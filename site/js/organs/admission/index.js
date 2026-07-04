// Shader Garden — organs/admission/index.js
// Admission's one entry point. Lazy (editor organ only), zero cost on a
// gallery/viewer visit. C4: only admit() invokes it, no bus request/reply;
// C3: ONLY emitter of garden.admission.evaluated.v1, source /garden/admission.
// Full verdict model both languages via the sacrificial worker + watchdog
// (§6.3): WGSL headless-texture WebGPU (ADM-B), GLSL OffscreenCanvas WebGL2
// (ADM-C, headless-testable under SwiftShader). No usable worker API ->
// compile-only ladder (§6.1), SG-S30. editor-self is sacrificial-free (G5).

import { bindSource } from '../../core/bus.js';
import { checkStatic, checkCompositionGraph } from './static.js';
import { wrapGlsl, wrapWgsl } from '../../runtime/wrap.js';

const bus = bindSource('/garden/admission');

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = new Uint8Array(10);
  crypto.getRandomValues(rnd);
  let rand = '', bits = 0, acc = 0;
  for (const byte of rnd) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; rand += B32[(acc >>> bits) & 31]; }
  }
  return time + rand;
}

// Pillar 4: policy is data. editor-self autoruns every verdict (own GPU);
// share-link/suggestion/embed narrow per admission design §8.
const POLICY = {
  'editor-self': { staticTier: false, sacrificial: false, autorunOn: ['OK', 'WA', 'VF', 'CE', 'RE', 'TLE', 'MLE'] },
  'share-link': { staticTier: true, sacrificial: true, autorunOn: ['OK', 'WA'] },
  suggestion: { staticTier: true, sacrificial: true, autorunOn: [] },
  embed: { staticTier: true, sacrificial: true, autorunOn: ['OK'] },
};

// §6.3 deadlines; frame deadline + resolution halve when SG-S20 fired.
const WATCHDOG = { contextMs: 1000, compileMs: 2500, frameMs: 800, frameMsHalved: 400 };
const TOTAL_BUDGET_MS = { 'share-link': 4000, suggestion: 8000, embed: 4000 };
// COMP-2 (v2 §7.5): composed admission happy path <= 1.5x the single-pass
// budget — applied to the hard wall-clock ceiling too, for one consistent
// multiplier rather than a second hand-picked number.
const TOTAL_BUDGET_MS_COMPOSITION = Math.round(TOTAL_BUDGET_MS['share-link'] * 1.5);

/** Cheap synchronous policy lookup — callers can check before lazy-loading admission at all. */
export function policyFor(surface) {
  return POLICY[surface] || POLICY['editor-self'];
}

// Last 100 envelopes (§7.3 export) — own ring, apart from bus.js's global one.
const RING_MAX = 100;
const ring = [];
function remember(envelope) {
  ring.push(envelope);
  if (ring.length > RING_MAX) ring.shift();
}
/** Last (up to 100) garden.admission.evaluated.v1 envelopes, newest last. */
export function recentAdmissions() { return ring.slice(); }

/** Live sacrificial-worker count — test/devtools introspection only. */
let activeWorkers = 0;
export function _activeWorkerCount() { return activeWorkers; }

function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// The four preadmit.v1 render_metrics keys ONLY (§6.5/§7.3). color_diversity
// <=1/256 (one quantized color) covers all-black AND all-white; NaN can't
// survive an 8-bit unorm readback so it surfaces the same way — documented.
function metricsFromPixels(bytes, size) {
  const n = size * size;
  const lumas = new Array(n);
  const colors = new Set();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    lumas[i] = luma(bytes[o] / 255, bytes[o + 1] / 255, bytes[o + 2] / 255);
    colors.add(((bytes[o] >> 4) << 8) | ((bytes[o + 1] >> 4) << 4) | (bytes[o + 2] >> 4));
  }
  lumas.sort((a, b) => a - b);
  const pct = (q) => lumas[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  const brightness_mean = lumas.reduce((a, b) => a + b, 0) / n;
  const p95 = pct(0.95), p5 = pct(0.05);
  return {
    brightness_mean,
    contrast_ratio: p5 > 0 ? p95 / p5 : (p95 > 0 ? 255 : 1),
    color_diversity: colors.size / 256,
  };
}

function isDegenerate(m) { return m.brightness_mean < 1 / 255 || m.color_diversity <= 1 / 256; }

async function previewFromPixels(buf, size) {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  try {
    const c = new OffscreenCanvas(size, size);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.slice(0)), size, size), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return 'data:image/png;base64,' + btoa(bin);
  } catch {
    return undefined;
  }
}

// Sacrificial worker, both languages. Resolves {fallback:true} when the
// worker has no usable GPU API for `language` (§6.1 ladder trigger), else {report:{...}}.
function runWorker(source, language, cfg, onProgress) {
  const backend = language === 'wgsl' ? 'webgpu' : 'webgl2';
  const NO_GPU = new Set(['no-webgpu-in-worker', 'no-adapter', 'no-webgl2-in-worker', 'no-offscreencanvas-in-worker']);
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL('./sac-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve({ fallback: true });
      return;
    }
    activeWorkers++;
    const seq = crypto.getRandomValues(new Uint32Array(1))[0];
    let settled = false;
    let phaseTimer = null;
    let compileMs = 0;
    const totalTimer = setTimeout(() => finish(tle('total admission budget exceeded')), cfg.budgetMs);
    function tle(why) {
      return { verdict: 'TLE', crash_risk: 'timeout', safe: false, backend, stages: { compile_ms: compileMs }, compile_log: why };
    }
    function arm(ms, phase) {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => finish(tle(`no heartbeat during '${phase}' within ${ms}ms`)), ms);
    }
    function finish(fields) {
      if (settled) return;
      settled = true;
      clearTimeout(phaseTimer);
      clearTimeout(totalTimer);
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.terminate(); } catch { /* already gone */ }
      activeWorkers--;
      resolve(fields.fallback ? fields : { report: fields });
    }

    arm(WATCHDOG.contextMs, 'context');
    onProgress?.({ phase: 'context' });
    worker.onmessage = async (e) => {
      const m = e.data;
      if (!m || m.seq !== seq || settled) return;
      if (m.ev === 'phase') {
        onProgress?.({ phase: m.phase, n: m.n });
        if (m.phase === 'compile') arm(WATCHDOG.compileMs, 'compile');
        else if (m.phase === 'frame') arm(cfg.frameMs, 'frame');
      } else if (m.ev === 'compiled') {
        compileMs = m.ms;
        if (!m.ok) finish({ verdict: 'CE', crash_risk: 'compile', safe: false, backend, stages: { compile_ms: m.ms }, compile_log: m.log });
        else arm(WATCHDOG.compileMs, 'compile'); // pipeline/link still counts against the compile deadline
      } else if (m.ev === 'lost') {
        finish({ verdict: 'RE', crash_risk: 'runtime', safe: false, backend, stages: { compile_ms: compileMs }, compile_log: `device lost: ${m.reason}` });
      } else if (m.ev === 'oom') {
        finish({ verdict: 'MLE', crash_risk: 'memory', safe: false, backend, stages: { compile_ms: compileMs } });
      } else if (m.ev === 'fatal') {
        if (NO_GPU.has(m.message)) finish({ fallback: true });
        else finish({ verdict: 'RE', crash_risk: 'compile', safe: false, backend, stages: { compile_ms: compileMs }, compile_log: m.message });
      } else if (m.ev === 'frames') {
        const pixels = new Uint8Array(m.pixels);
        const metrics = metricsFromPixels(pixels, cfg.size);
        const degenerate = isDegenerate(metrics);
        finish({
          verdict: degenerate ? 'WA' : 'OK', crash_risk: 'none', safe: true, backend,
          stages: { compile_ms: compileMs, frames_ms: m.ms },
          render_metrics: { render_time_ms: m.ms, ...metrics },
          preview_png: await previewFromPixels(pixels, cfg.size),
          extraFinding: degenerate ? 'SG-S40: degenerate-output (near-uniform brightness/color at the t=1.5 probe)' : undefined,
        });
      }
    };
    worker.onerror = (e) => finish({ verdict: 'RE', crash_risk: 'compile', safe: false, backend, compile_log: String(e.message || e) });
    worker.postMessage({
      op: 'run', seq, language, source, frames: 3, size: cfg.size,
      frameDeadlineMs: cfg.frameMs, testHang: cfg.testHang || undefined,
    });
  });
}

// §6.1 ladder: real compile on a separate sacrificial device/context
// (scoped there, never the page's own runtime). No frame/readback; caps at OK/CE + SG-S30.
async function compileOnlyWgsl(source) {
  const t0 = performance.now();
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { verdict: 'OK', crash_risk: 'none', safe: true, backend: 'none', compile_ms: performance.now() - t0, extraFinding: 'SG-S30: frames-unverified (no WebGPU available)' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { verdict: 'OK', crash_risk: 'none', safe: true, backend: 'none', compile_ms: performance.now() - t0, extraFinding: 'SG-S30: frames-unverified (no adapter)' };
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code: wrapWgsl(source) });
    const info = await module.getCompilationInfo();
    const scopeErr = await device.popErrorScope();
    const log = info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`).join('\n');
    const hasError = info.messages.some((m) => m.type === 'error');
    device.destroy();
    const compile_ms = performance.now() - t0;
    if (hasError || (scopeErr && info.messages.length === 0)) {
      return { verdict: 'CE', crash_risk: 'compile', safe: false, backend: 'webgpu', compile_ms, compile_log: log || (scopeErr ? scopeErr.message : 'compilation failed') };
    }
    return { verdict: 'OK', crash_risk: 'none', safe: true, backend: 'webgpu', compile_ms, extraFinding: 'SG-S30: frames-unverified (compile-only ladder, no worker GPU)' };
  } catch (err) {
    return { verdict: 'OK', crash_risk: 'none', safe: true, backend: 'none', compile_ms: performance.now() - t0, extraFinding: `SG-S30: frames-unverified (${String(err).slice(0, 80)})` };
  }
}

// §6.1 ladder fallback when the GLSL worker path is unavailable — a real
// compile on a throwaway, unattached WebGL2 context.
function compileOnlyGlsl(source) {
  const t0 = performance.now();
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { verdict: 'OK', crash_risk: 'none', safe: true, backend: 'none', compile_ms: performance.now() - t0, extraFinding: 'SG-S30: frames-unverified (no WebGL2 context available)' };
    const shader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(shader, wrapGlsl(source));
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    const log = gl.getShaderInfoLog(shader) || '';
    gl.deleteShader(shader);
    const compile_ms = performance.now() - t0;
    if (!ok) return { verdict: 'CE', crash_risk: 'compile', safe: false, backend: 'webgl2', compile_ms, compile_log: log };
    return { verdict: 'OK', crash_risk: 'none', safe: true, backend: 'webgl2', compile_ms, extraFinding: 'SG-S30: frames-unverified (compile-only ladder, no sacrificial worker for GLSL yet)' };
  } catch (err) {
    return { verdict: 'RE', crash_risk: 'compile', safe: false, backend: 'none', compile_ms: performance.now() - t0, compile_log: String(err) };
  }
}

// Merges a worker patch (nested `stages`, optional `extraFinding`) or a
// ladder patch (flat `compile_ms`) into `base`. Also fixes a real bug this
// refactor caught: naively spreading a patch's own `stages` over
// `base.stages` silently dropped `static_ms`.
function mergeReport(base, patch) {
  const { extraFinding, stages, compile_ms, ...rest } = patch;
  return {
    ...base, ...rest,
    static_findings: extraFinding ? [...base.static_findings, extraFinding] : base.static_findings,
    stages: { ...base.stages, ...(stages || (compile_ms !== undefined ? { compile_ms } : {})) },
  };
}

async function runSacrificial(source, language, base, opts, onProgress) {
  const halved = base.static_findings.some((f) => f.startsWith('SG-S20'));
  const cfg = {
    frameMs: halved ? WATCHDOG.frameMsHalved : WATCHDOG.frameMs,
    size: halved ? 32 : 64,
    budgetMs: opts.budgetMs || TOTAL_BUDGET_MS[base.surface] || TOTAL_BUDGET_MS['share-link'],
    testHang: opts._testHang,
  };

  if (typeof Worker !== 'undefined') {
    const outcome = await runWorker(source, language, cfg, onProgress);
    if (!outcome.fallback) return mergeReport(base, outcome.report);
    // §6.1: worker had no usable GPU API for this language — ladder below.
  }
  const ladder = language === 'wgsl' ? await compileOnlyWgsl(source) : compileOnlyGlsl(source);
  return mergeReport(base, ladder);
}

/**
 * Run the admission pipeline. Resolves ALWAYS — machinery failures become
 * verdicts (RE/TLE/OK+SG-S30), never a rejection.
 * @param {string} source mainImage-form shader body, no preamble
 * @param {{language:'glsl'|'wgsl', surface:string, shaderId?:string, budgetMs?:number,
 *   onProgress?:Function, forceSacrificial?:boolean}} opts
 *   forceSacrificial (ADM-D): the editor's "Check shader" button runs the FULL
 *   pipeline on demand for `editor-self` even though POLICY['editor-self']
 *   stays sacrificial:false for every OTHER caller (G5 — nothing auto-invokes
 *   this on a keystroke; pipeline.js's advisory checkStatic() is what typing
 *   actually runs). An explicit click is not the idle path.
 * @returns {Promise<object>} AdmissionReport (§4.2)
 */
export async function admit(source, opts) {
  const { language, surface, shaderId, onProgress, forceSacrificial } = opts;
  onProgress?.({ phase: 'static' });
  const t0 = performance.now();
  const { reject, findings } = checkStatic(source, language);
  const static_ms = performance.now() - t0;

  const base = {
    shader_id: shaderId || ulid(),
    language, kind: 'fragment', surface, backend: 'none',
    static_findings: findings.slice(),
    stages: { static_ms },
  };

  let report;
  if (reject) {
    report = { ...base, verdict: 'VF', crash_risk: 'none', safe: false };
  } else {
    const policy = policyFor(surface);
    if (!policy.sacrificial && !forceSacrificial) {
      report = {
        ...base, verdict: 'OK', crash_risk: 'none', safe: true,
        static_findings: [...findings, 'SG-S30: frames-unverified (no sacrificial tier for this surface)'],
      };
    } else {
      report = await runSacrificial(source, language, base, opts, onProgress);
    }
  }

  const envelope = bus.emit('garden.admission.evaluated.v1', report);
  remember(envelope);
  return report;
}

// COMP-2: one worker invocation plays the WHOLE composed graph (GLSL only —
// no WGSL multi-pass player exists in this tree). Mirrors runWorker()'s
// watchdog shape but simpler: no NO_GPU fallback ladder (a browser new
// enough for OffscreenCanvas WebGL2 — already required by ADM-C — has
// everything this needs), and `pass` on 'phase'/'compiled' events just
// enriches the report/watchdog-timeout log with which pass was in flight.
function runCompositionWorker(passes, order, cfg, onProgress) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL('./sac-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve({ verdict: 'OK', crash_risk: 'none', safe: true, backend: 'none', extraFinding: 'SG-S30: frames-unverified (no worker available)' });
      return;
    }
    activeWorkers++;
    const seq = crypto.getRandomValues(new Uint32Array(1))[0];
    let settled = false, phaseTimer = null, compileMs = 0, currentPass = null;
    const totalTimer = setTimeout(() => finish(tle('total admission budget exceeded')), cfg.budgetMs);
    function tle(why) {
      return { verdict: 'TLE', crash_risk: 'timeout', safe: false, backend: 'webgl2', stages: { compile_ms: compileMs }, compile_log: (currentPass ? `[${currentPass}] ` : '') + why };
    }
    function arm(ms, phase) {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => finish(tle(`no heartbeat during '${phase}' within ${ms}ms`)), ms);
    }
    function finish(fields) {
      if (settled) return;
      settled = true;
      clearTimeout(phaseTimer);
      clearTimeout(totalTimer);
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.terminate(); } catch { /* already gone */ }
      activeWorkers--;
      resolve(fields);
    }

    arm(WATCHDOG.contextMs, 'context');
    onProgress?.({ phase: 'context' });
    worker.onmessage = async (e) => {
      const m = e.data;
      if (!m || m.seq !== seq || settled) return;
      if (m.ev === 'phase') {
        if (m.pass) currentPass = m.pass;
        onProgress?.({ phase: m.phase, n: m.n, pass: m.pass });
        if (m.phase === 'compile') arm(WATCHDOG.compileMs, 'compile');
        else if (m.phase === 'frame') arm(cfg.frameMs, 'frame');
      } else if (m.ev === 'compiled') {
        compileMs = m.ms;
        if (!m.ok) finish({ verdict: 'CE', crash_risk: 'compile', safe: false, backend: 'webgl2', stages: { compile_ms: m.ms }, compile_log: m.log });
        // ok:true only ever arrives once, after every pass linked (sac-worker.js) —
        // re-arm the compile deadline once more to cover the frame-loop's own startup.
        else arm(WATCHDOG.compileMs, 'compile');
      } else if (m.ev === 'lost') {
        finish({ verdict: 'RE', crash_risk: 'runtime', safe: false, backend: 'webgl2', stages: { compile_ms: compileMs }, compile_log: `device lost: ${m.reason}` });
      } else if (m.ev === 'oom') {
        finish({ verdict: 'MLE', crash_risk: 'memory', safe: false, backend: 'webgl2', stages: { compile_ms: compileMs } });
      } else if (m.ev === 'fatal') {
        finish({ verdict: 'RE', crash_risk: 'compile', safe: false, backend: 'webgl2', stages: { compile_ms: compileMs }, compile_log: (currentPass ? `[${currentPass}] ` : '') + m.message });
      } else if (m.ev === 'frames') {
        const pixels = new Uint8Array(m.pixels);
        const metrics = metricsFromPixels(pixels, cfg.size);
        const degenerate = isDegenerate(metrics);
        finish({
          verdict: degenerate ? 'WA' : 'OK', crash_risk: 'none', safe: true, backend: 'webgl2',
          stages: { compile_ms: compileMs, frames_ms: m.ms },
          render_metrics: { render_time_ms: m.ms, ...metrics },
          preview_png: await previewFromPixels(pixels, cfg.size),
          extraFinding: degenerate ? 'SG-S40: degenerate-output (near-uniform brightness/color at the t=1.5 probe)' : undefined,
        });
      }
    };
    worker.onerror = (e) => finish({ verdict: 'RE', crash_risk: 'compile', safe: false, backend: 'webgl2', compile_log: String(e.message || e) });
    worker.postMessage({ op: 'run-composition', seq, passes, order, frames: 3, size: cfg.size });
  });
}

/**
 * Admission for a multi-pass composition (COMP-2, editor buffer tabs).
 * SG-S08 (DAG shape) first, then the SG-Sxx static tier PER PASS (findings
 * prefixed `[<passId>]`), then ONE sacrificial worker run that plays the
 * whole graph — any pass's CE/RE/TLE/MLE verdicts the WHOLE composition
 * (§7.3 item 25's accept line), matching the one-worker-spawn budget model
 * instead of N separate admit() calls. GLSL only.
 * @param {Array<{id,target,fullSource,channelSlots,feedback}>} passes
 *   buffers.js's `passesForCompile().passes` shape.
 * @param {{surface:string, shaderId?:string, budgetMs?:number, onProgress?:Function}} opts
 * @returns {Promise<object>} AdmissionReport-shaped, plus `passes: string[]`
 */
export async function admitComposition(passes, opts) {
  const { surface, shaderId, onProgress } = opts;
  onProgress?.({ phase: 'static' });
  const t0 = performance.now();

  const graph = checkCompositionGraph(passes.map((p) => ({
    kernel: p.id, target: p.target, channels: (p.channelSlots || []).filter(Boolean), feedback: p.feedback,
  })));
  const findings = graph.findings.slice();
  let reject = graph.reject;

  if (!reject) {
    for (const p of passes) {
      const r = checkStatic(p.fullSource || '', 'glsl');
      findings.push(...r.findings.map((f) => `[${p.id}] ${f}`));
      if (r.reject) reject = true;
    }
  }

  const base = {
    shader_id: shaderId || ulid(), language: 'glsl', kind: 'composition', surface, backend: 'none',
    static_findings: findings, stages: { static_ms: performance.now() - t0 }, passes: passes.map((p) => p.id),
  };

  let report;
  if (reject) {
    report = { ...base, verdict: 'VF', crash_risk: 'none', safe: false };
  } else {
    const policy = policyFor(surface);
    if (!policy.sacrificial) {
      report = {
        ...base, verdict: 'OK', crash_risk: 'none', safe: true,
        static_findings: [...findings, 'SG-S30: frames-unverified (no sacrificial tier for this surface)'],
      };
    } else {
      const withPayload = passes.map((p) => ({
        id: p.id, target: p.target, channelSlots: p.channelSlots || [],
        channelCount: (p.channelSlots || []).filter(Boolean).length ? (p.channelSlots || []).length : 0,
        fullSource: p.fullSource,
      }));
      const cfg = { frameMs: WATCHDOG.frameMs, size: 64, budgetMs: opts.budgetMs || TOTAL_BUDGET_MS_COMPOSITION };
      const patch = await runCompositionWorker(withPayload, graph.order, cfg, onProgress);
      report = mergeReport(base, patch);
    }
  }

  const envelope = bus.emit('garden.admission.evaluated.v1', report);
  remember(envelope);
  return report;
}
