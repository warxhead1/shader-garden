// Shader Garden — mp-netclient.mjs
// Multiplayer spec §8.1 (lane L2). Plain node:test, no browser and no
// socket: exercises only the exported PURE functions net.js/timesync.js
// promise not to hide behind a WebSocket — selectOffset()/sampleFromPong()
// (§3.1's min-RTT estimator), the peer slot allocator (§4.1), and
// resolveRelayUrl() (§2.5's four-case discovery order).
// Usage: node tools/test/mp-netclient.mjs  (or via `node --test`)

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectOffset, sampleFromPong } from '../../site/js/organs/garden/timesync.js';
import { createSlotAllocator, allocateSlot, freeSlot, resolveRelayUrl } from '../../site/js/organs/garden/net.js';

/* ---------------- §3.1 min-RTT offset estimator ---------------- */

test('selectOffset: null on an empty ring', () => {
  assert.equal(selectOffset([]), null);
});

test('selectOffset: picks the MINIMUM-rtt sample, never the mean', () => {
  // One clean sample (rtt 10, offset 500) and several jittered ones with
  // wildly different offsets. The mean of all offsets would land nowhere
  // near 500 — averaging is exactly the failure mode §3.1 rejects.
  const samples = [
    { rtt: 10, offset: 500 },
    { rtt: 240, offset: 50 },   // one bad Wi-Fi frame
    { rtt: 180, offset: 9000 }, // another
    { rtt: 60, offset: 480 },
  ];
  assert.equal(selectOffset(samples), 500);
});

test('selectOffset: a ring under sustained jitter still tracks the best sample seen', () => {
  // Simulates createTimeSync's ring behavior: only the last 8 samples matter,
  // and within that window the minimum rtt wins regardless of arrival order.
  const ring = [];
  const push = (rtt, offset) => { ring.push({ rtt, offset }); if (ring.length > 8) ring.shift(); };
  for (let i = 0; i < 20; i++) push(200 + (i % 7) * 30, 1000 + i); // noisy, offset drifting
  push(8, 42); // one great sample lands
  assert.equal(selectOffset(ring), 42);
  for (let i = 0; i < 8; i++) push(300, 9999); // eight consecutive bad samples evict the good one
  assert.notEqual(selectOffset(ring), 42);
});

test('sampleFromPong: rtt/offset formulas match §3.1 exactly', () => {
  // clientSendMs=1000, serverNowMs=1050 (server 50ms "ahead" of local clock
  // at the moment it replied), reply observed locally at nowMs=1040 (40ms
  // round trip).
  const { rtt, offset } = sampleFromPong(1000, 1050, 1040);
  assert.equal(rtt, 40);
  assert.equal(offset, 1050 + 40 / 2 - 1040); // 30
});

/* ---------------- §4.1 peer slot allocator ---------------- */

test('slot allocator: stable assignment, lowest-free-first', () => {
  const s = createSlotAllocator();
  assert.equal(allocateSlot(s, 'a'), 0);
  assert.equal(allocateSlot(s, 'b'), 1);
  assert.equal(allocateSlot(s, 'c'), 2);
  // Re-requesting an already-assigned id returns the SAME slot (idempotent,
  // "stable for a member's lifetime").
  assert.equal(allocateSlot(s, 'a'), 0);
  assert.equal(allocateSlot(s, 'b'), 1);
});

test('slot allocator: leave frees the slot WITHOUT re-packing survivors', () => {
  const s = createSlotAllocator();
  allocateSlot(s, 'a'); // 0
  allocateSlot(s, 'b'); // 1
  allocateSlot(s, 'c'); // 2
  freeSlot(s, 'b'); // b leaves — slot 1 goes back to the pool
  // c must NOT have been teleported down into b's old slot.
  assert.equal(s.slotOf.get('c'), 2);
  assert.equal(s.slotOf.has('b'), false);
  // A brand new member reuses the freed slot (lowest free first), never a
  // slot belonging to someone still present.
  assert.equal(allocateSlot(s, 'd'), 1);
  assert.equal(s.slotOf.get('a'), 0);
  assert.equal(s.slotOf.get('c'), 2);
});

test('slot allocator: join/leave/re-join churn never collides two present members', () => {
  const s = createSlotAllocator();
  const present = new Set();
  const rng = (() => { let x = 42; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  for (let i = 0; i < 200; i++) {
    const id = `m${Math.floor(rng() * 12)}`;
    if (present.has(id)) {
      freeSlot(s, id);
      present.delete(id);
    } else if (present.size < 7) {
      allocateSlot(s, id);
      present.add(id);
    }
    const used = new Set();
    for (const p of present) {
      const slot = s.slotOf.get(p);
      assert.ok(slot >= 0 && slot < 7, `slot ${slot} out of range for ${p}`);
      assert.ok(!used.has(slot), `slot ${slot} double-assigned among present members`);
      used.add(slot);
    }
  }
});

test('slot allocator: room full of MAX_PEERS returns -1, never overwrites an existing slot', () => {
  const s = createSlotAllocator();
  for (let i = 0; i < 7; i++) assert.notEqual(allocateSlot(s, `p${i}`), -1);
  assert.equal(allocateSlot(s, 'overflow'), -1);
  assert.equal(s.slotOf.has('overflow'), false);
});

/* ---------------- §2.5 relay discovery, all four cases ---------------- */

const neverFetch = () => { throw new Error('fetchRelayJson must not be called'); };

test('relay discovery: ?relay= wins over everything else', async () => {
  const res = await resolveRelayUrl({
    queryRelay: 'wss://override.example/relay',
    hostname: 'my-garden.example',
    isHttps: true,
    fetchRelayJson: neverFetch, // must short-circuit before this is ever called
  });
  assert.deepEqual(res, { url: 'wss://override.example/relay', source: 'query' });
});

test('relay discovery: assets/relay.json wins over the localhost fallback', async () => {
  const res = await resolveRelayUrl({
    queryRelay: null,
    hostname: 'localhost',
    isHttps: false,
    fetchRelayJson: async () => 'wss://configured.example/relay',
  });
  assert.deepEqual(res, { url: 'wss://configured.example/relay', source: 'relay.json' });
});

test('relay discovery: localhost + http, no query, no relay.json -> ws://<host>:8787', async () => {
  const res = await resolveRelayUrl({
    queryRelay: null,
    hostname: 'localhost',
    isHttps: false,
    fetchRelayJson: async () => null,
  });
  assert.deepEqual(res, { url: 'ws://localhost:8787', source: 'localhost' });
});

test('relay discovery: 127.0.0.1 + http also falls back to ws://', async () => {
  const res = await resolveRelayUrl({
    queryRelay: null,
    hostname: '127.0.0.1',
    isHttps: false,
    fetchRelayJson: async () => null,
  });
  assert.deepEqual(res, { url: 'ws://127.0.0.1:8787', source: 'localhost' });
});

test('relay discovery: production https with nothing configured -> no-relay, never ws://', async () => {
  const res = await resolveRelayUrl({
    queryRelay: null,
    hostname: 'shader-garden.example.github.io',
    isHttps: true,
    fetchRelayJson: async () => null,
  });
  assert.deepEqual(res, { url: null, source: 'no-relay' });
});

test('relay discovery: mixed-content guard — localhost served over https never falls back to ws://', async () => {
  // Never attempt a ws:// connection from an https:// page (§2.5) — even on
  // localhost, if the page itself loaded over https, this must resolve to
  // no-relay rather than a connection that browsers block silently.
  const res = await resolveRelayUrl({
    queryRelay: null,
    hostname: 'localhost',
    isHttps: true,
    fetchRelayJson: async () => null,
  });
  assert.deepEqual(res, { url: null, source: 'no-relay' });
});

console.log('all-PASS');
