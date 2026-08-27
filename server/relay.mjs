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

const TICK_HZ = 30;
// Signaling protocol — shares transport with sg.mp.v1 (same WS upgrade,
// ws.mjs codec, heartbeat, origin gate) but uses disjoint room state.
// `data` is forwarded exactly as the sender wrote it; the relay never
// inspects SDP/ICE.
const SIGNAL_PROTOCOL = 'sg.signal.v1';
const SIGNAL_MAX_MEMBERS = 8;
const SIGNAL_MAX_ROOMS = 64;

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

// Mirror of room.mjs's reducer-side name sanitizer: trim, slice to 24, default
// to 'wanderer'. Kept inline because the reducer does not export it.
function sanitizeName(name) {
  const s = typeof name === 'string' ? name.trim().slice(0, 24) : '';
  return s || 'wanderer';
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

export function startRelay({ port = 8787, host = '0.0.0.0', origins = null } = {}) {
  const rooms = new Map(); // id -> Room
  const conns = new Map(); // socket -> connection state
  let warnedOpenOrigin = false;

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

  // Signal rooms live in a separate Map so /healthz's `rooms` count does not
  // move when a signaling connection joins, and a host close in one mode
  // cannot affect the other.
  const signalRooms = new Map(); // id -> { id, hostId, members: Map<id, { id, name, conn }> }

  function getOrCreateSignalRoom(id) {
    let sigRoom = signalRooms.get(id);
    if (sigRoom) return sigRoom;
    if (signalRooms.size >= SIGNAL_MAX_ROOMS) return null;
    sigRoom = { id, hostId: null, members: new Map() };
    signalRooms.set(id, sigRoom);
    return sigRoom;
  }

  function reapEmptySignalRooms() {
    for (const [id, sigRoom] of signalRooms) {
      if (sigRoom.members.size === 0) signalRooms.delete(id);
    }
  }

  // First-message binding for sg.signal.v1. Returns false on a fatal close so
  // the caller can `return` out of handleData immediately.
  function bindSignalHello(conn, msg) {
    const sigRoom = getOrCreateSignalRoom(msg.room);
    if (!sigRoom) { closeConn(conn, 1013, 'server full'); return false; }
    if (sigRoom.members.size >= SIGNAL_MAX_MEMBERS) {
      // 9th-member refusal: close only, no in-band error (no client state
      // machine to reconcile against — onclose code is the only signal).
      closeConn(conn, 1013, 'room full');
      return false;
    }
    const id = socketKey(conn);
    const name = sanitizeName(msg.name);
    conn.roomId = msg.room;
    conn.signalId = id;
    conn.kind = 'signal';
    // First member is the immutable host. hostId is set exactly once at
    // room creation; only a host close + room delete can clear it.
    if (sigRoom.hostId === null) sigRoom.hostId = id;
    sigRoom.members.set(id, { id, name, conn });

    // Welcome to the joiner. peers is the snapshot a late joiner uses to
    // learn who to send its initial offer to — must exclude self even
    // though selfId is delivered separately.
    const peers = [];
    for (const m of sigRoom.members.values()) {
      if (m.id !== id) peers.push({ id: m.id, name: m.name });
    }
    const welcome = { t: 'signal.welcome', selfId: id, hostId: sigRoom.hostId, peers };
    if (conn.socket.writable) {
      try { conn.socket.write(encodeText(JSON.stringify(welcome))); } catch { /* gone */ }
    }
    if (peers.length > 0) {
      const joinMsg = { t: 'signal.peer.join', id, name };
      for (const m of sigRoom.members.values()) {
        if (m.id === id) continue;
        if (m.conn.socket.writable) {
          try { m.conn.socket.write(encodeText(JSON.stringify(joinMsg))); } catch { /* gone */ }
        }
      }
    }
    return true;
  }

  // Post-hello signal forwarding — the relay is a dumb pipe. Only
  // `{t:'signal', to, data}` is recognized; `data` round-trips verbatim.
  // Anything else (renamed `t`, missing `to`, extra fields) is silently
  // ignored so an extension layered on the same socket is not torn down.
  function handleSignalMessage(conn, msg) {
    if (msg.t !== 'signal') return;
    if (typeof msg.to !== 'string') return;
    const sigRoom = signalRooms.get(conn.roomId);
    if (!sigRoom) return;
    const target = sigRoom.members.get(msg.to);
    if (!target) return; // unknown id, or peer already left
    if (target.id === conn.signalId) return; // never echo to self
    const out = { t: 'signal', from: conn.signalId, data: msg.data };
    if (target.conn.socket.writable) {
      try { target.conn.socket.write(encodeText(JSON.stringify(out))); } catch { /* gone */ }
    }
  }

  // Tear-down for a signal connection. A guest close is a normal leave
  // notification; a host close evacuates the room entirely (no migration —
  // electing a new host is a WebRTC concern the relay is NOT taking on).
  function handleSignalClose(conn) {
    if (!conn.signalId) return; // never joined
    const sigRoom = signalRooms.get(conn.roomId);
    if (!sigRoom || !sigRoom.members.has(conn.signalId)) return; // already cleaned by a prior step
    const wasHost = sigRoom.hostId === conn.signalId;
    sigRoom.members.delete(conn.signalId);

    if (wasHost) {
      // host-lost first, then close frame 1012, on every remaining socket,
      // before destroying them. The clients receive the app message AND
      // the WS close — only both together mean "host is gone, reconnect".
      const hostLost = { t: 'signal.host-lost' };
      for (const m of sigRoom.members.values()) {
        if (m.conn.socket.writable) {
          try {
            m.conn.socket.write(encodeText(JSON.stringify(hostLost)));
            m.conn.socket.write(encodeClose(1012, 'host lost'));
          } catch { /* gone */ }
        }
        m.conn.socket.destroy();
      }
      signalRooms.delete(conn.roomId);
      return;
    }

    const leave = { t: 'signal.peer.leave', id: conn.signalId };
    for (const m of sigRoom.members.values()) {
      if (m.conn.socket.writable) {
        try { m.conn.socket.write(encodeText(JSON.stringify(leave))); } catch { /* gone */ }
      }
    }
    if (sigRoom.members.size === 0) signalRooms.delete(conn.roomId);
  }

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
    if (conn.kind === 'signal') { handleSignalClose(conn); return; }
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
          if (!bindSignalHello(conn, msg)) return;
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
        handleSignalMessage(conn, msg);
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
      let signalMembers = 0;
      for (const sigRoom of signalRooms.values()) signalMembers += sigRoom.members.size;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        rooms: rooms.size,
        members,
        signalRooms: signalRooms.size,
        signalMembers,
      }));
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
