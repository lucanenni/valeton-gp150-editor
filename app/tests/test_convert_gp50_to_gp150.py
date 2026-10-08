"""patch/convert_gp50_to_gp150.py — the GP-50->GP-150 converter (GP150-7).

Unlike GP-5<->GP-50 (patch/convert.py, a container reshape of an identical
effect catalog), this is a real cross-catalog transcode: see that module's
docstring and BACKLOG_GP150.md's GP150-7 entry for the full research trail
behind the model crosswalk, the fixed GP-50-slot -> GP-150-module mapping,
and where WAH/VOL (which GP-50 has no blocks for at all) land in the
output chain order.
"""

import glob
import json
import os

from app.tests import gp150_corpus as corpus
from patch import convert_gp50_to_gp150 as conv
from patch import gp150_format as g150
from patch import prst_format as fmt

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GP5_FIXTURES = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "fixtures", "gp5", "*.prst")))
GP50_SAMPLE = os.path.join(PROJECT_ROOT, "re/probes/test_out/76-VoxUltNAM__NS50-MesaLS.prst")


def test_gp50_sample_present():
    assert os.path.exists(GP50_SAMPLE)
    assert GP5_FIXTURES


def test_converts_gp50_to_a_valid_gp150_body():
    data = open(GP50_SAMPLE, "rb").read()
    assert fmt.detect(data).key == "gp50"
    result = conv.convert(data)
    g150.check_length(result.prst)  # raises if not exactly 1128 bytes
    decoded = g150.decode(result.prst)
    assert decoded.name == fmt.read_name(data)


def test_converts_a_gp5_source_too():
    # GP-5's catalog is a strict subset of GP-50's -- same converter path.
    data = open(GP5_FIXTURES[0], "rb").read()
    assert fmt.detect(data).key == "gp5"
    result = conv.convert(data)
    decoded = g150.decode(result.prst)
    assert decoded.name == fmt.read_name(data)


def test_rejects_a_gp150_source():
    data = open(corpus.corpus_files()[0], "rb").read()
    try:
        conv.convert(data)
        assert False, "should have rejected a GP-150 source"
    except ValueError as e:
        assert "gp150" in str(e)


def test_chain_order_matches_source_permutation_plus_wah_and_vol():
    data = open(GP50_SAMPLE, "rb").read()
    result = conv.convert(data)
    decoded = g150.decode(result.prst)
    assert sorted(decoded.chain_order) == sorted(g150.MODULE_NAMES)
    assert len(decoded.chain_order) == 12
    # WAH immediately precedes DST -- GP-50 has no WAH block, inserted at
    # the position GP-150's own factory-default order uses.
    i = decoded.chain_order.index("WAH")
    assert decoded.chain_order[i + 1] == "DST"
    # VOL always last -- GP-50 has no VOL block either.
    assert decoded.chain_order[-1] == "VOL"
    # The other 10 roles preserve the source's own relative order.
    source_order = [conv.GP50_SLOT_MODULE[s] for s in fmt.read_order(data)]
    converted_10 = [m for m in decoded.chain_order if m not in ("WAH", "VOL")]
    assert converted_10 == source_order


def test_wah_and_vol_always_disabled_since_gp50_has_no_opinion_on_them():
    data = open(GP50_SAMPLE, "rb").read()
    result = conv.convert(data)
    decoded = g150.decode(result.prst)
    assert decoded.module_enabled["WAH"] is False
    assert decoded.module_enabled["VOL"] is False


def test_enabled_state_matches_source_bypass_mask():
    data = open(GP50_SAMPLE, "rb").read()
    result = conv.convert(data)
    decoded = g150.decode(result.prst)
    bypass = fmt.bypass_mask(data)
    unmapped = {u.module for u in result.unmapped}
    for slot, module in enumerate(conv.GP50_SLOT_MODULE):
        if module in unmapped:  # no GP-150 model for it: never left "on" with nothing assigned
            assert decoded.module_enabled[module] is False
        else:
            assert decoded.module_enabled[module] == bool(bypass & (1 << slot))


def test_param_values_carry_through_for_a_matched_model():
    data = open(GP50_SAMPLE, "rb").read()
    recs = fmt.model_records(data)
    params = fmt.param_floats(data)
    amp_slot = conv.GP50_SLOT_MODULE.index("AMP")
    idx, cat, fxlow = recs[amp_slot]
    gp50_fxid = (cat << 24) | fxlow
    gp50_ring = json.load(open("patch/fxid_ring.json"))
    gp50_entry = gp50_ring[str(gp50_fxid)]

    result = conv.convert(data)
    decoded = g150.decode(result.prst)
    gp150_ring = json.load(open("patch/fxid_ring_gp150.json"))
    gp150_entry = gp150_ring[str(decoded.module_models["AMP"])]

    by_name_gp50 = {p["name"].lower(): p["algId"] for p in gp50_entry["params"]}
    by_name_gp150 = {p["name"].lower(): p["algId"] for p in gp150_entry["params"]}
    for name in ("gain", "tone"):  # present, spelled identically, on both
        src_val = params[amp_slot * 8 + by_name_gp50[name]]
        dst_val = g150.read_module_param_by_alg_id(result.prst, "AMP", by_name_gp150[name])
        assert dst_val == src_val, name


def test_ns_is_always_reported_unmapped_not_portable():
    # SnapTone content can never carry across -- every GP-50 source's NS
    # slot ends up in `unmapped`, regardless of what's in it.
    data = open(GP50_SAMPLE, "rb").read()
    result = conv.convert(data)
    assert any(u.module == "NS" for u in result.unmapped)


def test_model_map_has_no_genuinely_unmapped_real_models():
    # Every real (non-SnapTone) GP-50 model has at least a best-effort
    # GP-150 equivalent via OVERRIDES_BY_NAME -- if this ever regresses
    # (e.g. a fxid_ring.json rebuild adds a new model), it needs a real
    # mapping decision, not silent tolerance.
    model_map = json.load(open("patch/gp50_to_gp150_model_map.json"))
    gp50_ring = json.load(open("patch/fxid_ring.json"))
    unmapped_real = [
        gp50_ring[k]["name"]
        for k, v in model_map.items()
        if v is None and gp50_ring[k].get("module") != "N->S"
    ]
    assert unmapped_real == []
