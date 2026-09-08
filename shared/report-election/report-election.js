"use strict";

const POLICIES = Object.freeze(["ask", "generate", "skip", "inherit"]);
const LEANS = Object.freeze(["generate", "skip"]);
const STATES = Object.freeze(["pending-user-election", "elected-generate", "elected-skip", "inherited"]);

function nonNegative(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function recommendLean(signals = {}) {
  if (signals.parent_report_pending === true) {
    return { lean: "skip", reason: "a parent workflow is already positioned to synthesize the same material into one report" };
  }
  let score = 0;
  const findings = nonNegative(signals.finding_count);
  const candidates = nonNegative(signals.candidate_count);
  const cross = nonNegative(signals.cross_cutting_count);
  const comparisons = nonNegative(signals.comparison_count);
  const uncertainty = nonNegative(signals.uncertainty_count);
  const visuals = nonNegative(signals.visual_structure_count);
  if (findings >= 4) score += 2;
  else if (findings >= 2) score += 1;
  if (candidates >= 4) score += 2;
  else if (candidates >= 2) score += 1;
  if (cross > 0) score += 3;
  if (comparisons >= 2) score += 2;
  if (uncertainty >= 3) score += 1;
  if (visuals > 0) score += 2;
  if (signals.durable_review_value === true) score += 2;
  if (signals.report_cost === "medium") score -= 1;
  if (signals.report_cost === "high") score -= 2;
  if (score >= 3) {
    return { lean: "generate", reason: "the result has enough breadth, comparison, cross-cutting structure, or durable-review value for a report to add material value" };
  }
  return { lean: "skip", reason: "the result is narrow enough that the canonical artifact and concise summary should preserve nearly all useful information" };
}

function resolvePolicy({ policy = "ask", report_owner = null, explicit = null, signals = {} } = {}) {
  if (!POLICIES.includes(policy)) throw new Error("REPORT_POLICY_INVALID:" + policy);
  if (explicit === "generate" || explicit === "skip") policy = explicit;
  const recommendation = recommendLean(signals);
  if (policy === "inherit") {
    if (typeof report_owner !== "string" || !report_owner.trim()) throw new Error("REPORT_OWNER_REQUIRED_FOR_INHERIT");
    return { policy, report_owner, ...recommendation, state: "inherited" };
  }
  if (policy === "generate") return { policy, report_owner, lean: "generate", reason: "report generation was explicitly authorized", state: "elected-generate" };
  if (policy === "skip") return { policy, report_owner, lean: "skip", reason: "report rendering was explicitly declined", state: "elected-skip" };
  return { policy, report_owner, ...recommendation, state: "pending-user-election" };
}

function validateElectionRecord(record) {
  const problems = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return { ok:false, problems:["record must be an object"] };
  if (record.schema_version !== 1) problems.push("schema_version must be 1");
  if (!POLICIES.includes(record.policy)) problems.push("policy invalid");
  if (!LEANS.includes(record.lean)) problems.push("lean invalid");
  if (!STATES.includes(record.state)) problems.push("state invalid");
  if (typeof record.reason !== "string" || !record.reason.trim()) problems.push("reason required");
  if (record.policy === "inherit" && (typeof record.report_owner !== "string" || !record.report_owner.trim())) problems.push("inherit requires report_owner");
  if (record.policy !== "inherit" && record.report_owner !== null && typeof record.report_owner !== "string") problems.push("report_owner must be string or null");
  return { ok: problems.length === 0, problems };
}

module.exports = { POLICIES, LEANS, STATES, recommendLean, resolvePolicy, validateElectionRecord };
