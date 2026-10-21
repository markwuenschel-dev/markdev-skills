"use strict";

/* Direct-invocation boundary for standalone planner auto mode. The planner may
 * synthesize read-only topology without delivery authority. A mutating handoff
 * must carry an exact authorization owned by production-flywheel. */
const fs = require("fs");
const path = require("path");

function guard(repositoryRoot, deliveryAuthorization) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    return Object.freeze({ ok: false, code: "REPOSITORY_ROOT_REQUIRED", message: "Supply the canonical repository root." });
  }
  const canonicalRoot = path.resolve(repositoryRoot);
  if (!fs.existsSync(canonicalRoot)) {
    return Object.freeze({ ok: false, code: "REPOSITORY_NOT_FOUND", message: "The canonical repository root does not exist." });
  }
  if (deliveryAuthorization === undefined) {
    return Object.freeze({ ok: true, mode: "read-only-topology", repository_root: canonicalRoot });
  }
  if (!deliveryAuthorization || typeof deliveryAuthorization !== "object" || Array.isArray(deliveryAuthorization)) {
    return Object.freeze({ ok: false, code: "DELIVERY_AUTHORIZATION_INVALID", message: "Delivery authorization must be an object." });
  }
  const required = ["authorization_ref", "issuer", "mission_id", "scope_hash", "repository_revision"];
  if (required.some((key) => typeof deliveryAuthorization[key] !== "string" || deliveryAuthorization[key].length === 0)) {
    return Object.freeze({ ok: false, code: "DELIVERY_AUTHORIZATION_INCOMPLETE", message: "Authorization must bind reference, issuer, mission, scope, and repository revision." });
  }
  if (deliveryAuthorization.owner !== "production-flywheel" || deliveryAuthorization.permitted_mutation !== true) {
    return Object.freeze({ ok: false, code: "DELIVERY_AUTHORITY_MISMATCH", message: "Mutating topology may be handed only to production-flywheel under explicit mutation authority." });
  }
  return Object.freeze({
    ok: true,
    mode: "direct-authorized-handoff",
    repository_root: canonicalRoot,
    authorization: Object.freeze({
      authorization_ref: deliveryAuthorization.authorization_ref,
      issuer: deliveryAuthorization.issuer,
      mission_id: deliveryAuthorization.mission_id,
      scope_hash: deliveryAuthorization.scope_hash,
      repository_revision: deliveryAuthorization.repository_revision,
      owner: deliveryAuthorization.owner,
      permitted_mutation: true
    })
  });
}

if (require.main === module) {
  const repositoryRoot = process.argv[2];
  let authorization;
  if (process.argv[3]) authorization = JSON.parse(process.argv[3]);
  const result = guard(repositoryRoot, authorization);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
}

module.exports = { guard };
