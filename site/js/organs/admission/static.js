// Shader Garden — organs/admission/static.js
// Tier-S static screen: SG-S01..S07 are hard rejects — wrapper-subversion
// and other contract violations, regex-decidable and objective. SG-S20..S23
// are advisory findings that never reject; the sacrificial tier owns
// correctness. Pure JS, zero deps, zero wasm.
//
// Ruling C5: this is the ONLY SG-Sxx rule set — the editor imports
// checkStatic() directly for its own advisory-only findings; the admission
// organ's index.js imports it for the share-link gate.
//
// COMP-1 (v2 §7.3 item 24, ruling C12): SG-S08 (cyclic channel graph) is the
// one SG-Sxx rule whose algorithm lives outside this file — the composition
// player (organs/viewer/) needs the exact same DAG check at bake time, and
// this file must not gain a dependency that pulls it into the gallery/viewer
// "0 bytes" budget. checkCompositionGraph() below is the SG-S08 entry point;
// runtime/composition-graph.js owns the graph algorithm.

import { validateComposition } from '../../runtime/composition-graph.js';

const SOURCE_CAP_BYTES = 128 * 1024;

function byteLength(source) {
  return new TextEncoder().encode(source).length;
}

// Mirror of tools/bake_kernels.py's _brace_balance.
function braceBalance(source) {
  let depth = 0;
  for (const ch of source) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

const GLSL_HARD = [
  ['SG-S02', /^\s*#version\b/m, 'declares #version — the runtime supplies it'],
  ['SG-S02', /\bprecision\s+(?:lowp|mediump|highp)\s+\w+\s*;/, 'declares a precision statement — the runtime supplies it'],
  ['SG-S02', /\bvoid\s+main\s*\(/, 'declares its own void main() — the runtime owns the entry point'],
  ['SG-S02', /\b(?:uniform|out)\s+\w+\s+(?:iResolution|iTime|iTimeDelta|iFrame|iMouse|sg_fragColor)\b/,
    'redeclares a runtime-owned uniform or output'],
];

const WGSL_HARD = [
  ['SG-S03', /@(?:vertex|fragment|compute)\b/, 'declares its own entry point (@vertex/@fragment/@compute)'],
  ['SG-S03', /@(?:group|binding)\s*\(/, 'declares its own @group/@binding — the runtime owns binding 0'],
  ['SG-S03', /\bstruct\s+SGUniforms\b/, 'redeclares struct SGUniforms'],
  ['SG-S03', /\bvar<uniform>\s*U\b/, 'redeclares the runtime uniform var U'],
  ['SG-S03', /\bsg_\w+/, 'uses an sg_-prefixed identifier — reserved for the runtime wrapper'],
  ['SG-S04', /^\s*(?:enable|requires)\s+/m, 'uses an enable/requires directive — v2 runs core WGSL only'],
  ['SG-S07', /\bvar<storage/, 'declares a storage buffer — the uniform contract exposes none'],
  ['SG-S07', /\btexture_\w+/, 'declares a texture binding — the uniform contract exposes none'],
  ['SG-S07', /\bsampler(?:_comparison)?\b/, 'declares a sampler — the uniform contract exposes none'],
];

const LOOP_BAIT = /\b(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)|loop\s*\{)/;
const LOOP_ANY = /\b(?:for|while|loop)\s*[({]/;
const LOOP_TIME_BOUND = /\bfor\s*\([^)]*\b(?:iTime|U\.time|iMouse|U\.mouse)\b[^)]*\)/;
const DERIVATIVE_WGSL = /\b(?:dpdx|dpdy|fwidth)\b/;

function hasUnboundedLoop(source) {
  if (LOOP_BAIT.test(source) && !/\bbreak\b/.test(source)) return true;
  return LOOP_TIME_BOUND.test(source);
}

function maxNestingDepth(source) {
  let depth = 0, max = 0;
  for (const ch of source) {
    if (ch === '{') { depth++; if (depth > max) max = depth; }
    else if (ch === '}') depth--;
  }
  return max;
}

function longestStatement(source) {
  return source.split(';').reduce((m, s) => Math.max(m, s.length), 0);
}

function defineCount(source) {
  return (source.match(/^\s*#define\b/mg) || []).length;
}

/**
 * Run the SG-Sxx static screen against `source`.
 * @param {string} source
 * @param {'glsl'|'wgsl'} language
 * @returns {{ reject: boolean, findings: string[] }} findings are
 *   'SG-Sxx: prose' strings; reject === true means a hard reject fired
 *   (verdict VF). Advisory findings (SG-S20..S23) never set reject.
 */
export function checkStatic(source, language) {
  const findings = [];
  let reject = false;

  if (byteLength(source) > SOURCE_CAP_BYTES) {
    findings.push('SG-S01: source exceeds 128 KiB');
    reject = true;
  }

  for (const [id, re, why] of language === 'wgsl' ? WGSL_HARD : GLSL_HARD) {
    if (re.test(source)) { findings.push(id + ': ' + why); reject = true; }
  }

  if (braceBalance(source) !== 0) {
    findings.push('SG-S05: unbalanced braces');
    reject = true;
  }

  const hasMainImage = language === 'wgsl'
    ? /\bfn\s+mainImage\s*\(/.test(source)
    : /\bvoid\s+mainImage\s*\(/.test(source);
  if (!hasMainImage) {
    findings.push('SG-S06: no mainImage() definition found');
    reject = true;
  }

  if (hasUnboundedLoop(source)) {
    findings.push('SG-S20: unbounded loop shape — sacrificial budget halved');
  }
  if (maxNestingDepth(source) > 24 || longestStatement(source) > 8192) {
    findings.push('SG-S21: deep nesting or an oversized single statement');
  }
  if (language === 'glsl' && defineCount(source) > 64) {
    findings.push('SG-S22: more than 64 #define macros');
  }
  if (language === 'wgsl' && DERIVATIVE_WGSL.test(source) && LOOP_ANY.test(source)) {
    findings.push('SG-S23: derivative call inside a loop — possible non-uniform control flow');
  }

  return { reject, findings };
}

/**
 * SG-S08: cyclic channel graph (ruling C12) — a composition manifest's
 * `passes` array, DAG-validated. See runtime/composition-graph.js's header
 * for the algorithm and why it lives there instead of here.
 * @param {Array} passes composition manifest's `passes` array
 * @returns {{ reject: boolean, findings: string[], order: number[] }}
 */
export function checkCompositionGraph(passes) {
  return validateComposition(passes);
}
