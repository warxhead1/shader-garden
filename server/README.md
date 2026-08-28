# server/ — The Commons relay

A tiny, dependency-free WebSocket relay for multiplayer Shader Garden rooms
(`#/garden/:room`). It speaks two JSON-over-WebSocket protocols —
`sg.signal.v1` (the deployed default for the P2P transport; membership,
host selection, SDP/ICE forwarding, host-loss teardown) and `sg.mp.v1`
(the legacy central-relay ws transport; the relay itself runs the
reducer in that mode). In the deployed P2P mode the relay's job is
three things and only three things: track room membership, pick the
first member to arrive as the room's immutable host, and forward SDP
offers/answers + ICE candidates between peers during the WebRTC
handshake — the relay does not parse the SDP/ICE, but the operator can
read those descriptions and candidates because that is what signaling is.
The shared clock and game authority (lease flips, commits, drafts, poses,
game phase) run inside the browser host as
`site/js/multiplayer/room-core.js`, never on this process; game traffic
flows browser-to-browser over WebRTC data channels and never passes
through here. A host departure takes the whole room down (fail-closed —
see §3 below). See `docs/multiplayer-spec.md` §2 for the frozen design
this implements.

## Running it

```sh
node server/relay.mjs --port 8787
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `8787` | TCP port to listen on. |
| `--host <addr>` | `0.0.0.0` | Bind address. |
| `--origin <csv>` | *(none — open)* | Comma-separated allowlist of acceptable `Origin` headers. Without it, any origin is accepted and a one-line warning is printed once at boot. **Set this in production.** |

`GET /healthz` returns `{"ok":true,"rooms":<n>,"members":<n>}` — point an
uptime check at it.

There is nothing to install. Node >= 22 (for the built-in `WebSocket`
client, used by the test suite — the relay itself needs no client-side
global, only `node:http` and `node:crypto`) and this repo, nothing else.
`package.json` here has no `dependencies` block; that's invariant I6, not an
oversight.

## The mixed-content trap (GitHub Pages is HTTPS)

The site is served over `https://`, and an `https://` page is forbidden by
every browser from opening a plain `ws://` connection — it's the same rule
that blocks `http://` images on an `https://` page, just for sockets
instead. That means:

- **A production relay MUST be reachable at `wss://`** (TLS-terminated —
  behind a reverse proxy, a tunnel, whatever you've got; this relay itself
  speaks plain `ws://` and assumes something in front of it does TLS when
  it's not just `localhost`).
- On `localhost`/`127.0.0.1` the site is allowed to use plain `ws://` and
  will, automatically (see `docs/multiplayer-spec.md` §2.5) — that's what
  lets you run `node server/relay.mjs` and open the site locally with zero
  extra setup.
- Anywhere else, if no `wss://` relay is configured (`site/assets/relay.json`
  ships `{"url": null, "transport": "p2p", "iceServers": []}` and is the one
  operator-edited file — see DEPLOY.md), the room route shows a "no relay
  configured" notice instead of silently trying and failing. It never attempts
  `ws://` from an `https://` page; that attempt is blocked by the browser
  before a single byte leaves the tab, so the failure would otherwise be
  silent and confusing.

## The protocol, `sg.mp.v1`

One JSON object per text WebSocket message, always `{ "t": "<type>", ... }`.

**Client -> server**

| `t` | Purpose |
|---|---|
| `hello` | Join a room. MUST be the first message on a connection. The room is named by `hello.room` — the WebSocket upgrade URL path is transport addressing only and does **not** choose which room you join. Two clients with the same `hello.room` always share a room regardless of upgrade path; two clients on the same upgrade path with different `hello.room` values are always isolated. `hello.room` must be a non-empty string of at most 128 characters; anything else closes with WebSocket code **1002** and creates no room/member. |
| `pose` | Report `{x,z,yaw,speed01,gait}`. Rate-limited (see below). |
| `ring` | Tell the server whether you just entered/left the lectern's ring. |
| `lease.request` / `lease.keepalive` / `lease.release` | The "one writer" baton for editing the shared shader. |
| `draft` | Live, unsaved editor content — mirrored to everyone else, never stored. |
| `commit` | A saved shader-component body, applied for everyone if the epoch is current. |
| `tag` | Seeker-only: "I think I just tagged this player." |
| `ping` | Clock-sync round trip; server answers with `time`. |

**Server -> client**

`welcome`, `peer.join`, `peer.leave`, `poses`, `lease`, `draft`, `commit`,
`reject`, `time`, `game`, `error`. Field shapes for every one of these are
in `docs/multiplayer-spec.md` §2.3 — this file doesn't repeat them because
that table is the frozen source and a second copy here would just be one
more place for the two to drift out of sync.

### Rate limits and trust

- **Pose updates** are token-bucketed per member: 40 in the bucket, refilled
  at 30/s. Going over budget silently drops the extra pose messages — it
  never disconnects you. A player on bad wifi spamming poses is not an
  attacker; treating them like one would make the game unplayable exactly
  when it's already struggling.
- **Tag validation is distance-only.** The server has no signed distance
  field for the scene — that lives entirely in `scene.glsl`/`scene.wgsl` on
  the client — so it has no way to check line of sight. A seeker whose
  client thinks it can see a hider (and the server's last-known poses put
  them within `TAG_DISTANCE`) gets the tag, full stop, wall or no wall.

## What this is not

**This is a game for friends, not a cheat-proof system.** There is no
account system, no anti-cheat, no server-authoritative physics, and (per
the point above) no way for the server to stop a determined player from
walking through a wall to make a tag. A modified client can lie about its
pose, claim any name, and spam `tag` at anyone within range. None of that
is hardened against, on purpose — hardening it would mean building a
physics-authoritative server and duplicating the SDF server-side, which
`docs/multiplayer-spec.md` §7.2 explicitly rules out as the wrong trade for
"a shared garden you leave running with friends." If you need a
cheat-resistant multiplayer game, this isn't the codebase for it.

## Tests

```sh
node --test server/test/
```

Covers `ws.mjs`'s RFC6455 framing edge cases and `room.mjs`'s protocol
reducer, both without a socket (see invariant I8 — `room.mjs` has no I/O in
it at all, so its tests just call `createRoom`/`reduce`/`tick` directly with
a made-up clock). `mp-relay.mjs` (lane L6, `tools/test/`) is the suite that
exercises the real socket + real process end to end.

## Deploying the relay (what "friends can actually play" needs)

Until a relay is reachable on the public internet, the deployed site is
single-player by construction — not by bug. `net.js`'s `resolveRelayUrl()` has
exactly three sources: a `?relay=` query parameter, `assets/relay.json`, and
`ws://localhost:8787`. GitHub Pages is https, and the localhost branch is
deliberately barred there because a `ws://` dial from an https page is blocked
by the browser *silently*. So a Pages deploy with no `relay.json` resolves to
`no-relay` and shows a clean single-player garden.

Two things switch multiplayer on.

### 1. Run the relay somewhere

`server/Dockerfile` builds it. The relay has **zero npm dependencies** (see
`ws.mjs` — Node ships no WebSocket *server*, so this repo implements the RFC6455
framing rather than pulling in `ws`), so the image is just the base plus three
files, and there is no install step to break.

```sh
docker build -t sg-relay server/
docker run -p 8787:8787 -e SG_ALLOWED_ORIGINS=https://<owner>.github.io sg-relay
```

Any host that runs a container and terminates TLS works — Fly, Render, Railway.
All three inject `PORT`, which the image honours. You need TLS: the browser
requires `wss://` from an https page.

**Set `SG_ALLOWED_ORIGINS` before going public.** Without it the relay accepts
WebSocket upgrades from any origin and warns about it on every boot, which
means anyone's page can open rooms on your relay. Verified behaviour with the
allowlist set: matching origin gets `101`, any other origin gets `403`.

State is in memory. A room exists while someone is in it and is gone when the
last member leaves, so restarting the relay costs an in-progress round and
nothing else, and scaling is "run another one".

### 2. Tell the site where it is

Set the repository **variable** `SG_RELAY_URL` (Settings -> Secrets and
variables -> Actions -> Variables) to your `wss://` endpoint. `deploy.yml`
writes it into `site/assets/relay.json` at deploy time; unset means a
single-player deploy, and a non-`wss://` value fails the deploy loudly rather
than shipping multiplayer that appears broken for no visible reason.

A variable rather than a secret on purpose: this endpoint ships inside a public
artifact and is trivially readable from the deployed page. Marking it secret
would hide it from the people maintaining it without hiding it from anyone else.

### 3. P2P transport (Weekend integration)

The shipped default is the new peer-to-peer transport — `transport: "p2p"` in
`assets/relay.json`. The signaling endpoint is still a wss:// URL; the same
`SG_RELAY_URL` variable points at it. No separate process or port is required.

For ICE/TURN you may set the repository **secret** `SG_ICE_SERVERS_JSON` to
an array of `RTCIceServer`-shaped objects:

```json
[
  { "urls": "stun:stun.example.org:3478" },
  {
    "urls": "turn:turn.example.org:3478",
    "username": "<short-lived>",
    "credential": "<short-lived>",
    "credentialType": "password"
  }
]
```

`deploy.yml` validates this JSON with Node (NOT shell parsing) BEFORE the
final `assets/relay.json` is written — the file emitted by CI is always a
single, valid JSON document.

**Privacy and abuse notes for the operator.** This is a weekend ship and the
brief is explicit:

1. **Direct connectivity cannot be guaranteed.** Two visitors on hostile
   networks (symmetric NATs, captive portals) will fail peer-to-peer.
   Without TURN those visitors cannot play together.
2. **TURN may relay encrypted WebRTC traffic.** A TURN server sees the
   encrypted SRTP/SCTP-DTLS payload, never the plaintext gameplay. A TURN
   operator can see IP addresses, packet timing, and bandwidth use; they
   cannot see what players are editing.
3. **The signaling operator sees SDP/ICE and membership — but no
   gameplay.** The signaling endpoint carries `sg.signal.v1` messages
   (`hello` for join, `signal` for client→server→peer forwarding of SDP
   offers/answers and ICE candidates, `signal.welcome` /
   `signal.peer.join` / `signal.peer.leave` / `signal.host-lost` for
   server→client membership and host-loss notifications) only — never
   `sg.mp.v1` gameplay. The relay treats the forwarded SDP/ICE as
   opaque bytes it just relays, but the operator **can** read those
   descriptions and candidates because that is what signaling is. The
   relay sees no edits, poses, tunes, or game scores.
4. **Host authority / star topology.** The first member to reach the
   signal becomes the immutable host and runs `room-core.js`. The room
   caps at 8 members total (host + 7 peers); the 9th attempt is
   rejected with WebSocket close **1013** (`error{code:'room_full'}`
   immediately before the close). A host departure takes the whole room down — surviving
   members close with WebSocket code **1012** and the client surfaces a
   visible `closed` / "host lost" status. There is **no automatic
   retry** and **no silent promotion of a new host** on this path: the
   `code === 1012` branch in `site/js/organs/garden/net.js` returns
   before `scheduleReconnect()`, because re-dialling would land on a
   different room and never reconcile. The user has to explicitly
   reload or rejoin.
5. **Use short-lived TURN credentials.** Static or long-lived credentials
   embedded in the public site would expose the TURN service to abuse.
   The brief calls this out as a hard requirement for the ship.

### Playing locally, no deploy needed

```sh
node server/relay.mjs                      # :8787
python3 -m http.server -d site 8080        # then open http://localhost:8080
```
Both browsers on `http://localhost:8080/#/garden/<room>` find the relay through
the localhost branch, no configuration at all.
