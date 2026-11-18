// ============================================================================
// renderer, streaming, camera and input
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas = $('c'), qs = new URLSearchParams(location.search);
const bar = (f) => { $('bar').style.width = (f * 100).toFixed(0) + '%'; };
const fail = (m) => { $('msg').textContent = m; $('msg').style.display = 'block'; $('load').style.display = 'none'; throw new Error(m); };
const tick = () => new Promise((r) => setTimeout(r, 0));

// FAST changes nothing that is drawn: it only skips work whose result could not have reached the screen (see
// drawTrees), and adds GPU time and triangle counts to the stats. Set it to false to draw everything the plain way.
const FAST = true;
let CULL = FAST && qs.get('cull') !== '0';
// detail levels: anti-aliasing, pixel budget, plant density, shadow map size, light shaft steps
const QL = [
  { name: 'Low', aa: 1, pix: 1.0e6, dens: 0.5, sh: 2048, rays: 12 },
  { name: 'Medium', aa: 4, pix: 2.3e6, dens: 0.8, sh: 2048, rays: 16 },
  { name: 'High', aa: 4, pix: 4.1e6, dens: 1, sh: 4096, rays: 24 },
];
let qi = 1;
try { const s = localStorage.getItem('hikeQ'); if (s !== null) qi = +s; } catch (e) { }
if (qs.has('q')) qi = +qs.get('q');
qi = clamp(qi | 0, 0, 2);
const Q = QL[qi], AA = Q.aa;

if (!navigator.gpu) fail('This hike needs WebGPU. Try a current Chrome, Edge or Safari.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('No WebGPU adapter was found on this device.');
const TSQ = FAST && adapter.features.has('timestamp-query');
const device = await adapter.requestDevice(TSQ ? { requiredFeatures: ['timestamp-query'] } : undefined);
device.lost.then((i) => { $('msg').textContent = 'The graphics device was lost (' + i.message + '). Reload to continue.'; $('msg').style.display = 'block'; });
const ctx = canvas.getContext('webgpu'), CF = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format: CF, alphaMode: 'opaque' });
const DQ = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float';
const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;
const buf = (size, usage) => device.createBuffer({ size: (size + 3) & ~3, usage });
const bufOf = (arr, usage) => { const b = buf(arr.byteLength, usage | BU.COPY_DST); DQ.writeBuffer(b, 0, arr); return b; };
const tex = (w, h, format, usage, samples = 1) => device.createTexture({ size: [w, h], format, usage, sampleCount: samples });

// ---------------------------------------------------------------- uniforms, layouts, pipelines
const UB = new Float32Array(88), UBS = new Float32Array(88);
const ubo = buf(352, BU.UNIFORM | BU.COPY_DST), uboS = buf(352, BU.UNIFORM | BU.COPY_DST);
const bgl0 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: {} }] });
const bgl1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, texture: { sampleType: 'depth' } }, { binding: 1, visibility: SS.VERTEX | SS.FRAGMENT, sampler: { type: 'comparison' } }] });
const plScene = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] }), plShadow = device.createPipelineLayout({ bindGroupLayouts: [bgl0] });
const tShadow = tex(Q.sh, Q.sh, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), vShadow = tShadow.createView();
const sCmp = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
const sLin = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const bg0 = device.createBindGroup({ layout: bgl0, entries: [{ binding: 0, resource: { buffer: ubo } }] });
const bg0S = device.createBindGroup({ layout: bgl0, entries: [{ binding: 0, resource: { buffer: uboS } }] });
const bg1 = device.createBindGroup({ layout: bgl1, entries: [{ binding: 0, resource: vShadow }, { binding: 1, resource: sCmp }] });

const mod = async (code, name) => {
  const m = device.createShaderModule({ code });
  const info = await m.getCompilationInfo();
  for (const e of info.messages) if (e.type === 'error') console.error(name + ':' + e.lineNum + ': ' + e.message + '\n' + (code.split('\n')[e.lineNum - 1] || ''));
  return m;
};
const mScene = await mod(W_SCENE(AA), 'scene'), mRays = await mod(W_RAYS(AA, Q.rays), 'rays'), mBlur = await mod(W_RBLUR, 'blur'), mBlit = await mod(W_BLIT, 'blit'), mPost = await mod(W_POST(AA), 'post');
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const VB_T = [{ arrayStride: 32, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'float32x3'), A(2, 24, 'float32x2')] }];
const VB_I = { arrayStride: 32, stepMode: 'instance', attributes: [A(3, 0, 'float32x4'), A(4, 16, 'float32x4')] };
const VB_S = [{ arrayStride: 32, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'float32x3'), A(2, 24, 'float32x2')] }, VB_I];
const VB_C = [{ arrayStride: 56, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'float32x3'), A(2, 24, 'float32x2'), A(5, 32, 'float32x2'), A(6, 40, 'float32x4')] }, VB_I];
const VB_G = [{ arrayStride: 16, stepMode: 'instance', attributes: [A(0, 0, 'float32x3'), A(1, 12, 'unorm8x4')] }];
const VB_P = [{ arrayStride: 16, stepMode: 'instance', attributes: [A(0, 0, 'float32x4')] }];
const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const scenePipe = (vs, fs, buffers, o = {}) => device.createRenderPipeline({
  layout: plScene, vertex: { module: mScene, entryPoint: vs, buffers }, fragment: { module: mScene, entryPoint: fs, targets: [{ format: HDR, blend: o.blend }] },
  primitive: { topology: o.topo || 'triangle-list', cullMode: 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: !o.nowrite, depthCompare: o.cmp || 'greater' },
  multisample: { count: AA, alphaToCoverageEnabled: !!o.a2c && AA > 1 },
});
const shadowPipe = (vs, fs, buffers) => device.createRenderPipeline({
  layout: plShadow, vertex: { module: mScene, entryPoint: vs, buffers }, fragment: fs ? { module: mScene, entryPoint: fs, targets: [] } : undefined,
  primitive: { topology: 'triangle-list', cullMode: 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 },
});
const pTerr = scenePipe('vsT', 'fsT', VB_T), pSolid = scenePipe('vsS', 'fsS', VB_S), pCard = scenePipe('vsC', 'fsC', VB_C, { a2c: true });
const pGrass = scenePipe('vsG', 'fsG', VB_G, { topo: 'triangle-strip' }), pCrit = scenePipe('vsK', 'fsK', VB_P);
const pMote = scenePipe('vsM', 'fsM', VB_P, { topo: 'triangle-strip', blend: ADD, nowrite: true });
const pSky = scenePipe('vsF', 'fsSky', [], { nowrite: true, cmp: 'greater-equal' });
const pTerrS = shadowPipe('vsT', null, VB_T), pSolidS = shadowPipe('vsS', null, VB_S), pCardS = shadowPipe('vsC', 'fsCS', VB_C);
const fsPipe = (m, fs, format, blend) => device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vsF' }, fragment: { module: m, entryPoint: fs, targets: [{ format, blend }] } });
const pRays = fsPipe(mRays, 'fs', HDR), pBlur = fsPipe(mBlur, 'fs', HDR), pPost = fsPipe(mPost, 'fs', CF);
const pD0 = fsPipe(mBlit, 'fsD0', HDR), pD = fsPipe(mBlit, 'fsD', HDR), pU = fsPipe(mBlit, 'fsU', HDR, ADD);
bar(0.08); await tick();

// ---------------------------------------------------------------- meshes
const SV = [], SI = [], CV = [], CI = [];
// each mesh is stamped with its level of detail (0-2 for trees, 3 = always drawn) in a vertex field (solids: kind, cards: shape): +10 per level
const addTo = (V, I, M, stride, fld, lod) => { const m = { first: I.length, count: M.i.length, base: V.length / stride }; for (let k = 0; k < M.v.length; k++) V.push(k % stride === fld ? M.v[k] + lod * 10 : M.v[k]); for (let k = 0; k < M.i.length; k++) I.push(M.i[k]); return m; };
const addS = (M, lod = 3) => addTo(SV, SI, M, 8, 7, lod), addC = (M, lod = 3) => addTo(CV, CI, M, CS, 9, lod);
const TPAR = [
  { h: 15, cc: 0.66, trunk: 0.42, r: 0.4, depth: 4, f0: 6, t0: 0.5, l1: 0.4, lr: 0.66, ang: 0.95, bend: 0.5, lift: 0.06, droop: -0.05, lv: 15, ls: 0.8, f3: 0.5, kind: 0 },
  { h: 21, cc: 0.68, trunk: 0.62, r: 0.36, depth: 4, f0: 6, t0: 0.45, l1: 0.3, lr: 0.64, ang: 0.8, bend: 0.4, lift: 0.1, droop: 0, lv: 14, ls: 0.8, f3: 0.45, kind: 0 },
  { h: 13, cc: 0.66, trunk: 0.8, r: 0.17, depth: 3, f0: 9, t0: 0.35, l1: 0.22, lr: 0.7, ang: 0.7, bend: 0.5, lift: 0.08, droop: -0.3, lv: 22, ls: 0.6, f3: 0.5, kind: 1 },
];
const CPAR = [{ h: 19, r: 0.3, R: 3.4, nw: 22, nb: 8, droop: 0.9 }, { h: 14, r: 0.24, R: 2.9, nw: 17, nb: 7, droop: 0.6 }];
const TREES = [];
for (let v = 0; v < TREEV; v++) {
  const t = { s: [], c: [] };
  for (let lod = 0; lod < 3; lod++) {
    const m = v < 3 ? buildTree(101 + v * 31, TPAR[v], lod) : buildConifer(401 + v * 17, CPAR[v - 3], lod);
    t.s.push(addS(m.S, lod)); t.c.push(m.C.i.length ? addC(m.C, lod) : null);
  }
  TREES.push(t);
  bar(0.1 + 0.03 * v); await tick();
}
const ROCKS = [0, 1, 2].map((k) => addS(buildRock(900 + k * 13).S));
ROCKS.push(addS(buildBear().S), addS(buildSquirrel().S), addS(buildRabbit().S)); // animals ride along with the rocks
const UGM = [addC(buildFern(11).C), addC(buildBush(12).C), addC(buildFlowers(13, false).C), addC(buildFlowers(14, true).C)];
const vbS = bufOf(new Float32Array(SV), BU.VERTEX), ibS = bufOf(new Uint32Array(SI), BU.INDEX);
const vbC = bufOf(new Float32Array(CV), BU.VERTEX), ibC = bufOf(new Uint32Array(CI), BU.INDEX);
// terrain grid indices (shared by every chunk)
const NTI = ROWS * (COLS - 1) * 6, TI = new Uint16Array(NTI);
for (let j = 0, o = 0; j < ROWS; j++) for (let i = 0; i < COLS - 1; i++) { const a = j * COLS + i, b = a + COLS; TI[o++] = a; TI[o++] = b; TI[o++] = a + 1; TI[o++] = a + 1; TI[o++] = b; TI[o++] = b + 1; }
const ibT = bufOf(TI, BU.INDEX);
// seeds for the flying things: xyz random, w type (0 bird, 1 butterfly, 2 falling leaf), and for the dust motes
const NBIRD = 26, NBFLY = 60, NLEAF = 220, NCRIT = NBIRD + NBFLY + NLEAF, NMOTE = Q.aa > 1 ? 3600 : 1800;
const seeds = (n, ty) => { const a = new Float32Array(n * 4), r = RNG(n * 31 + 7); for (let k = 0; k < n; k++) { a[k * 4] = r(); a[k * 4 + 1] = r(); a[k * 4 + 2] = r(); a[k * 4 + 3] = ty ? ty(k) : r(); } return a; };
const vbCrit = bufOf(seeds(NCRIT, (k) => (k < NBIRD ? 0 : k < NBIRD + NBFLY ? 1 : 2)), BU.VERTEX), vbMote = bufOf(seeds(NMOTE), BU.VERTEX);

// ---------------------------------------------------------------- chunk ring
const VU = BU.VERTEX | BU.COPY_DST;
const chunks = Array.from({ length: NCH }, () => ({
  ci: -1e9, ready: false, stage: 0, xc: 0, x0: 0, x1: 0, ty0: 0, ty1: 0, gn: 0, tg: new Int32Array(60), td: new Float32Array(NTREE), rg: new Int32Array(12), ug: new Int32Array(8),
  vbT: buf(TVB.byteLength, VU), vbI: buf(NTREE * 32, VU), vbR: buf(NROCK * 32, VU), vbU: buf(NUG * 32, VU), vbG: buf(NGRASS * 16, VU),
}));
// builds one stage of chunk c per call (terrain, then trees / rocks / undergrowth, then grass)
function genStep(c) {
  if (c.stage === 0) { genTerrain(c.ci); DQ.writeBuffer(c.vbT, 0, TVB); c.xc = trailX(c.ci * CL + CL / 2); c.stage = 1;
    c.x0 = 1e9; c.x1 = -1e9; for (let j = 0; j < ROWS + 3; j++) { c.x0 = min(c.x0, RXR[j]); c.x1 = max(c.x1, RXR[j]); } // sideways reach of the trail in this chunk
    return false; }
  if (c.stage === 1) {
    let n = genTrees(c, Q.dens); if (n) DQ.writeBuffer(c.vbI, 0, IOUT, 0, n * 8);
    n = genRocks(c, Q.dens); if (n) DQ.writeBuffer(c.vbR, 0, IOUT, 0, n * 8);
    n = genUnder(c, Q.dens); if (n) DQ.writeBuffer(c.vbU, 0, IOUT, 0, n * 8);
    c.stage = 2; return false;
  }
  c.gn = genGrass(c, Q.dens); if (c.gn) DQ.writeBuffer(c.vbG, 0, GBUF, 0, c.gn * 16);
  c.stage = 3; c.ready = true; return true;
}
let gen = null;
// keeps the ring centred on the hiker: finds the nearest missing chunk and builds it one stage per frame
function stream(z) {
  if (!gen) {
    const c0 = floor(z / CL);
    for (let k = 0; k < NCH; k++) {
      const ci = c0 + ((k & 1) ? -((k + 1) >> 1) : (k >> 1)), c = chunks[((ci % NCH) + NCH) % NCH];
      if (c.ci !== ci) { c.ci = ci; c.ready = false; c.stage = 0; gen = c; break; }
    }
  }
  if (gen && genStep(gen)) gen = null;
  return gen !== null;
}

// ---------------------------------------------------------------- camera state (preallocated; the frame loop allocates nothing)
// time of day presets: sun elevation, azimuth, colour, intensity, zenith, horizon, fog, exposure, shaft strength, dusk (sunset sky and stars), night
const TOD = [
  { name: 'Morning', v: [0.50, -0.75, 1.0, 0.84, 0.62, 5.2, 0.12, 0.30, 0.72, 0.56, 0.67, 0.80, 0.0011, 0.62, 1.0, 0, 0] },
  { name: 'Midday', v: [1.05, -0.5, 1.0, 0.96, 0.88, 5.6, 0.10, 0.27, 0.75, 0.52, 0.68, 0.88, 0.0008, 0.56, 0.7, 0, 0] },
  { name: 'Golden hour', v: [0.17, -0.95, 1.0, 0.52, 0.2, 4.6, 0.14, 0.22, 0.50, 0.88, 0.54, 0.32, 0.0015, 0.75, 1.3, 0, 0] },
  { name: 'Early evening', v: [0.035, -1.05, 1.0, 0.36, 0.16, 2.6, 0.035, 0.065, 0.2, 0.8, 0.4, 0.24, 0.0013, 1.3, 1.2, 1, 0] },
  // night: the 'sun' is a dim blue moon, the sky is nearly black, and the headlamp does the work (L switches it)
  { name: 'Night', v: [0.85, -0.55, 0.6, 0.72, 1.0, 0.085, 0.004, 0.007, 0.018, 0.012, 0.018, 0.034, 0.0011, 1.25, 0.4, 0, 1] },
];
let tod = clamp(+(qs.get('t') || 0) | 0, 0, TOD.length - 1);
const TC = Float64Array.from(TOD[tod].v);
const FOVY = 62 * PI / 180, TANY = Math.tan(FOVY / 2), NEAR = 0.15, SHR = 85;
let W = 2, H = 2, TANX = TANY;
// where a hike can begin: 0 anywhere, 1 summer forest, 2 autumn forest, 3 meadow, 4 alpine. Picks a random spot
// in the first 20 km, then walks forward to the heart of the next stretch of the wanted kind.
function findStart(kind) {
  let z = Math.random() * 20000;
  if (!kind) return z;
  for (let k = 0; k < 6000; k++, z += 10) {
    biome(z, BIO);
    if (kind === 1 ? BIO[0] > 0.97 && BIO[3] < 0.1 : kind === 2 ? BIO[0] > 0.97 && BIO[3] > 0.9 : BIO[kind - 2] > 0.97) break;
  }
  return z + 40 + Math.random() * 120;
}
const BIO = new Float64Array(4), BC = new Float64Array(3), SUN = new Float64Array(3), SC = new Float64Array(3);
let Z = qs.has('z') ? +qs.get('z') : findStart(0), spd = 0, auto = false, lookY = +(qs.get('yaw') || 0), lookP = +(qs.get('pitch') || 0), yawS = atan2(trailDX(Z), 1), pitS = 0, bob = 0, lastLook = -10, walked = 0;
let T = +(qs.get('time') || 0), last = 0, started = false, paused = true, turn = 0;
let CX = 0, CY = 0, CZ = 0, FX = 0, FY = 0, FZ = 1, RTX = 1, RTZ = 0, UX = 0, UY = 1, UZ = 0, pitch = 0;
let lampOn = true, lampK = 1;
const keys = { f: 0, b: 0, run: 0, l: 0, r: 0 }, TSPD = +(qs.get('speed') || 0); // test hook: walking speed

function camera(dt) {
  const want = clamp(keys.f - keys.b + (auto ? 1 : 0), -1, 1), target = want * (TSPD || (keys.run ? 6.5 : 2.3));
  spd += (target - spd) * min(1, dt * 3.5);
  const dx = trailDX(Z), sl = elevD(Z), ds = spd * dt;
  Z += ds / hypot(1, dx, sl); walked += abs(ds);
  const b0 = floor(bob / PI); bob += abs(ds) * 1.95;
  if (floor(bob / PI) !== b0 && started) audioStep(abs(spd));
  const amp = min(1, abs(spd) / 2.3);
  let d = atan2(dx, 1) - yawS; yawS += d * min(1, dt * 2.2);
  pitS += (Math.atan(sl) * 0.7 - 0.02 - pitS) * min(1, dt * 2);
  lookY += (keys.r - keys.l) * dt * 1.4;
  if (keys.r || keys.l) lastLook = T;
  if (T - lastLook > 3 && abs(spd) > 0.3) { const k = exp(-dt * 0.6); lookY *= k; lookP *= k; }
  const yaw = yawS + lookY; pitch = clamp(pitS + lookP, -1.35, 1.35);
  const cp = cos(pitch);
  FX = sin(yaw) * cp; FY = sin(pitch); FZ = cos(yaw) * cp; RTX = cos(yaw); RTZ = -sin(yaw);
  UX = FY * RTZ; UY = FZ * RTX - FX * RTZ; UZ = -FY * RTX; // up = fwd x right
  CX = trailX(Z) + RTX * sin(bob) * 0.018 * amp; CY = elev(Z) + 1.68 + sin(bob * 2) * 0.024 * amp; CZ = Z + RTZ * sin(bob) * 0.018 * amp;
  biome(Z, BIO);
}
// 4x4 matrices are written column-major straight into the uniform array
function setRow(M, o, r, x, y, z, w) { M[o + r] = x; M[o + 4 + r] = y; M[o + 8 + r] = z; M[o + 12 + r] = w; }
function uniforms(dt) {
  const tv = TOD[tod].v, k = min(1, dt * 0.9);
  for (let i = 0; i < 17; i++) TC[i] += (tv[i] - TC[i]) * k;
  const el = TC[0], az = TC[1];
  SUN[0] = sin(az) * cos(el); SUN[1] = sin(el); SUN[2] = cos(az) * cos(el);
  const f = 1 / TANY, fa = f * H / W;
  setRow(UB, 0, 0, RTX * fa, 0, RTZ * fa, -(RTX * CX + RTZ * CZ) * fa);
  setRow(UB, 0, 1, UX * f, UY * f, UZ * f, -(UX * CX + UY * CY + UZ * CZ) * f);
  setRow(UB, 0, 2, 0, 0, 0, NEAR);
  setRow(UB, 0, 3, FX, FY, FZ, -(FX * CX + FY * CY + FZ * CZ));
  // shadow map: an orthographic box looking down the sun, centred ahead of the hiker and snapped to whole texels
  const fl = hypot(FX, FZ) || 1, sx = CX + FX / fl * SHR * 0.55, sz = CZ + FZ / fl * SHR * 0.55, sy = CY;
  const L0 = SUN[0], L1 = SUN[1], L2 = SUN[2], rl = hypot(L2, L0), r0 = L2 / rl, r2 = -L0 / rl; // r = up x L
  const u0 = L1 * r2, u1 = L2 * r0 - L0 * r2, u2 = -L1 * r0; // u = L x r
  const tx = 2 * SHR / Q.sh;
  const cr = round((sx * r0 + sz * r2) / tx) * tx, cu = round((sx * u0 + sy * u1 + sz * u2) / tx) * tx, cl = sx * L0 + sy * L1 + sz * L2;
  const DN = 320, DF = 160, id = 1 / (DN + DF);
  setRow(UB, 16, 0, r0 / SHR, 0, r2 / SHR, -cr / SHR);
  setRow(UB, 16, 1, u0 / SHR, u1 / SHR, u2 / SHR, -cu / SHR);
  setRow(UB, 16, 2, -L0 * id, -L1 * id, -L2 * id, (DN + cl) * id);
  setRow(UB, 16, 3, 0, 0, 0, 1);
  SC[0] = r0 * cr + u0 * cu + L0 * cl; SC[1] = u1 * cu + L1 * cl; SC[2] = r2 * cr + u2 * cu + L2 * cl;
  const wind = 0.34 + 0.2 * sin(T * 0.13) + 0.12 * sin(T * 0.31 + 1) + 0.25 * BIO[2];
  let o = 32;
  UB[o++] = CX; UB[o++] = CY; UB[o++] = CZ; UB[o++] = T;
  UB[o++] = L0; UB[o++] = L1; UB[o++] = L2; UB[o++] = TC[16];
  UB[o++] = TC[2] * TC[5]; UB[o++] = TC[3] * TC[5]; UB[o++] = TC[4] * TC[5]; UB[o++] = 0;
  UB[o++] = TC[6]; UB[o++] = TC[7]; UB[o++] = TC[8]; UB[o++] = 0;
  UB[o++] = TC[9]; UB[o++] = TC[10]; UB[o++] = TC[11]; UB[o++] = 0;
  UB[o++] = FX; UB[o++] = FY; UB[o++] = FZ; UB[o++] = NEAR;
  UB[o++] = RTX; UB[o++] = 0; UB[o++] = RTZ; UB[o++] = TANX;
  UB[o++] = UX; UB[o++] = UY; UB[o++] = UZ; UB[o++] = TANY;
  UB[o++] = W; UB[o++] = H; UB[o++] = 1 / W; UB[o++] = 1 / H;
  UB[o++] = BIO[0]; UB[o++] = BIO[1]; UB[o++] = BIO[2]; UB[o++] = BIO[3];
  lampK += ((lampOn ? 1 : 0) - lampK) * min(1, dt * 8);
  UB[o++] = 0.8; UB[o++] = 0.6; UB[o++] = wind; UB[o++] = 5.5 * lampK * sst(0.25, 0.8, TC[16]); // the headlamp comes on as night falls
  UB[o++] = SC[0]; UB[o++] = SC[1]; UB[o++] = SC[2]; UB[o++] = SHR;
  const bk = min(1, dt * 0.2);
  BC[0] += (CX + sin(yawS) * 90 - BC[0]) * bk; BC[1] += (CY - BC[1]) * bk; BC[2] += (CZ + cos(yawS) * 90 - BC[2]) * bk;
  UB[o++] = BC[0]; UB[o++] = BC[1]; UB[o++] = BC[2]; UB[o++] = 0;
  UB[o++] = TC[13]; UB[o++] = TC[14] * (0.0012 + 0.026 * BIO[0] + 0.003 * BIO[2]); UB[o++] = TC[12] * (1 + 0.5 * BIO[0]); UB[o++] = TC[15];
  UBS.set(UB); for (let i = 0; i < 16; i++) UBS[i] = UB[16 + i];
  DQ.writeBuffer(ubo, 0, UB); DQ.writeBuffer(uboS, 0, UBS);
}

// test hook (?cap): draw into a texture instead of the page and hand the pixels to window.__grab()
const CAP = qs.has('cap');
if (CAP) window.__grab = async () => {
  const bpr = (W * 4 + 255) & ~255, b = buf(bpr * H, BU.COPY_DST | BU.MAP_READ), e = device.createCommandEncoder();
  e.copyTextureToBuffer({ texture: tCap }, { buffer: b, bytesPerRow: bpr }, [W, H]); DQ.submit([e.finish()]);
  await b.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(b.getMappedRange()), out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) out.set(src.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
  b.unmap(); b.destroy();
  let s = ''; for (let i = 0; i < out.length; i += 32768) s += String.fromCharCode.apply(null, out.subarray(i, i + 32768));
  return { w: W, h: H, bgra: CF === 'bgra8unorm', data: btoa(s) };
};
// ---------------------------------------------------------------- render targets (rebuilt on resize)
let targets = [], tCap = null, passScene, passRays, passBlur, passPost, bgRays, bgBlur, bgPost, bloomPass = [], bloomBG = [];
const NB = 5, passShadow = { colorAttachments: [], depthStencilAttachment: { view: vShadow, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } };
const colorAtt = (view, clear) => ({ view, clearValue: [0, 0, 0, 1], loadOp: clear ? 'clear' : 'load', storeOp: 'store' });
function resize() {
  const dpr = min(devicePixelRatio || 1, 2), cw = max(8, floor(innerWidth * dpr)), ch = max(8, floor(innerHeight * dpr)), s = min(1, sqrt(Q.pix / (cw * ch)));
  const w = max(8, floor(cw * s) & ~1), h = max(8, floor(ch * s) & ~1);
  if (w === W && h === H) return;
  W = w; H = h; TANX = TANY * W / H; canvas.width = W; canvas.height = H;
  for (const t of targets) t.destroy();
  const RT = TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING;
  const tScene = tex(W, H, HDR, RT), tDepth = tex(W, H, DEPTH, RT, AA), tMS = AA > 1 ? tex(W, H, HDR, TU.RENDER_ATTACHMENT, AA) : null;
  const tRays = tex(W / 2, H / 2, HDR, RT), tRaysB = tex(W / 2, H / 2, HDR, RT), bl = [];
  for (let i = 0; i < NB; i++) bl.push(tex(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR, RT));
  targets = [tScene, tDepth, tRays, tRaysB, ...bl]; if (tMS) targets.push(tMS);
  if (CAP) { tCap = tex(W, H, CF, TU.RENDER_ATTACHMENT | TU.COPY_SRC); targets.push(tCap); }
  const vScene = tScene.createView(), vDepth = tDepth.createView(), vb = bl.map((t) => t.createView());
  passScene = {
    colorAttachments: [AA > 1 ? { view: tMS.createView(), resolveTarget: vScene, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'discard' } : colorAtt(vScene, true)],
    depthStencilAttachment: { view: vDepth, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
  };
  passRays = { colorAttachments: [colorAtt(tRays.createView(), true)] };
  passBlur = { colorAttachments: [colorAtt(tRaysB.createView(), true)] };
  passPost = { colorAttachments: [colorAtt(null, true)] };
  if (TSQ) passPost.timestampWrites = { querySet: tsSet, endOfPassWriteIndex: 1 };
  const U = { binding: 0, resource: { buffer: ubo } };
  bgRays = device.createBindGroup({ layout: pRays.getBindGroupLayout(0), entries: [U, { binding: 1, resource: vShadow }, { binding: 2, resource: sCmp }, { binding: 3, resource: vDepth }] });
  bgBlur = device.createBindGroup({ layout: pBlur.getBindGroupLayout(0), entries: [{ binding: 0, resource: tRays.createView() }] });
  bgPost = device.createBindGroup({ layout: pPost.getBindGroupLayout(0), entries: [U, { binding: 1, resource: sLin }, { binding: 2, resource: vScene }, { binding: 3, resource: tRaysB.createView() }, { binding: 4, resource: vb[0] }, { binding: 5, resource: vDepth }] });
  // bloom: NB steps down, then NB-1 steps back up (added onto the larger level)
  bloomPass = []; bloomBG = [];
  const blit = (p, src) => device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: sLin }, { binding: 1, resource: src }] });
  for (let i = 0; i < NB; i++) { bloomPass.push({ pipe: i ? pD : pD0, desc: { colorAttachments: [colorAtt(vb[i], true)] }, bg: blit(i ? pD : pD0, i ? vb[i - 1] : vScene) }); }
  for (let i = NB - 1; i > 0; i--) { bloomPass.push({ pipe: pU, desc: { colorAttachments: [colorAtt(vb[i - 1], false)] }, bg: blit(pU, vb[i]) }); }
}

// ---------------------------------------------------------------- drawing
// chunks in view this frame, nearest first
const VIS = new Array(NCH).fill(null), VISD = new Int32Array(NCH); let nvis = 0;
// is the strip x in [xc - w, xc + w], z in [z0, z1] possibly in view? (corner test against three planes)
function inView(xc, w, z0, z1, m = 30) {
  const fl = hypot(FX, FZ) || 1, fx = FX / fl, fz = FZ / fl, th = TANX / max(cos(pitch), 0.3) + 0.2;
  let behind = 0, left = 0, right = 0;
  for (let k = 0; k < 4; k++) {
    const vx = xc + ((k & 1) ? w : -w) - CX, vz = ((k & 2) ? z1 : z0) - CZ, al = vx * fx + vz * fz, sd = vx * fz - vz * fx;
    if (al < -m) behind++; if (sd < -(al * th + m)) left++; if (sd > al * th + m) right++;
  }
  return behind < 4 && left < 4 && right < 4;
}
// which levels of detail chunk `adc` chunks away may need (the shader hides each tree outside its own range)
// (full detail to ~95 m, half the leaves to ~250 m, a simple crown beyond; bands are 0-56, 45-160 and 160-700 m from the trail)
const lodDrawn = (band, lod, adc) => (lod === 0 ? band < 2 && adc <= (band ? 2 : 3) : lod === 1 ? adc <= (band === 2 ? 6 : 7) : band === 2 || adc >= 3);
// ---- exact culling (FAST build). Each test only rejects a group when none of it could be drawn:
// nearest / farthest horizontal distance from the camera to the rectangle xa..xb, z0..z1
let DMIN = 0, DMAX = 0, tris = 0;
function rectDist(xa, xb, z0, z1) {
  const dx = max(xa - CX, 0, CX - xb), dz = max(z0 - CZ, 0, CZ - z1); DMIN = hypot(dx, dz);
  DMAX = hypot(max(CX - xa, xb - CX), max(CZ - z0, z1 - CZ));
}
// is the box outside the shadow map? (its 8 corners against the map's sides and depth range)
function outOfShadow(xa, xb, ya, yb, z0, z1) {
  let l = 0, r = 0, b = 0, t = 0, n = 0, f = 0;
  for (let k = 0; k < 8; k++) {
    const x = (k & 1) ? xb : xa, y = (k & 2) ? yb : ya, z = (k & 4) ? z1 : z0;
    const sx = UB[16] * x + UB[20] * y + UB[24] * z + UB[28], sy = UB[17] * x + UB[21] * y + UB[25] * z + UB[29], sz = UB[18] * x + UB[22] * y + UB[26] * z + UB[30];
    if (sx < -1) l++; if (sx > 1) r++; if (sy < -1) b++; if (sy > 1) t++; if (sz < 0) n++; if (sz > 1) f++;
  }
  return l === 8 || r === 8 || b === 8 || t === 8 || n === 8 || f === 8;
}
const BIN = [0, 40, 155], BOUT = [57, 162, 702], PAD = 24; // band edges (m from the trail) and the widest crown
function drawTrees(r, c, adc, cards, shadow) {
  r.setVertexBuffer(1, c.vbI);
  const z0 = c.ci * CL - PAD, z1 = z0 + CL + 2 * PAD;
  for (let b = 0; b < 3; b++) for (let sd = 0; sd < 2; sd++) {
    let near = 0, far = 1e9, off = 0, dzn = 0;
    if (CULL) {
      // a tree d metres from the trail on this side is at least d + off away sideways, and dzn away along the trail
      off = sd ? c.x0 - CX : CX - c.x1; dzn = max(c.ci * CL - CZ, 0, CZ - c.ci * CL - CL);
      const xa = sd ? c.x0 + BIN[b] - PAD : c.x0 - BOUT[b] - PAD, xb = sd ? c.x1 + BOUT[b] + PAD : c.x1 - BIN[b] + PAD;
      if (shadow ? outOfShadow(xa, xb, c.ty0 - 2, c.ty1 + 46, z0, z1) : !inView((xa + xb) / 2, (xb - xa) / 2, z0, z1, 0)) continue;
      rectDist(xa, xb, z0, z1); near = DMIN - PAD - 13; far = hypot(DMAX, max(abs(c.ty0 - CY), abs(c.ty1 - CY)) + 2) + PAD + 13;
    }
    for (let lod = 0; lod < 3; lod++) {
      if (!lodDrawn(b, lod, adc)) continue;
      if (lod === 0 ? near >= 95 : lod === 1 ? far < 95 || near >= 250 : far < 225) continue; // no tree here is in this level's range
      for (let v = 0; v < TREEV; v++) {
        const g = ((b * 2 + sd) * TREEV + v) * 2; let n = c.tg[g + 1]; if (!n) continue;
        const m = cards ? TREES[v].c[lod] : TREES[v].s[lod]; if (!m) continue;
        if (CULL && lod < 2) { // trees are sorted by distance from the trail: stop where they must be beyond this level's range
          const lim = lod ? 263 : 108, reach = lim > dzn ? sqrt(lim * lim - dzn * dzn) - off : -1, s0 = c.tg[g];
          while (n > 0 && c.td[s0 + n - 1] >= reach) n--;
          if (!n) continue;
        }
        r.drawIndexed(m.count, n, m.first, m.base, c.tg[g]); tris += m.count / 3 * n;
      }
    }
  }
}
function drawGroups(r, vb, grp, meshes) {
  r.setVertexBuffer(1, vb);
  for (let v = 0; v < meshes.length; v++) { const n = grp[v * 2 + 1]; if (n) { r.drawIndexed(meshes[v].count, n, meshes[v].first, meshes[v].base, grp[v * 2]); tris += meshes[v].count / 3 * n; } }
}
function render() {
  const c0 = floor(CZ / CL);
  nvis = 0;
  for (let k = 0; k < NCH; k++) {
    const off = (k & 1) ? -((k + 1) >> 1) : (k >> 1), ci = c0 + off, c = chunks[((ci % NCH) + NCH) % NCH];
    if (c.ci !== ci || !c.ready) continue;
    if (inView(c.xc, 1180, ci * CL, ci * CL + CL)) { VIS[nvis] = c; VISD[nvis++] = abs(off); }
  }
  const e = device.createCommandEncoder();
  tris = 0;
  // shadow map: everything near the shadow centre
  let r = e.beginRenderPass(passShadow);
  r.setBindGroup(0, bg0S);
  const s0 = floor((SC[2] - SHR - 40) / CL), s1 = floor((SC[2] + SHR + 40) / CL);
  r.setPipeline(pTerrS); r.setIndexBuffer(ibT, 'uint16');
  for (let ci = s0; ci <= s1; ci++) { const c = chunks[((ci % NCH) + NCH) % NCH]; if (c.ci === ci && c.ready) { r.setVertexBuffer(0, c.vbT); r.drawIndexed(NTI); tris += NTI / 3; } }
  r.setPipeline(pSolidS); r.setVertexBuffer(0, vbS); r.setIndexBuffer(ibS, 'uint32');
  for (let ci = s0; ci <= s1; ci++) { const c = chunks[((ci % NCH) + NCH) % NCH]; if (c.ci === ci && c.ready) { drawTrees(r, c, abs(ci - c0), false, true); if (!CULL || !outOfShadow(c.x0 - 88, c.x1 + 88, c.ty0 - 30, c.ty1 + 30, ci * CL - 5, ci * CL + CL + 5)) drawGroups(r, c.vbR, c.rg, ROCKS); } }
  r.setPipeline(pCardS); r.setVertexBuffer(0, vbC); r.setIndexBuffer(ibC, 'uint32');
  for (let ci = s0; ci <= s1; ci++) { const c = chunks[((ci % NCH) + NCH) % NCH]; if (c.ci === ci && c.ready) drawTrees(r, c, abs(ci - c0), true, true); }
  r.end();

  r = e.beginRenderPass(passScene);
  r.setBindGroup(0, bg0); r.setBindGroup(1, bg1);
  r.setPipeline(pSolid); r.setVertexBuffer(0, vbS); r.setIndexBuffer(ibS, 'uint32');
  for (let k = 0; k < nvis; k++) { const c = VIS[k]; drawTrees(r, c, VISD[k], false, false); if (VISD[k] <= 10 && (!CULL || inView((c.x0 + c.x1) / 2, (c.x1 - c.x0) / 2 + 88, c.ci * CL - 5, c.ci * CL + CL + 5, 0))) drawGroups(r, c.vbR, c.rg, ROCKS); }
  r.setPipeline(pTerr); r.setIndexBuffer(ibT, 'uint16');
  for (let k = 0; k < nvis; k++) { r.setVertexBuffer(0, VIS[k].vbT); r.drawIndexed(NTI); tris += NTI / 3; }
  r.setPipeline(pCard); r.setVertexBuffer(0, vbC); r.setIndexBuffer(ibC, 'uint32');
  for (let k = 0; k < nvis; k++) { const c = VIS[k]; if (VISD[k] <= 7) drawTrees(r, c, VISD[k], true, false); if (VISD[k] <= 3 && (!CULL || inView((c.x0 + c.x1) / 2, (c.x1 - c.x0) / 2 + 60, c.ci * CL - 2, c.ci * CL + CL + 2, 0))) drawGroups(r, c.vbU, c.ug, UGM); }
  r.setPipeline(pGrass);
  for (let k = 0; k < nvis; k++) {
    const c = VIS[k]; if (VISD[k] > 2 || !c.gn) continue;
    if (CULL) { // blades are gone by 80 m; the strip of grass is within 70 m of the trail
      const xa = c.x0 - 70, xb = c.x1 + 70, z0 = c.ci * CL - 2, z1 = z0 + CL + 4;
      rectDist(xa, xb, z0, z1); if (DMIN >= 80 || !inView((xa + xb) / 2, (xb - xa) / 2, z0, z1, 0)) continue;
    }
    r.setVertexBuffer(0, c.vbG); r.draw(9, c.gn); tris += 7 * c.gn;
  }
  r.setPipeline(pCrit); r.setVertexBuffer(0, vbCrit); r.draw(12, NCRIT);
  r.setPipeline(pSky); r.draw(3);
  r.setPipeline(pMote); r.setVertexBuffer(0, vbMote); r.draw(4, NMOTE);
  r.end();

  r = e.beginRenderPass(passRays); r.setPipeline(pRays); r.setBindGroup(0, bgRays); r.draw(3); r.end();
  r = e.beginRenderPass(passBlur); r.setPipeline(pBlur); r.setBindGroup(0, bgBlur); r.draw(3); r.end();
  for (let i = 0; i < bloomPass.length; i++) { const b = bloomPass[i]; r = e.beginRenderPass(b.desc); r.setPipeline(b.pipe); r.setBindGroup(0, b.bg); r.draw(3); r.end(); }
  passPost.colorAttachments[0].view = (CAP ? tCap : ctx.getCurrentTexture()).createView();
  r = e.beginRenderPass(passPost); r.setPipeline(pPost); r.setBindGroup(0, bgPost); r.draw(3); r.end();
  if (TSQ) { e.resolveQuerySet(tsSet, 0, 2, tsBuf, 0); if (!tsBusy) e.copyBufferToBuffer(tsBuf, 0, tsRead, 0, 16); }
  DQ.submit([e.finish()]);
  if (TSQ && !tsBusy) { tsBusy = true; tsRead.mapAsync(GPUMapMode.READ).then(() => { const a = new BigInt64Array(tsRead.getMappedRange()), ms = Number(a[1] - a[0]) / 1e6; if (ms > 0 && ms < 1000) gpuMs += (ms - gpuMs) * (gpuMs ? 0.08 : 1); tsRead.unmap(); tsBusy = false; }); }
}
// GPU time of a whole frame (shadow pass start to composite end), where the browser allows timestamp queries
let tsSet = null, tsBuf = null, tsRead = null, tsBusy = false, gpuMs = 0;
if (TSQ) {
  tsSet = device.createQuerySet({ type: 'timestamp', count: 2 });
  tsBuf = buf(16, BU.QUERY_RESOLVE | BU.COPY_SRC); tsRead = buf(16, BU.COPY_DST | BU.MAP_READ);
  passShadow.timestampWrites = { querySet: tsSet, beginningOfPassWriteIndex: 0 };
}

// ---------------------------------------------------------------- frame loop, HUD
const BNAME = ['Forest', 'Meadow', 'Alpine'];
let hudT = 0, hudS = '', fps = 60, statsOn = qs.has('stats');
const FIXDT = +(qs.get('dt') || 0); // test hook: fixed time step
const FRMAX = +(qs.get('frames') || 0); let frameN = 0; // test hook: stop after N frames
function frame(now) {
  if (!FRMAX || ++frameN < FRMAX) requestAnimationFrame(frame); else window.__done = true;
  const dt = FIXDT || min((now - last) / 1000, 0.1); last = now;
  if (!paused || !started) T += dt;
  resize();
  camera(paused ? 0 : dt);
  stream(Z);
  uniforms(dt);
  render();
  fps += (1 / max(dt, 1e-3) - fps) * 0.05;
  if (now - hudT > 300) {
    hudT = now;
    const b = BIO[0] > BIO[1] ? (BIO[0] > BIO[2] ? 0 : 2) : (BIO[1] > BIO[2] ? 1 : 2);
    const s = (walked / 1000).toFixed(2) + ' km  ·  ' + BNAME[b] + (b === 0 && BIO[3] > 0.5 ? ' in autumn' : '') + '  ·  ' + round(240 + elev(Z)) + ' m' + (auto ? '  ·  auto-walk' : '');
    if (s !== hudS) { hudS = s; $('hud').textContent = s; }
    syncButtons();
    if (statsOn) $('stats').textContent = fps.toFixed(0) + ' fps  ·  ' + W + '×' + H + '  ·  ' + Q.name + '  ·  ' + nvis + ' chunks' + (FAST ? '  ·  ' + (tris / 1e6).toFixed(2) + 'M tris' + (TSQ ? '  ·  GPU ' + gpuMs.toFixed(1) + ' ms' : '') + '  ·  culling ' + (CULL ? 'on' : 'off') + ' (O)' : '');
  }
}

// ---------------------------------------------------------------- input
const setKey = (code, v) => {
  if (code === 'KeyW' || code === 'ArrowUp') keys.f = v; else if (code === 'KeyS' || code === 'ArrowDown') keys.b = v;
  else if (code === 'ShiftLeft' || code === 'ShiftRight') keys.run = v; else if (code === 'KeyA' || code === 'ArrowLeft') keys.l = v; else if (code === 'KeyD' || code === 'ArrowRight') keys.r = v;
  else return false;
  return true;
};
function openMenu(open) { paused = open; audioQuiet(open); $('menu').classList.toggle('on', open); canvas.classList.toggle('blur', open); if (open) { keys.f = keys.b = keys.run = keys.l = keys.r = 0; } $('go').textContent = started ? 'Keep walking' : 'Start hiking'; }
function start() { started = true; openMenu(false); audioStart(); }
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape') { if (started) openMenu(!paused); return; }
  if (paused) { if (e.code === 'Enter' || e.code === 'Space') { start(); e.preventDefault(); } return; }
  if (setKey(e.code, 1)) { e.preventDefault(); if (e.code === 'KeyS' || e.code === 'ArrowDown') auto = false; return; }
  if (e.code === 'Space') { auto = !auto; e.preventDefault(); }
  else if (e.code === 'KeyM') audioMute();
  else if (e.code === 'KeyT') { tod = (tod + 1) % TOD.length; toast(TOD[tod].name); }
  else if (e.code === 'KeyO' && FAST) { CULL = !CULL; toast('Culling ' + (CULL ? 'on' : 'off')); }
  else if (e.code === 'KeyL') { lampOn = !lampOn; toast('Headlamp ' + (lampOn ? 'on' : 'off')); }
  else if (e.code === 'KeyH') { statsOn = !statsOn; $('stats').style.display = statsOn ? 'block' : 'none'; }
});
addEventListener('keyup', (e) => { setKey(e.code, 0); });
addEventListener('blur', () => { keys.f = keys.b = keys.run = keys.l = keys.r = 0; });
let drag = false, px0 = 0, py0 = 0;
canvas.addEventListener('pointerdown', (e) => { drag = true; px0 = e.clientX; py0 = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (!drag) return; lookY += (e.clientX - px0) * 0.0035; lookP = clamp(lookP - (e.clientY - py0) * 0.0035, -1.2, 1.2); px0 = e.clientX; py0 = e.clientY; lastLook = T; });
const endDrag = () => { drag = false; };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });
let toastT = 0;
function toast(s) { const t = $('toast'); t.textContent = s; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 1800); }
$('go').addEventListener('click', start);
// the two small corner buttons: sound and auto-walk (they never take keyboard focus, so Space keeps its meaning)
function syncButtons() { $('bs').classList.toggle('off', muted); $('ba').classList.toggle('on', auto); }
for (const [id, fn] of [['bs', () => audioMute()], ['ba', () => { if (started && !paused) auto = !auto; }]]) {
  $(id).addEventListener('pointerdown', (e) => e.preventDefault());
  $(id).addEventListener('click', () => { fn(); syncButtons(); });
}
$('mbtn').addEventListener('click', () => openMenu(true));
// touch buttons: hold to walk
for (const [id, key] of [['tf', 'f'], ['tb', 'b']]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { keys[key] = 1; auto = false; el.setPointerCapture(e.pointerId); e.preventDefault(); });
  el.addEventListener('pointerup', () => { keys[key] = 0; }); el.addEventListener('pointercancel', () => { keys[key] = 0; });
}
document.querySelectorAll('.q:not(.sp)').forEach((b, i) => {
  b.classList.toggle('sel', i === qi);
  b.addEventListener('click', () => { if (i === qi) return; try { localStorage.setItem('hikeQ', i); } catch (e) { } const u = new URL(location.href); u.searchParams.delete('q'); u.searchParams.set('z', Z.toFixed(0)); location.href = u.href; });
});
document.addEventListener('visibilitychange', () => { last = performance.now(); });

// ---------------------------------------------------------------- build the ring around the hiker (at load, and after a jump)
async function buildRing() {
  for (let t0 = performance.now(); ;) {
    const busy = stream(Z);
    let done = 0; for (const c of chunks) if (c.ready) done++;
    if (!busy && done === NCH) break;
    if (performance.now() - t0 > 30) { bar(0.25 + 0.75 * done / NCH); await tick(); t0 = performance.now(); }
  }
}
// start somewhere else: the loading screen covers the swap
let jumping = false;
async function jumpTo(kind) {
  if (jumping) return; jumping = true;
  document.querySelectorAll('.sp').forEach((b, i) => b.classList.toggle('sel', i === kind));
  $('load').classList.remove('off'); bar(0.25);
  await new Promise((r) => setTimeout(r, 450));
  Z = findStart(kind); spd = 0; lookY = lookP = 0; pitS = 0; yawS = atan2(trailDX(Z), 1); auto = false;
  for (const c of chunks) { c.ci = -1e9; c.ready = false; } gen = null;
  camera(0); BC[0] = CX; BC[1] = CY; BC[2] = CZ + 90;
  await buildRing();
  bar(1); $('load').classList.add('off'); jumping = false;
}
document.querySelectorAll('.sp').forEach((b, i) => b.addEventListener('click', () => jumpTo(i)));
resize(); camera(0); BC[0] = CX; BC[1] = CY; BC[2] = CZ + 90;
await buildRing();
bar(1);
last = performance.now();
uniforms(0.016); render();
await DQ.onSubmittedWorkDone();
$('load').classList.add('off'); canvas.classList.add('blur');
openMenu(true);
requestAnimationFrame(frame);
if (qs.has('go')) { start(); if (qs.has('auto')) auto = true; }
if (statsOn) $('stats').style.display = 'block';
window.__ready = true;
