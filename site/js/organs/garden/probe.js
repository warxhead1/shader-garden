// GARDEN-0 — probe.js
// The tengine-probe homage: render one frame with the scene's uProbe
// uniform on (mainImage encodes the hit component's id into the red channel
// instead of shading it), readPixels the clicked pixel, decode, restore.
//
// Both renderOnce() calls below are synchronous (WebGL2 draws happen inline,
// not queued) — nothing else can observe the probe frame between the two
// calls, so the visible canvas never flashes the id-encoded frame.

/**
 * @param {import('../../runtime/webgl2.js').GL2Runtime} runtime
 * @param {number} x - drawing-buffer pixel x (GL convention, from canvasPixelCoords)
 * @param {number} y - drawing-buffer pixel y (GL convention, bottom-left origin)
 * @returns {number|null} the component id (1-based, matches parse.js's file
 *   order) at that pixel, or null if the click landed off-canvas or the
 *   context is lost.
 */
export function probeAt(runtime, x, y) {
  const canvas = runtime.canvas;
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
  if (runtime.isContextLost()) return null;

  const gl = canvas.getContext('webgl2'); // same context — getContext() on an
  // already-initialized canvas returns the existing context, never a new one.
  const clock = runtime.getClock();
  const t = clock.time;

  runtime.setUniforms({ uProbe: 1 });
  runtime.renderOnce(t);
  const out = new Uint8Array(4);
  gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
  runtime.setUniforms({ uProbe: 0 });
  runtime.renderOnce(t); // redraw the normal frame immediately — no visible flash

  return out[0]; // compId/255.0 in the shader, exact at 8-bit precision for small ids
}
