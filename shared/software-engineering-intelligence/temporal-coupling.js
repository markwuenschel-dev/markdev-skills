"use strict";

const crypto = require("node:crypto");

// An uncapped commit has fewer than threshold files; a capped mass commit has
// at most cap files. Keeping both limits at 40 bounds every nested pairing
// loop to C(40, 2) = 780 relationships.
const MAX_SAFE_MASS_CHANGE_CAP = 40;
const MAX_SAFE_MASS_CHANGE_THRESHOLD = 40;
const MAX_SAFE_PAIR_GENERATION_BOUND = (MAX_SAFE_MASS_CHANGE_CAP * (MAX_SAFE_MASS_CHANGE_CAP - 1)) / 2;

const DEFAULT_MASS_CHANGE_POLICY = Object.freeze({
  policy_id: "temporal-coupling-mass-change-v1",
  policy_version: "1.0.0",
  threshold: MAX_SAFE_MASS_CHANGE_THRESHOLD,
  cap: 32,
  action: "down_weight",
});
const POLICY_ACTIONS = new Set(["exclude", "down_weight", "retain"]);
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`FAIL-MALFORMED-TEMPORAL-RECORD: ${label} must be a non-empty NUL-free path`);
  }
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizedTimestamp(value, label) {
  if (typeof value !== "string" || !RFC3339_WITH_OFFSET.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`FAIL-MALFORMED-TEMPORAL-RECORD: ${label} must be RFC3339 with Z or an explicit offset`);
  }
  return new Date(value).toISOString();
}

function normalizePolicy(policy) {
  if (policy === undefined) policy = {};
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("FAIL-INVALID-MASS-CHANGE-POLICY: policy must be an object");
  }
  const allowed = new Set(["policy_id", "policy_version", "threshold", "cap", "action"]);
  for (const key of Object.keys(policy)) {
    if (!allowed.has(key)) {
      throw new Error(`FAIL-INVALID-MASS-CHANGE-POLICY: unsupported policy field ${key}`);
    }
  }
  const normalized = {
    policy_id: policy.policy_id ?? DEFAULT_MASS_CHANGE_POLICY.policy_id,
    policy_version: policy.policy_version ?? DEFAULT_MASS_CHANGE_POLICY.policy_version,
    threshold: policy.threshold ?? DEFAULT_MASS_CHANGE_POLICY.threshold,
    cap: policy.cap ?? DEFAULT_MASS_CHANGE_POLICY.cap,
    action: policy.action ?? DEFAULT_MASS_CHANGE_POLICY.action,
  };
  if (typeof normalized.policy_id !== "string" || normalized.policy_id.length === 0 ||
      typeof normalized.policy_version !== "string" || normalized.policy_version.length === 0) {
    throw new Error("FAIL-INVALID-MASS-CHANGE-POLICY: policy_id and policy_version must be non-empty strings");
  }
  for (const field of ["threshold", "cap"]) {
    if (!Number.isInteger(normalized[field]) || normalized[field] < 1) {
      throw new Error(`FAIL-INVALID-MASS-CHANGE-POLICY: ${field} must be a positive integer`);
    }
  }
  if (normalized.cap > MAX_SAFE_MASS_CHANGE_CAP) {
    throw new Error(`FAIL-MASS-CHANGE-POLICY: cap ${normalized.cap} exceeds fixed safe maximum ${MAX_SAFE_MASS_CHANGE_CAP}`);
  }
  if (normalized.threshold > MAX_SAFE_MASS_CHANGE_THRESHOLD) {
    throw new Error(`FAIL-MASS-CHANGE-POLICY: threshold ${normalized.threshold} exceeds fixed safe maximum ${MAX_SAFE_MASS_CHANGE_THRESHOLD}`);
  }
  if (!POLICY_ACTIONS.has(normalized.action)) {
    throw new Error("FAIL-INVALID-MASS-CHANGE-POLICY: action must be exclude, down_weight, or retain");
  }
  return normalized;
}

function normalizeCommits(commits) {
  if (!Array.isArray(commits)) {
    throw new Error("FAIL-MALFORMED-TEMPORAL-INPUT: commits must be an array");
  }
  const revisions = new Set();
  return commits.map((commit, commitIndex) => {
    if (!commit || typeof commit !== "object" || Array.isArray(commit) ||
        typeof commit.revision !== "string" || commit.revision.length === 0 ||
        typeof commit.timestamp !== "string" ||
        !Array.isArray(commit.files)) {
      throw new Error(`FAIL-MALFORMED-TEMPORAL-RECORD: commit ${commitIndex} is incomplete`);
    }
    const revision = commit.revision.toLowerCase();
    if (revisions.has(revision)) {
      throw new Error(`FAIL-DUPLICATE-TEMPORAL-COMMIT: commit ${commitIndex} duplicates revision ${commit.revision}`);
    }
    revisions.add(revision);
    const paths = new Set();
    for (const [fileIndex, file] of commit.files.entries()) {
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        throw new Error(`FAIL-MALFORMED-TEMPORAL-RECORD: commit ${commitIndex} file ${fileIndex} is invalid`);
      }
      if (file.eligible_for_temporal_coupling !== undefined && typeof file.eligible_for_temporal_coupling !== "boolean") {
        throw new Error(`FAIL-MALFORMED-TEMPORAL-RECORD: commit ${commitIndex} file ${fileIndex} eligibility must be boolean`);
      }
      // Only a collector that positively established human eligibility may
      // contribute a path. Undefined is classification-unknown, not human.
      if (file.eligible_for_temporal_coupling !== true) continue;
      const filePath = normalizedPath(file.path, `commit ${commitIndex} file ${fileIndex}.path`);
      if (paths.has(filePath)) {
        throw new Error(`FAIL-DUPLICATE-TEMPORAL-PATH: commit ${commitIndex} duplicates ${filePath}`);
      }
      paths.add(filePath);
    }
    return {
      revision,
      timestamp: normalizedTimestamp(commit.timestamp, `commit ${commitIndex}.timestamp`),
      paths: [...paths].sort(stableCompare),
    };
  }).sort((left, right) => stableCompare(left.timestamp, right.timestamp) || stableCompare(left.revision, right.revision));
}

function pairCount(fileCount) {
  return fileCount < 2 ? 0 : (fileCount * (fileCount - 1)) / 2;
}

function derivePolicyReceipt(policy, counts) {
  const policyHash = `sha256:${crypto.createHash("sha256").update(stableStringify(policy)).digest("hex")}`;
  const commonReason = `mass-change-pairs-at-or-above-threshold-${policy.threshold}`;
  let reason;
  if (counts.massCommitCount === 0) {
    reason = `no-mass-changes-observed-at-or-above-threshold-${policy.threshold}-so-no-mass-change-action-was-applied-within-fixed-safe-pair-bound-${MAX_SAFE_PAIR_GENERATION_BOUND}`;
  } else if (policy.action === "exclude") {
    reason = `${commonReason}-are-excluded-before-pair-enumeration`;
  } else if (policy.action === "down_weight") {
    reason = counts.cappedCommitCount > 0
      ? `${commonReason}-are-deterministically-capped-at-${policy.cap}-within-fixed-safe-maximum-${MAX_SAFE_MASS_CHANGE_CAP}-with-minimum-observed-file-frequency-denominator`
      : `${commonReason}-were-within-cap-${policy.cap}-so-no-cap-reduction-was-applied-with-minimum-observed-file-frequency-denominator`;
  } else {
    reason = `${commonReason}-must-fail-before-unbounded-pair-enumeration`;
  }
  return {
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_hash: policyHash,
    threshold: policy.threshold,
    action: policy.action,
    total_commit_count: counts.totalCommitCount,
    eligible_commit_count: counts.eligibleCommitCount,
    mass_commit_count: counts.massCommitCount,
    excluded_pairwise_count: counts.excludedPairwiseCount,
    down_weighted_pairwise_count: counts.downWeightedPairwiseCount,
    reason,
  };
}

function deriveTemporalCoupling({ commits, policy } = {}) {
  const normalizedPolicy = normalizePolicy(policy);
  const rows = normalizeCommits(commits);
  const fileFrequencies = new Map();
  const pairs = new Map();
  let eligibleCommitCount = 0;
  let massCommitCount = 0;
  let cappedCommitCount = 0;
  let excludedPairwiseCount = 0;
  let downWeightedPairwiseCount = 0;
  let pairGenerationBound = 0;

  for (const commit of rows) {
    const paths = commit.paths;
    if (paths.length === 0) continue;
    eligibleCommitCount += 1;
    for (const filePath of paths) {
      fileFrequencies.set(filePath, (fileFrequencies.get(filePath) ?? 0) + 1);
    }
    if (paths.length < 2) continue;

    const massChange = paths.length >= normalizedPolicy.threshold;
    if (massChange) massCommitCount += 1;
    if (massChange && normalizedPolicy.action === "retain") {
      throw new Error(`FAIL-MASS-CHANGE-POLICY: retain cannot enumerate a mass change of ${paths.length} files at threshold ${normalizedPolicy.threshold}`);
    }
    if (massChange && normalizedPolicy.action === "exclude") {
      excludedPairwiseCount += pairCount(paths.length);
      continue;
    }

    const selected = massChange && normalizedPolicy.action === "down_weight"
      ? paths.slice(0, normalizedPolicy.cap)
      : paths;
    const downWeighted = massChange
      && normalizedPolicy.action === "down_weight"
      && selected.length < paths.length;
    if (downWeighted) {
      cappedCommitCount += 1;
      downWeightedPairwiseCount += pairCount(paths.length);
    }
    const selectedPairwiseCount = pairCount(selected.length);
    if (selectedPairwiseCount > MAX_SAFE_PAIR_GENERATION_BOUND) {
      throw new Error(`FAIL-MASS-CHANGE-POLICY: selected pair bound ${selectedPairwiseCount} exceeds fixed safe maximum ${MAX_SAFE_PAIR_GENERATION_BOUND}`);
    }
    pairGenerationBound = Math.max(pairGenerationBound, selectedPairwiseCount);
    for (let left = 0; left < selected.length; left += 1) {
      for (let right = left + 1; right < selected.length; right += 1) {
        const key = `${selected[left]}\0${selected[right]}`;
        const observed = pairs.get(key) ?? { count: 0, down_weighted: false };
        observed.count += 1;
        observed.down_weighted ||= downWeighted;
        pairs.set(key, observed);
      }
    }
  }

  const receipt = derivePolicyReceipt(normalizedPolicy, {
    totalCommitCount: rows.length,
    eligibleCommitCount,
    massCommitCount,
    cappedCommitCount,
    excludedPairwiseCount,
    downWeightedPairwiseCount,
  });
  const relationships = [...pairs.entries()].map(([key, observed]) => {
    const [source, target] = key.split("\0");
    const denominator = Math.min(fileFrequencies.get(source), fileFrequencies.get(target));
    const relationship = {
      kind: "temporal_coupling",
      source,
      target,
      co_change_count: observed.count,
      coupling_ratio: observed.count / denominator,
    };
    if (observed.down_weighted) {
      relationship.policy_status = "down_weighted";
      relationship.policy_reason = receipt.reason;
    } else {
      relationship.policy_status = "included";
      relationship.policy_reason = receipt.reason;
    }
    return relationship;
  }).sort((left, right) => stableCompare(left.source, right.source) || stableCompare(left.target, right.target));

  return {
    relationships,
    file_frequencies: Object.fromEntries([...fileFrequencies.entries()].sort(([left], [right]) => stableCompare(left, right))),
    pair_generation_bound: pairGenerationBound,
    mass_change_policy: receipt,
  };
}

module.exports = { DEFAULT_MASS_CHANGE_POLICY, deriveTemporalCoupling };
