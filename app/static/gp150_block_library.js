"use strict";

// GP-150 block presets (EXP-9, 2026-09-23): save a single module's model,
// parameters, and on/off state on its own (LocalStorage), independent of
// any specific preset, so it can be applied to a different preset's same
// module later, or exported/imported as a shareable file. Deliberately
// self-contained and separate from gp150.js: only listens for the
// "gp150:patch-rendered" event gp150.js dispatches after decoding a patch
// (file upload OR live read) and reuses webmidi_gp150.js's existing write
// functions for "Apply to pedal" -- zero edits to gp150.js's own render or
// write logic beyond that one event dispatch, so this stays a clean,
// isolated diff for an eventual upstream PR (see BACKLOG_GP150.md's EXP-9 entry).
// GP-5/GP-50 have no equivalent here -- they'd go through PatchLib's own
// block records instead, a separate, not-yet-built feature (see EXP-9).
(() => {
  const root = document.getElementById("gp150-block-library");
  if (!root) return;

  const STORAGE_KEY = "gp150_block_library_v1";
  const listEl = root.querySelector("#gp150-block-list");
  const emptyEl = root.querySelector("#gp150-block-empty");
  const exportAllBtn = root.querySelector("#gp150-block-export-all-btn");
  const importBtn = root.querySelector("#gp150-block-import-btn");
  const importInput = root.querySelector("#gp150-block-import-input");
  const errEl = root.querySelector("#gp150-block-error");

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  // --- storage -------------------------------------------------------------
  // One JSON array in a single LocalStorage key -- plenty for a handful of
  // saved blocks, no indexing needed at this scale. Each block: {id, name,
  // module, fxid, model_name, enabled, params: [{algId, value}], savedAt}.
  function loadBlocks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveBlocks(blocks) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(blocks));
    } catch (e) {
      showError(`Couldn't save to LocalStorage: ${e.message}`);
    }
  }

  function makeId() {
    return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- rendering the saved-block list ---------------------------------------
  function render() {
    const blocks = loadBlocks();
    listEl.textContent = "";
    emptyEl.hidden = blocks.length > 0;
    for (const block of blocks) listEl.appendChild(renderBlockRow(block));
  }

  function renderBlockRow(block) {
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.className = "gp150-block-label";
    label.textContent = `${block.name} — ${block.module}: ${block.model_name || "— none —"}`;
    li.appendChild(label);

    const actions = document.createElement("span");
    actions.className = "gp150-block-actions";

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.textContent = "Apply to pedal";
    applyBtn.title = "Sends this block's model, params, and on/off state to the connected pedal's matching module";
    actions.appendChild(applyBtn);

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.textContent = "Export";
    exportBtn.addEventListener("click", () =>
      downloadJson(`${(block.name || block.module).replace(/[^\w.-]+/g, "_")}.gp150block.json`, {
        format: "gp150-block-library", version: 1, blocks: [block],
      })
    );
    actions.appendChild(exportBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "gp150-block-delete-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      saveBlocks(loadBlocks().filter((b) => b.id !== block.id));
      render();
    });
    actions.appendChild(delBtn);

    const status = document.createElement("span");
    status.className = "gp150-block-status";
    actions.appendChild(status);

    applyBtn.addEventListener("click", () => applyBlock(block, applyBtn, status));

    li.appendChild(actions);
    return li;
  }

  // --- applying a saved block to the live pedal -----------------------------
  // Targets whatever GP-150 is currently connected, by module name -- not
  // tied to any specific rendered patch card, since a saved block is a
  // standalone model+params+on/off triple. Reuses the exact write functions
  // gp150.js's own live-edit controls call (sendModelSwap/sendEnable/
  // sendSetParam), passing the block's own fxid to sendSetParam so each
  // param targets the block's model without needing a live re-read first
  // (the same override those controls already support for the swap+send
  // workflow) -- no new protocol, this just replays several confirmed-
  // working calls in sequence.
  async function applyBlock(block, btn, statusEl) {
    if (!window.WebMidiGP150) {
      showError("WebMIDI write support isn't loaded on this page.");
      return;
    }
    showError("");
    btn.disabled = true;
    statusEl.textContent = "Applying…";
    try {
      if (!window.WebMidiGP150.isConnected()) await window.WebMidiGP150.connect();
      let sent = 0;
      if (block.fxid != null) {
        window.WebMidiGP150.sendModelSwap(block.module, block.fxid);
        sent++;
      }
      window.WebMidiGP150.sendEnable(block.module, !!block.enabled);
      sent++;
      for (const p of block.params || []) {
        window.WebMidiGP150.sendSetParam(block.module, p.algId, p.value, { fxid: block.fxid });
        sent++;
      }
      statusEl.textContent = `Sent ${sent} message(s) — check the pedal's own display to confirm.`;
    } catch (e) {
      statusEl.textContent = "";
      showError(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // --- capturing a block from any rendered patch ----------------------------
  // Injects a "Save block" button at the end of each rendered module, using
  // the entry gp150.js already decoded -- no re-derivation from the DOM,
  // model/fxid/param data all come straight from its own decode pipeline.
  // Works for BOTH file uploads and live reads: saving is purely local (no
  // MIDI), so it doesn't need the live-connection restriction gp150.js's
  // own write controls have.
  document.addEventListener("gp150:patch-rendered", (e) => {
    const { entry, card } = e.detail || {};
    if (!card || !entry) return;
    const moduleEls = card.querySelectorAll(".gp150-module");
    // renderPatch() iterates entry.chain_order in the same order it builds
    // .gp150-module divs, so pairing by position is safe and avoids adding
    // a name-based DOM-lookup dependency on gp150.js's own class names.
    entry.chain_order.forEach((mod, i) => {
      const info = entry.modules[mod];
      const moduleEl = moduleEls[i];
      if (!info || !moduleEl || moduleEl.querySelector(".gp150-block-save-btn")) return;
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "gp150-block-save-btn";
      saveBtn.textContent = "💾 Save block";
      saveBtn.title = "Save this module's model, params, and on/off state to your block library";
      saveBtn.addEventListener("click", () => promptAndSaveBlock(mod, info));
      moduleEl.appendChild(saveBtn);
    });
  });

  function promptAndSaveBlock(mod, info) {
    const defaultName = info.model_name ? `${mod}: ${info.model_name}` : mod;
    const name = window.prompt("Name this block:", defaultName);
    if (!name) return; // cancelled or left empty
    const blocks = loadBlocks();
    blocks.push({
      id: makeId(),
      name,
      module: mod,
      fxid: info.fxid,
      model_name: info.model_name,
      enabled: info.enabled,
      params: info.params.map((p) => ({ algId: p.algId, value: p.value })),
      savedAt: new Date().toISOString(),
    });
    saveBlocks(blocks);
    render();
  }

  // --- export all / import --------------------------------------------------
  exportAllBtn.addEventListener("click", () => {
    downloadJson("gp150_block_library.json", {
      format: "gp150-block-library", version: 1, blocks: loadBlocks(),
    });
  });

  importBtn.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", () => {
    if (importInput.files.length) importFromFile(importInput.files[0]);
    importInput.value = "";
  });

  async function importFromFile(file) {
    showError("");
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      showError(`Not valid JSON: ${e.message}`);
      return;
    }
    const incoming = Array.isArray(data.blocks) ? data.blocks : Array.isArray(data) ? data : null;
    if (!incoming) {
      showError('Not a recognized block file — expected {"blocks": [...]}.');
      return;
    }
    // Re-validate and re-mint id/savedAt rather than trusting the file's own
    // -- this is user-supplied data, and a duplicate id from a re-imported
    // export shouldn't silently clobber an existing saved block.
    const valid = [];
    for (const b of incoming) {
      if (!b || typeof b.module !== "string" || !Array.isArray(b.params)) continue;
      valid.push({
        id: makeId(),
        name: typeof b.name === "string" && b.name ? b.name : b.module,
        module: b.module,
        fxid: typeof b.fxid === "number" ? b.fxid : null,
        model_name: typeof b.model_name === "string" ? b.model_name : null,
        enabled: !!b.enabled,
        params: b.params
          .filter((p) => p && typeof p.algId === "number" && typeof p.value === "number")
          .map((p) => ({ algId: p.algId, value: p.value })),
        savedAt: new Date().toISOString(),
      });
    }
    if (!valid.length) {
      showError("No valid blocks found in that file.");
      return;
    }
    const blocks = loadBlocks();
    blocks.push(...valid);
    saveBlocks(blocks);
    render();
  }

  render();
})();
