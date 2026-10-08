"""Emit expected GP-150 .prst inspect results for the GP-150 test corpus,
as a JSON manifest on stdout. The JS port (app/static/gp150_format.js +
gp150.js's decodeGp150()) is checked byte-for-byte against this by
app/tests/test_gp150_inspect_js.mjs.

Reimplements app/api_device.py's gp150_inspect()/_gp150_model_entry() logic
directly against patch/gp150_format.py rather than importing the FastAPI
route (which takes UploadFile objects, awkward to call from a script) --
same transform, just called from a plain function instead of a route.
"""

import base64
import glob
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from app.tests import gp150_corpus as corpus_helper  # noqa: E402
from patch import gp150_format as g150  # noqa: E402


def load_ring() -> dict:
    path = os.path.join(ROOT, "patch", "fxid_ring_gp150.json")
    return {int(k): v for k, v in json.load(open(path)).items()}


def model_entry(ring: dict, fxid: int, module: str):
    if fxid == g150.FXID_NONE and module != "VOL":
        return None
    return ring.get(fxid)


def inspect(prst: bytes, ring: dict) -> dict:
    patch = g150.decode(prst)
    modules = {}
    for mod, fxid in patch.module_models.items():
        entry = model_entry(ring, fxid, mod)
        params = []
        if entry:
            for p in entry.get("params") or []:
                if p.get("algId", -1) < 0:
                    continue
                params.append(
                    {
                        "name": p["name"],
                        "algId": p["algId"],
                        "value": g150.read_module_param_by_alg_id(prst, mod, p["algId"]),
                        "min": p.get("min"),
                        "max": p.get("max"),
                        "unit": p.get("unit") or "",
                        "toggle": bool(p.get("toggle")),
                    }
                )
        modules[mod] = {
            "fxid": fxid,
            "model_name": (entry.get("name") or entry.get("fxtitle")) if entry else None,
            "origin": entry.get("origin") if entry else None,
            "enabled": patch.module_enabled[mod],
            "params": params,
        }
    return {
        "slot_index": patch.slot_index,
        "patch_name": patch.name,
        "chain_order": patch.chain_order,
        "modules": modules,
    }


def models_by_module(ring: dict) -> dict:
    by_module: dict = {}
    for fxid, entry in ring.items():
        module = entry.get("module")
        if module == "N->S":
            module = "NS"
        if not module:
            continue
        if fxid == g150.FXID_NONE and module != "VOL":
            continue
        by_module.setdefault(module, []).append(
            {"fxid": fxid, "name": entry.get("name") or entry.get("fxtitle") or "", "origin": entry.get("origin") or ""}
        )
    for models_list in by_module.values():
        models_list.sort(key=lambda m: m["name"])
    return by_module


def corpus() -> list[str]:
    # the real 200-file corpus when GP150_CORPUS_DIR is set, else the stand-in set
    return corpus_helper.corpus_files()


def b64(x) -> str:
    return base64.b64encode(bytes(x)).decode()


if __name__ == "__main__":
    ring = load_ring()
    files = corpus()
    out = {
        "modelsByModule": models_by_module(ring),
        "records": [
            {"path": os.path.relpath(p, ROOT), "prstB64": b64(open(p, "rb").read()), "expected": inspect(open(p, "rb").read(), ring)}
            for p in files
        ],
    }
    print(json.dumps(out))
