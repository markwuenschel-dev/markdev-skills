"use strict";
const { finiteOrNull, gradeForScore, GRADE_BANDS } = require("../../shared/ria-scoring/scoring.js");

const WEIGHTS = Object.freeze({
  boundary_integrity: 20,
  dependency_direction_cycle_control: 15,
  cohesion_locality: 15,
  interface_contract_clarity: 15,
  state_data_ownership: 10,
  change_containment_evolvability: 10,
  duplication_competing_implementations: 10,
  architectural_testability_observability: 5,
});
const V2 = "architecture.fitness@2";
function fail(detail) { throw new Error(`FAIL-ARCHITECTURE-FITNESS: ${detail}`); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function closed(value, allowed, required, label) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} is not closed or lacks required fields`);
}
function confidence(input) {
  const value = input.confidence ?? null;
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) fail("confidence must be null or a number in [0, 1]");
  return value;
}
function summary(dimensions, level, schemaVersion) {
  let numerator = 0, denominator = 0;
  for (const [id, weight] of Object.entries(WEIGHTS)) {
    const score = schemaVersion === V2 ? dimensions[id].score : dimensions[id];
    if (score !== null) { numerator += score * weight; denominator += weight; }
  }
  const score = denominator ? Math.round(numerator / denominator * 10) / 10 : null;
  return { schema_version: schemaVersion, score, grade: gradeForScore(score), coverage: denominator / 100, confidence: level, dimensions, weights: WEIGHTS };
}
function dimension(value, id) {
  closed(value, ["score", "state", "reason_code", "detail", "evidence_refs"], ["score", "state"], id);
  if (!["scored", "unavailable", "not_applicable"].includes(value.state)) fail(`${id}.state is invalid`);
  if (value.state === "scored") {
    if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) fail(`${id}.score must be a number in [0, 100]`);
  } else if (value.score !== null || !nonempty(value.reason_code) || !nonempty(value.detail)) fail(`${id} requires null score, reason_code and detail`);
  for (const key of ["reason_code", "detail"]) if (Object.hasOwn(value, key) && !nonempty(value[key])) fail(`${id}.${key} is empty`);
  if (Object.hasOwn(value, "evidence_refs") && (!Array.isArray(value.evidence_refs) || !value.evidence_refs.length || value.evidence_refs.some(ref => !nonempty(ref)))) fail(`${id}.evidence_refs must contain nonempty source references`);
  if (value.state === "not_applicable" && !value.evidence_refs?.length) fail(`${id}.not_applicable requires evidence_refs`);
  return structuredClone(value);
}
/** Retains the v1 numerical adapter for old standalone callers. New @2 input is strict. */
function normalizeArchitectureFitness(input) {
  if (!object(input)) return null;
  if (Object.hasOwn(input, "schema_version") && !["architecture.fitness@1", V2].includes(input.schema_version)) fail("unsupported schema_version");
  const level = confidence(input), dims = {};
  if (input.schema_version === V2) {
    if (Object.hasOwn(input, "score") && input.score !== null && (typeof input.score !== "number" || !Number.isFinite(input.score) || input.score < 0 || input.score > 100)) fail("declared score must be null or a number in [0, 100]");
    if (Object.hasOwn(input, "grade") && input.grade !== null && !GRADE_BANDS.some(([, label]) => input.grade === label)) fail("declared grade must be null or a supported grade label");
    if (Object.hasOwn(input, "coverage") && (typeof input.coverage !== "number" || !Number.isFinite(input.coverage) || input.coverage < 0 || input.coverage > 1)) fail("declared coverage must be a number in [0, 1]");
    if (Object.hasOwn(input, "weights") && !object(input.weights)) fail("declared weights must be an object");
    closed(input, ["schema_version", "dimensions", "confidence", "score", "grade", "coverage", "weights"], ["schema_version", "dimensions"], "fitness");
    closed(input.dimensions, Object.keys(WEIGHTS), Object.keys(WEIGHTS), "dimensions");
    for (const id of Object.keys(WEIGHTS)) dims[id] = dimension(input.dimensions[id], id);
    return summary(dims, level, V2);
  }
  for (const id of Object.keys(WEIGHTS)) {
    const score = finiteOrNull(input.dimensions?.[id]);
    dims[id] = score === null ? null : Math.max(0, Math.min(100, score));
  }
  return summary(dims, level, "architecture.fitness@1");
}
/** Read migration only: callers supply parsed bytes; stored artifacts are never rewritten. */
function readArchitectureFitness(input) {
  const value = normalizeArchitectureFitness(input);
  if (!value || value.schema_version === V2) return value;
  return summary(Object.fromEntries(Object.entries(value.dimensions).map(([id, score]) => [id, score === null
    ? { score: null, state: "unavailable", reason_code: "LEGACY_NULL", detail: "Legacy architecture fitness has no score for this dimension." }
    : { score, state: "scored" }])), value.confidence, V2);
}
/** Missing mass is local to the mapped dimension, independent of global fitness coverage. */
function mappedFitnessSummary(input, ids) {
  const value = readArchitectureFitness(input);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !Object.hasOwn(WEIGHTS, id))) fail("invalid fitness dimension mapping");
  if (!value) return { score: null, coverage: 0, confidence: null, complete: false };
  let applicable = 0, assessed = 0, numerator = 0;
  for (const id of ids) {
    const item = value.dimensions[id];
    if (item.state === "not_applicable") continue;
    applicable += WEIGHTS[id];
    if (item.state === "scored") { assessed += WEIGHTS[id]; numerator += item.score * WEIGHTS[id]; }
  }
  return { score: assessed ? numerator / assessed : null, coverage: applicable ? assessed / applicable : null, confidence: value.confidence, complete: applicable > 0 && assessed === applicable };
}
function normalizeCandidateFitness(value, { requireV2 = false } = {}) {
  const hasFitness = Object.hasOwn(value, "architecture_fitness"), hasUnavailable = Object.hasOwn(value, "architecture_fitness_unavailable");
  if ((hasFitness && hasUnavailable) || (requireV2 && (hasFitness === hasUnavailable || (hasFitness && value.architecture_fitness?.schema_version !== V2)))) {
    throw new Error("FAIL-ARCHITECTURE-FITNESS-REQUIRED: supply exactly one complete architecture.fitness@2 or architecture_fitness_unavailable");
  }
  const result = { ...value };
  if (hasFitness) {
    result.architecture_fitness = normalizeArchitectureFitness(value.architecture_fitness);
    if (!result.architecture_fitness) fail("architecture_fitness must be an object");
  }
  if (hasUnavailable) {
    closed(value.architecture_fitness_unavailable, ["reason_code", "detail"], ["reason_code", "detail"], "architecture_fitness_unavailable");
    if (!nonempty(value.architecture_fitness_unavailable.reason_code) || !nonempty(value.architecture_fitness_unavailable.detail)) fail("unavailable fitness requires reason_code and detail");
    result.architecture_fitness_unavailable = structuredClone(value.architecture_fitness_unavailable);
  }
  return result;
}
module.exports = { WEIGHTS, normalizeArchitectureFitness, readArchitectureFitness, mappedFitnessSummary, normalizeCandidateFitness };
