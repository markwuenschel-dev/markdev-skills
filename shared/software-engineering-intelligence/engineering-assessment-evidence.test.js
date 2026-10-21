"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const evidence = require("./engineering-assessment-evidence.js");

function collector(collector_id, status = "available", reason = null) {
  return { collector_id, collector_version: "1.0.0", status, reason };
}

function metric(metric_id, value, collector_id, options = {}) {
  return {
    metric_id,
    ...(options.definition_id ? { definition_id: options.definition_id } : {}),
    value,
    measurement: {
      status: options.status ?? "measured",
      completeness: options.completeness ?? 1,
      confidence: options.confidence ?? 1,
    },
    source: {
      collector_id,
      collector_version: "1.0.0",
      artifact_refs: options.artifact_refs ?? [`artifact:${metric_id}`],
      evidence_refs: options.evidence_refs ?? [`evidence:${metric_id}`],
    },
    scope: { kind: "repository", path: ".", language: options.language ?? null, generated_code: false },
  };
}

function snapshot(measurements, collectors = []) {
  return { collectors, measurements };
}

function observation(index, observation_id) {
  const record = index.observations.find((candidate) => candidate.observation_id === observation_id);
  assert.ok(record, `missing observation ${observation_id}`);
  return record;
}

test("semantic evidence index uses canonical producer IDs and never guessed aliases", () => {
  const index = evidence.deriveSemanticEvidenceIndex(snapshot([
    metric("static.python.cyclomatic_complexity_p90:production", 17, "python-static-intelligence"),
    metric("static.cyclomatic_complexity.p90", 99, "python-static-intelligence"),
  ], [collector("python-static-intelligence")]));

  const p90 = observation(index, "engineering.complexity.production.p90");
  assert.equal(p90.value, 17);
  assert.deepEqual(p90.source_metric_ids, ["static.python.cyclomatic_complexity_p90:production"]);
  assert.ok(p90.evidence_refs.length > 0);
  assert.equal(index.semantic_observation_version, "sei.engineering-observation@1");
});

test("partial duplication stays an observed lower bound with canonical provenance", () => {
  const index = evidence.deriveSemanticEvidenceIndex(snapshot([
    metric("static.duplication.observed_percentage", 0.125, "structural-duplication-intelligence", {
      completeness: 0.4,
      confidence: 0.9,
    }),
    metric("static.duplication.analyzed_source_lines", 2300, "structural-duplication-intelligence", {
      completeness: 0.4,
      confidence: 0.9,
    }),
    metric("static.duplication.clone_family_count", 8, "structural-duplication-intelligence", {
      completeness: 0.4,
      confidence: 0.9,
    }),
  ], [collector("structural-duplication-intelligence", "degraded", "FAIL-DUPLICATION-RESOURCE-LIMIT: limit") ]));

  const ratio = observation(index, "engineering.duplication.observed_ratio");
  assert.equal(ratio.value, 0.125);
  assert.equal(ratio.unit, "ratio");
  assert.equal(ratio.state, "partial");
  assert.equal(ratio.context.lower_bound, true);
  assert.equal(ratio.coverage, 0.4);
  assert.ok(ratio.evidence_refs.length > 0);
});

test("raw producer renames preserve semantic observations and semantic digest", () => {
  const oldIndex = evidence.deriveSemanticEvidenceIndex(snapshot([
    metric("static.python.cyclomatic_complexity_p90:production", 11, "python-static-intelligence"),
  ], [collector("python-static-intelligence")]));
  const renamedIndex = evidence.deriveSemanticEvidenceIndex(snapshot([
    metric("static.python.cyclomatic.p90:production", 11, "python-static-intelligence"),
  ], [collector("python-static-intelligence")]));

  const oldObservation = observation(oldIndex, "engineering.complexity.production.p90");
  const renamedObservation = observation(renamedIndex, "engineering.complexity.production.p90");
  assert.deepEqual(
    { ...oldObservation, source_metric_ids: [], evidence_refs: [] },
    { ...renamedObservation, source_metric_ids: [], evidence_refs: [] },
  );
  assert.equal(oldIndex.semantic_digest, renamedIndex.semantic_digest);
  assert.notDeepEqual(oldObservation.source_metric_ids, renamedObservation.source_metric_ids);
});

test("arbitrary producer rename binds by the canonical definition while guessed IDs remain unmapped", () => {
  const renamedIndex = evidence.deriveSemanticEvidenceIndex(snapshot([
    metric("producer.v2.tail_complexity", 11, "python-static-intelligence", {
      definition_id: "sei.static.python.cyclomatic_complexity_p90@1",
    }),
    metric("static.cyclomatic_complexity.p90", 99, "python-static-intelligence"),
  ], [collector("python-static-intelligence")]));

  const p90 = observation(renamedIndex, "engineering.complexity.production.p90");
  assert.equal(p90.value, 11);
  assert.deepEqual(p90.source_metric_ids, ["producer.v2.tail_complexity"]);
  assert.equal(renamedIndex.mapping_debt.count, 1);
  assert.deepEqual(renamedIndex.mapping_debt.metric_ids, ["static.cyclomatic_complexity.p90"]);
});

test("canonical-family metrics that have no semantic recipe are reported as mapping debt", () => {
  const index = evidence.deriveSemanticEvidenceIndex(snapshot([
    metric("verification.tests_skipped", 3, "verification-summary", {
      definition_id: "sei.adapter.verification.tests_skipped@1",
    }),
  ], [collector("verification-summary")]));

  assert.equal(index.mapping_debt.count, 1);
  assert.deepEqual(index.mapping_debt.metric_ids, ["verification.tests_skipped"]);
  assert.equal(index.mapping_debt.entries[0].reason, "unmapped-assessable-metric");
});

test("semantic observations retain canonical snapshot binding context", () => {
  const index = evidence.deriveSemanticEvidenceIndex({
    snapshot_id: "sei-snapshot-1",
    repository: { repository_id: "repo-1", revision: "a".repeat(40), configuration_hash: "b".repeat(64) },
    measurements: [metric("static.source_file_count", 4, "static-source")],
    collectors: [collector("static-source")],
  });
  const source = observation(index, "engineering.source_inventory.human_file_count");
  assert.deepEqual(source.context.binding, {
    repository_id: "repo-1",
    repository_revision: "a".repeat(40),
    snapshot_id: "sei-snapshot-1",
  });
});

test("topology, Git, verification, and typed adapters emit only referenced semantic observations", () => {
  const index = evidence.deriveSemanticEvidenceIndex(snapshot([
    metric("static.python.dependency.cyclic_scc_count:production", 2, "python-static-intelligence", { language: "python" }),
    metric("git.observed_text_churn", 640, "git-history"),
    metric("git.observed_touch_ownership_concentration", 0.72, "git-history"),
    metric("git.observed_co_change_pair_count", 31, "git-history"),
    metric("verification.tests_total", 120, "verification-summary"),
    metric("verification.tests_passed", 118, "verification-summary"),
    metric("verification.tests_failed", 2, "verification-summary"),
    metric("discovery.test_evidence_path_count", 3, "test-discovery"),
    metric("verification.statement_coverage", 0.81, "verification-summary"),
    metric("discovery.coverage_evidence_path_count", 1, "coverage-discovery"),
    metric("discovery.ci_evidence_path_count", 2, "ci-discovery"),
    metric("kanban.cycle_time", 86400000, "work-item-adapter"),
    metric("flow.first_review_p50_ms", 3600000, "pr-flow"),
    metric("dora.deployment_frequency", 4, "deployment-events"),
  ], [
    collector("python-static-intelligence"), collector("git-history"), collector("verification-summary"),
    collector("test-discovery"), collector("coverage-discovery"), collector("ci-discovery"),
    collector("work-item-adapter"), collector("pr-flow"), collector("deployment-events"),
  ]));

  assert.equal(observation(index, "engineering.dependency.cycle_pressure").value, 2);
  assert.equal(observation(index, "engineering.git.observed_churn").value, 640);
  assert.equal(observation(index, "engineering.verification.test_execution").value, 120);
  assert.equal(observation(index, "engineering.verification.test_configuration").value, 3);
  assert.equal(observation(index, "engineering.verification.coverage_configuration").value, 1);
  assert.equal(observation(index, "engineering.delivery.ci_configuration").value, 2);
  assert.equal(observation(index, "engineering.work_item.cycle_time").value, 86400000);
  assert.equal(observation(index, "engineering.pr.review_latency").value, 3600000);
  assert.equal(observation(index, "engineering.delivery.deployment_frequency").value, 4);
  for (const record of index.observations) {
    assert.ok(record.evidence_refs.length > 0, `${record.observation_id} has evidence refs`);
    assert.ok(record.source_metric_ids.length > 0, `${record.observation_id} has source metric IDs`);
  }
});

test("CQR-shaped canonical producer evidence reaches the production recipes", () => {
  const index = evidence.deriveSemanticEvidenceIndex(snapshot([
    metric("static.python.cyclomatic_complexity_p90:production", 14, "python-static-intelligence"),
    metric("static.python.cyclomatic_complexity_max:production", 48, "python-static-intelligence"),
    metric("static.python.parsed_file_count:production", 184, "python-static-intelligence", { completeness: 0.92, confidence: 0.92 }),
    metric("static.python.file_count:production", 200, "python-static-intelligence", { completeness: 1, confidence: 1 }),
    metric("static.python.dependency.cyclic_node_count:production", 12, "python-static-intelligence"),
    metric("static.python.dependency.node_count:production", 200, "python-static-intelligence"),
    metric("static.python.dependency.cyclic_scc_count:production", 3, "python-static-intelligence"),
    metric("static.python.dependency.fan_in_max:production", 26, "python-static-intelligence"),
    metric("git.observed_text_churn", 8120, "git-history", { completeness: 0.88, confidence: 0.88 }),
    metric("git.observed_touch_ownership_concentration", 0.71, "git-history"),
    metric("git.observed_co_change_pair_count", 19, "git-history"),
    // A tempting but non-canonical spelling must not enter the index.
    metric("static.python.cyclomatic_complexity.p90:production", 999, "python-static-intelligence"),
  ], [collector("python-static-intelligence"), collector("git-history")]));

  assert.equal(observation(index, "engineering.complexity.production.p90").value, 14);
  assert.equal(observation(index, "engineering.complexity.production.max").value, 48);
  assert.equal(observation(index, "engineering.complexity.production.coverage").value, 0.92);
  assert.equal(observation(index, "engineering.dependency.scc_concentration").value, 0.06);
  assert.equal(observation(index, "engineering.dependency.boundary_pressure").value, 26);
  assert.equal(observation(index, "engineering.git.observed_churn").value, 8120);
  assert.equal(observation(index, "engineering.complexity.production.p90").source_metric_ids.includes("static.python.cyclomatic_complexity.p90:production"), false);
});

test("snapshot binding changes do not change the semantic vocabulary digest", () => {
  const measurements = [metric("static.source_file_count", 4, "static-source")];
  const first = evidence.deriveSemanticEvidenceIndex({
    snapshot_id: "sei-snapshot-one",
    repository: { repository_id: "repo-1", revision: "a".repeat(40) },
    measurements,
    collectors: [collector("static-source")],
  });
  const second = evidence.deriveSemanticEvidenceIndex({
    snapshot_id: "sei-snapshot-two",
    repository: { repository_id: "repo-1", revision: "a".repeat(40) },
    measurements,
    collectors: [collector("static-source")],
  });
  assert.equal(first.semantic_digest, second.semantic_digest);
  assert.notDeepEqual(
    observation(first, "engineering.source_inventory.human_file_count").context.binding,
    observation(second, "engineering.source_inventory.human_file_count").context.binding,
  );
});

test("runtime verification duration remains evidence but not semantic digest identity", () => {
  const base = {
    collectors: [collector("verification-summary")],
    measurements: [
      metric("verification.autonomous_duration_ms", 100, "verification-summary"),
      metric("verification.autonomous_tests_total", 4, "verification-summary"),
    ],
  };
  const slower = structuredClone(base);
  slower.measurements[0].value = 900;
  const first = evidence.deriveSemanticEvidenceIndex(base);
  const second = evidence.deriveSemanticEvidenceIndex(slower);
  assert.equal(first.semantic_digest, second.semantic_digest);
  assert.notEqual(
    observation(first, "engineering.verification.duration").value,
    observation(second, "engineering.verification.duration").value,
  );
});

test("trusted assessment facts and repository documentation presence share the semantic index", () => {
  const index = evidence.deriveSemanticEvidenceIndex({
    snapshot_id: "sei-docs",
    repository: { repository_id: "repo", revision: "a".repeat(40), configuration_hash: "b".repeat(64) },
    measurements: [
      metric("assessment.reliability.failure_handling", 0.8, "assessment-evidence", { definition_id: "sei.assessment.reliability.failure_handling@1" }),
      metric("assessment.security.verification", true, "assessment-evidence", { definition_id: "sei.assessment.security.verification@1" }),
      metric("git.age_days:README.md", 3, "git-history"),
      metric("git.age_days:RUNBOOK.md", 8, "git-history"),
      metric("assessment.unknown", 1, "assessment-evidence"),
    ],
    collectors: [collector("assessment-evidence"), collector("git-history")],
  });
  assert.equal(observation(index, "engineering.reliability.failure_handling").value, 0.8);
  assert.equal(observation(index, "engineering.security.verification").value, true);
  assert.equal(observation(index, "engineering.documentation.repository_overview").value, 1);
  assert.equal(observation(index, "engineering.documentation.contracts_and_runbooks").value, 1);
  assert.equal(index.mapping_debt.mapping_failure_count, 1);
  assert.deepEqual(index.mapping_debt.metric_ids, ["assessment.unknown"]);
});
