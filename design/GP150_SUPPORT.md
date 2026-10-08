# GP-150 support — what is known

Spec-level summary of everything this fork knows about the Valeton **GP-150**
(`.prst` format, SysEx wire protocol, catalog/upload formats, SnapTone profiler).
It is deliberately findings-only. Byte-level detail lives next to the code that
implements it (module docstrings and comments in `patch/gp150_*.py` and
`app/static/webmidi_gp150.js`), and every format below is locked to real captured
traffic by the tests in `app/tests/` (`test_gp150_*`), which replay captures from
`re/gp150_captures/` byte-for-byte.

Container spec: [`re/DEVICE_GP150.md`](../re/DEVICE_GP150.md).
Status by ticket: [`BACKLOG_GP150.md`](../BACKLOG_GP150.md).

This document supersedes `design/GP150_GP180_SUPPORT.md` (upstream's early research
notes, kept unchanged). It covers the GP-150 only.

---

## 1. Devices and scope

| | GP-5 | GP-50 | GP-150 |
|---|---|---|---|
| `.prst` length | 507 | 552 | **1128** |
| container magic | `GP-5\0` | `GP-50\0` | `11 30 64 04` |
| file checksum | CRC-8/0x07 @0x14 | CRC-8/0x07 @0x14 | CRC-16 @0x0E (see §2) |
| name | 0x19 | 0x19 | 0x2C (13 chars) |

GP-150 is **not** a variant of the GP-5/GP-50 container; only the nibble-per-byte
wire idea is shared. The effect catalog is derived from `module150_data.json` of the
user's own Valeton install by `patch/build_ring.py` (`fxid_ring_gp150.json`: flattened to the fields the
editor needs, not the original file; the original is never redistributed).

## 2. `.prst` body (1128 bytes)

See `re/DEVICE_GP150.md` for the full field map. In short: slot index @0x04, name
@0x2C, module chain order @0x78 (a 12-byte permutation of
`NR PRE WAH DST NS AMP CAB EQ MOD DLY RVB VOL`), then per-module records of
`fxid` (u32 model id) and float32 parameters (`algId*4 + 4` from the model
offset), with the on/off byte at `model_offset − 4`. The `NS` slot is really the
**N→S SnapTone selector**: its "models" are the 100 SnapTone library entries.
Patch-level settings live in the tail (0x020 to EOF) as a family of sub-structs
with magic markers `0x3010, 0x3020, 0x3030, 0x3050, 0x3060, 0x3070, 0x3080`:
patch volume, BPM, NAM mode, the three Quick Knob targets (`targetId`/`algId`),
the nine EXP/CTRL assignments (`{targetId, algId, rangeMin, rangeMax}`, `-1` =
unused; entries accumulate per group) and the footswitch bitmask. Writes use the
`[0x01, checksum, dataLen+8, 0, 0, 0x03, magic×2, datasize, data…]` envelope with
the normal chunking/tag machinery. A preset's own 0x0E–0x0F file checksum is a CRC-16 (polynomial 0x8005 bit-reflected, init 0xE011, over bytes 0x10–0x463, stored big-endian; it does not cover the slot index). It reproduces all 200 files of a real corpus and 200 bodies read back from the pedal, including ones edited after the export. The pedal never verifies it for writes
(the device recomputes it); the decoder therefore does not validate it.

## 3. Wire protocol

### 3.1 Framing

Every message is one SysEx message (or a burst of chunks). After the 8-byte
header, the payload is **nibble-encoded** (one nibble per byte, high nibble
first) — the same scheme as GP-5/GP-50, with a different header.

Multi-chunk messages use: `[0x7f, tag, totalLen lo, totalLen hi, offset lo,
offset hi, category, chunkIndex]` followed by up to 119 payload bytes as nibbles;
lengths and offsets are two 7-bit digits. Un-chunked commands use the shorter
`01 CC len …` form below.

Two checksums, both CRC-8 with polynomial `0x31`, init 0, no reflection:
- **payload checksum** (`CC`, payload byte 1): over the decoded payload from
  byte 5 onward (set-param / save / model-swap / enable / reorder);
- **wire tag** (raw header byte 1): `crc8(raw[2:]) & 0x7f`, over everything after
  the tag byte. It was the missing piece for accepted writes: the pedal silently
  ignores messages with a wrong tag.

Uploads and full-preset writes put a **content prefix** in front of the struct:
`[0x01, crc8(prefix[4:8] + body), 0x20, 0x20, 0x01, 0x01, typeLo, typeHi]`.

### 3.2 Reads

- A patch body streams back as a category-tagged multi-chunk reply whose decoded
  stream is an 8-byte prefix plus the exact 1128-byte `.prst` body.
- Selecting a preset: CC0 + Program Change works once per session; repeated
  selects must use the dedicated "select preset" SysEx (`flag=0x00`, index
  0-based). Index `0xFFFF` with `flag=0x01` means "whatever is active" — this is
  also Suite's own startup fetch.
- **One request in flight at a time.** The pedal behaves like a single-pending
  request state machine; resending, or sending a second request, corrupts the
  answer. Suite waits ~4 s after the MIDI connection before its first request and
  never retries; the app does the same (settle ≈ 300 ms between requests,
  6 s read timeout, no resend).
- **Catalog reads** (one request each, fixed reply lengths): `info`, `names`,
  `settings`, `firmware`, `user_irs` (412 B), `snaptones` (2032 B) and NAM models
  (2032 B; only indices 1–20 are real).
- **Preset name list**: one request (`target 0x1010`) returns all 200 names,
  without selecting anything — no front-panel disruption.
- **Body by index, without selecting** (live-confirmed 2026-10-01): the select
  template with the last byte `flag=0x01` and the slot's 0-based index in place of
  `0xFFFF` makes the pedal answer with that slot's body (decoded stream = 8-byte prefix +
  1128-byte `.prst`, body byte 4 = slot). The active preset and the front panel do not
  move; the body of slots 4, 65, 101, 150 was byte-identical to Suite's export.
- **Acknowledging a reply.** After every completed reply Suite sends an 8-byte message
  `7f TAG 00 00 00 00 CAT 00` (CAT = header byte 6 of the reply's chunks, TAG = the usual
  wire tag; 18/18 captured messages fit). Without it the pedal re-sends the reply for ~3 s
  and answers nothing else in the meantime, so reads cost ~3 s each; with it the next read
  answers in ~40 ms. Order matters: request → reply → acknowledgement → next request. A catalog read
  (`info` request, then the catalog request) therefore acknowledges the `info` reply before sending the
  catalog request and the catalog reply when it arrives; without that the pedal answers one request
  late (a NAM read returned the SnapTone list, 2032 bytes like it) and catalog reads had to be spaced
  by hand. With it, seven catalog reads in a row take ~0.7 s each. The first request after connecting
  still takes ~5 s. All 200 presets
  are read in ~40 s (one request at a time, 150 ms pause).
- **"Used by"** (`app/static/gp150_usage.js`) is built on that read: after connecting, the
  200 presets are read in the background, decoded for the N->S and CAB references and cached
  in localStorage. Later connects re-read only the presets whose name changed (one names
  request); the pedal's live broadcast and the editor's own writes update single entries;
  "Rescan presets" re-reads everything. A panel edit that changes neither name nor the
  active preset while the editor is closed is only picked up by a rescan.

### 3.3 Edits (single messages)

| command | raw bytes | payload |
|---|---|---|
| set-param | 56 | `01 CC 14 00 00 03 33 30 33 30 10 00 MM 00 T1 T2 00 00 [float32] FF AA 00 00` |
| save / commit | 72 | `… 1c … SS 00 00 00 <name>` (SS = 0-based target slot) |
| model-swap | 48 | `… 0c 00 [fxid LE] FF 00 00 00` |
| enable/disable | 40 | `… 08 00 FF EE 00 00` (EE = 1 on / 0 off) |
| reorder | 56 | same shape as set-param, carries the new 12-entry chain |

`MM,T1,T2` are the active model's own `fxid` as big-endian bytes
`[MM, 0, T1, T2]` (so they change after a model swap); `FF` is the module id;
`AA` is the parameter's `algId`. Edits change only the pedal's live state; the
save command persists it to a slot (the device then stores its own file
checksum).

### 3.4 Full-preset write (non-disruptive)

Category `0x07`: an 8-byte prefix `01 CC 6c 04 01 03 11 30` + the 1128-byte body,
10 chunks. No select, no activation, the front panel never moves. Byte 4 of the
body is the target slot; byte 0x0A is transient (the device ignores/overwrites
it). Verified live by writing a new patch to a scratch slot while another preset
stayed active.

### 3.5 Library uploads (category `0x08`-family)

All use the same 119-byte chunk shape and an 8220-byte struct
(`type marker u16, size 0x201c, slot, name[16], 8192-byte data region`).

| type | marker | slots | data region |
|---|---|---|---|
| User IR | `0x1040` | 20 (0-based on the wire) | up to 2048 × int32 PCM samples, untouched (no resampling) |
| SnapTone | `0x1050` | 1–100 (51–100 writable) | a `.clo` file in its **device form** (below) |
| NAM | `0x1090` (family `0x1050`) | 1–20 | 496-byte config header + 1871 float32 weights ("lite" WaveNet, `channels=3`) |

NAM header details: the header carries a CRC-32 (poly `0xedb88320`, init/final
`0xffffffff`) over the whole header+weights buffer, **skipping** the hash field's
own 4 bytes (offset 24–27) — skipped, not zeroed; the selected submodel's own
`metadata.loudness` (float64) sits at offset 44. Only this one architecture is
supported; a pedal slot rejects anything else. Files that contain several
submodels (slimmable containers) use their "lite" one.

## 4. SnapTone (`.clo`, "Tone Catch") files

`VTSI` magic. As Suite builds it:

```
0     "VTSI"
4     u32 total length            8   u32 CRC (see below)        20  u32 data length
24    two biquad sets (5 doubles each): identity, then a 20 Hz high-pass
104   float posPeak   108 float negPeak   112 float aPos   116 float aNeg   (waveshaper)
124   u32 128 (seg1 length)       128 u32 128      132 u32 2048 (seg2 length)
136   seg1: 128 float32  (min-phase IR, 44.1 kHz)
648   seg2: 2048 float32 (only the first 512 survive the wire truncation)
```

- **Device form**: Suite cuts the file to the first 2696 bytes (header + 2560
  data bytes) and rewrites total length (`@4 = 2696`), data length (`@20 = 2560`),
  seg2 length (`@132 = min(len, 512)`) and the **CRC** (`@8`): CRC-16/MODBUS
  (init `0xFFFF`, poly `0xA001`) over `[12:end]`, byte-swapped. Truncating
  without rewriting the header produces an inconsistent file, and the pedal
  then emits loud self-oscillating noise. The conversion is idempotent.
- Wire slots store IRs at 44.1 kHz; the profiler works at 48 kHz and converts.

## 5. The amp profiler (`app/static/amp_profiler*.js`)

Creates a `.clo` from a reference signal and a recording of the amp (or of a
NAM model run on it). It was checked against reference output made by Valeton Suite
on identical inputs (IRs agree to ~1e-5 and ~1e-4 of peak; header and
CRC bit-identical except the last float digit):

1. Detrend the recording, find the reference's onset.
2. Fit a static exponential waveshaper `y = (1 − exp(−a·x))·peak` per polarity
   from the 0–5 s level ramp: peaks of the detrended output over 0.1 s blocks,
   `a = 1.2 × least-squares slope / peak` (the slope over blocks up to 50 % of
   the peak).
3. Model chain: 4× IIR all-pass half-band up-sampling → waveshaper → 4× down →
   20 Hz high-pass. Transfer functions T (6–21 s) and P (23–28 s) by Welch H1.
4. Three rounds of the iterative amplitude-coefficient fit (`iterativeAmpFit`):
   mel-scale smoothing, geometric smoothing of the lowest bins, a 128-tap IR1
   and a 2048-tap IR2 (both minimum-phase), error measured on a 512-point
   mel grid (80 Hz–10 kHz); best-so-far with rollback.
5. Post stage on the 50–70 s playing section: spectral ratio of recording vs
   model, smoothed, → 256-tap correction folded into IR2, mean removed, energy
   matched, ×4.
6. Resample to 44.1 kHz, assemble header, CRC.

Known residuals: the final 48→44.1 kHz resampler is a windowed sinc, not
Suite's (~1.5 % on the first IR samples, < 0.3 dB spectrally); only 48 kHz NAM
models are handled.

**Reference signal.** `amp_profiler_reference.js` generates the 70 s test signal
(300 Hz ramp, click, low-level noise with a 1 Hz wobble, log sweep, gated log
chirps, plucked-string material), because Valeton's own file cannot be
redistributed. Profiles built with it match Suite's within the profiler's own
run-to-run spread (about ±1 dB in level and ~2 dB rms ripple, mostly above
8 kHz). For NAM models the "recording" is the model output × 0.31 quantized to
16 bit, as Suite's converter does.

## 6. Hardware-safety rules carried over

- One persistent MIDI connection; a settle delay after every request; a hard cap
  on requests per action; never a tight loop of reads.
- No guessed write traffic: a write path ships only after its bytes are
  reproduced exactly from a real capture, then confirmed on a scratch slot.
- SnapTone slots are a shared catalog: an upload changes every patch that points
  at that slot, so a slot is always chosen by the user.

## 7. Traps

- A shared codec does not imply a shared container (GP-150's `.prst` differs from
  GP-5/GP-50 even though the nibble scheme is identical).
- `MM,T1,T2` in set-param are stale after a model swap — rebuild them from the
  new `fxid`.
- CC0 + PC re-triggers a fresh read only the first time in a session.
- A wrong wire tag is silently ignored by the pedal (no ack, no error).
- Truncating a `.clo` without rewriting its header/CRC makes the pedal howl.
- Nothing verifies the 0x0E–0x0F checksum on import or write (a body written with a wrong one is stored with the right one); do not treat a
  mismatch as corruption.
