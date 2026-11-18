"use strict";
/*
 * GP-150 Generate view (explorer page): Randomize and Morph. Each makes a preset body in the browser, shows its chain,
 * and can open it in the inspector or write it to a slot through the library's confirmed write
 * (GP150LibraryUI.writePlan: names what is overwritten, sends, reads the name back, updates the library).
 */
(() => {
  const root = document.getElementById("gp150-generate");
  const G = window.GP150Generate, L = window.GP150Library, F = window.GP150Format;
  if (!root || !G || !L || !F) return;

  const randomEl = document.getElementById("gp150-gen-random"), morphEl = document.getElementById("gp150-gen-morph");
  const errEl = document.getElementById("gp150-gen-error");
  const showError = (m) => { errEl.textContent = m; errEl.hidden = !m; };
  const prefix = (window.__VALETON_STATIC__ ? "data/" : "/static/data/");
  let ring = null, skeleton = null;
  const ready = Promise.all([
    fetch(prefix + "fxid_ring_gp150.json").then((r) => r.json()).then((j) => { ring = j; }),
    fetch(prefix + "gp150_skeleton.prst").then((r) => r.arrayBuffer()).then((b) => { skeleton = new Uint8Array(b); }),
  ]).catch(() => showError("Couldn't load the model catalog — Generate is unavailable."));

  function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function labeled(text, el) { const l = mk("label", "gp150-lib-check"); l.append(text + " ", el); return l; }
  function num(min, max, value) { const i = mk("input"); i.type = "number"; i.min = min; i.max = max; i.step = 1; i.value = value; return i; }
  const baseBody = () => L.emptyTemplate() || skeleton;
  const defaultTarget = () => { const s = L.lastEmptySlot(); return (s == null ? 199 : s) + 1; };

  // The result box shared by both: preview, target slot, open, write.
  function resultBox(parent, defaultName) {
    const preview = mk("div", "gp150-gen-preview subtitle", "Nothing yet.");
    const slot = num(1, 200, defaultTarget());
    let touched = false, body = null;
    slot.addEventListener("input", () => { touched = true; });
    const open = mk("button", null, "Open in inspector"); open.type = "button"; open.disabled = true;
    const write = mk("button", "primary", "Write to slot"); write.type = "button"; write.disabled = true;
    const row = mk("div", "gp150-live-row");
    row.append(labeled("Slot", slot), open, write);
    parent.append(preview, row);
    open.addEventListener("click", () => { if (body && window.GP150UI) window.GP150UI.openBody(body, `${F.readName(body) || defaultName}.prst`); });
    write.addEventListener("click", async () => {
      showError("");
      if (!body) return;
      const n = parseInt(slot.value, 10);
      if (!(n >= 1 && n <= 200)) { showError("Enter a slot number from 1 to 200."); return; }
      if (!window.GP150LibraryUI) { showError("The library view isn't available."); return; }
      try {
        const plan = L.planPut(n - 1, body);
        await window.GP150LibraryUI.writePlan(plan, { verb: `Write “${F.readName(body)}” to slot ${n}` });
      } catch (e) { showError(e.message); }
    });
    return {
      show(b, extra) {
        body = b;
        preview.textContent = "";
        if (!b) { preview.textContent = extra || "Nothing yet."; preview.className = "gp150-gen-preview subtitle"; open.disabled = write.disabled = true; return; }
        preview.className = "gp150-gen-preview";
        const d = L.describeBody(b);
        preview.appendChild(mk("span", "gp150-lib-name", d.name || "(unnamed)"));
        const chain = mk("span", "gp150-lib-chain");
        for (const c of d.chain) if (c.on) { const chip = mk("span", "gp150-lib-chip", c.label); chip.title = c.mod; chain.appendChild(chip); }
        preview.appendChild(chain);
        if (extra) preview.appendChild(mk("div", "subtitle", extra));
        open.disabled = write.disabled = false;
        if (!touched) slot.value = defaultTarget();
      },
    };
  }

  // ---- Randomize --------------------------------------------------------------------------------
  {
    randomEl.appendChild(mk("h3", null, "Randomize"));
    const baseSel = mk("select"); baseSel.append(new Option("an empty preset", "empty"), new Option("the preset in slot…", "slot"));
    const baseSlot = num(1, 200, 1); baseSlot.hidden = true;
    baseSel.addEventListener("change", () => { baseSlot.hidden = baseSel.value !== "slot"; });
    const mods = mk("div", "gp150-gen-mods");
    const checks = new Map();
    const NAMES = { PRE: "PRE", WAH: "WAH", DST: "DST", AMP: "AMP", CAB: "CAB", EQ: "EQ", MOD: "MOD", DLY: "DLY", RVB: "RVB" };
    for (const m of G.RANDOMIZABLE) { const c = mk("input"); c.type = "checkbox"; c.checked = true; checks.set(m, c); mods.appendChild(labeled(NAMES[m], c)); }
    const chaos = mk("input"); chaos.type = "range"; chaos.min = 0; chaos.max = 100; chaos.value = 60;
    const chaosOut = mk("output", null, "60%"); chaos.addEventListener("input", () => { chaosOut.textContent = `${chaos.value}%`; });
    const roll = mk("button", "primary", "Generate"); roll.type = "button";
    randomEl.append(labeled("Start from", baseSel), baseSlot, mods);
    const crow = mk("div", "gp150-live-row"); crow.append(labeled("Chaos", chaos), chaosOut, roll); randomEl.appendChild(crow);
    const box = resultBox(randomEl, "Random");
    roll.addEventListener("click", async () => {
      showError(""); await ready;
      try {
        let base = baseBody();
        if (baseSel.value === "slot") {
          const n = parseInt(baseSlot.value, 10);
          base = n >= 1 && n <= 200 ? L.get(n - 1) : null;
          if (!base) throw new Error(`slot ${baseSlot.value} isn't in the library yet`);
        }
        if (!base) throw new Error("no preset to start from yet — read the pedal's presets first");
        const chosen = G.RANDOMIZABLE.filter((m) => checks.get(m).checked);
        if (!chosen.length) throw new Error("tick at least one module");
        const { body, chain } = G.randomize({ ring, base, modules: chosen, chaos: Number(chaos.value) / 100 });
        box.show(body, `${chain.length} module${chain.length === 1 ? "" : "s"} on`);
      } catch (e) { showError(e.message); }
    });
    box.show(null, "Press Generate. Each press makes a different preset.");
  }

  // ---- Morph --------------------------------------------------------------------------------------
  {
    morphEl.appendChild(mk("h3", null, "Morph"));
    const a = num(1, 200, 1), b = num(1, 200, 2);
    const t = mk("input"); t.type = "range"; t.min = 0; t.max = 100; t.value = 50;
    const tOut = mk("output", null, "50%");
    const row = mk("div", "gp150-live-row"); row.append(labeled("From slot", a), labeled("to slot", b));
    const row2 = mk("div", "gp150-live-row"); row2.append(labeled("Amount", t), tOut);
    morphEl.append(row, row2);
    const box = resultBox(morphEl, "Morph");
    async function update() {
      showError(""); await ready;
      tOut.textContent = `${t.value}%`;
      const na = parseInt(a.value, 10), nb = parseInt(b.value, 10);
      const A = na >= 1 && na <= 200 ? L.get(na - 1) : null, B = nb >= 1 && nb <= 200 ? L.get(nb - 1) : null;
      if (!A || !B) { box.show(null, `Slot ${!A ? a.value : b.value} isn't in the library yet.`); return; }
      if (na === nb) { box.show(null, "Pick two different presets."); return; }
      const name = `Mrph ${na}~${nb}`;
      box.show(G.morph({ ring, a: A, b: B, t: Number(t.value) / 100, name }), "Models that differ switch over at 50%; the same model is blended.");
    }
    for (const el of [a, b, t]) el.addEventListener("input", update);
    let timer = null;   // the library changes in bursts while it fills: look again once it settles
    L.on(() => { if (timer == null) timer = setTimeout(() => { timer = null; update(); }, 250); });
    update();
  }
})();
