"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, ".."), skillsRoot = path.resolve(root, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const json = relative => JSON.parse(read(relative));
const skill = read("SKILL.md"), auto = read("AUTO-MODE.md"), parallel = read("PARALLEL-REPORT.md");
const manifest = json("MANIFEST.json"), runtime = json("RUNTIME-CONTRACT.json"), mutation = json("MUTATION-RUNTIME-CONTRACT.json"), schema = json("contracts/candidate-handoff.schema.json"), policy = json("context-policy.json");
const overlay = JSON.parse(fs.readFileSync(path.join(skillsRoot, "shared", "capability-registry", "capability-overlay.json"), "utf8")).capabilities["codebase-integrity-audit-loop"];

assert.equal(runtime.authority.source_repository_mutation, false);
assert.equal(mutation.authorized_handoff.mutation_owner, "production-flywheel");
assert.equal(mutation.authorized_handoff.completion_authority, "independent-verification");
assert.deepEqual(mutation.authorized_handoff.completion_binding.schema.required, ["candidate_id", "repository_identity", "base_revision", "handoff_sha256", "execution_receipt_sha256"]);
assert.equal(mutation.authorized_handoff.completion_binding.completion_semantics.fresh_canonical_verdict_required, true);
assert.equal(manifest.authority.source_repository_mutation, false);
assert.equal(manifest.authority.mutation_owner, "production-flywheel");
assert.equal(manifest.authority.completion_authority, "independent-verification");
assert.equal(manifest.storage.tracked_source_mutation, false);
assert.equal(overlay.mutation_authority, "internal-state");
assert.equal(overlay.completion_authority, "independent-verification");
assert.equal(schema.properties.mutation_owner.const, "production-flywheel");
assert.equal(policy.schema_version, 2);

assert.match(skill, /Never modify tracked source/);
assert.match(skill, /One selected candidate is the unit/);
assert.match(skill, /scripts\/candidate-handoff\.js/);
assert.doesNotMatch(skill, /loop-router/i);
assert.doesNotMatch(skill, /Create or switch to an isolated worktree/i);
assert.doesNotMatch(skill, /Execute all executable candidates/i);
assert.match(auto, /separately authorized/);
assert.match(auto, /does not authorize a ledger/);
assert.doesNotMatch(auto, /Execute all executable candidates/i);
assert.match(parallel, /repo is inspected, never edited/i);
assert.match(parallel, /invocation ends at the candidate gate/i);

for (const relative of ["scripts/candidate-handoff.js", "scripts/candidate-handoff.test.js", "scripts/completion-binding-parity.test.js", "contracts/candidate-handoff.schema.json", "contracts/completion-binding-parity.json"]) assert.ok(fs.existsSync(path.join(root, relative)), relative);

console.log("GREEN integrity authority contract: assessment-only owner, exact Flywheel handoff, independent completion, safe auto compatibility");
