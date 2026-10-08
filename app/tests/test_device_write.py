"""CAP-4's transport groundwork: patch/device_write_snaptone.build_snaptone_upload_stream()
and validate_snaptone_stream(). No device I/O, no capture to check against (unlike
the patch write's test_patch_write_stream_reproduces_suite_capture) — the framing
itself (cmd 0x92, CRC-8/0x07, 19-byte blocks) is already cracked and shared with the
patch write's build_packet(), so these tests only need to confirm this project's own
code builds/validates that framing correctly. See the module docstring in
patch/device_write_snaptone.py for exactly why there is no sender to test.
"""

from patch import device_write as dw
from patch import device_write_snaptone as sn


def test_build_snaptone_upload_stream_frames_correctly():
    payload = bytes((i * 7) % 256 for i in range(2755))  # arbitrary ~2.7 KB payload
    packets = sn.build_snaptone_upload_stream(payload)
    assert len(packets) == -(-len(payload) // sn.SNAPTONE_BLOCK)  # ceil division
    for i, w in enumerate(packets):
        assert w[0] == 0xF0 and w[-1] == 0xF7
        buf = dw._nib_decode(w[1:-1])
        crc, cmd, index, length = buf[0], buf[1], buf[2], buf[3]
        assert cmd == sn.SNAPTONE_UPLOAD_CMD
        assert index == i
        assert dw.crc8(buf[1:]) == crc
        expected_len = min(sn.SNAPTONE_BLOCK, len(payload) - i * sn.SNAPTONE_BLOCK)
        assert length == expected_len


def test_build_snaptone_upload_stream_exact_multiple_of_block_size():
    payload = bytes(range(19 * 4))  # exactly 4 full blocks, no short tail
    packets = sn.build_snaptone_upload_stream(payload)
    assert len(packets) == 4
    assert all(dw._nib_decode(w[1:-1])[3] == 19 for w in packets)


def test_validate_snaptone_stream_accepts_well_formed_stream():
    payload = bytes((i * 3 + 1) % 256 for i in range(500))
    packets = sn.build_snaptone_upload_stream(payload)
    ok, reason = sn.validate_snaptone_stream(packets)
    assert ok and reason == "ok"


def test_validate_snaptone_stream_rejects_bad_crc():
    packets = sn.build_snaptone_upload_stream(bytes(range(40)))
    corrupt = list(packets[0])
    corrupt[1] ^= 0xFF  # flip a nibble inside the framed CRC byte
    ok, reason = sn.validate_snaptone_stream([corrupt] + packets[1:])
    assert not ok and "CRC" in reason


def test_validate_snaptone_stream_rejects_wrong_cmd():
    assert sn.SNAPTONE_UPLOAD_CMD != dw.PATCH_WRITE_CMD
    bad = dw.build_packet(dw.PATCH_WRITE_CMD, 0, bytes(range(5)))
    ok, reason = sn.validate_snaptone_stream([bad])
    assert not ok and "cmd" in reason


def test_validate_snaptone_stream_rejects_non_contiguous_index():
    packets = sn.build_snaptone_upload_stream(bytes(range(60)))
    reordered = [packets[0], packets[2], packets[1]]
    ok, reason = sn.validate_snaptone_stream(reordered)
    assert not ok and "index" in reason


def test_snaptone_upload_reuses_the_same_framing_as_the_patch_write():
    # same payload, different cmd byte -> both frame/decode consistently through
    # the one shared build_packet(), and only the cmd (+ the CRC it feeds into)
    # differ; every payload nibble and the F0/F7 frame are identical, confirming
    # the framing/CRC logic isn't duplicated or drifted between the two write kinds
    payload = bytes(range(19))
    snap = dw.build_packet(sn.SNAPTONE_UPLOAD_CMD, 0, payload)
    patch = dw.build_packet(dw.PATCH_WRITE_CMD, 0, payload)
    assert len(snap) == len(patch)
    assert snap[0] == patch[0] == 0xF0 and snap[-1] == patch[-1] == 0xF7
    assert snap[9:-1] == patch[9:-1]  # payload nibbles (after the 4-byte header)
    assert snap[5:9] == patch[5:9]  # index + length nibbles unaffected by cmd
    assert snap[3:5] != patch[3:5]  # the cmd nibbles themselves differ
    snap_buf, patch_buf = dw._nib_decode(snap[1:-1]), dw._nib_decode(patch[1:-1])
    assert dw.crc8(snap_buf[1:]) == snap_buf[0]
    assert dw.crc8(patch_buf[1:]) == patch_buf[0]


def test_no_sender_exists_for_snaptone_upload_on_purpose():
    # CAP-4 is deliberately transport-only until slot-addressing is confirmed
    # by a real capture — guard against a future change quietly adding one
    # without updating this project's write-safety discipline.
    assert not hasattr(dw, "send_snaptone_stream")
