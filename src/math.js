// ============================================================================
// math, noise and procedural mesh builders (everything in the world is made here, no asset files)
// ============================================================================
const { sin, cos, abs, min, max, floor, sqrt, PI, pow, exp, hypot, atan2, round } = Math;
const TAU = PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sst = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// seeded random numbers (mulberry32)
function RNG(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// integer lattice hash -> [0, 1)
function h2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// 2D value noise and fractal sums
function vn(x, y) {
  const xi = floor(x), yi = floor(y); let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, n) {
  let a = 0.5, s = 0;
  for (let i = 0; i < n; i++) { s += a * vn(x, y); const t = x * 1.6 + y * 1.2 + 11.3; y = y * 1.6 - x * 1.2 + 11.3; x = t; a *= 0.5; }
  return s;
}
// ridged noise for mountain crests
function ridge(x, y) {
  let a = 0.5, s = 0, w = 1;
  for (let i = 0; i < 5; i++) {
    let n = 1 - abs(2 * vn(x, y) - 1); n *= n; s += n * a * w; w = clamp(n * 1.6, 0, 1);
    const t = x * 1.6 + y * 1.2 + 5.7; y = y * 1.6 - x * 1.2 + 3.1; x = t; a *= 0.5;
  }
  return s;
}

// tiny vector helpers (used only while building meshes)
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vmul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vcrs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vnrm = (a) => { const l = hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const perp = (d) => vnrm(vcrs(d, abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));

// Solid vertex: pos3 normal3 sway kind (8 floats). kind's fraction is the radius of a twig that melts away with distance.
// Card vertex: pos3 normal3 uv2 sway shape+rand centre3 morph (14 floats). morph says how the card resizes about its
// centre as the tree recedes: 0 never, 1 grows 40% and 2 shrinks away over 70-95 m, 3 shrinks away over 225-250 m.
const CS = 14;
const newMesh = () => ({ v: [], i: [] });

// a tapered tube through pts [x, y, z, radius, sway]
function limb(M, pts, sides, kind, melt = false) {
  const b = M.v.length / 8, n = pts.length;
  for (let k = 0; k < n; k++) {
    const p = pts[k], d = vnrm(vsub(pts[min(k + 1, n - 1)], pts[max(k - 1, 0)])), u = perp(d), w = vcrs(d, u);
    for (let s = 0; s < sides; s++) {
      const t = (s / sides) * TAU, cs = cos(t), sn = sin(t);
      const nx = u[0] * cs + w[0] * sn, ny = u[1] * cs + w[1] * sn, nz = u[2] * cs + w[2] * sn;
      M.v.push(p[0] + nx * p[3], p[1] + ny * p[3], p[2] + nz * p[3], nx, ny, nz, p[4], kind + (melt ? min(p[3], 0.9) : 0));
    }
  }
  for (let k = 0; k < n - 1; k++) for (let s = 0; s < sides; s++) {
    const a = b + k * sides + s, c = b + k * sides + ((s + 1) % sides);
    M.i.push(a, c, a + sides, c, c + sides, a + sides);
  }
}
// a flat card (quad) centred at p, facing n, shaded with normal sn
function card(C, p, n, sn, size, shape, rnd, sw, morph = 0) {
  const u = perp(n), w = vcrs(n, u), h = size / 2, b = C.v.length / CS, sr = shape + min(rnd, 0.99) * 0.99;
  const P = (a, c, uu, vv) => C.v.push(p[0] + u[0] * a + w[0] * c, p[1] + u[1] * a + w[1] * c, p[2] + u[2] * a + w[2] * c, sn[0], sn[1], sn[2], uu, vv, sw, sr, p[0], p[1], p[2], morph);
  P(-h, -h, 0, 0); P(h, -h, 1, 0); P(h, h, 1, 1); P(-h, h, 0, 1);
  C.i.push(b, b + 1, b + 2, b, b + 2, b + 3);
}
// a ribbon of quads along pts [x,y,z], half width hw(t), side axis ax; uv.y runs along it
function strip(C, pts, ax, hw, sn, shape, rnd, sw0, sw1, morph = 0, ctr = [0, 0, 0]) {
  const b = C.v.length / CS, n = pts.length, sr = shape + min(rnd, 0.99) * 0.99;
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1), p = pts[k], w = hw(t), sw = mix(sw0, sw1, t);
    C.v.push(p[0] - ax[0] * w, p[1] - ax[1] * w, p[2] - ax[2] * w, sn[0], sn[1], sn[2], 0, t, sw, sr, ctr[0], ctr[1], ctr[2], morph);
    C.v.push(p[0] + ax[0] * w, p[1] + ax[1] * w, p[2] + ax[2] * w, sn[0], sn[1], sn[2], 1, t, sw, sr, ctr[0], ctr[1], ctr[2], morph);
  }
  for (let k = 0; k < n - 1; k++) { const a = b + k * 2; C.i.push(a, a + 1, a + 3, a, a + 3, a + 2); }
}

// unit icosphere: { p: [[x,y,z]...], f: [[a,b,c]...] }
function icosphere(sub) {
  const t = (1 + sqrt(5)) / 2;
  let p = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(vnrm);
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const cache = new Map(), nf = [];
    const mid = (a, b) => { const k = a < b ? a * 65536 + b : b * 65536 + a; let m = cache.get(k); if (m === undefined) { m = p.length; p.push(vnrm(vadd(p[a], p[b]))); cache.set(k, m); } return m; };
    for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  return { p, f };
}
// push a deformed icosphere with smooth normals; fn maps a unit direction to [pos, sway]
function blob(M, sub, kind, fn) {
  const { p, f } = icosphere(sub), b = M.v.length / 8, q = p.map(fn), nr = p.map(() => [0, 0, 0]);
  for (const [a, c, d] of f) { const n = vcrs(vsub(q[c][0], q[a][0]), vsub(q[d][0], q[a][0])); for (const k of [a, c, d]) { nr[k][0] += n[0]; nr[k][1] += n[1]; nr[k][2] += n[2]; } }
  q.forEach((v, k) => { let n = vnrm(nr[k]); if (n[0] * p[k][0] + n[1] * p[k][1] + n[2] * p[k][2] < 0) n = vmul(n, -1); M.v.push(v[0][0], v[0][1], v[0][2], n[0], n[1], n[2], v[1], kind); });
  for (const [a, c, d] of f) M.i.push(b + a, b + c, b + d);
}

// ---------------------------------------------------------------- trees
// A broadleaf tree grown by recursive branching. lod 0: full; lod 1: main limbs and half of the (larger) leaf
// cards; lod 2: a lumpy crown for the distance. All three come from the same random sequence, so they line up.
function buildTree(seed, P, lod) {
  const S = newMesh(), C = newMesh(), rng = RNG(seed), H = P.h, crown = [0, H * P.cc, 0];
  let nc = 0, sr = 0, sy = 0, sy2 = 0;
  const sway = (q, depth) => pow(max(q[1], 0) / H, 1.5) * 0.55 + (hypot(q[0], q[2]) / H) * 0.5 + depth * 0.02;
  const leaves = (pts, n) => {
    for (let k = 0; k < n; k++) {
      const t = 0.15 + 0.85 * rng(), fi = t * (pts.length - 1), k0 = min(floor(fi), pts.length - 2), u = fi - k0;
      const a = pts[k0], b = pts[k0 + 1], sp = P.ls * 0.7;
      const p = [mix(a[0], b[0], u) + (rng() - 0.5) * sp, mix(a[1], b[1], u) + (rng() - 0.5) * sp, mix(a[2], b[2], u) + (rng() - 0.5) * sp];
      const out = vnrm(vsub(p, crown)), n1 = vnrm([out[0] * 0.5 + rng() - 0.5, out[1] * 0.5 + 0.55 + (rng() - 0.5) * 0.6, out[2] * 0.5 + rng() - 0.5]);
      const size = P.ls * (0.75 + 0.6 * rng()), rnd = rng();
      sr += hypot(p[0], p[2]); sy += p[1]; sy2 += p[1] * p[1];
      nc++;
      if (lod === 2 || (lod === 1 && nc % 2)) continue;
      card(C, p, n1, vnrm([out[0] * 0.8 + n1[0] * 0.35, out[1] * 0.8 + n1[1] * 0.35 + 0.15, out[2] * 0.8 + n1[2] * 0.35]), lod ? size * 1.4 : size, 0, rnd, sway(p, 3) + 0.03, lod ? 3 : nc % 2 ? 2 : 1);
    }
  };
  const grow = (p, dir, len, rad, depth) => {
    const ns = depth === 0 ? 6 : depth < 3 ? 3 : 2, pts = [], last = depth >= P.depth;
    let q = p.slice(), d = dir.slice();
    for (let k = 0; k <= ns; k++) {
      const t = k / ns;
      pts.push([q[0], q[1], q[2], rad * (1 - t * (depth ? 0.5 : 0.45)), sway(q, depth)]);
      const bd = depth ? P.bend : P.bend * 0.35;
      d = vnrm([d[0] + (rng() - 0.5) * bd, d[1] + (rng() - 0.5) * bd * 0.5 + (depth ? (last ? P.droop : P.lift) : 0), d[2] + (rng() - 0.5) * bd]);
      q = vadd(q, vmul(d, len / ns));
    }
    if (lod === 0 || (lod === 1 && depth < 2) || (lod === 2 && depth === 0)) limb(S, pts, depth === 0 ? (lod ? 5 : 8) : depth === 1 ? (lod ? 3 : 5) : 3, P.kind, depth >= 2);
    if (last) { leaves(pts, P.lv); return; }
    const nch = depth === 0 ? P.f0 : 2 + (rng() < P.f3 ? 1 : 0), az0 = rng() * TAU;
    for (let c = 0; c < nch; c++) {
      const t = depth === 0 ? P.t0 + (1 - P.t0) * ((c + rng() * 0.7) / nch) : 0.4 + 0.6 * ((c + 1) / nch);
      const fi = min(t, 1) * ns, k0 = min(floor(fi), ns - 1), u = fi - k0, a = pts[k0], b = pts[k0 + 1];
      const pos = [mix(a[0], b[0], u), mix(a[1], b[1], u), mix(a[2], b[2], u)], r = mix(a[3], b[3], u);
      const d0 = vnrm(vsub(b, a)), u1 = perp(d0), w1 = vcrs(d0, u1);
      const az = az0 + c * 2.4 + rng() * 0.8, top = depth === 0 && c === nch - 1;
      const ang = P.ang * (0.7 + 0.6 * rng()) * (top ? 0.3 : 1), sa = sin(ang), ca = cos(ang);
      const cd = vnrm([d0[0] * ca + (u1[0] * cos(az) + w1[0] * sin(az)) * sa, d0[1] * ca + (u1[1] * cos(az) + w1[1] * sin(az)) * sa, d0[2] * ca + (u1[2] * cos(az) + w1[2] * sin(az)) * sa]);
      const cl = depth === 0 ? H * P.l1 * (0.75 + 0.5 * rng()) * (1 - (t - P.t0) * 0.35) : len * P.lr * (0.8 + 0.4 * rng());
      grow(pos, cd, cl, depth === 0 ? rad * 0.5 * (1.1 - t * 0.5) : r * 0.68, depth + 1);
    }
    if (depth === P.depth - 1) leaves(pts, P.lv >> 1);
  };
  grow([0, -0.4, 0], [0, 1, 0], H * P.trunk, P.r, 0);
  if (lod === 2) {
    const cy = sy / nc, rr = (sr / nc) * 1.25, ry = max(sqrt(max(sy2 / nc - cy * cy, 0.1)) * 2.1, rr * 0.8), r2 = RNG(seed + 5);
    const ph = [r2() * 6, r2() * 6, r2() * 6];
    blob(S, 1, 3, (d) => {
      const k = 1 + 0.2 * sin(d[0] * 3.1 + ph[0]) * sin(d[2] * 3.3 + ph[1]) + 0.14 * sin(d[1] * 4.3 + ph[2]);
      const y = cy + d[1] * ry * k;
      return [[d[0] * rr * k, y, d[2] * rr * k], pow(max(y, 0) / H, 1.5) * 0.55];
    });
  }
  return { S, C };
}
// a spruce / fir: straight trunk and whorls of drooping needle boughs (cards)
function buildConifer(seed, P, lod) {
  const S = newMesh(), C = newMesh(), rng = RNG(seed), H = P.h;
  const sw = (y) => pow(y / H, 1.6) * 0.5;
  if (lod === 2) {
    limb(S, [[0, -0.4, 0, P.r, 0], [0, H * 0.16, 0, P.r * 0.8, 0]], 4, 0);
    const pts = []; for (let k = 0; k <= 5; k++) { const t = k / 5, y = H * (0.13 + 0.87 * t); pts.push([0, y, 0, P.R * (1 - t) * (1 - 0.25 * t) + 0.08, sw(y)]); }
    limb(S, pts, 7, 4);
    return { S, C };
  }
  const tp = []; for (let k = 0; k <= 5; k++) { const t = k / 5; tp.push([0, -0.4 + (H + 0.4) * t, 0, P.r * (1 - t * 0.93), sw(H * t)]); }
  limb(S, tp, lod ? 4 : 7, 0);
  // a dark inner cone so the sky never shows through the middle of the tree
  const core = []; for (let k = 0; k <= 4; k++) { const t = k / 4, y = H * (0.16 + 0.8 * t); core.push([0, y, 0, P.R * 0.36 * (1 - t) + 0.05, sw(y)]); }
  limb(S, core, 6, 4);
  // boughs: one simple drooping blade each, identical at lod 0 and 1 so the tree never changes shape up close
  const nw = P.nw; let rot = 0;
  for (let w = 0; w < nw; w++) {
    const t = w / (nw - 1), y = H * (0.14 + 0.84 * t), R = P.R * pow(1 - t, 0.85) * (0.85 + 0.3 * rng()) + 0.25, nb = max(4, round(P.nb * (1 - t * 0.45)));
    rot += 1.1 + rng();
    for (let b = 0; b < nb; b++) {
      const az = rot + (b / nb) * TAU + (rng() - 0.5) * 0.5, dx = cos(az), dz = sin(az), dr = P.droop * (0.7 + 0.6 * rng()) * (1.3 - t), rnd = rng(), rise = 0.1 * rng();
      const pts = [];
      for (let k = 0; k <= 3; k++) { const f = 0.03 + 0.97 * (k / 3); pts.push([dx * R * f, y + R * (rise * f - dr * 0.55 * pow(f, 1.7)), dz * R * f]); }
      strip(C, pts, [-dz, 0, dx], () => R * 0.4, vnrm([dx * 0.6, 0.75, dz * 0.6]), 1, rnd, sw(y) + 0.02, sw(y) + R * 0.02, lod ? 3 : 0, [0, y, 0]);
    }
  }
  return { S, C };
}
// rocks: an icosphere dented by noise and cut by a few random planes
function buildRock(seed) {
  const S = newMesh(), rng = RNG(seed), cuts = [];
  for (let k = 0; k < 5; k++) cuts.push([vnrm([rng() - 0.5, rng() - 0.3, rng() - 0.5]), 0.62 + 0.3 * rng()]);
  const o = rng() * 50;
  blob(S, 2, 2, (d) => {
    let r = 1 + 0.5 * (fbm(d[0] * 1.6 + d[2] * 0.7 + o, d[1] * 1.6 - d[2] * 0.9 + o, 3) - 0.5);
    let p = vmul(d, r);
    for (const [n, c] of cuts) { const e = p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - c; if (e > 0) p = vsub(p, vmul(n, e)); }
    return [[p[0], p[1] * 0.72, p[2]], 0];
  });
  return { S };
}
// ---------------------------------------------------------------- undergrowth (all cards)
function buildFern(seed) {
  const C = newMesh(), rng = RNG(seed), n = 9;
  for (let k = 0; k < n; k++) {
    const az = (k / n) * TAU + rng() * 0.5, dx = cos(az), dz = sin(az), L = 0.55 + 0.4 * rng(), up = 0.5 + 0.4 * rng(), pts = [];
    for (let j = 0; j <= 3; j++) { const t = j / 3; pts.push([dx * L * t, up * L * (t * 1.5 - t * t * 1.25) + 0.02, dz * L * t]); }
    strip(C, pts, [-dz, 0, dx], () => L * 0.2, vnrm([dx * 0.4, 1, dz * 0.4]), 2, rng(), 0, 0.05);
  }
  return { C };
}
function buildBush(seed) {
  const C = newMesh(), rng = RNG(seed);
  for (let k = 0; k < 44; k++) {
    const d = vnrm([rng() - 0.5, rng() * 0.9 + 0.05, rng() - 0.5]), r = 0.2 + 0.4 * rng(), p = [d[0] * r, d[1] * r * 0.85 + 0.1, d[2] * r];
    card(C, p, vnrm([d[0] + rng() - 0.5, d[1] + 0.4, d[2] + rng() - 0.5]), vnrm([d[0], d[1] + 0.4, d[2]]), 0.2 + 0.12 * rng(), 0, rng() * 0.5, 0.03);
  }
  return { C };
}
// a small clump of flowers: thin crossed stems and either flat heads (daisy-like) or upright spikes (lupine-like)
function buildFlowers(seed, spike) {
  const C = newMesh(), rng = RNG(seed), n = spike ? 3 : 5;
  for (let k = 0; k < n; k++) {
    const x = (rng() - 0.5) * 0.3, z = (rng() - 0.5) * 0.3, h = spike ? 0.3 + 0.2 * rng() : 0.22 + 0.3 * rng(), lx = (rng() - 0.5) * 0.12, lz = (rng() - 0.5) * 0.12, rnd = rng();
    const pts = [[x, 0, z], [x + lx, h, z + lz]];
    strip(C, pts, [0.007, 0, 0], (t) => 1, [0, 1, 0], 4, rnd, 0, 0.04);
    strip(C, pts, [0, 0, 0.007], (t) => 1, [0, 1, 0], 4, rnd, 0, 0.04);
    if (spike) {
      const top = [[x + lx, h * 0.8, z + lz], [x + lx * 1.4, h + 0.3 + 0.12 * rng(), z + lz * 1.4]];
      strip(C, top, [0.05, 0, 0], () => 1, [0, 1, 0], 6, rnd, 0.04, 0.07);
      strip(C, top, [0, 0, 0.05], () => 1, [0, 1, 0], 6, rnd, 0.04, 0.07);
    } else {
      const n1 = vnrm([lx * 3 + (rng() - 0.5) * 0.5, 1, lz * 3 + (rng() - 0.5) * 0.5]);
      card(C, [x + lx, h + 0.005, z + lz], n1, [0, 1, 0], 0.11 + 0.06 * rng(), 3, rnd, 0.045);
    }
  }
  return { C };
}
