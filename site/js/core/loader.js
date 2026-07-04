// Shader Garden — core/loader.js
// Route -> organ activation, driven by assets/organs.json. Every organ is a
// real lazy `import()`ed module. Routes: literal segments + one ':param',
// matched in organs.json order; unknown route -> '#/'. v2 substrate SUB-4
// adds non-route "panel" activation: assets/layout.json's `placements`
// mount/unmount panel organs outside the route table — see syncPanels().

import { bindSource } from './bus.js';
import { loadData } from './registry.js';
import { loadLayout, placementsFor, regionEl, layoutCtx } from './layout.js';
import { el } from '../dom.js';

const coreBus = bindSource('/garden/core');
let organs = [], activeCleanup = null, activeId = null, navToken = 0;
const panelActive = new Map(); // organId -> cleanup()
const panelRegion = new Map(); // organId -> the layout region it was mounted into
const panelGen = new Map();    // organId -> generation counter, guards a slow panel import()

export function centerNotice(msg) {
  const box = el('div', 'center-notice glass');
  box.append(el('p', null, msg));
  const back = el('a', 'btn', 'Back to the garden');
  back.setAttribute('href', '#/');
  box.append(back);
  return box;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const qIndex = raw.indexOf('?');
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? '' : raw.slice(qIndex + 1));
  return { path, params };
}

function matchRoute(pattern, path) {
  const pSegs = pattern.split('/').filter(Boolean);
  const segs = path.split('/').filter(Boolean);
  if (pSegs.length !== segs.length) return null;
  const params = {};
  for (let i = 0; i < pSegs.length; i++) {
    if (!pSegs[i].startsWith(':')) { if (pSegs[i] !== segs[i]) return null; continue; }
    let v = segs[i];
    try { v = decodeURIComponent(v); } catch { /* malformed %-escape: keep raw segment */ }
    params[pSegs[i].slice(1)] = v;
  }
  return params;
}

function matchOrgan(path) {
  for (const organ of organs) {
    for (const pattern of organ.routes || []) {
      const params = matchRoute(pattern, path);
      if (params) return { organ, params };
    }
  }
  return null;
}

function regionFor(id) { return document.getElementById('region-' + id); }
function resolveEntry(entry) { return new URL(entry, document.baseURI).href; }

function showRegion(id) {
  for (const o of organs) {
    const r = regionFor(o.id);
    if (r) r.hidden = o.id !== id;
  }
  document.body.dataset.route = id;
  window.scrollTo(0, 0);
}

function fail(organ, error) {
  console.error('[loader] organ mount failed:', organ.id, error);
  coreBus.emit('organ.failed.v1', { organ: organ.id, error: String((error && error.message) || error) });
  const root = regionFor(organ.id);
  if (root) { root.replaceChildren(); root.append(centerNotice('Could not load this part of the garden.')); }
}

// Shared by activate() and syncPanels(): import -> mount, re-checking
// isStale() after each await (the loader mid-mount staleness gap) so a
// superseded activation never installs, and a mount that resolves after
// being superseded is disposed immediately instead. Returns the cleanup fn,
// or null if nothing ended up mounted (failure already reported via fail()
// unless it was simply superseded, which is not an error).
async function tryMount(organ, ctx, isStale) {
  let mountFn;
  try { mountFn = (await import(resolveEntry(organ.entry))).mount; }
  catch (e) { if (!isStale()) fail(organ, e); return null; }
  if (isStale()) return null;
  let cleanup;
  try { cleanup = await mountFn(ctx); }
  catch (e) { if (!isStale()) fail(organ, e); return null; }
  if (isStale()) { if (cleanup) { try { cleanup(); } catch { /* gone */ } } return null; }
  return cleanup;
}

// v1's navToken/superseded-mount rules (app.js:202-204/281-283/370-374), now
// the loader's own.
async function activate(organ, params) {
  const token = ++navToken;
  if (activeCleanup) {
    const c = activeCleanup;
    activeCleanup = null;
    try { c(); } catch { /* keep routing */ }
    coreBus.emit('organ.closed.v1', { organ: activeId });
  }
  activeId = null;
  showRegion(organ.id);
  const t0 = performance.now();
  const ctx = Object.freeze({
    root: regionFor(organ.id), params, manifest: organ,
    bus: bindSource('/garden/' + organ.id),
    registry: { load: loadData },
    layout: layoutCtx(), // { prefs, setPref } — v2 substrate SUB-4, substrate §5.2
    // A nav-away mid-mount is invisible to activate() itself — parked on
    // `await mountFn(ctx)`, it can't re-check navToken until that settles.
    // alive() lets the organ check after its OWN expensive internal awaits.
    alive: () => token === navToken,
  });
  const cleanup = await tryMount(organ, ctx, () => token !== navToken);
  if (!cleanup) return;
  activeCleanup = cleanup;
  activeId = organ.id;
  coreBus.emit('organ.opened.v1', { organ: organ.id, route: location.hash, ms: performance.now() - t0 });
}

// Mounts/unmounts "panel" organs per layout.json's `placements` (SUB-4). A
// panel survives a same-placement re-navigation (/s/a -> /s/b both want
// 'provenance') — its own ctx.params goes stale then, which is why panels
// lean on bus events for updates (substrate §7.1). Removing a placement
// means its organ is never wanted, so its entry is never `import()`ed.
async function syncPanels(path, params) {
  const placements = placementsFor(path);
  const wanted = new Map(placements.map((p) => [p.organ, p.region]));

  for (const [id, cleanup] of panelActive) {
    if (wanted.has(id)) continue;
    panelActive.delete(id);
    panelGen.set(id, (panelGen.get(id) || 0) + 1); // invalidates any in-flight mount for this id
    try { cleanup(); } catch { /* keep routing */ }
    coreBus.emit('organ.closed.v1', { organ: id });
    const region = panelRegion.get(id);
    panelRegion.delete(id);
    if (region && ![...panelRegion.values()].includes(region)) {
      const r = regionEl(region);
      if (r) r.hidden = true;
    }
  }

  for (const [id, regionId] of wanted) {
    if (panelActive.has(id)) continue;
    const organ = organs.find((o) => o.id === id);
    const root = regionEl(regionId);
    if (!organ || !root) continue; // unknown organ id or region not present in this deploy
    const gen = (panelGen.get(id) || 0) + 1;
    panelGen.set(id, gen);
    const ctx = Object.freeze({
      root, params, manifest: organ,
      bus: bindSource('/garden/' + organ.id),
      registry: { load: loadData },
      layout: layoutCtx(),
      alive: () => panelGen.get(id) === gen,
    });
    const cleanup = await tryMount(organ, ctx, () => panelGen.get(id) !== gen);
    if (!cleanup) continue;
    panelActive.set(id, cleanup);
    panelRegion.set(id, regionId);
    root.hidden = false;
    coreBus.emit('organ.opened.v1', { organ: id, route: location.hash });
  }
}

async function route() {
  const { path, params } = parseHash();
  const match = matchOrgan(path);
  // Bump navToken here too (v1 always-bump-first) — an in-flight stale
  // activation is superseded immediately, before the '#/' redirect even
  // triggers a second hashchange.
  if (!match) { ++navToken; location.hash = '#/'; return; }
  for (const [k, v] of Object.entries(match.params)) params.set(k, v);
  await activate(match.organ, params);
  await syncPanels(path, params);
}

// manifest: parsed organs.json.
export async function initLoader(manifest) {
  organs = (manifest && manifest.organs) || [];
  await loadLayout();
  window.addEventListener('hashchange', route);
  route();
}
