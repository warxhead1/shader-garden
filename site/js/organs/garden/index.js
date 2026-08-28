// Shader Garden — organs/garden/index.js
// "/garden" organ (GARDEN-0/GARDEN-1). A single raymarched scene made of
// named, probe-able components — see assets/garden/scene.{glsl,wgsl}'s
// headers and ARCHITECTURE.md § "The Garden" for the annotation convention
// this reads (byte-identical in both source files — parse.js never knows
// which backend actually rendered). prefer: 'auto': WebGPU when
// scene.wgsl loads and compiles, WebGL2 otherwise. Live component editing
// (GARDEN-IDE, edit.js) is GLSL-only — opening "Edit here" on a
// WebGPU-backed mount transparently rebuilds it onto WebGL2 first (see
// openProbe's onEditHere below).

import { centerNotice } from '../../core/loader.js';
import { runtimeHost } from '../../core/runtime-host.js';
import { el, inEditableChrome } from '../../dom.js';
import { canvasPixelCoords } from '../../runtime/uniforms.js';
import { compress, toast } from '../../share.js';
import { parseScene } from './parse.js';
import { probeAt } from './probe.js';
import { createProbePanel } from './panel.js';
import { summarizeConnections } from './connections.js';
import { createComponentTray } from './tray.js';
import { loadVariantManifest, loadVariantBody } from './variants.js';
import { attributionFor } from './attribution.js';
import { mountJoystick } from './joystick.js';
import { createUniformInspector } from './uniform-inspector.js';

// A pointerup within this many CSS pixels of the matching pointerdown counts
// as a probe click; anything farther is an orbit drag (both read the same
// canvas — the shader gets the raw iMouse feed regardless of which gesture
// this turns out to be).
const CLICK_SLOP = 6;

// Wave-3 §1b: how long the pointer must sit still before a hover-preview
// probe fires — a native-tooltip-style "settle, then probe" delay, not a
// per-mousemove cost (probeAt does two full renderOnce() calls on WebGL2, or
// an async texture-copy+mapAsync round-trip on WebGpu).
const HOVER_SETTLE_MS = 120;

// Wave-3 §1c: gates the first-visit hint pulse — same localStorage-flag
// pattern as QUALITY_KEY above, self-retiring the moment a visitor actually
// probes something rather than on a fixed timer.
const HINT_SEEN_KEY = 'sg.garden.hintSeen';

// Wave-3 §4: the player-controller's shared movement constants. PLAY_RADIUS
// keeps the figure inside the camera's own 3.6-unit orbit radius (blueprint
// §4) so it never crosses into terrain the camera can't frame well — no
// pond/rock collision by design (scene.glsl's SG_POND_XZ/SG_ROCK_XZ have no
// JS-side reader; duplicating them here would be exactly the kind of
// hand-honored, driftable invariant this codebase's own comments flag as a
// risk — see the blueprint's own §4 rationale). MOVE_SPEED crosses the
// 6.4-unit play diameter in ~3.5s, tuned to read as a walk, not a teleport.
const PLAY_RADIUS = 3.2;
const MOVE_SPEED = 1.8;
// Wave-4 §A: bounded turn rate for the character's facing (uCharYaw) — fast
// enough to feel responsive, slow enough that a diagonal-to-diagonal flick
// doesn't snap instantly to the new heading.
const TURN_RATE = 10; // rad/s
const MOVE_KEYS = new Map([
  ['w', [0, -1]], ['arrowup', [0, -1]],
  ['s', [0, 1]], ['arrowdown', [0, 1]],
  ['a', [-1, 0]], ['arrowleft', [-1, 0]],
  ['d', [1, 0]], ['arrowright', [1, 0]],
]);

// PERF-2: the garden is the single heaviest kernel on the site — an
// 88-step raymarch evaluating 4 distance fields per step, full-screen, every
// frame. The site-wide DEFAULT_DPR_CAP (1.5, webgl2.js) still leaves this
// mount rendering 2.25x more pixels than CSS size on any display reporting
// devicePixelRatio >= 1.5 (a 4K/HiDPI desktop is exactly that case — see the
// dispatch notes' "quite shite fps" report). Cap this mount to CSS-pixel
// density (1) instead — none of the quality presets below need more than
// that, and a viewer wanting sharper-than-CSS-pixel raymarch on this scene
// would be paying real GPU cost for detail this heavy a shader can't
// resolve anyway (the noise itself is only band-limited to a few octaves).
const GARDEN_MAX_DPR = 1;

// PERF-2: Low/Medium/High each pin BOTH a fixed renderScale (bypassing the
// PERF-0 adaptive ladder — see runtime-host.js's setRenderScale() contract)
// and a shader-side SG_QUALITY level (scene.glsl scales march steps + cloud
// fbm octaves off this). Auto (sgQuality 2, the ladder's own scale) is
// byte-identical to pre-PERF-2 behavior — see scene.glsl's own SG_QUALITY
// comment for why High == the original unconditional cost.
const QUALITY_PRESETS = {
  low:    { renderScale: 0.5,  sgQuality: 0 },
  medium: { renderScale: 0.75, sgQuality: 1 },
  high:   { renderScale: 1,    sgQuality: 2 },
};
const QUALITY_KEY = 'sg.garden.quality';

function loadQualityMode() {
  const saved = localStorage.getItem(QUALITY_KEY);
  return saved && (saved === 'auto' || QUALITY_PRESETS[saved]) ? saved : 'auto';
}

// Wave-4 §B: three camera modes (index = uCamMode's numeric value), a topbar
// <select> + keyboard 1/2/3 (guarded by inEditableChrome, same as WASD) +
// localStorage persistence — same shape as the quality preset above.
const CAM_MODES = ['orbit', 'follow', 'overview'];
const CAM_MODE_KEY = 'sg.garden.camMode';
const CAM_KEYS = new Map([['1', 0], ['2', 1], ['3', 2]]);
const CAM_BLEND_MS = 450; // fast enough to feel responsive, slow enough to read as a transition

function loadCamMode() {
  const idx = CAM_MODES.indexOf(localStorage.getItem(CAM_MODE_KEY));
  return idx >= 0 ? idx : 0;
}

// Multiplayer (spec docs/multiplayer-spec.md, "The Commons") — §5.1's
// diegetic lock. Kept in JS only as the trigger for a transition-only `ring`
// send + the "Take the lectern" affordance; the actual SDF placement lives
// shader-side (COMP_LECTERN, §5.1) and is NOT duplicated here beyond this
// one radius check, same discipline PLAY_RADIUS's own comment documents.
const SG_LECTERN_XZ = [1.6, -1.4];
const LECTERN_RADIUS = 0.9;
// §5.1: holder re-arms the server's 20s lease TTL on a timer "comfortably
// inside" it — 8s gives 2-3 missed beats of slack before the server would
// ever expire it out from under a still-present holder.
const LEASE_KEEPALIVE_MS = 8000;
const MP_NAME_KEY = 'sg.garden.name';

function loadMpName() {
  try {
    return localStorage.getItem(MP_NAME_KEY) || '';
  } catch { return ''; }
}

// Same swallow-and-continue shape as loadMpName: a browser with storage
// disabled still gets to play, it just does not remember the name next time.
function saveMpName(name) {
  try { localStorage.setItem(MP_NAME_KEY, name); } catch { /* private mode */ }
}

export async function mount(ctx) {
  const { root, bus } = ctx;
  root.replaceChildren();

  // §8: "#/garden" and "#/garden/:room" are the SAME organ — this is the
  // ONLY fork point. `room` presence is what activates the net layer; every
  // other line below either runs unconditionally (solo behaviour, I1) or is
  // behind `if (room)` (I3 — no net import, no MP uniform, no MP DOM on the
  // solo path). Never add a second branch that forks index.js itself.
  const room = ctx.params.get('room');

  const stage = el('div', 'viewer-stage'); // same fullscreen-canvas-host rules the viewer uses
  const topbar = el('div', 'viewer-topbar');
  const backLink = el('a', 'btn btn-small btn-ghost', '← gallery');
  backLink.setAttribute('href', '#/');
  // Wave-4 §3: makes "where did this come from" discoverable from inside
  // the garden itself, not just from a probe panel someone happens to open.
  const attribLink = el('a', 'btn btn-small btn-ghost', 'Attribution');
  attribLink.setAttribute('href', '#/attribution');
  const backendBadge = el('span', 'badge badge-backend', '…');
  const fpsBadge = el('span', 'badge badge-fps', '');
  const perfBadge = el('span', 'badge badge-perf', ''); // PERF-2: honest ms/frame (EMA) · renderScale, always on
  const qualitySelect = el('select', 'garden-quality-select');
  for (const opt of ['auto', 'low', 'medium', 'high']) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt === 'auto' ? 'Auto' : opt[0].toUpperCase() + opt.slice(1);
    qualitySelect.append(o);
  }
  let qualityMode = loadQualityMode();
  qualitySelect.value = qualityMode;
  // Wave-4 §B: camera mode select — same topbar slot/pattern as qualitySelect.
  // camBlend starts at 1 (fully resolved, no transition in flight) — boot
  // state is a settled Orbit, not a mid-blend.
  const camSelect = el('select', 'garden-cam-select');
  for (const [i, name] of CAM_MODES.entries()) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = name[0].toUpperCase() + name.slice(1);
    camSelect.append(o);
  }
  let camMode = loadCamMode(), prevCamMode = camMode, camBlend = 1;
  let camBlendStart = 0, camBlendRafId = null;
  camSelect.value = String(camMode);
  // D1 (wave-4): collapsed-by-default live uniform-bank inspector, toggled
  // from the topbar next to the quality select — see uniform-inspector.js.
  const uniformsToggle = el('button', 'btn btn-small btn-ghost garden-uniform-toggle', 'Uniforms');
  uniformsToggle.type = 'button';
  const hint = el('span', 'garden-hint muted', 'drag to orbit · click anything to probe it');
  if (!localStorage.getItem(HINT_SEEN_KEY)) hint.classList.add('garden-hint-pulse');

  // MP UI shell (spec §5, §7.4, §8) — built ONLY when `room` is present.
  // I3 requires zero MP DOM on the solo path, so this entire block (and
  // every element it creates) is gated on `room` and never touched again if
  // `room` is falsy.
  let mp = null;
  if (room) {
    const statusPill = el('span', 'pill garden-mp-status', 'connecting');
    const roomBadge = el('span', 'badge garden-mp-room', 'room ' + room);
    const roster = el('ul', 'garden-roster');
    const leaseLine = el('div', 'garden-lease-line muted', 'checking the lectern…');
    const leaseBtn = el('button', 'btn btn-small btn-primary garden-lease-btn', 'Take the lectern');
    leaseBtn.type = 'button';
    leaseBtn.hidden = true;
    const gamePill = el('span', 'pill garden-game-pill', 'lobby');
    const gameLine = el('div', 'garden-game-line muted', '');
    const startBtn = el('button', 'btn btn-small btn-ghost garden-game-start', 'Start hide-and-seek');
    startBtn.type = 'button';
    startBtn.hidden = true;
    // A room where everyone is 'wanderer' is not a game for friends. The name
    // was only ever read from localStorage at connect time and nothing wrote
    // it, so this is the missing half. `change` (not `input`) so a rename
    // lands when the player is done typing, not once per keystroke.
    const nameInput = el('input', 'garden-name-input');
    nameInput.type = 'text';
    nameInput.maxLength = 24;                 // matches the server's sanitizer
    nameInput.placeholder = 'your name';
    nameInput.value = loadMpName();
    const ghostNote = el('div', 'garden-ghost-note muted',
      'the garden is a ghost world — hiding is visual only, you pass through matter');
    const mpPanel = el('div', 'garden-mp-panel glass');
    const rosterHead = el('div', 'garden-mp-head', 'Who’s here');
    const leaseHead = el('div', 'garden-mp-head', 'The lectern');
    const gameHead = el('div', 'garden-mp-head', 'Hide and seek');
    mpPanel.append(
      rosterHead, nameInput, roster,
      leaseHead, leaseLine, leaseBtn,
      gameHead, gamePill, gameLine, startBtn,
      ghostNote,
    );
    stage.append(mpPanel);
    mp = {
      statusPill, roomBadge, roster, leaseLine, leaseBtn, gamePill, gameLine, startBtn, mpPanel,
      nameInput, members: [],
      selfId: null, holderId: null, phase: 'lobby',
    };
  }
  topbar.append(backLink, attribLink, backendBadge, fpsBadge, perfBadge, qualitySelect, camSelect, uniformsToggle);
  if (mp) topbar.append(mp.statusPill, mp.roomBadge);
  topbar.append(el('div', 'toolbar-spacer'), hint);
  root.append(stage, topbar);

  let sceneSrc;
  try {
    const res = await fetch('assets/garden/scene.glsl');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    sceneSrc = await res.text();
  } catch {
    const notice = centerNotice('Could not load the garden scene — the world failed to grow.');
    root.append(notice);
    return () => notice.remove();
  }
  // Best-effort: a missing/broken scene.wgsl just means runtimeHost's
  // prefer:'auto' never gets a WGSL candidate and falls straight to WebGL2 —
  // never a hard failure the way the GLSL fetch above is (GLSL is the only
  // source GARDEN-IDE can ever splice-recompile, so it's load-bearing).
  let sceneWgslSrc;
  try {
    const res = await fetch('assets/garden/scene.wgsl');
    if (res.ok) sceneWgslSrc = await res.text();
  } catch { /* WebGL2-only for this mount */ }
  // A nav-away during the fetch above is invisible to the loader until this
  // mount() call returns (loader mid-mount staleness gap) — bail before
  // spending a live GL context on a route nobody's looking at anymore.
  if (!ctx.alive()) return () => {};

  const { components } = parseScene(sceneSrc);
  const sceneLines = sceneSrc.split('\n');
  const connections = summarizeConnections(components); // pristine-source graph, computed once
  const idOf = (component) => components.indexOf(component) + 1; // probe-encoded id, 1-based, file order
  // GARDEN-IDE: component id -> current session-edited body text. Session-
  // only (no persistence) — populated by the inline "Edit here" editor
  // (edit.js via panel.js) and the stage selector (variants.js bodies also
  // land here — a variant IS an edit as far as splicing/Revert/measure are
  // concerned). Absent entry means "use component.source unchanged."
  const editedBodies = new Map();
  // GARDEN-IDE work item 3: component id -> selected variant id, so a
  // reopened panel shows the right active stage. Same session-only lifetime
  // as editedBodies; a manual edit clears the entry (the body is "custom"
  // from then on, not any named stage).
  const variantChoices = new Map();

  const tuneValues = {};
  for (const c of components) for (const t of c.tunes) tuneValues[t.name] = t.default;

  // Reassembles the full scene from the PRISTINE original (sceneLines) plus
  // whatever's currently in editedBodies — always rebuilt from scratch, never
  // from a previously-spliced string, so editing N different components in
  // one session never accumulates drift. Per component: pristine lines up to
  // and including its `@component` line, then its (possibly edited) body,
  // then resume right at its `@end` line.
  // `overrideBodies` defaults to the live editedBodies map (solo path,
  // unchanged) — MP's handleRemoteCommit passes a throwaway trial Map so a
  // not-yet-validated remote body never touches the real editedBodies until
  // prepareShader() has actually accepted it (I4).
  function buildSceneSource(overrideBodies = editedBodies) {
    if (!overrideBodies.size) return sceneSrc;
    const out = [];
    let cursor = 0;
    for (const c of components) {
      out.push(...sceneLines.slice(cursor, c.startLine));
      const body = overrideBodies.get(c.id);
      out.push(...(body != null ? body.split('\n') : sceneLines.slice(c.startLine, c.endLine - 1)));
      cursor = c.endLine - 1;
    }
    out.push(...sceneLines.slice(cursor));
    return out.join('\n');
  }

  // GARDEN-IDE: splice `body` in for `component`, recompile the whole scene,
  // and re-apply @tune values (webgl2.js already persists custom uniforms
  // across setShader() on the same instance — the explicit call here is
  // belt-and-suspenders, matching onBuild()'s own reapply below for the
  // context-loss case). Returns setShader()'s result in FULL-SCENE user
  // coordinates; edit.js does the further component-local remap.
  //
  // TRANSACTIONAL: a failing body may render diagnostics to the caller, but
  // it MUST NOT enter editedBodies and MUST NOT become the source the next
  // (re)build recompiles from — that's what `revert` / `handleRemoteCommit`
  // rely on for "the previous world still renders". The previous-good body
  // stays in editedBodies (or stays absent) exactly as it was before the
  // failed edit. The diagnostic surface (res.messages + the local pill in
  // edit.js) is unchanged.
  //
  // `opts.dryRun` (used for a non-holder's local sandbox — see openProbe
  // below): the trial build runs and the runtime shows the local draft
  // rendering, but the commit-to-editedBodies step is skipped. A non-
  // holder's body must never enter the world's source-of-truth map —
  // they aren't the lease holder, so even a passing local compile has
  // no claim on the world.
  function recompileWithBody(component, body, opts = {}) {
    if (!rh.runtime) return { ok: false, log: '', messages: [] };
    // Trial build: splice `body` into a throwaway copy of editedBodies so a
    // failure can't perturb the real state. Only commit to editedBodies
    // after setShader() confirms the trial compiles — the same two-sided
    // discipline handleRemoteCommit uses (its `trialBodies` pattern below),
    // applied uniformly here to the holder's own typing path.
    const trialBodies = new Map(editedBodies);
    if (body === component.source) trialBodies.delete(component.id);
    else trialBodies.set(component.id, body);
    const trialSrc = buildSceneSource(trialBodies);
    const res = rh.runtime.setShader(trialSrc);
    if (res.ok && !opts.dryRun) {
      // Trial compiled — commit to the real state.
      if (body === component.source) editedBodies.delete(component.id);
      else editedBodies.set(component.id, body);
      // F2: the single choke point every hand-edit AND variant swap already
      // goes through — editedBodies.has() is the truth, so this stays correct
      // (including clearing on revert-to-pristine) with no separate code path.
      tray.setEdited(component.id, editedBodies.has(component.id));
      rh.runtime.setUniforms(tuneValues);
    }
    // On !res.ok the real editedBodies is untouched; the next rebuild
    // (context loss, mount, etc.) still recompiles the prior-good source.
    return res;
  }

  let panel = null;
  function closePanel(opts) {
    if (panel) { panel.destroy(opts); panel = null; rh.runtime?.setUniforms({ uProbeSel: 0 }); }
  }

  // --- MP (multiplayer) state — spec §8.1's frozen net.js surface. `net` is
  // assigned once (below, after the movement integrator exists — getPose
  // reads charX/charZ/charYaw/gaitDist) but declared here, before the first
  // onBuild() call, so onBuild's `room && net` check is never a TDZ error.
  // Every one of these stays at its initial value on the solo path (I3).
  let net = null;
  let leaseHeld = 0, leaseHue = 0; // uLeaseHeld/uLeaseHue mirror, reapplied every (re)build below
  let ring = false;                // lectern-radius membership, for transition-only `ring` sends (§5.1)
  let lastSeekerId = null;         // whose round it is, for probingAllowed() below
  let phase = 'lobby';             // current room phase, drives uSpongeOn (mirror of mp.phase, kept locally for one-place reads)
  // §5.2 / dual-workspace bookkeeping. Three maps all keyed by componentId:
  //   - openEditors:   every currently mounted mountComponentEditor() handle
  //                    (both holder and non-holder). Lets renderLease/
  //                    renderGame push authority/mirror updates without
  //                    remounting, and lets handleRemoteDraft /
  //                    handleRemoteCommit keep an open editor's mirror in
  //                    lockstep with the world.
  //   - mirrorBodies:  last body we saw the holder broadcast for this
  //                    component (either via handleRemoteDraft or via
  //                    handleRemoteCommit's commit). Initial mirror text
  //                    for a freshly-opened non-holder editor, and the
  //                    fallback when no editor is currently open.
  //   - localDrafts:   the non-holder's editable-pane body for this
  //                    component, kept across close/reopen of the panel
  //                    AND across lease flips. NEVER used as rebuild
  //                    source (it's a local sandbox, not a commit) —
  //                    recompileWithBody() runs it as a trial build
  //                    locally so the user gets diagnostics on their
  //                    draft, but editedBodies is never touched for
  //                    a non-holder entry.
  let openEditors = new Map();
  let mirrorBodies = new Map();
  let localDrafts = new Map();

  // §5.1/§7.4/§8.1: uLecternOn=1 in any room (else 0; I3); uSpongeOn=1 only
  // during hiding/seeking (else 0); uSeekerBlind=1 only for the current
  // seeker during hiding (else 0). All three are MP-only — NEVER set on the
  // solo path (I3; mp-solo-parity.mjs asserts a solo mount never touches
  // them). Reapplied on every (re)build, same "fresh runtime starts with
  // nothing set" reasoning applyQualityUniform/applyCamUniforms document.
  function applyMpUniforms() {
    if (!room) return;
    const phaseOn = phase === 'hiding' || phase === 'seeking';
    const isSeeker = phase === 'hiding' && lastSeekerId != null && lastSeekerId === mp?.selfId;
    rh.runtime?.setUniforms({
      uLecternOn: 1,
      uSpongeOn: phaseOn ? 1 : 0,
      uSeekerBlind: isSeeker ? 1 : 0,
      uLeaseHeld: leaseHeld,
      uLeaseHue: leaseHue,
    });
  }

  // §5.2 dual-workspace: every open editor (holder or non-holder) needs
  // to know whether THIS client currently holds the lease, and what
  // name to show in the Watching pane if it doesn't. Pushed on every
  // lease change AND every phase edge (the spec calls these out together:
  // "renderLease/renderGame: Reapply uniforms and authority on every
  // change/rebuild"). The editor itself owns the swap (showing/hiding
  // the Watching pane, Revert/Commit buttons, the status pill label) —
  // this just tells it the truth at the moment of the change. Holders
  // also receive the call but only the holder-name update is meaningful
  // (they never show a Watching pane); harmless no-op for the rest.
  function notifyEditorsAuthority() {
    if (!room) return;
    const isSelfHolder = lastLease.isSelf;
    const holderName = isSelfHolder ? undefined : (lastLease.holderName || 'the holder');
    for (const [componentId, editor] of openEditors) {
      editor.setAuthority?.({ isHolder: isSelfHolder, holderName });
      // Resync the mirror too — by the time a lease flips, the previous
      // holder's last broadcast might still be in the Watching pane.
      const mirrorBody = mirrorBodies.get(componentId);
      if (mirrorBody != null) editor.setMirrorBody?.(mirrorBody);
    }
  }

  // PERF-2: pushes the current quality preset's SG_QUALITY level into the
  // shader — a fresh GL2Runtime (initial mount or a context-loss rebuild)
  // starts with no custom uniforms set, so this must run on every (re)build,
  // not just once. Auto uses the same level ("high") the site shipped before
  // this feature existed — see scene.glsl's SG_QUALITY comment.
  // PERF-4: in Auto, SG_QUALITY is no longer pinned at 2. The host's ladder
  // drops resolution first and, once that is pinned at its FLOOR and the
  // mount is STILL under LOW_FPS, calls onQualityStep(-1) — which walks this
  // value down. A fresh mount always starts at 2, so Auto on a capable
  // machine is still byte-identical to pre-PERF-2 behavior; only a mount that
  // has already proved it cannot hold framerate at the lowest resolution ever
  // sees a lower value. An explicit Low/Medium/High preset is untouched by
  // the ladder, which is the whole point of choosing one.
  let autoSgQuality = 2;
  function applyQualityUniform() {
    const sgQuality = qualityMode === 'auto' ? autoSgQuality : QUALITY_PRESETS[qualityMode].sgQuality;
    rh.runtime?.setUniforms({ SG_QUALITY: sgQuality });
  }

  // Wave-4 §B: pushes the current camera-mode state into the shader — same
  // "a fresh runtime starts with nothing set" reasoning as applyQualityUniform
  // above, so a context-loss rebuild mid-transition resumes at the LAST
  // known blend value (never resets to a jarring pure-orbit default).
  function applyCamUniforms() {
    rh.runtime?.setUniforms({ uCamMode: camMode, uPrevCamMode: prevCamMode, uCamBlend: camBlend });
  }

  // uCamBlend ramps 0->1 over CAM_BLEND_MS on every mode switch — the shader
  // cross-fades FROM uPrevCamMode's camera TO uCamMode's (see scene.glsl's
  // mainImage) so a mode switch is a blend, not a teleport.
  function setCamMode(next) {
    if (next === camMode) return;
    prevCamMode = camMode;
    camMode = next;
    localStorage.setItem(CAM_MODE_KEY, CAM_MODES[camMode]);
    camSelect.value = String(camMode);
    camBlend = 0;
    camBlendStart = performance.now();
    applyCamUniforms();
    if (camBlendRafId == null) camBlendRafId = requestAnimationFrame(tickCamBlend);
  }
  function tickCamBlend(t) {
    // Clamped at BOTH ends. `t` is the rAF callback's timestamp, which is the
    // time the frame STARTED — and that can precede the performance.now()
    // taken when the blend was armed, so (t - camBlendStart) goes slightly
    // negative on the first tick. Math.min alone let that through: measured
    // -0.00067 on the second sample of a ramp that was otherwise perfectly
    // monotonic, which is the camera extrapolating a frame the wrong way
    // before it starts. Rare (garden-camera passed two prior gate runs) and
    // sub-pixel, but it is a real inversion, not test noise.
    camBlend = Math.max(0, Math.min(1, (t - camBlendStart) / CAM_BLEND_MS));
    rh.runtime?.setUniforms({ uCamBlend: camBlend });
    camBlendRafId = camBlend < 1 ? requestAnimationFrame(tickCamBlend) : null;
  }
  function onCamChange(e) { setCamMode(Number(e.target.value)); }
  camSelect.addEventListener('change', onCamChange);

  let noGpuNotice = null; // see onBuild — retracted once a backend comes back
  function onBuild() {
    if (!rh) return; // fires once synchronously during the initial build, before rh is assigned
    backendBadge.textContent = rh.backend === 'webgpu' ? 'WebGPU' : rh.backend === 'webgl2' ? 'WebGL2' : 'no GPU';
    // One notice, not one per failed build. runtime-host's rebuild no longer
    // wipes the whole stage (it removes only its own canvas), so this handler
    // has to retract its own overlay: without this a retry loop stacks a fresh
    // notice every attempt, and a rebuild that finally SUCCEEDS would leave a
    // stale "no GPU" sign sitting over a working canvas.
    if (!rh.backend) {
      if (!noGpuNotice) { noGpuNotice = centerNotice('No GPU backend is available in this browser.'); stage.append(noGpuNotice); }
      return;
    }
    if (noGpuNotice) { noGpuNotice.remove(); noGpuNotice = null; }
    // A context-loss rebuild recompiles from the pristine glslSrc closed
    // over at runtimeHost() mount time — reassemble any session edits back
    // in before re-applying slider values, same reason as the line below.
    // editedBodies is only ever non-empty once GARDEN-IDE has run, which
    // permanently pins this mount to WebGL2 (see openProbe's onEditHere) —
    // so `rh.runtime.setShader` here is always the synchronous GL2 one.
    if (editedBodies.size) rh.runtime.setShader(buildSceneSource());
    // Re-applies current slider values after a fresh build — including a
    // context-loss rebuild, where the fresh runtime starts with none set.
    // Both backends support setUniforms() (GARDEN-1).
    rh.runtime.setUniforms(tuneValues);
    // §5.2 / Weekend P2P §2: any open editor that was mounted before this
    // rebuild also needs its tune authority re-pushed. onBuild() runs on
    // context loss too, where the old rh object is gone and a brand-new
    // runtime has no notion of who holds the lectern — without this, a
    // rebuild mid-round leaves every slider stuck at its post-rebuild
    // disabled state regardless of the still-current lease. Tunes also
    // reapply below via onBuild's setUniforms(tuneValues).
    // Correction 10: REMOVED. `notifyEditorsAuthority` is reachable
    // here only as a closure-captured name; the function it points at
    // is declared LATER in this same scope (line ~1028, well after
    // onBuild's first call at line ~579). JavaScript hoists the
    // declaration but not the assignment, so onBuild's first call
    // threw `ReferenceError: Cannot access 'notifyEditorsAuthority'
    // before initialization` and the runtime never finished building.
    // The lease flips already re-push authority via renderLease()
    // directly, so the call here was redundant — remove it.
    applyQualityUniform();
    applyCamUniforms();
    // §3.2: rh.rebuild() (context loss, or the WebGL2 pin the editing seam
    // above already does) builds a fresh runtime whose clock restarts at 0.
    // Re-arming here — right next to applyCamUniforms(), the exact pattern
    // this function already uses for quality/camera — is what keeps this
    // client's iTime from silently drifting off the rest of the room. This
    // is spec-called-out as the single most likely bug in the whole slice.
    applyMpUniforms();
    if (room && net) net.armClock(rh.runtime);
  }

  // PERF-2: honest compact HUD next to the fps badge — the same ~1Hz tap
  // wirePerf's fps badge uses, but the EMA'd ms/frame runtime-host.js
  // computes plus the current renderScale, always reflecting what's
  // actually rendering (never a stale/optimistic number).
  function fmtPerf({ emaMs, renderScale }) {
    const scale = (Math.round(renderScale * 100) / 100).toString() + 'x';
    perfBadge.textContent = emaMs.toFixed(1) + ' ms · ' + scale;
  }

  // Pinning a preset disables runtime-host's adaptive ladder for this mount
  // permanently (its own setRenderScale() contract) — the only way back to
  // Auto's clean ladder state is a fresh build, so switching TO auto rebuilds
  // rather than trying to resurrect ladder bookkeeping runtime-host already
  // tore down.
  async function setQuality(mode) {
    qualityMode = mode;
    localStorage.setItem(QUALITY_KEY, mode);
    if (mode === 'auto') {
      await rh.rebuild(); // resets scale/autoScale; onChange -> onBuild reapplies SG_QUALITY
    } else {
      rh.setRenderScale(QUALITY_PRESETS[mode].renderScale);
      applyQualityUniform();
    }
  }
  function onQualityChange(e) { setQuality(e.target.value); }
  qualitySelect.addEventListener('change', onQualityChange);

  let rh;
  rh = await runtimeHost(stage, {
    prefer: 'auto', glslSrc: sceneSrc, wgslSrc: sceneWgslSrc, canvasClass: 'viewer-canvas garden-canvas',
    fpsBadge, onLost: 'rebuild', bus, organ: 'garden', onChange: onBuild,
    maxDpr: GARDEN_MAX_DPR, onPerf: fmtPerf,
    // PERF-4: the rung below the resolution floor. Only Auto participates —
    // an explicit preset is a user decision the ladder must not relitigate.
    // Returns false at the ends of the range so the host keeps its timer
    // armed instead of spinning on a step that changes nothing.
    onQualityStep: (dir) => {
      if (qualityMode !== 'auto') return false;
      const next = Math.min(2, Math.max(0, autoSgQuality + dir));
      if (next === autoSgQuality) return false;
      autoSgQuality = next;
      applyQualityUniform();
      return true;
    },
  });
  if (qualityMode !== 'auto') rh.setRenderScale(QUALITY_PRESETS[qualityMode].renderScale);
  onBuild(); // paint the state the in-flight onChange() couldn't see rh for yet

  // Finds the first line inside `component`'s own pristine source where
  // `symbol` is actually referenced — a connection click scrolls here, not
  // just to the top of the component. Whole-word match; undefined (no
  // scroll) if the symbol moved or was never findable as plain text.
  function findSymbolLine(component, symbol) {
    const re = new RegExp('\\b' + symbol + '\\b');
    const lines = component.source.split('\n');
    const i = lines.findIndex((l) => re.test(l));
    return i < 0 ? undefined : i + 1;
  }

  // numericId is the probe-encoded id (1-based, file order — probeAt()'s
  // readback) — the shader side reads it back as `uProbeSel` to render a
  // selection seam around whichever component is currently probed.
  // `focusLine` (component-LOCAL, from a connections navigation click) scrolls
  // the read-only source pane there instead of leaving it at the top.
  let probedComponent = null; // for the tray's hover-highlight to fall back to when the mouse leaves an item

  // Wave-3 §3a: hovering a connection pill (panel.js's .probe-conn-link or
  // tray.js's .garden-tray-conn-link) previews the SAME uProbeSel rim-light
  // the tray's own item-hover uses below — resolved by id, since a
  // connection target is a {id,name,symbols} snapshot from connections.js,
  // not a reference into `components` (idOf() needs the latter). Falls back
  // to whatever's actually probed (or 0) on mouseleave, identical fallback.
  function onHoverConnection(componentId) {
    const target = componentId ? components.find((c) => c.id === componentId) : null;
    rh.runtime?.setUniforms({ uProbeSel: target ? idOf(target) : (probedComponent ? idOf(probedComponent) : 0) });
  }

  function openProbe(component, numericId, focusLine) {
    closePanel({ animate: false }); // fast swap — no exit animation to overlap the new panel's own enter transition
    rh.runtime?.setUniforms({ uProbeSel: numericId });
    probedComponent = component;
    panel = createProbePanel({
      component,
      body: editedBodies.get(component.id) ?? component.source,
      values: tuneValues,
      focusLine,
      // §5.2 / Weekend P2P §2: sliders only respond when this client is the
      // current lease holder. Solo (no room) = always tunable; room with
      // self-as-holder = tunable; otherwise read-only until the lease flips.
      // Read at mount time from `lastLease`; the renderLease path below
      // pushes setTuneAuthority() updates without remounting the panel.
      canTune: !room || lastLease.isSelf,
      connections: connections.get(component.id),
      onNavigate(targetId, symbol) {
        const target = components.find((c) => c.id === targetId);
        if (target) openProbe(target, idOf(target), findSymbolLine(target, symbol));
      },
      onHoverConnection,
      onTuneChange(name, v) {
        // Authority guard: a non-holder in a room is not allowed to
        // mutate the shared world. Panel disables slider for non-holders,
        // but a programmatic onTuneChange (future caller, lease flip
        // mid-keystroke) must NOT locally commit either — the holder's
        // broadcast is the single convergence path. Solo: always allowed.
        if (room && !lastLease.isSelf) return;
        tuneValues[name] = v;
        // §5.3 / Weekend P2P §2: holder dials, wire carries, every other
        // client converges via net.js's onTune(). Immediate local feedback
        // here is the holder's own slider — the authoritative echo matches.
        rh.runtime?.setUniforms({ [name]: v });
        // No debouncing: tunes are scalar, small, reactive. Reducer accepts
        // any number per second; wire is reliable ordered; server keeps the
        // last value authoritative. Solo path: net is null, no send.
        if (net && lastLease.isSelf) net.setTune(name, v);
      },
      async onEditHere(onSourceChanged) {
        // GARDEN-IDE's live recompile is GLSL-only — a WebGPU-backed mount
        // rebuilds onto WebGL2 first, transparently, and stays there for
        // the rest of this mount's life (runtime-host.js's rebuild()
        // permanently merges the override — no thrashing back to WebGPU on
        // a later context-loss rebuild). ctx.alive() isn't re-checked here:
        // this await is short (one fresh WebGL2 context, no network), and a
        // nav-away mid-rebuild just leaves an orphaned runtime the loader's
        // own superseded-mount cleanup already handles via this organ's
        // returned cleanup() calling rh.dispose().
        // F1: a visitor who was proud of seeing "WebGPU" in the badge
        // deserves to know why it just became "WebGL2" — one auto-
        // dismissing toast, exactly once per rebuild (this branch only
        // ever runs once per mount: rh.backend permanently stays 'webgl2'
        // afterward, so the condition itself is the once-per-rebuild guard).
        if (rh.backend === 'webgpu') {
          await rh.rebuild({ prefer: 'webgl2' });
          toast('Switched to WebGL2 for live editing');
        }
        const { mountComponentEditor } = await import('./edit.js');
        // §5.2: dual-workspace. isHolder is true for solo (room=null)
        // and for the current lease holder in a room; false for everyone
        // else in the room. Holder = single editable pane (legacy/solo
        // behaviour, preserved byte-identical). Non-holder = editable
        // "My draft" pane + read-only "Watching <holder>" pane above it.
        const isHolder = !room || lastLease.isSelf;
        const editor = await mountComponentEditor({
          component,
          // Holders reopen on their last-committed body; non-holders
          // reopen on their last LOCAL sandbox body — neither one
          // clobbers the other, so re-opening the same component five
          // minutes later still shows what the user had typed.
          initialBody: isHolder
            ? (editedBodies.get(component.id) ?? component.source)
            : (localDrafts.get(component.id) ?? component.source),
          originalBody: component.source,
          isHolder,
          isRoom: !!room,
          // The Watching pane header reads "Watching <name>"; non-holders
          // always get one. Holders ignore the field (their pane header
          // never shows it).
          holderName: isHolder ? undefined : (lastLease.holderName || 'the holder'),
          // The mirror starts at whatever the holder has last broadcast
          // for this component — a late-join snapshot applied via
          // applyEditsSnapshot, an earlier draft via handleRemoteDraft,
          // or the pristine source as the absolute fallback.
          initialMirrorBody: mirrorBodies.get(component.id) ?? component.source,
          // Same recompile path for everyone — recompileWithBody is
          // transactional (trial build; only an authoritative success path
          // commits into editedBodies), so a non-holder's local sandbox
          // runs as a trial build that renders locally to give them
          // their own diagnostics, never touches editedBodies, and is
          // never sent anywhere. dryRun makes the "commit" half of
          // recompileWithBody a no-op for non-holders, even on a passing
          // local compile — their draft is a local sandbox, not a claim
          // on the world.
          recompile: (body) => {
            // Authority is read HERE, at callback time — not from the
            // mount-time `isHolder` snapshot, which froze both dryRun and
            // draft transmission to whatever the lease was when the panel
            // opened, so a promoted editor never started transmitting.
            const authoritative = !room || lastLease.isSelf;
            const res = recompileWithBody(component, body, { dryRun: !authoritative });
            variantChoices.delete(component.id); // hand-edited — no named stage describes this body anymore
            onSourceChanged();
            // Only the holder broadcasts their draft. A non-holder's
            // local sandbox is local — §5.2 verbatim: "never transmitted
            // while non-holder", which is exactly why a non-holder's
            // recompile runs but their body never enters the net layer.
            if (room && net && res.ok && authoritative) net.sendDraft(component.id, body);
            return res;
          },
          // Keeps localDrafts in sync with the editable pane for EVERY mount,
          // not just non-holders. Holders route their keystrokes into
          // editedBodies through the recompile() above (the source of
          // truth), but ALSO writing to localDrafts keeps the cached
          // body honest across a later non-holder promotion: a player
          // who types as the holder, loses the lease, and reopens the
          // same component as a non-holder, would otherwise see a fresh
          // empty sandbox instead of the body they had been typing.
          // Negligible cost (one Map.set per keystroke).
          onLocalDraftChange: (body) => {
            localDrafts.set(component.id, body);
          },
          // §6.2 step 1: local validation via prepareShader() BEFORE ever
          // sending — a body that fails never leaves this machine.
          // Passed for EVERY room editor, not just one mounted as holder: a
          // later promotion can't acquire a callback without a remount, and
          // a remount would discard the local draft. Safe because edit.js
          // only shows Commit while current authority is holder.
          onCommit: room ? async (body) => {
            if (!net) return { ok: false, reason: 'no relay' };
            return net.commit(component.id, body);
          } : undefined,
        });
        // Track EVERY open editor (holder and non-holder) so renderLease
        // / renderGame can push authority + mirror updates without
        // remounting, and so handleRemoteCommit / handleRemoteDraft can
        // keep an open editor's mirror pane in lockstep with the world.
        // The destroy wrapper removes the entry so a fast-swap to another
        // component (or panel close) never leaves a stale handle in the
        // map for the next notifyEditorsAuthority() to call into.
        openEditors.set(component.id, editor);
        const rawDestroy = editor.destroy;
        editor.destroy = (...args) => { openEditors.delete(component.id); rawDestroy.apply(editor, args); };
        return editor;
      },
      async getEditorHref() {
        const b64 = await compress(buildSceneSource()).catch(() => null);
        return b64 ? ('#/edit?src=' + b64 + '&lang=glsl&line=' + component.startLine) : null;
      },
      onClose: () => { probedComponent = null; closePanel(); },
    });
    stage.append(panel.el);
    bus.emit('garden.probe.opened.v1', { component: component.id, route: '/garden' });
    // Wave-3 §1c: self-retires the hint the moment a visitor actually probes
    // something — not on a fixed timer.
    if (!localStorage.getItem(HINT_SEEN_KEY)) {
      localStorage.setItem(HINT_SEEN_KEY, '1');
      hint.classList.remove('garden-hint-pulse');
    }

    // Wave-4 §3: fetch this component's attribution (cached after the first
    // open, same identity-check discipline as the variant-manifest fetch
    // below — a fast-swapped panel must never get another component's
    // Origin block).
    const thisPanel = panel;
    attributionFor(component.id).then((attribution) => {
      if (panel !== thisPanel) return;
      thisPanel.setOrigin(attribution);
    });

    // GARDEN-IDE work item 3: fetch this component's stage manifest (cached
    // after the first open; a component without variants resolves null and
    // never shows a row). The panel may have been fast-swapped for another
    // component by the time the fetch lands — the identity check drops the
    // stale resolution instead of decorating the wrong panel.
    loadVariantManifest(component.id).then((manifest) => {
      if (!manifest || panel !== thisPanel) return;
      const activeId = variantChoices.get(component.id)
        ?? (editedBodies.has(component.id) ? null : manifest.variants.find((v) => v.pristine)?.id);
      thisPanel.setStages(manifest, activeId, async (variant) => {
        const nextBody = variant.pristine
          ? component.source
          : await loadVariantBody(component.id, variant).catch(() => null);
        if (nextBody == null) return null;
        // Variant bodies are GLSL, spliced through the same recompile path
        // as hand edits — same backend seam as onEditHere: a WebGPU-backed
        // mount pins onto WebGL2 first (and stays there — see onEditHere).
        if (rh.backend === 'webgpu') await rh.rebuild({ prefer: 'webgl2' });
        const res = recompileWithBody(component, nextBody);
        if (!res.ok) return null;
        if (variant.pristine) variantChoices.delete(component.id);
        else variantChoices.set(component.id, variant.id);
        return nextBody;
      });
    });
  }

  // GARDEN-IDE work item 1: the component tray — a collapsible rail listing
  // every parsed component, so components are touchable without pixel-
  // hunting the canvas. Hover previews the same uProbeSel highlight a canvas
  // click would set; it falls back to whatever's actually probed (if
  // anything) once the pointer leaves the item, rather than always to 0.
  const tray = createComponentTray({
    components,
    connections,
    onHover(component) {
      rh.runtime?.setUniforms({ uProbeSel: component ? idOf(component) : (probedComponent ? idOf(probedComponent) : 0) });
    },
    onSelect(component) { openProbe(component, idOf(component)); },
    onNavigate(componentId, symbol) {
      const target = components.find((c) => c.id === componentId);
      if (target) openProbe(target, idOf(target), findSymbolLine(target, symbol));
    },
    onHoverConnection,
    // GARDEN-IDE work item 4: measure.js is dynamic-imported here, not at the
    // top — same lazy discipline as edit.js; an idle #/garden visit never
    // fetches the measurement machinery.
    async onMeasure() {
      if (!rh.runtime) return;
      // measure.js stubs GLSL bodies and re-times via the synchronous GL2
      // readback — same backend seam as editing and variants: measuring a
      // WebGPU-backed mount pins it onto WebGL2 first (and it stays there).
      if (rh.backend === 'webgpu') await rh.rebuild({ prefer: 'webgl2' });
      if (!rh.runtime) return;
      const { measureComponentCosts } = await import('./measure.js');
      const results = await measureComponentCosts({ runtime: rh.runtime, components, editedBodies, buildSceneSource, tuneValues });
      for (const [id, ms] of results) tray.setCost(id, ms);
      // measure.js restores the scene itself; the probe highlight uniform
      // rides through setShader() untouched (webgl2.js persists custom
      // uniforms), so nothing else to put back here.
    },
  });
  stage.append(tray.el);

  // D1 (wave-4): mounted after `components` exists (tunable-name lookup) —
  // getRuntime/getComponents are lazy closures, so mount order vs. `rh`'s
  // own assignment above doesn't matter.
  const uniformInspector = createUniformInspector({ getRuntime: () => rh.runtime, getComponents: () => components });
  stage.append(uniformInspector.el);
  uniformInspector.start();
  uniformsToggle.addEventListener('click', () => uniformInspector.toggle());

  // Wave-3 §4: the player controller. One shared XZ vector two input
  // sources write into — held keyboard keys below and the touch joystick
  // (joystick.js, mounted further down) — read by a single rAF loop that
  // idle-exits the instant both sources go neutral (near-free: zero cost
  // while nobody's moving the figure). uCharPosX/uCharPosZ already drive
  // terrain-height clamping and 60%-follow camera targeting shader-side
  // (scene.glsl/scene.wgsl, wave-3 item D) — this only has to accumulate
  // and clamp a target, never read anything back from the GPU.
  let charX = 0, charZ = 0;
  // Wave-4 §A: charYaw (facing) and gaitDist (a distance accumulator, not a
  // time accumulator) live next to charX/charZ — same integrator, driven by
  // the same held-key/joystick vector. gaitDist NEVER wraps here (the
  // shader does fract()) — an ever-growing float is fine at f32 precision
  // for a browser session's realistic play time, exactly like iTime already
  // is.
  let charYaw = 0, gaitDist = 0;
  // §8.1: getPose() reads these SAME locals — the movement integrator is the
  // one and only source of truth; net.js never gets a second copy to drift
  // out of sync with. curSpeed01 mirrors moveFrame's own per-frame value
  // (0 at rest) so a poll between frames still reads something honest.
  let curSpeed01 = 0;
  const heldKeys = new Set();
  const joystickVec = { x: 0, z: 0 };
  let moveRafId = null;
  let moveLastT = 0;

  function currentMoveVector() {
    let dx = joystickVec.x, dz = joystickVec.z;
    for (const k of heldKeys) {
      const v = MOVE_KEYS.get(k);
      if (v) { dx += v[0]; dz += v[1]; }
    }
    const mag = Math.hypot(dx, dz);
    return mag > 1 ? [dx / mag, dz / mag] : [dx, dz]; // normalize so diagonals aren't faster
  }

  function moveFrame(t) {
    const dt = moveLastT ? (t - moveLastT) / 1000 : 0;
    moveLastT = t;
    const [dx, dz] = currentMoveVector();
    if (!dx && !dz) { curSpeed01 = 0; moveRafId = null; moveLastT = 0; return; } // idle-exit: no next frame scheduled
    let nx = charX + dx * MOVE_SPEED * dt;
    let nz = charZ + dz * MOVE_SPEED * dt;
    const d = Math.hypot(nx, nz);
    if (d > PLAY_RADIUS) { nx = (nx / d) * PLAY_RADIUS; nz = (nz / d) * PLAY_RADIUS; }
    const movedDist = Math.hypot(nx - charX, nz - charZ); // actual distance this frame, post-clamp
    gaitDist += movedDist; // frozen for free the instant this function idle-exits above
    if (movedDist > 1e-5) {
      const targetYaw = Math.atan2(dx, -dz); // matches the shader's yaw-rotation convention
                                              // (uCharYaw=0 faces -Z) — see scene.glsl's own comment
      let delta = targetYaw - charYaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest-path wrap to [-pi,pi]
      const maxTurn = TURN_RATE * dt;
      charYaw += Math.max(-maxTurn, Math.min(maxTurn, delta));
    }
    curSpeed01 = Math.min(1, Math.hypot(dx, dz)); // currentMoveVector() already normalizes to <= 1
    if (nx !== charX || nz !== charZ) {
      charX = nx; charZ = nz;
      rh.runtime?.setUniforms({
        uCharPosX: charX, uCharPosZ: charZ,
        uCharYaw: charYaw, uCharGaitDist: gaitDist, uCharSpeed01: curSpeed01,
      }); // only on actual change
      checkRing(); // §5.1: transition-only `ring` send, driven off the same integrator
    }
    moveRafId = requestAnimationFrame(moveFrame);
  }
  function ensureMoveLoop() {
    if (moveRafId == null) { moveLastT = 0; moveRafId = requestAnimationFrame(moveFrame); }
  }

  function onKeyDown(e) {
    const k = e.key.toLowerCase();
    const isMoveKey = MOVE_KEYS.has(k);
    const camIdx = CAM_KEYS.get(k); // wave-4 §B: 1/2/3 -> Orbit/Follow/Overview
    if (!isMoveKey && camIdx === undefined) return;
    // Guards the tune sliders (plain <input type="range">) and the mini-
    // editor (CodeMirror's isContentEditable div) the same way boot.js's
    // Shift+A hotkey does — see dom.js's inEditableChrome header.
    if (inEditableChrome(document.activeElement)) return;
    if (isMoveKey) {
      e.preventDefault(); // WASD/arrows must not scroll the page while steering the figure
      heldKeys.add(k);
      ensureMoveLoop();
    } else {
      setCamMode(camIdx); // digits don't scroll the page — no preventDefault needed
    }
  }
  function onKeyUp(e) { heldKeys.delete(e.key.toLowerCase()); }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Wave-3 §4 (mobile): the same shared vector, fed from a touch joystick
  // instead of held keys — joystick.js gates its own construction on
  // matchMedia('(pointer: coarse)') and no-ops (an inert destroy()) on
  // desktop, so this call is unconditional here.
  const joystick = mountJoystick(stage, (x, z) => {
    joystickVec.x = x; joystickVec.z = z;
    if (x || z) ensureMoveLoop();
  });

  // ---------------------------------------------------------------------
  // MP (multiplayer) wiring — spec §3-§7. Everything below this line is
  // reachable ONLY when `room` is set: `net` stays null and every handler
  // below is a no-op guard on the solo path (I3). Placed here, after the
  // movement integrator (charX/charZ/charYaw/gaitDist/curSpeed01) and the
  // tray/editedBodies machinery above both exist, since getPose and the
  // commit handlers close over them.
  // ---------------------------------------------------------------------
  let lastLease = { holder: null, isSelf: false };
  let keepaliveTimer = null;
  let mpEpoch = 0;

  function updateLeaseBtn() {
    if (!mp) return;
    const isSelf = lastLease.isSelf;
    // "Take the lectern" only appears while standing in the ring (§5.1) —
    // either to claim an unclaimed lease, or to release the one you hold.
    mp.leaseBtn.hidden = !ring || (lastLease.holder != null && !isSelf);
    mp.leaseBtn.textContent = isSelf ? 'Release the lectern' : 'Take the lectern';
  }

  function checkRing() {
    if (!room) return;
    const dx = charX - SG_LECTERN_XZ[0], dz = charZ - SG_LECTERN_XZ[1];
    const next = Math.hypot(dx, dz) < LECTERN_RADIUS;
    if (next === ring) return; // §5.1: transitions only, never per frame
    ring = next;
    net?.setInRing(ring);
    updateLeaseBtn();
  }

  function manageKeepalive(isHolder) {
    if (isHolder) {
      if (keepaliveTimer == null) keepaliveTimer = setInterval(() => net?.keepLease(), LEASE_KEEPALIVE_MS);
    } else if (keepaliveTimer != null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function renderRoster(members, selfId) {
    if (!mp) return;
    mp.members = members || [];
    if (selfId !== undefined) mp.selfId = selfId;
    mp.roster.replaceChildren();
    for (const m of members || []) {
      const li = el('li', 'garden-roster-item');
      const swatch = el('span', 'garden-hue-swatch');
      swatch.style.background = 'hsl(' + Math.round((m.hue ?? 0) * 360) + 'deg 70% 55%)';
      li.append(swatch, el('span', 'garden-roster-name', m.name || 'guest'));
      if (mp.holderId != null && mp.holderId === m.id) li.append(el('span', 'badge garden-lease-badge', 'lectern'));
      mp.roster.append(li);
    }
  }

  function renderLease(lease) {
    if (!mp) return;
    lastLease = lease || { holder: null, isSelf: false };
    mp.holderId = lastLease.holder ?? null;
    leaseHeld = lastLease.holder != null ? 1 : 0;
    leaseHue = lastLease.holderHue ?? 0;
    applyMpUniforms();
    mp.leaseLine.textContent = lastLease.holder == null
      ? 'unclaimed'
      : lastLease.isSelf
        ? 'you hold the lectern'
        : (lastLease.holderName || 'someone') + ' holds the lectern';
    updateLeaseBtn();
    manageKeepalive(lastLease.isSelf);
    // §5.2: any open editor was mounted against the PREVIOUS lease state.
    // The lease flipped (someone took / released / got it taken); every
    // editor needs to know its new role (single pane vs. dual workspace)
    // and, if it just became a non-holder, the new holder's name shown
    // in its Watching pane header. Holders may also need to drop the
    // Watching pane on the flip out — handled inside setAuthority.
    notifyEditorsAuthority();
    // §5.3 / Weekend P2P §2: a lease flip changes who may move a slider.
    // The currently-mounted panel (if any) needs the authority flip too,
    // without a remount — setTuneAuthority() is the in-place API for
    // toggling slider disabled-state. Reading lastLease.isSelf keeps the
    // contract identical to the canTune at panel-mount time above.
    panel?.setTuneAuthority?.(!room || lastLease.isSelf);
  }

  function renderGame(game) {
    if (!mp || !game) return;
    mp.gamePill.textContent = game.phase;
    mp.gamePill.className = 'pill garden-game-pill garden-game-' + game.phase;
    // The line was role-blind: everyone read "seek!", including the hiders.
    // It is also where Sculptor's Tag has to be TAUGHT — the seeker holding
    // the lectern by role is the whole mechanic, and a player who is not told
    // they can edit the world will just walk around looking.
    lastSeekerId = game.seekerId ?? null;
    const isSeeker = game.seekerId != null && game.seekerId === mp.selfId;
    // The reading panels cover most of the viewport (the component rail on
    // one side, the probe panel on the other). That is right for exploring
    // the garden and wrong for playing in it — you cannot hide in a world you
    // cannot see. Clear them once for the phase a player has to LOOK in.
    //
    // The seeker is exempt: those panels are their toolset, since Sculptor's
    // Tag is played by editing components. Fires on the phase EDGE only, so a
    // player who deliberately reopens a panel mid-round keeps it.
    if (game.phase !== mp.phase && (game.phase === 'hiding' || game.phase === 'seeking') && !isSeeker) {
      closePanel();
      tray.collapse();
    }
    if (game.phase === 'lobby') {
      mp.gameLine.textContent = 'waiting — press Start with 2+ people in the room';
      mp.startBtn.hidden = false;
    } else if (game.phase === 'over') {
      const nameOf = (id) => (mp.members.find((m) => m.id === id) || {}).name || 'someone';
      const scores = Object.entries(game.scores || {})
        .sort((x, y) => y[1] - x[1])
        .map(([id, n]) => nameOf(id) + ': ' + n)
        .join(', ');
      mp.gameLine.textContent = 'round over' + (scores ? ' — ' + scores : '');
      mp.startBtn.hidden = false;
    } else if (game.phase === 'hiding') {
      mp.gameLine.textContent = isSeeker
        ? 'you are the seeker — the world is yours the moment seeking starts'
        : 'hide! the seeker is blind for now';
      mp.startBtn.hidden = true;
    } else {
      mp.gameLine.textContent = isSeeker
        ? 'you hold the lectern — edit the world to flush them out'
        : 'stay hidden — the seeker can reshape the world around you';
      mp.startBtn.hidden = true;
    }
    // §7.4: uSpongeOn (hiding/seeking) + uSeekerBlind (only the current
    // seeker during hiding) — both live here so every phase edge reapplies
    // them on the next render. Reapply after the mp.phase comparison above
    // because isSeeker reads the OLD mp.phase; the local `phase` is what
    // applyMpUniforms() actually consults.
    phase = game.phase;
    applyMpUniforms();
    // §5.2: every open editor needs to know whether THIS client is
    // currently the lease holder. A phase edge usually doesn't change
    // the holder (the seeker holds throughout hiding+seeking), but the
    // spec lumps "renderLease/renderGame: reapply ... on every change/
    // rebuild" together — so a single function pushes both. Re-applying
    // authority here is a no-op when lastLease.isSelf hasn't changed;
    // re-applying the mirror body is idempotent.
    notifyEditorsAuthority();
    mp.phase = game.phase; // last: the edge test above compares against the previous phase
  }

  function renderStatus(status) {
    if (!mp || !status) return;
    mp.statusPill.textContent = status.message || status.state;
    mp.statusPill.className = 'pill garden-mp-status garden-mp-status-' + status.state;
  }

  // §5.3 late-join snapshot: apply EVERY committed body, then build + compile
  // the whole scene ONCE — never one compile per component (reuses the same
  // buildSceneSource() the solo path's own recompile flow reassembles from).
  function applyEditsSnapshot(edits) {
    if (!edits || !edits.size || !rh.runtime) return;
    for (const [componentId, body] of edits) {
      const component = components.find((c) => c.id === componentId);
      if (!component) continue;
      if (body == null) {
        editedBodies.delete(componentId);
        mirrorBodies.delete(componentId);
      } else {
        editedBodies.set(componentId, body);
        // The mirror pane should start at the freshly-snapshotted body
        // too — late-join means mirrorBodies was empty for this
        // component, and the next non-holder to open "Edit here" would
        // otherwise see pristine text in their Watching pane.
        mirrorBodies.set(componentId, body);
      }
      tray.setEdited(componentId, editedBodies.has(componentId));
      // If an editor is currently OPEN for this component (someone hit
      // "Edit here" before the snapshot arrived), keep its mirror in
      // lockstep — the holder's editor ignores the call, the non-
      // holder's pane re-renders to the newly-snapshotted body.
      openEditors.get(componentId)?.setMirrorBody?.(body ?? component.source);
    }
    const res = rh.runtime.setShader(buildSceneSource());
    if (res.ok) rh.runtime.setUniforms(tuneValues);
  }

  // See handleRemoteCommit: how many times a TLE-only gate result is retried,
  // and the base backoff between tries (multiplied by the attempt number, so
  // 500ms then 1000ms). Two retries covers the contention window measured on a
  // single-GPU box without making a genuinely slow scene feel hung.
  const REMOTE_GATE_TRIES = 3;
  const REMOTE_GATE_BACKOFF_MS = 500;
  // Bumped by every inbound commit so a retry that is overtaken can bail.
  let remoteCommitGen = 0;

  function rejectRemoteCommit(by) {
    toast((by ? by + '’s' : 'That') + ' change didn’t compile here — still showing the previous world');
  }

  // §6.2 step 2 — receiving a commit. Two-sided validation, belt and braces:
  // the existing admission-gate.js static check as a cheap reject, THEN
  // prepareShader() (L4, webgl2.js/webgpu.js) against a full scene built
  // with this ONE change trial-applied (editedBodies itself is untouched
  // until we know the trial compiles) — only prepareShader().commit() on
  // success. A failure never blanks the world (I4) and never advances the
  // locally-applied epoch.
  async function handleRemoteCommit({ componentId, body, by, epoch }) {
    if (!rh.runtime) return false;
    const component = components.find((c) => c.id === componentId);
    if (!component) return false;
    const trialBodies = new Map(editedBodies);
    if (body == null) trialBodies.delete(componentId); else trialBodies.set(componentId, body);
    const trialSrc = buildSceneSource(trialBodies);
    // §6.2 step 2, cheap reject first: the SAME admission-gate.js static
    // check the share-link surface uses. Dynamic-imported — same lazy
    // discipline edit.js's own import('./edit.js') and the doc-adapter
    // bundle already use, so an idle #/garden (solo OR MP-but-no-commit-yet)
    // never fetches js/editor/* (garden.mjs (a) asserts zero editor bytes
    // on an idle solo load). Only .admitted is read; .scrim (a DOM report)
    // is the share-link organ's own UI and is never appended here.
    const { gateShareLink } = await import('../../editor/admission-gate.js');
    // TLE is the one verdict that is about THIS MACHINE, not about the code.
    // The gate runs the trial in a sacrificial worker and gives it a fixed
    // frame budget (admission/index.js WATCHDOG.frameMs); when two live
    // gardens are already contending for one GPU the worker gets starved and
    // misses that budget on source that compiles fine in isolation (measured:
    // the same trial admits OK in ~390-1150ms alone and TLEs at ~1800-1900ms
    // with a second garden live). Rejecting there would strand this client a
    // component behind forever — §6.2 has no resync path, so the divergence is
    // permanent. So TLE alone is retried, with backoff, a bounded number of
    // times. CE/RE/WA/MLE are verdicts about the SOURCE and are never retried;
    // the anti-grief semantics that make them a hard reject are untouched.
    const myGen = ++remoteCommitGen;
    let admitted = false;
    for (let attempt = 0; attempt < REMOTE_GATE_TRIES; attempt++) {
      const res = await gateShareLink(trialSrc, 'glsl').catch(() => ({ admitted: false, report: null }));
      if (res.admitted) { admitted = true; break; }
      if (res.report?.verdict !== 'TLE') break; // a verdict about the code — reject now
      if (attempt + 1 >= REMOTE_GATE_TRIES) break;
      await new Promise((r) => setTimeout(r, REMOTE_GATE_BACKOFF_MS * (attempt + 1)));
      // A newer commit overtook this one while we were backing off; that one
      // owns the world now and re-running this stale trial would apply it out
      // of order. Drop out without touching the epoch.
      if (myGen !== remoteCommitGen) return false;
    }
    if (!admitted) { rejectRemoteCommit(by); return false; }
    if (myGen !== remoteCommitGen) return false;
    if (typeof rh.runtime.prepareShader !== 'function') { rejectRemoteCommit(by); return false; }
    const prepared = await rh.runtime.prepareShader(trialSrc).catch(() => null);
    if (!prepared || !prepared.ok) { prepared?.dispose(); rejectRemoteCommit(by); return false; }
    prepared.commit();
    if (body == null) editedBodies.delete(componentId); else editedBodies.set(componentId, body);
    tray.setEdited(componentId, editedBodies.has(componentId));
    rh.runtime.setUniforms(tuneValues);
    mpEpoch = epoch;
    // Update every open editor's Watching pane (holder has no mirror, so
    // the call is a no-op for them — see setMirrorBody in edit.js). Also
    // keep mirrorBodies fresh so the NEXT non-holder to open "Edit here"
    // for this component starts at the right text instead of the pristine
    // fallback.
    mirrorBodies.set(componentId, body ?? component.source);
    const editor = openEditors.get(componentId);
    editor?.setMirrorBody?.(body ?? component.source);
    return true;
  }

  // §5.2 — the live draft mirror. Routes to an OPEN editor's Watching
  // pane (no-op on a holder's editor — they don't have one); updates
  // mirrorBodies either way so a later "Edit here" on this component
  // starts at the latest seen holder body.
  function handleRemoteDraft({ componentId, body }) {
    mirrorBodies.set(componentId, body);
    openEditors.get(componentId)?.setMirrorBody?.(body);
  }

  // §5.3 / Weekend P2P §2: late-join welcome arrives with the full tunes
  // snapshot — every value the room is currently rendering. Reapply ALL
  // of them so a player who joins mid-round sees the same world the rest
  // of the room is showing, and so their probe panel opens with the right
  // starting slider positions if they peek a component before the first
  // delta. tuneValues is the source of truth — both the panel and the
  // shader read from it — and onBuild re-applies it on every rebuild.
  function handleTunesSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const u = {};
    for (const [name, value] of Object.entries(snapshot)) {
      tuneValues[name] = value;
      u[name] = value;
    }
    rh.runtime?.setUniforms(u);
    // A panel that's already open needs to know about every dialed value,
    // too — without setTuneValue() the slider visually disagrees with the
    // shader until the user nudges it. Pushed without remounting so the
    // currently-mounted probe stays put.
    panel?.setTuneValues?.(snapshot);
  }

  // §5.3 / Weekend P2P §2: a single tune delta from the holder. Mirrors
  // tuneValues locally so a subsequent probe panel opens at the right
  // slider position, and pushes the uniform so the world updates without
  // waiting for the next snapshot. The wire is authoritative — this
  // callback is the convergence path the holder's own dial initiated,
  // landing back at this client via the host's broadcast. No panel
  // remounting: setTuneValue() is the in-place slider update API the
  // brief calls out explicitly.
  function handleTuneDelta({ name, value, by }) {
    if (typeof name !== 'string' || typeof value !== 'number') return;
    tuneValues[name] = value;
    rh.runtime?.setUniforms({ [name]: value });
    panel?.setTuneValue?.(name, value);
  }

  if (room) {
    mp.leaseBtn.addEventListener('click', () => {
      if (!net) return;
      if (lastLease.isSelf) net.releaseLease();
      else net.requestLease();
    });
    mp.startBtn.addEventListener('click', () => net?.startGame());
    // Persist for the next visit AND apply to the live room, so a player who
    // names themselves mid-session does not have to rejoin to be recognised.
    mp.nameInput.addEventListener('change', () => {
      const next = mp.nameInput.value.trim().slice(0, 24);
      mp.nameInput.value = next;
      saveMpName(next);
      net?.rename(next);
    });
    import('./net.js').then(({ connectRoom }) => {
      if (!ctx.alive()) return;
      // Correction 8: the finite known-tune set is the union of every
      // @tune declared by every parsed component in the scene. A holder
      // cannot dial a uniform the scene never declared — and a
      // non-holder cannot be tricked into trying either, because
      // setTune() refuses unknown names BEFORE they hit the wire.
      const knownTunes = [];
      for (const c of components) for (const t of c.tunes) knownTunes.push(t.name);
      net = connectRoom({
        room,
        name: loadMpName(),
        getPose: () => ({ x: charX, z: charZ, yaw: charYaw, speed01: curSpeed01, gait: gaitDist }),
        setPeerUniforms: (obj) => rh.runtime?.setUniforms(obj),
        onEdits: applyEditsSnapshot,
        onCommit: handleRemoteCommit,
        onDraft: handleRemoteDraft,
        onLease: renderLease,
        onRoster: renderRoster,
        onGame: renderGame,
        onStatus: renderStatus,
        // §5.3 / Weekend P2P §2: tune snapshot + delta callbacks. Snapshot
        // arrives in the welcome payload, deltas arrive as `tune` messages
        // from the holder. The brief is explicit — these two callbacks are
        // the only places a non-holder's tuneValues advances, so a player
        // joining late or returning from a context-loss rebuild lands in
        // the room the rest of the room is in.
        onTunes: handleTunesSnapshot,
        onTune: handleTuneDelta,
        // Correction 8: finite known tune validation. See net.js's
        // `knownTunes` Set — setTune(name, value) refuses to send a wire
        // message unless `name` is in this list.
        knownTunes,
      });
      net.armClock(rh.runtime); // first arm — onBuild() re-arms on every rebuild thereafter (§3.2)
      checkRing(); // establish initial ring membership without waiting for the first movement frame
    }).catch(() => renderStatus({ state: 'failed', message: 'no relay' }));
  }

  let downAt = null;
  function onPointerDown(e) {
    if (e.target.closest('.probe-panel, .garden-tray')) return; // dragging a slider/tray item isn't a canvas gesture
    downAt = [e.clientX, e.clientY];
  }
  // async: WebGPU's probeAt() has no synchronous readback (see probe.js).
  // WebGL2's own probeAt() resolves in the same microtask either way, so
  // this costs GL2 nothing observable.
  // Mid-round, a hider clicking the world would reopen the very panel the
  // round-start clear just removed — and clicking is how you look around, so
  // it happens constantly. Reading the garden is a lobby activity; during a
  // round a non-seeker's click is just a click. The seeker keeps probing,
  // because probing is how they pick what to edit.
  function probingAllowed() {
    if (!mp) return true;                                   // solo: always
    if (mp.phase !== 'hiding' && mp.phase !== 'seeking') return true;
    return mp.selfId != null && mp.selfId === lastSeekerId;
  }

  async function onPointerUp(e) {
    if (!downAt || e.target.closest('.probe-panel, .garden-tray')) { downAt = null; return; }
    const [dx0, dy0] = downAt;
    downAt = null;
    if (Math.hypot(e.clientX - dx0, e.clientY - dy0) > CLICK_SLOP) return; // an orbit drag, not a click
    if (!probingAllowed()) return;
    if (!rh.runtime) return;
    const runtime = rh.runtime;
    const canvas = runtime.canvas;
    const [px, py] = canvasPixelCoords(canvas, e.clientX, e.clientY);
    const id = await probeAt(runtime, px, py);
    // The mount (or just this runtime, via a context-loss rebuild) may have
    // gone away while awaiting a WebGPU readback — re-check before touching
    // rh/the (possibly stale) runtime again.
    if (rh.runtime !== runtime) return;
    if (id == null || id < 1 || id > components.length) return;
    openProbe(components[id - 1], id);
  }
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);

  // Wave-3 §1b: hover-preview via a throttled probe, reusing the existing
  // hover->uProbeSel path (onHoverConnection resolves an id, falling back to
  // whatever's actually probed). Settles on ~120ms of no movement rather
  // than firing on every raw pointermove — probeAt is real GPU work.
  let hoverTimer = null;
  function onPointerMove(e) {
    if (e.target.closest('.probe-panel, .garden-tray')) return;
    clearTimeout(hoverTimer);
    const { clientX, clientY } = e;
    hoverTimer = setTimeout(async () => {
      if (!rh.runtime) return;
      const runtime = rh.runtime;
      const canvas = runtime.canvas;
      const [px, py] = canvasPixelCoords(canvas, clientX, clientY);
      const id = await probeAt(runtime, px, py);
      if (rh.runtime !== runtime) return; // same stale-async guard as onPointerUp
      onHoverConnection(id != null && id >= 1 && id <= components.length ? components[id - 1].id : null);
    }, HOVER_SETTLE_MS);
  }
  function onPointerLeave() {
    clearTimeout(hoverTimer);
    onHoverConnection(null);
  }
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerleave', onPointerLeave);

  return function cleanup() {
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerleave', onPointerLeave);
    clearTimeout(hoverTimer);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    if (moveRafId != null) cancelAnimationFrame(moveRafId);
    joystick.destroy();
    uniformInspector.destroy();
    qualitySelect.removeEventListener('change', onQualityChange);
    camSelect.removeEventListener('change', onCamChange);
    if (camBlendRafId != null) cancelAnimationFrame(camBlendRafId);
    closePanel({ animate: false });
    tray.destroy();
    if (keepaliveTimer != null) clearInterval(keepaliveTimer);
    net?.destroy();
    rh.dispose();
    stage.remove();
    topbar.remove();
  };
}
