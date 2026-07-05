// Real WebGPU execution evidence for the garden page, headless-in-CI (via a
// virtual X display, not chromium's own `--headless=new`).
//
// Three things had to be untangled to get here — each cost real bisection
// time, so pinning them for the next person:
//
// 1. browser.mjs's launch() uses chrome-headless-shell, which has no
//    navigator.gpu at all (see its own header comment). This harness drives
//    the FULL chromium/chrome binary instead.
//
// 2. navigator.gpu is gated on a secure context, and a freshly-opened
//    about:blank/data: page in Puppeteer does NOT count as secure enough to
//    expose it — only navigating to a real http://127.0.0.1 origin (the
//    spec's loopback "potentially trustworthy" exception) surfaces the
//    binding. No puppeteer launch-flag workaround (ignoreDefaultArgs, raw
//    spawn + connect) was needed once that was understood — puppeteer's own
//    default args are actually load-bearing here (a bare chromium spawn
//    without them never even opens the DevTools port in this environment).
//
// 3. Once navigator.gpu/requestAdapter/requestDevice/canvas.getContext
//    ('webgpu')/shader-compile were all confirmed genuinely working, the
//    SITE still fell back to WebGL2. Root cause: under chromium's
//    `--headless=new` (the Ozone "headless" platform), a WebGPU device dies
//    ("A valid external Instance reference no longer exists") within ~1s of
//    being put into active use — reproduced with BOTH the swiftshader
//    software backend AND the real NVIDIA Vulkan backend, and even with a
//    single non-competing runtimeHost() mount (not a double-mount/race
//    artifact). Under a virtual X11 display (Xvfb) with headed chromium
//    (no `--headless` switch at all), the identical device stays stable
//    indefinitely. So: this harness re-execs itself under `xvfb-run` when
//    not already running under a usable display, and launches chromium
//    HEADED (headless: false) against that virtual display. Still fully
//    unattended/CI-safe — just not chromium's own headless mode.
//
// 4. This still needs real Vulkan (`--use-angle=vulkan`, the default below).
//    GitHub-hosted `ubuntu-latest` runners have no GPU at all, so the
//    obvious next question is whether `--use-angle=swiftshader` (the
//    software backend) survives under this same Xvfb+headed setup. Verified
//    empirically: no. `requestAdapter()` resolves to null in real page
//    content — not an exception, not a slow warm-up (retried 6x over 9s) —
//    across every combination tried: bare `--use-angle=swiftshader`, adding
//    `--enable-unsafe-swiftshader` (which DOES flip the adapter's
//    chrome://gpu status from "Blocklisted - crbug.com/40057808: CPU
//    adapters not fully tested or conformant" to "Available", but doesn't
//    change what a real page can get), `--use-webgpu-adapter=swiftshader`,
//    `--ignore-gpu-blocklist`/`--ignore-gpu-blacklist`, and masking this
//    machine's real Vulkan ICDs via `VK_ICD_FILENAMES` (to rule out the
//    host's own NVIDIA driver interfering with backend selection — it
//    doesn't; same null result with it hidden). So: real WebGPU execution
//    proof needs an actual GPU, full stop — neither chromium's native
//    headless mode (point 3, gets a device but it dies) nor Xvfb+headed
//    swiftshader (this point, never gets an adapter at all) is a
//    substitute on a GPU-less runner. `SG_ANGLE=swiftshader` is left wired
//    in below for whoever revisits this with a self-hosted GPU runner or a
//    newer Chrome build; the CI workflow does not rely on it passing.
//
// Usage:
//   node tools/test/webgpu-live.mjs                    default: real Vulkan
//   SG_ANGLE=swiftshader node tools/test/webgpu-live.mjs   software backend (see point 4 — does not currently pass)
import { createRequire } from 'node:module';
import { globSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { serveSite, sleep, gotoSafe } from './browser.mjs';

const require = createRequire(import.meta.url);

// --- self-wrap under Xvfb (see point 3 above) -------------------------
if (!process.env.SG_UNDER_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, SG_UNDER_XVFB: '1' },
  });
  process.exit(r.status ?? 1);
}

const puppeteer = require('puppeteer-core');

// Screenshots land here — override with SG_WEBGPU_OUT for a scratch/report dir.
const SCRATCH = process.env.SG_WEBGPU_OUT
  || (() => { const p = new URL('./out', import.meta.url).pathname; mkdirSync(p, { recursive: true }); return p; })();

function fullChromiumPath() {
  const env = process.env.SG_CHROMIUM;
  if (env) return env;
  const candidates = ['/usr/lib/chromium/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch { /* try next */ }
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

const { server, base: BASE } = await serveSite();
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: fullChromiumPath(),
    headless: false, // see point 3 — chromium's own headless mode kills the WebGPU device
    args: [
      '--no-sandbox',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      // SG_ANGLE lets this be re-verified against the software backend
      // instead of assuming the real-hardware ANGLE backend this was
      // authored against — see point 4 above: it does not currently pass.
      // --enable-unsafe-swiftshader unblocks the adapter in chrome://gpu's
      // own listing but not in real page content, so it's included for
      // completeness rather than because it fixes anything.
      `--use-angle=${process.env.SG_ANGLE || 'vulkan'}`,
      ...(process.env.SG_ANGLE === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
      '--window-position=0,0',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Sanity gate: confirm navigator.gpu + a live adapter BEFORE trusting
  // anything the site's own badge says — an environment that can't do
  // WebGPU at all would otherwise just silently show the WebGL2 fallback
  // and this harness would misreport that as "the WGSL path never got
  // exercised" rather than "WebGPU itself isn't available here".
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
