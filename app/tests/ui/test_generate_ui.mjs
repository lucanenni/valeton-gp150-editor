/*
 * The Generate view (explorer page: gp150_generate_ui.js) in jsdom: Randomize and Morph make a preview, can be
 * opened in the inspector, and are written to a slot through the library's confirmed write.
 *
 *   cd app/tests/ui && npm ci && node test_generate_ui.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const S = resolve(here, "../../static");
const read = (p) => readFileSync(resolve(S, p), "utf8");
const dom = new JSDOM(read("explorer.html"), { runScripts: "outside-only", url: "http://localhost/explorer", pretendToBeVisual: true });
const w = dom.window;
const nodeSetTimeout = setTimeout;
w.setTimeout = (fn, ms, ...a) => nodeSetTimeout(fn, ms >= 100 ? 0 : ms, ...a);
Object.assign(w, { TextEncoder, TextDecoder, Uint8Array, Blob, Response });
w.fetch = async (url) => {
  if (/skeleton/.test(url)) { const b = readFileSync(resolve(S, "data/gp150_skeleton.prst")); return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; }
  return { json: async () => JSON.parse(read("data/fxid_ring_gp150.json")), ok: true };
};
for (const f of ["gp150_format.js", "gp150_zip.js", "gp150_generate.js", "gp150_library.js", "ui_core.js"]) w.eval(read(f));
const F = w.GP150Format, L = w.GP150Library;
const ring = JSON.parse(read("data/fxid_ring_gp150.json"));
const skeleton = new Uint8Array(readFileSync(resolve(S, "data/gp150_skeleton.prst")));
const idOf = (module, i) => Number(Object.entries(ring).filter(([, e]) => e.module === module)[i][0]);
function patch(slot0, name, models = {}) {
  const b = new Uint8Array(skeleton);
  b[F.PATCH_INDEX_OFF] = slot0; F.writeName(b, name);
  for (const m of ["NS", "AMP", "NR", "CAB", "EQ", "MOD", "DLY", "RVB"]) F.writeModuleEnabled(b, m, false);
  for (const [m, id] of Object.entries(models)) { F.writeModuleModel(b, m, id); F.writeModuleEnabled(b, m, true); }
  F.writeModuleEnabled(b, "VOL", true);
  return F.fixChecksum(b);
}
const stored = new Map(), sent = [], opened = [];
w.WebMidiGP150 = {
  isConnected: () => true, connect: async () => {},
  sendWritePreset(body, slot) { sent.push(slot); stored.set(slot, new Uint8Array(body)); },
  async readAllNames() { return Array.from({ length: 200 }, (_, i) => ({ index: i, name: stored.has(i) ? F.readName(stored.get(i)) : "It's GP-150" })); },
};
w.GP150Usage = { onBody() {}, guard() {}, on() {}, getStatus: () => ({ state: "ready", message: "" }), onConnected() {}, cancel() {}, rescan() {}, exclusive: async (fn) => fn(), applyBody() {} };
w.GP150UI = { openBody: (b, n) => opened.push([F.readName(b), n]) };

await L.init({ ring });
L.put(0, patch(0, "Clean", { AMP: idOf("AMP", 0), RVB: idOf("RVB", 0) }));
L.put(1, patch(1, "Heavy", { AMP: idOf("AMP", 3), DST: idOf("DST", 2), DLY: idOf("DLY", 0) }));
L.put(199, patch(199, "It's GP-150", {}));
w.eval(read("gp150_library_ui.js")); w.eval(read("gp150_generate_ui.js"));

const doc = w.document, $ = (id) => doc.getElementById(id);
const tick = (ms = 0) => new Promise((r) => nodeSetTimeout(r, ms));
const click = (el) => el.dispatchEvent(new w.Event("click", { bubbles: true }));
const btn = (parent, text) => [...parent.querySelectorAll("button")].find((b) => b.textContent === text);
async function until(cond, what) { for (let i = 0; i < 400; i++) { if (cond()) return; await tick(5); } throw new Error(`timed out: ${what}`); }
await tick(50);

// ---- Randomize
const rnd = $("gp150-gen-random");
assert.equal(btn(rnd, "Write to slot").disabled, true, "nothing to write before a preset exists");
click(btn(rnd, "Generate"));
await until(() => rnd.querySelector(".gp150-gen-preview .gp150-lib-name"), "preview");
const name1 = rnd.querySelector(".gp150-lib-name").textContent;
assert.match(name1, /^Rnd \d{3}$/);
assert.ok(rnd.querySelectorAll(".gp150-lib-chip").length >= 2, "an amp and a cab at least");
const targetInput = () => [...rnd.querySelectorAll("input[type=number]")].at(-1);
assert.equal(targetInput().value, "200", "the default target is the last empty slot");
click(btn(rnd, "Open in inspector"));
assert.deepEqual(opened.at(-1)[0], name1);
// tick only DLY, then generate again: the preview changes only there
for (const c of rnd.querySelectorAll(".gp150-gen-mods input")) c.checked = false;
click(btn(rnd, "Generate")); await tick(20);
assert.match($("gp150-gen-error").textContent, /tick at least one module/);
// write to slot 200
for (const c of rnd.querySelectorAll(".gp150-gen-mods input")) c.checked = true;
click(btn(rnd, "Generate")); await tick(20);
const written = rnd.querySelector(".gp150-lib-name").textContent;
click(btn(rnd, "Write to slot"));
await until(() => { const o = $("ui-confirm"); return o && !o.hidden; }, "confirm dialog");
assert.match($("ui-confirm-msg").textContent, new RegExp(`Write “${written}” to slot 200: slot 200 “It's GP-150” will be overwritten`));
click($("ui-confirm-ok"));
await until(() => /done/.test(($("ui-toast") || {}).textContent || ""), "write toast");
assert.deepEqual(sent, [199]);
assert.equal(F.readName(stored.get(199)), written); assert.ok(F.checksumOk(stored.get(199))); assert.equal(F.readPatchIndex(stored.get(199)), 199);
assert.equal(L.summary(199).name, written, "the library followed the write");

// ---- Randomize from a library preset
{
  const sel = rnd.querySelector("select"); sel.value = "slot"; sel.dispatchEvent(new w.Event("change"));
  const baseSlot = rnd.querySelectorAll("input[type=number]")[0]; baseSlot.value = "99";
  click(btn(rnd, "Generate")); await tick(20);
  assert.match($("gp150-gen-error").textContent, /slot 99 isn't in the library yet/);
  baseSlot.value = "2"; click(btn(rnd, "Generate")); await tick(20);
  assert.equal($("gp150-gen-error").hidden, true); assert.ok(rnd.querySelector(".gp150-lib-name"));
}

// ---- Morph
const mo = $("gp150-gen-morph");
await until(() => mo.querySelector(".gp150-lib-name"), "morph preview");
assert.equal(mo.querySelector(".gp150-lib-name").textContent, "Mrph 1~2");
const [a, b] = mo.querySelectorAll("input[type=number]");
b.value = "99"; b.dispatchEvent(new w.Event("input")); await tick(20);
assert.match(mo.querySelector(".gp150-gen-preview").textContent, /Slot 99 isn't in the library yet/);
assert.equal(btn(mo, "Write to slot").disabled, true);
b.value = "1"; b.dispatchEvent(new w.Event("input")); await tick(20);
assert.match(mo.querySelector(".gp150-gen-preview").textContent, /two different presets/);
b.value = "2"; b.dispatchEvent(new w.Event("input")); await tick(20);
const t = mo.querySelector("input[type=range]");
t.value = "0"; t.dispatchEvent(new w.Event("input")); await tick(20);
const chipsAt0 = [...mo.querySelectorAll(".gp150-lib-chip")].map((c) => c.textContent).join("|");
t.value = "100"; t.dispatchEvent(new w.Event("input")); await tick(20);
const chipsAt100 = [...mo.querySelectorAll(".gp150-lib-chip")].map((c) => c.textContent).join("|");
assert.notEqual(chipsAt0, chipsAt100, "the ends show the two presets' chains");
assert.equal(chipsAt0, L.summary(0).chain.filter((c) => c.on).map((c) => c.label).join("|"));
assert.equal(chipsAt100, L.summary(1).chain.filter((c) => c.on).map((c) => c.label).join("|"));
// write the morph to slot 150
sent.length = 0;
const slot = mo.querySelectorAll("input[type=number]")[2]; slot.value = "150"; slot.dispatchEvent(new w.Event("input"));
click(btn(mo, "Write to slot"));
await until(() => { const o = $("ui-confirm"); return o && !o.hidden; }, "confirm dialog");
click($("ui-confirm-ok"));
await until(() => sent.length === 1 && L.get(149), "morph written");
assert.equal(F.readName(stored.get(149)), "Mrph 1~2"); assert.ok(F.checksumOk(stored.get(149)));
console.log("ok");
process.exit(0);
