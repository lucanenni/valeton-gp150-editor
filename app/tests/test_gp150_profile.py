"""GP-150 support in patch/prst_format.py's DeviceProfile abstraction (GP150-3).

Ground-truth: the 200 real GP-150 exports (kept outside the repo, GP150_CORPUS_DIR;
see app/tests/gp150_corpus.py) or, without them, the stand-in set. GP-150 has its own header bytes (confirmed
2026-08-22 — HEADER_GP150, `11 30 64 04`; earlier docs/code wrongly called
it header-less, since those bytes aren't ASCII like GP-5/GP-50's) and a
different name offset than GP-5/GP-50 (re/DEVICE_GP150.md) — these tests
lock in that DeviceProfile can express that, detect() doesn't misidentify
it (or let it shadow GP-5/GP-50), and existing GP-5/GP-50 behavior is
unchanged.
"""

import glob
import os

from app.tests import gp150_corpus as corpus
from patch import prst_format as fmt

PROJECT_ROOT = corpus.PROJECT_ROOT
GP150_FILES = corpus.corpus_files()


def test_gp150_files_present():
    assert len(GP150_FILES) >= (100 if corpus.have_real_corpus() else 30)


def test_detect_gp150_by_length():
    for f in GP150_FILES:
        prof = fmt.detect(open(f, "rb").read())
        assert prof.key == "gp150", f"{f}: detected as {prof.key!r}"


def test_detect_still_prefers_gp5_gp50_headers():
    fake_gp50 = fmt.HEADER_GP50 + b"\x00" + fmt.SENTINEL + b"\0" * (552 - 0x19)
    assert fmt.detect(fake_gp50).key == "gp50"


def test_gp150_magic_header_across_whole_corpus():
    # Confirmed 2026-08-22: every one of the 200 real exports starts with the
    # same 4 bytes, and so do 3 independent live-captured bodies
    # (re/gp150_captures/wake_replay/, wake_select_read/) — a real magic
    # header, not an export artifact. Non-ASCII, unlike GP-5/GP-50's, which
    # is why it went unrecognized as a header for a while.
    for f in GP150_FILES:
        b = open(f, "rb").read()
        assert b[: len(fmt.HEADER_GP150)] == fmt.HEADER_GP150, f
    for name in ("wake_replay", "wake_select_read"):
        d = os.path.join(PROJECT_ROOT, "re/gp150_captures", name)
        for f in glob.glob(os.path.join(d, "*.prst")):
            b = open(f, "rb").read()
            assert b[: len(fmt.HEADER_GP150)] == fmt.HEADER_GP150, f


def test_gp150_name_offset_and_read_name():
    # cross-check against patch/gp150_format.py's independent reader (same
    # offset, different code path) rather than the export filename, which can
    # differ from the stored name in punctuation/whitespace (e.g. a trailing
    # "." Suite drops from the filename but keeps in the file).
    from patch import gp150_format

    for f in GP150_FILES[:20]:
        b = open(f, "rb").read()
        name = fmt.read_name(b, profile=fmt.GP150)
        assert name or f.endswith("000-blank.prst"), f"{f}: empty name"
        assert name == gp150_format.read_name(b), f"{f}: {name!r} vs gp150_format's reader"


def test_gp150_check_length():
    b = open(GP150_FILES[0], "rb").read()
    fmt.check_length(b, fmt.GP150)  # must not raise
    try:
        fmt.check_length(b[:-1], fmt.GP150)
    except ValueError:
        pass
    else:
        raise AssertionError("expected check_length to reject a truncated GP-150 file")


def test_gp5_gp50_name_defaults_unaffected():
    # read_name/write_name with no profile arg must behave exactly as before
    # (GP-5/GP-50 shared offset) - GP150-3 must not change existing behavior.
    b = bytearray(fmt.HEADER_GP50 + b"\x00" + fmt.SENTINEL + b"\0" * (552 - 0x19))
    fmt.write_name(b, "Regression")
    assert fmt.read_name(bytes(b)) == "Regression"


def test_body_off_property_matches_old_constant_for_gp50_gp5():
    assert fmt.GP50.body_off == fmt.BODY_OFF
    assert fmt.GP5.body_off == fmt.BODY_OFF
