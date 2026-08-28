// Shader Garden — multiplayer/ice-credentials.js
// SG-MM-ICE-VENDING (spec §2.7): provider-neutral runtime fetching of
// short-lived WebRTC ICE/TURN credentials BEFORE RTCPeerConnection creation.
// `site/js/organs/garden/net.js`'s p2p path imports this module so the
// non-p2p transport and the solo test rig never pay the bundle cost. The
// validator is pure (no `window`, no module-level state) — every failure
// mode returns a short tag from the documented allowlist (the brief:
// "credentials NEVER appear in storage or logs — only short error tags").
//
// Public surface:
//   fetchIceCredentials({ url, fetchImpl, isHttps, hostname })
//     Pure validator. Returns
//       { ok: true, iceServers: RTCIceServer[] }            on success
//       { ok: false, error: <short-tag> }                   on failure
//
// Contract (spec §2.7; deploy brief):
//   - GET with cache:'no-store', credentials:'omit', Accept: application/json.
//     `omit` stops the browser from sending cookies to the vending host
//     across origins, so the endpoint stays callable without inheriting
//     session state.
//   - Production must be https. http is allowed ONLY on localhost for the
//     test rig; http on an https page is mixed-content fail-closed.
//   - Response must be ok; JSON object with non-empty `iceServers` array of
//     RTCIceServer-shaped entries. Per-entry `urls` is required
//     (non-empty string OR non-empty array of non-empty strings);
//     optional `username`/`credential` must be strings when present.
//   - Every failure mode is fail-closed when the URL was configured: a
//     malformed/empty response does NOT fall through to STUN-only dialing.
//     The caller (connectRoom) surfaces the tag and lets scheduleReconnect
//     back off.
//
// Failure-mode tags (the entire allowlist — `tools/test/mp-ice-credentials.mjs`
// pins this list):
//   no-url, bad-url, bad-protocol, http-not-localhost, mixed-content,
//   fetch-failed, bad-response, http-<status>, bad-json, not-object,
//   no-ice-servers, empty-ice-servers, bad-entry, bad-urls, empty-urls,
//   bad-username, bad-credential

/** Pure: fetch + validate a short-lived ICE/TURN credential document.
 *  Plain inputs (no `window`) so the validation logic is unit-testable;
 *  the caller passes `fetchImpl` from `globalThis.fetch` in production.
 *
 *  @param {object} opts
 *  @param {string} opts.url       The vending endpoint URL. Already
 *                                 validated by resolveTransportConfig
 *                                 to be a non-empty string when this is
 *                                 called — defensive re-check covers
 *                                 direct callers in tests.
 *  @param {Function} opts.fetchImpl  fetch-shaped function. The production
 *                                    caller passes window.fetch.bind(window)
 *                                    or globalThis.fetch.
 *  @param {boolean} [opts.isHttps]   Whether the page itself is served
 *                                    over https. Mixed-content gate.
 *  @param {string} [opts.hostname]   Page hostname; used for the
 *                                    http-localhost-only branch.
 *  @returns {Promise<
 *    { ok: true, iceServers: object[] }
 *    | { ok: false, error: string }
 *  >}
 */
export async function fetchIceCredentials({ url, fetchImpl, isHttps, hostname }) {
  // Defensive re-check: resolveTransportConfig only emits a non-empty
  // string here, but the helper is exported on its own and unit tests
  // hit it directly. No silent degradation — refuse the empty case.
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: 'no-url' };
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    return { ok: false, error: 'bad-url' };
  }
  // Production must be https. http is allowed on localhost for the test
  // rig ONLY — a production http URL would be silently downgraded by the
  // browser and the credentials would land on the wire in cleartext.
  if (parsed.protocol !== 'https:') {
    if (parsed.protocol === 'http:') {
      const host = parsed.hostname;
      if (host !== 'localhost' && host !== '127.0.0.1') {
        return { ok: false, error: 'http-not-localhost' };
      }
      // Localhost http on a non-https page is fine (dev only); on an
      // https page the browser blocks mixed content — refuse.
      if (isHttps) {
        return { ok: false, error: 'mixed-content' };
      }
    } else {
      return { ok: false, error: 'bad-protocol' };
    }
  }

  let response;
  try {
    response = await fetchImpl(url, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { ok: false, error: 'fetch-failed' };
  }
  if (!response || typeof response.ok !== 'boolean') {
    return { ok: false, error: 'bad-response' };
  }
  if (!response.ok) {
    return { ok: false, error: 'http-' + response.status };
  }

  let body;
  try { body = await response.json(); } catch {
    return { ok: false, error: 'bad-json' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'not-object' };
  }
  if (!Array.isArray(body.iceServers)) {
    return { ok: false, error: 'no-ice-servers' };
  }
  if (body.iceServers.length === 0) {
    return { ok: false, error: 'empty-ice-servers' };
  }
  const validated = [];
  for (const entry of body.iceServers) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'bad-entry' };
    }
    // urls: required, must be a non-empty string OR a non-empty array
    // of non-empty strings. WebRTC requires every entry to actually
    // point at something reachable — an empty array would never dial,
    // an empty string would parse as a relative URL.
    if (typeof entry.urls === 'string') {
      if (entry.urls.length === 0) {
        return { ok: false, error: 'empty-urls' };
      }
    } else if (Array.isArray(entry.urls)) {
      if (entry.urls.length === 0) {
        return { ok: false, error: 'empty-urls' };
      }
      for (const u of entry.urls) {
        if (typeof u !== 'string' || u.length === 0) {
          return { ok: false, error: 'bad-urls' };
        }
      }
    } else {
      return { ok: false, error: 'bad-urls' };
    }
    // username / credential are optional and, when present, must be
    // strings. We intentionally do NOT enforce non-emptiness — the spec
    // allows `username: ''` (e.g. for `stun:`-only entries that the
    // provider nevertheless emits with an empty `username`), and the
    // browser will reject any malformed TURN pair at dial time. The
    // important gate here is the type, not the content.
    if ('username' in entry && typeof entry.username !== 'string') {
      return { ok: false, error: 'bad-username' };
    }
    if ('credential' in entry && typeof entry.credential !== 'string') {
      return { ok: false, error: 'bad-credential' };
    }
    validated.push(entry);
  }

  return { ok: true, iceServers: validated };
}

/** Pure: public STUN (from relay.json's `iceServers`) FIRST, ephemeral
 *  TURN (from fetchIceCredentials) SECOND. WebRTC tries all candidates
 *  in parallel — the order only affects DevTools visibility, not
 *  connectivity. Exported so the connect-time merge contract is
 *  unit-testable without running the full connect path.
 *
 *  @param {object[]} publicServers  operator-deployed STUN entries
 *  @param {object[]} ephemeralServers  vendored TURN entries
 *  @returns {object[]}
 */
export function mergeIceServers(publicServers, ephemeralServers) {
  const pub = Array.isArray(publicServers) ? publicServers : [];
  const eph = Array.isArray(ephemeralServers) ? ephemeralServers : [];
  return pub.concat(eph);
}