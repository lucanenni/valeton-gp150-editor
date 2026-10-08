"use strict";

// GP-150 Preset Inspector (beta) — decodes .prst file(s)/live reads and
// renders the patch name, chain order, and every module's real model +
// parameters. Fully client-side (PLAT-2, 2026-09-18): window.GP150Format
// (a port of patch/gp150_format.py) decodes the raw bytes, and this file
// resolves each module's fxid against the bundled fxid_ring_gp150.json —
// the same two steps app_device.py's gp150_inspect()/_gp150_model_entry()
// do server-side, just run in the browser now. No backend call for
// inspecting a GP-150 file anymore. The GP-50/GP-5 -> GP-150 converter
// (formerly section 5 here) now lives on the Preset Converter page
// (gp150_converter_ui.js, GP150-8) -- see PLAT-2 in BACKLOG_GP150.md for its
// own client-side port history.
(() => {
  const drop = document.getElementById("gp150-drop");
  const input = document.getElementById("gp150-input");
  const pickBtn = document.getElementById("gp150-pick-btn");
  const errEl = document.getElementById("gp150-error");
  const resultsEl = document.getElementById("gp150-results");
  const tmpl = document.getElementById("gp150-patch-template");

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  // Resolve the data dir relative to THIS script's own URL, so it works
  // whether it's served at /static/gp150.js (backend) or ./gp150.js (a
  // static host mounted at root) — same trick as static_api.js's DATA_BASE.
  const DATA_BASE = (() => {
    try { const s = document.currentScript && document.currentScript.src; if (s) return new URL("data/", s).href; } catch { /* fall through */ }
    return "/static/data/";
  })();
  const dataUrl = (f) => new URL(f, DATA_BASE).href;

  // Fetched once and cached — fxid -> catalog entry, keyed by string (JSON
  // object keys are always strings; matches _gp150_ring()'s int-keyed dict
  // on the Python side, just addressed with String(fxid) here instead).
  let gp150RingPromise = null;
  function getGp150Ring() {
    if (!gp150RingPromise) {
      gp150RingPromise = fetch(dataUrl("fxid_ring_gp150.json")).then((r) => r.json());
    }
    return gp150RingPromise;
  }

  // FXID_NONE is a real ID collision, not always "nothing selected": VOL's
  // catalog has exactly one model ("Volume"), and it happens to share
  // FXID_NONE's numeric id — see _gp150_model_entry()'s own Python
  // docstring (app/api_device.py) for the full explanation this mirrors.
  function gp150ModelEntry(ring, fxid, module) {
    if (fxid === window.GP150Format.FXID_NONE && module !== "VOL") return null;
    return ring[String(fxid)] || null;
  }

  // Decode one GP-150 .prst's bytes into the exact shape renderPatch()/
  // renderModule() below already expect (snake_case keys included) — this
  // used to be gp150_inspect()'s response body, now built in the browser.
  function decodeGp150(bytes, ring) {
    const patch = window.GP150Format.decode(bytes);
    const modules = {};
    for (const [mod, fxid] of Object.entries(patch.moduleModels)) {
      const entry = gp150ModelEntry(ring, fxid, mod);
      const params = [];
      if (entry) {
        for (const p of entry.params || []) {
          if ((p.algId ?? -1) < 0) continue;
          params.push({
            name: p.name,
            algId: p.algId,
            value: window.GP150Format.readModuleParamByAlgId(bytes, mod, p.algId),
            min: p.min,
            max: p.max,
            unit: p.unit || "",
            toggle: !!p.toggle,
            // widgetType 2 = a named-option enum (Suite's own module150_data.json,
            // e.g. CAB "Precision": 0="Regular", 1="High") -- `options[value]` is
            // the label. Empty when this param isn't a clean, fully-labeled enum.
            options: p.options || [],
          });
        }
      }
      modules[mod] = {
        fxid,
        model_name: entry ? (entry.name || entry.fxtitle) : null,
        origin: entry ? entry.origin : null,
        enabled: patch.moduleEnabled[mod],
        params,
      };
    }
    return {
      slot_index: patch.slotIndex, patch_name: patch.name, chain_order: patch.chainOrder, modules,
      // GP150-10: patch-level settings, plus the raw body itself so live-edit
      // controls can patch a field with GP150Format.writeXxx() and hand the
      // result straight to WebMidiGP150.sendXxx() -- see renderPatchSettings().
      patch_settings: {
        presetBpm: patch.presetBpm, patchVolume: patch.patchVolume, presetNam: patch.presetNam,
        quickKnobs: patch.quickKnobs, expCtrlBlocks: patch.expCtrlBlocks, fsSettings: patch.fsSettings,
      },
      raw_body: bytes,
    };
  }

  // Fetched once and cached (module -> whole 12-module catalog, not
  // per-module — the ring never changes at runtime). Powers the
  // model-swap dropdown below. Was GET /api/device/gp150/models; now built
  // client-side from the same bundled ring decodeGp150() uses.
  let modelsCatalogPromise = null;
  function getModelsCatalog() {
    if (!modelsCatalogPromise) {
      modelsCatalogPromise = getGp150Ring().then((ring) => {
        const byModule = {};
        for (const [fxidStr, entry] of Object.entries(ring)) {
          const fxid = Number(fxidStr);
          let module = entry.module;
          // This project's "NS" module draws its models exclusively from
          // the ring's "N->S"-keyed SnapTone catalog — normalize the key
          // so the frontend looks this up the same way as every other
          // module (mirrors gp150_models()'s own normalization).
          if (module === "N->S") module = "NS";
          if (!module) continue;
          if (fxid === window.GP150Format.FXID_NONE && module !== "VOL") continue;
          (byModule[module] ||= []).push({ fxid, name: entry.name || entry.fxtitle || "", origin: entry.origin || "" });
        }
        // Plain codepoint comparison, not localeCompare — matches Python's
        // sorted(key=...) (plain string ordering, not locale-collated),
        // which is what gp150_models() sorted this catalog with.
        for (const list of Object.values(byModule)) list.sort((a, z) => (a.name < z.name ? -1 : a.name > z.name ? 1 : 0));
        return byModule;
      });
    }
    return modelsCatalogPromise;
  }

  function fmtValue(p) {
    if (p.toggle) {
      // stored value is somewhere in [min,max]; not confirmed which raw
      // value means which state, so just split the range in half
      const mid = ((p.min ?? 0) + (p.max ?? 100)) / 2;
      return p.value >= mid ? "On" : "Off";
    }
    if (p.options && p.options.length) {
      const idx = Math.round(p.value) - Math.round(p.min ?? 0);
      return p.options[idx] || String(p.value);
    }
    const v = Number.isInteger(p.value) ? p.value : p.value.toFixed(2);
    return p.unit ? `${v}${p.unit}` : `${v}`;
  }

  // Shows a one-line "sent / error" status under a module's controls after
  // a live write attempt — same convention as wireReorder()'s status line:
  // no ack exists to check, this only confirms bytes were handed to
  // WebMIDI, not that the pedal did anything with them.
  function showWriteStatus(statusEl, sentBytesOrError) {
    if (sentBytesOrError instanceof Error) {
      statusEl.textContent = sentBytesOrError.message;
      statusEl.classList.add("gp150-write-status-error");
    } else {
      statusEl.textContent = `Sent (${sentBytesOrError.length} bytes) — check the pedal's own display to confirm.`;
      statusEl.classList.remove("gp150-write-status-error");
    }
  }

  function renderModule(mod, info, { liveWrite = false, modelsCatalog = null } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "gp150-module";
    if (!info.enabled) wrap.classList.add("gp150-module-off");

    const head = document.createElement("div");
    head.className = "gp150-module-head";

    const left = document.createElement("span");
    left.className = "gp150-module-head-left";
    const modName = document.createElement("span");
    modName.className = "gp150-module-tag";
    modName.textContent = mod;
    left.appendChild(modName);

    let writeStatusEl = null; // created below, used by both the enable toggle and param sends
    if (liveWrite && window.WebMidiGP150) {
      const stateBtn = document.createElement("button");
      stateBtn.type = "button";
      stateBtn.className = "gp150-module-state " + (info.enabled ? "on" : "off");
      stateBtn.textContent = info.enabled ? "on" : "off";
      stateBtn.title = "Confirmed working live (2026-09-20) — see design/GP150_SUPPORT.md §3.1";
      stateBtn.addEventListener("click", async () => {
        stateBtn.disabled = true;
        try {
          if (!window.WebMidiGP150.isConnected()) await window.WebMidiGP150.connect();
          const sent = window.WebMidiGP150.sendEnable(mod, !info.enabled);
          showWriteStatus(writeStatusEl, sent);
        } catch (e) {
          showWriteStatus(writeStatusEl, e);
        } finally {
          stateBtn.disabled = false;
        }
      });
      left.appendChild(stateBtn);
    } else {
      const state = document.createElement("span");
      state.className = "gp150-module-state " + (info.enabled ? "on" : "off");
      state.textContent = info.enabled ? "on" : "off";
      left.appendChild(state);
    }
    head.appendChild(left);

    if (liveWrite && window.WebMidiGP150 && modelsCatalog && modelsCatalog[mod]) {
      head.appendChild(renderModelSwapControl(mod, info, modelsCatalog[mod], () => writeStatusEl));
    } else {
      const model = document.createElement("span");
      model.className = "gp150-model-name";
      if (info.model_name) {
        model.textContent = info.origin ? `${info.model_name} (${info.origin})` : info.model_name;
      } else {
        model.textContent = "— none —";
        model.classList.add("gp150-model-none");
      }
      head.appendChild(model);
    }
    wrap.appendChild(head);

    if (info.params.length) {
      const list = document.createElement("ul");
      list.className = "gp150-param-list";
      for (const p of info.params) {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = p.name;
        li.appendChild(name);

        if (liveWrite && window.WebMidiGP150 && p.algId != null) {
          li.appendChild(renderWritableParamControl(mod, p, info.fxid, () => writeStatusEl));
        } else {
          const val = document.createElement("span");
          val.className = "gp150-param-value";
          val.textContent = fmtValue(p);
          li.appendChild(val);
        }
        list.appendChild(li);
      }
      wrap.appendChild(list);
    }

    if (liveWrite && window.WebMidiGP150) {
      writeStatusEl = document.createElement("div");
      writeStatusEl.className = "subtitle gp150-write-status";
      wrap.appendChild(writeStatusEl);
    }
    return wrap;
  }

  // A module's live model-swap control: a <select> of every catalog model
  // for this module (from GET /api/device/gp150/models) plus a "Swap"
  // button, replacing the plain model-name span. Sending targets whatever
  // is currently selected, regardless of whether it differs from the
  // module's current model — same click-to-send discipline as the other
  // controls, no auto-send on selection change. `getStatusEl` is a thunk
  // for the same reason as renderWritableParamControl()'s.
  function renderModelSwapControl(mod, info, models, getStatusEl) {
    const wrap = document.createElement("span");
    wrap.className = "gp150-param-control gp150-model-swap";

    const select = document.createElement("select");
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = String(m.fxid);
      opt.textContent = m.origin ? `${m.name} (${m.origin})` : m.name;
      if (m.fxid === info.fxid) opt.selected = true;
      select.appendChild(opt);
    }
    if (!models.some((m) => m.fxid === info.fxid)) {
      // Current model isn't in the swap catalog (e.g. "— none —") --
      // show it as a synthetic, unselectable heads-up rather than
      // silently pre-selecting the wrong option.
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = info.model_name ? `(current: ${info.model_name})` : "(none)";
      opt.selected = true;
      opt.disabled = true;
      select.insertBefore(opt, select.firstChild);
    }

    const swapBtn = document.createElement("button");
    swapBtn.type = "button";
    swapBtn.textContent = "Swap";
    swapBtn.title = "Confirmed working live (2026-09-20) — see design/GP150_SUPPORT.md §3.1";
    swapBtn.addEventListener("click", async () => {
      const statusEl = getStatusEl();
      const fxid = parseInt(select.value, 10);
      if (!Number.isInteger(fxid)) return;
      swapBtn.disabled = true;
      try {
        if (!window.WebMidiGP150.isConnected()) await window.WebMidiGP150.connect();
        const sent = window.WebMidiGP150.sendModelSwap(mod, fxid);
        if (statusEl) showWriteStatus(statusEl, sent);
      } catch (e) {
        if (statusEl) showWriteStatus(statusEl, e);
      } finally {
        swapBtn.disabled = false;
      }
    });

    wrap.appendChild(select);
    wrap.appendChild(swapBtn);
    return wrap;
  }

  // A single param's live control: a checkbox for toggle params (best
  // current guess — value >= (min+max)/2 reads as "On", same assumption
  // fmtValue() already makes, still unconfirmed which raw value means
  // which state), or a range slider + explicit "Send" button for
  // everything else (send-on-click, not on every drag tick, to avoid
  // flooding the device with an unconfirmed write). `getStatusEl` is a
  // thunk because the status element is created AFTER the param list in
  // renderModule() — resolved lazily at send time, not at render time.
  function renderWritableParamControl(mod, p, fxid, getStatusEl) {
    const wrap = document.createElement("span");
    wrap.className = "gp150-param-control";

    async function send(value) {
      const statusEl = getStatusEl();
      try {
        if (!window.WebMidiGP150.isConnected()) await window.WebMidiGP150.connect();
        const sent = window.WebMidiGP150.sendSetParam(mod, p.algId, value, { fxid });
        if (statusEl) showWriteStatus(statusEl, sent);
      } catch (e) {
        if (statusEl) showWriteStatus(statusEl, e);
      }
    }

    if (p.toggle) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      const mid = ((p.min ?? 0) + (p.max ?? 100)) / 2;
      cb.checked = p.value >= mid;
      cb.addEventListener("change", () => send(cb.checked ? (p.max ?? 100) : (p.min ?? 0)));
      wrap.appendChild(cb);
      return wrap;
    }

    // Named-option enum (widgetType 2 in Suite's own data, e.g. CAB
    // "Precision": 0="Regular", 1="High") -- a labeled <select> instead of
    // a bare numeric slider, same click-to-send discipline as the slider
    // below (send() only fires on an explicit click, not on selection).
    if (p.options && p.options.length) {
      const select = document.createElement("select");
      p.options.forEach((label, i) => {
        const opt = document.createElement("option");
        opt.value = String((p.min ?? 0) + i);
        opt.textContent = label;
        select.appendChild(opt);
      });
      select.value = String(Math.round(p.value));
      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.className = "gp150-param-send-btn";
      sendBtn.textContent = "Send";
      sendBtn.addEventListener("click", () => send(parseFloat(select.value)));
      wrap.appendChild(select);
      wrap.appendChild(sendBtn);
      return wrap;
    }

    const valueLabel = document.createElement("span");
    valueLabel.className = "gp150-param-value";
    valueLabel.textContent = fmtValue(p);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = p.min ?? 0;
    slider.max = p.max ?? 100;
    slider.step = Number.isInteger(p.value) ? 1 : 0.01;
    slider.value = p.value;
    slider.addEventListener("input", () => {
      valueLabel.textContent = p.unit ? `${slider.value}${p.unit}` : slider.value;
    });

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "gp150-param-send-btn";
    sendBtn.textContent = "Send";
    sendBtn.title = "Confirmed working live (2026-09-20) — see design/GP150_SUPPORT.md §3.1";
    sendBtn.addEventListener("click", () => send(parseFloat(slider.value)));

    wrap.appendChild(slider);
    wrap.appendChild(valueLabel);
    wrap.appendChild(sendBtn);
    return wrap;
  }

  // Wires up the drag-to-reorder chain list + "Send reorder to pedal"
  // button inside a rendered patch card. Only called for LIVE-read
  // patches (see renderPatch's `liveWrite` option) — reordering an
  // uploaded file's chain and sending it live would silently reorder
  // whatever patch is CURRENTLY ACTIVE on the device, not the uploaded
  // file's own slot, which would be confusing/unsafe; restricting this
  // to patches that just came off the live device keeps "what you see is
  // what you're about to send" true.
  function wireReorder(root, initialOrder) {
    const wrap = root.querySelector(".gp150-reorder");
    const list = root.querySelector(".gp150-reorder-list");
    const sendBtn = root.querySelector(".gp150-send-reorder-btn");
    const statusEl = root.querySelector(".gp150-reorder-status");
    const errEl = root.querySelector(".gp150-reorder-error");
    if (!wrap || !window.WebMidiGP150) return;
    wrap.hidden = false;

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    let order = initialOrder.slice();
    let dragFrom = null;

    function renderList() {
      list.textContent = "";
      order.forEach((mod, i) => {
        const li = document.createElement("li");
        li.textContent = mod;
        li.draggable = true;
        li.dataset.index = String(i);
        li.addEventListener("dragstart", (e) => {
          dragFrom = i;
          li.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
        });
        li.addEventListener("dragend", () => li.classList.remove("dragging"));
        li.addEventListener("dragover", (e) => {
          e.preventDefault();
          li.classList.add("drag-over");
        });
        li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
        li.addEventListener("drop", (e) => {
          e.preventDefault();
          li.classList.remove("drag-over");
          if (dragFrom === null || dragFrom === i) return;
          const [moved] = order.splice(dragFrom, 1);
          order.splice(i, 0, moved);
          dragFrom = null;
          renderList();
        });
        list.appendChild(li);
      });
    }
    renderList();

    sendBtn.addEventListener("click", async () => {
      showError("");
      sendBtn.disabled = true;
      statusEl.textContent = "Sending…";
      try {
        if (!window.WebMidiGP150.isConnected()) await window.WebMidiGP150.connect();
        const sent = window.WebMidiGP150.sendReorder(order);
        const hex = sent.map((b) => b.toString(16).padStart(2, "0")).join(" ");
        statusEl.textContent = `Sent (${sent.length} bytes) — check the pedal's own display to confirm.`;
        statusEl.title = hex;
      } catch (e) {
        showError(e.message);
        statusEl.textContent = "";
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  // Wires up the "Save to pedal" slot/name inputs + button inside a
  // rendered patch card. Only called for LIVE-read patches (same
  // rationale as wireReorder() above): save persists whatever is
  // CURRENTLY ACTIVE on the device, not an uploaded file's own content,
  // so this only makes sense right after a live read.
  function wireSave(root, entry) {
    const wrap = root.querySelector(".gp150-save");
    const slotInput = root.querySelector(".gp150-save-slot");
    const nameInput = root.querySelector(".gp150-save-name");
    const saveBtn = root.querySelector(".gp150-save-btn");
    const statusEl = root.querySelector(".gp150-save-status");
    const errEl = root.querySelector(".gp150-save-error");
    if (!wrap || !window.WebMidiGP150) return;
    wrap.hidden = false;

    slotInput.value = entry.slot_index + 1; // 1-based in the UI, like the slot reader above
    nameInput.value = entry.patch_name || "";

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    saveBtn.addEventListener("click", async () => {
      showError("");
      const slot1based = parseInt(slotInput.value, 10);
      if (!(slot1based >= 1 && slot1based <= 200)) {
        showError(`slot must be 1-200, got ${slotInput.value}`);
        return;
      }
      const name = nameInput.value;
      saveBtn.disabled = true;
      statusEl.textContent = "Saving…";
      try {
        if (!window.WebMidiGP150.isConnected()) await window.WebMidiGP150.connect();
        const sent = window.WebMidiGP150.sendSave(slot1based - 1, name);
        const hex = sent.map((b) => b.toString(16).padStart(2, "0")).join(" ");
        statusEl.textContent = `Sent (${sent.length} bytes) — check the pedal's own display / re-read this slot to confirm.`;
        statusEl.title = hex;
      } catch (e) {
        showError(e.message);
        statusEl.textContent = "";
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // GP150-13 (2026-09-27): write this EXACT patch body (unchanged, own
  // checksum intact) to any slot, non-disruptively -- no select, no
  // activation. Available for BOTH file uploads and live reads (unlike
  // wireReorder()/wireSave() above, which are live-read-only because they
  // send diffs against whatever's currently active on the pedal) --
  // entry.rawBytes is a complete, standalone body either way. Only works
  // for a file that's already valid (a real capture/export); writing
  // freshly-synthesized content (e.g. straight from the GP-50->GP-150
  // converter) is untested -- that content's own 0x0E-0x0F checksum has
  // never been confirmed correct outside of going through Suite first.
  function wireWritePreset(root, entry) {
    const wrap = root.querySelector(".gp150-write-preset");
    const slotInput = root.querySelector(".gp150-write-preset-slot");
    const writeBtn = root.querySelector(".gp150-write-preset-btn");
    const statusEl = root.querySelector(".gp150-write-preset-status");
    const errEl = root.querySelector(".gp150-write-preset-error");
    if (!wrap || !window.WebMidiGP150 || !entry.rawBytes) return;
    wrap.hidden = false;

    slotInput.value = entry.slot_index + 1; // 1-based in the UI, like Save above

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    // Post-write verification settle: the write itself is fire-and-forget
    // (confirmed live 2026-09-27/29 that Suite's own real import sends all
    // 10 chunks back-to-back with no ack either, so that's not a gap to
    // fix), but the device needs real time to actually commit a full
    // 1128-byte write to storage before it'll answer a fresh catalog read
    // with the new content -- confirmed live 2026-09-29: a first attempt
    // at 500ms got a truncated/wrong-length reply (readAllNames() timed
    // out), even though the write itself had genuinely succeeded (a
    // standalone readAllNames() call a few seconds later showed the
    // correct new name) -- this is a verification-timing issue, not a
    // write reliability issue. One retry after a longer wait fixes it.
    const WRITE_VERIFY_SETTLE_MS = 1500;
    const WRITE_VERIFY_RETRY_SETTLE_MS = 3000;

    async function readBackName(slot0based) {
      const names = await window.WebMidiGP150.readAllNames();
      const found = names.find((n) => n.index === slot0based);
      return (found ? found.name : "").trim();
    }

    writeBtn.addEventListener("click", async () => {
      showError("");
      const slot1based = parseInt(slotInput.value, 10);
      if (!(slot1based >= 1 && slot1based <= 200)) {
        showError(`slot must be 1-200, got ${slotInput.value}`);
        return;
      }
      const slot0based = slot1based - 1;
      const expectedName = (entry.patch_name || "").trim();
      writeBtn.disabled = true;
      statusEl.textContent = "Writing…";
      try {
        if (!window.WebMidiGP150.isConnected()) await window.WebMidiGP150.connect();
        const chunks = window.WebMidiGP150.sendWritePreset(entry.rawBytes, slot0based);
        statusEl.textContent = `Sent ${chunks.length} chunks — verifying…`;

        await new Promise((res) => setTimeout(res, WRITE_VERIFY_SETTLE_MS));
        let actualName;
        try {
          actualName = await readBackName(slot0based);
        } catch {
          // First attempt can catch the device still mid-commit (a
          // truncated/short reply, not a real failure) -- one longer-wait
          // retry before treating this as inconclusive.
          statusEl.textContent = `Sent ${chunks.length} chunks — verifying (retry)…`;
          await new Promise((res) => setTimeout(res, WRITE_VERIFY_RETRY_SETTLE_MS));
          actualName = await readBackName(slot0based);
        }
        if (actualName === expectedName) {
          // keep the "used by" cache in step with what we just wrote
          if (window.GP150Usage) { const w = new Uint8Array(entry.rawBytes); w[4] = slot0based; window.GP150Usage.applyBody(w); }
          statusEl.textContent = `✓ Verified — slot ${slot1based} now reads "${actualName}".`;
        } else {
          showError(`Wrote OK, but slot ${slot1based} reads "${actualName}" instead of "${expectedName}" — the write may not have taken effect. Check the pedal directly before trusting this slot.`);
          statusEl.textContent = "";
        }
      } catch (e) {
        showError(e.message);
        statusEl.textContent = "";
      } finally {
        writeBtn.disabled = false;
      }
    });
  }

  // --- GP150-10: Patch Settings (BPM, Patch Volume, NAM mode, Quick Knobs,
  // EXP/CTRL, footswitches) -- decode side fully confirmed live; write side
  // (webmidi_gp150.js's sendPresetInfo/sendQuickKnobs/sendExpCtrl/
  // sendFsSettings) confirmed byte-for-byte against real captures for 3 of
  // the 4 struct types, structurally confirmed (chunk framing matches a
  // real 2-chunk capture exactly) for the 4th (ExpCtrl). See BACKLOG_GP150.md's
  // GP150-10 entry. Every send here is a FULL-STATE write of its struct
  // (all 3 Quick Knobs / all 9 EXP-CTRL slots / all 9 footswitches
  // together), matching the real Suite/pedal's own confirmed behavior --
  // not a per-field delta.

  // A module+param picker for one Quick Knob/EXP-CTRL slot: two <select>s
  // (target, then that target's own params) sharing the same flat catalog
  // targetId scheme GP150Format.targetLabel() resolves. Only offers
  // "Patch Volume" (targetId 12, algId 0 -- confirmed live as a real
  // target, though this exact algId wasn't independently re-verified) and
  // modules that currently have a resolved model with params -- assigning
  // to an unknown/no-model module has no confirmed algId catalog to pick
  // from. Falls back to a synthetic disabled "(current: ...)" option when
  // the slot's existing target/param isn't in that list (unassigned, an
  // unconfirmed global target, or a module whose model changed since the
  // assignment was made) -- same idiom renderModelSwapControl() uses for
  // its own "current model isn't in the swap catalog" case.
  // `onParamChange(paramOrNull)` (optional) fires whenever the resolved
  // param changes (target select, param select, or the initial render) --
  // gives the caller the full param definition (min/max/options), not
  // just the algId, so e.g. renderPatchSettings()'s EXP/CTRL rows can
  // swap in a labeled <select> for an enum param's range instead of bare
  // number inputs.
  function renderTargetParamPicker(entry, current, onParamChange) {
    const wrap = document.createElement("span");
    wrap.className = "gp150-target-picker";
    const targetSel = document.createElement("select");
    const paramSel = document.createElement("select");

    const NONE_OPT = { targetId: -1, algId: -1, label: "— none —" };
    const PATCH_VOL_OPT = { targetId: 12, algId: 0, label: "Patch Volume" };
    const targets = [NONE_OPT, PATCH_VOL_OPT];
    for (const mod of entry.chain_order) {
      if ((entry.modules[mod].params || []).length) targets.push({ targetId: window.GP150Format.MODULE_NAMES.indexOf(mod), module: mod, label: mod });
    }

    function paramsFor(t) {
      if (t.targetId === -1) return [{ algId: -1, name: "—", min: 0, max: 0, options: [] }];
      if (t.targetId === 12) return [{ algId: 0, name: "Volume", min: 0, max: 100, options: [] }];
      return entry.modules[t.module].params.map((p) => ({ algId: p.algId, name: p.name, min: p.min, max: p.max, options: p.options || [] }));
    }

    let matched = false;
    for (const t of targets) {
      const opt = document.createElement("option");
      opt.value = String(t.targetId);
      opt.textContent = t.label;
      if (t.targetId === current.targetId) { opt.selected = true; matched = true; }
      targetSel.appendChild(opt);
    }
    if (!matched) {
      const opt = document.createElement("option");
      opt.value = String(current.targetId);
      opt.textContent = `(current: ${window.GP150Format.targetLabel(current.targetId) || "unassigned"})`;
      opt.disabled = true;
      opt.selected = true;
      targetSel.insertBefore(opt, targetSel.firstChild);
    }

    let currentList = [];
    function fillParams() {
      paramSel.textContent = "";
      const t = targets.find((x) => String(x.targetId) === targetSel.value);
      currentList = t ? paramsFor(t) : [{ algId: current.algId, name: `algId ${current.algId}`, min: 0, max: 0, options: [] }];
      let paramMatched = false;
      for (const p of currentList) {
        const opt = document.createElement("option");
        opt.value = String(p.algId);
        opt.textContent = p.name;
        if (matched && t && t.targetId === current.targetId && p.algId === current.algId) { opt.selected = true; paramMatched = true; }
        paramSel.appendChild(opt);
      }
      if (!paramMatched && matched && t && t.targetId === current.targetId) {
        const opt = document.createElement("option");
        opt.value = String(current.algId);
        opt.textContent = `(current: algId ${current.algId})`;
        opt.disabled = true;
        opt.selected = true;
        paramSel.insertBefore(opt, paramSel.firstChild);
      }
      // "— none —" selected: nothing to pick a param/range for, so hide the
      // rest of the row instead of showing a meaningless single "—" option.
      const isNone = t && t.targetId === -1;
      paramSel.hidden = isNone;
      if (onParamChange) onParamChange(isNone ? null : currentList.find((p) => String(p.algId) === paramSel.value) || null);
    }
    targetSel.addEventListener("change", fillParams);
    paramSel.addEventListener("change", () => {
      if (onParamChange) onParamChange(currentList.find((p) => String(p.algId) === paramSel.value) || null);
    });
    fillParams();

    wrap.appendChild(targetSel);
    wrap.appendChild(paramSel);
    return {
      el: wrap,
      getValue: () => ({ targetId: parseInt(targetSel.value, 10), algId: parseInt(paramSel.value, 10) }),
    };
  }

  function renderPatchSettings(entry, { liveWrite = false } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "gp150-patch-settings-inner";
    const s = entry.patch_settings;
    // A live-edit session's own working copy -- every control below patches
    // THIS shared buffer (GP150Format.writeXxx() mutates in place) so
    // edits to different fields compose, and a "Send" click always ships
    // the buffer's current state, not a stale re-read of entry.raw_body.
    const workingBody = liveWrite && entry.raw_body ? new Uint8Array(entry.raw_body) : null;

    const statusEl = document.createElement("div");
    statusEl.className = "subtitle gp150-write-status";

    function fieldRow(label, valueNode, sendBtn) {
      const row = document.createElement("div");
      row.className = "gp150-settings-row";
      const lab = document.createElement("span");
      lab.className = "gp150-settings-label";
      lab.textContent = label;
      row.appendChild(lab);
      row.appendChild(valueNode);
      if (sendBtn) row.appendChild(sendBtn);
      return row;
    }

    function sendBtnFor(onClick) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Send";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          if (!window.WebMidiGP150.isConnected()) await window.WebMidiGP150.connect();
          const sent = onClick(); // array of chunk byte-arrays (usually 1, 2 for ExpCtrl)
          showWriteStatus(statusEl, sent.flat());
        } catch (e) {
          showWriteStatus(statusEl, e);
        } finally {
          btn.disabled = false;
        }
      });
      return btn;
    }

    // BPM
    {
      let valueNode, sendBtn = null;
      if (liveWrite && window.WebMidiGP150) {
        const input = document.createElement("input");
        input.type = "number"; input.min = "30"; input.max = "300"; input.value = s.presetBpm;
        valueNode = input;
        sendBtn = sendBtnFor(() => {
          window.GP150Format.writePresetBpm(workingBody, parseInt(input.value, 10));
          return window.WebMidiGP150.sendPresetInfo(workingBody);
        });
      } else {
        valueNode = document.createElement("span");
        valueNode.textContent = String(s.presetBpm);
      }
      wrap.appendChild(fieldRow("BPM", valueNode, sendBtn));
    }

    // Patch Volume
    {
      let valueNode, sendBtn = null;
      if (liveWrite && window.WebMidiGP150) {
        const input = document.createElement("input");
        input.type = "number"; input.min = "0"; input.max = "100"; input.value = s.patchVolume;
        valueNode = input;
        sendBtn = sendBtnFor(() => {
          window.GP150Format.writePatchVolume(workingBody, parseInt(input.value, 10));
          return window.WebMidiGP150.sendPresetInfo(workingBody);
        });
      } else {
        valueNode = document.createElement("span");
        valueNode.textContent = String(s.patchVolume);
      }
      wrap.appendChild(fieldRow("Patch Volume", valueNode, sendBtn));
    }

    // N->S / NAM switch (confirmed live 2026-09-23: unchecked shows "N→S"
    // on the pedal's own display, checked shows "NAM" -- and then the
    // actual loaded NAM profile name, e.g. "A2 Lite", which this project
    // doesn't decode and isn't shown here).
    {
      let valueNode, sendBtn = null;
      if (liveWrite && window.WebMidiGP150) {
        const cbWrap = document.createElement("span");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = s.presetNam;
        const cbLabel = document.createElement("span");
        cbLabel.className = "gp150-param-value";
        cbLabel.textContent = cb.checked ? "NAM" : "N→S";
        cb.addEventListener("change", () => { cbLabel.textContent = cb.checked ? "NAM" : "N→S"; });
        cbWrap.appendChild(cb);
        cbWrap.appendChild(cbLabel);
        valueNode = cbWrap;
        sendBtn = sendBtnFor(() => {
          window.GP150Format.writePresetNam(workingBody, cb.checked);
          return window.WebMidiGP150.sendPresetInfo(workingBody);
        });
      } else {
        valueNode = document.createElement("span");
        valueNode.textContent = s.presetNam ? "NAM" : "N→S";
      }
      wrap.appendChild(fieldRow("Mode", valueNode, sendBtn));
    }

    // Quick Knobs (3 slots, one full-state send)
    {
      const list = document.createElement("ul");
      list.className = "gp150-settings-list";
      const pickers = [];
      s.quickKnobs.forEach((qk, i) => {
        const li = document.createElement("li");
        const lab = document.createElement("span");
        lab.textContent = `Knob ${i + 1}`;
        li.appendChild(lab);
        if (liveWrite && window.WebMidiGP150) {
          const picker = renderTargetParamPicker(entry, qk);
          pickers.push(picker);
          li.appendChild(picker.el);
        } else {
          const val = document.createElement("span");
          val.textContent = qk.targetId < 0 ? "— none —" : `${qk.targetLabel || qk.targetId} (algId ${qk.algId})`;
          li.appendChild(val);
        }
        list.appendChild(li);
      });
      wrap.appendChild(list);
      if (liveWrite && window.WebMidiGP150) {
        const btn = sendBtnFor(() => {
          pickers.forEach((p, i) => window.GP150Format.writeQuickKnob(workingBody, i, p.getValue()));
          return window.WebMidiGP150.sendQuickKnobs(workingBody);
        });
        btn.textContent = "Send Quick Knobs";
        wrap.appendChild(btn);
      }
    }

    // A range control that's either 2 number inputs (continuous params) or
    // 2 labeled <select>s (enum params, e.g. CAB "Precision": Regular/High)
    // -- swaps shape live via setParam() as the target/param picker above
    // it changes, driven by renderTargetParamPicker()'s onParamChange.
    function createRangeControl(initialMin, initialMax) {
      const wrap = document.createElement("span");
      wrap.className = "gp150-range-control";
      let minEl, maxEl;
      function renderNumber(minVal, maxVal) {
        wrap.textContent = "";
        minEl = document.createElement("input");
        minEl.type = "number"; minEl.step = "0.01"; minEl.className = "gp150-range-input"; minEl.value = minVal;
        maxEl = document.createElement("input");
        maxEl.type = "number"; maxEl.step = "0.01"; maxEl.className = "gp150-range-input"; maxEl.value = maxVal;
        wrap.appendChild(minEl);
        wrap.appendChild(maxEl);
      }
      function renderEnum(options, base, minVal, maxVal) {
        wrap.textContent = "";
        [minEl, maxEl] = [document.createElement("select"), document.createElement("select")];
        for (const sel of [minEl, maxEl]) {
          options.forEach((label, i) => {
            const opt = document.createElement("option");
            opt.value = String(base + i);
            opt.textContent = label;
            sel.appendChild(opt);
          });
        }
        minEl.value = String(Math.round(minVal));
        maxEl.value = String(Math.round(maxVal));
        wrap.appendChild(minEl);
        wrap.appendChild(maxEl);
      }
      renderNumber(initialMin, initialMax);
      return {
        el: wrap,
        setParam(p) {
          // p === null means the picker's target is "— none —" -- nothing
          // to set a range for, so hide the whole control instead of
          // showing a meaningless 0-0 range.
          wrap.hidden = p === null;
          if (p === null) return;
          const curMin = parseFloat(minEl.value), curMax = parseFloat(maxEl.value);
          if (p.options && p.options.length) renderEnum(p.options, p.min ?? 0, curMin, curMax);
          else renderNumber(curMin, curMax);
        },
        getValues: () => ({ rangeMin: parseFloat(minEl.value), rangeMax: parseFloat(maxEl.value) }),
      };
    }

    // Enum-aware read-only range text, e.g. "Regular–High" instead of "0–1".
    function paramDefFor(targetId, algId) {
      if (!(targetId >= 0 && targetId < window.GP150Format.MODULE_NAMES.length)) return null;
      const mod = window.GP150Format.MODULE_NAMES[targetId];
      return ((entry.modules[mod] || {}).params || []).find((p) => p.algId === algId) || null;
    }
    function rangeText(e) {
      const p = paramDefFor(e.targetId, e.algId);
      if (p && p.options && p.options.length) {
        const label = (v) => p.options[Math.round(v) - Math.round(p.min ?? 0)] ?? v;
        return `${label(e.rangeMin)}–${label(e.rangeMax)}`;
      }
      return `${e.rangeMin}–${e.rangeMax}`;
    }

    // EXP (9 slots across 3 blocks: EXP1-A, EXP1-B, EXP2 -- one full-state
    // send). NOT "EXP/CTRL" -- CTRL is the separate footswitch section below.
    {
      const expPickers = []; // {index, picker, range}
      for (const block of s.expCtrlBlocks) {
        const h = document.createElement("h4");
        h.className = "gp150-settings-subhead";
        h.textContent = block.key;
        wrap.appendChild(h);
        const list = document.createElement("ul");
        list.className = "gp150-settings-list";
        for (const e of block.entries) {
          const li = document.createElement("li");
          const lab = document.createElement("span");
          lab.textContent = `Slot ${(e.index % 3) + 1}`;
          li.appendChild(lab);
          if (liveWrite && window.WebMidiGP150) {
            const range = createRangeControl(e.rangeMin, e.rangeMax);
            const picker = renderTargetParamPicker(entry, e, (p) => range.setParam(p));
            li.appendChild(picker.el);
            li.appendChild(range.el);
            expPickers.push({ index: e.index, picker, range });
          } else {
            const val = document.createElement("span");
            val.textContent = e.targetId < 0
              ? "— none —"
              : `${e.targetLabel || e.targetId} (algId ${e.algId}), range ${rangeText(e)}`;
            li.appendChild(val);
          }
          list.appendChild(li);
        }
        wrap.appendChild(list);
      }
      if (liveWrite && window.WebMidiGP150) {
        const btn = sendBtnFor(() => {
          for (const { index, picker, range } of expPickers) {
            const { targetId, algId } = picker.getValue();
            const { rangeMin, rangeMax } = range.getValues();
            window.GP150Format.writeExpCtrl(workingBody, index, { targetId, algId, rangeMin, rangeMax });
          }
          return window.WebMidiGP150.sendExpCtrl(workingBody);
        });
        btn.textContent = "Send EXP";
        wrap.appendChild(btn);
      }
    }

    // CTRL A / CTRL B -- confirmed live 2026-09-23: the pedal has only 2
    // physical CTRL switches (not 9), shown on-device as "CTRL A"/"CTRL B",
    // living at FS_SETTING indices 1 and 2 (the struct itself has 9 u32
    // slots -- likely shared firmware with a device family that has more
    // physical switches; indices 0 and 3-8 aren't exposed on this
    // hardware). Each switch activates at most 3 modules -- also confirmed
    // live. Full-state send still resends all 9 slots (sendFsSettings()),
    // but only indices 1/2 are ever patched here -- every other slot's
    // real (if unused) live-read bytes round-trip untouched.
    {
      const F = window.GP150Format;
      const CTRL_MAX_ACTIVE = F.FS_CTRL_MAX_ACTIVE;
      const CTRL_SLOTS = [{ index: F.FS_CTRL_A_INDEX, label: "CTRL A" }, { index: F.FS_CTRL_B_INDEX, label: "CTRL B" }];
      const list = document.createElement("ul");
      list.className = "gp150-settings-list";
      const checkboxGroups = []; // {index, boxes}
      for (const { index, label } of CTRL_SLOTS) {
        const fs = s.fsSettings[index];
        const li = document.createElement("li");
        const lab = document.createElement("span");
        lab.textContent = label;
        li.appendChild(lab);
        if (liveWrite && window.WebMidiGP150) {
          const group = document.createElement("span");
          group.className = "gp150-fs-checkboxes";
          const boxes = [];
          function refreshCap() {
            const activeCount = boxes.filter((b) => b.cb.checked).length;
            for (const b of boxes) b.cb.disabled = !b.cb.checked && activeCount >= CTRL_MAX_ACTIVE;
          }
          for (const mod of window.GP150Format.MODULE_NAMES) {
            const cbLabel = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = fs.modules.includes(mod);
            cb.addEventListener("change", refreshCap);
            cbLabel.appendChild(cb);
            cbLabel.appendChild(document.createTextNode(mod));
            group.appendChild(cbLabel);
            boxes.push({ mod, cb });
          }
          refreshCap();
          li.appendChild(group);
          checkboxGroups.push({ index, boxes });
        } else {
          const val = document.createElement("span");
          val.textContent = fs.modules.length ? fs.modules.join(", ") : "— none —";
          li.appendChild(val);
        }
        list.appendChild(li);
      }
      wrap.appendChild(list);
      if (liveWrite && window.WebMidiGP150) {
        const btn = sendBtnFor(() => {
          checkboxGroups.forEach(({ index, boxes }) => {
            const modules = boxes.filter((b) => b.cb.checked).map((b) => b.mod);
            window.GP150Format.writeFsSetting(workingBody, index, modules);
          });
          return window.WebMidiGP150.sendFsSettings(workingBody);
        });
        btn.textContent = "Send CTRL";
        wrap.appendChild(btn);
      }
    }

    if (liveWrite && window.WebMidiGP150) wrap.appendChild(statusEl);
    return wrap;
  }

  // Toggle between the "Effects Chain" and "Patch Settings" tab panels
  // inside one rendered patch card. Independent per card (queries scoped
  // to `root`), so multiple cards on the page (multi-slot scan) each keep
  // their own selected tab.
  function wireTabs(root) {
    const buttons = root.querySelectorAll(".gp150-tab-btn");
    const panels = root.querySelectorAll(".gp150-tab-panel");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        buttons.forEach((b) => b.classList.toggle("active", b === btn));
        panels.forEach((p) => { p.hidden = p.dataset.tab !== btn.dataset.tab; });
      });
    });
  }

  function renderPatch(entry, { liveWrite = false, modelsCatalog = null } = {}) {
    const node = tmpl.content.cloneNode(true);
    node.querySelector(".gp150-patch-name").textContent = entry.patch_name || "(unnamed)";
    node.querySelector(".gp150-patch-slot").textContent = `slot ${entry.slot_index + 1}`;

    const chain = node.querySelector(".gp150-chain");
    chain.textContent = "";
    entry.chain_order.forEach((mod, i) => {
      const chip = document.createElement("span");
      chip.className = "gp150-chain-chip";
      chip.textContent = mod;
      chain.appendChild(chip);
      if (i < entry.chain_order.length - 1) {
        const arrow = document.createElement("span");
        arrow.className = "gp150-chain-arrow";
        arrow.textContent = "→";
        chain.appendChild(arrow);
      }
    });

    const settingsEl = node.querySelector(".gp150-patch-settings");
    if (settingsEl && entry.patch_settings) settingsEl.appendChild(renderPatchSettings(entry, { liveWrite }));
    wireTabs(node);

    if (liveWrite) wireReorder(node, entry.chain_order);
    if (liveWrite) wireSave(node, entry);
    wireWritePreset(node, entry); // GP150-13 -- available for file uploads too, not just live reads

    const modulesEl = node.querySelector(".gp150-modules");
    // show modules in signal-chain order, not the raw dict's storage order
    for (const mod of entry.chain_order) {
      modulesEl.appendChild(renderModule(mod, entry.modules[mod], { liveWrite, modelsCatalog }));
    }
    return node;
  }

  function renderError(name, message) {
    const div = document.createElement("section");
    div.className = "card gp150-patch-error";
    div.innerHTML = `<strong>${name}</strong> — ${message}`;
    return div;
  }

  // `clear: false` appends instead of replacing — used by the multi-slot scan
  // below so results from earlier slots in the range stick around.
  // `liveWrite: true` additionally wires up the drag-to-reorder-and-send
  // section on each rendered card — only ever passed by the live-read call
  // sites below, never by file uploads (see wireReorder()'s comment).
  async function inspect(fileList, { clear = true, liveWrite = false } = {}) {
    const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith(".prst"));
    const rejected = Array.from(fileList).filter((f) => !f.name.toLowerCase().endsWith(".prst"));
    showError(rejected.length ? `Skipped non-.prst file(s): ${rejected.map((f) => f.name).join(", ")}` : "");
    if (!files.length) return;

    let entries, modelsCatalog;
    try {
      const [ring, catalog] = await Promise.all([
        getGp150Ring(),
        liveWrite ? getModelsCatalog() : Promise.resolve(null),
      ]);
      modelsCatalog = catalog;
      entries = await Promise.all(files.map(async (f) => {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!window.GP150Format.isGp150(bytes)) {
          return { name: f.name, ok: false, error: `not a GP-150 .prst (len ${bytes.length}) — use the Preset Converter for GP-5/GP-50 files` };
        }
        try {
          // rawBytes kept verbatim (not re-derived from decoded fields) for
          // wireWritePreset() below -- GP150-13's write path needs the
          // ALREADY-VALID original body, checksum untouched.
          return { name: f.name, ok: true, rawBytes: bytes, ...decodeGp150(bytes, ring) };
        } catch (e) {
          return { name: f.name, ok: false, error: e.message };
        }
      }));
    } catch (e) {
      showError(`Couldn't load the GP-150 model catalog (${e.message}).`);
      return;
    }

    if (clear) resultsEl.textContent = "";
    for (const entry of entries) {
      if (!entry.ok) { resultsEl.appendChild(renderError(entry.name, entry.error)); continue; }
      const card = renderPatch(entry, { liveWrite, modelsCatalog });
      resultsEl.appendChild(card);
      // EXP-9 (2026-09-23): the only hook gp150_block_library.js needs —
      // hands off the already-decoded entry (modules/params/fxid, no
      // re-derivation from rendered text) plus the actual card element (a
      // DocumentFragment's children are inserted as siblings on append, so
      // read the just-appended last child rather than the (now-empty)
      // fragment reference). Query by :last-child since renderPatch()
      // returns raw content wrapped in a plain object, not one section node.
      document.dispatchEvent(new CustomEvent("gp150:patch-rendered", {
        detail: { entry, liveWrite, card: resultsEl.lastElementChild },
      }));
    }
  }

  function wireDropZone() {
    pickBtn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => { inspect(input.files); input.value = ""; });
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag-over"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag-over"); })
    );
    drop.addEventListener("drop", (e) => inspect(e.dataTransfer.files));
  }

  // --- live read over WebMIDI (webmidi_gp150.js) ------------------------------
  // Optional: only wired up if the page has the live-read section (it does) and
  // webmidi_gp150.js loaded. Reuses inspect() above for rendering, by wrapping
  // the raw body read off the device in a File — same backend decode path as
  // an uploaded .prst, no duplicated rendering logic.
  function wireLiveRead() {
    const connectBtn = document.getElementById("gp150-connect-btn");
    const statusEl = document.getElementById("gp150-live-status");
    const controls = document.getElementById("gp150-live-controls");
    const slotInput = document.getElementById("gp150-slot-input");
    const settleInput = document.getElementById("gp150-settle-input");
    const readBtn = document.getElementById("gp150-read-btn");
    const liveErrEl = document.getElementById("gp150-live-error");
    if (!connectBtn || !window.WebMidiGP150) return;

    function showLiveError(msg) {
      liveErrEl.textContent = msg;
      liveErrEl.hidden = !msg;
    }

    // Renders a live-read body (from any of the paths below, or from
    // startLiveSync()'s own onUpdate) through the same inspect() pipeline
    // an uploaded file uses, and updates the slot input to match.
    async function renderLiveBody(body, statusPrefix) {
      const slot1based = body[window.GP150Format.PATCH_INDEX_OFF] + 1;
      slotInput.value = slot1based;
      const file = new File([body], `live-slot${String(slot1based).padStart(3, "0")}.prst`, {
        type: "application/octet-stream",
      });
      statusEl.textContent = `${statusPrefix} slot ${slot1based}`;
      await inspect([file], { liveWrite: true });
    }

    connectBtn.addEventListener("click", async () => {
      showLiveError("");
      connectBtn.disabled = true;
      statusEl.textContent = "Connecting…";
      try {
        const dev = await window.WebMidiGP150.connect();
        statusEl.textContent = `Connected — ${dev.port}`;
        controls.hidden = false;
        // Auto-read whatever's currently active, matching Suite's own
        // behavior (it shows the active preset immediately on connect,
        // no explicit "read" step). Best-effort: a failure here doesn't
        // undo the connection, same as primeSession()'s own convention.
        try {
          statusEl.textContent = "Reading active preset…";
          const body = await window.WebMidiGP150.readActivePreset();
          await renderLiveBody(body, "Connected — active preset is");
        } catch (e) {
          statusEl.textContent = `Connected — ${dev.port}`;
        }
        // GP150-11 (2026-09-24): live-sync with the pedal from here on --
        // no polling, just decoding the pedal's own periodic self-
        // broadcast (confirmed live: it reflects a preset changed
        // DIRECTLY ON THE PEDAL, exactly how Suite itself stays in sync).
        window.WebMidiGP150.startLiveSync((body) => {
          if (window.GP150Usage) window.GP150Usage.applyBody(body);
          renderLiveBody(body, "Connected — live update, now on").catch(() => {});
        });
      } catch (e) {
        showLiveError(e.message);
        statusEl.textContent = "";
      } finally {
        connectBtn.disabled = false;
      }
    });

    // GP150-11 (2026-09-24): selects the slot via Suite's own SysEx
    // mechanism (no CC0/PC -- byte-for-byte confirmed against 2 real
    // Suite captures), then reads back whatever became active, retrying
    // the fetch if a stale (pre-switch) burst is caught first. Live-
    // tested more reliable than the old CC0+PC-based path it replaces.
    // WARNING (the user's own correction): this loads that preset live
    // on the pedal, exactly like changing patches in Suite itself --
    // unsaved edits on the pedal are lost.
    readBtn.addEventListener("click", async () => {
      showLiveError("");
      const slot1based = parseInt(slotInput.value, 10);
      if (!Number.isInteger(slot1based) || slot1based < 1 || slot1based > 200) {
        showLiveError("Slot must be 1-200");
        return;
      }
      const slot = slot1based - 1; // device protocol is 0-indexed
      const settleMs = parseInt(settleInput && settleInput.value, 10);
      readBtn.disabled = true;
      statusEl.textContent = `Selecting + reading slot ${slot1based}…`;
      try {
        const body = await window.WebMidiGP150.readSlotViaSelect(slot, Number.isInteger(settleMs) ? { settleMs } : undefined);
        await renderLiveBody(body, "Connected — read");
      } catch (e) {
        showLiveError(e.message);
        statusEl.textContent = "Connected";
      } finally {
        readBtn.disabled = false;
      }
    });
  }

  // --- list all patch names (Explorer-lite: one fast request, not 200 slow
  // reads) ---------------------------------------------------------------
  // Uses WebMidiGP150.readAllNames() (one request, ~4KB reply) instead of
  // readSlot() in a loop — the earlier version of this section did 200
  // individual live reads to build an overview; this does one. Shares the
  // same WebMIDI connection as wireLiveRead() above (WebMidiGP150 is a
  // module-level singleton). Each listed name has its own "Read" button
  // that does a full live read of just that slot, reusing readSlot() +
  // inspect() exactly like section 2's button does.
  function wireNameList() {
    const listBtn = document.getElementById("gp150-list-names-btn");
    const statusEl = document.getElementById("gp150-list-names-status");
    const errEl = document.getElementById("gp150-list-names-error");
    const listEl = document.getElementById("gp150-name-list");
    if (!listBtn || !window.WebMidiGP150) return;

    function showListError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    function renderNameList(names) {
      listEl.textContent = "";
      for (const { index, name } of names) {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${String(index + 1).padStart(3, "0")} — ${name || "(unnamed)"}`;
        const readBtn = document.createElement("button");
        readBtn.type = "button";
        readBtn.textContent = "Read";
        readBtn.addEventListener("click", async () => {
          showListError("");
          readBtn.disabled = true;
          const prevLabel = readBtn.textContent;
          readBtn.textContent = "Reading…";
          try {
            const body = await window.WebMidiGP150.readSlotViaSelect(index);
            const file = new File([body], `live-slot${String(index + 1).padStart(3, "0")}.prst`, {
              type: "application/octet-stream",
            });
            await inspect([file], { liveWrite: true });
            resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
          } catch (e) {
            showListError(`slot ${index + 1}: ${e.message}`);
          } finally {
            readBtn.disabled = false;
            readBtn.textContent = prevLabel;
          }
        });
        li.appendChild(label);
        li.appendChild(readBtn);
        listEl.appendChild(li);
      }
    }

    listBtn.addEventListener("click", async () => {
      showListError("");
      listBtn.disabled = true;
      if (!window.WebMidiGP150.isConnected()) {
        statusEl.textContent = "Connecting…";
        try {
          await window.WebMidiGP150.connect();
        } catch (e) {
          showListError(e.message);
          statusEl.textContent = "";
          listBtn.disabled = false;
          return;
        }
      }
      statusEl.textContent = "Fetching all 200 names…";
      try {
        const names = await window.WebMidiGP150.readAllNames();
        renderNameList(names);
        statusEl.textContent = `${names.length} names`;
      } catch (e) {
        showListError(e.message);
        statusEl.textContent = "";
      } finally {
        listBtn.disabled = false;
      }
    });
  }

  // SnapTone/User IR catalog listing (formerly section 4 here) moved to the
  // Captures & IRs page (gp150_captures_ui.js, GP150-8), alongside the
  // existing GP-5/GP-50 sync flow.

  wireDropZone();
  wireLiveRead();
  wireNameList();
  // GP-50/GP-5 -> GP-150 converter (section 5): moved to its own file
  // (gp150_converter_ui.js, GP150-8) so it can also run on the Preset
  // Converter page. Loaded separately in index.html's own <script> tags —
  // no wiring call needed here.
})();
