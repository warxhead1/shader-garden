// COMP-1 acceptance: composition manifest + viewer playback + provenance
// graph (v2 blueprint §7.3 item 24, rulings C11/C12). Usage:
// node tools/test/comp1.mjs (npm ci in tools/test first).
//
// 1) validateComposition() unit tests, pure Node (no browser): self-feedback
//    is the one legal cycle (positive control), a crafted two-pass cycle is
//    rejected as SG-S08, plus the structural checks (exactly one screen
//    target, no dangling channel reference, undeclared self-read rejected).
// 2) Headless GL2: the shipped demo composition (#/s/hills-into-icefield)
//    renders — canvas present, WebGL2 badge, no console errors.
// 3) Gallery: a composition card renders (chip + pass-count badge), href
//    resolves to the composition's own #/s/:id.
// 4) Provenance: the pass graph renders one node per pass, each node's link
//    resolves — clicking through to #/s/biome-rolling-hills renders that
//    kernel's own single-kernel provenance (its "own lineage").
// 5) Deleting assets/compositions/ wholesale leaves the site green: gallery
//    renders kernel-only (no composition cards, no console errors) and the
//    composition's own deep link falls back to the "not found" notice
//    instead of crashing.
import { readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launch, serveSite, sleep, SITE_ROOT, gotoSafe, assertRealGpu, assertRealWebgl2 } from './browser.mjs';
import { validateComposition } from '../../site/js/runtime/composition-graph.js';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

/* ---------- 1) validateComposition() unit tests ---------- */

{
  const demo = JSON.parse(readFileSync(path.join(SITE_ROOT, 'assets/compositions/hills-into-icefield.json'), 'utf8'));
  const r = validateComposition(demo.passes);
  check('(1) the shipped demo composition passes DAG validation', !r.reject, JSON.stringify(r.findings));
  check('(1) topological order places the screen pass last', demo.passes[r.order[r.order.length - 1]].target === 'screen', JSON.stringify(r.order));
}

{
  // Self-feedback: legal ONLY when declared (positive control, C12).
  const r = validateComposition([{ kernel: 'a', target: 'buf', channels: ['buf'], feedback: true }, { kernel: 'b', target: 'screen', channels: ['buf'] }]);
  check('(1) declared self-feedback is legal (C12)', !r.reject, JSON.stringify(r.findings));
}

{
  // Undeclared self-read: same shape, missing feedback:true — rejected.
  const r = validateComposition([{ kernel: 'a', target: 'buf', channels: ['buf'] }, { kernel: 'b', target: 'screen', channels: ['buf'] }]);
  check('(1) undeclared self-read (no feedback:true) is rejected', r.reject && r.findings.some((f) => f.includes('SG-S08')), JSON.stringify(r.findings));
}

{
  // A crafted arbitrary two-pass cycle (A reads B, B reads A) — the actual
  // "SG-S08 rejects a crafted cyclic manifest" acceptance criterion.
  const cyclic = [
    { kernel: 'a', target: 'bufA', channels: ['bufB'] },
    { kernel: 'b', target: 'bufB', channels: ['bufA'] },
    { kernel: 'c', target: 'screen', channels: ['bufA'] },
  ];
  const r = validateComposition(cyclic);
  check('(1) a crafted arbitrary cycle is rejected', r.reject, JSON.stringify(r.findings));
  check('(1) the rejection names SG-S08', r.findings.some((f) => f.startsWith('SG-S08')), JSON.stringify(r.findings));
}

{
  const noScreen = validateComposition([{ kernel: 'a', target: 'bufA' }]);
  check('(1) a composition with no "screen" target is rejected', noScreen.reject, JSON.stringify(noScreen.findings));

  const twoScreens = validateComposition([{ kernel: 'a', target: 'screen' }, { kernel: 'b', target: 'screen' }]);
  check('(1) a composition with two "screen" targets is rejected', twoScreens.reject, JSON.stringify(twoScreens.findings));

  const dangling = validateComposition([{ kernel: 'a', target: 'screen', channels: ['nope'] }]);
  check('(1) a channel referencing an unknown target is rejected', dangling.reject, JSON.stringify(dangling.findings));

  const screenAsChannel = validateComposition([{ kernel: 'a', target: 'bufA' }, { kernel: 'b', target: 'screen', channels: ['screen'] }]);
  check('(1) "screen" is not a valid channel source', screenAsChannel.reject, JSON.stringify(screenAsChannel.findings));
}

/* ---------- browser-driven checks ---------- */

const { server, base: BASE } = await serveSite();
// The composition player (site/js/organs/viewer/composition-player.js) is
// hard-wired to raw WebGL2 — it never goes through runtime-host's `prefer`
// knob at all, so this whole file is decision-rule bullet 1: about WebGL2
// semantics, stays pinned regardless of the site-wide WebGPU default.
const browser = await launch();

// (2) headless GL2 playback of the shipped demo composition
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html#/s/hills-into-icefield`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  // assertRealGpu proves the WebGPU adapter is real; this suite's actual
  // rendering is WebGL2 (composition-player is hard-wired to it), a
  // separate ANGLE/driver path with no software-adapter protection of its
  // own, so pin that down too.
  await assertRealGpu(page);
  await assertRealWebgl2(page);
  await page.waitForSelector('.viewer-canvas', { timeout: 8000 }).catch(() => {});
  await sleep(1500);

  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length).catch(() => -1);
  check('(2) composition deep link renders exactly one canvas', canvases === 1, 'canvases=' + canvases);
  const badge = await page.$eval('.badge-backend', (el) => el.textContent.trim()).catch(() => null);
  check('(2) composition deep link shows the correct backend badge (WebGL2, headless)', badge === 'WebGL2', 'badge=' + badge);
  check('(2) no console errors playing the composition', errors.length === 0, errors.join(' | '));

  // Pixel-correctness of the SAME graph, via a synchronous (non-rAF) draw —
  // comp0.mjs's own technique, applied to the shipped demo's real kernel
  // sources and validateComposition()'s real topological order. A single
  // synchronous frame sidesteps the getContext() quirk above entirely (no
  // requestAnimationFrame tick has happened yet), giving a reliable oracle
  // for "does this composition's exact pass graph draw non-black pixels".
  const px = await page.evaluate(async () => {
    const comp = await fetch('assets/compositions/hills-into-icefield.json').then((r) => r.json());
    const kernels = await fetch('assets/kernels.json').then((r) => r.json());
    const { validateComposition } = await import('./js/runtime/composition-graph.js');
    const { wrapGlsl } = await import('./js/runtime/wrap.js');
    const { order } = validateComposition(comp.passes);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const gl = canvas.getContext('webgl2');
    const vert = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vert, '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}');
    gl.compileShader(vert);
    const targets = {};
    for (const def of comp.passes) {
      if (def.target !== 'screen' && !targets[def.target]) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 128, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        targets[def.target] = { tex, fbo };
      }
    }
    const vao = gl.createVertexArray();
    let lastPixel = null;
    for (const i of order) {
      const def = comp.passes[i];
      const channels = (def.channels || []).length;
      const src = kernels.kernels.find((k) => k.id === def.kernel).glsl;
      const frag = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(frag, wrapGlsl(src, channels));
      gl.compileShader(frag);
      const program = gl.createProgram();
      gl.attachShader(program, vert);
      gl.attachShader(program, frag);
      gl.linkProgram(program);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform3f(gl.getUniformLocation(program, 'iResolution'), 128, 128, 1);
      gl.uniform1f(gl.getUniformLocation(program, 'iTime'), 1.0);
      gl.uniform1f(gl.getUniformLocation(program, 'iTimeDelta'), 0.016);
      gl.uniform1i(gl.getUniformLocation(program, 'iFrame'), 5);
      gl.uniform4f(gl.getUniformLocation(program, 'iMouse'), 0, 0, 0, 0);
      (def.channels || []).forEach((name, c) => {
        gl.activeTexture(gl.TEXTURE0 + c);
        gl.bindTexture(gl.TEXTURE_2D, targets[name].tex);
        gl.uniform1i(gl.getUniformLocation(program, 'iChannel' + c), c);
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, def.target === 'screen' ? null : targets[def.target].fbo);
      gl.viewport(0, 0, 128, 128);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (def.target === 'screen') {
        const buf = new Uint8Array(4);
        let hits = 0;
        for (let y = 0; y < 128; y += 16) {
          for (let x = 0; x < 128; x += 16) {
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            if (buf[0] || buf[1] || buf[2]) hits++;
          }
        }
        lastPixel = hits;
      }
    }
    return lastPixel;
  });
  check('(2) the exact shipped composition graph draws non-black screen output (synchronous oracle)', px > 0, 'nonBlackSamples=' + px);

  // NOT verified here: pixel content of the live, rAF-animated canvas via a
  // second, out-of-band getContext() call. Under this headless Chrome +
  // SwiftShader sandbox, ANY second getContext('webgl2', ...) on a canvas
  // that has already gone through one real requestAnimationFrame tick comes
  // back reporting isContextLost()===true, independent of composition-player
  // (reproduced identically probing the plain single-kernel viewer's own
  // rAF-driven canvas — smoke.mjs never attempts this for exactly that
  // reason, only DOM/badge/console-error checks on rAF-animated canvases).
  // The render pipeline's actual pixel correctness IS verified: (a) COMP-0's
  // own comp0.mjs exercises the identical createTarget/renderTo/setChannels
  // primitives this player calls, via a synchronous (non-rAF) harness where
  // the second-getContext quirk doesn't trigger; (b) instrumented manual runs
  // during development confirmed this exact composition draws correct
  // non-black output on every frame for 90+ consecutive frames via readbacks
  // taken from INSIDE the same rAF callback (no second getContext hop).
  await page.close();
}

// (3) gallery: a composition card renders with the right chrome
{
  const page = await browser.newPage();
  // .catch: a transient nav timeout must FAIL the checks below (card=null),
  // not crash the whole script — same guard every sibling goto carries.
  await gotoSafe(page, `${BASE}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await page.waitForSelector('.card-composition', { timeout: 8000 }).catch(() => {});
  const card = await page.evaluate(() => {
    const a = document.querySelector('.card-composition');
    if (!a) return null;
    return {
      href: a.getAttribute('href'),
      chip: a.querySelector('.chip')?.textContent,
      passes: a.querySelector('.badge-passes')?.textContent,
    };
  });
  check('(3) a composition gallery card renders', !!card, JSON.stringify(card));
  check('(3) card links to the composition\'s own #/s/:id', card && card.href === '#/s/hills-into-icefield', JSON.stringify(card));
  check('(3) card is tagged "composition"', card && card.chip === 'composition', JSON.stringify(card));
  check('(3) card shows the pass count', card && card.passes === '2 passes', JSON.stringify(card));
  await page.close();
}

// (4) provenance: the pass graph renders, every node link resolves
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${BASE}/index.html#/s/hills-into-icefield`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.meta-graph', { timeout: 8000 }).catch(() => {});
  await sleep(300);

  const nodes = await page.$$eval('.meta-graph-node', (items) => items.map((li) => ({
    kernel: li.querySelector('.meta-graph-link')?.textContent,
    href: li.querySelector('.meta-graph-link')?.getAttribute('href'),
    detail: li.querySelector('.meta-graph-detail')?.textContent,
  })));
  check('(4) provenance renders one node per pass', nodes.length === 2, JSON.stringify(nodes));
  check('(4) node 0 names its kernel and target', nodes[0]?.kernel === 'biome-rolling-hills' && nodes[0]?.detail.includes('bufferA'), JSON.stringify(nodes));
  check('(4) node 1 names the screen target and its channel source', nodes[1]?.kernel === 'biome-mountain-peaks' && nodes[1]?.detail.includes('screen') && nodes[1]?.detail.includes('bufferA'), JSON.stringify(nodes));
  check('(4) every node link points at #/s/<kernel>', nodes.every((n) => n.href === '#/s/' + encodeURIComponent(n.kernel)), JSON.stringify(nodes));

  // Follow the first node's link — it must resolve to that kernel's OWN
  // single-kernel provenance (its "own lineage"), not another graph.
  await page.click('.meta-graph-link');
  await page.waitForSelector('.meta-list', { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const landed = await page.evaluate(() => location.hash);
  check('(4) the node link navigated to the kernel\'s own page', landed === '#/s/biome-rolling-hills', 'hash=' + landed);
  const kernelTitle = await page.$eval('.meta-title', (el) => el.textContent).catch(() => null);
  check('(4) that page shows the kernel\'s own provenance panel (title, not a graph)', kernelTitle && kernelTitle.includes('Rolling Hills'), 'title=' + kernelTitle);
  const stillHasGraph = await page.$('.meta-graph');
  check('(4) the kernel\'s own page renders the single-kernel panel, not a pass graph', stillHasGraph === null);
  check('(4) no console errors following a graph-node link', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.kill();

// (5) deleting assets/compositions/ wholesale leaves the site green
{
  const tmp = mkdtempSync(path.join(tmpdir(), 'sg-nocomp-'));
  cpSync(SITE_ROOT, tmp, { recursive: true });
  rmSync(path.join(tmp, 'assets', 'compositions'), { recursive: true, force: true });

  const { server: s2, base: base2 } = await serveSite(tmp);
  const b2 = await launch();

  // The 404s for assets/compositions/index.json ARE the point of this test —
  // registry.js's loadCompositions() catches them and resolves []; Chrome
  // itself still logs the failed network request as a console error
  // (identical pattern to smoke.mjs's cm-editor.bundle.js-absent filter).
  const isExpected404 = (text, url) => (url || '').includes('/assets/compositions/') || text.includes('assets/compositions/');

  const page = await b2.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !isExpected404(m.text(), m.location().url)) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoSafe(page, `${base2}/index.html#/`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors.push('NAV: ' + e.message));
  await page.waitForSelector('.card', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const hasCompositionCard = await page.$('.card-composition');
  check('(5) with assets/compositions/ deleted, no composition card renders', hasCompositionCard === null);
  const kernelCards = await page.$$eval('.card', (els) => els.length);
  check('(5) kernel cards still render normally', kernelCards > 0, 'count=' + kernelCards);
  check('(5) no unexpected console errors on the gallery with compositions/ absent', errors.length === 0, errors.join(' | '));

  const page2 = await b2.newPage();
  const errors2 = [];
  page2.on('console', (m) => { if (m.type() === 'error' && !isExpected404(m.text(), m.location().url)) errors2.push(m.text()); });
  page2.on('pageerror', (e) => errors2.push(String(e)));
  await gotoSafe(page2, `${base2}/index.html#/s/hills-into-icefield`, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => errors2.push('NAV: ' + e.message));
  await sleep(500);
  const notice = await page2.$eval('.center-notice', (el) => el.textContent).catch(() => null);
  check('(5) the composition\'s own deep link falls back to a not-found notice, not a crash', !!notice, notice);
  check('(5) no unexpected console errors on the fallback notice', errors2.length === 0, errors2.join(' | '));

  await page.close();
  await page2.close();
  await b2.close();
  s2.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
