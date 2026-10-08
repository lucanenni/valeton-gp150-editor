"""Test data for the GP-150 decoder / converter / inspector tests.

The original ground truth is a corpus of 200 `.prst` files exported from a real
GP-150 (factory and user patches). Those are Valeton's content, so they are NOT
part of the repository. Point `GP150_CORPUS_DIR` at a folder holding them to run
the full real-data checks:

    GP150_CORPUS_DIR=~/Documents/GP-150/corpus_private python -m pytest app/tests

The real Suite upload captures (they hold third-party SnapTone / NAM / IR data) are likewise kept out of
the repo: point `GP150_CAPTURES_DIR` at a folder with the same sub-folder names as re/gp150_captures to
re-run the byte-for-byte parity checks against them; the upload tests otherwise check golden fixtures.

Without it, the suite runs on a deterministic stand-in set built here from:
  * the factory-empty patch ("It's GP-150") shipped as app/static/data/gp150_skeleton.prst,
  * upstream's GP-5/GP-50 sample presets converted to GP-150 by our converter,
  * synthetic patches (random chain order, models from the catalog, parameters in
    range, on/off states, names of 1-13 characters) written with the skeleton writer.
The synthetic set checks that decoding agrees with what was written, not that the
format matches a real pedal — the byte-exact captures under re/gp150_captures/ and
the real corpus cover that.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import random
import tempfile

import pytest

from patch import convert_gp50_to_gp150 as converter
from patch import gp150_format as g

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SKELETON_PATH = os.path.join(PROJECT_ROOT, "app", "static", "data", "gp150_skeleton.prst")
RING_PATH = os.path.join(PROJECT_ROOT, "patch", "fxid_ring_gp150.json")
GP5_FIXTURES = os.path.join(PROJECT_ROOT, "app", "tests", "fixtures", "gp5")
GP50_SAMPLES = os.path.join(PROJECT_ROOT, "re", "probes", "test_out")

# ring "module" label -> the decoder's module key
_MODULE_KEY = {"N->S": "NS"}
_NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -+'"

MIN_REAL_CORPUS = 100


def real_corpus_dir() -> str | None:
    """The real 200-file corpus folder if GP150_CORPUS_DIR points at one."""
    d = os.environ.get("GP150_CORPUS_DIR")
    if not d:
        return None
    d = os.path.expanduser(d)
    files = glob.glob(os.path.join(d, "prst_export", "*.prst")) or glob.glob(os.path.join(d, "*.prst"))
    return (os.path.dirname(files[0]) if len(files) >= MIN_REAL_CORPUS else None)


def have_real_corpus() -> bool:
    return real_corpus_dir() is not None


def real_file(name: str, *, subdir: str | None = None) -> str:
    """Path of one real corpus file (e.g. '001-New GEN.prst'), or skip the test."""
    root = real_corpus_dir()
    if root is None:
        pytest.skip("needs the real GP-150 corpus (set GP150_CORPUS_DIR)")
    base = os.path.dirname(root) if os.path.basename(root) == "prst_export" else root
    candidates = [os.path.join(root, name)]
    if subdir:
        candidates.insert(0, os.path.join(base, subdir, name))
    for c in candidates:
        if os.path.exists(c):
            return c
    pytest.skip(f"{name} not found in the real corpus")


def real_capture(rel: str) -> str:
    """Path of one real Suite capture (third-party content, not in the repo) under GP150_CAPTURES_DIR,
    e.g. 'snaptone_upload_2026-09-24/raw_midi_out_capture.txt'; skips the test when unavailable."""
    d = os.environ.get("GP150_CAPTURES_DIR")
    p = os.path.join(os.path.expanduser(d), rel) if d else None
    if not p or not os.path.exists(p):
        pytest.skip("needs the real Suite captures (set GP150_CAPTURES_DIR)")
    return p


def skeleton_bytes() -> bytes:
    with open(SKELETON_PATH, "rb") as f:
        return f.read()


def _ring() -> dict:
    with open(RING_PATH) as f:
        return json.load(f)


def _models_by_module() -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for fxid, entry in _ring().items():
        out.setdefault(_MODULE_KEY.get(entry["module"], entry["module"]), []).append(int(fxid))
    return {k: sorted(v) for k, v in out.items()}


def _random_name(rnd: random.Random) -> str:
    n = rnd.randint(1, g.NAME_MAX)
    return "".join(rnd.choice(_NAME_CHARS) for _ in range(n)).strip() or "X"


def synthetic_patches(count: int = 48, seed: int = 20260930) -> list[tuple[str, bytes, dict]]:
    """Deterministic patches written into the empty skeleton.
    Returns (filename, prst bytes, expected) where `expected` holds what was written."""
    rnd = random.Random(seed)
    ring, by_module = _ring(), _models_by_module()
    skeleton = skeleton_bytes()
    modules = list(g.MODULE_NAMES) if hasattr(g, "MODULE_NAMES") else list(g.MODULE_MODEL_OFFSET)
    out = []
    for i in range(count):
        chain = list(g.read_order(skeleton))
        if i % 4:  # every 4th keeps the factory order
            rnd.shuffle(chain)
        name = _random_name(rnd)
        models, params, enabled = {}, {}, {}
        for m in modules:
            cands = by_module.get(m)
            if not cands or (m not in ("VOL",) and rnd.random() < 0.15):
                continue  # leave the module unassigned
            fxid = rnd.choice(cands)
            models[m] = fxid
            params[m] = {}
            for p in ring[str(fxid)].get("params", []):
                lo, hi, step = p["min"], p["max"], p.get("step") or 1.0
                steps = max(int(round((hi - lo) / step)), 0)
                params[m][int(p["algId"])] = float(lo + step * rnd.randint(0, steps))
            enabled[m] = rnd.random() < 0.5
        prst = bytearray(g.build_from_skeleton(
            skeleton, name=name, chain_order=chain,
            module_models=models, module_params=params, module_enabled=enabled,
        ))
        prst[g.PATCH_INDEX_OFF] = i % 200
        expected = {"name": name[: g.NAME_MAX], "chain": chain, "models": models,
                    "params": params, "enabled": enabled}
        out.append((f"{i + 1:03d}-synth.prst", bytes(prst), expected))
    return out


def converted_upstream_patches() -> list[tuple[str, bytes]]:
    """Upstream's GP-5/GP-50 sample presets, converted to GP-150."""
    paths = sorted(glob.glob(os.path.join(GP5_FIXTURES, "*.prst")))
    paths += sorted(glob.glob(os.path.join(GP50_SAMPLES, "**", "*.prst"), recursive=True))
    skeleton = skeleton_bytes()
    out, seen = [], set()
    for p in paths:
        with open(p, "rb") as f:
            data = f.read()
        res = converter.convert(data, skeleton=skeleton)
        if res.prst in seen:
            continue
        seen.add(res.prst)
        out.append((f"conv-{os.path.basename(p)}", res.prst))
    return out


def corpus_files() -> list[str]:
    """Paths of `.prst` files to iterate: the real corpus when available,
    otherwise the stand-in set written to a per-content temp folder."""
    real = real_corpus_dir()
    if real:
        return sorted(glob.glob(os.path.join(real, "*.prst")))
    items = [("000-blank.prst", skeleton_bytes())]
    items += converted_upstream_patches()
    items += [(n, b) for n, b, _ in synthetic_patches()]
    digest = hashlib.sha1(b"".join(b for _, b in items)).hexdigest()[:12]
    d = os.path.join(tempfile.gettempdir(), f"gp150_standin_corpus_{digest}")
    os.makedirs(d, exist_ok=True)
    paths = []
    for name, data in items:
        p = os.path.join(d, name)
        if not os.path.exists(p):
            with open(p, "wb") as f:
                f.write(data)
        paths.append(p)
    return sorted(paths)
