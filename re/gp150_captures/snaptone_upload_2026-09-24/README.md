GP150-9 SnapTone re-capture, 2026-09-24, with a definitively known source file.

`raw_midi_out_capture.txt` (not in the repository: it carries a third-party SnapTone profile; see
`../ir_snaptone_nam_upload_2026-09-24/README.md` for how the tests cope) captured Suite's outgoing MIDI
while a third-party `.nam` was imported to library slot 51 — a single, unambiguous import, the name
confirmed inside the decoded struct and the target slot confirmed as the literal (non-decremented) value
51.

It established that the meaningful payload is a fixed 2696 bytes regardless of the source amp, that the
content is per-model, and (by exhaustive float32/float64/int8 search against the source weights) that it
is not a raw or quantized embedding of them — it is a profile computed from the model's behaviour, which
is what `app/static/amp_profiler.js` builds.
