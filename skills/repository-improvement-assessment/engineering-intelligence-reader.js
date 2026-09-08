"use strict";

const fs = require("node:fs");
const {
  assertArtifact,
  assertEngineeringIntelligenceRef,
  assertExpectedBinding,
  assertResolvedArtifactContained,
  canonicalBytes,
  deepEqual,
  fail,
  resolveArtifactFile,
  sha256Bytes,
} = require("./engineering-intelligence.js");

function assertReaderInput(input) {
  const allowed = ["repository_root", "engineering_intelligence_ref", "expected"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-READER-SCHEMA", "reader input contains unsupported fields");
  }
  if (typeof input.repository_root !== "string" || input.repository_root.trim().length === 0) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-READER-SCHEMA", "repository_root must be RIA-supplied storage context");
  }
  return {
    repository_root: input.repository_root,
    engineering_intelligence_ref: assertEngineeringIntelligenceRef(input.engineering_intelligence_ref),
    expected: assertExpectedBinding(input.expected),
  };
}

function assertBinding(ref, artifact, expected) {
  if (ref.repository_revision !== expected.repository_revision || ref.mission_id !== expected.mission_id || ref.scope_hash !== expected.scope_hash ||
      !deepEqual(ref.baseline_binding, expected.baseline_ref)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-BINDING-MISMATCH", "reference does not match expected RIA baseline, revision, mission, and scope binding");
  }
  if (artifact.repository_revision !== ref.repository_revision || artifact.mission_id !== ref.mission_id || artifact.scope_hash !== ref.scope_hash ||
      !deepEqual(artifact.baseline_binding, ref.baseline_binding)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-BINDING-MISMATCH", "artifact does not match its opaque reference binding");
  }
}

function readEngineeringIntelligenceArtifact(input) {
  const normalized = assertReaderInput(input);
  const storage = resolveArtifactFile(normalized.repository_root, normalized.engineering_intelligence_ref.sha256);
  let bytes;
  try {
    if (!fs.existsSync(storage.file_path)) {
      fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-NOT-FOUND", "no artifact exists at the canonical content-addressed location");
    }
    bytes = fs.readFileSync(assertResolvedArtifactContained(storage));
  } catch (error) {
    if (error.message?.startsWith("FAIL-ENGINEERING-INTELLIGENCE-")) throw error;
    fail("FAIL-ENGINEERING-INTELLIGENCE-STORAGE-READ", error.message);
  }
  if (sha256Bytes(bytes) !== normalized.engineering_intelligence_ref.sha256) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-HASH-MISMATCH", "artifact bytes do not match the opaque reference sha256");
  }
  let artifact;
  try {
    artifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-SCHEMA", "artifact bytes are not valid JSON");
  }
  if (!canonicalBytes(artifact).equals(bytes)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-CANONICAL", "artifact bytes must use RIA canonical JSON before semantic validation");
  }
  artifact = assertArtifact(artifact);
  assertBinding(normalized.engineering_intelligence_ref, artifact, normalized.expected);
  return artifact;
}

module.exports = { readEngineeringIntelligenceArtifact };
