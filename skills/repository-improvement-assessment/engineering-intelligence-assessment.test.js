"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const reportSchema = require("./assets/report-schema.json");
const { canonicalBytes } = require("./engineering-intelligence.js");
const { validateAgainstSchema } = require("../shared/software-engineering-intelligence/schema-validator.js");

const RIA_ROOT = __dirname;
const SKILLS_ROOT = path.resolve(RIA_ROOT, "..");
const SEI_ROOT = path.join(SKILLS_ROOT, "shared", "software-engineering-intelligence");
const CANONICAL_SNAPSHOT = JSON.parse(fs.readFileSync(path.join(SEI_ROOT, "canonical-intelligence.json"), "utf8"));
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SCOPE_HASH = "b".repeat(64);
const OWNER_IDS = [
  "repository-health-assessment",
  "codebase-integrity-audit-loop",
  "architecture-improvement-intelligence",
];

function clone(value) {
  return structuredClone(value);
}

function snapshotFor() {
  return clone(CANONICAL_SNAPSHOT);
}

function baselineRef() {
  return { artifact_id: "baseline:assessment-1", sha256: "a".repeat(64), repository_revision: REVISION };
}

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// The workspace layer requires a real git root (project-intelligence-workspace.js:40,45); a bare
// mkdtemp directory throws before the cwd fallback is reachable.
function temporaryRepository(context, prefix) {
  const directory = temporaryDirectory(context, prefix);
  const git = (...args) => childProcess.execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
  git("init");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(directory, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-m", "a");
  return directory;
}

function assessment() {
  return require("./engineering-intelligence-assessment.js");
}

function ownerReceipt(owner, input) {
  return {
    owner_ref: {
      owner,
      artifact_id: `${owner}:assessment`,
      sha256: String(OWNER_IDS.indexOf(owner) + 1).repeat(64),
      repository_revision: input.baseline_ref.repository_revision,
    },
    baseline_ref: clone(input.baseline_ref),
    engineering_intelligence_ref: clone(input.engineering_intelligence_ref),
    ...(input.sei_assessment_ref ? { sei_assessment_ref: clone(input.sei_assessment_ref) } : {}),
  };
}

function seiAssessmentRef(context, { revision = REVISION, evaluatorId = "sei.engineering-assessment", mutateArtifact } = {}) {
  const directory = temporaryDirectory(context, "ria-sei-assessment-");
  const binding = {
    snapshot_id: "sei-v1-integration-test",
    revision,
    repository_id: "integration-repository",
    digest: "c".repeat(64),
  };
  const ref = {
    schema_version: "sei.engineering-assessment@1",
    assessment_id: "sei-assessment:integration-test",
    snapshot_binding: binding,
    evaluator: { id: evaluatorId, version: "1.0.0" },
    rubric: { id: "sei-rubric", version: "1.0.0", digest: `sha256:${"d".repeat(64)}` },
    standard: { id: "sei-standard", version: "1.0.0", digest: `sha256:${"e".repeat(64)}` },
    config_digest: binding.digest,
    applicability_digest: `sha256:${"1".repeat(64)}`,
  };
  const sidecar = {
    schema_version: ref.schema_version,
    assessment_id: ref.assessment_id,
    snapshot_binding: {
      snapshot_id: binding.snapshot_id,
      repository_id: binding.repository_id,
      repository_revision: binding.revision,
      configuration_hash: binding.digest,
    },
    repository_index_binding: { repository_revision: binding.revision, index_digest: `sha256:${"2".repeat(64)}` },
    evaluator: { evaluator_id: evaluatorId, version: ref.evaluator.version, deterministic: true },
    rubric: { rubric_id: ref.rubric.id, version: ref.rubric.version, digest: ref.rubric.digest, maturity_thresholds: { not_scored_below: 0.3, provisional_below: 0.6 } },
    standard: { standard_id: ref.standard.id, version: ref.standard.version, source: "fixture", digest: ref.standard.digest },
    applicability: { not_applicable_criteria: [], digest: ref.applicability_digest },
  };
  mutateArtifact?.(sidecar);
  const artifactPath = path.join(directory, "assessment.json");
  const bytes = canonicalBytes(sidecar);
  fs.writeFileSync(artifactPath, bytes);
  return {
    ...ref,
    artifact_path: artifactPath,
    artifact_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function assessReport() {
  const baseline = baselineRef();
  const intelligenceSha = "e".repeat(64);
  return {
    schema: "https://markdev-skills.local/repository-improvement-assessment/assess-report-schema.json",
    // Closed 11-element tuple; assets/report-schema.json:282-321 pins both the order and the count.
    required_sections: [
      "Executive Assessment",
      "Health",
      "Integrity",
      "Architecture",
      "Cross-Cutting Synthesis",
      "Highest-Leverage Priorities",
      "Evidence Certainty and Gaps",
      "Downstream Disposition",
      "Coverage and Provenance",
      "Assessment Status",
      "Next Lifecycle",
    ],
    markdown: "# RIA assessment\n",
    baseline_ref: clone(baseline),
    engineering_intelligence_ref: {
      artifact_id: `engineering-intelligence:${intelligenceSha}`,
      owner: "repository-improvement-assessment",
      kind: "engineering-intelligence",
      schema_version: "1.0.0",
      sha256: intelligenceSha,
      repository_revision: REVISION,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      baseline_binding: clone(baseline),
    },
    assessment_refs: OWNER_IDS.map((owner, index) => ({
      owner,
      artifact_id: `${owner}:assessment`,
      sha256: String(index + 1).repeat(64),
      repository_revision: REVISION,
    })),
  };
}

test("canonical RIA computes once and passes byte-identical opaque evidence envelopes to exactly three owners", (context) => {
  const repositoryRoot = temporaryRepository(context, "ria-assess-engineering-intelligence-");
  const baseline = baselineRef();
  const envelopes = [];
  let computeCalls = 0;
  const projection = assessment().runAssessWithEngineeringIntelligence({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => {
      computeCalls += 1;
      return snapshotFor();
    },
    owner_assessors: Object.fromEntries(OWNER_IDS.map((owner) => [owner, (input) => {
      envelopes.push(JSON.stringify(input));
      assert.deepEqual(Object.keys(input).sort(), ["baseline_ref", "engineering_intelligence_ref"]);
      return ownerReceipt(owner, input);
    }])),
  });

  assert.equal(computeCalls, 1);
  assert.equal(envelopes.length, 3);
  assert.equal(new Set(envelopes).size, 1);
  assert.deepEqual(Object.keys(projection).sort(), [
    "assessment_refs",
    "baseline_ref",
    "engineering_intelligence_ref",
    "owner",
    "stage",
  ]);
  assert.equal(projection.owner, "repository-improvement-assessment");
  assert.equal(projection.stage, "ASSESS");
  assert.deepEqual(projection.assessment_refs.map((ref) => ref.owner), OWNER_IDS);
  assert.deepEqual(assessment().validateAssessProjection(projection), { ok: true, errors: [] });
});

test("RIA accepts a hash-verified optional SEI assessment sidecar without making SEI a fourth owner", (context) => {
  const repositoryRoot = temporaryRepository(context, "ria-assess-sei-sidecar-");
  const baseline = baselineRef();
  const seiAssessment = seiAssessmentRef(context);
  const projection = assessment().runAssessWithEngineeringIntelligence({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-sei-sidecar",
    scope_hash: SCOPE_HASH,
    compute_snapshot: snapshotFor,
    sei_assessment_ref: seiAssessment,
    owner_assessors: Object.fromEntries(OWNER_IDS.map((owner) => [owner, (input) => {
      assert.deepEqual(input.sei_assessment_ref, seiAssessment);
      return ownerReceipt(owner, input);
    }])),
  });

  assert.deepEqual(projection.sei_assessment_ref, seiAssessment);
  assert.equal(projection.assessment_refs.length, 3);
  assert.deepEqual(projection.assessment_refs.map((ref) => ref.owner), OWNER_IDS);
});

test("RIA rejects forged, stale, and wrong-owner SEI assessment sidecars before dispatch", (context) => {
  const repositoryRoot = temporaryRepository(context, "ria-assess-sei-sidecar-reject-");
  const baseline = baselineRef();
  const input = (sei_assessment_ref) => ({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-sei-sidecar-reject",
    scope_hash: SCOPE_HASH,
    compute_snapshot: snapshotFor,
    sei_assessment_ref,
    owner_assessors: Object.fromEntries(OWNER_IDS.map((owner) => [owner, (envelope) => ownerReceipt(owner, envelope)])),
  });
  const forged = seiAssessmentRef(context);
  fs.appendFileSync(forged.artifact_path, "forged");
  assert.throws(() => assessment().runAssessWithEngineeringIntelligence(input(forged)), /FAIL-SEI-ASSESSMENT-HASH-MISMATCH/);
  assert.throws(() => assessment().runAssessWithEngineeringIntelligence(input(seiAssessmentRef(context, { revision: "f".repeat(40) }))), /FAIL-SEI-ASSESSMENT-BINDING-MISMATCH/);
  assert.throws(() => assessment().runAssessWithEngineeringIntelligence(input(seiAssessmentRef(context, { evaluatorId: "repository-health-assessment" }))), /FAIL-SEI-ASSESSMENT-OWNER/);
});

test("RIA report accepts the optional verified SEI sidecar separately from exactly three owner references", (context) => {
  const report = assessReport();
  report.sei_assessment_ref = seiAssessmentRef(context);
  assert.deepEqual(validateAgainstSchema(report, reportSchema), []);
  assert.deepEqual(assessment().validateAssessReport(report), { ok: true, errors: [] });
  assert.equal(report.assessment_refs.length, 3);

  const stale = clone(report);
  stale.sei_assessment_ref = seiAssessmentRef(context, { revision: "f".repeat(40) });
  assert.deepEqual(validateAgainstSchema(stale, reportSchema), []);
  const validation = assessment().validateAssessReport(stale);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("FAIL-SEI-ASSESSMENT-BINDING-MISMATCH")));
});

test("RIA rejects an owner that forges an optional SEI assessment binding echo", (context) => {
  const repositoryRoot = temporaryRepository(context, "ria-assess-sei-echo-reject-");
  const baseline = baselineRef();
  const seiAssessment = seiAssessmentRef(context);
  const ownerAssessors = Object.fromEntries(OWNER_IDS.map((owner) => [owner, (input) => ownerReceipt(owner, input)]));
  ownerAssessors["repository-health-assessment"] = (input) => ({
    ...ownerReceipt("repository-health-assessment", input),
    sei_assessment_ref: { ...input.sei_assessment_ref, artifact_sha256: "0".repeat(64) },
  });
  assert.throws(() => assessment().runAssessWithEngineeringIntelligence({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-sei-echo-reject",
    scope_hash: SCOPE_HASH,
    compute_snapshot: snapshotFor,
    sei_assessment_ref: seiAssessment,
    owner_assessors: ownerAssessors,
  }), /FAIL-RIA-OWNER-ASSESSMENT-BINDING/);
});

test("canonical RIA rejects mismatched child bindings and retains grade, candidate, and judgment authority", (context) => {
  const repositoryRoot = temporaryRepository(context, "ria-assess-child-rejection-");
  const baseline = baselineRef();
  const validAssessors = Object.fromEntries(OWNER_IDS.map((owner) => [owner, (input) => ownerReceipt(owner, input)]));
  validAssessors["repository-health-assessment"] = (input) => ({
    ...ownerReceipt("repository-health-assessment", input),
    baseline_ref: { ...input.baseline_ref, artifact_id: "baseline:forged" },
  });

  assert.throws(
    () => assessment().runAssessWithEngineeringIntelligence({
      repository_root: repositoryRoot,
      baseline_ref: baseline,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      compute_snapshot: snapshotFor,
      owner_assessors: validAssessors,
    }),
    /FAIL-RIA-OWNER-ASSESSMENT-BINDING/,
  );

  const projection = assessment().runAssessWithEngineeringIntelligence({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test-authority",
    scope_hash: SCOPE_HASH,
    compute_snapshot: snapshotFor,
    owner_assessors: Object.fromEntries(OWNER_IDS.map((owner) => [owner, (input) => ownerReceipt(owner, input)])),
  });
  assert.ok(!Object.keys(projection).some((key) => /health|candidate|score|recommendation|graph|lifecycle|verification|publish/i.test(key)));
  assert.equal(projection.assessment_refs.length, 3);
});

test("RIA report schema and runtime reject a fourth owner, duplicate owners, and cross-field ref drift", () => {
  const valid = assessReport();
  assert.deepEqual(validateAgainstSchema(valid, reportSchema), []);
  assert.deepEqual(assessment().validateAssessReport(valid), { ok: true, errors: [] });

  const fourthOwner = clone(valid);
  fourthOwner.assessment_refs[2].owner = "software-engineering-intelligence";
  const ownerErrors = validateAgainstSchema(fourthOwner, reportSchema);
  assert.ok(ownerErrors.some((error) => error.includes("assessment_refs[2]")), "the closed oneOf owner set must reject a fourth owner directly in schema validation");

  const digestMismatch = clone(valid);
  digestMismatch.engineering_intelligence_ref.artifact_id = `engineering-intelligence:${"f".repeat(64)}`;
  assert.deepEqual(validateAgainstSchema(digestMismatch, reportSchema), []);
  const digestValidation = assessment().validateAssessReport(digestMismatch);
  assert.equal(digestValidation.ok, false);
  assert.ok(digestValidation.errors.some((error) => error.includes("FAIL-RIA-ASSESS-REPORT-BINDING")));

  const duplicateOwner = clone(valid);
  duplicateOwner.assessment_refs[2] = clone(duplicateOwner.assessment_refs[0]);
  const duplicateValidation = assessment().validateAssessReport(duplicateOwner);
  assert.equal(duplicateValidation.ok, false);
  assert.ok(duplicateValidation.errors.some((error) => error.includes("duplicate owner")));

  const extraOwner = clone(valid);
  extraOwner.assessment_refs.push(clone(extraOwner.assessment_refs[0]));
  assert.ok(validateAgainstSchema(extraOwner, reportSchema).some((error) => error.includes("assessment_refs")), "the report contract must not admit a fourth owner reference");
  const staleOwner = clone(valid);
  staleOwner.assessment_refs[1].repository_revision = "f".repeat(40);
  const staleValidation = assessment().validateAssessReport(staleOwner);
  assert.equal(staleValidation.ok, false);
  assert.ok(staleValidation.errors.some((error) => error.includes("FAIL-RIA-ASSESS-REPORT-BINDING")));

  const projectionWithDigestMismatch = {
    stage: "ASSESS",
    owner: "repository-improvement-assessment",
    baseline_ref: clone(valid.baseline_ref),
    engineering_intelligence_ref: clone(digestMismatch.engineering_intelligence_ref),
    assessment_refs: clone(valid.assessment_refs),
  };
  const projectionValidation = assessment().validateAssessProjection(projectionWithDigestMismatch);
  assert.equal(projectionValidation.ok, false);
  assert.ok(projectionValidation.errors.some((error) => error.includes("FAIL-ENGINEERING-INTELLIGENCE-REF-CONTRACT")));
});

test("RIA integration leaves runtime and remediation graph unaware of an SEI-specific field", () => {
  for (const relative of [
    "shared/orchestration-runtime/runtime.schema.json",
    "shared/remediation-graph/MANIFEST.json",
  ]) {
    const text = fs.readFileSync(path.join(SKILLS_ROOT, relative), "utf8");
    assert.doesNotMatch(text, /engineering[_-]intelligence/i, `${relative} must remain opaque to RIA evidence`);
  }
  const runtime = require("../shared/orchestration-runtime/runtime-store.js");
  assert.deepEqual(runtime.DEFAULT_STAGE_SUPPORTING_ARTIFACT_REQUIREMENTS.ASSESS, []);
  assert.deepEqual(runtime.DEFAULT_STAGE_RETURN_PROJECTIONS.ASSESS, {
    owner: "repository-improvement-assessment",
    kind: "assessment",
    projection_class: "assessment",
    predecessor_class: null,
  });
});

test("RIA and its three owners document one opaque evidence ref without transferring authority", () => {
  const read = (relative) => fs.readFileSync(path.join(SKILLS_ROOT, relative), "utf8");
  const ria = read("repository-improvement-assessment/SKILL.md");
  const health = read("repository-health-assessment/SKILL.md");
  const integrity = read("codebase-integrity-audit-loop/PARALLEL-REPORT.md");
  const architecture = read("architecture-improvement-intelligence/SKILL.md");
  const topology = read("human-directed-swarm-planner/SWARM-TYPES.md");

  assert.match(ria, /engineering_intelligence_ref/);
  assert.match(ria, /exactly three canonical owner references/i);
  assert.match(health, /engineering_intelligence_ref.*health-owned grade/i);
  assert.match(integrity, /engineering_intelligence_ref.*candidate authority/i);
  assert.match(architecture, /engineering_intelligence_ref/i);
  assert.match(architecture, /support architecture findings/i);
  assert.match(topology, /exactly three hash-bound owner references.*engineering intelligence reference/i);
});

test("direct standalone SEI runner remains usable independently of the RIA artifact path", (context) => {
  const repositoryRoot = temporaryDirectory(context, "ria-direct-sei-");
  const outputRoot = path.join(repositoryRoot, "out");
  const configPath = path.join(repositoryRoot, "sei-config.json");
  const run = (args) => {
    const result = childProcess.spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", windowsHide: true, shell: false });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  run(["init", "--quiet"]);
  run(["config", "user.email", "ria-test@example.test"]);
  run(["config", "user.name", "RIA Test"]);
  fs.writeFileSync(path.join(repositoryRoot, "index.js"), "export const answer = 42;\n", "utf8");
  run(["add", "index.js"]);
  run(["commit", "--quiet", "-m", "seed"]);
  fs.writeFileSync(configPath, `${JSON.stringify({ generated_path_patterns: [] })}\n`, "utf8");

  const runner = path.join(SKILLS_ROOT, "software-engineering-intelligence", "scripts", "run-sei.js");
  const result = childProcess.spawnSync(process.execPath, [runner, "--repo", repositoryRoot, "--out", outputRoot, "--config", configPath], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.ok(fs.existsSync(receipt.snapshot_path));
  assert.ok(fs.existsSync(receipt.report_path));
  assert.ok(!fs.existsSync(path.join(repositoryRoot, ".autonomous-loop", "assessment-artifacts", "engineering-intelligence")));
  assert.ok(!fs.existsSync(path.join(repositoryRoot, ".project-intelligence", "evidence", "engineering-intelligence")));
});
