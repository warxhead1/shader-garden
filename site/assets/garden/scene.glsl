// GARDEN-0 — the probe-able showcase scene ("/garden").
//
// Annotation convention (parsed by js/organs/garden/parse.js, documented in
// ARCHITECTURE.md § "The Garden"):
//   // @component <id> "<display name>" "<blurb>"   ...body...   // @end
//   // @tune <NAME> <min> <max> <default> "<label>"     (inside a component,
//   immediately above the `uniform float NAME;` it drives — becomes a
//   probe-panel slider, live, no recompile)
//
// Component ids are assigned by file order (1 = first @component seen, and
// so on) — the numeric COMP_* constants below MUST stay in that same order,
// because the probe readback (see mainImage's uProbe branch) encodes the id
// a raymarched pixel belongs to as a color channel, and js/organs/garden/
// parse.js decodes it back to a name purely by array position.
//
// World scale is a tabletop diorama, not the biome-rolling-hills flyover it
// borrows its noise from: terrain height ~0-2 units, camera orbit radius
// ~3.6 units. Small numbers so the character (a person-scale SDF, ~1.2
// units tall) can share one raymarch with the terrain.

uniform float uProbe; // 0 = normal shading, 1 = probe frame (encode compId, no lighting)
uniform float uProbeSel; // 0 = nothing selected, otherwise a COMP_* id — the matching
// component gets a fresnel rim-light in the normal shading path below. Never set by
// this branch (that's the probe panel's job), so it defaults to 0 and every pixel
// below is byte-identical to before whenever nothing is selected.

// PERF-2: 0 = Low, 1 = Medium, 2 = High. Scales sg_march's step count and
// sg_cloud_fbm's octave count (see both below) — the garden organ
// (js/organs/garden/index.js's applyQualityUniform()) sets this explicitly
// on every build, including a fresh context-loss rebuild, so "never set"
// never actually reaches a live frame. High (2) hits the exact same fixed
// loop bounds (88 steps, 3 octaves) every render used before this uniform
// existed — Low/Medium only add an early exit, they don't change either
// loop's own iteration math.
uniform float SG_QUALITY;

// World-space XZ target for the character (wave-3 movement controller,
// js/organs/garden/index.js). Unset uniforms default to 0 in GLSL, so the
// scene stays pixel-identical to before until something actually calls
// setUniforms({ uCharPosX, uCharPosZ }).
uniform float uCharPosX;
uniform float uCharPosZ;

// Wave-4 §A: distance-driven locomotion, JS-integrated in moveFrame()
// (js/organs/garden/index.js). uCharSpeed01 is 0 whenever the character is
// idle (unset uniforms default to 0), and every new motion term below is
// mixed on uCharSpeed01 — so a fresh mount, or any frame nobody is holding
// a direction, reproduces today's exact idle math bit-for-bit.
uniform float uCharYaw;       // facing angle, radians — turned toward the movement heading
                               // at a bounded rate JS-side, never snapped
uniform float uCharGaitDist;  // world-space distance accumulated ONLY while moving —
                               // freezes for free the instant moveFrame() idle-exits
uniform float uCharSpeed01;   // 0..1, current move-vector magnitude

// Wave-4 §B: camera mode (0=Orbit, 1=Follow, 2=Overview) — see sg_cam_orbit/
// sg_cam_follow/sg_cam_overview near mainImage below. uCamBlend ramps 0..1
// JS-side over a fixed duration on every mode switch, cross-fading between
// whatever uPrevCamMode's camera would be THIS instant and the new mode —
// see mainImage's camA/camB blend. Default boot state (0/0, blend either
// value) always resolves to Orbit on both sides of the blend, so this can
// never perturb the pre-wave-4 render.
uniform float uCamMode;
uniform float uPrevCamMode;
uniform float uCamBlend;

const float COMP_SKY       = 1.0;
const float COMP_TERRAIN   = 2.0;
const float COMP_CHARACTER = 3.0;
const float COMP_SHADOW    = 4.0;
const float COMP_POND      = 5.0;
const float COMP_GRASS     = 6.0;
const float COMP_CLOUDS    = 7.0;
const float COMP_ROCKS     = 8.0;
// MP-2/3/5 (docs/multiplayer-spec.md §4.2/§5.1/§7.1): appended, never
// inserted earlier — parse.js assigns component ids by file order, so
// these three MUST stay last or every id above shifts and the probe panel
// (and garden.mjs's id assertions) breaks.
const float COMP_PEERS     = 9.0;
const float COMP_LECTERN   = 10.0;
const float COMP_SPONGE    = 11.0;

// @component sky "Sky & Atmosphere" "A gradient horizon-to-zenith plus a squinted-power sun disc — the cheapest possible sky that still reads as one. No clouds, no scattering sim: one lerp, one pow(), and an additive sun term."
vec3 sg_sky_color(vec3 rd, float time) {
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 horizon = vec3(0.72, 0.82, 0.92);
  vec3 zenith  = vec3(0.20, 0.42, 0.82);
  vec3 col = mix(horizon, zenith, h * h);

  vec3 sun_dir = normalize(vec3(0.55, 0.42, 0.35));
  float sun = pow(max(dot(rd, sun_dir), 0.0), 340.0);
  col += vec3(1.5, 1.15, 0.75) * sun;

  // A slow drift in the horizon tint stands in for time-of-day — cheap
  // atmosphere without a real scattering model.
  col += vec3(0.03, 0.015, 0.0) * sin(time * 0.05);
  return col;
}
// @end

// @component terrain "Rolling Hills (evolved)" "The heightfield is FunSearch-evolved fractal noise, not hand-tuned — lifted from kernel biome-rolling-hills (fitness 0.9994). Rescaled here from a kilometers-wide flyover to a few-meter garden patch; the only change to the noise itself: its octave persistence (originally the constant 0.53) now drives the roughness slider below."
// From biome-rolling-hills (kernels.json), renamed sg_* to avoid colliding
// with anything else on the page. One deliberate edit: the kernel's
// hardcoded octave persistence (a *= 0.53) became TERRAIN_ROUGHNESS.
float sg_hash(float n) { return fract(sin(n) * 43758.5453); }
float sg_noise2(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * f * (10.0 - 15.0 * f + 6.0 * f * f);
  return mix(mix(sg_hash(i.x + i.y * 57.0),       sg_hash(i.x + 1.0 + i.y * 57.0),       f.x),
             mix(sg_hash(i.x + (i.y + 1.0) * 57.0), sg_hash(i.x + 1.0 + (i.y + 1.0) * 57.0), f.x), f.y);
}

// @tune TERRAIN_ROUGHNESS 0.35 0.72 0.53 "fractal persistence — how much each noise octave hands down to the next"
uniform float TERRAIN_ROUGHNESS;

float sg_biome_hills(vec2 p) {
  // PERF-3: this is the fbm PERF-2 did not scale. sg_cloud_fbm drops octaves
  // with SG_QUALITY and runs ONCE per sky pixel; this one ran a fixed 5
  // octaves and is called from sg_terrain_height, i.e. up to `maxSteps` (88)
  // times per ray plus normals — sg_march's own comment already names it
  // "the single most expensive call in this march". Scaling the cheap one
  // and not the hot one was an oversight, not a decision.
  //
  // High stays 5 octaves, so Auto/High output is byte-identical to before.
  // Low/Medium trade high-frequency relief for step cost, which is the
  // trade those presets exist to make.
  //
  // CONTRACT: the clamp to [0,1] is what sg_march's `terrainCeil` early-out
  // relies on, and dropping octaves only ever REDUCES the sum, so that bound
  // stays valid at every quality level.
  int octaves = SG_QUALITY < 0.5 ? 3 : (SG_QUALITY < 1.5 ? 4 : 5);
  float v = 0.0, a = 0.58;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    v += a * sg_noise2(p);
    p = vec2(p.x * 1.78 + p.y * 0.35, p.x * 0.35 + p.y * 1.78);
    a *= TERRAIN_ROUGHNESS;
  }
  return clamp(v, 0.0, 1.0);
}

// @tune TERRAIN_SCALE 0.4 2.0 1.0 "vertical exaggeration of the evolved heightfield"
uniform float TERRAIN_SCALE;

const float SG_TERRAIN_INV_SCALE = 1.0 / 4.4;
const float SG_TERRAIN_HEIGHT_RNG = 1.9;

float sg_terrain_height(vec2 xz) {
  return sg_biome_hills(xz * SG_TERRAIN_INV_SCALE) * SG_TERRAIN_HEIGHT_RNG * max(TERRAIN_SCALE, 0.05);
}

vec3 sg_terrain_normal(vec2 xz, float eps) {
  float h0 = sg_terrain_height(xz);
  float hx = sg_terrain_height(xz + vec2(eps, 0.0));
  float hz = sg_terrain_height(xz + vec2(0.0, eps));
  return normalize(vec3(h0 - hx, eps, h0 - hz));
}

vec3 sg_terrain_color(vec2 xz, float height, vec3 N) {
  float height01 = clamp(height / SG_TERRAIN_HEIGHT_RNG, 0.0, 1.0);
  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  vec3 col = mix(vec3(0.42, 0.58, 0.22), vec3(0.27, 0.40, 0.19), height01);
  col = mix(col, vec3(0.30, 0.23, 0.17), smoothstep(0.35, 0.7, slope));
  col = mix(col, vec3(0.86, 0.90, 0.94), smoothstep(0.78, 0.95, height01) * smoothstep(0.5, 0.25, slope));
  return col;
}
// @end

// @component character "Bouncing Figure" "Six smooth-blended primitives (head, torso, two arms, two legs), no mesh, no skeleton. Parabolic height keeps the hop physically believable; a cosine drives squash-and-stretch so the same handful of spheres and capsules reads as alive."
float sg_smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sg_sphere(vec3 p, vec3 c, float r) { return length(p - c) - r; }
float sg_capsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// @tune BOUNCE_HEIGHT 0.15 1.1 0.55 "apex height of the hop above the ground"
uniform float BOUNCE_HEIGHT;
// @tune BOUNCE_SPEED 0.4 2.5 1.1 "hops per second (roughly)"
uniform float BOUNCE_SPEED;

const float SG_LEG_LEN = 0.5;

// Bounce phase in [0, 1); a parabola of this (4t(1-t)) is the actual
// trajectory of a ball under constant gravity between two ground contacts —
// the same curve, not an approximation of one.
float sg_bounce_phase(float time) { return fract(time * BOUNCE_SPEED * 0.5); }

// Wave-4 §A: gait phase is DISTANCE-driven, not wall-clock — it stops
// advancing the instant uCharGaitDist stops growing, which happens
// automatically the frame moveFrame() (index.js) idle-exits.
const float SG_STRIDE_LEN = 1.1; // world units per full gait cycle — tuned so a
                                  // MOVE_SPEED=1.8 walk reads as ~1.6 steps/sec
float sg_gait_phase() { return fract(uCharGaitDist / SG_STRIDE_LEN); }

// MP-2 (docs/multiplayer-spec.md §4.2): the body SDF, parameterised so
// sg_peers_sdf (appended after rocks, below) can reuse it for up to 7 other
// players instead of forking a second copy of six smooth-blended
// primitives. `yaw`/`gaitPhase`/`speed01` are exactly what sg_character_sdf
// below reads off the uChar* globals — gaitPhase is already the [0,1)
// stride-cycle fraction (sg_gait_phase()'s output), not the raw
// accumulated distance, since a peer only ever gets ITS OWN already-
// normalized value over the wire (§4.1 flattens to scalars, not a
// distance the far end would have to replay stride math on). Bounce
// (squash/stretch, the parabolic hop) is driven by iTime, which is
// synced across clients as of MP-1 — so every figure this feeds, local or
// peer, bounces in lockstep for free, no per-peer bounce uniform needed.
float sg_figure_sdf(vec3 p, vec3 center, float yaw, float gaitPhase, float speed01) {
  float t = sg_bounce_phase(iTime);

  // Bounding-sphere early-out: almost every march step, for almost every
  // ray (sky, distant terrain), is nowhere near the figure. Only pay for
  // the five-primitive smooth-min chain when a step actually lands within
  // SG_CHAR_BOUND_MARGIN of the bound; farther out, the bound's own
  // (conservative) distance is a valid stepping estimate. The margin
  // matters: the bound's distance must never be what the caller's
  // hit-threshold test fires on — most of the volume inside the bound is
  // empty (the figure is thin limbs in a body-sized sphere), so a hit
  // registered against the bound itself, instead of the real geometry,
  // would land on empty air. Only stepping ever sees the bound's distance;
  // the threshold test only ever sees the real SDF once within margin of it.
  const float SG_CHAR_BOUND_R = 0.95;
  const float SG_CHAR_BOUND_MARGIN = 0.1;
  float toCenter = length(p - center);
  if (toCenter > SG_CHAR_BOUND_R + SG_CHAR_BOUND_MARGIN) return toCenter - SG_CHAR_BOUND_R;

  // Squash at ground contact (t=0/1), stretch at the apex (t=0.5) — the
  // classic cartoon convention, not literal velocity (velocity is actually
  // highest at contact) — it reads as "alive", which is the point.
  float phase = cos(t * 6.28318530718);
  float scaleY  = mix(0.72, 1.18, (1.0 - phase) * 0.5);
  float scaleXZ = mix(1.20, 0.90, (1.0 - phase) * 0.5);

  vec3 lp = p - center;

  // Wave-4 §A: byte-identical fast path when nothing is moving (the ACTUAL
  // idle signal moveFrame() maintains, not just "speed is near zero") — the
  // EXACT pre-wave-4 expression tree, untouched. Mathematically the
  // animated path below reduces to the same thing at these values (yaw
  // rotation is an identity at 0, every new term is 0-multiplied), but
  // empirically that reduction cost a handful of pixels a single ULP
  // (garden-locomotion-parity.mjs test (1) caught it — almost certainly the
  // compiler re-associating cos(uCharYaw)/sin(uCharYaw) into the chain
  // differently than the old code's absence of them). Literal code
  // preservation sidesteps the question of WHY entirely.
  if (yaw == 0.0 && gaitPhase == 0.0 && speed01 <= 0.0) {
    lp.y /= scaleY;
    lp.xz /= scaleXZ;

    float k = 0.075;
    float d = sg_capsule(lp, vec3(0.0, -0.04, 0.0), vec3(0.0, 0.28, 0.0), 0.165);
    d = sg_smin(d, sg_sphere(lp, vec3(0.0, 0.50, 0.0), 0.155), k);

    float swing = sin(iTime * 3.1);
    d = sg_smin(d, sg_capsule(lp, vec3( 0.24, 0.24, 0.0), vec3( 0.27 + 0.07 * swing, -0.12,  0.13 * swing), 0.062), k);
    d = sg_smin(d, sg_capsule(lp, vec3(-0.24, 0.24, 0.0), vec3(-0.27 - 0.07 * swing, -0.12, -0.13 * swing), 0.062), k);

    float tuck = smoothstep(0.12, 0.5, min(t, 1.0 - t)); // legs draw up mid-flight, extend for landing
    d = sg_smin(d, sg_capsule(lp, vec3( 0.11, -0.04, 0.0), vec3( 0.11, -0.5 + 0.24 * tuck,  0.07 * tuck), 0.075), k);
    d = sg_smin(d, sg_capsule(lp, vec3(-0.11, -0.04, 0.0), vec3(-0.11, -0.5 + 0.24 * tuck, -0.07 * tuck), 0.075), k);

    return d * min(scaleY, scaleXZ);
  }

  // Yaw the whole figure to face `yaw` before any limb math runs, so every
  // primitive below turns together.
  float cy = cos(yaw), sy = sin(yaw);
  lp.xz = vec2(lp.x * cy - lp.z * sy, lp.x * sy + lp.z * cy);

  // gp: 0..2pi over one full stride — `gaitPhase` IS sg_gait_phase()'s
  // output (the caller already normalized it; see this function's header
  // comment for why a peer never has to replay stride math to get here). A
  // second, smaller vertical bob at 2x gait frequency (one dip per
  // footstep, not per stride) rides underneath the hop's own squash/stretch
  // below.
  float gp = gaitPhase * 6.28318530718;
  float gaitBob = sin(gp * 2.0) * 0.03 * speed01;
  lp.y -= gaitBob;

  lp.y /= scaleY;
  lp.xz /= scaleXZ;

  float k = 0.075; // one smooth-min radius for the whole figure's "softness"

  // Lean the upper body into the direction of travel; legs stay in the
  // unleaned `lp` below so they read as planted, not swaying with the torso.
  float lean = speed01 * 0.12; // radians, ~7 deg max
  vec3 lu = lp;
  lu.yz += vec2(-lean * lp.z, lean * lp.y);

  float d = sg_capsule(lu, vec3(0.0, -0.04, 0.0), vec3(0.0, 0.28, 0.0), 0.165);
  d = sg_smin(d, sg_sphere(lu, vec3(0.0, 0.50, 0.0), 0.155), k);

  // Arm swing: at rest this branch is never reached (see the fast path
  // above) — the walk formula (gait-phase-driven) takes over as speed
  // increases, mixed FROM the same pre-wave-4 idle formula so a start/stop
  // is a blend, not a pop.
  float swing = mix(sin(iTime * 3.1), sin(gp) * 0.55, speed01);
  d = sg_smin(d, sg_capsule(lu, vec3( 0.24, 0.24, 0.0), vec3( 0.27 + 0.07 * swing, -0.12,  0.13 * swing), 0.062), k);
  d = sg_smin(d, sg_capsule(lu, vec3(-0.24, 0.24, 0.0), vec3(-0.27 - 0.07 * swing, -0.12, -0.13 * swing), 0.062), k);

  // Legs go counter-phase to the arms (gp + pi). The existing bounce-driven
  // tuck (mid-flight knee lift) is untouched; legSwing adds a horizontal
  // front/back stride offset on top of it — the two read as orthogonal
  // motions (swing forward/back AND lift at the knee).
  float tuck = smoothstep(0.12, 0.5, min(t, 1.0 - t)); // legs draw up mid-flight, extend for landing
  float legSwing = mix(0.0, sin(gp + 3.14159265) * 0.35, speed01);
  d = sg_smin(d, sg_capsule(lp, vec3( 0.11, -0.04, 0.0), vec3( 0.11 + legSwing * 0.15, -0.5 + 0.24 * tuck,  0.07 * tuck - legSwing * 0.10), 0.075), k);
  d = sg_smin(d, sg_capsule(lp, vec3(-0.11, -0.04, 0.0), vec3(-0.11 - legSwing * 0.15, -0.5 + 0.24 * tuck, -0.07 * tuck + legSwing * 0.10), 0.075), k);

  return d * min(scaleY, scaleXZ); // conservative distance correction for the non-uniform scale
}

// Thin wrapper: the local player's own body, reading the uChar* globals
// moveFrame() (index.js) drives — every pre-existing caller (sg_march's
// dChar, sg_character_normal below, the bounding-sphere early-out inside
// sg_figure_sdf above) goes through this unchanged, so nothing about the
// solo route's behavior moves even a ULP.
float sg_character_sdf(vec3 p, vec3 center) {
  return sg_figure_sdf(p, center, uCharYaw, sg_gait_phase(), uCharSpeed01);
}

vec3 sg_character_normal(vec3 p, vec3 center) {
  const float e = 0.0025;
  vec2 h = vec2(e, 0.0);
  return normalize(vec3(
    sg_character_sdf(p + h.xyy, center) - sg_character_sdf(p - h.xyy, center),
    sg_character_sdf(p + h.yxy, center) - sg_character_sdf(p - h.yxy, center),
    sg_character_sdf(p + h.yyx, center) - sg_character_sdf(p - h.yyx, center)
  ));
}

// The figure's world-space center for the current frame — computed once
// (one sg_terrain_height() call) and threaded through the march and shading
// instead of re-derived from iTime everywhere it's needed.
vec3 sg_character_center(float time) {
  float t = sg_bounce_phase(time);
  float arc = 4.0 * BOUNCE_HEIGHT * t * (1.0 - t);
  vec2 xz = vec2(uCharPosX, uCharPosZ);
  return vec3(xz.x, sg_terrain_height(xz) + SG_LEG_LEN + arc, xz.y);
}
// @end

// @component shadow "Blob Shadow" "No shadow ray, no depth buffer — just distance from the hit point to the character's ground projection, softened by how high the character currently is. Cheap and, at this camera distance, indistinguishable from the real thing."
// @tune SHADOW_SOFTNESS 0.4 2.5 1.0 "radius of the contact shadow beneath the figure"
uniform float SHADOW_SOFTNESS;

float sg_shadow_factor(vec2 xz) {
  float t = sg_bounce_phase(iTime);
  float arc = 4.0 * BOUNCE_HEIGHT * t * (1.0 - t);
  float r = max(0.30 * SHADOW_SOFTNESS * (1.0 + arc * 0.7), 0.05);
  float d = length(xz - vec2(uCharPosX, uCharPosZ));
  float shadow = 1.0 - smoothstep(0.0, r, d);
  return shadow * mix(1.0, 0.35, clamp(arc / max(BOUNCE_HEIGHT, 0.05), 0.0, 1.0));
}
// @end

// @component pond "Pond" "A small still-water pool set into a shallow terrain depression — no wave simulation, just a flat disk sunk below the surrounding ground and a planar reflection of the sky. The ripples are a normal-map trick: the water plane itself never moves."
const vec2  SG_POND_XZ = vec2(1.7, 0.5);
const float SG_POND_RADIUS = 0.5;
const float SG_POND_DEPTH = 0.12;

// @tune POND_RIPPLE 0.0 0.05 0.015 "ripple normal-perturbation strength"
uniform float POND_RIPPLE;
// @tune POND_TINT_MIX 0.0 1.0 0.35 "how much the water's own tint shows through the sky reflection"
uniform float POND_TINT_MIX;

// Sampled once per frame from the terrain at the pond's center (see
// mainImage) — sunk slightly below it so the disk reads as filling a
// depression, not floating on top of the ground.
float sg_pond_water_y(vec2 xz) {
  return sg_terrain_height(xz) - SG_POND_DEPTH;
}

// A flat, disk-shaped body of water. Not an exact SDF near the rim (it
// mildly overestimates there), which is fine at this march's tolerance —
// the terrain component uses the same kind of approximation for a much
// bigger feature, for the same reason.
float sg_pond_sdf(vec3 p, float waterY) {
  float radial = length(p.xz - SG_POND_XZ) - SG_POND_RADIUS;
  float vert = p.y - waterY;
  return length(vec2(max(radial, 0.0), vert));
}

vec3 sg_pond_normal(vec2 xz) {
  vec2 n2 = vec2(sg_noise2(xz * 6.0 + iTime * 0.6),
                 sg_noise2(xz * 6.0 + vec2(19.3, -7.1) - iTime * 0.5)) - 0.5;
  return normalize(vec3(n2.x * POND_RIPPLE * 4.0, 1.0, n2.y * POND_RIPPLE * 4.0));
}

// Cheap planar-reflection approximation: reflect the view ray and sample
// the sky — no scene geometry in the reflection, just enough to read as
// "water" once mixed with the pond's own tint.
vec3 sg_pond_color(vec3 rd, vec3 N) {
  vec3 R = reflect(rd, N);
  vec3 refl = sg_sky_color(R, iTime);
  vec3 tint = vec3(0.08, 0.20, 0.24);
  return mix(refl, tint, clamp(POND_TINT_MIX, 0.0, 1.0));
}
// @end

// @component grass "Meadow Sway" "A shading trick, not per-blade geometry: a wind-swayed color and normal wobble on the flattest, lowest patches of terrain. Cheap 2D noise offset by time stands in for blades bending in the wind — it only runs where terrain already shaded, no extra march-time cost."
// @tune GRASS_SWAY_SPEED 0.2 3.0 1.0 "wind sway animation speed"
uniform float GRASS_SWAY_SPEED;

// 1 on flat, low ground; 0 near cliffs (the same slope test sg_terrain_color
// uses) and near the snow line — grass grows in the meadow, not on exposed rock.
float sg_grass_mask(float height01, float slope) {
  float flatness = 1.0 - smoothstep(0.15, 0.55, slope);
  float lowland  = 1.0 - smoothstep(0.30, 0.62, height01);
  return flatness * lowland;
}

// N is nudged in place (inout) as well as the color — the "wobble" half of
// wind-swayed grass, not just a color tint.
vec3 sg_grass_shade(vec2 xz, inout vec3 N, vec3 baseCol, float mask) {
  float wind = sg_noise2(xz * 2.2 + vec2(iTime * GRASS_SWAY_SPEED * 0.6, 0.0));
  vec3 bladeCol = mix(vec3(0.34, 0.52, 0.18), vec3(0.48, 0.62, 0.22), wind);
  vec2 wobble = (vec2(sg_noise2(xz * 3.1 + iTime * GRASS_SWAY_SPEED),
                       sg_noise2(xz * 3.1 + 5.2 - iTime * GRASS_SWAY_SPEED)) - 0.5) * 0.10 * mask;
  N = normalize(N + vec3(wobble.x, 0.0, wobble.y));
  return mix(baseCol, bladeCol, mask * (0.55 + 0.25 * wind));
}
// @end

// @component clouds "Drifting Clouds" "2D fbm drifting across a plane projected from the view ray — no volumetrics, just a coverage threshold blended into the sky color. Shading-time only: it runs once per sky pixel, never inside the raymarch."
// @tune CLOUD_COVERAGE 0.0 1.0 0.45 "fraction of the sky covered by cloud"
uniform float CLOUD_COVERAGE;

float sg_cloud_fbm(vec2 p) {
  // PERF-2: fixed 3-octave loop bound unchanged (High == pre-SG_QUALITY
  // behavior); Low/Medium just exit after fewer octaves.
  int octaves = SG_QUALITY < 0.5 ? 1 : (SG_QUALITY < 1.5 ? 2 : 3);
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    if (i >= octaves) break;
    v += a * sg_noise2(p);
    p = p * 2.03 + vec2(11.0, 7.0);
    a *= 0.5;
  }
  return v;
}

// rd.y < 0.05 rejects below-horizon rays before paying for the fbm at all —
// sky-hit rays are never far below horizontal anyway (see sg_march: anything
// steeply downward hits the terrain's heightfield long before SG_MAX_DIST),
// so this mostly just guards the horizon seam cheaply.
float sg_cloud_mask(vec3 rd) {
  if (rd.y < 0.05) return 0.0;
  vec2 p = rd.xz / max(rd.y, 0.15) * 0.6 + vec2(iTime * 0.02, iTime * 0.01);
  float n = sg_cloud_fbm(p);
  float edge = 1.0 - clamp(CLOUD_COVERAGE, 0.0, 1.0);
  return smoothstep(edge, edge + 0.25, n);
}
// @end

// @component rocks "Weathered Rocks" "A 2-4 sphere smooth-blend near the pond's edge — the same smooth-min trick as the bouncing figure's body, but static. One radius controls how sharp vs. weathered the cluster reads."
// @tune ROCK_ROUNDNESS 0.0 1.0 0.4 "how weathered/rounded the rock cluster reads"
uniform float ROCK_ROUNDNESS;

const vec2  SG_ROCK_XZ = vec2(2.75, 1.05);
const float SG_ROCK_BOUND_R = 0.5;
const float SG_ROCK_BOUND_MARGIN = 0.08;

// Same bounding-sphere early-out as the character (see sg_character_sdf):
// almost every march step is nowhere near this small static cluster, so
// everywhere else only pays for the bound's own conservative distance.
float sg_rocks_sdf(vec3 p, vec3 center) {
  float toCenter = length(p - center);
  if (toCenter > SG_ROCK_BOUND_R + SG_ROCK_BOUND_MARGIN) return toCenter - SG_ROCK_BOUND_R;

  vec3 lp = p - center;
  float k = mix(0.02, 0.16, clamp(ROCK_ROUNDNESS, 0.0, 1.0));
  float d = sg_sphere(lp, vec3(0.0, 0.0, 0.0), 0.20);
  d = sg_smin(d, sg_sphere(lp, vec3(0.26, -0.05, 0.08), 0.15), k);
  d = sg_smin(d, sg_sphere(lp, vec3(-0.18, -0.09, -0.16), 0.13), k);
  d = sg_smin(d, sg_sphere(lp, vec3(0.04, -0.11, 0.22), 0.10), k);
  return d;
}

vec3 sg_rocks_normal(vec3 p, vec3 center) {
  const float e = 0.0025;
  vec2 h = vec2(e, 0.0);
  return normalize(vec3(
    sg_rocks_sdf(p + h.xyy, center) - sg_rocks_sdf(p - h.xyy, center),
    sg_rocks_sdf(p + h.yxy, center) - sg_rocks_sdf(p - h.yxy, center),
    sg_rocks_sdf(p + h.yyx, center) - sg_rocks_sdf(p - h.yyx, center)
  ));
}

// Fixed world position: unlike the character the cluster never moves, so
// this only needs the one-time terrain-height sample mainImage already
// takes for the pond's own precompute.
vec3 sg_rocks_center() {
  return vec3(SG_ROCK_XZ.x, sg_terrain_height(SG_ROCK_XZ) + 0.10, SG_ROCK_XZ.y);
}
// @end

// @component peers "Other Players" "Up to 7 other room members, each one a full sg_figure_sdf reuse of the local character's body — flattened into scalar uPeerN* uniforms because setUniforms() is scalar-float-only on both backends (docs/multiplayer-spec.md §0.2/§4.1). uPeerCount gates the entire component behind one uniform-valued branch, so solo (uPeerCount==0) pays nothing beyond that comparison — the same trick sponge uses below."
const float SG_PEER_MAX = 7.0;

uniform float uPeerCount;

uniform float uPeer0Act; uniform float uPeer0X; uniform float uPeer0Z; uniform float uPeer0Yaw; uniform float uPeer0Gait; uniform float uPeer0Speed; uniform float uPeer0Hue;
uniform float uPeer1Act; uniform float uPeer1X; uniform float uPeer1Z; uniform float uPeer1Yaw; uniform float uPeer1Gait; uniform float uPeer1Speed; uniform float uPeer1Hue;
uniform float uPeer2Act; uniform float uPeer2X; uniform float uPeer2Z; uniform float uPeer2Yaw; uniform float uPeer2Gait; uniform float uPeer2Speed; uniform float uPeer2Hue;
uniform float uPeer3Act; uniform float uPeer3X; uniform float uPeer3Z; uniform float uPeer3Yaw; uniform float uPeer3Gait; uniform float uPeer3Speed; uniform float uPeer3Hue;
uniform float uPeer4Act; uniform float uPeer4X; uniform float uPeer4Z; uniform float uPeer4Yaw; uniform float uPeer4Gait; uniform float uPeer4Speed; uniform float uPeer4Hue;
uniform float uPeer5Act; uniform float uPeer5X; uniform float uPeer5Z; uniform float uPeer5Yaw; uniform float uPeer5Gait; uniform float uPeer5Speed; uniform float uPeer5Hue;
uniform float uPeer6Act; uniform float uPeer6X; uniform float uPeer6Z; uniform float uPeer6Yaw; uniform float uPeer6Gait; uniform float uPeer6Speed; uniform float uPeer6Hue;

// peerCenter[i] is precomputed ONCE per pixel by mainImage (see charCenter/
// rockCenter above) — never here, and never inside sg_march's per-step
// loop: sg_terrain_height is a 5-octave noise call, and this SDF runs once
// per march step per active peer (up to 7x), so recomputing it per-step
// would be exactly the regression sg_character_center's own comment
// already warns about, just multiplied by MAX_PEERS. garden-perf.mjs is
// the budget that would catch it.
float sg_peers_sdf(vec3 p, vec3 peerCenter[7], out float hue) {
  hue = 0.0;
  if (uPeerCount < 0.5) return 1.0e4; // uniform-valued branch: fully coherent, free (I3)
  float best = 1.0e4;

  // One guarded block per slot — unrolled because GLSL ES 3.00 has no
  // uniform arrays here (§0.2: setUniforms() is scalar-float-only, so
  // there's no `uniform float uPeer[7]` to loop over). Each call to
  // sg_figure_sdf gets its own bounding-sphere early-out FOR FREE — it's
  // the same early-out sg_character_sdf already goes through, now living
  // inside sg_figure_sdf itself instead of duplicated per caller.
  if (uPeer0Act > 0.5) { float d = sg_figure_sdf(p, peerCenter[0], uPeer0Yaw, uPeer0Gait, uPeer0Speed); if (d < best) { best = d; hue = uPeer0Hue; } }
  if (uPeer1Act > 0.5) { float d = sg_figure_sdf(p, peerCenter[1], uPeer1Yaw, uPeer1Gait, uPeer1Speed); if (d < best) { best = d; hue = uPeer1Hue; } }
  if (uPeer2Act > 0.5) { float d = sg_figure_sdf(p, peerCenter[2], uPeer2Yaw, uPeer2Gait, uPeer2Speed); if (d < best) { best = d; hue = uPeer2Hue; } }
  if (uPeer3Act > 0.5) { float d = sg_figure_sdf(p, peerCenter[3], uPeer3Yaw, uPeer3Gait, uPeer3Speed); if (d < best) { best = d; hue = uPeer3Hue; } }
  if (uPeer4Act > 0.5) { float d = sg_figure_sdf(p, peerCenter[4], uPeer4Yaw, uPeer4Gait, uPeer4Speed); if (d < best) { best = d; hue = uPeer4Hue; } }
  if (uPeer5Act > 0.5) { float d = sg_figure_sdf(p, peerCenter[5], uPeer5Yaw, uPeer5Gait, uPeer5Speed); if (d < best) { best = d; hue = uPeer5Hue; } }
  if (uPeer6Act > 0.5) { float d = sg_figure_sdf(p, peerCenter[6], uPeer6Yaw, uPeer6Gait, uPeer6Speed); if (d < best) { best = d; hue = uPeer6Hue; } }
  return best;
}

// Distance-only wrapper (drops the hue out-param) so sg_scene_min and
// sg_peers_normal — neither of which cares which peer they landed on, only
// how far away it is — don't have to carry a throwaway `float hue` local.
float sg_peers_dist(vec3 p, vec3 peerCenter[7]) {
  float hue;
  return sg_peers_sdf(p, peerCenter, hue);
}

vec3 sg_peers_normal(vec3 p, vec3 peerCenter[7]) {
  const float e = 0.0025;
  vec2 h = vec2(e, 0.0);
  return normalize(vec3(
    sg_peers_dist(p + h.xyy, peerCenter) - sg_peers_dist(p - h.xyy, peerCenter),
    sg_peers_dist(p + h.yxy, peerCenter) - sg_peers_dist(p - h.yxy, peerCenter),
    sg_peers_dist(p + h.yyx, peerCenter) - sg_peers_dist(p - h.yyx, peerCenter)
  ));
}

// One player's world-space center, ground-following like sg_character_center
// but without its bounce arc term — peers send a gait phase, not a raw
// distance to replay JS-side bounce math against, so there's no local
// arc data to add here; the figure still squash/stretches and swings in
// place (sg_figure_sdf's `t = sg_bounce_phase(iTime)` is shared, synced
// clock), it just doesn't hop vertically in world space. A future slice
// could add an 8th flattened scalar per peer for the arc; not required by
// this one.
vec3 sg_peer_center(float x, float z) {
  return vec3(x, sg_terrain_height(vec2(x, z)) + SG_LEG_LEN, z);
}
// @end

// @component lectern "The Lectern" "A pedestal at a fixed diorama location (docs/multiplayer-spec.md §5.1) — the diegetic lock for who may edit the world. Neutral stone when nobody holds the write lease; glows with the holder's own hue while uLeaseHeld is set. Always present, even solo, same as the pond or the rock cluster — it's scenery first, mechanism second."
const vec2  SG_LECTERN_XZ     = vec2(1.6, -1.4);
const float SG_LECTERN_RADIUS = 0.35;
const float SG_LECTERN_HEIGHT = 0.6;
const float SG_LECTERN_BOUND_R = 0.75;
const float SG_LECTERN_BOUND_MARGIN = 0.08;

uniform float uLeaseHeld; // 0/1 — someone currently holds the write lease
uniform float uLeaseHue;  // 0..1 — that holder's hue (meaningless while uLeaseHeld == 0)
uniform float uLecternOn; // 0/1 — gates the whole component (I3); unset uniforms default to 0, so
                           // solo (no MP mount) gets this for free, same trick peers/sponge use.

// A stood-up capsule reads as a stubby pedestal at this scale — reusing
// sg_capsule (character component, above) rather than writing a bespoke
// cylinder SDF for one static prop. Same bounding-sphere early-out shape as
// rocks/character: base is precomputed once per pixel by mainImage (see
// sg_lectern_base below), never re-sampled from terrain height inside the
// march's per-step loop.
float sg_lectern_sdf(vec3 p, vec3 base) {
  if (uLecternOn < 0.5) return 1.0e4; // uniform-valued branch: fully coherent, free (I3)
  vec3 mid = base + vec3(0.0, SG_LECTERN_HEIGHT * 0.5, 0.0);
  float toC = length(p - mid);
  if (toC > SG_LECTERN_BOUND_R + SG_LECTERN_BOUND_MARGIN) return toC - SG_LECTERN_BOUND_R;
  return sg_capsule(p, base, base + vec3(0.0, SG_LECTERN_HEIGHT, 0.0), SG_LECTERN_RADIUS);
}

vec3 sg_lectern_normal(vec3 p, vec3 base) {
  const float e = 0.0025;
  vec2 h = vec2(e, 0.0);
  return normalize(vec3(
    sg_lectern_sdf(p + h.xyy, base) - sg_lectern_sdf(p - h.xyy, base),
    sg_lectern_sdf(p + h.yxy, base) - sg_lectern_sdf(p - h.yxy, base),
    sg_lectern_sdf(p + h.yyx, base) - sg_lectern_sdf(p - h.yyx, base)
  ));
}

// Fixed world position, same pattern as sg_rocks_center(): one terrain-
// height sample per pixel, not per march step.
vec3 sg_lectern_base() {
  return vec3(SG_LECTERN_XZ.x, sg_terrain_height(SG_LECTERN_XZ), SG_LECTERN_XZ.y);
}
// @end

// @component sponge "The Sponge" "A 4-iteration Menger sponge — the thing worth hiding in, and the origin of this whole idea (docs/multiplayer-spec.md §7.1). Box-fold IFS, not a mesh: each iteration folds space into eighths and carves the cross-shaped middle third, the standard recursive construction unrolled to a fixed loop since neither shader language has recursion. Gated on uSpongeOn so solo pays nothing beyond one comparison (I3), same trick peers uses above."
const vec3  SG_SPONGE_CENTER = vec3(0.0, 1.9, 0.0);
const float SG_SPONGE_HALF   = 2.2;

uniform float uSpongeOn; // 0/1 — off in solo (I3); on for the room's hide-and-seek phase

float sg_box(vec3 p, vec3 b) {
  vec3 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
}

float sg_sponge_sdf(vec3 p) {
  if (uSpongeOn < 0.5) return 1.0e4; // uniform-valued branch: fully coherent, free (I3)

  vec3 lp = p - SG_SPONGE_CENTER;

  // Cheap spherical bound before paying for the 4-iteration fold below —
  // same purpose as every other component's bounding-sphere early-out,
  // just looser (the sponge is a full box, not a point cluster).
  float toC = length(lp);
  if (toC > SG_SPONGE_HALF * 1.8) return toC - SG_SPONGE_HALF * 1.6;

  // Normalize into a unit-box IFS space so the fold math below is the
  // textbook unit-cube Menger sponge, then rescale the resulting distance
  // back to world units (valid because an SDF scales linearly under
  // uniform scaling: sdf(p/s)*s == distance in the original space).
  vec3 up = lp / SG_SPONGE_HALF;
  float d = sg_box(up, vec3(1.0));
  float s = 1.0;
  for (int i = 0; i < 4; i++) {
    vec3 a = mod(up * s, 2.0) - 1.0;
    s *= 3.0;
    vec3 r = abs(1.0 - 3.0 * abs(a));
    float da = max(r.x, r.y);
    float db = max(r.y, r.z);
    float dc = max(r.z, r.x);
    float c = (min(da, min(db, dc)) - 1.0) / s;
    d = max(d, c);
  }
  return d * SG_SPONGE_HALF;
}

vec3 sg_sponge_normal(vec3 p) {
  const float e = 0.0025;
  vec2 h = vec2(e, 0.0);
  return normalize(vec3(
    sg_sponge_sdf(p + h.xyy) - sg_sponge_sdf(p - h.xyy),
    sg_sponge_sdf(p + h.yxy) - sg_sponge_sdf(p - h.yxy),
    sg_sponge_sdf(p + h.yyx) - sg_sponge_sdf(p - h.yyx)
  ));
}
// @end

// ---- scene wiring below: not itself a component, just the raymarch that
// composes the components above and the probe-encode branch in mainImage. ----

const float SG_MAX_DIST = 20.0;
const float SG_FOG_DIST = 6.0; // aerial-perspective falloff scale, tuned to the diorama's own depth (a few units), not the march's far clip

struct SGHit { float t; float id; };

// MP-5 (docs/multiplayer-spec.md §7.3): minimum distance across every
// raymarch candidate, ignoring which one is closest — the ray-origin escape
// below only needs "is this point inside solid", not a hit id, so it calls
// this instead of duplicating the candidate list sg_march's own per-step
// loop tracks (which DOES need hitKind, right next to the code that reads
// it — see below).
float sg_scene_min(vec3 p, vec3 charCenter, float pondWaterY, vec3 rockCenter, vec3 peerCenter[7], vec3 lecternBase) {
  float d = p.y - sg_terrain_height(p.xz);
  d = min(d, sg_character_sdf(p, charCenter));
  d = min(d, sg_pond_sdf(p, pondWaterY));
  d = min(d, sg_rocks_sdf(p, rockCenter));
  d = min(d, sg_peers_dist(p, peerCenter));
  d = min(d, sg_lectern_sdf(p, lecternBase));
  d = min(d, sg_sponge_sdf(p));
  return d;
}

SGHit sg_march(vec3 ro, vec3 rd, vec3 charCenter, float pondWaterY, vec3 rockCenter, vec3 peerCenter[7], vec3 lecternBase) {
  // PERF-2: fixed 88-step loop bound unchanged (High == pre-SG_QUALITY
  // behavior); Low/Medium exit after fewer steps, same fallback path a ray
  // that legitimately exhausts 88 steps already takes below.
  int maxSteps = SG_QUALITY < 0.5 ? 44 : (SG_QUALITY < 1.5 ? 66 : 88);
  // PERF-2, exact (not an approximation): the heightfield's per-step noise
  // (sg_terrain_height, 5 octaves) is the single most expensive call in this
  // march, and it runs unconditionally every step even for sky rays. Once a
  // ray is strictly ascending (rd.y > 0) and already above the highest point
  // this frame's TERRAIN_SCALE can ever produce, terrain is analytically
  // unreachable for the rest of the march — dTerrain would only ever grow
  // from here, so skipping straight to a sentinel is not a visual
  // approximation, it's the same "terrain isn't the nearest surface"
  // conclusion the real computation would reach, without paying for it.
  // CONTRACT: this bound assumes sg_biome_hills() stays within [0,1] (the
  // pristine body and both shipped terrain variants clamp to that). An
  // edited terrain body exceeding 1.0 will see ascending rays skip terrain
  // that is actually reachable — clamp your biome function, not this ceil.
  float terrainCeil = SG_TERRAIN_HEIGHT_RNG * max(TERRAIN_SCALE, 0.05) + 0.02;
  float t = 0.05;

  // MP-5 §7.3: there is no collision (docs/multiplayer-spec.md §7.2 — a
  // hand-mirrored JS collision check would drift the same way index.js's
  // own comments already reject for SG_POND_XZ/SG_ROCK_XZ, and GPU readback
  // per frame isn't viable). So `ro` can land inside solid (most likely the
  // sponge, but this is written against sg_scene_min, not "is it the
  // sponge specifically"). An SDF march started inside solid never
  // converges — d stays negative-ish/near-zero forever and the loop below
  // either exhausts its step budget on garbage or free-falls through the
  // hit threshold on the wrong side. Bounded (8 iterations), cheap, and a
  // no-op whenever `ro` starts in open air (the very first sg_scene_min
  // call already clears 0.01). Distance-driven step (§0.5 C3): advancing by
  // the actual (negative) distance magnitude, floored at 0.02 so it can
  // never stall, guarantees the ray reaches the surface from anywhere
  // inside the sponge (half-extent 2.2) well within 8 steps — a fixed
  // 0.06 epsilon only ever covers 0.48 units total and does not.
  for (int i = 0; i < 8; i++) {
    float dEsc = sg_scene_min(ro + rd * t, charCenter, pondWaterY, rockCenter, peerCenter, lecternBase);
    if (dEsc > 0.01) break;
    t += max(abs(dEsc), 0.02);
  }

  float hitKind = COMP_TERRAIN; // which candidate was closest last — decides the fallback below
  for (int i = 0; i < 88; i++) {
    if (i >= maxSteps) break;
    vec3 p = ro + rd * t;
    float dTerrain = (rd.y > 0.0 && p.y > terrainCeil) ? 1.0e4 : (p.y - sg_terrain_height(p.xz));
    float dChar = sg_character_sdf(p, charCenter);
    float dPond = sg_pond_sdf(p, pondWaterY);
    float dRock = sg_rocks_sdf(p, rockCenter);
    float peerHue;
    float dPeers = sg_peers_sdf(p, peerCenter, peerHue);
    float dLectern = sg_lectern_sdf(p, lecternBase);
    float dSponge = sg_sponge_sdf(p);

    float d = dTerrain;
    hitKind = COMP_TERRAIN;
    if (dChar < d) { d = dChar; hitKind = COMP_CHARACTER; }
    if (dPond < d) { d = dPond; hitKind = COMP_POND; }
    if (dRock < d) { d = dRock; hitKind = COMP_ROCKS; }
    if (dPeers < d) { d = dPeers; hitKind = COMP_PEERS; }
    if (dLectern < d) { d = dLectern; hitKind = COMP_LECTERN; }
    if (dSponge < d) { d = dSponge; hitKind = COMP_SPONGE; }

    // Adaptive threshold (looser far away) — standard sphere-tracing
    // tolerance, needed here because dTerrain is a vertical-distance
    // approximation, not a true SDF, so it undershoots less predictably at
    // grazing angles than the other candidates' real SDFs do.
    if (d < max(0.002, t * 0.002)) {
      if (hitKind != COMP_TERRAIN) return SGHit(t, hitKind);
      break; // terrain hit — refine below, the heightfield march overshoots on slopes
    }
    t += max(d * 0.5, 0.01);
    if (t > SG_MAX_DIST) return SGHit(SG_MAX_DIST, COMP_SKY);
  }

  // A non-terrain hit that never converged inside the loop above (e.g. the
  // character's non-uniform squash/stretch scaling underestimates true
  // distance near its blend regions, so it can need more steps than a
  // plain sphere would) — return it as-is rather than falling into the
  // terrain-only bisection below, which would bisect the wrong surface.
  if (hitKind != COMP_TERRAIN) return SGHit(t, hitKind);

  // Bisection refine: the coarse loop above stops somewhere past the true
  // surface (a heightfield's vertical distance isn't a real SDF), which
  // otherwise shows up as banding across shallow slopes. Six bisections
  // against the actual height function remove it, same trick
  // biome-rolling-hills itself uses for its own (much larger-scale) march.
  float t0 = max(t - 0.3, 0.0), t1 = t;
  for (int i = 0; i < 6; i++) {
    float tm = (t0 + t1) * 0.5;
    vec3 pm = ro + rd * tm;
    if (pm.y < sg_terrain_height(pm.xz)) t1 = tm; else t0 = tm;
  }
  return SGHit((t0 + t1) * 0.5, COMP_TERRAIN);
}

// Wave-4 §B: three camera modes, each computing its own (target, ro) pair —
// mainImage picks the active pair via uCamMode and cross-blends toward it
// using uCamBlend (see mainImage below). Computed entirely in-shader: no
// per-mode JS math beyond picking the mode and driving the transition
// blend, so movement/camera both stay uniform-only on the hot path.
struct SGCam { vec3 target; vec3 ro; };

// Orbit: today's exact camera, extracted verbatim — byte-identical output,
// just relocated into its own function so Follow/Overview share the same
// calling convention.
SGCam sg_cam_orbit(vec3 charCenter, float dragYaw, float dragPitch) {
  float yaw = iTime * 0.07 + dragYaw;
  float pitch = clamp(0.42 + dragPitch, 0.08, 1.15);
  vec3 target = mix(vec3(0.0, sg_terrain_height(vec2(uCharPosX, uCharPosZ)), 0.0), charCenter, 0.6);
  float radius = 3.6;
  vec3 ro = target + radius * vec3(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
  return SGCam(target, ro);
}

// Follow: third-person, framed behind the character along ITS OWN facing
// (uCharYaw, wave-4 §A) — not an independent auto-drift. dragYaw/dragPitch
// still let the visitor look around without losing the follow framing.
SGCam sg_cam_follow(vec3 charCenter, float dragYaw, float dragPitch) {
  float yaw = uCharYaw + 3.14159265 + dragYaw; // "behind" = opposite the character's facing
  float pitch = clamp(0.30 + dragPitch, 0.08, 0.9);
  vec3 target = charCenter + vec3(0.0, 0.15, 0.0); // aim slightly above center (chest/head), not feet
  float radius = 2.0; // tighter than orbit's 3.6 — reads as "with" the character, not surveying
  vec3 ro = target + radius * vec3(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
  return SGCam(target, ro);
}

// Overview: high, architectural, looking down at the whole diorama's
// centroid (not the character specifically) — for probing/connections.
SGCam sg_cam_overview(vec3 charCenter) {
  vec3 target = vec3(1.2, 0.3, 0.7); // diorama's rough centroid (between pond/rocks/character range)
  vec3 ro = target + vec3(0.0, 4.2, 0.001); // near-top-down; tiny z avoids a degenerate up-vector
  return SGCam(target, ro);
}

// MP-2/3 (docs/multiplayer-spec.md §4.1/§5.1): every peer and the lectern's
// glow are identified by a bare 0..1 hue scalar over the wire (§0.2 —
// flattened, scalar-only), so shading needs its own hue->rgb, not a texture
// lookup. Pure-hue HSV->RGB at S=1,V=1 — the classic six-piecewise-linear
// formula, not a color-managed conversion; callers lighten/mix it further
// (see COMP_PEERS/COMP_LECTERN below) rather than shading a fully saturated
// color directly.
vec3 sg_hue_rgb(float hue) {
  return clamp(abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

vec3 sg_light(vec3 pos, vec3 rd, vec3 N, vec3 matCol, float t) {
  vec3 sun_dir = normalize(vec3(0.55, 0.42, 0.35));
  vec3 sky_col = vec3(0.45, 0.62, 0.90);
  vec3 sun_col = vec3(1.4, 1.15, 0.85);

  float diff = max(dot(N, sun_dir), 0.0);
  float amb  = 0.38 + 0.32 * N.y;
  vec3 H = normalize(sun_dir - rd);
  float spec = pow(max(dot(N, H), 0.0), 28.0) * 0.10;

  vec3 col = matCol * (sky_col * amb + sun_col * diff) + sun_col * spec;

  // Aerial perspective at diorama scale — the whole scene lives within a
  // handful of units, so this fades out against SG_FOG_DIST, not the
  // march's SG_MAX_DIST (which would barely register this close in).
  float fog = 1.0 - exp(-t / SG_FOG_DIST);
  return mix(col, sg_sky_color(rd, iTime) * 0.9, clamp(fog, 0.0, 1.0));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Drag offset read straight off iMouse, shared by every camera mode — the
  // drag offset persists after release (iMouse.xy keeps the last drag
  // position even once z/w go negative), so letting go of the mouse leaves
  // the view where you put it.
  float dragYaw = 0.0, dragPitch = 0.0;
  if (iMouse.z != 0.0) {
    float pressX = abs(iMouse.z), pressY = abs(iMouse.w);
    dragYaw   = -(iMouse.x - pressX) * 0.006;
    dragPitch =  (iMouse.y - pressY) * 0.006;
  }

  vec3 charCenter = sg_character_center(iTime);
  float pondWaterY = sg_pond_water_y(SG_POND_XZ);
  vec3 rockCenter = sg_rocks_center();
  vec3 lecternBase = sg_lectern_base();

  // MP-2 §4.2: precomputed once per pixel, exactly like charCenter/
  // rockCenter above — see sg_peers_sdf's own comment for why this must
  // never move into the march's per-step loop. uPeerCount gates the whole
  // block behind one comparison so solo pays the same single branch
  // sg_peers_sdf itself pays (I3).
  vec3 peerCenter[7];
  peerCenter[0] = vec3(0.0); peerCenter[1] = vec3(0.0); peerCenter[2] = vec3(0.0); peerCenter[3] = vec3(0.0);
  peerCenter[4] = vec3(0.0); peerCenter[5] = vec3(0.0); peerCenter[6] = vec3(0.0);
  if (uPeerCount > 0.5) {
    if (uPeer0Act > 0.5) peerCenter[0] = sg_peer_center(uPeer0X, uPeer0Z);
    if (uPeer1Act > 0.5) peerCenter[1] = sg_peer_center(uPeer1X, uPeer1Z);
    if (uPeer2Act > 0.5) peerCenter[2] = sg_peer_center(uPeer2X, uPeer2Z);
    if (uPeer3Act > 0.5) peerCenter[3] = sg_peer_center(uPeer3X, uPeer3Z);
    if (uPeer4Act > 0.5) peerCenter[4] = sg_peer_center(uPeer4X, uPeer4Z);
    if (uPeer5Act > 0.5) peerCenter[5] = sg_peer_center(uPeer5X, uPeer5Z);
    if (uPeer6Act > 0.5) peerCenter[6] = sg_peer_center(uPeer6X, uPeer6Z);
  }

  // Wave-4 §B: uCamMode picks the active camera; uCamBlend cross-fades FROM
  // whatever uPrevCamMode's camera would be AT THIS INSTANT to the new mode
  // — both computed fresh every frame (cheap: each is ~5 flops, not a
  // march), so no stored "previous camera" state is needed beyond the
  // uPrevCamMode uniform itself.
  vec3 target, ro;
  if (uCamMode < 0.5 && uPrevCamMode < 0.5) {
    // Byte-identical fast path for the default/settled-Orbit state: the
    // EXACT pre-wave-4 expression, untouched — verified empirically
    // (garden-locomotion-parity.mjs test (1)) that routing this case
    // through sg_cam_orbit()+mix() instead, while mathematically the same,
    // let the compiler re-associate a handful of pixels by a single ULP.
    // Literal code preservation sidesteps that risk entirely rather than
    // trusting float re-association to be harmless.
    float yaw = iTime * 0.07 + dragYaw;
    float pitch = clamp(0.42 + dragPitch, 0.08, 1.15);
    target = mix(vec3(0.0, sg_terrain_height(vec2(uCharPosX, uCharPosZ)), 0.0), charCenter, 0.6);
    float radius = 3.6;
    ro = target + radius * vec3(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
  } else {
    // if/else, not a ternary chain: ESSL 3.00 (WebGL2) disallows `?:` on structures.
    SGCam camA;
    if (uCamMode < 0.5) camA = sg_cam_orbit(charCenter, dragYaw, dragPitch);
    else if (uCamMode < 1.5) camA = sg_cam_follow(charCenter, dragYaw, dragPitch);
    else camA = sg_cam_overview(charCenter);
    SGCam camB;
    if (uPrevCamMode < 0.5) camB = sg_cam_orbit(charCenter, dragYaw, dragPitch);
    else if (uPrevCamMode < 1.5) camB = sg_cam_follow(charCenter, dragYaw, dragPitch);
    else camB = sg_cam_overview(charCenter);
    target = mix(camB.target, camA.target, uCamBlend);
    ro = mix(camB.ro, camA.ro, uCamBlend);
  }
  vec3 fwd = normalize(target - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  vec3 rd = normalize(fwd + uv.x * right * 1.35 + uv.y * up * 1.35);

  SGHit hit = sg_march(ro, rd, charCenter, pondWaterY, rockCenter, peerCenter, lecternBase);
  vec3 col;
  float compId;

  if (hit.id == COMP_SKY) {
    col = sg_sky_color(rd, iTime);
    compId = COMP_SKY;

    float cloudMask = sg_cloud_mask(rd);
    if (cloudMask > 0.01) {
      col = mix(col, vec3(0.97, 0.97, 1.0), cloudMask);
      if (cloudMask > 0.35) compId = COMP_CLOUDS;
    }
  } else {
    vec3 pos = ro + rd * hit.t;
    vec3 N;
    vec3 matCol;
    float grassMask = 0.0;

    if (hit.id == COMP_TERRAIN) {
      N = sg_terrain_normal(pos.xz, 0.02);
      float terrH = sg_terrain_height(pos.xz);
      matCol = sg_terrain_color(pos.xz, terrH, N);
      float height01 = clamp(terrH / SG_TERRAIN_HEIGHT_RNG, 0.0, 1.0);
      float slope = 1.0 - clamp(N.y, 0.0, 1.0);
      grassMask = sg_grass_mask(height01, slope);
      if (grassMask > 0.02) matCol = sg_grass_shade(pos.xz, N, matCol, grassMask);
    } else if (hit.id == COMP_CHARACTER) {
      N = sg_character_normal(pos, charCenter);
      matCol = vec3(0.86, 0.46, 0.22); // warm clay — the figure reads as one object at a glance
    } else if (hit.id == COMP_POND) {
      N = sg_pond_normal(pos.xz);
      matCol = vec3(0.0); // unused below — the pond skips the terrestrial lighting model entirely
    } else if (hit.id == COMP_ROCKS) {
      N = sg_rocks_normal(pos, rockCenter);
      matCol = mix(vec3(0.40, 0.39, 0.37), vec3(0.62, 0.58, 0.52), clamp(ROCK_ROUNDNESS, 0.0, 1.0));
    } else if (hit.id == COMP_PEERS) {
      N = sg_peers_normal(pos, peerCenter);
      float peerHue;
      sg_peers_sdf(pos, peerCenter, peerHue); // re-derive at the exact hit point — sg_march only kept a distance/id, not the hue
      matCol = sg_hue_rgb(peerHue) * 0.7 + vec3(0.18); // lightened tint, same "reads as one object" intent as the local character's warm clay
    } else if (hit.id == COMP_LECTERN) {
      N = sg_lectern_normal(pos, lecternBase);
      vec3 stone = vec3(0.50, 0.49, 0.47);
      matCol = mix(stone, sg_hue_rgb(uLeaseHue), clamp(uLeaseHeld, 0.0, 1.0) * 0.85);
    } else { // COMP_SPONGE
      N = sg_sponge_normal(pos);
      matCol = mix(vec3(0.30, 0.32, 0.28), vec3(0.55, 0.58, 0.52), clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
    }

    // Water is a planar reflection, not a diffuse-lit surface — running it
    // through sg_light would double up the sky contribution it already
    // samples directly.
    col = (hit.id == COMP_POND) ? sg_pond_color(rd, N) : sg_light(pos, rd, N, matCol, hit.t);
    compId = hit.id;

    // MP-3 §5.1: the lectern glows with the holder's hue rather than just
    // tinting flat-lit stone — sg_light's ambient+diffuse alone reads as
    // "grey rock painted a color", not "lit from within". Small, additive,
    // gated the same as the material mix above.
    if (hit.id == COMP_LECTERN && uLeaseHeld > 0.5) {
      col += sg_hue_rgb(uLeaseHue) * 0.22;
    }

    if (hit.id == COMP_TERRAIN) {
      if (grassMask > 0.4) compId = COMP_GRASS;

      float shadowF = sg_shadow_factor(pos.xz);
      col = mix(col, col * 0.32, shadowF);
      if (shadowF > 0.45) compId = COMP_SHADOW;
    }

    // uProbeSel highlight: a fresnel rim-light on whichever component is
    // currently selected in the probe panel, pulsing gently at ~1Hz. Skipped
    // for sky/clouds above (no surface or normal to rim there) — this branch
    // only ever runs for hit components with real geometry.
    if (uProbeSel > 0.5 && abs(compId - uProbeSel) < 0.5) {
      float fres = pow(1.0 - max(dot(N, -rd), 0.0), 2.5);
      float pulse = 0.7 + 0.3 * sin(iTime * 6.283185);
      col += vec3(0.30, 0.85, 1.0) * fres * pulse * 0.6;
    }
  }

  // Probe frame: encode compId in the red channel (0..255 -> 0..1, exact at
  // 8-bit precision for the handful of ids in play) and bail before any of
  // the shading below touches it — a probe frame is never meant to be seen.
  if (uProbe > 0.5) {
    fragColor = vec4(compId / 255.0, 0.0, 0.0, 1.0);
    return;
  }

  vec2 vigUv = fragCoord / iResolution.xy;
  float vig = 1.0 - 0.30 * dot(vigUv - 0.5, vigUv - 0.5) * 4.0;
  col *= clamp(vig, 0.0, 1.0);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  fragColor = vec4(col, 1.0);
}
