// Dedicated forced-sync render-cost harness for the garden scene (PERF-2).
// perf.mjs measures every BAKED kernel via its #/s/:id route; the garden
// (assets/garden/scene.glsl) isn't in kernels.json — GARDEN-0 is a
// standalone route, not a baked kernel — so it needs its own small harness.
// Same technique and same CAVEAT as perf.mjs (see that file's header): under
// SwiftShader-headless these numbers are ORDINAL (a ranking + regression
// signal against themselves), never absolute real-GPU fps truth.
//
// Usage: node tools/test/garden-perf.mjs   (from repo root; npm ci in tools/test first)
// Measures the scene once per SG_QUALITY level (Low/Medium/High — see
// scene.glsl's own SG_QUALITY comment) via the same forced
// GL2Runtime.renderOnce() + readPixels() sync trick perf.mjs uses, so a
// slow frame's real GPU cost is captured even though headless Chrome's rAF
// cadence alone would hide it. Writes tools/test/out/garden-perf.json;
// report-only — exits nonzero only on a harness failure, never a slow frame.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, serveSite, gotoSafe, sleep } from './browser.mjs';

// Closer to a real fullscreen mount than perf.mjs's 640x360 kernel-thumbnail
// size — the garden is a fullscreen hero scene, not a gallery thumbnail.
const VIEWPORT = { width: 1280, height: 720 };
const WARMUP_MS = 1000;
const MEASURE_MS = 3000;
const LEVELS = [
  { name: 'low', sgQuality: 0 },
  { name: 'medium', sgQuality: 1 },
  { name: 'high', sgQuality: 2 }, // byte-identical iteration counts to pre-SG_QUALITY code
];
const OUT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'out');

// Wave-3 item E: the "near-free" movement claim (blueprint §4 — zero cost
// while idle, and when active it's the same setUniforms() call every tune
// slider already proves cheap) must be MEASURED against the idle baseline,
// not assumed. Movement lives entirely in index.js's own rAF loop, not the
// shader, so this can't use sampleFrames' forced-sync scratch-canvas trick
// above (that bypasses index.js and the real mount's render loop
// altogether) — it instead reads the real mount's own perfBadge (the
// EMA'd ms/frame runtime-host.js already computes at ~1Hz), polled over a
// fixed window, once idle and once with 'd' held throughout.
const LIVE_SETTLE_MS = 1500; // let the EMA (fmtPerf) settle before sampling either pass
const LIVE_MEASURE_MS = 4000;
const LIVE_POLL_MS = 500;

function parsePerfBadgeMs(text) {
  const m = /([\d.]+)\s*ms/.exec(text || '');
  return m ? Number(m[1]) : null;
}

async function measureLiveFrameTime(moving) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.badge-perf', { timeout: 8000 }).catch(() => errors.push('no perf badge'));
  await sleep(LIVE_SETTLE_MS);

  if (moving) await page.keyboard.down('d');
  const samples = [];
  const deadline = Date.now() + LIVE_MEASURE_MS;
  while (Date.now() < deadline) {
    await sleep(LIVE_POLL_MS);
    const text = await page.$eval('.badge-perf', (el) => el.textContent).catch(() => null);
    const ms = parsePerfBadgeMs(text);
    if (ms != null) samples.push(ms);
  }
  if (moving) await page.keyboard.up('d');

  await page.close();
  const avg_ms = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
  return { moving, avg_ms, samples: samples.length, error: errors.length ? errors.join(' | ') : null };
}

// Runs on a scratch canvas (own GL2Runtime instance), same reasoning as
// perf.mjs's sampleFrames: forced-sync timing can't fight the live page's
// own rAF-driven render if it's on an entirely separate context.
async function sampleFrames(page, glslSrc, sgQuality) {
  return page.evaluate(async (src, quality, warmupMs, measureMs) => {
    const { GL2Runtime } = await import('./js/runtime/webgl2.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '1280px';
    canvas.style.height = '720px';
    document.body.appendChild(canvas);

    let rt;
    try { rt = new GL2Runtime(canvas); } catch (e) { canvas.remove(); return { error: String(e) }; }
    const compiled = rt.setShader(src);
    if (!compiled.ok) { rt.dispose(); canvas.remove(); return { error: compiled.log || 'compile failed' }; }
    rt.setUniforms({ SG_QUALITY: quality });

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
  }, glslSrc, sgQuality, WARMUP_MS, MEASURE_MS);
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

let sceneSrc;
try {
  sceneSrc = await (await fetch(`${BASE}/assets/garden/scene.glsl`)).text();
} catch (e) {
  console.error('FATAL: could not load scene.glsl —', e.message);
  await browser.close();
  server.kill();
  process.exit(1);
}

async function measureLevel(level) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Real-integration check: load the actual #/garden route once per process
  // so a wrap.js/runtime-host regression that only shows up through the real
  // mount (not this scratch canvas below) still fails this harness loudly.
  await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errors.push('no garden-canvas'));

  let s = null;
  if (errors.length === 0) {
    const r = await sampleFrames(page, sceneSrc, level.sgQuality).catch((e) => ({ error: e.message }));
    if (r.error) errors.push('measure: ' + r.error);
    else s = stats(r.deltas);
  }
  await page.close();
  return { level: level.name, sg_quality: level.sgQuality, error: errors.length ? errors.join(' | ') : null, ...s };
}

const results = [];
for (const level of LEVELS) results.push(await measureLevel(level));

const idleLive = await measureLiveFrameTime(false);
const movingLive = await measureLiveFrameTime(true);

await browser.close();
server.kill();

const out = {
  generated: new Date().toISOString(),
  viewport: VIEWPORT,
  warmup_ms: WARMUP_MS,
  measure_ms: MEASURE_MS,
  results,
  live_movement: { idle: idleLive, moving: movingLive },
};
writeFileSync(path.join(OUT_DIR, 'garden-perf.json'), JSON.stringify(out, null, 2) + '\n');

console.log(`${'level'.padEnd(10)}${'avg_ms'.padStart(8)}${'p95_ms'.padStart(8)}${'fps'.padStart(7)}`);
for (const r of results) {
  if (r.avg_ms == null) {
    console.log(`${r.level.padEnd(10)}${'-'.padStart(8)}${'-'.padStart(8)}${'-'.padStart(7)}  ERROR: ${r.error}`);
    continue;
  }
  console.log(`${r.level.padEnd(10)}${r.avg_ms.toFixed(2).padStart(8)}${r.p95_ms.toFixed(2).padStart(8)}${r.fps.toFixed(1).padStart(7)}`);
}
console.log(`\nlive movement (real mount, real rAF integrator — perfBadge EMA, ${LIVE_MEASURE_MS}ms window):`);
for (const r of [idleLive, movingLive]) {
  const label = r.moving ? 'moving (d held)' : 'idle';
  console.log(r.avg_ms == null
    ? `  ${label.padEnd(18)}ERROR: ${r.error}`
    : `  ${label.padEnd(18)}${r.avg_ms.toFixed(2)} ms  (n=${r.samples})`);
}
// Report-only comparison, same philosophy as the per-level table above (this
// file's own header: "exits nonzero only on a harness failure, never a slow
// frame") — headless SwiftShader timing is ordinal, not absolute, so a hard
// regression gate here would be exactly the kind of flaky assertion this
// harness deliberately avoids elsewhere. A generous +30% threshold still
// gives a real, printed signal for the "near-free" claim without failing
// the suite on measurement noise.
if (idleLive.avg_ms != null && movingLive.avg_ms != null) {
  const delta = movingLive.avg_ms - idleLive.avg_ms;
  const pct = (delta / idleLive.avg_ms) * 100;
  const flag = pct > 30 ? 'WARN' : 'OK';
  console.log(`  ${flag}: moving is ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs idle (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ms)`);
}
console.log(`\n-> ${path.relative(process.cwd(), path.join(OUT_DIR, 'garden-perf.json'))}`);

const harnessFailed = results.some((r) => r.avg_ms == null) || idleLive.avg_ms == null || movingLive.avg_ms == null;
process.exit(harnessFailed ? 1 : 0);
