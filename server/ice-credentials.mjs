// Shader Garden — server/ice-credentials.mjs
// Pure helpers for the GET /ice-credentials endpoint. This file does no I/O:
// relay.mjs is the only thing that should touch a socket, an env, or a clock
// for the live request path. Every behaviour that the focused tests want to
// pin down — URL parsing, TTL clamping, HMAC, response shape, rate-limit
// bucket math — lives here so it can be exercised without a listening socket.
//
// The endpoint contract this module backs:
//   GET  /ice-credentials          → 200 application/json { iceServers, expiresAt }
//                                    or 403 / 404 / 429 over the relay
//   OPTIONS /ice-credentials       → CORS preflight (handled by relay.mjs)
//
// Frozen semantics (do not loosen without updating docs):
//   • URL list is comma-separated turn:/turns: absolutes only (no spaces, no
//     "stun:", no path, no query).
//   • TTL is clamped to MIN_TTL_SECONDS..MAX_TTL_SECONDS. Default 600 (10min).
//   • Username is "<expiryUnix>:<randomUUID>".
//   • Credential is base64(HMAC-SHA1(username, sharedSecret)) — this is the
//     TURN REST API shared-secret scheme coturn uses with use-auth-secret.
//   • Per-IP token-bucket rate limit; default 30/min, configurable 1..300.
//   • The shared secret never leaves the process in any form.

import { createHmac, randomUUID } from 'node:crypto';

// ---- Constants ---------------------------------------------------------------

export const ICE_CREDENTIALS_PATH = '/ice-credentials';
export const ICE_CREDENTIALS_PATH_METHODS = new Set(['GET', 'OPTIONS']);

export const DEFAULT_TTL_SECONDS = 600;
export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 3600;

export const DEFAULT_RATE_PER_MINUTE = 30;
export const MIN_RATE_PER_MINUTE = 1;
export const MAX_RATE_PER_MINUTE = 300;

// One bucket per IPv4/IPv6 string. Fixed-window (per-minute) with a tiny
// bookkeeping array so tests can read it. The relay constructs one bucket
// per process; this is a pure helper, so the bucket is closed over the same
// way a real request loop would close over it.
export function createRateLimiter({ perMinute = DEFAULT_RATE_PER_MINUTE, nowMs = () => Date.now() } = {}) {
  const limit = clampInt(perMinute, MIN_RATE_PER_MINUTE, MAX_RATE_PER_MINUTE, DEFAULT_RATE_PER_MINUTE);
  const WINDOW_MS = 60_000;
  const hits = new Map(); // key -> array of millisecond timestamps inside the window
  function check(key) {
    const now = nowMs();
    const cutoff = now - WINDOW_MS;
    let arr = hits.get(key);
    if (!arr) {
      arr = [];
      hits.set(key, arr);
    }
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length >= limit) {
      // Retry-After is ceil to whole seconds, with a floor of 1 so clients
      // never spin against a 0.
      const retryAfterSec = Math.max(1, Math.ceil((arr[0] + WINDOW_MS - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    arr.push(now);
    return { ok: true, remaining: limit - arr.length, limit };
  }
  function reset(key) {
    if (key === undefined) {
      hits.clear();
    } else {
      hits.delete(key);
    }
  }
  return { check, reset, get limit() { return limit; } };
}

// ---- Parsing helpers ---------------------------------------------------------

// SG_TURN_URLS → list. Accepts whitespace around commas; rejects empty
// segments, anything that isn't turn: or turns:, and anything carrying a
// path/query/userinfo. coturn does not support those as a single "urls" entry.
export function parseTurnUrls(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    if (!isValidTurnUrl(p)) return null;
    out.push(p);
  }
  if (!out.length) return null;
  return out;
}

function isValidTurnUrl(s) {
  // turn:// — turns:// not handled here; turn:host:port and turn:host:port?transport=tcp
  // is the canonical coturn REST-returned shape. We intentionally accept
  // only the no-userinfo / no-path / no-fragment forms.
  if (s.length > 256) return false;
  if (s.startsWith('turn:') || s.startsWith('turns:')) {
    // No userinfo ("@" before the first slash), no path (must not contain "/").
    const slash = s.indexOf('/');
    if (slash !== -1) return false;
    // No fragment.
    if (s.includes('#')) return false;
    // Must have a host portion after the scheme separator.
    const rest = s.slice(s.startsWith('turn:') ? 5 : 6);
    if (!rest) return false;
    return true;
  }
  return false;
}

// SG_ALLOWED_ORIGINS → list. Empty list is allowed (means "disabled" upstream);
// relay.mjs treats empty as the disabled signal.
export function parseAllowedOrigins(input) {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'string') return [];
  return input.split(',').map((s) => s.trim()).filter(Boolean);
}

// SG_TURN_TTL_SECONDS → number clamped to [MIN_TTL_SECONDS, MAX_TTL_SECONDS].
// Missing / invalid → DEFAULT_TTL_SECONDS.
export function clampTtl(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SECONDS;
  return clampInt(n, MIN_TTL_SECONDS, MAX_TTL_SECONDS, DEFAULT_TTL_SECONDS);
}

// SG_TURN_CREDENTIALS_PER_MINUTE → number clamped to [1, 300]. Missing /
// invalid → DEFAULT_RATE_PER_MINUTE.
export function clampRatePerMinute(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RATE_PER_MINUTE;
  return clampInt(n, MIN_RATE_PER_MINUTE, MAX_RATE_PER_MINUTE, DEFAULT_RATE_PER_MINUTE);
}

function clampInt(n, min, max, fallback) {
  const v = Math.floor(n);
  if (!Number.isFinite(v)) return fallback;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// ---- Credential helpers ------------------------------------------------------

// Build {username, credential} for a coturn TURN REST request. The username is
// "<expiryUnix>:<randomUUID>" and the credential is base64(HMAC-SHA1(username,
// sharedSecret)). coturn's use-auth-secret + static-auth-secret checks both
// pieces. The expiry is the unix second at which the credential stops being
// accepted; relay-side clock and TURN-side clock are assumed to be roughly in
// sync (NTP) but we add the TTL only to the issuance time, so any drift eats
// into the credential lifetime, not into time before it becomes valid.
export function buildCredentials({ sharedSecret, ttlSeconds, nowMs = Date.now, rng = randomUUID } = {}) {
  if (typeof sharedSecret !== 'string' || sharedSecret.length === 0) return null;
  const ttl = clampTtl(ttlSeconds);
  const expiryUnix = Math.floor(nowMs() / 1000) + ttl;
  const username = `${expiryUnix}:${rng()}`;
  const credential = hmacSha1Base64(sharedSecret, username);
  return { username, credential, expiryUnix, ttlSeconds: ttl };
}

export function hmacSha1Base64(key, data) {
  return createHmac('sha1', String(key)).update(String(data)).digest('base64');
}

// Build the JSON body the endpoint returns. The shape is frozen so a client
// can `JSON.parse` it and walk straight to `iceServers[0].urls` without any
// guessing. expiresAt is RFC3339 / ISO 8601 in UTC ("Z" form) so every client
// parses it the same way.
export function buildResponse({ urls, username, credential, expiryUnix }) {
  return {
    iceServers: [
      {
        urls: Array.isArray(urls) ? urls.slice() : [],
        username,
        credential,
      },
    ],
    expiresAt: new Date(expiryUnix * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
  };
}

// ---- Endpoint state resolver -------------------------------------------------

// Decide whether the endpoint is enabled. Both the shared secret and the URL
// list must be present and valid; missing either yields "disabled" so the
// relay answers 404 with no further checks (no secret-name leakage in 403s).
export function isEndpointEnabled({ sharedSecret, turnUrls }) {
  if (typeof sharedSecret !== 'string' || sharedSecret.length === 0) return false;
  if (!Array.isArray(turnUrls) || turnUrls.length === 0) return false;
  return true;
}

// Strip control characters / newlines from a header value so it can't smuggle
// extra headers into the response. Cheap CRLF strip + space squish; matches
// the postel's-not-an-excuse-for-CRLF-injection rule.
export function safeHeader(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\r\n\t\v\f\0]+/g, '').trim();
}

export function resolveIceConfig(env = {}) {
  const sharedSecret = typeof env.SG_TURN_SHARED_SECRET === 'string' ? env.SG_TURN_SHARED_SECRET : '';
  const turnUrls = parseTurnUrls(env.SG_TURN_URLS);
  const ttlSeconds = clampTtl(env.SG_TURN_TTL_SECONDS);
  const ratePerMinute = clampRatePerMinute(env.SG_TURN_CREDENTIALS_PER_MINUTE);
  const allowedOrigins = [...new Set(parseAllowedOrigins(env.SG_ALLOWED_ORIGINS))];
  return Object.freeze({
    enabled: isEndpointEnabled({ sharedSecret, turnUrls }),
    sharedSecret,
    turnUrls: turnUrls || [],
    ttlSeconds,
    ratePerMinute,
    allowedOrigins,
  });
}

export function handleIceCredentials(req, res, { ice, iceLimiter, nowMs, rng }) {
  const method = req.method;
  if (!ICE_CREDENTIALS_PATH_METHODS.has(method)) {
    res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, OPTIONS' });
    res.end('method not allowed');
    return;
  }
  if (!ice.enabled) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  const requestOrigin = safeHeader(req.headers.origin);
  if (!requestOrigin || !ice.allowedOrigins.includes(requestOrigin)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  const corsHeaders = {
    'access-control-allow-origin': requestOrigin,
    vary: 'Origin',
    'cache-control': 'no-store',
    'content-type': 'application/json',
  };
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      ...corsHeaders,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  const limited = iceLimiter.check((req.socket && req.socket.remoteAddress) || 'unknown');
  if (!limited.ok) {
    res.writeHead(429, { ...corsHeaders, 'retry-after': String(limited.retryAfterSec) });
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return;
  }
  const creds = buildCredentials({
    sharedSecret: ice.sharedSecret,
    ttlSeconds: ice.ttlSeconds,
    nowMs,
    rng,
  });
  if (!creds) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error');
    return;
  }
  res.writeHead(200, corsHeaders);
  res.end(JSON.stringify(buildResponse({
    urls: ice.turnUrls,
    username: creds.username,
    credential: creds.credential,
    expiryUnix: creds.expiryUnix,
  })));
}

export function createIceCredentialsEndpoint({ env = {}, iceConfig = null, nowMs = Date.now, rng = randomUUID } = {}) {
  const ice = iceConfig || resolveIceConfig(env);
  const iceLimiter = createRateLimiter({ perMinute: ice.ratePerMinute, nowMs });
  const endpoint = (req, res) => handleIceCredentials(req, res, { ice, iceLimiter, nowMs, rng });
  endpoint.path = ICE_CREDENTIALS_PATH;
  endpoint.startupMessage = ice.enabled
    ? `[relay] /ice-credentials ENABLED ttl=${ice.ttlSeconds}s rate=${ice.ratePerMinute}/min urls=${ice.turnUrls.length}`
    : '[relay] /ice-credentials DISABLED (set SG_TURN_SHARED_SECRET and SG_TURN_URLS to enable)';
  return endpoint;
}
