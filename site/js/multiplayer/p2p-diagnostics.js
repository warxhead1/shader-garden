// Sanitized WebRTC selected-pair diagnostics. This module deliberately reads
// only coarse connection/candidate types and counters: never addresses, ports,
// URLs, SDP, candidate strings, usernames, or credentials.

const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const PROTOCOLS = new Set(['udp', 'tcp', 'tls', 'dtls', 'ssltcp']);

function safeEnum(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function summarizeSelectedPair(report) {
  const empty = {
    source: 'none',
    localCandidateType: null,
    remoteCandidateType: null,
    protocol: null,
    relayProtocol: null,
    bytesSent: null,
    bytesReceived: null,
    currentRoundTripTime: null,
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
  for (const transport of transports) {
    const candidate = byId.get(transport.selectedCandidatePairId);
    if (candidate && candidate.type === 'candidate-pair') {
      pair = candidate;
      source = 'transport';
      break;
    }
  }
  if (!pair) {
    pair = pairs.find((candidate) => candidate.selected === true)
      || pairs.find((candidate) => candidate.nominated === true && candidate.state === 'succeeded')
      || null;
    if (pair) source = 'selected-flag';
  }
  if (!pair) {
    pair = pairs.find((candidate) => candidate.state === 'succeeded') || null;
    if (pair) source = 'succeeded';
  }
  if (!pair) return empty;

  const local = pair.localCandidateId ? byId.get(pair.localCandidateId) : null;
  const remote = pair.remoteCandidateId ? byId.get(pair.remoteCandidateId) : null;
  return {
    source,
    localCandidateType: safeEnum(local && local.candidateType, CANDIDATE_TYPES),
    remoteCandidateType: safeEnum(remote && remote.candidateType, CANDIDATE_TYPES),
    protocol: safeEnum(pair.protocol, PROTOCOLS) || safeEnum(local && local.protocol, PROTOCOLS),
    relayProtocol: safeEnum(local && local.relayProtocol, PROTOCOLS),
    bytesSent: safeNumber(pair.bytesSent),
    bytesReceived: safeNumber(pair.bytesReceived),
    currentRoundTripTime: safeNumber(pair.currentRoundTripTime),
  };
}

export async function summarizePeerConnection(peerId, pc) {
  let pair = summarizeSelectedPair(null);
  if (pc && typeof pc.getStats === 'function') {
    try {
      pair = summarizeSelectedPair(await pc.getStats());
    } catch { /* Stats are optional diagnostics; preserve null metrics. */ }
  }
  return {
    id: typeof peerId === 'string' ? peerId : null,
    connectionState: pc && typeof pc.connectionState === 'string' ? pc.connectionState : null,
    iceConnectionState: pc && typeof pc.iceConnectionState === 'string' ? pc.iceConnectionState : null,
    selectedPairSource: pair.source,
    localCandidateType: pair.localCandidateType,
    remoteCandidateType: pair.remoteCandidateType,
    protocol: pair.protocol,
    relayProtocol: pair.relayProtocol,
    bytesSent: pair.bytesSent,
    bytesReceived: pair.bytesReceived,
    currentRoundTripTime: pair.currentRoundTripTime,
  };
}
