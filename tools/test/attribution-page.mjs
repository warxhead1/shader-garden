// Shader Garden — wave-4 §3 (attribution/provenance) browser acceptance
// tests. Usage: node tools/test/attribution-page.mjs   (first: npm ci in
// tools/test)
//
// Covers §3's acceptance lines #3, #4, #5 (garden-attribution.mjs, the
// node-only sibling, covers #1/#2 — reference-integrity):
//   3. The probe panel renders an Origin block for both `evolved` and
//      `handmade` kinds, never throwing while attribution.js's fetch is in
//      flight.
//   4. The /attribution route loads and lists every kernel's origin plus
//      every garden component's kind.
//   5. Clicking a garden component's sourceKernel link lands on
//      /s/<sourceKernel> and that kernel's own lineage/provenance panel
//      renders — proves the "don't duplicate data" design connects
//      end-to-end.
// Prints "all-PASS" and exits 0 only if every check passed.
import { launch, serveSite, sleep, gotoSafe } from './browser.mjs';

const { server, base: BASE } = await serveSite();
const browser = await launch();

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

async function freshPage(errors) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return page;
}

// Same technique garden.mjs uses (GARDEN-IDE work item 1) — click a tray
// item by its visible component name, no canvas pixel oracle needed.
async function clickTrayItem(page, name) {
  await page.waitForSelector('.garden-tray-item', { timeout: 8000 });
  const items = await page.$$('.garden-tray-item');
  for (const item of items) {
    const text = await item.$eval('.garden-tray-item-name', (el) => el.childNodes[0].textContent.trim());
    if (text === name) { await item.click(); return true; }
  }
  return false;
}

/* ---------- (1) probe panel Origin block: evolved kind (terrain) ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(1000);

  const opened = await clickTrayItem(page, 'Rolling Hills (evolved)');
  check('(1) tray opens the terrain (evolved) component', opened);
  await page.waitForSelector('.probe-origin', { timeout: 8000 }).catch(() => {});
  await sleep(200);

  const badgeText = await page.$eval('.probe-origin-evolved', (el) => el.textContent).catch(() => null);
  check('(1) terrain shows the "Evolved" badge', badgeText === 'Evolved', `got ${JSON.stringify(badgeText)}`);
  const linkHref = await page.$eval('.probe-origin-link', (el) => el.getAttribute('href')).catch(() => null);
  check('(1) terrain\'s origin link points at #/s/biome-rolling-hills', linkHref === '#/s/biome-rolling-hills', `got ${JSON.stringify(linkHref)}`);
  const noteText = await page.$eval('.probe-origin-note', (el) => el.textContent).catch(() => null);
  check('(1) terrain\'s honest note is present', !!noteText && noteText.includes('TERRAIN_ROUGHNESS'), `got ${JSON.stringify(noteText)}`);
  check('(1) no console/page errors while the Origin block loaded', errors.length === 0, JSON.stringify(errors));

  await page.close();
}

/* ---------- (2) probe panel Origin block: handmade kind (rocks) ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(1000);

  const opened = await clickTrayItem(page, 'Weathered Rocks');
  check('(2) tray opens the rocks (handmade) component', opened);
  await page.waitForSelector('.probe-origin', { timeout: 8000 }).catch(() => {});
  await sleep(200);

  const badgeText = await page.$eval('.probe-origin-handmade', (el) => el.textContent).catch(() => null);
  check('(2) rocks shows the "Hand-authored" badge (never a fabricated author)', badgeText.startsWith('Hand-authored'), `got ${JSON.stringify(badgeText)}`);
  const evolvedBadgeAbsent = await page.$('.probe-origin-evolved') === null;
  check('(2) rocks does NOT show an Evolved badge', evolvedBadgeAbsent);
  check('(2) no console/page errors while the Origin block loaded', errors.length === 0, JSON.stringify(errors));

  await page.close();
}

/* ---------- (3) /attribution route: loads and lists content ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/attribution`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.attrib-page', { timeout: 8000 }).catch(() => {});
  await sleep(300);

  const h1 = await page.$eval('.attrib-page h1', (el) => el.textContent).catch(() => null);
  check('(3) page title renders', h1 === 'Attribution & provenance', `got ${JSON.stringify(h1)}`);

  const kernelLinkCount = await page.$$eval('.attrib-kernel-list .attrib-kernel-link', (els) => els.length).catch(() => 0);
  const totalKernels = await page.evaluate(async () => (await (await fetch('assets/kernels.json')).json()).kernels.length);
  check('(3) every gallery kernel is listed', kernelLinkCount === totalKernels, `listed=${kernelLinkCount} total=${totalKernels}`);

  const componentRows = await page.$$eval('.attrib-component-list .attrib-component', (els) =>
    els.map((el) => ({
      name: el.querySelector('.attrib-component-name').textContent,
      evolved: !!el.querySelector('.probe-origin-evolved'),
      handmade: !!el.querySelector('.probe-origin-handmade'),
    })));
  // Stale count, not a backend-migration change: scene.glsl now declares 11
  // @component blocks (sky, terrain, character, shadow, pond, grass, clouds,
  // rocks, peers, lectern, sponge) — smoke.mjs's own "(w) scene yields at
  // least 8 probe-able components" check already accounts for 11. This test
  // still asserts the real invariant (every component the scene declares
  // shows up here), just against the current true count.
  check('(3) all 11 garden components are listed', componentRows.length === 11, `got ${componentRows.length}`);
  const terrainRow = componentRows.find((r) => r.name.includes('Rolling Hills'));
  check('(3) terrain is listed as evolved', !!terrainRow && terrainRow.evolved && !terrainRow.handmade);
  const rocksRow = componentRows.find((r) => r.name.includes('Weathered Rocks'));
  check('(3) rocks is listed as handmade', !!rocksRow && rocksRow.handmade && !rocksRow.evolved);
  check('(3) no console/page errors on the attribution page', errors.length === 0, JSON.stringify(errors));

  /* ---------- (4) clicking a sourceKernel link lands on that kernel's own lineage ---------- */
  const kernelLinks = await page.$$('.attrib-component-list .probe-origin-link, .attrib-component-list a.attrib-kernel-link');
  // The terrain row's link is inside its <li> — locate it directly rather
  // than assuming list order.
  const clicked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.attrib-component-list .attrib-component')];
    const row = rows.find((r) => r.querySelector('.attrib-component-name').textContent.includes('Rolling Hills'));
    const link = row && row.querySelector('a');
    if (!link) return false;
    link.click();
    return true;
  });
  check('(4) terrain row has a clickable sourceKernel link', clicked);
  await page.waitForSelector('.meta-title', { timeout: 8000 }).catch(() => {});
  await sleep(200);
  const metaTitle = await page.$eval('.meta-title', (el) => el.textContent).catch(() => null);
  check('(4) clicking through lands on biome-rolling-hills\'s own provenance panel', !!metaTitle && metaTitle.includes('Rolling Hills'), `got ${JSON.stringify(metaTitle)}`);
  const fitnessRow = await page.evaluate(() => {
    const dts = [...document.querySelectorAll('.meta-list dt')];
    const dt = dts.find((d) => d.textContent === 'fitness');
    return dt ? dt.nextElementSibling.textContent : null;
  });
  check('(4) that panel shows the kernel\'s real fitness (not re-rendered here)', fitnessRow === '0.9994', `got ${JSON.stringify(fitnessRow)}`);

  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAIL' : '\nall-PASS');
process.exit(failed ? 1 : 0);
