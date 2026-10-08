// Regenerates the regression fixtures of test_amp_profiler_js.mjs from the current profiler:
//   fixtures/amp_profiler_synth_ir{1,2}.f32, fixtures/amp_profiler_synth_golden.clo
// Run it only after a deliberate change of the algorithm, then regenerate the upload golden too:
//   node app/tests/amp_profiler_golden_gen.mjs && node app/tests/gp150_upload_golden_gen.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { makeSignals } from "./amp_profiler_synth.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const P = require(resolve(here, "../static/amp_profiler.js")).AmpProfiler;
const { x, y } = makeSignals();
const prof = P.profile(x, y);
const out = (n, a) => writeFileSync(resolve(here, "fixtures", n), Buffer.from(new Uint8Array(Float32Array.from(a).buffer)));
out("amp_profiler_synth_ir1.f32", prof.ir1);
out("amp_profiler_synth_ir2.f32", prof.ir2);
writeFileSync(resolve(here, "fixtures/amp_profiler_synth_golden.clo"), P.assembleClo(prof));
console.log("fixtures written:", prof.ir1.length, "+", prof.ir2.length, "taps");
