#!/usr/bin/env python3
"""GP-150 "wake" replay — CONFIRMED WORKING (2026-08-22): a live GP-150 read
no longer needs Valeton Suite open.

Run with Suite fully closed: replays the exact SysEx request Suite itself
sends on connect, and the device replies with the active patch — a real,
valid 1128-byte body (`gp150_format.decode()` resolves it cleanly: real
name, valid chain order, every module's model a real catalog entry).
Evidence: `re/gp150_captures/wake_replay/slot00_no_suite.prst`.

Not a finished read API yet — always fetches whatever patch is *currently
active* (no slot argument), and doesn't combine with CC0+PC select
(already Suite-independent, GP150-5 §1.7) into one tool. Open follow-ups:
does the wake need sending only once per connection, or can it repeat for
every read; do the varying bytes in the request actually need to be
correct, or did the device accept them regardless (untested — this reused
a full valid capture). See design/GP150_SUPPORT.md §3.2.

**Not guessed traffic.** The 38 bytes below are copied verbatim (via
`plistlib`, no manual transcription) from a real MIDI Monitor capture of
Suite connecting fresh (`re/gp150_captures/startup_sequence.mmon`, message
4 — the "To GP-150" request tagged category 0x01). Byte-compared against an
independent second capture of the same request from an earlier session
(`re/gp150_captures/patch_1_open.mmon`): 11 of 15 decoded payload bytes are
identical across the two, only a checksum-shaped byte and 3 trailing bytes
differ — see design/GP150_SUPPORT.md §3.2 for the
analysis. This is a **replay of exact previously-working bytes**, not a
synthesized guess — the same risk class as every other read-only request
this project has sent, not the "guessed traffic wedged the pedal" write-path
danger `re/DEVICE_WRITE.md` warns about (this has no write/commit opcode,
it's a read-style request).

**Run this with Valeton Suite fully CLOSED** — that's the whole point of
the test. (Needs pyobjc-framework-Cocoa, same as gp150_live_read.py.)

Usage:
  python3 patch/gp150_wake_replay.py

One request, one listen window, no retry loop, no CC0/PC sent — this tests
the wake request in complete isolation. If nothing comes back, that's a
real, informative result (the wake needs more than this exact byte
sequence) — report it, don't retry blindly.
"""

import os
import sys
import time

import rtmidi
from PyObjCTools import AppHelper

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patch import gp150_wire as wire  # noqa: E402

# Exact bytes of message 4 in re/gp150_captures/startup_sequence.mmon (the
# "To GP-150" request tagged category 0x01) — copied via plistlib, not typed
# by hand. This is what gets wrapped in F0/F7 and sent as-is.
WAKE_REQUEST_BYTES = bytes([
    127, 92, 15, 0, 0, 0, 1, 0, 0, 1, 8, 2, 0, 11, 0, 0, 0, 3, 0, 3, 1, 1, 3,
    0, 1, 1, 3, 0, 0, 2, 0, 0, 15, 15, 15, 15, 0, 1,
])

LISTEN_SECONDS = 5.0


def find_port_index(ports, wanted=("GP-150",)):
    for i, p in enumerate(ports):
        if any(w in p for w in wanted):
            return i
    raise SystemExit(f"no GP-150-looking port found in {ports!r}")


def strip_f0_f7(msg: bytes) -> bytes:
    if msg and msg[0] == 0xF0:
        msg = msg[1:]
    if msg and msg[-1] == 0xF7:
        msg = msg[:-1]
    return msg


def main():
    midi_in = rtmidi.MidiIn()
    midi_out = rtmidi.MidiOut()
    in_ports = midi_in.get_ports()
    out_ports = midi_out.get_ports()
    in_idx = find_port_index(in_ports)
    out_idx = find_port_index(out_ports)
    print(f"input port {in_idx}: {in_ports[in_idx]!r}  output port {out_idx}: {out_ports[out_idx]!r}")

    by_category = {}

    def callback(event, data=None):
        message, _dt = event
        d = strip_f0_f7(bytes(message))
        if len(d) > wire.CHUNK_HEADER_LEN:
            by_category.setdefault(d[wire.CHUNK_CATEGORY_IDX], []).append(d)
        print(f"  received {len(d)} bytes, raw={d.hex(' ')[:60]}...")

    midi_in.set_callback(callback)
    midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
    midi_in.open_port(in_idx)
    midi_out.open_port(out_idx)

    wire_msg = [0xF0] + list(WAKE_REQUEST_BYTES) + [0xF7]
    print(f"\nSending the wake request verbatim ({len(WAKE_REQUEST_BYTES)} bytes + F0/F7 framing)...")
    print("Make sure Valeton Suite is CLOSED for this test to mean anything.")
    time.sleep(0.5)
    midi_out.send_message(wire_msg)

    print(f"Listening {LISTEN_SECONDS}s...")
    AppHelper.callLater(LISTEN_SECONDS, AppHelper.stopEventLoop)
    AppHelper.runConsoleEventLoop()

    midi_in.close_port()
    midi_out.close_port()

    if not by_category:
        print("\nNO reply. The wake request alone (with Suite closed) did not "
              "get a response — informative, not a failure. Report this back.")
        return

    print(f"\nGot replies in {len(by_category)} categor(y/ies): "
          f"{[hex(c) for c in by_category]}")
    for cat, msgs in by_category.items():
        try:
            body = wire.reassemble_body(msgs)
        except ValueError as e:
            print(f"  category {cat:#04x} ({len(msgs)} chunks): couldn't reassemble a full body ({e})")
            continue
        print(f"  category {cat:#04x}: reassembled a full {len(body)}-byte body!")
        path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), "device_scan_gp150", "wake_replay_body.prst"
        )
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(body)
        print(f"  wrote {path}")


if __name__ == "__main__":
    main()
