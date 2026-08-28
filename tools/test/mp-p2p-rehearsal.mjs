// Shader Garden — mp-p2p-rehearsal.mjs
//
// Two-household rehearsal companion. This is NOT a pass/fail test: it is the
// instrument you watch while a human friend on the other side of the internet
// joins the same room from their own house, their own network, their own
// browser. It opens ONE local browser peer against a PUBLIC deployment you
// supply, then prints, on a fixed interval:
//
//   - sanitized WebRTC diagnostics for every peer connection this browser
//     holds (the same rows getP2PDiagnostics() returns in the app)
//   - gameplay convergence status read from the real DOM: transport, status
//     pill, roster, lease line, game phase, and the live @tune values
//
// It is deliberately provider-neutral: nothing here names a STUN/TURN vendor,
// a host, or a deployment. Everything comes from flags.
//
// SECRETS: this script never prints a URL, an IP address, an ICE candidate,
// SDP, or a TURN username/credential. The diagnostics rows come from
// p2p-socket.js's summarizePeerConnection() — the SHIPPED sanitizer, imported
// inside the page — so there is exactly one whitelist to audit, and a leak in
// the app is a leak here too rather than two copies drifting apart. The only
// thing echoed about the target is the room name and the target's ORIGIN
// (scheme+host), which is public by definition on a Pages deploy; pass
// --no-origin to suppress even that when screen-sharing.
//
// Usage:
//   node tools/test/mp-p2p-rehearsal.mjs --url https://<host>/<path>/ --room <room>
//   node tools/test/mp-p2p-rehearsal.mjs --url ... --room ... --minutes 20 --interval 10
//
// Flags:
//   --url <u>        REQUIRED. Public deployment root or index.html URL.
//   --room <r>       REQUIRED. Room name; both households must type the same.
//   --name <n>       Display name for this local peer (default 'rehearsal').
//   --interval <s>   Seconds between reports (default 10, min 2).
//   --minutes <m>    Stop after m minutes (default 30; 0 = run until Ctrl-C).
//   --transport <t>  'p2p' (default) or 'ws'. Appended as ?transport=.
//   --no-origin      Do not print the target origin (screen-share safe).
//   --json-only      Print one JSON object per interval and nothing else.
//
// Exit code is 0 on a clean stop (timer elapsed or Ctrl-C) and 1 only if the
// browser never reached the room at all — a rehearsal that could not start is
// different from a rehearsal that showed you a bad number.

import { launch, sleep, gotoSafe } from './browser.mjs';

/* ---------------- flags ---------------- */

function parseArgs(argv) {
  const out = { interval: 10, minutes: 30, name: 'rehearsal', transport: 'p2p' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--room') out.room = next();
    else if (a === '--name') out.name = next();
    else if (a === '--interval') out.interval = Number(next());
    else if (a === '--minutes') out.minutes = Number(next());
    else if (a === '--transport') out.transport = next();
    else if (a === '--no-origin') out.noOrigin = true;
    else if (a === '--json-only') out.jsonOnly = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.bad = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function usage(msg) {
  if (msg) console.error('error: ' + msg);
  console.error(
    'usage: node tools/test/mp-p2p-rehearsal.mjs --url <public-url> --room <room>\n' +
    '       [--name <n>] [--interval <seconds>] [--minutes <m>] [--transport p2p|ws]\n' +
    '       [--no-origin] [--json-only]');
  process.exit(msg ? 2 : 0);
}

if (args.help) usage();
if (args.bad) usage('unknown argument ' + JSON.stringify(args.bad));
if (!args.url) usage('--url is required');
if (!args.room) usage('--room is required');
if (!Number.isFinite(args.interval) || args.interval < 2) usage('--interval must be >= 2 seconds');
if (!Number.isFinite(args.minutes) || args.minutes < 0) usage('--minutes must be >= 0');
if (args.transport !== 'p2p' && args.transport !== 'ws') usage('--transport must be p2p or ws');

let target;
try { target = new URL(args.url); } catch { usage('--url is not a valid URL'); }
if (target.protocol !== 'https:' && target.hostname !== 'localhost' && target.hostname !== '127.0.0.1') {
  usage('--url must be https:// for a public rehearsal (a WebRTC/service-worker page needs a secure context)');
}

// Build the room URL from the supplied deployment root. A URL that already
// points at index.html is used as-is; anything else gets index.html appended
// to its directory. Query and hash are OURS — a stale ?relay= or #/garden/
// from a pasted URL is dropped so the rehearsal targets what the flags say.
function buildRoomUrl(u, room, transport) {
  const base = new URL(u.href);
  base.search = '';
  base.hash = '';
  if (!/index\.html$/.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/?$/, '/') + 'index.html';
  }
  base.searchParams.set('transport', transport);
  base.hash = '#/garden/' + room;
  return base.href;
}

const roomUrl = buildRoomUrl(target, args.room, args.transport);
// Printed instead of the full URL: no query string, no path secrets.
const originLabel = args.noOrigin ? '<origin hidden>' : target.origin;

/* ---------------- page instrumentation ----------------
 *
 * One init script, installed before any page module evaluates, that collects
 * the LIVE RTCPeerConnection instances the page creates. We deliberately do
 * not record configs, candidates, or SDP — only the instances, so we can ask
 * the shipped sanitizer about them later. `iceServerCount` is the one config
 * fact we keep, and it is a COUNT: it tells the operator "an ICE list was
 * passed" without revealing a single URL or credential.
 */
async function armRehearsalProbe(page) {
  const script = () => {
    const w = window;
    w.__sgRehearsal = { pcs: [], iceServerCount: [], rtcMissing: false };
    if (typeof w.RTCPeerConnection !== 'function') {
      w.__sgRehearsal.rtcMissing = true;
      return;
    }
    const Orig = w.RTCPeerConnection;
    function Probe(cfg) {
      const pc = new Orig(cfg);
      w.__sgRehearsal.pcs.push(pc);
      const list = (cfg && Array.isArray(cfg.iceServers)) ? cfg.iceServers : [];
      w.__sgRehearsal.iceServerCount.push(list.length); // COUNT only, never the entries
      return pc;
    }
    Object.defineProperty(Probe, 'name', { value: 'RTCPeerConnection' });
    Probe.prototype = Orig.prototype;
    w.RTCPeerConnection = Probe;
  };
  // playwright-core exposes addInitScript; the repo's browser.mjs pages also
  // carry puppeteer's evaluateOnNewDocument alias. Use whichever exists so
  // this script keeps working if the harness swaps drivers.
  if (typeof page.addInitScript === 'function') await page.addInitScript(script);
  else await page.evaluateOnNewDocument(script);
}

/** Sanitized diagnostics via the SHIPPED sanitizer, imported in-page. */
async function readDiagnostics(page) {
  return page.evaluate(async () => {
    const st = window.__sgRehearsal;
    if (!st || st.rtcMissing) return { error: 'no-rtc', rows: [] };
    if (st.pcs.length === 0) return { error: null, rows: [] };
    const url = new URL('js/multiplayer/p2p-socket.js', location.href).href;
    let mod;
    try { mod = await import(url); } catch { return { error: 'sanitizer-unavailable', rows: [] }; }
    if (typeof mod.summarizePeerConnection !== 'function') {
      return { error: 'sanitizer-missing-export', rows: [] };
    }
    const rows = [];
    for (let i = 0; i < st.pcs.length; i++) {
      rows.push(await mod.summarizePeerConnection('peer' + i, st.pcs[i]));
    }
    return { error: null, rows };
  });
}

/** Gameplay convergence, read from the REAL DOM the friend is looking at. */
async function readConvergence(page) {
  return page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const status = document.querySelector('.garden-mp-status');
    const roster = [...document.querySelectorAll('.garden-roster-item')]
      .map((li) => li.querySelector('.garden-roster-name')?.textContent?.trim())
      .filter(Boolean);
    // Live @tune values from any open probe panel: the cheapest observable
    // proof that a holder's slider converged on this side too.
    const tunes = {};
    for (const r of document.querySelectorAll('.probe-tune-range[data-name]')) {
      tunes[r.getAttribute('data-name')] = Number(r.value);
    }
    return {
      status: status ? status.textContent.trim() : null,
      statusState: status ? (status.className.match(/garden-mp-status-([\w-]+)/) || [])[1] || null : null,
      rosterCount: roster.length,
      roster,
      lease: txt('.garden-lease-line'),
      game: txt('.garden-game-line'),
      tunes,
      pcCount: (window.__sgRehearsal && window.__sgRehearsal.pcs.length) || 0,
      iceServerCount: (window.__sgRehearsal && window.__sgRehearsal.iceServerCount.slice(0, 4)) || [],
    };
  });
}

/* ---------------- human-readable report ---------------- */

function fmtBytes(n) {
  if (typeof n !== 'number') return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  return (n / (1024 * 1024)).toFixed(2) + ' MiB';
}

function fmtRtt(s) {
  return typeof s === 'number' ? (s * 1000).toFixed(1) + ' ms' : '—';
}

function pathLabel(row) {
  const l = row.localCandidateType || '?';
  const r = row.remoteCandidateType || '?';
  const relayed = (l === 'relay' || r === 'relay');
  const proto = row.protocol || '?';
  const via = relayed ? ('RELAYED/TURN' + (row.relayProtocol ? ' over ' + row.relayProtocol : '')) : 'direct';
  return `${l}<->${r} ${proto} (${via})`;
}

// Previous sample per peer id, so the report can say "moving" vs "stalled"
// instead of leaving the operator to diff numbers by eye.
const prev = new Map();

function report(stamp, diag, conv) {
  const lines = [];
  lines.push(`── ${stamp} ── room=${args.room} origin=${originLabel} transport=${args.transport}`);
  lines.push(`   status=${conv.status ?? '—'} (${conv.statusState ?? '—'})` +
    `  peers-in-roster=${conv.rosterCount}  peer-connections=${conv.pcCount}` +
    `  ice-list-sizes=[${conv.iceServerCount.join(',')}]`);
  lines.push(`   roster: ${conv.roster.length ? conv.roster.join(', ') : '(empty)'}`);
  lines.push(`   lease: ${conv.lease ?? '—'}`);
  if (conv.game) lines.push(`   game: ${conv.game}`);
  const tuneKeys = Object.keys(conv.tunes);
  if (tuneKeys.length) {
    lines.push('   tunes: ' + tuneKeys.map((k) => `${k}=${conv.tunes[k]}`).join(' '));
  }
  if (diag.error) lines.push(`   diagnostics unavailable: ${diag.error}`);
  if (diag.rows.length === 0 && !diag.error) lines.push('   diagnostics: no peer connection yet');
  for (const row of diag.rows) {
    const p = prev.get(row.id);
    const dSent = (p && typeof row.bytesSent === 'number' && typeof p.bytesSent === 'number')
      ? row.bytesSent - p.bytesSent : null;
    const dRecv = (p && typeof row.bytesReceived === 'number' && typeof p.bytesReceived === 'number')
      ? row.bytesReceived - p.bytesReceived : null;
    const moving = (dSent != null && dRecv != null)
      ? ((dSent > 0 && dRecv > 0) ? 'MOVING' : (dSent > 0 || dRecv > 0) ? 'one-way' : 'STALLED')
      : 'first-sample';
    lines.push(`   ${row.id}: pc=${row.connectionState} ice=${row.iceConnectionState}` +
      `  pair=${row.selectedPairSource}  ${pathLabel(row)}`);
    lines.push(`     sent=${fmtBytes(row.bytesSent)} recv=${fmtBytes(row.bytesReceived)}` +
      `  Δsent=${dSent == null ? '—' : fmtBytes(dSent)} Δrecv=${dRecv == null ? '—' : fmtBytes(dRecv)}` +
      `  rtt=${fmtRtt(row.currentRoundTripTime)}  [${moving}]`);
    prev.set(row.id, row);
  }
  console.log(lines.join('\n'));
}

/* ---------------- run ---------------- */

const browser = await launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await armRehearsalProbe(page);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

let reachedRoom = false;
try {
  if (!args.jsonOnly) {
    console.log(`opening one local peer against ${originLabel} room=${args.room} ` +
      `(transport=${args.transport}); reporting every ${args.interval}s. Ctrl-C to stop.`);
    console.log('Nothing below this line contains a URL, an IP address, SDP, an ICE ' +
      'candidate, or a TURN credential — it is safe to screen-share.');
  }
  await gotoSafe(page, roomUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // "Reached the room" = the multiplayer status pill exists at all. We do NOT
  // require 'live': waiting for the friend to join is the whole point, and a
  // stuck 'connecting' is itself a finding worth printing.
  reachedRoom = await page.waitForSelector('.garden-mp-status', { timeout: 60000 })
    .then(() => true).catch(() => false);
  if (!reachedRoom) {
    console.error('the page never rendered a multiplayer status pill — is multiplayer ' +
      'configured on this deployment (relay.json), and is the URL a garden route?');
  } else {
    const deadline = args.minutes > 0 ? Date.now() + args.minutes * 60_000 : Infinity;
    while (!stopping && Date.now() < deadline) {
      const stamp = new Date().toISOString().slice(11, 19) + 'Z';
      let diag = { error: 'read-failed', rows: [] };
      let conv = { status: null, statusState: null, rosterCount: 0, roster: [], lease: null, game: null, tunes: {}, pcCount: 0, iceServerCount: [] };
      try { diag = await readDiagnostics(page); } catch { /* page busy/navigating */ }
      try { conv = await readConvergence(page); } catch { /* page busy/navigating */ }
      if (args.jsonOnly) {
        // Machine-readable form: same sanitized fields, no free text.
        console.log(JSON.stringify({
          t: stamp, room: args.room, transport: args.transport,
          status: conv.status, statusState: conv.statusState,
          rosterCount: conv.rosterCount, roster: conv.roster,
          lease: conv.lease, game: conv.game, tunes: conv.tunes,
          peerConnections: conv.pcCount, iceServerCount: conv.iceServerCount,
          diagnosticsError: diag.error, peers: diag.rows,
        }));
        for (const row of diag.rows) prev.set(row.id, row);
      } else {
        report(stamp, diag, conv);
      }
      // Sleep in short slices so Ctrl-C is responsive during a long interval.
      for (let waited = 0; waited < args.interval * 1000 && !stopping; waited += 250) {
        await sleep(250);
      }
    }
  }
} finally {
  if (!args.jsonOnly && consoleErrors.length) {
    console.log(`\n${consoleErrors.length} console error(s) on the local peer (first 5):`);
    for (const e of consoleErrors.slice(0, 5)) console.log('  ', e);
  }
  try { await page.close(); } catch { /* already gone */ }
  try { await browser.close(); } catch { /* already gone */ }
}

process.exit(reachedRoom ? 0 : 1);
