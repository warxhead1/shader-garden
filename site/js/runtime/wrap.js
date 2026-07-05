// Shader Garden — runtime/wrap.js
// The runtime-owned prelude/epilogue for both backends, hoisted out of
// webgl2.js/webgpu.js so the (future) admission sacrificial worker compiles
// the byte-for-byte same artifact as the visible runtimes — see
// ARCHITECTURE.md § "The uniform contract".

export const GLSL_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;
out vec4 sg_fragColor;
`;

export const GLSL_EPILOGUE = `
void main() { vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy); sg_fragColor = vec4(c.rgb, 1.0); }
`;

// Computed from the actual prelude string (never hardcoded) — compiler line
// N maps to user line N - GLSL_PRELUDE_LINES.
export const GLSL_PRELUDE_LINES = GLSL_PRELUDE.split('\n').length - 1;

// COMP-0: `channels` (0-4) emits iChannel0.. sampler decls ONLY when > 0
// (ruling C11) — the zero-arg call keeps byte-identical single-pass output.
export function wrapGlsl(src, channels = 0) {
  const decl = channels ? Array.from({ length: channels }, (_, i) => `uniform sampler2D iChannel${i};\n`).join('') : '';
  return GLSL_PRELUDE + decl + src + GLSL_EPILOGUE;
}

// `custom` is a fixed 32-float bank (8 vec4f, so it satisfies WGSL's 16-byte
// array-of-vec4 alignment for free) backing GL2Runtime.setUniforms()'s WGSL
// equivalent — see wgCustomUniformNames()/genCustomAccessors() below. WGSL
// has no free-standing named-uniform binding model (no getUniformLocation-
// by-name equivalent), so a kernel can't just declare `uniform float NAME;`
// the way GLSL does; this bank + the `@sg-uniforms` directive is the WGSL
// substitute — see ARCHITECTURE.md § "The Garden" for the convention.
// 16 -> 32: wave-4 (locomotion §A + camera modes §B) adds 6 new engine
// uniforms (uCharYaw, uCharGaitDist, uCharSpeed01, uCamMode, uPrevCamMode,
// uCamBlend) — one deliberate doubling landed with the first of them
// (uCharYaw), not incrementally per-uniform, so the bank only ever moves
// once for this wave.
export const WGSL_CUSTOM_UNIFORM_SLOTS = 32;

export const WGSL_PRELUDE = `struct SGUniforms {
  res: vec4f,
  mouse: vec4f,
  time: f32,
  dt: f32,
  frame: f32,
  _pad: f32,
  custom: array<vec4f, 8>,
}
@group(0) @binding(0) var<uniform> U: SGUniforms;

@vertex
fn sg_vertex(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// A single directive line, anywhere in the raw (pre-wrap) user source:
//   // @sg-uniforms NAME1 NAME2 ...
// Assigns each name a bank slot by position (max WGSL_CUSTOM_UNIFORM_SLOTS).
// Not part of js/organs/garden/parse.js's @component/@tune/@end grammar —
// this is a runtime-level convention consumed only by wrap.js/webgpu.js.
const SG_UNIFORMS_DIRECTIVE_RE = /^\/\/\s*@sg-uniforms\s+(.+)$/m;

/** @returns {string[]} custom-uniform names in bank-slot order (possibly empty). */
export function wgCustomUniformNames(src) {
  const m = SG_UNIFORMS_DIRECTIVE_RE.exec(src);
  if (!m) return [];
  return m[1].trim().split(/\s+/).slice(0, WGSL_CUSTOM_UNIFORM_SLOTS);
}

const SWIZZLE = ['x', 'y', 'z', 'w'];

/** One `fn NAME() -> f32 { return U.custom[i].c; }` per name, in bank-slot order. */
function genCustomAccessors(names) {
  return names
    .map((name, i) => `fn ${name}() -> f32 { return U.custom[${i >> 2}].${SWIZZLE[i & 3]}; }\n`)
    .join('');
}

export const WGSL_EPILOGUE = `
@fragment
fn sg_fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // GLSL gl_FragCoord convention: pixel coords, y-up from the bottom edge.
  let sg_fragCoord = vec2f(pos.x, U.res.y - pos.y);
  let sg_color = mainImage(sg_fragCoord);
  return vec4f(sg_color.rgb, 1.0);
}
`;

// wrapWgsl joins with an extra '\n' on each side — that separator counts as
// a prelude line for compiler-message remap too.
export const WGSL_PRELUDE_LINES = (WGSL_PRELUDE + '\n').split('\n').length - 1;

// Extra lines a channel decl block adds — callers add this to WGSL_PRELUDE_LINES.
export const wgChanLines = (n) => (n ? 1 + n : 0);

// Extra lines the custom-uniform accessor block adds (one `fn NAME() {...}`
// line per name) — callers add this to WGSL_PRELUDE_LINES same as wgChanLines.
export const wgCustomLines = (src) => wgCustomUniformNames(src).length;

export function wrapWgsl(src, channels = 0) {
  const decl = channels ? `@group(0) @binding(1) var sg_samp: sampler;\n` + Array.from({ length: channels }, (_, i) => `@group(0) @binding(${2 + i}) var iChannel${i}: texture_2d<f32>;\n`).join('') : '';
  const customDecl = genCustomAccessors(wgCustomUniformNames(src));
  return WGSL_PRELUDE + '\n' + decl + customDecl + src + '\n' + WGSL_EPILOGUE;
}
