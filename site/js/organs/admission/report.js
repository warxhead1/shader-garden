// Shader Garden — organs/admission/report.js
// ADM-C: the full admission report (design §9) — replaces ADM-A's minimal
// badge+findings box. textContent only (v1 kernel-derived-string rule).

import { el } from '../../dom.js';
import { copyText, toast } from '../../share.js';

// Hover legend on every badge — teaches the vocabulary, never hidden.
const LEGEND = 'OK ok · WA works-anomalous (safe, empty/constant output) · '
  + 'VF verdict-fail (rejected pre-GPU) · CE compile-error · RE runtime-error '
  + '(crash/context-loss) · TLE time-limit-exceeded · MLE memory-limit-exceeded';

const MEANING = {
  OK: 'compiled and rendered cleanly',
  WA: 'compiled and rendered, but the output looks empty or constant — probably a logic bug, not a crash',
  VF: 'rejected before any GPU contact — the source violates the wrapper contract',
  CE: 'the compiler rejected the wrapped source',
  RE: 'the sacrificial run crashed or the GPU context was lost',
  TLE: 'a compile or render phase exceeded its watchdog deadline and was terminated',
  MLE: 'a GPU allocation reported out-of-memory',
};

function fmtMs(n) { return typeof n === 'number' ? Math.round(n * 10) / 10 + 'ms' : '—'; }

/**
 * Render a full admission report.
 * @param {object} report AdmissionReport (§4.2)
 * @param {{scrim?:boolean, admitted?:boolean, onRun?:Function}} opts
 *   scrim: wrap in the .admission-scrim glass panel (share-link use).
 *   onRun: if given and report.safe && !admitted, shows a "Run it" button.
 * @returns {HTMLElement}
 */
export function renderReport(report, opts = {}) {
  const box = el('div', 'admission-report' + (opts.scrim ? ' admission-scrim glass' : ''));

  const head = el('div', 'admission-scrim-head');
  const badge = el('span', 'badge badge-verdict-' + report.verdict.toLowerCase(), report.verdict);
  badge.title = LEGEND;
  head.append(badge, el('span', 'muted', MEANING[report.verdict] || report.verdict));
  box.append(head);

  if (report.static_findings.length) {
    const list = el('ul', 'admission-findings');
    for (const f of report.static_findings) list.append(el('li', null, f));
    box.append(list);
  }

  if (report.compile_log) box.append(el('pre', 'admission-log', report.compile_log));

  if (report.preview_png) {
    const img = el('img', 'admission-preview');
    img.src = report.preview_png;
    img.alt = 'sacrificial 64×64 readback preview';
    box.append(img);
  }

  const s = report.stages || {};
  box.append(el('div', 'admission-timing muted',
    `static ${fmtMs(s.static_ms)} · compile ${fmtMs(s.compile_ms)} · frames ${fmtMs(s.frames_ms)}`));

  const actions = el('div', 'admission-actions');
  const copyBtn = el('button', 'btn btn-small btn-ghost', 'Copy verdict JSON');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    const envelope = { specversion: '1.0', type: 'garden.admission.evaluated.v1', source: '/garden/admission', data: report };
    toast((await copyText(JSON.stringify(envelope, null, 2))) ? 'Verdict JSON copied' : 'Could not copy — see console');
  });
  actions.append(copyBtn);

  if (opts.onRun && report.safe && !opts.admitted) {
    const runBtn = el('button', 'btn btn-small btn-primary', 'Run it');
    runBtn.type = 'button';
    runBtn.addEventListener('click', () => opts.onRun());
    actions.append(runBtn);
  }
  box.append(actions);

  return box;
}
