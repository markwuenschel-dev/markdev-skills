"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Handoff = require("../codebase-integrity-audit-loop/scripts/candidate-handoff");
const { CampaignRuntime } = require("../production-campaign/campaign-runtime");
const { createGitFixture } = require("../production-campaign/test-support/git-fixture");
const { createCanonicalPassFixtureAsync } = require("../independent-verification/test-support/canonical-pass-fixture");
const { integratedVerifier, workerResult } = require("../production-campaign/test-support/runtime-contract-fixtures");
const Admission = require("./integrity-handoff-admission");

const AUTHORITY_SECRET = "production-flywheel-test-authority-secret-v1";
const AUTHORITY_KEY_ID = "production-flywheel-test-authority-v1";
const previousAuthoritySecret = process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY;
const previousAuthorityKeyId = process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY_ID;
process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY = AUTHORITY_SECRET;
process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY_ID = AUTHORITY_KEY_ID;
test.after(() => {
  if (previousAuthoritySecret === undefined) delete process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY;
  else process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY = previousAuthoritySecret;
  if (previousAuthorityKeyId === undefined) delete process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY_ID;
  else process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY_ID = previousAuthorityKeyId;
});

function handoffFor(git) {
  const candidate = { candidate_id: "INT-101", title: "Repair one executable seam" };
  const repository = { identity: git.root.replace(/\\/g, "/"), base_revision: git.base };
  const scope = ["src/seam.js", "tests/seam.test.js"];
  const evidence = [{ artifact_id: "claim-101", sha256: "b".repeat(64) }];
  const authorization = Handoff.signAuthorization({ authorization_id: "auth-101", issuer: "user", repository_identity: repository.identity, base_revision: repository.base_revision, candidate_id: candidate.candidate_id, candidate_hash: Handoff.hashValue(candidate), scope_hash: Handoff.scopeHash(repository, scope), evidence_hash: Handoff.hashValue(evidence), permitted_mutation: true }, AUTHORITY_SECRET, AUTHORITY_KEY_ID);
  return Handoff.createHandoff({ candidate, repository, scope_paths: scope, evidence_refs: evidence, authorization, acceptance_criteria: [{ criterion_id: "AC-1", command: "node --test tests/seam.test.js", expected: "exit 0" }], verification_strategy: { owner: "independent-verification", commands: ["node --test tests/seam.test.js"], completion_requires_fresh_evidence: true } });
}

test("Flywheel admits exactly one current immutable Integrity handoff", () => {
  const git = createGitFixture({ result: ["src/seam.js", "tests/seam.test.js"] });
  const handoff = handoffFor(git);
  const current = { identity: handoff.repository.identity, base_revision: git.base, candidate_id: handoff.candidate_id, candidate_hash: handoff.candidate_hash, scope_hash: handoff.scope.scope_hash, evidence_hash: handoff.evidence.evidence_hash, authorization_id: handoff.authorization.authorization_id };
  const admission = Admission.admitIntegrityHandoff(handoff, current);
  assert.equal(admission.plan.tasks.length, 1);
  assert.deepEqual(admission.plan.tasks[0].write_set, handoff.scope.paths);
  assert.equal(admission.binding.handoff_sha256, handoff.handoff_sha256);
  assert.throws(() => Admission.admitIntegrityHandoff([handoff], current), /EXACTLY_ONE/);
  assert.throws(() => Admission.admitIntegrityHandoff(handoff, { ...current, base_revision: "0".repeat(40) }), /STALE_BASE_REVISION/);
  assert.throws(() => Admission.admitIntegrityHandoff({ ...handoff, candidate_hash: "0".repeat(64) }, current), /HANDOFF_HASH_MISMATCH|HANDOFF_SHAPE/);
  const attackerAuthorization = Handoff.signAuthorization({ ...handoff.authorization, authority_mac: undefined }, "attacker-controlled-secret-with-32-bytes", AUTHORITY_KEY_ID);
  const attackerHandoff = Handoff.createHandoff({ candidate: handoff.candidate, repository: handoff.repository, scope_paths: handoff.scope.paths, evidence_refs: handoff.evidence.refs, authorization: attackerAuthorization, acceptance_criteria: handoff.acceptance_criteria, verification_strategy: handoff.verification_strategy });
  assert.throws(() => Admission.admitIntegrityHandoff(attackerHandoff, current), /PRODUCTION_FLYWHEEL_AUTHORITY_MAC_INVALID/, "a self-consistent handoff signed outside the trusted authority must not mint mutation authority");
});

test("Integrity producer reaches a Git-scoped Campaign receipt through Flywheel", async () => {
  const git = createGitFixture({ result: ["src/seam.js", "tests/seam.test.js"] });
  const handoff = handoffFor(git);
  const current = { identity: handoff.repository.identity, base_revision: git.base, candidate_id: handoff.candidate_id, candidate_hash: handoff.candidate_hash, scope_hash: handoff.scope.scope_hash, evidence_hash: handoff.evidence.evidence_hash, authorization_id: handoff.authorization.authorization_id };
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-flywheel-"));
  let planForVerification;
  const runtime = new CampaignRuntime({
    state_dir: stateRoot, repository_root: git.root,
    run_task: async (task, assignment) => workerResult(task, assignment, git.results.result),
    execute_command: async () => ({ exit_code: 0, stdout: "PASS", stderr: "" }),
    review_task: async (task) => ({ policy: task.review_policy, verdict: "PASS" }),
    verify_epoch: async (tasks, packet) => {
      const action = packet.action_packets[tasks[0].task_id];
      const binding = { kind: "production-campaign-action@1", campaign_id: planForVerification.campaign_id, plan_sha256: planForVerification.plan_sha256, repository_revision: planForVerification.repository_revision, action_id: tasks[0].task_id, attempt_id: action.attempt_id, base_tree_hash: action.scope_receipt.base_tree_hash, result_tree_hash: action.result_tree_hash, scope_receipt_sha256: action.scope_receipt.scope_receipt_sha256 };
      return { authority: "independent-verification", fresh: true, cache_hit: false, plan_sha256: packet.plan_sha256, repository_revision: planForVerification.repository_revision, invocation_id: "iv-integrity-flywheel", per_action: { [tasks[0].task_id]: await createCanonicalPassFixtureAsync(path.join(stateRoot, "iv"), binding) } };
    },
    verify_integrated_campaign: integratedVerifier(path.join(stateRoot, "integrated-iv"), "integrity-integrated-iv"),
    reassess_epoch: async () => ({ status: "clean", receipt_ref: ".integration/integrity.json", result_tree_hash: git.integrated, reconciled_paths: [] }),
  });
  planForVerification = Admission.admitIntegrityHandoff(handoff, current).plan;
  const receipt = await Admission.executeIntegrityHandoff({ handoff, repository_root: git.root, runtime });
  assert.equal(receipt.campaign_status, "complete");
  assert.equal(receipt.handoff_sha256, handoff.handoff_sha256);
  assert.match(Object.values(receipt.campaign_scope_receipts)[0], /^[a-f0-9]{64}$/);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.integrated_scope_receipt_sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() => Admission.executeIntegrityHandoff({ handoff, current, repository_root: git.root, runtime }), /CALLER_CURRENT_BINDING_FORBIDDEN/);
  await assert.rejects(() => Admission.executeIntegrityHandoff({ handoff, repository_root: git.root, runtime: { run: async () => ({ status: "complete" }) } }), /PRODUCTION_CAMPAIGN_RUNTIME_REQUIRED/);
  const originalRun = runtime.run.bind(runtime);
  runtime.run = async () => ({ schema_version: 3, campaign_id: planForVerification.campaign_id, plan_sha256: planForVerification.plan_sha256, repository_revision: planForVerification.repository_revision, status: "hard-stop" });
  await assert.rejects(() => Admission.executeIntegrityHandoff({ handoff, repository_root: git.root, runtime }), /PRODUCTION_CAMPAIGN_RUNTIME_REQUIRED/);
  runtime.run = originalRun;
});
