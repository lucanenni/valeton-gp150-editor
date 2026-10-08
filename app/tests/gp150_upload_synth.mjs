/*
 * Deterministic synthetic payloads for the GP-150 library-upload tests (User IR, NAM, SnapTone):
 * no third-party audio or model data is needed, so the tests run from a clean checkout.
 *
 * The expected chunks live in fixtures/gp150_upload_golden.json, produced by
 *   node app/tests/gp150_upload_golden_gen.mjs
 * with encoders that were first checked byte-for-byte against real Suite uploads (the captures hold
 * third-party content and are not in the repo; point GP150_CAPTURES_DIR at them to re-run that parity
 * check, see app/tests/gp150_corpus.py).
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../..");
export const goldenPath = resolve(here, "fixtures/gp150_upload_golden.json");
export const cloFixturePath = resolve(here, "fixtures/gp150_synth_device.clo");
const require = createRequire(import.meta.url);
export const codec = require(resolve(here, "../static/webmidi_gp150.js")).WebMidiGP150._codec;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return ((s >>> 8) & 0xffff) / 32768 - 1; };
}

export const IR_CASE = { slot0: 2, name: "Test IR", counter: 7 };
export function synthIr() {
  const r = lcg(12345), out = [];
  for (let i = 0; i < 1500; i++) out.push(Math.round(r() * Math.exp(-i / 300) * 2000000));
  return out;
}

export const NAM_CASE = { slot: 4, name: "Test NAM", counter: 3, loudness: -20.25 };
export function synthNam() {
  const r = lcg(777), out = [];
  for (let i = 0; i < 1871; i++) out.push(Math.fround(Math.sin(i * 0.37) * 0.5 + r() * 0.05));
  return out;
}

export const CLONE_CASE = { slot: 51, name: "Test Tone" };
export const synthClo = () => Array.from(readFileSync(cloFixturePath));

export const hex = (a) => Buffer.from(a).toString("hex");
export const unhex = (h) => Array.from(Buffer.from(h, "hex"));

// Optional real-capture directory (third-party content, kept out of the repo).
export function realCapture(rel) {
  const dirs = [process.env.GP150_CAPTURES_DIR].filter(Boolean);
  for (const d of dirs) { const p = join(d.replace(/^~/, homedir()), rel); if (existsSync(p)) return p; }
  return null;
}

// inner chunk (F0/F7 stripped) -> {category, index, nibbles}; works for the 0x7f-headed upload chunks
export function reassemble(chunks) {
  const byIdx = new Map();
  for (const c of chunks) byIdx.set(c[5] ?? 0, c);
  return byIdx;
}
