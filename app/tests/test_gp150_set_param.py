"""patch/gp150_set_param.py — GP-150 set-param + save message construction
(GP150-6).

Same discipline as test_gp150_write.py: build_set_param_message()/
build_save_message() must reproduce the real captures byte-for-byte when
asked for the exact same (module, algid, value)/(slot, name), and must
touch ONLY the bytes they claim to when asked to deviate. All 12 modules
are covered, matching the full module table in design/GP150_SUPPORT.md's
GP150-6 section.
"""

import struct

import pytest

from patch import gp150_wire as wire
from patch.gp150_set_param import (
    CAPTURED_ENABLE_MODULE,
    CAPTURED_ENABLE_ON,
    CAPTURED_ENABLE_TEMPLATE,
    CAPTURED_MODEL_SWAP_TARGET_FXID,
    CAPTURED_MODEL_SWAP_TEMPLATES,
    CAPTURED_REORDER_ORDER,
    CAPTURED_REORDER_TEMPLATE,
    CAPTURED_SAVE_NAME,
    CAPTURED_SAVE_SLOT,
    CAPTURED_SAVE_TEMPLATE,
    CAPTURED_TEMPLATES,
    MODULE_TAGS,
    SAVE_PAYLOAD_LEN,
    SET_PARAM_HEADER_LEN,
    SET_PARAM_PAYLOAD_LEN,
    compute_checksum,
    compute_wire_tag,
    build_enable_message,
    build_model_swap_message,
    build_reorder_message,
    build_save_message,
    build_set_param_message,
    fxid_to_mm_t1_t2,
    mm_t1_t2_to_fxid,
)


def _decode(raw):
    return wire.nibbles_to_bytes(bytes(raw[SET_PARAM_HEADER_LEN:]))


def test_all_twelve_modules_present():
    assert sorted(MODULE_TAGS) == sorted(CAPTURED_TEMPLATES) == [
        "AMP", "CAB", "DLY", "DST", "EQ", "MOD", "NR", "NS", "PRE", "RVB", "VOL", "WAH",
    ]


def test_captured_templates_are_56_bytes_and_decode_to_24():
    for mod, raw in CAPTURED_TEMPLATES.items():
        assert len(raw) == 56, mod
        assert len(_decode(raw)) == SET_PARAM_PAYLOAD_LEN, mod


def test_captured_save_template_is_72_bytes_and_decodes_to_32():
    assert len(CAPTURED_SAVE_TEMPLATE) == 72
    assert len(_decode(CAPTURED_SAVE_TEMPLATE)) == SAVE_PAYLOAD_LEN


def test_captured_templates_match_module_tags_table():
    for mod, tags in MODULE_TAGS.items():
        payload = _decode(CAPTURED_TEMPLATES[mod])
        assert payload[12] == tags["mm"], mod
        assert payload[14] == tags["t1"], mod
        assert payload[15] == tags["t2"], mod
        assert payload[20] == tags["ff"], mod
        assert payload[21] == tags["captured_algid"], mod
        value = struct.unpack("<f", payload[16:20])[0]
        assert value == pytest.approx(tags["captured_value"]), mod


@pytest.mark.parametrize("module", sorted(CAPTURED_TEMPLATES))
def test_compute_checksum_matches_every_captured_module_template(module):
    payload = _decode(CAPTURED_TEMPLATES[module])
    assert payload[1] == compute_checksum(payload)


def test_compute_checksum_matches_captured_save_template():
    payload = _decode(CAPTURED_SAVE_TEMPLATE)
    assert payload[1] == compute_checksum(payload)


def test_captured_save_template_matches_known_slot_and_name():
    payload = _decode(CAPTURED_SAVE_TEMPLATE)
    assert payload[12] == CAPTURED_SAVE_SLOT == 199
    name = payload[16:].rstrip(b"\x00").decode("ascii")
    assert name == CAPTURED_SAVE_NAME == "UK900 DIST"


@pytest.mark.parametrize("module", sorted(MODULE_TAGS))
def test_build_set_param_reproduces_capture_exactly_for_every_module(module):
    tags = MODULE_TAGS[module]
    built = build_set_param_message(module, tags["captured_algid"], tags["captured_value"])
    assert built == CAPTURED_TEMPLATES[module]


def test_build_save_message_reproduces_capture_exactly():
    assert build_save_message(CAPTURED_SAVE_SLOT, CAPTURED_SAVE_NAME) == CAPTURED_SAVE_TEMPLATE


def _checksum_nibble_positions():
    # decoded payload byte 1 (the checksum) lives at these two raw positions
    return {SET_PARAM_HEADER_LEN + 2 * 1, SET_PARAM_HEADER_LEN + 2 * 1 + 1}


def test_build_set_param_value_only_edit_touches_only_the_value_bytes_and_checksum():
    base = CAPTURED_TEMPLATES["AMP"]
    edited = build_set_param_message("AMP", MODULE_TAGS["AMP"]["captured_algid"], 55.0)
    diffs = set(i for i in range(len(base)) if base[i] != edited[i])
    # every diff must fall within the value bytes (16-19), the recomputed
    # payload checksum, or the wire tag (raw byte 1) -- both checksums are
    # now auto-recomputed whenever content changes.
    lo, hi = SET_PARAM_HEADER_LEN + 2 * 16, SET_PARAM_HEADER_LEN + 2 * 20
    allowed = _checksum_nibble_positions() | set(range(lo, hi)) | {1}
    assert diffs and diffs <= allowed
    payload = _decode(edited)
    assert struct.unpack("<f", payload[16:20])[0] == pytest.approx(55.0)
    assert payload[21] == MODULE_TAGS["AMP"]["captured_algid"]  # algid untouched
    assert payload[12:16] == _decode(base)[12:16]  # module tag quartet untouched
    assert payload[1] == compute_checksum(payload)  # checksum recomputed correctly
    assert edited[1] == compute_wire_tag(bytes(edited))  # wire tag recomputed correctly


def test_build_set_param_algid_only_edit_touches_only_the_algid_byte_and_checksum():
    base = CAPTURED_TEMPLATES["AMP"]
    edited = build_set_param_message("AMP", 1, MODULE_TAGS["AMP"]["captured_value"])
    diffs = set(i for i in range(len(base)) if base[i] != edited[i])
    lo, hi = SET_PARAM_HEADER_LEN + 2 * 21, SET_PARAM_HEADER_LEN + 2 * 22
    allowed = _checksum_nibble_positions() | set(range(lo, hi)) | {1}
    assert diffs and diffs <= allowed
    payload = _decode(edited)
    assert payload[21] == 1
    assert struct.unpack("<f", payload[16:20])[0] == pytest.approx(MODULE_TAGS["AMP"]["captured_value"])
    assert payload[1] == compute_checksum(payload)
    assert edited[1] == compute_wire_tag(bytes(edited))


def test_build_set_param_tag_counter_override():
    tags = MODULE_TAGS["AMP"]
    built = build_set_param_message(
        "AMP", tags["captured_algid"], tags["captured_value"], tag=0xAB, counter=0xCD
    )
    assert built[1] == 0xAB
    assert built[6] == 0xCD
    # everything else (payload) still matches the capture exactly
    assert built[:1] + built[2:6] + built[7:] == list(
        CAPTURED_TEMPLATES["AMP"][:1] + CAPTURED_TEMPLATES["AMP"][2:6] + CAPTURED_TEMPLATES["AMP"][7:]
    )


def test_build_save_message_tag_counter_override():
    built = build_save_message(CAPTURED_SAVE_SLOT, CAPTURED_SAVE_NAME, tag=0xAB, counter=0xCD)
    assert built[1] == 0xAB
    assert built[6] == 0xCD
    assert built[:1] + built[2:6] + built[7:] == list(
        CAPTURED_SAVE_TEMPLATE[:1] + CAPTURED_SAVE_TEMPLATE[2:6] + CAPTURED_SAVE_TEMPLATE[7:]
    )


def test_build_set_param_wire_tag_matches_every_captured_module_template():
    for module in sorted(CAPTURED_TEMPLATES):
        raw = CAPTURED_TEMPLATES[module]
        assert raw[1] == compute_wire_tag(bytes(raw)), module


def test_build_set_param_unknown_module_rejected():
    with pytest.raises(ValueError):
        build_set_param_message("NOPE", 0, 1.0)


def test_build_save_message_slot_only_edit_touches_only_the_slot_byte_and_checksum():
    edited = build_save_message(50, CAPTURED_SAVE_NAME)
    diffs = set(i for i in range(len(CAPTURED_SAVE_TEMPLATE)) if CAPTURED_SAVE_TEMPLATE[i] != edited[i])
    lo, hi = SET_PARAM_HEADER_LEN + 2 * 12, SET_PARAM_HEADER_LEN + 2 * 13
    allowed = _checksum_nibble_positions() | set(range(lo, hi)) | {1}
    assert diffs and diffs <= allowed
    payload = _decode(edited)
    assert payload[12] == 50
    assert payload[1] == compute_checksum(payload)
    assert edited[1] == compute_wire_tag(bytes(edited))
    assert payload[16:].rstrip(b"\x00").decode("ascii") == CAPTURED_SAVE_NAME


def test_build_save_message_name_only_edit_leaves_slot_untouched():
    edited = build_save_message(CAPTURED_SAVE_SLOT, "Test Patch")
    payload = _decode(edited)
    assert payload[12] == CAPTURED_SAVE_SLOT
    assert payload[16:].rstrip(b"\x00").decode("ascii") == "Test Patch"


def test_build_save_message_rejects_bad_slot_or_long_or_non_ascii_name():
    with pytest.raises(ValueError):
        build_save_message(200, "x")
    with pytest.raises(ValueError):
        build_save_message(-1, "x")
    with pytest.raises(ValueError):
        build_save_message(0, "a very long name well past sixteen bytes")
    with pytest.raises(ValueError):
        build_save_message(0, "café")  # non-ASCII


# --- fxid <-> (MM, T1, T2) decomposition (2026-09-07 finding) ---

@pytest.mark.parametrize("fxid", [117440590, 436207952, 436208064, 251658242])
def test_fxid_mm_t1_t2_round_trips(fxid):
    mm, t1, t2 = fxid_to_mm_t1_t2(fxid)
    assert mm_t1_t2_to_fxid(mm, t1, t2) == fxid


def test_fxid_to_mm_t1_t2_matches_captured_module_tags():
    # AMP's captured tag was derived from "UK 900" (fxid 117440590) being
    # the active model at capture time; NS's from "Match 35 CL" (fxid
    # 251658242, module "N->S" in fxid_ring_gp150.json).
    assert fxid_to_mm_t1_t2(117440590) == (
        MODULE_TAGS["AMP"]["mm"], MODULE_TAGS["AMP"]["t1"], MODULE_TAGS["AMP"]["t2"]
    )
    assert fxid_to_mm_t1_t2(251658242) == (
        MODULE_TAGS["NS"]["mm"], MODULE_TAGS["NS"]["t1"], MODULE_TAGS["NS"]["t2"]
    )


def test_fxid_to_mm_t1_t2_rejects_nonzero_second_byte():
    with pytest.raises(ValueError):
        fxid_to_mm_t1_t2(0x07010000)  # second byte (from the top) is 0x01, not 0x00


def test_build_set_param_fxid_override_matches_captured_tags():
    built_plain = build_set_param_message("AMP", 0, 71.0)
    built_fxid = build_set_param_message("AMP", 0, 71.0, fxid=117440590)
    assert built_plain == built_fxid


# --- model-swap (2026-09-07: no lookup table needed, the fxid IS the payload) ---

@pytest.mark.parametrize("module", sorted(CAPTURED_MODEL_SWAP_TEMPLATES))
def test_build_model_swap_reproduces_capture_exactly(module):
    template = CAPTURED_MODEL_SWAP_TEMPLATES[module]
    tag, counter = template[1], template[6]
    built = build_model_swap_message(module, CAPTURED_MODEL_SWAP_TARGET_FXID[module], tag, counter)
    assert built == template


def test_build_model_swap_auto_computes_wire_tag_when_omitted():
    built = build_model_swap_message("CAB", CAPTURED_MODEL_SWAP_TARGET_FXID["CAB"])
    assert built[1] == compute_wire_tag(bytes(built))


def test_build_model_swap_unknown_module_rejected():
    with pytest.raises(ValueError):
        build_model_swap_message("NOPE", 1, tag=0, counter=0)


def test_build_model_swap_rejects_oversized_fxid():
    with pytest.raises(ValueError):
        build_model_swap_message("CAB", 1 << 32, tag=0, counter=0)


# --- enable/disable toggle (2026-09-07 finding) ---

def test_build_enable_reproduces_capture_exactly():
    template = CAPTURED_ENABLE_TEMPLATE
    tag, counter = template[1], template[6]
    built = build_enable_message(CAPTURED_ENABLE_MODULE, CAPTURED_ENABLE_ON, tag, counter)
    assert built == template


def test_build_enable_off_flips_only_the_flag_byte():
    on_msg = build_enable_message("NS", True, tag=1, counter=2)
    off_msg = build_enable_message("NS", False, tag=1, counter=2)
    on_payload = _decode(on_msg)
    off_payload = _decode(off_msg)
    assert on_payload[13] == 1
    assert off_payload[13] == 0
    diffs = [i for i in range(len(on_payload)) if on_payload[i] != off_payload[i]]
    assert diffs == [1, 13]  # checksum + the flag byte itself


def test_build_enable_auto_computes_wire_tag_when_omitted():
    built = build_enable_message("NS", True)
    assert built[1] == compute_wire_tag(bytes(built))


def test_build_enable_unknown_module_rejected():
    with pytest.raises(ValueError):
        build_enable_message("NOPE", True, tag=0, counter=0)


# --- chain reorder (2026-09-08 finding) ---

def test_build_reorder_reproduces_capture_exactly():
    tag, counter = CAPTURED_REORDER_TEMPLATE[1], CAPTURED_REORDER_TEMPLATE[6]
    built = build_reorder_message(CAPTURED_REORDER_ORDER, tag, counter)
    assert built == CAPTURED_REORDER_TEMPLATE


def test_build_reorder_auto_computes_wire_tag_when_omitted():
    built = build_reorder_message(CAPTURED_REORDER_ORDER)
    assert built[1] == compute_wire_tag(bytes(built))


def test_build_reorder_rejects_missing_or_duplicate_modules():
    with pytest.raises(ValueError):
        build_reorder_message(["AMP"] * 12, tag=0, counter=0)
    with pytest.raises(ValueError):
        build_reorder_message(list(MODULE_TAGS)[:11], tag=0, counter=0)  # only 11
    with pytest.raises(ValueError):
        build_reorder_message(sorted(MODULE_TAGS) + ["NOPE"], tag=0, counter=0)


def test_build_reorder_encodes_ff_ids_not_module_names_order():
    payload = _decode(build_reorder_message(CAPTURED_REORDER_ORDER, tag=1, counter=2))
    encoded = list(payload[12:24])
    expected = [MODULE_TAGS[m]["ff"] for m in CAPTURED_REORDER_ORDER]
    assert encoded == expected
    assert sorted(encoded) == list(range(12))  # every FF id 0-11 exactly once
