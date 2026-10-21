"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProductionCommandEvidenceCache } = require("./command-evidence-cache");

(async () => {
  const cache = new ProductionCommandEvidenceCache(fs.mkdtempSync(path.join(os.tmpdir(), "command-evidence-")));
  let calls = 0;
  const execute = async () => ({ exit_code: 0, stdout: "PASS", invocation: ++calls });
  const base = { repository_key: "repo", tree_hash: "tree-a", command: "npm test", environment_fingerprint: "env-a", config_hash: "config-a", source_revision: "rev-a" };
  const first = await cache.run(base, execute, { rerun_reason: "no matching command evidence" });
  const hit = await cache.run(base, execute, { rerun_reason: "should not execute" });
  assert.equal(first.cache_hit, false);
  assert.equal(hit.cache_hit, true);
  assert.equal(calls, 1);
  for (const variant of [
    { tree_hash: "tree-b" },
    { command: "npm run test:full" },
    { environment_fingerprint: "env-b" },
    { config_hash: "config-b" }
  ]) await cache.run({ ...base, ...variant }, execute, { rerun_reason: "cache key changed" });
  assert.equal(calls, 5, "tree, command, environment, and config changes must each invalidate reuse");
  assert.equal(hit.payload.authority, "producer-command-evidence");
  assert.equal(hit.payload.independent_verification, false, "cached PASS is never an IV verdict");
  await assert.rejects(() => cache.run({ ...base, tree_hash: "tree-c" }, execute), /RERUN_REASON_REQUIRED/);
  console.log("GREEN — exact-key command evidence reuse and negative invalidation matrix");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
