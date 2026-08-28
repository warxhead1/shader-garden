#!/usr/bin/env node
// Shader Garden — server/relay.mjs
// The only file in server/ that touches a socket, a clock, or `process`.
// Everything protocol-shaped lives in room.mjs (pure reducer) and ws.mjs
// (pure codec); this file's whole job is wiring: accept an HTTP upgrade,
// decode/encode frames on the raw socket, feed the reducer, deliver its
// `sends`, and drive one setInterval that calls tick(). Node has no
// WebSocket *server* built in (only the client global, added in v22), which
// is why ws.mjs exists instead of `npm install ws` — invariant I6 keeps this
// repo dependency-free end to end.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  acceptKey,
  decodeFrames,
  encodeText,
  encodeClose,
  encodePing,
  encodePong,
} from './ws.mjs';
import { createRoom, reduce, tick, removeMember, PROTOCOL, MAX_ROOMS, HEARTBEAT_MS } from './room.mjs';
// sg.signal.v1 lives entirely in signal.mjs: room membership, host assignment,
// opaque forwarding, leave/host-loss teardown, its own limits and counters.
// This file only picks the protocol on hello and dispatches into that module.
import { createSignalHub, SIGNAL_PROTOCOL } from './signal.mjs';
// ICE/TURN credentials endpoint: pure parsing + crypto helpers live in
// ice-credentials.mjs; the HTTP wiring (origin gating, OPTIONS preflight,
// rate limiting, response shaping) lives here so all socket I/O stays in
// this one file. See server/README.md and server/test/ice-credentials.test.mjs.
import {
  ICE_CREDENTIALS_PATH,
  ICE_CREDENTIALS_PATH_METHODS,
  buildCredentials,
  buildResponse,
  clampTtl,
  clampRatePerMinute,
  createRateLimiter,
  isEndpointEnabled,
  parseAllowedOrigins,
  parseTurnUrls,
  safeHeader,
} from './ice-credentials.mjs';

const TICK_HZ = 30;

function parseArgs(argv) {
  const args = { port: 8787, host: '0.0.0.0', origins: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--origin') {
      args.origins = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return args;
}

// Resolve the ICE-credentials endpoint config from the environment. The
// shared secret is read HERE (so it never escapes into logs/CLI args) and is
// only ever passed by reference to buildCredentials(). Returning a frozen
// object means callers can stash it without worrying about mutation.
export function resolveIceConfig(env) {
  const sharedSecret = typeof env.SG_TURN_SHARED_SECRET === 'string' ? env.SG_TURN_SHARED_SECRET : '';
  const turnUrls = parseTurnUrls(env.SG_TURN_URLS);
  const ttlSeconds = clampTtl(env.SG_TURN_TTL_SECONDS);
  const ratePerMinute = clampRatePerMinute(env.SG_TURN_CREDENTIALS_PER_MINUTE);
  // SG_ALLOWED_ORIGINS is the source of truth for HTTP origin gating on the
  // /ice-credentials endpoint. --origin CLI list is still the WebSocket
  // upgrade allowlist (kept separate so a deployment can lock the
  // credential endpoint tighter than the signaling endpoint if it wants).
  // Both are merged so an operator only has to set one env var.
  const merged = new Set();
  for (const o of parseAllowedOrigins(env.SG_ALLOWED_ORIGINS)) merged.add(o);
  const allowedOrigins = [...merged];
  return Object.freeze({
    enabled: isEndpointEnabled({ sharedSecret, turnUrls }),
    sharedSecret, // reference only — never logged, never serialized
    turnUrls: turnUrls || [],
    ttlSeconds,
    ratePerMinute,
    allowedOrigins,
  });
}

/** Per-socket state. `roomId` is bound on the first valid hello.room; pre-hello,
 *  the connection belongs to no room. `kind` ('mp' | 'signal') is set on that
 *  same hello from msg.protocol and drives every subsequent dispatch in
 *  handleData/handleClose. The two modes share this struct but use disjoint
 *  room Maps so 'foo' in sg.signal.v1 is independent of 'foo' in sg.mp.v1.
 */
function makeConnection(socket) {
  return {
    socket,
    roomId: null, // bound on the first valid hello.room; null until then
    memberId: null, // mp-mode: assigned on hello via reduce(); null until then
    kind: null, // 'mp' | 'signal' — set on the first valid hello
    signalId: null, // signal-mode UUID; assigned on hello for sg.signal.v1
    buf: Buffer.alloc(0),
    frag: null,
    missedPongs: 0,
    awaitingPong: false,
    lastHeartbeatMs: 0, // set on first tick after connect; see interval below
  };
}

// Handle a request to /ice-credentials. This is the single HTTP entry point
// for the long-lived relay; it runs in the same createServer callback as
// /healthz so all socket I/O stays in this one file. The shared secret is
// read once at boot and only ever held by reference inside `ice.sharedSecret`
// — it is never logged, never echoed, and the response body never contains
// it (only the HMAC output).
export function handleIceCredentials(req, res, { ice, iceLimiter, nowMs, rng }) {
  const method = req.method;
  // Method gate: only GET and OPTIONS. Anything else is 405 with an Allow
  // header so debugging tools can see what is supported.
  if (!ICE_CREDENTIALS_PATH_METHODS.has(method)) {
    res.writeHead(405, {
      'content-type': 'text/plain',
      allow: 'GET, OPTIONS',
    });
    res.end('method not allowed');
    return;
  }

  // Disabled → 404 always, no CORS headers, no leak of which env var is
  // missing. A misconfigured page just sees the path as not existing.
  if (!ice.enabled) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  // Resolve the request Origin and strip anything that could smuggle a
  // header line through (CRLF / NUL) — we echo Origin back in ACAO and a
  // malicious Origin must never reach the response.
  const requestOrigin = safeHeader(req.headers.origin);

  // Origin gate: must exactly match one of the configured values. Empty
  // allowedOrigins ⇒ no origin allowed (production-safe default — when the
  // operator hasn't said who is allowed, we deny everyone).
  if (!requestOrigin || !ice.allowedOrigins.includes(requestOrigin)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  // CORS headers: ACAO is the *matched* origin (exact, never "*"), and
  // Vary: Origin is required so a downstream cache doesn't serve one
  // tenant's credentials to another.
  const corsHeaders = {
    'access-control-allow-origin': requestOrigin,
    vary: 'Origin',
    'cache-control': 'no-store',
    'content-type': 'application/json',
  };

  if (method === 'OPTIONS') {
    // Preflight: only GET/OPTIONS, only this path. We hard-code the
    // advertised methods (no echoing from Access-Control-Request-Method)
    // so a misbehaving client can't get us to advertise something the
    // endpoint doesn't actually support.
    res.writeHead(204, {
      ...corsHeaders,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  // GET path. Rate-limit BEFORE any crypto so a flood does not burn the
  // HMAC budget. The bucket key is the direct socket IP — X-Forwarded-For
  // is deliberately NOT consulted because we are at the edge of the trust
  // boundary; a reverse proxy that wants to enforce per-real-IP limits
  // should do so upstream and forward the real IP as the source.
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const rl = iceLimiter.check(ip);
  if (!rl.ok) {
    res.writeHead(429, {
      ...corsHeaders,
      'retry-after': String(rl.retryAfterSec),
    });
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return;
  }

  // Issue the credential. buildCredentials only returns null when the
  // secret is empty — the ice.enabled gate above already prevented that
  // case, so a returned null here is a defensive 500.
  const creds = buildCredentials({
    sharedSecret: ice.sharedSecret,
    ttlSeconds: ice.ttlSeconds,
    nowMs,
    rng,
  });
  if (!creds) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error');
    return;
  }
  const body = buildResponse({
    urls: ice.turnUrls,
    username: creds.username,
    credential: creds.credential,
    expiryUnix: creds.expiryUnix,
  });
  res.writeHead(200, corsHeaders);
  res.end(JSON.stringify(body));
}

export function startRelay({
  port = 8787,
  host = '0.0.0.0',
  origins = null,
  env = process.env,
  iceConfig: iceConfigOverride = null,
  nowMs = () => Date.now(),
  rng = randomUUID,
} = {}) {
  const rooms = new Map(); // id -> Room
  const conns = new Map(); // socket -> connection state
  let warnedOpenOrigin = false;
  // Resolve the ICE-credentials endpoint config once at boot; we never read
  // the shared secret from a request. The rate limiter is a single per-IP
  // bucket table that lives for the lifetime of the process.
  const ice = iceConfigOverride || resolveIceConfig(env);
  const iceLimiter = createRateLimiter({ perMinute: ice.ratePerMinute, nowMs });
  if (ice.enabled) {
    // One-line boot notice — does NOT include the secret. The TURN URL list
    // is public-by-design (it ends up in the issued credential anyway), so
    // logging its length / first host is fine.
    const hostHint = ice.turnUrls[0] ? ` (first: ${ice.turnUrls[0]})` : '';
    console.log(
      `[relay] /ice-credentials ENABLED ttl=${ice.ttlSeconds}s rate=${ice.ratePerMinute}/min urls=${ice.turnUrls.length}${hostHint}`
    );
  } else {
    console.log('[relay] /ice-credentials DISABLED (set SG_TURN_SHARED_SECRET and SG_TURN_URLS to enable)');
  }

  function getOrCreateRoom(id, nowMs) {
    let room = rooms.get(id);
    if (room) return room;
    if (rooms.size >= MAX_ROOMS) return null;
    room = createRoom(id, nowMs);
    rooms.set(id, room);
    return room;
  }

  function reapEmptyRooms() {
    for (const [id, room] of rooms) {
      if (room.members.size === 0) rooms.delete(id);
    }
  }

  // The signal-protocol half of this relay. It gets sockets only through the
  // connections handed to its three entry points, plus these two callbacks.
  const signal = createSignalHub({ closeConn, idFor: socketKey });

  function deliver(roomId, sends, exceptFrom) {
    if (!sends || sends.length === 0) return;
    for (const { to, msg } of sends) {
      const targets = resolveTargets(roomId, to, exceptFrom);
      const frame = encodeText(JSON.stringify(msg));
      for (const conn of targets) {
        if (conn.socket.writable) conn.socket.write(frame);
      }
    }
  }

  function resolveTargets(roomId, to, exceptFrom) {
    if (to === '*' || to === '*-except-from') {
      const out = [];
      for (const conn of conns.values()) {
        if (conn.roomId !== roomId || !conn.memberId) continue;
        if (to === '*-except-from' && conn.memberId === exceptFrom) continue;
        out.push(conn);
      }
      return out;
    }
    for (const conn of conns.values()) {
      if (conn.roomId === roomId && conn.memberId === to) return [conn];
    }
    return [];
  }

  function closeConn(conn, code, reason) {
    if (conn.socket.writable) {
      try {
        conn.socket.write(encodeClose(code, reason));
      } catch {
        // socket already going away; nothing left to do
      }
    }
    conn.socket.destroy();
  }

  function handleClose(conn) {
    conns.delete(conn.socket);
    if (conn.kind === 'signal') { signal.handleClose(conn); return; }
    if (!conn.memberId) return;
    const room = rooms.get(conn.roomId);
    if (!room) return;
    const { room: nextRoom, sends } = removeMember(room, conn.memberId, Date.now());
    rooms.set(conn.roomId, nextRoom);
    deliver(conn.roomId, sends, conn.memberId);
    reapEmptyRooms();
  }

  function handleData(conn, chunk) {
    conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
    const { messages, control, rest, frag, fatal } = decodeFrames(conn.buf, conn.frag);
    conn.buf = rest;
    conn.frag = frag;

    for (const c of control) {
      if (c.type === 'ping') {
        if (conn.socket.writable) conn.socket.write(encodePong(c.payload));
      } else if (c.type === 'pong') {
        conn.awaitingPong = false;
        conn.missedPongs = 0;
      } else if (c.type === 'close') {
        closeConn(conn, 1000, '');
        return;
      }
    }

    for (const raw of messages) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue; // malformed JSON: ignore rather than tear down the whole connection
      }
      const nowMs = Date.now();

      // Bind the connection to a room on the first valid hello. Per spec
      // §2.3 and this file's contract: the upgrade URL path is transport
      // addressing only — it does NOT choose room membership. Until that
      // hello arrives this connection is not a member of any room, and any
      // other message is a protocol violation.
      if (conn.roomId === null) {
        if (msg.t !== 'hello') {
          closeConn(conn, 1002, 'hello must be first');
          return;
        }
        // `hello.room` is the authoritative room identity. Spec contract:
        // a non-string, empty, or > 128-char value closes 1002 and creates
        // no room/member. Same gate applies to BOTH protocols.
        if (typeof msg.room !== 'string' || msg.room.length === 0 || msg.room.length > 128) {
          closeConn(conn, 1002, 'invalid room');
          return;
        }
        if (msg.protocol === SIGNAL_PROTOCOL) {
          if (!signal.bindHello(conn, msg)) return;
        } else {
          const room = getOrCreateRoom(msg.room, nowMs);
          if (!room) {
            // MAX_ROOMS is enforced HERE — once a hello names a never-before-
            // seen room, we either create it or refuse the connection. Doing
            // this at hello time (not on every message) means a single room
            // can't be created twice by two distinct hellos once the cap is
            // hit; the second hello sees the existing room and joins it.
            closeConn(conn, 1013, 'server full');
            return;
          }
          conn.roomId = msg.room;
        }
      }

      if (conn.kind === 'signal') {
        // Signal mode never touches the reducer; data is forwarded exactly,
        // framed only by relay-supplied `t` and `from`. Other shapes are
        // silent no-ops (the relay is a dumb pipe, not a session manager).
        signal.handleMessage(conn, msg);
        continue;
      }

      const room = rooms.get(conn.roomId);
      const from = conn.memberId || socketKey(conn);
      const result = reduce(room, { from, msg, nowMs });
      rooms.set(conn.roomId, result.room);

      // The first successful `hello` is what actually assigns memberId —
      // reduce() doesn't tell us that happened directly, so we detect it by
      // checking whether the `from` we sent now exists as a member.
      if (!conn.memberId && msg.t === 'hello' && result.room.members.has(from)) {
        conn.memberId = from;
      }

      deliver(conn.roomId, result.sends, conn.memberId || from);
      if (result.close) {
        closeConn(conn, result.close.code, result.close.reason);
        return;
      }
    }

    if (fatal) {
      closeConn(conn, fatal.code, fatal.reason);
    }
  }

  // Connections identify themselves to the reducer by memberId once hello
  // succeeds, but hello itself needs SOME stable id to reduce() against
  // before that happens (assignHue/room-full checks run inside reduce, not
  // before it). A per-socket random id, minted once, is that pre-hello id —
  // and it becomes the real memberId the instant hello is accepted.
  const socketIds = new WeakMap();
  function socketKey(conn) {
    let id = socketIds.get(conn.socket);
    if (!id) {
      id = randomUUID();
      socketIds.set(conn.socket, id);
    }
    return id;
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      let members = 0;
      for (const room of rooms.values()) members += room.members.size;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, members, ...signal.stats() }));
      return;
    }
    if (req.url === ICE_CREDENTIALS_PATH) {
      handleIceCredentials(req, res, { ice, iceLimiter, nowMs, rng });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (origins && origins.length > 0) {
      // Origin check happens BEFORE any WebSocket handshake bytes go out —
      // a mismatching Origin gets a bare HTTP 403 and the socket closes, so
      // an unauthorized page never even gets the 101 Switching Protocols
      // that would let it start speaking the protocol at us.
      if (!origin || !origins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    } else if (!warnedOpenOrigin) {
      warnedOpenOrigin = true;
      console.warn('[relay] no --origin allowlist configured — accepting WebSocket upgrades from any origin');
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const responseKey = acceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${responseKey}\r\n\r\n`
    );

    // The upgrade URL path is TRANSPORT addressing only. Room identity is
    // determined by the first valid `hello.room` on the connection (see
    // handleData), not by parsing the path. A connection is unbound to any
    // room until that hello arrives — anything else from a pre-hello
    // connection is a protocol violation (close 1002), so binding late
    // here is both safe and the spec-required behavior.
    const conn = makeConnection(socket);
    conns.set(socket, conn);
    if (head && head.length) handleData(conn, head);

    socket.on('data', (chunk) => handleData(conn, chunk));
    socket.on('close', () => handleClose(conn));
    socket.on('error', () => handleClose(conn));
  });

  // One interval drives everything time-based: reducer tick() for every
  // room at TICK_HZ, plus the heartbeat ping/pong that catches half-open TCP
  // connections (a laptop closing its lid drops no FIN packet — without an
  // application-level heartbeat that socket looks alive forever). The
  // heartbeat itself only fires every HEARTBEAT_MS, checked against each
  // connection's own clock rather than opening a second interval — one
  // timer driving two different cadences is simpler to reason about than
  // two timers that can drift relative to each other.
  const interval = setInterval(() => {
    const nowMs = Date.now();
    for (const [id, room] of rooms) {
      const { room: nextRoom, sends } = tick(room, nowMs);
      rooms.set(id, nextRoom);
      deliver(id, sends);
    }
    reapEmptyRooms();

    for (const conn of conns.values()) {
      if (nowMs - conn.lastHeartbeatMs < HEARTBEAT_MS) continue;
      conn.lastHeartbeatMs = nowMs;
      if (conn.awaitingPong) {
        conn.missedPongs += 1;
        if (conn.missedPongs >= 2) {
          closeConn(conn, 1001, 'heartbeat timeout');
          continue;
        }
      }
      conn.awaitingPong = true;
      if (conn.socket.writable) conn.socket.write(encodePing());
    }
  }, 1000 / TICK_HZ);

  server.listen(port, host);

  return {
    server,
    close() {
      clearInterval(interval);
      server.close();
      for (const conn of conns.values()) conn.socket.destroy();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const { server } = startRelay(args);
  server.on('listening', () => {
    console.log(`[relay] listening on ${args.host}:${args.port}${args.origins ? ` (origins: ${args.origins.join(', ')})` : ' (open origin — dev only)'}`);
  });
}
