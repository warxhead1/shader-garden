// Shader Garden — core/boot.js
// Entry point (v2 substrate SUB-3, replaces app.js). Gallery/viewer are now
// real organs (js/organs/gallery, js/organs/viewer) — this file is left
// with only what app.js:360-380 always was: page-chrome glue that has
// nowhere else to live, plus handing organs.json to the loader, plus (v2
// substrate SUB-5) the one shared keydown listener overlay organs hang a
// hotkey on — substrate §8.1's entire always-on cost for Anatomy.

import { githubRepoUrl } from '../share.js';
import { initLoader } from './loader.js';
import { bindSource, on } from './bus.js';
import { loadData } from './registry.js';
import { layoutCtx } from './layout.js';
import { inEditableChrome } from '../dom.js';

// Footer / hero GitHub links (placeholder repo substituted at deploy).
for (const link of document.querySelectorAll('a[data-repo-link]')) {
  link.setAttribute('href', githubRepoUrl());
}

// "Browse the kernels" scrolls to the grid without disturbing hash routing.
const exploreBtn = document.getElementById('explore-btn');
if (exploreBtn) {
  exploreBtn.addEventListener('click', () => {
    const g = document.getElementById('gallery');
    if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// Overlay organs (payload:"overlay", e.g. anatomy) own no route and no
// layout placement — the loader never touches them. They are opened by
// their manifest `hotkey` or by the one sanctioned command event,
// `organ.open.v1` (substrate §3.3/§4.4), toggled closed the same way (the
// anatomy module's own Esc handler and close button both just re-emit that
// command with their own id). `gen` is loader.js's `navToken` pattern,
// reused here: bumped SYNCHRONOUSLY before the mount's own await chain
// starts, so `ctx.alive()` (checked by the organ after ITS OWN internal
// awaits — anatomy fetches organs.json before rendering) compares against a
// snapshot taken before any await ran, not against `open` — which is only
// assigned after `mount()` resolves and would otherwise always read as
// "not yet open" during the mount itself (the same mid-mount staleness gap
// loader.js's navToken exists to close).
let open = null; // { id, cleanup }
let gen = 0;

function hotkeyMatches(hotkey, e) {
  const parts = hotkey.split('+');
  const held = (mod) => parts.includes(mod) === e[mod.toLowerCase() + 'Key'];
  return parts.includes(e.code) && held('Shift') && held('Ctrl') && held('Alt') && held('Meta');
}

async function toggleOverlay(organ) {
  const myGen = ++gen; // bumped first, like loader.js's navToken — invalidates any in-flight mount too
  const root = document.getElementById('region-overlay');
  if (open) {
    const wasSame = open.id === organ.id;
    try { open.cleanup(); } catch { /* keep the toggle path alive */ }
    root.hidden = true;
    open = null;
    if (wasSame) return;
  }
  root.hidden = false;
  const ctx = Object.freeze({
    root, params: new URLSearchParams(), manifest: organ,
    bus: bindSource('/garden/' + organ.id), registry: { load: loadData }, layout: layoutCtx(),
    alive: () => gen === myGen,
  });
  let cleanup;
  try { cleanup = await (await import(new URL(organ.entry, document.baseURI).href)).mount(ctx); }
  catch (e) { console.error('[boot] overlay mount failed:', organ.id, e); if (gen === myGen) root.hidden = true; return; }
  if (gen !== myGen) { try { cleanup && cleanup(); } catch { /* superseded mid-mount */ } return; }
  open = { id: organ.id, cleanup };
}

fetch('assets/organs.json')
  .then((res) => res.json())
  .then((manifest) => {
    const overlays = (manifest.organs || []).filter((o) => o.payload === 'overlay' && o.hotkey);
    window.addEventListener('keydown', (e) => {
      if (inEditableChrome(document.activeElement)) return;
      const hit = overlays.find((o) => hotkeyMatches(o.hotkey, e));
      if (hit) { e.preventDefault(); toggleOverlay(hit); }
    });
    on('organ.open.v1', (envelope) => {
      const organ = overlays.find((o) => o.id === (envelope.data || {}).organ);
      if (organ) toggleOverlay(organ);
    });
    initLoader(manifest);
  })
  .catch((e) => console.error('[boot] could not load assets/organs.json', e));
