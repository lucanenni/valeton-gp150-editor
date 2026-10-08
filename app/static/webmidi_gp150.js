"use strict";
/*
 * webmidi_gp150.js — read-only WebMIDI client for the GP-150, live in the browser.
 *
 * The browser-side twin of the confirmed-working Python prototype
 * patch/gp150_wake_select_read.py: same CC0+PC slot select, same captured
 * "wake" request replayed verbatim, same chunked-SysEx reassembly — ported
 * from patch/gp150_wire.py, including the split-bursts fix
 * (re/DEVICE_GP150.md, design/GP150_SUPPORT.md §3.2).
 *
 * CONFIRMED WORKING live in a real browser (2026-08-22) — several slots
 * read correctly through the actual /gp150 UI. Went through two real
 * timing issues on the way, both found and fixed live the same day:
 *
 * 1. A slot occasionally came back with only a short (~56-byte) stray
 *    message and nothing else — the same runt seen trailing real bursts in
 *    the Python captures — because the first version of this module waited
 *    for the SysEx stream to go quiet (idle-detection) before decoding, and
 *    exited too early when the real body burst started later than that.
 *    A retry succeeded, confirming a timing race, not a protocol failure.
 * 2. Fixed properly (not just papered over with a longer idle wait, which
 *    made every read slow instead — reported live): `readSlot()` now tries
 *    to decode after EVERY incoming message and resolves the instant any
 *    category's messages form a complete, clean burst, instead of waiting
 *    for quiet at all. This is fast in the common case (resolves the
 *    moment the last needed chunk arrives) and still robust for a
 *    genuinely late burst (case 1 above) — bounded only by
 *    READ_TIMEOUT_MS, an outer safety cap, not a wait target.
 * 3. That exposed a third, more fundamental issue (reported live): reading
 *    slot 80 right after slot 88 showed slot 88's patch. The device keeps
 *    periodically re-broadcasting on its own while "awake" (already known
 *    from the Python side), so a clean, complete, but STALE burst for the
 *    *previous* read can arrive right as a new readSlot() starts listening
 *    — "decodes cleanly" alone doesn't mean "is the slot we just asked
 *    for". Fixed by checking the decoded body's OWN embedded slot index
 *    (`prst[PATCH_INDEX_OFF]`, the same field patch/gp150_format.py reads)
 *    against the requested slot before accepting it (`findMatchingBody()`)
 *    — a stale burst is now skipped rather than returned. This is a
 *    genuinely GP-150-specific problem: GP-5/GP-50's protocol
 *    (webmidi_device.js) never had it, because that device only ever
 *    replies when explicitly asked and doesn't self-rebroadcast, so a
 *    previous reply can't leak into the next request the way it can here.
 *
 * All three fixes re-confirmed live the same day: reading different slots
 * back to back now consistently returns the right one, at normal speed.
 *
 * readCatalog() (readAllNames()/readUserIrs()/readSnaptones()) hit a
 * variant of finding 3 above (2026-09-03): calling readUserIrs() right
 * after readSnaptones() resolved timed out, seeing only stray bursts at
 * the PREVIOUS reply's length — the device kept re-sending it for a
 * while, apparently crowding out the new request/reply rather than just
 * coexisting alongside it. Fixed with a UI-level settle (gp150.js) plus a
 * mid-window resend inside readCatalog() itself if nothing has matched by
 * halfway through READ_TIMEOUT_MS — see its own comment for detail. Not
 * yet re-confirmed live.
 *
 * No Valeton Suite needed — same finding as the Python side.
 *
 * Write path (sendSetParam/sendEnable/sendModelSwap/sendReorder/sendSave):
 * LIVE-CONFIRMED on real hardware 2026-09-20 (design/GP150_SUPPORT.md
 * GP150-6) — the wire tag (raw byte 1, distinct from the payload checksum)
 * is CRC-8 (poly 0x31, init 0, no reflection) over raw[2:], masked to 7
 * bits, computed by computeWireTag(). This was ported from Python's
 * patch/gp150_set_param.py after it was cracked and verified there; this
 * JS port itself has not yet been separately exercised against the real
 * pedal (only the Python side has), so treat it as a direct, faithful
 * port rather than independently re-confirmed.
 *
 *   const dev = await WebMidiGP150.connect();       // {name, port}; throws if none found
 *   const body = await WebMidiGP150.readSlot(5);     // Uint8Array, 1128 bytes, a raw .prst body
 *
 * `readSlot`'s result is a raw GP-150 `.prst` body — hand it to gp150.js's
 * existing inspect() as a File to reuse the whole render pipeline (which
 * calls the already-tested Python decoder server-side); this module does
 * not decode the body itself.
 */
(function (root) {
  const CHUNK_HEADER_LEN = 8; // bytes before a chunk's nibble payload starts
  const CHUNK_CATEGORY_IDX = 6; // offset within a chunk of the category tag
  const CHUNK_INDEX_IDX = 7; // offset within a chunk of the 1-based chunk index
  const BODY_PREFIX_LEN = 8; // bytes before the .prst body starts, in the decoded stream
  const PRST_LEN = 1128; // GP-150 .prst body length (patch/gp150_format.py PRST_LEN)
  const PATCH_INDEX_OFF = 4; // offset of the 0-based slot index within a decoded .prst body (patch/gp150_format.py PATCH_INDEX_OFF)

  // Verbatim from patch/gp150_wake_replay.py's WAKE_REQUEST_BYTES — copied via
  // plistlib from a real MIDI Monitor capture of Suite connecting fresh, not
  // hand-typed or guessed. See that script's docstring for the full provenance.
  const WAKE_REQUEST_BYTES = [
    127, 92, 15, 0, 0, 0, 1, 0, 0, 1, 8, 2, 0, 11, 0, 0, 0, 3, 0, 3, 1, 1, 3,
    0, 1, 1, 3, 0, 0, 2, 0, 0, 15, 15, 15, 15, 0, 1,
  ];

  // Verbatim from patch/gp150_read_catalog.py's REQUESTS dict (same
  // provenance as WAKE_REQUEST_BYTES above — plistlib, startup_sequence.mmon).
  // "info" (category 0x00) has to be sent before "names" or the device only
  // acks and never sends the actual reply — confirmed live 2026-09-03, see
  // patch/gp150_read_catalog.py's docstring.
  const INFO_REQUEST_BYTES = [127, 37, 12, 0, 0, 0, 0, 0, 0, 1, 5, 3, 0, 8, 0, 0, 0, 3, 0, 1, 7, 0, 1, 0, 7, 0, 1, 0, 0, 2, 0, 0];
  const NAMES_REQUEST_BYTES = [127, 124, 12, 0, 0, 0, 2, 0, 0, 1, 8, 14, 0, 8, 0, 0, 0, 3, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 2, 0, 0];
  const USER_IRS_REQUEST_BYTES = [127, 81, 12, 0, 0, 0, 5, 0, 0, 1, 0, 12, 0, 8, 0, 0, 0, 3, 0, 1, 4, 2, 1, 0, 4, 2, 1, 0, 0, 2, 0, 0];
  const SNAPTONES_REQUEST_BYTES = [127, 97, 12, 0, 0, 0, 6, 0, 0, 1, 11, 1, 0, 8, 0, 0, 0, 3, 0, 1, 5, 2, 1, 0, 5, 2, 1, 0, 0, 2, 0, 0];
  // The 7th catalog category (NAM models), taken byte-for-byte from a
  // capture of Suite's own NAM-list screen (the other six are
  // info/names/settings/firmware/user_irs/snaptones). Confirmed live: index 1-20
  // are the real NAM slots (literal 1-based, matching NAM upload's own
  // targetSlot convention), showing the exact names of 2 real uploads
  // done earlier this session (two models at slots 1 and 2, a third at slot 3) --
  // independent, programmatic proof the NAM upload path (GP150-9)
  // actually works, not just visual confirmation on the pedal's screen.
  // Same 2032-byte / 101-entry-shaped reply as SnapTones (indices 21-100
  // just read back as unused "Empty" placeholders past NAM's real 20).
  const NAM_REQUEST_BYTES = [127, 125, 12, 0, 0, 0, 7, 0, 0, 1, 3, 10, 0, 8, 0, 0, 0, 3, 0, 1, 9, 2, 1, 0, 9, 2, 1, 0, 0, 2, 0, 0];
  const INDEXED_RECORD_HEADER_LEN = 12; // patch/gp150_catalog.py's INDEXED_RECORD_HEADER_LEN
  const INDEXED_RECORD_LEN = 20; // patch/gp150_catalog.py's INDEXED_RECORD_LEN
  const ALL_NAMES_COUNT = 200;
  const ALL_NAMES_REPLY_LEN = INDEXED_RECORD_HEADER_LEN + ALL_NAMES_COUNT * INDEXED_RECORD_LEN; // 4012, confirmed live
  const USER_IRS_REPLY_LEN = 412; // 20 entries, confirmed live 2026-09-03
  const SNAPTONES_REPLY_LEN = 2032; // 101 entries, confirmed live 2026-09-03
  const NAM_CATALOG_REPLY_LEN = 2032; // same shape as SnapTones; only indices 1-20 are real NAM slots, confirmed live 2026-09-26

  const INFO_REPLY_WAIT_MS = 1500; // how long a catalog read waits for the 'info' reply before sending its request
  const DEFAULT_SETTLE_MS = 300; // confirmed safe live in the Python port (--settle 0.3)
  // Outer safety cap only, not a wait target — readSlot() resolves as soon as
  // a burst decodes cleanly (usually near-instant); this just bounds the
  // genuinely-no-reply / never-decodes case so it fails instead of hanging.
  const READ_TIMEOUT_MS = 6000;
  const MATCH_SETTLE_MS = 300; // readCatalog(): grace period after a first length-match before committing, so a same-length reply still in flight isn't lost to a stale one that happened to complete first

  // --- wire codec (port of patch/gp150_wire.py) -------------------------------
  function nibblesToBytes(nibbles) {
    const n = nibbles.length - (nibbles.length % 2);
    const out = [];
    for (let i = 0; i < n; i += 2) out.push((nibbles[i] << 4) | nibbles[i + 1]);
    return out;
  }

  // Inverse of nibblesToBytes() -- port of patch/gp150_wire.py's
  // bytes_to_nibbles(): split each byte into (hi, lo) nibbles, high
  // nibble first. Needed for the write direction only.
  function bytesToNibbles(bytes) {
    const out = [];
    for (const b of bytes) {
      out.push((b >> 4) & 0xf, b & 0xf);
    }
    return out;
  }

  function groupChunks(messages) {
    const out = new Map();
    for (const m of messages) {
      if (m.length <= CHUNK_HEADER_LEN) continue;
      out.set(m[CHUNK_INDEX_IDX], m.slice(CHUNK_HEADER_LEN));
    }
    return out;
  }

  // Chunk messages (one burst) -> the full decoded nibble stream, whatever
  // length it turns out to be. No fixed-length/prefix assumption —
  // reassembleBody() below is just this plus the active-patch-specific
  // framing. Use this directly for other reply shapes (bulk names, User
  // IR list, SnapTone catalog — see readAllNames() and patch/
  // gp150_catalog.py). Mirrors gp150_wire.reassemble_stream().
  function reassembleStream(messages) {
    const chunks = groupChunks(messages);
    if (!chunks.size) throw new Error("no chunks given");
    const n = Math.max(...chunks.keys());
    const missing = [];
    for (let i = 1; i <= n; i++) if (!chunks.has(i)) missing.push(i);
    if (missing.length) throw new Error(`missing chunk indices: ${missing.join(",")}`);
    let nibbles = [];
    for (let i = 1; i <= n; i++) nibbles = nibbles.concat(chunks.get(i));
    return nibblesToBytes(nibbles);
  }

  // GP150-11 (2026-09-24): a real live test caught this decoding a
  // DIFFERENT category's reply (something else long enough to pass the
  // length check below) as if it were a .prst body, because nothing
  // here verified the result actually LOOKS like one -- multiple
  // categories can be mid-transfer at once (the pedal's own periodic
  // self-broadcast, catalog replies, etc.), and "long enough" alone
  // isn't a safe enough filter once more than one read path (readSlot(),
  // readActivePreset(), startLiveSync()) can all be listening around the
  // same time. Same header bytes patch/gp150_format.py's HEADER_GP150
  // checks (isGp150()) -- duplicated here rather than depending on that
  // file's own global, since this module has no other dependency on it.
  const HEADER_GP150 = [0x11, 0x30, 0x64, 0x04];
  function reassembleBody(messages) {
    const decoded = reassembleStream(messages);
    if (decoded.length < BODY_PREFIX_LEN + PRST_LEN) {
      throw new Error(`decoded ${decoded.length} bytes, need at least ${BODY_PREFIX_LEN + PRST_LEN} (prefix + full body)`);
    }
    const body = decoded.slice(BODY_PREFIX_LEN, BODY_PREFIX_LEN + PRST_LEN);
    for (let i = 0; i < HEADER_GP150.length; i++) {
      if (body[i] !== HEADER_GP150[i]) throw new Error("decoded body doesn't start with the GP-150 header -- not a .prst body (a different reply category, most likely)");
    }
    return body;
  }

  // Split raw chunk messages (arrival order) into separate bursts: a new
  // burst starts whenever chunk index 1 recurs after a higher index has
  // already been seen in the current one. Real devices can deliver more
  // than one full burst inside one listen window (the device's own
  // unprompted push from CC0+PC, plus the reply to our explicit fetch, and
  // sometimes more) — this tells them apart. Mirrors gp150_wire.split_bursts().
  function splitBursts(messages) {
    const bursts = [];
    let cur = [];
    let seenGt1 = false;
    for (const m of messages) {
      if (m.length <= CHUNK_HEADER_LEN) continue;
      const idx = m[CHUNK_INDEX_IDX];
      if (idx === 1 && seenGt1) {
        bursts.push(cur);
        cur = [];
        seenGt1 = false;
      }
      cur.push(m);
      if (idx > 1) seenGt1 = true;
    }
    if (cur.length) bursts.push(cur);
    return bursts;
  }

  // splitBursts() + return the first burst that reassembleBody() decodes
  // cleanly. Mirrors gp150_wire.reassemble_first_burst().
  function reassembleFirstBurst(messages) {
    const errors = [];
    const bursts = splitBursts(messages);
    for (let i = 0; i < bursts.length; i++) {
      try {
        return reassembleBody(bursts[i]);
      } catch (e) {
        errors.push(`burst ${i + 1} (${bursts[i].length} msgs): ${e.message}`);
      }
    }
    throw new Error(`no burst reassembled cleanly out of ${errors.length}: ${errors.join("; ")}`);
  }

  // Walk every category's bursts (not just the first that decodes) looking
  // for one whose OWN embedded slot index (prst[PATCH_INDEX_OFF], same
  // field patch/gp150_format.py reads) matches `expectedSlot`. Needed
  // because the device can keep re-broadcasting a *previous* read on its
  // own (observed live) — a clean, complete, but STALE burst for the last
  // slot read can otherwise arrive right as a new readSlot() starts
  // listening and get accepted as if it were the new slot's data (a real
  // bug found live 2026-08-22: reading slot 80 right after slot 88 showed
  // slot 88's patch). Returns {body, seenSlots} — body is null if no
  // burst yet matches; seenSlots collects every slot index actually seen,
  // for a useful error message if we time out without a match.
  function findMatchingBody(byCategory, expectedSlot) {
    const seenSlots = new Set();
    for (const msgs of byCategory.values()) {
      for (const burst of splitBursts(msgs)) {
        let body;
        try {
          body = reassembleBody(burst);
        } catch (e) {
          continue; // incomplete or corrupt — not a candidate yet
        }
        seenSlots.add(body[PATCH_INDEX_OFF]);
        if (body[PATCH_INDEX_OFF] === expectedSlot) return { body, seenSlots };
      }
    }
    return { body: null, seenSlots };
  }

  // Same idea as findMatchingBody(), for non-.prst-shaped replies
  // (readAllNames() below): walk every category's bursts looking for one
  // whose reassembled STREAM LENGTH matches `expectedLen` — the device can
  // still be re-broadcasting an unrelated earlier readSlot() body in the
  // background, and a bare "decodes cleanly" check can't tell a stray
  // 1136-byte body burst from the 4012-byte names reply we actually want.
  // Returns {stream, seenLens}.
  // Two catalogs can share the same reply length (NAM and SnapTones are
  // both 2032 bytes, found live 2026-09-26 wiring up readNamModels()) --
  // and the wire's own reply category tag can't disambiguate them either,
  // since it isn't a fixed per-catalog-type opcode (confirmed live: the
  // SAME NAM request got tagged 0x3b in one call and 0x71 in the very
  // next, content identical -- matches this project's older, separate
  // finding for the write family that "the category tag is not a fixed
  // opcode"). So instead of matching the first length-matching burst,
  // this returns the LAST one seen (Map/array insertion order = arrival
  // order): a category value freshly assigned to OUR just-sent request
  // is necessarily inserted after whatever stale/re-broadcast burst from
  // an earlier read might already be sitting in `byCategory`.
  function findMatchingStream(byCategory, expectedLen) {
    const seenLens = new Set();
    let best = null;
    for (const msgs of byCategory.values()) {
      for (const burst of splitBursts(msgs)) {
        let stream;
        try {
          stream = reassembleStream(burst);
        } catch (e) {
          continue;
        }
        seenLens.add(stream.length);
        if (expectedLen == null || stream.length === expectedLen) best = stream;
      }
    }
    if (best) return { stream: best, seenLens };
    return { stream: null, seenLens };
  }

  // One acknowledgement per completed reply (category) in `byCategory` that is not in `acked` yet (updated).
  // Returns how many were sent.
  function ackCompleted(byCategory, acked) {
    let sent = 0;
    for (const [cat, msgs] of byCategory) {
      if (acked.has(cat)) continue;
      let complete = false;
      for (const burst of splitBursts(msgs)) {
        try { reassembleStream(burst); complete = true; break; } catch (e) { /* partial burst */ }
      }
      if (!complete) continue;
      acked.add(cat);
      try { output.send([0xf0, ...buildAckMessage(cat), 0xf7]); sent++; } catch (e) { /* the read itself succeeded */ }
    }
    return sent;
  }

  // Shared record format for the bulk names/User-IR/SnapTone catalog
  // replies (patch/gp150_catalog.decode_indexed_records()): a 12-byte
  // header then N x 20-byte records, each a little-endian u32 index + a
  // 16-byte null-padded name. N falls out of `stream`'s length.
  function decodeIndexedRecords(stream) {
    if (stream.length < INDEXED_RECORD_HEADER_LEN) {
      throw new Error(`stream is ${stream.length} bytes, shorter than the ${INDEXED_RECORD_HEADER_LEN}-byte header`);
    }
    const body = stream.slice(INDEXED_RECORD_HEADER_LEN);
    const n = Math.floor(body.length / INDEXED_RECORD_LEN);
    if (n * INDEXED_RECORD_LEN !== body.length) {
      throw new Error(`${body.length} bytes after the header isn't a whole number of ${INDEXED_RECORD_LEN}-byte records`);
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const rec = body.slice(i * INDEXED_RECORD_LEN, (i + 1) * INDEXED_RECORD_LEN);
      const index = rec[0] | (rec[1] << 8) | (rec[2] << 16) | (rec[3] << 24);
      let end = 4;
      while (end < INDEXED_RECORD_LEN && rec[end] !== 0) end++;
      const name = String.fromCharCode(...rec.slice(4, end)).trim();
      out.push({ index, name });
    }
    return out;
  }

  // Manual p.77-78 split across the full 200-slot range: 001-128 (slot
  // 0-127) use CC0=0 + PC=slot; 129-200 (slot 128-199) use CC0=1 +
  // PC=slot-128. Mirrors gp150_wake_select_read.bank_and_pc().
  function bankAndPc(slot) {
    if (!(slot >= 0 && slot <= 199)) throw new Error(`slot must be 0-199, got ${slot}`);
    return slot < 128 ? [0, slot] : [1, slot - 128];
  }

  // --- write path: chain reorder (port of patch/gp150_set_param.py) ----------
  // GP150-6 write status as of 2026-09-20 (design/GP150_SUPPORT.md): BOTH
  // the per-message payload checksum AND the raw header's own wire `tag`
  // are solved, and both are auto-computed by these builders. Live-
  // confirmed on real hardware: a from-scratch set-param edit (watched on
  // the pedal's own display) and a full live-edit+save round-trip
  // (verified by read-back). Still no ack this code can check for any
  // single message -- for a set-param/enable/model-swap/reorder edit, the
  // pedal's own display remains the only immediate confirmation; a save
  // can be confirmed by reading the slot back.

  // Same 12 modules -> `FF` id (fxid_ring_gp150.json's moduleId field) used
  // everywhere else in this project's GP-150 write-path research.
  const MODULE_FF = {
    PRE: 0, WAH: 1, DST: 2, NS: 3, AMP: 4, NR: 5,
    CAB: 6, EQ: 7, MOD: 8, DLY: 9, RVB: 10, VOL: 11,
  };

  const REORDER_PAYLOAD_LEN = 24; // decoded payload length
  const REORDER_ORDER_OFFSET = 12; // decoded payload byte where the 12-entry order starts
  const CHECKSUM_POLY = 0x31;
  const CHECKSUM_START = 5; // decoded payload offset the checksum is computed from

  // CRC-8, poly 0x31, init 0, no reflection, no xorout -- cracked against
  // 23 real (payload, checksum) pairs, zero exceptions (patch/gp150_set_param.py's _crc8()).
  function crc8(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x80) ? ((crc << 1) ^ CHECKSUM_POLY) & 0xff : (crc << 1) & 0xff;
      }
    }
    return crc;
  }

  const computeChecksum = (payload) => crc8(payload.slice(CHECKSUM_START));

  // The raw header's own byte 1 "tag" -- SOLVED and LIVE-CONFIRMED
  // 2026-09-19/20 (design/GP150_SUPPORT.md §3.1): the SAME CRC-8 as
  // computeChecksum() above, just over a wider range and masked to 7 bits
  // (MIDI data bytes can't carry bit 7) -- everything from raw[2] (after
  // the tag byte itself) through the end of the nibble-encoded payload.
  // Port of patch/gp150_set_param.py's compute_wire_tag(). Verified
  // against 362/363 historical captures and all 17 templates in the
  // Python module, zero exceptions; live-confirmed on real hardware
  // twice (a from-scratch set-param edit watched on the pedal's own
  // display, and a full live-edit+save round-trip verified by read-back).
  const computeWireTag = (raw) => crc8(raw.slice(2)) & 0x7f;

  // Wrap a fully-populated decoded payload (checksum byte not set yet) in
  // an 8-byte raw header, nibble-encode it, poke in the correct payload
  // checksum, then the correct wire tag (auto-computed unless `tag`
  // overrides it) -- port of _build_from_payload()/
  // _recompute_payload_checksum().
  function buildFromPayload(payload, tag, counter) {
    const header = [0x7f, 0, payload.length, 0, 0, 0, (counter ?? 1) & 0xff, 0];
    const raw = header.concat(bytesToNibbles(payload));
    const checksum = computeChecksum(payload);
    raw[8 + 2 * 1] = (checksum >> 4) & 0xf;
    raw[8 + 2 * 1 + 1] = checksum & 0xf;
    raw[1] = (tag != null ? tag : computeWireTag(raw)) & 0xff;
    return raw;
  }

  // Build a 56-byte chain-reorder message. `order` is the new chain, all
  // 12 MODULE_FF keys in their new order. Port of build_reorder_message().
  function buildReorderMessage(order, tag, counter) {
    const expected = Object.keys(MODULE_FF).slice().sort();
    if (order.slice().sort().join(",") !== expected.join(",")) {
      throw new Error(`order must contain all 12 modules exactly once, got ${JSON.stringify(order)}`);
    }
    const payload = new Array(REORDER_PAYLOAD_LEN).fill(0);
    payload[0] = 0x01;
    payload[2] = 0x14;
    payload[5] = 0x03;
    payload[6] = 0x34; payload[7] = 0x30; payload[8] = 0x34; payload[9] = 0x30;
    payload[10] = 0x10;
    order.forEach((module, i) => { payload[REORDER_ORDER_OFFSET + i] = MODULE_FF[module]; });
    return buildFromPayload(payload, tag, counter);
  }

  // Build and send a chain-reorder message live. Fire-and-forget, like the
  // rest of this write path -- no ack to wait for, check the pedal's own
  // display. Returns the raw bytes actually sent (for UI display/debug).
  function sendReorder(order) {
    assertReady();
    const message = buildReorderMessage(order);
    output.send([0xf0, ...message, 0xf7]);
    return message;
  }

  // --- write path: set-param / enable-disable / save (port of patch/gp150_set_param.py) --
  // Same solved-and-live-confirmed wire tag as buildReorderMessage() above.

  const SET_PARAM_HEADER_LEN = 8; // raw bytes before the nibble payload
  const ENABLE_PAYLOAD_LEN = 16; // decoded payload length

  // One captured 56-byte raw template per module (tag/counter/value/algId
  // all get overwritten before sending -- only the template's constant
  // structure and MM/T1/T2 model bytes matter, and MM/T1/T2 get
  // recomputed too whenever a live `fxid` is supplied). Copied verbatim
  // from CAPTURED_TEMPLATES in patch/gp150_set_param.py.
  const CAPTURED_TEMPLATES = {
    PRE: [127, 46, 24, 0, 0, 0, 50, 0, 0, 1, 14, 10, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 8, 4, 1,
      0, 0, 0, 0, 0, 0, 0, 0],
    WAH: [127, 104, 24, 0, 0, 0, 52, 0, 0, 1, 8, 2, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 5, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 8, 12, 4, 2,
      0, 1, 0, 0, 0, 0, 0, 0],
    DST: [127, 107, 24, 0, 0, 0, 33, 0, 0, 1, 8, 14, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 14, 4, 2,
      0, 2, 0, 0, 0, 0, 0, 0],
    NS: [127, 62, 24, 0, 0, 0, 54, 0, 0, 1, 14, 5, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 15, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 8, 10, 4, 2,
      0, 3, 0, 0, 0, 0, 0, 0],
    AMP: [127, 82, 24, 0, 0, 0, 9, 0, 0, 1, 1, 0, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 7, 0, 0, 0, 0, 4, 14, 0, 0, 0, 0, 8, 14, 4, 2,
      0, 4, 0, 0, 0, 0, 0, 0],
    NR: [127, 31, 24, 0, 0, 0, 35, 0, 0, 1, 6, 2, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 9, 4, 3,
      0, 5, 0, 2, 0, 0, 0, 0],
    CAB: [127, 12, 24, 0, 0, 0, 16, 0, 0, 1, 4, 0, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      1, 10, 0, 0, 0, 1, 5, 0, 0, 0, 0, 0, 3, 4, 4, 2,
      0, 6, 0, 1, 0, 0, 0, 0],
    EQ: [127, 105, 24, 0, 0, 0, 57, 0, 0, 1, 15, 1, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 1, 0, 0, 0, 0, 3, 5, 0, 0, 0, 0, 9, 0, 4, 1,
      0, 7, 0, 0, 0, 0, 0, 0],
    MOD: [127, 72, 24, 0, 0, 0, 59, 0, 0, 1, 7, 4, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 4, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 7, 4, 4, 2,
      0, 8, 0, 0, 0, 0, 0, 0],
    DLY: [127, 38, 24, 0, 0, 0, 31, 0, 0, 1, 14, 10, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 11, 0, 0, 0, 0, 1, 13, 0, 0, 0, 0, 5, 4, 4, 2,
      0, 9, 0, 0, 0, 0, 0, 0],
    RVB: [127, 62, 24, 0, 0, 0, 29, 0, 0, 1, 10, 5, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 12, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 4, 4, 4, 2,
      0, 10, 0, 0, 0, 0, 0, 0],
    VOL: [127, 51, 24, 0, 0, 0, 38, 0, 0, 1, 9, 10, 1, 4, 0, 0,
      0, 0, 0, 3, 3, 3, 3, 0, 3, 3, 3, 0, 1, 0, 0, 0,
      0, 6, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 8, 2, 4, 2,
      0, 11, 0, 0, 0, 0, 0, 0],
  };

  // Overwrite the two raw nibble-bytes that decode to `value` at
  // `decodedIndex` of the payload -- port of _poke_decoded_byte().
  function pokeDecodedByte(raw, decodedIndex, value) {
    const pos = SET_PARAM_HEADER_LEN + 2 * decodedIndex;
    raw[pos] = (value >> 4) & 0xf;
    raw[pos + 1] = value & 0xf;
  }

  // Split a model's fxid (fxid_ring_gp150.json) into (MM, T1, T2) -- every
  // real fxid decomposes as big-endian bytes [MM, 0x00, T1, T2]. Port of
  // fxid_to_mm_t1_t2(); throws if that pattern doesn't hold.
  function fxidToMmT1T2(fxid) {
    const b = [(fxid >>> 24) & 0xff, (fxid >>> 16) & 0xff, (fxid >>> 8) & 0xff, fxid & 0xff];
    if (b[1] !== 0) throw new Error(`fxid 0x${fxid.toString(16)} has a non-zero second byte -- MM/T1/T2 split doesn't apply`);
    return [b[0], b[2], b[3]];
  }

  function float32LEBytes(value) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    return new Uint8Array(buf);
  }

  function float64LEBytes(value) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    return new Uint8Array(buf);
  }

  // Decode raw[SET_PARAM_HEADER_LEN:]'s nibbles back to bytes, compute the
  // checksum over payload[CHECKSUM_START:], poke it into decoded_index 1.
  // Port of _recompute_payload_checksum() -- must run AFTER every other
  // payload edit.
  function recomputePayloadChecksum(raw) {
    const payload = nibblesToBytes(raw.slice(SET_PARAM_HEADER_LEN));
    const checksum = computeChecksum(payload);
    pokeDecodedByte(raw, 1, checksum);
  }

  // Build a 56-byte set-param message for `module`, targeting parameter
  // `algid` with the new `value`. Port of build_set_param_message(). Pass
  // the module's live `fxid` (from the current inspect() response) to
  // keep MM/T1/T2 correct if the module's model has changed since the
  // captured template -- omit to trust the template's model.
  function buildSetParamMessage(module, algid, value, { fxid, tag, counter } = {}) {
    if (!CAPTURED_TEMPLATES[module]) throw new Error(`unknown module ${module}`);
    if (!(algid >= 0 && algid <= 255)) throw new Error(`algid must be a single byte (0-255), got ${algid}`);
    const raw = CAPTURED_TEMPLATES[module].slice();
    if (counter != null) raw[6] = counter & 0xff;
    if (fxid != null) {
      const [mm, t1, t2] = fxidToMmT1T2(fxid);
      pokeDecodedByte(raw, 12, mm);
      pokeDecodedByte(raw, 14, t1);
      pokeDecodedByte(raw, 15, t2);
    }
    const valueBytes = float32LEBytes(value);
    valueBytes.forEach((b, i) => pokeDecodedByte(raw, 16 + i, b));
    pokeDecodedByte(raw, 21, algid);
    recomputePayloadChecksum(raw);
    raw[1] = (tag != null ? tag : computeWireTag(raw)) & 0xff;
    return raw;
  }

  const SAVE_PAYLOAD_LEN = 32; // decoded payload length
  const SAVE_NAME_OFFSET = 16; // decoded payload byte where the name starts
  const SAVE_NAME_MAX_LEN = 16; // decoded payload bytes 16-31

  // Copied verbatim from CAPTURED_SAVE_TEMPLATE in patch/gp150_set_param.py.
  const CAPTURED_SAVE_TEMPLATE = [
    127, 125, 32, 0, 0, 0, 16, 0, 0, 1, 1, 0, 1, 12, 0, 0,
    0, 0, 0, 1, 2, 0, 1, 0, 2, 0, 1, 0, 1, 8, 0, 0,
    12, 7, 0, 0, 0, 0, 0, 0, 5, 5, 4, 11, 3, 9, 3, 0,
    3, 0, 2, 0, 4, 4, 4, 9, 5, 3, 5, 4, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ];

  // Build a 72-byte save/commit message targeting 0-based `slot` with
  // `name` (ASCII, truncated/null-padded to SAVE_NAME_MAX_LEN bytes).
  // Port of build_save_message() -- sent once after one or more set-param
  // edits to persist the device's current live state.
  function buildSaveMessage(slot, name, { tag, counter } = {}) {
    if (!(slot >= 0 && slot <= 199)) throw new Error(`slot must be 0-199, got ${slot}`);
    if (!/^[\x00-\x7f]*$/.test(name)) throw new Error(`name must be ASCII: ${JSON.stringify(name)}`);
    const nameBytes = Array.from(name, (c) => c.charCodeAt(0));
    if (nameBytes.length > SAVE_NAME_MAX_LEN) {
      throw new Error(`name too long (${nameBytes.length} bytes, max ${SAVE_NAME_MAX_LEN}): ${JSON.stringify(name)}`);
    }
    while (nameBytes.length < SAVE_NAME_MAX_LEN) nameBytes.push(0);

    const raw = CAPTURED_SAVE_TEMPLATE.slice();
    if (counter != null) raw[6] = counter & 0xff;
    pokeDecodedByte(raw, 12, slot);
    nameBytes.forEach((b, i) => pokeDecodedByte(raw, SAVE_NAME_OFFSET + i, b));
    recomputePayloadChecksum(raw);
    raw[1] = (tag != null ? tag : computeWireTag(raw)) & 0xff;
    return raw;
  }

  // Build a 40-byte message turning `module` on or off as a whole. Built
  // from scratch (not template-based) -- port of build_enable_message().
  function buildEnableMessage(module, on, tag, counter) {
    if (!MODULE_FF.hasOwnProperty(module)) throw new Error(`unknown module ${module}`);
    const payload = new Array(ENABLE_PAYLOAD_LEN).fill(0);
    payload[0] = 0x01;
    payload[2] = 0x0c;
    payload[5] = 0x03;
    payload[6] = 0x31; payload[7] = 0x30; payload[8] = 0x31; payload[9] = 0x30;
    payload[10] = 0x08;
    payload[12] = MODULE_FF[module];
    payload[13] = on ? 1 : 0;
    return buildFromPayload(payload, tag, counter);
  }

  const MODEL_SWAP_PAYLOAD_LEN = 20; // decoded payload length

  // Build a 48-byte message switching `module`'s active model to
  // `targetFxid` (any fxid from the /api/device/gp150/models catalog).
  // Built from scratch -- port of build_model_swap_message().
  function buildModelSwapMessage(module, targetFxid, tag, counter) {
    if (!MODULE_FF.hasOwnProperty(module)) throw new Error(`unknown module ${module}`);
    if (!(targetFxid >= 0 && targetFxid <= 0xffffffff)) throw new Error(`targetFxid must fit in 4 bytes, got ${targetFxid}`);
    const payload = new Array(MODEL_SWAP_PAYLOAD_LEN).fill(0);
    payload[0] = 0x01;
    payload[2] = 0x10;
    payload[5] = 0x03;
    payload[6] = 0x32; payload[7] = 0x30; payload[8] = 0x32; payload[9] = 0x30;
    payload[10] = 0x0c;
    // struct.pack("<I", targetFxid) -- little-endian, 4 bytes
    payload[12] = targetFxid & 0xff;
    payload[13] = (targetFxid >>> 8) & 0xff;
    payload[14] = (targetFxid >>> 16) & 0xff;
    payload[15] = (targetFxid >>> 24) & 0xff;
    payload[16] = MODULE_FF[module];
    return buildFromPayload(payload, tag, counter);
  }

  // Build and send a set-param / enable / model-swap message live.
  // Fire-and-forget, no ack -- check the pedal's own display.
  function sendSetParam(module, algid, value, opts) {
    assertReady();
    const message = buildSetParamMessage(module, algid, value, opts);
    output.send([0xf0, ...message, 0xf7]);
    return message;
  }

  function sendEnable(module, on) {
    assertReady();
    const message = buildEnableMessage(module, on);
    output.send([0xf0, ...message, 0xf7]);
    return message;
  }

  function sendModelSwap(module, targetFxid) {
    assertReady();
    const message = buildModelSwapMessage(module, targetFxid);
    output.send([0xf0, ...message, 0xf7]);
    return message;
  }

  function sendSave(slot, name) {
    assertReady();
    const message = buildSaveMessage(slot, name);
    output.send([0xf0, ...message, 0xf7]);
    return message;
  }

  // --- write path: GP150-10 patch-level settings (PatchData struct family) --
  // Confirmed live 2026-09-23 (BACKLOG_GP150.md GP150-10): every PatchData write
  // (setPresetInfo/quickKonb/expCtrl/setFsSetting) reuses the exact same
  // envelope as GP150-6's own bespoke messages above -- payload =
  // [0x01, checksum, dataLen+8, 0, 0, 0x03, <struct bytes>] -- just with
  // the struct's own "magic(u16) x2 + datasize(u16)" 6-byte header at
  // payload[6:12] standing in for GP150-6's ASCII msgId + explicit dataLen
  // pair. Verified byte-for-byte against 2 independent live captures
  // (expCtrl, an isolated BPM-drag presetInfo capture) plus 2 more fully
  // decoded from a second capture round (quickKonb, setFsSetting).
  //
  // Always built from a real live-read body's OWN bytes (never
  // zero-filled/synthesized) for every byte this project doesn't have a
  // confirmed field for (PresetInfo's author name + notes, ExpCtrl's own
  // 4 trailing reserved bytes) -- these are full-state sends, not deltas,
  // so guessing an unknown byte would silently corrupt/erase real data on
  // the pedal. Callers pass the body AFTER patching the one field being
  // edited with GP150Format's writePresetBpm/writeQuickKnob/etc., and this
  // just slices the relevant struct's byte range back out of it.
  const PATCHDATA_MAGIC = { PRESET_INFO: 0x3020, QUICK_KNOB: 0x3050, EXP_CTRL: 0x3060, FS_SETTING: 0x3080 };

  // Max decoded payload bytes carried by one chunk/raw SysEx message --
  // inferred from the live 2-chunk expCtrl capture (124-byte payload split
  // at byte offset 119, i.e. chunk 0 = 119 bytes, chunk 1 = the remaining
  // 5) and cross-checked against a full 1128-byte body read needing a
  // "full 10-chunk burst" (1136 decoded bytes incl. the 8-byte prefix,
  // 1136/119 ~= 10) -- consistent on both, but only ExpCtrl has ever
  // exercised the actual multi-chunk SEND path live; treat a >1-chunk
  // send as one step less confirmed than every single-chunk one here.
  const PATCHDATA_CHUNK_MAX_BYTES = 119;

  // Build every chunk of one PatchData write as raw (nibble-encoded, tag
  // and checksum already computed) message arrays -- almost always just
  // one for QuickKnob/PresetInfo/FsSetting, two for ExpCtrl. `dataBytes`
  // is the struct's own data (after its magic/datasize header), taken
  // verbatim from a live body via sliceStructBytes() below.
  function buildPatchDataChunks(magic, dataBytes, counter) {
    const dataLen = dataBytes.length;
    const payload = new Array(12 + dataLen).fill(0);
    payload[0] = 0x01;
    payload[2] = 8 + dataLen;
    payload[5] = 0x03;
    payload[6] = magic & 0xff; payload[7] = (magic >> 8) & 0xff;
    payload[8] = magic & 0xff; payload[9] = (magic >> 8) & 0xff;
    payload[10] = dataLen & 0xff; payload[11] = (dataLen >> 8) & 0xff;
    Array.from(dataBytes).forEach((b, i) => { payload[12 + i] = b; });
    payload[1] = computeChecksum(payload);

    const cnt = (counter ?? 1) & 0xff;
    const totalLen = payload.length;
    const chunks = [];
    for (let offset = 0, idx = 0; offset < totalLen; idx++) {
      const sliceLen = Math.min(PATCHDATA_CHUNK_MAX_BYTES, totalLen - offset);
      const slice = payload.slice(offset, offset + sliceLen);
      const header = [0x7f, 0, totalLen, 0, offset, 0, cnt, idx];
      const raw = header.concat(bytesToNibbles(slice));
      raw[1] = computeWireTag(raw) & 0x7f;
      chunks.push(raw);
      offset += sliceLen;
    }
    return chunks;
  }

  // Send every chunk of one PatchData write live, in order. Fire-and-
  // forget like the rest of this write path -- no ack to wait for.
  // Returns the flat array of raw chunk byte-arrays actually sent (for
  // UI display/debug), same convention as the other send* functions.
  function sendPatchDataChunks(magic, dataBytes) {
    assertReady();
    const chunks = buildPatchDataChunks(magic, dataBytes);
    for (const raw of chunks) output.send([0xf0, ...raw, 0xf7]);
    return chunks;
  }

  // `body` is a live-read 1128-byte .prst body (Uint8Array), typically
  // just patched with GP150Format's writePresetBpm/writePatchVolume/
  // writePresetNam so only the field(s) actually being edited differ from
  // what the pedal already has.
  function sendPresetInfo(body) {
    const F = root.GP150Format;
    const data = body.slice(F.PRESET_BPM_OFF, F.PRESET_BPM_OFF + 80);
    return sendPatchDataChunks(PATCHDATA_MAGIC.PRESET_INFO, data);
  }

  // `body` is a live-read body, patched with GP150Format.writeQuickKnob()
  // for the slot(s) being edited -- sends all 3 Quick Knob slots together
  // (a full-state send, matching the real Suite/pedal behavior this
  // project confirmed live).
  function sendQuickKnobs(body) {
    const F = root.GP150Format;
    const data = body.slice(F.QUICK_KNOB_ENTRY_OFF, F.QUICK_KNOB_ENTRY_OFF + F.QUICK_KNOB_COUNT * F.QUICK_KNOB_ENTRY_LEN);
    return sendPatchDataChunks(PATCHDATA_MAGIC.QUICK_KNOB, data);
  }

  // `body` is a live-read body, patched with GP150Format.writeExpCtrl()
  // for the slot(s) being edited -- sends all 9 EXP/CTRL slots (all 3
  // blocks: EXP1-A, EXP1-B, EXP2) together, plus the 4 trailing reserved
  // bytes taken verbatim from `body` (never decoded, so never guessed).
  // The only PatchData write that needs more than one chunk live.
  function sendExpCtrl(body) {
    const F = root.GP150Format;
    const data = body.slice(F.EXP_CTRL_ENTRY_OFF, F.EXP_CTRL_OFF + 116);
    return sendPatchDataChunks(PATCHDATA_MAGIC.EXP_CTRL, data);
  }

  // `body` is a live-read body, patched with GP150Format.writeFsSetting()
  // for the footswitch(es) being edited -- sends all 9 footswitch bitmasks
  // together.
  function sendFsSettings(body) {
    const F = root.GP150Format;
    const data = body.slice(F.FS_SETTING_ENTRY_OFF, F.FS_SETTING_ENTRY_OFF + F.FS_SETTING_COUNT * 4);
    return sendPatchDataChunks(PATCHDATA_MAGIC.FS_SETTING, data);
  }

  // --- write path: GP150-13 non-disruptive full-preset write -- no select,
  // no activation, the pedal's active preset and front panel are never
  // touched. Taken from a capture of Valeton Suite's own "import preset
  // from file" action (patch/gp150_write_preset.py's docstring has the
  // full writeup; captures in re/gp150_captures/write_preset_2026-09-27/).
  // Same 8-byte-header/nibble-payload wire scheme as everywhere else, just
  // large enough (1136 bytes: an 8-byte write prefix + the 1128-byte body)
  // that the chunk header needs a 2-byte 7-bit-pair length/offset instead
  // of the single byte buildPatchDataChunks() above gets away with for its
  // own (much smaller) sub-structs -- do NOT reuse buildPatchDataChunks()
  // for this; it would silently truncate totalLen/offset above 127.
  //
  // `body` must be an ALREADY-VALID 1128-byte .prst (its own 0x0E-0x0F file
  // checksum intact from wherever it came from -- a real capture, a file
  // export, a live read) -- confirmed live that checksum does NOT depend
  // on the target slot, so writing existing valid content to a new slot
  // needs no recomputation. Writing freshly-edited/synthesized content
  // whose own checksum isn't already correct is NOT covered by this --
  // GP150-2's checksum algorithm itself is still unsolved in general.
  const WRITE_PRESET_PREFIX = [0x01, 0, 0x6c, 0x04, 0x01, 0x03, 0x11, 0x30];
  const WRITE_PRESET_CHECKSUM_START = 4;
  const WRITE_PRESET_CATEGORY = 0x07;
  const WRITE_PRESET_CHUNK_MAX_BYTES = 119;

  function buildWritePresetChunks(body, targetSlot0based) {
    if (body.length !== 1128) throw new Error(`expected a 1128-byte GP-150 .prst body, got ${body.length}`);
    if (!(targetSlot0based >= 0 && targetSlot0based <= 199)) throw new Error(`targetSlot0based must be 0-199, got ${targetSlot0based}`);

    const bodyBytes = Array.from(body);
    bodyBytes[4] = targetSlot0based;

    const prefix = WRITE_PRESET_PREFIX.slice();
    prefix[1] = crc8(prefix.slice(WRITE_PRESET_CHECKSUM_START, 8).concat(bodyBytes));

    const stream = prefix.concat(bodyBytes);
    const totalLen = stream.length;

    const chunks = [];
    for (let offset = 0, idx = 0; offset < totalLen; idx++) {
      const sliceLen = Math.min(WRITE_PRESET_CHUNK_MAX_BYTES, totalLen - offset);
      const slice = stream.slice(offset, offset + sliceLen);
      const header = [
        0x7f, 0,
        totalLen & 0x7f, (totalLen >> 7) & 0x7f,
        offset & 0x7f, (offset >> 7) & 0x7f,
        WRITE_PRESET_CATEGORY, idx & 0xff,
      ];
      const raw = header.concat(bytesToNibbles(slice));
      raw[1] = computeWireTag(raw) & 0xff;
      chunks.push(raw);
      offset += sliceLen;
    }
    return chunks;
  }

  // Fire-and-forget, like the rest of this write path -- no ack to wait
  // for, and none needed: confirmed live 2026-09-27 that Valeton Suite's
  // own real "import from file" sends all 10 chunks back-to-back with no
  // inter-chunk ack either (the real capture's own timestamps span ~23ms
  // for all 10), so this isn't a gap relative to the real product. The
  // caller (gp150.js's wireWritePreset()) verifies the write actually
  // took by re-reading the target slot's name afterwards, same
  // non-disruptive request readAllNames() already uses -- do that at the
  // call site, not by adding chunk-level acking here (there isn't one).
  function sendWritePreset(body, targetSlot0based) {
    assertReady();
    const chunks = buildWritePresetChunks(body, targetSlot0based);
    for (const raw of chunks) output.send([0xf0, ...raw, 0xf7]);
    return chunks;
  }

  // --- write path: GP150-9 User IR upload (LibraryStruct/IR struct family) --
  // Wire format byte-verified against a real Suite capture (an IR WAV ->
  // slot 3): reassembling that capture's 70-chunk burst and re-deriving
  // it from the source WAV with this exact code produces IDENTICAL bytes,
  // chunk for chunk, tag for tag, zero mismatches. Read-only investigation
  // only until now — this is the first code in this project that
  // constructs new upload bytes from scratch rather than replaying/
  // decoding captured ones, so treat any change here as needing the same
  // re-verification against the real capture before it ever reaches a
  // real pedal (see app/tests's gp150 suite).
  //
  // Envelope (8228 bytes total for IR): [0x01, checksum, 0x20, 0x20, 0x01,
  // 0x01, 0x40, 0x10 (subtype+family marker, IR-specific), 0x1c, 0x20
  // (=8220, a fixed struct-size constant baked into every IR struct),
  // targetSlot(u32 LE, 0-based), 0x40, 0x10, 0x1c, 0x20 (repeated), name
  // (16 bytes, null-padded ASCII), then exactly 8192 bytes of raw audio
  // data: up to IR_MAX_SAMPLES 32-bit signed LE samples (sign-extended
  // straight from the source file's own PCM, NO resampling/requantizing —
  // confirmed byte-identical against the real WAV), zero-padded/truncated
  // to fill the fixed slot. checksum = crc8(envelope.slice(4)) -- a
  // DIFFERENT checksum start offset (4) than the CHECKSUM_START=5 family
  // used by buildSetParamMessage/buildSaveMessage/buildReorderMessage
  // above; this is a separate message family with its own envelope.
  const IR_CHECKSUM_START = 4;
  const IR_DATA_REGION_BYTES = 8192;
  const IR_MAX_SAMPLES = IR_DATA_REGION_BYTES / 4; // 2048 32-bit samples
  const IR_NAME_MAX_LEN = 16;
  const IR_TYPE_MARKER = 0x1040; // IR struct's own field_7/field constant (u16 LE: 0x40, 0x10)
  const IR_STRUCT_SIZE = 0x201c; // 8220 -- IR struct's own fixed "field_f" constant (u16 LE: 0x1c, 0x20)
  const IR_ENVELOPE_LEN = 36 + IR_DATA_REGION_BYTES; // 8228

  // Build the 8228-byte decoded envelope for one User IR upload.
  // `samples` is an array of 32-bit signed integers (already sign-extended
  // from whatever the source file's own bit depth was) -- pass at most
  // IR_MAX_SAMPLES; anything beyond that a real GP-150 slot can't hold is
  // rejected rather than silently truncated further than the caller
  // already chose to.
  function buildIrUploadEnvelope(targetSlot0based, name, samples) {
    if (!(targetSlot0based >= 0 && targetSlot0based < 20)) {
      throw new Error(`targetSlot0based must be 0-19 (20 User IR slots), got ${targetSlot0based}`);
    }
    if (!/^[\x00-\x7f]*$/.test(name)) throw new Error(`name must be ASCII: ${JSON.stringify(name)}`);
    const nameBytes = Array.from(name, (c) => c.charCodeAt(0)).slice(0, IR_NAME_MAX_LEN);
    if (samples.length > IR_MAX_SAMPLES) {
      throw new Error(`too many samples (${samples.length}), a User IR slot holds at most ${IR_MAX_SAMPLES}`);
    }

    const envelope = new Array(IR_ENVELOPE_LEN).fill(0);
    envelope[0] = 0x01;
    envelope[2] = 0x20; envelope[3] = 0x20;
    envelope[4] = 0x01; envelope[5] = 0x01;
    envelope[6] = IR_TYPE_MARKER & 0xff; envelope[7] = (IR_TYPE_MARKER >> 8) & 0xff;
    envelope[8] = IR_TYPE_MARKER & 0xff; envelope[9] = (IR_TYPE_MARKER >> 8) & 0xff;
    envelope[10] = IR_STRUCT_SIZE & 0xff; envelope[11] = (IR_STRUCT_SIZE >> 8) & 0xff;
    envelope[12] = targetSlot0based & 0xff;
    envelope[13] = (targetSlot0based >>> 8) & 0xff;
    envelope[14] = (targetSlot0based >>> 16) & 0xff;
    envelope[15] = (targetSlot0based >>> 24) & 0xff;
    envelope[16] = IR_TYPE_MARKER & 0xff; envelope[17] = (IR_TYPE_MARKER >> 8) & 0xff;
    envelope[18] = IR_STRUCT_SIZE & 0xff; envelope[19] = (IR_STRUCT_SIZE >> 8) & 0xff;
    nameBytes.forEach((b, i) => { envelope[20 + i] = b; });
    samples.forEach((v, i) => {
      const off = 36 + i * 4;
      envelope[off] = v & 0xff;
      envelope[off + 1] = (v >>> 8) & 0xff;
      envelope[off + 2] = (v >>> 16) & 0xff;
      envelope[off + 3] = (v >>> 24) & 0xff;
    });
    envelope[1] = crc8(envelope.slice(IR_CHECKSUM_START));
    return envelope;
  }

  // Max decoded payload nibbles per raw chunk for this message family --
  // 238 (119 bytes), matching the real capture's 244-byte inner (6-byte
  // header + 238 payload nibbles) exactly for every full chunk.
  const IR_UPLOAD_CHUNK_PAYLOAD_NIBBLES = 238;

  // Split a 16-bit-ish counter/length field into GP-150's own MIDI-safe
  // (7-bit-per-byte) two-byte encoding -- base 128, NOT the little-endian
  // base-256 every other message family on this page uses. Found live
  // 2026-09-25 by diffing a real capture's per-chunk cumulative-byte-count
  // field against the naive base-256 decode: they only agreed while the
  // low byte stayed under 128, diverging exactly where a 7-bit MIDI data
  // byte would otherwise have to carry a value >= 0x80.
  function toBase128Pair(value) {
    return [value % 128, Math.floor(value / 128) & 0xff];
  }

  // Build every raw chunk (nibble-encoded, tag already computed) of one
  // User IR upload. Per-chunk 6-byte header: [totalBytes_lo7, totalBytes_hi
  // (base 128), cumulativeBytesSentSoFar_lo7, _hi (base 128), counter,
  // 0-based chunk index], then up to 238 payload nibbles. `counter` is a
  // per-burst sequence byte Suite itself increments across reconnects;
  // nothing here suggests the pedal actually validates it, so this
  // defaults to 1 like every other write* builder's own counter param.
  function buildIrUploadChunks(targetSlot0based, name, samples, { counter } = {}) {
    const envelope = buildIrUploadEnvelope(targetSlot0based, name, samples);
    const nibbles = bytesToNibbles(envelope);
    const [totalLo, totalHi] = toBase128Pair(envelope.length);
    const cnt = (counter ?? 1) & 0xff;
    const chunks = [];
    let cumBytes = 0;
    for (let idx = 0; cumBytes * 2 < nibbles.length; idx++) {
      const sliceLen = Math.min(IR_UPLOAD_CHUNK_PAYLOAD_NIBBLES, nibbles.length - cumBytes * 2);
      const slice = nibbles.slice(cumBytes * 2, cumBytes * 2 + sliceLen);
      const [cumLo, cumHi] = toBase128Pair(cumBytes);
      const inner = [totalLo, totalHi, cumLo, cumHi, cnt, idx & 0xff, ...slice];
      const raw = [0x7f, 0, ...inner];
      raw[1] = computeWireTag(raw) & 0x7f;
      chunks.push(raw);
      cumBytes += sliceLen / 2;
    }
    return chunks;
  }

  // Build and send a User IR upload live. Fire-and-forget like every other
  // write* function on this page -- no ack to wait for. `targetSlot0based`
  // is 0-19 (20 User IR slots total); `samples` are 32-bit signed PCM
  // values already extracted from the source file (see wav.js's
  // decodeWavPcmSamples() for the browser-side file parsing this expects
  // as input). Returns the chunk arrays actually sent (for UI display/debug).
  function sendIrUpload(targetSlot0based, name, samples) {
    assertReady();
    const chunks = buildIrUploadChunks(targetSlot0based, name, samples);
    for (const raw of chunks) output.send([0xf0, ...raw, 0xf7]);
    return chunks;
  }

  // --- write path: GP150-9 SnapTone/"Clone" upload -- uploads an ALREADY-
  // PRODUCED .clo file (starting with ASCII magic "VTSI")
  // to a chosen SnapTone library slot, non-disruptively. Building the .clo
  // itself from audio or a NAM model is amp_profiler.js's job. The wire
  // format is byte-verified against a capture of Suite importing a real
  // .clo to SnapTone library slot 51
  // (re/gp150_captures/snaptone_upload_2026-09-24/). Same
  // 119-byte-chunk/2-byte-7-bit-pair-length wire shape as GP150-13's
  // full-preset write, category 0x08, and the SAME crc8(prefix[4:8]+body)
  // content-prefix formula -- ported to Python first in
  // patch/gp150_snaptone_upload.py, see its own docstring for the full
  // field-by-field writeup. No checksum of its own to solve: the .clo
  // file's bytes are truncated to 2696 and zero-padded verbatim, the
  // struct itself is a plain positional layout.
  const CLONE_TYPE_MARKER_SNAPTONE = 0x1050;
  const CLONE_CHECKSUM_START = 4;
  const CLONE_CATEGORY = 0x08;
  const CLONE_CHUNK_MAX_BYTES = 119;
  const CLONE_STRUCT_LEN = 8220;
  const CLONE_DATA_SLOT_LEN = 8192;
  const CLONE_NAME_LEN = 16;
  const CLONE_DATA_TRUNCATE_LEN = 2696;

  // Port of patch/gp150_snaptone_upload.py's convert_clo_for_device() (Suite's
  // Suite's .clo device-format conversion): truncating a .clo
  // to 2696 bytes without rewriting its header (lengths @4/@20/@132) and CRC16
  // (@8) yields an inconsistent file that makes the real pedal emit loud
  // self-oscillating noise. Idempotent on files already in the device format.
  function cloCrc16(bytes) {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return ((crc & 0xff) << 8) | (crc >>> 8);
  }

  function convertCloForDevice(cloBytes) {
    const total = CLONE_DATA_TRUNCATE_LEN;
    const out = new Uint8Array(total);
    out.set(Array.from(cloBytes).slice(0, total), 0);
    const view = new DataView(out.buffer);
    view.setUint32(4, total, true);
    view.setUint32(20, total - 136, true);
    view.setUint32(132, Math.min(view.getUint32(132, true), 512), true);
    view.setUint32(8, cloCrc16(out.subarray(12, total)), true);
    return Array.from(out);
  }

  function buildLibraryStruct(targetSlot, name, cloBytes) {
    if (!(targetSlot >= 1 && targetSlot <= 100)) throw new Error(`targetSlot must be 1-100, got ${targetSlot}`);
    const magic = String.fromCharCode(cloBytes[0], cloBytes[1], cloBytes[2], cloBytes[3]);
    if (magic !== "VTSI") throw new Error(`cloBytes doesn't start with the expected 'VTSI' magic (got "${magic}")`);

    const data = new Array(CLONE_DATA_SLOT_LEN).fill(0);
    convertCloForDevice(cloBytes).forEach((b, i) => { data[i] = b; });

    const struct = new Array(CLONE_STRUCT_LEN).fill(0);
    struct[0] = CLONE_TYPE_MARKER_SNAPTONE & 0xff; struct[1] = (CLONE_TYPE_MARKER_SNAPTONE >> 8) & 0xff;
    struct[2] = CLONE_STRUCT_LEN & 0xff; struct[3] = (CLONE_STRUCT_LEN >> 8) & 0xff;
    struct[4] = targetSlot & 0xff; struct[5] = (targetSlot >> 8) & 0xff;
    struct[6] = 0; struct[7] = 0;
    struct[8] = struct[0]; struct[9] = struct[1]; struct[10] = struct[2]; struct[11] = struct[3];
    const nameBytes = Array.from(name).map((c) => c.charCodeAt(0)).slice(0, CLONE_NAME_LEN);
    while (nameBytes.length < CLONE_NAME_LEN) nameBytes.push(0);
    for (let i = 0; i < CLONE_NAME_LEN; i++) struct[12 + i] = nameBytes[i];
    for (let i = 0; i < CLONE_DATA_SLOT_LEN; i++) struct[28 + i] = data[i];
    return struct;
  }

  function buildCloneUploadStream(targetSlot, name, cloBytes) {
    const body = buildLibraryStruct(targetSlot, name, cloBytes);
    const prefix = [0x01, 0, 0x20, 0x20, 0x01, 0x01, CLONE_TYPE_MARKER_SNAPTONE & 0xff, (CLONE_TYPE_MARKER_SNAPTONE >> 8) & 0xff];
    prefix[1] = crc8(prefix.slice(CLONE_CHECKSUM_START, 8).concat(body));
    return prefix.concat(body);
  }

  function buildCloneUploadChunks(targetSlot, name, cloBytes) {
    const stream = buildCloneUploadStream(targetSlot, name, cloBytes);
    const totalLen = stream.length;
    const chunks = [];
    for (let offset = 0, idx = 0; offset < totalLen; idx++) {
      const sliceLen = Math.min(CLONE_CHUNK_MAX_BYTES, totalLen - offset);
      const slice = stream.slice(offset, offset + sliceLen);
      const header = [
        0x7f, 0,
        totalLen & 0x7f, (totalLen >> 7) & 0x7f,
        offset & 0x7f, (offset >> 7) & 0x7f,
        CLONE_CATEGORY, idx & 0xff,
      ];
      const raw = header.concat(bytesToNibbles(slice));
      raw[1] = computeWireTag(raw) & 0xff;
      chunks.push(raw);
      offset += sliceLen;
    }
    return chunks;
  }

  // Fire-and-forget, like every other write* function here -- no ack to
  // wait for. `targetSlot` is the LITERAL SnapTone library slot (1-100,
  // not 0-based). `cloBytes` is a complete, real .clo file's own bytes.
  function sendSnapToneUpload(targetSlot, name, cloBytes) {
    assertReady();
    const chunks = buildCloneUploadChunks(targetSlot, name, cloBytes);
    for (const raw of chunks) output.send([0xf0, ...raw, 0xf7]);
    return chunks;
  }

  // --- write path: GP150-9 NAM upload (LibraryStruct family, "NAMB" sub-format) --
  // MUCH narrower than the IR upload above, and deliberately so. IR's
  // payload is the source file's own raw PCM verbatim -- any WAV works.
  // NAM's payload ("NAMB") instead serializes an entire WaveNet
  // architecture (channel counts, per-layer kernel sizes and dilations,
  // etc.) into a binary config block ahead of the raw float32 weights,
  // and that serialization is produced by Suite's own converter, whose
  // layout this project has not documented. What IS byte-verified is the
  // config block's *shape* for exactly one real architecture: the
  // "lite" submodel (channels=3, the specific per-layer kernel_size/
  // dilation pattern baked into NAM_HEADER_TEMPLATE below) from the one
  // real captured upload (a third-party `.nam`'s
  // `SlimmableContainer`, submodels[0], 1871 weights) -- confirmed
  // exactly matching `config.layers[0].dilations`/`kernel_sizes` from
  // that file's own JSON.
  //
  // The GP-150 itself only ever runs NAM's "lite" tier (per the user's
  // own confirmation, 2026-09-25) -- there is no "full" architecture to
  // support on this pedal in the first place, so this isn't a narrower
  // feature than what's useful, just narrower than what's POSSIBLE in
  // the abstract wire format. Still: this only works for a lite model
  // whose architecture happens to match NAM_HEADER_TEMPLATE's exactly
  // (proxied by an exact 1871-weight count, see pickNamLiteModel() in
  // gp150_captures_ui.js) -- a lite model trained with different
  // channel/layer settings would need its own config block, which isn't
  // implemented. Sending a config this project doesn't understand would
  // mean guessing binary struct fields for something a real device
  // reads -- exactly what this project's own hardware-safety discipline
  // says not to do, so buildNamUploadEnvelope() refuses instead.
  //
  // The 4-byte "hash" field at header offset 24 (`ca f2 52 95` in the
  // first capture) IS a content-dependent integrity check -- confirmed
  // live: a first upload sending it copied verbatim from the first capture
  // capture was cleanly rejected by the pedal (2026-09-25). Its formula
  // (as Suite's own NAM-to-.namb conversion computes it) is a
  // textbook bit-by-bit IEEE CRC-32 (poly 0xedb88320, init/final
  // 0xffffffff) over the whole header+weights buffer (bytes 0 up to
  // NAM_TOTAL_LEN), with the hash field's own 4 bytes (offset 24-27)
  // skipped entirely from the byte stream -- not zeroed, genuinely
  // absent -- so the hash isn't self-referential. Verified byte-for-byte
  // against two independent real captures with different weights (0x9552f2ca and
  // 0x70355f5f). See BACKLOG_GP150.md's GP150-9 entry.
  //
  // Header offset 44 (8 bytes) is ALSO now solved: it's a `double`, and
  // it's the selected submodel's OWN `metadata.loudness` (NOT the .nam
  // file's top-level metadata -- a SlimmableContainer's "lite" and
  // "full" submodels each carry their own independent metadata block,
  // and Suite's own converter reads "loudness" straight out of whichever
  // json object it's handed). Verified bit-for-bit exact (not just close) for
  // both real captures: the first model's lite submodel metadata.loudness ==
  // -16.426200956131407 == this file's own header bytes at 44-51,
  // the second's == -23.07768441476771, same. An earlier pass wrongly
  // compared against the .nam file's TOP-LEVEL loudness (measured for
  // the "full" submodel, genuinely different from "lite"'s own) and
  // concluded this was some unexplained near-miss; it wasn't -- wrong
  // submodel, not a fuzzy match. `sendNamUpload()`/`buildNamUploadEnvelope()`
  // now take this as an explicit `loudness` argument (default 0) instead
  // of copying the template's baked-in value; `pickNamLiteModel()`
  // in gp150_captures_ui.js extracts it from the right submodel.
  //
  // (A later pass thought there was a THIRD mystery field at offset 48,
  // ~-2.756659 for the first -- there isn't. Offset 48 is just the upper 4
  // bytes of the SAME 8-byte loudness double at offset 44 (44-51 is one
  // field, not two); reinterpreting bytes 48-51 alone as a float32
  // reliably produces some other finite-looking number, which is what
  // got mistaken for an independent value. Confirmed by re-deriving it
  // directly from the loudness double's own bit pattern -- exact match,
  // nothing left to solve here.)
  //
  // The NAM header format is now fully solved for this one verified
  // "lite" architecture: every byte is either a fixed architecture
  // constant (verified identical across 2 real captures), the target
  // slot/name, the CRC-32 hash, the submodel's own loudness, or the
  // weights themselves. See BACKLOG_GP150.md's GP150-9 entry.
  const NAM_TYPE_MARKER = 0x1090; // NAM's own subtype marker (vs IR's/SnapTone's 0x1040/0x1050)
  const NAM_FAMILY_MARKER = 0x1050; // shared with SnapTone -- NAM is a Clone-family subtype
  const NAM_STRUCT_SIZE = 0x201c; // 8220, same fixed struct-size constant as every other type
  const NAM_WEIGHTS_COUNT = 1871;
  const NAM_WEIGHTS_OFFSET = 496; // byte offset within the data region where raw float32 weights start
  const NAM_TOTAL_LEN = NAM_WEIGHTS_OFFSET + NAM_WEIGHTS_COUNT * 4; // 7980 -- whole header+weights buffer, for this one verified architecture
  const NAM_HASH_OFFSET = 24; // data-region-relative offset of the header's own CRC-32 field (see below)

  // Standard bit-by-bit IEEE CRC-32 (poly 0xedb88320, init/final
  // 0xffffffff) over `bytes[0:len]`, treating the `skipLen` bytes at
  // `skipStart` as entirely absent from the stream (not zeroed).
  // Matches Suite's own NAM-to-.namb conversion -- see NAM_HASH_OFFSET's use below.
  function crc32SkipRange(bytes, len, skipStart, skipLen) {
    let crc = 0xffffffff;
    for (let i = 0; i < len; i++) {
      if (i >= skipStart && i < skipStart + skipLen) continue;
      let b = (bytes[i] ^ crc) & 0xff;
      for (let k = 0; k < 8; k++) b = (b & 1) ? ((b >>> 1) ^ 0xedb88320) : (b >>> 1);
      crc = ((crc >>> 8) ^ b) >>> 0;
    }
    return (~crc) >>> 0;
  }

  // Byte-for-byte from the real first NAM capture's data region,
  // offset 0-495 (re/gp150_captures/ir_snaptone_nam_upload_2026-09-24/).
  // Magic "BMAN" (="NAMB" byte-reversed, matching the real
  // `_importNAMBToDevice()` function name), a handful of length/offset/
  // count fields (all verified against this exact capture), the unknown
  // hash field noted above, then the WaveNet config as u32/u16 arrays
  // (dilations, kernel_sizes) matching that file's own JSON exactly.
  const NAM_HEADER_TEMPLATE = [
    66, 77, 65, 78, 1, 0, 0, 0, 44, 31, 0, 0, 240, 1, 0, 0, 79, 7, 0, 0,
    157, 1, 0, 0, 202, 242, 82, 149, 0, 0, 0, 0, 0, 7, 0, 1, 0, 0, 0, 0,
    0, 112, 231, 64, 187, 27, 128, 129, 27, 109, 48, 192, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    3, 0, 153, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 3, 0, 3, 0, 16, 0,
    1, 23, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0, 1, 0,
    2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0,
    2, 0, 1, 0, 2, 0, 1, 0, 1, 0, 0, 0, 3, 0, 0, 0, 7, 0, 0, 0,
    17, 0, 0, 0, 41, 0, 0, 0, 101, 0, 0, 0, 239, 0, 0, 0, 1, 0, 0, 0,
    3, 0, 0, 0, 7, 0, 0, 0, 17, 0, 0, 0, 41, 0, 0, 0, 101, 0, 0, 0,
    239, 0, 0, 0, 1, 0, 0, 0, 13, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0,
    7, 0, 0, 0, 17, 0, 0, 0, 41, 0, 0, 0, 101, 0, 0, 0, 239, 0, 0, 0,
    6, 0, 6, 0, 6, 0, 6, 0, 6, 0, 6, 0, 6, 0, 6, 0, 6, 0, 6, 0,
    6, 0, 6, 0, 6, 0, 6, 0, 15, 0, 15, 0, 6, 0, 6, 0, 6, 0, 6, 0,
    6, 0, 6, 0, 6, 0, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1,
    10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215,
    35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60,
    4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1,
    10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215,
    35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60,
    4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1, 10, 215, 35, 60, 4, 1,
    10, 215, 35, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];

  // NAM/SnapTone share ONE 101-entry catalog for READING (index 0
  // "None", 1-50 factory, 51-100 user -- see readSnaptones()'s own
  // comment above), and the wire's own targetSlot field for this struct
  // family is the LITERAL 1-based catalog index, NOT 0-based like IR's
  // own targetSlot field. But NAM uploads specifically do NOT share the
  // full 1-100 write range: confirmed live 2026-09-26 (Suite's own UI
  // shows exactly 20 NAM slots, user-confirmed) after live hardware
  // tests to slots 76 and 100 were both silently rejected post-hash-fix
  // -- every real NAM capture this project has ever seen targeted
  // literal slot 1, never anything higher, which now makes sense: NAM's
  // own writable range is 1-20, a narrower sub-range of the shared
  // catalog, not the full 1-100 (that wider range is real for SnapTone/
  // SnapTone profile uploads specifically, confirmed via real captures at
  // literal 51 and 97 -- a DIFFERENT upload path this project hasn't
  // implemented, don't conflate the two ranges again).
  const NAM_SLOT_MIN = 1;
  const NAM_SLOT_MAX = 20;

  const NAM_LOUDNESS_OFFSET = 44; // data-region-relative offset of the selected submodel's own metadata.loudness (float64 LE)

  // Build the 8228-byte decoded envelope for one NAM upload. `targetSlot`
  // is the LITERAL 1-100 catalog slot (see above -- NOT 0-based, unlike
  // buildIrUploadEnvelope()'s targetSlot0based). `weights` MUST be
  // exactly NAM_WEIGHTS_COUNT floats (see the class comment above) --
  // this is a template substitution, not a general encoder, and refuses
  // anything that doesn't match the one verified architecture rather than
  // guess. `loudness` is the SAME submodel's own metadata.loudness (see
  // pickNamLiteModel() in gp150_captures_ui.js) -- defaults to 0 if the
  // source file's submodel has none.
  function buildNamUploadEnvelope(targetSlot, name, weights, loudness = 0) {
    if (!(targetSlot >= NAM_SLOT_MIN && targetSlot <= NAM_SLOT_MAX)) {
      throw new Error(`targetSlot must be ${NAM_SLOT_MIN}-${NAM_SLOT_MAX} (NAM's own narrower range within the shared SnapTone catalog), got ${targetSlot}`);
    }
    if (!/^[\x00-\x7f]*$/.test(name)) throw new Error(`name must be ASCII: ${JSON.stringify(name)}`);
    if (weights.length !== NAM_WEIGHTS_COUNT) {
      throw new Error(
        `this project only supports the one NAM "lite" WaveNet architecture it has verified `
        + `(${NAM_WEIGHTS_COUNT} weights) -- got ${weights.length}. See BACKLOG_GP150.md's GP150-9 entry.`
      );
    }
    const nameBytes = Array.from(name, (c) => c.charCodeAt(0)).slice(0, IR_NAME_MAX_LEN);

    const envelope = new Array(IR_ENVELOPE_LEN).fill(0);
    envelope[0] = 0x01;
    envelope[2] = 0x20; envelope[3] = 0x20;
    envelope[4] = 0x01; envelope[5] = 0x01;
    envelope[6] = NAM_TYPE_MARKER & 0xff; envelope[7] = (NAM_TYPE_MARKER >> 8) & 0xff;
    envelope[8] = NAM_FAMILY_MARKER & 0xff; envelope[9] = (NAM_FAMILY_MARKER >> 8) & 0xff;
    envelope[10] = NAM_STRUCT_SIZE & 0xff; envelope[11] = (NAM_STRUCT_SIZE >> 8) & 0xff;
    envelope[12] = targetSlot & 0xff;
    envelope[13] = (targetSlot >>> 8) & 0xff;
    envelope[14] = (targetSlot >>> 16) & 0xff;
    envelope[15] = (targetSlot >>> 24) & 0xff;
    envelope[16] = NAM_FAMILY_MARKER & 0xff; envelope[17] = (NAM_FAMILY_MARKER >> 8) & 0xff;
    envelope[18] = NAM_STRUCT_SIZE & 0xff; envelope[19] = (NAM_STRUCT_SIZE >> 8) & 0xff;
    nameBytes.forEach((b, i) => { envelope[20 + i] = b; });

    NAM_HEADER_TEMPLATE.forEach((b, i) => { envelope[36 + i] = b; });
    weights.forEach((w, i) => {
      const bytes = float32LEBytes(w);
      const off = 36 + NAM_WEIGHTS_OFFSET + i * 4;
      envelope[off] = bytes[0]; envelope[off + 1] = bytes[1]; envelope[off + 2] = bytes[2]; envelope[off + 3] = bytes[3];
    });
    const loudnessBytes = float64LEBytes(loudness);
    const loudnessOff = 36 + NAM_LOUDNESS_OFFSET;
    loudnessBytes.forEach((b, i) => { envelope[loudnessOff + i] = b; });
    const hash = crc32SkipRange(envelope.slice(36, 36 + NAM_TOTAL_LEN), NAM_TOTAL_LEN, NAM_HASH_OFFSET, 4);
    const hashOff = 36 + NAM_HASH_OFFSET;
    envelope[hashOff] = hash & 0xff;
    envelope[hashOff + 1] = (hash >>> 8) & 0xff;
    envelope[hashOff + 2] = (hash >>> 16) & 0xff;
    envelope[hashOff + 3] = (hash >>> 24) & 0xff;
    envelope[1] = crc8(envelope.slice(IR_CHECKSUM_START));
    return envelope;
  }

  // Same chunking as buildIrUploadChunks() -- identical per-chunk header
  // shape and 238-nibble slicing, just over a NAM envelope instead of an
  // IR one.
  function buildNamUploadChunks(targetSlot, name, weights, loudness = 0, { counter } = {}) {
    const envelope = buildNamUploadEnvelope(targetSlot, name, weights, loudness);
    const nibbles = bytesToNibbles(envelope);
    const [totalLo, totalHi] = toBase128Pair(envelope.length);
    const cnt = (counter ?? 1) & 0xff;
    const chunks = [];
    let cumBytes = 0;
    for (let idx = 0; cumBytes * 2 < nibbles.length; idx++) {
      const sliceLen = Math.min(IR_UPLOAD_CHUNK_PAYLOAD_NIBBLES, nibbles.length - cumBytes * 2);
      const slice = nibbles.slice(cumBytes * 2, cumBytes * 2 + sliceLen);
      const [cumLo, cumHi] = toBase128Pair(cumBytes);
      const inner = [totalLo, totalHi, cumLo, cumHi, cnt, idx & 0xff, ...slice];
      const raw = [0x7f, 0, ...inner];
      raw[1] = computeWireTag(raw) & 0x7f;
      chunks.push(raw);
      cumBytes += sliceLen / 2;
    }
    return chunks;
  }

  // Build and send a NAM upload live. Same fire-and-forget convention as
  // every other write* function on this page.
  function sendNamUpload(targetSlot, name, weights, loudness = 0) {
    assertReady();
    const chunks = buildNamUploadChunks(targetSlot, name, weights, loudness);
    for (const raw of chunks) output.send([0xf0, ...raw, 0xf7]);
    return chunks;
  }

  const findPort = (map) => [...map.values()].find((p) => (p.name || "").includes("GP-150")) || null;

  // --- connection state --------------------------------------------------
  let access = null, input = null, output = null;

  function assertReady() {
    if (!input || !output) throw new Error("not connected — call WebMidiGP150.connect() first");
  }

  // One-time session warm-up: live-observed 2026-09-18 that the very FIRST
  // WebMIDI exchange after a fresh connect() can get no reply at all —
  // "no reply — is the pedal on this port, and is CC0+PC select working?"
  // — even though the identical byte sequence works perfectly moments
  // later. Confirmed it's not a protocol/wiring bug: a hand-sent request in
  // DevTools, in the SAME page and SAME connect() session, immediately
  // unblocked that page's own subsequent reads — no reload needed. Looks
  // like the underlying MIDI session needs one successful round trip
  // before the device reliably replies to anyone. Send a harmless 'info'
  // request here (no CC0/PC — nothing on the pedal's own display changes)
  // so the user's first real click is never actually the session's first
  // exchange. Best-effort: connect() still succeeds even if this times out.
  //
  // GP150-11 (2026-09-24): a capture of Valeton Suite's own startup
  // showed it waits ~4 SECONDS between its MIDI
  // connection completing and its first real request — a probe sent at
  // t≈2.8s gets no reply at all, then Suite just goes quiet and commits
  // to its first REAL request once, at t≈6.8s, which succeeds. It never
  // retries the probe itself.
  //
  // A first attempt here (since reverted) instead retried the probe every
  // 700ms across the wait -- broke things worse: reads started failing
  // EVERY time after the first, not just intermittently. Most likely
  // explanation, matching this project's own hardware-safety principle
  // (never fire requests in a tight loop): the pedal looks like a
  // simple single-pending-request state machine, and several probes
  // in flight at once (all eventually answered once it wakes up) left
  // it confused about which request was "current" for good. Reverted to
  // matching Suite's own actual strategy instead of a smarter-looking
  // guess: send the probe ONCE, then just wait, patiently, for either a
  // reply or a generous timeout -- no repeats.
  const PRIME_WINDOW_MS = 6000; // >= the ~4-7s Suite itself was observed taking
  function primeSession() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; input.onmidimessage = null; resolve(); };
      const t = setTimeout(finish, PRIME_WINDOW_MS);
      input.onmidimessage = () => { clearTimeout(t); finish(); };
      try { output.send([0xf0, ...INFO_REQUEST_BYTES, 0xf7]); }
      catch { clearTimeout(t); finish(); }
    });
  }

  async function connect() {
    if (!navigator.requestMIDIAccess) throw new Error("this browser has no WebMIDI (use Chrome or Edge)");
    access = await navigator.requestMIDIAccess({ sysex: true });
    input = findPort(access.inputs);
    output = findPort(access.outputs);
    if (!input || !output) throw new Error("no GP-150 MIDI port found — connect it over USB (Valeton Suite can be closed)");
    await primeSession();
    return { name: "GP-150", port: input.name };
  }

  const isConnected = () => !!(input && output);

  // Select `slot` (CC0+PC), settle, send the wake/fetch request, and listen
  // for the chunked SysEx reply — returns a raw 1128-byte .prst body
  // (Uint8Array). Mirrors patch/gp150_wake_select_read.py's main() flow.
  // GP150-11 (2026-09-24): a live read of slot 190 kept failing roughly
  // half the time (worst on the first read of a session) even after two
  // fix attempts (a mid-window resend, a tunable settle delay) that
  // didn't move the needle. Rather than guess a third constant blind,
  // readSlot() now logs each incoming message + the outcome to the
  // console (harmless -- console.debug, no UI impact) so a failure can
  // actually be diagnosed from real data (which categories/chunk indices
  // showed up, in what order, how long after the wake request) instead
  // of guessed at. Filter DevTools console for "[gp150 readSlot]".
  function readSlot(slot, opts) {
    assertReady();
    const settleMs = (opts && opts.settleMs) || DEFAULT_SETTLE_MS;
    const [bank, pc] = bankAndPc(slot);
    const log = (...args) => console.debug("[gp150 readSlot]", `slot=${slot + 1}`, ...args);
    const prevHandler = input.onmidimessage; // restored on finish, not nulled -- coexists with startLiveSync()'s persistent listener

    return new Promise((resolve, reject) => {
      const byCategory = new Map();
      let done = false;
      const t0 = performance.now();
      const finish = (fn) => {
        if (done) return;
        done = true;
        input.onmidimessage = prevHandler;
        fn();
      };

      // Try every category's messages so far; resolve the instant a burst
      // decodes AND its own embedded slot index matches `slot` (see
      // findMatchingBody — filtering by slot, not just "decodes cleanly",
      // is what stops a stale re-broadcast of a PREVIOUS read from being
      // accepted as this one). No need to wait for the stream to go quiet:
      // a full 10-chunk burst decodes successfully the moment its last
      // chunk arrives, so the common case returns essentially immediately,
      // while a genuinely late burst (the slot-9 timing race this replaced)
      // still gets picked up as soon as it finishes, bounded only by
      // READ_TIMEOUT_MS below.
      const tryDecode = () => {
        const { body, seenSlots } = findMatchingBody(byCategory, slot);
        if (body) {
          log(`OK after ${(performance.now() - t0).toFixed(0)}ms`);
          finish(() => resolve(new Uint8Array(body)));
          return true;
        }
        return false;
      };

      const handler = (e) => {
        if (done) return;
        const d = Array.from(e.data);
        if (d[0] === 0xf0 && d[d.length - 1] === 0xf7) {
          const inner = d.slice(1, -1);
          if (inner.length > CHUNK_HEADER_LEN) {
            const cat = inner[CHUNK_CATEGORY_IDX];
            const idx = inner[CHUNK_INDEX_IDX];
            log(`+${(performance.now() - t0).toFixed(0)}ms chunk cat=${cat} idx=${idx} len=${inner.length}`);
            if (!byCategory.has(cat)) byCategory.set(cat, []);
            byCategory.get(cat).push(inner);
            tryDecode();
          } else {
            log(`+${(performance.now() - t0).toFixed(0)}ms runt len=${inner.length}`);
          }
        }
      };
      input.onmidimessage = handler;

      // GP150-11 (2026-09-24): this used to resend the wake/fetch request
      // once at the halfway point if nothing had matched yet (mirroring
      // readCatalog()'s own analogous safeguard). Reverted: a live test
      // showed reads starting to fail EVERY time after the first once
      // this (plus primeSession()'s own now-reverted retry loop) were
      // both in place -- see primeSession()'s comment for the likely
      // explanation (the pedal appears to be a simple single-pending-
      // request state machine, confused by more than one in flight at
      // once). A capture of Suite's own read timing showed it never
      // resends either -- it just waits, patiently, for
      // one request to resolve. Match that instead of a second send here.
      const timeoutTick = () => {
        if (done) return;
        const elapsed = performance.now() - t0;
        if (elapsed > READ_TIMEOUT_MS) {
          return finish(() => {
            if (!byCategory.size) return reject(new Error("no reply — is the pedal on this port, and is CC0+PC select working?"));
            const { body, seenSlots } = findMatchingBody(byCategory, slot);
            if (body) return resolve(new Uint8Array(body));
            if (seenSlots.size) {
              const seenList = [...seenSlots].map((s) => s + 1).join(", ");
              return reject(new Error(
                `timed out waiting for slot ${slot + 1} — only saw data for slot(s) ${seenList} ` +
                `(the pedal may still be re-sending an earlier read; try again)`
              ));
            }
            reject(new Error("got replies but none reassembled cleanly (no complete burst for any slot)"));
          });
        }
        setTimeout(timeoutTick, 25);
      };
      timeoutTick();

      try {
        output.send([0xb0, 0x00, bank]);
        setTimeout(() => {
          try {
            output.send([0xc0, pc]);
            setTimeout(() => {
              if (done) return;
              output.send([0xf0, ...WAKE_REQUEST_BYTES, 0xf7]);
            }, settleMs);
          } catch (err) { finish(() => reject(err)); }
        }, 50);
      } catch (err) { finish(() => reject(err)); }
    });
  }

  // GP150-11 (2026-09-24): fetch whatever preset is CURRENTLY active on
  // the pedal, with NO CC0/PC slot-select at all -- exactly matching what
  // Suite itself does at its own startup (a capture confirmed
  // Suite's own real fetch-trigger message is byte-identical to this
  // project's own WAKE_REQUEST_BYTES, both carrying the same 0xFFFF
  // "whatever's active" sentinel, and Suite never sends CC0/PC to get
  // it). Isolates whether CC0+PC itself is part of readSlot()'s
  // flakiness, per the user's own suggestion to replicate Suite's
  // startup path before tackling the harder "switch slot" one. Accepts
  // the first cleanly-reassembled burst from ANY category, since there's
  // no specific slot being requested to match against.
  function readActivePreset(requestBytes = WAKE_REQUEST_BYTES, accept = null, opts = null) {
    assertReady();
    const log = (...args) => console.debug("[gp150 readActivePreset]", ...args);
    const prevHandler = input.onmidimessage; // restored on finish -- coexists with startLiveSync()'s persistent listener

    return new Promise((resolve, reject) => {
      const byCategory = new Map();
      let done = false;
      const t0 = performance.now();
      const finish = (fn) => {
        if (done) return;
        done = true;
        input.onmidimessage = prevHandler;
        fn();
      };

      const tryDecode = () => {
        for (const [cat, msgs] of byCategory) {
          for (const burst of splitBursts(msgs)) {
            try {
              const body = reassembleBody(burst);
              if (accept && !accept(body)) { log(`ignoring a body for slot ${body[PATCH_INDEX_OFF] + 1}`); continue; }
              log(`OK after ${(performance.now() - t0).toFixed(0)}ms, slot=${body[PATCH_INDEX_OFF] + 1}`);
              if (opts && opts.ack) { try { output.send([0xf0, ...buildAckMessage(cat), 0xf7]); } catch { /* the read itself succeeded */ } }
              finish(() => resolve(new Uint8Array(body)));
              return true;
            } catch (e) { /* not a clean/complete burst yet -- keep listening */ }
          }
        }
        return false;
      };

      const handler = (e) => {
        if (done) return;
        const d = Array.from(e.data);
        if (d[0] === 0xf0 && d[d.length - 1] === 0xf7) {
          const inner = d.slice(1, -1);
          if (inner.length > CHUNK_HEADER_LEN) {
            const cat = inner[CHUNK_CATEGORY_IDX];
            const idx = inner[CHUNK_INDEX_IDX];
            log(`+${(performance.now() - t0).toFixed(0)}ms chunk cat=${cat} idx=${idx} len=${inner.length}`);
            if (!byCategory.has(cat)) byCategory.set(cat, []);
            byCategory.get(cat).push(inner);
            tryDecode();
          } else {
            log(`+${(performance.now() - t0).toFixed(0)}ms runt len=${inner.length}`);
          }
        }
      };
      input.onmidimessage = handler;

      const t = setTimeout(() => {
        finish(() => reject(new Error(byCategory.size
          ? "got replies but none reassembled cleanly"
          : "no reply — is the pedal on this port?")));
      }, READ_TIMEOUT_MS);

      try { output.send([0xf0, ...requestBytes, 0xf7]); }
      catch (err) { clearTimeout(t); finish(() => reject(err)); }
    });
  }

  // GP150-11 (2026-09-24): select a specific preset by index, with NO
  // CC0/PC at all -- the same mechanism a capture showed
  // Suite itself uses when the user opens a different preset in its own
  // browser (byte-for-byte confirmed against 2 real captures: this exact
  // template with flag=0x01/index=0xFFFF IS WAKE_REQUEST_BYTES itself,
  // Suite's own "whatever's active" fetch; flag=0x00/index=189 was
  // captured live when the user opened UI preset "190" -- 1-based UI to
  // 0-based wire, this project's usual convention). Checksum for this
  // message family starts at payload[4] (not the usual CHECKSUM_START=5
  // GP150-6's own messages use) -- confirmed unambiguous against both
  // real samples.
  //
  // IMPORTANT (the user's own correction, 2026-09-24): this is a
  // Program-Change equivalent, NOT a safe read-only query -- Suite has
  // no offline-edit concept, so selecting a preset LOADS it live on the
  // pedal immediately (unsaved edits lost, exactly like sendSave()'s own
  // docs already warn for any slot change). Same real-world risk
  // category as bankAndPc()'s CC0+PC, just a different wire mechanism --
  // never treat a reply to this message as the preset's own data; always
  // follow it with readActivePreset() to actually fetch what became
  // active.
  const SELECT_PRESET_CHECKSUM_START = 4;
  function buildSelectPresetMessage(slot, counter, flag = 0x00) {
    if (!(slot >= 0 && slot <= 199)) throw new Error(`slot must be 0-199, got ${slot}`);
    const payload = [0x01, 0, 0x0b, 0x00, 0x03, 0x03, 0x11, 0x30, 0x11, 0x30, 0x02, 0x00, slot & 0xff, (slot >> 8) & 0xff, flag];
    payload[1] = crc8(payload.slice(SELECT_PRESET_CHECKSUM_START));
    const header = [0x7f, 0, payload.length, 0, 0, 0, (counter ?? 1) & 0xff, 0];
    const raw = header.concat(bytesToNibbles(payload));
    raw[1] = computeWireTag(raw) & 0xff;
    return raw;
  }

  // Suite's acknowledgement of a completed reply: `7f TAG 00 00 00 00 CATEGORY 00`, CATEGORY
  // = header byte 6 of the reply's chunks, TAG = the usual wire tag.
  function buildAckMessage(category) {
    const raw = [0x7f, 0, 0, 0, 0, 0, category & 0xff, 0];
    raw[1] = computeWireTag(raw) & 0xff;
    return raw;
  }

  // Read one preset's body by index WITHOUT selecting it: the same template with
  // flag=0x01 (flag=0x01/index=0xFFFF is the "whatever's active" request above).
  // Live-confirmed 2026-10-01: the pedal answers with the body of the requested slot
  // (body byte 4 = slot) and the active preset / front panel stay untouched.
  //
  // Without an acknowledgement the pedal keeps re-sending the reply for ~3 s and does not
  // serve the next request meanwhile (~3 s per preset). Suite acknowledges every completed
  // reply with an 8-byte message echoing the reply's category byte (18/18 real captures);
  // sending the same makes the next read answer in tens of milliseconds.
  async function readPresetByIndex(slot) {
    // the pedal re-broadcasts earlier bodies spontaneously: only accept the one asked for
    return readActivePreset(buildSelectPresetMessage(slot, 1, 0x01), (b) => b[PATCH_INDEX_OFF] === slot, { ack: true });
  }

  // Fire-and-forget, like the rest of this project's write path -- no ack
  // to wait for. Follow with readActivePreset() (after a short settle,
  // the same discipline every other write here already uses) to fetch
  // the newly-active preset's actual data.
  function selectPreset(slot) {
    assertReady();
    const message = buildSelectPresetMessage(slot);
    output.send([0xf0, ...message, 0xf7]);
    return message;
  }

  // GP150-11 (2026-09-24): the real readSlot() replacement candidate --
  // selectPreset() instead of CC0+PC, otherwise identical matching logic
  // to readSlot() (findMatchingBody() against the REQUESTED slot, not
  // "accept the first thing that decodes"). Needed because a live test
  // caught the exact stale-burst race readSlot()'s own docstring already
  // describes (finding 3): the pedal correctly loaded the requested slot
  // on its own display, but the first burst to arrive afterward was a
  // leftover from BEFORE the switch, reporting the wrong slot. Plain
  // readActivePreset() has no way to detect that (it doesn't know what
  // slot to expect); this does, by reusing the SAME embedded-slot check
  // rather than accepting anything that merely decodes.
  function readSlotViaSelect(slot, opts) {
    assertReady();
    const settleMs = (opts && opts.settleMs) || DEFAULT_SETTLE_MS;
    const log = (...args) => console.debug("[gp150 readSlotViaSelect]", `slot=${slot + 1}`, ...args);
    const prevHandler = input.onmidimessage; // restored on finish -- coexists with startLiveSync()'s persistent listener

    return new Promise((resolve, reject) => {
      const byCategory = new Map();
      let done = false;
      const t0 = performance.now();
      const finish = (fn) => {
        if (done) return;
        done = true;
        input.onmidimessage = prevHandler;
        fn();
      };

      // If a full, clean burst arrives but it's for the WRONG slot (the
      // pedal hadn't finished switching yet, and the wake caught its old
      // state), resend the wake request once for each new distinct stale
      // result seen -- safe because it only fires AFTER a complete reply
      // has already come back (never overlapping an in-flight request,
      // unlike the earlier blind-timer retry loop that made things worse
      // -- see this function's own history above), and bounded to
      // MAX_STALE_RESENDS so it can't turn into an unbounded loop.
      const MAX_STALE_RESENDS = 3;
      let staleResends = 0;
      let lastStaleSignature = null;

      const tryDecode = () => {
        const { body, seenSlots } = findMatchingBody(byCategory, slot);
        if (body) {
          log(`OK after ${(performance.now() - t0).toFixed(0)}ms`);
          finish(() => resolve(new Uint8Array(body)));
          return true;
        }
        if (seenSlots.size) {
          const sig = [...seenSlots].sort((a, b) => a - b).join(",");
          if (sig !== lastStaleSignature && staleResends < MAX_STALE_RESENDS) {
            lastStaleSignature = sig;
            staleResends++;
            log(`stale data for slot(s) ${[...seenSlots].map((s) => s + 1).join(",")} -- resending wake (${staleResends}/${MAX_STALE_RESENDS})`);
            try { output.send([0xf0, ...WAKE_REQUEST_BYTES, 0xf7]); } catch (err) { /* timeout below will report it */ }
          }
        }
        return false;
      };

      const handler = (e) => {
        if (done) return;
        const d = Array.from(e.data);
        if (d[0] === 0xf0 && d[d.length - 1] === 0xf7) {
          const inner = d.slice(1, -1);
          if (inner.length > CHUNK_HEADER_LEN) {
            const cat = inner[CHUNK_CATEGORY_IDX];
            const idx = inner[CHUNK_INDEX_IDX];
            log(`+${(performance.now() - t0).toFixed(0)}ms chunk cat=${cat} idx=${idx} len=${inner.length}`);
            if (!byCategory.has(cat)) byCategory.set(cat, []);
            byCategory.get(cat).push(inner);
            tryDecode();
          } else {
            log(`+${(performance.now() - t0).toFixed(0)}ms runt len=${inner.length}`);
          }
        }
      };
      input.onmidimessage = handler;

      const timeoutTick = () => {
        if (done) return;
        if (performance.now() - t0 > READ_TIMEOUT_MS) {
          return finish(() => {
            if (!byCategory.size) return reject(new Error("no reply — is the pedal on this port?"));
            const { body, seenSlots } = findMatchingBody(byCategory, slot);
            if (body) return resolve(new Uint8Array(body));
            if (seenSlots.size) {
              const seenList = [...seenSlots].map((s) => s + 1).join(", ");
              return reject(new Error(
                `timed out waiting for slot ${slot + 1} — only saw data for slot(s) ${seenList} ` +
                `(the pedal may still be re-sending an earlier read; try again)`
              ));
            }
            reject(new Error("got replies but none reassembled cleanly (no complete burst for any slot)"));
          });
        }
        setTimeout(timeoutTick, 25);
      };
      timeoutTick();

      try {
        selectPreset(slot);
        setTimeout(() => {
          if (done) return;
          output.send([0xf0, ...WAKE_REQUEST_BYTES, 0xf7]);
        }, settleMs);
      } catch (err) { finish(() => reject(err)); }
    });
  }

  // GP150-11 (2026-09-24): live sync with the pedal's own state, with NO
  // polling at all -- confirmed live via two diagnostic tools (since
  // removed) that the pedal continuously, spontaneously re-broadcasts
  // its full active-preset body every ~1.5-4s while awake (the "device
  // keeps periodically re-broadcasting on its own" behavior already
  // known from readSlot()'s own history), and that this broadcast
  // reflects a preset switched DIRECTLY ON THE PEDAL, live-confirmed by
  // the user. This is exactly how Suite itself stays in sync without any
  // explicit request loop -- so this project's own UI can do the same:
  // just decode each periodic burst (splitBursts()/reassembleBody(), the
  // same machinery readActivePreset() uses for one read) and call
  // `onUpdate(body)` whenever the content actually changes (a full
  // byte-for-byte comparison, not just the slot index -- catches a live
  // parameter edit on the pedal too, not only a preset switch).
  //
  // Persistent for the whole connected session (installed once at
  // connect() time) -- coexists with one-off explicit reads because
  // readSlot()/readActivePreset()/readSlotViaSelect()/readCatalog() all
  // restore whatever handler was active before them (this one) instead
  // of nulling it out.
  function startLiveSync(onUpdate) {
    assertReady();
    let lastBodyKey = null;
    const byCategory = new Map();
    const handler = (e) => {
      const d = Array.from(e.data);
      if (d[0] !== 0xf0 || d[d.length - 1] !== 0xf7) return;
      const inner = d.slice(1, -1);
      if (inner.length <= CHUNK_HEADER_LEN) return;
      const cat = inner[CHUNK_CATEGORY_IDX];
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      const msgs = byCategory.get(cat);
      msgs.push(inner);
      if (msgs.length > 40) msgs.splice(0, msgs.length - 40); // bounded -- this listener runs indefinitely
      for (const burst of splitBursts(msgs)) {
        try {
          const body = reassembleBody(burst);
          const key = String.fromCharCode(...body); // cheap whole-body equality check
          if (key !== lastBodyKey) {
            lastBodyKey = key;
            onUpdate(new Uint8Array(body));
          }
        } catch (err) { /* not a complete/clean burst yet -- ignore */ }
      }
    };
    input.onmidimessage = handler;
    return () => { if (input && input.onmidimessage === handler) input.onmidimessage = null; };
  }

  // Shared implementation behind readAllNames()/readUserIrs()/
  // readSnaptones(): send 'info', settle, send `requestBytes`, resolve
  // with decodeIndexedRecords() of the first reply whose reassembled
  // length matches `expectedLen` (findMatchingStream — the stream-length
  // analog of readSlot()'s embedded-slot-index check, guarding against a
  // stray re-broadcast of an unrelated earlier readSlot() body getting
  // mistaken for this reply). No CC0/PC select involved for any of these
  // — 'info' first is required (a bare request alone gets only an ack and
  // no reply — confirmed live 2026-09-03, see gp150_read_catalog.py's
  // docstring).
  //
  // Resends the info+request pair once, at the halfway point of
  // READ_TIMEOUT_MS, if nothing has matched yet. Found live 2026-09-03:
  // firing readUserIrs() right after readSnaptones() resolved timed out
  // seeing only stray SnapTone-length bursts — the device can keep
  // re-sending the PREVIOUS catalog reply for a while after we've already
  // moved on, apparently crowding out the new request/reply entirely
  // rather than just being correctly ignored alongside it. The mid-window
  // resend gives a second, later-timed shot once that noise has likely
  // quieted down, without the caller needing its own retry loop.
  function readCatalog(requestBytes, expectedLen, opts) {
    assertReady();
    const settleMs = (opts && opts.settleMs) || DEFAULT_SETTLE_MS;
    const prevHandler = input.onmidimessage; // restored on finish -- coexists with startLiveSync()'s persistent listener

    return new Promise((resolve, reject) => {
      const byCategory = new Map();
      let done = false;
      const finish = (fn) => {
        if (done) return;
        done = true;
        input.onmidimessage = prevHandler;
        if (settleTimer != null) clearTimeout(settleTimer);
        fn();
      };

      // Found live 2026-09-26 wiring up readNamModels(): resolving the
      // INSTANT any length-matching burst completes is too eager when two
      // different catalogs share a reply length (NAM and SnapTones both
      // 2032 bytes) -- a stale/re-broadcast burst from an earlier read can
      // finish reassembling before our own fresh reply's chunks have even
      // all arrived, so "first complete match" silently picks the wrong
      // one. Once any match appears, wait a short settle window for
      // whatever's still in flight to finish too, then commit to
      // findMatchingStream's own freshest-wins result (see its comment)
      // instead of resolving immediately.
      let settleTimer = null;
      const tryDecode = () => {
        const { stream } = findMatchingStream(byCategory, expectedLen);
        if (stream && settleTimer == null) {
          settleTimer = setTimeout(() => {
            const { stream: settled } = findMatchingStream(byCategory, expectedLen);
            // Like Suite, acknowledge every completed reply: unacknowledged, the pedal keeps re-sending it
            // for ~3 s, and a read started meanwhile (e.g. right after an upload) gets that stale copy.
            ackCompleted(byCategory, acked);
            finish(() => resolve(decodeIndexedRecords(settled)));
          }, MATCH_SETTLE_MS);
        }
        return stream != null;
      };

      const handler = (e) => {
        if (done) return;
        const d = Array.from(e.data);
        if (d[0] === 0xf0 && d[d.length - 1] === 0xf7) {
          const inner = d.slice(1, -1);
          if (inner.length > CHUNK_HEADER_LEN) {
            const cat = inner[CHUNK_CATEGORY_IDX];
            if (!byCategory.has(cat)) byCategory.set(cat, []);
            byCategory.get(cat).push(inner);
            tryDecode();
          }
        }
      };
      input.onmidimessage = handler;

      // Suite's order: request -> reply -> acknowledgement -> next request. The 'info' request that must
      // precede every catalog request gets its reply acknowledged (as is any stale reply still being
      // re-broadcast) before the catalog request goes out; an unanswered 'info' falls back to a plain settle.
      const acked = new Set();
      const send = () => {
        output.send([0xf0, ...INFO_REQUEST_BYTES, 0xf7]);
        const t1 = performance.now();
        const afterInfo = () => {
          if (done) return;
          const waited = performance.now() - t1;
          if (waited < INFO_REPLY_WAIT_MS && ackCompleted(byCategory, acked) === 0) { setTimeout(afterInfo, 25); return; }
          setTimeout(() => {
            if (done) return;
            try { output.send([0xf0, ...requestBytes, 0xf7]); }
            catch (err) { finish(() => reject(err)); }
          }, settleMs);
        };
        setTimeout(afterInfo, 25);
      };

      const t0 = performance.now();
      let retried = false;
      const timeoutTick = () => {
        if (done) return;
        const elapsed = performance.now() - t0;
        if (!retried && elapsed > READ_TIMEOUT_MS / 2) {
          retried = true;
          try { send(); } catch (err) { /* final timeout below will report it */ }
        }
        if (elapsed > READ_TIMEOUT_MS) {
          return finish(() => {
            if (!byCategory.size) return reject(new Error("no reply — is the pedal connected, and is Suite closed?"));
            const { stream, seenLens } = findMatchingStream(byCategory, expectedLen);
            if (stream) return resolve(decodeIndexedRecords(stream));
            const seenList = [...seenLens].join(", ") || "none";
            reject(new Error(`timed out waiting for a ${expectedLen}-byte reply — only saw length(s) ${seenList}`));
          });
        }
        setTimeout(timeoutTick, 25);
      };
      timeoutTick();

      try {
        send();
      } catch (err) { finish(() => reject(err)); }
    });
  }

  // Fetch all 200 patch names in ONE request — much faster than readSlot()
  // in a loop (patch/gp150_read_catalog.py names). Confirmed live
  // 2026-09-03, including this JS port, via /gp150's "List all names"
  // button. Returns `[{index, name}, ...]` in stream order (index
  // 0-based, 0..199).
  const readAllNames = (opts) => readCatalog(NAMES_REQUEST_BYTES, ALL_NAMES_REPLY_LEN, opts);

  // Fetch the 20-entry User IR list in one request (patch/
  // gp150_read_catalog.py user_irs). Confirmed live 2026-09-03 in Python;
  // this JS port not yet run live. Returns `[{index, name}, ...]` —
  // indices carry a category tag in the high bits (`0x10000+n`), not
  // plain 0-based, matching the Python decoder.
  const readUserIrs = (opts) => readCatalog(USER_IRS_REQUEST_BYTES, USER_IRS_REPLY_LEN, opts);

  // Fetch the 101-entry SnapTone catalog in one request (patch/
  // gp150_read_catalog.py snaptones). Confirmed live 2026-09-03 in
  // Python; this JS port not yet run live. Returns `[{index, name}, ...]`
  // — index 0 "None", 1-50 the real factory library, then 50 empty user
  // slots at a different index base (`0x10033+n`), matching the Python
  // decoder.
  const readSnaptones = (opts) => readCatalog(SNAPTONES_REQUEST_BYTES, SNAPTONES_REPLY_LEN, opts);

  // Fetch the NAM catalog in one request -- a 7th category this project
  // didn't know existed until 2026-09-26 (see NAM_REQUEST_BYTES above).
  // Confirmed live the same day. Returns `[{index, name}, ...]`; only
  // indices 1-20 are real NAM slots (literal 1-based, matching
  // sendNamUpload()'s own targetSlot convention) -- indices beyond 20
  // read back as unused "Empty" placeholders from the shared 101-entry
  // struct shape and should be ignored by callers.
  const readNamModels = (opts) => readCatalog(NAM_REQUEST_BYTES, NAM_CATALOG_REPLY_LEN, opts);

  root.WebMidiGP150 = {
    connect,
    disconnect: () => { input = output = access = null; },
    isConnected,
    readSlot,
    readActivePreset,
    selectPreset,
    readPresetByIndex,
    buildAckMessage,
    readSlotViaSelect,
    startLiveSync,
    readAllNames,
    readUserIrs,
    readSnaptones,
    readNamModels,
    // write path -- LIVE-CONFIRMED 2026-09-20 (design/GP150_SUPPORT.md §3.1):
    // the wire tag is no longer a placeholder, it's the real, verified formula
    sendReorder,
    sendSetParam,
    sendEnable,
    sendModelSwap,
    sendSave,
    // GP150-13 write path
    buildWritePresetChunks,
    sendWritePreset,
    // GP150-10 write path
    sendPresetInfo,
    sendQuickKnobs,
    sendExpCtrl,
    sendFsSettings,
    // GP150-9 write path
    sendIrUpload,
    sendSnapToneUpload,
    sendNamUpload,
    IR_MAX_SAMPLES,
    IR_USER_IR_SLOT_COUNT: 20,
    NAM_WEIGHTS_COUNT,
    NAM_SLOT_MIN,
    NAM_SLOT_MAX,
    MODULE_FF,
    // exposed for tests / debugging
    _codec: {
      nibblesToBytes, bytesToNibbles, groupChunks, reassembleBody, reassembleStream, splitBursts,
      reassembleFirstBurst, findMatchingBody, findMatchingStream, decodeIndexedRecords,
      bankAndPc, findPort, crc8, computeChecksum, computeWireTag, buildFromPayload, buildReorderMessage,
      buildSetParamMessage, buildEnableMessage, buildModelSwapMessage, buildSaveMessage,
      fxidToMmT1T2, float32LEBytes, float64LEBytes, buildPatchDataChunks, PATCHDATA_MAGIC, PATCHDATA_CHUNK_MAX_BYTES,
      buildSelectPresetMessage, buildIrUploadEnvelope, buildIrUploadChunks, toBase128Pair,
      buildLibraryStruct, buildCloneUploadStream, buildCloneUploadChunks, convertCloForDevice,
      buildNamUploadEnvelope, buildNamUploadChunks, crc32SkipRange,
    },
  };
})(typeof self !== "undefined" ? self : this);
