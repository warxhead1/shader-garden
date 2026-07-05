// vault-61990596 — FunSearch latent-heat Allen-Cahn kernel visualizer.
// phi = x-axis, temp = y-axis, lap_T = 0.3*sin(time*0.8) (oscillating
// curvature term). Same colour convention as the plain phase kernel.
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn reaction(phi: f32, temp: f32, lap_T: f32) -> f32 {
  let dW = phi * phi * (4.0 * phi - 6.0) + 2.0 * phi;
  let m = 2.0 * (0.5 - temp);
  let iface = phi * (1.0 - phi);
  // Interface sharpening: stronger response at phase boundary
  let amp = 1.0 + 4.5 * iface;
  // Nonlinear thermal suppression: stronger when lap_T > 0 (latent heat in)
  let thermal_mod = 1.0 - 0.15 * lap_T + 0.03 * lap_T * lap_T;
  // Interface-localized latent heat coupling: self-regulating equilibrium
  let thermal_coupling = -0.7 * iface * lap_T;
  return (amp * (-dW + m)) * max(0.05, thermal_mod) + thermal_coupling;
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = fragCoord / U.res.xy;
  let phi = uv.x;
  let temp = uv.y;
  let lap_T = 0.3 * sin(U.time * 0.8); // oscillating curvature term

  let r = reaction(phi, temp, lap_T);

  let t = clamp(r / 4.0 + 0.5, 0.0, 1.0);
  var col = mix(vec3f(0.05, 0.25, 0.85), vec3f(0.95, 0.95, 0.95), t * 2.0 - clamp(t * 2.0 - 1.0, 0.0, 1.0));
  col = mix(col, vec3f(0.85, 0.1, 0.05), max(t * 2.0 - 1.0, 0.0));

  // Subtle pulse showing lap_T variation
  let pulse = abs(lap_T) * 0.12;
  col += vec3f(pulse * 0.4, pulse * 0.1, -pulse * 0.2);

  return vec4f(pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545)), 1.0);
}
