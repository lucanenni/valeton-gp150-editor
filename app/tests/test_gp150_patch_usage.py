"""Locks down patch.gp150_patch_usage.decode_usage() against real captured
.prst bodies already in this repo -- see that module's own docstring for
how these fxid values were cross-checked against patch/fxid_ring_gp150.json."""

import os

from patch import gp150_patch_usage as usage

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load(rel_path: str) -> bytes:
    with open(os.path.join(REPO_ROOT, rel_path), "rb") as f:
        return f.read()


def test_snaptone_reference_decodes():
    # Filename itself asserts this: a real capture of setting N->S to
    # SnapTone slot 3 ("_NS" in the name, GP150-6's own SnapTone work).
    prst = _load("re/gp150_captures/param_edits/200-Its GP150_NS.prst")
    result = usage.decode_usage(prst)
    assert result == {"snaptone_slot": 3, "nam_slot": None, "user_ir_slot": None}


def test_direct_factory_algorithm_is_not_a_catalog_reference():
    # A real live-read patch whose N->S module holds a factory algorithm
    # directly (MM=6), not a SnapTone/NAM catalog reference -- must decode
    # to None, not be mistaken for slot 6 or anything else.
    prst = _load("re/gp150_captures/wake_select_read/slot005_settle0.3_uk900dist.prst")
    result = usage.decode_usage(prst)
    assert result["snaptone_slot"] is None
    assert result["nam_slot"] is None


def test_another_real_snaptone_reference():
    prst = _load("re/gp150_captures/param_edits/200-Its GP150_NS_GAIN_60.prst")
    result = usage.decode_usage(prst)
    assert result["snaptone_slot"] == 3
    assert result["nam_slot"] is None
