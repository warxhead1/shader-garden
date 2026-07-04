// Shader Garden — provenance lineage acceptance tests (v2 blueprint work
// item 19 / SUB-6). Usage: node tools/test/lineage.mjs   (first: npm ci in
// tools/test)
//
// Covers SUB-6's acceptance lines:
//   1. The lineage block renders a `parents` entry as a `#/s/` link when the
//      parent id resolves against the current kernel roster.
//   2. A parent id that does NOT resolve renders as plain text — the common
//      case in practice, since bake_kernels.py's curation collapses most
//      evolutionary runs to a single survivor (see ARCHITECTURE.md).
//   3. A kernel whose lineage is entirely null (the vault genuinely had no
//      facts to contribute) renders with no lineage section and no error —
//      "partial lineage never throws" is the acceptance line, and "no
//      section at all" is the most partial case there is.
//   4. gen_diff stats (prev_generation/fitness_delta/lines/similarity)
//      render as readable text.
//
// This intercepts assets/kernels.json with a small synthetic fixture rather
// than depending on whatever bake_kernels.py's live vault fetch happens to
// produce — real data (checked separately, see bake_kernels.py's own log
// output) only produces the "plain text" branch today, because curation
// collapses runs; the resolvable-link branch needs a deterministic fixture
// to exercise at all.
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

// Minimal valid mainImage body — content doesn't matter for these checks,
// only that it compiles cleanly so the viewer never logs a runtime error.
const GLSL = 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(0.2, 0.4, 0.6, 1.0); }\n';

function fixtureKernel(id, lineage) {
  return {
    id,
    title: id,
    description: 'SUB-6 lineage fixture',
    domain: 'demo',
    fitness: 0.5,
    generation: null,
    run_id: null,
    author: 'test',
    origin: 'handmade',
    language: 'glsl',
    glsl: GLSL,
    tags: ['test'],
    featured: false,
    lineage,
  };
}

const KERNELS = {
  generated: '2026-01-01T00:00:00Z',
  kernels: [
    // No lineage facts at all — the most-partial case.
    fixtureKernel('lineage-fixture-noparent', { parents: [], oracle: null, eval_run_id: null, preadmit: null, gen_diff: null }),
    // Parent id resolves against this same roster -> renders as a link.
    fixtureKernel('lineage-fixture-child', {
      parents: ['lineage-fixture-noparent'],
      oracle: null,
      eval_run_id: 'RUN_TEST_01',
      preadmit: null,
      gen_diff: { prev_generation: 5, fitness_delta: 0.0123, lines_added: 4, lines_removed: 1, similarity: 0.876 },
    }),
    // Parent id does NOT resolve -> renders as plain text.
    fixtureKernel('lineage-fixture-ghost', {
      parents: ['vault-does-not-exist'],
      oracle: null,
      eval_run_id: null,
      preadmit: null,
      gen_diff: null,
    }),
  ],
};

async function withFixture(id) {
  const errors = [];
  const page = await freshPage(errors);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().endsWith('/assets/kernels.json')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(KERNELS) });
      return;
    }
    req.continue().catch(() => {});
  });
  await gotoSafe(page, `${BASE}/index.html#/s/${id}`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.meta-panel', { timeout: 8000 }).catch(() => {});
  await sleep(200); // panel resolve() is async past the initial render
  return { page, errors };
}

/* ---------- 1) no lineage facts -> no lineage section, no error ---------- */
{
  const { page, errors } = await withFixture('lineage-fixture-noparent');
  const hasSection = await page.evaluate(() => !!document.querySelector('.meta-lineage'));
  check('(1) all-null lineage renders NO lineage section', hasSection === false);
  check('(1) no console errors from an all-null lineage block', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 2) resolvable parent -> #/s/ link ---------- */
{
  const { page, errors } = await withFixture('lineage-fixture-child');
  const hasSection = await page.evaluate(() => !!document.querySelector('.meta-lineage'));
  check('(2) lineage section renders when facts exist', hasSection === true);
  const parentHref = await page.evaluate(() => {
    const a = document.querySelector('.meta-parents a');
    return a ? a.getAttribute('href') : null;
  });
  check('(2) resolvable parent renders as a #/s/ link', parentHref === '#/s/lineage-fixture-noparent', 'got=' + parentHref);
  const evalRun = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.meta-lineage dt')];
    const dt = rows.find((d) => d.textContent === 'eval run');
    return dt ? dt.nextElementSibling.textContent : null;
  });
  check('(2) eval_run_id renders', evalRun === 'RUN_TEST_01', 'got=' + evalRun);
  const genDiff = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.meta-lineage dt')];
    const dt = rows.find((d) => d.textContent === 'gen diff');
    return dt ? dt.nextElementSibling.textContent : null;
  });
  check('(2) gen_diff renders prev generation', !!genDiff && genDiff.includes('vs gen 5'), 'got=' + genDiff);
  check('(2) gen_diff renders fitness delta', !!genDiff && genDiff.includes('0.0123'), 'got=' + genDiff);
  check('(2) gen_diff renders line counts', !!genDiff && genDiff.includes('+4/-1'), 'got=' + genDiff);
  check('(2) gen_diff renders similarity', !!genDiff && genDiff.includes('88% similar'), 'got=' + genDiff);
  check('(2) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 3) non-resolvable parent -> plain text, no link ---------- */
{
  const { page, errors } = await withFixture('lineage-fixture-ghost');
  const hasSection = await page.evaluate(() => !!document.querySelector('.meta-lineage'));
  check('(3) lineage section renders for a non-resolving parent too', hasSection === true);
  const hasLink = await page.evaluate(() => !!document.querySelector('.meta-parents a'));
  check('(3) non-resolving parent renders with NO anchor', hasLink === false);
  const parentText = await page.evaluate(() => {
    const el = document.querySelector('.meta-parents');
    return el ? el.textContent : null;
  });
  check('(3) non-resolving parent renders id + "(not in gallery)"', parentText === 'vault-does-not-exist (not in gallery)', 'got=' + parentText);
  check('(3) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
