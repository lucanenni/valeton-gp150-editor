#!/usr/bin/env python3
"""GP-150 passive MIDI listener — dumps every message the PEDAL sends to the
host, with a timestamp, both to the console and to a timestamped file under
re/gp150_captures/. Sends nothing; safe to run alongside Suite (CoreMIDI
allows multiple simultaneous readers of the same source port).

**DIRECTION WARNING (found the hard way during GP150-9, 2026-09-24)**: this
can ONLY see device->host traffic (the pedal's own replies/broadcasts). It
CANNOT see what Suite (or any other app) sends TO the pedal (host->device)
-- that goes straight from Suite's process to the USB destination endpoint,
with no fan-out to other listeners. Use this for read-path/broadcast
investigations only (e.g. GP150-11's live-sync work). For anything about
what Suite itself SENDS (write/upload paths -- GP150-6, GP150-10, GP150-9),
you need to capture Suite's own MIDI output instead; this script cannot
substitute for that no matter how long you run it.

Usage:
  python3 patch/gp150_listen_passive.py [SECONDS] [--tag LABEL]
"""

import os
import sys
import time

import rtmidi


def find_port_index(ports, wanted=("GP-150",)):
    for i, p in enumerate(ports):
        if any(w in p for w in wanted):
            return i
    raise SystemExit(f"no GP-150-looking port found in {ports!r}")


def main():
    seconds = 60.0
    tag = "capture"
    args = sys.argv[1:]
    if args and not args[0].startswith("--"):
        seconds = float(args[0])
        args = args[1:]
    if args and args[0] == "--tag":
        tag = args[1]

    midi_in = rtmidi.MidiIn()
    in_ports = midi_in.get_ports()
    in_idx = find_port_index(in_ports)
    print(f"input port {in_idx}: {in_ports[in_idx]!r}")

    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "re", "gp150_captures")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{tag}_{int(time.time())}.txt")
    out_f = open(out_path, "w")

    t0 = time.time()

    def callback(event, data=None):
        message, _dt = event
        d = bytes(message)
        line = f"+{time.time() - t0:8.3f}s  len={len(d):4d}  {d.hex(' ')}"
        print(line)
        out_f.write(line + "\n")
        out_f.flush()

    midi_in.set_callback(callback)
    midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
    midi_in.open_port(in_idx)

    print(f"Listening passively for {seconds}s -- sending nothing. Do the Suite action now.")
    print(f"Writing to {out_path}")
    try:
        time.sleep(seconds)
    except KeyboardInterrupt:
        pass

    midi_in.close_port()
    out_f.close()
    print(f"\nDone. Capture saved to {out_path}")


if __name__ == "__main__":
    main()
