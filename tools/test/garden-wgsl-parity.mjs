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
// Multiplayer names come AFTER the tunes in the directive (they were appended
// with the peers/lectern/sponge components). All four gate a component or a
// lectern highlight and default to 0, which is exactly what makes the solo
// route unchanged (I3) — an unset uniform reads 0 and every gated body takes
// its early-out. uPeer* is deliberately absent: peers are GLSL-only (spec
// §0.5 C1), 50 scalars that cannot fit the bank, so scene.wgsl carries a
// miss-stub for parity and multiplayer pins to WebGL2.
const MP_NAMES = ['uSpongeOn', 'uLeaseHeld', 'uLeaseHue', 'uLecternOn'];
const expectedCustomNames = [...NON_TUNE_NAMES, ...wgsl.tunes.map((t) => t.name), ...MP_NAMES];
const actualCustomNames = wgCustomUniformNames(wgslSrc);
check('@sg-uniforms declares uProbe + uProbeSel + every @tune name + the MP gates, in that order',
  JSON.stringify(actualCustomNames) === JSON.stringify(expectedCustomNames),
  `expected=${JSON.stringify(expectedCustomNames)} actual=${JSON.stringify(actualCustomNames)}`);

// Bank overflow is the failure mode this file exists to catch, and the check
// above CANNOT catch it on its own: wgCustomUniformNames() ends in
// `.slice(0, WGSL_CUSTOM_UNIFORM_SLOTS)`, so a directive that overflows comes
// back silently truncated rather than erroring. Names past the bank are not
// merely dropped — they evict nothing and simply never bind, so the shader
// reads a stale slot and renders plausibly wrong. Count the RAW directive.
const rawCustomNames = (wgslSrc.match(/@sg-uniforms\s+(.+)/) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
check(`@sg-uniforms fits the ${WGSL_CUSTOM_UNIFORM_SLOTS}-slot bank without silent truncation`,
  rawCustomNames.length <= WGSL_CUSTOM_UNIFORM_SLOTS,
  `raw=${rawCustomNames.length} slots=${WGSL_CUSTOM_UNIFORM_SLOTS}`);
check('no uPeer* name reaches the WGSL bank (peers are GLSL-only, spec §0.5 C1)',
  !rawCustomNames.some((n) => n.startsWith('uPeer')),
  rawCustomNames.filter((n) => n.startsWith('uPeer')).join(',') || '(none)');

console.log(failed ? '\nFAIL' : '\nall-PASS');
process.exit(failed ? 1 : 0);
