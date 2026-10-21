"use strict";

const canonicalSnapshot = require("./canonical-intelligence.json");
const { materializeSnapshot } = require("./intelligence-engine.js");
const incrementalState = require("./incremental-run-state.js");

const statePrivate = incrementalState[Symbol.for("sei.incremental-run-state.private.v2")];
const CONFIGURATION_HASH = "a".repeat(64);
const REVISIONS = Object.freeze(
  Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`c${index + 1}`, (index + 1).toString(16).repeat(40)])),
);
const PATHS = Object.freeze(["src/a.py", "src/b.py", "src/c.py", "src/d.py"]);
const PREDICTIVE_METHODS = Object.freeze([
  Object.freeze({ method_id: "sei-four-signal-composite-v1", method_kind: "sei-heuristic" }),
  Object.freeze({ method_id: "baseline-loc-v1", method_kind: "simple-baseline" }),
  Object.freeze({ method_id: "baseline-change-frequency-v1", method_kind: "simple-baseline" }),
  Object.freeze({ method_id: "baseline-churn-v1", method_kind: "simple-baseline" }),
  Object.freeze({ method_id: "baseline-complexity-v1", method_kind: "simple-baseline" }),
]);
const PREDICTIVE_TARGETS = Object.freeze([
  "future-modification",
  "repeated-modification",
  "high-churn",
]);
const PREDICTIVE_HORIZONS = Object.freeze([10, 25, 50]);
const FEATURE_DEFINITIONS = Object.freeze({
  loc: Object.freeze({
    metric_stem: "static.source_lines",
    definition_id: "sei.static.source_lines@1",
    unit: "lines",
    family: "structural_complexity",
    collector_id: "static-source",
    collector_version: "1.0.0",
    analyzer_identity: "sei.lexical-python@1",
    analyzer_version: "1.0.0",
    source_kind: "local-source",
  }),
  complexity: Object.freeze({
    metric_stem: "static.cyclomatic_complexity",
    definition_id: "sei.static.cyclomatic_complexity@1",
    unit: "cyclomatic-complexity-points",
    family: "structural_complexity",
    collector_id: "python-static-intelligence",
    collector_version: "1.0.0",
    analyzer_identity: "sei.python-ast@1",
    analyzer_version: "sei.python-ast@1",
    source_kind: "local-source",
  }),
  churn: Object.freeze({
    metric_stem: "git.churn",
    definition_id: "sei.git.churn@1",
    unit: "lines-changed",
    family: "repository_behavior",
    collector_id: "git-history",
    collector_version: "1.0.0",
    analyzer_identity: "sei.git-history@1",
    analyzer_version: "1.2.0",
    source_kind: "git-history",
  }),
  change_frequency: Object.freeze({
    metric_stem: "git.change_frequency",
    definition_id: "sei.git.change_frequency@1",
    unit: "revisions",
    family: "repository_behavior",
    collector_id: "git-history",
    collector_version: "1.0.0",
    analyzer_identity: "sei.git-history@1",
    analyzer_version: "1.2.0",
    source_kind: "git-history",
  }),
});

function metric(revision, filePath, feature, value) {
  const spec = FEATURE_DEFINITIONS[feature];
  return {
    metric_id: `${spec.metric_stem}:${filePath}`,
    definition_id: spec.definition_id,
    family: spec.family,
    subject: `file:${filePath}`,
    repository_revision: revision,
    value,
    unit: spec.unit,
    measurement: { status: "measured", completeness: 1, confidence: 1, reason: null },
    source: {
      kind: spec.source_kind,
      collector_id: spec.collector_id,
      collector_version: spec.collector_version,
      repository_revision: revision,
      command: null,
      artifact_refs: [`git:${revision}:${filePath}`],
      evidence_refs: [`git:${revision}:${filePath}`],
    },
    scope: {
      kind: "file",
      path: filePath,
      language: "python",
      generated_code: false,
      included_in_human_maintainability: true,
    },
    window: { kind: "revision", start: null, end: revision },
    analyzer_identity: spec.analyzer_identity,
    analyzer_version: spec.analyzer_version,
    comparability: {
      analyzer_identity: spec.analyzer_identity,
      analyzer_version: spec.analyzer_version,
      configuration_hash: CONFIGURATION_HASH,
      compatible_with_prior: true,
      reason: "same fixture analyzer and configuration binding",
    },
  };
}

function makeSnapshot(revision, rows) {
  const snapshot = structuredClone(canonicalSnapshot);
  snapshot.snapshot_id = "pending";
  snapshot.repository = {
    ...snapshot.repository,
    repository_id: "canonical-repository",
    revision,
    configuration_hash: CONFIGURATION_HASH,
    history_boundary: { kind: "revision-range", start: null, end: revision },
  };
  snapshot.collectors = [...new Map(Object.values(FEATURE_DEFINITIONS).map((spec) => [spec.collector_id, {
    collector_id: spec.collector_id,
    collector_version: spec.collector_version,
    status: "available",
    analyzer_identity: spec.analyzer_identity,
    analyzer_version: spec.analyzer_version,
    reason: null,
  }])).values()];
  snapshot.measurements = rows.flatMap((row) => Object.keys(FEATURE_DEFINITIONS)
    .map((feature) => metric(revision, row.path, feature, row[feature])));
  snapshot.risk_models = [];
  snapshot.profiles = [];
  snapshot.evidence_summary = {
    measurement_count: snapshot.measurements.length,
    status_counts: {
      measured: snapshot.measurements.length,
      inferred: 0,
      unavailable: 0,
      "not-applicable": 0,
      unverifiable: 0,
    },
  };
  snapshot.run_metadata = {
    generated_at: "2026-08-13T00:00:00.000Z",
    cache: { cache_key: "pending" },
  };
  return materializeSnapshot(snapshot);
}

function rowSet() {
  return [
    { path: PATHS[0], loc: 10, complexity: 100, churn: 100, change_frequency: 100 },
    { path: PATHS[1], loc: 100, complexity: 10, churn: 10, change_frequency: 10 },
    { path: PATHS[2], loc: 80, complexity: 80, churn: 80, change_frequency: 80 },
    { path: PATHS[3], loc: 1, complexity: 1, churn: 1, change_frequency: 1 },
  ];
}

function changed(filePath, added, deleted = 0, overrides = {}) {
  return {
    path: filePath,
    added,
    deleted,
    binary_change: false,
    change_kind: "modify",
    ...overrides,
  };
}

function commit(index, files = []) {
  return {
    revision: REVISIONS[`c${index}`],
    timestamp: `2026-01-${String(index).padStart(2, "0")}T00:00:00.000Z`,
    author: "fixture@example.invalid",
    is_merge: false,
    files,
  };
}

function fixtureCommits() {
  return [
    commit(1, PATHS.map((filePath) => changed(filePath, 1, 0, { change_kind: "add" }))),
    commit(2, [changed(PATHS[0], 9, 1), changed(PATHS[1], 5)]),
    commit(3, [changed(PATHS[0], 7, 3)]),
    commit(4),
    commit(5, [changed(PATHS[0], 2), changed(PATHS[1], 10)]),
    commit(6, [changed(PATHS[1], 12)]),
    commit(7),
    commit(8, [changed(PATHS[1], 21), changed(PATHS[2], 2)]),
    commit(9, [changed(PATHS[2], 2)]),
    // This boundary change is intentionally large. A correct forward fold
    // excludes the next cutoff commit itself, so it cannot leak into fold 2.
    commit(10, [changed(PATHS[3], 999)]),
  ];
}

function historyStage(commits = fixtureCommits()) {
  return statePrivate.createHistoryStage({
    binding: {
      repository_id: "canonical-repository",
      object_format: "sha1",
      history_kind: "revision-range",
      history_start: null,
      history_end: commits.at(-1)?.revision ?? REVISIONS.c10,
      collector_version: "1.0.0",
      analyzer_identity: "sei.git-history@1",
      analyzer_version: "1.2.0",
      configuration_hash: CONFIGURATION_HASH,
      temporal_policy_hash: `sha256:${"7".repeat(64)}`,
    },
    commits,
  });
}

function createForwardTemporalFixture({ rows = rowSet() } = {}) {
  const snapshots = [REVISIONS.c1, REVISIONS.c4, REVISIONS.c7, REVISIONS.c10]
    .map((revision) => makeSnapshot(revision, rows));
  return {
    revisions: REVISIONS,
    paths: PATHS,
    commits: fixtureCommits(),
    input: {
      schema_version: "sei.forward-temporal-evaluation-input@1",
      history_stage: historyStage(),
      snapshots,
      ranking_k: 1,
    },
  };
}

function createConstantScoreForwardTemporalFixture() {
  return createForwardTemporalFixture({
    rows: PATHS.map((filePath) => ({
      path: filePath,
      loc: 10,
      complexity: 10,
      churn: 10,
      change_frequency: 10,
    })),
  });
}

function createPartiallyConstantLocForwardTemporalFixture() {
  const rows = rowSet();
  const constantLocRows = rows.map((row) => ({ ...row, loc: 10 }));
  const commits = fixtureCommits().map((entry) => entry.revision === REVISIONS.c4
    ? commit(4, [changed(PATHS[0], 1)])
    : entry);
  const snapshots = [
    makeSnapshot(REVISIONS.c1, rows),
    makeSnapshot(REVISIONS.c3, constantLocRows),
    makeSnapshot(REVISIONS.c5, rows),
    makeSnapshot(REVISIONS.c7, rows),
    makeSnapshot(REVISIONS.c10, rows),
  ];
  return {
    revisions: REVISIONS,
    paths: PATHS,
    commits,
    input: {
      schema_version: "sei.forward-temporal-evaluation-input@1",
      history_stage: historyStage(commits),
      snapshots,
      ranking_k: 1,
    },
  };
}

function replaceHistory(fixture, commits) {
  return { ...fixture.input, history_stage: historyStage(commits) };
}

function promotionMetric(method, foldIndex, overrides = {}) {
  const developmentAveragePrecision = method.method_id === "sei-four-signal-composite-v1" ? 0.9 : 0.7;
  return {
    method_id: method.method_id,
    lift_at_k: foldIndex === 4 ? (method.method_id === "sei-four-signal-composite-v1" ? 2 : 1.5) : 1.25,
    average_precision: developmentAveragePrecision,
    ...overrides,
  };
}

function predictiveCutoffIds(horizon) {
  return Array.from({ length: 6 }, (_, index) => (
    index === 5
      ? `sei-v1-${"f".repeat(64)}`
      : `sei-v1-${horizon.toString(16).padStart(2, "0")}${index.toString(16)}${"0".repeat(61)}`
  ));
}

function promotionEvaluation(targetId, horizon) {
  const foldIds = Array.from({ length: 4 }, (_, index) => `${targetId}-${horizon}-fold-${index + 1}`);
  return {
    target_id: targetId,
    horizon_commits: horizon,
    cutoff_snapshot_ids: predictiveCutoffIds(horizon),
    development_fold_ids: foldIds.slice(0, 3),
    terminal_fold_id: foldIds[3],
    folds: foldIds.map((foldId, index) => ({
      fold_id: foldId,
      role: index === 3 ? "terminal-holdout" : "development",
      classes: { observations: 4, positive: 2, negative: 2 },
      methods: PREDICTIVE_METHODS.map((method) => promotionMetric(method, index + 1)),
    })),
  };
}

function createPredictivePromotionFixture() {
  return {
    schema_version: "sei.predictive-promotion-input@1",
    current_binding: {
      repository_id: "canonical-repository",
      revision: "f".repeat(40),
      snapshot_id: `sei-v1-${"f".repeat(64)}`,
      configuration_hash: CONFIGURATION_HASH,
    },
    evidence_binding: {
      repository_id: "canonical-repository",
      final_revision: "f".repeat(40),
      final_snapshot_id: `sei-v1-${"f".repeat(64)}`,
      configuration_hash: CONFIGURATION_HASH,
    },
    protocol: {
      evaluation_schema_version: "sei.forward-temporal-evaluation@3",
      candidate_registry_version: "sei.predictive-method-registry@1",
      target_schema_version: "sei.predictive-targets@1",
      evaluation_protocol_version: "sei.predictive-terminal-holdout@1",
      method_order: PREDICTIVE_METHODS.map((method) => method.method_id),
      target_order: PREDICTIVE_TARGETS.slice(),
      horizon_order: PREDICTIVE_HORIZONS.slice(),
      fallback_method_id: "baseline-change-frequency-v1",
      nomination_metric: "mean-average-precision-across-three-development-folds",
      nomination_tie_rule: "higher-mean-average-precision-then-predeclared-method-order",
      promotion_rule: "terminal-lift-at-k-greater-than-one-and-average-precision-not-lower-than-change-frequency-fallback",
      eligible_commit_rule: "all-branded-history-commits-including-merges-and-empty-commits",
      outcome_window_rule: "commits-strictly-after-cutoff-and-strictly-before-next-cutoff-with-boundary-cutoff-reserved",
      cutoff_selection_rule: "latest-six-chronologically-ordered-cutoff-snapshots-without-class-backfill",
      development_fold_count: 3,
      terminal_holdout_fold_count: 1,
      minimum_cutoff_snapshot_count: 6,
      ranking_k: 1,
    },
    horizon_readiness: PREDICTIVE_HORIZONS.map((horizon) => ({
      horizon_commits: horizon,
      cutoff_snapshot_count: 6,
      state: "READY",
    })),
    evaluations: PREDICTIVE_HORIZONS.flatMap((horizon) => (
      PREDICTIVE_TARGETS.map((targetId) => promotionEvaluation(targetId, horizon))
    )),
  };
}

function longRevision(index) {
  return (index + 1).toString(16).padStart(40, "0");
}

function longCommit(index) {
  const revision = longRevision(index);
  const timestamp = new Date(Date.UTC(2025, 0, 1 + index)).toISOString();
  const files = index === 0
    ? PATHS.map((filePath) => changed(filePath, 1, 0, { change_kind: "add" }))
    : [changed(PATHS[0], 10), changed(PATHS[1], 1)];
  return {
    revision,
    timestamp,
    author: "fixture@example.invalid",
    is_merge: false,
    files,
  };
}

function v3Rows() {
  return [
    { path: PATHS[0], loc: 100, complexity: 100, churn: 100, change_frequency: 100 },
    { path: PATHS[1], loc: 80, complexity: 80, churn: 80, change_frequency: 80 },
    { path: PATHS[2], loc: 10, complexity: 10, churn: 10, change_frequency: 10 },
    { path: PATHS[3], loc: 1, complexity: 1, churn: 1, change_frequency: 1 },
  ];
}

function createV3ForwardTemporalFixture({ cutoffSnapshotCounts = {} } = {}) {
  const counts = Object.fromEntries(PREDICTIVE_HORIZONS.map((horizon) => [
    horizon,
    cutoffSnapshotCounts[horizon] ?? 6,
  ]));
  const commitCount = Math.max(...PREDICTIVE_HORIZONS.map((horizon) => (
    (counts[horizon] - 1) * (horizon + 1) + 1
  )));
  const commits = Array.from({ length: commitCount }, (_, index) => longCommit(index));
  const rows = v3Rows();
  const snapshotByIndex = new Map();
  const snapshotAt = (index) => {
    if (!snapshotByIndex.has(index)) snapshotByIndex.set(index, makeSnapshot(longRevision(index), rows));
    return snapshotByIndex.get(index);
  };
  const finalIndex = commits.length - 1;
  const horizons = PREDICTIVE_HORIZONS.map((horizon) => ({
    horizon_commits: horizon,
    snapshots: Array.from({ length: counts[horizon] }, (_, index) => (
      snapshotAt(finalIndex - (counts[horizon] - 1 - index) * (horizon + 1))
    )),
  }));
  return {
    commits,
    input: {
      schema_version: "sei.forward-temporal-evaluation-input@2",
      history_stage: historyStage(commits),
      horizons,
      ranking_k: 1,
    },
  };
}

module.exports = {
  createConstantScoreForwardTemporalFixture,
  createForwardTemporalFixture,
  createPartiallyConstantLocForwardTemporalFixture,
  createPredictivePromotionFixture,
  createV3ForwardTemporalFixture,
  replaceHistory,
};
