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
 * }}
 * @returns {{ el: HTMLElement, destroy: (opts?: { animate?: boolean }) => void }}
 */
export function createProbePanel({ component, body, values, onTuneChange, onEditHere, getEditorHref, onClose }) {
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

  const source = el('pre', 'probe-source');
  const code = el('code');
  code.innerHTML = tintGlsl(body.replace(/^\n+|\n+$/g, ''));
  source.append(code);
  panelBody.append(source);

  const editBtn = el('button', 'btn btn-small', 'Edit here');
  editBtn.type = 'button';
  const editHost = el('div', 'component-editor-host');
  editHost.hidden = true;
  let editorApi = null;
  editBtn.addEventListener('click', async () => {
    if (editorApi) return;
    editBtn.disabled = true;
    editBtn.textContent = 'Editing…';
    source.hidden = true;
    editHost.hidden = false;
    editorApi = await onEditHere(refreshEditorLink);
    editHost.append(editorApi.el);
  });
  panelBody.append(editBtn, editHost);

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

  return {
    el: panel,
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
