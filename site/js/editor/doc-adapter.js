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

// `opts.readOnly` (multiplayer §5.2): the CM adapter blocks user typing by
// making the content DOM non-editable (see doc-adapter-codemirror.js — the
// vendor chunk's createEditor() facade has no readOnly param, so this is
// enforced at the adapter layer rather than via CM's own EditorState.readOnly
// facet, which would need a facade/bundle change); the textarea fallback
// uses the native `readonly` attribute. Both still accept programmatic
// setValue() calls — that's how a read-only mirror updates.
export async function createDocAdapter(doc, onChange, opts = {}) {
  const { readOnly = false } = opts;
  const bundle = await loadEditorBundle();
  if (bundle) return { adapter: createCodeMirror(bundle, { doc, onChange, readOnly }), kind: 'cm' };
  return { adapter: createTextarea(doc, onChange, { readOnly }), kind: 'textarea' };
}
