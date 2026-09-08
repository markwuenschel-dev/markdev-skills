"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STATUSES = new Set(["submitted", "ready", "started", "reused", "completed", "failed", "blocked", "cancelled", "retry"]);
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function createTaskEvent(input) {
  if (!input || !input.run_id || !input.task_id || !STATUSES.has(input.status) || !Number.isInteger(input.sequence) || input.sequence < 1 || !Number.isFinite(Date.parse(input.occurred_at))) throw new Error("FAIL-RIA-TASK-EVENT: identity is invalid");
  return Object.freeze(canonical({
    schema_version: "ria.task-event@1", event_id: `ria-event:${hash({ run_id: input.run_id, task_id: input.task_id, status: input.status, sequence: input.sequence, occurred_at: input.occurred_at })}`,
    run_id: String(input.run_id), task_id: String(input.task_id), executor_class: String(input.executor_class || "unknown"), status: input.status,
    sequence: input.sequence, occurred_at: new Date(input.occurred_at).toISOString(), attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
    cache_key: input.cache_key ?? null, reason_code: input.reason_code ?? null, failure_code: input.failure_code ?? null,
    telemetry: { tool_calls: input.telemetry?.tool_calls ?? null, tokens: input.telemetry?.tokens ?? null },
    scheduler: { ready_wait_ms: input.scheduler?.ready_wait_ms ?? null, resource_blocked_ms: input.scheduler?.resource_blocked_ms ?? null, running_count: input.scheduler?.running_count ?? null },
    result_ref: input.result_ref ?? null,
  }));
}
function validateTaskEvent(value) { try { const rebuilt = createTaskEvent(value); if (JSON.stringify(rebuilt) !== JSON.stringify(canonical(value))) throw new Error("event is not canonical"); return { ok: true, errors: [] }; } catch (error) { return { ok: false, errors: [error.message] }; } }
function appendTaskEvent(filePath, event) { const validation = validateTaskEvent(event); if (!validation.ok) throw new Error(validation.errors.join("; ")); const target = path.resolve(filePath); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.appendFileSync(target, `${JSON.stringify(event)}\n`, "utf8"); return target; }
function readTaskEvents(filePath) { if (!fs.existsSync(filePath)) return []; return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
module.exports = { STATUSES, appendTaskEvent, createTaskEvent, readTaskEvents, validateTaskEvent };
