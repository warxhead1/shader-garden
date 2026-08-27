// Shader Garden — core/runtime-host.js
// P1+P6 extraction (substrate.md §6.1): canvas -> backend pick -> compile ->
// start -> context-loss policy, replacing the hand-rolled hero + viewer
// lifecycle copies (v1 app.js:150-181/274-349). thumbs.js and the editor
// (mode.createRuntime) keep their own lifecycles (substrate §6.1/§6.2).
// PERF-0: also owns the adaptive-quality ladder — sustained low fps steps
// renderScale down (floor 0.5), sustained recovery steps it back up (ceiling
// 1 — full DPR is explicit user choice, see webgl2.js). setRenderScale()
// below disables the ladder for its mount.

import { GL2Runtime } from '../runtime/webgl2.js';
import { wirePerf } from '../dom.js';

const LOW_FPS = 24, LOW_MS = 3000, HIGH_FPS = 50, HIGH_MS = 5000;
const STEP = 0.75, FLOOR = 0.5, CEIL = 1;

// PERF-3: onLost:'rebuild''s automatic recovery had no circuit breaker — a
// freshly (re)built context that itself loses immediately (reproducible under
// this site's own headless SwiftShader setup) drove `build()` straight back
// into `else build()` with no bound, so a busy enough machine could turn
// "lose, rebuild, lose again" into an unbounded stall with nothing left to
// observe it. MAX_LOSS_REBUILDS caps losses arriving before the context
// managed HEALTHY_UPTIME_MS of life. Measure UPTIME, not elapsed time: elapsed
// time on a slow host is mostly the REBUILD, so the old sliding window reset
// on every loss and could not trip (CI 32691231440: 39 losses, bound of 6).
const MAX_LOSS_REBUILDS = 5, HEALTHY_UPTIME_MS = 5000;

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
//         onPerf?: ({fps, ms, emaMs, renderScale}) => void, ~1Hz, PERF-2,
//         onQualityStep?: (-1|+1) => boolean, PERF-4 — the rung below the
//           resolution floor; false when the caller has no preset left }
export async function runtimeHost(host, opts) {
  const h = { runtime: null, backend: null, ok: false, log: '', duration_ms: 0 };
  let disposed = false, gen = 0;
  let scale = 1, autoScale = true, lowSince = 0, highSince = 0; // ladder state
  let emaMs = null; // PERF-2: smoothed ms/frame for the honest HUD readout
  // The one canvas THIS host created. The host is SHARED with the caller
  // (garden hangs the probe panel, MP panel, tray and uniform inspector off
  // it), so every build/rebuild/release path below removes its own canvas and
  // nothing else. A full wipe of the host's children instead detached whatever
  // the caller had mounted — garden's "Edit here" WebGL2 pin evicted the very
  // panel the editor was mid-flight to mount into.
  let ownCanvas = null;
  let lossCount = 0, builtAt = 0; // PERF-3 breaker; builtAt is stamped on build completion so the reset measures how long the context LIVED.

  function emit(type, data) {
    if (opts.bus) opts.bus.emit(type, { organ: opts.organ, ...data });
  }

  // Hysteretic: a fps sample inside [LOW_FPS, HIGH_FPS] resets both timers so a
  // mount hovering near a threshold doesn't oscillate the scale.
  // PERF-4: resolution is only the first rung. Pinned at FLOOR and still
  // starving, the ladder used to stop — leaving the mount slow forever at full
  // shader cost. opts.onQualityStep(-1|+1) is the rung below; truthy means it
  // changed something. Optional, so other organs are unaffected.
  function ladder(fps) {
    if (!autoScale || !h.runtime) return;
    const now = performance.now();
    if (fps < LOW_FPS) {
      highSince = 0; lowSince ||= now;
      if (now - lowSince >= LOW_MS) {
        if (scale > FLOOR) {
          scale = Math.max(FLOOR, scale * STEP); h.runtime.setRenderScale(scale); lowSince = now;
        } else if (opts.onQualityStep?.(-1)) {
          lowSince = now; // pixels are exhausted; shader work came down instead
        }
      }
    } else if (fps > HIGH_FPS) {
      lowSince = 0; highSince ||= now;
      if (now - highSince >= HIGH_MS) {
        // Quality back before resolution: it was taken away last.
        if (opts.onQualityStep?.(+1)) {
          highSince = now;
        } else if (scale < CEIL) {
          scale = Math.min(CEIL, scale / STEP); h.runtime.setRenderScale(scale); highSince = now;
        }
      }
    } else { lowSince = 0; highSince = 0; }
  }

  async function build() {
    const my = ++gen;
    if (h.runtime) { try { h.runtime.dispose(); } catch { /* gone */ } }
    h.runtime = null;
    scale = 1; autoScale = true; lowSince = 0; highSince = 0; emaMs = null; // fresh mount/rebuild starts the ladder clean
    ownCanvas?.remove(); ownCanvas = null; // fresh canvas each (re)build — one context type per canvas
    let canvas = document.createElement('canvas');
    if (opts.canvasClass) canvas.className = opts.canvasClass;
    // prepend, not append: the caller's overlays survive a rebuild, and
    // canvas-is-first-child is the invariant the old full-wipe guaranteed.
    host.prepend(canvas);
    ownCanvas = canvas;
    // Give up THIS build's canvas, touching nothing else in the host. Clears
    // ownCanvas only if it's still ours — a newer build (or dispose()) owns whatever is mounted now.
    const abandon = () => { canvas.remove(); if (ownCanvas === canvas) ownCanvas = null; };

    let picked = null;
    const attemptedWebgpu = opts.prefer !== 'webgl2' && !!opts.wgslSrc;
    if (attemptedWebgpu) picked = await tryWebgpu(canvas, opts.wgslSrc);
    // Re-check BEFORE the WebGL2 leg, not just after it: tryWebgpu() is the
    // only await here, so a rebuild()/dispose() landing during it leaves this
    // build holding a detached canvas — falling through would replaceWith()
    // onto a parentless node (a no-op) and point ownCanvas at that orphan,
    // stranding the CURRENT build's canvas as an unowned second one.
    if (disposed || my !== gen) { picked?.runtime?.dispose(); abandon(); return; }
    if (!picked && opts.prefer !== 'webgpu' && opts.glslSrc) {
      // A canvas's context type locks in on the first getContext() call — a
      // WebGPU attempt above may already have claimed this one as 'webgpu'
      // even though it went on to fail (a bad WGSL kernel gets a context fine
      // and only fails at compile/pipeline time), so getContext('webgl2') on
      // the SAME element silently returns null instead of falling back
      // (verified empirically). A fresh canvas whenever WebGPU was actually
      // attempted lets a failed WGSL kernel degrade instead of dead-ending.
      if (attemptedWebgpu) {
        const fresh = document.createElement('canvas');
        if (opts.canvasClass) fresh.className = opts.canvasClass;
        canvas.replaceWith(fresh);
        canvas = fresh;
        ownCanvas = fresh;
      }
      picked = tryWebgl2(canvas, opts.glslSrc, opts.maxDpr);
    }
    if (disposed || my !== gen) { picked?.runtime?.dispose(); abandon(); return; }

    if (!picked) { abandon(); h.backend = null; h.ok = false; h.log = ''; opts.onChange?.(); return; }
    const { runtime, backend, reason, res } = picked;
    h.runtime = runtime;
    h.backend = backend;
    h.ok = res.ok; h.log = res.log || ''; h.duration_ms = res.duration_ms;

    if (opts.fpsBadge) wirePerf(runtime, opts.fpsBadge, () => scale);
    const reportPerf = runtime.onPerf; // wirePerf's badge formatter, if any — chain the ladder onto it
    runtime.onPerf = (perf) => {
      // EMA over the ~1Hz samples — one honest, slightly-smoothed number for a
      // compact HUD, distinct from wirePerf's raw per-second fps badge.
      emaMs = emaMs == null ? perf.ms : emaMs * 0.8 + perf.ms * 0.2;
      reportPerf?.(perf); ladder(perf.fps);
      opts.onPerf?.({ fps: perf.fps, ms: perf.ms, emaMs, renderScale: scale });
    };
    runtime.onContextLost = () => {
      if (disposed || my !== gen) return;
      // PERF-3 circuit breaker: only the plain 'rebuild' policy retries
      // automatically, so only it needs bounding.
      const now = performance.now();
      if (now - builtAt > HEALTHY_UPTIME_MS) lossCount = 0; // survived the window = clean slate
      lossCount++;
      const autoRebuild = opts.onLost !== 'release' && typeof opts.onLost !== 'function';
      const tripped = autoRebuild && lossCount > MAX_LOSS_REBUILDS;
      emit('runtime.lost.v1', { backend, rebuilt: opts.onLost !== 'release' && !tripped });
      if (opts.onLost === 'release') { try { runtime.dispose(); } catch { /* gone */ } h.runtime = null; }
      else if (typeof opts.onLost === 'function') opts.onLost();
      else if (!tripped) build();
      else {
        try { runtime.dispose(); } catch { /* gone */ }
        h.runtime = null; h.backend = null; h.ok = false;
        h.log = `WebGL context lost ${lossCount} times without surviving ${HEALTHY_UPTIME_MS}ms; giving up automatic rebuild.`;
        opts.onChange?.();
      }
    };
    builtAt = performance.now(); // starts the breaker's uptime clock
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
    // `overrides` merges into `opts` BEFORE this and any future rebuild
    // (onLost:'rebuild' included), so a forced backend switch — garden's
    // editing seam pins WebGPU -> WebGL2 for live recompile — persists for the
    // rest of the mount's life instead of reverting on the next loss rebuild.
    rebuild(overrides) {
      if (overrides) Object.assign(opts, overrides);
      return build();
    },
    dispose() {
      disposed = true;
      // Drop our callbacks first: a runtime firing onContextLost from its own dispose() must not re-enter the rebuild policy.
      if (h.runtime) {
        h.runtime.onContextLost = null; h.runtime.onPerf = null;
        try { h.runtime.dispose(); } catch { /* gone */ }
        h.runtime = null;
      }
      ownCanvas?.remove(); ownCanvas = null; // ours only; the caller disposes its own overlays
    },
  };
}
