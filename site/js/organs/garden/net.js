// Shader Garden — organs/garden/net.js
// Multiplayer spec §8.1: the one frozen export, `connectRoom(opts)`. L5 codes
// against this factory's opts/return shape ONLY — never reaches past it
// into timesync.js or roster.js, never imports from site/js/runtime/.
// Implicit calls the spec's §2.3 message table leaves open: commit/reject
// carry no client-chosen request id (single FIFO on the next echo of our
// own id or reject), §7.4's "Start" uses `game.start`, `poses` batches
// carry the array under a `poses` key. Weekend P2P: p2p-socket.js dynamic-
// imported; selection ?relay=/?transport= > relay.json > localhost ws.
// SG-MM-ICE-VENDING (spec §2.7): thin plumbing — see ice-credentials.js
// for the validator + merge helpers imported by the p2p path below.

import { createTimeSync } from './timesync.js';
import { createRoster } from './roster.js';
import { fetchIceCredentials, mergeIceServers } from '../../multiplayer/ice-credentials.js';

const PROTOCOL = 'sg.mp.v1';
const RECONNECT_STEPS_MS = [1000, 2000, 4000, 8000];
const DRAFT_DEBOUNCE_MS = 150;
const POSE_HZ = 15;
const POSE_INTERVAL_MS = 1000 / POSE_HZ;
const RESYNC_EPS = 0.05; // §3.2 — the deadband IS the design, see armClock()
const MAX_PEERS = 7; // §4.1 — slots 0..6
const LOCAL_RELAY_PORT = 8787;
// §7.4 / Sculptor's Tag. Seeker-side prefilter; matches room-core.js
// TAG_DISTANCE. 500ms cooldown stops one dwell from spamming duplicates.
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

/** Pure: relay + transport discovery (§2.5, Weekend P2P §1). Plain inputs. */
export async function resolveTransportConfig({ queryRelay, queryTransport, hostname, isHttps, fetchTransportJson }) {
  // `?relay=` wins outright; defer JSON fetch. `?transport=` still runs here.
  if (queryRelay) {
    const transport = (queryTransport === 'p2p' || queryTransport === 'ws') ? queryTransport : 'ws';
    return { url: queryRelay, transport, iceServers: [], iceCredentialsUrl: null, source: 'query' };
  }
  // Legacy-shape fetch: STRING URL, OBJECT, or null.
  const raw = await fetchTransportJson().catch(() => null);
  const jsonObj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const jsonUrl = jsonObj ? jsonObj.url : (typeof raw === 'string' ? raw : null);
  const jsonTransport = jsonObj ? jsonObj.transport : undefined;
  const iceServers = Array.isArray(jsonObj && jsonObj.iceServers) ? jsonObj.iceServers : [];
  // SG-MM-ICE-VENDING (spec §2.7): malformed iceCredentialsUrl (wrong type
  // or empty) is a broken deploy — reject, never silently coerce to null.
  let iceCredentialsUrl = null;
  if (jsonObj && 'iceCredentialsUrl' in jsonObj) {
    const v = jsonObj.iceCredentialsUrl;
    if (typeof v !== 'string' || v.length === 0) throw new TypeError('resolveTransportConfig: iceCredentialsUrl must be a non-empty string; see spec §2.7.');
    iceCredentialsUrl = v;
  }
  let url = null;
  let source = 'no-config';
  if (jsonUrl) { url = jsonUrl; source = 'relay.json'; }
  else {
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
    // ws:// from https:// blocked silently; never fire on https.
    if (isLocalHost && !isHttps) {
      url = `ws://${hostname}:${LOCAL_RELAY_PORT}`;
      source = 'localhost';
    }
  }
  // Transport selection. `?transport=` wins; otherwise JSON's `transport`
  // is authoritative (except when URL came from query string).
  let transport = 'ws';
  if (queryTransport === 'p2p' || queryTransport === 'ws') {
    transport = queryTransport;
  } else if (source !== 'query' && (jsonTransport === 'p2p' || jsonTransport === 'ws')) {
    transport = jsonTransport;
  }
  return { url, transport, iceServers, iceCredentialsUrl, source };
}

/** Correction 5: backward-compat alias — mp-netclient.mjs §2.5 asserts the
 *  legacy `{url, source}` shape. queryRelay precedence preserved. */
export async function resolveRelayUrl({ queryRelay, hostname, isHttps, fetchRelayJson }) {
  const res = await resolveTransportConfig({
    queryRelay, queryTransport: null, hostname, isHttps,
    fetchTransportJson: fetchRelayJson || (() => ({})),
  });
  const source = res.source === 'no-config' ? 'no-relay' : res.source;
  return { url: res.url, source };
}

function fetchTransportJsonDefault() {
  // Best-effort-empty: a missing file resolves to "nothing configured".
  return fetch('assets/relay.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
}

export function connectRoom(opts) {
  const {
    room, relayUrl: relayUrlOverride, name,
    getPose, setPeerUniforms,
    onEdits, onCommit, onDraft, onLease, onRoster, onGame, onStatus,
    // Correction 8: `knownTunes: string[]` — strict name gate.
    knownTunes: knownTunesOpt,
    onTunes, onTune,
  } = opts;

  let socket = null;            // active socket (WebSocket or p2p-socket facade)
  let socketFacade = null;       // 'ws' | 'p2p'
  let destroyed = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let selfId = null;
  let epoch = 0;
  let inRing = false;
  let lastLease = { holder: null };
  let lastGame = { phase: 'lobby' };
  const members = new Map();
  const peerState = new Map();
  const draftTimers = new Map();
  const pendingCommits = []; // FIFO of resolve fns — see file header
  let slots = createSlotAllocator();
  let poseTimer = null;
  let clockRaf = null;
  // Correction 8: empty knownTunes = not registered, fail-closed.
  const knownTunes = new Set(Array.isArray(knownTunesOpt) ? knownTunesOpt.filter((n) => typeof n === 'string') : []);
  const lastTagMs = new Map();

  const timeSync = createTimeSync({ send: (msg) => send(msg) });
  const roster = createRoster();

  // WebSocket.OPEN is 1; p2p facade exports the same numeric.
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
    const ks = ['Act', 'X', 'Z', 'Yaw', 'Gait', 'Speed', 'Hue'];
    for (let i = 0; i < MAX_PEERS; i++) for (const k of ks) out[`uPeer${i}${k}`] = 0;
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
      // §7.4 / Sculptor's Tag: seeker sends `tag` within TAG_DISTANCE of any
      // peer's last-known pose. Correction 3: skip already-found targets.
      if (lastGame.phase === 'seeking' && lastGame.seekerId === selfId && getPose) {
        const now = Date.now();
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
      // I4/§6.2: local compile failure means we're behind; resync.
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
        // §5.3 / Weekend P2P §2: tunes snapshot. Strict — known name +
        // finite number; empty known set = not registered, drop all (fail-closed).
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
        // Correction 4: stale_epoch-only resync. Other reasons don't imply
        // stale; sending snapshot.request on every reject churns the reducer.
        if (msg.reason === 'stale_epoch') send({ t: 'snapshot.request' });
        if (pendingCommits.length) pendingCommits.shift()({ ok: false, reason: msg.reason });
        break;
      }
      case 'tune': {
        // §5 / Weekend P2P §2: holder delta. Strict known-name gate.
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
      // Developer override (tests/programmatic callers). No iceCredentialsUrl
      // — not a production vending path. Must NOT touch `window` here.
      return { url: relayUrlOverride, transport: 'ws', iceServers: [], iceCredentialsUrl: null, source: 'override' };
    }
    const query = new URLSearchParams(window.location.search);
    return resolveTransportConfig({
      queryRelay: query.get('relay'),
      queryTransport: query.get('transport'),
      hostname: window.location.hostname,
      isHttps: window.location.protocol === 'https:',
      fetchTransportJson: fetchTransportJsonDefault,
    });
  }

  function scheduleReconnect() {
    if (destroyed) return;
    const delay = RECONNECT_STEPS_MS[Math.min(reconnectAttempt, RECONNECT_STEPS_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  /** SG-MM-ICE-VENDING: vend + merge for the p2p path. */
  async function vendAndMergeIce(cfg) {
    const w = window;
    const fetchImpl = (w && w.fetch) ? w.fetch.bind(w)
      : (typeof globalThis.fetch === 'function') ? globalThis.fetch : null;
    if (!fetchImpl) return { ok: false, error: 'no-fetch' };
    const r = await fetchIceCredentials({ url: cfg.iceCredentialsUrl, fetchImpl,
      isHttps: w ? w.location.protocol === 'https:' : false,
      hostname: w ? w.location.hostname : '' });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, iceServers: mergeIceServers(cfg.iceServers, r.iceServers) };
  }

  async function connect() {
    if (destroyed) return;
    onStatus && onStatus({ state: reconnectAttempt === 0 ? 'connecting' : 'retrying' });
    let cfg;
    try { cfg = await resolveConfig(); }
    catch (e) {
      // Malformed iceCredentialsUrl (spec §2.7) — surface and back off.
      onStatus && onStatus({ state: 'retrying', message: 'ice-config:' + (e instanceof TypeError ? 'bad-type' : 'bad-config') });
      scheduleReconnect();
      return;
    }
    if (destroyed) return;
    if (!cfg.url) { onStatus && onStatus({ state: 'no-relay' }); return; }
    let next;
    try {
      if (cfg.transport === 'p2p') {
        let mergedIceServers = cfg.iceServers || [];
        if (cfg.iceCredentialsUrl) {
          const v = await vendAndMergeIce(cfg);
          if (!v.ok) {
            onStatus && onStatus({ state: 'retrying', message: `ice-vend:${v.error}` });
            scheduleReconnect();
            return;
          }
          mergedIceServers = v.iceServers;
        }
        const { createP2PSocket } = await import('../../multiplayer/p2p-socket.js');
        next = createP2PSocket({ signalUrl: cfg.url, room, name,
          iceServers: mergedIceServers,
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
        if (!destroyed) onStatus && onStatus({ state: 'closed', message: 'host lost', code });
        return;
      }
      // Fresh `welcome` on reconnect — no state carried across the gap.
      if (!destroyed) {
        onStatus && onStatus({ state: 'retrying' });
        scheduleReconnect();
      }
    });
    socket.addEventListener('error', () => {}); // 'close' always follows; nothing extra to do here
  }

  // §3.2. Re-arm from onBuild() after every rebuild.
  function armClock(runtime) {
    if (clockRaf != null) { cancelAnimationFrame(clockRaf); clockRaf = null; }
    const c = runtime && runtime.getClock ? runtime.getClock() : null;
    if (!c) return;
    const loop = () => {
      clockRaf = requestAnimationFrame(loop);
      const target = timeSync.sharedTime();
      if (target == null) return;
      if (Math.abs(c.time - target) > RESYNC_EPS) c.seek(target);
    };
    clockRaf = requestAnimationFrame(loop);
  }

  function setInRing(v) {
    const next = !!v;
    if (next === inRing) return;
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

  /** §5 / Weekend P2P §2: dial a @tune slider. Only holder; strict name +
   *  finite-number gate (Correction 8: empty knownTunes = not registered,
   *  drop). Server also enforces holder check (room-core.js). */
  function setTune(name, value) {
    if (lastLease.holder !== selfId) return;
    if (!knownTunes.has(name)) return;
    send({ t: 'tune', name, value });
  }

  /** Settle every queued commit resolver once with the failure shape, then
   *  drop the FIFO. Called on socket close and on destroy(); a fresh
   *  `welcome` after reconnect gets a new FIFO. */
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
    // §1: visible transport indicator.
    getTransport: () => socketFacade,
    destroy,
  };
}
