// GARDEN-IDE — organs/garden/attribution.js
// Wave-4 §3 (attribution/provenance). Fetches + caches the garden's own
// component provenance — same fetch-once discipline as variants.js's
// loadVariantManifest (module-scope memoized promises, never re-fetched).
//
// Two separate assets, deliberately not merged into one:
//   assets/garden/attribution.json          — hand-curated (kind, sourceKernel,
//                                              note). Checked in; a human made
//                                              every call in it, so a dangling
//                                              sourceKernel is a bug, not a
//                                              tolerable gap (see
//                                              garden-attribution.mjs).
//   assets/garden/attribution-commits.json  — git-derived (firstCommit sha/date
//                                              per component), baked once by
//                                              tools/bake_garden_attribution.py.
//                                              Never hand-edited — it would go
//                                              stale the moment a component's
//                                              body is touched again.
// A missing/unparseable file of either kind resolves to an empty object, not
// an error — every caller treats a missing entry as "nothing to show", same
// posture as variants.js's own missing-manifest handling.
let attribPromise = null;
let commitsPromise = null;

function loadAttribution() {
  if (!attribPromise) {
    attribPromise = fetch('assets/garden/attribution.json')
      .then((r) => (r.ok ? r.json() : { components: {}, variants: {} }))
      .catch(() => ({ components: {}, variants: {} }));
  }
  return attribPromise;
}

function loadCommits() {
  if (!commitsPromise) {
    commitsPromise = fetch('assets/garden/attribution-commits.json')
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return commitsPromise;
}

// Exported for the site-level /attribution organ, which lists every
// component's kind directly rather than resolving them one probe at a time —
// same underlying fetches, no second network shape to maintain.
export function loadAttributionData() {
  return loadAttribution();
}

// `componentId` — a garden component id (not a variant). Resolves null if
// the component has no attribution.json entry at all (garden-attribution.mjs
// treats that as a build-time failure, not a runtime one — every parsed
// component is required to have an entry by the time this ships).
export async function attributionFor(componentId) {
  const [attrib, commits] = await Promise.all([loadAttribution(), loadCommits()]);
  const entry = attrib.components && attrib.components[componentId];
  if (!entry) return null;
  return { ...entry, firstCommit: commits[componentId] || null };
}

// Variant attribution follows the same {kind, sourceKernel?, note?} shape,
// keyed by [componentId][variantId] in attribution.json's `variants` block —
// variants have no independent git history worth surfacing (they're static
// assets, not `@component` blocks), so no firstCommit lookup here.
export async function attributionForVariant(componentId, variantId) {
  const attrib = await loadAttribution();
  const forComponent = attrib.variants && attrib.variants[componentId];
  return (forComponent && forComponent[variantId]) || null;
}
