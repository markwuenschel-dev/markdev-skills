#!/usr/bin/env node
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { profile } = require("./profiles.js");

const COMPONENTS = Object.freeze({
  SEI: "SEI", verification: "verification", Health: "Health", Integrity: "Integrity", Architecture: "Architecture",
});
const REUSE_POLICIES = new Set(["auto", "rerun", "require-reuse"]);
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function reuseControls(value = {}) {
  const components = Object.values(COMPONENTS);
  // Check unknown keys FIRST. Run the policy loop first and a mis-cased key such as
  // `sei` quietly defaults to "auto", passes, and then dies on a message that names
  // neither the key nor the fact that the mismatch was casing.
  const unknown = Object.keys(value).filter((key) => !components.includes(key));
  if (unknown.length) {
    const near = unknown.map((key) => {
      const match = components.find((component) => component.toLowerCase() === String(key).toLowerCase());
      return match ? `${key} (did you mean ${match}?)` : key;
    });
    throw new Error(`FAIL-RIA-PLAN: unknown reuse component ${near.join(", ")} — valid: ${components.join(", ")} (case-sensitive)`);
  }
  const output = {};
  for (const component of components) {
    const policy = value[component] ?? "auto";
    if (!REUSE_POLICIES.has(policy)) throw new Error(`FAIL-RIA-PLAN: invalid ${component} reuse policy ${policy} — valid: ${[...REUSE_POLICIES].join(", ")}`);
    output[component] = policy;
  }
  return output;
}
function resource(id, permits = 1, mode = "shared") { return { id, mode, permits }; }
function task(task_id, owner, kind, executor_class, dependencies, priority, input, extra = {}) {
  return canonical({
    task_id, owner, kind, executor_class, dependencies, priority,
    cache_key: digest({ schema: "ria-task-cache@2", task_id, kind: extra.cache_kind ?? kind, input: input ?? null }),
    resources: extra.resources ?? [],
    reuse: { component: extra.component ?? null, policy: extra.reuse_policy ?? "auto" },
    failure_policy: { mode: extra.failure_mode ?? "strict" },
    degraded_mode_reachability: extra.degraded_mode_reachability === true,
    condition: extra.condition ?? null,
    estimated_duration_ms: extra.estimated_duration_ms ?? null,
    max_retries: extra.max_retries ?? 0,
  });
}
function workerBudgets(depthProfile, tasks) {
  const width = Math.max(1, tasks.filter((candidate) => candidate.dependencies.length <= 1).length);
  const classBudgets = {
    "local-deterministic": Math.min(4, width),
    "heavy-tool": Math.min(depthProfile.max_heavy_tools, 3),
    agent: Math.min(depthProfile.max_parallel_agents, 3),
  };
  return { max_parallel: Object.values(classBudgets).reduce((sum, value) => sum + value, 0), class_budgets: classBudgets };
}

function buildExecutionPlan(input = {}) {
  const lifecycle = input.lifecycle ?? input.mode ?? "run";
  if (!new Set(["plan", "run", "continue", "report-only", "verify-only"]).has(lifecycle)) throw new Error(`FAIL-RIA-PLAN: invalid lifecycle ${lifecycle}`);
  const depthProfile = profile(input.depth ?? "standard", input.custom_budget ?? {});
  const controls = reuseControls(input.reuse_controls);
  if (lifecycle === "report-only") for (const component of Object.keys(controls)) controls[component] = "require-reuse";
  const startup = input.startup_resolution ?? { startup_mode: "FRESH_BASELINE", node_cache_state: "MISS" };
  const baselineBinding = input.baseline_ref ?? input.baseline?.content_sha256 ?? input.repository_binding ?? "unresolved";
  const allowDegraded = input.allow_degraded === true;
  const ownerFailure = allowDegraded ? "degrade" : "strict";
  const presentation = input.presentation_policy ?? "ask";
  const reportCondition = presentation === "generate" ? null : presentation === "skip" ? "never" : "presentation-policy=generate";
  const common = { baseline: baselineBinding, depth: depthProfile.depth, profile: depthProfile };
  const tasks = [
    task("repository-preflight", "repository-improvement-assessment", "repository-preflight", "local-deterministic", [], 170, { repository: input.repository, durable_mode: input.durable_mode }),
    task("baseline-build", "repository-improvement-assessment", "baseline-build", "local-deterministic", ["repository-preflight"], 165, common),
    task("baseline-verify", "repository-improvement-assessment", "baseline-verification", "local-deterministic", ["baseline-build"], 160, common),
    task("reuse-resolve", "repository-improvement-assessment", "startup-and-reuse-resolution", "local-deterministic", ["baseline-verify"], 155, { ...common, startup }),
    task("sei-snapshot", "software-engineering-intelligence", startup.startup_mode === "EXACT_REUSE" ? "exact-sei-reuse" : startup.startup_mode === "INCREMENTAL_REUSE" ? "incremental-sei" : "fresh-sei", "heavy-tool", ["reuse-resolve"], 150, { ...common, compatibility: input.sei_compatibility_binding }, { component: COMPONENTS.SEI, reuse_policy: controls.SEI, cache_kind: "sei-snapshot", resources: [resource("sei-engine", 1)], estimated_duration_ms: 20_000 }),
    task("sei-assessment", "software-engineering-intelligence", "engineering-assessment", "heavy-tool", ["sei-snapshot"], 140, common, { component: COMPONENTS.SEI, reuse_policy: controls.SEI, resources: [resource("sei-engine", 1)], failure_mode: allowDegraded ? "degrade" : "strict", degraded_mode_reachability: allowDegraded, estimated_duration_ms: 8_000 }),
    // allow_degraded is in the input because it changes what this handler may RETURN: a
    // degraded run caches an untrustworthy baseline, and a strict run served that from cache
    // would skip the gate, which only runs inside the handler.
    task("verification-baseline", "shared/assessment-verification-baseline", "verification-baseline", "heavy-tool", ["reuse-resolve"], 145, { ...common, verification: input.verification_contract, allow_degraded: allowDegraded }, { component: COMPONENTS.verification, reuse_policy: controls.verification, resources: [resource("test-toolchain", 1), resource("isolated-source", 1)], failure_mode: allowDegraded ? "degrade" : "strict", degraded_mode_reachability: allowDegraded, estimated_duration_ms: 18_000 }),
    // Repository Health dispatches its own review-* lanes (repository-health-assessment/REVIEW-LANES.md)
    // and folds them into lanes as claims; RIA no longer schedules review-testing for lane substitution.
    task("owner-health", "repository-health-assessment", "canonical-owner-assessment", "agent", ["sei-assessment", "verification-baseline"], 130, { ...common, owner: "health", coverage_metrics: ["line", "branch", "changed_line"] }, { component: COMPONENTS.Health, reuse_policy: controls.Health, resources: [resource("owner-agent", 1)], failure_mode: ownerFailure, degraded_mode_reachability: allowDegraded, estimated_duration_ms: 12_000 }),
    task("owner-integrity", "codebase-integrity-audit-loop", "canonical-owner-assessment", "agent", ["sei-assessment", "verification-baseline"], 129, { ...common, owner: "integrity", integrity_coverage_schema: "integrity.coverage@2" }, { component: COMPONENTS.Integrity, reuse_policy: controls.Integrity, resources: [resource("owner-agent", 1)], failure_mode: ownerFailure, degraded_mode_reachability: allowDegraded, estimated_duration_ms: 12_000 }),
    task("owner-architecture", "architecture-improvement-intelligence", "canonical-owner-assessment", "agent", ["sei-assessment", "verification-baseline"], 128, { ...common, owner: "architecture", repository_fitness_schema: "architecture.fitness@2" }, { component: COMPONENTS.Architecture, reuse_policy: controls.Architecture, resources: [resource("owner-agent", 1)], failure_mode: ownerFailure, degraded_mode_reachability: allowDegraded, estimated_duration_ms: 12_000 }),
    task("owner-artifact-verification", "repository-improvement-assessment", "owner-artifact-verification", "local-deterministic", ["owner-health", "owner-integrity", "owner-architecture"], 110, common, { failure_mode: ownerFailure, degraded_mode_reachability: allowDegraded }),
    task("cross-owner-synthesis", "repository-improvement-assessment", "cross-owner-synthesis", "local-deterministic", ["owner-artifact-verification"], 100, common, { failure_mode: ownerFailure, degraded_mode_reachability: allowDegraded }),
    task("assess-binding", "repository-improvement-assessment", "strict-assess-binding", "local-deterministic", ["owner-artifact-verification", "cross-owner-synthesis"], 90, common, { failure_mode: allowDegraded ? "observe" : "strict", degraded_mode_reachability: allowDegraded }),
    task("report-data", "repository-improvement-assessment", "report-data-build", "local-deterministic", ["assess-binding", "owner-artifact-verification", "sei-telemetry-summary", "verification-baseline"], 80, common, { failure_mode: "observe", degraded_mode_reachability: true }),
    task("report-render", "repository-improvement-assessment", "report-render", "local-deterministic", ["report-data"], 70, common, { resources: [resource("report-renderer", 1)], failure_mode: "observe", degraded_mode_reachability: true, condition: reportCondition, estimated_duration_ms: 1_000 }),
    task("sei-telemetry-summary", "repository-improvement-assessment", "sei-telemetry-summary", "local-deterministic", ["sei-assessment"], 75, common, { failure_mode: "observe", degraded_mode_reachability: true }),
  ];
  if (lifecycle === "verify-only") {
    const active = new Set(["repository-preflight", "baseline-build", "baseline-verify", "reuse-resolve", "verification-baseline"]);
    for (const planned of tasks) if (!active.has(planned.task_id)) planned.condition = "never";
  }
  tasks.push(task("performance-receipt", "repository-improvement-assessment", "performance-receipt", "local-deterministic", tasks.map((candidate) => candidate.task_id), 1, common, { failure_mode: "observe", degraded_mode_reachability: true }));
  const budgets = workerBudgets(depthProfile, tasks);
  return Object.freeze(canonical({
    schema_version: "ria.execution-plan@2",
    lifecycle,
    depth: depthProfile.depth,
    profile: depthProfile,
    allow_degraded: allowDegraded,
    presentation_policy: presentation,
    reuse_controls: controls,
    ...budgets,
    resource_capacities: { "isolated-source": 2, "owner-agent": budgets.class_budgets.agent, "report-renderer": 1, "sei-engine": 1, "test-toolchain": 1 },
    tasks,
    execution_semantics: { ready_queue: "eager", completion: "as_completed", refill: "immediate", work_conserving: true, invalidation: "graph-descendants", cancellation: "dependency-and-budget", persistence: "ria.task-event@1" },
  }));
}

if (require.main === module) {
  try { const input = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), "utf8")); const bytes = `${JSON.stringify(buildExecutionPlan(input), null, 2)}\n`; if (process.argv[3]) { fs.mkdirSync(path.dirname(path.resolve(process.argv[3])), { recursive: true }); fs.writeFileSync(path.resolve(process.argv[3]), bytes); } else process.stdout.write(bytes); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { COMPONENTS, REUSE_POLICIES, buildExecutionPlan, digest, reuseControls, workerBudgets };
