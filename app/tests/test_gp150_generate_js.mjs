/*
 * GP150Generate (app/static/gp150_generate.js): Randomize and Morph keep every preset valid, in range and
 * repeatable; the morph's ends are the two presets.
 *
 *   node app/tests/test_gp150_generate_js.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const S = resolve(dirname(fileURLToPath(import.meta.url)), "../static");
const F = require(resolve(S, "gp150_format.js"));
const G = require(resolve(S, "gp150_generate.js"));
const ring = JSON.parse(readFileSync(resolve(S, "data/fxid_ring_gp150.json"), "utf8"));
const skeleton = new Uint8Array(readFileSync(resolve(S, "data/gp150_skeleton.prst")));

// ---- randomize: many seeds, every result valid
const cat = G.catalogByModule(ring);
assert.deepEqual(Object.keys(cat).sort(), [...G.RANDOMIZABLE].sort());
assert.ok(cat.CAB.every((m) => !((m.fxid >>> 24) === 0x0a && ((m.fxid >>> 16) & 0xff) === 0x10)), "no User IR placeholder among the cab models");
for (let seed = 1; seed <= 300; seed++) {
  const chaos = [0, 0.3, 0.6, 1][seed % 4];
  const { body, chain } = G.randomize({ ring, base: skeleton, chaos, rng: G.seeded(seed) });
  assert.ok(F.isGp150(body) && F.checksumOk(body), `seed ${seed}: valid body`);
  assert.ok(F.isValidOrder(body), "chain order untouched");
  assert.equal(body[F.PATCH_INDEX_OFF], skeleton[F.PATCH_INDEX_OFF], "slot index untouched");
  assert.ok(F.readName(body).length >= 1 && F.readName(body).length <= F.NAME_MAX);
  const d = F.decode(body);
  const mods = new Set(chain.map((c) => c.mod));
  assert.ok(mods.has("AMP") && mods.has("CAB"), "an amp and a cab are always on");
  for (const mod of G.RANDOMIZABLE) {
    assert.equal(!!d.moduleEnabled[mod], mods.has(mod), `${mod} enabled flag matches the chain`);
    if (!mods.has(mod)) continue;
    const entry = ring[String(d.moduleModels[mod])];
    assert.ok(entry && (entry.module === mod), `${mod}: a catalog model of that module`);
    for (const p of entry.params) {
      if (p.algId < 0) continue;
      const v = F.readModuleParamByAlgId(body, mod, p.algId);
      assert.ok(v >= p.min - 1e-4 && v <= p.max + 1e-4, `${entry.name}.${p.name} = ${v} outside ${p.min}..${p.max}`);
      if (p.toggle || (p.options && p.options.length)) assert.ok(Number.isInteger(v), `${entry.name}.${p.name} is a whole number`);
      if (/^volume$/i.test(p.name)) assert.ok(Math.abs(v - p.default) <= 0.15 * (p.max - p.min) + 1e-3, "levels stay near their default");
    }
  }
  assert.equal(F.moduleMask(body) & 0x800, F.moduleMask(skeleton) & 0x800, "the volume block's bit is left as it was");
}
// repeatable, and different seeds differ
const a1 = G.randomize({ ring, base: skeleton, rng: G.seeded(7) }), a2 = G.randomize({ ring, base: skeleton, rng: G.seeded(7) }), a3 = G.randomize({ ring, base: skeleton, rng: G.seeded(8) });
assert.deepEqual([...a1.body], [...a2.body]); assert.notDeepEqual([...a1.body], [...a3.body]);
// chaos 0 keeps every parameter at its default
{
  const { body, chain } = G.randomize({ ring, base: skeleton, chaos: 0, rng: G.seeded(3) });
  const d = F.decode(body);
  for (const c of chain) for (const p of ring[String(d.moduleModels[c.mod])].params) if (p.algId >= 0) assert.ok(Math.abs(F.readModuleParamByAlgId(body, c.mod, p.algId) - clampDef(p)) < 1e-3, `${c.mod}.${p.name}`);
}
function clampDef(p) { return Math.min(p.max, Math.max(p.min, p.default)); }
// only the chosen modules change; the rest of the body is the base
{
  const { body } = G.randomize({ ring, base: skeleton, modules: ["DLY"], rng: G.seeded(11) });
  const d0 = F.decode(skeleton), d1 = F.decode(body);
  for (const mod of F.MODULE_NAMES) if (mod !== "DLY") assert.equal(d1.moduleModels[mod], d0.moduleModels[mod], `${mod} untouched`);
}
assert.equal(F.readName(G.randomize({ ring, base: skeleton, name: "A very long preset name" }).body).length, F.NAME_MAX);
assert.throws(() => G.randomize({ base: skeleton }), /catalog/);

// ---- morph: the ends are the presets, the middle is in between
const r1 = G.randomize({ ring, base: skeleton, rng: G.seeded(21) }).body, r2 = G.randomize({ ring, base: skeleton, rng: G.seeded(22) }).body;
assert.deepEqual([...G.morph({ ring, a: r1, b: r2, t: 0 })], [...r1], "t = 0 is exactly the first preset (the same patch volume, nothing else mixed)");
assert.deepEqual([...G.morph({ ring, a: r1, b: r2, t: 1 })], [...r2], "t = 1 is exactly the second");
// two presets with the same amp: the middle is the average of its parameters
{
  const amp = Number(Object.entries(ring).find(([, e]) => e.module === "AMP")[0]);
  const mk = (gain) => { const b = new Uint8Array(skeleton); F.writeModuleModel(b, "AMP", amp); F.writeModuleEnabled(b, "AMP", true); F.writeModuleParamByAlgId(b, "AMP", 0, gain); F.writePatchVolume(b, gain === 10 ? 20 : 80); return F.fixChecksum(b); };
  const mid = G.morph({ ring, a: mk(10), b: mk(90), t: 0.5, name: "Mid" });
  assert.equal(F.readModuleParamByAlgId(mid, "AMP", 0), 50); assert.equal(F.readPatchVolume(mid), 50); assert.equal(F.readName(mid), "Mid"); assert.ok(F.checksumOk(mid));
  assert.equal(F.readModuleParamByAlgId(G.morph({ ring, a: mk(10), b: mk(90), t: 0.25 }), "AMP", 0), 30);
}
// different models: the module comes whole from the nearer preset, and every morph is valid
for (let t = 0; t <= 1; t += 0.1) { const m = G.morph({ ring, a: r1, b: r2, t }); assert.ok(F.isGp150(m) && F.checksumOk(m) && F.isValidOrder(m)); }
const near = G.morph({ ring, a: r1, b: r2, t: 0.4 });
for (const mod of F.MODULE_NAMES) if (F.readModuleModel(r1, mod) !== F.readModuleModel(r2, mod)) assert.equal(F.readModuleModel(near, mod), F.readModuleModel(r1, mod));
assert.throws(() => G.morph({ ring, a: r1, b: r2, t: 1.5 }), /between 0 and 1/);
console.log("ok");
