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

  check('(2) all 8 components parsed', components.length === 8, String(components.length));
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
    'shadow->character:const:SG_CHAR_XZ',
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
  check('(2) terrain is usedBy character, clouds, grass, pond, rocks',
    JSON.stringify(terrainUsedBy) === JSON.stringify(['character', 'clouds', 'grass', 'pond', 'rocks']), JSON.stringify(terrainUsedBy));
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
