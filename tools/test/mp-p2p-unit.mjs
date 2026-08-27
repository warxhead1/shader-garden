// Shader Garden — mp-p2p-unit.mjs
// Multiplayer spec §10 (mp-p2p-unit row) + the brief's required coverage.
// Pure-Node test of the frozen browser WebRTC transport in
// site/js/multiplayer/p2p-socket.js. Uses a fake signal server and a fake
// RTCPeerConnection that pairs two instances together — no real network,
// no real browser, no setTimeout dependency beyond what the host's tick
// loop needs (which we let run with the real timer; one tick per test
// is harmless).
//
// Coverage (from the brief):
//   1. host election (first signal member is the immutable host)
//   2. offer/answer (host is sole offerer, guest answers)
//   3. ICE buffering (candidates buffered until remote description;
//      tolerated before offer/answer)
//   4. reliable vs pose routing (control reliable ordered; pose
//      ordered:false, maxRetransmits:0)
//   5. reducer welcome/commit/tune/lease path (host local loopback fires
//      welcome; commit/tune/lease propagate to guests on control)
//   6. pose-drop backpressure (pose dropped when bufferedAmount >
//      POSE_BUFFERED_DROP_BYTES)
//   7. guest removal (host removes member + broadcasts peer.leave)
//   8. host-loss close (signal.host-lost -> guest closes 1012)
//   9. signaling stream contains no sg.mp gameplay
//
// Usage: node tools/test/mp-p2p-unit.mjs   (or via `node --test`)

import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createP2PSocket, OPEN, CONNECTING, CLOSED } from '../../site/js/multiplayer/p2p-socket.js';
import { PROTOCOL as MP_PROTOCOL } from '../../site/js/multiplayer/room-core.js';

// Track every P2PSocket created in this process so afterEach can close
// them on EVERY exit path (assertion failure, throw, normal completion).
// Without this, the host's tick setTimeout chain (TICK_INTERVAL_MS ≈ 67ms)
// keeps the event loop alive forever and the test process hangs past the
// CI timeout — see the regression that motivated this file's rewrite.
const tracked = new Set();

/* ======================================================================
 * Fake WebSocket
 * ====================================================================== */

const WS_CONNECTING = 0, WS_OPEN = 1, WS_CLOSING = 2, WS_CLOSED = 3;

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = WS_CONNECTING;
    this.sent = []; // raw strings we sent
    this._listeners = {};
    FakeWebSocket.instances.push(this);
    // Open on next microtask so consumers can attach listeners first.
    queueMicrotask(() => { if (this.readyState === WS_CONNECTING) this._open(); });
  }
  static get CONNECTING() { return WS_CONNECTING; }
  static get OPEN() { return WS_OPEN; }
  static get CLOSING() { return WS_CLOSING; }
  static get CLOSED() { return WS_CLOSED; }
  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  _fire(type, ev) {
    for (const h of this._listeners[type] || []) h(ev);
  }
  send(raw) {
    if (this.readyState !== WS_OPEN) return;
    this.sent.push(raw);
    if (this._signal) this._signal._onMessage(this, raw);
  }
  close() {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this._fire('close', {});
    if (this._signal) this._signal._onClose(this);
  }
  _open() {
    this.readyState = WS_OPEN;
    this._fire('open', {});
  }
  /** Test hook: receive a message AS IF from the signal server. */
  _receive(raw) {
    this._fire('message', { data: raw });
  }
}
FakeWebSocket.instances = [];

/* ======================================================================
 * Fake signal server — in-process, deterministic
 * ====================================================================== */

class FakeSignal {
  constructor() {
    /** ws -> { id, roomId, name, ws } */
    this.bySocket = new Map();
    /** id -> ws */
    this.byId = new Map();
    /** roomId -> Map<id, ws> */
    this.rooms = new Map();
    /** Every wire message for the "no sg.mp on the wire" assertion. */
    this.signalStream = [];
    this._idCounter = 0;
  }
  attach(ws) {
    const entry = { id: null, roomId: null, name: null, ws };
    this.bySocket.set(ws, entry);
    ws._signal = this;
  }
  /** Wire snapshot at call time. */
  snapshot() {
    return this.signalStream.slice();
  }
  _onMessage(ws, raw) {
    const entry = this.bySocket.get(ws);
    if (!entry) return;
    const msg = JSON.parse(raw);
    this.signalStream.push({ from: entry.id, msg });

    if (msg && msg.t === 'hello') {
      entry.id = `c${++this._idCounter}`;
      entry.roomId = msg.room;
      entry.name = msg.name;
      let room = this.rooms.get(msg.room);
      if (!room) { room = new Map(); this.rooms.set(msg.room, room); }
      const wasEmpty = room.size === 0;
      room.set(entry.id, ws);
      this.byId.set(entry.id, ws);
      const hostId = wasEmpty ? entry.id : [...room.keys()][0];
      const peers = [];
      for (const [otherId] of room) {
        if (otherId === entry.id) continue;
        const other = this.bySocket.get([...room.entries()].find(([, w]) => w === ws) ? null : ws); // (we just want the OTHER entries)
        // Just look up other entry directly:
        const otherWs = [...room.values()].find((w, i) => [...room.keys()][i] === otherId);
        const otherEntry = this.bySocket.get(otherWs);
        peers.push({ id: otherId, name: otherEntry ? otherEntry.name : '' });
      }
      ws._receive(JSON.stringify({
        t: 'signal.welcome',
        selfId: entry.id,
        hostId,
        peers,
      }));
      // Track the signal-server's OUTBOUND signal-layer messages on the
      // same stream as inbound — test 1's host-election invariant reads
      // signal.welcome back out of here, and the "no sg.mp on the wire"
      // test must cover BOTH directions (a buggy host that emitted e.g.
      // `{t:'commit', ...}` as a server-pushed message would be visible
      // on this stream regardless of direction).
      this.signalStream.push({
        direction: 'out',
        from: 'signal-server',
        to: entry.id,
        msg: { t: 'signal.welcome', selfId: entry.id, hostId, peers },
      });
      // Notify existing members about the new join — the host's
      // hostInitiatePeer is gated on signal.peer.join, so without this
      // emit the host never calls createOffer and the guest's control
      // channel never opens.
      for (const [otherId, otherWs] of room) {
        if (otherId === entry.id) continue;
        if (otherWs.readyState === WS_OPEN) {
          otherWs._receive(JSON.stringify({
            t: 'signal.peer.join',
            id: entry.id,
            name: entry.name,
          }));
          this.signalStream.push({
            direction: 'out',
            from: 'signal-server',
            to: otherId,
            msg: { t: 'signal.peer.join', id: entry.id, name: entry.name },
          });
        }
      }
    } else if (msg && msg.t === 'signal' && msg.to) {
      const targetWs = this.byId.get(msg.to);
      if (!targetWs || targetWs.readyState !== WS_OPEN) return;
      targetWs._receive(JSON.stringify({
        t: 'signal',
        from: entry.id,
        data: msg.data,
      }));
      // Track the relayed signal (SDP/ICE) so the no-sg.mp wire check
      // sees BOTH the inbound side (from the sender) and the outbound
      // side (to the receiver) — same channel, two endpoints.
      this.signalStream.push({
        direction: 'out',
        from: entry.id,
        to: msg.to,
        msg: { t: 'signal', from: entry.id, data: msg.data },
      });
    }
  }
  _onClose(ws) {
    const entry = this.bySocket.get(ws);
    if (!entry) return;
    if (entry.id && entry.roomId) {
      const room = this.rooms.get(entry.roomId);
      if (room) {
        const wasHost = [...room.keys()][0] === entry.id;
        room.delete(entry.id);
        // Notify remaining members about the leave.
        for (const [otherId, otherWs] of room) {
          if (otherWs.readyState === WS_OPEN) {
            otherWs._receive(JSON.stringify({ t: 'signal.peer.leave', id: entry.id }));
            this.signalStream.push({
              direction: 'out',
              from: 'signal-server',
              to: otherId,
              msg: { t: 'signal.peer.leave', id: entry.id },
            });
          }
        }
        // If the HOST disconnected, signal host-lost to remaining members.
        if (wasHost) {
          for (const [, otherWs] of room) {
            if (otherWs.readyState === WS_OPEN) {
              otherWs._receive(JSON.stringify({ t: 'signal.host-lost' }));
              this.signalStream.push({
                direction: 'out',
                from: 'signal-server',
                to: '*',
                msg: { t: 'signal.host-lost' },
              });
            }
          }
        }
        if (room.size === 0) this.rooms.delete(entry.roomId);
      }
      this.byId.delete(entry.id);
    }
    this.bySocket.delete(ws);
  }
  /** Test hook: force a host-loss emit (the host doesn't actually have to
   *  close; this is for testing the signal.host-lost path explicitly). */
  forceHostLost(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const hostId = [...room.keys()][0];
    for (const [id, ws] of room) {
      if (id !== hostId && ws.readyState === WS_OPEN) {
        ws._receive(JSON.stringify({ t: 'signal.host-lost' }));
      }
    }
  }
  /** Test hook: forcibly close one member's socket (simulates a TCP drop
   *  without going through host-lost). */
  disconnectMember(id) {
    const ws = this.byId.get(id);
    if (ws) ws.close();
  }
}

/* ======================================================================
 * Fake RTCPeerConnection — pairs two instances together for the test.
 * ====================================================================== */

class FakeRTCDataChannel {
  constructor(label, init = {}) {
    this.label = label;
    this._init = { ordered: init.ordered !== false, maxRetransmits: init.maxRetransmits };
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this._listeners = {};
    this._peer = null; // the paired channel on the other side
  }
  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  _fire(type, ev) {
    for (const h of this._listeners[type] || []) h(ev);
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error(`FakeDC(${this.label}): not open`);
    // The HOST/SENDER p2p-socket checks bufferedAmount > threshold BEFORE
    // calling send. This fake does not gate on bufferedAmount itself; the
    // threshold check is the production code's job, and the test sets
    // bufferedAmount directly to simulate backpressure. The actual send
    // always relays to the peer channel so we can observe routing.
    if (this._peer) this._peer._receive(data);
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this._fire('close', {});
  }
  _open() {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this._fire('open', {});
  }
  _receive(data) {
    this._fire('message', { data });
  }
  // Test hook: manually set bufferedAmount (for pose-drop test).
  setBufferedAmount(n) { this.bufferedAmount = n; }
}

class FakeRTCPeerConnection {
  constructor(config = {}) {
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this._listeners = {};
    this._localChannels = []; // we created these (host side)
    this._remoteChannels = []; // we received these (guest side, via datachannel event)
    this._peer = null;
    this._nextCandidate = 0;
    this._iceCandidatesSeen = []; // test spy: every addIceCandidate call
    // Chronological operation log. The ICE-buffering test reads this to
    // prove that addIceCandidate calls come AFTER setRemoteDescription —
    // i.e. that pendingRemoteCandidates was actually buffered (not
    // flushed on arrival) and then drained after remote description
    // landed. A correct impl MUST show [setRemoteDescription,
    // addIceCandidate, ...] in that order; an impl that flushes on
    // arrival would show the addIceCandidate rows first.
    this._opLog = [];
  }
  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  _fire(type, ev) {
    for (const h of this._listeners[type] || []) h(ev);
  }
  createDataChannel(label, init) {
    const ch = new FakeRTCDataChannel(label, init || {});
    ch._owner = this;
    this._localChannels.push(ch);
    return ch;
  }
  async createOffer() {
    return { type: 'offer', sdp: `fake-offer(${this._localChannels.map(c => c.label).join(',')})` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'fake-answer' };
  }
  async setLocalDescription(desc) {
    this._opLog.push({ op: 'setLocalDescription', type: desc && desc.type });
    this.localDescription = desc;
    if (desc && desc.type === 'offer') {
      this.signalingState = 'have-local-offer';
      this.connectionState = 'connecting';
    } else {
      this.signalingState = 'stable';
      this.connectionState = 'stable';
    }
    // Emit fake ICE candidates synchronously, like the real API does
    // after setLocalDescription. The host's icecandidate listener
    // forwards them via signal to the peer.
    for (let i = 0; i < 2; i++) {
      const cand = {
        candidate: `candidate:${++this._nextCandidate} 1 UDP 2122252543 127.0.0.1 typ host`,
        sdpMid: '0',
        sdpMLineIndex: i % Math.max(1, this._localChannels.length),
      };
      this._fire('icecandidate', { candidate: cand });
    }
  }
  async setRemoteDescription(desc) {
    this._opLog.push({ op: 'setRemoteDescription', type: desc && desc.type });
    this.remoteDescription = desc;
    if (desc && desc.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      this.connectionState = 'connecting';
      // Pair the peer's local channels with our remote channels, fire
      // ondatachannel for each, then open everything on a microtask so
      // the caller has a chance to install handlers.
      if (this._peer) {
        for (const peerLocalCh of this._peer._localChannels) {
          const ourRemote = new FakeRTCDataChannel(peerLocalCh.label, peerLocalCh._init);
          ourRemote._owner = this;
          this._remoteChannels.push(ourRemote);
          peerLocalCh._peer = ourRemote;
          ourRemote._peer = peerLocalCh;
          this._fire('datachannel', { channel: ourRemote });
        }
      }
      queueMicrotask(() => {
        // Open our newly-received remote channels AND the local channels
        // we already had. In real RTC both sides fire open after DTLS.
        for (const ch of this._remoteChannels) {
          if (ch.readyState === 'connecting') ch._open();
        }
        for (const ch of this._localChannels) {
          if (ch.readyState === 'connecting') ch._open();
        }
        // Also open on the peer's local channels if not already.
        if (this._peer) {
          for (const ch of this._peer._localChannels) {
            if (ch.readyState === 'connecting') ch._open();
          }
        }
      });
    } else {
      this.signalingState = 'stable';
      this.connectionState = 'stable';
      // Also open our local channels if not already (DTLS finished).
      queueMicrotask(() => {
        for (const ch of this._localChannels) {
          if (ch.readyState === 'connecting') ch._open();
        }
        if (this._peer) {
          for (const ch of this._peer._remoteChannels) {
            if (ch.readyState === 'connecting') ch._open();
          }
        }
      });
    }
  }
  async addIceCandidate(candidate) {
    this._opLog.push({ op: 'addIceCandidate' });
    this._iceCandidatesSeen.push(candidate);
  }
  close() {
    this._opLog.push({ op: 'close' });
    this.connectionState = 'closed';
    this._fire('connectionstatechange', {});
    for (const ch of this._localChannels) ch.close();
    for (const ch of this._remoteChannels) ch.close();
  }
  // Test hooks
  pairWith(other) { this._peer = other; other._peer = this; }
  get iceCandidatesSeen() { return this._iceCandidatesSeen.slice(); }
  get opLog() { return this._opLog.slice(); }
}

/* ======================================================================
 * Harness — wire a client to the fake signal + fake RTC, and await async
 * state transitions with a flush helper (microtasks + setImmediate).
 * ====================================================================== */

function makeRTC() {
  return new FakeRTCPeerConnection();
}

function makeClient({ signal, name, expectedPeers = 1 }) {
  // The p2p-socket captures WebSocketImpl at construction time, so we
  // capture a constructor function that returns a fresh FakeWebSocket and
  // attaches it to the signal. The first WebSocketImpl call returns the
  // very next instance the FakeWebSocket.instances list will record.
  const ws0 = new FakeWebSocket(`ws://signal/${name}`);
  signal.attach(ws0);

  // We need the SAME WebSocket instance across constructions. The
  // constructor takes the next instance from a static list; the simplest
  // way to "freeze" which instance is used is to monkey-patch the
  // WebSocketImpl to return the instance we already created.
  // The p2p-socket calls `new WebSocketImpl(signalUrl)` exactly once, so
  // we override the constructor on a per-client basis.
  const WSCtor = function (url) {
    return ws0; // ignore `new`; p2p-socket's `new WebSocketImpl(...)` will hit this
  };

  // Pre-allocate the per-peer RTCs up front. The host creates one RTC
  // per guest (one peer.join signal = one RTC), so a host with two
  // guests needs two pre-allocated RTCs. The first peer.join signal the
  // host processes gets rtcPool[0], the second gets rtcPool[1], and so
  // on. A guest creates exactly one RTC (its connection to the host),
  // so expectedPeers=1 is the right default for guests.
  const rtcPool = [];
  for (let i = 0; i < expectedPeers; i++) rtcPool.push(new FakeRTCPeerConnection());
  let nextRtcIdx = 0;
  const RTCImpl = function (config) {
    if (nextRtcIdx >= rtcPool.length) {
      throw new Error(`makeClient(${name}): no more pre-allocated RTCs (had ${rtcPool.length}); raise expectedPeers`);
    }
    return rtcPool[nextRtcIdx++];
  };

  const client = createP2PSocket({
    signalUrl: `ws://signal/${name}`,
    room: 'testroom',
    name,
    iceServers: [],
    WebSocketImpl: WSCtor,
    RTCPeerConnectionImpl: RTCImpl,
    clock: () => Date.now(),
  });
  tracked.add(client);
  return { client, ws: ws0, rtcPool };
}

// afterEach: tear down every tracked client + drain the event loop. The
// drain is what stops the host's tick chain (closeSocket clears the
// timer, but a microtask drain after close() guarantees the 'close'
// handler fired and the timer ref is released). Without this hook, a
// failure mid-test leaks the host's setTimeout forever.
afterEach(async () => {
  for (const c of tracked) {
    try { c.close(); } catch { /* */ }
  }
  tracked.clear();
  // Yield so 'close' listeners run before the next test spins up a new
  // client that re-uses any of the just-released state.
  await new Promise((r) => setImmediate(r));
});

async function flush(ms = 50) {
  // Drain microtasks + a small setImmediate to let async chains settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/* ======================================================================
 * TESTS
 * ====================================================================== */

test('host election: the FIRST signal member becomes the host and is OPEN after the local welcome loopback', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const { client, rtc } = makeClient({ signal, name: 'Alice' });
  // Track 'open' and 'message' events.
  const opens = [];
  const messages = [];
  client.addEventListener('open', () => opens.push(Date.now()));
  client.addEventListener('message', (e) => messages.push(JSON.parse(e.data)));

  await flush();
  assert.equal(client.readyState, OPEN, 'host is OPEN after welcome + local loopback');
  assert.equal(opens.length, 1, 'host fires exactly one open event');
  assert.equal(messages.length >= 1, true, 'host gets at least one welcome message via local loopback');
  // The first 'message' the host sees is the REDUCER welcome loopback
  // (room-core's welcomeMessage()). That envelope has selfId + room +
  // members + lease + ... but NOT hostId — hostId lives only on the
  // SIGNAL welcome (sg.signal.v1). The brief's "selfId === hostId when
  // alone" invariant is about the SIGNAL layer's authority, and the host
  // is the only member, so the signal layer's welcome must have matched
  // them. Verify via getTransportInfo().
  assert.equal(messages[0].t, 'welcome');
  assert.equal(messages[0].selfId, client.getTransportInfo().selfId);
  // Signal welcome recorded — hostId is the FIRST entry of the room,
  // and the first entry IS selfId when the room was empty.
  const welcome = signal.signalStream.find((e) => e.msg && e.msg.t === 'signal.welcome');
  assert.ok(welcome, 'signal.welcome was emitted');
  assert.equal(welcome.msg.selfId, welcome.msg.hostId, 'signal welcome: selfId === hostId when alone');
  const info = client.getTransportInfo();
  assert.equal(info.role, 'host');
  assert.equal(info.selfId, info.hostId);
  client.close();
});

test('host election: the SECOND signal member becomes a guest, guest becomes OPEN only after the control channel opens', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  // Now create a guest — but pair the pre-allocated RTCs BEFORE the
  // auto-flow's first setRemoteDescription runs, so ondatachannel fires
  // and DCs open via the auto-flow. The old test pairWith'd AFTER
  // makeClient + flush + manual SDP, which was a hack; the rtcPool
  // design lets us pair up front and trust the auto-flow to complete.
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  const opens = [];
  const messages = [];
  guest.client.addEventListener('open', () => opens.push(true));
  guest.client.addEventListener('message', (e) => messages.push(JSON.parse(e.data)));

  await flush(200);

  assert.equal(host.client.readyState, OPEN);
  assert.equal(guest.client.readyState, OPEN, 'guest is OPEN after control channel opens');
  assert.equal(opens.length, 1, 'guest fires exactly one open event');
  const info = guest.client.getTransportInfo();
  assert.equal(info.role, 'guest');
  assert.notEqual(info.selfId, info.hostId, 'guest: selfId !== hostId');
  assert.equal(messages.some((m) => m.t === 'welcome'), true, 'guest got welcome from host');

  host.client.close();
  guest.client.close();
});

test('offer/answer: host is the sole offerer; guest answers; SDP exchange is symmetric', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  // Pair BEFORE the auto-flow's setRemoteDescription runs.
  host.rtcPool[0].pairWith(guest.rtcPool[0]);

  // After flush, the auto-flow has exchanged both offer and answer.
  await flush(200);
  // Capture SDP messages sent on the signal bus (both directions).
  const sdpSignals = signal.signalStream
    .filter((m) => m.msg && m.msg.t === 'signal' && m.msg.data && (m.msg.data.type === 'offer' || m.msg.data.type === 'answer'))
    .map((m) => ({ type: m.msg.data.type, from: m.from, to: m.msg.to }));
  assert.equal(sdpSignals.some((s) => s.type === 'offer' && s.from === host.client.getTransportInfo().selfId), true, 'host sent an offer');
  assert.equal(sdpSignals.some((s) => s.type === 'answer' && s.from === guest.client.getTransportInfo().selfId), true, 'guest sent an answer');

  // The auto-flow set local/remote descriptions symmetrically. Verify
  // each side landed the matching description type.
  assert.equal(host.rtcPool[0].localDescription && host.rtcPool[0].localDescription.type, 'offer');
  assert.equal(guest.rtcPool[0].remoteDescription && guest.rtcPool[0].remoteDescription.type, 'offer');
  assert.equal(guest.rtcPool[0].localDescription && guest.rtcPool[0].localDescription.type, 'answer');
  assert.equal(host.rtcPool[0].remoteDescription && host.rtcPool[0].remoteDescription.type, 'answer');

  host.client.close();
  guest.client.close();
});

test('ICE: candidates arriving BEFORE the offer/answer are buffered and flushed after remote description', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);

  // Drive the auto-flow to completion (offer/answer/ICE).
  await flush(200);

  // The brief's invariant: "candidates arriving BEFORE the offer/answer
  // are buffered and flushed after remote description." We prove it
  // three ways against the auto-flow's natural chronology:
  //
  //   (a) Wire ordering: candidates reached the signal bus BEFORE the
  //       first SDP message did — the host's setLocalDescription fires
  //       ICE events synchronously BEFORE the .then() that signalSend's
  //       the offer. So the buffer had to absorb them.
  //   (b) RTC opLog: on the guest's RTC, the FIRST addIceCandidate call
  //       comes AFTER the FIRST setRemoteDescription call. An impl that
  //       flushed on arrival would show addIceCandidate rows first.
  //   (c) Count match: every candidate the host emitted over the wire
  //       landed as an addIceCandidate on the guest. Buffering neither
  //       dropped nor duplicated.
  const stream = signal.signalStream;
  const firstCandWireIdx = stream.findIndex(
    (e) => e.msg && e.msg.t === 'signal' && e.msg.data && 'candidate' in e.msg.data
  );
  const firstSdpWireIdx = stream.findIndex(
    (e) => e.msg && e.msg.t === 'signal' && e.msg.data && (e.msg.data.type === 'offer' || e.msg.data.type === 'answer')
  );
  assert.ok(firstCandWireIdx >= 0, 'at least one candidate on the wire');
  assert.ok(firstSdpWireIdx >= 0, 'at least one SDP on the wire');
  assert.ok(
    firstCandWireIdx < firstSdpWireIdx,
    `first candidate (wire idx ${firstCandWireIdx}) arrived before first SDP (${firstSdpWireIdx})`
  );

  const guestOps = guest.rtcPool[0].opLog;
  const firstSetRemoteIdx = guestOps.findIndex((o) => o.op === 'setRemoteDescription');
  const firstAddIceIdx = guestOps.findIndex((o) => o.op === 'addIceCandidate');
  assert.ok(firstSetRemoteIdx >= 0, 'guest: setRemoteDescription was called');
  assert.ok(firstAddIceIdx >= 0, 'guest: addIceCandidate was called');
  assert.ok(
    firstSetRemoteIdx < firstAddIceIdx,
    `guest: first addIceCandidate (op idx ${firstAddIceIdx}) came AFTER first setRemoteDescription (${firstSetRemoteIdx}) — buffered, then flushed`
  );

  // The signalStream tracks BOTH the inbound (sender side) and the
  // outbound (relay side) of every signal message, so the same candidate
  // appears twice. Count unique candidates by their candidate string
  // across both directions — each unique candidate should match exactly
  // one addIceCandidate call on the guest. The wire payload is
  // {candidate: <string>, sdpMid, sdpMLineIndex} (flat), so the
  // candidate string IS e.msg.data.candidate.
  const candsOnWire = new Set(
    stream
      .filter((e) => e.msg && e.msg.t === 'signal' && e.msg.data && typeof e.msg.data.candidate === 'string')
      .map((e) => e.msg.data.candidate)
      .filter(Boolean)
  );
  const candsApplied = guest.rtcPool[0].iceCandidatesSeen.length;
  assert.equal(
    candsApplied, candsOnWire.size,
    `applied ${candsApplied} candidates === emitted ${candsOnWire.size} unique over wire`
  );

  host.client.close();
  guest.client.close();
});

test('routing: control channel is RELIABLE ORDERED, pose channel is UNRELIABLE UNORDERED (ordered:false, maxRetransmits:0)', async () => {
  // Capture the init args passed to createDataChannel on the host side.
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);

  // Wait for the auto-flow's hostInitiatePeer to create the DCs.
  await flush(200);

  const createdChannels = [];
  const origCreateDC = host.rtcPool[0].createDataChannel.bind(host.rtcPool[0]);
  host.rtcPool[0].createDataChannel = function (label, init) {
    createdChannels.push({ label, init: { ...init } });
    return origCreateDC(label, init);
  };

  // The host already created its DCs in hostInitiatePeer — verify the
  // live ones carry the right init. (createDataChannel was patched too
  // late for those calls, so we read _init directly off the existing
  // FakeRTCDataChannel instances.)
  const hostChannels = host.rtcPool[0]._localChannels;
  const ctrlCh = hostChannels.find((c) => c.label === 'sg-mp-control-v1');
  const poseCh = hostChannels.find((c) => c.label === 'sg-mp-pose-v1');
  assert.ok(ctrlCh, 'host has control channel');
  assert.ok(poseCh, 'host has pose channel');
  assert.equal(ctrlCh._init.ordered, true, 'control: ordered:true (reliable)');
  assert.equal(poseCh._init.ordered, false, 'pose: ordered:false (unreliable)');
  assert.equal(poseCh._init.maxRetransmits, 0, 'pose: maxRetransmits:0');

  host.client.close();
  guest.client.close();
});

test('reducer: host local hello -> welcome loopback; host commit/tune/lease propagate to guest on control', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  await flush(200);
  // Both are OPEN now; the guest's hello has already arrived at the host
  // and the host has broadcast welcome + peer.join.

  // Register BOTH listeners BEFORE the first send — the host loopback
  // fires synchronously during send processing, and the guest's lease
  // arrives over control from the host's lease.request handler.
  const hostMessages = [];
  host.client.addEventListener('message', (e) => hostMessages.push(JSON.parse(e.data)));
  const guestMessages = [];
  guest.client.addEventListener('message', (e) => guestMessages.push(JSON.parse(e.data)));

  // Drive a lease.request from the host (requires ring first).
  host.client.send(JSON.stringify({ t: 'ring', inRing: true }));
  host.client.send(JSON.stringify({ t: 'lease.request' }));
  // The host sends a commit (after ring+lease). Use a fake component id.
  host.client.send(JSON.stringify({ t: 'commit', componentId: 1, body: '// hi', baseEpoch: 0 }));
  host.client.send(JSON.stringify({ t: 'tune', name: 'speed', value: 1.5 }));
  await flush();
  const leaseOnHost = hostMessages.find((m) => m.t === 'lease' && m.holder === host.client.getTransportInfo().selfId);
  assert.ok(leaseOnHost, 'host got its own lease via reducer loopback');
  const commitOnGuest = guestMessages.find((m) => m.t === 'commit' && m.componentId === 1);
  const tuneOnGuest = guestMessages.find((m) => m.t === 'tune' && m.name === 'speed');
  const leaseOnGuest = guestMessages.find((m) => m.t === 'lease');
  assert.ok(commitOnGuest, 'guest received commit over control');
  assert.equal(commitOnGuest.by, host.client.getTransportInfo().selfId, 'commit.by is host selfId');
  assert.equal(commitOnGuest.epoch, 1, 'commit.epoch advanced');
  assert.ok(tuneOnGuest, 'guest received tune over control');
  assert.equal(tuneOnGuest.value, 1.5);
  assert.ok(leaseOnGuest, 'guest received lease over control');
  assert.equal(leaseOnGuest.holder, host.client.getTransportInfo().selfId);

  host.client.close();
  guest.client.close();
});

test('pose-drop backpressure: pose messages are DROPPED when bufferedAmount exceeds the documented bound', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  await flush(200);

  // The guest sends a pose. The guest's send() routes {t:'pose'} to the
  // pose channel. Simulate backpressure by setting the guest's pose
  // channel bufferedAmount above the threshold.
  const guestPoseCh = guest.rtcPool[0]._remoteChannels.find((c) => c.label === 'sg-mp-pose-v1');
  assert.ok(guestPoseCh, 'guest has pose channel');
  guestPoseCh.setBufferedAmount(512 * 1024); // 512 KiB > 256 KiB threshold

  // Capture messages on the host's pose channel.
  const hostPoseMsgs = [];
  const hostPoseCh = host.rtcPool[0]._localChannels.find((c) => c.label === 'sg-mp-pose-v1');
  assert.ok(hostPoseCh, 'host has pose channel');
  const origReceive = hostPoseCh._receive.bind(hostPoseCh);
  hostPoseCh._receive = function (data) {
    hostPoseMsgs.push(data);
    origReceive(data);
  };

  // Send a pose from the guest. The p2p-socket checks bufferedAmount and drops.
  guest.client.send(JSON.stringify({ t: 'pose', x: 1, z: 2, yaw: 0, speed01: 0, gait: 0 }));
  await flush();
  assert.equal(hostPoseMsgs.length, 0, 'pose was dropped (no message on host pose channel)');

  // Clear backpressure and try again — should land.
  guestPoseCh.setBufferedAmount(0);
  guest.client.send(JSON.stringify({ t: 'pose', x: 1, z: 2, yaw: 0, speed01: 0, gait: 0 }));
  await flush();
  assert.equal(hostPoseMsgs.length, 1, 'pose arrived after backpressure cleared');

  host.client.close();
  guest.client.close();
});

test('guest removal: when a guest leaves, host removes the member and broadcasts peer.leave to the remaining guest', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  // Host needs two pre-allocated RTCs: one per guest. The first peer.join
  // signal the host processes gets rtcPool[0], the second gets [1].
  const host = makeClient({ signal, name: 'Alice', expectedPeers: 2 });
  await flush();
  // Create each guest and pair IMMEDIATELY (before any flush could run
  // the auto-flow against an un-paired RTC). The intermediate flushes
  // before this fix ran auto-flow with null _peer and corrupted state.
  const guestA = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guestA.rtcPool[0]);
  await flush(200);
  const guestB = makeClient({ signal, name: 'Carol' });
  host.rtcPool[1].pairWith(guestB.rtcPool[0]);
  await flush(300);

  // Both guests joined; both are in the host's peers Map (the SDP didn't
  // matter for that — hostInitiatePeer registers the peer entry as soon
  // as the peer.join signal lands, which is independent of DTLS open).
  const hostInfoBefore = host.client.getTransportInfo();
  assert.equal(hostInfoBefore.peers.length, 2, 'host has 2 peers (A and B)');
  const aId = guestA.client.getTransportInfo().selfId;
  const bId = guestB.client.getTransportInfo().selfId;
  const peerIds = hostInfoBefore.peers.map((p) => p.id).sort();
  assert.deepEqual(peerIds, [aId, bId].sort(), 'host sees A and B as peers');

  // Capture peer.leave messages on host AND on guestB (the remaining
  // guest). guestB's control channel needs to be open to receive
  // peer.leave; only B's pair completed (A's pairWith ran in this test
  // but A's auto-flow only completes if its host RTC's offer/answer
  // chain ran without a race — we pair A too, so A's control also opens).
  const hostMessages = [];
  host.client.addEventListener('message', (e) => hostMessages.push(JSON.parse(e.data)));
  const bMessages = [];
  guestB.client.addEventListener('message', (e) => bMessages.push(JSON.parse(e.data)));

  // Disconnect guest A from the signal server. The FakeSignal emits
  // signal.peer.leave to remaining room members (including B), which
  // the host's onPeerLeave handler turns into hostRemovePeer → removeMember
  // → peer.leave broadcast on '*'.
  signal.disconnectMember(aId);
  await flush();

  // Host's info should now show one peer (B).
  const hostInfoAfter = host.client.getTransportInfo();
  assert.equal(hostInfoAfter.peers.length, 1, 'host has 1 peer after guest A leaves');
  assert.equal(hostInfoAfter.peers[0].id, bId, 'remaining peer is B');

  // Host got exactly one peer.leave loopback (since removeMember's
  // sends.to === '*' includes the host).
  const hostPeerLeaves = hostMessages.filter((m) => m.t === 'peer.leave');
  assert.equal(hostPeerLeaves.length, 1, `host got exactly one peer.leave (got ${hostPeerLeaves.length})`);
  assert.equal(hostPeerLeaves[0].id, aId, 'host peer.leave.id is the removed guest (A)');

  // The remaining guest (B) received exactly one peer.leave on the
  // control channel. This is the visible "tell" the other guests
  // learn about the leave from — without it, B's roster would never
  // know A is gone until the host's peer.leave round-trip.
  const bPeerLeaves = bMessages.filter((m) => m.t === 'peer.leave');
  assert.equal(bPeerLeaves.length, 1, `remaining guest B got exactly one peer.leave (got ${bPeerLeaves.length})`);
  assert.equal(bPeerLeaves[0].id, aId, 'B peer.leave.id is the removed guest (A)');

  host.client.close();
  guestA.client.close();
  guestB.client.close();
});

test('host loss: signal.host-lost -> guest closes with code 1012 ("host lost")', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  await flush(200);
  assert.equal(guest.client.readyState, OPEN, 'preflight: guest is OPEN');

  let closeEv = null;
  guest.client.addEventListener('close', (e) => { closeEv = e; });

  // Force the signal server to emit signal.host-lost to remaining guests.
  signal.forceHostLost('testroom');
  await flush();

  assert.equal(guest.client.readyState, CLOSED, 'guest is CLOSED after host-lost');
  assert.ok(closeEv, 'guest fired close event');
  assert.equal(closeEv.code, 1012, 'close code is 1012 (host lost)');

  host.client.close();
});

test('signaling stream: NO sg.mp gameplay messages ever travel over the signal bus', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  await flush(200);

  // Run a representative slice of gameplay through the host.
  host.client.send(JSON.stringify({ t: 'ring', inRing: true }));
  host.client.send(JSON.stringify({ t: 'lease.request' }));
  host.client.send(JSON.stringify({ t: 'commit', componentId: 1, body: 'foo', baseEpoch: 0 }));
  host.client.send(JSON.stringify({ t: 'tune', name: 'speed', value: 1.5 }));
  host.client.send(JSON.stringify({ t: 'game.start' }));
  host.client.send(JSON.stringify({ t: 'tag', targetId: guest.client.getTransportInfo().selfId }));
  await flush();

  // Inspect the signal stream. Every message must be a SIGNAL-layer
  // message (hello, signal.welcome, signal.peer.join/leave, signal,
  // signal.host-lost) — never a sg.mp.* gameplay message.
  const stream = signal.signalStream;
  assert.ok(stream.length > 0, 'signal stream has messages');
  const SG_MP_TS = new Set([
    'welcome', 'peer.join', 'peer.leave', 'peer.rename',
    'poses', 'lease', 'draft', 'commit', 'reject',
    'game', 'tag', 'time', 'error', 'tune',
    'ping', 'pose', 'ring', 'lease.request', 'lease.keepalive', 'lease.release',
    'snapshot.request', 'rename',
  ]);
  for (const entry of stream) {
    const t = entry.msg && entry.msg.t;
    assert.equal(SG_MP_TS.has(t), false, `sg.mp gameplay message ${t} leaked into the signal stream`);
    // 'signal' is the bare SDP/ICE relay envelope; 'signal.*' is the
    // namespaced server-emitted events (welcome/peer.join/leave/host-lost).
    // 'hello' is the only inbound client-emitted signal-layer message.
    const allowed = t === 'hello' || t === 'signal' || (typeof t === 'string' && t.startsWith('signal.'));
    assert.equal(allowed, true, `unexpected signal-stream message: ${t}`);
  }

  host.client.close();
  guest.client.close();
});

test('transport info: getTransportInfo() reports role/selfId/hostId/peers and is callable any time', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const info = host.client.getTransportInfo();
  assert.equal(info.role, 'host');
  assert.equal(typeof info.selfId, 'string');
  assert.equal(info.selfId, info.hostId);
  assert.ok(Array.isArray(info.peers));
  host.client.close();
});

/* ======================================================================
 * Backpressure: control must fail closed on every open-channel send that
 * exceeds the bound, not silently drop. Two halves — host (sendToPeer
 * path) and guest (public send path).
 * ====================================================================== */

test('backpressure (host): a control send whose target peer control buffer exceeds the bound triggers hostRemovePeer, never a silent drop', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  await flush(200);

  // Drive the peer into the room so we have a peer entry to send to.
  host.client.send(JSON.stringify({ t: 'ring', inRing: true }));
  host.client.send(JSON.stringify({ t: 'lease.request' }));
  await flush();
  const hostInfoBefore = host.client.getTransportInfo();
  assert.equal(hostInfoBefore.peers.length, 1, 'preflight: host has the guest as a peer');

  // Force the peer's control channel bufferedAmount past the bound.
  const hostControlCh = host.rtcPool[0]._localChannels.find((c) => c.label === 'sg-mp-control-v1');
  assert.ok(hostControlCh, 'host has control channel');
  hostControlCh.setBufferedAmount(2 * 1024 * 1024); // 2 MiB > 1 MiB

  // Count peer.leave broadcasts (sent on host's local loopback when
  // removeMember fires). With a recursive / non-fenced impl, this would
  // be > 1.
  const peerLeaves = [];
  host.client.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'peer.leave') peerLeaves.push(m.id);
  });

  // Trigger a control send whose sendToPeer check will trip the bound.
  // A commit broadcasts to '*' which calls sendToPeer for every peer.
  host.client.send(JSON.stringify({ t: 'commit', componentId: 1, body: '// x', baseEpoch: 0 }));
  await flush();

  // The host's sendToPeer must have observed the over-bound condition
  // and called hostRemovePeer for the peer — not silently dropped the
  // message. We assert this via the visible side effect: the peer entry
  // is gone.
  const hostInfoAfter = host.client.getTransportInfo();
  assert.equal(hostInfoAfter.peers.length, 0, 'peer removed after control overflow (no silent drop)');
  assert.equal(peerLeaves.length, 1, `exactly one peer.leave broadcast (got ${peerLeaves.length})`);
  assert.equal(peerLeaves[0], guest.client.getTransportInfo().selfId);

  host.client.close();
});

test('backpressure (guest): a public send() over an open control channel whose bufferedAmount exceeds the bound closes the socket with an explicit code (never swallowed as success)', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  await flush(200);
  assert.equal(guest.client.readyState, OPEN, 'preflight: guest is OPEN');

  // Force the guest's control channel buffer over the bound.
  const guestControlCh = guest.rtcPool[0]._remoteChannels.find((c) => c.label === 'sg-mp-control-v1');
  assert.ok(guestControlCh, 'guest has control channel');
  guestControlCh.setBufferedAmount(2 * 1024 * 1024);

  let closeEv = null;
  guest.client.addEventListener('close', (e) => { closeEv = e; });

  // Send a control-class message. The guest's send() must observe the
  // over-bound condition and close visibly with 1014 (control-overflow),
  // not swallow the failure as success.
  guest.client.send(JSON.stringify({ t: 'ring', inRing: true }));
  await flush();

  assert.ok(closeEv, 'guest fired close after control overflow');
  assert.equal(closeEv.code, 1014, 'close code is 1014 (control-overflow), explicit and visible');
  assert.equal(guest.client.readyState, CLOSED);

  host.client.close();
});

/* ======================================================================
 * Re-entrancy fence: synchronous data-channel / RTC close events must not
 * re-enter hostRemovePeer recursively. Delete ownership BEFORE teardown.
 * ====================================================================== */

test('re-entrancy: synchronous data-channel close during hostRemovePeer does not re-enter hostRemovePeer (no double peer.leave)', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  await flush(200);
  // Drive the peer into the room so hostRemovePeer has something to remove.
  host.client.send(JSON.stringify({ t: 'ring', inRing: true }));
  host.client.send(JSON.stringify({ t: 'lease.request' }));
  await flush();

  // Track every peer.leave loopback fired on the host. Without the
  // re-entrancy fence, a synchronous control.close() / pc.close() during
  // teardown re-enters hostRemovePeer and runs removeMember again,
  // producing a second peer.leave broadcast.
  const peerLeaves = [];
  host.client.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'peer.leave') peerLeaves.push(m);
  });

  // Trigger the path: signal-side disconnect fires onPeerLeave ->
  // hostRemovePeer -> teardownPeer. The fake RTC fires connectionstate-
  // change and data-channel close synchronously inside pc.close(); our
  // close handler calls hostRemovePeer again. With the fence, the
  // second call is a no-op (peer already deleted from the Map).
  signal.disconnectMember(guest.client.getTransportInfo().selfId);
  await flush();

  assert.equal(peerLeaves.length, 1, `exactly one peer.leave (no re-entry); got ${peerLeaves.length}`);
  assert.equal(host.client.getTransportInfo().peers.length, 0);

  host.client.close();
});

/* ======================================================================
 * addIceCandidate returns a Promise — tryFlushPendingCandidates must wrap
 * it so a rejection does not surface as an unhandled promise rejection.
 * ====================================================================== */

test('ICE: a rejected addIceCandidate Promise does not surface as an unhandled rejection', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);

  // Install a global handler so we can detect an unhandled rejection.
  // Node 26 emits a warning but does not fail the process; we observe
  // by counting 'unhandledRejection' firings during the ICE flow.
  const rejections = [];
  const onRej = (reason, promise) => rejections.push(reason);
  process.on('unhandledRejection', onRej);

  // Make the guest's addIceCandidate always reject — simulating a
  // network or parsing error in real WebRTC. This is the ONLY thing
  // the implementation has to handle correctly: the rejection must be
  // OWNED (caught and ignored), not leak to the host.
  guest.rtcPool[0].addIceCandidate = function () { return Promise.reject(new Error('simulated ICE failure')); };

  // Let the auto-flow run end-to-end. The host emits ICE candidates
  // during setLocalDescription; the impl forwards them via signal;
  // guestReceiveOffer's setRemoteDescription(offer).then() calls
  // tryFlushPendingCandidates which invokes addIceCandidate for each
  // buffered candidate — every call rejects, and the impl MUST own
  // each rejection via Promise.resolve(...).catch().
  await flush(200);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20)); // give any queued rejection a tick to surface
  assert.equal(rejections.length, 0, `expected zero unhandled rejections, got ${rejections.length}: ${rejections.map(String).join(' | ')}`);

  process.removeListener('unhandledRejection', onRej);

  host.client.close();
  guest.client.close();
});

/* ======================================================================
 * flushBufferedControl: drain path must enforce the bound on EVERY queued
 * send and tear the peer down on the first exceed — never silently catch.
 * Mirrors the per-send check in sendToPeer so a queue of reliable messages
 * cannot get swallowed under backpressure simply because the channel
 * opened mid-drain.
 * ====================================================================== */

test('flushBufferedControl: a queued control send whose bufferedAmount exceeds the bound during drain calls hostRemovePeer (no silent catch)', async () => {
  FakeWebSocket.instances = [];
  const signal = new FakeSignal();
  const host = makeClient({ signal, name: 'Alice' });
  await flush();
  const guest = makeClient({ signal, name: 'Bob' });
  host.rtcPool[0].pairWith(guest.rtcPool[0]);
  // Let the auto-flow complete: peer.join → hostInitiatePeer → offer →
  // guest's setRemoteDescription → answer → host's setRemoteDescription
  // → host's local control channel opens. The host's local channel is
  // the SAME object that peer.control references inside the transport.
  await flush(300);

  // Sanity: control channel is open and the peer entry exists.
  const hostControlCh = host.rtcPool[0]._localChannels.find((c) => c.label === 'sg-mp-control-v1');
  assert.ok(hostControlCh, 'host has local control channel');
  assert.equal(hostControlCh.readyState, 'open', 'preflight: control channel is open');
  assert.equal(host.client.getTransportInfo().peers.length, 1, 'preflight: host has 1 peer');

  // Force the channel back to 'connecting' so subsequent sends route to
  // peer.bufferedControl. We then queue several broadcasts and finally
  // flip readyState back to 'open' AND fire 'open' to invoke the
  // production onControlOpen listener (which calls flushBufferedControl).
  hostControlCh.readyState = 'connecting';

  // Drive three broadcasts to '*' so bufferedControl accumulates multiple
  // items. ring + lease.request acquires the lease; tune + commit also
  // broadcast (gated on lease.holder === from, satisfied by host's own
  // lease.request). Each send goes through hostRunReducer → dispatch →
  // sendToPeer, which sees readyState !== 'open' and pushes to
  // peer.bufferedControl.
  host.client.send(JSON.stringify({ t: 'ring', inRing: true }));
  host.client.send(JSON.stringify({ t: 'lease.request' }));
  host.client.send(JSON.stringify({ t: 'tune', name: 'speed', value: 1.5 }));
  host.client.send(JSON.stringify({ t: 'commit', componentId: 1, body: '// hi', baseEpoch: 0 }));

  // Patch send so the first call during the upcoming flush bumps
  // bufferedAmount above CONTROL_BUFFERED_CLOSE_BYTES (1 MiB). The
  // second queued item's per-item check then trips hostRemovePeer.
  const origSend = hostControlCh.send.bind(hostControlCh);
  let sendCalls = 0;
  hostControlCh.send = function (data) {
    sendCalls++;
    if (sendCalls === 1) {
      hostControlCh.setBufferedAmount(2 * 1024 * 1024); // 2 MiB > 1 MiB
    }
    return origSend(data);
  };

  // Track peer.leave loopbacks. The hostRemovePeer path dispatches the
  // reducer's send (to === '*'), which fires the host's own loopback
  // message. The re-entrancy fence guarantees exactly one broadcast.
  const peerLeaves = [];
  host.client.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'peer.leave') peerLeaves.push(m.id);
  });

  // Trigger the production onControlOpen path: flip readyState back to
  // 'open' so flushBufferedControl's guard passes, then fire 'open'
  // to invoke the listener the transport registered when the channel
  // was first created. flushBufferedControl drains the queue.
  hostControlCh.readyState = 'open';
  hostControlCh._fire('open', {});
  await flush();

  // The first queued item passed the bound check (bufferedAmount was 0),
  // bumped it past the bound via the patch on send, and was sent. The
  // second iteration's per-item check then found bufferedAmount > bound
  // and called hostRemovePeer — BEFORE attempting the second send. So
  // sendCalls === 1 proves the per-item enforcement, not a single
  // up-front check that would have skipped the queue entirely or, worse,
  // a silent try/catch that would have shipped the second message and
  // then ignored the failure.
  assert.equal(sendCalls, 1, `flushBufferedControl sent exactly the first item (got ${sendCalls})`);
  // The peer entry is gone — hostRemovePeer deleted ownership before
  // dispatching the reducer's peer.leave send.
  assert.equal(host.client.getTransportInfo().peers.length, 0, 'peer removed after queue-drain overflow');
  // Exactly one peer.leave loopback (fence prevents re-entry on the
  // synchronous close fired by teardownPeer → pc.close → control.close).
  assert.equal(peerLeaves.length, 1, `exactly one peer.leave (got ${peerLeaves.length})`);

  host.client.close();
  guest.client.close();
});

// CI's "Battery verdict" step derives each suite's result by grepping its
// log for `all-PASS`. node:test owns the exit code: 0 when every assertion
// passed, 1 when any failed. Print the sentinel ONLY on a clean exit so a
// process that hangs past the timeout does not falsely advertise success.
// process.on('exit') fires AFTER node:test's summary and AFTER the after
// hook above, so 'all-PASS' is always the LAST line the log shows when
// the gate is genuinely green.
process.on('exit', (code) => {
  if (code === 0 || code === undefined) {
    console.log('all-PASS');
  } else {
    console.log(`FAIL (exit ${code})`);
  }
});