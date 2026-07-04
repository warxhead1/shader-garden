// Shader Garden — editor/bundle-loader.js
// Loads the committed CodeMirror vendor chunk (tools/editor-bundle/) and
// memoizes the attempt. A fresh buildless checkout (chunk never built) or a
// broken deploy resolves null instead of throwing past the call site —
// index.js falls back to doc-adapter-textarea.js, and every mode's
// language() re-hits this same cached promise (Pillar 4: modes stay
// self-contained, no central dispatch table).
let cached = null;

export function loadEditorBundle() {
  if (!cached) cached = import('../vendor/cm-editor.bundle.js').catch(() => null);
  return cached;
}
