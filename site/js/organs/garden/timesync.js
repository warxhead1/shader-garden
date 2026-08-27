// Shader Garden — organs/garden/timesync.js
// Multiplayer spec §3.1/§3.2: NTP-style min-RTT offset estimation. Standalone
// so net.js's socket plumbing never has to be spun up to test the math
// (mp-netclient.mjs imports selectOffset() directly).
//
// Ring of the last OFFSET_RING samples; the estimate is the offset that
// belongs to the sample with the MINIMUM rtt, never the mean. Averaging drags
// the estimate toward whatever the single worst (most jittered) packet said
// — one bad Wi-Fi frame corrupts every future frame's iTime. Minimum-RTT
// selection assumes the best-observed round trip is the closest any sample
// got to the true one-way latency, and throws the rest away.

export const OFFSET_RING = 8;
// First 5 samples come in fast (2s) so a freshly joined client converges
// before anyone notices drift; after that, 15s is plenty — offset drifts on
// the order of clock skew (ppm), not seconds.
const FAST_PING_MS = 2000;
const FAST_PING_COUNT = 5;
const SLOW_PING_MS = 15000;

/** Pure: pick the offset of the min-rtt sample. `samples` is [{rtt, offset}].
 *  Null on an empty ring. Exported so it is testable without a ring, socket,
 *  or clock. */
export function selectOffset(samples) {
  if (!samples || samples.length === 0) return null;
  let best = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].rtt < best.rtt) best = samples[i];
  }
  return best.offset;
}

/** Pure: derive {rtt, offset} from a `time` reply and local send/receive
 *  clock readings, per §3.1's formulas exactly. Exported alongside
 *  selectOffset so the estimator is testable end-to-end: feed synthetic
 *  (clientSendMs, serverNowMs, nowMs) triples. */
export function sampleFromPong(clientSendMs, serverNowMs, nowMs) {
  const rtt = nowMs - clientSendMs;
  const offset = serverNowMs + rtt / 2 - nowMs;
  return { rtt, offset };
}

/** Stateful ring + ping scheduler. `send(msg)` is the caller's socket-send;
 *  `now()` defaults to Date.now and is overridable for tests. Owns nothing
 *  about the socket's lifecycle — net.js calls onPong() when a `time`
 *  message arrives and start()/stop() around the socket's open/close, so a
 *  reconnect gets a clean ping cadence instead of inheriting a stale timer
 *  pointed at a dead connection. */
export function createTimeSync({ send, now = () => Date.now() }) {
  const samples = [];
  let t0Ms = 0;
  let pingId = 0;
  let pingsSent = 0;
  let timer = null;
  const pending = new Map(); // id -> clientSendMs, so a late pong from a prior connection is ignored once cleared

  function scheduleNext() {
    const delay = pingsSent < FAST_PING_COUNT ? FAST_PING_MS : SLOW_PING_MS;
    timer = setTimeout(sendPing, delay);
  }

  function sendPing() {
    const id = String(pingId++);
    const clientSendMs = now();
    pending.set(id, clientSendMs);
    pingsSent++;
    send({ t: 'ping', id, clientSendMs });
    scheduleNext();
  }

  return {
    /** Set once, from `welcome.t0Ms` — the room's shared epoch origin. */
    setT0(ms) { t0Ms = ms; },

    /** Begin pinging. Call once per live connection. */
    start() {
      if (timer) return;
      sendPing();
    },

    /** Stop pinging and drop in-flight ping bookkeeping — call on disconnect
     *  so a pong that arrives after the socket is dead (or belongs to a
     *  since-superseded reconnect) can't corrupt the ring. */
    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending.clear();
    },

    /** Feed a `time{serverNowMs, echo:{id}}` reply in. Strangers, duplicates,
     *  malformed packets, and stale-from-a-prior-connection pings must all be
     *  ignored silently — a single bad reply (or a replayed one, or our own
     *  out-of-order send) must never throw or poison the ring. The stored
     *  clientSendMs in `pending` is the ONLY source of truth: echo.clientSendMs
     *  is wire noise we deliberately don't trust, because a malicious or
     *  replayed `time` could otherwise claim any send-time it wanted. */
    onPong(serverNowMs, echo) {
      if (!echo || typeof echo !== 'object') return;
      const id = echo.id;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      if (typeof serverNowMs !== 'number' || !Number.isFinite(serverNowMs)) return;
      const sent = pending.get(id);
      if (sent === undefined) return; // unknown / stale / duplicate — never trust echo.clientSendMs
      pending.delete(id);
      if (typeof sent !== 'number' || !Number.isFinite(sent)) return;
      const received = now();
      if (typeof received !== 'number' || !Number.isFinite(received)) return;
      const { rtt, offset } = sampleFromPong(sent, serverNowMs, received);
      if (!Number.isFinite(rtt) || rtt < 0) return;
      if (!Number.isFinite(offset)) return;
      samples.push({ rtt, offset });
      if (samples.length > OFFSET_RING) samples.shift();
    },

    /** Current offset estimate, or null before the first sample lands. */
    offset() { return selectOffset(samples); },

    /** §3.1: `(Date.now() + offset - t0Ms) / 1000`. Null until offset() is. */
    sharedTime() {
      const off = selectOffset(samples);
      if (off == null) return null;
      return (now() + off - t0Ms) / 1000;
    },
  };
}
