// GARDEN-IDE — connections.js
// Static analysis of the PRISTINE scene source (parse.js's `components`,
// never a live-edited body — the graph describes how the components were
// authored to relate, not a moving target every keystroke). Plain regex over
// GLSL text, no parser, same trade-off parse.js's own annotation grammar
// makes. Pure functions, no DOM/GL — see tools/test/garden-connections.mjs
// for the node-only unit test this makes possible.
//
// Two kinds of edges, both scoped to "does component A's own body reference
// a symbol component B defines":
//   'call'  — A calls a function B's body defines (`float sg_foo(...)`-style).
//   'const' — A reads a top-level const/uniform B's body declares (this
//             covers both `const ... SG_FOO` diorama constants AND the
//             ALL-CAPS `@tune` uniforms — both are "owned" by whichever
//             component's body first declares them, and both show up as
//             real cross-component coupling in this scene).
// First-declaration wins ties (two components never declare the same name
// in this scene, but the rule is deterministic either way).
//
// Comments are stripped BEFORE both the definition scan AND the reference
// scan. A `// sg_foo()` line comment or a `/* sg_foo */` block comment
// mentions a symbol to a reader, not to the compiler, so it neither defines
// the symbol nor counts as a cross-component call/const reference. Block
// comments have their non-newline characters replaced with spaces so the
// surviving tokens keep their line numbers; line comments are dropped from
// `//` to the next newline.

const DEF_FN_RE = /\b(?:float|double|int|uint|bool|vec[234]|ivec[234]|bvec[234]|mat[234]|void)\s+([A-Za-z_]\w*)\s*\(/g;
const DEF_CONST_RE = /\b(?:const\s+\w+|uniform\s+float)\s+([A-Z][A-Z0-9_]*)\b/g;
const IDENT_RE = /\b[A-Za-z_]\w*\b/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;

/**
 * Strip GLSL comments (both line `//` form and `slash-star ... star-slash`
 * block form) from a chunk of source so the symbol scan only ever sees
 * executable mentions.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  // Block comments: replace each non-newline character with a space, keep
  // the newlines so the surviving tokens stay on the same line numbers.
  // Line comments: drop everything from `//` to the next newline.
  return source
    .replace(BLOCK_COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
    .replace(LINE_COMMENT_RE, '');
}

function extractDefs(source) {
  const fns = new Set();
  const consts = new Set();
  for (const m of source.matchAll(DEF_FN_RE)) fns.add(m[1]);
  for (const m of source.matchAll(DEF_CONST_RE)) consts.add(m[1]);
  return { fns, consts };
}

/**
 * @param {Array<{id: string, name: string, source: string}>} components — parse.js's output, file order
 * @returns {{
 *   nodes: Array<{ id, name, fns: string[], consts: string[] }>,
 *   edges: Array<{ from: string, to: string, kind: 'call'|'const', symbol: string }>,
 * }}
 */
export function analyzeConnections(components) {
  const strippedById = new Map(components.map((c) => [c.id, stripComments(c.source)]));
  const defsById = new Map(components.map((c) => [c.id, extractDefs(strippedById.get(c.id))]));
  const ownerOf = new Map(); // symbol -> owning component id
  for (const c of components) {
    const { fns, consts } = defsById.get(c.id);
    for (const s of fns) if (!ownerOf.has(s)) ownerOf.set(s, c.id);
    for (const s of consts) if (!ownerOf.has(s)) ownerOf.set(s, c.id);
  }

  const edges = [];
  const seen = new Set();
  for (const c of components) {
    const own = defsById.get(c.id);
    const idents = new Set(Array.from(strippedById.get(c.id).matchAll(IDENT_RE), (m) => m[0]));
    for (const ident of idents) {
      if (own.fns.has(ident) || own.consts.has(ident)) continue; // self-reference, not a connection
      const owner = ownerOf.get(ident);
      if (!owner || owner === c.id) continue;
      const key = `${c.id}>${owner}>${ident}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = defsById.get(owner).fns.has(ident) ? 'call' : 'const';
      edges.push({ from: c.id, to: owner, kind, symbol: ident });
    }
  }

  const nodes = components.map((c) => {
    const { fns, consts } = defsById.get(c.id);
    return { id: c.id, name: c.name, fns: [...fns], consts: [...consts] };
  });
  return { nodes, edges };
}

/**
 * Collapses the edge list to the per-component "uses" / "usedBy" shape the
 * tray and panel render (component names + the symbols that justify the
 * link), keyed by component id.
 * @returns {Map<string, {
 *   uses: Array<{ id, name, symbols: string[] }>,
 *   usedBy: Array<{ id, name, symbols: string[] }>,
 * }>}
 */
export function summarizeConnections(components) {
  const { nodes, edges } = analyzeConnections(components);
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  const bucket = () => new Map(nodes.map((n) => [n.id, new Map()]));
  const uses = bucket(), usedBy = bucket();
  for (const e of edges) {
    if (!uses.get(e.from).has(e.to)) uses.get(e.from).set(e.to, []);
    uses.get(e.from).get(e.to).push(e.symbol);
    if (!usedBy.get(e.to).has(e.from)) usedBy.get(e.to).set(e.from, []);
    usedBy.get(e.to).get(e.from).push(e.symbol);
  }
  const toList = (m) => [...m].map(([id, symbols]) => ({ id, name: nameOf.get(id), symbols }));
  return new Map(nodes.map((n) => [n.id, { uses: toList(uses.get(n.id)), usedBy: toList(usedBy.get(n.id)) }]));
}
