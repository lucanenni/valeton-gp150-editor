"use strict";

// GP-50/GP-5 -> GP-150 converter UI (GP150-8: moved out of gp150.js into its
// own file so it can live on the Preset Converter page alongside the
// existing GP-5<->GP-50 section, instead of GP-150's own now-removed page).
// Fully client-side (window.PRST + window.GP150Format + window.ConvertGp150 —
// ports of patch/prst_format.py, gp150_format.py, and convert_gp50_to_gp150.py;
// see PLAT-2 in BACKLOG_GP150.md). Needs elements with ids gp150-convert-drop/
// -input/-pick-btn/-error/-list present on the page.
(() => {
  const drop = document.getElementById("gp150-convert-drop");
  if (!drop) return; // section not present on this page

  const input = document.getElementById("gp150-convert-input");
  const pickBtn = document.getElementById("gp150-convert-pick-btn");
  const errEl = document.getElementById("gp150-convert-error");
  const listEl = document.getElementById("gp150-convert-list");

  // Resolve the data dir relative to THIS script's own URL — same trick as
  // gp150.js/static_api.js's DATA_BASE, so this works wherever the script is
  // loaded from.
  const DATA_BASE = (() => {
    try { const s = document.currentScript && document.currentScript.src; if (s) return new URL("data/", s).href; } catch { /* fall through */ }
    return "/static/data/";
  })();
  const dataUrl = (f) => new URL(f, DATA_BASE).href;

  let convertDataPromise = null;
  function getConvertData() {
    if (!convertDataPromise) {
      convertDataPromise = Promise.all([
        fetch(dataUrl("fxid_ring.json")).then((r) => r.json()),
        fetch(dataUrl("fxid_ring_gp5.json")).then((r) => r.json()),
        fetch(dataUrl("fxid_ring_gp150.json")).then((r) => r.json()),
        fetch(dataUrl("gp50_to_gp150_model_map.json")).then((r) => r.json()),
        fetch(dataUrl("gp150_skeleton.prst")).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
      ]).then(([gp50Ring, gp5Ring, gp150Ring, modelMap, skeleton]) => ({
        rings: { gp50: gp50Ring, gp5: gp5Ring }, gp150Ring, modelMap, skeleton,
      }));
    }
    return convertDataPromise;
  }

  function showConvertError(msg) {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith(".prst"));
    showConvertError("");
    if (!files.length) return;

    let data;
    try {
      data = await getConvertData();
    } catch (e) {
      showConvertError(`Could not load converter data: ${e.message}`);
      return;
    }

    for (const file of files) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${file.name} — converting…`;
      li.appendChild(label);
      listEl.prepend(li);

      let bytes, src, result;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
        src = window.PRST.detect(bytes);
        if (src.key !== "gp50" && src.key !== "gp5") {
          throw new Error(`source is ${src.name}, not GP-5/GP-50`);
        }
        result = window.ConvertGp150.convert(bytes, {
          skeleton: data.skeleton,
          gp50Ring: data.rings[src.key],
          gp150Ring: data.gp150Ring,
          modelMap: data.modelMap,
        });
      } catch (e) {
        label.textContent = `${file.name} — ${e.message}`;
        continue;
      }

      const patchName = window.PRST.readName(bytes);
      const unmappedNote = result.unmapped.length
        ? ` — no GP-150 equivalent for: ${result.unmapped.map((u) => `${u.module} (${u.gp50Name})`).join(", ")}, fix in Suite after import`
        : "";
      label.textContent = `${patchName} (${src.name})${unmappedNote}`;

      const downloadBtn = document.createElement("button");
      downloadBtn.type = "button";
      downloadBtn.textContent = "Download GP-150 .prst";
      downloadBtn.addEventListener("click", () => {
        const blob = new Blob([result.prst], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name.replace(/\.prst$/i, "") + "__GP-150.prst";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
      li.appendChild(downloadBtn);
    }
  }

  pickBtn.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { handleFiles(input.files); input.value = ""; });
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag-over"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag-over"); })
  );
  drop.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
})();
