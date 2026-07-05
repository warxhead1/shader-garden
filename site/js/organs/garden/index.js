// Shader Garden — organs/garden/index.js
// "/garden" organ (GARDEN-0). A single raymarched GLSL scene made of named,
// probe-able components — see assets/garden/scene.glsl's header and
// ARCHITECTURE.md § "The Garden" for the annotation convention this reads.
// GL2-only by design (prefer: 'webgl2') — a WGSL port is future work, not a
// v2 requirement.

import { centerNotice } from '../../core/loader.js';
import { runtimeHost } from '../../core/runtime-host.js';
import { el } from '../../dom.js';
import { canvasPixelCoords } from '../../runtime/uniforms.js';
import { compress } from '../../share.js';
import { parseScene } from './parse.js';
import { probeAt } from './probe.js';
import { createProbePanel } from './panel.js';
import { summarizeConnections } from './connections.js';
import { createComponentTray } from './tray.js';
import { loadVariantManifest, loadVariantBody } from './variants.js';

// A pointerup within this many CSS pixels of the matching pointerdown counts
// as a probe click; anything farther is an orbit drag (both read the same
// canvas — the shader gets the raw iMouse feed regardless of which gesture
// this turns out to be).
const CLICK_SLOP = 6;

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
  const hint = el('span', 'garden-hint muted', 'drag to orbit · click anything to probe it');
  topbar.append(backLink, backendBadge, fpsBadge, perfBadge, qualitySelect, el('div', 'toolbar-spacer'), hint);
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
    backendBadge.textContent = rh.backend === 'webgl2' ? 'WebGL2' : 'no GPU';
    if (!rh.backend) {
      stage.append(centerNotice('WebGL2 is not available in this browser.'));
      return;
    }
    // A context-loss rebuild recompiles from the pristine glslSrc closed
    // over at runtimeHost() mount time — reassemble any session edits back
    // in before re-applying slider values, same reason as the line below.
    if (editedBodies.size) rh.runtime.setShader(buildSceneSource());
    // Re-applies current slider values after a fresh build — including a
    // context-loss rebuild, where the new GL2Runtime starts with none set.
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
    prefer: 'webgl2', glslSrc: sceneSrc, canvasClass: 'viewer-canvas garden-canvas',
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
      onTuneChange(name, v) {
        tuneValues[name] = v;
        rh.runtime?.setUniforms({ [name]: v });
      },
      async onEditHere(onSourceChanged) {
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
    // GARDEN-IDE work item 4: measure.js is dynamic-imported here, not at the
    // top — same lazy discipline as edit.js; an idle #/garden visit never
    // fetches the measurement machinery.
    async onMeasure() {
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

  let downAt = null;
  function onPointerDown(e) {
    if (e.target.closest('.probe-panel, .garden-tray')) return; // dragging a slider/tray item isn't a canvas gesture
    downAt = [e.clientX, e.clientY];
  }
  function onPointerUp(e) {
    if (!downAt || e.target.closest('.probe-panel, .garden-tray')) { downAt = null; return; }
    const [dx0, dy0] = downAt;
    downAt = null;
    if (Math.hypot(e.clientX - dx0, e.clientY - dy0) > CLICK_SLOP) return; // an orbit drag, not a click
    if (!rh.runtime) return;
    const canvas = rh.runtime.canvas;
    const [px, py] = canvasPixelCoords(canvas, e.clientX, e.clientY);
    const id = probeAt(rh.runtime, px, py);
    if (id == null || id < 1 || id > components.length) return;
    openProbe(components[id - 1], id);
  }
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);

  return function cleanup() {
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    qualitySelect.removeEventListener('change', onQualityChange);
    closePanel({ animate: false });
    tray.destroy();
    rh.dispose();
    stage.remove();
    topbar.remove();
  };
}
