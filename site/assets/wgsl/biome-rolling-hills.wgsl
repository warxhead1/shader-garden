// biome-rolling-hills — FunSearch-evolved terrain (fitness=0.9994)
// Quintic FBM + shear heightfield, hardwired to the rolling_hills biome,
// with the heightfield raymarcher + shading path from the evolved terrain demo.
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

const HEIGHT_MIN: f32 = 40.0;
const HEIGHT_MAX: f32 = 420.0;
const HEIGHT_RNG: f32 = HEIGHT_MAX - HEIGHT_MIN;
const INV_SCALE: f32 = 1.0 / 512.0; // world -> noise coords

fn mod_f(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

// ---------------------------------------------------------------------------
// rolling_hills heightfield: quintic-smoothed value noise + sheared octaves
// ---------------------------------------------------------------------------
fn hh(n: f32) -> f32 {
  return fract(sin(n) * 43758.5453);
}

fn hn(x: vec2f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * f * (10.0 - 15.0 * f + 6.0 * f * f); // quintic fade
  return mix(
    mix(hh(i.x + i.y * 57.0), hh(i.x + 1.0 + i.y * 57.0), f.x),
    mix(hh(i.x + (i.y + 1.0) * 57.0), hh(i.x + 1.0 + (i.y + 1.0) * 57.0), f.x),
    f.y);
}

fn biome_hills(p_in: vec2f) -> f32 {
  var p = p_in;
  var v = 0.0;
  var a = 0.58;
  for (var i = 0; i < 5; i = i + 1) {
    v = v + a * hn(p);
    p = vec2f(p.x * 1.78 + p.y * 0.35, p.x * 0.35 + p.y * 1.78); // shear
    a = a * 0.53;
  }
  return clamp(v, 0.0, 1.0);
}

fn terrain_height(xz: vec2f) -> f32 {
  return HEIGHT_MIN + biome_hills(xz * INV_SCALE) * HEIGHT_RNG;
}

fn terrain_normal(xz: vec2f, eps: f32) -> vec3f {
  let h0 = terrain_height(xz);
  let hx = terrain_height(xz + vec2f(eps, 0.0));
  let hz = terrain_height(xz + vec2f(0.0, eps));
  return normalize(vec3f(h0 - hx, eps, h0 - hz));
}

// ---------------------------------------------------------------------------
// Allen-Cahn phase kernel (fitness=1.0) — drives the ice tint
// ---------------------------------------------------------------------------
fn phase_reaction(phi: f32, temp: f32) -> f32 {
  let dW = phi * phi * (4.0 * phi - 6.0) + 2.0 * phi;
  let m = 2.0 * (0.5 - temp);
  let mob = 1.0 + 0.6 * tanh(2.5 * (0.5 - temp));
  return -dW + m * mob + 4.0 * phi * (1.0 - phi) * m;
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
// Material / coloring (rolling_hills path: grass + soil + water + ice + snow)
// ---------------------------------------------------------------------------
fn material_color(xz: vec2f, height: f32, N: vec3f, time: f32) -> vec3f {
  let height01 = (height - HEIGHT_MIN) / HEIGHT_RNG;
  let slope = 1.0 - clamp(N.y, 0.0, 1.0);

  // Hills: grass + dark soil on slopes
  var col = mix(vec3f(0.45, 0.62, 0.22), vec3f(0.28, 0.42, 0.18), height01);
  col = mix(col, vec3f(0.30, 0.24, 0.18), smoothstep(0.4, 0.7, slope));

  // Water at low elevation
  let water = 1.0 - smoothstep(55.0, 65.0, height);
  col = mix(col, vec3f(0.08, 0.20, 0.38), water);

  // Snow + ice from the Allen-Cahn phase kernel
  let temp = 0.4 + 0.3 * sin(time * 0.25);
  let phi = clamp(0.5 + 5.0 * phase_reaction(0.5, temp), 0.0, 1.0);
  let ice_amt = phi * smoothstep(80.0, 160.0, height);
  let snow = smoothstep(320.0, 370.0, height) * (1.0 - smoothstep(0.35, 0.55, slope));
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
// Entry
// ---------------------------------------------------------------------------
fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;

  // Mouse in the top half of the screen (while pressed) freezes/scrubs time
  var use_time = U.time;
  if (U.mouse.y > U.res.y * 0.5 && U.mouse.z > 0.0) {
    use_time = U.mouse.x * 0.1;
  }

  // Camera: slow forward flight over the hills
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
