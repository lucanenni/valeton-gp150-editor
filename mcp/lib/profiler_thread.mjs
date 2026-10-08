// worker_threads entry: runs the amp profiler off the main thread (the MCP server must stay responsive).
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const P = require(resolve(dirname(fileURLToPath(import.meta.url)), "../../app/static/amp_profiler.js")).AmpProfiler;

parentPort.on("message", (m) => {
  if (m.type !== "run") return;
  try {
    const r = P.profile(m.x, m.y, { progress: (stage, frac) => parentPort.postMessage({ type: "progress", stage, frac }) });
    parentPort.postMessage({ type: "result", result: r });
  } catch (e) {
    parentPort.postMessage({ type: "error", message: String((e && e.message) || e) });
  }
});
