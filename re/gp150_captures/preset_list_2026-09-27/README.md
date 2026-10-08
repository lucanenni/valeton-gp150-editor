# Preset list bulk read -- 2026-09-27

Live capture of the request/reply for GP-150's non-disruptive "read all
preset names" mechanism, found in a capture of Valeton
Suite's own startup traffic (see
`re/gp150_captures/presetlist_startup_capture_2026-09-27.jsonl`).

Suite sends a generic "read info by target ID" request (the same struct
family `build_select_preset_message()` uses in `webmidi_gp150.js` /
`gp150_scan_bank.py`, category=3, subcat=1) with target=`0x1010`, right
after connecting, as one of several startup info queries. Unlike the
preset-select mechanism, this does NOT change the pedal's active preset or
touch the front panel at all.

Request (verbatim from Suite, SysEx-stripped):
```
7f 7c 0c 00 00 00 02 00 00 01 08 0e 00 08 00 00 00 03 00 01 01 00 01 00 01 00 01 00 00 02 00 00
```

Reply: 68 chunked SysEx messages under category `0x7b` (123) -- 34 unique
chunks, sent twice (the device's own spontaneous rebroadcast). Reassembled
via `wire.reassemble_first_burst_stream()` (NOT `reassemble_first_burst()`,
which truncates to a `.prst`-sized 1128 bytes and silently drops the rest --
this reply is 4012 bytes, much longer than one `.prst` body).

`reassembled_stream.raw`: the exact 4012-byte reassembled stream, replayed
live and saved for regression testing (`app/tests/test_gp150_preset_list.py`).

Format: 8-byte echo of the request's own payload, then `magic(u16 LE)=0x1010`,
`size(u16 LE)=4000`, then 200 x 20-byte entries `[index: u32 LE][name: 16
bytes, null-padded latin1]`. Verified byte-for-byte against the real 200-slot
factory+custom name list (`patch/gp150_preset_list.py`).
