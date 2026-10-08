"""Extra device endpoints added by this fork (bulk export of stored patches,
reset, replace-SnapTone). Kept out of api_device.py so that file stays close to
upstream's; wired in by app/main.py.
"""

from __future__ import annotations

import io
import os
import zipfile

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app import device_io, patchlib

router = APIRouter(prefix="/api/device")


def _export_patch(slot: int) -> tuple[str, bytes]:
    """(filename, raw .prst bytes) for `slot`, byte-for-byte as stored — for
    local backup/export (EXP-5e), not an edit."""
    src = patchlib.patch_file(slot)
    if src is None:
        raise ValueError(f"unknown patch slot {slot}")
    return os.path.basename(src), open(src, "rb").read()


class ExportRequest(BaseModel):
    patch_slots: list[int]


@router.post("/export")
def export_patches(req: ExportRequest) -> Response:
    """Export one or more patches exactly as stored (EXP-5e's bulk export, no
    edits applied) — a single .prst if one slot, else a .zip."""
    if not req.patch_slots:
        raise HTTPException(400, "no patch slots given")
    try:
        outs = [_export_patch(s) for s in req.patch_slots]
    except ValueError as e:
        raise HTTPException(400, str(e))

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
        headers={"Content-Disposition": 'attachment; filename="presets.zip"'},
    )


class ResetRequest(BaseModel):
    patch_slots: list[int]
    confirm: bool = False
    allow_unverified: bool = False  # override the GP-5 unverified-write gate


@router.post("/reset")
def reset_patches(req: ResetRequest) -> dict:
    """Overwrite each of `patch_slots` with the factory-default blank preset
    (CAP-2) — e.g. to clear out the patches using a SnapTone before deleting
    it. Requires confirm=True. Stops and reports on the first failed slot."""
    if not req.confirm:
        raise HTTPException(400, "refusing to reset: confirm=true required")
    if not req.patch_slots:
        raise HTTPException(400, "no patch slots given")
    missing = [s for s in req.patch_slots if patchlib.patch_file(s) is None]
    if missing:
        raise HTTPException(404, f"unknown patch slot(s): {missing}")
    try:
        blank = prst_format.blank_patch(patchlib.device()["key"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    done = []
    for slot in req.patch_slots:
        r = device_io.write_patch(blank, slot, allow_unverified=req.allow_unverified)
        if not r.get("ok"):
            if done:
                patchlib.reload()
            return {
                "ok": False,
                "reset": done,
                "error": f"stopped after {len(done)}/{len(req.patch_slots)} "
                f"— slot {slot} failed: {r.get('error')}",
            }
        done.append(slot)
    patchlib.reload()
    return {"ok": True, "reset": done}


class ReplaceSnaptoneRequest(BaseModel):
    patch_slots: list[int]
    target_ns_slot: int
    confirm: bool = False
    allow_unverified: bool = False  # override the GP-5 unverified-write gate


@router.post("/replace-snaptone")
def replace_snaptone(req: ReplaceSnaptoneRequest) -> dict:
    """Repoint each of `patch_slots` at a different SnapTone (CAP-3) and write
    the result back to its own slot. Requires confirm=True. Stops and reports
    on the first failed slot."""
    if not req.confirm:
        raise HTTPException(400, "refusing to write: confirm=true required")
    if not req.patch_slots:
        raise HTTPException(400, "no patch slots given")
    missing = [s for s in req.patch_slots if patchlib.patch_file(s) is None]
    if missing:
        raise HTTPException(404, f"unknown patch slot(s): {missing}")
    done = []
    for slot in req.patch_slots:
        try:
            _, data = patchlib.clone_with_snaptone(slot, req.target_ns_slot)
        except ValueError as e:
            return {
                "ok": False,
                "written": done,
                "error": f"stopped after {len(done)}/{len(req.patch_slots)} "
                f"— slot {slot}: {e}",
            }
        r = device_io.write_patch(data, slot, allow_unverified=req.allow_unverified)
        if not r.get("ok"):
            if done:
                patchlib.reload()
            return {
                "ok": False,
                "written": done,
                "error": f"stopped after {len(done)}/{len(req.patch_slots)} "
                f"— slot {slot} failed: {r.get('error')}",
            }
        done.append(slot)
    patchlib.reload()
    return {"ok": True, "written": done}
