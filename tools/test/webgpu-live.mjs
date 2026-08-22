// Real WebGPU execution evidence for the garden page, driven against the
// real GPU by browser.mjs's launch() (headed chromium/Vulkan under a
// borrowed compositor or Xvfb — see browser.mjs's own header for the full
// story of why: chrome-headless-shell has no navigator.gpu at all, and
// chromium's native `--headless=new` gets a WebGPU device that dies within
// ~1s of use). This suite used to do its own Xvfb self-wrap and its own
// full-chromium binary resolution; both are now browser.mjs's job
// (resolveDisplay()/ensureDisplay() and chromePath()), so this file is just
// the assertions.
//
// One thing that's still specific to this suite, not generic to launch():
// navigator.gpu is gated on a secure context, and a freshly-opened
// about:blank/data: page does NOT count as secure enough to expose it —
// only navigating to a real http://127.0.0.1 origin (the spec's loopback
// "potentially trustworthy" exception) surfaces the binding. That's what
// serveSite() below is for, and why the GPU probe runs after gotoSafe(),
// not before.
//
// Usage:
//   node tools/test/webgpu-live.mjs                    default: real Vulkan
//   SG_ALLOW_SOFTWARE=1 node tools/test/webgpu-live.mjs   accept a software adapter deliberately
import { mkdirSync } from 'node:fs';
import { launch, serveSite, sleep, gotoSafe, assertRealGpu } from './browser.mjs';

// Screenshots land here — override with SG_WEBGPU_OUT for a scratch/report dir.
const SCRATCH = process.env.SG_WEBGPU_OUT
  || (() => { const p = new URL('./out', import.meta.url).pathname; mkdirSync(p, { recursive: true }); return p; })();

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

const { server, base: BASE } = await serveSite();
let browser;
try {
  browser = await launch({ viewport: { width: 1280, height: 800 } });

  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Sanity gate: confirm navigator.gpu + a live adapter BEFORE trusting
  // anything the site's own badge says — an environment that can't do
  // WebGPU at all would otherwise just silently show the WebGL2 fallback
  // and this harness would misreport that as "the WGSL path never got
  // exercised" rather than "WebGPU itself isn't available here". Must run
  // after gotoSafe(), not before — navigator.gpu is gated on a secure
  // context and a real http://127.0.0.1 origin is what unlocks it.
  await gotoSafe(page, `${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Throws on a software adapter (SG_ALLOW_SOFTWARE=1 to accept one
  // deliberately) — the whole point of this migration is that a green run
  // here can't quietly mean SwiftShader.
  await assertRealGpu(page);
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
  check('backend badge reads WebGPU', backendBadge === 'WebGPU', 'badge=' + backendBadge);
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

  console.log(JSON.stringify({ gpuProbe, backendBadge, probeTitle, consoleErrors }, null, 1));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
