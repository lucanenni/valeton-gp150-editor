"use strict";
/*
 * gp150_format.js — the GP-150 .prst format, in the browser.
 *
 * A faithful port of patch/gp150_format.py (read side + the narrow
 * skeleton-editing writer) so the GP-50/GP-5 -> GP-150 converter can run
 * 100% client-side (no Python backend) — see convert_gp50_to_gp150.js.
 * See patch/gp150_format.py's own docstring for what's confirmed and why
 * build_from_skeleton() is safe to have despite the ~168-byte tail still being
 * undecoded: every write here targets a field the read side already fully
 * understands, and everything else is left exactly as the skeleton (a real,
 * valid GP-150 .prst) already had it; the file checksum is recomputed
 * (computeChecksum()).
 *
 * Exposes window.GP150Format in the browser and module.exports under node
 * (for the oracle cross-check, app/tests/test_gp150_convert_js.mjs).
 */
(function (root) {
  const PRST_LEN = 1128;
  // From patch/prst_format.py's HEADER_GP150 — that module owns device
  // detection for GP-5/GP-50/GP-150 in Python, but prst.js (this project's
  // JS port of prst_format.py) only ported the GP-5/GP-50 profiles, so this
  // page needs its own minimal check.
  const HEADER_GP150 = [0x11, 0x30, 0x64, 0x04];

  const PATCH_INDEX_OFF = 0x04;
  const NAME_OFF = 0x2c;
  const NAME_MAX = 13; // confirmed: a 16-char input truncates to exactly 13 on the device
  const ORDER_OFF = 0x78;
  const ORDER_LEN = 12;

  // Module index order for the 0x78 chain-order array. FIXED 2026-09-20 --
  // was the manual's MIDI Control Information List order (CC48-59, NR
  // first), never independently verified against a real non-default chain
  // order until a live reorder proved it wrong (see patch/gp150_format.py's
  // MODULE_NAMES comment and design/GP150_SUPPORT.md §3.1 for
  // the full derivation). Correct order matches fxid_ring_gp150.json's own
  // moduleId field.
  const MODULE_NAMES = ["PRE", "WAH", "DST", "NS", "AMP", "NR", "CAB", "EQ", "MOD", "DLY", "RVB", "VOL"];

  const MODULE_PARAM_OFFSET = {
    PRE: 0x08c, WAH: 0x0d0, DST: 0x114, NS: 0x158, AMP: 0x19c, NR: 0x1e0,
    CAB: 0x228, EQ: 0x27c, MOD: 0x2ac, DLY: 0x2f0, RVB: 0x334, VOL: 0x378,
  };

  const MODULE_MODEL_OFFSET = {
    PRE: 0x088, WAH: 0x0cc, DST: 0x110, NS: 0x154, AMP: 0x198, NR: 0x1dc,
    CAB: 0x220, EQ: 0x264, MOD: 0x2a8, DLY: 0x2ec, RVB: 0x330, VOL: 0x374,
  };

  const FXID_NONE = 100663299;

  const MODULE_ENABLE_OFFSET = {};
  for (const m of Object.keys(MODULE_MODEL_OFFSET)) MODULE_ENABLE_OFFSET[m] = MODULE_MODEL_OFFSET[m] - 4;

  // --- GP150-10 (2026-09-23): patch-level settings beyond the effects
  // chain. Each field was confirmed by a live read + diff on real
  // hardware. Byte offsets below are
  // absolute, within the 1128-byte body -- unlike the module offsets
  // above, these all live in ONE contiguous "PatchData preset-info"-family
  // region (0x020-0x074) plus a separate tail (0x3B4-EOF); nothing here
  // overlaps the 12-module block itself (0x088-0x3B8/0x3B4-ish).
  const PRESET_INFO_OFF = 0x020; // PatchData preset-info: magic 0x3020, 84 bytes
  const PRESET_BPM_OFF = 0x024; // i16
  const PATCH_VOL_OFF = 0x026; // i16
  const CURRENT_MODE_OFF = 0x028; // u16, unconfirmed range, not exposed here
  const PRESET_NAM_OFF = 0x02a; // u16 -- confirmed live 2026-09-23: 0 shows "N->S" on the pedal's own display, 1 shows "NAM" (then the loaded NAM profile name, e.g. "A2 Lite" -- not decoded here)

  const QUICK_KNOB_OFF = 0x3b4; // PatchData quick-knob: magic 0x3050, 16 bytes
  const QUICK_KNOB_ENTRY_OFF = 0x3b8; // 3 x {targetId: i16, algId: i16}
  const QUICK_KNOB_COUNT = 3;
  const QUICK_KNOB_ENTRY_LEN = 4;

  const EXP_CTRL_OFF = 0x3c4; // PatchData EXP/CTRL: magic 0x3060, 116 bytes
  const EXP_CTRL_ENTRY_OFF = 0x3c8; // 9 x {targetId: i16, algId: i16, rangeMin: f32, rangeMax: f32}
  const EXP_CTRL_COUNT = 9;
  const EXP_CTRL_ENTRY_LEN = 12;
  // Index -> {EXP1-A, EXP1-B, EXP2} block, confirmed live via 4 isolated
  // single-assignment tests on a cleared patch (BACKLOG_GP150.md's GP150-10
  // entry). EXP1 is the pedal's own built-in rocker/toggle footswitch
  // (A/B = its two discrete switched positions, each an independent set
  // of assignments); EXP2 is the external expression-pedal jack. Each
  // block holds up to 3 simultaneous parameter assignments, filled
  // front-to-back.
  const EXP_CTRL_BLOCKS = [
    { key: "EXP1-A", start: 0 },
    { key: "EXP1-B", start: 3 },
    { key: "EXP2", start: 6 },
  ];

  const FS_SETTING_OFF = 0x440; // PatchData footswitch: magic 0x3080, 36 bytes
  const FS_SETTING_ENTRY_OFF = 0x444; // 9 x u32 bitmask (MODULE_NAMES bit order)
  const FS_SETTING_COUNT = 9;
  // Confirmed live 2026-09-23: this GP-150 only has 2 physical CTRL
  // switches, shown on-device as "CTRL A"/"CTRL B", living at indices 1
  // and 2 of the 9 (indices 0 and 3-8 aren't exposed on this hardware --
  // the struct's own 9-slot size likely comes from a shared-firmware
  // device family with more physical switches). Each switch activates at
  // most 3 modules, also confirmed live.
  const FS_CTRL_A_INDEX = 1;
  const FS_CTRL_B_INDEX = 2;
  const FS_CTRL_MAX_ACTIVE = 3;

  // Flat catalog Quick Knob/EXP/CTRL targetId values index into: 0-11 are
  // simply the module's own position in MODULE_NAMES (confirmed live:
  // targetId 4 == MODULE_NAMES[4] == "AMP"); 12+ are non-module ("global")
  // targets. Only 12 is confirmed live so far (Patch Volume); 13 is a
  // strong guess (Tempo, given it's Quick Knob 2's untouched factory
  // default and the manual lists Volume+Tempo as the obvious pair) but
  // UNCONFIRMED -- don't treat it as solved.
  const GLOBAL_TARGETS = {
    12: "Patch Volume",
    13: "Tempo (unconfirmed)",
  };
  function targetLabel(targetId) {
    if (targetId < 0) return null; // unassigned
    if (targetId < MODULE_NAMES.length) return MODULE_NAMES[targetId];
    return GLOBAL_TARGETS[targetId] || `Unknown target ${targetId}`;
  }

  const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  function isGp150(prst) {
    prst = u8(prst);
    if (prst.length !== PRST_LEN) return false;
    for (let i = 0; i < HEADER_GP150.length; i++) if (prst[i] !== HEADER_GP150[i]) return false;
    return true;
  }

  function checkLength(prst) {
    prst = u8(prst);
    if (prst.length !== PRST_LEN) throw new Error(`expected a ${PRST_LEN}-byte GP-150 .prst, got ${prst.length}`);
  }

  function readPatchIndex(prst) { return u8(prst)[PATCH_INDEX_OFF]; }

  function readName(prst) {
    prst = u8(prst);
    let s = "";
    for (let i = NAME_OFF; i < NAME_OFF + NAME_MAX; i++) {
      if (prst[i] === 0) break;
      s += String.fromCharCode(prst[i]);
    }
    return s.trim();
  }

  function readOrder(prst) {
    prst = u8(prst);
    return Array.from(prst.subarray(ORDER_OFF, ORDER_OFF + ORDER_LEN), (i) => MODULE_NAMES[i]);
  }

  function isValidOrder(prst) {
    prst = u8(prst);
    const idxs = Array.from(prst.subarray(ORDER_OFF, ORDER_OFF + ORDER_LEN)).sort((a, z) => a - z);
    const want = Array.from({ length: MODULE_NAMES.length }, (_, i) => i);
    return idxs.length === want.length && idxs.every((v, i) => v === want[i]);
  }

  function readModuleParam(prst, module) {
    return dv(u8(prst)).getFloat32(MODULE_PARAM_OFFSET[module], true);
  }
  function readAllModuleParams(prst) {
    const out = {};
    for (const m of Object.keys(MODULE_PARAM_OFFSET)) out[m] = readModuleParam(prst, m);
    return out;
  }

  function readModuleModel(prst, module) {
    return dv(u8(prst)).getUint32(MODULE_MODEL_OFFSET[module], true);
  }
  function readAllModuleModels(prst) {
    const out = {};
    for (const m of Object.keys(MODULE_MODEL_OFFSET)) out[m] = readModuleModel(prst, m);
    return out;
  }

  function readModuleEnabled(prst, module) {
    return !!u8(prst)[MODULE_ENABLE_OFFSET[module]];
  }
  function readAllModuleEnabled(prst) {
    const out = {};
    for (const m of Object.keys(MODULE_ENABLE_OFFSET)) out[m] = readModuleEnabled(prst, m);
    return out;
  }

  function moduleParamOffset(module, algId) {
    return MODULE_MODEL_OFFSET[module] + 4 + algId * 4;
  }
  function readModuleParamByAlgId(prst, module, algId) {
    return dv(u8(prst)).getFloat32(moduleParamOffset(module, algId), true);
  }

  function readModelParams(prst, module, modelParams) {
    const out = {};
    for (const p of modelParams || []) {
      if ((p.algId ?? -1) < 0) continue;
      out[p.name] = readModuleParamByAlgId(prst, module, p.algId);
    }
    return out;
  }

  // --- GP150-10: patch-level settings (read) ----------------------------

  function readPresetBpm(prst) { return dv(u8(prst)).getInt16(PRESET_BPM_OFF, true); }
  function readPatchVolume(prst) { return dv(u8(prst)).getInt16(PATCH_VOL_OFF, true); }
  function readPresetNam(prst) { return dv(u8(prst)).getUint16(PRESET_NAM_OFF, true) !== 0; }

  function readQuickKnobs(prst) {
    const d = dv(u8(prst));
    const out = [];
    for (let i = 0; i < QUICK_KNOB_COUNT; i++) {
      const off = QUICK_KNOB_ENTRY_OFF + i * QUICK_KNOB_ENTRY_LEN;
      const targetId = d.getInt16(off, true);
      out.push({ targetId, algId: d.getInt16(off + 2, true), targetLabel: targetLabel(targetId) });
    }
    return out;
  }

  function readExpCtrl(prst) {
    const d = dv(u8(prst));
    const out = [];
    for (let i = 0; i < EXP_CTRL_COUNT; i++) {
      const off = EXP_CTRL_ENTRY_OFF + i * EXP_CTRL_ENTRY_LEN;
      const targetId = d.getInt16(off, true);
      out.push({
        targetId,
        algId: d.getInt16(off + 2, true),
        rangeMin: d.getFloat32(off + 4, true),
        rangeMax: d.getFloat32(off + 8, true),
        targetLabel: targetLabel(targetId),
      });
    }
    return out;
  }

  // Group the flat 9-entry EXP_CTRL array into its 3 real blocks (see
  // EXP_CTRL_BLOCKS above) -- what the UI should actually render, since a
  // block's own 3 slots are independent of the OTHER blocks' slot counts.
  function readExpCtrlBlocks(prst) {
    const entries = readExpCtrl(prst);
    return EXP_CTRL_BLOCKS.map(({ key, start }) => ({
      key,
      entries: entries.slice(start, start + 3).map((e, i) => ({ ...e, index: start + i })),
    }));
  }

  function readFsSettings(prst) {
    const d = dv(u8(prst));
    const out = [];
    for (let i = 0; i < FS_SETTING_COUNT; i++) {
      const bits = d.getUint32(FS_SETTING_ENTRY_OFF + i * 4, true);
      const modules = MODULE_NAMES.filter((_, bit) => (bits & (1 << bit)) !== 0);
      out.push({ index: i, bits, modules });
    }
    return out;
  }

  function decode(prst) {
    checkLength(prst);
    return {
      slotIndex: readPatchIndex(prst),
      name: readName(prst),
      chainOrder: readOrder(prst),
      moduleParams: readAllModuleParams(prst),
      moduleModels: readAllModuleModels(prst),
      moduleEnabled: readAllModuleEnabled(prst),
      presetBpm: readPresetBpm(prst),
      patchVolume: readPatchVolume(prst),
      presetNam: readPresetNam(prst),
      quickKnobs: readQuickKnobs(prst),
      expCtrlBlocks: readExpCtrlBlocks(prst),
      fsSettings: readFsSettings(prst),
    };
  }

  // --- writer: edit a real skeleton patch's known fields ----------------------

  function writeName(b, name) {
    for (let i = 0; i < NAME_MAX; i++) b[NAME_OFF + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0;
  }

  function writeOrder(b, order) {
    const want = [...MODULE_NAMES].sort();
    const got = [...order].sort();
    if (got.length !== want.length || !got.every((v, i) => v === want[i])) {
      throw new Error(`order must contain each of ${MODULE_NAMES} exactly once, got ${JSON.stringify(order)}`);
    }
    for (let i = 0; i < ORDER_LEN; i++) b[ORDER_OFF + i] = MODULE_NAMES.indexOf(order[i]);
  }

  function writeModuleModel(b, module, fxid) {
    dv(b).setUint32(MODULE_MODEL_OFFSET[module], fxid >>> 0, true);
  }

  function writeModuleParamByAlgId(b, module, algId, value) {
    dv(b).setFloat32(moduleParamOffset(module, algId), value, true);
  }

  function writeModuleEnabled(b, module, enabled) {
    b[MODULE_ENABLE_OFFSET[module]] = enabled ? 1 : 0;
    setModuleMask(b);
  }

  // The pedal keeps a bitmask of the enabled modules at 0x444 (u16 LE) and rewrites it itself when it stores a
  // patch (found 2026-10: a body written with the factory-empty mask came back with the right one, and the
  // checksum recomputed over it). One bit per module; reproduces 200/200 real files. The NS bit (0x8) is
  // inferred from the sequence: NS was never enabled in the corpus.
  const MODULE_MASK_OFF = 0x444;
  const MODULE_MASK_BIT = { PRE: 0x1, WAH: 0x2, DST: 0x4, NS: 0x8, AMP: 0x10, NR: 0x20, CAB: 0x40, EQ: 0x80, MOD: 0x100, DLY: 0x200, RVB: 0x400, VOL: 0x800 };
  const moduleMask = (b) => Object.entries(MODULE_MASK_BIT).reduce((m, [name, bit]) => m | (b[MODULE_ENABLE_OFFSET[name]] ? bit : 0), 0);
  function setModuleMask(b) {
    const m = moduleMask(b);
    b[MODULE_MASK_OFF] = m & 0xff; b[MODULE_MASK_OFF + 1] = m >> 8;
  }

  // --- GP150-10: patch-level settings (write) ----------------------------
  // Byte-patchers on a full 1128-byte body, same convention as the module
  // writers above -- always called on a body just read live (never a blank
  // skeleton), so every OTHER byte in the struct stays exactly what the
  // pedal already had. The live-write path (webmidi_gp150.js) slices the
  // relevant struct's own byte range back out of the patched body to build
  // the wire message; these functions never talk to MIDI themselves.

  function writePresetBpm(b, value) { dv(b).setInt16(PRESET_BPM_OFF, value, true); }
  function writePatchVolume(b, value) { dv(b).setInt16(PATCH_VOL_OFF, value, true); }
  function writePresetNam(b, enabled) { dv(b).setUint16(PRESET_NAM_OFF, enabled ? 1 : 0, true); }

  function writeQuickKnob(b, index, { targetId, algId }) {
    const off = QUICK_KNOB_ENTRY_OFF + index * QUICK_KNOB_ENTRY_LEN;
    dv(b).setInt16(off, targetId, true);
    dv(b).setInt16(off + 2, algId, true);
  }

  function writeExpCtrl(b, index, { targetId, algId, rangeMin, rangeMax }) {
    const off = EXP_CTRL_ENTRY_OFF + index * EXP_CTRL_ENTRY_LEN;
    dv(b).setInt16(off, targetId, true);
    dv(b).setInt16(off + 2, algId, true);
    dv(b).setFloat32(off + 4, rangeMin, true);
    dv(b).setFloat32(off + 8, rangeMax, true);
  }

  // `modules` is an array of MODULE_NAMES entries to set the bit for (e.g.
  // ["PRE","NR"]) -- confirmed live encoding (BACKLOG_GP150.md's GP150-10):
  // bit position = the module's own MODULE_NAMES index.
  function writeFsSetting(b, index, modules) {
    let bits = 0;
    for (const m of modules || []) {
      const bit = MODULE_NAMES.indexOf(m);
      if (bit >= 0) bits |= 1 << bit;
    }
    dv(b).setUint32(FS_SETTING_ENTRY_OFF + index * 4, bits >>> 0, true);
  }

  // The file's own 0x0E-0x0F checksum: CRC-16, polynomial 0x8005 (reflected), init 0xE011, over bytes
  // 0x10..0x463, stored big-endian (reproduces 200/200 real files and 200 bodies read from the pedal).
  const CHECKSUM_OFF = 0x0e, CHECKSUM_START = 0x10, CHECKSUM_END = 1124, CHECKSUM_INIT = 0xe011;
  function computeChecksum(prst) {
    const b = u8(prst);
    let crc = CHECKSUM_INIT;
    for (let i = CHECKSUM_START; i < CHECKSUM_END; i++) {
      crc ^= b[i];
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc;
  }
  const readChecksum = (prst) => (u8(prst)[CHECKSUM_OFF] << 8) | u8(prst)[CHECKSUM_OFF + 1];
  const checksumOk = (prst) => readChecksum(prst) === computeChecksum(prst);
  function fixChecksum(b) {   // in place
    const crc = computeChecksum(b);
    b[CHECKSUM_OFF] = crc >> 8; b[CHECKSUM_OFF + 1] = crc & 0xff;
    return b;
  }

  // Edit a real, valid GP-150 .prst (`skeleton`) and return the result. Any
  // field left undefined/omitted keeps the skeleton's own value untouched —
  // the slot index and every still-undecoded byte always do; the checksum is recomputed.
  function buildFromSkeleton(skeleton, { name, chainOrder, moduleModels, moduleParams, moduleEnabled } = {}) {
    checkLength(skeleton);
    const out = new Uint8Array(u8(skeleton));
    if (name != null) writeName(out, name);
    if (chainOrder != null) writeOrder(out, chainOrder);
    for (const [module, fxid] of Object.entries(moduleModels || {})) writeModuleModel(out, module, fxid);
    for (const [module, params] of Object.entries(moduleParams || {})) {
      for (const [algId, value] of Object.entries(params)) writeModuleParamByAlgId(out, module, Number(algId), value);
    }
    for (const [module, enabled] of Object.entries(moduleEnabled || {})) writeModuleEnabled(out, module, enabled);
    return fixChecksum(out);
  }

  const API = {
    PRST_LEN, PATCH_INDEX_OFF, NAME_OFF, NAME_MAX, ORDER_OFF, ORDER_LEN,
    MODULE_NAMES, MODULE_PARAM_OFFSET, MODULE_MODEL_OFFSET, MODULE_ENABLE_OFFSET, FXID_NONE,
    isGp150, checkLength, readPatchIndex, readName, readOrder, isValidOrder,
    readModuleParam, readAllModuleParams, readModuleModel, readAllModuleModels,
    readModuleEnabled, readAllModuleEnabled, moduleParamOffset, readModuleParamByAlgId,
    readModelParams, decode,
    writeName, writeOrder, writeModuleModel, writeModuleParamByAlgId, writeModuleEnabled,
    buildFromSkeleton, moduleMask, setModuleMask, computeChecksum, readChecksum, checksumOk, fixChecksum,
    // GP150-10
    PRESET_INFO_OFF, PRESET_BPM_OFF, PATCH_VOL_OFF, CURRENT_MODE_OFF, PRESET_NAM_OFF,
    QUICK_KNOB_OFF, QUICK_KNOB_ENTRY_OFF, QUICK_KNOB_COUNT, QUICK_KNOB_ENTRY_LEN,
    EXP_CTRL_OFF, EXP_CTRL_ENTRY_OFF, EXP_CTRL_COUNT, EXP_CTRL_ENTRY_LEN, EXP_CTRL_BLOCKS,
    FS_SETTING_OFF, FS_SETTING_ENTRY_OFF, FS_SETTING_COUNT, GLOBAL_TARGETS, targetLabel,
    FS_CTRL_A_INDEX, FS_CTRL_B_INDEX, FS_CTRL_MAX_ACTIVE,
    readPresetBpm, readPatchVolume, readPresetNam, readQuickKnobs, readExpCtrl,
    readExpCtrlBlocks, readFsSettings,
    writePresetBpm, writePatchVolume, writePresetNam, writeQuickKnob, writeExpCtrl, writeFsSetting,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.GP150Format = API;
})(typeof self !== "undefined" ? self : this);
