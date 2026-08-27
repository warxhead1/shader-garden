// Shader Garden — server/signal.mjs
// sg.signal.v1: the relay's dumb-pipe WebRTC signaling protocol.
//
// It shares transport with sg.mp.v1 (same WS upgrade, ws.mjs codec, heartbeat,
// origin gate) but nothing else: disjoint room state, no reducer, no tick. The
// whole protocol is room membership + host assignment + opaque forwarding, and
// keeping it in its own file is what makes the central invariant checkable by
// reading one screen — `data` is forwarded exactly as the sender wrote it and
// the relay NEVER inspects SDP or ICE.
//
// relay.mjs owns sockets, timers and `process`; this module owns none of them.
// It reaches the wire only through the socket handles on connections the relay
// hands it, plus the two callbacks passed to createSignalHub().

import { encodeText, encodeClose } from './ws.mjs';

export const SIGNAL_PROTOCOL = 'sg.signal.v1';
export const SIGNAL_MAX_MEMBERS = 8;
export const SIGNAL_MAX_ROOMS = 64;

// Mirror of room.mjs's reducer-side name sanitizer: trim, slice to 24, default
// to 'wanderer'. Kept inline because the reducer does not export it.
function sanitizeName(name) {
  const s = typeof name === 'string' ? name.trim().slice(0, 24) : '';
  return s || 'wanderer';
}

// One best-effort write. Every send in this protocol is advisory: a peer whose
// socket died is already being torn down by the relay's close handler, so a
// failed write here is never worth propagating.
function send(conn, msg) {
  if (!conn.socket.writable) return;
  try { conn.socket.write(encodeText(JSON.stringify(msg))); } catch { /* gone */ }
}

/**
 * @param {object} deps
 * @param {(conn: object, code: number, reason: string) => void} deps.closeConn
 *        relay.mjs's close path — writes a close frame, then destroys.
 * @param {(conn: object) => string} deps.idFor
 *        relay.mjs's per-socket stable id (the same mint the mp pre-hello path
 *        uses), so a signal member id and an mp pre-hello id can never collide.
 */
export function createSignalHub({ closeConn, idFor }) {
  // Signal rooms live in a Map of their own so /healthz's `rooms` count does
  // not move when a signaling connection joins, and a host close in one mode
  // cannot affect the other.
  const rooms = new Map(); // id -> { id, hostId, members: Map<id, { id, name, conn }> }

  function getOrCreateRoom(id) {
    let room = rooms.get(id);
    if (room) return room;
    if (rooms.size >= SIGNAL_MAX_ROOMS) return null;
    room = { id, hostId: null, members: new Map() };
    rooms.set(id, room);
    return room;
  }

  // First-message binding for sg.signal.v1. Returns false on a fatal close so
  // the caller can `return` out of handleData immediately.
  function bindHello(conn, msg) {
    const room = getOrCreateRoom(msg.room);
    if (!room) { closeConn(conn, 1013, 'server full'); return false; }
    if (room.members.size >= SIGNAL_MAX_MEMBERS) {
      // 9th-member refusal: close only, no in-band error (no client state
      // machine to reconcile against — onclose code is the only signal).
      closeConn(conn, 1013, 'room full');
      return false;
    }
    const id = idFor(conn);
    const name = sanitizeName(msg.name);
    conn.roomId = msg.room;
    conn.signalId = id;
    conn.kind = 'signal';
    // First member is the immutable host. hostId is set exactly once at
    // room creation; only a host close + room delete can clear it.
    if (room.hostId === null) room.hostId = id;
    room.members.set(id, { id, name, conn });

    // Welcome to the joiner. peers is the snapshot a late joiner uses to
    // learn who to send its initial offer to — must exclude self even
    // though selfId is delivered separately.
    const peers = [];
    for (const m of room.members.values()) {
      if (m.id !== id) peers.push({ id: m.id, name: m.name });
    }
    send(conn, { t: 'signal.welcome', selfId: id, hostId: room.hostId, peers });
    if (peers.length > 0) {
      const joinMsg = { t: 'signal.peer.join', id, name };
      for (const m of room.members.values()) {
        if (m.id !== id) send(m.conn, joinMsg);
      }
    }
    return true;
  }

  // Post-hello forwarding — the relay is a dumb pipe. Only
  // `{t:'signal', to, data}` is recognized; `data` round-trips verbatim.
  // Anything else (renamed `t`, missing `to`, extra fields) is silently
  // ignored so an extension layered on the same socket is not torn down.
  function handleMessage(conn, msg) {
    if (msg.t !== 'signal') return;
    if (typeof msg.to !== 'string') return;
    const room = rooms.get(conn.roomId);
    if (!room) return;
    const target = room.members.get(msg.to);
    if (!target) return; // unknown id, or peer already left
    if (target.id === conn.signalId) return; // never echo to self
    send(target.conn, { t: 'signal', from: conn.signalId, data: msg.data });
  }

  // Tear-down for a signal connection. A guest close is a normal leave
  // notification; a host close evacuates the room entirely (no migration —
  // electing a new host is a WebRTC concern the relay is NOT taking on).
  function handleClose(conn) {
    if (!conn.signalId) return; // never joined
    const room = rooms.get(conn.roomId);
    if (!room || !room.members.has(conn.signalId)) return; // already cleaned by a prior step
    const wasHost = room.hostId === conn.signalId;
    room.members.delete(conn.signalId);

    if (wasHost) {
      // host-lost first, then close frame 1012, on every remaining socket,
      // before destroying them. The clients receive the app message AND
      // the WS close — only both together mean "host is gone, reconnect".
      for (const m of room.members.values()) {
        send(m.conn, { t: 'signal.host-lost' });
        if (m.conn.socket.writable) {
          try { m.conn.socket.write(encodeClose(1012, 'host lost')); } catch { /* gone */ }
        }
        m.conn.socket.destroy();
      }
      rooms.delete(conn.roomId);
      return;
    }

    const leave = { t: 'signal.peer.leave', id: conn.signalId };
    for (const m of room.members.values()) send(m.conn, leave);
    if (room.members.size === 0) rooms.delete(conn.roomId);
  }

  // /healthz counters. Reported separately from the mp room/member counts so
  // one protocol's load is never mistaken for the other's.
  function stats() {
    let members = 0;
    for (const room of rooms.values()) members += room.members.size;
    return { signalRooms: rooms.size, signalMembers: members };
  }

  return { bindHello, handleMessage, handleClose, stats };
}
