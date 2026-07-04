// Shader Garden — organs/gallery/thumbs.js
// Lazy gallery thumbnails: ONE shared canvas + ONE GL2Runtime for the whole
// grid. IntersectionObserver queues cards as they scroll into view; each
// kernel is rendered exactly once at t=1.5s via renderOnce, snapshotted with
// toDataURL, and cached in memory. Compile failures get a neutral placeholder.
// Never creates per-card GL contexts. Module-scope cache/state, moved into
// the gallery organ verbatim (substrate §6.1 "keep module-scope cache" —
// zero regression); NOT folded into runtimeHost, a genuinely different
// lifecycle (one shared context for N kernels vs one per mount).

import { GL2Runtime } from '../../runtime/webgl2.js';

const THUMB_W = 400;
const THUMB_H = 225;
const THUMB_TIME = 1.5;

const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="225">' +
  '<rect width="400" height="225" fill="#11141c"/>' +
  '<path d="M200 146v-34m0 0c0-20 15-30 30-30 0 20-14 30-30 30m0 0c0-15-11-22-22-22 0 15 9 22 22 22" ' +
  'stroke="#39435c" stroke-width="3" fill="none" stroke-linecap="round"/>' +
  '<text x="200" y="176" text-anchor="middle" font-family="system-ui" font-size="11" fill="#4a556e">no preview</text>' +
  '</svg>'
);

const cache = new Map();        // kernel id -> data URL
const pending = new Map();      // <img> -> kernel
const queue = [];               // { img, kernel }
let pumping = false;

let sharedCanvas = null;
let sharedRuntime = null;
let runtimeDead = false;        // WebGL2 unavailable — placeholders for all

const io = ('IntersectionObserver' in window)
  ? new IntersectionObserver(onIntersect, { rootMargin: '300px' })
  : null;

/**
 * Register a card <img> for a kernel. Cached thumbs resolve immediately;
 * otherwise the image is queued when it scrolls near the viewport.
 */
export function thumb(imgEl, kernel) {
  if (cache.has(kernel.id)) {
    applyThumb(imgEl, cache.get(kernel.id));
    return;
  }
  if (!io) {
    queue.push({ img: imgEl, kernel });
    pump();
    return;
  }
  pending.set(imgEl, kernel);
  io.observe(imgEl);
}

function onIntersect(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    io.unobserve(entry.target);
    const kernel = pending.get(entry.target);
    pending.delete(entry.target);
    if (kernel) queue.push({ img: entry.target, kernel });
  }
  pump();
}

function teardownRuntime() {
  if (sharedRuntime) { try { sharedRuntime.dispose(); } catch { /* gone */ } }
  sharedRuntime = null;
  if (sharedCanvas) { sharedCanvas.remove(); sharedCanvas = null; }
}

function ensureRuntime() {
  if (sharedRuntime || runtimeDead) return sharedRuntime;
  try {
    sharedCanvas = document.createElement('canvas');
    sharedCanvas.width = THUMB_W;
    sharedCanvas.height = THUMB_H;
    // Runtimes size themselves from client size — give the offscreen canvas
    // a real layout box, parked outside the viewport.
    sharedCanvas.style.cssText =
      'position:fixed;left:-10000px;top:0;' +
      'width:' + THUMB_W + 'px;height:' + THUMB_H + 'px;pointer-events:none;';
    sharedCanvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sharedCanvas);
    sharedRuntime = new GL2Runtime(sharedCanvas); // throws if no webgl2
    // On context loss tear the shared runtime down so the next ensureRuntime()
    // rebuilds it with a fresh canvas/context instead of snapshotting blanks.
    sharedRuntime.onContextLost = () => teardownRuntime();
  } catch {
    runtimeDead = true;
    sharedRuntime = null;
    if (sharedCanvas) { sharedCanvas.remove(); sharedCanvas = null; }
  }
  return sharedRuntime;
}

function pump() {
  if (pumping) return;
  pumping = true;
  requestAnimationFrame(step);
}

// One thumbnail per animation frame keeps the main thread responsive.
function step() {
  const item = queue.shift();
  if (!item) { pumping = false; return; }

  const { img, kernel } = item;
  let url = cache.get(kernel.id);

  if (!url) {
    const rt = ensureRuntime();
    if (rt) {
      try {
        const res = rt.setShader(kernel.glsl);
        if (res && res.ok) {
          rt.renderOnce(THUMB_TIME);
          // A lost context reports compile "ok" and toDataURL() of the dead
          // drawing buffer yields a blank PNG — never cache that.
          if (!rt.isContextLost()) url = sharedCanvas.toDataURL('image/png');
        } else if (!rt.isContextLost()) {
          url = PLACEHOLDER; // genuine compile failure
        }
      } catch {
        url = PLACEHOLDER;
      }
      if (!url) {
        // Context lost mid-pump: rebuild the shared runtime and retry this
        // kernel once instead of caching a blank thumbnail for the session.
        teardownRuntime();
        if (!item.retried) {
          item.retried = true;
          queue.push(item);
          requestAnimationFrame(step);
          return;
        }
        url = PLACEHOLDER;
      }
    } else {
      url = PLACEHOLDER;
    }
    cache.set(kernel.id, url);
  }

  applyThumb(img, url);
  requestAnimationFrame(step);
}

function applyThumb(img, url) {
  img.src = url;
  if (url === PLACEHOLDER) img.classList.add('thumb-fallback');
  img.classList.add('thumb-ready');
}
