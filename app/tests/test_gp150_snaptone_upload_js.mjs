/*
 * GP150-9's SnapTone/"Clone" upload write path: webmidi_gp150.js's buildCloneUploadChunks().
 *
 *  1. Golden on a synthetic .clo (gp150_upload_synth.mjs). The same golden is checked by the Python
 *     encoder (test_gp150_snaptone_upload.py), so the two implementations agree chunk for chunk.
 *  2. Byte-for-byte parity with a real Suite upload, when that capture is available
 *     (GP150_CAPTURES_DIR; it holds a third-party profile so it is not in the repo).
 *
 *   node app/tests/test_gp150_snaptone_upload_js.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { codec, goldenPath, CLONE_CASE, synthClo, hex, realCapture } from "./gp150_upload_synth.mjs";

const { buildCloneUploadChunks } = codec;

{
  const clo = synthClo();
  const chunks = buildCloneUploadChunks(CLONE_CASE.slot, CLONE_CASE.name, clo);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")).clone;
  assert.equal(chunks.length, 70);
  assert.deepEqual(chunks.map(hex), golden.chunks, "SnapTone chunks differ from the golden fixture");
  const nib = [];
  for (const c of chunks) nib.push(...c.slice(8));
  const bytes = codec.nibblesToBytes(nib);
  assert.equal(bytes.length, 8228);
  assert.deepEqual(bytes.slice(8 + 28, 8 + 32), [0x56, 0x54, 0x53, 0x49], "VTSI magic");
  assert.deepEqual(bytes.slice(8 + 28, 8 + 28 + clo.length), clo, ".clo bytes did not survive the round trip");
  console.log("OK: synthetic SnapTone upload -- 70 chunks match the golden and decode back to the input");
}

const capture = realCapture("snaptone_upload_2026-09-24/raw_midi_out_capture.txt");
const cloPath = realCapture("snaptone_upload_2026-09-29/snaptone_clo_truncated.raw");
if (!capture || !cloPath) {
  console.log("skip: real-capture parity (set GP150_CAPTURES_DIR to run it)");
  process.exit(0);
}
const re = /SYSEX len=(\d+)\s+([0-9a-f ]+)/;
const real = new Map();
for (const line of readFileSync(capture, "utf8").split("\n")) {
  const m = re.exec(line);
  if (!m) continue;
  const d = Uint8Array.from(m[2].trim().split(" ").map((h) => parseInt(h, 16))).slice(1, -1);
  if (d.length > 8 && d[6] === 0x08 && !real.has(d[7])) real.set(d[7], Array.from(d));
}
const nibs = [];
[...real.keys()].sort((a, b) => a - b).forEach((i) => nibs.push(...real.get(i).slice(8)));
const stream = codec.nibblesToBytes(nibs);
const name = String.fromCharCode(...stream.slice(8 + 12, 8 + 28)).replace(/\0+$/, ""); // as sent by Suite
const mine = buildCloneUploadChunks(51, name, Array.from(readFileSync(cloPath)));
assert.equal(mine.length, real.size);
mine.forEach((c, i) => assert.deepEqual(c, real.get(i), `chunk ${i}`));
console.log("OK: all chunks match the real Suite capture byte-for-byte");
