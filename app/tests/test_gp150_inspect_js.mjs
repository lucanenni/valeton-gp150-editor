/*
 * Byte-for-byte parity check: app/static/gp150_format.js's decode side (as
 * used by gp150.js's decodeGp150()/getModelsCatalog()) vs the Python oracle
 * (patch/gp150_format.py + app/api_device.py's _gp150_model_entry() logic)
 * over the real 200-file GP-150 export corpus.
 *
 *   node app/tests/test_gp150_inspect_js.mjs            # auto-runs gp150_inspect_oracle.py
 *   node app/tests/test_gp150_inspect_js.mjs foo.json    # verify a pre-built manifest
 *
 * This locks in PLAT-2's GP-150 inspect port (gp150.js no longer calls
 * POST /api/device/gp150/inspect or GET /api/device/gp150/models) — see the
 * sibling test_gp150_convert_js.mjs for the converter half of that port.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const G150 = require(resolve(here, "../static/gp150_format.js"));

function loadManifest() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(readFileSync(arg, "utf8"));
  const py = [".venv-app/bin/python", ".venv-midi/bin/python", "python3"]
    .map((p) => (p.includes("/") ? resolve(repoRoot, p) : p))
    .find((p) => !p.includes("/") || existsSync(p)) || "python3";
  const oracle = resolve(here, "gp150_inspect_oracle.py");
  const json = execFileSync(py, [oracle], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(json.toString("utf8"));
}

const fromB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

let pass = 0, fail = 0;
const fails = [];
const check = (path, label, ok, detail) => {
  if (ok) { pass++; return; }
  fail++; fails.push(`${path} :: ${label}${detail ? " — " + detail : ""}`);
};

// Mirrors gp150.js's gp150ModelEntry()/decodeGp150() exactly (kept in sync
// by hand — this is a test, not a require() of the page script, since
// gp150.js is a page-init IIFE with no exports).
function modelEntry(ring, fxid, module) {
  if (fxid === G150.FXID_NONE && module !== "VOL") return null;
  return ring[String(fxid)] || null;
}
function decodeGp150(bytes, ring) {
  const patch = G150.decode(bytes);
  const modules = {};
  for (const [mod, fxid] of Object.entries(patch.moduleModels)) {
    const entry = modelEntry(ring, fxid, mod);
    const params = [];
    if (entry) {
      for (const p of entry.params || []) {
        if ((p.algId ?? -1) < 0) continue;
        params.push({
          name: p.name, algId: p.algId,
          value: G150.readModuleParamByAlgId(bytes, mod, p.algId),
          min: p.min, max: p.max, unit: p.unit || "", toggle: !!p.toggle,
        });
      }
    }
    modules[mod] = { fxid, model_name: entry ? (entry.name || entry.fxtitle) : null, origin: entry ? entry.origin : null, enabled: patch.moduleEnabled[mod], params };
  }
  return { slot_index: patch.slotIndex, patch_name: patch.name, chain_order: patch.chainOrder, modules };
}
function modelsByModule(ring) {
  const byModule = {};
  for (const [fxidStr, entry] of Object.entries(ring)) {
    const fxid = Number(fxidStr);
    let module = entry.module;
    if (module === "N->S") module = "NS";
    if (!module) continue;
    if (fxid === G150.FXID_NONE && module !== "VOL") continue;
    (byModule[module] ||= []).push({ fxid, name: entry.name || entry.fxtitle || "", origin: entry.origin || "" });
  }
  for (const list of Object.values(byModule)) list.sort((a, z) => (a.name < z.name ? -1 : a.name > z.name ? 1 : 0));
  return byModule;
}

const manifest = loadManifest();
if (!manifest.records.length) {
  console.error("no GP-150 test corpus files found — nothing to verify");
  process.exit(1);
}

// need the actual ring JSON (not just modelsByModule) for decodeGp150()
const ring = JSON.parse(readFileSync(resolve(repoRoot, "patch/fxid_ring_gp150.json"), "utf8"));

for (const rec of manifest.records) {
  const prst = fromB64(rec.prstB64);
  let got;
  try {
    got = decodeGp150(prst, ring);
  } catch (e) {
    check(rec.path, "decode", false, e.message);
    continue;
  }
  check(rec.path, "inspect", JSON.stringify(got) === JSON.stringify(rec.expected),
    JSON.stringify(got) !== JSON.stringify(rec.expected) ? "mismatch" : undefined);
}

// Compared key-by-key, not via a single JSON.stringify of the whole object:
// ring's own keys are fxid numbers, and JS objects always enumerate
// integer-like string keys in ascending numeric order regardless of
// insertion order (unlike Python dicts, which preserve JSON file order) —
// so Object.entries(ring) and Python's ring.items() walk fxids in a
// different order. That only affects which module name is "first seen"
// (i.e. this dict-of-lists' own top-level key order), not any value —
// each module's own list is independently sorted by name and compared
// exactly below, and object property order was never meaningful to
// gp150.js's only consumer (modelsCatalog[mod] lookups).
const gotCatalog = modelsByModule(ring);
const gotKeys = Object.keys(gotCatalog).sort();
const expKeys = Object.keys(manifest.modelsByModule).sort();
check("(catalog)", "modelsByModule.keys", JSON.stringify(gotKeys) === JSON.stringify(expKeys));
for (const k of expKeys) {
  check("(catalog)", `modelsByModule.${k}`, JSON.stringify(gotCatalog[k]) === JSON.stringify(manifest.modelsByModule[k]));
}

console.log(`gp150 inspect JS<->Python parity: ${pass} checks passed, ${fail} failed, ${manifest.records.length} corpus files`);
if (fail) {
  console.error(fails.slice(0, 30).join("\n"));
  if (fails.length > 30) console.error(`... and ${fails.length - 30} more`);
  process.exit(1);
}
