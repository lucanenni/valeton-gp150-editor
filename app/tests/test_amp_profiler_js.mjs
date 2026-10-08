/*
 * amp_profiler.js regression test on a deterministic synthetic (reference, recorded) pair from
 * amp_profiler_synth.mjs -- seeded noise, nothing proprietary. The stored outputs come from this
 * profiler itself (node app/tests/amp_profiler_golden_gen.mjs); the algorithm was originally checked
 * against profiles made with Valeton Suite on identical inputs (see design/GP150_SUPPORT.md §5).
 *
 *   fixtures/amp_profiler_synth_ir{1,2}.f32   the two IRs (48 kHz)
 *   fixtures/amp_profiler_synth_golden.clo    the full 8840-byte output
 *
 *   node app/tests/test_amp_profiler_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { makeSignals } from "./amp_profiler_synth.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const P = require(resolve(here, "../static/amp_profiler.js")).AmpProfiler;
const fx = (n) => readFileSync(resolve(here, "fixtures", n));
const f32 = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failed++;
}
const relErr = (a, b, n = b.length) => {
  let m = 0, pk = 0;
  for (let i = 0; i < n; i++) { m = Math.max(m, Math.abs(a[i] - b[i])); pk = Math.max(pk, Math.abs(b[i])); }
  return m / pk;
};

const { x, y } = makeSignals();
const prof = P.profile(x, y);
const gold = fx("amp_profiler_synth_golden.clo");
const goldDv = new DataView(gold.buffer, gold.byteOffset, gold.length);

// 1. the 48 kHz impulse responses (before resampling) agree with the stored ones
check("IR1 (128 taps) matches the stored IR", relErr(prof.ir1, f32(fx("amp_profiler_synth_ir1.f32")).subarray(0, 128)) < 1e-6,
  relErr(prof.ir1, f32(fx("amp_profiler_synth_ir1.f32")).subarray(0, 128)).toExponential(2));
check("IR2 (2048 taps) matches the stored IR", relErr(prof.ir2, f32(fx("amp_profiler_synth_ir2.f32"))) < 1e-6,
  relErr(prof.ir2, f32(fx("amp_profiler_synth_ir2.f32"))).toExponential(2));

// 2. header: waveshaper coefficients, biquad sets, lengths
const clo = P.assembleClo(prof);
const dv = new DataView(clo.buffer);
for (const [off, nm] of [[104, "posPeak"], [108, "negPeak"], [112, "aPos"], [116, "aNeg"]]) {
  const a = dv.getFloat32(off, true), b = goldDv.getFloat32(off, true);
  check(`header ${nm}`, Math.abs(a - b) <= 1e-5 * Math.abs(b), `${a} vs ${b}`);
}
let hdrDiff = 0;
for (let i = 0; i < 136; i++) if ((i < 8 || i > 11) && !(i >= 112 && i < 120) && clo[i] !== gold[i]) hdrDiff++;
check("header bytes (except CRC and waveshaper floats) identical", hdrDiff === 0, `${hdrDiff} differ`);
check("length", clo.length === 8840);

// 3. resampled segments
const seg = (buf, off, n) => { const d = new DataView(buf.buffer, buf.byteOffset); return Float32Array.from({ length: n }, (_, i) => d.getFloat32(off + 4 * i, true)); };
check("seg1 (44.1 kHz) match the stored ones", relErr(seg(clo, 136, 128), seg(gold, 136, 128)) < 1e-6, relErr(seg(clo, 136, 128), seg(gold, 136, 128)).toExponential(2));
check("seg2 (44.1 kHz) match the stored ones", relErr(seg(clo, 648, 512), seg(gold, 648, 512)) < 1e-6, relErr(seg(clo, 648, 512), seg(gold, 648, 512)).toExponential(2));

// 4. CRC-16: the stored file's own CRC verifies, and ours is self-consistent
check("CRC-16 matches the stored file's CRC", P.crc16(gold.subarray(12)) === goldDv.getUint32(8, true));
check("CRC-16 of our file is self-consistent", P.crc16(clo.subarray(12)) === dv.getUint32(8, true));

// 5. device form: 2696 bytes, lengths rewritten, CRC valid, idempotent
const dev = P.toDeviceClo(clo);
const ddv = new DataView(dev.buffer);
check("device .clo is 2696 bytes with rewritten lengths", dev.length === 2696 && ddv.getUint32(4, true) === 2696 && ddv.getUint32(20, true) === 2560 && ddv.getUint32(132, true) === 512);
check("device .clo CRC valid", P.crc16(dev.subarray(12)) === ddv.getUint32(8, true));
const dev2 = P.toDeviceClo(dev);
check("toDeviceClo is idempotent", dev.every((v, i) => v === dev2[i]));

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log("\nall checks passed");
