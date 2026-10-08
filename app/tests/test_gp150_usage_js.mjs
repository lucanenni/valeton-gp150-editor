/*
 * GP150Usage (app/static/gp150_usage.js): decoding of the N->S / CAB references, the
 * cache-aware loading (full scan, then only the presets whose name changed), live updates
 * through applyBody(), the stop-after-two-failures rule and exclusive() yielding.
 * Runs against a fake pedal built from the empty skeleton patch.
 *
 *   node app/tests/test_gp150_usage_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const F = require(resolve(here, "../static/gp150_format.js"));

const skeleton = new Uint8Array(readFileSync(resolve(repo, "app/static/data/gp150_skeleton.prst")));
function patch(slot0, name, { ns, cab, nsOn = true, cabOn = true } = {}) {
  const b = new Uint8Array(skeleton);
  b[F.PATCH_INDEX_OFF] = slot0;
  F.writeName(b, name);
  if (ns !== undefined) F.writeModuleModel(b, "NS", ns);
  if (cab !== undefined) F.writeModuleModel(b, "CAB", cab);
  F.writeModuleEnabled(b, "NS", nsOn);
  F.writeModuleEnabled(b, "CAB", cabOn);
  return b;
}
const fx = (mm, b2, t1, t2) => ((mm << 24) | (b2 << 16) | (t1 << 8) | t2) >>> 0;

// fake pedal
let requests = [], failSlots = new Set(), live = null;
const bodies = new Map();
function fakePedal() {
  return {
    isConnected: () => true,
    startLiveSync: (cb) => { live = cb; },
    readAllNames: async () => { requests.push("names"); return Array.from({ length: 200 }, (_, i) => ({ index: i, name: bodies.get(i) ? F.readName(bodies.get(i)).trim() : "It's GP-150" })); },
    readPresetByIndex: async (i) => {
      requests.push(i);
      if (failSlots.has(i)) throw new Error("timeout");
      return bodies.get(i) || patch(i, "It's GP-150");
    },
  };
}
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
globalThis.WebMidiGP150 = fakePedal();
globalThis.GP150Format = F;

function fresh() {
  delete require.cache[resolve(here, "../static/gp150_usage.js")];
  return require(resolve(here, "../static/gp150_usage.js"));
}

// --- decoding
let U = fresh(); U.configure({ settleMs: 0 });
assert.deepEqual(
  (({ st, nam, ir }) => ({ st, nam, ir }))(U.decodeBody(patch(0, "A", { ns: fx(15, 0, 0, 2), cab: fx(10, 16, 0, 4) }))),
  { st: 3, nam: null, ir: 5 });
assert.deepEqual((({ st, nam }) => ({ st, nam }))(U.decodeBody(patch(0, "A", { ns: fx(16, 0, 0, 0) }))), { st: null, nam: 1 });
const fac = U.decodeBody(patch(0, "A", { ns: fx(6, 0, 0, 3), cab: fx(10, 0, 0, 7) }));
assert.deepEqual([fac.st, fac.nam, fac.ir], [null, null, null], "factory algorithms are not catalog references");
const real = U.decodeBody(new Uint8Array(readFileSync(resolve(repo, "re/gp150_captures/param_edits/200-Its GP150_NS.prst"))));
assert.equal(real.st, 3, "real capture: SnapTone slot 3");

// --- full scan, then queries
bodies.set(0, patch(0, "Alpha", { ns: fx(15, 0, 0, 2) }));            // SnapTone 3
bodies.set(9, patch(9, "Beta", { ns: fx(15, 0, 0, 2), nsOn: false })); // SnapTone 3, bypassed
bodies.set(10, patch(10, "Gamma", { cab: fx(10, 16, 0, 0) }));         // IR 1
await U.load();
assert.equal(requests.length, 200, "first load reads all 200 presets, one request each");
assert.equal(U.isComplete(), true);
assert.deepEqual(U.get("st", 3).map((x) => [x.slot, x.name, x.enabled]), [[1, "Alpha", true], [10, "Beta", false]]);
assert.equal(U.count("ir", 1), 1);
assert.equal(U.count("st", 4), 0);
assert.equal(U.getStatus().state, "ready");

// --- cache restored by a new session: only changed names are read
await new Promise((r) => setTimeout(r, 700)); // debounced save
assert.ok(store.get("gp150.usage.v1"), "cache written");
U = fresh(); U.configure({ settleMs: 0 });
assert.equal(U.isComplete(), true, "cache restored");
requests = [];
bodies.set(20, patch(20, "Delta", { ns: fx(15, 0, 0, 3) })); // renamed on the pedal
await U.load();
assert.deepEqual(requests, ["names", 20], "names list + the one slot whose name changed");
assert.equal(U.count("st", 4), 1);

// --- live update / own write
U.applyBody(patch(0, "Alpha", { ns: fx(15, 0, 0, 7) }));
assert.equal(U.count("st", 3), 1, "slot 1 no longer uses SnapTone 3");
assert.equal(U.count("st", 8), 1);
U.applyBody(new Uint8Array(10)); // garbage is ignored
await U.onConnected(); // starts the live listener, then a cheap load
assert.equal(typeof live, "function");
live(patch(10, "Gamma", { cab: fx(10, 16, 0, 5) }));
assert.equal(U.count("ir", 6), 1);
assert.equal(U.count("ir", 1), 0);

// --- two consecutive failures stop the scan
U._reset(); store.clear(); requests = []; failSlots = new Set([5, 6]);
await U.load();
assert.equal(U.getStatus().state, "error");
assert.match(U.getStatus().message, /stopped after 2 failed reads/);
assert.equal(requests.length, 7, "slots 1-5 ok, 6th and 7th fail, nothing after");
failSlots = new Set();

// --- exclusive() runs between two requests
U._reset(); store.clear(); requests = [];
const order = [];
const p = U.load({ force: true });
await new Promise((r) => setTimeout(r, 50));
await U.exclusive(async () => { order.push(requests.length); await new Promise((r) => setTimeout(r, 20)); order.push(requests.length); });
assert.equal(order[0], order[1], "no scan request while a user action runs");
await p;
assert.equal(requests.length, 200);
console.log("ok");
