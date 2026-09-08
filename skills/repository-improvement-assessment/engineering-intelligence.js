"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("./engineering-intelligence.schema.json");
const { validateAgainstSchema } = require("../shared/software-engineering-intelligence/schema-validator.js");
const { validateSnapshot } = require("../shared/software-engineering-intelligence/intelligence-engine.js");
const projectWorkspace = require("../shared/project-intelligence-workspace/project-intelligence-workspace.js");

const RIA_OWNER = "repository-improvement-assessment";
const ENGINEERING_INTELLIGENCE_KIND = "engineering-intelligence";
const ENGINEERING_INTELLIGENCE_SCHEMA_VERSION = "1.0.0";
const BASELINE_INDEX_KIND = "engineering-intelligence-baseline-index";
const BASELINE_PIN_KIND = "engineering-intelligence-baseline-pin";
const OWNER_IDS = Object.freeze([
  "repository-health-assessment",
  "codebase-integrity-audit-loop",
  "architecture-improvement-intelligence",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, message) {
  throw new Error(`${code}: ${message}`);
}

function stableStringify(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("FAIL-ENGINEERING-INTELLIGENCE-CANONICALIZATION", "artifact content must not contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) fail("FAIL-ENGINEERING-INTELLIGENCE-CANONICALIZATION", `artifact content has undefined ${key}`);
      return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
    }).join(",")}}`;
  }
  fail("FAIL-ENGINEERING-INTELLIGENCE-CANONICALIZATION", "artifact content must be JSON data");
}

function canonicalBytes(value) {
  return Buffer.from(`${stableStringify(value)}\n`, "utf8");
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function deepEqual(left, right) {
  try {
    return stableStringify(left) === stableStringify(right);
  } catch {
    return false;
  }
}

function schemaErrors(value, definition) {
  return validateAgainstSchema(value, { $defs: schema.$defs, $ref: `#/$defs/${definition}` });
}

function assertSchema(value, definition, code) {
  const errors = schemaErrors(value, definition);
  if (errors.length > 0) fail(code, errors.join("; "));
}

function artifactId(sha256) {
  return `engineering-intelligence:${sha256}`;
}

function assertBaselineRef(value, code = "FAIL-ENGINEERING-INTELLIGENCE-BASELINE-SCHEMA") {
  assertSchema(value, "baselineRef", code);
  return structuredClone(value);
}

function assertEngineeringIntelligenceRef(value, code = "FAIL-ENGINEERING-INTELLIGENCE-REF-SCHEMA") {
  assertSchema(value, "engineeringIntelligenceRef", code);
  if (value.artifact_id !== artifactId(value.sha256)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-REF-CONTRACT", "artifact_id must derive from sha256");
  }
  assertBaselineRef(value.baseline_binding, "FAIL-ENGINEERING-INTELLIGENCE-REF-SCHEMA");
  if (value.repository_revision !== value.baseline_binding.repository_revision) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-REF-CONTRACT", "repository_revision must match baseline_binding.repository_revision");
  }
  return structuredClone(value);
}

function assertSeiAssessmentRef(value, expected = {}) {
  if (isRecord(value) && isRecord(value.evaluator) && value.evaluator.id !== "sei.engineering-assessment") {
    fail("FAIL-SEI-ASSESSMENT-OWNER", "SEI assessment evidence must be produced by the SEI engineering-assessment evaluator");
  }
  assertSchema(value, "seiAssessmentRef", "FAIL-SEI-ASSESSMENT-REF-SCHEMA");
  if (!isRecord(expected) || Object.keys(expected).some((key) => key !== "repository_revision")) {
    fail("FAIL-SEI-ASSESSMENT-EXPECTED-SCHEMA", "expected SEI assessment binding must contain only repository_revision");
  }
  if (typeof expected.repository_revision !== "string" || expected.repository_revision.length === 0) {
    fail("FAIL-SEI-ASSESSMENT-EXPECTED-SCHEMA", "expected SEI assessment repository_revision must be a non-empty stable id");
  }
  if (value.snapshot_binding.revision !== expected.repository_revision) {
    fail("FAIL-SEI-ASSESSMENT-BINDING-MISMATCH", "SEI assessment snapshot revision must match RIA's baseline repository revision");
  }

  const artifactPath = path.resolve(value.artifact_path);
  let bytes;
  try {
    const stats = fs.statSync(artifactPath);
    if (!stats.isFile()) fail("FAIL-SEI-ASSESSMENT-ARTIFACT-NOT-FOUND", "assessment artifact path must resolve to a regular file");
    bytes = fs.readFileSync(fs.realpathSync(artifactPath));
  } catch (error) {
    if (error.message?.startsWith("FAIL-SEI-ASSESSMENT-")) throw error;
    fail("FAIL-SEI-ASSESSMENT-ARTIFACT-NOT-FOUND", "assessment artifact is not readable");
  }
  if (sha256Bytes(bytes) !== value.artifact_sha256) {
    fail("FAIL-SEI-ASSESSMENT-HASH-MISMATCH", "assessment artifact bytes do not match artifact_sha256");
  }
  let artifact;
  try {
    artifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("FAIL-SEI-ASSESSMENT-ARTIFACT-SCHEMA", "assessment artifact bytes are not valid JSON");
  }
  const exactBinding = isRecord(artifact) &&
    artifact.schema_version === value.schema_version &&
    artifact.assessment_id === value.assessment_id &&
    artifact.snapshot_binding?.snapshot_id === value.snapshot_binding.snapshot_id &&
    artifact.snapshot_binding?.repository_id === value.snapshot_binding.repository_id &&
    artifact.snapshot_binding?.repository_revision === value.snapshot_binding.revision &&
    artifact.snapshot_binding?.configuration_hash === value.snapshot_binding.digest &&
    artifact.evaluator?.evaluator_id === value.evaluator.id &&
    artifact.evaluator?.version === value.evaluator.version &&
    artifact.rubric?.rubric_id === value.rubric.id &&
    artifact.rubric?.version === value.rubric.version &&
    artifact.rubric?.digest === value.rubric.digest &&
    artifact.standard?.standard_id === value.standard.id &&
    artifact.standard?.version === value.standard.version &&
    artifact.standard?.digest === value.standard.digest &&
    artifact.snapshot_binding?.configuration_hash === value.config_digest &&
    artifact.applicability?.digest === value.applicability_digest;
  if (!exactBinding) {
    fail("FAIL-SEI-ASSESSMENT-ARTIFACT-BINDING", "assessment artifact must exactly echo the sidecar provenance binding");
  }
  return structuredClone(value);
}

function assertExpectedBinding(value) {
  const allowed = ["baseline_ref", "repository_revision", "mission_id", "scope_hash"];
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(value, key))) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-BINDING-SCHEMA", "expected binding must contain only baseline_ref, repository_revision, mission_id, and scope_hash");
  }
  const baseline = assertBaselineRef(value.baseline_ref, "FAIL-ENGINEERING-INTELLIGENCE-BINDING-SCHEMA");
  if (typeof value.repository_revision !== "string" || value.repository_revision.length === 0 ||
      typeof value.mission_id !== "string" || value.mission_id.length === 0 ||
      !/^[a-f0-9]{64}$/.test(value.scope_hash)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-BINDING-SCHEMA", "expected binding has invalid identity fields");
  }
  if (baseline.repository_revision !== value.repository_revision) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-BINDING-SCHEMA", "expected repository_revision must match its baseline_ref");
  }
  return {
    baseline_ref: baseline,
    repository_revision: value.repository_revision,
    mission_id: value.mission_id,
    scope_hash: value.scope_hash,
  };
}

function baselineIndexIdentity(expected) {
  const binding = assertExpectedBinding(expected);
  return {
    schema_version: ENGINEERING_INTELLIGENCE_SCHEMA_VERSION,
    kind: BASELINE_INDEX_KIND,
    repository_revision: binding.repository_revision,
    mission_id: binding.mission_id,
    scope_hash: binding.scope_hash,
    baseline_binding: binding.baseline_ref,
  };
}

function baselineIndexHash(expected) {
  return sha256Bytes(canonicalBytes(baselineIndexIdentity(expected)));
}

function assertBaselineIntelligenceIndex(value, expected, code = "FAIL-ENGINEERING-INTELLIGENCE-INDEX-SCHEMA") {
  assertSchema(value, "baselineIntelligenceIndex", code);
  const binding = assertExpectedBinding(expected);
  const expectedHash = baselineIndexHash(binding);
  if (value.binding_hash !== expectedHash || value.repository_revision !== binding.repository_revision ||
      value.mission_id !== binding.mission_id || value.scope_hash !== binding.scope_hash ||
      !deepEqual(value.baseline_binding, binding.baseline_ref)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-BINDING-MISMATCH", "baseline index must match the established baseline, revision, mission, scope, and canonical binding hash");
  }
  const ref = assertEngineeringIntelligenceRef(value.engineering_intelligence_ref, code);
  if (ref.repository_revision !== binding.repository_revision || ref.mission_id !== binding.mission_id ||
      ref.scope_hash !== binding.scope_hash || !deepEqual(ref.baseline_binding, binding.baseline_ref)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-BINDING-MISMATCH", "baseline index evidence ref must match the established baseline, revision, mission, and scope");
  }
  if (value.first_minted_artifact_id !== artifactId(value.first_minted_sha256) ||
      value.first_minted_artifact_id !== ref.artifact_id || value.first_minted_sha256 !== ref.sha256) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-FIRST-MINTED-MISMATCH", "baseline index evidence ref must remain the immutable canonical first-minted artifact");
  }
  return structuredClone(value);
}

function assertBaselineIntelligencePin(value, expected, code = "FAIL-ENGINEERING-INTELLIGENCE-PIN-SCHEMA") {
  assertSchema(value, "baselineIntelligencePin", code);
  const binding = assertExpectedBinding(expected);
  const expectedHash = baselineIndexHash(binding);
  if (value.binding_hash !== expectedHash || value.repository_revision !== binding.repository_revision ||
      value.mission_id !== binding.mission_id || value.scope_hash !== binding.scope_hash ||
      !deepEqual(value.baseline_binding, binding.baseline_ref)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-BINDING-MISMATCH", "baseline pin must match the established baseline, revision, mission, scope, and canonical binding hash");
  }
  const ref = assertEngineeringIntelligenceRef(value.engineering_intelligence_ref, code);
  if (ref.repository_revision !== binding.repository_revision || ref.mission_id !== binding.mission_id ||
      ref.scope_hash !== binding.scope_hash || !deepEqual(ref.baseline_binding, binding.baseline_ref)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-BINDING-MISMATCH", "baseline pin evidence ref must match the established baseline, revision, mission, and scope");
  }
  return structuredClone(value);
}

function assertBaselineIndexMatchesPin(index, pin) {
  const indexRef = assertEngineeringIntelligenceRef(index.engineering_intelligence_ref, "FAIL-ENGINEERING-INTELLIGENCE-PIN-INDEX-MISMATCH");
  const pinRef = assertEngineeringIntelligenceRef(pin.engineering_intelligence_ref, "FAIL-ENGINEERING-INTELLIGENCE-PIN-INDEX-MISMATCH");
  if (!deepEqual(indexRef, pinRef) || index.first_minted_artifact_id !== pinRef.artifact_id ||
      index.first_minted_sha256 !== pinRef.sha256) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-INDEX-MISMATCH", "baseline index must agree with the independent immutable first-minted baseline pin");
  }
  return structuredClone(pinRef);
}

function assertArtifact(value, code = "FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-SCHEMA") {
  assertSchema(value, "engineeringIntelligenceArtifact", code);
  const baseline = assertBaselineRef(value.baseline_binding, code);
  if (value.repository_revision !== baseline.repository_revision) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-CONTRACT", "artifact repository_revision must match baseline_binding.repository_revision");
  }
  const snapshotValidation = validateSnapshot(value.engineering_intelligence);
  if (!snapshotValidation.ok) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-CONTRACT", `embedded SEI snapshot is invalid: ${snapshotValidation.errors.join("; ")}`);
  }
  if (value.engineering_intelligence.repository?.revision !== value.repository_revision) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-CONTRACT", "embedded SEI snapshot revision must bind repository_revision");
  }
  return structuredClone(value);
}

function resolveArtifactRoot(repositoryRoot, { create = false } = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim().length === 0) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-STORAGE-CONTAINMENT", "repository_root must be a non-empty path supplied by RIA, not an artifact reference");
  }
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  if (!fs.existsSync(resolvedRepositoryRoot)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-STORAGE-CONTAINMENT", "repository_root does not exist");
  }
  const canonicalRepositoryRoot = fs.realpathSync(resolvedRepositoryRoot);
  const workspace = projectWorkspace.ensureWorkspace(canonicalRepositoryRoot);
  const configuredRoot = path.resolve(workspace.paths.evidence, "engineering-intelligence");
  assertContained(canonicalRepositoryRoot, configuredRoot, "artifact root");
  if (create) fs.mkdirSync(configuredRoot, { recursive: true });
  if (!fs.existsSync(configuredRoot)) return { repository_root: canonicalRepositoryRoot, artifact_root: configuredRoot };
  const canonicalArtifactRoot = fs.realpathSync(configuredRoot);
  assertContained(canonicalRepositoryRoot, canonicalArtifactRoot, "artifact root");
  return { repository_root: canonicalRepositoryRoot, artifact_root: canonicalArtifactRoot };
}


function legacyArtifactRoot(repositoryRoot) {
  return path.resolve(repositoryRoot, ".autonomous-loop", "assessment-artifacts", "engineering-intelligence");
}

function copyLegacyCandidateIfPresent(repositoryRoot, legacyFile, canonicalFile) {
  if (fs.existsSync(canonicalFile) || !fs.existsSync(legacyFile)) return;
  const legacyRoot = legacyArtifactRoot(repositoryRoot);
  assertContained(repositoryRoot, legacyRoot, "legacy artifact root");
  assertContained(legacyRoot, legacyFile, "legacy artifact file");
  fs.mkdirSync(path.dirname(canonicalFile), { recursive: true });
  try { fs.copyFileSync(legacyFile, canonicalFile, fs.constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-STORAGE-CONTAINMENT", `${label} must stay within RIA's canonical artifact root`);
  }
}

function resolveArtifactFile(repositoryRoot, sha256, { createRoot = false } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-REF-SCHEMA", "sha256 must be a lowercase digest before a storage path is derived");
  }
  const storage = resolveArtifactRoot(repositoryRoot, { create: createRoot });
  const filePath = path.resolve(storage.artifact_root, `${sha256}.json`);
  assertContained(storage.artifact_root, filePath, "artifact file");
  const legacyFile = path.resolve(legacyArtifactRoot(storage.repository_root), `${sha256}.json`);
  if (createRoot) copyLegacyCandidateIfPresent(storage.repository_root, legacyFile, filePath);
  if (!createRoot && !fs.existsSync(filePath) && fs.existsSync(legacyFile)) {
    const legacyRoot = legacyArtifactRoot(storage.repository_root);
    return { repository_root: storage.repository_root, artifact_root: legacyRoot, file_path: legacyFile, legacy: true };
  }
  return { ...storage, file_path: filePath, legacy: false };
}

function resolveBaselineIndexFile(repositoryRoot, bindingHash, { createRoot = false } = {}) {
  if (!/^[a-f0-9]{64}$/.test(bindingHash)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-SCHEMA", "baseline index hash must be a lowercase digest before a storage path is derived");
  }
  const storage = resolveArtifactRoot(repositoryRoot, { create: createRoot });
  const configuredIndexRoot = path.resolve(storage.artifact_root, "baseline-index");
  assertContained(storage.artifact_root, configuredIndexRoot, "baseline index root");
  if (createRoot) fs.mkdirSync(configuredIndexRoot, { recursive: true });
  const indexRoot = fs.existsSync(configuredIndexRoot)
    ? fs.realpathSync(configuredIndexRoot)
    : configuredIndexRoot;
  assertContained(storage.artifact_root, indexRoot, "baseline index root");
  const indexFilePath = path.resolve(indexRoot, `${bindingHash}.json`);
  assertContained(indexRoot, indexFilePath, "baseline index file");
  const legacyRoot = path.resolve(legacyArtifactRoot(storage.repository_root), "baseline-index");
  const legacyFile = path.resolve(legacyRoot, `${bindingHash}.json`);
  if (createRoot) copyLegacyCandidateIfPresent(storage.repository_root, legacyFile, indexFilePath);
  if (!createRoot && !fs.existsSync(indexFilePath) && fs.existsSync(legacyFile)) {
    return { ...storage, artifact_root: legacyArtifactRoot(storage.repository_root), index_root: legacyRoot, index_file_path: legacyFile, legacy: true };
  }
  return { ...storage, index_root: indexRoot, index_file_path: indexFilePath, legacy: false };
}

function resolveBaselinePinFile(repositoryRoot, bindingHash, { createRoot = false } = {}) {
  if (!/^[a-f0-9]{64}$/.test(bindingHash)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-SCHEMA", "baseline pin hash must be a lowercase digest before a storage path is derived");
  }
  const storage = resolveArtifactRoot(repositoryRoot, { create: createRoot });
  const configuredPinRoot = path.resolve(storage.artifact_root, "baseline-pin");
  assertContained(storage.artifact_root, configuredPinRoot, "baseline pin root");
  if (createRoot) fs.mkdirSync(configuredPinRoot, { recursive: true });
  const pinRoot = fs.existsSync(configuredPinRoot)
    ? fs.realpathSync(configuredPinRoot)
    : configuredPinRoot;
  assertContained(storage.artifact_root, pinRoot, "baseline pin root");
  const pinFilePath = path.resolve(pinRoot, `${bindingHash}.json`);
  assertContained(pinRoot, pinFilePath, "baseline pin file");
  const legacyRoot = path.resolve(legacyArtifactRoot(storage.repository_root), "baseline-pin");
  const legacyFile = path.resolve(legacyRoot, `${bindingHash}.json`);
  if (createRoot) copyLegacyCandidateIfPresent(storage.repository_root, legacyFile, pinFilePath);
  if (!createRoot && !fs.existsSync(pinFilePath) && fs.existsSync(legacyFile)) {
    return { ...storage, artifact_root: legacyArtifactRoot(storage.repository_root), pin_root: legacyRoot, pin_file_path: legacyFile, legacy: true };
  }
  return { ...storage, pin_root: pinRoot, pin_file_path: pinFilePath, legacy: false };
}

function assertResolvedContainedFile(root, filePath, label) {
  const canonicalFile = fs.realpathSync(filePath);
  assertContained(root, canonicalFile, label);
  return canonicalFile;
}

function assertResolvedArtifactContained(storage) {
  return assertResolvedContainedFile(storage.artifact_root, storage.file_path, "artifact file");
}

function assertResolvedBaselineIndexContained(storage) {
  return assertResolvedContainedFile(storage.index_root, storage.index_file_path, "baseline index file");
}

function assertResolvedBaselinePinContained(storage) {
  return assertResolvedContainedFile(storage.pin_root, storage.pin_file_path, "baseline pin file");
}

function validateAssessProjection(value) {
  const errors = schemaErrors(value, "assessProjection");
  if (errors.length > 0) return { ok: false, errors: errors.map((error) => `FAIL-RIA-ASSESS-PROJECTION-SCHEMA: ${error}`) };
  try {
    const baseline = assertBaselineRef(value.baseline_ref, "FAIL-RIA-ASSESS-PROJECTION-SCHEMA");
    const intelligence = assertEngineeringIntelligenceRef(value.engineering_intelligence_ref, "FAIL-RIA-ASSESS-PROJECTION-SCHEMA");
    if (!deepEqual(baseline, intelligence.baseline_binding)) {
      throw new Error("FAIL-RIA-ASSESS-PROJECTION-BINDING: engineering_intelligence_ref must bind the projection baseline_ref");
    }
    if (Object.hasOwn(value, "sei_assessment_ref")) {
      assertSeiAssessmentRef(value.sei_assessment_ref, { repository_revision: baseline.repository_revision });
    }
    const owners = new Set();
    value.assessment_refs.forEach((ref, index) => {
      assertSchema(ref, "ownerAssessmentRef", "FAIL-RIA-ASSESS-PROJECTION-SCHEMA");
      if (ref.repository_revision !== baseline.repository_revision) {
        throw new Error(`FAIL-RIA-ASSESS-PROJECTION-BINDING: assessment_refs[${index}] revision must match baseline_ref`);
      }
      if (owners.has(ref.owner)) throw new Error(`FAIL-RIA-ASSESS-PROJECTION-CONTRACT: duplicate owner ${ref.owner}`);
      owners.add(ref.owner);
      if (ref.owner !== OWNER_IDS[index]) throw new Error("FAIL-RIA-ASSESS-PROJECTION-CONTRACT: assessment_refs must retain canonical owner order");
    });
    if (!deepEqual([...owners].sort(), [...OWNER_IDS].sort())) {
      throw new Error("FAIL-RIA-ASSESS-PROJECTION-CONTRACT: assessment_refs must contain exactly the three canonical owners");
    }
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}

module.exports = {
  BASELINE_INDEX_KIND,
  BASELINE_PIN_KIND,
  ENGINEERING_INTELLIGENCE_KIND,
  ENGINEERING_INTELLIGENCE_SCHEMA_VERSION,
  OWNER_IDS,
  RIA_OWNER,
  artifactId,
  assertArtifact,
  assertBaselineRef,
  assertBaselineIntelligenceIndex,
  assertBaselineIntelligencePin,
  assertBaselineIndexMatchesPin,
  assertEngineeringIntelligenceRef,
  assertSeiAssessmentRef,
  assertExpectedBinding,
  assertResolvedArtifactContained,
  assertResolvedBaselineIndexContained,
  assertResolvedBaselinePinContained,
  baselineIndexHash,
  canonicalBytes,
  deepEqual,
  fail,
  resolveArtifactFile,
  resolveBaselineIndexFile,
  resolveBaselinePinFile,
  sha256Bytes,
  stableStringify,
  validateAssessProjection,
};
