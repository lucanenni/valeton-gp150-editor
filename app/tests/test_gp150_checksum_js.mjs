/*
 * The 0x0E-0x0F checksum in the browser module (gp150_format.js): CRC-16, poly 0x8005 reflected, init 0xE011,
 * over bytes 0x10..0x463, big-endian. Real device files from re/gp150_captures, and the writers.
 *   node app/tests/test_gp150_checksum_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const G = require(resolve(here, "../static/gp150_format.js"));
const load = (p) => new Uint8Array(readFileSync(resolve(repo, p)));

const REAL = [
  "app/static/data/gp150_skeleton.prst",
  "re/gp150_captures/cc_experiments/slot00_baseline.prst",
  "re/gp150_captures/live_edit/readback_after_save_gain80.prst",
  "re/gp150_captures/param_edits/200-Its GP150_NS.prst",
  "re/gp150_captures/param_edits/200-Its GP150_NS_GAIN_60.prst",
  "re/gp150_captures/param_edits/200-Test123456789.prst",
  "re/gp150_captures/wake_replay/slot00_no_suite.prst",
  "re/gp150_captures/wake_select_read/slot005_settle0.3_uk900dist.prst",
  "re/gp150_captures/wake_select_read/slot010_settle10_morse_purple.prst",
  "re/gp150_captures/write_attempts/readback_slot197_after_bad_checksum.prst",
  "re/gp150_captures/write_attempts/readback_slot199_after_import.prst",
  "re/gp150_captures/write_preset_2026-09-27/004-Foxy Clean.prst",
];
for (const rel of REAL) {
  const b = load(rel);
  assert.ok(G.checksumOk(b), `${rel}: stored ${G.readChecksum(b).toString(16)}, computed ${G.computeChecksum(b).toString(16)}`);
}

const skeleton = load("app/static/data/gp150_skeleton.prst");
const base = G.computeChecksum(skeleton);
const moved = new Uint8Array(skeleton); moved[G.PATCH_INDEX_OFF] = 77;
assert.equal(G.computeChecksum(moved), base, "the slot index is not covered");
const built = G.buildFromSkeleton(skeleton, { name: "Check Me" });
assert.ok(G.checksumOk(built) && G.computeChecksum(built) !== base);
const broken = new Uint8Array(built); broken[G.PATCH_INDEX_OFF + 10] ^= 0xff;
assert.ok(!G.checksumOk(broken));
assert.deepEqual(Array.from(G.fixChecksum(broken)), Array.from(built));
console.log("ok");

// the enabled-module bitmask at 0x444, which the pedal rewrites itself
for (const rel of REAL) {
  const b = load(rel);
  assert.equal(b[0x444] | (b[0x445] << 8), G.moduleMask(b), `${rel}: module mask`);
}
const m = new Uint8Array(skeleton);
assert.equal(G.moduleMask(m), 0x800);
G.writeModuleEnabled(m, "AMP", true); G.writeModuleEnabled(m, "RVB", true);
assert.equal(G.moduleMask(m), 0xc10);
assert.equal(m[0x444], 0x10); assert.equal(m[0x445], 0x0c);
console.log("ok (module mask)");
