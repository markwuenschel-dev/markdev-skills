#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path");
const here = __dirname;
const ledger = JSON.parse(fs.readFileSync(path.join(here, "canonical-ledger.json"), "utf8"));
eval(fs.readFileSync(path.join(here, "ledger-verify.js"), "utf8"));
const LV = globalThis.LedgerVerify;
if (!LV || typeof LV.verifyLedger !== "function") throw new Error("ledger-verify.js did not expose LedgerVerify.verifyLedger");
const clone = (value) => JSON.parse(JSON.stringify(value));
const attacks = [
  ["unknown-spine-version", (x) => { x.spine_version = 2; }],
  ["partial-envelope", (x) => { delete x.candidates[0].scores.severity; }],
  ["priority-mismatch", (x) => { x.candidates[0].rollup.priority_score = 99; }],
  ["dependency-cycle", (x) => { x.candidates[0].depends_on = ["CONTRACT-007"]; }],
  ["invalid-lifecycle", (x) => { x.candidates[0].candidate_lifecycle.lifecycle_status = "gone"; }],
  ["ria-dimensions-unknown", (x) => { x.candidates[0].ria_dimensions = ["architecture"]; }],
  ["ria-dimensions-empty", (x) => { x.candidates[0].ria_dimensions = []; }],
  ["defect-class-unknown", (x) => { x.candidates[0].defect_class = "bad-vibes"; }],
  ["ria-proof-without-predicate", (x) => { x.candidates[0].ria_proof = { input_binding: { repository_id: "r", root_id: "root", revision: "abc" }, proofs: [{ kind: "judgment" }] }; }],
  ["ria-proof-unknown-kind", (x) => { x.candidates[0].ria_proof = { failure_predicate: { predicate_id: "p", statement: "s" }, input_binding: { repository_id: "r", root_id: "root", revision: "abc" }, proofs: [{ kind: "workflow-status" }] }; }]
];
// composite-scoring-v3 §6.4: the RIA fields are optional, and a valid set verifies.
const withRia = clone(ledger);
Object.assign(withRia.candidates[0], {
  ria_dimensions: ["contracts"],
  defect_class: "contract-drift",
  ria_proof: { failure_predicate: { predicate_id: "contracts:contract-drift:api-schema", statement: "Two schemas disagree." }, input_binding: { repository_id: "r", root_id: "root", revision: "abc" }, proofs: [{ kind: "judgment" }] }
});
let failures = 0;
const base = LV.verifyLedger(ledger);
if (!base.ok) { console.error("FAIL canonical", base.problems); failures++; } else console.log("ok canonical");
const ria = LV.verifyLedger(withRia);
if (!ria.ok) { console.error("FAIL ria-fields-valid", ria.problems); failures++; } else console.log("ok ria-fields-valid");
for (const [name, mutate] of attacks) {
  const candidate = clone(ledger); mutate(candidate);
  const result = LV.verifyLedger(candidate);
  const caught = !result.ok;
  console.log((caught ? "ok  " : "FAIL") + " " + name);
  if (!caught) failures++;
}
process.exit(failures ? 1 : 0);
