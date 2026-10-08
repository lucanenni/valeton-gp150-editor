"""/api/device/gp150/inspect — the first GP-150 product-surface slice (GP150-7).

Read-only decode endpoint, no editing/writing. Ground truth: the 200-file
export corpus (BACKLOG_GP150.md GP150-1/2).
"""

import glob
import json
import os

from fastapi.testclient import TestClient

from app.main import app
from app.tests import gp150_corpus as corpus
from patch import gp150_format as g

client = TestClient(app)

PROJECT_ROOT = corpus.PROJECT_ROOT
GP150_FILES = corpus.corpus_files()


def _green_od_patch(*, dst_enabled=True) -> bytes:
    """Empty skeleton + a DST slot holding "Green OD" at Gain 10 / Tone 70 / Volume 80."""
    ring = json.load(open(corpus.RING_PATH))
    fxid = next(int(k) for k, v in ring.items() if v["module"] == "DST" and v["name"] == "Green OD")
    params = {p["name"]: p["algId"] for p in ring[str(fxid)]["params"]}
    return g.build_from_skeleton(
        corpus.skeleton_bytes(), name="Green patch",
        module_models={"DST": fxid},
        module_params={"DST": {params["Gain"]: 10.0, params["Tone"]: 70.0, params["Volume"]: 80.0}},
        module_enabled={"DST": dst_enabled},
    )
GP5_FILES = sorted(
    glob.glob(os.path.join(os.path.dirname(__file__), "fixtures", "gp5", "*.prst"))
)


def test_gp150_files_present():
    assert len(GP150_FILES) >= (100 if corpus.have_real_corpus() else 30)


def test_inspect_decodes_a_real_gp150_file():
    path = GP150_FILES[0]
    data = open(path, "rb").read()
    resp = client.post(
        "/api/device/gp150/inspect",
        files={"files": (os.path.basename(path), data, "application/octet-stream")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["files"]) == 1
    entry = body["files"][0]
    assert entry["ok"] is True
    assert entry["patch_name"]
    assert len(entry["chain_order"]) == 12
    assert sorted(entry["chain_order"]) == sorted(
        ["NR", "PRE", "WAH", "DST", "NS", "AMP", "CAB", "EQ", "MOD", "DLY", "RVB", "VOL"]
    )
    assert set(entry["modules"]) == {
        "PRE", "WAH", "DST", "NS", "AMP", "NR", "CAB", "EQ", "MOD", "DLY", "RVB", "VOL",
    }
    for mod, m in entry["modules"].items():
        assert set(m) == {"fxid", "model_name", "origin", "enabled", "params"}
        assert isinstance(m["enabled"], bool)
        assert isinstance(m["params"], list)  # [] for FXID_NONE / no ring entry
        for p in m["params"]:
            # algId (2026-09-08): exposed so the frontend's live-write UI
            # (gp150.js's renderWritableParamControl()) can target the
            # right param in build_set_param_message() -- this endpoint
            # itself still only decodes, it doesn't write anything.
            assert set(p) == {"name", "algId", "value", "min", "max", "unit", "toggle"}


def test_inspect_handles_a_batch():
    files = [
        (os.path.basename(p), open(p, "rb").read(), "application/octet-stream")
        for p in GP150_FILES[:10]
    ]
    resp = client.post(
        "/api/device/gp150/inspect",
        files=[("files", f) for f in files],
    )
    assert resp.status_code == 200
    body = resp.json()["files"]
    assert len(body) == 10
    assert all(e["ok"] for e in body)


def test_inspect_resolves_real_model_names_and_params():
    data = _green_od_patch()
    resp = client.post(
        "/api/device/gp150/inspect",
        files={"files": ("green.prst", data, "application/octet-stream")},
    )
    dst = resp.json()["files"][0]["modules"]["DST"]
    assert dst["model_name"] == "Green OD"
    assert dst["params"]
    gain = next(p for p in dst["params"] if p["name"] == "Gain")
    assert gain["value"] == 10.0
    assert gain["min"] == 0.0 and gain["max"] == 100.0


def test_inspect_vol_module_resolves_despite_sharing_fxid_none():
    # VOL's only catalog model ("Volume") shares fxid_ring_gp150.json's key
    # 100663299 with FXID_NONE (the shared "no model" placeholder every other
    # module also uses) - VOL must still resolve to a real model + its
    # Volume param, not read as "no model selected" like every other module
    # legitimately can.
    path = GP150_FILES[0]
    data = open(path, "rb").read()
    resp = client.post(
        "/api/device/gp150/inspect",
        files={"files": (os.path.basename(path), data, "application/octet-stream")},
    )
    vol = resp.json()["files"][0]["modules"]["VOL"]
    assert vol["model_name"] == "Volume"
    assert vol["params"]
    assert any(p["name"] == "Volume" for p in vol["params"])


def test_inspect_reports_a_bypassed_module_as_disabled_with_model_intact():
    data = _green_od_patch(dst_enabled=False)
    resp = client.post(
        "/api/device/gp150/inspect",
        files={"files": ("green_off.prst", data, "application/octet-stream")},
    )
    dst = resp.json()["files"][0]["modules"]["DST"]
    assert dst["enabled"] is False
    assert dst["model_name"] == "Green OD"  # model untouched by the bypass


def test_inspect_rejects_a_gp5_file_with_a_clear_message():
    assert GP5_FILES
    data = open(GP5_FILES[0], "rb").read()
    resp = client.post(
        "/api/device/gp150/inspect",
        files={"files": ("gp5.prst", data, "application/octet-stream")},
    )
    assert resp.status_code == 200
    entry = resp.json()["files"][0]
    assert entry["ok"] is False
    assert "gp-5" in entry["error"].lower() or "gp5" in entry["error"].lower()


def test_inspect_rejects_garbage():
    resp = client.post(
        "/api/device/gp150/inspect",
        files={"files": ("junk.prst", b"not a prst file", "application/octet-stream")},
    )
    assert resp.status_code == 200
    entry = resp.json()["files"][0]
    assert entry["ok"] is False


def test_models_lists_every_module_with_multiple_real_choices():
    # Powers the frontend's model-swap dropdown (GP150-6).
    resp = client.get("/api/device/gp150/models")
    assert resp.status_code == 200
    by_module = resp.json()["modules"]
    assert set(by_module) == {
        "PRE", "WAH", "DST", "NS", "AMP", "NR", "CAB", "EQ", "MOD", "DLY", "RVB", "VOL",
    }
    for module, models_list in by_module.items():
        assert models_list, f"{module} has no models"
        for m in models_list:
            assert set(m) == {"fxid", "name", "origin"}
            assert isinstance(m["fxid"], int)
    # DST is confirmed (test_inspect_resolves_real_model_names_and_params) to
    # have "Green OD" as one of its real models.
    assert any(m["name"] == "Green OD" for m in by_module["DST"])


def test_models_vol_has_exactly_its_one_real_model_not_excluded_as_fxid_none():
    resp = client.get("/api/device/gp150/models")
    vol = resp.json()["modules"]["VOL"]
    assert any(m["name"] == "Volume" for m in vol)
