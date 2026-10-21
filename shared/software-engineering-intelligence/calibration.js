"use strict";

// This module intentionally evaluates a declared heuristic without changing a
// snapshot risk model.  Its scores are ranks, never probabilities: a positive
// backtest result therefore remains an inspectable heuristic receipt rather
// than a caller-created calibrated or validated SEI claim.
const crypto = require("node:crypto");
const { materializeSnapshot, validateSnapshot } = require("./intelligence-engine.js");

const OBSERVED_STATUSES = new Set(["measured", "inferred"]);
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ATTESTATION_SCHEMA_VERSION = "1.0.0";
const ATTESTATION_KIND = "sei-calibration-label-attestation";
const ATTESTATION_STATEMENT_FIELDS = Object.freeze([
  "attestation_id",
  "event_id",
  "snapshot_id",
  "snapshot_document_sha256",
  "repository_id",
  "repository_revision",
  "snapshot_observed_at",
  "subject",
  "outcome",
  "observed_at",
  "artifact_ref",
  "artifact_sha256",
]);

const FEATURE_SPECS = Object.freeze([
  Object.freeze({ key: "loc", definition_id: "sei.static.source_lines@1" }),
  // The current canonical collector exposes lexical nesting, not a verified
  // per-file cyclomatic score.  Keep that limitation in the method ID rather
  // than silently relabelling a lexical proxy as cyclomatic complexity.
  Object.freeze({ key: "lexical_complexity", definition_id: "sei.static.lexical_max_nesting_depth@1" }),
  Object.freeze({ key: "churn", definition_id: "sei.git.churn@1" }),
  Object.freeze({ key: "commit_frequency", definition_id: "sei.git.change_frequency@1" }),
]);

const METHOD_SPECS = Object.freeze([
  Object.freeze({ method_id: "heuristic-combined-v1", feature_keys: ["loc", "lexical_complexity", "churn", "commit_frequency"] }),
  Object.freeze({ method_id: "naive-loc-v1", feature_keys: ["loc"] }),
  Object.freeze({ method_id: "naive-lexical-complexity-v1", feature_keys: ["lexical_complexity"] }),
  Object.freeze({ method_id: "naive-churn-v1", feature_keys: ["churn"] }),
  Object.freeze({ method_id: "naive-commit-frequency-v1", feature_keys: ["commit_frequency"] }),
]);

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\u0000");
}

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function assertClosed(value, allowedKeys, label, code = "FAIL-CALIBRATION-CONTRACT") {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${label}.${key} is not declared`);
  }
}

function assertStableId(value, label, code = "FAIL-CALIBRATION-CONTRACT") {
  if (!isNonBlankString(value)) fail(code, `${label} must be a nonblank stable identifier`);
  return value.trim();
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !RFC3339_WITH_OFFSET.test(value)) {
    fail("FAIL-CALIBRATION-CONTRACT", `${label} must be RFC3339 with an explicit UTC offset`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("FAIL-CALIBRATION-CONTRACT", `${label} is not a valid timestamp`);
  return timestamp;
}

function canonicalLabelProjection(label) {
  const source = isRecord(label?.source) ? label.source : {};
  return {
    label_id: label?.label_id,
    snapshot_id: label?.snapshot_id,
    subject: label?.subject,
    observed_at: label?.observed_at,
    outcome: label?.outcome,
    source: {
      authority: source.authority,
      artifact_ref: source.artifact_ref,
      repository_revision: source.repository_revision,
    },
  };
}

function deriveLabelEventDigest(label) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(canonicalLabelProjection(label))).digest("hex")}`;
}

// A snapshot_id deliberately excludes generated_at so identical evidence can be
// materialized reproducibly.  Calibration time ordering must not reuse that
// identity as an observation-time claim: verifier attestations bind this full
// canonical document digest instead.
function deriveSnapshotDocumentDigest(snapshot) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(snapshot)).digest("hex")}`;
}

function digestArtifactBytes(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function collectorSignature(snapshot) {
  if (!Array.isArray(snapshot?.collectors)) return null;
  const ids = new Set();
  const records = snapshot.collectors.map((collector) => {
    if (!isRecord(collector)) return null;
    const record = {};
    for (const field of ["collector_id", "collector_version", "status", "analyzer_identity", "analyzer_version"]) {
      if (!isNonBlankString(collector[field])) return null;
      record[field] = collector[field].trim();
    }
    if (ids.has(record.collector_id)) return null;
    ids.add(record.collector_id);
    return record;
  });
  if (records.some((record) => record === null)) return null;
  return stableStringify(records.sort((left, right) => stableCompare(left.collector_id, right.collector_id)));
}

function profileSignature(snapshot) {
  if (!Array.isArray(snapshot?.profiles)) return null;
  const ids = new Set();
  const records = snapshot.profiles.map((profile) => {
    if (!isRecord(profile)) return null;
    const record = {};
    for (const field of ["profile_id", "profile_version", "profile_contract_hash"]) {
      if (!isNonBlankString(profile[field])) return null;
      record[field] = profile[field].trim();
    }
    if (ids.has(record.profile_id)) return null;
    ids.add(record.profile_id);
    return record;
  });
  if (records.some((record) => record === null)) return null;
  return stableStringify(records.sort((left, right) => stableCompare(left.profile_id, right.profile_id)));
}

function assertCanonicalSnapshot(value, index) {
  const validation = validateSnapshot(value);
  if (!validation.ok) {
    fail("FAIL-CALIBRATION-EVIDENCE", `snapshots[${index}] is not a valid canonical snapshot (${validation.errors.join("; ")})`);
  }
  let materialized;
  try {
    materialized = materializeSnapshot(value);
  } catch (error) {
    fail("FAIL-CALIBRATION-EVIDENCE", `snapshots[${index}] cannot be canonically materialized (${error.message})`);
  }
  if (materialized.snapshot_id !== value.snapshot_id) {
    fail("FAIL-CALIBRATION-EVIDENCE", `snapshots[${index}] identity does not survive canonical materialization`);
  }
  return materialized;
}

function normalizeWindow(value, label) {
  assertClosed(value, ["window_id", "start", "end", "snapshot_ids"], label);
  const windowId = assertStableId(value.window_id, `${label}.window_id`);
  const start = parseTimestamp(value.start, `${label}.start`);
  const end = parseTimestamp(value.end, `${label}.end`);
  if (start >= end) fail("FAIL-CALIBRATION-CONTRACT", `${label}.start must precede ${label}.end`);
  if (!Array.isArray(value.snapshot_ids) || value.snapshot_ids.length === 0) {
    fail("FAIL-CALIBRATION-CONTRACT", `${label}.snapshot_ids must be a nonempty array`);
  }
  const ids = value.snapshot_ids.map((id, index) => assertStableId(id, `${label}.snapshot_ids[${index}]`));
  if (new Set(ids).size !== ids.length) fail("FAIL-CALIBRATION-LEAKAGE", `${label}.snapshot_ids contains a duplicate snapshot ID`);
  return { window_id: windowId, start: value.start, end: value.end, start_ms: start, end_ms: end, snapshot_ids: ids.sort(stableCompare) };
}

function validateUntrustedLabelClaims(labels) {
  for (const [index, value] of labels.entries()) {
    const label = `input.labels[${index}]`;
    assertClosed(value, ["label_id", "snapshot_id", "subject", "observed_at", "outcome", "source"], label);
    for (const field of ["label_id", "snapshot_id", "subject", "observed_at", "outcome", "source"]) {
      if (!(field in value)) fail("FAIL-CALIBRATION-CONTRACT", `${label}.${field} is required`);
    }
    assertClosed(value.source, ["authority", "artifact_ref", "artifact_sha256", "repository_revision"], `${label}.source`);
    for (const field of ["authority", "artifact_ref", "artifact_sha256", "repository_revision"]) {
      if (!(field in value.source)) fail("FAIL-CALIBRATION-CONTRACT", `${label}.source.${field} is required`);
    }
  }
}

function normalizeInput(input) {
  assertClosed(input, ["schema_version", "snapshots", "training", "holdout", "labels", "ranking_k"], "input");
  if (input.schema_version !== "1.0.0") fail("FAIL-CALIBRATION-CONTRACT", "input.schema_version must equal 1.0.0");
  if (!Array.isArray(input.snapshots) || input.snapshots.length === 0) {
    fail("FAIL-CALIBRATION-CONTRACT", "input.snapshots must be a nonempty array");
  }
  const snapshots = input.snapshots.map(assertCanonicalSnapshot);
  const snapshotById = new Map();
  for (const snapshot of snapshots) {
    if (snapshotById.has(snapshot.snapshot_id)) fail("FAIL-DUPLICATE-ID", `snapshots duplicates ${snapshot.snapshot_id}`);
    snapshotById.set(snapshot.snapshot_id, snapshot);
  }
  const training = normalizeWindow(input.training, "training");
  const holdout = normalizeWindow(input.holdout, "holdout");
  if (training.end_ms > holdout.start_ms) {
    fail("FAIL-CALIBRATION-LEAKAGE", "training and holdout windows overlap");
  }
  const trainingIds = new Set(training.snapshot_ids);
  const holdoutIds = new Set(holdout.snapshot_ids);
  for (const id of trainingIds) {
    if (!snapshotById.has(id)) fail("FAIL-CALIBRATION-EVIDENCE", `training references an unknown canonical snapshot ${id}`);
    if (holdoutIds.has(id)) fail("FAIL-CALIBRATION-LEAKAGE", `snapshot ${id} is present in both training and holdout`);
  }
  for (const id of holdoutIds) {
    if (!snapshotById.has(id)) fail("FAIL-CALIBRATION-EVIDENCE", `holdout references an unknown canonical snapshot ${id}`);
  }
  if (trainingIds.size + holdoutIds.size !== snapshotById.size) {
    fail("FAIL-CALIBRATION-CONTRACT", "input.snapshots must be partitioned exactly between training and holdout");
  }

  const orderedSnapshots = [...snapshotById.values()].sort((left, right) => stableCompare(left.snapshot_id, right.snapshot_id));
  const first = orderedSnapshots[0];
  const expectedEnvironment = {
    schema_version: first.schema_version,
    repository_id: first.repository.repository_id,
    configuration_hash: first.repository.configuration_hash,
    collectors: collectorSignature(first),
    profiles: profileSignature(first),
  };
  if (expectedEnvironment.collectors === null || expectedEnvironment.profiles === null) {
    fail("FAIL-CALIBRATION-EVIDENCE", "canonical snapshot collector or profile inventory is not usable for calibration");
  }
  for (const snapshot of orderedSnapshots.slice(1)) {
    if (
      snapshot.schema_version !== expectedEnvironment.schema_version ||
      snapshot.repository.repository_id !== expectedEnvironment.repository_id ||
      snapshot.repository.configuration_hash !== expectedEnvironment.configuration_hash ||
      collectorSignature(snapshot) !== expectedEnvironment.collectors ||
      profileSignature(snapshot) !== expectedEnvironment.profiles
    ) {
      fail("FAIL-CALIBRATION-INCOMPATIBLE", "canonical snapshots differ in schema, repository, configuration, collector, or profile bindings");
    }
  }
  if (!Array.isArray(input.labels)) fail("FAIL-CALIBRATION-CONTRACT", "input.labels must be an array");
  validateUntrustedLabelClaims(input.labels);
  if (!Number.isInteger(input.ranking_k) || input.ranking_k < 1) {
    fail("FAIL-CALIBRATION-CONTRACT", "input.ranking_k must be a positive integer");
  }
  return {
    snapshots: orderedSnapshots,
    snapshot_by_id: snapshotById,
    training,
    holdout,
    labels: input.labels,
    ranking_k: input.ranking_k,
    environment: expectedEnvironment,
  };
}

function collectorIsAvailable(snapshot, metric) {
  const collector = Array.isArray(snapshot.collectors)
    ? snapshot.collectors.find((candidate) => candidate?.collector_id === metric?.source?.collector_id)
    : null;
  return collector?.status === "available" &&
    collector.collector_version === metric?.source?.collector_version &&
    collector.analyzer_identity === metric?.analyzer_identity &&
    collector.analyzer_version === metric?.analyzer_version;
}

function metricEvidenceRefs(metric) {
  return [...new Set([
    ...(Array.isArray(metric?.source?.artifact_refs) ? metric.source.artifact_refs : []),
    ...(Array.isArray(metric?.source?.evidence_refs) ? metric.source.evidence_refs : []),
  ].filter(isNonBlankString))].sort(stableCompare);
}

function canonicalFilePathFromSubject(subject) {
  if (typeof subject !== "string" || !subject.startsWith("file:")) return null;
  const slashNormalized = subject.slice("file:".length).trim().replace(/\\/g, "/");
  if (!slashNormalized || slashNormalized.startsWith("/") || /^[A-Za-z]:\//.test(slashNormalized)) return null;
  const segments = slashNormalized.split("/");
  if (segments.some((segment) => segment === ".." || segment.includes("\u0000"))) return null;
  const canonical = segments.filter((segment) => segment !== "" && segment !== ".");
  return canonical.length > 0 ? canonical.join("/") : null;
}

function isObservedFeature(snapshot, metric) {
  const subjectPath = canonicalFilePathFromSubject(metric?.subject);
  return OBSERVED_STATUSES.has(metric?.measurement?.status) &&
    typeof metric?.value === "number" && Number.isFinite(metric.value) &&
    subjectPath !== null &&
    metric?.scope?.kind === "file" &&
    metric.scope.path === subjectPath &&
    metric.scope.generated_code === false &&
    metric.scope.included_in_human_maintainability === true &&
    metric.source?.repository_revision === snapshot.repository?.revision &&
    metric.repository_revision === snapshot.repository?.revision &&
    metricEvidenceRefs(metric).length > 0 &&
    collectorIsAvailable(snapshot, metric);
}

function featureSignature(metric) {
  return stableStringify({
    definition_id: metric.definition_id,
    analyzer_identity: metric.analyzer_identity,
    analyzer_version: metric.analyzer_version,
    collector_id: metric.source.collector_id,
    collector_version: metric.source.collector_version,
    window_kind: metric.window?.kind,
    window_start: metric.window?.start,
    configuration_hash: metric.comparability?.configuration_hash,
  });
}

function deriveCandidates(snapshot) {
  const bySubject = new Map();
  for (const metric of snapshot.measurements) {
    if (typeof metric?.subject !== "string" || !metric.subject.startsWith("file:")) continue;
    const spec = FEATURE_SPECS.find((candidate) => candidate.definition_id === metric.definition_id);
    if (!spec || !isObservedFeature(snapshot, metric)) continue;
    if (!bySubject.has(metric.subject)) bySubject.set(metric.subject, new Map());
    const byFeature = bySubject.get(metric.subject);
    if (byFeature.has(spec.key)) {
      fail("FAIL-CALIBRATION-EVIDENCE", `${snapshot.snapshot_id}/${metric.subject} has ambiguous ${spec.key} evidence`);
    }
    byFeature.set(spec.key, metric);
  }
  const candidates = [];
  for (const [subject, features] of bySubject.entries()) {
    if (!FEATURE_SPECS.every((spec) => features.has(spec.key))) continue;
    const featureValues = {};
    const featureBindings = {};
    const evidenceRefs = new Set();
    for (const spec of FEATURE_SPECS) {
      const metric = features.get(spec.key);
      featureValues[spec.key] = metric.value;
      featureBindings[spec.key] = featureSignature(metric);
      for (const ref of metricEvidenceRefs(metric)) evidenceRefs.add(ref);
    }
    candidates.push({
      observation_id: `${snapshot.snapshot_id}::${subject}`,
      snapshot_id: snapshot.snapshot_id,
      subject,
      repository_revision: snapshot.repository.revision,
      features: featureValues,
      feature_bindings: featureBindings,
      evidence_refs: [...evidenceRefs].sort(stableCompare),
    });
  }
  return candidates.sort((left, right) => stableCompare(left.observation_id, right.observation_id));
}

// Calibration does not treat any JSON label as trusted evidence.  A host-owned
// verifier must resolve immutable artifact bytes and return these closed
// statements.  The calibrator independently checks the returned bytes and the
// canonical snapshot document before exposing any score.
function hasOnlyKeys(value, allowedKeys) {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(descriptors).every((key) => (
      typeof key === "string" &&
      allowedKeys.includes(key) &&
      Object.hasOwn(descriptors[key], "value")
    ));
  } catch {
    return false;
  }
}

function safeAttestedId(value) {
  return isNonBlankString(value) ? value.trim() : null;
}

function parseAttestedTimestamp(value) {
  if (typeof value !== "string" || !RFC3339_WITH_OFFSET.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function unverifiableEvidence(reason) {
  return { ok: false, reason };
}

function normalizeVerifierAuthority(value) {
  if (!hasOnlyKeys(value, ["issuer_id", "issuer_key_id", "public_key", "attest", "read_artifact"]) ||
    !isNonBlankString(value.issuer_id) ||
    !isNonBlankString(value.issuer_key_id) ||
    !isNonBlankString(value.public_key) ||
    typeof value.attest !== "function" ||
    typeof value.read_artifact !== "function") {
    return null;
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(value.public_key);
  } catch {
    return null;
  }
  if (publicKey.asymmetricKeyType !== "ed25519") return null;
  return Object.freeze({
    issuer_id: value.issuer_id.trim(),
    issuer_key_id: value.issuer_key_id.trim(),
    public_key: publicKey,
    attest: value.attest,
    read_artifact: value.read_artifact,
  });
}

function attestationPayload(value) {
  return Buffer.from(stableStringify({
    schema_version: value.schema_version,
    kind: value.kind,
    issuer_id: value.issuer_id,
    issuer_key_id: value.issuer_key_id,
    statement: value.statement,
  }), "utf8");
}

function decodeEd25519Signature(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 64 && bytes.toString("base64") === value ? bytes : null;
}

function verifyAttestationEnvelope(value, authority) {
  if (!hasOnlyKeys(value, ["schema_version", "kind", "issuer_id", "issuer_key_id", "statement", "signature"]) ||
    value.schema_version !== ATTESTATION_SCHEMA_VERSION ||
    value.kind !== ATTESTATION_KIND ||
    value.issuer_id !== authority.issuer_id ||
    value.issuer_key_id !== authority.issuer_key_id ||
    !hasOnlyKeys(value.statement, ATTESTATION_STATEMENT_FIELDS) ||
    !hasOnlyKeys(value.signature, ["algorithm", "value"]) ||
    value.signature.algorithm !== "ed25519") {
    return unverifiableEvidence("the verifier returned a noncanonical attestation envelope");
  }
  const signature = decodeEd25519Signature(value.signature.value);
  if (signature === null) return unverifiableEvidence("the verifier attestation signature is not a canonical Ed25519 signature");
  let verified;
  try {
    verified = crypto.verify(null, attestationPayload(value), authority.public_key, signature);
  } catch {
    return unverifiableEvidence("the verifier attestation signature could not be checked");
  }
  if (!verified) return unverifiableEvidence("the verifier attestation signature does not bind its statement");
  return { ok: true, statement: value.statement };
}

function readImmutableArtifact(authority, artifactRef) {
  try {
    const bytes = authority.read_artifact(artifactRef);
    return Buffer.isBuffer(bytes) && bytes.length > 0 ? Buffer.from(bytes) : null;
  } catch {
    return null;
  }
}

function verifierRequest(context) {
  return {
    contract_version: ATTESTATION_SCHEMA_VERSION,
    snapshots: context.snapshots.map((snapshot) => ({
      snapshot_id: snapshot.snapshot_id,
      snapshot_document_sha256: deriveSnapshotDocumentDigest(snapshot),
      repository_id: snapshot.repository.repository_id,
      repository_revision: snapshot.repository.revision,
    })),
    training: {
      window_id: context.training.window_id,
      start: context.training.start,
      end: context.training.end,
      snapshot_ids: context.training.snapshot_ids.slice(),
    },
    holdout: {
      window_id: context.holdout.window_id,
      start: context.holdout.start,
      end: context.holdout.end,
      snapshot_ids: context.holdout.snapshot_ids.slice(),
    },
  };
}

function windowForSnapshot(context, snapshotId) {
  if (context.training.snapshot_ids.includes(snapshotId)) return context.training;
  if (context.holdout.snapshot_ids.includes(snapshotId)) return context.holdout;
  return null;
}

function isWithinWindow(timestamp, window) {
  return timestamp >= window.start_ms && timestamp < window.end_ms;
}

function normalizeVerifiedAttestations(context, verifier) {
  if (verifier === null) {
    return unverifiableEvidence("a host-owned verifier with immutable artifact resolution is required before calibration labels can be used");
  }

  let result;
  try {
    result = verifier.attest(verifierRequest(context));
  } catch {
    return unverifiableEvidence("the host-owned verifier did not produce an attestation result");
  }
  if (!hasOnlyKeys(result, ["status", "reason", "attestations"]) || !Array.isArray(result.attestations)) {
    return unverifiableEvidence("the verifier result is not a closed attestation envelope");
  }
  if (result.status === "unverifiable") {
    return unverifiableEvidence(isNonBlankString(result.reason) ? result.reason.trim() : "the verifier could not attest immutable label evidence");
  }
  if (result.status !== "verified" || result.reason !== null) {
    return unverifiableEvidence("the verifier result does not attest usable immutable label evidence");
  }

  const labels = [];
  const attestationIds = new Set();
  const eventIds = new Set();
  const observations = new Set();
  const snapshotObservations = new Map();

  for (const entry of result.attestations) {
    const attestation = verifyAttestationEnvelope(entry, verifier);
    if (!attestation.ok) return attestation;
    const statement = attestation.statement;
    const attestationId = safeAttestedId(statement.attestation_id);
    const eventId = safeAttestedId(statement.event_id);
    const snapshotId = safeAttestedId(statement.snapshot_id);
    const repositoryId = safeAttestedId(statement.repository_id);
    const repositoryRevision = safeAttestedId(statement.repository_revision);
    const subject = safeAttestedId(statement.subject);
    const artifactRef = safeAttestedId(statement.artifact_ref);
    const snapshotObservedAt = parseAttestedTimestamp(statement.snapshot_observed_at);
    const observedAt = parseAttestedTimestamp(statement.observed_at);
    if (!attestationId || !eventId || !snapshotId || !repositoryId || !repositoryRevision || !subject || !artifactRef || snapshotObservedAt === null || observedAt === null || !SHA256.test(statement.snapshot_document_sha256 ?? "") || !SHA256.test(statement.artifact_sha256 ?? "")) {
      return unverifiableEvidence("the verifier attestation has an invalid identity, digest, or timestamp binding");
    }
    if (!subject.startsWith("file:") || canonicalFilePathFromSubject(subject) === null || (statement.outcome !== "defect_observed" && statement.outcome !== "no_defect_observed")) {
      return unverifiableEvidence("the verifier attestation label subject or outcome is unsupported");
    }
    if (attestationIds.has(attestationId) || eventIds.has(eventId)) {
      return unverifiableEvidence("the verifier attestation duplicates an immutable event identity");
    }
    attestationIds.add(attestationId);
    eventIds.add(eventId);

    const snapshot = context.snapshot_by_id.get(snapshotId);
    if (!snapshot || snapshot.repository.repository_id !== repositoryId || snapshot.repository.revision !== repositoryRevision || deriveSnapshotDocumentDigest(snapshot) !== statement.snapshot_document_sha256) {
      return unverifiableEvidence("the verifier attestation does not bind the exact canonical snapshot document, repository, and revision");
    }
    const artifactBytes = readImmutableArtifact(verifier, artifactRef);
    if (artifactBytes === null) {
      return unverifiableEvidence("the verifier could not resolve immutable artifact bytes for its attestation");
    }
    if (digestArtifactBytes(artifactBytes) !== statement.artifact_sha256) {
      return unverifiableEvidence("the verifier artifact bytes do not match the attested immutable artifact digest");
    }
    const currentSnapshotObservation = snapshotObservations.get(snapshotId);
    if (currentSnapshotObservation !== undefined && currentSnapshotObservation !== snapshotObservedAt) {
      return unverifiableEvidence("the verifier gives contradictory observation times for one canonical snapshot");
    }
    snapshotObservations.set(snapshotId, snapshotObservedAt);

    const observationKey = `${snapshotId}\u0000${subject}`;
    if (observations.has(observationKey)) {
      return unverifiableEvidence("the verifier attestation duplicates one snapshot/file observation");
    }
    observations.add(observationKey);
    labels.push({
      label_id: eventId,
      snapshot_id: snapshotId,
      subject,
      observed_at: statement.observed_at,
      observed_at_ms: observedAt,
      snapshot_observed_at: statement.snapshot_observed_at,
      snapshot_observed_at_ms: snapshotObservedAt,
      outcome: statement.outcome,
      source: {
        artifact_ref: artifactRef,
        artifact_sha256: statement.artifact_sha256,
        repository_revision: repositoryRevision,
        attestation_id: attestationId,
        snapshot_document_sha256: statement.snapshot_document_sha256,
      },
    });
  }

  for (const snapshot of context.snapshots) {
    if (!snapshotObservations.has(snapshot.snapshot_id)) {
      return unverifiableEvidence("every calibration snapshot needs a verifier-attested observation time");
    }
  }
  for (const label of labels) {
    const window = windowForSnapshot(context, label.snapshot_id);
    if (!window || !isWithinWindow(label.snapshot_observed_at_ms, window) || !isWithinWindow(label.observed_at_ms, window)) {
      return unverifiableEvidence("the verifier attested a snapshot or label time outside its declared training or holdout window");
    }
    if (label.snapshot_observed_at_ms > label.observed_at_ms) {
      return unverifiableEvidence("the verifier attested a label before its canonical snapshot observation");
    }
  }
  const earliestHoldoutSnapshot = Math.min(...context.holdout.snapshot_ids.map((snapshotId) => snapshotObservations.get(snapshotId)));
  const latestTrainingLabel = labels
    .filter((label) => context.training.snapshot_ids.includes(label.snapshot_id))
    .reduce((latest, label) => Math.max(latest, label.observed_at_ms), Number.NEGATIVE_INFINITY);
  if (latestTrainingLabel >= earliestHoldoutSnapshot) {
    return unverifiableEvidence("training label outcomes must precede every holdout snapshot observation");
  }

  return {
    ok: true,
    labels: labels.sort((left, right) => stableCompare(left.label_id, right.label_id)),
    issuer_id: verifier.issuer_id,
    issuer_key_id: verifier.issuer_key_id,
    attestation_ids: [...attestationIds].sort(stableCompare),
    snapshot_observations: [...snapshotObservations.entries()]
      .map(([snapshot_id, observed_at_ms]) => ({ snapshot_id, observed_at_ms }))
      .sort((left, right) => stableCompare(left.snapshot_id, right.snapshot_id)),
  };
}

function attachLabels(candidates, labels) {
  const candidatesByKey = new Map(candidates.map((candidate) => [`${candidate.snapshot_id}\u0000${candidate.subject}`, candidate]));
  const labelsByKey = new Map(labels.map((label) => [`${label.snapshot_id}\u0000${label.subject}`, label]));
  for (const label of labels) {
    if (!candidatesByKey.has(`${label.snapshot_id}\u0000${label.subject}`)) {
      fail("FAIL-CALIBRATION-EVIDENCE", `label ${label.label_id} does not bind to a fully observed canonical feature vector`);
    }
  }
  const missing = candidates.filter((candidate) => !labelsByKey.has(`${candidate.snapshot_id}\u0000${candidate.subject}`));
  const observations = candidates
    .filter((candidate) => labelsByKey.has(`${candidate.snapshot_id}\u0000${candidate.subject}`))
    .map((candidate) => ({
      ...candidate,
      label: labelsByKey.get(`${candidate.snapshot_id}\u0000${candidate.subject}`),
      actual: labelsByKey.get(`${candidate.snapshot_id}\u0000${candidate.subject}`).outcome === "defect_observed" ? 1 : 0,
    }));
  return { observations, missing };
}

function assertFeatureCompatibility(observations) {
  const expected = new Map();
  for (const observation of observations) {
    for (const spec of FEATURE_SPECS) {
      const signature = observation.feature_bindings[spec.key];
      if (!expected.has(spec.key)) {
        expected.set(spec.key, signature);
      } else if (expected.get(spec.key) !== signature) {
        fail("FAIL-CALIBRATION-INCOMPATIBLE", `${spec.key} analyzer, collector, configuration, or window binding differs across snapshots`);
      }
    }
  }
}

function methodDefinitions() {
  return METHOD_SPECS.map((method) => ({
    method_id: method.method_id,
    feature_keys: method.feature_keys.slice(),
    score_interpretation: "training-minmax heuristic ranking score; not a probability",
  }));
}

function protocolReceipt(context, labels, trainingObservations, holdoutObservations, verification = null) {
  return {
    training_window: {
      window_id: context.training.window_id,
      start: context.training.start,
      end: context.training.end,
    },
    holdout_window: {
      window_id: context.holdout.window_id,
      start: context.holdout.start,
      end: context.holdout.end,
    },
    training_snapshot_ids: context.training.snapshot_ids.slice(),
    holdout_snapshot_ids: context.holdout.snapshot_ids.slice(),
    training_observation_ids: trainingObservations.map((observation) => observation.observation_id).sort(stableCompare),
    holdout_observation_ids: holdoutObservations.map((observation) => observation.observation_id).sort(stableCompare),
    label_evidence_refs: [...new Set(labels.map((label) => label.source.artifact_ref))].sort(stableCompare),
    verification: verification?.ok === true
      ? {
          status: "verified",
          issuer_id: verification.issuer_id,
          issuer_key_id: verification.issuer_key_id,
          attestation_ids: verification.attestation_ids.slice(),
          snapshot_ids: verification.snapshot_observations.map((entry) => entry.snapshot_id),
        }
      : {
          status: "unverifiable",
          reason: verification?.reason ?? "a verifier attestation is unavailable",
        },
  };
}

function labelReceipts(labels) {
  return labels.map((label) => ({
    label_id: label.label_id,
    snapshot_id: label.snapshot_id,
    subject: label.subject,
    observed_at: label.observed_at,
    outcome: label.outcome,
    source: { ...label.source },
  }));
}

function emptyResults(rankingK, reason, availability = "insufficient_data") {
  return METHOD_SPECS.map((method) => ({
    method_id: method.method_id,
    score_interpretation: "training-minmax heuristic ranking score; not a probability",
    ranking_k: rankingK,
    holdout_count: 0,
    positive_count: 0,
    negative_count: 0,
    precision_at_k: null,
    recall: null,
    lift_at_k: null,
    auc: null,
    calibration_error: null,
    metric_availability: {
      precision_at_k: availability,
      recall: availability,
      lift_at_k: availability,
      auc: availability,
      calibration_error: availability,
    },
    reason,
    holdout_ranking: [],
  }));
}

function insufficientReceipt(context, labels, candidates, reason, verification) {
  const training = candidates.filter((candidate) => context.training.snapshot_ids.includes(candidate.snapshot_id));
  const holdout = candidates.filter((candidate) => context.holdout.snapshot_ids.includes(candidate.snapshot_id));
  return {
    contract_version: "1.0.0",
    status: "insufficient_data",
    reason,
    model_status: "heuristic",
    calibration_status: "not_calibrated",
    score_kind: "training-minmax-heuristic-ranking-not-probability",
    repository: {
      repository_id: context.environment.repository_id,
      configuration_hash: context.environment.configuration_hash,
    },
    protocol: protocolReceipt(context, labels, training, holdout, verification),
    labels: labelReceipts(labels),
    methods: methodDefinitions(),
    results: emptyResults(context.ranking_k, reason),
  };
}

function unverifiableReceipt(context, reason) {
  return {
    contract_version: "1.0.0",
    status: "unverifiable",
    reason,
    model_status: "heuristic",
    calibration_status: "not_calibrated",
    score_kind: "training-minmax-heuristic-ranking-not-probability",
    repository: {
      repository_id: context.environment.repository_id,
      configuration_hash: context.environment.configuration_hash,
    },
    protocol: protocolReceipt(context, [], [], [], { ok: false, reason }),
    labels: [],
    methods: methodDefinitions(),
    results: emptyResults(context.ranking_k, reason, "unverifiable"),
  };
}

function trainingNormalizers(observations) {
  const normalizers = {};
  for (const spec of FEATURE_SPECS) {
    const values = observations.map((observation) => observation.features[spec.key]);
    normalizers[spec.key] = { min: Math.min(...values), max: Math.max(...values) };
  }
  return normalizers;
}

function normalizedScore(value, normalizer) {
  if (normalizer.max === normalizer.min) return 0.5;
  return Math.max(0, Math.min(1, (value - normalizer.min) / (normalizer.max - normalizer.min)));
}

function scoreObservation(observation, method, normalizers) {
  return method.feature_keys
    .map((key) => normalizedScore(observation.features[key], normalizers[key]))
    .reduce((total, score) => total + score, 0) / method.feature_keys.length;
}

function precisionAtK(ranking, k) {
  if (k > ranking.length) return null;
  return ranking.slice(0, k).reduce((total, entry) => total + entry.actual, 0) / k;
}

function auc(ranking) {
  const positives = ranking.filter((entry) => entry.actual === 1);
  const negatives = ranking.filter((entry) => entry.actual === 0);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.score > negative.score) wins += 1;
      else if (positive.score === negative.score) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

function calibrationError(ranking) {
  if (ranking.length === 0) return null;
  return ranking.reduce((total, entry) => total + Math.abs(entry.score - entry.actual), 0) / ranking.length;
}

function resultForMethod(method, holdout, normalizers, rankingK) {
  const ranking = holdout
    .map((observation) => ({
      observation_id: observation.observation_id,
      snapshot_id: observation.snapshot_id,
      subject: observation.subject,
      outcome: observation.label.outcome,
      score: scoreObservation(observation, method, normalizers),
      actual: observation.actual,
    }))
    .sort((left, right) => right.score - left.score || stableCompare(left.observation_id, right.observation_id));
  const positiveCount = ranking.filter((entry) => entry.actual === 1).length;
  const negativeCount = ranking.length - positiveCount;
  const precision = precisionAtK(ranking, rankingK);
  const recall = precision === null || positiveCount === 0 ? null : ranking.slice(0, rankingK).reduce((total, entry) => total + entry.actual, 0) / positiveCount;
  const lift = precision === null || positiveCount === 0 ? null : precision / (positiveCount / ranking.length);
  const aucValue = auc(ranking);
  const calibration = calibrationError(ranking);
  const availability = (value) => value === null ? "insufficient_data" : "available";
  return {
    method_id: method.method_id,
    score_interpretation: "training-minmax heuristic ranking score; not a probability",
    ranking_k: rankingK,
    holdout_count: ranking.length,
    positive_count: positiveCount,
    negative_count: negativeCount,
    precision_at_k: precision,
    recall,
    lift_at_k: lift,
    auc: aucValue,
    calibration_error: calibration,
    metric_availability: {
      precision_at_k: availability(precision),
      recall: availability(recall),
      lift_at_k: availability(lift),
      auc: availability(aucValue),
      calibration_error: availability(calibration),
    },
    reason: null,
    holdout_ranking: ranking.map(({ actual, ...entry }) => entry),
  };
}

// Calibration evidence can only be promoted by a repository-owned verifier
// integration with a pinned issuer and immutable artifact resolver.  This
// package deliberately does not provision that trust root.  In particular, a
// caller-supplied callback, public key, or self-signed envelope must not create
// an availability claim merely because it has the right object shape.
function evaluateHeuristicHotspots(input) {
  const context = normalizeInput(input);
  return unverifiableReceipt(
    context,
    "a repository-owned pinned calibration verifier authority is not provisioned",
  );
}

/*
 * The code below retains the closed receipt/calculation mechanics for a future
 * repository-owned integration.  It is intentionally unreachable from the
 * public API until that owner injects a non-caller-configurable trust root in a
 * separately reviewed seam.  Do not add a public factory or optional callback
 * here: that would make the verifier identity self-attested again.
 */
function evaluateVerifiedHeuristicHotspots(context, verification) {
  const labels = verification.labels;
  const candidates = context.snapshots.flatMap(deriveCandidates);
  const attached = attachLabels(candidates, labels);
  if (attached.missing.length > 0) {
    return insufficientReceipt(context, labels, candidates, "verifier-attested label coverage does not include every fully observed canonical feature vector", verification);
  }
  assertFeatureCompatibility(attached.observations);
  const training = attached.observations
    .filter((observation) => context.training.snapshot_ids.includes(observation.snapshot_id))
    .sort((left, right) => stableCompare(left.observation_id, right.observation_id));
  const holdout = attached.observations
    .filter((observation) => context.holdout.snapshot_ids.includes(observation.snapshot_id))
    .sort((left, right) => stableCompare(left.observation_id, right.observation_id));
  const trainingPositives = training.filter((observation) => observation.actual === 1).length;
  const holdoutPositives = holdout.filter((observation) => observation.actual === 1).length;
  if (training.length < 2 || holdout.length < 2 || trainingPositives === 0 || trainingPositives === training.length || holdoutPositives === 0 || holdoutPositives === holdout.length) {
    return insufficientReceipt(
      context,
      labels,
      attached.observations,
      "at least two labelled observations and both outcome classes are required in each disjoint training and holdout cohort",
      verification,
    );
  }
  const normalizers = trainingNormalizers(training);
  return {
    contract_version: "1.0.0",
    status: "available",
    reason: null,
    model_status: "heuristic",
    calibration_status: "not_calibrated",
    score_kind: "training-minmax-heuristic-ranking-not-probability",
    repository: {
      repository_id: context.environment.repository_id,
      configuration_hash: context.environment.configuration_hash,
    },
    protocol: protocolReceipt(context, labels, training, holdout, verification),
    labels: labelReceipts(labels),
    methods: methodDefinitions(),
    results: METHOD_SPECS.map((method) => resultForMethod(method, holdout, normalizers, context.ranking_k)),
  };
}

function backtestHeuristicHotspots(input) {
  return evaluateHeuristicHotspots(input);
}

function backtestHeuristicRisk(input) {
  return backtestHeuristicHotspots(input);
}

module.exports = {
  backtestHeuristicHotspots,
  backtestHeuristicRisk,
  deriveLabelEventDigest,
  deriveSnapshotDocumentDigest,
};
