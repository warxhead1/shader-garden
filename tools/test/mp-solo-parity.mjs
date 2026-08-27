// Shader Garden — mp-solo-parity.mjs
// Multiplayer spec §10 gate: I1/I3. On plain `#/garden` (no room, no relay
// param) — the ONLY fork point index.js's own header comment describes —
// `uPeerCount`/`uSpongeOn` must never be set, and COMP ids 1..8 must probe
// to exactly the same components they always did (§0.5 C2: the count grew
// 8 -> 11, but stable identity for ids 1..8 is the real invariant, not the
// count).
// Usage: node tools/test/mp-solo-parity.mjs   (first: npm ci in tools/test)
import { readFileSync } from 'node:fs';
import { launch, serveSite, sleep, gotoSafe, assertRealGpu, SITE_ROOT, awaitGardenCanvas } from './browser.mjs';
import { parseScene } from '../../site/js/organs/garden/parse.js';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

// Ground truth for id -> component: parse.js assigns numeric ids by FILE
// ORDER (parse.js's own header: "components[id - 1]") — never hand-typed,
// so this can't rot if scene.glsl's component list changes shape again.
const sceneSrc = readFileSync(`${SITE_ROOT}/assets/garden/scene.glsl`, 'utf8');
const { components } = parseScene(sceneSrc);
check('(setup) scene.glsl parses to at least 8 components', components.length >= 8, 'count=' + components.length);
const first8 = components.slice(0, 8);

const { server, base: BASE } = await serveSite();
const browser = await launch();

function freshPage(errors) {
  return browser.newPage().then((page) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    return page;
  });
}

// Same GL2Runtime.setUniforms spy garden-movement.mjs's armSpies uses — every
// value object passed to any setUniforms() call across the whole session,
// solo or MP, keyed only by which uniform names appeared. Patches BOTH
// runtime classes (mirrors mp-clock.mjs's armClockSpy): a fresh #/garden
// mount lands on WebGPU by default post-§0.5-C1-supersession, and "Edit
// here" below rebuilds it onto WebGL2 mid-run (GARDEN-IDE is GLSL-only), so
// a solo session's setUniforms calls genuinely cross both classes in one
// run. The underlying invariant (no uPeerCount/uSpongeOn on the solo route)
// is backend-independent — applyMpUniforms()'s `if (!room) return;` guard
// doesn't care which runtime called setUniforms — but only patching
// GL2Runtime would leave the WebGPU-backed portion of the session
// unobserved and understate what this check actually exercised.
async function armUniformSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__uniformCalls = [];
    function patch(Ctor) {
      const orig = Ctor.prototype.setUniforms;
      Ctor.prototype.setUniforms = function (values) {
        window.__uniformCalls.push({ ...values });
        return orig.call(this, values);
      };
    }
    import('./js/runtime/webgl2.js').then((mod) => patch(mod.GL2Runtime)).catch(() => {});
    import('./js/runtime/webgpu.js').then((mod) => patch(mod.GPURuntime)).catch(() => {});
  });
}

async function clickTrayItem(page, name) {
  await page.waitForSelector('.garden-tray-item', { timeout: 8000 });
  const items = await page.$$('.garden-tray-item');
  for (const item of items) {
    const text = await item.$eval('.garden-tray-item-name', (el) => el.childNodes[0].textContent.trim());
    if (text === name) { await item.click(); return true; }
  }
  return false;
}

/* ---------- (a) uPeerCount/uSpongeOn never set on the solo route ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await armUniformSpy(page);
  await gotoSafe(page, BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  // This suite asserts on rendering output (uniform calls, probe titles) —
  // proves a real GPU adapter is behind it, not a silent SwiftShader/
  // llvmpipe landing that would report green while proving nothing.
  const gpuInfoA = await assertRealGpu(page);
  check('(setup) real GPU adapter present', !!gpuInfoA, JSON.stringify(gpuInfoA));
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors); // shared ceiling + state dump; see browser.mjs

  // Regression guard for the index.js `if (room)` brace bug: a solo
  // mount (no room param) must still build the stage, runtime host, and
  // topbar — the entire mount body is gated on the canvas + topbar
  // DOM existing, NOT on `room`. The previous regression shipped a
  // missing brace that pushed every line below `if (room) { ... mp = {...};`
  // into the room branch, so a solo mount would never even reach
  // runtimeHost() — no canvas, no topbar, no probe. assertRealGpu()
  // alone wouldn't catch it (it only proves a GPU adapter exists);
  // the stage / topbar presence checks below are the actual mount-
  // stage assertion.
  const mountStage = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector('canvas.garden-canvas'),
    hasTopbar: !!document.querySelector('.viewer-topbar'),
    hasStage: !!document.querySelector('.viewer-stage'),
    hasQualitySelect: !!document.querySelector('.garden-quality-select'),
    hasCamSelect: !!document.querySelector('.garden-cam-select'),
    hasTray: !!document.querySelector('.garden-tray'),
  }));
  check('(a) solo mount built the stage (no missing-brace regression)',
    mountStage.hasStage, JSON.stringify(mountStage));
  check('(a) solo mount built the topbar (no missing-brace regression)',
    mountStage.hasTopbar, JSON.stringify(mountStage));
  check('(a) solo mount produced a canvas (runtimeHost ran, not skipped)',
    mountStage.hasCanvas, JSON.stringify(mountStage));
  check('(a) solo mount has quality + camera + tray controls (mount body reached its tail)',
    mountStage.hasQualitySelect && mountStage.hasCamSelect && mountStage.hasTray, JSON.stringify(mountStage));

  // Exercise every other surface that would ALSO push uniforms, so this
  // isn't just "solo never happened to render a frame": open + edit a
  // component, move the character, switch camera modes, change quality.
  await clickTrayItem(page, first8[0].name);
  await sleep(200);
  await page.click('.probe-panel .btn:not(.probe-edit-link)').catch(() => {}); // "Edit here"
  await sleep(400);
  await page.keyboard.down('d');
  await sleep(300);
  await page.keyboard.up('d');
  await sleep(150);
  await page.select('.garden-cam-select', '1').catch(() => {});
  await sleep(300);
  await page.select('.garden-quality-select', 'high').catch(() => {});
  await sleep(300);

  const noMpUniformsSet = await page.evaluate(() => window.__uniformCalls
    .every((c) => !('uPeerCount' in c) && !('uSpongeOn' in c)));
  check('(a) a solo mount never sets uPeerCount or uSpongeOn, across mount/edit/move/camera/quality',
    noMpUniformsSet,
    JSON.stringify((await page.evaluate(() => window.__uniformCalls))
      .filter((c) => ('uPeerCount' in c) || ('uSpongeOn' in c))));
  // No MP DOM either (§8: "every element it creates is gated on `room`").
  const mpDom = await page.evaluate(() => !!document.querySelector('.garden-mp-panel, .garden-mp-status, .garden-mp-room'));
  check('(a) no MP DOM (roster/status/room badge) on the solo route', !mpDom);

  check('(a) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (b) COMP ids 1..8 probe to the same components as before ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  const gpuInfoB = await assertRealGpu(page);
  check('(setup) real GPU adapter present', !!gpuInfoB, JSON.stringify(gpuInfoB));
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors); // shared ceiling + state dump; see browser.mjs
  await page.waitForSelector('.garden-tray-item', { timeout: 8000 }).catch(() => errors.push('no tray'));

  // The tray itself is built as components.map((c,i) => ...) — file order,
  // same order as the numeric probe id — so its first 8 items ARE ids 1..8
  // by construction. Clicking each by name and reading the probe panel
  // title back proves both halves of I2 at once: the tray's own item order
  // AND the probe readback agree with parse.js's ground truth.
  const trayNames = await page.$$eval('.garden-tray-item .garden-tray-item-name',
    (els) => els.map((el) => el.childNodes[0].textContent.trim()));
  check('(b) the tray\'s first 8 items are ids 1..8, in scene.glsl file order',
    JSON.stringify(trayNames.slice(0, 8)) === JSON.stringify(first8.map((c) => c.name)),
    'tray=' + JSON.stringify(trayNames.slice(0, 8)) + ' expected=' + JSON.stringify(first8.map((c) => c.name)));

  for (const c of first8) {
    const ok = await clickTrayItem(page, c.name);
    await sleep(250);
    const title = await page.$eval('.probe-title', (el) => el.textContent).catch(() => null);
    check(`(b) id ${components.indexOf(c) + 1} ("${c.id}") probes to "${c.name}"`, ok && title === c.name, 'got ' + title);
  }

  check('(b) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
