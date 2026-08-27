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
// Three layouts share one widget (multiplayer §5.2):
//   - Solo:       ONE editable pane (the historical behaviour, no mirror).
//   - Holder in a room: ONE editable pane AND a mirror DOM node, but the
//                       mirror is CSS-hidden via .component-editor-holder
//                       so the holder's view is still single-pane. The
//                       mirror DOM exists so handleRemoteDraft /
//                       handleRemoteCommit (which fire regardless of who
//                       is currently looking at the component) always have
//                       somewhere to land; on a later setAuthority({isHolder:
//                       false}) the same DOM flips to visible without
//                       remounting the editable pane.
//   - Non-holder: TWO panes — "Watching <holder>" (read-only mirror
//                 updated by remote drafts, NEVER compiles, NEVER
//                 transmits) above "My draft" (editable local sandbox,
//                 locally compiled, never transmitted while non-holder).
//
// The local draft is preserved across tab switches (panel close/reopen) and
// lease changes (non-holder → holder promotes the draft to committable;
// holder → non-holder keeps the draft editable). index.js owns the source-
// of-truth localDraft Map; this widget just reads/writes it via the
// `onLocalDraftChange` callback.
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
 *   initialMirrorBody?: string, // initial Watching pane text (only when isRoom === true)
 *   recompile?: (body: string) => { ok: boolean, log: string, messages: object[] },
 *     // messages are in FULL-SCENE user-source coordinates (webgl2.js's own
 *     // remap) — this module subtracts component.startLine to land on
 *     // editor-local line numbers. Omit when readOnly is true — a mirror
 *     // never compiles anything itself (docs/multiplayer-spec.md §5.2).
 *   isHolder: boolean,          // current lease state at mount time. true for
 *                               // solo and for the lease holder in a room;
 *                               // false for non-holders in a room. Authoritative
 *                               // role can change later via setAuthority().
 *   isRoom: boolean,            // true when this editor is mounted inside a
 *                               // room. Controls whether the mirror DOM is
 *                               // built (regardless of isHolder — see header
 *                               // note about handleRemoteDraft landing on a
 *                               // holder's still-present mirror DOM).
 *   holderName?: string,        // shown in the Watching pane heading; required when isRoom === true.
 *   onLocalDraftChange?: (body: string) => void,  // every keystroke on the local draft,
 *                               // so index.js's localDrafts map stays in sync.
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
 *     // or the committed body changes. Always present in a room, so the
 *     // draft has somewhere to land even on a holder's editor (which has
 *     // the mirror DOM CSS-hidden until a later lease flip).
 *   setAuthority?: (auth: { isHolder: boolean, holderName?: string }) => void,
 *     // Swap between single-pane (holder) and dual-workspace (non-holder)
 *     // layouts WITHOUT remounting — preserves the user's local draft text
 *     // across the lease flip. Only present in a room.
 *   getLocalDraft?: () => string,  // current editable pane text (for saves/reads)
 * }>}
 */
export async function mountComponentEditor({ component, initialBody, originalBody, initialMirrorBody, recompile, isHolder, isRoom, holderName, onLocalDraftChange, onCommit }) {
  let isHolderLocal = !!isHolder;
  // The wrap's class list is the single source of truth for whether the
  // mirror pane is CSS-visible: main.css's `.component-editor.component-
  // editor-holder .component-editor-mirror { display: none }` rule is what
  // hides it on a holder, and the constructor had a quiet gap — it only
  // stamped `component-editor-nonholder` on non-holders, leaving initial
  // holders with just `.component-editor` (and therefore a *visible* mirror
  // pane in any room, since the mirror DOM is built up front for everyone
  // in a room). Without `component-editor-holder` on construction, a
  // holder's first paint flashed the dual-workspace layout until the
  // first setAuthority() re-stamped the class. Solo mounts never build the
  // mirror DOM (isRoom === false), so they get neither class.
  const wrap = el('div', 'component-editor' + (
    isHolderLocal
      ? (isRoom ? ' component-editor-holder' : '')
      : ' component-editor-nonholder'
  ));
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

  // --- Mirror pane (Watching <holder>) — present for EVERY room editor,
  // regardless of whether THIS client currently holds the lease. The
  // holder's view hides it via .component-editor-holder's CSS so the
  // single-pane UX is preserved, but the DOM stays live: handleRemoteDraft
  // and handleRemoteCommit (called on every peer message, independent of
  // who's looking) always have somewhere to land, so a holder's editor
  // that loses the lease mid-round has the latest holder body already
  // rendered in its mirror pane when setAuthority({isHolder: false})
  // un-hides it. A solo mount (isRoom === false) builds nothing here.
  let mirrorWrap = null, mirrorTextarea = null, mirrorHead = null;
  if (isRoom) {
    mirrorWrap = el('div', 'component-editor-mirror');
    mirrorHead = el('div', 'component-editor-mirror-head muted', 'Watching ' + (holderName || 'the holder'));
    mirrorTextarea = document.createElement('textarea');
    mirrorTextarea.className = 'code-editor code-editor-readonly';
    mirrorTextarea.readOnly = true;
    mirrorTextarea.value = initialMirrorBody ?? originalBody;
    mirrorTextarea.setAttribute('aria-label', "Holder's draft (read-only)");
    mirrorWrap.append(mirrorHead, mirrorTextarea);
    // Mirror is the FIRST visible pane for non-holders; for holders the
    // wrap is hidden via CSS until a lease flip. The DOM ordering stays
    // "mirror above editable" either way, so a later un-hide is just
    // a class swap. Initial holders also get `mirrorWrap.hidden = true`
    // for symmetry with the setAuthority() holder branch below — a later
    // lease loss does `mirrorWrap.hidden = false` and removes the holder
    // class in one step, never a stale un-hide that races the class swap.
    if (isHolderLocal) mirrorWrap.hidden = true;
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
  // swap). Reverting to single-pane mode just toggles .component-editor-
  // holder's CSS, which hides the always-present mirror DOM node — the
  // mirror DOM is built for every room editor up front, so a holder's
  // mirror pane is already populated with the latest peer body by the
  // time a lease flip makes it visible.
  function setAuthority(auth) {
    if (destroyed) return;
    const nowHolder = !!auth.isHolder;
    const nextName = auth.holderName || 'the holder';
    if (nowHolder && !isHolderLocal) {
      // Non-holder → holder: build the holder-mode chrome (Revert + maybe
      // Commit) and remove the dual-workspace class. The editable pane is
      // already mounted; nothing in it moves. The mirror DOM stays in the
      // tree (CSS-hidden via .component-editor-holder) so the next lease
      // loss flips back to non-holder in a single class swap.
      isHolderLocal = true;
      wrap.classList.remove('component-editor-nonholder');
      wrap.classList.add('component-editor-holder');
      if (!statusRow.contains(revertBtn)) statusRow.append(revertBtn);
      if (onCommit && !statusRow.contains(commitBtn)) statusRow.append(commitBtn);
      if (mirrorWrap) mirrorWrap.hidden = true;
      backendNote.textContent = 'editing runs on WebGL2';
      setStatus(diagState.status, diagState.label);
      return;
    }
    if (!nowHolder && isHolderLocal) {
      // Holder → non-holder: show the Watching pane again (it was always
      // there, just hidden via CSS), drop Revert/Commit. The local draft
      // (now editable but not committable) is the SAME body the user was
      // just editing as holder — preserved across the flip. setMirrorBody
      // has been keeping the mirror body current throughout, so the user
      // sees the holder's latest draft the moment the CSS un-hides it.
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

  // Solo mounts never build the mirror DOM (isRoom === false), so the
  // authority/mirror handle methods would be no-ops even if returned —
  // keeping them off the returned object is the "this is a non-MP editor"
  // test surface. Room editors return them so notifyEditorsAuthority() /
  // handleRemoteDraft / handleRemoteCommit always have a target, even on
  // a holder's editor (whose mirror DOM is CSS-hidden until a lease flip).
  if (isRoom) {
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
  };
}
