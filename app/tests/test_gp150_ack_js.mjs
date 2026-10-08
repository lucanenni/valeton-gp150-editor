/*
 * The acknowledgement Suite sends after every completed reply (`7f TAG 00 00 00 00 CAT 00`) must be
 * reproduced byte for byte. Expected values are verbatim host messages from the real captures
 * re/gp150_captures/{startup_sequence,cold_start_ampgain,patch_1_open}.mmon.
 *
 *   node app/tests/test_gp150_ack_js.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { WebMidiGP150 } = require(resolve(dirname(fileURLToPath(import.meta.url)), "../static/webmidi_gp150.js"));
const hex = (a) => Buffer.from(a).toString("hex");
const real = { 0x29: "7f1f000000002900", 0x2a: "7f32000000002a00", 0x2b: "7f46000000002b00", 0x2c: "7f68000000002c00",
  0x2d: "7f1c000000002d00", 0x01: "7f74000000000100", 0x02: "7f59000000000200", 0x03: "7f2d000000000300",
  0x04: "7f03000000000400", 0x15: "7f19000000001500", 0x16: "7f34000000001600" };
for (const [cat, want] of Object.entries(real)) assert.equal(hex(WebMidiGP150.buildAckMessage(Number(cat))), want, `category ${cat}`);
console.log("ok");
