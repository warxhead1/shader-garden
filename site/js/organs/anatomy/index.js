// Shader Garden — organs/anatomy/index.js
// "overlay" organ (v2 substrate SUB-5, substrate.md §8). Opened by Shift+A
// or `bus.emit('organ.open.v1', {organ:'anatomy'})` — both paths live in
// core/boot.js's one shared keydown listener, guarded there against
// input/textarea/CodeMirror focus. This module holds no state of its own
// and is not fetched until one of those fires (network-panel-verifiable,
// tools/test/anatomy.mjs): pure projection of (organs.json, the bus ring
// buffer, layout.json). Deleting this file's organs.json entry removes the
// whole feature — the proof the substrate didn't special-case it (§8.2).

import { el, clear } from '../../dom.js';
import { snapshot as layoutSnapshot, resetLayout } from '../../core/layout.js';
import { downloadJson } from '../../share.js';

function sourceOrgan(source) {
  const m = /^\/garden\/([^/]+)$/.exec(source || '');
  return m ? m[1] : null;
}

// Every declared emits[]->consumes[] intersection across organs.json is the
// manifest's CLAIM about the graph — one edge per (fromOrgan, type,
// toOrgan). `"*"` consumers (overlay organs) match every emitted type.
// Whether each claim is TRUE this session is what the live tap + recent()
// backfill below finds out: unconfirmed edges render dashed (§8.2 — the
// manifest-lie audit made visible).
function buildEdges(organs) {
  const edges = [];
  for (const from of organs) {
    for (const type of from.emits || []) {
      for (const to of organs) {
        if (to.id === from.id) continue;
        const consumes = to.consumes || [];
        if (consumes.includes(type) || consumes.includes('*')) edges.push({ from: from.id, to: to.id, type });
      }
    }
  }
  return edges;
}

export async function mount(ctx) {
  const { root, bus } = ctx;
  clear(root);
  let disposed = false;

  // Own fetch, deliberately: ctx only ever carries THIS organ's manifest
  // entry (substrate §3.2's frozen ctx), and the full roster is what the
  // graph needs. organs.json is ~1 KiB and already SW-precached.
  let organs = [];
  try {
    const res = await fetch('assets/organs.json');
    organs = res.ok ? ((await res.json()).organs || []) : [];
  } catch { /* offline — graph renders empty, never brick the overlay */ }
  if (disposed || !ctx.alive()) return function cleanup() {};

  const overlay = el('div', 'anatomy-overlay glass');
  const head = el('div', 'anatomy-head');
  head.append(el('h2', null, 'Anatomy'));
  const closeBtn = el('button', 'anatomy-close btn', 'Close (Esc)');
  closeBtn.type = 'button';
  head.append(closeBtn);
  overlay.append(head);
  const body = el('div', 'anatomy-body');
  overlay.append(body);
  root.append(overlay);

  function requestClose() { bus.emit('organ.open.v1', { organ: ctx.manifest.id }); }
  closeBtn.addEventListener('click', requestClose);
  function onKey(e) { if (e.key === 'Escape') requestClose(); }
  window.addEventListener('keydown', onKey);

  /* ---------- 1) organ graph ---------- */
  const graphSection = el('section', 'anatomy-section');
  graphSection.append(el('h3', null, 'Organs'));
  const graphWrap = el('div', 'anatomy-graph-wrap');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'anatomy-edges');
  const cardRow = el('div', 'anatomy-cards');
  graphWrap.append(svg, cardRow);
  graphSection.append(graphWrap);
  body.append(graphSection);

  const cardEls = new Map();   // organId -> card
  const stateEls = new Map();  // organId -> state <span>
  const mounted = new Set();   // organId currently "loaded+mounted"
  const loaded = new Set();    // organId ever opened this session

  function tags(className, values) {
    const wrap = el('div', className);
    for (const v of values || []) wrap.append(el('span', 'anatomy-chip', v));
    return wrap;
  }

  for (const organ of organs) {
    const card = el('div', 'anatomy-card glass');
    card.append(el('div', 'anatomy-card-id', organ.id));
    card.append(el('div', 'anatomy-card-payload', organ.payload || 'surface'));
    if ((organ.routes || []).length) card.append(el('div', 'anatomy-card-routes', organ.routes.join(', ')));
    card.append(tags('anatomy-card-caps', organ.caps));
    card.append(tags('anatomy-card-emits', (organ.emits || []).map((t) => '→ ' + t)));
    card.append(tags('anatomy-card-consumes', (organ.consumes || []).map((t) => '← ' + t)));
    const state = el('div', 'anatomy-card-state', 'cold');
    card.append(state);
    cardRow.append(card);
    cardEls.set(organ.id, card);
    stateEls.set(organ.id, state);
  }

  const edges = buildEdges(organs);
  const edgeEls = new Map(); // "from|type|to" -> <line>
  for (const edge of edges) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('class', 'anatomy-edge anatomy-edge-dashed');
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = edge.from + ' → ' + edge.type + ' → ' + edge.to;
    line.append(title);
    svg.append(line);
    edgeEls.set(edge.from + '|' + edge.type + '|' + edge.to, line);
  }

  function cardCenter(id) {
    const card = cardEls.get(id);
    if (!card) return null;
    const c = card.getBoundingClientRect(), w = graphWrap.getBoundingClientRect();
    return { x: c.left - w.left + c.width / 2, y: c.top - w.top + c.height / 2 };
  }

  function layoutEdges() {
    svg.setAttribute('viewBox', `0 0 ${graphWrap.clientWidth} ${graphWrap.clientHeight}`);
    for (const edge of edges) {
      const line = edgeEls.get(edge.from + '|' + edge.type + '|' + edge.to);
      const a = cardCenter(edge.from), b = cardCenter(edge.to);
      if (!line || !a || !b) continue;
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    }
  }
  // Two rAFs: cards lay out via CSS flex-wrap, which can still be settling
  // (font metrics, wrap point) after just one frame — the first edge draw
  // must see the SAME geometry the user does.
  requestAnimationFrame(() => requestAnimationFrame(layoutEdges));
  window.addEventListener('resize', layoutEdges);

  const litTimers = new Map();
  function lightEdge(from, type) {
    for (const edge of edges) {
      if (edge.from !== from || edge.type !== type) continue;
      const key = edge.from + '|' + edge.type + '|' + edge.to;
      const line = edgeEls.get(key);
      if (!line) continue;
      line.classList.remove('anatomy-edge-dashed');
      line.classList.add('anatomy-edge-lit');
      clearTimeout(litTimers.get(key));
      litTimers.set(key, setTimeout(() => line.classList.remove('anatomy-edge-lit'), 1000));
    }
  }

  function markState(id, next) {
    const s = stateEls.get(id);
    if (s) s.textContent = next;
    const card = cardEls.get(id);
    if (card) card.classList.toggle('anatomy-card-mounted', next === 'loaded+mounted');
  }

  /* ---------- 2) event log ---------- */
  const logSection = el('section', 'anatomy-section');
  logSection.append(el('h3', null, 'Event log'));
  const filterInput = el('input', 'anatomy-filter');
  filterInput.type = 'search';
  filterInput.placeholder = 'filter by type or source…';
  logSection.append(filterInput);
  const logList = el('div', 'anatomy-log-list');
  logSection.append(logList);
  body.append(logSection);

  const MAX_ROWS = 256; // mirrors the bus's own ring — the log never grows past it
  function matchesFilter(type, source) {
    const q = filterInput.value.trim().toLowerCase();
    return !q || type.toLowerCase().includes(q) || source.toLowerCase().includes(q);
  }
  function addRow(envelope) {
    const row = el('div', 'anatomy-log-row');
    row.hidden = !matchesFilter(envelope.type, envelope.source);
    row.dataset.type = envelope.type;
    row.dataset.source = envelope.source;
    const head2 = el('div', 'anatomy-log-head');
    head2.append(el('span', 'anatomy-log-time', envelope.time.slice(11, 23)));
    head2.append(el('span', 'anatomy-log-type', envelope.type));
    head2.append(el('span', 'anatomy-log-source', envelope.source));
    const pre = el('pre', 'anatomy-log-data');
    pre.textContent = JSON.stringify(envelope.data, null, 2);
    pre.hidden = true;
    head2.addEventListener('click', () => { pre.hidden = !pre.hidden; });
    row.append(head2, pre);
    logList.prepend(row);
    while (logList.children.length > MAX_ROWS) logList.lastChild.remove();
  }
  filterInput.addEventListener('input', () => {
    for (const row of logList.children) row.hidden = !matchesFilter(row.dataset.type, row.dataset.source);
  });

  function handle(envelope) {
    addRow(envelope);
    const from = sourceOrgan(envelope.source);
    if (from) lightEdge(from, envelope.type);
    const oid = envelope.data && envelope.data.organ;
    if (envelope.type === 'organ.opened.v1' && oid) { loaded.add(oid); mounted.add(oid); markState(oid, 'loaded+mounted'); }
    if (envelope.type === 'organ.closed.v1' && oid) { mounted.delete(oid); markState(oid, loaded.has(oid) ? 'loaded' : 'cold'); }
  }

  for (const envelope of bus.recent()) handle(envelope); // catch-up, substrate §4.3 — late mounts read the ring
  const untap = bus.tap(handle);

  /* ---------- 3) layout inspector ---------- */
  const layoutSection = el('section', 'anatomy-section');
  layoutSection.append(el('h3', null, 'Layout'));
  const layoutArea = el('textarea', 'anatomy-layout-json');
  const snap = layoutSnapshot();
  layoutArea.value = JSON.stringify((snap && snap.prefs) || {}, null, 2);
  layoutSection.append(layoutArea);
  const layoutRow = el('div', 'anatomy-layout-actions');
  const applyBtn = el('button', 'btn', 'Apply prefs');
  applyBtn.type = 'button';
  const resetBtn = el('button', 'btn anatomy-reset', 'Reset layout');
  resetBtn.type = 'button';
  const layoutMsg = el('span', 'anatomy-layout-msg', '');
  layoutRow.append(applyBtn, resetBtn, layoutMsg);
  layoutSection.append(layoutRow);
  body.append(layoutSection);

  applyBtn.addEventListener('click', () => {
    let parsed;
    try { parsed = JSON.parse(layoutArea.value); }
    catch { layoutMsg.textContent = 'invalid JSON — not applied'; return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { layoutMsg.textContent = 'expected a JSON object'; return; }
    for (const [k, v] of Object.entries(parsed)) ctx.layout.setPref(k, v);
    layoutMsg.textContent = 'applied';
  });
  // A full reload is the honest way to un-stick every already-mounted
  // organ's own `ctx.layout.prefs` reference (layout.js's `cached` object
  // identity changes on reset) — same "never brick, just restart clean"
  // rule as a corrupt diff (substrate §5.3).
  resetBtn.addEventListener('click', () => { resetLayout(); location.reload(); });

  /* ---------- 4) operator export (ADM-D) ---------- */
  // `?operator=1` — a real query-string flag (survives hash routing), the
  // author's-own-machine switch admission design §7.3 names. Nothing here
  // runs, and admission's ~21 KB module never loads, unless this exact
  // button is clicked — a gallery/anatomy visitor who never sets the flag
  // pays zero cost for this section (it doesn't even exist in the DOM).
  if (new URLSearchParams(location.search).get('operator') === '1') {
    const opSection = el('section', 'anatomy-section');
    opSection.append(el('h3', null, 'Operator'));
    const exportBtn = el('button', 'btn', 'Export admission ring (JSON)');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', async () => {
      const { recentAdmissions } = await import(new URL('../admission/index.js', import.meta.url).href);
      downloadJson('admission-ring.json', recentAdmissions());
    });
    opSection.append(exportBtn);
    body.append(opSection);
  }

  return function cleanup() {
    disposed = true;
    untap();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', layoutEdges);
    for (const t of litTimers.values()) clearTimeout(t);
    overlay.remove();
  };
}
