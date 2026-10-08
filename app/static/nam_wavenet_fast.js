"use strict";
/*
 * nam_wavenet_fast.js -- fast NAM WaveNet renderer for long signals: flat
 * Float32 buffers with tight loops (no per-layer allocation), rendered in
 * overlapping blocks that can be spread over Web Workers (nam_worker.js).
 *
 * It computes exactly what nam_wavenet.js does (that float64 version stays
 * the reference; the tests compare the two), for both supported schemas:
 *   - "modern": one layer array, per-layer 1x1, final K-tap head conv + scale
 *   - "classic": several layer arrays chained through per-array 1x1 heads
 * Both reduce to the same program: per array, rechannel 1x1 -> layers
 * (dilated conv + mixer of the raw input, activation, 1x1 residual, head
 * accumulation) -> head conv (K taps; K=1 for classic arrays). Every signal is
 * end-aligned, exactly like the `trimLast` bookkeeping of the reference.
 *
 * A block is rendered with `receptiveField - 1` samples of real history in
 * front (zeros before the start of the signal), so blocks are independent.
 */
(function (root) {
  const NW = root.NamWaveNet || (typeof require !== "undefined" ? require("./nam_wavenet.js").NamWaveNet : null);
  if (!NW) throw new Error("nam_wavenet.js must be loaded first");
  const SCRIPT_BASE = (typeof document !== "undefined" && document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/[^/]*$/, "") : null;

  const flat3 = (w) => {           // [o][c][k] nested arrays -> Float32Array
    const O = w.length, C = w[0].length, K = w[0][0].length, out = new Float32Array(O * C * K);
    let i = 0;
    for (let o = 0; o < O; o++) for (let c = 0; c < C; c++) for (let k = 0; k < K; k++) out[i++] = w[o][c][k];
    return out;
  };
  const vec = (v, n) => Float32Array.from(v || new Array(n).fill(0));
  const actId = (fn) => (fn === NW.resolveActivation("Tanh") ? 0 : 1);   // 0 tanh, 1 leaky relu

  // model = NamWaveNet.extractAnyModel(...) result -> flat plan
  function compile(model) {
    const arrays = [];
    let headScale, rf = 1;
    if (model.kind === "modern") {
      const p = NW.parseWaveNetWeights(model.layerConfig, model.weights);
      const ch = p.channels;
      arrays.push({
        inCh: 1, ch, rechannel: flat3(p.rechannelWeight),
        layers: p.layers.map((l) => ({ k: l.kernelSize, d: l.dilation, act: actId(l.activation), conv: flat3(l.convWeight), convBias: vec(l.convBias, ch), mix: flat3(l.mixerWeight), one: flat3(l.layer1x1Weight), oneBias: vec(l.layer1x1Bias, ch) })),
        headOut: p.headWeight.length, headK: p.headKernelSize, head: flat3(p.headWeight), headBias: vec(p.headBias, p.headWeight.length),
      });
      headScale = p.headScale;
      rf = NW.receptiveField(p);
    } else {
      const cfg = model.config; let off = 0;
      for (const ac of cfg.layers) {
        const r = NW.parseClassicLayerArray(ac, model.weights, off); off = r.next;
        const p = r.parsed, ch = p.channels;
        arrays.push({
          inCh: ac.input_size, ch, rechannel: flat3(p.rechannelWeight),
          layers: p.layers.map((l) => ({ k: l.kernelSize, d: l.dilation, act: actId(p.activationFn), conv: flat3(l.convWeight), convBias: vec(l.convBias, ch), mix: flat3(l.mixerWeight), one: flat3(l.oneByOneWeight), oneBias: vec(l.oneByOneBias, ch) })),
          headOut: p.headRechannelWeight.length, headK: 1, head: flat3(p.headRechannelWeight), headBias: vec(p.headRechannelBias, p.headRechannelWeight.length),
        });
        rf += 1 + (ac.kernel_size - 1) * ac.dilations.reduce((a, b) => a + b, 0) - 1;
      }
      headScale = model.weights[off];
    }
    return { arrays, headScale, rf };
  }

  // out[o][n] = bias[o] + sum_{c,k} W[o][c][k] * inp[c][n + k*d]   (valid)
  // Terms are accumulated four at a time so each pass over the output row
  // does four multiply-adds per load/store of the accumulator.
  let offs = new Int32Array(1024), wts = new Float32Array(1024);
  function convValid(inp, inCh, Lin, W, outCh, K, d, bias, out) {
    const Lout = Lin - (K - 1) * d, T = inCh * K;
    if (T > offs.length) { offs = new Int32Array(T); wts = new Float32Array(T); }
    for (let o = 0; o < outCh; o++) {
      const ro = o * Lout, b = bias ? bias[o] : 0;
      let t = 0;
      for (let c = 0; c < inCh; c++) for (let k = 0; k < K; k++) {
        const w = W[(o * inCh + c) * K + k];
        if (w !== 0) { offs[t] = c * Lin + k * d; wts[t] = w; t++; }
      }
      for (let n = 0; n < Lout; n++) out[ro + n] = b;
      let i = 0;
      for (; i + 4 <= t; i += 4) {
        const b0 = offs[i], b1 = offs[i + 1], b2 = offs[i + 2], b3 = offs[i + 3];
        const w0 = wts[i], w1 = wts[i + 1], w2 = wts[i + 2], w3 = wts[i + 3];
        for (let n = 0; n < Lout; n++) out[ro + n] += w0 * inp[b0 + n] + w1 * inp[b1 + n] + w2 * inp[b2 + n] + w3 * inp[b3 + n];
      }
      for (; i < t; i++) {
        const b0 = offs[i], w0 = wts[i];
        for (let n = 0; n < Lout; n++) out[ro + n] += w0 * inp[b0 + n];
      }
    }
    return Lout;
  }

  // Renders one chunk: `x` holds (rf-1) samples of history followed by the samples to render.
  function forwardChunk(plan, x) {
    const Ltot = x.length;
    let cur = x, curCh = 1, Lcur = Ltot;          // array input
    let headIn = null, headInCh = 0, headInL = 0;  // carried head signal
    let lastHead = null, lastHeadL = 0;
    for (const arr of plan.arrays) {
      const ch = arr.ch;
      // array-final length
      let Lfin = Lcur; for (const l of arr.layers) Lfin -= (l.k - 1) * l.d;
      let y = new Float32Array(ch * Lcur); convValid(cur, arr.inCh, Lcur, arr.rechannel, ch, 1, 1, null, y);
      let Ly = Lcur;
      const headAcc = new Float32Array(ch * Lfin);
      if (headIn) for (let o = 0; o < ch; o++) for (let n = 0; n < Lfin; n++) headAcc[o * Lfin + n] = headIn[o * headInL + (headInL - Lfin) + n];
      for (const l of arr.layers) {
        const Lc = Ly - (l.k - 1) * l.d;
        const z = new Float32Array(ch * Lc);
        convValid(y, ch, Ly, l.conv, ch, l.k, l.d, l.convBias, z);
        const condOff = Ltot - Lc;
        for (let o = 0; o < ch; o++) {
          const mw = l.mix[o], ro = o * Lc;
          if (l.act === 0) for (let n = 0; n < Lc; n++) z[ro + n] = Math.tanh(z[ro + n] + mw * x[condOff + n]);
          else for (let n = 0; n < Lc; n++) { const v = z[ro + n] + mw * x[condOff + n]; z[ro + n] = v >= 0 ? v : 0.01 * v; }
        }
        const one = new Float32Array(ch * Lc); convValid(z, ch, Lc, l.one, ch, 1, 1, l.oneBias, one);
        const ny = new Float32Array(ch * Lc), yOff = Ly - Lc;
        for (let o = 0; o < ch; o++) { const ro = o * Lc, ry = o * Ly + yOff; for (let n = 0; n < Lc; n++) ny[ro + n] = y[ry + n] + one[ro + n]; }
        const hOff = Lc - Lfin;
        for (let o = 0; o < ch; o++) { const rh = o * Lfin, rz = o * Lc + hOff; for (let n = 0; n < Lfin; n++) headAcc[rh + n] += z[rz + n]; }
        y = ny; Ly = Lc;
      }
      const Lh = Lfin - (arr.headK - 1);
      const ho = new Float32Array(arr.headOut * Lh);
      convValid(headAcc, ch, Lfin, arr.head, arr.headOut, arr.headK, 1, arr.headBias, ho);
      headIn = ho; headInCh = arr.headOut; headInL = Lh; lastHead = ho; lastHeadL = Lh;
      cur = y; curCh = ch; Lcur = Ly;
    }
    const out = new Float32Array(lastHeadL);
    for (let n = 0; n < lastHeadL; n++) out[n] = lastHead[n] * plan.headScale;
    return out;
  }

  function makeChunk(input, s, end, hist) {
    const from = s - hist, chunk = new Float32Array(end - from);
    const lo = Math.max(0, from);
    chunk.set(input.subarray(lo, end), lo - from);
    return chunk;
  }

  // In-thread renderer (reference for the tests and fallback without workers)
  function renderSync(model, input, blockSize, onProgress) {
    const plan = compile(model), hist = plan.rf - 1, B = blockSize || 24000, n = input.length, out = new Float32Array(n);
    for (let s = 0; s < n; s += B) {
      const end = Math.min(n, s + B);
      out.set(forwardChunk(plan, makeChunk(input, s, end, hist)), s);
      if (onProgress) onProgress(end / n);
    }
    return out;
  }

  // Worker-pool renderer. `model` must be structured-cloneable (it is: plain JSON + weights).
  async function render(model, input, opts) {
    opts = opts || {};
    const B = opts.blockSize || 36000, n = input.length, onProgress = opts.onProgress;
    const nWorkers = opts.workers != null ? opts.workers : Math.max(1, Math.min(8, ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4) - 1));
    // `opts.workerFactory()` supplies Worker-like objects where there is no browser Worker (Node, see mcp/lib/threads.mjs).
    const makeWorker = opts.workerFactory || (() => new Worker(SCRIPT_BASE + "nam_worker.js"));
    if ((!opts.workerFactory && (typeof Worker === "undefined" || !SCRIPT_BASE)) || nWorkers < 2) {
      return renderSync(model, input, B, onProgress);
    }
    const plan = compile(model), hist = plan.rf - 1, out = new Float32Array(n);
    const tasks = []; for (let s = 0; s < n; s += B) tasks.push(s);
    let next = 0, done = 0;
    const workers = [];
    try {
      await new Promise((resolve, reject) => {
        const feed = (w) => {
          if (next >= tasks.length) return;
          const s = tasks[next++], end = Math.min(n, s + B), chunk = makeChunk(input, s, end, hist);
          w.postMessage({ type: "chunk", s, chunk }, [chunk.buffer]);
        };
        for (let i = 0; i < nWorkers; i++) {
          const w = makeWorker();
          workers.push(w);
          w.onerror = (e) => reject(new Error("NAM worker failed: " + (e.message || "unknown error")));
          w.onmessage = (ev) => {
            const m = ev.data;
            if (m.type === "ready") { feed(w); return; }
            if (m.type === "error") { reject(new Error(m.message)); return; }
            out.set(m.out, m.s); done++;
            if (onProgress) onProgress(Math.min(1, done / tasks.length));
            if (done === tasks.length) resolve(); else feed(w);
          };
          w.postMessage({ type: "init", plan, hist });
        }
      });
    } finally {
      for (const w of workers) w.terminate();
    }
    return out;
  }

  root.NamWaveNetFast = { compile, forwardChunk, renderSync, render };
})(typeof self !== "undefined" ? self : this);
