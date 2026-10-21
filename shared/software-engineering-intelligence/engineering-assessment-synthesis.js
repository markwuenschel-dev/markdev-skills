"use strict";

// Package-private synthesis seam for engineering-assessment@3.  It consumes
// semantic observations; raw producer metric IDs are retained only as evidence
// provenance and never participate in recipe selection.

const EVIDENCE_ROLES = Object.freeze(["primary", "supporting", "context", "limiting", "coverage"]);
const OBSERVED_STATES = new Set(["observed", "measured", "inferred", "available", "complete", "partial"]);
const round = (value) => Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
const compare = (left, right) => String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1;
const clamp = (value) => Math.max(0, Math.min(1, value));

function fail(code, message) { throw new Error(`${code}: ${message}`); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function uniqueSorted(values) { return [...new Set(values)].sort(compare); }

function slot(role, observation_id, direction, good, poor, facet_id, weight = 1) {
  return { role, observation_id, direction, good, poor, facet_id, weight };
}

const RECIPES = Object.freeze({
  complexity_concentration: Object.freeze({
    recipe_id: "complexity-tail-pressure@1", family: "complexity", reducer_version: "facet-floor@1",
    slots: [
      slot("primary", "engineering.complexity.production.p90", "lower", 5, 25, "tail_pressure", 0.55),
      slot("supporting", "engineering.complexity.production.max", "lower", 10, 60, "maximum_pressure", 0.25),
      slot("supporting", "engineering.complexity.production.outlier_ratio", "lower", 0.01, 0.2, "outlier_concentration", 0.2),
      slot("coverage", "engineering.complexity.production.coverage", "higher", 0.85, 0.35, "production_coverage"),
      slot("limiting", "engineering.complexity.parser_exclusions", "lower", 0, 1, "parser_exclusions"),
    ],
    meaning: "Complexity tail pressure identifies production code that is disproportionately difficult to change safely.",
    investigation: "Inspect the highest-complexity production modules and the excluded parser regions before choosing a refactor.",
  }),
  architecture: Object.freeze({
    recipe_id: "architecture-relationship-pressure@1", family: "architecture", reducer_version: "facet-floor@1",
    slots: [
      slot("primary", "engineering.dependency.cycle_pressure", "lower", 0.02, 0.5, "cycle_pressure", 0.3),
      slot("supporting", "engineering.dependency.scc_concentration", "lower", 0.05, 0.8, "scc_concentration", 0.25),
      slot("supporting", "engineering.dependency.centrality_concentration", "lower", 0.2, 0.9, "centrality_concentration", 0.2),
      slot("supporting", "engineering.dependency.boundary_pressure", "lower", 0.1, 0.8, "boundary_pressure", 0.15),
      slot("context", "engineering.git.co_change_pressure", "lower", 0.1, 0.8, "behavioral_coupling", 0.1),
      slot("limiting", "engineering.dependency.analysis_exclusions", "lower", 0, 1, "analysis_exclusions"),
    ],
    meaning: "Architecture evidence combines dependency integrity, concentration, boundaries, and behavioral coupling rather than treating one graph count as the architecture score.",
    investigation: "Inspect the highest-pressure dependency components and corroborating co-change relationships before changing boundaries.",
  }),
  dependency_direction: Object.freeze({
    recipe_id: "dependency-direction-integrity@1", family: "architecture", reducer_version: "facet-floor@1",
    slots: [
      slot("primary", "engineering.dependency.instability", "lower", 0.15, 0.8, "dependency_instability", 0.55),
      slot("supporting", "engineering.dependency.boundary_pressure", "lower", 0.1, 0.8, "boundary_pressure", 0.3),
      slot("context", "engineering.git.co_change_pressure", "lower", 0.1, 0.8, "behavioral_coupling", 0.15),
      slot("limiting", "engineering.dependency.analysis_exclusions", "lower", 0, 1, "analysis_exclusions"),
    ],
    meaning: "Dependency direction is assessed through observed instability and boundary pressure, with behavioral coupling as corroborating context.",
    investigation: "Inspect unstable dependency edges and the affected boundary before introducing a directional rule or refactor.",
  }),
  responsibility_concentration: Object.freeze({
    recipe_id: "responsibility-centrality-pressure@1", family: "architecture", reducer_version: "facet-floor@1",
    slots: [
      slot("primary", "engineering.dependency.centrality_concentration", "lower", 0.2, 0.9, "centrality_concentration", 0.6),
      slot("supporting", "engineering.git.co_change_pressure", "lower", 0.1, 0.8, "behavioral_coupling", 0.25),
      slot("supporting", "engineering.dependency.boundary_pressure", "lower", 0.1, 0.8, "boundary_pressure", 0.15),
      slot("limiting", "engineering.dependency.analysis_exclusions", "lower", 0, 1, "analysis_exclusions"),
    ],
    meaning: "Responsibility concentration is assessed from dependency centrality, corroborated by change coupling and boundary pressure.",
    investigation: "Inspect the highest-centrality modules and their co-change partners before splitting responsibilities.",
  }),
  module_boundary_coherence: Object.freeze({
    recipe_id: "module-boundary-pressure@1", family: "architecture", reducer_version: "facet-floor@1",
    slots: [
      slot("primary", "engineering.dependency.boundary_pressure", "lower", 0.1, 0.8, "boundary_pressure", 0.6),
      slot("supporting", "engineering.dependency.centrality_concentration", "lower", 0.2, 0.9, "centrality_concentration", 0.2),
      slot("context", "engineering.git.co_change_pressure", "lower", 0.1, 0.8, "behavioral_coupling", 0.2),
      slot("limiting", "engineering.dependency.analysis_exclusions", "lower", 0, 1, "analysis_exclusions"),
    ],
    meaning: "Module boundary coherence is assessed from cross-boundary pressure, with centrality and co-change providing context.",
    investigation: "Inspect the highest-pressure module boundaries and their recurring co-change relationships before moving code.",
  }),
  change_pressure: Object.freeze({
    recipe_id: "change-pressure-distribution@1", family: "change", reducer_version: "facet-floor@1",
    slots: [
      slot("primary", "engineering.git.observed_churn", "lower", 0.1, 0.8, "churn_distribution", 0.45),
      slot("supporting", "engineering.git.change_frequency", "lower", 0.1, 0.8, "change_frequency", 0.3),
      slot("supporting", "engineering.git.co_change_pressure", "lower", 0.1, 0.8, "co_change_pressure", 0.25),
      slot("coverage", "engineering.git.history_coverage", "higher", 0.85, 0.35, "history_coverage"),
    ],
    meaning: "Change pressure reflects the concentration and coupling of repository change, not a single commit count.",
    investigation: "Inspect high-churn modules and their recurring co-change partners for a bounded decomposition opportunity.",
  }),
  verification: Object.freeze({
    recipe_id: "verification-execution-evidence@1", family: "verification", reducer_version: "facet-floor@1",
    slots: [
      slot("primary", "engineering.verification.test_execution", "boolean", 1, 0, "test_execution", 0.6),
      slot("supporting", "engineering.verification.statement_coverage", "higher", 0.8, 0.4, "statement_coverage", 0.4),
      slot("coverage", "engineering.verification.test_scope_coverage", "higher", 0.85, 0.35, "test_scope_coverage"),
      slot("limiting", "engineering.verification.execution_exclusions", "lower", 0, 1, "execution_exclusions"),
    ],
    meaning: "Verification is established first by observed execution, then strengthened by coverage and bounded by exclusions.",
    investigation: "Run the configured test command in the observed environment and inspect excluded suites before expanding test claims.",
  }),
  duplication_pressure: Object.freeze({
    recipe_id: "duplication-observed-pressure@1", family: "duplication", reducer_version: "facet-floor@1",
    slots: [
      slot("primary", "engineering.duplication.observed_ratio", "lower", 0.02, 0.2, "observed_ratio", 0.65),
      slot("supporting", "engineering.duplication.clone_family_pressure", "lower", 0.02, 0.3, "clone_family_pressure", 0.35),
      slot("coverage", "engineering.duplication.analysis_coverage", "higher", 0.85, 0.35, "analysis_coverage"),
      slot("limiting", "engineering.duplication.resource_limit", "lower", 0, 1, "resource_limit"),
    ],
    meaning: "Duplication pressure reflects observed clone concentration and analysis reach; a truncated analysis is a lower bound, not a repository-wide result.",
    investigation: "Re-run duplication analysis with sufficient resources or inspect the reported clone families before consolidating code.",
  }),
  semantic_capability: Object.freeze({
    recipe_id: "semantic-capability-state@1", family: "capability", reducer_version: "state-gate@1",
    slots: [],
    meaning: "This criterion is based on the observed state of a repository capability, not an invented numeric proxy.",
    investigation: "Collect the configured capability evidence or document why the capability is not applicable.",
  }),
});

const CRITERION_FAMILIES = Object.freeze({
  complexity_concentration: "complexity_concentration",
  cycle_participation: "architecture",
  dependency_direction: "dependency_direction",
  responsibility_concentration: "responsibility_concentration",
  module_boundary_coherence: "module_boundary_coherence",
  change_pressure: "change_pressure",
  commit_batch_discipline: "change_pressure",
  ownership_distribution: "change_pressure",
  change_scope_coherence: "change_pressure",
  test_configuration: "verification",
  test_execution: "verification",
  coverage_evidence: "verification",
  change_verification: "verification",
  duplication_pressure: "duplication_pressure",
});

function getCriterionRecipe(criterionId) {
  const family = CRITERION_FAMILIES[criterionId] ?? criterionId;
  return RECIPES[family] ?? RECIPES.semantic_capability;
}

function assertObservation(value) {
  if (!isRecord(value) || typeof value.observation_id !== "string" || value.observation_id.length === 0) fail("FAIL-ASSESSMENT-SEMANTIC-ID", "observation_id must be a non-empty semantic identifier");
  if (!Object.hasOwn(value, "value") || !(Number.isFinite(value.value) || typeof value.value === "boolean" || typeof value.value === "string")) fail("FAIL-ASSESSMENT-EVIDENCE-MAP", `observation ${value.observation_id} has no usable value`);
  if (!OBSERVED_STATES.has(value.state)) fail("FAIL-ASSESSMENT-EVIDENCE-MAP", `observation ${value.observation_id} has unsupported state`);
  if (!Number.isFinite(value.coverage) || value.coverage < 0 || value.coverage > 1 || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) fail("FAIL-ASSESSMENT-EVIDENCE-MAP", `observation ${value.observation_id} has invalid coverage or confidence`);
  if (!Array.isArray(value.source_metric_ids) || !value.source_metric_ids.every((id) => typeof id === "string") || !Array.isArray(value.evidence_refs) || value.evidence_refs.length === 0 || !value.evidence_refs.every((ref) => typeof ref === "string")) fail("FAIL-ASSESSMENT-BINDING", `observation ${value.observation_id} must retain bound source metrics and evidence references`);
}

function scoreValue(value, descriptor) {
  const numeric = typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (descriptor.direction === "boolean") return numeric > 0 ? 100 : 0;
  if (descriptor.direction === "higher") {
    if (numeric >= descriptor.good) return 100;
    if (numeric <= descriptor.poor) return 0;
    return round(100 * (numeric - descriptor.poor) / (descriptor.good - descriptor.poor));
  }
  if (numeric <= descriptor.good) return 100;
  if (numeric >= descriptor.poor) return 0;
  return round(100 * (descriptor.poor - numeric) / (descriptor.poor - descriptor.good));
}

function confidenceFor(coverage, limiting) {
  if (coverage < 0.3) return "NOT_ESTABLISHED";
  if (coverage >= 0.8 && limiting.length === 0) return "HIGH";
  if (coverage >= 0.55) return "MODERATE";
  return "LOW";
}
function maturityFor(coverage, score) {
  if (score === null) return "not_scored";
  return coverage < 0.6 ? "provisional" : "established";
}
function scoreBand(score) { return score === null ? "NOT SCORED" : score >= 80 ? "strong" : score >= 60 ? "mixed" : "needs_attention"; }

function rolesFor(observations, recipe) {
  const descriptors = recipe.slots ?? [];
  return observations.map((observation) => {
    const descriptor = descriptors.find((candidate) => candidate.observation_id === observation.observation_id);
    return { observation, descriptor, role: descriptor?.role ?? "context" };
  }).sort((left, right) => compare(left.role, right.role) || compare(left.observation.observation_id, right.observation.observation_id));
}

function synthesizeCriterion({ criterion_id, observations, recipe = undefined }) {
  if (typeof criterion_id !== "string" || criterion_id.length === 0 || !Array.isArray(observations)) fail("FAIL-ASSESSMENT-INPUT", "criterion_id and observations are required");
  observations.forEach(assertObservation);
  const selectedRecipe = recipe ?? getCriterionRecipe(criterion_id);
  if (!isRecord(selectedRecipe) || typeof selectedRecipe.recipe_id !== "string" || !Array.isArray(selectedRecipe.slots)) fail("FAIL-ASSESSMENT-ROLE-CONTRACT", "recipe must provide an ID and slots");
  const dynamicCapabilitySlots = selectedRecipe.recipe_id === "semantic-capability-state@1" && selectedRecipe.slots.length === 0
    ? observations.slice().sort((left, right) => compare(left.observation_id, right.observation_id)).map((observation, index) => slot(index === 0 ? "primary" : "supporting", observation.observation_id, "boolean", 1, 0, index === 0 ? "capability_state" : `capability_context_${index}`, 1))
    : selectedRecipe.slots;
  const effectiveRecipe = dynamicCapabilitySlots === selectedRecipe.slots ? selectedRecipe : { ...selectedRecipe, slots: dynamicCapabilitySlots };
  const evidence = rolesFor(observations, effectiveRecipe).map(({ observation, role }) => ({ ...structuredClone(observation), role }));
  const byId = new Map(observations.map((observation) => [observation.observation_id, observation]));
  const facets = effectiveRecipe.slots.map((descriptor) => {
    const observation = byId.get(descriptor.observation_id) ?? null;
    return {
      facet_id: descriptor.facet_id,
      role: descriptor.role,
      observation_id: descriptor.observation_id,
      observed: observation !== null,
      score: observation === null || ["coverage", "limiting", "context"].includes(descriptor.role) ? null : scoreValue(observation.value, descriptor),
      coverage: observation === null ? 0 : round(clamp(observation.coverage * observation.confidence)),
      weight: descriptor.weight ?? 1,
    };
  });
  const primaryFacets = facets.filter((facet) => facet.role === "primary");
  const missingPrimary = primaryFacets.some((facet) => !facet.observed);
  const scoreFacets = facets.filter((facet) => facet.score !== null);
  const weightedScore = scoreFacets.length === 0 ? null : scoreFacets.reduce((sum, facet) => sum + facet.score * facet.weight, 0) / scoreFacets.reduce((sum, facet) => sum + facet.weight, 0);
  // The facet floor prevents a very weak tail/cycle/verification facet being
  // washed out by unrelated supporting observations.
  const facetFloor = scoreFacets.length === 0 ? null : Math.min(...scoreFacets.map((facet) => facet.score));
  const score = missingPrimary || scoreFacets.length === 0 ? null : round(0.7 * weightedScore + 0.3 * facetFloor);
  const qualityFacets = facets.filter((facet) => facet.observed && facet.role !== "context");
  const averageCoverage = qualityFacets.length === 0 ? 0 : qualityFacets.reduce((sum, facet) => sum + facet.coverage, 0) / qualityFacets.length;
  const optionalFacets = facets.filter((facet) => facet.role !== "primary" && facet.role !== "context");
  const missingOptionalCount = optionalFacets.filter((facet) => !facet.observed).length;
  // Optional corroboration never fabricates evidence: absent supporting,
  // coverage, and limiting observations bound the result without blocking it.
  const optionalCompleteness = optionalFacets.length === 0 ? 1 : 1 - (0.3 * missingOptionalCount / optionalFacets.length);
  const coverageFacets = facets.filter((facet) => facet.observed && facet.role === "coverage");
  const limitingFacets = facets.filter((facet) => facet.observed && facet.role === "limiting");
  const boundedCoverage = [...coverageFacets, ...limitingFacets].map((facet) => facet.coverage);
  const coverage = round(Math.min(averageCoverage * optionalCompleteness, ...(boundedCoverage.length ? boundedCoverage : [1])));
  const limiting = evidence.filter((item) => item.role === "limiting" && (item.state === "partial" || item.coverage < 0.8));
  const evidence_refs = uniqueSorted(evidence.flatMap((item) => item.evidence_refs));
  const familyLabel = selectedRecipe.family ?? "engineering";
  const observedFacets = facets.filter((facet) => facet.observed).map((facet) => facet.facet_id.replaceAll("_", " "));
  const limitations = missingPrimary
    ? "Required primary evidence was not observed. Supporting evidence cannot establish this criterion."
    : limiting.length > 0 ? "Partial or limiting evidence bounds confidence in this result."
      : missingOptionalCount > 0 ? "Some optional corroborating evidence was not observed, so this result is bounded."
        : "No limiting evidence was reported by the selected recipe.";
  const blocked = score === null ? "A stronger result is blocked until required primary evidence is collected."
    : coverage < 0.6 ? "This is a bounded lower-confidence result because available evidence is incomplete or resource-limited."
      : "A stronger result would require corroborating evidence or a more complete observed scope.";
  const explanation = {
    observed: observedFacets.length ? `SEI observed ${observedFacets.join(", ")} for this ${familyLabel} criterion.` : `SEI did not observe usable evidence for this ${familyLabel} criterion.`,
    means: selectedRecipe.meaning ?? "The observed evidence is interpreted through a deterministic engineering recipe.",
    why_it_matters: `${familyLabel[0].toUpperCase()}${familyLabel.slice(1)} pressure affects the safety and cost of future changes.`,
    limitations,
    blocked_stronger_result: blocked,
    next_investigation: selectedRecipe.investigation ?? "Collect the required primary evidence and inspect the bound evidence references.",
  };
  for (const [field, value] of Object.entries(explanation)) if (typeof value !== "string" || value.trim().length === 0) fail("FAIL-ASSESSMENT-EXPLANATION", `explanation.${field} must be non-empty`);
  return Object.freeze({
    criterion_id,
    applicability: score === null ? "not_scored" : "applicable",
    score,
    score_band: scoreBand(score),
    coverage,
    confidence: confidenceFor(coverage, limiting),
    maturity: maturityFor(coverage, score),
    evidence: Object.freeze(evidence),
    evidence_refs: Object.freeze(evidence_refs),
    facets: Object.freeze(facets),
    synthesis: Object.freeze({ recipe_id: selectedRecipe.recipe_id, reducer_version: selectedRecipe.reducer_version ?? "facet-floor@1", contributing_observation_ids: Object.freeze(uniqueSorted(evidence.map((item) => item.observation_id))) }),
    explanation: Object.freeze(explanation),
  });
}

module.exports = Object.freeze({ EVIDENCE_ROLES, RECIPES, getCriterionRecipe, synthesizeCriterion });
