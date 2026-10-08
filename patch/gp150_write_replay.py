#!/usr/bin/env python3
"""GP-150 write replay — the first write this project's own code has ever
sent to the real pedal. Built entirely from a real captured Suite write,
never guessed: re/gp150_captures/write_attempts/write_import_slot200_clean.mmon
(Suite importing 006-UK900 DIST.prst to slot 199, 0-indexed), decoded and
analyzed in design/GP150_SUPPORT.md §3.1.

STATUS: prepared, NOT yet run — no hardware/USB access in this sandbox.
This needs to be run carefully and in order (see "verify" and "corrupt"
below); nothing here has been executed live yet.

Every one of the 10 write-chunk messages below is copied VERBATIM from
that capture. Two modes:

  verify   Replays the capture byte-for-byte, unmodified, back to the SAME
           slot (199) it originally targeted. This is the mandatory first
           step, not a formality: this project's write-path discipline
           (re/DEVICE_WRITE.md) is capture-first, THEN build, THEN
           validate byte-for-byte, THEN send — 'verify' is that
           validation, done live instead of only diffed on paper. Slot
           199 already holds this exact content (Suite itself wrote it
           there), so this is idempotent and safe: if it works, the
           device just ends up with the same UK900 DIST it already has.
           If this doesn't round-trip cleanly, STOP — do not attempt
           'corrupt' until it does.

  corrupt  The real capture's bytes, with exactly two controlled edits:
           (1) the patch-index field repointed at a DIFFERENT slot (given
           via --slot, must not be 199 — this never touches the slot
           'verify' already validated), and (2) the checksum field
           (body offset 0x0E-0x0F) deliberately overwritten with an
           obviously wrong value (default: 0x00 0x00, i.e. checksum bytes
           become 0,0 instead of the real 237,105). Every other byte —
           all 12 module blocks, every param, the name, the chain order,
           the whole rest of the patch — stays byte-for-byte identical to
           the real capture. This is the actual experiment: does the
           device accept/store a body with a checksum it can't have
           computed itself? Read the target slot back immediately after
           (patch/gp150_wake_select_read.py SLOT) to find out — three
           readable outcomes: the wrong checksum is stored as-is (device
           doesn't care), the device silently computes/writes a correct
           one instead (device does care, corrects it), or the write is
           rejected/slot unchanged (device validates and refuses).

Both modes require an EMPTY/scratch target slot for corrupt (choose one
you don't mind being overwritten — this really writes to the device) and
--confirm on the command line, matching this project's existing gated-send
convention (patch/gp150_wake_select_read.py has no such gate because it
never writes; this is the first script in this repo that does).

Chunk pacing: sends all 10 body chunks with a small inter-chunk gap (the
GP-5 precedent's own note: "the pedal has a shallow input queue and
wedges if requests outrun it" — re/DEVICE_WRITE.md), then listens for the
device's ack (an 8-byte then a 24-byte message, same shape observed after
every real capture), then sends the same trailing ack-out byte the real
capture ended with.

Run with Suite fully closed:
  python3 patch/gp150_write_replay.py verify --confirm
  python3 patch/gp150_write_replay.py corrupt --slot SLOT --confirm [--bad-checksum HI LO]
"""

import argparse
import os
import sys
import time

import rtmidi
from PyObjCTools import AppHelper

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patch import gp150_wire as wire  # noqa: E402

from patch.gp150_write import (  # noqa: E402
    CAPTURED_WRITE_CHUNKS,
    CAPTURED_ACK_OUT,
    CAPTURED_SLOT,
    build_chunks,
)


def find_port_index(ports, wanted=("GP-150",)):
    for i, p in enumerate(ports):
        if any(w in p for w in wanted):
            return i
    raise SystemExit(f"no GP-150-looking port found in {ports!r}")


def send_write(midi_out, midi_in, chunks, listen_seconds=5.0):
    for i, chunk in enumerate(chunks):
        midi_out.send_message([0xF0] + chunk + [0xF7])
        time.sleep(0.03)  # small inter-chunk gap — shallow device queue

    replies = []

    def callback(event, data=None):
        message, _dt = event
        d = bytes(message)
        if d and d[0] == 0xF0:
            d = d[1:]
        if d and d[-1] == 0xF7:
            d = d[:-1]
        replies.append(d)
        print(f"  device: {len(d)} bytes, {d.hex(' ')[:60]}...")

    midi_in.set_callback(callback)
    print(f"Listening {listen_seconds}s for the device's ack...")
    AppHelper.callLater(listen_seconds, AppHelper.stopEventLoop)
    AppHelper.runConsoleEventLoop()
    midi_in.set_callback(None)

    midi_out.send_message([0xF0] + CAPTURED_ACK_OUT + [0xF7])
    print("Sent the closing ack-out. Done.")
    return replies


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="mode", required=True)

    p_verify = sub.add_parser("verify", help="replay the real capture unmodified, to slot 199")
    p_verify.add_argument("--confirm", action="store_true", required=True)

    p_corrupt = sub.add_parser("corrupt", help="same capture, deliberately wrong checksum, to a different slot")
    p_corrupt.add_argument("--slot", type=int, required=True, help="0-indexed target slot; must be empty/scratch, must not be 199")
    p_corrupt.add_argument("--bad-checksum", type=int, nargs=2, metavar=("HI", "LO"), default=(0, 0), help="deliberately wrong checksum bytes (default: 0 0)")
    p_corrupt.add_argument("--confirm", action="store_true", required=True)

    args = ap.parse_args()

    if args.mode == "verify":
        slot, bad_checksum = CAPTURED_SLOT, None
        print(f"VERIFY: replaying the real capture byte-for-byte to slot {slot} (unmodified).")
    else:
        if args.slot == CAPTURED_SLOT:
            raise SystemExit(f"refusing: slot {CAPTURED_SLOT} already holds the real 'verify' write — pick a different, empty slot")
        if not (0 <= args.slot <= 199):
            raise SystemExit(f"slot must be 0-199, got {args.slot}")
        slot, bad_checksum = args.slot, tuple(args.bad_checksum)
        print(f"CORRUPT: same capture, checksum forced to {bad_checksum}, targeting slot {slot}.")
        print("Make sure this slot is genuinely empty/scratch — this really writes to it.")

    print("Make sure Valeton Suite is CLOSED.")
    chunks = build_chunks(slot, bad_checksum)

    midi_in = rtmidi.MidiIn()
    midi_out = rtmidi.MidiOut()
    in_ports, out_ports = midi_in.get_ports(), midi_out.get_ports()
    in_idx, out_idx = find_port_index(in_ports), find_port_index(out_ports)
    print(f"input port {in_idx}: {in_ports[in_idx]!r}  output port {out_idx}: {out_ports[out_idx]!r}")
    midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
    midi_in.open_port(in_idx)
    midi_out.open_port(out_idx)

    time.sleep(0.5)
    send_write(midi_out, midi_in, chunks)

    midi_in.close_port()
    midi_out.close_port()

    print(f"\nNow read slot {slot} back to see what actually happened:")
    print(f"  python3 patch/gp150_wake_select_read.py {slot}")


if __name__ == "__main__":
    main()
