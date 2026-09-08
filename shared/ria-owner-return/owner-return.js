"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OWNERS = new Set(["repository-health-assessment", "codebase-integrity-audit-loop", "architecture-improvement-intelligence"]);
const SHA = /^[0-9a-f]{64}$/;
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fail(detail) { throw new Error(`FAIL-RIA-OWNER-RETURN: ${detail}`); }
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

function validateInputBindingEcho(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("input_binding_echo must be an object");
  const allowed = ["baseline_ref", "engineering_intelligence_ref", "sei_assessment_ref", "verification_baseline_ref", "presentation_policy"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("input_binding_echo is not closed");
  if (!value.baseline_ref || !value.engineering_intelligence_ref) fail("input_binding_echo requires baseline_ref and engineering_intelligence_ref");
  return canonical(value);
}

function createOwnerReturn(input) {
  if (!input || typeof input !== "object") fail("input is invalid");
  const owner = String(input.owner || "");
  if (!OWNERS.has(owner)) fail("owner is invalid");
  const artifactPath = path.resolve(String(input.artifact_path || ""));
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) fail("artifact_path must identify a file");
  const fileSha256 = sha256(fs.readFileSync(artifactPath));
  const ref = canonical(input.canonical_artifact_ref);
  if (!ref || ref.owner !== owner || ref.repository_revision !== input.repository_revision || ref.sha256 !== fileSha256 || !ref.artifact_id || !SHA.test(ref.sha256 || "")) fail("canonical artifact reference does not bind exact owner/revision/bytes");
  const warnings = input.warnings ?? [];
  if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== "string" || !warning)) fail("warnings are invalid");
  const specialistRefs = input.specialist_refs ?? [];
  if (!Array.isArray(specialistRefs)) fail("specialist_refs must be an array");
  for (const item of specialistRefs) {
    if (!item || typeof item !== "object" || !item.kind || !item.schema_version || !item.artifact_id || !SHA.test(item.sha256 || "") || item.repository_revision !== input.repository_revision || !item.path) fail("specialist_refs contains an invalid reference");
    const actual = sha256(fs.readFileSync(path.resolve(item.path)));
    if (actual !== item.sha256) fail("specialist_refs byte hash mismatch");
  }
  return Object.freeze(canonical({
    schema_version: "ria.owner-return@1",
    owner,
    canonical_artifact_ref: ref,
    repository_revision: String(input.repository_revision || ""),
    file_sha256: fileSha256,
    input_binding_echo: validateInputBindingEcho(input.input_binding_echo),
    artifact_path: artifactPath,
    ...(specialistRefs.length ? { specialist_refs: specialistRefs } : {}),
    warnings: [...new Set(warnings)].sort(),
  }));
}

function validateOwnerReturn(value, expected = {}) {
  try {
    const baseKeys = ["artifact_path", "canonical_artifact_ref", "file_sha256", "input_binding_echo", "owner", "repository_revision", "schema_version", "warnings"];
    const allowedKeys = new Set([...baseKeys, "specialist_refs"]);
    if (!value || typeof value !== "object" || Object.keys(value).some((key) => !allowedKeys.has(key)) || baseKeys.some((key) => !(key in value))) fail("return envelope is not closed");
    if (value.schema_version !== "ria.owner-return@1" || !OWNERS.has(value.owner) || !SHA.test(value.file_sha256 || "")) fail("return identity is invalid");
    validateInputBindingEcho(value.input_binding_echo);
    const rebuilt = createOwnerReturn({ owner: value.owner, canonical_artifact_ref: value.canonical_artifact_ref, repository_revision: value.repository_revision, artifact_path: value.artifact_path, input_binding_echo: value.input_binding_echo, specialist_refs: value.specialist_refs ?? [], warnings: value.warnings });
    if (!same(rebuilt, value)) fail("return bytes or bindings drifted");
    if (expected.owner && value.owner !== expected.owner) fail("unexpected owner");
    if (expected.repository_revision && value.repository_revision !== expected.repository_revision) fail("unexpected repository revision");
    if (expected.input_binding_echo && !same(value.input_binding_echo, expected.input_binding_echo)) fail("input binding echo mismatch");
    return { ok: true, errors: [], owner_ref: structuredClone(value.canonical_artifact_ref) };
  } catch (error) { return { ok: false, errors: [error.message] }; }
}

module.exports = { OWNERS, createOwnerReturn, validateOwnerReturn };
