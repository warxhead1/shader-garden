# Deploying Shader Garden

Operator guide: GitHub Pages setup, custom domain, and PWA install/caching
notes.

## 1. Enable GitHub Pages (Actions source)

The workflow at `.github/workflows/deploy.yml` uploads `site/` as a Pages
artifact and deploys it on every push to `main`. There is no build step — the
workflow only stamps two strings before upload: the repo name into
`js/share.js` (`OWNER_REPO_PLACEHOLDER`, which is why the "source on GitHub"
and issue links are dead placeholders in local dev) and the commit SHA into
`sw.js`.

1. Push the repo to GitHub and make it public (or Pages-enabled private).
2. Repo **Settings → Pages → Build and deployment → Source**: select
   **GitHub Actions**.
3. Push to `main` (or run the workflow manually via **Actions → Deploy to
   GitHub Pages → Run workflow**).
4. The site appears at `https://<user>.github.io/<repo>/`. All URLs in the app
   are relative, so the subpath just works.

## 2. Attach a custom domain (optional)

A short domain makes the PWA feel like a real product. Domains at registrars
like **Porkbun** or **Cloudflare Registrar** typically cost about the price of
a coffee or two per year — there is no hosting cost on top; GitHub Pages
serves the site for free.

### 2.1 DNS records at your registrar

For an **apex domain** (`shadergarden.example`), create four **A** records and
(optionally, for IPv6) four **AAAA** records pointing at GitHub Pages:

| Type | Host | Value |
|---|---|---|
| A | @ | `185.199.108.153` |
| A | @ | `185.199.109.153` |
| A | @ | `185.199.110.153` |
| A | @ | `185.199.111.153` |
| AAAA | @ | `2606:50c0:8000::153` |
| AAAA | @ | `2606:50c0:8001::153` |
| AAAA | @ | `2606:50c0:8002::153` |
| AAAA | @ | `2606:50c0:8003::153` |

For a **subdomain** (`garden.example.com`) — or the conventional `www` — a
single **CNAME** record is enough:

| Type | Host | Value |
|---|---|---|
| CNAME | garden (or www) | `<user>.github.io` |

(If you use Cloudflare DNS, set the record to "DNS only" / grey-cloud while
GitHub provisions its TLS certificate; you can proxy afterwards if you want.)

### 2.2 Tell GitHub about the domain

1. Repo **Settings → Pages → Custom domain**: enter the domain and save.
   GitHub runs a DNS check and provisions a certificate (can take a few
   minutes up to an hour).
2. Tick **Enforce HTTPS** once the certificate is issued. HTTPS is mandatory
   for service workers and PWA install, so do not skip this.
3. Commit the domain into the deployed artifact so it survives redeploys:
   create a file `site/CNAME` containing exactly one line — the domain:

   ```
   garden.example.com
   ```

   Because the workflow publishes the `site/` directory, the `CNAME` file
   lands at the artifact root where Pages expects it.

Once the site is served from the domain root, the app's relative URLs keep
working unchanged — nothing in `site/` references the repo subpath.

## 3. PWA wiring (already done — reference only)

`index.html` already links the manifest, icons, and theme color, and loads
`js/sw-register.js`, which registers `./sw.js` with a dev-host guard: no
registration on `localhost`/`127.0.0.1`, so development always sees fresh
files. As a second line of defense, `sw.js` itself refuses to cache anything
on those hostnames.

### Cache versioning

You never bump it by hand. The deploy workflow stamps the commit SHA into
`sw.js` (`SW_BUILD_PLACEHOLDER` → the pushed SHA), so every deploy
byte-changes the worker, reinstalls the precache, and activation drops the
previous version's caches. Only caches prefixed `shader-garden-` are ever
touched — other apps on the same Pages origin are left alone.

## 4. PWA install notes

- **Desktop Chrome/Edge**: an install icon appears in the address bar once the
  manifest + service worker are live over HTTPS.
- **Android Chrome**: browser menu → **Add to Home screen** (or the automatic
  install prompt). The maskable 512 icon keeps the sprout inside the safe zone
  on round/squircle launchers.
- **iOS Safari**: Safari does not show an install prompt. Use
  **Share → Add to Home Screen**. The `apple-touch-icon` link in `index.html`
  is what iOS uses for the home-screen tile; standalone display and offline
  caching work once the site has been visited over HTTPS.
- Offline behavior: the app shell and previously viewed kernel data are served
  from cache; `assets/kernels.json` and WGSL ports refresh in the background
  (stale-while-revalidate) on each visit.

## 5. Sanity checklist after first deploy

- [ ] `https://<domain>/manifest.webmanifest` loads (correct MIME, not 404).
- [ ] DevTools → Application → Service Workers shows `sw.js` activated.
- [ ] DevTools → Application → Manifest shows all three icons, no warnings.
- [ ] Lighthouse PWA audit passes installability.
- [ ] After a second deploy, Application → Cache Storage shows only one
      `shader-garden-v1-<sha>` cache — the previous deploy's cache is gone.
