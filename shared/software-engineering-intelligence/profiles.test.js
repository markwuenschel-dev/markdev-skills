"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const canonicalSnapshot = require("./canonical-intelligence.json");
const { materializeSnapshot } = require("./intelligence-engine.js");
const { collectAdapterEvidence } = require("./evidence-adapters.js");
const adapterFixtures = require("./adapter-fixtures.js");
const { deriveProfileContractHash, evaluateProfiles, PROFILE_VERSION } = require("./profiles.js");

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const CONFIGURATION_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function profileCollector(collectorId, analyzerIdentity) {
  return {
    collector_id: collectorId,
    collector_version: "1.0.0",
    status: "available",
    analyzer_identity: analyzerIdentity,
    analyzer_version: "1.0.0",
    reason: null,
  };
}

function profileMetric({
  metricId,
  definitionId,
  family,
  unit,
  value,
  collectorId,
  analyzerIdentity,
  sourceKind,
  evidenceRefs,
  measurementStatus = "measured",
}) {
  const metric = structuredClone(canonicalSnapshot.measurements[0]);
  metric.metric_id = metricId;
  metric.definition_id = definitionId;
  metric.family = family;
  metric.subject = "repository:canonical-repository";
  metric.repository_revision = REVISION;
  metric.value = value;
  metric.unit = unit;
  metric.measurement = { status: measurementStatus, completeness: 1, confidence: 1, reason: null };
  metric.source = {
    kind: sourceKind,
    collector_id: collectorId,
    collector_version: "1.0.0",
    repository_revision: REVISION,
    command: null,
    artifact_refs: evidenceRefs,
    evidence_refs: evidenceRefs,
  };
  metric.scope = {
    kind: "repository",
    path: ".",
    language: null,
    generated_code: false,
    included_in_human_maintainability: false,
  };
  metric.window = { kind: "revision-range", start: "fedcba9876543210fedcba9876543210fedcba98", end: REVISION };
  metric.analyzer_identity = analyzerIdentity;
  metric.analyzer_version = "1.0.0";
  metric.comparability = {
    analyzer_identity: analyzerIdentity,
    analyzer_version: "1.0.0",
    configuration_hash: CONFIGURATION_HASH,
    compatible_with_prior: false,
    reason: "framework fixture",
  };
  return metric;
}

function profileSnapshot({ collectors, metrics }) {
  const snapshot = structuredClone(canonicalSnapshot);
  snapshot.collectors.push(...collectors);
  snapshot.measurements.push(...metrics);
  snapshot.evidence_summary.measurement_count = snapshot.measurements.length;
  snapshot.evidence_summary.status_counts = Object.fromEntries(
    Object.keys(snapshot.evidence_summary.status_counts).map((status) => [
      status,
      snapshot.measurements.filter((metric) => metric.measurement.status === status).length,
    ]),
  );
  return snapshot;
}

function metricBinding(metric, dimension, extra = {}) {
  return {
    metric_id: metric.metric_id,
    dimension,
    status: metric.measurement.status,
    evidence_refs: metric.source.evidence_refs,
    ...extra,
  };
}

function doraSnapshot() {
  const collectorId = "dora-deployment-evidence";
  const analyzerIdentity = "sei.dora-deployment-evidence@1";
  const definitions = [
    ["change_lead_time", "milliseconds", 3600000],
    ["deployment_frequency", "deployments_per_window", 4],
    ["failed_deployment_recovery_time", "milliseconds", 1800000],
    ["change_fail_rate", "ratio", 0.1],
    ["deployment_rework_rate", "ratio", 0.05],
  ];
  return profileSnapshot({
    collectors: [profileCollector(collectorId, analyzerIdentity)],
    metrics: definitions.map(([dimension, unit, value]) => profileMetric({
      metricId: `dora.${dimension}`,
      definitionId: `sei.dora.${dimension}@1`,
      family: "delivery_performance",
      unit,
      value,
      collectorId,
      analyzerIdentity,
      sourceKind: "typed-authoritative-deployment",
      evidenceRefs: [`deployment-record:${dimension}`],
    })),
  });
}

function kanbanFixture() {
  const collectorId = "kanban-work-item-flow";
  const analyzerIdentity = "sei.kanban-work-item-flow@1";
  const workflowRef = ["workflow-definition:team-a"];
  const transitions = [
    { work_item_id: "work-item:done", from: "backlog", to: "in_progress", occurred_at: "2026-08-01T00:00:00Z", evidence_refs: ["work-item-transition:done:start"] },
    { work_item_id: "work-item:done", from: "in_progress", to: "done", occurred_at: "2026-08-03T00:00:00Z", evidence_refs: ["work-item-transition:done:finish"] },
    { work_item_id: "work-item:active", from: "backlog", to: "in_progress", occurred_at: "2026-08-05T00:00:00Z", evidence_refs: ["work-item-transition:active:start"] },
    { work_item_id: "work-item:active", from: "in_progress", to: "review", occurred_at: "2026-08-07T00:00:00Z", evidence_refs: ["work-item-transition:active:review"] },
  ];
  const transitionRefs = transitions.flatMap((transition) => transition.evidence_refs);
  const shared = { collectorId, analyzerIdentity, sourceKind: "typed-authoritative-work-item-flow" };
  const workflowMetric = profileMetric({
    metricId: "kanban.definition_of_workflow",
    definitionId: "sei.kanban.definition_of_workflow@1",
    family: "workflow_definition",
    unit: "definition",
    value: 1,
    evidenceRefs: workflowRef,
    ...shared,
  });
  const transitionMetric = profileMetric({
    metricId: "kanban.transition_records",
    definitionId: "sei.kanban.transition_records@1",
    family: "workflow_transitions",
    unit: "records",
    value: transitions.length,
    evidenceRefs: transitionRefs,
    ...shared,
  });
  const dimensionMetrics = [
    ["wip", "items", 1],
    ["throughput", "items", 1],
    ["work_item_age", "milliseconds", 432000000],
    ["cycle_time", "milliseconds", 172800000],
  ].map(([dimension, unit, value]) => profileMetric({
    metricId: `kanban.${dimension}`,
    definitionId: `sei.kanban.${dimension}@1`,
    family: "flow",
    unit,
    value,
    evidenceRefs: transitionRefs,
    ...shared,
  }));
  const snapshot = profileSnapshot({
    collectors: [profileCollector(collectorId, analyzerIdentity)],
    metrics: [workflowMetric, transitionMetric, ...dimensionMetrics],
  });
  const binding = {
    profile_id: "Kanban",
    definition_of_workflow: {
      metric_id: workflowMetric.metric_id,
      identified: true,
      start_event: "in_progress",
      finish_event: "done",
      active_states: ["in_progress", "review"],
      as_of: "2026-08-10T00:00:00Z",
      window_start: "2026-08-01T00:00:00Z",
      window_end: "2026-08-10T00:00:00Z",
      evidence_refs: workflowRef,
    },
    transition_metric_id: transitionMetric.metric_id,
    transitions,
  };
  return { snapshot, binding, dimensionMetrics };
}

function humanFrameworkMetric(profileId, dimension, metricId, evidenceRef, { measurementStatus = "measured", family = "framework_profile", unit = "evidence" } = {}) {
  return profileMetric({
    metricId,
    definitionId: `sei.${profileId.toLowerCase()}.${dimension}@1`,
    family,
    unit,
    value: 1,
    collectorId: "human-framework-evidence",
    analyzerIdentity: "sei.human-framework-evidence@1",
    sourceKind: "human-process-evidence",
    evidenceRefs: [evidenceRef],
    measurementStatus,
  });
}

test("DORA remains insufficient without all five typed authoritative deployment dimensions", () => {
  const genericDeploymentMetric = profileMetric({
    metricId: "deployment.succeeded_count",
    definitionId: "sei.adapter.deployment.succeeded_count@1",
    family: "deployment_events",
    unit: "count",
    value: 4,
    collectorId: "deployment-events",
    analyzerIdentity: "sei.adapter.deployment-events@1",
    sourceKind: "typed-adapter",
    evidenceRefs: ["deployment-event:generic"],
  });
  const snapshot = profileSnapshot({
    collectors: [profileCollector("deployment-events", "sei.adapter.deployment-events@1")],
    metrics: [genericDeploymentMetric],
  });
  const result = evaluateProfiles(snapshot, [{
    profile_id: "DORA",
    evidence: [{ kind: "merge", dimension: "deployment_frequency", status: "measured", evidence_refs: ["merge:42"] }],
  }]).DORA;

  assert.deepEqual(Object.keys(result.dimensions), [
    "change_lead_time",
    "deployment_frequency",
    "failed_deployment_recovery_time",
    "change_fail_rate",
    "deployment_rework_rate",
  ]);
  assert.equal(result.applicability.status, "insufficient_evidence");
  assert.ok(Object.values(result.dimensions).every((dimension) => dimension.status === "insufficient_evidence"));
  assert.deepEqual(result.failure_codes, ["FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE"]);
  assert.equal("score" in result, false);
});

test("DORA binds five separate authoritative measurements, keeps identity metadata, and materializes", () => {
  const snapshot = doraSnapshot();
  const dora = evaluateProfiles(snapshot, [{ profile_id: "DORA" }]).DORA;

  assert.equal(dora.applicability.status, "applicable");
  assert.deepEqual(
    Object.fromEntries(Object.entries(dora.dimensions).map(([dimension, record]) => [dimension, record.status])),
    {
      change_lead_time: "measured",
      deployment_frequency: "measured",
      failed_deployment_recovery_time: "measured",
      change_fail_rate: "measured",
      deployment_rework_rate: "measured",
    },
  );
  assert.equal(dora.profile_id, "DORA");
  assert.equal(dora.profile_version, PROFILE_VERSION);
  assert.equal(dora.profile_contract_hash, deriveProfileContractHash("DORA"));
  assert.equal("source" in dora, false, "M2 retains source identity through bound evidence, not an ad hoc profile source field");
  assert.deepEqual(dora.dimensions.deployment_frequency.evidence[0], {
    kind: "sei.dora.deployment_frequency@1",
    dimension: "deployment_frequency",
    status: "measured",
    evidence_refs: ["deployment-record:deployment_frequency"],
    metric_id: "dora.deployment_frequency",
  });
  snapshot.profiles = [dora];
  assert.doesNotThrow(() => materializeSnapshot(snapshot));
});

test("DORA recognizes adapter-calculated typed deployment and change measurements", () => {
  const evidence = collectAdapterEvidence(adapterFixtures.adapterInput([adapterFixtures.typedDeploymentEventsAdapter()]));
  const snapshot = profileSnapshot({ collectors: evidence.collectors, metrics: evidence.metrics });

  const dora = evaluateProfiles(snapshot, [{ profile_id: "DORA" }]).DORA;

  assert.equal(dora.applicability.status, "applicable");
  assert.deepEqual(
    Object.fromEntries(Object.entries(dora.dimensions).map(([dimension, record]) => [dimension, record.status])),
    {
      change_lead_time: "measured",
      deployment_frequency: "measured",
      failed_deployment_recovery_time: "measured",
      change_fail_rate: "measured",
      deployment_rework_rate: "measured",
    },
  );
  for (const record of Object.values(dora.dimensions)) {
    assert.ok(record.evidence.every((item) => item.evidence_refs.some((reference) => reference.startsWith("deployment-record:"))));
  }
  snapshot.profiles = [dora];
  assert.doesNotThrow(() => materializeSnapshot(snapshot));
});

test("DORA hard gate cannot be masked by four valid dimensions or merge-tainted provenance", () => {
  const snapshot = doraSnapshot();
  const tainted = snapshot.measurements.find((metric) => metric.metric_id === "dora.deployment_frequency");
  tainted.source.artifact_refs.push("merge:42");
  tainted.source.evidence_refs.push("merge:42");
  const dora = evaluateProfiles(snapshot, [{ profile_id: "DORA" }]).DORA;

  assert.equal(dora.dimensions.change_lead_time.status, "measured");
  assert.equal(dora.dimensions.deployment_frequency.status, "insufficient_evidence");
  assert.equal(dora.applicability.status, "insufficient_evidence");
  assert.deepEqual(dora.failure_codes, ["FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE"]);
});

test("Kanban calculates WIP, throughput, work-item age, and cycle time from a workflow and typed transitions", () => {
  const { snapshot, binding, dimensionMetrics } = kanbanFixture();
  const kanban = evaluateProfiles(snapshot, [binding]).Kanban;

  assert.equal(kanban.applicability.status, "applicable");
  assert.deepEqual(
    Object.fromEntries(Object.entries(kanban.dimensions).map(([dimension, record]) => [dimension, record.status])),
    { wip: "measured", throughput: "measured", work_item_age: "measured", cycle_time: "measured" },
  );
  for (const metric of dimensionMetrics) {
    const dimension = metric.metric_id.slice("kanban.".length);
    assert.ok(kanban.dimensions[dimension].evidence.some((item) => item.metric_id === metric.metric_id));
  }
  const reordered = evaluateProfiles(snapshot, [{ ...binding, transitions: [...binding.transitions].reverse() }]).Kanban;
  assert.deepEqual(reordered, kanban, "typed transition order must not change the calculated result");
  snapshot.profiles = [kanban];
  assert.doesNotThrow(() => materializeSnapshot(snapshot));
});

test("Kanban counts an observed coherent finish without inventing an unobserved cycle start", () => {
  const { snapshot, binding, dimensionMetrics } = kanbanFixture();
  binding.transitions = binding.transitions.filter((transition) => transition.work_item_id !== "work-item:done" || transition.to === "done");
  const transitionMetric = snapshot.measurements.find((metric) => metric.metric_id === "kanban.transition_records");
  transitionMetric.value = binding.transitions.length;
  dimensionMetrics.find((metric) => metric.metric_id === "kanban.throughput").value = 1;

  const kanban = evaluateProfiles(snapshot, [binding]).Kanban;

  assert.equal(kanban.dimensions.throughput.status, "measured");
  assert.equal(kanban.dimensions.wip.status, "measured");
  assert.equal(kanban.dimensions.work_item_age.status, "measured");
  assert.equal(kanban.dimensions.cycle_time.status, "insufficient_evidence");
  assert.equal(kanban.applicability.status, "insufficient_evidence");
});

test("public Kanban evaluation rejects civil-invalid workflow timestamps rather than Date.parse normalization", () => {
  for (const [field, timestamp] of [
    ["window_start", "2026-02-30T00:00:00Z"],
    ["as_of", "2026-08-10T00:00:00+24:00"],
  ]) {
    const { snapshot, binding } = kanbanFixture();
    binding.definition_of_workflow[field] = timestamp;

    const kanban = evaluateProfiles(snapshot, [binding]).Kanban;

    assert.equal(kanban.applicability.status, "insufficient_evidence", `${field} must be rejected`);
    assert.ok(kanban.failure_codes.includes("FAIL-KANBAN-WITHOUT-DEFINITION-OF-WORKFLOW"), `${field} must not normalize into a different workflow boundary`);
    assert.equal(kanban.failure_codes.includes("FAIL-KANBAN-TYPED-TRANSITION-CALCULATION-MISMATCH"), false, `${field} must fail parsing before metric comparison`);
  }
});

test("Kanban rejects raw workflow claims, missing transitions, and mismatched typed calculations", () => {
  const raw = evaluateProfiles({}, [{
    profile_id: "Kanban",
    definition_of_workflow: {
      identified: true,
      start_event: "in_progress",
      finish_event: "done",
      source: { status: "measured" },
      evidence_refs: ["workflow-definition:raw"],
    },
  }]).Kanban;
  assert.equal(raw.applicability.status, "insufficient_evidence");
  assert.ok(raw.failure_codes.includes("FAIL-KANBAN-WITHOUT-DEFINITION-OF-WORKFLOW"));

  const { snapshot, binding } = kanbanFixture();
  const incorrect = snapshot.measurements.find((metric) => metric.metric_id === "kanban.wip");
  incorrect.value = 2;
  const result = evaluateProfiles(snapshot, [binding]).Kanban;
  assert.equal(result.dimensions.wip.status, "insufficient_evidence");
  assert.equal(result.applicability.status, "insufficient_evidence");
  assert.ok(result.failure_codes.includes("FAIL-KANBAN-TYPED-TRANSITION-CALCULATION-MISMATCH"));
});

test("Kanban recognizes adapter-calculated Definition of Workflow and typed work-item transitions", () => {
  const adapter = adapterFixtures.deploymentEventsAdapter();
  adapter.adapter_id = "kanban-work-item-flow";
  adapter.kind = "work_item_workflow";
  adapter.format = "work-item-workflow-v1";
  adapter.artifact_ref = "fixture:kanban-work-item-flow";
  adapter.payload = {
    definition_of_workflow: {
      workflow_id: "team-a",
      states: ["backlog", "in_progress", "review", "done"],
      start_event: "in_progress",
      finish_event: "done",
      active_states: ["in_progress", "review"],
      as_of: "2026-08-10T00:00:00Z",
      window_start: "2026-08-01T00:00:00Z",
      window_end: "2026-08-10T00:00:00Z",
    },
    transitions: [
      { transition_id: "done-start", work_item_id: "work-item:done", from: "backlog", to: "in_progress", occurred_at: "2026-08-01T00:00:00Z" },
      { transition_id: "done-finish", work_item_id: "work-item:done", from: "in_progress", to: "done", occurred_at: "2026-08-03T00:00:00Z" },
      { transition_id: "active-start", work_item_id: "work-item:active", from: "backlog", to: "in_progress", occurred_at: "2026-08-05T00:00:00Z" },
      { transition_id: "active-review", work_item_id: "work-item:active", from: "in_progress", to: "review", occurred_at: "2026-08-07T00:00:00Z" },
    ],
  };
  const evidence = collectAdapterEvidence(adapterFixtures.adapterInput([adapterFixtures.bindArtifactDigest(adapter)]));
  const snapshot = profileSnapshot({ collectors: evidence.collectors, metrics: evidence.metrics });

  const kanban = evaluateProfiles(snapshot, [{ profile_id: "Kanban" }]).Kanban;

  assert.equal(kanban.applicability.status, "applicable");
  assert.deepEqual(
    Object.fromEntries(Object.entries(kanban.dimensions).map(([dimension, record]) => [dimension, record.status])),
    { wip: "measured", throughput: "measured", work_item_age: "measured", cycle_time: "measured" },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(kanban.dimensions).map(([dimension, record]) => [dimension, record.evidence.find((item) => item.metric_id === `kanban.${dimension}`)?.evidence_refs])),
    {
      wip: ["fixture:kanban-work-item-flow", "work-item-transition:active-review", "work-item-transition:active-start", "work-item-transition:done-finish", "work-item-transition:done-start"],
      throughput: ["fixture:kanban-work-item-flow", "work-item-transition:active-review", "work-item-transition:active-start", "work-item-transition:done-finish", "work-item-transition:done-start"],
      work_item_age: ["fixture:kanban-work-item-flow", "work-item-transition:active-review", "work-item-transition:active-start", "work-item-transition:done-finish", "work-item-transition:done-start"],
      cycle_time: ["fixture:kanban-work-item-flow", "work-item-transition:active-review", "work-item-transition:active-start", "work-item-transition:done-finish", "work-item-transition:done-start"],
    },
  );
  snapshot.profiles = [kanban];
  assert.doesNotThrow(() => materializeSnapshot(snapshot));
});

test("SPACE keeps dimensions separate and accepts human dimensions only when snapshot evidence is supplied", () => {
  const raw = evaluateProfiles({}, [{
    profile_id: "SPACE",
    evidence: [{ kind: "survey", dimension: "satisfaction_and_wellbeing", status: "measured", evidence_refs: ["survey:raw"] }],
  }]).SPACE;
  assert.equal(raw.dimensions.satisfaction_and_wellbeing.status, "unobservable");

  const satisfaction = humanFrameworkMetric("SPACE", "satisfaction_and_wellbeing", "space.satisfaction_and_wellbeing", "survey:wellbeing");
  const communication = humanFrameworkMetric("SPACE", "communication_and_collaboration", "space.communication_and_collaboration", "survey:communication");
  const activity = profileMetric({
    metricId: "space.activity",
    definitionId: "sei.space.activity@1",
    family: "framework_profile",
    unit: "events",
    value: 7,
    collectorId: "space-activity",
    analyzerIdentity: "sei.space-activity@1",
    sourceKind: "typed-adapter",
    evidenceRefs: ["activity-record:week-32"],
  });
  const snapshot = profileSnapshot({
    collectors: [
      profileCollector("human-framework-evidence", "sei.human-framework-evidence@1"),
      profileCollector("space-activity", "sei.space-activity@1"),
    ],
    metrics: [satisfaction, communication, activity],
  });
  const space = evaluateProfiles(snapshot, [{
    profile_id: "SPACE",
    evidence: [
      metricBinding(satisfaction, "satisfaction_and_wellbeing"),
      metricBinding(communication, "communication_and_collaboration"),
      metricBinding(activity, "activity"),
    ],
  }]).SPACE;

  assert.deepEqual(Object.keys(space.dimensions), [
    "satisfaction_and_wellbeing",
    "performance",
    "activity",
    "communication_and_collaboration",
    "efficiency_and_flow",
  ]);
  assert.equal(space.dimensions.satisfaction_and_wellbeing.status, "measured");
  assert.equal(space.dimensions.communication_and_collaboration.status, "measured");
  assert.equal(space.dimensions.activity.status, "measured");
  assert.equal(space.dimensions.performance.status, "unobservable");
  assert.equal("overall_score" in space, false);
  assert.throws(
    () => evaluateProfiles(snapshot, [{ profile_id: "SPACE", overall_score: 1 }]),
    /FAIL-SPACE-SINGLE-SCORE/,
  );
  snapshot.profiles = [space];
  assert.doesNotThrow(() => materializeSnapshot(snapshot));
});

test("public profile evaluation does not promote forged evidence references", () => {
  const activity = profileMetric({
    metricId: "space.activity",
    definitionId: "sei.space.activity@1",
    family: "framework_profile",
    unit: "events",
    value: 7,
    collectorId: "space-activity",
    analyzerIdentity: "sei.space-activity@1",
    sourceKind: "typed-adapter",
    evidenceRefs: ["activity-record:real"],
  });
  const snapshot = profileSnapshot({
    collectors: [profileCollector("space-activity", "sei.space-activity@1")],
    metrics: [activity],
  });

  const space = evaluateProfiles(snapshot, [{
    profile_id: "SPACE",
    evidence: [{
      metric_id: activity.metric_id,
      dimension: "activity",
      status: "measured",
      evidence_refs: ["activity-record:forged"],
    }],
  }]).SPACE;

  assert.equal(space.dimensions.activity.status, "unobservable");
  assert.deepEqual(space.dimensions.activity.evidence_refs, []);
  assert.deepEqual(space.applicability.evidence_refs, []);
});

test("Agile is alignment-only and cannot infer trust or customer collaboration from caller claims", () => {
  const raw = evaluateProfiles({}, [{
    profile_id: "Agile",
    evidence: [{
      kind: "stakeholder_interview",
      dimension: "customer_collaboration",
      status: "measured",
      evidence_class: "human",
      evidence_refs: ["interview:raw"],
    }],
  }]).Agile;
  assert.equal(raw.dimensions.customer_collaboration.status, "unobservable");

  const customer = humanFrameworkMetric("Agile", "customer_collaboration", "agile.customer_collaboration", "interview:customer");
  const workingSoftware = profileMetric({
    metricId: "agile.working_software",
    definitionId: "sei.agile.working_software@1",
    family: "framework_profile",
    unit: "verified_delivery",
    value: 1,
    collectorId: "agile-delivery-evidence",
    analyzerIdentity: "sei.agile-delivery-evidence@1",
    sourceKind: "typed-adapter",
    evidenceRefs: ["delivery-record:release-42"],
  });
  const snapshot = profileSnapshot({
    collectors: [
      profileCollector("human-framework-evidence", "sei.human-framework-evidence@1"),
      profileCollector("agile-delivery-evidence", "sei.agile-delivery-evidence@1"),
    ],
    metrics: [customer, workingSoftware],
  });
  const agile = evaluateProfiles(snapshot, [{
    profile_id: "Agile",
    evidence: [
      metricBinding(customer, "customer_collaboration", { evidence_class: "human" }),
      metricBinding(workingSoftware, "working_software", { evidence_class: "machine" }),
    ],
  }]).Agile;

  assert.equal(agile.applicability.status, "applicable");
  assert.equal(agile.dimensions.customer_collaboration.status, "measured");
  assert.equal(agile.dimensions.working_software.status, "measured");
  assert.equal(agile.dimensions.individuals_and_interactions.status, "unobservable");
  assert.deepEqual(agile.evidence.machine.map((item) => item.metric_id), ["agile.working_software"]);
  assert.deepEqual(agile.evidence.human.map((item) => item.metric_id), ["agile.customer_collaboration"]);
  assert.equal("score" in agile, false);
  snapshot.profiles = [agile];
  assert.doesNotThrow(() => materializeSnapshot(snapshot));
});

test("Scrum is applicable only for a current explicit metric-bound adoption; historical mentions are N/A", () => {
  const adoption = humanFrameworkMetric("Scrum", "current_adoption", "scrum.current_adoption", "framework-adoption:scrum-current", {
    measurementStatus: "inferred",
    family: "framework_adoption",
    unit: "assertion",
  });
  const snapshot = profileSnapshot({
    collectors: [profileCollector("human-framework-evidence", "sei.human-framework-evidence@1")],
    metrics: [adoption],
  });
  const current = evaluateProfiles(snapshot, [{
    profile_id: "Scrum",
    adoption: {
      metric_id: adoption.metric_id,
      framework: "Scrum",
      explicit: true,
      status: "current",
      evidence_refs: adoption.source.evidence_refs,
    },
  }]).Scrum;
  assert.equal(current.applicability.status, "applicable");
  assert.ok(Object.values(current.dimensions).every((dimension) => dimension.status === "inferred"));
  snapshot.profiles = [current];
  assert.doesNotThrow(() => materializeSnapshot(snapshot));

  const historical = evaluateProfiles(snapshot, [{
    profile_id: "Scrum",
    adoption: { framework: "Scrum", explicit: true, status: "historical", evidence_refs: ["framework-adoption:old"] },
  }]).Scrum;
  assert.equal(historical.applicability.status, "not_applicable");
  assert.ok(Object.values(historical.dimensions).every((dimension) => dimension.status === "not_applicable"));

  const rawCurrent = evaluateProfiles({}, [{
    profile_id: "Scrum",
    adoption: { framework: "Scrum", explicit: true, status: "current", evidence_refs: ["framework-adoption:raw"], source: { status: "measured" } },
  }]).Scrum;
  assert.equal(rawCurrent.applicability.status, "not_applicable");
});

test("default profiles and all profile evidence remain closed-M2 materializable", () => {
  const snapshot = structuredClone(canonicalSnapshot);
  const profiles = evaluateProfiles(snapshot);
  snapshot.profiles = Object.values(profiles);

  assert.deepEqual(Object.keys(profiles), ["Agile", "Scrum", "Kanban", "DORA", "SPACE", "EngThrive"]);
  assert.doesNotThrow(() => materializeSnapshot(snapshot));
});

test("profile aliases must agree and duplicate canonical bindings fail closed", () => {
  const agreeing = evaluateProfiles({}, [{ profile_id: " DORA ", profile: "dora", id: "DORA" }]);
  assert.ok(agreeing.DORA);
  assert.throws(
    () => evaluateProfiles({}, [{ profile_id: "DORA", profile: "SPACE" }]),
    /FAIL-FRAMEWORK-WITHOUT-APPLICABILITY/,
  );
  assert.throws(
    () => evaluateProfiles({}, [{ profile_id: "DORA" }, { profile: " dora " }]),
    /FAIL-FRAMEWORK-WITHOUT-APPLICABILITY/,
  );
});

test("EngThrive remains advisory, system-level, and never an individual ranking", () => {
  const system = evaluateProfiles({}, [{ profile_id: "EngThrive", evidence: [] }]).EngThrive;
  assert.equal(system.maturity, "experimental");
  assert.equal(system.guidance, "advisory");
  assert.equal(system.scope, "system");
  assert.deepEqual(Object.keys(system.dimensions), ["speed", "ease", "quality", "thriving"]);
  assert.equal("individual_productivity" in system, false);

  const individual = evaluateProfiles({}, [{ profile_id: "EngThrive", scope: { kind: "individual", id: "person-1" } }]).EngThrive;
  assert.equal(individual.applicability.status, "not_applicable");
});
