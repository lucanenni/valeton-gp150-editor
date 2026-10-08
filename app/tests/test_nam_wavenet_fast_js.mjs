/*
 * nam_wavenet_fast.js (flat Float32 + block-wise rendering) against the same
 * REAL PyTorch reference outputs nam_wavenet.js is validated with, and
 * against the float64 reference implementation on a longer signal.
 *
 *   node app/tests/test_nam_wavenet_fast_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const { NamWaveNet } = require(resolve(here, "../static/nam_wavenet.js"));
const { NamWaveNetFast } = require(resolve(here, "../static/nam_wavenet_fast.js"));
const load = (p) => JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));
const fixture = (n) => JSON.parse(readFileSync(resolve(here, "fixtures", n), "utf8"));

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures++;
}
const maxErr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// 1. real PyTorch outputs, rendered in small blocks so the history handling is exercised
const a2 = NamWaveNet.extractAnyModel(load("refs/A2.nam"));
for (const n of ["nam_wavenet_reference_1.json", "nam_wavenet_reference_2.json"]) {
  const ref = fixture(n), x = Float32Array.from(ref.input);
  const y = NamWaveNetFast.renderSync(a2, x, 700);
  check(`${n}: modern schema matches PyTorch`, y.length === x.length && maxErr(y, ref.output) < 1e-5, `max abs error ${maxErr(y, ref.output).toExponential(2)}`);
}
for (const [nam, fx, label] of [["refs/wavenet_a1_standard.nam", "nam_wavenet_classic_reference.json", "classic"], ["refs/wavenet.nam", "nam_wavenet_classic_tiny_reference.json", "tiny classic"]]) {
  const m = NamWaveNet.extractAnyModel(load(nam)), ref = fixture(fx), x = Float32Array.from(ref.input_unpadded);
  const y = NamWaveNetFast.renderSync(m, x, 700);
  check(`${label} schema matches PyTorch`, y.length === x.length && maxErr(y, ref.output) < 1e-5, `max abs error ${maxErr(y, ref.output).toExponential(2)}`);
}

// 2. block size must not matter; fast path equals the float64 reference on a longer signal
{
  const n = 20000, x = new Float32Array(n);
  let s = 1; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = 0.4 * Math.sin(i * 0.05) + 0.3 * ((s / 0x7fffffff) * 2 - 1); }
  const ref = NamWaveNet.renderModelBlocks(a2, x, 6000);
  const one = NamWaveNetFast.renderSync(a2, x, 6000), two = NamWaveNetFast.renderSync(a2, x, 2500);
  check("fast == float64 reference (modern)", maxErr(one, ref) < 1e-5, maxErr(one, ref).toExponential(2));
  check("block size does not change the result", maxErr(one, two) < 1e-5, maxErr(one, two).toExponential(2));
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall checks passed");
