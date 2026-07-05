// TERRAIN VARIANT: river-valley — from kernel biome-river-valley (fitness
// 0.9997). Cheap: the same 6-octave offset-FBM accumulation as the evolved
// kernel (staggered per-octave phase offsets instead of rolling-hills'
// shear matrix), still driven by TERRAIN_ROUGHNESS. sg_hash/sg_noise2 stay
// byte-identical to the default body — grass, clouds, and the pond's
// ripple normal all call sg_noise2 directly, so every terrain variant keeps
// it unchanged; only sg_biome_hills' own recipe and sg_terrain_color's
// palette are this variant's actual character.
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
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) {
    vec2 q = p + vec2(3.7 * float(i + 1), 2.3 * float(i + 1));
    v += a * sg_noise2(q);
    p *= 1.9;
    a *= TERRAIN_ROUGHNESS;
  }
  return clamp(v, 0.0, 1.0);
}

// @tune TERRAIN_SCALE 0.4 2.0 1.0 "vertical exaggeration of the evolved heightfield"
uniform float TERRAIN_SCALE;

const float SG_TERRAIN_INV_SCALE = 1.0 / 4.4;
const float SG_TERRAIN_HEIGHT_RNG = 1.4; // shallower carve than rolling-hills — a valley floor, not a ridge line

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
  vec3 col = mix(vec3(0.10, 0.42, 0.30), vec3(0.30, 0.55, 0.24), height01); // river-teal low, meadow green high
  col = mix(col, vec3(0.28, 0.24, 0.19), smoothstep(0.4, 0.75, slope));
  col = mix(col, vec3(0.10, 0.30, 0.42), smoothstep(0.16, 0.0, height01)); // channel tint at the lowest ground
  return col;
}
