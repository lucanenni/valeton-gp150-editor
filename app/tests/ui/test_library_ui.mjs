/*
 * The Library view (explorer page: gp150_library_ui.js) driven in jsdom with a fake pedal: stars, tags,
 * filters, the actions menu (rename / copy / swap / move / add to setlist), setlists and stage mode, and
 * a restore that carries stars, tags and setlists. No browser, no hardware.
 *
 *   cd app/tests/ui && npm ci && node test_library_ui.mjs
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
w.setTimeout = (fn, ms, ...a) => nodeSetTimeout(fn, ms >= 100 ? 0 : ms, ...a);   // the pedal's settle delays are not what is tested
Object.assign(w, { TextEncoder, TextDecoder, Uint8Array, Blob, Response });
w.fetch = async (url) => ({ json: async () => JSON.parse(read("data/fxid_ring_gp150.json")), ok: true, url });
const run = (file) => w.eval(read(file));
for (const f of ["gp150_format.js", "gp150_zip.js", "gp150_library.js", "ui_core.js"]) run(f);

// ---- fake pedal and usage -------------------------------------------------------------------
const F = w.GP150Format, L = w.GP150Library, Z = w.GP150Zip;
const skeleton = new Uint8Array(readFileSync(resolve(S, "data/gp150_skeleton.prst")));
const ring = JSON.parse(read("data/fxid_ring_gp150.json"));
const idOf = (module, i) => Number(Object.entries(ring).filter(([, e]) => e.module === module)[i][0]);
function patch(slot0, name, models = {}) {
  const b = new Uint8Array(skeleton);
  b[F.PATCH_INDEX_OFF] = slot0; F.writeName(b, name);
  for (const m of ["NS", "AMP", "NR", "CAB", "EQ", "MOD", "DLY", "RVB"]) F.writeModuleEnabled(b, m, false);
  for (const [m, id] of Object.entries(models)) { F.writeModuleModel(b, m, id); F.writeModuleEnabled(b, m, true); }
  F.writeModuleEnabled(b, "VOL", true);
  return F.fixChecksum(b);
}
const stored = new Map(), sent = [], selected = [];
w.WebMidiGP150 = {
  isConnected: () => true, connect: async () => {},
  sendWritePreset(body, slot) { sent.push(slot); stored.set(slot, new Uint8Array(body)); },
  async readAllNames() { return Array.from({ length: 200 }, (_, i) => ({ index: i, name: stored.has(i) ? F.readName(stored.get(i)) : "It's GP-150" })); },
  selectPreset(slot) { selected.push(slot); },
};
const applied = [];
w.GP150Usage = {
  onBody() {}, guard() {}, on() {}, getStatus: () => ({ state: "ready", message: "" }), onConnected() {}, cancel() {}, rescan() {},
  exclusive: async (fn) => fn(), applyBody: (b) => applied.push(F.readPatchIndex(b)),
};
w.GP150UI = { openBody() {} };

await L.init({ ring });
const seed = [
  [0, "Clean Sparkle", { AMP: idOf("AMP", 0) }], [1, "Lead Plexi", { AMP: idOf("AMP", 1), RVB: idOf("RVB", 0) }],
  [2, "Ambient", { RVB: idOf("RVB", 1) }], [10, "It's GP-150", {}], [150, "It's GP-150", {}],
];
for (const [slot, name, models] of seed) { const b = patch(slot, name, models); L.put(slot, b); stored.set(slot, b); }
run("gp150_library_ui.js");

const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);   // values made inside the jsdom window have its own Array
// ---- helpers --------------------------------------------------------------------------------
const doc = w.document;
const $ = (id) => doc.getElementById(id);
const tick = (ms = 0) => new Promise((r) => nodeSetTimeout(r, ms));
const settle = async () => { await tick(10); await tick(10); };
const rows = () => [...doc.querySelectorAll("#gp150-lib-list .gp150-lib-row")];
const rowOf = (slot1) => rows().find((r) => r.querySelector(".gp150-lib-slot").textContent === String(slot1).padStart(3, "0"));
const names = () => rows().map((r) => r.querySelector(".gp150-lib-name").textContent);
const click = (el) => el.dispatchEvent(new w.Event("click", { bubbles: true }));
async function dialogOpen() { for (let i = 0; i < 200; i++) { const o = $("ui-confirm"); if (o && !o.hidden) return o; await tick(5); } throw new Error("no dialog appeared"); }
async function answer(value) {   // fills the open prompt/confirm dialog and accepts it
  const o = await dialogOpen();
  const msg = $("ui-confirm-msg").textContent;
  const input = o.querySelector(".modal-input");
  if (input && value != null) input.value = value;
  click($("ui-confirm-ok"));
  await tick(5);
  return msg;
}
async function action(slot1, name) {
  const sel = rowOf(slot1).querySelector(".gp150-lib-actions");
  sel.value = name; sel.dispatchEvent(new w.Event("change", { bubbles: true }));
}
async function untilToast(re) { for (let i = 0; i < 400; i++) { const t = $("ui-toast"); if (t && re.test(t.textContent)) return t.textContent; if (!$("gp150-lib-error").hidden) throw new Error($("gp150-lib-error").textContent); await tick(5); } throw new Error(`no toast matching ${re}`); }

// ---- list, search, stars --------------------------------------------------------------------
await settle();
assert.deepEqual(names(), ["Clean Sparkle", "Lead Plexi", "Ambient", "It's GP-150", "It's GP-150"]);
assert.match($("gp150-lib-status").textContent, /5\/200/);
$("gp150-lib-search").value = "plexi"; $("gp150-lib-search").dispatchEvent(new w.Event("input"));
assert.deepEqual(names(), ["Lead Plexi"]);
$("gp150-lib-search").value = ""; $("gp150-lib-search").dispatchEvent(new w.Event("input"));

click(rowOf(2).querySelector(".gp150-lib-star")); await settle();
assert.equal(rowOf(2).querySelector(".gp150-lib-star").getAttribute("aria-pressed"), "true");
$("gp150-lib-starred").checked = true; $("gp150-lib-starred").dispatchEvent(new w.Event("change"));
assert.deepEqual(names(), ["Lead Plexi"]);
$("gp150-lib-starred").checked = false; $("gp150-lib-starred").dispatchEvent(new w.Event("change"));

// ---- tags: through the actions menu, then the tag menu and the chips ----------------------------
await action(2, "tags"); await answer("rock, lead"); await settle();
assert.deepEqual([...rowOf(2).querySelectorAll(".gp150-lib-tag")].map((b) => b.textContent), ["rock", "lead"]);
assert.deepEqual([...$("gp150-lib-tag").options].map((o) => o.value), ["", "lead", "rock"]);
$("gp150-lib-tag").value = "rock"; $("gp150-lib-tag").dispatchEvent(new w.Event("change"));
assert.deepEqual(names(), ["Lead Plexi"]);
$("gp150-lib-tag").value = ""; $("gp150-lib-tag").dispatchEvent(new w.Event("change"));
$("gp150-lib-search").value = "lead"; $("gp150-lib-search").dispatchEvent(new w.Event("input"));
assert.deepEqual(names(), ["Lead Plexi"], "tags are searched too");
$("gp150-lib-search").value = ""; $("gp150-lib-search").dispatchEvent(new w.Event("input"));

// ---- copy: confirmation names what is overwritten; stars and tags are copied -------------------
await action(2, "copy");
assert.match(await answer("11"), /Copy 002 “Lead Plexi” to slot/);
const confirmText = await answer();
assert.match(confirmText, /slot 11 “It's GP-150” will be overwritten/);
await untilToast(/Copy 2 → 11: done/);
assert.deepEqual(sent, [10]);
assert.equal(F.readName(stored.get(10)), "Lead Plexi"); assert.equal(F.readPatchIndex(stored.get(10)), 10);
assert.ok(F.checksumOk(stored.get(10)));
await settle();
assert.equal(L.summary(10).name, "Lead Plexi"); eq(L.getMeta(10).tags, ["rock", "lead"]); assert.deepEqual(applied, [10]);

// ---- swap, with tags following -----------------------------------------------------------------
sent.length = 0;
await action(1, "swap"); await answer("3"); await answer();
await untilToast(/Swap 1 ↔ 3: done/);
assert.deepEqual(sent, [2, 0]);
await settle();
assert.equal(L.summary(0).name, "Ambient"); assert.equal(L.summary(2).name, "Clean Sparkle");

// ---- move: the source is left empty, tags travel ------------------------------------------------
sent.length = 0;
await action(2, "move"); await answer("20"); const mvMsg = await answer();
assert.match(mvMsg, /“Lead Plexi \(left empty\)”/);
await untilToast(/Move 2 → 20: done/);
await settle();
assert.equal(L.summary(1).name, "It's GP-150"); assert.equal(L.summary(19).name, "Lead Plexi");
eq(L.getMeta(19).tags, ["rock", "lead"]); assert.equal(L.getMeta(19).star, true); eq(L.getMeta(1).tags, []);

// ---- rename: 13-character limit is enforced before anything is sent --------------------------------
sent.length = 0;
await action(1, "rename"); await answer("a name that is far too long");
await settle();
assert.match($("gp150-lib-error").textContent, /at most 13/); assert.deepEqual(sent, []);
await action(1, "rename"); await answer("Dream"); await answer();
await untilToast(/Rename: done/);
assert.equal(F.readName(stored.get(0)), "Dream");
await settle(); assert.equal(rowOf(1).querySelector(".gp150-lib-name").textContent, "Dream");

// ---- a write that the pedal does not take is reported, not hidden -----------------------------
{
  const orig = w.WebMidiGP150.sendWritePreset;
  w.WebMidiGP150.sendWritePreset = () => {};   // the pedal ignores it
  await action(3, "copy"); await answer("30"); await answer();
  for (let i = 0; i < 200 && $("gp150-lib-error").hidden; i++) await tick(5);
  assert.match($("gp150-lib-error").textContent, /slot 30 reads “It's GP-150”, expected “Clean Sparkle”/);
  w.WebMidiGP150.sendWritePreset = orig;
  assert.equal(L.get(29), null, "an unverified slot is not put in the library");
}

// ---- setlists and stage mode ---------------------------------------------------------------------
await action(1, "setlist"); await answer("Friday");               // creates it
await action(3, "setlist"); await answer("friday");                // finds it by name, any case
await action(20, "setlist"); await answer("Friday");
await settle();
eq(L.listSetlists()[0].slots, [0, 2, 19]);
const sl = $("gp150-lib-setlists");
const sel = sl.querySelector("select");
assert.equal(sel.value, String(L.listSetlists()[0].id), "the setlist just used is shown");
const entries = () => [...sl.querySelectorAll(".gp150-lib-setlist .gp150-lib-row")].map((li) => li.querySelectorAll(".gp150-lib-name")[0].textContent);
assert.deepEqual(entries(), ["Dream", "Clean Sparkle", "Lead Plexi"]);
click([...sl.querySelectorAll(".gp150-lib-setlist button")].find((b) => b.title === "Move down")); await settle();
assert.deepEqual(entries(), ["Clean Sparkle", "Dream", "Lead Plexi"]);
click([...sl.querySelectorAll(".gp150-lib-setlist button")].filter((b) => b.title === "Remove from the setlist")[1]); await settle();
eq(L.listSetlists()[0].slots, [2, 19]);

selected.length = 0;
click([...sl.querySelectorAll("button")].find((b) => b.textContent === "Stage mode")); await settle();
assert.deepEqual(selected, [2], "stage mode selects the first preset on the pedal");
assert.match(sl.querySelector(".gp150-lib-stage").textContent, /Friday · 1 \/ 2Clean SparkleSlot 003Next: Lead Plexi/);
w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await settle();
assert.deepEqual(selected, [2, 19]);
assert.match(sl.querySelector(".gp150-lib-stage").textContent, /2 \/ 2Lead Plexi/);
w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await settle();
assert.deepEqual(selected, [2, 19], "no step past the end");
w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
assert.equal(sl.querySelector(".gp150-lib-stage"), null);

// ---- backup, then a restore that brings stars, tags and setlists along -----------------------------
{
  const zip = L.buildBackup();
  const entriesZ = await Z.parse(zip);
  assert.ok(entriesZ.some((e) => e.name === "gp150-library.json"));
  // wipe the local extras, then restore from the zip
  for (const s of L.listSetlists()) L.deleteSetlist(s.id);
  L.setStar(19, false); L.setTags(19, []); L.setTags(10, []);
  await settle();
  const input = $("gp150-lib-restore-input");
  Object.defineProperty(input, "files", { value: [{ name: "b.zip", arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) }], configurable: true });
  input.dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 200 && $("gp150-lib-restore").hidden; i++) await tick(5);
  assert.equal($("gp150-lib-restore").hidden, false);
  assert.equal($("gp150-lib-restore-meta").hidden, false);
  assert.match($("gp150-lib-restore-meta-text").textContent, /stars and tags .* and 1 setlist/);
  for (const cb of doc.querySelectorAll("#gp150-lib-restore-list input[type=checkbox]")) { cb.checked = false; cb.dispatchEvent(new w.Event("change")); }
  assert.equal($("gp150-lib-restore-go").textContent, "Restore tags and setlists only");
  click($("gp150-lib-restore-go")); await settle();
  assert.equal(L.listSetlists().length, 1); eq(L.getMeta(19).tags, ["rock", "lead"]);
  assert.equal($("gp150-lib-restore").hidden, true);
}

console.log("ok");
process.exit(0);
