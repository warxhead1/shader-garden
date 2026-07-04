// Shader Garden — editor/multipass-share.js
// COMP-2 multi-pass share links. Additive to the frozen v1 format
// (editor-organ.md §8: "if the encoding of `src` ever changes, a `v=2` param
// is introduced; absence of `v` means v1 semantics forever") — rides
// share.js's SAME compress/decompress (deflate-raw, same 256 KiB
// MAX_DECOMPRESSED_BYTES cap) so multi-pass links are byte-for-byte the same
// transport, just a JSON payload instead of raw source. A v1 link (no `v`
// param, or `v` !== '2') is untouched: index.js only reaches this module
// when `params.get('v') === '2'`.
import { compress, decompress } from '../share.js';

/**
 * @param {object} composition buffers.js's serialize() shape
 * @param {string} lang always 'glsl' for v2 (buffer tabs are GLSL-only)
 * @returns {Promise<string>} the b64url `src` payload
 */
export async function compressComposition(composition) {
  return compress(JSON.stringify(composition));
}

/**
 * @param {string} b64 the `src` query value
 * @returns {Promise<object>} buffers.js's load() shape — throws on malformed
 *   JSON or a shape missing `image`/`buffers` (caller falls back to a
 *   starter shader, same as a corrupt v1 link).
 */
export async function decompressComposition(b64) {
  const obj = JSON.parse(await decompress(b64));
  if (!obj || typeof obj.image !== 'object' || !Array.isArray(obj.buffers)) {
    throw new Error('malformed multi-pass share payload');
  }
  return obj;
}
