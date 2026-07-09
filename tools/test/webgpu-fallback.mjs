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
// Real-GPU only, same recipe and same CI caveat as webgpu-live.mjs (read its
// header for the full story): chrome-headless-shell has no navigator.gpu, so
// headless runs never enter tryWebgpu and the regression cannot reproduce
// there. The suite needs Xvfb + full chromium + an actual GPU; in CI it runs
// non-blocking on GPU-less runners, exactly like webgpu-live.
//
// The precondition check matters: a WebGL2 badge only proves the FALLBACK
// worked if WebGPU was genuinely available and attempted. Without it, a
// GPU-less environment would trivially "pass".
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSite, sleep, gotoSafe, SITE_ROOT } from './browser.mjs';

const require = createRequire(import.meta.url);

// --- self-wrap under Xvfb (see webgpu-live.mjs point 3) ----------------
if (!process.env.SG_UNDER_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, SG_UNDER_XVFB: '1' },
  });
  process.exit(r.status ?? 1);
}

const puppeteer = require('puppeteer-core');

const SCRATCH = process.env.SG_WEBGPU_OUT
  || (() => { const p = new URL('./out', import.meta.url).pathname; mkdirSync(p, { recursive: true }); return p; })();

// Same resolution logic as webgpu-live.mjs (duplicated to keep browser.mjs,
// whose launch() is headless-shell-specific, out of the full-chromium story).
function fullChromiumPath() {
  const env = process.env.SG_CHROMIUM;
  if (env) return env;
  const candidates = ['/usr/lib/chromium/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch { /* try next */ }
  }
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
  browser = await puppeteer.launch({
    executablePath: fullChromiumPath(),
    headless: false, // chromium's own headless mode kills the WebGPU device — see webgpu-live.mjs
    args: [
      '--no-sandbox',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      `--use-angle=${process.env.SG_ANGLE || 'vulkan'}`,
      '--window-position=0,0',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();

  await gotoSafe(page, `${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const gpuOk = await page.evaluate(async () => {
    if (!navigator.gpu) return false;
    const a = await navigator.gpu.requestAdapter().catch(() => null);
    return !!a;
  });
  check('environment has live WebGPU (precondition — see header)', gpuOk);

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

  console.log(JSON.stringify({ gpuOk, badge, probeTitle }, null, 1));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  rmSync(brokenRoot, { recursive: true, force: true });
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
