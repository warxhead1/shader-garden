// vault-d2fbd4e9 — record-store milk crate SDF raymarch, drag to orbit
// (U.mouse). Built to hold 12.5" x 12.5" record shaders for a "dig through
// the vinyl" site.
//   SCALE: 1 world unit = 7 inches (S below)
//   Interior: 13" (W) x 13" (D) x 11" (H) -> a 12.5" record gets 0.5" of
//             lift clearance side-to-side and peeks ~1.5" above the rim.
//   RECORD MOUNT (for later): a record is a thin plane, 12.5" tall x 12.5"
//   wide, facing +z (toward the viewer). In world units a record spans
//     x,y in [-6.25, 6.25]*S = [-0.893, 0.893], centered at y = 0,
//   thin in z, slotted at successive z and lifted in +y to "pull and view".
//   Front of crate = +z. The empty crate is modeled here; records drop in later.
// WGSL port of the GLSL original. Defines mainImage(fragCoord) -> vec4f; reads U.*.
// GLSL's `out float id` march() param and the value params rot()/hash21()
// reassign in place have no direct WGSL equivalent (immutable bindings, no
// out-params) — march() returns a small struct instead (same pattern as
// scene.wgsl's SGHit), and hash21()/carveZ()/etc. take an `_in`-suffixed
// param and compute into a fresh local when the original mutated in place.

const PI: f32 = 3.14159265;
const S: f32 = 1.0 / 7.0; // world units per inch

fn rot(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(c, -s, s, c);
}

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
// square prism, infinite along the 3rd axis; cross-section half-size hxy in the 2 given coords
fn sdPrism(p: vec2f, hxy: vec2f) -> f32 {
  let d = abs(p) - hxy;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}
fn hash21(p_in: vec2f) -> f32 {
  var p = fract(p_in * vec2f(123.34, 456.21));
  p = p + vec2f(dot(p, p + 45.32));
  return fract(p.x * p.y);
}

// baked text mask 256x72, 576 words
const TXT: array<u32, 576> = array<u32, 576>(
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,3248484352u,2145380348u,2214338432u,4167437567u,58783745u,523390u,0u,0u,3250581504u,2145380348u,2214477760u,
  4234546431u,126090755u,523519u,0u,0u,3246587904u,234905628u,815328u,241568796u,126029315u,7363u,0u,
  0u,3246587904u,234905628u,974944u,241568796u,113248000u,7171u,0u,0u,3246587904u,234905628u,974944u,
  1013386268u,213911296u,7183u,0u,0u,4286775296u,236972028u,33480800u,4167564316u,216008449u,523390u,0u,
  0u,4286775296u,236971004u,67035232u,3764911132u,216008451u,261360u,0u,0u,3246587904u,234938396u,974944u,
  6687772u,534775559u,7616u,0u,0u,3246587904u,234905628u,942304u,107351068u,2683504135u,7619u,0u,
  0u,3246587904u,234907644u,817600u,2657487900u,942906883u,523719u,0u,0u,3246587904u,234907644u,933760u,
  4234546716u,808582147u,523519u,0u,0u,0u,0u,1536u,1610612736u,8192u,24u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,4039114752u,4160778243u,1886588912u,1022u,0u,0u,0u,0u,4173332480u,4261474311u,
  1895014387u,1022u,0u,0u,0u,0u,482344960u,234942470u,2029238323u,14u,0u,0u,
  0u,0u,482344960u,117495808u,2029238320u,14u,0u,0u,0u,0u,2025848832u,117544960u,
  2046015536u,14u,0u,0u,0u,0u,4039114752u,117545987u,1840455664u,1022u,0u,0u,
  0u,0u,3233808384u,117545991u,1840451568u,510u,0u,0u,0u,0u,12582912u,117701646u,
  1865616944u,14u,0u,0u,0u,0u,213909504u,100924942u,1731402803u,14u,0u,0u,
  0u,0u,1019215872u,2651260423u,1731401779u,1022u,0u,0u,0u,0u,4173332480u,4228253191u,
  1714665521u,1022u,0u,0u,0u,0u,3221225472u,536870912u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,2600468480u,3365162892u,132007427u,3834373063u,255615457u,121u,0u,0u,2600468480u,1771362716u,2161329670u,
  881426504u,19297057u,73u,0u,0u,3120562176u,731236758u,3284616752u,1962442840u,253546544u,57u,0u,
  0u,3992977408u,714436502u,3285992967u,3304686552u,255381553u,115u,0u,0u,1845493760u,1855417534u,2152817670u,
  344490056u,23394849u,201u,0u,0u,1711276032u,3432401315u,2279554103u,4103700591u,524127201u,121u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,3254779904u,2130077891u,
  1086839294u,806u,0u,0u,0u,0u,1728053248u,429320390u,3770702232u,372u,0u,0u,
  0u,0u,1694498816u,410446304u,2697191320u,372u,0u,0u,0u,0u,1837105152u,434596327u,
  2965626776u,477u,0u,0u,0u,0u,1870659584u,429353444u,4039137688u,477u,0u,0u,
  0u,0u,3363831808u,435579703u,398973336u,217u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
  0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,0u
);

// sample baked front text (uv origin bottom-left). returns 0/1
fn textMask(uv: vec2f) -> f32 {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
  let x = clamp(i32(uv.x * 256.0), 0, 255);
  let y = clamp(i32((1.0 - uv.y) * 72.0), 0, 71);
  let bit = u32(y * 256 + x);
  let word = TXT[bit >> 5u];
  return f32((word >> (bit & 31u)) & 1u);
}

// ---- crate dimensions, in inches (evaluated in inch-space, then scaled by S) ----
const WALL: f32 = 0.45;
const IHALF: vec3f = vec3f(6.50, 5.50, 6.50);             // interior half (13 x 11 x 13)
const OHALF: vec3f = vec3f(6.95, 5.50, 6.95);             // exterior half (open top)
// vertical bands (y, bottom of crate = -5.5, top = +5.5)
const MIDC: f32 = 0.15;
const MIDH: f32 = 2.15;                                   // diamond mesh band  (-2.0 .. +2.3)
const TOPC: f32 = 3.40;
const TOPH: f32 = 1.10;                                   // horizontal-rib band (+2.3 .. +4.5)
const XWIN: f32 = 6.20;                                   // carve window half (leaves corner posts)

var<private> g_id: f32; // material id from map()

// diamond mesh carved through z (front/back walls), inside an (x,y) window
fn carveZ(P: vec3f, yc: f32, yh: f32) -> f32 {
  let w = P.xy - vec2f(0.0, yc);
  let win = max(abs(w.x) - XWIN, abs(w.y) - yh);
  let r = rot(0.7854) * w; // 45deg -> square holes become diamonds
  let id = clamp(floor(r / 1.65 + 0.5), vec2f(-12.0), vec2f(12.0));
  let hole = sdPrism(r - 1.65 * id, vec2f(0.60));
  return max(hole, win);
}
fn carveX(P: vec3f, yc: f32, yh: f32) -> f32 {
  let w = P.zy - vec2f(0.0, yc);
  let win = max(abs(w.x) - XWIN, abs(w.y) - yh);
  let r = rot(0.7854) * w;
  let id = clamp(floor(r / 1.65 + 0.5), vec2f(-12.0), vec2f(12.0));
  let hole = sdPrism(r - 1.65 * id, vec2f(0.60));
  return max(hole, win);
}
// horizontal rib slots in the top band (open gaps between bars)
fn slotsZ(P: vec3f) -> f32 {
  let w = P.xy - vec2f(0.0, TOPC);
  let win = max(abs(w.x) - XWIN, abs(w.y) - TOPH);
  let yy = w.y - 0.55 * clamp(floor(w.y / 0.55 + 0.5), -5.0, 5.0);
  return max(abs(yy) - 0.18, win);
}
fn slotsX(P: vec3f) -> f32 {
  let w = P.zy - vec2f(0.0, TOPC);
  let win = max(abs(w.x) - XWIN, abs(w.y) - TOPH);
  let yy = w.y - 0.55 * clamp(floor(w.y / 0.55 + 0.5), -5.0, 5.0);
  return max(abs(yy) - 0.18, win);
}
// oblong handle hole near the top of front & back (carved through z)
fn handleHole(P: vec3f) -> f32 {
  let w = P.xy - vec2f(0.0, 4.05);
  let d = abs(w) - vec2f(2.30, 0.45);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))) - 0.35;
}

// crate SDF in inch-space
fn crateIn(P: vec3f) -> f32 {
  let outer = sdBox(P, OHALF) - 0.12; // slight rounding for plastic
  // cavity: closed bottom, open top
  let cavTop = OHALF.y + 2.0;
  let cavBot = -OHALF.y + WALL;
  let inner = sdBox(P - vec3f(0.0, (cavTop + cavBot) * 0.5, 0.0),
                     vec3f(IHALF.x, (cavTop - cavBot) * 0.5, IHALF.z));
  var shell = max(outer, -inner);

  // overhanging top rim lip
  let lipO = sdBox(P - vec3f(0.0, 4.95, 0.0), vec3f(OHALF.x + 0.28, 0.55, OHALF.z + 0.28)) - 0.1;
  let lipI = sdBox(P - vec3f(0.0, 4.95, 0.0), vec3f(IHALF.x, 1.6, IHALF.z));
  shell = min(shell, max(lipO, -lipI));

  // raised nameplate plaques on the front (+z) and back (-z) solid base
  let plaqF = sdBox(P - vec3f(0.0, -3.65, OHALF.z), vec3f(5.70, 1.55, 0.30)) - 0.04;
  let plaqB = sdBox(P - vec3f(0.0, -3.65, -OHALF.z), vec3f(5.70, 1.55, 0.30)) - 0.04;
  shell = min(shell, min(plaqF, plaqB));

  // carve the mesh, rib slots and handle
  var carve = carveZ(P, MIDC, MIDH);
  carve = min(carve, carveX(P, MIDC, MIDH));
  carve = min(carve, slotsZ(P));
  carve = min(carve, slotsX(P));
  carve = min(carve, handleHole(P));
  shell = max(shell, -carve);
  return shell;
}

fn map(p: vec3f) -> f32 {
  var d = 1e9;
  g_id = 0.0;
  let fl = p.y - (-OHALF.y * S); // floor at crate bottom
  if (fl < d) { d = fl; g_id = 0.0; }
  let cr = S * crateIn(p / S); // scale crate from inch-space
  if (cr < d) { d = cr; g_id = 1.0; }
  return d;
}

fn calcNormal(p: vec3f) -> vec3f {
  let e = vec2f(0.0012, 0.0);
  return normalize(vec3f(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)));
}

struct MarchHit { t: f32, id: f32 }

fn march(ro: vec3f, rd: vec3f) -> MarchHit {
  var t = 0.02;
  var id = -1.0;
  for (var i = 0; i < 200; i = i + 1) {
    let p = ro + t * rd;
    let d = map(p);
    if (d < 0.0008) { id = g_id; return MarchHit(t, id); }
    t = t + d * 0.7;
    if (t > 16.0) { break; }
  }
  return MarchHit(-1.0, id);
}

fn softShadow(ro: vec3f, rd: vec3f) -> f32 {
  var res = 1.0;
  var t = 0.04;
  for (var i = 0; i < 48; i = i + 1) {
    let h = map(ro + rd * t);
    if (h < 0.001) { return 0.04; }
    res = min(res, 10.0 * h / t);
    t = t + clamp(h, 0.01, 0.10);
    if (t > 7.0) { break; }
  }
  return clamp(res, 0.04, 1.0);
}
fn ao(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  for (var i = 0; i < 5; i = i + 1) {
    let hr = 0.01 + 0.10 * f32(i);
    occ = occ + (hr - map(p + n * hr)) * sca;
    sca = sca * 0.72;
  }
  return clamp(1.0 - 1.5 * occ, 0.0, 1.0);
}

fn background(rd: vec3f) -> vec3f {
  let h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(vec3f(0.42, 0.43, 0.46), vec3f(0.20, 0.22, 0.27), h);
}

fn material(p: vec3f, n: vec3f, id: f32) -> vec3f {
  if (id < 0.5) { // speckled concrete floor
    let g = p.xz * 9.0;
    let sp = hash21(floor(g)) + hash21(floor(g * 3.1)) * 0.5;
    let c = vec3f(0.60, 0.59, 0.575) + vec3f((sp - 0.7) * 0.10);
    return c;
  }
  // red plastic crate (worn matte)
  let wear = 0.85 + 0.15 * hash21(floor(p.xz * 40.0) + vec2f(floor(p.y * 40.0)));
  var red = vec3f(0.60, 0.085, 0.075) * wear;
  red = red + vec3f(0.04 * smoothstep(0.3, 1.0, n.y)); // slight top sheen
  // embossed warning text on the front (+z) nameplate plaque
  let P = p / S; // back to inch-space
  if (P.z > 7.05 && n.z > 0.4 && P.y > -5.3 && P.y < -2.0) {
    let tuv = vec2f((P.x + 5.6) / 11.2, (P.y + 5.20) / 3.10);
    let m = textMask(tuv);
    red = mix(red, vec3f(0.86, 0.84, 0.78), m * 0.92); // raised cream lettering
  }
  return red;
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * U.res.xy) / U.res.y;

  var yaw = 0.30 + 0.14 * sin(0.12 * U.time);
  var pitch = 0.34;
  if (U.mouse.z > 0.0) {
    yaw = -PI + 6.2832 * (U.mouse.x / U.res.x);
    pitch = mix(0.05, 1.30, clamp(U.mouse.y / U.res.y, 0.0, 1.0));
  }
  let rad = 5.4;
  let ta = vec3f(0.0, -0.02, 0.0);
  let ro = ta + rad * vec3f(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
  let ww = normalize(ta - ro);
  let uu = normalize(cross(ww, vec3f(0.0, 1.0, 0.0)));
  let vv = cross(uu, ww);
  let rd = normalize(uv.x * uu + uv.y * vv + 1.9 * ww);

  let key = normalize(vec3f(-0.55, 0.72, 0.45));
  var col = background(rd);

  let hit = march(ro, rd);
  if (hit.t > 0.0) {
    let p = ro + hit.t * rd;
    let n = calcNormal(p);
    let base = material(p, n, hit.id);

    let dif = clamp(dot(n, key), 0.0, 1.0);
    let sh = softShadow(p + n * 0.01, key);
    let occ = ao(p, n);
    let amb = background(n) * 0.7;
    let spec = pow(max(dot(reflect(-key, n), -rd), 0.0), 32.0);
    let fres = pow(1.0 - max(dot(n, -rd), 0.0), 4.0);

    col = base * (amb * occ + vec3f(1.0, 0.96, 0.9) * dif * sh * 1.1);
    col = col + vec3f(1.0, 0.97, 0.9) * spec * sh * 0.35 * select(0.0, 1.0, hit.id > 0.5);
    col = col + vec3f(fres * 0.06);
    col = mix(col, background(rd), smoothstep(9.0, 15.0, hit.t));
  }

  col = (col * (2.51 * col + vec3f(0.03))) / (col * (2.43 * col + vec3f(0.59)) + vec3f(0.14)); // ACES
  col = clamp(col, vec3f(0.0), vec3f(1.0));
  col = col * (1.0 - 0.18 * dot(uv, uv)); // vignette
  col = pow(col, vec3f(0.4545));
  return vec4f(col, 1.0);
}
