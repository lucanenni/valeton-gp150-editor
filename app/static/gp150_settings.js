"use strict";
/*
 * GP-150 pedal settings (the "global" menu: audio, recording, controls, MIDI, display, Global EQ on/off).
 *
 * The pedal answers a query for 0x2000 with its firmware string (8 bytes) and then one record per group:
 *   0x2010 Global EQ (32 values of 4 bytes)   0x2020 audio   0x2030 recording   0x2040 MIDI   0x2050 system
 *   (0x2060 drum, 0x2070 tuner and more follow; they are kept as they are)
 * each as [cmd u16][len u16][len bytes]. A setting is a number at a byte offset of its record; to change one the
 * whole record is sent back with that number replaced (webmidi_gp150.js sendSetRecord).
 *
 * Where each setting lives, and its labels and ranges, were written down from public notes on the Suite menu
 * (the layout is shared with the GP-180) and checked against a real GP-150 reply: tests/fixtures/gp150_globals_reply.json.
 * The factory reset (0x2080) is not a setting and nothing here can reach it.
 *
 * Browser global GP150Settings; module.exports under node.
 */
(function (root) {
  const OFF_ON = ["Off", "On"];
  const CHANNELS = ["Omni", ...Array.from({ length: 16 }, (_, i) => String(i + 1))];
  const FS_FUNCTIONS = ["Patch +", "Patch −", ...Array.from({ length: 14 }, (_, i) => `Function ${i + 3}`), "Default"];
  const R = { eq: 0x2010, audio: 0x2020, rec: 0x2030, midi: 0x2040, sys: 0x2050 };

  const num = (name, label, group, cmd, off, type, min, max, unit = "") => ({ name, label, group, cmd, off, type, kind: "number", min, max, unit });
  const en = (name, label, group, cmd, off, type, labels) => ({ name, label, group, cmd, off, type, kind: "enum", min: 0, max: labels.length - 1, labels });

  // In the order of the pedal's menu.
  const SPECS = Object.freeze([
    num("inputLevel", "Input level", "audio", R.audio, 0, "i16", -20, 20, "dB"),
    en("outputStereo", "Right output", "audio", R.audio, 2, "u16", ["Mono", "Stereo"]),
    en("noCabL", "No cab, left output", "audio", R.audio, 4, "u16", OFF_ON),
    en("noCabR", "No cab, right output", "audio", R.audio, 6, "u16", OFF_ON),
    en("autoCabMatch", "Auto cab match", "audio", R.sys, 20, "u8", OFF_ON),
    num("micLevel", "Mic level", "audio", R.audio, 8, "u16", 0, 100),
    en("micMonitor", "Mic monitor", "audio", R.audio, 10, "u16", OFF_ON),
    en("micJack", "Mic/phones jack", "audio", R.audio, 12, "u16", ["TRS", "TRRS"]),
    en("globalEq", "Global EQ", "audio", R.eq, 0, "u8", OFF_ON),
    num("usbRecLevel", "USB record level", "recording", R.rec, 0, "i16", -20, 20, "dB"),
    num("btRecLevel", "Bluetooth record level", "recording", R.rec, 2, "i16", -20, 20, "dB"),
    num("micRecLevel", "Mic record level", "recording", R.rec, 4, "i16", -20, 20, "dB"),
    en("recModeL", "Record mode, left", "recording", R.rec, 6, "u16", ["Dry", "Wet"]),
    en("recModeR", "Record mode, right", "recording", R.rec, 8, "u16", ["Dry", "Wet"]),
    num("usbMonitorLevel", "USB monitor level", "recording", R.rec, 10, "i16", -20, 20, "dB"),
    num("btAudioLevel", "Bluetooth audio level", "recording", R.sys, 17, "u8", 0, 100),
    en("fsMode", "Footswitch mode", "controls", R.sys, 6, "u8", ["Patch", "Stomp"]),
    en("autoSave", "Auto save", "controls", R.sys, 22, "u8", OFF_ON),
    en("expJack", "EXP / MIDI in jack", "controls", R.sys, 8, "u8", ["MIDI in", "Expression pedal"]),
    en("fsJack", "FS / MIDI out jack", "controls", R.sys, 9, "u8", ["MIDI out", "Single footswitch", "Double footswitch"]),
    en("extFs1", "External footswitch 1", "controls", R.sys, 10, "u8", FS_FUNCTIONS),
    en("extFs2", "External footswitch 2", "controls", R.sys, 11, "u8", FS_FUNCTIONS),
    en("tapPre", "Tap tempo sets PRE", "controls", R.sys, 12, "u8", OFF_ON),
    en("tapMod", "Tap tempo sets MOD", "controls", R.sys, 13, "u8", OFF_ON),
    en("tapDly", "Tap tempo sets DLY", "controls", R.sys, 14, "u8", OFF_ON),
    en("midiInSource", "MIDI in", "midi", R.midi, 0, "u16", ["TRS only", "USB only", "Bluetooth only", "Mixed"]),
    en("midiInChannelTrs", "MIDI in channel (TRS)", "midi", R.midi, 2, "u16", CHANNELS),
    en("midiInChannelUsb", "MIDI in channel (USB)", "midi", R.midi, 4, "u16", CHANNELS),
    en("midiInChannelBt", "MIDI in channel (Bluetooth)", "midi", R.midi, 6, "u16", CHANNELS),
    en("midiOutChannelTrs", "MIDI out channel (TRS)", "midi", R.midi, 8, "u16", CHANNELS),
    en("midiOutChannelUsb", "MIDI out channel (USB)", "midi", R.midi, 10, "u16", CHANNELS),
    en("midiOutChannelBt", "MIDI out channel (Bluetooth)", "midi", R.midi, 12, "u16", CHANNELS),
    en("clockSource", "Tempo clock source", "midi", R.midi, 14, "u16", ["Internal", "TRS only", "USB only", "External", "Mixed"]),
    en("clockOutTrs", "Send clock (TRS)", "midi", R.midi, 16, "u16", OFF_ON),
    en("cloudOutUsb", "Cloud out (USB)", "midi", R.midi, 18, "u16", OFF_ON),
    en("brightness", "Display brightness", "display", R.sys, 0, "u16", ["I", "II", "III"]),
    en("displayTimeout", "Display off after", "display", R.sys, 2, "u16", ["5 minutes", "30 minutes", "Never"]),
  ]);
  const BY_NAME = Object.freeze(Object.fromEntries(SPECS.map((s) => [s.name, s])));
  const GROUPS = Object.freeze([["audio", "Audio"], ["recording", "Recording"], ["controls", "Controls"], ["midi", "MIDI"], ["display", "Display"]]);
  const WIDTH = { u8: 1, u16: 2, i16: 2 };
  const FORBIDDEN = new Set([0x2080]);   // factory reset

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const specOf = (name) => { const s = BY_NAME[name]; if (!s) throw new RangeError(`The GP-150 has no setting ${name}`); return s; };

  // The query reply as the codec hands it over (the logical message: 01 | crc | len | P | T | cmd | [cmd][len] | data).
  // -> {firmware, records: Map(cmd -> Uint8Array)}
  function parseGlobalsReply(stream) {
    const b = stream instanceof Uint8Array ? stream : Uint8Array.from(stream);
    if (b.length < 20 || b[0] !== 0x01 || u16(b, 6) !== 0x2000) throw new Error("not a settings reply");
    const d = b.subarray(12);
    let firmware = "";
    for (let i = 0; i < 8 && d[i]; i++) firmware += String.fromCharCode(d[i]);
    const records = new Map();
    for (let o = 8; o + 4 <= d.length;) {
      const cmd = u16(d, o), len = u16(d, o + 2);
      if (cmd === 0 || o + 4 + len > d.length) break;
      records.set(cmd, d.slice(o + 4, o + 4 + len));
      o += 4 + len;
    }
    return { firmware: firmware.replace(/^V/, ""), records };
  }

  function readValue(record, spec) {
    if (!record || record.length < spec.off + WIDTH[spec.type]) return null;
    if (spec.type === "u8") return record[spec.off];
    const v = u16(record, spec.off);
    return spec.type === "i16" && v & 0x8000 ? v - 0x10000 : v;
  }
  // every setting found in `records` -> {name: value}
  function valuesOf(records) {
    const out = {};
    for (const s of SPECS) { const v = readValue(records.get(s.cmd), s); if (v != null) out[s.name] = v; }
    return out;
  }
  // A copy of `record` with setting `name` set to `value`: a whole number within the setting's range.
  function withValue(record, name, value) {
    const s = specOf(name);
    if (FORBIDDEN.has(s.cmd)) throw new Error("that record is never written");
    if (!Number.isInteger(value) || value < s.min || value > s.max) throw new RangeError(`${s.label}: ${value} is outside ${s.min}..${s.max}`);
    if (!record || record.length < s.off + WIDTH[s.type]) throw new Error(`the ${s.label} record is shorter than expected`);
    const out = Uint8Array.from(record);
    if (s.type === "u8") out[s.off] = value & 0xff;
    else { out[s.off] = value & 0xff; out[s.off + 1] = (value >> 8) & 0xff; }
    return out;
  }
  const label = (name, value) => { const s = specOf(name); return s.kind === "enum" ? (s.labels[value] ?? `#${value}`) : `${value}${s.unit ? " " + s.unit : ""}`; };

  // Global EQ record: 32 values; 0 is the on/off (u32), 1 the level, 2..31 the bands (f32).
  function eqValues(record) {
    if (!record || record.length < 128) return null;
    const dv = new DataView(record.buffer, record.byteOffset, record.byteLength);
    const f = (i) => Number(dv.getFloat32(4 * i, true).toFixed(3));
    return { on: dv.getUint32(0, true) === 1, level: f(1), bands: Array.from({ length: 30 }, (_, i) => f(i + 2)) };
  }

  const API = { SPECS, BY_NAME, GROUPS, parseGlobalsReply, valuesOf, withValue, readValue, label, eqValues, FORBIDDEN };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else root.GP150Settings = API;
})(typeof window !== "undefined" ? window : globalThis);
