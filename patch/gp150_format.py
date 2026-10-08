"""GP-150 `.prst` format — decoder, plus a narrow skeleton-editing writer.

Spec: `re/DEVICE_GP150.md` (overview: `design/GP150_SUPPORT.md`).
The read side is fully mapped: chain order, every module's model + full
params + on/off state, and the name field. The file's own `0x0E-0x0F`
checksum is decoded too (2026-10-08, see `compute_checksum()`): CRC-16 with
polynomial 0x8005 (bit-reflected), init 0xE011, over bytes 0x10..0x463,
stored big-endian; it reproduces all 200 files of a real corpus and 200
bodies read back from the pedal. It is never verified on import, though:
confirmed 2026-09-17, with a real live test (corrupt a real file's
checksum, import into Valeton Suite, push to the real pedal — accepted at
both steps, patch came out correct). This is
NOT the live SysEx write protocol (GP150-6, still genuinely blocked by an
unrelated per-message `tag` byte this project has never cracked) — it
only unblocks producing a `.prst` FILE for the user to import through
Suite, never a direct device write. `build_from_skeleton()` below only
edits a REAL, valid GP-150 patch's known fields (name, chain order,
module models/params/enable) and leaves everything else — including the
~168-byte unmapped tail — untouched from the skeleton (the checksum is
recomputed), exactly like `patch/convert.py` reshapes GP-5/GP-50 by
editing a real target skeleton rather than building one from scratch.

Model IDs (which catalog entry occupies each module slot) ARE decoded —
`MODULE_MODEL_OFFSET`, a u32 LE fxid 4 bytes before most modules' param
offset (CAB is -8, EQ is -24 — those two modules have extra fixed fields in
between, unmapped). And so is the FULL param set of whatever model is
active: `module_param_offset(module, algId) = MODULE_MODEL_OFFSET[module] +
4 + algId*4`, confirmed against every param (2608 instances) of every real
model active anywhere in the 200-file corpus — see `read_model_params()`.
Also decoded: each module's on/off state — `MODULE_ENABLE_OFFSET[module] =
MODULE_MODEL_OFFSET[module] - 4`, a single byte (0/1), independent of which
model is assigned (confirmed live: toggling DST off left its model/params
byte-for-byte unchanged and only this byte flipped 1->0) — see
`read_module_enabled()`. Cross-referencing fxids/algIds to names/ranges
needs the fxid ring
(`patch/fxid_ring_gp150.json`, extracted at runtime from the user's own
Valeton Suite install — `patch/build_ring.py gp150` — never committed as the
raw asset, same rule as GP-5/GP-50's rings) — this module stays stdlib-only
and just returns raw fxid ints / floats by algId; ring lookup is the
caller's job (same separation as GP-5/GP-50's model catalog resolution in
app/patchlib.py). fxids aren't module-locked in practice — some models
tagged e.g. "DST" in the catalog are legitimately storable in the "PRE"
slot too (confirmed: 20/200 real corpus patches do this) — so validate
membership against the *whole* ring, not just one module's subset.

stdlib-only, same reason as `patch/prst_format.py`: shared between the web
app and any future MIDI scripts.
"""

from __future__ import annotations

import struct
from typing import NamedTuple, Optional

PRST_LEN = 1128

PATCH_INDEX_OFF = 0x04
CHECKSUM_OFF = 0x0E        # u16 big-endian
CHECKSUM_START = 0x10      # the CRC covers [CHECKSUM_START, CHECKSUM_END): not the slot index, not itself
CHECKSUM_END = 1124        # the last 4 bytes are zero padding in every observed body
CHECKSUM_INIT = 0xE011
NAME_OFF = 0x2C
NAME_MAX = 13  # confirmed 2026-07-31: a 16-char input truncates to exactly
# 13 on the device (re/DEVICE_GP150.md) — this is the real field limit, not
# just the longest name anyone happened to type
ORDER_OFF = 0x78
ORDER_LEN = 12

# Module index order for the `0x78` chain-order array. FIXED 2026-09-20 —
# this was previously the manual's MIDI Control Information List order
# (CC48-59, NR first), which decoded every corpus file "successfully" (a
# valid permutation) but was NEVER independently verified against a real,
# non-default chain order until today. A live reorder (NR moved before AMP,
# confirmed correct on the pedal's own display, verified again after a full
# power-cycle, and independently cross-checked against Valeton Suite's own
# re-export of the same slot) proved the CC-list mapping wrong: decoding the
# resulting bytes with it produced "AMP, NS, NR, ..." while the device
# consistently showed "NR, AMP, ...". Solving for the mapping that explains
# BOTH that live result AND the untouched factory default (`001-New GEN.prst`,
# bytes `[5,0,1,2,3,4,6,...]`) uniquely gives this order — which is exactly
# `fxid_ring_gp150.json`'s own `moduleId` field (already used as `MODULE_TAGS`'
# `ff` in patch/gp150_set_param.py, and previously noted as `CATALOG_STORAGE_
# ORDER` below with a comment flagging this exact possibility on 2026-09-07:
# "worth keeping in mind if NR's position in the body ever seems inconsistent
# elsewhere"). See design/GP150_SUPPORT.md §3.1 for the
# derivation. `build_reorder_message()` (gp150_set_param.py), which already
# used this `moduleId`/`ff` numbering, was correct all along — this was a
# pure read-side decode bug.
MODULE_NAMES = ["PRE", "WAH", "DST", "NS", "AMP", "NR", "CAB", "EQ", "MOD", "DLY", "RVB", "VOL"]

# One confirmed float32 (LE) offset per module — each module's first-listed
# param, found by editing exactly that param on the device and diffing
# against the corpus original. See re/DEVICE_GP150.md for the per-module
# table (including which param each offset is) and the footprint caveats.
MODULE_PARAM_OFFSET = {
    "PRE": 0x08C,
    "WAH": 0x0D0,
    "DST": 0x114,
    "NS": 0x158,
    "AMP": 0x19C,
    "NR": 0x1E0,
    "CAB": 0x228,
    "EQ": 0x27C,
    "MOD": 0x2AC,
    "DLY": 0x2F0,
    "RVB": 0x334,
    "VOL": 0x378,
}

# u32 LE fxid, the model occupying each module's slot. Confirmed 0/200
# mismatches against the full fxid_ring_gp150.json across the real export
# corpus (re/DEVICE_GP150.md). Not simply MODULE_PARAM_OFFSET - 4 for CAB/EQ
# — those two modules have unmapped fixed fields between the model id and
# their first param.
MODULE_MODEL_OFFSET = {
    "PRE": 0x088,
    "WAH": 0x0CC,
    "DST": 0x110,
    "NS": 0x154,
    "AMP": 0x198,
    "NR": 0x1DC,
    "CAB": 0x220,
    "EQ": 0x264,
    "MOD": 0x2A8,
    "DLY": 0x2EC,
    "RVB": 0x330,
    "VOL": 0x374,
}

# The catalog's own moduleId order (module150_data.json) — this is the file's
# actual storage order for both MODULE_PARAM_OFFSET and MODULE_MODEL_OFFSET,
# confirmed 2026-07-31. Now known to be identical to MODULE_NAMES above (both
# were "the manual's CC-list order vs the catalog's moduleId order" until
# 2026-09-20's fix — see MODULE_NAMES' comment). Kept as a separate constant
# for documentation/cross-checking purposes, since it's independently sourced
# (module150_data.json's own moduleId field, not the 0x78 array).
CATALOG_STORAGE_ORDER = [
    "PRE", "WAH", "DST", "NS", "AMP", "NR", "CAB", "EQ", "MOD", "DLY", "RVB", "VOL",
]

# The catalog's shared "no model selected" placeholder, present in every
# module's entry list (name=None, fxtitle="Volume").
FXID_NONE = 100663299

# Per-module on/off byte (0 or 1), independent of which model is assigned —
# confirmed 2026-07-31 by toggling DST off with its model (Green OD) and
# params (Gain=10.0) left untouched: only this byte flipped, 1 -> 0. Same
# offset rule for all 12 modules, including CAB/EQ despite their irregular
# model-to-param spacing. Cross-checked against the full 200-file corpus:
# always 0 or 1, and (enabled=1, no-model) never co-occurs — you can't be
# "on" with nothing assigned, which is the sanity check that says this
# reading is right and not a coincidental correlate of something else.
MODULE_ENABLE_OFFSET = {m: off - 4 for m, off in MODULE_MODEL_OFFSET.items()}


class GP150Patch(NamedTuple):
    slot_index: int  # 0-based, from prst[0x04] — matches export filename order
    name: str
    chain_order: list  # chain_order[chain_position] = module name, e.g. chain_order[0] == "AMP" usually
    module_params: dict  # module name -> the one confirmed float for that module
    module_models: dict  # module name -> the raw fxid (int) occupying that slot
    module_enabled: dict  # module name -> bool, on/off independent of the model


def check_length(prst: bytes) -> None:
    if len(prst) != PRST_LEN:
        raise ValueError(f"expected a {PRST_LEN}-byte GP-150 .prst, got {len(prst)}")


def read_patch_index(prst: bytes) -> int:
    return prst[PATCH_INDEX_OFF]


def read_name(prst: bytes) -> str:
    raw = prst[NAME_OFF : NAME_OFF + NAME_MAX]
    return raw.split(b"\0")[0].decode("latin1", "replace").strip()


def read_order(prst: bytes) -> list:
    """chain_order[chain_position] = module name. Storage order of the
    per-module param floats is independent of this — see MODULE_PARAM_OFFSET."""
    idxs = prst[ORDER_OFF : ORDER_OFF + ORDER_LEN]
    return [MODULE_NAMES[i] for i in idxs]


def is_valid_order(prst: bytes) -> bool:
    idxs = list(prst[ORDER_OFF : ORDER_OFF + ORDER_LEN])
    return sorted(idxs) == list(range(len(MODULE_NAMES)))


def read_module_param(prst: bytes, module: str) -> float:
    off = MODULE_PARAM_OFFSET[module]
    return struct.unpack_from("<f", prst, off)[0]


def read_all_module_params(prst: bytes) -> dict:
    return {m: read_module_param(prst, m) for m in MODULE_PARAM_OFFSET}


def read_module_model(prst: bytes, module: str) -> int:
    """The raw fxid (int) of the model occupying `module`'s slot. FXID_NONE
    means no model selected. Look up the name via a loaded fxid_ring_gp150.json
    (this module stays stdlib-only, no ring loading here)."""
    off = MODULE_MODEL_OFFSET[module]
    return struct.unpack_from("<I", prst, off)[0]


def read_all_module_models(prst: bytes) -> dict:
    return {m: read_module_model(prst, m) for m in MODULE_MODEL_OFFSET}


def read_module_enabled(prst: bytes, module: str) -> bool:
    return bool(prst[MODULE_ENABLE_OFFSET[module]])


def read_all_module_enabled(prst: bytes) -> dict:
    return {m: read_module_enabled(prst, m) for m in MODULE_ENABLE_OFFSET}


def module_param_offset(module: str, alg_id: int) -> int:
    """Offset of a param's float32, given its algId (from a model's `params`
    list in fxid_ring_gp150.json). offset = model_offset + 4 + algId*4 —
    confirmed 2026-07-31 with zero mismatches across every param (2608
    instances) of every model actually active anywhere in the 200-file
    corpus, cross-referenced against the ring's min/max per param. This
    generalizes MODULE_PARAM_OFFSET (algId 0 of whatever model was tested
    when each entry there was found) to any param of any model."""
    return MODULE_MODEL_OFFSET[module] + 4 + alg_id * 4


def read_module_param_by_alg_id(prst: bytes, module: str, alg_id: int) -> float:
    return struct.unpack_from("<f", prst, module_param_offset(module, alg_id))[0]


def read_model_params(prst: bytes, module: str, model_params: list) -> dict:
    """All params for the model currently in `module`'s slot, given that
    model's `params` list from the ring (each a dict with at least `name`
    and `algId` — the shape build_ring.py's params_of() produces). Returns
    {param_name: float_value}. Caller resolves the model (read_module_model
    + a loaded ring) and passes its params list — this function itself
    doesn't touch the ring, staying stdlib-only like the rest of this module."""
    return {
        p["name"]: read_module_param_by_alg_id(prst, module, p["algId"])
        for p in model_params
        if p.get("algId", -1) >= 0
    }


def decode(prst: bytes) -> GP150Patch:
    check_length(prst)
    return GP150Patch(
        slot_index=read_patch_index(prst),
        name=read_name(prst),
        chain_order=read_order(prst),
        module_params=read_all_module_params(prst),
        module_models=read_all_module_models(prst),
        module_enabled=read_all_module_enabled(prst),
    )


# --- writer: edit a real skeleton patch's known fields ------------------
# See this module's docstring for why this is safe to have despite the
# checksum and ~168-byte tail region still not being decoded: every write
# below targets a field the read side above already fully understands, and
# everything else is left exactly as the skeleton (a real, valid GP-150
# .prst) already had it.


def write_name(b: bytearray, name: str) -> None:
    raw = name.encode("latin1", "replace")[:NAME_MAX].ljust(NAME_MAX, b"\0")
    b[NAME_OFF : NAME_OFF + NAME_MAX] = raw


def write_order(b: bytearray, order: list) -> None:
    if sorted(order) != sorted(MODULE_NAMES):
        raise ValueError(f"order must contain each of {MODULE_NAMES} exactly once, got {order!r}")
    idxs = bytes(MODULE_NAMES.index(m) for m in order)
    b[ORDER_OFF : ORDER_OFF + ORDER_LEN] = idxs


def write_module_model(b: bytearray, module: str, fxid: int) -> None:
    struct.pack_into("<I", b, MODULE_MODEL_OFFSET[module], fxid)


def write_module_param_by_alg_id(b: bytearray, module: str, alg_id: int, value: float) -> None:
    struct.pack_into("<f", b, module_param_offset(module, alg_id), value)


def write_module_enabled(b: bytearray, module: str, enabled: bool) -> None:
    b[MODULE_ENABLE_OFFSET[module]] = 1 if enabled else 0
    set_module_mask(b)


# The pedal keeps a bitmask of the enabled modules at 0x444 (u16 LE) and rewrites it itself when it stores a patch
# (found 2026-10: a body written with the factory-empty mask came back with the right one, and the checksum
# recomputed over it). One bit per module in this order; reproduces 200/200 real files. The NS bit (0x8) is
# inferred from the sequence: NS was never enabled in the corpus.
MODULE_MASK_OFF = 0x444
MODULE_MASK_BIT = {"PRE": 0x1, "WAH": 0x2, "DST": 0x4, "NS": 0x8, "AMP": 0x10, "NR": 0x20,
                   "CAB": 0x40, "EQ": 0x80, "MOD": 0x100, "DLY": 0x200, "RVB": 0x400, "VOL": 0x800}


def module_mask(prst: bytes) -> int:
    return sum(bit for m, bit in MODULE_MASK_BIT.items() if prst[MODULE_ENABLE_OFFSET[m]])


def set_module_mask(b: bytearray) -> None:
    mask = module_mask(b)
    b[MODULE_MASK_OFF] = mask & 0xFF
    b[MODULE_MASK_OFF + 1] = mask >> 8


def compute_checksum(prst: bytes) -> int:
    """CRC-16 (poly 0x8005 reflected, init 0xE011, no final xor) of bytes 0x10..0x463, which is what the
    pedal stores big-endian at 0x0E-0x0F. Independent of the slot index (byte 4)."""
    crc = CHECKSUM_INIT
    for b in bytes(prst[CHECKSUM_START:CHECKSUM_END]):
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def read_checksum(prst: bytes) -> int:
    return (prst[CHECKSUM_OFF] << 8) | prst[CHECKSUM_OFF + 1]


def checksum_ok(prst: bytes) -> bool:
    return read_checksum(prst) == compute_checksum(prst)


def fix_checksum(buf: bytearray) -> None:
    """Store the checksum in place (call after editing a body)."""
    crc = compute_checksum(buf)
    buf[CHECKSUM_OFF] = crc >> 8
    buf[CHECKSUM_OFF + 1] = crc & 0xFF


def build_from_skeleton(
    skeleton: bytes,
    *,
    name: Optional[str] = None,
    chain_order: Optional[list] = None,
    module_models: Optional[dict] = None,
    module_params: Optional[dict] = None,
    module_enabled: Optional[dict] = None,
) -> bytes:
    """Edit a real, valid GP-150 `.prst` (the `skeleton`) in place and
    return the result. Any field left as None/omitted keeps the
    skeleton's own value untouched — the checksum, slot index, and every
    still-undecoded byte always do, since nothing here ever touches them.

    `module_models`: {module: fxid}. `module_params`: {module: {algId:
    value}} — pass every param you want written for that module's
    CURRENTLY-assigned model (write module_models first if you're also
    changing the model, so param offsets are computed against the right
    module -- offsets don't depend on which model occupies the slot, but
    getting the model right first avoids writing params for a model
    that's about to be replaced)."""
    check_length(skeleton)
    out = bytearray(skeleton)
    if name is not None:
        write_name(out, name)
    if chain_order is not None:
        write_order(out, chain_order)
    for module, fxid in (module_models or {}).items():
        write_module_model(out, module, fxid)
    for module, params in (module_params or {}).items():
        for alg_id, value in params.items():
            write_module_param_by_alg_id(out, module, int(alg_id), value)
    for module, enabled in (module_enabled or {}).items():
        write_module_enabled(out, module, enabled)
    fix_checksum(out)
    return bytes(out)
