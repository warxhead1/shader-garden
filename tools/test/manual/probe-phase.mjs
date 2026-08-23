// Is the terrain probe's answer a function of WHEN you sample it?
import { launch, serveSite, sleep, gotoSafe, assertRealGpu } from '../browser.mjs';
const { server, base: BASE } = await serveSite();
const browser = await launch();
const page = await browser.newPage();
await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await assertRealGpu(page);
await sleep(2500);
await page.evaluate(async () => {
  const { on } = await import('./js/core/bus.js');
  window.__probeN = 0; on('garden.probe.opened.v1', () => { window.__probeN++; });
});
const out = [];
for (const wait of [0, 300, 600, 900, 1200, 1800, 2400, 3000]) {
  await new Promise((r) => setTimeout(r, wait));   // deliberately UNSCALED
  const before = await page.evaluate(() => window.__probeN);
  await page.mouse.click(720, 830);
  await page.waitForFunction((n) => window.__probeN > n, before, { timeout: 10000 }).catch(() => {});
  out.push([wait, await page.$eval('.probe-title', (e) => e.textContent).catch(() => null)]);
}
for (const [w, t] of out) console.log(String(w).padStart(5) + 'ms  ' + t);
await browser.close();
await new Promise((r) => server.close ? server.close(r) : (server.kill?.(), r()));
