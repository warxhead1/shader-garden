// Shader Garden — core/runtime-host.js
// P1+P6 extraction (substrate.md §6.1): canvas -> backend pick -> compile ->
// start -> context-loss policy, replacing the hand-rolled hero + viewer
// lifecycle copies (v1 app.js:150-181/274-349). thumbs.js (shared-context
// pump) and the editor (mode.createRuntime) keep their own genuinely
// different lifecycles — not folded in (substrate §6.1/§6.2).
// PERF-0: also owns the adaptive-quality ladder — sustained low fps steps
// renderScale down (floor 0.5), sustained recovery steps it back up (ceiling
// 1 — full DPR is explicit user choice, see webgl2.js). setRenderScale() below disables the ladder for its mount.

import { GL2Runtime } from '../runtime/webgl2.js';
import { wirePerf } from '../dom.js';

const LOW_FPS = 24, LOW_MS = 3000, HIGH_FPS = 50, HIGH_MS = 5000;
const STEP = 0.75, FLOOR = 0.5, CEIL = 1;

// webgpu.js is dynamic-imported only on an actual WGSL attempt — idle-costs-zero for a webgl2-only caller (the hero).
async function tryWebgpu(canvas, wgslSrc) {
  const { GPURuntime } = await import('../runtime/webgpu.js');
  const gpu = await GPURuntime.create(canvas);
  if (!gpu) return null;
  const t0 = performance.now();
  const res = await gpu.setShader(wgslSrc);
  if (!res.ok) { gpu.dispose(); return null; }
  return { runtime: gpu, backend: 'webgpu', reason: 'wgsl-port', res: { ...res, duration_ms: performance.now() - t0 } };
}

function tryWebgl2(canvas, glslSrc, maxDpr) {
  let gl;
  try { gl = new GL2Runtime(canvas, { maxDpr }); } catch { return null; }
  const t0 = performance.now();
  const res = gl.setShader(glslSrc);
  return { runtime: gl, backend: 'webgl2', reason: 'fallback', res: { ...res, duration_ms: performance.now() - t0 } };
}

// opts: { prefer: 'auto'|'webgl2'|'webgpu', glslSrc?, wgslSrc?, canvasClass,
//         fpsBadge?, onLost?: 'rebuild'|'release'|fn, bus?, organ?, onChange?,
//         maxDpr? (PERF-2: webgl2-only per-mount DPR cap, see webgl2.js),
//         onPerf?: ({fps, ms, emaMs, renderScale}) => void, ~1Hz, PERF-2 }
export async function runtimeHost(host, opts) {
  const h = { runtime: null, backend: null, ok: false, log: '', duration_ms: 0 };
  let disposed = false, gen = 0;
  let scale = 1, autoScale = true, lowSince = 0, highSince = 0; // ladder state
  let emaMs = null; // PERF-2: smoothed ms/frame for the honest HUD readout

  function emit(type, data) {
    if (opts.bus) opts.bus.emit(type, { organ: opts.organ, ...data });
  }

  // Hysteretic: a fps sample inside [LOW_FPS, HIGH_FPS] resets both timers so
  // a mount hovering near a threshold doesn't oscillate the scale.
  function ladder(fps) {
    if (!autoScale || !h.runtime) return;
    const now = performance.now();
    if (fps < LOW_FPS) {
      highSince = 0; lowSince ||= now;
      if (now - lowSince >= LOW_MS && scale > FLOOR) {
        scale = Math.max(FLOOR, scale * STEP); h.runtime.setRenderScale(scale); lowSince = now;
      }
    } else if (fps > HIGH_FPS) {
      lowSince = 0; highSince ||= now;
      if (now - highSince >= HIGH_MS && scale < CEIL) {
        scale = Math.min(CEIL, scale / STEP); h.runtime.setRenderScale(scale); highSince = now;
      }
    } else { lowSince = 0; highSince = 0; }
  }

  async function build() {
    const my = ++gen;
    if (h.runtime) { try { h.runtime.dispose(); } catch { /* gone */ } }
    h.runtime = null;
    scale = 1; autoScale = true; lowSince = 0; highSince = 0; emaMs = null; // fresh mount/rebuild starts the ladder clean
    host.replaceChildren(); // fresh canvas each (re)build — one context type per canvas
    const canvas = document.createElement('canvas');
    if (opts.canvasClass) canvas.className = opts.canvasClass;
    host.append(canvas);

    let picked = null;
    if (opts.prefer !== 'webgl2' && opts.wgslSrc) picked = await tryWebgpu(canvas, opts.wgslSrc);
    if (!picked && opts.prefer !== 'webgpu' && opts.glslSrc) picked = tryWebgl2(canvas, opts.glslSrc, opts.maxDpr);
    if (disposed || my !== gen) { picked?.runtime?.dispose(); return; }

    if (!picked) { canvas.remove(); h.backend = null; h.ok = false; h.log = ''; opts.onChange?.(); return; }
    const { runtime, backend, reason, res } = picked;
    h.runtime = runtime;
    h.backend = backend;
    h.ok = res.ok; h.log = res.log || ''; h.duration_ms = res.duration_ms;

    if (opts.fpsBadge) wirePerf(runtime, opts.fpsBadge, () => scale);
    const reportPerf = runtime.onPerf; // wirePerf's badge formatter, if any — chain the ladder onto it
    runtime.onPerf = (perf) => {
      // EMA over the ~1Hz samples — one honest, slightly-smoothed number for
      // a compact HUD, distinct from wirePerf's raw per-second fps badge.
      emaMs = emaMs == null ? perf.ms : emaMs * 0.8 + perf.ms * 0.2;
      reportPerf?.(perf); ladder(perf.fps);
      opts.onPerf?.({ fps: perf.fps, ms: perf.ms, emaMs, renderScale: scale });
    };
    runtime.onContextLost = () => {
      if (disposed || my !== gen) return;
      emit('runtime.lost.v1', { backend, rebuilt: opts.onLost !== 'release' });
      if (opts.onLost === 'release') { try { runtime.dispose(); } catch { /* gone */ } h.runtime = null; }
      else if (typeof opts.onLost === 'function') opts.onLost();
      else build();
    };
    emit('backend.selected.v1', { backend, reason });
    if (res.ok) runtime.start();
    opts.onChange?.();
  }

  await build();
  return {
    get runtime() { return h.runtime; },
    get backend() { return h.backend; },
    get ok() { return h.ok; },
    get log() { return h.log; },
    get duration_ms() { return h.duration_ms; },
    get renderScale() { return scale; },
    setRenderScale(s) { // user override — disables the auto ladder for this mount
      autoScale = false;
      return (scale = h.runtime ? h.runtime.setRenderScale(s) : s);
    },
    // `overrides` merges into `opts` BEFORE this (or any future — onLost:
    // 'rebuild' included) rebuild, so a one-time forced backend switch (the
    // garden organ's editing seam: WebGPU -> WebGL2 for live recompile)
    // persists for the rest of this mount's life instead of reverting on
    // the next context-loss rebuild — "don't thrash backends" is the
    // default once a caller has opted a mount onto a specific one.
    rebuild(overrides) {
      if (overrides) Object.assign(opts, overrides);
      return build();
    },
    dispose() {
      disposed = true;
      if (h.runtime) { try { h.runtime.dispose(); } catch { /* gone */ } h.runtime = null; }
      host.replaceChildren();
    },
  };
}
