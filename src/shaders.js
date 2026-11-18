// ============================================================================
// WGSL shaders
// ============================================================================
const S_G = /*wgsl*/`
struct G {
  vp: mat4x4f, sm: mat4x4f,
  cam: vec4f,    // xyz eye, w time
  sun: vec4f,    // xyz direction to the sun (the moon at night), w night amount
  sunC: vec4f,   // sun colour * intensity
  skyZ: vec4f,   // zenith colour
  skyH: vec4f,   // horizon colour
  fwd: vec4f,    // xyz, w near plane
  right: vec4f,  // xyz, w tan(half fov x)
  up: vec4f,     // xyz, w tan(half fov y)
  res: vec4f,    // w, h, 1/w, 1/h of the scene target
  bio: vec4f,    // forest, meadow, alpine, autumn at the camera
  wind: vec4f,   // xz direction, strength, headlamp brightness
  shc: vec4f,    // shadow map centre xyz, radius
  bird: vec4f,   // centre of the bird flock
  misc: vec4f,   // exposure, light shaft density, fog density, dusk
};
@group(0) @binding(0) var<uniform> g: G;
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = sat((x - a) / (b - a)); return t * t * (3. - 2. * t); }
fn h21(p: vec2f) -> f32 { var q = fract(p.xyx * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn h11(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn vn(p: vec2f) -> f32 {
  let i = floor(p); var f = p - i; f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2f(1., 0.)), f.x), mix(h21(i + vec2f(0., 1.)), h21(i + vec2f(1., 1.)), f.x), f.y);
}
fn fbm(p0: vec2f, n: i32) -> f32 {
  var p = p0; var a = .5; var s = 0.;
  for (var i = 0; i < n; i++) { s += a * vn(p); p = vec2f(p.x * 1.6 + p.y * 1.2, p.y * 1.6 - p.x * 1.2) + 11.3; a *= .5; }
  return s;
}
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
// biome weights along the trail (same as biome() in world.js): forest, meadow, alpine, autumn
fn biome(z: f32) -> vec4f {
  let th = z * .0045 + .5 * sin(z * .0013);
  let w = vec3f(ss(.2, .75, cos(th)), ss(.2, .75, cos(th - 2.0944)), ss(.2, .75, cos(th - 4.1888)));
  return vec4f(w / (w.x + w.y + w.z), ss(.3, .7, .5 + .5 * sin(z * .0011 + 4.)));
}
// the trail's sideways position along z (same as trailX() in world.js)
fn trailX(z: f32) -> f32 {
  let s = .5 + .5 * sin(z * .0019 + .7);
  return 38. * sin(z * .0061 + .5) + 17. * sin(z * .0173 + 2.1) + (.25 + .75 * s * s) * (11. * sin(z * .043 + 4.) + 5. * sin(z * .083 + 1.3));
}
// leaf colour from summer green (0) through gold and orange to red (1)
fn pal(t: f32) -> vec3f {
  var c = mix(vec3f(.05, .12, .016), vec3f(.13, .23, .03), sat(t * 5.));
  c = mix(c, vec3f(.50, .36, .03), ss(.25, .5, t));
  c = mix(c, vec3f(.52, .17, .02), ss(.5, .75, t));
  return mix(c, vec3f(.33, .045, .02), ss(.78, 1., t));
}
// clear sky without clouds or the sun disc
fn sky(rd: vec3f) -> vec3f {
  let h = max(rd.y, 0.);
  let mu = max(dot(rd, g.sun.xyz), 0.);
  // at dusk the horizon glows only on the sun's side and cools to violet away from it
  let side = ss(-.5, 1., dot(normalize(rd.xz + 1e-5), normalize(g.sun.xz)));
  let hz = mix(g.skyH.rgb, mix(vec3f(.16, .13, .27), g.skyH.rgb, side * side), g.misc.w);
  var c = mix(hz, g.skyZ.rgb, 1. - exp(-h * mix(3.2, 4.5, g.misc.w)));
  c = mix(c, vec3f(.5, .3, .42) * (.4 + .6 * side), g.misc.w * .45 * exp(-abs(h - .16) * 9.));
  return c + g.sunC.rgb * (pow(mu, 5.) * .018 + pow(mu, 40.) * .05);
}
// aerial haze: thicker low down, fully closed by 1.08 km (where the generated land ends)
fn fog(c: vec3f, wp: vec3f) -> vec3f {
  let v = wp - g.cam.xyz; let d = length(v); let rd = v / d;
  let k = .006 * v.y;
  let hf = select((1. - exp(-k)) / k, 1., abs(k) < 1e-3);
  var T = exp(-g.misc.z * d * hf);
  T *= 1. - ss(820., 1080., length(v.xz));
  let fc = sky(normalize(vec3f(rd.x, max(rd.y, 0.) * .5 + .03, rd.z)));
  return mix(fc, c, T);
}
fn amb(n: vec3f) -> vec3f { return mix(g.skyH.rgb * .22 + vec3f(.03, .035, .015) * (1. - .85 * g.sun.w), g.skyZ.rgb * .6 + g.skyH.rgb * .3, n.y * .5 + .5); }
// The headlamp: a warm cone of light from the eye along the view, with a bright centre, a soft edge, a faint wide
// spill so things beside you are not pitch black, and a falloff with distance. wrap softens it for thin foliage.
fn lamp(wp: vec3f, n: vec3f, wrap: f32) -> vec3f {
  if (g.wind.w < .001) { return vec3f(0.); }
  let v = g.cam.xyz - wp; let d = length(v); let l = v / d;
  let ca = dot(-l, g.fwd.xyz);
  let cone = ss(.80, .95, ca) * (.55 + .45 * ss(.95, .995, ca)) + .05 * ss(.2, .8, ca);
  return vec3f(1., .9, .74) * (g.wind.w * cone * mix(sat(dot(n, l)), 1., wrap) / (1. + .014 * d * d));
}
fn windAt(p: vec3f) -> vec2f {
  let ph = dot(p.xz, g.wind.xy) * .07 - g.cam.w * .8;
  return g.wind.xy * (g.wind.z * (.5 + .5 * sin(ph) * sin(ph * .37 + 1.7) + .15 * sin(ph * 2.3)));
}
// Level of detail is chosen per tree, not per chunk: every tree mesh carries its level (0 near, 1 middle, 2 far,
// 3 always) and collapses to nothing outside its own distance range. The distance is nudged by the tree's seed so
// neighbours change at different moments. Nothing switches in one frame: over 70-95 m the near mesh morphs into
// exactly the middle one (half its leaf cards shrink away, the rest grow, twigs melt into their branches), and
// over 225-250 m the middle mesh's leaves shrink while the far crown swells out from the trunk.
fn lodDist(ia: vec4f, ib: vec4f) -> f32 { return length(ia.xyz - g.cam.xyz) + (ib.y - .5) * 26.; }
fn lodKeep(lod: f32, d: f32) -> f32 {
  if (lod < .5) { return step(d, 95.); }
  if (lod < 1.5) { return step(95., d) * step(d, 250.); }
  if (lod < 2.5) { return step(225., d); }
  return 1.;
}
fn rotY(v: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(c * v.x + s * v.z, v.y, c * v.z - s * v.x); }
// fullscreen triangle, just in front of the far plane (depth is reversed: far = 0)
@vertex fn vsF(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 1e-6, 1.); }
`;

// shadow map lookups (group 1; not bound while the shadow map itself is drawn)
const S_SH = /*wgsl*/`
@group(1) @binding(0) var tSh: texture_depth_2d;
@group(1) @binding(1) var sSh: sampler_comparison;
fn shUV(p: vec3f) -> vec3f { let s = g.sm * vec4f(p, 1.); return vec3f(s.x * .5 + .5, .5 - s.y * .5, s.z); }
fn shFade(p: vec3f) -> f32 { return ss(g.shc.w * .78, g.shc.w * .97, length(p.xz - g.shc.xz)); }
fn shadow1(p: vec3f, far: f32) -> f32 {
  let s = shUV(p);
  return mix(textureSampleCompareLevel(tSh, sSh, s.xy, s.z - .0012), far, shFade(p));
}
fn shadow9(p: vec3f, n: vec3f, far: f32) -> f32 {
  let s = shUV(p + n * .07); let tx = 1.3 / f32(textureDimensions(tSh).x);
  var v = 0.;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) { v += textureSampleCompareLevel(tSh, sSh, s.xy + vec2f(f32(x), f32(y)) * tx, s.z - .0009); } }
  return mix(v / 9., far, shFade(p));
}
fn shadow4(p: vec3f, n: vec3f, far: f32) -> f32 {
  let s = shUV(p + n * .1); let tx = .9 / f32(textureDimensions(tSh).x);
  var v = 0.;
  for (var k = 0; k < 4; k++) { v += textureSampleCompareLevel(tSh, sSh, s.xy + vec2f(f32(k & 1) * 2. - 1., f32(k >> 1) * 2. - 1.) * tx, s.z - .0012); }
  return mix(v * .25, far, shFade(p));
}
// shade under the canopy where the shadow map does not reach
fn farShade(z: f32) -> f32 { return 1. - .62 * biome(z).x; }
`;

const W_SCENE = (AA) => S_G + S_SH + /*wgsl*/`
// ---------------------------------------------------------------- terrain
struct TO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) dr: vec2f };
@vertex fn vsT(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) dr: vec2f) -> TO {
  var o: TO; o.cp = g.vp * vec4f(p, 1.); o.wp = p; o.n = n; o.dr = dr; return o;
}
@fragment fn fsT(i: TO) -> @location(0) vec4f {
  let wp = i.wp; let ad = abs(i.dr.x); let rise = i.dr.y;
  let dist = length(wp - g.cam.xyz);
  let b = biome(wp.z);
  let det = sat(1. - dist / 60.); let det2 = sat(1. - dist / 240.);
  let lf = fbm(wp.xz * .06, 3);
  let mf = mix(.5, vn(wp.xz * .9), det2);
  let hf = mix(.5, vn(wp.xz * 6.5), det);
  let ff = mix(.5, vn(wp.xz * 23.), det * det);
  let gn = normalize(i.n);
  let n = normalize(gn + vec3f(mf - .5, 0., hf - .5) * .5 * det + vec3f(hf - .5, 0., ff - .5) * .5 * det);
  let slope = 1. - gn.y;
  // ground cover per biome
  let litter = ss(.35, .62, lf + (hf - .5) * .4);
  var forest = mix(vec3f(.055, .095, .022), vec3f(.115, .075, .036), litter * .8);
  forest = mix(forest, vec3f(.26, .14, .035), b.w * litter * (.5 + .5 * ff));
  let meadow = mix(vec3f(.085, .17, .03), vec3f(.19, .21, .05), ss(.3, .7, lf));
  let alpine = mix(vec3f(.10, .13, .045), vec3f(.19, .17, .085), lf);
  var alb = (forest * b.x + meadow * b.y + alpine * b.z) * (.7 + .6 * mf) * (.85 + .3 * ff);
  // rock on steep ground and high up
  let rock = vec3f(.24, .23, .22) * (.5 + .55 * mf + .35 * hf) * (.8 + .4 * ff);
  let rw = max(ss(.2, .4, slope + (lf - .5) * .25), b.z * ss(40., 190., rise + lf * 90.) * .9);
  alb = mix(alb, rock, rw);
  // far beyond the planted trees the hills are painted with canopy
  let cano = ss(640., 720., ad) * (1. - rw) * (.55 + .7 * vn(wp.xz * .11));
  alb = mix(alb, pal(b.w * .55 + .08) * .8, cano * b.x);
  alb = mix(alb, vec3f(.03, .06, .03), cano * b.z * (1. - ss(60., 140., rise)));
  let snow = b.z * ss(250., 340., rise + lf * 110.) * ss(.62, .3, slope);
  alb = mix(alb, vec3f(.86, .89, .95), snow);
  // the trail: packed earth, gravel in the mountains
  let tsl = trailX(wp.z + .5) - trailX(wp.z - .5); // where the trail runs at an angle, measure its width square to it
  let tw = 1. - ss(.62, 1.2, ad / sqrt(1. + tsl * tsl) + (vn(vec2f(wp.z * .35, 3.)) - .5) * .5 + (hf - .5) * .35 * det);
  var dirt = mix(vec3f(.21, .14, .085), vec3f(.33, .245, .16), mf) * (.72 + .5 * hf) * (.8 + .4 * ff);
  dirt = mix(dirt, vec3f(.17, .16, .145) * (.6 + .5 * hf + .4 * ff), b.z * .75);
  dirt = mix(dirt, forest * 1.5, b.x * ss(.5, .75, ff + lf * .3) * .6);
  alb = mix(alb, dirt, tw);
  let sh = shadow9(wp, gn, farShade(wp.z));
  let ao = mix(1., .62, b.x * ss(1.5, 10., ad) * (1. - cano));
  let c = alb * (g.sunC.rgb * sat(dot(n, g.sun.xyz)) * sh + amb(n) * ao + lamp(wp, n, .15));
  return vec4f(fog(c, wp), 1.);
}

// ---------------------------------------------------------------- solid meshes: trunks, rocks, distant crowns
struct SO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) lp: vec3f, @location(3) k: vec4f };
@vertex fn vsS(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) aux: vec2f, @location(3) ia: vec4f, @location(4) ib: vec4f) -> SO {
  var o: SO;
  let lod = floor(aux.y * .1 + .01); let kf = aux.y - lod * 10.; let kind = floor(kf); let d = lodDist(ia, ib);
  var q = p - n * ((kf - kind) * ss(70., 95., d));
  if (lod > 1.5 && lod < 2.5 && kind > 2.5) { let gw = ss(225., 250., d); q = vec3f(q.x * gw, q.y, q.z * gw); }
  var wp = rotY(q * (ia.w * lodKeep(lod, d)), ib.x) + ia.xyz;
  let w = windAt(ia.xyz) * (1. + .3 * sin(g.cam.w * 2.1 + ib.y * 40.));
  wp += vec3f(w.x, 0., w.y) * aux.x;
  o.cp = g.vp * vec4f(wp, 1.); o.wp = wp; o.n = rotY(n, ib.x); o.lp = p * ia.w + ib.y * 7.; o.k = vec4f(kind, ib.z, ib.y, aux.x);
  return o;
}
@fragment fn fsS(i: SO) -> @location(0) vec4f {
  let kind = i32(i.k.x + .5); let lp = i.lp;
  var n = normalize(i.n);
  let fn0 = normalize(cross(dpdx(i.wp), dpdy(i.wp)));
  let dist = length(i.wp - g.cam.xyz); let det = sat(1. - dist / 90.);
  let b = biome(i.wp.z);
  var alb = vec3f(.2); var tr = 0.;
  if (kind == 0) { // bark
    let s = fbm(vec2f((lp.x + lp.z) * 5., lp.y * 1.1), 3);
    alb = mix(vec3f(.085, .065, .048), vec3f(.21, .17, .13), ss(.3, .7, s)) * mix(1., .6 + .8 * vn(vec2f((lp.x - lp.z) * 22., lp.y * 5.)), det);
    alb = mix(alb, vec3f(.07, .12, .03), ss(.5, .75, fbm(lp.xz * 2. + lp.y * .6, 2)) * sat(1.2 - (i.wp.y - g.cam.y + 1.7) * .25) * .7 * b.x);
  } else if (kind == 1) { // birch
    let m = vn(vec2f((lp.x + lp.z) * 4., lp.y * 16.));
    alb = mix(vec3f(.72, .70, .64), vec3f(.07, .06, .05), ss(.66, .8, m) * det + (1. - det) * .15) * (.8 + .3 * vn(lp.xy * 3.));
  } else if (kind == 2) { // rock
    n = normalize(mix(n, select(fn0, -fn0, dot(fn0, n) < 0.), .55));
    let s = fbm(lp.xz * 2.5 + lp.y * 1.7, 3);
    alb = vec3f(.31, .295, .28) * (.45 + .9 * s) * mix(1., .7 + .6 * vn(lp.xy * 30. + lp.z * 17.), det);
    alb = mix(alb, vec3f(.36, .37, .22), ss(.62, .7, vn(lp.xz * 9. + lp.y * 5.)) * .5);
    alb = mix(alb, vec3f(.06, .11, .028), ss(.45, .8, n.y + (s - .5)) * (b.x * .85 + b.y * .3));
  } else if (kind == 3) { // distant broadleaf crown
    let s = vn(lp.xz * 1.1) * .6 + vn(lp.xy * 1.3 + 3.) * .4;
    alb = pal(i.k.y + (s - .5) * .12) * (.35 + .7 * s); tr = .3;
    n = normalize(n + vec3f(vn(lp.yz * 1.2) - .5, .15, vn(lp.xy * 1.2 + 7.) - .5) * .8);
  } else { // distant conifer
    let s = vn(vec2f(lp.x + lp.z, lp.y * 3.));
    alb = vec3f(.02, .046, .024) * (.45 + s); n = normalize(n + vec3f(0., .6, 0.));
  }
  let sh = shadow9(i.wp + n * select(0., .6, kind >= 3), n, mix(farShade(i.wp.z), 1., sat(i.k.w * 3.)));
  let V = normalize(i.wp - g.cam.xyz); let back = sat(dot(V, g.sun.xyz));
  var c = alb * (g.sunC.rgb * sat(dot(n, g.sun.xyz)) * sh + amb(n) * mix(.6, 1., sat(i.k.w * 3. + .3 - b.x * .3)) + lamp(i.wp, n, .25));
  c += alb * vec3f(1.3, 1.2, .4) * g.sunC.rgb * (tr * sh * (.15 + .5 * back * back));
  return vec4f(fog(c, i.wp), 1.);
}

// ---------------------------------------------------------------- cards: leaves, needles, ferns, flowers
struct CO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) k: vec4f };
@vertex fn vsC(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(5) sr: vec2f, @location(6) mc: vec4f, @location(3) ia: vec4f, @location(4) ib: vec4f) -> CO {
  var o: CO;
  let lod = floor(sr.y * .1); let d = lodDist(ia, ib);
  var ks = 1.;
  if (mc.w > 2.5) { ks = 1. - ss(225., 250., d); } else if (mc.w > 1.5) { ks = 1. - ss(70., 95., d); } else if (mc.w > .5) { ks = 1. + .4 * ss(70., 95., d); }
  var wp = rotY((mc.xyz + (p - mc.xyz) * ks) * (ia.w * lodKeep(lod, d)), ib.x) + ia.xyz;
  let w = windAt(ia.xyz) * (1. + .3 * sin(g.cam.w * 2.1 + ib.y * 40.));
  let rnd = fract(sr.y);
  let fl = sin(g.cam.w * (3.5 + rnd * 3.) + rnd * 50. + wp.x * 1.3) * (.02 + .05 * g.wind.z) * sat(sr.x * 20.);
  wp += vec3f(w.x + fl * (rnd - .3), fl * .6, w.y + fl * (.7 - rnd)) * max(sr.x, .02) * vec3f(1., sat(sr.x * 30.), 1.);
  o.cp = g.vp * vec4f(wp, 1.); o.wp = wp; o.n = rotY(n, ib.x); o.uv = uv; o.k = vec4f(floor(sr.y) - lod * 10., rnd, ib.z, ib.y);
  return o;
}
fn leafRing(p: vec2f, a0: f32, N: f32, R: f32, rnd: f32) -> f32 {
  let r = length(p); let a = atan2(p.y, p.x) + a0;
  let k = 6.2832 / N; let s = floor(a / k + .5); let la = a - s * k;
  let L = R * (.7 + .3 * h11(s * 3.1 + rnd * 17. + N));
  let t = r * cos(la) / L;
  let hw = L * .62 * sqrt(sat(t)) * pow(sat(1. - t), .65);
  return hw - abs(r * sin(la));
}
// x > 0 inside the shape (in uv units); y is a free parameter for colouring; z is a coarse outline for the distance
fn shapeA(uv: vec2f, sh: i32, rnd: f32) -> vec3f {
  let p = uv - .5; let x = abs(p.x) * 2.; let y = uv.y; let r = length(p);
  if (sh == 0) { return vec3f(max(leafRing(p, rnd * 6.28, 7., .5, rnd), leafRing(p, rnd * 9.1 + .4, 5., .29, rnd + .3)), r * 2., .36 - r); }
  if (sh == 1) { // conifer bough: a solid tapered blade with a coarse toothed edge (no fine detail to shimmer)
    let env = pow(sat(sin(3.1416 * sat(y * .9 + .08))), .6) * .98;
    let e = (env * (.74 + .26 * abs(fract(y * 6. + rnd * 3.) * 2. - 1.)) - x) * .5;
    return vec3f(e, x, (env * .87 - x) * .5);
  }
  if (sh == 2) {
    let e = (pow(sat(sin(3.1416 * sat(y * .86 + .12))), .8) * (1. - y * .25) - x) * .5;
    let tw = abs(fract((y - x * .22) * 13.) - .5);
    return vec3f(min(e, max((.34 - tw) / 13., .03 - x * .5)), x, e - .08);
  }
  if (sh == 3) { let a = atan2(p.y, p.x); return vec3f(.47 * (.6 + .4 * abs(cos(a * 4.5 + rnd * 6.))) - r, r * 2., .42 - r); }
  if (sh == 6) {
    let e = (((1. - y) * .62 + .1) * ss(0., .1, y) - x) * .5;
    return vec3f(min(e, (.43 - length(fract(vec2f(x * 1.6 + floor(y * 10.) * .5, y * 10.)) - .5)) / 10.), y, e);
  }
  return vec3f(1., y, 1.);
}
fn cardAlpha(i: CO) -> vec2f {
  let sh = i32(i.k.x + .5);
  let s = shapeA(i.uv, sh, i.k.y);
  let a0 = sat(s.x / max(fwidth(s.x), 1e-5) + .5);
  // far away the fine pattern would shimmer, so it fades to the outline (sooner for the finely toothed shapes)
  let cov = 1.; var f0 = .1;
  if (sh == 2 || sh == 6) { f0 = .02; }
  let a1 = sat(s.z / max(fwidth(s.z), 1e-5) + .5) * cov;
  return vec2f(mix(a0, a1, ss(f0, f0 * 3., fwidth(i.uv.x) + fwidth(i.uv.y))), s.y);
}
@fragment fn fsC(i: CO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let a = cardAlpha(i);
  ${AA > 1 ? '' : 'if (a.x < .5) { discard; }'}
  let sh = i32(i.k.x + .5); let rnd = i.k.y;
  var n = normalize(i.n);
  var alb = vec3f(.1); var tr = .6;
  if (sh == 0) { alb = pal(i.k.z + (rnd - .5) * .16) * (.65 + .7 * rnd) * (1. - .25 * a.y); }
  else if (sh == 1) { alb = mix(vec3f(.012, .034, .019), vec3f(.034, .072, .028), rnd) * (.5 + .7 * a.y) * (.75 + .25 * i.uv.y); tr = .15; }
  else if (sh == 2) { alb = mix(vec3f(.05, .14, .025), vec3f(.11, .22, .04), rnd); }
  else if (sh == 3) {
    var fc = array<vec3f, 5>(vec3f(.82, .82, .76), vec3f(.85, .58, .04), vec3f(.75, .16, .38), vec3f(.30, .18, .70), vec3f(.80, .13, .03));
    alb = mix(vec3f(.75, .5, .03), fc[i32(i.k.z * 4.99)], ss(.22, .3, a.y)); tr = .3;
  } else if (sh == 6) {
    alb = mix(vec3f(.26, .12, .62), vec3f(.62, .2, .55), sat(i.k.z * 1.2 + (a.y - .5) * .5)) * (.6 + .6 * a.y); tr = .3;
  } else { alb = vec3f(.07, .16, .035); }
  let V = normalize(i.wp - g.cam.xyz); let back = sat(dot(V, g.sun.xyz));
  let shd = shadow4(i.wp, n, mix(farShade(i.wp.z), 1., ss(3., 9., i.wp.y - g.cam.y)));
  let wrap = sat((dot(n, g.sun.xyz) + .35) / 1.35);
  var c = alb * (g.sunC.rgb * wrap * shd + amb(n) * (.55 + .45 * sat(n.y + .5)) + lamp(i.wp, n, .75));
  c += alb * vec3f(1.5, 1.35, .35) * g.sunC.rgb * (tr * shd * (.12 + .75 * back * back));
  return vec4f(fog(c, i.wp), a.x);
}
@fragment fn fsCS(i: CO) { if (cardAlpha(i).x < .5) { discard; } }

// ---------------------------------------------------------------- grass blades (9-vertex strips built in the shader)
struct GO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) k: vec3f };
@vertex fn vsG(@builtin(vertex_index) vi: u32, @location(0) a: vec3f, @location(1) b: vec4f) -> GO {
  var o: GO;
  let lv = f32(min(vi >> 1u, 4u)) * .25; let sd = select(f32(vi & 1u) * 2. - 1., 0., vi == 8u);
  let dist = length(a - g.cam.xyz);
  let keep = 1. - ss(45., 80., dist + b.w * 22.);
  let h = (.05 + b.x * .95) * keep;
  let w = (.011 + .013 * b.w) * (1. + dist * .05) * (1. - lv * .88) * keep * clamp(h * 3.5, .45, 1.);
  let ya = b.y * 6.2832; let dr = vec2f(cos(ya), sin(ya));
  let fl = sin(g.cam.w * 2.6 + a.x * .9 + a.z * .7 + b.w * 6.) * .08;
  let bend = (vec2f(-dr.y, dr.x) * (.18 + b.w * .35) + windAt(a) * 1.1 + g.wind.xy * fl) * (lv * lv * h);
  let wp = a + vec3f(dr.x * sd * w + bend.x, lv * h * (1. - .25 * length(bend) / max(h, .01)), dr.y * sd * w + bend.y);
  o.cp = g.vp * vec4f(wp, 1.); o.wp = wp; o.n = normalize(vec3f(bend.x * 2.5, 1., bend.y * 2.5)); o.k = vec3f(b.z, b.w, lv);
  return o;
}
@fragment fn fsG(i: GO) -> @location(0) vec4f {
  let lv = i.k.z; let b = biome(i.wp.z);
  let tip = mix(vec3f(.13, .27, .04), vec3f(.40, .37, .11), i.k.x);
  let root = (vec3f(.055, .095, .022) * b.x + vec3f(.07, .14, .025) * b.y + vec3f(.08, .11, .04) * b.z) * .8;
  let alb = mix(root, tip, lv * lv * .8 + lv * .2) * (.75 + .5 * i.k.y);
  let n = normalize(i.n);
  let sh = shadow1(i.wp + g.sun.xyz * .3 + vec3f(0., .08, 0.), farShade(i.wp.z));
  let V = normalize(i.wp - g.cam.xyz); let back = sat(dot(V, g.sun.xyz));
  let c = alb * (g.sunC.rgb * sh * (sat(dot(n, g.sun.xyz)) * .75 + (.25 + .9 * back * back) * lv) + amb(n) * (.35 + .65 * lv) + lamp(i.wp, n, .7) * (.5 + .5 * lv));
  return vec4f(fog(c, i.wp), 1.);
}

// ---------------------------------------------------------------- birds, butterflies and falling leaves
struct KO { @builtin(position) cp: vec4f, @location(0) c: vec3f, @location(1) uv: vec2f, @location(2) wp: vec3f, @location(3) k: f32 };
@vertex fn vsK(@builtin(vertex_index) vi: u32, @location(0) s: vec4f) -> KO {
  var o: KO; let t = g.cam.w; let ty = i32(s.w + .5);
  let tri = vi / 3u; let k = vi % 3u;
  var p = g.cam.xyz - g.fwd.xyz * 10.; var c = vec3f(.02); var uv = vec2f(.5);
  let lightc = g.sunC.rgb * .45 + g.skyZ.rgb;
  if (ty == 0) {
    let dirs = select(-1., 1., s.z > .5);
    let ang = t * (.1 + s.y * .09) * dirs + s.x * 6.2832; let rad = 22. + s.y * 75.;
    let ctr = g.bird.xyz + vec3f(cos(ang) * rad, 26. + s.z * 34. + sin(t * .31 + s.x * 9.) * 5., sin(ang) * rad);
    let dv = vec3f(-sin(ang), 0., cos(ang)) * dirs; let sv = vec3f(dv.z, 0., -dv.x);
    let ph = t * (6.5 + s.y * 3.) + s.x * 20.;
    let flap = sin(ph) * (.35 + .65 * ss(-.2, .4, sin(ph * .13 + s.x * 5.)));
    var l = vec3f(0.);
    if (tri < 2u) { let sg = f32(tri) * 2. - 1.; if (k == 0u) { l = vec3f(.2, 0., 0.); } else if (k == 1u) { l = vec3f(-.14, 0., 0.); } else { l = vec3f(-.06, flap * .5, sg * .66); } }
    else if (tri == 2u) { if (k == 0u) { l = vec3f(.4, 0., 0.); } else if (k == 1u) { l = vec3f(-.34, .02, .07); } else { l = vec3f(-.34, .02, -.07); } }
    p = ctr + (dv * l.x + vec3f(0., l.y, 0.) + sv * l.z) * 1.4;
    c = vec3f(.025, .025, .03) * lightc;
  } else if (ty == 1) {
    let V = vec3f(26., 2.4, 26.);
    let q = s.xyz * V + vec3f(sin(t * .23 + s.x * 40.) * 3., sin(t * 1.9 + s.y * 30.) * .3, cos(t * .19 + s.z * 40.) * 3.);
    let rel = (fract((q - g.cam.xyz) / V + .5) - .5) * V;
    let ctr = g.cam.xyz + vec3f(rel.x, rel.y - .55, rel.z);
    let ya = s.x * 30. + sin(t * .4 + s.z * 20.) * 2.; let dv = vec3f(cos(ya), 0., sin(ya)); let sv = vec3f(-dv.z, 0., dv.x);
    let fa = abs(sin(t * (11. + s.y * 5.) + s.x * 9.)) * 1.25;
    var l = vec3f(0.);
    if (tri < 2u) { let sg = f32(tri) * 2. - 1.; if (k == 0u) { l = vec3f(.035, 0., 0.); } else if (k == 1u) { l = vec3f(-.035, 0., 0.); } else { l = vec3f(-.01, sin(fa), sg * cos(fa)) * vec3f(1., .05, .05); } }
    let sc = ss(.08, .35, g.bio.y) * step(s.y, .2 + g.bio.y);
    p = ctr + (dv * l.x + vec3f(0., l.y, 0.) + sv * l.z) * sc;
    var bc = array<vec3f, 4>(vec3f(.85, .35, .04), vec3f(.85, .85, .8), vec3f(.2, .38, .85), vec3f(.9, .75, .1));
    c = bc[i32(s.z * 3.99)] * lightc * .35;
  } else {
    let V = vec3f(26., 13., 26.);
    let q = s.xyz * V + vec3f(sin(t * .5 + s.x * 30.) * 1.4 + g.wind.x * t * .5, -t * (.55 + s.y * .5), cos(t * .4 + s.z * 30.) * 1.4 + g.wind.y * t * .5);
    let rel = (fract((q - g.cam.xyz) / V + .5) - .5) * V;
    let ctr = g.cam.xyz + vec3f(rel.x, rel.y + 3.5, rel.z);
    let a1 = t * (1.5 + s.x * 2.) + s.x * 50.;
    let u = normalize(vec3f(cos(a1), .5 * sin(a1 * 1.3), sin(a1)));
    let w = normalize(cross(u, vec3f(sin(a1 * .7), 1., cos(a1 * .7))));
    let sc = .055 * ss(.15, .5, g.bio.x) * step(fract(s.y * 7.3), .12 + .88 * g.bio.w);
    if (tri < 2u) {
      var cr = vec2f(-1., -1.);
      if (vi == 1u) { cr = vec2f(1., -1.); } else if (vi == 2u || vi == 3u) { cr = vec2f(1., 1.); } else if (vi == 4u) { cr = vec2f(-1., 1.); }
      p = ctr + (u * cr.x + w * cr.y) * sc; uv = cr * .5 + .5;
    }
    c = pal(mix(.12, .35 + .6 * s.z, g.bio.w)) * lightc * .5;
  }
  o.cp = g.vp * vec4f(p, 1.); o.c = c; o.uv = uv; o.wp = p; o.k = s.w;
  return o;
}
@fragment fn fsK(i: KO) -> @location(0) vec4f {
  if (i.k > 1.5) { let p = i.uv - .5; let t = p.y + .5; if (.3 * sqrt(sat(t)) * pow(sat(1. - t), .6) * 1.6 - abs(p.x) < 0.) { discard; } }
  return vec4f(fog(i.c, i.wp), 1.);
}

// ---------------------------------------------------------------- pollen and dust motes that light up in the sun
struct MO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) c: vec3f };
@vertex fn vsM(@builtin(vertex_index) vi: u32, @location(0) s: vec4f) -> MO {
  var o: MO; let t = g.cam.w; let V = vec3f(34., 13., 34.);
  let q = s.xyz * V + vec3f(sin(t * .11 + s.w * 40.), sin(t * .07 + s.w * 70.) * .6, cos(t * .09 + s.w * 50.)) * 1.3 + vec3f(g.wind.x, -.03, g.wind.y) * (t * .3);
  let rel = (fract((q - g.cam.xyz) / V + .5) - .5) * V;
  let wp = g.cam.xyz + rel + vec3f(0., 2.5, 0.); let dist = length(wp - g.cam.xyz);
  let lit = shadow1(wp, farShade(wp.z) * .6);
  let px = dist * 2. * g.res.w * g.up.w;
  let r0 = .004 + .007 * s.w; let sz = max(r0, px * .9);
  let cr = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2. - 1.;
  o.cp = g.vp * vec4f(wp + (g.right.xyz * cr.x + g.up.xyz * cr.y) * sz, 1.);
  let mu = sat(dot(normalize(wp - g.cam.xyz), g.sun.xyz));
  let fade = (1. - ss(11., 16., dist)) * ss(.25, 1., dist) * (.55 + .45 * sin(t * 2.7 + s.w * 90.));
  let br = lit * (.08 + 1.6 * pow(mu, 5.)) * fade;
  o.c = (g.sunC.rgb * br + lamp(wp, g.fwd.xyz, 1.) * (fade * .5)) * (1. * .11 * (r0 * r0) / (sz * sz) * 3.); o.uv = cr;
  return o;
}
@fragment fn fsM(i: MO) -> @location(0) vec4f { return vec4f(i.c * sat(1. - dot(i.uv, i.uv)), 0.); }

// ---------------------------------------------------------------- sky: gradient, sun and drifting clouds
@fragment fn fsSky(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let nd = vec2f(fc.x * g.res.z * 2. - 1., 1. - fc.y * g.res.w * 2.);
  let rd = normalize(g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w));
  var c = sky(rd);
  let mu = dot(rd, g.sun.xyz);
  let stars = max(g.misc.w, g.sun.w);
  if (stars > .01 && rd.y > .02) { // a few first stars at dusk; at night two layers of them and a faint band of the galaxy
    let up = ss(.02, mix(.55, .2, g.sun.w), rd.y);
    let sp = rd.xz / (rd.y + .35) * 46.; let ci = floor(sp); let hs = h21(ci);
    let dd = length(fract(sp) - .15 - .7 * vec2f(h21(ci + 7.), h21(ci + 13.)));
    let thr = mix(.95, .9, g.sun.w);
    var st = ss(.13, 0., dd) * step(thr, hs) * (hs - thr + .02) * mix(34., 20., g.sun.w) * (.65 + .35 * sin(g.cam.w * 2.5 + hs * 90.));
    if (g.sun.w > .01) {
      let sp2 = rd.xz / (rd.y + .35) * 110. + 31.; let c2 = floor(sp2); let h2 = h21(c2);
      let d2 = length(fract(sp2) - .2 - .6 * vec2f(h21(c2 + 5.), h21(c2 + 11.)));
      st += g.sun.w * ss(.2, 0., d2) * step(.86, h2) * (h2 - .8) * 3.;
      let band = rd.x * .55 + rd.z * .3 - rd.y * .45;
      c += vec3f(.5, .56, .75) * (g.sun.w * .012 * exp(-band * band * 14.) * (.4 + fbm(rd.xz * 5. + rd.y * 3., 4)) * up);
    }
    c += mix(vec3f(.9, .95, 1.), vec3f(1., .92, .8), h21(ci + 3.)) * (st * stars * up);
  }
  c += g.sunC.rgb * (ss(.99982, .99994, mu) * 25. + pow(max(mu, 0.), 900.) * 1.5);
  if (rd.y > .005) {
    let uv = rd.xz / (rd.y + .1) * .55 + g.cam.w * vec2f(.004, .0022) + g.cam.xz * .00012;
    let n1 = fbm(uv * 1.4, 5);
    let cov = ss(.56, .8, n1 + .1 * fbm(uv * 6., 3));
    let n2 = fbm(uv * 1.4 + g.sun.xz * .11, 3);
    let lit = sat(.55 + (n1 - n2) * 5.);
    let cc = mix(g.skyH.rgb * .6 + g.skyZ.rgb * .2, g.sunC.rgb * .15 + g.skyH.rgb * .35, lit) * (1. + pow(max(mu, 0.), 12.) * .8);
    c = mix(c, cc, cov * ss(.0, .16, rd.y) * .9);
  }
  return vec4f(c, 1.);
}
`;

// ---------------------------------------------------------------- volumetric light shafts (half resolution)
const W_RAYS = (AA, RAYN) => S_G + /*wgsl*/`
@group(0) @binding(1) var tSh: texture_depth_2d;
@group(0) @binding(2) var sSh: sampler_comparison;
@group(0) @binding(3) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dp = textureLoad(tDp, vec2i(fc.xy) * 2, 0);
  let uv = fc.xy * 2. * g.res.zw;
  let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
  let rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  let rl = length(rv); let rd = rv / rl;
  let zl = min(g.fwd.w / max(dp, 1e-6), 2e4); // capped: the sky must stay finite in a 16-bit float
  let tm = min(zl * rl, 120.);
  let dt = tm / ${RAYN}.; let j = ign(fc.xy);
  let farV = 1. - .7 * g.bio.x;
  var acc = 0.;
  for (var n = 0; n < ${RAYN}; n++) {
    let t = (f32(n) + j) * dt; let p = g.cam.xyz + rd * t;
    let s = g.sm * vec4f(p, 1.);
    let v = textureSampleCompareLevel(tSh, sSh, vec2f(s.x * .5 + .5, .5 - s.y * .5), s.z - .0008);
    acc += mix(v, farV, ss(g.shc.w * .78, g.shc.w * .97, length(p.xz - g.shc.xz))) * exp(-t * .014);
  }
  let mu = dot(rd, g.sun.xyz);
  let ph = .1 + .032 * .4816 / pow(1.5184 - 1.44 * mu, 1.5);
  return vec4f(g.sunC.rgb * (acc * dt * g.misc.y * ph), zl);
}
`;
// depth-aware 3x3 blur of the half-res shafts (hides the sampling dither)
const W_RBLUR = /*wgsl*/`
@group(0) @binding(0) var tR: texture_2d<f32>;
@vertex fn vsF(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy); let mx = vec2i(textureDimensions(tR)) - 1;
  let c = textureLoad(tR, p, 0);
  var acc = vec3f(0.); var ws = 0.;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let r = textureLoad(tR, clamp(p + vec2i(x, y), vec2i(0), mx), 0);
    let w = 1. / (.03 + abs(r.a - c.a) / c.a);
    acc += r.rgb * w; ws += w;
  } }
  return vec4f(acc / ws, c.a);
}
`;
// bloom chain
const W_BLIT = /*wgsl*/`
@group(0) @binding(0) var sL: sampler;
@group(0) @binding(1) var tI: texture_2d<f32>;
@vertex fn vsF(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(tI, sL, uv, 0.).rgb; }
@fragment fn fsD0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let tx = 1. / vec2f(textureDimensions(tI)); let uv = fc.xy * 2. * tx;
  var acc = vec3f(0.); var ws = 0.;
  for (var k = 0; k < 4; k++) {
    let c = min(tap(uv + (vec2f(f32(k & 1), f32(k >> 1)) * 2. - 1.) * tx), vec3f(60.));
    let w = 1. / (1. + max(c.r, max(c.g, c.b))); acc += c * w; ws += w;
  }
  return vec4f(acc / ws, 1.);
}
@fragment fn fsD(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let tx = 1. / vec2f(textureDimensions(tI)); let uv = fc.xy * 2. * tx;
  return vec4f((tap(uv + vec2f(-1., -1.) * tx) + tap(uv + vec2f(1., -1.) * tx) + tap(uv + vec2f(-1., 1.) * tx) + tap(uv + vec2f(1., 1.) * tx)) * .25, 1.);
}
@fragment fn fsU(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let tx = 1. / vec2f(textureDimensions(tI)); let uv = fc.xy * .5 * tx;
  return vec4f((tap(uv + vec2f(-.5, -.5) * tx) + tap(uv + vec2f(.5, -.5) * tx) + tap(uv + vec2f(-.5, .5) * tx) + tap(uv + vec2f(.5, .5) * tx)) * .25, 1.);
}
`;
// final composite: shafts, bloom, exposure, tone curve, grade
const W_POST = (AA) => S_G + /*wgsl*/`
@group(0) @binding(1) var sL: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tR: texture_2d<f32>;
@group(0) @binding(4) var tB: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
fn tmap(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), vec3f(0.), vec3f(1.)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy); let uv = fc.xy * g.res.zw;
  let zf = min(g.fwd.w / max(textureLoad(tDp, px, 0), 1e-6), 2e4);
  let h = fc.xy * .5 - .5; let b = floor(h); let f = h - b; let bi = vec2i(b);
  let mx = vec2i(textureDimensions(tR)) - 1;
  var acc = vec3f(0.); var ws = 0.;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let r = textureLoad(tR, clamp(bi + o, vec2i(0), mx), 0);
    let bw = mix(1. - f.x, f.x, f32(o.x)) * mix(1. - f.y, f.y, f32(o.y));
    let w = (bw + .02) / (.02 + abs(r.a - zf) / zf);
    acc += r.rgb * w; ws += w;
  }
  var c = textureLoad(tS, px, 0).rgb + acc / ws;
  let bl = textureSampleLevel(tB, sL, uv, 0.).rgb;
  c = mix(c, bl, .07) + bl * .035;
  c *= g.misc.x;
  let q = uv - .5;
  c *= 1. - dot(q, q) * .45;
  c = tmap(c);
  let l0 = dot(c, vec3f(.2126, .7152, .0722));
  c = mix(vec3f(l0), c, 1.12);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  return vec4f(c + (ign(fc.xy) - .5) / 255., 1.);
}
`;
