#!/usr/bin/env python3
"""GP-150 catalog/info reads — the other 6 requests from Suite's startup
handshake, replayed the same way `gp150_wake_replay.py` replays request
0x01 (the active-patch body): exact bytes copied verbatim (via plistlib)
from `re/gp150_captures/startup_sequence.mmon`, a real captured Suite
connection, wrapped in F0/F7 and sent as-is. See patch/gp150_catalog.py
and design/GP150_SUPPORT.md §3.2 for the request/reply
catalog this is built from.

STATUS: `names` CONFIRMED WORKING live (2026-09-03) — decoded all 200 real
patch names, matching the corpus exactly, 0 mismatches. Unlike
gp150_wake_replay.py's request (cross-checked against a SECOND independent
capture), these 6 have only ever been seen in this one capture — still a
verbatim replay of exact previously-working bytes, not a guess, but with
less redundancy behind it. Read-only requests, same risk class as
everything else this project sends.

Run with Suite fully closed:
  python3 patch/gp150_read_catalog.py CATEGORY [--listen SECONDS] [--no-warm-info]

CATEGORY is one of: info, names, settings, firmware, user_irs, snaptones
("names" is the only one with a real decoder — patch/gp150_catalog.
decode_all_names() — the rest just get their raw bytes saved plus a
best-effort dump of printable ASCII runs, since their record layouts
haven't been decoded yet; also untested live — 'names' is the
only category actually run so far).

**Real finding (2026-09-03): a bare request alone isn't enough for
'names'.** First attempt got only an 8-byte ack (byte6=0x02, echoing our
request's own category — the same ack shape seen mid-stream in successful
body reads) and no actual reply even with `--listen 10`. Sending the
'info' (0x00) request first, settling, THEN the real request — matching
the order every request always has in Suite's own captured startup
handshake — got an immediate, correct, complete reply. This is now the
DEFAULT behavior (`--no-warm-info` to skip it). Untested whether the other
4 uncontacted categories need it too, but there's no reason to expect they
don't, so it's on for all of them, not just `names`.

Interesting wire-level detail from that successful run: the info reply
AND the names reply were both tagged the SAME category (`0x01`) in this
session — categories really are just a live per-connection counter, not a
fixed selector per request type (matches everything else found about them
in design/GP150_SUPPORT.md §3.2), and can repeat across
distinct request/reply pairs within one session, not just within retries
of the same one.
"""

import argparse
import os
import re
import sys
import time

import rtmidi
from PyObjCTools import AppHelper

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patch import gp150_catalog as catalog  # noqa: E402
from patch import gp150_wire as wire  # noqa: E402
from patch.gp150_wake_replay import strip_f0_f7  # noqa: E402

# Exact bytes of each "To GP-150" request in re/gp150_captures/
# startup_sequence.mmon, in the order Suite sends them — copied via
# plistlib, not typed by hand.
REQUESTS = {
    "info": [127, 37, 12, 0, 0, 0, 0, 0, 0, 1, 5, 3, 0, 8, 0, 0, 0, 3, 0, 1, 7, 0, 1, 0, 7, 0, 1, 0, 0, 2, 0, 0],
    "names": [127, 124, 12, 0, 0, 0, 2, 0, 0, 1, 8, 14, 0, 8, 0, 0, 0, 3, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 2, 0, 0],
    "settings": [127, 111, 12, 0, 0, 0, 3, 0, 0, 1, 2, 14, 0, 8, 0, 0, 0, 3, 0, 1, 8, 0, 1, 0, 8, 0, 1, 0, 0, 2, 0, 0],
    "firmware": [127, 69, 12, 0, 0, 0, 4, 0, 0, 1, 6, 0, 0, 8, 0, 0, 0, 3, 0, 2, 0, 0, 2, 0, 0, 0, 2, 0, 0, 2, 0, 0],
    "user_irs": [127, 81, 12, 0, 0, 0, 5, 0, 0, 1, 0, 12, 0, 8, 0, 0, 0, 3, 0, 1, 4, 2, 1, 0, 4, 2, 1, 0, 0, 2, 0, 0],
    "snaptones": [127, 97, 12, 0, 0, 0, 6, 0, 0, 1, 11, 1, 0, 8, 0, 0, 0, 3, 0, 1, 5, 2, 1, 0, 5, 2, 1, 0, 0, 2, 0, 0],
}

LISTEN_SECONDS = 5.0


def find_port_index(ports, wanted=("GP-150",)):
    for i, p in enumerate(ports):
        if any(w in p for w in wanted):
            return i
    raise SystemExit(f"no GP-150-looking port found in {ports!r}")


def printable_runs(data: bytes, min_len: int = 4):
    """Best-effort: find printable-ASCII runs of at least `min_len` bytes.
    Not a real decoder — just a starting point for eyeballing an
    undecoded category's content."""
    return [m.group().decode() for m in re.finditer(rb"[\x20-\x7e]{%d,}" % min_len, data)]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("category", choices=sorted(REQUESTS))
    ap.add_argument(
        "--listen", type=float, default=LISTEN_SECONDS,
        help=f"seconds to listen (default {LISTEN_SECONDS}) — try longer for a bigger "
        "reply (e.g. names is 4x the size of a patch body)",
    )
    ap.add_argument(
        "--no-warm-info", dest="warm_info", action="store_false",
        help="skip sending the 'info' (0x00) request first. On by default since "
        "2026-09-03: confirmed live that 'names' gets no reply at all without "
        "it (an 8-byte ack and nothing else, even with --listen 10) but works "
        "immediately with it — untested whether the other categories need it "
        "too, but there's no reason to expect they don't.",
    )
    args = ap.parse_args()
    request_bytes = REQUESTS[args.category]

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

    time.sleep(0.5)
    if args.warm_info and args.category != "info":
        print(f"\n--warm-info: sending the 'info' request first ({len(REQUESTS['info'])} bytes)...")
        midi_out.send_message([0xF0] + list(REQUESTS["info"]) + [0xF7])
        time.sleep(0.3)

    print(f"\nSending the '{args.category}' request ({len(request_bytes)} bytes + F0/F7 framing)...")
    midi_out.send_message([0xF0] + list(request_bytes) + [0xF7])

    print(f"Listening {args.listen}s...")
    AppHelper.callLater(args.listen, AppHelper.stopEventLoop)
    AppHelper.runConsoleEventLoop()

    midi_in.close_port()
    midi_out.close_port()

    if not by_category:
        print("\nNO reply. Informative, not a failure — report this back rather than retrying blindly.")
        return

    print(f"\nGot replies in {len(by_category)} categor(y/ies): {[hex(c) for c in by_category]}")
    for cat, msgs in by_category.items():
        try:
            stream = wire.reassemble_first_burst_stream(msgs)
        except ValueError as e:
            print(f"  category {cat:#04x} ({len(msgs)} chunks): couldn't reassemble cleanly ({e})")
            continue
        print(f"  category {cat:#04x}: reassembled {len(stream)} bytes")

        outdir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "device_scan_gp150")
        os.makedirs(outdir, exist_ok=True)
        path = os.path.join(outdir, f"catalog_{args.category}_{len(stream)}b.bin")
        open(path, "wb").write(stream)
        print(f"  wrote {path}")

        if args.category == "names":
            try:
                names = catalog.decode_all_names(stream)
                print(f"  decoded {len(names)} names, first 5: {names[:5]}")
            except ValueError as e:
                print(f"  decode_all_names() failed: {e}")
        else:
            runs = printable_runs(stream)
            print(f"  printable ASCII runs found (best-effort, not a real decode): {runs[:20]}")


if __name__ == "__main__":
    main()
