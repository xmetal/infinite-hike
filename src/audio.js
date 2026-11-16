// ============================================================================
// audio: a synthesized outdoor soundscape (no sample files)
// ============================================================================
// A fixed Web Audio graph built on the first click, steered by a 10 Hz timer (not the frame loop).
// Layers: wind, leaf rustle, birdsong (several kinds), a woodpecker, meadow insects, a hawk in the mountains,
// and footsteps that follow the walking pace and the ground underfoot.
let AC = null, OUT = null, STEP = null, muted = false;
const VOL = 0.8;
function mkSound(ac) {
  const sr = ac.sampleRate, rnd = Math.random, rr = (a, b) => a + (b - a) * rnd();
  const N = (C, o, ...to) => { const n = new C(ac, o); for (const d of to) n.connect(d); if (n.start) n.start(); return n; };
  const Gn = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, ...to) => N(BiquadFilterNode, { type, frequency, Q }, ...to);
  const lfo = (frequency, depth, to) => N(OscillatorNode, { frequency }, Gn(depth, to));
  const noise = (secs, f) => { const n = (sr * secs) | 0, b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr }); f(b.getChannelData(0), n); f(b.getChannelData(1), n); return b; };
  // seamless noise loops: pink-ish for wind, white for leaves and steps
  const loopN = (secs, step) => noise(secs, (d, n) => { let b = 0; const X = 4096; for (let i = 0; i < n + X; i++) { const v = step(b); b = v; if (i < n) d[i] = v; else { const k = (i - n) / X; d[i - n] = d[i - n] * k + v * (1 - k); } } });
  const nbrown = loopN(41, (b) => (b + 0.03 * (rnd() * 2 - 1)) / 1.03), nwhite = loopN(13, () => rnd() * 2 - 1);
  // a soft outdoor reverb: short, bright, with a pre-delay
  const ir = noise(1.6, (d, n) => { for (let i = 0; i < n; i++) { const t = i / sr; d[i] = (rnd() * 2 - 1) * exp(-t * 4.5) * (t < 0.02 ? 0 : 1) * (1 + 2 * exp(-t * 30)); } });
  const lim = N(DynamicsCompressorNode, { threshold: -8, knee: 8, ratio: 12, attack: 0.004, release: 0.25 }, ac.destination);
  const out = OUT = Gn(0, lim), wet = N(ConvolverNode, { buffer: ir }, Gn(0.5, out));
  const src = (buffer, playbackRate, ...to) => N(AudioBufferSourceNode, { buffer, loop: true, playbackRate }, ...to);

  // wind: a low body and a wandering whistle band, from one 41 s noise loop played at two unrelated speeds
  // (the pair only lines up again after about half an hour). Gusts are not a cycle: the timer below picks a new
  // random strength and pitch every few seconds and glides there.
  const wind = Gn(0.025, out), gust = Gn(0.5, wind);
  src(nbrown, 1, BQ('lowpass', 420, 0.5, Gn(7, gust)));
  const wf = BQ('bandpass', 620, 1.1, Gn(2.2, gust)); src(nbrown, 0.737, wf);
  lfo(0.11, 0.06, gust.gain);
  // leaves: a soft, breathy rustle rather than a hiss. It uses the wind's own dark noise, played faster so it sits
  // around 1-3 kHz, with the top rounded off; it stays well under the wind and swells with the same gusts.
  const leaf = Gn(0, out), lg = Gn(0.3, leaf);
  src(nbrown, 3.1, BQ('bandpass', 1700, 0.6, BQ('lowpass', 3200, 0.5, Gn(2, lg))));
  src(nbrown, 4.3, BQ('bandpass', 2600, 0.9, Gn(1.2, lg)));
  // meadow insects: a few crickets, each with its own pitch, place and loudness. Nothing here runs on a cycle: the
  // timer below gives each one bouts of chirps (2-4 quick pulses each) with uneven gaps, then a rest of random length.
  const bug = Gn(0, out);
  const crickets = Array.from({ length: 4 }, (_, k) => {
    const p = N(StereoPannerNode, { pan: rr(-0.9, 0.9) }, bug), g = Gn(0, p), f = rr(3900, 4900);
    N(OscillatorNode, { frequency: f }, g); N(OscillatorNode, { frequency: f * 1.031 }, Gn(0.5, g));
    return { g, next: 0, left: 0, vol: 0, rate: 0, pulses: 3, first: 1 + k * 2.5 };
  });
  const shim = Gn(0.05, bug); src(nwhite, 1.3, BQ('bandpass', 7800, 9, shim));
  // pooled voices for bird calls: oscillator -> envelope -> pan -> dry + reverb
  const pool = (n, type) => Array.from({ length: n }, () => { const p = N(StereoPannerNode, {}, out, wet), g = Gn(0, p); return { p, g, o: N(OscillatorNode, { type }, g) }; });
  const birds = pool(5, 'sine'), harsh = pool(2, 'sawtooth');
  // one note on voice v: pitch glides f0 -> f1 over dur
  const note = (v, t, f0, f1, dur, vol, att = 0.012) => {
    const f = v.o.frequency, g = v.g.gain;
    f.setValueAtTime(f0, t); f.exponentialRampToValueAtTime(f1, t + dur);
    g.setValueAtTime(0, t); g.linearRampToValueAtTime(vol, t + att); g.setValueAtTime(vol, t + dur * 0.7); g.linearRampToValueAtTime(0, t + dur);
  };
  const take = (vs, pan) => { const v = vs.shift(); vs.push(v); v.p.pan.setValueAtTime(pan, ac.currentTime); return v; };
  // birdsong, each returns its length in seconds. d = distance (quieter and further off-axis sounds the same here)
  const SONGS = [
    (t, v, d) => { const f = rr(3300, 4100); note(v, t, f, f * 0.98, 0.34, 0.05 * d); note(v, t + 0.42, f * 0.84, f * 0.83, 0.4, 0.05 * d); return 0.9; }, // two-note whistle
    (t, v, d) => { const n = 7 + (rnd() * 8 | 0), f = rr(2600, 3600), dt = rr(0.07, 0.1); for (let k = 0; k < n; k++) note(v, t + k * dt, f * (1 + 0.5 * (k % 2)), f * 1.5, dt * 0.8, 0.035 * d, 0.006); return n * dt; }, // trill
    (t, v, d) => { let tt = t; const n = 4 + (rnd() * 4 | 0); for (let k = 0; k < n; k++) { const f = rr(1900, 3400), l = rr(0.09, 0.2); note(v, tt, f, f * rr(0.7, 1.5), l, 0.045 * d); tt += l + rr(0.03, 0.12); } return tt - t; }, // warbling phrase
    (t, v, d) => { const f = rr(4200, 5200); for (let k = 0; k < 3; k++) note(v, t + k * 0.16, f, f * 0.72, 0.1, 0.03 * d, 0.004); return 0.5; }, // thin "tsee tsee tsee"
    (t, v, d) => { note(v, t, 690, 670, 0.22, 0.06 * d, 0.03); note(v, t + 0.34, 545, 530, 0.3, 0.06 * d, 0.03); return 0.7; }, // cuckoo
    (t, v, d) => { const f = rr(1500, 2100), n = 3 + (rnd() * 3 | 0); for (let k = 0; k < n; k++) note(v, t + k * 0.28, f, f * 1.25, 0.2, 0.04 * d, 0.05); return n * 0.28; }, // rising coos
  ];
  // footsteps: two noise bursts (heel, toe) through a filter that depends on the ground
  const stepG = Gn(0, out), stepF = BQ('bandpass', 900, 0.8, stepG), stepL = BQ('lowpass', 260, 0.7, Gn(1.3, stepG));
  src(nwhite, 1.21, stepF, stepL);
  STEP = (pace) => {
    const t = ac.currentTime + 0.01, f = 700 * BIO[0] + 480 * BIO[1] + 1900 * BIO[2], v = (0.05 + 0.03 * min(pace / 6, 1)) * (0.8 + 0.4 * rnd()) * (1 + 0.6 * BIO[2]);
    stepF.frequency.setValueAtTime(f * rr(0.85, 1.2), t); stepF.Q.setValueAtTime(0.6 + 1.2 * BIO[2], t);
    const g = stepG.gain; g.cancelScheduledValues(t); g.setValueAtTime(0, t); g.linearRampToValueAtTime(v, t + 0.012); g.exponentialRampToValueAtTime(v * 0.25, t + 0.07);
    g.linearRampToValueAtTime(v * 0.6, t + 0.1); g.exponentialRampToValueAtTime(0.0005, t + 0.24); g.setValueAtTime(0, t + 0.25);
  };
  // woodpecker: a quick run of knocks
  const knockG = Gn(0, N(StereoPannerNode, { pan: -0.4 }, out, wet)); src(nwhite, 0.9, BQ('bandpass', 1150, 5, knockG));
  let tGust = 0, lt = ac.currentTime, tBird = lt + 2, tBird2 = lt + rr(8, 20), tPeck = lt + rr(40, 120), tHawk = lt + rr(40, 120);
  out.gain.setTargetAtTime(VOL, lt, 0.8);
  return () => {
    const now = ac.currentTime, t = now + 0.06; if (now <= lt) return; lt = now;
    const F = BIO[0], M = BIO[1], A = BIO[2];
    wind.gain.setTargetAtTime(0.25 * (0.075 + 0.04 * M + 0.2 * A + 0.012 * min(abs(spd), 6)), t, 1.5); // wind alone, halved twice from its first level
    if (t > tGust) { // next gust or lull: mostly gentle, now and then a strong one; the leaves follow the same swell
      const lvl = 0.2 + 0.8 * pow(rnd(), 1.7), tc = rr(1.2, 4);
      gust.gain.setTargetAtTime(lvl, t, tc); lg.gain.setTargetAtTime(0.2 + 0.75 * lvl, t + rr(0, 0.6), tc);
      wf.frequency.setTargetAtTime(rr(380, 700) + 380 * lvl, t, tc * 1.5); wf.Q.setTargetAtTime(rr(0.7, 1.8), t, 3);
      tGust = t + rr(2.5, 11);
    }
    leaf.gain.setTargetAtTime(0.085 * F + 0.025 * M + 0.01 * A, t, 1.5); // a quiet background rustle
    bug.gain.setTargetAtTime(0.6 * M * M, t, 2);
    if (M > 0.05) for (const c of crickets) {
      if (!c.next) c.next = t + c.first;
      if (t < c.next) continue;
      if (c.left <= 0) { // start a new bout: how many chirps, how loud, how fast, how many pulses per chirp
        c.left = 3 + (rnd() * 14 | 0); c.vol = rr(0.006, 0.02); c.rate = rr(0.028, 0.04); c.pulses = 2 + (rnd() * 3 | 0);
      }
      const g = c.g.gain;
      for (let k = 0; k < c.pulses; k++) { const tt = t + k * c.rate * rr(0.94, 1.06); g.setValueAtTime(0, tt); g.linearRampToValueAtTime(c.vol * rr(0.7, 1), tt + 0.004); g.linearRampToValueAtTime(0, tt + c.rate * 0.6); }
      c.left--;
      c.next = t + c.pulses * c.rate + (c.left > 0 ? rr(0.25, 0.75) : rr(8, 48)); // a short gap, or a long rest after the bout
    }
    // animal sounds are occasional details, not a constant chorus: long, uneven gaps between them
    const life = F + 0.7 * M + 0.12 * A; // how much birdsong
    if (t > tBird) { if (rnd() < life) { const d = rr(0.35, 1); const l = SONGS[(rnd() * (F > 0.4 ? 6 : 4)) | 0](t, take(birds, rr(-0.8, 0.8)), d); tBird = t + l + rr(1.6, 14) / max(life, 0.2); } else tBird = t + rr(4, 16); }
    if (t > tBird2) { if (rnd() < life) { const d = rr(0.2, 0.6); SONGS[(rnd() * 4) | 0](t, take(birds, rr(-0.9, 0.9)), d); } tBird2 = t + rr(12, 36); }
    if (t > tPeck) { if (F > 0.5) { const g = knockG.gain, n = 9 + (rnd() * 8 | 0); for (let k = 0; k < n; k++) { const tt = t + k * 0.047; g.setValueAtTime(0.5 * (1 - k / n * 0.5), tt); g.exponentialRampToValueAtTime(0.001, tt + 0.03); } } tPeck = t + rr(72, 200); }
    if (t > tHawk) { if (A + M * 0.4 > 0.5) { const v = take(harsh, rr(-0.5, 0.5)); note(v, t, 2700, 1750, 0.95, 0.02, 0.06); } tHawk = t + rr(100, 240); }
  };
}
function audioStart() {
  if (!AC) { try { AC = new AudioContext({ latencyHint: 'playback' }); setInterval(mkSound(AC), 100); } catch (e) { console.warn('audio unavailable', e); AC = null; return; } }
  if (AC.state === 'suspended') AC.resume();
}
function audioStep(pace) { if (STEP && !muted && !quiet) STEP(pace); }
// everything goes silent while muted or while the menu is up
let quiet = false;
const setLevel = () => { if (AC) { OUT.gain.cancelScheduledValues(AC.currentTime); OUT.gain.setTargetAtTime(muted || quiet ? 0 : VOL, AC.currentTime, 0.08); } };
function audioMute() { if (!AC) return; muted = !muted; setLevel(); toast(muted ? 'Sound off' : 'Sound on'); }
function audioQuiet(q) { quiet = q; setLevel(); }
document.addEventListener('visibilitychange', () => { if (AC) document.hidden ? AC.suspend() : AC.resume(); });
