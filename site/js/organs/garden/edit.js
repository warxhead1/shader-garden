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
//
// Two layouts share one widget (multiplayer §5.2):
//   - Holder / solo: ONE editable pane (the historical behaviour).
//   - Non-holder: TWO panes — "Watching <holder>" (read-only mirror updated
//     by remote drafts, NEVER compiles, NEVER transmits) and "My draft"
//     (editable local sandbox, locally compiled, never transmitted while
//     non-holder). The local draft is preserved across tab switches (panel
//     close/reopen) and lease changes (non-holder → holder promotes the
//     draft to committable; holder → non-holder keeps the draft editable).
//     index.js owns the source-of-truth localDraft Map; this widget just
//     reads/writes it via the `onLocalDraftChange` callback.
import { createDocAdapter } from '../../editor/doc-adapter.js';
import { createDiagnosticsList } from '../../editor/diagnostics-list.js';
import glslMode from '../../editor/modes/glsl.js';
import { el } from '../../dom.js';
import { END_RE } from './parse.js';

const DEBOUNCE_MS = 300;

/**
 * @param {{
 *   component: import('./parse.js').Component,
 *   initialBody: string,        // initial editable pane value (local draft, or pristine)
 *   originalBody: string,       // pristine, for Revert
 *   initialMirrorBody?: string, // initial Watching pane text (only when isHolder === false)
 *   recompile?: (body: string) => { ok: boolean, log: string, messages: object[] },
 *     // messages are in FULL-SCENE user-source coordinates (webgl2.js's own
 *     // remap) — this module subtracts component.startLine to land on
 *     // editor-local line numbers. Omit when readOnly is true — a mirror
 *     // never compiles anything itself (docs/multiplayer-spec.md §5.2).
 *   isHolder: boolean,          // true → single editable pane (holder OR solo).
 *                               // false → dual workspace (non-holder in a room).
 *   holderName?: string,        // shown in the Watching pane heading; required when isHolder === false.
 *   onLocalDraftChange?: (body: string) => void,  // every keystroke on the local draft (non-holder)
 *                               // and on holder-mode local edits, so index.js's
 *                               // localDrafts map stays in sync.
 *   onCommit?: (body: string) => Promise<{ok: boolean, reason?: string}>,
 *     // MP §6.2: present only for the lease holder in a room — renders a
 *     // "Commit" button that validates locally (via `recompile`) before
 *     // ever sending.
 * }}
 * @returns {Promise<{
 *   el: HTMLElement,
 *   destroy: () => void,
 *   setMirrorBody?: (body: string) => void,
 *     // Update the Watching pane text without remounting — called from
 *     // handleRemoteDraft / handleRemoteCommit whenever the holder's draft
 *     // or the committed body changes. Only present in dual-workspace mode.
 *   setAuthority?: (auth: { isHolder: boolean, holderName?: string }) => void,
 *     // Swap between single-pane (holder) and dual-workspace (non-holder)
 *     // layouts WITHOUT remounting — preserves the user's local draft text
 *     // across the lease flip. Only present in a room.
 *   getLocalDraft?: () => string,  // current editable pane text (for saves/reads)
 * }>}
 */
export async function mountComponentEditor({ component, initialBody, originalBody, initialMirrorBody, recompile, isHolder, holderName, onLocalDraftChange, onCommit }) {
  let isHolderLocal = !!isHolder;
  const wrap = el('div', 'component-editor' + (isHolderLocal ? '' : ' component-editor-nonholder'));
  const statusRow = el('div', 'component-editor-status');
  const statusPill = el('span', 'pill', isHolderLocal ? 'unchanged' : 'local');
  const revertBtn = el('button', 'btn btn-small btn-ghost', 'Revert');
  revertBtn.type = 'button';
  const commitBtn = el('button', 'btn btn-small btn-primary', 'Commit');
  commitBtn.type = 'button';
  // GARDEN-1: live recompile always goes through webgl2.js's synchronous
  // setShader (see index.js's onEditHere, which rebuilds a WebGPU-backed
  // mount onto WebGL2 before this module ever mounts) — true regardless of
  // which backend was rendering a moment ago, so this is unconditional.
  const backendNote = el('span', 'muted component-editor-note',
    isHolderLocal ? 'editing runs on WebGL2' : 'local draft — compiles locally, never sent');
  statusRow.append(statusPill, backendNote);
  if (isHolderLocal) {
    statusRow.append(revertBtn);
    if (onCommit) statusRow.append(commitBtn);
  } else {
    // Non-holders get NO Revert and NO Commit — Revert would discard the
    // local sandbox the user is intentionally shaping, and a Commit would
    // conflict with the holder. Only the editable pane's own diagnostic pill
    // surfaces the local-compile state.
  }

  // --- Editable pane (always present) — drives recompile/onLocalDraftChange.
  const editableWrap = el('div', 'component-editor-editable');
  const { adapter, kind } = await createDocAdapter(
    initialBody,
    (body) => {
      if (onLocalDraftChange) onLocalDraftChange(body);
      scheduleRecompile(body);
    },
    { readOnly: false },
  );
  await adapter.setLanguage(glslMode);
  const diagList = createDiagnosticsList(adapter);
  editableWrap.append(adapter.el, diagList.el);
  wrap.append(statusRow, editableWrap);

  // --- Dual-workspace (non-holder) — Watching pane sits above the editable
  // pane, mirrors the holder's draft. Built only when isHolder === false;
  // on a later setAuthority({ isHolder: true }) the Watching pane hides and
  // the editable pane's commit button / revert button appear, all without
  // remounting the doc adapter.
  let mirrorWrap = null, mirrorTextarea = null, mirrorHead = null;
  if (!isHolderLocal) {
    mirrorWrap = el('div', 'component-editor-mirror');
    mirrorHead = el('div', 'component-editor-mirror-head muted', 'Watching ' + (holderName || 'the holder'));
    mirrorTextarea = document.createElement('textarea');
    mirrorTextarea.className = 'code-editor code-editor-readonly';
    mirrorTextarea.readOnly = true;
    mirrorTextarea.value = initialMirrorBody ?? originalBody;
    mirrorTextarea.setAttribute('aria-label', "Holder's draft (read-only)");
    mirrorWrap.append(mirrorHead, mirrorTextarea);
    wrap.insertBefore(mirrorWrap, editableWrap);
  }

  let debounce = null;
  let destroyed = false;
  let lastGoodBody = initialBody; // §6.2: only ever send/commit a body that PASSED recompile() locally
  let diagState = { status: 'unchanged', label: isHolderLocal ? 'unchanged' : 'local' };

  function setStatus(kindCls, label) {
    statusPill.className = 'pill ' + kindCls;
    statusPill.textContent = label;
    diagState = { status: kindCls, label };
  }

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
    if (!recompile) return; // no recompile in mirror-only contexts (kept for backward-compat with non-MP callers)
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

  // Holder-only Revert: rewinds the editable pane to the pristine source
  // and forces an immediate (no-debounce) recompile. Non-holders have no
  // Revert — the local draft IS the user's work in progress; an accidental
  // click would lose it without a second confirmation surface.
  if (isHolderLocal) {
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
  if (isHolderLocal && onCommit) {
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

  // setAuthority: called by index.js on every renderLease/renderGame. The
  // editable pane (and its local draft) is NEVER remounted — setMirrorBody
  // already keeps the Watching pane in lockstep with the holder, and the
  // editable pane's text is its own source of truth (kept alive across the
  // swap). Reverting to single-pane mode just hides the Watching wrapper.
  function setAuthority(auth) {
    if (destroyed) return;
    const nowHolder = !!auth.isHolder;
    const nextName = auth.holderName || 'the holder';
    if (nowHolder && !isHolderLocal) {
      // Non-holder → holder: build the holder-mode chrome (Revert + maybe
      // Commit) and remove the dual-workspace class. The editable pane is
      // already mounted; nothing in it moves.
      isHolderLocal = true;
      wrap.classList.remove('component-editor-nonholder');
      wrap.classList.add('component-editor-holder');
      if (!statusRow.contains(revertBtn)) statusRow.append(revertBtn);
      if (onCommit && !statusRow.contains(commitBtn)) statusRow.append(commitBtn);
      if (mirrorWrap) { mirrorWrap.hidden = true; }
      backendNote.textContent = 'editing runs on WebGL2';
      setStatus(diagState.status, diagState.label);
      return;
    }
    if (!nowHolder && isHolderLocal) {
      // Holder → non-holder: show the Watching pane again, drop Revert/Commit.
      // The local draft (now editable but not committable) is the SAME body
      // the user was just editing as holder — preserved across the flip.
      isHolderLocal = false;
      wrap.classList.add('component-editor-nonholder');
      wrap.classList.remove('component-editor-holder');
      if (statusRow.contains(revertBtn)) revertBtn.remove();
      if (statusRow.contains(commitBtn)) commitBtn.remove();
      if (mirrorWrap) {
        mirrorWrap.hidden = false;
        mirrorHead.textContent = 'Watching ' + nextName;
      }
      backendNote.textContent = 'local draft — compiles locally, never sent';
      setStatus(diagState.status, diagState.label);
    } else if (!nowHolder && mirrorWrap && mirrorHead) {
      // Already non-holder: just update the holder name shown.
      mirrorHead.textContent = 'Watching ' + nextName;
    }
  }

  return {
    el: wrap,
    destroy() {
      destroyed = true;
      clearTimeout(debounce);
      adapter.destroy();
    },
    getLocalDraft() {
      return adapter.getValue();
    },
    setAuthority,
    setMirrorBody(body) {
      if (mirrorTextarea && !destroyed) mirrorTextarea.value = body;
    },
  };
}