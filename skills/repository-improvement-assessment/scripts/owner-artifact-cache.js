"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { CacheStore, sha256 } = require("../../shared/assessment-acceleration/cache-store.js");
const workspace = require("../../shared/project-intelligence-workspace/project-intelligence-workspace.js");
function descriptor(input) {
  return {
    namespace:"ria-owner-artifact@1", repository_key:input.repository_key, lane_id:input.owner,
    contract_version:input.owner_version,
    input_fingerprint:sha256({baseline_sha256:input.baseline_sha256,engineering_intelligence_sha256:input.engineering_intelligence_sha256}),
    dependency_fingerprint:sha256({runtime_contract_sha256:input.runtime_contract_sha256,output_schema:input.output_schema}),
    environment_fingerprint:sha256({artifact_contract:"immutable-owner-ref@1"}),
    source_revision:input.repository_revision, working_tree_fingerprint:input.working_tree_fingerprint,
    scope:{owner:input.owner}
  };
}
function validatePayload(payload,input) {
  if (!payload || typeof payload !== "object" || payload.owner !== input.owner || payload.repository_revision !== input.repository_revision || !/^[0-9a-f]{64}$/.test(payload.sha256) || typeof payload.path !== "string") return false;
  try { return fs.statSync(payload.path).isFile() && sha256(fs.readFileSync(payload.path)) === payload.sha256; } catch { return false; }
}
function resolveCacheRoot(cacheRoot,input) {
  if (cacheRoot) return path.resolve(cacheRoot);
  if (!input?.repository_root) throw new Error("FAIL-RIA-OWNER-CACHE: repository_root is required when cacheRoot is omitted");
  workspace.ensureWorkspace(input.repository_root);
  return workspace.resolvePath(input.repository_root,"cache","ria-owner-artifacts");
}
function lookup(cacheRoot,input) {
  const store=new CacheStore(resolveCacheRoot(cacheRoot,input)); const hit=store.lookup(descriptor(input));
  if (!new Set(["exact","content-stable"]).has(hit.reuse) || !validatePayload(hit.entry?.payload,input)) return {reuse:"miss",payload:null};
  return {reuse:hit.reuse,payload:hit.entry.payload};
}
function put(cacheRoot,input,payload) {
  if(!validatePayload(payload,input)) throw new Error("FAIL-RIA-OWNER-CACHE: payload is not a valid immutable owner artifact");
  return new CacheStore(resolveCacheRoot(cacheRoot,input)).put(descriptor(input),payload,{provenance:{owner:input.owner,repository_revision:input.repository_revision}});
}
module.exports={descriptor,lookup,put,resolveCacheRoot};
