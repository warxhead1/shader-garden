// TERRAIN VARIANT: mountain-peaks — from kernel biome-mountain-peaks
// (fitness 0.9998). HEAVY: a 2-sample domain warp before the ridged term of
// EVERY octave across an 8-octave accumulation — about 26 sg_noise2 calls
// per sg_terrain_height() invocation versus rolling-hills' 5, and
// sg_terrain_height is evaluated once per raymarch step (sg_march) plus
// twice more per sg_terrain_normal call. Marked "heavy": true in
// variants/terrain/manifest.json — the probe panel applies it only on an
// explicit click. sg_hash/sg_noise2 stay byte-identical to the default body
// (grass/clouds/pond all call sg_noise2 directly).
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
  vec2 w = vec2(sg_noise2(p * 1.2 + vec2(1.7, 9.2)), sg_noise2(p * 1.5 + vec2(8.3, 2.8)));
  p += w * 0.31;
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 8; i++) {
    vec2 warp = vec2(sg_noise2(p + vec2(3.1, 0.0)), sg_noise2(p + vec2(0.0, 3.1))) - 0.5;
    float n = 1.0 - abs(2.0 * sg_noise2(p + warp * 0.4) - 1.0);
    n = pow(n, 1.9);
    v += a * n;
    p = p * 1.97 + vec2(3.9, 6.3);
    a *= TERRAIN_ROUGHNESS;
  }
  return clamp(v, 0.0, 1.0);
}

// @tune TERRAIN_SCALE 0.4 2.0 1.0 "vertical exaggeration of the evolved heightfield"
uniform float TERRAIN_SCALE;

const float SG_TERRAIN_INV_SCALE = 1.0 / 4.4;
const float SG_TERRAIN_HEIGHT_RNG = 2.3; // taller than rolling-hills — these are peaks, not hills

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
  vec3 col = mix(vec3(0.45, 0.42, 0.38), vec3(0.62, 0.58, 0.54), height01); // grey granite
  col = mix(col, vec3(0.28, 0.26, 0.24), smoothstep(0.3, 0.75, slope));
  col = mix(col, vec3(0.90, 0.92, 0.96), smoothstep(0.7, 0.92, height01) * smoothstep(0.55, 0.3, slope)); // snowcap
  return col;
}
