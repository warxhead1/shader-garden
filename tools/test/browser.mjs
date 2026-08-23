// Shared bits for the harness: browser resolution + static server.
//
// This harness drives PLAYWRIGHT against a REAL GPU. That is a deliberate
// reversal of how it used to work, and the reasons are measured, not
// inherited — every claim below was reproduced on this box:
//
// 1. `chrome-headless-shell` (what this file used to launch) has NO
//    navigator.gpu at all. Every rendering assertion the battery made ran
//    against SwiftShader software WebGL2. For a shader project that is not
//    verification, it is the appearance of verification.
//
// 2. navigator.gpu is gated on a SECURE CONTEXT. Probing it from about:blank
//    or a data: URL reports "no WebGPU" on a browser that fully supports it
//    — a confident false negative. Only a real http://127.0.0.1 origin (the
//    spec's loopback "potentially trustworthy" exception) exposes the
//    binding, which is what serveSite() below is for.
//
// 3. Under chromium's own `--headless=new`, requestAdapter() DOES resolve —
//    but only ever to `google/swiftshader`, and a device put into active use
//    dies within ~1s ("A valid external Instance reference no longer
//    exists"). HEADED on a real display, the same code gets `nvidia/ampere`
//    and survives 240 sustained frames with device.lost never firing. So: no
//    `--headless` switch anywhere. (An earlier version of this comment
//    credited `--use-angle=vulkan` for that; it does not — see GPU_ARGS
//    below for what that flag actually did, which was break WebGL2.)
//
// 4. Pixel readback from a WebGPU canvas via drawImage -> getImageData
//    returns SOLID BLACK — measured side by side against the same frame,
//    where copyTextureToBuffer returned 4096 distinct colours and the exact
//    expected gradient. A page screenshot of that canvas is likewise a
//    solid-colour PNG. Canvas assertions therefore go through the runtime's
//    own readPixel() (webgpu.js does the copyTextureToBuffer dance
//    correctly, matching webgl2.js's bottom-left coordinate contract) or
//    through raw gl.readPixels on a WebGL2-pinned mount. NEVER through
//    drawImage/getImageData — that route reads black and an "is the canvas
//    non-blank" check fails for a reason that has nothing to do with the
//    product.
//
// Escape hatches, both explicit and both loud:
//   SG_ALLOW_SOFTWARE=1     tolerate a swiftshader adapter (GPU-less CI)
//   SG_USE_REAL_DISPLAY=1   skip the Xvfb wrap and use $DISPLAY as-is
import { createRequire } from 'node:module';
import { startRelay } from '../../server/relay.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const chromium = require('playwright-core').chromium;

// --- display resolution (see point 3) ---------------------------------
// HARD RULE: never render onto the human's session. The browser must run
// headed to keep a stable WebGPU device, and chromium's ozone layer
// auto-detects Wayland from an inherited WAYLAND_DISPLAY — so a harness that
// merely sets DISPLAY=<Xvfb> still throws windows across the developer's
// actual desktop, ignoring the virtual display entirely. That is a real bug
// this file had; the fix is to choose the display explicitly and to pass the
// browser a scrubbed env rather than letting it inherit one.
//
// Preference order:
//   1. SG_WAYLAND_DISPLAY          — explicit override, always wins
//   2. any wayland-N socket in XDG_RUNTIME_DIR that is NOT the inherited
//      WAYLAND_DISPLAY (this box runs headless sway compositors alongside
//      the desktop one; they have dmabuf and give the real NVIDIA adapter)
//   3. Xvfb                        — self-wrap fallback for a box with no
//      spare compositor, e.g. a CI runner
export function resolveDisplay() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
  const explicit = process.env.SG_WAYLAND_DISPLAY;
  if (explicit) return { kind: 'wayland', display: explicit, runtimeDir };
  // The inherited socket belongs to whoever is sitting at this machine.
  // Excluding it by value (rather than hardcoding "wayland-0") is what makes
  // this correct on a box where the desktop happens to own a different one.
  const own = process.env.WAYLAND_DISPLAY;

  // Simulating a GPU-less runner? Say so. Do NOT reach for `env -u
  // WAYLAND_DISPLAY` — see the safety note below for why that is the one
  // input that turns this function's protection inside out.
  if (process.env.SG_FORCE_XVFB) return { kind: 'xvfb', display: null, runtimeDir };

  // SAFETY, and it is not a nicety: this function identifies the human's
  // compositor BY VALUE, as the socket named by WAYLAND_DISPLAY. That makes it
  // correct on a box whose desktop owns wayland-1 instead of wayland-0 — but it
  // means the protection lives entirely in that one variable. With it unset,
  // `own` is undefined, the filter below removes nothing, and spare[0] is the
  // desktop's own socket: the guard stops excluding the user's session and
  // starts TARGETING it. Every launched browser then opens on the monitor
  // someone is working at.
  //
  // 2026-08-22: that is exactly what happened, repeatedly, because `env -u
  // WAYLAND_DISPLAY` looks like a faithful way to imitate a headless runner.
  // It imitates the runner by disabling the only thing keeping windows off the
  // user's screen. So: if we cannot identify whose socket is whose, we take
  // none of them. Xvfb is always safe; guessing never is.
  if (!own) return { kind: 'xvfb', display: null, runtimeDir };

  let socks = [];
  try {
    socks = readdirSync(runtimeDir).filter((f) => /^wayland-\d+$/.test(f)).sort();
  } catch { /* no runtime dir — fall through to Xvfb */ }
  const spare = socks.filter((f) => f !== own);
  if (spare.length) return { kind: 'wayland', display: spare[0], runtimeDir };
  return { kind: 'xvfb', display: null, runtimeDir };
}

// Xvfb fallback only. Re-execs the suite under xvfb-run when there is no
// spare compositor to borrow. Guarded to a real script path: under `node -e`
// or a REPL, argv[1] is not something a child can re-run and the wrap would
// hang forever waiting on it.
function ensureDisplay() {
  if (process.env.SG_UNDER_XVFB || process.env.SG_USE_REAL_DISPLAY) return;
  if (resolveDisplay().kind === 'wayland') return;
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) return;
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, SG_UNDER_XVFB: '1' },
  });
  process.exit(r.status ?? 1);
}
ensureDisplay();

export const SITE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../site');
// Scaled by SLEEP_SCALE, NOT by TIME_SCALE — the two have opposite economics
// and sharing one multiplier was a mistake. A timeout is a CEILING: it costs
// nothing unless it is hit, so scaling it 6x is free insurance. A sleep is a
// FLOOR: every millisecond is paid on every run, including green ones. At 6x,
// garden.mjs's 44 sleeps (37.25s of literals) cost 224s per run to buy settle
// headroom that 2x already provides.
//
// The original reasoning still holds and is why this is not simply unscaled:
// a settle-wait long enough on this workstation is not long enough on a box
// running 6x slower. SLEEP_SCALE keeps that safety at a fraction of the bill.
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * SLEEP_SCALE)));

// Resolve the browser binary. SG_CHROME overrides; otherwise playwright-core
// resolves its own pinned build from ~/.cache/ms-playwright. Kept as a named
// export because webgpu-live.mjs and webgpu-fallback.mjs launch their own
// browsers with bespoke flags and need the same binary this module uses.
export function chromePath() {
  if (process.env.SG_CHROME) return process.env.SG_CHROME;
  return chromium.executablePath();
}

// Exported so tests can predict the exact port serveSite() would pick by
// default (same pid, same formula) — servesite.mjs uses this to pre-squat it.
export function derivePort(offset = 0) {
  return 8100 + ((process.pid + offset) % 1800);
}

// derivePort() is pid-derived, so a suite's port is effectively arbitrary
// within 8100-9899 and can collide with anything else listening on this box.
// serveSite() has always retried (SERVE_ATTEMPTS/RETRY_PORT_STEP below); the
// MP relay did not, and an unhandled 'error' on its server is a hard crash
// before the first check runs. Observed for real: mp-clock died in 0s with
// EADDRINUSE on 127.0.0.1:9101 against an unrelated 29-hour-old service,
// failing a whole 15-minute gate run for a reason that had nothing to do with
// the code under test. Same retry discipline as serveSite, one helper, so the
// four relay suites cannot drift apart on it.
export async function startRelayOnFreePort(opts = {}) {
  const { offset = 0, host = '127.0.0.1', ...rest } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt < SERVE_ATTEMPTS; attempt++) {
    const port = derivePort(offset + attempt * RETRY_PORT_STEP);
    const relay = startRelay({ port, host, ...rest });
    const err = await new Promise((resolve) => {
      const onErr = (e) => resolve(e || new Error('relay listen failed'));
      relay.server.once('error', onErr);
      relay.server.once('listening', () => { relay.server.off('error', onErr); resolve(null); });
    });
    if (!err) return { relay, port };
    lastErr = err;
    try { relay.close(); } catch { /* never listened */ }
    if (err.code !== 'EADDRINUSE') break; // a real failure — retrying just hides it
  }
  throw new Error(`could not bind a relay port after ${SERVE_ATTEMPTS} attempts: ${lastErr?.code || lastErr?.message}`);
}

const PROBE_TIMEOUT_MS = 3000, PROBE_INTERVAL_MS = 100, PROBE_FETCH_TIMEOUT_MS = 500;
const SERVE_ATTEMPTS = 3, RETRY_PORT_STEP = 7;

// Polls `url` until something answers or `child` has already exited —
// whichever comes first — for up to `timeoutMs`. Each individual fetch is
// itself bounded (PROBE_FETCH_TIMEOUT_MS) so a wedged connection attempt
// can't eat the whole budget. Resolves the Response on success, or null.
async function waitForLive(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return null; // died already (e.g. EADDRINUSE) — no point polling further
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), PROBE_FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch {
      // connection refused (still starting) or our own abort — keep polling
    } finally {
      clearTimeout(abortTimer);
    }
    await sleep(PROBE_INTERVAL_MS);
  }
  return null;
}

// Serves `root` on a pid-derived localhost port; caller must kill() the
// result. Verifies the server is both LIVE and OURS before returning —
// a blind fixed sleep used to hand back a URL that nothing (or someone
// else's leaked orphan) was listening on, which surfaces downstream as a
// confusing nav timeout or a test running against the wrong site tree.
// Liveness: poll a real HTTP request instead of guessing a sleep duration.
// Ownership: a colliding squatter serving a DIFFERENT tree is worse than a
// clean bind failure, so a live response only counts if its /index.html is
// byte-identical in length to root's own — otherwise it's treated the same
// as no response at all, and this retries on a new port rather than trusting
// it. Up to SERVE_ATTEMPTS ports are tried (port, then port+7, port+14, ...)
// before giving up loudly instead of ever returning an unverified URL.
export async function serveSite(root = SITE_ROOT, port = derivePort()) {
  const ownBytes = readFileSync(path.join(root, 'index.html')).length;
  const triedPorts = [];

  for (let attempt = 0; attempt < SERVE_ATTEMPTS; attempt++) {
    const attemptPort = port + RETRY_PORT_STEP * attempt;
    triedPorts.push(attemptPort);
    const server = spawn('python3', ['-m', 'http.server', String(attemptPort), '--bind', '127.0.0.1'],
      { cwd: root, stdio: 'ignore' });
    const base = `http://127.0.0.1:${attemptPort}`;

    const res = await waitForLive(`${base}/index.html`, server, PROBE_TIMEOUT_MS);
    if (res && res.ok) {
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.length === ownBytes) return { server, base };
    }
    // Nothing answered in time, the child died (bind failure), or a
    // squatter answered with someone else's content — this attempt is
    // unusable either way; discard it and try the next port.
    try { server.kill(); } catch { /* already gone */ }
  }

  throw new Error(`serveSite: no verified server for ${root} after ${SERVE_ATTEMPTS} attempts (ports tried: ${triedPorts.join(', ')})`);
}

// A second static root, CORS-open (Access-Control-Allow-Origin: *), on a
// different port than serveSite()'s default — for tests that need TWO
// distinct origins in the same run (e.g. tools/test/seed.mjs's foreign-embed
// fixture: the "garden" origin must serve its module + kernel JSON to a
// page on a genuinely different origin, and both `<script type="module">`
// and `fetch()` enforce CORS cross-origin).
export async function serveSiteCors(root, port = derivePort(500)) {
  const script = `
import http.server, socketserver, sys
port = int(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True
with ReusableTCPServer(('127.0.0.1', port), H) as httpd:
    httpd.serve_forever()
`;
  const server = spawn('python3', ['-c', script, String(port)], { cwd: root, stdio: 'ignore' });
  await sleep(800);
  return { server, base: `http://127.0.0.1:${port}` };
}

// Flags that get the REAL adapter on both APIs.
//
// This list deliberately does NOT set --use-angle. An earlier version set
// --use-angle=vulkan on the belief that chromium otherwise picks SwiftShader
// even with a working NVIDIA Vulkan ICD. That belief was WRONG, and wrong in
// an instructive way: it was extrapolated from HEADLESS probes, where it is
// true, and never retested headed -- a correct mechanism wrapped in an
// over-wide "always". Headed, measured side by side on this box:
//
//   --use-angle=vulkan  ->  WebGPU nvidia/ampere,  WebGL2 getContext() NULL
//   (no --use-angle)    ->  WebGPU nvidia/ampere,  WebGL2 works and reads back
//
// WebGPU adapter selection goes through Dawn and is independent of ANGLE, so
// the flag bought nothing on the WebGPU path while completely breaking
// WebGL2 context creation -- which would have silently disabled every
// WebGL2-pinned suite, the composition player (hard-wired WebGL2, no prefer
// knob at all), and all of multiplayer (pinned to WebGL2 by spec §0.5 C1).
// Found by lane M2 during the migration and confirmed here before removal.
//
// Known and accepted: WebGL2 resolves to the integrated AMD Raphael rather
// than the discrete 3070 Ti (the spare compositor this harness borrows runs
// on the iGPU), while WebGPU gets the discrete card. Both are real hardware
// -- neither is SwiftShader -- and that is what the assertions below check.
// Routing WebGL2 to the discrete GPU would mean reconfiguring the
// compositor, which is the developer's environment, not this harness's.
export const GPU_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
];

// The software path, for a GPU-less runner. Named and separate so that
// "we ran on SwiftShader" is always a decision someone made, never a silent
// fallback that a green checkmark hides.
export const SOFTWARE_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
];

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

// Playwright's Page is close enough to Puppeteer's that the suites port
// almost unchanged; these are the gaps that actually bit. Kept as a thin
// shim rather than rewritten call sites so the migration stays reviewable —
// a suite that needs Playwright-native behaviour can always reach past it.
// ONE knob for "this machine is N times slower than the box these numbers were
// tuned on", rather than N env vars — there are 101 hard-coded sub-10s timeouts
// and 214 fixed sleep() calls across 20 suite files, and chasing them
// individually costs one CI round-trip per discovery.
//
// Measured on a GitHub runner (2 cores, SwiftShader, no GPU) against this
// workstation: editor mount 18269ms/19998ms vs an 8000ms budget, the #/garden
// route 44s vs ~4s, 2 rAF callbacks in a window that yields ~30 here. That is
// the ~10x this scales for; CI sets 6 as a headroom-vs-runtime compromise.
//
// WHAT THIS MAY AND MAY NOT TOUCH. Scaling a WAIT (how long we are willing to
// wait for something to happen) retires no check: whatever never happens still
// fails. Scaling a MEASUREMENT WINDOW is also correct and is the reason this is
// a scale rather than a flat raise — "≥5 frames in 500ms" on a machine running
// 6x slower is faithfully "≥5 frames in 3000ms", which preserves the rate being
// asserted instead of deleting it. What it must NEVER do is scale a threshold
// that IS the claim under test (mp-clock's 120ms convergence bound); those are
// written as literals and stay literals.
// `Math.max(1, NaN)` is NaN, not 1 — it does NOT clamp. Parsing straight into
// Math.max meant a typo'd env value (`6x`, `'6 '`, `six`) silently produced a
// NaN scale, which makes sleep() ~0ms and every scaled timeout NaN: the knob
// inverts into "run everything faster and flakier", with nothing logged.
// Reject non-finite input loudly instead of limping.
function readScale(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name}='${raw}' is not a positive number. Timing scale must be numeric; refusing to run with an undefined scale.`);
  }
  return Math.max(1, n);
}

export const TIME_SCALE = readScale('SG_TIME_SCALE', 1);

// Sleeps get their own, deliberately smaller multiplier. SG_TIME_SCALE raises
// WAIT CEILINGS (free unless hit); SG_SLEEP_SCALE raises SETTLE FLOORS (paid
// every run). Defaulting to min(TIME_SCALE, 2) means a CI box asking for 6x
// timeouts still gets 2x settle headroom rather than 6x dead time, and a
// developer box (TIME_SCALE 1) is unchanged at 1x. Override independently
// when a machine genuinely needs more settle than that.
export const SLEEP_SCALE = readScale('SG_SLEEP_SCALE', Math.min(TIME_SCALE, 2));

// Scale a duration that is a wait or an observation window. Named so call
// sites read as a deliberate choice, and so grepping `scaled(` finds every
// place a machine-speed assumption was acknowledged.
export const scaled = (ms) => Math.round(ms * TIME_SCALE);

// A sleep that scales with TIME_SCALE rather than SLEEP_SCALE. Use it — and
// only it — where the elapsed window is itself the denominator of an
// assertion: ">5 frames in 500ms" is a RATE, and shortening the window
// silently RAISES the bar instead of lowering the cost. Splitting sleep from
// timeout was right for settle-waits, but it broke exactly these call sites,
// which had been relying on `sleep()` tracking SG_TIME_SCALE to stay
// frames-per-unit-of-MACHINE-time on a 6x-slower runner. Plain settle-waits
// keep using sleep(); this is the narrow exception, deliberately named so it
// is greppable.
export const slowSleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)));

// NOT action-scoped, despite the name it previously carried: setDefaultTimeout
// governs EVERY page wait that does not pass an explicit timeout — click,
// waitForSelector, waitForFunction alike. Codex flagged the old name
// (SG_ACTION_TIMEOUT_MS) as claiming a narrowness it does not have, and it was
// right; a job-wide widening deserves a job-wide name.
//
// Also worth recording honestly: the .probe-edit-link click that timed out at
// exactly 30000ms is NOT yet proven to be an actionability/stability failure. A
// previous comment here asserted that as fact. All the log establishes is that
// some actionability condition went unmet within the default budget; which one
// needs a Playwright trace to settle.
const DEFAULT_TIMEOUT_MS = Number(process.env.SG_DEFAULT_TIMEOUT_MS || scaled(30000));

function shimPage(page) {
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  page.setViewport = (vp) => page.setViewportSize(vp);

  const rawGoto = page.goto.bind(page);
  page.goto = (url, opts = {}) => {
    const w = opts.waitUntil;
    // Puppeteer's networkidle0/networkidle2 both map onto Playwright's
    // single 'networkidle'. Left explicit because a typo'd waitUntil is
    // accepted silently by neither library but produces very different waits.
    const waitUntil = w === 'networkidle0' || w === 'networkidle2' ? 'networkidle' : w;
    return rawGoto(url, {
      ...opts,
      waitUntil,
      ...(opts.timeout ? { timeout: scaled(opts.timeout) } : {}),
    });
  };

  // waitForSelector defaults differ, and the difference HANGS rather than
  // errors: puppeteer waits for presence in the DOM, Playwright waits for
  // VISIBILITY. A suite waiting on a deliberately-collapsed container (the
  // uniform inspector does exactly this) blocks past any timeout you give
  // it. Restore puppeteer's contract; callers that genuinely want
  // visibility can still pass { state: 'visible' } explicitly.
  //
  // An explicit `timeout:` is also SCALED here. That is the whole point of
  // doing this centrally: there are 101 hard-coded sub-10s timeouts across 20
  // suite files, every one of them tuned on this workstation, and an explicit
  // option overrides setDefaultTimeout — so without this, scaling would silently
  // miss exactly the call sites that already proved they were too tight
  // (`.cm-editor` at 8000ms, `.card` at 8000ms).
  const rawWaitForSelector = page.waitForSelector.bind(page);
  page.waitForSelector = (sel, opts = {}) => rawWaitForSelector(sel, {
    state: 'attached',
    ...opts,
    ...(opts.timeout ? { timeout: scaled(opts.timeout) } : {}),
  });

  // Puppeteer: waitForFunction(fn, options, ...args)
  // Playwright: waitForFunction(fn, arg, options)
  // The parameters are TRANSPOSED, and getting it wrong is silent: the
  // options object arrives inside the page as the function's argument, the
  // call throws in page context, and a caller's .catch() swallows it — so
  // the wait resolves wrong and every timing assertion built on it quietly
  // rots. Detect the puppeteer shape and refuse it rather than guess, since
  // Playwright takes exactly one arg and no remapping is faithful.
  const rawWaitForFunction = page.waitForFunction.bind(page);
  const PP_OPTION_KEYS = ['timeout', 'polling'];
  page.waitForFunction = (fn, arg, opts) => {
    const looksLikePuppeteerOptions = arg && typeof arg === 'object' && !Array.isArray(arg)
      && Object.keys(arg).length > 0 && Object.keys(arg).every((k) => PP_OPTION_KEYS.includes(k));
    if (looksLikePuppeteerOptions && opts === undefined) {
      throw new Error('browser.mjs: waitForFunction(fn, {timeout/polling}, ...) is the PUPPETEER signature. '
        + 'Playwright is waitForFunction(fn, arg, options) — pass the options THIRD, and bundle any page '
        + 'arguments into the single `arg`.');
    }
    return rawWaitForFunction(fn, arg,
      opts && opts.timeout ? { ...opts, timeout: scaled(opts.timeout) } : opts);
  };

  // evaluateOnNewDocument -> addInitScript (9 suites). Same semantics: runs
  // before any page script on every navigation, including iframes.
  page.evaluateOnNewDocument = (fn, ...args) => page.addInitScript({ content:
    typeof fn === 'string' ? fn : `(${fn})(...${JSON.stringify(args)})` });

  // emulateMediaFeatures([{name,value}]) -> emulateMedia({...}) (1 suite).
  page.emulateMediaFeatures = (features) => {
    const o = {};
    for (const f of features || []) {
      if (f.name === 'prefers-color-scheme') o.colorScheme = f.value;
      if (f.name === 'prefers-reduced-motion') o.reducedMotion = f.value;
    }
    return page.emulateMedia(o);
  };

  // select() -> selectOption() (3 suites).
  page.select = (sel, ...values) => page.selectOption(sel, values);

  // Request interception (8 suites). Puppeteer's model is
  // setRequestInterception(true) + page.on('request', r => r.continue());
  // Playwright's is page.route(). Bridged rather than rewritten at 8 call
  // sites, because the puppeteer shape is what those suites read like and a
  // half-ported interception is the kind of bug that silently lets a request
  // through and makes an offline-behaviour test vacuous.
  const reqHandlers = [];
  let routing = false;
  const rawOn = page.on.bind(page);
  let plainRequestObservers = 0;
  page.on = (ev, handler) => {
    // Two legitimate puppeteer patterns, and they need different plumbing:
    //   - interception ON  -> the handler settles requests (continue/abort/
    //     respond), so it must run inside the route handler.
    //   - interception OFF -> a pure OBSERVER that only reads req.url().
    //     Perfectly valid and common; it just cannot settle anything.
    // Only the ordering that mixes them is ambiguous, so only that throws
    // (below, in setRequestInterception) — an observer registered here on
    // its own is passed straight through.
    if (ev === 'request' && routing) { reqHandlers.push(handler); return page; }
    if (ev === 'request') plainRequestObservers += 1;
    return rawOn(ev, handler);
  };
  page.setRequestInterception = async (on) => {
    // The genuinely ambiguous case: handlers registered as plain observers,
    // then interception switched on afterwards. Those handlers are already
    // bound to the observer path, where the Request they receive has no
    // continue()/abort() at all — so they would look enabled and silently
    // fail to settle anything. Fail here, where the mistake is.
    if (on && plainRequestObservers > 0) {
      throw new Error("browser.mjs: setRequestInterception(true) called AFTER page.on('request') was registered "
        + `(${plainRequestObservers} observer(s)). Enable interception first, or those handlers cannot settle requests.`);
    }
    if (on && !routing) {
      routing = true;
      await page.route('**/*', async (route) => {
        const req = route.request();
        let settled = false;
        const facade = {
          url: () => req.url(),
          method: () => req.method(),
          headers: () => req.headers(),
          postData: () => req.postData(),
          resourceType: () => req.resourceType(),
          isNavigationRequest: () => req.isNavigationRequest(),
          continue: (o = {}) => { settled = true; return route.continue(o); },
          abort: (err) => { settled = true; return route.abort(err); },
          // Puppeteer respond({status, contentType, body, headers})
          // -> Playwright fulfill({status, contentType, body, headers}).
          respond: (r = {}) => { settled = true; return route.fulfill(r); },
        };
        if (!reqHandlers.length) { await route.continue(); return; }
        for (const h of reqHandlers) {
          await h(facade);
          if (settled) return;
        }
        // Deliberately NO fallback continue() here. Under puppeteer, an
        // intercepted request that no handler settles stays pending
        // FOREVER, and tests rely on exactly that to hold a request open
        // while they navigate away underneath it. An earlier version of
        // this shim called route.continue() when nothing settled, which
        // released every held request immediately and made those tests
        // vacuous — loader.mjs's stale-mount race then "failed" in a way
        // that looked precisely like an intermittent product bug, and was
        // diagnosed as one. A request left pending here is the correct
        // behaviour, not a leak.
      });
    } else if (!on && routing) {
      routing = false;
      reqHandlers.length = 0;
      await page.unroute('**/*');
    }
  };

  // metrics() -> CDP Performance domain (1 suite).
  page.metrics = async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    await cdp.detach();
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  };

  return page;
}

// Reports what the page's WebGPU adapter actually is. Returns null when the
// browser exposes no navigator.gpu at all. MUST be called on a real
// http://127.0.0.1 origin — see point 2 in this file's header.
export async function gpuInfo(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) return null;
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return { adapter: null };
    const i = a.info || {};
    return { vendor: i.vendor || '', architecture: i.architecture || '', device: i.device || '', description: i.description || '' };
  });
}

// Fails loudly if the browser quietly handed us a software adapter. This is
// the whole point of the migration: a rendering suite that silently runs on
// SwiftShader reports green while proving nothing about the GPU path.
export async function assertRealGpu(page) {
  const info = await gpuInfo(page);
  if (process.env.SG_ALLOW_SOFTWARE) return info;
  if (!info) throw new Error('assertRealGpu: no navigator.gpu — not a secure context, or the wrong binary (see header point 2)');
  if (!info.adapter && info.vendor === undefined) throw new Error('assertRealGpu: requestAdapter() resolved null');
  if (/swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`)) {
    throw new Error(`assertRealGpu: got a SOFTWARE adapter (${info.vendor}/${info.architecture}). `
      + 'Set SG_ALLOW_SOFTWARE=1 to accept this deliberately (GPU-less CI); otherwise the GPU flags are not taking effect.');
  }
  return info;
}

// The WebGL2 counterpart of assertRealGpu(). A WebGL2-pinned suite gets no
// protection from assertRealGpu(), which only inspects the WebGPU adapter --
// so without this a suite could pin to WebGL2, land on SwiftShader, and
// report green while proving nothing. Returns the unmasked renderer string.
export async function assertRealWebgl2(page) {
  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return null;
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  if (renderer === null) throw new Error('assertRealWebgl2: getContext("webgl2") returned null');
  if (process.env.SG_ALLOW_SOFTWARE) return renderer;
  if (/swiftshader|llvmpipe|software|mesa offscreen/i.test(renderer)) {
    throw new Error(`assertRealWebgl2: got a SOFTWARE renderer (${renderer}). `
      + 'Set SG_ALLOW_SOFTWARE=1 to accept this deliberately (GPU-less CI).');
  }
  return renderer;
}

// Headed chromium on the Xvfb display, real Vulkan adapter. `headless` is
// never set — see this file's header, point 3: chromium's own headless mode
// gets a device and then loses it mid-use.
export async function launch({ software = false, viewport = DEFAULT_VIEWPORT, args = [] } = {}) {
  const useSoftware = software || !!process.env.SG_ALLOW_SOFTWARE;
  const disp = resolveDisplay();
  // Scrubbed env, not the inherited one: DISPLAY and WAYLAND_DISPLAY are set
  // to exactly one target and the other is REMOVED, so ozone cannot quietly
  // pick the developer's session over the display we chose.
  const env = { ...process.env };
  delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;
  const platformArgs = [];
  if (disp.kind === 'wayland') {
    env.WAYLAND_DISPLAY = disp.display;
    env.XDG_RUNTIME_DIR = disp.runtimeDir;
    platformArgs.push('--ozone-platform=wayland');
  } else {
    env.DISPLAY = process.env.DISPLAY || ':99';
    platformArgs.push('--ozone-platform=x11');
  }
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: false,
    env,
    args: [...(useSoftware ? SOFTWARE_ARGS : GPU_ARGS), ...platformArgs, ...args],
  });
  const rawNewPage = browser.newPage.bind(browser);
  browser.newPage = async (opts = {}) => shimPage(await rawNewPage({ viewport, ...opts }));
  return browser;
}

// Explicit software launch, for suites that are about the WebGL2 fallback
// path itself rather than about rendering fidelity.
export async function launchSoft(opts = {}) {
  return launch({ ...opts, software: true });
}

// Transient nav-timeout flake: headless chrome under host load sporadically
// blows the goto timeout on a page that would load fine one second later —
// reproduced across every test file and on unmodified base commits (it's
// infra, not product). Retry a timed-out goto ONCE before letting it fail
// for real; anything that times out twice in a row is a genuine failure.
// All test files route page.goto through this.
export async function gotoSafe(page, url, opts) {
  try {
    return await page.goto(url, opts);
  } catch (e) {
    if (!String(e).includes('Navigation timeout')) throw e;
    console.log(`  [gotoSafe] nav timeout, retrying once: ${url}`);
    return page.goto(url, opts);
  }
}
