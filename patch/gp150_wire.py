"""GP-150 live SysEx read protocol — reassembling a streamed patch body.

Cracked 2026-07-31 from two MIDI-Monitor captures (`re/gp150_captures/
patch_1_open.mmon`, `bankpc_10_select.mmon`) against the known-good 200-file
export corpus (kept outside the repo, see app/tests/gp150_corpus.py). Findings:
`design/GP150_SUPPORT.md` §3.2. Spec: `re/DEVICE_GP150.md`.

**Read-only, and NOT yet exercised against live hardware by this code** — it
was derived and verified entirely from captured traffic, reproducing the
corpus byte-for-byte offline. A live capture (MIDI Monitor, or a future
mido-based tool) still needs to feed this to prove it end-to-end on a fresh
read, but the reassembly math itself is confirmed against 5 independent real
patches (New GEN, Morse Purple, Match OD, UK900 DIST, Dark Clean — 8 burst
decodes total, all exact matches). See GP150-5 in BACKLOG_GP150.md.

## What was found

The device streams a patch body as a category-tagged, multi-chunk SysEx
reply (see `gp150_probe.py`'s docstring for how a read is triggered: CC0+PC
select is enough, no request-side SysEx needed). Each chunk, as delivered by
mido/CoreMIDI (i.e. already stripped of the F0/F7 SysEx framing), has an
**8-byte per-chunk header** (category byte at index 6, 1-based chunk index at
index 7 — both float/observed, not confirmed field-by-field) followed by a
**nibble-encoded payload**: every payload byte is 0-15, one nibble per byte,
high nibble first — exactly GP-50's `to_wire_data`/`nib_decode` scheme
(`patch/live_read.py`), just wrapped in a different per-chunk header. An
earlier reading of this data mistook the per-chunk header bytes (which do
exceed 0x0F) for the actual nibble stream and wrongly concluded GP-150 uses a
different wire encoding than GP-5/GP-50 — it doesn't; only the container
format differs (see `re/DEVICE_GP150.md`), the wire codec is the same idea.

Concatenating chunks 1..N's payloads (after stripping each chunk's 8-byte
header) and nibble-decoding the result gives **an 8-byte prefix + the exact
1128-byte `.prst` body, byte-for-byte** — confirmed against the real export
corpus for 5 different patches. The prefix (`01 XX 6c 04 03 03 11 30` in
every capture so far, only byte 1 varying per patch) is NOT understood yet —
byte 1 looks content-dependent (candidate: a transmission-level checksum)
but doesn't match the file's own still-uncracked `0x0E-0x0F` field by any
simple relation tried. Not blocking: it's just skipped.
"""

from __future__ import annotations

from patch import prst_format as fmt

CHUNK_HEADER_LEN = 8  # bytes before a chunk's nibble payload starts
CHUNK_CATEGORY_IDX = 6  # offset within a chunk of the category tag
CHUNK_INDEX_IDX = 7  # offset within a chunk of the 1-based chunk index
BODY_PREFIX_LEN = 8  # bytes before the .prst body starts, in the decoded stream


def nibbles_to_bytes(nibbles: bytes) -> bytes:
    """Pair up (hi, lo) nibbles into bytes — same scheme as live_read.nib_decode,
    just operating on already-concatenated payload instead of a raw MIDI reply."""
    n = len(nibbles) - (len(nibbles) % 2)
    return bytes((nibbles[i] << 4) | nibbles[i + 1] for i in range(0, n, 2))


def bytes_to_nibbles(data: bytes) -> bytes:
    """Inverse of nibbles_to_bytes(): split each byte into (hi, lo) nibbles,
    high nibble first. Needed for the write direction (GP150-6's set-param/
    save messages), which use the same nibble-per-byte payload scheme as
    every read/write chunk."""
    out = bytearray(len(data) * 2)
    for i, b in enumerate(data):
        out[2 * i] = (b >> 4) & 0xF
        out[2 * i + 1] = b & 0xF
    return bytes(out)


def group_chunks(messages: list) -> dict:
    """`messages` = raw chunk byte-sequences (as captured/received, each with
    the 8-byte per-chunk header intact) for ONE category. Returns
    {chunk_index: payload_nibbles}, last-seen wins for a repeated index
    (matches what was observed: duplicate transmissions of the same content)."""
    out = {}
    for m in messages:
        if len(m) <= CHUNK_HEADER_LEN:
            continue
        idx = m[CHUNK_INDEX_IDX]
        out[idx] = m[CHUNK_HEADER_LEN:]
    return out


def reassemble_stream(messages: list) -> bytes:
    """Chunk messages (one burst, any order, duplicates OK) -> the full
    decoded nibble stream, whatever length it turns out to be. No
    assumption about a fixed body length or an 8-byte prefix to strip —
    `reassemble_body()` below is just this plus the active-patch-specific
    framing. Use this directly for the OTHER SysEx categories in Suite's
    startup handshake (bulk patch names, firmware version, User IR list,
    SnapTone catalog — see re/DEVICE_GP150.md and patch/gp150_catalog.py),
    whose replies aren't an 8-byte-prefix + 1128-byte-body shape. Raises
    ValueError if the chunks don't cover a contiguous 1..N run."""
    chunks = group_chunks(messages)
    if not chunks:
        raise ValueError("no chunks given")
    n = max(chunks)
    missing = [i for i in range(1, n + 1) if i not in chunks]
    if missing:
        raise ValueError(f"missing chunk indices: {missing}")
    nibbles = b"".join(chunks[i] for i in range(1, n + 1))
    return nibbles_to_bytes(nibbles)


def reassemble_body(messages: list) -> bytes:
    """Full pipeline: chunk messages (all the same category, any order,
    duplicates OK) -> the exact 1128-byte GP-150 `.prst` body. Raises
    ValueError if the chunks don't cover a contiguous 1..N run or the
    decoded length doesn't match a body + the known prefix.

    Assumes `messages` is ONE burst (a single 1..N transmission, possibly
    with duplicate re-sends of the same chunk). If more than one burst may
    have landed in the same capture/listen window, use `split_bursts()` +
    `reassemble_first_burst()` instead — this function's chunk-index dict
    applies a blind last-message-wins merge, which silently produces a
    corrupted decode if a later, unrelated or truncated burst overwrites an
    earlier burst's chunk at the same index with fewer bytes (observed
    live 2026-08-22, see gp150_wake_select_read.py)."""
    decoded = reassemble_stream(messages)
    if len(decoded) < BODY_PREFIX_LEN + fmt.GP150.prst_len:
        raise ValueError(
            f"decoded {len(decoded)} bytes, need at least "
            f"{BODY_PREFIX_LEN + fmt.GP150.prst_len} (prefix + full body)"
        )
    return decoded[BODY_PREFIX_LEN : BODY_PREFIX_LEN + fmt.GP150.prst_len]


def split_bursts(messages: list) -> list:
    """Split one category's raw chunk messages (arrival order, header
    intact, as accumulated over a whole listen window) into separate
    bursts. A new burst starts whenever chunk index 1 recurs after a
    higher index has already been seen in the current one.

    Real devices/listen windows can deliver more than one burst back to
    back — e.g. a device already "woken" auto-pushes on a plain CC0+PC
    select, then replies again to an explicit fetch request sent shortly
    after (confirmed live 2026-08-22, gp150_wake_select_read.py) — and
    `reassemble_body()` alone has no way to tell them apart; this does.
    Mirrors the `_bursts_from_capture()` helper `app/tests/test_gp150_wire.py`
    already used, informally, to make sense of `.mmon` captures."""
    bursts, cur, seen_gt1 = [], [], False
    for m in messages:
        if len(m) <= CHUNK_HEADER_LEN:
            continue
        idx = m[CHUNK_INDEX_IDX]
        if idx == 1 and seen_gt1:
            bursts.append(cur)
            cur, seen_gt1 = [], False
        cur.append(m)
        if idx > 1:
            seen_gt1 = True
    if cur:
        bursts.append(cur)
    return bursts


def reassemble_first_burst(messages: list) -> bytes:
    """`split_bursts()` + return the first burst that `reassemble_body()`
    decodes cleanly, ignoring any bursts before or after it (stray
    duplicates, truncated re-sends, etc). Raises ValueError (with every
    burst's own error folded in) if none decode."""
    errors = []
    for i, burst in enumerate(split_bursts(messages)):
        try:
            return reassemble_body(burst)
        except ValueError as e:
            errors.append(f"burst {i + 1} ({len(burst)} msgs): {e}")
    raise ValueError(
        f"no burst reassembled cleanly out of {len(errors)}: " + "; ".join(errors)
    )


def reassemble_first_burst_stream(messages: list) -> bytes:
    """Same idea as `reassemble_first_burst()`, but for `reassemble_stream()`
    — no fixed-length/prefix assumption. Use for the non-body SysEx
    categories (see `reassemble_stream()`)."""
    errors = []
    for i, burst in enumerate(split_bursts(messages)):
        try:
            return reassemble_stream(burst)
        except ValueError as e:
            errors.append(f"burst {i + 1} ({len(burst)} msgs): {e}")
    raise ValueError(
        f"no burst reassembled cleanly out of {len(errors)}: " + "; ".join(errors)
    )
