"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { withFileLock } = require("./file-lock");

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } }
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, file);
}

class AttemptStore {
  constructor(stateDir, options = {}) {
    this.stateDir = path.resolve(stateDir);
    this.lockTimeoutMs = Number(options.lock_timeout_ms || 10000);
    this.lockStaleMs = Number(options.lock_stale_ms || 300000);
    fs.mkdirSync(this.stateDir, { recursive: true });
  }
  _key(campaignId, taskId) { return encodeURIComponent(campaignId) + "--" + encodeURIComponent(taskId); }
  _file(campaignId, taskId) { return path.join(this.stateDir, this._key(campaignId, taskId) + ".json"); }
  _withLock(campaignId, taskId, operation) { return withFileLock(this._file(campaignId, taskId) + ".lock", operation, { timeout_ms: this.lockTimeoutMs, stale_ms: this.lockStaleMs }); }
  begin(campaignId, taskId, options = {}) {
    const maxAttempts = Number(options.max_attempts || 1);
    if (!campaignId || !taskId || !Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("ATTEMPT_BEGIN_INVALID");
    return this._withLock(campaignId, taskId, () => {
      const file = this._file(campaignId, taskId);
      const state = read(file) || { schema_version: 1, campaign_id: campaignId, task_id: taskId, status: "pending", max_attempts: maxAttempts, attempts: [] };
      if (state.status === "succeeded") return { started: false, reason: "ALREADY_SUCCEEDED", state: clone(state) };
      if (state.status === "hard-stop" || state.attempts.length >= maxAttempts) return { started: false, reason: "RETRY_BUDGET_EXHAUSTED", state: clone(state) };
      const active = state.attempts.find(item => item.status === "running");
      if (active && !options.recover_running) return { started: false, reason: "ATTEMPT_IN_FLIGHT", attempt: clone(active), state: clone(state) };
      if (active) {
        active.status = "failed";
        active.outcome = "orphaned-recovered";
        active.reason = "FENCED_LEASE_RECOVERY";
        active.finished_at = new Date().toISOString();
        state.status = "retryable";
        if (state.attempts.length >= maxAttempts) {
          state.status = "hard-stop";
          state.stop_reason = "RETRY_BUDGET_EXHAUSTED";
          atomicWrite(file, state);
          return { started: false, reason: "RETRY_BUDGET_EXHAUSTED", state: clone(state) };
        }
      }
      const now = new Date().toISOString();
      const attempt = { attempt_id: "attempt-" + (state.attempts.length + 1) + "-" + crypto.randomBytes(6).toString("hex"), attempt_number: state.attempts.length + 1, worker_identity: options.worker_identity || null, status: "running", started_at: now, finished_at: null, outcome: null, reason: null, evidence: [] };
      state.max_attempts = maxAttempts;
      state.status = "running";
      state.attempts.push(attempt);
      atomicWrite(file, state);
      return { started: true, attempt: clone(attempt), state: clone(state) };
    });
  }
  appendEvidence(campaignId, taskId, attemptId, evidence) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("ATTEMPT_EVIDENCE_INVALID");
    return this._withLock(campaignId, taskId, () => {
      const file = this._file(campaignId, taskId), state = read(file);
      const attempt = state && state.attempts.find(item => item.attempt_id === attemptId);
      if (!attempt || attempt.status !== "running") throw new Error("ATTEMPT_NOT_CURRENT");
      attempt.evidence.push({ ...clone(evidence), recorded_at: new Date().toISOString() });
      atomicWrite(file, state);
      return clone(attempt);
    });
  }
  finish(campaignId, taskId, attemptId, result = {}) {
    if (!["succeeded", "retryable-failure", "hard-stop"].includes(result.outcome)) throw new Error("ATTEMPT_OUTCOME_INVALID");
    return this._withLock(campaignId, taskId, () => {
      const file = this._file(campaignId, taskId), state = read(file);
      const attempt = state && state.attempts.find(item => item.attempt_id === attemptId);
      if (!attempt || attempt.status !== "running") throw new Error("ATTEMPT_NOT_CURRENT");
      attempt.finished_at = new Date().toISOString();
      attempt.outcome = result.outcome;
      attempt.reason = result.reason || null;
      if (result.outcome === "succeeded") { attempt.status = "succeeded"; state.status = "succeeded"; }
      else if (result.outcome === "hard-stop" || state.attempts.length >= state.max_attempts) { attempt.status = "failed"; state.status = "hard-stop"; state.stop_reason = result.outcome === "hard-stop" ? (result.reason || "HARD_STOP") : "RETRY_BUDGET_EXHAUSTED"; }
      else { attempt.status = "failed"; state.status = "retryable"; }
      atomicWrite(file, state);
      return { status: state.status, reason: state.stop_reason || attempt.reason, attempt: clone(attempt), state: clone(state) };
    });
  }
  read(campaignId, taskId) { const value = read(this._file(campaignId, taskId)); return value ? clone(value) : null; }
}

module.exports = { AttemptStore };
