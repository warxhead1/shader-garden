// Shader Garden — webgpu.js
// WebGPU runtime: wraps user WGSL (which defines `fn mainImage(fragCoord: vec2f) -> vec4f` and
// reads the uniform struct `U`) with a runtime-owned prelude (uniforms +
// fullscreen-triangle vertex) and a fragment entry point.
//
// fragCoord convention matches GLSL gl_FragCoord: pixel coordinates with the
// origin at the BOTTOM-left (y-up). WebGPU's @builtin(position) is top-left
// y-down, so the fragment entry flips y using U.res.y — ported shaders match
// the WebGL2 backend's output.

import { createClock, attachMouse } from './uniforms.js';
import { WGSL_PRELUDE_LINES as PRELUDE_LINES, wrapWgsl, wgChanLines } from './wrap.js';

const UNIFORM_BYTES = 48; // res(16) + mouse(16) + time/dt/frame/_pad(16)
// See webgl2.js's DEFAULT_DPR_CAP comment — same PERF-0 rationale, same value.
const DEFAULT_DPR_CAP = 1.5;
const RENDER_SCALE_MIN = 0.25;
const RENDER_SCALE_MAX = 2;

function clampLine(line, userLineCount) {
  return Math.min(Math.max(line, 1), Math.max(userLineCount, 1));
}

function wholeDocMessage(text) {
  return { line: 1, severity: 'error', text: text || 'compilation failed', wholeDoc: true };
}

/** GPUCompilationMessage -> user-source coordinates. lineNum 0 means "unknown".
 *  `offset` is PRELUDE_LINES plus any COMP-0 channel-decl lines (see setShader). */
function toUserMessage(m, userLineCount, offset) {
  const severity = m.type === 'error' ? 'error' : m.type === 'warning' ? 'warning' : 'info';
  if (!m.lineNum) return { line: 1, col: 1, severity, text: m.message };
  return {
    line: clampLine(m.lineNum - offset, userLineCount),
    col: m.linePos || undefined,
    severity,
    text: m.message,
  };
}

export class GPURuntime {
  /** @type {((perf: {fps: number, ms: number}) => void) | null} */
  onPerf = null;
  /** @type {((fps: number) => void) | null} deprecated — use onPerf */
  onFps = null;
  /**
   * Optional callback(GPUDeviceLostInfo) fired when the GPUDevice is lost
   * (GPU reset, driver update, ...). The render loop is stopped first; the
   * runtime does not attempt restoration — callers should rebuild. Not fired
   * for an intentional dispose().
   * @type {((info: any) => void) | null}
   */
  onContextLost = null;

  // COMP-0 (see ARCHITECTURE.md § "The uniform contract"): setShader(src, channels)
  // declares iChannel0..N-1 as `texture_2d<f32>` (+ one shared `sg_samp` sampler) only
  // when channels > 0 (C11); setChannels([view...]) binds views for the next frames;
  // createTarget(w,h,{feedback})/renderTo(target,t)/targetView(target)/disposeTarget(target)
  // are the render-to-texture primitives — feedback:true ping-pongs a texture pair, the
  // one legal cycle (C12); composition-graph validation arrives with COMP-1.

  /** @returns {Promise<GPURuntime|null>} null when WebGPU is unavailable — never throws for unsupported. */
  static async create(canvas) {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      if (!device) return null;
      const context = canvas.getContext('webgpu');
      if (!context) return null;
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });
      return new GPURuntime(canvas, device, context, format);
    } catch {
      return null;
    }
  }

  constructor(canvas, device, context, format) {
    this._canvas = canvas;
    this._device = device;
    this._context = context;
    this._format = format;
    this._pipeline = null;
    this._raf = 0;
    this._running = false;
    this._lost = false;
    this._disposed = false;

    this._uniformData = new Float32Array(UNIFORM_BYTES / 4);
    this._uniformBuf = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // COMP-0: bind group layout depends on the active shader's channel count
    // (0-4), cached per count since most kernels never change it.
    this._layouts = new Map();
    this._channelCount = 0;
    this._channelViews = [];
    this._sampler = null;
    this._bindGroup = device.createBindGroup({
      layout: this._layoutFor(0).bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this._uniformBuf } }],
    });

    this._clock = createClock();
    this._detachMouse = attachMouse(canvas, this._clock);
    this._renderScale = 1;

    // Serializes setShader() calls — see setShader().
    this._shaderChain = Promise.resolve();

    // Stop rendering if the device is lost (GPU reset, tab backgrounded too long, ...).
    device.lost.then((info) => {
      this._lost = true;
      this.stop();
      if (!this._disposed) this.onContextLost?.(info);
    }).catch(() => {});

    // Runtime owns canvas sizing: client size * devicePixelRatio, DPR capped.
    this._applySize();
    this._resizeObserver = new ResizeObserver(() => this._applySize());
    this._resizeObserver.observe(canvas);

    this._fpsFrames = 0;
    this._fpsSince = 0;
  }

  _applySize() {
    if (this._lost || this._disposed) return;
    const dpr = Math.min(window.devicePixelRatio || 1, DEFAULT_DPR_CAP) * this._renderScale;
    const maxDim = this._device.limits.maxTextureDimension2D;
    const w = Math.min(maxDim, Math.max(1, Math.round((this._canvas.clientWidth || 1) * dpr)));
    const h = Math.min(maxDim, Math.max(1, Math.round((this._canvas.clientHeight || 1) * dpr)));
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
  }

  /** Bind group layout for a channel count (0-4), built once per count and cached. */
  _layoutFor(n) {
    let L = this._layouts.get(n);
    if (L) return L;
    const entries = [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }];
    if (n) {
      entries.push({ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} });
      for (let i = 0; i < n; i++) entries.push({ binding: 2 + i, visibility: GPUShaderStage.FRAGMENT, texture: {} });
    }
    const bindGroupLayout = this._device.createBindGroupLayout({ entries });
    L = { bindGroupLayout, pipelineLayout: this._device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }) };
    this._layouts.set(n, L);
    return L;
  }

  /** Rebuild the bind group from the active channel count + bound views (COMP-0). */
  _rebuildBindGroup() {
    const entries = [{ binding: 0, resource: { buffer: this._uniformBuf } }];
    if (this._channelCount) {
      this._sampler ??= this._device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      entries.push({ binding: 1, resource: this._sampler });
      this._channelViews.forEach((v, i) => entries.push({ binding: 2 + i, resource: v }));
    }
    this._bindGroup = this._device.createBindGroup({ layout: this._layoutFor(this._channelCount).bindGroupLayout, entries });
  }

  /**
   * Bind up to 4 GPUTextureViews as iChannel0.. for subsequent frames
   * (COMP-0). The count must match the `channels` passed to the active
   * setShader() call — plumbing only, graph validation arrives at COMP-1.
   */
  setChannels(views) {
    this._channelViews = views || [];
    if (this._pipeline) this._rebuildBindGroup();
  }

  /**
   * Compile user WGSL. Keeps the previous pipeline when compilation fails.
   * Calls are serialized on a promise chain: the two pushErrorScope/
   * popErrorScope pairs straddle awaits, so two in-flight calls would
   * interleave scopes (mis-attributing errors between sources) and the
   * last-RESOLVED call would win this._pipeline (possibly the stale shader).
   * FIFO serialization preserves call order: newest source wins.
   *
   * @param {number} [channels] — COMP-0: 0-4 iChannel declarations (C11: 0 emits none)
   * @returns {Promise<{ ok: boolean, log: string, messages: object[] }>}
   *   messages are { line, col?, severity, text, wholeDoc? } in user-source
   *   coordinates; pipeline-stage errors carry no position and are always
   *   whole-doc.
   */
  setShader(wgslSrc, channels = 0) {
    const run = () => this._setShaderNow(wgslSrc, channels);
    this._shaderChain = this._shaderChain.then(run, run);
    return this._shaderChain;
  }

  async _setShaderNow(wgslSrc, channels = 0) {
    if (this._lost || this._disposed) return { ok: false, log: 'device lost', messages: [] };
    const full = wrapWgsl(wgslSrc, channels);
    const userLineCount = wgslSrc.split('\n').length;
    const offset = PRELUDE_LINES + wgChanLines(channels);

    this._device.pushErrorScope('validation');
    const module = this._device.createShaderModule({ code: full });
    const info = await module.getCompilationInfo();
    const scopeErr = await this._device.popErrorScope();

    const messages = info.messages.map((m) => toUserMessage(m, userLineCount, offset));
    const log = info.messages
      .map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`)
      .join('\n');
    const hasError = info.messages.some((m) => m.type === 'error');
    if (hasError || (scopeErr && info.messages.length === 0)) {
      return {
        ok: false,
        log: log || (scopeErr ? scopeErr.message : 'compilation failed'),
        messages: messages.length ? messages : [wholeDocMessage(scopeErr && scopeErr.message)],
      };
    }

    this._device.pushErrorScope('validation');
    const pipeline = this._device.createRenderPipeline({
      layout: this._layoutFor(channels).pipelineLayout,
      vertex: { module, entryPoint: 'sg_vertex' },
      fragment: {
        module,
        entryPoint: 'sg_fragment',
        targets: [{ format: this._format }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const pipeErr = await this._device.popErrorScope();
    if (pipeErr) {
      // No position survives pipeline creation — always whole-doc.
      return {
        ok: false,
        log: (log ? log + '\n' : '') + pipeErr.message,
        messages: [wholeDocMessage(pipeErr.message)],
      };
    }

    this._pipeline = pipeline;
    this._channelCount = channels;
    this._rebuildBindGroup();
    return { ok: true, log, messages };
  }

  _writeUniforms(time, dt, frame, mouse, w = this._canvas.width, h = this._canvas.height) {
    const u = this._uniformData;
    u[0] = w;
    u[1] = h;
    u[2] = 1;
    u[3] = 0;
    u[4] = mouse[0];
    u[5] = mouse[1];
    u[6] = mouse[2];
    u[7] = mouse[3];
    u[8] = time;
    u[9] = dt;
    u[10] = frame;
    u[11] = 0;
    this._device.queue.writeBuffer(this._uniformBuf, 0, u);
  }

  /** @param {GPUTextureView} [view] — defaults to the canvas; renderTo() passes an offscreen view. */
  _encodeFrame(view = this._context.getCurrentTexture().createView()) {
    const encoder = this._device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._bindGroup);
    pass.draw(3);
    pass.end();
    this._device.queue.submit([encoder.finish()]);
  }

  _frame(now) {
    if (!this._running) return;
    this._raf = requestAnimationFrame((t) => this._frame(t));
    if (!this._pipeline || this._lost) return;

    this._clock.tick();
    const c = this._clock;
    this._writeUniforms(c.time, c.dt, c.frame, c.mouse);
    try {
      this._encodeFrame();
    } catch {
      return; // canvas mid-resize / device teardown; skip this frame
    }

    this._fpsFrames++;
    const elapsed = now - this._fpsSince;
    if (elapsed >= 1000) {
      const fps = (this._fpsFrames * 1000) / elapsed;
      this.onPerf?.({ fps, ms: elapsed / this._fpsFrames });
      this.onFps?.(fps); // back-compat
      this._fpsFrames = 0;
      this._fpsSince = now;
    }
  }

  start() {
    if (this._running || this._lost || this._disposed) return;
    this._running = true;
    this._fpsFrames = 0;
    this._fpsSince = performance.now();
    this._clock.start();
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  stop() {
    this._running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    if (this._clock) this._clock.stop();
  }

  /**
   * True when the GPUDevice has been lost (GL2Runtime.isContextLost() parity).
   */
  isContextLost() {
    return this._lost;
  }

  /** The canvas backing this runtime (transport screenshot capture). */
  get canvas() {
    return this._canvas;
  }

  /** The shared clock — read-only from the caller's perspective. */
  getClock() {
    return this._clock;
  }

  /** ED-4 uniforms inspector: freeze/thaw iMouse tracking (detach/reattach). */
  freezeMouse() {
    if (this._mouseFrozen) return;
    this._detachMouse?.();
    this._mouseFrozen = true;
  }

  unfreezeMouse() {
    if (!this._mouseFrozen) return;
    this._detachMouse = attachMouse(this._canvas, this._clock);
    this._mouseFrozen = false;
  }

  /** Scrub to an absolute time and redraw immediately (works while stopped). */
  seek(t) {
    if (!this._pipeline || this._lost || this._disposed) return;
    this._clock.seek(t);
    const c = this._clock;
    this._writeUniforms(c.time, c.dt, c.frame, c.mouse);
    try { this._encodeFrame(); } catch { /* mid-resize/teardown — skip */ }
  }

  /** Transport "Step": one manual frame advance while stopped, then redraw. */
  step(dt) {
    if (!this._pipeline || this._lost || this._disposed) return;
    this._clock.step(dt);
    const c = this._clock;
    this._writeUniforms(c.time, c.dt, c.frame, c.mouse);
    try { this._encodeFrame(); } catch { /* mid-resize/teardown — skip */ }
  }

  /**
   * Multiplier on the DPR-capped drawing-buffer size, clamped [0.25, 2] (and
   * further bounded by maxTextureDimension2D in _applySize). Shared knob for
   * the user's resolution control AND runtime-host's adaptive fps ladder —
   * whichever last called it wins.
   */
  setRenderScale(s) {
    this._renderScale = Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, s));
    this._applySize();
    return this._renderScale;
  }

  /** Render a single frame at the given time in seconds (for thumbnails). */
  async renderOnce(timeSeconds) {
    if (!this._pipeline || this._lost || this._disposed) return;
    this._applySize();
    this._writeUniforms(timeSeconds, 0, 0, [0, 0, 0, 0]);
    this._encodeFrame();
    await this._device.queue.onSubmittedWorkDone();
  }

  /**
   * COMP-0: an offscreen render target usable as an iChannel source — a
   * texture sized (w,h) in the canvas's format. `feedback:true` allocates a
   * second texture and ping-pongs across renderTo() calls: self-feedback is
   * the only legal cycle (C12); composition-graph validation is COMP-1's job.
   */
  createTarget(w, h, { feedback = false } = {}) {
    const make = () => this._device.createTexture({
      size: [w, h],
      format: this._format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    return { w, h, feedback, a: make(), b: feedback ? make() : null, front: 0 };
  }

  /** Render one frame into `target` at an explicit time (renderOnce's off-screen sibling). */
  async renderTo(target, timeSeconds) {
    if (!this._pipeline || this._lost || this._disposed) return;
    const write = target.feedback && target.front ? target.a : target.b || target.a;
    this._writeUniforms(timeSeconds, 0, 0, [0, 0, 0, 0], target.w, target.h);
    this._encodeFrame(write.createView());
    await this._device.queue.onSubmittedWorkDone();
    if (target.feedback) target.front ^= 1;
  }

  /** A view of target's last-rendered texture (bind via setChannels() as an iChannel source). */
  targetView(target) {
    return (target.feedback && target.front ? target.b : target.a).createView();
  }

  /** Release a target's GPU textures. */
  disposeTarget(target) {
    target.a.destroy();
    if (target.b) target.b.destroy();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._detachMouse) this._detachMouse();
    try { this._uniformBuf.destroy(); } catch { /* already gone */ }
    try { this._context.unconfigure(); } catch { /* not configured */ }
    try { this._device.destroy(); } catch { /* already lost */ }
    this._pipeline = null;
  }
}
