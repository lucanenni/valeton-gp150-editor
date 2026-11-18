"use strict";
/*
 * GP-150 Library view (explorer page): the local copy of the 200 presets (gp150_library.js), searchable,
 * with a zip backup and a restore that writes a backup (zip or loose .prst files) back to the pedal.
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
  const panel = $("gp150-lib-restore"), panelList = $("gp150-lib-restore-list"), panelSummary = $("gp150-lib-restore-summary");
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
  function render() {
    const q = searchEl.value;
    shown = L.search(q, { onlyOn: onlyOnEl.checked });
    listEl.textContent = "";
    for (const s of shown) {
      const li = document.createElement("li");
      li.className = "gp150-lib-row";
      const slot = document.createElement("span"); slot.className = "gp150-lib-slot"; slot.textContent = pad(s.slot);
      const name = document.createElement("span"); name.className = "gp150-lib-name"; name.textContent = s.name || "(unnamed)";
      const chain = document.createElement("span"); chain.className = "gp150-lib-chain";
      for (const c of s.chain) {
        if (!c.on) continue;
        const chip = document.createElement("span");
        chip.className = "gp150-lib-chip"; chip.textContent = c.label; chip.title = c.mod;
        chain.appendChild(chip);
      }
      const open = document.createElement("button");
      open.type = "button"; open.textContent = "Open";
      open.title = "Show this preset in the inspector above";
      open.addEventListener("click", () => {
        const body = L.get(s.slot - 1);
        if (body && window.GP150UI) window.GP150UI.openBody(body, `library-slot${pad(s.slot)}.prst`);
      });
      li.append(slot, name, chain, open);
      listEl.appendChild(li);
    }
    const total = L.count();
    emptyEl.hidden = total > 0;
    emptyEl.textContent = "Nothing saved yet — connect to the pedal and its presets are read in the background.";
    backupAllBtn.disabled = total === 0;
    backupShownBtn.disabled = shown.length === 0;
    backupShownBtn.hidden = !searchEl.value.trim() && !onlyOnEl.checked;
    backupShownBtn.textContent = `Back up the ${shown.length} shown`;
    renderStatus();
  }

  function renderStatus() {
    const total = L.count();
    const s = U ? U.getStatus() : { state: "idle" };
    let t = `${total}/200 presets saved on this computer`;
    if (searchEl.value.trim() || onlyOnEl.checked) t += ` — ${shown.length} match`;
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

  function closePanel() { panel.hidden = true; pending = null; rowChecks.length = 0; panelList.textContent = ""; panelStatus.textContent = ""; }
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

  function selectedItems() { return pending ? pending.items.filter((_, i) => rowChecks[i] && rowChecks[i].checked) : []; }
  function updateGo() {
    const n = selectedItems().length;
    panelGo.textContent = `Write ${n} preset${n === 1 ? "" : "s"} to the pedal`;
    panelGo.disabled = n === 0;
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
    panel.hidden = false;
    updateGo();
  }

  panelGo.addEventListener("click", async () => {
    const items = selectedItems();
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

  render();
})();
