// Service-worker registration with the dev-host guard described in ARCHITECTURE.md.
// Safe to load unconditionally — it no-ops on localhost/127.0.0.1 and on
// browsers without SW support.

const DEV_HOSTS = ['localhost', '127.0.0.1'];

if ('serviceWorker' in navigator && !DEV_HOSTS.includes(location.hostname)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch((err) => console.warn('[shader-garden] SW registration failed:', err));
  });
}
