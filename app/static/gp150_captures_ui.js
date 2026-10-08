"use strict";

// GP-150 SnapTones/User IRs catalog listing UI (GP150-8: moved out of
// gp150.js into its own file so it can live on the Captures & IRs page
// alongside the existing GP-5/GP-50 sync flow, instead of GP-150's own
// now-removed page). Needs webmidi_gp150.js loaded first.
//
// Two independent one-shot requests -- the SnapTone catalog and the User IR
// list. Separate buttons on purpose (2026-09-03, after a live report): the
// device can keep re-sending one reply for a while after it arrives, which
// crowded out the other request when both fired back to back automatically
// (even with a settle delay and a mid-window retry in readCatalog() itself
// -- neither was enough). Two separate user-triggered clicks means the gap
// between requests is however long the user takes to click the second
// button, not a fixed guess.
//
// No per-row "Read" button -- unlike a patch name, a SnapTone/User IR entry
// isn't a slot with its own full-body live read; these are just catalog
// listings. Each card carries a "used by" badge and a "List Presets" button fed by
// GP150Usage (gp150_usage.js), which reads the 200 presets by index in the background
// after connecting.
//
// GP150-9 (2026-09-25): User IR *upload* -- reads a .wav file's raw PCM
// client-side and sends it with WebMidiGP150.sendIrUpload(), whose wire
// format is byte-verified against a real Suite capture (see
// webmidi_gp150.js's own comment on buildIrUploadEnvelope()).
(() => {
  const Usage = () => window.GP150Usage;
  // Every pedal action runs between two background preset reads (one request in flight).
  const guarded = (fn) => (...a) => (Usage() ? Usage().exclusive(() => fn(...a)) : fn(...a));

  // Start the background "used by" load whenever a connection is made, whichever button did it.
  if (window.WebMidiGP150 && !window.WebMidiGP150.__usageHooked) {
    const rawConnect = window.WebMidiGP150.connect;
    window.WebMidiGP150.connect = async (...a) => {
      const r = await rawConnect.apply(window.WebMidiGP150, a);
      if (Usage()) Usage().onConnected();
      return r;
    };
    window.WebMidiGP150.__usageHooked = true;
  }

  // ---- "used by" -------------------------------------------------------------------------
  // kind: "st" | "nam" | "ir"; `slot` literal 1-based (the number shown on the card).
  function usageLabel(kind, slot) {
    const U = Usage();
    if (!U || !U.isComplete()) return { text: "…", unused: true };
    const n = U.count(kind, slot);
    return { text: n ? `${n} patch${n === 1 ? "" : "es"}` : "unused", unused: !n };
  }

  function openUsageModal(kind, slot, title) {
    let ov = document.getElementById("gp150-usage-modal");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "gp150-usage-modal";
      ov.className = "modal-overlay";
      ov.hidden = true;
      ov.innerHTML = `<div class="modal-card build-card">
        <h2 class="build-title"></h2><p class="build-sub"></p><ul class="dep-list"></ul>
        <div class="modal-actions build-actions"><button type="button" class="modal-btn">Close</button></div></div>`;
      document.body.appendChild(ov);
      const close = () => { ov.hidden = true; };
      ov.querySelector("button").addEventListener("click", close);
      ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    }
    const U = Usage();
    const list = ov.querySelector(".dep-list");
    const rows = U ? U.get(kind, slot) : [];
    ov.querySelector(".build-title").textContent = title;
    ov.querySelector(".build-sub").textContent = !U || !U.isComplete()
      ? `Still reading the presets (${U ? U.known() : 0}/200) — ${rows.length ? "this list is partial so far:" : "check back in a moment."}`
      : rows.length
        ? `Used by ${rows.length} patch${rows.length === 1 ? "" : "es"}:`
        : "Not used by any patch — safe to overwrite.";
    list.textContent = "";
    for (const r of rows) {
      const li = document.createElement("li");
      li.className = "dep-row";
      const a = document.createElement("span"); a.className = "dep-slot"; a.textContent = `#${r.slot}`;
      const b = document.createElement("span"); b.className = "dep-name";
      b.textContent = r.enabled ? r.name : `${r.name} (module off)`;
      li.append(a, b);
      list.appendChild(li);
    }
    ov.hidden = false;
  }

  function refreshBadges() {
    document.querySelectorAll(".asset-card[data-usage-kind]").forEach((card) => {
      const b = card.querySelector(".usage-badge");
      if (!b) return;
      const { text, unused } = usageLabel(card.dataset.usageKind, Number(card.dataset.usageSlot));
      b.textContent = text;
      b.classList.toggle("unused", unused);
    });
  }

  function wireUsageStatus() {
    const U = Usage();
    const statusEl = document.getElementById("gp150-usage-status");
    const rescanBtn = document.getElementById("gp150-usage-rescan-btn");
    if (!U || !statusEl) return;
    const render = () => {
      const s = U.getStatus();
      if (s.state === "loading") statusEl.textContent = s.message;
      else if (s.state === "error") statusEl.textContent = `Preset scan stopped: ${s.message}`;
      else if (s.state === "cancelled") statusEl.textContent = `Preset scan cancelled — ${s.known}/200 read`;
      else statusEl.textContent = s.known ? `Used-by list: ${s.known}/200 presets read` : "Used-by list: connect to read the presets";
      if (rescanBtn) rescanBtn.textContent = s.state === "loading" ? "Stop" : "Rescan presets";
      refreshBadges();
    };
    U.on(render);
    render();
    if (rescanBtn) {
      rescanBtn.addEventListener("click", () => {
        if (U.getStatus().state === "loading") { U.cancel(); return; }
        if (!window.WebMidiGP150.isConnected()) {
          window.WebMidiGP150.connect().then(() => U.rescan(), (e) => { statusEl.textContent = e.message; });
        } else U.rescan();
      });
    }
  }

  // Same `.asset-card`/`.asset-grid` visual shape as the GP-5/GP-50
  // grids above (device_a.js's own assetCard()) -- the user explicitly
  // asked for this instead of a plain text list, 2026-09-26 ("io volevo
  // la stessa visualizzazione che c'era per il GP-50 anche per il
  // GP-150"). "Build"
  // was scoped (reuse the GP-50->GP-150 converter, repoint its N->S/NAM
  // reference, download-only) but explicitly deferred by the user ("per
  // ora lasciamo stare") -- not implemented.
  function catalogCard(kind, entry) {
    const card = document.createElement("div");
    card.className = `asset-card ${kind}`;
    const top = document.createElement("div");
    top.className = "ac-top";
    // Unwritten slots read back with a large placeholder index
    // (0x10000+n -- see readCatalog()'s own decoder comment); only a
    // slot that's actually been written shows its own real, small index.
    // User IRs' own written-slot index is 0-based on the wire (confirmed
    // live 2026-09-26: a real IR upload to human slot 15 reads
    // back as literal index 14) -- +1 for display, matching how the user
    // (and sendIrUpload()'s own targetSlot0based+1 convention) thinks
    // about IR slots. NAM/SnapTones are already literal 1-based on the
    // wire (matches sendNamUpload()'s own targetSlot), no offset needed.
    const isPlaceholder = entry.index >= 0x10000;
    const displayIndex = !isPlaceholder && kind === "ir" ? entry.index + 1 : entry.index;
    const slot = document.createElement("span");
    slot.className = "ac-slot";
    slot.textContent = isPlaceholder ? "–" : `#${displayIndex}`;
    const name = document.createElement("span");
    name.className = "ac-name";
    name.textContent = entry.name || "(unnamed)";
    top.append(slot, name);
    card.appendChild(top);

    // "used by": badge + "List Presets" (same markup as the GP-5/GP-50 cards). Slots that
    // were never written read back as placeholders and have nothing to be used by.
    if (!isPlaceholder && Usage()) {
      const usageKind = kind === "st" ? "st" : kind;
      card.dataset.usageKind = usageKind;
      card.dataset.usageSlot = String(displayIndex);
      const foot = document.createElement("div");
      foot.className = "ac-foot";
      const badge = document.createElement("span");
      const { text, unused } = usageLabel(usageKind, displayIndex);
      badge.className = "usage-badge" + (unused ? " unused" : "");
      badge.textContent = text;
      const list = document.createElement("button");
      list.type = "button";
      list.className = "ac-list";
      list.textContent = "List Presets";
      list.addEventListener("click", () => openUsageModal(usageKind, displayIndex, `${entry.name || "(unnamed)"} · #${displayIndex}`));
      foot.append(badge, list);
      card.appendChild(foot);
    }

    return card;
  }

  function wireCatalogList({ btnId, statusId, errId, listId, fetchFn, itemLabel, kind }) {
    const btn = document.getElementById(btnId);
    const statusEl = document.getElementById(statusId);
    const errEl = document.getElementById(errId);
    const listEl = document.getElementById(listId);
    if (!btn || !window.WebMidiGP150) return;

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    function renderCards(entries) {
      listEl.textContent = "";
      // "None" is a real wire entry (index 0 for SnapTones, an oddly
      // placeholder-shaped index for NAM) but it's a sentinel meaning "no
      // selection" for other UI (e.g. a param picker), not an actual
      // storable slot -- doesn't belong in this listing. Confirmed live
      // 2026-09-26 ("SnapTone #0 None non esiste").
      for (const entry of entries) {
        if (entry.name === "None") continue;
        listEl.appendChild(catalogCard(kind, entry));
      }
    }

    btn.addEventListener("click", guarded(async () => {
      showError("");
      btn.disabled = true;
      if (!window.WebMidiGP150.isConnected()) {
        statusEl.textContent = "Connecting…";
        try {
          await window.WebMidiGP150.connect();
        } catch (e) {
          showError(e.message);
          statusEl.textContent = "";
          btn.disabled = false;
          return;
        }
      }
      statusEl.textContent = `Fetching ${itemLabel}…`;
      try {
        const entries = await fetchFn();
        renderCards(entries);
        statusEl.textContent = `${entries.length} ${itemLabel}`;
      } catch (e) {
        showError(e.message);
        statusEl.textContent = "";
      } finally {
        btn.disabled = false;
      }
    }));
  }

  // Parse a .wav file's raw PCM into signed 32-bit samples (channel 0, no resampling): see gp150_upload_prep.js.
  function decodeWavPcmSamples(arrayBuffer) {
    return window.GP150UploadPrep.decodeWavPcmSamples(arrayBuffer, { maxFrames: window.WebMidiGP150.IR_MAX_SAMPLES });
  }

  const sanitizeIrName = (name) => window.GP150UploadPrep.sanitizeName(name);

  function wireIrUpload() {
    const fileInput = document.getElementById("gp150-ir-upload-file");
    const nameInput = document.getElementById("gp150-ir-upload-name");
    const slotSelect = document.getElementById("gp150-ir-upload-slot");
    const uploadBtn = document.getElementById("gp150-ir-upload-btn");
    const statusEl = document.getElementById("gp150-ir-upload-status");
    const errEl = document.getElementById("gp150-ir-upload-error");
    const maxMsEl = document.getElementById("gp150-ir-upload-max-ms");
    if (!fileInput || !window.WebMidiGP150) return;

    const SLOT_COUNT = window.WebMidiGP150.IR_USER_IR_SLOT_COUNT;
    for (let i = 1; i <= SLOT_COUNT; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `Slot ${i}`;
      slotSelect.appendChild(opt);
    }

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    let parsed = null; // { fmt/samples } of the currently-selected file

    fileInput.addEventListener("change", async () => {
      showError("");
      statusEl.textContent = "";
      parsed = null;
      uploadBtn.disabled = true;
      const file = fileInput.files[0];
      if (!file) return;
      if (!nameInput.value) nameInput.value = sanitizeIrName(file.name.replace(/\.wav$/i, ""));
      try {
        const buf = await file.arrayBuffer();
        parsed = decodeWavPcmSamples(buf);
        const maxMs = (window.WebMidiGP150.IR_MAX_SAMPLES / parsed.sampleRate) * 1000;
        if (maxMsEl) maxMsEl.textContent = `~${maxMs.toFixed(0)}ms`;
        const totalMs = (parsed.samples.length / parsed.sampleRate) * 1000;
        statusEl.textContent = `${parsed.channels}ch, ${parsed.bitsPerSample}-bit, ${parsed.sampleRate}Hz — sending ${parsed.samples.length} samples (${totalMs.toFixed(0)}ms)`;
        uploadBtn.disabled = false;
      } catch (e) {
        showError(`Couldn't read file: ${e.message}`);
      }
    });

    uploadBtn.addEventListener("click", guarded(async () => {
      showError("");
      if (!parsed) return;
      uploadBtn.disabled = true;
      if (!window.WebMidiGP150.isConnected()) {
        statusEl.textContent = "Connecting…";
        try {
          await window.WebMidiGP150.connect();
        } catch (e) {
          showError(e.message);
          statusEl.textContent = "";
          uploadBtn.disabled = false;
          return;
        }
      }
      const slot0based = Number(slotSelect.value) - 1;
      const name = sanitizeIrName(nameInput.value || "IR");
      statusEl.textContent = `Uploading to slot ${slot0based + 1}…`;
      try {
        window.WebMidiGP150.sendIrUpload(slot0based, name, parsed.samples);
        statusEl.textContent = `Sent to slot ${slot0based + 1}. Check the pedal's User IR list to confirm.`;
      } catch (e) {
        showError(e.message);
        statusEl.textContent = "";
      } finally {
        uploadBtn.disabled = false;
      }
    }));
  }

  // GP150-9: upload an ALREADY-BUILT .clo verbatim to a
  // chosen SnapTone library slot -- does not create a new SnapTone from
  // audio (see webmidi_gp150.js's own sendSnapToneUpload() comment for
  // why that's a separate, much larger DSP-reversing problem). Simpler
  // than IR/NAM's forms: no parsing needed, just the raw file bytes and
  // the "VTSI" magic check webmidi_gp150.js already does.
  function wireSnapToneUpload() {
    const fileInput = document.getElementById("gp150-snaptone-upload-file");
    const nameInput = document.getElementById("gp150-snaptone-upload-name");
    const slotInput = document.getElementById("gp150-snaptone-upload-slot");
    const uploadBtn = document.getElementById("gp150-snaptone-upload-btn");
    const statusEl = document.getElementById("gp150-snaptone-upload-status");
    const errEl = document.getElementById("gp150-snaptone-upload-error");
    if (!fileInput || !window.WebMidiGP150) return;

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    let cloBytes = null;

    fileInput.addEventListener("change", async () => {
      showError("");
      statusEl.textContent = "";
      cloBytes = null;
      uploadBtn.disabled = true;
      const file = fileInput.files[0];
      if (!file) return;
      if (!nameInput.value) nameInput.value = file.name.replace(/\.clo$/i, "").slice(0, 16);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        if (magic !== "VTSI") throw new Error(`not a .clo file — expected the "VTSI" magic, got "${magic}"`);
        cloBytes = bytes;
        statusEl.textContent = `${bytes.length} bytes — ready to upload.`;
        uploadBtn.disabled = false;
      } catch (e) {
        showError(`Couldn't read file: ${e.message}`);
      }
    });

    uploadBtn.addEventListener("click", guarded(async () => {
      showError("");
      if (!cloBytes) return;
      const slot = parseInt(slotInput.value, 10);
      if (!(slot >= 1 && slot <= 100)) {
        showError(`slot must be 1-100, got ${slotInput.value}`);
        return;
      }
      uploadBtn.disabled = true;
      if (!window.WebMidiGP150.isConnected()) {
        statusEl.textContent = "Connecting…";
        try {
          await window.WebMidiGP150.connect();
        } catch (e) {
          showError(e.message);
          statusEl.textContent = "";
          uploadBtn.disabled = false;
          return;
        }
      }
      const name = nameInput.value || "SnapTone";
      statusEl.textContent = `Uploading to slot ${slot}…`;
      try {
        window.WebMidiGP150.sendSnapToneUpload(slot, name, cloBytes);
        statusEl.textContent = `Sent to slot ${slot}. Check the pedal's SnapTone list to confirm.`;
      } catch (e) {
        showError(e.message);
        statusEl.textContent = "";
      } finally {
        uploadBtn.disabled = false;
      }
    }));
  }

  const wavSampleRate = (arrayBuffer) => window.GP150UploadPrep.wavSampleRate(arrayBuffer);

  // Decodes at the file's own rate (no browser resampling), takes the first
  // channel and converts to the profiler's 48 kHz with the same filter shape
  // as Suite's converter (the click in the reference is sensitive to it).
  async function decodeWavFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const rate = wavSampleRate(arrayBuffer) || 48000;
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, rate);
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    let samples = audioBuffer.getChannelData(0).slice();
    if (audioBuffer.sampleRate !== 48000) samples = window.AmpProfiler.resample(samples, audioBuffer.sampleRate, 48000);
    return { samples, sampleRate: 48000 };
  }

  // The profiler needs a recording of the whole 70 s test signal.
  const PROFILER_MIN_SAMPLES = 70 * 48000;
  function checkProfilerInputs(audio, what) {
    if (audio.samples.length < PROFILER_MIN_SAMPLES - 48000) {
      return `the ${what} is ${(audio.samples.length / 48000).toFixed(1)} s long — it must cover the whole 70 s test signal.`;
    }
    return "";
  }

  // NAM model -> reference signal -> modeled "recording", as Suite's converter does.
  async function renderNamRecording(namJson, ref, statusEl) {
    const model = window.NamWaveNet.extractAnyModel(namJson);
    const onProgress = (f) => { statusEl.textContent = `Running the NAM model… ${Math.round(f * 100)}%`; };
    const modeled = window.NamWaveNetFast
      ? await window.NamWaveNetFast.render(model, ref, { onProgress })
      : await window.NamWaveNet.renderModelBlocksAsync(model, ref, 24000, onProgress);
    // Suite writes the model output x 0.31 as 16-bit PCM before profiling it.
    return window.GP150UploadPrep.quantizeNamOutput(modeled);
  }

  // profile -> .clo -> upload, shared tail of both flows
  async function profileAndUpload(ref, recording, slot, name, statusEl) {
    const prof = await window.AmpProfiler.profileAsync(ref, recording, {
      progress: (stage) => { statusEl.textContent = `Profiling the amp… ${stage}`; },
    });
    const cloBytes = window.AmpProfiler.toDeviceClo(window.AmpProfiler.assembleClo(prof));
    statusEl.textContent = `Uploading to slot ${slot}…`;
    window.WebMidiGP150.sendSnapToneUpload(slot, name, cloBytes);
    statusEl.textContent = `Sent to slot ${slot}.`;
  }
  async function ensureConnected(statusEl) {
    if (!window.WebMidiGP150.isConnected()) {
      statusEl.textContent = "Connecting…";
      await window.WebMidiGP150.connect();
    }
  }

  // "Create SnapTone from a .nam file": one button that runs the whole chain.
  function wireCreateSnapToneFromNam() {
    const fileInput = document.getElementById("gp150-nam-clone-file");
    const nameInput = document.getElementById("gp150-nam-clone-upload-name");
    const slotInput = document.getElementById("gp150-nam-clone-upload-slot");
    const uploadBtn = document.getElementById("gp150-nam-clone-upload-btn");
    const statusEl = document.getElementById("gp150-nam-clone-upload-status");
    const errEl = document.getElementById("gp150-nam-clone-upload-error");
    if (!fileInput || !window.AmpProfiler || !window.AmpProfilerReference || !window.NamWaveNet || !window.WebMidiGP150) return;

    let namJson = null;
    let busy = false;
    const showError = (msg) => { errEl.textContent = msg; errEl.hidden = !msg; };
    const updateState = () => { uploadBtn.disabled = busy || !namJson; };

    fileInput.addEventListener("change", async () => {
      showError("");
      namJson = null;
      updateState();
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        // Validate early so the user finds out before clicking the button.
        const model = window.NamWaveNet.extractAnyModel(parsed);
        if ((model.sampleRate || 48000) !== 48000) {
          throw new Error(`the model runs at ${model.sampleRate} Hz — only 48 kHz NAM models are supported.`);
        }
        namJson = parsed;
        if (!nameInput.value) nameInput.value = ((parsed.metadata && parsed.metadata.name) || file.name.replace(/\.nam$/i, "")).slice(0, 16);
        updateState();
      } catch (e) {
        showError(`Couldn't read this .nam file: ${e.message}`);
      }
    });

    uploadBtn.addEventListener("click", guarded(async () => {
      showError("");
      if (!namJson) return;
      const slot = parseInt(slotInput.value, 10);
      if (!(slot >= 1 && slot <= 100)) { showError(`slot must be 1-100, got ${slotInput.value}`); return; }
      busy = true; updateState();
      try {
        await ensureConnected(statusEl);
        const ref = window.AmpProfilerReference.get();
        const modeled = await renderNamRecording(namJson, ref, statusEl);
        await profileAndUpload(ref, modeled, slot, nameInput.value || "NAM CLONE", statusEl);
      } catch (e) {
        showError(`Couldn't build and upload the SnapTone: ${e.message}`);
        statusEl.textContent = "";
      } finally {
        busy = false; updateState();
      }
    }));
  }

  // "Create SnapTone from audio": same chain, starting from a recording of the amp.
  function wireCreateSnapToneFromAudio() {
    const recInput = document.getElementById("gp150-clone-rec-file");
    const nameInput = document.getElementById("gp150-clone-upload-name");
    const slotInput = document.getElementById("gp150-clone-upload-slot");
    const uploadBtn = document.getElementById("gp150-clone-upload-btn");
    const statusEl = document.getElementById("gp150-clone-upload-status");
    const errEl = document.getElementById("gp150-clone-upload-error");
    if (!recInput || !window.AmpProfiler || !window.AmpProfilerReference || !window.WebMidiGP150) return;

    let recAudio = null;
    let busy = false;
    const showError = (msg) => { errEl.textContent = msg; errEl.hidden = !msg; };
    const updateState = () => { uploadBtn.disabled = busy || !recAudio; };
    const downloadBtn = document.getElementById("gp150-clone-ref-download");
    downloadBtn.addEventListener("click", () => {
      const wav = window.AmpProfilerReference.toWav16(window.AmpProfilerReference.get(), window.AmpProfilerReference.SAMPLE_RATE);
      const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      const a = document.createElement("a");
      a.href = url; a.download = "reference.wav"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    recInput.addEventListener("change", async () => {
      showError("");
      recAudio = null;
      updateState();
      const file = recInput.files[0];
      if (!file) return;
      try {
        const audio = await decodeWavFile(file);
        const problem = checkProfilerInputs(audio, "recording");
        if (problem) throw new Error(problem);
        recAudio = audio;
        if (!nameInput.value) nameInput.value = file.name.replace(/\.[^.]*$/, "").slice(0, 16);
        updateState();
      } catch (e) {
        showError(`Couldn't read the recording: ${e.message}`);
      }
    });

    uploadBtn.addEventListener("click", guarded(async () => {
      showError("");
      if (!recAudio) return;
      const slot = parseInt(slotInput.value, 10);
      if (!(slot >= 1 && slot <= 100)) { showError(`slot must be 1-100, got ${slotInput.value}`); return; }
      busy = true; updateState();
      try {
        await ensureConnected(statusEl);
        await profileAndUpload(window.AmpProfilerReference.get(), recAudio.samples, slot, nameInput.value || "AI CLONE", statusEl);
      } catch (e) {
        showError(`Couldn't build and upload the SnapTone: ${e.message}`);
        statusEl.textContent = "";
      } finally {
        busy = false; updateState();
      }
    }));
  }

  // (i) buttons: the descriptions in the upload section are shown in a popup.
  function wireInfoPopups() {
    const modal = document.getElementById("info-modal");
    if (!modal) return;
    const titleEl = document.getElementById("info-modal-title");
    const bodyEl = document.getElementById("info-modal-body");
    const close = () => { modal.hidden = true; };
    document.getElementById("info-modal-close").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
    for (const text of document.querySelectorAll("#gp150-upload-section .info-text")) {
      const heading = text.previousElementSibling;
      if (!heading || heading.tagName !== "H4") continue;
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "info-btn"; btn.textContent = "i";
      btn.title = "What is this?"; btn.setAttribute("aria-label", "About: " + heading.textContent.trim());
      btn.addEventListener("click", () => {
        titleEl.textContent = heading.firstChild.textContent.trim();
        bodyEl.innerHTML = text.innerHTML;
        modal.hidden = false;
      });
      heading.appendChild(btn);
    }
  }

  // The one NAM model this pedal can use (see gp150_upload_prep.js).
  function pickNamLiteModel(namJson) {
    return window.GP150UploadPrep.pickNamLiteModel(namJson, window.WebMidiGP150.NAM_WEIGHTS_COUNT);
  }

  function wireNamUpload() {
    const fileInput = document.getElementById("gp150-nam-upload-file");
    const nameInput = document.getElementById("gp150-nam-upload-name");
    const slotInput = document.getElementById("gp150-nam-upload-slot");
    const uploadBtn = document.getElementById("gp150-nam-upload-btn");
    const statusEl = document.getElementById("gp150-nam-upload-status");
    const errEl = document.getElementById("gp150-nam-upload-error");
    const weightsCountEl = document.getElementById("gp150-nam-upload-weights-count");
    if (!fileInput || !window.WebMidiGP150) return;

    if (weightsCountEl) weightsCountEl.textContent = String(window.WebMidiGP150.NAM_WEIGHTS_COUNT);
    slotInput.min = String(window.WebMidiGP150.NAM_SLOT_MIN);
    slotInput.max = String(window.WebMidiGP150.NAM_SLOT_MAX);

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    let weights = null; // the currently-selected file's picked lite-model weights
    let loudness = 0; // that same submodel's own metadata.loudness (0 if it has none)

    fileInput.addEventListener("change", async () => {
      showError("");
      statusEl.textContent = "";
      weights = null;
      uploadBtn.disabled = true;
      const file = fileInput.files[0];
      if (!file) return;
      if (!nameInput.value) nameInput.value = sanitizeIrName(file.name.replace(/\.nam$/i, ""));
      try {
        const text = await file.text();
        const namJson = JSON.parse(text);
        const picked = pickNamLiteModel(namJson);
        weights = picked.weights;
        loudness = picked.loudness || 0;
        statusEl.textContent = `Found a compatible lite model (${weights.length} weights)`;
        uploadBtn.disabled = false;
      } catch (e) {
        showError(`Couldn't use this file: ${e.message}`);
      }
    });

    uploadBtn.addEventListener("click", guarded(async () => {
      showError("");
      if (!weights) return;
      const slot = Number(slotInput.value);
      if (!Number.isInteger(slot) || slot < window.WebMidiGP150.NAM_SLOT_MIN || slot > window.WebMidiGP150.NAM_SLOT_MAX) {
        showError(`Slot must be ${window.WebMidiGP150.NAM_SLOT_MIN}-${window.WebMidiGP150.NAM_SLOT_MAX}`);
        return;
      }
      uploadBtn.disabled = true;
      if (!window.WebMidiGP150.isConnected()) {
        statusEl.textContent = "Connecting…";
        try {
          await window.WebMidiGP150.connect();
        } catch (e) {
          showError(e.message);
          statusEl.textContent = "";
          uploadBtn.disabled = false;
          return;
        }
      }
      const name = sanitizeIrName(nameInput.value || "NAM");
      statusEl.textContent = `Uploading to slot ${slot}…`;
      try {
        window.WebMidiGP150.sendNamUpload(slot, name, weights, loudness);
        statusEl.textContent = `Sent to slot ${slot}. Check the pedal's SnapTone list to confirm.`;
      } catch (e) {
        showError(e.message);
        statusEl.textContent = "";
      } finally {
        uploadBtn.disabled = false;
      }
    }));
  }

  if (!document.getElementById("gp150-list-snaptones-btn")) return; // section not present on this page

  wireCatalogList({
    btnId: "gp150-list-snaptones-btn",
    statusId: "gp150-list-snaptones-status",
    errId: "gp150-list-snaptones-error",
    listId: "gp150-snaptone-list",
    fetchFn: () => window.WebMidiGP150.readSnaptones(),
    itemLabel: "SnapTones",
    kind: "st",
  });
  wireCatalogList({
    btnId: "gp150-list-nam-btn",
    statusId: "gp150-list-nam-status",
    errId: "gp150-list-nam-error",
    listId: "gp150-nam-list",
    fetchFn: () => window.WebMidiGP150.readNamModels(),
    itemLabel: "NAM",
    kind: "nam",
  });
  wireCatalogList({
    btnId: "gp150-list-user-irs-btn",
    statusId: "gp150-list-user-irs-status",
    errId: "gp150-list-user-irs-error",
    listId: "gp150-user-ir-list",
    fetchFn: () => window.WebMidiGP150.readUserIrs(),
    itemLabel: "User IRs",
    kind: "ir",
  });
  wireUsageStatus();
  wireIrUpload();
  wireSnapToneUpload();
  wireCreateSnapToneFromAudio();
  wireCreateSnapToneFromNam();
  wireInfoPopups();
  wireNamUpload();
  wireGp150DeviceDetection();

  // A user only ever has ONE pedal connected at a time -- so instead of a
  // separate "GP-150" section sitting below the GP-5/GP-50 one (the
  // original layout, correctly rejected by the user 2026-09-26: "Se ho
  // collegato una GP150, significa che NON ho collegato una GP50, quindi
  // la parte GP50 DEVE DIVENTARE LA PARTE 150"), the SnapTones/User IRs
  // sections themselves switch content based on which device WebMIDI
  // actually sees plugged in. NAM has no GP-50 equivalent, so its section
  // (and the upload forms, GP-150-only) simply appear/disappear outright.
  // Auto-detect on load and again on every hot-plug (`onstatechange`) --
  // no button, per the user's explicit choice over a manual toggle.
  function wireGp150DeviceDetection() {
    const stGrid = document.getElementById("st-grid");
    const stEmpty = document.getElementById("st-empty");
    const stView = document.getElementById("gp150-snaptones-view");
    const stSubtitle = document.getElementById("st-subtitle");
    const stCount = document.getElementById("st-count");
    const irGrid = document.getElementById("ir-grid");
    const irEmpty = document.getElementById("ir-empty");
    const irView = document.getElementById("gp150-user-irs-view");
    const irSubtitle = document.getElementById("ir-subtitle");
    const irCount = document.getElementById("ir-count");
    const namSection = document.getElementById("nam-section");
    const uploadSection = document.getElementById("gp150-upload-section");
    if (!stView || !irView) return; // section not present on this page

    function applyMode(isGp150) {
      if (stGrid) stGrid.hidden = isGp150;
      if (isGp150 && stEmpty) stEmpty.hidden = true;
      stView.hidden = !isGp150;
      if (irGrid) irGrid.hidden = isGp150;
      if (isGp150 && irEmpty) irEmpty.hidden = true;
      irView.hidden = !isGp150;
      if (namSection) namSection.hidden = !isGp150;
      if (uploadSection) uploadSection.hidden = !isGp150;
      if (stSubtitle) stSubtitle.textContent = isGp150 ? "read live over WebMIDI" : "your NAM captures";
      if (irSubtitle) irSubtitle.textContent = isGp150 ? "read live over WebMIDI" : "your uploaded cabs";
      // The GP-50 "(n)" counts are meaningless in GP-150 mode -- each
      // list's own "List X" button shows its own count once fetched.
      // Only ever blank them, never set a value, so device_a.js's own
      // render() (whenever it runs) stays the sole source of truth for
      // the real GP-50 numbers.
      if (isGp150 && stCount) stCount.textContent = "";
      if (isGp150 && irCount) irCount.textContent = "";
    }

    async function detect() {
      try {
        const access = await navigator.requestMIDIAccess({ sysex: true });
        const isGp150Port = (p) => (p.name || "").includes("GP-150");
        const hasGp150 = [...access.outputs.values()].some(isGp150Port) || [...access.inputs.values()].some(isGp150Port);
        applyMode(hasGp150);
        access.onstatechange = () => detect();
      } catch (e) {
        applyMode(false); // no MIDI access (denied/unsupported) -- default to the GP-50 view
      }
    }
    detect();
  }
})();
