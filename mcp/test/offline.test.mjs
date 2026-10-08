// Offline checks of the catalog and the patch builder/editor (no pedal involved).
//   cd mcp && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPatch, editPatch } from "../lib/builder.mjs";
import { decodePatch, searchModels, describeModel, G } from "../lib/catalog.mjs";

const spec = { name: "T Crunch", modules: { AMP: { model: "UK 800", params: { Gain: 70, Treble: 62 } }, DLY: { model: "Pure", params: { Mix: 12 } } } };

test("build_patch writes what was asked and decodes back to it", () => {
  const { body, warnings, summary } = buildPatch(spec);
  assert.equal(body.length, 1128);
  assert.deepEqual(warnings, []);
  assert.equal(summary.name, "T Crunch");
  assert.equal(summary.modules.AMP.model, "UK 800");
  assert.equal(summary.modules.AMP.params.Gain, 70);
  assert.equal(summary.modules.AMP.params.Treble, 62);
  assert.equal(summary.modules.AMP.enabled, true, "a module that gets a model is switched on");
  assert.equal(summary.modules.CAB.enabled, false, "untouched modules stay off");
  assert.equal(decodePatch(body).name, "T Crunch");
});

test("build_patch refuses unknown models and parameters", () => {
  assert.throws(() => buildPatch({ name: "x", modules: { AMP: { model: "No Such Amp" } } }));
  assert.throws(() => buildPatch({ name: "x", modules: { AMP: { model: "UK 800", params: { NoSuchKnob: 1 } } } }));
});

test("edit_patch changes only what is named and lists it", () => {
  const { body } = buildPatch(spec);
  const r = editPatch(body, { name: "T Edit", modules: { AMP: { params: { Gain: 75 } } } });
  assert.deepEqual(r.changes, ["name: T Crunch → T Edit", "AMP.Gain: 70 → 75"]);
  assert.equal(r.summary.modules.AMP.params.Treble, 62);
  assert.equal(G.readName(body).trim(), "T Crunch", "the original is untouched");
});

test("edit_patch refuses parameters on a module that holds no model", () => {
  const { body } = buildPatch(spec);
  assert.throws(() => editPatch(body, { modules: { CAB: { params: { Volume: 5 } } } }), /holds no model/);
});

test("catalog search and describe", () => {
  const hits = searchModels({ module: "AMP", query: "UK 800" });
  assert.ok(Array.isArray(hits) ? hits.length : hits.results?.length || hits.models?.length, "search finds the model");
  const first = Array.isArray(hits) ? hits[0] : (hits.results || hits.models)[0];
  const d = describeModel(first.fxid ?? first.id);
  assert.ok(d && (d.params || d.parameters), "describe lists parameters");
});
