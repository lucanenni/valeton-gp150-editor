"""The 552-byte GP-50 .prst format — single source of truth.

Every byte offset, sentinel, record magic, and the file CRC live here and only
here. app/patchlib.py (inventory + edits), patch/device_write.py (write
payload), patch/scan_bank.py + patch/reconstruct_prst.py (rebuild from device
reads), and app/device_io.py (scan-cache naming) all consume this interface
instead of slicing bytes themselves.

Layout (decoded from the 0x41 read + 100/100 round-trip against presetExports;
see re/DEVICE_READ.md):

  prst[0x00:0x14]  constant "GP-50" header                (HEADER)
  prst[0x14]       file CRC — CRC-8/0x07 over prst[0x15:] (CRC_OFF)
  prst[0x15:0x19]  FF FF FF FF sentinel                   (SENTINEL)
  prst[0x19:0x29]  16-byte patch name, latin1, null-pad   (NAME_OFF..BODY_OFF)
  prst[0x29:]      511-byte body                          (BODY_OFF, BODY_LEN)

Body records (offsets found by magic, not fixed position):
  REC_MODELS  [03 30 28 00] + 10 x 4-byte model records [fxlow b0][b1][b2][cat]
  REC_BYPASS  [01 30 04 00] + u32 bitmask, bit k = block k active
  REC_PARAMS  [04 30 40 01] + 80 x float32 (10 blocks x 8 param slots)
  FS_TRAILER  [03 00 0A 00] + [FS1 u32][FS2 u32][2 bytes] footswitch masks

stdlib-only on purpose: imported by the web app (.venv-app) and by the MIDI
scripts (.venv-midi) alike.
"""

from __future__ import annotations

import base64
import struct
from typing import NamedTuple, Optional

PRST_LEN = 552  # GP-50 (the default device); GP-5 is 507 — see DEVICES below
BODY_LEN = 511  # GP-50 body (PRST_LEN - BODY_OFF)

HEADER = bytes.fromhex("47502d3530000000000000000000000000000100")  # GP-50 [0x00:0x14]
CRC_OFF = 0x14
SENTINEL = b"\xff\xff\xff\xff"  # [0x15:0x19]
NAME_OFF = 0x19
NAME_LEN = 16
BODY_OFF = 0x29  # NAME_OFF + NAME_LEN

REC_MODELS = bytes([0x03, 0x30, 0x28, 0x00])
REC_BYPASS = bytes([0x01, 0x30, 0x04, 0x00])
REC_ORDER = bytes(
    [0x02, 0x30, 0x0A, 0x00]
)  # 10-byte chain-order permutation (re/DEVICE_BLOCKORDER.md)
REC_PARAMS = bytes([0x04, 0x30, 0x40, 0x01])
FS_TRAILER = bytes(
    [0x03, 0x00, 0x0A, 0x00]
)  # GP-50 trailer magic (GP-5 is 03 00 08 00)
SETTINGS_OFF = (
    0x55  # first group-0x20 patch-settings record (same offset on both devices)
)

N_BLOCKS = 10
N_PARAM_SLOTS = 80  # N_BLOCKS x 8


# --- device profiles ----------------------------------------------------------
# The GP-5 and GP-50 share this .prst container, the SysEx protocol, and the
# effect catalog (GP-5's catalog is a strict subset of the GP-50's). The three
# things that differ per device are captured here: the 20-byte header, the total
# file length, and the 4-byte device tag inside the 0xFF block. Everything else
# (record magics, CRC, name codec, the 390-byte 0x02 tone block) is identical, so
# the parsing functions below are already device-agnostic.
#
# GP-150 is NOT a variant of this container (different header bytes, no
# CRC-8/0x07, name at a different offset — see re/DEVICE_GP150.md) but shares
# the same *shape* of problem: a device identified by header/length, with its
# own name offset. name_off/name_len live on the profile (not the module-level
# NAME_OFF/NAME_LEN, which stay as the GP-5/GP-50 default) so a
# differently-shaped device can be expressed. (Earlier docs/code called
# GP-150 "header-less" — wrong, corrected 2026-08-22: all 200 corpus files and
# 3 independent live captures start with the same 4 bytes, see HEADER_GP150.
# The `header: bytes` field and detect()'s empty-header skip stay as-is since
# a genuinely header-less device may exist someday; GP-150 just isn't one.)
# GP-150's body records (per-module param floats, chain order, ...) are NOT
# expressed here — they don't fit this file's magic-record model at all, and
# live in the separate, read-only patch/gp150_format.py instead. This file's
# body-record functions (model_records, bypass_mask, param_floats, ...) and
# rebuild()/device_write.py remain GP-5/GP-50-only; nothing here makes them
# work for GP-150, and none of them are called with the GP150 profile.

HEADER_GP50 = HEADER
HEADER_GP5 = bytes.fromhex("47502d3500000000000000000000000000000100")  # "GP-5\0"
# Confirmed 2026-08-22 against all 200 export-corpus files AND 3 independent
# live-captured bodies (re/gp150_captures/wake_replay/, wake_select_read/):
# not ASCII (unlike GP-5/GP-50's ["GP-5\0"/"GP-50\0"] headers), which is
# likely why it wasn't recognized as a header earlier and GP-150 was
# documented as "header-less" instead. The check was prompted by an external
# writeup a user found (a gist, github.com/AlbertoBarba) claiming the same 4
# bytes at the same offset, but verified here independently against this
# project's own corpus/captures, not taken on the gist's word — see
# design/GP150_SUPPORT.md for what else from that writeup was cross-checked.
HEADER_GP150 = bytes.fromhex("11306404")
DEVTAG_GP50 = bytes.fromhex("47503530")  # "GP50", 0xFF-block bytes [12:16]
DEVTAG_GP5 = bytes.fromhex("0a454d51")  # GP-5 device signature


class DeviceProfile(NamedTuple):
    key: str  # stable id: "gp50" | "gp5" | "gp150"
    name: str  # display / factory-default patch name: "GP-50" | "GP-5" | "GP-150"
    header: bytes  # fixed header ([0x00:len(header)]); all three known devices
    # have one now (GP-150's added 2026-08-22). b"" stays supported for a
    # genuinely header-less profile — detect() then relies on length alone,
    # never on a trivial empty-slice match — but nothing currently uses it.
    prst_len: int  # full .prst byte length
    devtag: bytes  # 4-byte tag inside the 0xFF block; b"" = unconfirmed/not
    # applicable (GP-150's live wire protocol isn't cracked — re/DEVICE_GP150.md)
    ring_file: str  # model catalog filename under patch/
    midi_port: str  # rtmidi port-name match for the live device
    usb_pid: Optional[int]  # USB idProduct (vendor is 0x84EF on GP-5/GP-50);
    # None = unconfirmed (GP-150/180's VID/PID — GP150-5 in BACKLOG_GP150.md)
    name_off: int = NAME_OFF  # defaults to the GP-5/GP-50 shared offset (0x19)
    name_len: int = NAME_LEN  # defaults to the GP-5/GP-50 shared width (16)

    @property
    def body_off(self) -> int:
        return self.name_off + self.name_len

    @property
    def body_len(self) -> int:
        return self.prst_len - self.body_off


GP50 = DeviceProfile(
    "gp50", "GP-50", HEADER_GP50, 552, DEVTAG_GP50, "fxid_ring.json", "GP-50", 0x018A
)
GP5 = DeviceProfile(
    "gp5", "GP-5", HEADER_GP5, 507, DEVTAG_GP5, "fxid_ring_gp5.json", "GP-5", 0x0184
)
GP150 = DeviceProfile(
    "gp150",
    "GP-150",
    HEADER_GP150,  # confirmed 2026-08-22 — see re/DEVICE_GP150.md
    1128,
    b"",  # devtag unconfirmed
    "fxid_ring_gp150.json",
    "GP-150",  # confirmed live (this session) — the device enumerates as this
    None,  # USB VID/PID unconfirmed
    name_off=0x2C,
    name_len=13,  # confirmed 2026-07-31: a 16-char input truncates to exactly
    # 13 on the device (re/DEVICE_GP150.md) — the real field limit
)
DEVICES = {p.key: p for p in (GP50, GP5, GP150)}


def profile_for(key: str) -> DeviceProfile:
    try:
        return DEVICES[key]
    except KeyError:
        raise ValueError(f"unknown device {key!r} (known: {sorted(DEVICES)})")


# Factory-default empty preset ("GP-50" blank), captured verbatim from the
# device's own empty slots — all 23 empty factory slots on a real GP-50 are
# byte-identical, so this is the one canonical blank. Slot-independent (the
# slot is a write-time argument, not stored in the .prst). Mirrors
# app/static/prst.js's BLANK_B64/blankPrst() byte-for-byte — same captured
# constant, kept in sync deliberately, not two independent "blanks".
BLANK_B64 = {
    "gp50": "R1AtNTAAAAAAAAAAAAAAAAAAAQCv/////0dQLTUwAAAAAAAAAAAAAAD/ABAAAQAEAAEAAAACAAQAR1A1MAAAEAABEAQACgAAAAIQBAAIAAAAAQA7AAEgAQAyAiAEAHgAAAADIAEAAAQgBAAAAAAABSAEAGQAAAAGIAEAAAcgAQAACCABAGQJIAEAAAogAQAAAgCGAQEwBAAAAAAAAjAKAAABAgkDBAUGBwgDMCgAGwAAAAAAAAAAAAADAQAABwEAAAo1AAABAAAABAAAAAsLAAAMAAAADwQwQAEAAKBBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoEEAAEhCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgQgAAjEIAAEhCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPBBAABIQgAASEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAASEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEhCAAAAAAAAAAAAAEhCAAAAPwAASEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoEEAAPpDAADwQQAAAAAAAAAAAAAAAAAAAAAAAAAAAADwQQAAAAAAAEhCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEhCAABIQgAASEIAAEhCAABIQgAAAAAAAAAAAAAAAAMACgAAAAAAAAAAAAUF",
}


def blank_patch(key: str = "gp50") -> bytes:
    """A fresh copy of the factory-default blank .prst for device `key`."""
    b64 = BLANK_B64.get(key)
    if not b64:
        raise ValueError(f"no factory blank preset for device {key!r}")
    return base64.b64decode(b64)


def detect(prst: bytes) -> DeviceProfile:
    """Identify a .prst's device from its header (then length as a fallback).
    Profiles with no header (b"") are skipped in the header pass — an empty
    slice trivially equals b"", so checking it would wrongly match everything."""
    for p in DEVICES.values():
        if p.header and prst[: len(p.header)] == p.header:
            return p
    for p in DEVICES.values():
        if len(prst) == p.prst_len:
            return p
    raise ValueError(f"unrecognized .prst (len {len(prst)}, header {prst[:6].hex()})")


# --- CRC (shared by the file format and the SysEx wire packets) ---------------


def crc8(data, init: int = 0) -> int:
    """CRC-8, poly 0x07 (CRC-8/SMBUS), no reflection, no final XOR."""
    c = init
    for b in data:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


def refix_crc(b: bytearray) -> None:
    """Recompute the file CRC in place after any body/name edit."""
    b[CRC_OFF] = crc8(bytes(b[CRC_OFF + 1 :]))


def check_length(prst: bytes, profile: Optional[DeviceProfile] = None) -> None:
    """Validate a .prst's length. With no profile, accept any known device;
    with one, require exactly that device's length."""
    if profile is not None:
        if len(prst) != profile.prst_len:
            raise ValueError(
                f"expected a {profile.prst_len}-byte {profile.name} .prst, "
                f"got {len(prst)}"
            )
        return
    detect(prst)  # raises ValueError if the length/header matches no known device


# --- name codec ----------------------------------------------------------------


def read_name(prst: bytes, profile: Optional[DeviceProfile] = None) -> str:
    """Defaults to the GP-5/GP-50 shared name offset; pass profile=GP150 (or
    any device) to use its own name_off/name_len instead."""
    off = profile.name_off if profile is not None else NAME_OFF
    length = profile.name_len if profile is not None else NAME_LEN
    return prst[off : off + length].split(b"\0")[0].decode("latin1", "replace").strip()


def write_name(b: bytearray, name: str, profile: Optional[DeviceProfile] = None) -> None:
    """Overwrite the name region in place (does NOT refix the CRC). Same
    profile-optional default as read_name."""
    off = profile.name_off if profile is not None else NAME_OFF
    length = profile.name_len if profile is not None else NAME_LEN
    b[off : off + length] = name.encode("latin1", "replace")[:length].ljust(
        length, b"\0"
    )


def rebuild(name: str, body: bytes, profile: DeviceProfile = GP50) -> bytes:
    """Full .prst from a device read: name (0x40 read) + body (0x41). Defaults to
    GP-50; pass profile=GP5 for a 466-byte GP-5 body.

    GP-5/GP-50 only — this assumes a fixed header + FF-sentinel + name + body
    shape that GP-150 doesn't have (no header, no known checksum scheme, no
    verified write protocol at all). Do not pass profile=GP150 here; there is
    no GP-150 writer yet (re/DEVICE_GP150.md, patch/gp150_format.py)."""
    if len(body) != profile.body_len:
        raise ValueError(
            f"expected a {profile.body_len}-byte {profile.name} body, got {len(body)}"
        )
    out = bytearray(profile.header + b"\x00" + SENTINEL + b"\0" * NAME_LEN + body)
    write_name(out, name)
    refix_crc(out)
    return bytes(out)


# --- body records ----------------------------------------------------------------


def models_offset(b: bytes) -> int:
    """Offset of the first model record (after the REC_MODELS magic), or -1."""
    i = b.find(REC_MODELS)
    return i + 4 if i >= 0 else -1


def model_records(b: bytes) -> list:
    """The 10 per-block model records as (idx, cat, fxlow):
    idx = b0 (slot/index for N->S and AMP), cat = category byte, fxlow = the
    3-byte little-endian model index. fxid = (cat << 24) | fxlow."""
    base = models_offset(b)
    if base < 0:
        return []
    out = []
    for k in range(N_BLOCKS):
        r = b[base + k * 4 : base + k * 4 + 4]
        fxlow = r[0] | (r[1] << 8) | (r[2] << 16)
        out.append((r[0], r[3], fxlow))
    return out


def model_rec_offset(b: bytes, category: int) -> Optional[int]:
    """Offset of the 4-byte model record whose category matches, or None."""
    base = models_offset(b)
    if base < 0:
        return None
    for k in range(N_BLOCKS):
        if b[base + k * 4 + 3] == category:
            return base + k * 4
    return None


def bypass_mask(b: bytes) -> int:
    """u32 bitmask: bit k = block k active (BLOCK_NAMES order)."""
    i = b.find(REC_BYPASS)
    return struct.unpack_from("<I", b, i + 4)[0] if i >= 0 else 0


def bypass_offset(b: bytes) -> int:
    """Offset of the bypass u32 (after the REC_BYPASS magic), or -1."""
    i = b.find(REC_BYPASS)
    return i + 4 if i >= 0 else -1


def order_offset(b: bytes) -> int:
    """Offset of the 10-byte chain-order record (after REC_ORDER magic), or -1."""
    i = b.find(REC_ORDER)
    return i + 4 if i >= 0 else -1


def read_order(b: bytes) -> list:
    """Chain (signal-path) order: order[chain_pos] = model-record index there.
    Records stay in fixed storage order; only this permutes. Missing -> identity."""
    o = order_offset(b)
    if o < 0:
        return list(range(N_BLOCKS))
    return list(b[o : o + N_BLOCKS])


def is_permutation(order) -> bool:
    return (
        order is not None
        and len(order) == N_BLOCKS
        and sorted(int(x) for x in order) == list(range(N_BLOCKS))
    )


def write_order(b: bytearray, order) -> None:
    if not is_permutation(order):
        raise ValueError(f"chain order must be a permutation of 0..{N_BLOCKS - 1}")
    o = order_offset(b)
    if o < 0:
        raise ValueError("patch has no chain-order record")
    for i in range(N_BLOCKS):
        b[o + i] = int(order[i])


def param_floats(b: bytes) -> list:
    """The 80-float parameter array: floats[block_index*8 + algId]."""
    i = b.find(REC_PARAMS)
    if i < 0:
        return [0.0] * N_PARAM_SLOTS
    return list(struct.unpack_from(f"<{N_PARAM_SLOTS}f", b, i + 4))


def params_offset(b: bytes) -> int:
    """Offset of the first param float (after the REC_PARAMS magic), or -1."""
    i = b.find(REC_PARAMS)
    return i + 4 if i >= 0 else -1


FS_TRAILER_GP5 = bytes([0x03, 0x00, 0x08, 0x00])  # GP-5 trailer (8-byte payload)


def fs_offset(b: bytes) -> int:
    """Offset of the footswitch mask pair ([FS1 u32][FS2 u32]) in the trailer.
    Handles both the GP-50 (10-byte) and GP-5 (8-byte) trailer records."""
    for magic in (FS_TRAILER, FS_TRAILER_GP5):
        i = b.rfind(magic)
        if i >= 0:
            return i + 4
    return -1
