"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateForwardTemporal } = require("./forward-temporal-evaluator.js");
const experiment = require("./predictive-candidate-experiment.js");
const {
  createConstantScoreForwardTemporalFixture,
  createForwardTemporalFixture,
  replaceHistory,
} = require("./forward-temporal-fixtures.js");

const {
  PREDICTIVE_CANDIDATE_EXPERIMENT_VERSION,
  evaluatePredictiveCandidateExperiment,
} = experiment;

function experimentInput(forwardTemporalInput) {
  return {
    schema_version: "sei.predictive-candidate-experiment-input@1",
    forward_temporal_input: forwardTemporalInput,
  };
}

function methodById(outcome, methodId) {
  const method = outcome.methods.find((entry) => entry.method_id === methodId);
  assert.ok(method, `missing ${methodId}`);
  return method;
}

test("predictive candidate experiment independently ranks a training-normalized complexity times churn candidate against all controls", () => {
  const fixture = createForwardTemporalFixture();
  const source = evaluateForwardTemporal(fixture.input);
  const receipt = evaluatePredictiveCandidateExperiment(experimentInput(fixture.input));

  assert.deepEqual(Object.keys(experiment).sort(), [
    "PREDICTIVE_CANDIDATE_EXPERIMENT_VERSION",
    "evaluatePredictiveCandidateExperiment",
  ]);
  assert.equal(PREDICTIVE_CANDIDATE_EXPERIMENT_VERSION, "sei.predictive-candidate-experiment@1");
  assert.equal(receipt.schema_version, "sei.predictive-candidate-experiment@1");
  assert.equal(receipt.kind, "predictive-candidate-experiment-receipt");
  assert.equal(receipt.status, "evaluated");
  assert.equal(receipt.source_forward_temporal_receipt_sha256, source.receipt_sha256);
  assert.equal(receipt.protocol.candidate_set_version, "sei.complexity-churn-product@1");
  assert.equal(receipt.protocol.training_rule, "only-completed-prior-outcome-intervals");
  assert.equal(receipt.protocol.outcome_inputs, "mechanically-observed-forward-outcomes-used-only-after-ranking");
  assert.deepEqual(receipt.methods.map((method) => method.method_id), [
    "sei-four-signal-composite-v1",
    "baseline-loc-v1",
    "baseline-change-frequency-v1",
    "baseline-churn-v1",
    "baseline-complexity-v1",
    "candidate-complexity-churn-product-v1",
  ]);
  assert.equal(receipt.folds.length, 2);
  assert.equal(receipt.folds.every((fold) => (
    fold.source_fold_sha256.startsWith("sha256:")
      && fold.candidate_evidence_sha256.startsWith("sha256:")
      && typeof fold.training.feature_normalizers.churn.min === "number"
      && typeof fold.training.feature_normalizers.complexity.max === "number"
      && fold.leakage_check.training_ends_before_holdout === true
  )), true);

  const repeated = receipt.evaluation.find((outcome) => outcome.outcome_id === "repeated-modification");
  const loc = methodById(repeated, "baseline-loc-v1");
  const candidate = methodById(repeated, "candidate-complexity-churn-product-v1");
  assert.equal(loc.comparison_to_candidate.result, "better");
  assert.equal(candidate.comparison_to_candidate.result, "reference");
  assert.equal(loc.mean_average_precision > candidate.mean_average_precision, true);
  for (const outcome of receipt.evaluation) {
    const sourceOutcome = source.evaluation.find((entry) => entry.outcome_id === outcome.outcome_id);
    for (const methodId of [
      "sei-four-signal-composite-v1",
      "baseline-loc-v1",
      "baseline-change-frequency-v1",
      "baseline-churn-v1",
      "baseline-complexity-v1",
    ]) {
      const actual = methodById(outcome, methodId);
      const expected = sourceOutcome.methods.find((entry) => entry.method_id === methodId);
      assert.equal(actual.mean_average_precision, expected.mean_average_precision, `${outcome.outcome_id}/${methodId} AP`);
      assert.equal(actual.mean_lift_at_k, expected.mean_lift_at_k, `${outcome.outcome_id}/${methodId} lift`);
      assert.deepEqual(actual.metric_availability, expected.metric_availability, `${outcome.outcome_id}/${methodId} availability`);
    }
  }
  assert.doesNotMatch(JSON.stringify(receipt), /probabilit|causal|defect/i);
  assert.equal(Object.isFrozen(receipt), true);
});

test("predictive candidate experiment has deterministic subject tie handling and remains invariant to cutoff input order", () => {
  const fixture = createConstantScoreForwardTemporalFixture();
  const first = evaluatePredictiveCandidateExperiment(experimentInput(fixture.input));
  const reordered = evaluatePredictiveCandidateExperiment(experimentInput({
    ...fixture.input,
    snapshots: fixture.input.snapshots.slice().reverse(),
  }));

  assert.deepEqual(reordered, first);
  const candidate = first.folds[0].outcomes
    .find((outcome) => outcome.outcome_id === "future-modification")
    .methods.find((method) => method.method_id === "candidate-complexity-churn-product-v1");
  assert.deepEqual(candidate.top_ranked_subjects.map((entry) => entry.subject), [
    "file:src/a.py",
    "file:src/b.py",
    "file:src/c.py",
    "file:src/d.py",
  ]);
  assert.equal(candidate.ranking_tie_rule, "rank-score-descending-then-subject-ascending");
});

test("predictive candidate experiment does not turn insufficient forward evidence into zero-valued success", () => {
  const fixture = createForwardTemporalFixture();
  const oneFoldInput = {
    ...replaceHistory(fixture, fixture.commits.slice(0, 7)),
    snapshots: fixture.input.snapshots.slice(0, 3),
  };
  const receipt = evaluatePredictiveCandidateExperiment(experimentInput(oneFoldInput));

  assert.equal(receipt.status, "not_established");
  assert.equal(receipt.reason, "one or more outcome aggregates lack two forward folds with both mechanically observed classes");
  assert.equal(receipt.evaluation.every((outcome) => (
    outcome.status === "not_established"
      && outcome.methods.every((method) => (
        method.mean_average_precision === null
          && method.metric_availability.mean_average_precision === "insufficient_folds"
      ))
  )), true);
});

test("predictive candidate experiment closes its public input and inherits certified forward-temporal evidence only", () => {
  const fixture = createForwardTemporalFixture();
  assert.throws(
    () => evaluatePredictiveCandidateExperiment({
      ...experimentInput(fixture.input),
      candidate_methods: ["untrusted-caller-method"],
    }),
    /FAIL-PREDICTIVE-CANDIDATE-EXPERIMENT.*not declared/,
  );
  assert.throws(
    () => evaluatePredictiveCandidateExperiment({
      schema_version: "sei.predictive-candidate-experiment-input@1",
      forward_temporal_input: { ...fixture.input, labels: [] },
    }),
    /FAIL-PREDICTIVE-CANDIDATE-EXPERIMENT-EVIDENCE.*caller-authored outcome labels are forbidden/,
  );
});
