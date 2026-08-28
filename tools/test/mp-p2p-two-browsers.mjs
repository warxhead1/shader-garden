// Shader Garden — mp-p2p-two-browsers.mjs
// Honest P2P transport acceptance: two real pages in one Chromium instance,
// both dialing the same room over ?transport=p2p&relay=ws://…, exercising
// the real WebSocket signaling + RTCPeerConnection + data-channel stack end
// to end. Every spy is installed at addInitScript time so it runs BEFORE any
// page code — wrapping WebSocket/RTCPeerConnection/RTCDataChannel.prototype
// at the first module evaluation lets the spy observe the production code's
// actual calls, not a partially-constructed surface seen by the time a
// late-arriving test hook could patch it.
//
// Acceptance (per the brief):
//   § transport:  both pages reach 'live' with a real RTCPeerConnection
//                 built with the ICE list from relay.json; signaling WS
//                 carries ONLY sg.signal.v1 frames (no sg.mp.v1 gameplay
//                 ever crosses the signaling hop)
//   § channels:   host creates sg-mp-control-v1 (reliable ordered, true)
//                 and sg-mp-pose-v1 (unordered, maxRetransmits=0); the
//                 guest RECEIVES them via the RTCPeerConnection
//                 `datachannel` event — no assertions on the guest's
//                 createDataChannel (guest does not create, it receives)
//   § over RTC:   peer/pose events arrive via data-channel send dispatch
//                 (proves the host reducer never proxies through signaling)
//   § ring+lease: real keyboard movement into the lectern ring drives the
//                 holder's `ring:true` over the wire; the holder's lease
//                 BUTTON click (the production authority flow) flips the
//                 OTHER page's lease line. Never injected ring/lease wires.
//   § tune:       holder inputs a real @tune slider; the OTHER page receives
//                 the `tune` message over the control data channel AND its
//                 runtime uniform bank updates to match
//   § host loss:  closing the host visibly fails the guest (status flips
//                 to `retrying`) AND emits `signal.host-lost` on the
//                 guest's signaling WS log
//
// Both pages run in one Chromium (same browser, different pages) — much
// cheaper than two browsers, and the two RTCPeerConnections genuinely
// complete ICE to each other over loopback candidates (chromium permits
// two same-host RTCPeerConnections to negotiate through loopback without
// external STUN).
//
// Usage: node tools/test/mp-p2p-two-browsers.mjs   (npm ci in tools/test)

import { launch, serveSite, sleep, scaled, gotoSafe, awaitGardenCanvas, startRelayOnFreePort } from './browser.mjs';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

const { relay, port: RELAY_PORT } = await startRelayOnFreePort({ offset: 640 });
const { server, base: BASE } = await serveSite();
const browser = await launch();

const ROOM = 'p2p-two-browsers-test';
// transport=p2p is explicit; relay=ws://... targets the in-process signal
// hub on the ws side (relay.mjs multiplexes sg.signal.v1 over the same
// upgrade). The room name rides in the hello payload (p2p-socket.js never
// appends it to the URL path).
const relayUrlFor = (room) => `ws://127.0.0.1:${RELAY_PORT}/${room}`;
const roomUrl = (room) => `${BASE}/index.html?relay=${encodeURIComponent(relayUrlFor(room))}&transport=p2p#/garden/${room}`;

// Same launch order as mp-dual-workspace.mjs: A first so A becomes the
// room's host (p2p-socket.js's "first signal member is the immutable host"
// rule). B joining AFTER lets us assert B's view of A as the host.
async function freshPage(errors) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('sg.garden.quality', 'low'); } catch { /* storage blocked */ }
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !(m.location().url || '').includes('cm-editor.bundle.js')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return page;
}

/* ---------- init-time transport spy ----------
 *
 * Installed via addInitScript so it runs before any page module evaluates.
 * Wrapping AT THE PROTOTYPE level matters: any per-instance wrapper risks
 * missing a `new WebSocket(...)` call that happens after the test hooked
 * the earlier one, and p2p-socket.js constructs its socket exactly once
 * per peer — instrumenting the prototype catches it deterministically.
 *
 * `onDataChannel` recording relies on the page having assigned a handler at
 * SOME point (either via .ondatachannel or addEventListener('datachannel')).
 * p2p-socket.js uses addEventListener for both signaling-state and data
 * events, so the spy also wraps `pc.addEventListener('datachannel', …)` and
 * captures every channel the peer side hands this side — guest side will
 * see 'peer-received' entries, host side stays empty for that path. We
 * intentionally do NOT record the guest's createDataChannel calls (guest
 * never makes them); that's a host-only check (see §channels below).
 */
async function armTransportSpy(page, label) {
  await page.addInitScript(({ label }) => {
    const w = window;
    w.__p2p = {
      label,
      // signalling WS
      wsSockets: [],
      wsSent: [],
      wsReceived: [],
      // RTCPeerConnection
      rtcSeen: false,
      pcs: [],
      iceServersUsed: [],
      // Data channels
      dataChannelsCreated: [],   // host: pc.createDataChannel(label, opts)
      dataChannelsReceived: [],  // either side: pc.onDataChannel / addEventListener('datachannel', …)
      // Data channel MESSAGE traffic, by label
      dcSent: [],        // out: every channel.send() payload with a 't'
      dcReceivedFrames: [], // in: every dispatched 'message' event with a 't'
    };
    const s = w.__p2p;
    w.__p2pPCs = [];

    // --- WebSocket spy: capture every URL + every JSON frame both ways.
    const OrigWS = w.WebSocket;
    function WSSpy(url, protocols) {
      const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      s.wsSockets.push(url);
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && typeof msg === 'object') s.wsReceived.push(msg);
        } catch { /* ignore non-JSON frames */ }
      });
      const origSend = ws.send.bind(ws);
      ws.send = (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg && typeof msg === 'object') s.wsSent.push(msg);
        } catch { /* ignore */ }
        return origSend(data);
      };
      return ws;
    }
    Object.defineProperty(WSSpy, 'name', { value: 'WebSocket' });
    Object.assign(WSSpy, {
      CONNECTING: OrigWS.CONNECTING, OPEN: OrigWS.OPEN,
      CLOSING: OrigWS.CLOSING, CLOSED: OrigWS.CLOSED,
    });
    WSSpy.prototype = OrigWS.prototype;
    w.WebSocket = WSSpy;

    // --- RTCPeerConnection spy: catch construction + createDataChannel +
    // inbound `datachannel` events (guest side).
    if (typeof w.RTCPeerConnection !== 'function') {
      s.rtcMissing = true;
      return;
    }
    const OrigPC = w.RTCPeerConnection;
    function PCSpy(cfg) {
      s.rtcSeen = true;
      const pc = new OrigPC(cfg);
      // Keep the LIVE instances (not serializable, so they live outside the
      // `__p2p` buffer readSpy() clones) so the diagnostics assertions can
      // call the production sanitizer against the real getStats() report of
      // the exact peer connections the page is using.
      w.__p2pPCs.push(pc);
      const iceServers = (cfg && Array.isArray(cfg.iceServers)) ? cfg.iceServers : [];
      s.pcs.push({ iceServers: JSON.parse(JSON.stringify(iceServers)) });
      s.iceServersUsed.push(JSON.parse(JSON.stringify(iceServers)));
      // createDataChannel: this is the only point p2p-socket.js reveals its
      // channel labels + ordered/maxRetransmits options. The HOST calls
      // it once per peer (control + pose); the guest does NOT call it at
      // all — it waits for `ondatachannel`.
      const origCreate = pc.createDataChannel.bind(pc);
      pc.createDataChannel = (label, opts) => {
        const ch = origCreate(label, opts);
        s.dataChannelsCreated.push({
          label,
          ordered: !!(opts && opts.ordered),
          maxRetransmits: opts && typeof opts.maxRetransmits === 'number' ? opts.maxRetransmits : null,
          protocol: (opts && opts.protocol) || '',
        });
        wrapChannel(ch); // host-created: spy send + dispatchEvent on THIS instance
        return ch;
      };
      // Track channels the OTHER side hands us (guest-side path). Wrap
      // addEventListener so any 'datachannel' listener registration is
      // captured, then we look at the channel's label after it lands.
      const origAddEL = pc.addEventListener.bind(pc);
      pc.addEventListener = (ev, h) => {
        if (ev === 'datachannel') {
          const wrapped = (event) => {
            const ch = event && event.channel;
            if (ch) {
              s.dataChannelsReceived.push({ label: ch.label, peer: 'guest-received' });
              wrapChannel(ch); // guest-received: same per-instance wrap
            }
            return h(event);
          };
          return origAddEL('datachannel', wrapped);
        }
        return origAddEL(ev, h);
      };
      return pc;
    }
    Object.defineProperty(PCSpy, 'name', { value: 'RTCPeerConnection' });
    PCSpy.prototype = OrigPC.prototype;
    w.RTCPeerConnection = PCSpy;

    // --- RTCDataChannel spy: per-INSTANCE wrapping, NOT prototype.
    // Patching RTCDataChannel.prototype is unreliable here:
    //   1) `window.RTCDataChannel` is the Chromium-internal class (often
    //      exposed under `window.webkitRTCDataChannel` in older builds),
    //      and a name-less global lookup can `undefined` under shims
    //      layered on top of chromium (p2p-socket.js's tests would have
    //      masked this; the production page does not).
    //   2) Even when the global resolves, the prototype's `send` /
    //      `dispatchEvent` are pulled from one EventTarget superclass and
    //      don't necessarily map 1:1 onto what an actual data channel
    //      uses.
    // The robust path is to WRAP EACH CHANNEL INSTANCE the moment we
    // see it: bind a send/receive pair right then. We hook two arrival
    // points so neither host-created nor guest-received channels slip
    // through:
    //   - on pc.createDataChannel(label, opts): wrap the return value
    //   - on the `datachannel` event of any PC: wrap event.channel
    // Wrapping on the channel (not its prototype) means the spy
    // captures THE channels the production code holds, with their real
    // `label`, regardless of class hierarchy.
    function wrapChannel(ch) {
      if (!ch || ch.__sgSpyWrapped) return;
      ch.__sgSpyWrapped = true;
      const origSend = ch.send.bind(ch);
      ch.send = function (data) {
        try {
          const text = typeof data === 'string' ? data : null;
          if (text) {
            const m = JSON.parse(text);
            if (m && typeof m.t === 'string') s.dcSent.push({ label: ch.label, t: m.t, frame: m });
          }
        } catch { /* binary / non-JSON */ }
        return origSend(data);
      };
      // Wrap addEventListener too: production code (p2p-socket.js) registers
      // its message handler via `dc.addEventListener('message', …)`, NOT via
      // the `onmessage` property setter. Native browser message events fire
      // through the channel's own EventTarget — they don't pass through the
      // captured `dispatchEvent` only on devicetools / polyfill installs.
      // Wrapping the per-instance addEventListener captures the channel's
      // REAL receiving path: every future message listener sees its own
      // data after the spy records it. onmessage (property form) is also
      // supported by wrapping the property setter.
      const origAddEL = ch.addEventListener.bind(ch);
      ch.addEventListener = function (ev, h) {
        if (ev === 'message') {
          const wrapped = (e) => {
            try {
              const data = typeof e.data === 'string' ? e.data : null;
              if (data) {
                const m = JSON.parse(data);
                if (m && typeof m.t === 'string') s.dcReceivedFrames.push({ label: ch.label, t: m.t, frame: m });
              }
            } catch { /* ignore */ }
            return h(e);
          };
          return origAddEL('message', wrapped);
        }
        return origAddEL(ev, h);
      };
      // onmessage property path (older p2p-socket paths / a future caller).
      const omDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ch), 'onmessage');
      if (omDesc && omDesc.set) {
        Object.defineProperty(ch, 'onmessage', {
          configurable: true,
          get: omDesc.get,
          set(handler) {
            const wrapped = (e) => {
              try {
                const data = typeof e.data === 'string' ? e.data : null;
                if (data) {
                  const m = JSON.parse(data);
                  if (m && typeof m.t === 'string') s.dcReceivedFrames.push({ label: ch.label, t: m.t, frame: m });
                }
              } catch { /* */ }
              return typeof handler === 'function' ? handler(e) : undefined;
            };
            return omDesc.set.call(ch, wrapped);
          },
        });
      }
    }
  }, { label });
}

// Read the spy buffer back from a page in one call.
async function readSpy(page) {
  return page.evaluate(() => {
    const s = window.__p2p;
    if (!s) return null;
    return {
      label: s.label,
      rtcSeen: !!s.rtcSeen,
      rtcMissing: !!s.rtcMissing,
      wsSockets: s.wsSockets.slice(),
      wsSent: s.wsSent.slice(),
      wsReceived: s.wsReceived.slice(),
      pcs: s.pcs.slice(),
      iceServersUsed: s.iceServersUsed.slice(),
      dataChannelsCreated: s.dataChannelsCreated.slice(),
      dataChannelsReceived: s.dataChannelsReceived.slice(),
      dcSent: s.dcSent.slice(),
      dcReceivedFrames: s.dcReceivedFrames.slice(),
    };
  });
}

/* ---------- diagnostics reader ----------
 *
 * Calls the PRODUCTION sanitizer (p2p-socket.js's summarizePeerConnection)
 * against the page's real RTCPeerConnection instances. Importing the shipped
 * module inside the page — rather than re-deriving a stats reducer here —
 * is what makes these assertions meaningful: a leak added to the module is
 * a leak this test sees. The module is already in the page's module map
 * (net.js dynamic-imports it on the p2p path), so this import is a cache hit.
 */
async function readDiagnostics(page) {
  return page.evaluate(async () => {
    const pcs = window.__p2pPCs || [];
    if (pcs.length === 0) return [];
    const url = new URL('js/multiplayer/p2p-socket.js', location.href).href;
    const mod = await import(url);
    const rows = [];
    for (let i = 0; i < pcs.length; i++) {
      rows.push(await mod.summarizePeerConnection('pc' + i, pcs[i]));
    }
    return rows;
  });
}

// The whitelist getP2PDiagnostics() promises. Anything outside it in an
// emitted row is a privacy regression regardless of its value.
const DIAG_ALLOWED_KEYS = new Set([
  'id', 'connectionState', 'iceConnectionState', 'selectedPairSource',
  'localCandidateType', 'remoteCandidateType', 'protocol', 'relayProtocol',
  'bytesSent', 'bytesReceived', 'currentRoundTripTime',
]);
// Substrings that must never appear anywhere in a serialized diagnostics
// row. Keys are checked against the whitelist (an unexpected key fails no
// matter what it holds); VALUES are checked for the shapes a leak would
// take — an address literal, a raw ICE candidate line, an SDP blob, a URL.
// Note the value scan deliberately does NOT grep for bare 'ip'/'port': the
// legitimate field name `currentRoundTripTime` contains "ip", and matching
// substrings inside whitelisted KEY NAMES is a false positive, not a leak.
function diagLeak(rows) {
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!DIAG_ALLOWED_KEYS.has(k)) return 'unexpected key "' + k + '"';
    }
  }
  // Only the VALUES, joined — key names are already fully constrained above.
  const values = rows.flatMap((r) => Object.values(r)).map((v) => String(v)).join(' | ');
  const BAD_VALUE_PATTERNS = [
    [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'an IPv4 literal'],
    [/[0-9a-f]{1,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}:/i, 'an IPv6 literal'],
    [/candidate:/i, 'a raw ICE candidate line'],
    [/:\/\//, 'a URL'],
    [/\b(turn|turns|stun|stuns):/i, 'an ICE server URL'],
    [/\bv=0\b|m=application|a=fingerprint|a=ice-ufrag/i, 'SDP'],
    [/credential|username/i, 'a credential field'],
  ];
  for (const [re, what] of BAD_VALUE_PATTERNS) {
    if (re.test(values)) return 'value contains ' + what;
  }
  return null;
}

async function waitLive(page, label) {  const ok = await page.waitForFunction(
    () => document.querySelector('.garden-mp-status')?.textContent === 'live',
    undefined, { timeout: scaled(30000) },
  ).then(() => true).catch(() => false);
  if (!ok) console.log(`  [${label}] never reached 'live' status`);
  return ok;
}

// /work/tools/test/mp-dual-workspace.mjs defines the production-checked
// helper pair that REUSES here. Re-implementing them inline would be the
// wrong shape of duplication; instead we re-derive a single-page variant:
// the same LECTERN_XZ/RING_RADIUS, the same poll-the-observer-while-pressing
// trick, the same post-keyup-rest confirmation that the figure stayed
// inside the ring. All of that came from real CI failures and is the
// reason the lease.request below is gated on a real ring transition, not
// a `ring:true` short-circuit.
const LECTERN_X = 1.6, LECTERN_Z = -1.4, RING_RADIUS = 0.9, RING_INNER = 0.35;

// SPY: GL2Runtime / GPURuntime.setUniforms. Lives on B so the test can
// observe A's pose broadcast landing in B's peer uniform bank — the
// OBSERVABLE proof the figure actually moved into the ring, not a guessed
// ring:true that would sidestep the very invariant the lease gates on.
async function armUniformSpy(page) {
  await page.evaluateOnNewDocument(() => {
    window.__uniformCalls = [];
    function patch(Ctor) {
      const orig = Ctor.prototype.setUniforms;
      Ctor.prototype.setUniforms = function (values) {
        window.__uniformCalls.push({ ...values });
        return orig.call(this, values);
      };
    }
    import('./js/runtime/webgl2.js').then((m) => patch(m.GL2Runtime)).catch(() => {});
    import('./js/runtime/webgpu.js').then((m) => patch(m.GPURuntime)).catch(() => {});
  });
}

async function isPeerInRing(observerPage, radius = RING_INNER) {
  return observerPage.evaluate(({ rx, rz, rr }) => {
    const calls = window.__uniformCalls || [];
    for (let i = calls.length - 1; i >= 0; i--) {
      const x = calls[i].uPeer0X, z = calls[i].uPeer0Z;
      if (typeof x === 'number' && typeof z === 'number') {
        return Math.hypot(x - rx, z - rz) < rr;
      }
    }
    return false;
  }, { rx: LECTERN_X, rz: LECTERN_Z, rr: radius });
}

async function moveIntoLecternRing(page, observerPage, label) {
  if (await isPeerInRing(observerPage, RING_INNER)) {
    console.log(`  [${label}] already deep in ring, no movement`);
    return;
  }
  // index.js's onKeyDown ignores keys while focus is on a textarea /
  // contenteditable. A drag-then-zoom cycle on the slider can leave a
  // keyboard-trapped pane; blur defensively.
  await page.evaluate(() => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) ae.blur();
  }).catch(() => {});
  await page.keyboard.down('d');
  await page.keyboard.down('w');
  const seenInRing = await observerPage.waitForFunction(
    ({ rx, rz, rr }) => {
      const calls = window.__uniformCalls || [];
      for (let i = calls.length - 1; i >= 0; i--) {
        const x = calls[i].uPeer0X, z = calls[i].uPeer0Z;
        if (typeof x === 'number' && typeof z === 'number') {
          return Math.hypot(x - rx, z - rz) < rr;
        }
      }
      return false;
    },
    { rx: LECTERN_X, rz: LECTERN_Z, rr: RING_INNER },
    { timeout: scaled(8000), polling: 100 },
  ).then(() => true).catch(() => false);
  await page.keyboard.up('d');
  await page.keyboard.up('w');
  if (!seenInRing) console.log(`  [${label}] peer did NOT reach the inner ring within timeout`);
  // Post-keyup rest confirmation (same shape as mp-dual-workspace.mjs):
  // prove the figure stayed inside LECTERN_RADIUS, not just at the
  // moment we released d+w.
  const watermark = await observerPage.evaluate(() => (window.__uniformCalls || []).length);
  const restingInRing = await observerPage.waitForFunction(
    ({ rx, rz, rr, from }) => {
      const calls = window.__uniformCalls || [];
      for (let i = calls.length - 1; i >= from; i--) {
        const x = calls[i].uPeer0X, z = calls[i].uPeer0Z;
        if (typeof x === 'number' && typeof z === 'number') {
          return Math.hypot(x - rx, z - rz) < rr;
        }
      }
      return false;
    },
    { rx: LECTERN_X, rz: LECTERN_Z, rr: RING_RADIUS, from: watermark },
    { timeout: scaled(5000), polling: 50 },
  ).then(() => true).catch(() => false);
  check(`(ring) ${label}: peer rests inside LECTERN_RADIUS after keyup`, restingInRing);
}

/* ---------- setup: A joins first → host. B joins → guest. ---------- */

const errorsA = [], errorsB = [];
const pageA = await freshPage(errorsA);
const pageB = await freshPage(errorsB);
// armUnformSpy on B: B is the OBSERVER for A's pose broadcasts. A does
// not need a uniform spy for any check here.
await armUniformSpy(pageB);
await armTransportSpy(pageA, 'A');
await armTransportSpy(pageB, 'B');

await gotoSafe(pageA, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: scaled(25000) })
  .catch((e) => errorsA.push('NAV A: ' + e.message));
await awaitGardenCanvas(pageA, errorsA);
const aLive = await waitLive(pageA, 'A');
check('(transport) A reached live', aLive);

await gotoSafe(pageB, roomUrl(ROOM), { waitUntil: 'networkidle2', timeout: scaled(25000) })
  .catch((e) => errorsB.push('NAV B: ' + e.message));
await awaitGardenCanvas(pageB, errorsB);
const bLive = await waitLive(pageB, 'B');
check('(transport) B reached live', bLive);

// Give the data channels a beat to settle — `open()` / `onopen()` is async
// in real WebRTC, and the spy only records createDataChannel() / onopen()
// calls (those happen synchronously inside p2p-socket.js's hostInitiatePeer
// or wireGuestPeerSide). 1.5s is well above observed negotiation time on
// loopback on this runner.
await sleep(scaled(1500));

const spyA = await readSpy(pageA);
const spyB = await readSpy(pageB);

/* ---------------- (1) Both reach live with REAL RTC, dialed our relay -------- */

check('(transport) A built a real RTCPeerConnection (not stubbed)', spyA && spyA.rtcSeen && !spyA.rtcMissing);
check('(transport) B built a real RTCPeerConnection (not stubbed)', spyB && spyB.rtcSeen && !spyB.rtcMissing);
check('(transport) A dialed our local relay URL',
  spyA && spyA.wsSockets.some((u) => u.includes(`127.0.0.1:${RELAY_PORT}`)));
check('(transport) B dialed our local relay URL',
  spyB && spyB.wsSockets.some((u) => u.includes(`127.0.0.1:${RELAY_PORT}`)));
check('(transport) A passed at least one ICE config', spyA && spyA.pcs.length >= 1);

/* ---------------- (2) Init-time WS spy: ALL signal frames, no gameplay --------- */

// Every JSON frame the host saw on its signaling WS, in order. Both
// `wsSent` and `wsReceived` are present in the spy — what we assert is
// the union carries exactly sg.signal.v1 types and ALL the types the
// brief calls out (hello/signal/signal.welcome/signal.peer.*/signal.host-lost
// have to be reachable from the union).
const sigA = [...spyA.wsSent, ...spyA.wsReceived].map((m) => m && m.t).filter(Boolean);
const sigB = [...spyB.wsSent, ...spyB.wsReceived].map((m) => m && m.t).filter(Boolean);
check('(transport) A signaling WS saw at least one `hello` frame',
  sigA.includes('hello'),
  JSON.stringify(sigA.slice(0, 12)));
// Host emits `hello` ONCE (the first time it dials); the relay does not
// echo `hello` back to the sender, so per-direction counts match "1 sent,
// 0 received" for the host. Guest emits `hello` ONCE on its own connect.
check('(transport) B signaling WS saw at least one `hello` frame', sigB.includes('hello'));
check('(transport) A signaling WS saw signal.welcome (`welcome`)',
  sigA.includes('welcome') || sigA.includes('signal.welcome'));
check('(transport) B signaling WS saw signal.welcome (`welcome`)',
  sigB.includes('welcome') || sigB.includes('signal.welcome'));

// Privacy floor: NO sg.mp.v1 gameplay frame ever crosses the signaling
// hop. Lease/draft/commit/poses/etc. are room-core traffic and travel
// over the data channels (§channels assertion below). A leaked gameplay
// `t` here would be a wire-isolation regression in p2p-socket's frame
// routing.
function gameplayLeak(sigs) {
  const ILLEGAL = new Set([
    'welcome', 'peer.join', 'peer.rename', 'peer.leave',
    'poses', 'lease', 'draft', 'commit', 'reject', 'tune',
    'tag', 'game', 'time', 'error', 'pose', 'ring',
    'lease.request', 'lease.release', 'lease.keepalive',
    'snapshot.request',
  ]);
  return sigs.find((t) => ILLEGAL.has(t)) || null;
}
const aLeak = gameplayLeak(sigA);
const bLeak = gameplayLeak(sigB);
check('(transport) A signaling WS has NO sg.mp.v1 gameplay leak (operator sees only SDP/ICE)',
  !aLeak, aLeak || JSON.stringify(sigA.slice(0, 16)));
check('(transport) B signaling WS has NO sg.mp.v1 gameplay leak (operator sees only SDP/ICE)',
  !bLeak, bLeak || JSON.stringify(sigB.slice(0, 16)));

/* ---------------- (3) Init-time PC/DC spy: channels shaped correctly, guest receives ---------- */

// HOST created exactly two data channels (one control, one pose); label
// and options recorded. We do NOT assert guest created any — guest
// doesn't create channels; it receives them via `datachannel` events.
const aChanLabels = spyA.dataChannelsCreated.map((c) => c.label).sort();
const aHasControl = spyA.dataChannelsCreated.find((c) => c.label === 'sg-mp-control-v1');
const aHasPose = spyA.dataChannelsCreated.find((c) => c.label === 'sg-mp-pose-v1');
check('(channels) HOST created sg-mp-control-v1', !!aHasControl, JSON.stringify(aChanLabels));
check('(channels) HOST created sg-mp-pose-v1', !!aHasPose, JSON.stringify(aChanLabels));
check('(channels) control channel is reliable ordered', aHasControl && aHasControl.ordered === true,
  JSON.stringify(aHasControl));
check('(channels) pose channel is unordered', aHasPose && aHasPose.ordered === false,
  JSON.stringify(aHasPose));
check('(channels) pose channel has maxRetransmits=0',
  aHasPose && aHasPose.maxRetransmits === 0, JSON.stringify(aHasPose));

// GUEST received the channels — the channels the host created travel
// over WebRTC to the guest as `datachannel` events, observed via the
// spy on `pc.addEventListener('datachannel', …)`. We DO NOT assert the
// guest's createDataChannel was called: guest doesn't call it.
const bChanLabels = spyB.dataChannelsReceived.map((c) => c.label).sort();
check('(channels) GUEST received at least one data channel via datachannel event',
  bChanLabels.length >= 1, JSON.stringify(spyB.dataChannelsReceived.slice(0, 4)));
const bGotControl = spyB.dataChannelsReceived.some((c) => c.label === 'sg-mp-control-v1');
check('(channels) GUEST received sg-mp-control-v1', bGotControl, JSON.stringify(bChanLabels));

/* ---------------- (4) Peer/pose over RTC, not signaling ----------------- */

// Per-direction over-RTC checks. The HOST (A) is alone on first dial,
// so its reducer's welcome is a LOCAL loopback — not crossing any
// network at all. We don't assert that A received `welcome` over a
// data channel: it never does. The GUEST (B) is the case where the
// welcome MUST travel: B's room-core join handshake arrives on the
// guest's data channels from the host.
//
// peer.join for B's arrival is generated by the HOST's reducer when
// the relay forwards signal.peer.join. The host reducer broadcasts it
// over the data channels to OTHER peers (B) AND fires it locally to
// its own net.js handler — but that local fire goes through
// dispatchEvent, not addEventListener (the host reducer is a
// self-dispatch, not a receive). Our addEventListener wrap misses the
// self-dispatch by design. So we DO NOT assert A.dcReceivedFrames
// contains peer.join: that path is wired but not the path under test.
const bSawWelcome = spyB.dcReceivedFrames.some((m) => m.t === 'welcome');
check('(over-RTC) GUEST (B) received its own `welcome` (carrying A in the roster) over the data channel',
  bSawWelcome, JSON.stringify(spyB.dcReceivedFrames.slice(0, 6)));

/* ---------------- (5) REAL ring + lease transition (`poses` over RTC) ------
 *
 * Single inseparable flow per the brief: real keyboard movement into the
 * lectern ring (gated by checkRing) → `ring:true` over the wire →
 * click the production lease button → `lease` message on the
 * control channel. NO pre-press of any free-movement key (that would
 * scatter A's pose broadcasts and scramble what the ring-test observes).
 *
 * The MOVE itself is also where `poses` traffic gets proven: while
 * A walks into the ring, A's net.js sends `pose` (singular) at 15Hz;
 * the host reducer batches them into `poses` (plural, sg.mp.v1
 * batched form) and broadcasts on the pose channel. B's data channel
 * spy sees those batched frames on the `sg-mp-pose-v1` label — that
 * is the wire-level proof pose traffic rides over RTC, not signaling.
 */
function lastFrame(arr, t) {
  let out = null;
  for (const m of arr) if (m.t === t) out = m;
  return out;
}
async function posesOnPoseChannel(observerPage) {
  return observerPage.evaluate(() => {
    const frames = (window.__p2p && window.__p2p.dcReceivedFrames) || [];
    return frames.filter((m) => m.label === 'sg-mp-pose-v1' && m.t === 'poses').length;
  });
}

await moveIntoLecternRing(pageA, pageB, 'A-takes-lease');

// `poses` over the pose channel: at least one batched frame arrived
// during the move. Number is not asserted (mock vs real WebRTC pacing
// affects batching); presence is the wire-isolation claim.
const posesSeen = await posesOnPoseChannel(pageB);
check('(over-RTC) B received at least one `poses` (batched) frame on sg-mp-pose-v1 during the move',
  posesSeen >= 1, 'count=' + posesSeen);

const aTakeResult = await pageA.evaluate(() => {
  // The holder's lease control surfaces as a `.garden-lease-btn` in the
  // lease line — production line 194. Its click handler is wired to
  // `net.requestLease()` AND a real production state-transition chain
  // through checkRing → ring wire message → room-core gate → lease
  // broadcast back over the data channel.
  const btn = document.querySelector('.garden-lease-btn');
  if (!btn) return { ok: false, reason: 'no-button' };
  btn.click();
  return { ok: true };
});
check('(lease) A\'s lease button click went through', aTakeResult.ok, JSON.stringify(aTakeResult));
// Give the room's reducer a beat to echo a `lease` message back over the
// control data channel and for B's status to settle.
await sleep(scaled(1000));
const spyAfterLeaseB = await readSpy(pageB);
// B receives the lease broadcast over the data channel — that is the
// wire-level proof the grant crossed the room. A's reducer also emits
// the same `lease` event locally for its own net.js handler (status
// pill), but that local emission is dispatchEvent, not addEventListener,
// so the spy is correct to miss it. The local grant is asserted via
// A's UI line below — the production surface that names A as holder.
const bLeaseOnDC = lastFrame(spyAfterLeaseB.dcReceivedFrames, 'lease');
check('(lease) B received a `lease` frame over the data channel',
  !!bLeaseOnDC, JSON.stringify(bLeaseOnDC));

// Both UI lines: A's lease line shows A holds (local grant, asserted
// on production DOM, not on a frame the spy cannot see); B's lease
// line shows the same holder from across the wire.
const aLeaseLine = await pageA.evaluate(() => document.querySelector('.garden-lease-line')?.textContent || '');
const bLeaseLine = await pageB.evaluate(() => document.querySelector('.garden-lease-line')?.textContent || '');
check('(lease) A\'s own lease line shows A holds the lectern (UI on the host)',
  /you hold the lectern/.test(aLeaseLine), aLeaseLine);
check('(lease) B\'s own lease line names a holder (UI on the guest)',
  /holds the lectern/.test(bLeaseLine), bLeaseLine);

/* ---------------- (6) Real tune slider input by HOLDER + remote convergence ---------- */
// A holds the lectern. Open the `terrain` probe panel (component 2 in
// scene.glsl, has @tune directives TERRAIN_ROUGHNESS / TERRAIN_SCALE),
// input a fresh value into one of the sliders, and verify the production
// chain: A's dcSent carries a `tune` message + B's dcReceivedFrames
// carries a matching `tune` + B's runtime uniform bank reflects it.
//
// We use direct DOM input events because headless GPU canvas probes
// depend on a real probeAt renderOnce — driving it through the tray
// click works on a real GPU, but the harness's signal that the slider
// moved travels entirely via DOM listeners either way. Reading the
// runtime uniform bank on B is the cross-machine proof: a probe-panel
// slider input only updates B's runtime if the `tune` traveled over
// the data channel AND the runtime's setUniforms was called here.

const TERRAIN_SLIDER = '.probe-panel .probe-tune-range[data-name="TERRAIN_ROUGHNESS"]';

// First open the terrain probe panel on A by clicking the tray item by
// name. Tray clicks are pure DOM (no GPU), so this is reliable across
// runners. The panel mounts and exposes the slider even when the
// underlying readback pixel can't be probed.
async function openTrayItemByName(page, name, label) {
  const ok = await page.evaluate((nm) => {
    const items = [...document.querySelectorAll('.garden-tray-item')];
    for (const it of items) {
      const txt = it.querySelector('.garden-tray-item-name')?.childNodes[0]?.textContent?.trim();
      if (txt === nm) { it.click(); return true; }
    }
    return false;
  }, name);
  if (!ok) console.log(`  [${label}] tray item "${name}" not found`);
  return ok;
}

await openTrayItemByName(pageA, 'Rolling Hills (evolved)', 'A');
// Wait for the panel to render its slider list. A panel with no tunes
// never produces a slider at all — the test asserts on TERRAIN_ROUGHNESS,
// chosen because terrain always declares at least one @tune in scene.glsl.
const sliderMounted = await pageA.waitForSelector(TERRAIN_SLIDER, { timeout: scaled(8000) })
  .then(() => true).catch(() => false);
check('(tune) terrain probe panel mounted with the TERRAIN_ROUGHNESS slider on A', sliderMounted);

// Read current value, push a fresh one within the declared [0.35, 0.72]
// range, dispatch input. Net fires `tune`, p2p-socket routes it over the
// control data channel, B receives it, B's panel setTuneValue updates
// the slider on B (panel must also be open), AND B's runtime setUniforms
// receives the new value.
// The HTML range element step-snaps the assigned value (e.g. 0.61 ->
// 0.61085 with the declared step). Production is correct: A's wire and
// B's runtime carry the snapped value the slider actually emitted. The
// test therefore reads the slider's numeric value AFTER assignment — the
// value the input event carried — and asserts the wire/runtime match
// that. Loosening tolerance would hide the bug.
const tuneRequested = 0.61; // strictly different from the default 0.53
const tuneActual = await pageA.evaluate((v) => {
  const r = document.querySelector('.probe-panel .probe-tune-range[data-name="TERRAIN_ROUGHNESS"]');
  if (!r) return null;
  r.value = String(v);
  // The real listener is registered via `range.addEventListener('input', …)`
  // in panel.js — re-dispatch the same event the user would have generated.
  r.dispatchEvent(new Event('input', { bubbles: true }));
  // Read the post-snap numeric value the input event just delivered.
  return r.valueAsNumber;
}, tuneRequested);
const tuneValue = tuneActual;

await sleep(scaled(1200));

const spyAfterTuneA = await readSpy(pageA);
const spyAfterTuneB = await readSpy(pageB);
const aTuneFrame = lastFrame(spyAfterTuneA.dcSent, 'tune');
const bTuneFrame = lastFrame(spyAfterTuneB.dcReceivedFrames, 'tune');
check('(tune) HOLDER (A) sent a `tune` frame over the data channel',
  !!aTuneFrame, JSON.stringify(aTuneFrame && aTuneFrame.frame));
check('(tune) GUEST (B) received a `tune` frame over the data channel',
  !!bTuneFrame, JSON.stringify(bTuneFrame && bTuneFrame.frame));
check('(tune) the host->guest tune name matches TERRAIN_ROUGHNESS',
  bTuneFrame && bTuneFrame.frame && bTuneFrame.frame.name === 'TERRAIN_ROUGHNESS',
  JSON.stringify(bTuneFrame && bTuneFrame.frame));
check('(tune) the host->guest tune value matches what HOLDER dialed (' + tuneValue + ')',
  bTuneFrame && bTuneFrame.frame && Math.abs(bTuneFrame.frame.value - tuneValue) < 1e-9,
  JSON.stringify(bTuneFrame && bTuneFrame.frame));

// Runtime convergence on B. Note: the bare setUniforms spy on B catches
// EVERY uniform call, including pose-rendering churn, so we look for
// the SPECIFIC TERRAIN_ROUGHNESS entry — its presence on B proves the
// tune traveled into B's runtime bank, which is the unit-converged
// promise the panel.js contract depends on.
const bUniforms = await pageB.evaluate(() => (window.__uniformCalls || []).filter((c) => 'TERRAIN_ROUGHNESS' in c));
const bConverged = bUniforms.some((c) => Math.abs(c.TERRAIN_ROUGHNESS - tuneValue) < 1e-9);
check('(tune) B\'s runtime uniform bank received TERRAIN_ROUGHNESS=' + tuneValue,
  bConverged, 'sample=' + JSON.stringify(bUniforms.slice(-3)));

/* ---------------- (6b) WebRTC diagnostics: sanitized, real, and moving ------- */

// These run BEFORE the host close so there is still a live peer connection
// to describe. Two samples separated by a beat of live gameplay (the pose
// loop runs continuously at POSE_HZ) let us assert byte counters advance —
// the "is anything actually flowing" question a rehearsal asks first.
const diagA1 = await readDiagnostics(pageA);
const diagB1 = await readDiagnostics(pageB);
await sleep(scaled(1500));
const diagA2 = await readDiagnostics(pageA);
const diagB2 = await readDiagnostics(pageB);

check('(diagnostics) HOST reports at least one peer connection', diagA2.length >= 1,
  JSON.stringify(diagA2));
check('(diagnostics) GUEST reports at least one peer connection', diagB2.length >= 1,
  JSON.stringify(diagB2));

const aLeakDiag = diagLeak(diagA2);
const bLeakDiag = diagLeak(diagB2);
check('(diagnostics) HOST rows carry no SDP/address/URL/credential/candidate string',
  !aLeakDiag, aLeakDiag + ' :: ' + JSON.stringify(diagA2));
check('(diagnostics) GUEST rows carry no SDP/address/URL/credential/candidate string',
  !bLeakDiag, bLeakDiag + ' :: ' + JSON.stringify(diagB2));

const rowA = diagA2[0] || {};
const rowB = diagB2[0] || {};
check('(diagnostics) HOST connectionState is connected', rowA.connectionState === 'connected',
  JSON.stringify(rowA));
check('(diagnostics) GUEST connectionState is connected', rowB.connectionState === 'connected',
  JSON.stringify(rowB));
check('(diagnostics) HOST iceConnectionState is connected/completed',
  rowA.iceConnectionState === 'connected' || rowA.iceConnectionState === 'completed',
  JSON.stringify(rowA));

// A selected pair MUST have resolved by now — via transport
// .selectedCandidatePairId on Chromium, or one of the documented fallbacks.
check('(diagnostics) HOST resolved a selected/nominated candidate pair',
  rowA.selectedPairSource === 'transport' || rowA.selectedPairSource === 'selected-flag'
  || rowA.selectedPairSource === 'succeeded',
  'source=' + rowA.selectedPairSource);

// Candidate types must be from the ICE enum. We deliberately do NOT assert
// 'relay' here: this harness runs both pages on loopback with no TURN
// server, so the honest outcome is 'host'. Asserting relay would be a
// false TURN claim — the forced-TURN evidence gate lives in DEPLOY.md's
// two-household rehearsal, where a real TURN server exists.
const ICE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
check('(diagnostics) HOST local candidate type is a valid ICE type',
  ICE_TYPES.has(rowA.localCandidateType), 'local=' + rowA.localCandidateType);
check('(diagnostics) HOST remote candidate type is a valid ICE type',
  ICE_TYPES.has(rowA.remoteCandidateType), 'remote=' + rowA.remoteCandidateType);
check('(diagnostics) HOST pair protocol is a known transport protocol',
  rowA.protocol === 'udp' || rowA.protocol === 'tcp' || rowA.protocol === 'tls',
  'protocol=' + rowA.protocol);
// relayProtocol is null unless the local candidate is a relay candidate.
// On loopback that is exactly what we expect, and asserting it keeps the
// field from quietly turning into a pass-through for something else.
check('(diagnostics) HOST relayProtocol is null on a non-relay (loopback) pair',
  rowA.localCandidateType === 'relay' ? rowA.relayProtocol != null : rowA.relayProtocol === null,
  'localType=' + rowA.localCandidateType + ' relayProtocol=' + rowA.relayProtocol);

check('(diagnostics) HOST byte counters are numeric',
  typeof rowA.bytesSent === 'number' && typeof rowA.bytesReceived === 'number',
  JSON.stringify(rowA));
const prevA = diagA1[0] || {};
check('(diagnostics) HOST bytesSent advanced between samples (traffic is flowing)',
  typeof prevA.bytesSent === 'number' && rowA.bytesSent > prevA.bytesSent,
  'before=' + prevA.bytesSent + ' after=' + rowA.bytesSent);
check('(diagnostics) HOST bytesReceived advanced between samples',
  typeof prevA.bytesReceived === 'number' && rowA.bytesReceived > prevA.bytesReceived,
  'before=' + prevA.bytesReceived + ' after=' + rowA.bytesReceived);
check('(diagnostics) HOST currentRoundTripTime is a finite non-negative number or null',
  rowA.currentRoundTripTime === null
  || (Number.isFinite(rowA.currentRoundTripTime) && rowA.currentRoundTripTime >= 0),
  'rtt=' + rowA.currentRoundTripTime);

console.log('  (diagnostics) observed HOST row: ' + JSON.stringify(rowA));
console.log('  (diagnostics) observed GUEST row: ' + JSON.stringify(rowB));

/* ---------------- (7) Host close -> visible fail-closed + signal.host-lost ---------- */

// Closing the HOST page forces p2p-socket.js's `peerconnectionstatechange`
// path to fire signal.host-lost to the guest. B's status pill flips to
// `closed` (per docs/multiplayer-spec.md §6.1 host-loss is fail-closed,
// guest never silently reconnects to a different host).
// Snapshot the signaling-WS welcome count BEFORE the close so the
// post-close "no fresh welcome" assertion compares against a known
// baseline rather than the post-close total (which now includes the
// signal.host-lost frame and would otherwise make any "no new welcome"
// assertion tautologically true).
const spyBPreClose = await readSpy(pageB);
const welcomesBeforeClose = spyBPreClose.wsReceived.filter((m) => m.t === 'welcome' || m.t === 'signal.welcome').length;

await pageA.close({ runBeforeUnload: false }).catch(() => { /* already closed */ });
// Host-lost propagation is bounded by signaling ping latency, not ICE
// timeouts — 2s is generous on loopback.
await sleep(scaled(2000));

const spyBFinal = await readSpy(pageB);
const bStatusText = await pageB.evaluate(() => document.querySelector('.garden-mp-status')?.textContent || '');
const bStatusClass = await pageB.evaluate(() => document.querySelector('.garden-mp-status')?.className || '');
// §6.1 fail-closed surfaces as the `closed` status state (with text
// "host lost") OR the legacy `retrying` pill — both are non-connecting
// end-states the spec accepts. The class carries the state, the text
// carries the human-readable reason.
const bFailedClosed = /retrying|disconnected|failed|no-relay|host lost/.test(bStatusText)
  || /(^|\s)closed(\s|$)/.test(bStatusClass);
check('(host-loss) B visibly entered fail-closed state after host close',
  bFailedClosed, 'text=' + JSON.stringify(bStatusText) + ' class=' + JSON.stringify(bStatusClass));

const bSawHostLost = spyBFinal.wsReceived.some((m) => m.t === 'signal.host-lost' || m.t === 'host-lost');
check('(host-loss) B received `signal.host-lost` on its signaling WS',
  bSawHostLost,
  'signal frames on B: ' + JSON.stringify(
    spyBFinal.wsReceived.map((m) => m.t).filter((t) => /signal\.|host|welcome/i.test(t)).slice(0, 12)
  ));

// Negative assertion: the signaling WS did NOT carry a fresh `welcome`
// after the host close. Compare against the pre-close baseline count —
// a new welcome would mean a silent reconnect to a different host, the
// exact fail-closed regression this floor catches.
const welcomesAfterClose = spyBFinal.wsReceived.filter((m) => m.t === 'welcome' || m.t === 'signal.welcome').length;
check('(host-loss) B received no fresh `welcome` over the signaling WS after host close',
  welcomesAfterClose === welcomesBeforeClose,
  'before=' + welcomesBeforeClose + ' after=' + welcomesAfterClose);

/* ---------------- teardown ---------------- */

check('no console errors on A', errorsA.length === 0, errorsA.join(' | '));
check('no console errors on B', errorsB.length === 0, errorsB.join(' | '));

try { pageA.close(); } catch { /* */ }
try { pageB.close(); } catch { /* */ }
try { browser.close(); } catch { /* */ }
try { server.kill(); } catch { /* */ }
try { relay.close(); } catch { /* */ }

if (errorsA.length) {
  console.log('--- page A console errors ---');
  for (const e of errorsA) console.log('  ', e);
}
if (errorsB.length) {
  console.log('--- page B console errors ---');
  for (const e of errorsB) console.log('  ', e);
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
