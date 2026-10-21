"use strict";

// Phase 9: the Appendix A evidence-grounded fixture end to end (composite-scoring-v3 §12
// tests 10-14, 19, 20, 25-28 through their real boundary). The fixture repository is built,
// ria.js runs to the owner rendezvous, the three owner artifacts are written by the canonical
// writers from an assessment of the fixture itself, and `continue` renders the report. Valid
// variants are separate fixture runs; corruption probes alter bytes of a finished run.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { appendixARun, requestFor, runRia } = require("./test-support/appendix-a-run.js");
const { compositeV2Analytics, v2ContextFromEnvelope } = require("./composite-v2-model.js");
const { loadPresentationPolicy, loadScoringConfig } = require("../../shared/ria-scoring/composite-v2-config.js");
const { resolveArchitectureEvidence, bindingFromEnvelope } = require("../../architecture-improvement-intelligence/assets/architecture-evidence-binding.js");

const OWNERS = Object.freeze({ health: "repository-health-assessment", integrity: "codebase-integrity-audit-loop", architecture: "architecture-improvement-intelligence" });
const HV = (() => { require("../../repository-health-assessment/assets/health-verify.js"); return globalThis.HealthVerify; })();

const runs = {};
function baseline() { return (runs.baseline ??= appendixARun()); }
function reportData(run) { return JSON.parse(fs.readFileSync(run.second.result.execution.task_results["report-data"].path, "utf8")); }
function shadow(run) { return reportData(run).analytics.composite_v2; }
function dimension(v2, id) { return v2.dimensions.find((item) => item.id === id); }
function contribution(v2, id, owner) { return dimension(v2, id).contributions.find((item) => item.owner === owner); }
function ownerArtifact(run, owner) { return JSON.parse(fs.readFileSync(run.second.result.execution.task_results["owner-artifact-verification"].owner_artifacts[OWNERS[owner]].artifact_path, "utf8")); }
function envelope(run) { return JSON.parse(fs.readFileSync(run.rendezvous.envelopes[OWNERS.architecture], "utf8")); }
function gitShow(run, file) { return childProcess.execFileSync("git", ["-C", run.root, "show", `${run.revision}:${file}`], { encoding: "utf8" }); }
function lineCount(text) { return text.split("\n").length - (text.endsWith("\n") ? 1 : 0); }
/** The binder over the run's bound artifacts, optionally with edited copies (the normalized-input harness). */
function bind(run, { health = ownerArtifact(run, "health"), integrity = ownerArtifact(run, "integrity"), architecture = ownerArtifact(run, "architecture"), policy, runState, omit = null } = {}) {
  const env = envelope(run);
  const context = v2ContextFromEnvelope({ envelope: env, repositoryRoot: run.root, architectureArtifact: architecture ?? ownerArtifact(run, "architecture"), allowedRoots: [path.join(run.root, ".project-intelligence")] });
  return compositeV2Analytics({
    ...(policy ? { policy } : {}),
    health: omit === "health" ? { raw: null } : { raw: health, verified: HV.verifyHealth(health) },
    integrity: { raw: omit === "integrity" ? null : integrity },
    architecture: omit === "architecture" ? { raw: null } : { raw: architecture, receipt: context.architecture_evidence },
    sei: context.sei, verification: context.verification, binding: bindingFromEnvelope(env), sources: context.sources, receipts: context.receipts,
    run: runState ?? { failed_tasks: [], allow_degraded: false },
  });
}
function decision(v2) {
  return {
    point: v2.point, bounds: v2.bounds, status: v2.status, confidence: v2.confidence, caps: v2.caps, influence: v2.influence,
    verdicts: v2.dimensions.map((d) => [d.id, d.verdict, d.point, d.lower, d.upper, d.confidence, d.contributions.map((c) => [c.owner, c.state, c.score])]),
    defects: v2.canonical_defects.map((group) => group.group_id),
  };
}

test("§12 test 20: owner evidence matches the fixture and each planted defect appears exactly once", () => {
  const run = baseline();
  assert.equal(run.second.status, 0, run.second.stderr);
  assert.equal(run.second.result.status, "complete");
  const health = ownerArtifact(run, "health");
  for (const claim of health.claims) for (const item of claim.evidence) {
    if (!item.path) continue;
    const text = gitShow(run, item.path);
    const [start, end] = item.lines.split("-").map(Number);
    assert.ok(start >= 1 && end <= lineCount(text), `${claim.claim_id} cites ${item.path}:${item.lines} within ${lineCount(text)} lines`);
  }
  for (const row of ownerArtifact(run, "integrity").candidates) for (const item of row.evidence) assert.ok(item.line <= lineCount(gitShow(run, item.file)), `${row.candidate_id} ${item.file}:${item.line}`);
  const v2 = shadow(run);
  const receipt = run.second.result.execution.task_results["owner-artifact-verification"].architecture_evidence;
  assert.deepEqual(receipt.withheld, []);
  assert.ok(receipt.dimensions.dependency_direction_cycle_control.facts.some((fact) => fact.path === "src/a.js") && receipt.dimensions.dependency_direction_cycle_control.facts.some((fact) => fact.path === "src/b.js"), "the cycle claim resolves to both files");
  const groups = v2.canonical_defects;
  assert.equal(groups.length, 3, JSON.stringify(groups));
  const byDimension = Object.fromEntries(groups.map((group) => [group.dimension, group]));
  assert.deepEqual(byDimension.correctness.members, ["integrity/integrity:CORR-001"]);
  assert.equal(byDimension.correctness.evidentiary_state, "reproduced");
  assert.deepEqual(byDimension.security.members, ["integrity/integrity:SEC-001"]);
  assert.equal(byDimension.security.evidentiary_state, "reproduced");
  assert.equal(byDimension.security.severity, 4);
  assert.deepEqual(byDimension.contracts.members, ["health/CONTRACT-001", "integrity/CONTRACT-001"], "contract drift is one canonical group");
  // The cycle lowers every architecture contribution; SEI measured it independently.
  assert.ok(contribution(v2, "architecture", "sei").score < 50, `SEI architecture ${contribution(v2, "architecture", "sei").score}`);
  assert.equal(contribution(v2, "architecture", "architecture").state, "scored");
  assert.notEqual(v2.status, "final", "not final unless every applicable dimension scores");
  assert.ok(v2.dimensions.some((d) => d.verdict !== "scored" && d.verdict !== "not_applicable"));
  for (const owner of ["health", "architecture", "integrity", "sei"]) assert.ok(v2.influence.effective[owner] > 0, owner);
});

test("the security group fires confirmed-critical-failure (confirmed, severity 4, critical, uncontained)", () => {
  const v2 = shadow(baseline());
  const group = v2.canonical_defects.find((item) => item.dimension === "security");
  const cap = v2.caps.find((item) => item.cap_id === "confirmed-critical-failure");
  assert.ok(cap, JSON.stringify(v2.caps));
  assert.equal(cap.trigger, group.group_id);
  assert.equal(cap.ceiling, 66.9);
  // Recorded outcome: the point is already below D, so the cap fires without binding.
  assert.equal(cap.binding, v2.point.raw_score > 66.9);
});

test("§12 tests 13-14: the shared contract defect counts once, and Integrity's adopted copy is dependent", () => {
  const v2 = shadow(baseline());
  const contracts = contribution(v2, "contracts", "integrity");
  assert.equal(contracts.score, 75, "one severity-3 group: the severity-3 ceiling, no second-group step");
  assert.equal(contracts.state, "dependent");
  assert.ok(contracts.origin_refs.includes("health"), JSON.stringify(contracts.origin_refs));
  assert.equal(v2.caps.filter((cap) => cap.trigger.endsWith(":contracts")).length, 0, "severity 3 never caps, and the group is not counted twice");
});

test("§12 test 10 / variant (d): workflow status changes leave the decision projection unchanged", () => {
  const run = baseline();
  const before = decision(bind(run).composite);
  const integrity = ownerArtifact(run, "integrity");
  for (const row of integrity.candidates) { row.status = "blocked"; row.rollup.execution_mode = "blocked-needs-human-decision"; if (row.candidate_lifecycle) row.candidate_lifecycle.lifecycle_status = "completed"; }
  const health = ownerArtifact(run, "health");
  for (const row of health.candidates) { row.status = "completed"; row.candidate_lifecycle.lifecycle_status = "completed"; }
  assert.deepEqual(decision(bind(run, { integrity, health }).composite), before);
  // D9 does not license invalid raw workflow envelopes: the spine verifier still rejects them.
  require("../../shared/candidate-ledger-spine/ledger-verify.js");
  const invalid = ownerArtifact(run, "integrity"); invalid.candidates[0].status = "bogus-status";
  assert.equal(globalThis.LedgerVerify.verifyLedger(invalid).ok, false);
});

test("§12 test 26: duplicate citations cannot inflate Architecture's independence", () => {
  const run = baseline();
  const architecture = ownerArtifact(run, "architecture");
  const before = bind(run).input.dimensions.architecture.contributions.architecture.dependence;
  for (const dimension of Object.values(architecture.architecture_fitness.dimensions)) dimension.evidence_refs = [...dimension.evidence_refs, ...dimension.evidence_refs];
  assert.deepEqual(bind(run, { architecture }).input.dimensions.architecture.contributions.architecture.dependence, before);
});

test("§12 test 25: a failing reproduction is not containment", () => {
  const run = baseline();
  const integrity = ownerArtifact(run, "integrity");
  const security = integrity.candidates.find((row) => row.candidate_id === "integrity:SEC-001");
  const repro = security.ria_proof.proofs[0];
  security.ria_proof.containment = { kind: "prevention-check", check_id: repro.check_id, receipt_sha256: repro.receipt_sha256, outcome: "fail", predicate_id: repro.predicate_id };
  const out = bind(run, { integrity }).composite;
  assert.ok(out.caps.some((cap) => cap.cap_id === "confirmed-critical-failure"), "an uncontained critical failure still caps");
  // Relabelling the reproduction's receipt as a passing check is not containment (review 2026-10-16).
  security.ria_proof.containment = { ...security.ria_proof.containment, outcome: "pass" };
  assert.ok(bind(run, { integrity }).composite.caps.some((cap) => cap.cap_id === "confirmed-critical-failure"), "a reproduction receipt cannot be passed off as a prevention check");
  // Positive control: a stored, passing prevention-check receipt for the same predicate contains it.
  const bytes = Buffer.from(JSON.stringify({ schema_version: "ria.proof-receipt@1", kind: "prevention-check", binding: repro.binding, predicate_id: repro.predicate_id, check_id: "guard-test", outcome: "pass" }));
  const digest = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const store = path.join(run.root, ".project-intelligence", "assessments", "integrity", "receipts");
  fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(path.join(store, `${digest}.json`), bytes);
  security.ria_proof.containment = { kind: "prevention-check", check_id: "guard-test", receipt_sha256: digest, outcome: "pass", predicate_id: repro.predicate_id, binding: repro.binding };
  assert.ok(!bind(run, { integrity }).composite.caps.some((cap) => cap.cap_id === "confirmed-critical-failure"), "a passing guard on the predicate contains the defect");
});

test("§12 test 28: a presentation-only change preserves the scoring binding; a scoring change does not", () => {
  const run = baseline();
  const reference = bind(run).composite;
  const promoted = bind(run, { policy: loadPresentationPolicy({ policy: { schema_version: "ria.composite-v2.policy@1", reported_composite: "v2", calibration_ref: { receipt_path: "calibration/receipt.json", receipt_sha256: "e".repeat(64) } } }) }).composite;
  assert.deepEqual(promoted.config, reference.config, "config and implementation hashes are unchanged");
  assert.deepEqual(decision(promoted), decision(reference));
  assert.notEqual(promoted.presentation.policy_sha256, reference.presentation.policy_sha256);
  assert.equal(promoted.reported, false, "no verified calibration receipt: still a shadow");
  const loaded = loadScoringConfig();
  const config = structuredClone(loaded.config); config.dimensions.correctness.shares = { health: 0.34, integrity: 0.66 };
  assert.notEqual(loadScoringConfig({ config }).config_sha256, loaded.config_sha256, "a scoring change yields a new identity the calibration gate cannot match");
});

test("§12 test 27 / variant (b): tampered SEI bytes block; a metric under the wrong criterion is rejected", () => {
  const run = baseline();
  const env = envelope(run);
  const assessmentPath = env.sei_assessment_ref.artifact_path;
  const original = fs.readFileSync(assessmentPath);
  try {
    fs.writeFileSync(assessmentPath, Buffer.concat([original, Buffer.from(" ")]));
    const blocked = runRia(run.sandbox, requestFor(run.root, { lifecycle: "report-only" }), "tampered-report-only");
    assert.notEqual(blocked.result?.status, "complete");
    assert.match(JSON.stringify(blocked.result?.execution?.failures ?? blocked.stderr), /FAIL-SEI-ASSESSMENT-HASH-MISMATCH/);
  } finally { fs.writeFileSync(assessmentPath, original); }
  // A structurally valid citation to a real metric under the wrong criterion.
  const assessment = JSON.parse(original.toString("utf8"));
  const withMetric = assessment.criteria.find((item) => (item.evidence?.observations ?? []).length > 0);
  const other = assessment.criteria.find((item) => item.criterion_id !== withMetric.criterion_id && !(item.evidence?.observations ?? []).some((o) => o.observation_id === withMetric.evidence.observations[0].observation_id));
  const island = ownerArtifact(run, "health");
  delete island.grade;
  island.claims[0].evidence.push({ kind: "sei-criterion", criterion_id: other.criterion_id, metric_id: withMetric.evidence.observations[0].observation_id });
  const input = path.join(run.sandbox, "wrong-criterion-island.json"); fs.writeFileSync(input, JSON.stringify(island));
  const out = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, "..", "..", "repository-health-assessment", "assets", "write-health-artifact.js"), "--input", input, "--repo", run.root, "--ria-envelope", run.rendezvous.envelopes[OWNERS.health]], { encoding: "utf8", env: { ...process.env, ...(run.rendezvous.contract?.env ?? {}) } });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /FAIL-SEI-CITATION-INVALID[\s\S]*is not a metric of criterion/);
});

test("step 5: an identical rerun is EXACT_REUSE with a byte-identical shadow composite", () => {
  const run = baseline();
  const again = runRia(run.sandbox, requestFor(run.root), "exact-reuse");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.result.startup_resolution.startup_mode, "EXACT_REUSE");
  const rerun = JSON.parse(fs.readFileSync(again.result.execution.task_results["report-data"].path, "utf8")).analytics.composite_v2;
  assert.equal(JSON.stringify(rerun), JSON.stringify(shadow(run)));
});

test("§12 tests 11-12, 25 / variant (a): sampled-only coverage without a negative claim is never a clean 100", () => {
  const run = (runs.sampled ??= appendixARun({ variant: { integrity: { reliabilitySampledWithoutNegativeClaim: true }, mutate: { integrity: (ledger) => { for (const surface of ledger.coverage.dimensions.security.surfaces) if (surface.state === "inspected") Object.assign(surface, { state: "uninspected", evidence_quality: "none", methods: [], scope: "", evidence_refs: [] }); } } } }));
  assert.equal(run.second.result.status, "complete", run.second.stderr);
  const v2 = shadow(run);
  const reliability = contribution(v2, "reliability", "integrity");
  assert.equal(reliability.state, "insufficient_evidence");
  assert.equal(reliability.score, null);
  // Correctness inspected runtime-code; security inspected nothing, so it has zero coverage.
  const security = contribution(v2, "security", "integrity");
  assert.equal(security.state, "insufficient_evidence");
  assert.match(security.limitations.join(" "), /coverage 0 is below/);
  assert.equal(contribution(v2, "correctness", "integrity").state, "scored");
  // Insufficient coverage cannot hide the admissible critical failure.
  assert.ok(v2.caps.some((cap) => cap.cap_id === "confirmed-critical-failure"), JSON.stringify(v2.caps));
});

test("§12 test 19 / variant (e): a failed Architecture owner degrades the run, never final", () => {
  const run = (runs.archFailed ??= appendixARun({ variant: { architectureFails: true } }));
  assert.notEqual(run.second.result.status, "complete");
  assert.equal(run.second.result.report, null, "no complete ASSESS projection, so no report");
  const base = baseline();
  for (const allow of [false, true]) {
    const out = bind(base, { omit: "architecture", runState: { failed_tasks: ["owner:architecture-improvement-intelligence"], allow_degraded: allow } }).composite;
    assert.equal(out.run_state, "degraded");
    assert.notEqual(out.status, "final");
    for (const id of ["architecture", "contracts", "verification", "maintainability"]) assert.equal(contribution(out, id, "architecture").state, "failed", id);
    if (allow) assert.ok(out.status_reasons.some((reason) => reason.startsWith("allow_degraded")));
  }
});
