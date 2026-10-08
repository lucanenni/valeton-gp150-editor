#!/usr/bin/env python3
"""GP-150 CC experiment: does a manual-documented CC change show up in a live
read, and if so, where? Built on the proven pipeline in gp150_live_read.py
(read that first) — same requirements: Valeton Suite open and connected,
pyobjc-framework-Cocoa installed.

Only sends CC/PC messages the manual's own MIDI Control Information List
documents (p.77-78) — nothing experimental or guessed. This is standard
external-controller traffic, the same shape as what a real MIDI footswitch
sends during normal use; not a SysEx write, and no patch is ever saved by
these commands as far as we know (that's part of what this script tests).

Usage:
  python3 patch/gp150_cc_experiment.py tempo <bpm>     # CC73=0, CC74=bpm (40-127)
  python3 patch/gp150_cc_experiment.py module <cc> <on|off>  # CC48-59 module on/off

Method: read the target slot live (baseline) -> send the CC -> try reading
again without reselecting (does the device broadcast on its own?) -> if
nothing arrives, force a fresh broadcast by selecting a different slot then
back to the target -> diff both reads against each other and against the
corpus original.

**Known ceiling (found 2026-08-05, tempo test): the reselect fallback can
only ever observe genuinely patch-SAVED changes, never live-only
overrides.** Reselecting reloads the patch from saved memory, which reverts
any live override *before* the read happens — confirmed directly: a tempo
CC visibly changed the BPM on the pedal's own screen, but reverted the
instant the patch was reselected, and the before/after read (via the
reselect fallback) came back byte-for-byte identical as a direct
consequence, not because tempo isn't readable. If the "no reselect" branch
never gets a spontaneous broadcast (no trigger for that is known besides an
actual patch-select event), a "no change" result from this script means
"this CC doesn't get saved to the patch," not "this data isn't in the
readable body." Manual-documented footswitch-style CCs (module on/off,
tempo, EXP, Quick Access, Looper) are all plausible candidates for the same
live-only behavior — see design/GP150_SUPPORT.md §3.2 before
spending more runs on this without a new idea for observing live state.
"""

import glob
import os
import sys
import time

import rtmidi
from PyObjCTools import AppHelper

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patch import gp150_wire as wire  # noqa: E402

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# optional reference corpus (kept outside the repo): GP150_CORPUS_DIR/prst_export
CORPUS_DIR = os.path.join(os.path.expanduser(os.environ.get("GP150_CORPUS_DIR", "")), "prst_export")
OUTDIR = os.path.join(PROJECT_ROOT, "re", "gp150_captures", "cc_experiments")
LISTEN_SECONDS = 4.0
TARGET_SLOT = 0  # slot 0 of the reference corpus (001-New GEN.prst), when available


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


class Device:
    """One open MIDI in/out pair for the whole experiment (one persistent
    port, per the project's hardware-safety discipline)."""

    def __init__(self):
        self.midi_in = rtmidi.MidiIn()
        self.midi_out = rtmidi.MidiOut()
        in_ports = self.midi_in.get_ports()
        out_ports = self.midi_out.get_ports()
        in_idx = find_port_index(in_ports)
        out_idx = find_port_index(out_ports)
        print(f"input port {in_idx}: {in_ports[in_idx]!r}  output port {out_idx}: {out_ports[out_idx]!r}")
        self.by_category = {}
        self.midi_in.set_callback(self._callback)
        self.midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
        self.midi_in.open_port(in_idx)
        self.midi_out.open_port(out_idx)

    def _callback(self, event, data=None):
        message, _dt = event
        d = strip_f0_f7(bytes(message))
        if len(d) > wire.CHUNK_HEADER_LEN:
            self.by_category.setdefault(d[wire.CHUNK_CATEGORY_IDX], []).append(d)

    def send_cc(self, control, value):
        print(f"  send CC{control}={value}")
        self.midi_out.send_message([0xB0, control & 0x7F, value & 0x7F])
        time.sleep(0.05)

    def select_slot(self, slot):
        print(f"  select slot {slot} (CC0=0, PC={slot})")
        self.midi_out.send_message([0xB0, 0x00, 0x00])
        time.sleep(0.05)
        self.midi_out.send_message([0xC0, slot & 0x7F])
        time.sleep(0.05)

    def listen_and_reassemble(self, seconds=LISTEN_SECONDS):
        self.by_category = {}
        AppHelper.callLater(seconds, AppHelper.stopEventLoop)
        AppHelper.runConsoleEventLoop()
        for cat, msgs in self.by_category.items():
            try:
                return wire.reassemble_body(msgs)
            except ValueError:
                continue
        return None

    def close(self):
        self.midi_in.close_port()
        self.midi_out.close_port()


def diff_report(label_a, a, label_b, b):
    if a is None or b is None:
        print(f"  ({label_a} or {label_b} missing, can't diff)")
        return
    if a == b:
        print(f"  {label_a} == {label_b}: IDENTICAL, no change visible")
        return
    diffs = [i for i in range(min(len(a), len(b))) if a[i] != b[i]]
    print(f"  {label_a} vs {label_b}: {len(diffs)} differing bytes")
    clusters = [[diffs[0]]]
    for o in diffs[1:]:
        if o - clusters[-1][-1] <= 1:
            clusters[-1].append(o)
        else:
            clusters.append([o])
    for c in clusters:
        lo, hi = c[0], c[-1] + 1
        print(f"    [{hex(lo)}:{hex(hi)}]  {label_a}={a[max(0,lo-2):hi+2].hex(' ')}"
              f"  {label_b}={b[max(0,lo-2):hi+2].hex(' ')}")


def run(cc_messages: list, restore_messages: list):
    dev = Device()
    try:
        corpus_files = glob.glob(os.path.join(CORPUS_DIR, f"{TARGET_SLOT + 1:03d}-*.prst"))
        known = open(corpus_files[0], "rb").read() if corpus_files else None

        print(f"\n1. baseline: select slot {TARGET_SLOT}, read")
        dev.select_slot(TARGET_SLOT)
        baseline = dev.listen_and_reassemble()
        if baseline is None:
            print("NO baseline read. Is Suite open and connected? Stopping.")
            return
        if known:
            print("  baseline vs corpus original:", "MATCH" if baseline == known else "DIFFERS")

        print(f"\n2. send experimental CC(s): {cc_messages}")
        for control, value in cc_messages:
            dev.send_cc(control, value)

        print("\n3. read again WITHOUT reselecting (does it broadcast on its own?)")
        immediate = dev.listen_and_reassemble()
        if immediate is not None:
            print("  got a broadcast without reselecting.")
            diff_report("baseline", baseline, "after-CC (no reselect)", immediate)
        else:
            print("  nothing broadcast on its own — forcing a fresh read via reselect")
            other_slot = 1 if TARGET_SLOT != 1 else 2
            dev.select_slot(other_slot)
            dev.listen_and_reassemble(seconds=1.5)  # drain/ignore
            dev.select_slot(TARGET_SLOT)
            after = dev.listen_and_reassemble()
            diff_report("baseline", baseline, "after-CC (via reselect)", after)
            immediate = after

        print(f"\n4. restore: send {restore_messages}, reselect, read")
        for control, value in restore_messages:
            dev.send_cc(control, value)
        other_slot = 1 if TARGET_SLOT != 1 else 2
        dev.select_slot(other_slot)
        dev.listen_and_reassemble(seconds=1.5)
        dev.select_slot(TARGET_SLOT)
        restored = dev.listen_and_reassemble()
        diff_report("baseline", baseline, "after-restore", restored)

        os.makedirs(OUTDIR, exist_ok=True)
        for name, blob in (("baseline", baseline), ("after_cc", immediate), ("restored", restored)):
            if blob:
                path = os.path.join(OUTDIR, f"slot{TARGET_SLOT:02d}_{name}.prst")
                open(path, "wb").write(blob)
                print(f"wrote {path}")
    finally:
        dev.close()


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    mode = sys.argv[1]
    if mode == "tempo":
        bpm = int(sys.argv[2])
        if not 40 <= bpm <= 127:
            raise SystemExit("bpm must be 40-127 for this quick test (CC73=0 range)")
        # no natural "restore" value known ahead of time - just re-set a
        # different, equally-arbitrary tempo isn't meaningful; leave as is
        # (tempo is a low-stakes, easily-changed-back setting either way).
        run(cc_messages=[(73, 0), (74, bpm)], restore_messages=[])
    elif mode == "module":
        cc = int(sys.argv[2])
        state = sys.argv[3]
        if not 48 <= cc <= 59:
            raise SystemExit("module CC must be 48-59 (see manual p.77)")
        value = 0 if state == "off" else 127
        restore_value = 127 if state == "off" else 0
        run(cc_messages=[(cc, value)], restore_messages=[(cc, restore_value)])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
