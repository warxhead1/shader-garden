// Shader Garden — editor/doc-adapter-textarea.js
// v1 textarea behavior, unchanged: no highlighting, textContent-only errors
// elsewhere. Plain Tab indents; Shift+Tab is left alone so keyboard users
// can move focus OUT of the textarea (WCAG 2.1.2 — no keyboard trap). The
// permanent fallback (design doc §3, §10.6): this is what makes a buildless
// checkout with no vendor chunk a fully working editor. Same facade surface
// as doc-adapter-codemirror.js — no highlighting/diagnostics rendering here,
// diagnostics-list.js is the fallback's diagnostic surface (§4).
export function createTextarea(doc, onChange, opts = {}) {
  const ta = document.createElement('textarea');
  ta.className = 'code-editor';
  ta.spellcheck = false;
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocorrect', 'off');
  ta.setAttribute('aria-label', 'Shader source');
  // Multiplayer §5.2: the native readonly attribute — still fully
  // programmatically settable via ta.value= (setValue below), which is how
  // a read-only mirror updates without ever accepting user keystrokes.
  if (opts.readOnly) ta.readOnly = true;
  ta.value = doc; // property assignment, not user input — never fires 'input'

  ta.addEventListener('input', () => onChange(ta.value));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      onChange(ta.value);
    }
  });

  return {
    el: ta,
    getValue: () => ta.value,
    setValue: (str) => { ta.value = str; },
    focus: () => ta.focus(),
    // 1-based; out-of-range clamps to the last line (diagnostics-list.js click,
    // and the &line= share param — GARDEN-0's probe panel opens the editor here).
    focusLine(n) {
      const lines = ta.value.split('\n');
      const line = Math.min(Math.max(1, n), lines.length);
      const start = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(start, start + lines[line - 1].length);
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18;
      ta.scrollTop = Math.max(0, (line - 3) * lineHeight);
    },
    setLanguage: () => {}, // no highlighting in the fallback
    setDiagnostics: () => {}, // diagnostics-list.js is the fallback's diagnostic surface
    destroy: () => {},
  };
}
