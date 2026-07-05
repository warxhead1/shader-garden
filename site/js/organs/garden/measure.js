// GARDEN-IDE — organs/garden/measure.js
// Per-component cost chips (work item 4): an explicit "Measure" action
// (tray.js's button — never automatic, so #/garden's idle cost never
// includes a measurement pass) that rebuilds the scene with one component's
// body neutralized at a time and times the delta against the current
// (un-neutralized) scene. Uses the same forced-sync renderOnce()+1x1-
// readPixels technique tools/test/perf.mjs uses headlessly — the only way to
// get real per-frame GPU cost instead of a rAF sample decoupled from actual
// completion (see that file's own header for the measured proof).
//
// STUB STRATEGY (documented, not gamed): sky and terrain are foundational —
// every other component's height/reflection math calls through them (see
// connections.js: terrain is used by 5 of the other 6 components), so
// "neutralizing" either would either fail to compile or collapse the whole
// diorama (terrain height feeds camera targeting, the pond depression, and
// the rock/character ground contact — a stubbed terrain isn't a smaller
// scene, it's a different one). Both report `null` ("—" in the tray) rather
// than a number that isn't actually measuring that component's own cost.
// Every other component gets its one cost-bearing function's body replaced
// with a trivial stand-in, textually, so the file still compiles and every
// OTHER component's behavior is byte-for-byte untouched.
const STUBS = {
  character: { fn: 'sg_character_sdf', body: 'return length(p - center) - 0.95;' },
  shadow: { fn: 'sg_shadow_factor', body: 'return 0.0;' },
  pond: { fn: 'sg_pond_sdf', body: 'return 1e6;' },
  grass: { fn: 'sg_grass_mask', body: 'return 0.0;' },
  clouds: { fn: 'sg_cloud_mask', body: 'return 0.0;' },
  rocks: { fn: 'sg_rocks_sdf', body: 'return 1e6;' },
};
const FRAMES = 20;

// Finds `<fn>(`, then a balanced-brace scan for its matching close (a GLSL
// function body never hides a brace inside a string literal), and swaps the
// interior for `newBody`. Returns null if `fn` isn't found (e.g. a live edit
// renamed it) or the braces don't balance — the caller reports "—" for that
// component rather than guessing at a corrupt splice.
function stubFunctionBody(source, fn, newBody) {
  const openParen = source.indexOf(fn + '(');
  if (openParen < 0) return null;
  const braceStart = source.indexOf('{', openParen);
  if (braceStart < 0) return null;
  let depth = 1, i = braceStart + 1;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  if (depth !== 0) return null;
  return source.slice(0, braceStart + 1) + '\n  ' + newBody + '\n' + source.slice(i - 1);
}

async function timeFrames(runtime, frames) {
  const gl = runtime.canvas.getContext('webgl2');
  const pixel = new Uint8Array(4);
  const t = runtime.getClock().time; // held fixed — every sample marches the SAME frame's geometry
  let prev = performance.now(), total = 0;
  for (let i = 0; i < frames; i++) {
    runtime.renderOnce(t);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); // blocks for real GPU completion
    const now = performance.now();
    total += now - prev;
    prev = now;
  }
  return total / frames;
}

/**
 * @param {{
 *   runtime: import('../../runtime/webgl2.js').GL2Runtime,
 *   components: import('./parse.js').Component[],
 *   editedBodies: Map<string, string>,  // live session edits — read AND restored, untouched otherwise
 *   buildSceneSource: () => string,
 *   tuneValues: Record<string, number>,
 * }}
 * @returns {Promise<Map<string, number|null>>} componentId -> ms delta, or null ("—": un-stubbable, or the stub target wasn't found)
 */
export async function measureComponentCosts({ runtime, components, editedBodies, buildSceneSource, tuneValues }) {
  const snapshot = new Map(editedBodies); // exact pre-measure state — restored below, edits included
  const results = new Map();

  const baselineAvg = await timeFrames(runtime, FRAMES);

  for (const c of components) {
    const stub = STUBS[c.id];
    if (!stub) { results.set(c.id, null); continue; } // sky / terrain — see header
    const activeBody = editedBodies.get(c.id) ?? c.source;
    const stubbedBody = stubFunctionBody(activeBody, stub.fn, stub.body);
    if (stubbedBody == null) { results.set(c.id, null); continue; }

    editedBodies.set(c.id, stubbedBody);
    const res = runtime.setShader(buildSceneSource());
    let ms = null;
    if (res.ok) {
      runtime.setUniforms(tuneValues);
      const stubbedAvg = await timeFrames(runtime, FRAMES);
      ms = Math.max(0, baselineAvg - stubbedAvg);
    }
    // Un-stub before the next component's measurement — every component is
    // measured against the true baseline, one neutralized at a time, never
    // a compounding stack of stubs.
    if (snapshot.has(c.id)) editedBodies.set(c.id, snapshot.get(c.id));
    else editedBodies.delete(c.id);
    results.set(c.id, ms);
  }

  // Rebuild once more from the exact pre-measure snapshot — the loop above
  // already restored the editedBodies MAP after each iteration, but the
  // runtime's compiled shader is still whatever the last stub left it at.
  editedBodies.clear();
  for (const [id, body] of snapshot) editedBodies.set(id, body);
  runtime.setShader(buildSceneSource());
  runtime.setUniforms(tuneValues);

  return results;
}
