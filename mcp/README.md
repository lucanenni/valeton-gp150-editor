# GP-150 MCP server

Lets Claude Code (or any MCP client) look at and, later, program a Valeton GP-150. It reuses the
browser modules in `app/static/` unchanged: `webmidi_gp150.js` runs in Node through a small Web
MIDI shim (`lib/webmidi_node_shim.mjs`) that talks to a Python helper (`lib/python_midi_bridge.py`,
python-rtmidi on CoreMIDI, from `.venv-midi`).

## Tools

| tool | touches the pedal | what it does |
|---|---|---|
| `search_models` | no | search the 306-model catalog by module and words (name, emulated gear, type) |
| `describe_model` | no | one model with every parameter (range, default, unit, named options) |
| `list_presets` | reads | the 200 preset names in one request |
| `read_active_patch` | reads | decode the preset that is active on the pedal (chain, models, parameters) |
| `read_patch` | reads | read and decode any slot 1–200 by index (~40 ms); the active preset and the front panel are not touched |
| `edit_patch` | no | modified copy of a patch from `read_patch` / `read_active_patch` / `build_patch` (name, chain, module model/on-off/parameters by name); lists exactly what changed |
| `build_patch` | no | build a patch from a description (module → model name + parameters by name); validated, decoded back, returns a `patch_id` |
| `list_library` | reads | the pedal's SnapTones, NAM models or User IRs: slot, name, and whether the slot was ever written (free slots are the safe targets) |
| `find_usage` | reads | which presets use a SnapTone / NAM / User IR slot (first call reads the 200 presets by index, ~40 s; later calls only what changed) |
| `upload_ir` | **writes** | a PCM `.wav` → User IR slot 1–20 (first 2048 samples, ~46 ms), re-reads the list to confirm |
| `upload_nam` | **writes** | an "A2 Lite" `.nam` (1871-weight lite WaveNet) → NAM slot 1–20, confirmed by re-reading |
| `upload_snaptone` | **writes** | a ready `.clo` → SnapTone slot 51–100, confirmed by re-reading |
| `create_snaptone_from_nam` | **writes** | runs a 48 kHz `.nam` on the built-in 70 s test signal, profiles it and uploads the SnapTone (~20–40 s; worker threads) |
| `export_reference_signal` | no | writes the 70 s test signal as `reference.wav` (play it through an amp and record it) |
| `create_snaptone_from_recording` | **writes** | profiles a recording of that signal played through your amp and uploads the SnapTone |
| `write_patch` | **writes** | overwrite one preset slot with a built patch, without selecting it; only slots in the allowed list (default 190–199, `GP150_WRITABLE_SLOTS`), then re-reads the names to confirm |

## Which library slots a tool may write

The library uploads only write to slots that were **never written** (they read back as "Empty …" / "User IR n"). To
overwrite a slot that holds something, list it in the matching variable when registering the server, e.g.

    claude mcp add gp150 -e GP150_OVERWRITABLE_SNAPTONE_SLOTS=52,65-66 -- node /absolute/path/to/mcp/server.mjs

(`GP150_OVERWRITABLE_SNAPTONE_SLOTS`, `GP150_OVERWRITABLE_NAM_SLOTS`, `GP150_OVERWRITABLE_IR_SLOTS`). SnapTone slots 1–50
are factory and never writable. A SnapTone slot is shared: every preset that points at it changes — ask `find_usage` first.

## Tests

`npm test` runs the catalog, builder/editor and upload checks offline (no pedal needed): slot rules, input parsing, the
upload flow against a fake pedal, and the worker-thread profiler and NAM renderer (a NAM → SnapTone build included).

## Setup

    cd mcp && npm install
    claude mcp add gp150 -- node /absolute/path/to/mcp/server.mjs

Needs macOS, the GP-150 on USB, Valeton Suite closed, and the repo's `.venv-midi`
(`python-rtmidi`, `pyobjc-framework-Cocoa`; override the interpreter with `GP150_MIDI_PYTHON`).
The first call that needs the pedal takes ~8 s (link set-up plus the ~5 s wait Suite also observes).
Requests are serialized: the pedal handles one at a time.
