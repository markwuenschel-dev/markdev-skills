"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const evaluator = require("./forward-temporal-evaluator.js");
const { evaluateForwardTemporal } = evaluator;
const evaluatorPrivate = evaluator[Symbol.for("sei.forward-temporal-evaluator.private.v1")];
const promotionPrivate = require("./predictive-promotion.js")[Symbol.for("sei.predictive-promotion.private.v1")];
const incrementalState = require("./incremental-run-state.js");
const statePrivate = incrementalState[Symbol.for("sei.incremental-run-state.private.v2")];
const intelligenceEngine = require("./intelligence-engine.js");
const enginePrivate = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")];
const { renderReport, verifyRenderedReport } = require("./report.js");
const reportPrivate = require("./report.js")[Symbol.for("sei.report.private.v1")];
const { derivePredictiveStatus } = require("./predictive-status.js");
const {
  createConstantScoreForwardTemporalFixture,
  createForwardTemporalFixture,
  createPartiallyConstantLocForwardTemporalFixture,
  createPredictivePromotionFixture,
  createV3ForwardTemporalFixture,
  replaceHistory,
} = require("./forward-temporal-fixtures.js");

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rehashV3Receipt(receipt) {
  const body = { ...receipt };
  delete body.receipt_sha256;
  receipt.receipt_sha256 = sha256(Buffer.from(stableStringify(body), "utf8"));
  return receipt;
}

function replaceV3HistoryWithAllSubjectsTouched(fixture, additions) {
  const history = statePrivate.readStage(fixture.input.history_stage, "history");
  const subjects = ["src/a.py", "src/b.py", "src/c.py", "src/d.py"];
  const commits = fixture.commits.map((commit, index) => ({
    ...commit,
    files: subjects.map((subject, subjectIndex) => ({
      path: subject,
      added: additions[subjectIndex],
      deleted: 0,
      binary_change: false,
      change_kind: index === 0 ? "add" : "modify",
    })),
  }));
  fixture.input.history_stage = statePrivate.createHistoryStage({
    binding: history.binding,
    commits,
  });
}

function recomputeV3OutcomeRankingClaims(outcome) {
  const metricFields = [
    "average_precision",
    "lift_at_k",
    "precision_at_k",
    "recall_at_k",
    "reciprocal_rank",
    "spearman_rank_correlation",
  ];
  for (const method of outcome.rankings) {
    const metrics = evaluatorPrivate.rankingMetrics(method.ranking, method.ranking_k);
    for (const field of metricFields) method[field] = metrics[field];
    method.metric_availability = structuredClone(metrics.metric_availability);
  }
  const sei = outcome.rankings[0];
  const comparisonFields = metricFields.filter((field) => field !== "reciprocal_rank");
  const comparison = (value, reference, isReference) => {
    if (value === null || reference === null) return { result: "unavailable", delta: null };
    if (isReference) return { result: "reference", delta: 0 };
    if (value === reference) return { result: "equal", delta: 0 };
    return { result: value > reference ? "better" : "worse", delta: value - reference };
  };
  for (const method of outcome.rankings) {
    method.comparisons_to_sei = Object.fromEntries(comparisonFields.map((field) => [
      field,
      comparison(method[field], sei[field], method.method_id === sei.method_id),
    ]));
    method.comparison_to_sei = {
      metric: "average_precision",
      ...method.comparisons_to_sei.average_precision,
    };
  }
}

function promotionEvaluationFromReceipt(record, outcomeId) {
  return {
    target_id: outcomeId,
    horizon_commits: record.horizon_commits,
    cutoff_snapshot_ids: record.cutoff_snapshot_bindings.map((binding) => binding.snapshot_id),
    development_fold_ids: record.development_fold_ids.slice(),
    terminal_fold_id: record.terminal_fold_id,
    folds: record.folds.map((fold) => {
      const outcome = fold.outcomes.find((entry) => entry.outcome_id === outcomeId);
      return {
        fold_id: fold.fold_id,
        role: fold.fold_id === record.terminal_fold_id ? "terminal-holdout" : "development",
        classes: structuredClone(outcome.holdout_classes),
        methods: outcome.rankings.map((ranking) => ({
          method_id: ranking.method_id,
          lift_at_k: ranking.lift_at_k,
          average_precision: ranking.average_precision,
        })),
      };
    }),
  };
}

function recomputeV3PromotionClaims(receipt, currentSnapshot) {
  const promotion = promotionPrivate.evaluatePredictivePromotion({
    schema_version: promotionPrivate.INPUT_SCHEMA_VERSION,
    current_binding: {
      repository_id: currentSnapshot.repository.repository_id,
      revision: currentSnapshot.repository.revision,
      snapshot_id: currentSnapshot.snapshot_id,
      configuration_hash: currentSnapshot.repository.configuration_hash,
    },
    evidence_binding: {
      repository_id: receipt.repository.repository_id,
      final_revision: receipt.repository.history_end_revision,
      final_snapshot_id: receipt.final_snapshot_binding.snapshot_id,
      configuration_hash: receipt.repository.configuration_hash,
    },
    protocol: receipt.protocol,
    horizon_readiness: receipt.horizons.map((record) => ({
      horizon_commits: record.horizon_commits,
      cutoff_snapshot_count: record.available_cutoff_snapshot_count,
      state: record.available_cutoff_snapshot_count >= promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT
        ? "READY"
        : "INSUFFICIENT_HISTORY",
    })),
    evaluations: receipt.horizons.flatMap((record) => (
      record.folds.length === 0
        ? []
        : promotionPrivate.TARGET_IDS.map((outcomeId) => promotionEvaluationFromReceipt(record, outcomeId))
    )),
  });
  for (const field of [
    "interpretation_boundary",
    "promotion_sha256",
    "promotions",
    "public_state",
    "readiness",
    "validated_selections",
  ]) receipt[field] = structuredClone(promotion[field]);
  return promotion;
}

function writeBundleArtifact(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, "utf8");
  return {
    path: relativePath.replaceAll("\\", "/"),
    sha256: sha256(Buffer.from(bytes, "utf8")),
    size_bytes: Buffer.byteLength(bytes),
  };
}

function writeForwardTemporalBundle(fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-forward-temporal-bundle-"));
  const historyDocument = statePrivate.readStage(fixture.input.history_stage, "history");
  const historyBytes = statePrivate.artifactForStage({
    output_root: root,
    repository_id: historyDocument.binding.repository_id,
    stage: fixture.input.history_stage,
  }).bytes;
  const cutoffSnapshots = fixture.input.snapshots.map((snapshot, index) => writeBundleArtifact(
    root,
    `cutoffs/${String(index).padStart(2, "0")}.json`,
    `${JSON.stringify(snapshot, null, 2)}\n`,
  ));
  const receipt = evaluateForwardTemporal(fixture.input);
  const bundle = {
    schema_version: "sei.forward-temporal-bundle@1",
    kind: "forward-temporal-evaluation-bundle",
    history_stage: writeBundleArtifact(root, "history/history-stage.json", historyBytes),
    cutoff_snapshots: cutoffSnapshots,
    receipt: writeBundleArtifact(root, "receipt/evaluation.json", `${JSON.stringify(receipt, null, 2)}\n`),
  };
  const bundlePath = path.join(root, "forward-temporal.bundle.json");
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { bundle, bundlePath, receipt, root };
}

function boundBundleInput(bundle) {
  return {
    bundle_path: bundle.bundlePath,
    expected_bundle_sha256: sha256(fs.readFileSync(bundle.bundlePath)),
  };
}

test("forward temporal evaluation derives future outcomes and preserves a losing SEI ranking", () => {
  const fixture = createForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);

  assert.equal(receipt.status, "evaluated");
  assert.equal(receipt.schema_version, "sei.forward-temporal-evaluation@2");
  assert.equal(receipt.folds.length, 2);
  assert.deepEqual(receipt.folds.map((fold) => [
    fold.training.outcome_end_revision,
    fold.holdout.cutoff_revision,
    fold.leakage_check.training_ends_before_holdout,
  ]), [
    [fixture.revisions.c3, fixture.revisions.c4, true],
    [fixture.revisions.c6, fixture.revisions.c7, true],
  ]);

  const firstRepeated = receipt.folds[0].outcomes
    .find((outcome) => outcome.outcome_id === "repeated-modification");
  const byMethod = new Map(firstRepeated.rankings.map((ranking) => [ranking.method_id, ranking]));
  assert.equal(byMethod.get("baseline-loc-v1").average_precision, 1);
  assert.equal(byMethod.get("sei-four-signal-composite-v1").average_precision, 1 / 3);
  assert.equal(byMethod.get("baseline-loc-v1").precision_at_k, 1);
  assert.equal(byMethod.get("baseline-loc-v1").recall_at_k, 1);
  assert.equal(byMethod.get("baseline-loc-v1").lift_at_k, 4);
  assert.equal(byMethod.get("baseline-loc-v1").spearman_rank_correlation, 0.7745966692414834);
  assert.deepEqual(byMethod.get("baseline-loc-v1").metric_availability, {
    precision_at_k: "available",
    recall_at_k: "available",
    lift_at_k: "available",
    average_precision: "available",
    spearman_rank_correlation: "available",
  });
  assert.deepEqual(byMethod.get("baseline-loc-v1").comparisons_to_sei, {
    precision_at_k: { result: "better", delta: 1 },
    recall_at_k: { result: "better", delta: 1 },
    lift_at_k: { result: "better", delta: 4 },
    average_precision: { result: "better", delta: 0.6666666666666667 },
    spearman_rank_correlation: { result: "better", delta: 1.0327955589886444 },
  });
  assert.equal(byMethod.get("baseline-loc-v1").comparison_to_sei.result, "better");
  assert.equal(byMethod.get("baseline-loc-v1").ranking[0].subject, "file:src/b.py");

  assert.equal(receipt.outcome_definitions
    .find((outcome) => outcome.outcome_id === "reliable-revert-or-fix-pattern").status, "unavailable");
  assert.doesNotMatch(JSON.stringify(receipt), /probabilit|defect/i);
});

test("fold receipts enumerate exact prior and holdout revisions without cutoff leakage", () => {
  const fixture = createForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);

  assert.deepEqual(receipt.folds.map((fold) => fold.training.outcome_revisions), [
    [fixture.revisions.c2, fixture.revisions.c3],
    [fixture.revisions.c2, fixture.revisions.c3, fixture.revisions.c5, fixture.revisions.c6],
  ]);
  assert.deepEqual(receipt.folds.map((fold) => fold.holdout.outcome_revisions), [
    [fixture.revisions.c5, fixture.revisions.c6],
    [fixture.revisions.c8, fixture.revisions.c9],
  ]);
  assert.deepEqual(receipt.folds.map((fold) => fold.holdout.cutoff_timestamp), [
    "2026-01-04T00:00:00.000Z",
    "2026-01-07T00:00:00.000Z",
  ]);
  assert.deepEqual(receipt.folds.map((fold) => fold.outcomes
    .find((outcome) => outcome.outcome_id === "high-churn").threshold.value), [20, 20]);
  const boundaryRecord = receipt.folds[1].outcomes
    .find((outcome) => outcome.outcome_id === "future-modification")
    .rankings[0].ranking.find((entry) => entry.subject === "file:src/d.py");
  assert.equal(boundaryRecord.observed_outcome, false);
  assert.equal(boundaryRecord.future_text_churn, 0);
});

test("evaluation is deterministic under caller input ordering and retains every simple baseline", () => {
  const fixture = createForwardTemporalFixture();
  const first = evaluateForwardTemporal(fixture.input);
  const reordered = evaluateForwardTemporal({ ...fixture.input, snapshots: fixture.input.snapshots.slice().reverse() });

  assert.deepEqual(reordered, first);
  assert.equal(first.receipt_sha256, "sha256:654623b95dca4ed165d8701e16ac08f655eeb1836bbe7951ac56be7e3bfc563e");
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(first.methods.map((method) => method.method_id), [
    "sei-four-signal-composite-v1",
    "baseline-loc-v1",
    "baseline-change-frequency-v1",
    "baseline-churn-v1",
    "baseline-complexity-v1",
  ]);
  const highChurn = first.evaluation.find((outcome) => outcome.outcome_id === "high-churn");
  assert.equal(highChurn.methods.find((method) => method.method_id === "baseline-loc-v1").comparison_to_sei.result, "better");
});

test("V3 evaluates the frozen target-horizon matrix with three development folds and one untouched terminal holdout", () => {
  const fixture = createV3ForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);
  const reordered = evaluateForwardTemporal({
    ...fixture.input,
    horizons: fixture.input.horizons.slice().reverse().map((entry) => ({
      ...entry,
      snapshots: entry.snapshots.slice().reverse(),
    })),
  });

  assert.equal(receipt.schema_version, "sei.forward-temporal-evaluation@3");
  assert.equal(receipt.kind, "forward-temporal-terminal-holdout-promotion-receipt");
  assert.equal(receipt.public_state, "VALIDATED_MODEL");
  assert.deepEqual(receipt.protocol.horizon_order, [10, 25, 50]);
  assert.deepEqual(receipt.protocol.target_order, [
    "future-modification",
    "repeated-modification",
    "high-churn",
  ]);
  assert.deepEqual(receipt.methods.map((method) => method.method_id), [
    "sei-four-signal-composite-v1",
    "baseline-loc-v1",
    "baseline-change-frequency-v1",
    "baseline-churn-v1",
    "baseline-complexity-v1",
  ]);
  assert.equal(receipt.horizons.length, 3);
  assert.equal(receipt.horizons.every((horizon) => (
    horizon.selected_cutoff_snapshot_count === 6
      && horizon.development_fold_ids.length === 3
      && !horizon.development_fold_ids.includes(horizon.terminal_fold_id)
      && horizon.folds.length === 4
  )), true);
  assert.equal(receipt.promotions.length, 9);
  assert.equal(receipt.current_forecasts.length, 9);
  assert.equal(receipt.current_forecasts.every((forecast) => (
    forecast.claim === "rank-only"
      && forecast.items.length === 1
      && Object.keys(forecast.items[0]).sort().join(",") === "path,percentile,rank,subject"
  )), true);
  assert.deepEqual(reordered, receipt);
  assert.equal(Object.isFrozen(receipt), true);
  assert.doesNotMatch(JSON.stringify(receipt), /probabilit|defect|causal|risk claim/i);
});

test("V3 records five cutoffs as explicit insufficient history without reading a terminal fold or emitting forecasts", () => {
  const fixture = createV3ForwardTemporalFixture();
  const receipt = evaluateForwardTemporal({
    ...fixture.input,
    horizons: fixture.input.horizons.map((entry) => ({
      ...entry,
      snapshots: entry.snapshots.slice(1),
    })),
  });

  assert.equal(receipt.schema_version, "sei.forward-temporal-evaluation@3");
  assert.equal(receipt.public_state, "NOT_READY");
  assert.equal(receipt.readiness.state, "NOT_READY");
  assert.equal(receipt.readiness.failure_code, "FAIL-PREDICTIVE-READINESS");
  assert.equal(receipt.promotions.every((entry) => (
    entry.state === "NOT_READY" && entry.terminal_holdout.state === "NOT_READ"
  )), true);
  assert.deepEqual(receipt.current_forecasts, []);
});

test("V3 all-unready horizons do not select complexity evidence or invoke development/terminal accessors", () => {
  const fixture = createV3ForwardTemporalFixture();
  const withoutComplexity = new Map();
  fixture.input.horizons = fixture.input.horizons.map((horizon) => ({
    ...horizon,
    snapshots: horizon.snapshots.slice(1).map((snapshot) => {
      if (withoutComplexity.has(snapshot.snapshot_id)) return withoutComplexity.get(snapshot.snapshot_id);
      const incomplete = structuredClone(snapshot);
      incomplete.measurements = incomplete.measurements.filter((metric) => (
        !["sei.static.cyclomatic_complexity@1", "sei.static.lexical_max_nesting_depth@1"]
          .includes(metric.definition_id)
      ));
      incomplete.evidence_summary.measurement_count = incomplete.measurements.length;
      incomplete.evidence_summary.status_counts.measured = incomplete.measurements.length;
      incomplete.snapshot_id = "pending";
      incomplete.run_metadata.cache.cache_key = "pending";
      const canonical = intelligenceEngine.materializeSnapshot(incomplete);
      withoutComplexity.set(snapshot.snapshot_id, canonical);
      return canonical;
    }),
  }));
  const forbidden = {};
  Object.defineProperty(forbidden, "evidence", {
    get() {
      throw new Error("terminal/development evidence was accessed for an unready horizon");
    },
  });

  const phase = evaluatorPrivate.materializeV3TerminalAfterDevelopment([], () => forbidden.evidence);
  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);

  assert.deepEqual(phase, { nominations: [], terminal_evidence: null });
  assert.equal(receipt.public_state, "NOT_READY");
  assert.equal(receipt.promotions.every((promotion) => promotion.state === "NOT_READY"), true);
  assert.deepEqual(receipt.current_forecasts, []);
  assert.equal(evaluatorPrivate.verifyV3Receipt(receipt, currentSnapshot), receipt);
});

test("V3 materializes terminal evidence only after all development nominations are fixed", () => {
  const promotionFixture = createPredictivePromotionFixture();
  const developmentEvaluations = promotionFixture.evaluations
    .filter((evaluation) => evaluation.horizon_commits === 10)
    .map((evaluation) => ({
      target_id: evaluation.target_id,
      horizon_commits: evaluation.horizon_commits,
      development_fold_ids: evaluation.development_fold_ids,
      folds: evaluation.folds.slice(0, 3),
    }));
  const terminal = {};
  let lockedNominations = null;
  Object.defineProperty(terminal, "evidence", {
    get() {
      assert.equal(lockedNominations.length, 3);
      assert.equal(lockedNominations.every((entry) => entry.state === "NOMINATED"), true);
      throw new Error("terminal-access-sentinel");
    },
  });

  assert.throws(
    () => evaluatorPrivate.materializeV3TerminalAfterDevelopment(
      developmentEvaluations,
      (nominations) => {
        lockedNominations = nominations;
        return terminal.evidence;
      },
    ),
    /terminal-access-sentinel/,
  );
});

test("V3 does not call the terminal factory when every development selection is unavailable", () => {
  const promotionFixture = createPredictivePromotionFixture();
  const developmentEvaluations = promotionFixture.evaluations
    .filter((evaluation) => evaluation.horizon_commits === 10)
    .map((evaluation) => {
      const development = structuredClone(evaluation);
      development.folds = development.folds.slice(0, 3);
      development.folds[0].methods.at(-1).average_precision = null;
      return {
        target_id: development.target_id,
        horizon_commits: development.horizon_commits,
        development_fold_ids: development.development_fold_ids,
        folds: development.folds,
      };
    });
  let terminalFactoryCalls = 0;
  let phase = null;

  assert.doesNotThrow(() => {
    phase = evaluatorPrivate.materializeV3TerminalAfterDevelopment(
      developmentEvaluations,
      () => {
        terminalFactoryCalls += 1;
        throw new Error("terminal factory must not run without one real nominee");
      },
    );
  });
  assert.equal(terminalFactoryCalls, 0);
  assert.equal(phase.nominations.every((entry) => entry.state === "READY_NOT_EVALUATED"), true);
  assert.equal(phase.terminal_evidence, null);
});

test("V3 all-no-nomination receipt contains development evidence but no terminal outcomes", () => {
  const fixture = createV3ForwardTemporalFixture();
  replaceV3HistoryWithAllSubjectsTouched(fixture, [10, 10, 10, 10]);

  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);

  assert.equal(receipt.public_state, "READY_NOT_EVALUATED");
  assert.equal(receipt.promotions.every((promotion) => (
    promotion.state === "READY_NOT_EVALUATED"
      && promotion.nomination === null
      && promotion.terminal_holdout.state === "NOT_READ"
      && promotion.terminal_holdout.fold_id === null
  )), true);
  assert.equal(receipt.horizons.every((horizon) => (
    horizon.folds.length === 3
      && horizon.development_fold_ids.length === 3
      && horizon.terminal_fold_id === null
  )), true);
  assert.deepEqual(receipt.current_forecasts, []);
  assert.equal(evaluatorPrivate.verifyV3Receipt(receipt, currentSnapshot), receipt);
});

test("V3 mixed development results materialize terminal evidence only for nominated targets", () => {
  const fixture = createV3ForwardTemporalFixture();
  replaceV3HistoryWithAllSubjectsTouched(fixture, [10, 1, 1, 1]);

  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);
  const unNominated = receipt.promotions.filter((promotion) => (
    promotion.target_id !== "high-churn"
  ));
  const nominated = receipt.promotions.filter((promotion) => (
    promotion.target_id === "high-churn"
  ));

  assert.equal(receipt.public_state, "VALIDATED_MODEL");
  assert.equal(unNominated.every((promotion) => (
    promotion.state === "READY_NOT_EVALUATED"
      && promotion.nomination === null
      && promotion.terminal_holdout.state === "NOT_READ"
      && promotion.terminal_holdout.fold_id === null
  )), true);
  assert.equal(nominated.every((promotion) => (
    promotion.state === "VALIDATED_MODEL"
      && promotion.nomination !== null
      && promotion.terminal_holdout.state === "EVALUATED"
  )), true);
  assert.equal(receipt.horizons.every((horizon) => (
    horizon.folds.length === 4
      && horizon.folds.at(-1).outcomes.length === 1
      && horizon.folds.at(-1).outcomes[0].outcome_id === "high-churn"
      && horizon.folds.at(-1).outcomes[0].rankings.every((ranking) => (
        ranking.ranking.every((row) => (
          Object.hasOwn(row, "future_text_churn")
            && !Object.hasOwn(row, "future_touch_count")
        ))
      ))
  )), true);
  assert.equal(receipt.current_forecasts.every((forecast) => forecast.target_id === "high-churn"), true);
  assert.equal(evaluatorPrivate.verifyV3Receipt(receipt, currentSnapshot), receipt);

  const leakedTerminal = evaluateForwardTemporal({
    schema_version: "sei.forward-temporal-evaluation-input@1",
    history_stage: fixture.input.history_stage,
    snapshots: fixture.input.horizons[0].snapshots,
    ranking_k: fixture.input.ranking_k,
  }).folds.at(-1).outcomes.find((outcome) => outcome.outcome_id === "future-modification");
  const forged = structuredClone(receipt);
  forged.horizons[0].folds.at(-1).outcomes.unshift(structuredClone(leakedTerminal));
  rehashV3Receipt(forged);
  assert.throws(
    () => evaluatorPrivate.verifyV3Receipt(forged, currentSnapshot, receipt),
    (error) => error?.code === "FAIL-PREDICTIVE-BINDING",
  );
});

test("V3 deterministically selects the latest six cutoffs without class backfill and bounds admission", () => {
  const fixture = createV3ForwardTemporalFixture({ cutoffSnapshotCounts: { 10: 7 } });
  const receipt = evaluateForwardTemporal(fixture.input);
  const tenInput = fixture.input.horizons.find((horizon) => horizon.horizon_commits === 10);
  const tenReceipt = receipt.horizons.find((horizon) => horizon.horizon_commits === 10);

  assert.equal(tenReceipt.available_cutoff_snapshot_count, 7);
  assert.equal(tenReceipt.selected_cutoff_snapshot_count, 6);
  assert.deepEqual(
    tenReceipt.cutoff_snapshot_bindings.map((binding) => binding.snapshot_id),
    tenInput.snapshots.slice(-6).map((snapshot) => snapshot.snapshot_id),
  );
  assert.equal(tenReceipt.folds.every((fold, index) => (
    fold.holdout.outcome_revisions.length === 10
      && fold.training.outcome_revisions.length === (index + 1) * 10
  )), true);

  const tooMany = createV3ForwardTemporalFixture();
  tooMany.input.horizons[0].snapshots = Array.from(
    { length: 257 },
    () => tooMany.input.horizons[0].snapshots[0],
  );
  assert.throws(
    () => evaluateForwardTemporal(tooMany.input),
    (error) => error?.code === "FAIL-PREDICTIVE-READINESS" && /between 1 and 256/i.test(error.message),
  );
});

test("V3 verification binds only receipt-derived selections and projects a versioned V9 status summary", () => {
  const fixture = createV3ForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);
  const binding = evaluatorPrivate.bindAutomaticEvaluation({
    receipt,
    current_snapshot: currentSnapshot,
    current_rankings: receipt.current_forecasts,
    selected_methods: receipt.validated_selections,
  });
  const projection = evaluatorPrivate.projectBoundForwardTemporalEvaluation(binding, currentSnapshot);
  const summary = evaluatorPrivate.projectBoundForwardTemporalReceiptSummary(binding);
  const status = derivePredictiveStatus({
    current_snapshot: {
      repository_id: currentSnapshot.repository.repository_id,
      revision: currentSnapshot.repository.revision,
      configuration_hash: currentSnapshot.repository.configuration_hash,
      snapshot_id: currentSnapshot.snapshot_id,
    },
    receipt: summary,
  });

  assert.equal(projection.state, "VALIDATED_MODEL");
  assert.equal(projection.forecast_state, "terminally-validated");
  assert.deepEqual(projection.current_rankings, receipt.current_forecasts);
  assert.equal(summary.schema_version, "sei.predictive-status-receipt@2");
  assert.equal(summary.source_schema_version, "sei.forward-temporal-evaluation@3");
  assert.equal(status.state, "VALIDATED_MODEL");
  assert.equal(status.outcomes.length, 9);

  assert.throws(
    () => evaluatorPrivate.bindAutomaticEvaluation({
      receipt,
      current_snapshot: currentSnapshot,
      current_rankings: [],
      selected_methods: receipt.validated_selections,
    }),
    (error) => error?.code === "FAIL-PREDICTIVE-BINDING",
  );
  const stale = structuredClone(receipt);
  stale.protocol.evaluation_protocol_version = "sei.predictive-terminal-holdout@0";
  assert.throws(
    () => evaluatorPrivate.verifyV3Receipt(stale, currentSnapshot),
    (error) => error?.code === "FAIL-PREDICTIVE-STALE",
  );
});

test("V3 verification rejects self-rehashed semantic claims and open nested fold evidence", () => {
  const fixture = createV3ForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);
  const overclaim = structuredClone(receipt);
  overclaim.score_kind = "calibrated-defect-probability";
  overclaim.interpretation_boundary = "causal defect risk probability claim";
  overclaim.limitations = ["probability of a future defect"];
  rehashV3Receipt(overclaim);
  const openFold = structuredClone(receipt);
  openFold.horizons[0].folds[0].undeclared_probability_claim = true;
  rehashV3Receipt(openFold);
  const openReason = structuredClone(receipt);
  openReason.horizons[0].folds[0].outcomes[0].reason = "causal defect risk probability";
  rehashV3Receipt(openReason);
  const openAvailability = structuredClone(receipt);
  openAvailability.horizons[0].folds[0].outcomes[0]
    .rankings[0].metric_availability.precision_at_k = "probability-of-defect";
  rehashV3Receipt(openAvailability);
  const openRevision = structuredClone(receipt);
  openRevision.horizons[0].folds[0].holdout.outcome_revisions[0] = { probability_claim: 0.99 };
  rehashV3Receipt(openRevision);
  const openInterval = structuredClone(receipt);
  openInterval.horizons[0].folds[0].training.interval_ids[0] = { causal_risk: true };
  rehashV3Receipt(openInterval);

  for (const candidate of [
    overclaim,
    openFold,
    openReason,
    openAvailability,
    openRevision,
    openInterval,
  ]) {
    assert.throws(
      () => evaluatorPrivate.verifyV3Receipt(candidate, currentSnapshot, receipt),
      (error) => error?.code === "FAIL-PREDICTIVE-BINDING",
    );
  }
});

test("V3 verification recomputes terminal metrics and rejects method cohort drift", () => {
  const fixture = createV3ForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);
  const staleMetrics = structuredClone(receipt);
  const terminalRankings = staleMetrics.horizons[0].folds.at(-1).outcomes[0].rankings;
  const terminalRanking = terminalRankings[0].ranking;
  const positiveIndex = terminalRanking.findIndex((entry) => entry.observed_outcome);
  const negativeIndex = terminalRanking.findIndex((entry) => !entry.observed_outcome);
  const positiveSubject = terminalRanking[positiveIndex].subject;
  const negativeSubject = terminalRanking[negativeIndex].subject;
  for (const method of terminalRankings) {
    method.ranking.find((entry) => entry.subject === positiveSubject).observed_outcome = false;
    method.ranking.find((entry) => entry.subject === negativeSubject).observed_outcome = true;
  }
  rehashV3Receipt(staleMetrics);
  const cohortMismatch = structuredClone(receipt);
  cohortMismatch.horizons[0].folds.at(-1).outcomes[0].rankings[1].ranking[0].subject = "file:attacker.js";
  rehashV3Receipt(cohortMismatch);

  assert.equal(receipt.public_state, "VALIDATED_MODEL");

  for (const candidate of [staleMetrics, cohortMismatch]) {
    assert.throws(
      () => evaluatorPrivate.verifyV3Receipt(candidate, currentSnapshot, receipt),
      (error) => error?.code === "FAIL-PREDICTIVE-BINDING",
    );
  }
});

test("V3 verification binds observed outcome labels to the subject factual cohort and target rule", () => {
  const fixture = createV3ForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);
  const forged = structuredClone(receipt);
  const originalPromotionSha256 = forged.promotion_sha256;
  const outcome = forged.horizons[0].folds[0].outcomes.find((entry) => (
    entry.outcome_id === "future-modification"
  ));
  const referenceRanking = outcome.rankings[0].ranking;
  const touched = referenceRanking.find((entry) => entry.future_touch_count === 10);
  const untouched = referenceRanking.find((entry) => entry.future_touch_count === 0);
  assert.equal(touched.observed_outcome, true);
  assert.equal(untouched.observed_outcome, false);

  for (const method of outcome.rankings) {
    method.ranking.find((entry) => entry.subject === touched.subject).observed_outcome = false;
    method.ranking.find((entry) => entry.subject === untouched.subject).observed_outcome = true;
  }
  recomputeV3OutcomeRankingClaims(outcome);
  const rebuiltPromotion = recomputeV3PromotionClaims(forged, currentSnapshot);
  rehashV3Receipt(forged);

  assert.equal(rebuiltPromotion.public_state, "VALIDATED_MODEL");
  assert.equal(rebuiltPromotion.promotions.find((promotion) => (
    promotion.target_id === "future-modification" && promotion.horizon_commits === 10
  )).state, "VALIDATED_MODEL");
  assert.notEqual(forged.promotion_sha256, originalPromotionSha256);
  assert.notEqual(forged.receipt_sha256, receipt.receipt_sha256);
  assert.throws(
    () => evaluatorPrivate.verifyV3Receipt(forged, currentSnapshot, receipt),
    (error) => error?.code === "FAIL-PREDICTIVE-BINDING" && /outcome.*factual|target rule/i.test(error.message),
  );
});

test("V3 deserialized verification source-binds touch, churn, and threshold facts to a replay-owned receipt", () => {
  const fixture = createV3ForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);

  const touchedFact = structuredClone(receipt);
  const futureOutcome = touchedFact.horizons[0].folds[0].outcomes.find((outcome) => (
    outcome.outcome_id === "future-modification"
  ));
  const touchedSubject = futureOutcome.rankings[0].ranking.find((row) => (
    row.observed_outcome
  )).subject;
  for (const method of futureOutcome.rankings) {
    method.ranking.find((row) => row.subject === touchedSubject).future_touch_count += 1;
  }
  rehashV3Receipt(touchedFact);

  const churnFact = structuredClone(receipt);
  const churnOutcome = churnFact.horizons[0].folds[0].outcomes.find((outcome) => (
    outcome.outcome_id === "high-churn"
  ));
  const churnSubject = churnOutcome.rankings[0].ranking.find((row) => (
    row.observed_outcome
  )).subject;
  for (const method of churnOutcome.rankings) {
    method.ranking.find((row) => row.subject === churnSubject).future_text_churn += 1;
  }
  rehashV3Receipt(churnFact);

  const thresholdFact = structuredClone(receipt);
  const thresholdOutcome = thresholdFact.horizons[0].folds[0].outcomes.find((outcome) => (
    outcome.outcome_id === "high-churn"
  ));
  const thresholdRows = thresholdOutcome.rankings[0].ranking;
  const minimumPositive = Math.min(...thresholdRows.filter((row) => row.observed_outcome)
    .map((row) => row.future_text_churn));
  const maximumNegative = Math.max(...thresholdRows.filter((row) => !row.observed_outcome)
    .map((row) => row.future_text_churn));
  thresholdOutcome.threshold.value = (minimumPositive + maximumNegative) / 2;
  assert.notEqual(thresholdOutcome.threshold.value, receipt.horizons[0].folds[0]
    .outcomes.find((outcome) => outcome.outcome_id === "high-churn").threshold.value);
  rehashV3Receipt(thresholdFact);

  for (const candidate of [touchedFact, churnFact, thresholdFact]) {
    assert.throws(
      () => evaluatorPrivate.verifyV3Receipt(candidate, currentSnapshot, candidate.receipt_sha256),
      (error) => error?.code === "FAIL-PREDICTIVE-BINDING" && /replay|package-branded/i.test(error.message),
    );
    assert.throws(
      () => evaluatorPrivate.verifyV3Receipt(candidate, currentSnapshot, receipt),
      (error) => error?.code === "FAIL-PREDICTIVE-BINDING" && /replay|canonical/i.test(error.message),
    );
  }
});

test("V3 binding owns verified receipt rankings instead of mutable caller aliases", () => {
  const fixture = createV3ForwardTemporalFixture();
  const receipt = evaluateForwardTemporal(fixture.input);
  const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);
  const serialized = structuredClone(receipt);
  assert.throws(
    () => evaluatorPrivate.verifyV3Receipt(serialized, currentSnapshot, receipt.receipt_sha256),
    (error) => error?.code === "FAIL-PREDICTIVE-BINDING" && /replay|package-branded/i.test(error.message),
  );
  const verified = evaluatorPrivate.verifyV3Receipt(serialized, currentSnapshot, receipt);
  const callerRankings = structuredClone(verified.current_forecasts);
  const callerSelections = structuredClone(verified.validated_selections);
  const expectedPath = verified.current_forecasts[0].items[0].path;
  const binding = evaluatorPrivate.bindAutomaticEvaluation({
    receipt: verified,
    current_snapshot: currentSnapshot,
    current_rankings: callerRankings,
    selected_methods: callerSelections,
  });

  serialized.current_forecasts[0].items[0].path = "attacker/serialized-alias.js";
  callerRankings[0].items[0].path = "attacker/caller-alias.js";

  const projection = evaluatorPrivate.projectBoundForwardTemporalEvaluation(binding, currentSnapshot);
  assert.equal(verified, receipt);
  assert.equal(projection.current_rankings[0].items[0].path, expectedPath);
  assert.equal(Object.isFrozen(verified.current_forecasts[0].items[0]), true);
});

test("V3 current forecasts reuse the exact complexity definition selected before terminal evaluation", () => {
  const fixture = createV3ForwardTemporalFixture();
  const finalSnapshots = new Set(fixture.input.horizons.map((horizon) => horizon.snapshots.at(-1)));
  let lexicalFinalSnapshot = null;
  for (const snapshot of finalSnapshots) {
    for (const metric of snapshot.measurements) {
      if (metric.definition_id !== "sei.static.cyclomatic_complexity@1") continue;
      metric.definition_id = "sei.static.lexical_max_nesting_depth@1";
      metric.metric_id = metric.metric_id.replace("cyclomatic_complexity", "lexical_max_nesting_depth");
      metric.unit = "lexical-brace-or-indentation-depth";
    }
    snapshot.snapshot_id = "pending";
    snapshot.run_metadata.cache.cache_key = "pending";
    lexicalFinalSnapshot = intelligenceEngine.materializeSnapshot(snapshot);
  }
  fixture.input.horizons = fixture.input.horizons.map((horizon) => ({
    ...horizon,
    snapshots: [...horizon.snapshots.slice(0, -1), lexicalFinalSnapshot],
  }));

  assert.throws(
    () => evaluateForwardTemporal(fixture.input),
    (error) => error?.code === "FAIL-PREDICTIVE-BINDING" && /current snapshot lacks/i.test(error.message),
  );
});

test("V3 input rejects open records and stale snapshot configuration with predictive failure codes", () => {
  const fixture = createV3ForwardTemporalFixture();
  assert.throws(
    () => evaluateForwardTemporal({ ...fixture.input, selected_method_id: "caller-choice" }),
    (error) => error?.code === "FAIL-PREDICTIVE-BINDING",
  );

  const stale = {
    ...fixture.input,
    horizons: fixture.input.horizons.map((horizon, horizonIndex) => ({
      ...horizon,
      snapshots: horizon.snapshots.map((snapshot, snapshotIndex) => (
        horizonIndex === 0 && snapshotIndex === 0
          ? { ...snapshot, repository: { ...snapshot.repository, configuration_hash: "b".repeat(64) } }
          : snapshot
      )),
    })),
  };
  assert.throws(
    () => evaluateForwardTemporal(stale),
    (error) => error?.code === "FAIL-PREDICTIVE-STALE",
  );
});

test("aggregate evaluation reports deterministic ranking metrics and direct baseline comparisons", () => {
  const receipt = evaluateForwardTemporal(createForwardTemporalFixture().input);
  const repeated = receipt.evaluation.find((outcome) => outcome.outcome_id === "repeated-modification");
  const methods = new Map(repeated.methods.map((method) => [method.method_id, method]));

  assert.equal(repeated.status, "evaluated");
  assert.equal(methods.get("sei-four-signal-composite-v1").mean_lift_at_k, 2);
  assert.equal(methods.get("sei-four-signal-composite-v1").mean_average_precision, 2 / 3);
  assert.equal(methods.get("sei-four-signal-composite-v1").mean_spearman_rank_correlation, 0.25819888974716115);
  const evidence = {
    contributing_fold_count: 2,
    contributing_fold_ids: ["forward-fold-1", "forward-fold-2"],
  };
  assert.deepEqual(methods.get("baseline-loc-v1").comparisons_to_sei, {
    mean_precision_at_k: { result: "equal", delta: 0, ...evidence },
    mean_recall_at_k: { result: "equal", delta: 0, ...evidence },
    mean_lift_at_k: { result: "equal", delta: 0, ...evidence },
    mean_average_precision: { result: "better", delta: 0.08333333333333337, ...evidence },
    mean_spearman_rank_correlation: { result: "better", delta: 0.25819888974716104, ...evidence },
  });
});

test("caller-authored outcomes and unbranded history facts fail closed", () => {
  const fixture = createForwardTemporalFixture();
  assert.throws(
    () => evaluateForwardTemporal({ ...fixture.input, labels: [] }),
    /FAIL-FORWARD-TEMPORAL-CALLER-LABEL.*forbidden/,
  );
  assert.throws(
    () => evaluateForwardTemporal({ ...fixture.input, history_stage: {} }),
    /FAIL-FORWARD-TEMPORAL-EVIDENCE.*package-branded/,
  );
});

test("structurally insufficient folds fail closed", () => {
  const fixture = createForwardTemporalFixture();
  assert.throws(
    () => evaluateForwardTemporal({ ...fixture.input, snapshots: fixture.input.snapshots.slice(0, 2) }),
    /FAIL-FORWARD-TEMPORAL-INSUFFICIENT.*at least 3 canonical cutoff snapshots/,
  );
});

test("one forward fold and degenerate classes report not established metrics without false zeroes", () => {
  const fixture = createForwardTemporalFixture();
  const oneFold = evaluateForwardTemporal({
    ...replaceHistory(fixture, fixture.commits.slice(0, 7)),
    snapshots: fixture.input.snapshots.slice(0, 3),
  });
  assert.equal(oneFold.status, "not_established");
  assert.match(oneFold.reason, /lack two forward folds/);
  assert.equal(oneFold.evaluation.every((outcome) => outcome.status === "not_established"), true);
  assert.equal(oneFold.evaluation.every((outcome) => outcome.methods.every((method) => (
    method.mean_average_precision === null
      && method.metric_availability.mean_average_precision === "insufficient_folds"
  ))), true);

  const outcomeRevisions = new Set([
    fixture.revisions.c2,
    fixture.revisions.c3,
    fixture.revisions.c5,
    fixture.revisions.c6,
    fixture.revisions.c8,
    fixture.revisions.c9,
  ]);
  const allPositive = fixture.commits.map((commit) => outcomeRevisions.has(commit.revision)
    ? {
        ...commit,
        files: fixture.paths.map((filePath) => ({
          path: filePath,
          added: 1,
          deleted: 0,
          binary_change: false,
          change_kind: "modify",
        })),
      }
    : commit);
  const degenerate = evaluateForwardTemporal(replaceHistory(fixture, allPositive));
  assert.equal(degenerate.status, "not_established");
  const firstFuture = degenerate.folds[0].outcomes
    .find((outcome) => outcome.outcome_id === "future-modification");
  assert.equal(firstFuture.status, "not_established");
  assert.equal(firstFuture.rankings.every((ranking) => ranking.average_precision === null), true);
  assert.equal(firstFuture.rankings.every((ranking) => ranking.spearman_rank_correlation === null), true);
  assert.equal(firstFuture.rankings.every((ranking) => (
    ranking.metric_availability.average_precision === "unavailable_class_distribution"
      && ranking.metric_availability.spearman_rank_correlation === "unavailable_class_distribution"
  )), true);
  const sei = firstFuture.rankings.find((ranking) => ranking.method_id === "sei-four-signal-composite-v1");
  assert.deepEqual(sei.comparisons_to_sei.average_precision, { result: "unavailable", delta: null });

  const allNegative = fixture.commits.map((commit) => outcomeRevisions.has(commit.revision)
    ? { ...commit, files: [] }
    : commit);
  const absentOutcomes = evaluateForwardTemporal(replaceHistory(fixture, allNegative));
  const absentFuture = absentOutcomes.folds[0].outcomes
    .find((outcome) => outcome.outcome_id === "future-modification");
  assert.equal(absentFuture.status, "not_established");
  assert.equal(absentFuture.rankings.every((ranking) => (
    ranking.precision_at_k === 0
      && ranking.recall_at_k === null
      && ranking.lift_at_k === null
      && ranking.average_precision === null
      && ranking.metric_availability.recall_at_k === "unavailable_no_positive_outcomes"
  )), true);
});

test("ranking correlation is unavailable when deterministic scores have no variation", () => {
  const receipt = evaluateForwardTemporal(createConstantScoreForwardTemporalFixture().input);
  for (const fold of receipt.folds) {
    for (const outcome of fold.outcomes) {
      for (const ranking of outcome.rankings) {
        assert.equal(ranking.spearman_rank_correlation, null);
        assert.equal(ranking.metric_availability.spearman_rank_correlation, "unavailable_constant_ranking");
      }
    }
  }
});

test("aggregate comparisons use the same eligible folds for both methods", () => {
  const receipt = evaluateForwardTemporal(createPartiallyConstantLocForwardTemporalFixture().input);
  const future = receipt.evaluation.find((outcome) => outcome.outcome_id === "future-modification");
  const methods = new Map(future.methods.map((method) => [method.method_id, method]));
  const sei = methods.get("sei-four-signal-composite-v1");
  const loc = methods.get("baseline-loc-v1");
  const evidence = {
    contributing_fold_count: 2,
    contributing_fold_ids: ["forward-fold-2", "forward-fold-3"],
  };

  assert.deepEqual(
    receipt.folds.map((fold) => fold.outcomes
      .find((outcome) => outcome.outcome_id === "future-modification").status),
    ["evaluated", "evaluated", "evaluated"],
  );
  assert.deepEqual(
    receipt.folds.map((fold) => fold.outcomes
      .find((outcome) => outcome.outcome_id === "future-modification").rankings
      .find((ranking) => ranking.method_id === "baseline-loc-v1").metric_availability
      .spearman_rank_correlation),
    ["unavailable_constant_ranking", "available", "available"],
  );
  assert.deepEqual(
    receipt.folds.map((fold) => fold.outcomes
      .find((outcome) => outcome.outcome_id === "future-modification").rankings
      .find((ranking) => ranking.method_id === "sei-four-signal-composite-v1").metric_availability
      .spearman_rank_correlation),
    ["available", "available", "available"],
  );
  assert.deepEqual(sei.metric_coverage.mean_spearman_rank_correlation, evidence);
  assert.deepEqual(loc.metric_coverage.mean_spearman_rank_correlation, evidence);
  assert.equal(sei.mean_spearman_rank_correlation, 0.09450735287639841);
  assert.equal(loc.mean_spearman_rank_correlation, 0.8345119301206996);
  assert.deepEqual(
    loc.comparisons_to_sei.mean_spearman_rank_correlation,
    { result: "better", delta: 0.7400045772443011, ...evidence },
  );
});

test("ambiguous history time and incomplete binary churn fail closed", () => {
  const fixture = createForwardTemporalFixture();
  const tiedTime = fixture.commits.map((commit) => commit.revision === fixture.revisions.c3
    ? { ...commit, timestamp: "2026-01-02T00:00:00.000Z" }
    : commit);
  assert.throws(
    () => evaluateForwardTemporal(replaceHistory(fixture, tiedTime)),
    /FAIL-FORWARD-TEMPORAL-LEAKAGE.*strictly increasing/,
  );

  const binary = fixture.commits.map((commit) => commit.revision === fixture.revisions.c5
    ? {
        ...commit,
        files: commit.files.map((file, index) => index === 0
          ? { ...file, added: null, deleted: null, binary_change: true }
          : file),
      }
    : commit);
  assert.throws(
    () => evaluateForwardTemporal(replaceHistory(fixture, binary)),
    /FAIL-FORWARD-TEMPORAL-OUTCOME.*binary future churn/,
  );
});

test("rename lineage is followed across both observed future touches", () => {
  const fixture = createForwardTemporalFixture();
  const renamedPath = "src/b-renamed.py";
  const renamed = fixture.commits.map((commit) => {
    if (commit.revision === fixture.revisions.c5) {
      return {
        ...commit,
        files: commit.files.map((file) => file.path === "src/b.py"
          ? {
              path: renamedPath,
              previous_path: "src/b.py",
              added: 10,
              deleted: 0,
              binary_change: false,
              change_kind: "rename",
            }
          : file),
      };
    }
    if (commit.revision === fixture.revisions.c6) {
      return {
        ...commit,
        files: [{
          path: "src/b.py",
          previous_path: renamedPath,
          added: 12,
          deleted: 0,
          binary_change: false,
          change_kind: "rename",
        }],
      };
    }
    return commit;
  });
  const receipt = evaluateForwardTemporal(replaceHistory(fixture, renamed));
  const repeated = receipt.folds[0].outcomes.find((outcome) => outcome.outcome_id === "repeated-modification");
  const b = repeated.rankings[0].ranking.find((entry) => entry.subject === "file:src/b.py");
  assert.equal(b.observed_outcome, true);
  assert.equal(b.future_touch_count, 2);
});

test("closed forward-temporal bundles are independently re-evaluated and bind their current canonical cutoff", (t) => {
  assert.equal(typeof evaluatorPrivate.loadForwardTemporalBundle, "function");
  assert.equal(typeof evaluatorPrivate.projectBoundForwardTemporalEvaluation, "function");
  const fixture = createForwardTemporalFixture();
  const bundle = writeForwardTemporalBundle(fixture);
  t.after(() => fs.rmSync(bundle.root, { recursive: true, force: true }));

  const binding = evaluatorPrivate.loadForwardTemporalBundle(boundBundleInput(bundle));
  const projection = evaluatorPrivate.projectBoundForwardTemporalEvaluation(binding, fixture.input.snapshots.at(-1));

  assert.equal(projection.state, "evaluated");
  assert.equal(projection.receipt_sha256, bundle.receipt.receipt_sha256);
  assert.equal(projection.forward_fold_count, 2);
  assert.deepEqual(projection.outcomes.map((outcome) => outcome.outcome_id), [
    "future-modification",
    "repeated-modification",
    "high-churn",
  ]);
  for (const outcome of projection.outcomes) {
    assert.deepEqual(outcome.methods.map((method) => method.method_id), [
      "sei-four-signal-composite-v1",
      "baseline-loc-v1",
      "baseline-change-frequency-v1",
      "baseline-churn-v1",
      "baseline-complexity-v1",
    ]);
  }
  const future = projection.outcomes.find((outcome) => outcome.outcome_id === "future-modification");
  assert.equal(future.methods.find((method) => method.method_id === "baseline-change-frequency-v1")
    .comparison_to_composite.result, "equal");
  assert.throws(
    () => evaluatorPrivate.projectBoundForwardTemporalEvaluation(binding, fixture.input.snapshots[0]),
    /FAIL-FORWARD-TEMPORAL-BUNDLE.*final cutoff does not bind the current canonical snapshot/,
  );
});

test("forward-temporal bundles reject a forged expected receipt and unsafe artifact reference", (t) => {
  const fixture = createForwardTemporalFixture();
  const bundle = writeForwardTemporalBundle(fixture);
  t.after(() => fs.rmSync(bundle.root, { recursive: true, force: true }));

  const receiptPath = path.join(bundle.root, bundle.bundle.receipt.path);
  const forgedReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  forgedReceipt.evaluation[0].methods[1].mean_average_precision = 99;
  const forgedBytes = `${JSON.stringify(forgedReceipt, null, 2)}\n`;
  fs.writeFileSync(receiptPath, forgedBytes, "utf8");
  bundle.bundle.receipt = {
    ...bundle.bundle.receipt,
    size_bytes: Buffer.byteLength(forgedBytes),
    sha256: sha256(Buffer.from(forgedBytes, "utf8")),
  };
  fs.writeFileSync(bundle.bundlePath, `${JSON.stringify(bundle.bundle, null, 2)}\n`, "utf8");
  assert.throws(
    () => evaluatorPrivate.loadForwardTemporalBundle(boundBundleInput(bundle)),
    /FAIL-FORWARD-TEMPORAL-BUNDLE.*receipt does not exactly equal the independently re-evaluated bundle artifacts/,
  );

  const safe = writeForwardTemporalBundle(fixture);
  t.after(() => fs.rmSync(safe.root, { recursive: true, force: true }));
  safe.bundle.history_stage.path = "../history-stage.json";
  fs.writeFileSync(safe.bundlePath, `${JSON.stringify(safe.bundle, null, 2)}\n`, "utf8");
  assert.throws(
    () => evaluatorPrivate.loadForwardTemporalBundle(boundBundleInput(safe)),
    /FAIL-FORWARD-TEMPORAL-BUNDLE.*parent path segments/,
  );
});

test("forward-temporal bundle loading rejects a same-size manifest swap after input binding", (t) => {
  const fixture = createForwardTemporalFixture();
  const bundle = writeForwardTemporalBundle(fixture);
  t.after(() => fs.rmSync(bundle.root, { recursive: true, force: true }));
  const initialBytes = fs.readFileSync(bundle.bundlePath);
  const expectedBundleSha256 = sha256(initialBytes);
  const swapped = initialBytes.toString("utf8").replace(
    '"kind": "forward-temporal-evaluation-bundle"',
    '"kind":"forward-temporal-evaluation-bundle" ',
  );
  assert.equal(Buffer.byteLength(swapped), initialBytes.length);
  fs.writeFileSync(bundle.bundlePath, swapped, "utf8");

  assert.throws(
    () => evaluatorPrivate.loadForwardTemporalBundle({
      bundle_path: bundle.bundlePath,
      expected_bundle_sha256: expectedBundleSha256,
    }),
    /FAIL-FORWARD-TEMPORAL-BUNDLE.*bundle bytes do not match the expected initial input binding/,
  );
});

test("an evaluated predictive report requires its exact package-branded bundle binding", (t) => {
  const fixture = createForwardTemporalFixture();
  const bundle = writeForwardTemporalBundle(fixture);
  t.after(() => fs.rmSync(bundle.root, { recursive: true, force: true }));
  const binding = evaluatorPrivate.loadForwardTemporalBundle(boundBundleInput(bundle));
  const snapshot = fixture.input.snapshots.at(-1);
  const html = renderReport(snapshot, { predictive_binding: binding });
  const island = /<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/.exec(html);

  assert.ok(island);
  const projection = JSON.parse(island[1]);
  assert.equal(projection.predictive_intelligence.state, "evaluated");
  assert.equal(projection.predictive_intelligence.receipt_sha256, bundle.receipt.receipt_sha256);
  assert.equal(projection.predictive_intelligence.outcomes.length, 3);
  assert.equal(verifyRenderedReport(html, snapshot).ok, false);
  assert.match(
    verifyRenderedReport(html, snapshot).errors.join("\n"),
    /evaluated predictive intelligence requires an expected package-branded predictive binding/,
  );
  assert.match(
    verifyRenderedReport(html, projection.source.snapshot_sha256, { predictive_binding: binding }).errors.join("\n"),
    /requires the expected canonical snapshot, not only its digest/,
  );
  assert.deepEqual(
    verifyRenderedReport(html, snapshot, { predictive_binding: binding }),
    { ok: true, errors: [] },
  );

  const artifact = enginePrivate.canonicalArtifactFromSnapshot(snapshot);
  const predictiveArtifactReport = reportPrivate.renderReportFromCanonicalArtifact(artifact, { predictive_binding: binding });
  const defaultArtifactReport = reportPrivate.renderReportFromCanonicalArtifact(artifact);
  assert.notEqual(predictiveArtifactReport, defaultArtifactReport);
  assert.deepEqual(
    reportPrivate.verifyRenderedReportFromCanonicalArtifact(predictiveArtifactReport, artifact, { predictive_binding: binding }),
    { ok: true, errors: [] },
  );
  assert.equal(
    reportPrivate.verifyRenderedReportFromCanonicalArtifact(predictiveArtifactReport, artifact).ok,
    false,
  );
});
