// phase-allen-cahn-demo — the full FunSearch-evolved terrain demo: five
// biomes side-by-side along Z (each 2048m wide, blended 100m at the seams)
// plus the Allen-Cahn phase kernel driving the ice/snow tint. Combines the
// same biome functions as the five biome-*.wgsl single-biome ports (mountain
// -peaks, volcanic-plateau, eroded-badlands, river-valley, rolling-hills),
// each kept under its own name prefix here (matching the GLSL original's own
// underscore-prefixed-per-biome convention) since one shader now needs all
// five at once.
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn mod_f(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

// ---------------------------------------------------------------------------
// Biome 0: mountain_peaks (fitness=0.9998) — 9-octave ridged Perlin, domain-warped
// ---------------------------------------------------------------------------
fn h_hash(p_in: vec2f) -> f32 {
  let p = vec2f(dot(p_in, vec2f(127.1, 311.7)), dot(p_in, vec2f(269.5, 183.3)));
  return fract(sin(p.x + p.y) * 43758.5453);
}
fn h_perlin(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h_hash(i),               h_hash(i + vec2f(1.0, 0.0)), f.x),
             mix(h_hash(i + vec2f(0.0, 1.0)), h_hash(i + vec2f(1.0, 1.0)), f.x), f.y);
}
fn biome_mountain(p_in: vec2f) -> f32 {
  let w = vec2f(h_perlin(p_in * 1.2 + vec2f(1.7, 9.2)), h_perlin(p_in * 1.5 + vec2f(8.3, 2.8)));
  var p = p_in + w * 0.31;
  var v = 0.0;
  var a = 0.55;
  var w2 = 1.0;
  let o = vec2f(3.9, 6.3);
  for (var i = 0; i < 9; i = i + 1) {
    var n = 1.0 - abs(2.0 * h_perlin(p) - 1.0);
    n = pow(n, 1.95);
    v = v + a * n * w2;
    w2 = clamp(n * 1.28, 0.35, 1.0);
    p = p * 2.03 + o + w * 0.07;
    a = a * 0.47;
  }
  return clamp(v, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Biome 1: volcanic_plateau (fitness=0.9876) — ridged FBM, rotated octaves + warp
// ---------------------------------------------------------------------------
fn vh(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
fn vn(x: vec2f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vh(i.x + i.y * 57.0),       vh(i.x + 1.0 + i.y * 57.0),       f.x),
             mix(vh(i.x + (i.y + 1.0) * 57.0), vh(i.x + 1.0 + (i.y + 1.0) * 57.0), f.x), f.y);
}
fn vr(x: vec2f) -> f32 { let n = vn(x); return 1.0 - abs(2.0 * n - 1.0); }
fn biome_volcanic(p_in: vec2f) -> f32 {
  var p = p_in;
  var v = 0.0;
  var a = 0.6;
  for (var i = 0; i < 6; i = i + 1) {
    v = v + a * vr(p);
    p = vec2f(p.x * 0.883 - p.y * 0.469, p.x * 0.469 + p.y * 0.883) * 2.1;
    a = a * 0.58;
  }
  let q = vec2f(vn(p), vn(p + vec2f(5.2, 1.3)));
  let ww = 0.3 * vn(p * 0.6 + 0.6 * q * 1.2);
  var s = 0.0;
  var sa = 0.4;
  for (var i = 0; i < 4; i = i + 1) {
    s = s + sa * vn(p);
    p = p * 2.0 + vec2f(1.7, 0.9);
    sa = sa * 0.5;
  }
  return clamp(v * 0.75 + ww * 0.12 + s * 0.13, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Biome 2: eroded_badlands (fitness=0.9807) — domain-warped turbulence
// ---------------------------------------------------------------------------
fn th(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
fn tv(x: vec2f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(th(i.x + i.y * 57.0),       th(i.x + 1.0 + i.y * 57.0),       f.x),
             mix(th(i.x + (i.y + 1.0) * 57.0), th(i.x + 1.0 + (i.y + 1.0) * 57.0), f.x), f.y);
}
fn biome_badlands(p_in: vec2f) -> f32 {
  var p = p_in;
  var v = 0.0;
  var a = 0.55;
  var q = p * 1.3;
  let w = 0.5;
  for (var i = 0; i < 8; i = i + 1) {
    let n = tv(p + vec2f(tv(q) * w, tv(q + vec2f(31.7, 17.3)) * w));
    v = v + a * select(n, abs(2.0 * n - 1.0), i == 0);
    p = p * 2.0;
    q = q * 2.0;
    a = a * 0.63;
  }
  return clamp(v, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Biome 3: river_valley (fitness=0.9997) — 6-octave offset FBM
// ---------------------------------------------------------------------------
fn rh(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
fn rv(x: vec2f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rh(i.x + i.y * 57.0),       rh(i.x + 1.0 + i.y * 57.0),       f.x),
             mix(rh(i.x + (i.y + 1.0) * 57.0), rh(i.x + 1.0 + (i.y + 1.0) * 57.0), f.x), f.y);
}
fn biome_valley(p_in: vec2f) -> f32 {
  var p = p_in;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 6; i = i + 1) {
    let q = p + vec2f(3.7 * f32(i + 1), 2.3 * f32(i + 1));
    v = v + a * rv(q);
    p = p * 2.05;
    a = a * 0.48;
  }
  return clamp(v, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Biome 4: rolling_hills (fitness=0.9994) — quintic FBM + shear
// ---------------------------------------------------------------------------
fn hh(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
fn hn(x: vec2f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * f * (10.0 - 15.0 * f + 6.0 * f * f);
  return mix(mix(hh(i.x + i.y * 57.0),       hh(i.x + 1.0 + i.y * 57.0),       f.x),
             mix(hh(i.x + (i.y + 1.0) * 57.0), hh(i.x + 1.0 + (i.y + 1.0) * 57.0), f.x), f.y);
}
fn biome_hills(p_in: vec2f) -> f32 {
  var p = p_in;
  var v = 0.0;
  var a = 0.58;
  for (var i = 0; i < 5; i = i + 1) {
    v = v + a * hn(p);
    p = vec2f(p.x * 1.78 + p.y * 0.35, p.x * 0.35 + p.y * 1.78);
    a = a * 0.53;
  }
  return clamp(v, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Allen-Cahn phase kernel (fitness=1.0)
// ---------------------------------------------------------------------------
fn phase_reaction(phi: f32, temp: f32) -> f32 {
  let dW = phi * phi * (4.0 * phi - 6.0) + 2.0 * phi;
  let m = 2.0 * (0.5 - temp);
  let mob = 1.0 + 0.6 * tanh(2.5 * (0.5 - temp));
  return -dW + m * mob + 4.0 * phi * (1.0 - phi) * m;
}

// ---------------------------------------------------------------------------
// Terrain dispatch — 5 biomes side-by-side along Z, 2048m tiles, 100m seam blend
// ---------------------------------------------------------------------------
const TILE_SZ: f32 = 2048.0;
const INV_SCALE: f32 = 1.0 / 512.0; // world -> noise: [0,2048] -> [0,4]
const HEIGHT_MIN: f32 = 40.0;
const HEIGHT_MAX: f32 = 420.0;
const HEIGHT_RNG: f32 = HEIGHT_MAX - HEIGHT_MIN;

fn biome_tile(z: f32) -> i32 {
  return clamp(i32(floor(z / TILE_SZ)), 0, 4);
}

fn raw_biome(id: i32, p: vec2f) -> f32 {
  if (id == 0) { return biome_mountain(p); }
  else if (id == 1) { return biome_volcanic(p); }
  else if (id == 2) { return biome_badlands(p); }
  else if (id == 3) { return biome_valley(p); }
  else { return biome_hills(p); }
}

fn terrain_height(xz: vec2f) -> f32 {
  // Tile-local [0,1] coordinate
  let local_z = mod_f(xz.y, TILE_SZ);
  let id = biome_tile(xz.y);
  let p = xz * INV_SCALE;
  var h = raw_biome(id, p);

  // Blend seam: 100m transition at tile boundaries
  let blend_w = 100.0;
  let seam_t = local_z / TILE_SZ; // 0=start, 1=end of tile
  if (seam_t > 1.0 - blend_w / TILE_SZ && id < 4) {
    var t = (seam_t - (1.0 - blend_w / TILE_SZ)) / (blend_w / TILE_SZ);
    t = t * t * (3.0 - 2.0 * t); // smoothstep
    let p2 = xz * INV_SCALE;
    let h2 = raw_biome(id + 1, p2);
    h = mix(h, h2, t);
  }

  return HEIGHT_MIN + h * HEIGHT_RNG;
}

fn terrain_normal(xz: vec2f, eps: f32) -> vec3f {
  let h0 = terrain_height(xz);
  let hx = terrain_height(xz + vec2f(eps, 0.0));
  let hz = terrain_height(xz + vec2f(0.0, eps));
  return normalize(vec3f(h0 - hx, eps, h0 - hz));
}

// ---------------------------------------------------------------------------
// Heightfield raymarcher
// ---------------------------------------------------------------------------
fn march(ro: vec3f, rd: vec3f) -> f32 {
  var t = 0.0;
  let tmax = 8000.0;
  for (var i = 0; i < 120; i = i + 1) {
    let p = ro + rd * t;
    let h = terrain_height(p.xz);
    let dist = p.y - h;
    if (dist < 0.5) { break; }
    t = t + max(dist * 0.55, 4.0); // adaptive step
    if (t > tmax) { return tmax; }
  }

  // Binary refinement
  var t0 = max(t - 80.0, 0.0);
  var t1 = t;
  for (var i = 0; i < 10; i = i + 1) {
    let tm = (t0 + t1) * 0.5;
    let pm = ro + rd * tm;
    if (pm.y < terrain_height(pm.xz)) { t1 = tm; } else { t0 = tm; }
  }
  return (t0 + t1) * 0.5;
}

// ---------------------------------------------------------------------------
// Material / coloring
// ---------------------------------------------------------------------------
fn biome_base_color(id: i32, height01: f32, slope: f32, xz: vec2f) -> vec3f {
  var col: vec3f;
  if (id == 0) {
    // Mountain: grey granite + dark ridge
    col = mix(vec3f(0.45, 0.40, 0.35), vec3f(0.65, 0.60, 0.55), height01);
    col = mix(col, vec3f(0.30, 0.28, 0.25), smoothstep(0.3, 0.8, slope));
  } else if (id == 1) {
    // Volcanic: dark basalt, orange lava low
    col = mix(vec3f(0.80, 0.35, 0.10), vec3f(0.18, 0.15, 0.14), height01);
    col = mix(col, vec3f(0.12, 0.10, 0.09), smoothstep(0.4, 0.9, slope));
  } else if (id == 2) {
    // Badlands: ochre/tan banding
    let band = fract(height01 * 8.0);
    col = mix(vec3f(0.78, 0.52, 0.28), vec3f(0.62, 0.40, 0.22), band);
    col = mix(col, vec3f(0.55, 0.45, 0.35), smoothstep(0.5, 0.9, slope));
  } else if (id == 3) {
    // Valley: green meadow + river blue low
    col = mix(vec3f(0.12, 0.38, 0.18), vec3f(0.30, 0.55, 0.22), height01);
    col = mix(col, vec3f(0.22, 0.50, 0.42), smoothstep(0.9, 1.0, 1.0 - height01));
  } else {
    // Hills: grass + dark soil on slopes
    col = mix(vec3f(0.45, 0.62, 0.22), vec3f(0.28, 0.42, 0.18), height01);
    col = mix(col, vec3f(0.30, 0.24, 0.18), smoothstep(0.4, 0.7, slope));
  }
  return col;
}

fn material_color(xz: vec2f, height: f32, N: vec3f, time: f32) -> vec3f {
  let id = biome_tile(xz.y);
  let height01 = (height - HEIGHT_MIN) / HEIGHT_RNG;
  let slope = 1.0 - clamp(N.y, 0.0, 1.0);

  var col = biome_base_color(id, height01, slope, xz);

  // Water at low elevation (valleys + base)
  let water = smoothstep(65.0, 55.0, height);
  col = mix(col, vec3f(0.08, 0.20, 0.38), water);

  // Lava for volcanic biome at low elevation
  if (id == 1) {
    let lava = smoothstep(100.0, 60.0, height);
    let lava_col = mix(vec3f(0.9, 0.4, 0.0), vec3f(1.0, 0.8, 0.0),
                        0.5 + 0.5 * sin(time * 1.2 + xz.x * 0.01 + xz.y * 0.01));
    col = mix(col, lava_col, lava * 0.8);
  }

  // Snow + ice from Allen-Cahn phase kernel
  let temp = 0.4 + 0.3 * sin(time * 0.25);
  let phi = clamp(0.5 + 5.0 * phase_reaction(0.5, temp), 0.0, 1.0);
  let ice_amt = phi * smoothstep(80.0, 160.0, height);
  // Snow: high slopes + high elevation
  let snow = smoothstep(320.0, 370.0, height) * smoothstep(0.55, 0.35, slope);
  let snow_col = vec3f(0.92, 0.94, 0.98);
  let ice_col = mix(vec3f(0.70, 0.85, 0.95), snow_col, 0.4);
  col = mix(col, ice_col, ice_amt * (1.0 - snow));
  col = mix(col, snow_col, snow);

  return col;
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------
fn sky_color(rd: vec3f) -> vec3f {
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  let horiz = vec3f(0.70, 0.80, 0.90);
  let zenith = vec3f(0.25, 0.45, 0.80);
  return mix(horiz, zenith, t * t);
}

fn light_scene(rd: vec3f, N: vec3f, xz: vec2f, height: f32, t: f32, time: f32) -> vec3f {
  let sun_dir = normalize(vec3f(0.55, 0.42, 0.35));
  let sky_col = vec3f(0.45, 0.65, 0.92);
  let sun_col = vec3f(1.45, 1.15, 0.85);

  let mat_col = material_color(xz, height, N, time);

  let diff = max(dot(N, sun_dir), 0.0);
  let amb = 0.35 + 0.35 * N.y;
  let H = normalize(sun_dir - rd);
  let spec = pow(max(dot(N, H), 0.0), 24.0) * 0.12;

  var col = mat_col * (sky_col * amb + sun_col * diff) + sun_col * spec;

  // Aerial perspective / fog
  let fog_dist = t * 0.00028;
  let fog = 1.0 - exp(-fog_dist * fog_dist);
  let fog_col = sky_col * 0.85;
  col = mix(col, fog_col, clamp(fog, 0.0, 1.0));

  return col;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;

  // Mouse in the top half of the screen (while pressed) freezes/scrubs time
  var use_time = U.time;
  if (U.mouse.y > U.res.y * 0.5 && U.mouse.z > 0.0) {
    use_time = U.mouse.x * 0.1;
  }

  // Camera: slow forward flight over the 5-biome strip (Z in [0, 10240])
  let cam_z = mod_f(use_time * 45.0 + 300.0, 9900.0);
  let cam_x = 1024.0 + 320.0 * sin(use_time * 0.04);
  let ro = vec3f(cam_x, 650.0, cam_z);

  let forward = normalize(vec3f(0.12 * sin(use_time * 0.05), -0.38, 1.0));
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let rd = normalize(forward + uv.x * right * 1.6 + uv.y * up);

  var col: vec3f;
  if (rd.y > 0.01) {
    col = sky_color(rd);
    let sun_dir = normalize(vec3f(0.55, 0.42, 0.35));
    let sun = pow(max(dot(rd, sun_dir), 0.0), 280.0);
    col = col + vec3f(1.4, 1.1, 0.8) * sun;
  } else {
    let t = march(ro, rd);
    if (t > 7900.0) {
      col = sky_color(rd);
    } else {
      let pos = ro + rd * t;
      let N = terrain_normal(pos.xz, 4.0);
      let height = terrain_height(pos.xz);
      col = light_scene(rd, N, pos.xz, height, t, use_time);
    }
  }

  // Subtle vignette
  let vig_uv = fragCoord / U.res.xy;
  let vig = 1.0 - 0.35 * dot(vig_uv - 0.5, vig_uv - 0.5) * 4.0;
  col = col * clamp(vig, 0.0, 1.0);

  // Gamma
  col = pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545));

  return vec4f(col, 1.0);
}
