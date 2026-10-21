"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  dependencyTopologyAdapter,
  deploymentEventsAdapter,
  feedbackTimingAdapter,
  prFlowAdapter,
  typedDeploymentEventsAdapter,
  verificationSummaryAdapter,
  workItemWorkflowAdapter,
} = require("./adapter-fixtures.js");

test("dependency topology fixture is a typed, revision-bound independent graph gold sample", () => {
  const adapter = dependencyTopologyAdapter();

  assert.equal(adapter.adapter_id, "dependency-topology");
  assert.equal(adapter.format, "dependency-topology-v1");
  assert.equal(adapter.repository_revision, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(adapter.configuration_hash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.deepEqual(adapter.payload.nodes.map((node) => node.id), ["src/a.js", "src/b.js", "src/c.js", "src/d.js"]);
  assert.deepEqual(adapter.payload.edges, [
    { source: "src/a.js", target: "src/b.js" },
    { source: "src/b.js", target: "src/c.js" },
    { source: "src/c.js", target: "src/a.js" },
    { source: "src/d.js", target: "src/c.js" },
  ]);
  assert.equal(adapter.payload.centrality[2].node, "src/c.js");
  assert.equal(adapter.payload.centrality[2].value, 1);
  assert.match(adapter.artifact_sha256, /^sha256:[a-f0-9]{64}$/);
});

test("typed deployment and work-item fixtures carry the authoritative fields required for DORA and Kanban", () => {
  const deployments = typedDeploymentEventsAdapter();
  const workflow = workItemWorkflowAdapter();

  assert.equal(deployments.adapter_id, "deployment-events");
  assert.equal(deployments.format, "deployment-events-v2");
  assert.equal(deployments.payload.production_environment, "production");
  assert.deepEqual(deployments.payload.changes.map((change) => change.change_set), ["change-a", "change-b", "change-c", "change-d"]);
  assert.deepEqual(
    deployments.payload.events.map((event) => [event.event_id, event.change_set, event.environment, event.status]),
    [["deployment-a", "change-a", "production", "succeeded"], ["deployment-b", "change-b", "production", "failed"], ["deployment-c", "change-c", "production", "succeeded"], ["deployment-d", "change-d", "production", "succeeded"]],
  );
  assert.equal(deployments.payload.events[1].rollback_of, "deployment-a");
  assert.equal(deployments.payload.events[1].recovery_completed_at, "2026-08-02T01:30:00Z");
  assert.equal(deployments.payload.events[2].rework_of, "deployment-b");

  assert.equal(workflow.adapter_id, "kanban-work-item-flow");
  assert.equal(workflow.format, "work-item-workflow-v1");
  assert.deepEqual(workflow.payload.definition_of_workflow.active_states, ["in_progress", "review"]);
  assert.deepEqual(workflow.payload.transitions.map((transition) => transition.transition_id), ["done-start", "done-finish", "active-start", "active-review"]);
  for (const adapter of [deployments, workflow]) {
    assert.equal(adapter.adapter_version, "1.0.0");
    assert.match(adapter.artifact_sha256, /^sha256:[a-f0-9]{64}$/);
  }
});

test("adapter fixtures are normalized typed summaries rather than raw provider or coverage payloads", () => {
  const verification = verificationSummaryAdapter();
  const feedback = feedbackTimingAdapter();
  const flow = prFlowAdapter();
  const deployments = deploymentEventsAdapter();

  assert.deepEqual(verification.payload.tests, { total: 10, passed: 8, failed: 2, skipped: 0, duration_ms: 1234 });
  assert.deepEqual(verification.payload.coverage, {
    statements: { covered: 80, total: 100 },
    branches: { covered: 45, total: 60 },
  });
  assert.deepEqual(feedback.payload.samples.map((sample) => sample.sample_id), ["feedback-1", "feedback-2", "feedback-3", "feedback-4"]);
  assert.equal(feedback.payload.samples[3].first_response_ms, 800);
  assert.equal(feedback.payload.samples[3].resolution_ms, 4000);
  assert.deepEqual(flow.payload.pull_requests.map((entry) => entry.pr_id), ["pr-1", "pr-2", "pr-3", "pr-4"]);
  assert.equal(flow.payload.pull_requests[3].merge_time_ms, 640);
  assert.deepEqual(deployments.payload.events.map((entry) => entry.status), ["started", "succeeded", "failed", "rolled_back"]);
  assert.equal(deployments.payload.events[3].duration_ms, 800);

  for (const adapter of [verification, feedback, flow, deployments]) {
    assert.equal(adapter.adapter_version, "1.0.0");
    assert.equal(adapter.completeness.state, "complete");
    assert.equal(adapter.coverage.scope, "repository");
    assert.match(adapter.artifact_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(adapter).match(/(?:<testsuite|<coverage|SF:|DA:|provider_url|api_token)/i), null);
  }
});
