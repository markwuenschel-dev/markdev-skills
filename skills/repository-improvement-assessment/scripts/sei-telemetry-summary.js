"use strict";
const crypto = require("node:crypto");
const STATES = new Set(["established", "provisional", "not_scored", "not_applicable"]);
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function sha256(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function criterionState(criterion) { if (criterion?.applicability === "not_applicable") return "not_applicable"; if (criterion?.applicability === "not_scored" || criterion?.maturity === "not_scored") return "not_scored"; if (criterion?.maturity === "established") return "established"; if (criterion?.maturity === "provisional") return "provisional"; throw new Error(`FAIL-SEI-TELEMETRY-SUMMARY: criterion ${criterion?.criterion_id ?? "unknown"} has no exclusive accounting state`); }
function unavailable(input = {}, code = "NOT_RECORDED") { return Object.freeze(canonical({ schema_version: "sei.telemetry-summary@1", summary_id: `sei-telemetry:${sha256({ binding: input.sei_binding ?? null, code })}`, sei_binding: input.sei_binding ?? null, cache_disposition: input.cache_disposition ?? null, collector_status: "unavailable", observation_counts: null, criterion_counts: null, phase_timings_ms: null, degraded_count: null, unavailable_count: null, gate_observation_ratio: null, gate_observation_status: "UNAVAILABLE", failure_code: code })); }
function buildSeiTelemetrySummary(input = {}) {
  if (!input.sei_binding) return unavailable(input, "SEI_BINDING_UNAVAILABLE");
  const criteria = input.assessment?.criteria;
  if (!Array.isArray(criteria)) return unavailable(input, "ASSESSMENT_TELEMETRY_NOT_RECORDED");
  const counts = { established: 0, provisional: 0, not_scored: 0, not_applicable: 0, total: criteria.length };
  for (const criterion of criteria) { const state = criterionState(criterion); if (!STATES.has(state)) throw new Error("FAIL-SEI-TELEMETRY-SUMMARY: invalid accounting state"); counts[state] += 1; }
  if (counts.established + counts.provisional + counts.not_scored + counts.not_applicable !== counts.total) throw new Error("FAIL-SEI-TELEMETRY-SUMMARY: accounting is not exhaustive");
  const denominator = counts.total - counts.not_applicable; const numerator = counts.established + counts.provisional;
  const ratio = denominator > 0 ? numerator / denominator : null;
  const body = canonical({ schema_version: "sei.telemetry-summary@1", sei_binding: input.sei_binding, cache_disposition: input.cache_disposition ?? "MISS", collector_status: input.collector_status ?? "recorded", observation_counts: input.observation_counts ?? null, criterion_counts: { ...counts, applicable: denominator, assessed: numerator }, phase_timings_ms: input.phase_timings_ms ?? null, degraded_count: input.degraded_count ?? 0, unavailable_count: input.unavailable_count ?? counts.not_scored, gate_observation_ratio: ratio, gate_observation_status: ratio === null ? "UNAVAILABLE" : "RECORDED", failure_code: null });
  return Object.freeze(canonical({ ...body, summary_id: `sei-telemetry:${sha256(body)}` }));
}
module.exports = { STATES, buildSeiTelemetrySummary, criterionState, unavailable };
