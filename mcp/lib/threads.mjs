// The browser's Web Workers, done with worker_threads: the amp profiler and the NAM renderer.
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const S = (f) => resolve(here, "../../app/static", f);
export const Profiler = require(S("amp_profiler.js")).AmpProfiler;
export const Reference = require(S("amp_profiler_reference.js")).AmpProfilerReference;
export const NamWaveNet = require(S("nam_wavenet.js")).NamWaveNet;
export const NamWaveNetFast = require(S("nam_wavenet_fast.js")).NamWaveNetFast;

// Web-Worker-shaped wrapper (postMessage / onmessage / onerror / terminate) around a worker_threads Worker.
class WorkerShim {
  constructor(file) {
    this.w = new Worker(resolve(here, file));
    this.onmessage = null;
    this.onerror = null;
    this.w.on("message", (data) => this.onmessage && this.onmessage({ data }));
    this.w.on("error", (e) => this.onerror && this.onerror(e));
  }
  postMessage(msg, transfer) { this.w.postMessage(msg, transfer); }
  terminate() { this.w.terminate(); }
}

// profile(x, y) in a worker thread -> {ir1, ir2, nl, onset}
export function profileInThread(x, y, { onProgress } = {}) {
  return new Promise((ok, fail) => {
    const w = new WorkerShim("profiler_thread.mjs");
    const done = () => w.terminate();
    w.onerror = (e) => { done(); fail(new Error("profiler thread failed: " + (e.message || e))); };
    w.onmessage = ({ data: m }) => {
      if (m.type === "progress") onProgress && onProgress(m.stage, m.frac);
      else if (m.type === "result") { done(); ok(m.result); }
      else if (m.type === "error") { done(); fail(new Error(m.message)); }
    };
    const xs = Float32Array.from(x), ys = Float32Array.from(y);
    w.postMessage({ type: "run", x: xs, y: ys }, [xs.buffer, ys.buffer]);
  });
}

// NAM model -> output for `input`, spread over worker threads
export function renderNam(model, input, { onProgress, workers } = {}) {
  const n = workers ?? Math.max(2, Math.min(8, cpus().length - 1));
  return NamWaveNetFast.render(model, input, { onProgress, workers: n, workerFactory: () => new WorkerShim("nam_thread.mjs") });
}
