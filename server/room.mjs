// Shader Garden — server/room.mjs
// The `sg.mp.v1` protocol as a PURE REDUCER (spec §2.2, invariant I8). No
// sockets, no timers, no `Date.now()` anywhere in this file — every function
// takes `nowMs` as a parameter instead. That is not a style preference: it
// is what makes `mp-protocol.mjs` able to fast-forward lease expiry, pose
// refill, and game-phase timers by simply calling `tick()` with a made-up
// clock, with no fake sockets and no real waiting. relay.mjs is the only
// file that is allowed to look at the wall clock or touch a socket; this
// file only ever answers "given this room and this event, what happens".
//
// A note on style: this reducer MUTATES the `room` object it is given and
// returns the same reference, rather than producing a structurally-shared
// copy. "Pure" here means "no I/O and fully determined by its arguments",
// not "immutable" — the room graph (Map of members, Set of found ids) would
// be expensive to deep-clone every 33ms tick for no test ever needs it, and
// every test in this repo asserts on the returned `room` reference, so
// mutate-and-return-self is both simpler and cheaper than the copying
// alternative.

// ---- protocol constants (spec §2.3) ----
export const PROTOCOL = 'sg.mp.v1';
export const LEASE_TTL_MS = 20000;
export const POSE_HZ = 15;
export const MAX_MEMBERS = 8;
// MAX_ROOMS is enforced by relay.mjs when a `hello` names a room that does
// not exist yet — the reducer only ever sees a single room and has no way
// to count how many others exist, so this constant is exported for relay.mjs
// to import rather than checked in here.
export const MAX_ROOMS = 64;
export const MAX_BODY_BYTES = 65536;
// HEARTBEAT_MS is a WebSocket-frame-level (ping/pong) concern that relay.mjs
// drives directly with ws.mjs's encodePing/encodePong against the raw
// socket — it never reaches the reducer, which only sees app-level messages.
// Exported here anyway so relay.mjs has one source of truth for the constant.
export const HEARTBEAT_MS = 15000;

const POSE_BUDGET = 40;
const POSE_REFILL_PER_SEC = 30;

const HIDE_MS = 30000;
const SEEK_MS = 120000;
const OVER_MS = 10000;
const TAG_DISTANCE = 0.9;

const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949; // hue spacing — see assignHue()

export function createRoom(id, nowMs) {
  return {
    id,
    protocol: PROTOCOL,
    t0Ms: nowMs,
    epoch: 0,
    members: new Map(), // id -> Member; Map insertion order IS join order (spec §7.4 round-robin)
    edits: new Map(), // componentId -> committed body (pristine components are simply absent)
    lease: { holder: null, expiresAt: 0 },
    game: { phase: 'lobby', seekerId: null, endsAt: 0, found: new Set(), scores: {} },
    pending: [], // Pose[] accumulated since the last tick() flush, deduped by member id at flush time
    lastPoseFlushMs: nowMs,
  };
}

function sanitizeName(name) {
  const s = typeof name === 'string' ? name.trim().slice(0, 24) : '';
  return s || 'wanderer';
}

// Golden-ratio-conjugate stepping around the hue wheel gives well-separated
// colors for however many members happen to be present, instead of a fixed
// 8-way palette that looks fine at 8 members and clumps badly at 2.
function assignHue(room) {
  return (room.members.size * GOLDEN_RATIO_CONJUGATE) % 1;
}

function leaseFields(room, nowMs) {
  const holder = room.lease.holder;
  const m = holder ? room.members.get(holder) : null;
  return {
    t: 'lease',
    holder,
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
    selfId: member.id,
    room: room.id,
    protocol: room.protocol,
    epoch: room.epoch,
    t0Ms: room.t0Ms,
    serverNowMs: nowMs,
    hue: member.hue,
    members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name, hue: m.hue })),
    edits: Object.fromEntries(room.edits), // every committed body, so a late joiner builds+compiles once (spec §5.3)
    lease: leaseFields(room, nowMs),
    game: gameFields(room),
  };
}

// Round-robin over join order, skipping the seeker of the round that just
// ended. `room.game.seekerId` still holds that previous value at the moment
// we're picking the next one (we only overwrite it once a new round starts),
// so "skip the previous seeker" falls out of "start from the slot after it"
// with no extra state to track.
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

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {object} room from createRoom()/a previous reduce()/tick() call
 * @param {{from:string, msg:object, nowMs:number}} event
 * @returns {{room:object, sends:Array<{to:string, msg:object}>, close?:{to:string, code:number, reason:string}}}
 */
export function reduce(room, { from, msg, nowMs }) {
  if (!msg || typeof msg.t !== 'string') return { room, sends: [] };

  // hello MUST be first (spec §2.3). Anything else from a connection that
  // hasn't joined yet means the client skipped the handshake — that's a
  // protocol violation, not a message we can meaningfully act on.
  if (msg.t !== 'hello' && !room.members.has(from)) {
    return { room, sends: [], close: { to: from, code: 1002, reason: 'hello must be first' } };
  }

  switch (msg.t) {
    case 'hello': {
      if (room.members.has(from)) return { room, sends: [] }; // duplicate hello from an already-joined member: ignore
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
      member.inRing = !!msg.inRing;
      return { room, sends: [] };
    }

    // A game "for friends, not a cheat-proof system" is unplayable when
    // everyone is called `wanderer`. The name arrives in `hello`, but nothing
    // could change it afterwards, so a player who set one had to reconnect to
    // apply it. Same sanitizer as join — 24 chars, trimmed, never empty.
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
      // lectern is inert: anyone else walking up to it gets the current truth
      // back, exactly like any other denial.
      if (room.game.phase === 'seeking' && from !== room.game.seekerId) {
        return { room, sends: [{ to: from, msg: leaseFields(room, nowMs) }] };
      }
      const expired = room.lease.holder == null || nowMs >= room.lease.expiresAt;
      if (expired && member.inRing) {
        room.lease.holder = from;
        room.lease.expiresAt = nowMs + LEASE_TTL_MS;
        return { room, sends: [{ to: '*', msg: leaseFields(room, nowMs) }] };
      }
      // A denial is just the current truth, not an error (spec §2.3) — tell
      // only the requester so their UI can reconcile; nothing changed for
      // anyone else, so there is nothing to broadcast.
      return { room, sends: [{ to: from, msg: leaseFields(room, nowMs) }] };
    }

    case 'lease.keepalive': {
      if (room.lease.holder !== from) return { room, sends: [] };
      room.lease.expiresAt = nowMs + LEASE_TTL_MS;
      return { room, sends: [] };
    }

    case 'lease.release': {
      if (room.lease.holder !== from) return { room, sends: [] };
      room.lease.holder = null;
      room.lease.expiresAt = 0;
      return { room, sends: [{ to: '*', msg: leaseFields(room, nowMs) }] };
    }

    case 'draft': {
      if (room.lease.holder !== from) return { room, sends: [] };
      const body = typeof msg.body === 'string' ? msg.body : '';
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return { room, sends: [] };
      return { room, sends: [{ to: '*-except-from', msg: { t: 'draft', from, componentId: msg.componentId, body } }] };
    }

    case 'commit': {
      if (room.lease.holder !== from) return { room, sends: [] };
      if (msg.baseEpoch !== room.epoch) {
        return { room, sends: [{ to: from, msg: { t: 'reject', reason: 'stale_epoch', epoch: room.epoch } }] };
      }
      const body = msg.body;
      if (body !== null && Buffer.byteLength(String(body), 'utf8') > MAX_BODY_BYTES) {
        return { room, sends: [{ to: from, msg: { t: 'reject', reason: 'body_too_large', epoch: room.epoch } }] };
      }
      // `null` is the pristine marker — a commit back to the original body
      // removes the override instead of storing an explicit copy of it.
      if (body === null) room.edits.delete(msg.componentId);
      else room.edits.set(msg.componentId, body);
      room.epoch += 1;
      return { room, sends: [{ to: '*', msg: { t: 'commit', epoch: room.epoch, componentId: msg.componentId, body, by: from } }] };
    }

    case 'tag': {
      const member = room.members.get(from);
      if (room.game.phase !== 'seeking' || from !== room.game.seekerId) return { room, sends: [] };
      const target = room.members.get(msg.targetId);
      if (!target) return { room, sends: [] };
      const dx = member.pose.x - target.pose.x;
      const dz = member.pose.z - target.pose.z;
      // The server has no SDF, so it cannot check line of sight — distance
      // against its own last-known poses is the entire trust model here
      // (spec §7.4/§6.4). That is a real griefing surface (a seeker who
      // clips through the sponge can tag through a wall) and it is accepted
      // on purpose: "a game for friends, not a cheat-proof system".
      if (Math.hypot(dx, dz) >= TAG_DISTANCE) return { room, sends: [] };
      room.game.found.add(msg.targetId);
      room.game.scores[from] = (room.game.scores[from] || 0) + 1;
      // Everyone found ends the round NOW. Without this the phase timer ran
      // the full SEEK_MS regardless, so a seeker who tagged the last hider in
      // twenty seconds still watched an empty world for a hundred more —
      // dead time that reads as the game being broken rather than won.
      // Counted against live members (minus the seeker) so a hider who
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

    // Not in spec §2.3's message table, which enumerates every OTHER client
    // message exhaustively but never says how `lobby -> hiding` is actually
    // triggered despite §7.4 requiring ">=2 members, anyone presses Start".
    // Filling that gap; type string `game.start` agreed with lane L2
    // (net.js's startGame()) so the reducer and the client stay in sync
    // without either side having to guess. Flagged in the lane report.
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
      return { room, sends: [] }; // unknown app-level message type: ignore rather than punish an older/newer client
  }
}

// Not one of the three signatures spec §2.2 names (createRoom/reduce/tick),
// but relay.mjs needs SOME pure entry point to tell the reducer "this socket
// is gone" — a raw TCP close carries no protocol message of its own. Kept
// here, not in relay.mjs, because it mutates Room/Member state exactly like
// reduce() does and must obey the same no-I/O rule.
export function removeMember(room, id, nowMs) {
  if (!room.members.has(id)) return { room, sends: [] };
  room.members.delete(id);
  const sends = [{ to: '*', msg: { t: 'peer.leave', id } }];
  if (room.lease.holder === id) {
    room.lease.holder = null;
    room.lease.expiresAt = 0;
    sends.push({ to: '*', msg: leaseFields(room, nowMs) });
  }
  if (room.game.seekerId === id && (room.game.phase === 'hiding' || room.game.phase === 'seeking')) {
    // The seeker disconnecting mid-round would otherwise hang the room in
    // 'seeking' forever (nobody left who can tag) — end the round instead.
    room.game.phase = 'over';
    room.game.endsAt = nowMs + OVER_MS;
    sends.push({ to: '*', msg: gameFields(room) });
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
// out — so the commit lease is assigned BY ROLE for the duration of the round
// instead of being taken at the lectern. The lectern stays the lobby-mode
// baton; this is the only change the design doc asks for, because the
// commit->recompile pipeline already does the rest.
//
// Returned as sends so the transition broadcasts the new holder in the same
// tick as the phase change; a client that learns it is the seeker but not
// that it holds the lease cannot act on the mechanic.
function grantRoleLease(room, nowMs) {
  room.lease.holder = room.game.seekerId;
  // Held for the whole round: expiry is what the lectern's TTL is for, and a
  // seeker whose lease lapsed mid-round would silently lose the verb.
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
 * Owns everything time-driven and NOT triggered by an incoming message:
 * lease expiry, batched pose flush at POSE_HZ, and game-phase advance
 * (spec §2.2). relay.mjs calls this from one setInterval at 30Hz; nothing
 * in here reads the wall clock itself.
 */
export function tick(room, nowMs) {
  const sends = [];
  // A role lease is not on the lectern's TTL — it ends with the round, in
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
