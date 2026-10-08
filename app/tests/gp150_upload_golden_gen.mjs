// Regenerates fixtures/gp150_upload_golden.json from the current encoders (see gp150_upload_synth.mjs).
//   node app/tests/gp150_upload_golden_gen.mjs
import { writeFileSync } from "node:fs";
import { codec, goldenPath, IR_CASE, NAM_CASE, CLONE_CASE, synthIr, synthNam, synthClo, hex } from "./gp150_upload_synth.mjs";

const g = {
  _comment: "Chunks (F0/F7 stripped, hex) from the upload encoders on synthetic payloads; see gp150_upload_synth.mjs",
  ir: { ...IR_CASE, chunks: codec.buildIrUploadChunks(IR_CASE.slot0, IR_CASE.name, synthIr(), { counter: IR_CASE.counter }).map(hex) },
  nam: { ...NAM_CASE, chunks: codec.buildNamUploadChunks(NAM_CASE.slot, NAM_CASE.name, synthNam(), NAM_CASE.loudness, { counter: NAM_CASE.counter }).map(hex) },
  clone: { ...CLONE_CASE, chunks: codec.buildCloneUploadChunks(CLONE_CASE.slot, CLONE_CASE.name, synthClo()).map(hex) },
};
writeFileSync(goldenPath, JSON.stringify(g, null, 1) + "\n");
console.log("golden written:", Object.entries(g).filter(([k]) => k[0] !== "_").map(([k, v]) => `${k}=${v.chunks.length} chunks`).join(", "));
