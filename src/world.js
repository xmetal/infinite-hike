// ============================================================================
// the world: an endless trail, the land around it, and what grows there
// ============================================================================
// The trail runs roughly along +z forever. Everything is a pure function of position, so walking back shows the
// same places again. The land is stored in chunks of CL metres of trail; a ring of NCH chunks follows the hiker.
const CL = 40, NCH = 56, HALF = NCH / 2, ROWS = 20, RS = CL / ROWS, COLS = 129, CH = 64;
// distance of each terrain column from the trail: 0.6 m apart at the path, ~50 m apart at the far ridges (1.1 km)
const DCOL = new Float32Array(COLS);
for (let i = 0; i < COLS; i++) { const u = i - CH; DCOL[i] = u * 0.6 + 0.0042 * u * u * u; }

// Where the trail is (x) at distance z, and its slope dx/dz. Two long swings set the general wander; two short
// ones add S-bends, and `twist` fades those in and out so some stretches run nearly straight and others wind.
// The waves never line up the same way twice, so no stretch repeats. (mirrored in WGSL: trailX())
const twist = (z) => { const s = 0.5 + 0.5 * sin(z * 0.0019 + 0.7); return 0.25 + 0.75 * s * s; };
const trailX = (z) => 38 * sin(z * 0.0061 + 0.5) + 17 * sin(z * 0.0173 + 2.1) + twist(z) * (11 * sin(z * 0.043 + 4.0) + 5 * sin(z * 0.083 + 1.3));
const trailDX = (z) => trailX(z + 0.5) - trailX(z - 0.5);
// biome weights at z: o = [forest, meadow, alpine, autumn]. One cycle is ~1.4 km. (mirrored in WGSL: biome())
const bphase = (z) => z * 0.0045 + 0.5 * sin(z * 0.0013);
function biome(z, o) {
  const th = bphase(z);
  const f = sst(0.2, 0.75, cos(th)), m = sst(0.2, 0.75, cos(th - 2.0944)), a = sst(0.2, 0.75, cos(th - 4.1888)), s = 1 / (f + m + a);
  o[0] = f * s; o[1] = m * s; o[2] = a * s; o[3] = sst(0.3, 0.7, 0.5 + 0.5 * sin(z * 0.0011 + 4.0));
}
// height of the trail at z: rolling, and climbing into the alpine stretches
const elev = (z) => 10 * sin(z * 0.0031 + 1) + 6 * sin(z * 0.0079 + 2.2) + 2.2 * sin(z * 0.019) + 30 * sst(-0.3, 1, cos(bphase(z) - 4.1888));
const elevD = (z) => (elev(z + 0.5) - elev(z - 0.5));

// height of the land d metres to the side of the trail, for the row set by rowSet(z)
// RC: the land is laid out in strips along z, so where the trail runs at an angle, sideways distances are scaled
// by RC to keep the path the same width
let RX = 0, RE = 0, RZ = 0, RC = 1; const RB = new Float64Array(4);
function rowSet(z) { RZ = z; RX = trailX(z); RE = elev(z); RC = 1 / hypot(1, trailDX(z)); biome(z, RB); }
function hgt(d) {
  const a = abs(d), fl = sst(1.3, 7, a * RC);
  if (fl <= 0) return RE;
  const x = RX + d, z = RZ;
  let h = RE + (fbm(x * 0.022, z * 0.022, 4) - 0.5) * (5 + 9 * min(a / 80, 1)) * fl;
  h += (fbm(x * 0.11, z * 0.11, 3) - 0.5) * 1.1 * fl * (0.4 + RB[2] * 1.3);
  h += clamp(d, -250, 250) * 0.06 * sin(z * 0.0021 + 1.3) * fl;
  const mw = sst(50, 650, a);
  if (mw > 0) h += mw * (ridge(x * 0.0016 + 3.1, z * 0.0016 + 1.7) * (70 * RB[0] + 45 * RB[1] + 520 * RB[2]) + RB[2] * 60 * mw);
  return h;
}

// ---------------------------------------------------------------- chunk generation
// scratch: heights of the chunk being generated (one border row on each side), trail x and height per row
const HG = new Float32Array((ROWS + 3) * COLS), RXR = new Float64Array(ROWS + 3), RER = new Float64Array(ROWS + 3);
const TVB = new Float32Array((ROWS + 1) * COLS * 8);
const NTREE = 512, NROCK = 160, NUG = 4096, NGRASS = 40000;
const TREEV = 5, UGV = 4, ROCKV = 3; // tree kinds (0-2 broadleaf, 3-4 conifer), undergrowth kinds, rock shapes
const ITB = new Float32Array(NTREE * 8), ISC = new Float32Array(NUG * 8), IKEY = new Uint8Array(NUG), IOUT = new Float32Array(NUG * 8);
const GBUF = new ArrayBuffer(NGRASS * 16), GF = new Float32Array(GBUF), G8 = new Uint8Array(GBUF);
const BB = new Float64Array(4), CNT = new Int32Array(32);
const TXZ = new Float32Array(NTREE * 3); let ntxz = 0; // trunks of the chunk being built (x, z, radius), for the bear to avoid

function fillHeights(ci) {
  const z0 = ci * CL;
  for (let j = 0; j < ROWS + 3; j++) {
    rowSet(z0 + (j - 1) * RS); RXR[j] = RX; RER[j] = RE;
    for (let i = 0, o = j * COLS; i < COLS; i++) HG[o + i] = hgt(DCOL[i]);
  }
}
function genTerrain(ci) {
  fillHeights(ci);
  const z0 = ci * CL; let o = 0;
  for (let j = 0; j <= ROWS; j++) {
    const r = (j + 1) * COLS, bx = RXR[j + 2] - RXR[j], bz = 2 * RS;
    for (let i = 0; i < COLS; i++) {
      const i0 = max(i - 1, 0), i1 = min(i + 1, COLS - 1), h = HG[r + i];
      const ax = DCOL[i1] - DCOL[i0], ay = HG[r + i1] - HG[r + i0], by = HG[r + COLS + i] - HG[r - COLS + i];
      let nx = -bz * ay, ny = bz * ax, nz = bx * ay - by * ax; const l = 1 / hypot(nx, ny, nz);
      TVB[o++] = RXR[j + 1] + DCOL[i]; TVB[o++] = h; TVB[o++] = z0 + j * RS;
      TVB[o++] = nx * l; TVB[o++] = ny * l; TVB[o++] = nz * l;
      TVB[o++] = DCOL[i]; TVB[o++] = h - RER[j + 1];
    }
  }
}
// fractional column of lateral distance d, then height / x on the generated grid (so things sit on the mesh)
function colOf(d) {
  let lo = 0, hi = COLS - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (DCOL[m] <= d) lo = m; else hi = m; }
  return lo + (d - DCOL[lo]) / (DCOL[hi] - DCOL[lo]);
}
let LX = 0, LY = 0, LE = 0;
function place(d, zl) {
  const fi = colOf(d), i = min(floor(fi), COLS - 2), u = fi - i, fj = zl / RS, j = min(floor(fj), ROWS - 1), v = fj - j, o = (j + 1) * COLS + i;
  LY = mix(mix(HG[o], HG[o + 1], u), mix(HG[o + COLS], HG[o + COLS + 1], u), v);
  LX = mix(RXR[j + 1], RXR[j + 2], v) + d; LE = mix(RER[j + 1], RER[j + 2], v);
}
// bucket the n scratch instances by key into IOUT and record [start, count] pairs in grp
function bucket(n, nk, grp) {
  CNT.fill(0);
  for (let k = 0; k < n; k++) CNT[IKEY[k]]++;
  let s = 0;
  for (let k = 0; k < nk; k++) { grp[k * 2] = s; grp[k * 2 + 1] = CNT[k]; s += CNT[k]; CNT[k] = grp[k * 2]; }
  for (let k = 0; k < n; k++) { const o = CNT[IKEY[k]]++ * 8, i = k * 8; for (let e = 0; e < 8; e++) IOUT[o + e] = ISC[i + e]; }
}
const put = (n, x, y, z, s, yaw, seed, tint, key) => { const o = n * 8; ISC[o] = x; ISC[o + 1] = y; ISC[o + 2] = z; ISC[o + 3] = s; ISC[o + 4] = yaw; ISC[o + 5] = seed; ISC[o + 6] = tint; ISC[o + 7] = 0; IKEY[n] = key; };

// trees: three bands by distance from the trail (0: <56 m, 1: <160 m, 2: far clumps to 700 m), each bucketed by side
// of the trail (0 left, 1 right) and kind, so a whole side or band can be skipped when it cannot be seen
const BAND = [3.4, 45, 160, 700], BANDN = [100, 130, 170];
function genTrees(c, dens) {
  const ci = c.ci, z0 = ci * CL, rng = RNG(ci * 7919 + 17);
  biome(z0 + CL / 2, BB);
  const fd = BB[0] + BB[1] * 0.045 + BB[2] * 0.42, pc = 0.05 + 0.92 * sst(0.12, 0.6, BB[2]);
  let n = 0, y0 = 1e9, y1 = -1e9;
  for (let b = 0; b < 3; b++) {
    const want = round(BANDN[b] * fd * dens), n0 = n;
    for (let k = 0; k < want * 2 && n - n0 < want && n < NTREE; k++) {
      const d = (rng() < 0.5 ? -1 : 1) * mix(BAND[b], BAND[b + 1], b ? rng() : pow(rng(), 0.85)) * (b ? 1 : 1.25), zl = rng() * CL;
      const r1 = rng(), r2 = rng(), r3 = rng(), r4 = rng(), r5 = rng();
      place(d, zl);
      if (BB[2] > 0.25 && LY - LE > 70 + r1 * 70) continue; // treeline
      if (b === 0) { let ok = true; for (let q = n0; q < n; q++) { const dx = ISC[q * 8] - LX, dz = ISC[q * 8 + 2] - (z0 + zl); if (dx * dx + dz * dz < 9) { ok = false; break; } } if (!ok) continue; }
      const con = r2 < pc, v = con ? 3 + (r3 < 0.5 ? 1 : 0) : r3 < 0.22 ? 2 : r3 < 0.62 ? 0 : 1;
      const tint = con ? r4 * 0.15 : clamp(BB[3] * (0.25 + 0.75 * r4) + r5 * 0.16, 0, 1);
      put(n++, LX, LY, z0 + zl, (0.72 + 0.6 * r5) * (b === 2 ? 1.5 : 1), r1 * TAU, r4, tint, (b * 2 + (d < 0 ? 0 : 1)) * TREEV + v);
      ISC[(n - 1) * 8 + 7] = abs(d); y0 = min(y0, LY); y1 = max(y1, LY);
    }
  }
  ntxz = n; for (let i = 0; i < n; i++) { TXZ[i * 3] = ISC[i * 8]; TXZ[i * 3 + 1] = ISC[i * 8 + 2]; TXZ[i * 3 + 2] = 0.45 * ISC[i * 8 + 3]; }
  bucket(n, 6 * TREEV, c.tg);
  // within each bucket, nearest the trail first (c.td keeps those distances), so a draw can stop at a distance
  for (let g = 0; g < 6 * TREEV; g++) {
    const s0 = c.tg[g * 2], e = s0 + c.tg[g * 2 + 1];
    for (let i = s0 + 1; i < e; i++) {
      for (let k = 0; k < 8; k++) ISC[k] = IOUT[i * 8 + k];
      let j = i - 1;
      for (; j >= s0 && IOUT[j * 8 + 7] > ISC[7]; j--) for (let k = 0; k < 8; k++) IOUT[(j + 1) * 8 + k] = IOUT[j * 8 + k];
      for (let k = 0; k < 8; k++) IOUT[(j + 1) * 8 + k] = ISC[k];
    }
  }
  for (let i = 0; i < n; i++) c.td[i] = IOUT[i * 8 + 7];
  c.ty0 = n ? y0 : 0; c.ty1 = n ? y1 : 0;
  return n;
}
function genRocks(c, dens) {
  const ci = c.ci, z0 = ci * CL, rng = RNG(ci * 4513 + 91);
  biome(z0 + CL / 2, BB);
  let n = 0; const want = round((7 + 4 * BB[1] + 70 * BB[2]) * dens);
  for (let k = 0; k < want && n < NROCK - 6; k++) {
    const s = 0.12 + pow(rng(), 3) * (1.2 + 2.2 * BB[2]), zl = rng() * CL, d = (rng() < 0.5 ? -1 : 1) * ((1.3 + s) * hypot(1, trailDX(z0 + zl)) + pow(rng(), 1.6) * 70);
    place(d, zl);
    put(n++, LX, LY - s * 0.25, z0 + zl, s, rng() * TAU, rng(), 0, floor(rng() * ROCKV));
  }
  if (BB[2] > 0.45 && ci % 3 === 0) { // a cairn beside the trail
    const d = (rng() < 0.5 ? -1.9 : 1.9) * hypot(1, trailDX(z0 + 20)); place(d, 20); let y = LY - 0.05;
    for (let k = 0; k < 5; k++) { const s = 0.3 - k * 0.05; put(n++, LX + (rng() - 0.5) * 0.06, y + s * 0.5, z0 + 20 + (rng() - 0.5) * 0.06, s, rng() * TAU, rng(), 0, k % ROCKV); y += s * 1.15; }
  }
  // Animals share the rock buffer (groups 3 bear, 4 squirrel, 5 rabbit). They are rare: at most one kind in a
  // chunk, and most chunks have none. They keep their distance: bears 26-58 m from the trail, squirrels 8-18 m,
  // rabbits 9-22 m. Each gets the slope of the ground along the short line it wanders.
  const zoo = qs.has('zoo'), ra = zoo ? 2 : rng(), pB = 0.05 * (BB[0] + 0.7 * BB[2]), pS = 0.11 * BB[0], pR = 0.12 * (BB[1] + 0.4 * BB[0]);
  // is the straight walk from (x, z) along (ux, uz), half length hl, clear of this chunk's trunks and rocks by `gap`?
  const clearWalk = (x, z, ux, uz, hl, gap) => {
    const hit = (px, pz, r) => { const t = clamp((px - x) * ux + (pz - z) * uz, -hl, hl), ex = px - x - ux * t, ez = pz - z - uz * t; return ex * ex + ez * ez < (r + gap) * (r + gap); };
    for (let i = 0; i < ntxz; i++) if (hit(TXZ[i * 3], TXZ[i * 3 + 1], TXZ[i * 3 + 2])) return false;
    for (let i = 0; i < n; i++) if (ISC[i * 8 + 3] > 0.35 && hit(ISC[i * 8], ISC[i * 8 + 2], ISC[i * 8 + 3])) return false;
    return true;
  };
  const animal = (sp, near, far, s0, s1) => {
    // the bear is big enough that walking through a tree shows, so it gets up to 16 tries at a clear line (and is
    // left out if there is none); its walk is 3.2 m each way plus its own length
    for (let attempt = 0; attempt < (sp === 1 ? 16 : 1); attempt++) {
      const zl = zoo ? 7 : (sp === 1 ? 9 + rng() * 22 : 6 + rng() * 28), d = (rng() < 0.5 ? -1 : 1) * (near + rng() * (far - near)), sc = mix(s0, s1, rng());
      // they are shy: the line they wander runs alongside the trail (within about 20 degrees), never toward it
      const tx = trailDX(z0 + zl), yaw = Math.atan2(-1, tx) + (rng() < 0.5 ? PI : 0) + (rng() - 0.5) * 0.7, seed = rng();
      place(d, zl); const x = LX, y = LY;
      if (sp === 1 && !clearWalk(x, z0 + zl, cos(yaw), -sin(yaw), 3.2 + 1.7 * sc, 0.75 * sc)) continue;
      const dzw = -sin(yaw), zz = clamp(zl + dzw, 0, CL); place(d + cos(yaw) - trailDX(z0 + zl) * dzw, zz);
      put(n++, x, y, z0 + zl, sc, yaw, seed, clamp(LY - y, -0.3, 0.3), ROCKV + sp - 1); ISC[(n - 1) * 8 + 7] = sp;
      return;
    }
  };
  if (zoo) { const k = ((ci % 3) + 3) % 3; if (k === 0) animal(1, 4, 4.5, 0.9, 1.15); else if (k === 1) animal(2, 1.2, 1.4, 1.5, 1.9); else animal(3, 1.2, 1.4, 1.1, 1.4); } // ?zoo: one beside the trail in every chunk, for checking them
  else if (ra < pB) animal(1, 26, 58, 0.9, 1.15);
  else if (ra < pB + pS) animal(2, 8, 18, 1.5, 1.9);
  else if (ra < pB + pS + pR) { animal(3, 9, 22, 1.1, 1.4); if (rng() < 0.4) animal(3, 9, 22, 1.0, 1.3); }
  bucket(n, ROCKV + 3, c.rg);
  return n;
}
// undergrowth: 0 ferns, 1 bushes, 2 flower clumps, 3 flower spikes
function genUnder(c, dens) {
  const ci = c.ci, z0 = ci * CL, rng = RNG(ci * 3331 + 5);
  biome(z0 + CL / 2, BB);
  let n = 0;
  const add = (key, want, near, far, sc0, sc1) => {
    for (let k = 0; k < want && n < NUG; k++) {
      const zl = rng() * CL, d = (rng() < 0.5 ? -1 : 1) * (near * hypot(1, trailDX(z0 + zl)) + pow(rng(), 1.7) * far), r1 = rng(), r2 = rng();
      place(d, zl);
      if (BB[2] > 0.3 && LY - LE > 150) continue;
      if (key === 3 && vn(LX * 0.045 + 7, (z0 + zl) * 0.045) < 0.5) continue; // spikes grow in drifts
      const tint = key >= 2 ? (floor(vn(LX * 0.06 + key * 9, (z0 + zl) * 0.06) * 6 + r2 * 1.4) % 5) / 5 + 0.1 : clamp(BB[3] * r2, 0, 1);
      put(n++, LX, LY, z0 + zl, mix(sc0, sc1, r1), r2 * TAU, r1, tint, key);
    }
  };
  add(0, round(520 * BB[0] * dens), 1.4, 34, 0.55, 1.15);
  add(1, round((90 * BB[0] + 70 * BB[2]) * dens), 2.2, 45, 0.7, 1.4);
  add(2, round((2600 * BB[1] + 160 * BB[0] + 420 * BB[2]) * dens), 1.0, 38, 0.5, 0.95);
  add(3, round((800 * BB[1] + 60 * BB[2]) * dens), 1.3, 40, 0.6, 1.1);
  bucket(n, UGV, c.ug);
  return n;
}
// grass blades: position + 4 bytes (height, facing, yellowness, random)
function genGrass(c, dens) {
  const ci = c.ci, z0 = ci * CL, rng = RNG(ci * 1223 + 3);
  biome(z0 + CL / 2, BB);
  const want = round(NGRASS * dens * (BB[0] * 0.5 + BB[1] + BB[2] * 0.85)), hs = BB[0] * 0.3 + BB[1] * 0.62 + BB[2] * 0.2;
  let n = 0;
  for (let k = 0; k < want; k++) {
    const a = 0.75 + pow(rng(), 1.9) * 36, zl = rng() * CL, d = (rng() < 0.5 ? -1 : 1) * (a + 0.75 * (hypot(1, trailDX(z0 + zl)) - 1)), r1 = rng(), r2 = rng(), r3 = rng();
    place(d, zl);
    const tall = sst(0.75, 2.2, a) * (0.45 + 0.55 * vn(LX * 0.21, (z0 + zl) * 0.21));
    const o = n * 16, f = n * 4;
    GF[f] = LX; GF[f + 1] = LY - 0.02; GF[f + 2] = z0 + zl;
    G8[o + 12] = clamp(hs * tall * (0.5 + r1) * (1 + a * 0.012), 0.03, 1) * 255;
    G8[o + 13] = r2 * 255;
    G8[o + 14] = clamp(BB[1] * 0.35 + BB[2] * 0.3 + BB[3] * 0.4 + vn(LX * 0.07 + 40, (z0 + zl) * 0.07) * 0.5 - 0.15 + r3 * 0.2, 0, 1) * 255;
    G8[o + 15] = r3 * 255;
    n++;
  }
  return n;
}
