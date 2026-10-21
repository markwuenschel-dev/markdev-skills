"use strict";

const { CacheStore, sha256 } = require("./cache-store");

function descriptorFor(input) {
  for (const key of ["repository_key", "tree_hash", "command", "environment_fingerprint", "config_hash"]) {
    if (typeof input[key] !== "string" || !input[key]) throw new Error("COMMAND_EVIDENCE_KEY_INVALID:" + key);
  }
  return {
    namespace: "production-command-evidence",
    repository_key: input.repository_key,
    lane_id: "command:" + sha256(input.command),
    contract_version: "production-command-evidence/v1",
    input_fingerprint: sha256({ tree_hash: input.tree_hash, command: input.command }),
    dependency_fingerprint: input.config_hash,
    environment_fingerprint: input.environment_fingerprint,
    source_revision: input.source_revision || input.tree_hash,
    working_tree_fingerprint: input.tree_hash,
    scope: { tree_hash: input.tree_hash, command: input.command, environment_fingerprint: input.environment_fingerprint, config_hash: input.config_hash }
  };
}

class ProductionCommandEvidenceCache {
  constructor(root) { this.store = new CacheStore(root); }
  async run(input, execute, options = {}) {
    if (typeof execute !== "function") throw new Error("COMMAND_EXECUTOR_REQUIRED");
    const descriptor = descriptorFor(input);
    const existing = this.store.lookup(descriptor);
    if (existing.reuse === "exact" || existing.reuse === "content-stable") return { ...existing, cache_hit: true, payload: existing.entry.payload };
    if (typeof options.rerun_reason !== "string" || !options.rerun_reason.trim()) throw new Error("RERUN_REASON_REQUIRED");
    return this.store.getOrCompute(descriptor, async () => {
      const result = await execute(input.command, input);
      if (!result || !Number.isInteger(result.exit_code)) throw new Error("COMMAND_EVIDENCE_RESULT_INVALID");
      return {
        schema_version: 1,
        authority: "producer-command-evidence",
        independent_verification: false,
        tree_hash: input.tree_hash,
        command: input.command,
        environment_fingerprint: input.environment_fingerprint,
        config_hash: input.config_hash,
        rerun_reason: options.rerun_reason.trim(),
        executed_at: new Date().toISOString(),
        ...result
      };
    }, { metadata: { provenance: { producer: "production-campaign", rerun_reason: options.rerun_reason.trim() } } });
  }
}

module.exports = { descriptorFor, ProductionCommandEvidenceCache };
