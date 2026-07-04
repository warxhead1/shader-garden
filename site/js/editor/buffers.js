// Shader Garden — editor/buffers.js
// COMP-2 (v2 blueprint §7.3 item 25): Image + up to 4 buffer tabs + a Common
// include. GLSL-only (mirrors COMP-1's composition player, which is WebGL2-
// only for the same reason: no WGSL multi-pass player exists anywhere in the
// tree). Must-not-break rule (blueprint §7.1): buffers are INVISIBLE until
// the user adds one — `el` starts with a single low-key "+ Buffer" control
// and no `.buffer-tabs`/`.buffer-channels` row exists in the DOM until
// `addBuffer()` is called at least once. index.js owns the single CM/textarea
// document; this module owns everything else about buffer/tab state so
// index.js stays ignorant of the multi-pass shape when there are zero
// buffers (the pixel-unchanged path never touches this file beyond mounting
// `el` and reading `hasBuffers()`).
import { el } from '../dom.js';
import { validateComposition } from '../runtime/composition-graph.js';

const IDS = ['A', 'B', 'C', 'D'];

function starterFor(id) {
  return `// Buffer ${id} — bind it to another tab's iChannel to sample it\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(0.0, 0.0, 0.0, 1.0);\n}\n`;
}

/**
 * @param {{onSwitch:(prevId:string, nextId:string)=>void, onChange:()=>void}} hooks
 *   onSwitch fires AFTER the active id has changed but BEFORE render() —
 *   the caller reads getSrc(prevId)/getSrc(nextId) itself (it owns the CM
 *   adapter, this module doesn't); onChange fires after any state edit that
 *   should trigger a recompile (channel rewire, buffer add/remove).
 */
export function createBufferBar({ onSwitch, onChange }) {
  let common = '';
  let imageSrc = null; // caller sets this via setSrc('Image', ...) at the 0->1 buffer transition
  let imageChannels = [null, null, null, null];
  const buffers = []; // { id, src, channels:[4] }
  let active = 'Image';

  const bar = el('div', 'buffer-bar');
  const addBtn = el('button', 'btn btn-small btn-ghost buffer-add', '+ Buffer');
  addBtn.type = 'button';
  addBtn.title = 'Add a render-to-texture buffer pass (GLSL only)';
  const tabsRow = el('div', 'buffer-tabs');
  tabsRow.hidden = true; // no buffers yet — must-not-break: nothing but "+ Buffer" itself renders
  const chanRow = el('div', 'buffer-channels');
  bar.append(addBtn, tabsRow, chanRow);
  addBtn.addEventListener('click', () => addBuffer());

  function hasBuffers() { return buffers.length > 0; }
  function findBuffer(id) { return buffers.find((b) => b.id === id); }
  function tabIds() { return ['Image', ...buffers.map((b) => b.id), 'Common']; }
  function channelsOf(id) { return id === 'Image' ? imageChannels : (findBuffer(id) || {}).channels; }

  function unlink(removedId) {
    for (const slots of [imageChannels, ...buffers.map((b) => b.channels)]) {
      for (let i = 0; i < slots.length; i++) if (slots[i] === removedId) slots[i] = null;
    }
  }

  function renderChannels() {
    chanRow.replaceChildren();
    if (active === 'Common' || !hasBuffers()) return;
    const slots = channelsOf(active);
    const sources = buffers.map((b) => b.id).filter((id) => id !== undefined);
    slots.forEach((val, i) => {
      const sel = el('select', 'buffer-chan-select');
      sel.append(new Option('iChannel' + i + ': —', ''));
      for (const id of sources) sel.append(new Option('iChannel' + i + ': Buffer ' + id, id, false, val === id));
      sel.value = val || '';
      sel.addEventListener('change', () => {
        slots[i] = sel.value || null;
        onChange?.();
      });
      chanRow.append(sel);
    });
  }

  function renderTabs() {
    tabsRow.replaceChildren();
    if (!hasBuffers()) { tabsRow.hidden = true; return; }
    tabsRow.hidden = false;
    for (const id of tabIds()) {
      const tab = el('button', 'buffer-tab' + (id === active ? ' active' : ''), id === 'Image' ? 'Image' : id);
      tab.type = 'button';
      tab.addEventListener('click', () => switchTo(id));
      if (id !== 'Image' && id !== 'Common') {
        const close = el('span', 'buffer-tab-close', '×');
        close.addEventListener('click', (ev) => { ev.stopPropagation(); removeBuffer(id); });
        tab.append(close);
      }
      tabsRow.append(tab);
    }
    addBtn.hidden = buffers.length >= IDS.length;
  }

  function render() { renderTabs(); renderChannels(); }

  function switchTo(id) {
    if (id === active || !tabIds().includes(id)) return;
    const prev = active;
    active = id;
    onSwitch?.(prev, id);
    render();
  }

  function addBuffer() {
    if (buffers.length >= IDS.length) return null;
    const id = IDS.find((cand) => !findBuffer(cand));
    buffers.push({ id, src: starterFor(id), channels: [null, null, null, null] });
    render();
    onChange?.();
    return id;
  }

  function removeBuffer(id) {
    const idx = buffers.findIndex((b) => b.id === id);
    if (idx < 0) return;
    buffers.splice(idx, 1);
    unlink(id);
    if (active === id) switchTo('Image');
    else render();
    onChange?.();
  }

  function getSrc(id) {
    if (id === 'Image') return imageSrc;
    if (id === 'Common') return common;
    return (findBuffer(id) || {}).src;
  }
  function setSrc(id, text) {
    if (id === 'Image') imageSrc = text;
    else if (id === 'Common') common = text;
    else { const b = findBuffer(id); if (b) b.src = text; }
  }

  return {
    el: bar,
    hasBuffers,
    get active() { return active; },
    getSrc,
    setSrc,
    switchTo,
    addBuffer,
    removeBuffer,
    // GLSL-only (no WGSL multi-pass player exists anywhere in this tree) —
    // index.js calls this on every mode switch so the "+ Buffer" control
    // itself is the one honest signal of when the feature is reachable.
    setEnabled(enabled) { addBtn.disabled = !enabled; addBtn.title = enabled ? 'Add a render-to-texture buffer pass' : 'Buffer tabs are GLSL-only'; },
    reset() {
      common = ''; imageSrc = null; imageChannels = [null, null, null, null];
      buffers.length = 0; active = 'Image'; render();
    },
    // Hydrate from a decoded v=2 share link (multipass-share.js's shape).
    load(state) {
      common = state.common || '';
      imageSrc = state.image.src;
      imageChannels = (state.image.channels || [null, null, null, null]).slice(0, 4);
      buffers.length = 0;
      for (const b of state.buffers.slice(0, IDS.length)) {
        buffers.push({ id: b.id, src: b.src, channels: (b.channels || [null, null, null, null]).slice(0, 4) });
      }
      active = 'Image';
      render();
    },
    /**
     * DAG-validate + assemble compile-ready passes. Returns
     * `{ reject, findings, order, passes }` — `passes[i]` is
     * `{ id, target, fullSource, channelSlots, feedback }`; `order` is a
     * valid topological index sequence into `passes` (screen last). Mirrors
     * COMP-1's composition manifest shape (ruling C12/SG-S08) but built from
     * inline editor sources instead of kernel-id references.
     */
    passesForCompile() {
      const passes = [
        { id: 'Image', target: 'screen', channelSlots: imageChannels, src: imageSrc },
        ...buffers.map((b) => ({ id: b.id, target: b.id, channelSlots: b.channels, src: b.src })),
      ].map((p) => ({
        ...p,
        feedback: p.channelSlots.includes(p.id),
        fullSource: (common ? common + '\n' : '') + (p.src || ''),
      }));
      const graphInput = passes.map((p) => ({
        kernel: p.id, target: p.target, channels: p.channelSlots.filter(Boolean), feedback: p.feedback,
      }));
      const { reject, findings, order } = validateComposition(graphInput);
      return { reject, findings, order, passes };
    },
    /** Serializable shape for multipass-share.js. */
    serialize() {
      return {
        common,
        image: { src: imageSrc, channels: imageChannels.slice() },
        buffers: buffers.map((b) => ({ id: b.id, src: b.src, channels: b.channels.slice() })),
      };
    },
  };
}
