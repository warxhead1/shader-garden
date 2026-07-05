// vault-394ae1b5 — (2,3) torus-knot tube SDF via nearest-sample search
// (coarse 48-point scan + a dense local refinement window), orbit camera.
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn sdf(pos: vec3f) -> f32 {
  let x = pos.x;
  let y = pos.y;
  let z = pos.z;
  let R = 0.6;
  let rm = 0.35;
  let tube = 0.15;
  let pi2 = 6.28318530;
  let p = 2.0;
  let q = 3.0;
  var best_d = 1e9;
  var best_t = 0.0;
  for (var i = 0; i < 48; i = i + 1) {
    let t = pi2 * f32(i) / 48.0;
    let rr = R + rm * cos(q * t);
    let kx = rr * cos(p * t);
    let ky = rr * sin(p * t);
    let kz = rm * sin(q * t);
    let dx = x - kx;
    let dy = y - ky;
    let dz = z - kz;
    let d = sqrt(dx * dx + dy * dy + dz * dz);
    if (d < best_d) { best_d = d; best_t = t; }
  }
  let arc_dense = pi2 / (p * 200.0);
  for (var i = -12; i <= 12; i = i + 1) {
    let t = best_t + f32(i) * arc_dense;
    let rr = R + rm * cos(q * t);
    let kx = rr * cos(p * t);
    let ky = rr * sin(p * t);
    let kz = rm * sin(q * t);
    let dx = x - kx;
    let dy = y - ky;
    let dz = z - kz;
    let d = sqrt(dx * dx + dy * dy + dz * dz);
    if (d < best_d) { best_d = d; }
  }
  return best_d - tube;
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;
  let t = U.time * 0.4 + 1.2;
  let ro = vec3f(2.0 * cos(t), 0.8 * 2.0, 2.0 * sin(t));
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
    let p2 = ro + d * rd;
    let e = 0.001;
    let n = normalize(vec3f(
      sdf(p2 + vec3f(e, 0.0, 0.0)) - sdf(p2 - vec3f(e, 0.0, 0.0)),
      sdf(p2 + vec3f(0.0, e, 0.0)) - sdf(p2 - vec3f(0.0, e, 0.0)),
      sdf(p2 + vec3f(0.0, 0.0, e)) - sdf(p2 - vec3f(0.0, 0.0, e))
    ));
    let ld = normalize(vec3f(1.5, 2.0, -0.5));
    let diff = max(dot(n, ld), 0.0);
    let spec = pow(max(dot(reflect(-ld, n), -rd), 0.0), 48.0) * 0.7;
    col = vec3f(0.15, 0.55, 0.85) * diff + vec3f(spec) + vec3f(0.08, 0.04, 0.12) * (1.0 - diff);
    col = col * exp(-d * 0.12);
  }
  return vec4f(pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545)), 1.0);
}
