# Full preset write -- 2026-09-27

Live capture of Valeton Suite's own "select all -> import from file"
preset-browser action, importing a real "Foxy Clean" `.prst` into slot 190
(human-numbered; 189 zero-based) on a real GP-150. Captured on Suite's own
outgoing MIDI.

This is the write-direction sibling of the read-side full-body fetch: same
8-byte chunk header + nibble payload wire scheme as everything else in this
project, just large enough (1136 bytes total) that the header's
length/offset fields need the 2-byte 7-bit-pair encoding instead of the
single byte this project's smaller writes (`build_dataComm*` in
`webmidi_gp150.js`) get away with.

`reassembled_stream.raw`: the exact 1136-byte reassembled write stream (an
8-byte "write preset" prefix + the full 1128-byte body), decoded via
`wire.nibbles_to_bytes()` on the 10 real chunks (category `0x07`, 0-based
chunk index 0-9, `wire.compute_wire_tag()` verified to reproduce every
chunk's own header tag byte exactly).

`004-Foxy Clean.prst`: the real, un-modified factory "Foxy Clean" `.prst`
(GP-150 index 3), used as the pre-import reference to diff against the
transmitted stream. Two real diffs found: offset 4 (the patch index, 3 ->
189, the whole point of the write) and offset 0x0A (a byte already known
from GP150-6's write-path work to be "transient during transfer" -- the
device overwrites/ignores it on store, confirmed again here since it's the
ONLY other byte that changed). Critically, the body's OWN 0x0E-0x0F
checksum (GP150-2, still uncracked in general) is IDENTICAL in both files
-- proof it does not depend on the slot index, so an existing valid body
can be written to a different slot verbatim without solving GP150-2.

The write-prefix's own tag byte (`reassembled_stream.raw[1]`) is
content-dependent: `crc8(prefix[4:8] + body)`, the same CRC-8 (poly 0x31)
already used throughout this project's write path -- verified exact
against this capture in `patch/gp150_write_preset.py`.

**Independently verified live the same day**: built a NEW write (different
source content -- "Finger Bass" -- and a different target slot, 195
zero-based / 196 human) from scratch using only `patch/
gp150_write_preset.py`, sent directly (Suite closed), and the user
confirmed the pedal's own preset browser shows "Finger Bass" at slot 196.
