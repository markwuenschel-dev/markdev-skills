"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const promotion = require("./predictive-promotion.js");
const {
  createPredictivePromotionFixture,
} = require("./forward-temporal-fixtures.js");

const promotionPrivate = promotion[Symbol.for("sei.predictive-promotion.private.v1")];
const { evaluatePredictivePromotion } = promotionPrivate;

function cloneFixture() {
  return structuredClone(createPredictivePromotionFixture());
}

function evaluationFor(input, targetId = "future-modification", horizon = 25) {
  return input.evaluations.find((entry) => (
    entry.target_id === targetId && entry.horizon_commits === horizon
  ));
}

function metricFor(fold, methodId) {
  return fold.methods.find((entry) => entry.method_id === methodId);
}

function resultFor(result, targetId = "future-modification", horizon = 25) {
  return result.promotions.find((entry) => (
    entry.target_id === targetId && entry.horizon_commits === horizon
  ));
}

test("five cutoff snapshots remain explicitly not ready and cannot promote", () => {
  const input = cloneFixture();
  input.horizon_readiness = input.horizon_readiness.map((entry) => ({
    ...entry,
    cutoff_snapshot_count: 5,
    state: "INSUFFICIENT_HISTORY",
  }));
  input.evaluations = [];

  const result = evaluatePredictivePromotion(input);

  assert.equal(result.public_state, "NOT_READY");
  assert.equal(result.readiness.failure_code, "FAIL-PREDICTIVE-READINESS");
  assert.equal(result.promotions.length, 9);
  assert.equal(result.promotions.every((entry) => entry.state === "NOT_READY"), true);
  assert.deepEqual(result.validated_selections, []);
});

test("terminal evidence can never participate in development nomination", () => {
  const input = cloneFixture();
  const evaluation = evaluationFor(input);
  evaluation.development_fold_ids[2] = evaluation.terminal_fold_id;

  assert.throws(
    () => evaluatePredictivePromotion(input),
    (error) => error?.code === "FAIL-PREDICTIVE-PROMOTION" && /terminal/i.test(error.message),
  );
});

test("a richer development nominee that loses terminal evidence emits no forecast", () => {
  const input = cloneFixture();
  const evaluation = evaluationFor(input);
  const terminal = evaluation.folds.at(-1);
  Object.assign(metricFor(terminal, "sei-four-signal-composite-v1"), {
    lift_at_k: 0.9,
    average_precision: 0.95,
  });
  Object.assign(metricFor(terminal, "baseline-change-frequency-v1"), {
    lift_at_k: 1,
    average_precision: 0.7,
  });

  const result = resultFor(evaluatePredictivePromotion(input));

  assert.equal(result.nomination.method_id, "sei-four-signal-composite-v1");
  assert.equal(result.state, "NO_USEFUL_SIGNAL");
  assert.equal(result.selected_method, null);
  assert.equal(result.forecast_eligible, false);
  assert.equal(Object.hasOwn(result, "current_forecast"), false);
});

test("a terminally qualifying change-frequency fallback is described honestly as a validated baseline", () => {
  const input = cloneFixture();
  const evaluation = evaluationFor(input);
  for (const fold of evaluation.folds.slice(0, 3)) {
    metricFor(fold, "baseline-change-frequency-v1").average_precision = 0.99;
  }
  Object.assign(metricFor(evaluation.folds.at(-1), "baseline-change-frequency-v1"), {
    lift_at_k: 2,
    average_precision: 0.8,
  });

  const result = resultFor(evaluatePredictivePromotion(input));

  assert.equal(result.nomination.method_id, "baseline-change-frequency-v1");
  assert.equal(result.state, "VALIDATED_BASELINE");
  assert.equal(result.selected_method.method_kind, "simple-baseline");
  assert.equal(result.forecast_eligible, true);
  assert.match(result.summary, /baseline/i);
  assert.doesNotMatch(result.summary, /model/i);
});

test("the predeclared fallback can validate when the richer development nominee fails terminal", () => {
  const input = cloneFixture();
  const evaluation = evaluationFor(input);
  const terminal = evaluation.folds.at(-1);
  Object.assign(metricFor(terminal, "sei-four-signal-composite-v1"), {
    lift_at_k: 0.9,
    average_precision: 0.9,
  });
  Object.assign(metricFor(terminal, "baseline-change-frequency-v1"), {
    lift_at_k: 1.5,
    average_precision: 0.7,
  });

  const result = resultFor(evaluatePredictivePromotion(input));

  assert.equal(result.nomination.method_id, "sei-four-signal-composite-v1");
  assert.equal(result.state, "VALIDATED_BASELINE");
  assert.equal(result.selected_method.method_id, "baseline-change-frequency-v1");
  assert.equal(result.forecast_eligible, true);
  assert.doesNotMatch(result.summary, /model/i);
});

test("a terminal fold without both mechanically observed classes is explicit and forecast-free", () => {
  const input = cloneFixture();
  const evaluation = evaluationFor(input);
  evaluation.folds.at(-1).classes = { observations: 4, positive: 4, negative: 0 };

  const result = resultFor(evaluatePredictivePromotion(input));

  assert.equal(result.state, "NO_USEFUL_SIGNAL");
  assert.equal(result.terminal_holdout.state, "INSUFFICIENT_CLASSES");
  assert.equal(result.terminal_holdout.failure_code, "FAIL-PREDICTIVE-TERMINAL-HOLDOUT");
  assert.equal(result.forecast_eligible, false);
  assert.equal(Object.hasOwn(result, "current_forecast"), false);
});

test("development folds without both classes remain ready but do not read terminal evidence", () => {
  const input = cloneFixture();
  const evaluation = evaluationFor(input);
  evaluation.folds[0].classes = { observations: 4, positive: 4, negative: 0 };
  let terminalEvidenceRead = false;
  for (const field of ["classes", "methods"]) {
    const original = evaluation.folds.at(-1)[field];
    Object.defineProperty(evaluation.folds.at(-1), field, {
      configurable: true,
      enumerable: true,
      get() {
        terminalEvidenceRead = true;
        return original;
      },
    });
  }

  const result = resultFor(evaluatePredictivePromotion(input));

  assert.equal(result.state, "READY_NOT_EVALUATED");
  assert.equal(result.failure_code, "FAIL-PREDICTIVE-PROMOTION");
  assert.equal(result.nomination, null);
  assert.equal(result.terminal_holdout.state, "NOT_READ");
  assert.equal(result.selected_method, null);
  assert.equal(result.forecast_eligible, false);
  assert.equal(terminalEvidenceRead, false);
});

test("development nomination requires complete average-precision evidence for all five registry methods", () => {
  const input = cloneFixture();
  const evaluation = evaluationFor(input);
  metricFor(evaluation.folds[1], "baseline-complexity-v1").average_precision = null;
  let terminalEvidenceRead = false;
  for (const field of ["classes", "methods"]) {
    const original = evaluation.folds.at(-1)[field];
    Object.defineProperty(evaluation.folds.at(-1), field, {
      configurable: true,
      enumerable: true,
      get() {
        terminalEvidenceRead = true;
        return original;
      },
    });
  }

  const result = resultFor(evaluatePredictivePromotion(input));

  assert.equal(result.state, "READY_NOT_EVALUATED");
  assert.equal(result.nomination, null);
  assert.equal(result.terminal_holdout.state, "NOT_READ");
  assert.equal(result.forecast_eligible, false);
  assert.equal(terminalEvidenceRead, false);
});

test("fold evidence must remain in the locked chronological development then terminal order", () => {
  const input = cloneFixture();
  const evaluation = evaluationFor(input);
  [evaluation.folds[0], evaluation.folds[1]] = [evaluation.folds[1], evaluation.folds[0]];

  assert.throws(
    () => evaluatePredictivePromotion(input),
    (error) => error?.code === "FAIL-PREDICTIVE-PROMOTION" && /chronological/i.test(error.message),
  );
});

test("stale protocol and configuration bindings reject instead of coercing", () => {
  const staleProtocol = cloneFixture();
  staleProtocol.protocol.evaluation_protocol_version = "sei.predictive-terminal-holdout@0";
  const staleConfiguration = cloneFixture();
  staleConfiguration.evidence_binding.configuration_hash = "b".repeat(64);

  for (const input of [staleProtocol, staleConfiguration]) {
    assert.throws(
      () => evaluatePredictivePromotion(input),
      (error) => error?.code === "FAIL-PREDICTIVE-STALE",
    );
  }
});

test("non-registry methods and phantom targets fail closed", () => {
  const nonRegistry = cloneFixture();
  metricFor(evaluationFor(nonRegistry).folds[0], "baseline-loc-v1").method_id = "caller-method";
  const phantomTarget = cloneFixture();
  evaluationFor(phantomTarget).target_id = "defect-risk";

  assert.throws(
    () => evaluatePredictivePromotion(nonRegistry),
    (error) => error?.code === "FAIL-PREDICTIVE-BINDING" && /registry/i.test(error.message),
  );
  assert.throws(
    () => evaluatePredictivePromotion(phantomTarget),
    (error) => error?.code === "FAIL-PHANTOM-TARGET",
  );
});

test("development ties use the frozen registry order and all nine target-horizon cells are present", () => {
  const input = cloneFixture();
  for (const evaluation of input.evaluations) {
    for (const fold of evaluation.folds.slice(0, 3)) {
      for (const method of fold.methods) method.average_precision = 0.8;
    }
  }

  const result = evaluatePredictivePromotion(input);

  assert.equal(result.promotions.length, 9);
  assert.equal(result.promotions.every((entry) => (
    entry.nomination.method_id === "sei-four-signal-composite-v1"
  )), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.promotions[0].nomination), true);
  assert.deepEqual(Object.keys(promotion), []);
  assert.equal(Object.isFrozen(promotionPrivate.METHOD_REGISTRY[0].feature_keys), true);
  assert.doesNotMatch(JSON.stringify(result), /probabilit|defect|causal|risk claim/i);
});
