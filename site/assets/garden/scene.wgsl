// GARDEN-0 — the probe-able showcase scene ("/garden"), WGSL port of
// scene.glsl. Defines mainImage(fragCoord) -> vec4f; reads U.*.
//
// Annotation convention (parsed by js/organs/garden/parse.js, documented in
// ARCHITECTURE.md § "The Garden") — kept BYTE-IDENTICAL to scene.glsl's own
// @component/@tune/@end comment lines so parse.js yields the same component
// list, same ids, same tune metadata from either file:
//   // @component <id> "<display name>" "<one-line blurb>"   ...body...   // @end
//   // @tune <NAME> <min> <max> <default> "<label>"
//
// WGSL has no free-standing named-uniform binding model — GLSL's arbitrary
// `uniform float NAME;` + getUniformLocation-by-name has no direct
// equivalent, so every @tune slider and the two probe toggles below are
// backed by one fixed 16-float bank (`U.custom`, see runtime/wrap.js) and
// exposed as zero-arg accessor functions instead of bare uniform reads —
// `TERRAIN_ROUGHNESS()` here reads exactly the value GLSL's bare
// `TERRAIN_ROUGHNESS` does. The `@sg-uniforms` line below is a
// webgpu.js-only convention (parsed by wrap.js), invisible to parse.js —
// it assigns each name a bank slot by position.
//
// Component ids are assigned by file order (1 = first @component seen, and
// so on) — the numeric COMP_* constants below MUST stay in that same order,
// same invariant as scene.glsl (see its own header for why).
//
// World scale is a tabletop diorama, not the biome-rolling-hills flyover it
// borrows its noise from: terrain height ~0-2 units, camera orbit radius
// ~3.6 units.

// @sg-uniforms uProbe uProbeSel TERRAIN_ROUGHNESS TERRAIN_SCALE BOUNCE_HEIGHT BOUNCE_SPEED SHADOW_SOFTNESS POND_RIPPLE POND_TINT_MIX GRASS_SWAY_SPEED CLOUD_COVERAGE ROCK_ROUNDNESS

// uProbe(): 0 = normal shading, 1 = probe frame (encode compId, no lighting)
// uProbeSel(): 0 = nothing selected, otherwise a COMP_* id — the matching
// component gets a fresnel rim-light in the normal shading path below.

const COMP_SKY: f32       = 1.0;
const COMP_TERRAIN: f32   = 2.0;
const COMP_CHARACTER: f32 = 3.0;
const COMP_SHADOW: f32    = 4.0;
const COMP_POND: f32      = 5.0;
const COMP_GRASS: f32     = 6.0;
const COMP_CLOUDS: f32    = 7.0;
const COMP_ROCKS: f32     = 8.0;

// @component sky "Sky & Atmosphere" "A gradient horizon-to-zenith plus a squinted-power sun disc — the cheapest possible sky that still reads as one. No clouds, no scattering sim: one lerp, one pow(), and an additive sun term."
fn sg_sky_color(rd: vec3f, time: f32) -> vec3f {
  let h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  let horizon = vec3f(0.72, 0.82, 0.92);
  let zenith  = vec3f(0.20, 0.42, 0.82);
  var col = mix(horizon, zenith, h * h);

  let sun_dir = normalize(vec3f(0.55, 0.42, 0.35));
  let sun = pow(max(dot(rd, sun_dir), 0.0), 340.0);
  col += vec3f(1.5, 1.15, 0.75) * sun;

  // A slow drift in the horizon tint stands in for time-of-day — cheap
  // atmosphere without a real scattering model.
  col += vec3f(0.03, 0.015, 0.0) * sin(time * 0.05);
  return col;
}
// @end

// @component terrain "Rolling Hills (evolved)" "The heightfield is FunSearch-evolved fractal noise, not hand-tuned — lifted from kernel biome-rolling-hills (fitness 0.9994). Rescaled here from a kilometers-wide flyover to a few-meter garden patch; the only change to the noise itself: its octave persistence (originally the constant 0.53) now drives the roughness slider below."
// From biome-rolling-hills (kernels.json), renamed sg_* to avoid colliding
// with anything else on the page. One deliberate edit: the kernel's
// hardcoded octave persistence (a *= 0.53) became TERRAIN_ROUGHNESS.
fn sg_hash(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
fn sg_noise2(x: vec2f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * f * (10.0 - 15.0 * f + 6.0 * f * f);
  return mix(mix(sg_hash(i.x + i.y * 57.0),       sg_hash(i.x + 1.0 + i.y * 57.0),       f.x),
             mix(sg_hash(i.x + (i.y + 1.0) * 57.0), sg_hash(i.x + 1.0 + (i.y + 1.0) * 57.0), f.x), f.y);
}

// @tune TERRAIN_ROUGHNESS 0.35 0.72 0.53 "fractal persistence — how much each noise octave hands down to the next"

fn sg_biome_hills(p_in: vec2f) -> f32 {
  var p = p_in;
  var v = 0.0;
  var a = 0.58;
  for (var i = 0; i < 5; i = i + 1) {
    v = v + a * sg_noise2(p);
    p = vec2f(p.x * 1.78 + p.y * 0.35, p.x * 0.35 + p.y * 1.78);
    a = a * TERRAIN_ROUGHNESS();
  }
  return clamp(v, 0.0, 1.0);
}

// @tune TERRAIN_SCALE 0.4 2.0 1.0 "vertical exaggeration of the evolved heightfield"

const SG_TERRAIN_INV_SCALE: f32 = 1.0 / 4.4;
const SG_TERRAIN_HEIGHT_RNG: f32 = 1.9;

fn sg_terrain_height(xz: vec2f) -> f32 {
  return sg_biome_hills(xz * SG_TERRAIN_INV_SCALE) * SG_TERRAIN_HEIGHT_RNG * max(TERRAIN_SCALE(), 0.05);
}

fn sg_terrain_normal(xz: vec2f, eps: f32) -> vec3f {
  let h0 = sg_terrain_height(xz);
  let hx = sg_terrain_height(xz + vec2f(eps, 0.0));
  let hz = sg_terrain_height(xz + vec2f(0.0, eps));
  return normalize(vec3f(h0 - hx, eps, h0 - hz));
}

fn sg_terrain_color(xz: vec2f, height: f32, N: vec3f) -> vec3f {
  let height01 = clamp(height / SG_TERRAIN_HEIGHT_RNG, 0.0, 1.0);
  let slope = 1.0 - clamp(N.y, 0.0, 1.0);
  var col = mix(vec3f(0.42, 0.58, 0.22), vec3f(0.27, 0.40, 0.19), height01);
  col = mix(col, vec3f(0.30, 0.23, 0.17), smoothstep(0.35, 0.7, slope));
  col = mix(col, vec3f(0.86, 0.90, 0.94), smoothstep(0.78, 0.95, height01) * smoothstep(0.5, 0.25, slope));
  return col;
}
// @end

// @component character "Bouncing Figure" "Six smooth-blended primitives (head, torso, two arms, two legs), no mesh, no skeleton. Parabolic height keeps the hop physically believable; a cosine drives squash-and-stretch so the same handful of spheres and capsules reads as alive."
fn sg_smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
fn sg_sphere(p: vec3f, c: vec3f, r: f32) -> f32 { return length(p - c) - r; }
fn sg_capsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// @tune BOUNCE_HEIGHT 0.15 1.1 0.55 "apex height of the hop above the ground"
// @tune BOUNCE_SPEED 0.4 2.5 1.1 "hops per second (roughly)"

const SG_LEG_LEN: f32 = 0.5;
const SG_CHAR_XZ: vec2f = vec2f(0.0);

// Bounce phase in [0, 1); a parabola of this (4t(1-t)) is the actual
// trajectory of a ball under constant gravity between two ground contacts —
// the same curve, not an approximation of one.
fn sg_bounce_phase(time: f32) -> f32 { return fract(time * BOUNCE_SPEED() * 0.5); }

// center is precomputed once per pixel by the caller (mainImage) — it only
// depends on U.time, not on p, and this is called once per raymarch step;
// recomputing sg_terrain_height() (a 5-octave noise loop) that often was
// the single biggest cost in the whole scene.
fn sg_character_sdf(p: vec3f, center: vec3f) -> f32 {
  let t = sg_bounce_phase(U.time);

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
  let SG_CHAR_BOUND_R: f32 = 0.95;
  let SG_CHAR_BOUND_MARGIN: f32 = 0.1;
  let toCenter = length(p - center);
  if (toCenter > SG_CHAR_BOUND_R + SG_CHAR_BOUND_MARGIN) { return toCenter - SG_CHAR_BOUND_R; }

  // Squash at ground contact (t=0/1), stretch at the apex (t=0.5) — the
  // classic cartoon convention, not literal velocity (velocity is actually
  // highest at contact) — it reads as "alive", which is the point.
  let phase = cos(t * 6.28318530718);
  let scaleY  = mix(0.72, 1.18, (1.0 - phase) * 0.5);
  let scaleXZ = mix(1.20, 0.90, (1.0 - phase) * 0.5);

  var lp = p - center;
  lp.y = lp.y / scaleY;
  lp = vec3f(lp.x / scaleXZ, lp.y, lp.z / scaleXZ);

  let k = 0.075; // one smooth-min radius for the whole figure's "softness"
  var d = sg_capsule(lp, vec3f(0.0, -0.04, 0.0), vec3f(0.0, 0.28, 0.0), 0.165);
  d = sg_smin(d, sg_sphere(lp, vec3f(0.0, 0.50, 0.0), 0.155), k);

  let swing = sin(U.time * 3.1);
  d = sg_smin(d, sg_capsule(lp, vec3f( 0.24, 0.24, 0.0), vec3f( 0.27 + 0.07 * swing, -0.12,  0.13 * swing), 0.062), k);
  d = sg_smin(d, sg_capsule(lp, vec3f(-0.24, 0.24, 0.0), vec3f(-0.27 - 0.07 * swing, -0.12, -0.13 * swing), 0.062), k);

  let tuck = smoothstep(0.12, 0.5, min(t, 1.0 - t)); // legs draw up mid-flight, extend for landing
  d = sg_smin(d, sg_capsule(lp, vec3f( 0.11, -0.04, 0.0), vec3f( 0.11, -0.5 + 0.24 * tuck,  0.07 * tuck), 0.075), k);
  d = sg_smin(d, sg_capsule(lp, vec3f(-0.11, -0.04, 0.0), vec3f(-0.11, -0.5 + 0.24 * tuck, -0.07 * tuck), 0.075), k);

  return d * min(scaleY, scaleXZ); // conservative distance correction for the non-uniform scale
}

fn sg_character_normal(p: vec3f, center: vec3f) -> vec3f {
  let e = 0.0025;
  let h = vec2f(e, 0.0);
  return normalize(vec3f(
    sg_character_sdf(p + h.xyy, center) - sg_character_sdf(p - h.xyy, center),
    sg_character_sdf(p + h.yxy, center) - sg_character_sdf(p - h.yxy, center),
    sg_character_sdf(p + h.yyx, center) - sg_character_sdf(p - h.yyx, center)
  ));
}

// The figure's world-space center for the current frame — computed once
// (one sg_terrain_height() call) and threaded through the march and shading
// instead of re-derived from U.time everywhere it's needed.
fn sg_character_center(time: f32) -> vec3f {
  let t = sg_bounce_phase(time);
  let arc = 4.0 * BOUNCE_HEIGHT() * t * (1.0 - t);
  return vec3f(SG_CHAR_XZ.x, sg_terrain_height(SG_CHAR_XZ) + SG_LEG_LEN + arc, SG_CHAR_XZ.y);
}
// @end

// @component shadow "Blob Shadow" "No shadow ray, no depth buffer — just distance from the hit point to the character's ground projection, softened by how high the character currently is. Cheap and, at this camera distance, indistinguishable from the real thing."
// @tune SHADOW_SOFTNESS 0.4 2.5 1.0 "radius of the contact shadow beneath the figure"

fn sg_shadow_factor(xz: vec2f) -> f32 {
  let t = sg_bounce_phase(U.time);
  let arc = 4.0 * BOUNCE_HEIGHT() * t * (1.0 - t);
  let r = max(0.30 * SHADOW_SOFTNESS() * (1.0 + arc * 0.7), 0.05);
  let d = length(xz - SG_CHAR_XZ);
  let shadow = 1.0 - smoothstep(0.0, r, d);
  return shadow * mix(1.0, 0.35, clamp(arc / max(BOUNCE_HEIGHT(), 0.05), 0.0, 1.0));
}
// @end

// @component pond "Pond" "A small still-water pool set into a shallow terrain depression — no wave simulation, just a flat disk sunk below the surrounding ground and a planar reflection of the sky. The ripples are a normal-map trick: the water plane itself never moves."
const SG_POND_XZ: vec2f = vec2f(1.7, 0.5);
const SG_POND_RADIUS: f32 = 0.5;
const SG_POND_DEPTH: f32 = 0.12;

// @tune POND_RIPPLE 0.0 0.05 0.015 "ripple normal-perturbation strength"
// @tune POND_TINT_MIX 0.0 1.0 0.35 "how much the water's own tint shows through the sky reflection"

// Sampled once per frame from the terrain at the pond's center (see
// mainImage) — sunk slightly below it so the disk reads as filling a
// depression, not floating on top of the ground.
fn sg_pond_water_y(xz: vec2f) -> f32 {
  return sg_terrain_height(xz) - SG_POND_DEPTH;
}

// A flat, disk-shaped body of water. Not an exact SDF near the rim (it
// mildly overestimates there), which is fine at this march's tolerance —
// the terrain component uses the same kind of approximation for a much
// bigger feature, for the same reason.
fn sg_pond_sdf(p: vec3f, waterY: f32) -> f32 {
  let radial = length(p.xz - SG_POND_XZ) - SG_POND_RADIUS;
  let vert = p.y - waterY;
  return length(vec2f(max(radial, 0.0), vert));
}

fn sg_pond_normal(xz: vec2f) -> vec3f {
  let n2 = vec2f(sg_noise2(xz * 6.0 + U.time * 0.6),
                  sg_noise2(xz * 6.0 + vec2f(19.3, -7.1) - U.time * 0.5)) - 0.5;
  return normalize(vec3f(n2.x * POND_RIPPLE() * 4.0, 1.0, n2.y * POND_RIPPLE() * 4.0));
}

// Cheap planar-reflection approximation: reflect the view ray and sample
// the sky — no scene geometry in the reflection, just enough to read as
// "water" once mixed with the pond's own tint.
fn sg_pond_color(rd: vec3f, N: vec3f) -> vec3f {
  let R = reflect(rd, N);
  let refl = sg_sky_color(R, U.time);
  let tint = vec3f(0.08, 0.20, 0.24);
  return mix(refl, tint, clamp(POND_TINT_MIX(), 0.0, 1.0));
}
// @end

// @component grass "Meadow Sway" "A shading trick, not per-blade geometry: a wind-swayed color and normal wobble on the flattest, lowest patches of terrain. Cheap 2D noise offset by time stands in for blades bending in the wind — it only runs where terrain already shaded, no extra march-time cost."
// @tune GRASS_SWAY_SPEED 0.2 3.0 1.0 "wind sway animation speed"

// 1 on flat, low ground; 0 near cliffs (the same slope test sg_terrain_color
// uses) and near the snow line — grass grows in the meadow, not on exposed rock.
fn sg_grass_mask(height01: f32, slope: f32) -> f32 {
  let flatness = 1.0 - smoothstep(0.15, 0.55, slope);
  let lowland  = 1.0 - smoothstep(0.30, 0.62, height01);
  return flatness * lowland;
}

// N is a pointer (WGSL has no `inout`) — the "wobble" half of wind-swayed
// grass mutates it in place, same as the GLSL original's `inout vec3 N`.
fn sg_grass_shade(xz: vec2f, N: ptr<function, vec3f>, baseCol: vec3f, mask: f32) -> vec3f {
  let wind = sg_noise2(xz * 2.2 + vec2f(U.time * GRASS_SWAY_SPEED() * 0.6, 0.0));
  let bladeCol = mix(vec3f(0.34, 0.52, 0.18), vec3f(0.48, 0.62, 0.22), wind);
  let wobble = (vec2f(sg_noise2(xz * 3.1 + U.time * GRASS_SWAY_SPEED()),
                       sg_noise2(xz * 3.1 + 5.2 - U.time * GRASS_SWAY_SPEED())) - 0.5) * 0.10 * mask;
  (*N) = normalize((*N) + vec3f(wobble.x, 0.0, wobble.y));
  return mix(baseCol, bladeCol, mask * (0.55 + 0.25 * wind));
}
// @end

// @component clouds "Drifting Clouds" "2D fbm drifting across a plane projected from the view ray — no volumetrics, just a coverage threshold blended into the sky color. Shading-time only: it runs once per sky pixel, never inside the raymarch."
// @tune CLOUD_COVERAGE 0.0 1.0 0.45 "fraction of the sky covered by cloud"

fn sg_cloud_fbm(p_in: vec2f) -> f32 {
  var p = p_in;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 3; i = i + 1) {
    v = v + a * sg_noise2(p);
    p = p * 2.03 + vec2f(11.0, 7.0);
    a = a * 0.5;
  }
  return v;
}

// rd.y < 0.05 rejects below-horizon rays before paying for the fbm at all —
// sky-hit rays are never far below horizontal anyway (see sg_march: anything
// steeply downward hits the terrain's heightfield long before SG_MAX_DIST),
// so this mostly just guards the horizon seam cheaply.
fn sg_cloud_mask(rd: vec3f) -> f32 {
  if (rd.y < 0.05) { return 0.0; }
  let p = rd.xz / max(rd.y, 0.15) * 0.6 + vec2f(U.time * 0.02, U.time * 0.01);
  let n = sg_cloud_fbm(p);
  let edge = 1.0 - clamp(CLOUD_COVERAGE(), 0.0, 1.0);
  return smoothstep(edge, edge + 0.25, n);
}
// @end

// @component rocks "Weathered Rocks" "A 2-4 sphere smooth-blend near the pond's edge — the same smooth-min trick as the bouncing figure's body, but static. One radius controls how sharp vs. weathered the cluster reads."
// @tune ROCK_ROUNDNESS 0.0 1.0 0.4 "how weathered/rounded the rock cluster reads"

const SG_ROCK_XZ: vec2f = vec2f(2.75, 1.05);
const SG_ROCK_BOUND_R: f32 = 0.5;
const SG_ROCK_BOUND_MARGIN: f32 = 0.08;

// Same bounding-sphere early-out as the character (see sg_character_sdf):
// almost every march step is nowhere near this small static cluster, so
// everywhere else only pays for the bound's own conservative distance.
fn sg_rocks_sdf(p: vec3f, center: vec3f) -> f32 {
  let toCenter = length(p - center);
  if (toCenter > SG_ROCK_BOUND_R + SG_ROCK_BOUND_MARGIN) { return toCenter - SG_ROCK_BOUND_R; }

  let lp = p - center;
  let k = mix(0.02, 0.16, clamp(ROCK_ROUNDNESS(), 0.0, 1.0));
  var d = sg_sphere(lp, vec3f(0.0, 0.0, 0.0), 0.20);
  d = sg_smin(d, sg_sphere(lp, vec3f(0.26, -0.05, 0.08), 0.15), k);
  d = sg_smin(d, sg_sphere(lp, vec3f(-0.18, -0.09, -0.16), 0.13), k);
  d = sg_smin(d, sg_sphere(lp, vec3f(0.04, -0.11, 0.22), 0.10), k);
  return d;
}

fn sg_rocks_normal(p: vec3f, center: vec3f) -> vec3f {
  let e = 0.0025;
  let h = vec2f(e, 0.0);
  return normalize(vec3f(
    sg_rocks_sdf(p + h.xyy, center) - sg_rocks_sdf(p - h.xyy, center),
    sg_rocks_sdf(p + h.yxy, center) - sg_rocks_sdf(p - h.yxy, center),
    sg_rocks_sdf(p + h.yyx, center) - sg_rocks_sdf(p - h.yyx, center)
  ));
}

// Fixed world position: unlike the character the cluster never moves, so
// this only needs the one-time terrain-height sample mainImage already
// takes for the pond's own precompute.
fn sg_rocks_center() -> vec3f {
  return vec3f(SG_ROCK_XZ.x, sg_terrain_height(SG_ROCK_XZ) + 0.10, SG_ROCK_XZ.y);
}
// @end

// ---- scene wiring below: not itself a component, just the raymarch that
// composes the components above and the probe-encode branch in mainImage. ----

const SG_MAX_DIST: f32 = 20.0;
const SG_FOG_DIST: f32 = 6.0; // aerial-perspective falloff scale, tuned to the diorama's own depth (a few units), not the march's far clip

struct SGHit { t: f32, id: f32 }

fn sg_march(ro: vec3f, rd: vec3f, charCenter: vec3f, pondWaterY: f32, rockCenter: vec3f) -> SGHit {
  var t = 0.05;
  var hitKind = COMP_TERRAIN; // which candidate was closest last — decides the fallback below
  for (var i = 0; i < 88; i = i + 1) {
    let p = ro + rd * t;
    let dTerrain = p.y - sg_terrain_height(p.xz);
    let dChar = sg_character_sdf(p, charCenter);
    let dPond = sg_pond_sdf(p, pondWaterY);
    let dRock = sg_rocks_sdf(p, rockCenter);

    var d = dTerrain;
    hitKind = COMP_TERRAIN;
    if (dChar < d) { d = dChar; hitKind = COMP_CHARACTER; }
    if (dPond < d) { d = dPond; hitKind = COMP_POND; }
    if (dRock < d) { d = dRock; hitKind = COMP_ROCKS; }

    // Adaptive threshold (looser far away) — standard sphere-tracing
    // tolerance, needed here because dTerrain is a vertical-distance
    // approximation, not a true SDF, so it undershoots less predictably at
    // grazing angles than the other candidates' real SDFs do.
    if (d < max(0.002, t * 0.002)) {
      if (hitKind != COMP_TERRAIN) { return SGHit(t, hitKind); }
      break; // terrain hit — refine below, the heightfield march overshoots on slopes
    }
    t = t + max(d * 0.5, 0.01);
    if (t > SG_MAX_DIST) { return SGHit(SG_MAX_DIST, COMP_SKY); }
  }

  // A non-terrain hit that never converged inside the loop above (e.g. the
  // character's non-uniform squash/stretch scaling underestimates true
  // distance near its blend regions, so it can need more steps than a
  // plain sphere would) — return it as-is rather than falling into the
  // terrain-only bisection below, which would bisect the wrong surface.
  if (hitKind != COMP_TERRAIN) { return SGHit(t, hitKind); }

  // Bisection refine: the coarse loop above stops somewhere past the true
  // surface (a heightfield's vertical distance isn't a real SDF), which
  // otherwise shows up as banding across shallow slopes. Six bisections
  // against the actual height function remove it, same trick
  // biome-rolling-hills itself uses for its own (much larger-scale) march.
  var t0 = max(t - 0.3, 0.0);
  var t1 = t;
  for (var i = 0; i < 6; i = i + 1) {
    let tm = (t0 + t1) * 0.5;
    let pm = ro + rd * tm;
    if (pm.y < sg_terrain_height(pm.xz)) { t1 = tm; } else { t0 = tm; }
  }
  return SGHit((t0 + t1) * 0.5, COMP_TERRAIN);
}

fn sg_light(pos: vec3f, rd: vec3f, N: vec3f, matCol: vec3f, t: f32) -> vec3f {
  let sun_dir = normalize(vec3f(0.55, 0.42, 0.35));
  let sky_col = vec3f(0.45, 0.62, 0.90);
  let sun_col = vec3f(1.4, 1.15, 0.85);

  let diff = max(dot(N, sun_dir), 0.0);
  let amb  = 0.38 + 0.32 * N.y;
  let H = normalize(sun_dir - rd);
  let spec = pow(max(dot(N, H), 0.0), 28.0) * 0.10;

  var col = matCol * (sky_col * amb + sun_col * diff) + sun_col * spec;

  // Aerial perspective at diorama scale — the whole scene lives within a
  // handful of units, so this fades out against SG_FOG_DIST, not the
  // march's SG_MAX_DIST (which would barely register this close in).
  let fog = 1.0 - exp(-t / SG_FOG_DIST);
  return mix(col, sg_sky_color(rd, U.time) * 0.9, clamp(fog, 0.0, 1.0));
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;

  // Orbit camera: slow auto-drift plus a drag offset read straight off
  // U.mouse — the drag offset persists after release (U.mouse.xy keeps the
  // last drag position even once z/w go negative), so letting go of the
  // mouse leaves the view where you put it.
  var dragYaw = 0.0;
  var dragPitch = 0.0;
  if (U.mouse.z != 0.0) {
    let pressX = abs(U.mouse.z);
    let pressY = abs(U.mouse.w);
    dragYaw   = -(U.mouse.x - pressX) * 0.006;
    dragPitch =  (U.mouse.y - pressY) * 0.006;
  }
  let yaw = U.time * 0.07 + dragYaw;
  let pitch = clamp(0.42 + dragPitch, 0.08, 1.15);

  let charCenter = sg_character_center(U.time);
  let pondWaterY = sg_pond_water_y(SG_POND_XZ);
  let rockCenter = sg_rocks_center();
  let camTarget = mix(vec3f(0.0, sg_terrain_height(SG_CHAR_XZ), 0.0), charCenter, 0.6);
  let radius = 3.6;
  let ro = camTarget + radius * vec3f(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
  let fwd = normalize(camTarget - ro);
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, fwd);
  let rd = normalize(fwd + uv.x * right * 1.35 + uv.y * up * 1.35);

  let hit = sg_march(ro, rd, charCenter, pondWaterY, rockCenter);
  var col: vec3f;
  var compId: f32;

  if (hit.id == COMP_SKY) {
    col = sg_sky_color(rd, U.time);
    compId = COMP_SKY;

    let cloudMask = sg_cloud_mask(rd);
    if (cloudMask > 0.01) {
      col = mix(col, vec3f(0.97, 0.97, 1.0), cloudMask);
      if (cloudMask > 0.35) { compId = COMP_CLOUDS; }
    }
  } else {
    let pos = ro + rd * hit.t;
    var N: vec3f;
    var matCol: vec3f;
    var grassMask = 0.0;

    if (hit.id == COMP_TERRAIN) {
      N = sg_terrain_normal(pos.xz, 0.02);
      let terrH = sg_terrain_height(pos.xz);
      matCol = sg_terrain_color(pos.xz, terrH, N);
      let height01 = clamp(terrH / SG_TERRAIN_HEIGHT_RNG, 0.0, 1.0);
      let slope = 1.0 - clamp(N.y, 0.0, 1.0);
      grassMask = sg_grass_mask(height01, slope);
      if (grassMask > 0.02) { matCol = sg_grass_shade(pos.xz, &N, matCol, grassMask); }
    } else if (hit.id == COMP_CHARACTER) {
      N = sg_character_normal(pos, charCenter);
      matCol = vec3f(0.86, 0.46, 0.22); // warm clay — the figure reads as one object at a glance
    } else if (hit.id == COMP_POND) {
      N = sg_pond_normal(pos.xz);
      matCol = vec3f(0.0); // unused below — the pond skips the terrestrial lighting model entirely
    } else { // COMP_ROCKS
      N = sg_rocks_normal(pos, rockCenter);
      matCol = mix(vec3f(0.40, 0.39, 0.37), vec3f(0.62, 0.58, 0.52), clamp(ROCK_ROUNDNESS(), 0.0, 1.0));
    }

    // Water is a planar reflection, not a diffuse-lit surface — running it
    // through sg_light would double up the sky contribution it already
    // samples directly. select() evaluates both branches (no WGSL ternary,
    // and no short-circuit either way) — both are pure, so that's fine.
    col = select(sg_light(pos, rd, N, matCol, hit.t), sg_pond_color(rd, N), hit.id == COMP_POND);
    compId = hit.id;

    if (hit.id == COMP_TERRAIN) {
      if (grassMask > 0.4) { compId = COMP_GRASS; }

      let shadowF = sg_shadow_factor(pos.xz);
      col = mix(col, col * 0.32, shadowF);
      if (shadowF > 0.45) { compId = COMP_SHADOW; }
    }

    // uProbeSel highlight: a fresnel rim-light on whichever component is
    // currently selected in the probe panel, pulsing gently at ~1Hz. Skipped
    // for sky/clouds above (no surface or normal to rim there) — this branch
    // only ever runs for hit components with real geometry.
    if (uProbeSel() > 0.5 && abs(compId - uProbeSel()) < 0.5) {
      let fres = pow(1.0 - max(dot(N, -rd), 0.0), 2.5);
      let pulse = 0.7 + 0.3 * sin(U.time * 6.283185);
      col += vec3f(0.30, 0.85, 1.0) * fres * pulse * 0.6;
    }
  }

  // Probe frame: encode compId in the red channel (0..255 -> 0..1, exact at
  // 8-bit precision for the handful of ids in play) and bail before any of
  // the shading below touches it — a probe frame is never meant to be seen.
  if (uProbe() > 0.5) {
    return vec4f(compId / 255.0, 0.0, 0.0, 1.0);
  }

  let vigUv = fragCoord / U.res.xy;
  let vig = 1.0 - 0.30 * dot(vigUv - 0.5, vigUv - 0.5) * 4.0;
  col = col * clamp(vig, 0.0, 1.0);
  col = pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545));
  return vec4f(col, 1.0);
}
