"""patch/gp150_write.py — GP-150 write payload construction (GP150-6).

Locks in build_chunks()'s surgical-edit guarantee: it must reproduce the
real captured write byte-for-byte when unmodified, and touch ONLY the
bytes it claims to (slot index and/or checksum) when asked to deviate —
nothing else in the 1128-byte body may ever change. This matters more
than most tests in this repo: this module's output has actually been sent
to the real pedal (patch/gp150_write_replay.py), confirmed live
2026-09-03 — a bug here isn't just a wrong render, it's wrong bytes on
real hardware.
"""

from patch import gp150_format as fmt
from patch import gp150_wire as wire
from patch.gp150_write import (
    CAPTURED_ACK_OUT,
    CAPTURED_SLOT,
    CAPTURED_WRITE_CHUNKS,
    build_chunks,
)


def _reassemble(chunk_lists):
    """0-based chunk indexing, matching the real write direction (see
    design/GP150_SUPPORT.md §3.1) — gp150_wire's own
    reassemble functions assume 1-based (read direction) so aren't reused
    here directly."""
    chunks = {c[7]: bytes(c[8:]) for c in chunk_lists}
    n = max(chunks)
    missing = [i for i in range(0, n + 1) if i not in chunks]
    assert not missing, f"missing chunk indices: {missing}"
    nibbles = b"".join(chunks[i] for i in range(0, n + 1))
    return wire.nibbles_to_bytes(nibbles)


def test_captured_chunks_shape():
    # 9 full 246-byte chunks + 1 short 138-byte one, matching every other
    # full-body burst seen in this project (both read and write direction)
    lens = [len(c) for c in CAPTURED_WRITE_CHUNKS]
    assert lens == [246] * 9 + [138], lens
    assert CAPTURED_ACK_OUT == [127, 26, 0, 0, 0, 0, 17, 0]


def test_captured_chunks_reassemble_to_the_real_written_patch():
    body = _reassemble(CAPTURED_WRITE_CHUNKS)[8 : 8 + fmt.PRST_LEN]
    p = fmt.decode(body)
    assert body[fmt.PATCH_INDEX_OFF] == CAPTURED_SLOT == 199
    assert p.name == "UK900 DIST"
    assert body[0x0E] == 237 and body[0x0F] == 105  # the real, valid checksum


def test_build_chunks_unmodified_matches_capture_exactly():
    assert build_chunks(CAPTURED_SLOT, None) == [list(c) for c in CAPTURED_WRITE_CHUNKS]


def test_build_chunks_slot_only_touches_exactly_the_patch_index_byte():
    real_body = _reassemble(CAPTURED_WRITE_CHUNKS)[8 : 8 + fmt.PRST_LEN]
    edited = build_chunks(50, None)
    for i in range(1, 10):  # chunks 1-9 must be byte-for-byte untouched
        assert edited[i] == list(CAPTURED_WRITE_CHUNKS[i]), f"chunk {i} unexpectedly changed"
    body = _reassemble(edited)[8 : 8 + fmt.PRST_LEN]
    diffs = [i for i in range(fmt.PRST_LEN) if body[i] != real_body[i]]
    assert diffs == [fmt.PATCH_INDEX_OFF]
    assert body[fmt.PATCH_INDEX_OFF] == 50
    assert body[0x0E] == 237 and body[0x0F] == 105  # checksum untouched


def test_build_chunks_checksum_only_touches_exactly_those_two_bytes():
    real_body = _reassemble(CAPTURED_WRITE_CHUNKS)[8 : 8 + fmt.PRST_LEN]
    edited = build_chunks(CAPTURED_SLOT, (0xAB, 0xCD))
    for i in range(1, 10):
        assert edited[i] == list(CAPTURED_WRITE_CHUNKS[i])
    body = _reassemble(edited)[8 : 8 + fmt.PRST_LEN]
    diffs = [i for i in range(fmt.PRST_LEN) if body[i] != real_body[i]]
    assert diffs == [0x0E, 0x0F]
    assert (body[0x0E], body[0x0F]) == (0xAB, 0xCD)
    assert body[fmt.PATCH_INDEX_OFF] == CAPTURED_SLOT  # slot untouched


def test_build_chunks_combined_edit_touches_only_the_three_expected_bytes():
    real_body = _reassemble(CAPTURED_WRITE_CHUNKS)[8 : 8 + fmt.PRST_LEN]
    edited = build_chunks(50, (0, 0))
    body = _reassemble(edited)[8 : 8 + fmt.PRST_LEN]
    diffs = [i for i in range(fmt.PRST_LEN) if body[i] != real_body[i]]
    assert diffs == [fmt.PATCH_INDEX_OFF, 0x0E, 0x0F]
    # the rest of the patch -- name, chain order, every module -- survives untouched
    p = fmt.decode(body)
    p_real = fmt.decode(real_body)
    assert p.name == p_real.name == "UK900 DIST"
    assert p.chain_order == p_real.chain_order
    assert p.module_models == p_real.module_models
    assert p.module_params == p_real.module_params
