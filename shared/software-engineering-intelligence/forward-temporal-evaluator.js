"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateSnapshot } = require("./intelligence-engine.js");
const intelligenceEngine = require("./intelligence-engine.js");
const incrementalState = require("./incremental-run-state.js");
const predictivePromotion = require("./predictive-promotion.js");

const intelligenceEnginePrivate = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")];
const statePrivate = incrementalState[Symbol.for("sei.incremental-run-state.private.v2")];
const promotionPrivate = predictivePromotion[Symbol.for("sei.predictive-promotion.private.v1")];
const INPUT_SCHEMA_VERSION = "sei.forward-temporal-evaluation-input@1";
const V3_INPUT_SCHEMA_VERSION = "sei.forward-temporal-evaluation-input@2";
const RECEIPT_SCHEMA_VERSION = "sei.forward-temporal-evaluation@2";
const AUTO_RECEIPT_SCHEMA_VERSION = "sei.forward-temporal-evaluation@3";
const BUNDLE_SCHEMA_VERSION = "sei.forward-temporal-bundle@1";
const MIN_SNAPSHOTS = 3;
const MIN_OBSERVATIONS = 4;
const MIN_ESTABLISHED_FOLDS = 2;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const INPUT_KEYS = Object.freeze(["history_stage", "ranking_k", "schema_version", "snapshots"]);
const V3_INPUT_KEYS = Object.freeze(["history_stage", "horizons", "ranking_k", "schema_version"]);
const V3_HORIZON_KEYS = Object.freeze(["horizon_commits", "snapshots"]);
const BUNDLE_KEYS = Object.freeze(["cutoff_snapshots", "history_stage", "kind", "receipt", "schema_version"]);
const ARTIFACT_REF_KEYS = Object.freeze(["path", "sha256", "size_bytes"]);
const MAX_BUNDLE_BYTES = 256 * 1024;
const MAX_HISTORY_STAGE_BYTES = 64 * 1024 * 1024;
const MAX_CUTOFF_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_CUTOFF_SNAPSHOT_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_CUTOFF_SNAPSHOT_COUNT = 16;
const MAX_V3_CUTOFF_SNAPSHOT_COUNT = 256;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SNAPSHOT_ID = /^sei-v[1-9][0-9]*-[a-f0-9]{64}$/;
const V3_KIND = "forward-temporal-terminal-holdout-promotion-receipt";
const V3_SCORE_KIND = "deterministic-rank-only";
const V3_LIMITATIONS = Object.freeze([
  "each eligible-commit horizon is evaluated independently",
  "three development folds nominate before one untouched terminal holdout is read",
  "current forecasts contain rank and percentile only",
]);
const forwardTemporalBundleState = new WeakMap();
const verifiedV3Receipts = new WeakSet();
const COMPLEXITY_DEFINITIONS = Object.freeze([
  "sei.static.cyclomatic_complexity@1",
  "sei.static.lexical_max_nesting_depth@1",
]);
const FEATURE_SPECS = Object.freeze([
  Object.freeze({ key: "loc", definition_id: "sei.static.source_lines@1" }),
  Object.freeze({ key: "change_frequency", definition_id: "sei.git.change_frequency@1" }),
  Object.freeze({ key: "churn", definition_id: "sei.git.churn@1" }),
]);
const METHODS = Object.freeze([
  Object.freeze({ method_id: "sei-four-signal-composite-v1", feature_keys: Object.freeze(["loc", "change_frequency", "churn", "complexity"]), method_kind: "sei-heuristic" }),
  Object.freeze({ method_id: "baseline-loc-v1", feature_keys: Object.freeze(["loc"]), method_kind: "simple-baseline" }),
  Object.freeze({ method_id: "baseline-change-frequency-v1", feature_keys: Object.freeze(["change_frequency"]), method_kind: "simple-baseline" }),
  Object.freeze({ method_id: "baseline-churn-v1", feature_keys: Object.freeze(["churn"]), method_kind: "simple-baseline" }),
  Object.freeze({ method_id: "baseline-complexity-v1", feature_keys: Object.freeze(["complexity"]), method_kind: "simple-baseline" }),
]);
const EVALUATED_OUTCOMES = Object.freeze([
  "future-modification",
  "repeated-modification",
  "high-churn",
]);

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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function bundleFail(detail) {
  fail("FAIL-FORWARD-TEMPORAL-BUNDLE", detail);
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalPrettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireRelativeBundlePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
      || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    bundleFail(`${label}.path must be a non-empty relative non-NUL path`);
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    bundleFail(`${label}.path must not contain empty, dot, or parent path segments`);
  }
  return value;
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readRegularBundleFile(filePath, label, maximumBytes, bundleRoot = null) {
  let stats;
  try {
    stats = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    bundleFail(`${label} is not readable (${error.code ?? error.message})`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0n || stats.size > BigInt(maximumBytes)) {
    bundleFail(`${label} must be a bounded non-empty regular non-symlink file`);
  }
  let realPath;
  try {
    realPath = fs.realpathSync.native(filePath);
  } catch (error) {
    bundleFail(`${label} cannot be resolved (${error.code ?? error.message})`);
  }
  if (bundleRoot !== null && !isContainedPath(bundleRoot, realPath)) {
    bundleFail(`${label} resolved outside the bundle directory`);
  }
  let bytes;
  try {
    bytes = fs.readFileSync(realPath);
  } catch (error) {
    bundleFail(`${label} cannot be read (${error.code ?? error.message})`);
  }
  if (bytes.length !== Number(stats.size)) bundleFail(`${label} changed while it was being read`);
  return Object.freeze({
    bytes,
    real_path: realPath,
    identity: `${stats.dev}:${stats.ino}`,
  });
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    bundleFail(`${label} is not valid JSON (${error.message})`);
  }
}

function normalizeBundleArtifactReference(value, label, maximumBytes) {
  if (!exactKeys(value, ARTIFACT_REF_KEYS)) {
    bundleFail(`${label} must contain only path, sha256, and size_bytes`);
  }
  const artifactPath = requireRelativeBundlePath(value.path, label);
  if (!SHA256.test(value.sha256)
      || !Number.isSafeInteger(value.size_bytes)
      || value.size_bytes <= 0
      || value.size_bytes > maximumBytes) {
    bundleFail(`${label} has an invalid bounded artifact reference`);
  }
  return Object.freeze({ path: artifactPath, sha256: value.sha256, size_bytes: value.size_bytes });
}

function readBundleArtifact(bundleRoot, bundleRealPath, reference, label, maximumBytes, seenPaths, seenIdentities) {
  const candidate = path.resolve(bundleRoot, reference.path);
  if (!isContainedPath(bundleRoot, candidate)) bundleFail(`${label}.path escaped the bundle directory`);
  const normalizedPath = canonicalPath(candidate);
  if (seenPaths.has(normalizedPath)) bundleFail(`${label}.path duplicates another bundle artifact path`);
  const artifact = readRegularBundleFile(candidate, label, maximumBytes, bundleRoot);
  if (canonicalPath(artifact.real_path) === canonicalPath(bundleRealPath)) {
    bundleFail(`${label} must not alias the bundle manifest`);
  }
  if (seenIdentities.has(artifact.identity)) bundleFail(`${label} aliases another bundle artifact`);
  if (artifact.bytes.length !== reference.size_bytes || sha256Bytes(artifact.bytes) !== reference.sha256) {
    bundleFail(`${label} bytes do not match its declared size and digest`);
  }
  seenPaths.add(normalizedPath);
  seenIdentities.add(artifact.identity);
  return artifact;
}

function assertClosed(value, allowedKeys, label) {
  if (!isRecord(value)) fail("FAIL-FORWARD-TEMPORAL-CONTRACT", `${label} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      if (new Set(["label", "labels", "outcome", "outcomes"]).has(key)) {
        fail("FAIL-FORWARD-TEMPORAL-CALLER-LABEL", "caller-authored outcome labels are forbidden; outcomes are derived only from the branded history stage");
      }
      fail("FAIL-FORWARD-TEMPORAL-CONTRACT", `${label}.${key} is not declared`);
    }
  }
}

function canonicalFilePath(subject) {
  if (typeof subject !== "string" || !subject.startsWith("file:")) return null;
  const value = subject.slice(5).trim().replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value) || value.includes("\0")) return null;
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  return parts.length > 0 && !parts.includes("..") ? parts.join("/") : null;
}

function metricCollector(snapshot, metric) {
  return snapshot.collectors.find((collector) => collector.collector_id === metric?.source?.collector_id) ?? null;
}

function usableMetric(snapshot, metric, definitionId) {
  const filePath = canonicalFilePath(metric?.subject);
  const collector = metricCollector(snapshot, metric);
  return metric?.definition_id === definitionId
    && filePath !== null
    && typeof metric.value === "number"
    && Number.isFinite(metric.value)
    && metric.value >= 0
    && metric.measurement?.status === "measured"
    && metric.repository_revision === snapshot.repository.revision
    && metric.source?.repository_revision === snapshot.repository.revision
    && metric.window?.end === snapshot.repository.revision
    && metric.scope?.kind === "file"
    && metric.scope.path === filePath
    && metric.scope.generated_code === false
    && metric.scope.included_in_human_maintainability === true
    && metric.comparability?.configuration_hash === snapshot.repository.configuration_hash
    && Array.isArray(metric.source?.artifact_refs)
    && metric.source.artifact_refs.length > 0
    && Array.isArray(metric.source?.evidence_refs)
    && metric.source.evidence_refs.length > 0
    && collector?.status === "available"
    && collector.collector_version === metric.source.collector_version
    && collector.analyzer_identity === metric.analyzer_identity
    && collector.analyzer_version === metric.analyzer_version;
}

function featureBinding(metric) {
  return stableStringify({
    definition_id: metric.definition_id,
    collector_id: metric.source.collector_id,
    collector_version: metric.source.collector_version,
    analyzer_identity: metric.analyzer_identity,
    analyzer_version: metric.analyzer_version,
    unit: metric.unit,
    window_kind: metric.window.kind,
    window_start: metric.window.start,
    configuration_hash: metric.comparability.configuration_hash,
  });
}

function metricsBySubject(snapshot, definitionId) {
  const bySubject = new Map();
  for (const metric of snapshot.measurements) {
    if (metric?.definition_id !== definitionId) continue;
    if (!usableMetric(snapshot, metric, definitionId)) continue;
    if (bySubject.has(metric.subject)) {
      fail("FAIL-FORWARD-TEMPORAL-EVIDENCE", `${snapshot.snapshot_id}/${metric.subject} has duplicate ${definitionId} evidence`);
    }
    bySubject.set(metric.subject, metric);
  }
  return bySubject;
}

function observationsForSnapshot(snapshot, complexityDefinition) {
  const specifications = [...FEATURE_SPECS, { key: "complexity", definition_id: complexityDefinition }];
  const maps = Object.fromEntries(specifications.map((spec) => [spec.key, metricsBySubject(snapshot, spec.definition_id)]));
  const subjects = [...maps.loc.keys()].filter((subject) => specifications.every((spec) => maps[spec.key].has(subject)));
  return subjects.sort(stableCompare).map((subject) => ({
    observation_id: `${snapshot.snapshot_id}::${subject}`,
    snapshot_id: snapshot.snapshot_id,
    repository_revision: snapshot.repository.revision,
    subject,
    path: canonicalFilePath(subject),
    features: Object.fromEntries(specifications.map((spec) => [spec.key, maps[spec.key].get(subject).value])),
    feature_bindings: Object.fromEntries(specifications.map((spec) => [spec.key, featureBinding(maps[spec.key].get(subject))])),
  }));
}

function selectComplexityDefinition(snapshots) {
  for (const definition of COMPLEXITY_DEFINITIONS) {
    if (snapshots.every((snapshot) => observationsForSnapshot(snapshot, definition).length >= MIN_OBSERVATIONS)) {
      return definition;
    }
  }
  fail("FAIL-FORWARD-TEMPORAL-INSUFFICIENT", `every cutoff needs at least ${MIN_OBSERVATIONS} complete LOC, change-frequency, churn, and consistent complexity observations`);
}

function assertFeatureCompatibility(observationsBySnapshot) {
  const expected = new Map();
  for (const observations of observationsBySnapshot.values()) {
    for (const observation of observations) {
      for (const [feature, binding] of Object.entries(observation.feature_bindings)) {
        if (!expected.has(feature)) expected.set(feature, binding);
        else if (expected.get(feature) !== binding) {
          fail("FAIL-FORWARD-TEMPORAL-INCOMPATIBLE", `${feature} evidence bindings differ across cutoff snapshots`);
        }
      }
    }
  }
}

function normalizeHistoryStage(historyStage) {
  let history;
  try {
    history = statePrivate.readStage(historyStage, "history");
  } catch (error) {
    fail("FAIL-FORWARD-TEMPORAL-EVIDENCE", `history_stage is not a package-branded revision-bound history stage (${error.message})`);
  }
  if (!SHA256.test(history.artifact_sha256) || history.commits.length === 0) {
    fail("FAIL-FORWARD-TEMPORAL-EVIDENCE", "history stage is empty or lacks its immutable digest");
  }
  for (let index = 1; index < history.commits.length; index += 1) {
    const previous = Date.parse(history.commits[index - 1].timestamp);
    const current = Date.parse(history.commits[index].timestamp);
    if (!(previous < current)) {
      fail("FAIL-FORWARD-TEMPORAL-LEAKAGE", "history commit timestamps must be strictly increasing; tied or regressing time cannot establish a forward fold");
    }
  }
  if (history.commits.at(-1).revision !== history.binding.history_end) {
    fail("FAIL-FORWARD-TEMPORAL-EVIDENCE", "history binding end is not the final strictly ordered commit fact");
  }
  return history;
}

function normalizeSnapshots(values, history, minimumSnapshots = MIN_SNAPSHOTS, requireHistoryEnd = true) {
  if (!Array.isArray(values) || values.length < minimumSnapshots) {
    const detail = minimumSnapshots === MIN_SNAPSHOTS
      ? `at least ${MIN_SNAPSHOTS} canonical cutoff snapshots are required for one training interval and one forward holdout`
      : `at least ${minimumSnapshots} canonical cutoff snapshot is required to bind predictive readiness`;
    fail("FAIL-FORWARD-TEMPORAL-INSUFFICIENT", detail);
  }
  const commitIndex = new Map(history.commits.map((commit, index) => [commit.revision, index]));
  const seenSnapshots = new Set();
  const seenRevisions = new Set();
  const snapshots = values.map((snapshot, index) => {
    const validation = validateSnapshot(snapshot);
    if (!validation.ok) {
      fail("FAIL-FORWARD-TEMPORAL-EVIDENCE", `snapshots[${index}] is not canonical (${validation.errors.join("; ")})`);
    }
    if (seenSnapshots.has(snapshot.snapshot_id) || seenRevisions.has(snapshot.repository.revision)) {
      fail("FAIL-FORWARD-TEMPORAL-EVIDENCE", "cutoff snapshot IDs and revisions must be unique");
    }
    if (!commitIndex.has(snapshot.repository.revision)) {
      fail("FAIL-FORWARD-TEMPORAL-EVIDENCE", `snapshot revision ${snapshot.repository.revision} is absent from the branded history facts`);
    }
    seenSnapshots.add(snapshot.snapshot_id);
    seenRevisions.add(snapshot.repository.revision);
    return snapshot;
  }).sort((left, right) => commitIndex.get(left.repository.revision) - commitIndex.get(right.repository.revision));
  const first = snapshots[0];
  for (const snapshot of snapshots) {
    if (snapshot.repository.repository_id !== history.binding.repository_id
        || snapshot.repository.configuration_hash !== history.binding.configuration_hash
        || snapshot.repository.repository_id !== first.repository.repository_id
        || snapshot.repository.configuration_hash !== first.repository.configuration_hash) {
      fail("FAIL-FORWARD-TEMPORAL-INCOMPATIBLE", "snapshot and history repository/configuration bindings differ");
    }
    const gitCollector = snapshot.collectors.find((collector) => collector.collector_id === "git-history");
    if (gitCollector?.status !== "available"
        || gitCollector.collector_version !== history.binding.collector_version
        || gitCollector.analyzer_identity !== history.binding.analyzer_identity
        || gitCollector.analyzer_version !== history.binding.analyzer_version) {
      fail("FAIL-FORWARD-TEMPORAL-INCOMPATIBLE", "snapshot Git collector does not match the branded history analyzer binding");
    }
  }
  if (requireHistoryEnd && snapshots.at(-1).repository.revision !== history.binding.history_end) {
    fail("FAIL-FORWARD-TEMPORAL-LEAKAGE", "the final cutoff snapshot must bind the history end so no undeclared future suffix exists");
  }
  return { snapshots, commitIndex };
}

function outcomeStats(observations, commits) {
  const stats = new Map(observations.map((observation) => [observation.subject, {
    subject: observation.subject,
    touch_count: 0,
    text_churn: 0,
    observed_revisions: [],
  }]));
  const subjectByPath = new Map(observations.map((observation) => [observation.path, observation.subject]));
  for (const commit of commits) {
    for (const file of commit.files) {
      let subject = subjectByPath.get(file.path) ?? null;
      if (file.change_kind === "rename" && file.previous_path !== undefined) {
        const renamedSubject = subjectByPath.get(file.previous_path) ?? null;
        if (renamedSubject !== null) {
          subject = renamedSubject;
          subjectByPath.delete(file.previous_path);
          subjectByPath.set(file.path, renamedSubject);
        }
      }
      if (subject === null) continue;
      if (file.binary_change) {
        fail("FAIL-FORWARD-TEMPORAL-OUTCOME", `${subject} has binary future churn, so the mandatory high-churn outcome is not mechanically complete`);
      }
      const record = stats.get(subject);
      record.touch_count += 1;
      record.text_churn += file.added + file.deleted;
      record.observed_revisions.push(commit.revision);
      if (file.change_kind === "delete") subjectByPath.delete(file.path);
    }
  }
  return stats;
}

function buildIntervals(snapshots, commitIndex, history, observationsBySnapshot) {
  return snapshots.slice(0, -1).map((snapshot, index) => {
    const next = snapshots[index + 1];
    const cutoffIndex = commitIndex.get(snapshot.repository.revision);
    const nextIndex = commitIndex.get(next.repository.revision);
    if (nextIndex - cutoffIndex < 2) {
      fail("FAIL-FORWARD-TEMPORAL-INSUFFICIENT", `cutoff ${snapshot.repository.revision} has no strictly-before-next-cutoff outcome commit`);
    }
    const outcomeCommits = history.commits.slice(cutoffIndex + 1, nextIndex);
    const observations = observationsBySnapshot.get(snapshot.snapshot_id);
    if (observations.length < MIN_OBSERVATIONS) {
      fail("FAIL-FORWARD-TEMPORAL-INSUFFICIENT", `cutoff ${snapshot.repository.revision} has fewer than ${MIN_OBSERVATIONS} complete observations`);
    }
    return {
      interval_id: `interval-${index + 1}`,
      snapshot,
      observations,
      cutoff_index: cutoffIndex,
      cutoff_commit: history.commits[cutoffIndex],
      next_cutoff_index: nextIndex,
      outcome_commits: outcomeCommits,
      outcomes: outcomeStats(observations, outcomeCommits),
      outcome_end: outcomeCommits.at(-1),
      next_snapshot: next,
    };
  });
}

function normalizers(trainingIntervals) {
  const records = trainingIntervals.flatMap((interval) => interval.observations);
  return Object.fromEntries(["loc", "change_frequency", "churn", "complexity"].map((feature) => {
    const values = records.map((record) => record.features[feature]);
    return [feature, { min: Math.min(...values), max: Math.max(...values) }];
  }));
}

function normalizedRankScore(value, range) {
  if (range.min === range.max) return 0.5;
  return Math.max(0, Math.min(1, (value - range.min) / (range.max - range.min)));
}

function methodScore(observation, method, ranges) {
  return method.feature_keys.reduce((sum, feature) => (
    sum + normalizedRankScore(observation.features[feature], ranges[feature])
  ), 0) / method.feature_keys.length;
}

function upperQuartile(values) {
  const ordered = values.slice().sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.75))];
}

function observedOutcome(outcomeId, stats, highChurnThreshold) {
  if (outcomeId === "future-modification") return stats.touch_count >= 1;
  if (outcomeId === "repeated-modification") return stats.touch_count >= 2;
  return stats.text_churn > 0 && stats.text_churn >= highChurnThreshold;
}

function classCounts(intervals, outcomeId, highChurnThreshold) {
  const values = intervals.flatMap((interval) => interval.observations.map((observation) => (
    observedOutcome(outcomeId, interval.outcomes.get(observation.subject), highChurnThreshold)
  )));
  const positive = values.filter(Boolean).length;
  return { observations: values.length, positive, negative: values.length - positive };
}

function assertUsableClasses(trainingIntervals, holdoutInterval, outcomeId, highChurnThreshold) {
  const training = classCounts(trainingIntervals, outcomeId, highChurnThreshold);
  const holdout = classCounts([holdoutInterval], outcomeId, highChurnThreshold);
  const hasTrainingClasses = training.positive > 0 && training.negative > 0;
  const hasHoldoutClasses = holdout.positive > 0 && holdout.negative > 0;
  return {
    training,
    holdout,
    status: hasTrainingClasses && hasHoldoutClasses ? "evaluated" : "not_established",
    reason: hasTrainingClasses && hasHoldoutClasses
      ? null
      : `${outcomeId} needs both mechanically observed classes in the prior training horizon and forward holdout`,
  };
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

function compareMetric(value, reference) {
  if (value === null || reference === null) return { result: "unavailable", delta: null };
  if (value === reference) return { result: "equal", delta: 0 };
  return { result: value > reference ? "better" : "worse", delta: value - reference };
}

function rankingsForOutcome(
  interval,
  outcomeId,
  highChurnThreshold,
  ranges,
  rankingK,
  targetSpecificFacts = false,
) {
  const raw = METHODS.map((method) => {
    const ranking = interval.observations.map((observation) => {
      const stats = interval.outcomes.get(observation.subject);
      return {
        subject: observation.subject,
        rank_score: methodScore(observation, method, ranges),
        observed_outcome: observedOutcome(outcomeId, stats, highChurnThreshold),
        ...(!targetSpecificFacts || outcomeId !== "high-churn"
          ? { future_touch_count: stats.touch_count }
          : {}),
        ...(!targetSpecificFacts || outcomeId === "high-churn"
          ? { future_text_churn: stats.text_churn }
          : {}),
      };
    }).sort((left, right) => right.rank_score - left.rank_score || stableCompare(left.subject, right.subject))
      .map((entry, index) => ({ rank: index + 1, ...entry }));
    return {
      method_id: method.method_id,
      method_kind: method.method_kind,
      score_interpretation: "training-range-normalized ranking score",
      ranking_k: rankingK,
      ...rankingMetrics(ranking, rankingK),
      ranking,
    };
  });
  const sei = raw.find((entry) => entry.method_id === "sei-four-signal-composite-v1");
  const comparisonFields = [
    "precision_at_k",
    "recall_at_k",
    "lift_at_k",
    "average_precision",
    "spearman_rank_correlation",
  ];
  return raw.map((entry) => {
    const comparisons = Object.fromEntries(comparisonFields.map((field) => [
      field,
      entry.method_id === sei.method_id
        ? { result: entry[field] === null ? "unavailable" : "reference", delta: entry[field] === null ? null : 0 }
        : compareMetric(entry[field], sei[field]),
    ]));
    return {
      ...entry,
      comparisons_to_sei: comparisons,
      comparison_to_sei: { metric: "average_precision", ...comparisons.average_precision },
    };
  });
}

function foldReceipt(
  intervals,
  holdoutIndex,
  rankingK,
  outcomeIds = EVALUATED_OUTCOMES,
  targetSpecificFacts = false,
) {
  const trainingIntervals = intervals.slice(0, holdoutIndex);
  const holdout = intervals[holdoutIndex];
  const ranges = normalizers(trainingIntervals);
  const trainingChurn = trainingIntervals.flatMap((interval) => (
    interval.observations.map((observation) => interval.outcomes.get(observation.subject).text_churn)
  ));
  const highChurnThreshold = upperQuartile(trainingChurn);
  const outcomes = outcomeIds.map((outcomeId) => {
    const classes = assertUsableClasses(trainingIntervals, holdout, outcomeId, highChurnThreshold);
    return {
      outcome_id: outcomeId,
      status: classes.status,
      reason: classes.reason,
      training_classes: classes.training,
      holdout_classes: classes.holdout,
      ...(outcomeId === "high-churn" ? {
        threshold: {
          value: highChurnThreshold,
          unit: "lines-changed",
          derivation: "upper-quartile-boundary-of-prior-training-outcome-churn-only",
        },
      } : {}),
      rankings: rankingsForOutcome(
        holdout,
        outcomeId,
        highChurnThreshold,
        ranges,
        rankingK,
        targetSpecificFacts,
      ),
    };
  });
  const trainingEnd = trainingIntervals.at(-1).outcome_end;
  const trainingEndIndex = holdout.cutoff_index - 1;
  const trainingEndsBeforeHoldout = trainingEndIndex < holdout.cutoff_index
    && Date.parse(trainingEnd.timestamp) < Date.parse(holdout.cutoff_commit.timestamp);
  if (!trainingEndsBeforeHoldout) {
    fail("FAIL-FORWARD-TEMPORAL-LEAKAGE", `forward-fold-${holdoutIndex} training horizon does not end before its holdout cutoff`);
  }
  return {
    fold_id: `forward-fold-${holdoutIndex}`,
    training: {
      interval_ids: trainingIntervals.map((interval) => interval.interval_id),
      cutoff_revisions: trainingIntervals.map((interval) => interval.snapshot.repository.revision),
      outcome_revisions: trainingIntervals.flatMap((interval) => (
        interval.outcome_commits.map((commit) => commit.revision)
      )),
      outcome_end_revision: trainingEnd.revision,
      outcome_end_timestamp: trainingEnd.timestamp,
      observation_count: trainingIntervals.reduce((sum, interval) => sum + interval.observations.length, 0),
      feature_normalizers: ranges,
    },
    holdout: {
      interval_id: holdout.interval_id,
      snapshot_id: holdout.snapshot.snapshot_id,
      cutoff_revision: holdout.snapshot.repository.revision,
      cutoff_timestamp: holdout.cutoff_commit.timestamp,
      outcome_start_exclusive_revision: holdout.snapshot.repository.revision,
      outcome_revisions: holdout.outcome_commits.map((commit) => commit.revision),
      outcome_end_revision: holdout.outcome_end.revision,
      outcome_end_timestamp: holdout.outcome_end.timestamp,
      next_cutoff_exclusive_revision: holdout.next_snapshot.repository.revision,
      observation_count: holdout.observations.length,
    },
    leakage_check: {
      training_ends_before_holdout: true,
      training_end_commit_index: trainingEndIndex,
      holdout_cutoff_commit_index: holdout.cutoff_index,
      holdout_outcome_excludes_cutoff_commit: true,
      holdout_outcome_excludes_next_cutoff_commit: true,
    },
    outcomes,
  };
}

function aggregateEvaluation(folds) {
  return EVALUATED_OUTCOMES.map((outcomeId) => {
    const foldOutcomes = folds.map((fold) => ({
      fold_id: fold.fold_id,
      outcome: fold.outcomes.find((outcome) => outcome.outcome_id === outcomeId),
    }));
    const evaluatedFoldOutcomes = foldOutcomes.filter(({ outcome }) => outcome.status === "evaluated");
    const established = evaluatedFoldOutcomes.length >= MIN_ESTABLISHED_FOLDS;
    const metricFields = [
      ["mean_precision_at_k", "precision_at_k"],
      ["mean_recall_at_k", "recall_at_k"],
      ["mean_lift_at_k", "lift_at_k"],
      ["mean_average_precision", "average_precision"],
      ["mean_spearman_rank_correlation", "spearman_rank_correlation"],
    ];
    const commonEligibleFoldIds = Object.fromEntries(metricFields.map(([aggregateField, foldField]) => [
      aggregateField,
      evaluatedFoldOutcomes.filter(({ outcome }) => METHODS.every((method) => (
        outcome.rankings.find((entry) => entry.method_id === method.method_id)
          .metric_availability[foldField] === "available"
      ))).map(({ fold_id: foldId }) => foldId),
    ]));
    const methods = METHODS.map((method) => {
      const records = evaluatedFoldOutcomes.map(({ fold_id: foldId, outcome }) => ({
        fold_id: foldId,
        ranking: outcome.rankings.find((entry) => entry.method_id === method.method_id),
      }));
      const mean = (aggregateField, foldField) => {
        const eligibleFoldIds = new Set(commonEligibleFoldIds[aggregateField]);
        const available = records.filter(({ fold_id: foldId }) => eligibleFoldIds.has(foldId));
        return established && available.length >= MIN_ESTABLISHED_FOLDS
          ? available.reduce((sum, { ranking }) => sum + ranking[foldField], 0) / available.length
          : null;
      };
      const availability = (aggregateField) => (
        established && commonEligibleFoldIds[aggregateField].length >= MIN_ESTABLISHED_FOLDS
          ? "available"
          : "insufficient_folds"
      );
      const metricCoverage = Object.fromEntries(metricFields.map(([aggregateField]) => [
        aggregateField,
        {
          contributing_fold_count: availability(aggregateField) === "available"
            ? commonEligibleFoldIds[aggregateField].length
            : 0,
          contributing_fold_ids: availability(aggregateField) === "available"
            ? commonEligibleFoldIds[aggregateField].slice()
            : [],
        },
      ]));
      const aggregateValues = Object.fromEntries(metricFields.map(([aggregateField, foldField]) => [
        aggregateField,
        mean(aggregateField, foldField),
      ]));
      const metricAvailability = Object.fromEntries(metricFields.map(([aggregateField]) => [
        aggregateField,
        availability(aggregateField),
      ]));
      const reciprocalRankRecords = records.map(({ ranking }) => ranking);
      return {
        method_id: method.method_id,
        method_kind: method.method_kind,
        fold_count: foldOutcomes.length,
        evaluated_fold_count: records.length,
        ...aggregateValues,
        mean_reciprocal_rank: established
          ? reciprocalRankRecords.reduce((sum, record) => sum + record.reciprocal_rank, 0) / reciprocalRankRecords.length
          : null,
        metric_availability: metricAvailability,
        metric_coverage: metricCoverage,
      };
    });
    const sei = methods.find((method) => method.method_id === "sei-four-signal-composite-v1");
    const comparisonFields = metricFields.map(([aggregateField]) => aggregateField);
    return {
      outcome_id: outcomeId,
      status: established ? "evaluated" : "not_established",
      reason: established
        ? null
        : `at least ${MIN_ESTABLISHED_FOLDS} forward folds with both mechanically observed classes are required`,
      fold_count: foldOutcomes.length,
      evaluated_fold_count: evaluatedFoldOutcomes.length,
      methods: methods.map((method) => {
        const comparisons = Object.fromEntries(comparisonFields.map((field) => [
          field,
          method.method_id === sei.method_id
            ? {
                result: method[field] === null ? "unavailable" : "reference",
                delta: method[field] === null ? null : 0,
                ...method.metric_coverage[field],
              }
            : { ...compareMetric(method[field], sei[field]), ...method.metric_coverage[field] },
        ]));
        return {
          ...method,
          comparisons_to_sei: comparisons,
          comparison_to_sei: { metric: "mean_average_precision", ...comparisons.mean_average_precision },
        };
      }),
    };
  });
}

function outcomeDefinitions(complexityDefinition) {
  return [
    {
      outcome_id: "future-modification",
      status: "evaluated",
      rule: "one-or-more-observed-file-touches-after-the-cutoff-and-before-the-next-cutoff",
    },
    {
      outcome_id: "repeated-modification",
      status: "evaluated",
      rule: "two-or-more-observed-file-touches-after-the-cutoff-and-before-the-next-cutoff",
    },
    {
      outcome_id: "high-churn",
      status: "evaluated",
      rule: "positive-observed-text-churn-at-or-above-the-upper-quartile-boundary-derived-from-prior-training-outcomes",
    },
    {
      outcome_id: "reliable-revert-or-fix-pattern",
      status: "unavailable",
      reason: "revision-bound compact history facts contain path, change-kind, and numstat evidence but no patch-equivalence or trusted change-intent binding",
    },
    {
      outcome_id: "complexity-baseline-binding",
      status: "evaluated",
      definition_id: complexityDefinition,
    },
  ];
}

function v3OutcomeDefinitions(complexityDefinition) {
  if (complexityDefinition !== null) return outcomeDefinitions(complexityDefinition);
  const definitions = outcomeDefinitions(COMPLEXITY_DEFINITIONS[0]);
  definitions[definitions.length - 1] = {
    outcome_id: "complexity-baseline-binding",
    status: "unavailable",
    definition_id: null,
    reason: "no eligible-commit horizon reached the six-cutoff evaluation threshold",
  };
  return definitions;
}

function evaluateLegacyForwardTemporal(
  input = {},
  forcedComplexityDefinition = null,
  allowDeclaredHistorySuffix = false,
) {
  assertClosed(input, INPUT_KEYS, "input");
  if (input.schema_version !== INPUT_SCHEMA_VERSION) {
    fail("FAIL-FORWARD-TEMPORAL-CONTRACT", `schema_version must equal ${INPUT_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(input.ranking_k) || input.ranking_k < 1) {
    fail("FAIL-FORWARD-TEMPORAL-CONTRACT", "ranking_k must be a positive integer");
  }
  const history = normalizeHistoryStage(input.history_stage);
  const normalized = normalizeSnapshots(input.snapshots, history, MIN_SNAPSHOTS, !allowDeclaredHistorySuffix);
  const intervalSnapshots = normalized.snapshots.slice(0, -1);
  if (forcedComplexityDefinition !== null && !COMPLEXITY_DEFINITIONS.includes(forcedComplexityDefinition)) {
    fail("FAIL-PREDICTIVE-BINDING", "forced complexity definition is not one frozen evaluator feature");
  }
  const complexityDefinition = forcedComplexityDefinition ?? selectComplexityDefinition(intervalSnapshots);
  const observationsBySnapshot = new Map(intervalSnapshots.map((snapshot) => [
    snapshot.snapshot_id,
    observationsForSnapshot(snapshot, complexityDefinition),
  ]));
  assertFeatureCompatibility(observationsBySnapshot);
  const intervals = buildIntervals(normalized.snapshots, normalized.commitIndex, history, observationsBySnapshot);
  if (intervals.length < 2) {
    fail("FAIL-FORWARD-TEMPORAL-INSUFFICIENT", "one prior training interval and at least one forward holdout interval are required");
  }
  if (intervals.some((interval) => input.ranking_k > interval.observations.length)) {
    fail("FAIL-FORWARD-TEMPORAL-INSUFFICIENT", "ranking_k exceeds an evaluated holdout cohort");
  }
  const folds = intervals.slice(1).map((_, index) => foldReceipt(intervals, index + 1, input.ranking_k));
  const evaluation = aggregateEvaluation(folds);
  const evaluatedOutcomeCount = evaluation.filter((outcome) => outcome.status === "evaluated").length;
  const status = evaluatedOutcomeCount === evaluation.length
    ? "evaluated"
    : evaluatedOutcomeCount === 0 ? "not_established" : "partially_evaluated";
  const body = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    kind: "forward-temporal-ranking-evaluation-receipt",
    status,
    reason: status === "evaluated"
      ? null
      : "one or more outcome aggregates lack two forward folds with both mechanically observed classes",
    score_kind: "deterministic-ranking-score",
    interpretation_boundary: "mechanically observed future repository modifications and text churn only; no causal, incident, or quality claim",
    repository: {
      repository_id: history.binding.repository_id,
      configuration_hash: history.binding.configuration_hash,
      history_stage_sha256: history.artifact_sha256,
      history_start_revision: history.binding.history_start,
      history_end_revision: history.binding.history_end,
      commit_count: history.commits.length,
    },
    protocol: {
      ordering_authority: "strictly-increasing-package-history-timestamps",
      cutoff_authority: "canonical-snapshot-repository-revision",
      outcome_window: "commits-strictly-after-cutoff-and-strictly-before-next-cutoff",
      training_rule: "only-completed-prior-outcome-intervals",
      minimum_snapshots: MIN_SNAPSHOTS,
      minimum_observations_per_cohort: MIN_OBSERVATIONS,
      minimum_forward_folds_for_established_aggregate: MIN_ESTABLISHED_FOLDS,
      ranking_k: input.ranking_k,
    },
    snapshot_bindings: normalized.snapshots.map((snapshot) => ({
      snapshot_id: snapshot.snapshot_id,
      repository_revision: snapshot.repository.revision,
    })),
    methods: METHODS.map((method) => ({
      method_id: method.method_id,
      method_kind: method.method_kind,
      feature_keys: method.feature_keys.slice(),
      score_interpretation: "training-range-normalized ranking score",
    })),
    outcome_definitions: outcomeDefinitions(complexityDefinition),
    folds,
    evaluation,
    limitations: [
      "strict timestamp ties or regressions are rejected because compact history facts do not retain a parent graph",
      "binary future changes are rejected because complete text churn cannot be derived",
      "rename lineage is followed; copies remain distinct paths",
      "cutoff snapshot generation time is not used as repository history time",
    ],
  };
  const receipt = {
    ...body,
    receipt_sha256: `sha256:${crypto.createHash("sha256").update(stableStringify(body)).digest("hex")}`,
  };
  return deepFreeze(receipt);
}

function materializeV3TerminalFold({
  historyStage,
  snapshots,
  rankingK,
  complexityDefinition,
  targetIds,
}) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    fail("FAIL-PREDICTIVE-PROMOTION", "terminal materialization targets must be a nonempty frozen-order subset");
  }
  const expectedTargetIds = EVALUATED_OUTCOMES.filter((targetId) => targetIds.includes(targetId));
  if (!sameSequence(targetIds, expectedTargetIds)) {
    fail("FAIL-PREDICTIVE-PROMOTION", "terminal materialization targets must be a nonempty frozen-order subset");
  }
  if (!Number.isInteger(rankingK) || rankingK < 1
      || !COMPLEXITY_DEFINITIONS.includes(complexityDefinition)) {
    fail("FAIL-PREDICTIVE-BINDING", "terminal materialization lacks its frozen ranking and complexity binding");
  }
  const history = normalizeHistoryStage(historyStage);
  const normalized = normalizeSnapshots(
    snapshots,
    history,
    promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT,
  );
  const intervalSnapshots = normalized.snapshots.slice(0, -1);
  const observationsBySnapshot = new Map(intervalSnapshots.map((snapshot) => [
    snapshot.snapshot_id,
    observationsForSnapshot(snapshot, complexityDefinition),
  ]));
  assertFeatureCompatibility(observationsBySnapshot);
  const intervals = buildIntervals(normalized.snapshots, normalized.commitIndex, history, observationsBySnapshot);
  if (intervals.length !== promotionPrivate.DEVELOPMENT_FOLD_COUNT
      + promotionPrivate.TERMINAL_HOLDOUT_FOLD_COUNT + 1
      || intervals.some((interval) => rankingK > interval.observations.length)) {
    fail("FAIL-PREDICTIVE-PROMOTION", "terminal materialization lacks the exact six-cutoff fold geometry");
  }
  return foldReceipt(
    intervals,
    intervals.length - 1,
    rankingK,
    targetIds,
    true,
  );
}

function assertPredictiveClosed(value, allowedKeys, label) {
  if (!isRecord(value)) fail("FAIL-PREDICTIVE-BINDING", `${label} must be an object`);
  const actual = Object.keys(value).sort(stableCompare);
  const expected = allowedKeys.slice().sort(stableCompare);
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} must contain exactly ${expected.join(", ")}`);
  }
}

function assertV3Finite(value, label, { nullable = false, minimum = 0, maximum = null } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== null && value < minimum)
      || (maximum !== null && value > maximum)) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} is outside its finite metric bounds`);
  }
}

function assertV3NonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} must be a nonnegative safe integer`);
  }
}

function assertV3Classes(value, label) {
  assertPredictiveClosed(value, ["negative", "observations", "positive"], label);
  for (const field of ["observations", "positive", "negative"]) {
    assertV3NonnegativeInteger(value[field], `${label}.${field}`);
  }
  if (value.observations < 1 || value.positive + value.negative !== value.observations) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} must exactly partition a nonempty cohort`);
  }
}

function assertV3FeatureNormalizers(value, label) {
  assertPredictiveClosed(value, ["change_frequency", "churn", "complexity", "loc"], label);
  for (const feature of ["loc", "change_frequency", "churn", "complexity"]) {
    const range = value[feature];
    assertPredictiveClosed(range, ["max", "min"], `${label}.${feature}`);
    assertV3Finite(range.min, `${label}.${feature}.min`);
    assertV3Finite(range.max, `${label}.${feature}.max`);
    if (range.min > range.max) fail("FAIL-PREDICTIVE-BINDING", `${label}.${feature} has an inverted range`);
  }
}

function assertV3Comparison(value, label, withMetric = false) {
  assertPredictiveClosed(value, withMetric ? ["delta", "metric", "result"] : ["delta", "result"], label);
  if (withMetric && value.metric !== "average_precision") {
    fail("FAIL-PREDICTIVE-BINDING", `${label}.metric must equal average_precision`);
  }
  if (!["better", "equal", "reference", "unavailable", "worse"].includes(value.result)) {
    fail("FAIL-PREDICTIVE-BINDING", `${label}.result is unsupported`);
  }
  assertV3Finite(value.delta, `${label}.delta`, { nullable: true, minimum: null });
}

function assertV3Ranking(
  value,
  label,
  expectedMethod,
  rankingK,
  holdoutClasses,
  outcomeId,
  highChurnThreshold,
  targetSpecificFacts,
) {
  assertPredictiveClosed(value, [
    "average_precision",
    "comparison_to_sei",
    "comparisons_to_sei",
    "lift_at_k",
    "method_id",
    "method_kind",
    "metric_availability",
    "precision_at_k",
    "ranking",
    "ranking_k",
    "recall_at_k",
    "reciprocal_rank",
    "score_interpretation",
    "spearman_rank_correlation",
  ], label);
  if (value.method_id !== expectedMethod.method_id
      || value.method_kind !== expectedMethod.method_kind
      || value.ranking_k !== rankingK
      || value.score_interpretation !== "training-range-normalized ranking score") {
    fail("FAIL-PREDICTIVE-BINDING", `${label} does not match its frozen method and score semantics`);
  }
  for (const field of ["precision_at_k", "recall_at_k", "average_precision", "reciprocal_rank"]) {
    assertV3Finite(value[field], `${label}.${field}`, { nullable: true, maximum: 1 });
  }
  assertV3Finite(value.lift_at_k, `${label}.lift_at_k`, { nullable: true });
  assertV3Finite(value.spearman_rank_correlation, `${label}.spearman_rank_correlation`, {
    nullable: true,
    minimum: -1,
    maximum: 1,
  });
  const metricFields = [
    "average_precision",
    "lift_at_k",
    "precision_at_k",
    "recall_at_k",
    "spearman_rank_correlation",
  ];
  const availabilityStates = {
    average_precision: ["available", "unavailable_class_distribution"],
    lift_at_k: ["available", "unavailable_no_positive_outcomes"],
    precision_at_k: ["available"],
    recall_at_k: ["available", "unavailable_no_positive_outcomes"],
    spearman_rank_correlation: [
      "available",
      "unavailable_class_distribution",
      "unavailable_constant_ranking",
    ],
  };
  assertPredictiveClosed(value.metric_availability, metricFields, `${label}.metric_availability`);
  assertPredictiveClosed(value.comparisons_to_sei, metricFields, `${label}.comparisons_to_sei`);
  for (const field of metricFields) {
    const availability = value.metric_availability[field];
    if (!availabilityStates[field].includes(availability)
        || (availability === "available") !== (value[field] !== null)) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.metric_availability.${field} contradicts its metric value`);
    }
    assertV3Comparison(value.comparisons_to_sei[field], `${label}.comparisons_to_sei.${field}`);
  }
  assertV3Comparison(value.comparison_to_sei, `${label}.comparison_to_sei`, true);
  if (!Array.isArray(value.ranking) || value.ranking.length !== holdoutClasses.observations
      || rankingK > value.ranking.length) {
    fail("FAIL-PREDICTIVE-BINDING", `${label}.ranking must cover the complete holdout cohort`);
  }
  value.ranking.forEach((entry, index) => {
    const factKeys = targetSpecificFacts
      ? [outcomeId === "high-churn" ? "future_text_churn" : "future_touch_count"]
      : ["future_text_churn", "future_touch_count"];
    assertPredictiveClosed(entry, [
      ...factKeys,
      "observed_outcome",
      "rank",
      "rank_score",
      "subject",
    ], `${label}.ranking[${index}]`);
    if (entry.rank !== index + 1 || typeof entry.subject !== "string" || entry.subject.length === 0
        || typeof entry.observed_outcome !== "boolean") {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.ranking[${index}] has malformed rank identity or outcome`);
    }
    assertV3Finite(entry.rank_score, `${label}.ranking[${index}].rank_score`, { maximum: 1 });
    if (Object.hasOwn(entry, "future_touch_count")) {
      assertV3NonnegativeInteger(entry.future_touch_count, `${label}.ranking[${index}].future_touch_count`);
    }
    if (Object.hasOwn(entry, "future_text_churn")) {
      assertV3NonnegativeInteger(entry.future_text_churn, `${label}.ranking[${index}].future_text_churn`);
    }
    const expectedOutcome = observedOutcome(outcomeId, {
      touch_count: entry.future_touch_count ?? 0,
      text_churn: entry.future_text_churn ?? 0,
    }, highChurnThreshold);
    if (entry.observed_outcome !== expectedOutcome) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.ranking[${index}] observed outcome contradicts its subject factual cohort and target rule`);
    }
    if (index > 0) {
      const previous = value.ranking[index - 1];
      if (previous.rank_score < entry.rank_score
          || (previous.rank_score === entry.rank_score && stableCompare(previous.subject, entry.subject) > 0)) {
        fail("FAIL-PREDICTIVE-BINDING", `${label}.ranking is not in its deterministic score/subject order`);
      }
    }
  });
  if (new Set(value.ranking.map((entry) => entry.subject)).size !== value.ranking.length) {
    fail("FAIL-PREDICTIVE-BINDING", `${label}.ranking subjects must be unique`);
  }
  if (value.ranking.filter((entry) => entry.observed_outcome).length !== holdoutClasses.positive) {
    fail("FAIL-PREDICTIVE-BINDING", `${label}.ranking outcomes contradict holdout class counts`);
  }
  const recomputed = rankingMetrics(value.ranking, rankingK);
  const metricValues = [
    "average_precision",
    "lift_at_k",
    "precision_at_k",
    "recall_at_k",
    "reciprocal_rank",
    "spearman_rank_correlation",
  ];
  if (metricValues.some((field) => !Object.is(value[field], recomputed[field]))
      || stableStringify(value.metric_availability) !== stableStringify(recomputed.metric_availability)) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} metrics do not recompute from its exact ordered outcome rows`);
  }
  return value.ranking.map((entry) => ({
    subject: entry.subject,
    ...(Object.hasOwn(entry, "future_touch_count")
      ? { future_touch_count: entry.future_touch_count }
      : {}),
    ...(Object.hasOwn(entry, "future_text_churn")
      ? { future_text_churn: entry.future_text_churn }
      : {}),
  })).sort((left, right) => stableCompare(left.subject, right.subject));
}

function assertV3Fold(
  value,
  label,
  foldIndex,
  record,
  rankingK,
  expectedOutcomeIds = EVALUATED_OUTCOMES,
) {
  assertPredictiveClosed(value, ["fold_id", "holdout", "leakage_check", "outcomes", "training"], label);
  if (value.fold_id !== `forward-fold-${foldIndex + 1}`) {
    fail("FAIL-PREDICTIVE-PROMOTION", `${label}.fold_id is not the chronological evaluator fold`);
  }
  assertPredictiveClosed(value.training, [
    "cutoff_revisions",
    "feature_normalizers",
    "interval_ids",
    "observation_count",
    "outcome_end_revision",
    "outcome_end_timestamp",
    "outcome_revisions",
  ], `${label}.training`);
  assertPredictiveClosed(value.holdout, [
    "cutoff_revision",
    "cutoff_timestamp",
    "interval_id",
    "next_cutoff_exclusive_revision",
    "observation_count",
    "outcome_end_revision",
    "outcome_end_timestamp",
    "outcome_revisions",
    "outcome_start_exclusive_revision",
    "snapshot_id",
  ], `${label}.holdout`);
  assertPredictiveClosed(value.leakage_check, [
    "holdout_cutoff_commit_index",
    "holdout_outcome_excludes_cutoff_commit",
    "holdout_outcome_excludes_next_cutoff_commit",
    "training_end_commit_index",
    "training_ends_before_holdout",
  ], `${label}.leakage_check`);
  const expectedTrainingCutoffs = record.cutoff_snapshot_bindings
    .slice(0, foldIndex + 1).map((binding) => binding.repository_revision);
  const expectedTrainingIntervals = Array.from(
    { length: foldIndex + 1 },
    (_, index) => `interval-${index + 1}`,
  );
  const validRevisionArray = (values) => Array.isArray(values)
    && values.every((revision) => typeof revision === "string" && OBJECT_ID.test(revision))
    && new Set(values).size === values.length;
  if (!Array.isArray(value.training.interval_ids)
      || !sameSequence(value.training.interval_ids, expectedTrainingIntervals)
      || !Array.isArray(value.training.cutoff_revisions)
      || !sameSequence(value.training.cutoff_revisions, expectedTrainingCutoffs)
      || value.holdout.interval_id !== `interval-${foldIndex + 2}`
      || value.holdout.snapshot_id !== record.cutoff_snapshot_bindings[foldIndex + 1].snapshot_id
      || value.holdout.cutoff_revision !== record.cutoff_snapshot_bindings[foldIndex + 1].repository_revision
      || value.holdout.outcome_start_exclusive_revision !== value.holdout.cutoff_revision
      || value.holdout.next_cutoff_exclusive_revision !== record.cutoff_snapshot_bindings[foldIndex + 2].repository_revision
      || !validRevisionArray(value.holdout.outcome_revisions)
      || value.holdout.outcome_revisions.length !== record.horizon_commits
      || !validRevisionArray(value.training.outcome_revisions)
      || value.training.outcome_revisions.length !== (foldIndex + 1) * record.horizon_commits
      || value.training.outcome_end_revision !== value.training.outcome_revisions.at(-1)
      || value.holdout.outcome_end_revision !== value.holdout.outcome_revisions.at(-1)
      || !OBJECT_ID.test(value.training.outcome_end_revision ?? "")
      || !OBJECT_ID.test(value.holdout.outcome_end_revision ?? "")
      || !Number.isFinite(Date.parse(value.training.outcome_end_timestamp))
      || !Number.isFinite(Date.parse(value.holdout.cutoff_timestamp))
      || !Number.isFinite(Date.parse(value.holdout.outcome_end_timestamp))
      || !(Date.parse(value.training.outcome_end_timestamp) < Date.parse(value.holdout.cutoff_timestamp))
      || !(Date.parse(value.holdout.cutoff_timestamp) < Date.parse(value.holdout.outcome_end_timestamp))
      || value.holdout.outcome_revisions.includes(value.holdout.cutoff_revision)
      || value.holdout.outcome_revisions.includes(value.holdout.next_cutoff_exclusive_revision)
      || value.training.outcome_revisions.some((revision) => value.holdout.outcome_revisions.includes(revision))) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} does not bind the declared cutoffs and eligible-commit horizon`);
  }
  assertV3NonnegativeInteger(value.training.observation_count, `${label}.training.observation_count`);
  assertV3NonnegativeInteger(value.holdout.observation_count, `${label}.holdout.observation_count`);
  assertV3FeatureNormalizers(value.training.feature_normalizers, `${label}.training.feature_normalizers`);
  if (value.leakage_check.training_ends_before_holdout !== true
      || value.leakage_check.holdout_outcome_excludes_cutoff_commit !== true
      || value.leakage_check.holdout_outcome_excludes_next_cutoff_commit !== true
      || !Number.isSafeInteger(value.leakage_check.training_end_commit_index)
      || !Number.isSafeInteger(value.leakage_check.holdout_cutoff_commit_index)
      || value.leakage_check.training_end_commit_index >= value.leakage_check.holdout_cutoff_commit_index) {
    fail("FAIL-PREDICTIVE-BINDING", `${label} lacks the frozen leakage boundary proof`);
  }
  if (!Array.isArray(value.outcomes) || value.outcomes.length !== expectedOutcomeIds.length) {
    fail("FAIL-PREDICTIVE-BINDING", `${label}.outcomes must cover exactly its expected frozen targets`);
  }
  value.outcomes.forEach((outcome, outcomeIndex) => {
    const expectedOutcomeId = expectedOutcomeIds[outcomeIndex];
    const keys = ["holdout_classes", "outcome_id", "rankings", "reason", "status", "training_classes"];
    if (expectedOutcomeId === "high-churn") keys.push("threshold");
    assertPredictiveClosed(outcome, keys, `${label}.outcomes[${outcomeIndex}]`);
    if (outcome.outcome_id !== expectedOutcomeId || !["evaluated", "not_established"].includes(outcome.status)) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.outcomes[${outcomeIndex}] has unsupported target state`);
    }
    assertV3Classes(outcome.training_classes, `${label}.outcomes[${outcomeIndex}].training_classes`);
    assertV3Classes(outcome.holdout_classes, `${label}.outcomes[${outcomeIndex}].holdout_classes`);
    if (outcome.holdout_classes.observations !== value.holdout.observation_count) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.outcomes[${outcomeIndex}] contradicts the holdout cohort`);
    }
    const established = outcome.training_classes.positive > 0
      && outcome.training_classes.negative > 0
      && outcome.holdout_classes.positive > 0
      && outcome.holdout_classes.negative > 0;
    const expectedStatus = established ? "evaluated" : "not_established";
    const expectedReason = established
      ? null
      : `${expectedOutcomeId} needs both mechanically observed classes in the prior training horizon and forward holdout`;
    if (outcome.status !== expectedStatus || outcome.reason !== expectedReason) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.outcomes[${outcomeIndex}] state and reason contradict its class evidence`);
    }
    if (expectedOutcomeId === "high-churn") {
      assertPredictiveClosed(outcome.threshold, ["derivation", "unit", "value"], `${label}.outcomes[${outcomeIndex}].threshold`);
      if (outcome.threshold.unit !== "lines-changed"
          || outcome.threshold.derivation !== "upper-quartile-boundary-of-prior-training-outcome-churn-only") {
        fail("FAIL-PREDICTIVE-BINDING", `${label}.outcomes[${outcomeIndex}].threshold semantics changed`);
      }
      assertV3Finite(outcome.threshold.value, `${label}.outcomes[${outcomeIndex}].threshold.value`, { minimum: 0 });
    }
    if (!Array.isArray(outcome.rankings) || outcome.rankings.length !== METHODS.length) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.outcomes[${outcomeIndex}].rankings must cover the frozen registry`);
    }
    const methodCohorts = outcome.rankings.map((ranking, methodIndex) => assertV3Ranking(
      ranking,
      `${label}.outcomes[${outcomeIndex}].rankings[${methodIndex}]`,
      METHODS[methodIndex],
      rankingK,
      outcome.holdout_classes,
      expectedOutcomeId,
      expectedOutcomeId === "high-churn" ? outcome.threshold.value : null,
      foldIndex === promotionPrivate.DEVELOPMENT_FOLD_COUNT,
    ));
    const expectedCohort = stableStringify(methodCohorts[0]);
    if (methodCohorts.some((cohort) => stableStringify(cohort) !== expectedCohort)) {
      fail("FAIL-PREDICTIVE-BINDING", `${label}.outcomes[${outcomeIndex}] methods do not share one subject/outcome cohort`);
    }
  });
}

function promotionProtocol(rankingK) {
  return {
    evaluation_schema_version: promotionPrivate.EVALUATION_SCHEMA_VERSION,
    candidate_registry_version: promotionPrivate.CANDIDATE_REGISTRY_VERSION,
    target_schema_version: promotionPrivate.TARGET_SCHEMA_VERSION,
    evaluation_protocol_version: promotionPrivate.EVALUATION_PROTOCOL_VERSION,
    method_order: promotionPrivate.METHOD_REGISTRY.map((method) => method.method_id),
    target_order: promotionPrivate.TARGET_IDS.slice(),
    horizon_order: promotionPrivate.HORIZON_COMMITS.slice(),
    fallback_method_id: promotionPrivate.FALLBACK_METHOD_ID,
    nomination_metric: promotionPrivate.NOMINATION_METRIC,
    nomination_tie_rule: promotionPrivate.NOMINATION_TIE_RULE,
    promotion_rule: promotionPrivate.PROMOTION_RULE,
    eligible_commit_rule: promotionPrivate.ELIGIBLE_COMMIT_RULE,
    outcome_window_rule: promotionPrivate.OUTCOME_WINDOW_RULE,
    cutoff_selection_rule: promotionPrivate.CUTOFF_SELECTION_RULE,
    development_fold_count: promotionPrivate.DEVELOPMENT_FOLD_COUNT,
    terminal_holdout_fold_count: promotionPrivate.TERMINAL_HOLDOUT_FOLD_COUNT,
    minimum_cutoff_snapshot_count: promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT,
    ranking_k: rankingK,
  };
}

function normalizeV3Horizons(values, history) {
  if (!Array.isArray(values) || values.length !== promotionPrivate.HORIZON_COMMITS.length) {
    fail("FAIL-PREDICTIVE-READINESS", "V3 input must declare the 10, 25, and 50 eligible-commit horizons");
  }
  const seen = new Set();
  const normalized = values.map((value, index) => {
    assertPredictiveClosed(value, V3_HORIZON_KEYS, `input.horizons[${index}]`);
    if (!promotionPrivate.HORIZON_COMMITS.includes(value.horizon_commits) || seen.has(value.horizon_commits)) {
      fail("FAIL-PREDICTIVE-BINDING", `input.horizons[${index}] is unsupported or duplicated`);
    }
    seen.add(value.horizon_commits);
    if (!Array.isArray(value.snapshots) || value.snapshots.length === 0
        || value.snapshots.length > MAX_V3_CUTOFF_SNAPSHOT_COUNT) {
      fail("FAIL-PREDICTIVE-READINESS", `input.horizons[${index}].snapshots must contain between 1 and ${MAX_V3_CUTOFF_SNAPSHOT_COUNT} cutoffs`);
    }
    for (const snapshot of value.snapshots) {
      if (snapshot?.repository?.repository_id !== history.binding.repository_id) {
        fail("FAIL-PREDICTIVE-BINDING", `horizon ${value.horizon_commits} snapshot belongs to a different repository`);
      }
      if (snapshot?.repository?.configuration_hash !== history.binding.configuration_hash) {
        fail("FAIL-PREDICTIVE-STALE", `horizon ${value.horizon_commits} snapshot configuration is stale`);
      }
    }
    const snapshotSet = normalizeSnapshots(value.snapshots, history, 1);
    const ordered = snapshotSet.snapshots;
    for (let snapshotIndex = 1; snapshotIndex < ordered.length; snapshotIndex += 1) {
      const previousIndex = snapshotSet.commitIndex.get(ordered[snapshotIndex - 1].repository.revision);
      const currentIndex = snapshotSet.commitIndex.get(ordered[snapshotIndex].repository.revision);
      if (currentIndex - previousIndex - 1 !== value.horizon_commits) {
        fail(
          "FAIL-PREDICTIVE-READINESS",
          `horizon ${value.horizon_commits} cutoff snapshots must enclose exactly ${value.horizon_commits} eligible commits`,
        );
      }
    }
    return {
      horizon_commits: value.horizon_commits,
      available_cutoff_snapshot_count: ordered.length,
      snapshots: ordered.slice(-promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT),
    };
  });
  return normalized.sort((left, right) => (
    promotionPrivate.HORIZON_COMMITS.indexOf(left.horizon_commits)
      - promotionPrivate.HORIZON_COMMITS.indexOf(right.horizon_commits)
  ));
}

function promotionFold(sourceFold, outcomeId, role) {
  const outcome = sourceFold.outcomes.find((entry) => entry.outcome_id === outcomeId);
  if (!outcome) fail("FAIL-PHANTOM-TARGET", `${sourceFold.fold_id} omitted ${outcomeId}`);
  return {
    fold_id: sourceFold.fold_id,
    role,
    classes: {
      observations: outcome.holdout_classes.observations,
      positive: outcome.holdout_classes.positive,
      negative: outcome.holdout_classes.negative,
    },
    methods: promotionPrivate.METHOD_REGISTRY.map((method) => {
      const ranking = outcome.rankings.find((entry) => entry.method_id === method.method_id);
      if (!ranking) fail("FAIL-PREDICTIVE-BINDING", `${sourceFold.fold_id}/${outcomeId} omitted registry method ${method.method_id}`);
      return {
        method_id: method.method_id,
        lift_at_k: ranking.metric_availability.lift_at_k === "available" ? ranking.lift_at_k : null,
        average_precision: ranking.metric_availability.average_precision === "available" ? ranking.average_precision : null,
      };
    }),
  };
}

function promotionEvaluation(horizonRecord, outcomeId) {
  const developmentFolds = horizonRecord.folds.slice(0, promotionPrivate.DEVELOPMENT_FOLD_COUNT);
  const terminalFold = horizonRecord.folds[promotionPrivate.DEVELOPMENT_FOLD_COUNT];
  const targetTerminalFold = terminalFold?.outcomes.some((outcome) => outcome.outcome_id === outcomeId)
    ? terminalFold
    : null;
  return {
    target_id: outcomeId,
    horizon_commits: horizonRecord.horizon_commits,
    cutoff_snapshot_ids: horizonRecord.cutoff_snapshot_bindings.map((entry) => entry.snapshot_id),
    development_fold_ids: developmentFolds.map((fold) => fold.fold_id),
    terminal_fold_id: targetTerminalFold?.fold_id ?? null,
    folds: [
      ...developmentFolds.map((fold) => promotionFold(fold, outcomeId, "development")),
      ...(targetTerminalFold === null ? [] : [promotionFold(targetTerminalFold, outcomeId, "terminal-holdout")]),
    ],
  };
}

function developmentPromotionEvaluation(horizonRecord, outcomeId) {
  const developmentFolds = horizonRecord.folds.slice(0, promotionPrivate.DEVELOPMENT_FOLD_COUNT);
  return {
    target_id: outcomeId,
    horizon_commits: horizonRecord.horizon_commits,
    development_fold_ids: developmentFolds.map((fold) => fold.fold_id),
    folds: developmentFolds.map((fold) => promotionFold(fold, outcomeId, "development")),
  };
}

function materializeV3TerminalAfterDevelopment(developmentEvaluations, terminalFactory) {
  if (!Array.isArray(developmentEvaluations) || typeof terminalFactory !== "function") {
    fail("FAIL-PREDICTIVE-BINDING", "V3 development/terminal sequencing input is malformed");
  }
  if (developmentEvaluations.length === 0) {
    return deepFreeze({ nominations: [], terminal_evidence: null });
  }
  if (developmentEvaluations.length !== promotionPrivate.TARGET_IDS.length) {
    fail("FAIL-PREDICTIVE-PROMOTION", "ready V3 horizon must lock all three target nominations before terminal evidence");
  }
  const nominations = developmentEvaluations.map((evaluation) => (
    promotionPrivate.readPredictiveDevelopmentNomination(
      promotionPrivate.nominatePredictiveDevelopment(evaluation),
    )
  ));
  if (!sameSequence(nominations.map((entry) => entry.target_id), promotionPrivate.TARGET_IDS)
      || new Set(nominations.map((entry) => entry.horizon_commits)).size !== 1) {
    fail("FAIL-PREDICTIVE-PROMOTION", "development nominations do not cover one ordered frozen target matrix");
  }
  if (nominations.every((entry) => entry.state !== "NOMINATED")) {
    return deepFreeze({ nominations, terminal_evidence: null });
  }
  const terminalEvidence = terminalFactory(deepFreeze(nominations.slice()));
  return deepFreeze({ nominations, terminal_evidence: terminalEvidence });
}

function currentRankingFor({ currentSnapshot, complexityDefinition, terminalFold, method, rankingK }) {
  const observations = observationsForSnapshot(currentSnapshot, complexityDefinition);
  if (observations.length < MIN_OBSERVATIONS || rankingK > observations.length) {
    fail(
      "FAIL-PREDICTIVE-BINDING",
      `current snapshot lacks ${MIN_OBSERVATIONS} complete observations for the terminally evaluated ${complexityDefinition} feature binding`,
    );
  }
  const ranges = terminalFold.training.feature_normalizers;
  const scored = observations.map((observation) => ({
    subject: observation.subject,
    path: observation.path,
    score: methodScore(observation, method, ranges),
  })).sort((left, right) => right.score - left.score || stableCompare(left.subject, right.subject));
  return scored.slice(0, rankingK).map((entry, index) => ({
    rank: index + 1,
    subject: entry.subject,
    path: entry.path,
    percentile: scored.length <= 1
      ? 1
      : Math.round((1 - index / (scored.length - 1)) * 1_000_000) / 1_000_000,
  }));
}

function evaluateV3ForwardTemporal(input) {
  assertPredictiveClosed(input, V3_INPUT_KEYS, "input");
  if (input.schema_version !== V3_INPUT_SCHEMA_VERSION) {
    fail("FAIL-PREDICTIVE-STALE", `schema_version must equal ${V3_INPUT_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(input.ranking_k) || input.ranking_k < 1) {
    fail("FAIL-PREDICTIVE-BINDING", "ranking_k must be a positive integer");
  }
  const history = normalizeHistoryStage(input.history_stage);
  const normalizedHorizons = normalizeV3Horizons(input.horizons, history);
  const finalSnapshots = normalizedHorizons.map((horizon) => horizon.snapshots.at(-1));
  const finalSnapshot = finalSnapshots[0];
  if (finalSnapshots.some((snapshot) => snapshot.snapshot_id !== finalSnapshot.snapshot_id
      || snapshot.repository.revision !== finalSnapshot.repository.revision
      || snapshot.repository.configuration_hash !== finalSnapshot.repository.configuration_hash)) {
    fail("FAIL-PREDICTIVE-STALE", "all predictive horizons must end at the same current canonical snapshot");
  }

  const horizonRecords = normalizedHorizons.map((horizon) => {
    const ready = horizon.available_cutoff_snapshot_count >= promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT;
    if (!ready) {
      return {
        horizon_commits: horizon.horizon_commits,
        available_cutoff_snapshot_count: horizon.available_cutoff_snapshot_count,
        selected_cutoff_snapshot_count: horizon.snapshots.length,
        cutoff_snapshot_bindings: horizon.snapshots.map((snapshot) => ({
          snapshot_id: snapshot.snapshot_id,
          repository_revision: snapshot.repository.revision,
        })),
        complexity_definition_id: null,
        development_fold_ids: [],
        terminal_fold_id: null,
        folds: [],
        source_receipt_sha256: null,
        development_nominations: [],
        selected_snapshots: horizon.snapshots,
      };
    }
    const developmentReceipt = evaluateLegacyForwardTemporal({
      schema_version: INPUT_SCHEMA_VERSION,
      history_stage: input.history_stage,
      snapshots: horizon.snapshots.slice(0, -1),
      ranking_k: input.ranking_k,
    }, null, true);
    if (developmentReceipt.folds.length !== promotionPrivate.DEVELOPMENT_FOLD_COUNT) {
      fail("FAIL-PREDICTIVE-PROMOTION", `horizon ${horizon.horizon_commits} did not produce exactly three development folds`);
    }
    const complexityDefinition = developmentReceipt.outcome_definitions.find((definition) => (
      definition.outcome_id === "complexity-baseline-binding"
    ))?.definition_id;
    if (!COMPLEXITY_DEFINITIONS.includes(complexityDefinition)) {
      fail("FAIL-PREDICTIVE-BINDING", `horizon ${horizon.horizon_commits} development evidence lacks one complexity definition`);
    }
    const developmentRecord = {
      horizon_commits: horizon.horizon_commits,
      folds: developmentReceipt.folds,
    };
    const phase = materializeV3TerminalAfterDevelopment(
      promotionPrivate.TARGET_IDS.map((outcomeId) => (
        developmentPromotionEvaluation(developmentRecord, outcomeId)
      )),
      (nominations) => materializeV3TerminalFold({
        historyStage: input.history_stage,
        snapshots: horizon.snapshots,
        rankingK: input.ranking_k,
        complexityDefinition,
        targetIds: nominations.filter((entry) => entry.state === "NOMINATED")
          .map((entry) => entry.target_id),
      }),
    );
    const terminalFold = phase.terminal_evidence;
    if (terminalFold === null) {
      return {
        horizon_commits: horizon.horizon_commits,
        available_cutoff_snapshot_count: horizon.available_cutoff_snapshot_count,
        selected_cutoff_snapshot_count: horizon.snapshots.length,
        cutoff_snapshot_bindings: horizon.snapshots.map((snapshot) => ({
          snapshot_id: snapshot.snapshot_id,
          repository_revision: snapshot.repository.revision,
        })),
        complexity_definition_id: complexityDefinition,
        development_fold_ids: developmentReceipt.folds.map((fold) => fold.fold_id),
        terminal_fold_id: null,
        folds: developmentReceipt.folds,
        source_receipt_sha256: developmentReceipt.receipt_sha256,
        development_nominations: phase.nominations,
        selected_snapshots: horizon.snapshots,
      };
    }
    if (terminalFold.fold_id !== `forward-fold-${promotionPrivate.DEVELOPMENT_FOLD_COUNT + 1}`) {
      fail("FAIL-PREDICTIVE-PROMOTION", `horizon ${horizon.horizon_commits} did not materialize its fourth forward fold`);
    }
    const folds = [...developmentReceipt.folds, terminalFold];
    return {
      horizon_commits: horizon.horizon_commits,
      available_cutoff_snapshot_count: horizon.available_cutoff_snapshot_count,
      selected_cutoff_snapshot_count: horizon.snapshots.length,
      cutoff_snapshot_bindings: horizon.snapshots.map((snapshot) => ({
        snapshot_id: snapshot.snapshot_id,
        repository_revision: snapshot.repository.revision,
      })),
      complexity_definition_id: complexityDefinition,
      development_fold_ids: developmentReceipt.folds.map((fold) => fold.fold_id),
      terminal_fold_id: terminalFold.fold_id,
      folds,
      source_receipt_sha256: developmentReceipt.receipt_sha256,
      development_nominations: phase.nominations,
      selected_snapshots: horizon.snapshots,
    };
  });

  const evaluatedComplexityDefinitions = new Set(horizonRecords
    .filter((record) => record.folds.length > 0)
    .map((record) => record.complexity_definition_id));
  if (evaluatedComplexityDefinitions.size > 1) {
    fail("FAIL-PREDICTIVE-BINDING", "all evaluated horizons must use one frozen complexity feature definition");
  }
  const complexityDefinition = evaluatedComplexityDefinitions.values().next().value
    ?? null;

  const horizonReadiness = horizonRecords.map((record) => ({
    horizon_commits: record.horizon_commits,
    cutoff_snapshot_count: record.available_cutoff_snapshot_count,
    state: record.available_cutoff_snapshot_count >= promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT
      ? "READY"
      : "INSUFFICIENT_HISTORY",
  }));
  const evaluations = horizonRecords.flatMap((record) => (
    record.folds.length === 0
      ? []
      : promotionPrivate.TARGET_IDS.map((outcomeId) => promotionEvaluation(record, outcomeId))
  ));
  const promotion = promotionPrivate.evaluatePredictivePromotion({
    schema_version: promotionPrivate.INPUT_SCHEMA_VERSION,
    current_binding: {
      repository_id: finalSnapshot.repository.repository_id,
      revision: finalSnapshot.repository.revision,
      snapshot_id: finalSnapshot.snapshot_id,
      configuration_hash: finalSnapshot.repository.configuration_hash,
    },
    evidence_binding: {
      repository_id: history.binding.repository_id,
      final_revision: history.binding.history_end,
      final_snapshot_id: finalSnapshot.snapshot_id,
      configuration_hash: history.binding.configuration_hash,
    },
    protocol: promotionProtocol(input.ranking_k),
    horizon_readiness: horizonReadiness,
    evaluations,
  });
  promotionPrivate.readPredictivePromotion(promotion);
  const lockedNominations = new Map(horizonRecords.flatMap((record) => (
    record.development_nominations.map((entry) => [
      `${entry.target_id}\0${entry.horizon_commits}`,
      entry,
    ])
  )));
  for (const decision of promotion.promotions) {
    const locked = lockedNominations.get(`${decision.target_id}\0${decision.horizon_commits}`) ?? null;
    if (locked === null) continue;
    if (stableStringify(locked.nomination) !== stableStringify(decision.nomination)
        || (locked.state === "READY_NOT_EVALUATED") !== (decision.state === "READY_NOT_EVALUATED")) {
      fail("FAIL-PREDICTIVE-PROMOTION", "terminal evaluation did not preserve the locked development-only nomination");
    }
  }

  const recordsByHorizon = new Map(horizonRecords.map((record) => [record.horizon_commits, record]));
  const methodsById = new Map(METHODS.map((method) => [method.method_id, method]));
  const currentForecasts = promotion.validated_selections.map((selection) => {
    const record = recordsByHorizon.get(selection.horizon_commits);
    const method = methodsById.get(selection.method_id);
    if (!record || !method || record.folds.length === 0) {
      fail("FAIL-PREDICTIVE-BINDING", "validated selection does not bind one evaluated registry method and horizon");
    }
    return {
      target_id: selection.target_id,
      horizon_commits: selection.horizon_commits,
      state: selection.state,
      method_id: selection.method_id,
      method_kind: selection.method_kind,
      claim: "rank-only",
      items: currentRankingFor({
        currentSnapshot: record.selected_snapshots.at(-1),
        complexityDefinition: record.complexity_definition_id,
        terminalFold: record.folds.at(-1),
        method,
        rankingK: input.ranking_k,
      }),
    };
  });
  const publicHorizonRecords = horizonRecords.map(({
    development_nominations: ignoredNominations,
    selected_snapshots: ignoredSnapshots,
    ...record
  }) => record);
  const reason = promotion.readiness.state === "READY"
    ? null
    : "one or more eligible-commit horizons lack six canonical cutoff snapshots";
  const body = {
    schema_version: AUTO_RECEIPT_SCHEMA_VERSION,
    kind: V3_KIND,
    status: promotion.readiness.state === "READY" ? "evaluated" : "not_ready",
    reason,
    public_state: promotion.public_state,
    score_kind: V3_SCORE_KIND,
    interpretation_boundary: promotion.interpretation_boundary,
    repository: {
      repository_id: history.binding.repository_id,
      configuration_hash: history.binding.configuration_hash,
      history_stage_sha256: history.artifact_sha256,
      history_start_revision: history.binding.history_start,
      history_end_revision: history.binding.history_end,
      commit_count: history.commits.length,
    },
    final_snapshot_binding: {
      snapshot_id: finalSnapshot.snapshot_id,
      repository_revision: finalSnapshot.repository.revision,
      configuration_hash: finalSnapshot.repository.configuration_hash,
    },
    protocol: promotion.protocol,
    readiness: promotion.readiness,
    methods: promotionPrivate.METHOD_REGISTRY.map((method) => ({
      method_id: method.method_id,
      method_kind: method.method_kind,
      feature_keys: method.feature_keys.slice(),
    })),
    outcome_definitions: v3OutcomeDefinitions(complexityDefinition),
    horizons: publicHorizonRecords,
    promotion_sha256: promotion.promotion_sha256,
    promotions: promotion.promotions,
    validated_selections: promotion.validated_selections,
    current_forecasts: currentForecasts,
    limitations: V3_LIMITATIONS.slice(),
  };
  const receipt = deepFreeze({
    ...body,
    receipt_sha256: `sha256:${crypto.createHash("sha256").update(stableStringify(body)).digest("hex")}`,
  });
  verifiedV3Receipts.add(receipt);
  return receipt;
}

function evaluateForwardTemporal(input = {}) {
  if (input?.schema_version === V3_INPUT_SCHEMA_VERSION) return evaluateV3ForwardTemporal(input);
  return evaluateLegacyForwardTemporal(input);
}

function verifyV3Receipt(receipt, currentSnapshot, replayOwnedReceipt = null) {
  const topLevelKeys = [
    "current_forecasts",
    "final_snapshot_binding",
    "horizons",
    "interpretation_boundary",
    "kind",
    "limitations",
    "methods",
    "outcome_definitions",
    "promotion_sha256",
    "promotions",
    "protocol",
    "public_state",
    "readiness",
    "reason",
    "receipt_sha256",
    "repository",
    "schema_version",
    "score_kind",
    "status",
    "validated_selections",
  ];
  if (!exactKeys(receipt, topLevelKeys)
      || receipt.schema_version !== AUTO_RECEIPT_SCHEMA_VERSION
      || receipt.kind !== V3_KIND
      || !SHA256.test(receipt.receipt_sha256)
      || !SHA256.test(receipt.promotion_sha256)) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 receipt is not one closed terminal-holdout promotion record");
  }
  const currentValidation = validateSnapshot(currentSnapshot);
  if (!currentValidation.ok) {
    fail("FAIL-PREDICTIVE-BINDING", `current snapshot is not canonical (${currentValidation.errors.join("; ")})`);
  }
  if (!exactKeys(receipt.repository, [
    "commit_count",
    "configuration_hash",
    "history_end_revision",
    "history_stage_sha256",
    "history_start_revision",
    "repository_id",
  ]) || !exactKeys(receipt.final_snapshot_binding, [
    "configuration_hash",
    "repository_revision",
    "snapshot_id",
  ])) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 repository and final snapshot bindings are not closed");
  }
  if (!SHA256.test(receipt.repository.history_stage_sha256 ?? "")
      || !OBJECT_ID.test(receipt.repository.history_end_revision ?? "")
      || (receipt.repository.history_start_revision !== null
        && !OBJECT_ID.test(receipt.repository.history_start_revision ?? ""))
      || !Number.isSafeInteger(receipt.repository.commit_count)
      || receipt.repository.commit_count < 1
      || !SNAPSHOT_ID.test(receipt.final_snapshot_binding.snapshot_id ?? "")
      || !OBJECT_ID.test(receipt.final_snapshot_binding.repository_revision ?? "")
      || !/^[a-f0-9]{64}$/.test(receipt.final_snapshot_binding.configuration_hash ?? "")) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 repository and final snapshot binding values are malformed");
  }
  if (receipt.repository.repository_id !== currentSnapshot.repository.repository_id
      || receipt.repository.configuration_hash !== currentSnapshot.repository.configuration_hash
      || receipt.repository.history_end_revision !== currentSnapshot.repository.revision
      || receipt.final_snapshot_binding.snapshot_id !== currentSnapshot.snapshot_id
      || receipt.final_snapshot_binding.repository_revision !== currentSnapshot.repository.revision
      || receipt.final_snapshot_binding.configuration_hash !== currentSnapshot.repository.configuration_hash) {
    fail("FAIL-PREDICTIVE-STALE", "V3 receipt does not bind the current repository, revision, snapshot, and configuration");
  }
  const expectedProtocol = promotionProtocol(receipt.protocol?.ranking_k);
  if (stableStringify(receipt.protocol) !== stableStringify(expectedProtocol)) {
    fail("FAIL-PREDICTIVE-STALE", "V3 protocol does not match the frozen evaluator configuration");
  }
  const expectedMethods = promotionPrivate.METHOD_REGISTRY.map((method) => ({
    method_id: method.method_id,
    method_kind: method.method_kind,
    feature_keys: method.feature_keys.slice(),
  }));
  if (stableStringify(receipt.methods) !== stableStringify(expectedMethods)) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 receipt method registry is not the frozen five-method registry");
  }
  if (!Array.isArray(receipt.horizons) || receipt.horizons.length !== promotionPrivate.HORIZON_COMMITS.length) {
    fail("FAIL-PREDICTIVE-READINESS", "V3 receipt does not cover all frozen horizons");
  }
  const horizonRecords = receipt.horizons.map((record, index) => {
    if (!exactKeys(record, [
      "available_cutoff_snapshot_count",
      "complexity_definition_id",
      "cutoff_snapshot_bindings",
      "development_fold_ids",
      "folds",
      "horizon_commits",
      "selected_cutoff_snapshot_count",
      "source_receipt_sha256",
      "terminal_fold_id",
    ]) || record.horizon_commits !== promotionPrivate.HORIZON_COMMITS[index]
        || !Number.isSafeInteger(record.available_cutoff_snapshot_count)
        || record.available_cutoff_snapshot_count < 1
        || !Number.isSafeInteger(record.selected_cutoff_snapshot_count)
        || record.selected_cutoff_snapshot_count < 1
        || record.selected_cutoff_snapshot_count > promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT
        || !Array.isArray(record.cutoff_snapshot_bindings)
        || record.cutoff_snapshot_bindings.length !== record.selected_cutoff_snapshot_count) {
      fail("FAIL-PREDICTIVE-READINESS", `V3 horizon record ${index} is malformed`);
    }
    record.cutoff_snapshot_bindings.forEach((binding, bindingIndex) => {
      if (!exactKeys(binding, ["repository_revision", "snapshot_id"])
          || !OBJECT_ID.test(binding.repository_revision ?? "")
          || !SNAPSHOT_ID.test(binding.snapshot_id ?? "")) {
        fail("FAIL-PREDICTIVE-BINDING", `V3 horizon ${record.horizon_commits} cutoff ${bindingIndex} is malformed`);
      }
    });
    if (new Set(record.cutoff_snapshot_bindings.map((binding) => binding.snapshot_id)).size !== record.cutoff_snapshot_bindings.length
        || new Set(record.cutoff_snapshot_bindings.map((binding) => binding.repository_revision)).size !== record.cutoff_snapshot_bindings.length) {
      fail("FAIL-PREDICTIVE-BINDING", `V3 horizon ${record.horizon_commits} cutoff bindings must be unique`);
    }
    if (record.cutoff_snapshot_bindings.at(-1).snapshot_id !== currentSnapshot.snapshot_id
        || record.cutoff_snapshot_bindings.at(-1).repository_revision !== currentSnapshot.repository.revision) {
      fail("FAIL-PREDICTIVE-STALE", `V3 horizon ${record.horizon_commits} does not end at the current snapshot`);
    }
    const ready = record.available_cutoff_snapshot_count >= promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT;
    if (ready) {
      const terminalMaterialized = record.terminal_fold_id !== null;
      const expectedFoldCount = promotionPrivate.DEVELOPMENT_FOLD_COUNT
        + (terminalMaterialized ? promotionPrivate.TERMINAL_HOLDOUT_FOLD_COUNT : 0);
      if (record.selected_cutoff_snapshot_count !== promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT
          || !Array.isArray(record.folds) || record.folds.length !== expectedFoldCount
          || !Array.isArray(record.development_fold_ids) || record.development_fold_ids.length !== 3
          || (terminalMaterialized && typeof record.terminal_fold_id !== "string")
          || !SHA256.test(record.source_receipt_sha256 ?? "")
          || !COMPLEXITY_DEFINITIONS.includes(record.complexity_definition_id)) {
        fail("FAIL-PREDICTIVE-PROMOTION", `V3 ready horizon ${record.horizon_commits} lacks its locked development/terminal proof`);
      }
      const foldIds = record.folds.map((fold) => fold?.fold_id);
      if (!sameSequence(record.development_fold_ids, foldIds.slice(0, 3))
          || (terminalMaterialized && record.terminal_fold_id !== foldIds[3])
          || (!terminalMaterialized && foldIds.length !== promotionPrivate.DEVELOPMENT_FOLD_COUNT)
          || new Set(foldIds).size !== expectedFoldCount) {
        fail("FAIL-PREDICTIVE-PROMOTION", `V3 horizon ${record.horizon_commits} fold partition is not chronological and disjoint`);
      }
      record.folds.slice(0, promotionPrivate.DEVELOPMENT_FOLD_COUNT).forEach((fold, foldIndex) => assertV3Fold(
        fold,
        `receipt.horizons[${index}].folds[${foldIndex}]`,
        foldIndex,
        record,
        receipt.protocol.ranking_k,
      ));
      const terminalTargetIds = promotionPrivate.TARGET_IDS.filter((outcomeId) => (
        promotionPrivate.readPredictiveDevelopmentNomination(
          promotionPrivate.nominatePredictiveDevelopment(
            developmentPromotionEvaluation(record, outcomeId),
          ),
        ).state === "NOMINATED"
      ));
      if (terminalMaterialized !== (terminalTargetIds.length > 0)) {
        fail("FAIL-PREDICTIVE-PROMOTION", `V3 horizon ${record.horizon_commits} terminal fold does not follow its target nominations`);
      }
      if (terminalMaterialized) {
        assertV3Fold(
          record.folds[promotionPrivate.DEVELOPMENT_FOLD_COUNT],
          `receipt.horizons[${index}].folds[${promotionPrivate.DEVELOPMENT_FOLD_COUNT}]`,
          promotionPrivate.DEVELOPMENT_FOLD_COUNT,
          record,
          receipt.protocol.ranking_k,
          terminalTargetIds,
        );
      }
    } else if (!Array.isArray(record.folds) || record.folds.length !== 0
        || !Array.isArray(record.development_fold_ids) || record.development_fold_ids.length !== 0
        || record.terminal_fold_id !== null || record.source_receipt_sha256 !== null
        || record.complexity_definition_id !== null
        || record.selected_cutoff_snapshot_count !== record.available_cutoff_snapshot_count) {
      fail("FAIL-PREDICTIVE-READINESS", `V3 unready horizon ${record.horizon_commits} claims evaluation evidence`);
    }
    return record;
  });
  const horizonReadiness = horizonRecords.map((record) => ({
    horizon_commits: record.horizon_commits,
    cutoff_snapshot_count: record.available_cutoff_snapshot_count,
    state: record.available_cutoff_snapshot_count >= promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT
      ? "READY"
      : "INSUFFICIENT_HISTORY",
  }));
  const evaluations = horizonRecords.flatMap((record) => (
    record.folds.length === 0
      ? []
      : promotionPrivate.TARGET_IDS.map((outcomeId) => promotionEvaluation(record, outcomeId))
  ));
  const rebuiltPromotion = promotionPrivate.evaluatePredictivePromotion({
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
    horizon_readiness: horizonReadiness,
    evaluations,
  });
  for (const record of horizonRecords.filter((entry) => entry.folds.length > 0)) {
    const hasDevelopmentNominee = rebuiltPromotion.promotions.some((promotion) => (
      promotion.horizon_commits === record.horizon_commits && promotion.nomination !== null
    ));
    if ((record.terminal_fold_id !== null) !== hasDevelopmentNominee) {
      fail("FAIL-PREDICTIVE-PROMOTION", `V3 horizon ${record.horizon_commits} terminal evidence does not follow its development nomination gate`);
    }
  }
  if (rebuiltPromotion.promotion_sha256 !== receipt.promotion_sha256
      || rebuiltPromotion.public_state !== receipt.public_state
      || stableStringify(rebuiltPromotion.readiness) !== stableStringify(receipt.readiness)
      || stableStringify(rebuiltPromotion.promotions) !== stableStringify(receipt.promotions)
      || stableStringify(rebuiltPromotion.validated_selections) !== stableStringify(receipt.validated_selections)) {
    fail("FAIL-PREDICTIVE-PROMOTION", "V3 promotion evidence does not independently reproduce its declared decision");
  }
  const expectedStatus = rebuiltPromotion.readiness.state === "READY" ? "evaluated" : "not_ready";
  const expectedReason = rebuiltPromotion.readiness.state === "READY"
    ? null
    : "one or more eligible-commit horizons lack six canonical cutoff snapshots";
  if (receipt.status !== expectedStatus
      || receipt.reason !== expectedReason
      || receipt.score_kind !== V3_SCORE_KIND
      || receipt.interpretation_boundary !== rebuiltPromotion.interpretation_boundary
      || stableStringify(receipt.limitations) !== stableStringify(V3_LIMITATIONS)) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 public semantics do not match the frozen rank-only protocol");
  }
  const complexityDefinition = receipt.outcome_definitions?.find((outcome) => (
    outcome?.outcome_id === "complexity-baseline-binding"
  ))?.definition_id;
  const hasEvaluatedHorizon = horizonRecords.some((record) => record.folds.length > 0);
  if ((hasEvaluatedHorizon && !COMPLEXITY_DEFINITIONS.includes(complexityDefinition))
      || (!hasEvaluatedHorizon && complexityDefinition !== null)) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 receipt lacks the frozen complexity evidence binding");
  }
  if (stableStringify(receipt.outcome_definitions) !== stableStringify(v3OutcomeDefinitions(complexityDefinition))) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 outcome definitions do not match the frozen target rules");
  }
  const evaluatedComplexityDefinitions = new Set(horizonRecords
    .filter((record) => record.folds.length > 0)
    .map((record) => record.complexity_definition_id));
  if (evaluatedComplexityDefinitions.size > 1
      || [...evaluatedComplexityDefinitions].some((definition) => definition !== complexityDefinition)) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 horizons do not share the declared frozen complexity feature definition");
  }
  const horizonById = new Map(horizonRecords.map((record) => [record.horizon_commits, record]));
  const methodsById = new Map(METHODS.map((method) => [method.method_id, method]));
  const rebuiltForecasts = rebuiltPromotion.validated_selections.map((selection) => {
    const horizon = horizonById.get(selection.horizon_commits);
    const method = methodsById.get(selection.method_id);
    if (!horizon || !method || horizon.folds.length === 0) {
      fail("FAIL-PREDICTIVE-BINDING", "V3 validated selection cannot be bound to its horizon and registry method");
    }
    return {
      target_id: selection.target_id,
      horizon_commits: selection.horizon_commits,
      state: selection.state,
      method_id: selection.method_id,
      method_kind: selection.method_kind,
      claim: "rank-only",
      items: currentRankingFor({
        currentSnapshot,
        complexityDefinition: horizon.complexity_definition_id,
        terminalFold: horizon.folds.at(-1),
        method,
        rankingK: receipt.protocol.ranking_k,
      }),
    };
  });
  if (stableStringify(rebuiltForecasts) !== stableStringify(receipt.current_forecasts)) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 current forecasts do not reproduce as rank-only rows from the bound current snapshot");
  }
  const body = { ...receipt };
  delete body.receipt_sha256;
  const actualDigest = `sha256:${crypto.createHash("sha256").update(stableStringify(body)).digest("hex")}`;
  if (actualDigest !== receipt.receipt_sha256) {
    fail("FAIL-PREDICTIVE-BINDING", "V3 receipt digest does not bind its closed contents");
  }
  if (verifiedV3Receipts.has(receipt)) {
    return deepFreeze(receipt);
  }
  if (!isRecord(replayOwnedReceipt) || !verifiedV3Receipts.has(replayOwnedReceipt)) {
    fail("FAIL-PREDICTIVE-BINDING", "deserialized V3 receipt requires a separate package-branded replay receipt; a raw digest is not provenance");
  }
  if (receipt.receipt_sha256 !== replayOwnedReceipt.receipt_sha256
      || stableStringify(receipt) !== stableStringify(replayOwnedReceipt)) {
    fail("FAIL-PREDICTIVE-BINDING", "deserialized V3 receipt does not equal the replay-owned canonical content and digest");
  }
  return replayOwnedReceipt;
}

function sameSequence(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function rehydrateHistoryStageArtifact(artifact, bundleRoot) {
  const document = parseJsonBytes(artifact.bytes, "history_stage");
  try {
    const stage = statePrivate.createHistoryStage({
      binding: document.binding,
      commits: document.commits,
    });
    const rebuilt = statePrivate.artifactForStage({
      output_root: bundleRoot,
      repository_id: document.binding?.repository_id,
      stage,
    });
    const branded = statePrivate.readStage(stage, "history");
    if (rebuilt.bytes !== artifact.bytes.toString("utf8")
        || branded.artifact_sha256 !== document.artifact_sha256) {
      bundleFail("history_stage is not exact canonical package-branded stage bytes");
    }
    return stage;
  } catch (error) {
    if (error?.code === "FAIL-FORWARD-TEMPORAL-BUNDLE") throw error;
    bundleFail(`history_stage cannot be rehydrated as a package-branded history stage (${error.message})`);
  }
}

function rehydrateCanonicalSnapshotArtifact(artifact, label) {
  const snapshot = parseJsonBytes(artifact.bytes, label);
  try {
    const canonicalArtifact = intelligenceEnginePrivate.canonicalArtifactFromSnapshot(snapshot);
    const state = intelligenceEnginePrivate.readCanonicalArtifact(canonicalArtifact);
    if (state.snapshot_json !== artifact.bytes.toString("utf8")) {
      bundleFail(`${label} is not exact canonical snapshot artifact bytes`);
    }
    return state.snapshot;
  } catch (error) {
    if (error?.code === "FAIL-FORWARD-TEMPORAL-BUNDLE") throw error;
    bundleFail(`${label} cannot be rehydrated as a canonical snapshot (${error.message})`);
  }
}

function receiptRankingK(receipt) {
  if (!isRecord(receipt)
      || receipt.schema_version !== RECEIPT_SCHEMA_VERSION
      || receipt.kind !== "forward-temporal-ranking-evaluation-receipt"
      || !SHA256.test(receipt.receipt_sha256)
      || !isRecord(receipt.protocol)
      || !Number.isSafeInteger(receipt.protocol.ranking_k)
      || receipt.protocol.ranking_k < 1
      || receipt.protocol.ranking_k > 10_000) {
    bundleFail("receipt does not declare a bounded forward-temporal evaluation contract");
  }
  return receipt.protocol.ranking_k;
}

function loadForwardTemporalBundle(input = {}) {
  if (!exactKeys(input, ["bundle_path", "expected_bundle_sha256"]) || typeof input.bundle_path !== "string"
      || input.bundle_path.length === 0 || input.bundle_path.includes("\0") || !path.isAbsolute(input.bundle_path)
      || !SHA256.test(input.expected_bundle_sha256)) {
    bundleFail("bundle_path and expected_bundle_sha256 must be one explicit absolute path and its initial SHA-256 binding");
  }
  const bundleCandidate = path.resolve(input.bundle_path);
  const bundleArtifact = readRegularBundleFile(bundleCandidate, "bundle", MAX_BUNDLE_BYTES);
  if (sha256Bytes(bundleArtifact.bytes) !== input.expected_bundle_sha256) {
    bundleFail("bundle bytes do not match the expected initial input binding");
  }
  const bundleRealPath = bundleArtifact.real_path;
  let bundleRoot;
  try {
    bundleRoot = fs.realpathSync.native(path.dirname(bundleRealPath));
  } catch (error) {
    bundleFail(`bundle directory cannot be resolved (${error.code ?? error.message})`);
  }
  const bundle = parseJsonBytes(bundleArtifact.bytes, "bundle");
  if (!exactKeys(bundle, BUNDLE_KEYS)
      || bundle.schema_version !== BUNDLE_SCHEMA_VERSION
      || bundle.kind !== "forward-temporal-evaluation-bundle"
      || !Array.isArray(bundle.cutoff_snapshots)
      || bundle.cutoff_snapshots.length < MIN_SNAPSHOTS
      || bundle.cutoff_snapshots.length > MAX_CUTOFF_SNAPSHOT_COUNT) {
    bundleFail("bundle must contain only its declared history stage, cutoff snapshots, and receipt references");
  }
  const historyReference = normalizeBundleArtifactReference(bundle.history_stage, "history_stage", MAX_HISTORY_STAGE_BYTES);
  const cutoffReferences = bundle.cutoff_snapshots.map((reference, index) => (
    normalizeBundleArtifactReference(reference, `cutoff_snapshots[${index}]`, MAX_CUTOFF_SNAPSHOT_BYTES)
  ));
  const totalCutoffBytes = cutoffReferences.reduce((sum, reference) => sum + reference.size_bytes, 0);
  if (!Number.isSafeInteger(totalCutoffBytes) || totalCutoffBytes > MAX_CUTOFF_SNAPSHOT_TOTAL_BYTES) {
    bundleFail("cutoff snapshot artifacts exceed the aggregate byte bound");
  }
  const receiptReference = normalizeBundleArtifactReference(bundle.receipt, "receipt", MAX_RECEIPT_BYTES);
  const seenPaths = new Set();
  const seenIdentities = new Set();
  const historyArtifact = readBundleArtifact(
    bundleRoot,
    bundleRealPath,
    historyReference,
    "history_stage",
    MAX_HISTORY_STAGE_BYTES,
    seenPaths,
    seenIdentities,
  );
  const snapshotArtifacts = cutoffReferences.map((reference, index) => readBundleArtifact(
    bundleRoot,
    bundleRealPath,
    reference,
    `cutoff_snapshots[${index}]`,
    MAX_CUTOFF_SNAPSHOT_BYTES,
    seenPaths,
    seenIdentities,
  ));
  const receiptArtifact = readBundleArtifact(
    bundleRoot,
    bundleRealPath,
    receiptReference,
    "receipt",
    MAX_RECEIPT_BYTES,
    seenPaths,
    seenIdentities,
  );

  const historyStage = rehydrateHistoryStageArtifact(historyArtifact, bundleRoot);
  const snapshots = snapshotArtifacts.map((artifact, index) => (
    rehydrateCanonicalSnapshotArtifact(artifact, `cutoff_snapshots[${index}]`)
  ));
  const suppliedReceipt = parseJsonBytes(receiptArtifact.bytes, "receipt");
  const rankingK = receiptRankingK(suppliedReceipt);
  let receipt;
  try {
    receipt = evaluateForwardTemporal({
      schema_version: INPUT_SCHEMA_VERSION,
      history_stage: historyStage,
      snapshots,
      ranking_k: rankingK,
    });
  } catch (error) {
    bundleFail(`bundle artifacts cannot establish a forward-temporal evaluation (${error.message})`);
  }
  const canonicalReceiptBytes = canonicalPrettyJson(receipt);
  if (receiptArtifact.bytes.toString("utf8") !== canonicalReceiptBytes
      || stableStringify(suppliedReceipt) !== stableStringify(receipt)
      || suppliedReceipt.receipt_sha256 !== receipt.receipt_sha256) {
    bundleFail("receipt does not exactly equal the independently re-evaluated bundle artifacts");
  }
  const finalSnapshot = snapshots.at(-1);
  const binding = Object.freeze({});
  forwardTemporalBundleState.set(binding, Object.freeze({
    bundle_sha256: sha256Bytes(bundleArtifact.bytes),
    receipt,
    final_snapshot: Object.freeze({
      snapshot_id: finalSnapshot.snapshot_id,
      repository_id: finalSnapshot.repository.repository_id,
      repository_revision: finalSnapshot.repository.revision,
      configuration_hash: finalSnapshot.repository.configuration_hash,
    }),
  }));
  return binding;
}

function boundForwardTemporalState(binding) {
  const state = forwardTemporalBundleState.get(binding);
  if (!state) bundleFail("forward-temporal report binding is not package-branded");
  return state;
}

function assertBoundCurrentSnapshot(binding, snapshot) {
  const state = boundForwardTemporalState(binding);
  const finalSnapshot = state.final_snapshot;
  if (snapshot?.snapshot_id !== finalSnapshot.snapshot_id
      || snapshot?.repository?.repository_id !== finalSnapshot.repository_id
      || snapshot?.repository?.revision !== finalSnapshot.repository_revision
      || snapshot?.repository?.configuration_hash !== finalSnapshot.configuration_hash) {
    bundleFail("forward-temporal receipt final cutoff does not bind the current canonical snapshot, repository revision, and configuration");
  }
  return state;
}

function rounded(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1_000_000) / 1_000_000
    : null;
}

function compactForwardTemporalMethod(method) {
  const comparison = method?.comparison_to_sei?.metric === "mean_average_precision"
    ? method.comparison_to_sei
    : { result: "unavailable", delta: null, contributing_fold_count: 0 };
  return Object.freeze({
    method_id: method.method_id,
    method_kind: method.method_kind,
    mean_average_precision: rounded(method.mean_average_precision),
    mean_lift_at_k: rounded(method.mean_lift_at_k),
    mean_spearman_rank_correlation: rounded(method.mean_spearman_rank_correlation),
    average_precision_availability: method.metric_availability?.mean_average_precision ?? "unavailable",
    comparison_to_composite: Object.freeze({
      result: comparison.result,
      delta: rounded(comparison.delta),
      contributing_fold_count: comparison.contributing_fold_count,
    }),
  });
}

function projectBoundForwardTemporalEvaluation(binding, snapshot) {
  const state = assertBoundCurrentSnapshot(binding, snapshot);
  if (state.receipt === null) {
    return deepFreeze({
      state: "not-established",
      reason: state.readiness.reason,
      forecast_state: "readiness",
      forward_fold_count: 0,
      selected_methods: [],
      current_rankings: [],
      outcomes: [],
    });
  }
  const receipt = state.receipt;
  if (receipt.schema_version === AUTO_RECEIPT_SCHEMA_VERSION) {
    const outcomes = receipt.promotions.map((promotion) => Object.freeze({
      outcome_id: promotion.target_id,
      horizon_commits: promotion.horizon_commits,
      state: promotion.state,
      nomination: promotion.nomination,
      terminal_holdout: promotion.terminal_holdout,
      selected_method: promotion.selected_method,
      forecast_eligible: promotion.forecast_eligible,
    }));
    return deepFreeze({
      state: receipt.public_state,
      reason: receipt.reason ?? "terminal-holdout promotion was evaluated from bound canonical evidence",
      receipt_sha256: receipt.receipt_sha256,
      bundle_sha256: state.bundle_sha256,
      ranking_k: receipt.protocol.ranking_k,
      forward_fold_count: receipt.readiness.state === "READY" ? 4 : 0,
      interpretation_boundary: receipt.interpretation_boundary,
      outcomes,
      forecast_state: state.forecast_state,
      selected_methods: state.selected_methods,
      current_rankings: state.current_rankings,
    });
  }
  const outcomes = receipt.evaluation.map((outcome) => Object.freeze({
    outcome_id: outcome.outcome_id,
    state: outcome.status,
    fold_count: outcome.fold_count,
    evaluated_fold_count: outcome.evaluated_fold_count,
    methods: Object.freeze(outcome.methods.map(compactForwardTemporalMethod)),
  }));
  return deepFreeze({
    state: receipt.status === "evaluated" ? "evaluated" : receipt.status.replaceAll("_", "-"),
    reason: receipt.reason ?? "independently re-evaluated from package-branded history and canonical cutoff snapshots",
    receipt_sha256: receipt.receipt_sha256,
    bundle_sha256: state.bundle_sha256,
    ranking_k: receipt.protocol.ranking_k,
    forward_fold_count: receipt.folds.length,
    interpretation_boundary: receipt.interpretation_boundary,
    outcomes,
    forecast_state: state.forecast_state ?? "historical-only",
    selected_methods: state.selected_methods ?? [],
    current_rankings: state.current_rankings ?? [],
  });
}

function isAutomaticReadinessBinding(binding) {
  const state = boundForwardTemporalState(binding);
  return state.receipt === null && state.forecast_state === "readiness";
}

function bindAutomaticEvaluation({ receipt, current_snapshot, current_rankings = [], selected_methods = [], cache_status = "miss" } = {}) {
  if (!isRecord(receipt) || ![RECEIPT_SCHEMA_VERSION, AUTO_RECEIPT_SCHEMA_VERSION].includes(receipt.schema_version)
      || !isRecord(current_snapshot) || typeof current_snapshot.snapshot_id !== "string"
      || !isRecord(current_snapshot.repository)) {
    fail("FAIL-FORWARD-TEMPORAL-BINDING", "automatic evaluation binding is malformed");
  }
  let boundReceipt = receipt;
  let boundRankings = current_rankings;
  let boundSelections = selected_methods;
  if (receipt.schema_version === AUTO_RECEIPT_SCHEMA_VERSION) {
    boundReceipt = verifyV3Receipt(receipt, current_snapshot);
    if (stableStringify(selected_methods) !== stableStringify(boundReceipt.validated_selections)
        || stableStringify(current_rankings) !== stableStringify(boundReceipt.current_forecasts)) {
      fail("FAIL-PREDICTIVE-BINDING", "caller-supplied selections or rankings contradict the verified V3 receipt");
    }
    boundRankings = boundReceipt.current_forecasts;
    boundSelections = boundReceipt.validated_selections;
  }
  const binding = Object.freeze({});
  const body = {
    receipt_sha256: boundReceipt.receipt_sha256,
    current_snapshot_id: current_snapshot.snapshot_id,
    repository_id: current_snapshot.repository.repository_id,
    repository_revision: current_snapshot.repository.revision,
    configuration_hash: current_snapshot.repository.configuration_hash,
    current_rankings: boundRankings,
    selected_methods: boundSelections,
  };
  const bundle_sha256 = `sha256:${crypto.createHash("sha256").update(stableStringify(body)).digest("hex")}`;
  forwardTemporalBundleState.set(binding, Object.freeze({
    bundle_sha256,
    receipt: boundReceipt,
    final_snapshot: Object.freeze({
      snapshot_id: current_snapshot.snapshot_id,
      repository_id: current_snapshot.repository.repository_id,
      repository_revision: current_snapshot.repository.revision,
      configuration_hash: current_snapshot.repository.configuration_hash,
    }),
    current_rankings: deepFreeze(boundRankings),
    selected_methods: deepFreeze(boundSelections),
    forecast_state: boundReceipt.schema_version === AUTO_RECEIPT_SCHEMA_VERSION
      ? boundRankings.length > 0 ? "terminally-validated" : "no-current-forecast"
      : boundRankings.length > 0 ? "useful-signal" : "no-useful-signal",
    cache_status,
  }));
  return binding;
}

function bindAutomaticReadiness({ current_snapshot, reason, available_snapshot_count = 0, cache_status = "miss" } = {}) {
  if (!isRecord(current_snapshot) || typeof current_snapshot.snapshot_id !== "string"
      || !isRecord(current_snapshot.repository) || typeof reason !== "string" || reason.length === 0
      || !Number.isSafeInteger(available_snapshot_count) || available_snapshot_count < 0) {
    fail("FAIL-FORWARD-TEMPORAL-BINDING", "automatic readiness binding is malformed");
  }
  const binding = Object.freeze({});
  forwardTemporalBundleState.set(binding, Object.freeze({
    bundle_sha256: null,
    receipt: null,
    final_snapshot: Object.freeze({
      snapshot_id: current_snapshot.snapshot_id,
      repository_id: current_snapshot.repository.repository_id,
      repository_revision: current_snapshot.repository.revision,
      configuration_hash: current_snapshot.repository.configuration_hash,
    }),
    current_rankings: Object.freeze([]),
    selected_methods: Object.freeze([]),
    forecast_state: "readiness",
    cache_status,
    readiness: Object.freeze({ reason, available_snapshot_count, cache_status }),
  }));
  return binding;
}

function baselineComparisonSummary(outcome) {
  const counts = {
    baseline_count: 0,
    baseline_better_count: 0,
    composite_better_count: 0,
    tied_count: 0,
    unavailable_count: 0,
  };
  for (const method of outcome.methods ?? []) {
    if (method?.method_kind !== "simple-baseline") continue;
    counts.baseline_count += 1;
    const result = method.comparison_to_sei?.result;
    if (result === "better") counts.baseline_better_count += 1;
    else if (result === "worse") counts.composite_better_count += 1;
    else if (result === "equal") counts.tied_count += 1;
    else counts.unavailable_count += 1;
  }
  return counts;
}

// This summary deliberately does not require the report snapshot to be the
// bundle's final cutoff.  It is used only through the package-private report
// path to distinguish a verified historical evaluation from an evaluation of
// the current snapshot.  The WeakMap brand remains the authority for every
// field below; callers cannot supply this summary directly to report
// projection.
function projectBoundForwardTemporalReceiptSummary(binding) {
  const state = boundForwardTemporalState(binding);
  if (state.receipt === null) return null;
  const receipt = state.receipt;
  if (receipt.schema_version === AUTO_RECEIPT_SCHEMA_VERSION) {
    const forecastsByCell = new Map(receipt.current_forecasts.map((forecast) => [
      `${forecast.target_id}\0${forecast.horizon_commits}`,
      forecast,
    ]));
    return deepFreeze({
      schema_version: "sei.predictive-status-receipt@2",
      source_schema_version: AUTO_RECEIPT_SCHEMA_VERSION,
      repository_id: receipt.repository.repository_id,
      final_revision: receipt.final_snapshot_binding.repository_revision,
      final_snapshot_id: receipt.final_snapshot_binding.snapshot_id,
      configuration_hash: receipt.repository.configuration_hash,
      horizon_cutoff_snapshot_ids: receipt.horizons.map((horizon) => ({
        horizon_commits: horizon.horizon_commits,
        cutoff_snapshot_ids: horizon.cutoff_snapshot_bindings.map((entry) => entry.snapshot_id),
      })),
      development_fold_count: receipt.protocol.development_fold_count,
      terminal_holdout_fold_count: receipt.protocol.terminal_holdout_fold_count,
      promotions: receipt.promotions.map((promotion) => {
        const forecast = forecastsByCell.get(`${promotion.target_id}\0${promotion.horizon_commits}`) ?? null;
        return {
          target_id: promotion.target_id,
          horizon_commits: promotion.horizon_commits,
          state: promotion.state,
          selected_method_id: promotion.selected_method?.method_id ?? null,
          selected_method_kind: promotion.selected_method?.method_kind ?? null,
          terminal_state: promotion.terminal_holdout.state,
          forecast_item_count: forecast?.items.length ?? 0,
        };
      }),
      receipt_sha256: receipt.receipt_sha256,
    });
  }
  return deepFreeze({
    repository_id: receipt.repository.repository_id,
    final_revision: state.final_snapshot.repository_revision,
    configuration_hash: receipt.repository.configuration_hash,
    cutoff_snapshot_ids: receipt.snapshot_bindings.map((entry) => entry.snapshot_id),
    forward_fold_count: receipt.folds.length,
    outcomes: receipt.evaluation.map((outcome) => ({
      outcome_id: outcome.outcome_id,
      state: outcome.status.replaceAll("_", "-"),
      evaluated_fold_count: outcome.evaluated_fold_count,
      baseline_vs_composite: baselineComparisonSummary(outcome),
    })),
    receipt_sha256: receipt.receipt_sha256,
  });
}

module.exports = { evaluateForwardTemporal };
Object.defineProperty(module.exports, Symbol.for("sei.forward-temporal-evaluator.private.v1"), {
  value: Object.freeze({
    assertBoundCurrentSnapshot,
    loadForwardTemporalBundle,
    projectBoundForwardTemporalReceiptSummary,
    projectBoundForwardTemporalEvaluation,
    bindAutomaticEvaluation,
    bindAutomaticReadiness,
    isAutomaticReadinessBinding,
    AUTO_RECEIPT_SCHEMA_VERSION,
    RECEIPT_SCHEMA_VERSION,
    observationsForSnapshot,
    selectComplexityDefinition,
    normalizers,
    methodScore,
    rankingMetrics,
    materializeV3TerminalAfterDevelopment,
    verifyV3Receipt,
    METHODS,
    EVALUATED_OUTCOMES,
  }),
});
