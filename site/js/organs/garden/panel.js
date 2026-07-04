// GARDEN-0 — panel.js
// Builds the probe panel DOM: component name/blurb/source chunk, its @tune
// sliders (live uniform updates, no recompile), and the "open in editor"
// deep link. Pure DOM construction — index.js owns the probe/runtime wiring.

import { el } from '../../dom.js';

/**
 * @param {{
 *   component: import('./parse.js').Component,
 *   values: Record<string, number>,   // current tune values, keyed by uniform name
 *   editorHref: string|null,          // null when share.js's compress() failed
 *   onTuneChange: (name: string, value: number) => void,
 *   onClose: () => void,
 * }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createProbePanel({ component, values, editorHref, onTuneChange, onClose }) {
  const panel = el('aside', 'probe-panel glass');

  const head = el('div', 'probe-head');
  head.append(el('h2', 'probe-title', component.name));
  const closeBtn = el('button', 'collapse-btn', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close probe panel');
  closeBtn.addEventListener('click', onClose);
  head.append(closeBtn);

  const body = el('div', 'probe-body');
  body.append(el('p', 'probe-blurb', component.blurb));

  const source = el('pre', 'probe-source');
  const code = el('code', null, component.source.replace(/^\n+|\n+$/g, ''));
  source.append(code);
  body.append(source);

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
    body.append(tuneList);
  }

  if (editorHref) {
    const editLink = el('a', 'btn btn-small probe-edit-link', 'Open in editor');
    editLink.setAttribute('href', editorHref);
    body.append(editLink);
  }

  panel.append(head, body);

  return {
    el: panel,
    destroy() { panel.remove(); },
  };
}
