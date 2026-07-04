/* Shader Garden service worker.
 *
 * Caching strategy (all paths relative to the SW scope — never a leading "/"):
 *   - precache: app shell (cache-first)
 *   - stale-while-revalidate: assets/kernels.json + assets/wgsl/*
 *   - same-origin only; opaque cross-origin responses are never cached
 *
 * Self-defense: registration is guarded at the call site (js/sw-register.js),
 * but this worker ALSO refuses to cache anything when running on
 * localhost/127.0.0.1 so a stray dev registration can't poison development.
 */

// SW_BUILD_PLACEHOLDER is substituted with the commit SHA at deploy time
// (deploy.yml), so EVERY deploy byte-changes sw.js — the browser's SW update
// check then reinstalls and rebuilds the precache. Without this, a content
// deploy that doesn't touch sw.js would never reach returning clients.
// Locally the literal placeholder is harmless: dev hosts never cache.
const VERSION = 'v1-SW_BUILD_PLACEHOLDER';
const CACHE_NAME = `shader-garden-${VERSION}`;

const IS_DEV_HOST =
  self.location.hostname === 'localhost' ||
  self.location.hostname === '127.0.0.1';

const PRECACHE = [
  './',
  './index.html',
  './css/main.css',
  './js/core/boot.js',
  './js/core/bus.js',
  './js/core/loader.js',
  './js/core/registry.js',
  './js/core/layout.js',
  './assets/organs.json',
  './assets/layout.json',
  // js/organs/gallery/*, js/organs/viewer/*, js/organs/admission/*,
  // js/organs/provenance/*, js/organs/anatomy/*, js/editor/*,
  // js/core/runtime-host.js, and js/runtime/* are all intentionally absent:
  // every organ (gallery/viewer included, since v2 substrate SUB-3 — they
  // used to be static imports in app.js; provenance since SUB-4; anatomy
  // since SUB-5) is a real lazy `import()` core/boot.js or core/loader.js
  // only fetches on route/placement/hotkey match; precaching any of them
  // would defeat idle-costs-zero. js/share.js IS precached: core/boot.js imports
  // it eagerly, at every boot, regardless of route. assets/organs.json and
  // assets/layout.json ARE precached: core/loader.js fetches both eagerly
  // (organs.json via boot.js, layout.json via core/layout.js's loadLayout())
  // to drive routing and panel placement before the first route() call.
  './js/share.js',
  './js/sw-register.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

// Runtime stale-while-revalidate targets (matched against scope-relative path).
function isRuntimeSWR(url) {
  const rel = url.pathname;
  return rel.endsWith('/assets/kernels.json') || rel.includes('/assets/wgsl/');
}

self.addEventListener('install', (event) => {
  if (IS_DEV_HOST) {
    self.skipWaiting();
    return;
  }
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // cache:'reload' bypasses the browser HTTP cache — otherwise a VERSION
      // bump can populate the new cache with STALE HTTP-cached asset bytes
      // (GitHub Pages serves max-age=600) and the deploy silently fails.
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // Cache Storage is origin-scoped and GitHub Pages project sites
            // share one origin (<user>.github.io) — only ever touch OUR
            // prefixed caches, never a sibling app's.
            .filter((k) => k.startsWith('shader-garden-') && (IS_DEV_HOST || k !== CACHE_NAME))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (IS_DEV_HOST) return; // network passthrough during development

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  if (isRuntimeSWR(url)) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }

  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (cached) return cached;
  try {
    return await fetch(req);
  } catch (err) {
    // Offline navigation fallback: the app is a hash-routed SPA in index.html.
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const refresh = fetch(req)
    .then(async (res) => {
      // Only cache clean, same-origin 200s (never opaque responses).
      if (res && res.status === 200 && res.type === 'basic') {
        // Awaited so a QuotaExceeded rejection lands in the catch below
        // instead of surfacing as an unhandled rejection.
        await cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => undefined);
  // Keep the worker alive until the background revalidation lands —
  // without this the UA may terminate the idle SW mid-refresh and the
  // cache update is silently dropped (stale kernels.json forever).
  event.waitUntil(refresh);
  return cached || refresh.then((res) => {
    if (!res) throw new Error('offline and not cached: ' + req.url);
    return res;
  });
}
