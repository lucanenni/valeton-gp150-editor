# SnapTone/"Clone" upload -- wire format cracked, 2026-09-29

Built on the 2026-09-24 SnapTone capture (`../snaptone_upload_2026-09-24/`): that session had decoded the
outer wire chunking and most of the `LibraryStruct` envelope but never turned it into a tested encoder.
The two derived artifacts of this pass (the 8228-byte reassembled stream and the 2696 bytes of the
embedded `.clo`) carried the third-party profile, so they are not in the repository either; the tests use
a synthetic `.clo` (`app/tests/fixtures/gp150_synth_device.clo`) and a golden shared by the Python and JS
encoders (`app/tests/fixtures/gp150_upload_golden.json`). With `GP150_CAPTURES_DIR` set they also check
the real files.

**Implemented and verified in `patch/gp150_snaptone_upload.py`** (and the JS twin):
`build_clone_upload_chunks(target_slot, name, clo_bytes)` reproduced all 70 of the real capture's chunks
byte-for-byte, using only formulas already proven elsewhere in this project:
- Outer per-chunk MIDI header: the same `compute_wire_tag()` CRC-8 used everywhere else, over a 2-byte
  7-bit-pair total-length/offset header (same shape as GP150-13's full-preset write, category `0x08`
  instead of `0x07`).
- Inner content prefix: `crc8(prefix[4:8] + body)`, the formula GP150-13's write-preset prefix uses.
- The `LibraryStruct` body has no checksum of its own: a plain positional struct (type marker, constant
  length, target slot, a 4-byte echo of its own header, a 16-byte name, then the `.clo` bytes truncated
  to 2696 and zero-padded to the fixed 8192-byte slot).

**Live-confirmed** 2026-09-30: a `.clo` written to a chosen SnapTone slot is accepted and read back
correctly (SnapTone slots are a shared catalog, so the user always picks the slot).

This only writes an already-produced `.clo`; building one from audio or a NAM model is
`app/static/amp_profiler.js`.
