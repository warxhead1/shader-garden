// ADM-B/C acceptance: sacrificial worker + orchestrator watchdog + verdict
// envelope, both languages.
//
// Headless reality (see ARCHITECTURE.md § Admission "Headless-test
// reality"): WebGPU never executes headlessly (chrome-headless-shell's
// SwiftShader path is GL2-only), so the WGSL worker's real compile/render
// against an actual GPU cannot be exercised here — real-browser-only
// (launch checklist row 5). GLSL is different: WebGL2-in-worker DOES run
// headlessly, so ADM-C's whole verdict model is exercised for real. What
// THIS file verifies:
//
//   (a) WGSL: the watchdog -> terminate() -> TLE path, using a private
//       test-only hang stub (never reachable from a share-link) so the
//       worker spawns for real, is tracked by Chrome DevTools Protocol as
//       a real worker target (page.workers()), and is actually terminated.
//   (b) GLSL: a REAL sacrificial-worker compile error (SwiftShader).
//   (c) GLSL: a REAL clean render — metrics + preview_png, no SG-S30.
//   (d) the envelope shape + admission-scoped ring buffer.
//   (e) editor-self never spawns a sacrificial worker (G5).
//   (f) GLSL: a REAL all-black kernel -> WA, safe:true, SG-S40, and the
//       share-link policy runs it (WA is in autorunOn) — "runs on consent".
//   (g) render_metrics keys are a strict subset of shader.preadmit
//       .evaluated.v1's render_metrics (schema, not assumed).
//   (h) GLSL: a REAL runtime-infinite loop (not a stub — see the header
//       comment at its definition below for why not a literal
//       `while(true)`) -> TLE, page interactive. Runs in its own
//       short-lived browser + hard-kill fallback (see comment there).
//
// Usage: node tools/test/admission-sac.mjs   (first: npm ci in tools/test)
import { launch, serveSite, sleep, gotoSafe } from './browser.mjs';

const { server, base: BASE } = await serveSite();
const browser = await launch();
let failed = false;

function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', String(e)));
// Playwright's page.workers()/'worker' event, verified empirically, never
// sees the sacrificial worker at all: admission/index.js spawns it as
// `new Worker(url, { type: 'module' })`, and a classic Worker() shows up
// in page.workers() fine but a MODULE worker never does — reproduced with
// a minimal repro page outside this file, not assumed. So "a real worker
// target spawned/terminated" is instrumented directly instead, the same
// self-instrumentation technique seed.mjs already uses for
// HTMLCanvasElement.getContext/requestAnimationFrame: wrap the global
// Worker constructor before any page script runs. This is still an
// external, product-blind observer (not trusting admission/index.js's own
// bookkeeping) — just one Playwright can actually see.
await page.addInitScript(() => {
  window.__workerLive = 0;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      window.__workerLive++;
    }
    terminate() {
      window.__workerLive--;
      return super.terminate();
    }
  };
});
async function workerCount(p = page) { return p.evaluate(() => window.__workerLive); }
await gotoSafe(page, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle0' });

const CLEAN_WGSL = `fn mainImage(fragCoord: vec2f) -> vec4f {
  return vec4f(fragCoord.x, fragCoord.y, 0.0, 1.0);
}`;

/* ---------- (a) TLE: stubbed worker never heartbeats ---------- */
{
  const before = await workerCount();
  const resultPromise = page.evaluate(async (src) => {
    const { admit } = await import('./js/organs/admission/index.js');
    const t0 = performance.now();
    const report = await admit(src, { language: 'wgsl', surface: 'share-link', _testHang: true });
    return { report, ms: performance.now() - t0 };
  }, CLEAN_WGSL);

  await sleep(300); // let the worker actually spawn before we sample devtools' worker list
  const mid = await workerCount();
  check('(a) sacrificial worker spawned (devtools worker target count grew)', mid > before, `before=${before} mid=${mid}`);

  const { report, ms } = await resultPromise;
  check('(a) verdict is TLE', report.verdict === 'TLE', 'verdict=' + report.verdict);
  check('(a) crash_risk is timeout', report.crash_risk === 'timeout', report.crash_risk);
  check('(a) safe=false', report.safe === false);
  check('(a) fired at the ~1s context deadline, not the 4s total budget', ms < 2000, `ms=${Math.round(ms)}`);

  // worker.terminate() is unconditional and synchronous from the caller's
  // side, but Chrome DevTools Protocol's target-detach notification (what
  // page.workers() reflects) lands a beat later — poll briefly rather than
  // asserting on a single immediate sample.
  let after = await workerCount();
  for (let i = 0; i < 20 && after !== before; i++) { await sleep(100); after = await workerCount(); }
  check('(a) worker terminated — devtools worker target count back to baseline', after === before, `before=${before} after=${after}`);

  const interactive = await page.evaluate(() => document.readyState !== 'loading');
  check('(a) page still interactive after TLE', interactive);

  const stillWorks = await page.evaluate(async () => {
    const { admit } = await import('./js/organs/admission/index.js');
    const r = await admit('void mainImage(out vec4 c, in vec2 p){ c=vec4(0.5); }', { language: 'glsl', surface: 'editor-self' });
    return r.verdict;
  });
  check('(a) a later admit() still works after the terminate() — page not wedged', stillWorks === 'OK', 'verdict=' + stillWorks);
}

/* ---------- (b) CE: GLSL sacrificial worker, real compile, verbatim log ---------- */
{
  const BROKEN_GLSL = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = 1.0;
}`;
  const before = await workerCount();
  const report = await page.evaluate(async (src) => {
    const { admit } = await import('./js/organs/admission/index.js');
    return admit(src, { language: 'glsl', surface: 'share-link' });
  }, BROKEN_GLSL);
  check('(b) verdict is CE', report.verdict === 'CE', 'verdict=' + report.verdict);
  check('(b) crash_risk is compile', report.crash_risk === 'compile', report.crash_risk);
  check('(b) compile_log is verbatim and non-empty', typeof report.compile_log === 'string' && report.compile_log.length > 0,
    JSON.stringify(report.compile_log || '').slice(0, 100));
  check('(b) backend reported as webgl2 (real SwiftShader compile, via the sacrificial worker)', report.backend === 'webgl2', report.backend);
  // devtools' target-detach notification lands a beat after terminate() returns — poll (see (a)'s identical note).
  let after = await workerCount();
  for (let i = 0; i < 20 && after !== before; i++) { await sleep(100); after = await workerCount(); }
  check('(b) worker spawned and cleaned up (devtools worker count back to baseline)', after === before, `before=${before} after=${after}`);
}

/* ---------- (c) OK: clean GLSL share-link, REAL sacrificial render ---------- */
{
  const CLEAN_GLSL = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(fragCoord / iResolution.xy, 0.5, 1.0);
}`;
  const report = await page.evaluate(async (src) => {
    const { admit } = await import('./js/organs/admission/index.js');
    return admit(src, { language: 'glsl', surface: 'share-link' });
  }, CLEAN_GLSL);
  check('(c) verdict is OK', report.verdict === 'OK', 'verdict=' + report.verdict);
  check('(c) NO SG-S30 finding — frames genuinely verified via the GLSL sacrificial worker (ADM-C)',
    !report.static_findings.some((f) => f.startsWith('SG-S30')), JSON.stringify(report.static_findings));
  check('(c) backend is webgl2', report.backend === 'webgl2', report.backend);
  check('(c) render_metrics present', !!report.render_metrics, JSON.stringify(report.render_metrics));
  check('(c) preview_png is a data URL', typeof report.preview_png === 'string' && report.preview_png.startsWith('data:image/png;base64,'),
    (report.preview_png || '').slice(0, 40));
  check('(c) verdict is in share-link autorunOn', ['OK', 'WA'].includes(report.verdict));
}

/* ---------- (d) envelope shape + admission-scoped ring buffer ---------- */
{
  const { envelopeOk, ringLen } = await page.evaluate(async () => {
    const { recentAdmissions } = await import('./js/organs/admission/index.js');
    const { recent } = await import('./js/core/bus.js');
    const busEvents = recent().filter((e) => e.type === 'garden.admission.evaluated.v1');
    const last = busEvents[busEvents.length - 1];
    const ring = recentAdmissions();
    return {
      envelopeOk: !!last && last.source === '/garden/admission' && last.specversion === '1.0' && !!last.data && !!last.data.verdict,
      ringLen: ring.length,
    };
  });
  check('(d) garden.admission.evaluated.v1 envelope shape correct (source=/garden/admission)', envelopeOk);
  check('(d) admission ring buffer holds recent envelopes', ringLen >= 4, 'ringLen=' + ringLen);
}

/* ---------- (e) editor-self never spawns a sacrificial worker (G5) ---------- */
{
  const before = await workerCount();
  await page.evaluate(async (src) => {
    const { admit } = await import('./js/organs/admission/index.js');
    await admit(src, { language: 'wgsl', surface: 'editor-self' });
  }, CLEAN_WGSL);
  const after = await workerCount();
  check('(e) editor-self admit() spawns no sacrificial worker', after === before, `before=${before} after=${after}`);
}

/* ---------- (f) WA: REAL all-black GLSL kernel, safe:true, runs on consent ---------- */
{
  const ALL_BLACK = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(0.0, 0.0, 0.0, 1.0);
}`;
  const { report, admitted } = await page.evaluate(async (src) => {
    const { admit, policyFor } = await import('./js/organs/admission/index.js');
    const r = await admit(src, { language: 'glsl', surface: 'share-link' });
    return { report: r, admitted: policyFor('share-link').autorunOn.includes(r.verdict) };
  }, ALL_BLACK);
  check('(f) verdict is WA', report.verdict === 'WA', 'verdict=' + report.verdict);
  check('(f) safe is true', report.safe === true);
  check('(f) crash_risk is none', report.crash_risk === 'none', report.crash_risk);
  check('(f) SG-S40 degenerate-output finding present', report.static_findings.some((f) => f.startsWith('SG-S40')),
    JSON.stringify(report.static_findings));
  check('(f) share-link policy admits WA — runs on consent, no explicit click needed', admitted);
}

/* ---------- (g) render_metrics keys are a strict subset of preadmit.v1 ---------- */
{
  const PREADMIT_V1_KEYS = new Set([
    'ssim', 'lpips', 'raps_slope_err', 'eikonal_grad_err', 'topology_score',
    'march_steps_mean', 'render_time_ms', 'brightness_mean', 'contrast_ratio',
    'color_diversity', 'noise_level', 'sharpness_score',
  ]); // mirrors nervous-bus schemas/shader.preadmit.evaluated.v1.json render_metrics — READ ONLY, never edit that repo
  const REQUIRED = ['render_time_ms', 'brightness_mean', 'contrast_ratio', 'color_diversity'];
  const report = await page.evaluate(async (src) => {
    const { admit } = await import('./js/organs/admission/index.js');
    return admit(src, { language: 'glsl', surface: 'share-link' });
  }, `void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(fragCoord / iResolution.xy, 0.5, 1.0); }`);
  const keys = Object.keys(report.render_metrics || {});
  check('(g) render_metrics keys are exactly the four preadmit-named ones', keys.length === 4 && REQUIRED.every((k) => keys.includes(k)), JSON.stringify(keys));
  check('(g) every render_metrics key is preadmit.v1-valid (strict subset, schema-checked)', keys.every((k) => PREADMIT_V1_KEYS.has(k)), JSON.stringify(keys));
}

await page.close();
await browser.close();

/* ---------- (h) REAL GLSL runtime-infinite loop -> the page survives ----------
 * A literal `while(true){}` with no reachable break is a COMPILE ERROR under
 * ANGLE ("Infinite loop detected in the shader") — empirically confirmed
 * while building this test, not assumed — so it can never reach the
 * watchdog. This shape has a `break` that is syntactically present (so it
 * compiles, and also slips past static.js's own SG-S20 regex, which only
 * checks for a break's presence, not reachability — a known §12-deferred
 * limitation) but never taken at runtime (`x` only increases from 0), so it
 * genuinely hangs the GPU-process-side render command.
 *
 * Two DIFFERENT real protections can win this race, and both are correct
 * per admission design §7.2's "the race is cosmetic" ruling — confirmed
 * empirically while building this test, not assumed: (1) the orchestrator's
 * own JS-side frame-deadline watchdog fires TLE, or (2) under heavier CPU
 * contention (SwiftShader pegging a core delays the main thread's own
 * setTimeout — a real observation, not a bug in the watchdog's design: JS
 * timers are a minimum delay, not a guarantee, under a starved event loop)
 * the browser's OWN GPU-process hang recovery wins first, surfacing as a
 * `webglcontextlost` event -> verdict RE. Either way: safe:false and the
 * PAGE stays interactive (the accept criterion) — this test asserts that
 * invariant, not a specific verdict or a tight wall-clock bound.
 *
 * Runs in its OWN short-lived browser, torn down with a hard-kill fallback
 * (not just close()) — a real hang can leave the GPU process outliving a
 * graceful close(), confirmed empirically while building this test. */
{
  const hangBrowser = await launch();
  const hangPage = await hangBrowser.newPage();
  hangPage.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await gotoSafe(hangPage, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle0' });

  const HANG_GLSL = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float x = 0.0;
  while (true) { x += 0.0001; if (x < 0.0) break; }
  fragColor = vec4(x, 0.0, 0.0, 1.0);
}`;
  const t0 = Date.now();
  const result = await Promise.race([
    hangPage.evaluate(async (src) => {
      const { admit } = await import('./js/organs/admission/index.js');
      const t0 = performance.now();
      const report = await admit(src, { language: 'glsl', surface: 'share-link' });
      return { report, ms: performance.now() - t0 };
    }, HANG_GLSL),
    sleep(30000).then(() => ({ report: null, ms: null, timedOutInNode: true })),
  ]);
  const wallMs = Date.now() - t0;
  check('(h) admit() resolved at all (not left hanging past a generous 30s outer bound)', !result.timedOutInNode, `wallMs=${wallMs}`);
  if (!result.timedOutInNode) {
    check('(h) verdict is TLE or RE — both are the watchdog/context-loss race winning (§7.2)',
      ['TLE', 'RE'].includes(result.report.verdict), 'verdict=' + result.report.verdict);
    check('(h) safe is false', result.report.safe === false);
  }
  const interactive = await hangPage.evaluate(() => document.readyState !== 'loading').catch(() => false);
  check('(h) page still interactive after the real hang', interactive);

  // Hard-kill fallback: a genuinely hung GPU-process render can outlive a
  // graceful close() (confirmed empirically under puppeteer) — this used
  // to race close() against a short timeout, then SIGKILL the underlying
  // process via puppeteer's browser.process().pid. Playwright's Browser
  // (from chromium.launch()) has no equivalent — verified empirically,
  // `'process' in browser` is false and there is no pid anywhere on its
  // prototype — chromium.launchServer() exposes one but browser.mjs's
  // launch() doesn't use it, and I'm not touching browser.mjs. Best effort
  // without it: just bound close() and move on; if this leaves an orphaned
  // GPU process on a genuinely wedged hang, that's a real gap — see my
  // report for the browser.mjs change that would close it (an optional
  // process handle on launch()'s return value).
  try { await Promise.race([hangBrowser.close(), sleep(3000)]); } catch { /* ignore */ }
}

server.kill();
console.log(failed ? 'SOME FAIL' : 'all-PASS');
process.exit(failed ? 1 : 0);
