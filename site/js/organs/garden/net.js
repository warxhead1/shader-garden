// Shader Garden — organs/garden/net.js
// Multiplayer spec §8.1: the one frozen export, `connectRoom(opts)`. L5 codes
// against this factory's opts/return shape ONLY — it never reaches past it
// into timesync.js or roster.js, and this file never imports from
// site/js/runtime/ (armClock takes the runtime as a plain argument, so
// ownership of "what a runtime is" stays entirely on L4/L5's side of the
// boundary; this file calls only the five methods §3.2/§4 name).
//
// Two design calls the spec's message table (§2.3) leaves implicit:
//   - `commit`/`reject` carry no client-chosen request id. Only the lease
//     holder ever has a commit in flight (server-enforced), so a single
//     FIFO of pending resolvers is enough: settle the oldest on the next
//     `commit` echoing our own id, or the next `reject`. edit.js only calls
//     commit() once the previous one has settled, so two-in-flight never
//     happens on the wire.
//   - §7.4's lobby "Start" action has no §2.3 client->server entry.
//     `game.start` (no fields) is the obvious name; L1 server.mjs agrees.
// `poses` batches are assumed to carry the array under a `poses` key
// (`{t:'poses', poses:[...]}`), matching how every other multi-field type
// in §2.3 keys its payload by name rather than overloading `t`.

import { createTimeSync } from './timesync.js';
import { createRoster } from './roster.js';

const PROTOCOL = 'sg.mp.v1';
const RECONNECT_STEPS_MS = [1000, 2000, 4000, 8000];
const DRAFT_DEBOUNCE_MS = 150;
const POSE_HZ = 15;
const POSE_INTERVAL_MS = 1000 / POSE_HZ;
const RESYNC_EPS = 0.05; // §3.2 — the deadband IS the design, see armClock()
const MAX_PEERS = 7; // §4.1 — slots 0..6
const LOCAL_RELAY_PORT = 8787;

/** Pure: peer slot allocator (§4.1). Exported so join/leave/re-join stability
 *  is testable without a socket (mp-netclient.mjs). */

export function createSlotAllocator() {
  const free = [];
  for (let i = MAX_PEERS - 1; i >= 0; i--) free.push(i); // pop() yields lowest first
  return { slotOf: new Map(), free };
}

/** Assigns `id` a slot (idempotent — a second call returns its existing slot).
 *  -1 if the room is already full of slots (should not happen: MAX_MEMBERS=8
 *  on the relay side caps membership at MAX_PEERS+1). */
export function allocateSlot(state, id) {
  if (state.slotOf.has(id)) return state.slotOf.get(id);
  if (state.free.length === 0) return -1;
  const slot = state.free.pop();
  state.slotOf.set(id, slot);
  return slot;
}

/** Frees `id`'s slot back into the pool for a FUTURE member — deliberately
 *  does not touch any other member's assignment. Re-packing would teleport
 *  an unrelated peer's body into the departed member's old slot. */
export function freeSlot(state, id) {
  const slot = state.slotOf.get(id);
  if (slot === undefined) return;
  state.slotOf.delete(id);
  state.free.push(slot);
  state.free.sort((a, b) => b - a); // keep pop() = lowest free slot, stable order
}

/** Pure: relay discovery (§2.5). Plain string/bool inputs (no
 *  `window`/`location` reach) so all four cases are unit-testable. */

export async function resolveRelayUrl({ queryRelay, hostname, isHttps, fetchRelayJson }) {
  if (queryRelay) return { url: queryRelay, source: 'query' };
  const jsonUrl = await fetchRelayJson();
  if (jsonUrl) return { url: jsonUrl, source: 'relay.json' };
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
  // ws:// from an https:// page is blocked silently by the browser, so this
  // branch must never fire on https.
  if (isLocalHost && !isHttps) {
    return { url: `ws://${hostname}:${LOCAL_RELAY_PORT}`, source: 'localhost' };
  }
  return { url: null, source: 'no-relay' };
}

function fetchRelayJsonDefault() {
  // Best-effort-empty, exactly like registry.js's compositions loader: a
  // missing/unparseable file resolves to "nothing configured", not an error.
  return fetch('assets/relay.json')
    .then((r) => (r.ok ? r.json() : { url: null }))
    .then((j) => (j && j.url) || null)
    .catch(() => null);
}

export function connectRoom(opts) {
  const {
    room, relayUrl: relayUrlOverride, name,
    getPose, setPeerUniforms,
    onEdits, onCommit, onDraft, onLease, onRoster, onGame, onStatus,
  } = opts;

  let ws = null;
  let destroyed = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let selfId = null;
  let epoch = 0;
  let inRing = false;
  let lastLease = { holder: null };
  let lastGame = { phase: 'lobby' };
  const members = new Map(); // id -> {id, name, hue}
  const peerState = new Map(); // id -> {x, z, yaw, gait, speed01, hue}
  const draftTimers = new Map(); // componentId -> timer
  const pendingCommits = []; // FIFO of resolve fns — see file header
  let slots = createSlotAllocator();
  let poseTimer = null;
  let clockRaf = null;

  const timeSync = createTimeSync({ send: (msg) => send(msg) });
  const roster = createRoster();

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function nameFor(id) {
    const m = members.get(id);
    return m ? m.name : 'someone';
  }

  function withIsSelf(lease) {
    return { ...lease, isSelf: lease.holder === selfId };
  }

  function refreshRoster() {
    const list = Array.from(members.values());
    roster.update({ members: list, selfId, lease: lastLease, game: lastGame });
    onRoster && onRoster(list, selfId);
  }

  /** Rebuilds the full 49+1 scalar bank from slots+peerState and pushes it
   *  in one setUniforms() call — cheaper than diffing, and the runtime
   *  contract (§0.2) is scalar-only so there is no bulk-array path. */
  function pushPeerUniforms() {
    if (!setPeerUniforms) return;
    const out = {};
    for (let i = 0; i < MAX_PEERS; i++) {
      out[`uPeer${i}Act`] = 0;
      out[`uPeer${i}X`] = 0;
      out[`uPeer${i}Z`] = 0;
      out[`uPeer${i}Yaw`] = 0;
      out[`uPeer${i}Gait`] = 0;
      out[`uPeer${i}Speed`] = 0;
      out[`uPeer${i}Hue`] = 0;
    }
    let count = 0;
    for (const [id, slot] of slots.slotOf) {
      const p = peerState.get(id);
      if (!p) continue;
      out[`uPeer${slot}Act`] = 1;
      out[`uPeer${slot}X`] = p.x;
      out[`uPeer${slot}Z`] = p.z;
      out[`uPeer${slot}Yaw`] = p.yaw;
      out[`uPeer${slot}Gait`] = p.gait;
      out[`uPeer${slot}Speed`] = p.speed01;
      out[`uPeer${slot}Hue`] = p.hue;
      count++;
    }
    out.uPeerCount = count;
    setPeerUniforms(out);
  }

  function startPoseLoop() {
    if (poseTimer) return;
    let last = null;
    poseTimer = setInterval(() => {
      if (!getPose) return;
      const p = getPose();
      if (!p) return;
      if (last && p.x === last.x && p.z === last.z && p.yaw === last.yaw &&
          p.speed01 === last.speed01 && p.gait === last.gait) return;
      last = p;
      send({ t: 'pose', x: p.x, z: p.z, yaw: p.yaw, speed01: p.speed01, gait: p.gait });
    }, POSE_INTERVAL_MS);
  }

  function stopPoseLoop() {
    if (poseTimer) { clearInterval(poseTimer); poseTimer = null; }
  }

  async function handleCommit(msg) {
    const applied = onCommit ? await onCommit({
      componentId: msg.componentId, body: msg.body, by: msg.by, epoch: msg.epoch,
    }) : true;
    if (applied) {
      epoch = msg.epoch;
    } else {
      // I4: the world in front of THIS client did not change. onStatus is
      // how that gets surfaced without pretending the local epoch moved.
      onStatus && onStatus({
        state: 'live',
        message: `${nameFor(msg.by)}'s change didn't compile here — still showing the previous world`,
      });
    }
    if (msg.by === selfId && pendingCommits.length) {
      pendingCommits.shift()(applied ? { ok: true } : { ok: false, reason: 'local-compile-failed' });
    }
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case 'welcome': {
        selfId = msg.selfId;
        epoch = msg.epoch;
        timeSync.setT0(msg.t0Ms);
        members.clear();
        peerState.clear();
        slots = createSlotAllocator();
        for (const m of msg.members || []) {
          members.set(m.id, m);
          if (m.id === selfId) continue;
          allocateSlot(slots, m.id);
          peerState.set(m.id, { x: 0, z: 0, yaw: 0, gait: 0, speed01: 0, hue: m.hue });
        }
        pushPeerUniforms();
        onEdits && onEdits(new Map(Object.entries(msg.edits || {})));
        lastLease = msg.lease || { holder: null };
        onLease && onLease(withIsSelf(lastLease));
        lastGame = msg.game || { phase: 'lobby' };
        onGame && onGame(lastGame);
        refreshRoster();
        timeSync.start();
        startPoseLoop();
        onStatus && onStatus({ state: 'live' });
        break;
      }
      case 'peer.join': {
        members.set(msg.id, { id: msg.id, name: msg.name, hue: msg.hue });
        allocateSlot(slots, msg.id);
        peerState.set(msg.id, { x: 0, z: 0, yaw: 0, gait: 0, speed01: 0, hue: msg.hue });
        pushPeerUniforms();
        refreshRoster();
        break;
      }
      case 'peer.rename': {
        // Rename touches the roster only — hue and slot are identity, not
        // presentation, so the peer keeps its color and uniform slot.
        const m = members.get(msg.id);
        if (m) { m.name = msg.name; refreshRoster(); }
        break;
      }
      case 'peer.leave': {
        members.delete(msg.id);
        freeSlot(slots, msg.id);
        peerState.delete(msg.id);
        pushPeerUniforms();
        refreshRoster();
        break;
      }
      case 'poses': {
        for (const p of msg.poses || []) {
          const prev = peerState.get(p.id);
          peerState.set(p.id, {
            x: p.x, z: p.z, yaw: p.yaw, gait: p.gait, speed01: p.speed01,
            hue: prev ? prev.hue : (members.get(p.id) || {}).hue || 0,
          });
        }
        pushPeerUniforms();
        break;
      }
      case 'lease': {
        lastLease = {
          holder: msg.holder, holderName: msg.holderName,
          holderHue: msg.holderHue, expiresAt: msg.expiresAt,
        };
        onLease && onLease(withIsSelf(lastLease));
        refreshRoster();
        break;
      }
      case 'draft': {
        onDraft && onDraft({ from: msg.from, componentId: msg.componentId, body: msg.body });
        break;
      }
      case 'commit': {
        handleCommit(msg); // async; the socket handler itself stays sync
        break;
      }
      case 'reject': {
        if (pendingCommits.length) pendingCommits.shift()({ ok: false, reason: msg.reason });
        break;
      }
      case 'time': {
        timeSync.onPong(msg.serverNowMs, msg.echo);
        break;
      }
      case 'game': {
        lastGame = {
          phase: msg.phase, seekerId: msg.seekerId, endsAt: msg.endsAt,
          found: msg.found, scores: msg.scores,
        };
        onGame && onGame(lastGame);
        refreshRoster();
        break;
      }
      case 'error': {
        onStatus && onStatus({ state: 'live', message: msg.message || msg.code });
        break;
      }
      default:
        break;
    }
  }

  async function resolveUrl() {
    if (relayUrlOverride) return relayUrlOverride;
    const query = new URLSearchParams(window.location.search).get('relay');
    const res = await resolveRelayUrl({
      queryRelay: query,
      hostname: window.location.hostname,
      isHttps: window.location.protocol === 'https:',
      fetchRelayJson: fetchRelayJsonDefault,
    });
    return res.url;
  }

  function scheduleReconnect() {
    if (destroyed) return;
    const delay = RECONNECT_STEPS_MS[Math.min(reconnectAttempt, RECONNECT_STEPS_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  async function connect() {
    if (destroyed) return;
    onStatus && onStatus({ state: reconnectAttempt === 0 ? 'connecting' : 'retrying' });
    const url = await resolveUrl();
    if (destroyed) return;
    if (!url) { onStatus && onStatus({ state: 'no-relay' }); return; }
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      send({ t: 'hello', protocol: PROTOCOL, room, name });
    });
    socket.addEventListener('message', (ev) => handleMessage(ev.data));
    socket.addEventListener('close', () => {
      ws = null;
      drainPendingCommits('disconnected');
      timeSync.stop();
      stopPoseLoop();
      // A reconnect gets a fresh `welcome` with a new epoch and edits; nothing
      // here tries to preserve members/peerState/slots across the gap.
      if (!destroyed) {
        onStatus && onStatus({ state: 'retrying' });
        scheduleReconnect();
      }
    });
    socket.addEventListener('error', () => {}); // 'close' always follows; nothing extra to do here
  }

  /** §3.2. Re-arm from onBuild() after every rebuild — a fresh runtime's
   *  clock starts at 0 and has no idea a shared session exists. Cancels any
   *  previous loop first so a second rebuild doesn't stack rAF callbacks. */
  function armClock(runtime) {
    if (clockRaf != null) { cancelAnimationFrame(clockRaf); clockRaf = null; }
    const c = runtime && runtime.getClock ? runtime.getClock() : null;
    if (!c) return;
    const loop = () => {
      clockRaf = requestAnimationFrame(loop);
      const target = timeSync.sharedTime();
      if (target == null) return; // no time sample yet — nothing to seek toward
      if (Math.abs(c.time - target) > RESYNC_EPS) c.seek(target);
    };
    clockRaf = requestAnimationFrame(loop);
  }

  function setInRing(v) {
    const next = !!v;
    if (next === inRing) return; // send only on transitions, per §5.1
    inRing = next;
    send({ t: 'ring', inRing });
  }

  function sendDraft(componentId, body) {
    const existing = draftTimers.get(componentId);
    if (existing) clearTimeout(existing);
    draftTimers.set(componentId, setTimeout(() => {
      draftTimers.delete(componentId);
      send({ t: 'draft', componentId, body });
    }, DRAFT_DEBOUNCE_MS));
  }

  function commit(componentId, body) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, reason: 'offline' });
        return;
      }
      pendingCommits.push(resolve);
      send({ t: 'commit', componentId, body, baseEpoch: epoch });
    });
  }

  /** Settle every queued commit resolver EXACTLY once with the given failure
   *  shape, then drop the FIFO. Called on WebSocket close (so an in-flight
   *  commit never strands its caller) and on destroy() (tear-down symmetric
   *  with tear-down-by-disconnect). Reconnect gets a fresh `welcome` with a
   *  new epoch; resolvers from a prior connection that survived here would
   *  double-resolve or attribute a reply from the new connection to a request
   *  the caller already gave up on. Hence "settle once, then drop". */
  function drainPendingCommits(reason) {
    while (pendingCommits.length) {
      pendingCommits.shift()({ ok: false, reason });
    }
  }

  function destroy() {
    destroyed = true;
    drainPendingCommits('disconnected');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (clockRaf != null) { cancelAnimationFrame(clockRaf); clockRaf = null; }
    stopPoseLoop();
    timeSync.stop();
    for (const t of draftTimers.values()) clearTimeout(t);
    draftTimers.clear();
    roster.destroy();
    if (ws) { try { ws.close(); } catch { /* already going away */ } ws = null; }
  }

  connect();

  return {
    sharedTime: () => timeSync.sharedTime(),
    armClock,
    setInRing,
    requestLease: () => send({ t: 'lease.request' }),
    releaseLease: () => send({ t: 'lease.release' }),
    keepLease: () => send({ t: 'lease.keepalive' }),
    sendDraft,
    commit,
    tag: (targetId) => send({ t: 'tag', targetId }),
    startGame: () => send({ t: 'game.start' }),
    rename: (n) => send({ t: 'rename', name: n }),
    destroy,
  };
}
