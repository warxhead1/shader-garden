// Shader Garden — organs/viewer/index.js
// "/s/:id" organ (v2 substrate SUB-3). Extraction of app.js's mountViewer.
// Runtime lifecycle (WebGPU->WebGL2 ladder, context-loss rebuild) now
// delegates to core/runtime-host.js (P1/P6); this file keeps only the
// domain-specific parts: kernel resolution, chrome, and shader.compiled.v1
// (needs shader_id/language, which runtimeHost has no reason to know). The
// metadata/collapse panel that used to live here moved to
// organs/provenance/index.js (v2 substrate SUB-4) — it docks into
// #region-side via assets/layout.json's placements, driven by this organ's
// own kernel.opened.v1 emit below, not a direct call.
//
// COMP-1: "/s/:id" also resolves composition ids (assets/compositions/) —
// same route, same region, a different playback path (composition-player.js,
// dynamic-imported so a plain kernel visit fetches none of it). A composition
// id and a kernel id share one namespace; the demo composition's id is
// deliberately distinct from every kernel id shipped today.

import { centerNotice } from '../../core/loader.js';
import { runtimeHost } from '../../core/runtime-host.js';
import { el, clear } from '../../dom.js';
import { copyText, toast } from '../../share.js';

// "Copy embed code" (SEED-3, V2_BLUEPRINT item 20): a working <shader-seed>
// snippet for the CURRENT kernel. seed@1.js and every per-kernel JSON are
// baked side-by-side into site/assets/seed/ (not site/embed/ — see
// ARCHITECTURE.md's seed embed section), so the module URL below is all a
// host needs; no `garden` attribute required on the canonical deployment.
function embedSnippet(kernelId) {
  const root = location.href.split('#')[0];
  const seedUrl = new URL('assets/seed/seed@1.js', root).href;
  return (
    '<script type="module" src="' + seedUrl + '"></' + 'script>\n' +
    '<shader-seed kernel="' + kernelId + '"></shader-seed>'
  );
}

async function mountComposition(ctx, composition, data) {
  const { root, bus } = ctx;
  const { validateComposition } = await import('../../runtime/composition-graph.js');
  const { reject, findings, order } = validateComposition(composition.passes);

  const stage = el('div', 'viewer-stage');
  const topbar = el('div', 'viewer-topbar');
  const backLink = el('a', 'btn btn-small btn-ghost', '← garden');
  backLink.setAttribute('href', '#/');
  const backendBadge = el('span', 'badge badge-backend', '…');
  const copyBtn = el('button', 'btn btn-small', 'Copy link');
  copyBtn.type = 'button';
  topbar.append(backLink, backendBadge, el('div', 'toolbar-spacer'), copyBtn);
  root.append(stage, topbar);

  if (reject) {
    backendBadge.textContent = 'invalid';
    const notice = centerNotice('This composition failed graph validation: ' + findings.join('; '));
    stage.append(notice);
    return function cleanup() { stage.remove(); topbar.remove(); };
  }

  const kernelSrc = new Map();
  for (const p of composition.passes) {
    const k = data.kernels.find((kk) => kk.id === p.kernel);
    kernelSrc.set(p.kernel, k ? k.glsl : '');
  }

  bus.emit('composition.opened.v1', {
    shader_id: composition.id,
    title: composition.title || null,
    description: composition.description || null,
    passes: composition.passes,
    provenance: composition.provenance || null, // COMP-3: oracle fitness block, if baked
    route: '/s/' + composition.id,
  });

  if (!ctx.alive()) return () => { stage.remove(); topbar.remove(); };

  const { mountComposition: playComposition } = await import('./composition-player.js');
  const player = playComposition(stage, { composition, order, kernelSrc, bus });
  backendBadge.textContent = player.backend === 'webgl2' ? 'WebGL2' : 'no GPU';
  if (!player.backend) stage.append(centerNotice('WebGL2 is not available in this browser.'));

  copyBtn.addEventListener('click', async () => {
    const url = location.href.split('#')[0] + '#/s/' + encodeURIComponent(composition.id);
    const ok = await copyText(url);
    if (!ok) console.warn('Link:', url);
    toast(ok ? 'Link copied to clipboard' : 'Could not copy — see console');
  });

  return function cleanup() {
    player.dispose();
    stage.remove();
    topbar.remove();
  };
}

export async function mount(ctx) {
  const { root, bus } = ctx;
  const id = ctx.params.get('id');
  clear(root);

  // Cleanups below remove ONLY the nodes this mount appended — never clear(root):
  // a superseded mount's late cleanup must not wipe a newer mount's DOM out of
  // the shared viewer root (rapid viewer-to-viewer navigation).
  let data = null;
  try {
    data = await ctx.registry.load();
  } catch {
    const notice = centerNotice('Could not load kernels.json — the garden is unreachable right now.');
    root.append(notice);
    return () => notice.remove();
  }
  // A nav-away during the load above is invisible to the loader until this
  // mount() call returns (loader mid-mount staleness gap) — bail before
  // starting the runtime ladder for a route nobody's looking at anymore.
  if (!ctx.alive()) return () => {};

  const kernel = data.kernels.find((k) => k.id === id);
  if (!kernel) {
    const composition = (data.compositions || []).find((c) => c.id === id);
    if (composition) return mountComposition(ctx, composition, data);
    const notice = centerNotice('No kernel or composition with id "' + id + '" grows in this garden.');
    root.append(notice);
    return () => notice.remove();
  }

  bus.emit('kernel.opened.v1', {
    shader_id: kernel.id,
    title: kernel.title || null,
    origin: kernel.origin || null,
    fitness: kernel.fitness != null ? kernel.fitness : null,
    generation: kernel.generation != null ? kernel.generation : null,
    run_id: kernel.run_id || null,
    route: '/s/' + kernel.id,
  });

  /* ---- stage + chrome ---- */
  const stage = el('div', 'viewer-stage');

  const topbar = el('div', 'viewer-topbar');
  const backLink = el('a', 'btn btn-small btn-ghost', '← garden');
  backLink.setAttribute('href', '#/');
  const backendBadge = el('span', 'badge badge-backend', '…');
  const fpsBadge = el('span', 'badge badge-fps', '');
  const resetBtn = el('button', 'btn btn-small', 'Reset time');
  const editLink = el('a', 'btn btn-small', 'Open in editor');
  editLink.setAttribute('href', '#/edit?k=' + encodeURIComponent(kernel.id));
  const embedBtn = el('button', 'btn btn-small', 'Copy embed code');
  const copyBtn = el('button', 'btn btn-small', 'Copy link');
  resetBtn.type = embedBtn.type = copyBtn.type = 'button';
  topbar.append(backLink, backendBadge, fpsBadge, el('div', 'toolbar-spacer'), resetBtn, editLink, embedBtn, copyBtn);

  root.append(stage, topbar);

  /* ---- runtime: WGSL ladder + lifecycle owned by runtimeHost ---- */
  // Fetched once per mount (not re-fetched on Reset — runtimeHost.rebuild()
  // reuses this opts object; a static asset never changes mid-session).
  let wgslSrc;
  const wgslPath = data.wgsl[kernel.id];
  if (wgslPath && typeof wgslPath === 'string') {
    try {
      const wres = await fetch(wgslPath);
      if (wres.ok) wgslSrc = await wres.text();
    } catch { /* fetch failed — silent fallback to WebGL2, v1 rule */ }
  }

  function onBuild() {
    if (!rh) return; // fires once synchronously during the initial build, before rh is assigned
    backendBadge.textContent = rh.backend === 'webgpu' ? 'WebGPU' : rh.backend === 'webgl2' ? 'WebGL2' : 'no GPU';
    // stage was just cleared by runtimeHost's build() (host.replaceChildren())
    // before this fired — no stale error/notice from a prior build to remove.
    if (!rh.backend) {
      stage.append(centerNotice('Neither WebGPU nor WebGL2 is available in this browser.'));
      return;
    }
    bus.emit('shader.compiled.v1', {
      shader_id: kernel.id,
      language: rh.backend === 'webgpu' ? 'wgsl' : 'glsl',
      ok: rh.ok,
      log_excerpt: rh.log ? rh.log.slice(0, 200) : null,
      duration_ms: rh.duration_ms,
      backend: rh.backend,
    });
    if (!rh.ok) {
      const err = el('pre', 'error-log viewer-error', rh.log || 'shader compile failed');
      stage.append(err);
    }
  }

  // Split declaration from assignment: onChange fires synchronously inside
  // the initial build, before the `= await runtimeHost(...)` expression
  // itself resolves — `rh` must already be a (still-undefined) binding.
  let rh;
  rh = await runtimeHost(stage, {
    prefer: 'auto', glslSrc: kernel.glsl, wgslSrc, canvasClass: 'viewer-canvas',
    fpsBadge, onLost: 'rebuild', bus, organ: 'viewer', onChange: onBuild,
  });
  onBuild(); // paint the state the in-flight onChange() couldn't see rh for yet

  resetBtn.addEventListener('click', () => { rh.rebuild(); });
  embedBtn.addEventListener('click', async () => {
    const ok = await copyText(embedSnippet(kernel.id));
    if (!ok) console.warn('Embed snippet:', embedSnippet(kernel.id));
    toast(ok ? 'Embed code copied to clipboard' : 'Could not copy — see console');
  });
  copyBtn.addEventListener('click', async () => {
    const url = location.href.split('#')[0] + '#/s/' + encodeURIComponent(kernel.id);
    const ok = await copyText(url);
    if (!ok) console.warn('Link:', url);
    toast(ok ? 'Link copied to clipboard' : 'Could not copy — see console');
  });

  return function cleanup() {
    rh.dispose();
    // Remove only this mount's nodes — a newer mount may already own the root.
    stage.remove();
    topbar.remove();
  };
}
