"use strict";

const round = (value) => Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
const compare = (left, right) => String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function notComparable(prior, reason, state = "methodology-changed") {
  return Object.freeze({
    state,
    classification: "not_comparable",
    movement_cause: "not_comparable",
    reason,
    prior_assessment_id: prior?.assessment_id ?? null,
    score_delta: null,
    coverage_delta: null,
    semantic_digest_changed: null,
    dimension_deltas: Object.freeze([]),
    criterion_deltas: Object.freeze([]),
  });
}
function itemMap(items, id) { return new Map((Array.isArray(items) ? items : []).filter(isRecord).filter((item) => typeof item[id] === "string").map((item) => [item[id], item])); }
function delta(prior, current, field) { return typeof prior?.[field] === "number" && typeof current?.[field] === "number" ? round(current[field] - prior[field]) : null; }
function itemCause(scoreDelta, coverageDelta) {
  const scoreChanged = scoreDelta !== null && Math.abs(scoreDelta) > 2;
  const coverageChanged = coverageDelta !== null && Math.abs(coverageDelta) >= 0.1;
  if (scoreChanged && coverageChanged) return "mixed";
  if (coverageChanged) return "evidence_expansion";
  return scoreChanged ? "engineering_change" : "stable";
}
function observationVocabularyDigest(assessment) {
  return assessment?.observation_vocabulary_digest ?? assessment?.observation_vocabulary?.digest ?? null;
}
function compareItems(priorItems, currentItems, id) {
  const prior = itemMap(priorItems, id);
  const current = itemMap(currentItems, id);
  return [...new Set([...prior.keys(), ...current.keys()])].sort(compare).map((key) => {
    const before = prior.get(key) ?? null;
    const after = current.get(key) ?? null;
    const score_delta = delta(before, after, "score");
    const coverage_delta = delta(before, after, "coverage");
    return Object.freeze({ [id]: key, prior_present: before !== null, current_present: after !== null, score_delta, coverage_delta, cause: before === null || after === null ? "evidence_expansion" : itemCause(score_delta, coverage_delta) });
  });
}

function compareAssessmentTrajectory({ prior, current }) {
  if (!current || !isRecord(current)) throw new Error("FAIL-ASSESSMENT-TRAJECTORY: current assessment is required");
  if (prior === undefined || prior === null) return notComparable(null, "no prior assessment was supplied", "first-observation");
  if (!isRecord(prior)) return notComparable(null, "prior assessment is not a valid assessment envelope");
  if (prior.schema_version === "sei.engineering-assessment@1" || current.schema_version === "sei.engineering-assessment@1") return notComparable(prior, "assessment@1 uses a materially different evaluator methodology");
  const same = prior.schema_version === current.schema_version
    && prior.snapshot_binding?.repository_id === current.snapshot_binding?.repository_id
    && prior.snapshot_binding?.configuration_hash === current.snapshot_binding?.configuration_hash
    && prior.rubric?.digest === current.rubric?.digest
    && prior.standard?.digest === current.standard?.digest
    && prior.applicability?.digest === current.applicability?.digest
    && (prior.target_policy?.policy_digest ?? null) === (current.target_policy?.policy_digest ?? null)
    && observationVocabularyDigest(prior) !== null
    && observationVocabularyDigest(prior) === observationVocabularyDigest(current);
  if (!same) return notComparable(prior, "repository, configuration, rubric, standard, applicability, target policy, or observation vocabulary changed");
  const score_delta = delta(prior.overview, current.overview, "score");
  const coverage_delta = delta(prior.overview, current.overview, "coverage");
  const dimension_deltas = compareItems(prior.dimensions, current.dimensions, "dimension_id");
  const criterion_deltas = compareItems(prior.criteria, current.criteria, "criterion_id");
  const scoreChanged = score_delta !== null && Math.abs(score_delta) > 2;
  const coverageChanged = coverage_delta !== null && Math.abs(coverage_delta) >= 0.1;
  const classification = scoreChanged && coverageChanged ? "mixed" : coverageChanged ? "evidence_expansion" : scoreChanged ? "engineering_change" : "stable";
  return Object.freeze({
    state: "comparable",
    classification,
    movement_cause: classification,
    reason: classification === "stable" ? "same methodology with no material score or coverage movement" : "same methodology; movement classified from score and coverage deltas",
    prior_assessment_id: prior.assessment_id ?? null,
    score_delta,
    coverage_delta,
    semantic_digest_changed: prior.semantic_digest !== current.semantic_digest,
    dimension_deltas: Object.freeze(dimension_deltas),
    criterion_deltas: Object.freeze(criterion_deltas),
  });
}

module.exports = Object.freeze({ compareAssessmentTrajectory });
