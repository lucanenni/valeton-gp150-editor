#!/usr/bin/env python3
"""Cautious, read-only GP-150 probe — first contact with a device this codebase has
never talked to. Reuses live_read.py's proven codec (crc8, nibble framing,
reassemble, split_names) and its safety discipline (one persistent port, SETTLE
between requests, no tight loops, hard request cap). NEVER sends a write/commit
opcode. See design/GP150_SUPPORT.md and re/DEVICE_READ.md for the research
this builds on.

Run this from a normal venv with mido + python-rtmidi installed
(`pip install mido python-rtmidi`) — it needs real MIDI/USB access, which an
agent sandbox does not have.

Usage, IN ORDER — do not skip a stage:
  python3 patch/gp150_probe.py list       # zero-risk: just lists MIDI port names
  python3 patch/gp150_probe.py diag       # checks whether SysEx reception needs unblocking
                                           # (python-rtmidi ignores incoming SysEx by default)
  python3 patch/gp150_probe.py selftest   # ONE 0x40 request: reads the 100 patch names
  python3 patch/gp150_probe.py names      # same as selftest but prints every name
  python3 patch/gp150_probe.py raw        # ONE 0x40 request, logs EVERY message unfiltered
  python3 patch/gp150_probe.py pc N       # sends ONLY a Program Change to slot N (no SysEx)
  python3 patch/gp150_probe.py bankpc N   # manual-documented patch select: CC0=0 then PC=N (0-127)
  python3 patch/gp150_probe.py step DIR   # CC24 (DIR=-1, "Patch -") or CC25 (DIR=+1, "Patch +")
  python3 patch/gp150_probe.py capture N  # PC to slot N, one 0x41 body read, saves raw bytes
  python3 patch/gp150_probe.py read N     # THE REAL ONE: select slot N (CC0+PC), listen for
                                           # the body stream, reassemble it into a full .prst
                                           # body via gp150_wire.reassemble_body() -- this is
                                           # the live version of what design/GP150_SUPPORT.md
                                           # section 1.9 proved offline against saved captures.

`read` is the payoff of everything cracked so far (re/DEVICE_GP150.md,
patch/gp150_wire.py): select a patch, the device streams its body
unprompted, reassemble it. Writes the reconstructed 1128-byte body to
device_scan_gp150/, and if a same-slot file exists in
$GP150_CORPUS_DIR/prst_export/ (the Suite export corpus, kept outside the repo), diffs against it
as a sanity check — this is genuinely new, never confirmed live before.

Per the manual (p.77, MIDI Control Information List): plain Program Change alone
is NOT how this device selects patches — CC0 is the "PATCH MSB" and must be
sent first (001-128: CC0=0,PC=0-127; 129-200: CC0=1,PC=0-71). `bankpc` follows
that exactly. CC24/CC25 ("Patch -"/"Patch +") are a simpler, bank-free
increment/decrement — good for a first sanity check.

If `selftest` reports 0 reply frames, run `raw` next — it sends the exact same
single request but doesn't assume the reply comes back as a "sysex"-typed mido
message or on the same nibble framing; it just logs everything so we can see
what, if anything, the GP-150 actually sends back.

`capture` is deliberately single-slot per invocation (re-run it per slot you want,
by hand) rather than a full 100-slot loop — GP-150's selectors/timing are unproven,
so this stays manual and inspectable until a handful of slots come back sane.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patch import live_read  # noqa: E402 — reuse the proven codec + safety knobs

CATSEL, NAME_SEL, BODY_SEL = 0x12, 0x40, 0x41
OUTDIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "device_scan_gp150")


def find_gp150_port():
    """MIDI port name, confirmed live: the GP-150 enumerates as exactly
    "GP-150" (design/GP150_SUPPORT.md §3.2)."""
    try:
        in_names = live_read.mido.get_input_names()
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"no MIDI backend / no ports visible: {e}")
    for name in in_names:
        if "GP-150" in name:
            return name
    raise SystemExit(
        f"no GP-150-looking port found. Ports seen: {in_names!r}\n"
        "Run `list` and pass the exact name by editing find_gp150_port() if needed."
    )


def cmd_list():
    print("MIDI inputs: ", live_read.mido.get_input_names())
    print("MIDI outputs:", live_read.mido.get_output_names())


def unignore_sysex(inp) -> bool:
    """python-rtmidi's underlying RtMidi C++ library ignores incoming SysEx by
    default unless told not to. Symptom if this is the problem: outgoing
    CC/Program Change always works (the pedal visibly reacts) but NOT ONE
    SysEx message is ever received, even when we know the device sent some
    (MIDI Monitor saw them). Returns True if we found and cleared the flag."""
    rt = getattr(inp, "_rt", None) or getattr(inp, "midi_in", None)
    if rt is not None and hasattr(rt, "ignore_types"):
        rt.ignore_types(sysex=False, timing=True, active_sense=True)
        return True
    return False


def cmd_diag():
    """Print the mido backend in use and whether we could reach the
    underlying rtmidi object to un-ignore SysEx. Run this if `read`/`raw`
    keep getting 0 SysEx messages despite the pedal visibly reacting to
    CC/PC — that combination points at exactly this."""
    import mido

    print("mido backend module:", mido.backend.name if hasattr(mido, "backend") else "?")
    port = find_gp150_port()
    with mido.open_input(port) as inp:
        print("input port object type:", type(inp))
        print("has _rt:", hasattr(inp, "_rt"), " has midi_in:", hasattr(inp, "midi_in"))
        fixed = unignore_sysex(inp)
        print("unignore_sysex() succeeded:", fixed)


def _one_shot_read(port, selector, wait=2.5):
    """Send exactly one read request on `port` and return (buf, replies).
    Mirrors live_read.read_bank() but against an explicit port instead of the
    GP-5/GP-50 find_port() resolver."""
    import mido

    buf = live_read.build_request(selector)
    replies = []
    with mido.open_input(port) as inp, mido.open_output(port) as out:
        unignore_sysex(inp)
        time.sleep(0.15)
        for _ in inp.iter_pending():
            pass
        out.send(mido.Message("sysex", data=live_read.to_wire_data(buf)))
        t0 = last = time.time()
        while time.time() - t0 < wait:
            got = False
            for m in inp.iter_pending():
                if m.type == "sysex":
                    replies.append(live_read.nib_decode(list(m.bytes())[1:-1]))
                    got = True
            if got:
                last = time.time()
            elif time.time() - last > 0.4 and replies:
                break
            time.sleep(0.02)
    time.sleep(live_read.SETTLE)
    return buf, replies


def cmd_selftest(show_all=False):
    port = find_gp150_port()
    print(f"using port: {port!r}")
    buf, replies = _one_shot_read(port, NAME_SEL)
    print(f"sent one 0x40 request, got {len(replies)} reply frames")
    banks = live_read.reassemble(replies)
    if not banks:
        print("NO REPLY — device may use a different selector, or isn't the "
              "shared codec. Stop here and report back; do not blind-sweep.")
        return
    for cmd, blob in banks.items():
        print(f"  reply cmd={cmd:#04x}  {len(blob)} raw bytes")
        names = live_read.split_names(blob)
        print(f"  ~{len(names)} name records decoded")
        shown = names if show_all else names[:15]
        for slot, nm in shown:
            print(f"    slot {slot:3}: {nm!r}")


def cmd_raw(wait=4.0):
    """Send the exact same ONE 0x40 request as selftest, but log every message
    mido reports at all (any type, any framing) instead of filtering to sysex.
    Diagnostic only — still a single request, not a sweep."""
    import mido

    port = find_gp150_port()
    print(f"using port: {port!r}")
    buf = live_read.build_request(NAME_SEL)
    wire = "F0 " + " ".join(f"{x:02x}" for x in live_read.to_wire_data(buf)) + " F7"
    print(f"sending: {wire}")
    with mido.open_input(port) as inp, mido.open_output(port) as out:
        print("unignore_sysex():", unignore_sysex(inp))
        time.sleep(0.15)
        for m in inp.iter_pending():
            print(f"  (drained stale) {m}")
        out.send(mido.Message("sysex", data=live_read.to_wire_data(buf)))
        t0 = time.time()
        n = 0
        while time.time() - t0 < wait:
            for m in inp.iter_pending():
                n += 1
                print(f"  [{time.time() - t0:5.2f}s] {m!r}  raw={list(m.bytes())}")
            time.sleep(0.02)
    print(f"done — {n} messages received in {wait}s window")
    if n == 0:
        print(
            "Truly nothing came back. Next things to check (tell me, don't "
            "guess-send more): is the pedal showing anything on its screen "
            "when this runs? Does its manual mention a MIDI mode/thru setting "
            "that needs enabling? Is 'GP-150' definitely the right port (not "
            "an unrelated virtual port with a coincidental name)?"
        )


def cmd_pc(slot: int):
    """Send ONLY a standard MIDI Program Change — no SysEx at all. Lowest-risk
    possible transport check: if the pedal's active patch visibly changes,
    basic MIDI-in works and the problem is specific to our SysEx request
    (wrong selector/category bytes for this device); if nothing happens either,
    the issue is more likely device-side MIDI settings or channel/port routing."""
    import mido

    port = find_gp150_port()
    print(f"using port: {port!r} — sending Program Change {slot} (channel 0, OMNI-safe)")
    with mido.open_output(port) as out:
        out.send(mido.Message("program_change", program=slot & 0x7F))
    print("sent. Check the pedal screen: did the active patch change?")


def cmd_bankpc(slot: int):
    """Manual-documented patch select (p.77): CC0 (PATCH MSB) then Program
    Change. slot is 0-127 (bank 001-128); CC0=0 covers that whole range."""
    import mido

    port = find_gp150_port()
    print(f"using port: {port!r} — CC0=0 then PC={slot}")
    with mido.open_output(port) as out:
        out.send(mido.Message("control_change", control=0, value=0))
        time.sleep(0.05)
        out.send(mido.Message("program_change", program=slot & 0x7F))
    print("sent. Check the pedal screen: did the active patch change?")


def cmd_step(direction: int):
    """CC24 ('Patch -', direction<0) or CC25 ('Patch +', direction>0) — the
    manual's bank-free increment/decrement, simplest possible sanity check."""
    import mido

    cc = 25 if direction > 0 else 24
    port = find_gp150_port()
    print(f"using port: {port!r} — sending CC{cc} ({'Patch +' if cc == 25 else 'Patch -'})")
    with mido.open_output(port) as out:
        out.send(mido.Message("control_change", control=cc, value=127))
    print("sent. Check the pedal screen: did the active patch change by one?")


def cmd_capture(slot: int):
    os.makedirs(OUTDIR, exist_ok=True)
    port = find_gp150_port()
    import mido

    print(f"using port: {port!r} — selecting slot {slot} via Program Change")
    with mido.open_output(port) as out:
        out.send(mido.Message("program_change", program=slot & 0x7F))
    time.sleep(0.30)  # same settle margin as scan_bank.py's proven cadence
    buf, replies = _one_shot_read(port, BODY_SEL)
    banks = live_read.reassemble(replies)
    if not banks:
        print("NO REPLY on 0x41 — stop; report back before retrying.")
        return
    blob = max(banks.values(), key=len)
    if blob[:2] == bytes([CATSEL, BODY_SEL]):
        blob = blob[2:]
    path = os.path.join(OUTDIR, f"slot{slot:02d}_body_{len(blob)}b.bin")
    open(path, "wb").write(blob)
    print(f"wrote {path} ({len(blob)} bytes) — raw body, container layout unknown yet")


def cmd_read(slot: int, wait: float = 3.0):
    """Select `slot` (CC0+PC) then listen for the SysEx body stream it
    triggers, and reassemble it with gp150_wire.reassemble_body(). One
    persistent port for the whole operation, bounded wait, no retry loop —
    same discipline as the rest of this file. Whatever category tag the
    device happens to use this time is fine (design/GP150_SUPPORT.md
    1.7: it rotates per transaction) — every category seen is reassembled
    and the first one that decodes cleanly wins."""
    import mido

    from patch import gp150_wire as wire

    os.makedirs(OUTDIR, exist_ok=True)
    port = find_gp150_port()
    print(f"using port: {port!r} — selecting slot {slot} (CC0+PC), then listening {wait}s")

    by_category = {}
    with mido.open_input(port) as inp, mido.open_output(port) as out:
        fixed = unignore_sysex(inp)
        print(f"unignore_sysex(): {fixed}")
        for _ in inp.iter_pending():
            pass  # drain stale
        out.send(mido.Message("control_change", control=0, value=0))
        time.sleep(0.05)
        out.send(mido.Message("program_change", program=slot & 0x7F))

        t0 = last = time.time()
        while time.time() - t0 < wait:
            got = False
            for m in inp.iter_pending():
                if m.type == "sysex":
                    d = bytes(m.data)
                    if len(d) > wire.CHUNK_HEADER_LEN:
                        by_category.setdefault(d[wire.CHUNK_CATEGORY_IDX], []).append(d)
                    got = True
            if got:
                last = time.time()
            elif time.time() - last > 0.5 and by_category:
                break
            time.sleep(0.02)
    time.sleep(live_read.SETTLE)

    if not by_category:
        print("NO SysEx received — stop; report back before retrying.")
        return None

    body = None
    for cat, msgs in by_category.items():
        try:
            body = wire.reassemble_body(msgs)
        except ValueError as e:
            print(f"  category {cat:#04x} ({len(msgs)} chunks): {e}")
            continue
        print(f"  category {cat:#04x}: reassembled {len(body)} bytes OK")
        break

    if body is None:
        print("Got SysEx but nothing reassembled cleanly — report back, don't retry blindly.")
        return None

    path = os.path.join(OUTDIR, f"slot{slot:02d}_live.prst")
    open(path, "wb").write(body)
    print(f"wrote {path}")

    # optional reference corpus (kept outside the repo): GP150_CORPUS_DIR/prst_export
    corpus_dir = os.path.join(os.path.expanduser(os.environ.get("GP150_CORPUS_DIR", "")), "prst_export")
    import glob

    candidates = glob.glob(os.path.join(corpus_dir, f"{slot + 1:03d}-*.prst"))
    if candidates:
        known = open(candidates[0], "rb").read()
        if known == body:
            print(f"MATCHES the Suite export ({os.path.basename(candidates[0])}) byte-for-byte.")
        else:
            diffs = sum(1 for a, b in zip(known, body) if a != b)
            print(
                f"DOES NOT MATCH {os.path.basename(candidates[0])}: {diffs} differing bytes "
                "— report back with this output, don't retry blindly."
            )
    return body


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "list"
    if mode == "list":
        cmd_list()
    elif mode == "diag":
        cmd_diag()
    elif mode == "selftest":
        cmd_selftest(show_all=False)
    elif mode == "names":
        cmd_selftest(show_all=True)
    elif mode == "raw":
        cmd_raw()
    elif mode == "pc":
        cmd_pc(int(sys.argv[2]))
    elif mode == "bankpc":
        cmd_bankpc(int(sys.argv[2]))
    elif mode == "step":
        cmd_step(int(sys.argv[2]))
    elif mode == "capture":
        cmd_capture(int(sys.argv[2]))
    elif mode == "read":
        cmd_read(int(sys.argv[2]))
    else:
        raise SystemExit(__doc__)
