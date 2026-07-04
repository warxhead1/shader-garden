// Shader Garden — editor/pipeline.js
// Debounced recompile with a staleness guard: a newer compile always wins
// over a slower in-flight one (async runtime.setShader can resolve out of
// order across a rapid burst of keystrokes). Every compile also runs the
// SG-Sxx static screen (organs/admission/static.js) and merges its findings
// into setDiagnostics as advisory-only — ruling C5: editor-self typing is
// never blocked, findings are diagnostics, never a gate.
import { checkStatic } from '../organs/admission/static.js';

const DEBOUNCE_MS = 400;

// SG-Sxx findings carry no line info (regex-level, not per-line) — surface
// them as whole-doc warnings alongside the compiler's own messages. The
// 'SG-Sxx:' prefix stays in the text: vocabulary is shown, not hidden.
function toStaticDiagnostic(finding) {
  return { line: 1, severity: 'warning', text: finding, wholeDoc: true };
}

export function createPipeline({ getRuntime, getSource, getLanguage, isDisposed, setStatus, showLog, setDiagnostics, onCompiled }) {
  let debounceTimer = null;
  let compileSeq = 0;

  async function recompile() {
    if (isDisposed()) return;
    const runtime = getRuntime();
    if (!runtime) {
      setStatus('err', 'error');
      return;
    }
    const seq = ++compileSeq;
    const source = getSource();
    const t0 = performance.now();
    let res;
    try {
      res = await runtime.setShader(source);
    } catch (e) {
      res = { ok: false, log: String((e && e.message) || e), messages: [] };
    }
    if (isDisposed() || seq !== compileSeq) return;
    if (res && res.ok) {
      setStatus('ok', 'ok');
      showLog('');
    } else {
      setStatus('err', 'error');
      showLog((res && res.log) || 'compile failed');
    }
    const { findings } = checkStatic(source, getLanguage());
    setDiagnostics?.([...((res && res.messages) || []), ...findings.map(toStaticDiagnostic)]);
    // ED-4: shader.compiled.v1 — editor's own compile-fact emission (the
    // substrate event table's other named emitter besides the viewer).
    onCompiled?.({ ok: !!(res && res.ok), log: (res && res.log) || '', duration_ms: performance.now() - t0 });
  }

  function scheduleCompile() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recompile, DEBOUNCE_MS);
  }

  function cancel() {
    clearTimeout(debounceTimer);
  }

  return { recompile, scheduleCompile, cancel };
}
