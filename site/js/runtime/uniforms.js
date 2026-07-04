// uniforms.js — shared clock + Shadertoy-style mouse state for both runtimes.
// Plain ES module, dependency-free. See ARCHITECTURE.md § "Runtime interfaces".

/**
 * Create a pause-aware render clock.
 *
 * Accumulates elapsed time only between `start()` and `stop()`, using
 * `performance.now()`. Runtimes call `tick()` once per animation frame;
 * while stopped, `tick()` is a no-op (dt stays 0, time/frame freeze).
 *
 * @returns {{
 *   time: number,            // seconds accumulated while running
 *   dt: number,              // seconds since previous tick (0 when paused)
 *   frame: number,           // integer frame counter
 *   mouse: number[],         // [x, y, clickX, clickY] — see attachMouse()
 *   running: boolean,
 *   start(): void,           // begin/resume accumulation
 *   stop(): void,            // pause (time/frame hold their values)
 *   tick(): void,            // advance time/dt/frame by one frame
 *   seek(t): void,           // jump to an absolute time (scrub); dt resets to 0
 *   step(dt?): void          // manual single-frame advance while stopped (transport "Step")
 * }}
 */
export function createClock() {
  let last = 0;
  const clock = {
    time: 0,
    dt: 0,
    frame: 0,
    mouse: [0, 0, 0, 0],
    running: false,

    start() {
      if (clock.running) return;
      clock.running = true;
      last = performance.now();
    },

    stop() {
      clock.running = false;
      clock.dt = 0;
    },

    tick() {
      if (!clock.running) return;
      const now = performance.now();
      clock.dt = (now - last) / 1000;
      last = now;
      clock.time += clock.dt;
      clock.frame += 1;
    },

    // Scrubber drag target — an absolute jump, not an accumulation. Frame
    // count is left untouched (scrubbing isn't "advancing frames").
    seek(t) {
      clock.time = Math.max(0, t);
      clock.dt = 0;
      last = performance.now(); // so a resumed tick() doesn't see a huge stale dt
    },

    // Transport "Step": one manual advance while paused. Distinct from tick()
    // (which reads wall-clock elapsed time) — dt is caller-supplied so a step
    // is reproducible regardless of how long the UI took to react to the click.
    step(dt = 1 / 60) {
      clock.dt = dt;
      clock.time += dt;
      clock.frame += 1;
    },
  };
  return clock;
}

/**
 * Client (viewport) coordinates -> canvas drawing-buffer pixel coordinates,
 * GL convention (bottom-left origin, physical pixels). Shared by
 * attachMouse's iMouse feed and GARDEN-0's probe click — both need the exact
 * drawing-buffer pixel a client-space event landed on.
 */
export function canvasPixelCoords(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? canvas.width / rect.width : 1;
  const sy = rect.height > 0 ? canvas.height / rect.height : 1;
  const x = (clientX - rect.left) * sx;
  const y = canvas.height - (clientY - rect.top) * sy; // bottom-left origin
  return [x, y];
}

/**
 * Wire Shadertoy `iMouse` semantics onto `clock.mouse` ([x, y, clickX, clickY]).
 *
 * Convention (the common single-pass variant):
 *  - On press: xy = zw = press position, z/w positive (positive z ⇒ button held).
 *  - While dragging: xy tracks the current position; zw stays at the press point.
 *  - On release: z and w are negated (still encode |click position|), xy keeps
 *    the last drag position. Classic Shadertoy additionally keeps w positive
 *    only on the click frame; here w simply shares z's sign (held ⇒ positive).
 *
 * Coordinates are in physical pixels with a bottom-left origin (y flipped),
 * scaled by `canvas.width / boundingRect.width` so they match whatever DPR the
 * runtime is rendering at.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ mouse: number[] }} clock — clock from createClock()
 * @returns {() => void} detach function removing all listeners
 */
export function attachMouse(canvas, clock) {
  const m = clock.mouse;
  // Held-state is tracked here, NOT inferred from the sign of m[2]: a press in
  // the leftmost pixel column yields x === 0, which a sign test can't encode.
  let held = false;

  const toPixels = (ev) => canvasPixelCoords(canvas, ev.clientX, ev.clientY);

  const onDown = (ev) => {
    if (!ev.isPrimary) return;
    canvas.setPointerCapture?.(ev.pointerId);
    held = true;
    const [x, y] = toPixels(ev);
    m[0] = x;
    m[1] = y;
    // Clamp to a small positive epsilon so shaders testing `iMouse.z > 0.0`
    // see the button as held even for a press at the exact left/bottom edge
    // (where the coordinate would otherwise be 0, and release would store -0).
    m[2] = Math.max(x, 0.001); // positive z ⇒ button held
    m[3] = Math.max(y, 0.001);
  };

  const onMove = (ev) => {
    if (!ev.isPrimary || !held) return; // only track while held
    const [x, y] = toPixels(ev);
    m[0] = x;
    m[1] = y;
  };

  const onUp = (ev) => {
    if (!ev.isPrimary) return;
    canvas.releasePointerCapture?.(ev.pointerId);
    held = false;
    m[2] = -Math.abs(m[2]); // negative ⇒ released; magnitude keeps click pos
    m[3] = -Math.abs(m[3]);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
  };
}
