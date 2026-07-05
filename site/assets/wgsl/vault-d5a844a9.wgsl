// vault-d5a844a9 — twisted multi-scale gyroid SDF raymarch (coarse+fine
// smooth union), orbit camera.
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn sdf(pos: vec3f) -> f32 {
  let x = pos.x;
  let y = pos.y;
  let z = pos.z;
  // Domain twist for richer structure
  let a = 0.1 * z;
  let ca = cos(a);
  let sa = sin(a);
  let xw = x * ca - y * sa;
  let yw = x * sa + y * ca;

  // Multi-scale gyroid: coarse + fine blended
  let s1 = 3.0;
  let s2 = 5.0;
  let f1 = sin(s1 * xw) * cos(s1 * yw) + sin(s1 * yw) * cos(s1 * z) + sin(s1 * z) * cos(s1 * xw);
  let f2 = sin(s2 * xw) * cos(s2 * yw) + sin(s2 * yw) * cos(s2 * z) + sin(s2 * z) * cos(s2 * xw);

  // Lipschitz-normalised signed distance (gradient bound = s*sqrt(3))
  let d1 = abs(f1) / (s1 * 1.7320508);
  let d2 = abs(f2) / (s2 * 1.7320508);

  // Smooth union of two scales
  let k = 0.08;
  let h = max(k - abs(d1 - d2), 0.0) / k;
  let d = min(d1, d2) - h * h * k * 0.25;

  return d - 0.1;
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;
  let t = U.time * 0.4 + 1.2;
  let ro = vec3f(3.0 * cos(t), 0.8 * 3.0, 3.0 * sin(t));
  let ww = normalize(-ro);
  let uu = normalize(cross(ww, vec3f(0.0, 1.0, 0.0)));
  let vv = cross(uu, ww);
  let rd = normalize(uv.x * uu + uv.y * vv + 1.7 * ww);

  var d = 0.001;
  let max_d = 12.0;
  for (var i = 0; i < 96; i = i + 1) {
    let h = sdf(ro + d * rd);
    if (abs(h) < 0.0015 * d || d > max_d) { break; }
    d = d + h * 0.75;
  }

  var col = vec3f(0.04, 0.02, 0.07);
  if (d < max_d) {
    let p = ro + d * rd;
    let e = 0.001;
    let n = normalize(vec3f(
      sdf(p + vec3f(e, 0.0, 0.0)) - sdf(p - vec3f(e, 0.0, 0.0)),
      sdf(p + vec3f(0.0, e, 0.0)) - sdf(p - vec3f(0.0, e, 0.0)),
      sdf(p + vec3f(0.0, 0.0, e)) - sdf(p - vec3f(0.0, 0.0, e))
    ));
    let ld = normalize(vec3f(1.5, 2.0, -0.5));
    let diff = max(dot(n, ld), 0.0);
    let spec = pow(max(dot(reflect(-ld, n), -rd), 0.0), 48.0) * 0.7;
    col = vec3f(0.15, 0.55, 0.85) * diff + vec3f(spec) + vec3f(0.08, 0.04, 0.12) * (1.0 - diff);
    col = col * exp(-d * 0.12);
  }
  return vec4f(pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545)), 1.0);
}
