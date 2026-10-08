GP150-9 (SnapTone/User IR/NAM upload) live capture, 2026-09-24.

`raw_midi_out_capture.txt` was every MIDI message Suite sent to the pedal (host→pedal traffic, which a
plain passive MIDI listener cannot see — see `patch/gp150_listen_passive.py`), timestamped in ms.
**The raw file is not in the repository**: its three imports carry third-party content (an IR WAV, a
SnapTone profile and a NAM model). The upload tests use synthetic payloads and a golden fixture instead
(`app/tests/gp150_upload_synth.mjs`); to re-run the byte-for-byte parity checks against the real capture
keep the file under this same folder name in a directory of your own and set `GP150_CAPTURES_DIR`.

Three imports were captured, each a distinct MIDISend burst: an IR → library slot 3 (a 60 KB 24-bit
44.1 kHz mono WAV, burst at ~36.6 s), a SnapTone → slot 97 (~68.3 s) and a NAM → slot 1 (a 294 KB
WaveNet `.nam`, ~143.8 s).

See BACKLOG_GP150.md's GP150-9 entry and `webmidi_gp150.js` for the decoded envelope structure (header
format, type markers, target-slot field, name field).
