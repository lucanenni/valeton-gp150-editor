"""Tiny MIDI bridge for the Node spike: talks to the GP-150 over CoreMIDI with python-rtmidi
(the combination patch/gp150_live_read.py proved: raw python-rtmidi + a pumped run loop) and
speaks newline-delimited JSON on stdin/stdout.

  stdin : {"op":"ports"} | {"op":"open","in":N,"out":M} | {"op":"send","bytes":[...]} | {"op":"close"}
  stdout: {"ev":"ports","in":[...],"out":[...]} | {"ev":"opened"} | {"ev":"midi","bytes":[...]} | {"ev":"error","msg":...}

Run with .venv-midi/bin/python (needs python-rtmidi and pyobjc-framework-Cocoa)."""
import json
import sys
import threading

import rtmidi
from PyObjCTools import AppHelper

midi_in = rtmidi.MidiIn()
midi_out = rtmidi.MidiOut()
lock = threading.Lock()


def emit(obj):
    with lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def on_midi(event, data=None):
    message, _dt = event
    emit({"ev": "midi", "bytes": list(message)})


def handle(cmd):
    op = cmd.get("op")
    if op == "ports":
        emit({"ev": "ports", "in": midi_in.get_ports(), "out": midi_out.get_ports()})
    elif op == "open":
        midi_in.set_callback(on_midi)
        midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
        midi_in.open_port(int(cmd["in"]))
        midi_out.open_port(int(cmd["out"]))
        emit({"ev": "opened"})
    elif op == "send":
        midi_out.send_message(cmd["bytes"])
    elif op == "close":
        for p in (midi_in, midi_out):
            try:
                p.close_port()
            except Exception:
                pass
        AppHelper.callAfter(AppHelper.stopEventLoop)


def reader():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as e:  # noqa: BLE001
            emit({"ev": "error", "msg": f"{type(e).__name__}: {e}"})
    AppHelper.callAfter(AppHelper.stopEventLoop)


threading.Thread(target=reader, daemon=True).start()
AppHelper.runConsoleEventLoop()
