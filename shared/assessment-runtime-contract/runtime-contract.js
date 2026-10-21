"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])); return value; }
function sha256(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function fail(detail) { throw new Error(`FAIL-ASSESSMENT-RUNTIME-CONTRACT: ${detail}`); }
function validate(value) {
  const keys = ["authority", "entrypoint", "execution", "input", "output", "owner", "presentation", "schema_version", "verification", "version"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== keys.sort().join("|")) fail("contract is not closed");
  if (value.schema_version !== "assessment-runtime-contract@1" || !value.owner || !/^\d+\.\d+\.\d+$/.test(value.version) || !value.entrypoint) fail("identity is invalid");
  if (!Array.isArray(value.input?.required) || !Array.isArray(value.input?.optional)) fail("input contract is invalid");
  if (!value.output?.immutable || !value.output.kind || !value.output.schema || !Array.isArray(value.output.reference_fields)) fail("output contract is invalid");
  if (value.authority?.source_repository_mutation !== false || !Array.isArray(value.authority.owns) || !Array.isArray(value.authority.does_not_own)) fail("authority is invalid");
  if (value.presentation?.canonical_independent_of_report !== true || typeof value.presentation.supports_report !== "boolean" || typeof value.presentation.accepts_inherit !== "boolean") fail("presentation is invalid");
  if (typeof value.verification?.consumes_shared_baseline !== "boolean" || typeof value.verification?.targeted_reverification_allowed !== "boolean") fail("verification is invalid");
  if (!new Set(["agent", "deterministic", "hybrid"]).has(value.execution?.executor_class) || typeof value.execution.flatten_under_ria !== "boolean" || value.execution.full_skill_read_by_parent !== false) fail("execution is invalid");
  return { ok: true, sha256: sha256(value), contract: Object.freeze(canonical(value)) };
}
function read(filePath) { const value = JSON.parse(fs.readFileSync(filePath, "utf8")); return validate(value); }
module.exports = { validate, read, sha256 };
