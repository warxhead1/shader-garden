// Shader Garden — wave-4 Area D acceptance tests: the live uniform-bank
// inspector (D1) + getCustomUniforms() snapshot isolation, plus the
// provenance multi-pass mechanism explainer (D3), gated correctly.
// Usage: node tools/test/garden-uniform-inspector.mjs (npm ci in tools/test first)
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

/* ---------- (1) the inspector shows live-updating values ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.garden-uniform-inspector', { timeout: 8000 }).catch(() => errors.push('no garden-uniform-inspector'));

  check('(1) inspector starts collapsed', await page.evaluate(() => document.querySelector('.garden-uniform-inspector').hidden === true));
  await page.click('.garden-uniform-toggle');
  await page.waitForSelector('.garden-uniform-row', { timeout: 4000 }).catch(() => {});
  check('(1) toggling the topbar button opens it', await page.evaluate(() => document.querySelector('.garden-uniform-inspector').hidden === false));
  check('(1) it lists at least one engine uniform group', await page.evaluate(() => !!document.querySelector('.garden-uniform-group')));

  // Probe something with a @tune slider — terrain (component #2 in file
  // order, same ground truth garden-connections.mjs pins) has
  // TERRAIN_ROUGHNESS/TERRAIN_SCALE. Click the tray entry, drag its range
  // input, then confirm the inspector's OWN row for that name updates
  // within one 10 Hz tick (100ms poll).
  await page.click('.garden-tray-item:nth-child(2)');
  await page.waitForSelector('.probe-tune-range', { timeout: 4000 }).catch(() => {});
  const rangeName = await page.evaluate(() => document.querySelector('.probe-tune-range')?.dataset.name);
  check('(1) a tune slider is present to drive this check', !!rangeName, rangeName);

  if (rangeName) {
    const before = await page.evaluate((n) => document.querySelector(`.garden-uniform-row[data-name="${n}"] .garden-uniform-value`)?.textContent, rangeName);
    await page.evaluate((n) => {
      const input = document.querySelector('.probe-tune-range');
      const newVal = (Number(input.min) + Number(input.max)) / 2 + 0.01; // away from both bounds and the current value
      input.value = String(newVal);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, rangeName);
    await sleep(150); // one 10 Hz tick (100ms) plus slack
    const after = await page.evaluate((n) => document.querySelector(`.garden-uniform-row[data-name="${n}"] .garden-uniform-value`)?.textContent, rangeName);
    check('(1) the inspector\'s displayed value changes within one 10 Hz tick of a slider move', before !== after, `before=${before} after=${after}`);
  }

  // Mutual avoidance: both the inspector (top-right) and the probe panel
  // (bottom-right, open from the click above) dock to the same edge — the
  // CSS-only :has() offset in main.css must keep their rendered rects from
  // ever overlapping, not just "look fine in one screenshot."
  const overlap = await page.evaluate(() => {
    const a = document.querySelector('.garden-uniform-inspector').getBoundingClientRect();
    const b = document.querySelector('.probe-panel').getBoundingClientRect();
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  });
  check('(1) the uniform inspector and an open probe panel never visually overlap', !overlap);
  check('(1) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (2) getCustomUniforms() returns a snapshot, not a live reference ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));

  const gl2 = await page.evaluate(async () => {
    const mod = await import('./js/runtime/webgl2.js');
    const rt = new mod.GL2Runtime(document.createElement('canvas'));
    rt.setUniforms({ probe_test: 1 });
    const snap = rt.getCustomUniforms();
    snap.probe_test = -99999; // mutate the RETURNED object
    return { returnedIsolated: snap.probe_test === -99999, liveUnaffected: rt.getCustomUniforms().probe_test === 1 };
  }).catch((e) => ({ threw: e.message }));
  check('(2) GL2Runtime.getCustomUniforms() returns an isolated snapshot (mutating it never touches the live bank)',
    gl2.returnedIsolated && gl2.liveUnaffected, JSON.stringify(gl2));

  const webgpuAvailable = await page.evaluate(() => !!navigator.gpu);
  if (webgpuAvailable) {
    const gpu = await page.evaluate(async () => {
      const mod = await import('./js/runtime/webgpu.js');
      const rt = await mod.GPURuntime.create(document.createElement('canvas')).catch(() => null);
      if (!rt) return { skipped: 'no adapter available headless' };
      rt.setUniforms({ probe_test: 1 });
      const snap = rt.getCustomUniforms();
      snap.probe_test = -99999;
      return { returnedIsolated: snap.probe_test === -99999, liveUnaffected: rt.getCustomUniforms().probe_test === 1 };
    }).catch((e) => ({ threw: e.message }));
    check('(2) GPURuntime.getCustomUniforms() returns an isolated snapshot too', gpu.skipped || (gpu.returnedIsolated && gpu.liveUnaffected), JSON.stringify(gpu));
  } else {
    console.log('SKIP (2) WebGPU not available in this headless browser — GL2Runtime check above already covers the accessor contract');
  }
  check('(2) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- (3) provenance multi-pass explainer, gated on passes.length > 1 ---------- */
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/s/hills-into-icefield', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.meta-graph', { timeout: 8000 }).catch(() => {});
  const explainerText = await page.evaluate(() => document.querySelector('.meta-graph-explainer')?.textContent || null);
  check('(3) the 2-pass demo composition shows the mechanism explainer', explainerText && explainerText.includes('ordered passes'), explainerText);
  check('(3) no console errors on the composition view', errors.length === 0, errors.join(' | '));
  await page.close();
}
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/s/biome-rolling-hills', { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.meta-list', { timeout: 8000 }).catch(() => {});
  await sleep(200);
  check('(3) a single-kernel view never grows the explainer (no regression)', await page.evaluate(() => !document.querySelector('.meta-graph-explainer')));
  check('(3) no console errors on the single-kernel view', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
