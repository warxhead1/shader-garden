// Shader Garden — editor/modes/wgsl.js
import { GPURuntime } from '../../runtime/webgpu.js';
import { loadEditorBundle } from '../bundle-loader.js';

const DEFAULT_WGSL = `// WGSL — edit me (uniforms via U: res, mouse, time, dt, frame)
fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = fragCoord / U.res.xy;
  let col = 0.5 + 0.5 * cos(U.time + uv.xyx + vec3f(0.0, 2.0, 4.0));
  return vec4f(col, 1.0);
}
`;

export default {
  id: 'wgsl',
  label: 'WGSL',
  backend: 'WebGPU',
  starter: DEFAULT_WGSL,
  unsupportedMessage: 'WebGPU is not available in this browser/context.\nSwitch to GLSL to keep editing with the WebGL2 backend.',
  async createRuntime(canvas) {
    try { return await GPURuntime.create(canvas); } catch { return null; }
  },
  async language() {
    return (await loadEditorBundle())?.wgsl() ?? null;
  },
};
