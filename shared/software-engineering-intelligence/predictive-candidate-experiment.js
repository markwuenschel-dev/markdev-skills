"use strict";

const crypto = require("node:crypto");

const { evaluateForwardTemporal } = require("./forward-temporal-evaluator.js");

const PREDICTIVE_CANDIDATE_EXPERIMENT_VERSION = "sei.predictive-candidate-experiment@1";
const INPUT_SCHEMA_VERSION = "sei.predictive-candidate-experiment-input@1";
const SOURCE_RECEIPT_SCHEMA_VERSION = "sei.forward-temporal-evaluation@2";
const RECEIPT_SCHEMA_VERSION = "sei.predictive-candidate-experiment@1";
const SOURCE_METHOD_IDS = Object.freeze([
  "sei-four-signal-composite-v1",
  "baseline-loc-v1",
  "baseline-change-frequency-v1",
  "baseline-churn-v1",
  "baseline-complexity-v1",
]);
const OUTCOME_IDS = Object.freeze([
  "future-modification",
  "repeated-modification",
  "high-churn",
]);
const METRIC_FIELDS = Object.freeze([
  Object.freeze(["mean_precision_at_k", "precision_at_k"]),
  Object.freeze(["mean_recall_at_k", "recall_at_k"]),
  Object.freeze(["mean_lift_at_k", "lift_at_k"]),
  Object.freeze(["mean_average_precision", "average_precision"]),
  Object.freeze(["mean_spearman_rank_correlation", "spearman_rank_correlation"]),
]);
const MAX_FORWARD_FOLDS = 64;
const MAX_COHORT_OBSERVATIONS = 100_000;
const MAX_RANKING_K = 10_000;
const MAX_EXPORTED_RANKED_SUBJECTS = 20;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONFIGURATION_HASH = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^sei-v[1-9][0-9]*-[a-f0-9]{64}$/;
const NORMALIZER_KEYS = Object.freeze(["loc", "change_frequency", "churn", "complexity"]);

const METHOD_SPECS = Object.freeze([
  Object.freeze({
    method_id: "sei-four-signal-composite-v1",
    method_kind: "existing-heuristic",
    feature_keys: Object.freeze(["loc", "change_frequency", "churn", "complexity"]),
    score_interpretation: "mean-of-training-range-normalized-four-input-ranking-scores",
  }),
  Object.freeze({
    method_id: "baseline-loc-v1",
    method_kind: "simple-baseline",
    feature_keys: Object.freeze(["loc"]),
    score_interpretation: "training-range-normalized-LOC-ranking-score",
  }),
  Object.freeze({
    method_id: "baseline-change-frequency-v1",
    method_kind: "simple-baseline",
    feature_keys: Object.freeze(["change_frequency"]),
    score_interpretation: "training-range-normalized-change-frequency-ranking-score",
  }),
  Object.freeze({
    method_id: "baseline-churn-v1",
    method_kind: "simple-baseline",
    feature_keys: Object.freeze(["churn"]),
    score_interpretation: "training-range-normalized-churn-ranking-score",
  }),
  Object.freeze({
    method_id: "baseline-complexity-v1",
    method_kind: "simple-baseline",
    feature_keys: Object.freeze(["complexity"]),
    score_interpretation: "training-range-normalized-complexity-ranking-score",
  }),
  Object.freeze({
    method_id: "candidate-complexity-churn-product-v1",
    method_kind: "candidate",
    feature_keys: Object.freeze(["complexity", "churn"]),
    score_interpretation: "product-of-training-range-normalized-complexity-and-churn-ranking-scores",
  }),
]);

function fail(detail) {
  const error = new Error(`FAIL-PREDICTIVE-CANDIDATE-EXPERIMENT: ${detail}`);
  error.code = "FAIL-PREDICTIVE-CANDIDATE-EXPERIMENT";
  throw error;
}

function failEvidence(detail) {
  const error = new Error(`FAIL-PREDICTIVE-CANDIDATE-EXPERIMENT-EVIDENCE: ${detail}`);
  error.code = "FAIL-PREDICTIVE-CANDIDATE-EXPERIMENT-EVIDENCE";
  throw error;
}

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(stableCompare)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function assertClosed(value, fields, label) {
  if (!isRecord(value)) fail(`${label} must be a plain closed record`);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(stableCompare);
  if (unknown.length > 0) fail(`${label}.${unknown[0]} is not declared`);
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(`${label}.${missing[0]} is required`);
}

function assertFinite(value, label, { minimum = null, maximum = null } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)
      || (minimum !== null && value < minimum)
      || (maximum !== null && value > maximum)) {
    failEvidence(`${label} must be a finite number within the declared bounds`);
  }
  return value;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
      || value.trim() !== value || value.includes("\0") || /[\r\n]/.test(value)) {
    failEvidence(`${label} must be a bounded stable identifier`);
  }
  return value;
}

function assertDigest(value, label) {
  if (!SHA256.test(value ?? "")) failEvidence(`${label} must be a SHA-256 digest`);
  return value;
}

function assertObjectId(value, label) {
  if (!OBJECT_ID.test(value ?? "")) failEvidence(`${label} must be a full lowercase repository object identifier`);
  return value;
}

function assertConfigurationHash(value, label) {
  if (!CONFIGURATION_HASH.test(value ?? "")) failEvidence(`${label} must be a lowercase configuration SHA-256 digest`);
  return value;
}

function assertSnapshotId(value, label) {
  if (!SNAPSHOT_ID.test(value ?? "")) failEvidence(`${label} must be a canonical SEI snapshot identifier`);
  return value;
}

function assertInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failEvidence(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function normalizeInput(input) {
  assertClosed(input, ["schema_version", "forward_temporal_input"], "input");
  if (input.schema_version !== INPUT_SCHEMA_VERSION) {
    fail(`input.schema_version must equal ${INPUT_SCHEMA_VERSION}`);
  }
  if (!isRecord(input.forward_temporal_input)) {
    fail("input.forward_temporal_input must be the existing forward-temporal evaluator input record");
  }
  return input.forward_temporal_input;
}

function sourceReceiptFor(forwardTemporalInput) {
  let receipt;
  try {
    receipt = evaluateForwardTemporal(forwardTemporalInput);
  } catch (error) {
    failEvidence(error?.message ?? "the forward-temporal evaluator rejected the supplied evidence");
  }
  if (!isRecord(receipt)
      || receipt.schema_version !== SOURCE_RECEIPT_SCHEMA_VERSION
      || receipt.kind !== "forward-temporal-ranking-evaluation-receipt"
      || !["evaluated", "partially_evaluated", "not_established"].includes(receipt.status)
      || !isRecord(receipt.repository)
      || !isRecord(receipt.protocol)
      || !Array.isArray(receipt.methods)
      || !Array.isArray(receipt.folds)
      || !Array.isArray(receipt.evaluation)) {
    failEvidence("the fixed forward-temporal evaluator did not return the expected @2 receipt contract");
  }
  assertDigest(receipt.receipt_sha256, "source_forward_temporal_receipt.receipt_sha256");
  if (receipt.folds.length === 0 || receipt.folds.length > MAX_FORWARD_FOLDS) {
    failEvidence(`source forward-temporal receipt must contain from one through ${MAX_FORWARD_FOLDS} folds`);
  }
  if (receipt.protocol.training_rule !== "only-completed-prior-outcome-intervals") {
    failEvidence("source forward-temporal receipt does not declare the required past-only training rule");
  }
  assertInteger(receipt.protocol.ranking_k, "source_forward_temporal_receipt.protocol.ranking_k", 1, MAX_RANKING_K);
  if (!Array.isArray(receipt.snapshot_bindings) || receipt.snapshot_bindings.length < 3
      || receipt.snapshot_bindings.length > MAX_FORWARD_FOLDS + 1) {
    failEvidence("source forward-temporal receipt snapshot bindings are outside the experiment bounds");
  }
  if (!Array.isArray(receipt.outcome_definitions) || receipt.outcome_definitions.length < OUTCOME_IDS.length) {
    failEvidence("source forward-temporal receipt outcome definitions are incomplete");
  }
  const actualMethods = receipt.methods.map((method) => method?.method_id);
  if (stableStringify(actualMethods) !== stableStringify(SOURCE_METHOD_IDS)) {
    failEvidence("source forward-temporal receipt method set is not the fixed composite plus four simple baselines");
  }
  const actualOutcomes = receipt.evaluation.map((outcome) => outcome?.outcome_id);
  if (stableStringify(actualOutcomes) !== stableStringify(OUTCOME_IDS)) {
    failEvidence("source forward-temporal receipt aggregate outcome set is not the fixed forward outcome contract");
  }
  return receipt;
}

function sourceMethodMap(outcome, label) {
  if (!isRecord(outcome) || !Array.isArray(outcome.rankings)) {
    failEvidence(`${label} has no bounded source rankings`);
  }
  const methodMap = new Map();
  for (const ranking of outcome.rankings) {
    const methodId = ranking?.method_id;
    if (!SOURCE_METHOD_IDS.includes(methodId) || methodMap.has(methodId)) {
      failEvidence(`${label} does not have exactly the required source ranking methods`);
    }
    if (!Array.isArray(ranking.ranking) || ranking.ranking.length < 1
        || ranking.ranking.length > MAX_COHORT_OBSERVATIONS) {
      failEvidence(`${label}/${methodId} cohort is outside the experiment bounds`);
    }
    methodMap.set(methodId, ranking);
  }
  if (methodMap.size !== SOURCE_METHOD_IDS.length) {
    failEvidence(`${label} does not have exactly the required source ranking methods`);
  }
  return methodMap;
}

function normalizeRankingEntry(value, label, expectedRank) {
  if (!isRecord(value)) failEvidence(`${label} must be a ranking record`);
  assertInteger(value.rank, `${label}.rank`, expectedRank, expectedRank);
  const subject = assertIdentifier(value.subject, `${label}.subject`);
  const rankScore = assertFinite(value.rank_score, `${label}.rank_score`, { minimum: 0, maximum: 1 });
  if (typeof value.observed_outcome !== "boolean") {
    failEvidence(`${label}.observed_outcome must be mechanically observed as true or false`);
  }
  const futureTouchCount = assertInteger(value.future_touch_count, `${label}.future_touch_count`, 0, Number.MAX_SAFE_INTEGER);
  const futureTextChurn = assertFinite(value.future_text_churn, `${label}.future_text_churn`, { minimum: 0 });
  return {
    subject,
    rank_score: rankScore,
    observed_outcome: value.observed_outcome,
    future_touch_count: futureTouchCount,
    future_text_churn: futureTextChurn,
  };
}

function rowsFromSourceOutcome(outcome, label) {
  const methods = sourceMethodMap(outcome, label);
  const firstMethod = methods.get("baseline-loc-v1");
  const cohortSize = firstMethod.ranking.length;
  const rowsBySubject = new Map();
  for (const methodId of SOURCE_METHOD_IDS) {
    const ranking = methods.get(methodId).ranking;
    if (ranking.length !== cohortSize) failEvidence(`${label}/${methodId} cohort size differs from the baseline cohort`);
    for (let index = 0; index < ranking.length; index += 1) {
      const entry = normalizeRankingEntry(ranking[index], `${label}/${methodId}.ranking[${index}]`, index + 1);
      const current = rowsBySubject.get(entry.subject);
      if (current === undefined) {
        rowsBySubject.set(entry.subject, {
          subject: entry.subject,
          observed_outcome: entry.observed_outcome,
          future_touch_count: entry.future_touch_count,
          future_text_churn: entry.future_text_churn,
          source_scores: { [methodId]: entry.rank_score },
        });
      } else {
        if (current.observed_outcome !== entry.observed_outcome
            || current.future_touch_count !== entry.future_touch_count
            || current.future_text_churn !== entry.future_text_churn) {
          failEvidence(`${label}/${entry.subject} outcome evidence differs between source methods`);
        }
        current.source_scores[methodId] = entry.rank_score;
      }
    }
  }
  if (rowsBySubject.size !== cohortSize) {
    failEvidence(`${label} source rankings do not contain an identical unique subject cohort`);
  }
  const rows = [...rowsBySubject.values()].sort((left, right) => stableCompare(left.subject, right.subject));
  for (const row of rows) {
    if (Object.keys(row.source_scores).length !== SOURCE_METHOD_IDS.length) {
      failEvidence(`${label}/${row.subject} is absent from one or more source methods`);
    }
    const expectedComposite = ["baseline-loc-v1", "baseline-change-frequency-v1", "baseline-churn-v1", "baseline-complexity-v1"]
      .reduce((sum, methodId) => sum + row.source_scores[methodId], 0) / 4;
    if (row.source_scores["sei-four-signal-composite-v1"] !== expectedComposite) {
      failEvidence(`${label}/${row.subject} source composite does not equal the declared four-input normalized mean`);
    }
  }
  return rows;
}

function scoreForMethod(row, methodId) {
  if (methodId === "candidate-complexity-churn-product-v1") {
    return row.source_scores["baseline-complexity-v1"] * row.source_scores["baseline-churn-v1"];
  }
  return row.source_scores[methodId];
}

function sourceFeatureEvidence(rows) {
  return rows.map((row) => ({
    subject: row.subject,
    normalized_churn_score: row.source_scores["baseline-churn-v1"],
    normalized_complexity_score: row.source_scores["baseline-complexity-v1"],
    complexity_churn_product_score: scoreForMethod(row, "candidate-complexity-churn-product-v1"),
  }));
}

function sameScoreRows(left, right, label) {
  if (left.length !== right.length) failEvidence(`${label} has a different source cohort size`);
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.subject !== b.subject
        || a.source_scores["baseline-churn-v1"] !== b.source_scores["baseline-churn-v1"]
        || a.source_scores["baseline-complexity-v1"] !== b.source_scores["baseline-complexity-v1"]
        || a.source_scores["baseline-loc-v1"] !== b.source_scores["baseline-loc-v1"]
        || a.source_scores["baseline-change-frequency-v1"] !== b.source_scores["baseline-change-frequency-v1"]
        || a.source_scores["sei-four-signal-composite-v1"] !== b.source_scores["sei-four-signal-composite-v1"]) {
      failEvidence(`${label} source feature scores are not invariant across outcome views`);
    }
  }
}

function rankingFor(rows, methodId, rankingK) {
  const ranking = rows.map((row) => ({
    subject: row.subject,
    rank_score: scoreForMethod(row, methodId),
    observed_outcome: row.observed_outcome,
    future_touch_count: row.future_touch_count,
    future_text_churn: row.future_text_churn,
  })).sort((left, right) => right.rank_score - left.rank_score || stableCompare(left.subject, right.subject))
    .map((entry, index) => ({ rank: index + 1, ...entry }));
  return {
    ranking,
    metrics: rankingMetrics(ranking, rankingK),
  };
}

function averageRanks(values) {
  const ordered = values.map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = Array(values.length);
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
    const rank = ((start + 1) + end) / 2;
    for (let index = start; index < end; index += 1) ranks[ordered[index].index] = rank;
    start = end;
  }
  return ranks;
}

function spearmanRankCorrelation(left, right) {
  const leftRanks = averageRanks(left);
  const rightRanks = averageRanks(right);
  const leftMean = leftRanks.reduce((sum, value) => sum + value, 0) / leftRanks.length;
  const rightMean = rightRanks.reduce((sum, value) => sum + value, 0) / rightRanks.length;
  let covariance = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < leftRanks.length; index += 1) {
    const leftDelta = leftRanks[index] - leftMean;
    const rightDelta = rightRanks[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  }
  if (leftSquares === 0 || rightSquares === 0) return null;
  return covariance / Math.sqrt(leftSquares * rightSquares);
}

function rankingMetrics(ranking, rankingK) {
  const positiveCount = ranking.filter((entry) => entry.observed_outcome).length;
  const negativeCount = ranking.length - positiveCount;
  const top = ranking.slice(0, rankingK);
  const topPositives = top.filter((entry) => entry.observed_outcome).length;
  let seen = 0;
  let precisionSum = 0;
  let reciprocalRank = null;
  ranking.forEach((entry, index) => {
    if (!entry.observed_outcome) return;
    seen += 1;
    precisionSum += seen / (index + 1);
    if (reciprocalRank === null) reciprocalRank = 1 / (index + 1);
  });
  const precisionAtK = topPositives / rankingK;
  const prevalence = positiveCount / ranking.length;
  const hasPositiveClass = positiveCount > 0;
  const hasBothClasses = hasPositiveClass && negativeCount > 0;
  const correlation = hasBothClasses
    ? spearmanRankCorrelation(
      ranking.map((entry) => entry.rank_score),
      ranking.map((entry) => entry.observed_outcome ? 1 : 0),
    )
    : null;
  return {
    precision_at_k: precisionAtK,
    recall_at_k: hasPositiveClass ? topPositives / positiveCount : null,
    lift_at_k: hasPositiveClass ? precisionAtK / prevalence : null,
    average_precision: hasBothClasses ? precisionSum / positiveCount : null,
    reciprocal_rank: reciprocalRank,
    spearman_rank_correlation: correlation,
    metric_availability: {
      precision_at_k: "available",
      recall_at_k: hasPositiveClass ? "available" : "unavailable_no_positive_outcomes",
      lift_at_k: hasPositiveClass ? "available" : "unavailable_no_positive_outcomes",
      average_precision: hasBothClasses ? "available" : "unavailable_class_distribution",
      spearman_rank_correlation: !hasBothClasses
        ? "unavailable_class_distribution"
        : correlation === null ? "unavailable_constant_ranking" : "available",
    },
  };
}

function compactFoldMethod(method, result) {
  const rankingDigest = sha256(result.ranking.map((entry) => ({
    subject: entry.subject,
    rank_score: entry.rank_score,
    observed_outcome: entry.observed_outcome,
    future_touch_count: entry.future_touch_count,
    future_text_churn: entry.future_text_churn,
  })));
  return {
    method_id: method.method_id,
    method_kind: method.method_kind,
    feature_keys: method.feature_keys.slice(),
    score_interpretation: method.score_interpretation,
    ranking_tie_rule: "rank-score-descending-then-subject-ascending",
    cohort_size: result.ranking.length,
    ranking_sha256: rankingDigest,
    exported_ranked_subject_count: Math.min(result.ranking.length, MAX_EXPORTED_RANKED_SUBJECTS),
    top_ranked_subjects: result.ranking.slice(0, MAX_EXPORTED_RANKED_SUBJECTS).map((entry) => ({
      rank: entry.rank,
      subject: entry.subject,
      rank_score: entry.rank_score,
    })),
    ...result.metrics,
  };
}

function normalizeClassCounts(value, label) {
  if (!isRecord(value)) failEvidence(`${label} must contain observed class counts`);
  const observations = assertInteger(value.observations, `${label}.observations`, 0, MAX_COHORT_OBSERVATIONS * MAX_FORWARD_FOLDS);
  const positive = assertInteger(value.positive, `${label}.positive`, 0, observations);
  const negative = assertInteger(value.negative, `${label}.negative`, 0, observations);
  if (positive + negative !== observations) failEvidence(`${label} observed class counts must partition observations`);
  return { observations, positive, negative };
}

function normalizeFeatureNormalizers(value, label) {
  if (!isRecord(value) || stableStringify(Object.keys(value).sort(stableCompare)) !== stableStringify(NORMALIZER_KEYS.slice().sort(stableCompare))) {
    failEvidence(`${label} must contain exactly the four fixed feature normalizers`);
  }
  return Object.fromEntries(NORMALIZER_KEYS.map((feature) => {
    const range = value[feature];
    if (!isRecord(range) || stableStringify(Object.keys(range).sort(stableCompare)) !== stableStringify(["max", "min"])) {
      failEvidence(`${label}.${feature} must contain only min and max`);
    }
    const min = assertFinite(range.min, `${label}.${feature}.min`, { minimum: 0 });
    const max = assertFinite(range.max, `${label}.${feature}.max`, { minimum: min });
    return [feature, { min, max }];
  }));
}

function foldOutcomesFor(sourceFold, sourceReceipt) {
  if (!isRecord(sourceFold) || !isRecord(sourceFold.training) || !isRecord(sourceFold.holdout)
      || !isRecord(sourceFold.leakage_check) || !Array.isArray(sourceFold.outcomes)) {
    failEvidence("source forward fold is not a closed fixed-fold record");
  }
  assertIdentifier(sourceFold.fold_id, "source_forward_fold.fold_id");
  if (sourceFold.leakage_check.training_ends_before_holdout !== true) {
    failEvidence(`${sourceFold.fold_id} is not certified as training-ending-before-holdout`);
  }
  const sourceOutcomes = new Map();
  for (const outcome of sourceFold.outcomes) {
    if (!OUTCOME_IDS.includes(outcome?.outcome_id) || sourceOutcomes.has(outcome.outcome_id)) {
      failEvidence(`${sourceFold.fold_id} has an unsupported or duplicate outcome`);
    }
    if (!["evaluated", "not_established"].includes(outcome.status)) {
      failEvidence(`${sourceFold.fold_id}/${outcome.outcome_id} has unsupported established-status semantics`);
    }
    sourceOutcomes.set(outcome.outcome_id, outcome);
  }
  if (sourceOutcomes.size !== OUTCOME_IDS.length) {
    failEvidence(`${sourceFold.fold_id} does not contain the fixed forward outcome set`);
  }
  const rowsByOutcome = new Map(OUTCOME_IDS.map((outcomeId) => [
    outcomeId,
    rowsFromSourceOutcome(sourceOutcomes.get(outcomeId), `${sourceFold.fold_id}/${outcomeId}`),
  ]));
  const referenceRows = rowsByOutcome.get(OUTCOME_IDS[0]);
  for (const outcomeId of OUTCOME_IDS.slice(1)) {
    sameScoreRows(referenceRows, rowsByOutcome.get(outcomeId), `${sourceFold.fold_id}/${outcomeId}`);
  }
  const featureEvidence = sourceFeatureEvidence(referenceRows);
  const candidateEvidence = {
    source_forward_temporal_receipt_sha256: sourceReceipt.receipt_sha256,
    fold_id: sourceFold.fold_id,
    holdout_snapshot_id: assertIdentifier(sourceFold.holdout.snapshot_id, `${sourceFold.fold_id}.holdout.snapshot_id`),
    training_cutoff_revisions: Array.isArray(sourceFold.training.cutoff_revisions)
      ? sourceFold.training.cutoff_revisions.map((revision, index) => assertIdentifier(revision, `${sourceFold.fold_id}.training.cutoff_revisions[${index}]`))
      : failEvidence(`${sourceFold.fold_id}.training.cutoff_revisions must be a bounded array`),
    training_feature_normalizers: normalizeFeatureNormalizers(sourceFold.training.feature_normalizers, `${sourceFold.fold_id}.training.feature_normalizers`),
    feature_scores: featureEvidence,
  };
  if (candidateEvidence.training_cutoff_revisions.length === 0
      || candidateEvidence.training_cutoff_revisions.length > MAX_FORWARD_FOLDS) {
    failEvidence(`${sourceFold.fold_id}.training.cutoff_revisions are outside the experiment bounds`);
  }
  const outcomes = OUTCOME_IDS.map((outcomeId) => {
    const sourceOutcome = sourceOutcomes.get(outcomeId);
    const rows = rowsByOutcome.get(outcomeId);
    const trainingClasses = normalizeClassCounts(sourceOutcome.training_classes, `${sourceFold.fold_id}/${outcomeId}.training_classes`);
    const holdoutClasses = normalizeClassCounts(sourceOutcome.holdout_classes, `${sourceFold.fold_id}/${outcomeId}.holdout_classes`);
    const mechanicallyEstablished = trainingClasses.positive > 0 && trainingClasses.negative > 0
      && holdoutClasses.positive > 0 && holdoutClasses.negative > 0;
    if ((sourceOutcome.status === "evaluated") !== mechanicallyEstablished) {
      failEvidence(`${sourceFold.fold_id}/${outcomeId} established-status semantics do not match its mechanically observed classes`);
    }
    const methods = METHOD_SPECS.map((method) => compactFoldMethod(
      method,
      rankingFor(rows, method.method_id, sourceReceipt.protocol.ranking_k),
    ));
    return {
      outcome_id: outcomeId,
      status: sourceOutcome.status,
      reason: sourceOutcome.status === "evaluated" ? null : "this fold does not contain both mechanically observed classes in the prior training horizon and forward holdout",
      training_classes: trainingClasses,
      holdout_classes: holdoutClasses,
      methods,
    };
  });
  return {
    fold_id: sourceFold.fold_id,
    source_fold_sha256: sha256(sourceFold),
    candidate_evidence_sha256: sha256(candidateEvidence),
    training: {
      cutoff_revisions: candidateEvidence.training_cutoff_revisions,
      outcome_end_revision: assertIdentifier(sourceFold.training.outcome_end_revision, `${sourceFold.fold_id}.training.outcome_end_revision`),
      outcome_end_timestamp: assertIdentifier(sourceFold.training.outcome_end_timestamp, `${sourceFold.fold_id}.training.outcome_end_timestamp`),
      observation_count: assertInteger(sourceFold.training.observation_count, `${sourceFold.fold_id}.training.observation_count`, 1, MAX_COHORT_OBSERVATIONS * MAX_FORWARD_FOLDS),
      feature_normalizers: candidateEvidence.training_feature_normalizers,
    },
    holdout: {
      snapshot_id: candidateEvidence.holdout_snapshot_id,
      cutoff_revision: assertIdentifier(sourceFold.holdout.cutoff_revision, `${sourceFold.fold_id}.holdout.cutoff_revision`),
      outcome_revisions: Array.isArray(sourceFold.holdout.outcome_revisions)
        ? sourceFold.holdout.outcome_revisions.map((revision, index) => assertIdentifier(revision, `${sourceFold.fold_id}.holdout.outcome_revisions[${index}]`))
        : failEvidence(`${sourceFold.fold_id}.holdout.outcome_revisions must be an array`),
      observation_count: assertInteger(sourceFold.holdout.observation_count, `${sourceFold.fold_id}.holdout.observation_count`, 1, MAX_COHORT_OBSERVATIONS),
    },
    leakage_check: {
      training_ends_before_holdout: true,
      score_inputs_are_training_range_normalized: true,
      outcome_inputs_used_only_after_ranking: true,
    },
    outcomes,
  };
}

function compareMetric(value, reference) {
  if (value === null || reference === null) return { result: "unavailable", delta: null };
  if (value === reference) return { result: "equal", delta: 0 };
  return { result: value > reference ? "better" : "worse", delta: value - reference };
}

function aggregateEvaluation(folds) {
  return OUTCOME_IDS.map((outcomeId) => {
    const foldOutcomes = folds.map((fold) => ({
      fold_id: fold.fold_id,
      outcome: fold.outcomes.find((outcome) => outcome.outcome_id === outcomeId),
    }));
    const evaluated = foldOutcomes.filter(({ outcome }) => outcome.status === "evaluated");
    const established = evaluated.length >= 2;
    const commonEligibleFoldIds = Object.fromEntries(METRIC_FIELDS.map(([aggregateField, foldField]) => [
      aggregateField,
      evaluated.filter(({ outcome }) => METHOD_SPECS.every((method) => (
        outcome.methods.find((entry) => entry.method_id === method.method_id)
          .metric_availability[foldField] === "available"
      ))).map(({ fold_id: foldId }) => foldId),
    ]));
    const methods = METHOD_SPECS.map((method) => {
      const records = evaluated.map(({ fold_id: foldId, outcome }) => ({
        fold_id: foldId,
        ranking: outcome.methods.find((entry) => entry.method_id === method.method_id),
      }));
      const aggregateValues = Object.fromEntries(METRIC_FIELDS.map(([aggregateField, foldField]) => {
        const eligible = new Set(commonEligibleFoldIds[aggregateField]);
        const available = records.filter(({ fold_id: foldId }) => eligible.has(foldId));
        return [aggregateField, established && available.length >= 2
          ? available.reduce((sum, { ranking }) => sum + ranking[foldField], 0) / available.length
          : null];
      }));
      const metricAvailability = Object.fromEntries(METRIC_FIELDS.map(([aggregateField]) => [
        aggregateField,
        established && commonEligibleFoldIds[aggregateField].length >= 2 ? "available" : "insufficient_folds",
      ]));
      const metricCoverage = Object.fromEntries(METRIC_FIELDS.map(([aggregateField]) => {
        const available = metricAvailability[aggregateField] === "available";
        return [aggregateField, {
          contributing_fold_count: available ? commonEligibleFoldIds[aggregateField].length : 0,
          contributing_fold_ids: available ? commonEligibleFoldIds[aggregateField].slice() : [],
        }];
      }));
      return {
        method_id: method.method_id,
        method_kind: method.method_kind,
        feature_keys: method.feature_keys.slice(),
        score_interpretation: method.score_interpretation,
        fold_count: foldOutcomes.length,
        evaluated_fold_count: records.length,
        ...aggregateValues,
        mean_reciprocal_rank: established
          ? records.reduce((sum, { ranking }) => sum + ranking.reciprocal_rank, 0) / records.length
          : null,
        metric_availability: metricAvailability,
        metric_coverage: metricCoverage,
      };
    });
    const candidate = methods.find((method) => method.method_id === "candidate-complexity-churn-product-v1");
    return {
      outcome_id: outcomeId,
      status: established ? "evaluated" : "not_established",
      reason: established
        ? null
        : "at least two forward folds with both mechanically observed classes are required",
      fold_count: foldOutcomes.length,
      evaluated_fold_count: evaluated.length,
      methods: methods.map((method) => {
        const comparison = method.method_id === candidate.method_id
          ? {
              result: method.mean_average_precision === null ? "unavailable" : "reference",
              delta: method.mean_average_precision === null ? null : 0,
              ...method.metric_coverage.mean_average_precision,
            }
          : {
              ...compareMetric(method.mean_average_precision, candidate.mean_average_precision),
              ...method.metric_coverage.mean_average_precision,
            };
        return {
          ...method,
          comparison_to_candidate: {
            metric: "mean_average_precision",
            ...comparison,
          },
        };
      }),
    };
  });
}

function projectMethods() {
  return METHOD_SPECS.map((method) => ({
    method_id: method.method_id,
    method_kind: method.method_kind,
    feature_keys: method.feature_keys.slice(),
    score_interpretation: method.score_interpretation,
  }));
}

function projectRepository(source) {
  return {
    repository_id: assertIdentifier(source.repository.repository_id, "source_forward_temporal_receipt.repository.repository_id"),
    configuration_hash: assertConfigurationHash(source.repository.configuration_hash, "source_forward_temporal_receipt.repository.configuration_hash"),
    history_stage_sha256: assertDigest(source.repository.history_stage_sha256, "source_forward_temporal_receipt.repository.history_stage_sha256"),
    history_start_revision: source.repository.history_start_revision === null
      ? null
      : assertObjectId(source.repository.history_start_revision, "source_forward_temporal_receipt.repository.history_start_revision"),
    history_end_revision: assertObjectId(source.repository.history_end_revision, "source_forward_temporal_receipt.repository.history_end_revision"),
    commit_count: assertInteger(source.repository.commit_count, "source_forward_temporal_receipt.repository.commit_count", 1, Number.MAX_SAFE_INTEGER),
  };
}

function projectSnapshotBindings(source) {
  const seenIds = new Set();
  const seenRevisions = new Set();
  return source.snapshot_bindings.map((binding, index) => {
    if (!isRecord(binding)) failEvidence(`source_forward_temporal_receipt.snapshot_bindings[${index}] must be a binding record`);
    const snapshotId = assertSnapshotId(binding.snapshot_id, `source_forward_temporal_receipt.snapshot_bindings[${index}].snapshot_id`);
    const revision = assertObjectId(binding.repository_revision, `source_forward_temporal_receipt.snapshot_bindings[${index}].repository_revision`);
    if (seenIds.has(snapshotId) || seenRevisions.has(revision)) {
      failEvidence("source forward-temporal receipt snapshot bindings must be unique");
    }
    seenIds.add(snapshotId);
    seenRevisions.add(revision);
    return { snapshot_id: snapshotId, repository_revision: revision };
  });
}

function evaluatePredictiveCandidateExperiment(input = {}) {
  const forwardTemporalInput = normalizeInput(input);
  const source = sourceReceiptFor(forwardTemporalInput);
  const repository = projectRepository(source);
  const snapshotBindings = projectSnapshotBindings(source);
  const folds = source.folds.map((fold) => foldOutcomesFor(fold, source));
  const evaluation = aggregateEvaluation(folds);
  const evaluatedOutcomeCount = evaluation.filter((outcome) => outcome.status === "evaluated").length;
  const status = evaluatedOutcomeCount === evaluation.length
    ? "evaluated"
    : evaluatedOutcomeCount === 0 ? "not_established" : "partially_evaluated";
  const body = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    kind: "predictive-candidate-experiment-receipt",
    status,
    reason: status === "evaluated"
      ? null
      : "one or more outcome aggregates lack two forward folds with both mechanically observed classes",
    score_kind: "deterministic-ranking-score",
    interpretation_boundary: "rankings summarize mechanically observed future repository modification and text-churn patterns; they do not establish underlying reasons for those patterns",
    source_forward_temporal_receipt_sha256: source.receipt_sha256,
    repository,
    protocol: {
      candidate_set_version: "sei.complexity-churn-product@1",
      source_evaluator_schema_version: SOURCE_RECEIPT_SCHEMA_VERSION,
      source_fold_authority: "fixed-package-evaluated-forward-temporal-folds",
      training_rule: "only-completed-prior-outcome-intervals",
      outcome_inputs: "mechanically-observed-forward-outcomes-used-only-after-ranking",
      candidate_score_rule: "normalized-complexity-score-times-normalized-churn-score",
      ranking_tie_rule: "rank-score-descending-then-subject-ascending",
      ranking_k: source.protocol.ranking_k,
      minimum_forward_folds_for_established_aggregate: 2,
      maximum_forward_folds: MAX_FORWARD_FOLDS,
      maximum_cohort_observations: MAX_COHORT_OBSERVATIONS,
    },
    snapshot_bindings: snapshotBindings,
    methods: projectMethods(),
    folds,
    evaluation,
    limitations: [
      "the candidate combines only normalized complexity and churn ranking scores already certified by the fixed forward-temporal evaluator",
      "the experiment compares deterministic ranking metrics and does not produce likelihood estimates",
      "a result is not established until at least two forward folds have both mechanically observed classes",
      "this experiment does not identify why a file changed or judge change desirability",
    ],
  };
  return deepFreeze({
    ...body,
    receipt_sha256: sha256(body),
  });
}

module.exports = {
  PREDICTIVE_CANDIDATE_EXPERIMENT_VERSION,
  evaluatePredictiveCandidateExperiment,
};
