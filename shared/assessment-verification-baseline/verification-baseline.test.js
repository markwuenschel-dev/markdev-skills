"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVerificationBaseline, verifyVerificationBaseline, verifyVerificationBaselineFile, writeVerificationBaseline, deriveTrust } = require("./verification-baseline.js");
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
assert.equal(artifact.schema_version, "assessment-verification-baseline@3");
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

// --- trust: the verdict the summary counters always implied ---
const cmd = (id, status, exit_code, reason = null) => ({ id, command: id, status, exit_code, duration_ms: 1, evidence: ["e"], reason });
const withCommands = (commands) => createVerificationBaseline({ ...baseInput, commands });
assert.deepEqual(artifact.trust, { state: "partial", reason: "command-unavailable" });
assert.deepEqual(withCommands([cmd("ok", "passed", 0)]).trust, { state: "trustworthy", reason: "all-passing" });
assert.deepEqual(withCommands([cmd("bad", "failed", 1)]).trust, { state: "untrustworthy", reason: "command-failed" });
assert.deepEqual(withCommands([cmd("slow", "timed-out", null)]).trust, { state: "untrustworthy", reason: "command-timed-out" });
assert.deepEqual(withCommands([]).trust, { state: "not-run", reason: "no-commands" });
// A passing command alongside a failing one must not launder the verdict.
assert.equal(withCommands([cmd("ok", "passed", 0), cmd("bad", "failed", 1)]).trust.state, "untrustworthy");
assert.deepEqual(deriveTrust([], { failed: 0, timed_out: 0, unavailable: 0, skipped: 0 }), { state: "not-run", reason: "no-commands" });
// A hand-edited trust block must not survive verification.
assert.equal(verifyVerificationBaseline({ ...withCommands([cmd("bad", "failed", 1)]), trust: { state: "trustworthy", reason: "all-passing" } }).ok, false);

// --- @2 stays readable so pre-trust artifacts keep their content-addressed reuse ---
const legacy = createVerificationBaseline(baseInput, "assessment-verification-baseline@2");
assert.equal(legacy.schema_version, "assessment-verification-baseline@2");
assert.equal("trust" in legacy, false);
assert.equal(verifyVerificationBaseline(legacy).ok, true);
assert.notEqual(legacy.content_sha256, artifact.content_sha256);

// --- isolation overlay receipt (scope: worktree) ---
const overlaid = createVerificationBaseline({ ...baseInput, isolation: { ...baseInput.isolation, overlay: { copied: 2, removed: 1, entries: 3 } } });
assert.deepEqual(overlaid.isolation.overlay, { copied: 2, entries: 3, removed: 1 });
assert.equal(verifyVerificationBaseline(overlaid).ok, true);
assert.throws(() => createVerificationBaseline({ ...baseInput, isolation: { ...baseInput.isolation, overlay: { copied: -1, removed: 0, entries: 0 } } }), /isolation overlay is invalid/);
assert.throws(() => createVerificationBaseline({ ...baseInput, isolation: { ...baseInput.isolation, overlay: { copied: 1 } } }), /isolation overlay is invalid/);
assert.throws(() => createVerificationBaseline({ ...baseInput, isolation: { ...baseInput.isolation, overlay: { copied: 1, removed: 0, entries: 1, extra: true } } }), /isolation overlay is not closed/);

// --- kind derivation: never guess `test`, and mark every inference ---
const { deriveCommandKind, healthVerificationCommands } = require("./verification-baseline.js");
assert.equal(deriveCommandKind("node --test"), "test");
assert.equal(deriveCommandKind("pytest -q"), "test");
assert.equal(deriveCommandKind("cargo test"), "test");
assert.equal(deriveCommandKind("tsc --noEmit"), "typecheck");
assert.equal(deriveCommandKind("eslint ."), "lint");
assert.equal(deriveCommandKind("npm run build"), "build");
assert.equal(deriveCommandKind("./scripts/whatever.sh"), "other");
assert.equal(deriveCommandKind("docker compose up"), "other");
const derivedKinds = withCommands([cmd("a", "passed", 0), { ...cmd("b", "passed", 0), command: "node --test" }]);
assert.deepEqual(derivedKinds.commands.map(c => [c.kind, c.kind_inferred]), [["other", true], ["test", true]]);
const pinned = withCommands([{ ...cmd("a", "passed", 0), command: "./run.sh", kind: "test" }]);
assert.equal(pinned.commands[0].kind, "test");
assert.equal(pinned.commands[0].kind_inferred, false);
assert.throws(() => withCommands([{ ...cmd("a", "passed", 0), kind: "smoke" }]), /kind is invalid/);
// A derived kind must survive a round trip without flipping its provenance.
assert.equal(verifyVerificationBaseline(derivedKinds).ok, true);
assert.equal(verifyVerificationBaseline({ ...derivedKinds, commands: derivedKinds.commands.map(c => c.id === "b" ? { ...c, kind: "other" } : c) }).ok, false);

// --- the seam: the artifact carries repository-health-assessment's exact shape ---
assert.deepEqual(healthVerificationCommands([{ id: "x", command: "node --test", status: "failed", kind: "test", reason: null, exit_code: 2, duration_ms: 1500 }]),
  [{ command_id: "x", kind: "test", command: "node --test", result: "fail", exit_code: 2, elapsed_seconds: 1.5 }]);
assert.equal(healthVerificationCommands([{ id: "x", command: "c", status: "timed-out", kind: "test", exit_code: null, duration_ms: 0 }])[0].exit_code, 124);
assert.equal(healthVerificationCommands([{ id: "x", command: "c", status: "failed", kind: "test", exit_code: null, duration_ms: 0 }])[0].exit_code, 1);
const seam = withCommands([{ ...cmd("t", "failed", 1), command: "node --test" }]);
assert.deepEqual(seam.health_verification.commands, [{ command_id: "t", kind: "test", command: "node --test", result: "fail", exit_code: 1, elapsed_seconds: 0.001 }]);
// Health's own deriveBaseline, run on what RIA now emits, must call this untrustworthy.
// This is the whole point: a failed gate can no longer reach a health island as no gate.
// health-verify.js is an island script with no module.exports, so lift the real function
// out of its source rather than reimplementing it — a copy here would pass while the
// actual consumer diverged, which is precisely the failure this seam is meant to close.
const healthSource = fs.readFileSync(path.resolve(__dirname, "..", "..", "repository-health-assessment", "assets", "health-verify.js"), "utf8");
const deriveBaselineSource = /function deriveBaseline\(commands\)[\s\S]*?\n}/.exec(healthSource);
assert.ok(deriveBaselineSource, "deriveBaseline not found in health-verify.js — the seam contract moved");
const healthDeriveBaseline = new Function(`${deriveBaselineSource[0]}; return deriveBaseline;`)();
assert.deepEqual(healthDeriveBaseline(seam.health_verification.commands), { state: "untrustworthy", reason: "test-not-passing" });
// And the asymmetry that made silence pay: omitting the adoption yields a SOFTER verdict.
assert.deepEqual(healthDeriveBaseline([]), { state: "not-run", reason: "no-commands" });
// An all-passing translated set is the only thing that earns trustworthy.
const allPass = withCommands([{ ...cmd("t", "passed", 0), command: "node --test" }]);
assert.deepEqual(healthDeriveBaseline(allPass.health_verification.commands), { state: "trustworthy", reason: "all-passing" });
assert.equal(allPass.trust.state, "trustworthy");
// An unrecognised command must not masquerade as a passing test suite.
const unclassified = withCommands([{ ...cmd("t", "passed", 0), command: "./scripts/whatever.sh" }]);
assert.equal(unclassified.commands[0].kind, "other");
assert.equal(unclassified.commands[0].kind_inferred, true);
assert.deepEqual(healthDeriveBaseline(unclassified.health_verification.commands), { state: "partial", reason: "no-test-command" });
assert.equal(seam.trust.state, "untrustworthy");

// --- the FULL Health verifier, not just deriveBaseline ---
// deriveBaseline alone does not check metrics, id charset or reasons, so an earlier version
// of this seam passed that assertion while being impossible to adopt: every executed command
// failed baseline-command-metrics. Splice the emitted array into Health's own canonical island
// and run the whole verifier the report path uses.
{
  const vm = require("node:vm");
  const skills = path.resolve(__dirname, "..", "..");
  const sandbox = { console }; sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(skills, "shared", "candidate-ledger-spine", "ledger-verify.js"), "utf8"), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(skills, "repository-health-assessment", "assets", "health-verify.js"), "utf8"), sandbox);
  const island = JSON.parse(fs.readFileSync(path.join(skills, "repository-health-assessment", "assets", "canonical-island.json"), "utf8"));
  const seamProblems = (commands) => {
    const candidate = structuredClone(island);
    candidate.verification = { ...(candidate.verification || {}), commands };
    delete candidate.verification.baseline;
    // Array.from: the verifier runs in a vm realm, whose arrays fail deepStrictEqual on prototype.
    return Array.from(sandbox.HealthVerify.verifyHealth(candidate).problems.filter((p) => /^baseline-command-/.test(p.code)), (p) => `${p.code}: ${p.message}`);
  };
  const mixed = withCommands([
    { ...cmd("t", "failed", 1), command: "node --test src/index.test.js", duration_ms: 41230 },
    { ...cmd("b", "passed", 0), command: "npm run build", duration_ms: 1500 },
    { ...cmd("u", "unavailable", null), command: "docker build .", reason: null },
    { ...cmd("s", "skipped", null), command: "pytest", reason: "python not installed" },
  ]);
  const emitted = mixed.health_verification.commands;
  assert.deepEqual(seamProblems(emitted), [], "health_verification must be adoptable verbatim by the full Health verifier");
  const byCommand = Object.fromEntries(emitted.map((c) => [c.command, c]));
  assert.match(byCommand["node --test src/index.test.js"].command_id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assert.equal(byCommand["node --test src/index.test.js"].elapsed_seconds, 41.23);
  assert.equal(byCommand["node --test src/index.test.js"].exit_code, 1);
  assert.equal(byCommand["docker build ."].result, "skipped");
  assert.ok(byCommand["docker build ."].reason, "a skipped command must carry a reason");
  assert.equal("exit_code" in byCommand["docker build ."], false);
  // Colliding sanitized ids stay unique.
  const collide = withCommands([{ ...cmd("a/b", "passed", 0), command: "echo 1" }, { ...cmd("a#b", "passed", 0), command: "echo 2" }]);
  assert.equal(new Set(collide.health_verification.commands.map((c) => c.command_id)).size, 2);
  assert.deepEqual(seamProblems(collide.health_verification.commands), []);
}

console.log("ASSESSMENT_VERIFICATION_BASELINE_V3_OK");
