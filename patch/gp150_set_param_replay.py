#!/usr/bin/env python3
"""GP-150 set-param + save live sender — GP150-6.

STATUS: prepared, NOT yet run — no hardware/USB access in this sandbox.

Built entirely from real captured Suite traffic
(re/gp150_captures/live_edit/*.mmon), decoded and analyzed in
design/GP150_SUPPORT.md §3.1 — never guessed. Five message
families, all single un-chunked SysEx messages (see
patch/gp150_set_param.py's docstring for the full byte layout, the
per-module MODULE_TAGS table, and the fxid encoding model-swap relies on):

  set-param    change one parameter on one module, live (RAM only until
               saved).
  save         persist the device's current live state to a slot, under a
               name — no patch content, no checksum: the device already
               holds the state from the preceding set-param edits.
  model-swap   change which model is loaded into a module (any fxid from
               fxid_ring_gp150.json, no separate id table needed).
  enable       turn a whole module on or off.
  reorder      change the whole 12-module signal-chain order in one shot.

Modes, in the order this project's write-path discipline requires
(capture-first, THEN build, THEN validate byte-for-byte LIVE, THEN
deviate — re/DEVICE_WRITE.md):

  verify-param MODULE       Replay MODULE's captured set-param message
                             byte-for-byte, unmodified (same algid/value
                             it was originally captured with). Idempotent
                             and safe — the pedal already has this exact
                             value. Do this for a module before ever using
                             'set' on it for the first time.

  verify-save                Replay the captured save message byte-for-byte
                             (slot 199, name "UK900 DIST"). Idempotent:
                             slot 199 already holds exactly this. Do this
                             before ever using 'save' with different args.

  verify-model-swap MODULE   Replay MODULE's captured model-swap message
                             byte-for-byte (CAB -> "Foxy 1x12" or
                             NS -> "Match 35 CL", whichever MODULE was
                             captured). Idempotent if the pedal is already
                             on that model; do this before 'model-swap'.

  verify-enable              Replay the captured enable message byte-for-byte
                             (NS module, turned on). Do this before 'enable'.

  set MODULE ALGID VALUE    Build and send a NEW set-param message —
                             deviates from the capture (a different algid
                             and/or value). Live-only: nothing is written
                             to flash until 'save' is sent. Read the
                             module back afterward with
                             patch/gp150_wake_select_read.py to confirm.

  save --slot N --name S    Build and send a NEW save/commit message —
                             persists whatever is currently live to slot N
                             under name S. N must not be 199 (that's the
                             'verify-save' slot) — pick an empty/scratch
                             slot you don't mind overwriting.

  model-swap MODULE FXID    Build and send a NEW model-swap message —
                             switches MODULE to the model with this fxid
                             (look it up in fxid_ring_gp150.json).

  enable MODULE on|off      Build and send a NEW enable/disable message.

  reorder M1 M2 ... M12     Build and send a NEW chain-reorder message —
                             all 12 module names, space-separated, in the
                             new order (e.g. "NR PRE WAH DST NS AMP CAB
                             EQ MOD DLY VOL RVB").

Every mode requires --confirm on the command line, matching this
project's existing gated-send convention (gp150_write_replay.py).

**Live status (2026-09-08): 'verify-*' modes work reliably (byte-for-byte
replay of a real capture always gets applied). The non-verify modes
(set/save/model-swap/enable/reorder) do NOT currently work for genuinely
new content — see design/GP150_SUPPORT.md §3.1, "the
session/handshake diagnosis was wrong."** The real remaining gate is the
raw header's `tag` byte: extensive live testing shows it must exactly
match whatever Suite's own client generated for that specific real
transmission, and it isn't a computable function of the message content
(ruled out via a 55-sample CRC-8 sweep and an identical-payload/
different-tag counter-example) — this project doesn't yet know how to
mint a `tag` the device will accept for new content. model-swap/enable/
reorder are built and offline-validated but have NOT been live-tested at
all; don't expect any of the non-verify modes to work until this is
cracked.

Run with Suite fully closed:
  python3 patch/gp150_set_param_replay.py verify-param AMP --confirm
  python3 patch/gp150_set_param_replay.py verify-save --confirm
  python3 patch/gp150_set_param_replay.py verify-model-swap CAB --confirm
  python3 patch/gp150_set_param_replay.py verify-enable --confirm
  python3 patch/gp150_set_param_replay.py verify-reorder --confirm
  python3 patch/gp150_set_param_replay.py set AMP 0 65.0 --confirm
  python3 patch/gp150_set_param_replay.py save --slot 190 --name "Test Patch" --confirm
  python3 patch/gp150_set_param_replay.py model-swap CAB 436208080 --confirm
  python3 patch/gp150_set_param_replay.py enable NS on --confirm
  python3 patch/gp150_set_param_replay.py reorder NR PRE WAH DST NS AMP CAB EQ MOD DLY VOL RVB --confirm
"""

import argparse
import os
import random
import sys
import time

import rtmidi
from PyObjCTools import AppHelper

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from patch.gp150_set_param import (  # noqa: E402
    CAPTURED_ENABLE_MODULE,
    CAPTURED_ENABLE_ON,
    CAPTURED_ENABLE_TEMPLATE,
    CAPTURED_MODEL_SWAP_TARGET_FXID,
    CAPTURED_MODEL_SWAP_TEMPLATES,
    CAPTURED_REORDER_ORDER,
    CAPTURED_REORDER_TEMPLATE,
    CAPTURED_SAVE_NAME,
    CAPTURED_SAVE_SLOT,
    CAPTURED_SAVE_TEMPLATE,
    CAPTURED_TEMPLATES,
    MODULE_TAGS,
    build_enable_message,
    build_model_swap_message,
    build_reorder_message,
    build_save_message,
    build_set_param_message,
)


def fresh_tag_counter():
    """A placeholder (tag, counter) pair — NOT known to work.

    Both bytes 7-bit-safe (0-127, since these two raw header bytes are
    sent as literal SysEx data bytes, not nibble-encoded like the
    payload — a real bug fixed 2026-09-08, this used to generate 0-255
    and could emit MIDI-invalid bytes with the high bit set).

    That said: live testing 2026-09-08 (design/GP150_SUPPORT.md's
    GP150-6 section, "the session/handshake diagnosis was wrong") found
    that NO independently-chosen (tag, counter) pair has ever worked,
    7-bit-safe or not, correct-counter-sequence or not — only replaying
    a real, verbatim (tag, counter, payload) triple that Suite itself
    generated is confirmed to work. This function exists for callers
    that want *a* value while that mystery remains open; don't treat a
    successful send as proof the pair was "correct" until this is
    actually cracked."""
    return random.randint(0, 127), random.randint(0, 127)


def find_port_index(ports, wanted=("GP-150",)):
    for i, p in enumerate(ports):
        if any(w in p for w in wanted):
            return i
    raise SystemExit(f"no GP-150-looking port found in {ports!r}")


def send_message(midi_out, midi_in, message, listen_seconds=3.0):
    midi_out.send_message([0xF0] + message + [0xF7])

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
    print(f"Listening {listen_seconds}s for the device's reply...")
    AppHelper.callLater(listen_seconds, AppHelper.stopEventLoop)
    AppHelper.runConsoleEventLoop()
    midi_in.set_callback(None)
    return replies


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="mode", required=True)

    p_vp = sub.add_parser("verify-param", help="replay a module's captured set-param message unmodified")
    p_vp.add_argument("module", choices=sorted(MODULE_TAGS))
    p_vp.add_argument("--confirm", action="store_true", required=True)

    p_vs = sub.add_parser("verify-save", help="replay the captured save message unmodified (slot 199)")
    p_vs.add_argument("--confirm", action="store_true", required=True)

    p_set = sub.add_parser("set", help="build and send a NEW set-param message")
    p_set.add_argument("module", choices=sorted(MODULE_TAGS))
    p_set.add_argument("algid", type=int, help="target param's algId, from fxid_ring_gp150.json")
    p_set.add_argument("value", type=float, help="new value")
    p_set.add_argument("--tag", type=int, default=None, help="override the (tag,counter) auto-generation; 0-255")
    p_set.add_argument("--counter", type=int, default=None, help="override the (tag,counter) auto-generation; 0-255")
    p_set.add_argument("--confirm", action="store_true", required=True)

    p_save = sub.add_parser("save", help="build and send a NEW save/commit message")
    p_save.add_argument("--slot", type=int, required=True, help="0-indexed target slot; must not be 199 (that's verify-save's slot)")
    p_save.add_argument("--name", required=True, help="patch name, ASCII, max 16 bytes")
    p_save.add_argument("--tag", type=int, default=None, help="override the (tag,counter) auto-generation; 0-255")
    p_save.add_argument("--counter", type=int, default=None, help="override the (tag,counter) auto-generation; 0-255")
    p_save.add_argument("--confirm", action="store_true", required=True)

    p_vms = sub.add_parser("verify-model-swap", help="replay a module's captured model-swap message unmodified")
    p_vms.add_argument("module", choices=sorted(CAPTURED_MODEL_SWAP_TEMPLATES))
    p_vms.add_argument("--confirm", action="store_true", required=True)

    p_ve = sub.add_parser("verify-enable", help="replay the captured enable message unmodified")
    p_ve.add_argument("--confirm", action="store_true", required=True)

    p_ms = sub.add_parser("model-swap", help="build and send a NEW model-swap message")
    p_ms.add_argument("module", choices=sorted(MODULE_TAGS))
    p_ms.add_argument("fxid", type=int, help="target model's fxid, from fxid_ring_gp150.json")
    p_ms.add_argument("--tag", type=int, default=None)
    p_ms.add_argument("--counter", type=int, default=None)
    p_ms.add_argument("--confirm", action="store_true", required=True)

    p_en = sub.add_parser("enable", help="build and send a NEW enable/disable message")
    p_en.add_argument("module", choices=sorted(MODULE_TAGS))
    p_en.add_argument("state", choices=("on", "off"))
    p_en.add_argument("--tag", type=int, default=None)
    p_en.add_argument("--counter", type=int, default=None)
    p_en.add_argument("--confirm", action="store_true", required=True)

    p_vr = sub.add_parser("verify-reorder", help="replay the captured chain-reorder message unmodified")
    p_vr.add_argument("--confirm", action="store_true", required=True)

    p_ro = sub.add_parser("reorder", help="build and send a NEW chain-reorder message")
    p_ro.add_argument("order", nargs=12, metavar="MODULE", choices=sorted(MODULE_TAGS),
                       help="all 12 module names, space-separated, in the new order")
    p_ro.add_argument("--tag", type=int, default=None)
    p_ro.add_argument("--counter", type=int, default=None)
    p_ro.add_argument("--confirm", action="store_true", required=True)

    args = ap.parse_args()

    if args.mode == "verify-param":
        tags = MODULE_TAGS[args.module]
        message = list(CAPTURED_TEMPLATES[args.module])
        print(f"VERIFY-PARAM: replaying {args.module}'s captured message byte-for-byte "
              f"(algid={tags['captured_algid']}, value={tags['captured_value']}).")
    elif args.mode == "verify-save":
        message = list(CAPTURED_SAVE_TEMPLATE)
        print(f"VERIFY-SAVE: replaying the captured save message byte-for-byte "
              f"(slot={CAPTURED_SAVE_SLOT}, name={CAPTURED_SAVE_NAME!r}).")
    elif args.mode == "verify-model-swap":
        message = list(CAPTURED_MODEL_SWAP_TEMPLATES[args.module])
        print(f"VERIFY-MODEL-SWAP: replaying {args.module}'s captured message byte-for-byte "
              f"(target fxid={CAPTURED_MODEL_SWAP_TARGET_FXID[args.module]}).")
    elif args.mode == "verify-enable":
        message = list(CAPTURED_ENABLE_TEMPLATE)
        print(f"VERIFY-ENABLE: replaying the captured message byte-for-byte "
              f"({CAPTURED_ENABLE_MODULE} -> {'on' if CAPTURED_ENABLE_ON else 'off'}).")
    elif args.mode == "set":
        tag, counter = args.tag, args.counter
        if tag is None and counter is None:
            tag, counter = fresh_tag_counter()
        message = build_set_param_message(args.module, args.algid, args.value, tag=tag, counter=counter)
        print(f"SET: {args.module} algid={args.algid} -> {args.value} (live/RAM only, not saved).")
        print(f"  using fresh tag={tag:#04x} counter={counter:#04x} (see gp150_set_param.py docstring: "
              f"reusing the last-sent pair gets silently ignored by the device).")
    elif args.mode == "save":
        if args.slot == CAPTURED_SAVE_SLOT:
            raise SystemExit(f"refusing: slot {CAPTURED_SAVE_SLOT} is the 'verify-save' slot — pick a different, empty slot")
        if not (0 <= args.slot <= 199):
            raise SystemExit(f"slot must be 0-199, got {args.slot}")
        tag, counter = args.tag, args.counter
        if tag is None and counter is None:
            tag, counter = fresh_tag_counter()
        message = build_save_message(args.slot, args.name, tag=tag, counter=counter)
        print(f"SAVE: persisting current live state to slot {args.slot} as {args.name!r}.")
        print(f"  using fresh tag={tag:#04x} counter={counter:#04x}.")
        print("Make sure this slot is genuinely empty/scratch — this really writes to it.")
    elif args.mode == "model-swap":
        tag, counter = args.tag, args.counter
        if tag is None and counter is None:
            tag, counter = fresh_tag_counter()
        message = build_model_swap_message(args.module, args.fxid, tag, counter)
        print(f"MODEL-SWAP: {args.module} -> fxid {args.fxid}.")
        print(f"  using fresh tag={tag:#04x} counter={counter:#04x}.")
    elif args.mode == "enable":
        tag, counter = args.tag, args.counter
        if tag is None and counter is None:
            tag, counter = fresh_tag_counter()
        on = args.state == "on"
        message = build_enable_message(args.module, on, tag, counter)
        print(f"ENABLE: {args.module} -> {'on' if on else 'off'}.")
        print(f"  using fresh tag={tag:#04x} counter={counter:#04x}.")
    elif args.mode == "verify-reorder":
        message = list(CAPTURED_REORDER_TEMPLATE)
        print(f"VERIFY-REORDER: replaying the captured message byte-for-byte "
              f"(order={CAPTURED_REORDER_ORDER}).")
    else:  # reorder
        tag, counter = args.tag, args.counter
        if tag is None and counter is None:
            tag, counter = fresh_tag_counter()
        message = build_reorder_message(args.order, tag, counter)
        print(f"REORDER: {args.order}.")
        print(f"  using fresh tag={tag:#04x} counter={counter:#04x}.")

    print("Make sure Valeton Suite is CLOSED.")

    midi_in = rtmidi.MidiIn()
    midi_out = rtmidi.MidiOut()
    in_ports, out_ports = midi_in.get_ports(), midi_out.get_ports()
    in_idx, out_idx = find_port_index(in_ports), find_port_index(out_ports)
    print(f"input port {in_idx}: {in_ports[in_idx]!r}  output port {out_idx}: {out_ports[out_idx]!r}")
    midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
    midi_in.open_port(in_idx)
    midi_out.open_port(out_idx)

    time.sleep(0.5)
    send_message(midi_out, midi_in, message)

    midi_in.close_port()
    midi_out.close_port()

    if args.mode in ("set", "verify-param", "model-swap", "verify-model-swap", "enable"):
        print(f"\nNow read {args.module}'s current slot back to confirm (Suite closed, or via /gp150 in a browser).")
    elif args.mode == "verify-enable":
        print(f"\nNow read {CAPTURED_ENABLE_MODULE}'s current slot back to confirm.")
    elif args.mode in ("reorder", "verify-reorder"):
        print("\nNow read the current slot back to confirm the new chain order (Suite closed, or via /gp150 in a browser).")
    elif args.mode == "save":
        print(f"\nNow read slot {args.slot} back to confirm the save persisted:")
        print(f"  python3 patch/gp150_wake_select_read.py {args.slot}")


if __name__ == "__main__":
    main()
