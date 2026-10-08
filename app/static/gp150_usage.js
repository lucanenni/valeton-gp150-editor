"use strict";
/*
 * GP-150 "used by": which presets point at which SnapTone / NAM / User IR slot.
 *
 * The pedal can hand out a preset body by index without selecting it
 * (WebMidiGP150.readPresetByIndex, design/GP150_SUPPORT.md §3.2), so the whole
 * list is built by reading the 200 presets one after the other (~40 ms each plus the pause: under a minute
 * the first time) and decoding the N->S and CAB modules of each body:
 *
 *   N->S module: top byte of the model id 0x0F -> SnapTone slot, 0x10 -> NAM slot
 *                (low byte = 0-based slot); anything else is a factory algorithm.
 *   CAB module:  top byte 0x0A and third byte 0x10 -> User IR (low byte = 0-based slot).
 *   (same decomposition as patch/gp150_patch_usage.py)
 *
 * Keeping the list current without re-reading everything:
 *   - the result is cached in localStorage;
 *   - on connect only the presets whose name differs from the cache are re-read
 *     (one request for the 200 names);
 *   - the pedal's own periodic broadcast of the active preset (startLiveSync) and the
 *     editor's own writes call applyBody(), which replaces that one entry;
 *   - rescan() re-reads everything.
 *
 * Requests go one at a time with a settle in between, stop after two consecutive
 * failures, and yield to user actions through exclusive().
 *
 * Browser global GP150Usage; module.exports under node.
 */
(function (root) {
  const SLOTS = 200;
  const KEY = "gp150.usage.v1";
  let settleMs = 150;          // pause after each (acknowledged) reply; the pedal answers in ~40 ms
  const MAX_FAILURES = 2;      // consecutive read failures before the scan gives up
  const NO_NAME = "";

  const F = typeof module !== "undefined" && module.exports ? require("./gp150_format.js") : root.GP150Format;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const entries = new Array(SLOTS).fill(null); // {name, st, nam, ir, nsOn, cabOn}, slots literal 1-based or null
  const listeners = new Set();
  let status = { state: "idle", done: 0, total: 0, message: "" };
  let running = null, cancelled = false;
  let paused = 0, resume = null, inflight = null;
  let saveTimer = null;

  const storage = () => { try { return root.localStorage || null; } catch { return null; } };

  function emit() { for (const cb of listeners) { try { cb(); } catch (e) { console.error(e); } } }
  function setStatus(s) { status = { ...status, ...s }; emit(); }

  // ---- decode -------------------------------------------------------------------------------
  function decodeBody(body) {
    const ns = F.readModuleModel(body, "NS") >>> 0, cab = F.readModuleModel(body, "CAB") >>> 0;
    const nsMm = ns >>> 24, nsT2 = ns & 0xff;
    const cabMm = cab >>> 24, cabB2 = (cab >>> 16) & 0xff, cabT2 = cab & 0xff;
    return {
      name: F.readName(body).trim() || NO_NAME,
      st: nsMm === 0x0f ? nsT2 + 1 : null,
      nam: nsMm === 0x10 ? nsT2 + 1 : null,
      ir: cabMm === 0x0a && cabB2 === 0x10 ? cabT2 + 1 : null,
      nsOn: F.readModuleEnabled(body, "NS"),
      cabOn: F.readModuleEnabled(body, "CAB"),
    };
  }

  // ---- cache --------------------------------------------------------------------------------
  function saveNow() {
    saveTimer = null;
    const s = storage(); if (!s) return;
    try { s.setItem(KEY, JSON.stringify({ v: 1, entries })); } catch { /* quota or private mode */ }
  }
  function saveSoon() { if (saveTimer == null) saveTimer = setTimeout(saveNow, 500); }
  function restore() {
    const s = storage(); if (!s) return;
    try {
      const o = JSON.parse(s.getItem(KEY) || "null");
      if (!o || o.v !== 1 || !Array.isArray(o.entries) || o.entries.length !== SLOTS) return;
      o.entries.forEach((e, i) => { entries[i] = e && typeof e.name === "string" ? e : null; });
    } catch { /* corrupt cache: ignore */ }
  }

  // ---- queries ------------------------------------------------------------------------------
  const known = () => entries.reduce((n, e) => n + (e ? 1 : 0), 0);
  const isComplete = () => known() === SLOTS;
  // kind: "st" | "nam" | "ir"; slot literal 1-based. -> [{slot, name, enabled}]
  function get(kind, slot) {
    const out = [];
    entries.forEach((e, i) => {
      if (!e || e[kind] !== slot) return;
      out.push({ slot: i + 1, name: e.name, enabled: kind === "ir" ? e.cabOn : e.nsOn });
    });
    return out;
  }
  const count = (kind, slot) => get(kind, slot).length;
  const names = () => entries.map((e) => (e ? e.name : null));

  // ---- updates ------------------------------------------------------------------------------
  function setEntry(slot0, e) {
    const prev = JSON.stringify(entries[slot0]);
    entries[slot0] = e;
    if (JSON.stringify(e) !== prev) { saveSoon(); emit(); }
  }
  // A full preset body seen anywhere (live broadcast, our own write): replace that slot's entry.
  function applyBody(body) {
    try {
      if (!F.isGp150(body)) return;
      const slot0 = F.readPatchIndex(body);
      if (slot0 >= 0 && slot0 < SLOTS) setEntry(slot0, decodeBody(body));
    } catch { /* not a preset body */ }
  }

  // ---- scheduling: one request at a time, user actions go first -----------------------------
  async function gate() {
    while (paused > 0 && !cancelled) await new Promise((r) => { resume = r; });
  }
  // Run `fn` between two scan requests (waits for the one in flight to finish first).
  async function exclusive(fn) {
    paused++;
    try {
      if (inflight) { try { await inflight; } catch { /* its own error is reported by the scan */ } }
      return await fn();
    } finally {
      paused--;
      if (paused === 0 && resume) { const r = resume; resume = null; r(); }
    }
  }
  async function request(fn) {
    await gate();
    inflight = (async () => fn())();
    try { return await inflight; } finally { inflight = null; }
  }

  // ---- loading ------------------------------------------------------------------------------
  async function runLoad(force) {
    const W = root.WebMidiGP150;
    if (!W || !W.isConnected()) throw new Error("not connected to the pedal");
    let todo;
    if (force || known() === 0) {
      todo = Array.from({ length: SLOTS }, (_, i) => i);
    } else {
      setStatus({ state: "loading", done: 0, total: 0, message: "Checking preset names…" });
      const list = await request(() => W.readAllNames());
      const byIndex = new Map(list.map((x) => [x.index, (x.name || "").trim()]));
      todo = [];
      for (let i = 0; i < SLOTS; i++) {
        const e = entries[i];
        if (!e || (byIndex.has(i) && byIndex.get(i) !== e.name)) todo.push(i);
      }
      await sleep(settleMs);
    }
    const total = todo.length;
    let failures = 0, done = 0;
    for (const i of todo) {
      if (cancelled) break;
      setStatus({ state: "loading", done, total, message: `Reading presets… ${done}/${total}` });
      try {
        const body = await request(() => W.readPresetByIndex(i));
        setEntry(i, decodeBody(body));
        failures = 0;
      } catch (e) {
        if (++failures >= MAX_FAILURES) throw new Error(`stopped after ${failures} failed reads (preset ${i + 1}): ${e.message}`);
      }
      done++;
      await sleep(settleMs);
    }
    saveNow();
    setStatus({ state: cancelled ? "cancelled" : "ready", done, total, message: "" });
  }

  // Start (or join) a load. `force` re-reads all 200 presets, otherwise only what the cache lacks
  // or what changed name since.
  function load({ force = false } = {}) {
    if (running) return running;
    cancelled = false;
    running = runLoad(force)
      .catch((e) => { setStatus({ state: "error", message: e.message }); })
      .finally(() => { running = null; });
    return running;
  }
  const rescan = () => load({ force: true });
  function cancel() { cancelled = true; if (resume) { const r = resume; resume = null; r(); } }

  // Called right after a successful WebMidiGP150.connect(): follow the pedal live and
  // bring the list up to date in the background.
  let liveFor = null;
  function onConnected() {
    const W = root.WebMidiGP150;
    if (W && liveFor !== W && W.startLiveSync) {
      try { W.startLiveSync(applyBody); liveFor = W; } catch { /* no live updates */ }
    }
    return load();
  }

  restore();

  const API = {
    SLOTS, decodeBody, get, count, names, known, isComplete,
    applyBody, load, rescan, cancel, onConnected, exclusive,
    getStatus: () => ({ ...status, known: known() }),
    on: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    configure(o) { if (o && o.settleMs >= 0) settleMs = o.settleMs; },
    _reset() { entries.fill(null); status = { state: "idle", done: 0, total: 0, message: "" }; },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.GP150Usage = API;
})(typeof window !== "undefined" ? window : globalThis);
