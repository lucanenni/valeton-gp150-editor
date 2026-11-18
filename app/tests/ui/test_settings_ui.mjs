/*
 * The Settings view (explorer page: gp150_settings_ui.js) in jsdom with a fake pedal that keeps its records:
 * read, edit, discard, write (only the edited records are sent, only the edited numbers change), read-back check,
 * and a pedal that does not take the write.
 *
 *   cd app/tests/ui && npm ci && node test_settings_ui.mjs
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
for (const f of ["gp150_settings.js", "ui_core.js"]) w.eval(read(f));
const Set_ = w.GP150Settings;
const reply = JSON.parse(readFileSync(resolve(here, "../fixtures/gp150_globals_reply.json"), "utf8")).stream;

// fake pedal: records live here; sendSetRecord replaces one (unless `ignore`)
const { firmware, records } = Set_.parseGlobalsReply(reply);
const pedal = new Map([...records].map(([k, v]) => [k, Uint8Array.from(v)]));
const sent = []; let ignore = false, reads = 0;
w.WebMidiGP150 = {
  isConnected: () => true, connect: async () => {},
  async readGlobals() { reads++; return { firmware, records: new Map([...pedal].map(([k, v]) => [k, Uint8Array.from(v)])) }; },
  sendSetRecord(cmd, data) { sent.push(cmd); if (!ignore) pedal.set(cmd, Uint8Array.from(data)); },
};
w.GP150Usage = { exclusive: async (fn) => fn() };
w.eval(read("gp150_settings_ui.js"));

const doc = w.document, $ = (id) => doc.getElementById(id);
const tick = (ms = 0) => new Promise((r) => nodeSetTimeout(r, ms));
const click = (el) => el.dispatchEvent(new w.Event("click", { bubbles: true }));
const setField = (name, v) => { const el = $(`gp150-set-${name}`); el.value = String(v); el.dispatchEvent(new w.Event("change", { bubbles: true })); };
async function until(cond, what) { for (let i = 0; i < 400; i++) { if (cond()) return; await tick(5); } throw new Error(`timed out: ${what}`); }
async function confirmOpen() { await until(() => { const o = $("ui-confirm"); return o && !o.hidden; }, "confirm dialog"); const m = $("ui-confirm-msg").textContent; click($("ui-confirm-ok")); return m; }
const toast = () => ($("ui-toast") || {}).textContent || "";

// ---- read
assert.equal($("gp150-settings-write").disabled, true);
click($("gp150-settings-read"));
await until(() => doc.querySelectorAll(".gp150-setting").length > 0, "fields");
assert.equal(doc.querySelectorAll(".gp150-setting").length, 37);
assert.match($("gp150-settings-status").textContent, /Firmware V1\.1\.1 · 37 settings/);
assert.deepEqual([...doc.querySelectorAll(".gp150-settings-group h3")].map((h) => h.textContent), ["Audio", "Recording", "Controls", "MIDI", "Display"]);
assert.equal($("gp150-set-displayTimeout").selectedOptions[0].textContent, "Never");
assert.equal($("gp150-set-btRecLevel").value, "-21", "a value outside the documented range is shown as the pedal has it");

// ---- edit, then discard
setField("brightness", 0);
assert.equal($("gp150-settings-write").textContent, "Write 1 change");
assert.ok($("gp150-set-brightness").closest(".gp150-setting").classList.contains("dirty"));
click($("gp150-settings-revert")); await tick(5);
assert.equal($("gp150-set-brightness").value, "2"); assert.equal($("gp150-settings-write").disabled, true);

// ---- an out-of-range number is refused, nothing is marked as changed
setField("inputLevel", 99);
assert.match($("gp150-settings-error").textContent, /whole number from -20 to 20/); assert.equal($("gp150-settings-write").disabled, true);
assert.equal($("gp150-set-inputLevel").value, "0");

// ---- write two settings in two different records
setField("brightness", 0); setField("inputLevel", -7); setField("globalEq", 1);
assert.equal($("gp150-settings-write").textContent, "Write 3 changes");
const before = new Map([...pedal].map(([k, v]) => [k, Uint8Array.from(v)]));
click($("gp150-settings-write"));
const msg = await confirmOpen();
assert.match(msg, /Display brightness: III → I/); assert.match(msg, /Input level: 0 dB → -7 dB/); assert.match(msg, /Global EQ: Off → On/);
await until(() => /written/.test(toast()), "write toast");
assert.deepEqual([...new Set(sent)].sort(), [0x2010, 0x2020, 0x2050], "only the records that hold an edited setting are sent");
const after = Set_.valuesOf(pedal);
assert.deepEqual([after.brightness, after.inputLevel, after.globalEq], [0, -7, 1]);
for (const [cmd, rec] of pedal) {
  const changed = rec.reduce((n, b, i) => n + (b !== before.get(cmd)[i] ? 1 : 0), 0);
  assert.ok(changed <= 2, `record 0x${cmd.toString(16)}: only the edited numbers changed (${changed} bytes)`);
}
assert.equal($("gp150-settings-write").disabled, true, "nothing left to write");
assert.equal($("gp150-set-brightness").value, "0");

// ---- a pedal that ignores the write is reported
sent.length = 0; ignore = true;
setField("autoSave", 1);
click($("gp150-settings-write")); await confirmOpen();
await until(() => !$("gp150-settings-error").hidden, "error");
assert.match($("gp150-settings-error").textContent, /Auto save reads Off \(wanted On\)/);
assert.equal($("gp150-settings-write").disabled, false, "the unwritten change stays pending");
console.log("ok");
process.exit(0);
