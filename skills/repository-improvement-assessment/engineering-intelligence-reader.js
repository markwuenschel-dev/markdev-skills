"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  assertArtifact,
  assertSeiAssessmentRef,
  assertEngineeringIntelligenceRef,
  assertExpectedBinding,
  assertResolvedArtifactContained,
  canonicalBytes,
  deepEqual,
  fail,
  resolveArtifactFile,
  sha256Bytes,
} = require("./engineering-intelligence.js");

function assertReaderInput(input) {
  const allowed = ["repository_root", "engineering_intelligence_ref", "expected"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-READER-SCHEMA", "reader input contains unsupported fields");
  }
  if (typeof input.repository_root !== "string" || input.repository_root.trim().length === 0) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-READER-SCHEMA", "repository_root must be RIA-supplied storage context");
  }
  return {
    repository_root: input.repository_root,
    engineering_intelligence_ref: assertEngineeringIntelligenceRef(input.engineering_intelligence_ref),
    expected: assertExpectedBinding(input.expected),
  };
}

function assertBinding(ref, artifact, expected) {
  if (ref.repository_revision !== expected.repository_revision || ref.mission_id !== expected.mission_id || ref.scope_hash !== expected.scope_hash ||
      !deepEqual(ref.baseline_binding, expected.baseline_ref)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-BINDING-MISMATCH", "reference does not match expected RIA baseline, revision, mission, and scope binding");
  }
  if (artifact.repository_revision !== ref.repository_revision || artifact.mission_id !== ref.mission_id || artifact.scope_hash !== ref.scope_hash ||
      !deepEqual(artifact.baseline_binding, ref.baseline_binding)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-BINDING-MISMATCH", "artifact does not match its opaque reference binding");
  }
}

function readEngineeringIntelligenceArtifact(input) {
  const normalized = assertReaderInput(input);
  const storage = resolveArtifactFile(normalized.repository_root, normalized.engineering_intelligence_ref.sha256);
  let bytes;
  try {
    if (!fs.existsSync(storage.file_path)) {
      fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-NOT-FOUND", "no artifact exists at the canonical content-addressed location");
    }
    bytes = fs.readFileSync(assertResolvedArtifactContained(storage));
  } catch (error) {
    if (error.message?.startsWith("FAIL-ENGINEERING-INTELLIGENCE-")) throw error;
    fail("FAIL-ENGINEERING-INTELLIGENCE-STORAGE-READ", error.message);
  }
  if (sha256Bytes(bytes) !== normalized.engineering_intelligence_ref.sha256) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-HASH-MISMATCH", "artifact bytes do not match the opaque reference sha256");
  }
  let artifact;
  try {
    artifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-SCHEMA", "artifact bytes are not valid JSON");
  }
  if (!canonicalBytes(artifact).equals(bytes)) {
    fail("FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-CANONICAL", "artifact bytes must use RIA canonical JSON before semantic validation");
  }
  artifact = assertArtifact(artifact);
  assertBinding(normalized.engineering_intelligence_ref, artifact, normalized.expected);
  return artifact;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The expected binding derives from the bound RIA envelope, so owners can call
 * this reader with exactly the envelope and repository context they were given. */
function expectedFromEnvelope(envelope) {
  const ref = envelope?.engineering_intelligence_ref;
  return { baseline_ref: envelope?.baseline_ref, repository_revision: envelope?.baseline_ref?.repository_revision, mission_id: ref?.mission_id, scope_hash: ref?.scope_hash };
}

/** Combined SEI reader (composite-scoring-v3 §5.3): returns the verified snapshot
 * artifact and the verified scored criterion assessment, cross-bound.
 *
 * input: { repository_root, envelope, allowed_roots? }
 *   envelope        the bound RIA owner envelope (engineering_intelligence_ref,
 *                   optional sei_assessment_ref, baseline_ref)
 *   allowed_roots   directories an assessment artifact may live under; defaults to
 *                   <repository_root>/.project-intelligence plus $RIA_RUNTIME_ROOT
 * Returns { snapshot, assessment, assessment_status: "bound" | "missing" }.
 * A missing sei_assessment_ref is a legacy input ("missing"); a hash mismatch,
 * malformed bytes, path escape or conflicting binding always throws. */
function readSeiEvidence(input) {
  const allowed = ["repository_root", "envelope", "allowed_roots"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    fail("FAIL-SEI-EVIDENCE-READER-SCHEMA", "reader input contains unsupported fields");
  }
  const envelope = input.envelope;
  if (!envelope || typeof envelope !== "object") fail("FAIL-SEI-EVIDENCE-READER-SCHEMA", "envelope is required");
  const snapshot = readEngineeringIntelligenceArtifact({ repository_root: input.repository_root, engineering_intelligence_ref: envelope.engineering_intelligence_ref, expected: expectedFromEnvelope(envelope) });
  const ref = envelope.sei_assessment_ref;
  if (ref === undefined || ref === null) return { snapshot, assessment: null, assessment_status: "missing" };
  const roots = (input.allowed_roots ?? [path.join(input.repository_root, ".project-intelligence"), process.env.RIA_RUNTIME_ROOT].filter(Boolean)).map((root) => {
    try { return fs.realpathSync.native(path.resolve(root)); } catch { return path.resolve(root); }
  });
  let artifactReal;
  try { artifactReal = fs.realpathSync.native(path.resolve(String(ref.artifact_path ?? ""))); }
  catch { fail("FAIL-SEI-ASSESSMENT-ARTIFACT-NOT-FOUND", "assessment artifact is not readable"); }
  if (!roots.some((root) => isContained(root, artifactReal))) fail("FAIL-SEI-ASSESSMENT-PATH-ESCAPE", "assessment artifact must live under the repository workspace or the RIA runtime root");
  // Re-hashes the bytes before parsing and checks the exact ref <-> artifact binding.
  assertSeiAssessmentRef(ref, { repository_revision: envelope.baseline_ref?.repository_revision });
  const bytes = fs.readFileSync(artifactReal);
  if (sha256Bytes(bytes) !== ref.artifact_sha256) fail("FAIL-SEI-ASSESSMENT-HASH-MISMATCH", "assessment artifact bytes changed after verification");
  const assessment = JSON.parse(bytes.toString("utf8"));
  const sei = snapshot.engineering_intelligence ?? {};
  const binding = assessment.snapshot_binding ?? {};
  // A same-revision assessment from another snapshot is not interchangeable.
  if (binding.snapshot_id !== sei.snapshot_id || binding.repository_id !== sei.repository?.repository_id ||
      binding.repository_revision !== sei.repository?.revision || binding.configuration_hash !== sei.repository?.configuration_hash) {
    fail("FAIL-SEI-ASSESSMENT-SNAPSHOT-MISMATCH", "assessment is not bound to the bound engineering-intelligence snapshot");
  }
  return { snapshot, assessment, assessment_status: "bound" };
}

/** Citation check against bound assessment bytes (§5.3): a
 * {kind: "sei-criterion", criterion_id, metric_id} entry is valid only if the
 * criterion is in the assessment and the metric is one of its observations'
 * source_metric_ids or observation_ids. Returns problem strings. */
function seiCitationProblems(assessment, citations) {
  const problems = [];
  const criteria = new Map((assessment?.criteria ?? []).map((criterion) => [criterion.criterion_id, criterion]));
  for (const citation of citations) {
    const where = citation.where ? `${citation.where}: ` : "";
    if (typeof citation.criterion_id !== "string" || !citation.criterion_id || typeof citation.metric_id !== "string" || !citation.metric_id) { problems.push(`${where}sei-criterion citation needs criterion_id and metric_id`); continue; }
    if (!assessment) { problems.push(`${where}sei-criterion ${citation.criterion_id}/${citation.metric_id} cites SEI, but no SEI assessment is bound`); continue; }
    const criterion = criteria.get(citation.criterion_id);
    if (!criterion) { problems.push(`${where}criterion ${citation.criterion_id} is not in the bound assessment`); continue; }
    const metrics = new Set((criterion.evidence?.observations ?? []).flatMap((observation) => [observation.observation_id, ...(observation.source_metric_ids ?? [])]));
    if (!metrics.has(citation.metric_id)) problems.push(`${where}metric ${citation.metric_id} is not a metric of criterion ${citation.criterion_id} in the bound assessment`);
  }
  return problems;
}

/** Collects sei-criterion citations from a Health island or an Architecture
 * candidate set. */
function collectSeiCitations(value) {
  const out = [];
  const roots = [value, value?.health, value?.health_island, value?.payload, value?.assessment, value?.candidate_set, value?.architecture_candidate_set].filter((item) => item && typeof item === "object");
  const artifact = roots.find((item) => Array.isArray(item.claims) || (Array.isArray(item.candidates) && Number(item.schema_version) === 2)) ?? {};
  for (const claim of artifact?.claims ?? []) {
    for (const [index, entry] of (claim?.evidence ?? []).entries()) if (entry?.kind === "sei-criterion") out.push({ ...entry, where: `claims[${claim.claim_id}].evidence[${index}]` });
  }
  for (const candidate of artifact?.candidates ?? []) {
    for (const [index, entry] of (candidate?.evidence_refs ?? []).entries()) if (entry && typeof entry === "object" && entry.kind === "sei-criterion") out.push({ ...entry, where: `candidates[${candidate.candidate_id}].evidence_refs[${index}]` });
  }
  return out;
}

module.exports = { collectSeiCitations, readEngineeringIntelligenceArtifact, readSeiEvidence, seiCitationProblems };
