"use strict";

const TREND_STATUS_VERSION = "sei.trend-status@1";
const MAX_COMPARISONS = 100_000;
const MAX_TEXT = 512;
const BASELINE_BINDING_KINDS = new Set(["automatic", "explicit"]);
const BASELINE_STATUSES = new Set(["established", "selected", "explicit"]);
const HISTORY_STATES = new Set(["measured", "inferred", "unavailable", "unverifiable", "not-applicable"]);
const OBSERVED_HISTORY_STATES = new Set(["measured", "inferred"]);
const HISTORY_SCOPES = new Set(["full-repository", "configured-window"]);

function fail(detail) {
  const error = new Error(`FAIL-TREND-STATUS: ${detail}`);
  error.code = "FAIL-TREND-STATUS";
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
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT || value.trim() !== value
      || value.includes("\0") || /[\r\n]/.test(value)) {
    fail(`${label} must be a bounded nonblank stable identifier`);
  }
}

function assertRevision(value, label) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? "")) {
    fail(`${label} must be a full lowercase object identifier`);
  }
}

function assertSnapshotId(value, label) {
  if (!/^sei-v[1-9][0-9]*-[0-9a-f]{64}$/.test(value ?? "")) {
    fail(`${label} must be a canonical SEI snapshot identifier`);
  }
}

function assertFraction(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite ratio from zero through one`);
  }
}

function assertBoundedCount(value, label, maximum) {
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
  assertClosed(value, ["snapshot_id", "repository_revision"], "current_snapshot");
  assertSnapshotId(value.snapshot_id, "current_snapshot.snapshot_id");
  assertRevision(value.repository_revision, "current_snapshot.repository_revision");
  return {
    snapshot_id: value.snapshot_id,
    repository_revision: value.repository_revision,
  };
}

function nullableSnapshotId(value, label) {
  if (value === null) return null;
  assertSnapshotId(value, label);
  return value;
}

function nullableRevision(value, label) {
  if (value === null) return null;
  assertRevision(value, label);
  return value;
}

function validateBaseline(value) {
  if (value === null) return null;
  assertClosed(value, [
    "binding_kind",
    "status",
    "eligible",
    "baseline_snapshot_id",
    "baseline_repository_revision",
    "compatible_metric_count",
  ], "baseline");
  if (!BASELINE_BINDING_KINDS.has(value.binding_kind)) fail("baseline.binding_kind is unsupported");
  if (!BASELINE_STATUSES.has(value.status)) fail("baseline.status is unsupported");
  if (typeof value.eligible !== "boolean") fail("baseline.eligible must be boolean");
  const baselineSnapshotId = nullableSnapshotId(value.baseline_snapshot_id, "baseline.baseline_snapshot_id");
  const baselineRevision = nullableRevision(value.baseline_repository_revision, "baseline.baseline_repository_revision");
  assertBoundedCount(value.compatible_metric_count, "baseline.compatible_metric_count", MAX_COMPARISONS);

  if (value.status === "established") {
    if (value.binding_kind !== "automatic" || baselineSnapshotId !== null || baselineRevision !== null
        || value.compatible_metric_count !== 0) {
      fail("established baseline must be an unbound automatic baseline with zero compatible metrics");
    }
  }
  if (value.status === "selected") {
    if (value.binding_kind !== "automatic" || value.eligible !== true || baselineSnapshotId === null
        || baselineRevision === null || value.compatible_metric_count === 0) {
      fail("selected baseline must be an eligible automatic baseline with at least one compatible metric");
    }
  }
  if (value.status === "explicit") {
    if (value.binding_kind !== "explicit" || baselineSnapshotId === null || baselineRevision === null
        || value.eligible !== (value.compatible_metric_count > 0)) {
      fail("explicit baseline eligibility must exactly match compatible metric bindings");
    }
  }
  return {
    binding_kind: value.binding_kind,
    status: value.status,
    eligible: value.eligible,
    baseline_snapshot_id: baselineSnapshotId,
    baseline_repository_revision: baselineRevision,
    compatible_metric_count: value.compatible_metric_count,
  };
}

function validateHistory(value) {
  if (value === null) return null;
  assertClosed(value, [
    "metric_id",
    "definition_id",
    "state",
    "value",
    "coverage",
    "confidence",
    "scope",
  ], "history");
  if (value.metric_id !== "git.change_frequency") fail("history.metric_id must be git.change_frequency");
  if (value.definition_id !== "sei.git.change_frequency@1") {
    fail("history.definition_id must be sei.git.change_frequency@1");
  }
  if (!HISTORY_STATES.has(value.state)) fail("history.state is unsupported");
  if (!HISTORY_SCOPES.has(value.scope)) fail("history.scope is unsupported");
  assertFraction(value.coverage, "history.coverage");
  assertFraction(value.confidence, "history.confidence");
  if (OBSERVED_HISTORY_STATES.has(value.state)) {
    if (!Number.isSafeInteger(value.value) || value.value < 1) {
      fail("observed history.value must be a positive safe revision count");
    }
    if (value.coverage === 0 || value.confidence === 0) {
      fail("observed history requires positive coverage and confidence");
    }
  } else if (value.value !== null) {
    fail("non-observed history.value must be null");
  }
  return {
    metric_id: value.metric_id,
    definition_id: value.definition_id,
    state: value.state,
    observed_revision_count: value.value,
    coverage: value.coverage,
    confidence: value.confidence,
    scope: value.scope,
  };
}

function validateComparison(value, index) {
  const label = `comparisons[${index}]`;
  assertClosed(value, [
    "metric_id",
    "baseline_snapshot_id",
    "baseline_repository_revision",
    "binding_kind",
  ], label);
  assertStableId(value.metric_id, `${label}.metric_id`);
  assertSnapshotId(value.baseline_snapshot_id, `${label}.baseline_snapshot_id`);
  assertRevision(value.baseline_repository_revision, `${label}.baseline_repository_revision`);
  if (!BASELINE_BINDING_KINDS.has(value.binding_kind)) fail(`${label}.binding_kind is unsupported`);
  return {
    metric_id: value.metric_id,
    baseline_snapshot_id: value.baseline_snapshot_id,
    baseline_repository_revision: value.baseline_repository_revision,
    binding_kind: value.binding_kind,
  };
}

function validateComparisons(values, baseline) {
  if (!Array.isArray(values) || values.length > MAX_COMPARISONS) {
    fail(`comparisons must contain at most ${MAX_COMPARISONS} entries`);
  }
  const comparisons = values.map(validateComparison);
  const metricIds = comparisons.map((comparison) => comparison.metric_id);
  if (new Set(metricIds).size !== metricIds.length) fail("comparisons must use unique metric IDs");
  comparisons.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  if (baseline === null) {
    if (comparisons.length !== 0) fail("comparisons require validated baseline metadata");
    return comparisons;
  }
  if (comparisons.length !== baseline.compatible_metric_count) {
    fail("comparison binding count must equal baseline compatible metric count");
  }
  for (const comparison of comparisons) {
    if (comparison.binding_kind !== baseline.binding_kind
        || comparison.baseline_snapshot_id !== baseline.baseline_snapshot_id
        || comparison.baseline_repository_revision !== baseline.baseline_repository_revision) {
      fail(`comparison ${comparison.metric_id} does not match the declared baseline binding`);
    }
  }
  return comparisons;
}

function validateInput(input) {
  assertClosed(input, ["current_snapshot", "baseline", "history", "comparisons"], "input");
  const currentSnapshot = validateCurrentSnapshot(input.current_snapshot);
  const baseline = validateBaseline(input.baseline);
  const history = validateHistory(input.history);
  const comparisons = validateComparisons(input.comparisons, baseline);
  return { currentSnapshot, baseline, history, comparisons };
}

function historyHasObservedRevisions(history) {
  return history !== null && OBSERVED_HISTORY_STATES.has(history.state)
    && Number.isSafeInteger(history.observed_revision_count) && history.observed_revision_count >= 1;
}

function result({ currentSnapshot, baseline, history, comparisons, state, compatibility, summary, limitation, nextObservation }) {
  return deepFreeze({
    trend_status_version: TREND_STATUS_VERSION,
    state,
    compatibility,
    current_snapshot: currentSnapshot,
    baseline,
    history,
    comparison_binding_count: comparisons.length,
    summary,
    limitation,
    next_observation: nextObservation,
  });
}

function deriveTrendStatus(input) {
  const { currentSnapshot, baseline, history, comparisons } = validateInput(input);
  if (baseline === null) {
    return result({
      currentSnapshot,
      baseline,
      history,
      comparisons,
      state: "unresolved",
      compatibility: "unresolved",
      summary: "No validated trend-baseline metadata was supplied for this snapshot.",
      limitation: "The available input cannot establish whether a prior SEI baseline exists or is compatible.",
      nextObservation: "Supply validated trend-baseline metadata and any bound metric comparisons for this snapshot.",
    });
  }

  if (baseline.status === "established") {
    if (!baseline.eligible) {
      return result({
        currentSnapshot,
        baseline,
        history,
        comparisons,
        state: "unresolved",
        compatibility: "unresolved",
        summary: "SEI recorded an automatic baseline state, but this snapshot has no eligible current metric bindings.",
        limitation: "Without eligible current metric bindings, the available input cannot establish a factual trend comparison.",
        nextObservation: "Collect compatible current measurements before treating this snapshot as a trend baseline.",
      });
    }
    if (historyHasObservedRevisions(history) && history.scope === "full-repository" && history.observed_revision_count === 1
        && history.coverage === 1 && history.confidence === 1) {
      return result({
        currentSnapshot,
        baseline,
        history,
        comparisons,
        state: "repository-history-insufficient",
        compatibility: "not-yet-comparable",
        summary: "The supplied full-repository history proof contains one observed revision, so no prior repository revision is available for a trend comparison.",
        limitation: "This conclusion depends on the supplied full-repository history scope and does not assign a directional conclusion.",
        nextObservation: "Run SEI after a later repository revision with compatible evidence to obtain factual deltas.",
      });
    }
    if (historyHasObservedRevisions(history) && history.observed_revision_count > 1) {
      return result({
        currentSnapshot,
        baseline,
        history,
        comparisons,
        state: "first-compatible-sei-observation-with-observed-history",
        compatibility: "not-yet-comparable",
        summary: `No compatible prior SEI baseline was selected for this run. SEI established this snapshot for a later compatible comparison; the ${history.scope} reports ${history.observed_revision_count} observed revisions.`,
        limitation: "This does not claim that the repository is new, and it does not assign a directional conclusion.",
        nextObservation: "Run SEI later with compatible repository and configuration bindings to obtain factual deltas.",
      });
    }
    const historyLimitation = history !== null && history.scope === "configured-window"
      ? "The configured history window does not prove whether the repository has earlier history."
      : "No structured repository-history proof was supplied for this status.";
    return result({
      currentSnapshot,
      baseline,
      history,
      comparisons,
      state: "first-compatible-sei-observation",
      compatibility: "not-yet-comparable",
      summary: "No compatible prior SEI baseline was selected for this run. SEI established this snapshot for a later compatible comparison.",
      limitation: `${historyLimitation} No directional conclusion is assigned.`,
      nextObservation: "Run SEI later with compatible repository and configuration bindings to obtain factual deltas.",
    });
  }

  if (baseline.compatible_metric_count > 0) {
    return result({
      currentSnapshot,
      baseline,
      history,
      comparisons,
      state: "prior-compatible-baseline-selected",
      compatibility: "compatible",
      summary: `A compatible ${baseline.binding_kind} prior SEI baseline is bound to this snapshot across ${comparisons.length} metric bindings.`,
      limitation: "This status describes compatibility and binding only; it makes no directional conclusion.",
      nextObservation: "Inspect the bound factual metric deltas with their units, coverage, and confidence.",
    });
  }

  return result({
    currentSnapshot,
    baseline,
    history,
    comparisons,
    state: "prior-baseline-incompatible",
    compatibility: "incompatible",
    summary: "A prior SEI baseline was supplied, but no current metric bindings satisfy the recorded compatibility requirements.",
    limitation: "No factual trend comparison is available from this prior baseline.",
    nextObservation: "Use a baseline with matching repository, analyzer, and configuration bindings before comparing metric values.",
  });
}

module.exports = {
  TREND_STATUS_VERSION,
  deriveTrendStatus,
};
