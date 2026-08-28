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

## 5. Production multiplayer relay (The Commons)

Out of the box a public Pages deploy is single-player. Multiplayer is an
operator switch: you stand up a WebSocket relay somewhere on the public
internet and tell the deploy workflow about it. This section is the
end-to-end wiring; `server/README.md` is the relay itself.

### 5.1 Why this isn't just a checkbox

GitHub Pages is HTTPS. Every browser refuses a plain `ws://` socket from an
HTTPS page — same rule that blocks `http://` images on an HTTPS page, just
for WebSockets instead. That means:

- **The relay itself speaks plain `ws://`** (`server/relay.mjs` is a Node
  `http` server that does its own RFC6455 framing — invariant I6, zero npm
  dependencies). You terminate TLS in front of it (reverse proxy, fly.io,
  Cloudflare Tunnel, whatever you already operate).
- **The endpoint the site dials MUST be `wss://`** — anything else and the
  browser drops the connection before a single byte leaves the tab. There is
  no client-side fallback; this is mixed content, not a config error.
- On `localhost`/`127.0.0.1` the site is allowed to use plain `ws://` and
  does so automatically — that's what lets you run `node server/relay.mjs`
  and open the site locally with zero extra setup (see
  `docs/multiplayer-spec.md` §2.5 and `site/js/multiplayer/ice-credentials.js`'s
  `resolveRelayUrl`).

### 5.2 Stand the relay up

The image is just `server/Dockerfile` plus three files:

```sh
docker build -t sg-relay server/
docker run -p 8787:8787 \
  -e SG_ALLOWED_ORIGINS=https://<user>.github.io \
  sg-relay
```

Two non-obvious knobs that matter in production:

- **`SG_ALLOWED_ORIGINS`** is the origin allowlist (the relay's
  `--origin` flag). Without it the relay accepts WebSocket upgrades from
  any origin and prints a one-line warning on every boot — fine in dev,
  wrong on the open internet. With it set, a matching origin gets the
  `101` upgrade and any other origin gets a bare `403` before the
  handshake.
- **`GET /healthz`** returns `{"ok":true,"rooms":<n>,"members":<n>}` —
  point your uptime check at it. State is in memory: a room exists while
  someone is in it, so restarting the relay costs an in-progress round
  and nothing else.

Any host that runs a container and terminates TLS in front of it works.
The relay has no npm dependencies, so there is no install step to break
the image.

### 5.3 Tell the deploy workflow about it — `SG_RELAY_URL`

This is the actual stamping mechanism, taken straight from
`.github/workflows/deploy.yml`:

```yaml
- name: Point the deployed site at the relay
  env:
    RELAY_URL: ${{ vars.SG_RELAY_URL }}
  run: |
    if [ -z "$RELAY_URL" ]; then
      echo "SG_RELAY_URL unset — deploying a single-player site."
      exit 0
    fi
    case "$RELAY_URL" in
      wss://*) ;;
      *) echo "::error::SG_RELAY_URL must be wss:// (got '$RELAY_URL'); ws:// is blocked as mixed content on Pages." ; exit 1 ;;
    esac
    printf '{"url": "%s"}\n' "$RELAY_URL" > site/assets/relay.json
    echo "Relay configured: $RELAY_URL"
```

What that means for you:

1. **Set the repository VARIABLE `SG_RELAY_URL`** (Settings → Secrets and
   variables → Actions → Variables) to your public `wss://` endpoint. It
   is a **variable**, not a secret: this value ships inside a public
   Pages artifact and is trivially readable from the deployed page, so
   marking it secret would hide it from the people maintaining it
   without hiding it from anyone else.
2. **Unset = single-player deploy.** `site/assets/relay.json` ships
   `{"url": null}` and the deploy step leaves it that way. A Pages
   deploy with no `relay.json` resolves to `no-relay` and shows a clean
   single-player garden — not a broken multiplayer one.
3. **Set but not `wss://` = loud deploy failure.** A non-`wss://` value
   fails the deploy with a clear error rather than shipping multiplayer
   that looks broken for no visible reason. The mixed-content block is
   silent in the browser, so a permissive client would otherwise be the
   only signal anyone ever saw.

There is no hosted endpoint. This repository does not run a relay for
you; the URL you set has to point at infrastructure you operate, with
TLS termination you control, in front of a container you built from
`server/Dockerfile`.

### 5.4 Public STUN-only entries — `SG_ICE_SERVERS_JSON`

A **SECRET** with the same name as a previously-suggested "stun or turn"
override, kept for backward compatibility but now explicitly bounded to
**public, non-secret STUN entries only**.

```sh
# Example — public STUN list (the canonical "twelve servers, no auth"
# trick works fine here; these are all client-dialed directly and visible
# to anyone watching your network anyway):
SG_ICE_SERVERS_JSON='[
  {"urls": "stun:stun.l.google.com:19302"},
  {"urls": ["stun:stun1.l.google.com:19302","stun:stun2.l.google.com:19302"]}
]'
```

The deploy step validates the JSON, requires it to be an array of
`RTCIceServer`-shaped objects, and rejects any entry that carries
`username`, `credential`, or `credentialType` — long-lived TURN
credentials in a public artifact would expose your TURN service to
abuse (an attacker reading the deployed JS can reroute arbitrary
traffic through your relay). **For TURN, use §5.5 below.**

If unset, an empty `iceServers` array is stamped — direct connectivity
only, no TURN. Two visitors on hostile networks will then fail to
connect to each other. WebRTC's ICE layer will still try every direct
candidate pair; only the TURN fallback is missing.

### 5.5 Short-lived TURN credentials — `SG_ICE_CREDENTIALS_URL`

When two peers cannot establish a direct connection (symmetric NAT,
captive portal, restrictive firewall), WebRTC's ICE layer falls back
to a TURN server — a relay that forwards encrypted media/data. TURN
requires per-session credentials; long-lived ones in a public artifact
are a security risk, so the credentials are vended at runtime.

```sh
# Example: a public https URL that returns short-lived TURN credentials.
# The URL itself is public (it ships in the deployed artifact); the
# credentials it returns are short-lived (REST-style TTL, seconds to
# minutes) and never appear in the static site.
SG_ICE_CREDENTIALS_URL='https://my-turn-vend.example.com/credentials'
```

A **VARIABLE**, not a secret — same reasoning as `SG_RELAY_URL`. The
URL is callable by every visitor; the secrets stay on the vending host.

When this is set, `site/js/multiplayer/ice-credentials.js`'s
`fetchIceCredentials()` runs BEFORE every `createP2PSocket()` call (i.e.
on every connect/reconnect — `net.js` imports the helper and wires it
into its own vend-and-merge path), and:

1. Calls `GET <url>` with `cache:'no-store'`, `credentials:'omit'`,
   and `Accept: application/json`. The omit-credentials flag stops the
   browser from sending cookies to the vending host — important across
   origins.
2. Requires `response.ok`. 401/403/5xx all fail closed.
3. Requires a JSON OBJECT body whose `iceServers` field is a NONEMPTY
   array of `{ urls: string|string[] [, username, credential] }` entries.
4. **Fails closed** when the URL was configured but the response is
   malformed: the connection does not dial without ephemeral credentials
   (no spurious STUN-only fallback), the status pill surfaces the error
   tag (`ice-vend:http-502`, etc.), and the retry backoff takes over.
5. Merges public STUN (from `SG_ICE_SERVERS_JSON`) FIRST, then
   ephemeral TURN (from the vending endpoint) — visible in DevTools,
   but the credential strings themselves are never logged or persisted.

The endpoint contract:

```json
{
  "iceServers": [
    { "urls": "turn:turn.example.com:3478?transport=udp",
      "username": "<short-lived>",
      "credential": "<short-lived>" },
    { "urls": "turn:turn.example.com:3478?transport=tcp",
      "username": "<short-lived>",
      "credential": "<short-lived>" }
  ]
}
```

Any other top-level fields are ignored. An empty `iceServers` array,
a non-object body, or an entry whose `urls` is the wrong type is
rejected — the brief is explicit that failure must fail closed. See
`docs/multiplayer-spec.md` §2.6 for the full validation contract and
`tools/test/mp-ice-credentials.mjs` for the unit tests.

**What you operate.** This repository does not run a credential
vending service for you; you point `SG_ICE_CREDENTIALS_URL` at one you
run, with TTL short enough to limit the blast radius of a stolen
credential (the spec suggests seconds to minutes, not hours). Cloud
providers with managed TURN (Twilio Network Traversal, Cloudflare
Calls, etc.) expose this shape directly.

## 6. Sanity checklist after first deploy

- [ ] `https://<domain>/manifest.webmanifest` loads (correct MIME, not 404).
- [ ] DevTools → Application → Service Workers shows `sw.js` activated.
- [ ] DevTools → Application → Manifest shows all three icons, no warnings.
- [ ] Lighthouse PWA audit passes installability.
- [ ] After a second deploy, Application → Cache Storage shows only one
      `shader-garden-v1-<sha>` cache — the previous deploy's cache is gone.
- [ ] If multiplayer is on, opening `#/garden/<room>` on two devices shows
      both peers in the roster panel and the relay's `GET /healthz` reports
      `members: 2`.
