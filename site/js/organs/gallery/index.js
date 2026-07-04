// Shader Garden — organs/gallery/index.js
// "/" organ (v2 substrate SUB-3). Extraction of app.js's mountHome +
// buildGallery + makeCard + galleryError. Hero lifecycle now delegates to
// core/runtime-host.js (P1); thumbs.js moves in beside this file, module-
// scope cache kept (see thumbs.js header).
//
// COMP-3 (v2 §7.3 item 26): every card gets `dataset.kind` ('kernel' or
// 'composition') and, for kernels, `dataset.channelSource` — a plain DOM
// filter over cards already in the grid (wireFilters()), no re-render, no
// route/query-param plumbing. The "channel-source" tag itself is written
// onto kernels.json by tools/bake_compositions.py, never guessed here.

import { runtimeHost } from '../../core/runtime-host.js';
import { thumb } from './thumbs.js';
import { el, clear } from '../../dom.js';

function fmtFitness(k) {
  if (k.fitness == null) return null;
  let s = 'fit ' + Number(k.fitness).toFixed(4);
  if (k.generation != null) s += ' · gen ' + k.generation;
  return s;
}

function domainClass(domain) {
  const safe = String(domain || 'demo').toLowerCase().replace(/[^a-z0-9]/g, '');
  return 'chip chip-' + (safe || 'demo');
}

// Built once per page-load: gallery-grid/-status live outside the organ's
// mount/cleanup cycle (static index.html markup, region shown/hidden by the
// loader, never removed) — re-mounting the gallery must not rebuild the grid.
let galleryBuilt = false;

function buildGallery(data) {
  if (galleryBuilt) return;
  galleryBuilt = true;
  const grid = document.getElementById('gallery-grid');
  const status = document.getElementById('gallery-status');
  clear(grid);
  status.hidden = true;

  const compositions = Array.isArray(data.compositions) ? data.compositions : [];
  if (!data.kernels.length && !compositions.length) {
    status.textContent = 'The garden is empty — no kernels baked yet.';
    status.hidden = false;
    return;
  }

  const kernelsById = new Map(data.kernels.map((k) => [k.id, k]));
  const frag = document.createDocumentFragment();
  for (const k of data.kernels) frag.append(makeCard(k, data.wgsl));
  for (const c of compositions) frag.append(makeCompositionCard(c, kernelsById));
  grid.append(frag);
  wireFilters();
}

// COMP-3: `data-filter` on #gallery-filters buttons drives visibility of
// already-rendered cards via their own `dataset.kind`/`dataset.channelSource`
// — filtering the DOM, not re-fetching or re-mounting. Wired once (guarded
// the same way buildGallery() itself is), so re-navigation to "/" never
// double-binds click handlers.
let filtersWired = false;
function wireFilters() {
  if (filtersWired) return;
  filtersWired = true;
  const bar = document.getElementById('gallery-filters');
  if (!bar) return;
  const grid = document.getElementById('gallery-grid');
  bar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.filter-btn');
    if (!btn) return;
    bar.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    const mode = btn.dataset.filter;
    grid.querySelectorAll('.card').forEach((card) => {
      const show = mode === 'all' ||
        (mode === 'composition' && card.dataset.kind === 'composition') ||
        (mode === 'channel-source' && card.dataset.channelSource === '1');
      card.classList.toggle('card-filtered-out', !show);
    });
  });
}

function makeCard(k, wgslManifest) {
  const a = el('a', 'card');
  a.dataset.kind = 'kernel'; // COMP-3: filter target
  a.setAttribute('href', '#/s/' + encodeURIComponent(k.id));
  a.setAttribute('aria-label', k.title || k.id);

  const thumbBox = el('div', 'thumb');
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  thumbBox.append(img);

  const body = el('div', 'card-body');
  const h = el('h3', 'card-title', k.title || k.id);
  const meta = el('div', 'card-meta');

  meta.append(el('span', domainClass(k.domain), String(k.domain || 'demo')));
  if (wgslManifest[k.id]) meta.append(el('span', 'badge badge-wgsl', 'WGSL'));
  const fit = fmtFitness(k);
  if (fit) meta.append(el('span', 'badge badge-fit', fit));
  // COMP-3: kernels tools/bake_compositions.py tagged usable-as-texture-source.
  if (Array.isArray(k.tags) && k.tags.includes('channel-source')) {
    a.dataset.channelSource = '1';
    meta.append(el('span', 'badge badge-channel-source', 'channel source'));
  }

  body.append(h, meta);
  a.append(thumbBox, body);
  thumb(img, k);
  return a;
}

// COMP-1: a composition card — same "/s/:id" link, a distinct chip, and a
// thumbnail proxied from its own "screen" pass kernel (thumbs.js renders one
// kernel per card; a true composited preview is future work, and rendering
// the screen pass alone is honest, not misleading, about what's shown).
function makeCompositionCard(comp, kernelsById) {
  const a = el('a', 'card card-composition');
  a.dataset.kind = 'composition'; // COMP-3: filter target
  a.setAttribute('href', '#/s/' + encodeURIComponent(comp.id));
  a.setAttribute('aria-label', comp.title || comp.id);

  const thumbBox = el('div', 'thumb');
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  thumbBox.append(img);

  const body = el('div', 'card-body');
  const h = el('h3', 'card-title', comp.title || comp.id);
  const meta = el('div', 'card-meta');
  meta.append(el('span', domainClass(comp.domain || 'composite'), 'composition'));
  meta.append(el('span', 'badge badge-passes', (comp.passes || []).length + ' passes'));

  body.append(h, meta);
  a.append(thumbBox, body);

  const finalPass = (comp.passes || []).find((p) => p.target === 'screen');
  const finalKernel = finalPass && kernelsById.get(finalPass.kernel);
  if (finalKernel) thumb(img, { id: comp.id, glsl: finalKernel.glsl });
  else thumbBox.classList.add('thumb-fallback');
  return a;
}

function galleryError() {
  const status = document.getElementById('gallery-status');
  const grid = document.getElementById('gallery-grid');
  clear(grid);
  status.textContent = 'Could not load the kernel gallery.';
  status.hidden = false;
  console.warn('[shader-garden] kernels.json fetch failed — if running locally, serve over HTTP: python3 -m http.server');
}

export async function mount(ctx) {
  let heroHandle = null;
  let visHandler = null;
  let disposed = false;

  try {
    const data = await ctx.registry.load();
    if (disposed) return () => {};
    buildGallery(data);

    // Quiet full-bleed hero background: a featured terrain biome (rotates per
    // visit), dimmed by CSS, paused whenever the tab is hidden. No WGSL ladder
    // for the hero (v1 rule) — WebGL2 only, and a lost context just releases
    // (a static hero is fine, app.js:117-121/161-165).
    const heroPool = data.kernels.filter((k) => k.featured && k.domain === 'terrain');
    const pool = heroPool.length ? heroPool : data.kernels.filter((k) => k.featured);
    const featured = pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : data.kernels[0];
    const host = document.getElementById('hero-bg');
    if (featured && host) {
      heroHandle = await runtimeHost(host, {
        prefer: 'webgl2', glslSrc: featured.glsl, canvasClass: 'hero-canvas', onLost: 'release',
      });
      if (disposed) { heroHandle.dispose(); heroHandle = null; return () => {}; }
      if (heroHandle.runtime) {
        if (document.hidden) heroHandle.runtime.stop();
        visHandler = () => {
          if (!heroHandle || !heroHandle.runtime) return;
          if (document.hidden) heroHandle.runtime.stop();
          else heroHandle.runtime.start();
        };
        document.addEventListener('visibilitychange', visHandler);
      }
    }
  } catch {
    if (!disposed) galleryError();
  }

  return function cleanup() {
    disposed = true;
    if (visHandler) document.removeEventListener('visibilitychange', visHandler);
    if (heroHandle) heroHandle.dispose();
    heroHandle = null;
  };
}
