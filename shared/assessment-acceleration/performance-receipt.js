"use strict";

const { defaultWorkerBudget } = require("./scheduler.js");
const { resolveConcurrencyProfile } = require("./concurrency-profile.js");

const CACHE_KEYS = Object.freeze({
  exact: "exact",
  "content-stable": "content_stable",
  content_stable: "content_stable",
  "warm-only": "warm_only",
  warm_only: "warm_only",
  miss: "miss"
});

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeMode(value) {
  if (["cold", "warm", "mixed"].includes(value)) return value;
  throw new Error("PERFORMANCE_MODE_INVALID:" + value);
}

class PerformanceReceipt {
  constructor(options = {}) {
    this.clock = typeof options.clock === "function" ? options.clock : Date.now;
    this.started = this.clock();
    this.closed = false;
    const profile = resolveConcurrencyProfile(options.env || process.env);
    this.receipt = {
      receipt_schema_version: 1,
      mode: normalizeMode(options.mode || "cold"),
      worker_budget: positiveInteger(options.worker_budget, defaultWorkerBudget(options.env)),
      class_budgets: { ...profile.class_budgets, ...(options.class_budgets || {}) },
      queue_multiplier: positiveInteger(options.queue_multiplier, profile.queue_multiplier),
      planned_tasks: 0,
      peak_concurrency: 0,
      peak_by_class: {},
      cache: { exact: 0, content_stable: 0, warm_only: 0, miss: 0 },
      invalidated: [],
      stage_elapsed_ms: {},
      wall_elapsed_ms: 0
    };
    if (options.owner_lane_counts) this.setOwnerLaneCounts(options.owner_lane_counts);
  }

  assertOpen() {
    if (this.closed) throw new Error("PERFORMANCE_RECEIPT_CLOSED");
  }

  setPlannedTasks(value) {
    this.assertOpen();
    this.receipt.planned_tasks = Math.floor(finiteNonNegative(value));
    return this;
  }

  setOwnerLaneCounts(counts) {
    this.assertOpen();
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) throw new Error("OWNER_LANE_COUNTS_INVALID");
    this.receipt.owner_lane_counts = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([owner, count]) => {
      if (!owner || !Number.isInteger(Number(count)) || Number(count) < 0) throw new Error("OWNER_LANE_COUNT_INVALID:" + owner);
      return [owner, Number(count)];
    }));
    return this;
  }

  recordCache(reuse, count = 1) {
    this.assertOpen();
    const key = CACHE_KEYS[reuse];
    if (!key) throw new Error("CACHE_REUSE_CLASS_INVALID:" + reuse);
    if (!Number.isInteger(Number(count)) || Number(count) < 0) throw new Error("CACHE_REUSE_COUNT_INVALID");
    this.receipt.cache[key] += Number(count);
    return this;
  }

  invalidate(reason, details = {}) {
    this.assertOpen();
    if (typeof reason !== "string" || !reason.trim()) throw new Error("INVALIDATION_REASON_REQUIRED");
    if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("INVALIDATION_DETAILS_INVALID");
    this.receipt.invalidated.push({ reason: reason.trim(), ...details });
    return this;
  }

  startStage(name) {
    this.assertOpen();
    if (typeof name !== "string" || !name.trim()) throw new Error("PERFORMANCE_STAGE_REQUIRED");
    const stage = name.trim();
    const started = this.clock();
    let ended = false;
    return () => {
      this.assertOpen();
      if (ended) throw new Error("PERFORMANCE_STAGE_ALREADY_ENDED:" + stage);
      ended = true;
      const elapsed = finiteNonNegative(this.clock() - started);
      this.receipt.stage_elapsed_ms[stage] = finiteNonNegative(this.receipt.stage_elapsed_ms[stage]) + elapsed;
      return elapsed;
    };
  }

  async measure(name, operation) {
    if (typeof operation !== "function") throw new Error("PERFORMANCE_OPERATION_INVALID");
    const end = this.startStage(name);
    try { return await operation(); }
    finally { end(); }
  }

  absorbScheduler(result) {
    this.assertOpen();
    if (!result || typeof result !== "object") throw new Error("SCHEDULER_RESULT_INVALID");
    if (Number.isInteger(result.max_parallel) && result.max_parallel > 0) this.receipt.worker_budget = result.max_parallel;
    if (result.class_budgets && typeof result.class_budgets === "object") this.receipt.class_budgets = { ...result.class_budgets };
    if (Number.isFinite(result.peak_concurrency)) this.receipt.peak_concurrency = Math.max(this.receipt.peak_concurrency, result.peak_concurrency);
    if (result.peak_by_class && typeof result.peak_by_class === "object") {
      for (const [cls, value] of Object.entries(result.peak_by_class)) {
        if (Number.isFinite(value)) this.receipt.peak_by_class[cls] = Math.max(this.receipt.peak_by_class[cls] || 0, value);
      }
    }
    if (Number.isFinite(result.wall_elapsed_ms)) this.receipt.stage_elapsed_ms.scheduler = finiteNonNegative(this.receipt.stage_elapsed_ms.scheduler) + result.wall_elapsed_ms;
    if (Number.isFinite(result.serial_estimate_ms)) this.receipt.serial_estimate_ms = finiteNonNegative(this.receipt.serial_estimate_ms) + result.serial_estimate_ms;
    const schedulerWall = finiteNonNegative(this.receipt.stage_elapsed_ms.scheduler);
    if (schedulerWall > 0 && Number.isFinite(this.receipt.serial_estimate_ms)) this.receipt.speedup_estimate = Number((this.receipt.serial_estimate_ms / schedulerWall).toFixed(3));
    if (result.results && typeof result.results === "object") this.receipt.planned_tasks = Math.max(this.receipt.planned_tasks, Object.keys(result.results).length);
    return this;
  }

  recordReport(compiled, elapsedMs) {
    this.assertOpen();
    if (!compiled || typeof compiled !== "object") throw new Error("REPORT_COMPILE_RESULT_INVALID");
    const measured = Number.isFinite(elapsedMs) ? elapsedMs : compiled.compile_elapsed_ms;
    if (Number.isFinite(measured)) this.receipt.stage_elapsed_ms.report_compile = finiteNonNegative(measured);
    if (Number.isFinite(compiled.bytes)) this.receipt.report_bytes = Number(compiled.bytes);
    if (typeof compiled.sha256 === "string") this.receipt.report_sha256 = compiled.sha256;
    return this;
  }

  finalize(extra = {}) {
    this.assertOpen();
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("PERFORMANCE_RECEIPT_EXTRA_INVALID");
    for (const key of Object.keys(extra)) if (Object.prototype.hasOwnProperty.call(this.receipt, key)) throw new Error("PERFORMANCE_RECEIPT_EXTRA_COLLISION:" + key);
    this.receipt.wall_elapsed_ms = finiteNonNegative(this.clock() - this.started);
    const result = Object.freeze({ ...this.receipt, ...extra, cache: Object.freeze({ ...this.receipt.cache }), invalidated: Object.freeze(this.receipt.invalidated.map(item => Object.freeze({ ...item }))), stage_elapsed_ms: Object.freeze({ ...this.receipt.stage_elapsed_ms }) });
    this.closed = true;
    return result;
  }
}

module.exports = { CACHE_KEYS, normalizeMode, PerformanceReceipt };
