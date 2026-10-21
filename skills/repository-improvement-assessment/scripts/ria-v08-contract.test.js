"use strict";
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildExecutionPlan } = require("./build-execution-plan.js");
const { verifyBaseline } = require("../baseline.js");
const { executeRia } = require("./ria.js");
const { validateAgainstSchema } = require("../../shared/software-engineering-intelligence/schema-validator.js");
const { createTaskEvent } = require("./task-event.js");
const { unavailablePerformanceReceipt } = require("./performance-receipt.js");
const { unavailable: unavailableTelemetry } = require("./sei-telemetry-summary.js");
const root = path.resolve(__dirname, "..");
function read(relative) { return fs.readFileSync(path.join(root, relative), "utf8"); }

test("v0.8 package exposes the authoritative 17-node runtime without Loop Router", () => {
  const manifest = JSON.parse(read("MANIFEST.json"));
  assert.equal(manifest.version, "0.10.0");
  assert.equal(manifest.consumes.includes("loop-router"), false);
  const runtimeSources = ["SKILL.md", "PERFORMANCE.md", "RUNTIME-CONTRACT.json", "scripts/ria.js", "scripts/build-execution-plan.js", "scripts/execution-runtime.js"].map(read).join("\n");
  assert.doesNotMatch(runtimeSources, /loop-router/i);
  const plan = buildExecutionPlan({ depth: "standard", presentation_policy: "skip" });
  assert.equal(plan.tasks.length, 17);
  assert.deepEqual([...new Set(plan.tasks.map((task) => task.executor_class))].sort(), ["agent", "heavy-tool", "local-deterministic"]);
  assert.equal(plan.execution_semantics.work_conserving, true);
  assert.equal(typeof executeRia, "function");
});

test("published contracts bind current SEI, observational telemetry, and a valid baseline example", () => {
  const intelligence = JSON.parse(read("engineering-intelligence.schema.json"));
  assert.equal(intelligence.$defs.seiAssessmentRef.properties.schema_version.enum.includes("sei.engineering-assessment@3"), true);
  const performance = JSON.parse(read("assets/performance-receipt.schema.json"));
  assert.equal(performance.properties.schema_version.const, "ria.performance-receipt@2");
  const telemetry = JSON.parse(read("assets/sei-telemetry-summary.schema.json"));
  assert.equal(telemetry.properties.schema_version.const, "sei.telemetry-summary@1");
  const example = JSON.parse(read("baseline.example.json"));
  assert.equal(verifyBaseline(example).ok, true);
});

test("material v0.8 schemas close their nested runtime records", () => {
  const verification = JSON.parse(read("../shared/assessment-verification-baseline/verification-baseline.schema.json"));
  assert.equal(verification.properties.commands.items.additionalProperties, false);
  assert.equal(verification.properties.summary.additionalProperties, false);
  const performance = JSON.parse(read("assets/performance-receipt.schema.json"));
  assert.equal(performance.properties.metrics.anyOf[1].additionalProperties, false);
  assert.equal(performance.properties.tasks.items.additionalProperties, false);
  const taskEvent = JSON.parse(read("assets/task-event.schema.json"));
  assert.equal(taskEvent.properties.telemetry.additionalProperties, false);
  assert.equal(taskEvent.properties.scheduler.additionalProperties, false);
  assert.equal(taskEvent.properties.result_ref.anyOf[0].additionalProperties, false);
  const plan = buildExecutionPlan({ depth: "quick", presentation_policy: "skip" });
  assert.deepEqual(validateAgainstSchema(plan, JSON.parse(read("assets/execution-plan.schema.json"))), []);
  const sampleEvent = createTaskEvent({ run_id: "contract", task_id: "sample", executor_class: "local-deterministic", status: "completed", sequence: 1, occurred_at: "2026-08-30T00:00:00.000Z", cache_key: "a".repeat(64), result_ref: { cache_key: "a".repeat(64) } });
  assert.deepEqual(validateAgainstSchema(sampleEvent, taskEvent), []);
  assert.deepEqual(validateAgainstSchema(unavailablePerformanceReceipt("contract", "NOT_RECORDED"), performance), []);
  const telemetry = JSON.parse(read("assets/sei-telemetry-summary.schema.json"));
  assert.deepEqual(validateAgainstSchema(unavailableTelemetry({}, "NOT_RECORDED"), telemetry), []);
  const widened = structuredClone(sampleEvent); widened.scheduler.undocumented = true;
  assert.notDeepEqual(validateAgainstSchema(widened, taskEvent), []);
});

test("report v3 exercises build-report and does not revive the old gate-count proxy", () => {
  const result = childProcess.spawnSync(process.execPath, [path.join(root, "scripts", "report-v3.test.js")], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /REPORT_V3_TEST_OK/);
  assert.doesNotMatch(read("scripts/report-model.js"), /observed\s+\$\{[^}]+\}\s*\/\s*\$\{[^}]+\}\s+gates/i);
});
