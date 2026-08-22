# The Commons — multiplayer Shader Garden

**Status:** implementation spec, frozen. Every lane works from THIS file, not
from a summary of it.

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
decodeFrames(buf) -> { messages: string[], control: [...], rest: Buffer, fatal?: {code, reason} }
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
| `hello` | `protocol`, `room`, `name` | MUST be first. Wrong `protocol` -> close 1002. Room full (`MAX_MEMBERS=8`) -> `error{code:'room_full'}` then close 1013. |
| `pose` | `x,z,yaw,speed01,gait` | Non-finite or out-of-range -> ignored. Token bucket: `POSE_BUDGET=40` refilled 30/s; overflow -> silently dropped (never a disconnect — a laggy client is not an attacker). |
| `ring` | `inRing` | asserts the sender is inside the lectern radius. |
| `lease.request` | — | granted only if `lease.holder == null || expired`, **and** `member.inRing`. Otherwise `lease{...}` unchanged (a denial is just the current truth, not an error). |
| `lease.keepalive` | — | holder only; re-arms `expiresAt = now + LEASE_TTL_MS`. |
| `lease.release` | — | holder only. |
| `draft` | `componentId`, `body` | holder only; relayed to `*-except-from`; **never stored**. `body` capped at `MAX_BODY_BYTES=65536`. |
| `commit` | `componentId`, `body`, `baseEpoch` | holder only. `baseEpoch !== room.epoch` -> `reject{reason:'stale_epoch', epoch}`. On accept: `edits.set(componentId, body)` (or delete if body equals pristine marker `null`), `epoch++`, broadcast `commit` to `*`. |
| `tag` | `targetId` | seeker only, phase `seeking`. Server validates **distance only** (see §6.4). |
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

`site/assets/relay.json` ships with `{"url": null}` and is documented in
DEPLOY.md as the one operator-edited file.

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
| `mp-protocol.mjs` | `server/room.mjs` reducer + `server/ws.mjs` codec, no sockets, no browser. Lease grant/deny-out-of-ring/expiry/holder-leaves; stale-epoch reject; join snapshot completeness; pose token bucket; every framing case in §2.1. |
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
