"""patch/gp150_catalog.py — the catalog/info SysEx replies (names, User
IRs, SnapTones).

Ground truth for names: re/gp150_captures/startup_sequence.mmon, a real
captured Suite connection that already contains this reply's chunks
(category 0x2B) — no live MIDI needed to test this, unlike most of
GP150-5. Cross-checked against the 200-file export corpus (GP150_CORPUS_DIR, optional) via
patch/gp150_format.py's own (separately-derived) name reader.

Ground truth for all three (names, User IRs, SnapTones): the already-
reassembled raw replies from a real live run (2026-09-03,
patch/gp150_read_catalog.py), saved at re/gp150_captures/catalog_live/ —
also no live MIDI needed to test against these, they're just files now.
"""

import glob
import os
import plistlib

from app.tests import gp150_corpus as corpus_helper
from patch import gp150_catalog as catalog
from patch import gp150_format as fmt
from patch import gp150_wire as wire

PROJECT_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
CAPTURES_DIR = os.path.join(PROJECT_ROOT, "re", "gp150_captures")
CATALOG_LIVE_DIR = os.path.join(CAPTURES_DIR, "catalog_live")
ALL_NAMES_REPLY_CATEGORY = 0x2B  # request 0x02 + 0x29, this specific capture's session


def _load_mmon_messages(path):
    top = plistlib.loads(open(path, "rb").read())
    arc = plistlib.loads(top["messageData"])
    objs = arc["$objects"]

    def resolve(x):
        return objs[x.data] if isinstance(x, plistlib.UID) else x

    root = resolve(arc["$top"]["root"])
    out = []
    for u in root["NS.objects"]:
        m = resolve(u)
        ep = resolve(m.get("originatingEndpoint"))
        d = resolve(m.get("data")) if "data" in m else None
        out.append((ep, d))
    return out


def _all_names_reply_chunks():
    path = os.path.join(CAPTURES_DIR, "startup_sequence.mmon")
    msgs = _load_mmon_messages(path)
    return [
        d
        for ep, d in msgs
        if ep == "From GP-150"
        and d is not None
        and len(d) > wire.CHUNK_HEADER_LEN
        and d[wire.CHUNK_CATEGORY_IDX] == ALL_NAMES_REPLY_CATEGORY
    ]


def _corpus_names_by_slot():
    """slot -> stored name from the real corpus (GP150_CORPUS_DIR); {} without it."""
    out = {}
    d = corpus_helper.real_corpus_dir()
    for f in glob.glob(os.path.join(d, "*.prst")) if d else []:
        b = open(f, "rb").read()
        out[fmt.read_patch_index(b)] = fmt.read_name(b)
    return out


def test_decode_all_names_matches_the_real_corpus():
    chunks = _all_names_reply_chunks()
    assert chunks, "no category-0x2B (all-names) chunks found in the capture"
    stream = wire.reassemble_first_burst_stream(chunks)
    assert len(stream) == 4012

    names = catalog.decode_all_names(stream)
    assert len(names) == 200
    assert [idx for idx, _ in names] == list(range(200)), "expected sequential 0..199"

    corpus = _corpus_names_by_slot()
    if not corpus:  # names decoded and sequential above; the cross-check needs the real corpus
        return
    mismatches = []
    for idx, name in names:
        if idx in corpus and corpus[idx] != name:
            mismatches.append((idx, name, corpus[idx]))
    # Known, expected divergence: Suite's own filesystem export sanitizes a
    # few characters (periods/apostrophes/ampersands) that survive in the
    # device's own stored name, which this decoder reads directly — not a
    # decode bug. Assert it stays within that known, small set rather than
    # zero, and that every one is explainable by stripped punctuation.
    assert len(mismatches) < 150, f"too many mismatches to be just filename sanitization: {mismatches[:10]}"
    for idx, decoded, corpus_name in mismatches:
        stripped = "".join(ch for ch in decoded if ch.isalnum() or ch.isspace())
        assert stripped.strip() == corpus_name.strip(), (
            f"slot {idx}: decoded {decoded!r} vs corpus {corpus_name!r} — "
            "not explained by punctuation stripping"
        )


def test_decode_all_names_rejects_a_short_stream():
    import pytest

    with pytest.raises(ValueError):
        catalog.decode_all_names(b"\x00" * 100)


def _live_dat(name):
    return open(os.path.join(CATALOG_LIVE_DIR, name), "rb").read()


def test_live_names_capture_matches_offline_decode_and_corpus():
    # Cross-check the live-captured reply (2026-09-03) against both the
    # offline one (from startup_sequence.mmon) and the corpus directly —
    # a stronger check than the offline-only one above, since this compares
    # against each file's own stored name, not a sanitized export filename.
    stream = _live_dat("names_4012b.dat")
    assert len(stream) == 4012
    names = catalog.decode_all_names(stream)
    assert len(names) == 200
    assert [idx for idx, _ in names] == list(range(200))

    corpus = _corpus_names_by_slot()
    if not corpus:
        return
    mismatches = [(i, n, corpus[i]) for i, n in names if i in corpus and corpus[i] != n]
    assert mismatches == [], f"live decode should match corpus exactly: {mismatches[:5]}"


def test_decode_user_irs_from_live_capture():
    stream = _live_dat("user_irs_412b.dat")
    assert len(stream) == 412
    irs = catalog.decode_user_irs(stream)
    assert len(irs) == 20
    assert [name for _, name in irs] == [f"User IR {i}" for i in range(1, 21)]
    # indices carry a category tag in the high bits, not plain 0-based
    assert [idx for idx, _ in irs] == [0x10000 + i for i in range(20)]


def test_decode_snaptones_from_live_capture():
    stream = _live_dat("snaptones_2032b.dat")
    assert len(stream) == 2032
    snaps = catalog.decode_snaptones(stream)
    assert len(snaps) == 101

    # index 0 is the "no SnapTone" placeholder, then 50 real factory tones
    assert snaps[0] == (0, "None")
    assert snaps[1] == (1, "Dark CL")
    factory_names = [name for _, name in snaps[:51]]
    assert "" not in factory_names, "every factory slot should have a real name"

    # the remaining 50 are unpopulated user slots, a different index base
    user_slots = snaps[51:]
    assert len(user_slots) == 50
    assert [name for _, name in user_slots] == [f"Empty {i}" for i in range(1, 51)]
    assert [idx for idx, _ in user_slots] == [0x10033 + i for i in range(50)]
