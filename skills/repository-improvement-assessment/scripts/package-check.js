"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const child = require("node:child_process");

const root = path.resolve(__dirname, "..");
const skillsRoot = path.resolve(root, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "MANIFEST.json"), "utf8"));
assert.equal(manifest.name, "repository-improvement-assessment");
assert.equal(manifest.version, "0.10.0");
assert.equal(JSON.parse(fs.readFileSync(path.join(root, "RUNTIME-CONTRACT.json"), "utf8")).version, manifest.version, "runtime contract version must match manifest");
for (const relative of [...manifest.contracts, ...manifest.scripts]) {
  assert.ok(fs.existsSync(path.join(root, relative)), `manifest path missing: ${relative}`);
}
for (const relative of [
  "baseline.schema.json",
  "engineering-intelligence.schema.json",
  "assets/execution-plan.schema.json",
  "assets/performance-receipt.schema.json",
  "assets/sei-telemetry-summary.schema.json",
  "assets/task-event.schema.json",
  "../shared/assessment-verification-baseline/verification-baseline.schema.json",
  "../shared/ria-owner-return/owner-return.schema.json",
]) JSON.parse(fs.readFileSync(path.resolve(root, relative), "utf8"));

const runtime = require(path.join(skillsRoot, "shared", "assessment-runtime-contract", "runtime-contract.js"));
const contractResult = runtime.validate(JSON.parse(fs.readFileSync(path.join(root, "RUNTIME-CONTRACT.json"), "utf8")));
assert.equal(contractResult.ok, true);

for (const script of [
  "scripts/task3-contract-check.js",
  "scripts/report-v3-package-check.js",
  "scripts/startup-and-plan.test.js",
  "scripts/performance-receipt.test.js",
  "scripts/scoring.test.js",
  "scripts/workspace-lineage.test.js",
  "scripts/ria.test.js",
  "scripts/ria-agent-adapter.test.js",
  "scripts/ria-v08-contract.test.js",
]) {
  child.execFileSync(process.execPath, [path.join(root, script)], { stdio: "inherit" });
}
console.log("RIA_V0_8_PACKAGE_OK");
