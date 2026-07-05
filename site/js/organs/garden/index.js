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
import { el } from '../../dom.js';
import { canvasPixelCoords } from '../../runtime/uniforms.js';
import { compress } from '../../share.js';
import { parseScene } from './parse.js';
import { probeAt } from './probe.js';
import { createProbePanel } from './panel.js';

// A pointerup within this many CSS pixels of the matching pointerdown counts
// as a probe click; anything farther is an orbit drag (both read the same
// canvas — the shader gets the raw iMouse feed regardless of which gesture
// this turns out to be).
const CLICK_SLOP = 6;

export async function mount(ctx) {
  const { root, bus } = ctx;
  root.replaceChildren();

  const stage = el('div', 'viewer-stage'); // same fullscreen-canvas-host rules the viewer uses
  const topbar = el('div', 'viewer-topbar');
  const backLink = el('a', 'btn btn-small btn-ghost', '← gallery');
  backLink.setAttribute('href', '#/');
  const backendBadge = el('span', 'badge badge-backend', '…');
  const fpsBadge = el('span', 'badge badge-fps', '');
  const hint = el('span', 'garden-hint muted', 'drag to orbit · click anything to probe it');
  topbar.append(backLink, backendBadge, fpsBadge, el('div', 'toolbar-spacer'), hint);
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
  // GARDEN-IDE: component id -> current session-edited body text. Session-
  // only (no persistence) — populated by the inline "Edit here" editor
  // (edit.js via panel.js), never by anything else. Absent entry means
  // "use component.source unchanged."
  const editedBodies = new Map();

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
  }

  let rh;
  rh = await runtimeHost(stage, {
    prefer: 'auto', glslSrc: sceneSrc, wgslSrc: sceneWgslSrc, canvasClass: 'viewer-canvas garden-canvas',
    fpsBadge, onLost: 'rebuild', bus, organ: 'garden', onChange: onBuild,
  });
  onBuild(); // paint the state the in-flight onChange() couldn't see rh for yet

  // numericId is the probe-encoded id (1-based, file order — probeAt()'s
  // readback) — the shader side reads it back as `uProbeSel` to render a
  // selection seam around whichever component is currently probed.
  function openProbe(component, numericId) {
    closePanel({ animate: false }); // fast swap — no exit animation to overlap the new panel's own enter transition
    rh.runtime?.setUniforms({ uProbeSel: numericId });
    panel = createProbePanel({
      component,
      body: editedBodies.get(component.id) ?? component.source,
      values: tuneValues,
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
        if (rh.backend === 'webgpu') await rh.rebuild({ prefer: 'webgl2' });
        const { mountComponentEditor } = await import('./edit.js');
        return mountComponentEditor({
          component,
          initialBody: editedBodies.get(component.id) ?? component.source,
          originalBody: component.source,
          recompile(body) {
            const res = recompileWithBody(component, body);
            onSourceChanged();
            return res;
          },
        });
      },
      async getEditorHref() {
        const b64 = await compress(buildSceneSource()).catch(() => null);
        return b64 ? ('#/edit?src=' + b64 + '&lang=glsl&line=' + component.startLine) : null;
      },
      onClose: () => closePanel(),
    });
    stage.append(panel.el);
    bus.emit('garden.probe.opened.v1', { component: component.id, route: '/garden' });
  }

  let downAt = null;
  function onPointerDown(e) {
    if (e.target.closest('.probe-panel')) return; // dragging a slider isn't a canvas gesture
    downAt = [e.clientX, e.clientY];
  }
  // async: WebGPU's probeAt() has no synchronous readback (see probe.js).
  // WebGL2's own probeAt() resolves in the same microtask either way, so
  // this costs GL2 nothing observable.
  async function onPointerUp(e) {
    if (!downAt || e.target.closest('.probe-panel')) { downAt = null; return; }
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

  return function cleanup() {
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    closePanel({ animate: false });
    rh.dispose();
    stage.remove();
    topbar.remove();
  };
}
