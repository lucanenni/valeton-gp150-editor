// Library uploads for the MCP server: User IR, NAM model, SnapTone (.clo), and SnapTone creation from a
// NAM file or a recording. The pedal-facing functions take the WebMidiGP150 module `W` so they can be tested
// against a fake pedal.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { root } from "./catalog.mjs";
import { Profiler, Reference, NamWaveNet, profileInThread, renderNam } from "./threads.mjs";

const require = createRequire(import.meta.url);
export const Prep = require(resolve(root, "app/static/gp150_upload_prep.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLACEHOLDER_INDEX = 0x10000;   // slots that were never written read back with this offset
export const KINDS = {
  snaptone: { label: "SnapTone", min: 51, max: 100, env: "GP150_OVERWRITABLE_SNAPTONE_SLOTS", wire: (s) => s, read: (W) => W.readSnaptones() },
  nam: { label: "NAM", min: 1, max: 20, env: "GP150_OVERWRITABLE_NAM_SLOTS", wire: (s) => s, read: (W) => W.readNamModels() },
  ir: { label: "User IR", min: 1, max: 20, env: "GP150_OVERWRITABLE_IR_SLOTS", wire: (s) => s - 1, read: (W) => W.readUserIrs() },
};

// "52,65-66" -> Set {52, 65, 66}
export function parseSlotList(str) {
  const out = new Set();
  for (const part of String(str || "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad slot list "${str}" (use e.g. "52,65-66")`);
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) out.add(i);
  }
  return out;
}

// -> {slot, name, written} for each real slot of the library
export function describeLibrary(kind, entries) {
  const k = KINDS[kind];
  const out = [];
  for (let slot = kind === "snaptone" ? 1 : k.min; slot <= k.max; slot++) {
    const e = entries.find((x) => (x.index & 0xffff) === k.wire(slot));
    if (!e) continue;
    // anything that does not clearly read back as a placeholder counts as written
    const written = e.index < PLACEHOLDER_INDEX && !/^(empty|none)\b/i.test(e.name || "");
    out.push({ slot, name: e.name || "", written });
  }
  return out;
}

// Throws unless `slot` may be written: in range, never written before, or listed in the kind's
// GP150_OVERWRITABLE_* variable. Returns what is there now.
export function checkSlot(kind, slot, entries, env = process.env) {
  const k = KINDS[kind];
  if (!Number.isInteger(slot) || slot < k.min || slot > k.max) {
    throw new Error(`${k.label} slot must be ${k.min}-${k.max}${kind === "snaptone" ? " (1-50 are factory SnapTones)" : ""}, got ${slot}`);
  }
  const cur = describeLibrary(kind, entries).find((x) => x.slot === slot);
  if (!cur) throw new Error(`${k.label} slot ${slot} was not found in the pedal's list`);
  if (cur.written && !parseSlotList(env[k.env]).has(slot)) {
    throw new Error(
      `${k.label} slot ${slot} already holds "${cur.name}" and is not in the overwritable list. Writing there would replace it` +
      `${kind === "snaptone" ? " (and change every preset that uses it — see find_usage)" : ""}. ` +
      `Pick a free slot, or add ${slot} to ${k.env} (claude mcp add -e ${k.env}=${slot} …) to allow it.`);
  }
  return cur;
}

export const readLibrary = (W, kind) => KINDS[kind].read(W);

// ---- input preparation ------------------------------------------------------------------------------------------
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

export function prepareIr(path) {
  const wav = Prep.decodeWavPcmSamples(toAB(readFileSync(path)), { maxFrames: 2048 });
  const total = Prep.decodeWavPcmSamples(toAB(readFileSync(path))).samples.length;
  return { samples: wav.samples, sampleRate: wav.sampleRate, truncated: total > wav.samples.length ? total : 0,
    note: `${wav.channels}ch ${wav.bitsPerSample}-bit ${wav.sampleRate} Hz, ${wav.samples.length} samples (${(wav.samples.length / wav.sampleRate * 1000).toFixed(0)} ms)` };
}

export function prepareNam(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const { weights, loudness } = Prep.pickNamLiteModel(json, 1871);
  return { weights, loudness: loudness || 0, defaultName: json.metadata && json.metadata.name };
}

export function prepareClo(path) {
  const bytes = new Uint8Array(readFileSync(path));
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "VTSI") throw new Error(`not a .clo file — expected the "VTSI" magic, got "${magic}"`);
  return bytes;
}

// ---- SnapTone creation ------------------------------------------------------------------------------------------
export const referenceSignal = () => Reference.get();                      // Float32Array, 48 kHz, 70 s
export const referenceWav = () => Reference.toWav16(Reference.get(), Reference.SAMPLE_RATE);

const MIN_SECONDS = 69;   // the profiler needs the whole 70 s test signal
const to48k = (a) => (a.sampleRate === 48000 ? a.samples : Profiler.resample(a.samples, a.sampleRate, 48000));

export function loadRecording(path) {
  const x = to48k(Prep.decodeWavFloat(toAB(readFileSync(path))));
  if (x.length < MIN_SECONDS * 48000) throw new Error(`the recording is ${(x.length / 48000).toFixed(1)} s long — it must cover the whole 70 s test signal (from the very start of playback)`);
  return x;
}

export function loadNamModel(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const model = NamWaveNet.extractAnyModel(json);
  if ((model.sampleRate || 48000) !== 48000) throw new Error(`the model runs at ${model.sampleRate} Hz — only 48 kHz NAM models are supported`);
  return { model, defaultName: json.metadata && json.metadata.name };
}

// reference + recording -> device-form .clo
export async function cloFromRecording(recording, { onProgress } = {}) {
  const ref = referenceSignal();
  const prof = await profileInThread(ref, recording, { onProgress });
  return Profiler.toDeviceClo(Profiler.assembleClo(prof));
}

// NAM model -> "recording" of it playing the reference -> .clo
export async function cloFromNam(model, { onProgress } = {}) {
  const modeled = await renderNam(model, referenceSignal(), { onProgress: onProgress && ((f) => onProgress("Running the NAM model", f)) });
  return cloFromRecording(Prep.quantizeNamOutput(modeled), { onProgress });
}

// ---- writing ----------------------------------------------------------------------------------------------------
// Checks the slot, sends the upload, waits, re-reads the list and reports what the slot holds now.
export async function upload(W, kind, slot, name, send, { env = process.env, settleMs = 3000, sleepFn = sleep } = {}) {
  const k = KINDS[kind];
  const before = checkSlot(kind, slot, await readLibrary(W, kind), env);
  await sleepFn(500);
  const chunks = send(W);
  const clean = Prep.sanitizeName(name);
  // The pedal needs a moment to commit the slot; re-read a few times before calling it unconfirmed.
  let after = null, confirmed = false;
  for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
    await sleepFn(settleMs);
    after = describeLibrary(kind, await readLibrary(W, kind)).find((x) => x.slot === slot);
    confirmed = !!after && after.written && after.name.trim() === clean.trim();
  }
  return { kind: k.label, slot, name: clean, replaced: before.written ? before.name : null, chunks: chunks.length,
    confirmed, now_in_slot: after ? after.name : null };
}
