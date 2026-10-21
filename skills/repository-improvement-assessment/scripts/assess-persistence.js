"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { recordArtifact, publishCurrent, lineagePath } = require("./workspace-lineage.js");
const { repositoryIdentity } = require("./startup-resolver.js");
const { SCHEMA_VERSION: VERIFICATION_SCHEMA_VERSION } = require("../../shared/assessment-verification-baseline/verification-baseline.js");
const storage = require("./durable-storage.js");

const OWNER_TASKS = Object.freeze({
  "owner-health": "repository-health-assessment",
  "owner-integrity": "codebase-integrity-audit-loop",
  "owner-architecture": "architecture-improvement-intelligence",
});
const skillsRoot = path.resolve(__dirname, "..", "..");

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}
function digestFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}
function existingFile(filePath) {
  if (!filePath) return null;
  try {
    const resolved = path.resolve(filePath);
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}
function storeValue(repositoryRoot, durableMode, namespace, value) {
  return storage.storeJsonArtifact(repositoryRoot, durableMode, "assessments", namespace, value);
}
function ownerContract(owner) {
  const filePath = path.join(skillsRoot, owner, "RUNTIME-CONTRACT.json");
  const bytes = fs.readFileSync(filePath);
  return { version: JSON.parse(bytes.toString("utf8")).version, sha256: sha256(bytes) };
}

function persistAssessmentArtifacts({
  repositoryRoot,
  durableMode = "git",
  baseline,
  execution,
  projection = null,
  required = "assess",
}) {
  // Must use the same scope the resolver will use, or the fingerprint recorded here never
  // matches the one looked up and every run rebuilds what it already has.
  const id = repositoryIdentity(repositoryRoot, durableMode, baseline.repository?.scope ?? "head");
  const binding = baseline.sei_compatibility_binding || {};
  const results = execution?.task_results || {};
  const recorded = { sei: false, verification: false, owners: [] };
  let assess = null;

  const sei = results["sei-snapshot"];
  const eiRef = sei?.engineering_intelligence_ref;
  if (eiRef) {
    const source = existingFile(sei.artifact_path) || existingFile(eiRef.path);
    const file = source
      ? { path: source, sha256: digestFile(source) }
      : storeValue(repositoryRoot, durableMode, "ria-sei-refs", eiRef);
    recordArtifact(repositoryRoot, "sei", {
      repository_key: id.repository_key,
      revision: id.revision,
      working_tree_fingerprint: id.working_tree_fingerprint,
      engine_version: binding.engine_version,
      config_hash: binding.config_hash,
      execution_contract_hash: binding.execution_contract_hash,
      sha256: file.sha256,
      path: file.path,
      artifact_id: eiRef.artifact_id,
    }, { durableMode });
    recorded.sei = true;
  }

  const verification = results["verification-baseline"];
  const vRef = verification?.verification_baseline_ref;
  if (vRef) {
    const source = existingFile(verification.writer?.path) || existingFile(vRef.path) || existingFile(verification.path);
    const file = source
      ? { path: source, sha256: digestFile(source) }
      : storeValue(repositoryRoot, durableMode, "ria-verification-refs", vRef);
    recordArtifact(repositoryRoot, "verification", {
      repository_key: id.repository_key,
      revision: id.revision,
      working_tree_fingerprint: id.working_tree_fingerprint,
      baseline_sha256: baseline.content_sha256,
      verifier_version: VERIFICATION_SCHEMA_VERSION,
      contract_hash: sha256(JSON.stringify(baseline.verification_contract || {})),
      config_hash: binding.config_hash,
      content_sha256: vRef.content_sha256 || file.sha256,
      file_sha256: vRef.file_sha256 || file.sha256,
      path: file.path,
      artifact_id: vRef.artifact_id,
    }, { durableMode });
    recorded.verification = true;
  }

  for (const [taskId, owner] of Object.entries(OWNER_TASKS)) {
    const ownerReturn = results[taskId];
    const artifactPath = existingFile(ownerReturn?.artifact_path);
    if (!artifactPath) continue;
    const contract = ownerContract(owner);
    recordArtifact(repositoryRoot, "owner", {
      owner,
      owner_version: contract.version,
      repository_key: id.repository_key,
      revision: id.revision,
      working_tree_fingerprint: id.working_tree_fingerprint,
      baseline_sha256: baseline.content_sha256,
      engineering_intelligence_sha256: eiRef?.sha256 || "0".repeat(64),
      runtime_contract_sha256: contract.sha256,
      sha256: ownerReturn.file_sha256 || digestFile(artifactPath),
      path: artifactPath,
      artifact_id: ownerReturn.canonical_artifact_ref?.artifact_id,
    }, { durableMode });
    recorded.owners.push(owner);
  }

  if (projection?.stage === "ASSESS") {
    const stored = storage.storeJsonArtifact(repositoryRoot, durableMode, "assessments", "ria", projection);
    assess = { path: stored.path, sha256: stored.sha256, artifact_id: `ria-assess:${stored.sha256}`, repository_revision: projection.baseline_ref.repository_revision };
  }
  const current = publishCurrent(repositoryRoot, { durableMode, assess });

  if (required === "assess") {
    const missing = [];
    if (!recorded.sei) missing.push("sei");
    if (!recorded.verification) missing.push("verification");
    for (const owner of Object.values(OWNER_TASKS)) if (!recorded.owners.includes(owner)) missing.push(owner);
    if (!assess) missing.push("assess-projection");
    if (missing.length) {
      const error = new Error(`FAIL-RIA-LINEAGE-INCOMPLETE: missing ${missing.join(", ")}`);
      error.code = "FAIL-RIA-LINEAGE-INCOMPLETE";
      throw error;
    }
  } else if (required === "partial") {
    if (!recorded.sei || !recorded.verification) {
      const error = new Error("FAIL-RIA-LINEAGE-INCOMPLETE: SEI and verification must be recorded before owner rendezvous");
      error.code = "FAIL-RIA-LINEAGE-INCOMPLETE";
      throw error;
    }
  } else if (required === "verification" && !recorded.verification) {
    const error = new Error("FAIL-RIA-LINEAGE-INCOMPLETE: verification artifact was not recorded");
    error.code = "FAIL-RIA-LINEAGE-INCOMPLETE";
    throw error;
  }

  return Object.freeze({
    lineage_path: lineagePath(repositoryRoot, { durableMode }),
    current_path: current.path,
    assess,
    recorded,
  });
}

module.exports = { persistAssessmentArtifacts, OWNER_TASKS };
