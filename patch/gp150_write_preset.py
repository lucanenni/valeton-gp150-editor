"""Write a full GP-150 patch body to an arbitrary slot, non-disruptively --
no select, no activation, the pedal's front panel and active preset are
untouched. LIVE-CONFIRMED 2026-09-27: wrote a real captured "Finger Bass"
body to slot 196 (human-numbered) with the pedal never leaving whatever
preset was already active, and read back correct on the real device.

Found in a capture of Valeton Suite's own "import preset
from file" action (re/gp150_captures/import_write_capture_2026-09-27.jsonl):
this is the write-direction sibling of the read-side full-body fetch this
project already understood, using the SAME 8-byte-header/nibble-payload
wire scheme as everything else -- just with a message large enough (1136
bytes total: an 8-byte "write preset" prefix + the 1128-byte body) that its
chunk header needs a 2-byte (7-bit-pair) length/offset instead of the
single-byte length this project's other, smaller multi-chunk writes
(build_dataComm-family messages in webmidi_gp150.js) get away with.

Two real findings from diffing the captured write against the source file:
- The body's OWN internal 0x0E-0x0F checksum (GP150-2, still uncracked in
  general) does NOT need to change when only the target slot changes --
  confirmed identical in the real capture despite the slot index moving
  from 3 to 189. This means an existing, already-valid .prst body can be
  written to any OTHER slot verbatim (its own checksum untouched) without
  needing GP150-2 solved -- writing genuinely NEW/edited content still
  would.
- Body offset 0x0A differs between the source file and what was actually
  transmitted (already-known from GP150-6's write-path work as a
  "transient during transfer" byte the device overwrites/ignores when
  storing) -- left as whatever the source body already has; it does not
  need to match any particular value.

The write-prefix's own tag byte (prefix[1]) IS content-dependent: solved
as crc8(prefix[4:8] + body), the same CRC-8 (poly 0x31) already used
throughout this project's write path -- verified byte-for-byte against
the real capture.
"""
from __future__ import annotations

from patch import gp150_wire as wire
from patch.gp150_set_param import _crc8, compute_wire_tag

WRITE_PREFIX = bytes([0x01, 0, 0x6C, 0x04, 0x01, 0x03, 0x11, 0x30])
WRITE_CHECKSUM_START = 4  # prefix[1] = crc8(prefix[WRITE_CHECKSUM_START:8] + body)
WRITE_CATEGORY = 0x07
CHUNK_MAX_BYTES = 119  # same per-chunk payload cap as build_dataComm-family messages


def build_write_preset_stream(body: bytes, target_slot: int) -> bytes:
    """Return the 1136-byte [prefix + body] stream to chunk and send, with
    `body`'s own patch-index byte (offset 4, 0-based slot) set to
    `target_slot` and the write-prefix's own checksum recomputed --
    everything else in `body` (including its own 0x0E-0x0F checksum) is
    passed through unchanged."""
    if len(body) != 1128:
        raise ValueError(f"expected a 1128-byte GP-150 .prst body, got {len(body)}")
    if not 0 <= target_slot <= 199:
        raise ValueError(f"target_slot must be 0-199, got {target_slot}")

    body = bytearray(body)
    body[4] = target_slot

    prefix = bytearray(WRITE_PREFIX)
    prefix[1] = _crc8(bytes(prefix[WRITE_CHECKSUM_START:8]) + bytes(body))
    return bytes(prefix) + bytes(body)


def build_write_preset_chunks(body: bytes, target_slot: int) -> list[bytes]:
    """Full pipeline: build the write stream, then chunk it exactly like
    the real capture (119 payload bytes/chunk, 0-based chunk index, a
    2-byte little-endian-ish 7-bit-pair total-length and running-offset in
    the outer wire header) -- each chunk's own wire tag computed via the
    same compute_wire_tag() this project's other write messages already
    use. Returns raw chunk bytes (no F0/F7 SysEx wrapper -- add that at
    the MIDI-send layer, same convention as build_select_preset_message()
    etc.)."""
    stream = build_write_preset_stream(body, target_slot)
    total_len = len(stream)

    chunks = []
    offset = 0
    idx = 0
    while offset < total_len:
        chunk_len = min(CHUNK_MAX_BYTES, total_len - offset)
        payload = stream[offset : offset + chunk_len]
        header = bytes([
            0x7F, 0,
            total_len & 0x7F, (total_len >> 7) & 0x7F,
            offset & 0x7F, (offset >> 7) & 0x7F,
            WRITE_CATEGORY, idx & 0xFF,
        ])
        raw = bytearray(header + wire.bytes_to_nibbles(payload))
        raw[1] = compute_wire_tag(bytes(raw))
        chunks.append(bytes(raw))
        offset += chunk_len
        idx += 1
    return chunks
