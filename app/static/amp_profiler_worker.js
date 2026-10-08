"use strict";
// Web Worker for amp_profiler.js: runs the amp profiler off the UI thread.
importScripts("amp_profiler_dsp.js", "amp_profiler.js");
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type !== "run") return;
  try {
    const r = self.AmpProfiler.profile(m.x, m.y, { progress: (stage, frac) => self.postMessage({ type: "progress", stage, frac }) });
    self.postMessage({ type: "result", result: r });
  } catch (e) {
    self.postMessage({ type: "error", message: String((e && e.message) || e) });
  }
};
