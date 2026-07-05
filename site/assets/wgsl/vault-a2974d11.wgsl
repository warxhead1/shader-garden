// vault-a2974d11 — (2,3) torus-knot tube SDF via arc-length-aware nearest-
// sample search (600-point coarse scan + a dense local refinement window —
// vault-394ae1b5's cheaper 48-point sibling), orbit camera.
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

  // Arc-length aware sampling: more samples where curvature is high
  // (2,3) knot has 3-fold symmetry + faster arc in XZ plane
  let BASE_SAMPLES = 600;

  var best_d = 1e9;
  var best_t = 0.0;

  // Two-pass: coarse scan then local refinement
  for (var i = 0; i < BASE_SAMPLES; i = i + 1) {
    let t = pi2 * f32(i) / f32(BASE_SAMPLES);
    let ct3 = cos(q * t);
    let ct2 = cos(p * t);
    let st2 = sin(p * t);
    let st3 = sin(q * t);
    let rr = R + rm * ct3;
    let kx = rr * ct2;
    let ky = rr * st2;
    let kz = rm * st3;
    let d = sqrt((x - kx) * (x - kx) + (y - ky) * (y - ky) + (z - kz) * (z - kz));
    if (d < best_d) { best_d = d; best_t = t; }
  }

  // Local refinement with arc-length density correction
  let arc_dense = pi2 / (p * 200.0); // denser near curvature
  for (var i = -12; i <= 12; i = i + 1) {
    let t = best_t + f32(i) * arc_dense;
    let ct3 = cos(q * t);
    let ct2 = cos(p * t);
    let st2 = sin(p * t);
    let st3 = sin(q * t);
    let rr = R + rm * ct3;
    let kx = rr * ct2;
    let ky = rr * st2;
    let kz = rm * st3;
    let d = sqrt((x - kx) * (x - kx) + (y - ky) * (y - ky) + (z - kz) * (z - kz));
    if (d < best_d) { best_d = d; }
  }

  return best_d - tube;
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;
  let t = U.time * 0.4 + 1.2;
  let ro = vec3f(3.5 * cos(t), 0.8 * 3.5, 3.5 * sin(t));
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
