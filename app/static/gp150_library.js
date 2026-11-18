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
 *   - Per-slot stars and tags, and named setlists (ordered slot lists), kept next to the bodies and carried
 *     in the backup zip as gp150-library.json. Slot operations (copy / swap / move) plan their writes here;
 *     the caller sends them with writeBackup() and then calls remap() so tags and setlists follow.
 *   - buildBackup(): zip of NNN - Name.prst files, each a valid .prst (the checksum is rewritten, so
 *     Suite and this editor open them). readBackup(): zip or loose .prst files -> validated items,
 *     compared with what the library holds (new / same / changed) before anything is written.
 *
 * Browser global GP150Library; module.exports under node (memory store, plus an injectable store).
 */
(function (root) {
  const SLOTS = 200;
  const META_FILE = "gp150-library.json";
  const DB_NAME = "gp150-library", STORE = "bodies", META_STORE = "meta";

  const isNode = typeof module !== "undefined" && module.exports;
  const F = isNode ? require("./gp150_format.js") : root.GP150Format;
  const Z = isNode ? require("./gp150_zip.js") : root.GP150Zip;

  // ---- stores: {load() -> [{slot, body, at}], put(rec), clear()} ----------------------------
  function memoryStore() {
    const m = new Map(); let meta = null;
    return {
      async load() { return [...m.values()]; }, async put(r) { m.set(r.slot, r); }, async clear() { m.clear(); },
      async loadMeta() { return meta; }, async saveMeta(v) { meta = JSON.parse(JSON.stringify(v)); },
    };
  }
  function idbStore(idb) {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const rq = idb.open(DB_NAME, 2);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "slot" });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    }));
    const tx = async (mode, fn, name = STORE) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(name, mode), rq = fn(t.objectStore(name));
        t.oncomplete = () => res(rq && rq.result);
        t.onerror = t.onabort = () => rej(t.error);
      });
    };
    return {
      load: () => tx("readonly", (s) => s.getAll()),
      put: (r) => tx("readwrite", (s) => s.put(r)),
      clear: () => tx("readwrite", (s) => s.clear()),
      loadMeta: async () => { const r = await tx("readonly", (s) => s.get("state"), META_STORE); return r ? r.value : null; },
      saveMeta: (v) => tx("readwrite", (s) => s.put({ key: "state", value: v }), META_STORE),
    };
  }

  // ---- state --------------------------------------------------------------------------------
  const bodies = new Array(SLOTS).fill(null);   // {body, at}
  const listeners = new Set();
  let store = null, ready = null, ring = null, summaries = new Array(SLOTS).fill(null);
  // stars, tags (per slot) and setlists. Slots are 0-based keys; ids are small integers.
  let meta = { slots: {}, setlists: [], nextId: 1 };
  const emptyMeta = () => ({ slots: {}, setlists: [], nextId: 1 });
  const emit = () => { for (const cb of listeners) { try { cb(); } catch (e) { console.error(e); } } };

  function init(opts = {}) {
    store = opts.store || (root.indexedDB ? idbStore(root.indexedDB) : memoryStore());
    if (opts.ring !== undefined) setRing(opts.ring);
    ready = Promise.all([store.load(), store.loadMeta ? store.loadMeta().catch(() => null) : null]).then(([rows, m]) => {
      if (m) adoptMeta(m);
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


  // ---- stars, tags, setlists ----------------------------------------------------------------
  const cleanTag = (t) => String(t).trim().replace(/\s+/g, " ").slice(0, 24);
  function adoptMeta(m) {
    const out = emptyMeta();
    for (const [k, v] of Object.entries((m && m.slots) || {})) {
      const slot = Number(k);
      if (!(slot >= 0 && slot < SLOTS) || !v) continue;
      const tags = [...new Set((Array.isArray(v.tags) ? v.tags : []).map(cleanTag).filter(Boolean))];
      if (v.star || tags.length) out.slots[slot] = { star: !!v.star, tags };
    }
    for (const sl of (m && m.setlists) || []) {
      if (!sl || typeof sl.name !== "string") continue;
      out.setlists.push({ id: out.nextId++, name: sl.name.slice(0, 40) || "Setlist", slots: (Array.isArray(sl.slots) ? sl.slots : []).filter((x) => Number.isInteger(x) && x >= 0 && x < SLOTS) });
    }
    meta = out;
  }
  const exportMeta = () => ({ format: "gp150-library", version: 1, slots: JSON.parse(JSON.stringify(meta.slots)), setlists: meta.setlists.map((s) => ({ name: s.name, slots: [...s.slots] })) });
  function saveMeta() {
    whenReady().then(() => store.saveMeta && store.saveMeta(JSON.parse(JSON.stringify(meta)))).catch(() => {});
    emit();
  }
  const getMeta = (slot0) => { const m = meta.slots[slot0]; return m ? { star: m.star, tags: [...m.tags] } : { star: false, tags: [] }; };
  function putMeta(slot0, star, tags) {
    if (star || tags.length) meta.slots[slot0] = { star, tags }; else delete meta.slots[slot0];
  }
  function setStar(slot0, on) { const m = getMeta(slot0); putMeta(slot0, !!on, m.tags); saveMeta(); }
  function setTags(slot0, tags) {
    const m = getMeta(slot0);
    putMeta(slot0, m.star, [...new Set((tags || []).map(cleanTag).filter(Boolean))]);
    saveMeta();
  }
  function allTags() {
    const n = new Map();
    for (const m of Object.values(meta.slots)) for (const t of m.tags) n.set(t, (n.get(t) || 0) + 1);
    return [...n].sort((a, b) => a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
  }
  const listSetlists = () => meta.setlists.map((s) => ({ id: s.id, name: s.name, slots: [...s.slots] }));
  const findSetlist = (id) => { const s = meta.setlists.find((x) => x.id === id); if (!s) throw new Error("no such setlist"); return s; };
  function createSetlist(name) {
    const id = meta.nextId++;
    meta.setlists.push({ id, name: cleanTag(name).slice(0, 40) || "Setlist", slots: [] });
    saveMeta(); return id;
  }
  function renameSetlist(id, name) { findSetlist(id).name = cleanTag(name).slice(0, 40) || "Setlist"; saveMeta(); }
  function deleteSetlist(id) { meta.setlists = meta.setlists.filter((s) => s.id !== id); saveMeta(); }
  function setlistAdd(id, slot0) {
    if (!(slot0 >= 0 && slot0 < SLOTS)) throw new Error("slot out of range");
    findSetlist(id).slots.push(slot0); saveMeta();
  }
  function setlistRemove(id, index) { const s = findSetlist(id); if (index >= 0 && index < s.slots.length) s.slots.splice(index, 1); saveMeta(); }
  function setlistMove(id, from, to) {
    const s = findSetlist(id);
    if (from < 0 || from >= s.slots.length || to < 0 || to >= s.slots.length) return;
    const [x] = s.slots.splice(from, 1); s.slots.splice(to, 0, x); saveMeta();
  }
  // After presets moved on the pedal: mapping {from: to} (swap: both ways; move: from -> to). Stars, tags
  // and setlist entries of a source follow it; whatever sat on a destination that is not itself a source is
  // overwritten (its stars/tags go; setlist entries keep pointing at the slot, which now holds the arrival).
  function remap(mapping) {
    const pairs = Object.entries(mapping).map(([a, b]) => [Number(a), Number(b)]);
    const moved = new Map(pairs.map(([a]) => [a, meta.slots[a] ? meta.slots[a] : null]));
    for (const [, b] of pairs) if (!moved.has(b)) delete meta.slots[b];
    for (const [a] of pairs) delete meta.slots[a];
    for (const [a, b] of pairs) if (moved.get(a)) meta.slots[b] = moved.get(a);
    const to = new Map(pairs);
    for (const sl of meta.setlists) sl.slots = sl.slots.map((x) => (to.has(x) ? to.get(x) : x));
    saveMeta();
  }
  function copyMeta(from, to) {
    const m = meta.slots[from];
    if (m) meta.slots[to] = { star: m.star, tags: [...m.tags] }; else delete meta.slots[to];
    saveMeta();
  }
  // Merge or replace from a backup's gp150-library.json (already adoptMeta-shaped through readBackup).
  function applyMeta(m, { mode = "replace" } = {}) {
    if (mode === "replace") { adoptMeta(m); saveMeta(); return; }
    const cur = exportMeta(), add = { slots: { ...cur.slots }, setlists: [...cur.setlists] };
    for (const [k, v] of Object.entries((m && m.slots) || {})) {
      const c = add.slots[k];
      add.slots[k] = c ? { star: c.star || !!v.star, tags: [...new Set([...(c.tags || []), ...(v.tags || [])])] } : v;
    }
    for (const sl of (m && m.setlists) || []) if (!add.setlists.some((x) => x.name === sl.name)) add.setlists.push(sl);
    adoptMeta(add); saveMeta();
  }

  // ---- slot operations (planning only: the caller writes them) ------------------------------
  const isEmptyBody = (body) => { const d = F.decode(body); return (d.name || "").trim() === "It's GP-150" && !Object.entries(d.moduleEnabled).some(([mod, on]) => on && mod !== "VOL"); };  // the volume block is always on
  function emptyTemplate(exclude = []) {
    for (let i = SLOTS - 1; i >= 0; i--) if (bodies[i] && !exclude.includes(i) && isEmptyBody(bodies[i].body)) return bodies[i].body;
    return null;
  }
  const withSlot = (body, slot) => { const b = new Uint8Array(body); b[F.PATCH_INDEX_OFF] = slot; return F.fixChecksum(b); };
  const item = (slot, body) => ({ slot, name: F.readName(body).trim(), body });
  // op: "copy" | "swap" | "move"; a is the source slot, b the target (both 0-based).
  // -> {items: readBackup-shaped writes, mapping: for remap() ({} for copy), overwritten: [{slot, name}]}
  function planSlotOp(op, a, b) {
    if (!(a >= 0 && a < SLOTS && b >= 0 && b < SLOTS)) throw new Error("slot must be 1-200");
    if (a === b) throw new Error("pick a different slot");
    const A = bodies[a], B = bodies[b];
    if (!A) throw new Error(`slot ${a + 1} isn't in the library yet`);
    const name = (s) => (bodies[s] ? F.readName(bodies[s].body).trim() : "?");
    if (op === "copy") return { items: [item(b, withSlot(A.body, b))], mapping: {}, overwritten: [{ slot: b, name: name(b) }] };
    if (op === "swap") {
      if (!B) throw new Error(`slot ${b + 1} isn't in the library yet`);
      return { items: [item(b, withSlot(A.body, b)), item(a, withSlot(B.body, a))], mapping: { [a]: b, [b]: a }, overwritten: [{ slot: a, name: name(a) }, { slot: b, name: name(b) }] };
    }
    if (op === "move") {
      const blank = emptyTemplate([a, b]);
      if (!blank) throw new Error("no empty preset in the library to leave behind — copy it instead, or read the pedal's presets first");
      return { items: [item(b, withSlot(A.body, b)), item(a, withSlot(blank, a))], mapping: { [a]: b }, overwritten: [{ slot: b, name: name(b) }, { slot: a, name: `${name(a)} (left empty)` }] };
    }
    throw new Error(`unknown operation ${op}`);
  }
  // A new preset (from the generator) for `slot`: the same plan shape as the operations above.
  function planPut(slot, body, verb) {
    if (!(slot >= 0 && slot < SLOTS)) throw new Error("slot must be 1-200");
    if (!body || body.length !== F.PRST_LEN) throw new Error("not a GP-150 preset");
    const cur = bodies[slot];
    return { items: [item(slot, withSlot(body, slot))], mapping: {}, overwritten: [{ slot, name: cur ? F.readName(cur.body).trim() : "?" }] };
  }
  // First slot, counting from the end, that reads as empty (the factory "It's GP-150" with nothing enabled), or null.
  function lastEmptySlot() {
    for (let i = SLOTS - 1; i >= 0; i--) if (bodies[i] && isEmptyBody(bodies[i].body)) return i;
    return null;
  }
  // Name and chain of a body that is not in the library (a generated preset), as summary() describes the stored ones.
  const describeBody = (body) => summarize(F.readPatchIndex(body), body);
  // New name for one preset (13 characters at most, the pedal's limit).
  function planRename(slot, newName) {
    const cur = bodies[slot]; if (!cur) throw new Error(`slot ${slot + 1} isn't in the library yet`);
    const n = String(newName).trim();
    if (!n) throw new Error("the name can't be empty");
    if (!/^[\x20-\x7e]+$/.test(n)) throw new Error("use printable ASCII characters only");
    if (n.length > F.NAME_MAX) throw new Error(`at most ${F.NAME_MAX} characters`);
    const b = new Uint8Array(cur.body); F.writeName(b, n); F.fixChecksum(b);
    return { items: [item(slot, b)], mapping: {}, overwritten: [{ slot, name: F.readName(cur.body).trim() }] };
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
    const base = summaries[slot0] || (summaries[slot0] = summarize(slot0, e.body));
    const m = meta.slots[slot0];
    return { ...base, star: !!(m && m.star), tags: m ? [...m.tags] : [] };
  }

  // All words must match (substring, case-insensitive). A purely numeric word also matches the slot
  // number ("12" or "012"). `onlyOn`: look only at enabled modules. -> summaries in slot order.
  function search(query = "", { onlyOn = false, starred = false, tag = null } = {}) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < SLOTS; i++) {
      const s = summary(i); if (!s) continue;
      const m = meta.slots[i];
      if (starred && !(m && m.star)) continue;
      if (tag && !(m && m.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase()))) continue;
      const chain = (onlyOn ? s.chain.filter((c) => c.on) : s.chain).map((c) => `${c.mod} ${c.label}`).join(" ");
      const hay = `${s.name} ${chain} ${m ? m.tags.join(" ") : ""}`.toLowerCase();
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
    const m = exportMeta();
    if (Object.keys(m.slots).length || m.setlists.length) files.push({ name: META_FILE, data: new TextEncoder().encode(JSON.stringify(m, null, 1)) });
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
    let metaIn = null;
    for (const e of entries) {
      const base = e.name.split("/").pop();
      if (/^(\.|__MACOSX)/.test(base) || e.name.includes("__MACOSX/")) continue;
      if (base === META_FILE) {
        try {
          const j = JSON.parse(new TextDecoder().decode(e.data));
          if (j && j.format === "gp150-library") metaIn = j; else skipped.push({ file: e.name, reason: "not a GP-150 library file" });
        } catch { skipped.push({ file: e.name, reason: "unreadable library file" }); }
        continue;
      }
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
    let metaSummary = null;
    if (metaIn) {
      const keep = meta; adoptMeta(metaIn); const got = meta; meta = keep;
      metaSummary = { data: exportMetaOf(got), tagged: Object.keys(got.slots).length, setlists: got.setlists.length };
    }
    return { items, skipped, meta: metaSummary };
  }
  const exportMetaOf = (m) => ({ format: "gp150-library", version: 1, slots: JSON.parse(JSON.stringify(m.slots)), setlists: m.setlists.map((s) => ({ name: s.name, slots: [...s.slots] })) });

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
      // the pedal can be slow to answer right after committing presets: three tries, waiting longer each time
      let names, lastErr;
      for (let attempt = 0; attempt < 3 && !names; attempt++) {
        if (attempt) await sleep(retryMs * attempt);
        try { names = await read(); } catch (e) { lastErr = e; }
      }
      if (!names) throw new Error(`the presets were sent, but the pedal didn't answer the check (${lastErr.message}). Use “Re-read all presets” to see what it holds now`);
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
    getMeta, setStar, setTags, allTags, listSetlists, createSetlist, renameSetlist, deleteSetlist, setlistAdd, setlistRemove, setlistMove,
    remap, copyMeta, applyMeta, planSlotOp, planRename, planPut, lastEmptySlot, describeBody, emptyTemplate,
    on: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    _reset() { bodies.fill(null); summaries.fill(null); ring = null; store = null; ready = null; meta = emptyMeta(); },
  };
  if (isNode) module.exports = API; else root.GP150Library = API;
})(typeof window !== "undefined" ? window : globalThis);
