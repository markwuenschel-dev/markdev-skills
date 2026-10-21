"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Handoff = require("./candidate-handoff");
const { createCanonicalPassFixture } = require("../../independent-verification/test-support/canonical-pass-fixture");

const AUTHORITY_SECRET = "integrity-authority-test-secret-32-bytes-minimum";
const AUTHORITY_KEY_ID = "integrity-test-authority-v1";

const candidate = { candidate_id: "INT-007", title: "Repair one seam", evidence_refs: ["claim-1"], acceptance: "gate green" };
const repository = { identity: "repo:skills", base_revision: "a".repeat(40) };
const scope_paths = ["src/seam.js", "tests/seam.test.js"];
const evidence_refs = [{ artifact_id: "claim-1", sha256: "b".repeat(64) }];
const candidate_hash = Handoff.hashValue(candidate);
const scope_hash = Handoff.scopeHash(repository, scope_paths);
const evidence_hash = Handoff.hashValue(evidence_refs);
const authorization = Handoff.signAuthorization({
  authorization_id: "auth-007",
  issuer: "user",
  repository_identity: repository.identity,
  base_revision: repository.base_revision,
  candidate_id: candidate.candidate_id,
  candidate_hash,
  scope_hash,
  evidence_hash,
  permitted_mutation: true
}, AUTHORITY_SECRET, AUTHORITY_KEY_ID);

assert.equal(Handoff.authorizationMac(authorization, AUTHORITY_SECRET), authorization.authority_mac);
assert.notEqual(Handoff.authorizationMac(authorization, `${AUTHORITY_SECRET}-wrong`), authorization.authority_mac);

const handoff = Handoff.createHandoff({
  candidate,
  repository,
  scope_paths,
  evidence_refs,
  authorization,
  acceptance_criteria: [{ criterion_id: "AC-1", command: "node --test tests/seam.test.js", expected: "exit 0" }],
  verification_strategy: { owner: "independent-verification", commands: ["node --test tests/seam.test.js"], completion_requires_fresh_evidence: true }
});

assert.equal(Handoff.validateHandoff(handoff, { ...repository, candidate_id: candidate.candidate_id, candidate_hash, scope_hash, evidence_hash, authorization_id: authorization.authorization_id }).ok, true);
assert.throws(() => Handoff.validateHandoff(handoff, { ...repository, base_revision: "c".repeat(40) }), /STALE_BASE_REVISION/);
assert.throws(() => Handoff.validateHandoff(handoff, { ...repository, candidate_hash: "d".repeat(64) }), /CANDIDATE_HASH_MISMATCH/);
assert.throws(() => Handoff.validateHandoff(handoff, { ...repository, scope_hash: "e".repeat(64) }), /SCOPE_HASH_MISMATCH/);
assert.throws(() => Handoff.validateHandoff({ ...handoff, authorization: { ...handoff.authorization, authorization_hash: "0".repeat(64) } }), /HANDOFF_SHAPE_OR_BINDING_MISMATCH/);
assert.throws(() => Handoff.createHandoff({ candidate: { ...candidate, candidate_id: "INT-008" }, repository, scope_paths, evidence_refs, authorization, acceptance_criteria: [{ criterion_id: "AC-1", command: "x", expected: "y" }], verification_strategy: { owner: "independent-verification", commands: ["x"], completion_requires_fresh_evidence: true } }), /AUTHORIZATION_CANDIDATE_MISMATCH/);
for (const unsafe of ["../outside.txt", "/etc/passwd", "C:/Windows/System32/config", "src//x", "src/./x"]) {
  assert.throws(() => Handoff.scopeHash(repository, [unsafe]), /SCOPE_PATH_INVALID/, unsafe);
}
assert.throws(() => Handoff.scopeHash(repository, ["src/X.js", "src/x.js"]), /SCOPE_PATH_CASE_COLLISION/);

const execution = { owner: "production-flywheel", kind: "production-delivery-receipt", artifact_id: "exec-1", handoff_sha256: handoff.handoff_sha256, sha256: "f".repeat(64) };
const fabricatedVerification = { owner: "independent-verification", kind: "independent-verification-receipt", artifact_id: "iv-1", status: "verified", handoff_sha256: handoff.handoff_sha256, execution_receipt_sha256: execution.sha256, sha256: "1".repeat(64) };
assert.throws(() => Handoff.closeCandidate(handoff, execution, { ...fabricatedVerification, status: "failed" }), /FRESH_INDEPENDENT_VERIFICATION_REQUIRED/);
assert.throws(() => Handoff.closeCandidate(handoff, execution, fabricatedVerification), /FRESH_INDEPENDENT_VERIFICATION_REQUIRED/, "an IV-shaped object with invented hashes must never close a candidate");
const ivRoot = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-canonical-iv-"));
let closure;
try {
  const verification = createCanonicalPassFixture(ivRoot, { kind: "integrity-candidate-closure@1", candidate_id: handoff.candidate_id, repository_identity: handoff.repository.identity, base_revision: handoff.repository.base_revision, handoff_sha256: handoff.handoff_sha256, execution_receipt_sha256: execution.sha256 });
  closure = Handoff.closeCandidate(handoff, execution, verification);
  assert.throws(() => Handoff.closeCandidate(handoff, { ...execution, sha256: "e".repeat(64) }, verification), /FRESH_INDEPENDENT_VERIFICATION_REQUIRED/, "a canonical verdict bound to another execution receipt must be rejected");
  const tampered = JSON.parse(fs.readFileSync(verification.verdict_ref, "utf8"));
  tampered.at = "1999-01-01T00:00:00Z";
  fs.writeFileSync(verification.verdict_ref, JSON.stringify(tampered, null, 2));
  assert.throws(() => Handoff.closeCandidate(handoff, execution, verification), /FRESH_INDEPENDENT_VERIFICATION_REQUIRED/, "post-verdict tampering must invalidate closure");
} finally { fs.rmSync(ivRoot, { recursive: true, force: true }); }
assert.deepEqual(Object.keys(closure).sort(), ["candidate_id", "execution_receipt_ref", "status", "verification_receipt_ref"]);
assert.equal(closure.status, "completed");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-handoff-"));
try {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "sentinel.txt"), "unchanged\n");
  const before = fs.readFileSync(path.join(repo, "src", "sentinel.txt"), "utf8");
  const written = Handoff.writeHandoff(repo, handoff);
  assert.ok(written.startsWith(path.join(repo, ".project-intelligence", "assessments", "integrity", "handoffs")));
  assert.equal(fs.readFileSync(path.join(repo, "src", "sentinel.txt"), "utf8"), before);
  assert.throws(() => Handoff.writeHandoff(repo, handoff, path.join(repo, "src", "forbidden.json")), /ARTIFACT_PATH_FORBIDDEN/);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log("GREEN integrity candidate handoff: exact authorization, stale/substitution rejection, opaque IV closure, artifact-only writes");
