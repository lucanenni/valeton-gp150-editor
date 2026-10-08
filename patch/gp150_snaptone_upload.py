"""Upload an existing, already-valid SnapTone (.clo / "Tone Catch") file to
an arbitrary GP-150 library slot, non-disruptively -- no select, no
activation. Structurally identical write path to GP150-13's full-preset
write (same 8-byte per-chunk header with a 2-byte 7-bit-pair length/offset,
same compute_wire_tag() formula, same inner-prefix crc8(prefix[4:8]+body)
convention) -- verified byte-for-byte against a capture of Suite importing
a third-party `.nam` to library slot 51
(re/gp150_captures/snaptone_upload_2026-09-24/; the raw capture is not distributed, see its README).

**Does NOT create a new SnapTone from audio** -- the amp-profiling step
that builds a .clo from audio or a NAM model lives in the browser
(app/static/amp_profiler.js). This only WRITES an already-produced `.clo`
file (like the one cached at
a full `.clo` as the profiler writes it (app/tests/fixtures/amp_profiler_synth_golden.clo),
or any real SnapTone Suite has already built) to a chosen slot -- the wire
transport problem, not the DSP problem.

Wire format, confirmed against the real capture:
- 8-byte content prefix (part of the decoded nibble stream, NOT the
  per-chunk MIDI header): `[0x01, crc8(prefix[4:8]+body), 0x20, 0x20,
  0x01, 0x01, typeMarker_lo, typeMarker_hi]`.
- `LibraryStruct` body, 8220 bytes: `typeMarker(u16 LE) + 0x201c(u16 LE,
  constant) + targetSlot(u16 LE, LITERAL library slot, not 0-based --
  confirmed: real capture's slot "51" encodes as literal 51) +
  0x0000(u16, constant) + a 4-byte self-referential echo of the struct's
  own first 4 bytes + name(16 bytes, null-padded ASCII) + an 8192-byte
  data slot`.
- The data slot is the raw `.clo` file's own bytes (a `.clo` file,
  starting with the ASCII magic "VTSI"), hard-truncated to its first 2696
  bytes and zero-padded to fill the fixed 8192-byte slot -- confirmed
  live 2026-09-24 (see BACKLOG_GP150.md's GP150-9 entry) that Suite does this
  same truncate-and-pad regardless of the source file's own length, never
  compressing or re-encoding it.
- Chunked exactly like GP150-13's write (119 payload bytes/chunk, 0-based
  chunk index), just under category `0x08` instead of `0x07`.
"""
from __future__ import annotations

from patch import gp150_wire as wire
from patch.gp150_set_param import _crc8, compute_wire_tag

CLONE_TYPE_MARKER_SNAPTONE = 0x1050  # confirmed from the real capture
CLONE_CHECKSUM_START = 4  # prefix[1] = crc8(prefix[4:8] + body), same convention as GP150-13
CLONE_CATEGORY = 0x08
CLONE_CHUNK_MAX_BYTES = 119
CLONE_STRUCT_LEN = 8220
CLONE_DATA_SLOT_LEN = 8192
CLONE_NAME_LEN = 16
CLONE_DATA_TRUNCATE_LEN = 2696  # confirmed: Suite hard-truncates the source .clo to this length


CLO_HEADER_LEN = 136
CLO_DEVICE_DATA_LEN = 2560  # bytes of float data after the 136-byte header in the device format
CLO_SEG2_MAX = 512  # max floats of segment 2 the device format carries
_CLO_OFF_TOTAL_LEN = 4
_CLO_OFF_CRC = 8
_CLO_OFF_DATA_LEN = 20
_CLO_OFF_SEG2_LEN = 132


def clo_crc16(data: bytes) -> int:
    """Suite's the `.clo` CRC-16 over `file[12:total]`: the standard
    CRC-16/MODBUS (init 0xFFFF, poly 0xA001 reflected) with its two bytes
    swapped -- Suite's own table implementation returns `(hi << 8) | lo`.
    Verified against the real capture (0xe612) and against
    the full 8840-byte file the same conversion starts from (0xcbc0)."""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return ((crc & 0xFF) << 8) | (crc >> 8)


def convert_clo_for_device(clo_bytes: bytes) -> bytes:
    """Suite's own device-format conversion applied to a
    `.clo` before it is sent to the pedal: keep the 136-byte header plus the
    first 2560 data bytes (2696 total), rewrite the header's total-length
    (@4), data-length (@20) and segment-2-length (@132, capped at 512)
    fields to match, and recompute the CRC16 (@8). Idempotent: a file that
    is already in the device format comes back byte-identical (verified
    against the real capture).

    Truncating alone is NOT enough: a device-side header that still
    declares the full 8840-byte file (and carries its CRC) on a 2696-byte
    payload is an inconsistent file, and produces loud self-oscillating
    noise on the real pedal."""
    total = CLO_HEADER_LEN + CLO_DEVICE_DATA_LEN
    out = bytearray(clo_bytes[:total].ljust(total, b"\x00"))
    out[_CLO_OFF_TOTAL_LEN : _CLO_OFF_TOTAL_LEN + 4] = total.to_bytes(4, "little")
    out[_CLO_OFF_DATA_LEN : _CLO_OFF_DATA_LEN + 4] = CLO_DEVICE_DATA_LEN.to_bytes(4, "little")
    seg2 = int.from_bytes(out[_CLO_OFF_SEG2_LEN : _CLO_OFF_SEG2_LEN + 4], "little")
    out[_CLO_OFF_SEG2_LEN : _CLO_OFF_SEG2_LEN + 4] = min(seg2, CLO_SEG2_MAX).to_bytes(4, "little")
    out[_CLO_OFF_CRC : _CLO_OFF_CRC + 4] = clo_crc16(bytes(out[12:total])).to_bytes(4, "little")
    return bytes(out)


def build_library_struct(target_slot: int, name: str, clo_bytes: bytes) -> bytes:
    """`target_slot` is the LITERAL SnapTone library slot (1-100, not
    0-based -- confirmed against the real capture's own slot 51). `name`
    is truncated/null-padded to 16 bytes. `clo_bytes` is a real, complete
    `.clo` file's own raw bytes (starts with "VTSI") -- truncated to
    CLONE_DATA_TRUNCATE_LEN and zero-padded to the fixed 8192-byte slot,
    matching Suite's own real behavior exactly (never compressed/re-coded)."""
    if not 1 <= target_slot <= 100:
        raise ValueError(f"target_slot must be 1-100, got {target_slot}")
    if not clo_bytes.startswith(b"VTSI"):
        raise ValueError("clo_bytes doesn't start with the expected 'VTSI' magic")

    data = convert_clo_for_device(clo_bytes).ljust(CLONE_DATA_SLOT_LEN, b"\x00")

    struct = bytearray(CLONE_STRUCT_LEN)
    struct[0:2] = CLONE_TYPE_MARKER_SNAPTONE.to_bytes(2, "little")
    struct[2:4] = CLONE_STRUCT_LEN.to_bytes(2, "little")  # 0x201c = 8220, a fixed constant
    struct[4:6] = target_slot.to_bytes(2, "little")
    struct[6:8] = b"\x00\x00"
    struct[8:12] = bytes(struct[0:4])  # self-referential echo, confirmed against the real capture
    name_bytes = name.encode("latin1", "replace")[:CLONE_NAME_LEN].ljust(CLONE_NAME_LEN, b"\x00")
    struct[12 : 12 + CLONE_NAME_LEN] = name_bytes
    struct[28 : 28 + len(data)] = data
    return bytes(struct)


def build_clone_upload_stream(target_slot: int, name: str, clo_bytes: bytes) -> bytes:
    body = build_library_struct(target_slot, name, clo_bytes)
    prefix = bytearray([0x01, 0, 0x20, 0x20, 0x01, 0x01]) + CLONE_TYPE_MARKER_SNAPTONE.to_bytes(2, "little")
    prefix[1] = _crc8(bytes(prefix[CLONE_CHECKSUM_START:8]) + body)
    return bytes(prefix) + body


def build_clone_upload_chunks(target_slot: int, name: str, clo_bytes: bytes) -> list[bytes]:
    stream = build_clone_upload_stream(target_slot, name, clo_bytes)
    total_len = len(stream)

    chunks = []
    offset = 0
    idx = 0
    while offset < total_len:
        chunk_len = min(CLONE_CHUNK_MAX_BYTES, total_len - offset)
        payload = stream[offset : offset + chunk_len]
        header = bytes([
            0x7F, 0,
            total_len & 0x7F, (total_len >> 7) & 0x7F,
            offset & 0x7F, (offset >> 7) & 0x7F,
            CLONE_CATEGORY, idx & 0xFF,
        ])
        raw = bytearray(header + wire.bytes_to_nibbles(payload))
        raw[1] = compute_wire_tag(bytes(raw))
        chunks.append(bytes(raw))
        offset += chunk_len
        idx += 1
    return chunks
