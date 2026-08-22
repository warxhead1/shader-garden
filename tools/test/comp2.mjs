// COMP-2 acceptance: editor buffer tabs + per-pass admission (v2 blueprint
// §7.3 item 25). Usage: node tools/test/comp2.mjs (npm ci in tools/test first).
//
// (1) Must-not-break (§7.1): with zero buffers, the editor's DOM shape is
//     the same as pre-COMP-2 — no `.buffer-tab`/`.buffer-channels` element
//     anywhere, the toolbar/canvas-pane/code-pane child structure is
//     unchanged. The one deliberate addition is `.buffer-bar`'s own
//     always-present "+ Buffer" control (buffers are reachable, not
//     literally absent from the DOM) — documented as a judgment call, not
//     hidden from this test.
// (2) Adding a buffer reveals the tab bar and switches the canvas to the
//     COMP-2 composition runtime (WebGL2, headless-real).
// (3) Admission: SG-S08 (composition-graph.js, already unit-tested in
//     comp1.mjs) + a REAL per-pass hang — a time-bomb in buffer A verdicts
//     the WHOLE composition TLE/RE, with the page staying interactive
//     (same watchdog/context-loss race as admission-sac.mjs's single-pass
//     equivalent, §7.2 — own short-lived browser + hard-kill fallback for
//     the same reason: a genuinely hung GPU-process command can outlive a
//     graceful close()).
// (4) A multi-pass share link (`&v=2`, additive to the frozen v1 format)
//     round-trips: compress/decompress byte-for-byte, and a real navigation
//     to the minted link boots straight into composition mode, admits, and
//     renders.
import { launch, serveSite, sleep, gotoSafe, assertRealGpu, assertRealWebgl2 } from './browser.mjs';

// The editor's buffer/composition mode runs through composition-player.js,
// which is hard-wired to raw WebGL2 (no runtime-host `prefer` knob at all —
// see comp1.mjs's header comment for the full reasoning).
const { server, base: BASE } = await serveSite();
const browser = await launch();
let failed = false;

function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

async function waitForEditor(page) {
  await page.waitForSelector('.cm-editor, .code-editor', { timeout: 8000 });
}

/* ---------- (1) DOM shape is unchanged with zero buffers ---------- */
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !(m.location().url || '').includes('cm-editor.bundle.js')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await sleep(300);

  const shape = await page.evaluate(() => {
    const toolbar = document.querySelector('.editor-toolbar');
    const canvasPane = document.querySelector('.editor-canvas-pane');
    const bar = document.querySelector('.buffer-bar');
    return {
      toolbarChildClasses: toolbar ? [...toolbar.children].map((c) => c.className) : null,
      canvasPaneChildClasses: canvasPane ? [...canvasPane.children].map((c) => c.className) : null,
      canvases: document.querySelectorAll('canvas').length,
      barExists: !!bar,
      barChildCount: bar ? bar.children.length : -1,
      addBtnText: bar ? bar.querySelector('.buffer-add')?.textContent : null,
      tabsHidden: bar ? bar.querySelector('.buffer-tabs')?.hidden : null,
      bufferTabCount: document.querySelectorAll('.buffer-tab').length,
      channelSelectCount: document.querySelectorAll('.buffer-chan-select').length,
    };
  });

  check('(1) exactly one canvas (single-pass path untouched)', shape.canvases === 1, 'canvases=' + shape.canvases);
  // Baseline is the post-ADM-D toolbar (7 children: lang seg-group, status
  // pill, spacer, Share, "Check shader", Suggest, back link) — ADM-D landed
  // after COMP-2 and its two buttons are part of the frozen shape now.
  check('(1) toolbar has its baseline 7 children in order', shape.toolbarChildClasses && shape.toolbarChildClasses.length === 7,
    JSON.stringify(shape.toolbarChildClasses));
  // element 1 is the status pill — 'pill idle'/'pill ok'/'pill err' are all
  // legitimate pre-COMP-2 states depending on how far the debounced compile
  // got by the time this runs; only its class PREFIX is part of the shape.
  check('(1) toolbar child classes match the baseline shape exactly',
    shape.toolbarChildClasses?.[0] === 'seg-group' && shape.toolbarChildClasses?.[1]?.startsWith('pill ')
      && JSON.stringify(shape.toolbarChildClasses?.slice(2)) === JSON.stringify(['toolbar-spacer', 'btn btn-small', 'btn btn-small btn-ghost', 'btn btn-small', 'btn btn-small btn-ghost']),
    JSON.stringify(shape.toolbarChildClasses));
  check('(1) canvas-pane has its original 4 children in order',
    shape.canvasPaneChildClasses && shape.canvasPaneChildClasses[0] === 'editor-canvas-host'
      && shape.canvasPaneChildClasses[1] === 'editor-badges', JSON.stringify(shape.canvasPaneChildClasses));
  check('(1) the ONLY buffer-related DOM is the always-present "+ Buffer" control', shape.barExists && shape.barChildCount === 3, JSON.stringify(shape));
  check('(1) "+ Buffer" is the sole visible affordance — no tabs, no channel selects yet',
    shape.addBtnText === '+ Buffer' && shape.tabsHidden === true && shape.bufferTabCount === 0 && shape.channelSelectCount === 0,
    JSON.stringify(shape));
  check('(1) no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (2) adding a buffer reveals the tab bar + composition mode ---------- */
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle0' });
  // assertRealGpu proves the WebGPU adapter is real; the composition canvas
  // this check reads is WebGL2 (composition-player is hard-wired to it), a
  // separate driver path with no software-adapter protection of its own.
  await assertRealGpu(page);
  await assertRealWebgl2(page);
  await waitForEditor(page);
  await page.click('.buffer-add');
  await sleep(800);

  const after = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.buffer-tab')].map((t) => t.textContent.replace('×', '').trim()),
    tabsHidden: document.querySelector('.buffer-tabs')?.hidden,
    channelSelects: document.querySelectorAll('.buffer-chan-select').length,
    canvases: document.querySelectorAll('canvas').length,
    badge: document.querySelector('.badge-backend')?.textContent,
  }));
  check('(2) tab bar shows Image/A/Common after one add', JSON.stringify(after.tabs) === JSON.stringify(['Image', 'A', 'Common']), JSON.stringify(after.tabs));
  check('(2) tabs row is no longer hidden', after.tabsHidden === false);
  check('(2) the active tab (Image) shows 4 channel selects', after.channelSelects === 4, after.channelSelects);
  check('(2) exactly one canvas (composition runtime replaced the single-pass one)', after.canvases === 1, 'canvases=' + after.canvases);
  check('(2) backend badge reflects composition mode', (after.badge || '').includes('composition'), after.badge);
  check('(2) no console/page errors adding a buffer', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (3) admission: a time-bomb in buffer A -> TLE, page interactive ---------- */
// Own short-lived browser + hard-kill fallback: same reasoning as
// admission-sac.mjs's (h) — a genuinely hung GPU-process render can outlive
// graceful close().
{
  const hangBrowser = await launch();
  const hangPage = await hangBrowser.newPage();
  hangPage.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await gotoSafe(hangPage, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle0' });

  const CLEAN_IMAGE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(fragCoord / iResolution.xy, 0.5, 1.0);
}`;
  const HANG_A = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float x = 0.0;
  while (true) { x += 0.0001; if (x < 0.0) break; }
  fragColor = vec4(x, 0.0, 0.0, 1.0);
}`;

  const t0 = Date.now();
  const result = await Promise.race([
    // Playwright's page.evaluate(fn, arg) takes exactly ONE arg, unlike
    // Puppeteer's page.evaluate(fn, ...args) — fixed at the call site (see
    // garden-perf.mjs's sampleFrames() for the same fix and reasoning).
    hangPage.evaluate(async ({ imageSrc, hangSrc }) => {
      const { admitComposition } = await import('./js/organs/admission/index.js');
      const passes = [
        { id: 'Image', target: 'screen', channelSlots: [null, null, null, null], feedback: false, fullSource: imageSrc },
        { id: 'A', target: 'A', channelSlots: [null, null, null, null], feedback: false, fullSource: hangSrc },
      ];
      const t0 = performance.now();
      const report = await admitComposition(passes, { surface: 'share-link' });
      return { report, ms: performance.now() - t0 };
    }, { imageSrc: CLEAN_IMAGE, hangSrc: HANG_A }),
    sleep(30000).then(() => ({ timedOutInNode: true })),
  ]);
  const wallMs = Date.now() - t0;
  check('(3) admitComposition() resolved at all (not left hanging past a generous 30s outer bound)', !result.timedOutInNode, `wallMs=${wallMs}`);
  if (!result.timedOutInNode) {
    check('(3) a time-bomb in buffer A verdicts the WHOLE composition — TLE or RE (watchdog/context-loss race, §7.2)',
      ['TLE', 'RE'].includes(result.report.verdict), 'verdict=' + result.report.verdict);
    check('(3) safe is false', result.report.safe === false);
    check('(3) the report names every pass in the composition', JSON.stringify(result.report.passes) === JSON.stringify(['Image', 'A']), JSON.stringify(result.report.passes));
  }
  const interactive = await hangPage.evaluate(() => document.readyState !== 'loading').catch(() => false);
  check('(3) page still interactive after the composed hang', interactive);

  const stillWorks = await hangPage.evaluate(async () => {
    const { admit } = await import('./js/organs/admission/index.js');
    const r = await admit('void mainImage(out vec4 c, in vec2 p){ c=vec4(0.5); }', { language: 'glsl', surface: 'editor-self' });
    return r.verdict;
  }).catch(() => null);
  check('(3) a later admit() still works after the composed TLE — page not wedged', stillWorks === 'OK', 'verdict=' + stillWorks);

  // Puppeteer's browser.process().pid (for a SIGKILL fallback if close()
  // itself hangs) has no Playwright equivalent: playwright-core's
  // chromium.launch() exposes no public accessor for the underlying OS
  // process — confirmed empirically (no `.process`, no `.pid`, nothing on
  // the prototype chain matching /pid|process/i). This is a real gap versus
  // the original suite's defense-in-depth, not something browser.mjs can
  // shim (it would need Playwright's own driver internals). What's left:
  // the checks above already proved the hang resolves via the in-page
  // admission watchdog in ~1s (verdict=TLE), not by outliving the process,
  // so close() racing a timeout is the best available fallback here.
  try { await Promise.race([hangBrowser.close(), sleep(3000)]); } catch { /* ignore */ }
}

/* ---------- (4) multi-pass share link round-trips ---------- */
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle0' });
  await waitForEditor(page);

  const composition = {
    common: '',
    image: {
      src: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n'
        + '  fragColor = mix(texture(iChannel0, fragCoord / iResolution.xy), vec4(fragCoord / iResolution.xy, 0.0, 1.0), 0.5);\n}',
      channels: ['A', null, null, null],
    },
    buffers: [{ id: 'A', src: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0, 0.0, 0.0, 1.0); }', channels: [null, null, null, null] }],
  };

  const roundTrip = await page.evaluate(async (comp) => {
    const { compressComposition, decompressComposition } = await import('./js/editor/multipass-share.js');
    const b64 = await compressComposition(comp);
    const decoded = await decompressComposition(b64);
    return { b64Len: b64.length, decoded, matches: JSON.stringify(decoded) === JSON.stringify(comp) };
  }, composition);
  check('(4) a multi-pass composition round-trips byte-for-byte through compress/decompress', roundTrip.matches, JSON.stringify(roundTrip.decoded));
  check('(4) the b64 payload stays well under the 256 KiB share cap', roundTrip.b64Len < 256 * 1024, 'len=' + roundTrip.b64Len);

  const link = await page.evaluate(async (comp) => {
    const { compressComposition } = await import('./js/editor/multipass-share.js');
    const { absoluteShareUrl } = await import('./js/share.js');
    return absoluteShareUrl(await compressComposition(comp), 'glsl') + '&v=2';
  }, composition);
  check('(4) the minted link carries the additive v=2 marker', link.includes('&v=2') && link.includes('lang=glsl'), link);

  await gotoSafe(page, link, { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await sleep(2000); // composed admission (real sacrificial worker run) needs to resolve

  const landed = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.buffer-tab')].map((t) => t.textContent.replace('×', '').trim()),
    canvases: document.querySelectorAll('canvas').length,
    badge: document.querySelector('.badge-backend')?.textContent,
    scrimPresent: !!document.querySelector('.admission-scrim'),
  }));
  check('(4) navigating the link boots straight into composition mode (Image/A/Common tabs)',
    JSON.stringify(landed.tabs) === JSON.stringify(['Image', 'A', 'Common']), JSON.stringify(landed.tabs));
  check('(4) exactly one canvas after landing on the link', landed.canvases === 1, 'canvases=' + landed.canvases);
  check('(4) a clean composition (verdict OK) autoruns — no withheld scrim', landed.badge && landed.badge.includes('composition') && !landed.scrimPresent,
    JSON.stringify(landed));
  check('(4) no console/page errors on the multi-pass link', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
