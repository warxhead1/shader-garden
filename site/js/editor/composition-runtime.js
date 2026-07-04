// Shader Garden — editor/composition-runtime.js
// COMP-2's live multi-pass GL2 renderer. Sibling of
// organs/viewer/composition-player.js (same ping-pong/target conventions,
// same "raw WebGL2, not GL2Runtime" rationale: N passes need N simultaneously
// live programs) but LIVE-EDITABLE — `recompilePass(id, fullSource,
// channelCount)` hot-swaps ONE pass's program in place, leaving the others
// running, which the read-only player has no reason to support. Lives in
// editor/ (not runtime/ or organs/viewer/) so its budget is the editor
// organ's own ≤1500 LOC aggregate, not a squeeze against the already-tight
// COMP-0/COMP-1 runtime/viewer caps.
import { wrapGlsl } from '../runtime/wrap.js';
import { createClock, attachMouse } from '../runtime/uniforms.js';

const SIZE = 384; // offscreen target resolution — a live-typing preview, not a thumbnail or a final render

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
  return sh;
}

function makeTarget(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo };
}

function backOf(t) { return (t.feedback && t.front) ? t.a : (t.b || t.a); }
function frontTexOf(t) { return (t.feedback && t.front ? t.b : t.a).tex; }

/**
 * @param {HTMLElement} host
 * @param {{ passes: Array<{id,target,fullSource,channelSlots,feedback}>, order: number[] }} opts
 * @returns {{ backend:'webgl2'|null, canvas, recompilePass(id,fullSource,channelSlots):{ok,log},
 *             dispose(), freezeMouse(), unfreezeMouse() }}
 */
export function mountComposition(host, { passes, order }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'editor-canvas';
  host.append(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) return { backend: null, canvas, recompilePass: () => ({ ok: false, log: 'WebGL2 unavailable' }), dispose() { canvas.remove(); }, freezeMouse() {}, unfreezeMouse() {} };

  const vert = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
  const vao = gl.createVertexArray();
  const clock = createClock();
  let detachMouse = attachMouse(canvas, clock);

  const targets = new Map();
  for (const p of passes) {
    if (p.target === 'screen' || targets.has(p.target)) continue;
    targets.set(p.target, { a: makeTarget(gl), b: p.feedback ? makeTarget(gl) : null, feedback: !!p.feedback, front: 0 });
  }

  const live = passes.map((p) => ({ id: p.id, target: p.target, program: null, uniforms: null }));

  function link(i, fullSource, channelSlots) {
    const channels = channelSlots.filter(Boolean).length ? channelSlots.length : 0;
    const fs = compile(gl, gl.FRAGMENT_SHADER, wrapGlsl(fullSource || '', channels));
    const log = gl.getShaderInfoLog(fs) || '';
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) { gl.deleteShader(fs); return { ok: false, log }; }
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const linkLog = gl.getProgramInfoLog(program) || 'link failed';
      gl.deleteProgram(program);
      return { ok: false, log: (log ? log + '\n' : '') + linkLog };
    }
    const old = live[i].program;
    live[i] = {
      id: live[i].id, target: live[i].target, program, channelSlots,
      uniforms: {
        iResolution: gl.getUniformLocation(program, 'iResolution'),
        iTime: gl.getUniformLocation(program, 'iTime'),
        iTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
        iFrame: gl.getUniformLocation(program, 'iFrame'),
        iMouse: gl.getUniformLocation(program, 'iMouse'),
        channels: channelSlots.map((_, c) => gl.getUniformLocation(program, 'iChannel' + c)),
      },
    };
    if (old) gl.deleteProgram(old);
    return { ok: true, log };
  }

  const results = passes.map((p, i) => link(i, p.fullSource, p.channelSlots));

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  function drawPass(p, w, h) {
    if (!p.program) return;
    gl.useProgram(p.program);
    gl.bindVertexArray(vao);
    const u = p.uniforms;
    gl.uniform3f(u.iResolution, w, h, 1);
    gl.uniform1f(u.iTime, clock.time);
    gl.uniform1f(u.iTimeDelta, clock.dt);
    gl.uniform1i(u.iFrame, clock.frame);
    gl.uniform4f(u.iMouse, clock.mouse[0], clock.mouse[1], clock.mouse[2], clock.mouse[3]);
    (p.channelSlots || []).forEach((name, c) => {
      const t = name && targets.get(name);
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
      const p = live[i];
      if (p.target === 'screen') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        drawPass(p, canvas.width, canvas.height);
      } else {
        const t = targets.get(p.target);
        gl.bindFramebuffer(gl.FRAMEBUFFER, backOf(t).fbo);
        gl.viewport(0, 0, SIZE, SIZE);
        drawPass(p, SIZE, SIZE);
        if (t.feedback) t.front ^= 1;
      }
    }
  }

  let raf = 0;
  function loop() { raf = requestAnimationFrame(loop); frame(); }
  clock.start();
  raf = requestAnimationFrame(loop);

  return {
    backend: 'webgl2',
    canvas,
    firstCompileResults: results,
    recompilePass(id, fullSource, channelSlots) {
      const i = passes.findIndex((p) => p.id === id);
      if (i < 0) return { ok: false, log: 'unknown pass ' + id };
      return link(i, fullSource, channelSlots);
    },
    freezeMouse() { detachMouse(); detachMouse = () => {}; },
    unfreezeMouse() { detachMouse(); detachMouse = attachMouse(canvas, clock); },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      detachMouse();
      for (const p of live) if (p.program) gl.deleteProgram(p.program);
      gl.deleteShader(vert);
      gl.deleteVertexArray(vao);
      for (const t of targets.values()) for (const b of [t.a, t.b]) { if (b) { gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.fbo); } }
      canvas.remove();
    },
  };
}
