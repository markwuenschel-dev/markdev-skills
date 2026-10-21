"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { collectAdapterEvidence } = require("./evidence-adapters.js");
const fixtures = require("./adapter-fixtures.js");
const canonicalSnapshot = require("./canonical-intelligence.json");
const { materializeSnapshot } = require("./intelligence-engine.js");

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const CONFIGURATION_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HISTORY_WINDOW = {
  kind: "revision-range",
  start: "fedcba9876543210fedcba9876543210fedcba98",
  end: REVISION,
};

function input(overrides = {}) {
  return {
    repository_revision: REVISION,
    configuration_hash: CONFIGURATION_HASH,
    history_window: HISTORY_WINDOW,
    adapters: [],
    ...overrides,
  };
}

function appendToSnapshot(adapterEvidence) {
  const snapshot = structuredClone(canonicalSnapshot);
  snapshot.collectors.push(...adapterEvidence.collectors);
  snapshot.measurements.push(...adapterEvidence.metrics);
  snapshot.evidence_summary.measurement_count = snapshot.measurements.length;
  snapshot.evidence_summary.status_counts = Object.fromEntries(
    Object.keys(snapshot.evidence_summary.status_counts).map((status) => [
      status,
      snapshot.measurements.filter((metric) => metric.measurement.status === status).length,
    ]),
  );
  return snapshot;
}

function metric(result, metricId) {
  const found = result.metrics.find((candidate) => candidate.metric_id === metricId);
  assert.ok(found, `expected ${metricId}`);
  return found;
}

function assertTypedDoraFailsClosed(adapter, label) {
  const result = collectAdapterEvidence(fixtures.adapterInput([adapter]));
  const collector = result.collectors.find((candidate) => candidate.collector_id === "dora-deployment-evidence");
  assert.equal(collector.status, "degraded", `${label}: relationally broken typed deployment evidence cannot be available`);
  for (const candidate of result.metrics.filter((entry) => entry.metric_id.startsWith("dora."))) {
    assert.equal(candidate.value, null, `${label}: ${candidate.metric_id} must not retain a partial DORA fact`);
    assert.equal(candidate.measurement.status, "unverifiable", `${label}: ${candidate.metric_id} must fail closed`);
    assert.match(candidate.measurement.reason, /FAIL-ADAPTER-(?:MALFORMED|FOREIGN-|DUPLICATE)/, `${label}: failure reason must remain attributable`);
  }
  return result;
}

test("missing adapters emit declared unavailable M2 measurement slots without inventing evidence", () => {
  const result = collectAdapterEvidence(input());

  assert.deepEqual(result.collectors.map((collector) => [collector.collector_id, collector.status]), [
    ["assessment-evidence", "unavailable"],
    ["dependency-topology", "unavailable"],
    ["deployment-events", "unavailable"],
    ["dora-deployment-evidence", "unavailable"],
    ["feedback-timing", "unavailable"],
    ["kanban-work-item-flow", "unavailable"],
    ["pr-flow", "unavailable"],
    ["verification-summary", "unavailable"],
  ]);
  assert.ok(result.metrics.some((metric) => metric.metric_id === "dependency.scc_count"));
  assert.ok(result.metrics.some((metric) => metric.metric_id === "verification.statement_coverage"));
  assert.ok(result.metrics.some((metric) => metric.metric_id === "feedback.first_response_p95_ms"));
  assert.ok(result.metrics.some((metric) => metric.metric_id === "flow.pr_cycle_p90_ms"));
  assert.ok(result.metrics.some((metric) => metric.metric_id === "deployment.succeeded_count"));
  assert.ok(result.metrics.some((metric) => metric.metric_id === "dora.change_lead_time"));
  assert.ok(result.metrics.some((metric) => metric.metric_id === "kanban.definition_of_workflow"));
  for (const metric of result.metrics) {
    assert.equal(metric.value, null, `${metric.metric_id} must not become zero`);
    assert.equal(metric.measurement.status, "unavailable", `${metric.metric_id} must remain unavailable`);
    assert.match(metric.measurement.reason, /FAIL-ADAPTER-MISSING/);
    assert.equal(metric.repository_revision, REVISION);
    assert.equal(metric.source.repository_revision, REVISION);
    assert.equal(metric.comparability.configuration_hash, CONFIGURATION_HASH);
  }

  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));
});

test("typed dependency topology derives deterministic SCC, cycle, fan, density, and declared centrality facts", () => {
  const adapter = fixtures.dependencyTopologyAdapter();
  const result = collectAdapterEvidence(fixtures.adapterInput([adapter]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "dependency-topology").status, "available");
  assert.equal(metric(result, "dependency.node_count").value, 4);
  assert.equal(metric(result, "dependency.edge_count").value, 4);
  assert.equal(metric(result, "dependency.scc_count").value, 2);
  assert.equal(metric(result, "dependency.cyclic_scc_count").value, 1);
  assert.equal(metric(result, "dependency.cyclic_node_count").value, 3);
  assert.equal(metric(result, "dependency.fan_in").value, 2);
  assert.equal(metric(result, "dependency.fan_out").value, 1);
  assert.equal(metric(result, "dependency.density").value, 0.333333);
  assert.equal(metric(result, "dependency.centrality").value, 1);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));

  const reordered = structuredClone(adapter);
  reordered.payload.nodes.reverse();
  reordered.payload.edges.reverse();
  reordered.payload.centrality.reverse();
  const reorderedResult = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(reordered)]));
  assert.deepEqual(reorderedResult, result);
});

test("self-loops remain cycle evidence but cannot inflate directed graph density above one", () => {
  const adapter = fixtures.dependencyTopologyAdapter();
  adapter.payload = {
    nodes: [{ id: "src/a.js" }, { id: "src/b.js" }],
    edges: [
      { source: "src/a.js", target: "src/a.js" },
      { source: "src/a.js", target: "src/b.js" },
      { source: "src/b.js", target: "src/a.js" },
    ],
    centrality: [{ node: "src/a.js", value: 1 }, { node: "src/b.js", value: 0.5 }],
  };
  const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(adapter)]));

  assert.equal(metric(result, "dependency.edge_count").value, 3);
  assert.equal(metric(result, "dependency.cyclic_scc_count").value, 1);
  assert.equal(metric(result, "dependency.fan_in").value, 1);
  assert.equal(metric(result, "dependency.fan_out").value, 1);
  assert.equal(metric(result, "dependency.density").value, 1);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));
});

test("typed artifact hashes use code-unit-stable ordering rather than a host locale", () => {
  const adapter = fixtures.dependencyTopologyAdapter();
  adapter.payload = {
    nodes: [{ id: "z" }, { id: "ä" }],
    edges: [{ source: "z", target: "ä" }],
    centrality: [{ node: "z", value: 1 }, { node: "ä", value: 0.5 }],
  };
  const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(adapter)]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "dependency-topology").status, "available");
  assert.equal(metric(result, "dependency.density").value, 0.5);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));
});

test("normalized JUnit evidence emits only declared test and coverage facts without network access", () => {
  const adapter = fixtures.verificationSummaryAdapter();
  const result = collectAdapterEvidence(fixtures.adapterInput([adapter]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "verification-summary").status, "available");
  assert.equal(metric(result, "verification.tests_total").value, 10);
  assert.equal(metric(result, "verification.tests_passed").value, 8);
  assert.equal(metric(result, "verification.tests_failed").value, 2);
  assert.equal(metric(result, "verification.duration_ms").value, 1234);
  assert.equal(metric(result, "verification.statement_coverage").value, 0.8);
  assert.equal(metric(result, "verification.branch_coverage").value, 0.75);
  assert.deepEqual(metric(result, "verification.statement_coverage").source.artifact_refs, [adapter.artifact_ref]);
  assert.deepEqual(metric(result, "verification.statement_coverage").source.evidence_refs, [adapter.artifact_ref, adapter.artifact_sha256]);
  assert.equal(result.metrics.some((candidate) => /(?:mutation|quality|score)/.test(candidate.metric_id)), false);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));

  const hadFetch = Object.hasOwn(globalThis, "fetch");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network access is forbidden in adapter collection"); };
  try {
    assert.doesNotThrow(() => collectAdapterEvidence(fixtures.adapterInput([adapter])));
  } finally {
    if (hadFetch) globalThis.fetch = originalFetch;
    else delete globalThis.fetch;
  }

  for (const format of ["lcov-summary-v1", "cobertura-summary-v1", "coverage-py-summary-v1", "jacoco-summary-v1"]) {
    const normalized = fixtures.verificationSummaryAdapter();
    normalized.format = format;
    const output = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(normalized)]));
    assert.equal(output.collectors.find((collector) => collector.collector_id === "verification-summary").status, "available", format);
    assert.equal(metric(output, "verification.statement_coverage").value, 0.8, format);
  }
});

test("assessment evidence adapter emits only bound declared semantic support facts", () => {
  const adapter = fixtures.assessmentEvidenceAdapter();
  const result = collectAdapterEvidence(fixtures.adapterInput([adapter]));
  const collector = result.collectors.find((candidate) => candidate.collector_id === "assessment-evidence");
  assert.equal(collector.status, "degraded", "partial adapter output is explicit because undeclared facts remain unavailable");
  assert.equal(metric(result, "assessment.reliability.failure_handling").value, 0.8);
  assert.equal(metric(result, "assessment.security.verification").value, true);
  assert.equal(metric(result, "assessment.developer.flow_friction").value, 2);
  assert.equal(metric(result, "assessment.reliability.operational_readiness").measurement.status, "unavailable");
  const malformed = collectAdapterEvidence(fixtures.adapterInput([{
    ...adapter,
    payload: { facts: [{ metric_id: "assessment.not_declared", value: 1 }] },
    artifact_sha256: fixtures.payloadDigest({ facts: [{ metric_id: "assessment.not_declared", value: 1 }] }),
  }]));
  assert.equal(malformed.collectors.find((candidate) => candidate.collector_id === "assessment-evidence").status, "degraded");
  assert.match(metric(malformed, "assessment.reliability.failure_handling").measurement.reason, /FAIL-ADAPTER-MALFORMED/);
});

test("typed feedback timing uses deterministic nearest-rank percentiles without inventing feedback quality", () => {
  const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.feedbackTimingAdapter()]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "feedback-timing").status, "available");
  assert.equal(metric(result, "feedback.sample_count").value, 4);
  assert.equal(metric(result, "feedback.first_response_p50_ms").value, 200);
  assert.equal(metric(result, "feedback.first_response_p75_ms").value, 400);
  assert.equal(metric(result, "feedback.first_response_p90_ms").value, 800);
  assert.equal(metric(result, "feedback.first_response_p95_ms").value, 800);
  assert.equal(metric(result, "feedback.resolution_p50_ms").value, 2000);
  assert.equal(metric(result, "feedback.resolution_p75_ms").value, 3000);
  assert.equal(metric(result, "feedback.resolution_p90_ms").value, 4000);
  assert.equal(metric(result, "feedback.resolution_p95_ms").value, 4000);
  assert.equal(result.metrics.some((candidate) => /(?:quality|satisfaction|score)/.test(candidate.metric_id)), false);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));
});

test("optional typed PR flow stays distinct from deployment evidence and merge-only input remains incomplete", () => {
  const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.prFlowAdapter()]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "pr-flow").status, "available");
  assert.equal(metric(result, "flow.pr_count").value, 4);
  assert.equal(metric(result, "flow.pr_cycle_p50_ms").value, 200);
  assert.equal(metric(result, "flow.pr_cycle_p75_ms").value, 400);
  assert.equal(metric(result, "flow.pr_cycle_p90_ms").value, 800);
  assert.equal(metric(result, "flow.first_review_p50_ms").value, 40);
  assert.equal(metric(result, "flow.review_p75_ms").value, 200);
  assert.equal(metric(result, "flow.merge_p95_ms").value, 640);
  assert.equal(result.metrics.filter((candidate) => candidate.metric_id.startsWith("flow.")).some((candidate) => /dora/.test(candidate.metric_id)), false);
  assert.equal(metric(result, "deployment.succeeded_count").value, null);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));

  const mergeOnly = fixtures.prFlowAdapter();
  mergeOnly.payload = { pull_requests: [{ pr_id: "merge-only", merged: true }] };
  const incomplete = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(mergeOnly)]));
  assert.equal(incomplete.collectors.find((collector) => collector.collector_id === "pr-flow").status, "degraded");
  assert.equal(metric(incomplete, "flow.pr_count").value, 1);
  assert.equal(metric(incomplete, "flow.pr_cycle_p50_ms").value, null);
  assert.equal(metric(incomplete, "flow.pr_cycle_p50_ms").measurement.status, "unavailable");
  assert.equal(incomplete.collectors.find((collector) => collector.collector_id === "deployment-events").status, "unavailable");
});

test("legacy generic deployment events emit bounded facts but never delivery-equivalence claims", () => {
  const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.deploymentEventsAdapter()]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "deployment-events").status, "available");
  assert.equal(metric(result, "deployment.started_count").value, 1);
  assert.equal(metric(result, "deployment.succeeded_count").value, 1);
  assert.equal(metric(result, "deployment.failed_count").value, 1);
  assert.equal(metric(result, "deployment.rollback_count").value, 1);
  assert.equal(metric(result, "deployment.duration_p50_ms").value, 200);
  assert.equal(metric(result, "deployment.duration_p75_ms").value, 400);
  assert.equal(metric(result, "deployment.duration_p90_ms").value, 800);
  assert.equal(metric(result, "deployment.duration_p95_ms").value, 800);
  assert.equal(result.collectors.find((collector) => collector.collector_id === "dora-deployment-evidence").status, "unavailable");
  for (const candidate of result.metrics.filter((entry) => entry.metric_id.startsWith("dora."))) {
    assert.equal(candidate.value, null);
    assert.equal(candidate.measurement.status, "unavailable");
    assert.equal(candidate.source.collector_id, "dora-deployment-evidence");
  }
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));
});

test("complete typed deployment and change records materialize all five DORA measurements separately", () => {
  const adapter = fixtures.deploymentEventsAdapter();
  adapter.format = "deployment-events-v2";
  adapter.payload = {
    production_environment: "production",
    changes: [
      { change_set: "change-a", committed_at: "2026-08-01T00:00:00Z" },
      { change_set: "change-b", committed_at: "2026-08-02T00:00:00Z" },
      { change_set: "change-c", committed_at: "2026-08-03T00:00:00Z" },
      { change_set: "change-d", committed_at: "2026-08-04T00:00:00Z" },
    ],
    events: [
      { event_id: "deployment-a", change_set: "change-a", environment: "production", started_at: "2026-08-01T00:30:00Z", completed_at: "2026-08-01T01:00:00Z", status: "succeeded" },
      { event_id: "deployment-b", change_set: "change-b", environment: "production", started_at: "2026-08-02T00:30:00Z", completed_at: "2026-08-02T01:00:00Z", status: "failed", rollback_of: "deployment-a", recovery_completed_at: "2026-08-02T01:30:00Z" },
      { event_id: "deployment-c", change_set: "change-c", environment: "production", started_at: "2026-08-03T01:00:00Z", completed_at: "2026-08-03T02:00:00Z", status: "succeeded", rework_of: "deployment-b" },
      { event_id: "deployment-d", change_set: "change-d", environment: "production", started_at: "2026-08-04T03:00:00Z", completed_at: "2026-08-04T04:00:00Z", status: "succeeded" },
    ],
  };
  const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(adapter)]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "deployment-events").status, "available");
  assert.equal(result.collectors.find((collector) => collector.collector_id === "dora-deployment-evidence").status, "available");
  assert.equal(metric(result, "dora.change_lead_time").value, 7200000);
  assert.equal(metric(result, "dora.deployment_frequency").value, 3);
  assert.equal(metric(result, "dora.failed_deployment_recovery_time").value, 1800000);
  assert.equal(metric(result, "dora.change_fail_rate").value, 0.25);
  assert.equal(metric(result, "dora.deployment_rework_rate").value, 0.25);
  for (const candidate of result.metrics.filter((entry) => entry.metric_id.startsWith("dora."))) {
    assert.equal(candidate.source.kind, "typed-authoritative-deployment");
    assert.equal(candidate.source.collector_id, "dora-deployment-evidence");
    assert.ok(candidate.source.evidence_refs.every((reference) => reference.startsWith("deployment-record:")));
  }
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));
});

test("typed deployment-v2 DORA evidence is relationally closed before any dimension is measured", () => {
  const cases = [
    ["unknown production change", (adapter) => { adapter.payload.events[0].change_set = "undeclared-change"; }],
    ["unknown non-production change", (adapter) => {
      adapter.payload.events[3].environment = "staging";
      adapter.payload.events[3].change_set = "undeclared-change";
    }],
    ["change committed after deployment started", (adapter) => { adapter.payload.changes[0].committed_at = "2026-08-01T00:45:00Z"; }],
    ["change committed at deployment start", (adapter) => { adapter.payload.changes[0].committed_at = "2026-08-01T00:30:00Z"; }],
    ["rollback target after linked failure", (adapter) => { adapter.payload.events[1].rollback_of = "deployment-d"; }],
    ["rollback target in another environment", (adapter) => { adapter.payload.events[0].environment = "staging"; }],
    ["rework target after linked success", (adapter) => {
      adapter.payload.events[2].rework_of = "deployment-d";
      adapter.payload.events[3].status = "failed";
      adapter.payload.events[3].recovery_completed_at = "2026-08-04T04:30:00Z";
    }],
    ["rework target in another environment", (adapter) => {
      adapter.payload.events[0].environment = "staging";
      adapter.payload.events[1].environment = "staging";
    }],
    ["recovery before its failed deployment completed", (adapter) => { adapter.payload.events[1].recovery_completed_at = "2026-08-02T00:45:00Z"; }],
    ["recovery at its failed deployment completion", (adapter) => { adapter.payload.events[1].recovery_completed_at = "2026-08-02T01:00:00Z"; }],
    ["civil-invalid committed timestamp", (adapter) => { adapter.payload.changes[0].committed_at = "2026-02-30T00:00:00Z"; }],
    ["invalid committed timestamp offset", (adapter) => { adapter.payload.changes[0].committed_at = "2026-08-01T00:00:00+24:00"; }],
  ];

  for (const [label, mutate] of cases) {
    const adapter = fixtures.typedDeploymentEventsAdapter();
    mutate(adapter);
    const result = assertTypedDoraFailsClosed(fixtures.bindArtifactDigest(adapter), label);
    assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)), `${label}: closed M2 envelopes must remain materializable`);
  }
});

test("typed deployment-v2 rejects foreign, mismatched-window, and duplicate envelopes before DORA can measure", () => {
  const foreignRevision = fixtures.typedDeploymentEventsAdapter();
  foreignRevision.repository_revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assertTypedDoraFailsClosed(foreignRevision, "foreign revision");

  const foreignConfiguration = fixtures.typedDeploymentEventsAdapter();
  foreignConfiguration.configuration_hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assertTypedDoraFailsClosed(foreignConfiguration, "foreign configuration");

  const foreignWindow = fixtures.typedDeploymentEventsAdapter();
  foreignWindow.history_window.start = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assertTypedDoraFailsClosed(foreignWindow, "foreign history window");

  const duplicate = fixtures.typedDeploymentEventsAdapter();
  const duplicateResult = collectAdapterEvidence(fixtures.adapterInput([duplicate, structuredClone(duplicate)]));
  const collector = duplicateResult.collectors.find((candidate) => candidate.collector_id === "dora-deployment-evidence");
  assert.equal(collector.status, "degraded");
  for (const candidate of duplicateResult.metrics.filter((entry) => entry.metric_id.startsWith("dora."))) {
    assert.equal(candidate.value, null);
    assert.equal(candidate.measurement.status, "unverifiable");
    assert.match(candidate.measurement.reason, /FAIL-ADAPTER-DUPLICATE/);
  }
});

test("explicit Definition of Workflow and typed work-item transitions calculate all Kanban dimensions", () => {
  const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.workItemWorkflowAdapter()]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "kanban-work-item-flow").status, "available");
  assert.equal(metric(result, "kanban.definition_of_workflow").value, 1);
  assert.equal(metric(result, "kanban.transition_records").value, 4);
  assert.equal(metric(result, "kanban.wip").value, 1);
  assert.equal(metric(result, "kanban.throughput").value, 1);
  assert.equal(metric(result, "kanban.work_item_age").value, 432000000);
  assert.equal(metric(result, "kanban.cycle_time").value, 172800000);
  for (const candidate of result.metrics.filter((entry) => entry.metric_id.startsWith("kanban."))) {
    assert.equal(candidate.source.kind, "typed-authoritative-work-item-flow");
    assert.equal(candidate.source.collector_id, "kanban-work-item-flow");
  }
  assert.deepEqual(metric(result, "kanban.definition_of_workflow").source.evidence_refs, ["workflow-definition:team-a"]);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));
});

test("Kanban counts a coherent finish without an observed start while leaving cycle time unavailable", () => {
  const adapter = fixtures.workItemWorkflowAdapter();
  adapter.payload.transitions = adapter.payload.transitions.filter((transition) => transition.transition_id !== "done-start");
  const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(adapter)]));

  assert.equal(result.collectors.find((collector) => collector.collector_id === "kanban-work-item-flow").status, "degraded");
  assert.equal(metric(result, "kanban.throughput").value, 1);
  assert.equal(metric(result, "kanban.throughput").measurement.status, "measured");
  assert.equal(metric(result, "kanban.cycle_time").value, null);
  assert.equal(metric(result, "kanban.cycle_time").measurement.status, "unavailable");
  assert.match(metric(result, "kanban.cycle_time").measurement.reason, /observed start/);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(result)));
});

test("typed workflow timestamps reject civil-invalid dates and invalid offsets", () => {
  for (const [label, field, timestamp] of [
    ["civil-invalid date", "window_start", "2026-02-30T00:00:00Z"],
    ["invalid offset", "as_of", "2026-08-10T00:00:00+24:00"],
  ]) {
    const adapter = fixtures.workItemWorkflowAdapter();
    adapter.payload.definition_of_workflow[field] = timestamp;
    const result = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(adapter)]));
    assert.equal(result.collectors.find((collector) => collector.collector_id === "kanban-work-item-flow").status, "degraded", label);
    for (const candidate of result.metrics.filter((entry) => entry.metric_id.startsWith("kanban."))) {
      assert.equal(candidate.value, null, `${label}: no Kanban fact can survive an invalid typed workflow timestamp`);
      assert.equal(candidate.measurement.status, "unverifiable", label);
    }
  }
});

test("incomplete deployment recovery and malformed work-item state chains fail closed without proxies", () => {
  const incompleteDeployment = fixtures.typedDeploymentEventsAdapter();
  delete incompleteDeployment.payload.events[1].recovery_completed_at;
  const deploymentResult = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(incompleteDeployment)]));
  assert.equal(deploymentResult.collectors.find((collector) => collector.collector_id === "deployment-events").status, "available");
  assert.equal(deploymentResult.collectors.find((collector) => collector.collector_id === "dora-deployment-evidence").status, "degraded");
  assert.equal(metric(deploymentResult, "dora.failed_deployment_recovery_time").value, null);
  assert.equal(metric(deploymentResult, "dora.failed_deployment_recovery_time").measurement.status, "unavailable");
  assert.match(metric(deploymentResult, "dora.failed_deployment_recovery_time").measurement.reason, /recovery_completed_at/);
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(deploymentResult)));

  const brokenWorkflow = fixtures.workItemWorkflowAdapter();
  brokenWorkflow.payload.transitions[3].from = "backlog";
  const workflowResult = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(brokenWorkflow)]));
  assert.equal(workflowResult.collectors.find((collector) => collector.collector_id === "kanban-work-item-flow").status, "degraded");
  for (const candidate of workflowResult.metrics.filter((entry) => entry.metric_id.startsWith("kanban."))) {
    assert.equal(candidate.value, null);
    assert.equal(candidate.measurement.status, "unverifiable");
    assert.match(candidate.measurement.reason, /FAIL-ADAPTER-MALFORMED/);
  }
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(workflowResult)));
});

test("typed envelopes and their canonical snapshot materialization are deterministic under record ordering", () => {
  const adapters = [
    fixtures.dependencyTopologyAdapter(),
    fixtures.verificationSummaryAdapter(),
    fixtures.feedbackTimingAdapter(),
    fixtures.prFlowAdapter(),
    fixtures.typedDeploymentEventsAdapter(),
    fixtures.workItemWorkflowAdapter(),
  ];
  const first = collectAdapterEvidence(fixtures.adapterInput(adapters));
  const reordered = adapters.map((adapter) => {
    const copy = structuredClone(adapter);
    for (const value of Object.values(copy.payload)) if (Array.isArray(value)) value.reverse();
    return fixtures.bindArtifactDigest(copy);
  }).reverse();
  const second = collectAdapterEvidence(fixtures.adapterInput(reordered));

  assert.deepEqual(second, first);
  assert.equal(
    materializeSnapshot(appendToSnapshot(second)).snapshot_id,
    materializeSnapshot(appendToSnapshot(first)).snapshot_id,
  );
});

test("partial, malformed, duplicate, hash-mismatched, foreign, unsupported, and coverage-theater envelopes fail closed", () => {
  const partial = fixtures.dependencyTopologyAdapter();
  delete partial.payload.centrality;
  partial.completeness = { state: "partial", fraction: 0.5 };
  partial.coverage = { scope: "partial", fraction: 0.5 };
  const partialResult = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(partial)]));
  assert.equal(partialResult.collectors.find((collector) => collector.collector_id === "dependency-topology").status, "degraded");
  assert.equal(metric(partialResult, "dependency.node_count").measurement.status, "measured");
  assert.equal(metric(partialResult, "dependency.node_count").measurement.completeness, 0.5);
  assert.equal(metric(partialResult, "dependency.node_count").measurement.confidence, 0.5);
  assert.equal(metric(partialResult, "dependency.centrality").measurement.status, "unavailable");
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(partialResult)));

  const malformed = fixtures.dependencyTopologyAdapter();
  malformed.payload.nodes[0].attacker = true;
  const hashMismatch = fixtures.dependencyTopologyAdapter();
  hashMismatch.payload.nodes[0].id = "src/forged.js";
  const foreignRevision = fixtures.dependencyTopologyAdapter();
  foreignRevision.repository_revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const foreignConfiguration = fixtures.dependencyTopologyAdapter();
  foreignConfiguration.configuration_hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const blankArtifactRef = fixtures.dependencyTopologyAdapter();
  blankArtifactRef.artifact_ref = "";
  const unsupported = fixtures.dependencyTopologyAdapter();
  unsupported.format = "raw-lcov";
  const coverageTheater = fixtures.verificationSummaryAdapter();
  coverageTheater.payload.coverage.statements = { covered: 0, total: 0 };

  const failures = [
    ["malformed", fixtures.bindArtifactDigest(malformed), "FAIL-ADAPTER-MALFORMED", "unverifiable"],
    ["duplicate", [fixtures.dependencyTopologyAdapter(), fixtures.dependencyTopologyAdapter()], "FAIL-ADAPTER-DUPLICATE", "unverifiable"],
    ["hash mismatch", hashMismatch, "FAIL-ADAPTER-HASH-MISMATCH", "unverifiable"],
    ["foreign revision", foreignRevision, "FAIL-ADAPTER-FOREIGN-REVISION", "unverifiable"],
    ["foreign configuration", foreignConfiguration, "FAIL-ADAPTER-FOREIGN-CONFIGURATION", "unverifiable"],
    ["blank artifact ref", blankArtifactRef, "FAIL-ADAPTER-MALFORMED", "unverifiable"],
    ["unsupported format", fixtures.bindArtifactDigest(unsupported), "FAIL-ADAPTER-UNSUPPORTED-FORMAT", "unavailable"],
  ];
  for (const [name, supplied, reason, status] of failures) {
    const adapters = Array.isArray(supplied) ? supplied : [supplied];
    const output = collectAdapterEvidence(fixtures.adapterInput(adapters));
    const collector = output.collectors.find((candidate) => candidate.collector_id === "dependency-topology");
    assert.equal(collector.status, status === "unavailable" ? "unavailable" : "degraded", name);
    for (const candidate of output.metrics.filter((entry) => entry.metric_id.startsWith("dependency."))) {
      assert.equal(candidate.value, null, `${name}: ${candidate.metric_id}`);
      assert.equal(candidate.measurement.status, status, `${name}: ${candidate.metric_id}`);
      assert.match(candidate.measurement.reason, new RegExp(reason));
    }
    assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(output)), `${name} output must remain M2-valid`);
  }

  const theater = collectAdapterEvidence(fixtures.adapterInput([fixtures.bindArtifactDigest(coverageTheater)]));
  assert.equal(theater.collectors.find((collector) => collector.collector_id === "verification-summary").status, "degraded");
  for (const candidate of theater.metrics.filter((entry) => entry.metric_id.startsWith("verification."))) {
    assert.equal(candidate.value, null);
    assert.equal(candidate.measurement.status, "unverifiable");
    assert.match(candidate.measurement.reason, /FAIL-ADAPTER-COVERAGE-THEATER/);
  }
  assert.doesNotThrow(() => materializeSnapshot(appendToSnapshot(theater)));
});
