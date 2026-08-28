// Shader Garden — organs/commons/index.js
// "/play" organ — the way INTO multiplayer.
//
// Until this existed, a shared garden was reachable only by typing
// `#/garden/<room>` by hand. That is not a discoverability nit, it is a
// structural gap: the room name is a route SEGMENT, so a room does not exist
// as a thing to link to until someone invents its name. There was no button
// that could have linked to one, and nothing anywhere in the UI said that
// inventing a name is how rooms get made. Multiplayer shipped, worked, and
// was invisible unless you had read DEPLOY.md §6.
//
// This organ is the missing step: name a room, open it, and — the part that
// actually matters — get a link you can send to the other household.
//
// Two deliberate choices:
//
// 1. Availability is answered by net.js's OWN `resolveTransportConfig`, not by
//    a second copy of the precedence rules here. The lobby's answer to "is
//    multiplayer on?" and the garden's answer to "what do I dial?" are then
//    the same computation, and cannot drift into a lobby that offers a room
//    the garden then refuses to connect to. This file is multiplayer UI, so
//    importing the multiplayer module is on-path — the invariant the garden's
//    index.js protects is that the SOLO route pulls in no net layer, and /play
//    is not the solo route. It is lazily route-mounted like every other organ,
//    so an idle boot still pays nothing.
//
// 2. The lobby states who hosts. The first member into a room is the immutable
//    host and host loss is fail-closed with no re-election (spec §Weekend P2P)
//    — so if the wrong person opens the room first, the round dies when they
//    close their tab. That is a decision the two players have to make BEFORE
//    they click, which makes it lobby copy, not a post-hoc error message.

import { el, clear } from '../../dom.js';
import { resolveTransportConfig, fetchTransportJsonDefault } from '../garden/net.js';

// Deliberately drawn from the garden's own vocabulary rather than a generic
// adjective/noun list — a room called `mossy-lantern` reads like this place.
const FIRST = ['mossy', 'quiet', 'amber', 'drifting', 'hollow', 'sunlit', 'salt', 'dim', 'folded', 'bright'];
const SECOND = ['fern', 'lantern', 'pond', 'ridge', 'sponge', 'thicket', 'stone', 'tide', 'lattice', 'grove'];

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

/** A memorable, URL-clean room name. The 2-digit tail keeps two households
 *  that independently reach for "mossy-fern" out of each other's round. */
export function suggestRoomName() {
  return `${pick(FIRST)}-${pick(SECOND)}-${10 + Math.floor(Math.random() * 90)}`;
}

/** UI-level tidying, NOT a protocol rule: the relay accepts any string of
 *  1..128 chars (relay.mjs's hello guard). We narrow to what survives a URL
 *  hash and a read-aloud over the phone, because a room name's whole job is
 *  to be transmitted between two people by voice or by link. */
export function normalizeRoomName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function inviteUrlFor(room) {
  // Hash routes, so everything before '#' is the deploy's own base — this is
  // correct on a Pages subpath and on a custom domain alike, with no config.
  return `${location.href.split('#')[0]}#/garden/${encodeURIComponent(room)}`;
}

export async function mount(ctx) {
  const root = ctx.root;
  clear(root);

  const wrap = el('div', 'commons-wrap');
  const head = el('header', 'commons-head');
  head.append(
    el('h1', 'commons-title', 'Play together'),
    el('p', 'commons-sub', 'Open a shared garden and send the link to a friend. You walk the same ground, and whoever holds the lectern can edit the world live.'),
  );
  wrap.append(head);

  const card = el('div', 'commons-card glass');
  wrap.append(card);
  root.append(wrap);

  // Ask the real resolver, exactly as the garden will when it dials.
  let cfg = null;
  let resolveError = null;
  try {
    cfg = await resolveTransportConfig({
      queryRelay: new URLSearchParams(location.search).get('relay'),
      queryTransport: new URLSearchParams(location.search).get('transport'),
      hostname: location.hostname,
      isHttps: location.protocol === 'https:',
      // resolveTransportConfig injects its fetcher rather than defaulting one
      // (that is what keeps it unit-testable), so pass connectRoom's own.
      fetchTransportJson: fetchTransportJsonDefault,
    });
  } catch (e) {
    // A malformed relay.json throws by design (spec §2.7 — a broken deploy is
    // never silently coerced to "single-player"). Say so; do not offer rooms.
    resolveError = String((e && e.message) || e);
  }
  if (!ctx.alive()) return () => {};

  if (resolveError || !cfg || !cfg.url) {
    card.append(el('h2', 'commons-card-title', resolveError ? 'Multiplayer is misconfigured' : 'This deploy is single-player'));
    card.append(el('p', 'commons-note', resolveError
      ? `The relay configuration could not be read, so no room would connect: ${resolveError}`
      : 'No relay is configured for this site, so there is nowhere for a second player to meet you. The garden itself works fully on your own.'));
    if (!resolveError) {
      card.append(el('p', 'commons-note muted', 'Running your own copy? DEPLOY.md §5 covers standing up a relay and pointing a deploy at it.'));
    }
    const solo = el('a', 'btn btn-primary', 'Walk the garden alone');
    solo.setAttribute('href', '#/garden');
    const soloActions = el('div', 'commons-actions');
    soloActions.append(solo);
    card.append(soloActions);
    return () => clear(root);
  }

  // ---- multiplayer is live ------------------------------------------------
  card.append(el('h2', 'commons-card-title', 'Name your room'));
  card.append(el('p', 'commons-note', 'Anyone with the name — or the link — walks into the same garden. Up to 8 people.'));

  const label = el('label', 'commons-label', 'Room name');
  label.setAttribute('for', 'commons-room');
  const input = el('input', 'commons-input');
  input.id = 'commons-room';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = suggestRoomName();
  input.setAttribute('aria-describedby', 'commons-link-row');

  const shuffle = el('button', 'btn btn-ghost commons-shuffle', 'Suggest another');
  shuffle.type = 'button';

  const nameRow = el('div', 'commons-row');
  nameRow.append(input, shuffle);
  card.append(label, nameRow);

  const linkRow = el('div', 'commons-link-row', null);
  linkRow.id = 'commons-link-row';
  const linkText = el('code', 'commons-link');
  const copyBtn = el('button', 'btn btn-ghost commons-copy', 'Copy invite link');
  copyBtn.type = 'button';
  linkRow.append(linkText, copyBtn);
  card.append(linkRow);

  const openBtn = el('a', 'btn btn-primary commons-open', 'Open the room');
  const actions = el('div', 'commons-actions');
  const soloLink = el('a', 'btn btn-ghost', 'Walk alone instead');
  soloLink.setAttribute('href', '#/garden');
  actions.append(openBtn, soloLink);
  card.append(actions);

  const warn = el('p', 'commons-warn');
  card.append(warn);

  // The host rule, stated before the click rather than after the failure.
  const hostNote = el('p', 'commons-note muted',
    'Whoever opens the room FIRST is its host for the whole round. If the host closes their tab the room ends for everyone — there is no hand-off — so let the person with the steadiest connection go first.');
  card.append(hostNote);

  let live = '';
  function sync() {
    const clean = normalizeRoomName(input.value);
    live = clean;
    const ok = clean.length > 0;
    linkText.textContent = ok ? inviteUrlFor(clean) : '—';
    copyBtn.disabled = !ok;
    openBtn.classList.toggle('is-disabled', !ok);
    if (ok) openBtn.setAttribute('href', `#/garden/${encodeURIComponent(clean)}`);
    else openBtn.removeAttribute('href');
    // Only nag when tidying actually CHANGED what they typed — silence when
    // the box already holds exactly what the link will carry.
    warn.textContent = ok && clean !== input.value.trim().toLowerCase()
      ? `Opening as “${clean}”.`
      : '';
  }

  const onInput = () => sync();
  const onShuffle = () => { input.value = suggestRoomName(); sync(); input.focus(); };
  const onKey = (e) => {
    if (e.key === 'Enter' && live) { e.preventDefault(); location.hash = `#/garden/${encodeURIComponent(live)}`; }
  };
  let copyTimer = 0;
  const onCopy = async () => {
    if (!live) return;
    const url = inviteUrlFor(live);
    let ok = false;
    try {
      // Only available on a secure context; a plain-http dev host has no
      // clipboard API at all, which is a normal state here, not an error.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch { /* fall through to the manual path */ }
    copyBtn.textContent = ok ? 'Copied' : 'Press ⌘/Ctrl+C';
    if (!ok) {
      // No clipboard: select the text so the keyboard shortcut works.
      const range = document.createRange();
      range.selectNodeContents(linkText);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy invite link'; }, 2000);
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  shuffle.addEventListener('click', onShuffle);
  copyBtn.addEventListener('click', onCopy);
  sync();

  return () => {
    clearTimeout(copyTimer);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKey);
    shuffle.removeEventListener('click', onShuffle);
    copyBtn.removeEventListener('click', onCopy);
    clear(root);
  };
}
