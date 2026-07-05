// Shader Garden — organs/garden/uniform-inspector.js (wave-4 Area D1)
// Collapsed-by-default panel, topbar-toggled: lists every custom uniform the
// active runtime currently holds, ticking at 10 Hz — same interval ED-4's
// editor/surfaces/uniforms.js already uses for the fixed five. Data source
// is the runtime's own getCustomUniforms() snapshot (§0.4 of the wave-4
// blueprint: both backends already keep this in a plain JS object, so no new
// runtime plumbing beyond that one accessor). Names are grouped "engine"
// (bank residents no @tune slider drives) vs. "tunable" (every @tune name
// the parsed components declare) — the same split
// garden-wgsl-parity.mjs's NON_TUNE_NAMES already encodes as a test
// assertion, reused here as a UI concept.

import { el } from '../../dom.js';

const POLL_MS = 100; // 10 Hz

export function createUniformInspector({ getRuntime, getComponents }) {
  const box = el('div', 'garden-uniform-inspector glass');
  box.hidden = true;
  box.append(el('div', 'garden-uniform-head muted', 'uniform bank'));
  const list = el('div', 'garden-uniform-list');
  box.append(list);

  let pollTimer = null;
  const rows = new Map(); // name -> value <span>

  function tunableNames() {
    const names = new Set();
    for (const c of getComponents()) for (const t of c.tunes) names.add(t.name);
    return names;
  }

  function rebuildRows(values) {
    list.replaceChildren();
    rows.clear();
    const tunable = tunableNames();
    const names = Object.keys(values).sort();
    const groups = [
      ['engine', names.filter((n) => !tunable.has(n))],
      ['tunable', names.filter((n) => tunable.has(n))],
    ];
    for (const [label, group] of groups) {
      if (!group.length) continue;
      list.append(el('div', 'garden-uniform-group', label));
      for (const name of group) {
        const row = el('div', 'garden-uniform-row');
        row.dataset.name = name;
        const value = el('span', 'garden-uniform-value', String(values[name]));
        row.append(el('span', 'garden-uniform-name', name), value);
        list.append(row);
        rows.set(name, value);
      }
    }
  }

  function refresh() {
    const rt = getRuntime();
    if (!rt || box.hidden || !rt.getCustomUniforms) return;
    const values = rt.getCustomUniforms();
    const names = Object.keys(values);
    if (names.length !== rows.size || names.some((n) => !rows.has(n))) rebuildRows(values);
    else for (const [name, span] of rows) span.textContent = String(values[name]);
  }

  return {
    el: box,
    toggle() {
      box.hidden = !box.hidden;
      if (!box.hidden) refresh();
    },
    start() {
      clearInterval(pollTimer);
      pollTimer = setInterval(refresh, POLL_MS);
    },
    destroy() { clearInterval(pollTimer); },
  };
}
