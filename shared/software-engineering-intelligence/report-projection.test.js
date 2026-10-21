"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const canonicalSnapshot = require("./canonical-intelligence.json");
const { createV3ForwardTemporalFixture } = require("./forward-temporal-fixtures.js");
const { evaluateAutomatic } = require("./predictive-auto.js");
const forwardTemporalPrivate = require("./forward-temporal-evaluator.js")[Symbol.for("sei.forward-temporal-evaluator.private.v1")];
const {
  deriveRiskModelContractHash,
  materializeSnapshot,
} = require("./intelligence-engine.js");
const { deriveHotspots } = require("./interpretation.js");
const reportProjection = require("./report-projection.js");
const { LIMITS, projectReport, validateReportProjection } = reportProjection;
const reportProjectionPrivate = reportProjection[Symbol.for("sei.report-projection.private.v1")];
const V9_PREDICTIVE_STATES = new Set([
  "NOT_READY",
  "READY_NOT_EVALUATED",
  "VALIDATED_BASELINE",
  "VALIDATED_MODEL",
  "NO_USEFUL_SIGNAL",
  "STALE",
  "INCOMPATIBLE",
]);

function measuredMetric({ metricId, definitionId, family, subject, value, unit, scope }) {
  const metric = structuredClone(canonicalSnapshot.measurements[0]);
  metric.metric_id = metricId;
  metric.definition_id = definitionId;
  metric.family = family;
  metric.subject = subject;
  metric.value = value;
  metric.unit = unit;
  metric.scope = scope;
  metric.source.artifact_refs = [scope.path];
  metric.source.evidence_refs = [scope.path];
  return metric;
}

function boundedFixture() {
  const draft = structuredClone(canonicalSnapshot);
  draft.snapshot_id = "pending";
  draft.run_metadata.cache.cache_key = "pending";
  const measurements = [];
  for (let index = 0; index < 70; index += 1) {
    const path = `src/file-${String(index).padStart(2, "0")}.js`;
    const scope = { kind: "file", path, language: "javascript", generated_code: false, included_in_human_maintainability: true };
    measurements.push(
      measuredMetric({
        metricId: `static.source_lines:${path}`,
        definitionId: "sei.static.source_lines@1",
        family: "structural_complexity",
        subject: `file:${path}`,
        value: index + 1,
        unit: "lines",
        scope,
      }),
      measuredMetric({
        metricId: `git.churn:${path}`,
        definitionId: "sei.git.churn@1",
        family: "repository_behavior",
        subject: `file:${path}`,
        value: (index + 1) * 2,
        unit: "lines-changed",
        scope,
      }),
    );
  }
  for (let index = 0; index < 30; index += 1) {
    measurements.push(measuredMetric({
      metricId: `static.python.cyclomatic_complexity_p90:partition-${String(index).padStart(2, "0")}`,
      definitionId: "sei.static.python.cyclomatic_complexity_p90@1",
      family: "structural_complexity",
      subject: `repository:${draft.repository.repository_id}`,
      value: index + 1,
      unit: "cyclomatic-complexity-points",
      scope: { kind: "repository", path: ".", language: "python", generated_code: false, included_in_human_maintainability: true },
    }));
  }
  for (let index = 0; index < 25; index += 1) {
    measurements.push(measuredMetric({
      metricId: `static.python.dependency.node_count:partition-${String(index).padStart(2, "0")}`,
      definitionId: "sei.static.python.dependency.node_count@1",
      family: "dependency_topology",
      subject: `repository:${draft.repository.repository_id}`,
      value: index + 1,
      unit: "modules",
      scope: { kind: "repository", path: ".", language: "python", generated_code: false, included_in_human_maintainability: true },
    }));
  }
  for (let index = 0; index < 15; index += 1) {
    measurements.push(measuredMetric({
      metricId: `static.duplication.clone_family_count:partition-${String(index).padStart(2, "0")}`,
      definitionId: "sei.static.duplication.clone_family_count@1",
      family: "structural_duplication",
      subject: `repository:${draft.repository.repository_id}`,
      value: index,
      unit: "clone-families",
      scope: { kind: "repository", path: ".", language: "javascript", generated_code: false, included_in_human_maintainability: true },
    }));
  }
  draft.measurements = measurements;
  draft.evidence_summary = {
    measurement_count: measurements.length,
    status_counts: { measured: measurements.length, inferred: 0, unavailable: 0, "not-applicable": 0, unverifiable: 0 },
  };
  const withoutModel = materializeSnapshot(draft);
  const hotspots = deriveHotspots(withoutModel);
  const evidenceRefs = [...new Set(measurements.flatMap((metric) => metric.source.evidence_refs))].sort();
  const withModel = structuredClone(withoutModel);
  withModel.snapshot_id = "pending";
  withModel.run_metadata.cache.cache_key = "pending";
  withModel.risk_models = [{
    risk_model_id: "heuristic-v1",
    model_version: "1.0.0",
    model_contract_hash: deriveRiskModelContractHash("heuristic-v1"),
    model_status: "heuristic",
    calibration: null,
    result: {
      result_id: `heuristic-v1:${withModel.repository.revision}`,
      kind: "heuristic_hotspot_vectors",
      status: "available",
      repository_revision: withModel.repository.revision,
      evidence_metric_ids: measurements.map((metric) => metric.metric_id).sort(),
      evidence_refs: evidenceRefs,
      interpretation_boundary: hotspots.interpretation_boundary,
      records: hotspots.features.map((feature) => ({
        subject: feature.subject,
        features: feature.vector,
        hotspot_signals: feature.hotspot_signals,
      })),
    },
  }];
  return materializeSnapshot(withModel);
}

function v3MemoryStore() {
  const promotions = new Map();
  const digest = (bytes) => `sha256:${require("node:crypto").createHash("sha256").update(bytes).digest("hex")}`;
  return {
    readPromotion({ key }) {
      const promotion = promotions.get(key);
      if (!promotion) return null;
      return {
        manifest: { key, binding: promotion.binding },
        objects: promotion.objects.map((object) => ({ ...object, size: Buffer.byteLength(object.bytes), digest: digest(object.bytes) })),
      };
    },
    publishPromotion({ key, binding, objects }) {
      promotions.set(key, { binding, objects: objects.map((object) => ({ ...object })) });
    },
  };
}

test("report projection is a bounded deterministic human view with honest empty states", () => {
  const first = projectReport(canonicalSnapshot);
  const second = projectReport(structuredClone(canonicalSnapshot));

  assert.deepEqual(second, first);
  assert.equal(first.schema_version, "sei.report-projection@3");
  assert.equal(first.source.snapshot_id, canonicalSnapshot.snapshot_id);
  assert.match(first.source.snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.evidence.statuses.map(({ status }) => status), [
    "measured",
    "inferred",
    "unavailable",
    "not-applicable",
    "unverifiable",
  ]);
  assert.equal(first.scatter.state, "unavailable");
  assert.deepEqual(first.scatter.points, []);
  assert.equal(first.views.coupling.state, "unavailable");
  assert.equal(first.predictive_intelligence.state, "NOT_READY");
  assert.equal(first.predictive_intelligence.default_horizon_commits, 25);
  assert.deepEqual(first.predictive_intelligence.current_rankings, []);
  assert.equal(first.predictive_status.state, "not-yet-evaluated");
  assert.equal(first.predictive_status.evaluation_exists, false);
  assert.equal(first.trend_status.state, "unresolved");
  assert.equal(Object.hasOwn(first, "measurements"), false);
  assert.equal(Object.hasOwn(first, "profiles"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") < 64 * 1024);
});

test("V9 predictive projection uses explicit state vocabulary and default horizon", () => {
  const projection = projectReport(canonicalSnapshot);
  assert.equal(projection.predictive_intelligence.state, "NOT_READY");
  assert.equal(projection.predictive_intelligence.default_horizon_commits, 25);
  assert.deepEqual(projection.predictive_intelligence.available_horizons, []);
  assert.deepEqual(projection.predictive_intelligence.current_rankings, []);
  assert.equal(projection.predictive_intelligence.forecast_state, "readiness");
  assert.deepEqual(projection.predictive_intelligence.validation.coverage, {
    available_horizon_count: 0,
    evaluated_horizon_count: 0,
    default_horizon_evaluated: false,
  });
  assert.ok(projection.predictive_intelligence.limitations.length > 0);
  assert.equal(validateReportProjection(projection).ok, true);
});

test("V9 projection consumes only the opaque automatic binding and keeps rank-only forecasts bounded", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = v3MemoryStore();
  const current = fixture.input.horizons[0].snapshots.at(-1);
  const byRevision = new Map(fixture.input.horizons.flatMap((horizon) => horizon.snapshots)
    .map((snapshot) => [snapshot.repository.revision, snapshot]));
  const result = evaluateAutomatic({
    mode: "required",
    output_root: process.cwd(),
    state_root: process.cwd(),
    repository_id: current.repository.repository_id,
    configuration_hash: current.repository.configuration_hash,
    history_stage: fixture.input.history_stage,
    current_snapshot: current,
    artifact_store: store,
    cutoff_builder: ({ required_revisions }) => required_revisions.map((revision) => ({ snapshot: byRevision.get(revision) })),
    ranking_k: fixture.input.ranking_k,
  });
  assert.equal(result.status, "evaluated");
  const projection = reportProjectionPrivate.projectValidatedSnapshot(current, { predictive_binding: result.binding });
  assert.ok(V9_PREDICTIVE_STATES.has(projection.predictive_intelligence.state));
  assert.equal(projection.predictive_intelligence.default_horizon_commits, 25);
  assert.ok(projection.predictive_intelligence.horizons.every((horizon) => [10, 25, 50].includes(horizon.horizon_commits)));
  assert.ok(projection.predictive_intelligence.current_rankings.every((ranking) => ranking.claim === "rank-only"));
  assert.equal(projection.predictive_intelligence.validation.development_fold_count, 3);
  assert.equal(projection.predictive_intelligence.validation.terminal_holdout_fold_count, 1);
  assert.equal(projection.predictive_intelligence.validation.coverage.available_horizon_count, 3);
  assert.equal(projection.predictive_intelligence.validation.coverage.evaluated_horizon_count, 3);
  assert.doesNotMatch(JSON.stringify(projection.visual_datasets), /"metric_id"/);
  assert.deepEqual(validateReportProjection(projection), { ok: true, errors: [] });
});

test("branded automatic readiness projects NOT_READY and never the legacy readiness state", () => {
  const binding = forwardTemporalPrivate.bindAutomaticReadiness({
    current_snapshot: canonicalSnapshot,
    reason: "fewer than three compatible development folds are available",
    available_snapshot_count: 2,
  });
  const projection = reportProjectionPrivate.projectValidatedSnapshot(canonicalSnapshot, { predictive_binding: binding });
  assert.equal(projection.predictive_intelligence.state, "NOT_READY");
  assert.notEqual(projection.predictive_intelligence.state, "not-established");
  assert.equal(projection.predictive_intelligence.forecast_state, "readiness");
  assert.deepEqual(projection.predictive_intelligence.current_rankings, []);
  assert.deepEqual(validateReportProjection(projection), { ok: true, errors: [] });
});

test("stale and incompatible V9 bindings remain bounded and suppress current forecasts", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = v3MemoryStore();
  const current = fixture.input.horizons[0].snapshots.at(-1);
  const byRevision = new Map(fixture.input.horizons.flatMap((horizon) => horizon.snapshots)
    .map((snapshot) => [snapshot.repository.revision, snapshot]));
  const result = evaluateAutomatic({
    mode: "required",
    output_root: process.cwd(),
    state_root: process.cwd(),
    repository_id: current.repository.repository_id,
    configuration_hash: current.repository.configuration_hash,
    history_stage: fixture.input.history_stage,
    current_snapshot: current,
    artifact_store: store,
    cutoff_builder: ({ required_revisions }) => required_revisions.map((revision) => ({ snapshot: byRevision.get(revision) })),
    ranking_k: fixture.input.ranking_k,
  });
  const stale = structuredClone(current);
  stale.repository.revision = "b".repeat(40);
  const incompatible = structuredClone(current);
  incompatible.repository.repository_id = `${current.repository.repository_id}-other`;
  for (const [label, snapshot, expected] of [
    ["stale", stale, "STALE"],
    ["incompatible", incompatible, "INCOMPATIBLE"],
  ]) {
    const projection = reportProjectionPrivate.projectValidatedSnapshot(snapshot, { predictive_binding: result.binding });
    const predictive = projection.predictive_intelligence;
    assert.equal(predictive.state, expected, label);
    assert.equal(predictive.forecast_state, expected.toLowerCase(), label);
    assert.deepEqual(predictive.current_rankings, [], label);
    assert.ok(predictive.outcomes.length > 0, label);
    assert.ok(predictive.outcomes.every((outcome) => [10, 25, 50].includes(outcome.horizon_commits)), label);
    assert.ok(predictive.outcomes.every((outcome) => ["NOT_READ", "EVALUATED", "INSUFFICIENT_CLASSES"].includes(outcome.terminal_state)), label);
    assert.ok(predictive.outcomes.every((outcome) => outcome.forecast_item_count === 0), label);
    assert.deepEqual(validateReportProjection(projection), { ok: true, errors: [] });
  }
});

test("V9 aggregate terminal state preserves NOT_READ and distinguishes no-class terminal evidence", () => {
  const projectV9 = reportProjectionPrivate.projectV9PredictiveState;
  const notRead = projectV9({
    state: "NOT_READY",
    reason: "cutoff history is incomplete",
    source: {
      state: "NOT_READY",
      outcomes: [{
        target_id: "future-modification",
        horizon_commits: 25,
        state: "NOT_READY",
        terminal_holdout: { state: "NOT_READ" },
      }],
      current_rankings: [],
      selected_methods: [],
      forward_fold_count: 0,
    },
    predictiveStatus: null,
  });
  assert.equal(notRead.validation.terminal_state, "NOT_READ");

  const insufficientClasses = projectV9({
    state: "NO_USEFUL_SIGNAL",
    reason: "terminal holdout had insufficient classes",
    source: {
      state: "NO_USEFUL_SIGNAL",
      outcomes: [{
        target_id: "future-modification",
        horizon_commits: 25,
        state: "NO_USEFUL_SIGNAL",
        terminal_holdout: { state: "INSUFFICIENT_CLASSES" },
      }],
      current_rankings: [],
      selected_methods: [],
      forward_fold_count: 4,
    },
    predictiveStatus: null,
  });
  assert.equal(insufficientClasses.validation.terminal_state, "INSUFFICIENT_CLASSES");
});

test("predictive projection rejects an unbound caller-supplied receipt", () => {
  assert.throws(
    () => reportProjectionPrivate.projectValidatedSnapshot(canonicalSnapshot, {
      predictive_binding: { receipt: { schema_version: "sei.forward-temporal-evaluation@3" } },
    }),
    /FAIL-PREDICTIVE|FAIL-FORWARD-TEMPORAL/,
  );
});

test("first compatible observation projects significant Git history context", () => {
  const draft = structuredClone(canonicalSnapshot);
  draft.snapshot_id = "pending";
  draft.run_metadata.trend_baseline = {
    binding_kind: "automatic",
    status: "established",
    eligible: true,
    baseline_snapshot_id: null,
    baseline_repository_revision: null,
    compatible_metric_count: 0,
    historical_context: {
      kind: "significant-git-history",
      event_kind: "commit",
      repository_revision: "a".repeat(40),
      short_revision: "aaaaaaaaaaaa",
      subject: "introduce service architecture",
      author: "SEI fixture",
      authored_at: "2026-08-15T00:00:00Z",
      commit_distance: 2,
      parent_count: 1,
      is_merge: false,
      changed_file_count: 3,
      additions: 120,
      deletions: 10,
      text_churn: 130,
      significance_basis: "at-least-3-changed-files",
    },
    reason: "automatic baseline established for a later compatible run; no prior compatible strict ancestor observation selected",
  };
  const snapshot = materializeSnapshot(draft);
  const projection = projectReport(snapshot);
  assert.equal(projection.trend_status.state, "first-compatible-sei-observation");
  assert.equal(projection.trend_status.historical_context.short_revision, "aaaaaaaaaaaa");
  assert.match(projection.trend_status.summary, /Significant prior Git change found/);
  assert.equal(projection.trend_primary.historical_context.changed_file_count, 3);
  assert.deepEqual(validateReportProjection(projection), { ok: true, errors: [] });
});

test("V7 projection leads with semantic capability evidence and keeps raw evidence in its explorer", () => {
  const projection = projectReport(canonicalSnapshot);

  assert.equal(projection.schema_version, "sei.report-projection@3");
  assert.ok(projection.repository_overview);
  assert.ok(Array.isArray(projection.capability_coverage.capabilities));
  assert.ok(projection.capability_coverage.capabilities.every((capability) => (
    typeof capability.title === "string"
      && typeof capability.evidence_state === "string"
      && typeof capability.summary === "string"
      && typeof capability.next_evidence === "string"
  )));
  assert.ok(projection.complexity.empty_state);
  assert.ok(projection.scatter.empty_state);
  assert.ok(projection.investigations.empty_state);
  assert.ok(projection.investigations.items.every((item) => item.kind !== "temporal-coupling"));
  assert.ok(projection.evidence_explorer);
  assert.equal(projection.predictive_status.state, "not-yet-evaluated");
  assert.equal(projection.trend_status.state, "unresolved");
  assert.equal(projection.evidence_explorer.measurement_summary, projection.evidence);
  assert.equal(projection.evidence_explorer.raw_views.coupling, projection.views.coupling);
  assert.deepEqual(validateReportProjection(projection), { ok: true, errors: [] });
});

test("report projection retains an honestly partial package-bound predictive evaluation", () => {
  const projection = structuredClone(projectReport(canonicalSnapshot));
  projection.predictive_intelligence = {
    state: "partially-evaluated",
    reason: "one or more outcome aggregates lack two forward folds with both mechanically observed classes",
    receipt_sha256: `sha256:${"a".repeat(64)}`,
    bundle_sha256: `sha256:${"b".repeat(64)}`,
    ranking_k: 1,
    forward_fold_count: 2,
    interpretation_boundary: "mechanically observed future repository modifications and text churn only; no causal, incident, or quality claim",
    outcomes: [{
      outcome_id: "future-modification",
      state: "partially-evaluated",
      fold_count: 2,
      evaluated_fold_count: 1,
      methods: [],
    }],
  };
  projection.predictive_status = {
    predictive_status_version: "sei.predictive-status@1",
    state: "evaluated-current",
    evaluation_exists: true,
    compatibility: "compatible",
    exact_snapshot_participation: true,
    receipt: {
      receipt_sha256: `sha256:${"a".repeat(64)}`,
      digest_status: "declared-not-recomputed",
      final_revision: canonicalSnapshot.repository.revision,
      forward_fold_count: 2,
      cutoff_snapshot_count: 4,
    },
    outcomes: [{
      outcome_id: "future-modification",
      state: "partially-evaluated",
      evaluated_fold_count: 1,
      baseline_vs_composite: {
        basis: "forward-fold ranking-score comparison",
        baseline_count: 0,
        baseline_better_count: 0,
        composite_better_count: 0,
        tied_count: 0,
        unavailable_count: 0,
        summary: "No baseline ranking-score comparison is available.",
      },
    }],
    summary: "A compatible predictive evaluation includes this exact snapshot as the final cutoff.",
  };

  assert.equal(projection.predictive_intelligence.state, "partially-evaluated");
  assert.deepEqual(validateReportProjection(projection), { ok: true, errors: [] });
  assert.throws(
    () => projectReport(canonicalSnapshot, { predictive_receipt: projection.predictive_status.receipt }),
    /public projection does not accept predictive evidence/,
  );

  const rogue = structuredClone(projection);
  rogue.predictive_intelligence = {
    state: "not-established",
    reason: "no validated forward-temporal evaluation is bound to this canonical snapshot",
  };
  rogue.predictive_status.evaluation_exists = false;
  assert.equal(validateReportProjection(rogue).ok, false);
});

test("package-private projection bypasses public snapshot validation for its trusted caller", () => {
  assert.equal(typeof reportProjectionPrivate?.projectValidatedSnapshot, "function");
  const untrusted = structuredClone(canonicalSnapshot);
  untrusted.snapshot_id = "not-a-canonical-snapshot";

  assert.throws(
    () => projectReport(untrusted),
    /FAIL-REPORT-PROJECTION-SNAPSHOT/,
  );
  const projection = reportProjectionPrivate.projectValidatedSnapshot(untrusted);
  assert.equal(projection.source.snapshot_id, "not-a-canonical-snapshot");
  assert.deepEqual(validateReportProjection(projection), { ok: true, errors: [] });
});

test("report projection orders and truncates every high-cardinality visual surface", () => {
  const projection = projectReport(boundedFixture());

  assert.equal(projection.scatter.points.length, LIMITS.scatter);
  assert.equal(projection.scatter.omitted_count, 10);
  assert.equal(projection.scatter.points[0].subject, "file:src/file-69.js");
  assert.equal(projection.evidence_explorer.raw_views.complexity.distributions.length, LIMITS.complexity_distributions);
  assert.equal(projection.evidence_explorer.raw_views.complexity.distribution_omitted_count, 6);
  assert.equal(projection.views.topology.items.length, LIMITS.topology);
  assert.equal(projection.views.topology.omitted_count, 5);
  assert.equal(projection.views.duplication.items.length, LIMITS.duplication);
  assert.equal(projection.views.duplication.omitted_count, 3);
  assert.ok(projection.investigations.items.length <= LIMITS.investigations);
  assert.deepEqual(validateReportProjection(projection), { ok: true, errors: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") < 64 * 1024);
});

test("top complexity projection is reserved for concrete subjects instead of aggregate maxima", () => {
  const snapshot = boundedFixture();
  const aggregate = structuredClone(snapshot.measurements[0]);
  aggregate.metric_id = "static.python.cyclomatic_complexity_max:production";
  aggregate.definition_id = "sei.static.python.cyclomatic_complexity_max@1";
  aggregate.subject = `repository:${snapshot.repository.repository_id}`;
  aggregate.value = 10_000;
  aggregate.scope = {
    kind: "repository",
    path: ".",
    language: "python",
    generated_code: false,
    included_in_human_maintainability: true,
  };
  const subjectMetric = structuredClone(aggregate);
  subjectMetric.metric_id = "static.cyclomatic_complexity:src/example.py";
  subjectMetric.definition_id = "sei.static.cyclomatic_complexity@1";
  subjectMetric.subject = "file:src/example.py";
  subjectMetric.value = 7;
  subjectMetric.scope = {
    kind: "file",
    path: "src/example.py",
    language: "python",
    generated_code: false,
    included_in_human_maintainability: true,
  };
  const draft = structuredClone(snapshot);
  draft.snapshot_id = "pending";
  draft.run_metadata.cache.cache_key = "pending";
  draft.measurements.push(aggregate, subjectMetric);
  draft.evidence_summary.measurement_count += 2;
  draft.evidence_summary.status_counts.measured += 2;

  const projection = projectReport(materializeSnapshot(draft));

  const rawComplexity = projection.evidence_explorer.raw_views.complexity;
  assert.ok(rawComplexity.distributions.some((item) => item.metric_id === aggregate.metric_id));
  assert.ok(rawComplexity.top_items.length > 0);
  assert.ok(rawComplexity.top_items.every((item) => item.subject.startsWith("file:") || item.subject.startsWith("python-callable:")));
  assert.equal(rawComplexity.top_items.some((item) => item.metric_id === aggregate.metric_id), false);
});
