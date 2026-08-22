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
//    exists"). Under a virtual X display (Xvfb) with HEADED chromium and
//    `--use-angle=vulkan`, the same code gets `nvidia/ampere` and survives
//    240 sustained frames with device.lost never firing. So: no
//    `--headless` switch anywhere, and this module re-execs itself under
//    xvfb-run (see ensureDisplay() below).
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
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Flags that get the REAL adapter. Measured, not guessed: without
// --use-angle=vulkan chromium picks SwiftShader even on a box with a working
// NVIDIA Vulkan ICD, and --disable-vulkan-fallback-to-gl-for-testing is what
// turns a silent software downgrade into a visible failure.
export const GPU_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--disable-vulkan-fallback-to-gl-for-testing',
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
function shimPage(page) {
  page.setViewport = (vp) => page.setViewportSize(vp);

  const rawGoto = page.goto.bind(page);
  page.goto = (url, opts = {}) => {
    const w = opts.waitUntil;
    // Puppeteer's networkidle0/networkidle2 both map onto Playwright's
    // single 'networkidle'. Left explicit because a typo'd waitUntil is
    // accepted silently by neither library but produces very different waits.
    const waitUntil = w === 'networkidle0' || w === 'networkidle2' ? 'networkidle' : w;
    return rawGoto(url, { ...opts, waitUntil });
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
  page.on = (ev, handler) => {
    if (ev === 'request' && routing) { reqHandlers.push(handler); return page; }
    return rawOn(ev, handler);
  };
  page.setRequestInterception = async (on) => {
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
        for (const h of reqHandlers) {
          await h(facade);
          if (settled) return;
        }
        if (!settled) await route.continue();
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
