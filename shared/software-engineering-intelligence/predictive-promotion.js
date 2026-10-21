"use strict";

const crypto = require("node:crypto");

const PREDICTIVE_PROMOTION_VERSION = "sei.predictive-promotion@1";
const DEVELOPMENT_NOMINATION_VERSION = "sei.predictive-development-nomination@1";
const INPUT_SCHEMA_VERSION = "sei.predictive-promotion-input@1";
const EVALUATION_SCHEMA_VERSION = "sei.forward-temporal-evaluation@3";
const CANDIDATE_REGISTRY_VERSION = "sei.predictive-method-registry@1";
const TARGET_SCHEMA_VERSION = "sei.predictive-targets@1";
const EVALUATION_PROTOCOL_VERSION = "sei.predictive-terminal-holdout@1";
const FALLBACK_METHOD_ID = "baseline-change-frequency-v1";
const DEVELOPMENT_FOLD_COUNT = 3;
const TERMINAL_HOLDOUT_FOLD_COUNT = 1;
const MINIMUM_CUTOFF_SNAPSHOT_COUNT = 6;
const METHOD_REGISTRY = deepFreeze([
  { method_id: "sei-four-signal-composite-v1", method_kind: "sei-heuristic", feature_keys: ["loc", "change_frequency", "churn", "complexity"] },
  { method_id: "baseline-loc-v1", method_kind: "simple-baseline", feature_keys: ["loc"] },
  { method_id: FALLBACK_METHOD_ID, method_kind: "simple-baseline", feature_keys: ["change_frequency"] },
  { method_id: "baseline-churn-v1", method_kind: "simple-baseline", feature_keys: ["churn"] },
  { method_id: "baseline-complexity-v1", method_kind: "simple-baseline", feature_keys: ["complexity"] },
]);
const TARGET_IDS = Object.freeze(["future-modification", "repeated-modification", "high-churn"]);
const HORIZON_COMMITS = Object.freeze([10, 25, 50]);
const METHOD_IDS = Object.freeze(METHOD_REGISTRY.map((method) => method.method_id));
const METHOD_BY_ID = new Map(METHOD_REGISTRY.map((method) => [method.method_id, method]));
const NOMINATION_METRIC = "mean-average-precision-across-three-development-folds";
const NOMINATION_TIE_RULE = "higher-mean-average-precision-then-predeclared-method-order";
const PROMOTION_RULE = "terminal-lift-at-k-greater-than-one-and-average-precision-not-lower-than-change-frequency-fallback";
const ELIGIBLE_COMMIT_RULE = "all-branded-history-commits-including-merges-and-empty-commits";
const OUTCOME_WINDOW_RULE = "commits-strictly-after-cutoff-and-strictly-before-next-cutoff-with-boundary-cutoff-reserved";
const CUTOFF_SELECTION_RULE = "latest-six-chronologically-ordered-cutoff-snapshots-without-class-backfill";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONFIGURATION_HASH = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^sei-v[1-9][0-9]*-[a-f0-9]{64}$/;
const brandedPromotions = new WeakSet();
const brandedDevelopmentNominations = new WeakSet();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(stableCompare)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  Object.values(value).forEach(deepFreeze);
  if (!Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function assertClosed(value, fields, label, code = "FAIL-PREDICTIVE-BINDING") {
  if (!isRecord(value)) fail(code, `${label} must be a closed object`);
  const actual = Object.keys(value).sort(stableCompare);
  const expected = fields.slice().sort(stableCompare);
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, `${label} must contain exactly ${expected.join(", ")}`);
  }
}

function assertStableId(value, label, code = "FAIL-PREDICTIVE-BINDING") {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
      || value.trim() !== value || value.includes("\0") || /[\r\n]/.test(value)) {
    fail(code, `${label} is not a bounded stable identifier`);
  }
}

function assertNonnegativeInteger(value, label, code = "FAIL-PREDICTIVE-BINDING") {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${label} must be a nonnegative safe integer`);
}

function assertFiniteMetric(value, label, maximum = null) {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0
      || (maximum !== null && value > maximum)) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} must be null or a bounded nonnegative finite metric`);
  }
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function normalizeBinding(value, label, final = false) {
  assertClosed(value, final
    ? ["configuration_hash", "final_revision", "final_snapshot_id", "repository_id"]
    : ["configuration_hash", "repository_id", "revision", "snapshot_id"], label);
  assertStableId(value.repository_id, `${label}.repository_id`);
  const revision = final ? value.final_revision : value.revision;
  const snapshotId = final ? value.final_snapshot_id : value.snapshot_id;
  if (!REVISION.test(revision ?? "")) fail("FAIL-PREDICTIVE-BINDING", `${label} revision is invalid`);
  if (!SNAPSHOT_ID.test(snapshotId ?? "")) fail("FAIL-PREDICTIVE-BINDING", `${label} snapshot ID is invalid`);
  if (!CONFIGURATION_HASH.test(value.configuration_hash ?? "")) {
    fail("FAIL-PREDICTIVE-BINDING", `${label}.configuration_hash is invalid`);
  }
  return {
    repository_id: value.repository_id,
    revision,
    snapshot_id: snapshotId,
    configuration_hash: value.configuration_hash,
  };
}

function normalizeProtocol(value) {
  assertClosed(value, [
    "candidate_registry_version",
    "cutoff_selection_rule",
    "development_fold_count",
    "eligible_commit_rule",
    "evaluation_protocol_version",
    "evaluation_schema_version",
    "fallback_method_id",
    "horizon_order",
    "method_order",
    "minimum_cutoff_snapshot_count",
    "nomination_metric",
    "nomination_tie_rule",
    "outcome_window_rule",
    "promotion_rule",
    "ranking_k",
    "target_order",
    "target_schema_version",
    "terminal_holdout_fold_count",
  ], "protocol");
  const stale = value.evaluation_schema_version !== EVALUATION_SCHEMA_VERSION
    || value.candidate_registry_version !== CANDIDATE_REGISTRY_VERSION
    || value.target_schema_version !== TARGET_SCHEMA_VERSION
    || value.evaluation_protocol_version !== EVALUATION_PROTOCOL_VERSION;
  if (stale) fail("FAIL-PREDICTIVE-STALE", "protocol versions do not match the frozen V9 contract");
  if (!sameArray(value.method_order, METHOD_IDS)
      || !sameArray(value.target_order, TARGET_IDS)
      || !sameArray(value.horizon_order, HORIZON_COMMITS)
      || value.fallback_method_id !== FALLBACK_METHOD_ID
      || value.nomination_metric !== NOMINATION_METRIC
      || value.nomination_tie_rule !== NOMINATION_TIE_RULE
      || value.promotion_rule !== PROMOTION_RULE
      || value.eligible_commit_rule !== ELIGIBLE_COMMIT_RULE
      || value.outcome_window_rule !== OUTCOME_WINDOW_RULE
      || value.cutoff_selection_rule !== CUTOFF_SELECTION_RULE
      || value.development_fold_count !== DEVELOPMENT_FOLD_COUNT
      || value.terminal_holdout_fold_count !== TERMINAL_HOLDOUT_FOLD_COUNT
      || value.minimum_cutoff_snapshot_count !== MINIMUM_CUTOFF_SNAPSHOT_COUNT
      || !Number.isSafeInteger(value.ranking_k) || value.ranking_k < 1 || value.ranking_k > 10_000) {
    fail("FAIL-PREDICTIVE-BINDING", "protocol configuration does not exactly match the frozen V9 contract");
  }
  return deepFreeze(structuredClone(value));
}

function normalizeHorizonReadiness(values) {
  if (!Array.isArray(values) || values.length !== HORIZON_COMMITS.length) {
    fail("FAIL-PREDICTIVE-READINESS", "horizon_readiness must cover exactly the 10, 25, and 50 eligible-commit horizons");
  }
  const seen = new Set();
  const normalized = values.map((value, index) => {
    assertClosed(value, ["cutoff_snapshot_count", "horizon_commits", "state"], `horizon_readiness[${index}]`);
    if (!HORIZON_COMMITS.includes(value.horizon_commits) || seen.has(value.horizon_commits)) {
      fail("FAIL-PREDICTIVE-READINESS", `horizon_readiness[${index}] has an unsupported or duplicate horizon`);
    }
    seen.add(value.horizon_commits);
    assertNonnegativeInteger(value.cutoff_snapshot_count, `horizon_readiness[${index}].cutoff_snapshot_count`, "FAIL-PREDICTIVE-READINESS");
    const expectedState = value.cutoff_snapshot_count >= MINIMUM_CUTOFF_SNAPSHOT_COUNT
      ? "READY"
      : "INSUFFICIENT_HISTORY";
    if (value.state !== expectedState) {
      fail("FAIL-PREDICTIVE-READINESS", `horizon ${value.horizon_commits} readiness contradicts its cutoff count`);
    }
    return { ...value };
  });
  return normalized.sort((left, right) => (
    HORIZON_COMMITS.indexOf(left.horizon_commits) - HORIZON_COMMITS.indexOf(right.horizon_commits)
  ));
}

function normalizeClasses(value, label) {
  assertClosed(value, ["negative", "observations", "positive"], label);
  for (const field of ["observations", "positive", "negative"]) {
    assertNonnegativeInteger(value[field], `${label}.${field}`);
  }
  if (value.observations === 0 || value.positive + value.negative !== value.observations) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} must exactly partition a nonempty observed cohort`);
  }
  return { observations: value.observations, positive: value.positive, negative: value.negative };
}

function normalizeMethods(values, label) {
  if (!Array.isArray(values) || values.length !== METHOD_REGISTRY.length) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} must contain the frozen five-method registry`);
  }
  const byId = new Map();
  values.forEach((value, index) => {
    assertClosed(value, ["average_precision", "lift_at_k", "method_id"], `${label}[${index}]`);
    if (!METHOD_BY_ID.has(value.method_id) || byId.has(value.method_id)) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}[${index}] is not one unique registry method`);
    }
    assertFiniteMetric(value.average_precision, `${label}[${index}].average_precision`, 1);
    assertFiniteMetric(value.lift_at_k, `${label}[${index}].lift_at_k`);
    byId.set(value.method_id, {
      method_id: value.method_id,
      lift_at_k: value.lift_at_k,
      average_precision: value.average_precision,
    });
  });
  return METHOD_IDS.map((methodId) => byId.get(methodId));
}

function normalizeFold(value, label) {
  assertClosed(value, ["classes", "fold_id", "methods", "role"], label);
  assertStableId(value.fold_id, `${label}.fold_id`);
  if (!new Set(["development", "terminal-holdout"]).has(value.role)) {
    fail("FAIL-PREDICTIVE-PROMOTION", `${label}.role is unsupported`);
  }
  return {
    fold_id: value.fold_id,
    role: value.role,
    classes: normalizeClasses(value.classes, `${label}.classes`),
    methods: normalizeMethods(value.methods, `${label}.methods`),
  };
}

function normalizeFoldIdentity(value, label, expectedRole) {
  assertClosed(value, ["classes", "fold_id", "methods", "role"], label);
  assertStableId(value.fold_id, `${label}.fold_id`);
  if (value.role !== expectedRole) {
    fail("FAIL-PREDICTIVE-PROMOTION", `${label}.role must equal ${expectedRole}`);
  }
  return value;
}

function normalizeEvaluation(value, index, currentBinding) {
  const label = `evaluations[${index}]`;
  assertClosed(value, [
    "cutoff_snapshot_ids",
    "development_fold_ids",
    "folds",
    "horizon_commits",
    "target_id",
    "terminal_fold_id",
  ], label);
  if (!TARGET_IDS.includes(value.target_id)) {
    fail("FAIL-PHANTOM-TARGET", `${label}.target_id is not one frozen predictive target`);
  }
  if (!HORIZON_COMMITS.includes(value.horizon_commits)) {
    fail("FAIL-PREDICTIVE-BINDING", `${label}.horizon_commits is not one frozen horizon`);
  }
  if (!Array.isArray(value.cutoff_snapshot_ids)
      || value.cutoff_snapshot_ids.length !== MINIMUM_CUTOFF_SNAPSHOT_COUNT) {
    fail("FAIL-PREDICTIVE-READINESS", `${label} must bind the exact six selected cutoff snapshots`);
  }
  value.cutoff_snapshot_ids.forEach((snapshotId, snapshotIndex) => {
    if (!SNAPSHOT_ID.test(snapshotId ?? "")) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.cutoff_snapshot_ids[${snapshotIndex}] is invalid`);
    }
  });
  if (new Set(value.cutoff_snapshot_ids).size !== value.cutoff_snapshot_ids.length
      || value.cutoff_snapshot_ids.at(-1) !== currentBinding.snapshot_id) {
    fail("FAIL-PREDICTIVE-STALE", `${label} cutoff binding is duplicate or does not end at the current snapshot`);
  }
  if (!Array.isArray(value.development_fold_ids)
      || value.development_fold_ids.length !== DEVELOPMENT_FOLD_COUNT) {
    fail("FAIL-PREDICTIVE-PROMOTION", `${label} must declare exactly three development fold IDs`);
  }
  value.development_fold_ids.forEach((foldId, foldIndex) => assertStableId(foldId, `${label}.development_fold_ids[${foldIndex}]`, "FAIL-PREDICTIVE-PROMOTION"));
  const hasTerminalFold = value.terminal_fold_id !== null;
  if (hasTerminalFold) {
    assertStableId(value.terminal_fold_id, `${label}.terminal_fold_id`, "FAIL-PREDICTIVE-PROMOTION");
  }
  if (new Set(value.development_fold_ids).size !== DEVELOPMENT_FOLD_COUNT
      || (hasTerminalFold && value.development_fold_ids.includes(value.terminal_fold_id))) {
    fail("FAIL-PREDICTIVE-PROMOTION", `${label} terminal holdout must be disjoint from all development folds`);
  }
  if (!Array.isArray(value.folds)
      || value.folds.length !== DEVELOPMENT_FOLD_COUNT + (hasTerminalFold ? TERMINAL_HOLDOUT_FOLD_COUNT : 0)) {
    fail("FAIL-PREDICTIVE-PROMOTION", `${label} must contain three development folds and only a materialized terminal holdout`);
  }
  const expectedFoldIds = hasTerminalFold
    ? [...value.development_fold_ids, value.terminal_fold_id]
    : value.development_fold_ids;
  if (!sameArray(value.folds.map((fold) => fold?.fold_id), expectedFoldIds)) {
    fail("FAIL-PREDICTIVE-PROMOTION", `${label} folds must follow the locked chronological development/terminal order`);
  }
  const developmentFolds = value.folds.slice(0, DEVELOPMENT_FOLD_COUNT).map((fold, foldIndex) => (
    normalizeFold(fold, `${label}.folds[${foldIndex}]`)
  ));
  if (developmentFolds.some((fold) => fold.role !== "development")) {
    fail("FAIL-PREDICTIVE-PROMOTION", `${label} fold roles do not match the locked development/terminal partition`);
  }
  const normalized = {
    target_id: value.target_id,
    horizon_commits: value.horizon_commits,
    cutoff_snapshot_ids: value.cutoff_snapshot_ids.slice(),
    development_fold_ids: value.development_fold_ids.slice(),
    terminal_fold_id: value.terminal_fold_id,
    development_folds: developmentFolds,
    read_terminal_fold: null,
  };
  if (!hasTerminalFold) {
    if (nominate(normalized) !== null) {
      fail("FAIL-PREDICTIVE-TERMINAL-HOLDOUT", `${label} has a development nominee but no terminal holdout`);
    }
    normalized.read_terminal_fold = () => {
      fail("FAIL-PREDICTIVE-TERMINAL-HOLDOUT", `${label} terminal holdout was not materialized`);
    };
    return normalized;
  }
  const terminalSource = normalizeFoldIdentity(
    value.folds[DEVELOPMENT_FOLD_COUNT],
    `${label}.folds[${DEVELOPMENT_FOLD_COUNT}]`,
    "terminal-holdout",
  );
  normalized.read_terminal_fold = () => normalizeFold(
    terminalSource,
    `${label}.folds[${DEVELOPMENT_FOLD_COUNT}]`,
  );
  return normalized;
}

function normalizeDevelopmentNominationInput(value) {
  assertClosed(value, [
    "development_fold_ids",
    "folds",
    "horizon_commits",
    "target_id",
  ], "development_evaluation");
  if (!TARGET_IDS.includes(value.target_id)) {
    fail("FAIL-PHANTOM-TARGET", "development_evaluation.target_id is not one frozen predictive target");
  }
  if (!HORIZON_COMMITS.includes(value.horizon_commits)) {
    fail("FAIL-PREDICTIVE-BINDING", "development_evaluation.horizon_commits is not one frozen horizon");
  }
  if (!Array.isArray(value.development_fold_ids)
      || value.development_fold_ids.length !== DEVELOPMENT_FOLD_COUNT
      || new Set(value.development_fold_ids).size !== DEVELOPMENT_FOLD_COUNT) {
    fail("FAIL-PREDICTIVE-PROMOTION", "development_evaluation must bind exactly three unique development folds");
  }
  value.development_fold_ids.forEach((foldId, index) => (
    assertStableId(foldId, `development_evaluation.development_fold_ids[${index}]`, "FAIL-PREDICTIVE-PROMOTION")
  ));
  if (!Array.isArray(value.folds) || value.folds.length !== DEVELOPMENT_FOLD_COUNT
      || !sameArray(value.folds.map((fold) => fold?.fold_id), value.development_fold_ids)) {
    fail("FAIL-PREDICTIVE-PROMOTION", "development_evaluation folds must follow the locked chronological order");
  }
  const developmentFolds = value.folds.map((fold, index) => (
    normalizeFold(fold, `development_evaluation.folds[${index}]`)
  ));
  if (developmentFolds.some((fold) => fold.role !== "development")) {
    fail("FAIL-PREDICTIVE-PROMOTION", "development_evaluation cannot contain terminal evidence");
  }
  return {
    target_id: value.target_id,
    horizon_commits: value.horizon_commits,
    development_fold_ids: value.development_fold_ids.slice(),
    development_folds: developmentFolds,
  };
}

function normalizeInput(input) {
  assertClosed(input, [
    "current_binding",
    "evaluations",
    "evidence_binding",
    "horizon_readiness",
    "protocol",
    "schema_version",
  ], "input");
  if (input.schema_version !== INPUT_SCHEMA_VERSION) {
    fail("FAIL-PREDICTIVE-STALE", `input.schema_version must equal ${INPUT_SCHEMA_VERSION}`);
  }
  const currentBinding = normalizeBinding(input.current_binding, "current_binding");
  const evidenceBinding = normalizeBinding(input.evidence_binding, "evidence_binding", true);
  if (currentBinding.repository_id !== evidenceBinding.repository_id) {
    fail("FAIL-PREDICTIVE-BINDING", "predictive evidence belongs to a different repository identity");
  }
  if (currentBinding.revision !== evidenceBinding.revision
      || currentBinding.snapshot_id !== evidenceBinding.snapshot_id
      || currentBinding.configuration_hash !== evidenceBinding.configuration_hash) {
    fail("FAIL-PREDICTIVE-STALE", "predictive evidence does not bind the current revision, snapshot, and configuration");
  }
  const protocol = normalizeProtocol(input.protocol);
  const readiness = normalizeHorizonReadiness(input.horizon_readiness);
  if (!Array.isArray(input.evaluations)) fail("FAIL-PREDICTIVE-BINDING", "evaluations must be an array");
  const evaluations = input.evaluations.map((value, index) => normalizeEvaluation(value, index, currentBinding));
  const evaluationKeys = evaluations.map((value) => `${value.target_id}\0${value.horizon_commits}`);
  if (new Set(evaluationKeys).size !== evaluationKeys.length) {
    fail("FAIL-PREDICTIVE-BINDING", "target/horizon evaluation cells must be unique");
  }
  const byKey = new Map(evaluations.map((value) => [`${value.target_id}\0${value.horizon_commits}`, value]));
  for (const horizon of readiness) {
    for (const targetId of TARGET_IDS) {
      const key = `${targetId}\0${horizon.horizon_commits}`;
      if ((horizon.state === "READY") !== byKey.has(key)) {
        fail("FAIL-PREDICTIVE-READINESS", `horizon ${horizon.horizon_commits} evaluation coverage contradicts readiness`);
      }
    }
  }
  return { currentBinding, protocol, readiness, byKey };
}

function bothClasses(classes) {
  return classes.positive > 0 && classes.negative > 0;
}

function methodMetric(fold, methodId) {
  return fold.methods.find((method) => method.method_id === methodId);
}

function terminalProjection(metric, qualifies) {
  if (metric === null) return null;
  return {
    method_id: metric.method_id,
    method_kind: METHOD_BY_ID.get(metric.method_id).method_kind,
    lift_at_k: metric.lift_at_k,
    average_precision: metric.average_precision,
    qualifies,
  };
}

function notReadyPromotion(targetId, readiness) {
  return {
    target_id: targetId,
    horizon_commits: readiness.horizon_commits,
    state: "NOT_READY",
    failure_code: "FAIL-PREDICTIVE-READINESS",
    nomination: null,
    terminal_holdout: {
      fold_id: null,
      state: "NOT_READ",
      failure_code: "FAIL-PREDICTIVE-READINESS",
      classes: null,
      nominated_method: null,
      fallback_method: null,
      qualification_rule: PROMOTION_RULE,
    },
    selected_method: null,
    forecast_eligible: false,
    summary: `The ${readiness.horizon_commits}-commit horizon has ${readiness.cutoff_snapshot_count} cutoff snapshots; six are required before evaluation.`,
  };
}

function notEvaluatedPromotion(evaluation) {
  return {
    target_id: evaluation.target_id,
    horizon_commits: evaluation.horizon_commits,
    state: "READY_NOT_EVALUATED",
    failure_code: "FAIL-PREDICTIVE-PROMOTION",
    nomination: null,
    terminal_holdout: {
      fold_id: evaluation.terminal_fold_id,
      state: "NOT_READ",
      failure_code: "FAIL-PREDICTIVE-PROMOTION",
      classes: null,
      nominated_method: null,
      fallback_method: null,
      qualification_rule: PROMOTION_RULE,
    },
    selected_method: null,
    forecast_eligible: false,
    summary: "Three development folds exist, but they do not all contain both observed classes and complete average-precision evidence.",
  };
}

function nominate(evaluation) {
  if (evaluation.development_folds.some((fold) => !bothClasses(fold.classes))) return null;
  const methodEvidence = METHOD_REGISTRY.map((method, methodIndex) => {
    const metrics = evaluation.development_folds.map((fold) => methodMetric(fold, method.method_id));
    if (metrics.some((metric) => metric.average_precision === null)) return null;
    return {
      method_id: method.method_id,
      method_kind: method.method_kind,
      mean_average_precision: metrics.reduce((sum, metric) => sum + metric.average_precision, 0) / metrics.length,
      method_order: methodIndex,
    };
  });
  if (methodEvidence.some((evidence) => evidence === null)) return null;
  const candidates = methodEvidence.sort((left, right) => (
    right.mean_average_precision - left.mean_average_precision
      || left.method_order - right.method_order
  ));
  const nominated = candidates[0] ?? null;
  if (nominated === null) return null;
  return {
    method_id: nominated.method_id,
    method_kind: nominated.method_kind,
    development_fold_ids: evaluation.development_fold_ids.slice(),
    metric: NOMINATION_METRIC,
    mean_average_precision: nominated.mean_average_precision,
    tie_rule: NOMINATION_TIE_RULE,
  };
}

function nominatePredictiveDevelopment(value = {}) {
  const evaluation = normalizeDevelopmentNominationInput(value);
  const nomination = nominate(evaluation);
  const result = deepFreeze({
    schema_version: DEVELOPMENT_NOMINATION_VERSION,
    kind: "development-only-predictive-nomination",
    target_id: evaluation.target_id,
    horizon_commits: evaluation.horizon_commits,
    state: nomination === null ? "READY_NOT_EVALUATED" : "NOMINATED",
    nomination,
  });
  brandedDevelopmentNominations.add(result);
  return result;
}

function readPredictiveDevelopmentNomination(value) {
  if (!brandedDevelopmentNominations.has(value)
      || value?.schema_version !== DEVELOPMENT_NOMINATION_VERSION) {
    fail("FAIL-PREDICTIVE-BINDING", "development nomination is not package-branded");
  }
  return value;
}

function evaluatedPromotion(evaluation) {
  // Nomination is deliberately complete before the terminal fold is read.
  const nomination = nominate(evaluation);
  if (nomination === null) return notEvaluatedPromotion(evaluation);

  const terminal = evaluation.read_terminal_fold();
  if (!bothClasses(terminal.classes)) {
    return {
      target_id: evaluation.target_id,
      horizon_commits: evaluation.horizon_commits,
      state: "NO_USEFUL_SIGNAL",
      failure_code: "FAIL-PREDICTIVE-TERMINAL-HOLDOUT",
      nomination,
      terminal_holdout: {
        fold_id: terminal.fold_id,
        state: "INSUFFICIENT_CLASSES",
        failure_code: "FAIL-PREDICTIVE-TERMINAL-HOLDOUT",
        classes: terminal.classes,
        nominated_method: null,
        fallback_method: null,
        qualification_rule: PROMOTION_RULE,
      },
      selected_method: null,
      forecast_eligible: false,
      summary: "The untouched terminal holdout does not contain both observed classes, so no current ranking forecast is authorized.",
    };
  }

  const nominatedMetric = methodMetric(terminal, nomination.method_id);
  const fallbackMetric = methodMetric(terminal, FALLBACK_METHOD_ID);
  const fallbackQualifies = fallbackMetric.lift_at_k !== null
    && fallbackMetric.average_precision !== null
    && fallbackMetric.lift_at_k > 1;
  const nominatedQualifies = nominatedMetric.lift_at_k !== null
    && nominatedMetric.average_precision !== null
    && fallbackMetric.average_precision !== null
    && nominatedMetric.lift_at_k > 1
    && nominatedMetric.average_precision >= fallbackMetric.average_precision;

  let selected = null;
  let state = "NO_USEFUL_SIGNAL";
  if (nomination.method_id !== FALLBACK_METHOD_ID && nominatedQualifies) {
    selected = METHOD_BY_ID.get(nomination.method_id);
    state = selected.method_kind === "simple-baseline" ? "VALIDATED_BASELINE" : "VALIDATED_MODEL";
  } else if (fallbackQualifies) {
    selected = METHOD_BY_ID.get(FALLBACK_METHOD_ID);
    state = "VALIDATED_BASELINE";
  }
  const selectedMethod = selected === null ? null : {
    method_id: selected.method_id,
    method_kind: selected.method_kind,
    validation_basis: "untouched-terminal-holdout",
  };
  const summary = state === "VALIDATED_MODEL"
    ? "The nominated composite ranking passed the untouched terminal holdout against the predeclared change-frequency fallback."
    : state === "VALIDATED_BASELINE"
      ? "A simple baseline passed the untouched terminal holdout; the validated result is limited to that baseline ranking."
      : "Neither the locked nominee nor the predeclared change-frequency fallback passed the untouched terminal holdout.";
  return {
    target_id: evaluation.target_id,
    horizon_commits: evaluation.horizon_commits,
    state,
    failure_code: state === "NO_USEFUL_SIGNAL" ? "FAIL-PREDICTIVE-PROMOTION" : null,
    nomination,
    terminal_holdout: {
      fold_id: terminal.fold_id,
      state: "EVALUATED",
      failure_code: null,
      classes: terminal.classes,
      nominated_method: terminalProjection(nominatedMetric, nominatedQualifies),
      fallback_method: terminalProjection(fallbackMetric, fallbackQualifies),
      qualification_rule: PROMOTION_RULE,
    },
    selected_method: selectedMethod,
    forecast_eligible: selectedMethod !== null,
    summary,
  };
}

function aggregatePublicState(promotions) {
  const states = new Set(promotions.map((promotion) => promotion.state));
  if (states.has("VALIDATED_MODEL")) return "VALIDATED_MODEL";
  if (states.has("VALIDATED_BASELINE")) return "VALIDATED_BASELINE";
  if (states.has("NO_USEFUL_SIGNAL")) return "NO_USEFUL_SIGNAL";
  if (states.has("READY_NOT_EVALUATED")) return "READY_NOT_EVALUATED";
  return "NOT_READY";
}

function evaluatePredictivePromotion(input = {}) {
  const normalized = normalizeInput(input);
  const readinessByHorizon = new Map(normalized.readiness.map((entry) => [entry.horizon_commits, entry]));
  const promotions = HORIZON_COMMITS.flatMap((horizon) => TARGET_IDS.map((targetId) => {
    const readiness = readinessByHorizon.get(horizon);
    if (readiness.state !== "READY") return notReadyPromotion(targetId, readiness);
    return evaluatedPromotion(normalized.byKey.get(`${targetId}\0${horizon}`));
  }));
  const validatedSelections = promotions.filter((promotion) => promotion.forecast_eligible).map((promotion) => ({
    target_id: promotion.target_id,
    horizon_commits: promotion.horizon_commits,
    state: promotion.state,
    method_id: promotion.selected_method.method_id,
    method_kind: promotion.selected_method.method_kind,
  }));
  const readinessState = normalized.readiness.every((entry) => entry.state === "INSUFFICIENT_HISTORY")
    ? "NOT_READY"
    : normalized.readiness.every((entry) => entry.state === "READY") ? "READY" : "PARTIALLY_READY";
  const body = {
    schema_version: PREDICTIVE_PROMOTION_VERSION,
    kind: "terminal-holdout-promotion-decision",
    public_state: aggregatePublicState(promotions),
    readiness: {
      state: readinessState,
      failure_code: readinessState === "READY" ? null : "FAIL-PREDICTIVE-READINESS",
      horizons: normalized.readiness,
    },
    binding: normalized.currentBinding,
    protocol: normalized.protocol,
    promotions,
    validated_selections: validatedSelections,
    interpretation_boundary: "rank-only ordering of mechanically observed repository-change targets",
  };
  const result = deepFreeze({
    ...body,
    promotion_sha256: `sha256:${crypto.createHash("sha256").update(stableStringify(body)).digest("hex")}`,
  });
  brandedPromotions.add(result);
  return result;
}

function readPredictivePromotion(value) {
  if (!brandedPromotions.has(value) || !SHA256.test(value?.promotion_sha256 ?? "")) {
    fail("FAIL-PREDICTIVE-BINDING", "predictive promotion is not package-branded");
  }
  return value;
}

module.exports = {};
Object.defineProperty(module.exports, Symbol.for("sei.predictive-promotion.private.v1"), {
  value: Object.freeze({
    PREDICTIVE_PROMOTION_VERSION,
    DEVELOPMENT_NOMINATION_VERSION,
    INPUT_SCHEMA_VERSION,
    EVALUATION_SCHEMA_VERSION,
    CANDIDATE_REGISTRY_VERSION,
    TARGET_SCHEMA_VERSION,
    EVALUATION_PROTOCOL_VERSION,
    FALLBACK_METHOD_ID,
    METHOD_REGISTRY,
    TARGET_IDS,
    HORIZON_COMMITS,
    NOMINATION_METRIC,
    NOMINATION_TIE_RULE,
    PROMOTION_RULE,
    ELIGIBLE_COMMIT_RULE,
    OUTCOME_WINDOW_RULE,
    CUTOFF_SELECTION_RULE,
    DEVELOPMENT_FOLD_COUNT,
    TERMINAL_HOLDOUT_FOLD_COUNT,
    MINIMUM_CUTOFF_SNAPSHOT_COUNT,
    evaluatePredictivePromotion,
    nominatePredictiveDevelopment,
    readPredictiveDevelopmentNomination,
    readPredictivePromotion,
  }),
});
