"use strict";

// Closed, semantic target policy for the engineering assessment.  Targets are
// keyed by criterion and semantic observation ID; raw producer metric IDs are
// deliberately not accepted here.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { RECIPES } = require("./engineering-assessment-synthesis.js");

const ASSESSMENT_TARGET_POLICY_VERSION = "sei.assessment-target-policy@1";
const DEFAULT_SCORE_BANDS = Object.freeze({ acceptable: 70, strong: 80, excellent: 90 });
const DIRECTIONS = Object.freeze({ lower: "at_or_below", higher: "at_or_above", boolean: "at_or_above" });
const TARGET_SOURCE = Object.freeze({ DEFAULT: "sei-default", OVERRIDE: "repository-override", EXPLICIT: "explicit_config" });

// A target policy must remain usable when the current repository has no value
// for an observation.  These units are the semantic units published by the
// evidence index; observed units are checked against them when available.
const OBSERVATION_UNITS = Object.freeze({
  "engineering.complexity.production.p90": "complexity-points",
  "engineering.complexity.production.max": "complexity-points",
  "engineering.complexity.production.outlier_ratio": "ratio",
  "engineering.complexity.production.coverage": "ratio",
  "engineering.complexity.parser_exclusions": "ratio",
  "engineering.dependency.cycle_pressure": "cycles",
  "engineering.dependency.scc_concentration": "ratio",
  "engineering.dependency.centrality_concentration": "ratio",
  "engineering.dependency.boundary_pressure": "fan-in",
  "engineering.git.co_change_pressure": "pairs",
  "engineering.dependency.analysis_exclusions": "ratio",
  "engineering.dependency.instability": "ratio",
  "engineering.git.observed_churn": "changed-lines",
  "engineering.git.change_frequency": "revisions",
  "engineering.git.history_coverage": "ratio",
  "engineering.verification.test_execution": "tests",
  "engineering.verification.statement_coverage": "ratio",
  "engineering.verification.test_scope_coverage": "ratio",
  "engineering.verification.execution_exclusions": "ratio",
  "engineering.duplication.observed_ratio": "ratio",
  "engineering.duplication.clone_family_pressure": "families",
  "engineering.duplication.analysis_coverage": "ratio",
  "engineering.duplication.resource_limit": "state",
  "engineering.verification.test_configuration": "paths",
  "engineering.delivery.ci_configuration": "paths",
  "engineering.delivery.release_configuration": "paths",
  "engineering.delivery.reproducibility_inputs": "manifests",
  "engineering.maintainability.failure_explicitness": "ratio",
  "engineering.verification.change_verification": "ratio",
  "engineering.verification.tests_passed": "tests",
  "engineering.reliability.failure_handling": "ratio",
  "engineering.reliability.operational_readiness": "ratio",
  "engineering.reliability.recovery_evidence": "state",
  "engineering.reliability.observability": "ratio",
  "engineering.security.secret_findings": "findings",
  "engineering.security.verification": "state",
  "engineering.developer.local_feedback": "state",
  "engineering.developer.configuration_ergonomics": "ratio",
  "engineering.documentation.repository_overview": "state",
  "engineering.documentation.contracts_and_runbooks": "ratio",
  "engineering.documentation.change_context": "ratio",
  "engineering.documentation.onboarding_discoverability": "state",
});

const DYNAMIC_CRITERION_SLOTS = Object.freeze({
  test_configuration: [{ role: "primary", observation_id: "engineering.verification.test_configuration", direction: "boolean", good: 1, poor: 0, facet_id: "test_configuration", weight: 1 }],
  ci_prerequisites: [{ role: "primary", observation_id: "engineering.delivery.ci_configuration", direction: "boolean", good: 1, poor: 0, facet_id: "ci_configuration", weight: 1 }],
  release_automation_prerequisites: [{ role: "primary", observation_id: "engineering.delivery.release_configuration", direction: "boolean", good: 1, poor: 0, facet_id: "release_configuration", weight: 1 }],
  reproducible_build: [{ role: "primary", observation_id: "engineering.delivery.reproducibility_inputs", direction: "boolean", good: 1, poor: 0, facet_id: "reproducibility_inputs", weight: 1 }],
  failure_explicitness: [{ role: "primary", observation_id: "engineering.maintainability.failure_explicitness", direction: "higher", good: 0.8, poor: 0.35, facet_id: "failure_explicitness", weight: 1 }],
  failure_handling: [{ role: "primary", observation_id: "engineering.reliability.failure_handling", direction: "higher", good: 0.8, poor: 0.35, facet_id: "failure_handling", weight: 1 }],
  operational_readiness: [{ role: "primary", observation_id: "engineering.reliability.operational_readiness", direction: "higher", good: 0.8, poor: 0.35, facet_id: "operational_readiness", weight: 1 }],
  recovery_evidence: [{ role: "primary", observation_id: "engineering.reliability.recovery_evidence", direction: "boolean", good: 1, poor: 0, facet_id: "recovery_evidence", weight: 1 }],
  observability: [{ role: "primary", observation_id: "engineering.reliability.observability", direction: "higher", good: 0.8, poor: 0.35, facet_id: "observability", weight: 1 }],
  secrets_and_configuration: [{ role: "primary", observation_id: "engineering.security.secret_findings", direction: "lower", good: 0, poor: 5, facet_id: "secret_findings", weight: 1 }],
  security_verification: [{ role: "primary", observation_id: "engineering.security.verification", direction: "boolean", good: 1, poor: 0, facet_id: "security_verification", weight: 1 }],
  local_feedback: [{ role: "primary", observation_id: "engineering.developer.local_feedback", direction: "boolean", good: 1, poor: 0, facet_id: "local_feedback", weight: 1 }],
  configuration_ergonomics: [{ role: "primary", observation_id: "engineering.developer.configuration_ergonomics", direction: "higher", good: 0.8, poor: 0.35, facet_id: "configuration_ergonomics", weight: 1 }],
  repository_overview: [{ role: "primary", observation_id: "engineering.documentation.repository_overview", direction: "boolean", good: 1, poor: 0, facet_id: "repository_overview", weight: 1 }],
  contracts_and_runbooks: [{ role: "primary", observation_id: "engineering.documentation.contracts_and_runbooks", direction: "higher", good: 0.8, poor: 0.35, facet_id: "contracts_and_runbooks", weight: 1 }],
  change_context: [{ role: "primary", observation_id: "engineering.documentation.change_context", direction: "higher", good: 0.8, poor: 0.35, facet_id: "change_context", weight: 1 }],
  onboarding_discoverability: [{ role: "primary", observation_id: "engineering.documentation.onboarding_discoverability", direction: "boolean", good: 1, poor: 0, facet_id: "onboarding_discoverability", weight: 1 }],
  change_verification: [
    { role: "primary", observation_id: "engineering.verification.change_verification", direction: "higher", good: 0.9, poor: 0.45, facet_id: "change_verification", weight: 0.7 },
    { role: "supporting", observation_id: "engineering.verification.tests_passed", direction: "higher", good: 1, poor: 0, facet_id: "tests_passed", weight: 0.3 },
  ],
});

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function compare(left, right) { return String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1; }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) { return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`; }
function freeze(value) {
  if (Array.isArray(value)) value.forEach(freeze);
  else if (isRecord(value)) Object.values(value).forEach(freeze);
  return Object.freeze(value);
}
function fail(message) { throw new Error(`FAIL-ASSESSMENT-TARGET-POLICY: ${message}`); }
function assertClosed(value, allowed, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort(compare);
  if (unexpected.length > 0) fail(`${label} contains unexpected field ${unexpected[0]}`);
}
function finite(value, label) {
  if (!Number.isFinite(value)) fail(`${label} must be a finite number`);
}

function recipeSlots(criterionId, recipes) {
  const supplied = recipes?.[criterionId];
  if (supplied && Array.isArray(supplied.slots)) return supplied.slots;
  if (Array.isArray(DYNAMIC_CRITERION_SLOTS[criterionId])) return DYNAMIC_CRITERION_SLOTS[criterionId];
  const fallback = RECIPES[criterionId];
  if (fallback && Array.isArray(fallback.slots)) return fallback.slots;
  return [];
}

function normalizeTargetDescriptor(slot, observationsById, label) {
  if (!isRecord(slot) || typeof slot.observation_id !== "string" || slot.observation_id.length === 0) fail(`${label} must bind a semantic observation ID`);
  if (!Object.hasOwn(DIRECTIONS, slot.direction)) fail(`${label} has unsupported direction ${String(slot.direction)}`);
  finite(slot.good, `${label}.acceptable_value`);
  finite(slot.poor, `${label}.concern_value`);
  const direction = DIRECTIONS[slot.direction];
  if (direction === "at_or_below" && slot.good > slot.poor) fail(`${label} has an inverted lower-is-better range`);
  if (direction === "at_or_above" && slot.good < slot.poor) fail(`${label} has an inverted higher-is-better range`);
  const observed = observationsById.get(slot.observation_id);
  const unit = observed?.unit ?? OBSERVATION_UNITS[slot.observation_id] ?? slot.unit;
  if (typeof unit !== "string" || unit.trim() === "") fail(`${label} has no known semantic unit`);
  if (OBSERVATION_UNITS[slot.observation_id] && OBSERVATION_UNITS[slot.observation_id] !== unit) {
    fail(`${label} unit ${unit} does not match the semantic unit ${OBSERVATION_UNITS[slot.observation_id]}`);
  }
  return {
    observation_id: slot.observation_id,
    direction,
    acceptable_value: slot.good,
    concern_value: slot.poor,
    unit,
  };
}

function normalizeOverrideDescriptor(value, fallback, label) {
  assertClosed(value, ["observation_id", "direction", "acceptable_value", "concern_value", "unit"], label);
  if (value.observation_id !== fallback.observation_id) fail(`${label} is not bound to the recipe observation ${fallback.observation_id}`);
  if (value.direction !== fallback.direction) fail(`${label}.direction cannot change semantic directionality`);
  if (value.unit !== fallback.unit) fail(`${label}.unit must be ${fallback.unit}`);
  finite(value.acceptable_value, `${label}.acceptable_value`);
  finite(value.concern_value, `${label}.concern_value`);
  if (fallback.direction === "at_or_below" && value.acceptable_value > value.concern_value) fail(`${label} has an inverted lower-is-better range`);
  if (fallback.direction === "at_or_above" && value.acceptable_value < value.concern_value) fail(`${label} has an inverted higher-is-better range`);
  if (fallback.unit === "state" && !(value.acceptable_value === 1 && value.concern_value === 0)) fail(`${label} state thresholds must remain 1 and 0`);
  return {
    observation_id: fallback.observation_id,
    direction: fallback.direction,
    acceptable_value: value.acceptable_value,
    concern_value: value.concern_value,
    unit: fallback.unit,
  };
}

function normalizeOverrideMap(raw, recipes, observationsById, label) {
  if (raw === undefined || raw === null) return new Map();
  let mapValue = raw;
  if (isRecord(raw) && Object.hasOwn(raw, "targets")) {
    assertClosed(raw, ["targets"], label);
    mapValue = raw.targets;
  }
  const entries = Array.isArray(mapValue)
    ? mapValue.map((entry) => {
      if (!isRecord(entry) || typeof entry.criterion_id !== "string") fail(`${label} array entries require criterion_id`);
      assertClosed(entry, ["criterion_id", "observations"], `${label}.${entry.criterion_id}`);
      return [entry.criterion_id, entry];
    })
    : isRecord(mapValue) ? Object.entries(mapValue) : null;
  if (entries === null) fail(`${label} must be a criterion map or array`);
  const result = new Map();
  for (const [criterionId, entry] of entries.sort((left, right) => compare(left[0], right[0]))) {
    if (result.has(criterionId)) fail(`${label} repeats criterion ${criterionId}`);
    const slots = recipeSlots(criterionId, recipes);
    if (slots.length === 0) fail(`${label} references unknown or non-numeric criterion ${criterionId}`);
    if (!isRecord(entry)) fail(`${label}.${criterionId} must be an object`);
    assertClosed(entry, ["observations"], `${label}.${criterionId}`);
    if (!Array.isArray(entry.observations) || entry.observations.length === 0) fail(`${label}.${criterionId}.observations must be a non-empty array`);
    const defaults = new Map(slots.map((slot) => [slot.observation_id, normalizeTargetDescriptor(slot, observationsById, `${label}.${criterionId}.${slot.observation_id}`)]));
    const seen = new Set();
    const overrideObservations = entry.observations.map((value, index) => {
      if (!isRecord(value) || typeof value.observation_id !== "string") fail(`${label}.${criterionId}.observations[${index}] requires observation_id`);
      if (seen.has(value.observation_id)) fail(`${label}.${criterionId} repeats ${value.observation_id}`);
      seen.add(value.observation_id);
      const fallback = defaults.get(value.observation_id);
      if (!fallback) fail(`${label}.${criterionId} references unbound observation ${value.observation_id}`);
      return normalizeOverrideDescriptor(value, fallback, `${label}.${criterionId}.observations[${index}]`);
    });
    result.set(criterionId, overrideObservations);
  }
  return result;
}

function readRepositoryProfile(repositoryRoot, readFile) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "") return null;
  const profilePath = path.join(repositoryRoot, ".sei", "assessment-profile.json");
  let payload;
  try { payload = readFile(profilePath, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let profile;
  try { profile = JSON.parse(payload); } catch { fail(`repository profile ${profilePath} is not valid JSON`); }
  if (!isRecord(profile)) fail(`repository profile ${profilePath} must be an object`);
  const keys = ["targets", "assessment_targets", "target_policy"].filter((key) => Object.hasOwn(profile, key));
  if (keys.length > 1) fail(`repository profile ${profilePath} declares multiple target policy fields`);
  if (keys.length === 0) return null;
  if (profile[keys[0]] === null || profile[keys[0]] === undefined) fail(`repository profile ${profilePath} target policy must not be null`);
  return { value: profile[keys[0]], path: profilePath };
}

function explicitTargetPolicy(assessmentConfig) {
  if (!isRecord(assessmentConfig)) return null;
  const keys = ["targets", "assessment_targets", "target_policy"].filter((key) => Object.hasOwn(assessmentConfig, key));
  if (keys.length > 1) fail("assessment configuration declares multiple target policy fields");
  if (keys.length === 0) return null;
  if (assessmentConfig[keys[0]] === null || assessmentConfig[keys[0]] === undefined) fail("assessment target policy must not be null");
  return { value: assessmentConfig[keys[0]], path: null };
}

function resolveAssessmentTargetPolicy({ assessmentConfig = null, repositoryRoot = null, readFile = fs.readFileSync, recipes = null, rubric = null, observations = [] } = {}) {
  if (!Array.isArray(observations)) fail("observations must be an array");
  const observationsById = new Map();
  for (const observation of observations) {
    if (isRecord(observation) && typeof observation.observation_id === "string") observationsById.set(observation.observation_id, observation);
  }
  const selected = explicitTargetPolicy(assessmentConfig) ?? readRepositoryProfile(repositoryRoot, readFile);
  const selectedRecipes = recipes ?? Object.fromEntries(Object.entries(RECIPES));
  const criterionIds = rubric?.criteria?.map((criterion) => criterion.criterion_id)
    ?? Object.keys(selectedRecipes);
  const overrideMap = selected ? normalizeOverrideMap(selected.value, selectedRecipes, observationsById, selected.path ? `repository target policy ${selected.path}` : "explicit target policy") : new Map();
  const criteria = [];
  for (const criterionId of [...new Set(criterionIds)].sort(compare)) {
    const slots = recipeSlots(criterionId, selectedRecipes);
    const defaults = slots.map((slot) => normalizeTargetDescriptor(slot, observationsById, `criterion ${criterionId}.${slot.observation_id}`));
    const overrides = new Map((overrideMap.get(criterionId) ?? []).map((target) => [target.observation_id, target]));
    const targetObservations = defaults.map((target) => overrides.get(target.observation_id) ?? target);
    criteria.push({
      criterion_id: criterionId,
      acceptable_score: DEFAULT_SCORE_BANDS.acceptable,
      target_source: overrideMap.has(criterionId) ? (selected?.path ? TARGET_SOURCE.OVERRIDE : TARGET_SOURCE.EXPLICIT) : TARGET_SOURCE.DEFAULT,
      observations: targetObservations,
    });
  }
  const sourceKind = selected === null ? TARGET_SOURCE.DEFAULT : selected.path ? TARGET_SOURCE.OVERRIDE : TARGET_SOURCE.EXPLICIT;
  const canonical = {
    schema_version: ASSESSMENT_TARGET_POLICY_VERSION,
    score_bands: DEFAULT_SCORE_BANDS,
    criteria,
    source: { kind: sourceKind },
  };
  return freeze({ ...canonical, policy_digest: digest(canonical) });
}

function deriveTargetPolicyDigest(policy) {
  if (!isRecord(policy)) return null;
  const { policy_digest, ...canonical } = policy;
  return digest(canonical);
}

const KNOWN_TARGET_OBSERVATION_IDS = Object.freeze(new Set([
  ...Object.keys(OBSERVATION_UNITS),
  ...Object.values(RECIPES).flatMap((recipe) => (recipe.slots ?? []).map((slot) => slot.observation_id)),
  ...Object.values(DYNAMIC_CRITERION_SLOTS).flatMap((slots) => slots.map((slot) => slot.observation_id)),
]));

module.exports = Object.freeze({
  ASSESSMENT_TARGET_POLICY_VERSION,
  DEFAULT_SCORE_BANDS,
  deriveTargetPolicyDigest,
  KNOWN_TARGET_OBSERVATION_IDS,
  OBSERVATION_UNITS,
  resolveAssessmentTargetPolicy,
});
