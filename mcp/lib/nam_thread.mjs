// worker_threads entry mirroring app/static/nam_worker.js: renders chunks of a compiled WaveNet plan.
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Fast = require(resolve(dirname(fileURLToPath(import.meta.url)), "../../app/static/nam_wavenet_fast.js")).NamWaveNetFast;
let plan = null;
parentPort.on("message", (m) => {
  try {
    if (m.type === "init") { plan = m.plan; parentPort.postMessage({ type: "ready" }); }
    else if (m.type === "chunk") {
      const out = Fast.forwardChunk(plan, m.chunk);
      parentPort.postMessage({ type: "out", s: m.s, out }, [out.buffer]);
    }
  } catch (e) { parentPort.postMessage({ type: "error", message: String((e && e.message) || e) }); }
});
