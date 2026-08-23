// PERF-4 verification: does the ladder actually reach for shader quality once
// resolution is pinned, and does it leave a healthy mount alone?
import { launch, serveSite, sleep, gotoSafe } from '../browser.mjs';
const { server, base: BASE } = await serveSite();
const browser = await launch();
const page = await browser.newPage();
await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
// Open the live uniform inspector — SG_QUALITY is a real bank resident, so
// this reads the value the shader is actually running with rather than a
// number the harness computed for itself.
await new Promise((r) => setTimeout(r, 2500));  // toggle is wired on mount, not on first paint
await page.click('.garden-uniform-toggle');
for (let i = 0; i < 9; i++) {
  await new Promise((r) => setTimeout(r, 3000));           // unscaled: real ladder seconds
  const st = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return {
      perf: (document.querySelector('.badge-perf') || {}).textContent || '',
      sgq: (() => {
        for (const r of document.querySelectorAll('.garden-uniform-row')) {
          if (r.textContent.includes('SG_QUALITY')) return r.textContent.trim().replace(/\s+/g, ' ');
        }
        return 'not shown';
      })(),
      backing: c ? `${c.width}x${c.height}` : '?',
    };
  });
  console.log(`t=${(i + 1) * 3}s  backing=${st.backing}  perf="${st.perf.trim()}"  ${st.sgq}`);
}
await browser.close();
await new Promise((r) => server.close ? server.close(r) : (server.kill?.(), r()));
