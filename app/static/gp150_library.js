"use strict";
/*
 * GP-150 preset library: a local copy of the pedal's 200 presets, searchable and backed up as a zip.
 *
 *   - put()/get(): the raw 1128-byte .prst bodies, one per slot, kept in IndexedDB (memory only when
 *     the browser has none). GP150Usage hands every body it reads over (its full scan, the live
 *     broadcast, the editor's own writes), so the library fills while "used by" loads and follows
 *     the pedal afterwards with no extra traffic.
 *   - summary()/search(): name, slot and the model of every module, matched word by word
 *     ("plexi 012", "snaptone", "spring reverb").
 *   - buildBackup(): zip of NNN - Name.prst files, each a valid .prst (the checksum is rewritten, so
 *     Suite and this editor open them). readBackup(): zip or loose .prst files -> validated items,
 *     compared with what the library holds (new / same / changed) before anything is written.
 *
 * Browser global GP150Library; module.exports under node (memory store, plus an injectable store).
 */
(function (root) {
  const SLOTS = 200;
  const DB_NAME = "gp150-library", STORE = "bodies";

  const isNode = typeof module !== "undefined" && module.exports;
  const F = isNode ? require("./gp150_format.js") : root.GP150Format;
  const Z = isNode ? require("./gp150_zip.js") : root.GP150Zip;

  // ---- stores: {load() -> [{slot, body, at}], put(rec), clear()} ----------------------------
  function memoryStore() {
    const m = new Map();
    return { async load() { return [...m.values()]; }, async put(r) { m.set(r.slot, r); }, async clear() { m.clear(); } };
  }
  function idbStore(idb) {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const rq = idb.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: "slot" });
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(STORE, mode), rq = fn(t.objectStore(STORE));
        t.oncomplete = () => res(rq && rq.result);
        t.onerror = t.onabort = () => rej(t.error);
      });
    };
    return {
      load: () => tx("readonly", (s) => s.getAll()),
      put: (r) => tx("readwrite", (s) => s.put(r)),
      clear: () => tx("readwrite", (s) => s.clear()),
    };
  }

  // ---- state --------------------------------------------------------------------------------
  const bodies = new Array(SLOTS).fill(null);   // {body, at}
  const listeners = new Set();
  let store = null, ready = null, ring = null, summaries = new Array(SLOTS).fill(null);
  const emit = () => { for (const cb of listeners) { try { cb(); } catch (e) { console.error(e); } } };

  function init(opts = {}) {
    store = opts.store || (root.indexedDB ? idbStore(root.indexedDB) : memoryStore());
    if (opts.ring !== undefined) setRing(opts.ring);
    ready = store.load().then((rows) => {
      for (const r of rows || []) {
        if (r && r.slot >= 0 && r.slot < SLOTS && r.body && r.body.length === F.PRST_LEN && !bodies[r.slot]) {
          bodies[r.slot] = { body: new Uint8Array(r.body), at: r.at || 0 };
          summaries[r.slot] = null;
        }
      }
      emit();
    }).catch(() => { store = memoryStore(); }); // blocked storage: keep working in memory
    return ready;
  }
  const whenReady = () => ready || init();

  // The fxid -> model catalog (app/static/data/fxid_ring_gp150.json), needed to name the models.
  function setRing(r) { ring = r || null; summaries = new Array(SLOTS).fill(null); emit(); }

  const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

  // ---- reading / writing --------------------------------------------------------------------
  function put(slot0, body, at = Date.now()) {
    if (!(slot0 >= 0 && slot0 < SLOTS) || !body || body.length !== F.PRST_LEN) return false;
    const b = new Uint8Array(body); b[F.PATCH_INDEX_OFF] = slot0;
    const cur = bodies[slot0];
    if (cur && same(cur.body, b)) return false;
    bodies[slot0] = { body: b, at };
    summaries[slot0] = null;
    whenReady().then(() => store.put({ slot: slot0, body: b, at })).catch(() => {});
    emit();
    return true;
  }
  const get = (slot0) => (bodies[slot0] ? bodies[slot0].body : null);
  const count = () => bodies.reduce((n, e) => n + (e ? 1 : 0), 0);
  async function clear() {
    bodies.fill(null); summaries.fill(null);
    await whenReady(); await store.clear(); emit();
  }

  // ---- summaries and search -----------------------------------------------------------------
  function modelLabel(mod, fxid) {
    const mm = fxid >>> 24, b2 = (fxid >>> 16) & 0xff, t2 = fxid & 0xff;
    if (mod === "NS" && mm === 0x0f) return `SnapTone ${t2 + 1}`;
    if (mod === "NS" && mm === 0x10) return `NAM ${t2 + 1}`;
    if (mod === "CAB" && mm === 0x0a && b2 === 0x10) return `User IR ${t2 + 1}`;
    if (fxid === F.FXID_NONE && mod !== "VOL") return null;
    const e = ring && ring[String(fxid)];
    return e ? (e.name || e.fxtitle || null) : null;
  }

  // {slot (1-based), name, chain: [{mod, label, on}] in signal order, text (lower-case haystack)}
  function summarize(slot0, body) {
    const d = F.decode(body);
    const chain = [];
    for (const mod of d.chainOrder) {
      if (mod === "VOL") continue; // the volume block is always there: noise in a list and in search
      const label = modelLabel(mod, d.moduleModels[mod]);
      if (label) chain.push({ mod, label, on: !!d.moduleEnabled[mod] });
    }
    const name = d.name || "";
    return { slot: slot0 + 1, name, chain, text: `${name} ${chain.map((c) => `${c.mod} ${c.label}`).join(" ")}`.toLowerCase() };
  }
  function summary(slot0) {
    const e = bodies[slot0]; if (!e) return null;
    return summaries[slot0] || (summaries[slot0] = summarize(slot0, e.body));
  }

  // All words must match (substring, case-insensitive). A purely numeric word also matches the slot
  // number ("12" or "012"). `onlyOn`: look only at enabled modules. -> summaries in slot order.
  function search(query = "", { onlyOn = false } = {}) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < SLOTS; i++) {
      const s = summary(i); if (!s) continue;
      const chain = (onlyOn ? s.chain.filter((c) => c.on) : s.chain).map((c) => `${c.mod} ${c.label}`).join(" ");
      const hay = `${s.name} ${chain}`.toLowerCase();
      if (words.every((w) => hay.includes(w) || (/^\d+$/.test(w) && Number(w) === s.slot))) out.push(s);
    }
    return out;
  }

  // ---- backup / restore ---------------------------------------------------------------------
  const safeName = (s) => (s || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim() || "Untitled";
  const fileName = (slot0, name) => `${String(slot0 + 1).padStart(3, "0")} - ${safeName(name)}.prst`;

  // Zip of the chosen slots (default: all that are known). Every file is a valid .prst.
  function buildBackup({ slots = null, date } = {}) {
    const list = (slots || Array.from({ length: SLOTS }, (_, i) => i)).filter((i) => bodies[i]);
    if (!list.length) throw new Error("nothing to back up yet");
    const files = list.map((i) => {
      const b = new Uint8Array(bodies[i].body);
      F.fixChecksum(b);
      return { name: fileName(i, F.readName(b)), data: b };
    });
    return Z.build(files, date ? { date } : undefined);
  }

  // files: [{name, data}] (a zip's entries, or loose .prst files). A zip passed as one entry is unpacked.
  // -> {items, skipped}: items {slot (0-based), body, name, file, status: new|same|changed, checksumOk};
  // skipped [{file, reason}]. Later files win when two target the same slot.
  async function readBackup(files) {
    const entries = [], skipped = [];
    for (const f of files) {
      const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      if (/\.zip$/i.test(f.name) || (data.length > 3 && data[0] === 0x50 && data[1] === 0x4b)) {
        try { for (const e of await Z.parse(data)) entries.push(e); } catch (e) { skipped.push({ file: f.name, reason: e.message }); }
      } else entries.push({ name: f.name, data });
    }
    const bySlot = new Map();
    for (const e of entries) {
      const base = e.name.split("/").pop();
      if (/^(\.|__MACOSX)/.test(base) || e.name.includes("__MACOSX/")) continue;
      if (!/\.prst$/i.test(base)) { skipped.push({ file: e.name, reason: "not a .prst file" }); continue; }
      if (!F.isGp150(e.data)) { skipped.push({ file: e.name, reason: "not a GP-150 preset (wrong size or header)" }); continue; }
      const slot = F.readPatchIndex(e.data);
      if (slot >= SLOTS) { skipped.push({ file: e.name, reason: `slot index ${slot} out of range` }); continue; }
      const body = new Uint8Array(e.data);
      const ok = F.checksumOk(body);
      bySlot.set(slot, { slot, body, name: F.readName(body), file: base, checksumOk: ok });
    }
    const items = [...bySlot.values()].sort((a, b) => a.slot - b.slot);
    for (const it of items) {
      const cur = bodies[it.slot];
      // compare with the checksum normalised on both sides: pedal bodies may carry the device's own value
      it.status = !cur ? "new" : same(F.fixChecksum(new Uint8Array(cur.body)), F.fixChecksum(new Uint8Array(it.body))) ? "same" : "changed";
    }
    return { items, skipped };
  }

  // Writes the chosen readBackup() items to the pedal one after the other, then reads the names back and
  // keeps the library (and the "used by" list) in step for every slot that reads back correctly.
  // -> {written: [slot0], failed: [{slot, expected, got}]}. Throws if a send fails; slots written before
  // that stay written (the caller says so). `pedal` is WebMidiGP150, `usage` GP150Usage (optional).
  async function writeBackup(items, { pedal, usage = null, gapMs = 1500, settleMs = 1500, retryMs = 3000, onProgress = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const prepared = items.map((it) => {
      const body = F.fixChecksum(new Uint8Array(it.body)); body[F.PATCH_INDEX_OFF] = it.slot;
      return { slot: it.slot, name: (it.name || "").trim(), body };
    });
    const run = async () => {
      for (let n = 0; n < prepared.length; n++) {
        onProgress({ phase: "write", done: n, total: prepared.length, slot: prepared[n].slot });
        pedal.sendWritePreset(prepared[n].body, prepared[n].slot);
        await sleep(gapMs);
      }
      onProgress({ phase: "verify", done: prepared.length, total: prepared.length });
      await sleep(settleMs);
      const read = async () => new Map((await pedal.readAllNames()).map((n) => [n.index, (n.name || "").trim()]));
      let names;
      try { names = await read(); } catch { await sleep(retryMs); names = await read(); }
      const written = [], failed = [];
      for (const p of prepared) {
        const got = names.get(p.slot);
        if (got === p.name) { put(p.slot, p.body); if (usage) usage.applyBody(p.body); written.push(p.slot); }
        else failed.push({ slot: p.slot, expected: p.name, got: got ?? null });
      }
      return { written, failed };
    };
    return usage ? usage.exclusive(run) : run();
  }

  const API = {
    SLOTS, init, whenReady, setRing, put, get, count, clear, summary, search, buildBackup, readBackup, writeBackup,
    fileName, memoryStore,
    on: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    _reset() { bodies.fill(null); summaries.fill(null); ring = null; store = null; ready = null; },
  };
  if (isNode) module.exports = API; else root.GP150Library = API;
})(typeof window !== "undefined" ? window : globalThis);
