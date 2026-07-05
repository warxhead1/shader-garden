// Shader Garden — dom.js
// Tiny shared DOM helpers: element factory, node clearing, FPS-badge wiring.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent — never innerHTML
  return node;
}

export function clear(node) { node.replaceChildren(); }

// input/textarea/contenteditable guard — isContentEditable also catches
// CodeMirror's `.cm-content` div, so the editor never loses a keystroke.
// Shared by boot.js's Shift+A overlay hotkey and any other keydown listener
// that must not steal input from focused editable chrome.
export function inEditableChrome(t) {
  return !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

// Formats a renderScale multiplier like "0.75x" / "1x" (never "1.00x").
function fmtScale(s) {
  return (Math.round(s * 100) / 100).toString() + 'x';
}

// Wires a runtime's ~1 Hz perf callback to a badge, honestly: fps AND the
// live render scale, never just one. getScale is called fresh on every
// sample so it reflects the adaptive ladder or a user override in real time.
export function wirePerf(runtime, badge, getScale) {
  runtime.onPerf = ({ fps }) => {
    const scale = getScale ? getScale() : 1;
    badge.textContent = Math.round(fps) + ' fps · ' + fmtScale(scale);
  };
}
