// Shader Garden — anatomy acceptance tests (v2 substrate SUB-5).
// Usage: node tools/test/anatomy.mjs   (first: npm ci in tools/test)
//
// Covers this stage's acceptance line (v2 blueprint work item 14):
//   "closed cost = one keydown listener (no module fetched — network panel);
//    deleting its organs.json line removes the feature entirely."
// Plus the substrate §8 behaviors: input/textarea/CodeMirror focus guard,
// organ graph (dashed -> solid+lit on live traffic), event log filter,
// layout inspector apply + reset.
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

/* ---------- 1) zero cost when closed: no anatomy bytes fetched, Shift+A opens it ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  const requestedUrls = [];
  page.on('request', (req) => requestedUrls.push(req.url()));

  await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(1000);

  const preHits = requestedUrls.filter((u) => u.includes('/organs/anatomy/'));
  check('(1) idle page fetches ZERO anatomy bytes', preHits.length === 0, JSON.stringify(preHits));
  check('(1) #region-overlay starts hidden', await page.evaluate(() => document.getElementById('region-overlay').hidden === true));

  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  await page.waitForSelector('.anatomy-overlay', { timeout: 8000 }).catch(() => {});

  const postHits = requestedUrls.filter((u) => u.includes('/organs/anatomy/'));
  check('(1) Shift+A fetches exactly the anatomy module (not zero, not repeated)', postHits.length === 1, JSON.stringify(postHits));
  check('(1) the overlay is now visible', await page.evaluate(() => document.getElementById('region-overlay').hidden === false));
  check('(1) no console errors opening anatomy', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 2) Shift+A is guarded against input/textarea/CodeMirror focus ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.cm-editor, .code-editor', { timeout: 8000 });

  // Focus whichever doc adapter mounted (CodeMirror's .cm-content or the
  // textarea fallback — both are legitimate "the editor must never lose a
  // keystroke to chrome" surfaces).
  await page.evaluate(() => {
    const target = document.querySelector('.cm-content') || document.querySelector('.code-editor');
    target.focus();
  });
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  await sleep(400);
  check('(2) Shift+A while the editor is focused does NOT open anatomy',
    await page.evaluate(() => document.getElementById('region-overlay').hidden === true));

  // Blur to the body, then the same keystroke DOES open it (control).
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  await page.waitForSelector('.anatomy-overlay', { timeout: 8000 }).catch(() => {});
  check('(2) control: Shift+A with nothing focused DOES open anatomy',
    await page.evaluate(() => document.getElementById('region-overlay').hidden === false));
  check('(2) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 3) organ graph: cards render, an edge lights up on real traffic ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/s/biome-rolling-hills`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(500);
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyA'); await page.keyboard.up('Shift');
  await page.waitForSelector('.anatomy-overlay', { timeout: 8000 });

  const cardIds = await page.evaluate(() => [...document.querySelectorAll('.anatomy-card-id')].map((n) => n.textContent));
  check('(3) a card renders for every manifest organ', cardIds.includes('viewer') && cardIds.includes('anatomy') && cardIds.includes('gallery'),
    JSON.stringify(cardIds));

  // The viewer already emitted kernel.opened.v1 on its own mount, backfilled
  // via bus.recent() — that edge should already be lit/solid, not dashed,
  // by the time anatomy finishes its first layout pass.
  await sleep(300);
  const kernelOpenedSolid = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.anatomy-edge')];
    return lines.some((l) => l.querySelector('title')?.textContent.includes('kernel.opened.v1') && !l.classList.contains('anatomy-edge-dashed'));
  });
  check('(3) kernel.opened.v1 edge is solid (recent() backfill), not dashed', kernelOpenedSolid);

  const anyDashedRemains = await page.evaluate(() =>
    [...document.querySelectorAll('.anatomy-edge-dashed')].some((l) => l.querySelector('title')?.textContent.includes('runtime.lost.v1')));
  check('(3) runtime.lost.v1 (needs an actual context loss) legitimately stays dashed', anyDashedRemains);
  check('(3) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 4) event log: recent() backfill + live tap + filter ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/s/biome-rolling-hills`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(500);
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyA'); await page.keyboard.up('Shift');
  await page.waitForSelector('.anatomy-overlay', { timeout: 8000 });

  const rowCountBefore = await page.evaluate(() => document.querySelectorAll('.anatomy-log-row').length);
  check('(4) event log has rows from bus.recent() backfill on open', rowCountBefore > 0, 'rows=' + rowCountBefore);

  await page.type('.anatomy-filter', 'kernel.opened');
  await sleep(150);
  const visibleAfterFilter = await page.evaluate(() =>
    [...document.querySelectorAll('.anatomy-log-row')].filter((r) => !r.hidden).every((r) => r.dataset.type.includes('kernel.opened')));
  const anyVisible = await page.evaluate(() => [...document.querySelectorAll('.anatomy-log-row')].some((r) => !r.hidden));
  check('(4) filter hides non-matching rows', visibleAfterFilter && anyVisible);

  await page.evaluate(() => { document.querySelector('.anatomy-filter').value = ''; document.querySelector('.anatomy-filter').dispatchEvent(new Event('input')); });
  await page.evaluate(() => document.querySelector('.anatomy-log-head').click());
  const dataVisible = await page.evaluate(() => !document.querySelector('.anatomy-log-data').hidden);
  check('(4) clicking a row expands its data pre', dataVisible);
  check('(4) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 5) layout inspector: apply prefs + reset ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyA'); await page.keyboard.up('Shift');
  await page.waitForSelector('.anatomy-overlay', { timeout: 8000 });

  const initialJson = await page.$eval('.anatomy-layout-json', (ta) => ta.value);
  check('(5) layout inspector shows the current prefs as JSON', (() => { try { JSON.parse(initialJson); return true; } catch { return false; } })(), initialJson);

  await page.evaluate(() => { document.querySelector('.anatomy-layout-json').value = JSON.stringify({ anatomy_test_pref: 42 }); });
  await page.click('.anatomy-layout-actions .btn:not(.anatomy-reset)');
  await sleep(150);
  const diff = await page.evaluate(() => localStorage.getItem('sg.layout.v1'));
  check('(5) Apply prefs persists a localStorage diff with the new key', !!diff && JSON.parse(diff).prefs.anatomy_test_pref === 42, 'diff=' + diff);

  await page.click('.anatomy-reset');
  await sleep(300);
  const diffAfterReset = await page.evaluate(() => localStorage.getItem('sg.layout.v1'));
  check('(5) Reset layout clears the localStorage key (page reloads)', diffAfterReset === null, 'diff=' + diffAfterReset);
  check('(5) no console errors across the layout-inspector flow', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 6) deleting the organs.json line removes the feature entirely ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.url().endsWith('/assets/organs.json')) {
      const res = await fetch(`${BASE}/assets/organs.json`);
      const json = await res.json();
      json.organs = json.organs.filter((o) => o.id !== 'anatomy');
      await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
      return;
    }
    req.continue().catch(() => {});
  });

  await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(500);
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyA'); await page.keyboard.up('Shift');
  await sleep(500);

  check('(6) with the organs.json entry removed, Shift+A does nothing (overlay never opens)',
    await page.evaluate(() => document.getElementById('region-overlay').hidden === true));
  check('(6) the rest of the site still works fine without anatomy', (await page.$('#gallery-grid')) !== null);
  check('(6) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
