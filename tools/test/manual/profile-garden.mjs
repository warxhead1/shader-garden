// Where does the live garden's ~33ms frame actually go? Splits per-frame cost
// into JS (rAF callback self-time), and infers GPU/composite as the remainder.
import { launch, serveSite, sleep, gotoSafe, assertRealGpu, assertRealWebgl2 } from '../browser.mjs';
const { server, base: BASE } = await serveSite();
const browser = await launch();
const page = await browser.newPage();
// A/B: SG_NO_WEBGPU=1 hides navigator.gpu before any script runs, so the
// mount takes its own WebGL2 fallback path. Same scene, same canvas, same
// pixels — the only variable is the backend.
if (process.env.SG_NO_WEBGPU) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
  });
}
await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await (process.env.SG_NO_WEBGPU ? assertRealWebgl2(page) : assertRealGpu(page));
await sleep(3000);

const r = await page.evaluate(async () => {
  const native = window.requestAnimationFrame.bind(window);
  const starts = [], selfs = [];
  let last = 0;
  window.requestAnimationFrame = (cb) => native((ts) => {
    const t0 = performance.now();
    if (last) starts.push(t0 - last);
    last = t0;
    try { cb(ts); } finally { selfs.push(performance.now() - t0); }
  });
  await new Promise((res) => setTimeout(res, 4000));
  const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)] || 0; };
  return {
    frames: starts.length,
    interval_med: +med(starts).toFixed(2),
    js_self_med: +med(selfs).toFixed(2),
    js_self_max: +Math.max(...selfs, 0).toFixed(2),
    dpr: devicePixelRatio,
    canvas: (() => { const c=document.querySelector('canvas'); return c? `${c.width}x${c.height} css ${c.clientWidth}x${c.clientHeight}`:'none'; })(),
    backend: (document.querySelector('.badge-backend')||{}).textContent || '?',
    panelsOpen: document.querySelectorAll('.garden-panel, .probe-panel, aside, .components-panel').length,
    domNodes: document.querySelectorAll('*').length,
  };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
await new Promise((res) => server.close ? server.close(res) : (server.kill?.(), res()));
