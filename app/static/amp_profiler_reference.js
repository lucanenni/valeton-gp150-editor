"use strict";
/*
 * amp_profiler_reference.js -- the 70 s test signal for the amp profiler, generated
 * here (deterministic, nothing is bundled or copied).
 *
 * The profiler (amp_profiler.js) expects a signal with a fixed layout and
 * level plan; every section below serves one stage of it:
 *
 *    0 -  5 s   300 Hz tone, level ramp -60 -> 0 dBFS   waveshaper (clipping curve) fit
 *    6 s        click (+1/-1 pair on a 44.1 kHz grid)    first transfer-function estimate
 *    6 - 21 s   low-level noise, 1 Hz amplitude wobble   (rms 0.3e-3 .. 1.2e-3, ~ -62 dBFS)
 *   23 - 28 s   log sweep 22 Hz -> 11.5 kHz, -3 dBFS     second estimate
 *   30 - 50 s   20 Hz -> 20 kHz log chirp each second,    iterative IR fit
 *               gated by 6 decaying bursts per second, rising slowly (-28 -> -25 dBFS rms)
 *   50 - 70 s   synthetic plucked-string playing,         spectral correction on "real" material
 *               long-term spectrum shaped like guitar
 *
 * Authored at 44.1 kHz and converted to 48 kHz with the same resampler used
 * for user files, so the whole signal has the band limit the profiler is used to.
 * Compared with profiles made by Valeton Suite from real NAM models, profiles
 * built from this signal land within the run-to-run spread of the profiler
 * itself (about +-1 dB level, ~2 dB rms ripple, mostly above 8 kHz).
 */
(function (root) {
  const CL = root.AmpProfilerDsp || (typeof require !== "undefined" ? require("./amp_profiler_dsp.js").AmpProfilerDsp : null);
  const PR = root.AmpProfiler || (typeof require !== "undefined" ? require("./amp_profiler.js").AmpProfiler : null);
  if (!CL || !PR) throw new Error("amp_profiler_dsp.js and amp_profiler.js must be loaded first");

  const SR_AUTHOR = 44100, SR_OUT = 48000, SECONDS = 70;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Long-term spectrum of the playing section: dB per 1/3-octave band, applied to the raw plucks.
  const GUITAR_EQ = [[40, 10.4], [50, 12.9], [63, 12.1], [80, 8], [101, 9.3], [127, 5.8], [160, 5.9], [202, 6.5], [254, 5.5], [320, 6.8], [403, 4], [508, 2.1], [640, 1.3], [806, -0.4], [1016, -3], [1280, -4.3], [1613, -4.7], [2032, -4.4], [2560, -4.8], [3225, -5.3], [4064, -9.3], [5120, -13.6], [6451, -17], [8127, -19.9], [10240, -24.1], [12902, -27.4], [16255, -32.3]];

  function applyEq(g, sr, table) {
    let N = 1; while (N < g.length) N <<= 1;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < g.length; i++) re[i] = g[i];
    CL.fft(re, im, false);
    const gainDb = (f) => {
      if (f <= table[0][0]) return table[0][1];
      for (let k = 0; k < table.length - 1; k++) {
        if (f < table[k + 1][0]) return table[k][1] + (table[k + 1][1] - table[k][1]) * Math.log(f / table[k][0]) / Math.log(table[k + 1][0] / table[k][0]);
      }
      return table[table.length - 1][1];
    };
    for (let k = 0; k <= N / 2; k++) {
      const gn = k * sr / N < 20 ? 0 : Math.pow(10, gainDb(k * sr / N) / 20);
      re[k] *= gn; im[k] *= gn;
      if (k > 0 && k < N / 2) { re[N - k] *= gn; im[N - k] *= gn; }
    }
    CL.fft(re, im, true);
    const out = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = re[i];
    return out;
  }

  // Generates the reference: Float32Array, 48 kHz mono, 70 s. `seed` only changes the noise/playing.
  function generate(seed) {
    const sr = SR_AUTHOR, n = SECONDS * sr, x = new Float32Array(n), rnd = mulberry32(seed == null ? 7 : seed);
    const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };

    // 0-5 s: 300 Hz tone, 30 dB/s from -60 dBFS to -30 dBFS (first second), then 7.5 dB/s up to 0 dBFS
    for (let i = 0; i < 5 * sr; i++) {
      const t = i / sr, db = t < 1 ? -60 + 30 * t : -30 + 7.5 * (t - 1);
      x[i] = Math.min(0.9993, Math.pow(10, db / 20)) * Math.sin(2 * Math.PI * 300 * t);
    }
    // 6 s: click
    x[6 * sr] = 1; x[6 * sr + 1] = -1;
    // 6.1-21 s: noise with a 1 Hz amplitude wobble
    for (let i = Math.round(6.1 * sr); i < 21 * sr; i++) {
      const t = i / sr;
      x[i] = 1e-4 * (7.35 + 4.45 * Math.cos(2 * Math.PI * (t - 7.21))) * gauss();
    }
    // 23-28 s: log sweep (x3.5 per second), constant level
    {
      const k = Math.log(3.5), f0 = 22.04;
      for (let i = 23 * sr; i < 28 * sr; i++) x[i] = 0.5657 * Math.sin(2 * Math.PI * f0 / k * (Math.exp(k * (i / sr - 23)) - 1));
    }
    // 30-50 s: 20 Hz -> 20 kHz log chirp per second, gated by six decaying bursts per second
    {
      const k = Math.log(1000), f0 = 20, tau = 0.073, T = 1 / 6;
      for (let s = 0; s < 20; s++) {
        const rms = 0.0378 + (0.0585 - 0.0378) * s / 19, amp = rms / 0.329;   // 0.329 = rms of the gated envelope
        for (let i = 0; i < sr; i++) {
          const t = i / sr, g = t % T, env = Math.exp(-g / tau) * Math.min(1, g / 0.003);
          x[(30 + s) * sr + i] = amp * env * Math.sin(2 * Math.PI * f0 / k * (Math.exp(k * t) - 1));
        }
      }
    }
    // 50-70 s: plucked strings (Karplus-Strong), strummed chords and single notes
    {
      const len = 20 * sr, g = new Float32Array(len), strings = [82.41, 110, 146.83, 196, 246.94, 329.63];
      const pluck = (start, f, amp, decay, bright) => {
        const N = Math.round(sr / f), buf = new Float64Array(N); let lp = 0;
        for (let i = 0; i < N; i++) { lp += bright * (gauss() - lp); buf[i] = lp; }
        let idx = 0; const cnt = Math.min(len - start, Math.round(sr * decay));
        for (let i = 0; i < cnt; i++) { const j = (idx + 1) % N, v = buf[idx]; buf[idx] = 0.5 * (buf[idx] + buf[j]) * 0.9985; g[start + i] += amp * v; idx = j; }
      };
      const chords = [[0, 2, 2, 1, 0, 0], [0, 0, 2, 2, 2, 0], [-1, 2, 2, 0, 0, 0], [3, 2, 0, 0, 0, 3], [0, 2, 2, 1, 0, 0], [-1, 0, 2, 2, 1, 0]];
      let t = 0.1, ci = 0;
      while (t < 19.4) {
        if (rnd() < 0.7) {
          const ch = chords[ci++ % chords.length], dir = rnd() < 0.5 ? 1 : -1; let off = 0;
          for (let s = 0; s < 6; s++) {
            const si = dir > 0 ? s : 5 - s; if (ch[si] < 0) continue;
            pluck(Math.round((t + off) * sr), strings[si] * Math.pow(2, ch[si] / 12), 0.6 + 0.3 * rnd(), 1.4, 0.25 + 0.4 * rnd());
            off += 0.008 + 0.01 * rnd();
          }
          t += 0.7 + 0.5 * rnd();
        } else {
          const si = Math.floor(rnd() * 6);
          pluck(Math.round(t * sr), strings[si] * Math.pow(2, Math.floor(rnd() * 8) / 12), 0.9, 0.9, 0.4 + 0.4 * rnd());
          t += 0.25 + 0.25 * rnd();
        }
      }
      const shaped = applyEq(g, sr, GUITAR_EQ);
      let e = 0, pk = 0;
      for (let i = 0; i < len; i++) { e += shaped[i] * shaped[i]; pk = Math.max(pk, Math.abs(shaped[i])); }
      const sc = Math.min(0.13 / Math.sqrt(e / len), 0.9 / pk);
      for (let i = 0; i < len; i++) x[50 * sr + i] = shaped[i] * sc;
    }
    for (let i = 0; i < n; i++) x[i] = Math.fround(Math.max(-1, Math.min(1, x[i])));
    return PR.resample(x, SR_AUTHOR, SR_OUT);
  }

  // 16-bit mono WAV file bytes (for playing the reference through an amp)
  function toWav16(samples, sampleRate) {
    const n = samples.length, buf = new ArrayBuffer(44 + 2 * n), dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + 2 * n, true); str(8, "WAVE"); str(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, 2 * n, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
    return new Uint8Array(buf);
  }

  let cached = null;
  root.AmpProfilerReference = {
    SAMPLE_RATE: SR_OUT,
    SAMPLES: SECONDS * SR_OUT,
    generate,
    get() { return cached || (cached = generate(7)); },     // the reference the app uses
    toWav16,
  };
})(typeof self !== "undefined" ? self : this);
