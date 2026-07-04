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

const float COMP_SKY       = 1.0;
const float COMP_TERRAIN   = 2.0;
const float COMP_CHARACTER = 3.0;
const float COMP_SHADOW    = 4.0;

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
  float v = 0.0, a = 0.58;
  for (int i = 0; i < 5; i++) {
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
const vec2  SG_CHAR_XZ = vec2(0.0);

// Bounce phase in [0, 1); a parabola of this (4t(1-t)) is the actual
// trajectory of a ball under constant gravity between two ground contacts —
// the same curve, not an approximation of one.
float sg_bounce_phase(float time) { return fract(time * BOUNCE_SPEED * 0.5); }

// center is precomputed once per pixel by the caller (mainImage) — it only
// depends on iTime, not on p, and this is called once per raymarch step;
// recomputing sg_terrain_height() (a 5-octave noise loop) that often was
// the single biggest cost in the whole scene.
float sg_character_sdf(vec3 p, vec3 center) {
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
  lp.y /= scaleY;
  lp.xz /= scaleXZ;

  float k = 0.075; // one smooth-min radius for the whole figure's "softness"
  float d = sg_capsule(lp, vec3(0.0, -0.04, 0.0), vec3(0.0, 0.28, 0.0), 0.165);
  d = sg_smin(d, sg_sphere(lp, vec3(0.0, 0.50, 0.0), 0.155), k);

  float swing = sin(iTime * 3.1);
  d = sg_smin(d, sg_capsule(lp, vec3( 0.24, 0.24, 0.0), vec3( 0.27 + 0.07 * swing, -0.12,  0.13 * swing), 0.062), k);
  d = sg_smin(d, sg_capsule(lp, vec3(-0.24, 0.24, 0.0), vec3(-0.27 - 0.07 * swing, -0.12, -0.13 * swing), 0.062), k);

  float tuck = smoothstep(0.12, 0.5, min(t, 1.0 - t)); // legs draw up mid-flight, extend for landing
  d = sg_smin(d, sg_capsule(lp, vec3( 0.11, -0.04, 0.0), vec3( 0.11, -0.5 + 0.24 * tuck,  0.07 * tuck), 0.075), k);
  d = sg_smin(d, sg_capsule(lp, vec3(-0.11, -0.04, 0.0), vec3(-0.11, -0.5 + 0.24 * tuck, -0.07 * tuck), 0.075), k);

  return d * min(scaleY, scaleXZ); // conservative distance correction for the non-uniform scale
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
  return vec3(SG_CHAR_XZ.x, sg_terrain_height(SG_CHAR_XZ) + SG_LEG_LEN + arc, SG_CHAR_XZ.y);
}
// @end

// @component shadow "Blob Shadow" "No shadow ray, no depth buffer — just distance from the hit point to the character's ground projection, softened by how high the character currently is. Cheap and, at this camera distance, indistinguishable from the real thing."
// @tune SHADOW_SOFTNESS 0.4 2.5 1.0 "radius of the contact shadow beneath the figure"
uniform float SHADOW_SOFTNESS;

float sg_shadow_factor(vec2 xz) {
  float t = sg_bounce_phase(iTime);
  float arc = 4.0 * BOUNCE_HEIGHT * t * (1.0 - t);
  float r = max(0.30 * SHADOW_SOFTNESS * (1.0 + arc * 0.7), 0.05);
  float d = length(xz - SG_CHAR_XZ);
  float shadow = 1.0 - smoothstep(0.0, r, d);
  return shadow * mix(1.0, 0.35, clamp(arc / max(BOUNCE_HEIGHT, 0.05), 0.0, 1.0));
}
// @end

// ---- scene wiring below: not itself a component, just the raymarch that
// composes the four above and the probe-encode branch in mainImage. ----

const float SG_MAX_DIST = 20.0;

struct SGHit { float t; float id; };

SGHit sg_march(vec3 ro, vec3 rd, vec3 charCenter) {
  float t = 0.05;
  bool nearTerrain = true; // which candidate was closer last — decides the fallback below
  for (int i = 0; i < 88; i++) {
    vec3 p = ro + rd * t;
    float dTerrain = p.y - sg_terrain_height(p.xz);
    float dChar = sg_character_sdf(p, charCenter);
    nearTerrain = dTerrain <= dChar;
    float d = min(dTerrain, dChar);
    // Adaptive threshold (looser far away) — standard sphere-tracing
    // tolerance, needed here because dTerrain is a vertical-distance
    // approximation, not a true SDF, so it undershoots less predictably at
    // grazing angles than the character's real SDF does.
    if (d < max(0.002, t * 0.002)) {
      if (!nearTerrain) return SGHit(t, COMP_CHARACTER);
      break; // terrain hit — refine below, the heightfield march overshoots on slopes
    }
    t += max(d * 0.5, 0.01);
    if (t > SG_MAX_DIST) return SGHit(SG_MAX_DIST, COMP_SKY);
  }

  // A character hit that never converged inside the loop above (the
  // non-uniform squash/stretch scaling underestimates true distance near
  // the blend regions, so it can need more steps than a plain sphere would)
  // — return it as-is rather than falling into the terrain-only bisection
  // below, which would bisect the wrong surface entirely.
  if (!nearTerrain) return SGHit(t, COMP_CHARACTER);

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

vec3 sg_light(vec3 pos, vec3 rd, vec3 N, vec3 matCol, float t) {
  vec3 sun_dir = normalize(vec3(0.55, 0.42, 0.35));
  vec3 sky_col = vec3(0.45, 0.62, 0.90);
  vec3 sun_col = vec3(1.4, 1.15, 0.85);

  float diff = max(dot(N, sun_dir), 0.0);
  float amb  = 0.38 + 0.32 * N.y;
  vec3 H = normalize(sun_dir - rd);
  float spec = pow(max(dot(N, H), 0.0), 28.0) * 0.10;

  vec3 col = matCol * (sky_col * amb + sun_col * diff) + sun_col * spec;

  float fog = 1.0 - exp(-pow(t / SG_MAX_DIST, 2.0) * 3.0);
  return mix(col, sg_sky_color(rd, iTime) * 0.9, clamp(fog, 0.0, 1.0));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

  // Orbit camera: slow auto-drift plus a drag offset read straight off
  // iMouse — the drag offset persists after release (iMouse.xy keeps the
  // last drag position even once z/w go negative), so letting go of the
  // mouse leaves the view where you put it.
  float dragYaw = 0.0, dragPitch = 0.0;
  if (iMouse.z != 0.0) {
    float pressX = abs(iMouse.z), pressY = abs(iMouse.w);
    dragYaw   = -(iMouse.x - pressX) * 0.006;
    dragPitch =  (iMouse.y - pressY) * 0.006;
  }
  float yaw = iTime * 0.07 + dragYaw;
  float pitch = clamp(0.42 + dragPitch, 0.08, 1.15);

  vec3 charCenter = sg_character_center(iTime);
  vec3 target = mix(vec3(0.0, sg_terrain_height(SG_CHAR_XZ), 0.0), charCenter, 0.6);
  float radius = 3.6;
  vec3 ro = target + radius * vec3(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
  vec3 fwd = normalize(target - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  vec3 rd = normalize(fwd + uv.x * right * 1.35 + uv.y * up * 1.35);

  SGHit hit = sg_march(ro, rd, charCenter);
  vec3 col;
  float compId;

  if (hit.id == COMP_SKY) {
    col = sg_sky_color(rd, iTime);
    compId = COMP_SKY;
  } else {
    vec3 pos = ro + rd * hit.t;
    vec3 N = (hit.id == COMP_TERRAIN) ? sg_terrain_normal(pos.xz, 0.02) : sg_character_normal(pos, charCenter);
    vec3 matCol = (hit.id == COMP_TERRAIN)
      ? sg_terrain_color(pos.xz, sg_terrain_height(pos.xz), N)
      : vec3(0.86, 0.46, 0.22); // warm clay — the figure reads as one object at a glance
    col = sg_light(pos, rd, N, matCol, hit.t);
    compId = hit.id;

    if (hit.id == COMP_TERRAIN) {
      float shadowF = sg_shadow_factor(pos.xz);
      col = mix(col, col * 0.32, shadowF);
      if (shadowF > 0.45) compId = COMP_SHADOW;
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
