// Screenshot capture for human review: every route plus the two admission
// states (scrim on a hostile share link, diagnostics on a broken shader).
// Usage: node tools/test/shots.mjs [out-dir]   (default tools/test/out)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launch, serveSite, sleep, gotoSafe } from './browser.mjs';

const out = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), 'out');
mkdirSync(out, { recursive: true });

const { server, base: BASE } = await serveSite();
const browser = await launch();

async function shot(route, name, extra) {
  const page = await browser.newPage();
  await gotoSafe(page, `${BASE}/index.html${route}`, { waitUntil: 'networkidle0', timeout: 20000 });
  await sleep(3000);
  if (extra) await extra(page);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name);
  await page.close();
}

await shot('#/', '1-gallery');
await shot('#/s/biome-rolling-hills', '2-viewer-rolling-hills');
await shot('#/edit?k=biome-rolling-hills', '3-editor-kernel');

// admission scrim: a share link that declares its own entry point (SG-S02)
{
  const page = await browser.newPage();
  await gotoSafe(page, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.code-editor', { timeout: 8000 });
  const link = await page.evaluate(async () => {
    const { compress, absoluteShareUrl } = await import('./js/share.js');
    const src = 'void main() { }\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(1.0); }';
    return absoluteShareUrl(await compress(src), 'glsl');
  });
  await gotoSafe(page, link, { waitUntil: 'networkidle0' });
  await sleep(1500);
  await page.screenshot({ path: `${out}/4-admission-scrim-vf.png` });
  console.log('shot 4-admission-scrim-vf');
  await page.close();
}

// diagnostics: user-typed broken shader -> line-mapped clickable list
{
  const page = await browser.newPage();
  await gotoSafe(page, `${BASE}/index.html#/edit`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.code-editor', { timeout: 8000 });
  await page.click('.code-editor', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('void mainImage(out vec4 c, in vec2 f) {\n  c = vec4(1.0)\n}', { delay: 2 });
  await sleep(1500);
  await page.screenshot({ path: `${out}/5-diagnostics-line-mapped.png` });
  console.log('shot 5-diagnostics-line-mapped');
  await page.close();
}

// GARDEN-0: the scene itself, then a probe panel open on the terrain
{
  const page = await browser.newPage();
  await gotoSafe(page, `${BASE}/index.html#/garden`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 });
  await sleep(2500);
  await page.screenshot({ path: `${out}/6-garden.png` });
  console.log('shot 6-garden');

  await page.mouse.click(720, 830); // center-bottom — terrain
  await sleep(400);
  await page.screenshot({ path: `${out}/7-garden-probe.png` });
  console.log('shot 7-garden-probe');
  await page.close();
}

await browser.close();
server.kill();
