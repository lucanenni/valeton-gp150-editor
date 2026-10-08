/*
 * gp150_upload_prep.js: name sanitising, WAV parsing and picking the NAM "lite" model.
 *   node app/tests/test_gp150_upload_prep_js.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const P = require(resolve(dirname(fileURLToPath(import.meta.url)), "../static/gp150_upload_prep.js"));

// a tiny WAV: `bits`-bit PCM (or float32 when tag 3), 2 channels so channel 0 selection is exercised
function wav({ bits = 16, rate = 44100, tag = 1, frames }) {
  const bytes = bits / 8, n = frames.length, data = n * 2 * bytes;
  const b = new DataView(new ArrayBuffer(44 + data));
  const w4 = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w4(0, "RIFF"); b.setUint32(4, 36 + data, true); w4(8, "WAVE"); w4(12, "fmt "); b.setUint32(16, 16, true);
  b.setUint16(20, tag, true); b.setUint16(22, 2, true); b.setUint32(24, rate, true); b.setUint32(28, rate * 2 * bytes, true);
  b.setUint16(32, 2 * bytes, true); b.setUint16(34, bits, true); w4(36, "data"); b.setUint32(40, data, true);
  frames.forEach((v, i) => {
    for (let c = 0; c < 2; c++) {
      const o = 44 + (i * 2 + c) * bytes, x = c === 0 ? v : 999;
      if (tag === 3) b.setFloat32(o, x, true);
      else if (bits === 16) b.setInt16(o, x, true);
      else if (bits === 24) { b.setUint8(o, x & 255); b.setUint8(o + 1, (x >> 8) & 255); b.setUint8(o + 2, (x >> 16) & 255); }
      else b.setInt32(o, x, true);
    }
  });
  return b.buffer;
}

assert.equal(P.sanitizeName("Café Ampèg 1234567890"), "Caf_ Amp_g 12345");
assert.equal(P.sanitizeName("ok"), "ok");

const vals = [0, 1000, -1000, 32767, -32768];
for (const bits of [16, 24, 32]) {
  const scale = bits === 16 ? 1 : bits === 24 ? 256 : 65536;
  const r = P.decodeWavPcmSamples(wav({ bits, frames: vals.map((v) => v * scale) }));
  assert.deepEqual(r.samples, vals.map((v) => v * scale), `${bits}-bit PCM, channel 0 only`);
  assert.equal(r.sampleRate, 44100);
}
assert.equal(P.decodeWavPcmSamples(wav({ frames: vals }), { maxFrames: 2 }).samples.length, 2, "maxFrames");
assert.equal(P.wavSampleRate(wav({ rate: 48000, frames: [0] })), 48000);
assert.equal(P.wavSampleRate(new ArrayBuffer(40)), 0);
assert.throws(() => P.decodeWavPcmSamples(new ArrayBuffer(64)), /RIFF/);
assert.throws(() => P.decodeWavPcmSamples(wav({ tag: 3, bits: 32, frames: [0.5] })), /floating-point/);

const f = P.decodeWavFloat(wav({ bits: 16, frames: [0, 16384, -32768] }));
assert.deepEqual(Array.from(f.samples), [0, 0.5, -1]);
const ff = P.decodeWavFloat(wav({ tag: 3, bits: 32, frames: [0.25, -0.5] }));
assert.deepEqual(Array.from(ff.samples), [0.25, -0.5]);

const weights = Array.from({ length: 1871 }, (_, i) => i / 1871);
assert.deepEqual(P.pickNamLiteModel({ architecture: "WaveNet", weights, metadata: { loudness: -12 } }, 1871), { weights, loudness: -12 });
const container = { config: { submodels: [{ model: { weights: [1, 2, 3] } }, { model: { weights, metadata: { loudness: -9.5 } } }] } };
assert.deepEqual(P.pickNamLiteModel(container, 1871), { weights, loudness: -9.5 });
assert.throws(() => P.pickNamLiteModel({ architecture: "WaveNet", weights: [1] }, 1871), /1871-weight/);
console.log("ok");
