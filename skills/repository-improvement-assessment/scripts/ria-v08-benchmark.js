#!/usr/bin/env node
"use strict";
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { executeRia } = require("./ria.js");
const { deriveCompatibilityBinding } = require("./compatibility-binding.js");
const stockAdapter = require("./test-support/ria-stock-adapter.js");
function git(root, args) { return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-v08-benchmark-")); git(root, ["init"]); git(root, ["config", "user.email", "benchmark@example.invalid"]); git(root, ["config", "user.name", "RIA Benchmark"]); fs.writeFileSync(path.join(root, "source.txt"), "equivalent stock benchmark\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "benchmark fixture"]); return root; }
function compatibility() { return deriveCompatibilityBinding({ engine_version: "sei-stock-benchmark@1", effective_configuration: { evidence: "bounded" }, execution_contract: { version: 1 }, history_window: { kind: "full" }, assessment_schema_version: "sei.engineering-assessment@3", analyzer_capabilities: {} }); }
function request(root, depth) { return { repository: { root }, durable_mode: "git", command_authorization: { state: "granted", authorization_ref: "benchmark", inherited_from: null, commands: ["node-version"] }, verification_contract: { commands: ["node-version"], isolation: "read-only-source" }, sei_compatibility_binding: compatibility(), runtime_root: path.join(root, ".project-intelligence", "assessments", "ria", "benchmark"), presentation_policy: "generate", depth }; }
function value(metric) { return metric?.value ?? null; }
function duration(receipt, taskId) { return receipt.tasks.find((task) => task.task_id === taskId)?.duration_ms ?? null; }
async function runBenchmark() {
  const rows = [];
  for (const depth of ["quick", "standard", "deep"]) {
    const root = fixture();
    try {
      const result = await executeRia(request(root, depth), stockAdapter);
      const receipt = result.performance_receipt;
      const analytics = result.execution.task_results["report-data"]?.report_data?.analytics;
      rows.push({
        depth, status: result.status,
        wall_time_ms: value(receipt.metrics?.actual_wall_ms), critical_path_ms: value(receipt.metrics?.critical_path_ms), serial_work_ms: value(receipt.metrics?.serial_work_ms), scheduler_overhead_ms: value(receipt.metrics?.scheduler_overhead_ms),
        agent_tokens: value(receipt.metrics?.tokens), tool_calls: value(receipt.metrics?.tool_calls), peak_concurrency: value(receipt.metrics?.peak_concurrency), ready_queue_time_ms: value(receipt.metrics?.ready_queue_time_ms), resource_blocked_time_ms: value(receipt.metrics?.resource_blocked_time_ms), reuse_savings_ms: value(receipt.metrics?.cache_reuse_savings_ms),
        sei_duration_ms: duration(receipt, "sei-snapshot") + duration(receipt, "sei-assessment"), verification_duration_ms: duration(receipt, "verification-baseline"), owner_durations_ms: { health: duration(receipt, "owner-health"), integrity: duration(receipt, "owner-integrity"), architecture: duration(receipt, "owner-architecture") }, report_generation_ms: duration(receipt, "report-data") + duration(receipt, "report-render"),
        schema_correction_turns: null,
        candidate_counts: { health: analytics?.health?.candidate_count ?? null, integrity: analytics?.integrity?.candidate_count ?? null, architecture: analytics?.architecture?.candidate_count ?? null },
        class_budgets: result.plan.class_budgets, profile: result.plan.profile,
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  return { schema_version: "ria.v0.8-benchmark@1", workload: "equivalent isolated stock Git fixture with explicit report generation", comparison_claim: "measurement only; no performance-improvement claim", rows };
}
if (require.main === module) runBenchmark().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { runBenchmark };
