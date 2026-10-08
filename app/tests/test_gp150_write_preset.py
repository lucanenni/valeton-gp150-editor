"""Locks down patch.gp150_write_preset against a real captured full-preset
write -- see that module's own docstring and
re/gp150_captures/write_preset_2026-09-27/README.md for how this was
found (a capture of Valeton Suite's own "import preset
from file" action) and independently live-verified (a second, genuinely
new write -- different content, different slot -- confirmed on the real
pedal)."""

import json
import os

from patch import gp150_write_preset as writer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CAPTURE_DIR = os.path.join(REPO_ROOT, "re/gp150_captures/write_preset_2026-09-27")


def _load_real_chunks() -> dict[int, bytes]:
    path = os.path.join(CAPTURE_DIR, "midi_out_packets.json")
    with open(path) as f:
        packets = json.load(f)["packets"]
    chunks = {}
    for p in packets:
        b = bytes.fromhex(p.replace(" ", ""))
        d = b[1:-1]
        if len(d) > 8 and d[6] == writer.WRITE_CATEGORY:
            chunks[d[7]] = d
    return chunks


def test_build_write_preset_chunks_matches_real_suite_capture():
    with open(os.path.join(CAPTURE_DIR, "reassembled_stream.raw"), "rb") as f:
        real_stream = f.read()
    real_body = real_stream[8:]  # already has the real target slot (189) baked in

    chunks = writer.build_write_preset_chunks(real_body, target_slot=189)
    real_chunks = _load_real_chunks()

    assert len(chunks) == len(real_chunks) == 10
    for i, built in enumerate(chunks):
        assert built == real_chunks[i], f"chunk {i} mismatch"


def test_write_preset_stream_sets_slot_and_preserves_body_checksum():
    with open(os.path.join(CAPTURE_DIR, "004-Foxy Clean.prst"), "rb") as f:
        orig = f.read()
    assert orig[4] == 3  # factory default slot

    stream = writer.build_write_preset_stream(orig, target_slot=189)
    written_body = stream[8:]

    assert len(stream) == 1136
    assert written_body[4] == 189
    # GP150-2's own file-level checksum must NOT need recomputing when only
    # the slot changes -- confirmed against the real capture.
    assert written_body[0x0E:0x10] == orig[0x0E:0x10]
    # every other byte except the slot index and the known-transient 0x0A
    # byte must be untouched
    diffs = [i for i in range(1128) if written_body[i] != orig[i]]
    assert set(diffs) <= {4, 0x0A}


def test_write_prefix_checksum_matches_real_capture():
    with open(os.path.join(CAPTURE_DIR, "reassembled_stream.raw"), "rb") as f:
        real_stream = f.read()
    real_body = real_stream[8:]

    stream = writer.build_write_preset_stream(real_body, target_slot=189)
    assert stream == real_stream


def test_rejects_wrong_length_body():
    import pytest

    with pytest.raises(ValueError):
        writer.build_write_preset_stream(b"\x00" * 100, target_slot=0)


def test_rejects_out_of_range_slot():
    import pytest

    with pytest.raises(ValueError):
        writer.build_write_preset_stream(b"\x00" * 1128, target_slot=200)
