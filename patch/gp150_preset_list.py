"""Non-disruptive GP-150 preset NAME list, read in a single request -- does
NOT select/activate any preset, does NOT touch the pedal's front panel.

Found 2026-09-27 in a capture of Valeton Suite's own startup
traffic (re/gp150_captures/presetlist_startup_capture_2026-09-27.jsonl):
among Suite's batch of small "read info by target ID" requests sent right
after connecting, one (target=0x1010) got back all 200 preset names in one
reply. This replaces the old select-and-read-active-preset approach
(gp150_scan_bank.py's original mechanism), which had to switch the pedal's
real active preset 200 times -- 6-10+ seconds of front-panel disruption per
slot, ~20-30 minutes total, explicitly rejected as impractical. This
request is the SAME wire family as build_select_preset_message() (a
generic "read target X" struct, category=3), just with a different target
and no side effect on the active preset.

Only gives {index, name} per slot -- NOT the full patch body, so it can't by
itself answer "which SnapTone/NAM/IR does preset N use" (gp150_patch_usage.py
needs the full 1128-byte body for that). Useful on its own for a fast,
harmless preset browser/name list.
"""
from __future__ import annotations

from patch import gp150_wire as wire
from patch.gp150_set_param import _crc8, compute_wire_tag

PRESET_LIST_TARGET = 0x1010
READ_TARGET_CHECKSUM_START = 4  # same convention as build_select_preset_message()
ENTRY_LEN = 20  # 4-byte index (u32 LE) + 16-byte null-padded name
NAME_LEN = 16
ECHO_PREFIX_LEN = 8  # the reply echoes the request's own 8-byte payload first
HEADER_LEN = 4  # magic(u16 LE) + size(u16 LE), inside the reply after the echo prefix


def build_read_target_request(category: int, subcat: int, target: int, counter: int = 1) -> bytes:
    """Generic "read info by target ID" request -- the same struct family
    build_select_preset_message() uses, verified byte-for-byte against a
    live Suite capture for (category=3, subcat=1, target=0x1010)."""
    payload = bytearray([
        0x01, 0, 0x08, 0x00, category, subcat,
        target & 0xFF, (target >> 8) & 0xFF,
        target & 0xFF, (target >> 8) & 0xFF,
        0x02, 0x00,
    ])
    payload[1] = _crc8(bytes(payload[READ_TARGET_CHECKSUM_START:]))
    header = bytes([0x7F, 0, len(payload), 0, 0, 0, counter & 0xFF, 0])
    raw = bytearray(header + wire.bytes_to_nibbles(bytes(payload)))
    raw[1] = compute_wire_tag(bytes(raw))
    return bytes(raw)


def build_preset_list_request(counter: int = 1) -> bytes:
    return build_read_target_request(0x03, 0x01, PRESET_LIST_TARGET, counter)


def decode_preset_list_stream(stream: bytes) -> list[tuple[int, str]]:
    """Decode a reassembled (NOT length-capped -- use
    wire.reassemble_first_burst_stream(), not reassemble_first_burst())
    reply stream into [(index, name), ...] for all entries present."""
    body = stream[ECHO_PREFIX_LEN:]
    magic = int.from_bytes(body[0:2], "little")
    if magic != PRESET_LIST_TARGET:
        raise ValueError(f"unexpected magic 0x{magic:04x}, expected 0x{PRESET_LIST_TARGET:04x}")
    size = int.from_bytes(body[2:4], "little")
    entries_data = body[HEADER_LEN : HEADER_LEN + size]
    entries = []
    for off in range(0, len(entries_data) - ENTRY_LEN + 1, ENTRY_LEN):
        idx = int.from_bytes(entries_data[off : off + 4], "little")
        name = entries_data[off + 4 : off + 4 + NAME_LEN].split(b"\x00")[0].decode("latin1", "replace")
        entries.append((idx, name))
    return entries
