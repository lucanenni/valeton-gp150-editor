"use strict";
// Web Worker for nam_wavenet_fast.js: renders chunks of a compiled WaveNet plan.
importScripts("nam_wavenet.js", "nam_wavenet_fast.js");
let plan = null;
self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === "init") { plan = m.plan; self.postMessage({ type: "ready" }); }
    else if (m.type === "chunk") {
      const out = self.NamWaveNetFast.forwardChunk(plan, m.chunk);
      self.postMessage({ type: "out", s: m.s, out }, [out.buffer]);
    }
  } catch (e) { self.postMessage({ type: "error", message: String(e && e.message || e) }); }
};
