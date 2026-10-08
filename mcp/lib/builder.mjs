// Build a GP-150 patch from a plain description: resolves model and parameter names against the
// catalog, starts every used model from its catalog defaults, validates ranges, writes the result
// into the factory-empty skeleton and reads it back to check it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { G, ring, moduleKey, MODULES, decodePatch } from "./catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skeleton = new Uint8Array(readFileSync(resolve(root, "app/static/data/gp150_skeleton.prst")));
export const STANDARD_CHAIN = ["NR", "PRE", "WAH", "DST", "NS", "AMP", "CAB", "EQ", "MOD", "DLY", "RVB", "VOL"];

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9+]/g, "");

function modelsOf(module) {
  return Object.entries(ring)
    .filter(([fxid, e]) => moduleKey(e.module) === module && !(Number(fxid) === G.FXID_NONE && module !== "VOL"))
    .map(([fxid, e]) => ({ fxid: Number(fxid), entry: e, name: e.name || e.fxtitle || "" }));
}

export function resolveModel(module, ref) {
  const all = modelsOf(module);
  if (typeof ref === "number") {
    const hit = all.find((m) => m.fxid === ref);
    if (!hit) throw new Error(`${module}: fxid ${ref} is not a ${module} model`);
    return hit;
  }
  const q = norm(ref);
  const exact = all.filter((m) => norm(m.name) === q);
  if (exact.length === 1) return exact[0];
  const fuzzy = all.filter((m) => norm(m.name).includes(q) || norm(m.entry.origin || "").includes(q) || norm(m.entry.fxtitle || "").includes(q));
  if (fuzzy.length === 1) return fuzzy[0];
  const cands = (exact.length ? exact : fuzzy).slice(0, 8).map((m) => `${m.name} (${m.entry.origin || "-"})`);
  throw new Error(cands.length
    ? `${module}: "${ref}" is ambiguous — candidates: ${cands.join("; ")}`
    : `${module}: no model matches "${ref}" (use search_models)`);
}

function resolveParam(model, key) {
  const params = (model.entry.params || []).filter((p) => (p.algId ?? -1) >= 0);
  const q = norm(key);
  const hit = params.find((p) => norm(p.name) === q) || (params.filter((p) => norm(p.name).startsWith(q)).length === 1 ? params.find((p) => norm(p.name).startsWith(q)) : null);
  if (!hit) throw new Error(`${model.name}: no parameter "${key}" (has: ${params.map((p) => p.name).join(", ")})`);
  return hit;
}

function paramValue(model, p, raw, warnings) {
  let v = raw;
  if (typeof v === "boolean") v = v ? 1 : 0;
  if (typeof v === "string") {
    const i = (p.options || []).findIndex((o) => norm(o) === norm(v));
    if (i < 0) throw new Error(`${model.name} ${p.name}: "${raw}" is not one of ${(p.options || []).join(", ") || "(no named options)"}`);
    v = i;
  }
  if (!Number.isFinite(v)) throw new Error(`${model.name} ${p.name}: not a number`);
  const clamped = Math.min(Math.max(v, p.min), p.max);
  if (clamped !== v) warnings.push(`${model.name} ${p.name}: ${raw} is outside ${p.min}–${p.max}, set to ${clamped}`);
  return clamped;
}

export function buildPatch(spec) {
  const warnings = [];
  if (!spec.name || spec.name.length > G.NAME_MAX) throw new Error(`name must be 1–${G.NAME_MAX} characters`);
  if (!/^[\x20-\x7e]+$/.test(spec.name)) throw new Error("name must be plain ASCII");
  const chain = spec.chain || STANDARD_CHAIN;
  if (new Set(chain).size !== 12 || !chain.every((m) => MODULES.includes(m))) throw new Error("chain must list each of the 12 modules exactly once");

  const moduleModels = {}, moduleParams = {}, moduleEnabled = {};
  for (const [mod, cfg] of Object.entries(spec.modules || {})) {
    const module = mod.toUpperCase();
    if (!MODULES.includes(module)) throw new Error(`unknown module "${mod}" (use ${MODULES.join(", ")})`);
    const model = resolveModel(module, cfg.model);
    moduleModels[module] = model.fxid;
    const params = {};
    for (const p of model.entry.params || []) if ((p.algId ?? -1) >= 0 && p.default != null) params[p.algId] = p.default;
    for (const [k, raw] of Object.entries(cfg.params || {})) {
      const p = resolveParam(model, k);
      params[p.algId] = paramValue(model, p, raw, warnings);
    }
    moduleParams[module] = params;
    moduleEnabled[module] = cfg.enabled !== false;
  }
  // Modules the description leaves out stay unassigned and off (VOL keeps the skeleton's own state).
  for (const m of MODULES) if (!(m in moduleModels) && m !== "VOL") moduleEnabled[m] = false;

  const body = G.buildFromSkeleton(skeleton, { name: spec.name, chainOrder: chain, moduleModels, moduleParams, moduleEnabled });
  body[G.PATCH_INDEX_OFF] = 0;

  // read it back and compare with what was asked for
  const back = G.decode(body);
  if (back.name !== spec.name) throw new Error(`read-back mismatch: name ${back.name}`);
  if (chain.join() !== back.chainOrder.join()) throw new Error("read-back mismatch: chain order");
  for (const [m, fxid] of Object.entries(moduleModels)) {
    if (back.moduleModels[m] !== fxid || back.moduleEnabled[m] !== moduleEnabled[m]) throw new Error(`read-back mismatch: ${m}`);
    for (const [alg, v] of Object.entries(moduleParams[m])) {
      if (Math.abs(G.readModuleParamByAlgId(body, m, Number(alg)) - v) > 1e-4) throw new Error(`read-back mismatch: ${m} param ${alg}`);
    }
  }
  return { body, warnings, summary: decodePatch(body) };
}

// ---- editing an existing patch -----------------------------------------------------------------
const flat = (summary) => {
  const out = { name: summary.name, chain: summary.chain.join(" ") };
  for (const [m, v] of Object.entries(summary.modules)) {
    out[`${m}.enabled`] = v.enabled; out[`${m}.model`] = v.model;
    for (const [k, x] of Object.entries(v.params)) out[`${m}.${k}`] = x;
  }
  return out;
};

// Apply `changes` ({name?, chain?, modules?: {MOD: {model?, enabled?, params?}}}) to a copy of `body`.
export function editPatch(body, changes) {
  const warnings = [];
  const out = new Uint8Array(body);
  const before = decodePatch(body);
  if (changes.name != null) {
    if (!changes.name || changes.name.length > G.NAME_MAX || !/^[\x20-\x7e]+$/.test(changes.name)) throw new Error(`name must be 1–${G.NAME_MAX} plain ASCII characters`);
    G.writeName(out, changes.name);
  }
  if (changes.chain != null) {
    if (new Set(changes.chain).size !== 12 || !changes.chain.every((m) => MODULES.includes(m))) throw new Error("chain must list each of the 12 modules exactly once");
    G.writeOrder(out, changes.chain);
  }
  for (const [mod, cfg] of Object.entries(changes.modules || {})) {
    const module = mod.toUpperCase();
    if (!MODULES.includes(module)) throw new Error(`unknown module "${mod}" (use ${MODULES.join(", ")})`);
    let fxid = G.readModuleModel(out, module);
    const hadModel = !(fxid === G.FXID_NONE && module !== "VOL");
    let model = null;
    if (cfg.model != null) {
      model = resolveModel(module, cfg.model);
      if (model.fxid !== fxid) {                        // a different model: start from its defaults
        fxid = model.fxid;
        G.writeModuleModel(out, module, fxid);
        for (const p of model.entry.params || []) if ((p.algId ?? -1) >= 0 && p.default != null) G.writeModuleParamByAlgId(out, module, p.algId, p.default);
      }
    } else if (!(fxid === G.FXID_NONE && module !== "VOL") && ring[String(fxid)]) {
      model = { fxid, entry: ring[String(fxid)], name: ring[String(fxid)].name || ring[String(fxid)].fxtitle };
    }
    if (!model && (cfg.params || cfg.enabled === true)) throw new Error(`${module} holds no model — give "model" to set one`);
    for (const [k, raw] of Object.entries(cfg.params || {})) {
      const p = resolveParam(model, k);
      G.writeModuleParamByAlgId(out, module, p.algId, paramValue(model, p, raw, warnings));
    }
    if (cfg.enabled != null) G.writeModuleEnabled(out, module, cfg.enabled);
    else if (cfg.model != null && !hadModel) G.writeModuleEnabled(out, module, true);   // a module that just got its first model is switched on
  }
  const after = decodePatch(out);
  const fb = flat(before), fa = flat(after);
  const diff = Object.keys({ ...fb, ...fa }).filter((k) => fb[k] !== fa[k]).map((k) => `${k}: ${fb[k] ?? "–"} → ${fa[k] ?? "–"}`);
  return { body: out, warnings, summary: after, changes: diff };
}
