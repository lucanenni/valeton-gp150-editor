"""patch/gp150_format.py — the GP-150 .prst decoder itself (name, chain order,
per-module params, per-module model fxids).

Ground truth: the 200-file export corpus (BACKLOG_GP150.md GP150-1/2, kept outside
the repo: set GP150_CORPUS_DIR, see app/tests/gp150_corpus.py) and the extracted
catalog (patch/fxid_ring_gp150.json, BACKLOG_GP150.md GP150-4). The model-fxid
offsets (MODULE_MODEL_OFFSET) were found and confirmed 2026-07-31 — every one of
200 x 12 = 2400 model slots in the corpus is a real, known fxid; this is the test
that would catch it drifting. Without the corpus the tests below run on the
stand-in set (empty patch, converted upstream presets, synthetic patches).
"""

import json
import os

from app.tests import gp150_corpus as corpus
from patch import gp150_format as g

PROJECT_ROOT = corpus.PROJECT_ROOT
GP150_FILES = corpus.corpus_files()
RING_PATH = corpus.RING_PATH


def test_corpus_present():
    assert len(GP150_FILES) >= (100 if corpus.have_real_corpus() else 30)


def test_decode_all_corpus_files_cleanly():
    for f in GP150_FILES:
        prst = open(f, "rb").read()
        p = g.decode(prst)
        assert p.name or f.endswith("000-blank.prst"), f"{f}: empty name"
        assert g.is_valid_order(prst), f"{f}: invalid chain-order permutation"
        assert set(p.module_params) == set(g.MODULE_PARAM_OFFSET)
        assert set(p.module_models) == set(g.MODULE_MODEL_OFFSET)
        assert set(p.module_enabled) == set(g.MODULE_ENABLE_OFFSET)
        for v in p.module_enabled.values():
            assert isinstance(v, bool)


def test_all_model_fxids_are_known_across_the_full_corpus():
    ring = json.load(open(RING_PATH))
    known = {int(k) for k in ring} | {g.FXID_NONE}
    bad = []
    for f in GP150_FILES:
        p = g.decode(open(f, "rb").read())
        for mod, fxid in p.module_models.items():
            if fxid not in known:
                bad.append((f, mod, fxid))
    assert not bad, f"{len(bad)} unknown model fxids, e.g. {bad[:5]}"


def test_dst_model_on_a_known_patch():
    # real corpus: 001-New GEN.prst's DST slot is "Green OD"
    path = corpus.real_file("001-New GEN.prst")
    ring = json.load(open(RING_PATH))
    p = g.decode(open(path, "rb").read())
    entry = ring[str(p.module_models["DST"])]
    assert entry["name"] == "Green OD"


def test_full_param_layout_in_range_across_the_whole_corpus():
    """The big one: module_param_offset(module, algId) = model_offset + 4 +
    algId*4 for EVERY param of EVERY model actually active anywhere in the
    200-file corpus, not just the one param-per-module spot-checked when each
    MODULE_PARAM_OFFSET entry was found. Confirmed 2026-07-31: 2608 param
    instances, 0 out of a [min,max] (+5% pad) sanity range."""
    ring = json.load(open(RING_PATH))
    checked = out_of_range = 0
    for f in GP150_FILES:
        prst = open(f, "rb").read()
        p = g.decode(prst)
        for mod, fxid in p.module_models.items():
            if fxid == g.FXID_NONE:
                continue
            entry = ring.get(str(fxid))
            if not entry or not entry.get("params"):
                continue
            for param in entry["params"]:
                val = g.read_module_param_by_alg_id(prst, mod, param["algId"])
                lo, hi = param["min"], param["max"]
                pad = max(1.0, (hi - lo) * 0.05)
                checked += 1
                if not (lo - pad <= val <= hi + pad):
                    out_of_range += 1
    assert checked > (2000 if corpus.have_real_corpus() else 100), f"only checked {checked} param instances"
    assert out_of_range == 0, f"{out_of_range}/{checked} params out of range"


def test_read_model_params_resolves_names():
    ring = json.load(open(RING_PATH))
    path = corpus.real_file("001-New GEN.prst")
    prst = open(path, "rb").read()
    p = g.decode(prst)
    dst_entry = ring[str(p.module_models["DST"])]
    assert dst_entry["name"] == "Green OD"
    params = g.read_model_params(prst, "DST", dst_entry["params"])
    assert params == {"Gain": 10.0, "Tone": 70.0, "Volume": 80.0}


def test_enable_byte_is_always_boolean_and_never_on_with_no_model():
    """Corpus-wide sanity check for MODULE_ENABLE_OFFSET: always 0/1, and
    (enabled=True, no model assigned) never happens - you can't be "on" with
    nothing selected. This is what says the reading is a real on/off flag
    and not a coincidental correlate of something else."""
    for f in GP150_FILES:
        prst = open(f, "rb").read()
        p = g.decode(prst)
        for mod in g.MODULE_ENABLE_OFFSET:
            raw = prst[g.MODULE_ENABLE_OFFSET[mod]]
            assert raw in (0, 1), f"{f}:{mod} enable byte = {raw}, not 0/1"
            if p.module_enabled[mod] and mod != "VOL":
                # VOL's only real model shares FXID_NONE's id (see
                # test_inspect_vol_module_resolves_despite_sharing_fxid_none)
                assert p.module_models[mod] != g.FXID_NONE, f"{f}:{mod} on with no model"


def test_toggling_a_module_off_only_flips_its_enable_byte():
    """Ground truth: 001-New GEN.prst with DST manually toggled off on the
    device (re/gp150_captures/param_edits/001-New GEN_NO_DST.prst), model and
    params left untouched - confirms the enable byte is independent of both."""
    path = corpus.real_file("001-New GEN_NO_DST.prst", subdir="param_edits")
    orig = open(corpus.real_file("001-New GEN.prst"), "rb").read()
    off_ = open(path, "rb").read()
    p_orig, p_off = g.decode(orig), g.decode(off_)
    assert p_orig.module_enabled["DST"] is True
    assert p_off.module_enabled["DST"] is False
    assert p_orig.module_models["DST"] == p_off.module_models["DST"]
    assert p_orig.module_params["DST"] == p_off.module_params["DST"]


def test_name_truncates_at_13_chars_on_the_real_device():
    """Ground truth: a 16-char name typed on the device
    (re/gp150_captures/param_edits/200-Test123456789.prst) truncated to
    exactly 13 - the real field limit, not just the longest name anyone
    happened to type into the 200-file export corpus."""
    path = os.path.join(PROJECT_ROOT, "re/gp150_captures/param_edits", "200-Test123456789.prst")
    p = g.decode(open(path, "rb").read())
    assert p.name == "Test123456789"
    assert len(p.name) == 13


def test_cab_and_eq_use_a_different_offset_than_param_minus_4():
    # documented irregularity: most modules are model_off == param_off - 4,
    # CAB is -8 and EQ is -24 (extra unmapped fixed fields in between)
    assert g.MODULE_MODEL_OFFSET["CAB"] == g.MODULE_PARAM_OFFSET["CAB"] - 8
    assert g.MODULE_MODEL_OFFSET["EQ"] == g.MODULE_PARAM_OFFSET["EQ"] - 24
    for mod in g.MODULE_PARAM_OFFSET:
        if mod in ("CAB", "EQ"):
            continue
        assert g.MODULE_MODEL_OFFSET[mod] == g.MODULE_PARAM_OFFSET[mod] - 4, mod


def test_module_blocks_are_a_uniform_68_bytes_with_no_exceptions():
    """CAB/EQ's *param* offset looks irregular (test above), but that's just
    where their first *tested* param happened to land - the *model* offsets
    (the real block boundary) are perfectly 0x44 apart for all 12 modules,
    zero exceptions. Corrects an earlier reading (re/DEVICE_GP150.md) that
    took the param-offset gaps at face value."""
    offs = sorted(g.MODULE_MODEL_OFFSET.values())
    for i in range(1, len(offs)):
        assert offs[i] - offs[i - 1] == 0x44


def test_nr_ratio_at_0x1e4_via_the_general_formula():
    # 0x1E4 was an open mystery earlier this session ("some NR param, maybe
    # Release") - it's just algId=1 (Ratio) of whatever NR model is active,
    # already covered by module_param_offset(), not a separate unknown.
    assert g.module_param_offset("NR", 1) == 0x1E4


def test_writer_truncates_names_at_13_chars():
    skeleton = corpus.skeleton_bytes()
    out = g.build_from_skeleton(skeleton, name="Test123456789abc")
    assert g.read_name(out) == "Test123456789"
