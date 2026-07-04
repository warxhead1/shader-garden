// Shader Garden — editor/surfaces/record.js (ED-4)
// canvas.captureStream + MediaRecorder -> a downloaded .webm. Un-cut per
// ruling C13 (record was the "first to cut" flag in the design doc; the A1
// amendment removes it — export is the #4 demand-evidence gap and cutting
// it would leave a whole surfaces/ file dark). 10 s hard cap, no settings
// UI — a second click (or the cap) stops early and triggers the download.
// Feature-detected: an engine/context lacking MediaRecorder(webm) gets a
// disabled button with a title explaining why, never a silent failure.

import { el } from '../../dom.js';

const CAP_MS = 10000;
const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

export function createRecorder({ getRuntime }) {
  const btn = el('button', 'btn btn-small', 'Record');
  btn.type = 'button';

  const mimeType = typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype.captureStream
    ? pickMimeType() : null;
  if (!mimeType) {
    btn.disabled = true;
    btn.title = 'Recording unavailable — this browser has no captureStream + MediaRecorder(webm) support.';
    return { el: btn, destroy() {} };
  }

  let recorder = null;
  let capTimer = null;
  let tickTimer = null;
  let deadline = 0;

  function stop() {
    clearTimeout(capTimer);
    clearInterval(tickTimer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function download(blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shader-garden.webm';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  btn.addEventListener('click', () => {
    if (recorder) { stop(); return; } // already recording -> manual early stop
    const rt = getRuntime();
    if (!rt) return;
    const chunks = [];
    let stream;
    try {
      stream = rt.canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      btn.title = 'Recording failed to start on this canvas.';
      recorder = null;
      return;
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      recorder = null;
      btn.textContent = 'Record';
      btn.classList.remove('active');
      if (chunks.length) download(new Blob(chunks, { type: mimeType }));
    };
    recorder.start();
    deadline = performance.now() + CAP_MS;
    btn.classList.add('active');
    tickTimer = setInterval(() => {
      const left = Math.max(0, Math.round((deadline - performance.now()) / 1000));
      btn.textContent = `Stop (${left}s)`;
    }, 250);
    capTimer = setTimeout(stop, CAP_MS);
  });

  return {
    el: btn,
    destroy() { stop(); },
  };
}
