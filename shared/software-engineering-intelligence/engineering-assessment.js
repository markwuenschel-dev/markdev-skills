"use strict";

const crypto = require("node:crypto");

const rubricFixture = require("./engineering-assessment-rubric.json");
const { validateAgainstSchema } = require("./schema-validator.js");
const assessmentSchema = require("./engineering-assessment.schema.json");
const { buildFrameworkLenses } = require("./framework-lenses.js");
const { resolveAssessmentStandard } = require("./assessment-standards.js");
const {
  ASSESSMENT_TARGET_POLICY_VERSION,
  DEFAULT_SCORE_BANDS,
  deriveTargetPolicyDigest,
  KNOWN_TARGET_OBSERVATION_IDS,
  resolveAssessmentTargetPolicy,
} = require("./assessment-target-policy.js");
const { SEMANTIC_OBSERVATION_VERSION, deriveSemanticEvidenceIndex } = require("./engineering-assessment-evidence.js");
const { getCriterionRecipe, synthesizeCriterion } = require("./engineering-assessment-synthesis.js");
const { compareAssessmentTrajectory } = require("./engineering-assessment-trajectory.js");

const ASSESSMENT_SCHEMA_VERSION = "sei.engineering-assessment@3";
const PREVIOUS_ASSESSMENT_SCHEMA_VERSION = "sei.engineering-assessment@2";
const LEGACY_ASSESSMENT_SCHEMA_VERSION = "sei.engineering-assessment@1";
const CONFIDENCE = Object.freeze(["HIGH", "MODERATE", "LOW", "NOT_ESTABLISHED"]);
const APPLICABILITY = Object.freeze(["applicable", "not_applicable", "not_scored"]);
const MATURITY = Object.freeze(["not_scored", "provisional", "established"]);
const DORA_PERFORMANCE_PREFIX = /^dora\.(?:change_lead_time|deployment_frequency|failed_deployment_recovery_time|change_fail_rate|deployment_rework_rate)/;
const DEFAULT_COVERAGE_GATE = Object.freeze({ required_criteria: 30, denominator: 30, enforce: false });
const boundAssessmentState = new WeakMap();

const CRITERION_PROBES = Object.freeze({
  complexity_concentration: { ids: ["static.cognitive_complexity.p90", "static.cyclomatic_complexity.p90", "static.lexical_max_nesting_depth_p90"], mode: "lower", good: 5, poor: 25, intervention: "module-refactor" },
  duplication_pressure: { ids: ["static.duplication_ratio", "static.duplicate_line_ratio", "duplication.ratio"], mode: "lower", good: 0.02, poor: 0.2, intervention: "local-code-change" },
  change_pressure: { ids: ["git.churn", "git.change_frequency", "change.churn_pressure"], mode: "lower", good: 10, poor: 200, intervention: "module-refactor" },
  failure_explicitness: { ids: ["static.failure_handling_ratio", "static.explicit_error_handling_ratio"], mode: "higher", good: 0.9, poor: 0.4, intervention: "local-code-change" },
  dependency_direction: { ids: ["dependency.direction_violations", "architecture.dependency_direction"], mode: "lower", good: 0, poor: 10, intervention: "architecture-investigation" },
  cycle_participation: { ids: ["dependency.cycle_count", "architecture.cycle_participation"], mode: "lower", good: 0, poor: 5, intervention: "architecture-investigation" },
  responsibility_concentration: { ids: ["dependency.hub_concentration", "architecture.responsibility_concentration"], mode: "lower", good: 0.2, poor: 0.8, intervention: "module-refactor" },
  module_boundary_coherence: { ids: ["architecture.module_boundary_coherence", "dependency.boundary_coherence"], mode: "higher", good: 0.85, poor: 0.45, intervention: "architecture-investigation" },
  test_configuration: { ids: ["verification.test_configured", "verification.test_configuration"], mode: "boolean", intervention: "test-verification-improvement" },
  test_execution: { ids: ["verification.test_execution", "verification.test_execution_success"], mode: "boolean", intervention: "test-verification-improvement" },
  coverage_evidence: { ids: ["verification.coverage_ratio", "verification.line_coverage"], mode: "higher", good: 0.8, poor: 0.4, intervention: "test-verification-improvement" },
  change_verification: { ids: ["verification.change_verification", "git.change_verification_ratio"], mode: "higher", good: 0.9, poor: 0.45, intervention: "test-verification-improvement" },
  ci_prerequisites: { ids: ["delivery.ci_configured", "verification.ci_configured"], mode: "boolean", intervention: "delivery-automation" },
  release_automation_prerequisites: { ids: ["delivery.release_automation", "delivery.release_configured"], mode: "boolean", intervention: "delivery-automation" },
  reproducible_build: { ids: ["delivery.reproducible_build", "verification.build_reproducibility"], mode: "boolean", intervention: "delivery-automation" },
  commit_batch_discipline: { ids: ["git.commit_batch_discipline", "git.commit_size"], mode: "lower", good: 5, poor: 100, intervention: "local-code-change" },
  ownership_distribution: { ids: ["git.ownership_concentration", "git.bus_factor"], mode: "lower", good: 0.25, poor: 0.85, intervention: "missing-evidence-instrumentation" },
  change_scope_coherence: { ids: ["git.co_change_pair_count", "git.change_scope_coherence"], mode: "lower", good: 3, poor: 100, intervention: "module-refactor" },
  failure_handling: { ids: ["reliability.failure_handling", "static.failure_handling_ratio"], mode: "higher", good: 0.9, poor: 0.4, intervention: "local-code-change" },
  operational_readiness: { ids: ["reliability.operational_readiness", "operations.runbook_coverage"], mode: "higher", good: 0.8, poor: 0.35, intervention: "observability-improvement" },
  recovery_evidence: { ids: ["reliability.recovery_evidence", "operations.recovery_exercise"], mode: "boolean", intervention: "missing-evidence-instrumentation" },
  observability: { ids: ["reliability.observability", "operations.observability_coverage"], mode: "higher", good: 0.8, poor: 0.35, intervention: "observability-improvement" },
  secrets_and_configuration: { ids: ["security.secret_findings", "security.secrets_findings"], mode: "lower", good: 0, poor: 5, intervention: "security-hardening" },
  security_verification: { ids: ["security.verification", "security.scan_execution"], mode: "boolean", intervention: "security-hardening" },
  local_feedback: { ids: ["developer_experience.local_feedback", "verification.local_feedback"], mode: "boolean", intervention: "test-verification-improvement" },
  configuration_ergonomics: { ids: ["developer_experience.configuration_ergonomics", "developer_experience.config_ergonomics"], mode: "higher", good: 0.8, poor: 0.35, intervention: "local-code-change" },
  repository_overview: { ids: ["documentation.overview_present", "documentation.repository_overview"], mode: "boolean", intervention: "local-code-change" },
  contracts_and_runbooks: { ids: ["documentation.contracts_and_runbooks", "documentation.runbook_coverage"], mode: "higher", good: 0.8, poor: 0.35, intervention: "local-code-change" },
  change_context: { ids: ["documentation.change_context", "documentation.decision_records"], mode: "higher", good: 0.8, poor: 0.35, intervention: "local-code-change" },
  onboarding_discoverability: { ids: ["documentation.onboarding_discoverability", "documentation.onboarding_present"], mode: "boolean", intervention: "local-code-change" },
});

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stableCompare(left, right) { return String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1; }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`; }
function round(value) { return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null; }
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }
function fail(family, detail) { throw new Error(`${family}: ${detail}`); }

function assertClosed(value, allowed, label, family) {
  if (!isRecord(value)) fail(family, `${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort(stableCompare);
  if (unexpected.length) fail(family, `${label} contains unexpected field ${unexpected[0]}`);
}

function digest(document) { return sha256(document); }
function normalizeRubric(assessmentConfig) {
  const supplied = assessmentConfig?.rubric;
  const rubric = supplied === undefined ? rubricFixture : { ...rubricFixture, ...supplied };
  if (!isRecord(rubric) || !Array.isArray(rubric.dimensions) || !Array.isArray(rubric.criteria)) fail("FAIL-ASSESSMENT-RUBRIC", "rubric must declare dimensions and criteria");
  assertClosed(rubric, ["schema_version", "rubric_id", "version", "maturity_thresholds", "dimensions", "criteria"], "rubric", "FAIL-ASSESSMENT-RUBRIC");
  const dimensions = rubric.dimensions.map((dimension) => ({ ...dimension })).sort((a, b) => stableCompare(a.dimension_id, b.dimension_id));
  const criteria = rubric.criteria.map((criterion) => ({ ...criterion })).sort((a, b) => stableCompare(a.criterion_id, b.criterion_id));
  const dimensionIds = new Set();
  let totalDimensionWeight = 0;
  for (const dimension of dimensions) {
    assertClosed(dimension, ["dimension_id", "weight"], `dimension ${dimension.dimension_id ?? "<unknown>"}`, "FAIL-ASSESSMENT-RUBRIC");
    if (typeof dimension.dimension_id !== "string" || dimension.dimension_id.length === 0 || !Number.isFinite(dimension.weight) || dimension.weight <= 0) fail("FAIL-ASSESSMENT-RUBRIC", "dimensions must have non-empty IDs and positive finite weights");
    if (dimensionIds.has(dimension.dimension_id)) fail("FAIL-ASSESSMENT-RUBRIC", `dimension ${dimension.dimension_id} is duplicated`);
    dimensionIds.add(dimension.dimension_id); totalDimensionWeight += dimension.weight;
  }
  if (totalDimensionWeight !== 100) fail("FAIL-ASSESSMENT-RUBRIC", "dimension weights must total exactly 100");
  const ownerByCriterion = new Map();
  for (const criterion of criteria) {
    assertClosed(criterion, ["criterion_id", "dimension_id", "weight"], `criterion ${criterion.criterion_id ?? "<unknown>"}`, "FAIL-ASSESSMENT-RUBRIC");
    if (typeof criterion.criterion_id !== "string" || criterion.criterion_id.length === 0 || !dimensionIds.has(criterion.dimension_id) || !Number.isFinite(criterion.weight) || criterion.weight <= 0) fail("FAIL-ASSESSMENT-RUBRIC", "criteria must have a valid owner and positive finite weight");
    if (ownerByCriterion.has(criterion.criterion_id)) fail("FAIL-ASSESSMENT-RUBRIC", `criterion ${criterion.criterion_id} has duplicate ownership`);
    if (!Object.hasOwn(CRITERION_PROBES, criterion.criterion_id)) fail("FAIL-ASSESSMENT-RUBRIC", `criterion ${criterion.criterion_id} is not implemented by this evaluator`);
    ownerByCriterion.set(criterion.criterion_id, criterion.dimension_id);
  }
  for (const dimension of dimensions) {
    const total = criteria.filter((criterion) => criterion.dimension_id === dimension.dimension_id).reduce((sum, criterion) => sum + criterion.weight, 0);
    if (total !== dimension.weight) fail("FAIL-ASSESSMENT-RUBRIC", `criterion weights for ${dimension.dimension_id} must equal the dimension weight`);
  }
  const thresholds = rubric.maturity_thresholds ?? rubricFixture.maturity_thresholds;
  assertClosed(thresholds, ["not_scored_below", "provisional_below"], "maturity_thresholds", "FAIL-ASSESSMENT-RUBRIC");
  if (!isRecord(thresholds) || !Number.isFinite(thresholds.not_scored_below) || !Number.isFinite(thresholds.provisional_below)
      || thresholds.not_scored_below < 0 || thresholds.provisional_below > 1 || thresholds.not_scored_below >= thresholds.provisional_below) {
    fail("FAIL-ASSESSMENT-RUBRIC", "maturity thresholds are invalid");
  }
  const canonical = { schema_version: rubric.schema_version ?? rubricFixture.schema_version, rubric_id: rubric.rubric_id ?? rubricFixture.rubric_id, version: rubric.version ?? rubricFixture.version, maturity_thresholds: thresholds, dimensions, criteria };
  return { ...canonical, digest: digest(canonical) };
}

function normalizeStandard(assessmentConfig) {
  const supplied = assessmentConfig?.standard ?? assessmentConfig?.standard_resolution?.standard;
  const resolved = supplied === undefined
    ? resolveAssessmentStandard({ repositoryRoot: assessmentConfig?.repository_root ?? null })
    : null;
  const standard = supplied ?? resolved.standard;
  const version = standard?.version ?? standard?.standard_version;
  if (!isRecord(standard) || typeof standard.standard_id !== "string" || typeof version !== "string") fail("FAIL-ASSESSMENT-STANDARD", "standard must have an ID and version");
  const applicability = standard.applicability ?? { not_applicable_criteria: [] };
  const notApplicable = applicability.not_applicable_criteria ?? [];
  if (!isRecord(applicability) || !Array.isArray(notApplicable) || !notApplicable.every((id) => typeof id === "string" && Object.hasOwn(CRITERION_PROBES, id))) {
    fail("FAIL-ASSESSMENT-STANDARD", "standard applicability must list implemented criterion IDs");
  }
  const source = typeof standard.source === "string" ? standard.source : standard.source?.kind ?? "explicit";
  const canonical = { schema_version: standard.schema_version ?? "sei.engineering-assessment-standard@1", standard_id: standard.standard_id, version, name: standard.name ?? standard.label ?? standard.standard_id, source, applicability: { not_applicable_criteria: [...new Set(notApplicable)].sort(stableCompare) } };
  return { ...canonical, digest: digest(canonical) };
}

function validateInput(input) {
  assertClosed(input, ["snapshot", "repositoryIndex", "assessmentConfig", "priorAssessment"], "input", "FAIL-ASSESSMENT-INPUT");
  if (!isRecord(input.snapshot) || !isRecord(input.snapshot.repository) || typeof input.snapshot.snapshot_id !== "string") fail("FAIL-ASSESSMENT-INPUT", "snapshot must be a canonical snapshot-shaped object");
  if (typeof input.snapshot.repository.repository_id !== "string" || !/^[0-9a-f]{40,64}$/.test(input.snapshot.repository.revision ?? "") || !/^[0-9a-f]{64}$/.test(input.snapshot.repository.configuration_hash ?? "")) fail("FAIL-ASSESSMENT-INPUT", "snapshot repository binding is invalid");
  if (!Array.isArray(input.snapshot.measurements)) fail("FAIL-ASSESSMENT-INPUT", "snapshot.measurements must be an array");
  if (!isRecord(input.repositoryIndex?.binding) || input.repositoryIndex.binding.repository_revision !== input.snapshot.repository.revision || !/^sha256:[0-9a-f]{64}$/.test(input.repositoryIndex.binding.index_digest ?? "")) fail("FAIL-ASSESSMENT-BINDING", "repository index must bind the snapshot revision and declare a SHA-256 digest");
  if (input.assessmentConfig !== undefined && !isRecord(input.assessmentConfig)) fail("FAIL-ASSESSMENT-INPUT", "assessmentConfig must be an object when supplied");
}

function usableMeasurement(measurement) {
  return isRecord(measurement) && typeof measurement.metric_id === "string" && Number.isFinite(measurement.value)
    && isRecord(measurement.measurement) && ["measured", "inferred"].includes(measurement.measurement.status);
}
function metricForProbe(measurements, probe) {
  const preferred = measurements.filter((measurement) => usableMeasurement(measurement) && probe.ids.includes(measurement.metric_id));
  return preferred.sort((a, b) => stableCompare(a.metric_id, b.metric_id))[0] ?? null;
}
function scoreMetric(value, probe) {
  if (probe.mode === "boolean") return value > 0 ? 100 : 0;
  if (probe.mode === "higher") {
    if (value >= probe.good) return 100;
    if (value <= probe.poor) return 0;
    return round((value - probe.poor) / (probe.good - probe.poor) * 100);
  }
  if (value <= probe.good) return 100;
  if (value >= probe.poor) return 0;
  return round((probe.poor - value) / (probe.poor - probe.good) * 100);
}
function quality(measurement) {
  return round(Math.max(0, Math.min(1, Number(measurement.measurement.completeness ?? 0))) * Math.max(0, Math.min(1, Number(measurement.measurement.confidence ?? 0))));
}
function maturity(coverage, thresholds) { return coverage < thresholds.not_scored_below ? "not_scored" : coverage < thresholds.provisional_below ? "provisional" : "established"; }
function confidence(coverage, averageQuality) {
  if (coverage < 0.3) return "NOT_ESTABLISHED";
  if (coverage >= 0.6 && averageQuality >= 0.8) return "HIGH";
  if (coverage >= 0.45 && averageQuality >= 0.5) return "MODERATE";
  return "LOW";
}
function band(score) { return score === null ? "NOT SCORED" : score >= 90 ? "Excellent" : score >= 80 ? "Strong" : score >= 70 ? "Good" : score >= 55 ? "Needs attention" : "Material gaps"; }

function criterionRecipe(criterionId) {
  const base = getCriterionRecipe(criterionId);
  const single = (observation_id, family = base.family, meaning = base.meaning, investigation = base.investigation, direction = "boolean", good = 1, poor = 0) => ({
    ...base,
    slots: [{ role: "primary", observation_id, direction, good, poor, facet_id: observation_id.replaceAll(".", "_"), weight: 1 }],
    family,
    meaning,
    investigation,
  });
  if (criterionId === "test_configuration") return single("engineering.verification.test_configuration", "verification");
  if (criterionId === "ci_prerequisites") return single("engineering.delivery.ci_configuration", "delivery");
  if (criterionId === "coverage_evidence") return { ...base, slots: [
    { role: "primary", observation_id: "engineering.verification.statement_coverage", direction: "higher", good: 0.8, poor: 0.4, facet_id: "statement_coverage", weight: 1 },
  ] };
  const singleDefinitions = {
    release_automation_prerequisites: ["engineering.delivery.release_configuration", "delivery"],
    reproducible_build: ["engineering.delivery.reproducibility_inputs", "delivery"],
    failure_explicitness: ["engineering.maintainability.failure_explicitness", "maintainability"],
    failure_handling: ["engineering.reliability.failure_handling", "reliability"],
    operational_readiness: ["engineering.reliability.operational_readiness", "reliability"],
    recovery_evidence: ["engineering.reliability.recovery_evidence", "reliability"],
    observability: ["engineering.reliability.observability", "reliability"],
    secrets_and_configuration: ["engineering.security.secret_findings", "security"],
    security_verification: ["engineering.security.verification", "security"],
    local_feedback: ["engineering.developer.local_feedback", "developer experience"],
    configuration_ergonomics: ["engineering.developer.configuration_ergonomics", "developer experience"],
    repository_overview: ["engineering.documentation.repository_overview", "documentation"],
    contracts_and_runbooks: ["engineering.documentation.contracts_and_runbooks", "documentation"],
    change_context: ["engineering.documentation.change_context", "documentation"],
    onboarding_discoverability: ["engineering.documentation.onboarding_discoverability", "documentation"],
  };
  if (Object.hasOwn(singleDefinitions, criterionId)) {
    const [observationId, family] = singleDefinitions[criterionId];
    const direction = ["failure_explicitness", "failure_handling", "operational_readiness", "observability", "configuration_ergonomics", "contracts_and_runbooks", "change_context"].includes(criterionId) ? "higher"
      : ["secrets_and_configuration"].includes(criterionId) ? "lower" : "boolean";
    const good = direction === "lower" ? 0 : direction === "higher" ? 0.8 : 1;
    const poor = direction === "lower" ? 5 : direction === "higher" ? 0.35 : 0;
    return single(observationId, family, base.meaning, base.investigation, direction, good, poor);
  }
  if (criterionId === "change_verification") return {
    ...base,
    family: "verification",
    slots: [
      { role: "primary", observation_id: "engineering.verification.change_verification", direction: "higher", good: 0.9, poor: 0.45, facet_id: "change_verification", weight: 0.7 },
      { role: "supporting", observation_id: "engineering.verification.tests_passed", direction: "higher", good: 1, poor: 0, facet_id: "tests_passed", weight: 0.3 },
    ],
  };
  return base;
}

function normalizeCoverageGate(assessmentConfig, criterionTotal) {
  const supplied = assessmentConfig?.coverage_gate;
  if (supplied !== undefined && !isRecord(supplied)) fail("FAIL-ASSESSMENT-COVERAGE-GATE", "coverage_gate must be an object");
  const gate = { ...DEFAULT_COVERAGE_GATE, ...(supplied ?? {}) };
  assertClosed(gate, ["required_criteria", "denominator", "enforce"], "coverage_gate", "FAIL-ASSESSMENT-COVERAGE-GATE");
  if (!Number.isSafeInteger(gate.required_criteria) || gate.required_criteria < 0 || gate.required_criteria > criterionTotal
      || !Number.isSafeInteger(gate.denominator) || gate.denominator !== criterionTotal || typeof gate.enforce !== "boolean") {
    fail("FAIL-ASSESSMENT-COVERAGE-GATE", "coverage_gate must require an integer criterion count against the rubric denominator");
  }
  return gate;
}

// One gate evaluation shared by the fresh assessment path and exact replay
// (cli.js). It reads only the persisted coverage_accounting counts, so a
// replayed assessment is re-gated against the CURRENT profile, not the one it
// was produced under.
function evaluateCoverageGate(assessment, assessmentConfig) {
  const accounting = assessment?.coverage_accounting;
  const counts = ["criterion_total", "established_count", "provisional_count", "not_scored_count", "not_applicable_count", "mapping_failure_count"];
  if (!isRecord(accounting) || counts.some((key) => !Number.isSafeInteger(accounting[key]) || accounting[key] < 0)) {
    fail("FAIL-ASSESSMENT-COVERAGE-GATE", "assessment coverage accounting is unavailable for gate evaluation");
  }
  const gate = normalizeCoverageGate(assessmentConfig, accounting.criterion_total);
  const assessedCount = accounting.established_count + accounting.provisional_count;
  const unassessedCount = accounting.not_scored_count + accounting.not_applicable_count;
  const passed = accounting.mapping_failure_count === 0
    && assessedCount >= gate.required_criteria
    && unassessedCount <= accounting.criterion_total - gate.required_criteria;
  return Object.freeze({ gate: Object.freeze({ ...gate }), passed, assessed_count: assessedCount, criterion_total: accounting.criterion_total });
}

function enforceCoverageGate(evaluation) {
  if (evaluation.gate.enforce && !evaluation.passed) {
    fail("FAIL-ASSESSMENT-COVERAGE-GATE", `assessed ${evaluation.assessed_count}/${evaluation.criterion_total} criteria; required ${evaluation.gate.required_criteria}`);
  }
  return evaluation;
}

function notScoredCategory(criterion, recipe) {
  if (criterion.applicability === "not_applicable") return "not_applicable";
  if (!recipe || !Array.isArray(recipe.slots)) return "mapping_failure";
  if (recipe.slots.length === 0) {
    return new Set(["ownership_distribution", "commit_batch_discipline", "change_scope_coherence", "local_feedback"])
      .has(criterion.criterion_id) ? "external_evidence_required" : "unsupported_capability";
  }
  return "genuinely_unavailable_evidence";
}

function missingCriterionDetails(criterionId) {
  return {
    observed: "SEI did not observe usable evidence for this criterion.",
    means: "This criterion is based on the observed state of a repository capability, not an invented numeric proxy.",
    why_it_matters: "This engineering capability affects the safety and cost of future changes.",
    limitations: "Required primary evidence was not observed. Supporting evidence cannot establish this criterion.",
    blocked_stronger_result: "A stronger result is blocked until required primary evidence is collected.",
    next_investigation: "Collect the configured capability evidence or document why the capability is not applicable.",
    reason: "insufficient criterion evidence: no canonical semantic observation was available",
  };
}

function targetAdjustedRecipe(recipe, target) {
  if (!target || !Array.isArray(target.observations) || !Array.isArray(recipe?.slots)) return recipe;
  const byId = new Map(target.observations.map((observation) => [observation.observation_id, observation]));
  return {
    ...recipe,
    slots: recipe.slots.map((slot) => {
      const targetObservation = byId.get(slot.observation_id);
      if (!targetObservation) return slot;
      const direction = targetObservation.direction === "at_or_below" ? "lower" : "higher";
      return {
        ...slot,
        direction: slot.direction === "boolean" ? "boolean" : direction,
        good: targetObservation.acceptable_value,
        poor: targetObservation.concern_value,
      };
    }),
  };
}

function criterionRecords(semanticIndex, rubric, standard, targetPolicy) {
  const skipped = new Set(standard.applicability.not_applicable_criteria);
  const byId = new Map(semanticIndex.observations.map((observation) => [observation.observation_id, observation]));
  return rubric.criteria.map((criterion) => {
    const recipe = criterionRecipe(criterion.criterion_id);
    const target = targetPolicy.criteria.find((candidate) => candidate.criterion_id === criterion.criterion_id) ?? {
      criterion_id: criterion.criterion_id,
      acceptable_score: DEFAULT_SCORE_BANDS.acceptable,
      target_source: "sei-default",
      observations: [],
    };
    const explanationEmpty = {
      observed: "SEI did not observe usable evidence for this criterion.",
      means: recipe.meaning || "The criterion is interpreted through a deterministic engineering recipe.",
      why_it_matters: "This evidence helps bound the safety and cost of future engineering changes.",
      limitations: "No applicable semantic observation was bound to this criterion.",
      blocked_stronger_result: "A stronger result is blocked until the required primary evidence is collected.",
      next_investigation: recipe.investigation || "Collect the required primary evidence and rerun SEI.",
    };
    if (skipped.has(criterion.criterion_id)) return {
      criterion_id: criterion.criterion_id, dimension_id: criterion.dimension_id, weight: criterion.weight,
      applicability: "not_applicable", score: null, coverage: 0, confidence: "NOT_ESTABLISHED", maturity: "not_scored",
      evidence_refs: [], evidence: { observations: [], synthesis: { recipe_id: recipe.recipe_id, reducer_version: recipe.reducer_version, contributing_observation_ids: [] } },
      target,
      explanation: { ...explanationEmpty, limitations: "This criterion is not applicable under the selected standard." },
      synthesis: { recipe_id: recipe.recipe_id, reducer_version: recipe.reducer_version, contributing_observation_ids: [] },
      reason: "not applicable under the selected standard", intervention_family: CRITERION_PROBES[criterion.criterion_id]?.intervention ?? "missing-evidence-instrumentation",
    };
    const wanted = new Set((recipe.slots ?? []).map((slot) => slot.observation_id));
    const observations = semanticIndex.observations.filter((observation) => wanted.has(observation.observation_id));
    const synthesis = synthesizeCriterion({ criterion_id: criterion.criterion_id, observations, recipe: targetAdjustedRecipe(recipe, target) });
    const applicability = synthesis.applicability === "applicable" ? "applicable" : "not_scored";
    const maturityValue = applicability === "not_scored" ? "not_scored" : synthesis.maturity;
    const score = maturityValue === "not_scored" ? null : synthesis.score;
    const missingDetails = missingCriterionDetails(criterion.criterion_id);
    const missingExplanation = Object.fromEntries(Object.entries(missingDetails).filter(([key]) => key !== "reason"));
    const reason = score === null
      ? observations.length === 0
        ? missingDetails.reason
        : "insufficient criterion evidence: required primary or bounded corroborating evidence was unavailable"
      : "semantic evidence synthesized from bound observations";
    return {
      criterion_id: criterion.criterion_id, dimension_id: criterion.dimension_id, weight: criterion.weight,
      applicability, score, coverage: synthesis.coverage, confidence: synthesis.confidence, maturity: maturityValue,
      evidence_refs: synthesis.evidence_refs, evidence: { observations: synthesis.evidence, synthesis: synthesis.synthesis },
      target,
      synthesis: synthesis.synthesis, explanation: score === null ? { ...explanationEmpty, ...missingExplanation } : synthesis.explanation,
      reason,
      intervention_family: CRITERION_PROBES[criterion.criterion_id]?.intervention ?? recipe.family ?? "missing-evidence-instrumentation",
    };
  }).sort((a, b) => stableCompare(a.dimension_id, b.dimension_id) || stableCompare(a.criterion_id, b.criterion_id));
}

function aggregate(criteria, weight, thresholds) {
  const considered = criteria.filter((criterion) => criterion.applicability !== "not_applicable");
  const denominator = considered.reduce((sum, criterion) => sum + criterion.weight, 0);
  const observed = considered.filter((criterion) => criterion.score !== null);
  const observedWeight = observed.reduce((sum, criterion) => sum + criterion.weight, 0);
  const coverage = denominator === 0 ? 0 : round(observed.reduce((sum, criterion) => sum + criterion.weight * criterion.coverage, 0) / denominator);
  const averageQuality = observedWeight === 0 ? 0 : observed.reduce((sum, criterion) => sum + criterion.weight * criterion.coverage, 0) / observedWeight;
  const score = observedWeight === 0 ? null : round(observed.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / observedWeight);
  return { score, coverage, confidence: confidence(coverage, averageQuality), maturity: maturity(coverage, thresholds), considered_weight: denominator, observed_weight: observedWeight, weight };
}

function dimensionRecords(criteria, rubric) {
  return rubric.dimensions.map((dimension) => {
    const members = criteria.filter((criterion) => criterion.dimension_id === dimension.dimension_id);
    const aggregateRecord = aggregate(members, dimension.weight, rubric.maturity_thresholds);
    return { dimension_id: dimension.dimension_id, weight: dimension.weight, score: aggregateRecord.maturity === "not_scored" ? null : aggregateRecord.score, coverage: aggregateRecord.coverage, confidence: aggregateRecord.confidence, maturity: aggregateRecord.maturity, criterion_count: members.length, observed_criterion_count: members.filter((criterion) => criterion.score !== null).length };
  }).sort((a, b) => stableCompare(a.dimension_id, b.dimension_id));
}

function lensRecords(criteria, measurements, profiles) {
  const frameworkEvidence = {};
  const doraRefs = measurements.filter((measurement) => usableMeasurement(measurement) && DORA_PERFORMANCE_PREFIX.test(measurement.metric_id)).map((measurement) => measurement.metric_id).sort(stableCompare);
  if (doraRefs.length) frameworkEvidence.DORA = { status: "observed", evidence_refs: doraRefs };
  for (const profile of profiles ?? []) {
    if (profile?.profile_id && ["Agile", "Scrum", "Kanban", "SPACE", "EngThrive"].includes(profile.profile_id)
        && profile.applicability?.status === "applicable") {
      frameworkEvidence[profile.profile_id] = { status: "observed", evidence_refs: profile.applicability.evidence_refs ?? [] };
    }
  }
  return buildFrameworkLenses({ criteria, frameworkEvidence });
}

function interventionTargets(criterion, snapshot) {
  const sourceMetricIds = new Set((criterion.evidence?.observations ?? [])
    .flatMap((observation) => Array.isArray(observation.source_metric_ids) ? observation.source_metric_ids : []));
  const paths = (snapshot?.measurements ?? [])
    .filter((metric) => sourceMetricIds.has(metric?.metric_id) && typeof metric?.scope?.path === "string"
      && metric.scope.path.length > 0 && metric.scope.path !== ".")
    .map((metric) => metric.scope.path)
    .filter((path, index, all) => all.indexOf(path) === index)
    .sort(stableCompare)
    .slice(0, 8);
  if (paths.length > 0) return paths;
  const languages = [...new Set((criterion.evidence?.observations ?? [])
    .flatMap((observation) => Array.isArray(observation.context?.languages) ? observation.context.languages : []))]
    .filter((language) => typeof language === "string" && language.length > 0)
    .sort(stableCompare)
    .slice(0, 4);
  if (languages.length > 0) return languages.map((language) => `${language} source boundary`);
  const family = criterion.evidence?.observations?.[0]?.context?.family;
  return [typeof family === "string" && family.length > 0 ? `repository-level ${family} evidence` : "repository-level evidence"].slice(0, 1);
}

function findings(criteria, snapshot) {
  const scored = criteria.filter((criterion) => criterion.score !== null);
  const strengths = scored.filter((criterion) => criterion.score >= 80).map((criterion) => ({ criterion_id: criterion.criterion_id, dimension_id: criterion.dimension_id, score: criterion.score, evidence_refs: criterion.evidence_refs })).sort((a, b) => b.score - a.score || stableCompare(a.criterion_id, b.criterion_id));
  const deficiencies = scored.filter((criterion) => criterion.score < 70).map((criterion) => ({ criterion_id: criterion.criterion_id, dimension_id: criterion.dimension_id, score: criterion.score, severity: round((100 - criterion.score) * criterion.weight), evidence_refs: criterion.evidence_refs })).sort((a, b) => b.severity - a.severity || stableCompare(a.criterion_id, b.criterion_id));
  const interventions = deficiencies.map((deficiency) => {
    const criterion = criteria.find((item) => item.criterion_id === deficiency.criterion_id);
    return { intervention_id: `sei-intervention:${deficiency.criterion_id}`, criterion_id: deficiency.criterion_id, dimension_id: deficiency.dimension_id, family: criterion.intervention_family, priority: deficiency.severity, evidence_refs: deficiency.evidence_refs, targets: interventionTargets(criterion, snapshot), why: criterion.explanation?.why_it_matters ?? "This criterion is a bounded engineering pressure.", next_investigation: criterion.explanation?.next_investigation ?? "Collect the missing primary evidence.", boundary: "SEI recommendation only; no RIA candidate or lifecycle identity is created" };
  });
  return { strengths, deficiencies, interventions };
}

function trajectory(priorAssessment, current) {
  return compareAssessmentTrajectory({ prior: priorAssessment, current });
}

function assessRepositoryEngineering(input) {
  validateInput(input);
  const rubric = normalizeRubric(input.assessmentConfig);
  const standard = normalizeStandard(input.assessmentConfig);
  const snapshotBinding = { snapshot_id: input.snapshot.snapshot_id, repository_id: input.snapshot.repository.repository_id, repository_revision: input.snapshot.repository.revision, configuration_hash: input.snapshot.repository.configuration_hash };
  const indexBinding = { repository_revision: input.repositoryIndex.binding.repository_revision, index_digest: input.repositoryIndex.binding.index_digest };
  const applicability = { not_applicable_criteria: standard.applicability.not_applicable_criteria, digest: digest(standard.applicability) };
  const semanticIndex = deriveSemanticEvidenceIndex(input.snapshot);
  const mappingFailureCount = Number(semanticIndex.mapping_debt?.mapping_failure_count
    ?? semanticIndex.mapping_debt?.count ?? 0);
  if (!Number.isSafeInteger(mappingFailureCount) || mappingFailureCount !== 0) {
    const unmapped = Array.isArray(semanticIndex.mapping_debt?.metric_ids)
      ? semanticIndex.mapping_debt.metric_ids.slice(0, 8).join(", ")
      : "unknown";
    fail("FAIL-MAPPING-DEBT", `semantic evidence mapping debt is ${String(mappingFailureCount)} (${unmapped})`);
  }
  const targetRecipes = Object.fromEntries(rubric.criteria.map((criterion) => [criterion.criterion_id, criterionRecipe(criterion.criterion_id)]));
  const targetPolicy = resolveAssessmentTargetPolicy({
    assessmentConfig: input.assessmentConfig,
    repositoryRoot: input.assessmentConfig?.repository_root ?? null,
    rubric,
    recipes: targetRecipes,
    observations: semanticIndex.observations,
  });
  const criteria = criterionRecords(semanticIndex, rubric, standard, targetPolicy);
  const coverageGate = normalizeCoverageGate(input.assessmentConfig, criteria.length);
  const dimensions = dimensionRecords(criteria, rubric);
  const all = aggregate(criteria, 100, rubric.maturity_thresholds);
  const overviewMaturity = maturity(all.coverage, rubric.maturity_thresholds);
  const overview = {
    score: overviewMaturity === "not_scored" ? null : all.score,
    score_band: overviewMaturity === "not_scored" ? "NOT SCORED" : band(all.score),
    score_visibility: overviewMaturity === "not_scored" ? "hidden" : overviewMaturity === "provisional" ? "provisional" : "established",
    score_targets: { ...targetPolicy.score_bands },
    coverage: all.coverage,
    confidence: all.confidence,
    maturity: overviewMaturity,
    dimension_count: dimensions.length,
  };
  const coverageBucket = (criterion) => {
    if (criterion.applicability === "not_applicable") return "not_applicable";
    if (criterion.maturity === "established") return "established";
    if (criterion.maturity === "provisional") return "provisional";
    return "not_scored";
  };
  const coverageAccounting = {
    criterion_total: criteria.length,
    established_count: criteria.filter((criterion) => coverageBucket(criterion) === "established").length,
    provisional_count: criteria.filter((criterion) => coverageBucket(criterion) === "provisional").length,
    not_scored_count: criteria.filter((criterion) => coverageBucket(criterion) === "not_scored").length,
    not_applicable_count: criteria.filter((criterion) => coverageBucket(criterion) === "not_applicable").length,
    mapping_failure_count: mappingFailureCount,
    assessed_criterion_rate: round((criteria.filter((criterion) => criterion.maturity === "established" || criterion.maturity === "provisional").length) / Math.max(1, criteria.length)),
    coverage_gate: null,
    not_scored_reasons: [...new Map(criteria.filter((criterion) => coverageBucket(criterion) === "not_scored").map((criterion) => {
      const category = notScoredCategory(criterion, criterionRecipe(criterion.criterion_id));
      const key = `${category}\0${criterion.reason}`;
      return [key, { reason: criterion.reason, category, criterion_count: 0 }];
    }))].sort((left, right) => stableCompare(left[0], right[0])).map(([, entry]) => ({
      ...entry,
      criterion_count: criteria.filter((criterion) => coverageBucket(criterion) === "not_scored"
        && criterion.reason === entry.reason
        && notScoredCategory(criterion, criterionRecipe(criterion.criterion_id)) === entry.category).length,
    })),
  };
  const gateEvaluation = evaluateCoverageGate({ coverage_accounting: coverageAccounting }, input.assessmentConfig);
  const gatePassed = gateEvaluation.passed;
  coverageAccounting.coverage_gate = {
    required_criteria: coverageGate.required_criteria,
    denominator: coverageGate.denominator,
    target_rate: round(coverageGate.required_criteria / coverageGate.denominator),
    assessed_criterion_rate: coverageAccounting.assessed_criterion_rate,
    status: gatePassed ? "passed" : "not_met",
    reason: gatePassed ? "criterion coverage target was met with zero semantic mapping debt" : "criterion coverage target was not met by bound evidence",
  };
  enforceCoverageGate(gateEvaluation);
  const provisional = {
    schema_version: ASSESSMENT_SCHEMA_VERSION,
    snapshot_binding: snapshotBinding,
    repository_index_binding: indexBinding,
    evaluator: { evaluator_id: "sei.engineering-assessment", version: "3.0.0", deterministic: true },
    rubric: { rubric_id: rubric.rubric_id, version: rubric.version, digest: rubric.digest, maturity_thresholds: rubric.maturity_thresholds },
    standard: { standard_id: standard.standard_id, version: standard.version, source: standard.source, digest: standard.digest },
    target_policy: targetPolicy,
    applicability,
    observation_vocabulary_version: semanticIndex.semantic_observation_version,
    observation_vocabulary_digest: semanticIndex.semantic_digest,
    semantic_digest: digest({ semantic_observation_version: semanticIndex.semantic_observation_version, semantic_digest: semanticIndex.semantic_digest, criteria: criteria.map((criterion) => ({ criterion_id: criterion.criterion_id, score: criterion.score, coverage: criterion.coverage, maturity: criterion.maturity, synthesis: criterion.synthesis, evidence: (criterion.evidence?.observations ?? []).map(semanticObservationShape) })) }),
    coverage_accounting: coverageAccounting,
    overview,
    criteria,
    dimensions,
    framework_lenses: lensRecords(criteria, input.snapshot.measurements, input.snapshot.profiles),
    ...findings(criteria, input.snapshot),
    evidence_limits: criteria.filter((criterion) => criterion.applicability === "not_scored").map((criterion) => ({ criterion_id: criterion.criterion_id, reason: criterion.reason })).sort((a, b) => stableCompare(a.criterion_id, b.criterion_id)),
  };
  const current = { ...provisional, assessment_id: "pending" };
  const complete = { ...provisional, trajectory: trajectory(input.priorAssessment, current) };
  const assessment_id = deriveAssessmentId(complete);
  const result = { ...complete, assessment_id };
  const schemaErrors = validateAgainstSchema(result, assessmentSchema);
  if (schemaErrors.length) fail("FAIL-ASSESSMENT-SCHEMA", schemaErrors.join("; "));
  return freeze(result);
}

function deriveAssessmentId(assessment) {
  if (!isRecord(assessment)) fail("FAIL-ASSESSMENT-IDENTITY", "assessment must be an object");
  const { assessment_id, ...identity } = assessment;
  return sha256(identity);
}

function semanticDigestForAssessment(assessment) {
  const criteria = (Array.isArray(assessment.criteria) ? assessment.criteria : [])
    .map((criterion) => ({
      criterion_id: criterion.criterion_id,
      score: criterion.score,
      coverage: criterion.coverage,
      maturity: criterion.maturity,
      synthesis: criterion.synthesis,
      evidence: (criterion.evidence?.observations ?? []).map(semanticObservationShape),
    }));
  return digest({
    semantic_observation_version: assessment.observation_vocabulary_version,
    semantic_digest: assessment.observation_vocabulary_digest,
    criteria,
  });
}

function semanticObservationShape(observation) {
  if (!isRecord(observation)) return null;
  const { source_metric_ids, evidence_refs, context, ...semantic } = observation;
  // Binding/provenance is verified separately against the canonical snapshot;
  // it must not make equivalent semantic evidence hash differently across
  // independent output roots.
  return {
    ...semantic,
    ...(isRecord(context)
      ? { context: Object.fromEntries(Object.entries(context).filter(([key]) => key !== "binding")) }
      : {}),
  };
}

function semanticObservationValueShape(observation) {
  if (!isRecord(observation)) return null;
  const { source_metric_ids, evidence_refs, role, ...semantic } = observation;
  return semantic;
}

function validateBoundObservationProvenance(assessment, snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.measurements)) return ["FAIL-ASSESSMENT-BINDING: canonical snapshot measurements are required"];
  const metrics = new Map(snapshot.measurements.filter((metric) => isRecord(metric) && typeof metric.metric_id === "string")
    .map((metric) => [metric.metric_id, metric]));
  const refsByMetric = new Map([...metrics].map(([metricId, metric]) => [metricId, new Set([
    ...(Array.isArray(metric.source?.artifact_refs) ? metric.source.artifact_refs : []),
    ...(Array.isArray(metric.source?.evidence_refs) ? metric.source.evidence_refs : []),
  ].filter((ref) => typeof ref === "string"))]));
  let semanticIndex;
  try {
    semanticIndex = deriveSemanticEvidenceIndex(snapshot);
  } catch (error) {
    return [`FAIL-ASSESSMENT-BINDING: canonical semantic evidence index failed: ${error.message}`];
  }
  const canonicalById = new Map(semanticIndex.observations.map((observation) => [observation.observation_id, observation]));
  const errors = [];
  for (const criterion of Array.isArray(assessment.criteria) ? assessment.criteria : []) {
    for (const observation of Array.isArray(criterion?.evidence?.observations) ? criterion.evidence.observations : []) {
      const sourceMetricIds = Array.isArray(observation.source_metric_ids) ? observation.source_metric_ids : [];
      const evidenceRefs = Array.isArray(observation.evidence_refs) ? observation.evidence_refs : [];
      const canonical = canonicalById.get(observation.observation_id);
      if (!canonical) {
        errors.push(`FAIL-ASSESSMENT-BINDING: observation ${observation.observation_id} is not in the canonical semantic vocabulary`);
      } else {
        const suppliedSemantic = semanticObservationValueShape(observation);
        if (stableStringify(suppliedSemantic) !== stableStringify(semanticObservationValueShape(canonical))) {
          errors.push(`FAIL-ASSESSMENT-BINDING: observation ${observation.observation_id} does not match canonical semantic evidence`);
        }
        const contributing = new Set(criterion.evidence?.synthesis?.contributing_observation_ids ?? criterion.synthesis?.contributing_observation_ids ?? []);
        if (!contributing.has(observation.observation_id)) {
          errors.push(`FAIL-ASSESSMENT-BINDING: observation ${observation.observation_id} is not declared by criterion synthesis`);
        }
      }
      if (sourceMetricIds.length === 0 || evidenceRefs.length === 0) {
        errors.push(`FAIL-ASSESSMENT-BINDING: observation ${observation.observation_id} has no bound provenance`);
        continue;
      }
      for (const metricId of sourceMetricIds) {
        if (!metrics.has(metricId)) errors.push(`FAIL-ASSESSMENT-BINDING: observation ${observation.observation_id} references unknown metric ${metricId}`);
      }
      const knownRefs = new Set(sourceMetricIds.flatMap((metricId) => [...(refsByMetric.get(metricId) ?? [])]));
      for (const ref of evidenceRefs) {
        if (!knownRefs.has(ref)) errors.push(`FAIL-ASSESSMENT-BINDING: observation ${observation.observation_id} references unbound evidence ${ref}`);
      }
    }
  }
  return errors;
}

function validateAssessment(assessment, snapshot = null) {
  const errors = [];
  if (!isRecord(assessment)) return { ok: false, errors: ["FAIL-ASSESSMENT-SCHEMA: assessment must be an object"] };
  if (assessment.schema_version === LEGACY_ASSESSMENT_SCHEMA_VERSION) {
    const required = ["assessment_id", "snapshot_binding", "repository_index_binding", "overview", "criteria"];
    if (required.some((field) => !Object.hasOwn(assessment, field))) errors.push("FAIL-ASSESSMENT-SCHEMA: legacy assessment envelope is incomplete");
  } else {
    const schemaErrors = validateAgainstSchema(assessment, assessmentSchema);
    if (schemaErrors.length) errors.push(...schemaErrors.map((error) => `FAIL-ASSESSMENT-SCHEMA: ${error}`));
  }
  if ([ASSESSMENT_SCHEMA_VERSION, PREVIOUS_ASSESSMENT_SCHEMA_VERSION].includes(assessment.schema_version) && assessment.coverage_accounting?.mapping_failure_count !== 0) {
    errors.push("FAIL-MAPPING-DEBT: mapping_failure_count must be zero");
  }
  if ([ASSESSMENT_SCHEMA_VERSION, PREVIOUS_ASSESSMENT_SCHEMA_VERSION].includes(assessment.schema_version)) {
    const accounting = assessment.coverage_accounting;
    if (isRecord(accounting)) {
      const accounted = Number(accounting.established_count ?? 0) + Number(accounting.provisional_count ?? 0)
        + Number(accounting.not_scored_count ?? 0) + Number(accounting.not_applicable_count ?? 0);
      const reasonTotal = Array.isArray(accounting.not_scored_reasons)
        ? accounting.not_scored_reasons.reduce((sum, reason) => sum + Number(reason?.criterion_count ?? 0), 0) : -1;
      if (accounted !== accounting.criterion_total || reasonTotal !== accounting.not_scored_count) {
        errors.push("FAIL-ASSESSMENT-SCORE-SEMANTICS: coverage accounting does not reconcile to the criterion total"
          + ` (established=${Number(accounting.established_count ?? 0)}`
          + ` provisional=${Number(accounting.provisional_count ?? 0)}`
          + ` not_scored=${Number(accounting.not_scored_count ?? 0)}`
          + ` not_applicable=${Number(accounting.not_applicable_count ?? 0)}`
          + ` accounted=${accounted}`
          + ` criterion_total=${accounting.criterion_total}`
          + ` not_scored_reasons=${reasonTotal})`);
      }
      const assessed = Number(accounting.established_count ?? 0) + Number(accounting.provisional_count ?? 0);
      const expectedRate = accounting.criterion_total > 0 ? round(assessed / accounting.criterion_total) : 0;
      if (accounting.assessed_criterion_rate !== expectedRate || accounting.coverage_gate?.assessed_criterion_rate !== expectedRate) {
        errors.push("FAIL-ASSESSMENT-SCORE-SEMANTICS: assessed criterion rate does not reconcile to criterion counts");
      }
      if (accounting.coverage_gate?.denominator !== accounting.criterion_total
          || accounting.coverage_gate?.status !== (accounting.mapping_failure_count === 0
            && assessed >= accounting.coverage_gate?.required_criteria
            && Number(accounting.not_scored_count ?? 0) + Number(accounting.not_applicable_count ?? 0) <= accounting.criterion_total - accounting.coverage_gate?.required_criteria ? "passed" : "not_met")) {
        errors.push("FAIL-ASSESSMENT-COVERAGE-GATE: coverage gate does not reconcile to criterion accounting");
      }
    }
    if (assessment.observation_vocabulary_version !== SEMANTIC_OBSERVATION_VERSION) {
      errors.push("FAIL-ASSESSMENT-EVIDENCE-MAP: unsupported observation vocabulary");
    }
    if (assessment.semantic_digest !== semanticDigestForAssessment(assessment)) {
      errors.push("FAIL-ASSESSMENT-BINDING: semantic_digest does not match criterion evidence");
    }
    if (snapshot !== null) errors.push(...validateBoundObservationProvenance(assessment, snapshot));
  }
  if (assessment.overview?.maturity === "not_scored" && assessment.overview?.score !== null) {
    errors.push("FAIL-ASSESSMENT-SCORE-SEMANTICS: not_scored assessments must have a null score");
  }
  if ([ASSESSMENT_SCHEMA_VERSION, PREVIOUS_ASSESSMENT_SCHEMA_VERSION].includes(assessment.schema_version)) {
    const expectedVisibility = { not_scored: "hidden", provisional: "provisional", established: "established" }[assessment.overview?.maturity];
    if (expectedVisibility !== undefined && assessment.overview?.score_visibility !== expectedVisibility) {
      errors.push("FAIL-ASSESSMENT-SCORE-SEMANTICS: overview score visibility must match maturity");
    }
    if (Array.isArray(assessment.dimensions) && assessment.dimensions.some((dimension) => dimension?.maturity === "not_scored" && dimension.score !== null)) {
      errors.push("FAIL-ASSESSMENT-SCORE-SEMANTICS: not_scored dimensions must have null scores");
    }
  }
  if (Array.isArray(assessment.criteria) && assessment.criteria.some((criterion) => criterion?.maturity === "not_scored" && criterion.score !== null)) {
    errors.push("FAIL-ASSESSMENT-SCORE-SEMANTICS: not_scored criteria must have null scores");
  }
  if (assessment.schema_version === ASSESSMENT_SCHEMA_VERSION) {
    const policy = assessment.target_policy;
    if (!isRecord(policy) || policy.schema_version !== ASSESSMENT_TARGET_POLICY_VERSION) {
      errors.push("FAIL-ASSESSMENT-TARGET-POLICY: @3 assessments must carry a target policy");
    } else {
      if (policy.policy_digest !== deriveTargetPolicyDigest(policy)) errors.push("FAIL-ASSESSMENT-TARGET-POLICY: target policy digest is stale");
      if (stableStringify(policy.score_bands) !== stableStringify(DEFAULT_SCORE_BANDS)) errors.push("FAIL-ASSESSMENT-TARGET-POLICY: score bands are not the global SEI bands");
      if (assessment.overview?.score_targets && stableStringify(assessment.overview.score_targets) !== stableStringify(policy.score_bands)) {
        errors.push("FAIL-ASSESSMENT-TARGET-POLICY: overview score targets do not match the target policy");
      }
      const criterionIds = new Set((assessment.criteria ?? []).map((criterion) => criterion?.criterion_id));
      const policyCriterionIds = new Set();
      for (const target of Array.isArray(policy.criteria) ? policy.criteria : []) {
        if (!isRecord(target) || typeof target.criterion_id !== "string" || policyCriterionIds.has(target.criterion_id) || !criterionIds.has(target.criterion_id)) {
          errors.push("FAIL-ASSESSMENT-TARGET-POLICY: target policy criterion binding is invalid");
          continue;
        }
        policyCriterionIds.add(target.criterion_id);
        for (const observation of Array.isArray(target.observations) ? target.observations : []) {
          if (!KNOWN_TARGET_OBSERVATION_IDS.has(observation?.observation_id)) errors.push(`FAIL-ASSESSMENT-TARGET-POLICY: unknown target observation ${String(observation?.observation_id)}`);
          if (observation?.direction === "at_or_below" && observation.acceptable_value > observation.concern_value) errors.push("FAIL-ASSESSMENT-TARGET-POLICY: inverted lower-is-better target range");
          if (observation?.direction === "at_or_above" && observation.acceptable_value < observation.concern_value) errors.push("FAIL-ASSESSMENT-TARGET-POLICY: inverted higher-is-better target range");
        }
      }
      if (policyCriterionIds.size !== criterionIds.size) errors.push("FAIL-ASSESSMENT-TARGET-POLICY: every criterion must have a target projection");
      for (const criterion of assessment.criteria ?? []) {
        if (!isRecord(criterion?.target)) errors.push(`FAIL-ASSESSMENT-TARGET-POLICY: criterion ${String(criterion?.criterion_id)} is missing target projection`);
      }
    }
  }
  if (typeof assessment.assessment_id !== "string" || assessment.assessment_id !== deriveAssessmentId(assessment)) {
    errors.push("FAIL-ASSESSMENT-IDENTITY: assessment_id does not match canonical content");
  }
  return { ok: errors.length === 0, errors };
}

function bindAssessment(assessment, snapshot = null) {
  const validation = validateAssessment(assessment, snapshot);
  if (!validation.ok) fail("FAIL-ASSESSMENT-BINDING", validation.errors.join("; "));
  if (snapshot !== null && (!isRecord(snapshot) || assessment.snapshot_binding.snapshot_id !== snapshot.snapshot_id
      || assessment.snapshot_binding.repository_id !== snapshot.repository?.repository_id
      || assessment.snapshot_binding.repository_revision !== snapshot.repository?.revision
      || assessment.snapshot_binding.configuration_hash !== snapshot.repository?.configuration_hash)) {
    fail("FAIL-ASSESSMENT-BINDING", "assessment does not bind the supplied canonical snapshot");
  }
  const binding = Object.freeze({});
  boundAssessmentState.set(binding, freeze(structuredClone(assessment)));
  return binding;
}

function readBoundAssessment(binding) {
  const state = boundAssessmentState.get(binding);
  if (!state) fail("FAIL-ASSESSMENT-BINDING", "assessment binding is not package-branded");
  return state;
}

module.exports = { ASSESSMENT_SCHEMA_VERSION, assessRepositoryEngineering, validateAssessment };
Object.defineProperty(module.exports, Symbol.for("sei.engineering-assessment.private.v1"), {
  value: Object.freeze({ bindAssessment, enforceCoverageGate, evaluateCoverageGate, readBoundAssessment, validateAssessment }),
});
