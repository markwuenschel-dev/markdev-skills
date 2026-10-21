"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const intelligenceEngine = require("./intelligence-engine.js");
const incrementalState = require("./incremental-run-state.js");
const forwardTemporal = require("./forward-temporal-evaluator.js");
const predictiveArtifactStore = require("./predictive-artifact-store.js");
const predictivePromotion = require("./predictive-promotion.js");

const enginePrivate = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")];
const statePrivate = incrementalState[Symbol.for("sei.incremental-run-state.private.v2")];
const forwardPrivate = forwardTemporal[Symbol.for("sei.forward-temporal-evaluator.private.v1")];
const artifactStorePrivate = predictiveArtifactStore[Symbol.for("sei.predictive-artifact-store.private.v1")];
const promotionPrivate = predictivePromotion[Symbol.for("sei.predictive-promotion.private.v1")];

const AUTO_SCHEMA_VERSION = "sei.forward-temporal-auto@1";
const HORIZON_COMMITS = 10;
const REQUIRED_CUTOFFS = 5;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_CUTOFF_BUILD_MS = 180_000;
const V3_INPUT_SCHEMA_VERSION = "sei.forward-temporal-evaluation-input@2";
const DEFAULT_RANKING_K = 10;
const HISTORY_LABEL = "history-stage";
const CURRENT_SNAPSHOT_LABEL = "current-snapshot";
const RECEIPT_LABEL = "v3-receipt";
const PREDICTIVE_SEI_VERSION = "sei.predictive-orchestration@9";
const FEATURE_SCHEMA_VERSION = "sei.forward-temporal-features@3";

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

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("FAIL-PREDICTIVE-AUTO: execution was cancelled");
}

function historyDocument(historyStage) {
  try {
    return statePrivate.readStage(historyStage, "history");
  } catch (error) {
    throw new Error(`FAIL-PREDICTIVE-AUTO: history stage is not package-branded (${error.message})`);
  }
}

function cutoffRevisions(history, current_snapshot) {
  const commitIndex = new Map(history.commits.map((commit, index) => [commit.revision, index]));
  const currentIndex = commitIndex.get(current_snapshot?.repository?.revision);
  if (!Number.isSafeInteger(currentIndex)) return [];
  return Array.from({ length: REQUIRED_CUTOFFS - 1 }, (_, offset) => {
    const index = currentIndex - HORIZON_COMMITS * (offset + 1);
    return index >= 0 ? history.commits[index]?.revision ?? null : null;
  }).filter(Boolean);
}

function buildCutoffSnapshots({ repository_root, config_path, python_executable, history, current_snapshot, candidates, required_revisions = null, signal }) {
  if (typeof repository_root !== "string" || !path.isAbsolute(repository_root)
      || (config_path !== null && (typeof config_path !== "string" || !path.isAbsolute(config_path)))) return [];
  const existing = new Set(candidates.map((candidate) => candidate.snapshot?.repository?.revision).filter(Boolean));
  const required = (required_revisions === null ? cutoffRevisions(history, current_snapshot) : required_revisions)
    .filter((revision) => !existing.has(revision));
  if (required.length === 0) return [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-cutoffs-"));
  const cloneRoot = path.join(tempRoot, "repo");
  const runnerPath = path.resolve(__dirname, "../../software-engineering-intelligence/scripts/run-sei.js");
  const built = [];
  try {
    checkSignal(signal);
    const clone = childProcess.spawnSync("git", ["clone", "--quiet", "--no-hardlinks", repository_root, cloneRoot], {
      encoding: "utf8", windowsHide: true, timeout: MAX_CUTOFF_BUILD_MS,
    });
    if (clone.status !== 0) throw new Error(`git clone failed: ${String(clone.stderr || clone.error?.message || "unknown error").trim().slice(0, 500)}`);
    // A local-path clone rewrites origin.url to the temporary checkout path.
    // Repository identity is origin-bound, so preserve every source origin
    // before running a cutoff; otherwise the cutoff snapshot cannot bind to
    // the current canonical repository even though revision/configuration are
    // identical.
    const sourceOrigins = childProcess.spawnSync("git", ["-c", `safe.directory=${repository_root}`, "-C", repository_root, "config", "--get-all", "remote.origin.url"], {
      encoding: "utf8", windowsHide: true, timeout: MAX_CUTOFF_BUILD_MS,
    });
    if (sourceOrigins.status === 0) {
      const origins = String(sourceOrigins.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (origins.length > 0) {
        const clearOrigins = childProcess.spawnSync("git", ["-C", cloneRoot, "config", "--unset-all", "remote.origin.url"], {
          encoding: "utf8", windowsHide: true, timeout: MAX_CUTOFF_BUILD_MS,
        });
        if (clearOrigins.status !== 0) throw new Error(`clone origin reset failed: ${String(clearOrigins.stderr || clearOrigins.error?.message || "unknown error").trim().slice(0, 500)}`);
        for (const origin of origins) {
          const addOrigin = childProcess.spawnSync("git", ["-C", cloneRoot, "config", "--add", "remote.origin.url", origin], {
            encoding: "utf8", windowsHide: true, timeout: MAX_CUTOFF_BUILD_MS,
          });
          if (addOrigin.status !== 0) throw new Error(`clone origin binding failed: ${String(addOrigin.stderr || addOrigin.error?.message || "unknown error").trim().slice(0, 500)}`);
        }
      }
    }
    for (const [index, revision] of required.entries()) {
      checkSignal(signal);
      const checkout = childProcess.spawnSync("git", ["-C", cloneRoot, "checkout", "--quiet", "--detach", revision], {
        encoding: "utf8", windowsHide: true, timeout: MAX_CUTOFF_BUILD_MS,
      });
      if (checkout.status !== 0) throw new Error(`checkout ${revision} failed: ${String(checkout.stderr || checkout.error?.message || "unknown error").trim().slice(0, 500)}`);
      const outputRoot = path.join(tempRoot, `run-${index}`);
      const args = [runnerPath, "--repo", cloneRoot, "--out", outputRoot];
      if (config_path !== null) args.push("--config", config_path);
      args.push("--incremental", "off", "--predictive", "off", "--evidence-only");
      if (typeof python_executable === "string" && python_executable.length > 0) args.push("--python", python_executable);
      const run = childProcess.spawnSync(process.execPath, args, {
        encoding: "utf8", windowsHide: true, timeout: MAX_CUTOFF_BUILD_MS,
        env: { ...process.env, SEI_INCREMENTAL_STATE_ROOT: path.join(tempRoot, "state") },
      });
      if (run.status !== 0) throw new Error(`cutoff ${revision} assessment failed: ${String(run.stderr || run.error?.message || run.stdout || "unknown error").trim().slice(0, 700)}`);
      const lines = String(run.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
      const receipt = JSON.parse(lines.at(-1) ?? "{}");
      if (typeof receipt.snapshot_path !== "string" || !path.isAbsolute(receipt.snapshot_path)) throw new Error(`cutoff ${revision} did not publish a snapshot path`);
      const bytes = fs.readFileSync(receipt.snapshot_path);
      const snapshot = JSON.parse(bytes.toString("utf8"));
      const canonical = enginePrivate.canonicalArtifactFromSnapshot(snapshot);
      if (enginePrivate.readCanonicalArtifact(canonical).snapshot_json !== bytes.toString("utf8")) throw new Error(`cutoff ${revision} snapshot bytes are not canonical`);
      if (snapshot.repository?.revision !== revision
          || snapshot.repository?.repository_id !== current_snapshot.repository.repository_id
          || snapshot.repository?.configuration_hash !== current_snapshot.repository.configuration_hash) {
        throw new Error(`cutoff ${revision} snapshot binding does not match the current repository/configuration`);
      }
      built.push({ snapshot, bytes: bytes.toString("utf8"), sha256: sha256(bytes), path: receipt.snapshot_path });
    }
    return built;
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* readiness remains fail-closed */ }
  }
}

function canonicalSnapshotBytes(snapshot) {
  try {
    const artifact = enginePrivate.canonicalArtifactFromSnapshot(snapshot);
    return enginePrivate.readCanonicalArtifact(artifact).snapshot_json;
  } catch (error) {
    throw new Error("FAIL-PREDICTIVE-BINDING: snapshot is not exact canonical evidence (" + error.message + ")");
  }
}

function stageArtifactBytes({ output_root, state_root, repository_id, stage }) {
  try {
    const artifact = statePrivate.artifactForStage({ output_root, state_root, repository_id, stage });
    return Buffer.from(artifact.bytes).toString("utf8");
  } catch (error) {
    throw new Error("FAIL-PREDICTIVE-BINDING: history stage cannot be serialized as exact package bytes (" + error.message + ")");
  }
}

function cutoffObjectLabel(revision) {
  return "cutoff-snapshot:" + revision;
}

function createV3CutoffPlan(history, currentSnapshot) {
  const currentRevision = currentSnapshot?.repository?.revision;
  const commitIndex = new Map((history?.commits ?? []).map((commit, index) => [commit.revision, index]));
  const currentIndex = commitIndex.get(currentRevision);
  if (!Number.isSafeInteger(currentIndex) || currentRevision !== history?.binding?.history_end) {
    return {
      status: "not-ready",
      available_snapshot_count: 0,
      reason: "current canonical snapshot is not the strict end of the package-branded history stage",
    };
  }
  if (currentSnapshot?.repository?.repository_id !== history.binding.repository_id
      || currentSnapshot?.repository?.configuration_hash !== history.binding.configuration_hash) {
    return {
      status: "not-ready",
      available_snapshot_count: 0,
      reason: "current canonical snapshot repository or configuration does not match the package-branded history stage",
    };
  }
  const horizons = promotionPrivate.HORIZON_COMMITS.map((horizon_commits) => {
    const revisions = Array.from(
      { length: promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT },
      (_, position) => currentIndex - (promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT - 1 - position) * (horizon_commits + 1),
    ).filter((index) => index >= 0).map((index) => history.commits[index]?.revision).filter(Boolean);
    return { horizon_commits, revisions };
  });
  const availableSnapshotCount = Math.min(...horizons.map((horizon) => horizon.revisions.length));
  if (horizons.some((horizon) => horizon.revisions.length < promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT)) {
    return {
      status: "not-ready",
      available_snapshot_count: availableSnapshotCount,
      reason: "automatic prediction needs " + promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT
        + " canonical cutoff snapshots for every " + promotionPrivate.HORIZON_COMMITS.join(", ")
        + " eligible-commit horizon",
    };
  }
  const current = new Set([currentRevision]);
  return {
    status: "ready",
    available_snapshot_count: availableSnapshotCount,
    horizons,
    unique_historical_revisions: [...new Set(horizons.flatMap((horizon) => horizon.revisions)
      .filter((revision) => !current.has(revision)))],
  };
}

function predictiveLineage(history) {
  const root = {
    repository_id: history.binding.repository_id,
    history_start_revision: history.binding.history_start,
    first_observed_revision: history.commits[0]?.revision ?? null,
  };
  const rootHistoryDigest = sha256(Buffer.from(stableStringify(root), "utf8"));
  return {
    repository_lineage_id: "lineage:" + rootHistoryDigest.slice("sha256:".length),
    root_history_digest: rootHistoryDigest,
    remote_urls: [],
  };
}

function predictiveArtifactBinding({
  history,
  plan,
  currentSnapshot,
  currentSnapshotDigest,
  historyStageDigest,
  configuration_hash,
  ranking_k,
}) {
  const lineage = predictiveLineage(history);
  const cutoffPlanDigest = sha256(Buffer.from(stableStringify({
    horizons: plan.horizons,
    minimum_cutoff_snapshot_count: promotionPrivate.MINIMUM_CUTOFF_SNAPSHOT_COUNT,
    cutoff_selection_rule: promotionPrivate.CUTOFF_SELECTION_RULE,
  }), "utf8"));
  const predictiveConfigDigest = sha256(Buffer.from(stableStringify({
    configuration_hash,
    ranking_k,
    horizons: promotionPrivate.HORIZON_COMMITS,
    evaluation_protocol_version: promotionPrivate.EVALUATION_PROTOCOL_VERSION,
    target_schema_version: promotionPrivate.TARGET_SCHEMA_VERSION,
    candidate_registry_version: promotionPrivate.CANDIDATE_REGISTRY_VERSION,
  }), "utf8"));
  return {
    lineage,
    binding: {
      repository_lineage_id: lineage.repository_lineage_id,
      revision_id: currentSnapshot.repository.revision,
      evidence_snapshot_digest: currentSnapshotDigest,
      bound_artifact_digests: {
        "current-snapshot": currentSnapshotDigest,
        "cutoff-plan": cutoffPlanDigest,
        "history-stage": historyStageDigest,
      },
      sei_version: PREDICTIVE_SEI_VERSION,
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      target_schema_version: promotionPrivate.TARGET_SCHEMA_VERSION,
      candidate_registry_version: promotionPrivate.CANDIDATE_REGISTRY_VERSION,
      evaluation_protocol_version: promotionPrivate.EVALUATION_PROTOCOL_VERSION,
      predictive_config_digest: predictiveConfigDigest,
    },
  };
}

function resolvePromotionStore({ artifact_store, state_root, repository_id, lineage, lease, signal }) {
  if (artifact_store !== undefined && artifact_store !== null) {
    if (!isRecord(artifact_store) || typeof artifact_store.readPromotion !== "function"
        || typeof artifact_store.publishPromotion !== "function") {
      throw new Error("FAIL-PREDICTIVE-BINDING: injected predictive artifact store is invalid");
    }
    return artifact_store;
  }
  if (typeof state_root !== "string" || !path.isAbsolute(state_root) || lease === null || lease === undefined) return null;
  return artifactStorePrivate.openPredictiveArtifactStore({
    stateRoot: state_root,
    repositoryBinding: { repository_id },
    lineage,
    lease,
    signal,
  });
}

function parseCanonicalSnapshot(bytes, label) {
  if (typeof bytes !== "string" || bytes.length === 0 || Buffer.byteLength(bytes) > MAX_SNAPSHOT_BYTES) {
    throw new Error("FAIL-PREDICTIVE-OBJECT: " + label + " is not a bounded UTF-8 object");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(bytes);
  } catch {
    throw new Error("FAIL-PREDICTIVE-OBJECT: " + label + " is not JSON");
  }
  if (canonicalSnapshotBytes(snapshot) !== bytes) {
    throw new Error("FAIL-PREDICTIVE-BINDING: " + label + " is not exact canonical snapshot bytes");
  }
  return snapshot;
}

function parseHistoryStage(bytes, context) {
  if (typeof bytes !== "string" || bytes.length === 0 || Buffer.byteLength(bytes) > MAX_SNAPSHOT_BYTES) {
    throw new Error("FAIL-PREDICTIVE-OBJECT: history-stage is not a bounded UTF-8 object");
  }
  let document;
  try {
    document = JSON.parse(bytes);
  } catch {
    throw new Error("FAIL-PREDICTIVE-OBJECT: history-stage is not JSON");
  }
  let stage;
  try {
    stage = statePrivate.createHistoryStage({ binding: document.binding, commits: document.commits });
  } catch (error) {
    throw new Error("FAIL-PREDICTIVE-BINDING: history-stage cannot be rehydrated as package evidence (" + error.message + ")");
  }
  if (stageArtifactBytes({ ...context, stage }) !== bytes) {
    throw new Error("FAIL-PREDICTIVE-BINDING: history-stage is not exact canonical package bytes");
  }
  return stage;
}

function sameSnapshotBinding(snapshot, currentSnapshot) {
  return snapshot?.snapshot_id === currentSnapshot?.snapshot_id
    && snapshot?.repository?.repository_id === currentSnapshot?.repository?.repository_id
    && snapshot?.repository?.revision === currentSnapshot?.repository?.revision
    && snapshot?.repository?.configuration_hash === currentSnapshot?.repository?.configuration_hash;
}

function promotionObjectMap(hit, expectedLabels) {
  if (!isRecord(hit) || !Array.isArray(hit.objects)) {
    throw new Error("FAIL-PREDICTIVE-OBJECT: predictive store hit is not a package-owned object collection");
  }
  const expected = new Set(expectedLabels);
  if (hit.objects.length !== expected.size) {
    throw new Error("FAIL-PREDICTIVE-OBJECT: predictive store hit has an unexpected object count");
  }
  const objects = new Map();
  const objectDigests = new Set();
  for (const object of hit.objects) {
    const byteCount = typeof object?.bytes === "string" ? Buffer.byteLength(object.bytes) : 0;
    const byteDigest = typeof object?.bytes === "string" ? sha256(Buffer.from(object.bytes, "utf8")) : null;
    if (!isRecord(object) || typeof object.label !== "string" || typeof object.bytes !== "string"
        || !expected.has(object.label) || objects.has(object.label)
        || object.bytes.length === 0 || byteCount > MAX_SNAPSHOT_BYTES
        || !Number.isSafeInteger(object.size) || object.size !== byteCount
        || object.digest !== byteDigest) {
      throw new Error("FAIL-PREDICTIVE-OBJECT: predictive store hit contains an unbound or malformed object");
    }
    if (objectDigests.has(byteDigest)) {
      throw new Error("FAIL-PREDICTIVE-OBJECT: predictive store hit objects are aliased");
    }
    objects.set(object.label, object.bytes);
    objectDigests.add(byteDigest);
  }
  if ([...expected].some((label) => !objects.has(label))) {
    throw new Error("FAIL-PREDICTIVE-OBJECT: predictive store hit omitted a required bound object");
  }
  return objects;
}

function rehydrateV3Promotion({ hit, historyBytes, currentBytes, currentSnapshot, plan, context, ranking_k, signal }) {
  const expectedLabels = [
    HISTORY_LABEL,
    CURRENT_SNAPSHOT_LABEL,
    RECEIPT_LABEL,
    ...plan.unique_historical_revisions.map(cutoffObjectLabel),
  ];
  const objects = promotionObjectMap(hit, expectedLabels);
  if (objects.get(HISTORY_LABEL) !== historyBytes) {
    throw new Error("FAIL-PREDICTIVE-BINDING: promotion history-stage does not equal current package-branded history evidence");
  }
  if (objects.get(CURRENT_SNAPSHOT_LABEL) !== currentBytes) {
    throw new Error("FAIL-PREDICTIVE-STALE: promotion current-snapshot does not equal current canonical evidence bytes");
  }
  const rehydratedHistory = parseHistoryStage(objects.get(HISTORY_LABEL), context);
  const storedCurrentSnapshot = parseCanonicalSnapshot(objects.get(CURRENT_SNAPSHOT_LABEL), CURRENT_SNAPSHOT_LABEL);
  if (!sameSnapshotBinding(storedCurrentSnapshot, currentSnapshot)) {
    throw new Error("FAIL-PREDICTIVE-STALE: promotion current-snapshot binding diverged from requested repository revision or configuration");
  }
  const snapshotsByRevision = new Map([[storedCurrentSnapshot.repository.revision, storedCurrentSnapshot]]);
  for (const revision of plan.unique_historical_revisions) {
    const label = cutoffObjectLabel(revision);
    const snapshot = parseCanonicalSnapshot(objects.get(label), label);
    if (snapshot.repository?.revision !== revision
        || snapshot.repository?.repository_id !== currentSnapshot.repository.repository_id
        || snapshot.repository?.configuration_hash !== currentSnapshot.repository.configuration_hash
        || snapshotsByRevision.has(revision)) {
      throw new Error("FAIL-PREDICTIVE-STALE: " + label + " does not bind one exact non-aliased cutoff repository revision");
    }
    snapshotsByRevision.set(revision, snapshot);
  }
  const replayReceipt = forwardTemporal.evaluateForwardTemporal({
    schema_version: V3_INPUT_SCHEMA_VERSION,
    history_stage: rehydratedHistory,
    horizons: plan.horizons.map(({ horizon_commits, revisions }) => ({
      horizon_commits,
      snapshots: revisions.map((revision) => {
        const snapshot = snapshotsByRevision.get(revision);
        if (!snapshot) throw new Error("FAIL-PREDICTIVE-OBJECT: promotion omitted selected cutoff " + revision);
        return snapshot;
      }),
    })),
    ranking_k,
  });
  checkSignal(signal);
  const receiptBytes = objects.get(RECEIPT_LABEL);
  let serializedReceipt;
  try {
    serializedReceipt = JSON.parse(receiptBytes);
  } catch {
    throw new Error("FAIL-PREDICTIVE-OBJECT: promotion receipt is not JSON");
  }
  if (JSON.stringify(serializedReceipt) !== receiptBytes) {
    throw new Error("FAIL-PREDICTIVE-BINDING: promotion receipt does not use exact canonical serialization");
  }
  const verifiedReceipt = forwardPrivate.verifyV3Receipt(serializedReceipt, currentSnapshot, replayReceipt);
  checkSignal(signal);
  return {
    receipt: verifiedReceipt,
    selected_methods: verifiedReceipt.validated_selections,
    current_rankings: verifiedReceipt.current_forecasts,
  };
}

function normalizeBuiltCutoffs(built, expectedRevisions, currentSnapshot) {
  if (!Array.isArray(built) || built.length !== expectedRevisions.length) {
    throw new Error("FAIL-PREDICTIVE-READINESS: required cutoff builder did not return every exact planned cutoff");
  }
  const expected = new Set(expectedRevisions);
  const cutoffs = new Map();
  for (const candidate of built) {
    if (!isRecord(candidate) || !isRecord(candidate.snapshot)) {
      throw new Error("FAIL-PREDICTIVE-READINESS: required cutoff builder returned an invalid candidate");
    }
    const bytes = candidate.bytes === undefined ? canonicalSnapshotBytes(candidate.snapshot) : candidate.bytes;
    const snapshot = parseCanonicalSnapshot(bytes, "required cutoff candidate");
    const revision = snapshot.repository?.revision;
    if (!expected.has(revision) || cutoffs.has(revision)
        || snapshot.repository?.repository_id !== currentSnapshot.repository.repository_id
        || snapshot.repository?.configuration_hash !== currentSnapshot.repository.configuration_hash) {
      throw new Error("FAIL-PREDICTIVE-STALE: required cutoff builder returned a divergent, duplicate, or stale candidate");
    }
    cutoffs.set(revision, { snapshot, bytes });
  }
  if ([...expected].some((revision) => !cutoffs.has(revision))) {
    throw new Error("FAIL-PREDICTIVE-READINESS: required cutoff builder omitted a planned cutoff revision");
  }
  return cutoffs;
}

function promotionObjects({ historyBytes, currentBytes, plan, cutoffs, receipt }) {
  const objects = [
    { label: HISTORY_LABEL, bytes: historyBytes },
    { label: CURRENT_SNAPSHOT_LABEL, bytes: currentBytes },
    ...plan.unique_historical_revisions.map((revision) => ({
      label: cutoffObjectLabel(revision),
      bytes: cutoffs.get(revision).bytes,
    })),
    { label: RECEIPT_LABEL, bytes: JSON.stringify(receipt) },
  ];
  if (objects.some((object) => typeof object.bytes !== "string" || object.bytes.length === 0)
      || new Set(objects.map((object) => object.label)).size !== objects.length) {
    throw new Error("FAIL-PREDICTIVE-BINDING: required predictive publication objects are not closed and non-aliased");
  }
  return objects;
}

function predictiveTelemetry({ promotion_read_count = 0, cutoff_construction_count = 0, promotion_publication_count = 0 } = {}) {
  return deepFreeze({ promotion_read_count, cutoff_construction_count, promotion_publication_count });
}

function readinessResult({ current_snapshot, reason, available_snapshot_count = 0, cache_status = "miss", telemetry = predictiveTelemetry(), signal = null }) {
  checkSignal(signal);
  const binding = forwardPrivate.bindAutomaticReadiness({
    current_snapshot,
    reason,
    available_snapshot_count,
    cache_status,
  });
  return deepFreeze({
    schema_version: AUTO_SCHEMA_VERSION,
    status: "not-ready",
    reason,
    available_snapshot_count,
    cache_status,
    binding,
    artifact_bytes: null,
    receipt: null,
    current_rankings: [],
    selected_methods: [],
    forecast_state: "readiness",
    telemetry,
  });
}

function disabledResult() {
  return deepFreeze({
    schema_version: AUTO_SCHEMA_VERSION,
    status: "disabled",
    reason: null,
    available_snapshot_count: 0,
    cache_status: "disabled",
    binding: null,
    artifact_bytes: null,
    receipt: null,
    current_rankings: [],
    selected_methods: [],
    forecast_state: "disabled",
    telemetry: predictiveTelemetry(),
  });
}

function evaluatedResult({ current_snapshot, replay, available_snapshot_count, cache_status, telemetry, signal = null }) {
  checkSignal(signal);
  const binding = forwardPrivate.bindAutomaticEvaluation({
    receipt: replay.receipt,
    current_snapshot,
    current_rankings: replay.current_rankings,
    selected_methods: replay.selected_methods,
    cache_status,
  });
  return deepFreeze({
    schema_version: AUTO_SCHEMA_VERSION,
    status: "evaluated",
    reason: null,
    available_snapshot_count,
    cache_status,
    binding,
    artifact_bytes: null,
    receipt: replay.receipt,
    current_rankings: replay.current_rankings,
    selected_methods: replay.selected_methods,
    forecast_state: replay.current_rankings.length > 0 ? "terminally-validated" : "no-current-forecast",
    telemetry,
  });
}

function errorDetail(error) {
  return String(error?.message ?? error ?? "unknown predictive failure").replace(/[\r\n]+/g, " ").slice(0, 700);
}

function readPromotionWithCancellation(store, request, signal) {
  checkSignal(signal);
  const hit = store.readPromotion(request);
  checkSignal(signal);
  return hit;
}

function publishPromotionWithCancellation(store, request, signal) {
  checkSignal(signal);
  const published = store.publishPromotion(request);
  checkSignal(signal);
  return published;
}

function evaluateAutomatic({
  mode = "auto",
  output_root,
  state_root = null,
  repository_id,
  configuration_hash,
  history_stage,
  current_snapshot,
  repository_root = null,
  config_path = null,
  python_executable = null,
  lease = null,
  artifact_store = undefined,
  cutoff_builder = buildCutoffSnapshots,
  ranking_k = DEFAULT_RANKING_K,
  signal,
} = {}) {
  if (!["off", "auto", "required"].includes(mode)) {
    throw new Error("FAIL-PREDICTIVE-MODE: predictive mode must be off, auto, or required");
  }
  if (mode === "off") return disabledResult();
  if (typeof cutoff_builder !== "function" || !Number.isSafeInteger(ranking_k) || ranking_k < 1) {
    throw new Error("FAIL-PREDICTIVE-BINDING: predictive construction inputs are invalid");
  }
  checkSignal(signal);
  const telemetry = { promotion_read_count: 0, cutoff_construction_count: 0, promotion_publication_count: 0 };
  const readiness = (input) => readinessResult({ ...input, signal });
  const history = historyDocument(history_stage);
  const plan = createV3CutoffPlan(history, current_snapshot);
  if (plan.status !== "ready") {
    return readiness({
      current_snapshot,
      reason: plan.reason,
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "not-ready",
      telemetry: predictiveTelemetry(telemetry),
    });
  }
  if (repository_id !== current_snapshot.repository.repository_id
      || configuration_hash !== current_snapshot.repository.configuration_hash) {
    return readiness({
      current_snapshot,
      reason: "requested repository or configuration does not match current canonical evidence",
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "rejected",
      telemetry: predictiveTelemetry(telemetry),
    });
  }

  let historyBytes;
  let currentBytes;
  let details;
  try {
    historyBytes = stageArtifactBytes({ output_root, state_root, repository_id, stage: history_stage });
    currentBytes = canonicalSnapshotBytes(current_snapshot);
    details = predictiveArtifactBinding({
      history,
      plan,
      currentSnapshot: current_snapshot,
      currentSnapshotDigest: sha256(Buffer.from(currentBytes, "utf8")),
      historyStageDigest: sha256(Buffer.from(historyBytes, "utf8")),
      configuration_hash,
      ranking_k,
    });
  } catch (error) {
    return readiness({
      current_snapshot,
      reason: "predictive evidence binding was unavailable: " + errorDetail(error),
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "rejected",
      telemetry: predictiveTelemetry(telemetry),
    });
  }

  let store;
  try {
    store = resolvePromotionStore({
      artifact_store,
      state_root,
      repository_id,
      lineage: details.lineage,
      lease,
      signal,
    });
    checkSignal(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return readiness({
      current_snapshot,
      reason: "predictive promotion storage was unavailable: " + errorDetail(error),
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "unavailable",
      telemetry: predictiveTelemetry(telemetry),
    });
  }
  if (store === null) {
    return readiness({
      current_snapshot,
      reason: mode === "required"
        ? "required predictive mode needs a compatible package state-writer lease"
        : "no compatible predictive promotion is available; run with --predictive required to build one",
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "unavailable",
      telemetry: predictiveTelemetry(telemetry),
    });
  }

  const key = artifactStorePrivate.buildPredictiveArtifactKey(details.binding);
  let hit;
  try {
    telemetry.promotion_read_count += 1;
    hit = readPromotionWithCancellation(store, { key, expectedBinding: details.binding }, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return readiness({
      current_snapshot,
      reason: "predictive promotion read was rejected: " + errorDetail(error),
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "rejected",
      telemetry: predictiveTelemetry(telemetry),
    });
  }
  if (hit !== null) {
    try {
      const replay = rehydrateV3Promotion({
        hit,
        historyBytes,
        currentBytes,
        currentSnapshot: current_snapshot,
        plan,
        context: { output_root, state_root, repository_id },
        ranking_k,
        signal,
      });
      checkSignal(signal);
      return evaluatedResult({
        current_snapshot,
        replay,
        available_snapshot_count: plan.available_snapshot_count,
        cache_status: "hit",
        telemetry: predictiveTelemetry(telemetry),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return readiness({
        current_snapshot,
        reason: "predictive promotion was rejected: " + errorDetail(error),
        available_snapshot_count: plan.available_snapshot_count,
        cache_status: "rejected",
        telemetry: predictiveTelemetry(telemetry),
      });
    }
  }
  if (mode === "auto") {
    return readiness({
      current_snapshot,
      reason: "no compatible predictive promotion is available; run with --predictive required to build one",
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "miss",
      telemetry: predictiveTelemetry(telemetry),
    });
  }

  let cutoffs;
  let receipt;
  try {
    checkSignal(signal);
    telemetry.cutoff_construction_count += 1;
    const built = cutoff_builder({
      repository_root,
      config_path,
      python_executable,
      history,
      current_snapshot,
      candidates: [],
      required_revisions: plan.unique_historical_revisions,
      signal,
    });
    checkSignal(signal);
    cutoffs = normalizeBuiltCutoffs(built, plan.unique_historical_revisions, current_snapshot);
    const snapshotsByRevision = new Map([[current_snapshot.repository.revision, current_snapshot]]);
    for (const [revision, cutoff] of cutoffs.entries()) snapshotsByRevision.set(revision, cutoff.snapshot);
    receipt = forwardTemporal.evaluateForwardTemporal({
      schema_version: V3_INPUT_SCHEMA_VERSION,
      history_stage,
      horizons: plan.horizons.map(({ horizon_commits, revisions }) => ({
        horizon_commits,
        snapshots: revisions.map((revision) => {
          const snapshot = snapshotsByRevision.get(revision);
          if (!snapshot) throw new Error("FAIL-PREDICTIVE-READINESS: required cutoff construction omitted " + revision);
          return snapshot;
        }),
      })),
      ranking_k,
    });
    checkSignal(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return readiness({
      current_snapshot,
      reason: "required predictive construction was rejected: " + errorDetail(error),
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "rejected",
      telemetry: predictiveTelemetry(telemetry),
    });
  }

  try {
    telemetry.promotion_publication_count += 1;
    publishPromotionWithCancellation(store, {
      key,
      binding: details.binding,
      objects: promotionObjects({ historyBytes, currentBytes, plan, cutoffs, receipt }),
      reportPins: [],
    }, signal);
    telemetry.promotion_read_count += 1;
    const published = readPromotionWithCancellation(store, { key, expectedBinding: details.binding }, signal);
    if (published === null) throw new Error("FAIL-PREDICTIVE-OBJECT: immutable predictive publication could not be read back");
    const replay = rehydrateV3Promotion({
      hit: published,
      historyBytes,
      currentBytes,
      currentSnapshot: current_snapshot,
      plan,
      context: { output_root, state_root, repository_id },
      ranking_k,
      signal,
    });
    checkSignal(signal);
    return evaluatedResult({
      current_snapshot,
      replay,
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "published",
      telemetry: predictiveTelemetry(telemetry),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return readiness({
      current_snapshot,
      reason: "required predictive publication was rejected: " + errorDetail(error),
      available_snapshot_count: plan.available_snapshot_count,
      cache_status: "rejected",
      telemetry: predictiveTelemetry(telemetry),
    });
  }
}

module.exports = { evaluateAutomatic };
Object.defineProperty(module.exports, Symbol.for("sei.predictive-auto.private.v1"), {
  value: Object.freeze({ AUTO_SCHEMA_VERSION, HORIZON_COMMITS, REQUIRED_CUTOFFS, cutoffRevisions }),
});
