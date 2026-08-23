// Shader Garden — wave-3 item E acceptance tests (player-controller
// movement: keyboard integrator + touch joystick, one shared move vector).
// Usage: node tools/test/garden-movement.mjs   (first: npm ci in tools/test)
//
// Covers:
//   (a) holding 'd' increases uCharPosX over successive frames (spy on
//       GL2Runtime.setUniforms, same technique garden.mjs's armSpies uses).
//   (b) no movement while a tune-slider <input> or the mini-editor has
//       focus — the inEditableChrome guard (dom.js) must hold WASD/arrows.
//   (c) the circular play-radius clamp holds: driving in one direction long
//       enough to cross it never pushes the position past PLAY_RADIUS.
//   (d) the touch joystick writes into the SAME uniform path as the
//       keyboard — real Puppeteer touch/mobile emulation flips
//       matchMedia('(pointer: coarse)') in this headless Chrome (verified
//       empirically before writing this file), so the joystick's own
//       production gate is exercised directly rather than bypassed with a
//       test-only hook.
//   (e) no console errors across the whole session.
//   (f) wave-4 §A: holding a direction produces monotonically increasing
//       uCharGaitDist writes; releasing freezes it within one idle-exit
//       frame (no further writes trickle in after release).
//   (g) wave-4 §A: uCharYaw never jumps by more than TURN_RATE*dt in a
//       single frame across a scripted 180-degree direction reversal (no
//       instant snap-to).
//
// Real-GPU migration (see browser.mjs's header): every section here mounts
// #/garden with prefer:'auto' and never opens the editor (the one thing
// that forces a WebGL2 rebuild — see garden.mjs), so on this harness the
// mount stays on WebGPU (GPURuntime) the whole time. This suite asserts on
// the uniform WRITES the movement/gait/yaw integrator produces, not on
// which backend renders them, so armSpies patches BOTH runtime classes'
// setUniforms into the same window.__uniformCalls array (decision rule:
// "asserts on output generically" -> let it run WebGPU).
// Prints "all-PASS" and exits 0 only if every check passed.
import { launch, serveSite, sleep, scaled, gotoSafe, assertRealGpu } from './browser.mjs';

const { server, base: BASE } = await serveSite();
const browser = await launch();
let failed = false;

function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

// Playwright's setViewportSize(vp) — what shimPage's page.setViewport maps
// onto — only ever reads {width, height}. Puppeteer's setViewport also
// carries isMobile/hasTouch, which Playwright instead requires as REAL
// newPage()/newContext() creation options (Emulation.setDeviceMetricsOverride
// equivalents aren't settable post-creation). MEASURED: passing
// {isMobile,hasTouch} through the shim silently drops them — coarse-pointer
// emulation never took effect, no error, no throw. So isMobile/hasTouch go
// straight to browser.newPage() (browser.mjs merges opts into its own
// newPage(), a real Playwright call) instead of through the shim.
function freshPage(errors, viewportOpts) {
  const { isMobile, hasTouch, ...vp } = viewportOpts || {};
  return browser.newPage(isMobile || hasTouch ? { isMobile, hasTouch } : {}).then(async (page) => {
    if (Object.keys(vp).length) await page.setViewport(vp);
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    return page;
  });
}

// `.garden-canvas` is prepended SYNCHRONOUSLY by runtime-host's build(),
// before either backend is attempted — so its absence never means "the GPU is
// slow", it means the organ never got as far as building, or built and then
// removed the canvas because BOTH backends failed (runtime-host.js: `if
// (!picked) { canvas.remove(); ... }`). A bare `errors.push('no
// garden-canvas')` cannot tell those apart, and this failed on CI in a shape
// that does not reproduce on this workstation under any combination of
// SwiftShader, WebGPU-disabled and 2-core pinning that was tried. So the
// timeout path SAYS WHAT IT SAW: enough state to distinguish "still booting",
// "route never mounted" and "both backends refused" from a log alone.
async function awaitGardenCanvas(page, errors) {
  try {
    await page.waitForSelector('.garden-canvas', { timeout: 8000 });
    return true;
  } catch {
    const seen = await page.evaluate(() => ({
      hash: location.hash,
      canvases: document.querySelectorAll('canvas').length,
      classes: [...document.querySelectorAll('canvas')].map((c) => c.className),
      stage: !!document.querySelector('.garden-stage, .stage'),
      badge: document.querySelector('.badge-backend')?.textContent || null,
      fps: document.querySelector('.badge-fps')?.textContent || null,
      bodyLen: document.body.innerHTML.length,
    })).catch((e) => ({ evaluateFailed: String(e) }));
    errors.push('no garden-canvas ' + JSON.stringify(seen));
    return false;
  }
}

// Same GL2Runtime.setUniforms spy garden.mjs's armSpies uses — patched on
// the prototype so it takes effect regardless of when the instance under
// test was constructed (method lookup happens at call time).
async function armSpies(page) {
  await page.evaluateOnNewDocument(() => {
    window.__uniformCalls = [];
    const hook = (mod, className) => {
      const orig = mod[className].prototype.setUniforms;
      mod[className].prototype.setUniforms = function (values) {
        window.__uniformCalls.push({ ...values });
        return orig.call(this, values);
      };
    };
    import('./js/runtime/webgl2.js').then((mod) => hook(mod, 'GL2Runtime')).catch(() => {});
    import('./js/runtime/webgpu.js').then((mod) => hook(mod, 'GPURuntime')).catch(() => {});
  });
}

/* ---------- (a) holding 'd' increases uCharPosX across frames ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await armSpies(page);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors);
  await page.bringToFront(); // real headed browser: keyboard input needs the window focused
  // MEASURED: this is the FIRST page opened on this browser, and on a cold
  // module/pipeline cache the mount's window.addEventListener('keydown', ...)
  // (index.js, attached well after the async runtimeHost() build — line
  // ~717) can still be un-attached at the moment '.garden-canvas' first
  // appears in the DOM, so a keydown sent right after waitForSelector can
  // land before the app is listening for it and silently produce zero
  // movement. Every later page in this run (b onward) is on a warm cache and
  // needs no such margin — same real-GPU-is-slower-to-boot effect
  // garden.mjs's own sleep(2500)-after-nav margin exists for. Polls the fps
  // badge (populated once the runtime's own render loop starts, which
  // happens after the async build the keydown listener also waits on) with
  // a bounded ceiling instead of a single fixed sleep, since real-GPU
  // pipeline-compile time on this box also varies with contention from
  // sibling suites/agents running concurrently.
  // A ceiling, scaled by TIME_SCALE rather than counted in SLEEP_SCALE'd
  // steps: `20 x sleep(300)` silently fell from a 36s budget to 12s when
  // sleeps moved onto the smaller multiplier, which is the wrong direction
  // for the one wait in this file that exists because CI is slow.
  await page.waitForFunction(
    () => !!document.querySelector('.badge-fps')?.textContent,
    undefined,
    { timeout: scaled(6000), polling: 300 },
  ).catch(() => errors.push('fps badge never populated'));
  await sleep(500); // margin past first frame for the rest of boot's synchronous setup (incl. the keydown listener) to land

  await page.keyboard.down('d');
  await sleep(600);
  await page.keyboard.up('d');
  await sleep(150); // let the idle-exit frame land so no further calls trickle in

  const posCalls = await page.evaluate(() => window.__uniformCalls.filter((c) => 'uCharPosX' in c).map((c) => c.uCharPosX));
  check('(a) holding d produced multiple uCharPosX writes', posCalls.length >= 2, 'got ' + posCalls.length);
  const strictlyIncreasing = posCalls.every((v, i) => i === 0 || v > posCalls[i - 1]);
  check('(a) uCharPosX strictly increases across those writes', strictlyIncreasing, JSON.stringify(posCalls));
  check('(a) uCharPosX ends up positive (moved in +x)', posCalls.length > 0 && posCalls[posCalls.length - 1] > 0, JSON.stringify(posCalls));

  check('(a) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (b) no movement while a tune-slider or the mini-editor has focus ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await armSpies(page);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors);
  await page.bringToFront(); // real headed browser: keyboard input needs the window focused

  // Bouncing Figure sits at the same screen-point oracle every other garden
  // test uses (character center-frame regardless of iTime) and has two
  // @tune sliders (BOUNCE_HEIGHT, BOUNCE_SPEED) — real production UI, not a
  // synthetic input planted for this test.
  await page.mouse.click(720, 380);
  await sleep(300);
  const opened = await page.$eval('.probe-title', (el) => el.textContent).catch(() => null);
  check('(b) opened the Bouncing Figure panel (has @tune sliders)', opened === 'Bouncing Figure', 'got ' + opened);

  await page.focus('.probe-tune-range');
  await page.evaluate(() => { window.__uniformCalls.length = 0; }); // ignore panel-open noise, isolate the held-key window

  await page.keyboard.down('d');
  await sleep(500);
  await page.keyboard.up('d');
  await sleep(150);

  const movedWhileFocused = await page.evaluate(() => window.__uniformCalls.some((c) => 'uCharPosX' in c || 'uCharPosZ' in c));
  check('(b) no uCharPos writes while a tune slider has focus', !movedWhileFocused);

  // Range input's own native behavior isn't blocked (only our listener's
  // preventDefault is skipped) — confirm the guard is the reason nothing
  // moved, not some unrelated breakage: focus a plain control-free spot
  // (blur back to body) and confirm the SAME key now does move the figure.
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => { window.__uniformCalls.length = 0; });
  await page.keyboard.down('d');
  await sleep(500);
  await page.keyboard.up('d');
  await sleep(150);
  const movedAfterBlur = await page.evaluate(() => window.__uniformCalls.some((c) => 'uCharPosX' in c));
  check('(b) the same key DOES move the figure once focus leaves the slider (guard is the cause, not a stuck listener)', movedAfterBlur);

  check('(b) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (c) play-radius clamp holds ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await armSpies(page);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors);
  await page.click('.garden-canvas');
  await page.bringToFront(); // real headed browser: keyboard input needs the window focused

  // PLAY_RADIUS=3.2, MOVE_SPEED=1.8 units/s (index.js) — crossing the radius
  // in one axis takes ~1.8s of real hold time; 4s gives ample margin even
  // under headless SwiftShader's slower/irregular frame cadence (position
  // integration uses real elapsed dt, so total distance only depends on
  // wall-clock hold time, not frame rate).
  await page.keyboard.down('d');
  await sleep(4000);
  await page.keyboard.up('d');
  await sleep(150);

  const calls = await page.evaluate(() => window.__uniformCalls.filter((c) => 'uCharPosX' in c));
  const last = calls[calls.length - 1];
  check('(c) the clamp produced at least one uCharPosX write', !!last, 'calls=' + calls.length);
  if (last) {
    const dist = Math.hypot(last.uCharPosX ?? 0, last.uCharPosZ ?? 0);
    check('(c) final distance from origin is at (not past) the 3.2 play radius', dist <= 3.21 && dist >= 3.1, 'dist=' + dist);
  }

  check('(c) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (d) touch joystick writes through the same uniform path ---------- */
{
  const errors = [];
  // Real touch/mobile emulation, not a bypass: setViewport({isMobile,
  // hasTouch}) flips matchMedia('(pointer: coarse)') in this headless
  // Chrome (verified directly before writing this test) — joystick.js's own
  // production gate decides to build the nub, exactly as a real phone would
  // trip it. No test-only hook was added to joystick.js for this.
  const page = await freshPage(errors, { width: 400, height: 700, isMobile: true, hasTouch: true });
  await armSpies(page);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors);

  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  check('(d) coarse-pointer emulation actually took effect', coarse);

  const nub = await page.waitForSelector('.garden-joystick', { timeout: 4000 }).catch(() => null);
  check('(d) the joystick nub is built under coarse-pointer emulation', !!nub);
  if (nub) {
    const box = await nub.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.evaluate(() => { window.__uniformCalls.length = 0; });

    // Pointer events (mouse-typed, since headless Chrome has no real
    // touchscreen) — joystick.js listens for pointerdown/move/up, which
    // PointerEvent unifies with touch on a real device; this drives the
    // exact same listeners a finger drag would.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 30, cy - 10, { steps: 5 }); // drag toward +x, slightly -z
    await sleep(120);
    await page.mouse.up();
    await sleep(150);

    const posCalls = await page.evaluate(() => window.__uniformCalls.filter((c) => 'uCharPosX' in c || 'uCharPosZ' in c));
    check('(d) dragging the joystick produced uCharPos writes through setUniforms (same path as keyboard)', posCalls.length >= 1, 'got ' + posCalls.length);
    const grewPositiveX = posCalls.some((c) => (c.uCharPosX ?? 0) > 0);
    check('(d) the drag direction (+x) is reflected in uCharPosX', grewPositiveX, JSON.stringify(posCalls));
  }

  check('(d) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (e) desktop (non-coarse) never builds the joystick ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors);
  const nub = await page.$('.garden-joystick');
  check('(e) no joystick DOM on a regular (fine-pointer) desktop viewport', nub === null);
  check('(e) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (f) wave-4 §A: uCharGaitDist monotonic while held, frozen after release ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await armSpies(page);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors);
  await page.bringToFront(); // real headed browser: keyboard input needs the window focused

  await page.keyboard.down('d');
  await sleep(600);
  await page.keyboard.up('d');
  await sleep(150); // idle-exit window, same as (a)

  const gaitCalls = await page.evaluate(() => window.__uniformCalls.filter((c) => 'uCharGaitDist' in c).map((c) => c.uCharGaitDist));
  check('(f) holding a direction produced multiple uCharGaitDist writes', gaitCalls.length >= 2, 'got ' + gaitCalls.length);
  const nonDecreasing = gaitCalls.every((v, i) => i === 0 || v >= gaitCalls[i - 1]);
  check('(f) uCharGaitDist is monotonically non-decreasing while held', nonDecreasing, JSON.stringify(gaitCalls));

  await page.evaluate(() => { window.__uniformCalls.length = 0; }); // isolate the post-release window
  await sleep(400); // outlives the idle-exit frame with margin
  const afterRelease = await page.evaluate(() => window.__uniformCalls.filter((c) => 'uCharGaitDist' in c).map((c) => c.uCharGaitDist));
  check('(f) uCharGaitDist stops advancing once released (frozen, no further writes)', afterRelease.length === 0, JSON.stringify(afterRelease));

  check('(f) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (g) wave-4 §A: uCharYaw never snaps across a 180-degree reversal ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await page.evaluateOnNewDocument(() => {
    window.__yawCalls = [];
    // Record the rAF timestamp the integrator is ACTUALLY handed, not the
    // wall clock at the moment it happens to call setUniforms. moveFrame(t)
    // (garden/index.js) computes `dt = t - moveLastT` from the timestamp rAF
    // passes it; performance.now() inside setUniforms is that same frame plus
    // however long the callback has been running. On a real GPU those agree
    // to within noise. Under SwiftShader they do not: the callback-start-to-
    // setUniforms offset swings by tens of ms frame to frame, so a pair whose
    // rAF dt was 40ms can look like 12ms of wall clock — and the check then
    // fails a turn the integrator itself had already clamped to TURN_RATE*dt.
    // Measured overshoots of 0.006-0.072 rad reproduced locally only once
    // SwiftShader was actually forced (SG_EXTRA_CHROME_ARGS); the integrator
    // is correct, the yardstick was not.
    window.__lastRafT = 0;
    const rawRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => rawRaf((t) => { window.__lastRafT = t; return cb(t); });
    const hook = (mod, className) => {
      const orig = mod[className].prototype.setUniforms;
      mod[className].prototype.setUniforms = function (values) {
        if ('uCharYaw' in values) window.__yawCalls.push({ yaw: values.uCharYaw, t: window.__lastRafT });
        return orig.call(this, values);
      };
    };
    import('./js/runtime/webgl2.js').then((mod) => hook(mod, 'GL2Runtime')).catch(() => {});
    import('./js/runtime/webgpu.js').then((mod) => hook(mod, 'GPURuntime')).catch(() => {});
  });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await awaitGardenCanvas(page, errors);
  await page.bringToFront(); // real headed browser: keyboard input needs the window focused

  // Face +X, then reverse straight to -X — a 180-degree heading flip across
  // one input transition. Both phases (and the transition between them) land
  // in the SAME __yawCalls array, checked as one continuous sequence below.
  await page.keyboard.down('d');
  await sleep(500);
  await page.keyboard.up('d');
  await sleep(200); // idle-exit gap — no calls land here, see the dt note below
  await page.keyboard.down('a');
  await sleep(500);
  await page.keyboard.up('a');
  await sleep(150);

  const yawCalls = await page.evaluate(() => window.__yawCalls);
  check('(g) the session produced multiple uCharYaw writes', yawCalls.length >= 4, 'got ' + yawCalls.length);
  // TURN_RATE = 10 rad/s (index.js). Consecutive PUSHED calls are almost
  // always one real animation frame apart, EXCEPT across the idle-exit gap
  // above (no calls land during it) — that pair's dt is correspondingly
  // large, so its bound scales up too; it can never falsely trip this check,
  // it just isn't a meaningful sample. 25% slack over the theoretical
  // per-frame bound for rAF jitter/GC pauses under headless SwiftShader,
  // the same generosity this repo's own PERF harnesses give real-GPU timing.
  const TURN_RATE = 10, SLACK = 1.25;
  let worstOvershoot = 0;
  for (let i = 1; i < yawCalls.length; i++) {
    const dt = (yawCalls[i].t - yawCalls[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const delta = Math.abs(yawCalls[i].yaw - yawCalls[i - 1].yaw);
    worstOvershoot = Math.max(worstOvershoot, delta - TURN_RATE * dt * SLACK);
  }
  check('(g) uCharYaw never jumps more than TURN_RATE*dt in a single frame (no instant snap)',
    worstOvershoot <= 0, `worst overshoot=${worstOvershoot.toFixed(4)} rad`);

  check('(g) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
