// GARDEN-1 (WebGPU garden port) — parse-parity acceptance.
// Usage: node tools/test/garden-wgsl-parity.mjs   (pure Node, no browser —
// no puppeteer dependency needed for this one).
//
// The @component/@tune/@end annotation grammar (js/organs/garden/parse.js)
// MUST survive verbatim in the WGSL port: scene.wgsl has to yield the
// IDENTICAL component list (same ids, same names/blurbs, same tune
// metadata, same order) as scene.glsl, since js/organs/garden/index.js
// builds its probe UI from whichever source the active backend actually
// compiled. startLine/endLine are expected to differ (the two files aren't
// line-for-line identical) and are intentionally excluded from the
// comparison; `source` (the raw body text) is GLSL vs WGSL code and is
// compared only for non-emptiness, not equality.
//
// Also checks the `@sg-uniforms` directive (wrap.js's WGSL custom-uniform
// bank) declares exactly the probe toggles + every @tune name parse.js
// found — the two conventions are independent (parse.js never reads
// @sg-uniforms) but must stay in sync by hand, so this is the regression
// oracle for that.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseScene } from '../../site/js/organs/garden/parse.js';
import { wgCustomUniformNames, WGSL_CUSTOM_UNIFORM_SLOTS } from '../../site/js/runtime/wrap.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GLSL_PATH = join(ROOT, 'site/assets/garden/scene.glsl');
const WGSL_PATH = join(ROOT, 'site/assets/garden/scene.wgsl');

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok ? '' : `\n      ${detail || ''}`));
  if (!ok) failed = true;
}

const glslSrc = readFileSync(GLSL_PATH, 'utf8');
const wgslSrc = readFileSync(WGSL_PATH, 'utf8');

const glsl = parseScene(glslSrc);
const wgsl = parseScene(wgslSrc);

check('same component count', glsl.components.length === wgsl.components.length,
  `glsl=${glsl.components.length} wgsl=${wgsl.components.length}`);

const n = Math.min(glsl.components.length, wgsl.components.length);
for (let i = 0; i < n; i++) {
  const g = glsl.components[i], w = wgsl.components[i];
  const label = `component[${i}] (${g.id})`;
  check(`${label}: id matches`, g.id === w.id, `glsl=${g.id} wgsl=${w.id}`);
  check(`${label}: name matches`, g.name === w.name, `glsl="${g.name}" wgsl="${w.name}"`);
  check(`${label}: blurb matches`, g.blurb === w.blurb, `glsl="${g.blurb}" wgsl="${w.blurb}"`);
  check(`${label}: source non-empty in both`, g.source.trim().length > 0 && w.source.trim().length > 0);
  check(`${label}: same tune count`, g.tunes.length === w.tunes.length,
    `glsl=${g.tunes.length} wgsl=${w.tunes.length}`);
  const tn = Math.min(g.tunes.length, w.tunes.length);
  for (let j = 0; j < tn; j++) {
    const gt = g.tunes[j], wt = w.tunes[j];
    check(`${label}: tune[${j}] (${gt.name}) matches`,
      gt.name === wt.name && gt.min === wt.min && gt.max === wt.max &&
      gt.default === wt.default && gt.label === wt.label,
      `glsl=${JSON.stringify(gt)} wgsl=${JSON.stringify(wt)}`);
  }
}

// @sg-uniforms coverage: every @tune name + the non-tune engine uniforms, no
// more, no less. SG_QUALITY is the third probe-adjacent toggle (PERF-2's
// quality tier); uCharPosX/uCharPosZ (wave-3 movement controller),
// uCharYaw/uCharGaitDist/uCharSpeed01 (wave-4 §A locomotion), and
// uCamMode/uPrevCamMode/uCamBlend (wave-4 §B camera modes) are the most
// recent additions — none have a slider, but all must live in the WGSL bank
// so the garden organ can set them on either backend. Grow this allowlist
// deliberately, one named entry at a time — never widen it with a wildcard.
const NON_TUNE_NAMES = ['uProbe', 'uProbeSel', 'SG_QUALITY', 'uCharPosX', 'uCharPosZ',
  'uCharYaw', 'uCharGaitDist', 'uCharSpeed01', 'uCamMode', 'uPrevCamMode', 'uCamBlend'];
// Multiplayer names come AFTER the tunes in the directive (they were
// appended with the peers/lectern/sponge components). The gate uniforms
// default to 0 and every gated body early-outs on 0, which is what leaves
// the solo route unchanged (I3).
//
// The peer scalars ARE here, on the WebGPU path. They were briefly absent
// when wrap.js's bank held 32 floats and 25 were spent, which had forced
// multiplayer to be declared WebGL2-only. The bank is now 128, so WebGPU
// renders peers like any other backend. This list is generated in the same
// order sg_peers_sdf unrolls them.
const PEER_FIELDS = ['Act', 'X', 'Z', 'Yaw', 'Gait', 'Speed', 'Hue'];
const PEER_NAMES = ['uPeerCount', ...Array.from({ length: 7 }, (_, i) =>
  PEER_FIELDS.map((f) => `uPeer${i}${f}`)).flat()];
const MP_NAMES = [...PEER_NAMES, 'uLeaseHeld', 'uLeaseHue', 'uSpongeOn', 'uLecternOn'];
const expectedCustomNames = [...NON_TUNE_NAMES, ...wgsl.tunes.map((t) => t.name), ...MP_NAMES];
const actualCustomNames = wgCustomUniformNames(wgslSrc);
check('@sg-uniforms declares uProbe + uProbeSel + every @tune name + the MP names, in that order',
  JSON.stringify(actualCustomNames) === JSON.stringify(expectedCustomNames),
  `expected=${JSON.stringify(expectedCustomNames)} actual=${JSON.stringify(actualCustomNames)}`);

// Bank capacity. wgCustomUniformNames() now THROWS on overflow rather than
// slicing silently, so this can no longer be a silent miscompile — but the
// check stays, because it fails with a useful number instead of an exception
// and because it documents the headroom the multiplayer wave actually needs.
const rawCustomNames = (wgslSrc.match(/@sg-uniforms\s+(.+)/) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
check(`@sg-uniforms fits the ${WGSL_CUSTOM_UNIFORM_SLOTS}-slot bank`,
  rawCustomNames.length <= WGSL_CUSTOM_UNIFORM_SLOTS,
  `raw=${rawCustomNames.length} slots=${WGSL_CUSTOM_UNIFORM_SLOTS}`);

// Peers must be present on BOTH backends. The inverse of this assertion
// ("no uPeer* reaches the WGSL bank") was correct for exactly as long as
// multiplayer was pinned to WebGL2; it is now the regression to catch.
check('every peer scalar reaches the WGSL bank (WebGPU renders peers too)',
  PEER_NAMES.every((n) => rawCustomNames.includes(n)),
  `missing=${PEER_NAMES.filter((n) => !rawCustomNames.includes(n)).join(',') || '(none)'}`);

console.log(failed ? '\nFAIL' : '\nall-PASS');
process.exit(failed ? 1 : 0);
