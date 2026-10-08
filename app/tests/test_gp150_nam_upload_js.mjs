/*
 * GP150-9's NAM upload write path: webmidi_gp150.js's buildNamUploadChunks().
 *
 *  1. Golden + round trip on synthetic weights (gp150_upload_synth.mjs).
 *  2. Byte-for-byte parity with two real Suite uploads, when those captures are available
 *     (GP150_CAPTURES_DIR; they hold third-party model weights so they are not in the repo).
 *
 *   node app/tests/test_gp150_nam_upload_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { codec, goldenPath, NAM_CASE, synthNam, hex, realCapture } from "./gp150_upload_synth.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const { buildNamUploadChunks } = codec;

// ---- 1. synthetic golden + round trip -------------------------------------------------------
{
  const weights = synthNam();
  const chunks = buildNamUploadChunks(NAM_CASE.slot, NAM_CASE.name, weights, NAM_CASE.loudness, { counter: NAM_CASE.counter });
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")).nam;
  assert.deepEqual(chunks.map(hex), golden.chunks, "NAM chunks differ from the golden fixture");
  const nib = [];
  for (const c of chunks) nib.push(...c.slice(8));
  const bytes = codec.nibblesToBytes(nib);
  assert.equal(bytes.length, 8228);
  assert.equal(String.fromCharCode(...bytes.slice(20, 36)).replace(/\0+$/, ""), NAM_CASE.name);
  const region = bytes.slice(36, 36 + 8192);
  const dv = new DataView(Uint8Array.from(region).buffer);
  assert.equal(dv.getUint32(16, true), weights.length, "weights count");
  assert.equal(dv.getFloat64(44, true), NAM_CASE.loudness, "loudness");
  const off = dv.getUint32(12, true);
  const back = weights.map((_, i) => dv.getFloat32(off + i * 4, true));
  assert.deepEqual(back, weights, "weights did not survive the round trip");
  console.log(`OK: synthetic NAM upload -- ${chunks.length} chunks match the golden and decode back to the input`);
}

// ---- 2. parity with real Suite captures (optional) ------------------------------------------
// Two independent real captures, same "lite" architecture, different
// weights AND different loudness -- both round-trip byte-for-byte now
// that the header is fully understood: the CRC-32 hash (offset 24) and
// the selected submodel's own metadata.loudness (offset 44, 8 bytes) are
// both solved (see NAM_HASH_OFFSET/NAM_LOUDNESS_OFFSET in
// webmidi_gp150.js). There is no third field at offset 48 -- that was a
// self-inflicted false lead (reinterpreting the loudness double's own
// upper 4 bytes as an independent float32), corrected 2026-09-26.
const CASES = [
  { label: "capture A -> slot 1", rel: "ir_snaptone_nam_upload_2026-09-24/raw_midi_out_capture.txt", lo: 143768, hi: 144100 },
  { label: "capture B -> slot 1", rel: "nam_upload_2026-09-25/raw_midi_out_capture.txt", lo: 27900, hi: 28123 },
].map((c) => ({ ...c, path: realCapture(c.rel) })).filter((c) => c.path);
if (!CASES.length) { console.log("skip: real-capture parity (set GP150_CAPTURES_DIR to run it)"); process.exit(0); }

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
    const inner = d.slice(3, -1);
    byIndex.set(inner[5], inner.slice(6));
  }
  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  const nibbles = [];
  for (const i of indices) nibbles.push(...byIndex.get(i));
  const n = nibbles.length - (nibbles.length % 2);
  const bytes = [];
  for (let i = 0; i < n; i += 2) bytes.push((nibbles[i] << 4) | nibbles[i + 1]);
  return bytes;
}

function decodeUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeFloat32LE(bytes, offset) {
  return new DataView(Uint8Array.from(bytes.slice(offset, offset + 4)).buffer).getFloat32(0, true);
}

function decodeFloat64LE(bytes, offset) {
  return new DataView(Uint8Array.from(bytes.slice(offset, offset + 8)).buffer).getFloat64(0, true);
}

let anyFail = false;

for (const { label, path, lo, hi } of CASES) {
  const messages = parseCaptureLines(path);
  const payload = reassembleBurst(messages, lo, hi);

  if (payload.length !== 8228) {
    throw new Error(`${label}: expected the real reassembled payload to be 8228 bytes, got ${payload.length}`);
  }

  const name = String.fromCharCode(...payload.slice(20, 36)).replace(/\0+$/, "");
  const targetSlot0based = decodeUint32LE(payload, 12);
  const dataRegion = payload.slice(36, 36 + 8192);
  const weightsOffset = decodeUint32LE(dataRegion, 12);
  const weightsCount = decodeUint32LE(dataRegion, 16);
  const weights = [];
  for (let i = 0; i < weightsCount; i++) weights.push(decodeFloat32LE(dataRegion, weightsOffset + i * 4));
  const loudness = decodeFloat64LE(dataRegion, 44);

  console.log(`[${label}] recovered from capture: name=${JSON.stringify(name)} slot0based=${targetSlot0based} weights=${weights.length} loudness=${loudness}`);

  const realMessages = messages.filter(([t, d]) => t >= lo && t <= hi && d.length >= 40);
  const realByIndex = new Map();
  for (const [, d] of realMessages) realByIndex.set(d.slice(3, -1)[5], d);
  const realCounter = realMessages[0][1].slice(3, -1)[4];

  const myChunks = buildNamUploadChunks(targetSlot0based, name, weights, loudness, { counter: realCounter });

  let mismatches = 0;
  if (myChunks.length !== realByIndex.size) {
    console.error(`[${label}] FAIL: chunk count mismatch -- mine=${myChunks.length} real=${realByIndex.size}`);
    mismatches++;
  }
  for (let i = 0; i < myChunks.length; i++) {
    const mine = Uint8Array.from([0xf0, ...myChunks[i], 0xf7]);
    const real = realByIndex.get(i);
    if (!real || real.length !== mine.length || !real.every((b, j) => b === mine[j])) {
      mismatches++;
      if (mismatches <= 3) {
        console.error(`[${label}] MISMATCH chunk ${i}:`);
        console.error("  real:", real ? [...real].map((b) => b.toString(16).padStart(2, "0")).join(" ") : "(missing)");
        console.error("  mine:", [...mine].map((b) => b.toString(16).padStart(2, "0")).join(" "));
      }
    }
  }

  if (mismatches > 0) {
    console.error(`[${label}] FAIL: ${mismatches} chunk mismatch(es) out of ${myChunks.length}`);
    anyFail = true;
  } else {
    console.log(`[${label}] OK: all ${myChunks.length} chunks match the real Suite capture byte-for-byte`);
  }
}

if (anyFail) process.exit(1);
