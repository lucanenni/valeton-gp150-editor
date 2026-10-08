# GP-150 backlog

Tickets of this fork's work. Upstream's own backlog stays in
[`BACKLOG.md`](BACKLOG.md), untouched — the items below that carry upstream ticket ids
(EXP-*, CAP-*, CONV-*, REORD-1, WRITE-1, PLAT-*) were implemented here, so their status
in upstream's file is out of date. Findings behind each item are in
[`design/GP150_SUPPORT.md`](design/GP150_SUPPORT.md) and
[`re/DEVICE_GP150.md`](re/DEVICE_GP150.md).

## Done

- [x] **GP150-1** — Samples. All 200 factory/user slots exported from a real
  GP-150 (kept outside the repo; tests use it via `GP150_CORPUS_DIR`, else a stand-in set).
- [x] **GP150-3** — `patch/prst_format.py` refactored so a device profile can carry
  its own name offset/length and an optional header (GP-150 has a different
  container); the GP-5/GP-50 converter refuses GP-150 files instead of misreading them.
- [x] **GP150-4** — Effect catalog: `build_ring.py gp150` builds `fxid_ring_gp150.json`
  from the user's own `module150_data.json` by `patch/build_ring.py`. The result is a derivative
  (flattened to the fields the editor needs, not the original file) and is committed, the way upstream
  does for the GP-5/GP-50 catalogs; the original `module150_data.json` is never redistributed.
- [x] **GP150-5** — Read path: a patch streams back as a chunked SysEx reply whose
  decoded stream is an 8-byte prefix + the exact 1128-byte body; decoded byte-for-byte
  against the 200-file corpus and live on hardware (Python and WebMIDI).
- [x] **GP150-6** — Write path, live-verified 2026-09-20: set-param, save, model-swap,
  enable/disable, chain reorder. The missing piece was the wire tag: CRC-8 (poly
  0x31) over everything after the tag byte, masked to 7 bits.
- [x] **GP150-7 / GP150-8** — Product surface: device badge, GP-50⇄GP-150 preset
  converter, and the GP-150 inspector folded into the existing Explorer and
  Captures & IRs pages.
- [x] **GP150-9** — Library uploads and SnapTone creation, live-verified:
  - User IR, NAM ("lite" WaveNet, 1871 weights) and SnapTone (`.clo`) upload, each
    byte-for-byte equal to a real capture; SnapTone files go out in Suite's device
    form (2696 bytes, header lengths and CRC-16 rewritten — without that the pedal howls).
  - `amp_profiler.js` builds a SnapTone from a NAM model or from a recording with the
    same algorithm as Suite's profiler (IRs agree to ~1e-5 / 1e-4 of peak); one button
    ("Generate and upload") runs NAM model → profiler → upload in about 15 s.
  - `amp_profiler_reference.js` generates the 70 s test signal, so nothing of Valeton's is
    bundled. Auditioned on the pedal against a profile built with Valeton's own
    signal: no big difference.
  - Limits: 48 kHz NAM models only; the 48→44.1 kHz resampler is not Suite's (< 0.3 dB);
    some classic-format NAM files that Suite's own converter rejects must be imported
    as ready-made SnapTones.
- [x] **GP150-10** — Patch-level settings decoded: patch volume, BPM, NAM mode, Quick
  Knob, EXP/CTRL and footswitch assignments (all live-confirmed). Volume, BPM and
  NAM mode are also writable; the assignment blocks are read-only.
- [x] **GP150-11** — Read reliability: one request in flight, settle delay, no resend,
  a ~4 s wait after connecting (what Suite itself does); live sync and a
  non-disruptive "active preset" fetch.
- [x] **GP150-12** — GP-150 "used by" view: first removed (no non-disruptive read of a
  patch body was known and depending on a Suite export was ruled out), then rebuilt on the
  by-index read (design/GP150_SUPPORT.md §3.2): badge + "List Presets" on every SnapTone /
  NAM / User IR card, list loaded in the background on connect, cached, kept current by name
  changes, live broadcasts and our own writes.
- [x] **GP150-13** — Full-preset write: import a whole patch to any slot without
  selecting or activating it (category 0x07); live-verified on a scratch slot.
- [x] **MCP server** (`mcp/`, see its README): search the catalog, read any preset by index, build
  and edit patches by model/parameter names, write to a scratch slot (default 190–199, read-back
  verified). Reuses the browser modules in Node through a Web MIDI shim; registered with
  `claude mcp add gp150 -- node …/mcp/server.mjs`. Live-checked on a real pedal (slot 199 written and read
  back with every edited parameter correct); offline tests in `mcp/test`.
- [x] **MCP-2** — Upload tools for the MCP server: `list_library`, `find_usage`, `upload_ir`, `upload_nam`,
  `upload_snaptone`, `create_snaptone_from_nam`, `export_reference_signal`, `create_snaptone_from_recording`
  (profiler and NAM renderer on `worker_threads`; writes only into never-written slots unless
  allow-listed). Tested offline against a fake pedal and live on 2026-10-08: SnapTone slots 90 (ready
  `.clo`), 91 (from a `.nam`, 23 s) and 92 (from a recording, 15 s), User IR 20 (synthetic IR), NAM 20
  (the lite model of `refs/A2.nam`), each uploaded and read back; refusal of a written slot without the
  allow-list and overwrite with it; `find_usage` (200 presets in 37 s). That run also showed that catalog
  reads need Suite's acknowledgements (see GP150_SUPPORT.md §3.2), now added. Not listened to: the sound
  of the created SnapTones, the test IR and the NAM.
- [x] **NAM → SnapTone speed**: flat Float32 renderer plus a Web Worker pool
  (`nam_wavenet_fast.js`), profiler in a worker: 68 s → ~12–15 s in Chrome.

## Upstream tickets completed in this fork

- [x] **EXP-1 … EXP-8** — Explorer polish: no ACK counts in write messages, inline row
  drag instead of a Reorder button, green active-state highlight, bigger drag grip,
  bypassed blocks hidden on collapsed rows, 3-column grid in the expanded detail view;
  **EXP-5**: multi-select with bulk actions.
- [x] **EXP-9** — Block presets: copy one block between presets, save/name blocks
  (LocalStorage), export/import single blocks or sets (`gp150_block_library.js` for
  GP-150).
- [x] **CAP-1 … CAP-3** — Captures & IRs: Templates above SnapTones; per-patch reset
  and "replace with…" (single and all) in the SnapTone usage modal (GP-50).
- [x] **CONV-1 / CONV-2** — "Preset Converter" page rename; the in-browser NAM
  converter was spun out of this fork.
- [x] **REORD-1** — Bank-backup import/restore. **WRITE-1** — read-back verify and
  auto-retry for device writes.
- [x] **PLAT-2** — Backend-only features ported to client-side WebMIDI.
- [x] **CLEANUP-1** — Audit of superseded scripts and app pieces.

## Open

- [x] **Test data without Valeton content**: the factory-empty patch "It's GP-150"
  (`app/static/data/gp150_skeleton.prst`) is the converter's skeleton; the 200-patch
  corpus is kept outside the repo (`GP150_CORPUS_DIR`, see `app/tests/gp150_corpus.py`)
  and the tests otherwise run on a stand-in set (empty patch, converted upstream
  presets, synthetic patches). The real Suite upload captures (User IR, NAM, SnapTone) carry
  third-party audio/model data, so they are kept outside the repo too (`GP150_CAPTURES_DIR`); the upload
  tests check golden fixtures from synthetic payloads, shared by the Python and JS encoders. Two patches converted from upstream's GP-5 samples on the
  empty skeleton were written to scratch slots 198/199 of a real GP-150 and read back
  (names) and inspected on the pedal: accepted, plausible chain and parameters.

- [ ] **GP150-2** — *Blocked.* The 0x0E–0x0F file checksum of a `.prst` cannot be
  reproduced offline (the pedal computes it itself and never verifies it on write).
  Not needed for any shipped feature.
- [x] **PLAT-1** — Hosting: GitHub Pages, live at https://lucanenni.github.io/valeton-gp150-editor/
  (`.github/workflows/pages.yml` builds `dist/` and deploys on every push to `master`; the static
  build was checked under a sub-path, workers included).
- [x] **PLAT-3** — Release checklist, in order: (1) minimal diff against upstream,
  (2) documentation scrub, (3) squash history, (4) go public, publish `dist/`, tag a
  first beta (`v0.1.0-beta.1`). All done: the repository is a public fork of upstream with one
  commit of ours on top (third-party captures kept out, see `app/tests/gp150_corpus.py`); README carries the not-affiliated notice, LICENSE the fork's
  copyright line.
  - (1) done for everything GP-150-specific that can live in its own file: GP-150
    endpoints (`app/api_gp150.py`), fork-only GP-50 endpoints
    (`app/api_device_extras.py`), GP-150 styles (`app/static/gp150.css`), SnapTone
    upload groundwork (`patch/device_write_snaptone.py`); `device_io.py`, `patchlib.py`,
    `SNAPTONE_PROTOCOL.md`, the probes README, `BACKLOG.md` and upstream's GP-150/180
    design note are identical to upstream. What still differs in upstream files is
    integration (device registry in `prst_format.py`, port detection in `live_read.py`,
    converter guard, page markup and hooks in `device.html`/`explorer.html`) and this
    fork's own GP-50 features (bulk select, block presets, reset/replace SnapTone,
    the NAM trainer removal).
- [x] **SNAP-1** — Superseded by GP150-9's profiler and built-in reference; closed.

## Blocked on hardware this fork's author does not own (GP-50)

CAP-4, REORD-2, BLK-1, BLK-2 — see [`BACKLOG.md`](BACKLOG.md).
