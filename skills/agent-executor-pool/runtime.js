"use strict";

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "STALE"]);
const MUTATING = new Set(["implementation", "integration", "publication"]);
const CLASSES = ["read_only", "implementation", "validation", "integration", "publication"];

function clone(v) { return JSON.parse(JSON.stringify(v)); }

class ExecutorPool {
  constructor(options = {}) {
    this.budgets = Object.assign({ read_only: 16, implementation: 8, validation: 8, integration: 1, publication: 1 }, options.budgets || {});
    this.resourceCapacities = Object.assign({}, options.resource_capacities || {});
    this.maxBufferedJobs = Number.isInteger(options.max_buffered_jobs) ? options.max_buffered_jobs : 256;
    this.jobs = new Map();
    this.seq = 0;
    this.cancelledScopes = new Set();
  }

  submit(job) {
    if (!job || typeof job !== "object") throw new Error("EXECUTOR_JOB_INVALID");
    if (!job.job_id || this.jobs.has(job.job_id)) throw new Error(this.jobs.has(job.job_id) ? "EXECUTOR_DUPLICATE_JOB" : "EXECUTOR_JOB_ID_REQUIRED");
    if (!CLASSES.includes(job.class)) throw new Error("EXECUTOR_CLASS_INVALID");
    if (MUTATING.has(job.class) && Number(job.executor_depth || 0) > 1) throw new Error("NESTED_MUTATING_EXECUTOR_FORBIDDEN");
    if (this.jobs.size >= this.maxBufferedJobs) throw new Error("EXECUTOR_BACKPRESSURE");
    const resources = Array.isArray(job.resources) ? job.resources.map(r => Object.assign({}, r)) : [];
    for (const r of resources) {
      if (!r.id || !["shared", "exclusive"].includes(r.mode) || !Number.isInteger(r.permits) || r.permits < 1) throw new Error("EXECUTOR_RESOURCE_REQUEST_INVALID");
    }
    const rec = Object.assign({}, clone(job), { dependencies: (job.dependencies || []).slice(), resources, status: "PENDING", submitted_seq: ++this.seq, started_seq: null, finished_seq: null, outcome: null });
    this.jobs.set(rec.job_id, rec);
    return clone(rec);
  }

  setBudget(cls, value) {
    if (!CLASSES.includes(cls) || !Number.isInteger(value) || value < 0) throw new Error("EXECUTOR_BUDGET_INVALID");
    this.budgets[cls] = value;
  }

  _running() { return [...this.jobs.values()].filter(j => j.status === "RUNNING"); }
  _classRunning(cls) { return this._running().filter(j => j.class === cls).length; }

  _resourceUsage() {
    const usage = new Map();
    for (const j of this._running()) for (const r of j.resources) {
      if (!usage.has(r.id)) usage.set(r.id, { shared: 0, exclusive: false });
      const u = usage.get(r.id);
      if (r.mode === "exclusive") u.exclusive = true; else u.shared += r.permits;
    }
    return usage;
  }

  _resourcesAvailable(job, usage) {
    for (const r of job.resources) {
      const cap = Number.isInteger(this.resourceCapacities[r.id]) ? this.resourceCapacities[r.id] : 1;
      const u = usage.get(r.id) || { shared: 0, exclusive: false };
      if (r.mode === "exclusive") {
        if (u.exclusive || u.shared > 0) return false;
      } else {
        if (u.exclusive || u.shared + r.permits > cap) return false;
      }
    }
    return true;
  }

  _reserve(job, usage) {
    for (const r of job.resources) {
      if (!usage.has(r.id)) usage.set(r.id, { shared: 0, exclusive: false });
      const u = usage.get(r.id);
      if (r.mode === "exclusive") u.exclusive = true; else u.shared += r.permits;
    }
  }

  _refreshReadiness() {
    for (const j of this.jobs.values()) {
      if (TERMINAL.has(j.status) || j.status === "RUNNING") continue;
      if (this.cancelledScopes.has(j.scope_id)) { j.status = "CANCELLED"; j.finished_seq = ++this.seq; continue; }
      let waiting = false, failed = false;
      for (const depId of j.dependencies) {
        const d = this.jobs.get(depId);
        if (!d) { waiting = true; continue; }
        if (["FAILED", "BLOCKED", "CANCELLED", "STALE"].includes(d.status)) failed = true;
        else if (d.status !== "SUCCEEDED") waiting = true;
      }
      j.status = failed ? "BLOCKED" : waiting ? "PENDING" : "READY";
      if (failed && !j.finished_seq) j.finished_seq = ++this.seq;
    }
  }

  schedule() {
    this._refreshReadiness();
    const usage = this._resourceUsage();
    const candidates = [...this.jobs.values()].filter(j => j.status === "READY")
      .sort((a,b) => (Number(b.priority || 0) - Number(a.priority || 0)) || a.submitted_seq - b.submitted_seq || a.job_id.localeCompare(b.job_id));
    const admissions = [];
    const classRunning = Object.fromEntries(CLASSES.map(c => [c, this._classRunning(c)]));
    for (const j of candidates) {
      const cap = Number(this.budgets[j.class] || 0);
      if (classRunning[j.class] >= cap) continue;
      if (!this._resourcesAvailable(j, usage)) continue;
      j.status = "RUNNING"; j.started_seq = ++this.seq;
      classRunning[j.class] += 1; this._reserve(j, usage); admissions.push(j.job_id);
    }
    return admissions;
  }

  complete(jobId, outcome = {}) { return this._finish(jobId, "SUCCEEDED", outcome); }
  fail(jobId, outcome = {}) { return this._finish(jobId, "FAILED", outcome); }
  stale(jobId, outcome = {}) { return this._finish(jobId, "STALE", outcome); }

  _finish(jobId, status, outcome) {
    const j = this.jobs.get(jobId); if (!j) throw new Error("EXECUTOR_UNKNOWN_JOB");
    if (j.status !== "RUNNING") throw new Error("EXECUTOR_JOB_NOT_RUNNING");
    j.status = status; j.outcome = clone(outcome); j.finished_seq = ++this.seq;
    this._refreshReadiness(); return clone(j);
  }

  cancelScope(scopeId) {
    this.cancelledScopes.add(scopeId);
    const running = [], cancelled = [];
    for (const j of this.jobs.values()) if (j.scope_id === scopeId && !TERMINAL.has(j.status)) {
      if (j.status === "RUNNING") running.push(j.job_id);
      else { j.status = "CANCELLED"; j.finished_seq = ++this.seq; cancelled.push(j.job_id); }
    }
    return { cancel_requests: running.sort(), cancelled: cancelled.sort() };
  }

  snapshot() { this._refreshReadiness(); return [...this.jobs.values()].map(clone).sort((a,b) => a.submitted_seq-b.submitted_seq); }
}

module.exports = { ExecutorPool, CLASSES, TERMINAL, MUTATING };
