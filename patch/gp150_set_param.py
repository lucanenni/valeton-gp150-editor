"""GP-150 set-param + save write logic — no MIDI dependency, mirrors
gp150_write.py's pattern (verbatim captures + surgical nibble edits,
unit-testable without rtmidi/pyobjc). Live sender: gp150_set_param_replay.py.

Both message families are ONE UN-CHUNKED SysEx message each — not the
10-chunk full-body protocol — but their payload past the 8-byte header
IS nibble-encoded, same scheme as everything else on this wire (an early
pass over these captures missed that and read the raw bytes directly;
see design/GP150_SUPPORT.md §3.1).

**set-param** (56 raw bytes -> 24-byte decoded payload), one per parameter
edit:
  01 CC 14 00 00 03 33 30 33 30 10 00 MM 00 T1 T2 00 00 [float32 LE @16-19] FF AA 00 00
`MM,T1,T2,FF` are a per-module tag quartet, captured verbatim per module —
`MM` alone is NOT a unique module id (PRE and NR both use MM=0x00), and
`FF` is the real clean 0-11 module-type id, so the whole quartet travels
together rather than being reconstructed from parts. `AA` is the target
param's `algId` field, taken verbatim from fxid_ring_gp150.json (its real
field, not its list position — confirmed against CAB, which skips algId
slots). The float32 at payload bytes 16-19 is the new value.

`CC` (payload byte 1) is a REAL, VALIDATED CHECKSUM, cracked 2026-09-04
after the first two live 'set' attempts were silently ignored (no ack,
no device-side change) despite being otherwise well-formed: it's
**CRC-8, polynomial 0x31, init 0, no bit reflection, no xorout, computed
over payload bytes [5:]** (i.e. everything from the `03` after the fixed
`01 CC 14 00 00` prefix, through the end — CC itself and the 5 bytes
before it are excluded). Confirmed byte-for-byte against all 12 captured
set-param templates AND the save/commit template below (same formula,
just a longer payload). `_crc8()`/`compute_checksum()` implement this;
build_set_param_message()/build_save_message() recompute and poke it
automatically after every edit — callers never need to touch it.

The RAW header (separate from the payload above) also carries a byte 1
"tag" and a byte 6 "counter" that vary on every real transmission,
including back-to-back resends of an unchanged value.

**`tag` SOLVED and LIVE-CONFIRMED (2026-09-19/20)**: it's the same
CRC-8 (poly 0x31, init 0, no reflection) as the payload checksum above,
just computed over a different, wider range — `compute_wire_tag(raw) =
_crc8(raw[2:]) & 0x7f` (everything after the tag byte itself, i.e. from
the length byte through the end of the nibble-encoded payload).
Verified against 362/363 historical captures across this whole
project's history and all 17 templates in this module, zero
exceptions. The "mystery" was never an unknown algorithm, just an
unmasked CRC compared against a 7-bit MIDI value (see
design/GP150_SUPPORT.md §3.1). Live-confirmed twice on real
hardware: a genuinely new (never-captured) set-param edit changing
AMP gain to 55.0 (user watched the pedal's display), and a full
live-edit + save/commit to a scratch slot, verified via read-back.

`build_set_param_message()`/`build_save_message()`/
`build_model_swap_message()`/`build_enable_message()`/
`build_reorder_message()` now **auto-compute the correct wire tag by
default** (same as the payload checksum always has been) — pass an
explicit `tag=` only to override this for experimentation. `counter`
appears not to need any particular value (a fresh direct-connection
send with `counter=1` worked live with nothing else sent first); it
still defaults to whatever's in the captured template, or 1 for the
from-scratch builders.

**save/commit** (72 raw bytes -> 32-byte decoded payload), sent once after
one or more set-param edits to persist the device's current live state:
  01 CC 1c 00 00 01 20 10 20 10 18 00 SS 00 00 00 <name ASCII, null-padded>
`SS` = the 0-based target slot. `CC` is the exact same CRC-8 as above,
computed over this (longer) payload's own bytes [5:]. No patch content
otherwise — the device already holds the live-edited state internally.
Confirmed live (re/gp150_captures/live_edit/live_edit_save.mmon +
readback_after_save_gain80.prst): after this exact command, the target
slot read back with the edited value persisted and a NEW, device-computed
*file* checksum (unrelated to this per-message CRC-8) — Suite never sent
one for the file.

Both templates below are copied VERBATIM (via plistlib, programmatically
— never hand-typed, matching the lesson learned building gp150_write.py)
from re/gp150_captures/live_edit/live_edit_*.mmon.

**`MM`/`T1`/`T2` are not an opaque per-module tag — they ARE the currently
active model's own `fxid`, split into bytes (2026-09-07, cracked via a
known-target model-swap capture).** Every `fxid` in `fxid_ring_gp150.json`
decomposes as big-endian bytes `[MM, 0x00, T1, T2]` — the third byte is
always 0 in every fxid checked. Confirmed exactly against 4 real fxids:
AMP "UK 900" (`0x0700004e` -> MM=`07`,T1=`00`,T2=`4e`, matching the
captured AMP tag exactly), CAB "UK 30 4x12" (`0x1a000150` ->
MM=`1a`,T1=`01`,T2=`50`), CAB "Foxy 1x12" (`0x1a0001c0`), and the
"N->S"-module's "Match 35 CL" (`0x0f000002` -> MM=`0f`,T1=`00`,T2=`02`,
matching the earlier-captured "NS" tag exactly). Two real consequences:
- `MM`/`T1`/`T2` are only stable as long as the block's active model
  doesn't change — a captured template is really "this module, as long
  as it still holds the model that was active when captured." Swapping
  models changes them (to that new model's own fxid bytes), so
  `build_set_param_message()` accepts an optional `fxid` override to
  recompute them fresh instead of trusting a stale capture.
- `fxid_ring_gp150.json`'s `module == "N->S"` entries (100 of them —
  `Dark CL`, `Band CL`, ... `Empty 50`) are byte-for-byte the SAME
  SnapTone catalog already decoded from the read-side protocol
  (GP150-5's `decode_snaptones()`) — this module loads a SnapTone as its
  "model." `"N->S"` is a SnapTone-slot selector, not a noise-suppressor
  effect — already established in design/GP150_SUPPORT.md §3.2 (the
  manual's "NS"/CC52 is this same slot); this live test just reconfirms
  it from a second, independent angle.

**model-swap** (48 raw bytes -> 20-byte decoded payload), switches the
model loaded into a module — needs no separate id table at all, now that
the fxid encoding above is known:
  01 CC 10 00 00 03 32 30 32 30 0c 00 [fxid, 4 bytes LE] FF 00 00 00
Confirmed exactly against 2 real, KNOWN-target captures (CAB -> "Foxy
1x12", "N->S" module -> "Match 35 CL") plus retroactive decoding of an
earlier unknown-target capture (turns out it was CAB -> "Bad KT OD" on
the "N->S" module, decoded from its own fxid bytes after the fact).
`FF` is the same module id as above (`fxid_ring_gp150.json`'s
`moduleId`). `build_model_swap_message()` builds this from scratch (no
captured template needed) — pass any module + any real `fxid` from the
ring.

**enable/disable toggle** (40 raw bytes -> 16-byte decoded payload),
turns a whole module on/off — a new, simpler command family, decoded
from the same capture round (the "N->S" module going from off to on):
  01 CC 0c 00 00 03 31 30 31 30 08 00 FF EE 00 00
`FF` is the module id again; `EE` is `1` for on, `0` for off.
`build_enable_message()` builds this from scratch too.

**chain reorder** (56 raw bytes -> 24-byte decoded payload, same shape as
set-param), decoded 2026-09-08 from one clean capture (initial chain
`NR PRE WAH DST NS AMP CAB EQ MOD DLY RVB VOL`, user moved VOL to just
before RVB):
  01 CC 14 00 00 03 34 30 34 30 10 00 [12 x FF, one per chain position]
Bytes 12-23 are the new chain order, 12 bytes, **each one a module's
`FF` id** (the same `fxid_ring_gp150.json` `moduleId`, 0-11 — confirmed
2026-09-20 to be the SAME numbering `gp150_format.py`'s `MODULE_NAMES`
now uses to decode the `0x78` chain-order array; they were wrongly
believed to differ until then, see that module's comment) — decoded
the capture's `05 00 01 02 03 04 06 07 08 09 0b 0a` as
`NR,PRE,WAH,DST,NS,AMP,CAB,EQ,MOD,DLY,VOL,RVB`, exactly the requested
reorder. `build_reorder_message()` builds this from a plain list of the
12 module names in their new order. The capture's very next message was
an ordinary set-param setting VOL's own Volume to 90.0 — Suite's
already-known auto-gain-compensation behavior reacting to the reorder,
not part of the reorder mechanism itself.

All four commands (set-param, model-swap, enable, reorder) plus
save/commit share the exact same checksum formula — `CHECKSUM_START=5`
into the payload — confirmed against all of them with zero exceptions;
the tag family at payload bytes 6-9 (`33 30 33 30` set-param / `32 30 32
30` model-swap / `31 30 31 30` enable / `34 30 34 30` reorder) looks
like it just counts the command type (`0x30 + N`) in its low nibble,
though that's cosmetic — nothing reads it.

STATUS: prepared, NOT yet sent — see gp150_set_param_replay.py.
"""

from __future__ import annotations

import struct

from patch import gp150_wire as wire

SET_PARAM_HEADER_LEN = 8  # raw bytes before the nibble payload
SET_PARAM_PAYLOAD_LEN = 24  # decoded payload length
SAVE_PAYLOAD_LEN = 32  # decoded payload length
SAVE_NAME_OFFSET = 16  # decoded payload byte where the name starts
SAVE_NAME_MAX_LEN = 16  # decoded payload bytes 16-31
MODEL_SWAP_PAYLOAD_LEN = 20  # decoded payload length
ENABLE_PAYLOAD_LEN = 16  # decoded payload length
REORDER_PAYLOAD_LEN = 24  # decoded payload length (same as set-param)
REORDER_ORDER_OFFSET = 12  # decoded payload byte where the 12-entry order starts

CAPTURED_SAVE_SLOT = 199
CAPTURED_SAVE_NAME = "UK900 DIST"

# The per-message payload checksum (payload byte 1): CRC-8, poly 0x31,
# init 0, no reflection, no xorout, over payload[CHECKSUM_START:].
# Cracked 2026-09-04 against 23 real (payload, checksum) pairs spanning
# all 12 modules plus the save/commit message — zero exceptions.
CHECKSUM_POLY = 0x31
CHECKSUM_START = 5


def _crc8(data: bytes, poly: int = CHECKSUM_POLY, init: int = 0) -> int:
    crc = init
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def compute_checksum(payload: bytes) -> int:
    """The correct payload byte 1 for a decoded set-param/save payload,
    given every OTHER byte already in place (byte 1 itself is not read)."""
    return _crc8(bytes(payload[CHECKSUM_START:]))


WIRE_TAG_START = 2


def compute_wire_tag(raw: bytes) -> int:
    """The correct raw byte 1 ("tag") for a fully-assembled raw message
    (header + nibble-encoded payload, everything else already in place):
    the same CRC-8 as compute_checksum(), computed over raw[WIRE_TAG_START:]
    and masked to 7 bits (MIDI data bytes can't carry bit 7). See this
    module's docstring for how this was cracked and confirmed live."""
    return _crc8(bytes(raw[WIRE_TAG_START:])) & 0x7F

# --- verbatim captured data (module tags + templates) ---
MODULE_TAGS = {
    "PRE": {"mm": 0, "t1": 0, "t2": 0, "ff": 0, "captured_algid": 0, "captured_value": 29.0},
    "WAH": {"mm": 5, "t1": 0, "t2": 8, "ff": 1, "captured_algid": 0, "captured_value": 70.0},
    "DST": {"mm": 3, "t1": 0, "t2": 0, "ff": 2, "captured_algid": 0, "captured_value": 71.0},
    "NS": {"mm": 15, "t1": 0, "t2": 2, "ff": 3, "captured_algid": 0, "captured_value": 69.0},
    "AMP": {"mm": 7, "t1": 0, "t2": 78, "ff": 4, "captured_algid": 0, "captured_value": 71.0},
    "NR": {"mm": 0, "t1": 0, "t2": 33, "ff": 5, "captured_algid": 2, "captured_value": 137.0},
    "CAB": {"mm": 26, "t1": 1, "t2": 80, "ff": 6, "captured_algid": 1, "captured_value": 45.0},
    "EQ": {"mm": 1, "t1": 0, "t2": 53, "ff": 7, "captured_algid": 0, "captured_value": 18.0},
    "MOD": {"mm": 4, "t1": 0, "t2": 1, "ff": 8, "captured_algid": 0, "captured_value": 61.0},
    "DLY": {"mm": 11, "t1": 0, "t2": 29, "ff": 9, "captured_algid": 0, "captured_value": 53.0},
    "RVB": {"mm": 12, "t1": 0, "t2": 4, "ff": 10, "captured_algid": 0, "captured_value": 49.0},
    "VOL": {"mm": 6, "t1": 0, "t2": 3, "ff": 11, "captured_algid": 0, "captured_value": 65.0},
}

CAPTURED_TEMPLATES = {
    "PRE": [
        127, 46, 24, 0, 0, 0, 50, 0, 0, 1, 14, 10, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 8, 4, 1,
        0, 0, 0, 0, 0, 0, 0, 0,
    ],
    "WAH": [
        127, 104, 24, 0, 0, 0, 52, 0, 0, 1, 8, 2, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 5, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 8, 12, 4, 2,
        0, 1, 0, 0, 0, 0, 0, 0,
    ],
    "DST": [
        127, 107, 24, 0, 0, 0, 33, 0, 0, 1, 8, 14, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 14, 4, 2,
        0, 2, 0, 0, 0, 0, 0, 0,
    ],
    "NS": [
        127, 62, 24, 0, 0, 0, 54, 0, 0, 1, 14, 5, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 15, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 8, 10, 4, 2,
        0, 3, 0, 0, 0, 0, 0, 0,
    ],
    "AMP": [
        127, 82, 24, 0, 0, 0, 9, 0, 0, 1, 1, 0, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 7, 0, 0, 0, 0, 4, 14, 0, 0, 0, 0, 8, 14, 4, 2,
        0, 4, 0, 0, 0, 0, 0, 0,
    ],
    "NR": [
        127, 31, 24, 0, 0, 0, 35, 0, 0, 1, 6, 2, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 9, 4, 3,
        0, 5, 0, 2, 0, 0, 0, 0,
    ],
    "CAB": [
        127, 12, 24, 0, 0, 0, 16, 0, 0, 1, 4, 0, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        1, 10, 0, 0, 0, 1, 5, 0, 0, 0, 0, 0, 3, 4, 4, 2,
        0, 6, 0, 1, 0, 0, 0, 0,
    ],
    "EQ": [
        127, 105, 24, 0, 0, 0, 57, 0, 0, 1, 15, 1, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 1, 0, 0, 0, 0, 3, 5, 0, 0, 0, 0, 9, 0, 4, 1,
        0, 7, 0, 0, 0, 0, 0, 0,
    ],
    "MOD": [
        127, 72, 24, 0, 0, 0, 59, 0, 0, 1, 7, 4, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 4, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 7, 4, 4, 2,
        0, 8, 0, 0, 0, 0, 0, 0,
    ],
    "DLY": [
        127, 38, 24, 0, 0, 0, 31, 0, 0, 1, 14, 10, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 11, 0, 0, 0, 0, 1, 13, 0, 0, 0, 0, 5, 4, 4, 2,
        0, 9, 0, 0, 0, 0, 0, 0,
    ],
    "RVB": [
        127, 62, 24, 0, 0, 0, 29, 0, 0, 1, 10, 5, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 12, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 4, 4, 4, 2,
        0, 10, 0, 0, 0, 0, 0, 0,
    ],
    "VOL": [
        127, 51, 24, 0, 0, 0, 38, 0, 0, 1, 9, 10, 1, 4, 0, 0,
        0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
        0, 6, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 8, 2, 4, 2,
        0, 11, 0, 0, 0, 0, 0, 0,
    ],
}

CAPTURED_SAVE_TEMPLATE = [
    127, 125, 32, 0, 0, 0, 16, 0, 0, 1, 1, 0, 1, 12, 0, 0,
    0, 0, 0, 1, 2, 0, 1, 0, 2, 0, 1, 0, 1, 8, 0, 0,
    12, 7, 0, 0, 0, 0, 0, 0, 5, 5, 4, 11, 3, 9, 3, 0,
    3, 0, 2, 0, 4, 4, 4, 9, 5, 3, 5, 4, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
]

# Two real, KNOWN-target model-swap captures (re/gp150_captures/live_edit/
# GP150_test.mmon — the user reported exactly which model was selected in
# each case, letting the fxid-encoding below be cracked and verified).
# Copied verbatim via plistlib, never hand-typed.
CAPTURED_MODEL_SWAP_TEMPLATES = {
    # CAB, switched from "UK 30 4x12" to "Foxy 1x12" (fxid 436208064 = 0x1a0001c0)
    "CAB": [127, 83, 20, 0, 0, 0, 7, 0, 0, 1, 8, 2, 1, 0, 0, 0, 0, 0, 0, 3, 3, 2, 3, 0, 3, 2, 3, 0, 0, 12, 0, 0, 12, 0, 0, 1, 0, 0, 1, 10, 0, 6, 0, 0, 0, 0, 0, 0],
    # NS (fxid_ring_gp150.json spells this module "N->S"), switched from off
    # to on with "Match 35 CL" (fxid 251658242 = 0x0f000002)
    "NS": [127, 108, 20, 0, 0, 0, 9, 0, 0, 1, 7, 15, 1, 0, 0, 0, 0, 0, 0, 3, 3, 2, 3, 0, 3, 2, 3, 0, 0, 12, 0, 0, 0, 2, 0, 0, 0, 0, 0, 15, 0, 3, 0, 0, 0, 0, 0, 0],
}
CAPTURED_MODEL_SWAP_TARGET_FXID = {"CAB": 436208064, "NS": 251658242}

# The same capture round's enable/disable toggle: NS module, off -> on
# (the model-swap above happened right after this, on the same module).
CAPTURED_ENABLE_TEMPLATE = [127, 39, 16, 0, 0, 0, 8, 0, 0, 1, 1, 7, 0, 12, 0, 0, 0, 0, 0, 3, 3, 1, 3, 0, 3, 1, 3, 0, 0, 8, 0, 0, 0, 3, 0, 1, 0, 0, 0, 0]
CAPTURED_ENABLE_MODULE = "NS"
CAPTURED_ENABLE_ON = True

# Chain-reorder capture (re/gp150_captures/live_edit/reorder_vol_before_rvb.mmon):
# initial chain NR PRE WAH DST NS AMP CAB EQ MOD DLY RVB VOL, user moved VOL
# to just before RVB -> NR PRE WAH DST NS AMP CAB EQ MOD DLY VOL RVB.
CAPTURED_REORDER_TEMPLATE = [127, 88, 24, 0, 0, 0, 7, 0, 0, 1, 4, 6, 1, 4, 0, 0, 0, 0, 0, 3, 3, 4, 3, 0, 3, 4, 3, 0, 1, 0, 0, 0, 0, 5, 0, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 6, 0, 7, 0, 8, 0, 9, 0, 11, 0, 10]
CAPTURED_REORDER_ORDER = ["NR", "PRE", "WAH", "DST", "NS", "AMP", "CAB", "EQ", "MOD", "DLY", "VOL", "RVB"]


def fxid_to_mm_t1_t2(fxid: int) -> tuple:
    """Split a model's fxid (from fxid_ring_gp150.json) into the (MM, T1, T2)
    triple used in set-param/model-swap messages. Every real fxid checked
    decomposes as big-endian bytes [MM, 0x00, T1, T2] — raises if the
    normally-zero third byte isn't, since that would mean this fxid breaks
    the pattern and the split below would silently drop information."""
    b = fxid.to_bytes(4, "big")
    if b[1] != 0:
        raise ValueError(f"fxid {fxid:#010x} has a non-zero second byte ({b[1]:#04x}) — MM/T1/T2 split doesn't apply")
    return b[0], b[2], b[3]


def mm_t1_t2_to_fxid(mm: int, t1: int, t2: int) -> int:
    """Inverse of fxid_to_mm_t1_t2()."""
    return int.from_bytes(bytes([mm, 0, t1, t2]), "big")


def _poke_decoded_byte(raw: bytearray, decoded_index: int, value: int) -> None:
    """Overwrite the two raw nibble-bytes that decode to `value` at
    `decoded_index` of the payload (payload starts at raw[SET_PARAM_HEADER_LEN:]).
    `raw` is mutated in place."""
    pos = SET_PARAM_HEADER_LEN + 2 * decoded_index
    raw[pos] = (value >> 4) & 0xF
    raw[pos + 1] = value & 0xF


def _recompute_payload_checksum(raw: bytearray) -> None:
    """Decode `raw`'s current payload, compute the correct byte-1 checksum
    over it, and poke it back in. Must run AFTER every other payload edit
    (it reads the just-edited bytes) — both builders call this last."""
    payload = bytearray(wire.nibbles_to_bytes(bytes(raw[SET_PARAM_HEADER_LEN:])))
    checksum = compute_checksum(payload)
    _poke_decoded_byte(raw, 1, checksum)


def build_set_param_message(module: str, algid: int, value: float, fxid: int = None, tag: int = None, counter: int = None) -> list:
    """Build a 56-byte set-param message for `module`, targeting parameter
    `algid` (fxid_ring_gp150.json's own algId field for that param) with
    the new `value`. Starts from that module's captured template and edits
    the float32 value (payload bytes 16-19), the algId byte (payload byte
    21), and — critically — recomputes the payload checksum (byte 1) to
    match, using compute_checksum(). Without that last step this silently
    does nothing on real hardware (confirmed live 2026-09-04: the device
    ignores a set-param message whose checksum doesn't match its own
    payload, no ack, no error).

    `MM`/`T1`/`T2` (payload bytes 12/14/15) are the CURRENTLY ACTIVE
    model's own fxid, split via fxid_to_mm_t1_t2() — the captured
    template's value is only correct as long as the module's model hasn't
    changed since capture. Pass the model's real, current `fxid` (read
    from the patch, e.g. via gp150_format.read_module_model()) to
    recompute them fresh; omit it to trust the captured template's model
    (fine for testing against a pedal that hasn't had that module's model
    changed).

    The raw header's byte 1 "tag" is auto-computed via compute_wire_tag()
    to match the final content unless `tag` overrides it; byte 6
    "counter" is left as captured unless `counter` overrides it (no
    known constraint on its value — see this module's docstring)."""
    if module not in CAPTURED_TEMPLATES:
        raise ValueError(f"unknown module {module!r}, expected one of {sorted(CAPTURED_TEMPLATES)}")
    if not (0 <= algid <= 255):
        raise ValueError(f"algid must be a single byte (0-255), got {algid}")
    raw = bytearray(CAPTURED_TEMPLATES[module])
    if counter is not None:
        raw[6] = counter & 0xFF
    if fxid is not None:
        mm, t1, t2 = fxid_to_mm_t1_t2(fxid)
        _poke_decoded_byte(raw, 12, mm)
        _poke_decoded_byte(raw, 14, t1)
        _poke_decoded_byte(raw, 15, t2)
    for i, b in enumerate(struct.pack("<f", value)):
        _poke_decoded_byte(raw, 16 + i, b)
    _poke_decoded_byte(raw, 21, algid)
    _recompute_payload_checksum(raw)
    raw[1] = (tag & 0xFF) if tag is not None else compute_wire_tag(bytes(raw))
    return list(raw)


def build_save_message(slot: int, name: str, tag: int = None, counter: int = None) -> list:
    """Build a 72-byte save/commit message targeting 0-based `slot` with
    `name` (ASCII, truncated/null-padded to SAVE_NAME_MAX_LEN bytes).
    Starts from the captured template and edits the slot byte (payload
    byte 12), the name bytes (payload bytes 16-31), and recomputes the
    payload checksum (byte 1) to match — see build_set_param_message's
    docstring for why that step is mandatory. The raw header's wire tag
    is auto-computed to match unless `tag` overrides it; `counter` is
    left as captured unless overridden."""
    if not (0 <= slot <= 199):
        raise ValueError(f"slot must be 0-199, got {slot}")
    try:
        name_bytes = name.encode("ascii")
    except UnicodeEncodeError as e:
        raise ValueError(f"name must be ASCII: {name!r}") from e
    if len(name_bytes) > SAVE_NAME_MAX_LEN:
        raise ValueError(f"name too long ({len(name_bytes)} bytes, max {SAVE_NAME_MAX_LEN}): {name!r}")
    name_bytes = name_bytes.ljust(SAVE_NAME_MAX_LEN, b"\x00")

    raw = bytearray(CAPTURED_SAVE_TEMPLATE)
    if counter is not None:
        raw[6] = counter & 0xFF
    _poke_decoded_byte(raw, 12, slot)
    for i, b in enumerate(name_bytes):
        _poke_decoded_byte(raw, SAVE_NAME_OFFSET + i, b)
    _recompute_payload_checksum(raw)
    raw[1] = (tag & 0xFF) if tag is not None else compute_wire_tag(bytes(raw))
    return list(raw)


def _build_from_payload(payload: bytes, tag: int = None, counter: int = 1) -> list:
    """Wrap a fully-populated decoded payload (checksum byte not set yet)
    in an 8-byte raw header, nibble-encode it, poke in the correct payload
    checksum, then the correct wire tag (auto-computed via
    compute_wire_tag() unless `tag` overrides it). Shared by
    build_model_swap_message()/build_enable_message()/build_reorder_message(),
    which — unlike build_set_param_message()/build_save_message() — build
    the payload from scratch rather than editing a captured template."""
    header = bytes([0x7F, 0, len(payload), 0, 0, 0, counter & 0xFF, 0])
    raw = bytearray(header + wire.bytes_to_nibbles(payload))
    _recompute_payload_checksum(raw)
    raw[1] = (tag & 0xFF) if tag is not None else compute_wire_tag(bytes(raw))
    return list(raw)


def build_model_swap_message(module: str, target_fxid: int, tag: int = None, counter: int = 1) -> list:
    """Build a 48-byte model-swap message switching `module`'s active
    model to `target_fxid` (any fxid from fxid_ring_gp150.json, no lookup
    table needed — see this module's docstring for how the fxid encoding
    was cracked). Built from scratch, not from a captured template: every
    byte of this format is understood, including the wire tag (auto-computed
    by default — pass `tag=` only to override for experimentation)."""
    if module not in MODULE_TAGS:
        raise ValueError(f"unknown module {module!r}, expected one of {sorted(MODULE_TAGS)}")
    if not (0 <= target_fxid <= 0xFFFFFFFF):
        raise ValueError(f"target_fxid must fit in 4 bytes, got {target_fxid}")
    payload = bytearray(MODEL_SWAP_PAYLOAD_LEN)
    payload[0] = 0x01
    payload[2] = 0x10
    payload[5] = 0x03
    payload[6:10] = b"\x32\x30\x32\x30"
    payload[10] = 0x0C
    payload[12:16] = struct.pack("<I", target_fxid)
    payload[16] = MODULE_TAGS[module]["ff"]
    return _build_from_payload(bytes(payload), tag, counter)


def build_enable_message(module: str, on: bool, tag: int = None, counter: int = 1) -> list:
    """Build a 40-byte message turning `module` on or off as a whole.
    Built from scratch, same rationale as build_model_swap_message() —
    the wire tag is auto-computed by default."""
    if module not in MODULE_TAGS:
        raise ValueError(f"unknown module {module!r}, expected one of {sorted(MODULE_TAGS)}")
    payload = bytearray(ENABLE_PAYLOAD_LEN)
    payload[0] = 0x01
    payload[2] = 0x0C
    payload[5] = 0x03
    payload[6:10] = b"\x31\x30\x31\x30"
    payload[10] = 0x08
    payload[12] = MODULE_TAGS[module]["ff"]
    payload[13] = 1 if on else 0
    return _build_from_payload(bytes(payload), tag, counter)


def build_reorder_message(order: list, tag: int = None, counter: int = 1) -> list:
    """Build a 56-byte chain-reorder message. `order` is the new chain,
    all 12 module names (MODULE_TAGS keys) in their new order — same
    modules this project already uses everywhere else, e.g.
    ["NR","PRE","WAH","DST","NS","AMP","CAB","EQ","MOD","DLY","VOL","RVB"].
    Each entry is encoded as its `FF` id (fxid_ring_gp150.json's
    `moduleId`) — confirmed 2026-09-20 to be the same numbering
    `gp150_format.py`'s `MODULE_NAMES` uses for the `0x78` chain-order
    array (see this module's docstring for how that was settled). Built
    from scratch, same rationale as build_model_swap_message() — the
    wire tag is auto-computed by default."""
    if sorted(order) != sorted(MODULE_TAGS):
        raise ValueError(f"order must contain all 12 modules exactly once, got {order!r}")
    payload = bytearray(REORDER_PAYLOAD_LEN)
    payload[0] = 0x01
    payload[2] = 0x14
    payload[5] = 0x03
    payload[6:10] = b"\x34\x30\x34\x30"
    payload[10] = 0x10
    for i, module in enumerate(order):
        payload[REORDER_ORDER_OFFSET + i] = MODULE_TAGS[module]["ff"]
    return _build_from_payload(bytes(payload), tag, counter)
