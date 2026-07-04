// COMP-3 acceptance: the evolved-compositions bridge (v2 blueprint §7.3 item
// 26). Usage: node tools/test/comp3.mjs (npm ci in tools/test first).
//
// 1) tools/bake_compositions.py's hand-rolled kernel.composition.ready.v1
//    validation, pure Node driving the script as a subprocess against
//    crafted fixture dirs (no browser): a structurally-invalid fixture is
//    skipped and logged, never baked; a `ready: false` fixture is skipped;
//    a fixture whose run ids don't resolve against kernels.json is skipped;
//    the real committed fixture bakes cleanly and is idempotent (--dry-run
//    and a second real run both report zero net change).
// 2) The committed composition (site/assets/compositions/
//    phase-into-mountain-peaks.json) structurally validates against
//    validateComposition() (the SAME DAG check COMP-1's demo goes through)
//    and carries a `provenance` block with real fitness numbers.
// 3) Headless GL2: the composition deep link renders — canvas, WebGL2
//    badge, no console errors (same pattern as comp1.mjs's check 2).
// 4) Gallery: the channel-source/composition filter — "Compositions" shows
//    both composition cards and hides every kernel card; "Channel sources"
//    shows only the kernel(s) bake_compositions.py tagged and hides
//    everything else; "All" restores the full grid. The channel-source
//    kernel's own card carries the "channel source" badge.
// 5) Provenance: the pass graph for the evolved composition shows per-node
//    fitness (fit 0.9998 / fit 1.0000) AND the composition-level oracle
//    summary line (bake_compositions.py's `provenance` block).
// 6) Deleting the fixture + the baked composition leaves the site green:
//    re-running bake_compositions.py with an empty fixtures dir is a no-op
//    (never touches already-baked assets); with the composition's own
//    JSON + index.json entry removed from a site/ copy, the gallery still
//    renders every other card (including the COMP-1 demo) with no console
//    errors, and the deep link falls back to a not-found notice.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, serveSite, sleep, SITE_ROOT, gotoSafe } from './browser.mjs';
import { validateComposition } from '../../site/js/runtime/composition-graph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const BAKE_SCRIPT = path.join(REPO_ROOT, 'tools', 'bake_compositions.py');
const REAL_FIXTURE = path.join(REPO_ROOT, 'tools', 'fixtures', 'composition_ready', 'phase-into-mountain-peaks.json');
const COMP_ID = 'phase-into-mountain-peaks';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

function runBake(fixturesDir, kernelsPath, args = []) {
  // Runs the real bake_compositions.py against a scratch kernels.json copy
  // (via a scratch site/assets/compositions dir alongside it) so these
  // unit-level checks never touch the checked-in assets this test itself
  // later exercises in the browser.
  const out = execFileSync('python3', [BAKE_SCRIPT, '--fixtures', fixturesDir, ...args], {
    cwd: path.dirname(kernelsPath), encoding: 'utf8',
  });
  return out;
}

/* ---------- 1) bake_compositions.py validation, via subprocess ---------- */
{
  // Scratch tree: tools/ (with our own fixtures dir) + site/assets/{kernels.json,compositions/}
  // — bake_compositions.py resolves KERNELS_PATH/COMPOSITIONS_DIR relative
  // to ITS OWN location, so the scratch tree mirrors the real layout.
  const scratch = mkdtempSync(path.join(tmpdir(), 'sg-bake-'));
  const scratchTools = path.join(scratch, 'tools');
  const scratchFixtures = path.join(scratchTools, 'fixtures', 'composition_ready');
  const scratchSite = path.join(scratch, 'site', 'assets');
  mkdirSync(scratchFixtures, { recursive: true });
  mkdirSync(path.join(scratchSite, 'compositions'), { recursive: true });
  cpSync(BAKE_SCRIPT, path.join(scratchTools, 'bake_compositions.py'));
  cpSync(path.join(REPO_ROOT, 'site', 'assets', 'kernels.json'), path.join(scratchSite, 'kernels.json'));
  writeFileSync(path.join(scratchSite, 'compositions', 'index.json'), JSON.stringify({ compositions: [] }));

  const runScratch = (fixtureDoc, name, extraArgs = []) => {
    rmSync(scratchFixtures, { recursive: true, force: true });
    mkdirSync(scratchFixtures, { recursive: true });
    if (fixtureDoc !== null) writeFileSync(path.join(scratchFixtures, name + '.json'), JSON.stringify(fixtureDoc));
    return execFileSync('python3', [path.join(scratchTools, 'bake_compositions.py'), '--fixtures', scratchFixtures, ...extraArgs], {
      cwd: scratchTools, encoding: 'utf8',
    });
  };

  const validDoc = JSON.parse(readFileSync(REAL_FIXTURE, 'utf8'));

  // (a) a structurally invalid fixture (missing required data field) is skipped
  {
    const bad = JSON.parse(JSON.stringify(validDoc));
    delete bad.data.gate_threshold;
    const out = runScratch(bad, 'bad-missing-field', ['--dry-run']);
    check('(1a) missing-field fixture is SKIPped, not baked', /SKIP .* fails kernel\.composition\.ready\.v1 validation/.test(out), out.trim());
    check('(1a) the validation error names the missing field', out.includes("missing required field 'gate_threshold'"), out.trim());
  }

  // (b) a fixture with an additionalProperties violation inside `data` is skipped
  {
    const bad = JSON.parse(JSON.stringify(validDoc));
    bad.data.extra_field_not_in_schema = 'nope';
    const out = runScratch(bad, 'bad-extra-field', ['--dry-run']);
    check('(1b) data with an unschema\'d field is SKIPped', out.includes('not allowed by schema'), out.trim());
  }

  // (c) a wrong `type`/`source` const fails validation
  {
    const bad = JSON.parse(JSON.stringify(validDoc));
    bad.source = '/somewhere/else';
    const out = runScratch(bad, 'bad-source', ['--dry-run']);
    check('(1c) a wrong `source` const is SKIPped', out.includes('source must be'), out.trim());
  }

  // (d) ready:false is skipped even though it's schema-valid
  {
    const notReady = JSON.parse(JSON.stringify(validDoc));
    notReady.data.ready = false;
    const out = runScratch(notReady, 'not-ready', ['--dry-run']);
    check('(1d) ready:false is SKIPped (gate not cleared)', out.includes('ready=false'), out.trim());
  }

  // (e) a schema-valid, ready:true fixture whose run ids don't resolve is skipped
  {
    const unresolvable = JSON.parse(JSON.stringify(validDoc));
    unresolvable.data.terrain_run_id = 'nonexistent-kernel-id';
    const out = runScratch(unresolvable, 'unresolvable', ['--dry-run']);
    check('(1e) an unresolvable run id is SKIPped', out.includes('do not resolve against'), out.trim());
  }

  // (f) the REAL fixture bakes cleanly
  {
    const out = runScratch(validDoc, 'phase-into-mountain-peaks');
    check('(1f) the real fixture bakes without error', out.includes(`-> ${COMP_ID}`), out.trim());
    const compPath = path.join(scratchSite, 'compositions', COMP_ID + '.json');
    check('(1f) the composition JSON was written', existsSync(compPath));
    const idx = JSON.parse(readFileSync(path.join(scratchSite, 'compositions', 'index.json'), 'utf8'));
    check('(1f) index.json lists the new composition', idx.compositions.includes(COMP_ID), JSON.stringify(idx));
    const kernels = JSON.parse(readFileSync(path.join(scratchSite, 'kernels.json'), 'utf8'));
    const reaction = kernels.kernels.find((k) => k.id === 'vault-91e87215');
    check('(1f) the reaction kernel is tagged channel-source', reaction.tags.includes('channel-source'), JSON.stringify(reaction.tags));

    // (g) re-running is idempotent: no duplicate index entry, no duplicate tag
    const out2 = runScratch(validDoc, 'phase-into-mountain-peaks');
    check('(1g) a second run reports the tag already present (idempotent)', out2.includes('already present'), out2.trim());
    const idx2 = JSON.parse(readFileSync(path.join(scratchSite, 'compositions', 'index.json'), 'utf8'));
    check('(1g) index.json still lists the composition exactly once', idx2.compositions.filter((x) => x === COMP_ID).length === 1, JSON.stringify(idx2));
  }

  // (h) an empty fixtures dir is a clean no-op (build-time-input deletion case)
  {
    rmSync(scratchFixtures, { recursive: true, force: true });
    mkdirSync(scratchFixtures, { recursive: true });
    const out = execFileSync('python3', [path.join(scratchTools, 'bake_compositions.py'), '--fixtures', scratchFixtures], { cwd: scratchTools, encoding: 'utf8' });
    check('(1h) an empty fixtures dir is a clean no-op', out.includes('nothing to do'), out.trim());
    const idx3 = JSON.parse(readFileSync(path.join(scratchSite, 'compositions', 'index.json'), 'utf8'));
    check('(1h) the already-baked composition is untouched by the empty run', idx3.compositions.includes(COMP_ID), JSON.stringify(idx3));
  }

  rmSync(scratch, { recursive: true, force: true });
}

/* ---------- 2) the committed composition validates + carries provenance ---------- */
{
  const comp = JSON.parse(readFileSync(path.join(SITE_ROOT, 'assets', 'compositions', COMP_ID + '.json'), 'utf8'));
  const r = validateComposition(comp.passes);
  check('(2) the committed evolved composition passes DAG validation', !r.reject, JSON.stringify(r.findings));
  check('(2) both passes reference real, different, evolved kernels', comp.passes[0].kernel !== comp.passes[1].kernel);
  check('(2) carries a provenance block with the oracle\'s fitness numbers',
    comp.provenance && comp.provenance.composition_fitness != null && comp.provenance.terrain_fitness != null && comp.provenance.reaction_fitness != null,
    JSON.stringify(comp.provenance));
  const idx = JSON.parse(readFileSync(path.join(SITE_ROOT, 'assets', 'compositions', 'index.json'), 'utf8'));
  check('(2) index.json lists both the COMP-1 demo and the COMP-3 evolved composition',
    idx.compositions.includes('hills-into-icefield') && idx.compositions.includes(COMP_ID), JSON.stringify(idx));
  const kernels = JSON.parse(readFileSync(path.join(SITE_ROOT, 'assets', 'kernels.json'), 'utf8'));
  const reaction = kernels.kernels.find((k) => k.id === comp.passes[0].kernel);
  check('(2) the channel-source pass\'s kernel is tagged channel-source in the shipped kernels.json',
    reaction && Array.isArray(reaction.tags) && reaction.tags.includes('channel-source'), JSON.stringify(reaction && reaction.tags));
}

/* ---------- browser-driven checks ---------- */

const { server, base: BASE } = await serveSite();
const browser = await launch();

// (3) headless GL2 playback of the evolved composition
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html#/s/${COMP_ID}`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length).catch(() => -1);
  check('(3) evolved composition deep link renders exactly one canvas', canvases === 1, 'canvases=' + canvases);
  const badge = await page.$eval('.badge-backend', (el) => el.textContent.trim()).catch(() => null);
  check('(3) evolved composition deep link shows WebGL2 (headless)', badge === 'WebGL2', 'badge=' + badge);
  check('(3) no console errors playing the evolved composition', errors.length === 0, errors.join(' | '));
  await page.close();
}

// (4) gallery: the channel-source/composition filter
{
  const page = await browser.newPage();
  await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForSelector('.card', { timeout: 8000 });
  await sleep(300);

  const counts = await page.evaluate(() => ({
    all: document.querySelectorAll('.card:not(.card-filtered-out)').length,
    compositions: document.querySelectorAll('.card-composition').length,
  }));
  check('(4) both composition cards render under "All"', counts.compositions === 2, JSON.stringify(counts));

  await page.click('.filter-btn[data-filter="composition"]');
  await sleep(150);
  const compOnly = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.card:not(.card-filtered-out)')];
    return { count: visible.length, allComposition: visible.every((c) => c.dataset.kind === 'composition') };
  });
  check('(4) "Compositions" filter shows exactly the 2 composition cards, nothing else', compOnly.count === 2 && compOnly.allComposition, JSON.stringify(compOnly));

  await page.click('.filter-btn[data-filter="channel-source"]');
  await sleep(150);
  const chanOnly = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.card:not(.card-filtered-out)')];
    return { count: visible.length, hrefs: visible.map((c) => c.getAttribute('href')), allTagged: visible.every((c) => c.dataset.channelSource === '1') };
  });
  check('(4) "Channel sources" filter shows only channel-source-tagged kernels', chanOnly.count >= 1 && chanOnly.allTagged, JSON.stringify(chanOnly));
  check('(4) the evolved composition\'s own reaction kernel is among them', chanOnly.hrefs.includes('#/s/vault-91e87215'), JSON.stringify(chanOnly.hrefs));

  await page.click('.filter-btn[data-filter="all"]');
  await sleep(150);
  const allBack = await page.evaluate(() => document.querySelectorAll('.card:not(.card-filtered-out)').length);
  check('(4) "All" restores the full grid', allBack === counts.all, 'allBack=' + allBack + ' expected=' + counts.all);

  const badge = await page.$eval('a[href="#/s/vault-91e87215"] .badge-channel-source', (el) => el.textContent.trim()).catch(() => null);
  check('(4) the channel-source kernel\'s own card carries the "channel source" badge', badge === 'channel source', 'badge=' + badge);
  await page.close();
}

// (5) provenance: per-node fitness + the composition-level oracle summary
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html#/s/${COMP_ID}`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.meta-graph', { timeout: 8000 }).catch(() => {});
  await sleep(300);

  const nodes = await page.$$eval('.meta-graph-node', (items) => items.map((li) => ({
    kernel: li.querySelector('.meta-graph-link')?.textContent,
    fitness: li.querySelector('.meta-graph-fitness')?.textContent,
  }))).catch(() => []);
  check('(5) provenance renders one node per pass', nodes.length === 2, JSON.stringify(nodes));
  check('(5) node 0 (reaction/channel-source) shows its own fitness', nodes[0]?.kernel === 'vault-91e87215' && nodes[0]?.fitness?.includes('1.0000'), JSON.stringify(nodes));
  check('(5) node 1 (terrain consumer) shows its own fitness', nodes[1]?.kernel === 'biome-mountain-peaks' && nodes[1]?.fitness?.includes('0.9998'), JSON.stringify(nodes));

  const oracle = await page.$eval('.meta-oracle', (el) => el.textContent).catch(() => null);
  check('(5) a composition-level oracle summary line renders', !!oracle, oracle);
  check('(5) the oracle line names the composition fitness', oracle && oracle.includes('0.9421'), oracle);
  check('(5) the oracle line names the gate threshold', oracle && oracle.includes('0.85'), oracle);
  check('(5) the oracle line says "ready"', oracle && oracle.includes('ready') && !oracle.includes('not ready'), oracle);
  check('(5) no console errors rendering the evolved composition\'s provenance', errors.length === 0, errors.join(' | '));

  // The COMP-1 demo composition, by contrast, has NO oracle data of its own
  // — renderComposition() must stay null-safe, not synthesize one.
  await gotoSafe(page, `${BASE}/index.html#/s/hills-into-icefield`, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForSelector('.meta-graph', { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const demoOracle = await page.$('.meta-oracle');
  check('(5) the COMP-1 hand-authored demo shows no oracle line (bake_compositions.py never touched it, so it has no `provenance` block)', demoOracle === null);
  // Per-node fitness itself is NOT gated on a `provenance` block — it's a
  // straight kernelsById lookup, so COMP-1's demo (whose two member kernels
  // both carry real `fitness` from bake_kernels.py) gets it too. This is the
  // additive-render-path guarantee, not a COMP-3-only feature.
  const demoNodes = await page.$$eval('.meta-graph-node', (items) => items.map((li) => li.querySelector('.meta-graph-fitness')?.textContent || null)).catch(() => []);
  check('(5) the COMP-1 demo\'s own nodes ALSO show per-node fitness (additive, not COMP-3-gated)', demoNodes.every((f) => f && f.includes('fit ')), JSON.stringify(demoNodes));
  await page.close();
}

await browser.close();
server.kill();

// (6) deleting the fixture + the baked composition leaves the site green
{
  // (6a) empty fixtures dir — bake_compositions.py itself is a no-op, never
  // touches already-baked site/ assets (build-time input, not a runtime dep).
  const tmpTools = mkdtempSync(path.join(tmpdir(), 'sg-nofixture-'));
  const out = execFileSync('python3', [BAKE_SCRIPT, '--fixtures', tmpTools], { encoding: 'utf8' });
  check('(6a) bake_compositions.py with no fixtures present is a harmless no-op', out.includes('nothing to do'), out.trim());
  rmSync(tmpTools, { recursive: true, force: true });

  // (6b) runtime: remove the composition's own JSON + index.json entry
  // (COMP-1's demo stays — this only proves THIS composition is optional).
  const tmp = mkdtempSync(path.join(tmpdir(), 'sg-nocomp3-'));
  cpSync(SITE_ROOT, tmp, { recursive: true });
  rmSync(path.join(tmp, 'assets', 'compositions', COMP_ID + '.json'), { force: true });
  const idx = JSON.parse(readFileSync(path.join(tmp, 'assets', 'compositions', 'index.json'), 'utf8'));
  idx.compositions = idx.compositions.filter((id) => id !== COMP_ID);
  writeFileSync(path.join(tmp, 'assets', 'compositions', 'index.json'), JSON.stringify(idx));

  const { server: s2, base: base2 } = await serveSite(tmp);
  const b2 = await launch();

  const isExpected404 = (text, url) => (url || '').includes(COMP_ID) || text.includes(COMP_ID);

  const page = await b2.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !isExpected404(m.text(), m.location().url)) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${base2}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.card', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  // .catch(() => null/-1): a genuine renderer crash under host load (a
  // detached-frame exception, not an application bug) must surface as a
  // named FAIL below, never abort the whole run and lose every result
  // already printed above.
  const compCards = await page.$$eval('.card-composition', (els) => els.map((e) => e.getAttribute('href'))).catch(() => null);
  check('(6b) with the evolved composition removed, only the COMP-1 demo card renders', !!compCards && compCards.length === 1 && compCards[0] === '#/s/hills-into-icefield', JSON.stringify(compCards));
  const kernelCards = await page.$$eval('.card[data-kind="kernel"]', (els) => els.length).catch(() => -1);
  check('(6b) kernel cards still render normally', kernelCards > 0, 'count=' + kernelCards);
  check('(6b) no unexpected console errors on the gallery with the composition absent', errors.length === 0, errors.join(' | '));

  const page2 = await b2.newPage();
  const errors2 = [];
  page2.on('console', (m) => { if (m.type() === 'error' && !isExpected404(m.text(), m.location().url)) errors2.push(m.text()); });
  page2.on('pageerror', (e) => errors2.push(String(e)));
  await gotoSafe(page2, `${base2}/index.html#/s/${COMP_ID}`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors2.push('NAV: ' + e.message));
  await sleep(500);
  const notice = await page2.$eval('.center-notice', (el) => el.textContent).catch(() => null);
  check('(6b) the removed composition\'s deep link falls back to a not-found notice, not a crash', !!notice, notice);
  check('(6b) no unexpected console errors on the fallback notice', errors2.length === 0, errors2.join(' | '));

  await page.close();
  await page2.close();
  await b2.close();
  s2.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
