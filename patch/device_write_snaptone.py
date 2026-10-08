"""SnapTone-upload transport groundwork for the GP-50 (CAP-4), kept out of
device_write.py so that file stays close to upstream's. Framing only — there
is deliberately no sender (see the note below)."""

from patch.device_write import _nib_decode, build_packet, crc8

# --- SnapTone upload (CAP-4) — transport only, deliberately NOT wired to a sender ---
#
# re/SNAPTONE_PROTOCOL.md cracked the framing (cmd 0x92, same CRC-8/0x07 + 19-byte
# blocks as the patch write above) from a real capture (298/298 packets matched).
# What that capture never isolated is HOW THE DEVICE KNOWS WHICH SLOT TO WRITE INTO:
# the patch write's target slot is the payload's own first bytes (PATCH_HDR above),
# but no equivalent field has ever been confirmed inside a SnapTone payload — and
# "no separate control/commit packet appeared" in the capture rules out a
# separate select-then-upload step too. Building a real "SnapTone -> slot N" write
# from this alone would be sending a guessed command to real hardware — the exact
# thing this project's own safety discipline refuses (the pedal has wedged from
# unvalidated traffic before). This builder/validator exist so the transport is
# ready the moment a fresh MIDI Monitor capture of a full Suite SnapTone import
# (against a KNOWN target slot) confirms the addressing (CAP-4). No
# send_snaptone_stream exists on purpose for GP-50; the GP-150 equivalent is
# patch/gp150_snaptone_upload.py.
SNAPTONE_UPLOAD_CMD = 0x92  # host->device SnapTone data-write block
SNAPTONE_BLOCK = 19  # payload bytes per block, same as the patch write


def build_snaptone_upload_stream(payload: bytes) -> list:
    """Wire packets for a SnapTone-upload transfer of `payload` (the raw ~2.7 KB
    SnapTone bytes, produced elsewhere — see re/REFIT_FINDINGS.md for why this
    project can't generate that payload itself yet). Same framing as
    build_patch_write_stream, no patch-style header. Returns wire-byte packets
    (each incl F0/F7). Does NOT send — there is no sender for this stream, see
    the module note above."""
    return [
        build_packet(
            SNAPTONE_UPLOAD_CMD, i // SNAPTONE_BLOCK, payload[i : i + SNAPTONE_BLOCK]
        )
        for i in range(0, len(payload), SNAPTONE_BLOCK)
    ]


def validate_snaptone_stream(packets: list) -> tuple:
    """Confirm a SnapTone-upload stream's framing/CRC (mirrors validate_stream, but
    for SNAPTONE_UPLOAD_CMD — no payload-length/header check, since the SnapTone
    payload's own internal layout is still unknown)."""
    payload = bytearray()
    for i, w in enumerate(packets):
        if not w or w[0] != 0xF0 or w[-1] != 0xF7:
            return False, f"packet {i}: not F0..F7 framed"
        buf = _nib_decode(w[1:-1])
        if len(buf) < 4:
            return False, f"packet {i}: truncated"
        crc, cmd, index, length = buf[0], buf[1], buf[2], buf[3]
        if crc8(buf[1:]) != crc:
            return False, f"packet {i}: bad CRC"
        if cmd != SNAPTONE_UPLOAD_CMD:
            return (
                False,
                f"packet {i}: cmd {cmd:#04x} != snaptone-upload {SNAPTONE_UPLOAD_CMD:#04x}",
            )
        if index != i:
            return False, f"packet {i}: non-contiguous index {index}"
        if length != len(buf) - 4:
            return False, f"packet {i}: length {length} != payload {len(buf) - 4}"
        payload += bytes(buf[4 : 4 + length])
    return True, "ok"
