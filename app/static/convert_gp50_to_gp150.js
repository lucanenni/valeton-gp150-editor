"use strict";
/*
 * convert_gp50_to_gp150.js — GP-50/GP-5 -> GP-150 preset conversion, in the
 * browser. A faithful port of patch/convert_gp50_to_gp150.py, so the
 * converter on /gp150 can run 100% client-side (no Python backend). See
 * that module's docstring for the background of every
 * decision here (the model crosswalk, the fixed slot->module mapping, where
 * WAH/VOL land in the output chain) — this file only re-encodes the same
 * logic, it doesn't re-derive it.
 *
 * Needs window.PRST (prst.js) for the GP-50/GP-5 read side and
 * window.GP150Format (gp150_format.js) for the GP-150 write side. Data
 * (the skeleton bytes + the three JSON tables: the source device's fxid
 * ring, fxid_ring_gp150.json, and gp50_to_gp150_model_map.json) is the
 * caller's job to load and pass in — this module stays free of fetch()/
 * data-loading concerns, same separation as prst.js/gp150_format.js.
 *
 * Exposes window.ConvertGp150 in the browser and module.exports under node
 * (for the oracle cross-check, app/tests/test_gp150_convert_js.mjs).
 */
(function (root) {
  const PRST = root.PRST || (typeof require !== "undefined" ? require("./prst.js") : null);
  const G150 = root.GP150Format || (typeof require !== "undefined" ? require("./gp150_format.js") : null);

  // GP-50's 10 fixed storage slots (prst.js's modelRecords() order), each
  // permanently tied to one role — see patch/convert_gp50_to_gp150.py's
  // GP50_SLOT_MODULE for how this was derived.
  const GP50_SLOT_MODULE = ["NR", "PRE", "DST", "AMP", "CAB", "EQ", "MOD", "DLY", "RVB", "NS"];

  const ALIASES = { pdelay: "predelay", predelay: "predelay", fback: "feedback", feedback: "feedback" };

  function normParamName(name) {
    const n = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return ALIASES[n] || n;
  }

  // {gp50AlgId: gp150AlgId} for params present (by normalized name) on both
  // models. A param only on one side is silently dropped — see the Python
  // module's own docstring for why that's the right default.
  function paramAlgIdCrosswalk(gp50Entry, gp150Entry) {
    const byName = {};
    for (const p of (gp150Entry && gp150Entry.params) || []) {
      if ((p.algId ?? -1) < 0) continue;
      byName[normParamName(p.name)] = p.algId;
    }
    const out = {};
    for (const p of (gp50Entry && gp50Entry.params) || []) {
      if ((p.algId ?? -1) < 0) continue;
      const target = byName[normParamName(p.name)];
      if (target !== undefined) out[p.algId] = target;
    }
    return out;
  }

  // convert(gp50Prst, {skeleton, gp50Ring, gp150Ring, modelMap}) ->
  // {prst: Uint8Array, unmapped: [{module, gp50Name}, ...]}
  function convert(gp50Prst, { skeleton, gp50Ring, gp150Ring, modelMap }) {
    const profile = PRST.detect(gp50Prst);
    if (profile.key !== "gp50" && profile.key !== "gp5") {
      throw new Error(`source must be a GP-5/GP-50 .prst, got ${profile.key}`);
    }
    G150.checkLength(skeleton);

    const name = PRST.readName(gp50Prst);
    const orderSlots = PRST.readOrder(gp50Prst); // [slotIdx, ...] length 10
    const records = PRST.modelRecords(gp50Prst); // [[idx, cat, fxlow], ...] length 10
    const bypass = PRST.bypassMask(gp50Prst);
    const params = PRST.paramFloats(gp50Prst); // 80 floats: block*8 + algId

    const moduleModels = {};
    const moduleParams = {};
    const moduleEnabled = {};
    const unmapped = [];

    for (let slot = 0; slot < records.length; slot++) {
      const module = GP50_SLOT_MODULE[slot];
      const [, cat, fxlow] = records[slot];
      // cat*0x1000000 + fxlow, not (cat<<24)|fxlow — a plain bitwise shift
      // would flip sign for cat >= 0x80 in JS's 32-bit bitwise ops, unlike
      // Python's arbitrary-precision ints; this matches str(gp50_fxid) keys
      // in gp50_to_gp150_model_map.json exactly for every category.
      const gp50Fxid = cat * 0x1000000 + fxlow;
      moduleEnabled[module] = !!(bypass & (1 << slot));
      const gp150Fxid = modelMap[String(gp50Fxid)];
      if (gp150Fxid === undefined || gp150Fxid === null) {
        const gp50Entry = gp50Ring[String(gp50Fxid)] || {};
        unmapped.push({ module, gp50Name: gp50Entry.name || `fxid ${gp50Fxid}` });
        moduleEnabled[module] = false; // never "on" with no model assigned
        continue; // leave this module's model/params as the skeleton's own
      }
      moduleModels[module] = gp150Fxid;
      const gp50Entry = gp50Ring[String(gp50Fxid)] || {};
      const gp150Entry = gp150Ring[String(gp150Fxid)] || {};
      const crosswalk = paramAlgIdCrosswalk(gp50Entry, gp150Entry);
      // Start from the target model's catalog defaults (see the Python
      // converter), then overlay the mapped parameters.
      const blockParams = {};
      for (const p of gp150Entry.params || []) {
        if (p.default !== undefined && p.default !== null) blockParams[p.algId] = p.default;
      }
      for (const [gp50Alg, gp150Alg] of Object.entries(crosswalk)) {
        blockParams[gp150Alg] = params[slot * 8 + Number(gp50Alg)];
      }
      moduleParams[module] = blockParams;
    }

    // Chain order: translate GP-50's 10 slot-index positions into role names,
    // then insert WAH right before DST and VOL at the very end — matching
    // GP-150's own factory-default order at the two positions GP-50 has no
    // opinion on.
    const chain = orderSlots.map((s) => GP50_SLOT_MODULE[s]);
    chain.splice(chain.indexOf("DST"), 0, "WAH");
    chain.push("VOL");

    // WAH/VOL don't exist on GP-50 — always off, keep the skeleton's own
    // model/params for them untouched.
    moduleEnabled.WAH = false;
    moduleEnabled.VOL = false;

    const prst = G150.buildFromSkeleton(skeleton, {
      name, chainOrder: chain, moduleModels, moduleParams, moduleEnabled,
    });
    return { prst, unmapped };
  }

  const API = { GP50_SLOT_MODULE, normParamName, paramAlgIdCrosswalk, convert };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.ConvertGp150 = API;
})(typeof self !== "undefined" ? self : this);
