"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateOwnerReturn, envelopeForOwner } = require("../../shared/ria-owner-return/owner-return.js");
const skills = path.resolve(__dirname, "..", "..");
const { architectureRiaInput } = require("./test-support/architecture-ria-fixture.js");
function git(root, args) { return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
// Writers confine --output/--return-out to <repo>/.project-intelligence/ or $RIA_RUNTIME_ROOT;
// RIA always names its runtime root rather than passing --allow-path-outside.
function invoke(script, args, runtimeRoot) { return JSON.parse(childProcess.execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, RIA_RUNTIME_ROOT: runtimeRoot } })); }

test("all three canonical writers return the same RIA envelope without source mutation", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-owner-writers-")); context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ria-owner-inputs-")); context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  git(root, ["init"]); git(root, ["config", "user.email", "test@example.invalid"]); git(root, ["config", "user.name", "RIA Test"]); fs.writeFileSync(path.join(root, "sentinel.txt"), "unchanged\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "fixture"]);
  const revision = "abc1234";
  const envelope = { baseline_ref: { artifact_id: "baseline:fixture", sha256: "a".repeat(64), repository_revision: revision }, engineering_intelligence_ref: { artifact_id: `engineering-intelligence:${"b".repeat(64)}`, owner: "repository-improvement-assessment", kind: "engineering-intelligence", schema_version: "1.0.0", sha256: "b".repeat(64), repository_revision: revision, mission_id: "fixture", scope_hash: "c".repeat(64), baseline_binding: { artifact_id: "baseline:fixture", sha256: "a".repeat(64), repository_revision: revision } }, presentation_policy: "inherit" };
  const envelopePath = path.join(scratch, "envelope.json"); fs.writeFileSync(envelopePath, JSON.stringify(envelope));
  // RIA-mode Architecture input: every scored fitness dimension bound to stored packet claims (architecture.evidence-binding@1).
  const architecture = architectureRiaInput(root, envelope).input;
  const architectureInput = path.join(scratch, "architecture.json"); fs.writeFileSync(architectureInput, JSON.stringify(architecture));
  // RIA-mode Integrity input: integrity.coverage@2 plus bound proof on minted rows (composite-scoring-v3 §7.1).
  const integrityInput = path.join(scratch, "integrity.json");
  fs.writeFileSync(integrityInput, fs.readFileSync(path.join(skills, "codebase-integrity-audit-loop", "assets", "canonical-ria-ledger.json"), "utf8").replaceAll("__RIA_BASELINE_ARTIFACT_ID__", envelope.baseline_ref.artifact_id));
  const cases = [
    ["repository-health-assessment", path.join(skills, "repository-health-assessment", "assets", "write-health-artifact.js"), ["--input", path.join(skills, "repository-health-assessment", "assets", "canonical-island.json")]],
    ["codebase-integrity-audit-loop", path.join(skills, "codebase-integrity-audit-loop", "assets", "write-ledger.js"), ["--input", integrityInput]],
    ["architecture-improvement-intelligence", path.join(skills, "architecture-improvement-intelligence", "assets", "write-candidate-set.js"), ["--input", architectureInput]],
  ];
  for (const [owner, script, args] of cases) {
    const result = invoke(script, [...args, "--repo", root, "--ria-envelope", envelopePath], scratch);
    assert.equal(result.schema_version, "ria.owner-return@1"); assert.equal(result.owner, owner);
    assert.equal(validateOwnerReturn(result, { owner, repository_revision: revision, input_binding_echo: envelope }).ok, true);

    // --return-out writes the return to the exact path RIA's rendezvous names, into a
    // directory that need not exist yet. Without it the redirect is a manual step nobody
    // documented, and a missed redirect is indistinguishable from an owner that never ran.
    const destination = path.join(scratch, "owner-returns", `${owner}.json`);
    const printed = childProcess.execFileSync(process.execPath, [script, ...args, "--repo", root, "--ria-envelope", envelopePath, "--return-out", destination], { encoding: "utf8", env: { ...process.env, RIA_RUNTIME_ROOT: scratch } }).trim();
    assert.equal(printed, destination);
    assert.equal(fs.existsSync(destination), true);
    const fromFile = JSON.parse(fs.readFileSync(destination, "utf8"));
    assert.deepEqual(fromFile, result);
    assert.equal(validateOwnerReturn(fromFile, { owner, repository_revision: revision, input_binding_echo: envelope }).ok, true);

    // The per-owner envelope RIA now sends carries candidate_namespace; every writer must echo it.
    const namespaced = envelopeForOwner(envelope, owner);
    const namespacedPath = path.join(scratch, `${owner}-envelope.json`); fs.writeFileSync(namespacedPath, JSON.stringify(namespaced));
    const namespacedResult = invoke(script, [...args, "--repo", root, "--ria-envelope", namespacedPath], scratch);
    assert.equal(namespacedResult.input_binding_echo.candidate_namespace, namespaced.candidate_namespace);
    assert.equal(validateOwnerReturn(namespacedResult, { owner, repository_revision: revision, input_binding_echo: namespaced }).ok, true);
  }
  assert.equal(fs.readFileSync(path.join(root, "sentinel.txt"), "utf8"), "unchanged\n");
  assert.equal(git(root, ["status", "--porcelain"]), "");
});
