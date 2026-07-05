// GARDEN-0/GARDEN-1 — probe.js
// The tengine-probe homage: render one frame with the scene's uProbe
// uniform on (mainImage encodes the hit component's id into the red channel
// instead of shading it), read back the clicked pixel, decode.
//
// Routes by backend (GPURuntime is the only one with a readPixel() method —
// see runtime/webgpu.js):
//   - WebGL2: both renderOnce() calls are synchronous (WebGL2 draws happen
//     inline, not queued) — nothing else can observe the probe frame between
//     the two calls, so the visible canvas never flashes the id-encoded
//     frame; the second renderOnce() restores it.
//   - WebGPU: readPixel() renders into a dedicated offscreen texture and
//     never touches the canvas at all (see its own doc comment), so there's
//     no restore step needed on this backend — the visible frame was never
//     disturbed. Necessarily async (WebGPU has no synchronous readback);
//     callers must await probeAt().

/**
 * @param {import('../../runtime/webgl2.js').GL2Runtime | import('../../runtime/webgpu.js').GPURuntime} runtime
 * @param {number} x - drawing-buffer pixel x (GL convention, from canvasPixelCoords)
 * @param {number} y - drawing-buffer pixel y (GL convention, bottom-left origin)
 * @returns {Promise<number|null>} the component id (1-based, matches parse.js's
 *   file order) at that pixel, or null if the click landed off-canvas or the
 *   context is lost.
 */
export async function probeAt(runtime, x, y) {
  return typeof runtime.readPixel === 'function'
    ? probeAtWebgpu(runtime, x, y)
    : probeAtWebgl2(runtime, x, y);
}

function probeAtWebgl2(runtime, x, y) {
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

async function probeAtWebgpu(runtime, x, y) {
  if (runtime.isContextLost()) return null;
  const t = runtime.getClock().time;
  // uProbe:1 is scoped to this one offscreen frame (see readPixel's own doc)
  // — never written to persisted setUniforms() state, so the live render
  // loop is untouched regardless of how long the readback's await takes.
  const out = await runtime.readPixel(x, y, t, { uProbe: 1 });
  return out ? out[0] : null;
}
