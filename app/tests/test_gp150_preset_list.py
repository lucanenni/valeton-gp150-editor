"""Locks down patch.gp150_preset_list against a real captured reply stream
-- see patch/gp150_preset_list.py's own docstring and
re/gp150_captures/preset_list_2026-09-27/README.md for how this
non-disruptive bulk preset-name request was found (a capture of Valeton
Suite's own startup traffic)."""

import os

from patch import gp150_preset_list as preset_list
from patch import gp150_wire as wire
from patch.gp150_set_param import _crc8, compute_wire_tag

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

KNOWN_REQUEST_HEX = (
    "7f 7c 0c 00 00 00 02 00 00 01 08 0e 00 08 00 00 00 03 00 01 "
    "01 00 01 00 01 00 01 00 00 02 00 00"
)


def _load_stream() -> bytes:
    path = os.path.join(REPO_ROOT, "re/gp150_captures/preset_list_2026-09-27/reassembled_stream.raw")
    with open(path, "rb") as f:
        return f.read()


def test_build_preset_list_request_matches_real_suite_capture():
    known = bytes.fromhex(KNOWN_REQUEST_HEX.replace(" ", ""))
    built = preset_list.build_preset_list_request(counter=2)
    assert built == known


def test_decode_preset_list_stream_against_real_capture():
    stream = _load_stream()
    entries = preset_list.decode_preset_list_stream(stream)
    assert len(entries) == 200
    by_index = dict(entries)
    assert by_index[0] == "New GEN."
    assert by_index[1] == "Dark Clean"
    assert by_index[5] == "UK900 DIST"
    assert by_index[199] == "UK900 DIST"
    assert by_index[190] == "It's GP-150"


def test_read_target_request_checksum_and_wire_tag_are_self_consistent():
    msg = preset_list.build_preset_list_request(counter=5)
    header, nibbles = msg[:8], msg[8:]
    payload = wire.nibbles_to_bytes(nibbles)
    assert payload[1] == _crc8(payload[preset_list.READ_TARGET_CHECKSUM_START:])
    assert header[1] == compute_wire_tag(header + nibbles)
    assert header[6] == 5  # counter round-trips into the wire header
