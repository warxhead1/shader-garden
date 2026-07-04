// Shader Garden — organs/provenance/index.js
// "panel" organ (v2 substrate SUB-4). Extraction of organs/viewer/index.js's
// inline meta panel (itself extracted from v1's app.js:237-265). Placed by
// assets/layout.json's `placements` list, not a route — removing that
// placement entry means this module is never import()ed (idle-costs-zero
// applies to panels too, substrate §3.3).
//
// Initial paint uses ctx.params (the route params captured when the
// placement activates) + ctx.registry.load() — the same lookup the viewer
// itself does. Live updates while this panel stays mounted across a
// same-placement re-navigation (e.g. /s/a -> /s/b: 'provenance' is wanted by
// both, so the loader never unmounts it, but this panel's own ctx.params is
// now stale) come from kernel.opened.v1, which the viewer emits on every
// kernel resolution regardless of whether this panel is new or already up.
//
// COMP-1 (v2 §7.3 item 24): a second render path, renderComposition(), for
// composition.opened.v1 — the pass graph. Each node deep-links to
// #/s/<kernel>, which re-enters this same organ on renderKernel() and shows
// THAT kernel's own lineage — "own lineage" per the accept criterion is this
// path, not a second recursive graph.

import { el, clear } from '../../dom.js';

// Every origin kernels.json ships today (see ARCHITECTURE.md's schema) is
// curated INTO this repo under its own MIT license (LICENSE) — vault,
// handmade, and shadertoy_evolved are the only three that reach kernels.json
// (bake_kernels.py's gate). Anything else reaching this panel is, by
// construction, source the repo does not hold the rights to license itself
// — a foreign/share-link feed (v2 blueprint §7.1 demand adjustment #8). The
// panel names that honestly instead of implying a license it can't vouch
// for.
const GALLERY_ORIGINS = new Set(['vault', 'handmade', 'shadertoy_evolved']);

function licenseFor(kernel) {
  return kernel && GALLERY_ORIGINS.has(kernel.origin) ? 'MIT (Shader Garden gallery)' : "author's own";
}

// ============================================================================
// SUB-6 — lineage block (v2 blueprint work item 19). Self-contained: reads
// `kernel.lineage` (bake_kernels.py-authored: parents/oracle/eval_run_id/
// preadmit/gen_diff — see ARCHITECTURE.md's "kernels.json lineage" section)
// and renders whatever subset is non-null. Never throws on a missing or
// partial block — most kernels' `lineage` is mostly-null by construction
// (the vault genuinely lacks most of these facts for most kernels), and
// that's the expected common case, not an error state. Kept as one
// standalone function + one call site to minimize merge surface against the
// concurrent COMP-1 pass-graph work on this same file.
// ============================================================================
function hasLineageContent(lineage) {
  if (!lineage) return false;
  const nonEmpty = (v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  return nonEmpty(lineage.parents) || nonEmpty(lineage.oracle) || nonEmpty(lineage.eval_run_id) ||
    nonEmpty(lineage.preadmit) || nonEmpty(lineage.gen_diff);
}

function renderGenDiff(gen_diff) {
  const bits = [];
  if (gen_diff.prev_generation != null) bits.push('vs gen ' + gen_diff.prev_generation);
  if (gen_diff.fitness_delta != null) {
    const d = Number(gen_diff.fitness_delta);
    bits.push((d >= 0 ? '+' : '') + d.toFixed(4) + ' fitness');
  }
  if (gen_diff.lines_added != null || gen_diff.lines_removed != null) {
    bits.push(`+${gen_diff.lines_added ?? 0}/-${gen_diff.lines_removed ?? 0} lines`);
  }
  if (gen_diff.similarity != null) bits.push(Math.round(gen_diff.similarity * 100) + '% similar');
  return bits.join(', ');
}

// `knownIds`: a Set of every kernel id in the current roster, or null before
// the roster has loaded — used to decide parent-link vs. plain-text (SUB-6
// accept: "renders parents as #/s/ links when the parent id resolves in
// kernels.json, plain text otherwise"). Curation collapses most evolutionary
// runs to a single survivor, so a NON-resolving parent is the common case,
// not a bug.
function renderLineage(panelBody, kernel, knownIds) {
  const lineage = kernel && kernel.lineage;
  if (!hasLineageContent(lineage)) return;

  const section = el('section', 'meta-lineage');
  section.append(el('h3', 'meta-lineage-title', 'Lineage'));
  // Deliberately its own class, not `.meta-list` — the main panel body's
  // `dl.meta-list` is queried by other tests/CSS as "the" meta list; a
  // shared class would fold this dl into that selector's matches too.
  const dl = el('dl', 'meta-list meta-lineage-list');
  const row = (label, node) => {
    if (node == null) return;
    const dd = el('dd', null, null);
    if (node instanceof Node) dd.append(node); else dd.textContent = String(node);
    dl.append(el('dt', null, label), dd);
  };

  if (Array.isArray(lineage.parents) && lineage.parents.length) {
    const wrap = el('span', 'meta-parents', null);
    lineage.parents.forEach((pid, i) => {
      if (i > 0) wrap.append(document.createTextNode(', '));
      if (knownIds && knownIds.has(pid)) {
        const a = el('a', null, pid);
        a.href = '#/s/' + pid;
        wrap.append(a);
      } else {
        wrap.append(document.createTextNode(pid + ' (not in gallery)'));
      }
    });
    row('parents', wrap);
  }
  row('eval run', lineage.eval_run_id);
  row('oracle', lineage.oracle);
  if (lineage.preadmit) row('preadmit', typeof lineage.preadmit === 'string' ? lineage.preadmit : JSON.stringify(lineage.preadmit));
  if (lineage.gen_diff) row('gen diff', renderGenDiff(lineage.gen_diff));

  if (!dl.childElementCount) return; // hasLineageContent() can be true with every row still filtered by `row()`'s own null guard
  section.append(dl);
  panelBody.append(section);
}

export async function mount(ctx) {
  const { root, bus, registry, layout } = ctx;
  clear(root);
  let disposed = false;

  const panel = el('aside', 'meta-panel glass');
  const panelHead = el('div', 'meta-head');
  const title = el('h2', 'meta-title', '');
  const collapseBtn = el('button', 'collapse-btn', '–');
  collapseBtn.type = 'button';
  panelHead.append(title, collapseBtn);
  const panelBody = el('div', 'meta-body');
  panel.append(panelHead, panelBody);
  panel.hidden = true; // unhidden by render() once a kernel resolves
  root.append(panel);

  // Collapse state survives reload via ctx.layout.setPref (v1 pain P10 —
  // v1's collapse was a transient DOM class, lost on every refresh).
  const collapsed = !!(layout && layout.prefs && layout.prefs.provenance_collapsed);
  panel.classList.toggle('collapsed', collapsed);
  collapseBtn.textContent = collapsed ? '+' : '–';
  collapseBtn.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
  collapseBtn.addEventListener('click', () => {
    const next = panel.classList.toggle('collapsed');
    collapseBtn.textContent = next ? '+' : '–';
    collapseBtn.setAttribute('aria-label', next ? 'Expand panel' : 'Collapse panel');
    if (layout) layout.setPref('provenance_collapsed', next);
  });

  // SUB-6: full kernel roster once loaded, for the lineage block's parent-
  // link resolution. COMP-3 reuses the SAME map (a Map, not a Set — `.has()`
  // still works for SUB-6's membership check) for the pass-graph's per-node
  // fitness lookup instead of adding a second roster fetch.
  let kernelsById = null;

  function renderKernel(kernel) {
    if (!kernel) { panel.hidden = true; return; }
    panel.hidden = false;
    title.textContent = kernel.title || kernel.id;
    clear(panelBody);
    if (kernel.description) panelBody.append(el('p', 'meta-desc', kernel.description));
    const dl = el('dl', 'meta-list');
    const row = (label, value) => {
      if (value == null || value === '') return;
      dl.append(el('dt', null, label), el('dd', null, String(value)));
    };
    row('domain', kernel.domain);
    row('fitness', kernel.fitness != null ? Number(kernel.fitness).toFixed(4) : null);
    row('generation', kernel.generation);
    row('run', kernel.run_id);
    row('author', kernel.author);
    row('origin', kernel.origin);
    row('license', licenseFor(kernel));
    panelBody.append(dl);
    renderLineage(panelBody, kernel, kernelsById); // SUB-6
  }

  // COMP-1: the pass graph, one node per pass, each deep-linking to its
  // member kernel's own "/s/:id" — clicking through shows that kernel's own
  // lineage via renderKernel() above, reached the ordinary way. COMP-3:
  // each node also shows that MEMBER KERNEL's own `fitness` (straight from
  // the roster, never recomputed) when kernelsById has resolved it, plus a
  // composition-level oracle line when `data.provenance` (bake_compositions.
  // py's block) is present — both null-safe, both absent on the COMP-1 demo
  // composition (hand-authored, no oracle data of its own).
  function renderComposition(data) {
    panel.hidden = false;
    title.textContent = data.title || data.shader_id;
    clear(panelBody);
    if (data.description) panelBody.append(el('p', 'meta-desc', data.description));
    const prov = data.provenance;
    if (prov && prov.composition_fitness != null) {
      panelBody.append(el('p', 'meta-oracle',
        'composition oracle: fit ' + Number(prov.composition_fitness).toFixed(4) +
        ' (gate ' + prov.gate_threshold + ', ' + (prov.ready ? 'ready' : 'not ready') + ')'));
    }
    const list = el('ol', 'meta-graph');
    (data.passes || []).forEach((p) => {
      const item = el('li', 'meta-graph-node');
      const link = el('a', 'meta-graph-link', p.kernel);
      link.setAttribute('href', '#/s/' + encodeURIComponent(p.kernel));
      const targetLabel = p.target === 'screen' ? 'screen' : 'buffer "' + p.target + '"';
      const chans = (p.channels || []).length ? ' ← ' + p.channels.join(', ') : '';
      const detail = el('span', 'meta-graph-detail', ' → ' + targetLabel + chans + (p.feedback ? ' (feedback)' : ''));
      item.append(link, detail);
      const member = kernelsById && kernelsById.get(p.kernel);
      if (member && member.fitness != null) {
        item.append(el('span', 'meta-graph-fitness', ' · fit ' + Number(member.fitness).toFixed(4)));
      }
      list.append(item);
    });
    panelBody.append(list);
  }

  async function resolveById(id) {
    if (!id) { panel.hidden = true; return; }
    try {
      const data = await registry.load();
      if (disposed) return;
      kernelsById = new Map(data.kernels.map((k) => [k.id, k])); // SUB-6 + COMP-3
      const kernel = kernelsById.get(id);
      if (kernel) { renderKernel(kernel); return; }
      const comp = (data.compositions || []).find((c) => c.id === id);
      if (comp) renderComposition({ shader_id: comp.id, title: comp.title, description: comp.description, passes: comp.passes, provenance: comp.provenance });
      else panel.hidden = true;
    } catch {
      if (!disposed) panel.hidden = true;
    }
  }

  // COMP-3: the bus path (same-placement re-navigation, e.g. /s/a -> /s/comp)
  // may fire before this panel's own resolveById() has populated
  // kernelsById — fall back to registry.load() (memoized, so this is never
  // a second real fetch) so per-node fitness renders on that path too.
  async function onCompositionOpened(envelope) {
    if (!kernelsById) {
      try {
        const data = await registry.load();
        if (!disposed) kernelsById = new Map(data.kernels.map((k) => [k.id, k]));
      } catch { /* fitness stays absent — renderComposition is null-safe */ }
    }
    if (!disposed) renderComposition(envelope.data || {});
  }

  // Subscribe before the initial (possibly slow) resolve — an opened event
  // fired while this panel's own registry.load() is still in flight must not
  // be missed.
  const offKernel = bus.on('kernel.opened.v1', (envelope) => resolveById((envelope.data || {}).shader_id));
  const offComposition = bus.on('composition.opened.v1', onCompositionOpened);
  resolveById(ctx.params.get('id')); // not awaited — a panel never blocks the loader's activation on its own fetch

  return function cleanup() {
    disposed = true;
    offKernel();
    offComposition();
    panel.remove();
  };
}
