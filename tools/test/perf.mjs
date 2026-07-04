// Per-kernel performance harness (PERF-1): loads every kernel's viewer route
// headlessly, warms it up, then measures per-frame render cost to catch the
// "quite shite fps" kernels before they reach a real screen.
//
// CAVEAT: in CI this runs on SwiftShader (software GL, see browser.mjs) —
// the numbers are ORDINAL, a ranking + regression signal against each other,
// not absolute fps truth for a real GPU.
//
// NOT sampled via passive requestAnimationFrame deltas: headless Chrome's
// BeginFrame cadence is decoupled from actual GPU completion — a synthetic
// shader doing 2,000,000 noise-hash iterations per pixel (460B ops/frame)
// still produced a flat 16.7ms/frame under rAF sampling (the same shader
// under forced sync below: ~294ms/frame). Instead each frame is driven
// explicitly via GL2Runtime.renderOnce() (the same call thumbs.js uses)
// followed by a 1x1 gl.readPixels(), which per the WebGL spec blocks until
// that frame's GPU work actually completes — the only way to get real
// per-frame cost out of this runtime headlessly.
//
// Usage: node tools/test/perf.mjs   (from repo root; npm ci in tools/test first)
// Writes tools/test/out/perf.json; exits nonzero only on harness failure
// (navigation/launch errors), never on a slow kernel — this is report-only
// until bake_kernels.py's --perf gate consumes it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, serveSite, gotoSafe } from './browser.mjs';

const VIEWPORT = { width: 640, height: 360 };
const WARMUP_MS = 1000;
const MEASURE_MS = 3000;
const OUT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'out');

// Runs on a scratch canvas (own GL2Runtime instance, independent of the
// viewer's live canvas) so the forced-sync loop can't fight the app's own
// rAF-driven render. import() is relative to the already-loaded page, same
// trick smoke.mjs uses for share.js.
async function sampleFrames(page, glslSrc) {
  return page.evaluate(async (src, warmupMs, measureMs) => {
    const { GL2Runtime } = await import('./js/runtime/webgl2.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '640px';
    canvas.style.height = '360px';
    document.body.appendChild(canvas);

    let rt;
    try { rt = new GL2Runtime(canvas); } catch (e) { canvas.remove(); return { error: String(e) }; }
    const compiled = rt.setShader(src);
    if (!compiled.ok) { rt.dispose(); canvas.remove(); return { error: compiled.log || 'compile failed' }; }

    const gl = canvas.getContext('webgl2');
    const pixel = new Uint8Array(4);
    function syncedFrame(t) {
      rt.renderOnce(t);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); // blocks for real GPU completion
    }

    let t = 0;
    const warmStart = performance.now();
    while (performance.now() - warmStart < warmupMs) { syncedFrame(t); t += 1 / 60; }

    const deltas = [];
    const measureStart = performance.now();
    let prev = performance.now();
    while (performance.now() - measureStart < measureMs) {
      syncedFrame(t);
      t += 1 / 60;
      const now = performance.now();
      deltas.push(now - prev);
      prev = now;
    }

    rt.dispose();
    canvas.remove();
    return { deltas };
  }, glslSrc, WARMUP_MS, MEASURE_MS);
}

function stats(deltas) {
  if (!deltas.length) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const avg_ms = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const p95_ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { avg_ms, p95_ms, fps: 1000 / avg_ms, samples: deltas.length };
}

mkdirSync(OUT_DIR, { recursive: true });
const { server, base: BASE } = await serveSite();
const browser = await launch();

let kernels;
try {
  kernels = (await (await fetch(`${BASE}/assets/kernels.json`)).json()).kernels;
} catch (e) {
  console.error('FATAL: could not load kernels.json —', e.message);
  await browser.close();
  server.kill();
  process.exit(1);
}

async function measureKernel(k) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // real-integration check: the kernel must actually load through the
  // viewer route (registry lookup, backend ladder) before it's worth timing.
  await gotoSafe(page, `${BASE}/index.html#/s/${k.id}`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => errors.push('no viewer-canvas'));
  const badge = await page.$eval('.badge-backend', (el) => el.textContent.trim()).catch(() => null);

  let s = null;
  if (errors.length === 0 && badge && badge !== 'no GPU') {
    const r = await sampleFrames(page, k.glsl).catch((e) => ({ error: e.message }));
    if (r.error) errors.push('measure: ' + r.error);
    else s = stats(r.deltas);
  }
  await page.close();
  return { id: k.id, title: k.title || k.id, backend: badge, error: errors.length ? errors.join(' | ') : null, ...s };
}

const results = [];
for (const k of kernels) results.push(await measureKernel(k));

await browser.close();
server.kill();

const timed = results.filter((r) => r.avg_ms != null);
const medianAvg = timed.length
  ? [...timed.map((r) => r.avg_ms)].sort((a, b) => a - b)[Math.floor(timed.length / 2)]
  : null;
for (const r of results) r.heavy = medianAvg != null && r.avg_ms != null && r.avg_ms > 2 * medianAvg;

results.sort((a, b) => (b.avg_ms ?? -1) - (a.avg_ms ?? -1));

const out = {
  generated: new Date().toISOString(),
  viewport: VIEWPORT,
  warmup_ms: WARMUP_MS,
  measure_ms: MEASURE_MS,
  median_avg_ms: medianAvg,
  results,
};
writeFileSync(path.join(OUT_DIR, 'perf.json'), JSON.stringify(out, null, 2) + '\n');

console.log(`${'id'.padEnd(28)}${'avg_ms'.padStart(8)}${'p95_ms'.padStart(8)}${'fps'.padStart(7)}  flag`);
for (const r of results) {
  if (r.avg_ms == null) {
    console.log(`${r.id.padEnd(28)}${'-'.padStart(8)}${'-'.padStart(8)}${'-'.padStart(7)}  ERROR: ${r.error}`);
    continue;
  }
  console.log(
    `${r.id.padEnd(28)}${r.avg_ms.toFixed(2).padStart(8)}${r.p95_ms.toFixed(2).padStart(8)}${r.fps.toFixed(1).padStart(7)}  ${r.heavy ? 'HEAVY' : ''}`
  );
}
console.log(`\n${results.length} kernels, median avg_ms=${medianAvg != null ? medianAvg.toFixed(2) : 'n/a'} -> ${path.relative(process.cwd(), path.join(OUT_DIR, 'perf.json'))}`);

const harnessFailed = results.some((r) => r.avg_ms == null && /NAV:|no viewer-canvas/.test(r.error || ''));
process.exit(harnessFailed ? 1 : 0);
