// GARDEN-IDE — connections.js acceptance (pure function, no browser).
// Runs the analyzer against the REAL scene.glsl (via parse.js, the same
// ground-truth every other garden test uses) and pins the actual adjacency
// it produces — a regression net for both the regex grammar and the scene's
// own cross-component wiring. Node only: `node tools/test/garden-connections.mjs`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseScene } from '../../site/js/organs/garden/parse.js';
import { analyzeConnections, summarizeConnections } from '../../site/js/organs/garden/connections.js';

const SITE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../site');
let failed = false;

function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

function edgeSet(edges) {
  return new Set(edges.map((e) => `${e.from}->${e.to}:${e.kind}:${e.symbol}`));
}

/* ---------- (1) a tiny synthetic scene pins the grammar itself ---------- */
{
  const synthetic = [
    '// @component a "A" "defines a helper"',
    'float a_helper(float x) { return x * 2.0; }',
    'const float A_K = 1.5;',
    '// @end',
    '// @component b "B" "calls A and reads its constant"',
    'float b_use(float x) { return a_helper(x) + A_K; }',
    '// @end',
  ].join('\n');
  const { components } = parseScene(synthetic);
  const { edges } = analyzeConnections(components);
  check('(1) b calls a_helper (call edge)', edgeSet(edges).has('b->a:call:a_helper'), JSON.stringify(edges));
  check('(1) b reads A_K (const edge)', edgeSet(edges).has('b->a:const:A_K'), JSON.stringify(edges));
  check('(1) exactly two edges — no self-edges, no duplicates', edges.length === 2, JSON.stringify(edges));

  const summary = summarizeConnections(components);
  check('(1) summarizeConnections: a is usedBy b', summary.get('a').usedBy.some((u) => u.id === 'b'));
  check('(1) summarizeConnections: b uses a', summary.get('b').uses.some((u) => u.id === 'a'));
}

/* ---------- (2) the REAL scene's adjacency (ground truth, not a guess) ---------- */
{
  const sceneSrc = readFileSync(path.join(SITE_ROOT, 'assets/garden/scene.glsl'), 'utf8');
  const { components } = parseScene(sceneSrc);
  const { nodes, edges } = analyzeConnections(components);

  // 8 -> 11: see garden.mjs's note -- three appended multiplayer components.
  // The per-component identity checks below are deliberately unchanged.
  check('(2) all 11 components parsed', components.length === 11, String(components.length));
  check('(2) sky defines sg_sky_color', nodes.find((n) => n.id === 'sky').fns.includes('sg_sky_color'));
  check('(2) terrain owns sg_terrain_height', nodes.find((n) => n.id === 'terrain').fns.includes('sg_terrain_height'));

  const es = edgeSet(edges);
  // Every one of these is a real cross-component reference read straight out
  // of scene.glsl's component bodies — see connections.js's header for why
  // "const" also covers @tune uniforms, not just SG_* diorama constants.
  const expected = [
    'character->terrain:call:sg_terrain_height',   // sg_character_center's ground sample
    'shadow->character:call:sg_bounce_phase',       // sg_shadow_factor reuses the bounce phase
    'shadow->character:const:BOUNCE_HEIGHT',
    // wave-3: the character's XZ target moved from a component-owned const
    // (SG_CHAR_XZ) to a top-level engine uniform (uCharPosX/uCharPosZ,
    // declared alongside uProbe/uProbeSel/SG_QUALITY) — same reason those
    // three never show up as edges: it's not "owned" by any component body,
    // so this is no longer a tracked cross-component reference.
    'pond->terrain:call:sg_terrain_height',         // sg_pond_water_y sinks below the heightfield
    'pond->sky:call:sg_sky_color',                  // sg_pond_color's reflection
    'grass->terrain:call:sg_noise2',                // sg_grass_shade's wind wobble
    'clouds->terrain:call:sg_noise2',               // sg_cloud_fbm
    'rocks->terrain:call:sg_terrain_height',        // sg_rocks_center's ground sample
  ];
  for (const e of expected) check(`(2) real-scene edge present: ${e}`, es.has(e));
  check('(2) no edges from sky or terrain (they are the scene\'s leaves)',
    !edges.some((e) => e.from === 'sky' || e.from === 'terrain'), JSON.stringify(edges.filter((e) => e.from === 'sky' || e.from === 'terrain')));

  const summary = summarizeConnections(components);
  const terrainUsedBy = summary.get('terrain').usedBy.map((u) => u.id).sort();
  // 8 -> 11: multiplayer (docs/multiplayer-spec.md §0.5 C2) appends peers,
  // lectern and sponge after rocks; lectern and peers both read terrain
  // height like the pre-existing five do. Same "count/membership was never
  // the invariant, stable identity is" precedent as ffeeb04 ("test: accept
  // the three appended garden components (8 -> 11)"), which fixed the
  // sibling component-count assertions but missed this usedBy-list one.
  check('(2) terrain is usedBy character, clouds, grass, lectern, peers, pond, rocks',
    JSON.stringify(terrainUsedBy) === JSON.stringify(['character', 'clouds', 'grass', 'lectern', 'peers', 'pond', 'rocks']), JSON.stringify(terrainUsedBy));
}

/* ---------- (3) comment-only mentions: NO definitions, NO edges ---------- */
{
  // 'a' declares real symbols; 'b' only MENTIONS them inside // line
  // comments and /* block comments */. The graph must read 'b' as if those
  // mentions did not exist — 'a' still owns its defs, 'b' picks up no new
  // ones, and neither kind of cross-component edge (call/const) is emitted.
  const synthetic = [
    '// @component a "A" "owns the helper and constant"',
    'float a_helper(float x) { return x * 2.0; }',
    'const float A_K = 1.5;',
    '// @end',
    '// @component b "B" "mentions a\'s symbols ONLY in comments"',
    '// line comment: a_helper(A_K) looks like a call but is not',
    '/* block comment: a_helper(A_K) also looks like a call but is not */',
    'float b_real(float x) { return x + 1.0; }',
    '// @end',
  ].join('\n');
  const { components } = parseScene(synthetic);
  const { nodes, edges } = analyzeConnections(components);
  const a = nodes.find((n) => n.id === 'a');
  const b = nodes.find((n) => n.id === 'b');

  // Definitions: 'a' still owns exactly what it actually declares; 'b'
  // picks up no fns/consts from the commented mentions.
  check('(3) a still defines a_helper', a.fns.includes('a_helper'), JSON.stringify(a.fns));
  check('(3) a still defines A_K', a.consts.includes('A_K'), JSON.stringify(a.consts));
  check('(3) b defines only its real fn (no //-leaked defs)', JSON.stringify(b.fns) === JSON.stringify(['b_real']), JSON.stringify(b.fns));
  check('(3) b defines no consts (no /* */-leaked defs)', b.consts.length === 0, JSON.stringify(b.consts));

  // Edges: the comment-only mentions create neither a call nor a const
  // edge from b to a, and there is no edge at all from b.
  const bToA = edges.filter((e) => e.from === 'b' && e.to === 'a');
  check('(3) no comment-mention edges b -> a', bToA.length === 0, JSON.stringify(bToA));
  check('(3) no edges of any kind originate in b', edges.every((e) => e.from !== 'b'), JSON.stringify(edges));

  // And the summary view agrees — 'a' is not usedBy b.
  const summary = summarizeConnections(components);
  check('(3) summarizeConnections: a is not usedBy b',
    !summary.get('a').usedBy.some((u) => u.id === 'b'),
    JSON.stringify(summary.get('a').usedBy));
}

/* ---------- (4) comment-only DEFINITIONS are also ignored ----------------- */
{
  // A function-shaped and const-shaped token that only ever appear inside
  // comments must not be picked up as defs by extractDefs — the grammar is
  // for executable GLSL, not for prose that names a symbol.
  const synthetic = [
    '// @component a "A" "no executable defs, only commented ones"',
    '// float ghost_helper(float x) { return x; }',
    '/* const float GHOST_K = 9.0; */',
    'float real_only(float x) { return x + 0.0; }',
    '// @end',
  ].join('\n');
  const { components } = parseScene(synthetic);
  const { nodes, edges } = analyzeConnections(components);
  const a = nodes.find((n) => n.id === 'a');
  check('(4) commented float-decl does not register as a fn def',
    !a.fns.includes('ghost_helper'), JSON.stringify(a.fns));
  check('(4) commented const-decl does not register as a const def',
    !a.consts.includes('GHOST_K'), JSON.stringify(a.consts));
  check('(4) real executable def survives comment-stripping',
    a.fns.includes('real_only'), JSON.stringify(a.fns));
  check('(4) no edges at all (nothing else in the scene to connect to)',
    edges.length === 0, JSON.stringify(edges));
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
