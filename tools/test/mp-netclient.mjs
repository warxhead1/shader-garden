// Shader Garden — mp-netclient.mjs
// Multiplayer spec §8.1 (lane L2). Plain node:test, no browser and no
// socket: exercises only the exported PURE functions net.js/timesync.js
// promise not to hide behind a WebSocket — selectOffset()/sampleFromPong()
// (§3.1's min-RTT estimator), the peer slot allocator (§4.1), and
// resolveRelayUrl() (§2.5's four-case discovery order). Plus regression
// coverage for the L2 client-reliability contract: time-reply validation
// (unknown / duplicate / stale / malformed must all be ignored silently)
// and disconnect settlement of in-flight commit() resolvers, driven by a
// minimal mock WebSocket so the L2 socket plumbing is exercised without a
// live relay.
// Usage: node tools/test/mp-netclient.mjs  (or via `node --test`)

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectOffset, sampleFromPong, createTimeSync } from '../../site/js/organs/garden/timesync.js';
import {
  createSlotAllocator, allocateSlot, freeSlot, resolveRelayUrl, connectRoom,
} from '../../site/js/organs/garden/net.js';

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

/* ---------------- §3.1 time-reply validation (client reliability) ---------------- */

// `now` is mutable so each test can advance the receive clock independently of
// the send clock — that lets us assert a sample lands without racing the
// "ping registered at t=1000, reply received at t=1050" path against `Date`.
function makeClock(initial = 1000) {
  let t = initial;
  const now = () => t;
  now.advance = (dt) => { t += dt; };
  now.set = (v) => { t = v; };
  return now;
}

test('timesync: a valid pong lands one sample, offset is computable', () => {
  const sent = [];
  const now = makeClock(1000);
  const ts = createTimeSync({ send: (m) => sent.push(m), now });
  ts.start(); // id '0', clientSendMs 1000
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'ping');
  assert.equal(sent[0].id, '0');
  now.advance(40); // reply arrives 40ms later
  ts.onPong(1050, { id: '0' });
  // rtt = 40, offset = 1050 + 20 - 1040 = 30
  assert.equal(ts.offset(), 30);
  ts.stop();
});

test('timesync: unknown echo.id is ignored — never poisons the ring', () => {
  const sent = [];
  const now = makeClock(1000);
  const ts = createTimeSync({ send: (m) => sent.push(m), now });
  ts.start(); // registers ping id '0'
  now.advance(40);
  // A replay/relay-from-prior-connection arriving with an id we never sent.
  assert.doesNotThrow(() => ts.onPong(1050, { id: '42' }));
  assert.equal(ts.offset(), null);
  // And a genuinely valid reply after that still lands.
  ts.onPong(1050, { id: '0' });
  assert.equal(ts.offset(), 30);
  ts.stop();
});

test('timesync: duplicate echo.id is ignored after the first settled reply', () => {
  const sent = [];
  const now = makeClock(1000);
  const ts = createTimeSync({ send: (m) => sent.push(m), now });
  ts.start(); // id '0'
  now.advance(40);
  ts.onPong(1050, { id: '0' }); // first reply — lands
  assert.equal(ts.offset(), 30);
  // A second reply with the same id (a relay that double-forwarded, or a
  // server that didn't de-dup) must NOT add a second sample and must NOT
  // throw — pending was already cleared on the first settlement.
  assert.doesNotThrow(() => ts.onPong(1070, { id: '0' }));
  assert.equal(ts.offset(), 30); // unchanged
  ts.stop();
});

test('timesync: malformed echo (null / undefined / non-object) is ignored without throwing', () => {
  const sent = [];
  const now = makeClock(1000);
  const ts = createTimeSync({ send: (m) => sent.push(m), now });
  ts.start();
  now.advance(40);
  // The wire can deliver anything: a stray string, null, undefined, an
  // array. None of these should throw and none should poison the ring.
  assert.doesNotThrow(() => ts.onPong(1050, null));
  assert.doesNotThrow(() => ts.onPong(1050, undefined));
  assert.doesNotThrow(() => ts.onPong(1050, 'echo'));
  assert.doesNotThrow(() => ts.onPong(1050, [0, 1, 2]));
  assert.doesNotThrow(() => ts.onPong(1050, 7));
  assert.equal(ts.offset(), null);
  // A well-formed reply after the garbage still lands.
  ts.onPong(1050, { id: '0' });
  assert.equal(ts.offset(), 30);
  ts.stop();
});

test('timesync: echo.id of the wrong type (object, missing) is ignored', () => {
  const sent = [];
  const now = makeClock(1000);
  const ts = createTimeSync({ send: (m) => sent.push(m), now });
  ts.start(); // registers '0'
  now.advance(40);
  // echo.id must be a string or number — anything else is treated as a
  // malformed echo and dropped.
  assert.doesNotThrow(() => ts.onPong(1050, { id: { nested: true } }));
  assert.doesNotThrow(() => ts.onPong(1050, { id: null }));
  assert.doesNotThrow(() => ts.onPong(1050, {})); // missing id
  assert.equal(ts.offset(), null);
  ts.onPong(1050, { id: '0' });
  assert.equal(ts.offset(), 30);
  ts.stop();
});

test('timesync: non-finite serverNowMs is ignored', () => {
  const sent = [];
  const now = makeClock(1000);
  const ts = createTimeSync({ send: (m) => sent.push(m), now });
  ts.start();
  now.advance(40);
  for (const bad of [Infinity, -Infinity, NaN, '1050', null, undefined]) {
    assert.doesNotThrow(() => ts.onPong(bad, { id: '0' }));
  }
  assert.equal(ts.offset(), null);
  ts.onPong(1050, { id: '0' });
  assert.equal(ts.offset(), 30);
  ts.stop();
});

test('timesync: negative rtt (serverNow arrived before clientSendMs) is ignored', () => {
  // Hand-build a state where the receive clock is *before* the send clock —
  // sampleFromPong would yield a negative rtt, which §3.1 rejects (a
  // negative RTT is a clock or a packet-ordering anomaly, never real data).
  let t = 1000;
  const now = () => t;
  const ts = createTimeSync({ send: () => {}, now });
  ts.start(); // pending '0' -> 1000
  // Drop "receive time" to before "send time".
  t = 900;
  ts.onPong(1050, { id: '0' });
  assert.equal(ts.offset(), null);
  ts.stop();
});

test('timesync: never trusts echo.clientSendMs as a fallback — unknown id stays unknown', () => {
  // The classic attack: a malicious server replays a `time` reply with an id
  // we never sent, and stamps echo.clientSendMs with whatever timestamp it
  // wants to inject. The ring must reject it because the id isn't in pending,
  // and never fall back to "well, the wire says 500ms ago, use that".
  const sent = [];
  const now = makeClock(1000);
  const ts = createTimeSync({ send: (m) => sent.push(m), now });
  ts.start(); // only registers id '0'
  now.advance(40);
  ts.onPong(1050, { id: 'ghost', clientSendMs: 1000 }); // stranger, well-formed shape
  assert.equal(ts.offset(), null);
  ts.onPong(1050, { id: '0' });
  assert.equal(ts.offset(), 30);
  ts.stop();
});

test('timesync: stale pong from a prior connection is ignored after stop()', () => {
  // A reconnect supersedes the prior connection's `pending` map. A pong
  // arriving after stop() — i.e. one whose id belonged to the old session —
  // must not resurrect any state from the old session.
  const sent = [];
  const now = makeClock(1000);
  const ts = createTimeSync({ send: (m) => sent.push(m), now });
  ts.start(); // id '0' at t=1000
  now.advance(40);
  ts.stop(); // simulate the close handler's `timeSync.stop()`
  // Even with the right id, the post-stop map is empty — the reply is a
  // stranger now.
  assert.doesNotThrow(() => ts.onPong(1050, { id: '0' }));
  assert.equal(ts.offset(), null);
});

/* ---------------- net.js disconnect settlement (client reliability) ---------------- */

// Minimal in-process WebSocket shim: just enough surface for net.js's
// connect()/commit()/destroy() path. The constructor captures itself in a
// registry so each test can drive open/close events on the specific socket
// net.js built. We restore the original WebSocket on every test's exit so a
// failure here can't pollute the rest of the suite.
const WS_OPEN = 1;
const WS_CLOSED = 3;

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING — matches spec; tests must _open() to flip OPEN
    this.sent = [];
    this._listeners = {};
    MockWebSocket.instances.push(this);
  }
  send(data) {
    // Real WebSocket.send takes a string; net.js calls JSON.stringify, so
    // parse for ergonomic assertions on the resulting messages.
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this._fire('close', {});
  }
  addEventListener(ev, h) {
    (this._listeners[ev] ||= []).push(h);
  }
  _fire(ev, e) {
    for (const h of this._listeners[ev] || []) h(e);
  }
  _open() {
    this.readyState = WS_OPEN;
    this._fire('open', {});
  }
}

function installMockWebSocket() {
  const orig = globalThis.WebSocket;
  MockWebSocket.instances = [];
  globalThis.WebSocket = Object.assign(MockWebSocket, {
    CONNECTING: 0, OPEN: WS_OPEN, CLOSING: 2, CLOSED: WS_CLOSED,
  });
  return () => { globalThis.WebSocket = orig; };
}

// roster.js appends its panel to document.body. We stub document just enough
// to make that no-op — this is a headless test of L2's networking logic, not
// a DOM test, so the panel never needs to render. `panel.remove()` is
// roster.js's teardown hook, so the shim needs that too.
function installMockDocument() {
  const orig = globalThis.document;
  const makeNode = () => ({
    setAttribute() {},
    appendChild() {},
    remove() {},
    replaceChildren() {},
  });
  globalThis.document = {
    body: {
      appendChild() { /* swallow */ },
      removeChild() { /* swallow */ },
    },
    createElement() { return makeNode(); },
  };
  return () => { globalThis.document = orig; };
}

async function nextTick() {
  // connect()'s resolveUrl() is async (await), so the socket isn't built
  // until the microtask queue drains. Wait one.
  await new Promise((r) => setImmediate(r));
}

test('net: commit() while offline resolves {ok:false, reason:offline} (existing path preserved)', async () => {
  const restoreWS = installMockWebSocket();
  const restoreDoc = installMockDocument();
  try {
    const room = connectRoom({
      room: 't1',
      relayUrl: 'ws://mock/relay',
      name: 'alice',
    });
    await nextTick();
    // Don't drive the socket open — commit must hit the offline branch.
    const r = await room.commit('comp', { src: 'x' });
    assert.deepEqual(r, { ok: false, reason: 'offline' });
    room.destroy();
  } finally {
    restoreDoc();
    restoreWS();
  }
});

test('net: WebSocket close settles every queued commit exactly once with reason:disconnected', async () => {
  const restoreWS = installMockWebSocket();
  const restoreDoc = installMockDocument();
  try {
    const room = connectRoom({
      room: 't2',
      relayUrl: 'ws://mock/relay',
      name: 'alice',
    });
    await nextTick();
    const sock = MockWebSocket.instances[0];
    sock._open(); // drive open so commit() enqueues (not the offline branch)
    // Two commits in flight — must BOTH settle on close, in FIFO order,
    // each exactly once, with the disconnect reason.
    const p1 = room.commit('a', { src: '1' });
    const p2 = room.commit('b', { src: '2' });
    // Confirm the wire actually saw both commits.
    assert.deepEqual(sock.sent.filter((m) => m.t === 'commit').map((m) => m.componentId), ['a', 'b']);
    sock.close();
    const r1 = await p1;
    const r2 = await p2;
    assert.deepEqual(r1, { ok: false, reason: 'disconnected' });
    assert.deepEqual(r2, { ok: false, reason: 'disconnected' });
    // A subsequent commit must take the offline branch — the queue is empty.
    const r3 = await room.commit('c', { src: '3' });
    assert.deepEqual(r3, { ok: false, reason: 'offline' });
    room.destroy();
  } finally {
    restoreDoc();
    restoreWS();
  }
});

test('net: destroy() settles queued commits with reason:disconnected', async () => {
  const restoreWS = installMockWebSocket();
  const restoreDoc = installMockDocument();
  try {
    const room = connectRoom({
      room: 't3',
      relayUrl: 'ws://mock/relay',
      name: 'alice',
    });
    await nextTick();
    const sock = MockWebSocket.instances[0];
    sock._open();
    const p1 = room.commit('a', { src: '1' });
    const p2 = room.commit('b', { src: '2' });
    // destroy() (not close()) — must drain exactly the same way.
    room.destroy();
    const r1 = await p1;
    const r2 = await p2;
    assert.deepEqual(r1, { ok: false, reason: 'disconnected' });
    assert.deepEqual(r2, { ok: false, reason: 'disconnected' });
  } finally {
    restoreDoc();
    restoreWS();
  }
});

test('net: a fresh commit after reconnect never resolves against a stale resolver', async () => {
  // The dangerous case: socket closes mid-flight, then reconnect completes
  // and a new welcome arrives. The stale resolvers must NOT be carried
  // across — they were settled on close, the queue is empty, and a new
  // commit goes onto a fresh FIFO that the next `commit` echo will head.
  const restoreWS = installMockWebSocket();
  const restoreDoc = installMockDocument();
  try {
    const room = connectRoom({
      room: 't4',
      relayUrl: 'ws://mock/relay',
      name: 'alice',
    });
    await nextTick();
    const sock1 = MockWebSocket.instances[0];
    sock1._open();
    const stale = room.commit('a', { src: 'stale' });
    sock1.close();
    assert.deepEqual(await stale, { ok: false, reason: 'disconnected' });

    // After destroy() there is no live socket and the queue is empty — a
    // follow-up commit must take the offline path, never silently bind to
    // a stale resolver.
    room.destroy();
    const post = await room.commit('b', { src: 'post' });
    assert.deepEqual(post, { ok: false, reason: 'offline' });
  } finally {
    restoreDoc();
    restoreWS();
  }
});

console.log('all-PASS');
