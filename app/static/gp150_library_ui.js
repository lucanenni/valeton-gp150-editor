"use strict";
/*
 * GP-150 Library view (explorer page): the local copy of the 200 presets (gp150_library.js), searchable,
 * with a zip backup and a restore that writes a backup (zip or loose .prst files) back to the pedal.
 *
 * Per preset: a star, tags, and an actions menu (rename, copy / swap / move to another slot, add to a setlist).
 * Slot operations are written to the pedal like a restore (confirmed, sent one after the other, read back).
 * Below the list: setlists (ordered presets) with a stage mode that selects each one on the pedal.
 *
 * The library fills from GP150Usage's background read (connect -> only what changed is re-read) and from
 * the live broadcast, so there is no button to press in the normal case. Everything except restore works
 * offline, from what was last read.
 */
(() => {
  const root = document.getElementById("gp150-library");
  const L = window.GP150Library, U = window.GP150Usage, W = window.WebMidiGP150, F = window.GP150Format;
  if (!root || !L || !F) return;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("gp150-lib-status"), searchEl = $("gp150-lib-search"), onlyOnEl = $("gp150-lib-only-on");
  const listEl = $("gp150-lib-list"), emptyEl = $("gp150-lib-empty"), errEl = $("gp150-lib-error");
  const backupAllBtn = $("gp150-lib-backup-all"), backupShownBtn = $("gp150-lib-backup-shown");
  const restoreBtn = $("gp150-lib-restore-btn"), restoreInput = $("gp150-lib-restore-input");
  const rescanBtn = $("gp150-lib-rescan");
  const starredEl = $("gp150-lib-starred"), tagEl = $("gp150-lib-tag"), setlistsEl = $("gp150-lib-setlists");
  const panel = $("gp150-lib-restore"), panelList = $("gp150-lib-restore-list"), panelSummary = $("gp150-lib-restore-summary");
  const metaRow = $("gp150-lib-restore-meta"), metaCheck = $("gp150-lib-restore-meta-check"), metaMode = $("gp150-lib-restore-meta-mode"), metaText = $("gp150-lib-restore-meta-text");
  const panelGo = $("gp150-lib-restore-go"), panelCancel = $("gp150-lib-restore-cancel"), panelStatus = $("gp150-lib-restore-status");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(3, "0");
  const showError = (msg) => { errEl.textContent = msg; errEl.hidden = !msg; };
  const WRITE_GAP_MS = 1500;       // pause after each preset write: the pedal commits 1128 bytes to flash
  const VERIFY_SETTLE_MS = 1500, VERIFY_RETRY_MS = 3000;

  // ---- plumbing: catalog, scan on connect, reads yield to the scan ---------------------------
  fetch((window.__VALETON_STATIC__ ? "data/" : "/static/data/") + "fxid_ring_gp150.json")
    .then((r) => r.json()).then((ring) => L.setRing(ring)).catch(() => showError("Couldn't load the model catalog — model names won't be searchable."));
  L.init();
  if (U) {
    U.onBody((slot0, body) => L.put(slot0, body), (slot0) => !L.get(slot0));
    if (W) U.guard(W, ["readActivePreset", "readSlotViaSelect", "readAllNames", "readUserIrs", "readSnaptones", "readNamModels"]);
  }
  if (W && !W.__usageHooked) {
    const rawConnect = W.connect;
    W.connect = async (...a) => {
      const r = await rawConnect.apply(W, a);
      if (U) U.onConnected();
      return r;
    };
    W.__usageHooked = true;
  }

  // ---- list ------------------------------------------------------------------------------------
  let shown = [];
  const filters = () => ({ onlyOn: onlyOnEl.checked, starred: starredEl.checked, tag: tagEl.value || null });
  const hasFilter = () => !!(searchEl.value.trim() || onlyOnEl.checked || starredEl.checked || tagEl.value);

  function refreshTagMenu() {
    const keep = tagEl.value, tags = L.allTags();
    tagEl.textContent = "";
    tagEl.appendChild(new Option(tags.length ? "all tags" : "no tags yet", ""));
    for (const t of tags) tagEl.appendChild(new Option(`${t.tag} (${t.count})`, t.tag));
    tagEl.value = tags.some((t) => t.tag === keep) ? keep : "";
    tagEl.disabled = !tags.length;
  }

  const ACTIONS = [
    ["", "Actions…"], ["rename", "Rename…"], ["tags", "Edit tags…"], ["copy", "Copy to slot…"], ["swap", "Swap with slot…"],
    ["move", "Move to slot…"], ["setlist", "Add to setlist…"],
  ];
  function render() {
    shown = L.search(searchEl.value, filters());
    refreshTagMenu();
    listEl.textContent = "";
    for (const s of shown) {
      const li = document.createElement("li");
      li.className = "gp150-lib-row";
      const star = document.createElement("button");
      star.type = "button"; star.className = "gp150-lib-star" + (s.star ? " on" : "");
      star.textContent = s.star ? "★" : "☆"; star.title = s.star ? "Remove the star" : "Star this preset";
      star.setAttribute("aria-pressed", s.star ? "true" : "false");
      star.addEventListener("click", () => L.setStar(s.slot - 1, !s.star));
      const slot = document.createElement("span"); slot.className = "gp150-lib-slot"; slot.textContent = pad(s.slot);
      const name = document.createElement("span"); name.className = "gp150-lib-name"; name.textContent = s.name || "(unnamed)";
      const tags = document.createElement("span"); tags.className = "gp150-lib-tags";
      for (const t of s.tags) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "gp150-lib-tag"; b.textContent = t; b.title = `Show only “${t}”`;
        b.addEventListener("click", () => { tagEl.value = t; render(); });
        tags.appendChild(b);
      }
      const chain = document.createElement("span"); chain.className = "gp150-lib-chain";
      for (const c of s.chain) {
        if (!c.on) continue;
        const chip = document.createElement("span");
        chip.className = "gp150-lib-chip"; chip.textContent = c.label; chip.title = c.mod;
        chain.appendChild(chip);
      }
      const menu = document.createElement("select");
      menu.className = "gp150-lib-actions"; menu.setAttribute("aria-label", `Actions for preset ${pad(s.slot)}`);
      for (const [v, t] of ACTIONS) menu.appendChild(new Option(t, v));
      menu.addEventListener("change", () => { const a = menu.value; menu.value = ""; if (a) runAction(a, s); });
      const open = document.createElement("button");
      open.type = "button"; open.textContent = "Open";
      open.title = "Show this preset in the inspector above";
      open.addEventListener("click", () => {
        const body = L.get(s.slot - 1);
        if (body && window.GP150UI) window.GP150UI.openBody(body, `library-slot${pad(s.slot)}.prst`);
      });
      li.append(star, slot, name, tags, chain, menu, open);
      listEl.appendChild(li);
    }
    const total = L.count();
    emptyEl.hidden = total > 0;
    emptyEl.textContent = "Nothing saved yet — connect to the pedal and its presets are read in the background.";
    backupAllBtn.disabled = total === 0;
    backupShownBtn.disabled = shown.length === 0;
    backupShownBtn.hidden = !hasFilter();
    backupShownBtn.textContent = `Back up the ${shown.length} shown`;
    renderStatus();
    renderSetlists();
  }

  function renderStatus() {
    const total = L.count();
    const s = U ? U.getStatus() : { state: "idle" };
    let t = `${total}/200 presets saved on this computer`;
    if (hasFilter()) t += ` — ${shown.length} match`;
    if (s.state === "loading") t += ` · ${s.message}`;
    else if (s.state === "error") t += ` · scan stopped: ${s.message}`;
    statusEl.textContent = t;
    rescanBtn.textContent = s.state === "loading" ? "Stop" : "Re-read all presets";
  }

  let renderTimer = null;
  const renderSoon = () => { if (renderTimer == null) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 150); };
  L.on(renderSoon);
  if (U) U.on(renderStatus);
  searchEl.addEventListener("input", render);
  onlyOnEl.addEventListener("change", render);
  starredEl.addEventListener("change", render);
  tagEl.addEventListener("change", render);

  rescanBtn.addEventListener("click", async () => {
    showError("");
    if (!U) return;
    if (U.getStatus().state === "loading") { U.cancel(); return; }
    try {
      if (!W.isConnected()) await W.connect();   // the connect hook already starts a load
      U.rescan();
    } catch (e) { showError(e.message); }
  });

  // ---- backup ----------------------------------------------------------------------------------
  function download(bytes, filename) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function backup(slots, label) {
    showError("");
    try {
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
      const zip = L.buildBackup({ slots, date: d });
      download(zip, `gp150-${label}-${stamp}.zip`);
      return true;
    } catch (e) { showError(e.message); return false; }
  }
  backupAllBtn.addEventListener("click", () => backup(null, "backup"));
  backupShownBtn.addEventListener("click", () => backup(shown.map((s) => s.slot - 1), "selection"));

  // ---- restore ---------------------------------------------------------------------------------
  let pending = null;   // {items, skipped}
  const rowChecks = [];

  function closePanel() { panel.hidden = true; pending = null; rowChecks.length = 0; panelList.textContent = ""; panelStatus.textContent = ""; metaRow.hidden = true; }
  panelCancel.addEventListener("click", closePanel);

  restoreBtn.addEventListener("click", () => restoreInput.click());
  restoreInput.addEventListener("change", async () => {
    showError("");
    const files = [...restoreInput.files];
    restoreInput.value = "";
    if (!files.length) return;
    try {
      const loaded = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
      await L.whenReady();
      pending = await L.readBackup(loaded);
      renderRestorePanel();
    } catch (e) { showError(e.message); }
  });

  metaCheck.addEventListener("change", () => { if (pending) updateGo(); });
  function selectedItems() { return pending ? pending.items.filter((_, i) => rowChecks[i] && rowChecks[i].checked) : []; }
  function updateGo() {
    const n = selectedItems().length;
    panelGo.textContent = n === 0 && pending && pending.meta ? "Restore tags and setlists only" : `Write ${n} preset${n === 1 ? "" : "s"} to the pedal`;
    panelGo.disabled = n === 0 && !(pending && pending.meta && metaCheck.checked);
  }

  function renderRestorePanel() {
    const { items, skipped } = pending;
    panelList.textContent = "";
    rowChecks.length = 0;
    const counts = { new: 0, same: 0, changed: 0 };
    for (const it of items) counts[it.status]++;
    panelSummary.textContent = items.length
      ? `${items.length} preset${items.length === 1 ? "" : "s"} in the backup: ${counts.changed} differ from what the library holds, ${counts.new} are new to it, ${counts.same} identical.` +
        (skipped.length ? ` ${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped (${skipped.slice(0, 3).map((s) => `${s.file}: ${s.reason}`).join("; ")}${skipped.length > 3 ? "; …" : ""}).` : "")
      : `No GP-150 presets found. ${skipped.map((s) => `${s.file}: ${s.reason}`).join("; ")}`;
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "gp150-lib-row";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = it.status !== "same";
      cb.addEventListener("change", updateGo);
      rowChecks.push(cb);
      const slot = document.createElement("span"); slot.className = "gp150-lib-slot"; slot.textContent = pad(it.slot + 1);
      const cur = L.summary(it.slot);
      const name = document.createElement("span"); name.className = "gp150-lib-name";
      name.textContent = it.status === "changed" && cur && cur.name !== it.name ? `${cur.name || "(unnamed)"} → ${it.name || "(unnamed)"}` : (it.name || "(unnamed)");
      const badge = document.createElement("span");
      badge.className = `gp150-lib-badge ${it.status}`;
      badge.textContent = it.status === "same" ? "identical" : it.status === "new" ? "slot not in library" : "differs";
      li.append(cb, slot, name, badge);
      panelList.appendChild(li);
    }
    metaRow.hidden = !pending.meta;
    if (pending.meta) {
      metaCheck.checked = true; metaMode.value = "merge";
      metaText.textContent = `Also bring back the stars and tags (${pending.meta.tagged} preset${pending.meta.tagged === 1 ? "" : "s"}) and ${pending.meta.setlists} setlist${pending.meta.setlists === 1 ? "" : "s"} from this backup`;
    }
    panel.hidden = false;
    updateGo();
  }
  function applyBackupMeta() {
    if (pending && pending.meta && metaCheck.checked) L.applyMeta(pending.meta.data, { mode: metaMode.value });
  }

  panelGo.addEventListener("click", async () => {
    const items = selectedItems();
    if (!items.length && pending && pending.meta && metaCheck.checked) { applyBackupMeta(); closePanel(); window.UI.toast("Stars, tags and setlists restored.", "ok"); return; }
    if (!items.length || !W) return;
    showError("");
    const unknown = items.filter((it) => !L.get(it.slot)).length;
    const ok = await window.UI.confirmDialog(
      `Overwrite ${items.length} preset${items.length === 1 ? "" : "s"} on the pedal (${items.map((i) => i.slot + 1).slice(0, 12).join(", ")}${items.length > 12 ? ", …" : ""})? ` +
      `Their current content is replaced.` +
      (unknown ? ` ${unknown} of these slot${unknown === 1 ? " is" : "s are"} not in the library, so there is no local copy of what is there now.` : " The library holds a copy of what is there now — use “Back up all” first if you want it in a file."),
      "Write to pedal");
    if (!ok) return;
    panelGo.disabled = true; panelCancel.disabled = true;
    try {
      if (!W.isConnected()) await W.connect();
      const { failed } = await L.writeBackup(items, {
        pedal: W, usage: U, gapMs: WRITE_GAP_MS, settleMs: VERIFY_SETTLE_MS, retryMs: VERIFY_RETRY_MS,
        onProgress: (p) => { panelStatus.textContent = p.phase === "write" ? `Writing ${p.done + 1}/${p.total} — slot ${p.slot + 1}…` : "Verifying…"; },
      });
      if (failed.length) {
        const list = failed.map((f) => `${f.slot + 1} (reads “${f.got ?? "?"}”, expected “${f.expected}”)`).join("; ");
        showError(`Wrote ${items.length}, but ${failed.length} slot${failed.length === 1 ? "" : "s"} did not read back as expected: ${list}. Check the pedal directly before trusting ${failed.length === 1 ? "it" : "them"}.`);
        panelStatus.textContent = "";
      } else {
        applyBackupMeta();
        closePanel();
        window.UI.toast(`Restored ${items.length} preset${items.length === 1 ? "" : "s"} — every name read back correctly.`, "ok");
      }
    } catch (e) {
      showError(`Restore stopped: ${e.message}. Some presets may already have been written — compare with the library before retrying.`);
      panelStatus.textContent = "";
    } finally {
      panelCancel.disabled = false;
      if (pending) updateGo();
    }
  });

    // ---- per-preset actions ----------------------------------------------------------------------
  let busy = false;
  const label = (slot0) => { const m = L.summary(slot0); return `${pad(slot0 + 1)} “${m ? m.name || "(unnamed)" : "?"}”`; };

  // Sends a plan from L.planSlotOp / L.planRename to the pedal after a confirmation, then keeps the library in step.
  async function writePlan(plan, { verb, after }) {
    if (busy) { showError("Another write is still running."); return false; }
    if (!W) { showError("Web MIDI isn't available in this browser."); return false; }
    const lines = plan.overwritten.map((o) => `${o.slot + 1} “${o.name}”`).join(", ");
    const ok = await window.UI.confirmDialog(`${verb}: slot${plan.overwritten.length === 1 ? "" : "s"} ${lines} will be overwritten on the pedal. The library keeps a copy of what is there now — use “Back up all” first if you want it in a file.`, "Write to pedal");
    if (!ok) return false;
    busy = true; showError("");
    try {
      if (!W.isConnected()) await W.connect();
      const { failed } = await L.writeBackup(plan.items, {
        pedal: W, usage: U, gapMs: WRITE_GAP_MS, settleMs: VERIFY_SETTLE_MS, retryMs: VERIFY_RETRY_MS,
        onProgress: (p) => { statusEl.textContent = p.phase === "write" ? `Writing ${p.done + 1}/${p.total} — slot ${p.slot + 1}…` : "Verifying…"; },
      });
      if (failed.length) {
        showError(`${verb}: ${failed.map((f) => `slot ${f.slot + 1} reads “${f.got ?? "?"}”, expected “${f.expected}”`).join("; ")}. Check the pedal directly before trusting ${failed.length === 1 ? "it" : "them"}.`);
        return false;
      }
      if (after) after();
      window.UI.toast(`${verb}: done — every name read back correctly.`, "ok");
      return true;
    } catch (e) {
      showError(`${verb} stopped: ${e.message}. Some slots may already have been written — compare with the library before retrying.`);
      return false;
    } finally { busy = false; renderStatus(); }
  }

  window.GP150LibraryUI = {
    writePlan, isBusy: () => busy,
    // open stage mode on a setlist (used by the command palette)
    startStage(id) {
      const l = L.listSetlists().find((x) => x.id === id);
      if (!l || !l.slots.length) return false;
      currentList = id; stage = { index: 0 }; selectOnPedal(l.slots[0]); renderSetlists();
      return true;
    },
  };

  async function askSlot(text) {
    const raw = await window.UI.promptDialog(text, "", "Next");
    if (raw == null) return null;
    const n = parseInt(String(raw).trim(), 10);
    if (!(n >= 1 && n <= 200)) { showError("Enter a slot number from 1 to 200."); return null; }
    return n - 1;
  }

  async function runAction(action, s) {
    showError("");
    const a = s.slot - 1;
    try {
      if (action === "tags") {
        const raw = await window.UI.promptDialog(`Tags for ${label(a)} (comma separated):`, s.tags.join(", "), "Save");
        if (raw != null) L.setTags(a, raw.split(","));
      } else if (action === "rename") {
        const raw = await window.UI.promptDialog(`New name for ${label(a)} (${F.NAME_MAX} characters at most):`, s.name, "Rename");
        if (raw == null || raw.trim() === s.name) return;
        await writePlan(L.planRename(a, raw), { verb: "Rename" });
      } else if (action === "copy" || action === "swap" || action === "move") {
        const verbs = { copy: "Copy", swap: "Swap", move: "Move" };
        const b = await askSlot(`${verbs[action]} ${label(a)} ${action === "swap" ? "with" : "to"} slot (1-200):`);
        if (b == null) return;
        const plan = L.planSlotOp(action, a, b);
        await writePlan(plan, { verb: `${verbs[action]} ${a + 1} ${action === "swap" ? "↔" : "→"} ${b + 1}`, after: () => { if (action === "copy") L.copyMeta(a, b); else L.remap(plan.mapping); } });
      } else if (action === "setlist") {
        const lists = L.listSetlists();
        const raw = await window.UI.promptDialog(
          `Add ${label(a)} to which setlist? Type its name${lists.length ? ` (${lists.map((x) => x.name).join(", ")})` : ""} — a new name creates it.`,
          lists.length ? lists[lists.length - 1].name : "", "Add");
        if (raw == null || !raw.trim()) return;
        const found = lists.find((x) => x.name.toLowerCase() === raw.trim().toLowerCase());
        const id = found ? found.id : L.createSetlist(raw);
        L.setlistAdd(id, a); currentList = id;
        window.UI.toast(`Added to “${L.listSetlists().find((x) => x.id === id).name}”.`, "ok");
      }
    } catch (e) { showError(e.message); }
  }

  // ---- setlists --------------------------------------------------------------------------------
  let currentList = null, stage = null;   // stage: {index} while stage mode is open
  const selectOnPedal = async (slot0) => {
    try {
      if (!W.isConnected()) await W.connect();
      const send = () => W.selectPreset(slot0);
      if (U && U.exclusive) await U.exclusive(async () => send()); else send();
    } catch (e) { showError(e.message); }
  };
  function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, title, fn) { const b = mk("button", null, text); b.type = "button"; if (title) b.title = title; b.addEventListener("click", fn); return b; }
  const entryName = (slot0) => { const m = L.summary(slot0); return m ? m.name || "(unnamed)" : "(not read yet)"; };

  function renderSetlists() {
    setlistsEl.textContent = "";
    const lists = L.listSetlists();
    const head = mk("div", "gp150-live-row");
    head.appendChild(mk("strong", null, "Setlists"));
    const sel = mk("select"); sel.setAttribute("aria-label", "Setlist");
    sel.appendChild(new Option(lists.length ? "— choose —" : "none yet", ""));
    for (const l of lists) sel.appendChild(new Option(`${l.name} (${l.slots.length})`, String(l.id)));
    if (!lists.some((l) => l.id === currentList)) currentList = null;
    sel.value = currentList == null ? "" : String(currentList);
    sel.addEventListener("change", () => { currentList = sel.value ? Number(sel.value) : null; renderSetlists(); });
    head.appendChild(sel);
    head.appendChild(btn("New", "Create an empty setlist", async () => {
      const name = await window.UI.promptDialog("Name of the new setlist:", "", "Create");
      if (name && name.trim()) { currentList = L.createSetlist(name); }
    }));
    const cur = lists.find((l) => l.id === currentList);
    if (cur) {
      head.appendChild(btn("Rename", "", async () => { const n = await window.UI.promptDialog("New name:", cur.name, "Rename"); if (n && n.trim()) L.renameSetlist(cur.id, n); }));
      head.appendChild(btn("Delete", "", async () => { if (await window.UI.confirmDialog(`Delete the setlist “${cur.name}”? The presets stay.`, "Delete")) { L.deleteSetlist(cur.id); currentList = null; } }));
      const add = btn("Add shown", "Add every preset the list above currently shows, in slot order", () => { for (const m of shown) L.setlistAdd(cur.id, m.slot - 1); });
      head.appendChild(add);
      const go = btn("Stage mode", "A big view to step through the setlist; each step selects that preset on the pedal", () => { if (cur.slots.length) { stage = { index: 0 }; selectOnPedal(cur.slots[0]); renderSetlists(); } });
      go.disabled = !cur.slots.length;
      head.appendChild(go);
    }
    setlistsEl.appendChild(head);

    if (cur) {
      const ol = mk("ol", "gp150-lib-setlist");
      cur.slots.forEach((slot0, i) => {
        const li = mk("li", "gp150-lib-row");
        li.append(mk("span", "gp150-lib-slot", String(i + 1)), mk("span", "gp150-lib-slot", pad(slot0 + 1)), mk("span", "gp150-lib-name", entryName(slot0)));
        const tools = mk("span", "gp150-lib-chain");
        tools.append(
          btn("On pedal", "Select this preset on the pedal", () => selectOnPedal(slot0)),
          btn("▲", "Move up", () => L.setlistMove(cur.id, i, i - 1)),
          btn("▼", "Move down", () => L.setlistMove(cur.id, i, i + 1)),
          btn("✕", "Remove from the setlist", () => L.setlistRemove(cur.id, i)));
        li.appendChild(tools);
        ol.appendChild(li);
      });
      if (!cur.slots.length) ol.appendChild(mk("li", "subtitle", "Empty — use “Add to setlist…” in a preset's actions menu, or “Add shown”."));
      setlistsEl.appendChild(ol);
      if (stage) {
        if (stage.index >= cur.slots.length) stage.index = Math.max(0, cur.slots.length - 1);
        const slot0 = cur.slots[stage.index];
        const box = mk("div", "gp150-lib-stage");
        box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Stage mode");
        box.append(
          mk("div", "gp150-lib-stage-pos", `${cur.name} · ${stage.index + 1} / ${cur.slots.length}`),
          mk("div", "gp150-lib-stage-name", entryName(slot0)),
          mk("div", "gp150-lib-stage-slot", `Slot ${pad(slot0 + 1)}`));
        if (stage.index + 1 < cur.slots.length) box.appendChild(mk("div", "gp150-lib-stage-next", `Next: ${entryName(cur.slots[stage.index + 1])}`));
        const row = mk("div", "gp150-live-row");
        row.append(
          btn("◀ Previous", "", () => stageStep(-1)), btn("Next ▶", "", () => stageStep(1)),
          btn("Select again", "Send this preset to the pedal again", () => selectOnPedal(slot0)),
          btn("Close", "", () => { stage = null; renderSetlists(); }));
        box.appendChild(row);
        setlistsEl.appendChild(box);
      }
    }
  }
  function stageStep(d) {
    const cur = L.listSetlists().find((l) => l.id === currentList);
    if (!stage || !cur) return;
    const i = stage.index + d;
    if (i < 0 || i >= cur.slots.length) return;
    stage.index = i; selectOnPedal(cur.slots[i]); renderSetlists();
  }
  document.addEventListener("keydown", (e) => {
    if (!stage || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "")) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); stageStep(1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); stageStep(-1); }
    else if (e.key === "Escape") { stage = null; renderSetlists(); }
  });

  render();
})();
