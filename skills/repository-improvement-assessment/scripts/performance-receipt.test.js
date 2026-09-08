"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildExecutionPlan } = require("./build-execution-plan.js");
const { executePlan, MemoryArtifactCache } = require("./execution-runtime.js");
const { buildPerformanceReceipt, unavailablePerformanceReceipt, validatePerformanceReceipt } = require("./performance-receipt.js");
const { createTaskEvent } = require("./task-event.js");

const ORIGIN = Date.parse("2026-08-30T00:00:00.000Z");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function metric(receipt, name) { return receipt.metrics[name].value; }
function task(id, dependencies = [], estimated = 0, component = null) {
  return { task_id: id, owner: `owner-${id}`, executor_class: "agent", dependencies, reuse: { component, policy: "auto" }, estimated_duration_ms: estimated };
}
function scenario(id, tasks, eventSpecs) {
  const events = eventSpecs.map((item, index) => createTaskEvent({
    run_id: id,
    task_id: item.task_id,
    executor_class: "agent",
    status: item.status,
    sequence: index + 1,
    occurred_at: new Date(ORIGIN + item.at).toISOString(),
    cache_key: `${item.task_id}-cache`,
    telemetry: item.status === "completed" ? { tool_calls: 1, tokens: 0 } : undefined,
    scheduler: item.status === "started" ? { ready_wait_ms: 0, resource_blocked_ms: 0, running_count: 1 } : undefined,
    result_ref: item.status === "completed" ? { task_id: item.task_id } : null,
  }));
  return {
    plan: { tasks, class_budgets: { agent: 3, "heavy-tool": 2, "local-deterministic": 4 } },
    execution_result: { run_id: id, events },
  };
}
function twoTaskEvents(aEnd, bStart, bEnd, bDependencyReady = false) {
  return [
    { task_id: "A", status: "submitted", at: 0 }, { task_id: "B", status: "submitted", at: 0 },
    { task_id: "A", status: "ready", at: 0 }, { task_id: "A", status: "started", at: 0 },
    ...(bDependencyReady ? [] : [{ task_id: "B", status: "ready", at: bStart }, { task_id: "B", status: "started", at: bStart }]),
    { task_id: "A", status: "completed", at: aEnd },
    ...(bDependencyReady ? [{ task_id: "B", status: "ready", at: bStart }, { task_id: "B", status: "started", at: bStart }] : []),
    { task_id: "B", status: "completed", at: bEnd },
  ];
}
function ownerEvents(states) {
  const events = ["Health", "Integrity", "Architecture"].map((task_id) => ({ task_id, status: "submitted", at: 0 }));
  for (const task_id of ["Health", "Integrity", "Architecture"]) {
    events.push({ task_id, status: "ready", at: 0 }, { task_id, status: "started", at: 0 });
    events.push({ task_id, status: states[task_id], at: states[task_id] === "reused" ? 0 : 100 });
  }
  return events;
}

test("performance receipt remains valid for the executable 17-node DAG", async () => {
  const plan = buildExecutionPlan({ depth: "quick", presentation_policy: "skip" });
  const handlers = {
    "local-deterministic": async () => { await delay(1); return { telemetry: { tool_calls: { value: 0, evidence: "measured" }, tokens: { value: 0, evidence: "unavailable" } } }; },
    "heavy-tool": async () => { await delay(8); return { telemetry: { tool_calls: { value: 1, evidence: "measured" }, tokens: null } }; },
    agent: async () => { await delay(10); return { telemetry: { tool_calls: { value: 2, evidence: "measured" }, tokens: { value: 50, evidence: "measured" } } }; },
  };
  const execution = await executePlan(plan, { handlers, cache: new MemoryArtifactCache(), run_nonce: "performance" });
  const receipt = buildPerformanceReceipt({ plan, execution_result: execution });
  assert.equal(validatePerformanceReceipt(receipt).ok, true);
  assert.equal(receipt.tasks.length, 17);
  assert.ok(metric(receipt, "serial_work_ms") >= metric(receipt, "critical_path_ms"));
  assert.ok(metric(receipt, "peak_concurrency") >= 2);
  assert.equal(receipt.metrics.tool_calls.evidence, "measured");
  assert.equal(receipt.tasks.find((item) => item.task_id === "report-render").state, "cancelled");
  const unavailable = unavailablePerformanceReceipt(execution.run_id, "FIXTURE_TELEMETRY_FAILURE");
  assert.equal(unavailable.telemetry_status, "unavailable");
  assert.equal(validatePerformanceReceipt(unavailable).ok, true);
});

test("performance receipt is derived from scheduler events with DAG-native metrics", () => {
  const tasks = [task("A"), task("B")];
  const low = scenario("historical-identity-low", tasks, twoTaskEvents(100, 0, 200));
  const high = scenario("historical-identity-high", tasks, twoTaskEvents(100, 0, 800));

  function prove(builder) {
    const first = builder(low);
    const repeat = builder(low);
    const changed = builder(high);
    assert.deepEqual(first, repeat, "same scheduler events must produce the same receipt");
    assert.equal(metric(first, "serial_work_ms"), 300);
    assert.equal(metric(changed, "serial_work_ms"), 900);
    assert.equal(metric(first, "critical_path_ms"), 200);
    assert.equal(metric(changed, "critical_path_ms"), 800);
    assert.equal(metric(first, "peak_concurrency"), 2);
    assert.equal(metric(changed, "peak_concurrency"), 2);
    assert.notEqual(first.receipt_sha256, changed.receipt_sha256, "changed scheduler events must change receipt identity");
  }

  assert.doesNotThrow(() => prove(buildPerformanceReceipt));
  assert.throws(() => prove(() => 1));
  assert.throws(() => prove(() => "nonempty"));
  const fixed = buildPerformanceReceipt(low);
  assert.throws(() => prove(() => fixed));
});

test("serial work changes exactly with causal task duration", () => {
  const tasks = [task("A"), task("B")];
  const caseA = buildPerformanceReceipt(scenario("serial-a", tasks, twoTaskEvents(100, 0, 200)));
  const caseB = buildPerformanceReceipt(scenario("serial-b", tasks, twoTaskEvents(100, 0, 800)));
  assert.equal(metric(caseA, "serial_work_ms"), 300);
  assert.equal(metric(caseB, "serial_work_ms"), 900);
  assert.ok(metric(caseB, "serial_work_ms") > metric(caseA, "serial_work_ms"));
});

test("dependency shape changes critical path and concurrency without changing serial work", () => {
  const parallel = buildPerformanceReceipt(scenario("parallel", [task("A"), task("B")], twoTaskEvents(500, 0, 500)));
  const serial = buildPerformanceReceipt(scenario("serial", [task("A"), task("B", ["A"])], twoTaskEvents(500, 500, 1000, true)));
  assert.equal(metric(parallel, "serial_work_ms"), 1000);
  assert.equal(metric(serial, "serial_work_ms"), 1000);
  assert.equal(metric(parallel, "critical_path_ms"), 500);
  assert.equal(metric(serial, "critical_path_ms"), 1000);
  assert.equal(metric(parallel, "peak_concurrency"), 2);
  assert.equal(metric(serial, "peak_concurrency"), 1);
});

test("exact verification reuse increases savings, removes executed work, and still releases its dependent", () => {
  const tasks = [task("verification", [], 200, "verification"), task("owner", ["verification"], 100, "Health")];
  const executedEvents = [
    { task_id: "verification", status: "submitted", at: 0 }, { task_id: "owner", status: "submitted", at: 0 },
    { task_id: "verification", status: "ready", at: 0 }, { task_id: "verification", status: "started", at: 0 }, { task_id: "verification", status: "completed", at: 200 },
    { task_id: "owner", status: "ready", at: 200 }, { task_id: "owner", status: "started", at: 200 }, { task_id: "owner", status: "completed", at: 300 },
  ];
  const reusedEvents = [
    { task_id: "verification", status: "submitted", at: 0 }, { task_id: "owner", status: "submitted", at: 0 },
    { task_id: "verification", status: "ready", at: 0 }, { task_id: "verification", status: "started", at: 0 }, { task_id: "verification", status: "reused", at: 0 },
    { task_id: "owner", status: "ready", at: 0 }, { task_id: "owner", status: "started", at: 0 }, { task_id: "owner", status: "completed", at: 100 },
  ];
  const executedInput = scenario("verification-executed", tasks, executedEvents);
  const reusedInput = scenario("verification-reused", tasks, reusedEvents);
  const executed = buildPerformanceReceipt(executedInput);
  const reused = buildPerformanceReceipt(reusedInput);
  assert.equal(metric(executed, "cache_reuse_savings_ms"), 0);
  assert.equal(metric(reused, "cache_reuse_savings_ms"), 200);
  assert.equal(metric(executed, "serial_work_ms"), 300);
  assert.equal(metric(reused, "serial_work_ms"), 100);
  assert.equal(reused.tasks.find((item) => item.task_id === "verification").state, "reused");
  const terminal = reusedInput.execution_result.events.find((item) => item.task_id === "verification" && item.status === "reused");
  const dependentReady = reusedInput.execution_result.events.find((item) => item.task_id === "owner" && item.status === "ready");
  assert.ok(terminal.sequence < dependentReady.sequence);
});

test("selective Integrity rerun changes only expected owner execution and reuse metrics", () => {
  const tasks = [task("Health", [], 100, "Health"), task("Integrity", [], 100, "Integrity"), task("Architecture", [], 100, "Architecture")];
  const full = buildPerformanceReceipt(scenario("owners-full", tasks, ownerEvents({ Health: "completed", Integrity: "completed", Architecture: "completed" })));
  const selective = buildPerformanceReceipt(scenario("owners-selective", tasks, ownerEvents({ Health: "reused", Integrity: "completed", Architecture: "reused" })));
  assert.equal(metric(full, "serial_work_ms"), 300);
  assert.equal(metric(selective, "serial_work_ms"), 100);
  assert.equal(metric(full, "cache_reuse_savings_ms"), 0);
  assert.equal(metric(selective, "cache_reuse_savings_ms"), 200);
  assert.deepEqual(Object.fromEntries(selective.tasks.map((item) => [item.task_id, item.state])), { Architecture: "reused", Health: "reused", Integrity: "completed" });
});

test("causal receipt proof rejects numeric, nonempty, and fixed-object implementations", () => {
  const tasks = [task("A"), task("B")];
  const low = scenario("anti-constant-low", tasks, twoTaskEvents(100, 0, 200));
  const high = scenario("anti-constant-high", tasks, twoTaskEvents(100, 0, 800));
  function prove(builder) {
    const first = builder(low);
    const repeat = builder(low);
    const changed = builder(high);
    assert.deepEqual(first, repeat, "same causal input must be deterministic");
    assert.equal(first.metrics.serial_work_ms.value, 300);
    assert.equal(changed.metrics.serial_work_ms.value, 900);
    assert.notEqual(first.receipt_sha256, changed.receipt_sha256, "different causal input must change the receipt identity");
  }
  assert.doesNotThrow(() => prove(buildPerformanceReceipt));
  assert.throws(() => prove(() => 1));
  assert.throws(() => prove(() => "nonempty"));
  const fixed = buildPerformanceReceipt(low);
  assert.throws(() => prove(() => fixed));
});
