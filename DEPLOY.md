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
docker build -t sg-relay -f server/Dockerfile .
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

A repository **VARIABLE**, explicitly bounded to public, non-secret
STUN entries only. It is not a secret because the stamped value is readable
from the public Pages artifact.

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

## 6. Two-household rehearsal (P2P, with a real friend)

Everything above proves the site deploys. This section proves the P2P
transport works **between two houses on two different networks** — the only
configuration that exercises NAT traversal, and the one a single machine
with two browser tabs cannot fake. Run it once before you invite anyone
you'd be embarrassed in front of.

You need: the public URL, a room name you both type, a phone call (or any
side channel) so the two of you can say "go" to each other, and — for the
forced-relay pass in step 6.5 — a TURN server in the ICE list the deploy
already ships.

### 6.1 Before the call

1. Confirm the deploy is multiplayer: `site/assets/relay.json` on the live
   site returns a `wss://` URL (open
   `https://<domain>/assets/relay.json` in a browser). `{"url": null}`
   means single-player and the rehearsal cannot start.
2. Agree on ONE room name — plain lowercase, no spaces, e.g. `rehearsal-1`.
   The easy path is `https://<domain>/#/play`: type the name there, hit
   **Open the room**, and use **Copy invite link** to send the other
   household the exact URL rather than dictating it. Both of you can also
   just open `https://<domain>/#/garden/<room>` directly — the lobby only
   builds that URL, it is not a separate entry point.
3. Decide who joins FIRST. The first signal member of a room is the
   immutable host (`docs/multiplayer-spec.md` §Weekend P2P); host loss is
   fail-closed with no re-election, so "who hosts" is a decision, not an
   accident. Have the friend with the more stable connection host.

### 6.2 Run the rehearsal instrument on your side

From `tools/test` (after `npm ci`), open ONE local browser peer against the
public deploy and let it print sanitized diagnostics on an interval:

```sh
node tools/test/manual/mp-p2p-rehearsal.mjs \
  --url https://<domain>/ --room rehearsal-1 --interval 10 --minutes 30
```

Add `--json-only` if you want to pipe the output somewhere. The script is
provider-neutral (it names no STUN/TURN vendor) and prints **no URL, IP
address, ICE candidate, SDP, TURN username or credential** — it reuses
`p2p-socket.js`'s own sanitizer, so the output is safe to screen-share or
paste into an issue. Pass `--no-origin` to suppress even the target origin.

Your local peer counts as one of the two households; your friend joins the
same room from theirs in an ordinary browser.

### 6.3 Evidence gates

The rehearsal PASSES only when every gate below is observed. A gate you
did not check is a gate that failed.

- [ ] **Both devices live.** Each side's multiplayer status pill reads
      `live`, and each side's roster lists BOTH players. The rehearsal
      script's `status=live` + `peers-in-roster=2` line is the same fact
      from your side.
- [ ] **Signaling carries no gameplay.** On either side: DevTools →
      Network → the `wss://` signaling socket → Messages. Every frame is
      `sg.signal.v1` (`hello`, `signal`, `signal.welcome`,
      `signal.peer.join`/`.leave`, `signal.host-lost`). There must be
      **zero** `sg.mp.v1` gameplay frames (`welcome`, `poses`, `lease`,
      `draft`, `commit`, `tune`, `tag`, `game`, `time`, `ring`, …) — those
      belong on the data channels. A gameplay `t` on the signaling hop
      means the operator of the relay can read the game, which is the
      whole property P2P is here to remove.
- [ ] **Tune convergence.** One side takes the lectern lease, opens a
      component probe panel, and drags a `@tune` slider. The OTHER
      household's render visibly changes and its own slider lands on the
      same value. The rehearsal script echoes the live values on its
      `tunes:` line.
- [ ] **Edit convergence.** The lease holder edits a component and commits.
      The other household's garden rebuilds with the edit, and a THIRD
      party joining afterwards receives it in their `welcome` snapshot.
- [ ] **A selected candidate pair exists.** Every diagnostics row shows
      `pair=transport` (or `selected-flag`/`succeeded`) with a
      `connectionState=connected` — not `pair=none`. `pair=none` with a
      connected pill means the room is running over the ws relay, not P2P.
- [ ] **Forced-TURN pass: at least one candidate type is `relay`.** Repeat
      the rehearsal with both households on networks that cannot reach
      each other directly (mobile hotspot on one side is the easiest
      approximation; `chrome://flags` / an `iceTransportPolicy: 'relay'`
      build is the deterministic one). At least one of
      `localCandidateType` / `remoteCandidateType` must read `relay`, and
      `relayProtocol` must be non-null on the relay side. **Do not claim
      TURN works because the direct pass succeeded** — a direct pass
      proves nothing about the TURN path, and a broken TURN config is
      invisible until the first household behind a symmetric NAT shows up.
      The automated `mp-p2p-two-browsers` suite deliberately does not
      assert `relay`: it runs on loopback where the honest answer is
      `host`.
- [ ] **Byte counters increase.** Across two consecutive reports, both
      `Δsent` and `Δrecv` are positive on every row (the script labels
      this `[MOVING]`). `[STALLED]` while both pills say `live` means the
      pair is up but the data channels are not carrying — treat it as a
      failure, not a slow moment.
- [ ] **Host loss is fail-closed.** The HOST household closes its tab. The
      guest's status pill flips to `closed` with the text `host lost`
      (WebSocket close code **1012**), the guest's signaling socket shows
      `signal.host-lost`, and **no fresh `welcome` arrives afterwards** —
      there is no re-election and no silent re-dial to another host. A
      guest that reconnects into a different room's state is the exact
      regression this gate exists to catch. To play again, everyone
      reloads and someone joins first.

### 6.4 If a gate fails

- **Never reaches `live`** — check `relay.json` is `wss://`, the relay's
  `SG_ALLOWED_ORIGINS` includes the deployed origin, and the relay's
  `GET /healthz` shows the room's members.
- **`pair=none` / `connectionState=failed`** — ICE never completed. Both
  households behind restrictive NATs with no reachable TURN server is the
  usual cause; this is what the forced-TURN gate is for.
- **`[STALLED]` with a connected pair** — the pair is alive but a data
  channel closed. Reload both sides; a repeat means a transport bug worth
  an issue (attach the sanitized rehearsal output, which is safe to paste).
- **Gameplay frames on the signaling socket** — stop and file it. That is
  a wire-isolation regression, not a tuning problem.

## 7. Sanity checklist after first deploy

- [ ] `https://<domain>/manifest.webmanifest` loads (correct MIME, not 404).
- [ ] DevTools → Application → Service Workers shows `sw.js` activated.
- [ ] DevTools → Application → Manifest shows all three icons, no warnings.
- [ ] Lighthouse PWA audit passes installability.
- [ ] After a second deploy, Application → Cache Storage shows only one
      `shader-garden-v1-<sha>` cache — the previous deploy's cache is gone.
- [ ] If multiplayer is on, opening `#/garden/<room>` on two devices shows
      both peers in the roster panel and the relay's `GET /healthz` reports
      `members: 2`.
