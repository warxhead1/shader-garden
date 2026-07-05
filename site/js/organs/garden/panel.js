// GARDEN-0 — panel.js
// Builds the probe panel DOM: component name/blurb/syntax-tinted source
// chunk, its @tune sliders (live uniform updates, no recompile), an "Edit
// here" inline mini-editor (GARDEN-IDE, lazy — see edit.js), and the "open in
// editor" full-scene deep link. Pure DOM construction — index.js owns the
// probe/runtime/splice wiring.

import { el } from '../../dom.js';
import { tintGlsl } from './highlight.js';

// Exit-animation budget (CSS transition is 0.18s) — a safety net in case
// `transitionend` never fires (e.g. the panel got display:none'd by an
// ancestor mid-transition).
const EXIT_MS = 260;

/**
 * @param {{
 *   component: import('./parse.js').Component,
 *   body: string,                     // current body — edited if a prior session edited it
 *   values: Record<string, number>,   // current tune values, keyed by uniform name
 *   onTuneChange: (name: string, value: number) => void,
 *   onEditHere: (onSourceChanged: () => void) => Promise<{ el: HTMLElement, destroy: () => void }>,
 *     // dynamic-imports edit.js on first call; onSourceChanged fires after
 *     // every recompile attempt so the "open in editor" link stays current.
 *   getEditorHref: () => Promise<string|null>,  // exports the CURRENT (edited) full scene
 *   onClose: () => void,
 *   focusLine?: number,                // GARDEN-IDE work item 2 — scroll the read-only source here on open
 *   connections?: { uses: Array<{id,name,symbols}>, usedBy: Array<{id,name,symbols}> },
 *   onNavigate?: (componentId: string, symbol: string) => void,  // opens that component's panel, scrolled to `symbol`
 *   onHoverConnection?: (componentId: string|null) => void,  // wave-3 §3a — mouseenter/leave on a connection link
 * }}
 * @returns {{
 *   el: HTMLElement,
 *   setStages: (manifest, activeId, onSelect) => void,
 *     // GARDEN-IDE work item 3 — renders the stage/variant selector once the
 *     // manifest arrives (index.js fetches it async after the panel opens;
 *     // most components have none, so the row is opt-in, never a placeholder).
 *     // onSelect(variant) resolves to the applied body text, or null if the
 *     // variant failed to load/compile (the row then stays as it was).
 *   destroy: (opts?: { animate?: boolean }) => void,
 * }}
 */
export function createProbePanel({ component, body, values, onTuneChange, onEditHere, getEditorHref, onClose, focusLine, connections, onNavigate, onHoverConnection }) {
  const panel = el('aside', 'probe-panel glass probe-panel-enter');

  const head = el('div', 'probe-head');
  head.append(el('h2', 'probe-title', component.name));
  const closeBtn = el('button', 'collapse-btn', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close probe panel');
  closeBtn.addEventListener('click', onClose);
  head.append(closeBtn);

  const panelBody = el('div', 'probe-body');
  panelBody.append(el('p', 'probe-blurb', component.blurb));

  // GARDEN-IDE work item 2: this component's own edge of the connections
  // graph (connections.js, computed once in index.js) — same data the tray
  // shows, in-panel with the source it's actually about. Clicking a link
  // re-probes the OTHER component with its source scrolled to the symbol.
  if (connections && (connections.uses.length || connections.usedBy.length)) {
    const connBlock = el('div', 'probe-conn');
    const line = (label, targets) => {
      const p = el('p', 'probe-conn-line');
      p.append(el('span', 'probe-conn-label', label + ': '));
      targets.forEach((t, i) => {
        const a = el('a', 'probe-conn-link', t.name);
        a.href = '#';
        a.title = t.symbols.join(', ');
        a.addEventListener('click', (e) => { e.preventDefault(); onNavigate?.(t.id, t.symbols[0]); });
        // wave-3 §3a: reuses the same uProbeSel rim-light the tray's own
        // item-hover already drives — released back to whatever's actually
        // probed (or nothing) on mouseleave, index.js's job, not ours.
        a.addEventListener('mouseenter', () => onHoverConnection?.(t.id));
        a.addEventListener('mouseleave', () => onHoverConnection?.(null));
        p.append(a);
        if (i < targets.length - 1) p.append(', ');
      });
      return p;
    };
    if (connections.uses.length) connBlock.append(line('Uses', connections.uses));
    if (connections.usedBy.length) connBlock.append(line('Used by', connections.usedBy));
    panelBody.append(connBlock);
  }

  // Renders the read-only source pane line-by-line (one <span class="gline">
  // per source line, tinted independently) so a connection click can scroll
  // + flash a specific line — plain positional lookup (querySelectorAll), no
  // ids, so nothing to collide if a future caller ever mounts two panels.
  const source = el('pre', 'probe-source');
  const code = el('code');
  function renderSource(text) {
    const clean = text.replace(/^\n+|\n+$/g, '');
    code.innerHTML = clean.split('\n').map((l) => `<span class="gline">${tintGlsl(l)}</span>`).join('\n');
  }
  renderSource(body);
  source.append(code);
  panelBody.append(source);

  const editBtn = el('button', 'btn btn-small', 'Edit here');
  editBtn.type = 'button';
  const editHost = el('div', 'component-editor-host');
  editHost.hidden = true;
  let editorApi = null;
  let stagesRow = null;
  editBtn.addEventListener('click', async () => {
    if (editorApi) return;
    editBtn.disabled = true;
    editBtn.textContent = 'Editing…';
    source.hidden = true;
    editHost.hidden = false;
    // The mini-editor owns the body from here on — a stage swap underneath
    // it would silently discard whatever's in the doc (see setStages).
    stagesRow?.classList.add('probe-stages-locked');
    editorApi = await onEditHere(refreshEditorLink);
    editHost.append(editorApi.el);
  });
  panelBody.append(editBtn, editHost);

  // GARDEN-IDE work item 3: the stage/variant selector. Heavy variants carry
  // a ⚡ and only ever apply on this explicit click — nothing here is
  // automatic. Selection state itself lives in index.js (session-only, same
  // lifetime as its editedBodies map); this row only renders and reports.
  function setStages(manifest, activeId, onSelect) {
    if (stagesRow) stagesRow.remove();
    stagesRow = el('div', 'probe-stages');
    stagesRow.append(el('span', 'probe-stages-label', 'Stage'));
    if (editorApi) stagesRow.classList.add('probe-stages-locked');
    const btns = manifest.variants.map((variant) => {
      const btn = el('button', 'probe-stage-btn', (variant.heavy ? '⚡ ' : '') + variant.label);
      btn.type = 'button';
      btn.title = variant.blurb || '';
      btn.dataset.variant = variant.id; // garden.mjs test hook
      if (variant.id === activeId) btn.classList.add('probe-stage-active');
      btn.addEventListener('click', async () => {
        if (editorApi || btn.classList.contains('probe-stage-active') || stagesRow.classList.contains('probe-stages-busy')) return;
        stagesRow.classList.add('probe-stages-busy');
        const applied = await onSelect(variant);
        stagesRow.classList.remove('probe-stages-busy');
        if (applied == null) return; // failed load/compile — row unchanged, last-good keeps rendering
        for (const b of btns) b.classList.toggle('probe-stage-active', b === btn);
        renderSource(applied);
        refreshEditorLink();
      });
      stagesRow.append(btn);
      return btn;
    });
    panelBody.insertBefore(stagesRow, source);
  }

  if (component.tunes.length) {
    const tuneList = el('div', 'probe-tunes');
    for (const tune of component.tunes) {
      const row = el('div', 'probe-tune');
      const label = el('label', 'probe-tune-label');
      const value = el('span', 'probe-tune-value', values[tune.name].toFixed(2));
      label.append(tune.label, value);
      const range = el('input', 'probe-tune-range');
      range.type = 'range';
      range.min = String(tune.min);
      range.max = String(tune.max);
      range.step = String((tune.max - tune.min) / 200 || 0.01);
      range.value = String(values[tune.name]);
      range.dataset.name = tune.name; // smoke.mjs test hook
      range.addEventListener('input', () => {
        const v = Number(range.value);
        value.textContent = v.toFixed(2);
        onTuneChange(tune.name, v);
      });
      row.append(label, range);
      tuneList.append(row);
    }
    panelBody.append(tuneList);
  }

  const editLink = el('a', 'btn btn-small probe-edit-link', 'Open in editor');
  async function refreshEditorLink() {
    const href = await getEditorHref();
    if (href) editLink.setAttribute('href', href);
  }
  refreshEditorLink();
  panelBody.append(editLink);

  panel.append(head, panelBody);

  // Enter transition: start faded/offset (probe-panel-enter, set above),
  // then let the CSS transition in main.css carry it to rest. Two rAFs so
  // the browser paints the "enter" state at least once before we remove it
  // (one rAF alone can coalesce with the class add on some engines).
  requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('probe-panel-enter')));

  // GARDEN-IDE work item 2: a connection click opens the TARGET component's
  // panel with its source scrolled to the referencing line — same double-rAF
  // wait as the enter transition above, so the panel has real layout before
  // scrollIntoView runs. Positional lookup (nth .gline), not an id.
  if (focusLine > 0) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = source.querySelectorAll('.gline')[focusLine - 1];
      if (!target) return;
      target.scrollIntoView({ block: 'center' });
      target.classList.add('gline-hit');
      setTimeout(() => target.classList.remove('gline-hit'), 1600);
    }));
  }

  return {
    el: panel,
    setStages,
    // animate:false is index.js's fast-swap path (probing a different
    // component, or organ cleanup) — no exit animation to overlap with the
    // next panel's own enter transition.
    destroy({ animate = true } = {}) {
      editorApi?.destroy();
      if (!animate) { panel.remove(); return; }
      panel.classList.add('probe-panel-exit');
      const remove = () => panel.remove();
      panel.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, EXIT_MS);
    },
  };
}
