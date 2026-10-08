#!/usr/bin/env python3
"""Scan all (or a range of) GP-150 presets off the device into .prst files,
emitting one JSON progress line per slot so the web app can show a progress
bar — the GP-150 analog of scan_bank.py (GP-50). Feeds the "used by"
cross-reference on the Captures & IRs page (which SnapTone/NAM/User IR slot
each live patch references), the one piece of that page GP-150 never had
because, unlike GP-50, this project has no local library of exported GP-150
patches to derive it from -- everything about a live pedal's OWN patches has
to come from the pedal itself, live, every time.

**Bug #1, found and fixed during this script's own first live test,
2026-09-27**: an early version selected slots the way gp150_wake_select_read.py
does (plain MIDI CC0+ProgramChange), then repeated that + a WAKE_REQUEST_BYTES
fetch across 200 slots in ONE persistent session. Slot 0 decoded correctly,
every slot after it kept re-decoding slot 0's OWN body again -- CC0+PC only
reliably re-triggers a fresh read the FIRST time in a session. FIX: use the
same dedicated "select preset" SysEx command webmidi_gp150.js's
readSlotViaSelect() relies on (build_select_preset_message() below, ported
byte-for-byte from buildSelectPresetMessage()) instead of CC0+PC.

**Bug #2, found right after fixing #1**: with the new select mechanism, the
FIRST slot in a session decoded correctly but every later one still failed --
the exact same symptom, one layer removed. Cross-checked live against the
browser: webmidi_gp150.js's own readSlotViaSelect() handles repeated calls in
one session perfectly (proven live, slots 5/6/7 in a row, right after this
script kept failing on the same hardware). So the wire protocol was never the
problem a second time either -- the bug was in how this script drove PyObjC's
run loop. The old code called AppHelper.runConsoleEventLoop()/stopEventLoop()
freshly for EACH slot, and stopEventLoop() was being called from inside the
rtmidi MIDI callback -- which fires on CoreMIDI's own background thread, not
the main thread the run loop belongs to. That cross-thread AppKit call
apparently "works" the first time by luck and leaves the main run loop unable
to properly service a second runConsoleEventLoop() call afterwards. FIX:
run ONE continuous runConsoleEventLoop() for the entire scan; a
self-rescheduling main-thread timer (tick(), driven by AppHelper.callLater())
polls the state the MIDI callback fills in and does ALL decision-making --
sending commands, detecting matches, advancing slots -- so stopEventLoop() is
only ever called from the main thread, once, at the very end.

Every wire-level step here (info probe, select command, wake/fetch request)
is copied verbatim from real Suite captures or already-proven JS formulas --
nothing here is guessed traffic.

  python3 patch/gp150_scan_bank.py [start] [end] [outdir]
    # inclusive 0..199; default 0 199 gp150_scan_cache/

Default output dir is deliberately NOT device_scan_gp150/ (that directory
holds this project's own ad-hoc research captures from earlier reverse-
engineering sessions -- one-off files, kept as reference material, never
meant to be bulk-deleted). This script's caller (device_io.py, mirroring
GP-50's own scan_bank() wiping SCAN_DIR first) DOES wipe its own output
dir clean before each run, so it needs a directory nothing else writes
into.
"""

import argparse
import os
import sys
import time

import rtmidi
from PyObjCTools import AppHelper

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patch import device_protocol  # noqa: E402
from patch import gp150_format as fmt  # noqa: E402
from patch import gp150_wire as wire  # noqa: E402
from patch.gp150_set_param import _crc8, compute_wire_tag  # noqa: E402
from patch.gp150_wake_replay import WAKE_REQUEST_BYTES, strip_f0_f7  # noqa: E402
from patch.gp150_wake_select_read import find_port_index  # noqa: E402

SETTLE_MS = 0.30  # webmidi_gp150.js's own DEFAULT_SETTLE_MS, proven live
READ_TIMEOUT = 10.0  # real hardware latency measured live 2026-09-27: a full,
# correct body can take ~6-7s to actually arrive after select+wake under a
# busy session (confirmed via a patient, no-timeout capture) -- webmidi_gp150.js's
# own 6000ms budget was right at the edge, not a comfortable margin
MAX_STALE_RESENDS = 3  # readSlotViaSelect()'s own bound
BETWEEN_SLOTS = 0.05  # scan_bank.py's own pacing; keeps this well clear of a tight-loop hazard
POLL_INTERVAL = 0.05  # main-thread tick() cadence -- see module docstring, bug #2

# webmidi_gp150.js's connect()->primeSession(): the actual session warm-up
# readSlotViaSelect() relies on. Sends one harmless 'info' request and waits
# for an ACTUAL reply before doing anything else -- Suite's own observed
# startup behavior, needed because the very first exchange after a fresh
# connection can otherwise get no reply at all.
INFO_REQUEST_BYTES = bytes([
    127, 37, 12, 0, 0, 0, 0, 0, 0, 1, 5, 3, 0, 8, 0, 0, 0, 3, 0, 1, 7, 0, 1, 0,
    7, 0, 1, 0, 0, 2, 0, 0,
])
PRIME_WINDOW = 6.0  # webmidi_gp150.js's own PRIME_WINDOW_MS

SELECT_PRESET_CHECKSUM_START = 4  # webmidi_gp150.js's own SELECT_PRESET_CHECKSUM_START


def build_select_preset_message(slot: int, counter: int = 1) -> bytes:
    """Byte-for-byte port of webmidi_gp150.js's buildSelectPresetMessage() --
    the dedicated "select preset" SysEx command (NOT CC0+ProgramChange; see
    this module's own docstring, bug #1, for why that distinction matters)."""
    if not 0 <= slot <= 199:
        raise ValueError(f"slot must be 0-199, got {slot}")
    payload = bytearray([
        0x01, 0, 0x0B, 0x00, 0x03, 0x03, 0x11, 0x30, 0x11, 0x30, 0x02, 0x00,
        slot & 0xFF, (slot >> 8) & 0xFF, 0x00,
    ])
    payload[1] = _crc8(bytes(payload[SELECT_PRESET_CHECKSUM_START:]))
    header = bytes([0x7F, 0, len(payload), 0, 0, 0, counter & 0xFF, 0])
    raw = bytearray(header + wire.bytes_to_nibbles(bytes(payload)))
    raw[1] = compute_wire_tag(bytes(raw))
    return bytes(raw)


def run_scan(midi_out, session, slots, on_slot):
    """Drive the ENTIRE scan inside one continuous runConsoleEventLoop() call.
    A self-rescheduling main-thread timer (tick(), via AppHelper.callLater())
    polls session["by_category"] -- which the MIDI callback (on CoreMIDI's own
    background thread) only ever appends to -- and does ALL decision-making:
    sending the prime/select/wake commands, detecting a matching body,
    resending on stale data, advancing slots, and timing out. stopEventLoop()
    is therefore only ever called from tick() itself, i.e. the main thread,
    exactly once, when every slot is done. See module docstring, bug #2."""
    st = {
        "slots": list(slots),
        "i": -1,
        "phase": "prime",
        "phase_t0": time.time(),
        "prime_sent": False,
        "wake_sent": False,
        "resends": 0,
        "last_sig": None,
        "seen_slots": set(),
    }

    def start_slot():
        st["i"] += 1
        if st["i"] >= len(st["slots"]):
            st["phase"] = "finished"
            return
        slot = st["slots"][st["i"]]
        session["by_category"] = {}
        st["phase"] = "waiting"
        st["phase_t0"] = time.time()
        st["wake_sent"] = False
        st["resends"] = 0
        st["last_sig"] = None
        st["seen_slots"] = set()
        select_msg = build_select_preset_message(slot)
        midi_out.send_message([0xF0] + list(select_msg) + [0xF7])

    def check_match(slot):
        for msgs in list(session["by_category"].values()):
            try:
                body = wire.reassemble_first_burst(msgs)
            except ValueError:
                continue
            if len(body) != fmt.PRST_LEN:
                continue
            got_slot = fmt.read_patch_index(body)
            if got_slot == slot:
                return body
            st["seen_slots"].add(got_slot)
        return None

    def tick():
        if st["phase"] == "prime":
            if not st["prime_sent"]:
                midi_out.send_message([0xF0] + list(INFO_REQUEST_BYTES) + [0xF7])
                st["prime_sent"] = True
                st["phase_t0"] = time.time()
            elif session["by_category"] or time.time() - st["phase_t0"] > PRIME_WINDOW:
                start_slot()
        elif st["phase"] == "waiting":
            slot = st["slots"][st["i"]]
            elapsed = time.time() - st["phase_t0"]
            if not st["wake_sent"] and elapsed >= SETTLE_MS:
                midi_out.send_message([0xF0] + list(WAKE_REQUEST_BYTES) + [0xF7])
                st["wake_sent"] = True
            body = check_match(slot) if st["wake_sent"] else None
            if body is not None:
                on_slot(slot, body)
                start_slot()
            elif st["wake_sent"] and st["seen_slots"]:
                sig = ",".join(str(s) for s in sorted(st["seen_slots"]))
                if sig != st["last_sig"] and st["resends"] < MAX_STALE_RESENDS:
                    st["last_sig"] = sig
                    st["resends"] += 1
                    midi_out.send_message([0xF0] + list(WAKE_REQUEST_BYTES) + [0xF7])
                if elapsed > READ_TIMEOUT:
                    on_slot(slot, None)
                    start_slot()
            elif elapsed > READ_TIMEOUT:
                on_slot(slot, None)
                start_slot()

        if st["phase"] == "finished":
            AppHelper.stopEventLoop()
        else:
            AppHelper.callLater(POLL_INTERVAL, tick)

    AppHelper.callLater(0, tick)
    AppHelper.runConsoleEventLoop()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("start", type=int, nargs="?", default=0)
    ap.add_argument("end", type=int, nargs="?", default=199)
    ap.add_argument(
        "outdir", nargs="?",
        default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "gp150_scan_cache"),
    )
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    total = args.end - args.start + 1
    device_protocol.emit(device_protocol.scan_start(total))

    midi_in = rtmidi.MidiIn()
    midi_out = rtmidi.MidiOut()
    in_idx = find_port_index(midi_in.get_ports())
    out_idx = find_port_index(midi_out.get_ports())

    session = {"by_category": {}}

    def callback(event, data=None):
        message, _dt = event
        d = strip_f0_f7(bytes(message))
        if len(d) > wire.CHUNK_HEADER_LEN:
            cat = d[wire.CHUNK_CATEGORY_IDX]
            session["by_category"].setdefault(cat, []).append(d)

    midi_in.set_callback(callback)
    midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
    midi_in.open_port(in_idx)
    midi_out.open_port(out_idx)
    time.sleep(0.3)

    counters = {"written": 0, "errors": 0, "i": 0}

    def on_slot(slot, body):
        i = counters["i"]
        counters["i"] += 1
        if body is None:
            counters["errors"] += 1
            device_protocol.emit(
                device_protocol.scan_slot(i, slot, f"slot{slot}", False, i + 1, total)
            )
            return
        name = fmt.read_name(body) or f"slot{slot}"
        safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in name)
        with open(os.path.join(args.outdir, f"{slot:03d}-{safe}.prst"), "wb") as f:
            f.write(body)
        counters["written"] += 1
        device_protocol.emit(device_protocol.scan_slot(i, slot, name, True, i + 1, total))

    run_scan(midi_out, session, range(args.start, args.end + 1), on_slot)

    midi_in.close_port()
    midi_out.close_port()
    device_protocol.emit(device_protocol.scan_done(counters["written"], counters["errors"], args.outdir))


if __name__ == "__main__":
    main()
