"use strict";

const crypto = require("node:crypto");
const schema = require("./intelligence.schema.json");
const { validateAgainstSchema } = require("./schema-validator.js");
const { interpretEvidence } = require("./semantic-evidence.js");
const {
  PROFILE_DIMENSIONS,
  PROFILE_VERSION,
  deriveProfileContractHash,
} = require("./profiles.js");

const SNAPSHOT_SCHEMA_VERSION = "1.0.0";
const STATUS = new Set([
  "measured",
  "inferred",
  "unavailable",
  "not-applicable",
  "unverifiable",
]);
const OBSERVED_MEASUREMENT_STATUS = new Set(["measured", "inferred"]);
const COLLECTOR_STATUS = new Set(["available", "degraded", "unavailable"]);
const RISK_MODEL_DEFINITIONS = Object.freeze({
  "heuristic-v1": Object.freeze({
    model_version: "1.0.0",
    result_kind: "heuristic_hotspot_vectors",
    interpretation_boundary: "feature vectors and review-attention signals only",
  }),
  "temporal-coupling-pressure-v1": Object.freeze({
    model_version: "1.0.0",
    result_kind: "temporal_coupling_pressure",
    interpretation_boundary: "source-bound co-change pressure only; not a defect probability or candidate priority",
  }),
  "engineering-investigation-signals-v1": Object.freeze({
    model_version: "1.0.0",
    result_kind: "engineering_investigation_signals",
    interpretation_boundary: "bounded repository-relative engineering investigation signals only; not defect, architecture, priority, or health verdicts",
  }),
});
const RISK_MODEL_STATUS = new Set(["heuristic", "calibrated", "validated", "unavailable", "unverifiable"]);
const RISK_RESULT_STATUS = new Set(["available", "unavailable", "unverifiable"]);
const INVESTIGATION_OBSERVATION_STATUS = new Set(["measured", "degraded", "unavailable", "unverifiable"]);
const PROFILE_APPLICABILITY_STATUS = new Set(["applicable", "not_applicable", "insufficient_evidence", "unobservable"]);
const PROFILE_DIMENSION_STATUS = new Set(["measured", "inferred", "not_applicable", "insufficient_evidence", "unobservable"]);
const POLICY_STATUS = new Set(["included", "excluded", "down_weighted"]);
const INTERNAL_TIMING = Symbol("sei-intelligence-engine-timing");
const canonicalArtifactState = new WeakMap();
const trendProbeState = new WeakMap();

const REQUIRED_TOP_LEVEL = [
  "schema_version",
  "snapshot_id",
  "repository",
  "collectors",
  "measurements",
  "risk_models",
  "profiles",
  "evidence_summary",
  "run_metadata",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function internalTiming(options) {
  const timing = options?.[INTERNAL_TIMING] ?? null;
  if (timing === null) return null;
  if (!isRecord(timing) || typeof timing.now !== "function" || typeof timing.observe !== "function") {
    throw new Error("FAIL-SNAPSHOT-TELEMETRY: private timing observer is invalid");
  }
  return timing;
}

function observedWork(timing, field, work) {
  if (timing === null) return work();
  const started = timing.now();
  try {
    return work();
  } finally {
    const finished = timing.now();
    if (typeof started !== "bigint" || typeof finished !== "bigint" || finished < started) {
      throw new Error("FAIL-SNAPSHOT-TELEMETRY: private monotonic clock is invalid");
    }
    timing.observe(field, Number(finished - started) / 1_000_000);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function addRequiredString(errors, value, path) {
  if (!isNonEmptyString(value)) {
    errors.push(`FAIL-MISSING-STABLE-ID: ${path} must be a non-empty string`);
  }
}

function validateAllowedKeys(errors, value, path, allowedKeys, failureCode = "FAIL-SNAPSHOT-CONTRACT") {
  if (!isRecord(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${failureCode}: ${path}.${key} is not a declared field`);
    }
  }
}

function addDuplicateErrors(errors, items, idField, path) {
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const id = items[index]?.[idField];
    addRequiredString(errors, id, `${path}[${index}].${idField}`);
    if (isNonEmptyString(id) && seen.has(id)) {
      errors.push(`FAIL-DUPLICATE-ID: ${path}[${index}].${idField} duplicates ${id}`);
    }
    seen.add(id);
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableCompare(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

function sortByField(items, field) {
  items.sort((left, right) => stableCompare(left?.[field], right?.[field]));
}

function normalizeObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeObjectKeys(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeObjectKeys(value[key])]),
  );
}

function normalizeAndSort(input) {
  const snapshot = structuredClone(input);
  for (const [field, idField] of [
    ["collectors", "collector_id"],
    ["measurements", "metric_id"],
    ["risk_models", "risk_model_id"],
    ["profiles", "profile_id"],
  ]) {
    if (Array.isArray(snapshot[field])) {
      sortByField(snapshot[field], idField);
    }
  }
  if (Array.isArray(snapshot.repository?.generated_path_patterns)) {
    snapshot.repository.generated_path_patterns.sort(stableCompare);
  }
  for (const metric of snapshot.measurements ?? []) {
    if (Array.isArray(metric.source?.evidence_refs)) {
      metric.source.evidence_refs.sort(stableCompare);
    }
    if (Array.isArray(metric.source?.artifact_refs)) {
      metric.source.artifact_refs.sort(stableCompare);
    }
  }
  if (Array.isArray(snapshot.run_metadata?.cache?.collector_versions)) {
    snapshot.run_metadata.cache.collector_versions.sort(stableCompare);
  }
  return normalizeObjectKeys(snapshot);
}

function digest(prefix, value) {
  return `${prefix}${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function deriveRiskModelContractHash(riskModelId) {
  const definition = RISK_MODEL_DEFINITIONS[riskModelId];
  if (!definition) return null;
  return `sha256:${crypto.createHash("sha256").update(stableStringify({
    risk_model_id: riskModelId,
    model_version: definition.model_version,
    result_kind: definition.result_kind,
    interpretation_boundary: definition.interpretation_boundary,
  })).digest("hex")}`;
}

function cacheBindings(snapshot) {
  const collectors = Array.isArray(snapshot.collectors) ? snapshot.collectors : [];
  return {
    repository_revision: snapshot.repository?.revision,
    configuration_hash: snapshot.repository?.configuration_hash,
    schema_version: snapshot.schema_version,
    collector_versions: collectors
      .map((collector) => `${collector.collector_id}@${collector.collector_version}`)
      .sort(stableCompare),
    collector_fingerprints: collectors
      .map((collector) => stableStringify({
        collector_id: collector.collector_id,
        collector_version: collector.collector_version,
        analyzer_identity: collector.analyzer_identity,
        analyzer_version: collector.analyzer_version,
      }))
      .sort(stableCompare),
    history_boundary: snapshot.repository?.history_boundary,
  };
}

function deriveCacheKey(snapshot) {
  return digest("sei-cache-v1-", cacheBindings(snapshot));
}

function snapshotIdentityProjection(snapshot) {
  const projection = structuredClone(snapshot);
  delete projection.snapshot_id;
  if (isRecord(projection.run_metadata)) {
    delete projection.run_metadata.generated_at;
    if (isRecord(projection.run_metadata.cache)) {
      delete projection.run_metadata.cache.cache_key;
    }
  }
  return normalizeAndSort(projection);
}

function deriveSnapshotId(snapshot) {
  return digest("sei-v1-", snapshotIdentityProjection(snapshot));
}

function addStringArrayErrors(errors, value, path, failureCode) {
  if (!Array.isArray(value)) {
    errors.push(`${failureCode}: ${path} must be an array`);
    return;
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      errors.push(`${failureCode}: ${path}[${index}] must be a non-empty string`);
    }
  });
}

function addUniqueStringArrayErrors(errors, value, path, failureCode, { minimum = 0 } = {}) {
  addStringArrayErrors(errors, value, path, failureCode);
  if (!Array.isArray(value)) return;
  if (value.length < minimum) {
    errors.push(`${failureCode}: ${path} must contain at least ${minimum} item(s)`);
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) return;
    if (seen.has(item)) errors.push(`FAIL-DUPLICATE-ID: ${path}[${index}] duplicates ${item}`);
    seen.add(item);
  });
}

function stableIdSet(values) {
  return new Set((Array.isArray(values) ? values : []).filter(isNonEmptyString));
}

function snapshotEvidenceRefs(snapshot) {
  const refs = new Set();
  for (const metric of Array.isArray(snapshot?.measurements) ? snapshot.measurements : []) {
    for (const field of ["artifact_refs", "evidence_refs"]) {
      for (const ref of Array.isArray(metric?.source?.[field]) ? metric.source[field] : []) {
        if (isNonEmptyString(ref)) refs.add(ref);
      }
    }
  }
  return refs;
}

function validateBoundary(errors, boundary, path, failureCode = "FAIL-SNAPSHOT-CONTRACT") {
  if (!isRecord(boundary)) {
    errors.push(`${failureCode}: ${path} must be an object`);
    return;
  }
  validateAllowedKeys(errors, boundary, path, ["kind", "start", "end"], failureCode);
  addRequiredString(errors, boundary.kind, `${path}.kind`);
  for (const field of ["start", "end"]) {
    if (!(field in boundary)) {
      errors.push(`${failureCode}: ${path}.${field} is required`);
    } else if (boundary[field] !== null && !isNonEmptyString(boundary[field])) {
      errors.push(`${failureCode}: ${path}.${field} must be a non-empty string or null`);
    }
  }
}

function validateRepository(snapshot, errors) {
  const repository = snapshot.repository;
  validateAllowedKeys(errors, repository, "repository", [
    "repository_id",
    "revision",
    "configuration_hash",
    "history_boundary",
    "generated_path_patterns",
  ]);
  addRequiredString(errors, repository?.repository_id, "repository.repository_id");
  addRequiredString(errors, repository?.revision, "repository.revision");
  addRequiredString(errors, repository?.configuration_hash, "repository.configuration_hash");
  validateBoundary(errors, repository?.history_boundary, "repository.history_boundary");
  addStringArrayErrors(errors, repository?.generated_path_patterns, "repository.generated_path_patterns", "FAIL-SNAPSHOT-CONTRACT");
}

function validateCollector(collector, index, errors) {
  const path = `collectors[${index}]`;
  validateAllowedKeys(errors, collector, path, [
    "collector_id",
    "collector_version",
    "status",
    "analyzer_identity",
    "analyzer_version",
    "reason",
  ]);
  for (const field of ["collector_id", "collector_version", "analyzer_identity", "analyzer_version"]) {
    addRequiredString(errors, collector?.[field], `${path}.${field}`);
  }
  if (!COLLECTOR_STATUS.has(collector?.status)) {
    errors.push(`FAIL-COLLECTOR-CONTRACT: ${path}.status is unsupported`);
  }
  if (!isRecord(collector) || !("reason" in collector) || (collector.reason !== null && !isNonEmptyString(collector.reason))) {
    errors.push(`FAIL-COLLECTOR-CONTRACT: ${path}.reason must be a non-empty string or null`);
  }
  if (collector?.status === "available" && collector?.reason !== null) {
    errors.push(`FAIL-COLLECTOR-CONTRACT: ${path}.reason must be null for available`);
  }
  if (
    (collector?.status === "degraded" || collector?.status === "unavailable") &&
    !isNonEmptyString(collector?.reason)
  ) {
    errors.push(`FAIL-COLLECTOR-CONTRACT: ${path}.reason is required for ${collector.status}`);
  }
}

function validateMeasurement(metric, index, snapshot, collectorById, errors) {
  const path = `measurements[${index}]`;
  validateAllowedKeys(errors, metric, path, [
    "metric_id",
    "definition_id",
    "family",
    "subject",
    "repository_revision",
    "value",
    "unit",
    "measurement",
    "source",
    "scope",
    "window",
    "analyzer_identity",
    "analyzer_version",
    "comparability",
    "comparison",
  ], "FAIL-METRIC-CONTRACT");
  for (const field of [
    "definition_id",
    "family",
    "subject",
    "repository_revision",
    "unit",
    "analyzer_identity",
    "analyzer_version",
  ]) {
    addRequiredString(errors, metric?.[field], `${path}.${field}`);
  }
  if (metric?.repository_revision !== snapshot.repository?.revision) {
    errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path}.repository_revision does not match repository.revision`);
  }
  if (metric?.value !== null && (typeof metric?.value !== "number" || !Number.isFinite(metric.value))) {
    errors.push(`FAIL-METRIC-CONTRACT: ${path}.value must be a finite number or null`);
  }

  if (!isRecord(metric?.measurement)) {
    errors.push(`FAIL-METRIC-CONTRACT: ${path}.measurement must be an object`);
  } else {
    validateAllowedKeys(errors, metric.measurement, `${path}.measurement`, [
      "status",
      "completeness",
      "confidence",
      "reason",
    ], "FAIL-METRIC-CONTRACT");
    const { status, completeness, confidence, reason } = metric.measurement;
    if (!STATUS.has(status)) {
      errors.push(`FAIL-METRIC-CONTRACT: ${path}.measurement.status is unsupported`);
    }
    if (typeof completeness !== "number" || completeness < 0 || completeness > 1) {
      errors.push(`FAIL-METRIC-CONTRACT: ${path}.measurement.completeness must be between 0 and 1`);
    }
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      errors.push(`FAIL-METRIC-CONTRACT: ${path}.measurement.confidence must be between 0 and 1`);
    }
    if (!("reason" in metric.measurement) || (reason !== null && !isNonEmptyString(reason))) {
      errors.push(`FAIL-METRIC-CONTRACT: ${path}.measurement.reason must be a non-empty string or null`);
    }
    if (status === "measured" || status === "inferred") {
      if (metric.value === null || metric.value === undefined) {
        errors.push(`FAIL-MISSING-AS-ZERO: ${path}.value must be present for ${status}`);
      }
    } else if (STATUS.has(status)) {
      if (metric.value !== null) {
        errors.push(`FAIL-MISSING-AS-ZERO: ${path}.value must be null for ${status}`);
      }
      if (!isNonEmptyString(reason)) {
        errors.push(`FAIL-METRIC-CONTRACT: ${path}.measurement.reason is required for ${status}`);
      }
    }
  }

  if (!isRecord(metric?.source)) {
    errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path}.source must be an object`);
  } else {
    const source = metric.source;
    validateAllowedKeys(errors, source, `${path}.source`, [
      "kind",
      "collector_id",
      "collector_version",
      "repository_revision",
      "command",
      "artifact_refs",
      "evidence_refs",
    ], "FAIL-METRIC-WITHOUT-PROVENANCE");
    for (const field of ["kind", "collector_id", "collector_version", "repository_revision"]) {
      if (!isNonEmptyString(source[field])) {
        errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path}.source.${field} is required`);
      }
    }
    if (source.command !== null && !isNonEmptyString(source.command)) {
      errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path}.source.command must be a non-empty string or null`);
    }
    addUniqueStringArrayErrors(errors, source.artifact_refs, `${path}.source.artifact_refs`, "FAIL-METRIC-WITHOUT-PROVENANCE");
    if (source.evidence_refs !== undefined) {
      addUniqueStringArrayErrors(errors, source.evidence_refs, `${path}.source.evidence_refs`, "FAIL-METRIC-WITHOUT-PROVENANCE");
    }
    if (source.command === null && (!Array.isArray(source.artifact_refs) || source.artifact_refs.length === 0)) {
      errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path}.source requires a command or at least one artifact reference`);
    }
    if (source.repository_revision !== snapshot.repository?.revision) {
      errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path}.source.repository_revision does not match repository.revision`);
    }
    const collector = collectorById.get(source.collector_id);
    if (!collector || collector.collector_version !== source.collector_version) {
      errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path}.source collector identity is not bound to collectors`);
    } else {
      if (collector.analyzer_identity !== metric.analyzer_identity || collector.analyzer_version !== metric.analyzer_version) {
        errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path}.analyzer identity/version is not bound to its collector`);
      }
      if (
        collector.status === "unavailable" &&
        (metric.measurement?.status === "measured" || metric.measurement?.status === "inferred")
      ) {
        errors.push(`FAIL-METRIC-WITHOUT-PROVENANCE: ${path} cannot be ${metric.measurement.status} from an unavailable collector`);
      }
    }
  }

  if (!isRecord(metric?.comparability)) {
    errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparability must be an object`);
  } else {
    const comparability = metric.comparability;
    validateAllowedKeys(errors, comparability, `${path}.comparability`, [
      "analyzer_identity",
      "analyzer_version",
      "configuration_hash",
      "compatible_with_prior",
      "reason",
    ], "FAIL-INCOMPATIBLE-COMPARISON");
    if (comparability.analyzer_identity !== metric.analyzer_identity) {
      errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparability.analyzer_identity does not match the metric analyzer`);
    }
    if (comparability.analyzer_version !== metric.analyzer_version) {
      errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparability.analyzer_version does not match the metric analyzer`);
    }
    if (comparability.configuration_hash !== snapshot.repository?.configuration_hash) {
      errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparability.configuration_hash does not match repository configuration`);
    }
    if (typeof comparability.compatible_with_prior !== "boolean") {
      errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparability.compatible_with_prior must be boolean`);
    }
    if (!isNonEmptyString(comparability.reason)) {
      errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparability.reason is required`);
    }
  }

  if (!isRecord(metric?.scope)) {
    errors.push(`FAIL-METRIC-CONTRACT: ${path}.scope must be an object`);
  } else {
    validateAllowedKeys(errors, metric.scope, `${path}.scope`, [
      "kind",
      "path",
      "language",
      "generated_code",
      "included_in_human_maintainability",
      "generated_code_inclusion_reason",
    ], "FAIL-METRIC-CONTRACT");
    addRequiredString(errors, metric.scope.kind, `${path}.scope.kind`);
    if (typeof metric.scope.path !== "string") {
      errors.push(`FAIL-METRIC-CONTRACT: ${path}.scope.path must be a string`);
    }
    if (metric.scope.language !== null && typeof metric.scope.language !== "string") {
      errors.push(`FAIL-METRIC-CONTRACT: ${path}.scope.language must be a string or null`);
    }
    if (
      "generated_code_inclusion_reason" in metric.scope &&
      !isNonEmptyString(metric.scope.generated_code_inclusion_reason)
    ) {
      errors.push(`FAIL-GENERATED-CODE-SCOPE: ${path}.scope.generated_code_inclusion_reason must be a non-empty string when present`);
    }
    if (typeof metric.scope.generated_code !== "boolean") {
      errors.push(`FAIL-GENERATED-CODE-SCOPE: ${path}.scope.generated_code must be boolean`);
    }
    if (typeof metric.scope.included_in_human_maintainability !== "boolean") {
      errors.push(`FAIL-GENERATED-CODE-SCOPE: ${path}.scope.included_in_human_maintainability must be boolean`);
    }
    if (
      metric.scope.generated_code === true &&
      metric.scope.included_in_human_maintainability === true &&
      !isNonEmptyString(metric.scope.generated_code_inclusion_reason)
    ) {
      errors.push(`FAIL-GENERATED-CODE-CONTAMINATION: ${path}.scope requires an explicit inclusion reason`);
    }
  }
  if (!isRecord(metric?.window)) {
    errors.push(`FAIL-METRIC-CONTRACT: ${path}.window must be an object`);
  } else {
    validateAllowedKeys(errors, metric.window, `${path}.window`, ["kind", "start", "end"], "FAIL-METRIC-CONTRACT");
    addRequiredString(errors, metric.window.kind, `${path}.window.kind`);
    for (const field of ["start", "end"]) {
      if (!(field in metric.window)) {
        errors.push(`FAIL-METRIC-CONTRACT: ${path}.window.${field} is required`);
      } else if (metric.window[field] !== null && !isNonEmptyString(metric.window[field])) {
        errors.push(`FAIL-METRIC-CONTRACT: ${path}.window.${field} must be a non-empty string or null`);
      }
    }
  }

  if (metric?.comparison !== undefined) {
    if (!isRecord(metric.comparison)) {
      errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison must be an object`);
    } else {
      validateAllowedKeys(errors, metric.comparison, `${path}.comparison`, [
        "baseline_snapshot_id",
        "baseline_metric_id",
        "analyzer_identity",
        "analyzer_version",
        "configuration_hash",
        "binding_kind",
        "baseline_repository_revision",
        "baseline_value",
        "delta",
        "confidence",
      ], "FAIL-INCOMPATIBLE-COMPARISON");
      addRequiredString(errors, metric.comparison.baseline_snapshot_id, `${path}.comparison.baseline_snapshot_id`);
      addRequiredString(errors, metric.comparison.baseline_metric_id, `${path}.comparison.baseline_metric_id`);
      if (metric.comparison.analyzer_identity !== metric.analyzer_identity) {
        errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.analyzer_identity does not match the metric analyzer`);
      }
      if (metric.comparison.analyzer_version !== metric.analyzer_version) {
        errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.analyzer_version does not match the metric analyzer`);
      }
      if (metric.comparison.configuration_hash !== snapshot.repository?.configuration_hash) {
        errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.configuration_hash does not match repository configuration`);
      }
      if (metric.comparison.baseline_metric_id !== metric.metric_id) {
        errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.baseline_metric_id does not match metric_id`);
      }
      if (metric.comparability?.compatible_with_prior !== true) {
        errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison requires compatible_with_prior`);
      }
      const factualFields = [
        "binding_kind",
        "baseline_repository_revision",
        "baseline_value",
        "delta",
        "confidence",
      ];
      const factualFieldCount = factualFields.filter((field) => Object.hasOwn(metric.comparison, field)).length;
      if (factualFieldCount !== 0 && factualFieldCount !== factualFields.length) {
        errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison factual binding fields must be complete`);
      }
      if (factualFieldCount === factualFields.length) {
        const comparison = metric.comparison;
        if (comparison.binding_kind !== "explicit" && comparison.binding_kind !== "automatic") {
          errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.binding_kind is unsupported`);
        }
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(comparison.baseline_repository_revision)) {
          errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.baseline_repository_revision must be a full commit ID`);
        }
        if (comparison.baseline_repository_revision === snapshot.repository?.revision) {
          errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.baseline_repository_revision must differ from the current revision`);
        }
        for (const field of ["baseline_value", "delta", "confidence"]) {
          if (typeof comparison[field] !== "number" || !Number.isFinite(comparison[field])) {
            errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.${field} must be finite`);
          }
        }
        if (
          typeof comparison.baseline_value === "number" && Number.isFinite(comparison.baseline_value) &&
          typeof comparison.delta === "number" && Number.isFinite(comparison.delta) &&
          comparison.delta !== metric.value - comparison.baseline_value
        ) {
          errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.delta does not equal current value minus baseline value`);
        }
        if (
          typeof comparison.confidence === "number" &&
          (comparison.confidence < 0 || comparison.confidence > 1 || comparison.confidence > metric.measurement?.confidence)
        ) {
          errors.push(`FAIL-INCOMPATIBLE-COMPARISON: ${path}.comparison.confidence exceeds the current measurement confidence bound`);
        }
        const baselineMetadata = snapshot.run_metadata?.trend_baseline;
        if (!isRecord(baselineMetadata)) {
          errors.push(`FAIL-TREND-BASELINE-METADATA: ${path}.comparison requires run_metadata.trend_baseline`);
        } else {
          if (comparison.binding_kind !== baselineMetadata.binding_kind) {
            errors.push(`FAIL-TREND-BASELINE-METADATA: ${path}.comparison.binding_kind differs from run metadata`);
          }
          if (comparison.baseline_snapshot_id !== baselineMetadata.baseline_snapshot_id) {
            errors.push(`FAIL-TREND-BASELINE-METADATA: ${path}.comparison.baseline_snapshot_id differs from run metadata`);
          }
          if (comparison.baseline_repository_revision !== baselineMetadata.baseline_repository_revision) {
            errors.push(`FAIL-TREND-BASELINE-METADATA: ${path}.comparison.baseline_repository_revision differs from run metadata`);
          }
        }
      } else if (snapshot.run_metadata?.trend_baseline !== undefined) {
        errors.push(`FAIL-TREND-BASELINE-METADATA: ${path}.comparison must carry factual binding fields when trend metadata is present`);
      }
    }
  }
}

function canonicalRelativeFilePath(value) {
  if (!isNonEmptyString(value)) return null;
  const slashNormalized = value.trim().replace(/\\/g, "/");
  if (slashNormalized.startsWith("/") || /^[A-Za-z]:\//.test(slashNormalized)) return null;
  const segments = slashNormalized.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const canonical = segments.filter((segment) => segment.length > 0 && segment !== ".");
  return canonical.length > 0 ? canonical.join("/") : null;
}

function canonicalFileSubject(value) {
  if (typeof value !== "string" || !value.startsWith("file:")) return null;
  const filePath = canonicalRelativeFilePath(value.slice("file:".length));
  return filePath === null ? null : `file:${filePath}`;
}

function metricEvidenceRefs(metric) {
  return stableIdSet([
    ...(Array.isArray(metric?.source?.artifact_refs) ? metric.source.artifact_refs : []),
    ...(Array.isArray(metric?.source?.evidence_refs) ? metric.source.evidence_refs : []),
  ]);
}

function semanticFeatureEvidence(snapshot, metric, collectorById) {
  const collector = collectorById.get(metric?.source?.collector_id);
  const revision = snapshot?.repository?.revision;
  const bindingValid = collector !== undefined
    && metric?.repository_revision === revision
    && metric?.source?.repository_revision === revision
    && metric?.window?.end === revision
    && metric?.comparability?.configuration_hash === snapshot?.repository?.configuration_hash
    && collector.collector_version === metric?.source?.collector_version
    && collector.analyzer_identity === metric?.analyzer_identity
    && collector.analyzer_version === metric?.analyzer_version;
  try {
    return interpretEvidence({
      value: metric?.value,
      measurement: {
        status: metric?.measurement?.status,
        completeness: metric?.measurement?.completeness,
        confidence: metric?.measurement?.confidence,
      },
      collector: { status: collector?.status, binding_valid: bindingValid },
      condition: { kind: "observed", code: null },
      source_metric_ids: [metric?.metric_id],
      evidence_refs: [...metricEvidenceRefs(metric)],
      exclusions: [],
    });
  } catch (error) {
    if (error?.code === "FAIL-SEMANTIC-EVIDENCE") return null;
    throw error;
  }
}

function isFeatureMetricEligible(snapshot, metric, collectorById) {
  const subject = canonicalFileSubject(metric?.subject);
  return (
    subject !== null &&
    metric?.scope?.kind === "file" &&
    canonicalRelativeFilePath(metric.scope.path) === subject.slice("file:".length) &&
    metric.scope.generated_code === false &&
    metric.scope.included_in_human_maintainability === true &&
    semanticFeatureEvidence(snapshot, metric, collectorById)?.usable === true
  );
}

function expectedFeatureCohort(snapshot, metric, collectorById, cohortCache = null) {
  const cacheKey = `${metric?.definition_id ?? ""}\u0000${metric?.unit ?? ""}`;
  if (cohortCache?.has(cacheKey)) return cohortCache.get(cacheKey);
  const bySubject = new Map();
  let duplicateSubject = false;
  for (const candidate of Array.isArray(snapshot?.measurements) ? snapshot.measurements : []) {
    if (!isFeatureMetricEligible(snapshot, candidate, collectorById)) continue;
    if (candidate.definition_id !== metric.definition_id || candidate.unit !== metric.unit) continue;
    const subject = canonicalFileSubject(candidate.subject);
    if (bySubject.has(subject)) duplicateSubject = true;
    bySubject.set(subject, candidate.value);
  }
  const result = { values: [...bySubject.values()], duplicateSubject };
  cohortCache?.set(cacheKey, result);
  return result;
}

function expectedFeatureInterpretation(metric) {
  const identity = `${metric?.metric_id ?? ""} ${metric?.definition_id ?? ""}`.toLowerCase();
  if (identity.includes("lexical") || identity.includes("nesting")) return "lexical structural proxy";
  if (identity.includes("coverage")) return "observed coverage only";
  if (identity.includes("test") && (identity.includes("count") || identity.includes("number"))) return "observed test count only";
  if (identity.includes("churn") || identity.includes("change_frequency")) return "observed change activity";
  return "observed metric";
}

function expectedPercentile(value, peers) {
  if (typeof value !== "number" || !Number.isFinite(value) || peers.length === 0) return null;
  return Number((peers.filter((peer) => peer <= value).length / peers.length).toFixed(6));
}

function validateRiskFeature(feature, path, recordSubject, snapshot, metricById, collectorById, evidenceRefs, errors, cohortCache) {
  validateAllowedKeys(errors, feature, path, [
    "metric_id",
    "definition_id",
    "value",
    "unit",
    "measurement_status",
    "percentile",
    "cohort_size",
    "analyzer_identity",
    "analyzer_version",
    "evidence_refs",
    "interpretation",
  ], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  for (const field of ["metric_id", "definition_id", "unit", "measurement_status", "interpretation"]) {
    addRequiredString(errors, feature?.[field], `${path}.${field}`);
  }
  if (typeof feature?.value !== "number" || !Number.isFinite(feature.value)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.value must be a finite number`);
  }
  if (!OBSERVED_MEASUREMENT_STATUS.has(feature?.measurement_status)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.measurement_status must be measured or inferred`);
  }
  if (feature?.percentile !== null && (typeof feature?.percentile !== "number" || feature.percentile < 0 || feature.percentile > 1)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.percentile must be between 0 and 1 or null`);
  }
  if (!Number.isInteger(feature?.cohort_size) || feature.cohort_size < 0) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.cohort_size must be a non-negative integer`);
  }
  if (feature?.analyzer_identity !== null && !isNonEmptyString(feature?.analyzer_identity)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.analyzer_identity must be a non-empty string or null`);
  }
  if (feature?.analyzer_version !== null && !isNonEmptyString(feature?.analyzer_version)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.analyzer_version must be a non-empty string or null`);
  }
  addUniqueStringArrayErrors(errors, feature?.evidence_refs, `${path}.evidence_refs`, "FAIL-DERIVED-INTELLIGENCE-CONTRACT");
  const metric = metricById.get(feature?.metric_id);
  if (!metric) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.metric_id does not resolve to a snapshot measurement`);
    return;
  }
  for (const [field, expected] of [
    ["definition_id", metric.definition_id],
    ["unit", metric.unit],
    ["measurement_status", metric.measurement?.status],
    ["analyzer_identity", metric.analyzer_identity],
    ["analyzer_version", metric.analyzer_version],
  ]) {
    if (feature?.[field] !== expected) {
      errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.${field} is not bound to ${feature.metric_id}`);
    }
  }
  if (recordSubject !== metric.subject) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path} record subject does not match ${feature.metric_id}`);
  }
  if (feature?.value !== metric.value) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.value is not the observed ${feature.metric_id} value`);
  }
  if (!isFeatureMetricEligible(snapshot, metric, collectorById)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-EVIDENCE: ${path}.metric_id is not an eligible human file observation`);
  }
  const cohort = expectedFeatureCohort(snapshot, metric, collectorById, cohortCache);
  if (cohort.duplicateSubject) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-EVIDENCE: ${path}.metric_id has an ambiguous file cohort`);
  }
  const expectedCohortSize = cohort.values.length;
  const expected = expectedPercentile(metric.value, cohort.values);
  if (feature?.cohort_size !== expectedCohortSize) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-EVIDENCE: ${path}.cohort_size is not derived from the observed cohort`);
  }
  if (feature?.percentile !== expected) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-EVIDENCE: ${path}.percentile is not derived from the observed cohort`);
  }
  if (feature?.interpretation !== expectedFeatureInterpretation(metric)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.interpretation is not the declared metric interpretation`);
  }
  const metricRefs = metricEvidenceRefs(metric);
  for (const ref of Array.isArray(feature?.evidence_refs) ? feature.evidence_refs : []) {
    if (!evidenceRefs.has(ref) || !metricRefs.has(ref)) {
      errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.evidence_refs contains an unbound reference`);
    }
  }
}

function expectedHotspotSignals(features) {
  const vector = Array.isArray(features) ? features : [];
  const churn = vector.find((feature) => /(?:^|\.)churn(?::|$)/.test(feature?.metric_id ?? ""));
  const structural = vector.find((feature) => /lexical_max_nesting_depth|source_lines/.test(feature?.metric_id ?? ""));
  if (
    (churn?.cohort_size ?? 0) >= 3 &&
    (structural?.cohort_size ?? 0) >= 3 &&
    (churn?.percentile ?? 0) >= 0.8 &&
    (structural?.percentile ?? 0) >= 0.8
  ) {
    return [{
      signal_id: "coincident-change-and-structure",
      basis_metric_ids: [churn.metric_id, structural.metric_id].sort(stableCompare),
      interpretation: "review-attention signal only; not a defect probability or candidate priority",
    }];
  }
  return [];
}

function validateHotspotRecord(record, path, snapshot, metricById, collectorById, evidenceRefs, errors, cohortCache) {
  validateAllowedKeys(errors, record, path, ["subject", "features", "hotspot_signals"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  addRequiredString(errors, record?.subject, `${path}.subject`);
  if (!Array.isArray(record?.features)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.features must be an array`);
  } else {
    record.features.forEach((feature, index) => validateRiskFeature(feature, `${path}.features[${index}]`, record.subject, snapshot, metricById, collectorById, evidenceRefs, errors, cohortCache));
  }
  if (!Array.isArray(record?.hotspot_signals)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.hotspot_signals must be an array`);
    return;
  }
  const signalIds = new Set();
  const featureMetricIds = stableIdSet(record.features?.map((feature) => feature?.metric_id));
  record.hotspot_signals.forEach((signal, index) => {
    const signalPath = `${path}.hotspot_signals[${index}]`;
    validateAllowedKeys(errors, signal, signalPath, ["signal_id", "basis_metric_ids", "interpretation"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
    addRequiredString(errors, signal?.signal_id, `${signalPath}.signal_id`);
    if (isNonEmptyString(signal?.signal_id) && signalIds.has(signal.signal_id)) {
      errors.push(`FAIL-DUPLICATE-ID: ${signalPath}.signal_id duplicates ${signal.signal_id}`);
    }
    signalIds.add(signal?.signal_id);
    addUniqueStringArrayErrors(errors, signal?.basis_metric_ids, `${signalPath}.basis_metric_ids`, "FAIL-DERIVED-INTELLIGENCE-CONTRACT");
    addRequiredString(errors, signal?.interpretation, `${signalPath}.interpretation`);
    for (const metricId of Array.isArray(signal?.basis_metric_ids) ? signal.basis_metric_ids : []) {
      if (!metricById.has(metricId)) {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${signalPath}.basis_metric_ids contains an unknown metric`);
      }
      if (!featureMetricIds.has(metricId)) {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${signalPath}.basis_metric_ids must bind to this vector`);
      }
    }
  });
  if (stableStringify(record.hotspot_signals) !== stableStringify(expectedHotspotSignals(record.features))) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-EVIDENCE: ${path}.hotspot_signals are not derivable from the bound vector`);
  }
}

function validateTemporalCouplingRecord(record, path, errors) {
  validateAllowedKeys(errors, record, path, [
    "kind",
    "source",
    "target",
    "co_change_count",
    "coupling_ratio",
    "policy_status",
    "policy_reason",
  ], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  if (record?.kind !== "temporal_coupling") {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.kind must equal temporal_coupling`);
  }
  for (const field of ["source", "target"]) addRequiredString(errors, record?.[field], `${path}.${field}`);
  if (!Number.isInteger(record?.co_change_count) || record.co_change_count < 0) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.co_change_count must be a non-negative integer`);
  }
  if (typeof record?.coupling_ratio !== "number" || !Number.isFinite(record.coupling_ratio) || record.coupling_ratio < 0 || record.coupling_ratio > 1) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.coupling_ratio must be between 0 and 1`);
  }
  if (record?.policy_status !== undefined && !POLICY_STATUS.has(record.policy_status)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.policy_status is unsupported`);
  }
  if (record?.policy_status !== undefined && !isNonEmptyString(record?.policy_reason)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.policy_reason is required with policy_status`);
  }
  if (record?.policy_status === undefined && record?.policy_reason !== undefined) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.policy_reason requires policy_status`);
  }
}

function validateProbabilityRecord(record, path, metricById, evidenceRefs, errors) {
  validateAllowedKeys(errors, record, path, ["subject", "probability", "evidence_metric_ids", "evidence_refs"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  addRequiredString(errors, record?.subject, `${path}.subject`);
  if (typeof record?.probability !== "number" || !Number.isFinite(record.probability) || record.probability < 0 || record.probability > 1) {
    errors.push(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${path}.probability must be between 0 and 1`);
  }
  addUniqueStringArrayErrors(errors, record?.evidence_metric_ids, `${path}.evidence_metric_ids`, "FAIL-DERIVED-INTELLIGENCE-CONTRACT", { minimum: 1 });
  addUniqueStringArrayErrors(errors, record?.evidence_refs, `${path}.evidence_refs`, "FAIL-DERIVED-INTELLIGENCE-CONTRACT", { minimum: 1 });
  for (const metricId of Array.isArray(record?.evidence_metric_ids) ? record.evidence_metric_ids : []) {
    if (!metricById.has(metricId)) errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.evidence_metric_ids contains an unknown metric`);
  }
  for (const ref of Array.isArray(record?.evidence_refs) ? record.evidence_refs : []) {
    if (!evidenceRefs.has(ref)) errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.evidence_refs contains an unbound reference`);
  }
}

function validateMassChangePolicy(policy, path, errors) {
  validateAllowedKeys(errors, policy, path, [
    "policy_id",
    "policy_version",
    "policy_hash",
    "threshold",
    "action",
    "total_commit_count",
    "eligible_commit_count",
    "mass_commit_count",
    "excluded_pairwise_count",
    "down_weighted_pairwise_count",
    "reason",
  ], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  for (const field of ["policy_id", "policy_version", "policy_hash", "reason"]) addRequiredString(errors, policy?.[field], `${path}.${field}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(policy?.policy_hash ?? "")) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.policy_hash must be a sha256 digest`);
  }
  if (!Number.isInteger(policy?.threshold) || policy.threshold < 1) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.threshold must be a positive integer`);
  }
  if (!["exclude", "down_weight", "retain"].includes(policy?.action)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.action is unsupported`);
  }
  for (const field of ["total_commit_count", "eligible_commit_count", "mass_commit_count", "excluded_pairwise_count", "down_weighted_pairwise_count"]) {
    if (!Number.isInteger(policy?.[field]) || policy[field] < 0) {
      errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.${field} must be a non-negative integer`);
    }
  }
  if (policy?.eligible_commit_count > policy?.total_commit_count || policy?.mass_commit_count > policy?.total_commit_count) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path} commit counts exceed total_commit_count`);
  }
  if (policy?.action === "exclude" && policy?.down_weighted_pairwise_count !== 0) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.exclude policy cannot down-weight pairwise work`);
  }
  if (policy?.action === "down_weight" && policy?.excluded_pairwise_count !== 0) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.down_weight policy cannot exclude pairwise work`);
  }
  if (policy?.action === "retain" && (policy?.excluded_pairwise_count !== 0 || policy?.down_weighted_pairwise_count !== 0)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.retain policy cannot alter pairwise work`);
  }
}

function validateCalibration(calibration, path, evidenceRefs, errors) {
  validateAllowedKeys(errors, calibration, path, [
    "calibration_id",
    "calibration_hash",
    "method",
    "training_ids",
    "holdout_ids",
    "evidence_refs",
  ], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  for (const field of ["calibration_id", "calibration_hash", "method"]) addRequiredString(errors, calibration?.[field], `${path}.${field}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(calibration?.calibration_hash ?? "")) {
    errors.push(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${path}.calibration_hash must be a sha256 digest`);
  }
  addUniqueStringArrayErrors(errors, calibration?.training_ids, `${path}.training_ids`, "FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION", { minimum: 1 });
  addUniqueStringArrayErrors(errors, calibration?.holdout_ids, `${path}.holdout_ids`, "FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION", { minimum: 1 });
  addUniqueStringArrayErrors(errors, calibration?.evidence_refs, `${path}.evidence_refs`, "FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION", { minimum: 1 });
  const training = stableIdSet(calibration?.training_ids);
  for (const holdoutId of Array.isArray(calibration?.holdout_ids) ? calibration.holdout_ids : []) {
    if (training.has(holdoutId)) errors.push(`FAIL-TRAIN-TEST-LEAKAGE: ${path}.training_ids overlaps holdout_ids at ${holdoutId}`);
  }
  for (const ref of Array.isArray(calibration?.evidence_refs) ? calibration.evidence_refs : []) {
    if (!evidenceRefs.has(ref)) errors.push(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${path}.evidence_refs contains an unbound reference`);
  }
}

function validateRiskModel(model, index, snapshot, metricById, collectorById, evidenceRefs, resultIds, errors, cohortCache) {
  const path = `risk_models[${index}]`;
  validateAllowedKeys(errors, model, path, [
    "risk_model_id",
    "model_version",
    "model_contract_hash",
    "model_status",
    "calibration",
    "result",
  ], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  const definition = RISK_MODEL_DEFINITIONS[model?.risk_model_id];
  if (!definition) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.risk_model_id is not a declared model`);
  }
  for (const field of ["risk_model_id", "model_version", "model_contract_hash"]) addRequiredString(errors, model?.[field], `${path}.${field}`);
  if (!RISK_MODEL_STATUS.has(model?.model_status)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.model_status is unsupported`);
  }
  if (definition && model?.model_version !== definition.model_version) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.model_version does not match ${model.risk_model_id}`);
  }
  if (definition && model?.model_contract_hash !== deriveRiskModelContractHash(model.risk_model_id)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.model_contract_hash does not match ${model.risk_model_id}`);
  }
  if (model?.model_status === "calibrated" || model?.model_status === "validated") {
    if (!isRecord(model?.calibration)) {
      errors.push(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${path}.${model.model_status} claims require independent calibration evidence`);
    } else {
      validateCalibration(model.calibration, `${path}.calibration`, evidenceRefs, errors);
    }
    errors.push(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${path}.risk_model_id has no declared calibrated or validated model contract`);
  } else if (model?.calibration !== null) {
    errors.push(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${path}.calibration must be null unless a calibrated or validated contract is declared`);
  }

  const result = model?.result;
  if (!isRecord(result)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${path}.result must be an object`);
    return;
  }
  const resultPath = `${path}.result`;
  validateAllowedKeys(errors, result, resultPath, [
    "result_id",
    "kind",
    "status",
    "repository_revision",
    "evidence_metric_ids",
    "evidence_refs",
    "interpretation_boundary",
    "records",
    "mass_change_policy",
  ], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  for (const field of ["result_id", "kind", "repository_revision", "interpretation_boundary"]) addRequiredString(errors, result?.[field], `${resultPath}.${field}`);
  if (isNonEmptyString(result?.result_id) && resultIds.has(result.result_id)) {
    errors.push(`FAIL-DUPLICATE-ID: ${resultPath}.result_id duplicates ${result.result_id}`);
  }
  resultIds.add(result?.result_id);
  if (!RISK_RESULT_STATUS.has(result?.status)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${resultPath}.status is unsupported`);
  }
  if (definition && result?.kind !== definition.result_kind) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${resultPath}.kind does not match ${model.risk_model_id}`);
  }
  if (definition && result?.interpretation_boundary !== definition.interpretation_boundary) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${resultPath}.interpretation_boundary does not match ${model.risk_model_id}`);
  }
  if (result?.repository_revision !== snapshot.repository?.revision) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${resultPath}.repository_revision does not match repository.revision`);
  }
  addUniqueStringArrayErrors(errors, result?.evidence_metric_ids, `${resultPath}.evidence_metric_ids`, "FAIL-DERIVED-INTELLIGENCE-CONTRACT");
  addUniqueStringArrayErrors(errors, result?.evidence_refs, `${resultPath}.evidence_refs`, "FAIL-DERIVED-INTELLIGENCE-CONTRACT");
  for (const metricId of Array.isArray(result?.evidence_metric_ids) ? result.evidence_metric_ids : []) {
    if (!metricById.has(metricId)) errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${resultPath}.evidence_metric_ids contains an unknown metric`);
  }
  for (const ref of Array.isArray(result?.evidence_refs) ? result.evidence_refs : []) {
    if (!evidenceRefs.has(ref)) errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${resultPath}.evidence_refs contains an unbound reference`);
  }
  if (result?.status === "available" && (
    !Array.isArray(result?.evidence_metric_ids) || result.evidence_metric_ids.length === 0 ||
    !Array.isArray(result?.evidence_refs) || result.evidence_refs.length === 0
  )) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${resultPath}.available results require metric and source evidence bindings`);
  }
  if ((result?.status === "unavailable" || result?.status === "unverifiable") && Array.isArray(result?.records) && result.records.length > 0) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${resultPath}.${result.status} results cannot include records`);
  }
  if ((model?.model_status === "unavailable" || model?.model_status === "unverifiable") && result?.status !== model.model_status) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${resultPath}.status must match unavailable model status`);
  }
  if (result?.kind === "probability") {
    errors.push(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${resultPath}.probability results require a separately declared validated model contract`);
  }
  if (!Array.isArray(result?.records)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${resultPath}.records must be an array`);
  } else if (result.kind === "heuristic_hotspot_vectors") {
    const subjects = new Set();
    result.records.forEach((record, recordIndex) => {
      const recordPath = `${resultPath}.records[${recordIndex}]`;
      validateHotspotRecord(record, recordPath, snapshot, metricById, collectorById, evidenceRefs, errors, cohortCache);
      if (isNonEmptyString(record?.subject) && subjects.has(record.subject)) {
        errors.push(`FAIL-DUPLICATE-ID: ${recordPath}.subject duplicates ${record.subject}`);
      }
      subjects.add(record?.subject);
    });
  } else if (result.kind === "temporal_coupling_pressure") {
    const relationships = new Set();
    result.records.forEach((record, recordIndex) => {
      const recordPath = `${resultPath}.records[${recordIndex}]`;
      validateTemporalCouplingRecord(record, recordPath, errors);
      const identity = `${record?.source ?? ""}\u0000${record?.target ?? ""}`;
      if (relationships.has(identity)) errors.push(`FAIL-DUPLICATE-ID: ${recordPath} duplicates temporal relationship`);
      relationships.add(identity);
    });
  } else if (result.kind === "engineering_investigation_signals") {
    if (result.records.length > 25) errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${resultPath}.records exceeds 25 bounded signals`);
    const signalIds = new Set();
    result.records.forEach((record, recordIndex) => {
      const recordPath = `${resultPath}.records[${recordIndex}]`;
      validateAllowedKeys(errors, record, recordPath, ["signal_id", "signal_type", "subject", "observations", "coverage", "confidence", "evidence_refs", "interpretation", "suggested_investigation"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
      for (const field of ["signal_id", "signal_type", "subject", "confidence", "interpretation", "suggested_investigation"]) addRequiredString(errors, record?.[field], `${recordPath}.${field}`);
      if (!/^sha256:[a-f0-9]{64}$/.test(record?.signal_id ?? "")) errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${recordPath}.signal_id must be a sha256 digest`);
      if (signalIds.has(record?.signal_id)) errors.push(`FAIL-DUPLICATE-ID: ${recordPath}.signal_id duplicates ${record.signal_id}`);
      signalIds.add(record?.signal_id);
      addUniqueStringArrayErrors(errors, record?.evidence_refs, `${recordPath}.evidence_refs`, "FAIL-DERIVED-INTELLIGENCE-CONTRACT", { minimum: 1 });
      if (!new Set(["high", "medium"]).has(record?.confidence)) {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${recordPath}.confidence is invalid`);
      }
      for (const ref of Array.isArray(record?.evidence_refs) ? record.evidence_refs : []) {
        if (!result.evidence_refs.includes(ref) || !evidenceRefs.has(ref)) errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${recordPath}.evidence_refs contains an unbound reference`);
      }
      if (!Array.isArray(record?.observations) || record.observations.length < 2) errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${recordPath}.observations needs at least two independent signals`);
      let hasDegradedObservation = false;
      const observationKinds = new Set();
      for (const [observationIndex, observation] of (Array.isArray(record?.observations) ? record.observations : []).entries()) {
        const observationPath = `${recordPath}.observations[${observationIndex}]`;
        validateAllowedKeys(errors, observation, observationPath, ["kind", "status", "value", "coverage", "confidence", "semantic_state", "evidence_refs"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
        addRequiredString(errors, observation?.kind, `${observationPath}.kind`);
        if (isNonEmptyString(observation?.kind) && observationKinds.has(observation.kind)) {
          errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${observationPath}.kind duplicates a signal kind within the record`);
        }
        observationKinds.add(observation?.kind);
        addRequiredString(errors, observation?.status, `${observationPath}.status`);
        if (!INVESTIGATION_OBSERVATION_STATUS.has(observation?.status)) errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${observationPath}.status is invalid`);
        const hasUncertainty = Object.hasOwn(observation ?? {}, "coverage")
          || Object.hasOwn(observation ?? {}, "confidence") || Object.hasOwn(observation ?? {}, "semantic_state");
        if (observation?.status === "measured") {
          if (!Number.isFinite(observation?.value) || observation.value < 0 || observation.value > 1) errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${observationPath}.value must be a finite normalized number when measured`);
          if (hasUncertainty) errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${observationPath} measured evidence cannot declare partial uncertainty`);
        } else if (observation?.status === "degraded" && Number.isFinite(observation?.value)) {
          hasDegradedObservation = true;
          if (observation.value < 0 || observation.value > 1
              || !Number.isFinite(observation.coverage) || observation.coverage < 0.9 || observation.coverage > 1
              || !Number.isFinite(observation.confidence) || observation.confidence < 0.9 || observation.confidence > 1
              || (observation.coverage === 1 && observation.confidence === 1)
              || observation.semantic_state !== "strong-partial") {
            errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${observationPath} degraded numeric evidence must declare matching strong-partial coverage and confidence`);
          }
        } else if (observation?.value !== null) {
          errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${observationPath}.value must be null unless measured`);
        } else if (hasUncertainty) {
          errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${observationPath} nonnumeric evidence cannot declare numeric uncertainty`);
        }
        if (observation?.status === "degraded") hasDegradedObservation = true;
        addUniqueStringArrayErrors(errors, observation?.evidence_refs, `${observationPath}.evidence_refs`, "FAIL-DERIVED-INTELLIGENCE-CONTRACT", { minimum: 1 });
        for (const ref of Array.isArray(observation?.evidence_refs) ? observation.evidence_refs : []) {
          if (!(Array.isArray(record?.evidence_refs) && record.evidence_refs.includes(ref)) || !(Array.isArray(result?.evidence_refs) && result.evidence_refs.includes(ref)) || !evidenceRefs.has(ref)) errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${observationPath}.evidence_refs contains an unbound reference`);
        }
      }
      if (hasDegradedObservation && record?.confidence !== "medium") {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${recordPath}.confidence must be medium when any observation is degraded`);
      }
      if (!isRecord(record?.coverage) || record.coverage.observed !== record?.observations?.length || record.coverage.required < 2 || record.coverage.ratio !== 1) {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${recordPath}.coverage must describe complete multi-signal evidence`);
      }
    });
  } else if (result.kind === "probability") {
    result.records.forEach((record, recordIndex) => validateProbabilityRecord(record, `${resultPath}.records[${recordIndex}]`, metricById, evidenceRefs, errors));
  }
  if (result?.mass_change_policy !== undefined) {
    if (result.kind !== "temporal_coupling_pressure") {
      errors.push(`FAIL-DERIVED-INTELLIGENCE-CONTRACT: ${resultPath}.mass_change_policy is only valid for temporal coupling`);
    }
    validateMassChangePolicy(result.mass_change_policy, `${resultPath}.mass_change_policy`, errors);
  }
}

function validateProfileEvidence(item, path, expectedDimension, metricById, errors) {
  const boundRefs = [];
  validateAllowedKeys(errors, item, path, ["kind", "dimension", "status", "evidence_refs", "metric_id"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  for (const field of ["kind", "dimension", "status"]) addRequiredString(errors, item?.[field], `${path}.${field}`);
  if (!OBSERVED_MEASUREMENT_STATUS.has(item?.status)) {
    errors.push(`FAIL-PROFILE-CONTRACT: ${path}.status must be measured or inferred`);
  }
  addUniqueStringArrayErrors(errors, item?.evidence_refs, `${path}.evidence_refs`, "FAIL-PROFILE-CONTRACT", { minimum: 1 });
  if (isNonEmptyString(expectedDimension) && item?.dimension !== expectedDimension) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.dimension does not match ${expectedDimension}`);
  }
  if (!isNonEmptyString(item?.metric_id)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.metric_id must bind profile evidence to a snapshot measurement`);
    return boundRefs;
  }
  const metric = metricById.get(item.metric_id);
  if (!metric) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.metric_id does not resolve to a snapshot measurement`);
    return boundRefs;
  }
  if (item.kind !== metric.definition_id) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.kind is not bound to ${item.metric_id}.definition_id`);
  }
  if (!OBSERVED_MEASUREMENT_STATUS.has(metric.measurement?.status)) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.metric_id is not an observed snapshot measurement`);
  }
  if (item.status !== metric.measurement?.status) {
    errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.status does not match ${item.metric_id}`);
  }
  const metricRefs = metricEvidenceRefs(metric);
  for (const ref of Array.isArray(item?.evidence_refs) ? item.evidence_refs : []) {
    if (!metricRefs.has(ref)) {
      errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.evidence_refs is not bound to ${item.metric_id}`);
    } else {
      boundRefs.push(ref);
    }
  }
  return boundRefs;
}

function validateProfile(profile, index, snapshot, metricById, errors) {
  const path = `profiles[${index}]`;
  validateAllowedKeys(errors, profile, path, [
    "profile_id",
    "profile_version",
    "profile_contract_hash",
    "applicability",
    "dimensions",
    "failure_codes",
    "evidence",
    "maturity",
    "guidance",
    "scope",
  ], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
  if (profile?.profile_id === "SPACE" && Object.keys(profile ?? {}).some((key) => /(^|_)(overall|score|composite|aggregate|weighted|summary)(_|$)/.test(key))) {
    errors.push(`FAIL-SPACE-SINGLE-SCORE: ${path} cannot declare a scalar or composite SPACE result`);
  }
  const dimensions = PROFILE_DIMENSIONS[profile?.profile_id];
  if (!dimensions) {
    errors.push(`FAIL-PROFILE-CONTRACT: ${path}.profile_id is not declared`);
  }
  if (profile?.profile_version !== PROFILE_VERSION) {
    errors.push(`FAIL-PROFILE-IDENTITY-DRIFT: ${path}.profile_version does not match the canonical profile contract`);
  }
  if (dimensions && profile?.profile_contract_hash !== deriveProfileContractHash(profile.profile_id)) {
    errors.push(`FAIL-PROFILE-IDENTITY-DRIFT: ${path}.profile_contract_hash does not match ${profile.profile_id}`);
  }
  const applicability = profile?.applicability;
  if (!isRecord(applicability)) {
    errors.push(`FAIL-PROFILE-CONTRACT: ${path}.applicability must be an object`);
  } else {
    validateAllowedKeys(errors, applicability, `${path}.applicability`, ["status", "reason", "evidence_refs"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
    if (!PROFILE_APPLICABILITY_STATUS.has(applicability.status)) {
      errors.push(`FAIL-PROFILE-CONTRACT: ${path}.applicability.status is unsupported`);
    }
    addRequiredString(errors, applicability.reason, `${path}.applicability.reason`);
    addUniqueStringArrayErrors(errors, applicability.evidence_refs, `${path}.applicability.evidence_refs`, "FAIL-PROFILE-CONTRACT");
  }
  const profileDimensionRecords = [];
  const authoritativeProfileEvidenceRefs = new Set();
  if (!isRecord(profile?.dimensions)) {
    errors.push(`FAIL-PROFILE-CONTRACT: ${path}.dimensions must be an object`);
  } else if (dimensions) {
    validateAllowedKeys(errors, profile.dimensions, `${path}.dimensions`, dimensions, "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
    for (const dimension of dimensions) {
      if (!Object.hasOwn(profile.dimensions, dimension)) {
        errors.push(`FAIL-PROFILE-CONTRACT: ${path}.dimensions.${dimension} is required`);
        continue;
      }
      const record = profile.dimensions[dimension];
      const dimensionPath = `${path}.dimensions.${dimension}`;
      if (!isRecord(record)) {
        errors.push(`FAIL-PROFILE-CONTRACT: ${dimensionPath} must be an object`);
        continue;
      }
      validateAllowedKeys(errors, record, dimensionPath, ["status", "evidence", "evidence_refs"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
      if (!PROFILE_DIMENSION_STATUS.has(record.status)) {
        errors.push(`FAIL-PROFILE-CONTRACT: ${dimensionPath}.status is unsupported`);
      }
      const evidenceItems = Array.isArray(record.evidence) ? record.evidence : [];
      if (!Array.isArray(record.evidence)) {
        errors.push(`FAIL-PROFILE-CONTRACT: ${dimensionPath}.evidence must be an array`);
      } else {
        evidenceItems.forEach((item, evidenceIndex) => {
          validateProfileEvidence(item, `${dimensionPath}.evidence[${evidenceIndex}]`, dimension, metricById, errors)
            .forEach((ref) => authoritativeProfileEvidenceRefs.add(ref));
        });
      }
      addUniqueStringArrayErrors(errors, record.evidence_refs, `${dimensionPath}.evidence_refs`, "FAIL-PROFILE-CONTRACT");
      const recordEvidenceRefs = Array.isArray(record.evidence_refs) ? record.evidence_refs : [];
      const itemEvidenceRefs = stableIdSet(evidenceItems.flatMap((item) => (
        Array.isArray(item?.evidence_refs) ? item.evidence_refs : []
      )));
      for (const ref of recordEvidenceRefs) {
        if (!itemEvidenceRefs.has(ref)) {
          errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${dimensionPath}.evidence_refs is not declared by its evidence records`);
        }
      }
      if ((record.status === "measured" || record.status === "inferred") && recordEvidenceRefs.length === 0) {
        errors.push(`FAIL-PROFILE-CONTRACT: ${dimensionPath}.${record.status} requires evidence_refs`);
      }
      if ((record.status === "measured" || record.status === "inferred") && evidenceItems.length === 0) {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${dimensionPath}.${record.status} requires typed snapshot evidence`);
      }
      if (record.status === "measured" && !evidenceItems.some((item) => item?.status === "measured")) {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${dimensionPath}.measured requires a measured snapshot metric`);
      }
      if (record.status === "inferred" && !evidenceItems.every((item) => item?.status === "inferred")) {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${dimensionPath}.inferred must contain only inferred snapshot metrics`);
      }
      profileDimensionRecords.push({ dimension, record, path: dimensionPath });
    }
  }
  if (applicability?.status === "not_applicable") {
    if ((Array.isArray(applicability.evidence_refs) ? applicability.evidence_refs : []).length > 0) {
      errors.push(`FAIL-PROFILE-CONTRACT: ${path}.applicability.not_applicable cannot retain evidence_refs`);
    }
    for (const { record, path: dimensionPath } of profileDimensionRecords) {
      const evidence = Array.isArray(record?.evidence) ? record.evidence : [];
      const refs = Array.isArray(record?.evidence_refs) ? record.evidence_refs : [];
      if (record?.status !== "not_applicable" || evidence.length > 0 || refs.length > 0) {
        errors.push(`FAIL-PROFILE-CONTRACT: ${dimensionPath} must be not_applicable without evidence when the profile is not_applicable`);
      }
    }
  }
  addUniqueStringArrayErrors(errors, profile?.failure_codes, `${path}.failure_codes`, "FAIL-PROFILE-CONTRACT");
  const allowedExtensions = profile?.profile_id === "Agile"
    ? new Set(["evidence"])
    : profile?.profile_id === "EngThrive"
      ? new Set(["maturity", "guidance", "scope"])
      : new Set();
  for (const field of ["evidence", "maturity", "guidance", "scope"]) {
    if (profile?.[field] !== undefined && !allowedExtensions.has(field)) {
      errors.push(`FAIL-PROFILE-CONTRACT: ${path}.${field} is not permitted for ${profile.profile_id}`);
    }
  }
  if (profile?.profile_id === "Agile" && isRecord(profile.evidence)) {
    validateAllowedKeys(errors, profile.evidence, `${path}.evidence`, ["machine", "human", "unobservable"], "FAIL-DERIVED-INTELLIGENCE-SCHEMA");
    for (const field of ["machine", "human", "unobservable"]) {
      if (!Array.isArray(profile.evidence[field])) errors.push(`FAIL-PROFILE-CONTRACT: ${path}.evidence.${field} must be an array`);
    }
    for (const field of ["machine", "human"]) {
      (Array.isArray(profile.evidence?.[field]) ? profile.evidence[field] : [])
        .forEach((item, evidenceIndex) => {
          validateProfileEvidence(item, `${path}.evidence.${field}[${evidenceIndex}]`, null, metricById, errors)
            .forEach((ref) => authoritativeProfileEvidenceRefs.add(ref));
        });
    }
    addUniqueStringArrayErrors(errors, profile.evidence?.unobservable, `${path}.evidence.unobservable`, "FAIL-PROFILE-CONTRACT");
  }
  if (profile?.profile_id === "EngThrive") {
    for (const field of ["maturity", "guidance", "scope"]) addRequiredString(errors, profile?.[field], `${path}.${field}`);
  }
  if (isRecord(applicability)) {
    for (const ref of Array.isArray(applicability.evidence_refs) ? applicability.evidence_refs : []) {
      if (!authoritativeProfileEvidenceRefs.has(ref)) {
        errors.push(`FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE: ${path}.applicability.evidence_refs is not bound to authoritative profile evidence`);
      }
    }
  }
}

function validateEvidenceSummary(snapshot, errors) {
  const summary = snapshot.evidence_summary;
  if (!isRecord(summary)) {
    errors.push("FAIL-SNAPSHOT-CONTRACT: evidence_summary must be an object");
    return;
  }
  validateAllowedKeys(errors, summary, "evidence_summary", ["measurement_count", "status_counts"]);
  const measurements = Array.isArray(snapshot.measurements) ? snapshot.measurements : [];
  if (summary.measurement_count !== measurements.length) {
    errors.push("FAIL-SNAPSHOT-CONTRACT: evidence_summary.measurement_count does not match measurements");
  }
  if (!isRecord(summary.status_counts)) {
    errors.push("FAIL-SNAPSHOT-CONTRACT: evidence_summary.status_counts must be an object");
    return;
  }
  validateAllowedKeys(errors, summary.status_counts, "evidence_summary.status_counts", [...STATUS]);
  const actual = Object.fromEntries([...STATUS].map((status) => [status, 0]));
  measurements.forEach((metric) => {
    if (STATUS.has(metric?.measurement?.status)) actual[metric.measurement.status] += 1;
  });
  for (const status of STATUS) {
    if (summary.status_counts[status] !== actual[status]) {
      errors.push(`FAIL-SNAPSHOT-CONTRACT: evidence_summary.status_counts.${status} does not match measurements`);
    }
  }
}

function validateRunMetadata(snapshot, collectors, errors, { checkCache = true, timing = null } = {}) {
  const metadata = snapshot.run_metadata;
  if (!isRecord(metadata)) {
    errors.push("FAIL-SNAPSHOT-CONTRACT: run_metadata must be an object");
    return;
  }
  validateAllowedKeys(errors, metadata, "run_metadata", ["generated_at", "cache", "trend_baseline"]);
  addRequiredString(errors, metadata.generated_at, "run_metadata.generated_at");
  const trendBaseline = metadata.trend_baseline;
  if (trendBaseline !== undefined) {
    if (!isRecord(trendBaseline)) {
      errors.push("FAIL-TREND-BASELINE-METADATA: run_metadata.trend_baseline must be an object");
    } else {
      validateAllowedKeys(errors, trendBaseline, "run_metadata.trend_baseline", [
        "binding_kind",
        "status",
        "eligible",
        "baseline_snapshot_id",
        "baseline_repository_revision",
        "compatible_metric_count",
        "historical_context",
        "reason",
      ], "FAIL-TREND-BASELINE-METADATA");
      if (trendBaseline.binding_kind !== "explicit" && trendBaseline.binding_kind !== "automatic") {
        errors.push("FAIL-TREND-BASELINE-METADATA: run_metadata.trend_baseline.binding_kind is unsupported");
      }
      if (!["established", "selected", "explicit"].includes(trendBaseline.status)) {
        errors.push("FAIL-TREND-BASELINE-METADATA: run_metadata.trend_baseline.status is unsupported");
      }
      if (typeof trendBaseline.eligible !== "boolean") {
        errors.push("FAIL-TREND-BASELINE-METADATA: run_metadata.trend_baseline.eligible must be boolean");
      }
      if (!Number.isInteger(trendBaseline.compatible_metric_count) || trendBaseline.compatible_metric_count < 0) {
        errors.push("FAIL-TREND-BASELINE-METADATA: run_metadata.trend_baseline.compatible_metric_count must be a nonnegative integer");
      }
      if (!isNonEmptyString(trendBaseline.reason)) {
        errors.push("FAIL-TREND-BASELINE-METADATA: run_metadata.trend_baseline.reason is required");
      }
      const historicalContext = trendBaseline.historical_context;
      if (historicalContext !== undefined && historicalContext !== null) {
        if (!isRecord(historicalContext)) {
          errors.push("FAIL-TREND-BASELINE-METADATA: historical_context must be an object or null");
        } else {
          validateAllowedKeys(errors, historicalContext, "run_metadata.trend_baseline.historical_context", [
            "kind",
            "event_kind",
            "repository_revision",
            "short_revision",
            "subject",
            "author",
            "authored_at",
            "commit_distance",
            "parent_count",
            "is_merge",
            "changed_file_count",
            "additions",
            "deletions",
            "text_churn",
            "significance_basis",
          ], "FAIL-TREND-BASELINE-METADATA");
          if (historicalContext.kind !== "significant-git-history") errors.push("FAIL-TREND-BASELINE-METADATA: historical_context.kind is unsupported");
          if (!["commit", "merge-commit"].includes(historicalContext.event_kind)) errors.push("FAIL-TREND-BASELINE-METADATA: historical_context.event_kind is unsupported");
          for (const field of ["repository_revision", "short_revision", "subject", "author", "authored_at", "significance_basis"]) {
            if (!isNonEmptyString(historicalContext[field])) errors.push(`FAIL-TREND-BASELINE-METADATA: historical_context.${field} is required`);
          }
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(historicalContext.repository_revision ?? "")) errors.push("FAIL-TREND-BASELINE-METADATA: historical_context.repository_revision must be a full commit ID");
          for (const field of ["commit_distance", "parent_count", "changed_file_count", "additions", "deletions", "text_churn"]) {
            if (!Number.isSafeInteger(historicalContext[field]) || historicalContext[field] < (field === "commit_distance" || field === "parent_count" ? 1 : 0)) {
              errors.push(`FAIL-TREND-BASELINE-METADATA: historical_context.${field} must be a bounded nonnegative integer`);
            }
          }
          if (typeof historicalContext.is_merge !== "boolean") errors.push("FAIL-TREND-BASELINE-METADATA: historical_context.is_merge must be boolean");
          if (historicalContext.text_churn !== historicalContext.additions + historicalContext.deletions) errors.push("FAIL-TREND-BASELINE-METADATA: historical_context.text_churn must equal additions plus deletions");
          if ((historicalContext.event_kind === "merge-commit") !== historicalContext.is_merge) errors.push("FAIL-TREND-BASELINE-METADATA: historical_context merge identity is inconsistent");
          if (historicalContext.is_merge && historicalContext.parent_count < 2) errors.push("FAIL-TREND-BASELINE-METADATA: merge historical_context requires at least two parents");
        }
      }
      const comparisons = (Array.isArray(snapshot.measurements) ? snapshot.measurements : [])
        .filter((metric) => isRecord(metric?.comparison));
      const collectorById = new Map(collectors.map((collector) => [collector.collector_id, collector]));
      const currentEligible = (Array.isArray(snapshot.measurements) ? snapshot.measurements : []).some((metric) => {
        const collector = collectorById.get(metric?.source?.collector_id);
        return (
          OBSERVED_MEASUREMENT_STATUS.has(metric?.measurement?.status) &&
          typeof metric?.value === "number" && Number.isFinite(metric.value) &&
          collector?.status === "available" &&
          collector.collector_version === metric?.source?.collector_version &&
          collector.analyzer_identity === metric?.analyzer_identity &&
          collector.analyzer_version === metric?.analyzer_version
        );
      });
      if (trendBaseline.compatible_metric_count !== comparisons.length) {
        errors.push("FAIL-TREND-BASELINE-METADATA: compatible_metric_count does not match comparison bindings");
      }
      const expectedEligibility = trendBaseline.status === "established" ? currentEligible : comparisons.length > 0;
      if (trendBaseline.eligible !== expectedEligibility) {
        errors.push("FAIL-TREND-BASELINE-METADATA: eligible does not match current bindable evidence");
      }
      if (trendBaseline.status === "established") {
        if (
          trendBaseline.binding_kind !== "automatic" ||
          trendBaseline.baseline_snapshot_id !== null ||
          trendBaseline.baseline_repository_revision !== null ||
          trendBaseline.compatible_metric_count !== 0
        ) {
          errors.push("FAIL-TREND-BASELINE-METADATA: established automatic baseline cannot bind a prior snapshot");
        }
      } else {
        addRequiredString(errors, trendBaseline.baseline_snapshot_id, "run_metadata.trend_baseline.baseline_snapshot_id");
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(trendBaseline.baseline_repository_revision)) {
          errors.push("FAIL-TREND-BASELINE-METADATA: baseline_repository_revision must be a full commit ID");
        }
        if (
          (trendBaseline.status === "selected" && trendBaseline.binding_kind !== "automatic") ||
          (trendBaseline.status === "explicit" && trendBaseline.binding_kind !== "explicit")
        ) {
          errors.push("FAIL-TREND-BASELINE-METADATA: status and binding_kind disagree");
        }
        if (trendBaseline.status === "selected" && trendBaseline.compatible_metric_count === 0) {
          errors.push("FAIL-TREND-BASELINE-METADATA: selected automatic baseline requires a compatible metric");
        }
      }
    }
  }
  const cache = metadata.cache;
  if (cache === undefined) return;
  if (!isRecord(cache)) {
    errors.push("FAIL-STALE-CACHE-METADATA: run_metadata.cache must be an object");
    return;
  }
  validateAllowedKeys(errors, cache, "run_metadata.cache", [
    "cache_key",
    "repository_revision",
    "configuration_hash",
    "schema_version",
    "collector_versions",
    "collector_fingerprints",
    "history_boundary",
  ], "FAIL-STALE-CACHE-METADATA");
  if (!checkCache) return;
  const expectedBindings = cacheBindings(snapshot);
  for (const [field, expected] of Object.entries(expectedBindings)) {
    const actual = field === "collector_versions" && Array.isArray(cache[field])
      ? [...cache[field]].sort(stableCompare)
      : cache[field];
    if (stableStringify(actual) !== stableStringify(expected)) {
      errors.push(`FAIL-STALE-CACHE-METADATA: run_metadata.cache.${field} does not match snapshot bindings`);
    }
  }
  if (cache.cache_key !== observedWork(timing, "snapshot_identity_ms", () => deriveCacheKey(snapshot))) {
    errors.push("FAIL-STALE-CACHE-METADATA: run_metadata.cache.cache_key does not match canonical bindings");
  }
}

function validateSnapshot(snapshot, options = {}) {
  const { checkIdentity = true, checkCache = true } = options;
  const timing = internalTiming(options);
  const errors = [];
  if (!isRecord(snapshot)) {
    return { ok: false, errors: ["FAIL-SNAPSHOT-CONTRACT: snapshot must be an object"] };
  }

  validateAgainstSchema(snapshot, schema).forEach((error) => {
    errors.push(`FAIL-SCHEMA-CONTRACT: ${error}`);
  });
  validateAllowedKeys(errors, snapshot, "snapshot", REQUIRED_TOP_LEVEL);

  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in snapshot)) {
      errors.push(`FAIL-SNAPSHOT-CONTRACT: ${field} is required`);
    }
  }

  if (snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`FAIL-SNAPSHOT-CONTRACT: schema_version must equal ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  addRequiredString(errors, snapshot.snapshot_id, "snapshot_id");
  validateRepository(snapshot, errors);

  const collectionFields = ["collectors", "measurements", "risk_models", "profiles"];
  for (const field of collectionFields) {
    if (!Array.isArray(snapshot[field])) {
      errors.push(`FAIL-SNAPSHOT-CONTRACT: ${field} must be an array`);
    }
  }

  const collectors = Array.isArray(snapshot.collectors) ? snapshot.collectors : [];
  const measurements = Array.isArray(snapshot.measurements) ? snapshot.measurements : [];
  const riskModels = Array.isArray(snapshot.risk_models) ? snapshot.risk_models : [];
  const profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : [];

  addDuplicateErrors(errors, collectors, "collector_id", "collectors");
  addDuplicateErrors(errors, measurements, "metric_id", "measurements");
  addDuplicateErrors(errors, riskModels, "risk_model_id", "risk_models");
  addDuplicateErrors(errors, profiles, "profile_id", "profiles");

  collectors.forEach((collector, index) => validateCollector(collector, index, errors));

  const collectorById = new Map(collectors.map((collector) => [collector.collector_id, collector]));
  const metricById = new Map(measurements.map((metric) => [metric.metric_id, metric]));
  const evidenceRefs = snapshotEvidenceRefs(snapshot);
  measurements.forEach((metric, index) => {
    validateMeasurement(metric, index, snapshot, collectorById, errors);
  });
  const cohortCache = new Map();
  const resultIds = new Set();
  riskModels.forEach((model, index) => validateRiskModel(model, index, snapshot, metricById, collectorById, evidenceRefs, resultIds, errors, cohortCache));
  profiles.forEach((profile, index) => validateProfile(profile, index, snapshot, metricById, errors));
  validateEvidenceSummary(snapshot, errors);
  validateRunMetadata(snapshot, collectors, errors, { checkCache, timing });

  if (checkIdentity && isNonEmptyString(snapshot.snapshot_id) && snapshot.snapshot_id !== observedWork(
    timing,
    "snapshot_identity_ms",
    () => deriveSnapshotId(snapshot),
  )) {
    errors.push("FAIL-SNAPSHOT-IDENTITY: snapshot_id does not match canonical evidence content");
  }

  return { ok: errors.length === 0, errors };
}

function validateSnapshotWithTelemetry(snapshot, options, timing) {
  return observedWork(timing, "snapshot_validation_ms", () => validateSnapshot(snapshot, {
    ...options,
    [INTERNAL_TIMING]: timing,
  }));
}

function createSnapshot(input, options = {}) {
  const timing = internalTiming(options);
  const snapshot = normalizeAndSort(input);
  const validation = validateSnapshotWithTelemetry(snapshot, {}, timing);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  return snapshot;
}

function materializeSnapshot(input, options = {}) {
  const timing = internalTiming(options);
  let snapshot = normalizeAndSort(input);
  if (!isRecord(snapshot)) {
    return createSnapshot(snapshot, { [INTERNAL_TIMING]: timing });
  }
  if (isRecord(snapshot.run_metadata?.cache)) {
    Object.assign(snapshot.run_metadata.cache, cacheBindings(snapshot));
    snapshot.run_metadata.cache.cache_key = "pending";
  }
  if (isRecord(snapshot.run_metadata?.cache)) {
    snapshot.run_metadata.cache.cache_key = observedWork(timing, "snapshot_identity_ms", () => deriveCacheKey(snapshot));
  }
  snapshot.snapshot_id = observedWork(timing, "snapshot_identity_ms", () => deriveSnapshotId(snapshot));
  snapshot = normalizeAndSort(snapshot);
  const validation = validateSnapshotWithTelemetry(snapshot, {}, timing);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  return snapshot;
}

function materializeSnapshotWithTelemetry(input, timing) {
  return materializeSnapshot(input, { [INTERNAL_TIMING]: timing });
}

function canonicalArtifact(snapshot, timing) {
  const frozenSnapshot = deepFreeze(snapshot);
  const state = Object.freeze({
    snapshot: frozenSnapshot,
    snapshot_json: observedWork(timing, "snapshot_serialization_ms", () => `${JSON.stringify(frozenSnapshot, null, 2)}\n`),
  });
  const artifact = Object.freeze({});
  canonicalArtifactState.set(artifact, state);
  return artifact;
}

function artifactTiming(timing) {
  return timing === undefined || timing === null
    ? null
    : internalTiming({ [INTERNAL_TIMING]: timing });
}

function materializeCanonicalArtifact(input, timing = null) {
  const observer = artifactTiming(timing);
  let snapshot = normalizeAndSort(input);
  if (isRecord(snapshot.run_metadata?.cache)) {
    Object.assign(snapshot.run_metadata.cache, cacheBindings(snapshot));
    snapshot.run_metadata.cache.cache_key = observedWork(observer, "snapshot_identity_ms", () => deriveCacheKey(snapshot));
  }
  snapshot.snapshot_id = observedWork(observer, "snapshot_identity_ms", () => deriveSnapshotId(snapshot));
  snapshot = normalizeAndSort(snapshot);
  const validation = validateSnapshotWithTelemetry(snapshot, {}, observer);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return canonicalArtifact(snapshot, observer);
}

function canonicalArtifactFromSnapshot(input, timing = null) {
  const observer = artifactTiming(timing);
  const snapshot = normalizeAndSort(input);
  const validation = validateSnapshotWithTelemetry(snapshot, {}, observer);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return canonicalArtifact(snapshot, observer);
}

function readCanonicalArtifact(artifact) {
  const state = canonicalArtifactState.get(artifact);
  if (!state) throw new Error("FAIL-SNAPSHOT-ARTIFACT: canonical artifact brand is invalid");
  return state;
}

function assertTrendProjection(projection) {
  if (
    !isRecord(projection) ||
    typeof projection.schema_version !== "string" || projection.schema_version.length === 0 ||
    typeof projection.snapshot_id !== "string" || projection.snapshot_id.length === 0 ||
    !isRecord(projection.repository) ||
    !Array.isArray(projection.collectors) ||
    !Array.isArray(projection.measurements) ||
    !Array.isArray(projection.profiles)
  ) {
    throw new Error("FAIL-TREND-PROBE: trend probe projection is invalid");
  }
}

function createTrendProbe(input, timing = null) {
  const observer = artifactTiming(timing);
  const snapshot = normalizeAndSort(input);
  if (isRecord(snapshot.run_metadata?.cache)) {
    Object.assign(snapshot.run_metadata.cache, cacheBindings(snapshot));
    snapshot.run_metadata.cache.cache_key = observedWork(observer, "snapshot_identity_ms", () => deriveCacheKey(snapshot));
  }
  snapshot.snapshot_id = observedWork(observer, "snapshot_identity_ms", () => deriveSnapshotId(snapshot));
  const projection = {
    schema_version: snapshot.schema_version,
    snapshot_id: snapshot.snapshot_id,
    repository: structuredClone(snapshot.repository),
    collectors: structuredClone(snapshot.collectors),
    measurements: structuredClone(snapshot.measurements),
    profiles: structuredClone(snapshot.profiles ?? []),
  };
  assertTrendProjection(projection);
  const frozenProjection = deepFreeze(normalizeObjectKeys(projection));
  const probe = Object.freeze({});
  trendProbeState.set(probe, frozenProjection);
  return probe;
}

function readTrendProbe(probe) {
  const projection = trendProbeState.get(probe);
  if (!projection) throw new Error("FAIL-TREND-PROBE: trend probe brand is invalid");
  return projection;
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  STATUS,
  createSnapshot,
  deriveCacheKey,
  deriveRiskModelContractHash,
  deriveSnapshotId,
  materializeSnapshot,
  validateSnapshot,
};
Object.defineProperty(module.exports, Symbol.for("sei.intelligence-engine.private.v1"), {
  value: Object.freeze({
    canonicalArtifactFromSnapshot,
    createTrendProbe,
    materializeCanonicalArtifact,
    materializeSnapshotWithTelemetry,
    readCanonicalArtifact,
    readTrendProbe,
    validateSnapshotWithTelemetry,
  }),
});
