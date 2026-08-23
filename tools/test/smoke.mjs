// Smoke harness: the substrate §10 regression oracle + admission acceptance.
// Usage: node tools/test/smoke.mjs [route ...]   (first: npm ci in tools/test)
//
// 1) Loads each route headlessly and fails on any console/page error.
// 2) Admission acceptance: (a) a #/edit?src= link declaring its own
//    "void main(" loads into the editor but does NOT autorun, the scrim names
//    SG-S02, and the first user edit reclassifies to editor-self; (b) typing
//    the same source directly is never blocked — findings surface as advisory
//    diagnostics; (e) a clean share link still autoruns.
// 6) ED-4: uniforms inspector (usage-scan + freeze), record WebM (real
//    headless captureStream+MediaRecorder path AND the feature-detect
//    degrade path), the "Run it" scrim consent, and shader.compiled.v1.
// 7) ADM-D: "Check shader" runs the full pipeline on demand for editor-self
//    and never blocks typing; Suggest stays disabled until a fresh safe
//    verdict exists; the Suggest issue body embeds a parseable fenced
//    verdict-JSON block (minus preview_png); a real captured glsl verdict
//    validates against nervous-bus's shader.preadmit.evaluated.v1 (READ
//    ONLY) after stripping browser-only keys, via python3 jsonschema; the
//    operator-mode ring export (organs/anatomy) downloads the ring as JSON.
// Prints "all-PASS" and exits 0 only if every check passed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, serveSite, sleep, gotoSafe, SITE_ROOT, assertRealGpu, assertRealWebgl2 } from './browser.mjs';

const routes = process.argv.slice(2);
const DEFAULT_ROUTES = ['#/', '#/s/biome-rolling-hills', '#/edit', '#/edit?k=biome-rolling-hills', '#/garden'];

const { server, base: BASE } = await serveSite();
const browser = await launch();
let failed = false;

// Prove the browser this whole battery runs in actually got the real GPU —
// a green smoke suite must not be able to mean "we quietly ran on
// SwiftShader" (migration brief). One check, on a throwaway page, up front.
{
  const gpuPage = await browser.newPage();
  await gotoSafe(gpuPage, BASE + '/index.html#/', { waitUntil: 'networkidle2', timeout: 20000 });
  await assertRealGpu(gpuPage);
  await gpuPage.close();
}

function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

/* ---------- 1) route regression ---------- */

for (const route of (routes.length ? routes : DEFAULT_ROUTES)) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    // ED-2 fallback contract: with site/js/vendor/cm-editor.bundle.js
    // deliberately absent (ACCEPT: "moved aside"), the dynamic import's
    // failed network fetch is logged by the browser itself, separately from
    // the caught rejection bundle-loader.js swallows — expected noise for
    // that configuration, not a regression.
    if (m.type() === 'error' && !(m.location().url || '').includes('cm-editor.bundle.js')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html${route}`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(2500);
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length).catch(() => -1);
  check(`${route} canvases=${canvases}`, errors.length === 0, errors.join(' | ') || undefined);
  await page.close();
}

/* ---------- 2) admission acceptance ---------- */
// Both doc adapters (ED-2: CodeMirror when site/js/vendor/cm-editor.bundle.js
// exists, textarea fallback when it doesn't) share one DOM contract: exactly
// one of `.cm-editor` or a bare `.code-editor` textarea is present. These
// helpers read/drive whichever one mounted so every check below runs
// unchanged against both — this IS the fallback-parity check (ACCEPT: "run
// smoke.mjs with the chunk moved aside — restore after").

const FORBIDDEN = `void main() { /* wrapper subversion attempt */ }
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(1.0);
}
`;

async function shareLinkFor(page, source, lang) {
  return page.evaluate(async ({ src, l }) => {
    const { compress, absoluteShareUrl } = await import('./js/share.js');
    return absoluteShareUrl(await compress(src), l);
  }, { src: source, l: lang });
}

// The editor mount is async: createDocAdapter() awaits the 375KB CodeMirror
// vendor chunk and falls back to a textarea, so BOTH outcomes end in an
// element carrying one of these classes. Only a never-settling await, or a
// machine slow enough to miss the budget, produces neither.
//
// 8000ms was tuned on a workstation and is not a bound on anything real — a
// GitHub runner is 2 cores with no GPU, and measured on one, a single garden
// route took 44s against ~4s here. A wait budget is not an assertion: raising
// it retires no check, it only stops the slowest legitimate machine from
// being called broken. The failure it must still catch — a mount that never
// happens at all — is unaffected by waiting longer.
// Back to the original tight 8000. It is no longer a special case: waitForSelector
// scales an explicit timeout by SG_TIME_SCALE, so this is 8s on a dev box (where a
// slow mount IS a regression worth failing on) and 48s on a runner measured at 6x.
// A per-symptom env var here would double-scale and hide the very regressions the
// tight local number exists to catch.
const EDITOR_TIMEOUT_MS = 8000;

async function waitForEditor(page) {
  const t0 = Date.now();
  try {
    await page.waitForSelector('.cm-editor, .code-editor', { timeout: EDITOR_TIMEOUT_MS });
  } catch (e) {
    // Report WHY rather than just "timed out". Distinguishes the three cases
    // that look identical from the outside: the page never navigated, the
    // editor host mounted but the adapter never resolved, or the adapter
    // resolved into a DOM we are selecting wrongly.
    const diag = await page.evaluate(async () => {
      // Ask the APP whether it got ready, instead of only inferring readiness
      // from a DOM side-effect. bus.js's recent() is a ring buffer, so this
      // sees events that ALREADY fired — no listener-registered-too-late race
      // (the trap that hung four relay suites tonight via once('listening')).
      let organsOpened = 'unavailable';
      try {
        const { recent } = await import('./js/core/bus.js');
        organsOpened = recent().filter((e) => e.type === 'organ.opened.v1')
          .map((e) => (e.data && e.data.organ) || '?');
      } catch (err) { organsOpened = 'import failed: ' + String(err); }
      return {
        url: location.href,
        readyState: document.readyState,
        title: document.title,
        bodyLen: document.body ? document.body.innerHTML.length : -1,
        // #region-editor is the ACTUAL host (site/index.html:77). The first
        // version of this diagnostic looked for #editor/.editor/[data-organ],
        // none of which exist in this app — it would have reported "no editor
        // host" on EVERY timeout and sent the next investigation hunting a
        // mount failure that was not there. A diagnostic that lies is worse
        // than no diagnostic, because it is believed.
        hasEditorHost: !!document.querySelector('#region-editor'),
        organsOpened,
        canvases: document.querySelectorAll('canvas').length,
        classesOnBody: document.body ? document.body.className : null,
        firstIds: [...document.querySelectorAll('[id]')].slice(0, 12).map((n) => n.id),
      };
    }).catch((err) => ({ evaluateFailed: String(err) }));
    console.log(`  [waitForEditor] TIMEOUT after ${Date.now() - t0}ms: ${JSON.stringify(diag)}`);
    throw e;
  }
  const ms = Date.now() - t0;
  // Surfaced so a runner that is merely slow is visible in the log as slow,
  // instead of silently creeping back up on the budget.
  if (ms > 5000) console.log(`  [waitForEditor] slow mount: ${ms}ms`);
}

async function editorInfo(page) {
  return page.evaluate(() => {
    const cm = document.querySelector('.cm-editor');
    if (cm) {
      const value = [...cm.querySelectorAll('.cm-content > .cm-line')].map((l) => l.textContent).join('\n');
      return { kind: 'cm', value };
    }
    const ta = document.querySelector('.code-editor');
    return { kind: 'textarea', value: ta ? ta.value : null };
  });
}

async function focusEditor(page) {
  const { kind } = await editorInfo(page);
  if (kind === 'cm') await page.click('.cm-content');
  else await page.focus('.code-editor');
  return kind;
}

// Replaces the whole doc, then types `text`. CM: Ctrl-A (defaultKeymap binds
// Mod-a to selectAll) + Backspace. Textarea: triple-click + Backspace (v1
// behavior, unchanged).
async function replaceAllAndType(page, text) {
  const kind = await focusEditor(page);
  if (kind === 'cm') {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
  } else {
    await page.click('.code-editor', { clickCount: 3 });
    await page.keyboard.press('Backspace');
  }
  await page.keyboard.type(text, { delay: 2 });
  return kind;
}

// (a) foreign share link containing "void main(" is gated
{
  const seed = await browser.newPage();
  await gotoSafe(seed, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(seed);
  const vfLink = await shareLinkFor(seed, FORBIDDEN, 'glsl');
  await seed.close();

  const page = await browser.newPage();
  await gotoSafe(page, vfLink, { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await sleep(600);

  const loaded = await editorInfo(page);
  check('(a) foreign source loaded into the editor', (loaded.value || '').includes('wrapper subversion attempt'), 'kind=' + loaded.kind);

  const scrimText = await page.$eval('.admission-scrim', (el) => el.textContent).catch(() => null);
  check('(a) scrim is shown — autorun withheld', !!scrimText, scrimText ? scrimText.slice(0, 48) : 'no scrim');
  check('(a) report names SG-S02', !!scrimText && scrimText.includes('SG-S02'));

  const statusIdle = await page.$eval('.pill', (el) => el.textContent.trim());
  check('(a) no autorun — status pill still idle', statusIdle === 'idle', 'status=' + statusIdle);

  // the user's own edit clears the scrim and reclassifies the session as editor-self
  await focusEditor(page);
  await page.keyboard.type(' ');
  await sleep(900);
  check('(a) scrim clears on the first user edit', (await page.$('.admission-scrim')) === null);
  const statusAfterEdit = await page.$eval('.pill', (el) => el.textContent.trim());
  check('(a) compile attempted after the edit — not stuck idle', statusAfterEdit !== 'idle', 'status=' + statusAfterEdit);
  await page.close();
}

// (b) editor-self typing is never blocked
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  const kind = await replaceAllAndType(page, FORBIDDEN);
  await sleep(900);

  check('(b) editor-self typing never shows the gate scrim', (await page.$('.admission-scrim')) === null);
  const statusB = await page.$eval('.pill', (el) => el.textContent.trim());
  check('(b) editor-self compile was attempted', statusB !== 'idle', 'status=' + statusB);

  if (kind === 'cm') {
    // CM path: no diag-list (that's the textarea fallback's surface, §4) —
    // the SG-S02 finding surfaces as a squiggle instead. ED-2 acceptance
    // section below pins the squiggle-line mechanism directly; here just
    // confirm the list stays empty/hidden (no duplicate surface).
    const listHidden = await page.$eval('.diag-list', (el) => el.hidden).catch(() => true);
    check('(b) CM: diag-list stays hidden (squiggles are the CM surface, not the list)', listHidden !== false);
  } else {
    const diagTexts = await page.$$eval('.diag-item', (nodes) => nodes.map((n) => n.textContent));
    const diagClasses = await page.$$eval('.diag-item', (nodes) => nodes.map((n) => n.className));
    check('(b) SG-S02 finding present as an advisory diagnostic',
      diagTexts.some((t) => t.includes('SG-S02')), JSON.stringify(diagTexts));
    check('(b) advisory findings render as warnings, not errors',
      diagClasses.filter((c) => c.includes('diag-warning')).length > 0, JSON.stringify(diagClasses));
  }
  await page.close();
}

// (e) a clean share link still autoruns
{
  const seed = await browser.newPage();
  await gotoSafe(seed, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(seed);
  const cleanSrc = (await editorInfo(seed)).value; // default GLSL starter
  const cleanLink = await shareLinkFor(seed, cleanSrc, 'glsl');
  await seed.close();

  const page = await browser.newPage();
  await gotoSafe(page, cleanLink, { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await sleep(900);
  check('(e) clean share link shows no scrim', (await page.$('.admission-scrim')) === null);
  const cleanStatus = await page.$eval('.pill', (el) => el.textContent.trim());
  check('(e) clean share link autoran', cleanStatus !== 'idle', 'status=' + cleanStatus);
  await page.close();
}

/* ---------- 2.5) ED-2: CodeMirror bundle acceptance ---------- */
// Only meaningful with the chunk present — run once with
// site/js/vendor/cm-editor.bundle.js in place (checks (i) below) and once
// with it moved aside (ACCEPT: a fully working textarea editor). This file
// asserts CM behavior only when it detects CM actually mounted, so the same
// run works for both — the FAIL case to watch for is '(i) CodeMirror mounts
// when the vendor chunk exists' going PASS→FAIL after moving the chunk aside
// (that's the expected, not a bug) — see tools/editor-bundle/README.md.
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  const kind = (await editorInfo(page)).kind;
  console.log(`(i) editor kind on this run: ${kind}`);

  if (kind === 'cm') {
    check('(i) builtin-identifier decorator tags the Shadertoy contract',
      (await page.$$eval('.cm-sg-builtin', (nodes) => nodes.map((n) => n.textContent))).includes('iTime'));

    // A compiler error (not an SG-Sxx static finding) at a known line —
    // confirms setDiagnostics() squiggles land on the ED-1 line, not just
    // "somewhere".
    const BAD = `// Shadertoy-style GLSL — edit me
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 col = sgTestUndeclaredIdentifier(uv);
  fragColor = vec4(col, 1.0);
}
`;
    const badLine = BAD.split('\n').findIndex((l) => l.includes('sgTestUndeclaredIdentifier')) + 1;
    await replaceAllAndType(page, BAD);
    await sleep(900);

    const squiggleLines = await page.evaluate(() =>
      [...document.querySelectorAll('.cm-content > .cm-line')]
        .map((l, i) => (l.querySelector('.cm-lintRange-error') ? i + 1 : null))
        .filter((n) => n !== null));
    check('(i) squiggle lands on the compiler-error line',
      squiggleLines.includes(badLine), 'expected line ' + badLine + ', got ' + JSON.stringify(squiggleLines));
  }
  await page.close();
}

/* ---------- 3) v2 substrate SUB-3: organ-split regression oracle ---------- */
// gallery/viewer now delegate their runtime lifecycle to core/runtime-host.js
// (substrate §6.1, P1/P6) — these pin the three behaviors the extraction
// must not regress (substrate §10 Stage 3 blast radius): hero pause on tab
// hide, thumbs settling exactly once, and the WebGPU->WebGL2 ladder telling
// the truth about which backend actually rendered.

// (f) hero pauses its render loop on visibilitychange, resumes when visible
{
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__raf = 0;
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => { window.__raf++; return native(cb); };
  });
  await gotoSafe(page, BASE + '/index.html#/', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => console.log('NAV', e.message));
  await page.waitForSelector('.hero-canvas', { timeout: 8000 }).catch(() => {});

  await sleep(500);
  // Zero the counter and hide the tab in ONE evaluate. Split across two CDP
  // round-trips there is a live window of a few ms between "counter = 0" and
  // "tab is hidden" in which the still-running hero legitimately schedules a
  // frame, so the count picked up a straggler that was requested while the
  // tab was still VISIBLE (deterministic raf=1 here). Measuring atomically
  // counts only frames requested after the hide, which is what this asserts.
  const beforeHide = await page.evaluate(() => {
    const n = window.__raf;
    window.__raf = 0;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    return n;
  });
  // TWO samples, not one, and the assertion is that the count STOPPED GROWING
  // rather than that it is exactly zero. A rAF callback already scheduled when
  // the hide fired still runs and still increments — resetting the counter
  // atomically with the hide (above) excludes frames counted BEFORE the reset,
  // but cannot un-queue one already handed to the browser. The comment above
  // claimed otherwise; on a runner that straggler is reliably 1-2 (measured
  // raf=2), so `=== 0` fails there for a reason that is not a product defect.
  //
  // "Stopped growing across a full further window" is the honest form of the
  // claim, and it is strictly stronger than `=== 0` in one respect: a loop that
  // kept running slowly would satisfy a single lenient count but cannot hold
  // steady across two samples.
  await sleep(500);
  const hiddenDrain = await page.evaluate(() => window.__raf);
  await sleep(500);
  const hiddenSettled = await page.evaluate(() => window.__raf);
  check('(f) hero has a running rAF loop while visible', beforeHide > 5, 'raf=' + beforeHide);
  check('(f) hero stops requesting frames once the tab hides',
    hiddenSettled === hiddenDrain, `raf=${hiddenDrain}->${hiddenSettled} (in-flight stragglers allowed, new frames are not)`);

  await page.evaluate(() => { window.__raf = 0; });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // A fixed window, restored deliberately. An earlier revision replaced this
  // with a poll-until-6-frames-or-15s and claimed the bar was unchanged. It was
  // not: ">5 frames in 500ms" is a RATE, and ">=6 frames within 15s" passes for
  // a loop limping at one frame every two seconds. That is a weakened
  // assertion wearing the costume of a widened budget, which is exactly the
  // substitution the wait-vs-assertion rule is supposed to forbid.
  //
  // sleep() is scaled by SG_TIME_SCALE, so the rate survives the move to a slow
  // machine instead of being deleted: at scale 6 this is ">5 frames in 3000ms",
  // the same frames-per-unit-of-machine-time being asserted here.
  await sleep(500);
  const afterShow = await page.evaluate(() => window.__raf);
  check('(f) hero resumes once the tab is visible again', afterShow > 5, 'raf=' + afterShow);
  await page.close();
}

// (g) gallery thumbnails settle to thumb-ready exactly once per card, no re-render on scroll
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/index.html#/', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => console.log('NAV', e.message));
  await page.waitForSelector('.card', { timeout: 8000 });
  // IntersectionObserver (rootMargin 300px) only queues cards near the
  // viewport — a single top->bottom jump can skip whole rows that sit more
  // than one viewport+300px from BOTH endpoints once the grid grows past a
  // few rows (COMP-3 added a second composition card, which was enough to
  // push mid-grid rows into that dead zone on a plain two-position scroll).
  // Walk several intermediate stops so every row passes near the viewport
  // at some point, pausing at each for thumbs.js's one-per-rAF-frame pump
  // (see thumbs.js's own header) to drain what that stop just queued.
  const stops = await page.evaluate(() => {
    const max = document.body.scrollHeight;
    const step = Math.max(1, Math.floor(window.innerHeight * 0.6));
    const ys = [];
    for (let y = 0; y < max; y += step) ys.push(y);
    ys.push(max);
    return ys;
  });
  for (const y of stops) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await sleep(350);
  }
  await sleep(2000); // drain whatever the last stops queued
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const first = await page.$$eval('.card img', (imgs) => imgs.map((i) => i.src));
  check('(g) every card thumbnail settled (ready or fallback)',
    first.length > 0 && first.every((s) => s && s !== ''), 'count=' + first.length);
  // A second settle pass (scroll jiggle) must not change any already-cached src —
  // thumbs.js's module-scope cache Map is the substrate §6.1 "keep it" decision.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const second = await page.$$eval('.card img', (imgs) => imgs.map((i) => i.src));
  check('(g) thumbnail cache is stable across a re-scroll (rendered once)',
    JSON.stringify(first) === JSON.stringify(second));
  await page.close();
}

// (h) viewer WebGPU->WebGL2 ladder: this check is about the FALLBACK PATH
// itself (core/runtime-host.js's tryWebgpu -> tryWebgl2 ladder), not about
// rendering fidelity — so per the migration brief's decision rule it stays
// pinned to WebGL2. Under puppeteer headless-shell, navigator.gpu simply
// didn't exist and the ladder fell through for free; under real-GPU
// Playwright it does exist, so the same "no WebGPU available" precondition
// is reproduced deliberately by stubbing navigator.gpu away on this page
// only (GPURuntime.create() in runtime/webgpu.js already treats a missing
// navigator.gpu as "no adapter" and returns null, same as it always has).
{
  const page = await browser.newPage();
  // Pinned WebGL2, so prove it's the real renderer, not a silent SwiftShader
  // downgrade (assertRealGpu only inspects the WebGPU adapter — no
  // protection for a suite that never touches it).
  await assertRealWebgl2(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, BASE + '/index.html#/s/biome-rolling-hills', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(1500);

  const badge = await page.$eval('.badge-backend', (el) => el.textContent.trim()).catch(() => null);
  check('(h) headless lands on WebGL2 despite biome-rolling-hills having a WGSL port',
    badge === 'WebGL2', 'badge=' + badge);
  const ctxType = await page.evaluate(() => {
    const c = document.querySelector('.viewer-canvas');
    if (!c) return null;
    if (c.getContext('webgl2', { failIfMajorPerformanceCaveat: false })) return 'webgl2-capable';
    return 'other';
  });
  check('(h) exactly one viewer canvas, WebGL2-capable', ctxType === 'webgl2-capable', 'ctx=' + ctxType);
  check('(h) no page errors on the WebGPU->WebGL2 fallback path', errors.length === 0, errors.join(' | '));

  // Reset time re-runs the full ladder (runtimeHost.rebuild()) — badge must
  // still tell the truth afterward, and no duplicate canvas should leak in.
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button.btn-small')]
      .find((b) => b.textContent.trim() === 'Reset time');
    if (!btn) return false;
    btn.click();
    return true;
  });
  check('(h) found and clicked the Reset time button', clicked);
  await sleep(1200);
  const badgeAfterReset = await page.$eval('.badge-backend', (el) => el.textContent.trim()).catch(() => null);
  const canvasCountAfterReset = await page.$$eval('.viewer-canvas', (els) => els.length);
  check('(h) badge still tells the truth after Reset time', badgeAfterReset === 'WebGL2', 'badge=' + badgeAfterReset);
  check('(h) Reset time leaves exactly one canvas (fresh-canvas-per-rebuild rule)',
    canvasCountAfterReset === 1, 'count=' + canvasCountAfterReset);
  await page.close();
}

/* ---------- 4) ED-3 + PERF-0: transport + adaptive quality ---------- */

async function clickTransportButton(page, label) {
  return page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.transport-row button')].find((b) => b.textContent.trim() === l);
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
}

// (i) pause -> step advances exactly one frame (iFrame proxy: row.dataset.frame)
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transport-row', { timeout: 8000 });
  await sleep(500);
  check('(i) Pause clicked', await clickTransportButton(page, 'Pause'));
  await sleep(300);
  const before = await page.$eval('.transport-row', (el) => Number(el.dataset.frame));
  check('(i) Step clicked', await clickTransportButton(page, 'Step'));
  await sleep(150);
  const after = await page.$eval('.transport-row', (el) => Number(el.dataset.frame));
  check('(i) pause->step advances exactly one frame', after - before === 1, `before=${before} after=${after}`);
  await page.close();
}

// (j) &t=30&paused=1 restores state on load
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/#/edit?t=30&paused=1', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transport-row', { timeout: 8000 });
  await sleep(700);
  const timeText = await page.$eval('.transport-time', (el) => el.textContent);
  check('(j) &t=30 restores clock time', timeText.startsWith('30.'), 'time=' + timeText);
  const label = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.transport-row button')].find((b) => b.textContent === 'Play' || b.textContent === 'Pause');
    return btn ? btn.textContent : null;
  });
  check('(j) &paused=1 leaves the transport paused (button reads Play)', label === 'Play', 'label=' + label);
  await page.close();
}

// (k) setRenderScale(0.5) halves canvas.width vs CSS size, and the badge tells the truth
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transport-scale', { timeout: 8000 });
  await sleep(500);
  await page.select('.transport-scale', '0.5');
  await sleep(1300); // let a ~1 Hz onPerf sample land so the badge picks up the new scale
  const dims = await page.evaluate(() => {
    const c = document.querySelector('.editor-canvas');
    return { w: c.width, cw: c.clientWidth };
  });
  check('(k) setRenderScale(0.5) halves canvas.width vs CSS size',
    Math.abs(dims.w - Math.round(dims.cw * 0.5)) <= 1, JSON.stringify(dims));
  const badgeText = await page.$eval('.badge-fps', (el) => el.textContent);
  check('(k) badge text matches the actual scale (0.5x)', badgeText.includes('0.5x'), 'badge=' + badgeText);
  await page.close();
}

/* ---------- 5) GARDEN-0: the probe-able showcase organ ---------- */
// Camera composition is stable under the orbit's auto-drift (the look
// target is a 60%-weighted blend toward the character — scene.glsl's
// `mix(groundOrigin, charCenter, 0.6)` — not a hard lock, but close enough
// to keep the framing fixed), so fixed screen points are a stable oracle: the
// character sits center-frame, the ground fills the lower half, the sky the
// upper. Three different click points must decode to three different
// components — this is also the regression oracle for parse.js's file-order
// <-> shader COMP_* id mapping staying in sync (scene.glsl's own header
// warns this isn't otherwise enforced).
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(2500);

  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length).catch(() => -1);
  check('(l) #/garden renders with >0 canvases and no console errors', canvases > 0 && errors.length === 0,
    'canvases=' + canvases + (errors.length ? ' errs=' + errors.join(' | ') : ''));

  // This was written back when the garden scene shipped GLSL only, so
  // prefer:'auto' always fell straight through to WebGL2 (see the stale
  // comment near this organ's runtimeHost() call). The scene now also ships
  // a scene.wgsl, so on a real GPU prefer:'auto' legitimately mounts WebGPU
  // — garden only forces a rebuild to WebGL2 when live-editing starts (see
  // organs/garden/index.js's `if (rh.backend === 'webgpu') await
  // rh.rebuild({ prefer: 'webgl2' })`). The invariant this check actually
  // guards — the badge honestly names whichever real backend rendered — is
  // preserved by accepting either; hard-pinning to WebGL2 here would just
  // reassert a premise the product no longer holds.
  const backendBadge = await page.$eval('.badge-backend', (el) => el.textContent.trim()).catch(() => null);
  check('(w) #/garden shows an honest backend badge (WebGL2 or WebGPU)',
    backendBadge === 'WebGL2' || backendBadge === 'WebGPU', 'badge=' + backendBadge);

  // The probe is an ASYNC GPU readback (webgpu.js has no synchronous
  // readPixels), so a fixed settle sleep here is a race that only looked
  // stable because a large SG_TIME_SCALE hid it: at scale 6 the 300ms became
  // 1800ms and passed; at 2x it became 600ms and this check started reading
  // the PREVIOUS panel ("got Meadow Sway"). Wait for the organ's own
  // `garden.probe.opened.v1` instead — the readback completing is exactly
  // what emits it — so the wait is as long as this machine needs, no longer.
  //
  // The counter is installed ONCE and polled as a plain sync property read.
  // Doing the `import('./js/core/bus.js')` inside the poll instead starves
  // the page badly enough that the panel never opens at all (every probe
  // came back null) — the measurement has to stay cheaper than the thing
  // it measures.
  await page.evaluate(async () => {
    const { on } = await import('./js/core/bus.js');
    window.__probeN = 0;
    on('garden.probe.opened.v1', () => { window.__probeN++; });
  });
  async function probe(x, y) {
    const before = await page.evaluate(() => window.__probeN);
    await page.mouse.click(x, y);
    await page.waitForFunction((n) => window.__probeN > n, before, { timeout: 10000 })
      .catch(() => { /* fall through: the read below reports whatever is actually there */ });
    return page.$eval('.probe-title', (el) => el.textContent).catch(() => null);
  }

  const terrainTitle = await probe(720, 830);
  const characterTitle = await probe(720, 380);
  const skyTitle = await probe(720, 60);
  check('(l) three different probe targets -> three different panels',
    new Set([terrainTitle, characterTitle, skyTitle]).size === 3 && [terrainTitle, characterTitle, skyTitle].every(Boolean),
    JSON.stringify({ terrainTitle, characterTitle, skyTitle }));
  // The ground at (720,830) is shared by TWO components, not one: the
  // heightfield and the grass that animates on top of it. Measured with
  // tools/test/manual/probe-phase.mjs, sampling that pixel at eight
  // different moments returned 'Rolling Hills (evolved)' seven times and
  // 'Meadow Sway' once — so pinning the oracle to a single name asserted a
  // fact about ANIMATION PHASE, not about the probe. It passed only because
  // a large settle sleep happened to land on a favourable phase; CI would
  // have hit the other one at random.
  //
  // Deliberately still strict about what it rejects: a ground probe that
  // returns the sky, the character, some unrelated component, or null is
  // still a failure. Only the terrain/grass ambiguity — which is real, and
  // which the product is entitled to — is accepted.
  const GROUND_COMPONENTS = ['Rolling Hills (evolved)', 'Meadow Sway'];
  check('(l) terrain probe names a ground component',
    GROUND_COMPONENTS.includes(terrainTitle),
    'got ' + terrainTitle + ' (expected one of: ' + GROUND_COMPONENTS.join(', ') + ')');
  check('(l) character probe names the character component', characterTitle === 'Bouncing Figure', 'got ' + characterTitle);
  check('(l) sky probe names the sky component', skyTitle === 'Sky & Atmosphere', 'got ' + skyTitle);

  // Re-probe the character specifically — sky (probed last above, to prove
  // the three-way distinction) has no @tune sliders, so the remaining
  // checks below need the character's panel open.
  await probe(720, 380);

  // source chunk matches the @component span exactly — parse.js is the
  // oracle here, not a hand-copied string, so this pins the extraction
  // itself rather than just today's scene.glsl text.
  const expectedSource = await page.evaluate(async () => {
    const { parseScene } = await import('./js/organs/garden/parse.js');
    const src = await fetch('assets/garden/scene.glsl').then((r) => r.text());
    return parseScene(src).components.find((c) => c.name === 'Bouncing Figure').source;
  });
  const shownSource = await page.$eval('.probe-source', (el) => el.textContent.trim());
  check('(l) probe panel source chunk matches the @component/@end span',
    shownSource === expectedSource.replace(/^\n+|\n+$/g, ''), 'lengths ' + shownSource.length + ' vs ' + expectedSource.length);

  // a @tune slider updates the underlying uniform (not just its own label) —
  // proven by moving one and asking the runtime, not just reading the DOM
  // back to itself.
  const tuneCheck = await page.evaluate(() => {
    const range = document.querySelector('.probe-tune-range');
    if (!range) return null;
    const name = range.dataset.name;
    const before = Number(range.value);
    range.value = String(Number(range.max));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    return { name, before, after: Number(range.max) };
  });
  await sleep(150);
  const valueLabel = await page.$eval('.probe-tune-value', (el) => el.textContent);
  check('(l) moving a @tune slider updates its live value readout',
    !!tuneCheck && valueLabel === tuneCheck.after.toFixed(2), JSON.stringify({ tuneCheck, valueLabel }));
  const errorsAfterTune = errors.length;
  check('(l) no console errors after a live @tune update', errorsAfterTune === 0, errors.join(' | '));

  // "open in editor" -> #/edit with the source loaded and &line= pointing
  // at the probed component's exact start line (independently recomputed
  // by parse.js, not hand-copied).
  const expectedLine = await page.evaluate(async () => {
    const { parseScene } = await import('./js/organs/garden/parse.js');
    const src = await fetch('assets/garden/scene.glsl').then((r) => r.text());
    return parseScene(src).components.find((c) => c.name === 'Bouncing Figure').startLine;
  });
  const editHref = await page.$eval('.probe-edit-link', (el) => el.getAttribute('href'));
  const hrefLine = Number(new URLSearchParams(editHref.split('?')[1]).get('line'));
  check('(l) "open in editor" link carries &line= for the probed component',
    hrefLine === expectedLine, 'href line=' + hrefLine + ' expected=' + expectedLine);

  // The share payload itself is the oracle, not the DOM: scene.glsl is
  // hundreds of lines and CM6 virtualizes offscreen lines, so a naive
  // .cm-line scrape (editorInfo()'s trick, fine for the repo's short demo
  // shaders) would only see whatever happened to be in the viewport.
  const decodedPayload = await page.evaluate(async (b64) => {
    const { decompress } = await import('./js/share.js');
    return decompress(b64);
  }, editHref.match(/src=([^&]+)/)[1]);
  check('(l) the full scene source is what "open in editor" carried',
    decodedPayload.includes('sg_character_sdf'), 'len=' + decodedPayload.length);

  await page.click('.probe-edit-link');
  // waitForEditor, not a second hand-rolled 8000ms copy of it — that duplicate
  // was the same workstation-tuned budget the top of this file already fixed,
  // and it would have failed here for the identical reason (measured mount:
  // 18269ms on a runner).
  await waitForEditor(page);
  await sleep(700);
  check('(l) "open in editor" navigated to #/edit', (await page.evaluate(() => location.hash)).startsWith('#/edit'));
  const loadedInfo = await editorInfo(page);
  check('(l) the editor mounted with no decode error', loadedInfo.value != null, 'kind=' + loadedInfo.kind);
  if (loadedInfo.kind === 'textarea') {
    check('(l) textarea fallback: full source present', loadedInfo.value.includes('sg_character_sdf'));
    const caretLine = await page.$eval('.code-editor', (ta) => ta.value.slice(0, ta.selectionStart).split('\n').length);
    check('(l) textarea fallback: caret lands on the expected line', caretLine === expectedLine, 'caret=' + caretLine);
  }
  await page.close();
}

// (w) scene richness (GARDEN-1): the file-order <-> COMP_* id invariant
// scene.glsl's own header warns nothing enforces at build time — this is
// that enforcement, run node-side (no browser) straight against the source.
{
  const { parseScene } = await import('../../site/js/organs/garden/parse.js');
  const sceneSrc = readFileSync(path.join(SITE_ROOT, 'assets/garden/scene.glsl'), 'utf8');
  const { components } = parseScene(sceneSrc);

  check('(w) scene yields at least 8 probe-able components', components.length >= 8, 'count=' + components.length);
  check('(w) every component has a non-empty name/blurb/source',
    components.every((c) => c.name && c.blurb && c.source.trim().length > 0),
    JSON.stringify(components.map((c) => c.id)));

  const compConstRe = /const float (COMP_\w+)\s*=\s*([\d.]+);/g;
  const compConsts = [];
  let m;
  while ((m = compConstRe.exec(sceneSrc))) compConsts.push({ name: m[1], value: Number(m[2]) });

  check('(w) COMP_* constant count matches component count', compConsts.length === components.length,
    'consts=' + compConsts.length + ' components=' + components.length);

  // Each component's slug (e.g. "pond") must have a matching COMP_<SLUG>
  // constant whose value is its 1-based file-order position — the exact
  // invariant the probe readback depends on (id -> array index).
  const order = components.map((c, i) => {
    const wantName = 'COMP_' + c.id.toUpperCase();
    const found = compConsts.find((cc) => cc.name === wantName);
    return { slug: c.id, wantName, value: found ? found.value : null, expected: i + 1 };
  });
  check('(w) COMP_* values match file order (component i -> id i+1)',
    order.every((o) => o.value === o.expected), JSON.stringify(order));
}

/* ---------- 6) ED-4: uniforms inspector + record + Run it + shader.compiled.v1 ---------- */

// (m) usage-scan shows only referenced uniforms, and updates as the source
// changes; the freeze toggle actually stops iMouse tracking (not just a
// label flip) — proven by moving the mouse before/after the toggle and
// reading the panel's own live value back, not the runtime's internals.
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await page.waitForSelector('.uniforms-panel', { timeout: 8000 });
  await sleep(400);

  const namesAt = () => page.$$eval('.uniforms-name', (nodes) => nodes.map((n) => n.textContent));
  const initialNames = await namesAt();
  check('(m) default starter (iTime/iResolution) scans in', initialNames.includes('iTime') && initialNames.includes('iResolution'), JSON.stringify(initialNames));
  check('(m) unused uniforms are not shown', !initialNames.includes('iMouse'), JSON.stringify(initialNames));

  const WITH_MOUSE = `// Shadertoy-style GLSL — edit me
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
  if (iMouse.z > 0.0) col = vec3(1.0);
  fragColor = vec4(col, 1.0);
}
`;
  await replaceAllAndType(page, WITH_MOUSE);
  await sleep(900); // debounced compile -> pipeline's onCompiled -> uniformsPanel.rescan()
  const namesAfter = await namesAt();
  check('(m) iMouse appears once the source references it', namesAfter.includes('iMouse'), JSON.stringify(namesAfter));

  const box = await page.$('.editor-canvas');
  const bb = await box.boundingBox();
  const cx = bb.x + bb.width * 0.3, cy = bb.y + bb.height * 0.3;
  const cx2 = bb.x + bb.width * 0.7, cy2 = bb.y + bb.height * 0.7;

  const mouseRowValue = () => page.evaluate(() => {
    const row = [...document.querySelectorAll('.uniforms-row-item')].find((r) => r.querySelector('.uniforms-name').textContent === 'iMouse');
    return row ? row.querySelector('.uniforms-value').textContent : null;
  });

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy); // press registers m[0..3]
  await page.mouse.up(); // release before .click() below (puppeteer's click does its own down/up);
  await sleep(150);       // attachMouse's onUp flips z/w sign — read the settled value, not mid-press
  const beforeFreeze = await mouseRowValue();

  const freezeBtn = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.uniforms-head button')].find((b) => b.textContent.includes('Freeze')));
  await freezeBtn.asElement().click();
  await sleep(150);
  const labelAfterClick = await page.$eval('.uniforms-head button', (b) => b.textContent);
  check('(m) freeze button flips to Unfreeze', labelAfterClick === 'Unfreeze iMouse', labelAfterClick);

  await page.mouse.move(cx2, cy2);
  await page.mouse.down();
  await page.mouse.move(cx2, cy2);
  await sleep(150);
  const whileFrozen = await mouseRowValue();
  await page.mouse.up();
  check('(m) iMouse value holds while frozen', whileFrozen === beforeFreeze, `before=${beforeFreeze} while=${whileFrozen}`);

  const unfreezeBtn = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.uniforms-head button')].find((b) => b.textContent.includes('Unfreeze')));
  await unfreezeBtn.asElement().click();
  await page.mouse.move(cx2, cy2);
  await page.mouse.down();
  await page.mouse.move(cx2 + 5, cy2 + 5);
  await sleep(150);
  const afterUnfreeze = await mouseRowValue();
  await page.mouse.up();
  check('(m) iMouse value tracks again once unfrozen', afterUnfreeze !== whileFrozen, `while=${whileFrozen} after=${afterUnfreeze}`);
  await page.close();
}

// (n) record: real headless captureStream+MediaRecorder path produces a
// non-empty .webm blob (verified empirically — chrome-headless-shell under
// SwiftShader DOES support this, unlike navigator.gpu). Downloads are
// intercepted at the createObjectURL boundary since headless has no
// download directory to inspect.
{
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__capturedBlobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__capturedBlobs.push(blob); return orig(blob); };
  });
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await page.waitForSelector('.transport-row', { timeout: 8000 });
  await sleep(500);

  const findRecordBtn = () => page.evaluateHandle(() =>
    [...document.querySelectorAll('.transport-row button')].find((b) => b.textContent.startsWith('Record')));
  const recBtn = await findRecordBtn();
  check('(n) Record button present and enabled', !!recBtn.asElement() && !(await (await recBtn.getProperty('disabled')).jsonValue()));
  await recBtn.asElement().click();
  await sleep(1300);
  const stopBtn = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.transport-row button')].find((b) => b.textContent.startsWith('Stop')));
  check('(n) button reads Stop(Ns) while recording', !!stopBtn.asElement());
  await stopBtn.asElement().click(); // manual early stop — the 10s cap is the OTHER path, not exercised here for speed
  await sleep(500);

  const blobInfo = await page.evaluate(() => window.__capturedBlobs.map((b) => ({ size: b.size, type: b.type })));
  check('(n) recording produced exactly one captured blob', blobInfo.length === 1, JSON.stringify(blobInfo));
  check('(n) the blob is non-empty', blobInfo[0] && blobInfo[0].size > 0, JSON.stringify(blobInfo));
  check('(n) the blob is a webm', blobInfo[0] && blobInfo[0].type.startsWith('video/webm'), JSON.stringify(blobInfo));
  const labelAfter = await page.evaluate(() =>
    [...document.querySelectorAll('.transport-row button')].find((b) => b.textContent.startsWith('Record') || b.textContent.startsWith('Stop'))?.textContent);
  check('(n) button reverts to Record after stopping', labelAfter === 'Record', labelAfter);
  await page.close();
}

// (o) record: feature-detect degrade — an engine with no MediaRecorder gets
// a disabled button with an explanatory title, never a silent/broken control.
{
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { delete window.MediaRecorder; });
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await page.waitForSelector('.transport-row', { timeout: 8000 });
  const info = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.transport-row button')].find((b) => b.textContent.startsWith('Record'));
    return btn ? { disabled: btn.disabled, title: btn.title } : null;
  });
  check('(o) Record degrades to a disabled button when MediaRecorder is absent', !!info && info.disabled === true, JSON.stringify(info));
  check('(o) the disabled button explains why', !!info && info.title.length > 0, JSON.stringify(info));
  await page.close();
}

// (p) "Run it" scrim consent: report.js's onRun affordance (ADM-C) only
// ever renders for a safe-but-withheld verdict — under the live admission
// policy (share-link autorunOn === the safe verdict set), that state can't
// occur through a real share link, so this test stubs
// organs/admission/index.js over the wire to force it, proving
// admission-gate.js's onRun forwarding and index.js's runAnyway() actually
// work end-to-end (not just that report.js's button renders in isolation).
{
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().endsWith('/js/organs/admission/index.js')) {
      req.respond({
        contentType: 'text/javascript',
        // COMP-2's admission-gate.js also imports admitComposition from this
        // module — the stub must keep exporting it (even unused here) or the
        // whole /edit page fails to link and waitForEditor() times out.
        body: `export function policyFor() { return { staticTier: true, sacrificial: true, autorunOn: [] }; }
export async function admit(source, opts) {
  return { shader_id: 'test-run-it', language: opts.language, kind: 'fragment', safe: true, verdict: 'OK',
    crash_risk: 'none', static_findings: [], stages: { static_ms: 0.1 } };
}
export async function admitComposition(passes, opts) {
  return { shader_id: 'test-run-it-comp', language: 'glsl', kind: 'composition', safe: true, verdict: 'OK',
    crash_risk: 'none', static_findings: [], stages: { static_ms: 0.1 }, passes: passes.map((p) => p.id) };
}`,
      });
    } else req.continue();
  });

  const seed = await browser.newPage();
  await gotoSafe(seed, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(seed);
  const cleanSrc = (await editorInfo(seed)).value;
  const link = await shareLinkFor(seed, cleanSrc, 'glsl');
  await seed.close();

  await gotoSafe(page, link, { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await sleep(700);

  const runBtn = await page.$('.admission-scrim button.btn-primary');
  check('(p) a safe-but-withheld verdict shows a "Run it" button', !!runBtn);
  const runLabel = runBtn ? await page.evaluate((el) => el.textContent, runBtn) : null;
  check('(p) it reads "Run it"', runLabel === 'Run it', runLabel);

  const statusBefore = await page.$eval('.pill', (el) => el.textContent.trim());
  check('(p) autorun withheld before consent — status still idle', statusBefore === 'idle', 'status=' + statusBefore);

  await runBtn.click();
  await sleep(700);
  check('(p) scrim clears after Run it', (await page.$('.admission-scrim')) === null);
  const statusAfter = await page.$eval('.pill', (el) => el.textContent.trim());
  check('(p) compile attempted after Run it — not stuck idle', statusAfter !== 'idle', 'status=' + statusAfter);
  await page.close();
}

// (q) shader.compiled.v1 — the editor's own compile-fact emission (substrate
// §4.5's event table names "editor, viewer" as co-emitters; the viewer side
// already had it, this pins the editor side ED-4 adds).
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await sleep(900); // boot compile
  const envelopes = await page.evaluate(async () => {
    const { recent } = await import('./js/core/bus.js');
    return recent().filter((e) => e.type === 'shader.compiled.v1');
  });
  check('(q) shader.compiled.v1 emitted on boot compile', envelopes.length >= 1, JSON.stringify(envelopes.slice(-1)));
  const last = envelopes[envelopes.length - 1];
  check('(q) source is /garden/editor', last && last.source === '/garden/editor', last && last.source);
  check('(q) language is glsl (default starter)', last && last.data.language === 'glsl', last && JSON.stringify(last.data));
  check('(q) ok=true for the clean default starter', last && last.data.ok === true, last && JSON.stringify(last.data));
  await page.close();
}

/* ---------- 7) ADM-D: suggestion integration + Check shader + operator export ---------- */
// GLSL sacrificial runs for real under headless SwiftShader (see the
// "Headless-test reality" note in ARCHITECTURE.md's Admission section) — the
// default editor starter is GLSL, so "Check shader" here exercises the FULL
// pipeline (static + real sacrificial compile/render/readback), not a stub.

async function clickButtonByText(page, text) {
  return page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === t);
    if (!b) return false;
    b.click();
    return true;
  }, text);
}

async function buttonState(page, text) {
  return page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === t);
    return b ? { found: true, disabled: !!b.disabled } : { found: false, disabled: null };
  }, text);
}

// (r) Suggest starts disabled; "Check shader" on the clean default starter
// produces a safe verdict and enables it; the user's own next edit
// re-disables it (a stale verdict must not authorize a suggestion).
{
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__openedUrls = [];
    window.open = (url) => { window.__openedUrls.push(url); return null; };
  });
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);

  const suggestBefore = await buttonState(page, 'Suggest for gallery');
  check('(r) Suggest disabled before any check', suggestBefore.found && suggestBefore.disabled === true, JSON.stringify(suggestBefore));

  const checkClicked = await clickButtonByText(page, 'Check shader');
  check('(r) "Check shader" button found and clicked', checkClicked === true);
  await sleep(3000); // real sacrificial compile+3 frames under SwiftShader

  const reportShown = await page.$eval('.check-report-host', (el) => !el.hidden).catch(() => false);
  check('(r) full report rendered inline (never a scrim)', reportShown === true);
  const badgeText = await page.$eval('.check-report-host .badge', (el) => el.textContent).catch(() => null);
  check('(r) clean starter verdict is safe (OK or WA)', badgeText === 'OK' || badgeText === 'WA', 'verdict=' + badgeText);

  const suggestAfterCheck = await buttonState(page, 'Suggest for gallery');
  check('(r) Suggest enabled after a safe check', suggestAfterCheck.disabled === false, JSON.stringify(suggestAfterCheck));

  // Capture the real envelope for the python jsonschema check below, from
  // the actual bus emission (not a hand-typed fixture).
  const envelope = await page.evaluate(async () => {
    const { recent } = await import('./js/core/bus.js');
    const evs = recent().filter((e) => e.type === 'garden.admission.evaluated.v1');
    return evs[evs.length - 1] || null;
  });
  check('(r) garden.admission.evaluated.v1 emitted by the check', !!envelope, JSON.stringify(envelope));
  check('(r) captured envelope is glsl', !!envelope && envelope.data.language === 'glsl', envelope && envelope.data.language);

  const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'out');
  mkdirSync(outDir, { recursive: true });
  const fixturePath = path.join(outDir, 'admission-verdict-glsl.json');
  writeFileSync(fixturePath, JSON.stringify(envelope, null, 2));

  // Suggest, now enabled, opens a GitHub issue URL with a fenced verdict
  // block (minus preview_png) in the body.
  await clickButtonByText(page, 'Suggest for gallery');
  await sleep(200);
  const openedUrls = await page.evaluate(() => window.__openedUrls);
  check('(r) Suggest opened exactly one URL', openedUrls.length === 1, JSON.stringify(openedUrls));
  const issueUrl = openedUrls[0] || '';
  const bodyMatch = /[?&]body=([^&]*)/.exec(issueUrl);
  const body = bodyMatch ? decodeURIComponent(bodyMatch[1].replace(/\+/g, '%20')) : '';
  const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(body);
  check('(r) issue body contains a fenced json block', !!fenceMatch, body.slice(0, 200));
  let suggestedEnvelope = null;
  try { suggestedEnvelope = fenceMatch && JSON.parse(fenceMatch[1]); } catch { /* checked below */ }
  check('(r) fenced block parses as JSON', !!suggestedEnvelope, fenceMatch && fenceMatch[1].slice(0, 200));
  check('(r) fenced envelope is garden.admission.evaluated.v1',
    !!suggestedEnvelope && suggestedEnvelope.type === 'garden.admission.evaluated.v1', JSON.stringify(suggestedEnvelope));
  check('(r) fenced envelope carries a safe verdict', !!suggestedEnvelope && suggestedEnvelope.data.safe === true, JSON.stringify(suggestedEnvelope));
  check('(r) fenced envelope omits preview_png', !!suggestedEnvelope && !('preview_png' in suggestedEnvelope.data), JSON.stringify(suggestedEnvelope && Object.keys(suggestedEnvelope.data)));

  // The user's next edit invalidates the stale verdict — Suggest re-locks.
  await focusEditor(page);
  await page.keyboard.type(' ');
  await sleep(200);
  const suggestAfterEdit = await buttonState(page, 'Suggest for gallery');
  check('(r) Suggest re-disabled after the next edit (stale verdict)', suggestAfterEdit.disabled === true, JSON.stringify(suggestAfterEdit));
  await page.close();
}

// (s) "Check shader" never blocks typing: a hostile SG-S02 source can still
// be typed freely, and an on-demand check on it reports VF/unsafe without
// ever touching the GPU (rejected pre-sacrificial) — Suggest stays disabled.
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  await replaceAllAndType(page, FORBIDDEN);
  await sleep(600);
  check('(s) typing the hostile source was never blocked (no scrim)', (await page.$('.admission-scrim')) === null);

  await clickButtonByText(page, 'Check shader');
  await sleep(600); // VF is a pre-GPU static reject — fast
  const badgeText = await page.$eval('.check-report-host .badge', (el) => el.textContent).catch(() => null);
  check('(s) "Check shader" on hostile source reports VF', badgeText === 'VF', 'verdict=' + badgeText);
  const suggestState = await buttonState(page, 'Suggest for gallery');
  check('(s) Suggest stays disabled on an unsafe verdict', suggestState.disabled === true, JSON.stringify(suggestState));
  await page.close();
}

// (t) python3 jsonschema: the real captured glsl envelope from (r), after
// stripping browser-only keys, validates against nervous-bus's
// shader.preadmit.evaluated.v1 (READ ONLY — never written to).
{
  const fixturePath = path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), 'out'), 'admission-verdict-glsl.json');
  const checker = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'check_preadmit_v1_compat.py');
  // The checker prints "SKIP:" (exit 0) when no nervous-bus checkout exists
  // (a public clone of this repo alone) — the real validation and its
  // negative control only bite where the ecosystem is present.
  let schemaPresent = false;
  try {
    const out = execFileSync('python3', [checker, fixturePath], { encoding: 'utf8' });
    schemaPresent = out.startsWith('OK:');
    check('(t) captured glsl envelope validates against shader.preadmit.evaluated.v1', schemaPresent || out.startsWith('SKIP:'), out.trim());
  } catch (e) {
    check('(t) captured glsl envelope validates against shader.preadmit.evaluated.v1', false, String(e.stderr || e.message));
  }
  // Negative control: the checker must actually be able to fail (proves this
  // is a real jsonschema validation, not a script that always prints OK) —
  // additionalProperties:false on `data` must reject a browser-only key that
  // was NOT stripped.
  if (schemaPresent) {
    const badPath = path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), 'out'), 'admission-verdict-glsl-bad.json');
    const goodEnvelope = JSON.parse(readFileSync(fixturePath, 'utf8'));
    writeFileSync(badPath, JSON.stringify({ ...goodEnvelope, data: { ...goodEnvelope.data, unexpected_browser_key: true } }, null, 2));
    let negativeFailedAsExpected = false;
    try {
      execFileSync('python3', [checker, badPath], { encoding: 'utf8' });
    } catch {
      negativeFailedAsExpected = true;
    }
    check('(t) negative control: an un-stripped extra key correctly fails schema validation', negativeFailedAsExpected);
  }
}

// (u) operator-mode ring-buffer export: `?operator=1` shows the Anatomy
// "Export admission ring" control; without the flag the control doesn't
// exist at all. Downloads are intercepted via URL.createObjectURL (no CDP
// download plumbing needed) so the test reads the exact JSON that would be
// written to disk.
{
  const page = await browser.newPage();
  await gotoSafe(page, BASE + '/index.html?operator=1#/edit', { waitUntil: 'networkidle0' });
  await waitForEditor(page);
  // Generate at least one ring entry in THIS page's admission module instance.
  await clickButtonByText(page, 'Check shader');
  await sleep(3000);

  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  await page.waitForSelector('.anatomy-overlay', { timeout: 8000 });

  const exportBtn = await page.$('.anatomy-overlay button.btn');
  const exportInfo = await page.evaluate(
    () => [...document.querySelectorAll('.anatomy-overlay button')].map((b) => b.textContent));
  check('(u) operator export control renders under ?operator=1', exportInfo.some((t) => t.includes('Export admission ring')), JSON.stringify(exportInfo));

  await page.evaluate(() => {
    window.__capturedBlobText = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__capturedBlobText = t; }); return orig(blob); };
  });
  const clickedExport = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.anatomy-overlay button')].find((n) => n.textContent.includes('Export admission ring'));
    if (!b) return false;
    b.click();
    return true;
  });
  check('(u) export button clicked', clickedExport === true);
  await sleep(400);
  const blobText = await page.evaluate(() => window.__capturedBlobText);
  let ring = null;
  try { ring = blobText && JSON.parse(blobText); } catch { /* checked below */ }
  check('(u) export produced a JSON array', Array.isArray(ring), blobText && blobText.slice(0, 200));
  check('(u) exported ring contains the check-shader admission', !!ring && ring.some((e) => e.type === 'garden.admission.evaluated.v1'), ring && ring.length);
  await page.close();
}

// (v) without the operator flag, Anatomy shows no export control at all.
{
  const page = await browser.newPage();
  // domcontentloaded + a .card wait, NOT networkidle2: this section only
  // needs boot.js's hotkey listener live (proven by the gallery organ having
  // mounted), and the gallery's hero canvas + thumbs keep network activity
  // going long enough that idle-based waits can time out on slow machines —
  // this exact goto was the first CI-runner casualty (2-core GitHub runner,
  // 20s×2 nav timeout, late in the suite when the browser is heaviest).
  await gotoSafe(page, BASE + '/index.html#/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.card', { timeout: 15000 });
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  await page.waitForSelector('.anatomy-overlay', { timeout: 8000 });
  const hasExport = await page.evaluate(
    () => [...document.querySelectorAll('.anatomy-overlay button')].some((b) => b.textContent.includes('Export admission ring')));
  check('(v) no operator export control without ?operator=1', hasExport === false);
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
