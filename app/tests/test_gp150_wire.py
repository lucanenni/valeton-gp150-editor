"""patch/gp150_wire.py — GP-150 live SysEx body reassembly (GP150-5).

Ground truth: two real MIDI-Monitor captures (re/gp150_captures/*.mmon) of a
live GP-150, cross-checked against the 200-file export corpus when
GP150_CORPUS_DIR points at it (otherwise only structurally checked). `.mmon` files
are NSKeyedArchiver binary plists (MIDI Monitor's save format, no CLI/export)
— parsed here with plistlib + manual $objects/UID resolution, same as the
session that produced these fixtures.
"""

import glob
import os
import plistlib

from app.tests import gp150_corpus as corpus_helper
from patch import gp150_wire as wire

PROJECT_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
CAPTURES_DIR = os.path.join(PROJECT_ROOT, "re", "gp150_captures")


def _load_mmon_messages(path):
    """[(originatingEndpoint, data_bytes_or_None), ...] in capture order."""
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


def _bursts_from_capture(path, category):
    """Split a capture's From-GP150 sysex messages (matching `category`)
    into bursts, via wire.split_bursts() — this helper just does the
    capture-specific endpoint/category filtering first."""
    msgs = _load_mmon_messages(path)
    filtered = [
        d for ep, d in msgs
        if ep == "From GP-150"
        and d is not None
        and len(d) > wire.CHUNK_HEADER_LEN
        and d[wire.CHUNK_CATEGORY_IDX] == category
    ]
    return wire.split_bursts(filtered)


def _corpus():
    """{filename: bytes} of the real corpus (GP150_CORPUS_DIR); {} without it."""
    d = corpus_helper.real_corpus_dir()
    return {
        os.path.basename(f): open(f, "rb").read()
        for f in (glob.glob(os.path.join(d, "*.prst")) if d else [])
    }


def _check_body(body):
    from patch import prst_format as fmt

    assert len(body) == fmt.GP150.prst_len
    assert body[: len(fmt.HEADER_GP150)] == fmt.HEADER_GP150


def test_patch_1_open_capture_matches_corpus_exactly():
    path = os.path.join(CAPTURES_DIR, "patch_1_open.mmon")
    bursts = _bursts_from_capture(path, category=0x15)
    assert bursts, "no category-0x15 bursts found in the capture"
    body = wire.reassemble_body(bursts[0])
    _check_body(body)
    corpus = _corpus()
    if corpus:
        assert body == corpus["001-New GEN.prst"]


def test_bankpc_10_capture_all_bursts_match_real_corpus_files():
    path = os.path.join(CAPTURES_DIR, "bankpc_10_select.mmon")
    bursts = _bursts_from_capture(path, category=0x24)
    full_bursts = [b for b in bursts if len(b) == 10]
    assert len(full_bursts) >= 4, "expected several complete 10-chunk bursts"
    corpus = _corpus()
    matched = 0
    for burst in full_bursts:
        body = wire.reassemble_body(burst)
        _check_body(body)
        if any(body == v for v in corpus.values()):
            matched += 1
    if corpus:
        assert matched == len(full_bursts), f"only {matched}/{len(full_bursts)} bursts matched a real file"


def test_reassemble_body_rejects_missing_chunks():
    import pytest

    # a lone chunk with index 2 (byte 7 == 2) but no chunk 1
    msg = bytes([0] * 7 + [2] + [0])
    with pytest.raises(ValueError):
        wire.reassemble_body([msg])


def _nib_encode(data: bytes) -> list:
    out = []
    for b in data:
        out.append((b >> 4) & 0xF)
        out.append(b & 0xF)
    return out


def _build_burst(category: int, content: bytes) -> list:
    """A synthetic, complete 10-chunk burst (9x238-nibble + 1x130-nibble
    payload, matching the real device's chunking) encoding exactly
    `content` (must be BODY_PREFIX_LEN + a full .prst body = 1136 bytes)."""
    from patch import prst_format as fmt

    assert len(content) == wire.BODY_PREFIX_LEN + fmt.GP150.prst_len
    nibbles = _nib_encode(content)
    sizes = [238] * 9 + [130]
    chunks, pos = [], 0
    for i, size in enumerate(sizes, start=1):
        payload = bytes(nibbles[pos : pos + size])
        pos += size
        header = bytes(6) + bytes([category, i])
        chunks.append(header + payload)
    assert pos == len(nibbles)
    return chunks


def test_reassemble_first_burst_recovers_when_a_stray_truncated_burst_follows():
    """Reproduces the real live failure (2026-08-22, gp150_wake_select_read.py
    settle=0.3): a complete burst, then a second complete (duplicate) burst,
    then a truncated third burst's lone, shorter re-sent chunk 1. Naive
    reassemble_body() on everything merged raises (short decoded length,
    matching the exact 1041-byte figure seen live); reassemble_first_burst()
    recovers the real content from the first complete burst."""
    import pytest

    from patch import prst_format as fmt

    prefix = bytes(range(8))
    body = bytes((i * 7) % 256 for i in range(fmt.GP150.prst_len))
    full = prefix + body

    burst1 = _build_burst(0x30, full)
    burst2 = _build_burst(0x30, full)  # devices duplicate full bursts, observed live
    stray_full_chunk1 = burst2[0]
    stray_truncated = stray_full_chunk1[: wire.CHUNK_HEADER_LEN + 48]  # like the real 56-byte case
    messages = burst1 + burst2 + [stray_truncated, stray_truncated]

    with pytest.raises(ValueError):
        wire.reassemble_body(messages)  # last-index-1-wins merge is short by design

    assert wire.reassemble_first_burst(messages) == body


def test_reassemble_first_burst_recovers_from_silent_frankenstein_corruption():
    """A sneakier variant: a lone same-length chunk-1 from a DIFFERENT burst
    lands right after a complete burst. reassemble_body()'s last-wins merge
    stays the right total length (no exception) but silently splices chunk 1
    from burst B onto chunks 2-10 from burst A — wrong content, no error.
    reassemble_first_burst() must not be fooled by this either."""
    from patch import prst_format as fmt

    prefix = bytes(range(8))
    body_a = bytes((i * 7) % 256 for i in range(fmt.GP150.prst_len))
    body_b = bytes((i * 13 + 3) % 256 for i in range(fmt.GP150.prst_len))
    assert body_a != body_b

    burst_a = _build_burst(0x30, prefix + body_a)
    burst_b = _build_burst(0x30, prefix + body_b)
    messages = burst_a + [burst_b[0]]  # burst B's chunk 1 only, same length as burst A's

    frankenstein = wire.reassemble_body(messages)
    assert frankenstein not in (body_a, body_b), "test setup should produce a spliced body"

    assert wire.reassemble_first_burst(messages) == body_a


def test_bytes_to_nibbles_round_trips_with_nibbles_to_bytes():
    data = bytes(range(256))
    nibbles = wire.bytes_to_nibbles(data)
    assert all(0 <= n <= 15 for n in nibbles)
    assert len(nibbles) == 2 * len(data)
    assert wire.nibbles_to_bytes(nibbles) == data


def test_bytes_to_nibbles_high_nibble_first():
    assert wire.bytes_to_nibbles(bytes([0xAB])) == bytes([0xA, 0xB])
