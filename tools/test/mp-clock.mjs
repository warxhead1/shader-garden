// Shader Garden — mp-clock.mjs
// Multiplayer spec §3 (shared time) + §10 gate: two pages in one room
// converge to within tolerance of each other's iTime, AND re-converge after
// a forced rh.rebuild() — §3.2 calls the reapply-after-rebuild step "the
// single most likely bug in the whole slice", so it's exercised directly,
// not just the steady-state convergence.
// Usage: node tools/test/mp-clock.mjs   (first: npm ci in tools/test)
import { startRelay } from '../../server/relay.mjs';
import { launch, serveSite, sleep, gotoSafe, derivePort } from './browser.mjs';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

// §C5: a suite needing a site AND a relay gives the relay its own explicit
// port rather than calling serveSite() twice (two serveSite() calls derive
// the SAME pid-based port and the second just aliases the first). Offset
// 610 is this suite's own slice of the pid-derived port space, distinct
// from serveSite()'s default (offset 0) and the other three MP suites'.
const RELAY_PORT = derivePort(610);
const relay = startRelay({ port: RELAY_PORT, host: '127.0.0.1' });
await new Promise((resolve, reject) => {
  relay.server.once('listening', resolve);
  relay.server.once('error', reject);
});

const { server, base: BASE } = await serveSite();
const browser = await launch();
const ROOM = 'clock-test';
// net.js's resolveUrl() reads window.location.SEARCH (the real URL's query
// string, before '#') for the `?relay=` override — NOT the hash's own query
// string. Confirmed empirically: navigating to
// ".../index.html#/garden/room?relay=..." leaves location.search empty and
// the override never fires. The query has to sit before the hash.
//
// The room ALSO has to be embedded in the relay URL's own path
// (ws://host:port/<room>), not just left for the `hello` message's `room`
// field to carry — confirmed empirically (mp-compile-swap.mjs's dev run):
// relay.mjs picks which Room object a connection belongs to purely from the
// upgrade request's URL path (`server/relay.mjs`'s `roomId = parts[parts.length
// - 1] || 'lobby'`); `reduce()`'s `hello` case never reads `msg.room` for
// routing at all. net.js's connectRoom() never appends `room` to the
// WebSocket URL it dials — only to the `hello` payload — so a bare
// `?relay=ws://host:port` override (with no room segment) lands every
// client in the same fallback "lobby" room regardless of `#/garden/:room`.
// Flagged in this suite's report as a real cross-lane (net.js/relay.mjs)
// protocol bug; worked around here by putting the room in the URL path,
// which relay.mjs DOES honor.
const relayUrlFor = (room) => `ws://127.0.0.1:${RELAY_PORT}/${room}`;
const roomUrl = (room) => `${BASE}/index.html?relay=${encodeURIComponent(relayUrlFor(room))}#/garden/${room}`;

function freshPage(errors) {
  return browser.newPage().then((page) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    return page;
  });
}

// Spies GL2Runtime.getClock() (same prototype-patch technique
// garden-movement.mjs's armSpies uses for setUniforms) so window.__clock
// always holds the CURRENT live clock instance. A rebuild constructs a
// fresh GL2Runtime with a fresh clock — object identity changes — so
// __clockGen (bumped only when the returned instance differs from the last
// one seen) is this page's own proof a rebuild actually produced a new
// runtime, without reaching into runtime-host's private state.
async function armClockSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__clock = null;
    window.__clockGen = 0;
    let last = null;
    import('./js/runtime/webgl2.js').then((mod) => {
      const orig = mod.GL2Runtime.prototype.getClock;
      mod.GL2Runtime.prototype.getClock = function () {
        const c = orig.call(this);
        if (c !== last) { last = c; window.__clock = c; window.__clockGen++; }
        return c;
      };
    }).catch(() => {});
  });
}

async function waitLive(page, label) {
  const ok = await page.waitForFunction(
    () => document.querySelector('.garden-mp-status')?.textContent === 'live',
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  if (!ok) console.log(`  [${label}] never reached 'live' status`);
  return ok;
}

async function waitForClock(page, label) {
  const ok = await page.waitForFunction(() => window.__clock != null, { timeout: 10000 })
    .then(() => true).catch(() => false);
  if (!ok) console.log(`  [${label}] __clock never appeared`);
  return ok;
}

async function sampleBoth(pageA, pageB) {
  // Promise.all fires both evaluate() calls back-to-back, but they still
  // serialize on the CDP wire — the residual gap is real sampling skew, not
  // clock skew, and is exactly what CLOCK_TOLERANCE_S below has to absorb
  // on top of §3.2's own RESYNC_EPS=0.05s deadband.
  const [a, b] = await Promise.all([
    pageA.evaluate(() => window.__clock?.time ?? null),
    pageB.evaluate(() => window.__clock?.time ?? null),
  ]);
  return { a, b, diff: (a != null && b != null) ? Math.abs(a - b) : null };
}

const errorsA = [], errorsB = [];
const pageA = await freshPage(errorsA);
const pageB = await freshPage(errorsB);
await armClockSpy(pageA);
await armClockSpy(pageB);

await Promise.all([
  gotoSafe(pageA, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => errorsA.push('NAV: ' + e.message)),
  gotoSafe(pageB, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => errorsB.push('NAV: ' + e.message)),
]);
await Promise.all([
  pageA.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errorsA.push('no garden-canvas')),
  pageB.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errorsB.push('no garden-canvas')),
]);

check('(setup) A reached live status', await waitLive(pageA, 'A'));
check('(setup) B reached live status', await waitLive(pageB, 'B'));
check('(setup) A has a clock', await waitForClock(pageA, 'A'));
check('(setup) B has a clock', await waitForClock(pageB, 'B'));

// Let the min-RTT estimator take its first (fast-cadence) sample and the
// per-frame deadband loop actually seek — timeSync.start() sends the first
// ping immediately on `welcome`, so this settle window is generous, not
// tight against the 2s fast-ping cadence.
await sleep(2500);

// TOLERANCE_S: measured, not asserted blind. §3.2's own deadband
// (RESYNC_EPS=0.05s) is the real per-client bound; on top of it this
// suite's own sampling (two separate CDP round trips per sampleBoth() call)
// adds skew. Measured worst case across real runs on this box, room-isolated
// (see relayUrlFor's header note — an EARLIER draft of this suite shared the
// relay's fallback "lobby" room with no isolation and measured ~85ms worst
// case instead): 6-8ms typical, both before and after the forced rebuild.
// 120ms keeps real margin over that (roughly 2x RESYNC_EPS) without hiding a
// genuine desync; if a run needs more than this, that's a regression to
// report, not a threshold to keep widening.
const CLOCK_TOLERANCE_S = 0.12;

const samples = [];
for (let i = 0; i < 5; i++) {
  samples.push(await sampleBoth(pageA, pageB));
  await sleep(300);
}
const worst = samples.reduce((m, s) => (s.diff != null && s.diff > m ? s.diff : m), 0);
check('(a) both pages sampled a clock on every attempt', samples.every((s) => s.diff != null), JSON.stringify(samples));
check(`(a) converged clocks stay within ${Math.round(CLOCK_TOLERANCE_S * 1000)}ms of each other`,
  worst <= CLOCK_TOLERANCE_S, 'worst diff=' + (worst * 1000).toFixed(1) + 'ms ' + JSON.stringify(samples));

// ---- forced rebuild on B: WEBGL_lose_context -> onLost:'rebuild' -> a
// fresh runtime whose clock starts at 0 and has never heard of the room's
// shared time until onBuild() re-arms it (§3.2). ----
const genBefore = await pageB.evaluate(() => window.__clockGen);
await pageB.evaluate(() => {
  const canvas = document.querySelector('.garden-canvas');
  const gl = canvas && canvas.getContext('webgl2');
  const ext = gl && gl.getExtension('WEBGL_lose_context');
  if (ext) ext.loseContext();
});
const rebuilt = await pageB.waitForFunction(
  (gen) => window.__clockGen > gen,
  { timeout: 10000 },
  genBefore,
).then(() => true).catch(() => false);
check('(b) forcing WEBGL_lose_context on B produced a fresh clock instance (rebuild happened)', rebuilt);

// Re-convergence needs its own settle window: the fresh clock starts at
// time=0, arbitrarily far from the room's shared time, so the deadband loop
// has real distance to seek across before landing back inside tolerance.
await sleep(2500);
const reSamples = [];
for (let i = 0; i < 5; i++) {
  reSamples.push(await sampleBoth(pageA, pageB));
  await sleep(300);
}
const reWorst = reSamples.reduce((m, s) => (s.diff != null && s.diff > m ? s.diff : m), 0);
check('(b) both pages still sample a clock after B\'s rebuild', reSamples.every((s) => s.diff != null), JSON.stringify(reSamples));
check(`(b) B re-converges to within ${Math.round(CLOCK_TOLERANCE_S * 1000)}ms after rh.rebuild() (§3.2 reapply-after-rebuild)`,
  reWorst <= CLOCK_TOLERANCE_S, 'worst diff=' + (reWorst * 1000).toFixed(1) + 'ms ' + JSON.stringify(reSamples));

check('(setup) no console errors on A', errorsA.length === 0, errorsA.join(' | '));
check('(setup) no console errors on B', errorsB.length === 0, errorsB.join(' | '));

await pageA.close();
await pageB.close();
await browser.close();
server.kill();
relay.close();

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
