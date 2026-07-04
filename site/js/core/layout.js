// Shader Garden — core/layout.js
// Layout-as-data (v2 substrate SUB-4). assets/layout.json ships the default
// regions/placements/prefs — schema is regions/placements/prefs ONLY (ruling
// C2: the editor's mode roster is not a top-level key; it lives at
// prefs.editor_modes / prefs.editor_default_mode). localStorage carries only
// a DIFF against the shipped default (substrate §5.3); a corrupt/unparseable
// diff is discarded silently — defaults win, never brick the site.

const STORAGE_KEY = 'sg.layout.v1';
const DEFAULT = Object.freeze({ version: 1, regions: {}, placements: [], prefs: {} });

let cached = null; // merged snapshot, set once loadLayout() resolves; shared by every caller

function readDiff() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; } // denied (private mode) -> default only
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // corrupt diff -> defaults win silently
  }
}

function writeDiff(diff) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(diff)); } catch { /* quota/denied — pref just doesn't persist */ }
}

function merge(base, diff) {
  const regions = {};
  for (const [id, region] of Object.entries(base.regions || {})) regions[id] = { ...region };
  if (diff && diff.regions) {
    for (const [id, patch] of Object.entries(diff.regions)) regions[id] = { ...(regions[id] || {}), ...patch };
  }
  return {
    version: base.version || 1,
    regions,
    placements: Array.isArray(base.placements) ? base.placements.slice() : [],
    prefs: { ...(base.prefs || {}), ...((diff && diff.prefs) || {}) },
  };
}

// Fetches the shipped default and merges the localStorage diff over it.
// Memoized — every caller shares this one snapshot; setPref() mutates it in
// place, so an already-mounted organ's ctx.layout.prefs sees later changes.
export async function loadLayout() {
  if (cached) return cached;
  let base = DEFAULT;
  try {
    const res = await fetch('assets/layout.json');
    if (res.ok) base = await res.json();
  } catch { /* offline/missing — empty default layout, never brick the site */ }
  cached = merge(base, readDiff());
  return cached;
}

// Mirrors loader.js's matchRoute grammar (literal segments + one ':param')
// but only needs a boolean; kept standalone to avoid a loader<->layout cycle.
function matches(pattern, path) {
  const pSegs = pattern.split('/').filter(Boolean);
  const segs = path.split('/').filter(Boolean);
  if (pSegs.length !== segs.length) return false;
  return pSegs.every((seg, i) => seg.startsWith(':') || seg === segs[i]);
}

export function placementsFor(path) {
  if (!cached) return [];
  return cached.placements.filter((p) => (p.when || []).some((pattern) => matches(pattern, path)));
}

export function regionEl(regionId) {
  const region = cached && cached.regions[regionId];
  return region && region.el ? document.querySelector(region.el) : null;
}

export function setPref(key, value) {
  if (!cached) return; // loadLayout() not yet resolved — nothing to persist against
  cached.prefs[key] = value;
  const diff = readDiff() || {};
  diff.prefs = { ...(diff.prefs || {}), [key]: value };
  writeDiff(diff);
}

// The 5th and final mount ctx key (substrate §5.2), same wrapper for every
// organ. `prefs` is the live `cached.prefs` object, so a later setPref() is
// visible without a remount.
export function layoutCtx() {
  return Object.freeze({ prefs: cached ? cached.prefs : {}, setPref });
}

// Anatomy's "Reset layout" button (substrate §8.2, SUB-5).
export function resetLayout() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
  cached = null;
}

// Anatomy's layout inspector (substrate §8.2, SUB-5): the full merged
// snapshot (regions/placements/prefs), read-only — organs otherwise only
// ever see `layoutCtx()`'s `prefs` slice.
export function snapshot() {
  return cached;
}
