// Shader Garden — mp-two-browsers.mjs
// Multiplayer spec §10 gate: one room, two pages (same browser instance —
// cheaper than two browsers despite the suite's name, per the brief).
// Covers:
//   (a) B's peer uniforms track A's movement.
//   (b) A's commit changes B's RENDERED scene — asserted on canvas pixels,
//       not a JS variable.
//   (c) B's lease request is denied while A holds it.
//   (d) B's editor is read-only and mirrors A's (uncommitted) draft.
// Usage: node tools/test/mp-two-browsers.mjs   (first: npm ci in tools/test)
import { readFileSync } from 'node:fs';
import { startRelay } from '../../server/relay.mjs';
import { launch, serveSite, sleep, gotoSafe, derivePort, assertRealGpu, SITE_ROOT } from './browser.mjs';
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
const RELAY_PORT = derivePort(620);
const relay = startRelay({ port: RELAY_PORT, host: '127.0.0.1' });
await new Promise((resolve, reject) => {
  relay.server.once('listening', resolve);
  relay.server.once('error', reject);
});

const { server, base: BASE } = await serveSite();
const browser = await launch();
const ROOM = 'two-browsers-test';
// See mp-clock.mjs's relayUrlFor header note: the query param has to sit
// before the hash (net.js reads window.location.search), AND the relay URL
// itself has to carry the room in its path (relay.mjs routes purely off the
// WS upgrade URL's path segment — net.js never appends room there, only to
// the hello payload). Both confirmed empirically; flagged as a cross-lane
// bug in this suite's report.
const relayUrlFor = (room) => `ws://127.0.0.1:${RELAY_PORT}/${room}`;
const roomUrl = (room) => `${BASE}/index.html?relay=${encodeURIComponent(relayUrlFor(room))}#/garden/${room}`;

const sceneSrc = readFileSync(`${SITE_ROOT}/assets/garden/scene.glsl`, 'utf8');
const { components } = parseScene(sceneSrc);
const skyComponent = components.find((c) => c.id === 'sky');
if (!skyComponent) { console.log('FAIL setup: scene.glsl has no "sky" @component'); process.exit(1); }

/* ---------------- page helpers ---------------- */

// Multiplayer spec §0.5 C1 is SUPERSEDED: WGSL's custom-uniform bank was
// raised 32->128 slots (mp/integration 69e2f2f, ceb35ea) and scene.wgsl
// restored a real sg_peers_sdf body, so 50 flattened peer scalars now fit
// comfortably and multiplayer is no longer WebGL2-pinned. This suite used to
// block canvas.getContext('webgpu') here to force the fallback path; that's
// removed — both pages now run whatever backend runtime-host.js's
// prefer:'auto' picks for a fresh room mount, WebGPU by default on this box,
// same as every other suite post-migration.
async function forceTextareaFallback(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('cm-editor.bundle.js')) { req.abort().catch(() => {}); return; }
    req.continue().catch(() => {});
  });
}

// Same GL2Runtime.setUniforms spy garden-movement.mjs's armSpies uses, now
// patching BOTH runtime classes (setUniforms is shared surface on
// GL2Runtime and GPURuntime — see mp-clock.mjs's armClockSpy for the same
// pattern) since a fresh room mount can land on either backend post-§0.5-C1-
// supersession. Also stashes the live instance on window.__runtime so
// readCanvasPixel below can dispatch its readback without caring which
// backend is live.
async function armUniformSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__uniformCalls = [];
    window.__runtime = null;
    function patch(Ctor) {
      const orig = Ctor.prototype.setUniforms;
      Ctor.prototype.setUniforms = function (values) {
        window.__runtime = this;
        window.__uniformCalls.push({ ...values });
        return orig.call(this, values);
      };
    }
    import('./js/runtime/webgl2.js').then((mod) => patch(mod.GL2Runtime)).catch(() => {});
    import('./js/runtime/webgpu.js').then((mod) => patch(mod.GPURuntime)).catch(() => {});
  });
}

// Spies GL2Runtime.prepareShader() — the ONLY entry point index.js's
// handleRemoteCommit() calls to actually compile+swap a peer's committed
// body onto this page's runtime (site/js/organs/garden/index.js:869). A
// `draft` message only ever touches the read-only mirror's textarea value —
// it is never passed through here. Counting calls to this one function is a
// direct, non-flaky proof that "the draft alone didn't recompile B's
// scene", which a raw canvas-pixel diff cannot give cleanly: the sky itself
// has a real, uncontrolled animated element (scene.glsl's clouds component,
// `sg_cloud_mask`, drifts an fbm field by iTime with a hard smoothstep edge)
// that can swing a fixed sky pixel by 90+ RGB-distance units across the
// ~1s a draft's debounce (edit.js 300ms + net.js DRAFT_DEBOUNCE_MS 150ms)
// takes to land, with nothing to do with compilation at all — confirmed
// empirically: an early draft of this suite asserted `dist < 15` on the
// pre-commit pixel and flaked FAIL with dist~96 purely from cloud drift.
async function armPrepareSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__prepareCalls = 0;
    function patch(Ctor) {
      const orig = Ctor.prototype.prepareShader;
      Ctor.prototype.prepareShader = function (...args) {
        window.__runtime = this;
        window.__prepareCalls++;
        return orig.apply(this, args);
      };
    }
    import('./js/runtime/webgl2.js').then((mod) => patch(mod.GL2Runtime)).catch(() => {});
    import('./js/runtime/webgpu.js').then((mod) => patch(mod.GPURuntime)).catch(() => {});
  });
}

// Captures every WebSocket this page opens, AND every message it receives
// on it, so a test can (a) send a raw protocol message directly on the
// page's own REAL connection and (b) read back what the server actually
// said, independent of any DOM the production UI may or may not have kept
// alive.
//
// This is load-bearing, not a convenience: index.js's `if (room) {...}`
// block builds the roster/lease/game panel (`mpPanel`) and appends it to
// `stage` at the very TOP of mount() — BEFORE the later
// `rh = await runtimeHost(stage, {...})` call. runtime-host.js's build()
// does `host.replaceChildren()` on that same `stage` element to mount its
// canvas (core/runtime-host.js:89/186), which silently deletes mpPanel (the
// roster `<ul>`, the lease line/button, the game controls) the instant the
// runtime finishes its first build. Confirmed empirically: `.garden-canvas`,
// `.garden-mp-status` and `.garden-mp-room` all exist post-mount (they're
// children of `topbar`, a sibling never cleared) but `.garden-mp-panel`,
// `.garden-roster`, `.garden-lease-btn` and `.garden-lease-line` do not
// exist AT ALL in the live DOM on either page — there is no lease button to
// click and no roster to read. The internal `lastLease`/`isHolder` state
// index.js's own authorization logic runs on is unaffected (it's driven by
// the `onLease` callback, not the dead DOM), so this suite drives lease
// acquisition/denial over each page's own real socket instead — the actual
// production wire protocol, just without the (currently non-functional) UI
// affordance in front of it. Flagged as the top bug in this suite's report;
// out of scope to fix (index.js is L5's file, off-limits here).
async function armSocketSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__sockets = [];
    window.__wsReceived = [];
    const OrigWS = window.WebSocket;
    window.WebSocket = new Proxy(OrigWS, {
      construct(target, args) {
        const ws = new target(...args);
        window.__sockets.push(ws);
        ws.addEventListener('message', (ev) => { try { window.__wsReceived.push(JSON.parse(ev.data)); } catch { /* ignore */ } });
        return ws;
      },
    });
  });
}

function sendOnLiveSocket(page, msg) {
  return page.evaluate((m) => window.__sockets[window.__sockets.length - 1]?.send(JSON.stringify(m)), msg);
}

/** Waits for the next message of `type` in this page's own __wsReceived log
 *  after `afterIndex` — same technique mp-compile-swap.mjs's rawClient
 *  waitForNext uses, adapted to read a page's real production socket. */
async function waitForNextOnPage(page, type, afterIndex, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Playwright's page.evaluate() takes exactly one arg (unlike puppeteer's
    // variadic form) — bundle type/afterIndex into a single object.
    const found = await page.evaluate(({ t, i }) => {
      const log = window.__wsReceived;
      for (let idx = i + 1; idx < log.length; idx++) if (log[idx].t === t) return { msg: log[idx], index: idx };
      return null;
    }, { t: type, i: afterIndex });
    if (found) return found;
    await sleep(50);
  }
  return null;
}

// This suite is the only one that runs TWO live gardens at once, and they
// share one GPU. That is not a load any real user's machine sees, and it
// starves the admission gate's sacrificial worker: its render phase misses
// the 800ms frame heartbeat (WATCHDOG.frameMs) and every commit comes back
// TLE -> 'local-compile-failed', with the compiler never reached. MEASURED:
// the same trial source gates OK in ~1150ms on one page and TLEs at ~1800ms
// with both pages live. So pin both tabs to the product's own 'low' quality
// preset (renderScale 0.5, SG_QUALITY 0) to bring two tabs back inside a
// one-tab GPU budget. This changes only how much the two gardens cost to
// draw — no assertion here depends on render scale or march-step count, and
// probe coordinates are CSS-space, unaffected by renderScale.
function freshPage(errors) {
  return browser.newPage().then(async (page) => {
    await page.evaluateOnNewDocument(() => {
      try { localStorage.setItem('sg.garden.quality', 'low'); } catch { /* storage blocked */ }
    });
    page.on('console', (m) => {
      if (m.type() === 'error' && !(m.location().url || '').includes('cm-editor.bundle.js')) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    return page;
  });
}

async function waitLive(page, label) {
  // Playwright's waitForFunction(pageFunction, arg, options) puts arg BEFORE
  // options (opposite of puppeteer) — this predicate takes no data arg, so
  // undefined must be passed explicitly or the options object silently binds
  // as arg and the intended timeout never applies.
  const ok = await page.waitForFunction(
    () => document.querySelector('.garden-mp-status')?.textContent === 'live',
    undefined, { timeout: 15000 },
  ).then(() => true).catch(() => false);
  if (!ok) console.log(`  [${label}] never reached 'live' status`);
  return ok;
}

async function clickTrayItem(page, name) {
  await page.waitForSelector('.garden-tray-item', { timeout: 8000 });
  const items = await page.$$('.garden-tray-item');
  for (const item of items) {
    const text = await item.$eval('.garden-tray-item-name', (el) => el.childNodes[0].textContent.trim());
    if (text === name) { await item.click(); return true; }
  }
  return false;
}

async function openEditHere(page) {
  await page.click('.probe-panel .btn:not(.probe-edit-link)').catch(() => {});
  return page.waitForSelector('.component-editor .code-editor', { timeout: 8000 }).then(() => true).catch(() => false);
}

// Same Ctrl+A/Backspace/type technique garden.mjs's replaceAllAndType uses
// (a plain textarea's triple-click only selects one paragraph, not the
// whole multi-paragraph body).
async function replaceAllAndType(page, text) {
  await page.focus('.component-editor .code-editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 2 });
}

// Backend-agnostic pixel read, dispatching off window.__runtime (stashed by
// armUniformSpy/armPrepareSpy above) the same way production's probe.js
// picks between GPURuntime and GL2Runtime: `typeof rt.readPixel ===
// 'function'` means WebGPU, which has its own offscreen
// copyTextureToBuffer readback that never touches the visible canvas or its
// context type. The WebGL2 branch still needs the requestAnimationFrame
// read, not a bare evaluate() — the mounted canvas has
// preserveDrawingBuffer:false, so a readback from an ordinary evaluate() (a
// later tick, after the browser has already presented and implicitly
// cleared the backbuffer) reads all-zero even though the canvas visibly
// shows content. Confirmed empirically developing mp-compile-swap.mjs; see
// that file's readCanvasPixel header for the full story.
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
      // WebGPU: offscreen readback (probe.js's contract — drawing-buffer
      // pixel coords, sim clock time, not wall time), never touches the
      // visible canvas or its context type.
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
const colorDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* ---------------- setup: A joins, then B (so A is B's slot 0 peer) ---------------- */

const errorsA = [], errorsB = [];
const pageA = await freshPage(errorsA);
const pageB = await freshPage(errorsB);
await forceTextareaFallback(pageA);
await forceTextareaFallback(pageB);
await armUniformSpy(pageB);
await armPrepareSpy(pageB);
await armPrepareSpy(pageA); // see the commit diagnostic below — separates a gate reject from a compile reject
await armSocketSpy(pageA); // A becomes the lease holder over its own real socket — see armSocketSpy's header note
await armSocketSpy(pageB);

await gotoSafe(pageA, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => errorsA.push('NAV: ' + e.message));
await pageA.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errorsA.push('no garden-canvas'));
check('(setup) A reached live status', await waitLive(pageA, 'A'));
const aWelcome = await waitForNextOnPage(pageA, 'welcome', -1);
check('(setup) captured A\'s own welcome (selfId)', !!aWelcome, JSON.stringify(aWelcome));
const aSelfId = aWelcome && aWelcome.msg.selfId;

// B joins AFTER A so A is already a member when B's `welcome` arrives —
// net.js's slot allocator assigns slots to OTHER members in ascending
// order (allocateSlot pops the lowest free slot), so A is deterministically
// B's peer slot 0.
await gotoSafe(pageB, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => errorsB.push('NAV: ' + e.message));
await pageB.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errorsB.push('no garden-canvas'));
check('(setup) B reached live status', await waitLive(pageB, 'B'));
const bWelcome = await waitForNextOnPage(pageB, 'welcome', -1);
check('(setup) captured B\'s own welcome (selfId, epoch)', !!bWelcome, JSON.stringify(bWelcome));
let bIdx = bWelcome ? bWelcome.index : -1;
check('(setup) B\'s welcome already lists A as a member (join order)',
  !!bWelcome && (bWelcome.msg.members || []).some((m) => m.id === aSelfId), JSON.stringify(bWelcome));

// Both pages assert on rendering output (peer-tracked uniforms, canvas
// pixels) below, so this proves they got a real GPU adapter, not a silent
// SwiftShader fallback that would report green while proving nothing about
// the real multiplayer render path. No backend pin (see forceTextareaFallback's
// header) — assertRealGpu() is backend-agnostic, unlike assertRealWebgl2().
const gpuInfoA = await assertRealGpu(pageA);
const gpuInfoB = await assertRealGpu(pageB);
check('(setup) A and B both have a live real-GPU adapter (not SwiftShader/llvmpipe)', !!gpuInfoA && !!gpuInfoB, `A=${JSON.stringify(gpuInfoA)} B=${JSON.stringify(gpuInfoB)}`);

// NOTE: no roster-DOM assertion here — .garden-roster does not exist post-
// mount on EITHER page (armSocketSpy's header note: runtimeHost() wipes the
// whole mpPanel, roster included). "Both members are in the room" is
// asserted above from the wire (welcome.members), which is the ground
// truth the (now nonexistent) roster DOM would only have echoed.

/* ---------------- (a) B's peer uniforms track A's movement ---------------- */

await pageB.evaluate(() => { window.__uniformCalls.length = 0; }); // isolate the movement window below
await pageA.click('.garden-canvas').catch(() => {}); // canvas isn't focusable but a click clears any stray input focus

// A moves toward the lectern (SG_LECTERN_XZ = [1.6, -1.4]): 'd' is +x, 'w'
// is -z (index.js's MOVE_KEYS) — holding both together drives A diagonally
// toward it. This single move ALSO satisfies (a)'s "produced peer uniform
// writes" requirement, so it isn't a throwaway gesture.
await pageA.keyboard.down('d');
await pageA.keyboard.down('w');
await sleep(1500);
await pageA.keyboard.up('d');
await pageA.keyboard.up('w');
await sleep(300); // let the last pose (POSE_HZ=15) land and B's peer uniforms catch up

const peerCalls = await pageB.evaluate(() => window.__uniformCalls
  .filter((c) => 'uPeer0X' in c || 'uPeer0Z' in c || 'uPeer0Act' in c));
check('(a) B received peer uniform writes while A moved', peerCalls.length > 0, 'got ' + peerCalls.length);
const everActive = peerCalls.some((c) => c.uPeer0Act === 1);
check('(a) B\'s peer slot 0 (A) is marked active', everActive, JSON.stringify(peerCalls.slice(0, 3)));
const xs = peerCalls.filter((c) => 'uPeer0X' in c).map((c) => c.uPeer0X);
const zs = peerCalls.filter((c) => 'uPeer0Z' in c).map((c) => c.uPeer0Z);
check('(a) B\'s uPeer0X tracks A moving toward +x', xs.length > 0 && xs[xs.length - 1] > (xs[0] ?? 0), JSON.stringify(xs));
check('(a) B\'s uPeer0Z tracks A moving toward -z', zs.length > 0 && zs[zs.length - 1] < (zs[0] ?? 0), JSON.stringify(zs));

/* ---------------- A takes the lectern (over its own real socket — see armSocketSpy) ---------------- */

// A's real movement above (into SG_LECTERN_XZ's ring) already drove
// checkRing() -> net.setInRing(true) -> a real `ring` send on A's actual
// connection; sending it again here is a harmless, idempotent confirmation,
// not a substitute for the real trigger.
let aIdx = aWelcome ? aWelcome.index : -1;
await sendOnLiveSocket(pageA, { t: 'ring', inRing: true });
await sendOnLiveSocket(pageA, { t: 'lease.request' });
const aLease = await waitForNextOnPage(pageA, 'lease', aIdx);
aIdx = aLease ? aLease.index : aIdx;
check('(setup) A holds the lectern (its own real connection granted the lease)',
  !!aLease && aLease.msg.holder === aSelfId, JSON.stringify(aLease));

/* ---------------- (c) B's lease request is denied while A holds it ---------------- */

// index.js's updateLeaseBtn() would normally hide B's own lease button here
// (lastLease.holder != null && !isSelf) — but that DOM doesn't exist post-
// mount at all (see armSocketSpy's header note), so this proves the SERVER
// side of the denial directly: B sends the same raw request on its own real
// socket and the reply must still name A as holder.
await sendOnLiveSocket(pageB, { t: 'lease.request' });
const bLeaseReply = await waitForNextOnPage(pageB, 'lease', bIdx);
bIdx = bLeaseReply ? bLeaseReply.index : bIdx;
check('(c) B\'s lease.request was denied — the reply still names A as holder, not B',
  !!bLeaseReply && bLeaseReply.msg.holder === aSelfId && bLeaseReply.msg.holder !== null,
  JSON.stringify(bLeaseReply) + ' (aSelfId=' + aSelfId + ')');

/* ---------------- (d) B's editor is read-only and mirrors A's draft ---------------- */

check('(setup) B opened the sky probe panel', await clickTrayItem(pageB, skyComponent.name));
await sleep(200);
check('(setup) B\'s "Edit here" mounted', await openEditHere(pageB));
const bReadOnly = await pageB.$eval('.component-editor', (el) => el.classList.contains('component-editor-readonly')).catch(() => null);
check('(d) B\'s editor mounted read-only (B is not the holder)', bReadOnly === true, 'got ' + bReadOnly);
const bBodyPristine = await pageB.$eval('.component-editor .code-editor', (el) => el.value).catch(() => null);
check('(setup) B\'s editor starts on the pristine sky body', bBodyPristine === skyComponent.source);

check('(setup) A opened the sky probe panel', await clickTrayItem(pageA, skyComponent.name));
await sleep(200);
check('(setup) A\'s "Edit here" mounted', await openEditHere(pageA));
const aReadOnly = await pageA.$eval('.component-editor', (el) => el.classList.contains('component-editor-readonly')).catch(() => null);
check('(setup) A\'s editor mounted EDITABLE (A is the holder)', aReadOnly === false, 'got ' + aReadOnly);

const skyPixelBaseline = await readCanvasPixel(pageB, 720, 60);
check('(setup) got B\'s baseline sky pixel', Array.isArray(skyPixelBaseline), JSON.stringify(skyPixelBaseline));

// PRODUCT BUG (found here, not a test artifact — see final report): both
// "Edit here" mounts above (A's and B's) fail on this box. Root cause,
// confirmed independently of this suite with a single-page repro: index.js's
// onEditHere calls `rh.rebuild({ prefer: 'webgl2' })` on a WebGPU-backed
// mount (GARDEN-IDE is GLSL-only) BEFORE mounting the editor — but
// runtime-host.js's build() does an unscoped `host.replaceChildren()` on
// the shared `stage` element (core/runtime-host.js:89), and index.js
// appends the probe panel itself (`panel.el`, the ancestor of the very
// "Edit here" button just clicked) as a direct child of that same `stage`
// (organs/garden/index.js:538). The rebuild wipes the probe panel—and the
// editHost the click handler is about to append into—out of the live DOM
// mid-handler. mountComponentEditor() still resolves cleanly (no console
// error, no rejection: confirmed cm-editor.bundle.js loads fine and
// createDocAdapter/setLanguage/etc all complete) and its result IS
// appended — just into a detached subtree nobody will ever see. Every
// #/garden mount now defaults to WebGPU (§0.5 C1 supersession), so this
// fires on EVERY "Edit here" click, not just in a room. Not fixable here:
// core/runtime-host.js and organs/garden/index.js are outside this lane's
// seven files. The two checks above and everything below that depends on
// an editor existing are therefore honest FAILs, not vacuous ones — this
// is exactly what "the editor never mounted" should look like.
const editorsAvailable = !!(await pageA.$('.component-editor .code-editor')) && !!(await pageB.$('.component-editor .code-editor'));
if (editorsAvailable) {
  const GOOD_BODY = 'vec3 sg_sky_color(vec3 rd, float time) {\n  return vec3(1.0, 0.0, 1.0); // magenta — never produced by the real gradient\n}';
  await replaceAllAndType(pageA, GOOD_BODY);
  // edit.js debounces recompile at 300ms; net.js's sendDraft debounces the
  // wire send at another 150ms on top of that (DRAFT_DEBOUNCE_MS) — both only
  // fire after a PASSING local recompile (§6.2 step 1), so this also proves
  // the draft mirrors something that actually compiled, not raw keystrokes.
  // Playwright's waitForFunction(pageFunction, arg, options) puts arg BEFORE
  // options (opposite of puppeteer's (fn, options, ...args)).
  const draftMirrored = await pageB.waitForFunction(
    (expected) => document.querySelector('.component-editor .code-editor')?.value === expected,
    GOOD_BODY, { timeout: 6000 },
  ).then(() => true).catch(() => false);
  check('(d) B\'s read-only mirror picked up A\'s UNCOMMITTED draft', draftMirrored);
  const bStillReadOnly = await pageB.$eval('.component-editor', (el) => el.classList.contains('component-editor-readonly')).catch(() => null);
  check('(d) B\'s editor is still read-only after the draft landed (never becomes editable)', bStillReadOnly === true);

  // NOT a pixel diff — see armPrepareSpy's header note on why a fixed sky
  // pixel is the wrong oracle for "did a draft alone recompile B's scene"
  // (scene.glsl's clouds drift independently of any compile). This checks the
  // one function a commit (and ONLY a commit) drives instead.
  const prepareCallsAfterDraft = await pageB.evaluate(() => window.__prepareCalls);
  check('(setup) a draft (not yet committed) never triggers B\'s prepareShader (no recompile from a draft)',
    prepareCallsAfterDraft === 0, 'calls=' + prepareCallsAfterDraft);

  /* ---------------- (b) A's commit changes B's RENDERED scene ---------------- */

  // The commit is validated locally by the admission gate's sacrificial
  // worker before it is sent (§6.2 step 1). That worker renders probe frames
  // under an 800ms-per-frame heartbeat (WATCHDOG.frameMs), and this is the
  // one suite that keeps TWO live gardens on a single GPU — so the worker
  // gets starved and the gate returns TLE ('total'/'frame' watchdog), which
  // net.js surfaces as 'rejected: local-compile-failed'. MEASURED on this
  // box: the identical trial source gates OK in ~390ms when the GPU happens
  // to be free and TLEs at ~1900ms when it is not, run to run.
  //
  // TLE explicitly means "this did not finish in time here", NOT "this source
  // is bad" — so retry, which is exactly what a user staring at that message
  // would do. The assertion is unchanged: if a commit never lands, `committed`
  // stays false and this still fails.
  let committed = false;
  for (let attempt = 0; attempt < 4 && !committed; attempt++) {
    await pageA.click('.component-editor .btn-primary').catch(() => {}); // Commit
    committed = await pageA.waitForFunction(
      () => document.querySelector('.component-editor .pill')?.textContent === 'committed',
      undefined, { timeout: 10000 },
    ).then(() => true).catch(() => false);
    if (!committed) await sleep(1200); // let the GPU drain before re-gating
  }
  const commitState = await pageA.evaluate(() => ({
    pill: document.querySelector('.component-editor .pill')?.textContent ?? null,
    btn: document.querySelector('.component-editor .btn-primary')?.textContent ?? null,
    disabled: document.querySelector('.component-editor .btn-primary')?.disabled ?? null,
  })).catch(() => null);
  // handleRemoteCommit rejects on two very different grounds — the
  // admission gate refusing the trial source, or prepareShader failing to
  // compile it — and both surface as the same 'local-compile-failed'. A's own
  // prepareShader count tells them apart: 0 means the gate never let it
  // through.
  const aPrepareCalls = await pageA.evaluate(() => window.__prepareCalls).catch(() => null);
  check('(setup) A\'s commit succeeded', committed,
    'pill=' + JSON.stringify(commitState) + ' aPrepareCalls=' + aPrepareCalls);

  const prepareCallsAfterCommit = await pageB.evaluate(() => window.__prepareCalls);
  const bStatus = await pageB.evaluate(() => ({
    sawCommit: (window.__wsReceived || []).filter((m) => m.t === 'commit').length,
    types: [...new Set((window.__wsReceived || []).map((m) => m.t))],
    notice: document.body.innerText.match(/didn.t compile here[^\n]*/)?.[0] ?? null,
  })).catch(() => null);
  check('(b) A\'s commit DID trigger B\'s prepareShader exactly once (the compile+swap actually ran)',
    prepareCallsAfterCommit === 1, 'calls=' + prepareCallsAfterCommit + ' bStatus=' + JSON.stringify(bStatus));

  const skyPixelAfterCommit = await readCanvasPixel(pageB, 720, 60);
  const dist = Array.isArray(skyPixelAfterCommit) ? colorDist(skyPixelBaseline, skyPixelAfterCommit) : -1;
  // Threshold and rationale match mp-compile-swap.mjs's own pixel check: the
  // committed color still passes through mainImage's tonemap/fog before it's
  // a pixel, so this is a distance-from-baseline check, not exact-magenta.
  // `committed` is part of the predicate on purpose. scene.glsl's clouds drift
  // on their own, so a bare distance-from-baseline passes even when nothing
  // was committed at all — observed doing exactly that (dist=134.9 with
  // prepareCalls=0 and the commit rejected). The pixel move is only evidence
  // of a swap if a swap actually happened, which is the same reasoning the
  // draft check above already applies by counting prepareShader instead.
  check('(b) A\'s commit changed B\'s RENDERED canvas pixel (not just a JS variable)',
    committed && dist >= 25, 'committed=' + committed + ' baseline=' + JSON.stringify(skyPixelBaseline) + ' afterCommit=' + JSON.stringify(skyPixelAfterCommit) + ' dist=' + dist.toFixed(1));
} else {
  check('(d) B\'s read-only mirror picked up A\'s UNCOMMITTED draft', false, 'BLOCKED: editor never mounted, see product-bug note above');
  check('(d) B\'s editor is still read-only after the draft landed (never becomes editable)', false, 'BLOCKED: editor never mounted');
  check('(setup) a draft (not yet committed) never triggers B\'s prepareShader (no recompile from a draft)', false, 'BLOCKED: editor never mounted');
  check('(setup) A\'s commit succeeded', false, 'BLOCKED: editor never mounted');
  check('(b) A\'s commit DID trigger B\'s prepareShader exactly once (the compile+swap actually ran)', false, 'BLOCKED: editor never mounted');
  check('(b) A\'s commit changed B\'s RENDERED canvas pixel (not just a JS variable)', false, 'BLOCKED: editor never mounted');
}

check('no console errors on A', errorsA.length === 0, errorsA.join(' | '));
check('no console errors on B', errorsB.length === 0, errorsB.join(' | '));

await pageA.close();
await pageB.close();
await browser.close();
server.kill();
relay.close();

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
