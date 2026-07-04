// Shader Garden — editor/modes/glsl.js
import { GL2Runtime } from '../../runtime/webgl2.js';
import { loadEditorBundle } from '../bundle-loader.js';

const DEFAULT_GLSL = `// Shadertoy-style GLSL — edit me
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
  fragColor = vec4(col, 1.0);
}
`;

export default {
  id: 'glsl',
  label: 'GLSL',
  backend: 'WebGL2',
  starter: DEFAULT_GLSL,
  unsupportedMessage: 'WebGL2 is not available in this browser/context.',
  // Normalized to GPURuntime.create's convention — resolve null, never
  // throw, so the caller doesn't need a per-mode try/catch.
  async createRuntime(canvas) {
    try { return new GL2Runtime(canvas); } catch { return null; }
  },
  // null → plain-text editing (bundle absent, or a future grammar-less
  // mode). The CM adapter is the only caller — the textarea adapter never
  // asks a mode for its language.
  async language() {
    return (await loadEditorBundle())?.glsl() ?? null;
  },
};
