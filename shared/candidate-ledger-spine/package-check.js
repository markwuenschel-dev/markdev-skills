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
  ["invalid-lifecycle", (x) => { x.candidates[0].candidate_lifecycle.lifecycle_status = "gone"; }]
];
let failures = 0;
const base = LV.verifyLedger(ledger);
if (!base.ok) { console.error("FAIL canonical", base.problems); failures++; } else console.log("ok canonical");
for (const [name, mutate] of attacks) {
  const candidate = clone(ledger); mutate(candidate);
  const result = LV.verifyLedger(candidate);
  const caught = !result.ok;
  console.log((caught ? "ok  " : "FAIL") + " " + name);
  if (!caught) failures++;
}
process.exit(failures ? 1 : 0);
