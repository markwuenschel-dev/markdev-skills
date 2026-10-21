"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EVIDENCE_ROLES,
  getCriterionRecipe,
  synthesizeCriterion,
} = require("./engineering-assessment-synthesis.js");

function observation(observation_id, value, options = {}) {
  return {
    observation_id,
    value,
    unit: options.unit ?? "ratio",
    state: options.state ?? "observed",
    coverage: options.coverage ?? 1,
    confidence: options.confidence ?? 1,
    context: options.context ?? {},
    source_metric_ids: options.source_metric_ids ?? ["static.fixture.metric"],
    evidence_refs: options.evidence_refs ?? [`evidence:${observation_id}`],
  };
}

test("complexity synthesis preserves evidence roles and reacts to tail concentration rather than a scalar average", () => {
  const recipe = getCriterionRecipe("complexity_concentration");
  const broadTail = synthesizeCriterion({
    criterion_id: "complexity_concentration",
    recipe,
    observations: [
      observation("engineering.complexity.production.p90", 7),
      observation("engineering.complexity.production.max", 9),
      observation("engineering.complexity.production.outlier_ratio", 0.02),
      observation("engineering.complexity.production.coverage", 0.95),
    ],
  });
  const sharpTail = synthesizeCriterion({
    criterion_id: "complexity_concentration",
    recipe,
    observations: [
      observation("engineering.complexity.production.p90", 7),
      observation("engineering.complexity.production.max", 40),
      observation("engineering.complexity.production.outlier_ratio", 0.02),
      observation("engineering.complexity.production.coverage", 0.95),
    ],
  });

  assert.deepEqual(EVIDENCE_ROLES, ["primary", "supporting", "context", "limiting", "coverage"]);
  assert.equal(broadTail.score > sharpTail.score, true);
  assert.equal(broadTail.evidence.some((item) => item.role === "primary"), true);
  assert.equal(broadTail.evidence.some((item) => item.role === "supporting"), true);
  assert.equal(broadTail.evidence.some((item) => item.role === "coverage"), true);
  assert.equal(broadTail.explanation.observed.length > 0, true);
  assert.equal(broadTail.explanation.next_investigation.length > 0, true);
  assert.equal(broadTail.evidence_refs.length, 4);
});

test("architecture recipe treats cycle and SCC pressure as separate facets", () => {
  const recipe = getCriterionRecipe("cycle_participation");
  const dispersed = synthesizeCriterion({
    criterion_id: "cycle_participation",
    recipe,
    observations: [
      observation("engineering.dependency.cycle_pressure", 0.1),
      observation("engineering.dependency.scc_concentration", 0.1),
      observation("engineering.dependency.centrality_concentration", 0.1),
      observation("engineering.dependency.boundary_pressure", 0.1),
      observation("engineering.git.co_change_pressure", 0.1),
    ],
  });
  const concentrated = synthesizeCriterion({
    criterion_id: "cycle_participation",
    recipe,
    observations: [
      observation("engineering.dependency.cycle_pressure", 0.1),
      observation("engineering.dependency.scc_concentration", 0.9),
      observation("engineering.dependency.centrality_concentration", 0.1),
      observation("engineering.dependency.boundary_pressure", 0.1),
      observation("engineering.git.co_change_pressure", 0.1),
    ],
  });

  assert.equal(dispersed.score > concentrated.score, true);
  assert.equal(concentrated.facets.some((facet) => facet.facet_id === "scc_concentration"), true);
  assert.match(concentrated.explanation.means, /architecture/i);
});

test("architecture criteria use distinct primary semantic observations", () => {
  assert.equal(getCriterionRecipe("dependency_direction").slots.find((item) => item.role === "primary").observation_id, "engineering.dependency.instability");
  assert.equal(getCriterionRecipe("responsibility_concentration").slots.find((item) => item.role === "primary").observation_id, "engineering.dependency.centrality_concentration");
  assert.equal(getCriterionRecipe("module_boundary_coherence").slots.find((item) => item.role === "primary").observation_id, "engineering.dependency.boundary_pressure");
});

test("primary evidence is required while partial limiting evidence bounds assessment confidence", () => {
  const recipe = getCriterionRecipe("verification");
  const missingPrimary = synthesizeCriterion({
    criterion_id: "test_execution",
    recipe,
    observations: [observation("engineering.verification.statement_coverage", 0.9)],
  });
  const limited = synthesizeCriterion({
    criterion_id: "test_execution",
    recipe,
    observations: [
      observation("engineering.verification.test_execution", 1),
      observation("engineering.verification.statement_coverage", 0.9),
      observation("engineering.verification.execution_exclusions", 1, { state: "partial", coverage: 0.35, confidence: 0.8 }),
    ],
  });

  assert.equal(missingPrimary.score, null);
  assert.equal(missingPrimary.applicability, "not_scored");
  assert.equal(limited.score !== null, true);
  assert.equal(limited.confidence !== "HIGH", true);
  assert.match(limited.explanation.limitations, /partial|limit/i);
});

test("a numeric score with coverage below 0.3 is provisional, not an uncounted not_scored hole", () => {
  const result = synthesizeCriterion({
    criterion_id: "ci_prerequisites",
    observations: [observation("engineering.delivery.ci_configured", true, { unit: "state", coverage: 0.2, confidence: 0.4 })],
  });
  assert.notEqual(result.score, null);
  assert.equal(result.applicability, "applicable");
  assert.equal(result.maturity, "provisional");
  assert.ok(result.coverage < 0.3);
});

test("resource-limited duplication remains an observed lower bound rather than complete repository evidence", () => {
  const result = synthesizeCriterion({
    criterion_id: "duplication_pressure",
    recipe: getCriterionRecipe("duplication_pressure"),
    observations: [
      observation("engineering.duplication.observed_ratio", 0.08),
      observation("engineering.duplication.clone_family_pressure", 0.1),
      observation("engineering.duplication.analysis_coverage", 0.35),
      observation("engineering.duplication.resource_limit", 1, { state: "partial", coverage: 0.35 }),
    ],
  });

  assert.equal(result.score !== null, true);
  assert.equal(result.coverage < 0.6, true);
  assert.match(result.explanation.blocked_stronger_result, /lower bound|resource|coverage/i);
});

test("semantic capability states are reduced from observed capability state, not a numeric proxy", () => {
  const result = synthesizeCriterion({
    criterion_id: "ci_prerequisites",
    observations: [observation("engineering.delivery.ci_configured", true, { unit: "state" })],
  });

  assert.equal(result.synthesis.recipe_id, "semantic-capability-state@1");
  assert.equal(result.score, 100);
  assert.equal(result.evidence[0].role, "primary");
});

test("synthesis rejects unbound observations and empty explanation contracts", () => {
  const invalid = observation("engineering.complexity.production.p90", 7, { evidence_refs: [] });
  assert.throws(() => synthesizeCriterion({
    criterion_id: "complexity_concentration",
    recipe: getCriterionRecipe("complexity_concentration"),
    observations: [invalid],
  }), /FAIL-ASSESSMENT-BINDING/);
});
