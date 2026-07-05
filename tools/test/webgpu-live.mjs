// Real WebGPU execution evidence for the garden page.
//
// browser.mjs's launch() uses chrome-headless-shell, which has no
// navigator.gpu at all — that's why smoke.mjs's (l)/(h) checks pin WebGL2 as
// the expected headless badge. This harness instead drives the FULL chromium
// binary (not the headless-shell variant), which DOES expose navigator.gpu
// under headless=new with the swiftshader ANGLE/Vulkan backend — PROVIDED the
// page is loaded from a real http(s) origin. The gotcha that cost the most
// time bisecting: navigator.gpu is gated on a secure context, and Chrome does
// not treat a freshly-opened about:blank/data: page as secure enough to
// expose it — only navigating to a real http://127.0.0.1 (loopback, spec's
// "potentially trustworthy" exception) origin surfaces the binding. No
// puppeteer launch-flag workaround (ignoreDefaultArgs, raw spawn + connect)
// was needed once that was understood; puppeteer's own default args are
// actually necessary here (bare chromium launches without them hang before
// ever opening the DevTools port in this environment).
//
// Headless ceiling (verified, not assumed): navigator.gpu, requestAdapter(),
// and requestDevice() all succeed headless — the sanity gate below passes.
// But the GPUDevice is then spontaneously destroyed by the headless GPU
// process ~37ms later (device.lost resolves with reason 'destroyed', "A
// valid external Instance reference no longer exists") before the garden
// route's runtime finishes standing up its WebGPU renderer. runtime-host's
// onLost handler (site/js/core/runtime-host.js) can't re-acquire an adapter
// mid-mount and correctly rebuilds on WebGL2 instead. This reproduces under
// both `--use-angle=swiftshader` and real-Vulkan-ANGLE headless, and does
// NOT reproduce headed on a real GPU — so headless can only prove the
// graceful-degradation contract (env sanity + a clean WebGL2 landing), never
// the WebGPU badge itself. That badge is the manual launch-checklist row
// (tools/launch_checklist.md), automated here as an opt-in headed mode.
//
// Usage:
//   node tools/test/webgpu-live.mjs             headless: degradation contract
//   SG_HEADED=1 node tools/test/webgpu-live.mjs  headed, real GPU: WebGPU badge
import { createRequire } from 'node:module';
import { globSync } from 'node:fs';
import { serveSite, sleep, gotoSafe } from './browser.mjs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const HEADED = !!process.env.SG_HEADED;

// Screenshots land here — override with SG_WEBGPU_OUT for a scratch/report dir.
const SCRATCH = process.env.SG_WEBGPU_OUT
  || (() => { require('node:fs').mkdirSync(new URL('./out', import.meta.url), { recursive: true }); return new URL('./out', import.meta.url).pathname; })();

function fullChromiumPath() {
  const env = process.env.SG_CHROMIUM;
  if (env) return env;
  const candidates = ['/usr/lib/chromium/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of candidates) {
    try { if (require('node:fs').statSync(c).isFile()) return c; } catch { /* try next */ }
  }
  // fall back to a puppeteer-managed "Google Chrome for Testing" build, if one is cached
  const home = process.env.HOME || '';
  const hits = globSync(`${home}/.cache/puppeteer/chrome/*/chrome-linux64/chrome`).sort();
  if (hits.length) return hits[hits.length - 1];
  throw new Error('no full chromium/chrome binary found — set SG_CHROMIUM (chrome-headless-shell has no navigator.gpu)');
}

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}
function skip(name, reason) {
  console.log(`SKIP ${name} (${reason})`);
}

const { server, base: BASE } = await serveSite();
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: fullChromiumPath(),
    headless: HEADED ? false : 'new',
    // The swiftshader/Vulkan forcing is what makes navigator.gpu exist at
    // all under headless (see file header) — on a real GPU headed run these
    // flags aren't needed, and forcing swiftshader there would defeat the
    // point of the row (verifying WebGPU on real hardware).
    args: HEADED
      ? ['--no-sandbox']
      : ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader'],
    defaultViewport: { width: 1440, height: 900 },
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Sanity gate: confirm navigator.gpu + a live adapter BEFORE trusting
  // anything the site's own badge says — an environment that can't do
  // WebGPU at all would otherwise just silently show the WebGL2 fallback
  // and this harness would misreport that as "the WGSL path never got
  // exercised" rather than "WebGPU itself isn't available here". This gate
  // holds in both modes — it's the device destruction AFTER this point that
  // is headless-only (see file header).
  await gotoSafe(page, `${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const gpuProbe = await page.evaluate(async () => {
    const hasGpu = !!navigator.gpu;
    if (!hasGpu) return { hasGpu };
    let adapter = null, features = [], deviceOk = false;
    try {
      adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        features = [...adapter.features];
        const device = await adapter.requestDevice();
        deviceOk = !!device;
      }
    } catch (e) { return { hasGpu, error: String(e) }; }
    return { hasGpu, adapterInfo: adapter ? (adapter.info || {}) : null, features, deviceOk };
  });
  check('navigator.gpu exists on a real http origin', gpuProbe.hasGpu, JSON.stringify(gpuProbe));
  check('requestAdapter() returned a live adapter', !!gpuProbe.adapterInfo, JSON.stringify(gpuProbe.adapterInfo));
  check('requestDevice() succeeded', gpuProbe.deviceOk === true);
  check('adapter reports a non-trivial feature set', (gpuProbe.features || []).length > 3, 'features=' + JSON.stringify(gpuProbe.features));

  // Now the real garden route — known bug: a cold direct-nav to #/garden can
  // stall the mount forever. Recover by bouncing through #/ first.
  await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'networkidle2', timeout: 20000 });
  let mounted = await page.waitForSelector('.garden-tray-item', { timeout: 15000 }).then(() => true).catch(() => false);
  if (!mounted) {
    console.log('  [recover] cold #/garden nav stalled — bouncing through #/');
    await page.evaluate(() => { location.hash = '#/'; });
    await sleep(2000);
    await page.evaluate(() => { location.hash = '#/garden'; });
    mounted = await page.waitForSelector('.garden-tray-item', { timeout: 15000 }).then(() => true).catch(() => false);
  }
  check('#/garden mounted (garden-tray-item present)', mounted);
  await sleep(1500);

  const backendBadge = await page.$eval('.badge-backend', (el) => el.textContent.trim()).catch(() => null);
  if (HEADED) {
    check('backend badge reads WebGPU', backendBadge === 'WebGPU', 'badge=' + backendBadge);
  } else {
    skip('backend badge reads WebGPU', 'headless GPU-process instability destroys the device ~37ms post-adapter — see file header; run SG_HEADED=1 on real hardware for this row');
    check('backend badge lands on the WebGL2 fallback (graceful degradation)', backendBadge === 'WebGL2', 'badge=' + backendBadge);
  }
  await page.screenshot({ path: `${SCRATCH}/wgpu-1-badge.png`, fullPage: true });
  console.log('  screenshot: wgpu-1-badge.png, badge text = ' + JSON.stringify(backendBadge));

  // Click the character (same coordinates smoke.mjs's (l) test uses for the
  // "Bouncing Figure" probe target) to trigger the async GPU readback.
  await page.mouse.click(720, 380);
  await sleep(800);
  const probeTitle = await page.$eval('.probe-title', (el) => el.textContent.trim()).catch(() => null);
  check('probe panel opened with a component name', !!probeTitle, 'title=' + probeTitle);
  await page.screenshot({ path: `${SCRATCH}/wgpu-2-probe.png`, fullPage: true });
  console.log('  screenshot: wgpu-2-probe.png, probe title = ' + JSON.stringify(probeTitle));

  check('no console errors across the whole run', consoleErrors.length === 0, consoleErrors.join(' | '));
  if (consoleErrors.length) console.log('  console errors: ' + JSON.stringify(consoleErrors, null, 1));

  console.log(JSON.stringify({ headed: HEADED, gpuProbe, backendBadge, probeTitle, consoleErrors }, null, 1));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
