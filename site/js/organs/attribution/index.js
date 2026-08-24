// Shader Garden — organs/attribution/index.js
// "/attribution" organ (wave-4 §3). A plain data/text page — no GPU, no
// canvas — making "where did this come from" a first-class, linked-to page
// instead of prose buried in README.md or scattered across probe panels.
//
// Three sections, each reusing data this site already computes elsewhere
// rather than inventing a second shape for the same facts:
//   1. Every gallery kernel, grouped by `origin` (kernels.json's own field,
//      the same one organs/provenance/index.js reads for its license line).
//   2. The garden's own components + terrain variants, read from
//      assets/garden/attribution.json via organs/garden/attribution.js —
//      the SAME module the probe panel's Origin block uses, so this page
//      and that panel can never disagree about a component's kind.
//   3. A short pipeline explainer, lifted from README.md's "How the kernels
//      are grown" section (already accurate, just not linked from the app).
//
// Component kind/source here NEVER re-renders a kernel's own lineage detail
// (fitness/generation/eval-run) — clicking through to #/s/<id> lands on the
// existing provenance panel for that, same "don't duplicate the data" rule
// the panel's Origin block follows.

import { el, clear } from '../../dom.js';
import { parseScene } from '../garden/parse.js';
import { loadAttributionData } from '../garden/attribution.js';

const ORIGIN_LABELS = {
  vault: 'Vault — curated evolutionary picks',
  funsearch_evolved: 'FunSearch-evolved (this repo’s own runs)',
  // Read-compat only, never written. The old name said "evolved FROM
  // Shadertoy", which was never true — the upstream file was Shadertoy
  // FORMAT ("paste this into shadertoy.com"), not Shadertoy source. A
  // browser holding a cached kernels.json from before the rename still gets
  // the right label instead of the raw string. See THIRD-PARTY-NOTICES.md.
  shadertoy_evolved: 'FunSearch-evolved (this repo’s own runs)',
  handmade: 'Hand-authored',
};

function originLabel(origin) {
  return ORIGIN_LABELS[origin] || origin || 'unknown';
}

function kernelLink(id, title) {
  const a = el('a', 'attrib-kernel-link', title || id);
  a.href = '#/s/' + encodeURIComponent(id);
  return a;
}

function renderKernelSection(kernels) {
  const section = el('section', 'attrib-section');
  section.append(el('h2', null, 'Gallery kernels'));
  section.append(el('p', 'muted', kernels.length + ' kernels, grouped by where they came from.'));

  const groups = new Map();
  for (const k of kernels) {
    const origin = k.origin || 'unknown';
    if (!groups.has(origin)) groups.set(origin, []);
    groups.get(origin).push(k);
  }
  // Deterministic group order: vault, funsearch_evolved, handmade, then
  // anything else alphabetically — matches the order GALLERY_ORIGINS is
  // declared in organs/provenance/index.js.
  const order = ['vault', 'funsearch_evolved', 'handmade'];
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  for (const origin of keys) {
    const list = groups.get(origin);
    const group = el('div', 'attrib-group');
    group.append(el('h3', null, originLabel(origin) + ' (' + list.length + ')'));
    const ul = el('ul', 'attrib-kernel-list');
    for (const k of list.sort((a, b) => a.id.localeCompare(b.id))) {
      const li = el('li', null, null);
      li.append(kernelLink(k.id, k.title || k.id));
      if (k.fitness != null) li.append(el('span', 'muted', ' · fit ' + Number(k.fitness).toFixed(4)));
      ul.append(li);
    }
    group.append(ul);
    section.append(group);
  }
  return section;
}

function renderGardenSection(components, attribution) {
  const section = el('section', 'attrib-section');
  section.append(el('h2', null, 'The garden'));
  section.append(el('p', 'muted',
    'Every component in the #/garden diorama, honestly split into the two provenance categories that actually exist: ' +
    'evolved (a real FunSearch kernel this component was lifted from) or hand-authored (written directly for the garden — no prompt/model record exists for these, and none is invented here).'));

  const ul = el('ul', 'attrib-component-list');
  const attribComponents = (attribution && attribution.components) || {};
  for (const c of components) {
    const entry = attribComponents[c.id];
    const li = el('li', 'attrib-component');
    li.append(el('span', 'attrib-component-name', c.name));
    if (entry && entry.kind === 'evolved') {
      li.append(el('span', 'probe-origin-badge probe-origin-evolved', 'Evolved'));
      li.append(document.createTextNode(' from '), kernelLink(entry.sourceKernel));
    } else {
      li.append(el('span', 'probe-origin-badge probe-origin-handmade', 'Hand-authored'));
    }
    if (entry && entry.note) li.append(el('p', 'attrib-component-note', entry.note));
    ul.append(li);
  }
  section.append(ul);

  const variants = (attribution && attribution.variants) || {};
  const variantComponentIds = Object.keys(variants);
  if (variantComponentIds.length) {
    section.append(el('h3', null, 'Terrain variants'));
    const vul = el('ul', 'attrib-variant-list');
    for (const componentId of variantComponentIds) {
      for (const [variantId, entry] of Object.entries(variants[componentId])) {
        const li = el('li', 'attrib-variant');
        li.append(el('span', 'attrib-component-name', componentId + ' → ' + variantId));
        if (entry.kind === 'evolved') {
          li.append(el('span', 'probe-origin-badge probe-origin-evolved', 'Evolved'));
          li.append(document.createTextNode(' from '), kernelLink(entry.sourceKernel));
        } else {
          li.append(el('span', 'probe-origin-badge probe-origin-handmade', 'Hand-authored'));
        }
        vul.append(li);
      }
    }
    section.append(vul);
  }
  return section;
}

// Lifted near-verbatim from README.md's "How the kernels are grown" —
// already accurate prose, just not reachable from inside the app itself.
function renderPipelineSection() {
  const section = el('section', 'attrib-section');
  section.append(el('h2', null, 'How the kernels are grown'));
  const p1 = el('p', null, 'Kernels are evolved offline with an island-model evolutionary loop: multiple isolated populations mutate candidate shader programs in parallel, and periodic migration between islands keeps diversity up and prevents premature convergence on a local optimum.');
  const p2 = el('p', null, 'Every candidate is scored by a deterministic oracle, not a human — eikonal validity for SDFs, heightfield statistics for terrain, physics coherence (conservation/continuity) for phase, latent-heat, and SPH kernels. Winning kernels are baked into kernels.json with their fitness score and, where the run recorded it, generation and run-id lineage.');
  const p3 = el('p', null, 'The garden (#/garden) puts one evolved terrain kernel into a raymarched diorama alongside a bouncing hand-authored SDF character — click anything to see its exact source, nudge its live tunable sliders, and see this page’s Origin badge for exactly how it got there.');
  section.append(p1, p2, p3);
  return section;
}

export async function mount(ctx) {
  const { root, registry } = ctx;
  clear(root);

  const page = el('div', 'attrib-page');
  const back = el('a', 'btn btn-small btn-ghost', '← gallery');
  back.href = '#/';
  page.append(back);
  page.append(el('h1', null, 'Attribution & provenance'));
  page.append(el('p', 'attrib-intro',
    'Where every shader in this gallery actually came from — evolved by FunSearch, curated from the vault, or written by hand. Nothing here is guessed: an "evolved" entry always resolves to a real kernel with real fitness data; "hand-authored" never pretends to know an author or model that was never recorded.'));

  let data, attribution, sceneSrc;
  try {
    [data, attribution, sceneSrc] = await Promise.all([
      registry.load(),
      loadAttributionData(),
      fetch('assets/garden/scene.glsl').then((r) => (r.ok ? r.text() : '')).catch(() => ''),
    ]);
  } catch {
    if (!ctx.alive()) return () => {};
    page.append(el('p', 'muted', 'Could not load attribution data.'));
    root.append(page);
    return function cleanup() { root.replaceChildren(); };
  }
  if (!ctx.alive()) return () => {};

  const components = sceneSrc ? parseScene(sceneSrc).components : [];

  page.append(renderKernelSection(data.kernels || []));
  page.append(renderGardenSection(components, attribution));
  page.append(renderPipelineSection());

  root.append(page);
  return function cleanup() { root.replaceChildren(); };
}
