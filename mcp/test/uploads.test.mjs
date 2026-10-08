// Offline checks of the library uploads (no pedal): slot rules, input preparation, the upload flow against a
// fake pedal, and the worker-thread profiler / NAM renderer.
//   cd mcp && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseSlotList, describeLibrary, checkSlot, upload, prepareIr, prepareNam, prepareClo, loadRecording, loadNamModel, cloFromNam, KINDS } from "../lib/uploads.mjs";
import { profileInThread, renderNam, NamWaveNet, NamWaveNetFast, Profiler } from "../lib/threads.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const require = createRequire(import.meta.url);
const W = require(resolve(repo, "app/static/webmidi_gp150.js")).WebMidiGP150;
const tmp = mkdtempSync(join(tmpdir(), "gp150-mcp-"));

// the pedal's real SnapTone list from a capture (slots 1-50 factory written, 51+ never written)
const realList = W._codec.decodeIndexedRecords(Array.from(readFileSync(resolve(repo, "re/gp150_captures/catalog_live/snaptones_2032b.dat"))));
const withSlot = (list, slot, name) => list.map((e) => ((e.index & 0xffff) === slot ? { index: slot, name } : e));

test("slot lists", () => {
  assert.deepEqual([...parseSlotList("52,65-66")], [52, 65, 66]);
  assert.equal(parseSlotList("").size, 0);
  assert.throws(() => parseSlotList("52;65"));
});

test("snapTone slots: factory range, free slots, written slots need the allow-list", () => {
  const lib = describeLibrary("snaptone", realList);
  assert.equal(lib.length, 100);
  assert.equal(lib[0].written, true, "factory SnapTones read as written");
  assert.equal(lib.find((x) => x.slot === 51).written, false);
  assert.equal(checkSlot("snaptone", 51, realList, {}).written, false);
  assert.throws(() => checkSlot("snaptone", 10, realList, {}), /1-50 are factory|must be 51-100/);
  const used = withSlot(realList, 52, "TEST52");
  assert.throws(() => checkSlot("snaptone", 52, used, {}), /already holds "TEST52".*GP150_OVERWRITABLE_SNAPTONE_SLOTS/s);
  assert.equal(checkSlot("snaptone", 52, used, { GP150_OVERWRITABLE_SNAPTONE_SLOTS: "52" }).name, "TEST52");
  assert.throws(() => checkSlot("snaptone", 101, realList, {}), /51-100/);
});

test("user IR slots are 1-based in the tool, 0-based on the wire", () => {
  const irs = [{ index: 0x10000, name: "User IR 1" }, { index: 1, name: "Broad" }, { index: 0x10002, name: "User IR 3" }];
  const lib = describeLibrary("ir", irs);
  assert.deepEqual(lib.map((x) => [x.slot, x.written]), [[1, false], [2, true], [3, false]]);
  assert.equal(KINDS.ir.wire(2), 1);
  assert.throws(() => checkSlot("ir", 2, irs, {}), /already holds "Broad"/);
});

function fakePedal(entries) {
  const sent = [];
  let current = entries;
  return {
    sent, setAfter: (e) => { current = e; },
    readSnaptones: async () => current,
    sendSnapToneUpload: (slot, name, bytes) => { sent.push({ slot, name, len: bytes.length }); return new Array(70).fill(0); },
  };
}

test("upload: checks the slot, sends, re-reads and confirms the name", async () => {
  const pedal = fakePedal(realList);
  const clo = new Uint8Array(readFileSync(resolve(repo, "app/tests/fixtures/gp150_synth_device.clo")));
  const send = (w) => w.sendSnapToneUpload(60, "My Tone", clo);
  const p = upload(pedal, "snaptone", 60, "My Tone", send, { env: {}, sleepFn: async () => pedal.setAfter(withSlot(realList, 60, "My Tone")) });
  const res = await p;
  assert.deepEqual(pedal.sent, [{ slot: 60, name: "My Tone", len: 2696 }]);
  assert.equal(res.confirmed, true);
  assert.equal(res.replaced, null);
  const wrong = fakePedal(realList);
  const r2 = await upload(wrong, "snaptone", 61, "A Name", (w) => w.sendSnapToneUpload(61, "A Name", clo), { env: {}, sleepFn: async () => wrong.setAfter(withSlot(realList, 61, "Other")) });
  assert.equal(r2.confirmed, false, "a different name in the slot is reported, not hidden");
});

test("upload: nothing is sent to a written slot that is not allowed", async () => {
  const pedal = fakePedal(withSlot(realList, 70, "Keep Me"));
  await assert.rejects(upload(pedal, "snaptone", 70, "New", (w) => w.sendSnapToneUpload(70, "New", new Uint8Array(4)), { env: {}, sleepFn: async () => {} }), /already holds "Keep Me"/);
  assert.equal(pedal.sent.length, 0);
});

test("input preparation", () => {
  // IR: 24-bit mono WAV with 3000 samples -> first 2048 kept and reported
  const n = 3000, data = new DataView(new ArrayBuffer(44 + n * 3));
  const w4 = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  w4(0, "RIFF"); data.setUint32(4, 36 + n * 3, true); w4(8, "WAVE"); w4(12, "fmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
  data.setUint16(22, 1, true); data.setUint32(24, 44100, true); data.setUint32(28, 44100 * 3, true); data.setUint16(32, 3, true); data.setUint16(34, 24, true);
  w4(36, "data"); data.setUint32(40, n * 3, true);
  const wavPath = join(tmp, "ir.wav"); writeFileSync(wavPath, Buffer.from(data.buffer));
  const ir = prepareIr(wavPath);
  assert.equal(ir.samples.length, 2048); assert.equal(ir.truncated, 3000); assert.match(ir.note, /24-bit 44100 Hz/);
  // NAM: lite model picked from a container
  const weights = Array.from({ length: 1871 }, (_, i) => i / 1871);
  const namPath = join(tmp, "m.nam"); writeFileSync(namPath, JSON.stringify({ metadata: { name: "My Amp" }, config: { submodels: [{ model: { weights, metadata: { loudness: -11 } } }] } }));
  const nam = prepareNam(namPath);
  assert.equal(nam.weights.length, 1871); assert.equal(nam.loudness, -11);
  writeFileSync(join(tmp, "bad.nam"), JSON.stringify({ architecture: "WaveNet", weights: [1, 2] }));
  assert.throws(() => prepareNam(join(tmp, "bad.nam")), /1871-weight/);
  // .clo
  writeFileSync(join(tmp, "x.clo"), "NOPE");
  assert.throws(() => prepareClo(join(tmp, "x.clo")), /VTSI/);
  assert.equal(prepareClo(resolve(repo, "app/tests/fixtures/gp150_synth_device.clo")).length, 2696);
  // recording too short
  assert.throws(() => loadRecording(wavPath), /must cover the whole 70 s/);
});

test("worker-thread NAM renderer equals the single-thread one", async () => {
  const model = NamWaveNet.extractAnyModel(JSON.parse(readFileSync(resolve(repo, "refs/wavenet_a1_standard.nam"), "utf8")));
  const x = new Float32Array(48000 * 2).map((_, i) => 0.3 * Math.sin(i * 0.05) * Math.sin(i * 0.0007));
  const a = await renderNam(model, x, { workers: 3 });
  const b = NamWaveNetFast.renderSync(model, x, 36000);
  assert.equal(a.length, b.length);
  assert.ok(a.every((v, i) => v === b[i]));
});

test("worker-thread profiler matches the stored regression output", async () => {
  const { makeSignals } = await import(resolve(repo, "app/tests/amp_profiler_synth.mjs"));
  const { x, y } = makeSignals();
  const prof = await profileInThread(x, y);
  const gold = readFileSync(resolve(repo, "app/tests/fixtures/amp_profiler_synth_ir1.f32"));
  const ref = new Float32Array(gold.buffer.slice(gold.byteOffset, gold.byteOffset + gold.length));
  let m = 0, pk = 0;
  for (let i = 0; i < 128; i++) { m = Math.max(m, Math.abs(prof.ir1[i] - ref[i])); pk = Math.max(pk, Math.abs(ref[i])); }
  assert.ok(m / pk < 1e-6, `IR1 differs by ${m / pk}`);
});

test("NAM -> device .clo end to end", { timeout: 180000 }, async () => {
  const { model } = loadNamModel(resolve(repo, "refs/wavenet_a1_standard.nam"));
  const clo = await cloFromNam(model);
  assert.equal(clo.length, 2696);
  assert.equal(String.fromCharCode(...clo.slice(0, 4)), "VTSI");
  const dv = new DataView(clo.buffer, clo.byteOffset);
  assert.equal(Profiler.crc16(clo.subarray(12)), dv.getUint32(8, true), "CRC of the device form");
});
