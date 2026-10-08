"""GP-150 HTTP endpoints: inspect a GP-150 `.prst`, the model catalog, and the
GP-50/GP-5 -> GP-150 preset converter. Kept out of api_device.py so that file
stays close to upstream's; wired in by app/main.py.
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from functools import lru_cache
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import RedirectResponse, Response

from patch import convert_gp50_to_gp150 as gp50_to_gp150
from patch import gp150_format
from patch import prst_format

router = APIRouter(prefix="/api/device")
page_router = APIRouter()


@page_router.get("/gp150")
def gp150_page() -> RedirectResponse:
    """GP-150 support lives inside Preset Explorer (its own section below the
    GP-5/GP-50 inventory); redirect an old bookmark instead of a bare 404."""
    return RedirectResponse("/explorer")


@router.post("/convert/gp50-to-gp150/inspect")
async def convert_gp50_to_gp150_inspect(files: list[UploadFile] = File(...)) -> dict:
    """Preview a GP-50/GP-5 -> GP-150 conversion: patch name and any modules
    with no GP-150 equivalent (currently just NS/SnapTone, never portable —
    see patch/convert_gp50_to_gp150.py). No file data returned."""
    out = []
    for f in files:
        data = await f.read()
        try:
            src = prst_format.detect(data)
            if src.key not in ("gp5", "gp50"):
                raise ValueError(
                    f"{f.filename}: source is {src.name}, not GP-5/GP-50"
                )
            result = gp50_to_gp150.convert(data)
        except ValueError as e:
            out.append({"name": f.filename, "ok": False, "error": str(e)})
            continue
        out.append(
            {
                "name": f.filename,
                "ok": True,
                "source_key": src.key,
                "source_name": src.name,
                "patch_name": prst_format.read_name(data),
                "unmapped": [
                    {"module": u.module, "gp50_model": u.gp50_name}
                    for u in result.unmapped
                ],
            }
        )
    return {"files": out}


@router.post("/convert/gp50-to-gp150")
async def convert_gp50_to_gp150_endpoint(files: list[UploadFile] = File(...)) -> Response:
    """Convert uploaded GP-5/GP-50 .prst file(s) to GP-150. One file -> a
    .prst; many -> a .zip. Import the result into Valeton Suite (not a
    direct device write — GP150-6's live SysEx write protocol is a
    different, still-blocked thing this never touches); Suite repairs the
    file's own checksum on import (confirmed live, GP150-2)."""
    outs: list[tuple[str, bytes]] = []
    for f in files:
        data = await f.read()
        try:
            src = prst_format.detect(data)
            if src.key not in ("gp5", "gp50"):
                raise ValueError(f"source is {src.name}, not GP-5/GP-50")
            result = gp50_to_gp150.convert(data)
        except ValueError as e:
            raise HTTPException(400, f"{f.filename}: {e}")
        stem = (f.filename or "patch").rsplit("/", 1)[-1]
        if stem.lower().endswith(".prst"):
            stem = stem[:-5]
        outs.append((f"{stem}__GP-150.prst", result.prst))

    if len(outs) == 1:
        fname, data = outs[0]
        return Response(
            data,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, data in outs:
            zf.writestr(fname, data)
    return Response(
        buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="converted_gp150.zip"'},
    )


# --- GP-150 read-only inspection (GP150-7, first slice) ------------------------
#
# GP-150 support is NOT integrated into the GP-5/GP-50 inventory pipeline
# above (app.patchlib) — that module's whole model is GP-50's magic-record
# body (model_records/bypass_mask/param_floats), which GP-150 doesn't have
# (re/DEVICE_GP150.md). This is a separate, explicitly read-only endpoint:
# no editing, no writing, no model-catalog cross-reference yet (no model-ID
# record has been found — see re/DEVICE_GP150.md "Open"). It exists so a
# GP-150 .prst can be inspected at all instead of only being rejected by the
# GP-5/GP-50 converter (see _require_supported() in patch/convert.py).


@lru_cache(maxsize=1)
def _gp150_ring() -> dict:
    """fxid -> catalog entry for GP-150, keyed by int (fxid_ring_gp150.json has
    string keys on disk). Independent of app.patchlib._ring(), which is tied to
    the GP-5/GP-50 source-dir device detection this endpoint doesn't use."""
    path = os.path.join(os.path.dirname(prst_format.__file__), "fxid_ring_gp150.json")
    if not os.path.exists(path):
        return {}
    return {int(k): v for k, v in json.load(open(path)).items()}


def _gp150_model_entry(fxid: int, module: str) -> Optional[dict]:
    """FXID_NONE is a real ID collision, not always "nothing selected": VOL's
    catalog has exactly one model ("Volume"), and it happens to share
    FXID_NONE's numeric id (100663299) — confirmed in fxid_ring_gp150.json,
    where that key resolves to VOL's own entry (module="VOL", params=
    [{"name": "Volume", ...}]) because it's the last module build_ring.py
    processes and overwrites the placeholder copies every other module's
    "None" entry also registers under the same id. So treat FXID_NONE as
    "no model" everywhere except VOL, where it's VOL's only real model."""
    if fxid == gp150_format.FXID_NONE and module != "VOL":
        return None
    return _gp150_ring().get(fxid)


@router.post("/gp150/inspect")
async def gp150_inspect(files: list[UploadFile] = File(...)) -> dict:
    """Decode uploaded GP-150 .prst file(s): patch name, chain order, and
    (2026-07-31) which catalog model occupies each module slot, whether that
    module is on or off, and the model's FULL param set with real
    names/values (re/DEVICE_GP150.md — the `algId*4 + 4` offset formula,
    confirmed against every param of every real model in the export corpus).
    Read-only — there is no GP-150 write path (GP150-6 is gated)."""
    out = []
    for f in files:
        data = await f.read()
        try:
            profile = prst_format.detect(data)
        except ValueError as e:
            out.append({"name": f.filename, "ok": False, "error": str(e)})
            continue
        if profile.key != "gp150":
            out.append(
                {
                    "name": f.filename,
                    "ok": False,
                    "error": f"detected as {profile.name}, not GP-150 — use "
                    f"/api/device/convert/inspect for GP-5/GP-50 files",
                }
            )
            continue
        patch = gp150_format.decode(data)
        modules = {}
        for mod, fxid in patch.module_models.items():
            entry = _gp150_model_entry(fxid, mod)
            params = []
            if entry:
                for p in entry.get("params") or []:
                    if p.get("algId", -1) < 0:
                        continue
                    params.append(
                        {
                            "name": p["name"],
                            "algId": p["algId"],
                            "value": gp150_format.read_module_param_by_alg_id(
                                data, mod, p["algId"]
                            ),
                            "min": p.get("min"),
                            "max": p.get("max"),
                            "unit": p.get("unit") or "",
                            "toggle": bool(p.get("toggle")),
                        }
                    )
            modules[mod] = {
                "fxid": fxid,
                "model_name": entry.get("name") or entry.get("fxtitle") if entry else None,
                "origin": entry.get("origin") if entry else None,
                "enabled": patch.module_enabled[mod],
                "params": params,
            }
        out.append(
            {
                "name": f.filename,
                "ok": True,
                "slot_index": patch.slot_index,
                "patch_name": patch.name,
                "chain_order": patch.chain_order,
                "modules": modules,
            }
        )
    return {"files": out}


@router.get("/gp150/models")
def gp150_models() -> dict:
    """Every selectable model, grouped by module — `{module: [{fxid, name,
    origin}, ...]}`, sorted by name. Powers the frontend's model-swap
    dropdown (gp150.js's renderModelSwapControl(), which builds
    build_model_swap_message()-equivalent SysEx via webmidi_gp150.js's
    sendModelSwap()). FXID_NONE is excluded except for VOL, matching
    _gp150_model_entry()'s own "no model selected" convention — VOL's
    catalog has exactly one real model that happens to share that id."""
    by_module: dict[str, list] = {}
    for fxid, entry in _gp150_ring().items():
        module = entry.get("module")
        if module == "N->S":
            # This project's "NS" module (chain_order/MODULE_TAGS) draws its
            # models exclusively from the ring's "N->S"-keyed SnapTone
            # catalog -- it's a SnapTone-slot selector, not a discrete
            # noise-suppressor type. Normalize the key so the frontend can
            # look this up the same way it looks up every other module.
            module = "NS"
        if not module:
            continue
        if fxid == gp150_format.FXID_NONE and module != "VOL":
            continue
        by_module.setdefault(module, []).append(
            {"fxid": fxid, "name": entry.get("name") or entry.get("fxtitle") or "", "origin": entry.get("origin") or ""}
        )
    for models_list in by_module.values():
        models_list.sort(key=lambda m: m["name"])
    return {"modules": by_module}

