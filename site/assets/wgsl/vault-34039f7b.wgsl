// vault-34039f7b — twisted triply-periodic surface SDF raymarch, drag to
// orbit/zoom (idle auto-spins).
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn sdf(pos: vec3f) -> f32 {
  let x = pos.x;
  let y = pos.y;
  let z = pos.z;
  let s = 3.0;
  let k = 0.3;
  let angle = k * z;
  let xw = x * cos(angle) - y * sin(angle);
  let yw = x * sin(angle) + y * cos(angle);
  let f = sin(s * xw) * cos(s * yw) + sin(s * yw) * cos(s * z) + sin(s * z) * cos(s * xw);
  let grad = s * 1.8;
  return abs(f) / grad - 0.08;
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;
  // Camera: drag horizontally to orbit, vertically to zoom; idle auto-spins.
  var t = U.time * 0.4 + 1.2;
  var cr = 3.0;
  if (U.mouse.z > 0.0) {
    t = (U.mouse.x / U.res.x) * 6.2831853 + 1.2;
    cr = 3.0 * (0.45 + 1.4 * clamp(U.mouse.y / U.res.y, 0.0, 1.0));
  }
  let ro = vec3f(cr * cos(t), 0.8 * 3.0, cr * sin(t));
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
