"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const predictiveStatus = require("./predictive-status.js");
const {
  PREDICTIVE_STATUS_VERSION,
  derivePredictiveStatus,
} = predictiveStatus;

const CURRENT = Object.freeze({
  repository_id: "fixture-repository",
  revision: "a".repeat(40),
  configuration_hash: "b".repeat(64),
  snapshot_id: `sei-v1-${"c".repeat(64)}`,
});
const EARLIEST_SNAPSHOT = `sei-v1-${"1".repeat(64)}`;
const EARLIER_SNAPSHOT = `sei-v1-${"2".repeat(64)}`;
const PREVIOUS_SNAPSHOT = `sei-v1-${"d".repeat(64)}`;

function outcome(overrides = {}) {
  return {
    outcome_id: "future-modification",
    state: "evaluated",
    evaluated_fold_count: 2,
    baseline_vs_composite: {
      baseline_count: 4,
      baseline_better_count: 1,
      composite_better_count: 2,
      tied_count: 1,
      unavailable_count: 0,
    },
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    repository_id: CURRENT.repository_id,
    final_revision: CURRENT.revision,
    configuration_hash: CURRENT.configuration_hash,
    cutoff_snapshot_ids: [EARLIEST_SNAPSHOT, EARLIER_SNAPSHOT, PREVIOUS_SNAPSHOT, CURRENT.snapshot_id],
    // The forward-temporal evaluator needs one initial interval before the
    // first holdout, so four cutoff snapshots yield two forward folds.
    forward_fold_count: 2,
    outcomes: [outcome()],
    receipt_sha256: `sha256:${"e".repeat(64)}`,
    ...overrides,
  };
}

function input(receiptSummary = null) {
  return { current_snapshot: CURRENT, receipt: receiptSummary };
}

const V9_TARGETS = ["future-modification", "repeated-modification", "high-churn"];
const V9_HORIZONS = [10, 25, 50];

function v9Promotion(targetId, horizon, state) {
  const validated = state === "VALIDATED_MODEL" || state === "VALIDATED_BASELINE";
  const baseline = state === "VALIDATED_BASELINE";
  return {
    target_id: targetId,
    horizon_commits: horizon,
    state,
    selected_method_id: validated
      ? baseline ? "baseline-change-frequency-v1" : "sei-four-signal-composite-v1"
      : null,
    selected_method_kind: validated ? baseline ? "simple-baseline" : "sei-heuristic" : null,
    terminal_state: validated || state === "NO_USEFUL_SIGNAL" ? "EVALUATED" : "NOT_READ",
    forecast_item_count: validated ? 4 : 0,
  };
}

function v9Receipt(state = "VALIDATED_MODEL", overrides = {}) {
  const cutoffIds = (horizon) => {
    const ids = [
      `sei-v1-${String(horizon).padStart(2, "0")}${"1".repeat(62)}`,
      `sei-v1-${String(horizon).padStart(2, "0")}${"2".repeat(62)}`,
      `sei-v1-${String(horizon).padStart(2, "0")}${"3".repeat(62)}`,
      `sei-v1-${String(horizon).padStart(2, "0")}${"4".repeat(62)}`,
      `sei-v1-${String(horizon).padStart(2, "0")}${"5".repeat(62)}`,
      CURRENT.snapshot_id,
    ];
    return state === "NOT_READY" ? ids.slice(1) : ids;
  };
  return {
    schema_version: "sei.predictive-status-receipt@2",
    source_schema_version: "sei.forward-temporal-evaluation@3",
    repository_id: CURRENT.repository_id,
    final_revision: CURRENT.revision,
    final_snapshot_id: CURRENT.snapshot_id,
    configuration_hash: CURRENT.configuration_hash,
    horizon_cutoff_snapshot_ids: V9_HORIZONS.map((horizon) => ({
      horizon_commits: horizon,
      cutoff_snapshot_ids: cutoffIds(horizon),
    })),
    development_fold_count: 3,
    terminal_holdout_fold_count: 1,
    promotions: V9_HORIZONS.flatMap((horizon) => (
      V9_TARGETS.map((targetId) => v9Promotion(targetId, horizon, state))
    )),
    receipt_sha256: `sha256:${"9".repeat(64)}`,
    ...overrides,
  };
}

test("reports a closed immutable not-yet-evaluated state without inventing predictive evidence", () => {
  const result = derivePredictiveStatus(input());
  const omittedReceipt = derivePredictiveStatus({ current_snapshot: CURRENT });

  assert.deepEqual(Object.keys(predictiveStatus).sort(), [
    "PREDICTIVE_STATUS_VERSION",
    "derivePredictiveStatus",
  ]);
  assert.equal(PREDICTIVE_STATUS_VERSION, "sei.predictive-status@1");
  assert.deepEqual(result, {
    predictive_status_version: "sei.predictive-status@1",
    state: "not-yet-evaluated",
    evaluation_exists: false,
    compatibility: "not-assessed",
    exact_snapshot_participation: null,
    receipt: null,
    outcomes: [],
    summary: "No validated predictive evaluation receipt summary was supplied for this snapshot.",
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(omittedReceipt, result);
});

test("reports current evaluation separately from compatibility and summarizes baseline comparisons without causal claims", () => {
  const result = derivePredictiveStatus(input(receipt()));
  const reversed = derivePredictiveStatus(input(receipt({
    cutoff_snapshot_ids: [CURRENT.snapshot_id, PREVIOUS_SNAPSHOT, EARLIER_SNAPSHOT, EARLIEST_SNAPSHOT],
    outcomes: [
      outcome({ outcome_id: "high-churn" }),
      outcome(),
    ],
  })));

  assert.equal(result.state, "evaluated-current");
  assert.equal(result.evaluation_exists, true);
  assert.equal(result.compatibility, "compatible");
  assert.equal(result.exact_snapshot_participation, true);
  assert.deepEqual(result.receipt, {
    receipt_sha256: `sha256:${"e".repeat(64)}`,
    digest_status: "declared-not-recomputed",
    final_revision: CURRENT.revision,
    forward_fold_count: 2,
    cutoff_snapshot_count: 4,
  });
  assert.deepEqual(result.outcomes, [{
    outcome_id: "future-modification",
    state: "evaluated",
    evaluated_fold_count: 2,
    baseline_vs_composite: {
      basis: "forward-fold ranking-score comparison",
      baseline_count: 4,
      baseline_better_count: 1,
      composite_better_count: 2,
      tied_count: 1,
      unavailable_count: 0,
      summary: "Across 4 baseline-to-composite ranking-score comparisons: 1 baseline higher, 2 composite higher, 1 tied, and 0 unavailable. This does not establish causation.",
    },
  }]);
  assert.match(result.summary, /exact snapshot as the final cutoff/i);
  assert.doesNotMatch(result.summary, /causes|caused|cause of/i);
  assert.equal(Object.isFrozen(result.outcomes[0].baseline_vs_composite), true);
  assert.deepEqual(reversed.outcomes.map((entry) => entry.outcome_id), ["future-modification", "high-churn"]);
  assert.deepEqual(reversed.receipt.cutoff_snapshot_count, 4);
});

test("distinguishes compatible prior evidence, non-comparable prior evidence, and unresolved bindings", () => {
  const currentAttemptWithoutTwoFolds = derivePredictiveStatus(input(receipt({
    cutoff_snapshot_ids: [EARLIEST_SNAPSHOT, PREVIOUS_SNAPSHOT, CURRENT.snapshot_id],
    forward_fold_count: 1,
    outcomes: [outcome({
      state: "not-established",
      evaluated_fold_count: 1,
      baseline_vs_composite: {
        baseline_count: 0,
        baseline_better_count: 0,
        composite_better_count: 0,
        tied_count: 0,
        unavailable_count: 0,
      },
    })],
  })));
  assert.equal(currentAttemptWithoutTwoFolds.state, "unresolved");
  assert.equal(currentAttemptWithoutTwoFolds.exact_snapshot_participation, true);
  assert.match(currentAttemptWithoutTwoFolds.summary, /required two forward folds/i);

  const compatiblePrior = derivePredictiveStatus(input(receipt({
    final_revision: "f".repeat(40),
    cutoff_snapshot_ids: [EARLIEST_SNAPSHOT, EARLIER_SNAPSHOT, PREVIOUS_SNAPSHOT],
    forward_fold_count: 1,
    outcomes: [outcome({ state: "not-established", evaluated_fold_count: 0, baseline_vs_composite: {
      baseline_count: 0,
      baseline_better_count: 0,
      composite_better_count: 0,
      tied_count: 0,
      unavailable_count: 0,
    } })],
  })));
  assert.equal(compatiblePrior.state, "previously-evaluated-compatible-not-current");
  assert.equal(compatiblePrior.compatibility, "compatible");
  assert.equal(compatiblePrior.exact_snapshot_participation, false);

  const priorAttemptWithAnInsufficientOutcome = derivePredictiveStatus(input(receipt({
    final_revision: "f".repeat(40),
    cutoff_snapshot_ids: [EARLIEST_SNAPSHOT, EARLIER_SNAPSHOT, PREVIOUS_SNAPSHOT],
    forward_fold_count: 1,
    outcomes: [outcome({
      state: "not-established",
      evaluated_fold_count: 1,
      baseline_vs_composite: {
        baseline_count: 0,
        baseline_better_count: 0,
        composite_better_count: 0,
        tied_count: 0,
        unavailable_count: 0,
      },
    })],
  })));
  assert.equal(priorAttemptWithAnInsufficientOutcome.state, "previously-evaluated-compatible-not-current");
  assert.equal(priorAttemptWithAnInsufficientOutcome.outcomes[0].evaluated_fold_count, 1);

  const notComparable = derivePredictiveStatus(input(receipt({
    configuration_hash: "f".repeat(64),
    final_revision: "f".repeat(40),
    cutoff_snapshot_ids: [EARLIEST_SNAPSHOT, EARLIER_SNAPSHOT, PREVIOUS_SNAPSHOT],
    forward_fold_count: 1,
    outcomes: [outcome({ state: "not-established", evaluated_fold_count: 0, baseline_vs_composite: {
      baseline_count: 0,
      baseline_better_count: 0,
      composite_better_count: 0,
      tied_count: 0,
      unavailable_count: 0,
    } })],
  })));
  assert.equal(notComparable.state, "prior-evaluation-not-comparable");
  assert.equal(notComparable.compatibility, "not-comparable");
  assert.equal(notComparable.exact_snapshot_participation, null);

  const unresolved = derivePredictiveStatus(input(receipt({
    final_revision: "f".repeat(40),
    cutoff_snapshot_ids: [EARLIEST_SNAPSHOT, PREVIOUS_SNAPSHOT, CURRENT.snapshot_id],
    forward_fold_count: 1,
    outcomes: [outcome({ state: "not-established", evaluated_fold_count: 1 })],
  })));
  assert.equal(unresolved.state, "unresolved");
  assert.equal(unresolved.compatibility, "compatible");
  assert.equal(unresolved.exact_snapshot_participation, true);
  assert.match(unresolved.summary, /different revision/i);
});

test("rejects forged, open, duplicate, or unbounded identities and receipt summaries", () => {
  const invalid = [
    { current_snapshot: { ...CURRENT, extra: true }, receipt: null },
    { current_snapshot: { ...CURRENT, revision: "short" }, receipt: null },
    input({ ...receipt(), receipt_sha256: "sha256:not-a-digest" }),
    input({ ...receipt(), cutoff_snapshot_ids: [CURRENT.snapshot_id, CURRENT.snapshot_id] }),
    input({ ...receipt(), forward_fold_count: 9 }),
    input({ ...receipt(), outcomes: [outcome({ evaluated_fold_count: 1 })] }),
    input({ ...receipt(), outcomes: [{ ...outcome(), extra: true }] }),
    input({ ...receipt(), outcomes: [outcome({ baseline_vs_composite: {
      baseline_count: 1,
      baseline_better_count: 1,
      composite_better_count: 1,
      tied_count: 0,
      unavailable_count: 0,
    } })] }),
    { current_snapshot: CURRENT, receipt: null, extra: true },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => derivePredictiveStatus(candidate),
      (error) => error?.code === "FAIL-PREDICTIVE-STATUS",
    );
  }
});

test("projects every V9 public state without turning baseline or no-signal evidence into a richer claim", () => {
  const states = [
    "NOT_READY",
    "READY_NOT_EVALUATED",
    "VALIDATED_BASELINE",
    "VALIDATED_MODEL",
    "NO_USEFUL_SIGNAL",
  ];
  for (const state of states) {
    const result = derivePredictiveStatus(input(v9Receipt(state)));
    assert.equal(result.state, state);
    assert.equal(result.evaluation_exists, true);
    assert.equal(result.compatibility, "compatible");
    assert.equal(result.exact_snapshot_participation, true);
    assert.equal(result.outcomes.length, 9);
    assert.equal(result.outcomes.every((entry) => entry.state === state), true);
    assert.equal(result.outcomes.every((entry) => (
      state === "VALIDATED_BASELINE" || state === "VALIDATED_MODEL"
        ? entry.forecast_item_count === 4
        : entry.forecast_item_count === 0 && entry.selected_method === null
    )), true);
    if (state === "VALIDATED_BASELINE") {
      assert.match(result.summary, /baseline/i);
      assert.doesNotMatch(result.summary, /model/i);
    }
    if (state === "NO_USEFUL_SIGNAL") assert.match(result.summary, /no current forecast/i);
  }
});

test("V9 status distinguishes stale current evidence from incompatible repository or configuration evidence", () => {
  const stale = derivePredictiveStatus(input(v9Receipt("VALIDATED_MODEL", {
    final_revision: "f".repeat(40),
    final_snapshot_id: PREVIOUS_SNAPSHOT,
  })));
  const incompatibleRepository = derivePredictiveStatus(input(v9Receipt("VALIDATED_MODEL", {
    repository_id: "other-repository",
  })));
  const incompatibleConfiguration = derivePredictiveStatus(input(v9Receipt("VALIDATED_MODEL", {
    configuration_hash: "f".repeat(64),
  })));

  assert.equal(stale.state, "STALE");
  assert.equal(stale.compatibility, "compatible");
  assert.equal(stale.exact_snapshot_participation, false);
  assert.equal(incompatibleRepository.state, "INCOMPATIBLE");
  assert.equal(incompatibleRepository.compatibility, "not-comparable");
  assert.equal(incompatibleConfiguration.state, "INCOMPATIBLE");
  assert.equal(incompatibleConfiguration.outcomes.every((entry) => entry.forecast_item_count === 0), true);
});

test("ambiguous legacy-shaped V3 summaries and incoherent V9 forecast states reject rather than coerce", () => {
  const ambiguousLegacy = { ...receipt(), schema_version: "sei.forward-temporal-evaluation@3" };
  const incoherent = v9Receipt("NO_USEFUL_SIGNAL");
  incoherent.promotions[0].forecast_item_count = 1;

  for (const candidate of [ambiguousLegacy, incoherent]) {
    assert.throws(
      () => derivePredictiveStatus(input(candidate)),
      (error) => error?.code === "FAIL-PREDICTIVE-STATUS",
    );
  }
});

test("evaluated V9 horizons require exactly six selected cutoff snapshot IDs", () => {
  const forgedSeven = v9Receipt("VALIDATED_MODEL");
  forgedSeven.horizon_cutoff_snapshot_ids[0].cutoff_snapshot_ids.unshift(
    `sei-v1-${"7".repeat(64)}`,
  );

  assert.throws(
    () => derivePredictiveStatus(input(forgedSeven)),
    (error) => error?.code === "FAIL-PREDICTIVE-STATUS" && /exactly six/i.test(error.message),
  );
});
