"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const VerificationGate = require("../../shared/action-graph-execution/verification-gate");
const RepositoryScope = require("../../shared/repository-scope");

const HASH = /^[a-f0-9]{64}$/;
const nonblank = (value, code) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function normalizedScope(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("SCOPE_REQUIRED");
  try { return RepositoryScope.canonicalRepositoryPaths(paths, { requireNonEmpty: true }); }
  catch (error) {
    if (error.code === "REPOSITORY_PATH_ALIAS") throw new Error("SCOPE_PATH_DUPLICATE");
    if (error.code === "REPOSITORY_PATH_CASE_COLLISION") throw new Error("SCOPE_PATH_CASE_COLLISION");
    throw new Error("SCOPE_PATH_INVALID");
  }
}

function scopeHash(repository, scopePaths) {
  return hashValue({ repository_identity: nonblank(repository && repository.identity, "REPOSITORY_IDENTITY_REQUIRED"), base_revision: nonblank(repository && repository.base_revision, "BASE_REVISION_REQUIRED"), paths: normalizedScope(scopePaths) });
}

function validateRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) throw new Error("EVIDENCE_REFS_REQUIRED");
  const normalized = refs.map(ref => {
    const artifact_id = nonblank(ref && ref.artifact_id, "EVIDENCE_ARTIFACT_ID_REQUIRED");
    const sha256 = nonblank(ref && ref.sha256, "EVIDENCE_HASH_REQUIRED");
    if (!HASH.test(sha256)) throw new Error("EVIDENCE_HASH_INVALID");
    return { artifact_id, sha256 };
  }).sort((a, b) => a.artifact_id.localeCompare(b.artifact_id) || a.sha256.localeCompare(b.sha256));
  if (new Set(normalized.map(ref => ref.artifact_id)).size !== normalized.length) throw new Error("EVIDENCE_ARTIFACT_DUPLICATE");
  return normalized;
}

function validateCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) throw new Error("ACCEPTANCE_CRITERIA_REQUIRED");
  return criteria.map(item => ({ criterion_id: nonblank(item && item.criterion_id, "ACCEPTANCE_ID_REQUIRED"), command: nonblank(item && item.command, "ACCEPTANCE_COMMAND_REQUIRED"), expected: nonblank(item && item.expected, "ACCEPTANCE_EXPECTED_REQUIRED") }));
}

function validateStrategy(strategy) {
  if (!strategy || strategy.owner !== "independent-verification" || strategy.completion_requires_fresh_evidence !== true || !Array.isArray(strategy.commands) || strategy.commands.length === 0) throw new Error("INDEPENDENT_VERIFICATION_STRATEGY_REQUIRED");
  return { owner: strategy.owner, commands: strategy.commands.map(command => nonblank(command, "VERIFICATION_COMMAND_REQUIRED")), completion_requires_fresh_evidence: true };
}

function authorizationBinding(authorization) {
  if (!authorization || authorization.permitted_mutation !== true) throw new Error("EXACT_MUTATION_AUTHORIZATION_REQUIRED");
  const result = {
    authorization_id: nonblank(authorization.authorization_id, "AUTHORIZATION_ID_REQUIRED"),
    issuer: nonblank(authorization.issuer, "AUTHORIZATION_ISSUER_REQUIRED"),
    repository_identity: nonblank(authorization.repository_identity, "AUTHORIZATION_REPOSITORY_REQUIRED"),
    base_revision: nonblank(authorization.base_revision, "AUTHORIZATION_REVISION_REQUIRED"),
    candidate_id: nonblank(authorization.candidate_id, "AUTHORIZATION_CANDIDATE_REQUIRED"),
    candidate_hash: nonblank(authorization.candidate_hash, "AUTHORIZATION_CANDIDATE_HASH_REQUIRED"),
    scope_hash: nonblank(authorization.scope_hash, "AUTHORIZATION_SCOPE_HASH_REQUIRED"),
    evidence_hash: nonblank(authorization.evidence_hash, "AUTHORIZATION_EVIDENCE_HASH_REQUIRED"),
    authority_key_id: nonblank(authorization.authority_key_id, "AUTHORIZATION_KEY_ID_REQUIRED"),
    authority_mac: nonblank(authorization.authority_mac, "AUTHORIZATION_MAC_REQUIRED"),
    permitted_mutation: true
  };
  for (const key of ["candidate_hash", "scope_hash", "evidence_hash"]) if (!HASH.test(result[key])) throw new Error("AUTHORIZATION_HASH_INVALID");
  if (!HASH.test(result.authority_mac)) throw new Error("AUTHORIZATION_MAC_INVALID");
  return Object.freeze({ ...result, authorization_hash: hashValue(result) });
}

function unsignedAuthorization(authorization) {
  return {
    authorization_id: nonblank(authorization.authorization_id, "AUTHORIZATION_ID_REQUIRED"),
    issuer: nonblank(authorization.issuer, "AUTHORIZATION_ISSUER_REQUIRED"),
    repository_identity: nonblank(authorization.repository_identity, "AUTHORIZATION_REPOSITORY_REQUIRED"),
    base_revision: nonblank(authorization.base_revision, "AUTHORIZATION_REVISION_REQUIRED"),
    candidate_id: nonblank(authorization.candidate_id, "AUTHORIZATION_CANDIDATE_REQUIRED"),
    candidate_hash: nonblank(authorization.candidate_hash, "AUTHORIZATION_CANDIDATE_HASH_REQUIRED"),
    scope_hash: nonblank(authorization.scope_hash, "AUTHORIZATION_SCOPE_HASH_REQUIRED"),
    evidence_hash: nonblank(authorization.evidence_hash, "AUTHORIZATION_EVIDENCE_HASH_REQUIRED"),
    authority_key_id: nonblank(authorization.authority_key_id, "AUTHORIZATION_KEY_ID_REQUIRED"),
    permitted_mutation: true,
  };
}

function authorizationMac(authorization, secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error("AUTHORIZATION_SECRET_REQUIRED");
  return crypto.createHmac("sha256", secret).update(JSON.stringify(canonical(unsignedAuthorization(authorization)))).digest("hex");
}

function signAuthorization(authorization, secret, keyId) {
  const unsigned = { ...authorization, authority_key_id: nonblank(keyId, "AUTHORIZATION_KEY_ID_REQUIRED"), permitted_mutation: true };
  return Object.freeze({ ...unsigned, authority_mac: authorizationMac(unsigned, secret) });
}

function createHandoff(input) {
  const candidate = canonical(input && input.candidate);
  const candidate_id = nonblank(candidate && candidate.candidate_id, "CANDIDATE_ID_REQUIRED");
  const repository = { identity: nonblank(input.repository && input.repository.identity, "REPOSITORY_IDENTITY_REQUIRED"), base_revision: nonblank(input.repository && input.repository.base_revision, "BASE_REVISION_REQUIRED") };
  const scope_paths = normalizedScope(input.scope_paths), evidence_refs = validateRefs(input.evidence_refs);
  const candidate_hash = hashValue(candidate), scope_hash = scopeHash(repository, scope_paths), evidence_hash = hashValue(evidence_refs);
  const authorization = authorizationBinding(input.authorization);
  if (authorization.candidate_id !== candidate_id) throw new Error("AUTHORIZATION_CANDIDATE_MISMATCH");
  if (authorization.repository_identity !== repository.identity) throw new Error("AUTHORIZATION_REPOSITORY_MISMATCH");
  if (authorization.base_revision !== repository.base_revision) throw new Error("AUTHORIZATION_BASE_REVISION_MISMATCH");
  if (authorization.candidate_hash !== candidate_hash) throw new Error("AUTHORIZATION_CANDIDATE_HASH_MISMATCH");
  if (authorization.scope_hash !== scope_hash) throw new Error("AUTHORIZATION_SCOPE_HASH_MISMATCH");
  if (authorization.evidence_hash !== evidence_hash) throw new Error("AUTHORIZATION_EVIDENCE_HASH_MISMATCH");
  const body = {
    schema_version: "integrity-candidate-handoff@1",
    owner: "codebase-integrity-audit-loop",
    mutation_owner: "production-flywheel",
    completion_authority: "independent-verification",
    candidate_id,
    candidate,
    candidate_hash,
    repository,
    scope: { paths: scope_paths, scope_hash },
    evidence: { refs: evidence_refs, evidence_hash },
    authorization,
    acceptance_criteria: validateCriteria(input.acceptance_criteria),
    verification_strategy: validateStrategy(input.verification_strategy)
  };
  const handoff_sha256 = hashValue(body);
  return Object.freeze({ ...body, handoff_id: `integrity-handoff-${handoff_sha256.slice(0, 24)}`, handoff_sha256 });
}

function validateHandoff(value, current = {}) {
  if (!value || value.schema_version !== "integrity-candidate-handoff@1") throw new Error("HANDOFF_SCHEMA_INVALID");
  const recreated = createHandoff({ candidate: value.candidate, repository: value.repository, scope_paths: value.scope && value.scope.paths, evidence_refs: value.evidence && value.evidence.refs, authorization: value.authorization, acceptance_criteria: value.acceptance_criteria, verification_strategy: value.verification_strategy });
  if (recreated.handoff_sha256 !== value.handoff_sha256 || recreated.handoff_id !== value.handoff_id) throw new Error("HANDOFF_HASH_MISMATCH");
  if (JSON.stringify(canonical(recreated)) !== JSON.stringify(canonical(value))) throw new Error("HANDOFF_SHAPE_OR_BINDING_MISMATCH");
  if (current.identity !== undefined && current.identity !== value.repository.identity) throw new Error("REPOSITORY_IDENTITY_MISMATCH");
  if (current.base_revision !== undefined && current.base_revision !== value.repository.base_revision) throw new Error("STALE_BASE_REVISION");
  if (current.candidate_id !== undefined && current.candidate_id !== value.candidate_id) throw new Error("CANDIDATE_ID_MISMATCH");
  if (current.candidate_hash !== undefined && current.candidate_hash !== value.candidate_hash) throw new Error("CANDIDATE_HASH_MISMATCH");
  if (current.scope_hash !== undefined && current.scope_hash !== value.scope.scope_hash) throw new Error("SCOPE_HASH_MISMATCH");
  if (current.evidence_hash !== undefined && current.evidence_hash !== value.evidence.evidence_hash) throw new Error("EVIDENCE_HASH_MISMATCH");
  if (current.authorization_id !== undefined && current.authorization_id !== value.authorization.authorization_id) throw new Error("AUTHORIZATION_ID_MISMATCH");
  return Object.freeze({ ok: true, handoff_id: value.handoff_id, handoff_sha256: value.handoff_sha256 });
}

function receiptRef(receipt) {
  return Object.freeze({ artifact_id: receipt.artifact_id, owner: receipt.owner, kind: receipt.kind, sha256: receipt.sha256 });
}

function closeCandidate(handoff, execution, verification) {
  validateHandoff(handoff);
  if (!execution || execution.owner !== "production-flywheel" || execution.kind !== "production-delivery-receipt" || execution.handoff_sha256 !== handoff.handoff_sha256 || !HASH.test(execution.sha256 || "")) throw new Error("BOUND_EXECUTION_RECEIPT_REQUIRED");
  let verified;
  try {
    verified = VerificationGate.validateCanonicalVerdictEvidence(verification, {
      kind: "integrity-candidate-closure@1",
      candidate_id: handoff.candidate_id,
      repository_identity: handoff.repository.identity,
      base_revision: handoff.repository.base_revision,
      handoff_sha256: handoff.handoff_sha256,
      execution_receipt_sha256: execution.sha256,
    });
  } catch (_) {
    throw new Error("FRESH_INDEPENDENT_VERIFICATION_REQUIRED");
  }
  return Object.freeze({ candidate_id: handoff.candidate_id, status: "completed", execution_receipt_ref: receiptRef(execution), verification_receipt_ref: receiptRef(verified) });
}

function writeHandoff(repositoryRoot, handoff, requestedPath = null) {
  validateHandoff(handoff);
  const root = fs.realpathSync.native(repositoryRoot);
  const directory = path.join(root, ".project-intelligence", "assessments", "integrity", "handoffs");
  fs.mkdirSync(directory, { recursive: true });
  const target = requestedPath ? path.resolve(requestedPath) : path.join(directory, `${handoff.handoff_id}.json`);
  const relative = path.relative(directory, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("ARTIFACT_PATH_FORBIDDEN");
  const body = JSON.stringify(handoff, null, 2) + "\n";
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, "utf8") !== body) throw new Error("HANDOFF_IMMUTABLE_CONFLICT");
    return target;
  }
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, body, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
  return target;
}

module.exports = { authorizationMac, canonical, hashValue, scopeHash, signAuthorization, createHandoff, validateHandoff, closeCandidate, writeHandoff };
