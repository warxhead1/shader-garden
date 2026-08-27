// core/runtime-host.js — onLost:'rebuild' circuit breaker (PERF-3).
//
// Bug this guards: a freshly (re)built WebGL2 context that itself loses
// immediately drove the old onContextLost handler straight back into
// `else build()` with no bound — repro'd empirically against a live
// #/garden cold boot under this project's own headless SwiftShader setup
// (no cross-organ interference required; an isolated #/garden-only page
// load reproduces "WebGL: CONTEXT_LOST_WEBGL" on essentially every fresh
// context). Under a busy-enough machine (each WebGL2 setup itself getting
// slower), "lose, rebuild, lose again" could compound into an effectively
// unbounded stall with nothing to observe it — no exception, no rejection,
// `runtimeHost()`'s own promise handling was never even reached again.
//
// This test doesn't try to coerce real driver flakiness (non-deterministic,
// load-dependent, and not something a CI box should be made to reproduce on
// purpose) — it drives the same failure shape deterministically using the
// standard WEBGL_lose_context extension: force-lose every canvas
// runtimeHost() creates, as fast as it creates them, and assert the
// automatic-rebuild policy gives up after a bounded number of attempts
// instead of retrying forever.
//
// Usage: node tools/test/runtime-host-loss.mjs   (first: npm ci in tools/test)
import { launch, serveSite, gotoSafe, sleep, scaled, assertRealWebgl2 } from './browser.mjs';

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
// Pinned WebGL2 throughout (runtimeHost() below is called with
// prefer:'webgl2' directly) — prove it's the real renderer, not a silent
// SwiftShader downgrade.
await assertRealWebgl2(page);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Any page that already serves the ES module tree works — runtimeHost() is
// exercised directly via a scratch host div, not through an organ route.
await gotoSafe(page, BASE + '/index.html#/', { waitUntil: 'networkidle2', timeout: 20000 });

const result = await page.evaluate(async (budgetMs) => {
  const { runtimeHost } = await import('./js/core/runtime-host.js');

  const host = document.createElement('div');
  document.body.appendChild(host);

  // Force-lose every canvas the instant it appears — WEBGL_lose_context is
  // the spec-sanctioned way to simulate context loss deterministically (real
  // browsers auto-schedule the actual 'webglcontextlost' dispatch shortly
  // after the call, same as a real driver-triggered loss would).
  let forcedLosses = 0;
  const seen = new WeakSet();
  const observer = new MutationObserver(() => {
    const canvas = host.querySelector('canvas');
    if (!canvas || seen.has(canvas)) return;
    seen.add(canvas);
    const gl = canvas.getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (ext) { forcedLosses++; ext.loseContext(); }
  });
  observer.observe(host, { childList: true });

  const events = [];
  const bus = { emit: (type, data) => events.push({ type, data }) };

  const rh = await runtimeHost(host, {
    prefer: 'webgl2',
    glslSrc: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }',
    canvasClass: '',
    onLost: 'rebuild',
    bus,
    organ: 'runtime-host-loss-test',
  });
  const initialBackend = rh.backend; // proves the FIRST await runtimeHost() resolved at all

  // Wait for the circuit breaker to trip (backend -> null) or bail with
  // whatever state it's in — a stuck retry loop shows up here as "never hits
  // null before the deadline", not as this evaluate() call itself hanging
  // (each build() attempt still returns to the event loop between losses).
  // budgetMs comes from Node as scaled(8000). It has to: this deadline lives
  // INSIDE page.evaluate, so shimPage's TIME_SCALE scaling — which only
  // reaches Playwright's own `timeout:` options — cannot see it. The breaker
  // trips after a fixed COUNT of losses, and every retry in that count pays a
  // SwiftShader compile, so on a GPU-less runner the count outlasts 8s of wall
  // clock (run 32680404388: timedOut=true, finalBackend=webgl2 — still
  // retrying, not stuck). The ASSERTION is untouched: the breaker must still
  // trip rather than retry forever, which is the only thing this ever claimed.
  const deadline = Date.now() + budgetMs;
  while (rh.backend !== null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

  observer.disconnect();
  return {
    initialBackend,
    finalBackend: rh.backend,
    finalOk: rh.ok,
    finalLog: rh.log,
    forcedLosses,
    lostEvents: events.filter((e) => e.type === 'runtime.lost.v1').length,
    timedOut: Date.now() >= deadline,
  };
}, scaled(8000));

check('the initial build resolved before any loss was forced', result.initialBackend === 'webgl2', 'initialBackend=' + result.initialBackend);
check('the circuit breaker tripped instead of retrying past the deadline', !result.timedOut && result.finalBackend === null,
  'timedOut=' + result.timedOut + ' finalBackend=' + result.finalBackend);
check('the failure state is honest (not ok, log names the reason)', result.finalOk === false && /lost/i.test(result.finalLog || ''),
  'finalOk=' + result.finalOk + ' finalLog=' + result.finalLog);
// MAX_LOSS_REBUILDS=5 in runtime-host.js: 1 initial context + 5 automatic
// rebuilds = 6 canvases total before giving up. Asserted as a range, not an
// exact literal, so a deliberate future tune of the constant doesn't need a
// matching edit here — the invariant under test is "bounded", not "exactly 6".
check('rebuild attempts were bounded, not unbounded', result.forcedLosses >= 3 && result.forcedLosses <= 10,
  'forcedLosses=' + result.forcedLosses);
check('runtime.lost.v1 fired once per loss, including the final give-up', result.lostEvents === result.forcedLosses,
  'lostEvents=' + result.lostEvents + ' forcedLosses=' + result.forcedLosses);
check('no page errors', errors.length === 0, errors.join(' | '));

// Ownership regression (design contract 1/2): the host element is SHARED with
// the caller — garden hangs the probe/editor panel, MP panel and tray off the
// same node runtimeHost() mounts its canvas into. A rebuild (including the
// "Edit here" WebGPU->WebGL2 pin) or a release must therefore touch only the
// canvas THIS host created. The regression this guards is the old unscoped
// full-wipe of host children, which evicted the very panel the editor was
// mid-flight to mount into and left it rendering into an orphaned subtree.
const ownership = await page.evaluate(async () => {
  const { runtimeHost } = await import('./js/core/runtime-host.js');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const sibling = document.createElement('div');
  sibling.className = 'unrelated-sibling';
  sibling.textContent = 'panel the caller mounted';
  host.appendChild(sibling);

  const snap = () => ({
    siblingAlive: host.contains(sibling) && document.body.contains(sibling),
    canvases: host.querySelectorAll('canvas').length,
    canvasFirst: host.firstElementChild?.tagName === 'CANVAS',
  });

  const rh = await runtimeHost(host, {
    prefer: 'webgl2',
    glslSrc: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }',
    canvasClass: 'owned-canvas',
    onLost: 'release',
  });
  const afterBuild = { ...snap(), backend: rh.backend };
  // The same call shape garden's editing seam uses to pin a mount to WebGL2.
  await rh.rebuild({ prefer: 'webgl2' });
  const afterRebuild = { ...snap(), backend: rh.backend };
  rh.dispose();
  const afterDispose = snap();

  sibling.remove(); host.remove();
  return { afterBuild, afterRebuild, afterDispose };
});

check('build mounts exactly one owned canvas, beneath the caller\'s sibling',
  ownership.afterBuild.canvases === 1 && ownership.afterBuild.canvasFirst && ownership.afterBuild.siblingAlive,
  JSON.stringify(ownership.afterBuild));
check('rebuild replaces only its own canvas — the unrelated sibling survives',
  ownership.afterRebuild.siblingAlive && ownership.afterRebuild.canvases === 1 && ownership.afterRebuild.backend === 'webgl2',
  JSON.stringify(ownership.afterRebuild));
check('release removes the owned canvas and nothing else',
  ownership.afterDispose.canvases === 0 && ownership.afterDispose.siblingAlive,
  JSON.stringify(ownership.afterDispose));
check('no page errors after the ownership pass', errors.length === 0, errors.join(' | '));

// Overlapping-build race (the fix 529de42 proved). An initial WebGL2 build
// gives us an `rh` handle; we then stub navigator.gpu.requestAdapter with a
// deferred promise; rebuild A with prefer:'auto' + WGSL stalls inside
// tryWebgpu awaiting the adapter; while A stalls, rebuild B with
// prefer:'webgl2' runs to completion (synchronous, no WebGPU); we then
// resolve A as unavailable and await both. Without the fix, A's continuation
// fell through to the WebGL2 leg, replaceWith()'d a fresh canvas onto a
// parentless node (a no-op), and assigned ownCanvas to the orphan — so
// dispose() later removed the orphan instead of B's live canvas and left a
// stranded canvas in the shared host. With the fix, A detects my !== gen
// BEFORE the WebGL2 leg and abandon()s only its own canvas, leaving B's
// canvas intact and removable by dispose.
const overlap = await page.evaluate(async () => {
  const { runtimeHost } = await import('./js/core/runtime-host.js');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const sibling = document.createElement('div');
  sibling.className = 'unrelated-sibling';
  sibling.textContent = 'panel the caller mounted';
  host.appendChild(sibling);

  const GLSL = 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }';
  const WGSL = '@fragment fn main() {}';

  // Step 1: an initial WebGL2 build so `rh` is available to call rebuild().
  const rh = await runtimeHost(host, {
    prefer: 'webgl2', glslSrc: GLSL, canvasClass: 'owned-canvas', onLost: 'release',
  });
  const initialBaseline = {
    canvases: host.querySelectorAll('canvas').length,
    siblingAlive: host.contains(sibling),
    backend: rh.backend,
  };

  // Step 2: stub navigator.gpu.requestAdapter with a deferred promise so
  // build A stalls inside tryWebgpu until we choose to resolve it. Try the
  // browser-native navigator.gpu first; if it is absent, synthesise the
  // minimum surface the WebGPU leg needs to reach its await — requestAdapter
  // must exist for the stub to take effect.
  let resolveGpu;
  const adapterDeferred = new Promise((r) => { resolveGpu = r; });
  let adapterCalls = 0;
  const origGpu = navigator.gpu;
  if (origGpu && typeof origGpu.requestAdapter === 'function') {
    navigator.gpu.requestAdapter = () => { adapterCalls++; return adapterDeferred; };
  } else {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {
        requestAdapter: () => { adapterCalls++; return adapterDeferred; },
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    });
  }

  const trail = {};
  let pageErr = null;
  try {
    // Step 3: start rebuild A (prefer:'auto' + WGSL) without awaiting — we
    // interleave B before A resolves.
    const promiseA = rh.rebuild({ prefer: 'auto', wgslSrc: WGSL });
    // Wait for build A to reach the requestAdapter() await.
    while (!adapterCalls) await new Promise((r) => setTimeout(r, 5));
    trail.afterAStalled = {
      canvases: host.querySelectorAll('canvas').length,
      siblingAlive: host.contains(sibling),
      firstChildTag: host.firstElementChild?.tagName,
    };

    // Step 4: complete rebuild B with prefer:'webgl2' while A is stalled.
    await rh.rebuild({ prefer: 'webgl2' });
    trail.afterBComplete = {
      canvases: host.querySelectorAll('canvas').length,
      siblingAlive: host.contains(sibling),
      backend: rh.backend,
      firstChildTag: host.firstElementChild?.tagName,
    };

    // Step 5: resolve A as unavailable/failure and await it.
    resolveGpu(null);
    await promiseA;
    trail.afterAComplete = {
      canvases: host.querySelectorAll('canvas').length,
      siblingAlive: host.contains(sibling),
      backend: rh.backend,
      firstChildTag: host.firstElementChild?.tagName,
    };

    // Step 6: dispose — the only canvas left must be the one B installed.
    rh.dispose();
    trail.afterDispose = {
      canvases: host.querySelectorAll('canvas').length,
      siblingAlive: host.contains(sibling),
    };
  } catch (e) {
    pageErr = String(e?.message ?? e);
  } finally {
    // Restore navigator.gpu regardless of how the race ended.
    if (origGpu === undefined) {
      try { delete navigator.gpu; } catch { /* gone */ }
    } else if (origGpu) {
      navigator.gpu.requestAdapter = origGpu.requestAdapter;
    }
    sibling.remove(); host.remove();
  }

  return { initialBaseline, trail, adapterCalls, pageErr };
});

check('overlap: initial WebGL2 baseline left exactly one canvas and the sibling intact',
  overlap.initialBaseline.canvases === 1 && overlap.initialBaseline.siblingAlive && overlap.initialBaseline.backend === 'webgl2',
  JSON.stringify(overlap.initialBaseline));
check('overlap: while A was stalled, host held exactly one canvas and the sibling survived',
  overlap.trail.afterAStalled?.canvases === 1 && overlap.trail.afterAStalled?.siblingAlive && overlap.trail.afterAStalled?.firstChildTag === 'CANVAS',
  JSON.stringify(overlap.trail.afterAStalled));
check('overlap: B completed first — backend is webgl2, exactly one canvas is live',
  overlap.trail.afterBComplete?.canvases === 1 && overlap.trail.afterBComplete?.backend === 'webgl2' && overlap.trail.afterBComplete?.siblingAlive,
  JSON.stringify(overlap.trail.afterBComplete));
check('overlap: A finishing stale left B\'s canvas intact (no orphan, no extra canvas)',
  overlap.trail.afterAComplete?.canvases === 1 && overlap.trail.afterAComplete?.siblingAlive && overlap.trail.afterAComplete?.firstChildTag === 'CANVAS',
  JSON.stringify(overlap.trail.afterAComplete));
check('overlap: dispose removed the one owned canvas — host is empty',
  overlap.trail.afterDispose?.canvases === 0 && overlap.trail.afterDispose?.siblingAlive,
  JSON.stringify(overlap.trail.afterDispose));
check('overlap: adapter stub was actually called (the WebGPU leg really ran)', overlap.adapterCalls >= 1, 'adapterCalls=' + overlap.adapterCalls);
check('overlap: no errors raised during the staged race', overlap.pageErr === null, overlap.pageErr || '');
check('overlap: no page errors', errors.length === 0, errors.join(' | '));

// Dispose while A is stalled (if feasible). The losing build's continuation
// lands inside dispose=true after the host is already torn down — it must
// not strand a canvas in the host AND must not raise. On both old and new
// code dispose() itself clears the live canvas before A's continuation
// runs, so this is a regression guard rather than a fix discriminator, but
// it pins the contract for the dispose-then-resolve order and surfaces any
// later regression that re-introduces a leak into the WebGL2 fallback path.
const disposeWhileStalled = await page.evaluate(async () => {
  const { runtimeHost } = await import('./js/core/runtime-host.js');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const sibling = document.createElement('div');
  sibling.className = 'unrelated-sibling';
  sibling.textContent = 'panel the caller mounted';
  host.appendChild(sibling);

  const GLSL = 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }';
  const WGSL = '@fragment fn main() {}';

  const rh = await runtimeHost(host, {
    prefer: 'webgl2', glslSrc: GLSL, canvasClass: 'owned-canvas', onLost: 'release',
  });

  let resolveGpu;
  const adapterDeferred = new Promise((r) => { resolveGpu = r; });
  let adapterCalls = 0;
  const origGpu = navigator.gpu;
  if (origGpu && typeof origGpu.requestAdapter === 'function') {
    navigator.gpu.requestAdapter = () => { adapterCalls++; return adapterDeferred; };
  } else {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {
        requestAdapter: () => { adapterCalls++; return adapterDeferred; },
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    });
  }

  const trail = {};
  let pageErr = null;
  try {
    const promiseA = rh.rebuild({ prefer: 'auto', wgslSrc: WGSL });
    while (!adapterCalls) await new Promise((r) => setTimeout(r, 5));

    // Dispose WHILE A is stalled — A's continuation lands in dispose=true.
    rh.dispose();
    trail.afterDisposeStalled = {
      canvases: host.querySelectorAll('canvas').length,
      siblingAlive: host.contains(sibling),
    };

    // Resolve the adapter promise. A's continuation must not strand a canvas.
    resolveGpu(null);
    await promiseA;
    trail.afterAComplete = {
      canvases: host.querySelectorAll('canvas').length,
      siblingAlive: host.contains(sibling),
    };
  } catch (e) {
    pageErr = String(e?.message ?? e);
  } finally {
    if (origGpu === undefined) {
      try { delete navigator.gpu; } catch { /* gone */ }
    } else if (origGpu) {
      navigator.gpu.requestAdapter = origGpu.requestAdapter;
    }
    sibling.remove(); host.remove();
  }

  return { trail, pageErr };
});

check('dispose-while-stalled: dispose dropped canvases to zero with the sibling intact',
  disposeWhileStalled.trail.afterDisposeStalled?.canvases === 0 && disposeWhileStalled.trail.afterDisposeStalled?.siblingAlive,
  JSON.stringify(disposeWhileStalled.trail.afterDisposeStalled));
check('dispose-while-stalled: A\'s later continuation did not strand a canvas',
  disposeWhileStalled.trail.afterAComplete?.canvases === 0 && disposeWhileStalled.trail.afterAComplete?.siblingAlive,
  JSON.stringify(disposeWhileStalled.trail.afterAComplete));
check('dispose-while-stalled: no errors raised', disposeWhileStalled.pageErr === null, disposeWhileStalled.pageErr || '');
check('dispose-while-stalled: no page errors', errors.length === 0, errors.join(' | '));

await page.close();
await browser.close();
server.kill();

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
