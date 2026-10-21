"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { materializeSnapshot } = require("../shared/software-engineering-intelligence/intelligence-engine.js");
const {
  BASELINE_INDEX_KIND,
  BASELINE_PIN_KIND,
  ENGINEERING_INTELLIGENCE_KIND,
  ENGINEERING_INTELLIGENCE_SCHEMA_VERSION,
  RIA_OWNER,
  artifactId,
  assertArtifact,
  assertBaselineIntelligenceIndex,
  assertBaselineIntelligencePin,
  assertBaselineIndexMatchesPin,
  assertBaselineRef,
  assertResolvedArtifactContained,
  assertResolvedBaselineIndexContained,
  assertResolvedBaselinePinContained,
  baselineIndexHash,
  canonicalBytes,
  fail,
  resolveArtifactFile,
  resolveBaselineIndexFile,
  resolveBaselinePinFile,
  sha256Bytes,
} = require("./engineering-intelligence.js");
const { readEngineeringIntelligenceArtifact } = require("./engineering-intelligence-reader.js");

function assertWriterInput(input) {
  const allowed = ["repository_root", "baseline_ref", "mission_id", "scope_hash", "compute_snapshot"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-WRITER-SCHEMA", "writer input contains unsupported fields");
  }
  const baseline = assertBaselineRef(input.baseline_ref);
  if (typeof input.repository_root !== "string" || input.repository_root.trim().length === 0 ||
      typeof input.mission_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.mission_id) ||
      !/^[a-f0-9]{64}$/.test(input.scope_hash) || typeof input.compute_snapshot !== "function") {
    fail("FAIL-ENGINEERING-INTELLIGENCE-WRITER-SCHEMA", "writer input has invalid repository, identity, or compute fields");
  }
  return { ...input, baseline_ref: baseline };
}

function immutableWrite(storage, bytes) {
  const temporary = path.join(storage.artifact_root, `.${path.basename(storage.file_path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    try {
      fs.linkSync(temporary, storage.file_path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existingPath = assertResolvedArtifactContained(storage);
      const existing = fs.readFileSync(existingPath);
      if (!existing.equals(bytes)) {
        fail("FAIL-ENGINEERING-INTELLIGENCE-IMMUTABLE-CONFLICT", "content-addressed artifact path already contains different bytes");
      }
    }
  } catch (error) {
    if (error.message?.startsWith("FAIL-ENGINEERING-INTELLIGENCE-")) throw error;
    fail("FAIL-ENGINEERING-INTELLIGENCE-STORAGE-WRITE", error.message);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* temporary file was never created or already removed */ }
  }
}

function immutableIndexWrite(storage, bytes) {
  const temporary = path.join(storage.index_root, `.${path.basename(storage.index_file_path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    try {
      fs.linkSync(temporary, storage.index_file_path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existingPath = assertResolvedBaselineIndexContained(storage);
      const existing = fs.readFileSync(existingPath);
      if (!existing.equals(bytes)) {
        fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-IMMUTABLE-CONFLICT", "baseline index path already contains different immutable bytes");
      }
    }
  } catch (error) {
    if (error.message?.startsWith("FAIL-ENGINEERING-INTELLIGENCE-")) throw error;
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-WRITE", error.message);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* temporary file was never created or already removed */ }
  }
}

function immutablePinWrite(storage, bytes) {
  const temporary = path.join(storage.pin_root, `.${path.basename(storage.pin_file_path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    try {
      fs.linkSync(temporary, storage.pin_file_path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existingPath = assertResolvedBaselinePinContained(storage);
      const existing = fs.readFileSync(existingPath);
      if (!existing.equals(bytes)) {
        fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-IMMUTABLE-CONFLICT", "baseline pin path already contains different immutable bytes");
      }
    }
  } catch (error) {
    if (error.message?.startsWith("FAIL-ENGINEERING-INTELLIGENCE-")) throw error;
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-WRITE", error.message);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* temporary file was never created or already removed */ }
  }
}

function expectedBinding(normalized) {
  return {
    baseline_ref: normalized.baseline_ref,
    repository_revision: normalized.baseline_ref.repository_revision,
    mission_id: normalized.mission_id,
    scope_hash: normalized.scope_hash,
  };
}

function readBaselineIndex(storage, expected) {
  if (!fs.existsSync(storage.index_file_path)) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(assertResolvedBaselineIndexContained(storage));
  } catch (error) {
    if (error.message?.startsWith("FAIL-ENGINEERING-INTELLIGENCE-")) throw error;
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-READ", error.message);
  }
  let index;
  try {
    index = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-SCHEMA", "baseline index bytes are not valid JSON");
  }
  if (!canonicalBytes(index).equals(bytes)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-CANONICAL", "baseline index bytes must use RIA canonical JSON before semantic validation");
  }
  return assertBaselineIntelligenceIndex(index, expected);
}

function readBaselinePin(storage, expected) {
  if (!fs.existsSync(storage.pin_file_path)) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(assertResolvedBaselinePinContained(storage));
  } catch (error) {
    if (error.message?.startsWith("FAIL-ENGINEERING-INTELLIGENCE-")) throw error;
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-READ", error.message);
  }
  let pin;
  try {
    pin = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-SCHEMA", "baseline pin bytes are not valid JSON");
  }
  if (!canonicalBytes(pin).equals(bytes)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-CANONICAL", "baseline pin bytes must use RIA canonical JSON before semantic validation");
  }
  return assertBaselineIntelligencePin(pin, expected);
}

function reusePinnedArtifact(repositoryRoot, index, pin, expected) {
  const ref = assertBaselineIndexMatchesPin(index, pin);
  readEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    engineering_intelligence_ref: ref,
    expected,
  });
  return structuredClone(ref);
}

function indexStorage(repositoryRoot, expected) {
  return resolveBaselineIndexFile(repositoryRoot, baselineIndexHash(expected), { createRoot: true });
}

function pinStorage(repositoryRoot, expected) {
  return resolveBaselinePinFile(repositoryRoot, baselineIndexHash(expected), { createRoot: true });
}

function readEstablishedBaselineIntelligence(index, pin, expected) {
  const establishedIndex = readBaselineIndex(index, expected);
  const establishedPin = readBaselinePin(pin, expected);
  if (establishedIndex === null && establishedPin === null) return null;
  if (establishedIndex === null || establishedPin === null) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-PIN-INDEX-INCOMPLETE", "an established baseline requires both its immutable pin and reusable index");
  }
  return { index: establishedIndex, pin: establishedPin };
}

function acquireIndexLock(storage) {
  const lockPath = path.join(storage.index_root, `.${path.basename(storage.index_file_path)}.lock`);
  try {
    const descriptor = fs.openSync(lockPath, "wx");
    fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    return { descriptor, lock_path: lockPath };
  } catch (error) {
    if (error.code === "EEXIST") return null;
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-LOCK", error.message);
  }
}

function releaseIndexLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.descriptor); } catch { /* descriptor may already be closed after a failed write */ }
  try { fs.unlinkSync(lock.lock_path); } catch { /* failed creation or externally removed lock stays fail closed */ }
}

function writeEngineeringIntelligenceArtifact(input) {
  const normalized = assertWriterInput(input);
  const expected = expectedBinding(normalized);
  let storage = indexStorage(normalized.repository_root, expected);
  let pin = pinStorage(normalized.repository_root, expected);
  const existing = readEstablishedBaselineIntelligence(storage, pin, expected);
  if (existing) return reusePinnedArtifact(normalized.repository_root, existing.index, existing.pin, expected);

  const lock = acquireIndexLock(storage);
  if (!lock) {
    const afterContention = readEstablishedBaselineIntelligence(storage, pin, expected);
    if (afterContention) return reusePinnedArtifact(normalized.repository_root, afterContention.index, afterContention.pin, expected);
    fail("FAIL-ENGINEERING-INTELLIGENCE-INDEX-LOCKED", "baseline index is being established; retry after its immutable binding appears");
  }

  try {
    storage = indexStorage(normalized.repository_root, expected);
    pin = pinStorage(normalized.repository_root, expected);
    const afterLock = readEstablishedBaselineIntelligence(storage, pin, expected);
    if (afterLock) return reusePinnedArtifact(normalized.repository_root, afterLock.index, afterLock.pin, expected);

    let computed;
    try {
      computed = normalized.compute_snapshot({
        baseline_ref: structuredClone(normalized.baseline_ref),
        repository_revision: normalized.baseline_ref.repository_revision,
        mission_id: normalized.mission_id,
        scope_hash: normalized.scope_hash,
      });
    } catch (error) {
      fail("FAIL-ENGINEERING-INTELLIGENCE-COMPUTE", error.message ?? String(error));
    }

    let engineeringIntelligence;
    try {
      engineeringIntelligence = materializeSnapshot(computed);
    } catch (error) {
      fail("FAIL-ENGINEERING-INTELLIGENCE-COMPUTE", error.message ?? String(error));
    }
    if (engineeringIntelligence.repository.revision !== normalized.baseline_ref.repository_revision) {
      fail("FAIL-ENGINEERING-INTELLIGENCE-BINDING-MISMATCH", "computed SEI snapshot revision must match the established baseline");
    }

    const artifact = {
      schema_version: ENGINEERING_INTELLIGENCE_SCHEMA_VERSION,
      owner: RIA_OWNER,
      kind: ENGINEERING_INTELLIGENCE_KIND,
      repository_revision: normalized.baseline_ref.repository_revision,
      mission_id: normalized.mission_id,
      scope_hash: normalized.scope_hash,
      baseline_binding: structuredClone(normalized.baseline_ref),
      engineering_intelligence: engineeringIntelligence,
    };
    assertArtifact(artifact);
    const bytes = canonicalBytes(artifact);
    const sha256 = sha256Bytes(bytes);
    const artifactStorage = resolveArtifactFile(normalized.repository_root, sha256, { createRoot: true });
    immutableWrite(artifactStorage, bytes);
    const ref = {
      artifact_id: artifactId(sha256),
      owner: RIA_OWNER,
      kind: ENGINEERING_INTELLIGENCE_KIND,
      schema_version: ENGINEERING_INTELLIGENCE_SCHEMA_VERSION,
      sha256,
      repository_revision: artifact.repository_revision,
      mission_id: artifact.mission_id,
      scope_hash: artifact.scope_hash,
      baseline_binding: structuredClone(artifact.baseline_binding),
    };
    const baselinePin = {
      schema_version: ENGINEERING_INTELLIGENCE_SCHEMA_VERSION,
      owner: RIA_OWNER,
      kind: BASELINE_PIN_KIND,
      binding_hash: baselineIndexHash(expected),
      repository_revision: expected.repository_revision,
      mission_id: expected.mission_id,
      scope_hash: expected.scope_hash,
      baseline_binding: structuredClone(expected.baseline_ref),
      engineering_intelligence_ref: structuredClone(ref),
    };
    assertBaselineIntelligencePin(baselinePin, expected);
    immutablePinWrite(pin, canonicalBytes(baselinePin));
    const index = {
      schema_version: ENGINEERING_INTELLIGENCE_SCHEMA_VERSION,
      owner: RIA_OWNER,
      kind: BASELINE_INDEX_KIND,
      binding_hash: baselineIndexHash(expected),
      repository_revision: expected.repository_revision,
      mission_id: expected.mission_id,
      scope_hash: expected.scope_hash,
      baseline_binding: structuredClone(expected.baseline_ref),
      first_minted_artifact_id: ref.artifact_id,
      first_minted_sha256: ref.sha256,
      engineering_intelligence_ref: structuredClone(ref),
    };
    assertBaselineIntelligenceIndex(index, expected);
    immutableIndexWrite(storage, canonicalBytes(index));
    return ref;
  } finally {
    releaseIndexLock(lock);
  }
}

module.exports = { writeEngineeringIntelligenceArtifact };
