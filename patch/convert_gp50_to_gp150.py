"""GP-50 -> GP-150 preset converter (GP150-7's "converter matrix", one
direction).

Unlike patch/convert.py (GP-5<->GP-50), this IS a real effect-catalog
transcode: the two devices have different, only partially-overlapping
model libraries and a different fixed block architecture (GP-50 has 10
fixed-role slots; GP-150 has those same 10 roles plus WAH and VOL, which
GP-50 simply doesn't have as blocks at all). See BACKLOG_GP150.md's GP150-7
entry and design/GP150_SUPPORT.md for the background of
every decision this module encodes: the model crosswalk
(patch/gp50_to_gp150_model_map.json, built by
patch/build_gp50_to_gp150_model_map.py), the fixed slot->module mapping
below, and where WAH/VOL land in the output chain.

Output goes through Suite, not straight to the pedal: build a `.prst`
here, the user imports it into Valeton Suite, Suite pushes it to the
device. This works despite GP150-2's file checksum still being
uncracked because Suite recomputes/repairs it on import (confirmed live,
2026-09-17, GP150-2 in BACKLOG_GP150.md) -- this project's live SysEx
write protocol (GP150-6) is a different, unrelated, still-genuinely-
blocked thing (a per-message `tag` byte), and this converter never uses
it.

stdlib-only except for loading the two JSON rings, matching the rest of
this codebase's device-format modules.
"""

from __future__ import annotations

import json
import os
import re
from typing import NamedTuple, Optional

from patch import gp150_format as g150
from patch import prst_format as fmt

HERE = os.path.dirname(os.path.abspath(__file__))

# GP-50's 10 fixed storage slots (patch/prst_format.py's model_records()
# order), each permanently tied to one role -- confirmed against real
# GP-5/GP-50 fixtures (see build_gp50_to_gp150_model_map.py's module
# docstring for how this was derived: slot position determines role, NOT
# the stored category byte, which repeats across slots e.g. NR and PRE
# both use category 0).
GP50_SLOT_MODULE = ["NR", "PRE", "DST", "AMP", "CAB", "EQ", "MOD", "DLY", "RVB", "NS"]

# Factory-empty GP-150 patch ("It's GP-150": every module unassigned, only VOL on,
# standard chain order) used as the output skeleton -- supplies every byte this
# converter doesn't explicitly write (header, the file's own checksum, the
# ~168-byte tail, WAH/VOL's own model+params before we disable them, ...).
DEFAULT_SKELETON_PATH = os.path.join(
    HERE, "..", "app", "static", "data", "gp150_skeleton.prst"
)

_ABBREV = {"vol": "volume", "predelay": "predelay", "fb": "feedback"}
_ALIASES = {
    "pdelay": "predelay", "predelay": "predelay", "fback": "feedback",
    "feedback": "feedback",
}


def _norm_param_name(name: str) -> str:
    n = re.sub(r"[^a-z0-9]", "", name.lower())
    return _ALIASES.get(n, n)


class UnmappedModel(NamedTuple):
    module: str  # GP-150 module the block ended up in
    gp50_name: str


class ConversionResult(NamedTuple):
    prst: bytes
    unmapped: list  # [UnmappedModel, ...] -- modules left at the skeleton's own model


def _load_json(name: str) -> dict:
    with open(os.path.join(HERE, name)) as f:
        return json.load(f)


def _param_alg_id_crosswalk(gp50_entry: dict, gp150_entry: dict) -> dict:
    """{gp50_algId: gp150_algId} for params present (by normalized name) on
    both models. A param only on one side is silently dropped -- the
    skeleton/default value for that param on the target stays whatever
    build_from_skeleton() didn't touch (i.e. whatever the target model's
    default already encodes if this is a fresh model, or the skeleton's
    prior value if the module's model isn't being replaced)."""
    gp150_by_name = {
        _norm_param_name(p["name"]): p["algId"]
        for p in (gp150_entry.get("params") or [])
        if p.get("algId", -1) >= 0
    }
    out = {}
    for p in gp50_entry.get("params") or []:
        if p.get("algId", -1) < 0:
            continue
        target_alg = gp150_by_name.get(_norm_param_name(p["name"]))
        if target_alg is not None:
            out[p["algId"]] = target_alg
    return out


def convert(
    gp50_prst: bytes,
    *,
    skeleton: Optional[bytes] = None,
) -> ConversionResult:
    """Convert a GP-50 `.prst` to a GP-150 one. `skeleton` defaults to a
    real committed GP-150 export (DEFAULT_SKELETON_PATH) -- pass a
    different real GP-150 `.prst` to use as the base if you want, e.g. to
    preserve that skeleton's own WAH/VOL sound instead of the default's.

    Returns the new .prst plus a list of modules where no equivalent
    GP-150 model was found for the source's model. As of the current
    gp50_to_gp150_model_map.json this is always just NS (SnapTone
    content is never portable, not a mapping gap) -- every other real
    GP-50 model has at least a best-effort GP-150 equivalent. Unmapped
    modules keep the skeleton's own model/params/enabled state for that
    slot; check `unmapped` and tell the user to fix those manually in
    Suite if that ever changes (e.g. a fxid_ring.json rebuild adds a new
    model)."""
    profile = fmt.detect(gp50_prst)
    if profile.key not in ("gp50", "gp5"):
        raise ValueError(f"source must be a GP-5/GP-50 .prst, got {profile.key!r}")

    if skeleton is None:
        with open(DEFAULT_SKELETON_PATH, "rb") as f:
            skeleton = f.read()
    g150.check_length(skeleton)

    gp50_ring = _load_json(profile.ring_file)
    gp150_ring = _load_json("fxid_ring_gp150.json")
    model_map = _load_json("gp50_to_gp150_model_map.json")

    name = fmt.read_name(gp50_prst)
    order_slots = fmt.read_order(gp50_prst)  # [slot_idx, ...] length 10
    records = fmt.model_records(gp50_prst)  # [(idx, cat, fxlow), ...] length 10
    bypass = fmt.bypass_mask(gp50_prst)
    params = fmt.param_floats(gp50_prst)  # 80 floats: block*8 + algId

    module_models: dict = {}
    module_params: dict = {}
    module_enabled: dict = {}
    unmapped: list = []

    for slot in range(len(records)):
        module = GP50_SLOT_MODULE[slot]
        idx, cat, fxlow = records[slot]
        gp50_fxid = (cat << 24) | fxlow
        gp150_fxid = model_map.get(str(gp50_fxid))
        module_enabled[module] = bool(bypass & (1 << slot))

        if gp150_fxid is None:
            gp50_entry = gp50_ring.get(str(gp50_fxid)) or {}
            unmapped.append(UnmappedModel(module, gp50_entry.get("name") or f"fxid {gp50_fxid:#x}"))
            module_enabled[module] = False  # never "on" with no model assigned
            continue  # leave this module's model/params as the skeleton's own

        module_models[module] = gp150_fxid
        gp50_entry = gp50_ring.get(str(gp50_fxid)) or {}
        gp150_entry = gp150_ring.get(str(gp150_fxid)) or {}
        crosswalk = _param_alg_id_crosswalk(gp50_entry, gp150_entry)
        # Start from the target model's catalog defaults so parameters with no
        # GP-50 counterpart (and a skeleton whose module holds no model yet)
        # end up at sensible values, then overlay the mapped ones.
        block_params = {
            int(p["algId"]): p["default"]
            for p in gp150_entry.get("params", [])
            if p.get("default") is not None
        }
        for gp50_alg, gp150_alg in crosswalk.items():
            block_params[gp150_alg] = params[slot * 8 + gp50_alg]
        module_params[module] = block_params

    # Chain order: translate GP-50's 10 slot-index positions into role
    # names, then insert WAH right before DST and VOL at the very end --
    # matching GP-150's own factory-default order (NR PRE WAH DST NS AMP
    # CAB EQ MOD DLY RVB VOL) at the two positions GP-50 has no opinion on.
    chain = [GP50_SLOT_MODULE[s] for s in order_slots]
    dst_pos = chain.index("DST")
    chain.insert(dst_pos, "WAH")
    chain.append("VOL")

    # WAH/VOL don't exist on GP-50 -- always off, keep the skeleton's own
    # model/params for them untouched (build_from_skeleton() just never
    # writes those two modules' model/params fields at all).
    module_enabled["WAH"] = False
    module_enabled["VOL"] = False

    out = g150.build_from_skeleton(
        skeleton,
        name=name,
        chain_order=chain,
        module_models=module_models,
        module_params=module_params,
        module_enabled=module_enabled,
    )
    return ConversionResult(prst=out, unmapped=unmapped)
