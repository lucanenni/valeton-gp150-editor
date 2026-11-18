"use strict";
/*
 * Command palette (Ctrl+K / ⌘K) for the explorer page: type to find a preset (name, slot, any model, tag) or an action,
 * arrow keys to move, Enter to run, Esc to close. On a preset, Enter opens it in the inspector and Shift+Enter selects
 * it on the pedal. Actions jump to a section, start a backup or a read, or open stage mode on a setlist.
 *
 * The palette builds its own overlay on first use and only calls what the page already offers (GP150Library, GP150UI,
 * WebMidiGP150, the buttons of the other sections), so it works on whatever of those is present.
 */
(() => {
  const L = window.GP150Library;
  if (!L) return;
  const doc = document;
  const pad = (n) => String(n).padStart(3, "0");
  const MAX_PRESETS = 30;

  let overlay = null, input = null, list = null, hint = null;
  let items = [], sel = 0, returnFocus = null, query = "";

  function mk(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const toast = (m, kind) => { try { window.UI && window.UI.toast(m, kind); } catch { /* no toast */ } };
  const byId = (id) => doc.getElementById(id);
  function goTo(id) { const el = byId(id); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" }); return el; }
  function press(id) { const b = byId(id); if (b && !b.disabled) b.click(); }

  // ---- what can be found -----------------------------------------------------------------------
  function presetItems(q) {
    let found = L.search(q);
    if (!q.trim()) found = [...found.filter((s) => s.star), ...found.filter((s) => !s.star)];
    return found.slice(0, MAX_PRESETS).map((s) => ({
      kind: s.star ? "★ preset" : "preset",
      label: `${pad(s.slot)}  ${s.name || "(unnamed)"}`,
      sub: [...s.tags.map((t) => `#${t}`), ...s.chain.filter((c) => c.on).map((c) => c.label)].join(" · "),
      run(mode) {
        const body = L.get(s.slot - 1);
        if (!body) return;
        if (mode === "pedal") return selectOnPedal(s.slot - 1, `${pad(s.slot)} ${s.name}`);
        if (window.GP150UI) { window.GP150UI.openBody(body, `library-slot${pad(s.slot)}.prst`); goTo("gp150-results"); }
      },
    }));
  }
  async function selectOnPedal(slot0, label) {
    const W = window.WebMidiGP150, U = window.GP150Usage;
    try {
      if (!W) throw new Error("Web MIDI isn't available in this browser.");
      if (!W.isConnected()) await W.connect();
      const send = async () => W.selectPreset(slot0);
      if (U && U.exclusive) await U.exclusive(send); else await send();
      toast(`Selected ${label} on the pedal.`, "ok");
    } catch (e) { toast(e.message, "err"); }
  }

  const SECTIONS = [["Library", "gp150-library"], ["Generate (Randomize, Morph)", "gp150-generate"], ["Settings", "gp150-settings"], ["Block library", "gp150-block-library"], ["Inspector", "gp150-results"]];
  function actionItems() {
    const out = [];
    for (const [name, id] of SECTIONS) if (byId(id)) out.push({ kind: "go to", label: name, sub: "", keywords: "section jump", run: () => goTo(id) });
    const act = (label, sub, keywords, fn, needs) => { if (!needs || byId(needs)) out.push({ kind: "action", label, sub, keywords, run: fn }); };
    act("Back up all presets (.zip)", "download a zip of every preset", "backup download save", () => { goTo("gp150-library"); press("gp150-lib-backup-all"); }, "gp150-lib-backup-all");
    act("Re-read all presets", "ask the pedal for every preset again", "rescan refresh scan", () => { goTo("gp150-library"); press("gp150-lib-rescan"); }, "gp150-lib-rescan");
    act("Restore from backup…", "pick a zip or .prst files", "import upload", () => { goTo("gp150-library"); press("gp150-lib-restore-btn"); }, "gp150-lib-restore-btn");
    act("Read the pedal's settings", "the global menu", "settings global read", () => { goTo("gp150-settings"); press("gp150-settings-read"); }, "gp150-settings-read");
    act("Randomize a new preset", "make a random preset to look at", "random generate new", () => {
      goTo("gp150-generate"); const g = [...doc.querySelectorAll("#gp150-gen-random button")].find((b) => b.textContent === "Generate"); if (g) g.click();
    }, "gp150-gen-random");
    const UI = window.GP150LibraryUI;
    if (UI && UI.startStage) {
      for (const sl of L.listSetlists()) if (sl.slots.length) out.push({ kind: "stage", label: `Stage mode: ${sl.name}`, sub: `${sl.slots.length} presets`, keywords: "setlist gig live", run: () => { UI.startStage(sl.id); goTo("gp150-lib-setlists"); } });
    }
    return out;
  }
  const matches = (it, words) => { const hay = `${it.kind} ${it.label} ${it.sub || ""} ${it.keywords || ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); };

  function compute() {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const actions = actionItems().filter((a) => !words.length ? false : matches(a, words));
    const presets = presetItems(query);
    // actions first when the words name one outright, presets otherwise; with no query: presets, then the commands
    items = words.length ? [...actions, ...presets] : [...presets.slice(0, 8), ...actionItems()];
    sel = 0;
  }

  // ---- the overlay -------------------------------------------------------------------------------
  function build() {
    if (overlay) return;
    overlay = mk("div", "modal-overlay"); overlay.hidden = true;
    const card = mk("div", "modal-card gp150-palette");
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", "Command palette");
    input = mk("input", "modal-input"); input.type = "text"; input.autocomplete = "off"; input.spellcheck = false;
    input.placeholder = "Search presets, models, tags — or type an action";
    input.setAttribute("role", "combobox"); input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-controls", "gp150-palette-list");
    list = mk("ul", "gp150-palette-list"); list.id = "gp150-palette-list"; list.setAttribute("role", "listbox");
    hint = mk("div", "gp150-palette-hint", "↑↓ to move · Enter opens a preset in the inspector · Shift+Enter selects it on the pedal · Esc closes");
    card.append(input, list, hint);
    overlay.appendChild(card);
    doc.body.appendChild(overlay);
    input.addEventListener("input", () => { query = input.value; compute(); render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); run(e.shiftKey ? "pedal" : "open"); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Tab") e.preventDefault();   // keep focus in the box
    });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  }

  function render() {
    list.textContent = "";
    items.forEach((it, i) => {
      const li = mk("li", "gp150-palette-item");
      li.setAttribute("role", "option"); li.id = `gp150-palette-opt-${i}`; li.setAttribute("aria-selected", i === sel ? "true" : "false");
      li.append(mk("span", "gp150-palette-kind", it.kind), mk("span", "gp150-palette-label", it.label), mk("span", "gp150-palette-sub", it.sub || ""));
      li.addEventListener("click", () => { sel = i; run("open"); });
      list.appendChild(li);
    });
    if (!items.length) list.appendChild(mk("li", "gp150-palette-hint", L.count() ? "Nothing matches." : "The library is empty — connect to the pedal first."));
    input.setAttribute("aria-activedescendant", items.length ? `gp150-palette-opt-${sel}` : "");
    const cur = list.children[sel];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
  function move(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", i === sel ? "true" : "false"));
    input.setAttribute("aria-activedescendant", `gp150-palette-opt-${sel}`);
    const cur = list.children[sel]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
  function run(mode) {
    const it = items[sel]; if (!it) return;
    close();
    try { it.run(mode); } catch (e) { toast(e.message, "err"); }
  }
  function open() {
    build();
    returnFocus = doc.activeElement;
    query = ""; input.value = ""; compute(); overlay.hidden = false; render();
    input.focus();
  }
  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    if (returnFocus && returnFocus.focus) { try { returnFocus.focus(); } catch { /* gone */ } }
  }

  doc.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (overlay && !overlay.hidden) close(); else open();
    }
  });
  window.GP150Palette = { open, close, isOpen: () => !!overlay && !overlay.hidden };
})();
