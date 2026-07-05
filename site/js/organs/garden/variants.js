// GARDEN-IDE — organs/garden/variants.js
// Fetches component stage/variant metadata + bodies (work item 3). One
// TOP-LEVEL manifest (assets/garden/variants/manifest.json, keyed by
// component id) rather than a manifest per component directory — most
// components have no variants, and per-component fetches meant a guaranteed
// 404 in the console for each of them on every panel open. Session-only
// selection state lives in index.js, same lifetime as editedBodies — this
// module only knows how to fetch, once per session (cached).
// A missing/unparseable manifest resolves to null for every component, not
// an error — every caller treats null as "no stages".
let indexPromise = null;
const bodyCache = new Map(); // "componentId/variantId" -> Promise<string>

function loadVariantIndex() {
  if (!indexPromise) {
    indexPromise = fetch('assets/garden/variants/manifest.json')
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return indexPromise;
}

export function loadVariantManifest(componentId) {
  return loadVariantIndex().then((index) => index[componentId] ?? null);
}

export function loadVariantBody(componentId, variant) {
  const key = componentId + '/' + variant.id;
  if (!bodyCache.has(key)) {
    bodyCache.set(key, fetch(`assets/garden/variants/${componentId}/${variant.file}`).then((r) => r.text()));
  }
  return bodyCache.get(key);
}
