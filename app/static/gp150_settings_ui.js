"use strict";
/*
 * GP-150 Settings view (explorer page): read the pedal's global menu, edit, write back, check.
 *
 * "Write changes" re-reads the settings right before sending (so nothing the pedal changed in the meantime is lost),
 * replaces only the edited numbers in each affected record, sends those records, waits, reads again and compares.
 * It runs between two requests of the background preset scan (GP150Usage.exclusive).
 */
(() => {
  const root = document.getElementById("gp150-settings");
  const S = window.GP150Settings, W = window.WebMidiGP150, U = window.GP150Usage;
  if (!root || !S) return;

  const $ = (id) => document.getElementById(id);
  const readBtn = $("gp150-settings-read"), writeBtn = $("gp150-settings-write"), revertBtn = $("gp150-settings-revert");
  const statusEl = $("gp150-settings-status"), errEl = $("gp150-settings-error"), groupsEl = $("gp150-settings-groups");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SEND_GAP_MS = 800, SETTLE_MS = 1200;
  const showError = (m) => { errEl.textContent = m; errEl.hidden = !m; };
  const exclusive = (fn) => (U && U.exclusive ? U.exclusive(fn) : fn());

  let current = null;       // {firmware, records, values}: what the pedal held when last read
  let edits = new Map();    // setting name -> new value
  const controls = new Map();

  function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function refreshButtons() {
    writeBtn.disabled = !current || edits.size === 0;
    revertBtn.disabled = edits.size === 0;
    writeBtn.textContent = edits.size ? `Write ${edits.size} change${edits.size === 1 ? "" : "s"}` : "Write changes";
    for (const [name, c] of controls) c.row.classList.toggle("dirty", edits.has(name));
  }

  function render() {
    groupsEl.textContent = "";
    controls.clear();
    if (!current) return;
    for (const [gid, gname] of S.GROUPS) {
      const specs = S.SPECS.filter((s) => s.group === gid && current.values[s.name] != null);
      if (!specs.length) continue;
      const box = mk("div", "gp150-settings-group");
      box.appendChild(mk("h3", null, gname));
      const grid = mk("div", "gp150-settings-grid");
      for (const s of specs) {
        const row = mk("div", "gp150-setting");
        const id = `gp150-set-${s.name}`;
        const lab = mk("label", null, s.label); lab.htmlFor = id;
        const val = edits.has(s.name) ? edits.get(s.name) : current.values[s.name];
        let input;
        if (s.kind === "enum") {
          input = mk("select");
          s.labels.forEach((t, i) => input.appendChild(new Option(t, String(i))));
          if (!s.labels[val]) input.appendChild(new Option(`#${val} (as set on the pedal)`, String(val)));
          input.value = String(val);
        } else {
          input = mk("input"); input.type = "number"; input.min = s.min; input.max = s.max; input.step = 1; input.value = String(val);
          input.title = `${s.min} to ${s.max}${s.unit ? " " + s.unit : ""}`;
        }
        input.id = id;
        input.addEventListener("change", () => {
          const n = Number(input.value);
          if (!Number.isInteger(n) || n < s.min || n > s.max) { showError(`${s.label}: enter a whole number from ${s.min} to ${s.max}.`); input.value = String(edits.has(s.name) ? edits.get(s.name) : current.values[s.name]); return; }
          showError("");
          if (n === current.values[s.name]) edits.delete(s.name); else edits.set(s.name, n);
          refreshButtons();
        });
        row.append(lab, input);
        grid.appendChild(row);
        controls.set(s.name, { row, input });
      }
      box.appendChild(grid);
      groupsEl.appendChild(box);
    }
    const eq = S.eqValues(current.records.get(0x2010));
    if (eq) groupsEl.appendChild(mk("p", "subtitle", `Global EQ level ${eq.level}; its 30 band values are not editable here.`));
    refreshButtons();
  }

  async function load() {
    if (!W) throw new Error("Web MIDI isn't available in this browser.");
    if (!W.isConnected()) await W.connect();
    const g = await exclusive(async () => W.readGlobals());
    return { firmware: g.firmware, records: g.records, values: S.valuesOf(g.records) };
  }

  readBtn.addEventListener("click", async () => {
    showError(""); readBtn.disabled = true; statusEl.textContent = "Reading…";
    try {
      current = await load(); edits = new Map();
      statusEl.textContent = `Firmware V${current.firmware} · ${Object.keys(current.values).length} settings`;
      render();
    } catch (e) { showError(e.message); statusEl.textContent = ""; }
    finally { readBtn.disabled = false; }
  });
  revertBtn.addEventListener("click", () => { edits = new Map(); render(); });

  writeBtn.addEventListener("click", async () => {
    if (!current || !edits.size) return;
    const lines = [...edits].map(([n, v]) => `${S.BY_NAME[n].label}: ${S.label(n, current.values[n])} → ${S.label(n, v)}`);
    const ok = await window.UI.confirmDialog(`Write ${edits.size} setting${edits.size === 1 ? "" : "s"} to the pedal?\n${lines.join("\n")}`, "Write to pedal");
    if (!ok) return;
    showError(""); writeBtn.disabled = readBtn.disabled = revertBtn.disabled = true;
    try {
      statusEl.textContent = "Checking what the pedal holds now…";
      const fresh = await load();                           // never write over a stale copy
      const byRecord = new Map();
      for (const [name, value] of edits) {
        const spec = S.BY_NAME[name];
        byRecord.set(spec.cmd, S.withValue(byRecord.get(spec.cmd) || fresh.records.get(spec.cmd), name, value));
      }
      await exclusive(async () => {
        let n = 0;
        for (const [cmd, record] of byRecord) {
          statusEl.textContent = `Writing ${++n}/${byRecord.size}…`;
          W.sendSetRecord(cmd, record);
          await sleep(SEND_GAP_MS);
        }
      });
      statusEl.textContent = "Checking…"; await sleep(SETTLE_MS);
      const after = await load();
      const wrong = [...edits].filter(([n, v]) => after.values[n] !== v);
      current = after;
      if (wrong.length) {
        showError(`Sent, but ${wrong.map(([n, v]) => `${S.BY_NAME[n].label} reads ${S.label(n, after.values[n])} (wanted ${S.label(n, v)})`).join("; ")}. Check the pedal's menu.`);
        edits = new Map(wrong.map(([n, v]) => [n, v]));
      } else {
        window.UI.toast(`${edits.size} setting${edits.size === 1 ? "" : "s"} written — read back correctly.`, "ok");
        edits = new Map();
      }
      statusEl.textContent = `Firmware V${after.firmware} · ${Object.keys(after.values).length} settings`;
      render();
    } catch (e) {
      showError(`Stopped: ${e.message}. Some changes may already have been sent — read the settings again.`);
      statusEl.textContent = "";
    } finally { readBtn.disabled = false; refreshButtons(); }
  });
})();
