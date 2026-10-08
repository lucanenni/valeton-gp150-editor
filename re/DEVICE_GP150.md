# GP-150 `.prst` format — reverse-engineered 2026-07-31

Cracked from a real 200-slot export off a user-owned GP-150 (Valeton Suite export)
plus ~14 deliberate single-parameter edits diffed against that corpus. The corpus is
Valeton's content and is kept outside the repository (tests use it when
`GP150_CORPUS_DIR` points at it, see `app/tests/gp150_corpus.py`; otherwise they run on a
stand-in set built from the factory-empty patch "It's GP-150", shipped as
`app/static/data/gp150_skeleton.prst`). The edits built on the empty patch are in
`re/gp150_captures/param_edits/`. Method throughout:
change exactly one thing on the device, re-export that slot, diff against the
corpus original for that slot number. Wire protocol, upload formats and the
SnapTone profiler are summarized in `design/GP150_SUPPORT.md`; this file is the
`.prst` container spec.

**Status:** reading is complete and byte-for-byte verified against the 200-file
corpus; writes are live-verified (see `design/GP150_SUPPORT.md` §3). The file's own
0x0E–0x0F checksum is solved too (see "Checksum" at the bottom) — the pedal recomputes
it itself when it stores a patch, and nothing verifies it on import.

## Container

GP-150 does not use GP-5/GP-50's CRC-8/0x07 checksum scheme (see
`patch/prst_format.py` for that shape — GP-150 is not a variant of it), but
**does have its own 4-byte magic header, `11 30 64 04`** (`patch/prst_format.
HEADER_GP150`) — confirmed 2026-08-22 across all 200 corpus files plus 3
independent live-captured bodies. This was documented as "no magic header"
until then; it's non-ASCII (unlike GP-5/GP-50's `"GP-5\0"`/`"GP-50\0"`), which
is likely why it wasn't recognized as a header earlier even though it was
already noted as a constant below.

```
prst[0x00:0x04]  magic header, `11 30 64 04`                       CONFIRMED
prst[0x04]       patch slot index, 0-based (u8)                    CONFIRMED
prst[0x05:0x0E]  constant across all 200 real samples, unidentified
prst[0x0E:0x10]  checksum, u16 big-endian: CRC-16 (poly 0x8005
                 reflected, init 0xE011) over 0x10..0x463 — not the
                 slot index (see "Checksum" below)                  CONFIRMED
prst[0x10:0x2C]  constant across all 200 real samples, unidentified
prst[0x2C:0x39]  patch name, ASCII/latin1, null-padded, 13 bytes    PARTIAL
                 (longest real name seen is 13 chars — the padding out to at
                 least 0x2C+68=0x70 is confirmed always-zero, so 13 is the
                 real usable limit even if the reserved field is wider)
prst[0x39:0x74]  unidentified, mostly-fixed with a few varying bytes
prst[0x74:0x78]  constant, `30 30 3c 03`                            CONFIRMED
prst[0x78:0x84]  chain order — 12-byte permutation of 0-11           CONFIRMED
prst[0x84:0x8C]  unidentified
prst[0x8C:...]   per-module param floats (see below)                 CONFIRMED
prst[~0x460:EOF] constant across all 200 real samples — reserved/unused, or a
                 fixed-per-firmware trailer unrelated to patch content
```

Total length: **1128 bytes**, confirmed on all 200 real samples (not just the
original 3-sample set).

## Chain order (`0x78`, 12 bytes)

Same idea as GP-50's `REC_ORDER` (`re/DEVICE_BLOCKORDER.md`): a permutation of
module indices, `order[chain_position] = module_index`. Module index order
comes from the manual's MIDI CC list (pp.77-78, CC48-59):

```
0=NR  1=PRE  2=WAH  3=DST  4=NS  5=AMP  6=CAB  7=EQ  8=MOD  9=DLY  10=RVB  11=VOL
```

Confirmed genuine (not a fixed byte run) by finding **7 distinct real orders**
across the 200-file corpus, e.g. `[5,0,8,1,2,3,4,6,7,9,10,11]`,
`[5,1,2,3,4,6,7,8,9,10,0,11]` — always alongside the base
`[5,0,1,2,3,4,6,7,8,9,10,11]` (AMP first, then NR..VOL in CC order).
**`order[0]` is always `5` (AMP) — confirmed across all 200 files, no
exceptions**: AMP is always first in the signal chain on this device.

**Storage order for the param floats below is INDEPENDENT of this array** —
confirmed by checking that each module's param offset holds a sane value
across all 7 distinct chain-order groups in the corpus, not just the default
one. The `0x78` array only affects signal routing/playback order, never where
a module's own parameters live in the file. Same rule as GP-50.

## Per-module param floats

One confirmed float32 (little-endian) offset per module, found by editing
exactly that module's first-listed parameter on the device:

| Module | Offset | Confirmed param (orig → new) |
|---|---|---|
| PRE | `0x08C` | Gain: 20.0 → 30.0 |
| WAH | `0x0D0` | Range: 50.0 → 60.0 |
| DST | `0x114` | Gain: 10.0 → 20.0 |
| NS  | `0x158` | Gain: 50.0 → 60.0 |
| AMP | `0x19C` | Gain: 50.0 → 60.0 |
| NR  | `0x1E0` | Threshold: 10.0 → 20.0 |
| CAB | `0x228` | Vol: 65.0 → 75.0 |
| EQ  | `0x27C` | Vol: 50.0 → 60.0 |
| MOD | `0x2AC` | Depth: 61.0 → 71.0 |
| DLY | `0x2F0` | Mix: 10.0 → 20.0 |
| RVB | `0x334` | Mix: 15.0 → 25.0 |
| VOL | `0x378` | Volume: 100.0 → 70.0 |

**File storage order is `PRE, WAH, DST, NS, AMP, NR, CAB, EQ, MOD, DLY, RVB,
VOL` — NOT the manual's CC-list order** (`NR, PRE, WAH, ...`). This turns out
to be the internal catalog's own `moduleId` order in `module150_data.json`
(0=PRE ... 11=VOL), not an arbitrary ordering. Also: the manual's "NS" (CC52)
is the catalog's **`N->S`** — a SnapTone-slot selector (101 entries: "None" +
100 SnapTone slots), same concept as GP-50's `N->S` category
(`app/patchlib.py`) — **not a noise-suppressor effect**, despite the
misleading name and this doc's own earlier phrasing.

Within a module, params are additional float32 slots at **+4 bytes each** —
generalized and confirmed for every module in "Full param layout" below
(`module_param_offset(module, algId)`). E.g. NR's `0x1E4` (between
Threshold at `0x1E0` and Attack at `0x1E8`) is `Ratio` (algId=1), not
"unidentified" as an earlier pass through this doc had it — see that
section instead of trusting the per-module table just below, which only
ever spot-checked algId 0.

**Per-module footprint: a uniform 68 bytes for every module, no
exceptions.** An earlier pass through this doc measured the gap between
consecutive modules' *param* offsets and found CAB/EQ looking irregularly
large — that was comparing the wrong thing (where each module's first
*tested* param happened to land, not the block boundary). `MODULE_MODEL_OFFSET`
(confirmed, "Model IDs" above) is perfectly `0x44`-spaced for all 12
modules with zero exceptions. Each module's 68-byte block is: 1 enable byte
(`model_off - 4`, padded to a 4-byte field) + a 4-byte model fxid
(`model_off`) + up to 15 param float slots (`model_off + 4` through
`model_off + 64`, `algId` 0-14).

**`VOL`'s float can be auto-written by the device**, not just by a direct
edit: editing NR Threshold/Attack or DST Gain also changed `0x378` (without
touching VOL), read as automatic output-level compensation recalculating
overall patch loudness when an upstream gain param changes. Don't assume a
changed `0x378` implies the user touched Volume.

## Model IDs (which catalog entry occupies each module slot)

A u32 (little-endian) fxid, matching `fxid_ring_gp150.json` keys exactly.
For 9 of 12 modules it's 4 bytes before that module's param offset above;
CAB and EQ have extra unmapped fixed fields in between, at different offsets:

| Module | Model offset | vs. param offset |
|---|---|---|
| PRE | `0x08C` | −4 |
| WAH | `0x0CC` | −4 |
| DST | `0x110` | −4 |
| NS  | `0x154` | −4 |
| AMP | `0x198` | −4 |
| NR  | `0x1DC` | −4 |
| CAB | `0x220` | **−8** |
| EQ  | `0x264` | **−24** |
| MOD | `0x2A8` | −4 |
| DLY | `0x2EC` | −4 |
| RVB | `0x330` | −4 |
| VOL | `0x374` | −4 |

`fxid 100663299` (`FXID_NONE`) = "no model selected", present as a shared
placeholder entry (name `None`, title `Volume`) in every module's catalog
list. Confirmed with **zero mismatches across all 200 × 12 = 2400 module
slots** in the corpus, validated against the ring's *whole* fxid set (not
just each module's own catalog subset — see the important caveat next).

**Models are not module-locked in practice.** 20/200 real corpus files
store a fxid in the `PRE` slot that the catalog tags as `DST` (e.g. "Boost",
"OD 9") — the device evidently lets some drive/boost pedals occupy either
slot. Validate a decoded fxid against the *entire* ring, not one module's
subset, or real files will read as errors that aren't.

Implemented in `patch/gp150_format.py` (`MODULE_MODEL_OFFSET`,
`read_module_model()`, `FXID_NONE`), surfaced via
`POST /api/device/gp150/inspect`. Tests: `app/tests/test_gp150_format.py`.

## Full param layout: `algId*4 + 4` from the model offset

`param_offset(module, algId) = MODULE_MODEL_OFFSET[module] + 4 + algId*4` —
same idea as GP-50's `REC_PARAMS`, `algId` is a slot index. Confirmed
against **every param of every model actually active anywhere in the
200-file corpus**: 2608 param instances, each checked against its own
catalog `[min,max]` range — zero out of range. The format is readable
end-to-end now: decode the model in each module slot, then decode every one
of that model's real parameters by name and value, not just one
spot-checked float per module.

`patch/gp150_format.py`: `module_param_offset()`, `read_model_params()`
(takes a model's `params` list from the ring, returns `{param_name:
value}`). `POST /api/device/gp150/inspect` returns a `modules` dict:
`{module: {fxid, model_name, origin, params}}`. Tests:
`app/tests/test_gp150_format.py`.

## Module on/off state: a single byte, `model_offset - 4`

Confirmed live (2026-07-31): toggled DST off on the device with its model
(Green OD) and params (Gain=10.0, Tone=70.0, Volume=80.0) left completely
untouched — only one byte changed, `0x10C` (`MODULE_MODEL_OFFSET["DST"] -
4`), `1 -> 0`. Generalizes to all 12 modules at `model_offset - 4`
(`MODULE_ENABLE_OFFSET`), confirmed corpus-wide: always exactly `0` or `1`,
and `(enabled=1, no model assigned)` never co-occurs — you can't be "on"
with nothing selected, which is what says this is a real flag and not a
coincidental correlate.

**This settles the "no model assigned" vs "bypassed" question the earlier
`0x441` bitmask search couldn't**: they're independent, exactly as
suspected — a module can hold a real model while switched off (confirmed:
`001-New GEN.prst`'s `WAH` slot has a real model, "V-Wah", but is off by
default). The `0x441` region remains unidentified and is NOT this — don't
conflate the two.

`patch/gp150_format.py`: `MODULE_ENABLE_OFFSET`, `read_module_enabled()`.
Sample fixture: a real-corpus edit (DST toggled off), used by the tests when `GP150_CORPUS_DIR` is set.
Tests: `app/tests/test_gp150_format.py`
(`test_toggling_a_module_off_only_flips_its_enable_byte`,
`test_enable_byte_is_always_boolean_and_never_on_with_no_model`).

## Name field width: confirmed at 13 characters

Confirmed live (2026-07-31): typed a 16-character name on the device: it
truncated to exactly 13 (`"Test123456789012"` → `"Test123456789"`,
`re/gp150_captures/param_edits/200-Test123456789.prst`). This is the real
field limit, not just the longest name that happened to appear in the
200-file export corpus (which was also 13, `"Force of YJM "` — no longer a
coincidence). `NAME_MAX = 13` in `patch/gp150_format.py` and `name_len=13`
on `patch/prst_format.py`'s `GP150` profile.

## Enabling a previously-inactive module

Turning NS on from a blank/inactive patch (tested on `200-Its GP150`, a
factory placeholder) wrote NS's whole ~6-slot default block (`0x14D-0x16E`,
values snapping to `50.0` at each `0x44`-spaced slot) plus a small change
around **`0x441-0x444`** — a plausible bypass/enable-bitmask region (cf.
GP-50's `REC_BYPASS` u32), **not yet confirmed deliberately** (would need a
toggle-one-module-on-then-off-again test with nothing else changed).

## Live read — no Valeton Suite needed (confirmed 2026-08-22)

The live SysEx read (`patch/gp150_wire.py`'s chunk reassembly,
`patch/gp150_live_read.py`'s port handling) originally required Valeton
Suite open and connected — the device wouldn't broadcast its state to
anyone otherwise. That requirement is gone: `patch/gp150_wake_replay.py`
replays the exact SysEx request Suite itself sends on connect (captured
verbatim, not reconstructed) and gets the same reply **with Suite fully
closed**. Confirmed live: a real, valid, 1128-byte active-patch body came
back, byte-for-byte matching the corpus format (`gp150_format.decode()`
resolves it cleanly — real name, valid chain order, every module's model
resolving to a real catalog entry).

`gp150_wake_replay.py`'s current form always fetches whatever patch is
*currently active* (no slot argument) and uses one hardcoded captured byte
sequence — good enough to prove the concept, not yet a finished read API.
`patch/gp150_wake_select_read.py SLOT` does the combination — CC0+PC to
pick a specific slot, then the wake/fetch request — for a full Suite-free
read of any slot; **confirmed working live (2026-08-22, slot 10 → "Morse
Purple")**. See `design/GP150_SUPPORT.md` §3.2 for the request/reply
catalog Suite's startup sequence decodes to (patch body,
all 200 names, firmware version, User IR list, SnapTone catalog) and
what's still open (do the varying bytes in the request need to be
correct).

The other 6 requests in that same startup sequence are fetchable the same
way via `patch/gp150_read_catalog.py CATEGORY` — **confirmed live
2026-09-03** for all of them. Three (patch names, User IR list, SnapTone
catalog) share one simple record format (12-byte header + N x 20-byte
index+name records) and are fully decoded (`patch/gp150_catalog.py`);
firmware version and settings are not. One real gotcha: a bare request
alone got no reply for `names` — the `info` (0x00) request has to be sent
first, matching Suite's own request order. See `design/GP150_SUPPORT.md` §3.2.

One real wire-level gotcha found while getting the combined tool working:
once the device is "awake," a single CC0+PC select can trigger more than
one full body broadcast in quick succession — its own unprompted push,
the reply to an explicit fetch sent shortly after, and sometimes more
still (one live listen window caught **four** complete 10-chunk bursts;
the device seems to periodically re-broadcast on its own while connected
and awake, not just once per trigger). `reassemble_body()` alone can't
tell separate bursts apart and silently corrupts the result if their
chunks overlap in one message list. `gp150_wire.split_bursts()` +
`reassemble_first_burst()` fix this: split raw messages into bursts
(new burst wherever chunk index 1 recurs after a higher index was already
seen), decode the first complete one — **confirmed live** (`--settle 0.3`
on slot 5 decoded cleanly to "UK900 DIST" despite four overlapping
bursts). Use these instead of `reassemble_body()` directly for any live
capture that might contain more than one transmission.

## Decoder

`patch/gp150_format.py` — read-only, deliberately no writer (see its
docstring for why). Validated against all 200 real files in
the (private) corpus: 0 decode errors, 200/200 valid chain-order
permutations, 200/200 non-empty names. An early check of just
`MODULE_PARAM_OFFSET` (module → one fixed offset) found 3/2400 values
outside a plausible range, all on `MOD` — explained and superseded by "Full
param layout" below: that offset is only correct for the specific model
each entry was tested against (usually algId 0), not necessarily every
model's algId-0 param. The real, general answer is `module_param_offset()`.

## Checksum (solved 2026-10-08)

`prst[0x0E:0x10]` = CRC-16, polynomial 0x8005 processed bit-reflected (0xA001), initial value 0xE011, no final
xor, over bytes `0x10..0x463` (1114 bytes; the last four bytes of the 1128 are zero padding in every body seen),
stored big-endian. It does not cover the slot index (byte 4): the 100 factory-empty patches differ only there and
share one checksum. `patch/gp150_format.py` `compute_checksum()` / `fix_checksum()` and the JS twin implement it.

How it was found (after standard CRC variants over many ranges had failed): for a CRC, the checksum difference
of two equal-length messages depends only on the difference of the messages, so initial value and final xor drop
out. Taking pairs of real patches that differ in a few bytes, every 16-bit polynomial in every bit order and for
every end offset was tested at once; exactly one candidate fit all pairs (0x8005 reflected, end at 0x464). The
initial value then fell out of a direct solve (any start up to the first varying byte gives an equivalent
value; 0xE011 is for start 0x10). Confirmed on 200/200 files of a real corpus and 200/200 bodies read back from
the pedal in 2026-10 (including slots edited after the export), and on the twelve real files tracked in
`re/gp150_captures`. `readback_slot197_after_bad_checksum.prst` is a body imported with a deliberately wrong
checksum and read back: the pedal stored the correct one.

Hardware check, 2026-10-08: two patches built by the MCP builder (checksum and mask computed by our code) were
written to a scratch slot with the normal full-preset write and read back by index: **0 bytes differed** from what
was sent, so the pedal stores such a body exactly as is. An earlier try with the factory-empty mask came back with
two bytes changed at `0x444-0x445` and a checksum recomputed over them.

### The enabled-module mask at 0x444

`prst[0x444:0x446]` (u16 LE) is a bitmask of the enabled modules, one bit per module (PRE 0x1, WAH 0x2, DST 0x4,
NS 0x8, AMP 0x10, NR 0x20, CAB 0x40, EQ 0x80, MOD 0x100, DLY 0x200, RVB 0x400, VOL 0x800; independent of the chain
order). It reproduces all 200 corpus files; the NS bit is inferred from the sequence (NS is never enabled in the
corpus). The pedal rewrites it itself when it stores a patch, and since it lies inside the checksum range our writers
(`write_module_enabled()`) keep it in step with the enable flags. The other varying bytes of that tail
(`0x448`, `0x44c`) belong to the patch-level settings (footswitch assignments), see GP150-10.

## Open (do not re-derive from scratch, but not solved either)

- **`0x441-0x444` region**: a real, distinct varying region (confirmed in
  the corpus at `0x444-0x445`/`0x448-0x449`/`0x44c-0x44d`, a `0x44`-spaced
  pattern), first flagged from an NS-activation side-effect. **Not** the
  module on/off state — that turned out to be `model_offset - 4` instead
  (see "Module on/off state" above), found independently. **Now placed,
  not decoded**: the 12 modules' 68-byte blocks are confirmed to run
  `0x088` to `0x3B8` (`VOL`'s block end, "Per-module footprint" above) —
  `0x441` sits well past that, in a ~168-byte tail (`0x3B8`-`0x460`ish)
  that isn't part of any module. Most likely home for patch-level settings
  the manual's CC list has but the 12 modules don't (Patch Volume, EXP1/
  EXP2 assignment, Quick Access knobs 1-3, Tempo, Looper) — small integer
  values in that tail (seen: 0-129, mostly under 20) are consistent with
  assignment/index fields rather than raw levels. Unconfirmed; would need a
  live test (change one global setting, e.g. tap tempo or a quick-access
  assignment, diff) to pin down.
