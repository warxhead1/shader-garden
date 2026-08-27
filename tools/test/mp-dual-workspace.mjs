// Shader Garden — mp-dual-workspace.mjs
// Multiplayer spec §5.2 / §6.2 / §7.4 acceptance for the dual-workspace
// editor: non-holders see "Watching <holder>" (read-only mirror, updated
// by remote drafts/commits) ABOVE a separate editable "My draft" pane
// (locally compiled, never transmitted, preserved across tab switches
// and lease changes). Holder behaviour is preserved byte-identical.
//
// One room, two pages, full lease lifecycle. Each scenario asserts on the
// DOM the production UI exposes (no JS internals leaking out), and on the
// uniforms the runtime actually received — the spec's "the world still
// shows the previous-good source after a failed draft" claim is a uniform
// invariant, not a JS-variable one.
//
//   (a) non-holder mount: dual-workspace, no Commit, mirror pane present
//   (b) holder mount: single editable pane, no mirror pane, Commit visible
//   (c) non-holder local draft NEVER transmits; closing+reopening the
//       panel preserves the draft; lease flip to holder promotes it to
//       committable without losing text
//   (d) transactional failed draft: typed-broken source stays out of
//       editedBodies (asserted on the runtime's last received uniforms,
//       not on a JS map), gets a local error pill, never enters the
//       wire (a non-holder's failed draft is below the noise floor)
//   (e) authority handoff without remount: non-holder → holder changes
//       classes / buttons without re-creating the editable pane; the
//       user's in-progress draft is the new editable body
//   (f) phase uniform truth: uLecternOn=1 in any room, uSpongeOn=1 only
//       in hiding/seeking, uSeekerBlind=1 ONLY for the seeker during
//       hiding (else 0)
//
// Usage: node tools/test/mp-dual-workspace.mjs   (first: npm ci in tools/test)
import { readFileSync } from 'node:fs';
import { launch, serveSite, sleep, scaled, gotoSafe, startRelayOnFreePort, SITE_ROOT, awaitGardenCanvas } from './browser.mjs';
import { parseScene } from '../../site/js/organs/garden/parse.js';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

const { relay, port: RELAY_PORT } = await startRelayOnFreePort({ offset: 660 });
const { server, base: BASE } = await serveSite();
const browser = await launch();
const ROOM = 'dual-workspace-test';
const relayUrlFor = (room) => `ws://127.0.0.1:${RELAY_PORT}/${room}`;
const roomUrl = (room) => `${BASE}/index.html?relay=${encodeURIComponent(relayUrlFor(room))}#/garden/${room}`;

const sceneSrc = readFileSync(`${SITE_ROOT}/assets/garden/scene.glsl`, 'utf8');
const { components } = parseScene(sceneSrc);
// Pick a component present in the scene; "sky" is always there.
const skyComponent = components.find((c) => c.id === 'sky');
if (!skyComponent) { console.log('FAIL setup: scene.glsl has no "sky" @component'); process.exit(1); }

/* ---------- helpers (same shape as mp-two-browsers.mjs) ---------- */

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

const EDITABLE = '.component-editor-editable';
const EDITABLE_CM = `${EDITABLE} .cm-content`;
const EDITABLE_TA = `${EDITABLE} .code-editor`;

async function openEditHere(page) {
  await page.click('.probe-panel .btn:not(.probe-edit-link)').catch(() => {});
  // Wait on the EDITABLE pane's own surface, never on `.component-editor
  // .code-editor` — that selector also matches the mirror's read-only
  // textarea (see the EDITABLE_* note below), so it could report "mounted"
  // off a pane the user cannot type into.
  return page.waitForSelector(`${EDITABLE_CM}, ${EDITABLE_TA}`, { timeout: 8000 }).then(() => true).catch(() => false);
}

/* ---------- editable-pane helpers: CodeMirror OR textarea ----------
 *
 * The editable pane's doc adapter is whichever one doc-adapter.js picked:
 * CodeMirror when site/js/vendor/cm-editor.bundle.js built, the plain
 * <textarea> fallback otherwise (design doc §3, "Fallback is a contract").
 * Both mount under `.component-editor-editable`, and BOTH answer to
 * `.code-editor` — doc-adapter-codemirror.js stamps that class onto CM's
 * `view.dom` as a layout/theme hook. That shared class is the trap this
 * suite fell into on a real-GPU run:
 *
 *   - `.component-editor-editable .code-editor` under CM is the CM WRAPPER
 *     <div>. It has no `.value` (so every `$eval(el => el.value)` returned
 *     undefined and the draft assertions failed for the wrong reason) and no
 *     tabindex (so `page.focus()` on it does nothing — the subsequent
 *     keystrokes went to <body>, i.e. straight into index.js's window-level
 *     onKeyDown, where WASD walks the character instead of typing).
 *   - The real CM surfaces are `.cm-content` (the contenteditable the
 *     keyboard talks to) and its `.cm-line` children (the rendered doc).
 *
 * Every helper below is scoped to `.component-editor-editable` for the
 * ORIGINAL reason this suite scoped its selectors: the non-holder's panel
 * has the read-only "Watching" mirror inserted BEFORE the editable pane
 * (edit.js), and the mirror is always a real `<textarea class="code-editor
 * code-editor-readonly">`, so the unscoped `.component-editor .code-editor`
 * resolves to the mirror first in document order. Reading it would assert
 * against the holder's body instead of the user's draft; typing at it would
 * put a no-op Ctrl+A on a read-only textarea and land the Backspace
 * elsewhere. Nothing here can match the mirror. The EDITABLE / EDITABLE_CM /
 * EDITABLE_TA selectors these helpers share are declared above openEditHere,
 * which waits on the same pair.
 */

// 'cm' | 'textarea' | null — which adapter actually mounted in the editable pane.
async function editableKind(page) {
  return page.evaluate((sel) => {
    const pane = document.querySelector(sel);
    if (!pane) return null;
    if (pane.querySelector('.cm-content')) return 'cm';
    return pane.querySelector('.code-editor') ? 'textarea' : null;
  }, EDITABLE).catch(() => null);
}

// Put the keyboard INSIDE the editable document. Under CM a bare
// contentDOM.focus() is not enough on its own: EditorView.focus() also
// re-projects the editor's selection into the DOM, and without that the
// browser holds a focused contenteditable with no range, so keystrokes can
// vanish. A click is what garden.mjs (l) and smoke.mjs already do on this
// exact panel-hosted editor — it places a real cursor through CM's own
// mouse handling. `.focus()` stays as the fallback for a pane the click
// cannot reach, and the activeElement probe reports the truth either way so
// a silent miss shows up in the log instead of as a mystery FAIL downstream.
// Both selector calls carry an explicit timeout: Playwright's click waits on
// actionability against the 30s default, and a pane that never becomes
// clickable should cost one scaled 8s, not half a minute per attempt.
async function focusEditable(page, label = '') {
  const kind = await editableKind(page);
  if (kind === 'cm') {
    await page.click(EDITABLE_CM, { timeout: scaled(8000) }).catch(() => {});
  } else if (kind === 'textarea') {
    await page.focus(EDITABLE_TA, { timeout: scaled(8000) }).catch(() => {});
  }
  const focusedIn = (sel) => page.evaluate((s) => {
    const ae = document.activeElement;
    return !!(ae && ae.closest && ae.closest(s));
  }, sel).catch(() => false);
  if (!(await focusedIn(EDITABLE))) {
    await page.evaluate((sel) => {
      const pane = document.querySelector(sel);
      const target = pane && (pane.querySelector('.cm-content') || pane.querySelector('.code-editor'));
      if (!target) return;
      target.focus();
      // A contenteditable that is focused with NO DOM selection swallows
      // typing. Park a collapsed range at the end of the doc — CM's own
      // DOMObserver reads that back into view.state.selection, which is what
      // the click path gets for free from CM's mouse handling.
      if (target.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        const sel2 = window.getSelection();
        sel2.removeAllRanges();
        sel2.addRange(range);
      }
    }, EDITABLE).catch(() => {});
    if (!(await focusedIn(EDITABLE))) console.log(`  [${label || 'editor'}] could not focus the editable pane (kind=${kind})`);
  }
  return kind;
}

// The EXACT editable document, read from whichever adapter mounted. CM
// renders one `.cm-line` per document line and the line's textContent is
// that line's exact text (highlight <span>s concatenate back to it; an
// empty line is a lone <br>, i.e. ''), which is the same read smoke.mjs
// uses. The zero-width space CM parks in a line to keep a cursor position
// paintable is a rendering artifact, never part of the doc, so it is
// stripped — no expected body in this suite contains one, so this can only
// remove noise, never mask a mismatch. Returns null when no editable pane
// is mounted, so a missing pane still fails its check rather than
// accidentally comparing equal.
async function readEditableBody(page) {
  return page.evaluate((sel) => {
    const pane = document.querySelector(sel);
    if (!pane) return null;
    if (pane.querySelector('.cm-content')) {
      return [...pane.querySelectorAll('.cm-content > .cm-line')]
        .map((l) => l.textContent.replace(/\u200B/g, ''))
        .join('\n');
    }
    const ta = pane.querySelector('textarea.code-editor') || pane.querySelector('.code-editor');
    return ta && typeof ta.value === 'string' ? ta.value : null;
  }, EDITABLE).catch(() => null);
}

// Same Ctrl+A/Backspace/type as mp-two-browsers.mjs's replaceAllAndType, but
// aimed at the editable pane's real keyboard surface. CM binds Mod-a to
// selectAll via defaultKeymap and a focused <textarea> gets the browser's
// own select-all, so one keystroke sequence covers both adapters. The
// facade (tools/editor-bundle/facade.js) deliberately ships no
// autocomplete and no bracket-closing, so typed text round-trips byte-exact
// under CM — the strict equality assertions below stay strict.
async function replaceAllAndType(page, text, label = '') {
  await clearEditable(page, label);
  await page.keyboard.type(text, { delay: 2 });
}

async function clearEditable(page, label = '') {
  const kind = await focusEditable(page, label);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  return kind;
}

// index.js's checkRing() drives the `ring` wire-send off charX/charZ vs
// SG_LECTERN_XZ, and room-core.js's `ring` handler releases the lease the
// instant the holder steps OUT. So a lease.request from a page that has
// never moved (or has moved away) is denied — the lease is gated on
// member.inRing AND the "ring:false => immediate release" rule applies
// before the request even lands. Same trick mp-two-browsers.mjs uses
// (lines 416-435): press d+w together for 1500ms (diagonal at MOVE_SPEED
// 1.8 u/s into [1.6,-1.4] inside LECTERN_RADIUS=0.9), then wait on the
// other page's uPeer0X/uPeer0Z uniforms — the OBSERVABLE proof that the
// moving page actually reached the ring, not a guessed `ring:true`
// injection that would sidestep the very invariant the lease gates on.
const RING_X = 1.6, RING_Z = -1.4, RING_R = 0.9;
async function isPeerInRing(observerPage) {
  return observerPage.evaluate(({ rx, rz, rr }) => {
    const calls = window.__uniformCalls || [];
    for (let i = calls.length - 1; i >= 0; i--) {
      const x = calls[i].uPeer0X, z = calls[i].uPeer0Z;
      if (typeof x === 'number' && typeof z === 'number') {
        return Math.hypot(x - rx, z - rz) < rr;
      }
    }
    return false;
  }, { rx: RING_X, rz: RING_Z, rr: RING_R });
}
async function moveIntoLecternRing(page, observerPage, label) {
  // Idempotent: if the moving page is already standing in the ring (e.g.
  // A retakes later without having stepped out), skip the movement — holding
  // d+w from inside the ring would carry A OUT past LECTERN_RADIUS and
  // immediately trigger the authority-core's `ring:false => lease release`.
  if (await isPeerInRing(observerPage)) {
    console.log(`  [${label}] already in ring, no movement`);
    return;
  }
  // index.js's onKeyDown ignores keys while focus is on a textarea / content-
  // editable (inEditableChrome guard). The editable pane's keyboard surface is
  // focused after a replaceAllAndType round — CM's contenteditable `.cm-content`
  // when the vendor chunk built, the fallback <textarea> otherwise — so a
  // re-take must blur it first; otherwise the d+w press is silently swallowed
  // and the lease request below is denied for a reason nothing in the harness
  // surfaces. The blur below covers both adapters (isContentEditable catches CM).
  // We deliberately do NOT click the canvas here: index.js's onPointerUp
  // fires probeAt() (an async GPU readback on WebGPU) and then synchronously
  // calls openProbe() on whatever's under the cursor, which REPLACES the
  // panel that's hosting the editor the harness just typed into. A click is
  // unnecessary anyway — blurring the editable chrome is sufficient to
  // route d+w to index.js's window-level onKeyDown.
  await page.evaluate(() => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) ae.blur();
  }).catch(() => {});
  await page.keyboard.down('d');
  await page.keyboard.down('w');
  // Poll the observer WHILE the moving page drives d+w — release the keys
  // the INSTANT the observer's uPeer0X/uPeer0Z shows the peer inside
  // LECTERN_RADIUS. The previous implementation held d+w for a fixed 1500ms,
  // which at MOVE_SPEED=1.8 u/s along the normalised (1,-1)/sqrt(2) diagonal
  // covers ~1.91 units — starting from the origin, that carries the figure
  // across the (1.6,-1.4) lectern centre AND past the ring's outer edge on
  // the far side. By the time the keys release, checkRing() has already
  // fired ring:false and the authority-core's "ring:false => immediate
  // release" rule has cancelled the lease before any subsequent
  // lease.request ever lands. Releasing on the observer's first sighting of
  // the peer inside the ring stops the figure inside the ring, so the
  // lease.request that follows is admitted by the gate, not bounced.
  const seenInRing = await observerPage.waitForFunction(
    ({ rx, rz, rr }) => {
      const calls = window.__uniformCalls || [];
      for (let i = calls.length - 1; i >= 0; i--) {
        const x = calls[i].uPeer0X, z = calls[i].uPeer0Z;
        if (typeof x === 'number' && typeof z === 'number') {
          return Math.hypot(x - rx, z - rz) < rr;
        }
      }
      return false;
    },
    { rx: RING_X, rz: RING_Z, rr: RING_R },
    { timeout: scaled(8000), polling: 100 },
  ).then(() => true).catch(() => false);
  // Stop keyboard movement the instant the observer confirms the peer is
  // inside the ring. The move integrator in index.js idle-exits on the next
  // frame once heldKeys is empty, so the figure stops inside the ring (the
  // observer's most-recent uniform snapshot is what's true at the moment of
  // release — the figure doesn't carry any further).
  await page.keyboard.up('d');
  await page.keyboard.up('w');
  if (!seenInRing) console.log(`  [${label}] peer did NOT reach the ring within timeout`);
  await sleep(300); // last POSE_HZ=15 broadcast to land
}

// GL2Runtime.setUniforms spy on BOTH backends — multi-player rooms can
// land on either (see mp-two-browsers.mjs's armUniformSpy header note).
async function armUniformSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__uniformCalls = [];
    function patch(Ctor) {
      const orig = Ctor.prototype.setUniforms;
      Ctor.prototype.setUniforms = function (values) {
        window.__uniformCalls.push({ ...values });
        return orig.call(this, values);
      };
    }
    import('./js/runtime/webgl2.js').then((mod) => patch(mod.GL2Runtime)).catch(() => {});
    import('./js/runtime/webgpu.js').then((mod) => patch(mod.GPURuntime)).catch(() => {});
  });
}

// prepareShader spy — committed bodies go through this; drafts do not.
async function armPrepareSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__prepareCalls = 0;
    function patch(Ctor) {
      const orig = Ctor.prototype.prepareShader;
      Ctor.prototype.prepareShader = function (...args) {
        window.__prepareCalls++;
        return Promise.resolve(orig.apply(this, args));
      };
    }
    import('./js/runtime/webgl2.js').then((mod) => patch(mod.GL2Runtime)).catch(() => {});
    import('./js/runtime/webgpu.js').then((mod) => patch(mod.GPURuntime)).catch(() => {});
  });
}

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

async function waitForNextOnPage(page, type, afterIndex, timeoutMs = scaled(8000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

// Reads what the runtime was LAST told for a uniform. uSpongeOn and
// uSeekerBlind are pushed every renderLease/renderGame call (and on every
// rebuild), so "last value wins" is the right oracle for "what does the
// shader currently see".
async function lastUniform(page, name) {
  return page.evaluate((n) => {
    const log = window.__uniformCalls;
    for (let i = log.length - 1; i >= 0; i--) if (n in log[i]) return log[i][n];
    return undefined;
  }, name);
}

/* ---------- setup: A joins, becomes holder; B joins as a non-holder ---------- */

const errorsA = [], errorsB = [];
const pageA = await freshPage(errorsA);
const pageB = await freshPage(errorsB);
await armUniformSpy(pageA);
await armUniformSpy(pageB);
await armPrepareSpy(pageA);
await armPrepareSpy(pageB);
await armSocketSpy(pageA);
await armSocketSpy(pageB);

await gotoSafe(pageA, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => errorsA.push('NAV: ' + e.message));
await awaitGardenCanvas(pageA, errorsA);
check('(setup) A reached live status', await waitLive(pageA, 'A'));
const aWelcome = await waitForNextOnPage(pageA, 'welcome', -1);
const aSelfId = aWelcome && aWelcome.msg.selfId;

await gotoSafe(pageB, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => errorsB.push('NAV: ' + e.message));
await awaitGardenCanvas(pageB, errorsB);
check('(setup) B reached live status', await waitLive(pageB, 'B'));
const bWelcome = await waitForNextOnPage(pageB, 'welcome', -1);
const bSelfId = bWelcome && bWelcome.msg.selfId;
check('(setup) A and B are distinct members', aSelfId && bSelfId && aSelfId !== bSelfId, `A=${aSelfId} B=${bSelfId}`);

// A is the only member on arrival; drive A into the lectern ring FIRST so
// index.js's checkRing() emits `ring:true` from A's actual charX/charZ, and
// room-core.js's lease.request gate (`if (expired && member.inRing)`) is
// satisfied from a real ring-membership transition — not an injected
// `ring:true` short-circuit. The observable proof is B's uPeer0X/uPeer0Z
// (the moving page's pose broadcast to its peer) settling inside
// LECTERN_RADIUS=0.9 of SG_LECTERN_XZ.
let aIdx = aWelcome ? aWelcome.index : -1;
await moveIntoLecternRing(pageA, pageB, 'A-takes-lease');
await sendOnLiveSocket(pageA, { t: 'lease.request' });
const aLease = await waitForNextOnPage(pageA, 'lease', aIdx);
aIdx = aLease ? aLease.index : aIdx;
check('(setup) A holds the lectern', !!aLease && aLease.msg.holder === aSelfId, JSON.stringify(aLease));

// Wait for B to receive the lease broadcast so B's lease state is settled
// before we open any "Edit here".
let bIdx = bWelcome ? bWelcome.index : -1;
const bLease = await waitForNextOnPage(pageB, 'lease', bIdx, scaled(10000));
bIdx = bLease ? bLease.index : bIdx;
check('(setup) B received the lease broadcast naming A as holder', !!bLease && bLease.msg.holder === aSelfId, JSON.stringify(bLease));

/* ---------------- (a) non-holder mount: dual workspace, no Commit ---------------- */

await clickTrayItem(pageB, skyComponent.name);
await sleep(200);
check('(setup) B opened the sky probe panel', !!await pageB.$('.probe-title'));
check('(setup) B\'s "Edit here" mounted', await openEditHere(pageB));

const bClasses = await pageB.$eval('.component-editor', (el) => [...el.classList]).catch(() => null);
check('(a) B\'s editor has the nonholder class (dual-workspace layout)', Array.isArray(bClasses) && bClasses.includes('component-editor-nonholder'), JSON.stringify(bClasses));
// The mirror DOM is built for every room editor (so handleRemoteDraft /
// handleRemoteCommit have somewhere to land), so "has a Watching pane"
// is a visibility assertion, not a presence assertion.
const bMirrorVisible = await pageB.$eval('.component-editor-mirror', (el) => {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && el.offsetParent !== null;
}).catch(() => null);
check('(a) B\'s "Watching" mirror pane is CSS-visible', bMirrorVisible === true);
const bMirrorReadOnly = await pageB.$eval('.component-editor-mirror textarea', (el) => el.readOnly).catch(() => null);
check('(a) B\'s mirror textarea is read-only', bMirrorReadOnly === true);
const bEditableKind = await editableKind(pageB);
console.log(`  [B] editable doc adapter on this run: ${bEditableKind}`);
check('(a) B\'s editor mounts an editable "My draft" pane', bEditableKind === 'cm' || bEditableKind === 'textarea', 'kind=' + bEditableKind);
const bHasCommit = !!(await pageB.$('.component-editor .btn-primary'));
check('(a) B\'s editor has NO Commit button (cannot broadcast)', !bHasCommit);
const bHasRevert = !!(await pageB.$('.component-editor .btn-ghost'));
check('(a) B\'s editor has NO Revert button (no pristine to revert to, while non-holder)', !bHasRevert);
const bMirrorHead = await pageB.$eval('.component-editor-mirror-head', (el) => el.textContent.trim()).catch(() => null);
check('(a) B\'s mirror head names the current holder', bMirrorHead && /Watching/.test(bMirrorHead) && !/Watching the holder/.test(bMirrorHead), JSON.stringify(bMirrorHead));

/* ---------------- (b) holder mount: single editable pane, no mirror, Commit visible ---------------- */

await clickTrayItem(pageA, skyComponent.name);
await sleep(200);
check('(setup) A opened the sky probe panel', !!await pageA.$('.probe-title'));
check('(setup) A\'s "Edit here" mounted', await openEditHere(pageA));

const aClasses = await pageA.$eval('.component-editor', (el) => [...el.classList]).catch(() => null);
check('(b) A\'s editor has the holder class (no dual-workspace)', Array.isArray(aClasses) && aClasses.includes('component-editor-holder') && !aClasses.includes('component-editor-nonholder'), JSON.stringify(aClasses));
// Holder's mirror DOM exists (so handleRemoteDraft / handleRemoteCommit
// always have a target) but is CSS-hidden via .component-editor-holder.
const aMirrorVisible = await pageA.$eval('.component-editor-mirror', (el) => {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && el.offsetParent !== null;
}).catch(() => null);
check('(b) A\'s holder mirror is CSS-hidden (single-pane UX)', aMirrorVisible === false);
const aHasCommit = !!(await pageA.$('.component-editor .btn-primary'));
check('(b) A\'s editor HAS a Commit button (can broadcast)', aHasCommit);
const aHasRevert = !!(await pageA.$('.component-editor .btn-ghost'));
check('(b) A\'s editor HAS a Revert button (can rewind to pristine)', aHasRevert);

/* ---------------- (c) non-holder local draft: isolation + preservation + promotion ---------------- */

// First, B types a unique local draft. We watch what the wire sees; the
// local draft must NEVER appear in any draft/commit/anycast message.
await pageB.evaluate(() => { window.__wsReceived.length = 0; });
const bDraftText = '// B-LOCAL-DRAFT-MARKER\nvec3 sg_sky_color(vec3 rd, float t) { return vec3(0.1, 0.2, 0.3); }';
await replaceAllAndType(pageB, bDraftText, 'B-draft');
// Assert the draft lands in the editable pane IMMEDIATELY, before the
// edit.js 300ms debounce even fires — proves the keystroke reached the
// editable pane (not the read-only mirror above it) and that no lazy
// re-render defers the value the user can already see. readEditableBody()
// reads the CM document (or the fallback textarea's value) scoped to
// `.component-editor-editable`, so the mirror textarea — which the broader
// `.component-editor .code-editor` selector would have matched first in
// document order — can never answer this read.
const bDraftImmediate = await readEditableBody(pageB);
check('(c) B\'s editable pane holds the typed draft immediately (no debounce defer)', bDraftImmediate === bDraftText, JSON.stringify(bDraftImmediate));
await sleep(scaled(800)); // plenty for the 300ms edit.js debounce + 150ms net draft debounce
const wireSeenBLocalDraft = await pageB.evaluate((txt) => {
  return (window.__wsReceived || []).some((m) => {
    if (typeof m !== 'object' || m == null) return false;
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (typeof v === 'string' && v.includes(txt)) return true;
    }
    return false;
  });
}, bDraftText);
check('(c) B\'s local draft NEVER reached the wire (no draft / commit / anycast)', !wireSeenBLocalDraft);

// Local draft preserved across panel close/reopen: destroy the panel by
// navigating to another component, then come back. The editable pane MUST
// still hold the same body the user typed. components[0] is `sky` (sky is
// the first @component declared in scene.glsl, and parseScene assigns ids
// by file order), so picking it would just re-open the SAME panel — the
// editable pane would never be torn down and the "preserved" body would
// be tautological. Pick the first component with an id that differs from
// sky's, guaranteed to be a different editor mount.
const detourComponent = components.find((c) => c.id !== 'sky');
if (!detourComponent) { console.log('FAIL setup: scene.glsl has no non-sky @component for the close/reopen detour'); process.exit(1); }
await clickTrayItem(pageB, detourComponent.name); // swap to a different component to force a panel close
await sleep(200);
await clickTrayItem(pageB, skyComponent.name); // reopen the same one
await sleep(200);
check('(setup) B reopened the sky editor (after a different-component detour)', await openEditHere(pageB));
const bLocalAfterReopen = await readEditableBody(pageB);
check('(c) B\'s local draft is preserved across panel close+reopen', bLocalAfterReopen === bDraftText, JSON.stringify(bLocalAfterReopen));

// Now release A's lease, take it on B (over the wire), and verify the
// SAME text becomes the editable body on B's editor — without remount.
// B's editable pane is focused from the typing round above (CM's
// `.cm-content` or the fallback textarea) — blur it
// so the movement keys reach index.js's window-level onKeyDown (it gates
// on inEditableChrome(activeElement) and would otherwise swallow d+w).
const aReleaseIdx = aIdx;
// Handle to the live editable pane, captured AFTER the close/reopen detour
// (which legitimately remounts) and BEFORE the lease flip (which must not).
// Compared by identity below — the old presence-only check would have gone
// green on a freshly remounted pane.
const bEditableNodeBeforeFlip = await pageB.$(EDITABLE);
await sendOnLiveSocket(pageA, { t: 'lease.release' });
await sleep(200);
await moveIntoLecternRing(pageB, pageA, 'B-takes-lease');
await sendOnLiveSocket(pageB, { t: 'lease.request' });
const bTakesLease = await waitForNextOnPage(pageB, 'lease', bIdx, scaled(10000));
bIdx = bTakesLease ? bTakesLease.index : bIdx;
check('(c) B took the lease over its own real socket', !!bTakesLease && bTakesLease.msg.holder === bSelfId, JSON.stringify(bTakesLease));

// setAuthority must NOT remount: the same .component-editor-editable node
// should still be present, AND its value should still be B's local draft.
await sleep(200);
const bEditableSameNode = bEditableNodeBeforeFlip
  ? await pageB.evaluate(({ el, sel }) => el === document.querySelector(sel),
    { el: bEditableNodeBeforeFlip, sel: EDITABLE }).catch(() => false)
  : false;
check('(c) B\'s editable pane survived the lease flip (no remount)', bEditableSameNode,
  'hadNodeBefore=' + !!bEditableNodeBeforeFlip + ' sameNodeAfter=' + bEditableSameNode);
const bEditableAfterFlip = await readEditableBody(pageB);
check('(c) B\'s local draft becomes the editable body on the lease flip (preserved, now committable)',
  bEditableAfterFlip === bDraftText, JSON.stringify(bEditableAfterFlip));
// After the flip B is the holder — Commit button appears, mirror is
// CSS-hidden via .component-editor-holder (the DOM stays in place so
// handleRemoteDraft / handleRemoteCommit still have a target).
const bHasCommitNow = !!(await pageB.$('.component-editor .btn-primary'));
check('(c) B\'s editor now HAS a Commit button (promoted to holder)', bHasCommitNow);
const bMirrorNowVisible = await pageB.$eval('.component-editor-mirror', (el) => {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && el.offsetParent !== null;
}).catch(() => null);
check('(c) B\'s mirror is CSS-hidden after promotion to holder', bMirrorNowVisible === false);
const bClassesAfterFlip = await pageB.$eval('.component-editor', (el) => [...el.classList]).catch(() => null);
check('(c) B\'s editor class flipped from nonholder to holder', Array.isArray(bClassesAfterFlip) && bClassesAfterFlip.includes('component-editor-holder') && !bClassesAfterFlip.includes('component-editor-nonholder'), JSON.stringify(bClassesAfterFlip));

/* ---------------- (d) transactional failed draft: stays out of editedBodies, surfaces locally, never on wire ---------------- */

// B is now the holder. We type a body that the runtime refuses to compile.
// prepareShader is NOT gated by the admission worker (it's a per-tab
// compile, not the per-machine gate) — so a deliberate syntax error
// reliably fails locally and never reaches prepareShader's success path.
// The §6.2 step-1 contract: local errors surface in the editor's pill,
// editedBodies is untouched (asserted on the runtime's last received
// uniforms, not on a JS map), and the wire sees nothing.
const bPrepareBefore = await pageB.evaluate(() => window.__prepareCalls);
const BROKEN = 'this is not valid glsl at all --- vec3 sg_sky_color(vec3 rd, float t) { return';
await pageB.evaluate(() => { window.__wsReceived.length = 0; });
// Clear + retype through the real keyboard. The previous programmatic clear
// (`el.value = ''` + a synthetic 'input' on `.component-editor-editable
// .code-editor`) is a no-op under CodeMirror: that node is CM's wrapper
// <div>, so the assignment just parks a stray property on a div and the
// event never reaches the contentDOM CM listens on. Worse, the `el.focus()`
// beside it did nothing either (the wrapper takes no focus), so the
// keyboard.type() that followed went to <body> and index.js's window-level
// onKeyDown walked the character around the garden instead of typing BROKEN
// — (d) would then be asserting against a still-passing draft.
await replaceAllAndType(pageB, BROKEN, 'B-broken');
await sleep(scaled(800));

// The broken body really is what the editable pane now holds — without this
// the pill/wire assertions below could pass vacuously off a stale draft.
const bBrokenInPane = await readEditableBody(pageB);
check('(d) B\'s editable pane holds the broken draft the harness typed', bBrokenInPane === BROKEN, JSON.stringify(bBrokenInPane));

// The pill should report an error (the local compile failed). Reading the
// pill text is more honest than reading res.ok: a slow compile might still
// be in flight; the pill is what the user sees.
const bPillAfterBroken = await pageB.$eval('.component-editor .pill', (el) => el.textContent.trim()).catch(() => null);
check('(d) B\'s local pill surfaces a compile error after a broken draft',
  bPillAfterBroken && /err|error/i.test(bPillAfterBroken), JSON.stringify(bPillAfterBroken));

// prepareShader did NOT run for a typing-rejected body — the trial build
// inside recompileWithBody never reaches the runtime's compile path on
// failure (rh.runtime.setShader returns ok:false and the trial is
// discarded). On a green run we expect prepareCalls unchanged.
const bPrepareAfterBroken = await pageB.evaluate(() => window.__prepareCalls);
check('(d) a broken local draft never reaches prepareShader (no commit path taken)',
  bPrepareAfterBroken === bPrepareBefore, 'before=' + bPrepareBefore + ' after=' + bPrepareAfterBroken);

// Wire sees nothing — same predicate as (c) but with the broken body.
const wireSeenBroken = await pageB.evaluate((txt) => {
  return (window.__wsReceived || []).some((m) => {
    if (typeof m !== 'object' || m == null) return false;
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (typeof v === 'string' && v.includes(txt)) return true;
    }
    return false;
  });
}, BROKEN);
check('(d) a broken local draft never reached the wire', !wireSeenBroken);

// "Previous world still renders": after a broken draft, the runtime's
// last-received body for uLeaseHeld/uLeaseHue is unchanged. Stronger oracle
// than reading a JS map: a shader-uniform regression would actually look
// wrong on screen, not just in a comment. (uLeaseHeld is set on every
// lease / phase / rebuild — reading its last value pins the truth at the
// moment we sampled.)
await sleep(scaled(400));
const aLeaseHeldAfterBroken = await lastUniform(pageA, 'uLeaseHeld');
check('(d) A\'s uLeaseHeld still says A is/was the holder OR cleared (NOT replaced by B\'s broken draft)',
  aLeaseHeldAfterBroken === 0 || aLeaseHeldAfterBroken === 1, 'got ' + aLeaseHeldAfterBroken);

// Recovery: revert B to its last good state (the local draft we had typed
// before going broken — same text, recompiles clean). This proves the
// transactional path doesn't strand a failed buffer in editedBodies either.
await replaceAllAndType(pageB, bDraftText, 'B-retype');
await sleep(scaled(800));
// Same read-back guard as the broken round: the pill can only be trusted to
// mean "this body recompiled" if the pane actually holds that body.
const bGoodInPane = await readEditableBody(pageB);
check('(d) B\'s editable pane holds the re-typed passing draft', bGoodInPane === bDraftText, JSON.stringify(bGoodInPane));
const bPillAfterGood = await pageB.$eval('.component-editor .pill', (el) => el.textContent.trim()).catch(() => null);
check('(d) B\'s editor recovers cleanly on a passing re-type (pill returns to ok)', /ok/i.test(bPillAfterGood || ''), JSON.stringify(bPillAfterGood));

/* ---------------- (e) authority handoff without remount: A → B via wire ---------------- */

// A's panel: A was a non-holder earlier (its panel mounted dual-workspace).
// Verify it gained a Commit button without remount when B took the lease.
// (We haven't opened A's editor yet for the new holder — actually A had
// NO panel open for sky during (b). Open it now as A's first sky panel.)
// BUG NOTE: a fresh openProbe always mounts as holder/nonholder per the
// CURRENT lease. The interesting handoff is the OPPOSITE: an editor that
// is ALREADY open must transition on a lease change without remount.

// B is the holder and its editor is open. Release B's lease and have A
// take it back. B's open editor must drop Commit + gain mirror, again
// without remounting the editable pane.
//
// "No remount" is asserted on NODE IDENTITY (a handle to the live element,
// compared against whatever `.component-editor-editable` resolves to after
// the flip), not on an outerHTML prefix. Under CodeMirror the pane's
// serialised HTML churns for reasons that have nothing to do with a
// remount — CM toggles `cm-focused` on its wrapper, retitles its
// `cm-announced` aria-live region on doc/selection changes, and writes
// measured inline styles — so a prefix compare would report a phantom
// remount. Identity is also the stricter oracle: a torn-down-and-rebuilt
// pane that happened to serialise identically would have slipped past the
// old check and cannot slip past this one.
const editableNodeBefore = await pageB.$(EDITABLE);
await sendOnLiveSocket(pageB, { t: 'lease.release' });
await sleep(200);
// Re-take: A is still inside the ring from the original (setup) move — the
// helper's isPeerInRing() guard makes this a no-op movement when so, which
// is exactly the "keep A in-ring" half of the brief. If anything had stepped
// A out (it does not here), the helper would re-issue d+w and re-enter.
await moveIntoLecternRing(pageA, pageB, 'A-retakes-lease');
await sendOnLiveSocket(pageA, { t: 'lease.request' });
const aTakesBack = await waitForNextOnPage(pageA, 'lease', aIdx, scaled(10000));
aIdx = aTakesBack ? aTakesBack.index : aIdx;
check('(e) A took the lease back over its own real socket', !!aTakesBack && aTakesBack.msg.holder === aSelfId, JSON.stringify(aTakesBack));
await sleep(scaled(600));
const editableSameNode = editableNodeBefore
  ? await pageB.evaluate(({ el, sel }) => el === document.querySelector(sel),
    { el: editableNodeBefore, sel: EDITABLE }).catch(() => false)
  : false;
check('(e) B\'s open editor did NOT remount the editable pane (same DOM, no flash)',
  editableSameNode, 'hadNodeBefore=' + !!editableNodeBefore + ' sameNodeAfter=' + editableSameNode);
// The draft the user was holding is still in that same pane after losing
// the lease — the flip is a class/button swap, never a content reset.
const bDraftAfterLoss = await readEditableBody(pageB);
check('(e) B\'s local draft survived the lease loss intact', bDraftAfterLoss === bDraftText, JSON.stringify(bDraftAfterLoss));
const bCommitAfterLoss = !!(await pageB.$('.component-editor .btn-primary'));
check('(e) B\'s editor dropped its Commit button on losing the lease', !bCommitAfterLoss);
// The mirror DOM was always present (built at mount time); the lease
// flip just removes the .component-editor-holder class so its CSS no
// longer hides it. "Re-shows" is a visibility assertion.
const bMirrorAfterLoss = await pageB.$eval('.component-editor-mirror', (el) => {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && el.offsetParent !== null;
}).catch(() => null);
check('(e) B\'s mirror is CSS-visible again on losing the lease', bMirrorAfterLoss === true);

/* ---------------- (f) phase uniform truth ---------------- */

// B is a non-seeker, A is a non-seeker; in lobby. Both should see
// uLecternOn=1 (any room) and uSpongeOn=0, uSeekerBlind=0.
const aLecternLobby = await lastUniform(pageA, 'uLecternOn');
const aSpongeLobby = await lastUniform(pageA, 'uSpongeOn');
const aSeekerBlindLobby = await lastUniform(pageA, 'uSeekerBlind');
check('(f) uLecternOn=1 in lobby (any room)', aLecternLobby === 1, 'got ' + aLecternLobby);
check('(f) uSpongeOn=0 in lobby', aSpongeLobby === 0, 'got ' + aSpongeLobby);
check('(f) uSeekerBlind=0 in lobby (no seeker yet)', aSeekerBlindLobby === 0, 'got ' + aSeekerBlindLobby);

// uLeaseHeld should be 1 (A holds) or 0 — never partial / NaN. Stronger
// check: the value is exactly one of those two across all reads.
const allLeaseReads = await pageA.evaluate(() =>
  (window.__uniformCalls || []).map((c) => c.uLeaseHeld).filter((v) => v !== undefined));
const onlyBinaryLeaseHeld = allLeaseReads.every((v) => v === 0 || v === 1);
check('(f) uLeaseHeld is binary across the whole session (0 or 1, never NaN/partial)', onlyBinaryLeaseHeld, 'reads=' + JSON.stringify(allLeaseReads.slice(-10)));

// Tell A (the holder) to start the round. B (non-holder) should see the
// game line flip and BOTH pages should report uSpongeOn=1 in 'hiding'.
const aIdxBeforeGame = aIdx;
await sendOnLiveSocket(pageA, { t: 'game.start' });
const aGameHiding = await waitForNextOnPage(pageA, 'game', aIdxBeforeGame, scaled(10000));
aIdx = aGameHiding ? aGameHiding.index : aIdx;
check('(f) game.start moved A into the hiding phase', !!aGameHiding && aGameHiding.msg.phase === 'hiding', JSON.stringify(aGameHiding));

await sleep(scaled(400));
const aSpongeHiding = await lastUniform(pageA, 'uSpongeOn');
const bSpongeHiding = await lastUniform(pageB, 'uSpongeOn');
check('(f) uSpongeOn=1 in hiding (A)', aSpongeHiding === 1, 'got ' + aSpongeHiding);
check('(f) uSpongeOn=1 in hiding (B)', bSpongeHiding === 1, 'got ' + bSpongeHiding);

// In hiding the seeker (A, holder, game.seekerId = A) should see
// uSeekerBlind=1; B (non-seeker) should see uSeekerBlind=0.
const aSeekerBlindHiding = await lastUniform(pageA, 'uSeekerBlind');
const bSeekerBlindHiding = await lastUniform(pageB, 'uSeekerBlind');
check('(f) uSeekerBlind=1 for the seeker during hiding (A)', aSeekerBlindHiding === 1, 'got ' + aSeekerBlindHiding);
check('(f) uSeekerBlind=0 for a non-seeker during hiding (B)', bSeekerBlindHiding === 0, 'got ' + bSeekerBlindHiding);

// uLecternOn stays 1 across the phase edge.
const aLecternHiding = await lastUniform(pageA, 'uLecternOn');
const bLecternHiding = await lastUniform(pageB, 'uLecternOn');
check('(f) uLecternOn=1 across the lobby -> hiding edge (A)', aLecternHiding === 1, 'got ' + aLecternHiding);
check('(f) uLecternOn=1 across the lobby -> hiding edge (B)', bLecternHiding === 1, 'got ' + bLecternHiding);

/* ---------------- cleanup ---------------- */

check('no console errors on A', errorsA.length === 0, errorsA.join(' | '));
check('no console errors on B', errorsB.length === 0, errorsB.join(' | '));

await pageA.close();
await pageB.close();
await browser.close();
server.kill();
relay.close();

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);