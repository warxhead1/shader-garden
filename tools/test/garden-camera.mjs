// Wave-4 §B acceptance: three camera modes (Orbit/Follow/Overview), a
// cross-fade on switch, and probing staying live in every mode.
// Usage: node tools/test/garden-camera.mjs   (npm ci in tools/test first)
//
// Screen-point oracles below were determined empirically (same discipline
// garden.mjs's own probe(720,380) comment describes) at the default
// 1440x900 viewport, camera fully settled (uCamBlend=1, no transition in
// flight): Orbit's own oracle is garden.mjs's existing (720,380) ->
// "Bouncing Figure"; Follow's canvas-center resolves to "Bouncing Figure"
// (it frames the character directly); Overview's canvas-center resolves to
// "Meadow Sway" (it looks down at the diorama centroid, not the character)
// — both re-verified against production code (probeAt against the real
// runtime), never guessed from a screenshot.
//
// Covers:
//   (a) switching modes (keyboard 1/2/3 AND the topbar select) updates
//       uCamMode and ramps uCamBlend 0->1 monotonically over ~450ms.
//   (b) a forced-sync render at uCamBlend=0.5 differs from BOTH the pure
//       pre- and post-mode renders (the blend is a real cross-fade, not a
//       step function) — deterministic scratch-canvas technique, not a
//       race against the live rAF ramp.
//   (c) probing (click-to-probe) returns a real component in all three
//       modes, at each mode's own screen-point oracle.
//   (d) Follow keeps the character framed at its own oracle point even
//       after it has walked (and turned) well away from where it started —
//       proof the camera actually tracks uCharYaw/position, not a fixed offset.
//   (e) orbit-default byte-identical-at-rest is covered by
//       garden-locomotion-parity.mjs's test (1) (uCamMode=uPrevCamMode=0)
//       — not duplicated here.
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
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    return page;
  });
}

async function armBlendSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__blendCalls = [];
    import('./js/runtime/webgl2.js').then((mod) => {
      const orig = mod.GL2Runtime.prototype.setUniforms;
      mod.GL2Runtime.prototype.setUniforms = function (values) {
        if ('uCamBlend' in values) window.__blendCalls.push(values.uCamBlend);
        return orig.call(this, values);
      };
    }).catch(() => {});
  });
}

async function probe(page, x, y) {
  await page.mouse.click(x, y);
  await sleep(300);
  const title = await page.$eval('.probe-title', (el) => el.textContent).catch(() => null);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(150);
  return title;
}

/* ---------- (a) keyboard + select both switch modes; uCamBlend ramps 0->1 ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await armBlendSpy(page);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errors.push('no garden-canvas'));

  check('(a) boots in Orbit', await page.$eval('.garden-cam-select', (el) => el.value) === '0');

  // Boot itself applies uCamBlend=1 (settled Orbit, see index.js's onBuild) —
  // clear that leading call so the array below is ONLY the switch's own ramp.
  await page.evaluate(() => { window.__blendCalls.length = 0; });
  await page.keyboard.press('2'); // Follow
  await sleep(600); // outlive the ~450ms blend
  check('(a) keyboard 2 switches the select to Follow', await page.$eval('.garden-cam-select', (el) => el.value) === '1');
  let calls = await page.evaluate(() => window.__blendCalls);
  check('(a) the switch produced multiple uCamBlend writes', calls.length >= 2, 'got ' + calls.length);
  let nonDecreasing = calls.every((v, i) => i === 0 || v >= calls[i - 1]);
  check('(a) uCamBlend is monotonically non-decreasing during the ramp', nonDecreasing, JSON.stringify(calls));
  check('(a) uCamBlend reaches 1 (fully resolved)', calls[calls.length - 1] === 1, JSON.stringify(calls));

  await page.evaluate(() => { window.__blendCalls.length = 0; });
  await page.select('.garden-cam-select', '2'); // Overview, via the topbar <select>
  await sleep(600);
  check('(a) the <select> itself switches modes (not just keyboard)',
    await page.$eval('.garden-cam-select', (el) => el.value) === '2');
  calls = await page.evaluate(() => window.__blendCalls);
  check('(a) the select switch also ramps uCamBlend 0->1', calls.length >= 2 && calls[calls.length - 1] === 1, JSON.stringify(calls));

  check('(a) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (b) uCamBlend=0.5 is a real cross-fade, not a step function ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));

  const src = await (await fetch(BASE + '/assets/garden/scene.glsl')).text();

  const render = (uniforms) => page.evaluate(async (src, uniforms) => {
    const { GL2Runtime } = await import('./js/runtime/webgl2.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '320px';
    canvas.style.height = '180px';
    document.body.appendChild(canvas);
    const rt = new GL2Runtime(canvas);
    const compiled = rt.setShader(src);
    if (!compiled.ok) { rt.dispose(); canvas.remove(); return { error: compiled.log }; }
    rt.setUniforms(uniforms);
    const gl = canvas.getContext('webgl2');
    rt.renderOnce(2.0);
    const w = canvas.width, h = canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    rt.dispose();
    canvas.remove();
    return { pixels: Array.from(pixels) };
  }, src, uniforms);

  // Orbit -> Follow, mid-transition. Both endpoints computed fresh, plus a
  // blend=0.5 frame — same uCharPosX/Z/Yaw throughout so only uCamBlend varies.
  const base = { SG_QUALITY: 2, uCharPosX: 0.4, uCharPosZ: -0.3, uCharYaw: 0.5, uCharGaitDist: 0, uCharSpeed01: 0, uCamMode: 1, uPrevCamMode: 0 };
  const pre = await render({ ...base, uCamBlend: 0 });   // pure Orbit (uPrevCamMode)
  const post = await render({ ...base, uCamBlend: 1 });  // pure Follow (uCamMode)
  const mid = await render({ ...base, uCamBlend: 0.5 }); // cross-fade midpoint

  check('(b) all three renders compiled', !pre.error && !post.error && !mid.error, [pre.error, post.error, mid.error].filter(Boolean).join(' | '));
  if (!pre.error && !post.error && !mid.error) {
    const diffsFrom = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
    check('(b) pre (Orbit) and post (Follow) renders actually differ (sanity check on the test itself)',
      diffsFrom(pre.pixels, post.pixels) > 0);
    check('(b) mid-transition (blend=0.5) differs from the pure Orbit render', diffsFrom(mid.pixels, pre.pixels) > 0);
    check('(b) mid-transition (blend=0.5) differs from the pure Follow render', diffsFrom(mid.pixels, post.pixels) > 0);
  }

  check('(b) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (c) probing returns a real component in all three modes ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errors.push('no garden-canvas'));
  await sleep(500);

  const oracles = [
    { mode: '1', name: 'Orbit', x: 720, y: 380, expect: 'Bouncing Figure' },
    { mode: '2', name: 'Follow', x: 720, y: 450, expect: 'Bouncing Figure' },
    { mode: '3', name: 'Overview', x: 720, y: 450, expect: 'Meadow Sway' },
  ];
  for (const o of oracles) {
    await page.keyboard.press(o.mode);
    await sleep(600);
    const title = await probe(page, o.x, o.y);
    check(`(c) probing in ${o.name} mode returns "${o.expect}"`, title === o.expect, 'got ' + title);
  }

  check('(c) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (d) Follow tracks the character after it walks and turns ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.garden-canvas', { timeout: 8000 }).catch(() => errors.push('no garden-canvas'));

  await page.keyboard.press('2'); // Follow, before moving — proves it tracks from the start too
  await sleep(600);

  // Walk in an L-shape so both position AND facing (uCharYaw) change well
  // away from the origin/rest-yaw the (c) oracle above was measured at.
  await page.keyboard.down('d');
  await sleep(900);
  await page.keyboard.up('d');
  await page.keyboard.down('w');
  await sleep(900);
  await page.keyboard.up('w');
  await sleep(200);

  const title = await probe(page, 720, 450); // same Follow oracle point as (c)
  check('(d) Follow still frames the character at its oracle point after walking + turning', title === 'Bouncing Figure', 'got ' + title);

  check('(d) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
