/*
 * GP150Settings (app/static/gp150_settings.js) against a real settings reply, and the set-record packets
 * (webmidi_gp150.js buildSetRecordPackets) against an independent encoder.
 *
 *   node app/tests/test_gp150_settings_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const S = require(resolve(here, "../static/gp150_settings.js"));
const { WebMidiGP150: W } = require(resolve(here, "../static/webmidi_gp150.js"));
const reply = JSON.parse(readFileSync(resolve(here, "fixtures/gp150_globals_reply.json"), "utf8")).stream;

// ---- the real reply
const { firmware, records } = S.parseGlobalsReply(reply);
assert.equal(firmware, "1.1.1");
assert.deepEqual([...records.keys()], [0x2010, 0x2020, 0x2030, 0x2040, 0x2050, 0x2060, 0x2070]);
assert.deepEqual([...records.values()].map((r) => r.length), [128, 16, 16, 22, 24, 8, 120]);
const v = S.valuesOf(records);
assert.equal(Object.keys(v).length, S.SPECS.length, "every setting has a value in a real reply");
assert.deepEqual([v.inputLevel, v.outputStereo, v.micLevel, v.btRecLevel, v.midiInSource, v.brightness, v.displayTimeout, v.btAudioLevel, v.autoCabMatch],
  [0, 1, 50, -21, 3, 2, 2, 50, 1], "values as the pedal showed them");
assert.equal(S.label("displayTimeout", 2), "Never"); assert.equal(S.label("inputLevel", 3), "3 dB"); assert.equal(S.label("midiInChannelTrs", 0), "Omni");
const eq = S.eqValues(records.get(0x2010));
assert.equal(eq.on, false); assert.equal(eq.level, 50); assert.equal(eq.bands.length, 30);
assert.throws(() => S.parseGlobalsReply([1, 2, 3]), /not a settings reply/);

// ---- changing one setting touches only its bytes
for (const s of S.SPECS) {
  const rec = records.get(s.cmd), other = s.kind === "enum" ? (v[s.name] + 1) % (s.max + 1) : (v[s.name] === s.max ? s.min : v[s.name] + 1);
  const out = S.withValue(rec, s.name, other);
  assert.equal(S.readValue(out, s), other, s.name);
  const width = s.type === "u8" ? 1 : 2;
  for (let i = 0; i < rec.length; i++) if (i < s.off || i >= s.off + width) assert.equal(out[i], rec[i], `${s.name}: byte ${i} must not change`);
  assert.notEqual(out, rec, "a copy, never the original");
}
assert.equal(S.readValue(S.withValue(records.get(0x2020), "inputLevel", -7), S.BY_NAME.inputLevel), -7, "negative values survive");
assert.throws(() => S.withValue(records.get(0x2050), "brightness", 3), /outside/);
assert.throws(() => S.withValue(records.get(0x2050), "brightness", 1.5), /outside/);
assert.throws(() => S.withValue(records.get(0x2050), "nope", 1), /no setting/);
assert.throws(() => S.withValue(new Uint8Array(4), "autoSave", 1), /shorter/);

// ---- set-record packets: an independent encoder written from the frame description
function crc8(bytes) { let c = 0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x31) & 0xff : (c << 1) & 0xff; } return c; }
function expected(cmd, data, seq) {
  const rest = [0x00, (cmd >> 12) & 0xf, cmd & 0xff, cmd >> 8, cmd & 0xff, cmd >> 8, data.length & 0xff, data.length >> 8, ...data];
  const msg = [0x01, crc8(rest), rest.length & 0xff, rest.length >> 8, ...rest];
  const frames = [];
  for (let off = 0, i = 0; off < msg.length; off += 119, i++) {
    const wire = msg.slice(off, off + 119).flatMap((b) => [b >> 4, b & 0xf]);
    const body = [msg.length & 0x7f, msg.length >> 7, off & 0x7f, off >> 7, seq, i, ...wire];
    frames.push([0x7f, crc8(body) & 0x7f, ...body]);
  }
  return frames;
}
for (const cmd of [0x2050, 0x2020, 0x2010]) {
  const data = records.get(cmd);
  const got = W._codec.buildSetRecordPackets(cmd, data, { seq: 5 });
  assert.deepEqual(got, expected(cmd, [...data], 5), `0x${cmd.toString(16)}`);
  assert.equal(got.length, Math.ceil((12 + data.length) / 119), "one packet up to 119 bytes of message, then more");
}
assert.equal(W._codec.buildSetRecordPackets(0x2010, records.get(0x2010), { seq: 1 }).length, 2, "the Global EQ record spans two packets");
// never the factory reset, never an unknown record
for (const bad of [0x2080, 0x2060, 0x2070, 0x3011, 0x1050, 0]) assert.throws(() => W._codec.buildSetRecordPackets(bad, [1, 2, 3, 4]), /not one that may be written/);
console.log("ok");
