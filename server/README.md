# server/ — The Commons relay

A tiny, dependency-free WebSocket relay for multiplayer Shader Garden rooms
(`#/garden/:room`). It speaks one JSON-over-WebSocket protocol, `sg.mp.v1`,
and does three things: hands out a shared clock, relays player poses and
committed shader edits between the people in a room, and referees a simple
hide-and-seek game. See `docs/multiplayer-spec.md` §2 for the frozen design
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
  ships `{"url": null}` and is the one operator-edited file — see
  DEPLOY.md), the room route shows a "no relay configured" notice instead of
  silently trying and failing. It never attempts `ws://` from an `https://`
  page; that attempt is blocked by the browser before a single byte leaves
  the tab, so the failure would otherwise be silent and confusing.

## The protocol, `sg.mp.v1`

One JSON object per text WebSocket message, always `{ "t": "<type>", ... }`.

**Client -> server**

| `t` | Purpose |
|---|---|
| `hello` | Join a room. MUST be the first message on a connection. |
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
