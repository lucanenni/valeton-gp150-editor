"use strict";
/*
 * GP-150 preset generation: Randomize and Morph. Pure functions on 1128-byte preset bodies and the model catalog
 * (data/fxid_ring_gp150.json); nothing here talks to the pedal.
 *
 *   randomize({ring, base, modules, chaos, rng})  -> {body, chain}   a new preset built on `base`
 *   morph({ring, a, b, t})                        -> body             a preset between two others (t 0 = a, 1 = b)
 *
 * Randomize picks catalog models only (never SnapTones, NAM or User IR references, which depend on what is stored on
 * the pedal) and keeps every parameter inside its catalog range. Level-like parameters (Volume, Level, Mix ...) stay close
 * to the model's default, so a random preset is never much louder than a normal one. Morph mixes the parameters of the
 * modules that hold the same model in both presets and, where the models differ, takes the whole module from the nearer
 * preset; the chain order, on/off flags and every other byte come from the nearer one too.
 *
 * Browser global GP150Generate; module.exports under node.
 */
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const F = isNode ? require("./gp150_format.js") : root.GP150Format;

  const RANDOMIZABLE = Object.freeze(["PRE", "WAH", "DST", "AMP", "CAB", "EQ", "MOD", "DLY", "RVB"]);
  const ALWAYS_ON = new Set(["AMP", "CAB"]);
  const ON_PROBABILITY = { PRE: 0.3, WAH: 0.15, DST: 0.5, EQ: 0.4, MOD: 0.4, DLY: 0.5, RVB: 0.6 };
  const LEVELISH = /^(volume|level|master|mix|dry|wet|blend|output)$/i;
  const PARAM_SLOTS = 15;   // floats in one module's parameter block

  function seeded(seed) {   // mulberry32: a small repeatable generator for tests and "same seed, same preset"
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  const moduleKey = (m) => (m === "N->S" ? "NS" : m);
  function catalogByModule(ring) {
    const out = {};
    for (const [k, e] of Object.entries(ring)) {
      const mod = moduleKey(e.module), fxid = Number(k);
      if (!RANDOMIZABLE.includes(mod)) continue;
      if (mod === "CAB" && (fxid >>> 24) === 0x0a && ((fxid >>> 16) & 0xff) === 0x10) continue;   // a User IR slot, not a model
      (out[mod] ||= []).push({ fxid, entry: e });
    }
    return out;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function snap(v, p) {
    const step = p.step > 0 ? p.step : 1;
    const s = Math.round((v - p.min) / step) * step + p.min;
    return Number(clamp(s, p.min, p.max).toFixed(4));
  }
  function randomValue(p, rng, chaos) {
    const def = clamp(p.default ?? p.min, p.min, p.max);
    if (p.toggle) return rng() < chaos * 0.5 ? (def ? 0 : 1) : def;
    if (p.options && p.options.length) return rng() < chaos ? p.min + Math.floor(rng() * p.options.length) : def;
    const range = p.max - p.min;
    if (LEVELISH.test(p.name)) return snap(def + (rng() * 2 - 1) * 0.15 * range * chaos, p);
    return snap(def + (p.min + rng() * range - def) * chaos, p);
  }

  function randomize({ ring, base, modules = RANDOMIZABLE, chaos = 0.6, rng = Math.random, name } = {}) {
    if (!ring) throw new Error("the model catalog is not loaded");
    F.checkLength(base);
    const cat = catalogByModule(ring);
    const out = new Uint8Array(base);
    const chain = [];
    for (const mod of RANDOMIZABLE) {
      if (!modules.includes(mod) || !cat[mod] || !cat[mod].length) continue;
      const on = ALWAYS_ON.has(mod) || rng() < (ON_PROBABILITY[mod] ?? 0.3);
      if (!on) { F.writeModuleEnabled(out, mod, false); continue; }
      const pick = cat[mod][Math.floor(rng() * cat[mod].length)];
      F.writeModuleModel(out, mod, pick.fxid);
      for (let i = 0; i < PARAM_SLOTS; i++) F.writeModuleParamByAlgId(out, mod, i, 0);   // nothing left over from the previous model
      for (const p of pick.entry.params || []) if ((p.algId ?? -1) >= 0) F.writeModuleParamByAlgId(out, mod, p.algId, randomValue(p, rng, chaos));
      F.writeModuleEnabled(out, mod, true);
      chain.push({ mod, name: pick.entry.name });
    }
    F.writeName(out, (name ?? `Rnd ${String(Math.floor(rng() * 1000)).padStart(3, "0")}`).slice(0, F.NAME_MAX));
    F.fixChecksum(out);
    return { body: out, chain };
  }

  function morph({ ring, a, b, t, name } = {}) {
    if (!ring) throw new Error("the model catalog is not loaded");
    F.checkLength(a); F.checkLength(b);
    if (!(t >= 0 && t <= 1)) throw new RangeError("t must be between 0 and 1");
    const out = new Uint8Array(t < 0.5 ? a : b);
    const A = F.decode(a), B = F.decode(b);
    for (const mod of F.MODULE_NAMES) {
      const fx = A.moduleModels[mod];
      if (fx !== B.moduleModels[mod]) continue;
      const entry = ring[String(fx)];
      for (const p of (entry && entry.params) || []) {
        if ((p.algId ?? -1) < 0 || p.toggle || (p.options && p.options.length)) continue;
        const va = F.readModuleParamByAlgId(a, mod, p.algId), vb = F.readModuleParamByAlgId(b, mod, p.algId);
        if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
        F.writeModuleParamByAlgId(out, mod, p.algId, snap(va + (vb - va) * t, p));
      }
    }
    F.writePatchVolume(out, Math.round(A.patchVolume + (B.patchVolume - A.patchVolume) * t));
    if (name != null) F.writeName(out, name.slice(0, F.NAME_MAX));
    F.fixChecksum(out);
    return out;
  }

  const API = { RANDOMIZABLE, randomize, morph, seeded, catalogByModule };
  if (isNode) module.exports = API; else root.GP150Generate = API;
})(typeof window !== "undefined" ? window : globalThis);
