// Shader Garden — editor/surfaces/transport.js (ED-3)
// Pause/step/scrub + resolution-scale + screenshot controls for the editor
// canvas. Owns no clock state of its own — the active runtime's clock
// (getClock/seek/step) is the single source of truth, so a mode switch just
// means onRuntimeReady() re-syncs the UI to whatever runtime replaced it.

import { el } from '../../dom.js';

const SCALE_STEPS = [0.25, 0.5, 1, 2];
const SCRUB_PRECISION = 100; // scrub input works in integer "time * 100" units

export function createTransport({ getRuntime }) {
  let paused = false;
  let scale = 1;
  let pollTimer = null;

  const playBtn = el('button', 'btn btn-small', 'Pause');
  const stepBtn = el('button', 'btn btn-small', 'Step');
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.className = 'transport-scrub';
  scrub.min = '0';
  scrub.value = '0';
  scrub.setAttribute('aria-label', 'Scrub time');
  const timeLabel = el('span', 'transport-time', '0.0s');

  const scaleSel = document.createElement('select');
  scaleSel.className = 'transport-scale';
  scaleSel.setAttribute('aria-label', 'Resolution scale');
  for (const s of SCALE_STEPS) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = s + 'x';
    if (s === 1) opt.selected = true;
    scaleSel.append(opt);
  }
  const shotBtn = el('button', 'btn btn-small', 'Screenshot');
  playBtn.type = stepBtn.type = shotBtn.type = 'button';

  const row = el('div', 'transport-row');
  row.append(playBtn, stepBtn, scrub, timeLabel, scaleSel, shotBtn);
  row.dataset.frame = '0'; // testable proxy for iFrame — see tools/test/smoke.mjs

  function refresh() {
    const rt = getRuntime();
    if (!rt) return;
    const clock = rt.getClock();
    scrub.max = String(Math.round(Math.max(60, clock.time * 1.25) * SCRUB_PRECISION));
    scrub.value = String(Math.round(clock.time * SCRUB_PRECISION));
    timeLabel.textContent = clock.time.toFixed(1) + 's';
    row.dataset.frame = String(clock.frame);
  }

  function setPaused(next) {
    paused = next;
    playBtn.textContent = paused ? 'Play' : 'Pause';
    stepBtn.disabled = !paused;
    const rt = getRuntime();
    if (!rt) return;
    if (paused) rt.stop(); else rt.start();
  }

  playBtn.addEventListener('click', () => setPaused(!paused));
  stepBtn.addEventListener('click', () => {
    const rt = getRuntime();
    if (!rt || !paused) return;
    rt.step(1 / 60);
    refresh();
  });
  scrub.addEventListener('input', () => {
    const rt = getRuntime();
    if (!rt) return;
    const t = Number(scrub.value) / SCRUB_PRECISION;
    rt.seek(t);
    timeLabel.textContent = t.toFixed(1) + 's';
    row.dataset.frame = String(rt.getClock().frame);
  });
  scaleSel.addEventListener('change', () => {
    scale = Number(scaleSel.value);
    getRuntime()?.setRenderScale(scale);
  });
  shotBtn.addEventListener('click', () => {
    const rt = getRuntime();
    if (!rt || rt.isContextLost?.()) return;
    // renderOnce() draws synchronously for GL2; for WebGPU it submits before
    // its first await, so queue.submit() has already run by the time this
    // call returns — capturing here (without awaiting onSubmittedWorkDone)
    // is the documented fallback (see ARCHITECTURE.md § Screenshot; the
    // alternative, awaiting the GPU-idle promise first, was not verified
    // headlessly — no navigator.gpu in this repo's puppeteer harness).
    rt.renderOnce(rt.getClock().time);
    rt.canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'shader-garden.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  });

  return {
    el: row,
    get scale() { return scale; },
    // Called after (re)building a runtime (mode switch, boot): re-applies
    // this surface's own paused/scale state to the new instance and starts polling.
    onRuntimeReady(rt) {
      if (!rt) return;
      stepBtn.disabled = !paused;
      if (paused) rt.stop(); else rt.start();
      rt.setRenderScale(scale);
      refresh();
      clearInterval(pollTimer);
      pollTimer = setInterval(refresh, 250); // cheap label/scrub sync — no second rAF loop
    },
    // Additive share params (&t=&paused=&scale=) — read once after boot.
    applyShareParams(params) {
      const t = params.get('t');
      const p = params.get('paused');
      const s = params.get('scale');
      if (s != null && !Number.isNaN(Number(s))) {
        scale = Number(s);
        scaleSel.value = SCALE_STEPS.includes(scale) ? String(scale) : '1';
        getRuntime()?.setRenderScale(scale);
      }
      if (t != null && !Number.isNaN(Number(t))) getRuntime()?.seek(Number(t));
      if (p === '1') setPaused(true);
      refresh();
    },
    shareQuery() {
      const rt = getRuntime();
      const t = rt ? rt.getClock().time.toFixed(2) : '0';
      return '&t=' + t + '&paused=' + (paused ? '1' : '0') + '&scale=' + scale;
    },
    destroy() {
      clearInterval(pollTimer);
    },
  };
}
