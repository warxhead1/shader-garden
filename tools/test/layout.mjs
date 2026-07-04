// Shader Garden — layout/provenance acceptance tests (v2 substrate SUB-4).
// Usage: node tools/test/layout.mjs   (first: npm ci in tools/test)
//
// Covers this stage's three acceptance lines (v2 blueprint §6 item 11):
//   1. The provenance panel renders on /s/:id with the license row (demand
//      adjustment #8, v2 blueprint §7.1) and collapse state survives reload
//      via ctx.layout.setPref (P10).
//   2. A corrupt localStorage diff is discarded silently — defaults win,
//      the site never bricks (substrate §5.3).
//   3. Removing the provenance placement from a served layout.json means
//      the organ's module is never fetched at all — a network-panel-style
//      check on the actual requests the page issued, not just its DOM.
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

/* ---------- 1) panel renders, license row, collapse survives reload ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/s/biome-rolling-hills`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.meta-panel', { timeout: 8000 }).catch(() => {});

  const licenseText = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.meta-list dt')];
    const dt = rows.find((d) => d.textContent === 'license');
    return dt ? dt.nextElementSibling.textContent : null;
  });
  check('(1) panel renders and docks in #region-side', !!(await page.$('#region-side .meta-panel')));
  check('(1) gallery kernel shows an explicit MIT license line', licenseText === 'MIT (Shader Garden gallery)', 'got=' + licenseText);
  check('(1) #region-side is unhidden while the panel is mounted',
    await page.evaluate(() => document.getElementById('region-side').hidden === false));

  const collapsedBefore = await page.evaluate(() => document.querySelector('.meta-panel').classList.contains('collapsed'));
  check('(1) panel starts expanded (shipped default)', collapsedBefore === false);

  await page.click('.collapse-btn');
  await sleep(150);
  const collapsedAfterClick = await page.evaluate(() => document.querySelector('.meta-panel').classList.contains('collapsed'));
  check('(1) clicking collapse toggles the class', collapsedAfterClick === true);

  const diffAfterClick = await page.evaluate(() => localStorage.getItem('sg.layout.v1'));
  check('(1) collapse persists a localStorage diff', !!diffAfterClick && JSON.parse(diffAfterClick).prefs.provenance_collapsed === true,
    'diff=' + diffAfterClick);

  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => errors.push('RELOAD: ' + e.message));
  await page.waitForSelector('.meta-panel', { timeout: 8000 }).catch(() => {});
  const collapsedAfterReload = await page.evaluate(() => document.querySelector('.meta-panel').classList.contains('collapsed'));
  check('(1) collapse state SURVIVES RELOAD', collapsedAfterReload === true);

  check('(1) no console errors across the whole flow', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 2) corrupt localStorage diff -> defaults silently ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await page.evaluateOnNewDocument(() => localStorage.setItem('sg.layout.v1', '{not json'));
  await gotoSafe(page, `${BASE}/index.html#/s/biome-rolling-hills`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.meta-panel', { timeout: 8000 }).catch(() => {});

  check('(2) a corrupt diff never bricks the page — panel still renders', !!(await page.$('.meta-panel')));
  const collapsed = await page.evaluate(() => document.querySelector('.meta-panel').classList.contains('collapsed'));
  check('(2) corrupt diff falls back to the shipped default (expanded)', collapsed === false);
  check('(2) no console errors from the corrupt diff', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 3) removing the placement -> zero provenance bytes fetched ---------- */
// Network-panel-style check: intercept every request the page issues and
// assert the provenance organ's module URL never appears among them when a
// served layout.json declares no placements — the loader must never
// import() an organ nothing wants (idle-costs-zero, substrate §3.3).
{
  const errors = [];
  const page = await freshPage(errors);
  const requestedUrls = [];
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    requestedUrls.push(req.url());
    if (req.url().endsWith('/assets/layout.json')) {
      await req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: 1, regions: { side: { el: '#region-side' } }, placements: [], prefs: {} }),
      });
      return;
    }
    req.continue().catch(() => {});
  });

  await gotoSafe(page, `${BASE}/index.html#/s/biome-rolling-hills`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(1500); // outlive any panel activation that would otherwise have happened

  const provenanceHits = requestedUrls.filter((u) => u.includes('/organs/provenance/'));
  check('(3) removing the placement fetches ZERO provenance bytes', provenanceHits.length === 0, JSON.stringify(provenanceHits));
  check('(3) region-side stays hidden with no placement wanting it',
    await page.evaluate(() => document.getElementById('region-side').hidden === true));
  check('(3) the viewer itself still renders fine without its panel', (await page.$('.viewer-topbar')) !== null);
  check('(3) no console errors with the placement removed', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 4) placement present -> provenance IS fetched (control for #3) ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  const requestedUrls = [];
  page.on('request', (req) => requestedUrls.push(req.url()));

  await gotoSafe(page, `${BASE}/index.html#/s/biome-rolling-hills`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(1500);

  const provenanceHits = requestedUrls.filter((u) => u.includes('/organs/provenance/'));
  check('(4) control: the shipped default DOES fetch provenance on /s/:id', provenanceHits.length > 0, JSON.stringify(provenanceHits));
  check('(4) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
