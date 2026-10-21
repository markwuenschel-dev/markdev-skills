"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const skills = path.resolve(__dirname, "..", "..");
function git(root, args) { return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function invoke(script, args) { return JSON.parse(childProcess.execFileSync(process.execPath, [script, ...args], { encoding: "utf8" })); }

test("all three canonical writers return the same RIA envelope without source mutation", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-owner-writers-")); context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ria-owner-inputs-")); context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  git(root, ["init"]); git(root, ["config", "user.email", "test@example.invalid"]); git(root, ["config", "user.name", "RIA Test"]); fs.writeFileSync(path.join(root, "sentinel.txt"), "unchanged\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "fixture"]);
  const revision = "abc1234";
  const envelope = { baseline_ref: { artifact_id: "baseline:fixture", sha256: "a".repeat(64), repository_revision: revision }, engineering_intelligence_ref: { artifact_id: `engineering-intelligence:${"b".repeat(64)}`, owner: "repository-improvement-assessment", kind: "engineering-intelligence", schema_version: "1.0.0", sha256: "b".repeat(64), repository_revision: revision, mission_id: "fixture", scope_hash: "c".repeat(64), baseline_binding: { artifact_id: "baseline:fixture", sha256: "a".repeat(64), repository_revision: revision } }, presentation_policy: "inherit" };
  const envelopePath = path.join(scratch, "envelope.json"); fs.writeFileSync(envelopePath, JSON.stringify(envelope));
  const architecture = JSON.parse(fs.readFileSync(path.join(skills, "architecture-improvement-intelligence", "assets", "architecture-candidate-set.example.json"), "utf8")); architecture.repository_revision = revision;
  const architectureInput = path.join(scratch, "architecture.json"); fs.writeFileSync(architectureInput, JSON.stringify(architecture));
  const cases = [
    ["repository-health-assessment", path.join(skills, "repository-health-assessment", "assets", "write-health-artifact.js"), ["--input", path.join(skills, "repository-health-assessment", "assets", "canonical-island.json")]],
    ["codebase-integrity-audit-loop", path.join(skills, "codebase-integrity-audit-loop", "assets", "write-ledger.js"), ["--input", path.join(skills, "shared", "candidate-ledger-spine", "canonical-ledger.json")]],
    ["architecture-improvement-intelligence", path.join(skills, "architecture-improvement-intelligence", "assets", "write-candidate-set.js"), ["--input", architectureInput]],
  ];
  for (const [owner, script, args] of cases) {
    const result = invoke(script, [...args, "--repo", root, "--ria-envelope", envelopePath]);
    assert.equal(result.schema_version, "ria.owner-return@1"); assert.equal(result.owner, owner);
    assert.equal(validateOwnerReturn(result, { owner, repository_revision: revision, input_binding_echo: envelope }).ok, true);
  }
  assert.equal(fs.readFileSync(path.join(root, "sentinel.txt"), "utf8"), "unchanged\n");
  assert.equal(git(root, ["status", "--porcelain"]), "");
});
