// Shader Garden — webgl2.js
// WebGL2 fallback runtime for Shadertoy-style GLSL kernels. See ARCHITECTURE.md § "Runtime interfaces".

import { createClock, attachMouse } from './uniforms.js';
import { GLSL_PRELUDE_LINES as PRELUDE_LINES, wrapGlsl } from './wrap.js';

// Default effective device-pixel-ratio cap. Full native DPR costs real fps on
// high-density displays (PERF-0: "quite shite fps" on the author's desktop) —
// reaching past this is an explicit user choice via setRenderScale(), not
// the default.
const DEFAULT_DPR_CAP = 1.5;
const RENDER_SCALE_MIN = 0.25;
const RENDER_SCALE_MAX = 2;

// ANGLE: "ERROR: 0:12: 'foo' : ..." / "WARNING: 0:12: ...". No column.
const ANGLE_RE = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/;
// Mesa: "0:12(5): error: ..." / "0:12(5): warning: ...".
const MESA_RE = /^\d+:(\d+)\((\d+)\):\s*(error|warning):\s*(.*)$/;

function clampLine(line, userLineCount) {
  return Math.min(Math.max(line, 1), Math.max(userLineCount, 1));
}

function wholeDocMessage(text) {
  return { line: 1, severity: 'error', text: text || 'compile failed', wholeDoc: true };
}

/** Parse an ANGLE- or Mesa-style GLSL info log into user-coordinate messages.
 *  `offset` is PRELUDE_LINES plus any COMP-0 channel-decl lines (see setShader). */
function parseGlLog(log, userLineCount, offset) {
  if (!log) return [];
  const messages = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m = ANGLE_RE.exec(line);
    if (m) {
      messages.push({
        line: clampLine(Number(m[2]) - offset, userLineCount),
        severity: m[1] === 'ERROR' ? 'error' : 'warning',
        text: m[3],
      });
      continue;
    }
    m = MESA_RE.exec(line);
    if (m) {
      messages.push({
        line: clampLine(Number(m[1]) - offset, userLineCount),
        col: Number(m[2]),
        severity: m[3],
        text: m[4],
      });
    }
  }
  return messages;
}

// Fullscreen triangle synthesized from gl_VertexID — no vertex buffer needed.
const VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * WebGL2 runtime: compiles wrapped Shadertoy-style GLSL, renders a fullscreen
 * triangle each animation frame with the shared uniform set
 * (iResolution/iTime/iTimeDelta/iFrame/iMouse).
 *
 * Public surface:
 *   new GL2Runtime(canvas)   — throws Error if WebGL2 is unavailable
 *   setShader(src)           — { ok, log, messages }; on failure the previous
 *                              working program keeps rendering (live-recompile
 *                              UX). messages[] is compiler diagnostics remapped
 *                              to user-source line numbers (§ ARCHITECTURE.md).
 *   start() / stop()         — run/pause the rAF loop (clock is pause-aware)
 *   renderOnce(timeSeconds)  — set the clock to a time and draw one frame
 *                              synchronously (thumbnails)
 *   dispose()                — release GL objects, observers, listeners
 *   onPerf                   — optional callback({fps, ms}) invoked ~once per second
 *   onFps                    — deprecated back-compat: callback(fps), fired alongside onPerf
 *   onContextLost            — optional callback(WebGLContextEvent); fired when
 *                              the browser loses the GL context. The loop is
 *                              stopped first; the runtime does not attempt
 *                              restoration — callers should rebuild.
 *   setRenderScale(s)        — multiplier on the DPR-capped buffer size, clamped [0.25, 2]
 *   getClock()                — the shared clock (time/dt/frame/mouse/running)
 *   seek(t) / step(dt?)       — scrub / single-frame-advance while stopped
 *   setUniforms({name: n})   — named float uniforms beyond the fixed five (GARDEN-0
 *                              @tune sliders + probe toggle); merges into existing
 *                              values, persists across setShader(), unknown names ignored
 *   setShader(src, channels) — COMP-0: `channels` (0-4) declares iChannel0..N-1 as
 *                              `uniform sampler2D` (C11: omitted entirely when 0)
 *   setChannels([tex...])    — bind up to 4 WebGLTextures as iChannel0.. for the next
 *                              draw; count must match the `channels` passed to setShader
 *   createTarget(w,h,{feedback}) — an offscreen framebuffer-backed RGBA8 texture render
 *                              target; feedback:true allocates a ping-pong pair — the
 *                              one legal cycle (C12), graph validation arrives in COMP-1
 *   renderTo(target, t)      — render one frame into `target` at time t (thumbnails'
 *                              renderOnce, but off-screen); flips the ping-pong pair
 *   disposeTarget(target)    — release a target's GL objects
 */
export class GL2Runtime {
  /** @type {((perf: {fps: number, ms: number}) => void) | null} */
  onPerf = null;
  /** @type {((fps: number) => void) | null} deprecated — use onPerf */
  onFps = null;
  /** @type {((ev: Event) => void) | null} */
  onContextLost = null;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{maxDpr?: number}} [opts] — maxDpr overrides DEFAULT_DPR_CAP for
   *   this instance (PERF-2: heavier mounts like the garden's raymarch pin a
   *   tighter cap than the site-wide default).
   */
  constructor(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not supported on this device/browser');

    this._canvas = canvas;
    this._gl = gl;
    this._program = null;
    this._uniforms = null; // cached locations for the active program
    this._raf = 0;
    this._fpsFrames = 0;
    this._fpsSince = 0;

    this._clock = createClock();
    this._detachMouse = attachMouse(canvas, this._clock);
    this._maxDpr = opts.maxDpr ?? DEFAULT_DPR_CAP;
    this._renderScale = 1;
    this._customUniforms = {}; // name -> value, GARDEN-0's tune sliders + probe toggle
    this._customLocations = {}; // name -> WebGLUniformLocation, cleared on relink
    this._channelTex = []; // COMP-0: bound WebGLTextures for iChannel0..3

    this._vao = gl.createVertexArray();

    this._vert = this._compile(gl.VERTEX_SHADER, VERT_SRC).shader;

    this._onLost = (ev) => {
      this.stop();
      this.onContextLost?.(ev);
    };
    canvas.addEventListener('webglcontextlost', this._onLost);

    this._resize(); // initial sizing before the observer's first callback
    this._observer = new ResizeObserver(() => this._resize());
    this._observer.observe(canvas);
  }

  /**
   * Compile + link `src` wrapped in the runtime preamble/footer.
   * On success the new program replaces the old one; on failure the previous
   * working program is left untouched and keeps rendering.
   *
   * @param {string} src — Shadertoy-style body defining mainImage()
   * @param {number} [channels] — COMP-0: 0-4 iChannel declarations (C11: 0 emits none)
   * @returns {{ ok: boolean, log: string, messages: object[] }} log is the raw
   *   GL info log; messages are { line, col?, severity, text, wholeDoc? } in
   *   user-source coordinates (link-stage failures are always whole-doc — no
   *   position survives linking).
   */
  setShader(src, channels = 0) {
    const gl = this._gl;
    const userLineCount = src.split('\n').length;
    const offset = PRELUDE_LINES + channels;
    const { shader: frag, log: fragLog, ok: fragOk } = this._compile(
      gl.FRAGMENT_SHADER,
      wrapGlsl(src, channels),
    );
    if (!fragOk) {
      gl.deleteShader(frag);
      const messages = parseGlLog(fragLog, userLineCount, offset);
      return { ok: false, log: fragLog, messages: messages.length ? messages : [wholeDocMessage(fragLog)] };
    }

    const program = gl.createProgram();
    gl.attachShader(program, this._vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(frag); // linked (or failed); shader object no longer needed
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      return { ok: false, log, messages: [wholeDocMessage(log)] };
    }

    if (this._program) gl.deleteProgram(this._program);
    this._program = program;
    this._uniforms = {
      iResolution: gl.getUniformLocation(program, 'iResolution'),
      iTime: gl.getUniformLocation(program, 'iTime'),
      iTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
      iFrame: gl.getUniformLocation(program, 'iFrame'),
      iMouse: gl.getUniformLocation(program, 'iMouse'),
    };
    for (let i = 0; i < 4; i++) this._uniforms['iChannel' + i] = gl.getUniformLocation(program, 'iChannel' + i);
    this._customLocations = {}; // stale locations from the old program are invalid
    return { ok: true, log: '', messages: parseGlLog(fragLog, userLineCount, offset) };
  }

  /**
   * Bind up to 4 textures as iChannel0.. for subsequent draws (COMP-0). The
   * count must match the `channels` passed to the active setShader() call —
   * plumbing only, no composition-graph validation until COMP-1.
   * @param {(WebGLTexture|null)[]} textures
   */
  setChannels(textures) {
    this._channelTex = textures || [];
  }

  /**
   * Set named float uniforms beyond the runtime's fixed five — GARDEN-0's
   * `@tune` sliders and probe-mode toggle. Values persist across setShader()
   * (a recompile doesn't reset a slider); locations are resolved lazily per
   * program and cached until the next relink. A name absent from the active
   * program is silently ignored (getUniformLocation returns null — the
   * compiler already stripped it, most likely dead-code-eliminated).
   */
  setUniforms(values) {
    Object.assign(this._customUniforms, values);
  }

  start() {
    if (this._raf) return;
    this._clock.start();
    this._fpsFrames = 0;
    this._fpsSince = performance.now();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this._clock.tick();
      this._draw();
      this._countFps();
    };
    this._raf = requestAnimationFrame(loop);
  }

  /**
   * True when the underlying WebGL context has been lost. setShader() reports
   * ok on a lost context (no spurious error log); callers that snapshot the
   * canvas (thumbnails) must check this before trusting the drawing buffer.
   */
  isContextLost() {
    return this._gl.isContextLost();
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
    this._detachMouse();
    this._mouseFrozen = true;
  }

  unfreezeMouse() {
    if (!this._mouseFrozen) return;
    this._detachMouse = attachMouse(this._canvas, this._clock);
    this._mouseFrozen = false;
  }

  /** Scrub to an absolute time and redraw immediately (works while stopped). */
  seek(t) {
    this._clock.seek(t);
    this._draw();
  }

  /** Transport "Step": one manual frame advance while stopped, then redraw. */
  step(dt) {
    this._clock.step(dt);
    this._draw();
  }

  /**
   * Multiplier on the DPR-capped drawing-buffer size, clamped [0.25, 2].
   * Shared knob for the user's resolution control AND runtime-host's
   * adaptive fps ladder — whichever last called it wins.
   */
  setRenderScale(s) {
    this._renderScale = Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, s));
    this._resize();
    return this._renderScale;
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._clock.stop();
  }

  /**
   * Render a single frame at an explicit time (thumbnail capture).
   * Sets the shared clock to `timeSeconds` (dt=0) and draws synchronously —
   * the canvas is readable/drawable immediately after this returns.
   *
   * @param {number} timeSeconds
   */
  renderOnce(timeSeconds) {
    this._clock.time = timeSeconds;
    this._clock.dt = 0;
    this._resize();
    this._draw();
  }

  /**
   * COMP-0: an offscreen render target usable as an iChannel source — an
   * RGBA8 texture backed by a framebuffer, sized (w,h). `feedback:true`
   * allocates a second texture and ping-pongs between them across renderTo()
   * calls: self-feedback is the only legal cycle (C12); arbitrary composition
   * graphs are validated at COMP-1, not here.
   */
  createTarget(w, h, { feedback = false } = {}) {
    const gl = this._gl;
    const make = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      // Unlike WebGPU (spec-guaranteed zero-init), WebGL texture storage is
      // undefined until written — clear so a feedback target's first read
      // (before its first write) is deterministic black, not driver garbage.
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo };
    };
    const a = make();
    return { w, h, feedback, a, b: feedback ? make() : null, front: 0 };
  }

  /**
   * Render one frame into `target` at an explicit time (renderOnce's
   * off-screen sibling). Writes the "back" buffer of a feedback target, then
   * flips — `target.a`/`target.b` (whichever is current-front) is the
   * readable texture to bind via setChannels() for the *next* frame.
   */
  renderTo(target, timeSeconds) {
    const gl = this._gl;
    const back = target.feedback && target.front ? target.a : target.b || target.a;
    gl.bindFramebuffer(gl.FRAMEBUFFER, back.fbo);
    gl.viewport(0, 0, target.w, target.h);
    this._clock.time = timeSeconds;
    this._clock.dt = 0;
    this._drawCore(target.w, target.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (target.feedback) target.front ^= 1;
  }

  /** The texture currently holding target's last-rendered frame (bind as an iChannel source). */
  targetTexture(target) {
    return (target.feedback && target.front ? target.b : target.a).tex;
  }

  /** Release a target's GL objects (textures + framebuffers). */
  disposeTarget(target) {
    const gl = this._gl;
    for (const t of [target.a, target.b]) {
      if (!t) continue;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
  }

  dispose() {
    this.stop();
    this._observer.disconnect();
    this._detachMouse();
    this._canvas.removeEventListener('webglcontextlost', this._onLost);
    const gl = this._gl;
    if (this._program) gl.deleteProgram(this._program);
    this._program = null;
    this._uniforms = null;
    gl.deleteShader(this._vert);
    gl.deleteVertexArray(this._vao);
    this.onPerf = null;
    this.onFps = null;
    this.onContextLost = null;
  }

  // ---- internals ----------------------------------------------------------

  _compile(type, src) {
    const gl = this._gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    const ok =
      Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)) || gl.isContextLost();
    return { shader, ok, log: gl.getShaderInfoLog(shader) ?? '' };
  }

  /** Drawing-buffer size = client size × min(DPR, this._maxDpr) × renderScale. */
  _resize() {
    const canvas = this._canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this._maxDpr) * this._renderScale;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  /** On-screen draw: default framebuffer, canvas-sized viewport/resolution. */
  _draw() {
    const gl = this._gl;
    if (gl.isContextLost()) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this._drawCore(gl.drawingBufferWidth, gl.drawingBufferHeight);
  }

  /** Shared draw body for on-screen (_draw) and off-screen (renderTo) targets. */
  _drawCore(w, h) {
    const gl = this._gl;
    if (!this._program) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const c = this._clock;
    const u = this._uniforms;
    gl.useProgram(this._program);
    gl.bindVertexArray(this._vao);
    gl.uniform3f(u.iResolution, w, h, 1);
    gl.uniform1f(u.iTime, c.time);
    gl.uniform1f(u.iTimeDelta, c.dt);
    gl.uniform1i(u.iFrame, c.frame);
    gl.uniform4f(u.iMouse, c.mouse[0], c.mouse[1], c.mouse[2], c.mouse[3]);
    for (let i = 0; i < this._channelTex.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this._channelTex[i]);
      if (u['iChannel' + i]) gl.uniform1i(u['iChannel' + i], i);
    }
    for (const name in this._customUniforms) {
      let loc = this._customLocations[name];
      if (loc === undefined) loc = this._customLocations[name] = gl.getUniformLocation(this._program, name);
      if (loc) gl.uniform1f(loc, this._customUniforms[name]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _countFps() {
    this._fpsFrames += 1;
    const now = performance.now();
    const elapsed = now - this._fpsSince;
    if (elapsed >= 1000) {
      const fps = (this._fpsFrames * 1000) / elapsed;
      this.onPerf?.({ fps, ms: elapsed / this._fpsFrames });
      this.onFps?.(fps); // back-compat
      this._fpsFrames = 0;
      this._fpsSince = now;
    }
  }
}
