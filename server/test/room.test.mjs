// Shader Garden — server/test/room.test.mjs
// server/room.mjs is a pure reducer (invariant I8): every case here calls
// createRoom/reduce/tick directly with a made-up `nowMs`, no sockets, no
// waiting on real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, reduce, tick, removeMember, PROTOCOL, LEASE_TTL_MS, MAX_MEMBERS, TUNE_NAME_RE, TUNE_VALUE_MAX_ABS } from '../room.mjs';

function hello(room, from, name, nowMs) {
  return reduce(room, { from, msg: { t: 'hello', protocol: PROTOCOL, room: room.id, name }, nowMs });
}

function join(room, from, name, nowMs) {
  const r = hello(room, from, name, nowMs);
  return r;
}

test('hello joins a member and welcome carries full member list + edits + tunes', () => {
  let room = createRoom('r1', 1000);
  let r = join(room, 'a', 'Alice', 1000);
  room = r.room;
  const welcome = r.sends.find((s) => s.to === 'a').msg;
  assert.equal(welcome.t, 'welcome');
  assert.equal(welcome.selfId, 'a');
  assert.equal(welcome.protocol, PROTOCOL);
  assert.equal(welcome.members.length, 1);
  assert.deepEqual(welcome.edits, {});
  assert.deepEqual(welcome.tunes, {}); // tunes rides the welcome as an object, late joiners see current dials

  r = join(room, 'b', 'Bob', 1001);
  room = r.room;
  const peerJoin = r.sends.find((s) => s.to === '*-except-from');
  assert.equal(peerJoin.msg.t, 'peer.join');
  assert.equal(peerJoin.msg.id, 'b');
  const welcome2 = r.sends.find((s) => s.to === 'b').msg;
  assert.equal(welcome2.members.length, 2);
});

test('wrong protocol on hello closes 1002', () => {
  const room = createRoom('r1', 0);
  const r = reduce(room, { from: 'a', msg: { t: 'hello', protocol: 'bogus', name: 'x' }, nowMs: 0 });
  assert.equal(r.close.code, 1002);
});

test('room full rejects with error then close 1013', () => {
  let room = createRoom('r1', 0);
  for (let i = 0; i < MAX_MEMBERS; i++) {
    room = join(room, `m${i}`, `m${i}`, 0).room;
  }
  const r = join(room, 'overflow', 'x', 0);
  assert.equal(r.sends[0].msg.code, 'room_full');
  assert.equal(r.close.code, 1013);
});

test('non-hello message before hello closes 1002', () => {
  const room = createRoom('r1', 0);
  const r = reduce(room, { from: 'a', msg: { t: 'pose', x: 0, z: 0, yaw: 0, speed01: 0, gait: 0 }, nowMs: 0 });
  assert.equal(r.close.code, 1002);
});

test('lease.request denied when not inRing, granted once inRing', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  let r = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 });
  room = r.room;
  assert.equal(room.lease.holder, null);
  assert.equal(r.sends[0].to, 'a'); // denial goes only to requester

  r = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 1 });
  room = r.room;
  r = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 2 });
  room = r.room;
  assert.equal(room.lease.holder, 'a');
  assert.equal(room.lease.expiresAt, 2 + LEASE_TTL_MS);
  assert.equal(r.sends[0].to, '*'); // grant is broadcast
});

test('lease expires via tick and is broadcast', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;
  assert.equal(room.lease.holder, 'a');

  let r = tick(room, LEASE_TTL_MS - 1);
  room = r.room;
  assert.equal(room.lease.holder, 'a'); // not yet expired

  r = tick(room, LEASE_TTL_MS + 1);
  room = r.room;
  assert.equal(room.lease.holder, null);
  const leaseMsg = r.sends.find((s) => s.msg.t === 'lease');
  assert.ok(leaseMsg);
});

test('lease.keepalive re-arms expiry, only for the holder', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = join(room, 'b', 'B', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;

  // Non-holder keepalive is a no-op.
  room = reduce(room, { from: 'b', msg: { t: 'lease.keepalive' }, nowMs: 5000 }).room;
  assert.equal(room.lease.expiresAt, LEASE_TTL_MS);

  room = reduce(room, { from: 'a', msg: { t: 'lease.keepalive' }, nowMs: 5000 }).room;
  assert.equal(room.lease.expiresAt, 5000 + LEASE_TTL_MS);
});

test('lease.release by holder only', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = join(room, 'b', 'B', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;

  room = reduce(room, { from: 'b', msg: { t: 'lease.release' }, nowMs: 1 }).room;
  assert.equal(room.lease.holder, 'a'); // not the holder: no-op

  room = reduce(room, { from: 'a', msg: { t: 'lease.release' }, nowMs: 1 }).room;
  assert.equal(room.lease.holder, null);
});

test('draft is relayed to everyone except sender and never stored', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = join(room, 'b', 'B', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;

  // Non-holder draft is dropped.
  let r = reduce(room, { from: 'b', msg: { t: 'draft', componentId: 1, body: 'x' }, nowMs: 0 });
  assert.equal(r.sends.length, 0);

  r = reduce(room, { from: 'a', msg: { t: 'draft', componentId: 1, body: 'float x = 1.0;' }, nowMs: 0 });
  room = r.room;
  assert.equal(r.sends[0].to, '*-except-from');
  assert.equal(r.sends[0].msg.t, 'draft');
  assert.equal(room.edits.size, 0); // never stored
});

test('commit: stale epoch rejected, accepted commit bumps epoch and broadcasts', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;

  let r = reduce(room, { from: 'a', msg: { t: 'commit', componentId: 2, body: 'x', baseEpoch: 999 }, nowMs: 0 });
  assert.equal(r.sends[0].msg.t, 'reject');
  assert.equal(r.sends[0].msg.reason, 'stale_epoch');

  r = reduce(room, { from: 'a', msg: { t: 'commit', componentId: 2, body: 'float y=2.0;', baseEpoch: 0 }, nowMs: 0 });
  room = r.room;
  assert.equal(room.epoch, 1);
  assert.equal(room.edits.get(2), 'float y=2.0;');
  assert.equal(r.sends[0].to, '*');
  assert.equal(r.sends[0].msg.t, 'commit');

  // Committing `null` (pristine marker) removes the override.
  r = reduce(room, { from: 'a', msg: { t: 'commit', componentId: 2, body: null, baseEpoch: 1 }, nowMs: 0 });
  room = r.room;
  assert.equal(room.edits.has(2), false);
});

test('non-holder commit is a no-op', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  const r = reduce(room, { from: 'a', msg: { t: 'commit', componentId: 1, body: 'x', baseEpoch: 0 }, nowMs: 0 });
  assert.equal(r.sends.length, 0);
  assert.equal(r.room.epoch, 0);
});

test('pose token bucket: 40 budget, overflow silently dropped never disconnects', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  let sentCount = 0;
  for (let i = 0; i < 45; i++) {
    const r = reduce(room, { from: 'a', msg: { t: 'pose', x: 1, z: 1, yaw: 0, speed01: 0.5, gait: 0 }, nowMs: 0 });
    room = r.room;
    assert.equal(r.close, undefined);
  }
  assert.equal(room.members.get('a').poseBudget, 0);
  assert.equal(room.pending.length, 40); // only 40 of the 45 accepted
});

test('pose budget refills at 30/s', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  for (let i = 0; i < 40; i++) {
    room = reduce(room, { from: 'a', msg: { t: 'pose', x: 0, z: 0, yaw: 0, speed01: 0, gait: 0 }, nowMs: 0 } ).room;
  }
  assert.equal(room.members.get('a').poseBudget, 0);
  room = reduce(room, { from: 'a', msg: { t: 'pose', x: 0, z: 0, yaw: 0, speed01: 0, gait: 0 }, nowMs: 1000 }).room;
  // after 1s, +30 refilled, -1 consumed = 29
  assert.equal(room.members.get('a').poseBudget, 29);
});

test('non-finite or out-of-range pose is ignored', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'pose', x: NaN, z: 0, yaw: 0, speed01: 0, gait: 0 }, nowMs: 0 }).room;
  assert.equal(room.pending.length, 0);
  room = reduce(room, { from: 'a', msg: { t: 'pose', x: 0, z: 0, yaw: 0, speed01: 1.5, gait: 0 }, nowMs: 0 }).room;
  assert.equal(room.pending.length, 0);
});

test('tick flushes batched poses at POSE_HZ, self excluded', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = join(room, 'b', 'B', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'pose', x: 5, z: 6, yaw: 0, speed01: 0, gait: 0 }, nowMs: 0 }).room;

  let r = tick(room, 10); // too soon (< 1000/15 ms)
  room = r.room;
  assert.equal(r.sends.filter((s) => s.msg.t === 'poses').length, 0);

  r = tick(room, 100); // now >= 66.7ms since lastPoseFlushMs
  room = r.room;
  const toB = r.sends.find((s) => s.to === 'b' && s.msg.t === 'poses');
  assert.ok(toB);
  assert.deepEqual(toB.msg.poses, [{ id: 'a', x: 5, z: 6, yaw: 0, speed01: 0, gait: 0 }]);
  const toA = r.sends.find((s) => s.to === 'a' && s.msg.t === 'poses');
  assert.equal(toA, undefined); // self excluded, and 'a' has no peer poses to receive
});

test('start requires >=2 members and only fires from lobby', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  let r = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs: 0 });
  assert.equal(r.room.game.phase, 'lobby'); // only 1 member

  room = join(r.room, 'b', 'B', 0).room;
  r = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs: 0 });
  assert.equal(r.room.game.phase, 'hiding');
  assert.ok(['a', 'b'].includes(r.room.game.seekerId));
  assert.equal(r.room.game.endsAt, 30000);
});

test('game phase advances hiding -> seeking -> over -> lobby via tick, seeker round-robins skipping previous', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = join(room, 'b', 'B', 0).room;
  room = join(room, 'c', 'C', 0).room;
  let r = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs: 0 });
  room = r.room;
  const firstSeeker = room.game.seekerId;
  assert.equal(firstSeeker, 'a'); // first game: join-order[0]

  r = tick(room, 30000);
  room = r.room;
  assert.equal(room.game.phase, 'seeking');
  assert.equal(room.game.endsAt, 30000 + 120000);

  r = tick(room, 30000 + 120000);
  room = r.room;
  assert.equal(room.game.phase, 'over');

  r = tick(room, 30000 + 120000 + 10000);
  room = r.room;
  assert.equal(room.game.phase, 'lobby');
  assert.equal(room.game.found.size, 0);

  // Next game skips the previous seeker ('a' -> 'b').
  r = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs: 0 });
  assert.equal(r.room.game.seekerId, 'b');
});

test('tag: seeker only, phase seeking only, distance < 0.9', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = join(room, 'b', 'B', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs: 0 }).room;
  assert.equal(room.game.seekerId, 'a');
  room = tick(room, 30000).room; // -> seeking

  // Too far: no tag.
  room = reduce(room, { from: 'a', msg: { t: 'pose', x: 0, z: 0, yaw: 0, speed01: 0, gait: 0 }, nowMs: 30000 }).room;
  room = reduce(room, { from: 'b', msg: { t: 'pose', x: 5, z: 5, yaw: 0, speed01: 0, gait: 0 }, nowMs: 30000 }).room;
  let r = reduce(room, { from: 'a', msg: { t: 'tag', targetId: 'b' }, nowMs: 30000 });
  assert.equal(r.room.game.found.size, 0);

  // Non-seeker cannot tag.
  r = reduce(room, { from: 'b', msg: { t: 'tag', targetId: 'a' }, nowMs: 30000 });
  assert.equal(r.room.game.found.size, 0);

  // Close enough: tag lands.
  room = reduce(room, { from: 'b', msg: { t: 'pose', x: 0.1, z: 0, yaw: 0, speed01: 0, gait: 0 }, nowMs: 30000 }).room;
  r = reduce(room, { from: 'a', msg: { t: 'tag', targetId: 'b' }, nowMs: 30000 });
  assert.ok(r.room.game.found.has('b'));
  assert.equal(r.room.game.scores.a, 1);
});

test('removeMember releases the lease and broadcasts peer.leave', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = join(room, 'b', 'B', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;
  assert.equal(room.lease.holder, 'a');

  const r = removeMember(room, 'a', 1);
  room = r.room;
  assert.equal(room.members.has('a'), false);
  assert.equal(room.lease.holder, null);
  assert.ok(r.sends.some((s) => s.msg.t === 'peer.leave' && s.msg.id === 'a'));
});

test('removeMember ends the round early if the seeker disconnects', () => {
  let room = createRoom('r1', 0);
  room = join(room, 'a', 'A', 0).room;
  room = join(room, 'b', 'B', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs: 0 }).room;
  assert.equal(room.game.seekerId, 'a');

  const r = removeMember(room, 'a', 5);
  assert.equal(r.room.game.phase, 'over');
});

// --- "Sculptor's Tag" (docs/the-commons-design.md §0) -----------------------
// The seeker edits the world to flush hiders out, so the commit lease is
// assigned BY ROLE for the round rather than taken at the lectern.

function startRound(nowMs = 0) {
  let room = createRoom('sc', nowMs);
  room = join(room, 'a', 'Ada', nowMs).room;
  room = join(room, 'b', 'Baz', nowMs).room;
  room = join(room, 'c', 'Cy', nowMs).room;
  const r = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs });
  return r.room;
}

test("Sculptor's Tag: entering `seeking` hands the commit lease to the seeker", () => {
  let room = startRound(0);
  assert.equal(room.game.phase, 'hiding');
  assert.equal(room.lease.holder, null, 'hiding phase must not grant the lease yet');

  const r = tick(room, 30001); // HIDE_MS elapsed
  room = r.room;
  assert.equal(room.game.phase, 'seeking');
  assert.equal(room.lease.holder, room.game.seekerId, 'seeker holds the lease by role');

  // The transition must BROADCAST the new holder in the same tick — a client
  // told it is the seeker but not that it holds the lease cannot act.
  const leaseMsg = r.sends.find((s) => s.msg.t === 'lease');
  assert.ok(leaseMsg, 'phase change broadcasts the lease');
  assert.equal(leaseMsg.to, '*');
  assert.equal(leaseMsg.msg.holder, room.game.seekerId);
});

test("Sculptor's Tag: the lectern is inert for non-seekers during `seeking`", () => {
  let room = tick(startRound(0), 30001).room;
  const seeker = room.game.seekerId;
  const other = [...room.members.keys()].find((id) => id !== seeker);

  // Standing in the ring is what normally qualifies a claim.
  room = reduce(room, { from: other, msg: { t: 'ring', inRing: true }, nowMs: 30002 }).room;
  const r = reduce(room, { from: other, msg: { t: 'lease.request' }, nowMs: 30003 });
  assert.equal(r.room.lease.holder, seeker, 'a hider cannot take the round lease');
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].to, other, 'denial goes only to the requester');
});

test("Sculptor's Tag: the role lease does not expire on the lectern TTL", () => {
  let room = tick(startRound(0), 30001).room;
  const seeker = room.game.seekerId;
  // Well past LEASE_TTL_MS, but still inside the round.
  const r = tick(room, 30001 + LEASE_TTL_MS + 5000);
  assert.equal(r.room.game.phase, 'seeking');
  assert.equal(r.room.lease.holder, seeker, 'the verb survives the whole round');
});

test("Sculptor's Tag: leaving `seeking` releases the role lease", () => {
  let room = tick(startRound(0), 30001).room;
  const r = tick(room, 30001 + 120001); // SEEK_MS elapsed
  assert.equal(r.room.game.phase, 'over');
  assert.equal(r.room.lease.holder, null, 'the round ending returns the lectern');
});

test('tagging the last hider ends the round immediately', () => {
  let room = tick(startRound(0), 30001).room;
  const seeker = room.game.seekerId;
  const hiders = [...room.members.keys()].filter((id) => id !== seeker);
  // Co-locate so the server's distance check passes.
  for (const id of [seeker, ...hiders]) {
    room = reduce(room, { from: id, msg: { t: 'pose', x: 0, y: 0, z: 0, yaw: 0 }, nowMs: 30002 }).room;
  }

  let r = reduce(room, { from: seeker, msg: { t: 'tag', targetId: hiders[0] }, nowMs: 30003 });
  room = r.room;
  assert.equal(room.game.phase, 'seeking', 'one hider left — the round continues');

  r = reduce(room, { from: seeker, msg: { t: 'tag', targetId: hiders[1] }, nowMs: 30004 });
  room = r.room;
  assert.equal(room.game.phase, 'over', 'no hiders left — the round ends now');
  assert.equal(room.lease.holder, null, 'ending early still returns the lectern');
  assert.equal(room.game.scores[seeker], 2);
});

test('a hider who disconnects cannot leave the round unwinnable', () => {
  let room = tick(startRound(0), 30001).room;
  const seeker = room.game.seekerId;
  const hiders = [...room.members.keys()].filter((id) => id !== seeker);
  for (const id of [seeker, hiders[0]]) {
    room = reduce(room, { from: id, msg: { t: 'pose', x: 0, y: 0, z: 0, yaw: 0 }, nowMs: 30002 }).room;
  }
  room = removeMember(room, hiders[1], 30003).room;

  const r = reduce(room, { from: seeker, msg: { t: 'tag', targetId: hiders[0] }, nowMs: 30004 });
  assert.equal(r.room.game.phase, 'over', 'the only remaining hider was found');
});

test('rename changes the member name and tells everyone', () => {
  let room = createRoom('rn', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = join(room, 'b', 'Baz', 0).room;

  const r = reduce(room, { from: 'b', msg: { t: 'rename', name: '  Bazza  ' }, nowMs: 1 });
  room = r.room;
  assert.equal(room.members.get('b').name, 'Bazza', 'trimmed, same sanitizer as join');
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].to, '*');
  assert.deepEqual(r.sends[0].msg, { t: 'peer.rename', id: 'b', name: 'Bazza' });

  // Empty falls back rather than producing a nameless member.
  room = reduce(room, { from: 'b', msg: { t: 'rename', name: '   ' }, nowMs: 2 }).room;
  assert.equal(room.members.get('b').name, 'wanderer');

  // Over-long names are cut, not rejected.
  room = reduce(room, { from: 'b', msg: { t: 'rename', name: 'x'.repeat(50) }, nowMs: 3 }).room;
  assert.equal(room.members.get('b').name.length, 24);

  // A no-op rename broadcasts nothing.
  assert.equal(reduce(room, { from: 'b', msg: { t: 'rename', name: 'x'.repeat(24) }, nowMs: 4 }).sends.length, 0);
});

// --- Tunes (Wave-5 §1) ----------------------------------------------------
// A late joiner must see the current tune values, not just an empty map — the
// slider in the UI binds to the welcome's tunes object, so a fresh dial has
// to ride that object straight through.
test('a late joiner sees the current tunes in the welcome', () => {
  let room = createRoom('tn', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'tune', name: 'SG_TIME', value: 1.5 }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'tune', name: 'SG_BLOOM', value: 0.25 }, nowMs: 0 }).room;

  const r = join(room, 'b', 'Baz', 1);
  room = r.room;
  const welcome = r.sends.find((s) => s.to === 'b').msg;
  assert.deepEqual(welcome.tunes, { SG_TIME: 1.5, SG_BLOOM: 0.25 });
  // tune storage shape is a Map in the room — JSON-friendly projection is
  // the welcome's job, not the room's.
  assert.equal(room.tunes instanceof Map, true);
});

test('tune: only the lease holder can dial, broadcasts {t,name,value,by}', () => {
  let room = createRoom('tn', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = join(room, 'b', 'Baz', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;

  // Non-holder tune is dropped, never broadcast, never stored.
  let r = reduce(room, { from: 'b', msg: { t: 'tune', name: 'SG_TIME', value: 1.5 }, nowMs: 0 });
  assert.equal(r.sends.length, 0);
  assert.equal(r.room.tunes.size, 0);

  // Holder's tune broadcasts with `by` and stores the latest value.
  r = reduce(room, { from: 'a', msg: { t: 'tune', name: 'SG_TIME', value: 1.5 }, nowMs: 0 });
  room = r.room;
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].to, '*');
  assert.deepEqual(r.sends[0].msg, { t: 'tune', name: 'SG_TIME', value: 1.5, by: 'a' });
  assert.equal(room.tunes.get('SG_TIME'), 1.5);
});

test('tune: invalid name is rejected (must match TUNE_NAME_RE)', () => {
  let room = createRoom('tn', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;

  // Each of these would reach across to an arbitrary uniform or just be a
  // parse error in the shader side if we let it through. We refuse them all.
  // (`x'.repeat(64)` is the boundary the grammar accepts: 1 initial + 63
  // subsequent = 64 chars total. Anything past that is over.)
  const badNames = ['1LEAD', 'SG-TIME', 'SG TIME', '', 'SG.TIME', 'x'.repeat(65)];
  for (const name of badNames) {
    const r = reduce(room, { from: 'a', msg: { t: 'tune', name, value: 1 }, nowMs: 0 });
    assert.equal(r.sends.length, 0, `name ${JSON.stringify(name)} should be rejected`);
    assert.equal(r.room.tunes.size, 0);
  }
  // The regex itself must match the grammar the spec locks in.
  assert.equal(TUNE_NAME_RE.test('SG_TIME'), true);
  assert.equal(TUNE_NAME_RE.test('_a'), true);
  assert.equal(TUNE_NAME_RE.test('a1_b2'), true);
});

test('tune: non-finite or out-of-range value is rejected', () => {
  let room = createRoom('tn', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;

  for (const value of [NaN, Infinity, -Infinity, TUNE_VALUE_MAX_ABS + 1, -(TUNE_VALUE_MAX_ABS + 1), '1', null]) {
    const r = reduce(room, { from: 'a', msg: { t: 'tune', name: 'SG_TIME', value }, nowMs: 0 });
    assert.equal(r.sends.length, 0, `value ${JSON.stringify(value)} should be rejected`);
    assert.equal(r.room.tunes.size, 0);
  }

  // The boundary value is accepted (inclusive).
  const r = reduce(room, { from: 'a', msg: { t: 'tune', name: 'SG_TIME', value: TUNE_VALUE_MAX_ABS }, nowMs: 0 });
  assert.equal(r.sends.length, 1);
  assert.equal(r.room.tunes.get('SG_TIME'), TUNE_VALUE_MAX_ABS);
});

// --- snapshot.request -----------------------------------------------------
// A joined member who needs the full room state again (e.g. after a UI re-
// mount) asks for one. We return a FRESH complete welcome only to the
// requester — state is unchanged, no broadcast.
test('snapshot.request returns a fresh complete welcome only to the requester', () => {
  let room = createRoom('sn', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = join(room, 'b', 'Baz', 0).room;
  // Some state we expect to come back.
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'tune', name: 'SG_TIME', value: 0.75 }, nowMs: 0 }).room;
  const epochBefore = room.epoch;
  const tunesBefore = new Map(room.tunes);
  const holderBefore = room.lease.holder;

  const r = reduce(room, { from: 'b', msg: { t: 'snapshot.request' }, nowMs: 5 });
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].to, 'b', 'snapshot goes only to the requester');
  const snap = r.sends[0].msg;
  assert.equal(snap.t, 'welcome');
  assert.equal(snap.selfId, 'b');
  assert.equal(snap.members.length, 2);
  assert.deepEqual(snap.tunes, { SG_TIME: 0.75 });
  assert.equal(snap.lease.holder, 'a');
  // State must be untouched by a snapshot.
  assert.equal(r.room.epoch, epochBefore);
  assert.deepEqual([...r.room.tunes], [...tunesBefore]);
  assert.equal(r.room.lease.holder, holderBefore);
  assert.equal(room.epoch, epochBefore);
});

test('snapshot.request from a non-member is ignored (closes 1002 via the pre-hello guard)', () => {
  const room = createRoom('sn', 0);
  const r = reduce(room, { from: 'stranger', msg: { t: 'snapshot.request' }, nowMs: 0 });
  assert.equal(r.close.code, 1002);
  assert.equal(r.sends.length, 0);
});

// --- ring release ---------------------------------------------------------
// Walking OUT of the lectern ring while holding the lease forfeits it
// immediately, rather than waiting for the TTL — otherwise a holder who
// walks away still looks like the holder to the rest of the room for up to
// LEASE_TTL_MS.
test('ring: stepping out of the ring releases a normal lectern lease', () => {
  let room = createRoom('rg', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;
  assert.equal(room.lease.holder, 'a');

  const r = reduce(room, { from: 'a', msg: { t: 'ring', inRing: false }, nowMs: 1 });
  room = r.room;
  assert.equal(room.lease.holder, null);
  assert.equal(room.lease.expiresAt, 0);
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].to, '*');
  assert.equal(r.sends[0].msg.t, 'lease');
  assert.equal(r.sends[0].msg.holder, null);
});

test('ring: stepping in (false -> true) does not touch the lease', () => {
  let room = createRoom('rg', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;
  assert.equal(room.lease.holder, 'a');

  // Idempotent re-entry: inRing was already true.
  const r = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 1 });
  assert.equal(r.sends.length, 0);
  assert.equal(r.room.lease.holder, 'a');
});

test('ring: stepping out does NOT release the seeker role lease during seeking', () => {
  // 3 members so a seeker role lease exists during `seeking`.
  let room = createRoom('rg', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = join(room, 'b', 'Baz', 0).room;
  room = join(room, 'c', 'Cy', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs: 0 }).room;
  room = tick(room, 30001).room; // -> seeking; seeker holds the role lease
  const seeker = room.game.seekerId;
  assert.equal(room.lease.holder, seeker);

  // The seeker steps out of the ring. The role lease is round-owned, not
  // lectern-owned, so it must survive.
  const r = reduce(room, { from: seeker, msg: { t: 'ring', inRing: false }, nowMs: 30002 });
  room = r.room;
  assert.equal(room.lease.holder, seeker, 'role lease survives a false ring transition');
  assert.equal(r.sends.length, 0, 'no lease broadcast — nothing changed');
});

test('ring: stepping out DOES release the seeker role lease once the round is over', () => {
  // Drive the round to `over`, where the lease was already released by
  // advanceGame(). After that, the holder is null and a ring transition has
  // no lease to release anyway — but a non-seeker in `over` holding a
  // (hypothetical) lease should still be released on ring false. We assert
  // the simpler property that the released-holder stays released.
  let room = createRoom('rg', 0);
  room = join(room, 'a', 'Ada', 0).room;
  room = join(room, 'b', 'Baz', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'game.start' }, nowMs: 0 }).room;
  room = tick(room, 30001).room; // -> seeking
  const seeker = room.game.seekerId;
  room = tick(room, 30001 + 120001).room; // -> over; role lease released
  assert.equal(room.lease.holder, null);

  // a non-seeker takes the lectern in `over` (lobby-mode behavior), then
  // steps out.
  const other = [...room.members.keys()].find((id) => id !== seeker);
  room = reduce(room, { from: other, msg: { t: 'ring', inRing: true }, nowMs: 200000 }).room;
  room = reduce(room, { from: other, msg: { t: 'lease.request' }, nowMs: 200001 }).room;
  assert.equal(room.lease.holder, other);

  const r = reduce(room, { from: other, msg: { t: 'ring', inRing: false }, nowMs: 200002 });
  assert.equal(r.room.lease.holder, null);
});
