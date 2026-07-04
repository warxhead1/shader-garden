// Shader Garden — organs/admission/sac-worker.js
// Sacrificial compile+run. Dedicated MODULE worker — killable
// unconditionally via worker.terminate(); index.js owns the watchdog (§6.3).
// Module not classic: C8 needs runtime/wrap.js imported for a byte-for-byte
// compile; a classic worker can only importScripts() a non-module copy
// (the prelude-drift C8 exists to prevent). Dedicated-worker WebGPU only
// ships alongside module workers anyway, so nothing is lost.
// Protocol (§4.3): main->worker {op:'run',seq,language,source,frames,size,
// frameDeadlineMs,testHang?}; worker->main {ev:'phase'|'compiled'|'frames'
// |'lost'|'oom'|'fatal', ...}. ADM-C: GLSL via OffscreenCanvas WebGL2, real
// and headless under SwiftShader (unlike WGSL) — admission-sac.mjs exercises it for real.
// COMP-2 (v2 §7.3 item 25): op:'run-composition' plays N GLSL passes (Image +
// buffers) through the same OffscreenCanvas WebGL2 context — one worker
// spawn, one watchdog window per composite frame, matching the single-pass
// budget model instead of N separate admit() calls (which would blow the
// composed happy-path budget, §7.5). Any pass's compile failure or runtime
// hang aborts/terminates the WHOLE run, same "any-pass verdicts the whole
// composition" rule the orchestrator applies to the result.

import { wrapWgsl, wrapGlsl } from '../../runtime/wrap.js';

const UNIFORM_BYTES = 48; // GPURuntime: res(16) + mouse(16) + time/dt/frame/pad(16)
const PROBE_TIMES = [0.0, 1.5, 5.0]; // t=1.5 matches thumbs.js's THUMB_TIME

// Fixed boilerplate, no user input — kept byte-identical to webgl2.js's
// VERT_SRC by hand (C8 governs the USER-source wrap, not this).
const GLSL_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

function post(seq, msg, transfer) {
  if (transfer) self.postMessage({ seq, ...msg }, transfer);
  else self.postMessage({ seq, ...msg });
}

// GLSL run: no vertex buffer (gl_VertexID trick). Frame 1 (t=1.5) reads
// back row-flipped (GL origin is bottom-left) to match the WGSL path.
function runGlsl(seq, source, frames, size) {
  post(seq, { ev: 'phase', phase: 'context' });
  if (typeof OffscreenCanvas === 'undefined') { post(seq, { ev: 'fatal', message: 'no-offscreencanvas-in-worker' }); return; }
  const canvas = new OffscreenCanvas(size, size);
  const gl = canvas.getContext('webgl2');
  if (!gl) { post(seq, { ev: 'fatal', message: 'no-webgl2-in-worker' }); return; }
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    post(seq, { ev: 'lost', reason: 'webglcontextlost' });
  });

  post(seq, { ev: 'phase', phase: 'compile' });
  const tCompile = performance.now();
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, GLSL_VERT);
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, wrapGlsl(source));
  gl.compileShader(fs);
  const fsLog = gl.getShaderInfoLog(fs) || '';
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    post(seq, { ev: 'compiled', ok: false, log: fsLog, ms: performance.now() - tCompile });
    return;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    post(seq, { ev: 'compiled', ok: false, log: (fsLog ? fsLog + '\n' : '') + (gl.getProgramInfoLog(program) || 'link failed'), ms: performance.now() - tCompile });
    return;
  }
  post(seq, { ev: 'compiled', ok: true, log: fsLog, ms: performance.now() - tCompile });

  gl.useProgram(program);
  const uRes = gl.getUniformLocation(program, 'iResolution');
  const uTime = gl.getUniformLocation(program, 'iTime');
  const uDt = gl.getUniformLocation(program, 'iTimeDelta');
  const uFrame = gl.getUniformLocation(program, 'iFrame');
  const uMouse = gl.getUniformLocation(program, 'iMouse');
  gl.viewport(0, 0, size, size);

  const tFrames = performance.now();
  let raw = null;
  for (let i = 0; i < frames; i++) {
    post(seq, { ev: 'phase', phase: 'frame', n: i });
    const t = PROBE_TIMES[i] ?? PROBE_TIMES[PROBE_TIMES.length - 1];
    gl.uniform3f(uRes, size, size, 1);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uDt, 0);
    gl.uniform1i(uFrame, i);
    gl.uniform4f(uMouse, 0, 0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // readPixels syncs — where a hung shader blocks; watchdog is main-thread.
    if (i === 1) {
      raw = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    }
  }
  if (gl.getError() === gl.OUT_OF_MEMORY) { post(seq, { ev: 'oom' }); return; } // GL2 has no error-scope; best-effort MLE
  if (!raw) { post(seq, { ev: 'fatal', message: 'no-readback' }); return; }
  const pixels = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) pixels.set(raw.subarray(row * size * 4, row * size * 4 + size * 4), (size - 1 - row) * size * 4);
  post(seq, { ev: 'frames', ok: true, ms: performance.now() - tFrames, pixels: pixels.buffer }, [pixels.buffer]);
}

// COMP-2 composition ping-pong helpers — same convention as
// organs/viewer/composition-player.js and editor/composition-runtime.js
// (kept local, not imported: the worker has no module-scope headroom to
// spare and this is eight lines that won't drift independently).
function compTarget(gl, size, feedback) {
  function tex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: t, fbo };
  }
  return { a: tex(), b: feedback ? tex() : null, feedback, front: 0 };
}
const compBack = (t) => (t.feedback && t.front) ? t.a : (t.b || t.a);
const compFrontTex = (t) => (t.feedback && t.front ? t.b : t.a).tex;

// passes: [{id, target, fullSource, channelSlots, channelCount}]; order:
// topological index sequence (screen last) — both precomputed by index.js
// via runtime/composition-graph.js's validateComposition(), the SAME
// SG-S08 algorithm the static tier already ran on this graph.
function runCompositionGlsl(seq, passes, order, frames, size) {
  post(seq, { ev: 'phase', phase: 'context' });
  if (typeof OffscreenCanvas === 'undefined') { post(seq, { ev: 'fatal', message: 'no-offscreencanvas-in-worker' }); return; }
  const canvas = new OffscreenCanvas(size, size);
  const gl = canvas.getContext('webgl2');
  if (!gl) { post(seq, { ev: 'fatal', message: 'no-webgl2-in-worker' }); return; }
  canvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); post(seq, { ev: 'lost', reason: 'webglcontextlost' }); });

  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, GLSL_VERT);
  gl.compileShader(vs);

  const targets = new Map();
  for (const p of passes) if (p.target !== 'screen' && !targets.has(p.target)) targets.set(p.target, compTarget(gl, size, p.channelSlots.includes(p.target)));

  const live = [];
  const tCompile = performance.now();
  for (const p of passes) {
    post(seq, { ev: 'phase', phase: 'compile', pass: p.id });
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, wrapGlsl(p.fullSource || '', p.channelCount || 0));
    gl.compileShader(fs);
    const fsLog = gl.getShaderInfoLog(fs) || '';
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      post(seq, { ev: 'compiled', ok: false, log: `[${p.id}] ${fsLog}`, ms: performance.now() - tCompile, pass: p.id });
      return;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      post(seq, { ev: 'compiled', ok: false, log: `[${p.id}] ${gl.getProgramInfoLog(program) || 'link failed'}`, ms: performance.now() - tCompile, pass: p.id });
      return;
    }
    live.push({
      id: p.id, target: p.target, channelSlots: p.channelSlots, program,
      u: {
        res: gl.getUniformLocation(program, 'iResolution'), time: gl.getUniformLocation(program, 'iTime'),
        dt: gl.getUniformLocation(program, 'iTimeDelta'), frame: gl.getUniformLocation(program, 'iFrame'),
        mouse: gl.getUniformLocation(program, 'iMouse'),
        channels: p.channelSlots.map((_, c) => gl.getUniformLocation(program, 'iChannel' + c)),
      },
    });
  }
  post(seq, { ev: 'compiled', ok: true, log: '', ms: performance.now() - tCompile });

  const tFrames = performance.now();
  let raw = null;
  for (let i = 0; i < frames; i++) {
    post(seq, { ev: 'phase', phase: 'frame', n: i });
    const t = PROBE_TIMES[i] ?? PROBE_TIMES[PROBE_TIMES.length - 1];
    for (const idx of order) {
      const p = live[idx];
      const screen = p.target === 'screen';
      gl.bindFramebuffer(gl.FRAMEBUFFER, screen ? null : compBack(targets.get(p.target)).fbo);
      gl.viewport(0, 0, size, size);
      gl.useProgram(p.program);
      gl.uniform3f(p.u.res, size, size, 1);
      gl.uniform1f(p.u.time, t);
      gl.uniform1f(p.u.dt, 0);
      gl.uniform1i(p.u.frame, i);
      gl.uniform4f(p.u.mouse, 0, 0, 0, 0);
      p.channelSlots.forEach((name, c) => {
        const src = name && targets.get(name);
        if (!src || !p.u.channels[c]) return;
        gl.activeTexture(gl.TEXTURE0 + c);
        gl.bindTexture(gl.TEXTURE_2D, compFrontTex(src));
        gl.uniform1i(p.u.channels[c], c);
      });
      // readPixels below syncs — where a hung pass blocks; watchdog is main-thread.
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!screen && targets.get(p.target).feedback) targets.get(p.target).front ^= 1;
    }
    if (i === 1) {
      raw = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    }
  }
  if (gl.getError() === gl.OUT_OF_MEMORY) { post(seq, { ev: 'oom' }); return; }
  if (!raw) { post(seq, { ev: 'fatal', message: 'no-readback' }); return; }
  const pixels = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) pixels.set(raw.subarray(row * size * 4, row * size * 4 + size * 4), (size - 1 - row) * size * 4);
  post(seq, { ev: 'frames', ok: true, ms: performance.now() - tFrames, pixels: pixels.buffer }, [pixels.buffer]);
}

self.onmessage = async (e) => {
  const { op, seq, language, source, frames, size } = e.data;

  if (op === 'run-composition') {
    try { runCompositionGlsl(seq, e.data.passes, e.data.order, frames, size); } catch (err) { post(seq, { ev: 'fatal', message: String((err && err.message) || err) }); }
    return;
  }
  if (op !== 'run') return;

  // Test-only hang (WGSL side; private opts field, never reachable from a
  // share-link). GLSL gets a REAL runtime-infinite-loop test instead.
  if (e.data.testHang) { await new Promise(() => {}); return; }

  if (language === 'glsl') { try { runGlsl(seq, source, frames, size); } catch (err) { post(seq, { ev: 'fatal', message: String((err && err.message) || err) }); } return; }
  if (language !== 'wgsl') { post(seq, { ev: 'fatal', message: 'unsupported-language' }); return; }

  try {
    post(seq, { ev: 'phase', phase: 'context' });
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      post(seq, { ev: 'fatal', message: 'no-webgpu-in-worker' });
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) { post(seq, { ev: 'fatal', message: 'no-adapter' }); return; }
    const device = await adapter.requestDevice();
    device.lost.then((info) => {
      post(seq, { ev: 'lost', reason: (info && info.message) || String(info) });
    }).catch(() => {});

    post(seq, { ev: 'phase', phase: 'compile' });
    const tCompile = performance.now();
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code: wrapWgsl(source) });
    const info = await module.getCompilationInfo();
    const scopeErr = await device.popErrorScope();
    const compileLog = info.messages
      .map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`)
      .join('\n');
    const hasError = info.messages.some((m) => m.type === 'error');
    if (hasError || (scopeErr && info.messages.length === 0)) {
      post(seq, {
        ev: 'compiled', ok: false,
        log: compileLog || (scopeErr ? scopeErr.message : 'compilation failed'),
        ms: performance.now() - tCompile,
      });
      return;
    }

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    device.pushErrorScope('validation');
    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'sg_vertex' },
      fragment: { module, entryPoint: 'sg_fragment', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    const pipeErr = await device.popErrorScope();
    if (pipeErr) {
      post(seq, {
        ev: 'compiled', ok: false,
        log: (compileLog ? compileLog + '\n' : '') + pipeErr.message,
        ms: performance.now() - tCompile,
      });
      return;
    }
    post(seq, { ev: 'compiled', ok: true, log: compileLog, ms: performance.now() - tCompile });

    device.pushErrorScope('out-of-memory');
    const texture = device.createTexture({
      size: [size, size], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const uniformBuf = device.createBuffer({
      size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
    });
    const oomErr = await device.popErrorScope();
    if (oomErr) { post(seq, { ev: 'oom' }); return; }

    // copyTextureToBuffer requires bytesPerRow aligned to 256 bytes.
    const bytesPerRow = Math.ceil((size * 4) / 256) * 256;
    const readbackBuf = device.createBuffer({
      size: bytesPerRow * size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const uniformData = new Float32Array(UNIFORM_BYTES / 4);
    const tFrames = performance.now();
    let pixels = null;
    for (let i = 0; i < frames; i++) {
      post(seq, { ev: 'phase', phase: 'frame', n: i });
      const t = PROBE_TIMES[i] ?? PROBE_TIMES[PROBE_TIMES.length - 1];
      uniformData.set([size, size, 1, 0, 0, 0, 0, 0, t, 0, i, 0]);
      device.queue.writeBuffer(uniformBuf, 0, uniformData);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store',
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      // t=1.5 only (§6.2 step 6, thumbnail convention) — orchestrator computes metrics, worker stays dumb.
      if (i === 1) encoder.copyTextureToBuffer({ texture }, { buffer: readbackBuf, bytesPerRow }, [size, size, 1]);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    }

    await readbackBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readbackBuf.getMappedRange());
    // Copy out (dropping row padding) — mapped ranges detach on unmap().
    const tight = new Uint8Array(size * size * 4);
    for (let row = 0; row < size; row++) {
      tight.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + size * 4), row * size * 4);
    }
    readbackBuf.unmap();
    pixels = tight.buffer;

    device.destroy();
    post(seq, { ev: 'frames', ok: true, ms: performance.now() - tFrames, pixels }, [pixels]);
  } catch (err) {
    post(seq, { ev: 'fatal', message: String((err && err.message) || err) });
  }
};
