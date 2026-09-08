"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ExecutorPool } = require("../../agent-executor-pool/runtime.js");
const { appendTaskEvent, createTaskEvent, readTaskEvents } = require("./task-event.js");

const TERMINAL_EVENTS = new Set(["reused", "completed", "failed", "blocked", "cancelled"]);
const CLASS_MAP = Object.freeze({ "local-deterministic": "read_only", "heavy-tool": "validation", agent: "implementation" });
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function atomicJson(filePath, value) { const target = path.resolve(filePath); fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`; try { fs.writeFileSync(temporary, `${JSON.stringify(canonical(value), null, 2)}\n`, { flag: "wx" }); fs.renameSync(temporary, target); } finally { try { fs.rmSync(temporary, { force: true }); } catch {} } }

class MemoryArtifactCache {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  get(key) { return this.values.has(key) ? structuredClone(this.values.get(key)) : null; }
  put(key, value) { if (!this.values.has(key)) this.values.set(key, structuredClone(value)); return this.get(key); }
}
class FileArtifactCache {
  constructor(directory) { this.directory = path.resolve(directory); fs.mkdirSync(this.directory, { recursive: true }); }
  file(key) { if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("FAIL-RIA-CACHE: invalid cache key"); return path.join(this.directory, `${key}.json`); }
  get(key) { try { const value = JSON.parse(fs.readFileSync(this.file(key), "utf8")); return value.cache_key === key ? structuredClone(value.result) : null; } catch { return null; } }
  put(key, result) { const target = this.file(key); const record = canonical({ schema_version: "ria.task-cache@1", cache_key: key, result }); if (!fs.existsSync(target)) { try { fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; } } return this.get(key); }
}

function validatePlan(plan) {
  if (!plan || plan.schema_version !== "ria.execution-plan@2" || !Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new Error("FAIL-RIA-EXECUTION: invalid execution plan");
  const byId = new Map();
  for (const task of plan.tasks) {
    if (!task.task_id || byId.has(task.task_id) || !CLASS_MAP[task.executor_class]) throw new Error("FAIL-RIA-EXECUTION: invalid or duplicate task");
    byId.set(task.task_id, task);
  }
  for (const task of plan.tasks) for (const dependency of task.dependencies) if (!byId.has(dependency) || dependency === task.task_id) throw new Error(`FAIL-RIA-EXECUTION: invalid dependency ${task.task_id}->${dependency}`);
  const visiting = new Set(); const visited = new Set();
  function visit(id) { if (visiting.has(id)) throw new Error("FAIL-RIA-EXECUTION: dependency cycle"); if (visited.has(id)) return; visiting.add(id); for (const dependency of byId.get(id).dependencies) visit(dependency); visiting.delete(id); visited.add(id); }
  for (const id of byId.keys()) visit(id);
  return byId;
}
function descendantSet(plan) {
  const children = new Map(plan.tasks.map((task) => [task.task_id, []]));
  for (const task of plan.tasks) for (const dependency of task.dependencies) children.get(dependency).push(task.task_id);
  const invalidated = new Set(plan.tasks.filter((task) => task.reuse.policy === "rerun").map((task) => task.task_id));
  const queue = [...invalidated];
  while (queue.length) for (const child of children.get(queue.shift()) || []) if (!invalidated.has(child)) { invalidated.add(child); queue.push(child); }
  return invalidated;
}
function loadState(filePath) { if (!filePath || !fs.existsSync(filePath)) return null; const value = JSON.parse(fs.readFileSync(filePath, "utf8")); if (value.schema_version !== "ria.execution-state@1") throw new Error("FAIL-RIA-EXECUTION: state schema invalid"); return value; }
function evidenceValue(value) { if (Number.isFinite(value)) return Number(value); if (value && Number.isFinite(value.value)) return Number(value.value); return 0; }
function resultTelemetry(result) { return { tool_calls: result?.telemetry?.tool_calls ?? null, tokens: result?.telemetry?.tokens ?? null }; }
function conditionAllows(task, plan, options) {
  if (task.condition === null) return true;
  if (task.condition === "never") return false;
  if (task.condition === "presentation-policy=generate") return (options.presentation_decision ?? plan.presentation_policy) === "generate";
  if (typeof options.condition_resolver === "function") return options.condition_resolver(task.condition, task) === true;
  return false;
}

async function executePlan(plan, options = {}) {
  const byId = validatePlan(plan);
  const previous = loadState(options.state_path);
  const runId = options.run_id ?? previous?.run_id ?? `ria-${digest({ plan, nonce: options.run_nonce ?? Date.now() }).slice(0, 16)}`;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? new MemoryArtifactCache();
  const invalidated = descendantSet(plan);
  const pool = new ExecutorPool({
    budgets: { read_only: plan.class_budgets["local-deterministic"], validation: plan.class_budgets["heavy-tool"], implementation: plan.class_budgets.agent, integration: 0, publication: 0 },
    resource_capacities: plan.resource_capacities,
    max_buffered_jobs: Math.max(32, plan.tasks.length + 4),
  });
  const state = { schema_version: "ria.execution-state@1", run_id: runId, plan_sha256: digest(plan), event_log: options.event_log_path ? path.resolve(options.event_log_path) : null, last_sequence: previous?.last_sequence ?? 0, terminal_status: {}, task_results: { ...(previous?.task_results ?? {}) }, updated_at: null };
  const events = options.event_log_path && previous ? readTaskEvents(options.event_log_path) : [];
  const terminalEvents = new Set();
  const readyAt = new Map(); const resourceBlockedAt = new Map(); const attempts = new Map(); const running = new Map(); const controllers = new Map();
  const failures = []; const degradedFailures = []; const observationalFailures = [];
  let sequence = state.last_sequence; let peakConcurrency = 0; let budgetFailure = null; let totalToolCalls = 0; let totalTokens = 0;
  const startedAt = now();
  function persist() { state.last_sequence = sequence; state.updated_at = new Date(now()).toISOString(); if (options.state_path) atomicJson(options.state_path, state); }
  function emit(task, status, extra = {}) {
    const event = createTaskEvent({ run_id: runId, task_id: task.task_id, executor_class: task.executor_class, status, sequence: ++sequence, occurred_at: new Date(now()).toISOString(), attempt: extra.attempt ?? attempts.get(task.task_id) ?? 1, cache_key: task.cache_key, reason_code: extra.reason_code ?? null, failure_code: extra.failure_code ?? null, telemetry: extra.telemetry, scheduler: extra.scheduler, result_ref: extra.result_ref ?? null });
    events.push(event); if (options.event_log_path) appendTaskEvent(options.event_log_path, event); if (TERMINAL_EVENTS.has(status)) { terminalEvents.add(task.task_id); state.terminal_status[task.task_id] = status; }
    persist(); options.on_event?.(event); return event;
  }
  for (const task of plan.tasks) {
    pool.submit({ job_id: task.task_id, scope_id: runId, class: CLASS_MAP[task.executor_class], dependencies: task.dependencies, resources: task.resources, priority: task.priority, executor_depth: 0, mutating: false });
    emit(task, "submitted");
  }
  async function invoke(task, handler, controller) {
    const max = Number(task.max_retries || 0);
    for (let attempt = 1; ; attempt += 1) {
      attempts.set(task.task_id, attempt);
      try { return { ok: true, result: await handler({ task: structuredClone(task), plan, run_id: runId, signal: controller.signal, dependencies: Object.fromEntries(task.dependencies.map((id) => [id, state.task_results[id] ?? null])), profile: plan.profile }) }; }
      catch (error) {
        if (attempt <= max && !controller.signal.aborted) { emit(task, "retry", { attempt, failure_code: error.code ?? "TASK_ATTEMPT_FAILED", reason_code: error.message }); continue; }
        return { ok: false, error };
      }
    }
  }
  function reuseFor(task) {
    if (invalidated.has(task.task_id) || task.reuse.component === null) return null;
    if (previous?.task_results?.[task.task_id] && previous.terminal_status?.[task.task_id] && ["completed", "reused"].includes(previous.terminal_status[task.task_id])) return structuredClone(previous.task_results[task.task_id]);
    return cache.get(task.cache_key);
  }
  function classifyBudget() {
    const elapsed = now() - startedAt;
    if (elapsed > plan.profile.max_wall_minutes * 60_000) return "MAX_WALL_MINUTES_EXHAUSTED";
    if (totalTokens > plan.profile.max_subagent_tokens) return "MAX_SUBAGENT_TOKENS_EXHAUSTED";
    if (totalToolCalls > plan.profile.max_tool_calls) return "MAX_TOOL_CALLS_EXHAUSTED";
    return null;
  }
  while (terminalEvents.size < plan.tasks.length) {
    if (!budgetFailure) budgetFailure = classifyBudget();
    if (budgetFailure) { for (const controller of controllers.values()) controller.abort(budgetFailure); pool.cancelScope(runId); }
    const before = pool.snapshot();
    for (const record of before) if (record.status === "READY" && !readyAt.has(record.job_id) && !terminalEvents.has(record.job_id)) { readyAt.set(record.job_id, now()); emit(byId.get(record.job_id), "ready", { scheduler: { running_count: running.size } }); }
    const admissions = budgetFailure ? [] : pool.schedule();
    const admitted = new Set(admissions);
    for (const record of before) if (record.status === "READY" && !admitted.has(record.job_id) && !resourceBlockedAt.has(record.job_id)) resourceBlockedAt.set(record.job_id, now());
    for (const id of admissions) {
      const task = byId.get(id); const start = now(); const wait = readyAt.has(id) ? Math.max(0, start - readyAt.get(id)) : 0; const resourceWait = resourceBlockedAt.has(id) ? Math.max(0, start - resourceBlockedAt.get(id)) : 0;
      emit(task, "started", { scheduler: { ready_wait_ms: wait, resource_blocked_ms: resourceWait, running_count: running.size + 1 } });
      if (!conditionAllows(task, plan, options)) { pool.complete(id, { condition: false }); emit(task, "cancelled", { reason_code: "CONDITION_FALSE" }); continue; }
      const reused = reuseFor(task);
      if (reused !== null) { state.task_results[id] = reused; pool.complete(id, { reused: true }); emit(task, "reused", { reason_code: "EXACT_CACHE_HIT", result_ref: { cache_key: task.cache_key } }); continue; }
      if (task.reuse.policy === "require-reuse") { const error = Object.assign(new Error(`required reuse missed for ${id}`), { code: "REQUIRED_REUSE_MISS" }); pool.fail(id, { failure_code: error.code }); failures.push({ task_id: id, code: error.code, message: error.message }); emit(task, "failed", { failure_code: error.code, reason_code: error.message }); continue; }
      const handler = options.handlers?.[id] ?? options.handlers?.[task.executor_class];
      const selected = typeof handler === "function" ? handler : task.executor_class === "local-deterministic" ? async () => ({ task_id: id }) : async () => { const error = new Error(`no handler for ${id}`); error.code = "TASK_HANDLER_MISSING"; throw error; };
      const controller = new AbortController(); controllers.set(id, controller);
      const promise = invoke(task, selected, controller).then((settled) => ({ id, settled })); running.set(id, promise); peakConcurrency = Math.max(peakConcurrency, running.size);
    }
    const snapshot = pool.snapshot();
    for (const record of snapshot) {
      if (record.status === "BLOCKED" && !terminalEvents.has(record.job_id)) emit(byId.get(record.job_id), "blocked", { reason_code: "DEPENDENCY_FAILED" });
      if (record.status === "CANCELLED" && !terminalEvents.has(record.job_id) && !running.has(record.job_id)) emit(byId.get(record.job_id), "cancelled", { reason_code: budgetFailure ?? "SCOPE_CANCELLED" });
    }
    if (running.size === 0) {
      if (terminalEvents.size >= plan.tasks.length) break;
      if (admissions.length > 0) continue;
      const unresolved = pool.snapshot().filter((record) => !["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "STALE"].includes(record.status));
      if (unresolved.length === 0) continue;
      throw new Error(`FAIL-RIA-EXECUTION: scheduler stalled with ${unresolved.map((item) => item.job_id).join(",")}`);
    }
    const { id, settled } = await Promise.race(running.values()); running.delete(id); controllers.delete(id); const task = byId.get(id);
    if (settled.ok) {
      const result = settled.result ?? {}; state.task_results[id] = result; totalToolCalls += evidenceValue(resultTelemetry(result).tool_calls); totalTokens += evidenceValue(resultTelemetry(result).tokens);
      pool.complete(id, { result_ref: result.result_ref ?? null });
      if (task.reuse.component !== null && result.cacheable !== false) cache.put(task.cache_key, result);
      emit(task, "completed", { telemetry: resultTelemetry(result), result_ref: result.result_ref ?? { cache_key: task.cache_key } });
    } else {
      const failure = { task_id: id, code: settled.error?.code ?? "TASK_FAILED", message: settled.error?.message ?? String(settled.error) };
      emit(task, "failed", { failure_code: failure.code, reason_code: failure.message });
      if (task.failure_policy.mode === "strict") { failures.push(failure); pool.fail(id, failure); }
      else { pool.complete(id, { degraded_failure: failure }); if (task.failure_policy.mode === "degrade") degradedFailures.push(failure); else observationalFailures.push(failure); }
    }
  }
  const terminalCounts = Object.values(state.terminal_status).reduce((acc, status) => { acc[status] = (acc[status] || 0) + 1; return acc; }, {});
  const status = failures.length > 0 ? "blocked" : (degradedFailures.length > 0 || budgetFailure) ? (plan.allow_degraded ? "degraded" : "blocked") : "complete";
  persist();
  return Object.freeze(canonical({ schema_version: "ria.execution-result@1", run_id: runId, status, events, task_results: state.task_results, failures, degraded_failures: degradedFailures, observational_failures: observationalFailures, budget_failure: budgetFailure, metrics: { peak_concurrency: peakConcurrency, total_tool_calls: totalToolCalls, total_tokens: totalTokens, terminal_counts: terminalCounts }, invalidated_tasks: [...invalidated].sort() }));
}

module.exports = { CLASS_MAP, FileArtifactCache, MemoryArtifactCache, descendantSet, executePlan, loadState, validatePlan };
