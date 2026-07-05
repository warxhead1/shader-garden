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

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
