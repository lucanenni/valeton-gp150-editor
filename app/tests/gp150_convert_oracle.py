"""Emit expected GP-50/GP-5 -> GP-150 conversion results for the in-repo
corpus, as a JSON manifest on stdout. The JS port
(app/static/gp150_format.js + convert_gp50_to_gp150.js) is checked
byte-for-byte against this by app/tests/test_gp150_convert_js.mjs.

Corpus is repo-local only (presetExports/, app/tests/fixtures/gp5/, and the
known-good re/probes/test_out/ sample) so the test runs from a clean
checkout with no external files -- same convention as prst_oracle.py.
"""

import base64
import glob
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from patch import convert_gp50_to_gp150 as conv  # noqa: E402
from patch import gp150_format as g150  # noqa: E402
from patch import prst_format as fmt  # noqa: E402


def corpus() -> list[str]:
    paths = []
    paths += sorted(glob.glob(os.path.join(ROOT, "presetExports", "*.prst")))
    paths += sorted(
        glob.glob(os.path.join(ROOT, "app", "tests", "fixtures", "gp5", "*.prst"))
    )
    paths += sorted(
        glob.glob(os.path.join(ROOT, "re", "probes", "test_out", "*.prst"))
    )
    return paths


def b64(x) -> str:
    return base64.b64encode(bytes(x)).decode()


def load_json(name: str) -> dict:
    with open(os.path.join(ROOT, "patch", name)) as f:
        return json.load(f)


def record(path: str, skeleton: bytes) -> dict:
    with open(path, "rb") as fh:
        prst = fh.read()
    try:
        src = fmt.detect(prst)
    except ValueError as e:
        return {"path": path, "error": str(e)}
    if src.key not in ("gp50", "gp5"):
        return {"path": path, "error": f"not gp50/gp5 ({src.key})"}
    rec = {
        "path": os.path.relpath(path, ROOT),
        "srcKey": src.key,
        "ringFile": src.ring_file,
        "prstB64": b64(prst),
    }
    try:
        result = conv.convert(prst, skeleton=skeleton)
    except ValueError as e:
        rec["error"] = str(e)
        return rec
    rec["outB64"] = b64(result.prst)
    rec["unmapped"] = [list(u) for u in result.unmapped]
    return rec


if __name__ == "__main__":
    skel_path = conv.DEFAULT_SKELETON_PATH
    with open(skel_path, "rb") as f:
        skeleton = f.read()
    out = {
        "skeletonB64": b64(skeleton),
        "gp50Ring": load_json("fxid_ring.json"),
        "gp5Ring": load_json("fxid_ring_gp5.json"),
        "gp150Ring": load_json("fxid_ring_gp150.json"),
        "modelMap": load_json("gp50_to_gp150_model_map.json"),
        "records": [record(p, skeleton) for p in corpus()],
    }
    print(json.dumps(out))
