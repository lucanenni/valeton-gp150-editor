/*
 * Deterministic synthetic (reference, recorded) pair for the profiler tests.
 * Shaped like a real profiling session (0-5 s rising-level ramp, then
 * broadband material) but made of seeded noise, so nothing proprietary is
 * needed. The "amp" is an asymmetric soft clipper followed by a one-pole
 * low-pass; both signals are quantized to 16 bit so they can be written to
 * WAV files and fed to other implementations bit-identically.
 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const q16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))) / 32768;

export function makeSignals(sr = 48000, seconds = 70, opts = {}) {
  const { seed = 12345, gain = 6, asym = 0.7, lp = 0.35, delay = 0 } = opts;
  const n = sr * seconds, rnd = mulberry32(seed);
  const x = new Float32Array(n), y = new Float32Array(n);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const white = rnd() * 2 - 1;
    s1 += 0.5 * (white - s1); s2 += 0.05 * (white - s2);
    const level = i < 5 * sr ? (i / (5 * sr)) : 1;               // level ramp in the first 5 s
    x[i] = q16(0.5 * level * (0.7 * s1 + 1.6 * s2));
  }
  let lpState = 0;
  for (let i = 0; i < n; i++) {
    const xi = i >= delay ? x[i - delay] : 0, u = gain * xi;
    const w = u >= 0 ? Math.tanh(u) : asym * Math.tanh(u / asym);
    lpState += lp * (w - lpState);
    y[i] = q16(0.8 * lpState);
  }
  return { x, y };
}
