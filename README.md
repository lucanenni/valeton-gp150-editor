# Valeton GP-50 Editor — GP-150 fork

A fork of [drewmerc302/valeton-gp50](https://github.com/drewmerc302/valeton-gp50) (all credit
for the original GP-5/GP-50 work belongs there) that adds **Valeton GP-150** support — see
[GP-150 support](#gp-150-support-this-fork) below. Everything before that section describes the
upstream GP-5/GP-50 editor, unchanged by this fork except where noted.

This is an independent community project. It is not affiliated with, endorsed or sponsored by
Valeton or Sonicake; "Valeton", "GP-5", "GP-50", "GP-150" and "Valeton Suite" are names and
trademarks of their respective owners, used here only to say which hardware and software the
project works with. It contains no Valeton software, firmware or factory content.

A browser-based editor for the **Valeton GP-50** (and GP-5), built by reverse-engineering
the pedal's MIDI SysEx protocol from scratch. It reads and writes the device live over
**WebMIDI** — no vendor SDK, no drivers, no backend.

**Live demo (this fork, GP-150 included, beta):**
[lucanenni.github.io/valeton-gp150-editor](https://lucanenni.github.io/valeton-gp150-editor/) —
zero-setup, runs entirely in-browser, Chrome or Edge, pedal on USB. The **upstream** project's own
hosted build (GP-5/GP-50 only) is [valeton-gp50-woad.vercel.app](https://valeton-gp50-woad.vercel.app).
This is a beta: GP-150 writes go out only after their exact bytes were reproduced from real captures,
but read first and keep a backup of your presets before writing.

**What it does:**

- **Preset Explorer** — reads every preset off the connected pedal; full signal chain
  per preset, block chips color-coded by type.
- **Live editing** — edit a preset's blocks, models, and parameters in the browser;
  changes mirror straight to the pedal over WebMIDI.
- **Model picker** — swap any block's model using Valeton's official hardware names,
  not just internal IDs.
- **Preset rename** — edit a preset's name and write it back to the device.
- **Preset & block reordering** — drag to rearrange presets in a bank, or blocks
  within a preset's signal chain; each reorder is one batched, minimal write.
- **Clear Preset** — wipe a slot back to a factory-blank preset.
- **Captures & IRs browser** — every SnapTone capture and User IR on the device,
  plus reusable templates.
- **Capture usage lookup** — pick a SnapTone or IR and see exactly which presets
  reference it.
- **Build a patch from a capture** — wrap a template's effects chain around a
  SnapTone/IR and write the result to a slot.
- **Make a template from a preset** — save any preset's effects chain as a reusable
  template.
- **Preset Converter** — convert `.prst` preset files between the GP-5 and GP-50
  formats, entirely client-side.

Everything above runs client-side. The live demo is the whole app; the local FastAPI
server ([Setup](#setup)) is only for development and for the legacy in-repo NAM
converter.

## Maintenance status: no test hardware

I sold my GP-50 in September 2026 and no longer own a Valeton pedal. The app was
developed and tested against a real GP-50 and still works, but I can't reproduce
device-side bugs myself anymore, so a fix depends on what you send. Changes to the device
read/write path are now checked against the test suite only, not a live pedal.

If you open an issue about talking to the pedal, please include:

- Your browser and its exact version (from `chrome://version`), plus your OS
- Pedal model (GP-50 or GP-5) and firmware version
- What you did, what you expected, and what happened (screenshots help)
- The browser console output (DevTools → Console) from the failing action
- If you can, a raw MIDI capture of the failure, e.g. with
  [MIDI Monitor](https://www.snoize.com/midimonitor/) on macOS. This is the single most
  useful thing you can attach.

## GP-150 support (this fork)

Works over WebMIDI in Chrome/Edge with the pedal on USB (no Valeton Suite needed), or offline on
`.prst` files. The GP-150 uses a different `.prst` container and wire protocol than the GP-5/GP-50;
what is known is written up in [`design/GP150_SUPPORT.md`](design/GP150_SUPPORT.md)
(container spec: [`re/DEVICE_GP150.md`](re/DEVICE_GP150.md); tickets: [`BACKLOG_GP150.md`](BACKLOG_GP150.md)).

- **Explorer** (GP-150 connected, or a `.prst` dropped in): read any of the 200 patches live, see the
  full signal chain and every module's model, parameters and on/off state, live-edit parameters, swap
  models, switch modules on/off, reorder the chain, save, and write a whole patch to any slot without
  activating it.
  Patch-level settings (volume, tempo, NAM mode, Quick Knobs, EXP/CTRL, footswitches) are shown too.
- **Preset converter:** GP-50/GP-5 → GP-150 (`app/static/convert_gp50_to_gp150.js`), fully client-side.
- **Captures & IRs:** list the pedal's SnapTones, NAM models and User IRs, and upload:
  User IR (`.wav`), NAM ("A2 Lite" `.nam`), a ready-made SnapTone (`.clo`), or **create a SnapTone**
  from a `.nam` file or from a recording of your amp — one button builds it (a Valeton-compatible amp
  profiler running in the browser, `app/static/amp_profiler*.js`) and uploads it to the slot you choose.
  Uploads to a SnapTone slot change every patch that points at it, so the slot is always your call.
  Every SnapTone / NAM / User IR card also shows which patches use it ("used by"): the 200 presets are
  read in the background after connecting (about 40 s the first time, then only what changed).
- **MCP server** ([`mcp/`](mcp/README.md)): lets Claude Code (or any MCP client) search the effect
  catalog, read any preset from the pedal without touching the front panel, build or edit a patch by
  model and parameter names and write it to a scratch slot (default 190–199), list the pedal's libraries,
  see which presets use a SnapTone, and upload IRs, NAM models and SnapTones — including SnapTones built
  from a `.nam` file or a recording (only into never-written slots unless you allow more). Setup:
  `claude mcp add gp150 -- node /absolute/path/to/mcp/server.mjs` (macOS, Node, `.venv-midi`).

The Python scripts under `patch/gp150_*.py` are the command-line counterparts of the live paths
(`gp150_live_read.py`, `gp150_wake_select_read.py`, …) and the byte-exact builders the browser code
was checked against.

## Getting NAM captures onto the pedal

**That moved to its own project:
[nam-a2a1-converter](https://github.com/drewmerc302/nam-a2a1-converter)** — a standalone
desktop app (Windows / macOS / Linux, optional NVIDIA acceleration).
**[Download a release →](https://github.com/drewmerc302/nam-a2a1-converter/releases)**

The GP-50 only accepts NAM **A1**, and there's no A2→A1 format downgrade — they're
different neural architectures, so the weights don't transfer. The converter **distills**
instead: render a DI through the A2 model, then train an A1 to reproduce that output.
It's device-agnostic, so it serves any A1-only device or plugin, not just the GP-50.

This repo still carries the engine it grew out of (`a2a1/`, wired into the local app),
but the converter you actually want is the standalone one.

## Screenshots

|  |  |
| --- | --- |
| ![Preset Explorer — full preset list with block chips](docs/screenshots/01-preset-explorer.png) **Preset Explorer** — every preset on the pedal, block chips color-coded by type. | ![Preset detail — signal chain, per-block params, live edit](docs/screenshots/02-preset-detail.png) **Preset detail** — full signal chain, per-block params, live edit straight to the pedal. |
| ![Model picker — official hardware names for a block](docs/screenshots/03-model-picker.png) **Model picker** — swap a block's model, official hardware names included. | ![Captures & IRs — templates and SnapTone captures](docs/screenshots/04-captures-and-irs.png) **Captures & IRs** — saved templates plus every SnapTone capture on the device. |
| ![SnapTone usage — which patches reference a capture](docs/screenshots/05-snaptone-usage.png) **Capture usage** — see exactly which patches reference a SnapTone. | ![Build a patch from a capture](docs/screenshots/06-build-patch.png) **Build a patch** — wrap a template around a SnapTone and write it to a slot. |
| ![Make a template from a preset](docs/screenshots/07-make-template.png) **Make a template** — save any preset's effects chain as a reusable wrapper. | ![Preset Converter — GP-5 to GP-50 conversion](docs/screenshots/08-preset-converter.png) **Preset Converter** — convert `.prst` presets between the GP-5 and GP-50. |

## Setup

For GP-5/GP-50 use, you don't need any of this — open the upstream
[live demo](https://valeton-gp50-woad.vercel.app). Local setup below is for
development; it's also what you'd run to build this fork's own static bundle
(`scripts/build_static_site.mjs` — no hosted build of this fork exists yet, see
`DEPLOY.md`), which includes the GP-150 pages too.

```bash
# from this repo's root
python3 -m venv .venv-app && ./.venv-app/bin/python -m pip install fastapi "uvicorn[standard]" python-multipart pytest httpx
```

<details>
<summary>Optional: the in-repo NAM engine (superseded by <a href="https://github.com/drewmerc302/nam-a2a1-converter">nam-a2a1-converter</a>)</summary>

```bash
# engine venv (A2 render + train + 0.7.0 export; 0.5.x via in-process transcode)
python3 -m venv .venv && ./.venv/bin/python -m pip install -r a2a1/requirements-a2.txt   # NAM 0.13.0
```

One venv, not two — see [`a2a1/README.md`](a2a1/README.md) for why the old second one
is gone. The default DI is `refs/v3_0_0.wav` (official NAM input). Get it via the
trainer, or generate a synthetic fallback:
`./.venv/bin/python a2a1/make_di.py refs/v3_0_0.wav`.
</details>

## Run

```bash
./run.sh
```

Then open **http://127.0.0.1:8756**.

- **Preset Explorer / Captures & IRs:** connect the pedal over WebMIDI (Chrome/Edge,
  HTTPS or localhost), scan, and browse/edit real device data live — see the
  itemized feature list above.
  - **Known issue: Chrome 152 cannot talk to the pedal.** Chrome 152 has a Web MIDI
    regression that corrupts SysEx framing (the pedal receives `F0 F0 … F7 F7` and
    ignores it; replies are dropped). The pedal shows as connected but every scan
    fails with "no reply". Use Chrome 153 or newer, or Chrome Beta/Canary. Not a
    firmware or cable problem; see [issue #3](https://github.com/drewmerc302/valeton-gp50/issues/3).
- **Preset Converter:** drop in a `.prst` and convert between GP-5 and GP-50 formats.
- **NAM converter:** present in the local build only, and only with the engine venv
  above. The hosted build links to the standalone converter instead.
- **GP-150 (this fork only):** inspect a GP-150 `.prst`, read one live off the pedal, or convert
  a GP-50/GP-5 preset to GP-150 — see
  [GP-150 support](#gp-150-support-this-fork) below.

## Tests

```bash
./.venv-app/bin/python -m pytest app/tests -q -m "not slow"   # fast unit/API/frontend suite
./.venv-app/bin/python -m pytest app/tests/test_e2e.py -q -s  # slow: real headless browser conversion + screenshots
```

The GP-150 decoder tests run on a stand-in set (the factory-empty patch, converted upstream presets and
synthetic patches). To run them against a real corpus of exported GP-150 patches, put the `.prst` files in a
folder `X/prst_export/` and set `GP150_CORPUS_DIR=X`. The upload tests (User IR, NAM, SnapTone) check
golden fixtures built from synthetic payloads; the real Suite upload captures they were derived from hold
third-party content and are not in the repo — set `GP150_CAPTURES_DIR` to a folder with them to re-run the
byte-for-byte parity checks. The MCP server has its own tests in `mcp/` (`npm test`, no pedal needed).

## Layout

- `app/` — the FastAPI web app + the WebMIDI frontend (device I/O, decoders, editor UI).
- `a2a1/` — GP-50 MIDI RE tooling, plus the original A2→A1 engine
  ([README](a2a1/README.md)); the shipped converter now lives in
  [nam-a2a1-converter](https://github.com/drewmerc302/nam-a2a1-converter).
- `docs/`, `re/`, `design/` — protocol notes, RE captures, and format research.
- `refs/` — sample models + the DI input.
- `MVP_REQUIREMENTS.md`, `AUTONOMY.md`, `STATUS.md` — the MVP spec, the build-loop
  protocol, and live build status (all from upstream; not kept current by this fork).
- **This fork's GP-150 work**: `patch/gp150_*.py` (decoder, wire protocol, upload builders),
  `app/static/gp150*.js`, `webmidi_gp150.js` and `amp_profiler*.js` (the GP-150 pages, live MIDI and the
  amp profiler), `re/gp150_captures/` (real device captures the tests replay byte-for-byte),
  `re/DEVICE_GP150.md`, `design/GP150_SUPPORT.md`, `BACKLOG_GP150.md`.

## License

[MIT](LICENSE)

## Scope

Live device read/write (Explorer, live edit, reorder, rename, clear, capture usage,
build/make-template) is reverse-engineered and working over WebMIDI for GP-5/GP-50.
The app only talks to the physical pedal when you explicitly connect and scan/write
via the Explorer or Captures & IRs pages.

**GP-150 (this fork):** writes go out only after the exact bytes have been reproduced from a real
capture and confirmed on the pedal (see `design/GP150_SUPPORT.md` §6 for the safety rules).
