"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOwnerReturn, validateOwnerReturn, envelopeForOwner } = require("./owner-return.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-owner-return-"));
try {
  const artifact = path.join(root, "health.json"); fs.writeFileSync(artifact, "{\"canonical\":true}\n"); const digest = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  const echo = { baseline_ref: { artifact_id: "baseline:x", sha256: "a".repeat(64), repository_revision: "b".repeat(40) }, engineering_intelligence_ref: { artifact_id: "engineering-intelligence:x" }, presentation_policy: "inherit" };
  const specialist = path.join(root, "testing.json"); fs.writeFileSync(specialist, "{\"schema_version\":\"ria.testing-fitness@1\"}\n"); const specialistDigest = crypto.createHash("sha256").update(fs.readFileSync(specialist)).digest("hex");
  const value = createOwnerReturn({ owner: "repository-health-assessment", canonical_artifact_ref: { owner: "repository-health-assessment", artifact_id: `health-assessment:${digest}`, sha256: digest, repository_revision: "b".repeat(40) }, repository_revision: "b".repeat(40), artifact_path: artifact, input_binding_echo: echo, specialist_refs: [{ kind:"testing-fitness", schema_version:"ria.testing-fitness@1", artifact_id:`testing-fitness:${specialistDigest}`, sha256:specialistDigest, repository_revision:"b".repeat(40), path:specialist }], warnings: [] });
  assert.equal(validateOwnerReturn(value, { owner: "repository-health-assessment", repository_revision: "b".repeat(40), input_binding_echo: echo }).ok, true);
  assert.equal(value.specialist_refs.length, 1);
  // Evidence Recon sidecar ref: exact shape emitted by write-health-artifact.js.
  const sidecar = path.join(root, "evidence-recon.json"); fs.writeFileSync(sidecar, "{\"evidence_packet_version\":1}\n"); const sidecarDigest = crypto.createHash("sha256").update(fs.readFileSync(sidecar)).digest("hex");
  const erRef = { kind:"evidence-recon", schema_version:"evidence-recon.packet@1", artifact_id:`evidence-recon:${sidecarDigest}`, sha256:sidecarDigest, repository_revision:"b".repeat(40), path:sidecar, artifact_path:sidecar, packet_id:`RHA-ER:sha256:${"c".repeat(64)}` };
  const nsEcho = envelopeForOwner(echo, "repository-health-assessment");
  assert.equal(nsEcho.candidate_namespace, "health");
  const base = { owner: "repository-health-assessment", canonical_artifact_ref: { owner: "repository-health-assessment", artifact_id: `health-assessment:${digest}`, sha256: digest, repository_revision: "b".repeat(40) }, repository_revision: "b".repeat(40), artifact_path: artifact, warnings: [] };
  const withEr = createOwnerReturn({ ...base, input_binding_echo: nsEcho, specialist_refs: [erRef] });
  assert.equal(validateOwnerReturn(withEr, { owner: "repository-health-assessment", input_binding_echo: nsEcho }).ok, true);
  assert.throws(() => createOwnerReturn({ ...base, input_binding_echo: nsEcho, specialist_refs: [{ ...erRef, packet_id: "RHA-ER:pending" }] }), /packet_id/);
  assert.throws(() => createOwnerReturn({ ...base, input_binding_echo: nsEcho, specialist_refs: [{ ...erRef, extra: 1 }] }), /not closed/);
  assert.throws(() => createOwnerReturn({ ...base, input_binding_echo: nsEcho, specialist_refs: [{ ...erRef, artifact_id: "evidence-recon:x" }] }), /artifact_id/);
  assert.throws(() => createOwnerReturn({ ...base, input_binding_echo: nsEcho, specialist_refs: [{ ...erRef, kind: "unknown" }] }), /not supported/);
  // Namespace must belong to the returning owner; presentation_policy is the string "inherit".
  assert.throws(() => createOwnerReturn({ ...base, input_binding_echo: { ...echo, candidate_namespace: "integrity" } }), /not the namespace/);
  assert.throws(() => createOwnerReturn({ ...base, input_binding_echo: { ...echo, presentation_policy: { mode: "inherit" } } }), /presentation_policy/);
  fs.writeFileSync(artifact, "tampered\n"); assert.equal(validateOwnerReturn(value).ok, false);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("RIA_OWNER_RETURN_OK");
