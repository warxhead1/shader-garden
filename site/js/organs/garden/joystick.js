// Shader Garden — organs/garden/joystick.js
// Wave-3 §4 (mobile): a small on-screen virtual joystick, DOM-only, shown
// only on coarse-pointer (touch) devices. Canvas drag is already claimed
// twice over (orbit's iMouse feed, and the probe click/drag disambiguation
// in index.js's CLICK_SLOP) — overloading it a third time for movement
// would mean guessing gesture intent with no clean signal to disambiguate
// on. This nub is a separate input surface instead, feeding the SAME shared
// move vector index.js's keyboard integrator reads (one loop, two sources).
//
// Built on Pointer Events (not raw touchstart/touchmove) — PointerEvent
// already unifies mouse/touch/pen, same reasoning index.js's own canvas
// onPointerDown/onPointerUp handlers use, and it lets a synthetic-event
// test drive the nub identically to a real finger (see
// tools/test/garden-movement.mjs).
import { el } from '../../dom.js';

const RADIUS = 40; // px — nub travel radius; matches .garden-joystick's CSS size

/**
 * @param {HTMLElement} stage
 * @param {(x: number, z: number) => void} onVector  called with an analog
 *   vector (each axis in [-1, 1]) on every drag frame, and (0, 0) on release.
 * @returns {{ destroy: () => void }}
 */
export function mountJoystick(stage, onVector) {
  if (!matchMedia('(pointer: coarse)').matches) return { destroy() {} }; // desktop: no DOM built, zero cost

  const base = el('div', 'garden-joystick');
  const nub = el('div', 'garden-joystick-nub');
  base.append(nub);
  stage.append(base);

  let activeId = null;
  let originX = 0, originY = 0;

  function onPointerDown(e) {
    if (activeId != null) return;
    activeId = e.pointerId;
    const r = base.getBoundingClientRect();
    originX = r.left + r.width / 2;
    originY = r.top + r.height / 2;
    base.classList.add('garden-joystick-active');
    base.setPointerCapture(activeId);
  }
  function onPointerMove(e) {
    if (e.pointerId !== activeId) return;
    let dx = e.clientX - originX, dz = e.clientY - originY;
    const mag = Math.hypot(dx, dz);
    if (mag > RADIUS) { dx = (dx / mag) * RADIUS; dz = (dz / mag) * RADIUS; }
    nub.style.transform = `translate(${dx}px, ${dz}px)`;
    onVector(dx / RADIUS, dz / RADIUS);
  }
  function onPointerUp(e) {
    if (e.pointerId !== activeId) return;
    activeId = null;
    base.classList.remove('garden-joystick-active');
    nub.style.transform = '';
    onVector(0, 0);
  }
  base.addEventListener('pointerdown', onPointerDown);
  base.addEventListener('pointermove', onPointerMove);
  base.addEventListener('pointerup', onPointerUp);
  base.addEventListener('pointercancel', onPointerUp);

  return {
    destroy() {
      base.removeEventListener('pointerdown', onPointerDown);
      base.removeEventListener('pointermove', onPointerMove);
      base.removeEventListener('pointerup', onPointerUp);
      base.removeEventListener('pointercancel', onPointerUp);
      base.remove();
    },
  };
}
