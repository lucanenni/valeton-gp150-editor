/*
 * GP150-9's User IR upload write path: webmidi_gp150.js's buildIrUploadChunks().
 *
 *  1. Golden + round trip on a synthetic IR (gp150_upload_synth.mjs): the chunks must equal the
 *     checked-in golden, and decoding them again must give back the name, slot and samples.
 *  2. Byte-for-byte parity with a real Suite upload, when that capture is available
 *     (GP150_CAPTURES_DIR; it holds third-party audio so it is not in the repo).
 *
 *   node app/tests/test_gp150_ir_upload_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { codec, goldenPath, IR_CASE, synthIr, hex, unhex, realCapture } from "./gp150_upload_synth.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const { buildIrUploadChunks } = codec;

// ---- 1. synthetic golden + round trip -------------------------------------------------------
{
  const samples = synthIr();
  const chunks = buildIrUploadChunks(IR_CASE.slot0, IR_CASE.name, samples, { counter: IR_CASE.counter });
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")).ir;
  assert.deepEqual(chunks.map(hex), golden.chunks, "IR chunks differ from the golden fixture");
  // decode again: chunk = [7f, tag, lenlo, lenhi, offlo, offhi, ...] style header, then nibbles
  const nib = [];
  for (const c of chunks) nib.push(...c.slice(8));
  const bytes = codec.nibblesToBytes(nib);
  assert.equal(bytes.length, 8228);
  assert.equal(String.fromCharCode(...bytes.slice(20, 36)).replace(/\0+$/, ""), IR_CASE.name);
  assert.equal(bytes[12] | (bytes[13] << 8), IR_CASE.slot0);
  const back = [];
  for (let i = 0; i < samples.length; i++) back.push(new DataView(Uint8Array.from(bytes.slice(36 + i * 4, 40 + i * 4)).buffer).getInt32(0, true));
  assert.deepEqual(back, samples, "samples did not survive the round trip");
  console.log(`OK: synthetic IR upload -- ${chunks.length} chunks match the golden and decode back to the input`);
}

// ---- 2. parity with a real Suite capture (optional) -----------------------------------------
const CAPTURE_PATH = realCapture("ir_snaptone_nam_upload_2026-09-24/raw_midi_out_capture.txt");
if (!CAPTURE_PATH) {
  console.log("skip: real-capture parity (set GP150_CAPTURES_DIR to run it)");
  process.exit(0);
}
// The IR burst's timestamp window within that capture file.
const BURST_LO_MS = 36595;
const BURST_HI_MS = 36900;

function parseCaptureLines(path) {
  const text = readFileSync(path, "utf8");
  const out = [];
  const re = /\[\+(\d+)ms\]\s+SYSEX len=(\d+)\s+([0-9a-f ]+)/;
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const t = Number(m[1]);
    const bytes = Uint8Array.from(m[3].trim().split(" ").map((h) => parseInt(h, 16)));
    out.push([t, bytes]);
  }
  return out;
}

function reassembleBurst(messages, lo, hi) {
  const chunks = messages.filter(([t, d]) => t >= lo && t <= hi && d.length >= 40);
  const byIndex = new Map();
  for (const [, d] of chunks) {
    const inner = d.slice(3, -1); // strip f0, 7f, tag, f7
    byIndex.set(inner[5], inner.slice(6));
  }
  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  const nibbles = [];
  for (const i of indices) nibbles.push(...byIndex.get(i));
  const n = nibbles.length - (nibbles.length % 2);
  const bytes = [];
  for (let i = 0; i < n; i += 2) bytes.push((nibbles[i] << 4) | nibbles[i + 1]);
  return { payload: bytes, rawChunksByIndex: chunks };
}

function decodeInt32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) | 0;
}

const messages = parseCaptureLines(CAPTURE_PATH);
const { payload } = reassembleBurst(messages, BURST_LO_MS, BURST_HI_MS);

if (payload.length !== 8228) {
  throw new Error(`expected the real reassembled payload to be 8228 bytes, got ${payload.length}`);
}

const name = String.fromCharCode(...payload.slice(20, 36)).replace(/\0+$/, "");
const targetSlot0based = decodeInt32LE(payload, 12);
const dataRegion = payload.slice(36, 36 + 8192);
let lastNonZero = -1;
for (let i = dataRegion.length - 4; i >= 0; i -= 4) {
  if (dataRegion[i] || dataRegion[i + 1] || dataRegion[i + 2] || dataRegion[i + 3]) { lastNonZero = i; break; }
}
const numRealSamples = lastNonZero / 4 + 1;
const samples = [];
for (let i = 0; i < numRealSamples; i++) samples.push(decodeInt32LE(dataRegion, i * 4));

console.log(`recovered from capture: name=${JSON.stringify(name)} slot0based=${targetSlot0based} samples=${samples.length}`);

// Real capture used counter=7 (see BACKLOG_GP150.md) -- pass it explicitly so
// this test compares apples to apples; a real upload from this app
// would use its own default (1), which the pedal is not expected to
// validate against any particular value (see webmidi_gp150.js's comment
// on buildIrUploadChunks()'s counter param).
const myChunks = buildIrUploadChunks(targetSlot0based, name, samples, { counter: 7 });

const realMessages = parseCaptureLines(CAPTURE_PATH).filter(([t, d]) => t >= BURST_LO_MS && t <= BURST_HI_MS && d.length >= 40);
const realByIndex = new Map();
for (const [, d] of realMessages) realByIndex.set(d.slice(3, -1)[5], d);

let mismatches = 0;
if (myChunks.length !== realByIndex.size) {
  console.error(`FAIL: chunk count mismatch -- mine=${myChunks.length} real=${realByIndex.size}`);
  mismatches++;
}
for (let i = 0; i < myChunks.length; i++) {
  const mine = Uint8Array.from([0xf0, ...myChunks[i], 0xf7]);
  const real = realByIndex.get(i);
  if (!real || real.length !== mine.length || !real.every((b, j) => b === mine[j])) {
    mismatches++;
    if (mismatches <= 3) {
      console.error(`MISMATCH chunk ${i}:`);
      console.error("  real:", real ? [...real].map((b) => b.toString(16).padStart(2, "0")).join(" ") : "(missing)");
      console.error("  mine:", [...mine].map((b) => b.toString(16).padStart(2, "0")).join(" "));
    }
  }
}

if (mismatches > 0) {
  console.error(`FAIL: ${mismatches} chunk mismatch(es) out of ${myChunks.length}`);
  process.exit(1);
}
console.log(`OK: all ${myChunks.length} chunks match the real Suite capture byte-for-byte`);
