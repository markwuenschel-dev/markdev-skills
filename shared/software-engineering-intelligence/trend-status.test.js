"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const trendStatus = require("./trend-status.js");
const {
  TREND_STATUS_VERSION,
  deriveTrendStatus,
} = trendStatus;

const CURRENT = Object.freeze({
  snapshot_id: `sei-v1-${"a".repeat(64)}`,
  repository_revision: "b".repeat(40),
});
const BASELINE_SNAPSHOT_ID = `sei-v1-${"c".repeat(64)}`;
const BASELINE_REVISION = "d".repeat(40);

function baseline(overrides = {}) {
  return {
    binding_kind: "automatic",
    status: "established",
    eligible: true,
    baseline_snapshot_id: null,
    baseline_repository_revision: null,
    compatible_metric_count: 0,
    ...overrides,
  };
}

function history(overrides = {}) {
  return {
    metric_id: "git.change_frequency",
    definition_id: "sei.git.change_frequency@1",
    state: "measured",
    value: 145,
    coverage: 1,
    confidence: 1,
    scope: "configured-window",
    ...overrides,
  };
}

function comparison(metricId, overrides = {}) {
  return {
    metric_id: metricId,
    baseline_snapshot_id: BASELINE_SNAPSHOT_ID,
    baseline_repository_revision: BASELINE_REVISION,
    binding_kind: "automatic",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    current_snapshot: CURRENT,
    baseline: baseline(),
    history: history(),
    comparisons: [],
    ...overrides,
  };
}

test("reports a first compatible SEI observation separately from repository history", () => {
  const result = deriveTrendStatus(input());

  assert.deepEqual(Object.keys(trendStatus).sort(), [
    "TREND_STATUS_VERSION",
    "deriveTrendStatus",
  ]);
  assert.equal(TREND_STATUS_VERSION, "sei.trend-status@1");
  assert.equal(result.state, "first-compatible-sei-observation-with-observed-history");
  assert.equal(result.compatibility, "not-yet-comparable");
  assert.equal(result.comparison_binding_count, 0);
  assert.deepEqual(result.history, {
    metric_id: "git.change_frequency",
    definition_id: "sei.git.change_frequency@1",
    state: "measured",
    observed_revision_count: 145,
    coverage: 1,
    confidence: 1,
    scope: "configured-window",
  });
  assert.match(result.summary, /no compatible prior SEI baseline was selected/i);
  assert.match(result.summary, /145 observed revisions/i);
  assert.match(result.limitation, /does not claim that the repository is new/i);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.history), true);
  assert.doesNotMatch(`${result.summary} ${result.limitation} ${result.next_observation}`, /causes?|improv(?:e|ed|ement)|worsen|significan(?:ce|t)/i);
});

test("reports a selected compatible prior baseline from canonical bindings", () => {
  const selected = baseline({
    status: "selected",
    eligible: true,
    baseline_snapshot_id: BASELINE_SNAPSHOT_ID,
    baseline_repository_revision: BASELINE_REVISION,
    compatible_metric_count: 2,
  });
  const forward = deriveTrendStatus(input({
    baseline: selected,
    comparisons: [comparison("git.change_frequency"), comparison("static.source_lines")],
  }));
  const reversed = deriveTrendStatus(input({
    baseline: selected,
    comparisons: [comparison("static.source_lines"), comparison("git.change_frequency")],
  }));

  assert.equal(forward.state, "prior-compatible-baseline-selected");
  assert.equal(forward.compatibility, "compatible");
  assert.equal(forward.comparison_binding_count, 2);
  assert.equal(forward.baseline.status, "selected");
  assert.match(forward.summary, /2 metric bindings/i);
  assert.match(forward.limitation, /no directional conclusion/i);
  assert.deepEqual(reversed, forward);
});

test("reports repository-history insufficiency only from explicit full-history proof", () => {
  const proven = deriveTrendStatus(input({
    history: history({ value: 1, scope: "full-repository" }),
  }));
  const configuredWindowOnly = deriveTrendStatus(input({
    history: history({ value: 1, scope: "configured-window" }),
  }));

  assert.equal(proven.state, "repository-history-insufficient");
  assert.match(proven.summary, /full-repository history proof contains one observed revision/i);
  assert.equal(configuredWindowOnly.state, "first-compatible-sei-observation");
  assert.match(configuredWindowOnly.limitation, /configured history window/i);
  assert.doesNotMatch(configuredWindowOnly.summary, /repository history is insufficient/i);
});

test("distinguishes an explicit incompatible prior baseline from unresolved evidence", () => {
  const incompatible = deriveTrendStatus(input({
    baseline: baseline({
      binding_kind: "explicit",
      status: "explicit",
      eligible: false,
      baseline_snapshot_id: BASELINE_SNAPSHOT_ID,
      baseline_repository_revision: BASELINE_REVISION,
    }),
  }));
  const unresolved = deriveTrendStatus(input({ baseline: null }));

  assert.equal(incompatible.state, "prior-baseline-incompatible");
  assert.equal(incompatible.compatibility, "incompatible");
  assert.match(incompatible.summary, /prior SEI baseline was supplied/i);
  assert.equal(unresolved.state, "unresolved");
  assert.equal(unresolved.compatibility, "unresolved");
  assert.equal(unresolved.baseline, null);
});

test("rejects open, forged, duplicate, and unbounded trend evidence", () => {
  const selected = baseline({
    status: "selected",
    eligible: true,
    baseline_snapshot_id: BASELINE_SNAPSHOT_ID,
    baseline_repository_revision: BASELINE_REVISION,
    compatible_metric_count: 1,
  });
  const invalid = [
    { ...input(), extra: true },
    input({ baseline: { ...baseline(), reason: "do not parse this" } }),
    input({ history: history({ state: "measured", value: 1, scope: "unknown" }) }),
    input({ baseline: selected, comparisons: [comparison("git.change_frequency", { baseline_snapshot_id: `sei-v1-${"e".repeat(64)}` })] }),
    input({ baseline: selected, comparisons: [comparison("git.change_frequency"), comparison("git.change_frequency")] }),
    input({ baseline: selected, comparisons: [] }),
    input({ history: history({ value: 1.5 }) }),
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => deriveTrendStatus(candidate),
      (error) => error?.code === "FAIL-TREND-STATUS",
    );
  }
});
