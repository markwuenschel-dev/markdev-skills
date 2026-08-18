"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}
function json(rel) {
  return JSON.parse(read(rel));
}
function hasCore(rel, file) {
  const policy = json(rel);
  return Array.isArray(policy.core) && policy.core.includes(file);
}

const targets = [
  ["codebase-integrity-audit-loop", ["SKILL.md", "PERFORMANCE.md"]],
  ["repository-health-assessment", ["SKILL.md", "PERFORMANCE.md", "PARALLEL-ASSESSMENT.md"]],
  ["repository-improvement-assessment", ["SKILL.md", "PERFORMANCE.md"]],
  ["architecture-improvement-intelligence", ["SKILL.md", "PERFORMANCE.md"]]
];

for (const [skill, required] of targets) {
  const policy = json(`${skill}/context-policy.json`);
  for (const file of required) assert.ok(policy.core.includes(file), `${skill} must load ${file} in core context`);
}

const integrity = read("codebase-integrity-audit-loop/PARALLEL-REPORT.md");
assert.match(integrity, /immediately refill free worker slots/i);
assert.doesNotMatch(integrity, /four expert lanes/i);

const health = read("repository-health-assessment/PARALLEL-ASSESSMENT.md");
assert.match(health, /as_completed/i);
assert.match(health, /refill/i);

const architecture = read("architecture-improvement-intelligence/SKILL.md");
const architecturePerf = read("architecture-improvement-intelligence/PERFORMANCE.md");
assert.match(architecture, /active worker count is adaptive/i);
assert.match(architecturePerf, /submit every independent READY job before awaiting one/i);
assert.match(architecturePerf, /work[- ]steal/i);
assert.match(architecturePerf, /single-flight/i);

const ria = read("repository-improvement-assessment/SKILL.md");
assert.match(ria, /launch all three canonical owners concurrently/i);
assert.match(ria, /one RIA-owned global executor/i);

const swarms = read("human-directed-swarm-planner/SWARM-TYPES.md");
assert.doesNotMatch(swarms, /Captain \+ four default lanes/i);
assert.match(swarms, /coverage families, not a four-worker roster/i);
assert.match(swarms, /Global assessment executor/i);

console.log("GREEN — assessment throughput contract");
