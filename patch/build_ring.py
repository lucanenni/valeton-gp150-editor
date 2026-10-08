#!/usr/bin/env python3
"""Regenerate the fxid -> model metadata rings from Valeton Suite's asset data.
Builds one ring per device: fxid_ring.json from module50_data.json (GP-50),
fxid_ring_gp5.json from module_data.json (GP-5), and fxid_ring_gp150.json from
module150_data.json (GP-150). The GP-5 catalog is a strict subset of the
GP-50's; GP-150's is a separate, larger catalog (12 module groups). `origin` =
the official gear reference (e.g. Green OD -> "Ibanez TS808"), used by the
explorer's "official names" toggle."""

import json
import os
import re

SUITE_DIR = (
    "/Applications/Valeton Suite.app/Contents/Frameworks/App.framework"
    "/Versions/A/Resources/flutter_assets/assets/data"
)
# (source asset filename, output ring filename) per device
RINGS = [
    ("module50_data.json", "fxid_ring.json"),  # GP-50
    ("module_data.json", "fxid_ring_gp5.json"),  # GP-5
    ("module150_data.json", "fxid_ring_gp150.json"),  # GP-150
]


def clean_origin(o: str) -> str:
    if not o:
        return ""
    o = o.split("\n")[0].strip()  # drop "XTOMP/Ampero Name: ..." 2nd line
    o = re.sub(r"^Original:\s*", "", o).strip()  # newer Suite data prefixes "Original:"
    o = re.sub(r"\s*\(MIJ\)\s*$", "", o).strip()  # drop trailing "(MIJ)" noise
    if o.lower() in ("original", "n/a", "none", "-", "/"):  # not a real gear reference
        return ""
    return o


def resolve_origin(entry: dict) -> str:
    """Official gear name. Some origins drop the channel (e.g. Foxy 30N and
    Foxy 30TB are both 'VOX AC30'); recover it from the description's
    '(... channel)' hint when the origin has no parenthetical of its own."""
    o = clean_origin(entry.get("origin"))
    if not o or "(" in o:
        return o
    desc = re.sub(r"<[^>]+>", "", entry.get("descriptionEn") or "")
    m = re.search(r"\(([^)]*?)\s*channel\)", desc, re.I)
    if m:
        chan = m.group(1).strip().title()  # "normal" -> "Normal", "Top Boost"
        return f"{o} ({chan})"
    return o


def unit_from_range(rng: str) -> str:
    """Extract a display unit from a valueRange like '0.10Hz-10.00Hz' -> 'Hz',
    '0-1000ms' -> 'ms'. Returns '' for plain numeric or Off/On ranges."""
    if not rng or "/" in rng:
        return ""
    m = re.search(r"[0-9.]([A-Za-z%]+)\s*$", rng)  # trailing unit on the last number
    return m.group(1) if m else ""


def enum_options(p: dict) -> list:
    """Option labels for a widgetType==2 (named-enum) param, index == the
    stored value (0-based) -- e.g. CAB "Precision" (min 0, max 1) ->
    ["Regular", "High"]. Source: the "show" entry's "showValue" field,
    which is already clean, comma-separated English (unlike "valueRange",
    which sometimes uses a full-width "、" separator) -- e.g.
    show[0].showValue == "Regular, High". Returns [] for anything that
    isn't a clean, fully-labeled enum (wrong option count vs the declared
    min-max range, or missing data) rather than guess at a partial list."""
    if p.get("widgetType") != 2:
        return []
    show = (p.get("show") or [{}])[0]
    opts = [o.strip() for o in (show.get("showValue") or "").split(",") if o.strip()]

    def _num(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    lo, hi = _num(p.get("min")), _num(p.get("max"))
    if lo is None or hi is None or len(opts) != int(hi) - int(lo) + 1:
        return []
    return opts


def params_of(entry: dict) -> list:
    """Param definitions in model order: name + algId (float-slot index) + toggle
    flag + unit. Value at runtime = float[block*8 + algId]. `widgetType` (from
    Suite's own module150_data.json/module50_data.json) distinguishes 4 control
    kinds: 0 = continuous slider, 1 = on/off toggle (already captured by
    `toggle`), 2 = a named-option enum (`options` gives the labels, index ==
    stored value), 3 = a bipolar slider centered on 0 (still just min/max/step,
    no extra field needed)."""
    out = []
    for p in entry.get("alg") or []:
        try:
            algid = int(p.get("algId", "-1"))
        except (TypeError, ValueError):
            algid = -1
        if algid < 0:
            continue

        def _num(x, default):
            try:
                return float(x)
            except (TypeError, ValueError):
                return default

        out.append(
            {
                "name": p.get("name"),
                "algId": algid,
                "toggle": p.get("widgetType") == 1 or (p.get("valueRange") == "Off/On"),
                "widgetType": p.get("widgetType"),
                "options": enum_options(p),
                "unit": unit_from_range(p.get("valueRange") or ""),
                # slider bounds are in display units == the stored float value
                "min": _num(p.get("min"), 0),
                "max": _num(p.get("max"), 100),
                "step": _num(p.get("step"), 1),
                "default": _num(p.get("defaultValue"), 0),  # applied on model change
            }
        )
    return out


def build_ring(src_name: str) -> dict:
    d = json.load(open(os.path.join(SUITE_DIR, src_name)))
    ring = {}
    for m in d["modules"]:
        for e in m["module"]:
            fx = e.get("fxid")
            if fx is None:
                continue
            ring[fx] = {
                "module": m["name"],
                "moduleId": m.get("moduleId"),
                "name": e.get("name"),
                "fxtitle": e.get("fxtitle"),
                "type": e.get("type"),
                "origin": resolve_origin(e),
                "params": params_of(e),
            }
    return ring


def main(only: str = "all"):
    """Rebuild the model rings. `only` = 'gp50' | 'gp5' | 'gp150' | 'all'. NOTE: a
    fresh build reflects the *currently installed* Valeton Suite data, which can
    drift from the committed ring files (origin coverage changes between Suite
    versions) — rebuild each deliberately, not as a side effect of another."""
    targets = {
        "gp50": RINGS[0:1],
        "gp5": RINGS[1:2],
        "gp150": RINGS[2:3],
        "all": RINGS,
    }.get(only)
    if targets is None:
        raise SystemExit(f"unknown target {only!r} (gp50|gp5|gp150|all)")
    for src_name, out_name in targets:
        out = os.path.join(os.path.dirname(__file__), out_name)
        ring = build_ring(src_name)
        json.dump({str(k): v for k, v in ring.items()}, open(out, "w"))
        withorigin = sum(1 for v in ring.values() if v["origin"])
        withparams = sum(1 for v in ring.values() if v["params"])
        print(
            f"wrote {out}: {len(ring)} models, {withorigin} origins, "
            f"{withparams} with params"
        )


if __name__ == "__main__":
    import sys

    main(sys.argv[1] if len(sys.argv) > 1 else "all")
