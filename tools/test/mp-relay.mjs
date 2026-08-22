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
} finally {
  relay.close();
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exitCode = failed ? 1 : 0;
