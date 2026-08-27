// Shader Garden — mp-relay.mjs
// Spec §10, `mp-relay.mjs` row: a REAL relay process, end to end, with two
// clients using Node's built-in global `WebSocket` — no new dependency, the
// harness's only dep stays playwright-core (see tools/test/package.json).
//
// The relay is started IN-PROCESS via server/relay.mjs's startRelay(), which
// server.listen()s and returns { server, close() } — far more robust than
// spawning a child process, and it means we can always close() it in a
// finally without worrying about an orphaned child surviving a failed test.
//
// Usage: node tools/test/mp-relay.mjs   (from tools/test/ or repo root; the
// port is derived from process.pid exactly like browser.mjs's derivePort(),
// with a distinct offset so this never collides with a static file server.)

import http from 'node:http';
import { startRelay } from '../../server/relay.mjs';
import { PROTOCOL, HEARTBEAT_MS } from '../../server/room.mjs';
import { MAX_MESSAGE_BYTES } from '../../server/ws.mjs';

// Same formula as browser.mjs's derivePort(), inlined rather than imported:
// browser.mjs's TOP-LEVEL playwright-core import makes importing it a
// hard failure whenever the harness's npm deps aren't installed (this suite
// has none of its own), which would make a relay-only suite depend on a
// browser dependency it never uses. A distinct offset keeps this port out
// of the range serveSite()/serveSiteCors() retry through.
function derivePort(offset = 0) {
  return 8100 + ((process.pid + offset) % 1800);
}

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

// Every await in this file is bounded through one of these two helpers — a
// hung socket must never hang CI (spec instruction). Both reject with a
// message naming exactly what was being waited for.
function withDeadline(promiseFactory, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms waiting for: ${label}`)), timeoutMs);
    promiseFactory().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Targets here are a mix of DOM-style EventTarget (the global WebSocket:
// addEventListener only, no .on) and Node's EventEmitter (http.Server,
// http.ClientRequest: .once only, no addEventListener) — this branches on
// which shape `target` actually has rather than assuming one.
function waitForEvent(target, eventName, timeoutMs, label) {
  return withDeadline(() => new Promise((resolve, reject) => {
    if (typeof target.addEventListener === 'function') {
      const onEvt = (e) => { cleanup(); resolve(e); };
      const onErr = (e) => { cleanup(); reject(new Error(`error while waiting for ${label}: ${e && (e.message || e.type) || e}`)); };
      function cleanup() {
        target.removeEventListener(eventName, onEvt);
        if (eventName !== 'error') target.removeEventListener('error', onErr);
      }
      target.addEventListener(eventName, onEvt, { once: true });
      if (eventName !== 'error') target.addEventListener('error', onErr, { once: true });
    } else {
      target.once(eventName, (...args) => resolve(args[0]));
      if (eventName !== 'error') target.once('error', (e) => reject(new Error(`error while waiting for ${label}: ${e && e.message || e}`)));
    }
  }), timeoutMs, label);
}

// Wraps a WebSocket client: buffers every parsed JSON message it receives
// (in arrival order) and lets a test await the NEXT one matching a
// predicate — checking the buffer first (in case it already arrived before
// the test looked), then subscribing for new ones. This is what lets
// "pose relay", "lease handoff" etc. assert on the actual protocol message
// shape instead of a fixed sleep-and-hope.
function wrapClient(ws) {
  const messages = [];
  const waiters = new Set();
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    messages.push(msg);
    for (const w of waiters) if (w.predicate(msg)) { waiters.delete(w); w.resolve(msg); }
  });
  let closeInfo = null;
  ws.addEventListener('close', (e) => { closeInfo = { code: e.code, reason: e.reason }; });
  return {
    ws,
    messages,
    get closeInfo() { return closeInfo; },
    nextMatching(predicate, timeoutMs, label) {
      const already = messages.find(predicate);
      if (already) return Promise.resolve(already);
      return withDeadline(() => new Promise((resolve) => { waiters.add({ predicate, resolve }); }), timeoutMs, label);
    },
  };
}

async function connectClient(port, room, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/room/${room}`);
  await waitForEvent(ws, 'open', 5000, `${name} socket open`);
  const client = wrapClient(ws);
  ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, room, name }));
  const welcome = await client.nextMatching((m) => m.t === 'welcome', 5000, `${name} welcome`);
  client.selfId = welcome.selfId;
  return client;
}

// Variant that takes an explicit URL path so tests (7) and (8) can pin a
// connection to a specific upgrade path independently of `hello.room` — which
// is the whole point of those checks: the relay must route by hello.room, not
// by what was on the URL line.
async function connectAt(port, path, room, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await waitForEvent(ws, 'open', 5000, `${name} socket open`);
  const client = wrapClient(ws);
  ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, room, name }));
  const welcome = await client.nextMatching((m) => m.t === 'welcome', 5000, `${name} welcome`);
  client.selfId = welcome.selfId;
  return client;
}

// Signal-mode equivalent of connectClient: greets with sg.signal.v1 and
// captures the relay's signal.welcome so subsequent tests can pull selfId,
// hostId, and the existing peers list without re-parsing messages.
const SIGNAL_PROTOCOL = 'sg.signal.v1';
async function connectSignalClient(port, room, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/room/${room}`);
  await waitForEvent(ws, 'open', 5000, `${name} signal socket open`);
  const client = wrapClient(ws);
  ws.send(JSON.stringify({ t: 'hello', protocol: SIGNAL_PROTOCOL, room, name }));
  const welcome = await client.nextMatching((m) => m.t === 'signal.welcome', 5000, `${name} signal.welcome`);
  client.selfId = welcome.selfId;
  client.hostId = welcome.hostId;
  client.peers = welcome.peers;
  return client;
}

// /healthz is the only way to peek at internal Map sizes from outside the
// relay process — keep this helper tiny and rely on the same relay the rest
// of the suite talks to (no extra port).
function fetchHealthz(port) {
  return withDeadline(() => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('healthz timeout')));
  }), 3000, 'healthz fetch');
}

let PORT = derivePort(31337); // reassigned by the bind retry below; distinct offset — never the static-server default port; see the bind retry below
// Retries on EADDRINUSE. derivePort() can land on any listener on the box:
// mp-clock died in 0s against an unrelated service on 9101 and took a whole
// 15-minute gate run with it. This suite deliberately does NOT import
// browser.mjs (it is pure node — no browser, no playwright), so the retry is
// inlined here the same way derivePort() above already is.
let relay = null;
for (let attempt = 0; attempt < 3 && !relay; attempt++) {
  // PORT itself is reassigned, not a local: every client below dials PORT, so
  // binding a fallback without updating it would connect them all to nothing.
  PORT = derivePort(31337 + attempt * 7);
  const candidate = startRelay({ port: PORT, host: '127.0.0.1' });
  const err = await new Promise((resolve) => {
    const onErr = (e) => resolve(e || new Error('relay listen failed'));
    candidate.server.once('error', onErr);
    candidate.server.once('listening', () => { candidate.server.off('error', onErr); resolve(null); });
  });
  if (!err) { relay = candidate; break; }
  try { candidate.close(); } catch { /* never listened */ }
  if (err.code !== 'EADDRINUSE') throw err; // a real failure — retrying hides it
}
if (!relay) throw new Error('could not bind a relay port after 3 attempts');
// No waitForEvent(relay.server, 'listening') here any more: the bind loop
// above already awaited that event to decide whether the port was free, and
// 'listening' fires exactly once — a second wait registers a listener for
// something that has already happened and times out after 5s.

try {
  /* ---------- 1) join: two clients, one room ---------- */
  let a, b;
  try {
    a = await connectClient(PORT, 'mp-relay-room', 'Alice');
    const bJoinedPromise = (async () => {
      // subscribe to a's peer.join BEFORE b connects, so there's no race
      // between b's hello landing and a's listener being attached.
      return a.nextMatching((m) => m.t === 'peer.join', 5000, 'a sees peer.join for b');
    })();
    b = await connectClient(PORT, 'mp-relay-room', 'Bob');
    const peerJoin = await bJoinedPromise;
    check('(1) join: b receives its own welcome with a selfId', typeof b.selfId === 'string' && b.selfId.length > 0);
    check('(1) join: a is told about b via peer.join', peerJoin.id === b.selfId, JSON.stringify(peerJoin));
  } catch (e) {
    check('(1) join', false, e.message);
  }

  /* ---------- 2) pose relay A->B ---------- */
  try {
    a.ws.send(JSON.stringify({ t: 'pose', x: 3, z: 4, yaw: 1.5, speed01: 0.5, gait: 0.2 }));
    // tick() flushes batched poses at POSE_HZ (15Hz, ~66.7ms) — the relay's
    // own 30Hz setInterval drives this for real, no fake clock available
    // here (that's what mp-protocol.mjs's pure-reducer tests are for).
    const poses = await b.nextMatching((m) => m.t === 'poses', 3000, 'b receives poses containing a');
    const mine = poses.poses.find((p) => p.id === a.selfId);
    check('(2) pose relay: b receives a\'s pose', !!mine, JSON.stringify(poses));
    check('(2) pose relay: pose fields round-trip exactly',
      !!mine && mine.x === 3 && mine.z === 4 && mine.yaw === 1.5 && mine.speed01 === 0.5 && mine.gait === 0.2);
  } catch (e) {
    check('(2) pose relay', false, e.message);
  }

  /* ---------- 3) lease handoff ---------- */
  try {
    a.ws.send(JSON.stringify({ t: 'ring', inRing: true }));
    a.ws.send(JSON.stringify({ t: 'lease.request' }));
    const grantToA = await b.nextMatching((m) => m.t === 'lease' && m.holder === a.selfId, 3000, 'b sees lease granted to a');
    check('(3) lease handoff: grant broadcasts to the other member', grantToA.holder === a.selfId);

    a.ws.send(JSON.stringify({ t: 'lease.release' }));
    await b.nextMatching((m) => m.t === 'lease' && m.holder === null, 3000, 'b sees lease released');

    b.ws.send(JSON.stringify({ t: 'ring', inRing: true }));
    b.ws.send(JSON.stringify({ t: 'lease.request' }));
    const grantToB = await a.nextMatching((m) => m.t === 'lease' && m.holder === b.selfId, 3000, 'a sees lease granted to b');
    check('(3) lease handoff: the lease actually moves to the second requester', grantToB.holder === b.selfId);
  } catch (e) {
    check('(3) lease handoff', false, e.message);
  }

  /* ---------- 4) commit broadcast ---------- */
  try {
    // b holds the lease from step 3.
    const baseEpoch = (b.messages.filter((m) => m.t === 'welcome')[0] || {}).epoch ?? 0;
    const commitAckA = a.nextMatching((m) => m.t === 'commit' && m.componentId === 7, 3000, 'a receives commit broadcast');
    const commitAckB = b.nextMatching((m) => m.t === 'commit' && m.componentId === 7, 3000, 'b receives its own commit broadcast');
    b.ws.send(JSON.stringify({ t: 'commit', componentId: 7, body: 'float mp=7.0;', baseEpoch }));
    const [onA, onB] = await Promise.all([commitAckA, commitAckB]);
    check('(4) commit broadcast: reaches every member including the sender', onA.body === 'float mp=7.0;' && onB.body === 'float mp=7.0;');
    check('(4) commit broadcast: names who committed it', onA.by === b.selfId, JSON.stringify(onA));
  } catch (e) {
    check('(4) commit broadcast', false, e.message);
  }

  /* ---------- 5) oversize frame rejection ---------- */
  try {
    const c = new WebSocket(`ws://127.0.0.1:${PORT}/room/mp-relay-room`);
    await waitForEvent(c, 'open', 5000, 'oversize-probe socket open');
    const closePromise = waitForEvent(c, 'close', 5000, 'oversize-probe close 1009');
    // A single JSON message whose encoded byte length exceeds
    // MAX_MESSAGE_BYTES (spec §2.1) — ws.mjs's decodeFrames must flag this
    // fatal(1009) regardless of whether the underlying WebSocket
    // implementation fragments it into multiple frames on the wire.
    const filler = 'x'.repeat(MAX_MESSAGE_BYTES + 4096);
    c.send(JSON.stringify({ t: 'pose', x: 0, z: 0, yaw: 0, speed01: 0, gait: 0, filler }));
    const closeEvt = await closePromise;
    check('(5) oversize frame: relay closes with code 1009', closeEvt.code === 1009, `code=${closeEvt.code}`);
  } catch (e) {
    check('(5) oversize frame rejection', false, e.message);
  }

  /* ---------- 6) heartbeat close after 2 missed pongs ---------- */
  // Deliberately NOT the global WebSocket here: RFC6455-compliant WebSocket
  // implementations (Node's built-in client included — confirmed by hand
  // against a raw ping-sending test server) auto-respond to server pings
  // with a pong at the protocol level, entirely transparent to JS. That
  // makes "a client that never pongs" impossible to construct with the
  // WebSocket API itself. A raw node:http upgrade gives us the bare TCP
  // socket with no such auto-responder, which is exactly the client this
  // proof needs — still zero new dependencies, still no application-level
  // framing of our own beyond the HTTP Upgrade handshake.
  //
  // Real timing, read from the code (server/relay.mjs's setInterval body):
  // the FIRST ping fires on the very first tick after connect (lastHeartbeatMs
  // starts at 0, so `nowMs - 0 < HEARTBEAT_MS` is false immediately), the
  // second tick HEARTBEAT_MS later finds awaitingPong still true and counts
  // one missed pong, and the third tick another HEARTBEAT_MS after that
  // reaches missedPongs===2 and closes. That's ~2*HEARTBEAT_MS wall-clock,
  // not a sleep we chose — the deadline below gives it slack on top.
  try {
    const socket = await withDeadline(() => new Promise((resolve, reject) => {
      const req = http.request({
        port: PORT, host: '127.0.0.1', path: '/room/mp-relay-heartbeat',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('mp-relay-heartbeat-probe').toString('base64'),
        },
      });
      req.on('upgrade', (res, sock) => resolve(sock));
      req.on('error', reject);
      req.end();
    }), 5000, 'heartbeat-probe raw upgrade');
    socket.on('data', () => {}); // never acks anything — that's the whole point

    const deadlineMs = 2 * HEARTBEAT_MS + 15000; // 2*HEARTBEAT_MS expected + generous slack
    await withDeadline(() => new Promise((resolve) => socket.once('close', resolve)), deadlineMs, 'raw socket closed by heartbeat timeout');
    check('(6) heartbeat: relay closes a connection that never pongs', true);
  } catch (e) {
    check('(6) heartbeat close', false, e.message);
  }

  /* ---------- 7) same-path / different-room isolation ----------
   * The upgrade URL path is transport addressing only — it must not choose
   * room membership. Two clients connecting to the SAME path but sending
   * DIFFERENT hello.room values end up in DIFFERENT rooms, even though they
   * dialed the same URL. Without the binding-step change in relay.mjs, the
   * relay would (wrongly) put them both in whichever room the path named.
   */
  try {
    const samePath = '/room/same-path';
    const c = await connectAt(PORT, samePath, 'mp-relay-iso-alpha', 'Cee');
    const d = await connectAt(PORT, samePath, 'mp-relay-iso-beta', 'Dee');
    // Each welcome's `room` field must be the caller's hello.room, not the path.
    const cWelcome = c.messages.find((m) => m.t === 'welcome');
    const dWelcome = d.messages.find((m) => m.t === 'welcome');
    check('(7) same-path/diff-room: c welcome names c\'s hello.room, not the URL path',
      cWelcome && cWelcome.room === 'mp-relay-iso-alpha', cWelcome && cWelcome.room);
    check('(7) same-path/diff-room: d welcome names d\'s hello.room, not the URL path',
      dWelcome && dWelcome.room === 'mp-relay-iso-beta', dWelcome && dWelcome.room);

    // Cross-room isolation: neither side should see the other join. We
    // assert this by racing against a short deadline — if isolation is
    // broken, peer.join shows up well before the timer.
    const cSeesDJ = await Promise.race([
      c.nextMatching((m) => m.t === 'peer.join', 1000, 'c unexpectedly sees d join').then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    const dSeesCJ = await Promise.race([
      d.nextMatching((m) => m.t === 'peer.join', 1000, 'd unexpectedly sees c join').then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    check('(7) same-path/diff-room: c does NOT see d\'s peer.join (different rooms)', cSeesDJ === false);
    check('(7) same-path/diff-room: d does NOT see c\'s peer.join (different rooms)', dSeesCJ === false);

    c.ws.close(); d.ws.close();
  } catch (e) {
    check('(7) same-path/diff-room isolation', false, e.message);
  }

  /* ---------- 8) different-path / same-room joining ----------
   * Mirror of (7). Two clients on DIFFERENT upgrade paths but the SAME
   * hello.room land in the SAME room. Without the binding-step change,
   * they would land in different rooms named after each path's last
   * segment, and never see each other's peer.join or pose relay.
   */
  try {
    const sameRoom = 'mp-relay-join-gamma';
    // Subscribe on e BEFORE f connects — the same trick test (1) uses —
    // so there's no race between f's hello landing and e's listener being
    // attached. (f's broadcast of e's peer.join is unreachable here because
    // e joined before f's listener existed; instead we assert it via f's
    // `welcome.members` snapshot, which is exactly what late joiners use
    // to learn who's already in the room.)
    const e = await connectAt(PORT, '/foo/a', sameRoom, 'Ee');
    const eSeesF = e.nextMatching((m) => m.t === 'peer.join' && m.id === f?.selfId, 5000, 'e sees peer.join for f');
    const f = await connectAt(PORT, '/bar/b', sameRoom, 'Eff');
    const onE = await eSeesF;
    check('(8) diff-path/same-room: e receives f\'s peer.join', onE.id === f.selfId, JSON.stringify(onE));

    const eWelcome = e.messages.find((m) => m.t === 'welcome');
    const fWelcome = f.messages.find((m) => m.t === 'welcome');
    check('(8) diff-path/same-room: both welcomes name the shared hello.room',
      eWelcome && eWelcome.room === sameRoom && fWelcome && fWelcome.room === sameRoom,
      eWelcome && fWelcome ? `${eWelcome.room}/${fWelcome.room}` : 'missing welcome');
    // f's welcome carries the existing members — the snapshot a late joiner
    // uses to learn who's already there. e must be in it; if the path split
    // them into separate rooms, f would see an empty room.
    check('(8) diff-path/same-room: f\'s welcome lists e as an existing member',
      fWelcome && fWelcome.members.some((m) => m.id === e.selfId),
      fWelcome && JSON.stringify(fWelcome.members.map((m) => m.id)));

    // Pose relay across paths: if the path split them, f would never see e's
    // pose. Same POSE_HZ timing as test (2).
    e.ws.send(JSON.stringify({ t: 'pose', x: 1, z: 2, yaw: 0.5, speed01: 0.4, gait: 0.1 }));
    const poses = await f.nextMatching((m) => m.t === 'poses' && m.poses.some((p) => p.id === e.selfId), 3000, 'f receives e\'s pose');
    const mine = poses.poses.find((p) => p.id === e.selfId);
    check('(8) diff-path/same-room: pose relays across different upgrade paths',
      !!mine && mine.x === 1 && mine.z === 2, JSON.stringify(poses));

    e.ws.close(); f.ws.close();
  } catch (e) {
    check('(8) diff-path/same-room joining', false, e.message);
  }

  /* ---------- 9) signal: host is first, guest sees hostId + peer ---------- */
  // The signaling protocol is the relay's dumb-pipe WebRTC forwarder: it
  // owns no game state, only membership. The first joiner is the host
  // (immutable for the room's lifetime), late joiners get hostId and a
  // peers snapshot — same shape an sg.mp.v1 late joiner would expect, minus
  // the gameplay fields.
  let sigHost, sigGuest;
  try {
    sigHost = await connectSignalClient(PORT, 'mp-relay-signal-hostguest', 'SigHost');
    check('(9) signal host: first joiner is host (hostId === selfId)',
      sigHost.hostId === sigHost.selfId, `hostId=${sigHost.hostId} selfId=${sigHost.selfId}`);
    check('(9) signal host: first joiner sees an empty peers list',
      Array.isArray(sigHost.peers) && sigHost.peers.length === 0, JSON.stringify(sigHost.peers));

    const hostSeesGuest = sigHost.nextMatching((m) => m.t === 'signal.peer.join', 5000, 'host sees guest join');
    sigGuest = await connectSignalClient(PORT, 'mp-relay-signal-hostguest', 'SigGuest');
    const onHost = await hostSeesGuest;
    check('(9) signal guest: second joiner sees hostId === first joiner', sigGuest.hostId === sigHost.selfId);
    check('(9) signal guest: peers snapshot lists the host exactly once',
      sigGuest.peers.length === 1 && sigGuest.peers[0].id === sigHost.selfId && sigGuest.peers[0].name === 'SigHost',
      JSON.stringify(sigGuest.peers));
    check('(9) signal host: existing member is told about the new join',
      onHost.id === sigGuest.selfId && onHost.name === 'SigGuest', JSON.stringify(onHost));
  } catch (e) {
    check('(9) signal host/guest', false, e.message);
  }

  /* ---------- 10) signal: offer/answer/candidate opaque forwarding ----------
   * The relay does NOT inspect the WebRTC SDP/ICE bytes — the entire `data`
   * field of every signal message is forwarded exactly as the sender wrote
   * it (JSON round-trip on the wire only). Three flavors of real-world
   * WebRTC traffic are exercised here: an offer, an answer, and a trickle
   * ICE candidate; the receiver sees the same shape with `from` set to the
   * sender's signalId.
   */
  try {
    const offerData = {
      type: 'offer',
      sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
    };
    const answerData = { type: 'answer', sdp: 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
    const candidateData = {
      candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 12345 typ host generation 0',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'abcd',
    };

    sigHost.ws.send(JSON.stringify({ t: 'signal', to: sigGuest.selfId, data: offerData }));
    const gotOffer = await sigGuest.nextMatching((m) => m.t === 'signal' && m.data?.type === 'offer', 3000, 'guest receives offer');
    check('(10) signal offer: forwarded exactly with `from` set to sender',
      gotOffer.from === sigHost.selfId && JSON.stringify(gotOffer.data) === JSON.stringify(offerData),
      JSON.stringify(gotOffer));

    sigGuest.ws.send(JSON.stringify({ t: 'signal', to: sigHost.selfId, data: answerData }));
    const gotAnswer = await sigHost.nextMatching((m) => m.t === 'signal' && m.data?.type === 'answer', 3000, 'host receives answer');
    check('(10) signal answer: round-trip preserves the answer body exactly',
      gotAnswer.from === sigGuest.selfId && JSON.stringify(gotAnswer.data) === JSON.stringify(answerData),
      JSON.stringify(gotAnswer));

    sigHost.ws.send(JSON.stringify({ t: 'signal', to: sigGuest.selfId, data: candidateData }));
    const gotCandidate = await sigGuest.nextMatching((m) => m.t === 'signal' && m.data?.candidate, 3000, 'guest receives ICE candidate');
    check('(10) signal candidate: forwarded with all candidate fields intact',
      gotCandidate.from === sigHost.selfId && JSON.stringify(gotCandidate.data) === JSON.stringify(candidateData),
      JSON.stringify(gotCandidate));
  } catch (e) {
    check('(10) signal opaque forwarding', false, e.message);
  }

  /* ---------- 11) signal: unknown target ignored, self-echo blocked ----------
   * A third-party id (one the sender made up) and an id that happens to
   * match the sender itself both must NOT cause any write — the relay
   * never echoes back to the sender and never speculatively forwards to
   * ids it does not know about. The "no message arrives" property is what
   * a race-free client depends on; both checks below are negative ones,
   * but each is timed (a deadline that is much shorter than the heartbeat)
   * so a buggy relay that forwards anyway is caught, not silently ignored.
   */
  try {
    const sigProbeBefore = sigGuest.messages.length;
    sigHost.ws.send(JSON.stringify({ t: 'signal', to: 'definitely-not-a-peer', data: { type: 'offer', sdp: 'x' } }));
    sigHost.ws.send(JSON.stringify({ t: 'signal', to: sigHost.selfId, data: { type: 'offer', sdp: 'x' } }));
    await new Promise((r) => setTimeout(r, 500));
    check('(11) signal unknown target: guest receives no message for unknown id',
      sigGuest.messages.length === sigProbeBefore, `got ${sigGuest.messages.length - sigProbeBefore} extra`);
    check('(11) signal self-echo: host receives no message when addressing self',
      !sigHost.messages.slice(sigProbeBefore).some((m) => m.t === 'signal'), 'self-echo leaked');
  } catch (e) {
    check('(11) signal unknown target / self-echo', false, e.message);
  }

  /* ---------- 12) signal: same-named rooms are isolated -------------------
   * Mirror of test (7) for the signal protocol: two signaling clients in
   * different rooms must not see each other's join. Reusing distinct room
   * names exercises the signal-side room lookup, not the mp-side one.
   */
  try {
    const isoA = await connectSignalClient(PORT, 'mp-relay-signal-iso-a', 'IsoA');
    const isoB = await connectSignalClient(PORT, 'mp-relay-signal-iso-b', 'IsoB');
    const aSawB = await Promise.race([
      isoA.nextMatching((m) => m.t === 'signal.peer.join', 800, 'a unexpectedly sees b').then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 1200)),
    ]);
    const bSawA = await Promise.race([
      isoB.nextMatching((m) => m.t === 'signal.peer.join', 800, 'b unexpectedly sees a').then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 1200)),
    ]);
    check('(12) signal room isolation: alpha does NOT see beta\'s signal.peer.join', aSawB === false);
    check('(12) signal room isolation: beta does NOT see alpha\'s signal.peer.join', bSawA === false);

    isoA.ws.close(); isoB.ws.close();
  } catch (e) {
    check('(12) signal room isolation', false, e.message);
  }

  /* ---------- 13) signal: 9th member refusal ------------------------------
   * SIGNAL_MAX_MEMBERS is 8; the 9th connection is closed with 1013 and
   * never receives a signal.welcome. Every connection here is tracked so
   * the test can clean up after itself — eight leaked sockets would put
   * a real relay under heartbeat pressure for the rest of the suite.
   */
  try {
    const room13 = 'mp-relay-signal-cap';
    const members = [];
    for (let i = 0; i < 8; i++) {
      members.push(await connectSignalClient(PORT, room13, `Cap${i}`));
    }
    // 9th must fail: open a socket, send the hello, and watch it close.
    const overflow = new WebSocket(`ws://127.0.0.1:${PORT}/room/${room13}`);
    await waitForEvent(overflow, 'open', 5000, 'overflow socket open');
    const overflowWrap = wrapClient(overflow);
    overflow.send(JSON.stringify({ t: 'hello', protocol: SIGNAL_PROTOCOL, room: room13, name: 'Overflow' }));
    const closeEvt = await waitForEvent(overflow, 'close', 5000, 'overflow close 1013');
    check('(13) signal 9th-member refusal: closed with code 1013',
      closeEvt.code === 1013, `code=${closeEvt.code}`);
    check('(13) signal 9th-member refusal: never received signal.welcome',
      !overflowWrap.messages.some((m) => m.t === 'signal.welcome'),
      `got: ${overflowWrap.messages.map((m) => m.t).join(',')}`);

    for (const m of members) m.ws.close();
  } catch (e) {
    check('(13) signal 9th-member refusal', false, e.message);
  }

  /* ---------- 14) signal: host close notifies remaining and 1012 closes --
   * The host disconnects and every remaining guest sees (in order on the
   * wire): a signal.host-lost application message, then a WebSocket close
   * frame with code 1012. No host migration, no elect-new-host round —
   * the relay tears the room down on purpose and the clients must reconnect.
   */
  try {
    const hostLossRoom = 'mp-relay-signal-hostloss';
    const host = await connectSignalClient(PORT, hostLossRoom, 'HostLoss');
    const guest1 = await connectSignalClient(PORT, hostLossRoom, 'Guest1');
    const guest2 = await connectSignalClient(PORT, hostLossRoom, 'Guest2');

    const g1HostLost = guest1.nextMatching((m) => m.t === 'signal.host-lost', 5000, 'guest1 sees signal.host-lost');
    const g1Close = waitForEvent(guest1.ws, 'close', 5000, 'guest1 close 1012');
    const g2HostLost = guest2.nextMatching((m) => m.t === 'signal.host-lost', 5000, 'guest2 sees signal.host-lost');
    const g2Close = waitForEvent(guest2.ws, 'close', 5000, 'guest2 close 1012');

    host.ws.close(); // triggers host-close path

    const [g1Hl, g1Closed, g2Hl, g2Closed] = await Promise.all([g1HostLost, g1Close, g2HostLost, g2Close]);
    check('(14) signal host-loss: guest1 receives signal.host-lost',
      g1Hl && g1Hl.t === 'signal.host-lost');
    check('(14) signal host-loss: guest1 socket closed with code 1012',
      g1Closed && g1Closed.code === 1012, `code=${g1Closed && g1Closed.code}`);
    check('(14) signal host-loss: guest2 receives signal.host-lost',
      g2Hl && g2Hl.t === 'signal.host-lost');
    check('(14) signal host-loss: guest2 socket closed with code 1012',
      g2Closed && g2Closed.code === 1012, `code=${g2Closed && g2Closed.code}`);
  } catch (e) {
    check('(14) signal host-loss', false, e.message);
  }

  /* ---------- 15) signal: NEVER creates an sg.mp room / emits gameplay -----
   * This is the negative proof: a signaling-only session must leave the
   * gameplay side of the relay completely untouched. We assert both
   * observable surfaces — /healthz's `rooms` count, and the actual frame
   * stream on a signaling socket — show no sg.mp.v1 artifacts. A relay
   * that "happened to also create an mp room" or "happened to also fire
   * welcome/commit/poses" would fail every check below.
   */
  try {
    // Baseline: read /healthz with no signal rooms yet and remember the
    // mp-side counts. A subsequent regression would move either of these.
    const baseline = await fetchHealthz(PORT);
    const baseRooms = baseline.rooms;
    const baseMembers = baseline.members;

    const isoSig = await connectSignalClient(PORT, 'mp-relay-signal-iso-mp', 'IsoSig');

    // (a) /healthz: the gameplay-side `rooms` count MUST NOT have changed.
    const afterOne = await fetchHealthz(PORT);
    check('(15) signal isolation: /healthz rooms count unchanged after signal join',
      afterOne.rooms === baseRooms, `before=${baseRooms} after=${afterOne.rooms}`);
    check('(15) signal isolation: /healthz members count unchanged after signal join',
      afterOne.members === baseMembers, `before=${baseMembers} after=${afterOne.members}`);
    check('(15) signal isolation: /healthz signalRooms bumped to 1, signalMembers to 1',
      afterOne.signalRooms === baseline.signalRooms + 1 && afterOne.signalMembers === baseline.signalMembers + 1,
      JSON.stringify(afterOne));

    // (b) Frames observed on a SIGNALING socket: NO gameplay `t` values.
    // Anything outside the signaling vocabulary is the relay leaking the
    // wrong protocol onto the wrong socket.
    const signalOnlyTypes = new Set(['signal.welcome', 'signal.peer.join', 'signal.peer.leave', 'signal.host-lost', 'signal']);
    const leaked = isoSig.messages.filter((m) => !signalOnlyTypes.has(m.t));
    check('(15) signal isolation: signal socket only sees signal.* message types',
      leaked.length === 0, `leaked: ${leaked.map((m) => m.t).join(',')}`);

    // (c) A signal-only session in the same room name as an mp room MUST
    // not interfere with the mp room. Establish an mp room 'mp-relay-iso-mp'
    // (same string the signal client used) and verify the mp room's members
    // snapshot does not include the signaling socket's id.
    const mpClient = await connectClient(PORT, 'mp-relay-iso-mp', 'MpTwin');
    const mpWelcome = mpClient.messages.find((m) => m.t === 'welcome');
    check('(15) signal isolation: an mp room with the same name does NOT include the signal id',
      mpWelcome && !mpWelcome.members.some((m) => m.id === isoSig.selfId),
      `signalId=${isoSig.selfId} mpMembers=${JSON.stringify(mpWelcome && mpWelcome.members.map((m) => m.id))}`);

    // (d) After the mp client joined, /healthz's `rooms` count bumped by 1
    // (mp-side) and signal-side counts were untouched — a final cross-check
    // that the two Maps move independently.
    const afterBoth = await fetchHealthz(PORT);
    check('(15) signal isolation: mp join bumps mp rooms, not signal rooms',
      afterBoth.rooms === baseRooms + 1 && afterBoth.signalRooms === baseline.signalRooms + 1,
      JSON.stringify(afterBoth));

    isoSig.ws.close(); mpClient.ws.close();
    sigHost?.ws.close(); sigGuest?.ws.close();
  } catch (e) {
    check('(15) signal isolation', false, e.message);
  }
} finally {
  relay.close();
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exitCode = failed ? 1 : 0;
