/*
 * amp_profiler_reference.js: the generated 70 s profiler test signal has the layout
 * and level plan the profiler relies on, and is deterministic.
 *
 *   node app/tests/test_amp_profiler_reference_js.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const R = require(resolve(here, "../static/amp_profiler_reference.js")).AmpProfilerReference;
const sr = 48000;

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failed++; };
const x = R.get();
const rms = (a, b) => { let e = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) e += x[i] * x[i]; return Math.sqrt(e / ((b - a) * sr)); };
const peak = (a, b) => { let p = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) p = Math.max(p, Math.abs(x[i])); return p; };
const near = (v, t, tol) => Math.abs(v - t) <= tol * t;

check("70 s at 48 kHz", x.length === 70 * sr && R.SAMPLES === x.length);
check("ramp reaches 0 dBFS", peak(4.7, 5) > 0.99 && peak(0, 0.25) < 0.01, `${peak(4.7, 5).toFixed(3)} / ${peak(0, 0.25).toFixed(4)}`);
check("silence 5-6 s except the click region", peak(5.05, 5.9) < 1e-3);
check("click at 6 s", peak(5.99, 6.01) > 0.9 && Math.abs(x[6 * sr]) > 0.9);
check("noise section level (~0.8e-3 rms)", near(rms(8, 20), 8e-4, 0.1), rms(8, 20).toExponential(2));
check("silence 21.2-22.9 s", peak(21.2, 22.9) < 1e-6);
check("sweep section level (0.4 rms)", near(rms(23.1, 27.9), 0.4, 0.02), rms(23.1, 27.9).toFixed(3));
check("silence 28.3-29.9 s", peak(28.3, 29.9) < 1e-6);
check("chirp section level rises (0.038 -> 0.058 rms)", near(rms(30, 31), 0.0378, 0.15) && near(rms(49, 50), 0.0585, 0.15), `${rms(30, 31).toFixed(4)} / ${rms(49, 50).toFixed(4)}`);
check("chirp crest factor ~3", peak(40, 41) / rms(40, 41) > 2.5 && peak(40, 41) / rms(40, 41) < 3.6, (peak(40, 41) / rms(40, 41)).toFixed(2));
check("playing section level", near(rms(50, 70), 0.13, 0.1) && peak(50, 70) > 0.6 && peak(50, 70) <= 1, `${rms(50, 70).toFixed(3)} / ${peak(50, 70).toFixed(3)}`);
const y = R.generate(7);
check("deterministic", y.length === x.length && y.every((v, i) => v === x[i]));
check("other seed differs", R.generate(8).some((v, i) => v !== x[i]));
const wav = R.toWav16(x.subarray(0, 100), sr);
check("wav header", wav.length === 244 && String.fromCharCode(...wav.subarray(0, 4)) === "RIFF" && new DataView(wav.buffer).getUint32(24, true) === sr);

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log("\nall checks passed");
