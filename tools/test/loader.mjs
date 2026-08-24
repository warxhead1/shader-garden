// Shader Garden — loader invariant tests (v2 substrate stage 2, SUB-2).
// Usage: node tools/test/loader.mjs   (first: npm ci in tools/test — shares
// the harness's one pinned dependency, tools/test/browser.mjs)
//
// Pins the two v1 hand-tuned invariants that core/loader.js must preserve
// after extracting route()/navToken out of app.js:
//   1. navToken guard — a slow #/edit import superseded by a rapid nav back
//      to #/ must never let the editor mount (v1 app.js:394,441-445 —
//      "if (token !== navToken) { discard, cleanup if mounted }").
//   2. superseded-mount cleanup — every navigation disposes the previous
//      mount and touches only its own nodes, never clear(root) (v1
//      app.js:177-179,202-204,370-374).
// Also covers: unknown route falls back to the gallery (v1 app.js:433-436).
// Written against CURRENT main (pre-loader) first — every check below reads
// state that is stable across the extraction (DOM classes, not view/region
// ids) so it passed unmodified before the extraction and stays green after
// route()/navToken move into core/loader.js.
// Prints "all-PASS" and exits 0 only if every check passed.
import { launch, serveSite, sleep, scaled, gotoSafe } from './browser.mjs';

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

/* ---------- 1) navToken guard: slow-import race ---------- */
// Delays every js/editor/* module fetch so a nav away from #/edit lands
// well before the dynamic import() resolves — the editor must never mount.
{
  const errors = [];
  const page = await freshPage(errors);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('/js/editor/')) {
      setTimeout(() => req.continue().catch(() => {}), 800);
    } else {
      req.continue().catch(() => {});
    }
  });

  await gotoSafe(page, BASE + '/index.html#/', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.card', { timeout: 8000 });

  await page.evaluate(() => { location.hash = '#/edit'; });
  await sleep(150); // let the dynamic import kick off, still well inside the delay
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(4000); // outlive the delayed import chain resolving in the background

  check('(1) editor never mounts after a superseded slow import',
    (await page.$('.code-editor')) === null);
  check('(1) gallery is back and rendered', (await page.$('.card')) !== null);
  check('(1) no console errors from the discarded mount', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 2) superseded-mount cleanup: rapid nav flips ---------- */
// #/ -> #/edit -> #/ -> #/edit -> #/ back to back, no waiting between hops —
// the same stress v1's app.js:177-179/202-204/370-374 comments guard against.
{
  const errors = [];
  const page = await freshPage(errors);
  await page.setRequestInterception(true);
  page.on('request', (req) => req.continue().catch(() => {}));

  await gotoSafe(page, BASE + '/index.html#/', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.card', { timeout: 8000 });

  await page.evaluate(() => {
    location.hash = '#/edit';
    location.hash = '#/';
    location.hash = '#/edit';
    location.hash = '#/';
  });
  await sleep(2500);

  check('(2) settles on the gallery after a rapid flip storm', (await page.$('.card')) !== null);
  check('(2) no leaked editor DOM after the flip storm', (await page.$('.code-editor')) === null);
  check('(2) no leaked editor/viewer canvases after the flip storm',
    (await page.$('.editor-canvas')) === null && (await page.$('.viewer-canvas')) === null);
  check('(2) no console errors from the flip storm', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 3) unknown route falls back to the gallery ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await page.setRequestInterception(true);
  page.on('request', (req) => req.continue().catch(() => {}));

  await gotoSafe(page, BASE + '/index.html#/nonsense', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(1200);

  check('(3) unknown route rewrites the hash to #/', page.url().endsWith('#/'), 'url=' + page.url());
  check('(3) unknown route renders the gallery', (await page.$('.card')) !== null);
  check('(3) no console errors on the fallback', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 4) mid-mount staleness: registry.load() race (loader
   mid-mount staleness item) ----------
   activate() only re-checks navToken after 'await import()' and after
   'await mountFn(ctx)' — a nav-away while mount() is suspended on its OWN
   internal await (here: viewer's ctx.registry.load(), i.e. the
   assets/kernels.json fetch) was invisible until mount() finally resolved,
   by which point the runtime ladder had already built a live canvas into a
   hidden region. ctx.alive() closes that gap. This holds the raw HTTP
   request (never even letting fetch() see a response) so the nav-away lands
   deterministically before registry.load() resolves, then polls tightly
   across the release window for any trace of the stale mount. */
{
  const errors = [];
  const page = await freshPage(errors);
  let heldReq = null;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('assets/kernels.json') && !heldReq) {
      heldReq = req; // held, not continued — released below, after the nav-away
    } else {
      req.continue().catch(() => {});
    }
  });

  await gotoSafe(page, BASE + '/index.html#/s/biome-rolling-hills', { waitUntil: 'domcontentloaded', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));

  const t0 = Date.now();
  while (!heldReq && Date.now() - t0 < 5000) await sleep(20);
  check('(4) setup: kernels.json request captured for holding', !!heldReq);

  await page.evaluate(() => { location.hash = '#/'; }); // nav away WHILE the viewer's registry.load() is still pending
  if (heldReq) heldReq.continue().catch(() => {});

  // Tight poll across the release window — this is the exact race: mount()
  // resumes right here, after registry.load(), and (pre-fix) went on to
  // build the runtime before the loader's post-mountFn() check ever ran.
  let sawCanvas = false;
  // scaled(): this is a NEGATIVE assertion, so the window is the evidence.
  // The race it watches is 6x longer in wall clock on a 6x slower machine, and
  // a 3000ms poll that ends before the stale mount would have inserted its
  // canvas passes VACUOUSLY. Widening it here makes the check stricter, not
  // weaker — the opposite of the usual direction, which is why it is scaled
  // rather than left alone.
  const pollUntil = Date.now() + scaled(3000);
  while (Date.now() < pollUntil) {
    if (await page.$('.viewer-canvas')) { sawCanvas = true; break; }
    await sleep(10);
  }

  const viewerEvents = await page.evaluate(async () => {
    const bus = await import('./js/core/bus.js');
    return bus.recent().filter((e) => e.data && e.data.organ === 'viewer');
  });

  check('(4) stale viewer mount never inserts a canvas mid-mount', !sawCanvas);
  check('(4) region-viewer holds no leftover DOM from the stale mount',
    await page.evaluate(() => document.getElementById('region-viewer').children.length === 0));
  check('(4) settles on the gallery', (await page.$('.card')) !== null);
  check('(4) no organ.opened.v1/organ.failed.v1 for the stale viewer mount',
    viewerEvents.filter((e) => e.type === 'organ.opened.v1' || e.type === 'organ.failed.v1').length === 0,
    JSON.stringify(viewerEvents));
  check('(4) no console errors from the discarded mount', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
