// Shader Garden — editor/diagnostics-list.js
// Clickable "line N: text" list — the textarea fallback's diagnostic
// surface (ED-2 gives CodeMirror squiggles + gutter dots instead; index.js
// only feeds this list messages when the textarea adapter is mounted).
// Consumes setShader()'s messages[] (runtime/{webgl2,webgpu}.js), already
// remapped to user-source line numbers; clicking (or Enter/Space on) a row
// moves the caret there via the adapter's focusLine().

import { el } from '../dom.js';

export function createDiagnosticsList(adapter) {
  const list = el('ul', 'diag-list');
  list.hidden = true;

  function render(messages) {
    list.replaceChildren();
    if (!messages || messages.length === 0) {
      list.hidden = true;
      return;
    }
    for (const m of messages) {
      const li = el('li', 'diag-item diag-' + (m.severity || 'error'), 'line ' + m.line + ': ' + m.text);
      li.tabIndex = 0;
      li.addEventListener('click', () => adapter.focusLine(m.line));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); adapter.focusLine(m.line); }
      });
      list.append(li);
    }
    list.hidden = false;
  }

  return { el: list, render };
}
