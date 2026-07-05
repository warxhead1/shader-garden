// vault-20074725 — five-sphere union SDF raymarch, orbit camera.
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn sdf(pos: vec3f) -> f32 {
  let x = pos.x;
  let y = pos.y;
  let z = pos.z;
  let d = sqrt(x * x + y * y + z * z) - 0.5;
  let d2 = sqrt((x - 0.8) * (x - 0.8) + y * y + z * z) - 0.4;
  let d3 = sqrt((x + 0.7) * (x + 0.7) + (y - 0.5) * (y - 0.5) + z * z) - 0.35;
  let d4 = sqrt((x - 0.3) * (x - 0.3) + (y + 0.6) * (y + 0.6) + (z - 0.4) * (z - 0.4)) - 0.3;
  let d5 = sqrt((x + 0.5) * (x + 0.5) + y * y + (z - 0.6) * (z - 0.6)) - 0.32;
  return min(min(min(min(d, d2), d3), d4), d5);
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;
  let t = U.time * 0.4 + 1.2;
  let ro = vec3f(4.5 * cos(t), 0.8 * 4.5, 4.5 * sin(t));
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
