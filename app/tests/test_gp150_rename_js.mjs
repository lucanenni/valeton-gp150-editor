/*
 * buildRenameMessage() / buildQueryMessage() (User IR 0x1041 / SnapTone 0x1051 / NAM 0x1091 rename) against an independent
 * encoder written from the frame description in re/DEVICE_GP150.md ("Rename"): logical message
 * 01 | crc8 | u16 len | P | T | cmd | [cmd][len][u32 index][name16], then F0 7F | chk | TOTAL | OFF | SEQ | IDX | nibbles | F7.
 * The wire result is also decoded back with the codec's own nibble reader.
 *
 *   node app/tests/test_gp150_rename_js.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { WebMidiGP150: W } = require(resolve(dirname(fileURLToPath(import.meta.url)), "../static/webmidi_gp150.js"));
const hex = (a) => Buffer.from(a).toString("hex");

function crc8(bytes) { // poly 0x31, init 0
  let c = 0;
  for (const v of bytes) { c ^= v; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x31) & 0xff : (c << 1) & 0xff; }
  return c;
}
function frame(rest) {
  const msg = [0x01, crc8(rest), rest.length & 0xff, rest.length >> 8, ...rest];
  const wire = msg.flatMap((b) => [b >> 4, b & 0xf]);
  const hdr = [msg.length & 0x7f, msg.length >> 7, 0, 0, 1, 0];          // TOTAL lo7 hi7, OFF lo7 hi7, SEQ 1, IDX 0
  const body = [...hdr, ...wire];
  return [0xf0, 0x7f, crc8(body) & 0x7f, ...body, 0xf7];
}
function expected(cmd, index, name) {
  const nameField = new Array(16).fill(0);
  [...name].forEach((ch, i) => { nameField[i] = ch.charCodeAt(0); });
  const data = [index & 0xff, (index >> 8) & 0xff, 0, 0, ...nameField];
  return frame([0x00, (cmd >> 12) & 0xf, cmd & 0xff, cmd >> 8, cmd & 0xff, cmd >> 8, data.length + 4, 0, ...data]);
}
const expectedQuery = (cmd) => frame([0x03, (cmd >> 12) & 0xf, cmd & 0xff, cmd >> 8, cmd & 0xff, cmd >> 8, 2, 0]);

for (const [kind, cmd] of [["ir", 0x1041], ["st", 0x1051], ["nam", 0x1091]]) {
  for (const [index, name] of [[0, "A"], [19, "Sixteen chars!!!!"], [90, "Scratch rename"], [3, ""]].filter(([, n]) => n.length <= 16)) {
    const ours = [0xf0, ...W._codec.buildRenameMessage(kind, index, name, { counter: 1 }), 0xf7];
    assert.equal(hex(ours), hex(expected(cmd, index, name)), `${kind} ${index} ${JSON.stringify(name)}`);
  }
}
for (const cmd of [0x2000, 0x2010, 0x2050, 0x2070, 0x1010]) {
  assert.equal(hex([0xf0, ...W._codec.buildQueryMessage(cmd, { counter: 1 }), 0xf7]), hex(expectedQuery(cmd)), `query 0x${cmd.toString(16)}`);
}
// and it reproduces a request taken from a real Suite capture byte for byte (the preset-names query, SEQ 2)
assert.deepEqual(W._codec.buildQueryMessage(0x1010, { counter: 2 }), [127, 124, 12, 0, 0, 0, 2, 0, 0, 1, 8, 14, 0, 8, 0, 0, 0, 3, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 2, 0, 0]);
assert.throws(() => W._codec.buildRenameMessage("preset", 1, "x"), /kind/);
assert.throws(() => W._codec.buildRenameMessage("ir", 1, "this name is far too long"), /too long/);
assert.throws(() => W._codec.buildRenameMessage("ir", 1, "café"), /ASCII/);
assert.throws(() => W._codec.buildRenameMessage("nam", -1, "x"), /index/);
console.log("ok");
