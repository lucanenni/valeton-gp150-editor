#!/usr/bin/env python3
"""Same test as gp150_rtmidi_diag.py, but pumping a real CFRunLoop instead of
time.sleep() — CoreMIDI's documented requirement is that the calling thread
have an ACTIVE run loop for input callbacks to fire, which a plain script's
time.sleep() loop never provides (a GUI app like MIDI Monitor always has one
running). If this is the cause, this script will receive messages where
gp150_rtmidi_diag.py got none.

Needs: pip install pyobjc-framework-Cocoa

Usage:
  python3 patch/gp150_runloop_diag.py
Then, WHILE IT'S RUNNING, change the active patch (front panel button press
is cleanest, or `python3 patch/gp150_probe.py bankpc 20` from a 2nd terminal).
"""

import rtmidi
from PyObjCTools import AppHelper

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

print("\nPumping a CFRunLoop for 15 seconds (not just sleeping this time).")
print("Change the active patch NOW.\n")

AppHelper.callLater(15, AppHelper.stopEventLoop)
AppHelper.runConsoleEventLoop()

midi_in.close_port()
print(f"\nTotal messages received: {len(received)}")
if received:
    print("GOT SOMETHING — the run-loop theory was right. Report this back.")
else:
    print("Still zero even with a real run loop pumping. Report this back too.")
