// MP-4 (multiplayer-spec.md §6.1) acceptance: GL2Runtime/GPURuntime
// prepareShader() — the side-program compile that lets a remote player's
// commit be validated locally without ever touching the live program (I4).
// Usage: node tools/test/runtime-prepare-shader.mjs (npm ci in tools/test first)
//
// 1) GL2, driven by browser.mjs's launch() against a real GPU (WebGL2
//    resolves to the integrated AMD Raphael on this box — see browser.mjs's
//    own GPU_ARGS header for why, and assertRealWebgl2()'s doc comment for
//    how a suite pinning to WebGL2 proves that isn't SwiftShader):
//    - prepareShader() compiles a SIDE program; the canvas keeps rendering
//      the OLD program until commit() is called (I4's "never blanks/swaps
//      early" half).
//    - commit() re-applies persisted setUniforms() values across the swap —
//      the @tune-slider persistence guarantee at webgl2.js:216-219 — proving
//      a multiplayer commit can't silently reset a slider.
//    - a broken body: prepareShader() resolves ok:false, its commit() is a
//      no-op, and the live program is provably untouched afterward.
//    - dispose() on a prepared-but-uncommitted program, then commit() is a
//      no-op too (never resurrects a released program) — the anti-leak half
//      of I4's "griefer spamming broken commits" note.
//    - setShader() (the synchronous entry point) still reports the same
//      {ok, log, messages} shape and still keeps the previous program on
//      failure — the refactor didn't change its contract.
// 2) WebGPU, code-verified against a mocked GPUDevice in plain Node — no
//    browser needed for this half at all (unlike part 1, this never touches
//    a real adapter; the race-safety logic it's proving lives entirely in
//    GPURuntime's own bookkeeping, not in anything a real device can
//    disagree with): prepareShader() doesn't touch the live pipeline until
//    commit(), and a prepare stamped EARLIER whose commit()
//    is called AFTER a LATER prepare's commit() already ran is rejected —
//    the race-safety §6.1 calls out for this backend specifically.
import { launch, serveSite, gotoSafe } from './browser.mjs';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

/* ---------- 1) GL2, headless ---------- */

const { server, base: BASE } = await serveSite();
const browser = await launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 });

const gl2 = await page.evaluate(async () => {
  const { GL2Runtime } = await import('./js/runtime/webgl2.js');
  const rt = new GL2Runtime(document.createElement('canvas'));

  const readPixel = () => {
    const cgl = rt.canvas.getContext('webgl2');
    const px = new Uint8Array(4);
    cgl.readPixels(0, 0, 1, 1, cgl.RGBA, cgl.UNSIGNED_BYTE, px);
    return Array.from(px);
  };

  // Old program: solid red, tinted by a custom uniform.
  const oldOk = rt.setShader(`
    uniform float uTint;
    void mainImage(out vec4 fragColor, in vec2 fragCoord) {
      fragColor = vec4(1.0, uTint, 0.0, 1.0);
    }
  `);
  rt.setUniforms({ uTint: 0.5 });
  rt.renderOnce(0);
  const beforePrepare = readPixel();

  // New program: solid green, same custom uniform name reused for a
  // different channel so a successful re-apply is visible in the pixel.
  const prepared = await rt.prepareShader(`
    uniform float uTint;
    void mainImage(out vec4 fragColor, in vec2 fragCoord) {
      fragColor = vec4(0.0, 1.0, uTint, 1.0);
    }
  `);
  // Side program compiled — live program must be untouched (I4).
  rt.renderOnce(0);
  const duringPrepare = readPixel();

  prepared.commit();
  rt.renderOnce(0);
  const afterCommit = readPixel();

  // A broken body never displaces the live (just-committed) program.
  const broken = await rt.prepareShader('this is not glsl {{{');
  broken.commit(); // must be inert — ok is false
  rt.renderOnce(0);
  const afterBrokenCommitAttempt = readPixel();

  // dispose() before commit(): the side program must not become live even
  // if commit() is called afterward (idempotency / no resurrection).
  const droppedPrep = await rt.prepareShader(`
    void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(0.0, 0.0, 1.0, 1.0); }
  `);
  droppedPrep.dispose();
  droppedPrep.commit(); // no-op: settled by dispose()
  rt.renderOnce(0);
  const afterDisposeThenCommit = readPixel();

  // setShader()'s synchronous contract: same shape, previous program
  // survives a failed compile.
  const beforeBadSetShader = readPixel();
  const badSync = rt.setShader('also not glsl }}}');
  rt.renderOnce(0);
  const afterBadSetShader = readPixel();

  return {
    oldOk: oldOk.ok, preparedOk: prepared.ok, brokenOk: broken.ok, badSyncOk: badSync.ok,
    badSyncHasMessages: badSync.messages.length > 0,
    beforePrepare, duringPrepare, afterCommit,
    afterBrokenCommitAttempt, afterDisposeThenCommit,
    beforeBadSetShader, afterBadSetShader,
  };
});

check('(GL2) old program compiles', gl2.oldOk, JSON.stringify(gl2));
check('(GL2) prepareShader() resolves ok for a valid body', gl2.preparedOk, JSON.stringify(gl2));
// 8-bit channel quantization of 0.5 is driver-rounding-dependent (127 or
// 128, both legal) — assert against the byte the OLD program itself
// produced (beforePrepare), not a hand-computed constant, so this can't
// false-fail on a driver that rounds .5 differently than Math.round().
check('(GL2) the live program renders the OLD shader the entire time it compiles the side one (I4)',
  JSON.stringify(gl2.duringPrepare) === JSON.stringify(gl2.beforePrepare),
  'beforePrepare=' + JSON.stringify(gl2.beforePrepare) + ' duringPrepare=' + JSON.stringify(gl2.duringPrepare));
check('(GL2) commit() swaps to the new shader AND re-applies the persisted custom uniform',
  gl2.afterCommit[1] === 255 && gl2.afterCommit[2] === gl2.beforePrepare[1],
  'afterCommit=' + JSON.stringify(gl2.afterCommit) + ' (uTint byte should match beforePrepare\'s ' + gl2.beforePrepare[1] + ')');
check('(GL2) prepareShader() on a broken body resolves ok:false', !gl2.brokenOk, JSON.stringify(gl2));
check('(GL2) a broken side program\'s commit() is a no-op — the live (green) program is untouched',
  JSON.stringify(gl2.afterBrokenCommitAttempt) === JSON.stringify(gl2.afterCommit),
  'afterBrokenCommitAttempt=' + JSON.stringify(gl2.afterBrokenCommitAttempt));
check('(GL2) dispose() before commit() means the later commit() call cannot resurrect it',
  JSON.stringify(gl2.afterDisposeThenCommit) === JSON.stringify(gl2.afterCommit),
  'afterDisposeThenCommit=' + JSON.stringify(gl2.afterDisposeThenCommit));
check('(GL2) setShader() keeps its synchronous {ok,log,messages} shape', gl2.badSyncOk === false && gl2.badSyncHasMessages);
check('(GL2) setShader()\'s "previous program survives failure" contract (webgl2.js:73) still holds post-refactor',
  JSON.stringify(gl2.afterBadSetShader) === JSON.stringify(gl2.beforeBadSetShader),
  'before=' + JSON.stringify(gl2.beforeBadSetShader) + ' after=' + JSON.stringify(gl2.afterBadSetShader));
check('(GL2) no console errors across the prepare/commit/dispose sequence', consoleErrors.length === 0, consoleErrors.join(' | '));

await page.close();
await browser.close();
server.kill();

/* ---------- 2) WebGPU: code-verified against a mocked GPUDevice ---------- */

globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
globalThis.GPUShaderStage = { FRAGMENT: 1 };
globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.window = globalThis.window || { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

// Each fake pipeline is a unique object so committed-pipeline identity is
// checkable by reference, the same way the real runtime swaps GPU objects.
function fakeDevice() {
  let pipelineSeq = 0;
  return {
    limits: { maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    queue: { writeBuffer() {}, submit() {}, onSubmittedWorkDone: async () => {} },
    createBuffer: () => ({ destroy() {} }),
    createBindGroupLayout: (desc) => ({ entries: desc.entries }),
    createPipelineLayout: (desc) => ({ bindGroupLayouts: desc.bindGroupLayouts }),
    createBindGroup: (desc) => ({ layout: desc.layout, entries: desc.entries }),
    createSampler: () => ({ kind: 'sampler' }),
    // A body containing the sentinel below simulates a real compile error —
    // there's no real WGSL compiler in this mock, so this is how the "bad
    // body" checks below get an ok:false to assert on.
    createShaderModule: (desc) => ({
      getCompilationInfo: async () => (
        desc.code.includes('not valid wgsl')
          ? { messages: [{ type: 'error', lineNum: 1, linePos: 1, message: 'mock compile error' }] }
          : { messages: [] }
      ),
    }),
    createRenderPipeline: () => ({ id: ++pipelineSeq }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
      finish: () => ({}),
    }),
    pushErrorScope() {},
    popErrorScope: async () => null,
    destroy() {},
  };
}
const fakeCanvas = { clientWidth: 64, clientHeight: 64, width: 64, height: 64, addEventListener() {}, removeEventListener() {} };
const fakeContext = { getCurrentTexture: () => ({ createView: () => ({}) }), unconfigure() {} };

const { GPURuntime } = await import('../../site/js/runtime/webgpu.js');
const device = fakeDevice();
const rt = new GPURuntime(fakeCanvas, device, fakeContext, 'bgra8unorm');

const before = rt._pipeline;
const prep = rt.prepareShader('fn mainImage(fragCoord: vec2f) -> vec4f { return vec4f(1.0); }');
// A prepare in flight must not touch the live pipeline before commit().
check('(WebGPU) prepareShader() does not touch the live pipeline before commit() (I4)', rt._pipeline === before);
const prepared = await prep;
check('(WebGPU) prepareShader() resolves ok for a valid body', prepared.ok);
check('(WebGPU) still hasn\'t touched the live pipeline — commit() not called yet', rt._pipeline === before);
prepared.commit();
const afterFirstCommit = rt._pipeline;
check('(WebGPU) commit() swaps the pipeline in as live', afterFirstCommit !== before && !!afterFirstCommit);

// Race: A is prepared (stamped) before B, but A's commit() is called AFTER
// B's — A must not be allowed to stomp B's newer state (§6.1).
const prepA = rt.prepareShader('fn mainImage(fragCoord: vec2f) -> vec4f { return vec4f(0.0); }');
const prepB = rt.prepareShader('fn mainImage(fragCoord: vec2f) -> vec4f { return vec4f(0.5); }');
const [readyA, readyB] = await Promise.all([prepA, prepB]);
readyB.commit();
const afterB = rt._pipeline;
readyA.commit(); // later-stamped B already committed — this must no-op
const afterLateA = rt._pipeline;
check('(WebGPU) a later-made prepare\'s commit() cannot be undone by an earlier one committing after it',
  afterLateA === afterB && afterLateA !== afterFirstCommit,
  `afterB.id=${afterB?.id} afterLateA.id=${afterLateA?.id}`);

const badPrep = await rt.prepareShader('not valid wgsl at all {{{');
check('(WebGPU) prepareShader() surfaces a compile failure the same shape as GL2', badPrep.ok === false && Array.isArray(badPrep.messages));
badPrep.commit();
check('(WebGPU) a failed prepare\'s commit() is a no-op — live pipeline unchanged', rt._pipeline === afterB);

// 'all-PASS' is the sentinel the CI Battery verdict step greps for, and it
// is the ONLY thing that marks a suite green there — a step's own exit code
// is invisible under continue-on-error. This suite used to print its own
// wording and was reported FAIL in run 32678437991 with every single check
// passing. scripts/preflight.sh now enforces the sentinel.
console.log(failed ? 'FAIL runtime-prepare-shader' : 'all-PASS');
process.exit(failed ? 1 : 0);
