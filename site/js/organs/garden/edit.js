// GARDEN-IDE — organs/garden/edit.js
// The "Edit here" mini-editor for one probed component's body. Dynamic-
// imported by panel.js on the first click only — #/garden's idle payload
// never fetches doc-adapter.js/diagnostics-list.js/the CodeMirror vendor
// chunk (same lazy-load discipline #/edit already uses for the same files).
//
// This module owns only the editor widget (doc adapter lifecycle, debounce,
// status pill, Revert, diagnostics remap). The actual splice-into-the-full-
// scene + setShader() + tune-reapply lives in organs/garden/index.js's
// `recompile` callback, passed in — this module never touches the scene
// source or the runtime directly.
import { createDocAdapter } from '../../editor/doc-adapter.js';
import { createDiagnosticsList } from '../../editor/diagnostics-list.js';
import glslMode from '../../editor/modes/glsl.js';
import { el } from '../../dom.js';
import { END_RE } from './parse.js';

const DEBOUNCE_MS = 300;

/**
 * @param {{
 *   component: import('./parse.js').Component,
 *   initialBody: string,   // current body — edited if a prior session edited it
 *   originalBody: string,  // component.source, for Revert
 *   recompile: (body: string) => { ok: boolean, log: string, messages: object[] },
 *     // messages are in FULL-SCENE user-source coordinates (webgl2.js's own
 *     // remap) — this module subtracts component.startLine to land on
 *     // editor-local line numbers.
 * }}
 * @returns {Promise<{ el: HTMLElement, destroy: () => void }>}
 */
export async function mountComponentEditor({ component, initialBody, originalBody, recompile }) {
  const wrap = el('div', 'component-editor');
  const statusRow = el('div', 'component-editor-status');
  const statusPill = el('span', 'pill', 'unchanged');
  const revertBtn = el('button', 'btn btn-small btn-ghost', 'Revert');
  revertBtn.type = 'button';
  statusRow.append(statusPill, revertBtn);

  const { adapter, kind } = await createDocAdapter(initialBody, (body) => scheduleRecompile(body));
  await adapter.setLanguage(glslMode); // no-op on the textarea fallback
  const diagList = createDiagnosticsList(adapter);

  wrap.append(statusRow, adapter.el, diagList.el);

  let debounce = null;
  let destroyed = false;

  function setStatus(kindCls, label) {
    statusPill.className = 'pill ' + kindCls;
    statusPill.textContent = label;
  }

  // webgl2.js's own out-of-range clamp convention, one level deeper: a
  // message that lands outside this component's own body (a brace imbalance
  // bleeding into the next component, or a wholeDoc link error at scene line
  // 1) still shows *somewhere* the mini-editor's own line gutter has.
  function toLocalMessages(messages, bodyLineCount) {
    return (messages || []).map((m) => ({
      ...m,
      line: Math.min(Math.max((m.line || 1) - component.startLine, 1), Math.max(bodyLineCount, 1)),
    }));
  }

  function runRecompile(body) {
    if (destroyed) return;
    if (body.split('\n').some((l) => END_RE.test(l))) {
      // Refuse rather than splice — a `// @end` inside the body would look
      // like the component ends early in the exported full scene. The
      // last-good program keeps rendering (never-black); fix the line to
      // resume recompiling.
      setStatus('err', 'blocked');
      const msg = [{ line: 1, severity: 'error', text: 'A "// @end" line is not allowed inside a component body.', wholeDoc: true }];
      adapter.setDiagnostics(msg);
      if (kind === 'textarea') diagList.render(msg);
      return;
    }
    const res = recompile(body);
    const msgs = toLocalMessages(res.messages, body.split('\n').length);
    adapter.setDiagnostics(msgs);
    if (kind === 'textarea') diagList.render(msgs);
    setStatus(res.ok ? 'ok' : 'err', res.ok ? 'ok' : 'error');
  }

  function scheduleRecompile(body) {
    clearTimeout(debounce);
    debounce = setTimeout(() => runRecompile(body), DEBOUNCE_MS);
  }

  revertBtn.addEventListener('click', () => {
    clearTimeout(debounce);
    adapter.setValue(originalBody);
    runRecompile(originalBody); // immediate — Revert shouldn't wait out the debounce
  });

  return {
    el: wrap,
    destroy() {
      destroyed = true;
      clearTimeout(debounce);
      adapter.destroy();
    },
  };
}
