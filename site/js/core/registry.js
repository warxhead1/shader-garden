// Shader Garden — core/registry.js
// Kernel data loading, extracted verbatim from app.js's loadData() (P4).
// COMP-1 (v2 §7.3 item 24): also resolves assets/compositions/ — same
// best-effort-empty-on-failure shape as the WGSL manifest fetch below, so a
// missing/absent compositions dir (or one deleted wholesale) yields
// `compositions: []` instead of a rejected load, letting the gallery/viewer
// filter compositions out cleanly with zero special-casing.

let dataPromise = null;

async function loadCompositions() {
  try {
    const ires = await fetch('assets/compositions/index.json');
    if (!ires.ok) return [];
    const idx = await ires.json();
    const ids = Array.isArray(idx && idx.compositions) ? idx.compositions : [];
    const docs = await Promise.all(ids.map((id) =>
      fetch('assets/compositions/' + encodeURIComponent(id) + '.json')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ));
    return docs.filter((d) => d && typeof d.id === 'string' && Array.isArray(d.passes));
  } catch {
    return []; // no compositions dir, or a malformed index — never blocks kernels.json
  }
}

export function loadData() {
  if (!dataPromise) {
    dataPromise = (async () => {
      const res = await fetch('assets/kernels.json');
      if (!res.ok) throw new Error('kernels.json HTTP ' + res.status);
      const json = await res.json();
      let wgsl = {};
      try {
        const mres = await fetch('assets/wgsl/manifest.json');
        if (mres.ok) {
          const m = await mres.json();
          if (m && typeof m === 'object') wgsl = m;
        }
      } catch { /* no WGSL ports — GL2 everywhere */ }
      const compositions = await loadCompositions();
      return {
        generated: json.generated || null,
        kernels: Array.isArray(json.kernels) ? json.kernels : [],
        wgsl,
        compositions,
      };
    })();
    // A rejected promise must not be memoized forever — one transient fetch
    // failure would otherwise poison every later route until a reload.
    const p = dataPromise;
    p.catch(() => { if (dataPromise === p) dataPromise = null; });
  }
  return dataPromise;
}
