// "Used by" in Node: the same module the browser uses (app/static/gp150_usage.js), fed by the pedal link.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { root, G } from "./catalog.mjs";

const require = createRequire(import.meta.url);
globalThis.GP150Format = G;
// the usage cache needs a storage object; keep it in memory (Node's own localStorage prints a warning)
const mem = new Map();
Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) }, configurable: true, writable: true });
const U = require(resolve(root, "app/static/gp150_usage.js"));
const KIND = { snaptone: "st", nam: "nam", ir: "ir" };

// Reads the presets that are not cached yet (about 40 s the first time: 200 reads, one at a time), then answers.
// Must run inside withDevice().
export async function presetsUsing(W, kind, slot, { rescan = false } = {}) {
  globalThis.WebMidiGP150 = W;
  await (rescan ? U.rescan() : U.load());
  const st = U.getStatus();
  if (st.state === "error") throw new Error(st.message);
  return { complete: U.isComplete(), presets_read: U.known(), used_by: U.get(KIND[kind], slot) };
}
