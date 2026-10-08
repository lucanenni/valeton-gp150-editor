#!/usr/bin/env python3
"""Builds patch/gp50_to_gp150_model_map.json — GP-50 fxid -> GP-150 fxid,
the model crosswalk GP150-7's GP-50->GP-150 converter needs.

Matching strategy (worked out interactively 2026-09-17, see BACKLOG_GP150.md GP150-7 and design/GP150_SUPPORT.md for the background):

1. Primary key: a model's `name` field (the short display name shown in
   Suite/on the manual's effect list, e.g. "TWD CP 1x8", "UK 30 4x12") --
   NOT `fxtitle`, which for some modules (CAB in particular) is an
   internal/technical code instead of the display name. Matched
   cross-module (a model can be reclassified into a different module on
   GP-150 -- e.g. "Beefy Boost" is PRE on GP-50, DST on GP-150).
2. Fallback: `fxtitle` (nicer for other modules, e.g. NR's "AI Gate").
3. Explicit overrides below for real matches the name-only pass can't
   find automatically -- either because GP-150 uses a decorated/variant
   name (`OVERRIDES_BY_NAME`), or because there's no name match at all
   and the closest real equivalent was found by cross-referencing the
   official manuals' effect descriptions (real modeled gear) and, for
   MOD/MOD-like effects, by comparing each model's own param list
   (normalizing each device's own abbreviations -- "P.Delay"/"Pre Delay",
   "F.Back"/"Feedback", "VOL"/"Volume" -- before comparing).
4. Left unmapped (target fxid null) when no reasonable equivalent
   exists on GP-150 at all (currently just "Dark CS 2x12", a custom-
   modified cab with no real-world analog in GP-150's cab library).

N->S (SnapTone) entries are deliberately excluded -- they're user-
captured audio, not portable catalog models; a GP-50->GP-150 conversion
leaves that module empty regardless of what the source patch had
loaded there. Both rings' generic "User IR N" placeholders are likewise
excluded (each device's own IR slots are independent, and portable IR
*content* isn't representable in this crosswalk at all).
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# Ties broken by "first option" per the user's own instruction, and a few
# name-driven picks (AC Pre2/Dizz VH+/Flagman+) confirmed to exist verbatim
# on GP-150 once the "+"/"2" suffix was normalized away.
OVERRIDES_BY_NAME = {
    "AC Pre2": "AC Pre",
    "Dizz VH+": "Dizz VH",
    "Flagman+": "Flagman+ 1",
    "Sora Fuzz": "Red Haze",
    "N-Jet": "Jet",
    "Air": "N-Star",
    "A-Chorus": "G-Chorus",
    "Bass EQ 2": "Bass EQ 1",
    "EV 4x12": "Eagle 4x12",
    "L-Star 1x12": "L-Star 2x12",
    "TWD CP 1x8": "LUX 1x12",
    "UK GRN 2x12": "UK 2x12",
    "UK GRN 4x12": "UK Vintage 4x12",
    # Found earlier via real-gear (origin) cross-reference against the
    # manuals, not a name match: GP-50's "Dark"/"SUP" naming convention vs
    # GP-150's plainer one, same real modeled cab in each case.
    "Dark Twin 2x12": "Twin 2x12",  # both: Fender '65 Twin Reverb 2x12
    "Dark VIT 1x12": "LUX 1x12",  # both: Fender Vibrolux 1x12
    "SUP Star 2x12": "L-Star 2x12",  # both: Mesa/Boogie Lone Star 2x12
    # Analyzed by exact param-name match (after normalizing each device's
    # own abbreviations) alongside the batch above, but dropped from the
    # summary table shown to the user by mistake -- same "first listed
    # option" tie-break rule applied here too.
    "Analog": "Pure",  # DLY, tied with Tape/Ping Pong/Tube/Sweet Echo/999 Echo
    "M-Vibe": "V-Roto",  # MOD, tied with O-Trem
    "Plate L": "N-Star",  # RVB, tied with Deepsea
    # No exact real-gear match on GP-150 for a "custom modified Fender"
    # 2x12 -- closest same-brand 2x12 available (also used for "Dark Twin
    # 2x12" above; there's no second distinct Fender 2x12 on GP-150).
    "Dark CS 2x12": "Twin 2x12",
}

# No real equivalent at all -- leave the target module slot at whatever
# the GP-150 skeleton patch already has (or "no model"), and flag it in
# the conversion report. (Empty on purpose: every real GP-50 model now has
# at least a best-effort GP-150 equivalent via OVERRIDES_BY_NAME above.)
NO_EQUIVALENT: set[str] = set()


def is_real(name: str | None) -> bool:
    if not name:
        return False
    return (
        "SnapTone" not in name
        and "Snap Tone" not in name
        and not name.startswith("User IR")
        and name != "User IR"
    )


def build() -> dict:
    gp50 = json.load(open(os.path.join(HERE, "fxid_ring.json")))
    gp150 = json.load(open(os.path.join(HERE, "fxid_ring_gp150.json")))

    # key -> gp150 fxid, built from BOTH name and fxtitle so either can hit
    gp150_by_key: dict[str, int] = {}
    for fxid_s, v in gp150.items():
        for key in (v.get("name"), v.get("fxtitle")):
            if is_real(key) and key not in gp150_by_key:
                gp150_by_key[key] = int(fxid_s)

    mapping = {}
    unmapped = []
    for fxid_s, v in gp50.items():
        name = v.get("name")
        fxtitle = v.get("fxtitle")
        if v.get("module") == "N->S" or not is_real(name) or not is_real(fxtitle):
            continue  # SnapTone / User IR -- not portable, skip entirely
        if name in NO_EQUIVALENT:
            mapping[fxid_s] = None
            unmapped.append((v.get("module"), name))
            continue
        target_name = OVERRIDES_BY_NAME.get(name, name)
        target_fxid = gp150_by_key.get(target_name)
        if target_fxid is None and fxtitle:
            target_fxid = gp150_by_key.get(OVERRIDES_BY_NAME.get(fxtitle, fxtitle))
        if target_fxid is None:
            mapping[fxid_s] = None
            unmapped.append((v.get("module"), name))
        else:
            mapping[fxid_s] = target_fxid

    print(f"mapped: {sum(1 for v in mapping.values() if v is not None)}")
    print(f"unmapped: {len(unmapped)}: {unmapped}")
    return mapping


if __name__ == "__main__":
    mapping = build()
    out_path = os.path.join(HERE, "gp50_to_gp150_model_map.json")
    with open(out_path, "w") as f:
        json.dump(mapping, f, indent=1, sort_keys=True)
    print(f"wrote {out_path}")
