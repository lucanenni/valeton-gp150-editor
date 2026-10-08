#!/usr/bin/env python3
"""GP-150 live read — the working combination, finally.

Two things had to both be true for a real MIDI-in read to work at all,
found 2026-07-31 by elimination (re/probes/gp150_rtmidi_diag.py,
re/probes/gp150_runloop_diag.py — archived, see their comments — and a
lot of confused debugging in between):

1. **Valeton Suite (or Mobile) must be open and connected to the pedal.**
   With Suite closed, the device sends nothing to ANYONE — not even MIDI
   Monitor saw traffic. The device only streams its state while a companion
   app has it "awake"; a bare CC0+PC from us isn't enough by itself.
   **Superseded 2026-08-22**: this is true for a bare CC0+PC alone, but
   `patch/gp150_wake_replay.py` shows a plain replay of Suite's own
   connect-time SysEx request wakes the device without Suite running at
   all — see that script and design/GP150_SUPPORT.md §3.2.
2. **The calling process needs a real, pumped CFRunLoop, not time.sleep()
   polling.** CoreMIDI delivers input callbacks via the run loop; a GUI app
   (MIDI Monitor) always has one, a plain script doesn't unless it asks for
   one. `mido`'s rtmidi backend + `iter_pending()` never received anything
   in testing; raw `python-rtmidi` + a callback + `pyobjc`'s
   `AppHelper.runConsoleEventLoop()` did. Still true, unaffected by the
   wake-replay finding above.

This script uses raw `python-rtmidi` (not mido) for both directions, and
pumps a real run loop while listening. Needs: `pip install pyobjc-framework-Cocoa`
(already needed by re/probes/gp150_runloop_diag.py, which proved this
combination).

**Before running: open Valeton Suite and let it fully connect to the pedal
first.** It doesn't need to be doing anything, just connected. (If you want
to avoid Suite entirely, use `patch/gp150_wake_replay.py` instead.)

Usage:
  python3 patch/gp150_live_read.py <slot>

Reassembly reuses patch/gp150_wire.py (validated offline against saved
MIDI Monitor captures) — this script's only new part is actually getting
messages delivered, which is what 1-2 above were blocking.
"""

import os
import sys
import time

import rtmidi
from PyObjCTools import AppHelper

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patch import gp150_wire as wire  # noqa: E402

OUTDIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "device_scan_gp150")
LISTEN_SECONDS = 5.0


def find_port_index(ports, wanted=("GP-150",)):
    for i, p in enumerate(ports):
        if any(w in p for w in wanted):
            return i
    raise SystemExit(f"no GP-150/180-looking port found in {ports!r}")


def strip_f0_f7(msg: bytes) -> bytes:
    """Raw python-rtmidi callback messages include the F0/F7 SysEx wrapper
    (unlike mido's `.data`, and unlike the saved MIDI Monitor captures
    gp150_wire.py was validated against) — drop them so the rest of the
    pipeline (chunk header + nibble payload) lines up the same way."""
    if msg and msg[0] == 0xF0:
        msg = msg[1:]
    if msg and msg[-1] == 0xF7:
        msg = msg[:-1]
    return msg


def read_slot(slot: int) -> bytes | None:
    midi_in = rtmidi.MidiIn()
    midi_out = rtmidi.MidiOut()
    in_ports = midi_in.get_ports()
    out_ports = midi_out.get_ports()
    in_idx = find_port_index(in_ports)
    out_idx = find_port_index(out_ports)
    print(f"input port {in_idx}: {in_ports[in_idx]!r}  output port {out_idx}: {out_ports[out_idx]!r}")

    by_category = {}

    def callback(event, data=None):
        message, _deltatime = event
        d = strip_f0_f7(bytes(message))
        if len(d) > wire.CHUNK_HEADER_LEN:
            by_category.setdefault(d[wire.CHUNK_CATEGORY_IDX], []).append(d)

    midi_in.set_callback(callback)
    midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
    midi_in.open_port(in_idx)
    midi_out.open_port(out_idx)

    print(f"selecting slot {slot} (CC0=0, then PC={slot}) and listening {LISTEN_SECONDS}s...")
    midi_out.send_message([0xB0, 0x00, 0x00])  # CC0 = 0 (bank MSB)
    time.sleep(0.05)
    midi_out.send_message([0xC0, slot & 0x7F])  # Program Change

    AppHelper.callLater(LISTEN_SECONDS, AppHelper.stopEventLoop)
    AppHelper.runConsoleEventLoop()

    midi_in.close_port()
    midi_out.close_port()

    if not by_category:
        print("NO SysEx received. Is Valeton Suite still open and connected?")
        return None

    for cat, msgs in by_category.items():
        try:
            body = wire.reassemble_body(msgs)
        except ValueError as e:
            print(f"  category {cat:#04x} ({len(msgs)} chunks): {e}")
            continue
        print(f"  category {cat:#04x}: reassembled {len(body)} bytes OK")
        return body

    print("Got SysEx but nothing reassembled cleanly.")
    return None


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    slot = int(sys.argv[1])
    body = read_slot(slot)
    if body is None:
        return
    os.makedirs(OUTDIR, exist_ok=True)
    path = os.path.join(OUTDIR, f"slot{slot:02d}_live.prst")
    open(path, "wb").write(body)
    print(f"wrote {path}")

    import glob

    # optional reference corpus (kept outside the repo): GP150_CORPUS_DIR/prst_export
    corpus_dir = os.path.join(os.path.expanduser(os.environ.get("GP150_CORPUS_DIR", "")), "prst_export")
    candidates = glob.glob(os.path.join(corpus_dir, f"{slot + 1:03d}-*.prst"))
    if candidates:
        known = open(candidates[0], "rb").read()
        if known == body:
            print(f"MATCHES the Suite export ({os.path.basename(candidates[0])}) byte-for-byte.")
        else:
            diffs = sum(1 for a, b in zip(known, body) if a != b)
            print(f"DOES NOT MATCH {os.path.basename(candidates[0])}: {diffs} differing bytes.")
    else:
        print(f"(no corpus file found for slot {slot} to compare against)")


if __name__ == "__main__":
    main()
