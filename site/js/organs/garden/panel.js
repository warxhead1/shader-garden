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
 *   canTune?: boolean,                 // Weekend P2P §2 — slider authority at mount time. Solo (no room) and
 *                                       // lease holder = true; everyone else in the room = false. Updated
 *                                       // in place via setTuneAuthority() on lease flips so a panel never
 *                                       // remounts just because someone else took the lectern.
 * }}
 * @returns {{
 *   el: HTMLElement,
 *   setStages: (manifest, activeId, onSelect) => void,
 *     // GARDEN-IDE work item 3 — renders the stage/variant selector once the
 *     // manifest arrives (index.js fetches it async after the panel opens;
 *     // most components have none, so the row is opt-in, never a placeholder).
 *     // onSelect(variant) resolves to the applied body text, or null if the
 *     // variant failed to load/compile (the row then stays as it was).
 *   setOrigin: (attribution: {kind, sourceKernel?, note?, firstCommit?}) => void,
 *     // wave-4 §3 — renders the Origin block once attribution.js's fetch
 *     // resolves (index.js calls this the same way it calls setStages).
 *     // A no-op past the first real call or a null attribution.
 *   setTuneAuthority: (canTune: boolean) => void,
 *     // Weekend P2P §2 — toggle slider disabled-state in place. Index.js's
 *     // renderLease() pushes this on every lease flip; the panel does not
 *     // remount. Reads the same canTune contract as the constructor flag.
 *   setTuneValue: (name: string, value: number) => void,
 *     // Weekend P2P §2 — slider mirror for a remote tune delta. Updates the
 *     // slider position + label without firing onTuneChange, so the
 *     // authoritative echo doesn't loop back out onto the wire.
 *   setTuneValues: (snapshot: Record<string, number>) => void,
 *     // Weekend P2P §2 — bulk tune snapshot, e.g. the welcome payload.
 *     // Iterates every entry the snapshot carries and routes each through
 *     // setTuneValue so a single code path owns the DOM update.
 *   destroy: (opts?: { animate?: boolean }) => void,
 * }}
 */
export function createProbePanel({ component, body, values, onTuneChange, onEditHere, getEditorHref, onClose, focusLine, connections, onNavigate, onHoverConnection, canTune = true }) {
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

  // Wave-4 §3 (attribution): a stable anchor so the async-resolved Origin
  // block (setOrigin, below) always lands between the blurb and the
  // connections block, regardless of which of the two async fetches
  // (attribution.js vs. the connections block above, which is synchronous
  // anyway) settles first.
  const originAnchor = document.createComment('probe-origin-anchor');
  panelBody.append(originAnchor);

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

  // Wave-3 F3: btn-primary gives "Edit here" real visual weight — it's the
  // in-place, no-navigation option, unlike "Open in editor" below it, and
  // the two read identically today (same btn-small, no hierarchy at all).
  const editBtn = el('button', 'btn btn-small btn-primary', 'Edit here');
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

  // Wave-4 §3: the Origin block — kind ("Evolved" or "Hand-authored") plus,
  // for an evolved component, a deep-link into #/s/<sourceKernel> (the
  // EXISTING provenance organ already renders that kernel's real fitness/
  // lineage there — this panel never duplicates that data, only points at
  // it). Never throws while attribution.js's fetch is in flight: index.js
  // only calls this once the promise resolves, and a component with no
  // attribution.json entry at all just never gets a block.
  let originSection = null;
  function setOrigin(attribution) {
    if (!attribution || originSection) return;
    originSection = el('div', 'probe-origin');
    if (attribution.kind === 'evolved') {
      originSection.append(el('span', 'probe-origin-badge probe-origin-evolved', 'Evolved'));
      const link = el('a', 'probe-origin-link', attribution.sourceKernel);
      link.href = '#/s/' + attribution.sourceKernel;
      originSection.append(document.createTextNode(' from '), link);
    } else {
      originSection.append(el('span', 'probe-origin-badge probe-origin-handmade', 'Hand-authored'));
      if (attribution.firstCommit) {
        originSection.append(document.createTextNode(' · added ' + attribution.firstCommit.date.slice(0, 10)));
      }
    }
    if (attribution.note) originSection.append(el('p', 'probe-origin-note', attribution.note));
    originAnchor.after(originSection);
  }

  // Correction 1: panel block scope. The three in-place tune APIs MUST live
  // at the OUTER scope of createProbePanel so a panel mounted for a component
  // with no tunes still exposes the same uniform surface (setTuneAuthority/
  // setTuneValue/setTuneValues). index.js's unconditional optional-chain
  // calls (`panel?.setTuneAuthority?.(...)`) cannot reach an identifier that
  // was only declared inside a not-taken branch. The DOM building block stays
  // gated on tunes.length; the API surface does not.
  const tuneRanges = new Map(); // name -> {range, value, listener}
  if (component.tunes.length) {
    const tuneList = el('div', 'probe-tunes');
    // Weekend P2P §2: track every slider by uniform name so the in-place
    // authority/value updates below don't have to walk the DOM twice. Also
    // keeps a single owner of "what the slider currently displays" — the
    // constructor sets the initial value, setTuneValue() updates it for
    // a remote delta, setTuneValues() runs the same path over a snapshot,
    // and the `input` listener is the only path that reads back. Keeping
    // them keyed here avoids a querySelector in the hot path.
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
      // Weekend P2P §2: initial authority — solo or lease holder at mount
      // time is interactive; everyone else in a room sees a disabled
      // slider that visually tracks the holder's value. The
      // `input` listener is conditionally suppressed below so a
      // non-holder's disabled slider can never emit a tune message.
      range.disabled = !canTune;
      const listener = () => {
        const v = Number(range.value);
        value.textContent = v.toFixed(2);
        if (canTune) onTuneChange(tune.name, v);
      };
      range.addEventListener('input', listener);
      row.append(label, range);
      tuneList.append(row);
      tuneRanges.set(tune.name, { range, value, listener });
    }
    panelBody.append(tuneList);
  }

  // The three in-place tune APIs (Correction 1: outer scope). A panel with
  // no @tune (component.tunes.length === 0) has nothing to update, but the
  // METHODS are still bound so index.js's optional-chain calls do not throw.
  function setTuneAuthority(next) {
    const boolNext = !!next;
    if (boolNext === canTune) return;
    canTune = boolNext;
    for (const { range } of tuneRanges.values()) range.disabled = !canTune;
  }
  function setTuneValue(name, val) {
    const entry = tuneRanges.get(name);
    if (!entry || typeof val !== 'number') return;
    entry.range.value = String(val);
    entry.value.textContent = val.toFixed(2);
  }
  function setTuneValues(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const [name, val] of Object.entries(snapshot)) setTuneValue(name, val);
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
    setOrigin,
    // Correction 1: panel block scope. These three methods are bound at the
    // outer scope of createProbePanel (NOT inside `if (component.tunes.length)`),
    // so the public surface is uniform for every panel mount regardless of
    // whether this component has any @tune. A panel with no tunes accepts
    // setTuneAuthority / setTuneValue / setTuneValues as no-ops via the empty
    // tuneRanges Map — index.js's optional-chain calls never throw.
    setTuneAuthority,
    setTuneValue,
    setTuneValues,
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
