// GARDEN-IDE — organs/garden/tray.js
// The component tray: a collapsible left rail listing every parsed
// component, so components are touchable without pixel-hunting the canvas
// for the right raymarched surface. Pure DOM + a roving-tabindex keyboard
// list — index.js owns the probe/runtime wiring (openProbe, uProbeSel,
// recompiles); this module only calls back into it.
//
// Also hosts the per-component "uses / used by" connection affordances
// (connections.js's summarizeConnections output, passed in read-only — this
// module renders it, index.js/connections.js compute it).
import { el } from '../../dom.js';

/**
 * @param {{
 *   components: import('./parse.js').Component[],
 *   connections: Map<string, { uses: Array<{id,name,symbols}>, usedBy: Array<{id,name,symbols}> }>,
 *   onHover: (component: object|null) => void,           // null clears the canvas highlight
 *   onSelect: (component: object) => void,                 // click / Enter — opens the probe panel
 *   onNavigate: (componentId: string, symbol: string) => void,  // clicking a connection pill
 *   onHoverConnection: (componentId: string|null) => void,  // wave-3 §3a — hovering a connection pill
 *   onMeasure: () => Promise<void>,                        // work item 4 — explicit, never automatic
 * }}
 * @returns {{
 *   el: HTMLElement,
 *   setCost: (id: string, ms: number|null) => void,
 *   setEdited: (id: string, edited: boolean) => void,  // F2 — the "you changed this" chip
 *   destroy: () => void,
 * }}
 */
export function createComponentTray({ components, connections, onHover, onSelect, onNavigate, onHoverConnection, onMeasure }) {
  const tray = el('aside', 'garden-tray glass');
  const head = el('div', 'garden-tray-head');
  const toggle = el('button', 'garden-tray-toggle', '☰ Components');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'true');
  // Work item 4: per-component cost chips are measured only on this explicit
  // click (measure.js stubs one component at a time and re-times the scene —
  // never something to run behind the user's back on an idle page).
  const measureBtn = el('button', 'btn btn-small garden-tray-measure', 'Measure');
  measureBtn.type = 'button';
  measureBtn.title = 'Estimate each component’s per-frame cost: neutralize it, re-time the scene, report the delta';
  measureBtn.addEventListener('click', async () => {
    if (measureBtn.disabled) return;
    measureBtn.disabled = true;
    measureBtn.textContent = 'Measuring…';
    try { await onMeasure(); } finally {
      measureBtn.disabled = false;
      measureBtn.textContent = 'Measure';
    }
  });
  head.append(toggle, measureBtn);

  const list = el('ul', 'garden-tray-list');
  list.setAttribute('role', 'listbox');

  const costChips = new Map();
  const editedChips = new Map();
  const items = components.map((c, i) => {
    const li = el('li', 'garden-tray-item');
    li.setAttribute('role', 'option');
    li.tabIndex = i === 0 ? 0 : -1;

    const nameRow = el('div', 'garden-tray-item-name');
    nameRow.append(c.name);
    if (c.tunes.length) nameRow.append(el('span', 'garden-tray-item-count', `${c.tunes.length} tune${c.tunes.length > 1 ? 's' : ''}`));
    // F2: mirrors costChips exactly — hidden until index.js's
    // recompileWithBody says this component actually has a live edit (a
    // hand edit OR a non-pristine variant swap, same editedBodies truth).
    const editedChip = el('span', 'garden-tray-edited-chip', 'edited');
    editedChip.hidden = true;
    editedChips.set(c.id, editedChip);
    nameRow.append(editedChip);
    const cost = el('span', 'garden-tray-chip', '');
    costChips.set(c.id, cost);
    nameRow.append(cost);

    const blurb = el('p', 'garden-tray-item-blurb', c.blurb);
    li.append(nameRow, blurb);

    const conn = connections.get(c.id);
    if (conn && (conn.uses.length || conn.usedBy.length)) {
      const connRow = el('p', 'garden-tray-item-conn');
      const pill = (label, targets) => {
        const span = el('span', 'garden-tray-conn-group');
        span.append(label + ': ');
        targets.forEach((t, j) => {
          const a = el('a', 'garden-tray-conn-link', t.name);
          a.href = '#';
          a.title = t.symbols.join(', ');
          a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onNavigate(t.id, t.symbols[0]); });
          // wave-3 §3a: same uProbeSel rim-light the item's own hover uses
          // above — released back to whatever's actually probed on leave.
          a.addEventListener('mouseenter', () => onHoverConnection(t.id));
          a.addEventListener('mouseleave', () => onHoverConnection(null));
          span.append(a);
          if (j < targets.length - 1) span.append(', ');
        });
        return span;
      };
      if (conn.uses.length) connRow.append(pill('uses', conn.uses));
      if (conn.uses.length && conn.usedBy.length) connRow.append(' · ');
      if (conn.usedBy.length) connRow.append(pill('used by', conn.usedBy));
      li.append(connRow);
    }

    li.addEventListener('mouseenter', () => onHover(c));
    li.addEventListener('mouseleave', () => onHover(null));
    li.addEventListener('focus', () => onHover(c));
    li.addEventListener('blur', () => onHover(null));
    li.addEventListener('click', () => onSelect(c));
    list.append(li);
    return li;
  });

  function focusIndex(i) {
    const clamped = Math.max(0, Math.min(items.length - 1, i));
    for (const it of items) it.tabIndex = -1;
    items[clamped].tabIndex = 0;
    items[clamped].focus();
  }
  list.addEventListener('keydown', (e) => {
    const current = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIndex(current < 0 ? 0 : current + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIndex(current < 0 ? 0 : current - 1); }
    else if (e.key === 'Enter' && current >= 0) { e.preventDefault(); onSelect(components[current]); }
  });

  // One place that knows how collapsed state is expressed, so the click
  // handler and the programmatic path below cannot drift on the aria bit.
  function setCollapsed(next) {
    tray.classList.toggle('garden-tray-collapsed', next);
    toggle.setAttribute('aria-expanded', String(!next));
  }

  toggle.addEventListener('click', () => {
    setCollapsed(!tray.classList.contains('garden-tray-collapsed'));
  });

  function setCost(id, ms) {
    const chip = costChips.get(id);
    if (!chip) return;
    chip.textContent = ms == null ? '—' : `${ms.toFixed(1)}ms`;
  }

  function setEdited(id, edited) {
    const chip = editedChips.get(id);
    if (chip) chip.hidden = !edited;
  }

  tray.append(head, list);
  // collapse() is idempotent: a round starting while the rail is already
  // collapsed must not toggle it back open.
  return { el: tray, setCost, setEdited, collapse: () => setCollapsed(true), destroy() {} };
}
