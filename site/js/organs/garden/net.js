// Shader Garden — organs/garden/net.js
// Multiplayer spec §8.1: the one frozen export, `connectRoom(opts)`. L5 codes
// against this factory's opts/return shape ONLY — never reaches past it
// into timesync.js or roster.js, never imports from site/js/runtime/.
// Implicit calls the spec's §2.3 message table leaves open: commit/reject
// carry no client-chosen request id (single FIFO on the next echo of our
// own id or reject), §7.4's "Start" uses `game.start`, `poses` batches
// carry the array under a `poses` key. Weekend P2P: p2p-socket.js dynamic-
// imported; selection ?relay=/?transport= > relay.json > localhost ws.

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
// §7.4 / Sculptor's Tag. Seeker-side prefilter (server also checks). Matches
// room-core.js TAG_DISTANCE; 500ms cooldown stops one dwell from spamming
// duplicates the reducer would happily count.
const TAG_DISTANCE = 0.9;
const TAG_COOLDOWN_MS = 500;

/** Pure: peer slot allocator (§4.1). Exported so join/leave/re-join stability
 *  is testable without a socket (mp-netclient.mjs). */

export function createSlotAllocator() {
  const free = [];
  for (let i = MAX_PEERS - 1; i >= 0; i--) free.push(i); // pop() yields lowest first
  return { slotOf: new Map(), free };
}

/** Assigns `id` a slot (idempotent). -1 if full (MAX_MEMBERS=8). */
export function allocateSlot(state, id) {
  if (state.slotOf.has(id)) return state.slotOf.get(id);
  if (state.free.length === 0) return -1;
  const slot = state.free.pop();
  state.slotOf.set(id, slot);
  return slot;
}

/** Frees `id`'s slot. Does not re-pack — would teleport an unrelated peer. */
export function freeSlot(state, id) {
  const slot = state.slotOf.get(id);
  if (slot === undefined) return;
  state.slotOf.delete(id);
  state.free.push(slot);
  state.free.sort((a, b) => b - a); // pop() = lowest free slot, stable order
}

/** Pure: relay + transport discovery (§2.5, Weekend P2P §1). Plain inputs
 *  (no `window`/`location`) so all cases are unit-testable. */

export async function resolveTransportConfig({ queryRelay, queryTransport, hostname, isHttps, fetchTransportJson }) {
  // Short-circuit: `?relay=` wins outright. Defer JSON fetch until needed —
  // a neverFetch probe must never be called. `?transport=` still runs here.
  if (queryRelay) {
    const transport = (queryTransport === 'p2p' || queryTransport === 'ws') ? queryTransport : 'ws';
    return { url: queryRelay, transport, iceServers: [], source: 'query' };
  }
  // Legacy-shape fetch: STRING URL, OBJECT, or null. Coerce before reading
  // — otherwise `json.url` is `undefined` on a string return and the
  // resolver falls through to localhost.
  const raw = await fetchTransportJson().catch(() => null);
  const jsonObj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const jsonStr = typeof raw === 'string' ? raw : null;
  const jsonUrl = jsonObj ? jsonObj.url : jsonStr;
  const jsonTransport = jsonObj ? jsonObj.transport : undefined;
  const iceServers = Array.isArray(jsonObj && jsonObj.iceServers) ? jsonObj.iceServers : [];
  let url = null;
  let source = 'no-config';
  if (jsonUrl) { url = jsonUrl; source = 'relay.json'; }
  else {
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
    // ws:// from https:// blocked silently; must never fire on https.
    if (isLocalHost && !isHttps) {
      url = `ws://${hostname}:${LOCAL_RELAY_PORT}`;
      source = 'localhost';
    }
  }
  // Transport selection. `?transport=` wins; otherwise JSON's `transport`
  // is authoritative except when URL came from query string.
  let transport = 'ws';
  if (queryTransport === 'p2p' || queryTransport === 'ws') {
    transport = queryTransport;
  } else if (source !== 'query' && (jsonTransport === 'p2p' || jsonTransport === 'ws')) {
    transport = jsonTransport;
  }
  return { url, transport, iceServers, source };
}

/** Correction 5: backward-compat alias. mp-netclient.mjs §2.5 calls
 *  `resolveRelayUrl` and asserts the legacy `{url, source}` shape.
 *  queryRelay precedence preserved (query > JSON > localhost).
 */
export async function resolveRelayUrl({ queryRelay, hostname, isHttps, fetchRelayJson }) {
  const res = await resolveTransportConfig({
    queryRelay,
    queryTransport: null,
    hostname,
    isHttps,
    fetchTransportJson: fetchRelayJson || (() => ({})),
  });
  // Project v2 source strings back: legacy must see 'no-relay' not 'no-config'.
  const source = res.source === 'no-config' ? 'no-relay' : res.source;
  return { url: res.url, source };
}

function fetchTransportJsonDefault() {
  // Best-effort-empty: a missing file resolves to "nothing configured".
  // Shape: {url?, transport?, iceServers[]?}; partial objects accepted.
  return fetch('assets/relay.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
}

export function connectRoom(opts) {
  const {
    room, relayUrl: relayUrlOverride, name,
    getPose, setPeerUniforms,
    onEdits, onCommit, onDraft, onLease, onRoster, onGame, onStatus,
    // Correction 8: optional `knownTunes: string[]`. setTune() and tune
    // messages refuse names outside; omitted = all fail-closed.
    knownTunes: knownTunesOpt,
    onTunes, onTune,
  } = opts;

  let socket = null;            // active socket (WebSocket or p2p-socket facade)
  let socketFacade = null;       // 'ws' | 'p2p' — what we currently hold in `socket`
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
  // Correction 8: known-tune set. Empty = not registered, fail-closed.
  const knownTunes = new Set(Array.isArray(knownTunesOpt) ? knownTunesOpt.filter((n) => typeof n === 'string') : []);
  // §7.4 / Sculptor's Tag: per-target cooldown keyed by targetId.
  const lastTagMs = new Map();

  const timeSync = createTimeSync({ send: (msg) => send(msg) });
  const roster = createRoster();

  // WebSocket.OPEN is 1; p2p-socket facade exports the same numeric.
  function isOpen(s) { return s && s.readyState === 1; }

  function send(msg) {
    if (isOpen(socket)) socket.send(JSON.stringify(msg));
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

  /** Rebuilds the 49+1 scalar bank from slots+peerState in one setUniforms()
   *  call. Runtime contract (§0.2) is scalar-only. */
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
      const poseChanged = !last || p.x !== last.x || p.z !== last.z || p.yaw !== last.yaw ||
        p.speed01 !== last.speed01 || p.gait !== last.gait;
      last = p;
      if (poseChanged) send({ t: 'pose', x: p.x, z: p.z, yaw: p.yaw, speed01: p.speed01, gait: p.gait });
      // §7.4 / Sculptor's Tag. Seeker (only seeker, per room-core.js) sends
      // `tag` within TAG_DISTANCE of any peer's last-known pose.
      if (lastGame.phase === 'seeking' && lastGame.seekerId === selfId && getPose) {
        const now = Date.now();
        // Correction 3: found-target skip — re-tagging a hider already in
        // `lastGame.found` risks the server treating it as a NEW tag.
        const found = Array.isArray(lastGame.found) ? lastGame.found : null;
        for (const [targetId, peer] of peerState) {
          if (targetId === selfId) continue;
          if (found && found.includes(targetId)) continue;
          const dx = p.x - peer.x;
          const dz = p.z - peer.z;
          if (Math.hypot(dx, dz) >= TAG_DISTANCE) continue;
          const last = lastTagMs.get(targetId) || 0;
          if (now - last < TAG_COOLDOWN_MS) continue;
          lastTagMs.set(targetId, now);
          send({ t: 'tag', targetId });
        }
      }
    }, POSE_INTERVAL_MS);
  }

  function stopPoseLoop() {
    if (poseTimer) { clearInterval(poseTimer); poseTimer = null; }
    lastTagMs.clear();
  }

  async function handleCommit(msg) {
    const applied = onCommit ? await onCommit({
      componentId: msg.componentId, body: msg.body, by: msg.by, epoch: msg.epoch,
    }) : true;
    if (applied) {
      epoch = msg.epoch;
    } else {
      // I4: world did not change — surface without faking epoch. §6.2:
      // a local compile failure means we're behind; resync via snapshot.request.
      send({ t: 'snapshot.request' });
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
        lastTagMs.clear();
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
        // §5.3 / Weekend P2P §2: tunes snapshot in welcome. Strict to known
        // names + finite numbers; NaN would zero the world, empty known
        // set = not registered, drop all (fail-closed).
        if (onTunes && msg.tunes && typeof msg.tunes === 'object') {
          const filtered = {};
          for (const [name, value] of Object.entries(msg.tunes)) {
            if (!knownTunes.has(name)) continue;
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            filtered[name] = value;
          }
          try { onTunes(filtered); } catch { /* caller decides */ }
        }
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
        // Hue and slot are identity, not presentation.
        const m = members.get(msg.id);
        if (m) { m.name = msg.name; refreshRoster(); }
        break;
      }
      case 'peer.leave': {
        members.delete(msg.id);
        freeSlot(slots, msg.id);
        peerState.delete(msg.id);
        lastTagMs.delete(msg.id);
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
        // Correction 4: stale_epoch-only resync. Other reasons (room-full,
        // malformed body) don't imply stale; sending snapshot.request on
        // every reject churns the host's reducer. Settle FIFO either way.
        if (msg.reason === 'stale_epoch') send({ t: 'snapshot.request' });
        if (pendingCommits.length) pendingCommits.shift()({ ok: false, reason: msg.reason });
        break;
      }
      case 'tune': {
        // §5 / Weekend P2P §2: holder delta. Late joiners catch up via the
        // welcome snapshot. Strict — known name + finite number; empty known
        // set = not registered, drop.
        if (onTune && msg && typeof msg.name === 'string' && Number.isFinite(msg.value)
            && knownTunes.has(msg.name)) {
          try { onTune({ name: msg.name, value: msg.value, by: msg.by }); } catch { /* */ }
        }
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

  async function resolveConfig() {
    if (relayUrlOverride) {
      // Bypasses query/JSON/localhost — must NOT touch `window` (undefined
      // in node unit harness). Tests/programmatic callers; always ws.
      return { url: relayUrlOverride, transport: 'ws', iceServers: [], source: 'override' };
    }
    const query = new URLSearchParams(window.location.search);
    const res = await resolveTransportConfig({
      queryRelay: query.get('relay'),
      queryTransport: query.get('transport'),
      hostname: window.location.hostname,
      isHttps: window.location.protocol === 'https:',
      fetchTransportJson: fetchTransportJsonDefault,
    });
    return res;
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
    const cfg = await resolveConfig();
    if (destroyed) return;
    if (!cfg.url) { onStatus && onStatus({ state: 'no-relay' }); return; }
    let next;
    try {
      if (cfg.transport === 'p2p') {
        // Dynamic import — keeps p2p bundle off ws-only/solo/test paths.
        const { createP2PSocket } = await import('../../multiplayer/p2p-socket.js');
        next = createP2PSocket({
          signalUrl: cfg.url,
          room, name,
          iceServers: cfg.iceServers || [],
          WebSocketImpl: window.WebSocket,
          RTCPeerConnectionImpl: window.RTCPeerConnection,
        });
      } else {
        next = new WebSocket(cfg.url);
      }
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;
    socketFacade = cfg.transport;
    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      // §5.3 / Weekend P2P: duplicate hello is reducer-idempotent.
      send({ t: 'hello', protocol: PROTOCOL, room, name });
    });
    socket.addEventListener('message', (ev) => handleMessage(ev.data));
    socket.addEventListener('close', (ev) => {
      socket = null;
      socketFacade = null;
      drainPendingCommits('disconnected');
      timeSync.stop();
      stopPoseLoop();
      // §6.1: host loss (1012) is fail-closed — re-dialling would land on
      // a different host's room and never reconcile. Surface, stop.
      const code = (ev && typeof ev.code === 'number') ? ev.code
        : (ev && ev.detail && typeof ev.detail.code === 'number') ? ev.detail.code : 1000;
      if (code === 1012) {
        if (!destroyed) {
          onStatus && onStatus({ state: 'closed', message: 'host lost', code });
        }
        return;
      }
      // A reconnect gets a fresh `welcome` with new epoch and edits; nothing
      // here tries to preserve members/peerState/slots across the gap.
      if (!destroyed) {
        onStatus && onStatus({ state: 'retrying' });
        scheduleReconnect();
      }
    });
    socket.addEventListener('error', () => {}); // 'close' always follows; nothing extra to do here
  }

  /** §3.2. Re-arm from onBuild() after every rebuild. */
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
      if (!isOpen(socket)) {
        resolve({ ok: false, reason: 'offline' });
        return;
      }
      pendingCommits.push(resolve);
      send({ t: 'commit', componentId, body, baseEpoch: epoch });
    });
  }

  /** §5 / Weekend P2P §2: dial a @tune slider. Only holder can move (server
   *  check in room-core.js); latest value wins. Correction 2: refuse when
   *  not current lease holder. Correction 8: refuse unknown names; fail
   *  closed. Strict — empty knownTunes means "not registered", drop. */
  function setTune(name, value) {
    if (lastLease.holder !== selfId) return;
    if (!knownTunes.has(name)) return;
    send({ t: 'tune', name, value });
  }

  /** Settle every queued commit resolver once with the failure shape, then
   *  drop the FIFO. Called on socket close and on destroy(). Reconnect
   *  gets a fresh `welcome`; resolvers from a prior connection would
   *  double-resolve otherwise. */
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
    if (socket) { try { socket.close(); } catch { /* already going away */ } socket = null; }
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
    setTune,
    tag: (targetId) => send({ t: 'tag', targetId }),
    startGame: () => send({ t: 'game.start' }),
    rename: (n) => send({ t: 'rename', name: n }),
    // §1 / Weekend P2P: visible transport indicator. 'p2p'/'ws' shows direct
    // to host (bound to host lifetime) vs through the relay.
    getTransport: () => socketFacade,
    destroy,
  };
}
