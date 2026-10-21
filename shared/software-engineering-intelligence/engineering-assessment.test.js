"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { assessRepositoryEngineering, validateAssessment } = require("./engineering-assessment.js");
const assessmentPrivate = require("./engineering-assessment.js")[Symbol.for("sei.engineering-assessment.private.v1")];

const REVISION = "a".repeat(40);
const CONFIGURATION_HASH = "b".repeat(64);
const INDEX_DIGEST = `sha256:${"c".repeat(64)}`;

function metric(metric_id, value, { status = "measured", completeness = 1, confidence = 1 } = {}) {
  return {
    metric_id,
    value,
    measurement: { status, completeness, confidence, reason: status === "measured" ? null : "not collected" },
    source: { collector_id: metric_id.startsWith("verification.") || metric_id.startsWith("discovery.") ? "verification" : metric_id.startsWith("delivery.") ? "delivery" : "static", artifact_refs: ["artifact:assessment-fixture"] },
  };
}

function snapshot(measurements = []) {
  return {
    schema_version: "1.0.0",
    snapshot_id: `sei-${"d".repeat(61)}`,
    repository: {
      repository_id: "assessment-fixture",
      revision: REVISION,
      configuration_hash: CONFIGURATION_HASH,
    },
    measurements,
    collectors: [{ collector_id: "static", status: "available" }, { collector_id: "verification", status: "available" }, { collector_id: "delivery", status: "available" }],
    profiles: [],
  };
}

function repositoryIndex() {
  return {
    binding: { repository_revision: REVISION, index_digest: INDEX_DIGEST },
    entries: [],
    exclusions: [],
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function recomputeAssessmentId(assessment) {
  const { assessment_id, ...identity } = assessment;
  return `sha256:${crypto.createHash("sha256").update(stableStringify(identity)).digest("hex")}`;
}

function recomputeSemanticDigest(assessment) {
  const criteria = assessment.criteria.map((criterion) => ({
    criterion_id: criterion.criterion_id,
    score: criterion.score,
    coverage: criterion.coverage,
    maturity: criterion.maturity,
    synthesis: criterion.synthesis,
    evidence: (criterion.evidence?.observations ?? []).map((observation) => {
      const { source_metric_ids, evidence_refs, role, ...semantic } = observation;
      return semantic;
    }),
  }));
  return `sha256:${crypto.createHash("sha256").update(stableStringify({
    semantic_observation_version: assessment.observation_vocabulary_version,
    semantic_digest: assessment.observation_vocabulary_digest,
    criteria,
  })).digest("hex")}`;
}

test("assesses canonical evidence into a deterministic, evidence-bound sidecar without changing the snapshot", () => {
  const input = snapshot([
    metric("static.cyclomatic_complexity_p90", 3),
    metric("static.duplication.observed_percentage", 0.01),
    metric("verification.tests_total", 1),
    metric("verification.statement_coverage", 0.82),
    metric("discovery.ci_evidence_path_count", 1),
    metric("security.secret_findings", 0),
    metric("documentation.overview_present", 1),
  ]);

  const first = assessRepositoryEngineering({ snapshot: input, repositoryIndex: repositoryIndex() });
  const second = assessRepositoryEngineering({ snapshot: structuredClone(input), repositoryIndex: repositoryIndex() });

  assert.equal(first.schema_version, "sei.engineering-assessment@3");
  assert.equal(first.target_policy.schema_version, "sei.assessment-target-policy@1");
  assert.equal(first.overview.score_targets.acceptable, 70);
  assert.ok(first.criteria.every((criterion) => criterion.target && criterion.target.acceptable_score === 70));
  assert.equal(first.snapshot_binding.snapshot_id, input.snapshot_id);
  assert.equal(first.repository_index_binding.index_digest, INDEX_DIGEST);
  assert.equal(first.overview.dimension_count, 9);
  assert.equal(first.criteria.some((criterion) => criterion.score !== null), true);
  assert.deepEqual(first, second);
  assert.equal(first.assessment_id.startsWith("sha256:"), true);
  assert.deepEqual(input, snapshot([
    metric("static.cyclomatic_complexity_p90", 3),
    metric("static.duplication.observed_percentage", 0.01),
    metric("verification.tests_total", 1),
    metric("verification.statement_coverage", 0.82),
    metric("discovery.ci_evidence_path_count", 1),
    metric("security.secret_findings", 0),
    metric("documentation.overview_present", 1),
  ]));
});

test("keeps unknown evidence out of scoring and marks sparse evidence as not_scored", () => {
  const result = assessRepositoryEngineering({
    snapshot: snapshot([metric("unrelated.metric", 1)]),
    repositoryIndex: repositoryIndex(),
  });

  assert.equal(result.overview.score, null);
  assert.equal(result.overview.maturity, "not_scored");
  assert.equal(result.overview.coverage, 0);
  assert.equal(result.overview.confidence, "NOT_ESTABLISHED");
  assert.equal(result.criteria.every((criterion) => criterion.applicability === "not_scored"), true);
});

test("default rubric excludes external-provider-only criteria", () => {
  const result = assessRepositoryEngineering({ snapshot: snapshot(), repositoryIndex: repositoryIndex() });
  const retired = new Set(["delivery_feedback_flow", "flow_friction", "dependency_hygiene"]);

  assert.equal(result.criteria.length, 30);
  assert.equal(result.criteria.some((criterion) => retired.has(criterion.criterion_id)), false);
  assert.equal(result.coverage_accounting.criterion_total, 30);
  assert.equal(result.coverage_accounting.coverage_gate.required_criteria, 30);
  assert.equal(result.coverage_accounting.coverage_gate.denominator, 30);
  const accounting = result.coverage_accounting;
  assert.equal(
    accounting.established_count + accounting.provisional_count + accounting.not_scored_count + accounting.not_applicable_count,
    accounting.criterion_total,
  );
  assert.equal(accounting.not_scored_reasons.reduce((sum, reason) => sum + reason.criterion_count, 0), accounting.not_scored_count);
});

test("rejects duplicate criterion ownership and forged prior assessment bindings", () => {
  assert.throws(() => assessRepositoryEngineering({
    snapshot: snapshot(),
    repositoryIndex: repositoryIndex(),
    assessmentConfig: {
      rubric: {
        criteria: [
          { criterion_id: "complexity_concentration", dimension_id: "maintainability", weight: 1 },
          { criterion_id: "complexity_concentration", dimension_id: "architecture", weight: 1 },
        ],
      },
    },
  }), /FAIL-ASSESSMENT-RUBRIC: criterion complexity_concentration has duplicate ownership/);

  const legacyCompared = assessRepositoryEngineering({
    snapshot: snapshot(),
    repositoryIndex: repositoryIndex(),
    priorAssessment: {
      schema_version: "sei.engineering-assessment@1",
      assessment_id: `sha256:${"e".repeat(64)}`,
      snapshot_binding: { snapshot_id: "sei-other", repository_revision: REVISION, configuration_hash: CONFIGURATION_HASH },
      repository_index_binding: { repository_revision: REVISION, index_digest: INDEX_DIGEST },
      rubric: { digest: "sha256:forged" },
      standard: { digest: "sha256:forged" },
      applicability: { digest: "sha256:forged" },
    },
  });
  assert.equal(legacyCompared.trajectory.state, "methodology-changed");
});

test("does not turn unavailable DORA performance evidence into a delivery failure", () => {
  const result = assessRepositoryEngineering({
    snapshot: snapshot([metric("discovery.ci_evidence_path_count", 1)]),
    repositoryIndex: repositoryIndex(),
  });
  const dora = result.framework_lenses.find((lens) => lens.lens_id === "DORA");

  assert.equal(dora.status, "not_scored");
  assert.equal(dora.reason.includes("deployment"), true);
});

test("retired external-provider criteria are absent from the default assessment", () => {
  const result = assessRepositoryEngineering({ snapshot: snapshot(), repositoryIndex: repositoryIndex() });
  const retired = new Set(["delivery_feedback_flow", "flow_friction", "dependency_hygiene"]);
  assert.deepEqual(result.criteria.filter((criterion) => retired.has(criterion.criterion_id)), []);
});

test("brands only canonical, snapshot-bound assessment sidecars for downstream consumers", () => {
  const current = snapshot([metric("documentation.overview_present", 1)]);
  const assessment = assessRepositoryEngineering({ snapshot: current, repositoryIndex: repositoryIndex() });
  const binding = assessmentPrivate.bindAssessment(assessment, current);

  assert.equal(validateAssessment(assessment).ok, true);
  assert.equal(assessmentPrivate.readBoundAssessment(binding).assessment_id, assessment.assessment_id);
  assert.throws(() => assessmentPrivate.bindAssessment({ ...assessment, overview: { ...assessment.overview, coverage: 0.9 } }, current), /FAIL-ASSESSMENT-IDENTITY/);
  assert.throws(() => assessmentPrivate.bindAssessment(assessment, { ...current, snapshot_id: "sei-other" }), /does not bind|canonical semantic evidence/);
});

test("rejects forged observation provenance even when the assessment identity is recomputed", () => {
  const current = snapshot([metric("static.python.cyclomatic_complexity_p90:production", 7)]);
  const assessment = assessRepositoryEngineering({ snapshot: current, repositoryIndex: repositoryIndex() });
  const forged = structuredClone(assessment);
  const observed = forged.criteria.flatMap((criterion) => criterion.evidence.observations)[0];
  assert.ok(observed);
  observed.source_metric_ids = ["forged.metric"];
  observed.evidence_refs = ["evidence:forged"];
  forged.assessment_id = recomputeAssessmentId(forged);
  assert.equal(validateAssessment(forged).ok, true, "shape and identity remain valid before snapshot binding");
  assert.throws(() => assessmentPrivate.bindAssessment(forged, current), /unknown metric|unbound evidence/);
});

test("rejects forged semantic observations even when raw refs and assessment digests are recomputed", () => {
  const current = snapshot([metric("static.python.cyclomatic_complexity_p90:production", 7)]);
  const assessment = assessRepositoryEngineering({ snapshot: current, repositoryIndex: repositoryIndex() });
  const forged = structuredClone(assessment);
  const observed = forged.criteria.flatMap((criterion) => criterion.evidence.observations)[0];
  assert.ok(observed);
  observed.observation_id = "engineering.fake.observation";
  observed.value = 999;
  forged.semantic_digest = recomputeSemanticDigest(forged);
  forged.assessment_id = recomputeAssessmentId(forged);
  assert.throws(() => assessmentPrivate.bindAssessment(forged, current), /canonical semantic evidence|canonical semantic vocabulary/);
});

test("compares only prior sidecars with the same rubric, standard, applicability, and repository configuration", () => {
  const current = snapshot([metric("documentation.overview_present", 1)]);
  const prior = assessRepositoryEngineering({ snapshot: current, repositoryIndex: repositoryIndex() });
  const compared = assessRepositoryEngineering({ snapshot: current, repositoryIndex: repositoryIndex(), priorAssessment: prior });

  assert.equal(compared.trajectory.state, "comparable");
  assert.equal(compared.trajectory.prior_assessment_id, prior.assessment_id);
});

test("target-policy drift makes assessment trajectories methodology-incompatible", () => {
  const current = snapshot([metric("static.python.cyclomatic_complexity_p90:production", 3)]);
  const prior = assessRepositoryEngineering({ snapshot: current, repositoryIndex: repositoryIndex() });
  const changed = assessRepositoryEngineering({
    snapshot: current,
    repositoryIndex: repositoryIndex(),
    priorAssessment: prior,
    assessmentConfig: {
      target_policy: {
        targets: {
          complexity_concentration: {
            observations: [{
              observation_id: "engineering.complexity.production.p90",
              direction: "at_or_below",
              acceptable_value: 4,
              concern_value: 18,
              unit: "complexity-points",
            }],
          },
        },
      },
    },
  });
  assert.equal(changed.target_policy.source.kind, "explicit_config");
  assert.equal(changed.trajectory.state, "methodology-changed");
});

test("rejects numeric scores for not_scored assessments and preserves semantic digest independence from raw IDs", () => {
  const current = snapshot([metric("static.python.cyclomatic_complexity_p90:production", 3)]);
  const assessment = assessRepositoryEngineering({ snapshot: current, repositoryIndex: repositoryIndex() });
  const forged = structuredClone(assessment);
  forged.overview.score = 42;
  assert.equal(validateAssessment(forged).ok, false);
  const renamed = structuredClone(current);
  renamed.measurements[0].metric_id = "static.python.cyclomatic.p90:production";
  const renamedAssessment = assessRepositoryEngineering({ snapshot: renamed, repositoryIndex: repositoryIndex() });
  assert.equal(renamedAssessment.semantic_digest, assessment.semantic_digest);

  const forgedAccounting = structuredClone(assessment);
  forgedAccounting.coverage_accounting.not_scored_reasons[0].criterion_count += 1;
  forgedAccounting.assessment_id = recomputeAssessmentId(forgedAccounting);
  assert.equal(validateAssessment(forgedAccounting).ok, false);
  assert.match(validateAssessment(forgedAccounting).errors.join("\n"), /coverage accounting does not reconcile/);
});

test("accepts a trusted enriched evidence profile at the 90 percent criterion gate", () => {
  const enriched = [
    ["assessment.failure_explicitness", 0.82],
    ["assessment.delivery.release_configuration", 1],
    ["assessment.delivery.reproducibility_inputs", 1],
    ["assessment.reliability.failure_handling", 0.78],
    ["assessment.reliability.operational_readiness", 0.75],
    ["assessment.reliability.recovery_evidence", 1],
    ["assessment.reliability.observability", 0.8],
    ["assessment.security.secret_findings", 0],
    ["assessment.security.verification", 1],
    ["assessment.developer.local_feedback", 1],
    ["assessment.developer.configuration_ergonomics", 0.8],
    ["assessment.documentation.repository_overview", 1],
    ["assessment.documentation.contracts_and_runbooks", 0.8],
    ["assessment.documentation.change_context", 0.75],
    ["assessment.documentation.onboarding_discoverability", 1],
    ["assessment.verification.change_verification", 0.9],
  ].map(([id, value]) => metric(id, value));
  const result = assessRepositoryEngineering({
    snapshot: snapshot([
      metric("static.cyclomatic_complexity_p90", 3),
      metric("static.cyclomatic_complexity_max", 12),
      metric("static.python.parsed_file_count:production", 20),
      metric("static.python.file_count:production", 20),
      metric("static.duplication.observed_percentage", 0.04),
      metric("static.duplication.large_clone_family_count", 2),
      metric("git.observed_text_churn", 40),
      metric("git.change_frequency", 12),
      metric("git.observed_touch_ownership_concentration", 0.3),
      metric("git.observed_co_change_pair_count", 3),
      metric("dependency.node_count", 20),
      metric("dependency.cyclic_node_count", 1),
      metric("dependency.cyclic_scc_count", 1),
      metric("dependency.centrality", 0.25),
      metric("dependency.instability", 0.2),
      metric("dependency.fan_in", 3),
      metric("verification.tests_total", 100),
      metric("verification.tests_passed", 98),
      metric("verification.statement_coverage", 0.84),
      metric("discovery.test_evidence_path_count", 4),
      metric("discovery.ci_evidence_path_count", 1),
      ...enriched,
    ]),
    repositoryIndex: repositoryIndex(),
    assessmentConfig: { coverage_gate: { required_criteria: 30, denominator: 30 } },
  });
  const accounting = result.coverage_accounting;
  assert.equal(accounting.criterion_total, 30);
  assert.equal(accounting.mapping_failure_count, 0);
  assert.equal(accounting.established_count + accounting.provisional_count, 30, JSON.stringify({ counts: accounting, notScored: result.criteria.filter((criterion) => criterion.applicability === "not_scored").map((criterion) => criterion.criterion_id) }));
  assert.equal(accounting.assessed_criterion_rate, 1);
  assert.equal(accounting.coverage_gate.status, "passed");
  assert.equal(accounting.not_scored_count + accounting.not_applicable_count, 0);
  assert.equal(result.dimensions.filter((dimension) => dimension.maturity === "not_scored").length, 0);
});

test("does not fake a 90 percent result when the explicit gate is not met", () => {
  assert.throws(() => assessRepositoryEngineering({
    snapshot: snapshot([metric("static.cyclomatic_complexity_p90", 3)]),
    repositoryIndex: repositoryIndex(),
    assessmentConfig: { coverage_gate: { required_criteria: 30, denominator: 30, enforce: true } },
  }), /FAIL-ASSESSMENT-COVERAGE-GATE/);
});

test("evaluateCoverageGate re-gates a persisted assessment against the current profile with the fresh-path error", () => {
  const evidence = snapshot([metric("static.cyclomatic_complexity_p90", 3)]);
  const lenient = assessRepositoryEngineering({ snapshot: evidence, repositoryIndex: repositoryIndex() });
  const assessed = lenient.coverage_accounting.established_count + lenient.coverage_accounting.provisional_count;
  assert.ok(assessed < 30, "fixture must under-cover the rubric");

  // Same result as the gate recorded at assessment time when the profile is unchanged.
  const unchanged = assessmentPrivate.evaluateCoverageGate(lenient, undefined);
  assert.equal(unchanged.passed, lenient.coverage_accounting.coverage_gate.status === "passed");
  assert.equal(unchanged.gate.enforce, false);
  assert.equal(assessmentPrivate.enforceCoverageGate(unchanged), unchanged);

  // A stricter enforcing profile applied to the SAME persisted assessment fails
  // closed with exactly the message the fresh path raises.
  const strict = { coverage_gate: { required_criteria: 30, denominator: 30, enforce: true } };
  const evaluation = assessmentPrivate.evaluateCoverageGate(lenient, strict);
  assert.equal(evaluation.passed, false);
  let replayError;
  try { assessmentPrivate.enforceCoverageGate(evaluation); } catch (error) { replayError = error; }
  let freshError;
  try { assessRepositoryEngineering({ snapshot: evidence, repositoryIndex: repositoryIndex(), assessmentConfig: strict }); } catch (error) { freshError = error; }
  assert.ok(replayError instanceof Error && freshError instanceof Error);
  assert.equal(replayError.message, freshError.message);
  assert.match(replayError.message, new RegExp(`^FAIL-ASSESSMENT-COVERAGE-GATE: assessed ${assessed}/30 criteria; required 30$`));

  // A met gate never throws, even when enforced.
  const met = assessmentPrivate.evaluateCoverageGate(lenient, { coverage_gate: { required_criteria: assessed, denominator: 30, enforce: true } });
  assert.equal(met.passed, true);
  assessmentPrivate.enforceCoverageGate(met);

  // Missing accounting (legacy or tampered document) fails closed rather than passing.
  assert.throws(() => assessmentPrivate.evaluateCoverageGate({ coverage_accounting: null }, strict), /FAIL-ASSESSMENT-COVERAGE-GATE: assessment coverage accounting is unavailable/);
});
