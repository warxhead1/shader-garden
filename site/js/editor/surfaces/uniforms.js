// Shader Garden — editor/surfaces/uniforms.js (ED-4)
// Read-only uniforms inspector: usage-scan of the source (which of the fixed
// five contract uniforms the shader actually references) + a 10 Hz readout
// of their live values off the active runtime's clock. No editing of values
// in v2 (that's a custom-uniform system, deferred — design §6/§9); this
// panel only teaches what's live and lets the author freeze iMouse to hold
// a pose while iterating. C13: if the editor budget squeezes, this is the
// surface that sheds affordances first — it already has none to shed but
// the freeze toggle, so it stays deliberately tiny.

import { el } from '../../dom.js';

const POLL_MS = 100; // 10 Hz

// Per-language identifier -> live-value reader off {time, dt, frame, mouse}.
// GLSL exposes the five contract names directly; WGSL through the `U` struct
// (runtime/wrap.js's SGUniforms) — both are scanned by regex, never guessed.
const FIELDS = {
  glsl: [
    { name: 'iResolution', re: /\biResolution\b/, read: (c, canvas) => `${canvas.width}×${canvas.height}` },
    { name: 'iTime', re: /\biTime\b/, read: (c) => c.time.toFixed(2) },
    { name: 'iTimeDelta', re: /\biTimeDelta\b/, read: (c) => c.dt.toFixed(3) },
    { name: 'iFrame', re: /\biFrame\b/, read: (c) => String(c.frame) },
    { name: 'iMouse', re: /\biMouse\b/, read: (c) => c.mouse.map((n) => n.toFixed(0)).join(', ') },
  ],
  wgsl: [
    { name: 'U.res', re: /\bU\.res\b/, read: (c, canvas) => `${canvas.width}×${canvas.height}` },
    { name: 'U.time', re: /\bU\.time\b/, read: (c) => c.time.toFixed(2) },
    { name: 'U.dt', re: /\bU\.dt\b/, read: (c) => c.dt.toFixed(3) },
    { name: 'U.frame', re: /\bU\.frame\b/, read: (c) => String(c.frame) },
    { name: 'U.mouse', re: /\bU\.mouse\b/, read: (c) => c.mouse.map((n) => n.toFixed(0)).join(', ') },
  ],
};

export function createUniformsPanel({ getRuntime, getSource, getLanguage }) {
  const box = el('div', 'uniforms-panel glass');
  box.hidden = true;
  const head = el('div', 'uniforms-head');
  const title = el('span', 'muted', 'uniforms in use');
  const freezeBtn = el('button', 'btn btn-small btn-ghost', 'Freeze iMouse');
  freezeBtn.type = 'button';
  head.append(title, freezeBtn);
  const list = el('div', 'uniforms-list');
  box.append(head, list);

  let frozen = false;
  let pollTimer = null;
  const rows = new Map(); // field name -> value <span>

  function rebuildRows() {
    list.replaceChildren();
    rows.clear();
    const source = getSource() || '';
    const fields = FIELDS[getLanguage()] || FIELDS.glsl;
    for (const f of fields) {
      if (!f.re.test(source)) continue;
      const row = el('div', 'uniforms-row-item');
      const value = el('span', 'uniforms-value', '—');
      row.append(el('span', 'uniforms-name', f.name), value);
      list.append(row);
      rows.set(f.name, { value, read: f.read });
    }
    box.hidden = rows.size === 0;
  }

  function refresh() {
    const rt = getRuntime();
    if (!rt || box.hidden) return;
    const clock = rt.getClock();
    for (const { value, read } of rows.values()) value.textContent = read(clock, rt.canvas);
  }

  freezeBtn.addEventListener('click', () => {
    const rt = getRuntime();
    if (!rt) return;
    frozen = !frozen;
    if (frozen) rt.freezeMouse(); else rt.unfreezeMouse();
    freezeBtn.textContent = frozen ? 'Unfreeze iMouse' : 'Freeze iMouse';
    freezeBtn.classList.toggle('active', frozen);
  });

  return {
    el: box,
    // Called after every debounced compile (pipeline.js's cadence) — the
    // usage scan only needs to track the source actually running, not every
    // keystroke.
    rescan: rebuildRows,
    // Called after (re)building a runtime (mode switch, boot) — a fresh
    // runtime means a fresh (unfrozen) mouse attachment.
    onRuntimeReady(rt) {
      frozen = false; // a fresh runtime always starts with a fresh (unfrozen) mouse attachment
      freezeBtn.textContent = 'Freeze iMouse';
      freezeBtn.classList.remove('active');
      clearInterval(pollTimer);
      pollTimer = setInterval(refresh, POLL_MS);
      refresh();
    },
    destroy() {
      clearInterval(pollTimer);
    },
  };
}
