#!/usr/bin/env python3
"""GP-150 wake + select + read, combined — generalizes gp150_wake_replay.py
past "whatever patch happens to be active right now" to a specific slot,
with Valeton Suite fully closed.

STATUS: CONFIRMED WORKING live (2026-08-22, slot 10 → "Morse Purple",
decoded cleanly, valid chain order, every module a real model). It composes
two pieces each already confirmed *separately* (design/GP150_SUPPORT.md
GP150-5):

1. CC0+PC slot select (gp150_live_read.py / gp150_probe.py, confirmed
   2026-07-31) — makes `slot` the pedal's active patch.
2. The Suite-free "wake" replay (gp150_wake_replay.py, confirmed
   2026-08-22) — an explicit "send me the active patch" request, copied
   verbatim from a real capture, that gets a real reply with Suite closed.

The order here is deliberate: select the slot *first*, THEN send the
wake/fetch request — so the fetch always asks for "the active patch" only
after we've just made that patch `slot`.

**`--cold-start` (2026-09-20): the isolated wake/fetch request above only
works if Suite connected at least once earlier in this same USB session**
(even if closed since). In a genuinely cold session (Suite never opened
at all), the device replies to the isolated wake with only an 8-byte ack
and no body. Confirmed live: it needs the real 5-step handshake Suite
itself sends on connect (`re/gp150_captures/startup_sequence.mmon`,
messages 0/3/4, copied verbatim) — hello (32 bytes) -> device ack +
40-byte info reply -> our own 8-byte ack-out echoing that reply's
category -> [select, as above] -> wake/fetch. Pass `--cold-start` to run
the hello/ack-out pair first; omit it if this process (or an earlier one
this USB session) already did it once — resending it is harmless but
unnecessary.

**Real finding from first live runs**: with Suite closed but the device
already "awake" from an earlier script's request this session, a plain
CC0+PC select ALONE already triggers a full unprompted body push — same
behavior GP150-5 previously only saw with Suite open. This means "wake"
looks like a one-time, per-USB-session thing, not something that needs
resending before every read (one of GP150-5's open follow-ups) — not
fully confirmed yet (e.g. whether it survives a power cycle is untested),
but consistent with everything seen so far.

That also means more than one push can land inside a single listen window
— not just two: a later run at --settle 0.3 (after the fix below) caught
FOUR complete 10-chunk bursts (the automatic push from select, the reply
to our own fetch, and two more the device sent on its own with a
different transmission-level checksum byte — it appears to just keep
re-broadcasting periodically while "awake" and connected, not only in
direct response to a trigger). The first live attempts (0.3s/0.6s/1s, on
the *buggy* reassembly logic below) failed; 10s worked, which pointed at
this being a real parsing bug, not a device timing one:
`gp150_wire.reassemble_body()`'s naive last-chunk-index-wins merge
silently corrupts the result when more than one burst's chunks land in
the same message list. Fixed by `gp150_wire.split_bursts()` +
`reassemble_first_burst()` (unit-tested against synthetic reproductions of
both the exact failure seen live and a sneakier same-length
silent-corruption variant) — this script uses the latter. **Re-confirmed
live with the fix at --settle 0.3 (2026-08-22, slot 5 → "UK900 DIST",
matching the known corpus file exactly)** — short settle is safe again,
regardless of how many bursts the device throws at it.

Also fixes a latent bug present in gp150_live_read.py/gp150_cc_experiment.py:
those always send CC0=0, which only reaches slots 0-127 (patches 001-128)
and was never a problem there since neither was ever pointed at a slot
>=128. Per the manual (p.77): 001-128 use CC0=0 + PC=0-127; 129-200 use
CC0=1 + PC=0-71. `bank_and_pc()` below does the correct split for the full
0-199 range.

Run with Suite fully closed:
  python3 patch/gp150_wake_select_read.py SLOT [--settle SECONDS]

SLOT is 0-199 (0-indexed, matching every other script in this project).
"""

import argparse
import os
import sys
import time

import rtmidi
from PyObjCTools import AppHelper

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patch import gp150_wire as wire  # noqa: E402
from patch.gp150_wake_replay import WAKE_REQUEST_BYTES, strip_f0_f7  # noqa: E402

DEFAULT_SETTLE = 0.30  # same margin scan_bank.py's proven cadence uses after a select
LISTEN_SECONDS = 5.0

# Verbatim from startup_sequence.mmon message 0 ("To GP-150", 32 bytes) --
# the "hello" Suite sends on connect, before anything else.
HELLO_BYTES = bytes([
    0x7f, 0x25, 0x0c, 0, 0, 0, 0, 0, 0, 1, 5, 3, 0, 8, 0, 0, 0, 3, 0, 1,
    7, 0, 1, 0, 7, 0, 1, 0, 0, 2, 0, 0,
])
# Verbatim from startup_sequence.mmon message 3 ("To GP-150", 8 bytes) --
# our own ack-out echoing the info reply's category byte (0x29).
ACK_OUT_BYTES = bytes([0x7f, 0x1f, 0, 0, 0, 0, 0x29, 0])


def bank_and_pc(slot: int) -> tuple[int, int]:
    """Manual p.77-78 split across the full 200-slot range: 001-128 (slot
    0-127) use CC0=0 + PC=slot; 129-200 (slot 128-199) use CC0=1 +
    PC=slot-128."""
    if not 0 <= slot <= 199:
        raise ValueError(f"slot must be 0-199, got {slot}")
    if slot < 128:
        return 0, slot
    return 1, slot - 128


def find_port_index(ports, wanted=("GP-150",)):
    for i, p in enumerate(ports):
        if any(w in p for w in wanted):
            return i
    raise SystemExit(f"no GP-150-looking port found in {ports!r}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("slot", type=int, help="0-199, 0-indexed")
    ap.add_argument(
        "--settle", type=float, default=DEFAULT_SETTLE,
        help=f"seconds to wait between select and fetch (default {DEFAULT_SETTLE})",
    )
    ap.add_argument(
        "--cold-start", action="store_true",
        help="send the full hello/ack-out handshake first -- needed once per "
             "USB session if Suite has never connected (see this module's docstring)",
    )
    args = ap.parse_args()
    bank, pc = bank_and_pc(args.slot)

    midi_in = rtmidi.MidiIn()
    midi_out = rtmidi.MidiOut()
    in_ports = midi_in.get_ports()
    out_ports = midi_out.get_ports()
    in_idx = find_port_index(in_ports)
    out_idx = find_port_index(out_ports)
    print(f"input port {in_idx}: {in_ports[in_idx]!r}  output port {out_idx}: {out_ports[out_idx]!r}")
    print("Make sure Valeton Suite is CLOSED for this test to mean anything.")

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

    if args.cold_start:
        print("\nSending HELLO (32 bytes)...")
        time.sleep(0.5)
        midi_out.send_message([0xF0] + list(HELLO_BYTES) + [0xF7])
        time.sleep(1.0)
        print("Sending our ACK-OUT for the info reply (8 bytes)...")
        midi_out.send_message([0xF0] + list(ACK_OUT_BYTES) + [0xF7])
        time.sleep(0.5)

    print(f"\nSelecting slot {args.slot} (CC0={bank}, PC={pc})...")
    time.sleep(0.5)
    midi_out.send_message([0xB0, 0x00, bank])
    time.sleep(0.05)
    midi_out.send_message([0xC0, pc])

    print(f"Settling {args.settle}s, then sending the fetch request "
          f"({len(WAKE_REQUEST_BYTES)} bytes + F0/F7 framing)...")
    time.sleep(args.settle)
    wire_msg = [0xF0] + list(WAKE_REQUEST_BYTES) + [0xF7]
    midi_out.send_message(wire_msg)

    print(f"Listening {LISTEN_SECONDS}s...")
    AppHelper.callLater(LISTEN_SECONDS, AppHelper.stopEventLoop)
    AppHelper.runConsoleEventLoop()

    midi_in.close_port()
    midi_out.close_port()

    if not by_category:
        print("\nNO reply. Select-then-fetch (Suite closed) did not get a "
              "response — informative, not a failure. Try a bigger --settle, "
              "or report this back rather than retrying blindly.")
        return

    print(f"\nGot replies in {len(by_category)} categor(y/ies): "
          f"{[hex(c) for c in by_category]}")
    for cat, msgs in by_category.items():
        try:
            body = wire.reassemble_first_burst(msgs)
        except ValueError as e:
            print(f"  category {cat:#04x} ({len(msgs)} chunks): couldn't reassemble a full body ({e})")
            continue
        print(f"  category {cat:#04x}: reassembled a full {len(body)}-byte body!")
        path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), "device_scan_gp150",
            f"wake_select_read_slot{args.slot:03d}.prst",
        )
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(body)
        print(f"  wrote {path}")


if __name__ == "__main__":
    main()
