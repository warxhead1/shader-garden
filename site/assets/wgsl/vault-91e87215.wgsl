// vault-91e87215 — [phase] gen16 — FunSearch fit=1.0000
// Allen-Cahn phase-kernel visualizer: maps (phi, temp) parameter space to a
// colour-coded heatmap. phi = x-axis (0..1), temp = y-axis (0..1).
// Positive reaction -> red (growing phase), negative -> blue (shrinking), near-zero -> white.
// WGSL port of the GLSL vault original. Defines mainImage(fragCoord) -> vec4f; reads U.*.

fn reaction(phi: f32, temp: f32) -> f32 {
  let dW = phi * phi * (4.0 * phi - 6.0) + 2.0 * phi;      // W'(phi)
  let m = 2.0 * (0.5 - temp);                              // >0 when cold
  let mobility = 1.0 + 0.6 * tanh(2.5 * (0.5 - temp));     // tanh temperature response
  return -dW + m * mobility + 4.0 * phi * (1.0 - phi) * m; // bulk + interface terms
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = fragCoord / U.res.xy;
  let phi = uv.x;  // phase field  [0, 1]
  let temp = uv.y; // temperature  [0, 1]

  let r = reaction(phi, temp);

  // Map signed reaction value to colour: -3..+3 -> blue..white..red
  let t = clamp(r / 3.0 + 0.5, 0.0, 1.0);
  var col = mix(vec3f(0.1, 0.3, 0.9), vec3f(0.95, 0.95, 0.95),
                t * 2.0 - clamp(t * 2.0 - 1.0, 0.0, 1.0));
  col = mix(col, vec3f(0.9, 0.15, 0.1), max(t * 2.0 - 1.0, 0.0));

  // Grid lines at phi=0.5, temp=0.5
  let grid = step(0.995, abs(sin(uv.x * 3.14159))) * 0.18
           + step(0.995, abs(sin(uv.y * 3.14159))) * 0.18;
  col = mix(col, vec3f(0.0), grid);

  return vec4f(pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545)), 1.0);
}
