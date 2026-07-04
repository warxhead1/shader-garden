// Shader Garden — editor/doc-adapter.js
// Picks CodeMirror (ED-2) if the vendor chunk built, textarea otherwise — a
// fresh buildless checkout or a broken deploy never white-screens (design
// doc §3 "Fallback is a contract"). Both adapters share one facade: el,
// getValue/setValue, focus/focusLine, setLanguage(mode), setDiagnostics,
// destroy. `doc` is the actual initial source, not a placeholder later
// overwritten by setValue() — CM's onChange fires on every dispatched
// transaction including a post-construction setValue, which would clear a
// share-link admission scrim before the caller ever sees it (a plain
// textarea.value= assignment doesn't fire 'input', so this only bites CM).
import { loadEditorBundle } from './bundle-loader.js';
import { createCodeMirror } from './doc-adapter-codemirror.js';
import { createTextarea } from './doc-adapter-textarea.js';

export async function createDocAdapter(doc, onChange) {
  const bundle = await loadEditorBundle();
  if (bundle) return { adapter: createCodeMirror(bundle, { doc, onChange }), kind: 'cm' };
  return { adapter: createTextarea(doc, onChange), kind: 'textarea' };
}
