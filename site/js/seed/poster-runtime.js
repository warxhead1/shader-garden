// seed/poster-runtime.js (SEED-2, seed.md §4.4): ONE hidden canvas + ONE
// SeedRuntime for every still-frame render (cold-start poster, missing-
// poster gen) — thumbs.js lift: off-screen layout box, context-lost
// rebuild, retry-once, never cache a blank. Disposed after idle. Doesn't
// touch a playing seed's own runtime (it snapshots its own canvas).
import { SeedRuntime } from './runtime.js';

const POSTER_W = 480;
const POSTER_H = 270; // 16:9, matches the host contract's aspect-ratio default
const IDLE_DISPOSE_MS = 10000;

let canvas = null;
let runtime = null;
let runtimeDead = false;
let idleTimer = null;

function ensure() {
  if (runtime || runtimeDead) return runtime;
  try {
    canvas = document.createElement('canvas');
    canvas.width = POSTER_W;
    canvas.height = POSTER_H;
    canvas.style.cssText =
      'position:fixed;left:-10000px;top:0;width:' + POSTER_W + 'px;height:' + POSTER_H + 'px;pointer-events:none;';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    runtime = new SeedRuntime(canvas);
    runtime.onContextLost = teardown;
  } catch {
    runtimeDead = true;
    if (canvas) canvas.remove();
    canvas = null;
  }
  return runtime;
}

function teardown() {
  if (runtime) {
    try {
      runtime.dispose();
    } catch {
      /* already gone */
    }
  }
  runtime = null;
  if (canvas) {
    canvas.remove();
    canvas = null;
  }
}

function scheduleIdleDispose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(teardown, IDLE_DISPOSE_MS);
}

// Compile `glsl` and render one frame at `time` on the shared runtime;
// returns { ok:true, url } or { ok:false, code, log? }. Never throws.
export function renderPosterFrame(glsl, time, _retried) {
  const rt = ensure();
  if (!rt) return { ok: false, code: 'no-webgl2' };
  const res = rt.setShader(glsl);
  if (!res.ok) return { ok: false, code: 'compile', log: res.log };
  rt.renderOnce(time);
  if (rt.isContextLost()) { // dead buffer -> blank PNG, never cache it
    teardown();
    if (!_retried) return renderPosterFrame(glsl, time, true);
    return { ok: false, code: 'no-webgl2' };
  }
  try {
    const url = canvas.toDataURL('image/png');
    scheduleIdleDispose();
    return { ok: true, url };
  } catch {
    return { ok: false, code: 'no-webgl2' };
  }
}
