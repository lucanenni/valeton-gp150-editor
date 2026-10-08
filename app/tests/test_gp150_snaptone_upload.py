"""Locks down patch.gp150_snaptone_upload (SnapTone "Clone" upload).

The wire format was derived from a real Suite import and checked against it byte for byte; that capture
holds a third-party profile, so it is not in the repo. What is checked here:
  * the encoder's chunks equal the golden fixture shared with the JS encoder (so both implementations
    agree), built from a synthetic .clo (see app/tests/gp150_upload_synth.mjs);
  * the library struct layout and the .clo helpers;
  * the original byte-for-byte parity, when GP150_CAPTURES_DIR points at the captures.
See re/gp150_captures/snaptone_upload_2026-09-29/README.md for how the format was derived."""

import json
import os
import re

import pytest

from patch import gp150_snaptone_upload as upload
from app.tests.gp150_corpus import real_capture

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(REPO_ROOT, "app/tests/fixtures")
SYNTH_CLO = os.path.join(FIXTURES, "gp150_synth_device.clo")  # device form of the synthetic profile
GOLDEN = os.path.join(FIXTURES, "gp150_upload_golden.json")


def _synth_clo() -> bytes:
    with open(SYNTH_CLO, "rb") as f:
        return f.read()


def _golden() -> dict:
    with open(GOLDEN) as f:
        return json.load(f)["clone"]


def test_build_clone_upload_chunks_matches_golden():
    g = _golden()
    chunks = upload.build_clone_upload_chunks(g["slot"], g["name"], _synth_clo())
    assert len(chunks) == len(g["chunks"]) == 70
    for i, built in enumerate(chunks):
        assert built.hex() == g["chunks"][i], f"chunk {i} mismatch"


def test_build_clone_upload_chunks_matches_real_suite_capture():
    path = real_capture("snaptone_upload_2026-09-24/raw_midi_out_capture.txt")
    with open(real_capture("snaptone_upload_2026-09-29/snaptone_clo_truncated.raw"), "rb") as f:
        clo = f.read()
    real = {}
    with open(path) as f:
        for line in f:
            m = re.search(r"SYSEX len=(\d+)\s+([0-9a-f ]+)", line)
            if m:
                d = bytes.fromhex(m.group(2).replace(" ", ""))[1:-1]
                if len(d) > 8 and d[6] == upload.CLONE_CATEGORY:
                    real.setdefault(d[7], d)
    with open(real_capture("snaptone_upload_2026-09-29/reassembled_stream.raw"), "rb") as f:
        real_stream = f.read()
    name = real_stream[8 + 12 : 8 + 28].rstrip(b"\x00").decode("ascii")  # as sent by Suite
    chunks = upload.build_clone_upload_chunks(51, name, clo)
    assert len(chunks) == len(real) == 70
    for i, built in enumerate(chunks):
        assert built == real[i], f"chunk {i} mismatch"
    assert upload.build_clone_upload_stream(51, name, clo) == real_stream
    assert upload.convert_clo_for_device(clo) == clo
    assert upload.clo_crc16(clo[12:]) == int.from_bytes(clo[8:12], "little")


def test_library_struct_field_layout():
    clo_bytes = _synth_clo()
    body = upload.build_library_struct(51, "Test Tone", clo_bytes)

    assert len(body) == upload.CLONE_STRUCT_LEN
    assert int.from_bytes(body[0:2], "little") == upload.CLONE_TYPE_MARKER_SNAPTONE
    assert int.from_bytes(body[2:4], "little") == upload.CLONE_STRUCT_LEN
    assert int.from_bytes(body[4:6], "little") == 51  # literal slot, not 0-based
    assert body[6:8] == b"\x00\x00"
    assert body[8:12] == body[0:4]  # self-referential echo
    assert body[12:28] == b"Test Tone" + b"\x00" * 7
    assert body[28:32] == b"VTSI"
    assert body[28 : 28 + len(clo_bytes)] == clo_bytes
    assert body[28 + upload.CLONE_DATA_TRUNCATE_LEN :] == b"\x00" * (
        upload.CLONE_DATA_SLOT_LEN - upload.CLONE_DATA_TRUNCATE_LEN
    )


def test_rejects_missing_vtsi_magic():
    with pytest.raises(ValueError):
        upload.build_library_struct(1, "bad", b"NOTVTSI" + b"\x00" * 100)


def test_rejects_out_of_range_slot():
    clo_bytes = _synth_clo()
    with pytest.raises(ValueError):
        upload.build_library_struct(0, "x", clo_bytes)
    with pytest.raises(ValueError):
        upload.build_library_struct(101, "x", clo_bytes)


def test_device_form_is_idempotent_and_crc_consistent():
    clo = _synth_clo()
    assert upload.convert_clo_for_device(clo) == clo
    assert upload.clo_crc16(clo[12:]) == int.from_bytes(clo[8:12], "little")


def test_convert_clo_for_device_makes_a_full_file_self_consistent():
    # A full 8840-byte .clo as a profiler writes it: its header declares 8840/8704/2048 and a CRC over
    # the whole file. Truncating without rewriting those fields is what produced loud self-oscillating
    # noise on the real pedal.
    with open(os.path.join(FIXTURES, "amp_profiler_synth_golden.clo"), "rb") as f:
        full = f.read()
    assert len(full) == 8840
    out = upload.convert_clo_for_device(full)
    assert len(out) == 2696
    assert int.from_bytes(out[4:8], "little") == 2696
    assert int.from_bytes(out[20:24], "little") == 2560
    assert int.from_bytes(out[132:136], "little") == 512
    assert int.from_bytes(out[8:12], "little") == upload.clo_crc16(out[12:])
    assert out[136:] == full[136:2696]  # sample data untouched
    assert upload.convert_clo_for_device(out) == out  # idempotent
