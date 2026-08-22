// Shader Garden — dgc-graph acceptance tests (wave-4 Area E).
// Usage: node tools/test/dgc-graph.mjs   (first: npm ci in tools/test)
//
// Covers the blueprint's §5 acceptance line:
//   (1) Shift+D opens/closes (three-state contract, mirrors anatomy.mjs).
//   (2) idle-costs-zero: no dgc-graph bytes before the first Shift+D.
//   (3) every rendered node/edge is 1:1 with parseScene()/analyzeConnections()
//       — no invented work types, no invented dependencies.
//   (4) the dispatch-order list matches sg_march's literal evaluation order.
//   (5) the "simplified stand-in, not real buffer producer/consumer edges"
//       disclaimer text is present.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launch, serveSite, sleep, gotoSafe, SITE_ROOT } from './browser.mjs';
import { parseScene } from '../../site/js/organs/garden/parse.js';
import { analyzeConnections } from '../../site/js/organs/garden/connections.js';

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

// Ground truth: the SAME parse the organ re-derives at runtime, computed
// here directly against the real scene.glsl on disk — no browser needed for
// this part, same technique garden-connections.mjs uses.
const sceneSrc = readFileSync(path.join(SITE_ROOT, 'assets/garden/scene.glsl'), 'utf8');
const { components } = parseScene(sceneSrc);
const { nodes: expectedNodes, edges: expectedEdges } = analyzeConnections(components);

/* ---------- 1) Shift+D opens, a second Shift+D closes, Esc closes ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  const requestedUrls = [];
  page.on('request', (req) => requestedUrls.push(req.url()));

  await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(800);

  const preHits = requestedUrls.filter((u) => u.includes('/organs/dgc-graph/'));
  check('(1) idle page fetches ZERO dgc-graph bytes', preHits.length === 0, JSON.stringify(preHits));
  check('(1) #region-overlay starts hidden', await page.evaluate(() => document.getElementById('region-overlay').hidden === true));

  await page.keyboard.down('Shift'); await page.keyboard.press('KeyD'); await page.keyboard.up('Shift');
  await page.waitForSelector('.dgc-overlay', { timeout: 8000 }).catch(() => {});
  check('(1) Shift+D opens the overlay', await page.evaluate(() => document.getElementById('region-overlay').hidden === false));

  const postHits = requestedUrls.filter((u) => u.includes('/organs/dgc-graph/'));
  check('(1) exactly one dgc-graph module fetch (idle-costs-zero -> one import())', postHits.length === 1, JSON.stringify(postHits));

  await page.keyboard.down('Shift'); await page.keyboard.press('KeyD'); await page.keyboard.up('Shift');
  await sleep(200);
  check('(1) a second Shift+D closes it', await page.evaluate(() => document.getElementById('region-overlay').hidden === true));

  await page.keyboard.down('Shift'); await page.keyboard.press('KeyD'); await page.keyboard.up('Shift');
  await page.waitForSelector('.dgc-overlay', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await sleep(200);
  check('(1) Esc closes it too', await page.evaluate(() => document.getElementById('region-overlay').hidden === true));

  const finalHits = requestedUrls.filter((u) => u.includes('/organs/dgc-graph/'));
  check('(1) no repeated fetches across open/close/reopen', finalHits.length === 1, JSON.stringify(finalHits));
  check('(1) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 2) node/edge data fidelity + dispatch order + disclaimer ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyD'); await page.keyboard.up('Shift');
  await page.waitForSelector('.dgc-overlay', { timeout: 8000 });
  await sleep(300); // let the two-rAF edge layout settle

  const cardIds = await page.evaluate(() => [...document.querySelectorAll('.dgc-card-id')].map((n) => n.textContent));
  check('(2) exactly one card per parseScene() component, no invented work types',
    JSON.stringify(cardIds.slice().sort()) === JSON.stringify(expectedNodes.map((n) => n.id).sort()),
    JSON.stringify(cardIds));

  const edgeTitles = await page.evaluate(() =>
    [...document.querySelectorAll('.dgc-edge title')].map((t) => t.textContent));
  const expectedEdgeStrings = new Set(expectedEdges.map((e) => `${e.from} → ${e.to} (${e.kind}: ${e.symbol})`));
  check('(2) edge count matches analyzeConnections() exactly', edgeTitles.length === expectedEdges.length,
    `rendered=${edgeTitles.length} expected=${expectedEdges.length}`);
  check('(2) every rendered edge is a real connections.js edge (no invented dependencies)',
    edgeTitles.every((t) => expectedEdgeStrings.has(t)), JSON.stringify(edgeTitles));

  const dispatchItems = await page.evaluate(() => [...document.querySelectorAll('.dgc-dispatch-item')].map((n) => n.textContent));
  check('(4) dispatch order matches sg_march\'s literal evaluation order',
    JSON.stringify(dispatchItems) === JSON.stringify(['terrain', 'character', 'pond', 'rocks']), JSON.stringify(dispatchItems));

  const bodyText = await page.evaluate(() => document.querySelector('.dgc-overlay').textContent);
  check('(5) the "not a live tengine connection / not a DGC executor" disclaimer is present',
    bodyText.includes('Not a live tengine connection, not a DGC executor, no vkCmdDispatchIndirect involved.'));
  check('(5) the "simplified stand-in, not real buffer producer/consumer edges" text is present',
    bodyText.includes('This is a simplified stand-in, not a real buffer producer/consumer edge.'));

  // (6) Legibility regression guard: the overlay is opened over the garden
  // scene (bright sky/terrain) — a near-transparent backdrop washes out
  // every text element under it, so pin the backdrop opacity deterministically
  // rather than relying on a human eyeballing a screenshot every time.
  const bgAlpha = await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('.dgc-overlay')).backgroundColor;
    const m = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)/.exec(bg);
    return m ? (m[1] === undefined ? 1 : Number(m[1])) : null;
  });
  check('(6) the overlay backdrop is near-opaque (alpha >= 0.85) — legible over the bright garden scene',
    bgAlpha != null && bgAlpha >= 0.85, `backgroundColor alpha=${bgAlpha}`);

  check('no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
