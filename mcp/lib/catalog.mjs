// GP-150 effect catalog (patch/fxid_ring_gp150.json) and patch decoding for the MCP tools.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const G = require(resolve(root, "app/static/gp150_format.js"));
export const ring = JSON.parse(readFileSync(resolve(root, "patch/fxid_ring_gp150.json"), "utf8"));

export const MODULES = ["NR", "PRE", "WAH", "DST", "NS", "AMP", "CAB", "EQ", "MOD", "DLY", "RVB", "VOL"];
export const moduleKey = (m) => (m === "N->S" ? "NS" : m);

function modelEntry(fxid, module) {
  if (fxid === G.FXID_NONE && module !== "VOL") return null;
  return ring[String(fxid)] || null;
}

function describeParam(p) {
  return {
    name: p.name, algId: p.algId, min: p.min, max: p.max, default: p.default, step: p.step, unit: p.unit || "",
    ...(p.options && p.options.length ? { options: p.options } : {}),
    ...(p.toggle ? { toggle: true } : {}),
  };
}

export function describeModel(fxid) {
  const e = ring[String(fxid)];
  if (!e) return null;
  return {
    fxid: Number(fxid), module: moduleKey(e.module), name: e.name || e.fxtitle, description: e.fxtitle || "", origin: e.origin || "",
    params: (e.params || []).filter((p) => (p.algId ?? -1) >= 0).map(describeParam),
  };
}

export function searchModels({ module, query, limit = 25 } = {}) {
  const q = (query || "").toLowerCase().trim();
  const out = [];
  for (const [fxid, e] of Object.entries(ring)) {
    const mod = moduleKey(e.module);
    if (!mod || (Number(fxid) === G.FXID_NONE && mod !== "VOL")) continue;
    if (module && mod !== module.toUpperCase()) continue;
    const hay = `${e.name || ""} ${e.fxtitle || ""} ${e.origin || ""} ${e.type || ""}`.toLowerCase();
    if (q && !q.split(/\s+/).every((w) => hay.includes(w))) continue;
    out.push({ fxid: Number(fxid), module: mod, name: e.name || e.fxtitle, origin: e.origin || "", type: e.type || "", params: (e.params || []).filter((p) => (p.algId ?? -1) >= 0).map((p) => p.name) });
  }
  out.sort((a, b) => (a.module === b.module ? a.name.localeCompare(b.name) : MODULES.indexOf(a.module) - MODULES.indexOf(b.module)));
  return { total: out.length, models: out.slice(0, limit) };
}

// Human-readable decode of a 1128-byte .prst body
export function decodePatch(body) {
  const p = G.decode(body);
  const modules = {};
  for (const mod of p.chainOrder) {
    const fxid = p.moduleModels[mod];
    const e = modelEntry(fxid, mod);
    const params = {};
    if (e) for (const prm of e.params || []) if ((prm.algId ?? -1) >= 0) {
      const v = G.readModuleParamByAlgId(body, mod, prm.algId);
      params[prm.name] = prm.options && prm.options.length ? (prm.options[Math.round(v)] ?? v) : Math.round(v * 100) / 100;
    }
    modules[mod] = { enabled: !!p.moduleEnabled[mod], model: e ? (e.name || e.fxtitle) : null, fxid, origin: e ? e.origin || "" : "", params };
  }
  return {
    slot: p.slotIndex + 1, name: p.name, chain: p.chainOrder, modules,
    settings: { bpm: p.presetBpm, patchVolume: p.patchVolume },
  };
}
