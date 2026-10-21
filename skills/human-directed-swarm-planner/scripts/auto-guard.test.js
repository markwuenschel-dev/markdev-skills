"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { guard } = require("./auto-guard");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "planner-auto-guard-"));
try {
  const readOnly = guard(root);
  assert.equal(readOnly.ok, true);
  assert.equal(readOnly.mode, "read-only-topology");
  assert.equal(guard(path.join(root, "missing")).code, "REPOSITORY_NOT_FOUND");
  assert.equal(guard(root, {}).code, "DELIVERY_AUTHORIZATION_INCOMPLETE");
  const authorization = {
    authorization_ref: "auth-1",
    issuer: "operator",
    mission_id: "mission-1",
    scope_hash: "scope-1",
    repository_revision: "revision-1",
    owner: "production-flywheel",
    permitted_mutation: true
  };
  assert.equal(guard(root, { ...authorization, owner: "human-directed-swarm-planner" }).code, "DELIVERY_AUTHORITY_MISMATCH");
  const authorized = guard(root, authorization);
  assert.equal(authorized.ok, true);
  assert.equal(authorized.mode, "direct-authorized-handoff");
  assert.equal(authorized.authorization.authorization_ref, "auth-1");
  console.log("GREEN — 5/5 checks passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
