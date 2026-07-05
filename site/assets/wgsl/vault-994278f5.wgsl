// vault-994278f5 — FunSearch SPH (smoothed-particle hydrodynamics) kernel
// visualizer. Plots the quintic kernel W(r, h=1) against r/h in [0, 1.2],
// normalised to its own peak; the compact-support cutoff at r/h=1 is marked
// with a dashed vertical line. Pure 2D plot — no raymarch.
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn sph_kernel(r: f32, h: f32) -> f32 {
  let q = r / h;
  if (q >= 1.0) { return 0.0; }
  let m = 1.0 - q;
  let sigma = 1536.0 / (478.0 * 3.14159265 * h * h * h);
  let poly = 1.0 + 5.0 * q + 10.0 * q * q + 10.0 * q * q * q +
             5.0 * q * q * q * q + q * q * q * q * q;
  var m5 = m * m;
  m5 = m5 * m5 * m;
  return sigma * m5 * poly;
}

fn sampleW(rh: f32) -> f32 {
  let h = 1.0;
  return sph_kernel(rh * h, h);
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = fragCoord / U.res.xy;
  var col = vec3f(0.08, 0.08, 0.12);

  let rh_range = 1.3;
  let rh = uv.x * rh_range;

  // Evaluate the curve value at this column
  let W_here = sampleW(rh);
  let W_max = sampleW(0.0);
  let W_norm = select(0.0, W_here / W_max, W_max > 0.0);

  // Plot curve: draw band around the normalised value
  let curve_y = W_norm;
  let dist = abs(uv.y - curve_y);
  let line_w = 2.0 / U.res.y;
  col = mix(vec3f(0.2, 0.75, 0.95), col, smoothstep(0.0, line_w * 2.0, dist));

  // Fill under the curve
  if (uv.y < curve_y) {
    col = mix(col, vec3f(0.1, 0.35, 0.55), 0.35);
  }

  // Dashed vertical at r/h = 1.0
  let cutoff_x = 1.0 / rh_range;
  let cx = abs(uv.x - cutoff_x);
  let dash = step(0.5, fract(uv.y * 14.0));
  col = mix(col, vec3f(0.95, 0.65, 0.1), dash * (1.0 - smoothstep(0.0, 3.0 / U.res.x, cx)));

  // Axis labels (grid lines)
  col = mix(col, vec3f(0.35), vec3f(step(uv.y, 0.012) + step(uv.x, 0.012 * U.res.y / U.res.x)));

  return vec4f(pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545)), 1.0);
}
