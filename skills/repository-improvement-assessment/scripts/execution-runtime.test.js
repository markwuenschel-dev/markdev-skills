"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildExecutionPlan } = require("./build-execution-plan.js");
const { executePlan, MemoryArtifactCache } = require("./execution-runtime.js");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function plan(extra = {}) { return buildExecutionPlan({ startup_resolution: { startup_mode: "FRESH_BASELINE", node_cache_state: "MISS" }, baseline_ref: { sha256: "a".repeat(64) }, presentation_policy: "generate", depth: "quick", ...extra }); }
function handlers({ failOwner = null } = {}) {
  return {
    "local-deterministic": async ({ task }) => { await delay(2); return { result_ref: { task_id: task.task_id }, telemetry: { tool_calls: { value: 0, evidence: "measured" }, tokens: { value: 0, evidence: "unavailable" } } }; },
    "heavy-tool": async ({ task }) => { await delay(task.task_id === "verification-baseline" ? 35 : 22); return { result_ref: { task_id: task.task_id }, telemetry: { tool_calls: { value: 1, evidence: "measured" }, tokens: { value: 0, evidence: "unavailable" } } }; },
    agent: async ({ task }) => { await delay(30); if (task.task_id === failOwner) { const error = new Error("fixture owner failure"); error.code = "OWNER_FAILED"; throw error; } return { result_ref: { task_id: task.task_id }, telemetry: { tool_calls: { value: 2, evidence: "measured" }, tokens: { value: 100, evidence: "measured" } } }; },
  };
}
function event(result, task, status) { return result.events.find((candidate) => candidate.task_id === task && candidate.status === status); }

test("authoritative plan is consumed by bounded executor and every node gets a scheduler terminal event", async () => {
  const cache = new MemoryArtifactCache(); const first = await executePlan(plan(), { handlers: handlers(), cache, run_nonce: "first" });
  assert.equal(first.status, "complete"); assert.equal(Object.keys(first.metrics.terminal_counts).length > 0, true); assert.equal(first.metrics.peak_concurrency >= 2, true);
  for (const task of plan().tasks) assert.ok(first.events.some((candidate) => candidate.task_id === task.task_id && ["reused", "completed", "failed", "blocked", "cancelled"].includes(candidate.status)), task.task_id);
  const seiStart = Date.parse(event(first, "sei-snapshot", "started").occurred_at); const seiEnd = Date.parse(event(first, "sei-snapshot", "completed").occurred_at);
  const verificationStart = Date.parse(event(first, "verification-baseline", "started").occurred_at); const verificationEnd = Date.parse(event(first, "verification-baseline", "completed").occurred_at);
  assert.ok(Math.max(seiStart, verificationStart) < Math.min(seiEnd, verificationEnd), "SEI and verification must overlap");
  const second = await executePlan(plan({ startup_resolution: { startup_mode: "EXACT_REUSE", node_cache_state: "EXACT_REUSE" } }), { handlers: handlers(), cache, run_nonce: "second" });
  for (const id of ["sei-snapshot", "sei-assessment", "verification-baseline", "owner-health", "owner-integrity", "owner-architecture"]) assert.ok(event(second, id, "reused"), `${id} should reuse`);
});

test("selective Integrity rerun invalidates only graph descendants", async () => {
  const cache = new MemoryArtifactCache(); await executePlan(plan(), { handlers: handlers(), cache, run_nonce: "warm" });
  const selective = await executePlan(plan({ reuse_controls: { Integrity: "rerun" } }), { handlers: handlers(), cache, run_nonce: "selective" });
  assert.ok(event(selective, "owner-health", "reused")); assert.ok(event(selective, "owner-architecture", "reused")); assert.ok(event(selective, "owner-integrity", "completed"));
  assert.ok(selective.invalidated_tasks.includes("owner-integrity")); assert.ok(selective.invalidated_tasks.includes("cross-owner-synthesis")); assert.ok(!selective.invalidated_tasks.includes("owner-health"));
});

test("strict owner failure blocks while policy-gated degraded mode preserves reachable work", async () => {
  const strict = await executePlan(plan(), { handlers: handlers({ failOwner: "owner-integrity" }), cache: new MemoryArtifactCache(), run_nonce: "strict" });
  assert.equal(strict.status, "blocked"); assert.ok(event(strict, "owner-integrity", "failed")); assert.ok(event(strict, "owner-artifact-verification", "blocked"));
  const degraded = await executePlan(plan({ allow_degraded: true }), { handlers: handlers({ failOwner: "owner-integrity" }), cache: new MemoryArtifactCache(), run_nonce: "degraded" });
  assert.equal(degraded.status, "degraded"); assert.ok(event(degraded, "owner-integrity", "failed")); assert.ok(event(degraded, "cross-owner-synthesis", "completed"));
});

test("required reuse miss is explicit and report skip remains graph-terminal", async () => {
  const required = await executePlan(plan({ reuse_controls: { SEI: "require-reuse" } }), { handlers: handlers(), cache: new MemoryArtifactCache(), run_nonce: "required" });
  assert.equal(required.status, "blocked"); assert.equal(event(required, "sei-snapshot", "failed").failure_code, "REQUIRED_REUSE_MISS");
  const skippedPlan = plan({ presentation_policy: "skip" }); const skipped = await executePlan(skippedPlan, { handlers: handlers(), cache: new MemoryArtifactCache(), run_nonce: "skip" });
  assert.equal(skipped.status, "complete"); assert.equal(event(skipped, "report-render", "cancelled").reason_code, "CONDITION_FALSE"); assert.ok(event(skipped, "performance-receipt", "completed"));
});
