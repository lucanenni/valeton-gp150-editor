/*
 * Byte-for-byte parity check: app/static/gp150_format.js +
 * convert_gp50_to_gp150.js vs the Python oracle
 * (patch/gp150_format.py + patch/convert_gp50_to_gp150.py) over the
 * in-repo GP-50/GP-5 corpus.
 *
 *   node app/tests/test_gp150_convert_js.mjs            # auto-runs gp150_convert_oracle.py
 *   node app/tests/test_gp150_convert_js.mjs foo.json    # verify a pre-built manifest
 *
 * Auto mode shells out to the repo venv's python to build the manifest, so a
 * clean checkout can run it with no manual step. See app/tests/test_prst_js.mjs
 * for the sibling test this mirrors.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const PRST = require(resolve(here, "../static/prst.js"));
const G150 = require(resolve(here, "../static/gp150_format.js"));
const Conv = require(resolve(here, "../static/convert_gp50_to_gp150.js"));

function loadManifest() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(readFileSync(arg, "utf8"));
  const py = [".venv-app/bin/python", ".venv-midi/bin/python", "python3"]
    .map((p) => (p.includes("/") ? resolve(repoRoot, p) : p))
    .find((p) => !p.includes("/") || existsSync(p)) || "python3";
  const oracle = resolve(here, "gp150_convert_oracle.py");
  const json = execFileSync(py, [oracle], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(json.toString("utf8"));
}

const fromB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const eqBytes = (a, z) => a.length === z.length && a.every((v, i) => v === z[i]);

let pass = 0, fail = 0;
const fails = [];
const check = (path, label, ok, detail) => {
  if (ok) { pass++; return; }
  fail++; fails.push(`${path} :: ${label}${detail ? " — " + detail : ""}`);
};

const manifest = loadManifest();
const skeleton = fromB64(manifest.skeletonB64);
const rings = { gp50: manifest.gp50Ring, gp5: manifest.gp5Ring };

if (!manifest.records.length) {
  console.error("no GP-50/GP-5 fixtures found in this checkout — nothing to verify");
  process.exit(1);
}

for (const rec of manifest.records) {
  if (rec.error && !rec.prstB64) { check(rec.path, "python-oracle", false, rec.error); continue; }
  const prst = fromB64(rec.prstB64);

  let result;
  try {
    result = Conv.convert(prst, {
      skeleton,
      gp50Ring: rings[rec.srcKey],
      gp150Ring: manifest.gp150Ring,
      modelMap: manifest.modelMap,
    });
  } catch (e) {
    check(rec.path, "convert", rec.error != null, `JS threw "${e.message}" but Python didn't error`);
    continue;
  }
  if (rec.error) { check(rec.path, "convert.shouldHaveThrown", false, `Python errored: ${rec.error}`); continue; }

  const expected = fromB64(rec.outB64);
  check(rec.path, "convert.bytes", eqBytes(result.prst, expected),
    `len ${result.prst.length} vs ${expected.length}`);
  check(rec.path, "convert.length", result.prst.length === G150.PRST_LEN);

  const gotUnmapped = result.unmapped.map((u) => [u.module, u.gp50Name]);
  check(rec.path, "convert.unmapped", JSON.stringify(gotUnmapped) === JSON.stringify(rec.unmapped),
    `${JSON.stringify(gotUnmapped)} != ${JSON.stringify(rec.unmapped)}`);

  // decode() round-trip sanity on the produced GP-150 body (not compared to
  // Python — just confirms the writer produced something the reader agrees
  // with: valid length, valid chain-order permutation, name matches).
  check(rec.path, "decode.isValidOrder", G150.isValidOrder(result.prst));
  check(rec.path, "decode.name", G150.readName(result.prst) === PRST.readName(prst),
    `"${G150.readName(result.prst)}" != "${PRST.readName(prst)}"`);
}

console.log(`gp150 convert JS<->Python parity: ${pass} checks passed, ${fail} failed, ${manifest.records.length} source files`);
if (fail) {
  console.error(fails.slice(0, 30).join("\n"));
  if (fails.length > 30) console.error(`... and ${fails.length - 30} more`);
  process.exit(1);
}
