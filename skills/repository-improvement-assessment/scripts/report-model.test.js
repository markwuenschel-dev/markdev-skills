"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const child = require("node:child_process");
const { buildReportData, compositeAnalytics, deriveRouting, assertNoCrossOwnerDuplicates, readJson, reviewProofBasisCounts } = require("./report-model.js");
const { unavailablePerformanceReceipt } = require("./performance-receipt.js");

const root = path.resolve(__dirname, "..");
const skills = path.resolve(root, "..");
const revision = "abc1234";
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ria-report-model-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const healthPath = path.join(skills, "repository-health-assessment", "assets", "canonical-island.json");
  const integrityPath = path.join(skills, "shared", "candidate-ledger-spine", "canonical-ledger.json");
  const architecture = JSON.parse(fs.readFileSync(path.join(skills, "architecture-improvement-intelligence", "assets", "architecture-candidate-set.example.json"), "utf8"));
  architecture.repository_revision = revision;
  const architecturePath = path.join(temp, "architecture.json");
  fs.writeFileSync(architecturePath, JSON.stringify(architecture, null, 2) + "\n");
  const request = {
    repository: { name: "fixture-repo", revision }, mode: "read-only",
    baseline_ref: { artifact_id: "baseline:fixture-real-hash", sha256: digest(healthPath), repository_revision: revision },
    assessment_refs: [
      { owner: "repository-health-assessment", artifact_id: `health-assessment:${digest(healthPath)}`, sha256: digest(healthPath), repository_revision: revision },
      { owner: "codebase-integrity-audit-loop", artifact_id: `integrity-ledger:${digest(integrityPath)}`, sha256: digest(integrityPath), repository_revision: revision },
      { owner: "architecture-improvement-intelligence", artifact_id: `architecture-assessment:${digest(architecturePath)}`, sha256: digest(architecturePath), repository_revision: revision },
    ],
    report_election: { schema_version: 1, policy: "generate", lean: "generate", reason: "fixture report test", state: "elected-generate", report_owner: null },
    performance_receipt: unavailablePerformanceReceipt("fixture-run", "NO_EXECUTOR_TELEMETRY"),
  };
  return { temp, request, healthFile: readJson(healthPath, "health"), integrityFile: readJson(integrityPath, "integrity"), architectureFile: readJson(architecturePath, "architecture") };
}

test("a testing-fitness sidecar is informational and never substitutes the Health verification lane", (t) => {
  const f = fixture(t);
  const baseline = buildReportData({ ...f, skillRoot: root, fixture: true });
  const testingPath = path.join(f.temp, "testing.json");
  fs.writeFileSync(testingPath, JSON.stringify({ schema_version: "ria.testing-fitness@1", score: 100, grade: "A+", rubric_coverage: 1, evidence_confidence: 1 }));
  const request = { ...f.request, testing_fitness_ref: { kind: "testing-fitness", sha256: digest(testingPath), path: testingPath } };
  const withSidecar = buildReportData({ ...f, request, testingFitnessFile: readJson(testingPath, "testing-fitness"), skillRoot: root, fixture: true });
  const dim = (data) => data.analytics.composite.dimensions.find((row) => row.id === "verification-readiness");
  assert.equal(dim(withSidecar).source, "repository-health-assessment");
  assert.equal(dim(withSidecar).score, dim(baseline).score);
  assert.equal(withSidecar.analytics.composite.final_score, baseline.analytics.composite.final_score);
  assert.equal(withSidecar.analytics.composite.testing_informational.score, 100);
  assert.equal(withSidecar.provenance.testing_fitness_substituted, false);
  assert.deepEqual(withSidecar.specialist_bindings.map((row) => row.kind), ["testing-fitness"]);
});

test("an evidence-recon specialist ref is hash-bound and listed, never scored", (t) => {
  const f = fixture(t);
  const sidecarPath = path.join(f.temp, "evidence-recon.json");
  const packetId = `RHA-ER:sha256:${"d".repeat(64)}`;
  fs.writeFileSync(sidecarPath, JSON.stringify({ evidence_packet_version: 1, packet_id: packetId, producer: { skill: "repository-health-assessment" } }));
  const request = { ...f.request, evidence_recon_ref: { kind: "evidence-recon", sha256: digest(sidecarPath), repository_revision: revision, packet_id: packetId, path: sidecarPath } };
  const data = buildReportData({ ...f, request, evidenceReconFile: readJson(sidecarPath, "evidence-recon"), skillRoot: root, fixture: true });
  assert.deepEqual(data.specialist_bindings.map((row) => row.kind), ["evidence-recon"]);
  assert.equal(data.provenance.evidence_recon_hash_verified, true);
  const tampered = { ...request, evidence_recon_ref: { ...request.evidence_recon_ref, sha256: "0".repeat(64) } };
  assert.throws(() => buildReportData({ ...f, request: tampered, evidenceReconFile: readJson(sidecarPath, "evidence-recon"), skillRoot: root, fixture: true }), /EVIDENCE_RECON_SHA256_MISMATCH/);
});

function evidenceReconCase(t, producerExtra, notes = []) {
  const f = fixture(t);
  const sidecarPath = path.join(f.temp, "evidence-recon.json");
  const packetId = `RHA-ER:sha256:${"e".repeat(64)}`;
  fs.writeFileSync(sidecarPath, JSON.stringify({ evidence_packet_version: 1, packet_id: packetId, producer: { skill: "repository-health-assessment", ...producerExtra }, handoff: { consumer_notes: notes } }));
  const request = { ...f.request, evidence_recon_ref: { kind: "evidence-recon", sha256: digest(sidecarPath), repository_revision: revision, packet_id: packetId, path: sidecarPath } };
  return () => buildReportData({ ...f, request, evidenceReconFile: readJson(sidecarPath, "evidence-recon"), skillRoot: root, fixture: true });
}
const healthSha = () => digest(path.join(skills, "repository-health-assessment", "assets", "canonical-island.json"));

test("evidence-recon: a structured health-artifact ref matching the bound Health artifact is recorded as bound", (t) => {
  const sha = healthSha();
  const data = evidenceReconCase(t, { artifact_refs: [{ kind: "health-artifact", artifact_id: `health-assessment:${sha}`, sha256: sha }] }, [`health_artifact_ref artifact_id=health-assessment:${sha} sha256=${sha}`])();
  assert.equal(data.provenance.evidence_recon_hash_verified, true);
  assert.equal(data.provenance.evidence_recon_artifact_bound, true);
});

test("evidence-recon: a structured health-artifact ref naming another Health artifact throws", (t) => {
  const build = evidenceReconCase(t, { artifact_refs: [{ kind: "health-artifact", artifact_id: `health-assessment:${"f".repeat(64)}`, sha256: "f".repeat(64) }] });
  assert.throws(build, /EVIDENCE_RECON_HEALTH_ARTIFACT_MISMATCH/);
  const sha = healthSha();
  const duplicate = evidenceReconCase(t, { artifact_refs: [{ kind: "health-artifact", artifact_id: "a", sha256: sha }, { kind: "health-artifact", artifact_id: "b", sha256: sha }] });
  assert.throws(duplicate, /EVIDENCE_RECON_HEALTH_ARTIFACT_REF_DUPLICATE/);
});

test("evidence-recon: a legacy note-only sidecar is accepted and recorded as not artifact-bound", (t) => {
  const sha = healthSha();
  const data = evidenceReconCase(t, {}, [`health_artifact_ref artifact_id=health-assessment:${sha} sha256=${sha}`])();
  assert.equal(data.provenance.evidence_recon_hash_verified, true);
  assert.equal(data.provenance.evidence_recon_artifact_bound, false);
  const none = buildReportData({ ...fixture(t), skillRoot: root, fixture: true });
  assert.equal(none.provenance.evidence_recon_artifact_bound, false);
});

test("review proof basis counts split mechanical from judged review claims, display only", () => {
  assert.equal(reviewProofBasisCounts([{ claim_id: "c1" }]), null);
  assert.deepEqual(
    reviewProofBasisCounts([
      { claim_id: "a", review_source: { proof_basis: "mechanical" } },
      { claim_id: "b", review_source: { proof_basis: "judgment" } },
      { claim_id: "c", review_source: { proof_basis: "judgment" } },
      { claim_id: "d" },
    ]),
    { review_claims: 3, mechanical: 1, judgment: 2, treatment: "display only; never changes a score" },
  );
});

const lane = (id, score, extra = {}) => ({ id, score, grade: "C", critical: false, criticality_weight: 4, ...extra });
const gradedHealth = (extra = {}) => ({
  weighted_coverage: 90, confidence_index: 80, caps: [], not_gradable: false, not_gradable_reason: null,
  lanes: ["correctness-and-integrity", "architecture-fitness", "contracts-and-integration", "verification-readiness", "build-and-delivery", "maintainability-and-ownership"].map((id) => lane(id, 70)),
  ...extra,
});

test("a Not gradable Health propagates: the composite carries no score or letter, with reason", () => {
  const composite = compositeAnalytics(gradedHealth({ not_gradable: true, not_gradable_reason: "core surface not inspected: src (uninspected)" }), { fitness: null }, null);
  assert.equal(composite.not_gradable, true);
  assert.equal(composite.final_grade, "Not gradable");
  assert.equal(composite.final_score, null);
  assert.equal(composite.raw_grade, null);
  assert.match(composite.reason, /core surface not inspected: src/);
  const graded = compositeAnalytics(gradedHealth(), { fitness: null }, null);
  assert.equal(graded.not_gradable, false);
  assert.equal(graded.final_score, 70);
});

test("critical optional Health lanes are rendered explicitly and add no RIA weight", () => {
  const health = gradedHealth();
  health.lanes.push(lane("security-and-production-safety", 20, { critical: true, criticality_weight: 5 }));
  const composite = compositeAnalytics(health, { fitness: null }, null);
  assert.deepEqual(composite.optional_critical_lanes.map((row) => [row.id, row.score]), [["security-and-production-safety", 20]]);
  assert.equal(composite.dimensions.length, 6);
  assert.equal(composite.final_score, 70);
});

test("Health candidates route by recommended_action and execution_mode, not only status", () => {
  const health = { candidates: [
    { candidate_id: "health:a", recommended_action: "design", execution_mode: "sequential", status: "ready" },
    { candidate_id: "health:b", recommended_action: "prototype", execution_mode: "swarm", status: "ready" },
    { candidate_id: "health:c", recommended_action: "direct-fix", execution_mode: "sequential", status: "ready" },
    { candidate_id: "health:d", recommended_action: "fitness-check", execution_mode: "connected-impact-sweep", status: "blocked" },
    { candidate_id: "health:e", recommended_action: "triage", execution_mode: "sequential", status: "ready" },
    { candidate_id: "health:f", recommended_action: "design", execution_mode: "blocked-needs-human-decision", status: "needs-human-decision" },
    { candidate_id: "health:g", recommended_action: "reject", execution_mode: "sequential", status: "rejected" },
  ] };
  const integrity = { candidates: [
    { candidate_id: "integrity:x", execution_mode: "sequential", status: "ready" },
    { candidate_id: "integrity:y", execution_mode: "blocked-needs-human-decision", status: "needs-human-decision" },
  ] };
  const routing = deriveRouting({}, health, integrity, { candidates: [{ candidate_id: "architecture:p", disposition: "needs_prototype" }] });
  assert.deepEqual(routing.to_architecture, ["health:a", "health:b"]);
  assert.deepEqual(routing.to_integrity, ["health:c", "health:d", "health:e"]);
  assert.deepEqual(routing.decision_queue, ["integrity:y", "health:f"]);
  assert.deepEqual(routing.ready, ["integrity:x"]);
  assert.deepEqual(routing.needs_prototype, ["architecture:p"]);
  assert.equal(Object.values(routing).flat().includes("health:g"), false);
});

test("a candidate_id minted independently by two owners is rejected; an adopted upstream id is not", () => {
  assert.throws(() => assertNoCrossOwnerDuplicates({ candidates: [{ candidate_id: "C-1", title: "Flaky retry" }] }, { candidates: [{ candidate_id: "C-1", title: "Stale schema" }] }, { candidates: [] }), /CANDIDATE_ID_CROSS_OWNER_DUPLICATE:C-1/);
  // namespaced to an owner holding it: adopted (integrity adopting a health row)
  assert.doesNotThrow(() => assertNoCrossOwnerDuplicates({ candidates: [{ candidate_id: "health:C-1", title: "Flaky retry" }] }, { candidates: [{ candidate_id: "health:C-1", title: "Flaky retry (adopted)" }] }, { candidates: [] }));
  // namespaced to an owner that holds neither copy: collision
  assert.throws(() => assertNoCrossOwnerDuplicates({ candidates: [{ candidate_id: "architecture:Q", title: "A" }] }, { candidates: [{ candidate_id: "architecture:Q", title: "B" }] }, { candidates: [] }), /CANDIDATE_ID_CROSS_OWNER_DUPLICATE/);
  // legacy unprefixed id carried with the identical row: adopted
  assert.doesNotThrow(() => assertNoCrossOwnerDuplicates({ candidates: [{ candidate_id: "CONTRACT-007", title: "Duplicated API schema definitions" }] }, { candidates: [{ candidate_id: "CONTRACT-007", title: "Duplicated API schema definitions" }] }, { candidates: [] }));
});

test("build-report renders a Not gradable composite instead of failing the sufficiency gate", (t) => {
  const f = fixture(t);
  const data = buildReportData({ ...f, skillRoot: root, fixture: true });
  data.analytics.composite = { ...data.analytics.composite, raw_score: null, raw_grade: null, final_score: null, final_grade: "Not gradable", binding_cap: null, not_gradable: true, reason: "Repository Health is Not gradable: weighted coverage 30% is below the 40% gradability floor" };
  const input = path.join(f.temp, "data.json");
  const output = path.join(f.temp, "report.html");
  fs.writeFileSync(input, JSON.stringify(data));
  child.execFileSync(process.execPath, [path.join(root, "scripts", "build-report.js"), "--input", input, "--output", output], { stdio: "pipe" });
  const html = fs.readFileSync(output, "utf8");
  assert.match(html, /Not gradable/);
  assert.match(html, /below the 40% gradability floor/);
});

test("build-report displays mechanical vs judged review-claim counts and the evidence-recon binding flag", (t) => {
  const f = fixture(t);
  const data = buildReportData({ ...f, skillRoot: root, fixture: true });
  data.analytics.health = { ...data.analytics.health, review_proof_basis: { review_claims: 5, mechanical: 3, judgment: 2, treatment: "display only; never changes a score" } };
  const input = path.join(f.temp, "data.json");
  const output = path.join(f.temp, "report.html");
  fs.writeFileSync(input, JSON.stringify(data));
  child.execFileSync(process.execPath, [path.join(root, "scripts", "build-report.js"), "--input", input, "--output", output], { stdio: "pipe" });
  const html = fs.readFileSync(output, "utf8");
  assert.match(html, /review-sourced Health claims: 3 mechanical · 2 judged/);
  assert.match(html, /evidence_recon_artifact_bound/);
});
