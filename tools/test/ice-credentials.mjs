// Shader Garden — tools/test/ice-credentials.mjs
// Focused tests for the GET /ice-credentials endpoint. Two layers:
//   1. Pure helpers in server/ice-credentials.mjs — URL parsing, TTL clamp,
//      HMAC computation, response shaping, rate-limit bucket math.
//   2. The handler in server/relay.mjs (handleIceCredentials) driven with a
//      fake (req, res) so we can pin the full request → response contract
//      (status codes, CORS headers, no-store, origin gating, 429 Retry-After,
//      no secret leakage) without binding a real socket.
//
// Run from repo root:  node --test tools/test/ice-credentials.mjs
//   (or via tools/test/package.json — node:test auto-discovers *.test.mjs
//   patterns; this file matches that prefix-free pattern by being run
//   directly with --test, which the harness already does for mp-protocol).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRelay } from '../../server/relay.mjs';
import {
  ICE_CREDENTIALS_PATH,
  handleIceCredentials,
  resolveIceConfig,
  parseTurnUrls,
  parseAllowedOrigins,
  clampTtl,
  clampRatePerMinute,
  buildCredentials,
  buildResponse,
  createRateLimiter,
  isEndpointEnabled,
  safeHeader,
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  DEFAULT_RATE_PER_MINUTE,
  MIN_RATE_PER_MINUTE,
  MAX_RATE_PER_MINUTE,
} from '../../server/ice-credentials.mjs';
import { createHmac } from 'node:crypto';

// ---- Pure helpers -----------------------------------------------------------

test('parseTurnUrls accepts comma-separated turn:/turns: URLs', () => {
  assert.deepEqual(parseTurnUrls('turn:turn.example.org:3478'), ['turn:turn.example.org:3478']);
  assert.deepEqual(parseTurnUrls('turn:turn.example.org:3478,turns:turns.example.org:5349'), [
    'turn:turn.example.org:3478',
    'turns:turns.example.org:5349',
  ]);
  assert.deepEqual(parseTurnUrls(' turn:a , turns:b '), ['turn:a', 'turns:b']);
});

test('parseTurnUrls rejects empty / whitespace / non-turn URLs', () => {
  assert.equal(parseTurnUrls(''), null);
  assert.equal(parseTurnUrls('   '), null);
  assert.equal(parseTurnUrls('stun:stun.example.org:3478'), null);
  assert.equal(parseTurnUrls('turn:'), null); // empty host
  assert.equal(parseTurnUrls('turn:a/b'), null); // path not allowed
  assert.equal(parseTurnUrls('turn:a#frag'), null); // fragment not allowed
  assert.equal(parseTurnUrls('turn:a,stun:b'), null); // one bad entry poisons the list
  assert.equal(parseTurnUrls(42), null);
  assert.equal(parseTurnUrls(null), null);
});

test('parseAllowedOrigins splits comma list and trims whitespace', () => {
  assert.deepEqual(parseAllowedOrigins('https://a.example'), ['https://a.example']);
  assert.deepEqual(parseAllowedOrigins('https://a.example,https://b.example'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseAllowedOrigins(' https://a , https://b ,'), ['https://a', 'https://b']);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

test('clampTtl bounds to [60, 3600] with default 600', () => {
  assert.equal(clampTtl(undefined), DEFAULT_TTL_SECONDS);
  assert.equal(clampTtl('600'), 600);
  assert.equal(clampTtl(600), 600);
  assert.equal(clampTtl(60), MIN_TTL_SECONDS);
  assert.equal(clampTtl(3600), MAX_TTL_SECONDS);
  assert.equal(clampTtl(59), MIN_TTL_SECONDS); // floor
  assert.equal(clampTtl(3601), MAX_TTL_SECONDS); // ceiling
  assert.equal(clampTtl(-1), DEFAULT_TTL_SECONDS); // invalid → default
  assert.equal(clampTtl('not-a-number'), DEFAULT_TTL_SECONDS);
  assert.equal(clampTtl(0), DEFAULT_TTL_SECONDS);
});

test('clampRatePerMinute bounds to [1, 300] with default 30', () => {
  assert.equal(clampRatePerMinute(undefined), DEFAULT_RATE_PER_MINUTE);
  assert.equal(clampRatePerMinute(30), 30);
  assert.equal(clampRatePerMinute(1), MIN_RATE_PER_MINUTE);
  assert.equal(clampRatePerMinute(300), MAX_RATE_PER_MINUTE);
  assert.equal(clampRatePerMinute(0), DEFAULT_RATE_PER_MINUTE);
  assert.equal(clampRatePerMinute(999), MAX_RATE_PER_MINUTE);
  assert.equal(clampRatePerMinute(-5), DEFAULT_RATE_PER_MINUTE);
});

test('isEndpointEnabled requires both secret and urls', () => {
  assert.equal(isEndpointEnabled({ sharedSecret: '', turnUrls: ['turn:a'] }), false);
  assert.equal(isEndpointEnabled({ sharedSecret: 'k', turnUrls: null }), false);
  assert.equal(isEndpointEnabled({ sharedSecret: 'k', turnUrls: [] }), false);
  assert.equal(isEndpointEnabled({ sharedSecret: 'k', turnUrls: ['turn:a'] }), true);
});

test('buildCredentials produces username "<expiryUnix>:<uuid>" + base64 HMAC-SHA1', () => {
  const secret = 'super-secret-shared-key';
  // Pin the clock so expiryUnix is predictable.
  const nowMs = () => 1_700_000_000_000;
  const rng = () => 'fixed-uuid-1234-5678-9abc-def012345678';
  const c = buildCredentials({ sharedSecret: secret, ttlSeconds: 600, nowMs, rng });
  assert.ok(c);
  assert.equal(c.expiryUnix, 1_700_000_000 + 600);
  assert.equal(c.username, `1700000600:fixed-uuid-1234-5678-9abc-def012345678`);
  const expected = createHmac('sha1', secret).update(c.username).digest('base64');
  assert.equal(c.credential, expected);
  assert.equal(c.ttlSeconds, 600);
});

test('buildCredentials credentials differ per call (randomUUID randomness)', () => {
  let n = 0;
  const rng = () => 'uuid-' + (++n);
  const c1 = buildCredentials({ sharedSecret: 'k', ttlSeconds: 600, nowMs: () => 0, rng });
  const c2 = buildCredentials({ sharedSecret: 'k', ttlSeconds: 600, nowMs: () => 0, rng });
  assert.notEqual(c1.username, c2.username);
  assert.notEqual(c1.credential, c2.credential);
});

test('buildCredentials returns null on empty secret', () => {
  assert.equal(buildCredentials({ sharedSecret: '', ttlSeconds: 600, nowMs: () => 0, rng: () => 'u' }), null);
});

test('buildCredentials TTL is clamped even if a too-large value is passed', () => {
  const c = buildCredentials({ sharedSecret: 'k', ttlSeconds: 99999, nowMs: () => 0, rng: () => 'u' });
  assert.equal(c.ttlSeconds, MAX_TTL_SECONDS);
  assert.equal(c.expiryUnix, MAX_TTL_SECONDS); // ttl=3600 + now=0
});

test('buildResponse shape is the frozen JSON contract', () => {
  const r = buildResponse({
    urls: ['turn:a:3478', 'turns:b:5349'],
    username: '1700000000:fixed',
    credential: 'credbase64',
    expiryUnix: 1700000000,
  });
  assert.deepEqual(r, {
    iceServers: [
      { urls: ['turn:a:3478', 'turns:b:5349'], username: '1700000000:fixed', credential: 'credbase64' },
    ],
    expiresAt: '2023-11-14T22:13:20Z',
  });
});

test('safeHeader strips CRLF and control chars so header injection is impossible', () => {
  assert.equal(safeHeader('https://a.example'), 'https://a.example');
  assert.equal(safeHeader('a\r\nX-Evil: 1'), 'aX-Evil: 1');
  assert.equal(safeHeader('a\nb'), 'ab');
  assert.equal(safeHeader('a\x00b'), 'ab');
});

test('rate limiter allows up to N hits in the window then 429s with Retry-After', () => {
  let now = 1_000_000;
  const nowMs = () => now;
  const rl = createRateLimiter({ perMinute: 3, nowMs });
  assert.equal(rl.limit, 3);
  assert.deepEqual(rl.check('1.2.3.4'), { ok: true, remaining: 2, limit: 3 });
  assert.deepEqual(rl.check('1.2.3.4'), { ok: true, remaining: 1, limit: 3 });
  assert.deepEqual(rl.check('1.2.3.4'), { ok: true, remaining: 0, limit: 3 });
  const blocked = rl.check('1.2.3.4');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
  // Different IP gets its own bucket.
  assert.deepEqual(rl.check('5.6.7.8'), { ok: true, remaining: 2, limit: 3 });
  // Advance time past the window → bucket refills.
  now += 61_000;
  assert.deepEqual(rl.check('1.2.3.4'), { ok: true, remaining: 2, limit: 3 });
});

// ---- Handler-level tests (fake req/res) ------------------------------------

function makeReq({ method = 'GET', url = ICE_CREDENTIALS_PATH, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (origin !== undefined) h.origin = origin;
  return { method, url, headers: h, socket: { remoteAddress: '10.0.0.1' } };
}

function makeRes() {
  const res = {
    _status: 200,
    _headers: {},
    body: '',
    writeHead(status, headers) {
      this._status = status;
      this._headers = headers;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      return this;
    },
  };
  return res;
}

function callHandler({ req, ice, iceLimiter, nowMs = () => 0, rng = () => 'fixed-uuid' } = {}) {
  const res = makeRes();
  handleIceCredentials(req, res, { ice, iceLimiter, nowMs, rng });
  return res;
}

function makeIce(overrides = {}) {
  const base = {
    enabled: true,
    sharedSecret: 'shared-secret-A',
    turnUrls: ['turn:turn.example.org:3478'],
    ttlSeconds: 600,
    ratePerMinute: 30,
    allowedOrigins: ['https://app.example'],
  };
  return { ...base, ...overrides };
}

test('disabled endpoint (no secret) returns 404 with no CORS headers', () => {
  const ice = makeIce({ enabled: false, sharedSecret: '' });
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 0 });
  const res = callHandler({ req: makeReq({ origin: 'https://app.example' }), ice, iceLimiter: rl });
  assert.equal(res._status, 404);
  assert.equal(res._headers['access-control-allow-origin'], undefined);
  assert.equal(res._headers['vary'], undefined);
});

test('disabled endpoint (invalid urls) returns 404', () => {
  const ice = makeIce({ enabled: false, turnUrls: [] });
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 0 });
  const res = callHandler({ req: makeReq({ origin: 'https://app.example' }), ice, iceLimiter: rl });
  assert.equal(res._status, 404);
});

test('valid origin gets 200 with exact ACAO, Vary: Origin, no-store, json content-type', () => {
  const ice = makeIce();
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 1_700_000_000_000 });
  const res = callHandler({
    req: makeReq({ origin: 'https://app.example' }),
    ice,
    iceLimiter: rl,
    nowMs: () => 1_700_000_000_000,
    // UUID-shaped string so the regex check below is exercising real input.
    rng: () => 'abcdef01-2345-6789-abcd-ef0123456789',
  });
  assert.equal(res._status, 200);
  assert.equal(res._headers['access-control-allow-origin'], 'https://app.example');
  assert.equal(res._headers.vary, 'Origin');
  assert.equal(res._headers['cache-control'], 'no-store');
  assert.equal(res._headers['content-type'], 'application/json');
  const body = JSON.parse(res.body);
  assert.equal(body.iceServers.length, 1);
  assert.deepEqual(body.iceServers[0].urls, ['turn:turn.example.org:3478']);
  assert.match(body.iceServers[0].username, /^\d+:[0-9a-f-]+$/);
  // Credential is base64(HMAC-SHA1) → exactly 28 chars
  assert.match(body.iceServers[0].credential, /^[A-Za-z0-9+/=]{27,28}$/);
  assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('missing origin gets 403', () => {
  const ice = makeIce();
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 0 });
  const res = callHandler({ req: makeReq({}), ice, iceLimiter: rl });
  assert.equal(res._status, 403);
  assert.equal(res._headers['access-control-allow-origin'], undefined);
});

test('wrong origin gets 403 and never echoes the request origin', () => {
  const ice = makeIce();
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 0 });
  const res = callHandler({ req: makeReq({ origin: 'https://evil.example' }), ice, iceLimiter: rl });
  assert.equal(res._status, 403);
  assert.equal(res._headers['access-control-allow-origin'], undefined);
});

test('OPTIONS preflight returns 204 with GET/OPTIONS methods and the matched origin', () => {
  const ice = makeIce();
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 0 });
  const res = callHandler({
    req: makeReq({ method: 'OPTIONS', origin: 'https://app.example' }),
    ice,
    iceLimiter: rl,
  });
  assert.equal(res._status, 204);
  assert.equal(res._headers['access-control-allow-origin'], 'https://app.example');
  assert.equal(res._headers.vary, 'Origin');
  assert.equal(res._headers['access-control-allow-methods'], 'GET, OPTIONS');
  assert.equal(res._headers['cache-control'], 'no-store');
});

test('OPTIONS to wrong origin is 403 with no ACAO', () => {
  const ice = makeIce();
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 0 });
  const res = callHandler({
    req: makeReq({ method: 'OPTIONS', origin: 'https://evil.example' }),
    ice,
    iceLimiter: rl,
  });
  assert.equal(res._status, 403);
  assert.equal(res._headers['access-control-allow-origin'], undefined);
});

test('non-GET non-OPTIONS method is 405 with Allow header', () => {
  const ice = makeIce();
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 0 });
  const res = callHandler({
    req: makeReq({ method: 'POST', origin: 'https://app.example' }),
    ice,
    iceLimiter: rl,
  });
  assert.equal(res._status, 405);
  assert.equal(res._headers.allow, 'GET, OPTIONS');
});

test('GET over the rate limit returns 429 with Retry-After and CORS headers', () => {
  const ice = makeIce({ ratePerMinute: 2 });
  const rl = createRateLimiter({ perMinute: 2, nowMs: () => 1_700_000_000_000 });
  // Burn the budget.
  callHandler({ req: makeReq({ origin: 'https://app.example' }), ice, iceLimiter: rl, nowMs: () => 1_700_000_000_000 });
  callHandler({ req: makeReq({ origin: 'https://app.example' }), ice, iceLimiter: rl, nowMs: () => 1_700_000_000_000 });
  const res = callHandler({ req: makeReq({ origin: 'https://app.example' }), ice, iceLimiter: rl, nowMs: () => 1_700_000_000_000 });
  assert.equal(res._status, 429);
  assert.equal(res._headers['retry-after'], String(res._headers['retry-after']));
  assert.ok(Number(res._headers['retry-after']) >= 1);
  assert.equal(res._headers['access-control-allow-origin'], 'https://app.example');
  assert.equal(res._headers.vary, 'Origin');
});

test('the response body and headers NEVER contain the shared secret', () => {
  const secret = 'very-confidential-shared-secret-XXXXXXXXXXXXXXXXXXXX';
  const ice = makeIce({ sharedSecret: secret });
  const rl = createRateLimiter({ perMinute: 30, nowMs: () => 0 });
  const res = callHandler({
    req: makeReq({ origin: 'https://app.example' }),
    ice,
    iceLimiter: rl,
  });
  // Body
  assert.equal(res.body.includes(secret), false, 'secret leaked in response body');
  // Headers (key-by-key check is robust against lower-casing by node:http).
  for (const v of Object.values(res._headers)) {
    assert.equal(typeof v === 'string' && v.includes(secret), false, 'secret leaked in response headers');
  }
  // 404 / 403 / 405 responses must also not leak the secret.
  const r404 = callHandler({
    req: makeReq({ origin: 'https://app.example' }),
    ice: makeIce({ enabled: false, sharedSecret: secret }),
    iceLimiter: rl,
  });
  assert.equal(r404.body.includes(secret), false);
  for (const v of Object.values(r404._headers)) {
    assert.equal(typeof v === 'string' && v.includes(secret), false);
  }
  const r403 = callHandler({
    req: makeReq({ origin: 'https://evil.example' }),
    ice: makeIce({ sharedSecret: secret }),
    iceLimiter: rl,
  });
  assert.equal(r403.body.includes(secret), false);
  for (const v of Object.values(r403._headers)) {
    assert.equal(typeof v === 'string' && v.includes(secret), false);
  }
});

test('resolveIceConfig parses env into the frozen ice config', () => {
  const ice = resolveIceConfig({
    SG_TURN_SHARED_SECRET: 'k',
    SG_TURN_URLS: 'turn:a:3478,turns:b:5349',
    SG_ALLOWED_ORIGINS: 'https://x.example,https://y.example',
    SG_TURN_TTL_SECONDS: '900',
    SG_TURN_CREDENTIALS_PER_MINUTE: '50',
  });
  assert.equal(ice.enabled, true);
  assert.equal(ice.sharedSecret, 'k');
  assert.deepEqual(ice.turnUrls, ['turn:a:3478', 'turns:b:5349']);
  assert.deepEqual(ice.allowedOrigins, ['https://x.example', 'https://y.example']);
  assert.equal(ice.ttlSeconds, 900);
  assert.equal(ice.ratePerMinute, 50);
  // Frozen so callers can't mutate after boot.
  assert.equal(Object.isFrozen(ice), true);
});

test('resolveIceConfig disables when secret missing or urls invalid', () => {
  assert.equal(resolveIceConfig({}).enabled, false);
  assert.equal(resolveIceConfig({ SG_TURN_SHARED_SECRET: 'k' }).enabled, false);
  assert.equal(resolveIceConfig({ SG_TURN_URLS: 'stun:a' }).enabled, false);
  assert.equal(resolveIceConfig({ SG_TURN_SHARED_SECRET: 'k', SG_TURN_URLS: 'turn:a:3478' }).enabled, true);
});

test('resolveIceConfig clamps TTL and rate even when out of range', () => {
  const ice = resolveIceConfig({
    SG_TURN_SHARED_SECRET: 'k',
    SG_TURN_URLS: 'turn:a:3478',
    SG_TURN_TTL_SECONDS: '999999',
    SG_TURN_CREDENTIALS_PER_MINUTE: '99999',
  });
  assert.equal(ice.ttlSeconds, MAX_TTL_SECONDS);
  assert.equal(ice.ratePerMinute, MAX_RATE_PER_MINUTE);
});

// ---- Live socket smoke (proves startRelay wires the route correctly) -------

test('startRelay mounts GET /ice-credentials and answers the frozen contract end-to-end', async () => {
  const env = {
    SG_TURN_SHARED_SECRET: 'live-test-secret',
    SG_TURN_URLS: 'turn:turn.example.org:3478',
    SG_ALLOWED_ORIGINS: 'https://app.example',
    SG_TURN_TTL_SECONDS: '300',
    SG_TURN_CREDENTIALS_PER_MINUTE: '60',
  };
  const port = 9100 + (process.pid % 500);
  const { server, close } = startRelay({ port, host: '127.0.0.1', env, nowMs: () => 1_700_000_000_000 });
  await new Promise((r) => server.on('listening', r));
  try {
    const got = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: 'GET',
          host: '127.0.0.1',
          port,
          path: '/ice-credentials',
          headers: { origin: 'https://app.example' },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(got.status, 200);
    assert.equal(got.headers['access-control-allow-origin'], 'https://app.example');
    assert.equal(got.headers.vary, 'Origin');
    assert.equal(got.headers['cache-control'], 'no-store');
    const body = JSON.parse(got.body);
    assert.deepEqual(body.iceServers[0].urls, ['turn:turn.example.org:3478']);
    // Credential is independently verifiable: base64(HMAC-SHA1).
    const expected = createHmac('sha1', 'live-test-secret').update(body.iceServers[0].username).digest('base64');
    assert.equal(body.iceServers[0].credential, expected);
    assert.equal(body.expiresAt, new Date((1_700_000_000 + 300) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'));

    // Wrong origin → 403 over the live socket too.
    const blocked = await new Promise((resolve, reject) => {
      const req = http.request(
        { method: 'GET', host: '127.0.0.1', port, path: '/ice-credentials', headers: { origin: 'https://evil.example' } },
        (res) => resolve(res.statusCode)
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(blocked, 403);
  } finally {
    // server.close() waits for keep-alive sockets; the test's http.request
    // may have left one idle. Race the close against a short timer so a
    // stuck socket can't hang the test runner — clearInterval in close()
    // has already stopped the relay's tick, so the process can exit cleanly
    // even if the listener never gets its final cb.
    await Promise.race([
      new Promise((r) => close(r)),
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }
});
