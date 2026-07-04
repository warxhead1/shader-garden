// Shader Garden — editor/modes/index.js
// Mode registry. Order here drives the toolbar's seg-group and the
// default mode (MODES[0]) — glsl/wgsl ids are the share-link &lang= tags,
// frozen forever.
import glsl from './glsl.js';
import wgsl from './wgsl.js';

export const MODES = [glsl, wgsl];

export function findMode(id) {
  return MODES.find((m) => m.id === id);
}
