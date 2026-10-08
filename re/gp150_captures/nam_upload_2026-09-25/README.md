GP150-9 NAM upload, second real capture, 2026-09-25 — used to isolate the "hash" header field (see
BACKLOG_GP150.md's GP150-9 entry).

`raw_midi_out_capture.txt` (not in the repository: it carries a third-party NAM model; see
`../ir_snaptone_nam_upload_2026-09-24/README.md` for how the tests cope) captured Suite importing a
compatible "lite" NAM model to slot 1: same architecture as the first capture (magic, total_len=7980,
weights_offset=496, weights_count=1871, the same unexplained 413 field, all byte-identical) and a
different hash field (0x70355f5f vs 0x9552f2ca). That showed the field is content-dependent; it turned
out to be a CRC-32 over the header and weights that skips the hash field's own four bytes (see
`webmidi_gp150.js`).
