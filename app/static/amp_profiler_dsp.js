"use strict";
/*
 * amp_profiler_dsp.js -- numeric building blocks of the amp profiler (GP150-9)
 * that turns a (reference, recorded) signal pair into the SnapTone/"tone
 * catch" .clo payload (see amp_profiler.js for the pipeline itself).
 *
 * Each function was checked against reference output on identical
 * inputs until it agreed to float precision; the golden profile test
 * (app/tests/test_amp_profiler_js.mjs) exercises all of them end to end.
 */
(function (root) {
  // ---------------------------------------------------------------------
  // In-place radix-2 complex FFT (float64).
  // ---------------------------------------------------------------------
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k], ui = im[i + k];
          const xr = re[i + k + half], xi = im[i + k + half];
          const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // ---------------------------------------------------------------------
  // tfestimate(x, y, N, segLen, fftSize, nBins) -> {magnitude, freq}
  //
  // Welch H1 estimator, |E[Y X*]| / E[|X|^2]. Details matched to the reference output:
  //   * window: symmetric Hamming, 0.54 - 0.46*cos(2*pi*i/(segLen-1))
  //   * hop = ceil(segLen/2); segment starts 0, hop, 2*hop, ... < N-segLen,
  //     plus one final segment flush with the end (start N-segLen), which is
  //     not added twice when it already coincides with a regular start
  //   * the RAW segment mean is subtracted before windowing
  //   * when segLen > fftSize the windowed block is folded (time-aliased)
  //     modulo fftSize; when segLen < fftSize it is zero-padded
  // `freq[k] = k / fftSize * sampleRate`.
  // ---------------------------------------------------------------------
  function tfestimate(x, y, N, segLen, fftSize, nBins, sampleRate) {
    const win = new Float64Array(segLen);
    for (let i = 0; i < segLen; i++) win[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (segLen - 1));
    const hop = Math.ceil(segLen / 2);
    const starts = [];
    for (let s = 0; s < N - segLen; s += hop) starts.push(s);
    starts.push(N - segLen);

    const sxx = new Float64Array(nBins);
    const sxyRe = new Float64Array(nBins);
    const sxyIm = new Float64Array(nBins);
    const xr = new Float64Array(fftSize), xi = new Float64Array(fftSize);
    const yr = new Float64Array(fftSize), yi = new Float64Array(fftSize);
    for (const s of starts) {
      let mx = 0, my = 0;
      for (let i = 0; i < segLen; i++) { mx += x[s + i]; my += y[s + i]; }
      mx /= segLen; my /= segLen;
      xr.fill(0); xi.fill(0); yr.fill(0); yi.fill(0);
      for (let i = 0; i < segLen; i++) {
        const j = i % fftSize;
        xr[j] += (x[s + i] - mx) * win[i];
        yr[j] += (y[s + i] - my) * win[i];
      }
      fft(xr, xi, false);
      fft(yr, yi, false);
      for (let k = 0; k < nBins; k++) {
        sxx[k] += xr[k] * xr[k] + xi[k] * xi[k];
        sxyRe[k] += yr[k] * xr[k] + yi[k] * xi[k];
        sxyIm[k] += yi[k] * xr[k] - yr[k] * xi[k];
      }
    }
    const magnitude = new Float64Array(nBins);
    const freq = new Float64Array(nBins);
    for (let k = 0; k < nBins; k++) {
      magnitude[k] = Math.hypot(sxyRe[k], sxyIm[k]) / (sxx[k] + 1e-20);
      freq[k] = (k / fftSize) * sampleRate;
    }
    return { magnitude, freq };
  }


  const F = Math.fround;
  const FLT_MAX = 3.4028234663852886e38;

  // ---------------------------------------------------------------------
  // smoothdata(in, n, width). Gaussian-weighted
  // moving average (sigma = width/5) with a kernel of length (width | 1),
  // renormalised by the sum of the weights actually used near the edges.
  // Matches the reference output (max error ~2e-7, float32).
  // ---------------------------------------------------------------------
  function smoothdata(input, n, width) {
    const out = new Float64Array(n);
    if (width < 1) return out;
    const g = new Float64Array(width);
    const step = 5.0 / width;
    const c0 = Math.ceil(width * 0.5);
    let sum = 0;
    for (let i = 0; i < width; i++) {
      const t = (i + 1 - c0) * step;
      g[i] = Math.exp(-0.5 * t * t);
      sum += g[i];
    }
    const scale = 1e6 / sum;
    const len = width | 1;
    const k = new Float64Array(len);
    for (let i = 0; i < width; i++) k[i] = g[width - 1 - i] * scale;
    const c = Math.ceil(len * 0.5);
    const left = c - 1;
    const right = len - c;
    for (let i = 0; i < n; i++) {
      if (i >= left && i < n - right) {
        let acc = 0;
        for (let m = -left; m <= right; m++) acc += input[i + m] * k[m + left];
        out[i] = acc * 1e-6;
      } else {
        const lo = -Math.min(i, left);
        const hi = i < n - right ? right : n - 1 - i;
        let acc = 0, wsum = 0;
        for (let m = lo; m <= hi; m++) {
          const w = k[m + left];
          acc += input[i + m] * w;
          wsum += w;
        }
        out[i] = acc / wsum;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // interp1(x, n, y, xq, nq). Piecewise linear with the reference implementation's quirks,
  // reproduced bit-exactly (float32 with fused multiply-add): each query uses the
  // segment starting at the nearest x[i] <= xq; queries left of x[0] give
  // FLT_MAX; queries right of x[n-1] extrapolate with the last segment.
  // ---------------------------------------------------------------------
  function interp1(x, n, y, xq, nq) {
    const m = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (i < n - 1) {
        m[i] = F(F(y[i + 1] - y[i]) / F(x[i + 1] - x[i]));
        b[i] = F(y[i] - x[i] * m[i]);
      } else {
        m[i] = m[i - 1];
        b[i] = b[i - 1];
      }
    }
    const out = new Float32Array(nq);
    for (let q = 0; q < nq; q++) {
      const v = xq[q];
      let idx = -1, best = FLT_MAX;
      for (let i = 0; i < n; i++) {
        const d = F(v - x[i]);
        if (d >= 0 && d < best) { idx = i; best = d; }
      }
      out[q] = idx < 0 ? FLT_MAX : F(v * m[idx] + b[idx]);
    }
    return out;
  }

  function exp10f(v) { return F(Math.pow(10, v)); }
  function log10f(v) { return F(Math.log10(v)); }

  // float32 sequential linspace exactly as the real code builds its axes:
  // first value, then repeated addition of one float32 step, last forced.
  function linspaceSeq(a, b, n) {
    const out = new Float32Array(n);
    out[0] = a;
    if (n > 1) {
      const step = F(F(b - a) / F(n - 1));
      let v = a;
      for (let i = 1; i < n; i++) { v = F(v + step); out[i] = v; }
    }
    out[n - 1] = b;
    return out;
  }

  // ---------------------------------------------------------------------
  // downSampleSmoothFreq(magIn, freqIn, nIn, nOut). Smooths a magnitude curve in dB on the MEL
  // frequency scale (2595*log10(1+f/700)), resamples it to nOut points and
  // returns it on a LINEAR frequency axis freqOut = linspace(f0, fLast).
  // ---------------------------------------------------------------------
  function downSampleSmoothFreq(magIn, freqIn, nIn, nOut) {
    const K = 700, C = 2595;
    const w0 = F(log10f(F(F(freqIn[0] / K) + 1)) * C);
    const w1 = F(log10f(F(F(freqIn[nIn - 1] / K) + 1)) * C);
    const melIn = linspaceSeq(w0, w1, nIn);
    const hzIn = new Float32Array(nIn);
    for (let i = 0; i < nIn; i++) hzIn[i] = F(F(exp10f(F(melIn[i] / C)) + -1) * K);
    hzIn[0] = freqIn[0];
    hzIn[nIn - 1] = freqIn[nIn - 1];
    const melOut = linspaceSeq(w0, w1, nOut);
    const hzOut = new Float32Array(nOut);
    for (let i = 0; i < nOut; i++) hzOut[i] = F(F(exp10f(F(melOut[i] / C)) + -1) * K);
    hzOut[0] = freqIn[0];
    hzOut[nOut - 1] = freqIn[nIn - 1];
    const freqOut = linspaceSeq(freqIn[0], freqIn[nIn - 1], nOut);

    let db = new Float32Array(nIn);
    for (let i = 0; i < nIn; i++) db[i] = F(log10f(magIn[i]) * 20);
    db = Float32Array.from(smoothdata(db, nIn, Math.trunc(nIn * 0.002)));
    let onMel = interp1(freqIn, nIn, db, hzIn, nIn);
    onMel = Float32Array.from(smoothdata(onMel, nIn, Math.trunc(nIn / nOut) * 2));
    let resampled = onMel;
    if (nIn !== nOut) resampled = interp1(melIn, nIn, onMel, melOut, nOut);
    const dbOut = interp1(hzOut, nOut, resampled, freqOut, nOut);
    const magnitude = new Float32Array(nOut);
    for (let i = 0; i < nOut; i++) magnitude[i] = exp10f(F(dbOut[i] * F(0.05)));
    return { magnitude, freq: freqOut };
  }


  // Generic complex DFT: FFT for power-of-two lengths, direct O(N^2) otherwise
  // (minPhaseIR uses N = 2*(nBins-1), e.g. 254 for the 128-point fit).
  function dftAny(re, im, inverse) {
    const n = re.length;
    if ((n & (n - 1)) === 0) {
      const r = Float64Array.from(re), i = Float64Array.from(im);
      fft(r, i, inverse);
      return [r, i];
    }
    const cosT = new Float64Array(n), sinT = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      cosT[k] = Math.cos(a);
      sinT[k] = (inverse ? 1 : -1) * Math.sin(a);
    }
    const outR = new Float64Array(n), outI = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        const idx = (k * t) % n;
        const c = cosT[idx], sn = sinT[idx];
        sr += re[t] * c - im[t] * sn;
        si += re[t] * sn + im[t] * c;
      }
      outR[k] = inverse ? sr / n : sr;
      outI[k] = inverse ? si / n : si;
    }
    return [outR, outI];
  }

  // ---------------------------------------------------------------------
  // minPhaseIR(mag, nBins, irLen). Homomorphic
  // minimum-phase reconstruction over N = 2*(nBins-1) points (log-magnitude
  // -> real cepstrum -> fold -> exp), then truncated to irLen, its MEAN
  // removed, and rescaled so that its energy equals that of the full-length
  // minimum-phase response. Matches the reference output.
  // ---------------------------------------------------------------------
  function minPhaseIR(mag, nBins, irLen) {
    const N = 2 * (nBins - 1);
    const floorLin = 1e-5;
    const fm = new Float64Array(N);
    for (let k = 0; k < nBins; k++) fm[k] = Math.max(mag[k], floorLin);
    for (let k = 1; k <= N - nBins; k++) fm[N - k] = fm[k];
    const lg = new Float64Array(N);
    for (let i = 0; i < N; i++) lg[i] = Math.log(fm[i]);
    const zeros = new Float64Array(N);
    const [cep] = dftAny(lg, zeros, true);
    const lift = new Float64Array(N);
    const half = N / 2;
    lift[0] = cep[0];
    for (let i = 1; i < half; i++) lift[i] = 2 * cep[i];
    if (N % 2 === 0) lift[half] = cep[half];
    const [lr, li] = dftAny(lift, zeros, false);
    const hr = new Float64Array(N), hi = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const m = Math.exp(lr[i]);
      hr[i] = m * Math.cos(li[i]);
      hi[i] = m * Math.sin(li[i]);
    }
    const [full] = dftAny(hr, hi, true);
    let eFull = 0;
    for (let i = 0; i < N; i++) eFull += full[i] * full[i];
    const out = new Float64Array(irLen);
    let mean = 0;
    for (let i = 0; i < irLen; i++) { out[i] = i < N ? full[i] : 0; mean += out[i]; }
    mean /= irLen;
    let eTrunc = 0;
    for (let i = 0; i < irLen; i++) { out[i] -= mean; eTrunc += out[i] * out[i]; }
    if (eTrunc > 0) {
      const scale = Math.sqrt(eFull / eTrunc);
      for (let i = 0; i < irLen; i++) out[i] *= scale;
    }
    return out;
  }

  root.AmpProfilerDsp = { fft, tfestimate, smoothdata, interp1, downSampleSmoothFreq, minPhaseIR, dftAny };
})(typeof self !== "undefined" ? self : this);
