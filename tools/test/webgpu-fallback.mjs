// Regression test for the canvas context-type-lock fallback bug: a canvas's
// context type locks permanently on the first getContext() call, and the
// WebGPU attempt acquires a 'webgpu' context BEFORE shader compilation can
// fail. Without the fresh-canvas swap in runtime-host.js build(), a bad WGSL
// kernel therefore killed the WebGL2 fallback too — getContext('webgl2') on
// the poisoned canvas returned null and the garden died as "no GPU".
//
// This suite serves a COPY of the site whose scene.wgsl has the reserved
// word `target` reintroduced (the original shipped bug) and asserts the
// garden lands on the WebGL2 badge with a live probe panel.
//
// Real-GPU only, driven by browser.mjs's launch() — same recipe as
// webgpu-live.mjs (read its header, and browser.mjs's own header, for the
// full story): chrome-headless-shell has no navigator.gpu, so a run without
// a real GPU never enters tryWebgpu and the regression cannot reproduce.
// This suite used to do its own Xvfb self-wrap and its own full-chromium
// binary resolution; both are now browser.mjs's job.
//
// One flag needs overriding, though: browser.mjs's GPU_ARGS hardcodes
// `--use-angle=vulkan` to get WebGPU its real nvidia/ampere adapter, but on
// THIS box that same flag makes canvas.getContext('webgl2') return null
// UNCONDITIONALLY — measured with a bare fresh canvas, no runtime-host.js
// involved at all: `--use-angle=vulkan` -> webgl2:false; drop it (or pass
// any other `--use-angle=`) -> webgl2:true, landing on the AMD iGPU via
// Mesa's radeonsi (real hardware, not SwiftShader/llvmpipe) while WebGPU
// still resolves to the real nvidia/ampere adapter untouched (Dawn doesn't
// route through ANGLE). Chrome takes the LAST `--use-angle=` switch when a
// flag repeats, and launch()'s `args` option is appended after GPU_ARGS, so
// passing `--use-angle=default` here overrides it without touching
// browser.mjs. This suite's whole point is the WebGL2 fallback actually
// working, so it needs this override to exercise anything real.
//
// The precondition check matters: a WebGL2 badge only proves the FALLBACK
// worked if WebGPU was genuinely available and attempted. Without it, a
// GPU-less environment would trivially "pass".
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, serveSite, sleep, gotoSafe, assertRealGpu, SITE_ROOT } from './browser.mjs';

const SCRATCH = process.env.SG_WEBGPU_OUT
  || (() => { const p = new URL('./out', import.meta.url).pathname; mkdirSync(p, { recursive: true }); return p; })();

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

// --- build the deliberately-broken site copy ---------------------------
const brokenRoot = mkdtempSync(join(tmpdir(), 'sg-broken-'));
cpSync(SITE_ROOT, brokenRoot, { recursive: true });
const wgslPath = join(brokenRoot, 'assets/garden/scene.wgsl');
const wgsl = readFileSync(wgslPath, 'utf8');
const broken = wgsl.replaceAll('camTarget', 'target');
if (broken === wgsl) {
  console.log('FAIL scene.wgsl no longer contains camTarget — pick a new way to break the WGSL for this test');
  rmSync(brokenRoot, { recursive: true, force: true });
  process.exit(1);
}
writeFileSync(wgslPath, broken);
console.log(`broken copy at ${brokenRoot} (${broken.split('target').length - 1} reserved-word sites)`);

const { server, base: BASE } = await serveSite(brokenRoot);
let browser;
try {
  browser = await launch({ viewport: { width: 1280, height: 800 }, args: ['--use-angle=default'] });

  const page = await browser.newPage();

  await gotoSafe(page, `${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Precondition: a WebGL2 badge below only proves the FALLBACK worked if
  // WebGPU was genuinely available and attempted on a REAL adapter, not a
  // software one that might behave differently under a broken shader.
  // Throws on a software adapter (SG_ALLOW_SOFTWARE=1 to accept one).
  const gpuInfo = await assertRealGpu(page);
  check('environment has a live real-GPU WebGPU adapter (precondition — see header)', !!gpuInfo, JSON.stringify(gpuInfo));

  await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'networkidle2', timeout: 20000 });
  let mounted = await page.waitForSelector('.garden-tray-item', { timeout: 15000 }).then(() => true).catch(() => false);
  if (!mounted) {
    console.log('  [recover] cold #/garden nav stalled — bouncing through #/');
    await page.evaluate(() => { location.hash = '#/'; });
    await sleep(2000);
    await page.evaluate(() => { location.hash = '#/garden'; });
    mounted = await page.waitForSelector('.garden-tray-item', { timeout: 15000 }).then(() => true).catch(() => false);
  }
  check('#/garden mounted despite broken WGSL', mounted);
  await sleep(1500);

  const badge = await page.$eval('.badge-backend', (el) => el.textContent.trim()).catch(() => null);
  check('backend badge reads WebGL2 (fallback, not a dead mount)', badge === 'WebGL2', 'badge=' + badge);
  await page.screenshot({ path: `${SCRATCH}/wgpu-fallback-badge.png`, fullPage: true });
  console.log('  screenshot: wgpu-fallback-badge.png, badge text = ' + JSON.stringify(badge));

  await page.mouse.click(720, 380);
  await sleep(800);
  const probeTitle = await page.$eval('.probe-title', (el) => el.textContent.trim()).catch(() => null);
  check('probe panel works on the fallback runtime', !!probeTitle, 'title=' + probeTitle);

  console.log(JSON.stringify({ gpuInfo, badge, probeTitle }, null, 1));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  rmSync(brokenRoot, { recursive: true, force: true });
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
