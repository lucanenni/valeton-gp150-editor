#!/usr/bin/env node
// MCP server for the Valeton GP-150 (read-only tools for now). Speaks MCP over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decodePatch, describeModel, searchModels, MODULES } from "./lib/catalog.mjs";
import { withDevice, disconnect } from "./lib/device.mjs";
import { buildPatch, editPatch } from "./lib/builder.mjs";
import { writeFileSync } from "node:fs";
import { KINDS, upload, readLibrary, describeLibrary, checkSlot, prepareIr, prepareNam, prepareClo,
  loadRecording, loadNamModel, cloFromRecording, cloFromNam, referenceWav, Prep } from "./lib/uploads.mjs";
import { presetsUsing } from "./lib/usage.mjs";
import { basename } from "node:path";

const server = new McpServer({ name: "gp150", version: "0.2.0" });
const patches = new Map();            // patch_id -> { body, name }   (kept in memory for this session)
let patchCounter = 0;
const remember = (body, name) => { const id = `p${++patchCounter}`; patches.set(id, { body, name }); return id; };
const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

server.registerTool("search_models", {
  title: "Search GP-150 effect models",
  description: "Search the GP-150 model catalog (306 models: amps, cabs, pedals, effects, SnapTone slots). Filter by module (NR, PRE, WAH, DST, NS, AMP, CAB, EQ, MOD, DLY, RVB, VOL) and/or words matched against the model name, the original gear it emulates (e.g. 'Marshall', 'Tube Screamer') and its type. Does not touch the pedal.",
  inputSchema: { module: z.enum(MODULES).optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  annotations: { ...readOnly, openWorldHint: false },
}, async (args) => text(searchModels(args)));

server.registerTool("describe_model", {
  title: "Describe one GP-150 model",
  description: "Full description of one catalog model by fxid (from search_models): module, name, the gear it emulates, and every parameter with range, default, unit and named options. Does not touch the pedal.",
  inputSchema: { fxid: z.number().int() },
  annotations: readOnly,
}, async ({ fxid }) => { const d = describeModel(fxid); return d ? text(d) : fail(new Error(`unknown fxid ${fxid}`)); });

server.registerTool("list_presets", {
  title: "List the 200 preset names on the pedal",
  description: "Reads the names of all 200 presets from the connected GP-150 in one request (slot numbers are 1-based). Does not select or change anything on the pedal. Needs the GP-150 on USB with Valeton Suite closed; the first call takes ~8 s while the link is set up.",
  inputSchema: {},
  annotations: { ...readOnly, openWorldHint: true },
}, async () => {
  try {
    const names = await withDevice((W) => W.readAllNames());
    const list = Array.isArray(names) ? names : names.items || [];
    return text(list.map((x) => ({ slot: x.index + 1, name: x.name })));
  } catch (e) { return fail(e); }
});

server.registerTool("read_active_patch", {
  title: "Read the patch currently active on the pedal",
  description: "Reads the preset that is active on the GP-150 right now and decodes it (returns a patch_id you can pass to edit_patch or write_patch): name, slot, signal chain order, and for each module whether it is on, which model it holds (and the gear it emulates) and every parameter value. Does not select anything on the pedal.",
  inputSchema: {},
  annotations: { ...readOnly, openWorldHint: true },
}, async () => {
  try {
    const body = await withDevice((W) => W.readActivePreset());
    const summary = decodePatch(body);
    return text({ patch_id: remember(body, summary.name), ...summary });
  } catch (e) { return fail(e); }
});

// ---- building, editing and writing patches ------------------------------------------------------
server.registerTool("build_patch", {
  title: "Build a GP-150 patch",
  description: "Builds a GP-150 patch from a description and returns a patch_id (plus the decoded result and any warnings). Nothing is sent to the pedal; use write_patch for that. `modules` maps a module (NR, PRE, WAH, DST, NS, AMP, CAB, EQ, MOD, DLY, RVB, VOL) to {model, enabled?, params?}: `model` is a catalog name or fxid (see search_models; the name can also match the emulated gear, e.g. 'JCM800'), `params` are set by parameter name (see describe_model) on top of the model's defaults, values outside a parameter's range are clamped with a warning. Modules you leave out stay off. The signal chain defaults to NR PRE WAH DST NS AMP CAB EQ MOD DLY RVB VOL; pass `chain` to reorder. Optionally saves the .prst to `save_to`.",
  inputSchema: {
    name: z.string().min(1).max(13).describe("patch name, up to 13 ASCII characters"),
    chain: z.array(z.enum(MODULES)).length(12).optional(),
    modules: z.record(z.string(), z.object({
      model: z.union([z.string(), z.number().int()]),
      enabled: z.boolean().optional(),
      params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    })),
    save_to: z.string().optional().describe("optional path for a .prst copy"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => {
  try {
    const { body, warnings, summary } = buildPatch(args);
    const id = remember(body, args.name);
    if (args.save_to) writeFileSync(args.save_to, body);
    return text({ patch_id: id, verified: "decoded back and matches the description", warnings, patch: summary, ...(args.save_to ? { saved_to: args.save_to } : {}) });
  } catch (e) { return fail(e); }
});

server.registerTool("read_patch", {
  title: "Read one preset slot from the pedal",
  description: "Reads preset slot `slot` (1–200) from the connected GP-150 and decodes it (name, chain, models, every parameter); returns a patch_id for edit_patch/write_patch. Asks the pedal for that slot's body by index: the active preset and the front panel are not touched. Does not modify any preset.",
  inputSchema: { slot: z.number().int().min(1).max(200) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ slot }) => {
  try {
    const body = await withDevice((W) => W.readPresetByIndex(slot - 1));
    const summary = decodePatch(body);
    return text({ patch_id: remember(body, summary.name), ...summary });
  } catch (e) { return fail(e); }
});

server.registerTool("edit_patch", {
  title: "Edit a patch (from read_patch, read_active_patch or build_patch)",
  description: "Returns a modified copy of patch `patch_id` as a new patch_id (the original is unchanged; nothing is sent to the pedal — use write_patch for that). `changes` may contain: name; chain (all 12 modules in the new order); modules: {MODULE: {model?, enabled?, params?}} — `params` are set by name on the module's current model (see describe_model), giving a different `model` replaces it and starts from that model's defaults, out-of-range values are clamped with a warning. The result lists exactly what changed.",
  inputSchema: {
    patch_id: z.string(),
    name: z.string().min(1).max(13).optional(),
    chain: z.array(z.enum(MODULES)).length(12).optional(),
    modules: z.record(z.string(), z.object({
      model: z.union([z.string(), z.number().int()]).optional(),
      enabled: z.boolean().optional(),
      params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    })).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ patch_id, ...changes }) => {
  try {
    const src = patches.get(patch_id);
    if (!src) throw new Error(`unknown patch_id ${patch_id}`);
    const { body, warnings, summary, changes: diff } = editPatch(src.body, changes);
    return text({ patch_id: remember(body, summary.name), based_on: patch_id, changed: diff, warnings, patch: summary });
  } catch (e) { return fail(e); }
});

// Slots a write may target: GP150_WRITABLE_SLOTS (e.g. "190-199,150"), default the scratch range 190-199.
function writableSlots() {
  const set = new Set();
  for (const part of (process.env.GP150_WRITABLE_SLOTS || "190-199").split(",")) {
    const [a, b] = part.trim().split("-").map(Number);
    for (let i = a; i <= (b ?? a); i++) set.add(i);
  }
  return set;
}

server.registerTool("write_patch", {
  title: "Write a built patch to a preset slot on the pedal",
  description: "OVERWRITES preset slot `slot` (1–200) on the connected GP-150 with a patch made by build_patch, without selecting or activating it. Only slots in the allowed list (default 190–199, set with GP150_WRITABLE_SLOTS) can be written. Afterwards it re-reads the preset names and reports what the pedal now shows in that slot. The previous content of the slot is lost.",
  inputSchema: { patch_id: z.string(), slot: z.number().int().min(1).max(200) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ patch_id, slot }) => {
  try {
    const p = patches.get(patch_id);
    if (!p) throw new Error(`unknown patch_id ${patch_id} (build one with build_patch first)`);
    if (!writableSlots().has(slot)) throw new Error(`slot ${slot} is not in the writable list (${[...writableSlots()].join(",")}); set GP150_WRITABLE_SLOTS to allow more`);
    const res = await withDevice(async (W) => {
      W.sendWritePreset(p.body, slot - 1);
      await new Promise((r) => setTimeout(r, 1500));
      const names = await W.readAllNames();
      const list = Array.isArray(names) ? names : names.items || [];
      return list.find((x) => x.index === slot - 1);
    });
    const ok = !!res && res.name.trim() === p.name.trim();
    return text({ ok, slot, written_name: p.name, name_on_pedal: res ? res.name : null, note: ok ? "the pedal accepted the patch (name read back)" : "the name read back does not match — check the pedal" });
  } catch (e) { return fail(e); }
});

// ---- library: SnapTones, NAM models, User IRs --------------------------------------------------------------------
const kindSchema = z.enum(["snaptone", "nam", "ir"]).describe("snaptone (slots 51-100 writable, 1-50 factory), nam (1-20) or ir (User IR, 1-20)");
const writeAnn = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const OVERWRITE_NOTE = "Only slots that were never written may be targeted, unless the slot is listed in GP150_OVERWRITABLE_SNAPTONE_SLOTS / _NAM_SLOTS / _IR_SLOTS (e.g. \"52,65-66\").";

server.registerTool("list_library", {
  title: "List the pedal's SnapTones, NAM models or User IRs",
  description: "Reads one library from the pedal: slot, name and whether the slot has ever been written (free slots are the ones safe to upload to).",
  inputSchema: { kind: kindSchema, only_user_slots: z.boolean().optional().describe("snaptone: hide the 50 factory SnapTones (default true)") },
  annotations: { ...readOnly, openWorldHint: true },
}, async ({ kind, only_user_slots = true }) => {
  try {
    const entries = await withDevice((W) => readLibrary(W, kind));
    let list = describeLibrary(kind, entries);
    if (kind === "snaptone" && only_user_slots) list = list.filter((x) => x.slot >= KINDS.snaptone.min);
    return text({ kind, slots: list, free: list.filter((x) => !x.written).map((x) => x.slot) });
  } catch (e) { return fail(e); }
});

server.registerTool("find_usage", {
  title: "Which presets use a SnapTone / NAM model / User IR",
  description: "Lists the presets that point at one library slot (module on/off shown), so you know what an overwrite would change. The first call reads all 200 presets by index (about 40 s); later calls only re-read presets whose name changed. `rescan: true` re-reads everything.",
  inputSchema: { kind: kindSchema, slot: z.number().int().min(1).max(100), rescan: z.boolean().optional() },
  annotations: { ...readOnly, openWorldHint: true },
}, async ({ kind, slot, rescan }) => {
  try {
    return text({ kind, slot, ...(await withDevice((W) => presetsUsing(W, kind, slot, { rescan }))) });
  } catch (e) { return fail(e); }
});

server.registerTool("upload_ir", {
  title: "Upload a User IR (.wav) to the pedal",
  description: "Sends the first channel of a PCM .wav (16/24/32-bit; the pedal keeps the first 2048 samples, ~46 ms at 44.1 kHz) to User IR slot 1-20, then re-reads the list to confirm. " + OVERWRITE_NOTE,
  inputSchema: { path: z.string().describe("absolute path of the .wav"), slot: z.number().int().min(1).max(20), name: z.string().min(1).max(16).optional() },
  annotations: writeAnn,
}, async ({ path, slot, name }) => {
  try {
    const ir = prepareIr(path);
    const nm = name || basename(path).replace(/\.wav$/i, "");
    const res = await withDevice((W) => upload(W, "ir", slot, nm, (w) => w.sendIrUpload(slot - 1, Prep.sanitizeName(nm), ir.samples)));
    return text({ ...res, source: ir.note, ...(ir.truncated ? { warning: `the file has ${ir.truncated} samples; only the first 2048 were sent` } : {}) });
  } catch (e) { return fail(e); }
});

server.registerTool("upload_nam", {
  title: "Upload a NAM model (.nam, A2 Lite) to the pedal",
  description: "Sends a NAM file that contains the pedal's one supported architecture (a 'lite' WaveNet with 1871 weights, e.g. an A2 slimmable container's lite model) to NAM slot 1-20, then re-reads the list to confirm. " + OVERWRITE_NOTE,
  inputSchema: { path: z.string().describe("absolute path of the .nam"), slot: z.number().int().min(1).max(20), name: z.string().min(1).max(16).optional() },
  annotations: writeAnn,
}, async ({ path, slot, name }) => {
  try {
    const nam = prepareNam(path);
    const nm = name || nam.defaultName || basename(path).replace(/\.nam$/i, "");
    const res = await withDevice((W) => upload(W, "nam", slot, nm, (w) => w.sendNamUpload(slot, Prep.sanitizeName(nm), nam.weights, nam.loudness)));
    return text(res);
  } catch (e) { return fail(e); }
});

server.registerTool("upload_snaptone", {
  title: "Upload a ready-made SnapTone (.clo) to the pedal",
  description: "Sends a .clo file to SnapTone slot 51-100, then re-reads the list to confirm. A SnapTone slot is shared: every preset that points at it changes (see find_usage). " + OVERWRITE_NOTE,
  inputSchema: { path: z.string().describe("absolute path of the .clo"), slot: z.number().int().min(51).max(100), name: z.string().min(1).max(16).optional() },
  annotations: writeAnn,
}, async ({ path, slot, name }) => {
  try {
    const clo = prepareClo(path);
    const nm = name || basename(path).replace(/\.clo$/i, "");
    return text(await withDevice((W) => upload(W, "snaptone", slot, nm, (w) => w.sendSnapToneUpload(slot, Prep.sanitizeName(nm), clo))));
  } catch (e) { return fail(e); }
});

// Fail fast on a bad slot before spending ~20 s of CPU on the profile.
async function precheck(kind, slot) { return withDevice(async (W) => checkSlot(kind, slot, await readLibrary(W, kind))); }

server.registerTool("create_snaptone_from_nam", {
  title: "Create a SnapTone from a .nam model and upload it",
  description: "Runs the NAM model on the built-in 70 s test signal, profiles the result into a SnapTone and uploads it to SnapTone slot 51-100 (about 20-40 s). 48 kHz models only. The result can differ slightly from a SnapTone made with Valeton Suite (about 1 dB in level). A SnapTone slot is shared by every preset that points at it. " + OVERWRITE_NOTE,
  inputSchema: { path: z.string().describe("absolute path of the .nam"), slot: z.number().int().min(51).max(100), name: z.string().min(1).max(16).optional() },
  annotations: writeAnn,
}, async ({ path, slot, name }) => {
  try {
    const { model, defaultName } = loadNamModel(path);
    await precheck("snaptone", slot);
    const nm = name || defaultName || basename(path).replace(/\.nam$/i, "");
    const t0 = Date.now();
    const clo = await cloFromNam(model);
    const res = await withDevice((W) => upload(W, "snaptone", slot, nm, (w) => w.sendSnapToneUpload(slot, Prep.sanitizeName(nm), clo)));
    return text({ ...res, built_in_s: Math.round((Date.now() - t0) / 1000) });
  } catch (e) { return fail(e); }
});

server.registerTool("export_reference_signal", {
  title: "Write the 70 s SnapTone test signal as a .wav",
  description: "Writes the built-in reference signal (16-bit mono, 48 kHz, 70 s) to `path`. Play it through your amp, record the output from the very start (same length, nothing trimmed) and pass the recording to create_snaptone_from_recording. Nothing is sent to the pedal.",
  inputSchema: { path: z.string().describe("where to write reference.wav") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ path }) => {
  try { writeFileSync(path, referenceWav()); return text({ saved_to: path, seconds: 70, sample_rate: 48000 }); } catch (e) { return fail(e); }
});

server.registerTool("create_snaptone_from_recording", {
  title: "Create a SnapTone from a recording of your amp and upload it",
  description: "Profiles a recording of the reference signal played through your amp (see export_reference_signal; any PCM/float .wav that covers the whole 70 s) into a SnapTone and uploads it to SnapTone slot 51-100 (about 15-25 s). A SnapTone slot is shared by every preset that points at it. " + OVERWRITE_NOTE,
  inputSchema: { recording_path: z.string().describe("absolute path of the recording .wav"), slot: z.number().int().min(51).max(100), name: z.string().min(1).max(16).optional() },
  annotations: writeAnn,
}, async ({ recording_path, slot, name }) => {
  try {
    const rec = loadRecording(recording_path);
    await precheck("snaptone", slot);
    const nm = name || basename(recording_path).replace(/\.[^.]*$/, "");
    const t0 = Date.now();
    const clo = await cloFromRecording(rec);
    const res = await withDevice((W) => upload(W, "snaptone", slot, nm, (w) => w.sendSnapToneUpload(slot, Prep.sanitizeName(nm), clo)));
    return text({ ...res, built_in_s: Math.round((Date.now() - t0) / 1000) });
  } catch (e) { return fail(e); }
});

process.on("exit", disconnect);
await server.connect(new StdioServerTransport());
console.error("gp150 MCP server ready");
