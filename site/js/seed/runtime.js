// seed/runtime.js — FORKED snapshot of runtime/{webgl2,uniforms}.js post
// wrap.js extraction (ruling C8: the frozen embed contract must not move
// under a shipped page). bake_seed.py diffs GLSL_PRELUDE/EPILOGUE against
// runtime/wrap.js and WARNS on drift. Trimmed: no setUniforms(), no
// diagnostic remap, no pointer->iMouse (`interactive` stays deferred;
// `mouse` below only pins a constant). SEED-2 adds: clock.speed, an onFps
// ~1 Hz sampler, and a DPR cap (`max-dpr`) / ladder-scale pair.
const GLSL_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;
out vec4 sg_fragColor;
`;

const GLSL_EPILOGUE = `
void main() { vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy); sg_fragColor = vec4(c.rgb, 1.0); }
`;

function wrapGlsl(src) {
  return GLSL_PRELUDE + src + GLSL_EPILOGUE;
}

// Fullscreen triangle from gl_VertexID — no vertex buffer needed.
const VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const DEFAULT_DPR_CAP = 1.5;

// Clock (uniforms.js createClock, verbatim behavior).
export function createClock() {
  let last = 0;
  const clock = {
    time: 0,
    dt: 0,
    frame: 0,
    mouse: [0, 0, 0, 0],
    speed: 1, // 0 = frozen (element.js pins time to t0)
    running: false,
    start() {
      if (clock.running) return;
      clock.running = true;
      last = performance.now();
    },
    stop() {
      clock.running = false;
      clock.dt = 0;
    },
    tick() {
      if (!clock.running) return;
      const now = performance.now();
      clock.dt = ((now - last) / 1000) * clock.speed;
      last = now;
      clock.time += clock.dt;
      clock.frame += 1;
    },
  };
  return clock;
}

// Runtime — same public shape as GL2Runtime, embed-scoped subset.
export class SeedRuntime {
  onContextLost = null; // (ev) => void
  onFps = null; // ({fps}) => void, ~1 Hz

  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not supported on this device/browser');

    this._canvas = canvas;
    this._gl = gl;
    this._program = null;
    this._uniforms = null;
    this._raf = 0;
    this._clock = createClock();
    this._dprCap = DEFAULT_DPR_CAP; // `max-dpr` ceiling
    this._dprScale = 1; // ladder multiplier, floor 0.5
    this._fpsFrames = 0;
    this._fpsLastSample = 0;

    this._vao = gl.createVertexArray();
    this._vert = this._compile(gl.VERTEX_SHADER, VERT_SRC).shader;

    this._onLost = (ev) => {
      this.stop();
      this.onContextLost?.(ev);
    };
    canvas.addEventListener('webglcontextlost', this._onLost);

    this._resize();
    this._observer = new ResizeObserver(() => this._resize());
    this._observer.observe(canvas);
  }

  // `max-dpr` attribute retune — leaves the ladder's own scale untouched.
  setDprCap(cap) {
    this._dprCap = cap;
    this._resize();
  }

  // FPS ladder retune — halved on sustained low fps.
  setDprScale(scale) {
    this._dprScale = scale;
    this._resize();
  }

  // Compile + link `src` wrapped in the seed's GLSL preamble/footer.
  setShader(src) {
    const gl = this._gl;
    const { shader: frag, log: fragLog, ok: fragOk } = this._compile(gl.FRAGMENT_SHADER, wrapGlsl(src));
    if (!fragOk) {
      gl.deleteShader(frag);
      return { ok: false, log: fragLog };
    }
    const program = gl.createProgram();
    gl.attachShader(program, this._vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      return { ok: false, log };
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
    return { ok: true, log: '' };
  }

  start() {
    if (this._raf) return;
    this._clock.start();
    this._fpsFrames = 0;
    this._fpsLastSample = performance.now();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this._clock.tick();
      this._draw();
      this._sampleFps();
    };
    this._raf = requestAnimationFrame(loop);
  }

  _sampleFps() {
    this._fpsFrames += 1;
    const now = performance.now();
    const elapsed = now - this._fpsLastSample;
    if (elapsed < 1000) return;
    const fps = (this._fpsFrames * 1000) / elapsed;
    this._fpsFrames = 0;
    this._fpsLastSample = now;
    this.onFps?.({ fps });
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._clock.stop();
  }

  isContextLost() {
    return this._gl.isContextLost();
  }

  get canvas() {
    return this._canvas;
  }

  getClock() {
    return this._clock;
  }

  /** Render a single frame at an explicit time (poster capture). */
  renderOnce(timeSeconds) {
    this._clock.time = timeSeconds;
    this._clock.dt = 0;
    this._resize();
    this._draw();
  }

  dispose() {
    this.stop();
    this._observer.disconnect();
    this._canvas.removeEventListener('webglcontextlost', this._onLost);
    const gl = this._gl;
    if (this._program) gl.deleteProgram(this._program);
    this._program = null;
    this._uniforms = null;
    gl.deleteShader(this._vert);
    gl.deleteVertexArray(this._vao);
    this.onContextLost = null;
    this.onFps = null;
  }

  // internals

  _compile(type, src) {
    const gl = this._gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    const ok = Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)) || gl.isContextLost();
    return { shader, ok, log: gl.getShaderInfoLog(shader) ?? '' };
  }

  /** Drawing-buffer size = client size × min(DPR, cap) × ladder scale. */
  _resize() {
    const canvas = this._canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this._dprCap) * this._dprScale;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  _draw() {
    const gl = this._gl;
    if (gl.isContextLost()) return;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    if (!this._program) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const c = this._clock;
    const u = this._uniforms;
    gl.useProgram(this._program);
    gl.bindVertexArray(this._vao);
    gl.uniform3f(u.iResolution, gl.drawingBufferWidth, gl.drawingBufferHeight, 1);
    gl.uniform1f(u.iTime, c.time);
    gl.uniform1f(u.iTimeDelta, c.dt);
    gl.uniform1i(u.iFrame, c.frame);
    gl.uniform4f(u.iMouse, c.mouse[0], c.mouse[1], c.mouse[2], c.mouse[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
