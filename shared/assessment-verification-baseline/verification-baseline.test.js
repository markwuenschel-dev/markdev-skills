"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVerificationBaseline, verifyVerificationBaseline, verifyVerificationBaselineFile, writeVerificationBaseline } = require("./verification-baseline.js");
const baseInput = {
  repository: { repository_id: "repo:test", revision: "a".repeat(40), working_tree_fingerprint: "clean:test" },
  baseline_ref: { artifact_id: "baseline:test", sha256: "b".repeat(64), repository_revision: "a".repeat(40) },
  isolation: { mode: "worktree", path: "C:/rha-wt", source_repository_mutated: false },
  commands: [
    { id: "pytest", command: "pytest", status: "passed", exit_code: 0, duration_ms: 123, evidence: ["588 passed"], reason: null },
    { id: "docker", command: "docker build .", status: "unavailable", exit_code: null, duration_ms: 0, evidence: [], reason: "docker unavailable" }
  ], environment: { os: "test" }, coverage: { classes: ["python", "container"] }, created_at: "2026-08-18T00:00:00.000Z"
};
const artifact = createVerificationBaseline(baseInput);
assert.equal(artifact.schema_version, "assessment-verification-baseline@2");
assert.equal(artifact.summary.passed, 1); assert.equal(artifact.summary.unavailable, 1); assert.equal(artifact.summary.duration_ms, 123);
assert.equal(verifyVerificationBaseline(artifact).ok, true);
assert.equal(verifyVerificationBaseline({ ...artifact, summary: { ...artifact.summary, passed: 2 } }).ok, false);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "verification-identity-"));
try {
  const target = path.join(temp, "artifact.json"); const receipt = writeVerificationBaseline(target, artifact);
  assert.match(receipt.content_sha256, /^[0-9a-f]{64}$/); assert.match(receipt.file_sha256, /^[0-9a-f]{64}$/); assert.notEqual(receipt.content_sha256, receipt.file_sha256);
  assert.equal(verifyVerificationBaselineFile(target, receipt).ok, true);
  assert.equal(verifyVerificationBaselineFile(target, { ...receipt, file_sha256: "0".repeat(64) }).ok, false);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
assert.throws(() => createVerificationBaseline({ ...baseInput, isolation: { mode: "isolated-worktree", path: null, source_repository_mutated: false } }), /isolation receipt is invalid/);
console.log("ASSESSMENT_VERIFICATION_BASELINE_V2_OK");
