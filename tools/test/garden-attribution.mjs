// Shader Garden — wave-4 §3 (attribution/provenance) acceptance tests.
// Usage: node tools/test/garden-attribution.mjs   (pure Node, no browser —
// no puppeteer dependency needed, same shape as garden-wgsl-parity.mjs).
//
// Covers §3's acceptance lines #1 and #2 — the "never fabricate" enforcement:
//   1. Every attribution.json entry (component OR variant) with
//      kind:"evolved" has a `sourceKernel` that resolves in kernels.json.
//      A dangling reference is a TEST FAILURE, not a silent blank.
//   2. Every parsed scene.glsl component id has a corresponding
//      attribution.json `components` entry — catches a NEW component
//      landing without an attribution decision, forcing the choice at
//      review time instead of silently defaulting to "handmade".
// Plus schema-shape checks that back the same "never fabricate" rule:
//   3. `kind` is always exactly "evolved" or "handmade" — no third value.
//   4. Every "evolved" entry HAS a `sourceKernel` (the enum alone doesn't
//      guarantee the field exists).
// Prints "all-PASS" and exits 0 only if every check passed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseScene } from '../../site/js/organs/garden/parse.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCENE_PATH = join(ROOT, 'site/assets/garden/scene.glsl');
const ATTRIB_PATH = join(ROOT, 'site/assets/garden/attribution.json');
const KERNELS_PATH = join(ROOT, 'site/assets/kernels.json');

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok ? '' : `\n      ${detail || ''}`));
  if (!ok) failed = true;
  return ok;
}

const sceneSrc = readFileSync(SCENE_PATH, 'utf8');
const { components } = parseScene(sceneSrc);
const attribution = JSON.parse(readFileSync(ATTRIB_PATH, 'utf8'));
const kernels = JSON.parse(readFileSync(KERNELS_PATH, 'utf8'));
const kernelIds = new Set(kernels.kernels.map((k) => k.id));

const attribComponents = attribution.components || {};
const attribVariants = attribution.variants || {};

// Flatten every (label, entry) pair across both `components` and `variants`
// so the schema checks (kind enum, evolved-requires-sourceKernel,
// sourceKernel-resolves) run uniformly over the whole file.
const entries = [];
for (const [id, entry] of Object.entries(attribComponents)) {
  entries.push({ label: `components.${id}`, entry });
}
for (const [componentId, variantMap] of Object.entries(attribVariants)) {
  for (const [variantId, entry] of Object.entries(variantMap)) {
    entries.push({ label: `variants.${componentId}.${variantId}`, entry });
  }
}

check('attribution.json has at least one entry', entries.length > 0, 'file is empty or malformed');

for (const { label, entry } of entries) {
  check(`${label}: kind is "evolved" or "handmade"`, entry.kind === 'evolved' || entry.kind === 'handmade',
    `kind=${JSON.stringify(entry.kind)}`);
  if (entry.kind === 'evolved') {
    check(`${label}: evolved entry has sourceKernel`, typeof entry.sourceKernel === 'string' && entry.sourceKernel.length > 0,
      `sourceKernel=${JSON.stringify(entry.sourceKernel)}`);
    if (entry.sourceKernel) {
      // §3 acceptance #1 — the "never fabricate" enforcement: a dangling
      // sourceKernel is a hard failure, not a silent blank.
      check(`${label}: sourceKernel "${entry.sourceKernel}" resolves in kernels.json`,
        kernelIds.has(entry.sourceKernel), `known ids include: ${[...kernelIds].slice(0, 5).join(', ')}...`);
    }
  }
}

// §3 acceptance #2 — the opposite direction: every parsed component must
// have made an attribution decision. A new component landing with no entry
// fails loudly here rather than silently rendering as "handmade" by default.
for (const c of components) {
  check(`component "${c.id}" has an attribution.json entry`, Object.prototype.hasOwnProperty.call(attribComponents, c.id),
    `parsed from scene.glsl but missing from attribution.json's "components"`);
}

// And the reverse of #2 for hygiene: an attribution.json entry for a
// component id that no longer exists in scene.glsl is stale data, not a
// fabrication risk, but still worth flagging so the file gets cleaned up
// the same review cycle a component is removed.
const componentIds = new Set(components.map((c) => c.id));
for (const id of Object.keys(attribComponents)) {
  check(`attribution.json component "${id}" still exists in scene.glsl`, componentIds.has(id),
    'stale entry — component was removed from scene.glsl');
}

console.log(failed ? '\nFAIL' : '\nall-PASS');
process.exit(failed ? 1 : 0);
