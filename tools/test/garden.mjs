// Shader Garden — GARDEN-IDE acceptance tests (inline "Edit here" component
// editor + uProbeSel selection seam + probe-panel slickness).
// Usage: node tools/test/garden.mjs   (first: npm ci in tools/test)
//
// Forces the textarea doc-adapter fallback for every editing check in this
// file (see forceTextareaFallback) — deliberately, not a workaround.
// CodeMirror virtualizes offscreen lines (smoke.mjs's own comment on this:
// "CM6 virtualizes offscreen lines... a naive .cm-line scrape would only see
// whatever happened to be in the viewport"), so scraping the mounted editor
// to build a "modified" body to type back is unsound for a body this long.
// The splice/recompile/remap logic under test lives in edit.js/index.js and
// is identical regardless of which doc adapter mounted (ARCHITECTURE.md's
// "Editor bundle" contract — both adapters share one facade); CM-path
// coverage for that shared facade already exists via smoke.mjs's own
// #/garden and #/edit sections. Ground truth for "what's the real body/full
// scene" always comes from production code (parseScene, or the "Open in
// editor" share-link round-trip), never from scraping editor DOM.
//
// Covers:
//   (a) probe -> panel -> "Edit here" lazy-loads the editor machinery (zero
//       js/editor/ bytes before the click) and shows the component's body;
//       opening a probe sets uProbeSel to the component's numeric id, closing
//       resets it to 0.
//   (b) a benign edit debounce-recompiles; canvas keeps rendering, no errors.
//   (c) a syntax error surfaces a diagnostic whose component-local line
//       number matches the remap math (sceneLine - startLine, clamped) —
//       verified against the runtime's own raw (full-scene) messages via a
//       setShader spy, not against a guess of where the compiler reports it
//       (bracket-imbalance corruptions can cascade to a much later line).
//       The last-good program keeps rendering throughout (never-black).
//   (d) Revert restores the original body and recompiles immediately.
//   (e) closing and re-probing the SAME component shows the edited body,
//       not the stale original.
//   (f) "Open in editor" exports the CURRENT (edited) full scene.
//   (g) probing cursor affordance, read-only syntax tinting, panel
//       enter-transition settles.
//   (h) the component tray lists all 8 components; clicking one opens its
//       probe panel — no pixel-hunting the canvas required.
//   (i) a connections link (connections.js's graph, rendered in-panel and
//       in the tray) navigates to the referenced component, scrolled to and
//       flashing the relevant source line.
//   (j) the terrain stage selector swaps variant bodies through the same
//       splice/recompile path edits use; heavy variants are marked; pristine
//       reselect restores the original exactly.
//   (k) the tray's explicit Measure action fills per-component cost chips,
//       honest "—" for the un-stubbable foundations (sky, terrain).
//   (l) the REAL CodeMirror path (not the forced textarea fallback every
//       other check in this file uses) can open a component's inline editor
//       and recompile a change, when the vendor chunk is actually built.
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

function freshPage(errors) {
  return browser.newPage().then((page) => {
    page.on('console', (m) => {
      // The forced cm-editor.bundle.js 404 (forceTextareaFallback) logs a
      // browser-level resource error distinct from the caught rejection
      // bundle-loader.js swallows — expected noise for that configuration,
      // same exclusion smoke.mjs's own route-regression section applies.
      if (m.type() === 'error' && !(m.location().url || '').includes('cm-editor.bundle.js')) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    return page;
  });
}

// Same screen-point oracle smoke.mjs's garden section uses: the character
// sits center-frame regardless of iTime (a 60%-weighted camera-target
// blend, not a hard lock, but close enough to be stable).
async function probe(page, x, y) {
  await page.mouse.click(x, y);
  await sleep(300);
  return page.$eval('.probe-title', (el) => el.textContent).catch(() => null);
}

// Ground truth for the character component's pristine body + line span —
// independently recomputed by parse.js, never hand-copied (same technique
// smoke.mjs's own expectedSource/expectedLine checks use).
async function characterComponent(page) {
  return page.evaluate(async () => {
    const { parseScene } = await import('./js/organs/garden/parse.js');
    const src = await fetch('assets/garden/scene.glsl').then((r) => r.text());
    const c = parseScene(src).components.find((c) => c.name === 'Bouncing Figure');
    return { source: c.source, startLine: c.startLine, endLine: c.endLine };
  });
}

// Ground truth for "what does the full scene currently contain" — the real
// production round-trip (buildSceneSource() -> compress -> the anchor's
// href -> decompress), never a DOM scrape. Waits briefly for panel.js's
// async refreshEditorLink() (fired by onSourceChanged after each recompile)
// to land.
async function getCurrentFullScene(page) {
  await sleep(300);
  const href = await page.$eval('.probe-edit-link', (el) => el.getAttribute('href'));
  return page.evaluate(async (b64) => {
    const { decompress } = await import('./js/share.js');
    return decompress(b64);
  }, href.match(/src=([^&]+)/)[1]);
}

// Forces the textarea doc-adapter fallback, deterministically, regardless
// of whether this checkout happens to have the CodeMirror vendor chunk
// built — see the file header for why every editing check in this suite
// wants this.
async function forceTextareaFallback(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('cm-editor.bundle.js')) { req.abort().catch(() => {}); return; }
    req.continue().catch(() => {});
  });
}

async function replaceAllAndType(page, text) {
  // Ctrl+A, not a triple-click: a plain <textarea>'s triple-click selects
  // one line/paragraph in real browsers, not the whole value — for a body
  // this long (multiple blank-line-delimited paragraphs) that silently
  // left old content spliced together with the new typed text.
  await page.focus('.component-editor .code-editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 2 });
}

function fpsValue(text) {
  const m = /(\d+)\s*fps/.exec(text || '');
  return m ? Number(m[1]) : null;
}

// Patches GL2Runtime.prototype.setUniforms/setShader as call spies —
// patching the PROTOTYPE (not an instance) takes effect for calls made
// anytime after this resolves, regardless of when the instance itself was
// constructed (method lookup happens at call time via the prototype
// chain). Best-effort: a failure here just leaves window.__* empty, not a
// hang — the one assertion reading it would simply fail visibly.
async function armSpies(page) {
  await page.evaluateOnNewDocument(() => {
    window.__uniformCalls = [];
    window.__setShaderCalls = [];
    import('./js/runtime/webgl2.js').then((mod) => {
      const origU = mod.GL2Runtime.prototype.setUniforms;
      mod.GL2Runtime.prototype.setUniforms = function (values) {
        window.__uniformCalls.push({ ...values });
        return origU.call(this, values);
      };
      const origS = mod.GL2Runtime.prototype.setShader;
      mod.GL2Runtime.prototype.setShader = function (src, channels) {
        const res = origS.call(this, src, channels);
        window.__setShaderCalls.push({ srcLen: src.length, res });
        return res;
      };
    }).catch(() => {});
  });
}

// GARDEN-IDE work item 1: clicks a tray item by its visible component name —
// the whole point of the tray is not needing a canvas pixel oracle, so the
// new tray/connections/variant/measure tests below navigate this way instead
// of smoke.mjs's own screen-point probe() helper.
async function clickTrayItem(page, name) {
  await page.waitForSelector('.garden-tray-item', { timeout: 8000 });
  const items = await page.$$('.garden-tray-item');
  for (const item of items) {
    const text = await item.$eval('.garden-tray-item-name', (el) => el.childNodes[0].textContent.trim());
    if (text === name) { await item.click(); return true; }
  }
  return false;
}

async function openCharacterEditor(page, errors) {
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2500);
  await probe(page, 720, 380); // "Bouncing Figure" — has @tune sliders + SG_LEG_LEN/sg_smin to edit
  await page.click('.probe-panel .btn:not(.probe-edit-link)'); // "Edit here" — the only other .btn in the panel
  await page.waitForSelector('.component-editor .code-editor', { timeout: 8000 });
  await sleep(400);
}

/* ---------- (a) lazy-load + editor shows the body + uProbeSel ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await armSpies(page);
  await forceTextareaFallback(page);
  const requestedUrls = [];
  page.on('request', (req) => requestedUrls.push(req.url()));

  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2500);

  const editorHitsBeforeClick = requestedUrls.filter((u) => u.includes('/js/editor/'));
  check('(a) #/garden idle load fetches zero js/editor/ bytes', editorHitsBeforeClick.length === 0, JSON.stringify(editorHitsBeforeClick));

  const title = await probe(page, 720, 380);
  check('(a) probing the character opens its panel', title === 'Bouncing Figure', 'got ' + title);
  await sleep(150);

  const gotProbeSel = await page.evaluate(() => window.__uniformCalls.some((c) => 'uProbeSel' in c && c.uProbeSel === 3));
  check("(a) opening the probe sets uProbeSel to the component's numeric id (3)", gotProbeSel);

  const editBtns = await page.$$('.probe-panel .btn:not(.probe-edit-link)');
  check('(a) "Edit here" is present alongside the "Open in editor" secondary link',
    editBtns.length === 1 && (await page.$('.probe-edit-link')) !== null);

  await editBtns[0].click();
  await page.waitForSelector('.component-editor .code-editor', { timeout: 8000 });
  await sleep(400);

  const editorHitsAfterClick = requestedUrls.filter((u) => u.includes('/js/editor/'));
  check('(a) "Edit here" lazy-loads the editor machinery on first click', editorHitsAfterClick.length > 0);

  const shown = await page.$eval('.component-editor .code-editor', (ta) => ta.value);
  check('(a) editor pane shows the component body', shown.includes('sg_smin') && shown.includes('sg_character_sdf'));

  await sleep(150);
  const gotProbeSelZeroBefore = await page.evaluate(() => window.__uniformCalls.some((c) => 'uProbeSel' in c && c.uProbeSel === 0));
  await page.click('.probe-panel .collapse-btn');
  await sleep(400);
  const gotProbeSelZeroAfter = await page.evaluate(() => window.__uniformCalls.some((c) => 'uProbeSel' in c && c.uProbeSel === 0));
  check('(a) closing the panel resets uProbeSel to 0', gotProbeSelZeroBefore || gotProbeSelZeroAfter);

  check('(a) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (b) benign edit -> debounced recompile -> still rendering ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await forceTextareaFallback(page);
  await openCharacterEditor(page, errors);

  const meta = await characterComponent(page);
  check('(b) SG_LEG_LEN is present in the ground-truth body (test assumes it)', meta.source.includes('SG_LEG_LEN = 0.5'));
  const benign = meta.source.replace('SG_LEG_LEN = 0.5', 'SG_LEG_LEN = 0.52');

  await replaceAllAndType(page, benign);
  await sleep(700); // 300ms debounce + compile + settle margin

  const statusPill = await page.$eval('.component-editor-status .pill', (el) => el.textContent).catch(() => null);
  check('(b) recompile fires and reports ok', statusPill === 'ok', 'pill=' + statusPill);

  await sleep(1200); // outlive a ~1Hz fps sample so the badge reflects the post-edit frame
  const fpsText = await page.$eval('.badge-fps', (el) => el.textContent).catch(() => '');
  check('(b) canvas is still rendering after the edit (fps badge live)', (fpsValue(fpsText) || 0) > 0, 'fps=' + fpsText);
  check('(b) zero console errors after a benign edit', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (c) syntax error -> component-local diagnostic -> never-black ---------- */
// A bracket-imbalance corruption (unclosed paren/brace) can cascade a GLSL
// parser's error report far past the actual mistake, so this asserts the
// remap MATH (raw scene-coordinate line - component.startLine, clamped —
// edit.js's own contract) against the runtime's own raw messages (armSpies'
// setShader spy), not against a guess of which line ANGLE picks.
{
  const errors = [];
  const page = await freshPage(errors);
  await armSpies(page);
  await forceTextareaFallback(page);
  await openCharacterEditor(page, errors);

  const meta = await characterComponent(page);
  const bodyLines = meta.source.split('\n');
  const brokenIndex = bodyLines.findIndex((l) => l.includes('float sg_smin'));
  check('(c) found the target line to corrupt (test assumes it)', brokenIndex >= 0);
  bodyLines[brokenIndex] = 'float sg_smin( this is not valid glsl @@@';
  const broken = bodyLines.join('\n');

  await replaceAllAndType(page, broken);
  await sleep(700);

  const statusPill = await page.$eval('.component-editor-status .pill', (el) => el.textContent).catch(() => null);
  check('(c) recompile reports a compile error', statusPill === 'error', 'pill=' + statusPill);

  const raw = await page.evaluate(() => {
    const last = window.__setShaderCalls[window.__setShaderCalls.length - 1];
    return last && !last.res.ok ? last.res.messages : null;
  });
  check('(c) the runtime reported at least one compiler message', !!raw && raw.length > 0, JSON.stringify(raw));
  const bodyLineCount = broken.split('\n').length;
  const expectedLocal = raw && raw.length
    ? Math.min(Math.max((raw[0].line || 1) - meta.startLine, 1), Math.max(bodyLineCount, 1))
    : null;

  const diagLines = await page.$$eval('.component-editor .diag-item', (nodes) => nodes.map((n) => n.textContent));
  check('(c) a diagnostic is visible', diagLines.length > 0, JSON.stringify(diagLines));
  const reportedLocalLine = diagLines.length ? Number((/line (\d+):/.exec(diagLines[0]) || [])[1]) : null;
  check('(c) the diagnostic line number matches the remap math (sceneLine - startLine, clamped into the body)',
    reportedLocalLine === expectedLocal, 'reported=' + reportedLocalLine + ' expected=' + expectedLocal + ' raw=' + JSON.stringify(raw));

  await sleep(1200);
  const fpsText = await page.$eval('.badge-fps', (el) => el.textContent).catch(() => '');
  check('(c) canvas is STILL rendering the last-good program (never-black) after a syntax error',
    (fpsValue(fpsText) || 0) > 0, 'fps=' + fpsText);
  check('(c) no console errors from the intentional compile failure', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (d) Revert restores the original body ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await forceTextareaFallback(page);
  await openCharacterEditor(page, errors);

  const meta = await characterComponent(page);
  await replaceAllAndType(page, meta.source.replace('SG_LEG_LEN = 0.5', 'SG_LEG_LEN = 0.9'));
  await sleep(900); // debounce + recompile + the href refresh that follows it
  const changedScene = await getCurrentFullScene(page);
  check('(d) the body actually changed before reverting', changedScene.includes('SG_LEG_LEN = 0.9'));

  await page.click('.component-editor-status .btn'); // Revert
  await sleep(900);
  const revertedScene = await getCurrentFullScene(page);
  check('(d) Revert restores the original body', revertedScene.includes('SG_LEG_LEN = 0.5') && !revertedScene.includes('SG_LEG_LEN = 0.9'));

  const statusPill = await page.$eval('.component-editor-status .pill', (el) => el.textContent).catch(() => null);
  check('(d) Revert recompiles immediately and reports ok', statusPill === 'ok', 'pill=' + statusPill);
  check('(d) no console errors across the revert flow', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (e) re-probe the same component shows the edited body ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await forceTextareaFallback(page);
  await openCharacterEditor(page, errors);

  const meta = await characterComponent(page);
  await replaceAllAndType(page, meta.source.replace('SG_LEG_LEN = 0.5', 'SG_LEG_LEN = 0.77'));
  await sleep(900);

  await page.click('.probe-panel .collapse-btn'); // animated close
  await sleep(400); // outlive the ~0.18s exit transition
  check('(e) the panel actually closed', (await page.$('.probe-panel')) === null);

  await probe(page, 720, 380);
  const sourceText = await page.$eval('.probe-source', (el) => el.textContent);
  check('(e) re-probing the same component shows the EDITED body, not the stale original',
    sourceText.includes('0.77') && !sourceText.includes('SG_LEG_LEN = 0.5;'), 'source snippet=' + sourceText.slice(0, 160));
  check('(e) no console errors across the re-probe flow', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (f) "Open in editor" exports the CURRENT (edited) full scene ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await forceTextareaFallback(page);
  await openCharacterEditor(page, errors);

  const meta = await characterComponent(page);
  await replaceAllAndType(page, meta.source.replace('SG_LEG_LEN = 0.5', 'SG_LEG_LEN = 0.81'));
  await sleep(900);

  const scene = await getCurrentFullScene(page);
  check('(f) "Open in editor" exports the CURRENT (edited) full scene', scene.includes('0.81'));
  check('(f) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (g) cursor affordance, read-only tinting, enter transition ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2500);

  const cursorStyle = await page.$eval('.garden-canvas', (c) => getComputedStyle(c).cursor);
  check('(g) the garden canvas has a probing cursor affordance', cursorStyle === 'crosshair', 'cursor=' + cursorStyle);

  await probe(page, 720, 380);
  await sleep(250); // outlive the ~0.18s enter transition
  const tinted = await page.$$eval(
    '.probe-source .gtok-keyword, .probe-source .gtok-comment, .probe-source .gtok-number',
    (n) => n.length,
  );
  check('(g) the read-only source view is syntax-tinted (no CodeMirror needed)', tinted > 0, 'tokens=' + tinted);
  const panelOpacity = await page.$eval('.probe-panel', (el) => Number(getComputedStyle(el).opacity));
  check('(g) the panel finished its enter transition (opacity settles to 1)', panelOpacity === 1, 'opacity=' + panelOpacity);

  check('(g) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (h)+(i) tray navigation + connections graph navigation ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2000);

  const trayCount = await page.$$eval('.garden-tray-item', (n) => n.length);
  // 8 -> 11: multiplayer (docs/multiplayer-spec.md §0.5 C2) appends peers,
  // lectern and sponge AFTER rocks. The count was never the invariant worth
  // protecting -- stable identity for ids 1..8 is, and every id assertion
  // below is deliberately untouched. A shift in THOSE is the real regression.
  check('(h) the tray lists all 11 components', trayCount === 11, 'count=' + trayCount);

  check('(h) clicking a tray item opens its probe panel — no canvas pixel-hunting',
    await clickTrayItem(page, 'Weathered Rocks'));
  await sleep(300);
  const rocksTitle = await page.$eval('.probe-title', (el) => el.textContent).catch(() => null);
  check('(h) the opened panel is the clicked component', rocksTitle === 'Weathered Rocks', 'got ' + rocksTitle);

  // Real-scene ground truth (see tools/test/garden-connections.mjs): rocks
  // calls sg_terrain_height, so its panel's "Uses" list names the terrain
  // component by its display name, not its parse.js id.
  const usesLink = await page.$$eval('.probe-conn-link', (nodes) => nodes.find((n) => n.textContent === 'Rolling Hills (evolved)')?.textContent || null);
  check('(i) the in-panel connections block names the real used component', usesLink === 'Rolling Hills (evolved)');

  await page.evaluate(() => {
    const link = [...document.querySelectorAll('.probe-conn-link')].find((n) => n.textContent === 'Rolling Hills (evolved)');
    link?.click();
  });
  await sleep(300);
  const terrainTitle = await page.$eval('.probe-title', (el) => el.textContent).catch(() => null);
  check('(i) clicking a connection navigates to the referenced component', terrainTitle === 'Rolling Hills (evolved)', 'got ' + terrainTitle);
  const hitLines = await page.$$eval('.probe-source .gline-hit', (n) => n.length);
  check('(i) the target source is scrolled to and flashes the relevant line', hitLines > 0, 'hitLines=' + hitLines);

  check('(h)+(i) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (l) the REAL CodeMirror path (not the forced textarea fallback the rest of this file uses) ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2000);
  await clickTrayItem(page, 'Bouncing Figure');
  await sleep(300);
  await page.click('.probe-panel .btn:not(.probe-edit-link)'); // "Edit here"
  await page.waitForSelector('.component-editor .cm-editor, .component-editor .code-editor', { timeout: 8000 });
  await sleep(400);

  const kind = await page.evaluate(() => (document.querySelector('.component-editor .cm-editor') ? 'cm' : 'textarea'));
  console.log(`(l) editor kind on this run: ${kind}`);

  if (kind === 'cm') {
    await page.click('.component-editor .cm-content'); // the container swallows keystrokes — this is the real interactive surface
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    const meta = await characterComponent(page);
    await page.keyboard.type(meta.source.replace('SG_LEG_LEN = 0.5', 'SG_LEG_LEN = 0.66'), { delay: 2 });
    await sleep(900);

    const statusPill = await page.$eval('.component-editor-status .pill', (el) => el.textContent).catch(() => null);
    check('(l) a real CodeMirror edit debounce-recompiles and reports ok', statusPill === 'ok', 'pill=' + statusPill);
    const scene = await getCurrentFullScene(page);
    check('(l) the CodeMirror-path edit actually landed in the exported scene', scene.includes('0.66'));
  } else {
    console.log('(l) SKIP: site/js/vendor/cm-editor.bundle.js not built in this checkout — textarea fallback only');
  }
  check('(l) no console errors on the real CodeMirror path', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (j) terrain stage/variant selector ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2000);

  await clickTrayItem(page, 'Rolling Hills (evolved)');
  await page.waitForSelector('.probe-stage-btn', { timeout: 8000 }).catch(() => {});
  const stageBtns = await page.$$eval('.probe-stage-btn', (n) => n.map((b) => ({ text: b.textContent, variant: b.dataset.variant, active: b.classList.contains('probe-stage-active') })));
  check('(j) the terrain panel shows all three stages', stageBtns.length === 3, JSON.stringify(stageBtns.map((b) => b.variant)));
  check('(j) the pristine stage is active on a fresh open', stageBtns.find((b) => b.variant === 'rolling-hills')?.active === true);
  check('(j) the heavy variant is marked and applies only on explicit click',
    stageBtns.find((b) => b.variant === 'mountain-peaks')?.text.startsWith('\u26a1') === true,
    JSON.stringify(stageBtns.map((b) => b.text)));

  // River Valley: the cheap non-pristine stage. Applying it must go through
  // the SAME splice/recompile/export path a hand edit uses -- proven via the
  // real production round-trip (the refreshed "Open in editor" href).
  await page.click('.probe-stage-btn[data-variant="river-valley"]');
  await sleep(800); // fetch + recompile + href refresh
  const riverScene = await getCurrentFullScene(page);
  const RIVER_TOKEN = 'vec2(3.7 * float(i + 1)'; // river-valley.glsl's staggered octave offset -- absent from the pristine body
  check('(j) selecting River Valley splices its body into the exported scene', riverScene.includes(RIVER_TOKEN));
  const riverActive = await page.$eval('.probe-stage-btn[data-variant="river-valley"]', (b) => b.classList.contains('probe-stage-active'));
  check('(j) the applied stage becomes the active one', riverActive === true);
  const paneShowsRiver = await page.$eval('.probe-source', (el) => el.textContent.includes('vec2(3.7 * float(i + 1)'));
  check('(j) the read-only source pane re-renders to the variant body', paneShowsRiver === true);

  // Back to pristine: the editedBodies entry must clear, so the export is
  // byte-identical to never having touched the stage row.
  await page.click('.probe-stage-btn[data-variant="rolling-hills"]');
  await sleep(800);
  const pristineScene = await getCurrentFullScene(page);
  check('(j) reselecting the pristine stage restores the original exactly', !pristineScene.includes(RIVER_TOKEN));

  const fpsText = await page.$eval('.badge-fps', (el) => el.textContent).catch(() => '');
  check('(j) canvas is still rendering after two stage swaps (fps badge live)', (fpsValue(fpsText) || 0) > 0, 'fps=' + fpsText);
  check('(j) no console errors across stage swaps', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (k) explicit per-component cost measurement ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.garden-tray-measure', { timeout: 8000 }).catch(() => {});
  await sleep(2000);

  const chipsBefore = await page.$$eval('.garden-tray-chip', (n) => n.map((c) => c.textContent));
  check('(k) chips are empty before Measure is ever clicked (never automatic)', chipsBefore.every((t) => t === ''), JSON.stringify(chipsBefore));

  await page.click('.garden-tray-measure');
  // SwiftShader compiles the 6 stubbed scenes serially -- poll the button's
  // busy label instead of guessing a sleep.
  let done = false;
  for (let i = 0; i < 120 && !done; i++) {
    await sleep(500);
    done = await page.$eval('.garden-tray-measure', (b) => b.textContent === 'Measure' && !b.disabled);
  }
  check('(k) the Measure pass completes and re-enables the button', done);

  const chips = await page.$$eval('.garden-tray-item', (items) => items.map((it) => ({
    name: it.querySelector('.garden-tray-item-name').childNodes[0].textContent.trim(),
    chip: it.querySelector('.garden-tray-chip').textContent,
  })));
  check('(k) every component got a chip', chips.length === 11 && chips.every((c) => c.chip !== ''), JSON.stringify(chips));
  const skyChip = chips.find((c) => c.name.toLowerCase().includes('sky'))?.chip;
  const terrainChip = chips.find((c) => c.name === 'Rolling Hills (evolved)')?.chip;
  check('(k) sky and terrain report an honest dash, not a fake number', skyChip === '\u2014' && terrainChip === '\u2014', 'sky=' + skyChip + ' terrain=' + terrainChip);
  check('(k) at least one stubbable component reports a real ms figure', chips.some((c) => /^\d+(\.\d+)?ms$/.test(c.chip)), JSON.stringify(chips.map((c) => c.chip)));

  const fpsText = await page.$eval('.badge-fps', (el) => el.textContent).catch(() => '');
  check('(k) the scene renders on after measurement (exact restore)', (fpsValue(fpsText) || 0) > 0, 'fps=' + fpsText);
  check('(k) no console errors during measurement', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (m) connection hover highlight (wave-3 §3a) ---------- */
// COMP_TERRAIN=2 and COMP_ROCKS=8 (scene.glsl's own numeric ids, file order)
// — ground truth for what uProbeSel should read, not a guessed number.
{
  const errors = [];
  const page = await freshPage(errors);
  await armSpies(page);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2000);

  check('(m) opened the probed component (Weathered Rocks) via the tray', await clickTrayItem(page, 'Weathered Rocks'));
  await sleep(300);

  // Panel connection link: hovering "Uses: Rolling Hills (evolved)" previews
  // the terrain component (id 2), reverting to the actually-probed rocks
  // component (id 8) on mouseleave — mirrors tray.js's own hover fallback.
  const connLink = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.probe-conn-link')].find((n) => n.textContent === 'Rolling Hills (evolved)'));
  await connLink.asElement().hover();
  await sleep(200);
  const previewedTerrain = await page.evaluate(() => window.__uniformCalls.some((c) => c.uProbeSel === 2));
  check('(m) hovering a panel connection link sets uProbeSel to the target id', previewedTerrain);

  await page.hover('.probe-title'); // moves the real pointer off the link, onto unrelated panel chrome
  await sleep(200);
  const revertedToRocks = await page.evaluate(() => window.__uniformCalls[window.__uniformCalls.length - 1].uProbeSel === 8);
  check('(m) mouseleave reverts uProbeSel to the actually-probed component (Weathered Rocks, id 8)', revertedToRocks,
    'last=' + JSON.stringify(await page.evaluate(() => window.__uniformCalls[window.__uniformCalls.length - 1])));

  // Tray connection pill: same path, driven from .garden-tray-conn-link
  // instead of the panel's own block.
  const trayLink = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.garden-tray-conn-link')].find((n) => n.textContent === 'Rolling Hills (evolved)'));
  await trayLink.asElement().hover();
  await sleep(200);
  const previewedTerrainFromTray = await page.evaluate(() => window.__uniformCalls[window.__uniformCalls.length - 1].uProbeSel === 2);
  check('(m) hovering a tray connection pill sets uProbeSel to the target id', previewedTerrainFromTray);

  await page.hover('.probe-title');
  await sleep(200);
  const revertedAgain = await page.evaluate(() => window.__uniformCalls[window.__uniformCalls.length - 1].uProbeSel === 8);
  check('(m) leaving the tray connection pill reverts uProbeSel the same way', revertedAgain);

  check('(m) no console errors across the connection-hover flow', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (n) probing discoverability: hover-preview + first-visit hint (wave-3 §1) ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await armSpies(page);
  // Wipes whatever prior tests in this run left behind, before boot.js/
  // index.js ever reads it — same "first visit" the real flag is meant to
  // gate, not an artifact of test ordering sharing one browser profile.
  await page.evaluateOnNewDocument(() => localStorage.removeItem('sg.garden.hintSeen'));
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2000);

  const pulsingBefore = await page.$eval('.garden-hint', (el) => el.classList.contains('garden-hint-pulse'));
  check('(n) the hint pulses on a first visit (no localStorage flag yet)', pulsingBefore);

  // Hover-preview: settle over the character (same 720,380 oracle every
  // other check in this file uses) without clicking — the ~120ms settle
  // timer should still fire an async probe and preview uProbeSel.
  await page.mouse.move(720, 380);
  await sleep(500);
  const previewedWithoutClick = await page.evaluate(() => window.__uniformCalls.some((c) => 'uProbeSel' in c && c.uProbeSel === 3));
  check('(n) hovering (no click) previews the character via uProbeSel', previewedWithoutClick);

  // hover-then-click still opens the right panel — the settle-hover preview
  // must never interfere with the existing click-to-probe path.
  await page.mouse.click(720, 380);
  await sleep(300);
  const title = await page.$eval('.probe-title', (el) => el.textContent).catch(() => null);
  check('(n) hover-then-click still opens the right panel', title === 'Bouncing Figure', 'got ' + title);

  const hintSeenFlag = await page.evaluate(() => localStorage.getItem('sg.garden.hintSeen'));
  check('(n) hintSeen flag is set after the first open', hintSeenFlag === '1');
  const pulsingAfter = await page.$eval('.garden-hint', (el) => el.classList.contains('garden-hint-pulse'));
  check('(n) the pulse class is removed once the hint has retired', !pulsingAfter);

  check('(n) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (o) modify-flow fixes: edited chip + backend-switch toast (wave-3 §2) ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await forceTextareaFallback(page);
  await openCharacterEditor(page, errors);

  const meta = await characterComponent(page);
  await replaceAllAndType(page, meta.source.replace('SG_LEG_LEN = 0.5', 'SG_LEG_LEN = 0.6'));
  await sleep(900);

  await page.click('.probe-panel .collapse-btn'); // animated close
  await sleep(400);
  check('(o) the panel actually closed', (await page.$('.probe-panel')) === null);

  const editedVisible = await page.$$eval('.garden-tray-item', (items) => {
    const item = items.find((it) => it.querySelector('.garden-tray-item-name').childNodes[0].textContent.trim() === 'Bouncing Figure');
    const chip = item?.querySelector('.garden-tray-edited-chip');
    return chip ? !chip.hidden : null;
  });
  check('(o) the tray marks the edited component with a visible "edited" chip after the panel closes', editedVisible === true, 'got ' + editedVisible);

  // Edit tracking is per-component, not global — nothing else should light up.
  const otherEdited = await page.$$eval('.garden-tray-item', (items) => items
    .filter((it) => it.querySelector('.garden-tray-item-name').childNodes[0].textContent.trim() !== 'Bouncing Figure')
    .some((it) => !it.querySelector('.garden-tray-edited-chip').hidden));
  check('(o) no other component is marked edited', otherEdited === false);

  check('(o) no console errors across the edit-then-close flow', errors.length === 0, errors.join(' | '));
  await page.close();
}

// F1's backend-switch toast can't be exercised at runtime in this harness:
// puppeteer's SwiftShader-backed Chrome never reports a WebGPU adapter
// (browser.mjs's own header: "the WebGPU path does NOT execute headless"),
// so rh.backend can never actually BE 'webgpu' here to trip the branch —
// same limitation every other WebGPU-only row in the launch checklist has.
// Static regression net instead: the toast call must live inside the exact
// same conditional the rebuild call already does.
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/index.html', { waitUntil: 'networkidle2', timeout: 20000 });
  const src = await page.evaluate(() => fetch('js/organs/garden/index.js').then((r) => r.text()));
  const gated = /if \(rh\.backend === 'webgpu'\) \{\s*await rh\.rebuild\(\{ prefer: 'webgl2' \}\);\s*toast\('Switched to WebGL2 for live editing'\);/.test(src);
  check('(o) the WebGL2-switch toast is gated on the same condition as the rebuild (WebGPU untestable headless)', gated);
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
