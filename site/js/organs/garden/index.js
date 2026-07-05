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

export async function mount(ctx) {
  const { root, bus } = ctx;
  root.replaceChildren();

  const stage = el('div', 'viewer-stage'); // same fullscreen-canvas-host rules the viewer uses
  const topbar = el('div', 'viewer-topbar');
  const backLink = el('a', 'btn btn-small btn-ghost', '← gallery');
  backLink.setAttribute('href', '#/');
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
  // D1 (wave-4): collapsed-by-default live uniform-bank inspector, toggled
  // from the topbar next to the quality select — see uniform-inspector.js.
  const uniformsToggle = el('button', 'btn btn-small btn-ghost garden-uniform-toggle', 'Uniforms');
  uniformsToggle.type = 'button';
  const hint = el('span', 'garden-hint muted', 'drag to orbit · click anything to probe it');
  if (!localStorage.getItem(HINT_SEEN_KEY)) hint.classList.add('garden-hint-pulse');
  topbar.append(backLink, backendBadge, fpsBadge, perfBadge, qualitySelect, uniformsToggle, el('div', 'toolbar-spacer'), hint);
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
  function buildSceneSource() {
    if (!editedBodies.size) return sceneSrc;
    const out = [];
    let cursor = 0;
    for (const c of components) {
      out.push(...sceneLines.slice(cursor, c.startLine));
      const body = editedBodies.get(c.id);
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
  function recompileWithBody(component, body) {
    if (body === component.source) editedBodies.delete(component.id);
    else editedBodies.set(component.id, body);
    // F2: the single choke point every hand-edit AND variant swap already
    // goes through — editedBodies.has() is the truth, so this stays correct
    // (including clearing on revert-to-pristine) with no separate code path.
    tray.setEdited(component.id, editedBodies.has(component.id));
    if (!rh.runtime) return { ok: false, log: '', messages: [] };
    const res = rh.runtime.setShader(buildSceneSource());
    if (res.ok) rh.runtime.setUniforms(tuneValues);
    return res;
  }

  let panel = null;
  function closePanel(opts) {
    if (panel) { panel.destroy(opts); panel = null; rh.runtime?.setUniforms({ uProbeSel: 0 }); }
  }

  // PERF-2: pushes the current quality preset's SG_QUALITY level into the
  // shader — a fresh GL2Runtime (initial mount or a context-loss rebuild)
  // starts with no custom uniforms set, so this must run on every (re)build,
  // not just once. Auto uses the same level ("high") the site shipped before
  // this feature existed — see scene.glsl's SG_QUALITY comment.
  function applyQualityUniform() {
    const sgQuality = qualityMode === 'auto' ? 2 : QUALITY_PRESETS[qualityMode].sgQuality;
    rh.runtime?.setUniforms({ SG_QUALITY: sgQuality });
  }

  function onBuild() {
    if (!rh) return; // fires once synchronously during the initial build, before rh is assigned
    backendBadge.textContent = rh.backend === 'webgpu' ? 'WebGPU' : rh.backend === 'webgl2' ? 'WebGL2' : 'no GPU';
    if (!rh.backend) {
      stage.append(centerNotice('No GPU backend is available in this browser.'));
      return;
    }
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
    applyQualityUniform();
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
      connections: connections.get(component.id),
      onNavigate(targetId, symbol) {
        const target = components.find((c) => c.id === targetId);
        if (target) openProbe(target, idOf(target), findSymbolLine(target, symbol));
      },
      onHoverConnection,
      onTuneChange(name, v) {
        tuneValues[name] = v;
        rh.runtime?.setUniforms({ [name]: v });
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
        return mountComponentEditor({
          component,
          initialBody: editedBodies.get(component.id) ?? component.source,
          originalBody: component.source,
          recompile(body) {
            const res = recompileWithBody(component, body);
            variantChoices.delete(component.id); // hand-edited — no named stage describes this body anymore
            onSourceChanged();
            return res;
          },
        });
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

    // GARDEN-IDE work item 3: fetch this component's stage manifest (cached
    // after the first open; a component without variants resolves null and
    // never shows a row). The panel may have been fast-swapped for another
    // component by the time the fetch lands — the identity check drops the
    // stale resolution instead of decorating the wrong panel.
    const thisPanel = panel;
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
    if (!dx && !dz) { moveRafId = null; moveLastT = 0; return; } // idle-exit: no next frame scheduled
    let nx = charX + dx * MOVE_SPEED * dt;
    let nz = charZ + dz * MOVE_SPEED * dt;
    const d = Math.hypot(nx, nz);
    if (d > PLAY_RADIUS) { nx = (nx / d) * PLAY_RADIUS; nz = (nz / d) * PLAY_RADIUS; }
    if (nx !== charX || nz !== charZ) {
      charX = nx; charZ = nz;
      rh.runtime?.setUniforms({ uCharPosX: charX, uCharPosZ: charZ }); // only on actual change
    }
    moveRafId = requestAnimationFrame(moveFrame);
  }
  function ensureMoveLoop() {
    if (moveRafId == null) { moveLastT = 0; moveRafId = requestAnimationFrame(moveFrame); }
  }

  function onKeyDown(e) {
    const k = e.key.toLowerCase();
    if (!MOVE_KEYS.has(k)) return;
    // Guards the tune sliders (plain <input type="range">) and the mini-
    // editor (CodeMirror's isContentEditable div) the same way boot.js's
    // Shift+A hotkey does — see dom.js's inEditableChrome header.
    if (inEditableChrome(document.activeElement)) return;
    e.preventDefault(); // WASD/arrows must not scroll the page while steering the figure
    heldKeys.add(k);
    ensureMoveLoop();
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

  let downAt = null;
  function onPointerDown(e) {
    if (e.target.closest('.probe-panel, .garden-tray')) return; // dragging a slider/tray item isn't a canvas gesture
    downAt = [e.clientX, e.clientY];
  }
  // async: WebGPU's probeAt() has no synchronous readback (see probe.js).
  // WebGL2's own probeAt() resolves in the same microtask either way, so
  // this costs GL2 nothing observable.
  async function onPointerUp(e) {
    if (!downAt || e.target.closest('.probe-panel, .garden-tray')) { downAt = null; return; }
    const [dx0, dy0] = downAt;
    downAt = null;
    if (Math.hypot(e.clientX - dx0, e.clientY - dy0) > CLICK_SLOP) return; // an orbit drag, not a click
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
    closePanel({ animate: false });
    tray.destroy();
    rh.dispose();
    stage.remove();
    topbar.remove();
  };
}
