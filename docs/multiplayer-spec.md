# The Commons — multiplayer Shader Garden

**Status:** implementation spec. **READ §0.5 FIRST — it corrects four claims in
this document that an adversarial audit proved wrong against the real code.**
Every lane works from THIS file, not from a summary of it.

A shared garden. Several people load the same world; the world is one GLSL
source file; one person at a time holds the right to change it; when they
commit, everyone's world becomes the new source. Hide-and-seek is the first
game played inside it.

Route: `#/garden/:room`. Solo `#/garden` is unchanged and MUST stay so.

---

## 0. The three facts this design is built on

1. **The world is a pure function of `(source, iTime)`.** No physics
   authority, no rollback, no prediction. Two clients running the same source
   at the same time render the same frame. Determinism is free — but ONLY if
   `iTime` agrees, which it does not today (`createClock()` starts at zero on
   page load, per client). Shared time is therefore the first slice, not a
   detail.
2. **`setUniforms()` is scalar-float-only on both backends.**
   `webgl2.js:455-458` does `gl.uniform1f(loc, value)`; `webgpu.js` mirrors it
   through `wrap.js`'s directive. Peer state is therefore FLATTENED into
   scalar uniforms. **Do not widen the runtime uniform contract** — it is
   specified in ARCHITECTURE.md, covered by `garden-wgsl-parity.mjs`, and
   changing it is not in scope.
3. **`GL2Runtime.setShader()` already keeps the previous program on failure**
   (`webgl2.js:73`). Half of "a broken shader must not blank everyone's world"
   is already true. What is missing is (a) the synchronous compile hitch, and
   (b) any validation before remote source reaches the runtime.

---

## 0.5 Corrections (audit, post-freeze) — these override anything below

An adversarial read of this spec against the actual code found four claims that
were wrong and would have poisoned a lane. Each was verified by hand before
being accepted. **Where this section conflicts with a later section, this
section wins.**

### C1 — SUPERSEDED. Multiplayer runs on WebGPU. The bank was raised, not worked around.

**This ruling originally said the opposite**, and the original text is worth
keeping in outline because the reasoning failed in an instructive way.

It observed, correctly, that `wrap.js` defined `WGSL_CUSTOM_UNIFORM_SLOTS =
32` — a fixed 8×`vec4f` bank, because WGSL has no name-addressed uniform
binding model — that `scene.wgsl` already spent 21 of those, that 50 peer
scalars could not fit, and that names past slot 32 were **silently
truncated** (so the failure would not even be loud). From that it concluded
multiplayer should pin to WebGL2, reusing the existing live-editing seam
which already rebuilds a WebGPU mount onto WebGL2.

Every fact in that chain was true. The conclusion was still wrong, because it
treated `32` as a constraint to design around rather than a number to change.
It was not a hardware limit, a driver limit, or a measured cost — it was one
arbitrary doubling (16 → 32 in wave 4) that had hardened into an assumption.
Designing the *primary* backend's capability around the *fallback*'s
accidental cap is backwards; WebGPU is the standard the garden is aimed at.

**The actual resolution:**

- `WGSL_CUSTOM_UNIFORM_SLOTS` is now **128** (32×`vec4f`). That is 512 bytes
  of uniform buffer against WebGPU's 64 KiB *minimum guaranteed* binding
  size — about 0.8% of the floor. Unused slots emit no accessor and are
  never read, so the raise costs nothing.
- The `vec4f` count in `WGSL_PRELUDE` is now **derived** from that constant
  instead of being a second hardcoded literal. Previously the struct said
  `array<vec4f, 8>` while `webgpu.js` computed its buffer size from the
  constant, so raising one without the other would have desynced the struct
  from the buffer filling it — a silent miscompile.
- `wgCustomUniformNames()` now **throws** on overflow instead of slicing.
  Silent truncation was the worst available behaviour: an over-bank name did
  not go missing, it never bound, so the shader read a stale slot and
  rendered plausibly wrong with no error anywhere.
- `scene.wgsl` carries the peer scalars and the real `sg_peers_sdf` body, not
  stubs. 75 names declared against 128 available.

**Consequences for the rest of this document:** every "MP pins to WebGL2"
statement below is superseded. MP runs on whichever backend the mount
selected. The WebGL2 path remains fully supported as the fallback — it is not
deprecated and its uniform handling is unchanged — but it is no longer the
only path multiplayer can run on, and no suite should pin to it *on account
of peers*. `prepareShader()` on WebGPU (§6.1) is back on the critical path.

### C2 — invariant I1 was impossible as written. Here is the real gate.

I1 said every existing garden suite stays green *unmodified*. Three of them
hard-code the component count: `garden.mjs:417` (`trayCount === 8`),
`garden.mjs:553` (`chips.length === 8`), `garden-connections.mjs:53`
(`components.length === 8`). `garden-wgsl-parity.mjs` asserts the
`@sg-uniforms` list matches an allowlist "no more, no less" — and its own
comment says "Grow this allowlist," so the codebase anticipated this.

Appending components necessarily changes those numbers. The count was never the
invariant worth protecting; **stable identity for ids 1..8 is**. So:
- Those four files are **owned by L6** and their count assertions are updated
  deliberately, in one commit, with the new count named in the test.
- Every id-1..8 identity and probe assertion stays untouched. A shift in those
  is the real regression and remains a hard failure.

### C3 — three shader details that would ship broken

- **New ids shade as rocks.** The shading branch handles terrain, character and
  pond explicitly and falls through to `COMP_ROCKS` (`scene.glsl:667`). Peers,
  lectern and sponge each need their own normal/material/colour branch, or they
  probe as ids 9-11 while wearing rock material.
- **Peer hue cannot survive the march.** `SGHit` carries only `{t, id}`
  (`scene.glsl:465`). An `out float hue` local does not cross that boundary.
  Either widen `SGHit` with a slot index, or recompute the nearest peer in the
  shading branch. Widening `SGHit` is preferred — it is one struct field and it
  keeps the shading branch cheap.
- **The escape loop is far too short.** §7.3's 8 iterations × 0.06 advance
  0.48 units total, against a sponge of half-extent 2.2. It must step by the
  actual distance magnitude (`t += max(|d|, 0.02)`), not a fixed epsilon, and
  it must evaluate the real candidate set — `sg_scene_min()` does not exist;
  the candidates are inlined in `sg_march`.

### C4 — `uCharGaitDist` is a DISTANCE accumulator, not a phase

§4.2's `sg_figure_sdf(..., gaitPhase, ...)` mis-names it. `index.js:524`
accumulates unwrapped world distance; the shader converts with
`fract(dist / SG_STRIDE_LEN)` and uses the **raw** value in its exact idle
fast path (`scene.glsl:169`). Passing a pre-fract'd phase changes locomotion
and breaks `garden-locomotion-parity.mjs`. The parameter is `gaitDist`, raw,
and each peer's is converted inside the figure function exactly as the local
character's is.

### C5 — smaller, but they bite

- `ctx.params` is a `URLSearchParams`. Read the room as `ctx.params.get('room')`,
  never `ctx.params.room`. (L5 already did this correctly.)
- `sharedTime()` returns `null` until the first sample lands. Do not seek on
  it: `seek(null)` becomes `Math.max(0, null) === 0` and rewinds the clock to
  zero every frame after the deadband. (L2 already guards this correctly.)
- CI test steps run from `tools/test`, but `server/` is top-level — the
  protocol suite path is `../../server/test/*.test.mjs`, or run it from the
  repo root.
- Two `serveSite()` calls derive the **same** pid-based port and ownership is
  checked only by `index.html` byte length, so the second can alias the first.
  A suite needing a site *and* a relay gives the relay its own explicit port
  rather than calling `serveSite()` twice.
- §4.2's early-out is **coherent and low-overhead, not free** — it still costs
  a call/compare/branch per march step across up to 88 steps. It must be
  measured against the existing solo budget, not asserted.

### C6 — §0.1's framing was too strong

"The world is a pure function of `(source, iTime)`" is false as stated: the
scene also reads `iResolution`, mouse-driven camera state, each client's own
character position, and the tune values. Shared time synchronises **world
animation** — which is what hide-and-seek needs, and why MP-1 is still the
first slice. It does not make two clients' frames identical, and nothing in
this design requires that.

---

## 1. Hard invariants (gates, not preferences)

| # | Invariant | How it is proved |
|---|---|---|
| I1 | `#/garden` (no room) behaves exactly as before: same components, same COMP ids, same probe results, same tune sliders. | All 8 existing `garden*` suites stay green, unmodified. |
| I2 | New `@component` blocks are **appended after `rocks`**, before the `---- scene wiring ----` section. COMP ids 1..8 never shift. | `garden.mjs` probe assertions unchanged and green. |
| I3 | With `uPeerCount == 0` and `uSpongeOn == 0` (the uniform default — unset floats read 0), the scene is **visually identical** to pre-change. | Peer/sponge SDFs return `1.0e4` on a uniform-valued early-out; `mp-solo-parity.mjs` asserts the guard exists and that a solo mount never sets those uniforms. |
| I4 | A syntactically broken committed body NEVER blanks a receiving client's world. | `mp-compile-swap.mjs`: commit garbage, assert receiver's canvas still renders non-blank and shows a rejection notice. |
| I5 | `scene.glsl` and `scene.wgsl` stay behaviourally paired. | `garden-wgsl-parity.mjs` green. |
| I6 | The site stays dependency-free. The relay stays dependency-free. | No new entry in any `package.json` `dependencies` outside `tools/test`. |
| I7 | Every new/grown file has a deliberate `tools/check_budgets.py` entry with a comment saying why. | `python3 tools/check_budgets.py` exits 0. |
| I8 | The relay's protocol logic is a **pure reducer** with no I/O, unit-tested without sockets. | `mp-protocol.mjs`. |

---

## 2. Slice MP-0 — the relay

New top-level `server/`. Node >= 22, **zero dependencies** (Node has no
built-in WebSocket *server*, so we write RFC6455 framing; it is ~200 lines and
it keeps the repo's "no build step, no npm" property intact).

### 2.1 `server/ws.mjs` — framing codec, pure functions

```
acceptKey(secWebSocketKey) -> string          // SHA-1 + magic GUID, base64
decodeFrames(buf, frag = null) -> { messages, control, rest, frag, fatal?: {code, reason} }
                             // `frag` carries in-progress fragment reassembly ACROSS calls; the
                             // caller threads it back in. The original stateless signature could
                             // not satisfy this section's own cross-call fragmentation requirement.
encodeText(str) -> Buffer                      // server frames are UNMASKED
encodeClose(code, reason) -> Buffer
encodePing() / encodePong(payload) -> Buffer
```

Requirements, each a test case:
- Client->server frames MUST be masked; an unmasked data frame is fatal
  (close **1002**).
- Payload lengths 0-125, 126 (16-bit), 127 (64-bit) all handled.
- Continuation frames (opcode 0) reassembled; a control frame interleaved
  mid-fragmentation is delivered without breaking reassembly.
- Control frames must not be fragmented and must be <= 125 bytes; violation is
  fatal (1002).
- Reserved bits set, or an unknown opcode -> fatal (1002).
- A message exceeding `MAX_MESSAGE_BYTES = 262144` is fatal (close **1009**).
- Partial buffers: `decodeFrames` is streaming — it returns `rest` and never
  throws on a truncated frame.
- Invalid UTF-8 in a text frame -> fatal (**1007**).

### 2.2 `server/room.mjs` — the pure reducer

**No sockets, no timers, no `Date.now()` inside.** Signature:

```
createRoom(id, nowMs) -> Room
reduce(room, { from, msg, nowMs }) -> { room, sends: [{to: id|'*'|'*-except-from', msg}], close?: {to, code, reason} }
tick(room, nowMs) -> { room, sends: [...] }    // lease expiry, pose flush, game phase advance
removeMember(room, id, nowMs) -> { room, sends: [...] }
// removeMember exists because a TCP close carries no protocol message of its
// own — the socket layer needs a pure entry point to say someone went away. It
// also ends a round early if the SEEKER left, rather than stranding the room in
// `seeking` with nobody able to tag.
```

`Room`:
```
{ id, protocol: 'sg.mp.v1', t0Ms, epoch, members: Map<id,Member>,
  edits: Map<componentId, body>,           // committed bodies only
  lease: { holder: id|null, expiresAt: ms },
  game: { phase: 'lobby'|'hiding'|'seeking'|'over', seekerId, endsAt, found: Set, scores: {} },
  pending: Pose[]                          // flushed by tick() at POSE_HZ
}
```
`Member`: `{ id, name, hue, pose, inRing: bool, lastPoseMs, poseBudget }`.

### 2.3 Protocol `sg.mp.v1`

One JSON object per WebSocket text message. `{ t: "<type>", ... }`.

**Client -> server**

| `t` | fields | rules |
|---|---|---|
| `hello` | `protocol`, `room`, `name` | MUST be first. Wrong `protocol` -> close 1002. Room full (`MAX_MEMBERS=8`) -> `error{code:'room_full'}` then close 1013. `room` is the authoritative room identity: a non-string, empty, or longer-than-128-char value -> close 1002 and no room/member created. |
| `pose` | `x,z,yaw,speed01,gait` | Non-finite or out-of-range -> ignored. Token bucket: `POSE_BUDGET=40` refilled 30/s; overflow -> silently dropped (never a disconnect — a laggy client is not an attacker). |
| `ring` | `inRing` | asserts the sender is inside the lectern radius. |
| `lease.request` | — | granted only if `lease.holder == null || expired`, **and** `member.inRing`. Otherwise `lease{...}` unchanged (a denial is just the current truth, not an error). A **denial** goes to the requester only; a **grant / expiry / release** broadcasts to `*`, because that is state everyone needs. `lease.keepalive` broadcasts nothing — re-arming every ~10s is not news. |
| `lease.keepalive` | — | holder only; re-arms `expiresAt = now + LEASE_TTL_MS`. |
| `lease.release` | — | holder only. |
| `draft` | `componentId`, `body` | holder only; relayed to `*-except-from`; **never stored**. `body` capped at `MAX_BODY_BYTES=65536`. |
| `commit` | `componentId`, `body`, `baseEpoch` | holder only. `baseEpoch !== room.epoch` -> `reject{reason:'stale_epoch', epoch}`. On accept: `edits.set(componentId, body)` (or delete if body equals pristine marker `null`), `epoch++`, broadcast `commit` to `*`. |
| `tag` | `targetId` | seeker only, phase `seeking`. Server validates **distance only** (see §6.4). |
| `start` | — | lobby only, >= 2 members. §7.4 requires "anyone presses Start" but the original table had no message for it, leaving `hiding` unreachable. |
| `ping` | `id`, `clientSendMs` | -> `time`. |

**Server -> client**

| `t` | fields |
|---|---|
| `welcome` | `selfId, room, protocol, epoch, t0Ms, serverNowMs, hue, members[], edits{}, lease, game` |
| `peer.join` / `peer.leave` | `id, name, hue` |
| `poses` | `[{id,x,z,yaw,speed01,gait}]` — batched, `POSE_HZ=15`, self excluded |
| `lease` | `holder, holderName, holderHue, expiresAt, serverNowMs` |
| `draft` | `from, componentId, body` |
| `commit` | `epoch, componentId, body, by` |
| `reject` | `reason, epoch` |
| `time` | `serverNowMs, t0Ms, echo:{id, clientSendMs}` |
| `game` | `phase, seekerId, endsAt, found[], scores` |
| `error` | `code, message` |

Constants: `LEASE_TTL_MS=20000`, `POSE_HZ=15`, `MAX_MEMBERS=8`,
`MAX_ROOMS=64`, `MAX_BODY_BYTES=65536`, `HEARTBEAT_MS=15000`
(ping; two missed pongs -> close 1001).

### 2.4 `server/relay.mjs`

`node:http` server + `upgrade` handler + socket<->reducer wiring + a single
`setInterval` driving `tick()` at 30 Hz + heartbeat. CLI: `--port` (default
8787), `--host`, `--origin <allowlist,...>` (default: allow all, warn once).
`GET /healthz` -> `{ok, rooms, members}`. Empty rooms are reaped.

**Room authority is `hello.room`, NOT the upgrade URL path.** The HTTP /
WebSocket upgrade URL path is transport addressing only — it does not choose
room membership. Before the first valid `hello` lands, the connection is
unbound to any room and any other message is a protocol violation (close
**1002**). On the first `hello`: validate `room` (non-empty string of at most
128 characters; otherwise close **1002** and create no room/member), bind the
connection to that exact room, get/create it subject to `MAX_ROOMS=64`, and
reduce `hello` there. The `MAX_ROOMS` cap is therefore enforced at the moment
a `hello` first names a never-before-seen room, not on every message — two
clients with the same `hello.room` always share a room regardless of upgrade
path, and two clients on the same upgrade path with different `hello.room`
values are always isolated.

Origin check: if an allowlist is configured, a mismatching `Origin` on upgrade
gets a 403 before any WebSocket handshake.

### 2.5 Relay discovery from the client

GitHub Pages is HTTPS, so a production relay MUST be `wss://`. Resolution
order in `site/js/organs/garden/net.js`:
1. `?relay=` query param (dev/testing escape hatch),
2. `assets/relay.json` -> `{ "url": "wss://..." }`, fetched best-effort-empty
   exactly like `registry.js`'s compositions loader,
3. on `localhost`/`127.0.0.1` only: `ws://<hostname>:8787`,
4. otherwise: no relay — the room route renders a "no relay configured"
   notice with the one-line command to run one. **Never** attempt `ws://` from
   an `https://` page.

`site/assets/relay.json` ships with `{ "url": null, "transport": "p2p",
"iceServers": [], "iceCredentialsUrl": null }` and is documented in
DEPLOY.md as the one operator-edited file. The optional
`iceCredentialsUrl` field is the public https URL of a short-lived TURN
credential vending endpoint — when set, `ice-credentials.js`'s
`fetchIceCredentials()` runs on every connect/reconnect, BEFORE
`createP2PSocket`, and merges the result with the public STUN list.
§2.6 + §2.7 cover the fetch contract and validation.

### 2.6 Weekend P2P integration — transport selection

The legacy central-relay mode above remains fully supported. In addition the
`site/js/organs/garden/net.js` factory accepts a transport selector:

- `?transport=p2p` / `?transport=ws` query param overrides everything else,
- absent query, the `transport` field in `assets/relay.json` is the source of
  truth for production (deployed default: `"p2p"`),
- absent JSON transport, query-only `?relay=...` defaults to `"ws"` (the
  pre-P2P default) so the pre-existing test battery stays green.

P2P mode uses `site/js/multiplayer/p2p-socket.js`, dynamic-imported from
`net.js` so a non-room mount and a ws-only room never pay the bundle cost.
The p2p facade is WebSocket-shaped — same numeric `readyState` values
(`CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3`), same JSON-string `send`,
same `'open'/'message'/'close'` events — so the same `send()` /
`handleMessage()` paths in `net.js` serve both transports. `net.js` reads
`readyState === 1` numerically and never references `WebSocket.OPEN`, so
the two facades drive the same logic without a transport branch.

#### What the deployed config looks like

The deployed default is `transport: "p2p"` with an empty `iceServers`
list and `iceCredentialsUrl: null`. The CI workflow stamps
`SG_RELAY_URL` (the wss:// signaling endpoint hosted alongside the
static site), optionally `SG_ICE_SERVERS_JSON` (deploy-time operator
override for **public STUN-only** entries — any entry carrying
`username`, `credential`, or `credentialType` is rejected at stamp
time, per §2.7 below), and optionally `SG_ICE_CREDENTIALS_URL` (the
public https URL of a runtime credential vending endpoint) into
`site/assets/relay.json`. The `SG_ICE_SERVERS_JSON` value, if present,
is validated by the CI workflow as a JSON array of `RTCIceServer`-
shaped objects BEFORE the file is written — the file emitted by CI is
always a single JSON document, never a shell-printf that could break
parsing.

**`SG_ICE_SERVERS_JSON` is for public STUN only.** Long-lived TURN
credentials in the deployed artifact would expose the TURN service to
abuse (anyone reading the JS can reroute arbitrary traffic through
the operator's relay). The deploy workflow explicitly rejects any
entry that names `username`/`credential`/`credentialType`. Short-lived
TURN credentials belong in §2.7's runtime vending endpoint, not here.

#### Trust / privacy disclosures the operator must accept

This is a weekend ship and the brief is explicit that ICE/TURN credentials
embedded in the public site are visible to anyone who views source.

1. **Direct connectivity cannot be guaranteed.** Two visitors on hostile
   networks (symmetric NATs, firewalls, captive portals) will fail to
   establish a peer-to-peer connection. WebRTC's ICE layer probes every
   candidate combination and falls back to a TURN server when direct paths
   are blocked — without TURN, those visitors cannot play together.
2. **TURN may relay encrypted WebRTC traffic.** A TURN server is a relay
   for media/data — it sees the encrypted WebRTC packets but never the
   plaintext gameplay payload, because SRTP/SCTP-DTLS encrypts the entire
   payload end-to-end. A TURN operator can see IP addresses, packet
   timing, and bandwidth use. They CANNOT see what two players are
   editing.
3. **The signaling operator sees SDP/ICE and membership — but no
   gameplay.** The signaling transport (`SG_RELAY_URL`) carries
   `sg.signal.v1` messages: `hello` (the first message on a connection,
   names the room and the connecting member), `signal` (client→server→
   peer forwarding of SDP offers/answers and ICE candidates — the
   relay treats the payload as opaque bytes, but the operator **can**
   read the descriptions and candidates because that is the whole
   point of signaling), `signal.welcome` / `signal.peer.join` /
   `signal.peer.leave` / `signal.host-lost` (server→client membership
   and host-loss notifications). It carries **never** `sg.mp.v1`
   gameplay. The host's `room-core.js` reducer runs on the host's
   machine; the relay does not run a game reducer. A relay operator
   therefore has no view of the garden's state, edits, tunes, poses,
   or hide-and-seek scores.
4. **Host authority / star topology.** The first member to reach the
   signal becomes the immutable host for the room and runs the
   `room-core.js` reducer; every subsequent member sends gameplay over a
   data channel to that host, who then broadcasts back out. The room
   caps at 8 members total (host + 7 peers); the 9th attempt is
   rejected with WebSocket close 1013 and receives no signal.welcome, as tools/test/mp-relay.mjs proves. The brief calls this out as an honest star, not a mesh — a
   single host departure takes the whole room down, and the surviving
   members are FAIL-CLOSED: their `close` code is 1012 and the client
   surfaces a visible "host lost" / `closed` status (`net.js`'s
   `onStatus({ state: 'closed', message: 'host lost', code: 1012 })`).
   There is **no automatic retry** and **no silent promotion of a new
   host** on this path — re-dialling would land on a different room and
   never reconcile, so the code branches on `code === 1012` and returns
   before `scheduleReconnect()`. The user must explicitly reload or
   rejoin the room to continue.
5. **Short-lived ICE/TURN credentials are vendable at runtime;
   long-lived credentials embedded in the static site are NOT
   acceptable for this ship.** When TURN is enabled, the deploy
   workflow stamps the **URL** of a short-lived credential vending
   endpoint (`SG_ICE_CREDENTIALS_URL`, a public https URL) into
   `assets/relay.json`'s `iceCredentialsUrl` field; the actual
   credentials are requested by the browser just-in-time, never
   stitched into the static site. §2.7 covers the fetch contract
   and validation gate; the deploy workflow enforces the STUN-only
   constraint on `SG_ICE_SERVERS_JSON` (any entry carrying
   `username`/`credential`/`credentialType` is rejected at stamp
   time). The credentials themselves are short-lived (REST-style
   TTL) and never appear in storage or logs — the validation gate's
   error tags are short identifiers (`http-502`, `bad-json`, …),
   not the payload data.

### 2.7 Runtime ICE/TURN credential vending

`SG_ICE_SERVERS_JSON` covers the **public, non-secret STUN** half of
ICE configuration. TURN requires per-session credentials, and shipping
those in the static site is unacceptable (§2.6 trust disclosure 5). The
runtime vending flow is provider-neutral — any https endpoint that
returns the documented JSON shape works — and runs in
`site/js/multiplayer/ice-credentials.js`'s `fetchIceCredentials()`
helper, called from `connect()` BEFORE every `createP2PSocket()` (i.e.
every connect/reconnect attempt). The flow:

1. `connect()` reads `cfg.iceCredentialsUrl` (preserved by
   `resolveTransportConfig()` from `assets/relay.json`'s
   `iceCredentialsUrl` field).
2. If set, it issues `GET <url>` with `cache: 'no-store'`,
   `credentials: 'omit'`, and `Accept: application/json`. The
   omit-credentials flag stops the browser from sending cookies to
   the vending host across origins.
3. The response is validated against the contract below. Any failure
   is fail-closed: `createP2PSocket` is NOT called, the status pill
   surfaces the error tag (`ice-vend:<tag>`), and `scheduleReconnect`
   backs off.
4. On success, the ephemeral `iceServers` list is merged with the
   public STUN list (`cfg.iceServers`) — public STUN first, ephemeral
   TURN second. WebRTC tries all candidates in parallel; the ordering
   only affects DevTools visibility, not connectivity.
5. The merged list is passed to `createP2PSocket({ iceServers })`.
   Credentials NEVER appear in storage or logs — only the short error
   tag is observable on the failure path.

#### Vending endpoint contract

Request:
```
GET <SG_ICE_CREDENTIALS_URL>
Accept: application/json
(no cookies — `credentials: 'omit'`)
```

Response (success):
- HTTP 200 with `Content-Type: application/json` (the helper does not
  enforce the content-type, only the JSON body shape).
- Body is a JSON OBJECT:
  ```json
  {
    "iceServers": [
      { "urls": "turn:turn.example.com:3478?transport=udp",
        "username": "<short-lived>",
        "credential": "<short-lived>" },
      { "urls": ["turn:turn.example.com:3478?transport=tcp",
                 "turn:turn.example.com:443?transport=tcp"],
        "username": "<short-lived>",
        "credential": "<short-lived>" }
    ]
  }
  ```

Per-entry validation:
- `urls` is REQUIRED. String form: a non-empty URL string. Array
  form: a non-empty array of non-empty URL strings. Any other type
  fails closed.
- `username` and `credential` are OPTIONAL. When present, both must
  be strings (empty string allowed — WebRTC permits `username: ''`
  for non-authenticated entries).
- `credentialType` is not validated client-side (the spec allows
  `password` / `oauth`); a malformed value here surfaces as a
  WebRTC dial-time failure rather than a validation error, which is
  fine — the credential itself is short-lived.

Top-level body validation:
- Body MUST be a JSON OBJECT. Strings, arrays, numbers, booleans, null
  all fail closed (`not-object`).
- `iceServers` MUST be a non-empty array. Empty array fails closed
  (`empty-ice-servers`).
- Other top-level fields are ignored.

URL validation:
- `SG_ICE_CREDENTIALS_URL` itself must be `https://` in production;
  `http://localhost` is allowed on a non-https page for the test
  rig. Mixed content (http on https) is rejected.

Failure modes (all fail closed, all surface a short error tag, none
leak the payload):
- `no-url` — `iceCredentialsUrl` was empty.
- `bad-url` — URL didn't parse.
- `bad-protocol` — scheme was not http/https (e.g. ws://, file://).
- `http-not-localhost` — production http URL on a non-localhost host.
- `mixed-content` — http URL on an https page.
- `fetch-failed` — the fetch threw (network error, CORS rejection, …).
- `bad-response` — response missing `ok`/`status` (browser shim quirk).
- `http-<status>` — non-ok HTTP status (e.g. `http-401`, `http-502`).
- `bad-json` — body wasn't valid JSON.
- `not-object` — body wasn't a JSON object.
- `no-ice-servers` — body missing `iceServers` or `iceServers` was
  not an array.
- `empty-ice-servers` — `iceServers` is an empty array.
- `bad-entry` — an entry was not an object.
- `bad-urls` — an entry's `urls` was the wrong type, an empty string,
  an empty array, or an array containing non-string entries.
- `empty-urls` — an entry's `urls` was an empty string or empty array.
- `bad-username` / `bad-credential` — present but not a string.

Provider-neutrality is the point — Twilio Network Traversal, Cloudflare
Calls, Xirsys, and a hand-rolled `node:http` endpoint all work as long
as they return the documented shape. The vending host enforces auth
(API keys, mTLS, whatever the operator chooses); the browser only
sees the public-facing response.

What the repo ships: validation in `ice-credentials.js` + thin merge
plumbing in `net.js`, deploy-time stamping in
`.github/workflows/deploy.yml` (`SG_ICE_CREDENTIALS_URL` variable,
https-only), and unit tests in `tools/test/mp-ice-credentials.mjs`
covering every validation branch plus the merge contract.


---

## 3. Slice MP-1 — shared time

### 3.1 Offset estimation (`site/js/organs/garden/timesync.js`)

Client sends `ping{id, clientSendMs}`; server replies `time`. On reply:
```
rtt    = now - echo.clientSendMs
offset = serverNowMs + rtt/2 - now
```
Keep a ring of the last **8** samples and use the offset of the sample with
the **minimum RTT** — not the mean. Minimum-RTT selection is what makes this
robust under jitter; averaging drags the estimate toward whatever the worst
packet did. Ping every 2s for the first 5 samples, then every 15s.

`sharedTime() = (Date.now() + offset - t0Ms) / 1000`.

### 3.2 Clock adoption

The runtime owns the clock (`runtime.getClock()`, exposed on BOTH backends —
`webgl2.js:258`, `webgpu.js:399`) and ticks it from its own rAF. We do not
replace that loop. Instead, one rAF in the net layer:

```
const c = rh.runtime?.getClock(); if (!c) return;
const target = sharedTime();
if (Math.abs(c.time - target) > RESYNC_EPS) c.seek(target);
```
`RESYNC_EPS = 0.05`. The deadband is the whole point: a hard `seek()` every
frame would replace smooth accumulation with network jitter. Seeks become rare
after the first.

**Reapply after rebuild.** `rh.rebuild()` (context loss, backend pin) builds a
fresh runtime whose clock starts at 0. Time sync MUST be re-armed from
`onBuild()`, next to `applyCamUniforms()` — this is exactly the pattern that
file already documents for quality and camera uniforms. Missing this is the
single most likely bug in the slice.

---

## 4. Slice MP-2 — peers in the SDF

### 4.1 Uniforms (flattened, per §0.2)

`MAX_PEERS = 7` (8 players incl. self). Per slot `i` in `0..6`:

```
uniform float uPeer0Act;   // 0 or 1
uniform float uPeer0X;
uniform float uPeer0Z;
uniform float uPeer0Yaw;
uniform float uPeer0Gait;
uniform float uPeer0Speed;
uniform float uPeer0Hue;   // 0..1, HSV hue for this peer's body tint
```
...through `uPeer6*`. Plus `uniform float uPeerCount;`.

49 + 1 scalars. GLSL ES 3.00 guarantees >= 224 fragment uniform vectors and
this scene uses ~25 — comfortable. Slot assignment is **stable for the
lifetime of a member**: `net.js` keeps `id -> slot`, freed on `peer.leave`.
Never re-pack slots on leave (it would teleport an unrelated peer).

### 4.2 `scene.glsl` changes

**Refactor** `character` so the body SDF is parameterised instead of reading
`uChar*` globals directly:

```glsl
float sg_figure_sdf(vec3 p, vec3 center, float yaw, float gaitPhase, float speed01);
```
`sg_character_sdf(p, center)` becomes a thin wrapper that passes the `uChar*`
uniforms. This keeps every existing caller and the bounding-sphere early-out
intact. Mirror it 1:1 in `scene.wgsl`.

**Append** a new component AFTER `rocks`:

```glsl
// @component peers "Other Players" "..."
const float SG_PEER_MAX = 7.0;
float sg_peers_sdf(vec3 p, out float hue) {
  hue = 0.0;
  if (uPeerCount < 0.5) return 1.0e4;   // uniform-valued branch: fully coherent, free
  float best = 1.0e4;
  // one guarded block per slot — unrolled because we have no uniform arrays
  ...
  return best;
}
// @end
```
Each slot block is `if (uPeerNAct > 0.5) { ... }`. Every peer body is
`sg_figure_sdf` with a per-slot bounding-sphere early-out identical to the
one `sg_character_sdf` already uses (`scene.glsl:183`) — without it, 7 extra
full body evaluations per march step is a real regression, and
`garden-perf.mjs` will say so.

New id: `const float COMP_PEERS = 9.0;`. Added to `sg_march`'s candidate
chain after `dRock`.

### 4.3 No floating nameplates

The camera is computed entirely in-shader with **no JS-side reader**
(`scene.glsl:537` says so explicitly). A DOM nameplate needs a world->screen
projection, which means duplicating the camera in JS — precisely the
"hand-honored, driftable invariant" this codebase's own comments (see
`index.js`'s `PLAY_RADIUS` note) reject. Instead: each peer gets a **hue**,
and a DOM **roster panel** lists name + hue swatch + lease/role badge. Ship
that. Do not add a projection.

---

## 5. Slice MP-3 — the lectern (baton) and the draft mirror

### 5.1 Diegetic lock

Append a component `lectern` (`COMP_LECTERN = 10.0`): a low pedestal at
`SG_LECTERN_XZ = vec2(1.6, -1.4)`, radius `0.35`, height `0.6`. It **glows
with the holder's hue** when `uLeaseHeld > 0.5` (`uLeaseHue`), neutral stone
otherwise.

`LECTERN_RADIUS = 0.9`. JS (`net.js`) computes `inRing` from the local
`charX/charZ` it already integrates, and sends `ring` only on **transitions**
(never per frame). Server grants the lease only to an in-ring member;
stepping out auto-releases.

This makes the lock a place, which is the point. The UI affordance ("Take the
lectern") only appears while you are standing in it.

### 5.2 One writer, N readers

- Holder's component editor is normal.
- Non-holders get the SAME editor, `readOnly: true`, mirroring the holder's
  buffer live. `edit.js` gains a `readOnly` option; both doc adapters support
  it (`doc-adapter-codemirror.js` -> `EditorState.readOnly`,
  `doc-adapter-textarea.js` -> the `readonly` attribute). The read-only mirror
  is the feature, not the consolation prize: watching someone build the world
  around you is the thing.
- Drafts are debounced **150 ms** and are never persisted server-side.

### 5.3 Late joiners

`welcome.edits` carries every committed body. The joiner applies all of them
into `editedBodies`, then builds the scene source ONCE and compiles once —
never one compile per component. Without this a late joiner sees the pristine
world while everyone else sees the edited one, and nothing ever tells them.

---

## 6. Slice MP-4 — background compile, atomic swap

### 6.1 `webgl2.js`: `prepareShader()`

```
prepareShader(src, channels = 0) -> Promise<{ ok, log, messages, commit(): void, dispose(): void }>
```
- Compiles + links into a **side** program; the live program keeps rendering
  untouched.
- If `KHR_parallel_shader_compile` is available, poll
  `getProgramParameter(prog, COMPLETION_STATUS_KHR)` once per rAF instead of
  calling `getProgramParameter(prog, LINK_STATUS)` immediately — that is what
  actually removes the hitch, because `LINK_STATUS` forces a synchronous
  driver stall. Without the extension, fall back to synchronous link (correct,
  just hitchy) — never fail because the extension is missing.
- `commit()` swaps `_program`, clears `_customLocations`, re-resolves the fixed
  uniform locations, and **re-applies `_customUniforms`** — the persistence
  guarantee `setShader()` documents at `webgl2.js:216-219` must survive the
  swap. `dispose()` deletes the side program.
- `setShader(src)` is refactored to `prepareShader` + immediate `commit`,
  preserving its existing synchronous signature and its
  "previous program survives failure" contract **exactly**. Existing callers
  do not change.

`webgpu.js` already serialises `setShader` through a queue and is async; add
the same `prepareShader` shape there, sharing the swap semantics.

### 6.2 Two-sided validation (the anti-grief rule)

1. **Before sending** a `commit`, the holder runs `prepareShader` locally. A
   failure never leaves their machine — they see the diagnostics, the room
   sees nothing.
2. **On receiving** a `commit`, every client runs the existing
   `editor/admission-gate.js` static check first (cheap reject), then
   `prepareShader`. Only `commit()` on success. On failure: keep the old
   world, surface `"<name>'s change didn't compile here — still showing the
   previous world"`, and do NOT advance the locally-applied epoch.

Both sides. Belt and braces. This is I4 and it is the difference between a
toy and something you can leave running with friends in it.

---

## 7. Slice MP-5 — hide and seek

### 7.1 The sponge

Append `@component sponge` (`COMP_SPONGE = 11.0`): a Menger sponge, 4 IFS
iterations, box half-extent `2.2`, centred at `(0, 1.9, 0)`, gated on
`uSpongeOn > 0.5` (0 in solo -> `return 1.0e4`, satisfying I3). It is the
thing worth hiding in and it is the origin of this whole idea.

### 7.2 No collision — and why

There is no collision today (`PLAY_RADIUS` is a circle, and `index.js`
explicitly refuses to duplicate `SG_POND_XZ`/`SG_ROCK_XZ` in JS because a
hand-mirrored invariant drifts). Evaluating the sponge SDF in JS would be the
same mistake at four times the size. GPU readback per frame is not viable
(`probeAt` costs two `renderOnce()` calls).

So: **you pass through matter.** Hiding is purely visual occlusion — the
seeker genuinely cannot see you, because the raymarch genuinely does not
reach you. That is still hide-and-seek, and it is honest. Document it in the
room UI as "the garden is a ghost world". Real collision is future work and
needs an SDF the JS side can share, not a patch.

### 7.3 Camera-inside-geometry

Consequence of 7.2: `ro` can land inside solid. An SDF march from inside
solid never converges and renders garbage. Add to the top of `sg_march`, in
the scene-wiring section (not a component):

```glsl
// Advance the ray origin out of any solid it starts inside — without this a
// camera that ends up inside the sponge renders a garbage constant.
for (int i = 0; i < 8; i++) {
  float d0 = sg_scene_min(ro + rd * t, ...);
  if (d0 > 0.01) break;
  t += 0.06;
}
```
Bounded, uniform-ish, negligible. Mirror in WGSL.

### 7.4 Rules

Phases, all timed off **server** clock (`endsAt` in server-time; clients
already have the offset from MP-1 for free):

`lobby` -> (>=2 members, anyone presses Start) -> `hiding` (30 s, seeker's
`uSeekerBlind=1` renders a dark vignette) -> `seeking` (120 s) -> `over` (10 s
scoreboard) -> `lobby`.

Seeker: round-robin over join order, skipping the previous seeker.

**Tag** is client-detected, server-validated. The seeker's client checks
proximity (`< 0.6`) plus a line-of-sight ray it can only approximate, and
sends `tag{targetId}`. The server validates **distance only**, against its own
last-known poses (`< 0.9`, generous for latency). The server has no SDF and
cannot check line-of-sight — say so in the code comment rather than implying
authority the server does not have. **This is a game for friends, not a
cheat-proof system**, and the README says that out loud.

---

## 8. Where the code goes (lane partition — one owner per file)

`#/garden` and `#/garden/:room` are the SAME organ. Add `"/garden/:room"` to
the garden organ's `routes` in `organs.json` (`matchRoute` splits on `/` and
compares segment counts, so `/garden` and `/garden/:room` cannot collide).
`ctx.params.room` presence is what activates the net layer. **Do not fork
`garden/index.js`** — a copy would duplicate 684 lines and orphan 8 test
suites.

| Lane | Owns (exclusive) |
|---|---|
| **L1 relay** | `server/ws.mjs`, `server/room.mjs`, `server/relay.mjs`, `server/README.md` |
| **L2 net client** | `site/js/organs/garden/net.js`, `timesync.js`, `roster.js`, `site/assets/relay.json` |
| **L3 shader** | `site/assets/garden/scene.glsl`, `site/assets/garden/scene.wgsl` |
| **L4 runtime swap** | `site/js/runtime/webgl2.js`, `site/js/runtime/webgpu.js` |
| **L5 organ wiring** | `site/js/organs/garden/index.js`, `edit.js`, `site/assets/organs.json`, `site/css/main.css` |
| **L6 gates** | `tools/test/mp-*.mjs`, `tools/test/package.json`, `.github/workflows/test.yml`, `tools/check_budgets.py` |

L3 and L4 have no overlap with L5. L5 imports L2's modules by their specified
signatures; L2 must publish those signatures FIRST (see §9 wave order).

---

### 8.1 L2's published module surface (frozen — L5 codes against this)

`site/js/organs/garden/net.js` exports exactly one factory. L5 must not reach
past it into `timesync.js` or `roster.js`.

```js
// opts: {
//   room, relayUrl, name,
//   getPose:   () => ({x, z, yaw, speed01, gait}),   // read from index.js's integrator
//   setPeerUniforms: (obj) => void,                   // -> rh.runtime.setUniforms
//   onEdits:   (Map<componentId, body>) => void,      // late-join snapshot; apply ALL, compile ONCE
//   onCommit:  ({componentId, body, by, epoch}) => Promise<boolean>,  // false = failed locally
//   onDraft:   ({from, componentId, body}) => void,
//   onLease:   ({holder, holderName, holderHue, isSelf, expiresAt}) => void,
//   onRoster:  (members[]) => void,
//   onGame:    ({phase, seekerId, endsAt, found, scores}) => void,
//   onStatus:  ({state, message}) => void,            // 'connecting'|'live'|'retrying'|'failed'|'no-relay'
// }
export function connectRoom(opts) -> {
  sharedTime(): number|null,   // null until the first time sample lands
  armClock(runtime): void,     // call from onBuild() after EVERY (re)build — §3.2
  setInRing(bool): void,
  requestLease(): void, releaseLease(): void, keepLease(): void,
  sendDraft(componentId, body): void,          // debounced 150ms internally
  commit(componentId, body): Promise<{ok, reason?}>,  // resolves after server ack/reject
  tag(targetId): void,
  startGame(): void,
  getTransport(): 'p2p'|'ws'|null,             // visible transport indicator
  getP2PDiagnostics(): Promise<Array<{         // read-only, non-secret; see §8.2
    id, connectionState, iceConnectionState, selectedPairSource,
    localCandidateType, remoteCandidateType, protocol, relayProtocol,
    bytesSent, bytesReceived, currentRoundTripTime,
  }>>,
  destroy(): void,
}
```

Rules L2 owns and L5 must not reimplement: reconnect with backoff
(1s/2s/4s/8s, cap 8s, forever), peer slot assignment (`id -> slot`, stable for
a member's lifetime, freed on leave, **never re-packed**), the 150 ms draft
debounce, the pose send rate (15 Hz, and only when the pose actually changed),
`inRing` transition-only sends, and the min-RTT offset estimator.

L5 owns and L2 must not reach into: the DOM, the runtime, `editedBodies`,
`buildSceneSource()`, and every compile call. `net.js` never imports anything
from `site/js/runtime/`.

### 8.2 WebRTC diagnostics (`getP2PDiagnostics()`) — the non-secret whitelist

A two-household rehearsal has to answer four questions over a phone call:
is the pair connected, did it go direct or through a relay, is it UDP or
TCP, and are bytes moving. `getP2PDiagnostics()` is exactly that budget and
nothing more.

Implementation lives in `site/js/multiplayer/p2p-socket.js`
(`summarizeSelectedPair()` / `summarizePeerConnection()`, both exported so
tooling reuses the shipped sanitizer instead of re-deriving a second, leakier
copy). One entry per live `RTCPeerConnection`, built from
`RTCPeerConnection.getStats()`.

**Selected-pair resolution**, in order — browsers disagree on which members
they populate, so all three tiers are real:

1. the `transport` stat's `selectedCandidatePairId` → that exact
   `candidate-pair` (the spec path; `selectedPairSource: 'transport'`)
2. a `candidate-pair` with `selected === true`, or `nominated === true` with
   `state === 'succeeded'` (`'selected-flag'`)
3. any `candidate-pair` with `state === 'succeeded'` (`'succeeded'`)

No succeeded pair reports `selectedPairSource: 'none'` with null metrics —
"not connected yet" is distinguishable from "connected and idle", rather
than being papered over with zeros.

**Reported fields** (whitelist; each is assembled field-by-field, never
spread from a stats object):
`id`, `connectionState`, `iceConnectionState`, `selectedPairSource`,
`localCandidateType`, `remoteCandidateType`, `protocol`, `relayProtocol`,
`bytesSent`, `bytesReceived`, `currentRoundTripTime`.

**Never reported** — and never *read* from the stats report in the first
place, so a browser adding a new identifying member cannot leak through:
SDP, `address`/`ip`/`port`, `relatedAddress`/`relatedPort`, ICE server URLs,
TURN `username`/`credential`, and raw candidate strings. Candidate TYPE
(`host`/`srflx`/`prflx`/`relay`) is the coarse fact the operator needs: it
says "relayed" without saying "relayed via 203.0.113.7". Enum-valued fields
outside the known sets become `null` rather than being echoed back.

**Facade contract.** `net.js`'s `getP2PDiagnostics()` resolves `[]` — never
throws, never rejects — whenever there is nothing to report: `ws` transport,
solo, no socket, a socket without the method, or a socket that is not `OPEN`.
Callers get a stable array shape and never branch on transport.

**Rehearsal tooling.** `tools/test/mp-p2p-rehearsal.mjs` opens ONE local
browser peer against a supplied public URL and room and prints sanitized
diagnostics plus gameplay convergence on an interval, for a rehearsal with a
real friend on a real second network. It is provider-neutral (names no
STUN/TURN vendor) and prints no URL, address, candidate, SDP, or credential.
The evidence gates it feeds are enumerated in `DEPLOY.md` §6.3. The
automated `tools/test/mp-p2p-two-browsers.mjs` suite asserts the shape,
sanitization, selected pair, and advancing byte counters, but deliberately
does **not** assert a `relay` candidate type: it runs on loopback where the
honest answer is `host`, and a forced-TURN claim belongs to the manual
rehearsal where a TURN server actually exists.

---

## 9. Wave order

- **Wave A (parallel):** L1, L3, L4. All three are self-contained and have no
  cross-imports.
- **Wave B (parallel, after A):** L2 (needs L1's protocol frozen — it is, in
  §2.3), L6's non-browser suites (`mp-protocol.mjs` against L1).
- **Wave C:** L5 (needs L2's module surface), then L6's browser suites.
- **Wave D:** integration, full battery, adversarial review.

---

## 10. Gates

New suites, every one added to `tools/test/package.json` scripts AND
`.github/workflows/test.yml` as a **blocking** step (the non-blocking pattern
is reserved for the two suites that need a real GPU):

| Suite | Proves |
|---|---|
| `mp-protocol.mjs` | **Invoke as `node --test server/test/*.test.mjs` (glob), never `node --test server/test/` (bare directory).** On Node 26.7.0 the bare-directory form `require()`s the path instead of discovering tests — reproduced outside this repo, so it is a runtime behaviour change, not a repo issue. `server/room.mjs` reducer + `server/ws.mjs` codec, no sockets, no browser. Lease grant/deny-out-of-ring/expiry/holder-leaves; stale-epoch reject; join snapshot completeness; pose token bucket; every framing case in §2.1. |
| `mp-relay.mjs` | Real relay process, two clients using Node's **built-in global `WebSocket`** (no new dependency). Join, pose relay, lease handoff, commit broadcast, oversize rejection, heartbeat close. |
| `mp-clock.mjs` | Two pages in one room converge to within 50 ms of each other's `iTime`, and re-converge after a forced `rh.rebuild()`. |
| `mp-two-browsers.mjs` | Two puppeteer pages, one room: B's peer uniforms track A's movement; A's commit changes B's rendered scene; B's lease request is denied while A holds it; B's editor is read-only and mirrors A's draft. |
| `mp-compile-swap.mjs` | **I4.** Commit a broken body; receiver keeps rendering (canvas non-blank, no context loss), shows the rejection notice, and its epoch does not advance. Then commit a good body and assert it applies. |
| `mp-solo-parity.mjs` | **I1/I3.** `#/garden` never sets `uPeerCount`/`uSpongeOn`; all COMP ids 1..8 probe to the same components as before. |

Plus, unchanged and green: all 8 existing `garden*` suites, `smoke`,
`layout`, `loader`, and `python3 tools/check_budgets.py`.

`garden-perf.mjs` must stay within its existing budget on the SOLO route.
If the MP route is slower, that is acceptable and expected; the solo route
regressing is not.

---

## 11. Explicitly out of scope

Persistence across room restarts. Accounts. Voice. Collision. Mobile MP UI
beyond the existing joystick. Cheat-proofing. Spectator replay. A public
hosted relay.
