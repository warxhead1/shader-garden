// Shader Garden — mp-compile-swap.mjs
// Multiplayer spec §10 gate: I4, the single most important suite in the
// wave — "a syntactically broken committed body NEVER blanks a receiving
// client's world." §6.2's two-sided validation only matters if a broken
// body can actually REACH a receiver's handleRemoteCommit; the production
// UI (edit.js's commitBtn) structurally can't send one — it only ever
// commits `lastGoodBody`, which is only set once local recompile()
// succeeds (edit.js:74/110). So this suite plays the griefer itself: a raw
// `WebSocket` client that skips the holder's own local validation entirely
// and commits garbage straight over the wire, exactly like §6.2 step 2's
// "on receiving a commit" describes. The real assertions all live on a
// second, ordinary puppeteer page playing the receiver.
// Usage: node tools/test/mp-compile-swap.mjs   (first: npm ci in tools/test)
import { readFileSync } from 'node:fs';
import { launch, serveSite, sleep, gotoSafe, derivePort, assertRealGpu, SITE_ROOT, startRelayOnFreePort } from './browser.mjs';
import { parseScene } from '../../site/js/organs/garden/parse.js';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

// §C5: own explicit relay port, distinct from serveSite()'s default and the
// other MP suites' own offsets.

// Retries on EADDRINUSE — derivePort() can land on any listener on the
// box; see startRelayOnFreePort() in browser.mjs.
const { relay, port: RELAY_PORT } = await startRelayOnFreePort({ offset: 630 });
// No second wait for 'listening' here: startRelayOnFreePort() already awaited
// that event to decide the port was free, and it fires exactly ONCE. Waiting
// again registers a listener for something that has already happened, which
// hangs the suite forever with no output at all rather than failing.


const { server, base: BASE } = await serveSite();
const browser = await launch();
const ROOM = 'compile-swap-test';
// See mp-clock.mjs's header note (relayUrlFor): net.js's resolveUrl() reads
// window.location.search, not the hash's own query string — the relay
// override has to sit before the hash. It ALSO has to carry the room in its
// own URL path (relay.mjs routes purely off the WS upgrade URL's path
// segment; net.js never appends `room` there, only to the `hello` payload)
// — without this the browser page and the raw attacker client below land in
// two different rooms (the page falls back to relay.mjs's "lobby") and
// never see each other's messages at all. Confirmed empirically while
// developing this suite; flagged as a cross-lane bug in the final report.
const relayUrlFor = (room) => `ws://127.0.0.1:${RELAY_PORT}/${room}`;
const RELAY_URL = relayUrlFor(ROOM); // also reused below to build the raw attacker client's own URL
const roomUrl = (room) => `${BASE}/index.html?relay=${encodeURIComponent(relayUrlFor(room))}#/garden/${room}`;

// Ground truth for the 'sky' component's pristine body, independently
// parsed — never hand-copied, same technique the other MP suites use.
const sceneSrc = readFileSync(`${SITE_ROOT}/assets/garden/scene.glsl`, 'utf8');
const { components } = parseScene(sceneSrc);
const skyComponent = components.find((c) => c.id === 'sky');
if (!skyComponent) { console.log('FAIL setup: scene.glsl has no "sky" @component — pick a different target'); process.exit(1); }

/* ---------------- raw protocol client (the griefer) ---------------- */

function rawClient() {
  // RELAY_URL already carries the room in its path (relayUrlFor(ROOM))
  const ws = new WebSocket(RELAY_URL);
  const received = [];
  ws.addEventListener('message', (ev) => { try { received.push(JSON.parse(ev.data)); } catch { /* ignore */ } });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return { ws, received, opened };
}

function sendRaw(client, msg) { client.ws.send(JSON.stringify(msg)); }

/** Waits for the next message of `type` to arrive AFTER `afterIndex` in the
 *  client's own received log (each call passes back the index it found, so
 *  a caller can request several messages of the same type in sequence
 *  without re-matching an already-consumed one). */
async function waitForNext(client, type, afterIndex, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = afterIndex + 1; i < client.received.length; i++) {
      if (client.received[i].t === type) return { msg: client.received[i], index: i };
    }
    await sleep(50);
  }
  return null;
}

/* ---------------- receiver-page helpers ---------------- */

async function clickTrayItem(page, name) {
  await page.waitForSelector('.garden-tray-item', { timeout: 8000 });
  const items = await page.$$('.garden-tray-item');
  for (const item of items) {
    const text = await item.$eval('.garden-tray-item-name', (el) => el.childNodes[0].textContent.trim());
    if (text === name) { await item.click(); return true; }
  }
  return false;
}

async function forceTextareaFallback(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('cm-editor.bundle.js')) { req.abort().catch(() => {}); return; }
    req.continue().catch(() => {});
  });
}

// Stashes the live runtime instance on window.__runtime the same way
// mp-clock.mjs/mp-two-browsers.mjs's spies do, patching BOTH
// GL2Runtime.prototype and GPURuntime.prototype — a fresh #/garden/:room
// mount lands on WebGPU by default (§0.5 C1 supersession), so
// readCanvasPixel/isContextLost below need to know which backend is live to
// dispatch correctly. setUniforms is shared, harmless surface to hook (same
// choice mp-two-browsers.mjs's armUniformSpy makes) — this suite doesn't
// read window.__uniformCalls itself, only uses the spy for its window.__runtime
// side effect.
async function armRuntimeSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__runtime = null;
    function patch(Ctor) {
      const orig = Ctor.prototype.setUniforms;
      Ctor.prototype.setUniforms = function (values) {
        window.__runtime = this;
        return orig.call(this, values);
      };
    }
    import('./js/runtime/webgl2.js').then((mod) => patch(mod.GL2Runtime)).catch(() => {});
    import('./js/runtime/webgpu.js').then((mod) => patch(mod.GPURuntime)).catch(() => {});
  });
}

// canvasPixelCoords is the runtime's own client-coords -> drawing-buffer
// conversion (uniforms.js, shared by the mouse-probe path) — reused here
// instead of hand-deriving DPR/renderScale math a second time.
//
// Backend-agnostic dispatch off window.__runtime (armRuntimeSpy above),
// mirroring production's probe.js: GPURuntime.readPixel() renders into its
// own dedicated offscreen texture and never touches the visible canvas, so
// it needs no rAF trick. The WebGL2 branch still reads inside a
// requestAnimationFrame callback, not a bare evaluate() — confirmed
// empirically: the mounted canvas has preserveDrawingBuffer:false
// (webgl2.js's default), so a readPixels() from an ordinary evaluate()
// (which runs on its own later tick, after the browser has already
// presented and implicitly cleared the backbuffer) reads back all-zero even
// though the canvas visibly shows real content. Reading synchronously
// inside a rAF callback lands right after that frame's own draw, before the
// next clear — the same reason every OTHER pixel-oracle suite in this repo
// (comp0.mjs, garden-camera.mjs, perf.mjs) calls renderOnce() immediately
// before its own readPixels(); this suite can't call renderOnce() directly
// on the WebGL2 path (no handle on the mounted runtime without the spy), so
// rAF is the equivalent hook for a canvas driving its own render loop.
async function readCanvasPixel(page, clientX, clientY) {
  // Playwright's page.evaluate() takes exactly one arg — bundle the coords.
  return page.evaluate(({ cx, cy }) => new Promise(async (resolve) => {
    const rt = window.__runtime;
    if (!rt) { resolve(null); return; }
    const { canvasPixelCoords } = await import('./js/runtime/uniforms.js');
    const canvas = rt.canvas || document.querySelector('.garden-canvas');
    if (!canvas) { resolve(null); return; }
    const [x, y] = canvasPixelCoords(canvas, cx, cy);
    if (typeof rt.readPixel === 'function') {
      if (rt.isContextLost()) { resolve(null); return; }
      const t = rt.getClock().time;
      const px = await rt.readPixel(x, y, t).catch(() => null);
      resolve(px ? Array.from(px) : null);
      return;
    }
    const gl = canvas.getContext('webgl2');
    if (!gl || gl.isContextLost()) { resolve(null); return; }
    requestAnimationFrame(() => {
      const px = new Uint8Array(4);
      gl.readPixels(Math.round(x), Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      resolve(Array.from(px));
    });
  }), { cx: clientX, cy: clientY });
}

// Backend-agnostic: both GL2Runtime and GPURuntime expose their own
// isContextLost() (webgpu.js listens for device.lost the same way the
// canvas-level WEBGL_lose_context extension signals GL2Runtime) — dispatch
// through window.__runtime instead of assuming a WebGL2 context exists at
// all, which would return null unconditionally on a WebGPU-backed mount.
async function isContextLost(page) {
  return page.evaluate(() => {
    const rt = window.__runtime;
    return rt ? rt.isContextLost() : null;
  });
}

/* ---------------- receiver page setup ---------------- */

const errors = [];
const page = await browser.newPage();
page.on('console', (m) => {
  // The forced cm-editor.bundle.js 404 (forceTextareaFallback) is expected
  // noise, same exclusion garden.mjs's own forceTextareaFallback tests use.
  if (m.type() === 'error' && !(m.location().url || '').includes('cm-editor.bundle.js')) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await forceTextareaFallback(page);
await armRuntimeSpy(page);

await gotoSafe(page, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => errors.push('NAV: ' + e.message));
await page.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errors.push('no garden-canvas'));
// This suite asserts on rendering output (canvas pixels, context-loss
// state) as its core I4 evidence — proves a real GPU adapter is behind it,
// not a silent SwiftShader/llvmpipe landing that would report green while
// proving nothing about the real broken-commit-survival path.
const gpuInfo = await assertRealGpu(page);
check('(setup) receiver has a live real-GPU adapter (not SwiftShader/llvmpipe)', !!gpuInfo, JSON.stringify(gpuInfo));
// Playwright's waitForFunction(pageFunction, arg, options) puts arg BEFORE
// options (opposite of puppeteer's (fn, options, ...args)) — this predicate
// takes no data arg, so undefined must be passed explicitly.
const receiverLive = await page.waitForFunction(
  () => document.querySelector('.garden-mp-status')?.textContent === 'live',
  undefined, { timeout: 15000 },
).then(() => true).catch(() => false);
check('(setup) receiver reached live status', receiverLive);

// Open the 'sky' probe -> "Edit here" once, up front — this is also the
// non-holder read-only mirror path (§5.2), so its buffer is a second,
// independent witness for "the broken commit never landed": a successful
// commit calls the mirror's setBody(); a rejected one never touches it.
//
// PRODUCT BUG (see mp-two-browsers.mjs's report for the full trace, found
// independently there and reproduced with a single non-MP page): every
// "Edit here" click on a WebGPU-backed mount silently fails to show an
// editor — index.js's onEditHere rebuilds onto WebGL2 first
// (rh.rebuild({prefer:'webgl2'})), but runtime-host.js's build() does an
// unscoped host.replaceChildren() on the shared `stage` element, which is
// also the probe panel's own parent — the rebuild detaches the panel (and
// the editHost inside it) mid-handler. mountComponentEditor() still
// resolves and appends its result, just into an orphaned subtree. Every
// #/garden/:room mount now defaults to WebGPU, so this fires here every
// time. Not fixable in this lane (core/runtime-host.js and
// organs/garden/index.js are outside the seven owned files) — the
// editor-dependent checks below are gated on editorAvailable and degrade to
// honest FAILs rather than crashing; the core I4 pixel/context-loss
// evidence below does NOT depend on the editor and runs regardless.
const opened = await clickTrayItem(page, skyComponent.name);
check('(setup) opened the sky probe panel', opened);
await sleep(200);
await page.click('.probe-panel .btn:not(.probe-edit-link)').catch(() => {}); // "Edit here"
await page.waitForSelector('.component-editor .code-editor', { timeout: 8000 }).catch(() => {});
await sleep(300);
const editorAvailable = !!(await page.$('.component-editor .code-editor'));
if (!editorAvailable) console.log('  [note] editor never mounted (product bug — see comment above); gating editor-dependent checks');

const readOnlyBefore = editorAvailable
  ? await page.$eval('.component-editor', (el) => el.classList.contains('component-editor-readonly')).catch(() => null)
  : null;
check('(setup) the receiver\'s editor mounted read-only (not the holder)', editorAvailable && readOnlyBefore === true, editorAvailable ? 'got ' + readOnlyBefore : 'BLOCKED: editor never mounted');

const editorBodyBefore = editorAvailable
  ? await page.$eval('.component-editor .code-editor', (el) => el.value).catch(() => null)
  : null;
check('(setup) the editor shows the pristine sky body before any commit', editorAvailable && editorBodyBefore === skyComponent.source, editorAvailable ? '' : 'BLOCKED: editor never mounted');

const skyPixelBefore = await readCanvasPixel(page, 720, 60);
const charPixelBefore = await readCanvasPixel(page, 720, 380);
check('(setup) got a baseline sky pixel', Array.isArray(skyPixelBefore), JSON.stringify(skyPixelBefore));
check('(setup) got a baseline character pixel', Array.isArray(charPixelBefore), JSON.stringify(charPixelBefore));
check('(setup) canvas not context-lost before any of this', (await isContextLost(page)) === false);

/* ---------------- attacker: join, self-grant the lease, commit garbage ---------------- */

const attacker = rawClient();
await attacker.opened;
sendRaw(attacker, { t: 'hello', protocol: 'sg.mp.v1', room: ROOM, name: 'Griefer' });
const welcome = await waitForNext(attacker, 'welcome', -1);
check('(setup) attacker joined the room', !!welcome, JSON.stringify(attacker.received));
let idx = welcome ? welcome.index : -1;
const selfId = welcome && welcome.msg.selfId;
let epoch = welcome ? welcome.msg.epoch : null;

sendRaw(attacker, { t: 'ring', inRing: true }); // §5.1: lease.request only grants to an in-ring member
sendRaw(attacker, { t: 'lease.request' });
const leaseMsg = await waitForNext(attacker, 'lease', idx);
check('(setup) attacker self-granted the lease (server has no shader validation of its own)',
  !!leaseMsg && leaseMsg.msg.holder === selfId, JSON.stringify(leaseMsg));
idx = leaseMsg ? leaseMsg.index : idx;

// A syntactically broken body — not even close to GLSL. Never sent by any
// real client (the UI structurally can't produce this), which is exactly
// why this suite has to forge it at the protocol layer.
const BROKEN_BODY = 'this is not glsl at all {{{ unterminated';
sendRaw(attacker, { t: 'commit', componentId: 'sky', body: BROKEN_BODY, baseEpoch: epoch });
const brokenCommitEcho = await waitForNext(attacker, 'commit', idx);
check('(setup) the relay broadcast the broken commit (it has no shader validation, by design)',
  !!brokenCommitEcho, JSON.stringify(brokenCommitEcho));
idx = brokenCommitEcho ? brokenCommitEcho.index : idx;
const epochAfterBroken = brokenCommitEcho ? brokenCommitEcho.msg.epoch : epoch + 1;

/* ---------------- assertions: receiver survives the broken commit ---------------- */

const rejectedStatus = await page.waitForFunction(
  () => /didn.t compile here/.test(document.querySelector('.garden-mp-status')?.textContent || ''),
  undefined, { timeout: 15000 },
).then(() => true).catch(() => false);
check('(a) receiver shows a visible rejection notice for the broken commit', rejectedStatus);

check('(a) canvas not context-lost after the broken commit', (await isContextLost(page)) === false);

const skyPixelAfterBroken = await readCanvasPixel(page, 720, 60);
const charPixelAfterBroken = await readCanvasPixel(page, 720, 380);
// RGB channels only, NOT the full RGBA array: both canvas contexts here are
// created with {alpha:false} (webgl2.js's default / GPURuntime's opaque
// format), so alpha always reads back 255 regardless of what the RGB
// channels actually show — `pixel.some(v => v > 0)` on the full array is
// trivially true even for a fully black (context-lost-looking) frame,
// satisfied by alpha alone. Scoping to slice(0,3) makes this a real
// non-blank check on color, not a vacuous alpha check.
check('(a) canvas still renders non-blank at the sky oracle after the broken commit',
  Array.isArray(skyPixelAfterBroken) && skyPixelAfterBroken.slice(0, 3).some((v) => v > 0), JSON.stringify(skyPixelAfterBroken));
check('(a) canvas still renders non-blank at the character oracle after the broken commit',
  Array.isArray(charPixelAfterBroken) && charPixelAfterBroken.slice(0, 3).some((v) => v > 0), JSON.stringify(charPixelAfterBroken));

const editorBodyAfterBroken = editorAvailable
  ? await page.$eval('.component-editor .code-editor', (el) => el.value).catch(() => null)
  : null;
check('(a) the read-only mirror STILL shows the pristine body — the broken commit never advanced local state (I4 epoch guard)',
  editorAvailable && editorBodyAfterBroken === skyComponent.source, editorAvailable ? 'got ' + JSON.stringify(editorBodyAfterBroken) : 'BLOCKED: editor never mounted');

/* ---------------- then: a GOOD commit still applies ---------------- */

// Same function name/signature, valid body, a color no natural sky gradient
// produces — a clean, unambiguous "did this actually apply" pixel oracle
// (same idiom runtime-prepare-shader.mjs uses for its solid-color bodies).
const GOOD_BODY = `vec3 sg_sky_color(vec3 rd, float time) {\n  return vec3(1.0, 0.0, 1.0); // magenta — never produced by the real gradient\n}`;
sendRaw(attacker, { t: 'commit', componentId: 'sky', body: GOOD_BODY, baseEpoch: epochAfterBroken });
const goodCommitEcho = await waitForNext(attacker, 'commit', idx);
check('(b) the relay broadcast the good commit', !!goodCommitEcho, JSON.stringify(goodCommitEcho));

// Playwright's waitForFunction(pageFunction, arg, options) puts arg BEFORE
// options (opposite of puppeteer's (fn, options, ...args)).
const editorBodyAfterGood = editorAvailable && await page.waitForFunction(
  (expected) => document.querySelector('.component-editor .code-editor')?.value === expected,
  // 15000 was arithmetically too small, and the gate proved it. A remote commit
  // is gated on the RECEIVER, and that gate retries a TLE (garden/index.js:859,
  // REMOTE_GATE_TRIES=3, REMOTE_GATE_BACKOFF_MS=500). Worst case before the
  // mirror can possibly update:
  //
  //   3 attempts x (contextMs 1000 + compileMs 2500 + frameMs 800) = 12900ms
  //   backoff 500x1 + 500x2                                        =  1500ms
  //                                                                = 14400ms
  //
  // against a 15000ms budget — leaving 600ms for the compile, the atomic swap
  // and the DOM write. So this failed whenever a retry fired at all, and passed
  // only on runs where none did. Not flake: a test budget smaller than the
  // product's own documented worst-case latency.
  //
  // 45000 = the 14400ms ceiling plus room for prepareShader's compile+swap,
  // still far below any wall-clock the suite runner cares about.
  GOOD_BODY, { timeout: 45000 },
).then(() => true).catch(() => false);
check('(b) the read-only mirror picks up the good commit\'s body', editorAvailable && editorBodyAfterGood, editorAvailable ? '' : 'BLOCKED: editor never mounted');

const skyPixelAfterGood = await readCanvasPixel(page, 720, 60);
// Not an exact-magenta check: sg_sky_color()'s vec3(1,0,1) output still
// passes through mainImage's own tonemap/exposure/fog before it becomes a
// pixel, so the readback is a muted, not pure, magenta (measured on this
// box: [154,129,146] against a [155,166,177] baseline — R rises relative to
// G/B exactly as a magenta tint should, just compressed). A Euclidean color
// distance from the pre-commit baseline is the robust "did this actually
// apply" signal: the SAME oracle read twice with nothing committed in
// between (the broken-commit checks above) measured ~0 distance, so any
// real threshold well above that separates "applied" from "noise" cleanly.
const colorDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dist = Array.isArray(skyPixelAfterGood) ? colorDist(skyPixelBefore, skyPixelAfterGood) : -1;
check('(b) the sky pixel meaningfully changed once a VALID commit applied (color distance from baseline)',
  dist >= 25,
  'before=' + JSON.stringify(skyPixelBefore) + ' after=' + JSON.stringify(skyPixelAfterGood) + ' dist=' + dist.toFixed(1));

check('no console errors on the receiver across the whole sequence', errors.length === 0, errors.join(' | '));

await page.close();
try { attacker.ws.close(); } catch { /* already going away */ }
await browser.close();
server.kill();
relay.close();

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
