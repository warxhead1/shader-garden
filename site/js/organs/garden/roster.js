// Shader Garden — organs/garden/roster.js
// Multiplayer spec §4.3: peers get a hue, not a floating nameplate. The
// camera is computed entirely in-shader with no JS-side reader
// (scene.glsl:537) — a world->screen projection to place a DOM label over a
// peer's head would mean duplicating that camera in JS, exactly the
// hand-mirrored-invariant mistake index.js's own PLAY_RADIUS comment already
// rejects for the pond/rock XZ constants. So identity lives here instead: a
// DOM roster panel, off to the side, that never has to agree with the GPU
// about where anyone is standing.
//
// Self-mounted (appended to document.body) rather than handed a container,
// because §8.1's frozen opts/return surface has no DOM handle in it — L5
// owns the DOM everywhere else, but the roster panel is the one L2-owned DOM
// surface the spec calls out by name, and net.js is the only caller, so it
// mounts and tears itself down with the room connection's own lifecycle.

import { el, clear } from '../../dom.js';

const PANEL_STYLE = [
  'position:fixed', 'top:12px', 'right:12px', 'z-index:40',
  'font:12px/1.4 system-ui,sans-serif', 'background:rgba(20,20,24,0.82)',
  'color:#eee', 'border-radius:8px', 'padding:8px 10px',
  'min-width:140px', 'max-width:220px', 'pointer-events:none',
  'backdrop-filter:blur(4px)',
].join(';');

function hueColor(hue01) {
  const h = Math.round(((hue01 % 1) + 1) % 1 * 360);
  return `hsl(${h}, 70%, 55%)`;
}

function badgeFor(memberId, lease, game) {
  if (lease && lease.holder === memberId) return { text: 'holder', title: 'holds the lectern' };
  if (game && game.phase && game.phase !== 'lobby' && game.seekerId === memberId) {
    return { text: 'seeker', title: 'the seeker' };
  }
  return null;
}

/** Creates and mounts the roster panel. Returns {update(state), destroy()};
 *  `state` is { members: [{id,name,hue}], selfId, lease, game }. Rebuilds
 *  the row list on every update — the member count is <= MAX_MEMBERS (8),
 *  so a full rebuild is cheaper than diffing and never shows stale rows. */
export function createRoster() {
  const panel = el('div', 'sg-mp-roster');
  panel.setAttribute('style', PANEL_STYLE);
  const list = el('div', 'sg-mp-roster-list');
  panel.appendChild(list);
  document.body.appendChild(panel);

  function update({ members, selfId, lease, game }) {
    clear(list);
    for (const m of members || []) {
      const row = el('div', 'sg-mp-roster-row');
      row.setAttribute('style', 'display:flex;align-items:center;gap:6px;padding:2px 0');
      const swatch = el('span');
      swatch.setAttribute(
        'style',
        `display:inline-block;width:10px;height:10px;border-radius:50%;background:${hueColor(m.hue)};flex:none`
      );
      row.appendChild(swatch);
      const label = m.id === selfId ? `${m.name} (you)` : m.name;
      row.appendChild(el('span', null, label));
      const badge = badgeFor(m.id, lease, game);
      if (badge) {
        const b = el('span', 'sg-mp-roster-badge', badge.text);
        b.title = badge.title;
        b.setAttribute('style', 'margin-left:auto;opacity:0.75;font-style:italic');
        row.appendChild(b);
      }
      list.appendChild(row);
    }
  }

  function destroy() {
    panel.remove();
  }

  return { update, destroy };
}
