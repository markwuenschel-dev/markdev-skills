"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  scoreMaturity,
  renderMaturityScorecardMarkdown,
  validateMaturityScorecard,
  withEvidenceArtifactRoot,
} = require("./maturity-scorer.js");

const rubric = require("./maturity-rubric.json");

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function evidenceRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-maturity-scorer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "receipt.txt"), "canonical evidence\n", "utf8");
  return root;
}

function bundle(root, observations = [], promotionEvidence = {}) {
  return withEvidenceArtifactRoot({
    kind: "sei-maturity-evidence-v1",
    sei_revision: "a".repeat(40),
    observations,
    promotion_evidence: {
      report_schema_integrity: false,
      merge_heavy_useful: false,
      framework_not_scored_honest: false,
      heterogeneous_repository_count: 0,
      primary_language_ecosystem_count: 0,
      merge_heavy_repository: null,
      large_repository: null,
      predictive_validation: null,
      cache_incremental_runs: null,
      ...promotionEvidence,
    },
  }, root);
}

function cacheRuns() {
  return {
    repositories: [
      { repository_id: "repo-a", cold_warm_pairs: [{ cold_duration_ms: 100, warm_duration_ms: 70 }, { cold_duration_ms: 110, warm_duration_ms: 77 }, { cold_duration_ms: 90, warm_duration_ms: 63 }] },
      { repository_id: "repo-b", cold_warm_pairs: [{ cold_duration_ms: 200, warm_duration_ms: 140 }, { cold_duration_ms: 180, warm_duration_ms: 126 }, { cold_duration_ms: 220, warm_duration_ms: 154 }] },
      { repository_id: "repo-c", cold_warm_pairs: [{ cold_duration_ms: 80, warm_duration_ms: 56 }, { cold_duration_ms: 90, warm_duration_ms: 63 }, { cold_duration_ms: 70, warm_duration_ms: 49 }] },
    ],
  };
}

function cacheRunsWithMedianRegression() {
  const runs = cacheRuns();
  runs.repositories[0].cold_warm_pairs = [{ cold_duration_ms: 100, warm_duration_ms: 99 }, { cold_duration_ms: 100, warm_duration_ms: 100 }, { cold_duration_ms: 100, warm_duration_ms: 101 }];
  return runs;
}

function cacheRunsWithMisleadingSeparateMedians() {
  const runs = cacheRuns();
  runs.repositories[0].cold_warm_pairs = [
    { cold_duration_ms: 1, warm_duration_ms: 1 },
    { cold_duration_ms: 100, warm_duration_ms: 1 },
    { cold_duration_ms: 100, warm_duration_ms: 99 },
  ];
  return runs;
}

function bootstrapBound(lowerConfidenceBound = 1.01) {
  return {
    method: "paired_bootstrap",
    confidence_level: 0.95,
    lower_confidence_bound: lowerConfidenceBound,
    provenance: { path: "receipt.txt", sha256: digest(Buffer.from("canonical evidence\n", "utf8")) },
  };
}

function predictiveValidation() {
  return {
    repository_count: 3,
    forward_folds_per_repository: 5,
    resolved_holdout_subject_count: 500,
    horizon_count: 2,
    leakage_detected: false,
    horizons: [
      { horizon_id: "30d", paired_bootstrap_95_lower_confidence_bound: bootstrapBound(), baselines: ["loc", "churn", "complexity", "commit_count"] },
      { horizon_id: "90d", paired_bootstrap_95_lower_confidence_bound: bootstrapBound(1.02), baselines: ["loc", "churn", "complexity", "commit_count"] },
    ],
  };
}

function observation(criterionId, level = "implementation", status = "pass") {
  const criterion = rubric.categories.flatMap((category) => category.criteria).find((item) => item.criterion_id === criterionId);
  return {
    probe_id: criterion.probe_id,
    criterion_id: criterion.criterion_id,
    status,
    evidence_level: level,
    summary: `${criterion.criterion_id} ${status} at ${level}`,
    artifact_refs: [{ path: "receipt.txt", sha256: digest(Buffer.from("canonical evidence\n", "utf8")) }],
  };
}

function scoreFor(criterionId, level, t) {
  const root = evidenceRoot(t);
  return scoreMaturity(bundle(root, [observation(criterionId, level)]));
}

test("the pinned rubric allocates exactly 1,000 points across the canonical categories", () => {
  assert.equal(rubric.rubric_id, "sei-maturity-v1");
  assert.deepEqual(rubric.categories.map((category) => category.maximum_points), [260, 200, 180, 160, 70, 50, 35, 25, 15, 5]);
  assert.equal(rubric.categories.reduce((sum, category) => sum + category.maximum_points, 0), 1000);
  for (const category of rubric.categories) {
    assert.equal(category.criteria.reduce((sum, criterion) => sum + criterion.maximum_points, 0), category.maximum_points);
  }
});

test("scoring is deterministic and unsupported criteria remain at zero", (t) => {
  const root = evidenceRoot(t);
  const input = bundle(root, [observation("measurement.revision_source_binding", "implementation")]);
  const first = scoreMaturity(input);
  const second = scoreMaturity(input);
  assert.deepEqual(first, second);
  assert.equal(first.total_points, 10);
  assert.equal(first.categories.find((category) => category.category_id === "performance").points, 0);
  assert.equal(first.promotion.status, "blocked");
});

test("standard evidence ceilings are applied exactly", (t) => {
  const expected = {
    implementation: 10,
    focused_deterministic: 20,
    synthetic_integration: 28,
    one_real_oracle: 34,
    heterogeneous_real_oracles: 40,
    temporal_holdout: 40,
  };
  for (const [level, points] of Object.entries(expected)) {
    const scorecard = scoreFor("measurement.revision_source_binding", level, t);
    assert.equal(scorecard.total_points, points, level);
  }
});

test("predictive criteria use their stricter ceilings and require temporal holdout for full credit", (t) => {
  const expected = {
    implementation: 2,
    focused_deterministic: 5,
    synthetic_integration: 9,
    one_real_oracle: 12,
    heterogeneous_real_oracles: 15,
    temporal_holdout: 20,
  };
  for (const [level, points] of Object.entries(expected)) {
    assert.equal(scoreFor("predictive.transparent_formulation", level, t).total_points, points, level);
  }
});

test("provenance criteria receive full credit at focused deterministic evidence", (t) => {
  assert.equal(scoreFor("provenance.revision_config_source_binding", "implementation", t).total_points, 0.75);
  assert.equal(scoreFor("provenance.revision_config_source_binding", "focused_deterministic", t).total_points, 3);
});

test("a higher-tier failure cannot be hidden behind lower-tier passing evidence", (t) => {
  const root = evidenceRoot(t);
  const scorecard = scoreMaturity(bundle(root, [
    observation("measurement.revision_source_binding", "focused_deterministic", "pass"),
    observation("measurement.revision_source_binding", "one_real_oracle", "fail"),
  ]));
  const criterion = scorecard.categories[0].criteria.find((item) => item.criterion_id === "measurement.revision_source_binding");
  assert.equal(criterion.status, "fail");
  assert.equal(criterion.evidence_level, null);
  assert.equal(criterion.points, 0);
  assert.doesNotThrow(() => validateMaturityScorecard(scorecard));
  assert.match(renderMaturityScorecardMarkdown(scorecard), /Promotion: fail/);
});

test("a lower-tier failure does not suppress a stronger passing observation", (t) => {
  const root = evidenceRoot(t);
  const scorecard = scoreMaturity(bundle(root, [
    observation("measurement.revision_source_binding", "implementation", "fail"),
    observation("measurement.revision_source_binding", "one_real_oracle", "pass"),
  ]));
  const criterion = scorecard.categories[0].criteria.find((item) => item.criterion_id === "measurement.revision_source_binding");
  assert.equal(criterion.status, "pass");
  assert.equal(criterion.evidence_level, "one_real_oracle");
  assert.equal(criterion.points, 34);
});

test("promotion evaluates every numeric floor and each nonnumeric evidence gate", (t) => {
  const root = evidenceRoot(t);
  const observations = rubric.categories.flatMap((category) => category.criteria.map((criterion) => observation(criterion.criterion_id, "temporal_holdout")));
  const promotionEvidence = {
    report_schema_integrity: true,
    merge_heavy_useful: true,
    framework_not_scored_honest: true,
    heterogeneous_repository_count: 4,
    primary_language_ecosystem_count: 3,
    merge_heavy_repository: { commit_count: 200, merge_commit_count: 10 },
    large_repository: { supported_source_file_count: 10000, source_line_count: 0, commit_count: 0 },
    cache_incremental_runs: cacheRuns(),
    predictive_validation: predictiveValidation(),
  };
  const passing = scoreMaturity(bundle(root, observations, promotionEvidence));
  assert.equal(passing.total_points, 1000);
  assert.equal(passing.promotion.status, "pass");
  for (const gate of Object.values(passing.promotion.gates)) assert.equal(gate.status, "pass", gate.gate_id);

  const missingNumeric = scoreMaturity(bundle(root, observations.filter((item) => item.criterion_id !== "actionability.executive_interpretation"), {
    report_schema_integrity: true,
    merge_heavy_useful: true,
    framework_not_scored_honest: true,
    heterogeneous_repository_count: 4,
    primary_language_ecosystem_count: 3,
    merge_heavy_repository: { commit_count: 200, merge_commit_count: 10 },
    large_repository: { supported_source_file_count: 10000, source_line_count: 0, commit_count: 0 },
    cache_incremental_runs: cacheRuns(),
    predictive_validation: predictiveValidation(),
  }));
  assert.equal(missingNumeric.promotion.gates.actionability_floor.status, "blocked");
  assert.equal(missingNumeric.promotion.status, "blocked");

  const shortfalls = {
    overall_floor: observations.slice(0, 1),
    measurement_floor: observations.filter((item) => item.criterion_id !== "measurement.revision_source_binding"),
    performance_floor: observations.filter((item) => item.criterion_id !== "performance.git_process_efficiency"),
    breadth_floor: observations.filter((item) => item.criterion_id !== "breadth.static_code"),
    predictive_floor: observations.filter((item) => !["predictive.transparent_formulation", "predictive.longitudinal_pipeline"].includes(item.criterion_id)),
  };
  for (const [gateId, reducedObservations] of Object.entries(shortfalls)) {
    assert.equal(scoreMaturity(bundle(root, reducedObservations, promotionEvidence)).promotion.gates[gateId].status, "blocked", gateId);
  }

  const nonnumericShortfalls = {
    report_schema_integrity: { report_schema_integrity: false },
    cache_incremental_useful: { cache_incremental_runs: cacheRunsWithMedianRegression() },
    framework_not_scored_honest: { framework_not_scored_honest: false },
    heterogeneous_repository_coverage: { heterogeneous_repository_count: 3 },
    merge_heavy_repository: { merge_heavy_useful: false },
    large_repository: { large_repository: { supported_source_file_count: 9999, source_line_count: 0, commit_count: 0 } },
    predictive_validation: { predictive_validation: { ...promotionEvidence.predictive_validation, leakage_detected: true } },
  };
  for (const [gateId, override] of Object.entries(nonnumericShortfalls)) {
    assert.equal(scoreMaturity(bundle(root, observations, { ...promotionEvidence, ...override })).promotion.gates[gateId].status, "blocked", gateId);
  }
});

test("promotion closes repeated-run and paired-bootstrap evidence instead of accepting caller success flags", (t) => {
  const root = evidenceRoot(t);
  const observations = rubric.categories.flatMap((category) => category.criteria.map((criterion) => observation(criterion.criterion_id, "temporal_holdout")));
  const promotionEvidence = {
    report_schema_integrity: true,
    merge_heavy_useful: true,
    framework_not_scored_honest: true,
    heterogeneous_repository_count: 4,
    primary_language_ecosystem_count: 3,
    merge_heavy_repository: { commit_count: 200, merge_commit_count: 10 },
    large_repository: { supported_source_file_count: 10000, source_line_count: 0, commit_count: 0 },
    cache_incremental_runs: cacheRuns(),
    predictive_validation: predictiveValidation(),
  };
  assert.equal(scoreMaturity(bundle(root, observations, promotionEvidence)).promotion.status, "pass");

  const insufficientPairs = cacheRuns();
  insufficientPairs.repositories[0].cold_warm_pairs.pop();
  assert.throws(() => scoreMaturity(bundle(root, observations, { ...promotionEvidence, cache_incremental_runs: insufficientPairs })), /FAIL-SEI-MATURITY/);
  const regression = cacheRunsWithMedianRegression();
  assert.equal(scoreMaturity(bundle(root, observations, { ...promotionEvidence, cache_incremental_runs: regression })).promotion.gates.cache_incremental_useful.status, "blocked");
  const misleadingSeparateMedians = cacheRunsWithMisleadingSeparateMedians();
  assert.equal(scoreMaturity(bundle(root, observations, { ...promotionEvidence, cache_incremental_runs: misleadingSeparateMedians })).promotion.gates.cache_incremental_useful.status, "blocked");
  assert.throws(() => scoreMaturity(bundle(root, observations, { ...promotionEvidence, cache_incremental_useful: true })), /FAIL-SEI-MATURITY/);

  const mismatchedHorizonCount = predictiveValidation();
  mismatchedHorizonCount.horizon_count = 3;
  assert.throws(() => scoreMaturity(bundle(root, observations, { ...promotionEvidence, predictive_validation: mismatchedHorizonCount })), /FAIL-SEI-MATURITY/);
  const missingBaseline = predictiveValidation();
  missingBaseline.horizons[0].baselines.pop();
  assert.throws(() => scoreMaturity(bundle(root, observations, { ...promotionEvidence, predictive_validation: missingBaseline })), /FAIL-SEI-MATURITY/);
  const wrongMethod = predictiveValidation();
  wrongMethod.horizons[0].paired_bootstrap_95_lower_confidence_bound.method = "unpaired_bootstrap";
  assert.throws(() => scoreMaturity(bundle(root, observations, { ...promotionEvidence, predictive_validation: wrongMethod })), /FAIL-SEI-MATURITY/);
  const wrongConfidenceLevel = predictiveValidation();
  wrongConfidenceLevel.horizons[0].paired_bootstrap_95_lower_confidence_bound.confidence_level = 0.9;
  assert.throws(() => scoreMaturity(bundle(root, observations, { ...promotionEvidence, predictive_validation: wrongConfidenceLevel })), /FAIL-SEI-MATURITY/);
});

test("unknown, duplicate, tampered, and unsafe evidence is rejected before a scorecard is emitted", (t) => {
  const root = evidenceRoot(t);
  const valid = observation("measurement.revision_source_binding");
  assert.throws(() => scoreMaturity(bundle(root, [{ ...valid, criterion_id: "unknown.criterion" }])), /FAIL-SEI-MATURITY/);
  assert.throws(() => scoreMaturity(bundle(root, [valid, { ...valid }])), /FAIL-SEI-MATURITY/);
  assert.throws(() => scoreMaturity(bundle(root, [{ ...valid, artifact_refs: [{ path: "receipt.txt", sha256: `sha256:${"0".repeat(64)}` }] }])), /FAIL-SEI-MATURITY/);
  assert.throws(() => scoreMaturity(bundle(root, [{ ...valid, artifact_refs: [{ ...valid.artifact_refs[0], path: "../receipt.txt" }] }])), /FAIL-SEI-MATURITY/);
  assert.throws(() => scoreMaturity({ ...bundle(root, [valid]), unexpected: true }), /FAIL-SEI-MATURITY/);
  assert.throws(() => scoreMaturity({ ...bundle(root, [valid]), sei_revision: "A".repeat(40) }), /FAIL-SEI-MATURITY/);
});

test("JSON scorecard data and Markdown render agree without emitting repository-health grades", (t) => {
  const scorecard = scoreFor("measurement.revision_source_binding", "focused_deterministic", t);
  const markdown = renderMaturityScorecardMarkdown(scorecard);
  assert.match(markdown, /Total points: 20\/1000/);
  assert.match(markdown, /Measurement: 20\/260/);
  assert.doesNotMatch(markdown, /health grade|candidate score|lifecycle status/i);
});

test("the public scorecard validator rejects noncanonical identities, arithmetic, and promotion records", (t) => {
  const scorecard = scoreFor("measurement.revision_source_binding", "focused_deterministic", t);
  assert.doesNotThrow(() => validateMaturityScorecard(scorecard));

  const malformed = [
    (value) => { value.categories[0].criteria[0].criterion_id = "measurement.not_the_rubric"; },
    (value) => { value.categories[0].category_id = "not_measurement"; },
    (value) => { value.categories[0].criteria.pop(); },
    (value) => { value.categories[0].criteria[0].maximum_points = 41; },
    (value) => { value.categories[0].criteria[0].points = 21; },
    (value) => { value.categories[0].points = 21; },
    (value) => { value.total_points = 21; },
    (value) => { value.promotion.gates.overall_floor = { gate_id: "arbitrary_gate", status: "pass" }; },
    (value) => { value.promotion.gates.cache_incremental_useful.status = "fail"; },
    (value) => { value.scorecard_id = "sei-maturity-v1-" + "0".repeat(64); },
  ];
  for (const mutate of malformed) {
    const copy = structuredClone(scorecard);
    mutate(copy);
    assert.throws(() => validateMaturityScorecard(copy), /FAIL-SEI-MATURITY/);
    assert.throws(() => renderMaturityScorecardMarkdown(copy), /FAIL-SEI-MATURITY/);
  }
});

test("the scorecard schema closes category, criterion, promotion, and gate records", () => {
  const schema = require("./maturity-scorecard.schema.json");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.category.additionalProperties, false);
  assert.equal(schema.$defs.criterion.additionalProperties, false);
  assert.equal(schema.$defs.promotion.additionalProperties, false);
  assert.equal(schema.$defs.gates.additionalProperties, false);
  assert.equal(schema.$defs.gate.additionalProperties, false);
  assert.equal(schema.$defs.gates.properties.cache_incremental_useful.$ref, "#/$defs/cache_incremental_useful_gate");
  assert.deepEqual(schema.$defs.gate.required, ["gate_id", "status"]);
  for (const category of rubric.categories) {
    const definition = schema.$defs[`${category.category_id}_category`];
    const criteria = definition.allOf[1].properties.criteria;
    assert.equal(criteria.minItems, category.criteria.length);
    assert.equal(criteria.maxItems, category.criteria.length);
    assert.equal(criteria.items, false);
    assert.deepEqual(criteria.prefixItems.map((criterion) => [criterion.properties.criterion_id.const, criterion.properties.maximum_points.const, criterion.properties.points.maximum]), category.criteria.map((criterion) => [criterion.criterion_id, criterion.maximum_points, criterion.maximum_points]));
  }
});
