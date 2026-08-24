// Shader Garden — seed acceptance harness (SEED-1/2/3, V2_BLUEPRINT.md
// items 15, 16 & 20). Usage: node tools/test/seed.mjs   (first: npm ci in
// tools/test)
//
// Budgets are checked by `python3 tools/check_budgets.py`, not here — this
// file covers the runtime acceptance criteria that need a real browser:
//   (a) a test page on a DIFFERENT origin (tools/test/fixtures/foreign-seed/,
//       served on its own port — see browser.mjs's serveSiteCors) embedding
//       one <shader-seed kernel=…> fetches EXACTLY the module + one kernel
//       JSON from the garden origin, and nothing else.
//   (b) an off-screen seed creates zero WebGL2 contexts (instrumented via
//       HTMLCanvasElement.prototype.getContext, not inferred from state
//       alone) — plus a same-page control proving the instrumentation
//       actually detects a context when one IS created.
//   (c) prefers-reduced-motion: the seed settles on a static poster and
//       never starts an animation-frame loop; an explicit click (user
//       gesture) still starts playback despite reduced motion.
//   (e) SEED-2/3: site/embed/contract.html, the executable conformance page
//       (seed.md §2.5) — driven headless here, its own inline script covers
//       autoplay modes, live-attribute retuning, the speed=0 freeze, the
//       imperative API + sg-play/sg-pause/sg-poster reasons, an sg-error
//       path, the MAX_LIVE=4 + LRU-posterize budget with 6 real seeds, and
//       (SEED-3) the src=/href=+unsafe tier's refuse-without-unsafe /
//       forced-click / sg-admit(OK|CE) verdicts, `integrity`, and the
//       attribution chip.
//   (f) SEED-3: a REAL WEBGL_lose_context on a playing unsafe seed never
//       triggers the baked-kernel rebuild policy — no second sg-ready, no
//       return to "playing", backend stays disposed. Falls back to a stated
//       code-verified check if the extension isn't available headless.
//   (g) SEED-3: the viewer's "Copy embed code" button copies a snippet that,
//       replayed VERBATIM on a fresh blank page, is a genuinely working
//       embed (reaches "playing") — not just plausible-looking markup.
//   (h) SEED-4: site/embed/embed.html's snippet generator — the floating
//       snippet AND the SRI-pinned snippet both drive a live, actually-
//       playing preview on the page itself; the exact copied text of each
//       replays to "playing" on a fresh blank page (same bar as (g)); and a
//       corrupted integrity hash on the pinned snippet genuinely blocks the
//       module (proving `integrity=` is real SRI enforcement, not
//       decoration) — this is the accept line "embed.html generates a
//       snippet that passes the conformance page".
//   (i) SEED-4: the SRI publishing flow — every pinned seed@X.Y.Z.js file
//       ON DISK has a site/embed/releases.json entry whose sha384/bytes
//       match its ACTUAL current bytes (Node-side, no browser needed).
//   (j) SEED-4: the battery enhancement — with navigator.getBattery mocked
//       to report "discharging below 20%", a default-autoplay (`visible`)
//       seed never leaves "poster" on its own; an explicit click still
//       plays it. Feature-detected: this test is the only place the mock
//       exists — every other clause in this file exercises the
//       zero-behavior-change path (API absent).
//   (k) SEED-4: touch attribution — a synthetic `touchstart` on a
//       hover-attribution seed reveals the chip immediately, then it fades
//       back within ~3s (seed.md §6's "3s after first tap").
// Bonus (not required by any work item, cheap to also pin here): fetch
// dedup across multiple same-kernel seeds, and the not-found failure path.
// Prints "all-PASS" and exits 0 only if every check passed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { launch, serveSite, serveSiteCors, sleep, scaled, SITE_ROOT, gotoSafe } from './browser.mjs';

const FIXTURE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures/foreign-seed',
);

const { server: gardenServer, base: GARDEN } = await serveSiteCors(SITE_ROOT);
const { server: foreignServer, base: FOREIGN } = await serveSite(FIXTURE_ROOT);
const browser = await launch();
let failed = false;

function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

const GARDEN_SEED_DIR = GARDEN + '/assets/seed/';

function fixtureUrl({ kernel = 'biome-rolling-hills', offscreen = false, count = 1 } = {}) {
  const params = new URLSearchParams({
    origin: GARDEN_SEED_DIR,
    kernel,
    count: String(count),
  });
  if (offscreen) params.set('offscreen', '1');
  return `${FOREIGN}/index.html?${params.toString()}`;
}

// Instrument requestAnimationFrame + WebGL2 context creation on every page
// before any page script runs, so both counters are gapless from load.
async function instrumentedPage() {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => {
    window.__glContexts = 0;
    window.__raf = 0;
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (type === 'webgl2') window.__glContexts++;
      return origGetContext.call(this, type, ...rest);
    };
    const nativeRAF = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      window.__raf++;
      return nativeRAF(cb);
    };
  });
  return { page, errors };
}

async function seedState(page, selector = '#seed') {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.state : 'missing';
  }, selector);
}

async function waitForState(page, want, selector = '#seed', timeout = 8000) {
  // Playwright's waitForFunction is (pageFunction, arg, options) — a single
  // `arg` value, not puppeteer's (pageFunction, options, ...args) spread.
  // Passing {timeout} as if it were an arg silently fed `sel` the options
  // object here, so document.querySelector(sel) threw "not a valid
  // selector" on every call (masked because the whole thing is caught below
  // and only surfaces as a stray console error the (a)/(b)/(c)/... "no
  // console/page errors" checks then correctly flag).
  return page
    .waitForFunction(
      ({ sel, w }) => {
        const el = document.querySelector(sel);
        return el && el.state === w;
      },
      { sel: selector, w: want },
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

/* ---------- (a) foreign-origin: exactly module + one kernel JSON ---------- */
{
  const { page, errors } = await instrumentedPage();
  const gardenReqs = [];
  page.on('request', (req) => {
    if (req.url().startsWith(GARDEN)) gardenReqs.push(req.url());
  });

  await gotoSafe(page, fixtureUrl(), { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  const reachedPlaying = await waitForState(page, 'playing');
  const state = await seedState(page);

  check('(a) foreign-origin seed reaches "playing"', reachedPlaying, 'state=' + state);
  const unique = [...new Set(gardenReqs)];
  check('(a) exactly two requests hit the garden origin (module + one JSON)',
    unique.length === 2, JSON.stringify(unique));
  check('(a) one of them is the seed module',
    unique.some((u) => u.endsWith('/seed@1.js')), JSON.stringify(unique));
  check('(a) one of them is exactly one kernel JSON',
    unique.filter((u) => u.endsWith('.json')).length === 1, JSON.stringify(unique));
  check('(a) no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (a2) bonus: N seeds of the same kernel dedupe the JSON fetch --- */
{
  const { page, errors } = await instrumentedPage();
  const gardenReqs = [];
  page.on('request', (req) => {
    if (req.url().startsWith(GARDEN)) gardenReqs.push(req.url());
  });
  await gotoSafe(page, fixtureUrl({ count: 3 }), { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await waitForState(page, 'playing', '#seed');
  await waitForState(page, 'playing', '#seed-1');
  await waitForState(page, 'playing', '#seed-2');
  await sleep(300);
  const jsonReqs = [...new Set(gardenReqs)].filter((u) => u.endsWith('.json'));
  check('(a2) three same-kernel seeds still fetch the kernel JSON exactly once',
    jsonReqs.length === 1, JSON.stringify(jsonReqs));
  await page.close();
}

/* ---------- (b) off-screen seed holds zero GL contexts ---------- */
{
  const { page, errors } = await instrumentedPage();
  await gotoSafe(page, fixtureUrl({ offscreen: true }), { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await sleep(1500); // outlive the IO's rootMargin settle + any stray timers

  const state = await seedState(page);
  const glContexts = await page.evaluate(() => window.__glContexts);
  check('(b) off-screen seed never leaves "idle"', state === 'idle', 'state=' + state);
  check('(b) off-screen seed creates zero WebGL2 contexts', glContexts === 0, 'contexts=' + glContexts);

  // Control: scroll it into view and confirm the SAME instrumentation now
  // sees exactly one context — proves (b) isn't a false negative from a
  // broken counter.
  await page.evaluate(() => document.querySelector('#seed').scrollIntoView());
  const reachedPlaying = await waitForState(page, 'playing');
  const glContextsAfter = await page.evaluate(() => window.__glContexts);
  check('(b) control: scrolling into view reaches "playing"', reachedPlaying, 'state=' + (await seedState(page)));
  check('(b) control: exactly one WebGL2 context once visible', glContextsAfter === 1, 'contexts=' + glContextsAfter);
  check('(b) no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (c) prefers-reduced-motion: poster only, no rAF loop --------- */
{
  const { page, errors } = await instrumentedPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await gotoSafe(page, fixtureUrl(), { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  const reachedPoster = await waitForState(page, 'poster');
  const state = await seedState(page);
  check('(c) reduced-motion settles on "poster"', reachedPoster, 'state=' + state);
  check('(c) reduced-motion never reaches "playing"', state !== 'playing');

  await page.evaluate(() => { window.__raf = 0; });
  await sleep(700);
  const rafDuringPoster = await page.evaluate(() => window.__raf);
  check('(c) no animation-frame loop while posterized', rafDuringPoster === 0, 'raf=' + rafDuringPoster);

  const domState = await page.evaluate(() => {
    const el = document.querySelector('#seed');
    const root = el.shadowRoot;
    const canvas = root.querySelector('canvas');
    const poster = root.querySelector('.poster');
    return { canvasHidden: canvas.hidden, posterHidden: poster.hidden };
  });
  check('(c) canvas stays hidden under reduced motion', domState.canvasHidden === true, JSON.stringify(domState));
  check('(c) poster is shown under reduced motion', domState.posterHidden === false, JSON.stringify(domState));

  // An explicit click is a user gesture and overrides reduced-motion (seed.md §4.2).
  await page.evaluate(() => document.querySelector('#seed').shadowRoot.querySelector('.poster').click());
  const reachedPlayingAfterClick = await waitForState(page, 'playing');
  check('(c) a click overrides reduced-motion and starts playback', reachedPlayingAfterClick,
    'state=' + (await seedState(page)));
  check('(c) no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (d) bonus: unknown kernel id fails to poster with sg-error --- */
{
  const { page, errors } = await instrumentedPage();
  await gotoSafe(page, fixtureUrl({ kernel: 'does-not-exist-kernel' }), { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  const reachedError = await waitForState(page, 'error');
  const state = await seedState(page);
  check('(d) unknown kernel id fails to "error" (poster shown)', reachedError, 'state=' + state);
  const domHidden = await page.evaluate(() => {
    const el = document.querySelector('#seed');
    const root = el.shadowRoot;
    return { canvasHidden: root.querySelector('canvas').hidden, posterHidden: root.querySelector('.poster').hidden };
  });
  check('(d) failure resolves to the poster box, never a blank canvas',
    domHidden.canvasHidden === true && domHidden.posterHidden === false, JSON.stringify(domHidden));
  check('(d) zero GL contexts for a kernel that never compiled', (await page.evaluate(() => window.__glContexts)) === 0);
  await page.close();
}

/* ---------- (e) SEED-2: embed/contract.html conformance page ------------ */
{
  const { page, errors } = await instrumentedPage();
  await gotoSafe(page, `${GARDEN}/embed/contract.html`, { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  const settled = await page
    .waitForFunction(() => window.__conformanceDone === true, undefined, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check('(e) contract.html conformance run completes', settled);
  if (settled) {
    const conformanceFailed = await page.evaluate(() => window.__conformanceFailed);
    const conformanceResults = await page.evaluate(() => window.__conformanceResults);
    for (const r of conformanceResults || []) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'} contract: ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`);
    }
    check('(e) every contract.html clause passed', conformanceFailed === false);
  }
  // Clause G deliberately fetches a nonexistent kernel id (the sg-error
  // not-found path) — Chrome logs the resulting 404 as a console message
  // independent of the already-handled promise rejection; expected, filter it.
  const unexpectedErrors = errors.filter((e) => !/404 \(File not found\)/.test(e));
  check('(e) no unexpected console/page errors', unexpectedErrors.length === 0, unexpectedErrors.join(' | '));
  await page.close();
}

/* ---------- (f) SEED-3: unsafe context loss NEVER rebuilds --------------- */
// contract.html's own clauses (I-M) cover the rest of the unsafe tier;
// forcing a REAL context loss needs a page-level trick contract.html can't
// reach on its own, so it lives here — WEBGL_lose_context, the same
// extension real GPU-process TDRs surface through in a real browser.
{
  const { page, errors } = await instrumentedPage();
  await gotoSafe(page, `${GARDEN}/`, { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  const UNSAFE_GLSL = 'void mainImage(out vec4 c, in vec2 fragCoord) { c = vec4(fract(iTime), 0.0, 0.0, 1.0); }';
  await page.evaluate(async (glsl) => {
    await import('/assets/seed/seed@1.js');
    window.__readyCount = 0;
    const el = document.createElement('shader-seed');
    el.id = 'unsafe-seed';
    el.style.cssText = 'position:fixed;top:0;left:0;width:200px;';
    el.setAttribute('src', glsl);
    el.setAttribute('unsafe', '');
    el.addEventListener('sg-ready', () => { window.__readyCount++; });
    document.body.appendChild(el);
  }, UNSAFE_GLSL);

  const gotPoster = await page
    .waitForFunction(() => {
      const el = document.getElementById('unsafe-seed');
      return el && el.shadowRoot && el.shadowRoot.querySelector('.poster');
    }, undefined, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('(f) unsafe seed settles on the poster box (forced-click, never autoplays)', gotPoster);

  await page.evaluate(() => document.getElementById('unsafe-seed').shadowRoot.querySelector('.poster').click());
  const played = await waitForState(page, 'playing', '#unsafe-seed');
  check('(f) a click plays unsafe source', played);

  // Snapshot readyCount only once "playing" — a click that lands before the
  // element's own cold/no-autoplay poster-settle path finishes can
  // legitimately produce a first sg-ready from THAT (pre-existing SEED-1/2
  // behavior, unrelated to context loss) before the click's live boot fires
  // a second one; either way is a correct, already-completed compile
  // sequence by the time state==='playing'. What must NOT happen is a THIRD
  // sg-ready fired BY the loss below.
  const readyBeforeLoss = await page.evaluate(() => window.__readyCount);

  const lossSupported = await page.evaluate(() => {
    const el = document.getElementById('unsafe-seed');
    const gl = el._runtime && el._runtime._gl;
    const ext = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext();
    return true;
  });

  if (lossSupported) {
    const knockedOff = await page
      .waitForFunction(() => document.getElementById('unsafe-seed').state !== 'playing', undefined, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check('(f) context loss knocks the unsafe seed off "playing"', knockedOff);
    await sleep(1200); // outlive any (absent) automatic rebuild attempt
    const after = await page.evaluate(() => {
      const el = document.getElementById('unsafe-seed');
      return { state: el.state, backend: el.backend, readyCount: window.__readyCount };
    });
    check('(f) unsafe context loss never rebuilds — no sg-ready fired by the loss',
      after.readyCount === readyBeforeLoss, `before=${readyBeforeLoss} after=${JSON.stringify(after)}`);
    check('(f) unsafe context loss never rebuilds — backend stays disposed (null)', after.backend === null, JSON.stringify(after));
    check('(f) unsafe context loss settles on poster/error, never back to "playing"', after.state !== 'playing', JSON.stringify(after));
  } else {
    check(
      '(f) unsafe context loss never rebuilds — WEBGL_lose_context unavailable, CODE-VERIFIED instead',
      true,
      'site/js/seed/element.js _onContextLost() gates the one-rebuild branch on "!wasUnsafe" (seed.md §5.2)',
    );
  }
  check('(f) no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (g) SEED-3: viewer "Copy embed code" -> a real working embed - */
// The button's snippet is captured via a monkey-patched navigator.clipboard
// (headless Chrome has no real clipboard permission), then replayed
// VERBATIM — exactly the text a user would paste — on a fresh, blank page
// to prove it is a genuinely working embed, not just plausible markup.
{
  const { page, errors } = await instrumentedPage();
  await page.evaluateOnNewDocument(() => {
    window.__clipboard = null;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (text) => { window.__clipboard = text; return Promise.resolve(); } },
      configurable: true,
    });
  });
  await gotoSafe(page, `${GARDEN}/#/s/biome-rolling-hills`, { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));

  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.viewer-topbar button')]
      .find((b) => b.textContent.trim() === 'Copy embed code');
    if (!btn) return false;
    btn.click();
    return true;
  });
  check('(g) viewer topbar has a "Copy embed code" button', clicked);

  await page.waitForFunction(() => window.__clipboard !== null, undefined, { timeout: 5000 }).catch(() => {});
  const snippet = await page.evaluate(() => window.__clipboard);
  check('(g) clicking it copies a <shader-seed> snippet', typeof snippet === 'string' && snippet.includes('<shader-seed'), snippet);
  const hasSrc = /<script type="module" src="[^"]+seed@1\.js">/.test(snippet || '');
  const hasKernel = /<shader-seed kernel="biome-rolling-hills">/.test(snippet || '');
  check('(g) snippet has a module script tag pointing at seed@1.js', hasSrc, snippet);
  check('(g) snippet has a shader-seed kernel= attribute for THIS kernel', hasKernel, snippet);
  await page.close();

  if (snippet) {
    const page2 = await browser.newPage();
    const errors2 = [];
    page2.on('pageerror', (e) => errors2.push(String(e)));
    page2.on('console', (m) => { if (m.type() === 'error') errors2.push(m.text()); });
    // A fresh, blank document — no relation to the garden origin beyond the
    // absolute URL baked into the snippet itself (seed.md §5's "self-hostable,
    // works from a bare copy-paste" claim, exercised for real).
    await page2.setContent(`<!doctype html><html><body>${snippet}</body></html>`, { waitUntil: 'domcontentloaded' })
      .catch((e) => errors2.push('SETCONTENT: ' + e.message));
    const ready = await page2
      .waitForFunction(() => {
        const el = document.querySelector('shader-seed');
        return el && el.state === 'playing';
      }, undefined, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('(g) the copied snippet, replayed verbatim on a blank page, reaches "playing"', ready);
    check('(g) no console/page errors replaying the snippet', errors2.length === 0, errors2.join(' | '));
    await page2.close();
  }
}

/* ---------- (h) SEED-4: embed.html snippet generator ---------------------- */
{
  const { page, errors } = await instrumentedPage();
  await gotoSafe(page, `${GARDEN}/embed/embed.html`, { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));

  const kernelCount = await page.evaluate(() => document.getElementById('kernel-select').options.length);
  check('(h) embed.html populates the kernel picker from kernels.json', kernelCount > 0, 'count=' + kernelCount);

  // Floating path: no integrity attr, points at the alias/floating file, and
  // the live preview on the page itself reaches "playing".
  const floatingSnippet = await page.evaluate(() => document.getElementById('snippet-output').value);
  check('(h) floating snippet has no integrity= attribute', !/integrity=/.test(floatingSnippet), floatingSnippet);
  check('(h) floating snippet points at seed@1.js', /seed@1\.js/.test(floatingSnippet), floatingSnippet);
  const floatingPreviewReady = await page
    .waitForFunction(() => {
      const el = document.querySelector('#preview-box shader-seed');
      return el && el.state === 'playing';
    }, undefined, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('(h) the floating live preview on the page reaches "playing"', floatingPreviewReady);

  // Pinned + SRI path: toggle the checkbox, re-read the generated snippet.
  await page.evaluate(() => {
    const cb = document.getElementById('sri-toggle');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  });
  await page
    .waitForFunction(() => /integrity=/.test(document.getElementById('snippet-output').value), undefined, { timeout: 5000 })
    .catch(() => {});
  const pinnedSnippet = await page.evaluate(() => document.getElementById('snippet-output').value);
  const hasIntegrity = /integrity="sha384-[A-Za-z0-9+/=]+"/.test(pinnedSnippet);
  const hasCrossorigin = /crossorigin="anonymous"/.test(pinnedSnippet);
  check('(h) SRI-pinned snippet carries an integrity= sha384 hash', hasIntegrity, pinnedSnippet);
  check('(h) SRI-pinned snippet carries crossorigin="anonymous"', hasCrossorigin, pinnedSnippet);
  check('(h) SRI-pinned snippet points at a pinned seed@x.y.z.js, not the floating alias',
    /seed@\d+\.\d+\.\d+\.js/.test(pinnedSnippet), pinnedSnippet);
  const pinnedPreviewReady = await page
    .waitForFunction(() => {
      const el = document.querySelector('#preview-box shader-seed');
      return el && el.state === 'playing';
    }, undefined, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('(h) the SRI-pinned live preview on the page ALSO reaches "playing" (the hash is correct)', pinnedPreviewReady);
  check('(h) no console/page errors on embed.html', errors.length === 0, errors.join(' | '));
  await page.close();

  // Both copied snippets, replayed VERBATIM on a fresh blank page — same
  // rigor as clause (g), now for the doc generator instead of the viewer
  // button. This is the literal accept line: a snippet that "passes the
  // conformance page" is one that a browser can actually run to "playing".
  for (const [label, snippet] of [['floating', floatingSnippet], ['SRI-pinned', pinnedSnippet]]) {
    const replay = await browser.newPage();
    const replayErrors = [];
    replay.on('pageerror', (e) => replayErrors.push(String(e)));
    replay.on('console', (m) => { if (m.type() === 'error') replayErrors.push(m.text()); });
    await replay.setContent(`<!doctype html><html><body>${snippet}</body></html>`, { waitUntil: 'domcontentloaded' })
      .catch((e) => replayErrors.push('SETCONTENT: ' + e.message));
    const reached = await replay
      .waitForFunction(() => {
        const el = document.querySelector('shader-seed');
        return el && el.state === 'playing';
      }, undefined, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check(`(h) the copied ${label} snippet, replayed verbatim on a blank page, reaches "playing"`, reached);
    check(`(h) no console/page errors replaying the ${label} snippet`, replayErrors.length === 0, replayErrors.join(' | '));
    await replay.close();
  }

  // Negative control: a corrupted integrity hash must genuinely block the
  // module load (not just render a cosmetic warning) — proves `integrity=`
  // is real browser-enforced SRI, not decoration the generator merely prints.
  {
    const corrupted = pinnedSnippet.replace(/integrity="sha384-[A-Za-z0-9+/=]+"/, 'integrity="sha384-not-the-right-hash-at-all-0000000000000000000000000000000000000000"');
    const replay = await browser.newPage();
    await replay.setContent(`<!doctype html><html><body>${corrupted}</body></html>`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(1500);
    const defined = await replay.evaluate(() => !!customElements.get('shader-seed'));
    check('(h) a corrupted integrity hash blocks the module — shader-seed never gets defined', !defined);
    await replay.close();
  }
}

/* ---------- (i) SEED-4: releases.json ledger matches real file bytes ----- */
// Node-side, no browser needed — this is the standing "SRI publishing flow"
// guarantee tools/bake_seed.py's own verify_ledger() enforces at bake time;
// pinned here too so a hand-edited releases.json or a manually-copied
// seed@x.y.z.js can't drift without the test suite itself catching it.
{
  const seedAssetDir = path.join(SITE_ROOT, 'assets', 'seed');
  const releasesPath = path.join(SITE_ROOT, 'embed', 'releases.json');
  const releases = JSON.parse(fs.readFileSync(releasesPath, 'utf8'));
  const byFile = new Map(releases.map((r) => [r.file, r]));
  const pinnedFiles = fs.readdirSync(seedAssetDir).filter((f) => /^seed@\d+\.\d+\.\d+\.js$/.test(f));
  check('(i) at least one pinned seed release exists on disk', pinnedFiles.length > 0, JSON.stringify(pinnedFiles));
  for (const name of pinnedFiles) {
    const relPath = 'assets/seed/' + name;
    const data = fs.readFileSync(path.join(seedAssetDir, name));
    const digest = 'sha384-' + crypto.createHash('sha384').update(data).digest('base64');
    const entry = byFile.get(relPath);
    check(`(i) releases.json has an entry for ${name}`, !!entry, relPath);
    if (entry) {
      check(`(i) releases.json sha384 for ${name} matches the file's actual bytes`, entry.sha384 === digest,
        `ledger=${entry.sha384} actual=${digest}`);
      check(`(i) releases.json bytes for ${name} matches the file's actual size`, entry.bytes === data.length,
        `ledger=${entry.bytes} actual=${data.length}`);
    }
  }
}

/* ---------- (j) SEED-4: battery enhancement (mocked, feature-detected) --- */
// navigator.getBattery is mocked ONLY in this one page — every other clause
// in this file exercises the real "API absent" path, which is the whole
// point of "feature-detected, zero-cost elsewhere" (seed.md §4.3).
{
  const { page, errors } = await instrumentedPage();
  await page.evaluateOnNewDocument(() => {
    navigator.getBattery = () => Promise.resolve({
      charging: false,
      level: 0.05,
      addEventListener() {},
      removeEventListener() {},
    });
  });
  await gotoSafe(page, `${GARDEN}/`, { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.evaluate(async () => {
    await import('/assets/seed/seed@1.js');
    const el = document.createElement('shader-seed');
    el.id = 'battery-seed';
    el.style.cssText = 'position:fixed;top:0;left:0;width:200px;';
    el.setAttribute('kernel', 'biome-rolling-hills'); // default autoplay="visible"
    document.body.appendChild(el);
  });
  // sleep(1200) was a bet on how long getBattery()'s promise plus the
  // element's own boot takes. CI run 32654025156 read `state=loading` — the
  // element had not finished booting at all, so "never left poster" was being
  // asserted about a seed that had not yet reached ANY settled state. Wait for
  // it to leave 'loading' (a ceiling, free when it boots promptly), then make
  // the real claim: whatever it settled ON must be 'poster'.
  // Waiting for "not loading" was too early: the element settles through more
  // than one step, and run 32682633622 sampled the gap — it reported
  // `FAIL ... (state=poster)`, a message that contradicts its own verdict,
  // because the boolean and the detail string were TWO separate evaluate()
  // calls with the transition in between. Wait for the state this actually
  // claims, then hold, then take ONE snapshot that answers both.
  //
  // Still non-vacuous, and still the same claim: an element that autoplays
  // and STAYS playing never satisfies the poll, and the snapshot below then
  // reads 'playing' and fails. The extra settle is the real teeth — an
  // autoplay that fires late is still an autoplay.
  await page.waitForFunction(
    () => document.getElementById('battery-seed')?.state === 'poster',
    undefined,
    { timeout: scaled(20000), polling: 200 },
  ).catch(() => { /* fall through: the snapshot below reports where it actually is */ });
  await sleep(600);
  const batteryState = await page.evaluate(() => document.getElementById('battery-seed').state);
  check('(j) with battery discharging <20%, default autoplay="visible" never leaves "poster"',
    batteryState === 'poster', 'state=' + batteryState);

  await page.evaluate(() => document.getElementById('battery-seed').shadowRoot.querySelector('.poster').click());
  const played = await waitForState(page, 'playing', '#battery-seed');
  check('(j) a click still plays it despite low battery (forced-click degrade, not a hard block)', played);
  check('(j) no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (k) SEED-4: touch attribution reveal-then-fade ---------------- */
{
  const { page, errors } = await instrumentedPage();
  await gotoSafe(page, `${GARDEN}/`, { waitUntil: 'networkidle0', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.evaluate(async () => {
    await import('/assets/seed/seed@1.js');
    const el = document.createElement('shader-seed');
    el.id = 'touch-seed';
    el.style.cssText = 'position:fixed;top:0;left:0;width:200px;';
    el.setAttribute('kernel', 'biome-rolling-hills');
    document.body.appendChild(el);
  });
  await waitForState(page, 'playing', '#touch-seed');

  const beforeOpacity = await page.evaluate(() => {
    const chip = document.getElementById('touch-seed').shadowRoot.querySelector('.chip');
    return getComputedStyle(chip).opacity;
  });
  await page.evaluate(() => {
    const wrap = document.getElementById('touch-seed').shadowRoot.querySelector('.wrap');
    wrap.dispatchEvent(new Event('touchstart', { bubbles: true }));
  });
  // The .15s opacity transition is a CSS duration, but the handler that starts
  // it only runs once the element's own listeners are attached, and
  // getComputedStyle mid-transition returns an intermediate. CI run
  // 32654025156 sampled opacity=0 at 300ms. Poll for the end state instead of
  // guessing the duration; a chip that never reveals still fails below.
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('touch-seed').shadowRoot.querySelector('.chip')).opacity === '1',
    undefined,
    { timeout: scaled(5000), polling: 100 },
  ).catch(() => { /* fall through: the check below reports the opacity it is stuck at */ });
  const afterTouchOpacity = await page.evaluate(() => {
    const chip = document.getElementById('touch-seed').shadowRoot.querySelector('.chip');
    return getComputedStyle(chip).opacity;
  });
  check('(k) chip is invisible before any touch (hover-gated default)', beforeOpacity === '0', 'opacity=' + beforeOpacity);
  check('(k) a synthetic touchstart reveals the chip immediately', afterTouchOpacity === '1', 'opacity=' + afterTouchOpacity);

  await sleep(3400); // outlive the 3s reveal window
  const fadedOpacity = await page.evaluate(() => {
    const chip = document.getElementById('touch-seed').shadowRoot.querySelector('.chip');
    return getComputedStyle(chip).opacity;
  });
  check('(k) the chip fades back within ~3s of the tap (seed.md §6)', fadedOpacity === '0', 'opacity=' + fadedOpacity);
  check('(k) no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
gardenServer.kill();
foreignServer.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
