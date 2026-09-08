"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { read } = require("./runtime-contract.js");

const skills = path.resolve(__dirname, "..", "..");
const names = [
  "repository-improvement-assessment",
  "repository-health-assessment",
  "codebase-integrity-audit-loop",
  "architecture-improvement-intelligence",
  "software-engineering-intelligence",
];
const contracts = new Map(names.map(name => [name, read(path.join(skills, name, "RUNTIME-CONTRACT.json")).contract]));
for (const [name, contract] of contracts) {
  assert.equal(contract.owner, name);
  assert.equal(contract.execution.full_skill_read_by_parent, false);
  assert.equal(contract.presentation.canonical_independent_of_report, true);
}
for (const name of ["repository-health-assessment", "codebase-integrity-audit-loop", "architecture-improvement-intelligence"]) {
  const required = new Set(contracts.get(name).input.required);
  assert.ok(required.has("baseline_ref"), `${name} must require baseline_ref`);
  assert.ok(required.has("engineering_intelligence_ref"), `${name} must require engineering_intelligence_ref`);
}
const seiRequired = new Set(contracts.get("software-engineering-intelligence").input.required);
assert.deepEqual([...seiRequired].sort(), ["output_location", "repository"]);
assert.equal(seiRequired.has("engineering_intelligence_ref"), false, "SEI cannot circularly require the artifact RIA creates from SEI evidence");
assert.match(contracts.get("repository-improvement-assessment").output.schema, /#\/\$defs\/assessProjection$/);
console.log("ASSESSMENT_RUNTIME_CONTRACT_FAMILY_OK");
