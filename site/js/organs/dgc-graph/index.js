// Shader Garden — organs/dgc-graph/index.js (wave-4 Area E)
// "overlay" organ, Shift+D (mirrors anatomy's Shift+A pattern exactly —
// boot.js's overlay activation keys off organs.json's payload:"overlay" +
// hotkey fields generically, so this second overlay organ needed zero
// boot.js changes). Own fetch + own parse: it re-derives its graph by
// fetching scene.glsl and running the SAME parseScene()/analyzeConnections()
// the garden organ already uses for its probe/connections features — a
// fresh, independent read, never a shared live reference into a mounted
// garden organ (this overlay works even when #/garden isn't the active
// route).
//
// v1 scope (wave-4 blueprint §5): a TEACHING visualization of this one
// fragment shader's own function-call/shared-const structure, relabeled in
// tengine's work-type vocabulary (name/category/kind/depends/reads/writes —
// see ~/projects/tengine/_plans/UNIFIED_WORK_TYPE_MANIFEST.md). This is NOT
// a live tengine connection and NOT a DGC executor — the disclaimer below is
// load-bearing, not decoration (tools/test/dgc-graph.mjs asserts its text).

import { el, clear } from '../../dom.js';
import { parseScene } from '../garden/parse.js';
import { analyzeConnections } from '../garden/connections.js';

// Hand-honored invariant, same discipline scene.glsl's own COMP_* id-order
// comment already requires: mirrors sg_march's literal per-step evaluation
// order (dTerrain, dChar, dPond, dRock, in that source order). If sg_march's
// own order ever changes, update this list deliberately — dgc-graph.mjs
// pins it as a regression, not a live re-derivation from scene.glsl.
const MARCH_DISPATCH_ORDER = ['terrain', 'character', 'pond', 'rocks'];

const NON_GOAL_LINE = 'v1: a visualization of this garden scene\'s own structure in tengine\'s vocabulary. Not a live tengine connection, not a DGC executor, no vkCmdDispatchIndirect involved.';

const EXPLAINER_LINES = [
  'In tengine, a "work type" is one GPU dispatch (compute / graphics / mesh) that declares which buffers it reads and writes; the orchestrator schedules dispatches by those declared dependencies, not by hand-written order.',
  'This garden scene has no separate dispatches at all — it is ONE fragment shader. A GLSL function call below (solid arrow) stands in for a real cross-dispatch buffer READ; a shared top-level const/uniform (dashed arrow) stands in for a real shared BUFFER one work type WRITES and another READS. This is a simplified stand-in, not a real buffer producer/consumer edge.',
];

export async function mount(ctx) {
  const { root, bus } = ctx;
  clear(root);
  let disposed = false;

  let nodes = [], edges = [];
  try {
    const res = await fetch('assets/garden/scene.glsl');
    if (res.ok) {
      const { components } = parseScene(await res.text());
      ({ nodes, edges } = analyzeConnections(components));
    }
  } catch { /* offline — overlay renders with an empty graph, never throws */ }
  if (disposed || !ctx.alive()) return function cleanup() {};

  const overlay = el('div', 'dgc-overlay glass');
  const head = el('div', 'dgc-head');
  head.append(el('h2', null, 'DGC / producer-consumer (teaching view)'));
  const closeBtn = el('button', 'dgc-close btn', 'Close (Esc)');
  closeBtn.type = 'button';
  head.append(closeBtn);
  overlay.append(head, el('p', 'dgc-nongoal', NON_GOAL_LINE));
  for (const line of EXPLAINER_LINES) overlay.append(el('p', 'dgc-explainer', line));
  const body = el('div', 'dgc-body');
  overlay.append(body);
  root.append(overlay);

  function requestClose() { bus.emit('organ.open.v1', { organ: ctx.manifest.id }); }
  closeBtn.addEventListener('click', requestClose);
  function onKey(e) { if (e.key === 'Escape') requestClose(); }
  window.addEventListener('keydown', onKey);

  /* ---------- work-type graph ---------- */
  const graphSection = el('section', 'dgc-section');
  graphSection.append(el('h3', null, 'Work types (garden components)'));
  const graphWrap = el('div', 'dgc-graph-wrap');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'dgc-edges');
  const cardRow = el('div', 'dgc-cards');
  graphWrap.append(svg, cardRow);
  graphSection.append(graphWrap);
  body.append(graphSection);

  const cardEls = new Map();
  for (const node of nodes) {
    const category = MARCH_DISPATCH_ORDER.includes(node.id) ? 'geometry' : 'shading';
    const card = el('div', 'dgc-card glass');
    card.dataset.node = node.id;
    card.append(el('div', 'dgc-card-id', node.id));
    card.append(el('div', 'dgc-card-meta', `category: ${category} · kind: fragment-stage`));
    if (node.consts.length) card.append(el('div', 'dgc-card-writes', 'writes: ' + node.consts.join(', ')));
    const reads = [...new Set(edges.filter((e) => e.from === node.id && e.kind === 'const').map((e) => e.symbol))];
    if (reads.length) card.append(el('div', 'dgc-card-reads', 'reads: ' + reads.join(', ')));
    const depends = [...new Set(edges.filter((e) => e.from === node.id && e.kind === 'call').map((e) => e.to))];
    if (depends.length) card.append(el('div', 'dgc-card-depends', 'depends: ' + depends.join(', ')));
    cardRow.append(card);
    cardEls.set(node.id, card);
  }

  const edgeEls = [];
  for (const edge of edges) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('class', 'dgc-edge ' + (edge.kind === 'call' ? 'dgc-edge-call' : 'dgc-edge-const'));
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${edge.from} → ${edge.to} (${edge.kind}: ${edge.symbol})`;
    line.append(title);
    svg.append(line);
    edgeEls.push({ edge, line });
  }

  function cardCenter(id) {
    const card = cardEls.get(id);
    if (!card) return null;
    const c = card.getBoundingClientRect(), w = graphWrap.getBoundingClientRect();
    return { x: c.left - w.left + c.width / 2, y: c.top - w.top + c.height / 2 };
  }
  function layoutEdges() {
    svg.setAttribute('viewBox', `0 0 ${graphWrap.clientWidth} ${graphWrap.clientHeight}`);
    for (const { edge, line } of edgeEls) {
      const a = cardCenter(edge.from), b = cardCenter(edge.to);
      if (!a || !b) continue;
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    }
  }
  // Two rAFs, same reason anatomy's own layoutEdges scheduling gives: the
  // card row lays out via CSS flex-wrap, which can still be settling one
  // frame after mount.
  requestAnimationFrame(() => requestAnimationFrame(layoutEdges));
  window.addEventListener('resize', layoutEdges);

  /* ---------- per-frame dispatch order ---------- */
  const dispatchSection = el('section', 'dgc-section');
  dispatchSection.append(el('h3', null, 'Per-frame dispatch order'));
  dispatchSection.append(el('p', 'dgc-dispatch-note',
    'tengine schedules work types by declared depends edges and dispatch_policy; this scene has one fixed hand-written order instead — CPU-authored, not GPU-scheduled. A future wave could make this data-driven the way tengine does.'));
  const ol = el('ol', 'dgc-dispatch-list');
  for (const id of MARCH_DISPATCH_ORDER) ol.append(el('li', 'dgc-dispatch-item', id));
  dispatchSection.append(ol);
  body.append(dispatchSection);

  return function cleanup() {
    disposed = true;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', layoutEdges);
    overlay.remove();
  };
}
