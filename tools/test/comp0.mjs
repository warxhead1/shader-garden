// COMP-0 acceptance: iChannel plumbing + render-to-texture (v2 blueprint §7.3
// item 23, rulings C11/C12). Usage: node tools/test/comp0.mjs (npm ci in
// tools/test first).
//
// 1) wrap.js snapshot: wrapGlsl()/wrapWgsl() called with no `channels` arg
//    are byte-identical to the frozen golden strings below (ruling C11) — the
//    golden lives in this file, not a scratch fixture. Also proves channel
//    declarations appear ONLY when channels > 0.
// 2) GL2 two-pass demo, headless: an evolved-noise-style kernel renders to an
//    offscreen target; a consumer kernel declares iChannel0, samples the
//    target, and its own offscreen output is read back — proves
//    createTarget/renderTo/setChannels/setShader(src, channels) end to end.
//    A third pass exercises the feedback:true ping-pong (C12's one legal
//    cycle).
// 3) WebGPU: code-verified (the module imports with zero syntax errors) +
//    compile-shape-verified (the runtime's dynamically-built bind-group
//    layout/bind-group match wrapWgsl's channel bindings) via a mocked
//    GPUDevice. WebGPU never executes headless (see browser.mjs) — real-GPU
//    execution stays a manual launch-checklist row, stated plainly here as
//    NOT verified by this script.
import { launch, serveSite, gotoSafe } from './browser.mjs';
import {
  wrapGlsl,
  wrapWgsl,
  wgChanLines,
} from '../../site/js/runtime/wrap.js';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

/* ---------- 1) wrap.js snapshot (C11: byte-identical zero-channel output) ---------- */

const USER_GLSL = 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }\n';
const GOLDEN_GLSL = `#version 300 es
precision highp float;
precision highp int;
uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;
out vec4 sg_fragColor;
void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }

void main() { vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy); sg_fragColor = vec4(c.rgb, 1.0); }
`;
check('wrapGlsl(src) with no channels arg is byte-identical to the frozen golden (C11)',
  wrapGlsl(USER_GLSL) === GOLDEN_GLSL);
check('wrapGlsl(src, 0) === wrapGlsl(src) — explicit zero is still zero',
  wrapGlsl(USER_GLSL, 0) === wrapGlsl(USER_GLSL));

const USER_WGSL = 'fn mainImage(fragCoord: vec2f) -> vec4f { return vec4f(1.0); }';
// Re-frozen for GARDEN-1 (wave 2): the custom-uniform bank adds exactly one
// struct member to the WGSL prelude (16 named f32 slots — see wrap.js's
// @sg-uniforms directive). A deliberate C11 golden update, not drift.
const GOLDEN_WGSL = `struct SGUniforms {
  res: vec4f,
  mouse: vec4f,
  time: f32,
  dt: f32,
  frame: f32,
  _pad: f32,
  custom: array<vec4f, 4>,
}
@group(0) @binding(0) var<uniform> U: SGUniforms;

@vertex
fn sg_vertex(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn mainImage(fragCoord: vec2f) -> vec4f { return vec4f(1.0); }

@fragment
fn sg_fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // GLSL gl_FragCoord convention: pixel coords, y-up from the bottom edge.
  let sg_fragCoord = vec2f(pos.x, U.res.y - pos.y);
  let sg_color = mainImage(sg_fragCoord);
  return vec4f(sg_color.rgb, 1.0);
}
`;
check('wrapWgsl(src) with no channels arg is byte-identical to the frozen golden (C11)',
  wrapWgsl(USER_WGSL) === GOLDEN_WGSL);
check('wrapWgsl(src, 0) === wrapWgsl(src) — explicit zero is still zero',
  wrapWgsl(USER_WGSL, 0) === wrapWgsl(USER_WGSL));

check('wrapGlsl(src, 2) declares exactly iChannel0/iChannel1, no iChannel2',
  wrapGlsl(USER_GLSL, 2).includes('uniform sampler2D iChannel0;') &&
  wrapGlsl(USER_GLSL, 2).includes('uniform sampler2D iChannel1;') &&
  !wrapGlsl(USER_GLSL, 2).includes('iChannel2'));
check('wrapWgsl(src, 2) declares one shared sampler + iChannel0/iChannel1 at bindings 1-3',
  wrapWgsl(USER_WGSL, 2).includes('@group(0) @binding(1) var sg_samp: sampler;') &&
  wrapWgsl(USER_WGSL, 2).includes('@group(0) @binding(2) var iChannel0: texture_2d<f32>;') &&
  wrapWgsl(USER_WGSL, 2).includes('@group(0) @binding(3) var iChannel1: texture_2d<f32>;'));
check('wgChanLines(0) === 0, wgChanLines(2) === 3 (sampler + 2 textures) — the line-remap offset',
  wgChanLines(0) === 0 && wgChanLines(2) === 3);

/* ---------- 2) GL2 two-pass demo, headless (evolved noise -> consumer) ---------- */

const { server, base: BASE } = await serveSite();
const browser = await launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 });

const gl2 = await page.evaluate(async () => {
  const { GL2Runtime } = await import('./js/runtime/webgl2.js');

  // One runtime = one WebGL2 context: textures don't cross GL contexts, so a
  // composed pipeline's passes share a single runtime, swapping the compiled
  // program per pass via setShader() (COMP-1's player owns real scheduling;
  // this is the plumbing it will call).
  const rt = new GL2Runtime(document.createElement('canvas'));

  // Pass 1: an evolved-noise-style kernel, rendered to an offscreen target —
  // stand-in for a FunSearch-evolved noise kernel (COMP-3 wires real ones).
  const noiseOk = rt.setShader(`
    void mainImage(out vec4 fragColor, in vec2 fragCoord) {
      vec2 uv = fragCoord / iResolution.xy;
      float n = fract(sin(dot(uv, vec2(12.9898, 78.233)) + iTime) * 43758.5453);
      fragColor = vec4(vec3(n), 1.0);
    }
  `);
  const noiseTarget = rt.createTarget(64, 64);
  rt.renderTo(noiseTarget, 1.0);

  // Pass 2: a consumer kernel declaring iChannel0, sampling pass 1's target.
  const consumerOk = rt.setShader(`
    void mainImage(out vec4 fragColor, in vec2 fragCoord) {
      vec2 uv = fragCoord / iResolution.xy;
      fragColor = texture(iChannel0, uv);
    }
  `, 1);
  rt.setChannels([rt.targetTexture(noiseTarget)]);
  const outTarget = rt.createTarget(64, 64);
  rt.renderTo(outTarget, 1.0);

  const cgl = rt.canvas.getContext('webgl2');
  cgl.bindFramebuffer(cgl.FRAMEBUFFER, outTarget.a.fbo);
  const px = new Uint8Array(4);
  cgl.readPixels(32, 32, 1, 1, cgl.RGBA, cgl.UNSIGNED_BYTE, px);
  cgl.bindFramebuffer(cgl.FRAMEBUFFER, null);

  // Pass 3: self-feedback (C12's one legal cycle) — a kernel that reads its
  // own previous frame via iChannel0 and accumulates. createTarget() zeroes
  // both ping-pong buffers so frame 1's read is deterministic black.
  const fb = new GL2Runtime(document.createElement('canvas'));
  fb.setShader(`
    void mainImage(out vec4 fragColor, in vec2 fragCoord) {
      vec2 uv = fragCoord / iResolution.xy;
      vec3 prev = texture(iChannel0, uv).rgb;
      fragColor = vec4(prev + vec3(0.1), 1.0);
    }
  `, 1);
  const fbTarget = fb.createTarget(8, 8, { feedback: true });
  fb.setChannels([fb.targetTexture(fbTarget)]);
  fb.renderTo(fbTarget, 0.0);
  const frontAfter1 = fbTarget.front;
  fb.setChannels([fb.targetTexture(fbTarget)]); // rebind: front flipped after the write above
  fb.renderTo(fbTarget, 0.1);
  const frontAfter2 = fbTarget.front;
  const fgl = fb.canvas.getContext('webgl2');
  const readFbo = (fbTarget.front ? fbTarget.b : fbTarget.a).fbo;
  fgl.bindFramebuffer(fgl.FRAMEBUFFER, readFbo);
  const fpx = new Uint8Array(4);
  fgl.readPixels(4, 4, 1, 1, fgl.RGBA, fgl.UNSIGNED_BYTE, fpx);
  fgl.bindFramebuffer(fgl.FRAMEBUFFER, null);

  return {
    noiseOk: noiseOk.ok, consumerOk: consumerOk.ok, pixel: Array.from(px),
    frontAfter1, frontAfter2, feedbackPixel: Array.from(fpx),
  };
});

check('(GL2) noise kernel (pass 1, no channels) compiles', gl2.noiseOk, JSON.stringify(gl2));
check('(GL2) consumer kernel (pass 2, iChannel0 declared via channels=1) compiles', gl2.consumerOk, JSON.stringify(gl2));
check('(GL2) consumer\'s offscreen output is non-black — sourced from the noise target via iChannel0',
  gl2.pixel.slice(0, 3).some((c) => c > 0), 'pixel=' + JSON.stringify(gl2.pixel));
check('(GL2) feedback target flips front after each renderTo (ping-pong, C12)',
  gl2.frontAfter1 !== 0 && gl2.frontAfter2 !== gl2.frontAfter1, JSON.stringify(gl2));
check('(GL2) self-feedback accumulated two +0.1 writes (~0.2, out of a black start)',
  Math.abs(gl2.feedbackPixel[0] / 255 - 0.2) < 0.05, 'feedbackPixel=' + JSON.stringify(gl2.feedbackPixel));
check('(GL2) no console errors during the two-pass + feedback render', consoleErrors.length === 0, consoleErrors.join(' | '));

await page.close();
await browser.close();
server.kill();

/* ---------- 3) WebGPU: code-verified + compile-shape-verified (no real GPU) ---------- */

globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
globalThis.GPUShaderStage = { FRAGMENT: 1 };
globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.window = globalThis.window || { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

function fakeDevice() {
  const layouts = [];
  const groups = [];
  return {
    limits: { maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    queue: { writeBuffer() {}, submit() {}, onSubmittedWorkDone: async () => {} },
    createBuffer: () => ({ destroy() {} }),
    createBindGroupLayout: (desc) => { const L = { entries: desc.entries }; layouts.push(L); return L; },
    createPipelineLayout: (desc) => ({ bindGroupLayouts: desc.bindGroupLayouts }),
    createBindGroup: (desc) => { const G = { layout: desc.layout, entries: desc.entries }; groups.push(G); return G; },
    createSampler: () => ({ kind: 'sampler' }),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipeline: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
      finish: () => ({}),
    }),
    pushErrorScope() {},
    popErrorScope: async () => null,
    destroy() {},
    layouts,
    groups,
  };
}
const fakeCanvas = { clientWidth: 64, clientHeight: 64, width: 64, height: 64, addEventListener() {}, removeEventListener() {} };
const fakeContext = { getCurrentTexture: () => ({ createView: () => ({}) }), unconfigure() {} };

const { GPURuntime } = await import('../../site/js/runtime/webgpu.js');
console.log('PASS (WebGPU) module imports with zero syntax errors — code-verified, not run on a real GPU headless');
const device = fakeDevice();
const rt = new GPURuntime(fakeCanvas, device, fakeContext, 'bgra8unorm');
check('(WebGPU) constructs against a mocked device (constructor shape)', !!rt);

await rt.setShader('fn mainImage(fragCoord: vec2f) -> vec4f { return vec4f(1.0); }', 0);
const layout0 = device.layouts[0].entries;
check('(WebGPU) channels=0 bind group layout has exactly the uniform binding (C11 shape)',
  layout0.length === 1 && layout0[0].binding === 0, JSON.stringify(layout0));

await rt.setShader('fn mainImage(fragCoord: vec2f) -> vec4f { return vec4f(1.0); }', 2);
const layout2 = device.layouts.find((L) => L.entries.length === 4).entries;
check('(WebGPU) channels=2 bind group layout has uniform + sampler + 2 textures at bindings 0-3',
  layout2.map((e) => e.binding).join(',') === '0,1,2,3', JSON.stringify(layout2));

rt.setChannels([{ kind: 'view0' }, { kind: 'view1' }]);
const lastGroup = device.groups[device.groups.length - 1];
check('(WebGPU) setChannels() rebuilds the bind group with the sampler + 2 channel views bound',
  lastGroup.entries.length === 4 && lastGroup.entries[1].resource.kind === 'sampler',
  JSON.stringify(lastGroup.entries.map((e) => e.binding)));

const target = rt.createTarget(32, 32, { feedback: true });
check('(WebGPU) createTarget({feedback:true}) allocates a ping-pong pair', !!target.a && !!target.b);
await rt.renderTo(target, 0.5);
check('(WebGPU) renderTo() flips target.front for a feedback target (C12 self-feedback)', target.front === 1);
rt.disposeTarget(target);
console.log('NOTE (WebGPU) real-GPU execution (device.lost, actual GPU rendering, canvas presentation) is NOT verified by this script — no browser executes WebGPU headless; verify on the manual launch-checklist matrix.');

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
