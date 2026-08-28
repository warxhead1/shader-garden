// site/js/multiplayer/p2p-socket.js
//
// Frozen browser WebRTC transport for sg.mp.v1 multiplayer. createP2PSocket()
// returns a WebSocket-LIKE object — same readyState values, same
// 'open'/'message'/'close' event surface, same `send(JSON string)` shape —
// so an upstream consumer can swap transports without rewriting its
// message/connection logic.
//
// Topology (frozen, see task brief):
//   - The FIRST signal member of a room is the immutable browser host.
//   - The host runs the pure sg.mp.v1 reducer (room-core.js). The host's
//     OWN actions loop through the reducer exactly once — there is no
//     second local code path that touches game state. reducer.members
//     includes the host as a regular member.
//   - Each guest opens ONE RTCPeerConnection to the host (star topology).
//     The host is the sole offerer and creates TWO data channels per guest:
//       "control" — reliable ordered. ALL sg.mp.v1 traffic except poses.
//       "pose"    — unreliable unordered (ordered:false, maxRetransmits:0).
//     The host routes per-message: msg.t === 'poses' goes over the pose
//     channel, every other type over control. Client pose (guest -> host)
//     and server poses (host -> guests) both ride the pose channel.
//
// Signaling wire (frozen):
//   outbound: { t:'hello', protocol:'sg.signal.v1', room, name }
//             { t:'signal',  to, data }                       (SDP/ICE)
//   inbound:  { t:'signal.welcome', selfId, hostId, peers }
//             { t:'signal.peer.join', id, name }
//             { t:'signal.peer.leave', id }
//             { t:'signal', from, data }
//             { t:'signal.host-lost' }                        -> close 1012
//
// Failure model: no migration, no reconnect. Host loss closes every guest
// fail-closed with WebSocket code 1012. Control is never silently dropped:
// a bounded queue carries until the channel opens, and overflow closes
// the data channel hard. Pose MAY be dropped under backpressure — that
// is the whole point of having a separate unreliable channel.
//
// All inputs are injectable so the test harness can swap a fake
// RTCPeerConnection and a fake signaling bus without touching this file.

import {
  createRoom, reduce, tick, removeMember,
  PROTOCOL as MP_PROTOCOL, POSE_HZ,
} from './room-core.js';

const SIGNAL_PROTOCOL = 'sg.signal.v1';
const CONTROL_LABEL = 'sg-mp-control-v1';
const POSE_LABEL = 'sg-mp-pose-v1';

// Pose backpressure: the pose channel is unreliable — when bufferedAmount
// on the SENDING side exceeds this, the next pose is dropped (the producer
// sees the loss as the channel catching up later). This is the explicit
// bound the brief calls out: pose drops under backpressure.
const POSE_BUFFERED_DROP_BYTES = 256 * 1024;
// Control backpressure: control is reliable — when buffered bytes exceed
// this on the sending side, we close the data channel hard rather than
// growing a queue nothing will ever drain in a starved peer. "Never
// silently drop control" means "fail closed with a status".
const CONTROL_BUFFERED_CLOSE_BYTES = 1 * 1024 * 1024;
const TICK_INTERVAL_MS = 1000 / POSE_HZ; // host-side reducer tick (spec §2.2)

// WebSocket readyStates — public surface mirrors WebSocket so a caller
// can substitute this transport without changes.
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

// --- WebRTC diagnostics (provider-neutral, non-secret) ---------------------
//
// A two-household rehearsal needs to answer four questions from a phone on
// the other end of a phone call: is the pair actually connected, did it go
// direct or through a relay, is it UDP or TCP, and are bytes moving. That is
// the ENTIRE budget of what getP2PDiagnostics() reports.
//
// Everything that could identify a household or hand someone else our TURN
// allocation is excluded BY CONSTRUCTION, not by redaction: we never read
// `address`/`ip`/`port`/`url`/`candidate`/`username`/`credential` out of the
// stats report at all, and the emitted object is assembled field-by-field
// from a fixed whitelist. There is no pass-through path, so a browser that
// adds a new (possibly identifying) stats member cannot leak it through here.
// Candidate TYPE ('host'/'srflx'/'prflx'/'relay') is the coarse fact an
// operator needs — it says "relayed" without saying "relayed via 203.0.113.7".
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const PROTOCOLS = new Set(['udp', 'tcp', 'tls', 'dtls', 'ssltcp']);

/** Whitelisted enum read: anything unexpected becomes null rather than
 *  being echoed back (an echo is how a novel identifying field would
 *  escape). */
function safeEnum(value, allowed) {
  return (typeof value === 'string' && allowed.has(value)) ? value : null;
}

function safeNumber(value) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}

/**
 * Resolve the in-use candidate pair from an RTCStatsReport, then reduce it
 * to non-secret scalars.
 *
 * Selection order (all three tiers are real: browsers disagree on which
 * members they populate, and `selected` is legacy-Firefox-only):
 *   1. transport.selectedCandidatePairId -> that exact pair (the spec path)
 *   2. a candidate-pair with selected === true, or nominated === true
 *      whose state is 'succeeded'
 *   3. any candidate-pair whose state is 'succeeded'
 * No succeeded pair means "not connected yet" — we report source 'none'
 * rather than inventing zeros, so a rehearsal can tell "0 bytes because
 * idle" apart from "0 bytes because there is no pair".
 *
 * @param {Map|Iterable} report  RTCStatsReport (or any Map-like of stats)
 * @returns {{
 *   source: 'transport'|'selected-flag'|'succeeded'|'none',
 *   localCandidateType: string|null, remoteCandidateType: string|null,
 *   protocol: string|null, relayProtocol: string|null,
 *   bytesSent: number|null, bytesReceived: number|null,
 *   currentRoundTripTime: number|null,
 * }}
 */
export function summarizeSelectedPair(report) {
  const empty = {
    source: 'none',
    localCandidateType: null, remoteCandidateType: null,
    protocol: null, relayProtocol: null,
    bytesSent: null, bytesReceived: null, currentRoundTripTime: null,
  };
  if (!report || typeof report.forEach !== 'function') return empty;

  const byId = new Map();
  const pairs = [];
  const transports = [];
  report.forEach((stat) => {
    if (!stat || typeof stat !== 'object') return;
    if (stat.id) byId.set(stat.id, stat);
    if (stat.type === 'candidate-pair') pairs.push(stat);
    else if (stat.type === 'transport') transports.push(stat);
  });

  let pair = null;
  let source = 'none';
  for (const t of transports) {
    if (t.selectedCandidatePairId && byId.has(t.selectedCandidatePairId)) {
      const cand = byId.get(t.selectedCandidatePairId);
      if (cand && cand.type === 'candidate-pair') { pair = cand; source = 'transport'; break; }
    }
  }
  if (!pair) {
    pair = pairs.find((p) => p.selected === true)
      || pairs.find((p) => p.nominated === true && p.state === 'succeeded')
      || null;
    if (pair) source = 'selected-flag';
  }
  if (!pair) {
    pair = pairs.find((p) => p.state === 'succeeded') || null;
    if (pair) source = 'succeeded';
  }
  if (!pair) return empty;

  // Local/remote candidate lookups read exactly ONE member each
  // (candidateType) plus the local candidate's transport protocols. We do
  // not touch address/port/url/relatedAddress at any point.
  const local = pair.localCandidateId ? byId.get(pair.localCandidateId) : null;
  const remote = pair.remoteCandidateId ? byId.get(pair.remoteCandidateId) : null;

  return {
    source,
    localCandidateType: safeEnum(local && local.candidateType, CANDIDATE_TYPES),
    remoteCandidateType: safeEnum(remote && remote.candidateType, CANDIDATE_TYPES),
    // Pair-level protocol is the authoritative one; fall back to the local
    // candidate's when a browser only populates it there.
    protocol: safeEnum(pair.protocol, PROTOCOLS) || safeEnum(local && local.protocol, PROTOCOLS),
    // relayProtocol is only meaningful for a relay candidate: it is the
    // hop between us and the TURN server (udp/tcp/tls). Not the TURN URL.
    relayProtocol: safeEnum(local && local.relayProtocol, PROTOCOLS),
    bytesSent: safeNumber(pair.bytesSent),
    bytesReceived: safeNumber(pair.bytesReceived),
    currentRoundTripTime: safeNumber(pair.currentRoundTripTime),
  };
}

/**
 * Per-peer diagnostics for ONE RTCPeerConnection. Exported so the rehearsal
 * tooling can reuse the exact same sanitizer the app ships rather than
 * re-deriving a second (drift-prone, possibly leakier) copy.
 *
 * Never throws: a peer whose getStats() rejects or is absent reports its
 * connection/ice states with null metrics. A rehearsal that loses one peer's
 * stats still gets the other peer's line.
 */
export async function summarizePeerConnection(peerId, pc) {
  const base = {
    id: typeof peerId === 'string' ? peerId : null,
    connectionState: (pc && typeof pc.connectionState === 'string') ? pc.connectionState : null,
    iceConnectionState: (pc && typeof pc.iceConnectionState === 'string') ? pc.iceConnectionState : null,
  };
  let pairInfo = summarizeSelectedPair(null);
  if (pc && typeof pc.getStats === 'function') {
    try {
      pairInfo = summarizeSelectedPair(await pc.getStats());
    } catch { /* stats unavailable — keep the null metrics */ }
  }
  // Assembled field-by-field from the whitelist. No spread of a stats
  // object anywhere in this return.
  return {
    id: base.id,
    connectionState: base.connectionState,
    iceConnectionState: base.iceConnectionState,
    selectedPairSource: pairInfo.source,
    localCandidateType: pairInfo.localCandidateType,
    remoteCandidateType: pairInfo.remoteCandidateType,
    protocol: pairInfo.protocol,
    relayProtocol: pairInfo.relayProtocol,
    bytesSent: pairInfo.bytesSent,
    bytesReceived: pairInfo.bytesReceived,
    currentRoundTripTime: pairInfo.currentRoundTripTime,
  };
}

/**
 * @param {{
 *   signalUrl: string,
 *   room: string,
 *   name: string,
 *   iceServers?: Array,
 *   WebSocketImpl: Function,           // required, injectable
 *   RTCPeerConnectionImpl: Function,   // required, injectable
 *   clock?: () => number,
 *   setTimeout?: (fn: Function, ms: number) => any,
 *   clearTimeout?: (id: any) => void,
 * }} opts
 * @returns {{
 *   CONNECTING: number, OPEN: number, CLOSING: number, CLOSED: number,
 *   readyState: number,
 *   addEventListener: (type: string, fn: Function) => void,
 *   removeEventListener: (type: string, fn: Function) => void,
 *   send: (data: string) => void,
 *   close: (code?: number, reason?: string) => void,
 *   getTransportInfo: () => object,
 *   getDiagnostics: () => Promise<Array<object>>,
 * }}
 */
export function createP2PSocket(opts) {
  const o = opts || {};
  const {
    signalUrl,
    room: roomId,
    name,
    iceServers = [],
    WebSocketImpl,
    RTCPeerConnectionImpl,
    clock,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  } = o;

  if (!signalUrl) throw new Error('createP2PSocket: signalUrl is required');
  if (!roomId) throw new Error('createP2PSocket: room is required');
  if (typeof name !== 'string') throw new Error('createP2PSocket: name is required');
  if (typeof WebSocketImpl !== 'function') throw new Error('createP2PSocket: WebSocketImpl is required');
  if (typeof RTCPeerConnectionImpl !== 'function') throw new Error('createP2PSocket: RTCPeerConnectionImpl is required');

  const _now = clock || (() => Date.now());
  const _setTimeout = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
  const _clearTimeout = clearTimeoutFn || ((id) => clearTimeout(id));

  // --- public state -------------------------------------------------------
  let readyState = CONNECTING;
  const listeners = new Map(); // type -> Set<fn>
  let closed = false;
  let lastCloseCode = 1000;
  let lastCloseReason = '';

  // --- internal state ------------------------------------------------------
  let signalSocket = null;
  let selfId = null;
  let hostId = null;
  let role = null; // 'host' | 'guest'
  let mpRoom = null; // host only — the reducer state
  /** peerId -> { id, pc, control, pose, helloReceived, bufferedControl,
   *              bufferedControlBytes, controlState, poseState } */
  const peers = new Map();
  const pendingRemoteCandidates = new Map(); // peerId -> [candidateData]
  let hostTickTimer = null;

  // --- event helpers ------------------------------------------------------

  function addEventListener(type, handler) {
    let set = listeners.get(type);
    if (!set) { set = new Set(); listeners.set(type, set); }
    set.add(handler);
  }

  function removeEventListener(type, handler) {
    const set = listeners.get(type);
    if (set) set.delete(handler);
  }

  function fire(type, ev) {
    const set = listeners.get(type);
    if (!set) return;
    // Snapshot so a handler that removes itself doesn't perturb iteration.
    for (const h of [...set]) {
      try { h(ev); } catch { /* swallow listener errors */ }
    }
  }

  // --- signal wire ---------------------------------------------------------

  function signalSend(msg) {
    if (signalSocket && signalSocket.readyState === OPEN) {
      try { signalSocket.send(JSON.stringify(msg)); } catch { /* socket gone */ }
    }
  }

  function handleSignalMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'signal.welcome': onWelcome(msg); break;
      case 'signal.peer.join': onPeerJoin(msg); break;
      case 'signal.peer.leave': onPeerLeave(msg); break;
      case 'signal': onSignal(msg); break;
      case 'signal.host-lost': onHostLost(); break;
      default: break;
    }
  }

  function onWelcome(msg) {
    selfId = msg.selfId;
    hostId = msg.hostId;
    const peersList = Array.isArray(msg.peers) ? msg.peers : [];
    role = (hostId === selfId) ? 'host' : 'guest';
    if (role === 'host') becomeHost(peersList);
    else becomeGuest(peersList);
  }

  function becomeHost(existingPeers) {
    mpRoom = createRoom(roomId, _now());
    // Register ourselves in the reducer so we have a memberId and a
    // welcome. The welcome loops back as the WebSocket-like's first
    // 'message' event.
    hostRunReducer(selfId, { t: 'hello', protocol: MP_PROTOCOL, room: roomId, name });
    // Fire 'open' AFTER the local loopback welcome so any 'message' handler
    // attached synchronously by the caller can already be in place when the
    // welcome fires (matches WebSocket semantics — open is deferred past the
    // constructor return).
    if (readyState === CONNECTING) setReadyState(OPEN);
    scheduleHostTick();
    // Anyone already in the room gets a connection initiated from our side;
    // we won't have seen their hello, but the wire contract has them send
    // theirs when their control channel opens, and the reducer's
    // duplicate-hello guard makes that idempotent. We register them via the
    // reducer when their hello arrives, NOT here.
    for (const peer of existingPeers) {
      if (peer && peer.id && peer.id !== selfId) hostInitiatePeer(peer.id);
    }
  }

  function becomeGuest(existingPeers) {
    // Guest stays CONNECTING until the control channel is open. The host
    // initiates the connection (we never call createOffer). existingPeers
    // is informational only — guests only ever talk to the host.
    void existingPeers;
  }

  function onPeerJoin(msg) {
    if (role === 'host') hostInitiatePeer(msg.id);
    // Guest: peer-join is informational — we don't open peer connections.
  }

  function onPeerLeave(msg) {
    // Tear down regardless of role. Host runs the reducer's removeMember
    // path so other guests learn about the leave via peer.leave broadcast.
    if (role === 'host') hostRemovePeer(msg.id, 'signal-peer-leave');
    else teardownPeerById(msg.id);
  }

  function onSignal(msg) {
    const fromId = msg.from;
    const data = msg.data;
    if (!fromId || !data || typeof data !== 'object') return;
    if (data.type === 'offer') {
      guestReceiveOffer(fromId, data);
    } else if (data.type === 'answer') {
      hostReceiveAnswer(fromId, data);
    } else if ('candidate' in data || data.candidate != null) {
      // ICE candidate — buffer until remote description is set. Tolerates
      // candidates arriving BEFORE the offer/answer has reached us: we
      // keep them keyed by peerId and flush when the peer entry exists
      // AND remote description is set. The brief calls this out
      // explicitly ("tolerate candidate before offer/answer").
      const buf = pendingRemoteCandidates.get(fromId) || [];
      buf.push(data);
      pendingRemoteCandidates.set(fromId, buf);
      tryFlushPendingCandidates(fromId);
    }
  }

  function onHostLost() {
    if (closed) return;
    closeSocket(1012, 'host lost');
  }

  function tryFlushPendingCandidates(peerId) {
    const peer = peers.get(peerId);
    if (!peer || !peer.pc || !peer.pc.remoteDescription) return;
    const buf = pendingRemoteCandidates.get(peerId);
    if (!buf || buf.length === 0) return;
    pendingRemoteCandidates.delete(peerId);
    for (const c of buf) {
      // Real RTCPeerConnection.addIceCandidate returns a Promise. A
      // try/catch around the call itself CANNOT catch a rejected
      // promise — that surfaces as an unhandled rejection and (in
      // browser hosts) an "Unhandled Promise Rejection" in the
      // console. Normalise to Promise.resolve(...).catch so the
      // rejection is owned.
      Promise.resolve(peer.pc.addIceCandidate(c)).catch(() => { /* swallow ICE error */ });
    }
  }

  // --- host: initiate a connection ---------------------------------------

  function hostInitiatePeer(peerId) {
    if (peers.has(peerId)) return;
    const peer = newPeerEntry(peerId);
    peers.set(peerId, peer);
    const pc = new RTCPeerConnectionImpl({ iceServers });
    peer.pc = pc;
    // Host creates the two data channels; the guest receives them via
    // ondatachannel after setRemoteDescription(offer).
    peer.control = pc.createDataChannel(CONTROL_LABEL, { ordered: true });
    peer.pose = pc.createDataChannel(POSE_LABEL, { ordered: false, maxRetransmits: 0 });
    wireHostPeerSide(peer);
    pc.createOffer().then((offer) => {
      return pc.setLocalDescription(offer).then(() => offer);
    }).then((offer) => {
      signalSend({ t: 'signal', to: peerId, data: { type: 'offer', sdp: offer && offer.sdp } });
    }).catch(() => { /* SDP failure: peer entry sits; will be cleaned up by connectionstatechange or peer.leave */ });
  }

  function newPeerEntry(id) {
    return {
      id,
      pc: null,
      control: null,
      pose: null,
      helloReceived: false,
      bufferedControl: [],
      bufferedControlBytes: 0,
      controlState: 'connecting',
      poseState: 'connecting',
    };
  }

  function wireHostPeerSide(peer) {
    const peerId = peer.id;
    const onControlOpen = () => {
      peer.controlState = 'open';
      flushBufferedControl(peer);
    };
    const onControlClose = () => {
      peer.controlState = 'closed';
      // Hard fail: if control closes, the peer is gone for game purposes.
      hostRemovePeer(peerId, 'control-close');
    };
    const onControlMsg = (ev) => onControlMessage(peerId, ev.data);
    peer.control.addEventListener('open', onControlOpen);
    peer.control.addEventListener('close', onControlClose);
    peer.control.addEventListener('message', onControlMsg);

    peer.pose.addEventListener('open', () => { peer.poseState = 'open'; });
    peer.pose.addEventListener('close', () => { peer.poseState = 'closed'; });
    peer.pose.addEventListener('message', (ev) => onPoseMessage(peerId, ev.data));

    peer.pc.addEventListener('icecandidate', (ev) => {
      if (ev && ev.candidate) {
        signalSend({
          t: 'signal', to: peerId,
          data: {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid,
            sdpMLineIndex: ev.candidate.sdpMLineIndex,
          },
        });
      }
    });
    peer.pc.addEventListener('connectionstatechange', () => {
      const s = peer.pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        hostRemovePeer(peerId, 'pc-' + s);
      }
    });
  }

  function flushBufferedControl(peer) {
    if (!peer.control || peer.control.readyState !== 'open') return;
    if (peer.bufferedControl.length === 0) return;
    const items = peer.bufferedControl;
    peer.bufferedControl = [];
    peer.bufferedControlBytes = 0;
    // The brief is explicit: "never silently drop control; bounded queue
    // or explicit close on overflow." A queued reliable send that lands
    // while the peer is failing to drain is the SAME failure mode as an
    // open-channel send whose bufferedAmount exceeds the bound — we have
    // to check the bound on every item and tear the peer down on the
    // first exceed, not after we have already shipped a bunch of
    // messages into a buffer the peer will never read. And a send that
    // throws (channel closed mid-call, internal state error) must also
    // tear down — not be swallowed as success.
    for (const it of items) {
      if (!peer.control || peer.control.readyState !== 'open') {
        hostRemovePeer(peer.id, 'control-closed-during-flush');
        return;
      }
      if (peer.control.bufferedAmount > CONTROL_BUFFERED_CLOSE_BYTES) {
        hostRemovePeer(peer.id, 'control-overflow-flush');
        return;
      }
      try {
        peer.control.send(JSON.stringify(it));
      } catch {
        hostRemovePeer(peer.id, 'control-send-throw-flush');
        return;
      }
    }
  }

  function hostRemovePeer(peerId, why) {
    const peer = peers.get(peerId);
    if (!peer) return;
    // Re-entrancy fence: teardownPeer closes the RTC and the data
    // channels, each of which fires 'close' synchronously in the fake
    // (and may fire synchronously in real implementations on a
    // same-tab close()). Our 'close' handlers call hostRemovePeer again
    // for the SAME peer. Without fencing, that re-entry runs another
    // removeMember (broadcasts peer.leave a second time) and another
    // teardown (idempotent in practice but wrong). Delete ownership
    // FIRST so the re-entry is an explicit no-op.
    if (peer._removing) return;
    peer._removing = true;
    peers.delete(peerId);
    pendingRemoteCandidates.delete(peerId);
    if (mpRoom && mpRoom.members.has(peerId)) {
      const { room, sends } = removeMember(mpRoom, peerId, _now());
      mpRoom = room;
      dispatch(sends, peerId);
    }
    teardownPeer(peer, /*close*/ true);
    void why;
  }

  function teardownPeerById(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    teardownPeer(peer, true);
    peers.delete(peerId);
    pendingRemoteCandidates.delete(peerId);
  }

  // --- guest: receive offer, build answer ---------------------------------

  function guestReceiveOffer(fromId, offerData) {
    if (role !== 'guest') return;
    if (fromId !== hostId) return; // we only accept offers from the host
    if (peers.has(fromId)) return; // already negotiating (idempotent)
    const peer = newPeerEntry(fromId);
    peers.set(fromId, peer);
    const pc = new RTCPeerConnectionImpl({ iceServers });
    peer.pc = pc;
    wireGuestPeerSide(peer);
    pc.setRemoteDescription({ type: 'offer', sdp: offerData.sdp }).then(() => {
      // Now that remote description is set, any candidates we buffered
      // earlier can be applied.
      tryFlushPendingCandidates(fromId);
      return pc.createAnswer();
    }).then((answer) => {
      return pc.setLocalDescription(answer).then(() => answer);
    }).then((answer) => {
      signalSend({ t: 'signal', to: fromId, data: { type: 'answer', sdp: answer && answer.sdp } });
    }).catch(() => { /* SDP failure; the peer will close via connectionstatechange */ });
  }

  function hostReceiveAnswer(fromId, answerData) {
    const peer = peers.get(fromId);
    if (!peer || !peer.pc) return;
    peer.pc.setRemoteDescription({ type: 'answer', sdp: answerData.sdp }).then(() => {
      tryFlushPendingCandidates(fromId);
    }).catch(() => { /* */ });
  }

  function wireGuestPeerSide(peer) {
    const peerId = peer.id;
    peer.pc.addEventListener('datachannel', (ev) => {
      const ch = ev.channel;
      if (!ch) return;
      if (ch.label === CONTROL_LABEL) {
        peer.control = ch;
        const onOpen = () => {
          peer.controlState = 'open';
          // 'open' for the guest fires AFTER control is open — the brief
          // calls this out explicitly. The very first message the guest
          // sends is its own hello, so the host can register the new
          // member via the reducer and start the welcome/commit/etc. flow.
          if (readyState === CONNECTING && !closed) {
            setReadyState(OPEN);
            try {
              peer.control.send(JSON.stringify({
                t: 'hello', protocol: MP_PROTOCOL, room: roomId, name,
              }));
            } catch { /* */ }
          }
        };
        const onClose = () => {
          peer.controlState = 'closed';
          if (!closed) closeSocket(1006, 'control-closed');
        };
        const onMsg = (ev) => onControlMessage(peerId, ev.data);
        ch.addEventListener('open', onOpen);
        ch.addEventListener('close', onClose);
        ch.addEventListener('message', onMsg);
      } else if (ch.label === POSE_LABEL) {
        peer.pose = ch;
        ch.addEventListener('open', () => { peer.poseState = 'open'; });
        ch.addEventListener('close', () => { peer.poseState = 'closed'; });
        ch.addEventListener('message', (ev) => onPoseMessage(peerId, ev.data));
      }
    });
    peer.pc.addEventListener('icecandidate', (ev) => {
      if (ev && ev.candidate) {
        signalSend({
          t: 'signal', to: peerId,
          data: {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid,
            sdpMLineIndex: ev.candidate.sdpMLineIndex,
          },
        });
      }
    });
    peer.pc.addEventListener('connectionstatechange', () => {
      const s = peer.pc.connectionState;
      if ((s === 'failed' || s === 'closed' || s === 'disconnected') && !closed) {
        closeSocket(1006, 'pc-' + s);
      }
    });
  }

  // --- control / pose message dispatch -------------------------------------

  function onControlMessage(peerId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (role === 'host') hostHandleControlMessage(peerId, msg);
    else fire('message', { data: JSON.stringify(msg) });
  }

  function onPoseMessage(peerId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (role === 'host') hostHandlePoseMessage(peerId, msg);
    else fire('message', { data: JSON.stringify(msg) });
  }

  function hostHandleControlMessage(peerId, msg) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.helloReceived = peer.helloReceived || (msg && msg.t === 'hello');
    hostRunReducer(peerId, msg);
  }

  function hostHandlePoseMessage(peerId, msg) {
    if (!msg || msg.t !== 'pose') return; // pose channel carries poses only
    const peer = peers.get(peerId);
    if (!peer) return;
    hostRunReducer(peerId, msg);
  }

  function hostRunReducer(fromId, msg) {
    if (!mpRoom) return null;
    const r = reduce(mpRoom, { from: fromId, msg, nowMs: _now() });
    mpRoom = r.room;
    dispatch(r.sends, fromId);
    if (r.close) {
      const target = r.close.to;
      if (target === selfId) {
        closeSocket(r.close.code, r.close.reason);
      } else {
        hostRemovePeer(target, 'reducer-close');
      }
    }
    return r;
  }

  // --- dispatch reducer sends ---------------------------------------------

  /**
   * For each reducer send, route by target:
   *   '*'             -> loopback to host AND sendToPeer for every peer.
   *   '*-except-from' -> loopback to host IF fromId !== selfId, AND
   *                      sendToPeer for every peer EXCEPT fromId.
   *   selfId          -> loopback to host (a 'message' event). The reducer
   *                      only emits this for welcome, and only the host's
   *                      selfId path can trigger it.
   *   <other peerId>  -> sendToPeer(peerId, msg). Routing by msg.t:
   *                      'poses' -> pose channel; everything else -> control.
   */
  function dispatch(sends, fromId) {
    if (!sends || sends.length === 0) return;
    for (const send of sends) {
      const target = send.to;
      if (target === '*') {
        fire('message', { data: JSON.stringify(send.msg) });
        for (const peerId of peers.keys()) sendToPeer(peerId, send.msg);
      } else if (target === '*-except-from') {
        // The reducer's from is the sender of the underlying message.
        // We must exclude that exact id, NOT selfId — a guest-driven
        // peer.join is broadcast to host + all OTHER guests, and only
        // the host's own local-loopback send excludes selfId.
        if (fromId !== selfId) {
          fire('message', { data: JSON.stringify(send.msg) });
        }
        for (const peerId of peers.keys()) {
          if (peerId !== fromId) sendToPeer(peerId, send.msg);
        }
      } else if (target === selfId) {
        fire('message', { data: JSON.stringify(send.msg) });
      } else {
        sendToPeer(target, send.msg);
      }
    }
  }

  function sendToPeer(peerId, msg) {
    const peer = peers.get(peerId);
    if (!peer) return;
    // Routing rule from the file header: server poses ride the pose
    // channel and may be dropped under backpressure; everything else
    // rides control and is buffered (never silently dropped) until the
    // channel opens.
    const usePose = (role === 'host' && msg && msg.t === 'poses');
    const channel = usePose ? peer.pose : peer.control;
    if (!channel || channel.readyState !== 'open') {
      if (usePose) return; // pose is not queued — drop if no channel
      peer.bufferedControl.push(msg);
      peer.bufferedControlBytes += JSON.stringify(msg).length;
      if (peer.bufferedControlBytes > CONTROL_BUFFERED_CLOSE_BYTES) {
        // Hard close on overflow — control MUST NOT silently drop, and a
        // peer that will never catch up is the only way this bound gets
        // hit (a slow browser, a malicious peer). Brief: "explicit close
        // on overflow". Cleanly tear down via the reducer's removeMember
        // path so the rest of the room learns about the eviction.
        hostRemovePeer(peerId, 'control-overflow');
      }
      return;
    }
    const payload = JSON.stringify(msg);
    // Backpressure check applies on EVERY send, not just the pre-open
    // queue. The brief is explicit: "never silently drop control;
    // bounded queue or explicit close on overflow" — a peer whose
    // channel is open but whose send buffer is past the bound is still
    // failing to keep up, and silently dropping the message would
    // look like success to the producer. Pose drops silently under
    // backpressure (that is its entire purpose); control fails closed.
    if (usePose) {
      if (channel.bufferedAmount > POSE_BUFFERED_DROP_BYTES) {
        // Pose dropped under backpressure — unreliable by design.
        return;
      }
    } else {
      if (channel.bufferedAmount > CONTROL_BUFFERED_CLOSE_BYTES) {
        hostRemovePeer(peerId, 'control-overflow');
        return;
      }
    }
    try {
      channel.send(payload);
    } catch {
      // send() threw — channel closed mid-call, internal state error,
      // or our fake RTC refuses the call. Brief: "never swallow as
      // success". Treat as failure: tear down via the reducer path so
      // the rest of the room learns, and the peer's side sees the
      // close.
      hostRemovePeer(peerId, 'control-send-throw');
    }
  }

  // --- host tick -----------------------------------------------------------

  function scheduleHostTick() {
    if (role !== 'host' || closed) return;
    hostTickTimer = _setTimeout(hostTick, TICK_INTERVAL_MS);
  }

  function hostTick() {
    if (role !== 'host' || !mpRoom || closed) return;
    const { room, sends } = tick(mpRoom, _now());
    mpRoom = room;
    dispatch(sends, selfId);
    scheduleHostTick();
  }

  // --- teardown ------------------------------------------------------------

  function teardownPeer(peer, doClose) {
    if (!peer) return;
    if (doClose) {
      try { peer.control && peer.control.close(); } catch { /* */ }
      try { peer.pose && peer.pose.close(); } catch { /* */ }
      try { peer.pc && peer.pc.close(); } catch { /* */ }
    }
  }

  // --- readyState transitions ----------------------------------------------

  function setReadyState(next) {
    if (readyState === next || closed) return;
    readyState = next;
    if (next === OPEN) {
      // Defer one microtask so consumers attaching 'open' synchronously
      // after createP2PSocket() still observe the event (WebSocket has the
      // same contract).
      Promise.resolve().then(() => { if (!closed) fire('open', {}); });
    }
  }

  function closeSocket(code, reason) {
    if (closed) return;
    closed = true;
    lastCloseCode = code == null ? 1000 : code;
    lastCloseReason = reason || '';
    if (readyState === CONNECTING || readyState === OPEN) readyState = CLOSING;
    if (hostTickTimer != null) { _clearTimeout(hostTickTimer); hostTickTimer = null; }
    for (const [, peer] of peers) teardownPeer(peer, true);
    peers.clear();
    pendingRemoteCandidates.clear();
    if (signalSocket) { try { signalSocket.close(); } catch { /* */ } signalSocket = null; }
    readyState = CLOSED;
    fire('close', { code: lastCloseCode, reason: lastCloseReason });
  }

  // --- public send ---------------------------------------------------------

  function send(data) {
    if (typeof data !== 'string') {
      throw new TypeError('send: data must be a JSON string');
    }
    if (closed) throw new Error('send: socket is closed');
    if (readyState !== OPEN) throw new Error('send: socket is not open');
    let msg;
    try { msg = JSON.parse(data); } catch {
      throw new Error('send: data is not valid JSON');
    }
    if (role === 'host') {
      // Host: every send goes through the local reducer. Local loopback
      // traverses the reducer exactly once — that is the entire point of
      // having the host run room-core.js (no parallel local code path).
      hostRunReducer(selfId, msg);
    } else {
      // Guest: route by type — pose on the pose channel (may be dropped
      // under backpressure), everything else on control.
      const peer = peers.get(hostId);
      if (!peer) throw new Error('send: no host peer connection');
      if (msg && msg.t === 'pose') {
        const ch = peer.pose;
        if (!ch || ch.readyState !== 'open') return; // pose is not queued
        if (typeof ch.bufferedAmount === 'number' && ch.bufferedAmount > POSE_BUFFERED_DROP_BYTES) {
          return; // pose dropped under backpressure
        }
        try { ch.send(data); } catch { /* */ }
      } else {
        const ch = peer.control;
        if (!ch || ch.readyState !== 'open') {
          throw new Error('send: control channel not open');
        }
        // Same control backpressure check as the host's sendToPeer.
        // Guest never silently drops a control message: either the
        // channel is below the bound and the send goes through, or it
        // is at/above the bound and we close the socket with an
        // explicit code so the host observes the close and runs
        // removeMember. Brief: "Enforce the bound on every open-
        // channel send and fail closed visibly, never swallow as
        // success".
        if (typeof ch.bufferedAmount === 'number' && ch.bufferedAmount > CONTROL_BUFFERED_CLOSE_BYTES) {
          closeSocket(1014, 'control-overflow');
          return;
        }
        try {
          ch.send(data);
        } catch {
          closeSocket(1014, 'control-send-throw');
        }
      }
    }
  }

  // --- public close --------------------------------------------------------

  function close(code, reason) {
    closeSocket(code == null ? 1000 : code, reason || '');
  }

  // --- diagnostics ---------------------------------------------------------

  function getTransportInfo() {
    return {
      role,
      selfId,
      hostId,
      signalingState: signalSocket ? signalSocket.readyState : null,
      peers: [...peers.values()].map((p) => ({
        id: p.id,
        pcState: p.pc ? p.pc.connectionState : null,
        iceState: p.pc && p.pc.iceConnectionState ? p.pc.iceConnectionState : null,
        controlState: p.controlState,
        poseState: p.poseState,
        bufferedControlBytes: p.bufferedControlBytes,
      })),
    };
  }

  /**
   * Read-only WebRTC diagnostics, one entry per live peer connection.
   * Provider-neutral (nothing here names a STUN/TURN vendor) and non-secret
   * by construction — see summarizeSelectedPair() above for the whitelist.
   *
   * Resolves [] when there are no peers (pre-negotiation, or after close).
   * Never rejects: a peer whose getStats() fails contributes an entry with
   * its states and null metrics.
   */
  function getDiagnostics() {
    const live = [...peers.values()].filter((p) => p && p.pc);
    if (live.length === 0) return Promise.resolve([]);
    return Promise.all(live.map((p) => summarizePeerConnection(p.id, p.pc)))
      .catch(() => []);
  }

  // --- open the signal socket ----------------------------------------------
  signalSocket = new WebSocketImpl(signalUrl);
  signalSocket.addEventListener('open', () => {
    signalSend({ t: 'hello', protocol: SIGNAL_PROTOCOL, room: roomId, name });
  });
  signalSocket.addEventListener('message', (ev) => handleSignalMessage(ev.data));
  signalSocket.addEventListener('close', () => {
    if (closed) return;
    // The signal server is the source of truth for "host lost": it sees
    // the host's TCP close and emits `signal.host-lost` to remaining
    // guests. But that path races the socket close here, so we mirror
    // the same fail-closed behavior locally for the host too — every
    // peer needs a peer.leave and every guest's socket closes with 1006.
    if (role === 'host') {
      for (const peerId of [...peers.keys()]) hostRemovePeer(peerId, 'signal-closed');
    }
    closeSocket(1006, 'signal-closed');
  });
  signalSocket.addEventListener('error', () => {
    fire('error', { message: 'signal error' });
  });

  // --- public surface ------------------------------------------------------

  return {
    CONNECTING, OPEN, CLOSING, CLOSED,
    get readyState() { return readyState; },
    addEventListener,
    removeEventListener,
    send,
    close,
    getTransportInfo,
    getDiagnostics,
  };
}