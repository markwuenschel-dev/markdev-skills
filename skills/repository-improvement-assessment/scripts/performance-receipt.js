#!/usr/bin/env node
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const TERMINAL = new Set(["reused", "completed", "failed", "blocked", "cancelled"]);
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function sha256(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function finite(value) { return value === null || value === undefined ? null : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null; }
function observation(value) { if (Number.isFinite(value)) return { value: Number(value), evidence: "measured" }; if (value && Number.isFinite(value.value) && ["measured", "estimated", "unavailable"].includes(value.evidence)) return { value: Number(value.value), evidence: value.evidence }; return { value: null, evidence: "unavailable" }; }
function metric(value, evidence = "measured") { return { value: finite(value), evidence: finite(value) === null ? "unavailable" : evidence }; }
function fail(detail) { throw new Error(`FAIL-RIA-PERFORMANCE-RECEIPT: ${detail}`); }

function taskRows(plan, events) {
  const byTask = new Map(plan.tasks.map((task) => [task.task_id, []]));
  for (const event of events) { if (!byTask.has(event.task_id)) fail(`event references unplanned task ${event.task_id}`); byTask.get(event.task_id).push(event); }
  return plan.tasks.map((task) => {
    const stream = byTask.get(task.task_id).sort((a, b) => a.sequence - b.sequence); const started = stream.find((event) => event.status === "started"); const terminal = stream.find((event) => TERMINAL.has(event.status)); const ready = stream.find((event) => event.status === "ready");
    if (!terminal) fail(`task ${task.task_id} has no scheduler terminal event`);
    const duration = started ? Math.max(0, Date.parse(terminal.occurred_at) - Date.parse(started.occurred_at)) : 0;
    return canonical({ task_id: task.task_id, owner: task.owner, executor_class: task.executor_class, state: terminal.status, duration_ms: duration, ready_wait_ms: started?.scheduler?.ready_wait_ms ?? (ready ? Math.max(0, Date.parse(started?.occurred_at ?? terminal.occurred_at) - Date.parse(ready.occurred_at)) : null), resource_blocked_ms: started?.scheduler?.resource_blocked_ms ?? null, tool_calls: observation(terminal.telemetry?.tool_calls), tokens: observation(terminal.telemetry?.tokens), cache_disposition: terminal.status === "reused" ? "EXACT_REUSE" : task.reuse.component ? "MISS" : "NOT_APPLICABLE", estimated_avoided_ms: terminal.status === "reused" ? finite(task.estimated_duration_ms) : 0 });
  });
}
function criticalPath(plan, rows) {
  const durations = new Map(rows.map((row) => [row.task_id, row.state === "reused" ? 0 : row.duration_ms])); const end = new Map(); const parent = new Map(); const remaining = new Set(plan.tasks.map((task) => task.task_id));
  while (remaining.size) { let changed = false; for (const task of plan.tasks) if (remaining.has(task.task_id) && task.dependencies.every((id) => end.has(id))) { let best = null; for (const dependency of task.dependencies) if (best === null || end.get(dependency) > end.get(best)) best = dependency; end.set(task.task_id, (best ? end.get(best) : 0) + durations.get(task.task_id)); parent.set(task.task_id, best); remaining.delete(task.task_id); changed = true; } if (!changed) fail("plan is cyclic"); }
  let leaf = [...end.keys()].sort((a, b) => end.get(b) - end.get(a) || a.localeCompare(b))[0]; const tasks = []; while (leaf) { tasks.push(leaf); leaf = parent.get(leaf); }
  return { duration_ms: end.get(tasks[0]) ?? 0, task_ids: tasks.reverse() };
}
function concurrency(events) {
  const changes = [];
  for (const event of events) { if (event.status === "started") changes.push({ at: Date.parse(event.occurred_at), sequence: event.sequence, delta: 1 }); if (TERMINAL.has(event.status)) changes.push({ at: Date.parse(event.occurred_at), sequence: event.sequence, delta: -1 }); }
  changes.sort((a, b) => a.at - b.at || a.sequence - b.sequence); let current = 0; let peak = 0; for (const change of changes) { current = Math.max(0, current + change.delta); peak = Math.max(peak, current); } return peak;
}
function readyPeak(events) { const changes = []; for (const event of events) { if (event.status === "ready") changes.push({ sequence: event.sequence, delta: 1 }); if (event.status === "started") changes.push({ sequence: event.sequence, delta: -1 }); } changes.sort((a, b) => a.sequence - b.sequence); let current = 0; let peak = 0; for (const change of changes) { current = Math.max(0, current + change.delta); peak = Math.max(peak, current); } return peak; }
function aggregateEvidence(rows, field) { const observed = rows.map((row) => row[field]).filter((item) => item.value !== null); if (!observed.length) return { value: null, evidence: "unavailable" }; return { value: observed.reduce((sum, item) => sum + item.value, 0), evidence: observed.some((item) => item.evidence === "estimated") ? "estimated" : "measured" }; }

function buildPerformanceReceipt(input) {
  const plan = input?.plan; const execution = input?.execution_result; if (!plan || !execution || !Array.isArray(execution.events)) fail("plan and execution_result.events are required");
  const events = execution.events.filter((event) => event.run_id === execution.run_id); if (!events.length) fail("event stream is empty");
  const rows = taskRows(plan, events); const critical = criticalPath(plan, rows); const times = events.map((event) => Date.parse(event.occurred_at)).filter(Number.isFinite); const wall = Math.max(...times) - Math.min(...times); const serial = rows.filter((row) => ["completed", "failed"].includes(row.state)).reduce((sum, row) => sum + row.duration_ms, 0); const avoided = rows.reduce((sum, row) => sum + (row.estimated_avoided_ms || 0), 0);
  const body = canonical({
    schema_version: "ria.performance-receipt@2", run_id: execution.run_id, generated_at: new Date(Math.max(...times)).toISOString(), telemetry_status: "available", telemetry_failure_code: null,
    metrics: { serial_work_ms: metric(serial), critical_path_ms: metric(critical.duration_ms), actual_wall_ms: metric(wall), scheduler_overhead_ms: metric(Math.max(0, wall - critical.duration_ms)), cache_reuse_savings_ms: metric(avoided, "estimated"), parallelism_factor: metric(wall > 0 ? serial / wall : null), peak_concurrency: metric(concurrency(events)), ready_queue_peak: metric(readyPeak(events)), ready_queue_time_ms: metric(rows.reduce((sum, row) => sum + (row.ready_wait_ms || 0), 0)), resource_blocked_time_ms: metric(rows.reduce((sum, row) => sum + (row.resource_blocked_ms || 0), 0)), tool_calls: aggregateEvidence(rows, "tool_calls"), tokens: aggregateEvidence(rows, "tokens") },
    critical_path_task_ids: critical.task_ids, class_budgets: plan.class_budgets, tasks: rows,
  });
  return Object.freeze(canonical({ ...body, receipt_sha256: sha256(body) }));
}
function unavailablePerformanceReceipt(runId, code) { const body = canonical({ schema_version: "ria.performance-receipt@2", run_id: String(runId), generated_at: new Date().toISOString(), telemetry_status: "unavailable", telemetry_failure_code: String(code), metrics: null, critical_path_task_ids: [], class_budgets: {}, tasks: [] }); return Object.freeze(canonical({ ...body, receipt_sha256: sha256(body) })); }
function validatePerformanceReceipt(value) { try { if (!value || value.schema_version !== "ria.performance-receipt@2" || !/^[0-9a-f]{64}$/.test(value.receipt_sha256 || "")) fail("identity invalid"); const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "receipt_sha256")); if (sha256(body) !== value.receipt_sha256) fail("receipt hash mismatch"); if (!new Set(["available", "unavailable"]).has(value.telemetry_status)) fail("telemetry status invalid"); return { ok: true, errors: [] }; } catch (error) { return { ok: false, errors: [error.message] }; } }

if (require.main === module) { try { const input = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), "utf8")); const receipt = buildPerformanceReceipt(input); const bytes = `${JSON.stringify(receipt, null, 2)}\n`; if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), bytes); else process.stdout.write(bytes); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { buildPerformanceReceipt, unavailablePerformanceReceipt, validatePerformanceReceipt };
