# GP-50 SnapTone upload — notes (fork addition to SNAPTONE_PROTOCOL.md)

`patch/device_write_snaptone.py`'s `build_snaptone_upload_stream()`/`validate_snaptone_stream()`
port this framing (`cmd=0x92`, same `build_packet()`/CRC-8/0x07 as the patch write) into
buildable, tested code — `app/tests/test_device_write.py`, 8 passing, no device I/O.

**Found while scoping CAP-4, and this is the real remaining blocker, not the refit:**
this capture never isolated **how the device is told which SnapTone slot to write
into**. The patch write's target slot lives in the payload's own first bytes
(`PATCH_HDR` + slot byte, above) — no equivalent field has ever been confirmed inside
a SnapTone payload, and "no separate control/commit packet appeared" in the original
capture (`re/DEVICE_WRITE.md`) rules out a separate select-then-upload step too.
Sending a "SnapTone → slot N" write built on this alone would be a **guessed command
to real hardware** — exactly what this project's write-safety discipline refuses (the
pedal has wedged from unvalidated traffic before). That's why there is **no
`send_snaptone_stream`** and no UI wired to this — it would have nothing meaningful to
let a user pick anyway.

**What would unblock it:** a fresh MIDI Monitor capture of a full Suite SnapTone
import, WITH the target slot known ahead of time (e.g. import to slot 55 specifically,
then diff against a second import to a different known slot — the same
diff-two-captures method that cracked the patch write's slot byte). Until then, CAP-4
stays scoped to transport groundwork only; the refit (generating a payload from an
arbitrary NAM) is a separate, larger, deliberately-deferred problem.

GP-150 has no such gap: its SnapTone upload (slot carried in the struct) is implemented in
`patch/gp150_snaptone_upload.py` / `app/static/webmidi_gp150.js`.
