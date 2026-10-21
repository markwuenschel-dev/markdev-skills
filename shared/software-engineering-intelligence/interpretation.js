"use strict";

const schema = require("./intelligence.schema.json");
const { validateAgainstSchema } = require("./schema-validator.js");
const { interpretEvidence } = require("./semantic-evidence.js");

const VALID_MEASUREMENT_STATES = new Set(["measured", "inferred"]);
const NON_NUMERIC_MEASUREMENT_STATES = new Set(["unavailable", "not-applicable", "unverifiable"]);
const OBSERVATION_ABSENCE_REASONS = new Set([
  "current measurement source state is not trend-valid",
  "current collector source state is not available",
  "current numeric value is required for a delta",
  "prior measurement source state is not trend-valid",
  "prior collector source state is not available",
  "prior numeric value is required for a delta",
]);
const MINIMUM_HOTSPOT_COHORT = 3;
const HOTSPOT_MODEL_ID = "heuristic-v1";
const MODEL_ID_FIELDS = ["risk_model_id", "model_id"];
const ALLOWED_HISTORY_BOUNDARY_KINDS = new Set(["revision", "revision-range"]);
const ALLOWED_METRIC_WINDOW_KINDS = new Set(["revision", "revision-range"]);
const VALIDATION_REQUEST_FIELDS = new Set([
  "requested_status",
  "model_status",
  "status",
  "calibration_method",
  "training_ids",
  "holdout_ids",
  "evidence_refs",
  "risk_model_id",
  "model_id",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableCompare(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${label} must be a non-empty array`);
  }
  const normalized = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (normalized.some((item) => item.length === 0)) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${label} must contain only non-blank strings`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${label} must contain unique IDs`);
  }
  return normalized.sort(stableCompare);
}

function measurements(snapshot) {
  return Array.isArray(snapshot?.measurements) ? snapshot.measurements : [];
}

function assertUnambiguousMetricObservations(snapshot, label) {
  const metricIds = new Set();
  const fileFeatures = new Set();
  for (const metric of measurements(snapshot)) {
    const metricId = metric?.metric_id;
    if (metricIds.has(metricId)) {
      throw new Error(`FAIL-AMBIGUOUS-METRIC-OBSERVATION: ${label} contains duplicate metric_id ${String(metricId)}`);
    }
    metricIds.add(metricId);

    const subject = canonicalFileSubject(metric?.subject);
    if (subject === null) continue;
    const featureIdentity = JSON.stringify([
      subject,
      metric.definition_id ?? null,
      metric.unit ?? null,
    ]);
    if (fileFeatures.has(featureIdentity)) {
      throw new Error(`FAIL-AMBIGUOUS-METRIC-OBSERVATION: ${label} contains duplicate file feature identity`);
    }
    fileFeatures.add(featureIdentity);
  }
}

function evidenceRefs(metric) {
  const refs = [
    ...(Array.isArray(metric?.source?.evidence_refs) ? metric.source.evidence_refs : []),
    ...(Array.isArray(metric?.source?.artifact_refs) ? metric.source.artifact_refs : []),
  ];
  return [...new Set(refs
    .filter(isNonBlankString)
    .map((reference) => reference.trim()))].sort(stableCompare);
}

function featureInterpretation(metric) {
  const identity = `${metric?.metric_id ?? ""} ${metric?.definition_id ?? ""}`.toLowerCase();
  if (identity.includes("lexical") || identity.includes("nesting")) return "lexical structural proxy";
  if (identity.includes("coverage")) return "observed coverage only";
  if (identity.includes("test") && (identity.includes("count") || identity.includes("number"))) {
    return "observed test count only";
  }
  if (identity.includes("churn") || identity.includes("change_frequency")) return "observed change activity";
  return "observed metric";
}

function percentile(value, peers) {
  if (typeof value !== "number" || !Number.isFinite(value) || peers.length === 0) return null;
  const atOrBelow = peers.filter((peer) => peer <= value).length;
  return Number((atOrBelow / peers.length).toFixed(6));
}

function vectorize(snapshot) {
  const eligible = measurements(snapshot)
    .map((metric) => ({ metric, subject: canonicalFileSubject(metric?.subject) }))
    .filter(({ metric, subject }) => (
      subject !== null &&
      VALID_MEASUREMENT_STATES.has(metric?.measurement?.status) &&
      featureMetricHasSnapshotProvenance(snapshot, metric)
    ));
  const peerSubjects = new Map();
  for (const { metric, subject } of eligible) {
    if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) continue;
    const key = `${metric.definition_id}\u0000${metric.unit}`;
    if (!peerSubjects.has(key)) peerSubjects.set(key, new Map());
    // Duplicate canonical file features were rejected at the public API boundary, so
    // this map cannot silently select an observation by input order.
    peerSubjects.get(key).set(subject, metric.value);
  }

  const bySubject = new Map();
  for (const { metric, subject } of eligible) {
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    const subjectPeers = peerSubjects.get(`${metric.definition_id}\u0000${metric.unit}`);
    const peers = subjectPeers ? [...subjectPeers.values()] : [];
    bySubject.get(subject).push({
      metric_id: metric.metric_id,
      definition_id: metric.definition_id,
      value: metric.value,
      unit: metric.unit,
      measurement_status: metric.measurement.status,
      percentile: percentile(metric.value, peers),
      cohort_size: subjectPeers?.size ?? 0,
      analyzer_identity: metric.analyzer_identity ?? null,
      analyzer_version: metric.analyzer_version ?? null,
      evidence_refs: evidenceRefs(metric),
      interpretation: featureInterpretation(metric),
    });
  }

  return [...bySubject.entries()]
    .sort(([left], [right]) => stableCompare(left, right))
    .map(([subject, vector]) => {
      vector.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
      const churn = vector.find((feature) => /(?:^|\.)churn(?::|$)/.test(feature.metric_id));
      const structural = vector.find((feature) => /lexical_max_nesting_depth|source_lines/.test(feature.metric_id));
      const hotspot_signals = [];
      if (
        (churn?.cohort_size ?? 0) >= MINIMUM_HOTSPOT_COHORT &&
        (structural?.cohort_size ?? 0) >= MINIMUM_HOTSPOT_COHORT &&
        (churn?.percentile ?? 0) >= 0.8 &&
        (structural?.percentile ?? 0) >= 0.8
      ) {
        hotspot_signals.push({
          signal_id: "coincident-change-and-structure",
          basis_metric_ids: [churn.metric_id, structural.metric_id].sort(stableCompare),
          interpretation: "review-attention signal only; not a defect probability or candidate priority",
        });
      }
      return { subject, vector, hotspot_signals };
    });
}

function normalizedModelStatus(value, source) {
  if (!isNonBlankString(value)) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${source} model status is blank`);
  }
  return value.trim().toLowerCase();
}

function hotspotModelIdentityValues(value, source) {
  if (!isRecord(value)) return [];
  return MODEL_ID_FIELDS
    .filter((field) => Object.hasOwn(value, field))
    .map((field) => {
      if (!isNonBlankString(value[field])) {
        throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${source}.${field} is blank`);
      }
      return value[field].trim();
    });
}

function mayTargetHotspotModel(value, inheritedModelId = undefined) {
  return (
    inheritedModelId === HOTSPOT_MODEL_ID ||
    (isRecord(value) && MODEL_ID_FIELDS.some((field) => (
      isNonBlankString(value[field]) && value[field].trim() === HOTSPOT_MODEL_ID
    )))
  );
}

function targetsHotspotModel(value, source, inheritedModelId = undefined) {
  if (!mayTargetHotspotModel(value, inheritedModelId)) return false;
  const identities = [
    ...hotspotModelIdentityValues(value, source),
    ...(inheritedModelId === undefined ? [] : [inheritedModelId]),
  ];
  if (identities.length === 0) return false;
  if (new Set(identities).size !== 1) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${source} model identity aliases disagree`);
  }
  return identities[0] === HOTSPOT_MODEL_ID;
}

function canonicalValidationRequest(value, source, inheritedStatus = undefined) {
  if (!isRecord(value)) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${source} must be an object`);
  }
  const unknownFields = Object.keys(value).filter((field) => !VALIDATION_REQUEST_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${source} has unsupported field(s) ${unknownFields.join(", ")}`);
  }
  const statuses = [
    ...["requested_status", "model_status", "status"]
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => normalizedModelStatus(value[field], `${source}.${field}`)),
    ...(inheritedStatus === undefined ? [] : [normalizedModelStatus(inheritedStatus, `${source}.inherited_status`)]),
  ];
  if (new Set(statuses).size > 1) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${source} model status aliases disagree`);
  }
  const normalizedString = (field) => {
    if (!Object.hasOwn(value, field)) return null;
    if (!isNonBlankString(value[field])) {
      throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${source}.${field} is blank`);
    }
    return value[field].trim();
  };
  const normalizedList = (field) => (
    Object.hasOwn(value, field) ? normalizedUniqueStrings(value[field], `${source}.${field}`) : null
  );
  return {
    requested_status: statuses[0] ?? "heuristic",
    calibration_method: normalizedString("calibration_method"),
    training_ids: normalizedList("training_ids"),
    holdout_ids: normalizedList("holdout_ids"),
    evidence_refs: normalizedList("evidence_refs"),
  };
}

function riskModelStatus(candidate, source) {
  const statuses = ["model_status", "requested_status", "status"]
    .filter((field) => Object.hasOwn(candidate, field))
    .map((field) => normalizedModelStatus(candidate[field], `${source}.${field}`));
  if (new Set(statuses).size > 1) {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: ${source} model status aliases disagree`);
  }
  return statuses[0];
}

function requestedValidation(snapshot, options) {
  const requests = [];
  const add = (value, source, inheritedStatus = undefined, inheritedModelId = undefined) => {
    if (!targetsHotspotModel(value, source, inheritedModelId)) return;
    requests.push(canonicalValidationRequest(value, source, inheritedStatus));
  };
  if (isRecord(options)) {
    for (const field of ["model_validation", "validation"]) {
      if (Object.hasOwn(options, field)) add(options[field], `options.${field}`);
    }
  }
  if (Array.isArray(snapshot?.risk_models)) {
    snapshot.risk_models.forEach((candidate, index) => {
      if (!isRecord(candidate)) return;
      const source = `risk_models[${index}]`;
      if (!targetsHotspotModel(candidate, source)) return;
      const inheritedStatus = riskModelStatus(candidate, source);
      const validationFields = ["model_validation", "validation"].filter((field) => Object.hasOwn(candidate, field));
      if (validationFields.length > 0) {
        validationFields.forEach((field) => add(candidate[field], `${source}.${field}`, inheritedStatus, HOTSPOT_MODEL_ID));
      } else if (inheritedStatus !== undefined) {
        add(candidate, source, undefined, HOTSPOT_MODEL_ID);
      }
    });
  }
  if (requests.length === 0) return null;
  const fingerprint = JSON.stringify(requests[0]);
  if (requests.some((request) => JSON.stringify(request) !== fingerprint)) {
    throw new Error("FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: calibration requests from multiple sources disagree");
  }
  return requests[0];
}

function validateModelStatus(snapshot, options) {
  const validation = requestedValidation(snapshot, options);
  const requested = String(
    validation?.requested_status ?? validation?.model_status ?? validation?.status ?? "heuristic",
  ).trim().toLowerCase();
  if (requested === "heuristic") return { status: "heuristic", validation: null };
  if (requested !== "calibrated" && requested !== "validated") {
    throw new Error(`FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: unsupported model status ${requested}`);
  }

  const training = normalizedUniqueStrings(validation.training_ids, "training_ids");
  const holdout = normalizedUniqueStrings(validation.holdout_ids, "holdout_ids");
  const refs = normalizedUniqueStrings(validation.evidence_refs, "evidence_refs");
  const trainingSet = new Set(training);
  const overlap = holdout.filter((id) => trainingSet.has(id));
  if (overlap.length > 0) {
    throw new Error(`FAIL-TRAIN-TEST-LEAKAGE: training and holdout overlap at ${overlap.join(", ")}`);
  }
  if (!isNonBlankString(validation.calibration_method)) {
    throw new Error("FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: independent holdout, method, and evidence refs are required");
  }
  throw new Error(
    "FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION: V1 has no schema-attested calibration artifact contract",
  );
}

function deriveHotspots(snapshot = {}, options = {}) {
  assertUnambiguousMetricObservations(snapshot, "snapshot");
  const model = validateModelStatus(snapshot, options);
  return {
    model: HOTSPOT_MODEL_ID,
    model_status: model.status,
    model_validation: model.validation,
    features: vectorize(snapshot),
    interpretation_boundary: "feature vectors and review-attention signals only",
  };
}

function normalizedCollectorId(value) {
  return isNonBlankString(value) ? value.trim() : null;
}

function collectorsAreUnambiguous(snapshot) {
  const collectorIds = new Set();
  for (const collector of (Array.isArray(snapshot?.collectors) ? snapshot.collectors : [])) {
    const collectorId = normalizedCollectorId(collector?.collector_id);
    if (!collectorId || collectorIds.has(collectorId)) return false;
    collectorIds.add(collectorId);
  }
  return true;
}

function bindingSignature(records, fields, label, reasons) {
  if (!Array.isArray(records)) {
    reasons.push(`${label} bindings are missing`);
    return null;
  }
  const identities = new Set();
  const bindings = [];
  records.forEach((record, index) => {
    if (!isRecord(record)) {
      reasons.push(`${label}[${index}] binding is invalid`);
      return;
    }
    const binding = {};
    for (const field of fields) {
      if (!isNonBlankString(record[field])) {
        reasons.push(`${label}[${index}].${field} is missing or blank`);
      } else {
        binding[field] = record[field].trim();
      }
    }
    const identity = binding[fields[0]];
    if (identity && identities.has(identity)) {
      reasons.push(`${label} binding identity ${identity} is duplicated`);
    }
    if (identity) identities.add(identity);
    bindings.push(binding);
  });
  if (reasons.length > 0) return null;
  return JSON.stringify(bindings.sort((left, right) => stableCompare(left[fields[0]], right[fields[0]])));
}

function snapshotCollectorBinding(snapshot, label, reasons) {
  return bindingSignature(
    snapshot?.collectors,
    ["collector_id", "collector_version", "status", "analyzer_identity", "analyzer_version"],
    `${label} collector`,
    reasons,
  );
}

function snapshotProfileBinding(snapshot, label, reasons) {
  return bindingSignature(
    snapshot?.profiles === undefined ? [] : snapshot.profiles,
    ["profile_id", "profile_version", "profile_contract_hash"],
    `${label} profile`,
    reasons,
  );
}

function addEnvironmentBindingReasons(reasons, previousSnapshot, currentSnapshot) {
  const previousCollector = snapshotCollectorBinding(previousSnapshot, "prior", reasons);
  const currentCollector = snapshotCollectorBinding(currentSnapshot, "current", reasons);
  if (previousCollector !== null && currentCollector !== null && previousCollector !== currentCollector) {
    reasons.push("collector bindings differ");
  }

  const previousProfile = snapshotProfileBinding(previousSnapshot, "prior", reasons);
  const currentProfile = snapshotProfileBinding(currentSnapshot, "current", reasons);
  if (previousProfile !== null && currentProfile !== null && previousProfile !== currentProfile) {
    reasons.push("profile bindings differ");
  }
}

function collectorIsValid(snapshot, metric) {
  const collectorId = normalizedCollectorId(metric?.source?.collector_id);
  if (!collectorId || !collectorsAreUnambiguous(snapshot)) return false;
  const collector = (Array.isArray(snapshot?.collectors) ? snapshot.collectors : [])
    .find((candidate) => normalizedCollectorId(candidate?.collector_id) === collectorId);
  return (
    collector?.status === "available" &&
    collector.analyzer_identity === metric.analyzer_identity &&
    collector.analyzer_version === metric.analyzer_version
  );
}

function collectorDeclaresObservationUnavailable(snapshot, metric) {
  const collectorId = normalizedCollectorId(metric?.source?.collector_id);
  if (!collectorId || !collectorsAreUnambiguous(snapshot)) return false;
  const collector = snapshot.collectors
    .find((candidate) => normalizedCollectorId(candidate?.collector_id) === collectorId);
  return (
    (collector?.status === "degraded" || collector?.status === "unavailable") &&
    collector.analyzer_identity === metric.analyzer_identity &&
    collector.analyzer_version === metric.analyzer_version
  );
}

function semanticFeatureEvidence(snapshot, metric) {
  const collectorId = normalizedCollectorId(metric?.source?.collector_id);
  if (!collectorId || !collectorsAreUnambiguous(snapshot)) return null;
  const collector = snapshot.collectors
    .find((candidate) => normalizedCollectorId(candidate?.collector_id) === collectorId);
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
      evidence_refs: evidenceRefs(metric),
      exclusions: [],
    });
  } catch (error) {
    if (error?.code === "FAIL-SEMANTIC-EVIDENCE") return null;
    throw error;
  }
}

function featureMetricHasSnapshotProvenance(snapshot, metric) {
  const revision = snapshot?.repository?.revision;
  return (
    isNonBlankString(snapshot?.schema_version) &&
    isNonBlankString(snapshot?.repository?.repository_id) &&
    isNonBlankString(snapshot?.repository?.configuration_hash) &&
    isNonBlankString(revision) &&
    isNonBlankString(metric?.metric_id) &&
    isNonBlankString(metric?.definition_id) &&
    isNonBlankString(metric?.subject) &&
    isNonBlankString(metric?.unit) &&
    isNonBlankString(metric?.repository_revision) &&
    metric.repository_revision === revision &&
    isNonBlankString(metric?.analyzer_identity) &&
    isNonBlankString(metric?.analyzer_version) &&
    hasHumanMaintainabilityScope(metric) &&
    isRecord(metric?.source) &&
    isNonBlankString(metric.source.collector_id) &&
    metric.source.repository_revision === revision &&
    semanticFeatureEvidence(snapshot, metric)?.usable === true
  );
}

function hasHumanMaintainabilityScope(metric) {
  const subjectPath = canonicalFileSubjectPath(metric?.subject);
  return (
    isRecord(metric?.scope) &&
    metric.scope.kind === "file" &&
    subjectPath !== null &&
    canonicalFilePath(metric.scope.path) === subjectPath &&
    metric.scope.generated_code === false &&
    metric.scope.included_in_human_maintainability === true
  );
}

function canonicalFileSubjectPath(subject) {
  const canonicalSubject = canonicalFileSubject(subject);
  return canonicalSubject === null ? null : canonicalSubject.slice("file:".length);
}

function canonicalFileSubject(subject) {
  if (typeof subject !== "string" || !subject.startsWith("file:")) return null;
  const path = canonicalFilePath(subject.slice("file:".length));
  return path === null ? null : `file:${path}`;
}

function canonicalFilePath(path) {
  if (!isNonBlankString(path)) return null;
  const slashNormalized = path.trim().replace(/\\/g, "/");
  if (slashNormalized.startsWith("/") || /^[A-Za-z]:\//.test(slashNormalized)) return null;
  const segments = slashNormalized.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const canonical = segments.filter((segment) => segment.length > 0 && segment !== ".");
  return canonical.length > 0 ? canonical.join("/") : null;
}

function addRequiredFieldReasons(reasons, value, field) {
  if (!isNonBlankString(value)) reasons.push(`${field} is missing or blank`);
}

function addSnapshotBindingReasons(reasons, snapshot, label) {
  addRequiredFieldReasons(reasons, snapshot?.snapshot_id, `${label} snapshot ID`);
  addRequiredFieldReasons(reasons, snapshot?.schema_version, `${label} schema version`);
  addRequiredFieldReasons(reasons, snapshot?.repository?.repository_id, `${label} repository identity`);
  addRequiredFieldReasons(reasons, snapshot?.repository?.configuration_hash, `${label} configuration hash`);
  addRequiredFieldReasons(reasons, snapshot?.repository?.revision, `${label} repository revision`);
  const boundary = snapshot?.repository?.history_boundary;
  if (!isRecord(boundary)) {
    reasons.push(`${label} history boundary is missing`);
  } else {
    addRequiredFieldReasons(reasons, boundary.kind, `${label} history boundary kind`);
    addRequiredFieldReasons(reasons, boundary.end, `${label} history boundary end`);
    if (!ALLOWED_HISTORY_BOUNDARY_KINDS.has(boundary.kind)) {
      reasons.push(`${label} history boundary kind is unsupported`);
    }
    if (boundary.end !== snapshot?.repository?.revision) {
      reasons.push(`${label} history boundary end is not bound to repository revision`);
    }
    if (boundary.kind === "revision" && boundary.start !== null) {
      reasons.push(`${label} revision history boundary must have a null start`);
    }
    if (boundary.kind === "revision-range" && !isNonBlankString(boundary.start)) {
      reasons.push(`${label} revision-range history boundary requires a non-blank start`);
    }
    if (boundary.start !== null && !isNonBlankString(boundary.start)) {
      reasons.push(`${label} history boundary start is invalid`);
    }
  }
  if (!collectorsAreUnambiguous(snapshot)) {
    reasons.push(`${label} collectors are missing, blank, or duplicated`);
  }
}

function addMetricBindingReasons(reasons, snapshot, metric, label) {
  for (const [value, name] of [
    [metric?.metric_id, "metric ID"],
    [metric?.definition_id, "definition ID"],
    [metric?.subject, "subject"],
    [metric?.unit, "unit"],
    [metric?.analyzer_identity, "analyzer identity"],
    [metric?.analyzer_version, "analyzer version"],
    [metric?.repository_revision, "metric repository revision"],
  ]) {
    addRequiredFieldReasons(reasons, value, `${label} ${name}`);
  }
  if (metric?.repository_revision !== snapshot?.repository?.revision) {
    reasons.push(`${label} metric repository revision is not bound to snapshot revision`);
  }
  if (!isRecord(metric?.source) || metric.source.repository_revision !== snapshot?.repository?.revision) {
    reasons.push(`${label} source repository revision is not bound to snapshot revision`);
  }
  if (evidenceRefs(metric).length === 0) {
    reasons.push(`${label} source evidence references are missing`);
  }
  const window = metric?.window;
  if (!isRecord(window)) {
    reasons.push(`${label} metric window is missing`);
  } else {
    addRequiredFieldReasons(reasons, window.kind, `${label} metric window kind`);
    addRequiredFieldReasons(reasons, window.end, `${label} metric window end`);
    if (!ALLOWED_METRIC_WINDOW_KINDS.has(window.kind)) {
      reasons.push(`${label} metric window kind is unsupported`);
    }
    if (window.end !== snapshot?.repository?.revision) {
      reasons.push(`${label} metric window end is not bound to snapshot revision`);
    }
    if (window.kind === "revision" && window.start !== null) {
      reasons.push(`${label} revision metric window must have a null start`);
    }
    if (window.kind === "revision-range") {
      const boundary = snapshot?.repository?.history_boundary;
      if (!isNonBlankString(window.start) || boundary?.kind !== "revision-range" || window.start !== boundary.start) {
        reasons.push(`${label} revision-range metric window is not bound to snapshot history`);
      }
    }
    if (window.start !== null && !isNonBlankString(window.start)) {
      reasons.push(`${label} metric window start is invalid`);
    }
  }
  const comparability = metric?.comparability;
  if (!isRecord(comparability)) {
    reasons.push(`${label} metric comparability is missing`);
  } else {
    if (comparability.analyzer_identity !== metric.analyzer_identity) reasons.push(`${label} comparability analyzer identity is invalid`);
    if (comparability.analyzer_version !== metric.analyzer_version) reasons.push(`${label} comparability analyzer version is invalid`);
    if (comparability.configuration_hash !== snapshot?.repository?.configuration_hash) reasons.push(`${label} comparability configuration is invalid`);
  }
}

function addTrendOrderingReasons(reasons, previousSnapshot, currentSnapshot) {
  if (previousSnapshot?.snapshot_id === currentSnapshot?.snapshot_id) {
    reasons.push("snapshot identities must be distinct");
  }
  if (previousSnapshot?.repository?.revision === currentSnapshot?.repository?.revision) {
    reasons.push("snapshot revisions must be distinct");
  }
}

function currentMetricContractReasons(snapshot, metric) {
  const reasons = [];
  addMetricBindingReasons(reasons, snapshot, metric, "current");
  if (!VALID_MEASUREMENT_STATES.has(metric?.measurement?.status)) {
    reasons.push("current measurement source state is not trend-valid");
  }
  if (!collectorIsValid(snapshot, metric)) {
    reasons.push("current collector source state is not available");
  }
  if (typeof metric?.value !== "number" || !Number.isFinite(metric.value)) {
    reasons.push("current numeric value is required for a delta");
  }
  const comparison = metric?.comparison;
  if (!isRecord(comparison)) {
    if (Object.hasOwn(metric ?? {}, "comparison")) {
      reasons.push("current metric comparison binding is invalid");
    } else if (metric?.comparability?.compatible_with_prior !== false) {
      reasons.push("current metric comparison binding is missing");
    } else if (!isNonBlankString(metric?.comparability?.reason)) {
      reasons.push("current first-observation comparability reason is missing");
    }
  } else {
    for (const [value, name] of [
      [comparison.baseline_snapshot_id, "baseline snapshot ID"],
      [comparison.baseline_metric_id, "baseline metric ID"],
      [comparison.analyzer_identity, "baseline analyzer identity"],
      [comparison.analyzer_version, "baseline analyzer version"],
      [comparison.configuration_hash, "baseline configuration"],
    ]) {
      addRequiredFieldReasons(reasons, value, `current ${name}`);
    }
    if (comparison.analyzer_identity !== metric?.analyzer_identity || comparison.analyzer_version !== metric?.analyzer_version) {
      reasons.push("baseline analyzer binding differs");
    }
    if (comparison.configuration_hash !== snapshot?.repository?.configuration_hash) {
      reasons.push("baseline configuration binding differs");
    }
    if (metric?.comparability?.compatible_with_prior !== true) {
      reasons.push("current metric does not declare prior compatibility");
    }
    const factualFields = [
      "binding_kind",
      "baseline_repository_revision",
      "baseline_value",
      "delta",
      "confidence",
    ];
    const factualFieldCount = factualFields.filter((field) => Object.hasOwn(comparison, field)).length;
    if (factualFieldCount !== 0 && factualFieldCount !== factualFields.length) {
      reasons.push("factual baseline binding fields are incomplete");
    } else if (factualFieldCount === factualFields.length) {
      if (comparison.binding_kind !== "automatic" && comparison.binding_kind !== "explicit") {
        reasons.push("baseline binding kind is unsupported");
      }
      if (!isNonBlankString(comparison.baseline_repository_revision)) {
        reasons.push("baseline repository revision is missing");
      }
      for (const field of ["baseline_value", "delta", "confidence"]) {
        if (typeof comparison[field] !== "number" || !Number.isFinite(comparison[field])) {
          reasons.push(`baseline ${field} is not finite`);
        }
      }
      if (
        typeof comparison.baseline_value === "number" && Number.isFinite(comparison.baseline_value) &&
        typeof comparison.delta === "number" && Number.isFinite(comparison.delta) &&
        comparison.delta !== metric.value - comparison.baseline_value
      ) {
        reasons.push("factual baseline delta does not equal current value minus baseline value");
      }
      if (
        typeof comparison.confidence === "number" &&
        (comparison.confidence < 0 || comparison.confidence > 1 || comparison.confidence > metric?.measurement?.confidence)
      ) {
        reasons.push("factual baseline confidence exceeds current measurement confidence");
      }
    }
  }
  return [...new Set(reasons)];
}

function currentOnlyBaselineReasons(previousSnapshot, metric) {
  const comparison = metric?.comparison;
  if (!isRecord(comparison)) return [];
  const baseline = measurements(previousSnapshot)
    .find((candidate) => candidate?.metric_id === comparison.baseline_metric_id);
  const reasons = [];
  if (comparison.baseline_snapshot_id !== previousSnapshot?.snapshot_id) {
    reasons.push("baseline snapshot binding does not resolve to the supplied prior snapshot");
  }
  if (comparison.baseline_metric_id !== metric?.metric_id) {
    reasons.push("baseline metric binding differs from the current stable metric ID");
  }
  if (!baseline) {
    reasons.push("baseline metric binding does not exist in the supplied prior snapshot");
  }
  return reasons;
}

function metricCompatibility(previousSnapshot, currentSnapshot, previous, current, { requireExplicitBaseline = false } = {}) {
  const reasons = [];
  addMetricBindingReasons(reasons, previousSnapshot, previous, "prior");
  reasons.push(...currentMetricContractReasons(currentSnapshot, current));
  // M2 permits a first-observation metric to explicitly say that it has no
  // prior comparison.  Preserve that standalone trend contract for the public
  // two-argument comparator.  The CLI's explicit --baseline flow opts into a
  // stronger provenance requirement below, so a caller cannot turn an
  // unbound snapshot into a baseline comparison merely by supplying a file.
  if (requireExplicitBaseline) {
    if (current?.comparability?.compatible_with_prior !== true) {
      reasons.push("current metric does not declare compatibility with the explicit baseline");
    }
    if (!isRecord(current?.comparison)) {
      reasons.push("current metric explicit baseline binding is missing");
    }
  }
  if (previousSnapshot?.schema_version !== currentSnapshot?.schema_version) reasons.push("schema version differs");
  if (previousSnapshot?.repository?.repository_id !== currentSnapshot?.repository?.repository_id) reasons.push("repository identity differs");
  if (previous.definition_id !== current.definition_id) reasons.push("definition identity differs");
  if (previous.subject !== current.subject) reasons.push("subject differs");
  if (previous.unit !== current.unit) reasons.push("unit differs");
  if (previous.analyzer_identity !== current.analyzer_identity) reasons.push("analyzer identity differs");
  if (previous.analyzer_version !== current.analyzer_version) reasons.push("analyzer version differs");
  const previousConfig = previousSnapshot?.repository?.configuration_hash;
  const currentConfig = currentSnapshot?.repository?.configuration_hash;
  if (!previousConfig || previousConfig !== currentConfig) reasons.push("configuration differs");
  if (previous?.window?.kind !== current?.window?.kind || previous?.window?.start !== current?.window?.start) {
    reasons.push("metric window differs");
  }
  // A static revision window remains bound to its snapshot revision even when
  // repository history covers a broader range. The explicit baseline binding
  // below, rather than the history-range start, establishes this comparison.
  if (previous?.comparability?.configuration_hash !== previousConfig) reasons.push("prior metric configuration binding is invalid");
  if (!VALID_MEASUREMENT_STATES.has(previous?.measurement?.status)) {
    reasons.push("prior measurement source state is not trend-valid");
  }
  if (!collectorIsValid(previousSnapshot, previous)) {
    reasons.push("prior collector source state is not available");
  }
  if (typeof previous.value !== "number" || !Number.isFinite(previous.value)) {
    reasons.push("prior numeric value is required for a delta");
  }
  const comparison = current.comparison;
  if (isRecord(comparison)) {
    if (comparison.baseline_snapshot_id !== previousSnapshot.snapshot_id) reasons.push("baseline snapshot binding differs");
    if (comparison.baseline_metric_id !== previous.metric_id) reasons.push("baseline metric binding differs");
    if (comparison.analyzer_identity !== current.analyzer_identity || comparison.analyzer_version !== current.analyzer_version) {
      reasons.push("baseline analyzer binding differs");
    }
    if (comparison.configuration_hash !== currentConfig) reasons.push("baseline configuration binding differs");
    const factualFields = [
      "binding_kind",
      "baseline_repository_revision",
      "baseline_value",
      "delta",
      "confidence",
    ];
    if (factualFields.every((field) => Object.hasOwn(comparison, field))) {
      if (comparison.baseline_repository_revision !== previousSnapshot?.repository?.revision) {
        reasons.push("baseline repository revision differs from the supplied prior snapshot");
      }
      if (comparison.baseline_value !== previous.value) {
        reasons.push("baseline value differs from the supplied prior metric");
      }
      if (comparison.delta !== current.value - previous.value) {
        reasons.push("baseline delta differs from the supplied factual delta");
      }
      const expectedConfidence = Math.min(previous?.measurement?.confidence, current?.measurement?.confidence);
      if (!Number.isFinite(expectedConfidence) || comparison.confidence !== expectedConfidence) {
        reasons.push("baseline confidence differs from the minimum prior/current measurement confidence");
      }
    }
  }
  return [...new Set(reasons)];
}

function unavailableObservationIsDeclaredInsufficient(previousSnapshot, currentSnapshot, previous, current, reasons) {
  return (
    (
      NON_NUMERIC_MEASUREMENT_STATES.has(previous?.measurement?.status) ||
      NON_NUMERIC_MEASUREMENT_STATES.has(current?.measurement?.status) ||
      collectorDeclaresObservationUnavailable(previousSnapshot, previous) ||
      collectorDeclaresObservationUnavailable(currentSnapshot, current)
    ) &&
    current?.comparability?.compatible_with_prior === false &&
    isNonBlankString(current?.comparability?.reason) &&
    !Object.hasOwn(current ?? {}, "comparison") &&
    reasons.length > 0 &&
    reasons.every((reason) => OBSERVATION_ABSENCE_REASONS.has(reason))
  );
}

function validateTrendEnvelope(envelope) {
  const errors = validateAgainstSchema(envelope, {
    $defs: schema.$defs,
    $ref: "#/$defs/trendEnvelope",
  }).map((error) => `FAIL-TREND-CONTRACT: ${error}`);
  if (!isRecord(envelope)) return { ok: false, errors };
  const trends = Array.isArray(envelope.trends) ? envelope.trends : [];
  const metricIds = new Set();
  let comparableCount = 0;
  let insufficientCount = 0;
  let incomparableCount = 0;
  for (const [index, trend] of trends.entries()) {
    const path = `trends[${index}]`;
    if (!isRecord(trend)) continue;
    if (metricIds.has(trend.metric_id)) errors.push(`FAIL-DUPLICATE-ID: ${path}.metric_id duplicates ${trend.metric_id}`);
    metricIds.add(trend.metric_id);
    const numericFields = ["previous_value", "current_value", "delta"];
    if (trend.status === "comparable") {
      comparableCount += 1;
      if (trend.reason !== null) errors.push(`FAIL-TREND-CONTRACT: ${path}.comparable reason must be null`);
      if (Object.hasOwn(trend, "failure_code")) errors.push(`FAIL-TREND-CONTRACT: ${path}.comparable cannot carry failure_code`);
      for (const field of ["definition_id", "subject", "unit", ...numericFields]) {
        if (!Object.hasOwn(trend, field)) errors.push(`FAIL-TREND-CONTRACT: ${path}.${field} is required for comparable`);
      }
      for (const field of numericFields) {
        if (typeof trend[field] !== "number" || !Number.isFinite(trend[field])) {
          errors.push(`FAIL-TREND-CONTRACT: ${path}.${field} must be a finite number`);
        }
      }
      if (typeof trend.previous_value === "number" && typeof trend.current_value === "number" && typeof trend.delta === "number" && trend.delta !== trend.current_value - trend.previous_value) {
        errors.push(`FAIL-TREND-CONTRACT: ${path}.delta does not equal current_value minus previous_value`);
      }
    } else if (trend.status === "insufficient_history") {
      insufficientCount += 1;
      if (!isNonBlankString(trend.reason)) errors.push(`FAIL-TREND-CONTRACT: ${path}.insufficient_history requires reason`);
      for (const field of ["failure_code", "definition_id", "subject", "unit", ...numericFields]) {
        if (Object.hasOwn(trend, field)) errors.push(`FAIL-TREND-CONTRACT: ${path}.insufficient_history cannot carry ${field}`);
      }
    } else if (trend.status === "incomparable") {
      incomparableCount += 1;
      if (!isNonBlankString(trend.reason)) errors.push(`FAIL-TREND-CONTRACT: ${path}.incomparable requires reason`);
      if (trend.failure_code !== "FAIL-INCOMPATIBLE-COMPARISON") {
        errors.push(`FAIL-TREND-CONTRACT: ${path}.incomparable requires FAIL-INCOMPATIBLE-COMPARISON`);
      }
      for (const field of ["definition_id", "subject", "unit", ...numericFields]) {
        if (Object.hasOwn(trend, field)) errors.push(`FAIL-TREND-CONTRACT: ${path}.incomparable cannot carry ${field}`);
      }
    }
  }
  if (envelope.status === "comparable" && (comparableCount !== trends.length || trends.length === 0)) {
    errors.push("FAIL-TREND-CONTRACT: comparable envelope requires only comparable records");
  }
  if (envelope.status === "comparable") {
    if (!isNonBlankString(envelope.previous_snapshot_id) || !isNonBlankString(envelope.current_snapshot_id)) {
      errors.push("FAIL-TREND-CONTRACT: comparable envelope requires nonblank prior and current snapshot IDs");
    } else if (envelope.previous_snapshot_id === envelope.current_snapshot_id) {
      errors.push("FAIL-TREND-CONTRACT: comparable envelope requires distinct prior and current snapshot IDs");
    }
    if (envelope.reason !== null) {
      errors.push("FAIL-TREND-CONTRACT: comparable envelope reason must be null");
    }
  }
  if (envelope.status === "insufficient_history" && !(trends.length === 0 || insufficientCount === trends.length)) {
    errors.push("FAIL-TREND-CONTRACT: insufficient_history envelope requires only insufficient-history records");
  }
  if (envelope.status === "incomparable" && incomparableCount === 0 && !isNonBlankString(envelope.reason)) {
    errors.push("FAIL-TREND-CONTRACT: incomparable envelope requires an incomparable record or envelope reason");
  }
  if (envelope.status === "mixed" && (comparableCount === 0 || insufficientCount === 0 || incomparableCount > 0)) {
    errors.push("FAIL-TREND-CONTRACT: mixed envelope requires comparable and insufficient-history records only");
  }
  return { ok: errors.length === 0, errors };
}

function normalizeComparisonOptions(options) {
  if (options === undefined) return { requireExplicitBaseline: false };
  if (!isRecord(options)) {
    throw new Error("FAIL-TREND-CONTRACT: comparison options must be an object");
  }
  const keys = Object.keys(options);
  if (keys.some((key) => key !== "require_explicit_baseline")) {
    throw new Error("FAIL-TREND-CONTRACT: comparison options contain an unsupported key");
  }
  if (options.require_explicit_baseline !== undefined && typeof options.require_explicit_baseline !== "boolean") {
    throw new Error("FAIL-TREND-CONTRACT: require_explicit_baseline must be boolean");
  }
  return { requireExplicitBaseline: options.require_explicit_baseline === true };
}

function compareSnapshots(previous = {}, current = {}, options = undefined) {
  const comparisonOptions = normalizeComparisonOptions(options);
  assertUnambiguousMetricObservations(previous, "previous snapshot");
  assertUnambiguousMetricObservations(current, "current snapshot");
  const currentMetrics = measurements(current).slice().sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  const globalReasons = [];
  addSnapshotBindingReasons(globalReasons, previous, "prior");
  addSnapshotBindingReasons(globalReasons, current, "current");
  addTrendOrderingReasons(globalReasons, previous, current);
  if (!isNonBlankString(previous?.schema_version) || !isNonBlankString(current?.schema_version) || previous.schema_version !== current.schema_version) {
    globalReasons.push("schema version differs or is missing");
  }
  if (
    !isNonBlankString(previous?.repository?.repository_id) ||
    !isNonBlankString(current?.repository?.repository_id) ||
    previous.repository.repository_id !== current.repository.repository_id
  ) {
    globalReasons.push("repository identity differs or is missing");
  }
  addEnvironmentBindingReasons(globalReasons, previous, current);

  const previousById = new Map(measurements(previous).map((metric) => [metric.metric_id, metric]));
  const trends = currentMetrics.map((metric) => {
    const prior = previousById.get(metric.metric_id);
    if (!prior) {
      const currentReasons = currentMetricContractReasons(current, metric);
      const reasons = [...globalReasons, ...currentReasons, ...currentOnlyBaselineReasons(previous, metric)];
      if (reasons.length > 0) {
        return {
          metric_id: metric.metric_id,
          status: "incomparable",
          reason: [...new Set(reasons)].join("; "),
          failure_code: "FAIL-INCOMPATIBLE-COMPARISON",
        };
      }
      return {
        metric_id: metric.metric_id,
        status: "insufficient_history",
        reason: "no prior metric with the same stable metric ID",
      };
    }
    const coreReasons = metricCompatibility(previous, current, prior, metric);
    // An explicit baseline cannot manufacture a delta when either source-bound
    // observation is unavailable. When the current measurement transparently
    // declares that absence and every other binding is intact, preserve usable
    // sibling deltas as insufficient history rather than misclassifying them
    // as a contract-incompatible comparison.
    if (
      comparisonOptions.requireExplicitBaseline &&
      globalReasons.length === 0 &&
      unavailableObservationIsDeclaredInsufficient(previous, current, prior, metric, coreReasons)
    ) {
      return {
        metric_id: metric.metric_id,
        status: "insufficient_history",
        reason: "a metric observation is unavailable for a source-bound numeric delta",
      };
    }
    const reasons = [...globalReasons, ...metricCompatibility(previous, current, prior, metric, comparisonOptions)];
    if (reasons.length > 0) {
      return {
        metric_id: metric.metric_id,
        status: "incomparable",
        reason: reasons.join("; "),
        failure_code: "FAIL-INCOMPATIBLE-COMPARISON",
      };
    }
    return {
      metric_id: metric.metric_id,
      definition_id: metric.definition_id,
      subject: metric.subject,
      unit: metric.unit,
      status: "comparable",
      reason: null,
      previous_value: prior.value,
      current_value: metric.value,
      delta: metric.value - prior.value,
    };
  });

  let status;
  if (globalReasons.length > 0 || trends.some((trend) => trend.status === "incomparable")) status = "incomparable";
  else if (trends.length === 0 || trends.every((trend) => trend.status === "insufficient_history")) status = "insufficient_history";
  else if (trends.every((trend) => trend.status === "comparable")) status = "comparable";
  else status = "mixed";
  const envelope = {
    status,
    previous_snapshot_id: previous.snapshot_id ?? null,
    current_snapshot_id: current.snapshot_id ?? null,
    reason: globalReasons.length > 0 ? globalReasons.join("; ") : null,
    trends,
  };
  const validation = validateTrendEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return envelope;
}

module.exports = { compareSnapshots, deriveHotspots, validateTrendEnvelope };
