#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadLineage } = require("./workspace-lineage.js");
const { verifyVerificationBaselineFile } = require("../../shared/assessment-verification-baseline/verification-baseline.js");
const { gitPreflight, nonGitIdentity } = require("../baseline.js");

const SHA = /^[0-9a-f]{64}$/;
const REV = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])); return value; }
function fail(detail) { throw new Error(`FAIL-RIA-STARTUP-RESOLVER: ${detail}`); }
function git(repo, args) { return childProcess.execFileSync("git", ["-C", repo, ...args], { encoding:"utf8", stdio:["ignore","pipe","pipe"] }).trim(); }
function fileDigest(filePath) { return sha256(fs.readFileSync(filePath)); }
function nodeCacheState(startupMode) {
  if (startupMode === "EXACT_REUSE") return "EXACT_REUSE";
  if (startupMode === "INCREMENTAL_REUSE") return "INCREMENTAL_REUSE";
  if (startupMode === "FRESH_BASELINE") return "MISS";
  fail(`unknown startup mode ${startupMode}`);
}
function repositoryIdentity(repoRoot, durableMode = "git") {
  if (durableMode === "content-addressed-degraded") {
    const identity = nonGitIdentity(repoRoot);
    if (gitPreflight(identity.root).ok) fail("content-addressed-degraded cannot be used on a Git root");
    return Object.freeze({ root: identity.root, repository_key: identity.repository_key, revision: identity.revision, clean: null, working_tree_fingerprint: identity.working_tree_fingerprint });
  }
  if (durableMode !== "git") fail(`unsupported durable mode ${durableMode}`);
  const root = fs.realpathSync.native(repoRoot);
  const revision = git(root,["rev-parse","HEAD"]);
  const status = childProcess.execFileSync("git",["-C",root,"status","--porcelain=v1","-z","--untracked-files=all"],{encoding:"buffer",stdio:["ignore","pipe","pipe"]});
  return Object.freeze({ root, repository_key: sha256(process.platform === "win32" ? root.toLowerCase() : root), revision, clean: status.length === 0, working_tree_fingerprint: sha256(status) });
}
function compatible(candidate, request) {
  const binding = request.compatibility_binding ?? request;
  return candidate && candidate.engine_version === request.engine_version
    && candidate.config_hash === binding.config_hash
    && candidate.execution_contract_hash === binding.execution_contract_hash
    && (candidate.assessment_schema_version ?? binding.assessment_schema_version) === binding.assessment_schema_version
    && (candidate.history_window_hash ?? binding.history_window_hash) === binding.history_window_hash
    && (candidate.analyzer_capability_hash ?? binding.analyzer_capability_hash) === binding.analyzer_capability_hash
    && candidate.repository_key === request.repository.repository_key
    && candidate.working_tree_fingerprint === request.repository.working_tree_fingerprint
    && REV.test(candidate.revision)
    && SHA.test(candidate.sha256)
    && typeof candidate.path === "string";
}
function validArtifact(candidate) {
  try { return fs.statSync(candidate.path).isFile() && fileDigest(candidate.path) === candidate.sha256; }
  catch { return false; }
}
function ancestorDistance(repo, revision, head) {
  try {
    childProcess.execFileSync("git",["-C",repo,"merge-base","--is-ancestor",revision,head],{stdio:"ignore"});
    return Number(git(repo,["rev-list","--count",`${revision}..${head}`]));
  } catch { return null; }
}
function resolveStartup(request) {
  if (!request || typeof request !== "object") fail("request is invalid");
  const durableMode = request.durable_mode ?? "git";
  const repository = request.repository?.root ? repositoryIdentity(request.repository.root, durableMode) : request.repository;
  if (!repository || !repository.repository_key || !REV.test(repository.revision)) fail("repository identity is invalid");
  const binding = request.compatibility_binding ?? request;
  if (!binding.engine_version || !SHA.test(binding.config_hash) || !SHA.test(binding.execution_contract_hash)) fail("SEI compatibility binding is invalid");
  const effectiveLineage = request.lineage ?? (repository.root ? loadLineage(repository.root, { durableMode }) : { sei_artifacts: [], verification_artifacts: [], owner_artifacts: [] });
  const lineage = Array.isArray(effectiveLineage?.sei_artifacts) ? effectiveLineage.sei_artifacts : [];
  const candidates = lineage.filter((candidate) => compatible(candidate, { ...request, ...binding, repository })).filter(validArtifact);
  const exact = candidates.find((candidate) => candidate.revision === repository.revision);
  let mode = "FRESH_BASELINE";
  let base = null;
  const reason_codes = [];
  if (exact) {
    mode = "EXACT_REUSE";
    base = exact;
    reason_codes.push("EXACT_COMPATIBLE_ARTIFACT", "ARTIFACT_HASH_VERIFIED");
  } else {
    reason_codes.push("NO_EXACT_ARTIFACT");
    const reachable = durableMode === "git"
      ? candidates.map(candidate => ({ candidate, distance: ancestorDistance(repository.root, candidate.revision, repository.revision) }))
        .filter(item => Number.isInteger(item.distance)).sort((a,b)=>a.distance-b.distance || a.candidate.revision.localeCompare(b.candidate.revision))
      : [];
    if (reachable.length) {
      mode = "INCREMENTAL_REUSE";
      base = reachable[0].candidate;
      reason_codes.push("COMPATIBLE_ANCESTOR_FOUND", "ANCESTOR_REACHABLE", "ARTIFACT_HASH_VERIFIED");
    } else reason_codes.push("NO_COMPATIBLE_REACHABLE_ANCESTOR");
  }
  let verification_artifact_hit = { state:"MISS" };
  const verification = request.verification;
  if (verification && typeof verification === "object") {
    const hit = (effectiveLineage?.verification_artifacts ?? []).find(candidate => candidate
      && candidate.repository_key === repository.repository_key
      && candidate.working_tree_fingerprint === repository.working_tree_fingerprint
      && candidate.revision === repository.revision
      && candidate.baseline_sha256 === request.baseline_ref?.sha256
      && candidate.verifier_version === verification.version
      && candidate.contract_hash === verification.contract_hash
      && candidate.config_hash === verification.config_hash
      && verifyVerificationBaselineFile(candidate.path, { content_sha256:candidate.content_sha256, file_sha256:candidate.file_sha256 }).ok);
    if (hit) verification_artifact_hit = { state:"EXACT_REUSE", artifact_id:hit.artifact_id ?? null, content_sha256:hit.content_sha256, file_sha256:hit.file_sha256, path:path.resolve(hit.path) };
  }
  const owner_hits = {};
  for (const owner of request.owners ?? []) {
    const hit = (effectiveLineage?.owner_artifacts ?? []).find(candidate => candidate.owner === owner.owner
      && candidate.owner_version === owner.version
      && candidate.runtime_contract_sha256 === owner.runtime_contract_sha256
      && candidate.repository_key === repository.repository_key
      && candidate.working_tree_fingerprint === repository.working_tree_fingerprint
      && candidate.revision === repository.revision
      && candidate.baseline_sha256 === request.baseline_ref?.sha256
      && candidate.engineering_intelligence_sha256 === (exact?.sha256 ?? request.engineering_intelligence_sha256)
      && validArtifact(candidate));
    owner_hits[owner.owner] = hit ? { state:"EXACT_REUSE", artifact_id:hit.artifact_id, sha256:hit.sha256, path:hit.path } : { state:"MISS" };
  }
  return Object.freeze(canonical({
    schema_version:"ria.startup-resolution@1", startup_mode:mode, repository,
    base_artifact: base === null ? null : { revision:base.revision, artifact_id:base.artifact_id ?? null, sha256:base.sha256, path:path.resolve(base.path) },
    verification_artifact_hit,
    owner_artifact_hits:owner_hits, reason_codes,
    node_cache_state:nodeCacheState(mode),
    cache_policy:{ exact_reuse_required_when_valid:true, incremental_preferred_when_compatible:true, fresh_requires_reason:mode === "FRESH_BASELINE" }
  }));
}
function parse(argv) { const out={}; for(let i=0;i<argv.length;i+=1) { const key=argv[i]; if(key==="--help"||key==="-h") out[key]=true; else if(["--input","--output"].includes(key)) { if(!argv[i+1]) throw new Error(`MISSING_VALUE:${key}`); out[key]=argv[++i]; } else throw new Error(`UNKNOWN_ARGUMENT:${key}`); } return out; }
if (require.main === module) {
  try { const a=parse(process.argv.slice(2)); if (a["--help"] || a["-h"]) { process.stdout.write("usage: startup-resolver.js --input <resolver-input.json> [--output <resolution.json>]\n"); } else { if (!a["--input"]) throw new Error("--input is required"); const req=JSON.parse(fs.readFileSync(a["--input"],"utf8")); const result=resolveStartup(req); const bytes=JSON.stringify(result,null,2)+"\n"; if(a["--output"]){fs.mkdirSync(path.dirname(path.resolve(a["--output"])),{recursive:true});fs.writeFileSync(a["--output"],bytes);} else process.stdout.write(bytes); } }
  catch(error){ console.error(error.message); process.exitCode=1; }
}
module.exports={resolveStartup,repositoryIdentity,fileDigest,nodeCacheState};
