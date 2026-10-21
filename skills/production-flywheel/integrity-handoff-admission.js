"use strict";

const crypto = require("node:crypto");
const Handoff = require("../codebase-integrity-audit-loop/scripts/candidate-handoff");
const { compilePlan } = require("../production-campaign/plan-compiler");
const { CampaignRuntime, integratedCampaignBinding } = require("../production-campaign/campaign-runtime");
const GitScope = require("../shared/git-diff-scope");
const VerificationGate = require("../shared/action-graph-execution/verification-gate");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }

function validateAuthorityMac(handoff) {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff) || !handoff.authorization || typeof handoff.authorization !== "object") throw new Error("PRODUCTION_FLYWHEEL_AUTHORITY_INVALID");
  const secret = process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY;
  const expectedKeyId = process.env.PRODUCTION_FLYWHEEL_AUTHORITY_KEY_ID;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32 || !expectedKeyId) throw new Error("PRODUCTION_FLYWHEEL_AUTHORITY_UNAVAILABLE");
  if (handoff.authorization.authority_key_id !== expectedKeyId) throw new Error("PRODUCTION_FLYWHEEL_AUTHORITY_KEY_MISMATCH");
  const expected = Handoff.authorizationMac(handoff.authorization, secret);
  const actualBuffer = Buffer.from(handoff.authorization.authority_mac, "hex"), expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) throw new Error("PRODUCTION_FLYWHEEL_AUTHORITY_MAC_INVALID");
}

function admitIntegrityHandoff(handoff, current) {
  if (Array.isArray(handoff)) throw new Error("EXACTLY_ONE_INTEGRITY_HANDOFF_REQUIRED");
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("CURRENT_INTEGRITY_BINDING_REQUIRED");
  validateAuthorityMac(handoff);
  Handoff.validateHandoff(handoff, current);
  const taskId = `integrity-${handoff.candidate_id}`;
  const commands = [...new Set(handoff.acceptance_criteria.map((item) => item.command))].sort();
  const plan = compilePlan({
    campaign_id: handoff.handoff_id,
    repository_revision: handoff.repository.base_revision,
    source_graph_hash: handoff.handoff_sha256,
    tasks: [{
      task_id: taskId,
      title: handoff.candidate.title || handoff.candidate_id,
      dependencies: [],
      read_set: handoff.scope.paths,
      write_set: handoff.scope.paths,
      resource_keys: [`integrity-handoff:${handoff.handoff_sha256}`],
      risk: { score: 0, flags: [] },
      acceptance_commands: commands,
      expected_artifacts: handoff.scope.paths,
      max_attempts: 2,
    }],
  });
  const authorization = Object.freeze({
    schema_version: 2,
    authorization_kind: "production-campaign",
    campaign_id: plan.campaign_id,
    repository_revision: plan.repository_revision,
    source_graph_hash: plan.source_graph_hash,
    compiled_plan_sha256: plan.plan_sha256,
    planned_impact_set_sha256: plan.planned_impact_set_sha256,
    authorized_action_ids: [taskId],
    max_total_actions: 1,
    max_epoch_actions: 1,
    max_parallel_workers: 1,
    max_attempts_per_action: 2,
    publication_policy: "local_only",
    independent_verification_policy: "fresh-per-cohort-with-per-action-verdicts",
  });
  const binding = Object.freeze({
    schema_version: "integrity-flywheel-admission@1",
    handoff_id: handoff.handoff_id,
    handoff_sha256: handoff.handoff_sha256,
    candidate_id: handoff.candidate_id,
    candidate_hash: handoff.candidate_hash,
    scope_hash: handoff.scope.scope_hash,
    evidence_hash: handoff.evidence.evidence_hash,
    authorization_hash: handoff.authorization.authorization_hash,
    repository_identity: handoff.repository.identity,
    repository_revision: handoff.repository.base_revision,
    plan_sha256: plan.plan_sha256,
  });
  return Object.freeze({ plan, authorization, binding: Object.freeze({ ...binding, admission_sha256: hash(binding) }) });
}

function deriveCurrentIntegrityBinding(handoff, repositoryRoot) {
  const identity = GitScope.repositoryIdentity(repositoryRoot);
  if (identity !== handoff.repository.identity) throw new Error("STALE_REPOSITORY_IDENTITY");
  return Object.freeze({
    identity,
    base_revision: GitScope.repositoryHead(repositoryRoot),
  });
}

function validateCampaignReceipt(receipt, admission) {
  if (!receipt || receipt.schema_version !== 3 || receipt.status !== "complete" || receipt.campaign_id !== admission.plan.campaign_id || receipt.plan_sha256 !== admission.plan.plan_sha256 || receipt.repository_revision !== admission.plan.repository_revision || !/^[a-f0-9]{40,64}$/.test(receipt.result_tree_hash || "")) throw new Error("PRODUCTION_CAMPAIGN_COMPLETION_RECEIPT_REQUIRED");
  const actionIds = admission.plan.tasks.map((task) => task.task_id).sort();
  if (JSON.stringify(Object.keys(receipt.actions || {}).sort()) !== JSON.stringify(actionIds) || Object.values(receipt.actions).some((status) => status !== "complete")) throw new Error("PRODUCTION_CAMPAIGN_ACTION_COMPLETION_REQUIRED");
  const scopeValues = Object.values(receipt.scope_receipts || {}).sort();
  if (scopeValues.length !== actionIds.length || scopeValues.some((value) => !/^[a-f0-9]{64}$/.test(value || ""))) throw new Error("PRODUCTION_CAMPAIGN_SCOPE_RECEIPTS_REQUIRED");
  GitScope.validateIntegratedScopeReceipt(receipt.integrated_scope_receipt);
  if (receipt.integrated_scope_receipt.result_tree_hash !== receipt.result_tree_hash || JSON.stringify([...receipt.integrated_scope_receipt.action_scope_receipt_sha256s].sort()) !== JSON.stringify(scopeValues)) throw new Error("PRODUCTION_CAMPAIGN_INTEGRATION_BINDING_MISMATCH");
  if (!receipt.integrated_iv || typeof receipt.integrated_iv.packet_ref !== "string" || typeof receipt.integrated_iv.verdict_ref !== "string" || !/^[a-f0-9]{64}$/.test(receipt.integrated_iv.packet_lock_sha256 || "")) throw new Error("PRODUCTION_CAMPAIGN_INTEGRATED_IV_REQUIRED");
  return receipt;
}

async function validateCampaignRepositoryBinding(receipt, admission, repositoryRoot) {
  const task = admission.plan.tasks[0];
  const observed = await GitScope.verifyGitDiffScopeAsync({ repositoryRoot, baseTree: admission.plan.repository_revision, resultTree: receipt.result_tree_hash, authorizedWriteSet: task.write_set });
  const integrated = receipt.integrated_scope_receipt;
  if (integrated.repository_identity !== GitScope.repositoryIdentity(repositoryRoot) || integrated.base_tree_hash !== observed.base_tree_hash || integrated.result_tree_hash !== observed.result_tree_hash || integrated.final_scope_receipt_sha256 !== observed.scope_receipt_sha256 || integrated.reconciled_paths.length !== 0 || JSON.stringify(integrated.changed_paths) !== JSON.stringify(observed.changed_paths) || JSON.stringify(integrated.changed_blobs) !== JSON.stringify(observed.changed_blobs)) throw new Error("PRODUCTION_CAMPAIGN_REPOSITORY_BINDING_MISMATCH");
  const canonical = await VerificationGate.validateCanonicalVerdictEvidenceAsync(receipt.integrated_iv, integratedCampaignBinding(admission.plan, integrated));
  if (canonical.packet_lock_sha256 !== receipt.integrated_iv.packet_lock_sha256 || canonical.verdict_ref !== receipt.integrated_iv.verdict_ref) throw new Error("PRODUCTION_CAMPAIGN_INTEGRATED_IV_BINDING_MISMATCH");
  return receipt;
}

async function executeIntegrityHandoff(options) {
  const { handoff, repository_root: repositoryRoot, runtime } = options || {};
  if (Object.hasOwn(options || {}, "current")) throw new Error("CALLER_CURRENT_BINDING_FORBIDDEN");
  if (!(runtime instanceof CampaignRuntime) || runtime.constructor !== CampaignRuntime || runtime.run !== CampaignRuntime.prototype.run || GitScope.repositoryIdentity(runtime.repositoryRoot) !== GitScope.repositoryIdentity(repositoryRoot)) throw new Error("PRODUCTION_CAMPAIGN_RUNTIME_REQUIRED");
  const current = deriveCurrentIntegrityBinding(handoff, repositoryRoot);
  const admission = admitIntegrityHandoff(handoff, current);
  const campaignReceipt = await validateCampaignRepositoryBinding(validateCampaignReceipt(await runtime.run(admission.plan, admission.authorization), admission), admission, repositoryRoot);
  const body = {
    schema_version: "production-delivery-receipt@1",
    owner: "production-flywheel",
    kind: "production-delivery-receipt",
    artifact_id: `delivery-${handoff.handoff_id}`,
    handoff_sha256: handoff.handoff_sha256,
    admission_sha256: admission.binding.admission_sha256,
    campaign_id: campaignReceipt.campaign_id,
    campaign_plan_sha256: campaignReceipt.plan_sha256,
    campaign_status: campaignReceipt.status,
    result_tree_hash: campaignReceipt.result_tree_hash,
    integrated_scope_receipt_sha256: campaignReceipt.integrated_scope_receipt.integrated_scope_receipt_sha256,
    integrated_iv_packet_lock_sha256: campaignReceipt.integrated_iv.packet_lock_sha256,
    campaign_scope_receipts: campaignReceipt.scope_receipts,
  };
  return Object.freeze({ ...body, sha256: hash(body), campaign_receipt: campaignReceipt });
}

module.exports = Object.freeze({ admitIntegrityHandoff, deriveCurrentIntegrityBinding, executeIntegrityHandoff, validateAuthorityMac, validateCampaignReceipt, validateCampaignRepositoryBinding });
