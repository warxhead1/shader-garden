// vault-d8432ca0 — FunSearch rolling_hills terrain flyover (fitness=0.9994),
// a smaller standalone cousin of biome-rolling-hills.wgsl (different camera
// path and shading, same value-noise heightfield shape).
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn rh_hash(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
fn rh_vnoise(x: vec2f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * f * (10.0 - 15.0 * f + 6.0 * f * f);
  let n00 = rh_hash(i.x + i.y * 57.0);
  let n10 = rh_hash(i.x + 1.0 + i.y * 57.0);
  let n01 = rh_hash(i.x + (i.y + 1.0) * 57.0);
  let n11 = rh_hash(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y);
}
fn terrain(p_in: vec2f) -> f32 {
  var p = p_in;
  var v = 0.0;
  var a = 0.58;
  for (var i = 0; i < 5; i = i + 1) {
    v = v + a * rh_vnoise(p);
    p = vec2f(p.x * 1.78 + p.y * 0.35, p.x * 0.35 + p.y * 1.78);
    a = a * 0.53;
  }
  return clamp(v, 0.0, 1.0);
}

// FunSearch: biome=rolling_hills, fitness=0.9994
fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord * 2.0 - U.res.xy) / U.res.y;
  let ro = vec3f(1024.0 + 300.0 * sin(U.time * 0.1), 450.0, U.time * 10.0);
  let ta = ro + vec3f(0.0, -160.0, 500.0);
  let ww = normalize(ta - ro);
  let uu = normalize(cross(ww, vec3f(0.0, 1.0, 0.0)));
  let rd = normalize(uv.x * uu + uv.y * cross(uu, ww) + 1.4 * ww);
  let sun = normalize(vec3f(0.6, 0.4, 0.3));
  var col = mix(vec3f(0.3, 0.5, 0.82), vec3f(0.9, 0.8, 0.7), pow(max(dot(rd, sun), 0.0), 4.0));
  var t = 5.0;
  for (var i = 0; i < 80; i = i + 1) {
    let p = ro + rd * t;
    let h = terrain(p.xz * 0.0025) * 360.0 + 40.0;
    let diff = p.y - h;
    if (diff < 0.5 || t > 3500.0) { break; }
    t = t + max(diff * 0.6, 3.0);
  }
  if (t < 3490.0) {
    let p = ro + rd * t;
    let xz = p.xz * 0.0025;
    let e = 0.01;
    let n = normalize(vec3f(terrain(xz - vec2f(e, 0.0)) - terrain(xz + vec2f(e, 0.0)),
                             2.0 * e,
                             terrain(xz - vec2f(0.0, e)) - terrain(xz + vec2f(0.0, e))));
    let h = terrain(xz) * 360.0 + 40.0;
    let slope = 1.0 - n.y;
    var mat = mix(vec3f(0.28, 0.46, 0.18), vec3f(0.38, 0.30, 0.22), clamp(slope * 2.0, 0.0, 1.0));
    mat = mix(mat, vec3f(0.88, 0.94, 0.98), smoothstep(305.0, 375.0, h));
    mat = mix(mat, vec3f(0.18, 0.32, 0.54), smoothstep(80.0, 52.0, h));
    col = mat * (max(dot(n, sun), 0.0) * vec3f(1.35, 1.1, 0.85) + max(n.y, 0.0) * vec3f(0.1, 0.16, 0.26));
    col = mix(col, vec3f(0.52, 0.66, 0.84), 1.0 - exp(-t * 0.00022));
  }
  return vec4f(pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545)), 1.0);
}
