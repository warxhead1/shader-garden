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
 *   recompile?: (body: string) => { ok: boolean, log: string, messages: object[] },
 *     // messages are in FULL-SCENE user-source coordinates (webgl2.js's own
 *     // remap) — this module subtracts component.startLine to land on
 *     // editor-local line numbers. Omit when readOnly is true — a mirror
 *     // never compiles anything itself (docs/multiplayer-spec.md §5.2).
 *   readOnly?: boolean,     // MP §5.2: non-holders get the SAME editor, live-
 *     // mirroring the holder's draft via the returned handle's setBody().
 *   onCommit?: (body: string) => Promise<{ok: boolean, reason?: string}>,
 *     // MP §6.2: present only for the lease holder in a room — renders a
 *     // "Commit" button that validates locally (via `recompile`) before
 *     // ever sending.
 * }}
 * @returns {Promise<{ el: HTMLElement, destroy: () => void, setBody?: (body: string) => void }>}
 */
export async function mountComponentEditor({ component, initialBody, originalBody, recompile, readOnly = false, onCommit }) {
  const wrap = el('div', 'component-editor' + (readOnly ? ' component-editor-readonly' : ''));
  const statusRow = el('div', 'component-editor-status');
  const statusPill = el('span', 'pill', readOnly ? 'mirroring' : 'unchanged');
  const revertBtn = el('button', 'btn btn-small btn-ghost', 'Revert');
  revertBtn.type = 'button';
  const commitBtn = el('button', 'btn btn-small btn-primary', 'Commit');
  commitBtn.type = 'button';
  // GARDEN-1: live recompile always goes through webgl2.js's synchronous
  // setShader (see index.js's onEditHere, which rebuilds a WebGPU-backed
  // mount onto WebGL2 before this module ever mounts) — true regardless of
  // which backend was rendering a moment ago, so this is unconditional.
  const backendNote = el('span', 'muted component-editor-note',
    readOnly ? 'read-only — live view of the holder’s draft' : 'editing runs on WebGL2');
  statusRow.append(statusPill, backendNote);
  if (readOnly) {
    // §5.2: a mirror has nothing of its own to revert or commit — watching
    // is the whole feature, not a stripped-down editor.
  } else {
    statusRow.append(revertBtn);
    if (onCommit) statusRow.append(commitBtn);
  }

  const { adapter, kind } = await createDocAdapter(
    initialBody,
    readOnly ? () => {} : (body) => scheduleRecompile(body),
    { readOnly },
  );
  await adapter.setLanguage(glslMode); // no-op on the textarea fallback
  const diagList = createDiagnosticsList(adapter);

  wrap.append(statusRow, adapter.el, diagList.el);

  let debounce = null;
  let destroyed = false;
  let lastGoodBody = initialBody; // §6.2: only ever send/commit a body that PASSED recompile() locally

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
    if (res.ok) lastGoodBody = body; // §6.2: Commit only ever sends a body that passed the SAME local check
  }

  function scheduleRecompile(body) {
    clearTimeout(debounce);
    debounce = setTimeout(() => runRecompile(body), DEBOUNCE_MS);
  }

  if (!readOnly) {
    revertBtn.addEventListener('click', () => {
      clearTimeout(debounce);
      adapter.setValue(originalBody);
      runRecompile(originalBody); // immediate — Revert shouldn't wait out the debounce
    });
  }

  // §6.2 step 1: the holder validates locally (recompile(), which already
  // ran on every debounced keystroke above) before EVER sending. A body
  // that never got a passing recompile can't be committed — commitBtn only
  // exists when onCommit was passed (index.js only does that for the
  // in-room holder), and lastGoodBody only advances on res.ok above, so a
  // currently-broken buffer has nothing eligible to send.
  if (onCommit) {
    commitBtn.addEventListener('click', async () => {
      if (destroyed) return;
      commitBtn.disabled = true;
      setStatus('ok', 'committing…');
      const { ok, reason } = await onCommit(lastGoodBody).catch(() => ({ ok: false, reason: 'network' }));
      if (destroyed) return;
      commitBtn.disabled = false;
      setStatus(ok ? 'ok' : 'err', ok ? 'committed' : ('rejected' + (reason ? ': ' + reason : '')));
    });
  }

  return {
    el: wrap,
    // §5.2: the ONLY way a read-only mirror's buffer changes — net.js's
    // onDraft callback (via index.js) calls this as the holder types.
    // Never wired to onChange/recompile: a mirror does not typecheck.
    setBody(body) {
      if (!readOnly || destroyed) return;
      adapter.setValue(body);
    },
    destroy() {
      destroyed = true;
      clearTimeout(debounce);
      adapter.destroy();
    },
  };
}
