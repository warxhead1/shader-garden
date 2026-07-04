// Shader Garden — editor/index.js
// #/edit organ. Lazily imported by app.js's router — a gallery/viewer visit
// never fetches this tree. One runtime per canvas (context types don't mix);
// recompiles are debounced (pipeline.js); compiler logs land verbatim via
// textContent.
//
// COMP-2 (v2 blueprint §7.3 item 25): Image + up to 4 buffer tabs + a Common
// include, GLSL-only. Must-not-break rule (§7.1) — buffers.js's `el` renders
// nothing but a single "+ Buffer" control until `hasBuffers()` is true, and
// every code path below that touches the single-pass `runtime`/`pipeline`
// stays byte-for-byte what it was pre-COMP-2 when there are zero buffers.
// Composition mode is a parallel path (compositionRuntime, compGate) that
// only ever runs alongside the single-pass path being fully torn down.
import {
  compress, decompress, absoluteShareUrl, githubIssueUrl, copyText, toast,
} from '../share.js';
import { el, wirePerf } from '../dom.js';
import { MODES } from './modes/index.js';
import { createDocAdapter } from './doc-adapter.js';
import { createDiagnosticsList } from './diagnostics-list.js';
import { createPipeline } from './pipeline.js';
import { gateShareLink, gateShareLinkComposition } from './admission-gate.js';
import { admit } from '../organs/admission/index.js';
import { renderReport } from '../organs/admission/report.js';
import { createTransport } from './surfaces/transport.js';
import { createUniformsPanel } from './surfaces/uniforms.js';
import { createRecorder } from './surfaces/record.js';
import { createBufferBar } from './buffers.js';
import { mountComposition } from './composition-runtime.js';
import { compressComposition, decompressComposition } from './multipass-share.js';
import { checkStatic } from '../organs/admission/static.js';

/**
 * Mount the editor.
 * @param {{root:HTMLElement, params:URLSearchParams, registry:{load:Function}}} ctx
 *   params is the hash query (?k=<id> | ?src=<b64url>&lang=[&v=2]); registry.load()
 *   fetches kernels.json — called only when a `k` param actually needs it.
 * @returns {Promise<Function>} cleanup
 */
export async function mount(ctx) {
  const { root, params, registry, bus } = ctx;
  root.replaceChildren();

  /* ---------- DOM ---------- */
  const wrap = el('div', 'editor-wrap');

  const canvasPane = el('div', 'editor-canvas-pane');
  const canvasHost = el('div', 'editor-canvas-host');
  const badgeRow = el('div', 'editor-badges');
  const backendBadge = el('span', 'badge badge-backend', '…');
  const fpsBadge = el('span', 'badge badge-fps', '');
  badgeRow.append(backendBadge, fpsBadge);
  const transport = createTransport({ getRuntime: () => runtime });
  const uniformsPanel = createUniformsPanel({
    getRuntime: () => runtime, getSource: () => editor.getValue(), getLanguage: () => mode.id,
  });
  const recorder = createRecorder({ getRuntime: () => runtime });
  transport.el.append(recorder.el);
  canvasPane.append(canvasHost, badgeRow, uniformsPanel.el, transport.el);

  const codePane = el('div', 'editor-code-pane');
  const toolbar = el('div', 'editor-toolbar');

  const langGroup = el('div', 'seg-group');
  const modeButtons = new Map(); // mode.id -> button, insertion order = MODES order
  for (const mode of MODES) {
    const btn = el('button', 'seg-btn', mode.label);
    btn.type = 'button';
    modeButtons.set(mode.id, btn);
    langGroup.append(btn);
  }

  const statusPill = el('span', 'pill', 'idle');

  const spacer = el('div', 'toolbar-spacer');
  const shareBtn = el('button', 'btn btn-small', 'Share');
  // ADM-D: on-demand full pipeline for editor-self (admission design §8's
  // policy-table exception — typing itself stays static-only advisory,
  // pipeline.js).
  const checkBtn = el('button', 'btn btn-small btn-ghost', 'Check shader');
  const suggestBtn = el('button', 'btn btn-small', 'Suggest for gallery');
  const backLink = el('a', 'btn btn-small btn-ghost', '← garden');
  backLink.setAttribute('href', '#/');
  shareBtn.type = checkBtn.type = suggestBtn.type = 'button';
  // ADM-D: Suggest opens with a verdict fenced in the issue body (§9 below) —
  // it stays disabled until a "Check shader" run on the CURRENT source is safe.
  suggestBtn.disabled = true;
  suggestBtn.title = 'Run "Check shader" first — Suggest needs a safe verdict on the current source';

  toolbar.append(langGroup, statusPill, spacer, shareBtn, checkBtn, suggestBtn, backLink);

  const logPre = el('pre', 'error-log');
  logPre.hidden = true;
  const checkReportHost = el('div', 'check-report-host'); // ADM-D: "Check shader"'s full report, inline (never a scrim — never blocks typing)
  checkReportHost.hidden = true;

  /* ---------- state ---------- */
  let mode = MODES[0];
  let runtime = null; // single-kernel runtime — null while composition mode is active
  let compositionRuntime = null; // COMP-2 — null in single-pass mode
  let disposed = false;
  let langSeq = 0; // serializes activateMode: a newer call invalidates in-flight ones
  let gate = null; // single-pass share-link admission gate (ADM-A); null off that surface
  let compGate = null; // COMP-2: composed share-link admission gate
  let compDebounce = null;
  let lastCheck = null; // ADM-D: {source, lang, report} from the last "Check shader" run; invalidated by any edit

  function syncActiveDoc() { bufferBar.setSrc(bufferBar.active, editor.getValue()); }

  const bufferBar = createBufferBar({
    onSwitch(prevId, nextId) {
      bufferBar.setSrc(prevId, editor.getValue());
      editor.setValue(bufferBar.getSrc(nextId) || '');
      editor.setDiagnostics([]);
      if (editorKind === 'textarea') diagList.render([]);
      showLog('');
      invalidateCheck(); // ADM-D: the active tab defines "the current source"
    },
    onChange() {
      if (bufferBar.hasBuffers()) {
        if (!compositionRuntime && !compGate) enterCompositionMode();
        else if (compositionRuntime) mountCompositionRuntime(); // structural edit (add/remove/rewire) — cheap enough to always fully remount
      } else if (compositionRuntime || compGate) {
        exitCompositionMode();
      }
    },
  });

  function clearScrim() { if (gate && gate.scrim) { gate.scrim.remove(); gate.scrim = null; } }
  function clearCompScrim() { if (compGate && compGate.scrim) { compGate.scrim.remove(); compGate.scrim = null; } }
  // ADM-D: any edit/mode-switch/tab-switch reclassifies the source as
  // unchecked — Suggest re-locks until "Check shader" runs again.
  function invalidateCheck() { lastCheck = null; suggestBtn.disabled = true; checkReportHost.hidden = true; }

  // ED-4: the report's "Run it" consent (design §9) — runs the withheld
  // source AS-IS, no edit required. Distinct from clearScrim()'s other path
  // (the user's own first edit): this one recompiles the exact admitted
  // source instead of whatever the user typed.
  function runAnyway() { clearScrim(); pipeline.recompile(); }
  function runCompositionAnyway() { clearCompScrim(); mountCompositionRuntime(); }

  function setStatus(kind, label) {
    statusPill.className = 'pill ' + kind; // 'ok' | 'err' | ''
    statusPill.textContent = label;
  }

  function showLog(log) {
    if (log) {
      logPre.textContent = log; // verbatim compiler log, textContent only
      logPre.hidden = false;
    } else {
      logPre.textContent = '';
      logPre.hidden = true;
    }
  }

  /* ---------- initial source ---------- */
  const kernelId = params.get('k');
  const srcParam = params.get('src');
  const isMultipass = !!srcParam && params.get('v') === '2';
  let initial = mode.starter;
  let pendingComposition = null; // COMP-2: decoded {common,image,buffers}, consumed by bootComposition()

  if (isMultipass) {
    mode = MODES.find((m) => m.id === 'glsl') || mode; // buffer tabs are GLSL-only
    try {
      const decoded = await decompressComposition(srcParam);
      if (Array.isArray(decoded.buffers) && decoded.buffers.length > 0) {
        pendingComposition = decoded;
        initial = decoded.image.src || mode.starter;
      } else {
        initial = decoded.image.src || mode.starter; // no buffers in the payload — behaves like a plain share
      }
    } catch {
      initial = mode.starter;
      toast('Could not decode shared composition — loaded a starter shader');
    }
  } else if (srcParam) {
    const langParam = params.get('lang');
    const requested = MODES.find((m) => m.id === langParam);
    if (requested) mode = requested;
    try {
      initial = await decompress(srcParam);
      // Share-link source is third-party by definition (G1) — gate autorun
      // on the static tier before the runtime ever sees it.
      gate = await gateShareLink(initial, mode.id, runAnyway);
    } catch {
      initial = mode.starter;
      toast('Could not decode shared link — loaded a starter shader');
    }
  } else if (kernelId) {
    // Pure ?src= sessions never reach here — kernels.json is fetched only
    // when a ?k= param actually needs it (idle-costs-zero, substrate P4).
    try {
      const data = await registry.load();
      const kernel = data.kernels.find((k) => k.id === kernelId);
      if (kernel && typeof kernel.glsl === 'string') {
        initial = kernel.glsl;
      } else {
        toast('Kernel not found — loaded a starter shader');
      }
    } catch {
      toast('Could not load kernels.json — loaded a starter shader');
    }
  }
  // ctx.alive(): a nav-away during the registry.load()/gateShareLink() await
  // above is otherwise invisible here (loader mid-mount staleness gap).
  if (disposed || !ctx.alive()) return () => {};

  // clearScrim(): the user's own edit reclassifies this session as editor-self.
  const { adapter: editor, kind: editorKind } = await createDocAdapter(initial, () => {
    invalidateCheck(); // ADM-D: the user's own edit unchecks the source
    if (bufferBar.hasBuffers()) { clearCompScrim(); scheduleCompositionRecompile(); return; }
    clearScrim();
    pipeline.scheduleCompile();
  });
  if (disposed) { editor.destroy(); return () => {}; }
  const lineParam = parseInt(params.get('line'), 10); // GARDEN-0's probe panel opens the editor here
  if (Number.isFinite(lineParam)) editor.focusLine(lineParam);
  // diagList is the textarea fallback's diagnostic surface (§4) — CM gets
  // squiggles + gutter dots from editor.setDiagnostics instead, so the list
  // stays mounted-but-empty (hidden) when the CM adapter is active.
  const diagList = createDiagnosticsList(editor);

  const pipeline = createPipeline({
    getRuntime: () => runtime,
    getSource: () => editor.getValue(),
    getLanguage: () => mode.id,
    isDisposed: () => disposed,
    setStatus,
    showLog,
    setDiagnostics: (msgs) => {
      editor.setDiagnostics(msgs);
      if (editorKind === 'textarea') diagList.render(msgs);
    },
    onCompiled: (res) => {
      uniformsPanel.rescan();
      bus.emit('shader.compiled.v1', {
        shader_id: kernelId || undefined,
        language: mode.id === 'wgsl' ? 'wgsl' : 'glsl',
        ok: res.ok,
        log_excerpt: res.log ? res.log.slice(0, 200) : null,
        duration_ms: res.duration_ms,
        backend: mode.backend === 'WebGPU' ? 'webgpu' : 'webgl2',
      });
    },
  });

  codePane.append(toolbar, bufferBar.el, editor.el, diagList.el, logPre, checkReportHost);
  wrap.append(canvasPane, codePane);
  root.append(wrap);

  function disposeRuntime() {
    recorder.destroy(); // a mode switch tears down the canvas an in-flight recording targets
    if (runtime) {
      try { runtime.dispose(); } catch { /* already gone */ }
      runtime = null;
    }
    canvasHost.replaceChildren(); // a canvas can hold only one context type
    editor.setDiagnostics([]); // stale diagnostics don't survive a mode/runtime swap
    diagList.render([]);
  }

  async function activateMode(next) {
    if (bufferBar.hasBuffers()) return; // COMP-2: mode is locked to GLSL while buffers exist
    const seq = ++langSeq;
    mode = next;
    for (const [id, btn] of modeButtons) btn.classList.toggle('active', id === mode.id);
    disposeRuntime();
    await editor.setLanguage(mode);
    if (disposed || seq !== langSeq) return; // superseded while awaiting the language load

    const canvas = document.createElement('canvas');
    canvas.className = 'editor-canvas';
    canvasHost.append(canvas);

    backendBadge.textContent = mode.backend;
    const created = await mode.createRuntime(canvas);
    // A newer activateMode superseded this one while createRuntime() was
    // pending — never overwrite the runtime it installed (leak + wrong-mode
    // compile). !ctx.alive() catches a plain nav-away during this same
    // await, which never re-calls activateMode at all.
    if (disposed || seq !== langSeq || !ctx.alive()) { if (created) created.dispose(); return; }
    if (!created) {
      setStatus('err', 'error');
      showLog(mode.unsupportedMessage);
      fpsBadge.textContent = '';
      return;
    }
    runtime = created;

    wirePerf(runtime, fpsBadge, () => transport.scale);
    runtime.onContextLost = () => {
      if (disposed || seq !== langSeq) return;
      setStatus('err', 'error');
      showLog('The GPU context was lost — rebuilding the renderer…');
      activateMode(mode);
    };
    transport.onRuntimeReady(runtime); // re-applies transport's own paused/scale state (survives a mode switch)
    uniformsPanel.onRuntimeReady(runtime);
    uniformsPanel.rescan();
    // A share-link source with the scrim still up hasn't been admitted for
    // autorun yet — the user's first edit (clearScrim) reclassifies it.
    if (!(gate && gate.scrim)) await pipeline.recompile();
  }

  /* ---------- COMP-2: composition mode ---------- */

  function setSinglePassSurfacesHidden(hidden) {
    transport.el.hidden = hidden;
    uniformsPanel.el.hidden = hidden;
  }

  function applyActiveDiagnostics(log, findings, isReject) {
    setStatus(log ? 'err' : 'ok', log ? 'error' : 'ok');
    showLog(log);
    const msgs = findings.map((f) => ({ line: 1, severity: isReject ? 'error' : 'warning', text: f, wholeDoc: true }));
    editor.setDiagnostics(msgs);
    if (editorKind === 'textarea') diagList.render(msgs);
  }

  function mountCompositionRuntime() {
    syncActiveDoc();
    if (compositionRuntime) { try { compositionRuntime.dispose(); } catch { /* already gone */ } compositionRuntime = null; }
    canvasHost.replaceChildren();
    const { reject, findings, order, passes } = bufferBar.passesForCompile();
    if (reject) {
      backendBadge.textContent = 'graph error';
      fpsBadge.textContent = '';
      applyActiveDiagnostics(findings.join('\n'), [], true);
      return;
    }
    compositionRuntime = mountComposition(canvasHost, { passes, order });
    backendBadge.textContent = compositionRuntime.backend === 'webgl2' ? 'WebGL2 (composition)' : 'unsupported';
    fpsBadge.textContent = '';
    const bad = (compositionRuntime.firstCompileResults || []).find((r) => !r.ok);
    applyActiveDiagnostics(bad ? bad.log : '', [], false);
  }

  function enterCompositionMode() {
    langSeq++; // supersede any in-flight single-pass activateMode() (e.g. a context-loss rebuild)
    clearScrim();
    disposeRuntime();
    setSinglePassSurfacesHidden(true);
    bufferBar.setEnabled(false);
    mountCompositionRuntime();
  }

  function exitCompositionMode() {
    clearCompScrim();
    compGate = null;
    if (compositionRuntime) { try { compositionRuntime.dispose(); } catch { /* already gone */ } compositionRuntime = null; }
    canvasHost.replaceChildren();
    setSinglePassSurfacesHidden(false);
    bufferBar.setEnabled(mode.id === 'glsl');
    activateMode(mode);
  }

  function scheduleCompositionRecompile() {
    clearTimeout(compDebounce);
    compDebounce = setTimeout(recompileActivePass, 400);
  }

  // Body-text edit of the active tab (or Common, which every pass embeds) —
  // recompiles only the affected program(s) in place, never touches the
  // fixed render order (a structural edit — add/remove/rewire — goes through
  // bufferBar's own onChange -> mountCompositionRuntime() instead).
  function recompileActivePass() {
    if (!compositionRuntime || disposed) return;
    syncActiveDoc();
    const { reject, findings, passes } = bufferBar.passesForCompile();
    if (reject) { applyActiveDiagnostics(findings.join('\n'), [], true); return; }
    const active = bufferBar.active;
    const toRecompile = active === 'Common' ? passes : passes.filter((p) => p.id === active);
    const advisory = [];
    let ok = true, lastLog = '';
    for (const p of toRecompile) {
      const r = compositionRuntime.recompilePass(p.id, p.fullSource, p.channelSlots);
      if (!r.ok) { ok = false; lastLog = `[${p.id}] ${r.log}`; }
      advisory.push(...checkStatic(p.fullSource, 'glsl').findings.map((f) => `[${p.id}] ${f}`));
    }
    applyActiveDiagnostics(ok ? '' : lastLog, advisory, false);
    bus.emit('shader.compiled.v1', { language: 'glsl', ok, log_excerpt: ok ? null : lastLog.slice(0, 200), duration_ms: 0, backend: 'webgl2' });
  }

  async function bootComposition() {
    bufferBar.load(pendingComposition);
    disposeRuntime();
    setSinglePassSurfacesHidden(true);
    bufferBar.setEnabled(false);
    backendBadge.textContent = 'checking…';
    const { passes } = bufferBar.passesForCompile();
    compGate = await gateShareLinkComposition(passes, runCompositionAnyway);
    if (disposed || !ctx.alive()) return;
    if (compGate.scrim) canvasPane.append(compGate.scrim);
    else mountCompositionRuntime();
  }

  /* ---------- events ---------- */
  for (const target of MODES) {
    modeButtons.get(target.id).addEventListener('click', () => {
      if (mode.id === target.id) return;
      if (bufferBar.hasBuffers()) { toast('Buffer tabs are GLSL-only — remove all buffers first'); return; }
      clearScrim();
      invalidateCheck(); // ADM-D: a language switch is a different "current source"
      const otherStarters = MODES.filter((m) => m.id !== target.id).map((m) => m.starter.trim());
      const current = editor.getValue().trim();
      if (otherStarters.includes(current) || current === '') {
        editor.setValue(target.starter);
      }
      activateMode(target);
    });
  }

  shareBtn.addEventListener('click', async () => {
    try {
      let url;
      if (bufferBar.hasBuffers()) {
        syncActiveDoc();
        const b64 = await compressComposition(bufferBar.serialize());
        url = absoluteShareUrl(b64, 'glsl') + '&v=2';
      } else {
        const b64 = await compress(editor.getValue());
        url = absoluteShareUrl(b64, mode.id) + transport.shareQuery(); // additive &t=&paused=&scale= — v1 ignores them
      }
      const ok = await copyText(url);
      toast(ok ? 'Link copied to clipboard' : 'Could not copy — see console');
      if (!ok) console.log('Share link:', url);
    } catch {
      toast('Could not build the share link');
    }
  });

  // ADM-D: on-demand admission for the user's own current source — runs the
  // FULL pipeline (forceSacrificial) unlike ordinary editor-self typing,
  // which stays static-only/advisory (pipeline.js). Never runs on a
  // keystroke; only this explicit click. Gates Suggest below.
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    const source = editor.getValue(), lang = mode.id;
    setStatus('', 'checking…');
    try {
      const report = await admit(source, {
        language: lang, surface: 'editor-self', forceSacrificial: true,
        onProgress: (p) => setStatus('', 'checking (' + p.phase + ')…'),
      });
      lastCheck = { source, lang, report };
      suggestBtn.disabled = !report.safe;
      checkReportHost.replaceChildren(renderReport(report));
      checkReportHost.hidden = false;
      setStatus(report.safe ? 'ok' : 'err', report.verdict);
    } catch {
      toast('Check shader failed — see console');
    } finally {
      checkBtn.disabled = false;
    }
  });

  suggestBtn.addEventListener('click', async () => {
    if (!lastCheck || lastCheck.source !== editor.getValue() || lastCheck.lang !== mode.id || !lastCheck.report.safe) {
      toast('Run "Check shader" first — Suggest needs a safe verdict on the current source');
      return;
    }
    try {
      const { report, source, lang } = lastCheck;
      const b64 = await compress(source);
      const link = absoluteShareUrl(b64, lang);
      const title = 'Gallery suggestion: ' + lang.toUpperCase() + ' kernel';
      const { preview_png, ...verdict } = report; // ADM-D: fenced block excludes the preview (URL-length-safe)
      const envelopeJson = JSON.stringify(
        { specversion: '1.0', type: 'garden.admission.evaluated.v1', source: '/garden/admission', data: verdict },
        null, 2,
      );
      const body =
        '**Live link:** ' + link + '\n\n' +
        '**Language:** ' + lang + '\n\n' +
        '**What it does:**\n\n_describe your kernel here_\n\n' +
        '**Where it came from:** (hand-written / evolved / remix of a garden kernel)\n\n' +
        '**Admission verdict:**\n```json\n' + envelopeJson + '\n```\n';
      window.open(githubIssueUrl(title, body), '_blank', 'noopener');
    } catch {
      toast('Could not build the suggestion link');
    }
  });

  /* ---------- boot ---------- */
  if (pendingComposition) {
    await bootComposition();
  } else {
    await activateMode(mode);
    transport.applyShareParams(params); // additive &t=&paused=&scale= — no-op on older links
    if (gate && gate.scrim) canvasPane.append(gate.scrim);
  }

  return function cleanup() {
    disposed = true;
    clearTimeout(compDebounce);
    pipeline.cancel();
    transport.destroy();
    uniformsPanel.destroy();
    disposeRuntime();
    if (compositionRuntime) { try { compositionRuntime.dispose(); } catch { /* already gone */ } compositionRuntime = null; }
    editor.destroy();
    root.replaceChildren();
  };
}
