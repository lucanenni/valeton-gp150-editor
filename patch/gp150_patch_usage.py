"""Decode which SnapTone/NAM/User-IR slot (if any) a GP-150 patch body
references -- the piece the Captures & IRs page's "used by" cross-reference
needs, which never existed for GP-150 because it's derived from a live
device SCAN (gp150_scan_bank.py), not the imported-.prst inventory GP-50
uses (that's `patchlib.py`; this module is its GP-150 analog, deliberately
tiny since the only two modules that ever point at those catalogs are N->S
and CAB).

The N->S ("NS" in gp150_format.MODULE_NAMES) and CAB modules' own `fxid`
values decompose the same way every other GP-150 fxid does (confirmed
GP150-6, [MM, 0, T1, T2] big-endian-looking bytes packed into one u32) --
but MM here isn't a *module* id, it's which CATALOG that module's model
comes from:

  N->S module:  MM=0x0f (15) -> SnapTone catalog, T2 = 0-based slot
                MM=0x10 (16) -> NAM catalog,      T2 = 0-based slot
                anything else -> a factory NS algorithm assigned directly,
                not a reference into either catalog at all
  CAB module:   MM=0x0a (10) and the next byte ("B2") == 0x10 -> User IR,
                T2 = 0-based slot
                MM=0x0a and B2 == 0 -> a factory cab, not a User IR

Cross-checked against `patch/fxid_ring_gp150.json`'s own real entries
(module "N->S": MM 15 = "Dark CL".."Empty 50" then MM 16 = "NAM Slot
1".."NAM Slot 20"; module "CAB": MM 10/B2 0 = factory cabs, MM 10/B2 16 =
"User IR 1".."User IR 20", both T2 0-based) and validated live against 4
real captured .prst bodies already in this repo (device_scan_gp150/,
re/gp150_captures/param_edits/200-Its GP150_NS.prst -- the last one's own
filename already asserts what it should decode to, and it does: SnapTone
slot 3), 2026-09-27. Slots returned here are literal 1-based, matching
webmidi_gp150.js's own sendNamUpload()/readSnaptones() conventions (NOT
the 0-based convention IR *uploads* use -- see catalogCard()'s own
+1-for-IR-only comment for why those two differ on the wire).
"""

from __future__ import annotations

from patch import gp150_format as fmt


def _decompose(fxid: int) -> tuple[int, int, int, int]:
    return (fxid >> 24) & 0xFF, (fxid >> 16) & 0xFF, (fxid >> 8) & 0xFF, fxid & 0xFF


def decode_usage(prst: bytes) -> dict:
    """Returns {snaptone_slot, nam_slot, user_ir_slot}, each a literal
    1-based int or None. A patch can reference at most one of
    snaptone_slot/nam_slot (they share the one N->S module) and
    independently at most one user_ir_slot (the CAB module)."""
    ns_mm, _ns_b2, _ns_t1, ns_t2 = _decompose(fmt.read_module_model(prst, "NS"))
    cab_mm, cab_b2, _cab_t1, cab_t2 = _decompose(fmt.read_module_model(prst, "CAB"))
    return {
        "snaptone_slot": ns_t2 + 1 if ns_mm == 0x0F else None,
        "nam_slot": ns_t2 + 1 if ns_mm == 0x10 else None,
        "user_ir_slot": cab_t2 + 1 if (cab_mm == 0x0A and cab_b2 == 0x10) else None,
    }
