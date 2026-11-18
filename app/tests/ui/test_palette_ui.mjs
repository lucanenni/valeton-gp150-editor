/*
 * The command palette (explorer page: gp150_palette.js) in jsdom: Ctrl+K opens it, typing finds presets (name, slot,
 * model, tag) and actions, Enter / Shift+Enter / click run them, Esc closes and gives the focus back.
 *
 *   cd app/tests/ui && npm ci && node test_palette_ui.mjs
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
w.fetch = async () => ({ json: async () => JSON.parse(read("data/fxid_ring_gp150.json")), ok: true });
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
const selected = [], opened = [], clicks = [];
w.WebMidiGP150 = { isConnected: () => true, connect: async () => {}, selectPreset: (s) => selected.push(s), sendWritePreset() {}, async readAllNames() { return []; } };
w.GP150Usage = { onBody() {}, guard() {}, on() {}, getStatus: () => ({ state: "ready", message: "" }), onConnected() {}, cancel() {}, rescan() {}, exclusive: async (fn) => fn(), applyBody() {} };
w.GP150UI = { openBody: (b, n) => opened.push(F.readName(b)) };
await L.init({ ring });
const amp0 = ring[String(idOf("AMP", 0))].name, amp1 = ring[String(idOf("AMP", 1))].name;
L.put(0, patch(0, "Clean Sparkle", { AMP: idOf("AMP", 0) }));
L.put(4, patch(4, "Lead Plexi", { AMP: idOf("AMP", 1), RVB: idOf("RVB", 0) }));
L.put(7, patch(7, "Ambient", { RVB: idOf("RVB", 1) }));
L.setStar(7, true); L.setTags(4, ["rock"]);
w.eval(read("gp150_library_ui.js")); w.eval(read("gp150_palette.js"));
const doc = w.document;
doc.getElementById("gp150-settings-read").addEventListener("click", () => clicks.push("read-settings"));
doc.getElementById("gp150-lib-backup-all").disabled = false;
doc.getElementById("gp150-lib-backup-all").addEventListener("click", () => clicks.push("backup"));
w.Element.prototype.scrollIntoView = function () { clicks.push(`scroll:${this.id || this.className}`); };
const tick = (ms = 0) => new Promise((r) => nodeSetTimeout(r, ms));
await tick(30);

const P = () => doc.querySelector(".gp150-palette");
const items = () => [...doc.querySelectorAll(".gp150-palette-item")];
const labels = () => items().map((li) => li.querySelector(".gp150-palette-label").textContent);
const key = (el, k, opts = {}) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
const type = (text) => { const i = doc.querySelector(".gp150-palette input"); i.value = text; i.dispatchEvent(new w.Event("input", { bubbles: true })); };
const sel = () => items().findIndex((li) => li.getAttribute("aria-selected") === "true");

// ---- open: starred presets first, then the rest, then actions
const btn = doc.getElementById("gp150-lib-rescan"); btn.focus();
key(doc, "k", { ctrlKey: true });
assert.equal(w.GP150Palette.isOpen(), true);
assert.equal(doc.activeElement, doc.querySelector(".gp150-palette input"));
assert.deepEqual(labels().slice(0, 3), ["008  Ambient", "001  Clean Sparkle", "005  Lead Plexi"], "a starred preset comes first");
assert.ok(labels().includes("Back up all presets (.zip)"));

// ---- find by name, slot, model, tag
type("plexi"); assert.deepEqual(labels(), ["005  Lead Plexi"]);
type("8"); assert.deepEqual(labels(), ["008  Ambient"], "a number matches the slot");
type(amp1); assert.deepEqual(labels(), ["005  Lead Plexi"], "any model in the chain");
type("rock"); assert.deepEqual(labels(), ["005  Lead Plexi"], "tags");
type("zzzz"); assert.equal(items().length, 0); assert.match(P().textContent, /Nothing matches/);

// ---- Enter opens in the inspector, Shift+Enter selects on the pedal
type("clean");
const input = doc.querySelector(".gp150-palette input");
key(input, "Enter");
assert.deepEqual(opened, ["Clean Sparkle"]); assert.equal(w.GP150Palette.isOpen(), false);
assert.ok(clicks.includes("scroll:gp150-results"));
assert.equal(doc.activeElement, btn, "the focus goes back to where it was");
key(doc, "k", { metaKey: true }); type("lead"); key(doc.querySelector(".gp150-palette input"), "Enter", { shiftKey: true });
await tick(20);
assert.deepEqual(selected, [4]); assert.match((doc.getElementById("ui-toast") || {}).textContent, /Selected 005 Lead Plexi on the pedal/);

// ---- arrows wrap, click runs
key(doc, "k", { ctrlKey: true });
const n = items().length; assert.equal(sel(), 0);
key(doc.querySelector(".gp150-palette input"), "ArrowUp"); assert.equal(sel(), n - 1, "wraps to the last");
key(doc.querySelector(".gp150-palette input"), "ArrowDown"); assert.equal(sel(), 0);
key(doc.querySelector(".gp150-palette input"), "ArrowDown"); assert.equal(sel(), 1);
key(doc.querySelector(".gp150-palette input"), "Escape"); assert.equal(w.GP150Palette.isOpen(), false);
key(doc, "k", { ctrlKey: true }); type("sparkle"); items()[0].dispatchEvent(new w.Event("click", { bubbles: true }));
assert.deepEqual(opened.at(-1), "Clean Sparkle");

// ---- actions
clicks.length = 0;
key(doc, "k", { ctrlKey: true }); type("settings"); assert.ok(labels().includes("Read the pedal's settings"));
key(doc.querySelector(".gp150-palette input"), "Enter");   // the first match: "Settings" (go to) or the read action
assert.ok(clicks.some((c) => c === "scroll:gp150-settings"));
key(doc, "k", { ctrlKey: true }); type("backup"); key(doc.querySelector(".gp150-palette input"), "Enter");
assert.ok(clicks.includes("backup"), "the backup button was pressed");

// ---- stage mode for a setlist
const id = L.createSetlist("Friday"); L.setlistAdd(id, 0); L.setlistAdd(id, 4);
await tick(20);
key(doc, "k", { ctrlKey: true }); type("stage friday");
assert.deepEqual(labels(), ["Stage mode: Friday"]);
selected.length = 0;
key(doc.querySelector(".gp150-palette input"), "Enter"); await tick(30);
assert.deepEqual(selected, [0], "stage mode selects the first preset on the pedal");
assert.ok(doc.querySelector(".gp150-lib-stage"), "and shows it");

// ---- a click on the backdrop and Ctrl+K again both close it
key(doc, "k", { ctrlKey: true }); assert.equal(w.GP150Palette.isOpen(), true);
doc.querySelector(".gp150-palette").parentElement.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
assert.equal(w.GP150Palette.isOpen(), false);
key(doc, "k", { ctrlKey: true }); key(doc, "k", { ctrlKey: true }); assert.equal(w.GP150Palette.isOpen(), false);
console.log("ok");
process.exit(0);
