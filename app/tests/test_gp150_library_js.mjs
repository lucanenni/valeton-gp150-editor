/*
 * GP150Zip + GP150Library (app/static/gp150_zip.js, gp150_library.js): zip round trip (stored, and a
 * deflate entry made by node's zlib), model-aware search, backup files, readBackup() validation and
 * new/same/changed comparison, persistence through an injected store.
 *
 *   node app/tests/test_gp150_library_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const S = resolve(here, "../static");
const F = require(resolve(S, "gp150_format.js"));
const Z = require(resolve(S, "gp150_zip.js"));
const L = require(resolve(S, "gp150_library.js"));
const ring = JSON.parse(readFileSync(resolve(S, "data/fxid_ring_gp150.json"), "utf8"));
const skeleton = new Uint8Array(readFileSync(resolve(S, "data/gp150_skeleton.prst")));

function patch(slot0, name, models = {}) {
  const b = new Uint8Array(skeleton);
  b[F.PATCH_INDEX_OFF] = slot0;
  F.writeName(b, name);
  for (const [m, id] of Object.entries(models)) { F.writeModuleModel(b, m, id); F.writeModuleEnabled(b, m, true); }
  return F.fixChecksum(b);
}
const idOf = (module, name) => Number(Object.entries(ring).find(([, e]) => e.module === module && e.name === name)[0]);
const ampName = Object.values(ring).find((e) => e.module === "AMP").name;
const rvbName = Object.values(ring).find((e) => e.module === "RVB").name;
const AMP = idOf("AMP", ampName), RVB = idOf("RVB", rvbName);

// ---- zip
{
  const files = [{ name: "a.prst", data: new Uint8Array([1, 2, 3]) }, { name: "dir/é ü.txt", data: new Uint8Array(1000).fill(7) }];
  const out = await Z.parse(Z.build(files));
  assert.deepEqual(out.map((f) => f.name), ["a.prst", "dir/é ü.txt"]);
  assert.deepEqual([...out[0].data], [1, 2, 3]);
  assert.equal(out[1].data.length, 1000);

  // an entry compressed by another tool (deflate, method 8) still opens
  const raw = new Uint8Array(500).map((_, i) => i % 5), comp = deflateRawSync(raw);
  const built = Z.build([{ name: "x.bin", data: raw }]);
  const dv = new DataView(built.buffer);
  const patched = new Uint8Array(built.length - raw.length + comp.length);
  patched.set(built.subarray(0, 30 + 5)); patched.set(comp, 35);
  const rest = built.subarray(35 + raw.length);
  patched.set(rest, 35 + comp.length);
  const pdv = new DataView(patched.buffer);
  pdv.setUint16(8, 8, true); pdv.setUint32(18, comp.length, true);                    // local header
  const cd = 35 + comp.length;
  pdv.setUint16(cd + 10, 8, true); pdv.setUint32(cd + 20, comp.length, true);         // central header
  pdv.setUint32(patched.length - 6, cd, true);                                         // eocd: directory offset
  const got = await Z.parse(patched);
  assert.deepEqual([...got[0].data], [...raw]);

  const bad = Z.build(files); bad[40] ^= 0xff;
  await assert.rejects(Z.parse(bad), /CRC|corrupt/);
  await assert.rejects(Z.parse(new Uint8Array(40)), /not a zip/);
}

// ---- library: store, search
const store = L.memoryStore();
await L.init({ store, ring });
assert.equal(L.count(), 0);
L.put(0, patch(0, "Clean Sparkle", { AMP }));
L.put(11, patch(11, "Lead Plexi", { AMP, RVB }));
L.put(12, patch(12, "Ambient", { RVB }));
await L.whenReady(); await new Promise((r) => setTimeout(r, 10));
assert.equal(L.count(), 3);
assert.equal(L.put(11, patch(11, "Lead Plexi", { AMP, RVB })), false, "identical body: no write");
assert.deepEqual(L.search("plexi").map((s) => s.slot), [12]);
assert.deepEqual(L.search(ampName).map((s) => s.slot), [1, 12]);
assert.deepEqual(L.search(`${ampName} ${rvbName}`).map((s) => s.slot), [12]);
assert.deepEqual(L.search("012").map((x) => x.slot), [12], "a number matches the slot, zero-padded or not");
assert.deepEqual(L.search("clean 1").map((x) => x.slot), [1]);
assert.equal(L.search("").length, 3);
assert.deepEqual(L.search("nothing like this"), []);
const s12 = L.summary(11);
assert.equal(s12.name, "Lead Plexi");
assert.ok(s12.chain.some((c) => c.mod === "AMP" && c.label === ampName && c.on));
// SnapTone / NAM / IR references are named by slot
{
  const b = patch(20, "Cap", {}); F.writeModuleModel(b, "NS", ((0x0f << 24) | 4) >>> 0); F.writeModuleEnabled(b, "NS", true);
  F.writeModuleModel(b, "CAB", ((0x0a << 24) | (0x10 << 16) | 2) >>> 0); F.fixChecksum(b);
  L.put(20, b);
  assert.deepEqual(L.search("snapetone").length, 0);
  assert.deepEqual(L.search("snaptone 5").map((x) => x.slot), [21]);
  assert.deepEqual(L.search("user ir 3").map((x) => x.slot), [21]);
}

// ---- persistence
await new Promise((r) => setTimeout(r, 10));
L._reset();
await L.init({ store, ring });
assert.equal(L.count(), 4, "bodies come back from the store");
assert.equal(L.summary(11).name, "Lead Plexi");

// ---- backup: valid .prst files named NNN - Name.prst
const odd = patch(30, 'a/b:c*"?', {}); // illegal filename characters
L.put(30, odd);
const zip = L.buildBackup();
const entries = await Z.parse(zip);
assert.equal(entries.length, 5);
assert.ok(entries.every((e) => /^\d{3} - .+\.prst$/.test(e.name)));
assert.ok(entries.every((e) => F.isGp150(e.data) && F.checksumOk(e.data)), "every file is a valid .prst");
assert.ok(entries.some((e) => e.name === "012 - Lead Plexi.prst"));
assert.ok(entries.some((e) => e.name === "031 - a_b_c___.prst"), entries.map((e) => e.name).join("|"));
assert.equal(L.buildBackup({ slots: [0, 11] }).length < zip.length, true);
assert.throws(() => L.buildBackup({ slots: [100] }), /nothing to back up/);

// ---- readBackup: zip + loose files, validation, comparison with the library
{
  const changed = patch(11, "Lead Plexi 2", { AMP, RVB });
  const fresh = patch(40, "Brand new", { RVB });
  const src = Z.build([
    ...entries.filter((e) => e.name.startsWith("001")),
    { name: "x/012.prst", data: changed },
    { name: "__MACOSX/._junk.prst", data: new Uint8Array(4) },
    { name: "notes.txt", data: new Uint8Array(3) },
    { name: "short.prst", data: new Uint8Array(100) },
  ]);
  const { items, skipped } = await L.readBackup([{ name: "b.zip", data: src }, { name: "041.prst", data: fresh }]);
  assert.deepEqual(items.map((i) => [i.slot, i.status]), [[0, "same"], [11, "changed"], [40, "new"]]);
  assert.ok(items.every((i) => i.checksumOk));
  assert.deepEqual(skipped.map((s) => s.file).sort(), ["notes.txt", "short.prst"]);
  assert.match(skipped.find((s) => s.file === "short.prst").reason, /not a GP-150/);

  // a body whose checksum is stale is flagged
  const stale = patch(50, "Stale", {}); stale[0x100] ^= 1;
  const r2 = await L.readBackup([{ name: "s.prst", data: stale }]);
  assert.equal(r2.items[0].checksumOk, false);
  assert.deepEqual((await L.readBackup([{ name: "bad.zip", data: new Uint8Array([0x50, 0x4b, 1, 2, 3]) }])).skipped.length, 1);
}

// ---- writeBackup: a fake pedal that stores what it is sent
{
  L._reset(); await L.init({ store: L.memoryStore(), ring });
  const applied = [];
  const usage = { exclusive: async (fn) => fn(), applyBody: (b) => applied.push(F.readPatchIndex(b)) };
  const stored = new Map(), sent = [];
  const mkPedal = ({ drop = new Set(), failNames = 0 } = {}) => ({
    sendWritePreset(body, slot) { sent.push(slot); if (!drop.has(slot)) stored.set(slot, new Uint8Array(body)); },
    async readAllNames() {
      if (failNames-- > 0) throw new Error("timeout");
      return Array.from({ length: 200 }, (_, i) => ({ index: i, name: stored.has(i) ? F.readName(stored.get(i)) : "It's GP-150" }));
    },
  });
  const items = [3, 7, 9].map((slot) => { const b = patch(slot, `P${slot}`, { AMP }); b[0x10] ^= 0x55; return { slot, name: `P${slot}`, body: b }; }); // stale checksum on purpose
  const noSleep = () => Promise.resolve();
  const progress = [];
  const ok = await L.writeBackup(items, { pedal: mkPedal({ failNames: 1 }), usage, sleep: noSleep, onProgress: (p) => progress.push(p.phase) });
  assert.deepEqual(sent, [3, 7, 9], "written in order");
  assert.ok([...stored.values()].every((b) => F.checksumOk(b)), "the checksum is rewritten before sending");
  assert.deepEqual(ok.written, [3, 7, 9]); assert.deepEqual(ok.failed, []);
  assert.deepEqual(applied, [3, 7, 9], "used-by list kept in step");
  assert.deepEqual(L.search("p7").map((x) => x.slot), [8], "library updated from the verified write");
  assert.deepEqual(progress.filter((p) => p === "write").length, 3); assert.equal(progress.at(-1), "verify");

  // the check read fails twice, then works: still verified; fails three times: an error that says the presets were sent
  const slow = await L.writeBackup(items, { pedal: mkPedal({ failNames: 2 }), usage: null, sleep: noSleep });
  assert.deepEqual(slow.written, [3, 7, 9]);
  await assert.rejects(L.writeBackup(items, { pedal: mkPedal({ failNames: 3 }), usage: null, sleep: noSleep }), /were sent, but the pedal didn't answer/);

  // a slot that does not read back is reported, and left out of the library
  sent.length = 0; stored.clear();
  const bad = await L.writeBackup(items, { pedal: mkPedal({ drop: new Set([7]) }), usage: null, sleep: noSleep });
  assert.deepEqual(bad.written, [3, 9]);
  assert.deepEqual(bad.failed.map((f) => [f.slot, f.expected, f.got]), [[7, "P7", "It's GP-150"]]);

  // a failing send stops the run
  await assert.rejects(L.writeBackup(items, { pedal: { sendWritePreset(b, slot) { if (slot === 7) throw new Error("not connected"); sent.push(slot); }, readAllNames: async () => [] }, sleep: noSleep }), /not connected/);
}

// ---- stars, tags, setlists, persistence
{
  const st = L.memoryStore();
  L._reset(); await L.init({ store: st, ring });
  L.put(0, patch(0, "Clean Sparkle", { AMP })); L.put(11, patch(11, "Lead Plexi", { AMP, RVB })); L.put(12, patch(12, "Ambient", { RVB }));
  L.setStar(11, true); L.setTags(11, ["Rock", " rock ", "lead solo"]); L.setTags(0, ["clean"]);
  assert.deepEqual(L.getMeta(11), { star: true, tags: ["Rock", "rock", "lead solo"] }, "tags keep their case; exact duplicates only");
  assert.deepEqual(L.search("", { starred: true }).map((x) => x.slot), [12]);
  assert.deepEqual(L.search("", { tag: "ROCK" }).map((x) => x.slot), [12], "tag filter ignores case");
  assert.deepEqual(L.search("solo").map((x) => x.slot), [12], "tags are searched like names");
  assert.deepEqual(L.allTags().map((t) => t.tag), ["clean", "lead solo", "rock", "Rock"].sort((a, b) => a.localeCompare(b)));
  assert.equal(L.summary(11).star, true);
  const id = L.createSetlist("Friday gig"); L.setlistAdd(id, 11); L.setlistAdd(id, 0); L.setlistAdd(id, 12);
  L.setlistMove(id, 2, 0); assert.deepEqual(L.listSetlists()[0].slots, [12, 11, 0]);
  L.setlistRemove(id, 1); assert.deepEqual(L.listSetlists()[0].slots, [12, 0]);
  L.renameSetlist(id, "Saturday"); assert.equal(L.listSetlists()[0].name, "Saturday");
  assert.throws(() => L.setlistAdd(id, 500), /range/);
  await new Promise((r) => setTimeout(r, 10));
  L._reset(); await L.init({ store: st, ring });
  assert.equal(L.getMeta(0).tags[0], "clean"); assert.equal(L.listSetlists()[0].name, "Saturday"); assert.deepEqual(L.listSetlists()[0].slots, [12, 0]);

  // backup carries the meta file; readBackup hands it back; merge keeps what is there
  const zip2 = L.buildBackup();
  const names2 = (await Z.parse(zip2)).map((e) => e.name);
  assert.ok(names2.includes("gp150-library.json"));
  L._reset(); await L.init({ store: L.memoryStore(), ring });
  L.put(0, patch(0, "Clean Sparkle", { AMP })); L.setTags(0, ["mine"]);
  const rb = await L.readBackup([{ name: "b.zip", data: zip2 }]);
  assert.equal(rb.skipped.length, 0); assert.equal(rb.meta.tagged, 2); assert.equal(rb.meta.setlists, 1);
  assert.deepEqual(L.getMeta(0).tags, ["mine"], "reading a backup changes nothing by itself");
  L.applyMeta(rb.meta.data, { mode: "merge" });
  assert.deepEqual(L.getMeta(0).tags.sort(), ["clean", "mine"]);
  L.applyMeta(rb.meta.data, { mode: "replace" });
  assert.deepEqual(L.getMeta(0).tags, ["clean"]);
}

// ---- slot operations: plans, then a simulated pedal
{
  L._reset(); await L.init({ store: L.memoryStore(), ring });
  const blank = patch(150, "It's GP-150", {}); for (const m of ["NS", "AMP", "NR", "CAB", "EQ", "MOD", "DLY", "RVB"]) F.writeModuleEnabled(blank, m, false); F.writeModuleEnabled(blank, "VOL", true); F.fixChecksum(blank); // VOL stays on, as on the pedal
  L.put(150, blank);
  L.put(3, patch(3, "Three", { AMP })); L.put(7, patch(7, "Seven", { RVB }));
  L.setStar(3, true); L.setTags(7, ["b"]);
  const id = L.createSetlist("S"); L.setlistAdd(id, 3); L.setlistAdd(id, 7);

  const cp = L.planSlotOp("copy", 3, 7);
  assert.deepEqual(cp.items.map((i) => [i.slot, i.name, F.readPatchIndex(i.body), F.checksumOk(i.body)]), [[7, "Three", 7, true]]);
  assert.deepEqual(cp.overwritten.map((o) => o.name), ["Seven"]);
  const sw = L.planSlotOp("swap", 3, 7);
  assert.deepEqual(sw.items.map((i) => [i.slot, i.name]), [[7, "Three"], [3, "Seven"]]);
  assert.deepEqual(sw.mapping, { 3: 7, 7: 3 });
  const mv = L.planSlotOp("move", 3, 7);
  assert.deepEqual(mv.items.map((i) => [i.slot, i.name]), [[7, "Three"], [3, "It's GP-150"]], "the source is left empty");
  assert.equal(F.readPatchIndex(mv.items[1].body), 3);
  assert.throws(() => L.planSlotOp("copy", 3, 3), /different/);
  assert.throws(() => L.planSlotOp("copy", 99, 3), /isn't in the library/);
  assert.throws(() => L.planSlotOp("swap", 3, 120), /isn't in the library/);
  assert.throws(() => L.planSlotOp("shuffle", 3, 7), /unknown/);
  const rn = L.planRename(3, " Tres ");
  assert.equal(rn.items[0].name, "Tres"); assert.equal(F.readName(rn.items[0].body), "Tres"); assert.ok(F.checksumOk(rn.items[0].body));
  assert.throws(() => L.planRename(3, "far too long for the pedal"), /13/);
  assert.throws(() => L.planRename(3, "café"), /ASCII/);
  assert.throws(() => L.planRename(3, "  "), /empty/);

  // run a swap through writeBackup on a fake pedal, then remap: the pedal, the library and the meta agree
  const stored = new Map([[3, L.get(3)], [7, L.get(7)]]);
  const pedal = { sendWritePreset(b, slot) { stored.set(slot, new Uint8Array(b)); }, async readAllNames() { return Array.from({ length: 200 }, (_, i) => ({ index: i, name: stored.has(i) ? F.readName(stored.get(i)) : "It's GP-150" })); } };
  const noSleep = () => Promise.resolve();
  const r = await L.writeBackup(sw.items, { pedal, sleep: noSleep });
  assert.deepEqual(r.failed, []); L.remap(sw.mapping);
  assert.equal(L.summary(7).name, "Three"); assert.equal(L.summary(3).name, "Seven");
  assert.equal(L.getMeta(7).star, true, "the star followed the preset"); assert.deepEqual(L.getMeta(3).tags, ["b"]);
  assert.deepEqual(L.listSetlists()[0].slots, [7, 3], "setlist entries followed the presets");
  // move: tags travel, the destination's own are dropped, the source is empty
  L.remap(L.planSlotOp("move", 7, 3).mapping);
  assert.equal(L.getMeta(3).star, true); assert.deepEqual(L.getMeta(7).tags, []);
  assert.deepEqual(L.listSetlists()[0].slots, [3, 3]);
  L.copyMeta(3, 9); assert.equal(L.getMeta(9).star, true);
}

await L.clear();
assert.equal(L.count(), 0);
console.log("ok");
