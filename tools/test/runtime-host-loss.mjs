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
import { launch, serveSite, gotoSafe, sleep } from './browser.mjs';

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
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Any page that already serves the ES module tree works — runtimeHost() is
// exercised directly via a scratch host div, not through an organ route.
await gotoSafe(page, BASE + '/index.html#/', { waitUntil: 'networkidle2', timeout: 20000 });

const result = await page.evaluate(async () => {
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
  const deadline = Date.now() + 8000;
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
});

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

await page.close();
await browser.close();
server.kill();

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
