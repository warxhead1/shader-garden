// site/js/organs/garden/room-core.js — single authoritative sg.mp.v1 reducer
// (Wave-5 §1 frozen contract). Loaded by server/room.mjs (Node relay) AND by
// the elected browser host; one source, byte-identical behavior, no shim.
// Pure reducer (invariant I8): no sockets, no timers, no Date.now — every
// function takes `nowMs`. Mutates-and-returns-self (see server/room.mjs's
// header for why). Browser-safe: no Node built-ins; UTF-8 byte counting via
// the WHATWG TextEncoder that ships in every browser since 2018 and Node 11+.

// ---- protocol constants (spec §2.3) ----
export const PROTOCOL = 'sg.mp.v1';
export const LEASE_TTL_MS = 20000;
export const POSE_HZ = 15;
export const MAX_MEMBERS = 8;
// MAX_ROOMS is enforced by relay.mjs when a `hello` names a room that does
// not exist yet — the reducer only ever sees one room.
export const MAX_ROOMS = 64;
export const MAX_BODY_BYTES = 65536;
// HEARTBEAT_MS is a frame-level concern driven by relay.mjs; never reaches
// the reducer. Exported for relay.mjs's one source of truth.
export const HEARTBEAT_MS = 15000;

// Tunes: a holder (lectern OR seeker role) can dial a named scalar uniform.
// The regex locks the shader-side identifier grammar; the value cap blocks
// NaN/Inf territory on the renderer side.
export const TUNE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const TUNE_VALUE_MAX_ABS = 1_000_000;

const POSE_BUDGET = 40;
const POSE_REFILL_PER_SEC = 30;
const HIDE_MS = 30000;
const SEEK_MS = 120000;
const OVER_MS = 10000;
const TAG_DISTANCE = 0.9;
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949; // hue spacing — see assignHue()

// UTF-8 byte length without Node's Buffer. TextEncoder ships in every
// browser since 2018 and in Node 11+, so both runtimes get the same answer
// without a polyfill. The hand-rolled fallback is purely belt-and-braces.
const UTF8_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function utf8ByteLength(s) {
  if (UTF8_ENCODER) return UTF8_ENCODER.encode(s).length;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { n += 4; i++; continue; }
    }
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return n;
}

export function createRoom(id, nowMs) {
  return {
    id,
    protocol: PROTOCOL,
    t0Ms: nowMs,
    epoch: 0,
    members: new Map(), // id -> Member; Map insertion order IS join order (spec §7.4 round-robin)
    edits: new Map(), // componentId -> committed body (pristine components are simply absent)
    lease: { holder: null, expiresAt: 0 },
    tunes: new Map(), // name -> latest value (projected to {} for the welcome)
    game: { phase: 'lobby', seekerId: null, endsAt: 0, found: new Set(), scores: {} },
    pending: [], // Pose[] since last tick() flush, deduped by id at flush time
    lastPoseFlushMs: nowMs,
  };
}

function sanitizeName(name) {
  const s = typeof name === 'string' ? name.trim().slice(0, 24) : '';
  return s || 'wanderer';
}

// Golden-ratio-conjugate stepping around the hue wheel: well-separated colors
// for however many members happen to be present.
function assignHue(room) {
  return (room.members.size * GOLDEN_RATIO_CONJUGATE) % 1;
}

function leaseFields(room, nowMs) {
  const holder = room.lease.holder;
  const m = holder ? room.members.get(holder) : null;
  return {
    t: 'lease', holder,
    holderName: m ? m.name : null,
    holderHue: m ? m.hue : null,
    expiresAt: room.lease.expiresAt,
    serverNowMs: nowMs,
  };
}

function gameFields(room) {
  const g = room.game;
  return { t: 'game', phase: g.phase, seekerId: g.seekerId, endsAt: g.endsAt, found: [...g.found], scores: { ...g.scores } };
}

function welcomeMessage(room, member, nowMs) {
  return {
    t: 'welcome',
    selfId: member.id, room: room.id, protocol: room.protocol,
    epoch: room.epoch, t0Ms: room.t0Ms, serverNowMs: nowMs, hue: member.hue,
    members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name, hue: m.hue })),
    edits: Object.fromEntries(room.edits), // every committed body, so a late joiner builds+compiles once (spec §5.3)
    // Snapshot the tunes as a plain object — the welcome is serialized, so
    // Maps are out, and a fresh `{}` keeps a late joiner from holding onto
    // a reference that would mutate under them.
    tunes: Object.fromEntries(room.tunes),
    lease: leaseFields(room, nowMs),
    game: gameFields(room),
  };
}

// Round-robin over join order, skipping the seeker of the round that just
// ended. room.game.seekerId still holds that previous value at the moment
// we're picking the next one, so this falls out of "start from the slot
// after it" with no extra state.
function pickSeeker(room) {
  const ids = [...room.members.keys()];
  if (ids.length === 0) return null;
  const prev = room.game.seekerId;
  if (prev == null) return ids[0];
  const idx = ids.indexOf(prev);
  if (idx === -1) return ids[0]; // previous seeker already left
  return ids[(idx + 1) % ids.length];
}

function refillPoseBudget(member, nowMs) {
  const elapsedMs = nowMs - member.lastPoseMs;
  if (elapsedMs <= 0) return;
  member.poseBudget = Math.min(POSE_BUDGET, member.poseBudget + (elapsedMs / 1000) * POSE_REFILL_PER_SEC);
  member.lastPoseMs = nowMs;
}

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function isRoleLeaseHolder(room, id) {
  return room.game.phase === 'seeking' && room.lease.holder === room.game.seekerId && room.lease.holder === id;
}

/**
 * @param {object} room from createRoom()/a previous reduce()/tick() call
 * @param {{from:string, msg:object, nowMs:number}} event
 * @returns {{room:object, sends:Array<{to:string, msg:object}>, close?:{to:string, code:number, reason:string}}}
 */
export function reduce(room, { from, msg, nowMs }) {
  if (!msg || typeof msg.t !== 'string') return { room, sends: [] };

  // hello MUST be first (spec §2.3). Anything else from a connection that
  // hasn't joined yet is a protocol violation, not a message we can act on.
  if (msg.t !== 'hello' && !room.members.has(from)) {
    return { room, sends: [], close: { to: from, code: 1002, reason: 'hello must be first' } };
  }

  switch (msg.t) {
    case 'hello': {
      if (room.members.has(from)) return { room, sends: [] }; // duplicate hello: ignore
      if (msg.protocol !== room.protocol) {
        return { room, sends: [], close: { to: from, code: 1002, reason: 'protocol mismatch' } };
      }
      if (room.members.size >= MAX_MEMBERS) {
        return {
          room,
          sends: [{ to: from, msg: { t: 'error', code: 'room_full', message: 'room is full' } }],
          close: { to: from, code: 1013, reason: 'room full' },
        };
      }
      const member = {
        id: from,
        name: sanitizeName(msg.name),
        hue: assignHue(room),
        pose: { x: 0, z: 0, yaw: 0, speed01: 0, gait: 0 },
        inRing: false,
        lastPoseMs: nowMs,
        poseBudget: POSE_BUDGET,
      };
      room.members.set(from, member);
      return {
        room,
        sends: [
          { to: from, msg: welcomeMessage(room, member, nowMs) },
          { to: '*-except-from', msg: { t: 'peer.join', id: from, name: member.name, hue: member.hue } },
        ],
      };
    }

    case 'pose': {
      const member = room.members.get(from);
      const { x, z, yaw, speed01, gait } = msg;
      if (![x, z, yaw, speed01, gait].every(isFiniteNumber)) return { room, sends: [] };
      if (speed01 < 0 || speed01 > 1) return { room, sends: [] };
      refillPoseBudget(member, nowMs);
      if (member.poseBudget < 1) return { room, sends: [] }; // overflow: silently dropped, never a disconnect (spec §2.3)
      member.poseBudget -= 1;
      member.pose = { x, z, yaw, speed01, gait };
      room.pending.push({ id: from, x, z, yaw, speed01, gait });
      return { room, sends: [] };
    }

    case 'ring': {
      const member = room.members.get(from);
      const wasInRing = member.inRing;
      const next = !!msg.inRing;
      member.inRing = next;
      // The lectern is gated on `inRing`: if the holder steps out, the lease
      // is released IMMEDIATELY rather than waiting for the TTL — otherwise
      // a holder who walked away would still block anyone else for up to
      // LEASE_TTL_MS. The seeker's role lease during `seeking` is exempt:
      // the round owns it, not the lectern.
      if (wasInRing && !next && room.lease.holder === from && !isRoleLeaseHolder(room, from)) {
        room.lease.holder = null;
        room.lease.expiresAt = 0;
        return { room, sends: [{ to: '*', msg: leaseFields(room, nowMs) }] };
      }
      return { room, sends: [] };
    }

    // A "for friends, not a cheat-proof" game is unplayable when everyone
    // is `wanderer`. Same sanitizer as join — 24 chars, trimmed, never empty.
    case 'rename': {
      const member = room.members.get(from);
      const next = sanitizeName(msg.name);
      if (member.name === next) return { room, sends: [] };
      member.name = next;
      return { room, sends: [{ to: '*', msg: { t: 'peer.rename', id: from, name: next } }] };
    }

    case 'lease.request': {
      const member = room.members.get(from);
      // During `seeking` the lease belongs to the seeker by role, so the
      // lectern is inert: anyone else gets the current truth back.
      if (room.game.phase === 'seeking' && from !== room.game.seekerId) {
        return { room, sends: [{ to: from, msg: leaseFields(room, nowMs) }] };
      }
      const expired = room.lease.holder == null || nowMs >= room.lease.expiresAt;
      if (expired && member.inRing) {
        room.lease.holder = from;
        room.lease.expiresAt = nowMs + LEASE_TTL_MS;
        return { room, sends: [{ to: '*', msg: leaseFields(room, nowMs) }] };
      }
      // Denial is just the current truth, not an error (spec §2.3) — tell
      // only the requester so their UI can reconcile; nobody else changed.
      return { room, sends: [{ to: from, msg: leaseFields(room, nowMs) }] };
    }

    case 'lease.keepalive': {
      if (room.lease.holder !== from) return { room, sends: [] };
      // Role lease doesn't tick the lectern TTL — it ends with the round.
      if (isRoleLeaseHolder(room, from)) return { room, sends: [] };
      room.lease.expiresAt = nowMs + LEASE_TTL_MS;
      return { room, sends: [] };
    }

    case 'lease.release': {
      if (room.lease.holder !== from) return { room, sends: [] };
      // Same role-lease exception as keepalive.
      if (isRoleLeaseHolder(room, from)) return { room, sends: [] };
      room.lease.holder = null;
      room.lease.expiresAt = 0;
      return { room, sends: [{ to: '*', msg: leaseFields(room, nowMs) }] };
    }

    case 'draft': {
      if (room.lease.holder !== from) return { room, sends: [] };
      const body = typeof msg.body === 'string' ? msg.body : '';
      if (utf8ByteLength(body) > MAX_BODY_BYTES) return { room, sends: [] };
      return { room, sends: [{ to: '*-except-from', msg: { t: 'draft', from, componentId: msg.componentId, body } }] };
    }

    case 'commit': {
      if (room.lease.holder !== from) return { room, sends: [] };
      if (msg.baseEpoch !== room.epoch) {
        return { room, sends: [{ to: from, msg: { t: 'reject', reason: 'stale_epoch', epoch: room.epoch } }] };
      }
      const body = msg.body;
      if (body !== null && utf8ByteLength(String(body)) > MAX_BODY_BYTES) {
        return { room, sends: [{ to: from, msg: { t: 'reject', reason: 'body_too_large', epoch: room.epoch } }] };
      }
      // `null` is the pristine marker — drops the override instead of
      // storing an explicit copy.
      if (body === null) room.edits.delete(msg.componentId);
      else room.edits.set(msg.componentId, body);
      room.epoch += 1;
      return { room, sends: [{ to: '*', msg: { t: 'commit', epoch: room.epoch, componentId: msg.componentId, body, by: from } }] };
    }

    // Tune: only the current lease holder (lectern OR role lease during
    // seeking) can move a @tune slider. The name must match the shader-side
    // identifier grammar; the value is bounded in absolute magnitude so a
    // bad client can't push a uniform into NaN/Inf territory. Latest wins,
    // broadcast so other clients' UIs reflect what was dialed.
    case 'tune': {
      if (room.lease.holder !== from) return { room, sends: [] };
      if (typeof msg.name !== 'string' || !TUNE_NAME_RE.test(msg.name)) return { room, sends: [] };
      if (!isFiniteNumber(msg.value) || Math.abs(msg.value) > TUNE_VALUE_MAX_ABS) return { room, sends: [] };
      const value = msg.value;
      room.tunes.set(msg.name, value);
      return { room, sends: [{ to: '*', msg: { t: 'tune', name: msg.name, value, by: from } }] };
    }

    // Snapshot: a joined member who needs the full room state again (e.g.
    // after a UI re-mount) asks for one. Returns a FRESH complete welcome
    // only to the requester; state unchanged, no broadcast.
    case 'snapshot.request': {
      const member = room.members.get(from);
      if (!member) return { room, sends: [] };
      return { room, sends: [{ to: from, msg: welcomeMessage(room, member, nowMs) }] };
    }

    case 'tag': {
      const member = room.members.get(from);
      if (room.game.phase !== 'seeking' || from !== room.game.seekerId) return { room, sends: [] };
      const target = room.members.get(msg.targetId);
      if (!target) return { room, sends: [] };
      const dx = member.pose.x - target.pose.x;
      const dz = member.pose.z - target.pose.z;
      // No SDF on the server, so distance against last-known poses is the
      // entire trust model (spec §7.4/§6.4) — a griefing surface (clipping
      // through the sponge to tag through a wall) that's accepted on purpose:
      // "a game for friends, not a cheat-proof system".
      if (Math.hypot(dx, dz) >= TAG_DISTANCE) return { room, sends: [] };
      room.game.found.add(msg.targetId);
      room.game.scores[from] = (room.game.scores[from] || 0) + 1;
      // Everyone found ends the round NOW. Without this the phase timer ran
      // the full SEEK_MS regardless — dead time that reads as broken rather
      // than won. Counted against live members (minus seeker) so a hider who
      // disconnects mid-round cannot leave the round unwinnable.
      const hidersLeft = [...room.members.keys()]
        .filter((id) => id !== room.game.seekerId && !room.game.found.has(id));
      const sends = [];
      if (hidersLeft.length === 0) {
        room.game.phase = 'over';
        room.game.endsAt = nowMs + OVER_MS;
        sends.push(...releaseRoleLease(room, nowMs));
      }
      return { room, sends: [{ to: '*', msg: gameFields(room) }, ...sends] };
    }

    // Not in spec §2.3's table (which never says how `lobby -> hiding`
    // triggers despite §7.4 requiring ">=2 members, anyone presses Start").
    // Type string agreed with lane L2 (net.js's startGame()).
    case 'game.start': {
      if (room.game.phase !== 'lobby' || room.members.size < 2) return { room, sends: [] };
      room.game.phase = 'hiding';
      room.game.seekerId = pickSeeker(room);
      room.game.endsAt = nowMs + HIDE_MS;
      room.game.found = new Set();
      return { room, sends: [{ to: '*', msg: gameFields(room) }] };
    }

    case 'ping': {
      return {
        room,
        sends: [{ to: from, msg: { t: 'time', serverNowMs: nowMs, t0Ms: room.t0Ms, echo: { id: msg.id, clientSendMs: msg.clientSendMs } } }],
      };
    }

    default:
      return { room, sends: [] }; // unknown app-level type: ignore, don't punish an older/newer client
  }
}

// relay.mjs's pure entry point for "this socket is gone" (raw TCP close
// carries no protocol message). Mutates Room/Member state like reduce() and
// obeys the same no-I/O rule.
export function removeMember(room, id, nowMs) {
  if (!room.members.has(id)) return { room, sends: [] };
  room.members.delete(id);
  const sends = [{ to: '*', msg: { t: 'peer.leave', id } }];
  if (room.lease.holder === id && !isRoleLeaseHolder(room, id)) {
    room.lease.holder = null;
    room.lease.expiresAt = 0;
    sends.push({ to: '*', msg: leaseFields(room, nowMs) });
  }
  if (room.game.seekerId === id && (room.game.phase === 'hiding' || room.game.phase === 'seeking')) {
    // Seeker disconnecting mid-round would otherwise hang 'seeking' forever
    // (nobody left who can tag) — end the round instead.
    room.game.phase = 'over';
    room.game.endsAt = nowMs + OVER_MS;
    sends.push({ to: '*', msg: gameFields(room) });
    sends.push(...releaseRoleLease(room, nowMs));
  }
  return { room, sends };
}

function flushPoses(room, nowMs) {
  room.lastPoseFlushMs = nowMs;
  if (room.pending.length === 0) return [];
  // Dedupe to each member's latest pose this tick — mid-flush intermediate
  // positions are stale the instant a newer one for the same id exists.
  const latest = new Map();
  for (const p of room.pending) latest.set(p.id, p);
  room.pending = [];
  const all = [...latest.values()];
  const sends = [];
  for (const id of room.members.keys()) {
    const forThis = all.filter((p) => p.id !== id); // self excluded (spec §2.3)
    if (forThis.length > 0) sends.push({ to: id, msg: { t: 'poses', poses: forThis } });
  }
  return sends;
}

// "Sculptor's Tag" (docs/the-commons-design.md §0): during `seeking` the
// seeker does not walk around looking, they EDIT THE WORLD to flush people
// out — so the commit lease is assigned BY ROLE for the duration of the
// round instead of being taken at the lectern. The lectern stays the
// lobby-mode baton.
//
// Returned as sends so the transition broadcasts the new holder in the
// same tick as the phase change; a client that learns it is the seeker but
// not that it holds the lease cannot act on the mechanic.
function grantRoleLease(room, nowMs) {
  room.lease.holder = room.game.seekerId;
  // Held for the whole round: expiry is what the lectern's TTL is for, and
  // a seeker whose lease lapsed mid-round would silently lose the verb.
  room.lease.expiresAt = nowMs + SEEK_MS + OVER_MS;
  return [{ to: '*', msg: leaseFields(room, nowMs) }];
}

function releaseRoleLease(room, nowMs) {
  if (room.lease.holder !== room.game.seekerId) return [];
  room.lease.holder = null;
  room.lease.expiresAt = 0;
  return [{ to: '*', msg: leaseFields(room, nowMs) }];
}

function advanceGame(room, nowMs) {
  const g = room.game;
  if (g.phase === 'lobby' || nowMs < g.endsAt) return [];
  const extra = [];
  if (g.phase === 'hiding') {
    g.phase = 'seeking';
    g.endsAt = nowMs + SEEK_MS;
    extra.push(...grantRoleLease(room, nowMs));
  } else if (g.phase === 'seeking') {
    g.phase = 'over';
    g.endsAt = nowMs + OVER_MS;
    extra.push(...releaseRoleLease(room, nowMs));
  } else if (g.phase === 'over') {
    g.phase = 'lobby';
    g.endsAt = 0;
    g.found = new Set();
    // g.scores and g.seekerId deliberately survive into lobby: scores stay
    // visible on the scoreboard until the next round actually starts, and
    // seekerId is what pickSeeker() reads to skip the just-finished seeker.
  }
  return [{ to: '*', msg: gameFields(room) }, ...extra];
}

/**
 * Time-driven, not message-triggered: lease expiry, batched pose flush at
 * POSE_HZ, and game-phase advance (spec §2.2). relay.mjs calls this from
 * one setInterval at 30Hz; nothing here reads the wall clock itself.
 */
export function tick(room, nowMs) {
  const sends = [];
  // Role lease isn't on the lectern's TTL — it ends with the round, in
  // advanceGame(). Expiring it here would take the seeker's verb away
  // mid-round for no reason a player could see.
  const roleHeld = room.game.phase === 'seeking' && room.lease.holder === room.game.seekerId;
  if (room.lease.holder && !roleHeld && nowMs >= room.lease.expiresAt) {
    room.lease.holder = null;
    room.lease.expiresAt = 0;
    sends.push({ to: '*', msg: leaseFields(room, nowMs) });
  }
  if (nowMs - room.lastPoseFlushMs >= 1000 / POSE_HZ) {
    sends.push(...flushPoses(room, nowMs));
  }
  sends.push(...advanceGame(room, nowMs));
  return { room, sends };
}