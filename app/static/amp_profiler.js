"use strict";
/*
 * amp_profiler.js -- amp-profiling pipeline for the GP-150's SnapTone format (GP150-9):
 * (reference X, recorded Y) at 48 kHz  ->  SnapTone/"tone catch" .clo payload.
 *
 * Structure (Hammerstein-style profiler):
 *   1. detrend Y, find the onset of the reference in Y
 *   2. fit a static exponential waveshaper from the 0-5 s level ramp
 *      (peaks + 1.2 x LS slope/peak, stored in the .clo header)
 *   3. model = 4x IIR up -> waveshaper -> 4x IIR down -> 20 Hz high-pass;
 *      estimate transfer functions T (region 6 s + 15 s) and P (23 s + 5 s)
 *   4. three rounds of the iterative amp-coefficient fit (`iterativeAmpFit`)
 *      producing a 128-tap min-phase IR1 and a 2048-tap min-phase IR2
 *   5. post stage on the 50-70 s guitar segment: spectral correction IR3
 *      (256 taps) folded into IR2, mean removed, energy matched
 *   6. resample IR1/IR2 to 44.1 kHz, assemble header, CRC.
 *
 * Every stage was checked against reference output on identical inputs
 * (see app/tests/test_amp_profiler_js.mjs for the golden checks).
 * Float32 rounding is emulated where it affects results.
 */
(function (root) {
  const C = root.AmpProfilerDsp || (typeof require !== "undefined" ? require("./amp_profiler_dsp.js").AmpProfilerDsp : null);
  if (!C) throw new Error("amp_profiler_dsp.js must be loaded first");
  const F = Math.fround;
  const SCRIPT_BASE = (typeof document !== "undefined" && document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/[^/]*$/, "") : null;
  const EPS = 1.1920928955078125e-7;

  // ---- constant tables (half-band all-pass sections, 50-tap pre-FIR) ----
  const TAB = {
    upCounts: [7, 5, 4, 4], downCounts: [6, 4, 3, 3],
    up: [0.04572814702987671, 0.3325011134147644, 0.6632020473480225, 0.9338558316230774, 0.16808754205703735, 0.5044857263565063, 0.8037808537483215, 0.05423077940940857, 0.3987969756126404, 0.8629178404808044, 0.19969958066940308, 0.6210968494415283, 0.0, 0.0, 0.079866424202919, 0.5453236699104309, 0.28382933139801025, 0.8344119191169739, 0.0, 0.0, 0.0, 0.079866424202919, 0.5453236699104309, 0.28382933139801025, 0.8344119191169739, 0.0, 0.0, 0.0],
    down: [0.05421752482652664, 0.3830873370170593, 0.7487209439277649, 0.19679796695709229, 0.5731363892555237, 0.9142937064170837, 0.07076594978570938, 0.5131675601005554, 0.25785309076309204, 0.8173173666000366, 0.0, 0.0, 0.11447494477033615, 0.7699431777000427, 0.39783668518066406, 0.0, 0.0, 0.0, 0.11447494477033615, 0.7699431777000427, 0.39783668518066406, 0.0, 0.0, 0.0],
  };
  const FIR50_48K = [2.3698089122772217, 3.5321993827819824, 3.3860063552856445, 0.5711528062820435, -2.4945120811462402, -3.850381851196289, -3.1638450622558594, -1.5117536783218384, -0.5816931128501892, -0.1761655956506729, -0.15376220643520355, 0.26627060770988464, 0.4051620066165924, 0.38954851031303406, 0.11378289759159088, 0.15367279946804047, 0.26046958565711975, 0.3561989963054657, 0.20228299498558044, -0.01788109913468361, -0.05925950035452843, -0.030525999143719673, 0.07328040152788162, -0.03879399970173836, -0.020572500303387642, 0.020949900150299072, 0.08917230367660522, -0.0006698999786749482, 0.03298040106892586, 0.019076799973845482, 0.09519950300455093, 0.09397300332784653, -0.026918400079011917, -0.028186000883579254, 0.0035335998982191086, 0.08518820255994797, -0.02848079986870289, -0.0766185000538826, -0.08217039704322815, 0.012975700199604034, 0.05085289850831032, -0.062274299561977386, -0.12234269827604294, -0.022081099450588226, 0.08036129921674728, -0.020143000409007072, -0.0981329008936882, -0.0581544004380703, -0.0032508999574929476, 0.03926600143313408];
  // post-stage high-pass biquad (b0 b1 b2 a1 a2) at 48 kHz
  const POST_BIQUAD_48K = [0.99630439281463623, -1.9926087856292725, 0.99630439281463623, -1.9925950765609741, 0.9926224946975708];
  const SR = 48000;

  // ---------------------------------------------------------------- DSP blocks
  function upX2(inp, n, ns, coeffs, coff, state, soff) {
    const out = new Float32Array(2 * n), nA = ns - (ns >> 1);
    for (let i = 0; i < n; i++) {
      let v = inp[i];
      for (let k = 0; k < nA; k++) { const c = coeffs[coff + k], y = F(c * v + state[soff + k]); state[soff + k] = F(v - c * y); v = y; }
      out[2 * i] = v;
      v = inp[i];
      for (let k = nA; k < ns; k++) { const c = coeffs[coff + k], y = F(c * v + state[soff + k]); state[soff + k] = F(v - c * y); v = y; }
      out[2 * i + 1] = (ns === nA) ? inp[i] : v;
    }
    return out;
  }
  function downX2(inp, nOut, ns, coeffs, coff, state, soff, delay) {
    const out = new Float32Array(nOut), nA = ns - (ns >> 1);
    for (let i = 0; i < nOut; i++) {
      let a = inp[2 * i];
      for (let k = 0; k < nA; k++) { const c = coeffs[coff + k], y = F(c * a + state[soff + k]); state[soff + k] = F(a - c * y); a = y; }
      let b = inp[2 * i + 1];
      for (let k = nA; k < ns; k++) { const c = coeffs[coff + k], y = F(c * b + state[soff + k]); state[soff + k] = F(b - c * y); b = y; }
      if (ns === nA) b = inp[2 * i + 1];
      out[i] = F(F(a + delay[0]) * 0.5); delay[0] = b;
    }
    return out;
  }
  function nonlinear(x, nl) {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = x[i], pos = v > 0;
      const coefA = pos ? -nl.aPos : nl.aNeg, coefB = pos ? nl.posPeak : -nl.negPeak;
      out[i] = F(F(1 - F(Math.exp(F(coefA * v)))) * coefB);
    }
    return out;
  }
  function biquad(x, set) {
    const out = new Float32Array(x.length); let w1 = 0, w2 = 0;
    const b0 = set[0], b1 = set[1], b2 = set[2], a1 = set[3], a2 = set[4];
    for (let i = 0; i < x.length; i++) {
      const w = -a1 * w1 - a2 * w2 + x[i] * 1000;
      out[i] = F(F(b0 * w + b1 * w1 + b2 * w2) * 0.001);
      w2 = w1; w1 = w;
    }
    return out;
  }
  // causal convolution truncated to the input length (FFT overlap-add, float64)
  function convolve(x, h) {
    const n = x.length, L = h.length; let nf = 1; while (nf < 2 * L) nf <<= 1;
    const B = nf - L + 1, out = new Float32Array(n);
    const hr = new Float64Array(nf), hi = new Float64Array(nf); for (let i = 0; i < L; i++) hr[i] = h[i]; C.fft(hr, hi, false);
    const acc = new Float64Array(n + nf);
    const xr = new Float64Array(nf), xi = new Float64Array(nf);
    for (let s = 0; s < n; s += B) {
      const m = Math.min(B, n - s); xr.fill(0); xi.fill(0);
      for (let i = 0; i < m; i++) xr[i] = x[s + i];
      C.fft(xr, xi, false);
      for (let k = 0; k < nf; k++) { const r = xr[k] * hr[k] - xi[k] * hi[k], im = xr[k] * hi[k] + xi[k] * hr[k]; xr[k] = r; xi[k] = im; }
      C.fft(xr, xi, true);
      for (let i = 0; i < m + L - 1; i++) acc[s + i] += xr[i];
    }
    for (let i = 0; i < n; i++) out[i] = F(acc[i]);
    return out;
  }
  function modelChain(x, ctx) {
    const n = x.length, upS = new Float32Array(64), dnS = new Float32Array(64), dly1 = new Float32Array(1), dly2 = new Float32Array(1);
    const up1 = upX2(x, n, TAB.upCounts[0], TAB.up, 0, upS, 0);
    const up2 = upX2(up1, 2 * n, TAB.upCounts[1], TAB.up, 7, upS, 7);
    const nl = nonlinear(up2, ctx.nl);
    const dn1 = downX2(nl, 2 * n, TAB.downCounts[1], TAB.down, 6, dnS, 6, dly1);
    const dn2 = downX2(dn1, n, TAB.downCounts[0], TAB.down, 0, dnS, 0, dly2);
    return biquad(dn2, ctx.post);
  }

  // ---------------------------------------------------------------- front stage
  function detrend(y, n) {
    const out = Float32Array.from(y.subarray(0, n)); let s = 0;
    for (let i = 0; i < n; i++) s = F(s + out[i]);
    const mean = F(s / n); for (let i = 0; i < n; i++) out[i] = F(out[i] - mean);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const t = F(i + 1), v = out[i]; sx = F(sx + t); sy = F(sy + v); sxx = F(sxx + F(t * t)); sxy = F(sxy + F(t * v)); }
    const slope = F(F(F(sxy * n) - F(sy * sx)) / F(F(sxx * n) - F(sx * sx)));
    const icpt = F(F(sy - F(sx * slope)) / n);
    for (let i = 0; i < n; i++) out[i] = F(out[i] - F(F(slope * F(i + 1)) + icpt));
    return out;
  }
  function prepare(X, Yraw) {
    const n = Math.floor(70 * SR + 600);
    const Yp = new Float32Array(n); Yp.set(Yraw.subarray(0, Math.min(n, Yraw.length)));
    const Y = detrend(Yp, n);
    let onset = 600; for (let j = 0; j < 600; j++) if (Math.abs(Y[6 * SR + j]) > 0.01) { onset = j; break; }
    return { Y, onset };
  }
  // static waveshaper coefficients from the 0-5 s level ramp
  function fitWaveshaper(X, Y, onset) {
    const blk = F(SR * 0.1), nb = Math.floor(F(F(5 * SR) / blk));
    const A = new Float32Array(nb), B = new Float32Array(nb), Cn = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const j0 = Math.trunc(F(b * blk)), j1 = Math.trunc(F((b + 1) * blk));
      for (let j = j0; j < j1; j++) { const a = Math.abs(X[j]); if (a > A[b]) A[b] = a; const v = Y[j + onset]; if (v > B[b]) B[b] = v; if (v < Cn[b]) Cn[b] = v; }
    }
    let posPeak = 0, negPeak = 0; for (let b = 0; b < nb; b++) { posPeak = Math.max(posPeak, B[b]); negPeak = Math.max(negPeak, -Cn[b]); }
    let np = 0; for (let i = 0; i < nb; i++) if (0.5 * posPeak <= B[i]) { np = i + 1; break; }
    let nn = 0; for (let i = 0; i < nb; i++) if (Cn[i] <= -0.5 * negPeak) { nn = i + 1; break; }
    let sp = 0, sn = 0, a2p = 0, a2n = 0;
    for (let i = 0; i < np; i++) { sp += A[i] * B[i]; a2p += A[i] * A[i]; }
    for (let i = 0; i < nn; i++) { sn += -Cn[i] * A[i]; a2n += A[i] * A[i]; }
    return { posPeak: F(posPeak), negPeak: F(negPeak), aPos: F(1.2 * (sp / a2p) / posPeak), aNeg: F(1.2 * (sn / a2n) / negPeak) };
  }
  function buildTP(tf1mag, tf2mag, nb) {
    let p = Float32Array.from(C.smoothdata(tf2mag, nb, 1)); p = Float32Array.from(C.smoothdata(p, nb, 5));
    let mx = 0; for (let i = 0; i < nb; i++) if (tf1mag[i] > mx) mx = tf1mag[i];
    const f = F(mx * 0.001), f2 = F(f + f), k = F(F(f2 - f) / F(f2 * f2));
    for (let i = 0; i < nb; i++) if (p[i] < f2) p[i] = F(F(F(k * p[i]) * p[i]) + f);
    const T = new Float32Array(nb); for (let i = 0; i < nb; i++) T[i] = F((tf1mag[i] * 1e6) / (p[i] * 1e6 + EPS));
    return { T, P: p };
  }

  // ---------------------------------------------------------------- iterativeAmpFit
  function makeGrid512() {
    const a = new Float32Array(512); a[0] = F(121.95606994628906); const step = F(5.7754812240600586);
    for (let i = 1; i < 512; i++) a[i] = F(a[i - 1] + step);
    const hz = new Float32Array(512);
    for (let i = 0; i < 512; i++) hz[i] = F(F(F(Math.pow(10, F(a[i] / 2595))) + -1) * 700);
    hz[0] = 80; hz[511] = 10000; return hz;
  }
  function makeRamp(nb, invNyq) {
    const k = Math.floor(F(F(invNyq * 80) * nb)), n = nb - k, R = new Float32Array(nb).fill(1);
    const st = F(0.5 / n); let v = 1;
    for (let i = 1; i < n; i++) { v = F(v - st); R[k - 1 + i] = v; }
    R[k - 1 + n] = 0.5; return R;
  }
  function iterativeAmpFit(ctx, X, Y, N, iters, T, P, freq) {
    const nb = 1025, L1 = 128, L2 = 2048, fftSize = 2048;
    const R = ctx.rampR;
    let W = new Float32Array(nb).fill(1);
    let bestW = Float32Array.from(W), bestT = null, bestP = null, bestIR1 = null, bestIR2 = null, best = 100, e = 1.0;
    let IR1 = new Float32Array(L1), IR2 = new Float32Array(L2);
    const gridHz = ctx.grid512, info = [];
    const x = X.subarray(0, N), y = Y.subarray(0, N);
    const kGeo = Math.floor(F(F(ctx.invNyq * 60) * nb));
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < nb; i++) { let v = F(Math.pow(W[i], F(R[i] * e))); if (v > 5) v = 5; if (v < 0.2) v = 0.2; W[i] = F(v); }
      const d1 = C.downSampleSmoothFreq(W, freq, nb, nb), d2 = C.downSampleSmoothFreq(d1.magnitude, d1.freq, nb, nb);
      W = Float32Array.from(d2.magnitude);
      for (let i = 0; i < nb; i++) { P[i] = F(W[i] * P[i]); T[i] = F(T[i] / W[i]); }
      if (kGeo > 1) {
        const t0 = T[1]; let prev = F(Math.sqrt(F(F(Math.sqrt(F(T[0] * T[1]))) * T[0]))); T[0] = prev; let oldNext = t0;
        for (let k = 1; k < kGeo; k++) { const cur = F(Math.sqrt(F(F(Math.sqrt(F(prev * T[k + 1]))) * oldNext))); oldNext = T[k + 1]; T[k] = cur; prev = cur; }
      }
      const tcurve = C.downSampleSmoothFreq(T, freq, nb, L1);
      IR1 = Float32Array.from(C.minPhaseIR(tcurve.magnitude, L1, L1));
      const m1 = modelChain(convolve(x, IR1), ctx);
      const tf1m = Float32Array.from(C.tfestimate(m1, y, N, ctx.segLen, fftSize, nb, SR).magnitude);
      const ratio = new Float32Array(nb);
      for (let k = 0; k < nb; k++) ratio[k] = F((tf1m[k] * 1e6) / (P[k] * 1e6 + EPS));
      W = Float32Array.from(C.downSampleSmoothFreq(ratio, freq, nb, nb).magnitude);
      IR2 = Float32Array.from(C.minPhaseIR(tf1m, nb, L2));
      const m2 = convolve(m1, IR2);
      const tf2 = C.tfestimate(m2, y, N, ctx.segLen, fftSize, nb, SR);
      const V = C.interp1(freq, nb, Float32Array.from(tf2.magnitude), gridHz, 512);
      let err = 0; for (let j = 0; j < 512; j++) err = F(err + Math.abs(F(Math.log(F(V[j] + EPS)))));
      err = F(err * 0.001953125);
      e = F(e * 0.9);
      info.push({ it, err, e });
      if (err < best) { bestW = Float32Array.from(W); bestIR1 = Float32Array.from(IR1); bestIR2 = Float32Array.from(IR2); bestT = Float32Array.from(T); bestP = Float32Array.from(P); best = err; }
      else if (best * 1.2 < err) { W = Float32Array.from(bestW); IR1 = Float32Array.from(bestIR1); IR2 = Float32Array.from(bestIR2); T.set(bestT); P.set(bestP); e = F(e * 0.5); }
    }
    return { ir1: bestIR1, ir2: bestIR2, T: bestT, P: bestP, info };
  }

  // ---------------------------------------------------------------- post stage
  function dftBins(x, N, nBins) {
    const re = new Float64Array(nBins), im = new Float64Array(nBins);
    const cosT = new Float64Array(N), sinT = new Float64Array(N);
    for (let j = 0; j < N; j++) { const a = 2 * Math.PI * j / N; cosT[j] = Math.cos(a); sinT[j] = Math.sin(a); }
    for (let k = 0; k < nBins; k++) {
      let r = 0, i = 0;
      for (let j = 0; j < N; j++) { const idx = (j * k) % N; r += x[j] * cosT[idx]; i -= x[j] * sinT[idx]; }
      re[k] = r; im[k] = i;
    }
    return { re, im };
  }
  function clampRatio(r) {
    for (let i = 0; i < r.length; i++) { let v = r[i]; if (v > 10 || v < 0.1) { const m = Math.min(v, 10); r[i] = F(m >= 0.1 ? m : 0.1); } }
  }
  function postStage(ctx, X, Y, onset, IR1, IR2) {
    const N = 20 * SR, xs = 50 * SR, ys = 50 * SR + onset, blk = Math.round(SR * 0.1);
    const nBlk = Math.floor(N / blk);
    const m1 = modelChain(convolve(X.subarray(xs, xs + N), IR1), ctx);
    const m2 = convolve(m1, IR2);
    const Sm = new Float64Array(blk), Sy = new Float64Array(blk);
    for (let b = 0; b < nBlk; b++) for (let j = 0; j < blk; j++) { Sm[j] += m2[b * blk + j]; Sy[j] += Y[ys + b * blk + j]; }
    let mm = 0, my = 0; for (let j = 0; j < blk; j++) { mm += Sm[j]; my += Sy[j]; } mm /= blk; my /= blk;
    for (let j = 0; j < blk; j++) { const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * j / (blk - 1)); Sm[j] = (Sm[j] - mm) * w; Sy[j] = (Sy[j] - my) * w; }
    const nBins = Math.floor(blk * 0.5 + 1);
    const M = dftBins(Sm, blk, nBins), Yd = dftBins(Sy, blk, nBins);
    const Mmag = new Float32Array(nBins), Ymag = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) { Mmag[k] = F(Math.hypot(M.re[k], M.im[k])); Ymag[k] = F(Math.hypot(Yd.re[k], Yd.im[k])); }
    const freq = new Float32Array(nBins);
    { const step = F(F(SR / 2) / (nBins - 1)); let v = 0; for (let i = 1; i < nBins; i++) { v = F(v + step); freq[i] = v; } freq[nBins - 1] = F(SR / 2); }
    const Ms = C.downSampleSmoothFreq(Mmag, freq, nBins, nBins).magnitude, Ys = C.downSampleSmoothFreq(Ymag, freq, nBins, nBins).magnitude;
    let ratio = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) ratio[k] = F((Ys[k] * 1e6) / (Ms[k] * 1e6 + EPS));
    clampRatio(ratio);
    ratio = Float32Array.from(C.smoothdata(ratio, nBins, Math.trunc(nBins * 0.1)));
    clampRatio(ratio);
    const IR3 = C.minPhaseIR(C.downSampleSmoothFreq(ratio, freq, nBins, 256).magnitude, 256, 256);
    const L2 = IR2.length, full = new Float64Array(L2 + 255);
    for (let i = 0; i < L2; i++) for (let k = 0; k < 256; k++) full[i + k] += IR2[i] * IR3[k];
    const out2 = new Float32Array(L2); let mean = 0;
    for (let i = 0; i < L2; i++) { out2[i] = F(full[i]); mean += out2[i]; }
    mean = F(mean / L2); for (let i = 0; i < L2; i++) out2[i] = F(out2[i] - mean);
    const m3 = convolve(m1, out2);
    let ey = 0, em = 0; for (let i = 0; i < N; i++) { ey += Y[ys + i] * Y[ys + i]; em += m3[i] * m3[i]; }
    const g = F(Math.sqrt(ey) / Math.sqrt(em));
    for (let i = 0; i < L2; i++) out2[i] = F(F(out2[i] * g) * 4.0);
    return out2;
  }

  // ---------------------------------------------------------------- top level
  // X, Y: Float32Array mono at 48 kHz (Y at least 70 s + 600 samples of content, zero padded if shorter)
  function profile(X, Yraw, opts) {
    opts = opts || {};
    const progress = opts.progress || function () {};
    const nb = 1025;
    const { Y, onset } = prepare(X, Yraw);
    progress("waveshaper fit", 0.02);
    const nl = fitWaveshaper(X, Y, onset);
    const post = POST_BIQUAD_48K;
    const ctx = { nl, post, rampR: makeRamp(nb, F(1 / 24000)), grid512: makeGrid512(), invNyq: F(1 / 24000), segLen: Math.floor(SR * 0.125 + 0.5) };
    const N1 = 15 * SR, N2 = 5 * SR, s1 = 6 * SR, s2 = 23 * SR;
    const r1 = modelChain(X.subarray(s1, s1 + N1), ctx);
    const tf1 = C.tfestimate(r1, Y.subarray(s1 + onset, s1 + onset + N1), N1, ctx.segLen, 2048, nb, SR);
    const r2 = modelChain(convolve(X.subarray(s2, s2 + N2), FIR50_48K), ctx);
    const tf2 = C.tfestimate(r2, Y.subarray(s2 + onset, s2 + onset + N2), N2, ctx.segLen, 2048, nb, SR);
    progress("transfer functions", 0.1);
    const tp = buildTP(Float32Array.from(tf1.magnitude), Float32Array.from(tf2.magnitude), nb);
    const T = tp.T, P = tp.P, freq = Float32Array.from(tf1.freq);
    const calls = [{ xs: 23 * SR, N: 5 * SR, it: 3 }, { xs: 6 * SR, N: 15 * SR, it: 2 }, { xs: 30 * SR, N: 20 * SR, it: 5 }];
    let res = null;
    for (let c = 0; c < 3; c++) {
      const q = calls[c];
      res = iterativeAmpFit(ctx, X.subarray(q.xs, q.xs + q.N), Y.subarray(q.xs + onset, q.xs + onset + q.N), q.N, q.it, T, P, freq);
      T.set(res.T); P.set(res.P);
      progress("iterative fit " + (c + 1) + "/3", 0.1 + 0.25 * (c + 1));
    }
    const ir1 = res.ir1;
    const ir2 = postStage(ctx, X, Y, onset, ir1, res.ir2);
    progress("done", 1);
    return { ir1, ir2, nl, onset };
  }

  // Same as profile() but runs in a Web Worker (keeps the page responsive);
  // falls back to the calling thread where workers are unavailable.
  function profileAsync(X, Yraw, opts) {
    opts = opts || {};
    if (typeof Worker === "undefined" || !SCRIPT_BASE) return Promise.resolve(profile(X, Yraw, opts));
    return new Promise((resolve, reject) => {
      const w = new Worker(SCRIPT_BASE + "amp_profiler_worker.js");
      const done = () => w.terminate();
      w.onerror = (e) => { done(); reject(new Error("profiler worker failed: " + (e.message || "unknown error"))); };
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "progress") { if (opts.progress) opts.progress(m.stage, m.frac); }
        else if (m.type === "result") { done(); resolve(m.result); }
        else if (m.type === "error") { done(); reject(new Error(m.message)); }
      };
      const x = Float32Array.from(X), y = Float32Array.from(Yraw);      // copies, transferred below
      w.postMessage({ type: "run", x, y }, [x.buffer, y.buffer]);
    });
  }

  // ---------------------------------------------------------------- .clo assembly
  // Kaiser-windowed-sinc sample-rate conversion (polyphase, exact rational ratio).
  // fc = cutoff as a fraction of the lower Nyquist, hw = half-width in input
  // samples (scaled up when decimating). The defaults reproduce Suite's
  // converter (r8brain) on the 44.1 -> 48 kHz reference conversion to ~4e-4
  // of peak (checked on the 70 s reference signal).
  function resample(x, srIn, srOut, opts) {
    opts = opts || {};
    const fcRel = opts.fc || 0.982, hwBase = opts.hw || 200, beta = opts.beta || 6;
    if (srIn === srOut) return Float32Array.from(x);
    const gcd = (a, b) => (b ? gcd(b, a % b) : a), g = gcd(srIn, srOut);
    const M = srIn / g, L = srOut / g;                          // t = m * M / L (input samples)
    const down = srOut < srIn, fc = fcRel * (down ? srOut / srIn : 1), hw = Math.ceil(hwBase * (down ? srIn / srOut : 1));
    const I0 = (z) => { let s = 1, t = 1; for (let k = 1; k < 60; k++) { t *= (z / 2 / k) * (z / 2 / k); s += t; } return s; };
    const i0b = I0(beta), taps = 2 * hw, table = new Float64Array(L * taps);
    for (let p = 0; p < L; p++) {
      const frac = p / L;
      for (let k = -hw + 1; k <= hw; k++) {
        const d = frac - k, sinc = d === 0 ? fc : Math.sin(Math.PI * d * fc) / (Math.PI * d);
        table[p * taps + k + hw - 1] = sinc * I0(beta * Math.sqrt(Math.max(0, 1 - (d / hw) * (d / hw)))) / i0b;
      }
    }
    const n = x.length, nOut = Math.floor(n * srOut / srIn), out = new Float32Array(nOut);
    for (let m = 0; m < nOut; m++) {
      const pos = m * M, j0 = Math.floor(pos / L), p = pos - j0 * L, base = p * taps, first = j0 - hw + 1;
      let s = 0;
      if (first >= 0 && first + taps <= n) for (let k = 0; k < taps; k++) s += x[first + k] * table[base + k];
      else for (let k = 0; k < taps; k++) { const j = first + k; if (j >= 0 && j < n) s += x[j] * table[base + k]; }
      out[m] = F(s);
    }
    return out;
  }
  // IR resampling 48 -> 44.1 kHz for the .clo (tuned against Suite's own files)
  function resampleTo44k(x) { return resample(x, SR, 44100, { fc: 0.978, hw: 128, beta: 16 }); }
  function crc16(bytes) {          // CRC-16/MODBUS, byte-swapped result
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) { crc ^= bytes[i]; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1; }
    return ((crc & 0xff) << 8) | (crc >>> 8);
  }
  const CLO_FULL_LEN = 8840, CLO_WIRE_LEN = 2696;
  // full profiler output (0x2288 bytes): header 136 + 128-float seg1 + 2048-float seg2
  function assembleClo(prof) {
    const out = new Uint8Array(CLO_FULL_LEN), dv = new DataView(out.buffer);
    out.set([0x56, 0x54, 0x53, 0x49], 0);                       // 'VTSI'
    dv.setUint32(4, CLO_FULL_LEN, true);
    dv.setUint32(20, 0x2200, true);
    const ident = [1, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) { dv.setFloat64(24 + 8 * i, ident[i], true); dv.setFloat64(64 + 8 * i, POST_BIQUAD_48K[i], true); }
    dv.setFloat32(104, prof.nl.posPeak, true); dv.setFloat32(108, prof.nl.negPeak, true);
    dv.setFloat32(112, prof.nl.aPos, true); dv.setFloat32(116, prof.nl.aNeg, true);
    dv.setUint32(124, 128, true); dv.setUint32(128, 128, true); dv.setUint32(132, 2048, true);
    const s1 = resampleTo44k(prof.ir1.subarray(0, 128)), s2 = resampleTo44k(prof.ir2);
    for (let i = 0; i < 128; i++) dv.setFloat32(136 + 4 * i, i < s1.length ? s1[i] : 0, true);
    for (let i = 0; i < 2048; i++) dv.setFloat32(136 + 512 + 4 * i, i < s2.length ? s2[i] : 0, true);
    dv.setUint32(8, crc16(out.subarray(12)), true);
    return out;
  }
  // what the Suite sends to the pedal: header + first 2560 data bytes, lengths and CRC rewritten
  function toDeviceClo(clo) {
    const out = new Uint8Array(CLO_WIRE_LEN); out.set(clo.subarray(0, CLO_WIRE_LEN));
    const dv = new DataView(out.buffer);
    dv.setUint32(4, CLO_WIRE_LEN, true); dv.setUint32(20, CLO_WIRE_LEN - 136, true);
    dv.setUint32(132, Math.min(dv.getUint32(132, true), 512), true);
    dv.setUint32(8, crc16(out.subarray(12)), true);
    return out;
  }

  root.AmpProfiler = { profile, profileAsync, assembleClo, toDeviceClo, resample, resampleTo44k, crc16, fitWaveshaper, prepare, modelChain, convolve, buildTP, iterativeAmpFit, postStage, makeGrid512, makeRamp, POST_BIQUAD_48K, FIR50_48K, SR };
})(typeof self !== "undefined" ? self : this);
