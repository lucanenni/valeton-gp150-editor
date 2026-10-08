"""/api/device/convert/gp50-to-gp150(/inspect) — GP150-7's converter matrix,
GP-50/GP-5 -> GP-150 direction. See patch/convert_gp50_to_gp150.py's and
app/tests/test_convert_gp50_to_gp150.py's docstrings for the research
trail behind the conversion itself; these just cover the HTTP surface.
"""

import glob
import os

from fastapi.testclient import TestClient

from app.main import app
from app.tests import gp150_corpus as corpus

client = TestClient(app)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GP50_SAMPLE = os.path.join(PROJECT_ROOT, "re/probes/test_out/76-VoxUltNAM__NS50-MesaLS.prst")
GP150_SAMPLE = corpus.corpus_files()[0]


def test_inspect_reports_patch_name_and_ns_as_unmapped():
    data = open(GP50_SAMPLE, "rb").read()
    resp = client.post(
        "/api/device/convert/gp50-to-gp150/inspect",
        files={"files": ("VoxUltNAM.prst", data, "application/octet-stream")},
    )
    assert resp.status_code == 200
    entry = resp.json()["files"][0]
    assert entry["ok"] is True
    assert entry["source_key"] == "gp50"
    assert entry["patch_name"] == "VoxUltNAM"
    assert any(u["module"] == "NS" for u in entry["unmapped"])


def test_inspect_rejects_a_gp150_source_with_a_clear_message():
    data = open(GP150_SAMPLE, "rb").read()
    resp = client.post(
        "/api/device/convert/gp50-to-gp150/inspect",
        files={"files": ("gp150.prst", data, "application/octet-stream")},
    )
    assert resp.status_code == 200
    entry = resp.json()["files"][0]
    assert entry["ok"] is False
    assert "gp-150" in entry["error"].lower() or "gp150" in entry["error"].lower()


def test_convert_returns_a_downloadable_gp150_prst():
    data = open(GP50_SAMPLE, "rb").read()
    resp = client.post(
        "/api/device/convert/gp50-to-gp150",
        files={"files": ("VoxUltNAM.prst", data, "application/octet-stream")},
    )
    assert resp.status_code == 200
    assert resp.headers["content-disposition"] == 'attachment; filename="VoxUltNAM__GP-150.prst"'
    assert len(resp.content) == 1128


def test_convert_batch_returns_a_zip():
    data = open(GP50_SAMPLE, "rb").read()
    resp = client.post(
        "/api/device/convert/gp50-to-gp150",
        files=[
            ("files", ("a.prst", data, "application/octet-stream")),
            ("files", ("b.prst", data, "application/octet-stream")),
        ],
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"


def test_convert_rejects_a_gp150_source_with_400():
    data = open(GP150_SAMPLE, "rb").read()
    resp = client.post(
        "/api/device/convert/gp50-to-gp150",
        files={"files": ("gp150.prst", data, "application/octet-stream")},
    )
    assert resp.status_code == 400
