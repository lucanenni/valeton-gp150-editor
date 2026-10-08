/*
 * Byte-for-byte parity check for GP150-13's non-disruptive full-preset
 * write path: webmidi_gp150.js's buildWritePresetChunks() must reproduce
 * the real captured Suite "import from file" write exactly, chunk for
 * chunk, tag for tag. Mirrors the Python-side test
 * (app/tests/test_gp150_write_preset.py) against the same real capture.
 *
 *   node app/tests/test_gp150_write_preset_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const { WebMidiGP150 } = require(resolve(here, "../static/webmidi_gp150.js"));
const { buildWritePresetChunks } = WebMidiGP150;

const CAPTURE_DIR = resolve(repoRoot, "re/gp150_captures/write_preset_2026-09-27");

function loadRealChunks() {
  const { packets } = JSON.parse(readFileSync(resolve(CAPTURE_DIR, "midi_out_packets.json"), "utf8"));
  const chunks = new Map();
  for (const p of packets) {
    const bytes = Uint8Array.from(p.split(" ").map((h) => parseInt(h, 16)));
    const d = bytes.slice(1, -1); // strip F0/F7
    if (d.length > 8 && d[6] === 0x07) chunks.set(d[7], Array.from(d));
  }
  return chunks;
}

let failed = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.error(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

const realStream = readFileSync(resolve(CAPTURE_DIR, "reassembled_stream.raw"));
const realBody = Array.from(realStream.slice(8)); // already has slot=189 baked in

const chunks = buildWritePresetChunks(realBody, 189);
const realChunks = loadRealChunks();

assertEq(chunks.length, 10, "chunk count");
for (let i = 0; i < chunks.length; i++) {
  assertEq(chunks[i], realChunks.get(i), `chunk ${i}`);
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nall checks passed");
}
