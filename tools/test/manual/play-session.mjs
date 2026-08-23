// Not a suite: a PLAYTHROUGH. Two real browsers join one room, start a round,
// move, and tag — capturing what a player actually sees at each phase.
import { mkdirSync } from 'node:fs';
import { launch, serveSite, sleep, gotoSafe, assertRealGpu, startRelayOnFreePort } from '../browser.mjs';

// Repo-relative by default so nothing here encodes one machine's home
// directory (preflight rejects that, and this is a public repo). Override
// with SG_SHOT_DIR to write somewhere else.
const SHOT = process.env.SG_SHOT_DIR || 'out/play';
mkdirSync(SHOT, { recursive: true });
const { relay, port: RELAY_PORT } = await startRelayOnFreePort({ offset: 940 });
const { server, base: BASE } = await serveSite();
const browser = await launch();
const room = 'playtest';
const url = (n) => `${BASE}/index.html?relay=${encodeURIComponent(`ws://127.0.0.1:${RELAY_PORT}/${room}`)}&name=${n}#/garden/${room}`;

const hud = (p) => p.evaluate(() => {
  const t = (s) => (document.querySelector(s)?.textContent || '').trim();
  return {
    phase: t('.garden-game-pill'), line: t('.garden-game-line'),
    roster: [...document.querySelectorAll('.garden-roster li, .garden-roster-row')].map(e => e.textContent.trim()),
    leaseLine: t('.garden-lease-line'),
    trayCollapsed: !!document.querySelector('.garden-tray-collapsed'),
    probeOpen: !!document.querySelector('.probe-panel'),
    lease: t('.garden-lease-btn'),
    fps: t('.garden-fps') || null,
  };
});

async function join(name) {
  const p = await browser.newPage();
  await gotoSafe(p, url(name), { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('canvas', { timeout: 20000 });
  await assertRealGpu(p);
  await sleep(2500);
  // MP-6: name yourself through the product's own control, not a URL param.
  await p.fill('.garden-name-input', name);
  await p.dispatchEvent('.garden-name-input', 'change');
  await sleep(800);
  return p;
}

const A = await join('Ada');
const B = await join('Baz');
await sleep(2000);
console.log('JOINED A:', JSON.stringify(await hud(A)));
console.log('JOINED B:', JSON.stringify(await hud(B)));
await A.screenshot({ path: `${SHOT}/1-lobby.png` });

await A.click('.garden-game-start');
await sleep(2500);
const hidingA = await hud(A), hidingB = await hud(B);
console.log('HIDING A:', JSON.stringify(hidingA));
console.log('HIDING B:', JSON.stringify(hidingB));
await A.screenshot({ path: `${SHOT}/2-hiding.png` });

// Move B with real key events so the pose the server tags against is genuine.
await B.click('canvas');
for (const k of ['KeyW','KeyW','KeyA']) { await B.keyboard.down(k); await sleep(600); await B.keyboard.up(k); }
await sleep(1200);
await B.screenshot({ path: `${SHOT}/3-moving.png` });
console.log('MOVED B:', JSON.stringify(await hud(B)));

console.log('waiting out the 30s hide phase...');
await sleep(31000);
const seekA = await hud(A), seekB = await hud(B);
console.log('SEEKING A:', JSON.stringify(seekA));
console.log('SEEKING B:', JSON.stringify(seekB));
await A.screenshot({ path: `${SHOT}/4-seeking.png` });

// Who is the seeker? Whichever HUD says 'seek!' owns the tag verb.
// Identify the seeker by the LEASE, not by wording: Sculptor's Tag gives the
// round's lease to the seeker, and the phrasing of the game line is exactly
// the sort of thing that changes.
const seeker = seekA.leaseLine.startsWith('you hold') ? A : B;
await seeker.screenshot({ path: `${SHOT}/5-seeker-view.png` });
console.log('SEEKER IS:', seeker === A ? 'Ada' : 'Baz');

await browser.close();
await new Promise((r) => server.close ? server.close(r) : (server.kill?.(), r()));
relay.close();
console.log('PLAYTHROUGH COMPLETE');
