"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const { resolveStartup, repositoryIdentity, nodeCacheState } = require("./startup-resolver.js");
const { buildExecutionPlan } = require("./build-execution-plan.js");
function git(root, args) { return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }

test("resolver modes map to node cache states and v2 plan exposes real scheduler boundaries", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ria-startup-")); const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ria-artifact-")); const artifact = path.join(artifactDir, "sei.json");
  try {
    git(repo, ["init"]); git(repo, ["config", "user.email", "test@example.invalid"]); git(repo, ["config", "user.name", "Test"]); fs.writeFileSync(path.join(repo, "a.txt"), "a"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "a"]); const a = git(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(artifact, "{}\n"); const digest = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"); const cleanFingerprint = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    const base = { repository: { root: repo }, engine_version: "1.3.0", config_hash: "1".repeat(64), execution_contract_hash: "2".repeat(64), lineage: { sei_artifacts: [{ repository_key: repositoryIdentity(repo).repository_key, working_tree_fingerprint: cleanFingerprint, revision: a, engine_version: "1.3.0", config_hash: "1".repeat(64), execution_contract_hash: "2".repeat(64), sha256: digest, path: artifact }] }, owners: [] };
    let startup = resolveStartup(base); assert.equal(startup.startup_mode, "EXACT_REUSE"); assert.equal(startup.node_cache_state, "EXACT_REUSE");
    // Under `head` scope the assessed tree is the committed revision, so uncommitted work
    // must not invalidate reuse — otherwise one scratch file silently forces a full
    // recomputation of work the run already has. Under `worktree` scope the tree IS the
    // identity, so there the same file must invalidate.
    fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty");
    assert.equal(resolveStartup(base).startup_mode, "EXACT_REUSE");
    assert.equal(resolveStartup({ ...base, scope: "head" }).startup_mode, "EXACT_REUSE");
    assert.equal(resolveStartup({ ...base, scope: "worktree" }).startup_mode, "FRESH_BASELINE");
    fs.rmSync(path.join(repo, "dirty.txt"));
    assert.equal(resolveStartup(base).startup_mode, "EXACT_REUSE");
    fs.writeFileSync(path.join(repo, "b.txt"), "b"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "b"]); startup = resolveStartup(base); assert.equal(startup.startup_mode, "INCREMENTAL_REUSE"); assert.equal(startup.node_cache_state, "INCREMENTAL_REUSE");
    const plan = buildExecutionPlan({ startup_resolution: startup, depth: "standard", presentation_policy: "generate" });
    assert.equal(plan.schema_version, "ria.execution-plan@2"); assert.equal(plan.tasks.length, 17); assert.deepEqual([...new Set(plan.tasks.map((task) => task.executor_class))].sort(), ["agent", "heavy-tool", "local-deterministic"]);
    assert.deepEqual(plan.tasks.find((task) => task.task_id === "verification-baseline").dependencies, ["reuse-resolve"]); assert.deepEqual(plan.tasks.find((task) => task.task_id === "sei-snapshot").dependencies, ["reuse-resolve"]);
    assert.ok(plan.tasks.every((task) => task.cache_key && task.failure_policy && task.reuse && Array.isArray(task.resources) && Object.hasOwn(task, "degraded_mode_reachability")));
    assert.equal(plan.execution_semantics.work_conserving, true); assert.ok(plan.max_parallel < 12, "budgets derive from real graph width rather than the prior arbitrary minimum");
    const fresh = resolveStartup({ ...base, config_hash: "3".repeat(64) }); assert.equal(fresh.startup_mode, "FRESH_BASELINE"); assert.equal(fresh.node_cache_state, "MISS"); assert.equal(nodeCacheState("FRESH_BASELINE"), "MISS");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(artifactDir, { recursive: true, force: true }); }
});

test("report-only requires component reuse and verify-only graph-cancels non-verification work", () => {
  const report = buildExecutionPlan({ lifecycle: "report-only", depth: "quick", presentation_policy: "generate" });
  assert.equal(Object.values(report.reuse_controls).every((policy) => policy === "require-reuse"), true);
  const verify = buildExecutionPlan({ lifecycle: "verify-only", depth: "quick", presentation_policy: "skip" });
  const active = new Set(["repository-preflight", "baseline-build", "baseline-verify", "reuse-resolve", "verification-baseline", "performance-receipt"]);
  for (const task of verify.tasks) assert.equal(task.condition, active.has(task.task_id) ? null : "never", task.task_id);
});
