"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OWNERS = new Set(["repository-health-assessment", "codebase-integrity-audit-loop", "architecture-improvement-intelligence"]);
/** RIA assigns each owner one candidate id namespace. Owners prefix every candidate_id they
 * mint with `<namespace>:` so ids cannot collide across owners; an id carrying another
 * owner's prefix is an adopted upstream candidate, never a fresh mint. */
const CANDIDATE_NAMESPACES = Object.freeze({
  "repository-health-assessment": "health",
  "codebase-integrity-audit-loop": "integrity",
  "architecture-improvement-intelligence": "architecture",
});
const SHA = /^[0-9a-f]{64}$/;
const SPECIALIST_KINDS = Object.freeze({
  // Legacy review-testing sidecar: informational only in RIA (never substitutes a Health lane).
  "testing-fitness": { schema_version: "ria.testing-fitness@1", keys: ["artifact_id", "kind", "path", "repository_revision", "schema_version", "sha256"] },
  // Repository Health's validated Evidence Recon sidecar (shared/evidence-recon packet).
  "evidence-recon": { schema_version: "evidence-recon.packet@1", keys: ["artifact_id", "artifact_path", "kind", "packet_id", "path", "repository_revision", "schema_version", "sha256"] },
});
const PACKET_ID = /^RHA-ER:sha256:[0-9a-f]{64}$/;
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fail(detail) { throw new Error(`FAIL-RIA-OWNER-RETURN: ${detail}`); }
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

function validateInputBindingEcho(value, owner = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("input_binding_echo must be an object");
  const allowed = ["baseline_ref", "engineering_intelligence_ref", "sei_assessment_ref", "verification_baseline_ref", "presentation_policy", "candidate_namespace"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("input_binding_echo is not closed");
  if (!value.baseline_ref || !value.engineering_intelligence_ref) fail("input_binding_echo requires baseline_ref and engineering_intelligence_ref");
  if ("presentation_policy" in value && value.presentation_policy !== "inherit") fail("input_binding_echo.presentation_policy must be the string \"inherit\"");
  if ("candidate_namespace" in value) {
    if (!Object.values(CANDIDATE_NAMESPACES).includes(value.candidate_namespace)) fail("input_binding_echo.candidate_namespace is invalid");
    if (owner && CANDIDATE_NAMESPACES[owner] !== value.candidate_namespace) fail(`input_binding_echo.candidate_namespace ${value.candidate_namespace} is not the namespace of ${owner}`);
  }
  return canonical(value);
}

function validateSpecialistRef(item, repositoryRevision) {
  if (!item || typeof item !== "object" || Array.isArray(item)) fail("specialist_refs contains an invalid reference");
  const spec = SPECIALIST_KINDS[item.kind];
  if (!spec) fail(`specialist_refs kind ${item.kind} is not supported`);
  const keys = Object.keys(item).sort();
  if (keys.length !== spec.keys.length || keys.some((key, index) => key !== spec.keys[index])) fail(`specialist_refs ${item.kind} reference is not closed`);
  if (item.schema_version !== spec.schema_version || !item.artifact_id || !SHA.test(item.sha256 || "") || item.repository_revision !== repositoryRevision || !item.path) fail("specialist_refs contains an invalid reference");
  if (item.kind === "evidence-recon") {
    if (item.artifact_id !== `evidence-recon:${item.sha256}`) fail("evidence-recon artifact_id must be evidence-recon:<sha256>");
    if (path.resolve(String(item.artifact_path || "")) !== path.resolve(item.path)) fail("evidence-recon path and artifact_path must name the same file");
    if (!PACKET_ID.test(item.packet_id || "")) fail("evidence-recon packet_id must be RHA-ER:sha256:<64 hex>");
  }
  const actual = sha256(fs.readFileSync(path.resolve(item.path)));
  if (actual !== item.sha256) fail("specialist_refs byte hash mismatch");
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
  const kinds = new Set();
  for (const item of specialistRefs) {
    validateSpecialistRef(item, input.repository_revision);
    if (kinds.has(item.kind)) fail(`specialist_refs carries more than one ${item.kind} reference`);
    kinds.add(item.kind);
  }
  return Object.freeze(canonical({
    schema_version: "ria.owner-return@1",
    owner,
    canonical_artifact_ref: ref,
    repository_revision: String(input.repository_revision || ""),
    file_sha256: fileSha256,
    input_binding_echo: validateInputBindingEcho(input.input_binding_echo, owner),
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
    validateInputBindingEcho(value.input_binding_echo, value.owner);
    const rebuilt = createOwnerReturn({ owner: value.owner, canonical_artifact_ref: value.canonical_artifact_ref, repository_revision: value.repository_revision, artifact_path: value.artifact_path, input_binding_echo: value.input_binding_echo, specialist_refs: value.specialist_refs ?? [], warnings: value.warnings });
    if (!same(rebuilt, value)) fail("return bytes or bindings drifted");
    if (expected.owner && value.owner !== expected.owner) fail("unexpected owner");
    if (expected.repository_revision && value.repository_revision !== expected.repository_revision) fail("unexpected repository revision");
    if (expected.input_binding_echo && !same(value.input_binding_echo, expected.input_binding_echo)) fail("input binding echo mismatch");
    return { ok: true, errors: [], owner_ref: structuredClone(value.canonical_artifact_ref) };
  } catch (error) { return { ok: false, errors: [error.message] }; }
}

/** The envelope RIA sends one owner: the shared bindings plus that owner's namespace. */
function envelopeForOwner(envelope, owner) {
  if (!OWNERS.has(owner)) fail("owner is invalid");
  return canonical({ ...envelope, candidate_namespace: CANDIDATE_NAMESPACES[owner] });
}

module.exports = { OWNERS, CANDIDATE_NAMESPACES, SPECIALIST_KINDS, createOwnerReturn, validateOwnerReturn, envelopeForOwner };
