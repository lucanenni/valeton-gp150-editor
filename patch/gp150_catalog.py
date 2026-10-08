"""GP-150 catalog/info SysEx replies — everything from Suite's startup
handshake OTHER than the active-patch body (that one's `gp150_wire.
reassemble_body()` + `gp150_format.decode()`).

Suite's full startup sync is 7 request/reply pairs, request category
incrementing 0x00..0x06, reply category = request category + 0x29 always
(design/GP150_SUPPORT.md §3.2 summarizes it):

| Req  | Reply content                                          | Decoder here |
|------|---------------------------------------------------------|--------------|
| 0x00 | ack/version, no ASCII, not decoded                       | —            |
| 0x01 | the active patch body (1136 B: 8-byte prefix + 1128 B)   | gp150_wire/gp150_format |
| 0x02 | **all 200 patch names** (4012 B)                         | `decode_all_names()` |
| 0x03 | small settings block (144 B), no ASCII, not decoded      | —            |
| 0x04 | firmware version string (408 B) — e.g. `"V1.1.1"`        | (extract printable ASCII; see below) |
| 0x05 | **User IR list** (412 B, 20 entries)                     | `decode_user_irs()` |
| 0x06 | **SnapTone catalog** (2032 B, 101 entries)               | `decode_snaptones()` |

**Confirmed live 2026-09-03** (all 6 non-body categories run for the first
time against the real pedal, via `patch/gp150_read_catalog.py CATEGORY`):
0x02, 0x05, and 0x06 all share the exact same record format —
a 12-byte header (unidentified) then N x 20-byte records, each a
little-endian u32 index + a 16-byte null-padded ASCII/latin1 name, where N
falls out of the reply's total length (200/20/101 respectively, not
hardcoded per category except as a sanity check for `decode_all_names()`).
`decode_indexed_records()` is the shared decoder; `decode_all_names()`/
`decode_user_irs()`/`decode_snaptones()` are thin category-specific
wrappers (the first also enforces the expected count of 200).

- **Names** (0x02): verified against all 200 real corpus files, both
  offline (from `startup_sequence.mmon`'s own reply chunks) and live —
  0 mismatches either way (the offline run's apparent mismatches were
  just Suite's own filename sanitization on export, not a decode issue).
  See `app/tests/test_gp150_catalog.py`.
- **User IRs** (0x05): 20 entries, indices `65536..65555` (`0x10000 +
  n`) — the high 16 bits look like a category tag distinguishing this
  from the plain 0-based patch-name indices, not a bug. Names are exactly
  `"User IR 1"`.."User IR 20"` (the design doc's earlier "7+" guess, from
  eyeballing a truncated printable-ASCII scan, undercounted).
- **SnapTones** (0x06): 101 entries — index 0 `"None"`, 1-50 the real
  factory library (matches the manual's Factory SnapTone list, p.74-75:
  `"Dark CL"`, `"Band CL"`, `"Match 35 CL"`, ... down to bass amps like
  `"SBE BASS"`), then 50 more at indices `65587..65636` (`0x10033 + n`,
  a *different* base than the User IR category tag, but the same
  "high bits = category" idea) named `"Empty 1"`.."Empty 50"` — the user
  SnapTone slots, unpopulated on this device.

Evidence for all three: `re/gp150_captures/catalog_live/` (`.dat`, not
`.bin` — `*.bin` is gitignored).

**0x03 (settings) and 0x04 (firmware) are NOT decoded** — different shape
from the three above, no record-layout work done:
- 0x04's reply also starts with what looks like the same kind of 12-byte
  header, then an ASCII version string (`"V1.1.1"`, confirmed live —
  differs from the design doc's earlier-noted `"V1.0.5"`, almost
  certainly just this pedal's firmware having been updated since that
  capture, not a decode bug) null-padded to what looks like a 16-byte
  field (matching the same record shape as the other three!), followed by
  ~380 bytes of mixed content, some of it plausibly float32 LE (e.g. a
  `42 48 00 00`-style run reads as `50.0f`) — not pinned down further.
- 0x03's reply has no printable ASCII at all and no obvious record
  boundary tried yet.
"""

from __future__ import annotations

INDEXED_RECORD_HEADER_LEN = 12
INDEXED_RECORD_LEN = 20
ALL_NAMES_COUNT = 200


def decode_indexed_records(stream: bytes) -> list:
    """Shared decoder for the 3 catalog replies confirmed to share this
    record shape (all 200 patch names, User IR list, SnapTone catalog):
    a 12-byte header (unidentified) then N x 20-byte records, each a
    little-endian u32 index + a 16-byte null-padded name — N derived from
    `stream`'s length, not hardcoded. Returns `[(index, name), ...]` in
    stream order. Raises ValueError if the stream is shorter than one
    header or the remainder isn't a whole number of records."""
    if len(stream) < INDEXED_RECORD_HEADER_LEN:
        raise ValueError(f"stream is {len(stream)} bytes, shorter than the {INDEXED_RECORD_HEADER_LEN}-byte header")
    body = stream[INDEXED_RECORD_HEADER_LEN:]
    n, rem = divmod(len(body), INDEXED_RECORD_LEN)
    if rem:
        raise ValueError(
            f"{len(body)} bytes after the header isn't a whole number of "
            f"{INDEXED_RECORD_LEN}-byte records (remainder {rem})"
        )
    out = []
    for i in range(n):
        rec = body[i * INDEXED_RECORD_LEN : (i + 1) * INDEXED_RECORD_LEN]
        idx = rec[0] | (rec[1] << 8) | (rec[2] << 16) | (rec[3] << 24)
        name = rec[4:20].split(b"\0")[0].decode("latin1", "replace").strip()
        out.append((idx, name))
    return out


def decode_all_names(stream: bytes) -> list:
    """`stream` = the fully reassembled + nibble-decoded reply to the "all
    200 patch names" request (`gp150_wire.reassemble_first_burst_stream()`
    on the category-0x02-reply's chunks). Same as `decode_indexed_records()`
    but also enforces the expected count of 200 patches."""
    records = decode_indexed_records(stream)
    if len(records) != ALL_NAMES_COUNT:
        raise ValueError(f"expected {ALL_NAMES_COUNT} names, got {len(records)}")
    return records


def decode_user_irs(stream: bytes) -> list:
    """`stream` = the reassembled reply to the User IR list request
    (category 0x05). Confirmed live 2026-09-03: 20 entries, indices
    `0x10000 + n`, names `"User IR 1"`.."User IR 20"`."""
    return decode_indexed_records(stream)


def decode_snaptones(stream: bytes) -> list:
    """`stream` = the reassembled reply to the SnapTone catalog request
    (category 0x06). Confirmed live 2026-09-03: 101 entries — `"None"` +
    50 factory SnapTones (indices 0-50), then 50 empty user slots
    (indices `0x10033 + n`, named `"Empty 1"`.."Empty 50"`)."""
    return decode_indexed_records(stream)
