// Shader Garden — editor/admission-gate.js
// Share-link admission gate: runs the full pipeline (static tier + ADM-B/C
// sacrificial worker/compile-only ladder) on a #/edit?src= source before
// it's allowed to autorun. On withhold, builds the ADM-C full report (§9)
// as the scrim — replaces ADM-A's minimal badge+findings box. Editor-self
// typing is never gated — see pipeline.js, which merges the same static
// findings into advisory diagnostics on every compile.

import { el } from '../dom.js';
import { renderReport } from '../organs/admission/report.js';
import { admit, admitComposition, policyFor } from '../organs/admission/index.js';

/**
 * @param {string} source
 * @param {'glsl'|'wgsl'} language
 * @param {Function=} onRun ED-4: consent to run the withheld source as-is —
 *   report.js renders "Run it" only when the report is safe (§9); the
 *   caller's own edit remains the OTHER way to clear the scrim (index.js).
 * @returns {Promise<{admitted:boolean, report:object, scrim:HTMLElement|null}>}
 */
export async function gateShareLink(source, language, onRun) {
  const report = await admit(source, { language, surface: 'share-link' });
  const admitted = policyFor('share-link').autorunOn.includes(report.verdict);
  if (admitted) return { admitted, report, scrim: null };
  const scrim = renderReport(report, { scrim: true, admitted, onRun });
  scrim.prepend(el('div', 'muted admission-withheld', 'autorun withheld — edit the source below, or click Run it, to run it'));
  return { admitted, report, scrim };
}

/**
 * COMP-2: same gate, for a multi-pass composition — the sacrificial run
 * plays the WHOLE composed graph (organs/admission/index.js's
 * admitComposition()); any pass's bad verdict withholds the whole thing.
 * @param {Array} passes buffers.js's `passesForCompile().passes` shape
 * @param {Function=} onRun same "Run it" consent contract as gateShareLink
 */
export async function gateShareLinkComposition(passes, onRun) {
  const report = await admitComposition(passes, { surface: 'share-link' });
  const admitted = policyFor('share-link').autorunOn.includes(report.verdict);
  if (admitted) return { admitted, report, scrim: null };
  const scrim = renderReport(report, { scrim: true, admitted, onRun });
  scrim.prepend(el('div', 'muted admission-withheld', 'autorun withheld (composition) — edit a tab below, or click Run it, to run it'));
  return { admitted, report, scrim };
}
