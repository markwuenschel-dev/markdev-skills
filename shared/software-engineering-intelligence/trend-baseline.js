"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const intelligenceEngine = require("./intelligence-engine.js");
const { materializeSnapshot, validateSnapshot } = intelligenceEngine;
const intelligenceEnginePrivate = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")];
const { compareSnapshots } = require("./interpretation.js");

const COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const AUTOMATIC_BASELINE_MAX_CANDIDATES = 512;
const AUTOMATIC_BASELINE_MAX_DIRECTORY_ENTRIES = 2_048;
const AUTOMATIC_BASELINE_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const AUTOMATIC_BASELINE_MAX_INVENTORY_BYTES = 256 * 1024 * 1024;
const SIGNIFICANT_HISTORY_MAX_COMMITS = 256;
const SIGNIFICANT_HISTORY_MIN_FILES = 3;
const SIGNIFICANT_HISTORY_MIN_TEXT_CHURN = 100;
const CASE_INSENSITIVE_FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
const DEFAULT_PORTS = new Map([
  ["http:", "80"],
  ["https:", "443"],
  ["ssh:", "22"],
  ["git:", "9418"],
]);
const ESTABLISHED_REASON = "automatic baseline established for a later compatible run; no prior compatible strict ancestor observation selected";

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function runGit(repositoryRoot, args, { allowFailure = false } = {}) {
  const safeRoot = path.resolve(repositoryRoot);
  const result = spawnSync("git", ["-c", `safe.directory=${safeRoot}`, "-C", safeRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`FAIL-TREND-REPOSITORY-IDENTITY: git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function normalizedNetworkOrigin(origin) {
  const supplied = String(origin ?? "").trim();
  if (supplied.length === 0 || /^file:/i.test(supplied) || /^[a-zA-Z]:[\\/]/.test(supplied)) return null;

  let host;
  let port = "";
  let pathname;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(supplied);
  if (schemeMatch) {
    let parsed;
    try {
      parsed = new URL(supplied);
    } catch {
      return null;
    }
    const protocol = parsed.protocol.toLowerCase();
    if (!DEFAULT_PORTS.has(protocol)) return null;
    host = parsed.hostname.toLowerCase();
    port = parsed.port;
    if (port === DEFAULT_PORTS.get(protocol)) port = "";
    pathname = parsed.pathname;
  } else {
    const scpLike = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(supplied);
    if (!scpLike) return null;
    host = scpLike[1].toLowerCase();
    pathname = scpLike[2];
  }

  let normalizedPath = pathname.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  normalizedPath = normalizedPath.replace(/\.git$/i, "").replace(/\/+$/g, "");
  if (host.length === 0 || normalizedPath.length === 0) return null;
  if (CASE_INSENSITIVE_FORGES.has(host)) normalizedPath = normalizedPath.toLowerCase();
  return `${host}${port ? `:${port}` : ""}/${normalizedPath}`;
}

function rootCommitIdentity(repositoryRoot, repositoryRevision) {
  const revision = String(repositoryRevision ?? "").trim().toLowerCase();
  if (!COMMIT_ID_PATTERN.test(revision)) {
    throw new Error("FAIL-TREND-REPOSITORY-IDENTITY: repository_revision must be a full commit ID");
  }
  const output = runGit(repositoryRoot, ["rev-list", "--max-parents=0", revision]);
  const roots = [...new Set(output.split(/\r?\n/).filter(Boolean).map((value) => value.toLowerCase()))]
    .sort(stableCompare);
  if (roots.length === 0 || roots.some((value) => !COMMIT_ID_PATTERN.test(value))) {
    throw new Error("FAIL-TREND-REPOSITORY-IDENTITY: full root commit IDs are unavailable");
  }
  return `roots:${roots.join(",")}`;
}

function deriveCanonicalRepositoryIdentity({ repository_root, repository_revision, repository_id } = {}) {
  if (typeof repository_id === "string" && repository_id.trim().length > 0) return repository_id.trim();
  if (typeof repository_root !== "string" || repository_root.trim().length === 0) {
    throw new Error("FAIL-TREND-REPOSITORY-IDENTITY: repository_root must be nonblank");
  }
  const originOutput = runGit(repository_root, ["config", "--get-all", "remote.origin.url"], { allowFailure: true });
  const origins = [...new Set(String(originOutput ?? "")
    .split(/\r?\n/)
    .map(normalizedNetworkOrigin)
    .filter(Boolean))]
    .sort(stableCompare);
  const material = origins.length > 0
    ? `origin:${origins.join(",")}`
    : rootCommitIdentity(repository_root, repository_revision);
  return `sei-repository-v1-${crypto.createHash("sha256").update(material).digest("hex")}`;
}

function bindingSignature(records, fields) {
  if (!Array.isArray(records)) return null;
  const identities = new Set();
  const bindings = [];
  for (const record of records) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
    const binding = {};
    for (const field of fields) {
      if (typeof record[field] !== "string" || record[field].trim().length === 0) return null;
      binding[field] = record[field].trim();
    }
    if (identities.has(binding[fields[0]])) return null;
    identities.add(binding[fields[0]]);
    bindings.push(binding);
  }
  return JSON.stringify(bindings.sort((left, right) => stableCompare(left[fields[0]], right[fields[0]])));
}

function environmentIsCompatible(previous, current) {
  return (
    previous.schema_version === current.schema_version &&
    previous.repository.repository_id === current.repository.repository_id &&
    previous.repository.configuration_hash === current.repository.configuration_hash &&
    previous.repository.history_boundary.kind === current.repository.history_boundary.kind &&
    previous.repository.history_boundary.start === current.repository.history_boundary.start &&
    bindingSignature(
      previous.collectors,
      ["collector_id", "collector_version", "status", "analyzer_identity", "analyzer_version"],
    ) === bindingSignature(
      current.collectors,
      ["collector_id", "collector_version", "status", "analyzer_identity", "analyzer_version"],
    ) &&
    bindingSignature(
      previous.profiles ?? [],
      ["profile_id", "profile_version", "profile_contract_hash"],
    ) === bindingSignature(
      current.profiles ?? [],
      ["profile_id", "profile_version", "profile_contract_hash"],
    )
  );
}

function currentEligibleMetricCount(snapshot) {
  const collectors = new Map(snapshot.collectors.map((collector) => [collector.collector_id, collector]));
  return snapshot.measurements.filter((metric) => {
    const collector = collectors.get(metric?.source?.collector_id);
    return (
      (metric?.measurement?.status === "measured" || metric?.measurement?.status === "inferred") &&
      typeof metric.value === "number" && Number.isFinite(metric.value) &&
      collector?.status === "available" &&
      collector.collector_version === metric?.source?.collector_version &&
      collector.analyzer_identity === metric?.analyzer_identity &&
      collector.analyzer_version === metric?.analyzer_version
    );
  }).length;
}

function metricHasAvailableCollector(snapshot, metric) {
  const collector = snapshot.collectors.find((candidate) => candidate.collector_id === metric?.source?.collector_id);
  return (
    collector?.status === "available" &&
    collector.collector_version === metric?.source?.collector_version &&
    collector.analyzer_identity === metric?.analyzer_identity &&
    collector.analyzer_version === metric?.analyzer_version
  );
}

function metricsAreBindable(previous, current, previousSnapshot, currentSnapshot) {
  return (
    previous.metric_id === current.metric_id &&
    previous.definition_id === current.definition_id &&
    previous.subject === current.subject &&
    previous.unit === current.unit &&
    previous.analyzer_identity === current.analyzer_identity &&
    previous.analyzer_version === current.analyzer_version &&
    previous.window?.kind === current.window?.kind &&
    previous.window?.start === current.window?.start &&
    previous.comparability?.configuration_hash === current.comparability?.configuration_hash &&
    (previous.measurement?.status === "measured" || previous.measurement?.status === "inferred") &&
    (current.measurement?.status === "measured" || current.measurement?.status === "inferred") &&
    typeof previous.value === "number" && Number.isFinite(previous.value) &&
    typeof current.value === "number" && Number.isFinite(current.value) &&
    metricHasAvailableCollector(previousSnapshot, previous) &&
    metricHasAvailableCollector(currentSnapshot, current)
  );
}

function comparisonProbe(previous, current) {
  const probe = structuredClone(current);
  const previousByMetricId = new Map(previous.measurements.map((metric) => [metric.metric_id, metric]));
  for (const metric of probe.measurements) {
    const baselineMetric = previousByMetricId.get(metric.metric_id);
    if (!baselineMetric || !metricsAreBindable(baselineMetric, metric, previous, probe)) continue;
    metric.comparability.compatible_with_prior = true;
    metric.comparability.reason = "automatic baseline compatibility probe";
    metric.comparison = {
      baseline_snapshot_id: previous.snapshot_id,
      baseline_metric_id: baselineMetric.metric_id,
      analyzer_identity: metric.analyzer_identity,
      analyzer_version: metric.analyzer_version,
      configuration_hash: probe.repository.configuration_hash,
    };
  }
  return probe;
}

function significantHistoryRecord(repositoryRoot, currentRevision) {
  const log = runGit(repositoryRoot, [
    "log",
    "--first-parent",
    `--max-count=${SIGNIFICANT_HISTORY_MAX_COMMITS}`,
    "--format=%H%x00%P%x00%aI%x00%aN%x00%s%x1e",
    "--numstat",
    `${currentRevision}^`,
  ], { allowFailure: true });
  return significantHistoryFromLog(log);
}

// Parses `git log --first-parent --format=%H%x00%P%x00%aI%x00%aN%x00%s%x1e --numstat`
// output. Split from significantHistoryRecord so a mocked log can be tested.
function significantHistoryFromLog(log) {
  if (typeof log !== "string" || log.length === 0) return null;

  const candidates = [];
  const records = [];
  let currentRecord = null;
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.replaceAll("\x1e", "").trimEnd();
    if (line.includes("\x00")) {
      if (currentRecord !== null) records.push(currentRecord);
      currentRecord = { metadata: line, lines: [] };
    } else if (currentRecord !== null && line.trim().length > 0) {
      currentRecord.lines.push(line);
    }
  }
  if (currentRecord !== null) records.push(currentRecord);
  records.forEach((record, index) => {
    const lines = record.lines;
    const metadata = record.metadata;
    const fields = metadata?.split("\x00") ?? [];
    const revision = fields[0]?.trim().toLowerCase();
    const parents = fields[1]?.trim() === "" ? [] : (fields[1]?.trim().split(/\s+/) ?? []);
    const authoredAt = fields[2]?.trim();
    const author = fields[3]?.trim();
    const subject = fields.slice(4).join("\x00").trim();
    if (!COMMIT_ID_PATTERN.test(revision) || parents.some((parent) => !COMMIT_ID_PATTERN.test(parent))) return;
    // P2 (composite-scoring-v3 §3): a parentless (root) commit has no prior
    // state to compare against, and the history-context schema requires
    // parent_count >= 1. Skip it rather than relax the schema.
    if (parents.length === 0) return;

    let changedFileCount = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      const match = /^(\d+|-)[ \t]+(\d+|-)[ \t]+(.+)$/.exec(line);
      if (!match) continue;
      changedFileCount += 1;
      if (match[1] !== "-") additions += Number(match[1]);
      if (match[2] !== "-") deletions += Number(match[2]);
    }
    const textChurn = additions + deletions;
    const isMerge = parents.length > 1;
    if (!isMerge && changedFileCount < SIGNIFICANT_HISTORY_MIN_FILES && textChurn < SIGNIFICANT_HISTORY_MIN_TEXT_CHURN) return;
    candidates.push({
      kind: "significant-git-history",
      event_kind: isMerge ? "merge-commit" : "commit",
      repository_revision: revision,
      short_revision: revision.slice(0, 12),
      subject: subject.slice(0, 240),
      author: author.slice(0, 160),
      authored_at: authoredAt,
      commit_distance: index + 1,
      parent_count: parents.length,
      is_merge: isMerge,
      changed_file_count: changedFileCount,
      additions,
      deletions,
      text_churn: textChurn,
      significance_basis: isMerge
        ? "merge-commit"
        : changedFileCount >= SIGNIFICANT_HISTORY_MIN_FILES
          ? `at-least-${SIGNIFICANT_HISTORY_MIN_FILES}-changed-files`
          : `at-least-${SIGNIFICANT_HISTORY_MIN_TEXT_CHURN}-lines-of-text-churn`,
    });
  });
  return candidates[0] ?? null;
}

function strictAncestorDistance(repositoryRoot, previousRevision, currentRevision) {
  if (previousRevision === currentRevision) return null;
  const safeRoot = path.resolve(repositoryRoot);
  const ancestor = spawnSync("git", ["-c", `safe.directory=${safeRoot}`, "-C", safeRoot, "merge-base", "--is-ancestor", previousRevision, currentRevision], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (ancestor.error || ancestor.status !== 0) return null;
  const count = runGit(repositoryRoot, ["rev-list", "--count", `${previousRevision}..${currentRevision}`], { allowFailure: true });
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(count ?? ""))) return null;
  const distance = Number(count);
  return Number.isSafeInteger(distance) && distance > 0 ? distance : null;
}

function readCanonicalCandidate(filePath, expectedFilename) {
  let before;
  try {
    before = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > AUTOMATIC_BASELINE_MAX_SNAPSHOT_BYTES) return null;
  let document;
  try {
    document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  const validation = validateSnapshot(document);
  if (!validation.ok || `${document.snapshot_id}.json` !== expectedFilename) return null;
  let rematerialized;
  try {
    rematerialized = materializeSnapshot(document);
  } catch {
    return null;
  }
  if (
    rematerialized.snapshot_id !== document.snapshot_id ||
    JSON.stringify(rematerialized) !== JSON.stringify(document)
  ) return null;
  return rematerialized;
}

function establishedResult(currentSnapshot, eligibleMetricCount, reason, repositoryRoot) {
  return {
    binding_kind: "automatic",
    status: "established",
    eligible: eligibleMetricCount > 0,
    baseline: null,
    baseline_snapshot_id: null,
    baseline_repository_revision: null,
    compatible_metric_count: 0,
    current_snapshot_id: currentSnapshot.snapshot_id,
    historical_context: significantHistoryRecord(repositoryRoot, currentSnapshot.repository.revision),
    reason,
  };
}

function discoverAutomaticTrendBaselineCore({ repository_root, output_root, current_snapshot }) {
  if (typeof repository_root !== "string" || repository_root.trim().length === 0) {
    throw new Error("FAIL-TREND-BASELINE-INPUT: repository_root must be nonblank");
  }
  if (typeof output_root !== "string" || output_root.trim().length === 0) {
    throw new Error("FAIL-TREND-BASELINE-INPUT: output_root must be nonblank");
  }
  const eligibleMetricCount = currentEligibleMetricCount(current_snapshot);
  const snapshotDirectory = path.join(output_root, "snapshots");
  let directory;
  try {
    directory = fs.opendirSync(snapshotDirectory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return establishedResult(current_snapshot, eligibleMetricCount, ESTABLISHED_REASON, repository_root);
    }
    return establishedResult(current_snapshot, eligibleMetricCount, "automatic baseline inventory is unavailable", repository_root);
  }
  const entries = [];
  let directoryEntryCount = 0;
  let directoryBoundExceeded = false;
  let candidateBoundExceeded = false;
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      directoryEntryCount += 1;
      if (directoryEntryCount > AUTOMATIC_BASELINE_MAX_DIRECTORY_ENTRIES) {
        directoryBoundExceeded = true;
        break;
      }
      if (entry.name.endsWith(".json")) {
        if (entries.length <= AUTOMATIC_BASELINE_MAX_CANDIDATES) entries.push(entry);
        if (entries.length > AUTOMATIC_BASELINE_MAX_CANDIDATES) candidateBoundExceeded = true;
      }
    }
  } catch {
    return establishedResult(current_snapshot, eligibleMetricCount, "automatic baseline inventory is unavailable", repository_root);
  } finally {
    try { directory.closeSync(); } catch { /* read-only inventory is already unavailable or complete */ }
  }
  entries.sort((left, right) => stableCompare(left.name, right.name));
  if (directoryBoundExceeded) {
    return establishedResult(current_snapshot, eligibleMetricCount, `automatic baseline directory entry bound exceeded (${directoryEntryCount}/${AUTOMATIC_BASELINE_MAX_DIRECTORY_ENTRIES})`, repository_root);
  }
  if (candidateBoundExceeded) {
    return establishedResult(current_snapshot, eligibleMetricCount, `automatic baseline candidate bound exceeded (more than ${AUTOMATIC_BASELINE_MAX_CANDIDATES})`, repository_root);
  }

  const inventory = [];
  let inventoryBytes = 0;
  for (const entry of entries) {
    const candidatePath = path.join(snapshotDirectory, entry.name);
    let stats;
    try {
      stats = fs.lstatSync(candidatePath);
    } catch {
      continue;
    }
    if (!entry.isFile() || !stats.isFile() || stats.isSymbolicLink()) continue;
    inventoryBytes += stats.size;
    if (inventoryBytes > AUTOMATIC_BASELINE_MAX_INVENTORY_BYTES) {
      return establishedResult(current_snapshot, eligibleMetricCount, "automatic baseline aggregate candidate byte bound exceeded (limit 256 MiB)", repository_root);
    }
    inventory.push({ name: entry.name, path: candidatePath });
  }

  const compatible = [];
  for (const entry of inventory) {
    const candidate = readCanonicalCandidate(entry.path, entry.name);
    if (candidate === null || !environmentIsCompatible(candidate, current_snapshot)) continue;
    const distance = strictAncestorDistance(
      repository_root,
      candidate.repository.revision,
      current_snapshot.repository.revision,
    );
    if (distance === null) continue;
    let trend;
    try {
      trend = compareSnapshots(candidate, comparisonProbe(candidate, current_snapshot), {
        require_explicit_baseline: true,
      });
    } catch {
      continue;
    }
    const compatibleMetricCount = trend.trends.filter((record) => (
      record.status === "comparable" &&
      typeof record.previous_value === "number" && Number.isFinite(record.previous_value) &&
      typeof record.current_value === "number" && Number.isFinite(record.current_value) &&
      typeof record.delta === "number" && Number.isFinite(record.delta)
    )).length;
    if (compatibleMetricCount === 0) continue;
    compatible.push({ candidate, compatibleMetricCount, distance });
  }
  compatible.sort((left, right) => (
    left.distance - right.distance || stableCompare(left.candidate.snapshot_id, right.candidate.snapshot_id)
  ));
  const selected = compatible[0];
  if (!selected) {
    return establishedResult(current_snapshot, eligibleMetricCount, ESTABLISHED_REASON, repository_root);
  }
  return {
    binding_kind: "automatic",
    status: "selected",
    eligible: true,
    baseline: selected.candidate,
    baseline_snapshot_id: selected.candidate.snapshot_id,
    baseline_repository_revision: selected.candidate.repository.revision,
    compatible_metric_count: selected.compatibleMetricCount,
    current_snapshot_id: current_snapshot.snapshot_id,
    historical_context: null,
    reason: `selected nearest compatible strict ancestor at Git distance ${selected.distance}`,
  };
}

function discoverAutomaticTrendBaseline({ repository_root, output_root, current_snapshot } = {}) {
  if (typeof repository_root !== "string" || repository_root.trim().length === 0) {
    throw new Error("FAIL-TREND-BASELINE-INPUT: repository_root must be nonblank");
  }
  if (typeof output_root !== "string" || output_root.trim().length === 0) {
    throw new Error("FAIL-TREND-BASELINE-INPUT: output_root must be nonblank");
  }
  const currentValidation = validateSnapshot(current_snapshot);
  if (!currentValidation.ok) {
    throw new Error(`FAIL-TREND-BASELINE-CURRENT: ${currentValidation.errors.join("; ")}`);
  }
  return discoverAutomaticTrendBaselineCore({ repository_root, output_root, current_snapshot });
}

function discoverAutomaticTrendBaselineFromProbe({ repository_root, output_root, current_probe } = {}) {
  const currentSnapshot = intelligenceEnginePrivate.readTrendProbe(current_probe);
  return discoverAutomaticTrendBaselineCore({
    repository_root,
    output_root,
    current_snapshot: currentSnapshot,
  });
}

module.exports = {
  AUTOMATIC_BASELINE_MAX_CANDIDATES,
  AUTOMATIC_BASELINE_MAX_INVENTORY_BYTES,
  AUTOMATIC_BASELINE_MAX_SNAPSHOT_BYTES,
  deriveCanonicalRepositoryIdentity,
  discoverAutomaticTrendBaseline,
};
Object.defineProperty(module.exports, Symbol.for("sei.trend-baseline.private.v1"), {
  value: Object.freeze({ discoverAutomaticTrendBaselineFromProbe, significantHistoryFromLog }),
});
