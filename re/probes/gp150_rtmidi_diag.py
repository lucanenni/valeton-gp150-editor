#!/usr/bin/env python3
"""Minimal direct python-rtmidi SysEx-reception test, bypassing mido entirely.

Run this if gp150_probe.py's `read`/`raw` keep getting 0 SysEx messages
despite `unignore_sysex()` reporting success — this narrows down whether the
problem is in mido's wrapper/polling or something more fundamental
(python-rtmidi, CoreMIDI, or the driver).

Usage:
  python3 patch/gp150_rtmidi_diag.py

Then, WHILE IT'S RUNNING (it listens for 15s), change the active patch —
either by hand on the pedal's front panel, OR from a second terminal with
`python3 patch/gp150_probe.py bankpc 20`. Using the front panel is the
cleaner test: it isolates whether this script can receive SysEx AT ALL,
independent of anything our own send-side code does.
"""

import time

import rtmidi

midi_in = rtmidi.MidiIn()
ports = midi_in.get_ports()
print("available input ports:", ports)
idx = next((i for i, p in enumerate(ports) if "GP-150" in p or "GP150" in p), None)
if idx is None:
    raise SystemExit(f"no GP-150 port found in {ports!r}")
print(f"opening port {idx}: {ports[idx]!r}")

received = []


def callback(event, data=None):
    message, deltatime = event
    received.append(message)
    b = bytes(message)
    print(f"  [{len(received)}] {len(b)} bytes  first16={b[:16].hex(' ')}")


midi_in.set_callback(callback)
midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
midi_in.open_port(idx)

print("\nListening for 15 seconds.")
print("Change the active patch NOW — front panel button press is the")
print("cleanest test, or run `python3 patch/gp150_probe.py bankpc 20`")
print("from a second terminal.\n")
time.sleep(15)

midi_in.close_port()
print(f"\nTotal messages received: {len(received)}")
if not received:
    print(
        "Still zero. Next things to check (tell me, don't guess-fix): what "
        "does `pip show python-rtmidi` say (version)? Any error/warning "
        "printed above that got missed? Does Python show up anywhere "
        "needing a macOS permission prompt (check System Settings > "
        "Privacy & Security for anything MIDI/Bluetooth/Input related)?"
    )
