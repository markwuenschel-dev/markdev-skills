"use strict";
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { executeRia } = require("./ria.js");
const { deriveCompatibilityBinding } = require("./compatibility-binding.js");
const { validateOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const { validateAgainstSchema } = require("../../shared/software-engineering-intelligence/schema-validator.js");
const stockAdapter = require("./test-support/ria-stock-adapter.js");
const schemas = {
  plan: require("../assets/execution-plan.schema.json"),
  event: require("../assets/task-event.schema.json"),
  performance: require("../assets/performance-receipt.schema.json"),
  telemetry: require("../assets/sei-telemetry-summary.schema.json"),
  verification: require("../../shared/assessment-verification-baseline/verification-baseline.schema.json"),
  owner: require("../../shared/ria-owner-return/owner-return.schema.json"),
};
function git(root, args) { return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function compatibility() { return deriveCompatibilityBinding({ engine_version: "sei-stock-integration@1", effective_configuration: { evidence: "bounded" }, execution_contract: { version: 1 }, history_window: { kind: "full" }, assessment_schema_version: "sei.engineering-assessment@3", analyzer_capabilities: {} }); }
function initialize(root, name = "source.txt") { fs.mkdirSync(root, { recursive: true }); git(root, ["init"]); git(root, ["config", "user.email", "test@example.invalid"]); git(root, ["config", "user.name", "RIA Integration"]); fs.writeFileSync(path.join(root, name), "stock integration\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "stock integration fixture"]); return root; }
function gitFixture(context, prefix = "ria-v08-stock-") { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); context.after(() => fs.rmSync(root, { recursive: true, force: true })); return initialize(root); }
function request(roots, extra = {}) { const list = Array.isArray(roots) ? roots : [roots]; return { repository: list.length === 1 ? { root: list[0] } : { roots: list }, durable_mode: "git", command_authorization: { state: "granted", authorization_ref: "integration-test", inherited_from: null, commands: ["node-version"] }, verification_contract: { commands: ["node-version"], isolation: "read-only-source" }, sei_compatibility_binding: compatibility(), runtime_root: path.join(list[0], ".project-intelligence", "assessments", "ria", "v08-integration"), presentation_policy: "skip", depth: "quick", ...extra }; }
function terminalTasks(result) { const terminal = new Set(["reused", "completed", "failed", "blocked", "cancelled"]); return new Set(result.execution.events.filter((event) => terminal.has(event.status)).map((event) => event.task_id)); }
function event(result, taskId, status) { const found = result.execution.events.find((candidate) => candidate.task_id === taskId && candidate.status === status); assert.ok(found, `missing ${taskId}:${status}`); return found; }
function assertStartedTogether(result, taskIds) {
  const starts = taskIds.map((taskId) => event(result, taskId, "started"));
  const terminals = taskIds.map((taskId) => result.execution.events.find((candidate) => candidate.task_id === taskId && ["completed", "failed"].includes(candidate.status)));
  assert.equal(terminals.every(Boolean), true, `missing terminal event for ${taskIds.join(", ")}`);
  assert.ok(Math.max(...starts.map((item) => item.sequence)) < Math.min(...terminals.map((item) => item.sequence)), `${taskIds.join(", ")} did not overlap`);
}

test("stock fresh run generates a report and an identical second run reuses SEI, verification, and owners", async (context) => {
  const root = gitFixture(context);
  const first = await executeRia(request(root, { presentation_policy: "generate" }), stockAdapter);
  assert.equal(first.status, "complete", JSON.stringify(first.execution.failures));
  assert.deepEqual(validateAgainstSchema(first.plan, schemas.plan), []);
  for (const taskEvent of first.execution.events) assert.deepEqual(validateAgainstSchema(taskEvent, schemas.event), [], taskEvent.task_id);
  assert.deepEqual(validateAgainstSchema(first.performance_receipt, schemas.performance), []);
  assert.deepEqual(validateAgainstSchema(first.sei_telemetry, schemas.telemetry), []);
  assert.deepEqual(validateAgainstSchema(first.execution.task_results["verification-baseline"].artifact, schemas.verification), []);
  assert.equal(first.assessment.assessment_refs.length, 3);
  assert.equal(first.execution.task_results["sei-assessment"].assessment.schema_version, "sei.engineering-assessment@3");
  assert.equal(first.assessment.engineering_intelligence_ref.payload, undefined);
  assert.equal(first.sei_telemetry.gate_observation_status, "RECORDED");
  assert.equal(fs.existsSync(first.report.path), true);
  assert.equal(terminalTasks(first).size, first.plan.tasks.length);
  assert.ok(first.performance_receipt.metrics.peak_concurrency.value >= 2);
  assertStartedTogether(first, ["sei-snapshot", "verification-baseline"]);
  assert.equal(first.execution.task_results["sei-snapshot"].overlap_probe.generation, first.execution.task_results["verification-baseline"].overlap_probe.generation);
  assertStartedTogether(first, ["owner-health", "owner-integrity"]);
  const ownerTaskIds = ["owner-health", "owner-integrity", "owner-architecture"];
  const ownerReturns = ownerTaskIds.map((taskId) => first.execution.task_results[taskId]);
  assert.equal(ownerReturns.filter((value) => value?.schema_version === "ria.owner-return@1").length, 3);
  for (const value of ownerReturns) {
    assert.equal(validateOwnerReturn(value, { owner: value.owner, repository_revision: first.baseline_ref.repository_revision }).ok, true);
    assert.deepEqual(validateAgainstSchema(value, schemas.owner), [], value.owner);
  }
  assert.equal(first.execution.task_results["cross-owner-synthesis"].judgment_translation, false);
  assert.equal(git(root, ["status", "--porcelain"]), "");
  const second = await executeRia(request(root, { presentation_policy: "generate" }), stockAdapter);
  const reused = new Set(second.execution.events.filter((event) => event.status === "reused").map((event) => event.task_id));
  for (const id of ["sei-snapshot", "sei-assessment", "verification-baseline", "owner-health", "owner-integrity", "owner-architecture"]) assert.equal(reused.has(id), true, id);
  assert.ok(event(second, "sei-snapshot", "reused").sequence < event(second, "sei-assessment", "ready").sequence);
  for (const owner of ["owner-health", "owner-integrity", "owner-architecture"]) {
    const ready = event(second, owner, "ready");
    assert.ok(event(second, "sei-assessment", "reused").sequence < ready.sequence, `${owner} became ready before SEI reuse`);
    assert.ok(event(second, "verification-baseline", "reused").sequence < ready.sequence, `${owner} became ready before verification reuse`);
  }
  assert.ok(second.performance_receipt.metrics.cache_reuse_savings_ms.value > 0);
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("multi-root, degraded non-Git, deep Windows paths, and inherited command authority are executable", async (context) => {
  const first = gitFixture(context, "ria-v08-multi-a-");
  const second = gitFixture(context, "ria-v08-multi-b-");
  const multi = await executeRia(request([first, second]), stockAdapter);
  assert.equal(multi.status, "complete", JSON.stringify(multi.execution.failures));
  assert.equal(multi.execution.task_results["baseline-build"].artifact.repository.roots.length, 2);
  assert.equal(multi.baseline_ref.repository_revision.length, 64);
  const deepBase = fs.mkdtempSync(path.join(os.tmpdir(), "ria-v08-deep-")); context.after(() => fs.rmSync(deepBase, { recursive: true, force: true }));
  const deep = initialize(path.join(deepBase, ...Array.from({ length: 5 }, (_, index) => `segment-${String(index).padStart(2, "0")}-long-path`)));
  const deepResult = await executeRia(request(deep, { command_authorization: { state: "inherited", authorization_ref: "parent", inherited_from: "integration-parent", commands: ["node-version"] } }), stockAdapter);
  assert.equal(deepResult.status, "complete", JSON.stringify(deepResult.execution.failures));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ria-v08-content-")); context.after(() => fs.rmSync(plain, { recursive: true, force: true })); fs.writeFileSync(path.join(plain, "source.txt"), "content addressed\n");
  const nonGit = await executeRia(request(plain, { durable_mode: "content-addressed-degraded", runtime_root: path.join(plain, ".project-intelligence", "runtime") }), stockAdapter);
  assert.equal(nonGit.status, "degraded", JSON.stringify(nonGit.execution.failures));
  assert.equal(nonGit.assessment.stage, "ASSESS");
  assert.equal(nonGit.execution.task_results["baseline-build"].artifact.repository.ancestor_reuse_allowed, false);
});

test("selective Integrity rerun, strict owner failure, degraded owner failure, and denied commands have distinct outcomes", async (context) => {
  const root = gitFixture(context);
  await executeRia(request(root), stockAdapter);
  const selective = await executeRia(request(root, { reuse_controls: { Integrity: "rerun" } }), stockAdapter);
  assert.equal(selective.execution.events.some((event) => event.task_id === "owner-integrity" && event.status === "completed"), true);
  assert.equal(selective.execution.events.some((event) => event.task_id === "owner-health" && event.status === "reused"), true);
  const strict = await executeRia(request(root, { adapter_options: { test_fail_owner: "codebase-integrity-audit-loop" }, reuse_controls: { Integrity: "rerun" } }), stockAdapter);
  assert.equal(strict.status, "blocked");
  const degraded = await executeRia(request(root, { allow_degraded: true, adapter_options: { test_fail_owner: "codebase-integrity-audit-loop" }, reuse_controls: { Integrity: "rerun" } }), stockAdapter);
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.assessment, null);
  assert.equal(degraded.partial_assessment.stage, "ASSESS-PARTIAL");
  const denied = await executeRia(request(root, { command_authorization: { state: "denied", authorization_ref: "denied", inherited_from: null, commands: ["node-version"] }, reuse_controls: { verification: "rerun" } }), stockAdapter);
  assert.equal(denied.status, "blocked");
  assert.equal(denied.execution.failures[0].code, "COMMAND_AUTHORIZATION_DENIED");
});

test("concurrent first writers converge on immutable artifacts", async (context) => {
  const root = gitFixture(context);
  const concurrent = await Promise.all([executeRia(request(root), stockAdapter), executeRia(request(root), stockAdapter)]);
  assert.deepEqual(concurrent.map((result) => result.status), ["complete", "complete"]);
  assert.equal(concurrent[0].assessment.engineering_intelligence_ref.sha256, concurrent[1].assessment.engineering_intelligence_ref.sha256);
  assert.deepEqual(concurrent[0].assessment.assessment_refs, concurrent[1].assessment.assessment_refs);
});

test("a committed repository change invalidates the prior component cache keys", async (context) => {
  const root = gitFixture(context);
  const first = await executeRia(request(root), stockAdapter);
  fs.appendFileSync(path.join(root, "source.txt"), "incremental change\n");
  git(root, ["add", "source.txt"]); git(root, ["commit", "-m", "incremental change"]);
  const changed = await executeRia(request(root), stockAdapter);
  assert.notEqual(changed.baseline_ref.repository_revision, first.baseline_ref.repository_revision);
  for (const id of ["sei-snapshot", "verification-baseline", "owner-health", "owner-integrity", "owner-architecture"]) {
    assert.equal(changed.execution.events.some((event) => event.task_id === id && event.status === "completed"), true, id);
    assert.equal(changed.execution.events.some((event) => event.task_id === id && event.status === "reused"), false, id);
  }
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("quick, standard, deep, and custom profiles expose materially different bounded plans", async (context) => {
  const root = gitFixture(context);
  const results = {};
  for (const depth of ["quick", "standard", "deep"]) results[depth] = await executeRia(request(root, { lifecycle: "plan", depth }), stockAdapter);
  results.custom = await executeRia(request(root, { lifecycle: "plan", depth: "custom", custom_budget: { max_wall_minutes: 12, max_subagent_tokens: 40000, max_tool_calls: 100, max_owner_candidates: 10, max_parallel_agents: 1, max_heavy_tools: 1 } }), stockAdapter);
  assert.ok(results.quick.plan.profile.max_tool_calls < results.standard.plan.profile.max_tool_calls);
  assert.ok(results.standard.plan.profile.max_tool_calls < results.deep.plan.profile.max_tool_calls);
  assert.equal(results.custom.plan.class_budgets.agent, 1);
  assert.equal(results.custom.plan.class_budgets["heavy-tool"], 1);
});
