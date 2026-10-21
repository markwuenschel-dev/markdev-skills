"use strict";

const PREDICTIVE_STATUS_VERSION = "sei.predictive-status@1";
const MAX_CUTOFF_SNAPSHOTS = 256;
const MAX_FORWARD_FOLDS = 255;
const MIN_CUTOFF_SNAPSHOTS = 3;
const MAX_OUTCOMES = 16;
const MAX_BASELINES = 10_000;
const OUTCOME_STATES = new Set(["evaluated", "partially-evaluated", "not-established", "unavailable"]);
const V9_RECEIPT_SUMMARY_VERSION = "sei.predictive-status-receipt@2";
const V9_SOURCE_SCHEMA_VERSION = "sei.forward-temporal-evaluation@3";
const V9_TARGETS = Object.freeze(["future-modification", "repeated-modification", "high-churn"]);
const V9_HORIZONS = Object.freeze([10, 25, 50]);
const V9_STATES = new Set([
  "NOT_READY",
  "READY_NOT_EVALUATED",
  "VALIDATED_BASELINE",
  "VALIDATED_MODEL",
  "NO_USEFUL_SIGNAL",
]);
const V9_TERMINAL_STATES = new Set(["NOT_READ", "EVALUATED", "INSUFFICIENT_CLASSES"]);
const V9_METHODS = new Map([
  ["sei-four-signal-composite-v1", "sei-heuristic"],
  ["baseline-loc-v1", "simple-baseline"],
  ["baseline-change-frequency-v1", "simple-baseline"],
  ["baseline-churn-v1", "simple-baseline"],
  ["baseline-complexity-v1", "simple-baseline"],
]);

function fail(detail) {
  const error = new Error(`FAIL-PREDICTIVE-STATUS: ${detail}`);
  error.code = "FAIL-PREDICTIVE-STATUS";
  throw error;
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosed(value, fields, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain closed record`);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field)).sort(stableCompare);
  if (unknown.length > 0) fail(`${label}.${unknown[0]} is not declared`);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length > 0) fail(`${label}.${missing[0]} is required`);
}

function assertStableId(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value
      || value.includes("\0") || /[\r\n]/.test(value)) {
    fail(`${label} must be a bounded nonblank stable identifier`);
  }
}

function assertRevision(value, label) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? "")) {
    fail(`${label} must be a full lowercase object identifier`);
  }
}

function assertConfigurationHash(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) fail(`${label} must be a lowercase SHA-256 digest`);
}

function assertSnapshotId(value, label) {
  if (!/^sei-v[1-9][0-9]*-[0-9a-f]{64}$/.test(value ?? "")) {
    fail(`${label} must be a canonical SEI snapshot identifier`);
  }
}

function assertReceiptDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? "")) {
    fail(`${label} must be a prefixed lowercase SHA-256 digest`);
  }
}

function assertBoundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(`${label} must be a safe integer from zero through ${maximum}`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateCurrentSnapshot(value) {
  assertClosed(value, ["repository_id", "revision", "configuration_hash", "snapshot_id"], "current_snapshot");
  assertStableId(value.repository_id, "current_snapshot.repository_id");
  assertRevision(value.revision, "current_snapshot.revision");
  assertConfigurationHash(value.configuration_hash, "current_snapshot.configuration_hash");
  assertSnapshotId(value.snapshot_id, "current_snapshot.snapshot_id");
  return {
    repository_id: value.repository_id,
    revision: value.revision,
    configuration_hash: value.configuration_hash,
    snapshot_id: value.snapshot_id,
  };
}

function validateComparison(value, label) {
  assertClosed(value, [
    "baseline_count",
    "baseline_better_count",
    "composite_better_count",
    "tied_count",
    "unavailable_count",
  ], label);
  for (const field of Object.keys(value)) assertBoundedInteger(value[field], `${label}.${field}`, MAX_BASELINES);
  const total = value.baseline_better_count + value.composite_better_count + value.tied_count + value.unavailable_count;
  if (total !== value.baseline_count) fail(`${label} counts must exactly partition baseline_count`);
  return {
    baseline_count: value.baseline_count,
    baseline_better_count: value.baseline_better_count,
    composite_better_count: value.composite_better_count,
    tied_count: value.tied_count,
    unavailable_count: value.unavailable_count,
  };
}

function validateOutcome(value, index, forwardFoldCount) {
  const label = `receipt.outcomes[${index}]`;
  assertClosed(value, ["outcome_id", "state", "evaluated_fold_count", "baseline_vs_composite"], label);
  assertStableId(value.outcome_id, `${label}.outcome_id`);
  if (!OUTCOME_STATES.has(value.state)) fail(`${label}.state is unsupported`);
  assertBoundedInteger(value.evaluated_fold_count, `${label}.evaluated_fold_count`, forwardFoldCount);
  if (value.state === "evaluated" && value.evaluated_fold_count < 2) {
    fail(`${label}.evaluated state requires at least two forward folds`);
  }
  return {
    outcome_id: value.outcome_id,
    state: value.state,
    evaluated_fold_count: value.evaluated_fold_count,
    baseline_vs_composite: validateComparison(value.baseline_vs_composite, `${label}.baseline_vs_composite`),
  };
}

function validateLegacyReceipt(value) {
  assertClosed(value, [
    "repository_id",
    "final_revision",
    "configuration_hash",
    "cutoff_snapshot_ids",
    "forward_fold_count",
    "outcomes",
    "receipt_sha256",
  ], "receipt");
  assertStableId(value.repository_id, "receipt.repository_id");
  assertRevision(value.final_revision, "receipt.final_revision");
  assertConfigurationHash(value.configuration_hash, "receipt.configuration_hash");
  assertReceiptDigest(value.receipt_sha256, "receipt.receipt_sha256");
  if (!Array.isArray(value.cutoff_snapshot_ids) || value.cutoff_snapshot_ids.length < MIN_CUTOFF_SNAPSHOTS
      || value.cutoff_snapshot_ids.length > MAX_CUTOFF_SNAPSHOTS) {
    fail(`receipt.cutoff_snapshot_ids must contain from ${MIN_CUTOFF_SNAPSHOTS} through ${MAX_CUTOFF_SNAPSHOTS} canonical snapshot IDs`);
  }
  value.cutoff_snapshot_ids.forEach((snapshotId, index) => assertSnapshotId(snapshotId, `receipt.cutoff_snapshot_ids[${index}]`));
  const cutoffSnapshotIds = [...new Set(value.cutoff_snapshot_ids)].sort(stableCompare);
  if (cutoffSnapshotIds.length !== value.cutoff_snapshot_ids.length) fail("receipt.cutoff_snapshot_ids must be unique");
  assertBoundedInteger(value.forward_fold_count, "receipt.forward_fold_count", MAX_FORWARD_FOLDS);
  if (value.forward_fold_count !== cutoffSnapshotIds.length - 2) {
    fail("receipt.forward_fold_count must equal cutoff snapshot count minus two");
  }
  if (!Array.isArray(value.outcomes) || value.outcomes.length === 0 || value.outcomes.length > MAX_OUTCOMES) {
    fail(`receipt.outcomes must contain from one through ${MAX_OUTCOMES} outcomes`);
  }
  const outcomes = value.outcomes.map((outcome, index) => validateOutcome(outcome, index, value.forward_fold_count));
  const outcomeIds = outcomes.map((outcome) => outcome.outcome_id);
  if (new Set(outcomeIds).size !== outcomeIds.length) fail("receipt.outcomes must use unique outcome IDs");
  outcomes.sort((left, right) => stableCompare(left.outcome_id, right.outcome_id));
  return {
    repository_id: value.repository_id,
    final_revision: value.final_revision,
    configuration_hash: value.configuration_hash,
    cutoff_snapshot_ids: cutoffSnapshotIds,
    forward_fold_count: value.forward_fold_count,
    outcomes,
    receipt_sha256: value.receipt_sha256,
  };
}

function validateV9HorizonBinding(value, index) {
  const label = `receipt.horizon_cutoff_snapshot_ids[${index}]`;
  assertClosed(value, ["horizon_commits", "cutoff_snapshot_ids"], label);
  if (!V9_HORIZONS.includes(value.horizon_commits)) fail(`${label}.horizon_commits is unsupported`);
  if (!Array.isArray(value.cutoff_snapshot_ids) || value.cutoff_snapshot_ids.length === 0
      || value.cutoff_snapshot_ids.length > MAX_CUTOFF_SNAPSHOTS) {
    fail(`${label}.cutoff_snapshot_ids must be a bounded nonempty array`);
  }
  value.cutoff_snapshot_ids.forEach((snapshotId, snapshotIndex) => (
    assertSnapshotId(snapshotId, `${label}.cutoff_snapshot_ids[${snapshotIndex}]`)
  ));
  if (new Set(value.cutoff_snapshot_ids).size !== value.cutoff_snapshot_ids.length) {
    fail(`${label}.cutoff_snapshot_ids must be unique`);
  }
  return {
    horizon_commits: value.horizon_commits,
    cutoff_snapshot_ids: value.cutoff_snapshot_ids.slice(),
  };
}

function validateV9Promotion(value, index) {
  const label = `receipt.promotions[${index}]`;
  assertClosed(value, [
    "forecast_item_count",
    "horizon_commits",
    "selected_method_id",
    "selected_method_kind",
    "state",
    "target_id",
    "terminal_state",
  ], label);
  if (!V9_TARGETS.includes(value.target_id)) fail(`${label}.target_id is not a frozen predictive target`);
  if (!V9_HORIZONS.includes(value.horizon_commits)) fail(`${label}.horizon_commits is unsupported`);
  if (!V9_STATES.has(value.state)) fail(`${label}.state is unsupported`);
  if (!V9_TERMINAL_STATES.has(value.terminal_state)) fail(`${label}.terminal_state is unsupported`);
  assertBoundedInteger(value.forecast_item_count, `${label}.forecast_item_count`, 100_000);
  const validated = value.state === "VALIDATED_BASELINE" || value.state === "VALIDATED_MODEL";
  if (validated) {
    if (!V9_METHODS.has(value.selected_method_id)
        || V9_METHODS.get(value.selected_method_id) !== value.selected_method_kind
        || value.forecast_item_count < 1
        || value.terminal_state !== "EVALUATED") {
      fail(`${label} validated state requires one registry method, terminal evidence, and a nonempty rank-only forecast`);
    }
    if (value.state === "VALIDATED_MODEL" && value.selected_method_kind !== "sei-heuristic") {
      fail(`${label} VALIDATED_MODEL requires the frozen composite method`);
    }
    if (value.state === "VALIDATED_BASELINE" && value.selected_method_kind !== "simple-baseline") {
      fail(`${label} VALIDATED_BASELINE requires a frozen simple baseline`);
    }
  } else if (value.selected_method_id !== null || value.selected_method_kind !== null || value.forecast_item_count !== 0) {
    fail(`${label} nonvalidated state cannot carry a selected method or current forecast`);
  }
  if (value.state === "NO_USEFUL_SIGNAL" && value.terminal_state === "NOT_READ") {
    fail(`${label} NO_USEFUL_SIGNAL requires an evaluated or class-insufficient terminal holdout`);
  }
  if (new Set(["NOT_READY", "READY_NOT_EVALUATED"]).has(value.state) && value.terminal_state !== "NOT_READ") {
    fail(`${label} readiness state cannot claim terminal evaluation`);
  }
  return {
    target_id: value.target_id,
    horizon_commits: value.horizon_commits,
    state: value.state,
    selected_method_id: value.selected_method_id,
    selected_method_kind: value.selected_method_kind,
    terminal_state: value.terminal_state,
    forecast_item_count: value.forecast_item_count,
  };
}

function validateV9Receipt(value) {
  assertClosed(value, [
    "configuration_hash",
    "development_fold_count",
    "final_revision",
    "final_snapshot_id",
    "horizon_cutoff_snapshot_ids",
    "promotions",
    "receipt_sha256",
    "repository_id",
    "schema_version",
    "source_schema_version",
    "terminal_holdout_fold_count",
  ], "receipt");
  if (value.schema_version !== V9_RECEIPT_SUMMARY_VERSION
      || value.source_schema_version !== V9_SOURCE_SCHEMA_VERSION) {
    fail("receipt schema versions are stale or unsupported");
  }
  assertStableId(value.repository_id, "receipt.repository_id");
  assertRevision(value.final_revision, "receipt.final_revision");
  assertSnapshotId(value.final_snapshot_id, "receipt.final_snapshot_id");
  assertConfigurationHash(value.configuration_hash, "receipt.configuration_hash");
  assertReceiptDigest(value.receipt_sha256, "receipt.receipt_sha256");
  if (value.development_fold_count !== 3 || value.terminal_holdout_fold_count !== 1) {
    fail("receipt must bind exactly three development folds and one terminal holdout");
  }
  if (!Array.isArray(value.horizon_cutoff_snapshot_ids)
      || value.horizon_cutoff_snapshot_ids.length !== V9_HORIZONS.length) {
    fail("receipt.horizon_cutoff_snapshot_ids must cover all three frozen horizons");
  }
  const horizons = value.horizon_cutoff_snapshot_ids.map(validateV9HorizonBinding)
    .sort((left, right) => V9_HORIZONS.indexOf(left.horizon_commits) - V9_HORIZONS.indexOf(right.horizon_commits));
  if (!sameSequence(horizons.map((entry) => entry.horizon_commits), V9_HORIZONS)) {
    fail("receipt.horizon_cutoff_snapshot_ids must use each frozen horizon exactly once");
  }
  if (!Array.isArray(value.promotions) || value.promotions.length !== V9_TARGETS.length * V9_HORIZONS.length) {
    fail("receipt.promotions must cover every frozen target/horizon cell");
  }
  const promotions = value.promotions.map(validateV9Promotion).sort((left, right) => (
    V9_HORIZONS.indexOf(left.horizon_commits) - V9_HORIZONS.indexOf(right.horizon_commits)
      || V9_TARGETS.indexOf(left.target_id) - V9_TARGETS.indexOf(right.target_id)
  ));
  const keys = promotions.map((entry) => `${entry.target_id}\0${entry.horizon_commits}`);
  if (new Set(keys).size !== keys.length) fail("receipt.promotions must use unique target/horizon cells");
  for (const horizon of horizons) {
    const horizonPromotions = promotions.filter((promotion) => promotion.horizon_commits === horizon.horizon_commits);
    const cutoffCount = horizon.cutoff_snapshot_ids.length;
    if (cutoffCount > 6) {
      fail(`receipt horizon ${horizon.horizon_commits} evaluated evidence must bind exactly six selected cutoff snapshot IDs`);
    }
    const ready = cutoffCount === 6;
    if (horizonPromotions.some((promotion) => (promotion.state !== "NOT_READY") !== ready)) {
      fail(`receipt horizon ${horizon.horizon_commits} readiness contradicts its cutoff count`);
    }
  }
  return {
    schema_version: value.schema_version,
    source_schema_version: value.source_schema_version,
    repository_id: value.repository_id,
    final_revision: value.final_revision,
    final_snapshot_id: value.final_snapshot_id,
    configuration_hash: value.configuration_hash,
    horizon_cutoff_snapshot_ids: horizons,
    development_fold_count: value.development_fold_count,
    terminal_holdout_fold_count: value.terminal_holdout_fold_count,
    promotions,
    receipt_sha256: value.receipt_sha256,
  };
}

function sameSequence(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function comparisonSummary(comparison) {
  return `Across ${comparison.baseline_count} baseline-to-composite ranking-score comparisons: ${comparison.baseline_better_count} baseline higher, ${comparison.composite_better_count} composite higher, ${comparison.tied_count} tied, and ${comparison.unavailable_count} unavailable. This does not establish causation.`;
}

function projectOutcomes(outcomes) {
  return outcomes.map((outcome) => ({
    outcome_id: outcome.outcome_id,
    state: outcome.state,
    evaluated_fold_count: outcome.evaluated_fold_count,
    baseline_vs_composite: {
      basis: "forward-fold ranking-score comparison",
      baseline_count: outcome.baseline_vs_composite.baseline_count,
      baseline_better_count: outcome.baseline_vs_composite.baseline_better_count,
      composite_better_count: outcome.baseline_vs_composite.composite_better_count,
      tied_count: outcome.baseline_vs_composite.tied_count,
      unavailable_count: outcome.baseline_vs_composite.unavailable_count,
      summary: comparisonSummary(outcome.baseline_vs_composite),
    },
  }));
}

function v9PromotionSummary(promotion) {
  if (promotion.state === "VALIDATED_BASELINE") {
    return `The ${promotion.horizon_commits}-commit ${promotion.target_id} ranking is validated only as a simple baseline.`;
  }
  if (promotion.state === "VALIDATED_MODEL") {
    return `The ${promotion.horizon_commits}-commit ${promotion.target_id} composite ranking passed its untouched terminal holdout.`;
  }
  if (promotion.state === "NO_USEFUL_SIGNAL") {
    return `The ${promotion.horizon_commits}-commit ${promotion.target_id} result authorizes no current forecast.`;
  }
  if (promotion.state === "READY_NOT_EVALUATED") {
    return `The ${promotion.horizon_commits}-commit ${promotion.target_id} evidence is ready but development nomination was not established.`;
  }
  return `The ${promotion.horizon_commits}-commit ${promotion.target_id} evidence is not ready for terminal evaluation.`;
}

function projectV9Promotions(promotions, allowForecast) {
  return promotions.map((promotion) => ({
    target_id: promotion.target_id,
    horizon_commits: promotion.horizon_commits,
    state: promotion.state,
    selected_method: promotion.selected_method_id === null ? null : {
      method_id: promotion.selected_method_id,
      method_kind: promotion.selected_method_kind,
    },
    terminal_state: promotion.terminal_state,
    forecast_item_count: allowForecast ? promotion.forecast_item_count : 0,
    summary: v9PromotionSummary(promotion),
  }));
}

function aggregateV9State(promotions) {
  const states = new Set(promotions.map((promotion) => promotion.state));
  if (states.has("VALIDATED_MODEL")) return "VALIDATED_MODEL";
  if (states.has("VALIDATED_BASELINE")) return "VALIDATED_BASELINE";
  if (states.has("NO_USEFUL_SIGNAL")) return "NO_USEFUL_SIGNAL";
  if (states.has("READY_NOT_EVALUATED")) return "READY_NOT_EVALUATED";
  return "NOT_READY";
}

function v9Summary(state) {
  if (state === "VALIDATED_MODEL") return "At least one composite ranking passed its untouched terminal holdout.";
  if (state === "VALIDATED_BASELINE") return "The terminally supported current ranking is a validated simple baseline.";
  if (state === "NO_USEFUL_SIGNAL") return "Terminal evaluation found no useful signal, so there is no current forecast.";
  if (state === "READY_NOT_EVALUATED") return "Required cutoff history exists, but development nomination was not established.";
  if (state === "NOT_READY") return "At least one predictive horizon lacks the required cutoff history.";
  if (state === "STALE") return "The predictive receipt is compatible historical evidence but does not bind this current snapshot.";
  return "The predictive receipt belongs to a different repository identity or configuration.";
}

function deriveV9Status(current, receipt) {
  const compatibleRepository = receipt.repository_id === current.repository_id;
  const compatibleConfiguration = receipt.configuration_hash === current.configuration_hash;
  if (!compatibleRepository || !compatibleConfiguration) {
    return {
      state: "INCOMPATIBLE",
      compatibility: "not-comparable",
      exact_snapshot_participation: null,
      outcomes: projectV9Promotions(receipt.promotions, false),
      summary: v9Summary("INCOMPATIBLE"),
    };
  }
  const exact = receipt.final_revision === current.revision
    && receipt.final_snapshot_id === current.snapshot_id
    && receipt.horizon_cutoff_snapshot_ids.every((horizon) => horizon.cutoff_snapshot_ids.at(-1) === current.snapshot_id);
  if (!exact) {
    return {
      state: "STALE",
      compatibility: "compatible",
      exact_snapshot_participation: false,
      outcomes: projectV9Promotions(receipt.promotions, false),
      summary: v9Summary("STALE"),
    };
  }
  const state = aggregateV9State(receipt.promotions);
  return {
    state,
    compatibility: "compatible",
    exact_snapshot_participation: true,
    outcomes: projectV9Promotions(receipt.promotions, true),
    summary: v9Summary(state),
  };
}

function evaluatedState(current, receipt) {
  const compatible = receipt.repository_id === current.repository_id
    && receipt.configuration_hash === current.configuration_hash;
  if (!compatible) {
    return {
      compatibility: "not-comparable",
      exact_snapshot_participation: null,
      state: "prior-evaluation-not-comparable",
      summary: "A prior predictive evaluation receipt summary exists, but its repository identity or configuration does not match this snapshot.",
    };
  }
  const exactSnapshotParticipation = receipt.cutoff_snapshot_ids.includes(current.snapshot_id);
  if (exactSnapshotParticipation && receipt.final_revision === current.revision) {
    const establishedOutcomeCount = receipt.outcomes.filter((outcome) => outcome.state === "evaluated").length;
    if (establishedOutcomeCount === 0) {
      return {
        compatibility: "compatible",
        exact_snapshot_participation: true,
        state: "unresolved",
        summary: "A compatible predictive receipt includes this exact snapshot as the final cutoff, but no outcome aggregate reached the required two forward folds.",
      };
    }
    return {
      compatibility: "compatible",
      exact_snapshot_participation: true,
      state: "evaluated-current",
      summary: "A compatible predictive evaluation includes this exact snapshot as the final cutoff.",
    };
  }
  if (exactSnapshotParticipation) {
    return {
      compatibility: "compatible",
      exact_snapshot_participation: true,
      state: "unresolved",
      summary: "A compatible predictive receipt includes this snapshot but ends at a different revision, so it cannot establish current-snapshot evaluation.",
    };
  }
  return {
    compatibility: "compatible",
    exact_snapshot_participation: false,
    state: "previously-evaluated-compatible-not-current",
    summary: "A compatible predictive evaluation exists, but it does not include this exact snapshot as its final cutoff.",
  };
}

function validateInput(input) {
  if (!isPlainRecord(input)) fail("input must be a plain closed record");
  const allowed = new Set(["current_snapshot", "receipt"]);
  const unknown = Object.keys(input).filter((field) => !allowed.has(field)).sort(stableCompare);
  if (unknown.length > 0) fail(`input.${unknown[0]} is not declared`);
  if (!Object.hasOwn(input, "current_snapshot")) fail("input.current_snapshot is required");
  return {
    current_snapshot: input.current_snapshot,
    receipt: Object.hasOwn(input, "receipt") ? input.receipt : null,
  };
}

function derivePredictiveStatus(input) {
  const normalizedInput = validateInput(input);
  const current = validateCurrentSnapshot(normalizedInput.current_snapshot);
  if (normalizedInput.receipt === null) {
    return deepFreeze({
      predictive_status_version: PREDICTIVE_STATUS_VERSION,
      state: "not-yet-evaluated",
      evaluation_exists: false,
      compatibility: "not-assessed",
      exact_snapshot_participation: null,
      receipt: null,
      outcomes: [],
      summary: "No validated predictive evaluation receipt summary was supplied for this snapshot.",
    });
  }
  if (Object.hasOwn(normalizedInput.receipt, "schema_version")) {
    const receipt = validateV9Receipt(normalizedInput.receipt);
    const status = deriveV9Status(current, receipt);
    return deepFreeze({
      predictive_status_version: PREDICTIVE_STATUS_VERSION,
      state: status.state,
      evaluation_exists: true,
      compatibility: status.compatibility,
      exact_snapshot_participation: status.exact_snapshot_participation,
      receipt: {
        receipt_sha256: receipt.receipt_sha256,
        digest_status: "declared-not-recomputed",
        final_revision: receipt.final_revision,
        horizon_count: receipt.horizon_cutoff_snapshot_ids.length,
        development_fold_count: receipt.development_fold_count,
        terminal_holdout_fold_count: receipt.terminal_holdout_fold_count,
      },
      outcomes: status.outcomes,
      summary: status.summary,
    });
  }
  const receipt = validateLegacyReceipt(normalizedInput.receipt);
  const status = evaluatedState(current, receipt);
  return deepFreeze({
    predictive_status_version: PREDICTIVE_STATUS_VERSION,
    state: status.state,
    evaluation_exists: true,
    compatibility: status.compatibility,
    exact_snapshot_participation: status.exact_snapshot_participation,
    receipt: {
      receipt_sha256: receipt.receipt_sha256,
      digest_status: "declared-not-recomputed",
      final_revision: receipt.final_revision,
      forward_fold_count: receipt.forward_fold_count,
      cutoff_snapshot_count: receipt.cutoff_snapshot_ids.length,
    },
    outcomes: projectOutcomes(receipt.outcomes),
    summary: status.summary,
  });
}

module.exports = {
  PREDICTIVE_STATUS_VERSION,
  derivePredictiveStatus,
};
