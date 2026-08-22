// Shader Garden — editor/doc-adapter-codemirror.js
// CodeMirror 6 doc adapter. Same facade surface as doc-adapter-textarea.js
// (el, getValue/setValue, focus/focusLine, setLanguage, setDiagnostics,
// destroy) so index.js and diagnostics-list.js stay ignorant of which one
// mounted — index.js picks between the two via bundle-loader.js's try/catch
// (design doc §3 "Fallback is a contract").
//
// `bundle` is the already-loaded cm-editor.bundle.js module (createEditor/
// setDiagnostics/glsl/wgsl) — the only file in this tree that imports it.
export function createCodeMirror(bundle, { doc, onChange, readOnly = false }) {
  const editor = bundle.createEditor({ doc, language: null, onChange });
  editor.view.dom.classList.add('code-editor'); // layout/theme hook — same class the textarea used
  editor.view.contentDOM.setAttribute('aria-label', 'Shader source');
  // Multiplayer §5.2: the read-only mirror. createEditor() (the vendor
  // chunk's facade, tools/editor-bundle/facade.js) has no readOnly param, so
  // this blocks typing at the contentDOM level instead of via CM's own
  // EditorState.readOnly facet — functionally equivalent (no user edits
  // reach the doc) without a facade/bundle rebuild. setDoc() (this
  // adapter's setValue) still works — that's how the mirror updates.
  if (readOnly) {
    editor.view.contentDOM.contentEditable = 'false';
    editor.view.contentDOM.setAttribute('aria-readonly', 'true');
    editor.view.dom.classList.add('code-editor-readonly');
  }

  return {
    el: editor.view.dom,
    getValue: () => editor.getDoc(),
    setValue: (str) => editor.setDoc(str),
    focus: () => editor.view.focus(),
    focusLine: (line) => editor.focusLine(line),
    // `mode` is a mode descriptor (modes/glsl.js etc.) — its own language()
    // factory owns the CM type, this adapter never imports one directly.
    async setLanguage(mode) {
      editor.setLanguage((await mode.language?.()) ?? null);
    },
    setDiagnostics(messages) {
      bundle.setDiagnostics(editor.view, (messages || []).map((m) => toCmDiagnostic(editor.view, m)));
    },
    destroy: () => editor.destroy(),
  };
}

// ED-1's messages[] are { line, col?, severity, text, wholeDoc? } in 1-based
// user-source coordinates (ARCHITECTURE.md § compiler diagnostics); CM
// diagnostics are doc-offset spans. No compiler in this repo reports a
// length, so a located message (col present, not wholeDoc) squiggles one
// character; wholeDoc (or a message with no column) squiggles the whole line.
function toCmDiagnostic(view, m) {
  const ln = Math.min(Math.max(m.line || 1, 1), view.state.doc.lines);
  const line = view.state.doc.line(ln);
  let from = line.from;
  let to = line.to;
  if (!m.wholeDoc && m.col != null) {
    from = Math.min(line.from + Math.max(0, m.col - 1), line.to);
    to = Math.min(from + 1, line.to);
  }
  const severity = m.severity === 'warning' || m.severity === 'info' ? m.severity : 'error';
  return { from, to, severity, message: m.text };
}
