// Shader Garden — organs/viewer/composition-player.js
// COMP-1 (v2 blueprint §7.3 item 24): plays a composition manifest's passes
// through the COMP-0 render-to-texture contract (runtime/wrap.js's
// wrapGlsl() + the same createTarget/renderTo/setChannels shape GL2Runtime
// exposes, per ARCHITECTURE.md § "Channels (COMP-0)"). Raw WebGL2, not
// GL2Runtime — deliberately:
//
//   1. A composition needs N *simultaneously live* compiled programs (one
//      per pass), swapped every frame with zero recompiles. GL2Runtime's
//      public surface keeps exactly one program (`setShader` replaces it),
//      built for the single-kernel live-recompile UX — reusing it for
//      multi-pass playback would mean recompiling every pass every frame.
//   2. GL2Runtime is already at its COMP-0 budget cap (see
//      tools/check_budgets.py) — there is no headroom to grow a multi-
//      program cache into it, and doing so would risk the single-kernel
//      viewer path this file has nothing to do with.
//
// WebGPU composition playback is not implemented here (headless never runs
// WebGPU anyway, per tools/test/browser.mjs, and a real WebGPU multi-pass
// player is enough new surface to be its own future item, not a COMP-1
// squeeze-in) — the composition route always renders GL2, badge included.

import { wrapGlsl } from '../../runtime/wrap.js';
import { createClock, attachMouse } from '../../runtime/uniforms.js';

const TARGET_SIZE = 512; // fixed intermediate-buffer resolution — plenty for
// a demo composite; a per-composition size becomes a manifest field only if
// a real use case needs one (COMP-2/3 territory, not this one).

// Identical fullscreen-triangle trick as webgl2.js's VERT_SRC, duplicated
// rather than imported — that file has no budget headroom left (see above)
// and this string is six lines that will never change independently of it.
const VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  const ok = Boolean(gl.getShaderParameter(sh, gl.COMPILE_STATUS)) || gl.isContextLost();
  return { sh, ok, log: gl.getShaderInfoLog(sh) || '' };
}

function makeTarget(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TARGET_SIZE, TARGET_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(0, 0, 0, 1); // deterministic black first read, same rationale as GL2Runtime.createTarget
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo };
}

// Ping-pong convention lifted verbatim from GL2Runtime.renderTo/targetTexture
// (webgl2.js) so both places agree on what "front"/"back" mean.
function backOf(t) { return (t.feedback && t.front) ? t.a : (t.b || t.a); }
function frontTexOf(t) { return (t.feedback && t.front ? t.b : t.a).tex; }

/**
 * @param {HTMLElement} host
 * @param {{ composition: object, order: number[], kernelSrc: Map<string,string>, bus?: object }} opts
 * @returns {{ backend: 'webgl2'|null, canvas: HTMLCanvasElement, resetClock(): void, dispose(): void }}
 */
export function mountComposition(host, { composition, order, kernelSrc, bus }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'viewer-canvas';
  host.append(canvas);

  // preserveDrawingBuffer: true (unlike the single-kernel runtimes) — a
  // composition canvas is read asynchronously (screenshots, headless
  // acceptance checks) far more often relative to its draw cadence; without
  // it the browser is free to clear the default framebuffer right after
  // compositing each frame, so any read landing between two rAF callbacks
  // sees a blank canvas despite every frame having drawn correctly.
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) return { backend: null, canvas, resetClock() {}, dispose() { canvas.remove(); } };

  const vao = gl.createVertexArray();
  const vert = compile(gl, gl.VERTEX_SHADER, VERT_SRC).sh;
  const clock = createClock();
  const detachMouse = attachMouse(canvas, clock);

  // Compile every pass's program ONCE, up front — the reason this file
  // exists instead of reusing GL2Runtime (see header).
  const passes = composition.passes.map((def) => {
    const channels = Array.isArray(def.channels) ? def.channels.length : 0;
    const src = kernelSrc.get(def.kernel) || '';
    const { sh: frag, log: fragLog } = compile(gl, gl.FRAGMENT_SHADER, wrapGlsl(src, channels));
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(frag);
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS) || gl.isContextLost();
    if (!linked) console.warn('[composition]', def.kernel, 'failed to compile/link:', fragLog);
    const uniforms = linked ? {
      iResolution: gl.getUniformLocation(program, 'iResolution'),
      iTime: gl.getUniformLocation(program, 'iTime'),
      iTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
      iFrame: gl.getUniformLocation(program, 'iFrame'),
      iMouse: gl.getUniformLocation(program, 'iMouse'),
      channels: Array.from({ length: channels }, (_, c) => gl.getUniformLocation(program, 'iChannel' + c)),
    } : null;
    return { def, program: linked ? program : null, uniforms };
  });

  // One offscreen target per non-screen target name; feedback:true gets the
  // ping-pong pair (C12's one legal cycle).
  const targets = new Map();
  for (const def of composition.passes) {
    if (def.target === 'screen' || targets.has(def.target)) continue;
    targets.set(def.target, { a: makeTarget(gl), b: def.feedback ? makeTarget(gl) : null, feedback: !!def.feedback, front: 0 });
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  function drawPass(pass, w, h) {
    if (!pass.program) return;
    gl.useProgram(pass.program);
    gl.bindVertexArray(vao);
    const u = pass.uniforms;
    gl.uniform3f(u.iResolution, w, h, 1);
    gl.uniform1f(u.iTime, clock.time);
    gl.uniform1f(u.iTimeDelta, clock.dt);
    gl.uniform1i(u.iFrame, clock.frame);
    gl.uniform4f(u.iMouse, clock.mouse[0], clock.mouse[1], clock.mouse[2], clock.mouse[3]);
    (pass.def.channels || []).forEach((name, c) => {
      const t = targets.get(name);
      if (!t || !u.channels[c]) return;
      gl.activeTexture(gl.TEXTURE0 + c);
      gl.bindTexture(gl.TEXTURE_2D, frontTexOf(t));
      gl.uniform1i(u.channels[c], c);
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame() {
    clock.tick();
    for (const i of order) {
      const pass = passes[i];
      if (pass.def.target === 'screen') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        drawPass(pass, canvas.width, canvas.height);
      } else {
        const t = targets.get(pass.def.target);
        const back = backOf(t);
        gl.bindFramebuffer(gl.FRAMEBUFFER, back.fbo);
        gl.viewport(0, 0, TARGET_SIZE, TARGET_SIZE);
        drawPass(pass, TARGET_SIZE, TARGET_SIZE);
        if (t.feedback) t.front ^= 1;
      }
    }
  }

  let raf = 0;
  function loop() { raf = requestAnimationFrame(loop); frame(); }
  clock.start();
  raf = requestAnimationFrame(loop);

  if (bus) bus.emit('backend.selected.v1', { backend: 'webgl2', reason: 'composition' });

  return {
    backend: 'webgl2',
    canvas,
    resetClock() { clock.time = 0; clock.frame = 0; },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      detachMouse();
      for (const p of passes) if (p.program) gl.deleteProgram(p.program);
      gl.deleteShader(vert);
      gl.deleteVertexArray(vao);
      for (const t of targets.values()) {
        for (const b of [t.a, t.b]) { if (b) { gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.fbo); } }
      }
      canvas.remove();
    },
  };
}
