// Connection to the pedal for the MCP server: one persistent link, one request at a time.
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installWebMidiShim } from "./webmidi_node_shim.mjs";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// stdout is the MCP channel: anything the browser module logs must go to stderr.
for (const m of ["log", "info", "debug"]) console[m] = (...a) => console.error(...a);

const SETTLE_AFTER_CONNECT_MS = 5000;   // Suite waits ~4 s before its first real request
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let W = null, shim = null, connecting = null, queue = Promise.resolve();

async function ensureConnected() {
  if (W && W.isConnected()) return W;
  if (!connecting) {
    connecting = (async () => {
      if (!shim) shim = installWebMidiShim();
      W = require(resolve(root, "app/static/webmidi_gp150.js")).WebMidiGP150;
      await W.connect();
      await sleep(SETTLE_AFTER_CONNECT_MS);
      return W;
    })().finally(() => { connecting = null; });
  }
  return connecting;
}

// Run `fn(W)` once every earlier request has finished (the pedal handles one at a time).
export function withDevice(fn) {
  const run = queue.then(async () => fn(await ensureConnected()));
  queue = run.catch(() => {});
  return run;
}

export function disconnect() { try { shim && shim.close(); } catch { /* ignore */ } }
