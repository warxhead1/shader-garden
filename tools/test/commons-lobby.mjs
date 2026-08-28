// Shader Garden — /play lobby acceptance tests.
// Usage: node tools/test/commons-lobby.mjs   (first: npm ci in tools/test)
//
// The lobby exists because multiplayer was reachable only by hand-typing
// `#/garden/<room>`. These checks pin the two halves of that fix:
//
//   (a) /play renders a room you can name, a link you can send, and the
//       normalization that makes a typed name and its URL agree.
//   (b) The room itself offers the invite link, and — the regression that
//       would matter most — the SOLO garden still does not. The invite button
//       lives inside index.js's `if (room)` gate; a refactor that floats it
//       out would put MP DOM on the solo route and quietly break I3's
//       neighbours. mp-solo-parity.mjs pins the three original MP classes by
//       name, so it would NOT catch a newly-added fourth one. This does.
//
// This suite runs on the localhost dev path, where resolveTransportConfig
// returns a `ws://127.0.0.1:8787` relay whether or not anything is listening
// — that is exactly the branch the lobby's "multiplayer is available" UI is
// gated on, so no relay process is needed to test the lobby itself.
//
// Prints "all-PASS" and exits 0 only if every check passed.
import { launch, serveSite, gotoSafe } from './browser.mjs';

const { server, base: BASE } = await serveSite();
const browser = await launch();

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

async function freshPage(errors) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return page;
}

// ---- (a) the lobby ---------------------------------------------------------
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/play', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.commons-card', { timeout: 10000 });

  const hasRoomUi = await page.evaluate(() => !!document.querySelector('#commons-room'));
  check('(a) the lobby offers a room control on a host with a relay', hasRoomUi);

  const suggested = await page.$eval('#commons-room', (n) => n.value);
  check('(a) it pre-fills a memorable, URL-clean room name',
    /^[a-z]+-[a-z]+-\d{2}$/.test(suggested), suggested);

  const link = await page.$eval('.commons-link', (n) => n.textContent);
  check('(a) the invite link addresses the suggested room',
    link.endsWith('#/garden/' + suggested) && link.startsWith('http'), link);

  // The link must carry the deploy's own base, so it still works when the
  // site is served from a Pages SUBPATH rather than a domain root.
  check('(a) the invite link keeps the deploy base path (survives a Pages subpath)',
    link === BASE + '/index.html#/garden/' + suggested, link);

  await page.click('.commons-shuffle');
  const reshuffled = await page.$eval('#commons-room', (n) => n.value);
  check('(a) "Suggest another" proposes a different room', reshuffled !== suggested,
    `${suggested} -> ${reshuffled}`);

  // Normalization: what you type and what the link carries must agree, and
  // the UI has to SAY so when it changed your input.
  await page.$eval('#commons-room', (n) => { n.value = ''; });
  await page.type('#commons-room', 'My Room!! 2');
  const normalized = await page.evaluate(() => ({
    link: document.querySelector('.commons-link').textContent,
    warn: document.querySelector('.commons-warn').textContent,
    href: document.querySelector('.commons-open').getAttribute('href'),
  }));
  check('(a) a typed name is normalized into the link',
    normalized.link.endsWith('#/garden/my-room-2'), normalized.link);
  check('(a) the open button targets the normalized room',
    normalized.href === '#/garden/my-room-2', normalized.href);
  check('(a) the UI says so when it tidied the typed name',
    /my-room-2/.test(normalized.warn), normalized.warn);

  // An unusable name must not offer a room to open.
  await page.$eval('#commons-room', (n) => { n.value = ''; });
  await page.type('#commons-room', '!!!');
  const empty = await page.evaluate(() => ({
    href: document.querySelector('.commons-open').getAttribute('href'),
    disabled: document.querySelector('.commons-open').classList.contains('is-disabled'),
    copy: document.querySelector('.commons-copy').disabled,
  }));
  check('(a) a name that normalizes to nothing opens no room',
    empty.href === null && empty.disabled && empty.copy, JSON.stringify(empty));

  check('(a) no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ---- (b) lobby -> room, and the invite control inside it -------------------
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/play', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.commons-open', { timeout: 10000 });
  const room = await page.$eval('#commons-room', (n) => n.value);

  await page.click('.commons-open');
  await page.waitForSelector('.garden-mp-room', { timeout: 20000 });
  const badge = await page.$eval('.garden-mp-room', (n) => n.textContent);
  check('(b) opening the room lands in that room', badge === 'room ' + room, badge);

  const hasInvite = await page.waitForSelector('.garden-invite-btn', { timeout: 8000 })
    .then(() => true).catch(() => false);
  check('(b) the room offers an invite link to send', hasInvite);
  await page.close();
}

// ---- (c) the solo route stays free of the invite control -------------------
{
  const errors = [];
  const page = await freshPage(errors);
  await gotoSafe(page, BASE + '/index.html#/garden', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('canvas.garden-canvas', { timeout: 20000 });
  const soloInvite = await page.evaluate(() => !!document.querySelector('.garden-invite-btn'));
  check('(c) no invite control on the solo route (it stays inside the room gate)', !soloInvite);
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
