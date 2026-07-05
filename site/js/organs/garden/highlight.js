// GARDEN-IDE — highlight.js
// Minimal read-only GLSL syntax tinting for the probe panel's source block —
// comments, numbers, keywords, via one regex pass. Deliberately NOT
// CodeMirror (that stays behind edit.js's dynamic import, only for the live
// "Edit here" surface) — this runs on every probe open, so it has to be
// free. Returns an HTML string with every non-token character HTML-escaped,
// so it's safe to assign to a `.innerHTML` even though GLSL source is full
// of `<`/`>`/`&` (comparisons, bitwise ops) that would otherwise parse as
// markup.

const KEYWORDS = new Set([
  'void', 'float', 'double', 'int', 'uint', 'bool',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4',
  'mat2', 'mat3', 'mat4', 'sampler2D', 'samplerCube',
  'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard',
  'const', 'uniform', 'in', 'out', 'inout', 'struct', 'true', 'false',
]);

// Comments, numeric literals, or bare identifiers — the only three token
// classes worth tinting for a skim-read of shader math.
const TOKEN_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b\d+\.?\d*(?:[eE][+-]?\d+)?[fF]?\b|\b[A-Za-z_]\w*\b/g;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} src @returns {string} escaped HTML with token spans */
export function tintGlsl(src) {
  let out = '', last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    out += escapeHtml(src.slice(last, m.index));
    const t = m[0];
    const cls = t.startsWith('//') || t.startsWith('/*') ? 'gtok-comment'
      : /^\d/.test(t) ? 'gtok-number'
      : KEYWORDS.has(t) ? 'gtok-keyword'
      : null;
    out += cls ? `<span class="${cls}">${escapeHtml(t)}</span>` : escapeHtml(t);
    last = m.index + t.length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}
