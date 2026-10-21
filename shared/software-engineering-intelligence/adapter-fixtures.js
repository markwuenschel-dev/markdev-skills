"use strict";

const crypto = require("node:crypto");

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const CONFIGURATION_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HISTORY_WINDOW = Object.freeze({
  kind: "revision-range",
  start: "fedcba9876543210fedcba9876543210fedcba98",
  end: REVISION,
});

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function canonicalPayload(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalPayload(item)).sort((left, right) => stableCompare(stableStringify(left), stableStringify(right)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalPayload(value[key])]));
  }
  return value;
}

function payloadDigest(payload) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(canonicalPayload(payload))).digest("hex")}`;
}

function bindArtifactDigest(envelope) {
  return { ...structuredClone(envelope), artifact_sha256: payloadDigest(envelope.payload) };
}

function adapterEnvelope(fields) {
  return bindArtifactDigest({
    adapter_version: "1.0.0",
    repository_revision: REVISION,
    configuration_hash: CONFIGURATION_HASH,
    history_window: structuredClone(HISTORY_WINDOW),
    completeness: { state: "complete", fraction: 1 },
    coverage: { scope: "repository", fraction: 1 },
    ...fields,
  });
}

function dependencyTopologyAdapter() {
  return adapterEnvelope({
    adapter_id: "dependency-topology",
    kind: "dependency_topology",
    format: "dependency-topology-v1",
    artifact_ref: "fixture:dependency-topology",
    payload: {
      nodes: [
        { id: "src/a.js" },
        { id: "src/b.js" },
        { id: "src/c.js" },
        { id: "src/d.js" },
      ],
      edges: [
        { source: "src/a.js", target: "src/b.js" },
        { source: "src/b.js", target: "src/c.js" },
        { source: "src/c.js", target: "src/a.js" },
        { source: "src/d.js", target: "src/c.js" },
      ],
      centrality: [
        { node: "src/a.js", value: 0.5 },
        { node: "src/b.js", value: 0.5 },
        { node: "src/c.js", value: 1 },
        { node: "src/d.js", value: 0.5 },
      ],
    },
  });
}

function verificationSummaryAdapter() {
  return adapterEnvelope({
    adapter_id: "verification-summary",
    kind: "verification_summary",
    format: "junit-summary-v1",
    artifact_ref: "fixture:verification-junit",
    payload: {
      tests: {
        total: 10,
        passed: 8,
        failed: 2,
        skipped: 0,
        duration_ms: 1234,
      },
      coverage: {
        statements: { covered: 80, total: 100 },
        branches: { covered: 45, total: 60 },
      },
    },
  });
}

function assessmentEvidenceAdapter() {
  return adapterEnvelope({
    adapter_id: "assessment-evidence",
    kind: "assessment_evidence",
    format: "assessment-evidence-v1",
    artifact_ref: "fixture:assessment-evidence",
    payload: {
      facts: [
        { metric_id: "assessment.reliability.failure_handling", value: 0.8 },
        { metric_id: "assessment.security.verification", value: true },
        { metric_id: "assessment.developer.flow_friction", value: 2 },
      ],
    },
  });
}

function feedbackTimingAdapter() {
  return adapterEnvelope({
    adapter_id: "feedback-timing",
    kind: "feedback_timing",
    format: "feedback-timing-v1",
    artifact_ref: "fixture:feedback-timing",
    payload: {
      samples: [
        { sample_id: "feedback-1", first_response_ms: 100, resolution_ms: 1000 },
        { sample_id: "feedback-2", first_response_ms: 200, resolution_ms: 2000 },
        { sample_id: "feedback-3", first_response_ms: 400, resolution_ms: 3000 },
        { sample_id: "feedback-4", first_response_ms: 800, resolution_ms: 4000 },
      ],
    },
  });
}

function prFlowAdapter() {
  return adapterEnvelope({
    adapter_id: "pr-flow",
    kind: "pr_flow",
    format: "pr-flow-v1",
    artifact_ref: "fixture:pr-flow",
    payload: {
      pull_requests: [
        { pr_id: "pr-1", merged: true, cycle_time_ms: 100, first_review_time_ms: 20, review_time_ms: 50, merge_time_ms: 80 },
        { pr_id: "pr-2", merged: true, cycle_time_ms: 200, first_review_time_ms: 40, review_time_ms: 100, merge_time_ms: 160 },
        { pr_id: "pr-3", merged: true, cycle_time_ms: 400, first_review_time_ms: 80, review_time_ms: 200, merge_time_ms: 320 },
        { pr_id: "pr-4", merged: true, cycle_time_ms: 800, first_review_time_ms: 160, review_time_ms: 400, merge_time_ms: 640 },
      ],
    },
  });
}

function deploymentEventsAdapter() {
  return adapterEnvelope({
    adapter_id: "deployment-events",
    kind: "deployment_events",
    format: "deployment-events-v1",
    artifact_ref: "fixture:deployment-events",
    payload: {
      events: [
        { event_id: "deployment-1", status: "started", duration_ms: 100 },
        { event_id: "deployment-2", status: "succeeded", duration_ms: 200 },
        { event_id: "deployment-3", status: "failed", duration_ms: 400 },
        { event_id: "deployment-4", status: "rolled_back", duration_ms: 800 },
      ],
    },
  });
}

function typedDeploymentEventsAdapter() {
  return adapterEnvelope({
    adapter_id: "deployment-events",
    kind: "deployment_events",
    format: "deployment-events-v2",
    artifact_ref: "fixture:typed-deployment-events",
    payload: {
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
    },
  });
}

function workItemWorkflowAdapter() {
  return adapterEnvelope({
    adapter_id: "kanban-work-item-flow",
    kind: "work_item_workflow",
    format: "work-item-workflow-v1",
    artifact_ref: "fixture:kanban-work-item-flow",
    payload: {
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
    },
  });
}

function adapterInput(adapters = [dependencyTopologyAdapter()]) {
  return {
    repository_revision: REVISION,
    configuration_hash: CONFIGURATION_HASH,
    history_window: structuredClone(HISTORY_WINDOW),
    adapters: structuredClone(adapters),
  };
}

module.exports = {
  REVISION,
  CONFIGURATION_HASH,
  HISTORY_WINDOW,
  adapterInput,
  bindArtifactDigest,
  deploymentEventsAdapter,
  dependencyTopologyAdapter,
  feedbackTimingAdapter,
  payloadDigest,
  prFlowAdapter,
  typedDeploymentEventsAdapter,
  verificationSummaryAdapter,
  assessmentEvidenceAdapter,
  workItemWorkflowAdapter,
};
