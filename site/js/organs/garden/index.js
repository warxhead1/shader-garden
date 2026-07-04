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
  // A nav-away during the fetch above is invisible to the loader until this
  // mount() call returns (loader mid-mount staleness gap) — bail before
  // spending a live GL context on a route nobody's looking at anymore.
  if (!ctx.alive()) return () => {};

  const { components } = parseScene(sceneSrc);
  // Deep-link source for "open in editor" — built once (the scene is a
  // static asset, never changes mid-session), per component only the
  // &line= differs.
  const shareB64 = await compress(sceneSrc).catch(() => null);

  const tuneValues = {};
  for (const c of components) for (const t of c.tunes) tuneValues[t.name] = t.default;

  let panel = null;
  function closePanel() {
    if (panel) { panel.destroy(); panel = null; }
  }

  function onBuild() {
    if (!rh) return; // fires once synchronously during the initial build, before rh is assigned
    backendBadge.textContent = rh.backend === 'webgl2' ? 'WebGL2' : 'no GPU';
    if (!rh.backend) {
      stage.append(centerNotice('WebGL2 is not available in this browser.'));
      return;
    }
    // Re-applies current slider values after a fresh build — including a
    // context-loss rebuild, where the new GL2Runtime starts with none set.
    rh.runtime.setUniforms(tuneValues);
  }

  let rh;
  rh = await runtimeHost(stage, {
    prefer: 'webgl2', glslSrc: sceneSrc, canvasClass: 'viewer-canvas garden-canvas',
    fpsBadge, onLost: 'rebuild', bus, organ: 'garden', onChange: onBuild,
  });
  onBuild(); // paint the state the in-flight onChange() couldn't see rh for yet

  function openProbe(component) {
    closePanel();
    panel = createProbePanel({
      component,
      values: tuneValues,
      editorHref: shareB64 ? ('#/edit?src=' + shareB64 + '&lang=glsl&line=' + component.startLine) : null,
      onTuneChange(name, v) {
        tuneValues[name] = v;
        rh.runtime?.setUniforms({ [name]: v });
      },
      onClose: closePanel,
    });
    stage.append(panel.el);
    bus.emit('garden.probe.opened.v1', { component: component.id, route: '/garden' });
  }

  let downAt = null;
  function onPointerDown(e) {
    if (e.target.closest('.probe-panel')) return; // dragging a slider isn't a canvas gesture
    downAt = [e.clientX, e.clientY];
  }
  function onPointerUp(e) {
    if (!downAt || e.target.closest('.probe-panel')) { downAt = null; return; }
    const [dx0, dy0] = downAt;
    downAt = null;
    if (Math.hypot(e.clientX - dx0, e.clientY - dy0) > CLICK_SLOP) return; // an orbit drag, not a click
    if (!rh.runtime) return;
    const canvas = rh.runtime.canvas;
    const [px, py] = canvasPixelCoords(canvas, e.clientX, e.clientY);
    const id = probeAt(rh.runtime, px, py);
    if (id == null || id < 1 || id > components.length) return;
    openProbe(components[id - 1]);
  }
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);

  return function cleanup() {
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    closePanel();
    rh.dispose();
    stage.remove();
    topbar.remove();
  };
}
