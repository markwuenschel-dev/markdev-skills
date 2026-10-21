"use strict";
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { writeEngineeringIntelligenceArtifact } = require("../../engineering-intelligence-writer.js");
const { canonicalBytes } = require("../../engineering-intelligence.js");
const { materializeSnapshot } = require("../../../shared/software-engineering-intelligence/intelligence-engine.js");
const { assessRepositoryEngineering } = require("../../../shared/software-engineering-intelligence/engineering-assessment.js");
const { createVerificationBaseline, writeVerificationBaseline } = require("../../../shared/assessment-verification-baseline/verification-baseline.js");
const { createOwnerReturn } = require("../../../shared/ria-owner-return/owner-return.js");
const { buildReportData, readJson } = require("../report-model.js");
const { unavailablePerformanceReceipt } = require("../performance-receipt.js");
const { architectureRiaInput } = require("./architecture-ria-fixture.js");
const { v2ContextFromRun } = require("../composite-v2-model.js");

const skillsRoot = path.resolve(__dirname, "..", "..", "..");
const riaRoot = path.resolve(__dirname, "..", "..");
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function atomicJson(filePath, value) { const target = path.resolve(filePath); fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`; try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); fs.renameSync(temporary, target); } finally { try { fs.rmSync(temporary, { force: true }); } catch {} } return target; }
function invoke(script, args, runtimeRoot = null) { return JSON.parse(childProcess.execFileSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true, ...(runtimeRoot ? { env: { ...process.env, RIA_RUNTIME_ROOT: runtimeRoot } } : {}) })); }
function stableScope(baseline) { return sha256(JSON.stringify({ repository_id: baseline.repository.repository_id, revision: baseline.repository.revision, roots: baseline.repository.roots.map((root) => root.repository_key) })); }
function rendezvous(required, name) {
  let entrants = 0;
  let release;
  let fallback;
  const opened = new Promise((resolve) => { release = resolve; });
  const generation = `${name}:${crypto.randomUUID()}`;
  return async (participant) => {
    const entered_at = new Date().toISOString();
    entrants += 1;
    if (entrants === 1) fallback = setTimeout(release, 50);
    if (entrants >= required) { clearTimeout(fallback); release(); }
    await opened;
    return { generation, participant, entered_at, released_at: new Date().toISOString() };
  };
}
// Fixed stock measurements so the SEI assessment scores several dimensions and SEI takes part
// in composite v2 (composite-scoring-v3 Phase 8: four owners in effective influence). Each
// record is SEI's own canonical measurement template with the metric id, value and revision
// replaced; the values are fixture constants, not observations of the repository.
const STOCK_SEI_METRICS = Object.freeze([
  ["static.cyclomatic_complexity_p90", 3], ["static.cyclomatic_complexity_max", 6], ["static.duplication.observed_percentage", 0.01], ["static.duplication.large_clone_family_count", 0],
  ["verification.tests_total", 1], ["verification.tests_passed", 1], ["verification.statement_coverage", 0.82], ["discovery.ci_evidence_path_count", 1], ["discovery.test_evidence_path_count", 1],
  ["security.secret_findings", 0], ["documentation.overview_present", 1],
  ["dependency.node_count", 3], ["dependency.cyclic_node_count", 0], ["dependency.cyclic_scc_count", 0], ["dependency.centrality", 0.3], ["dependency.instability", 0.5], ["dependency.fan_in", 1],
  ["git.observed_text_churn", 40], ["git.change_frequency", 2], ["git.observed_touch_ownership_concentration", 0.6], ["git.observed_co_change_pair_count", 1],
]);
function stockMeasurements(revision, config) {
  const canonicalSnapshot = JSON.parse(fs.readFileSync(path.join(skillsRoot, "shared", "software-engineering-intelligence", "canonical-intelligence.json"), "utf8"));
  const template = (canonicalSnapshot.engineering_intelligence ?? canonicalSnapshot).measurements[0];
  return { collectors: (canonicalSnapshot.engineering_intelligence ?? canonicalSnapshot).collectors, measurements: STOCK_SEI_METRICS.map(([metric_id, value]) => ({ ...structuredClone(template), metric_id, definition_id: `sei.${metric_id}@1`, value, repository_revision: revision, source: { ...template.source, repository_revision: revision, command: "ria-stock-adapter fixture measurement" }, window: { ...template.window, end: revision }, comparability: { ...template.comparability, configuration_hash: config } })) };
}
function minimalSnapshot(baseline) {
  const revision = baseline.repository.revision;
  const config = baseline.sei_compatibility_binding.config_hash;
  const historyBoundary = { kind: "revision-range", start: null, end: revision };
  const { collectors, measurements } = stockMeasurements(revision, config);
  return materializeSnapshot({
    schema_version: "1.0.0",
    snapshot_id: "pending",
    repository: { repository_id: baseline.repository.repository_id, revision, configuration_hash: config, history_boundary: historyBoundary, generated_path_patterns: [] },
    collectors, measurements, risk_models: [], profiles: [],
    evidence_summary: { measurement_count: measurements.length, status_counts: { measured: measurements.length, inferred: 0, unavailable: 0, "not-applicable": 0, unverifiable: 0 } },
    run_metadata: { generated_at: "2026-08-30T00:00:00.000Z", cache: { cache_key: sha256(JSON.stringify({ revision, config })), repository_revision: revision, configuration_hash: config, schema_version: "1.0.0", collector_versions: collectors.map((item) => `${item.collector_id}@${item.collector_version}`), history_boundary: historyBoundary } },
  });
}
function writeEiWithRetry(input) {
  let last;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try { return writeEngineeringIntelligenceArtifact(input); }
    catch (error) {
      last = error;
      if (!String(error.message).includes("INDEX-LOCKED")) throw error;
      const until = Date.now() + 8; while (Date.now() < until) { /* bounded contention backoff */ }
    }
  }
  throw last;
}
function assessmentRef(assessment, artifactPath) {
  const bytes = fs.readFileSync(artifactPath);
  return {
    schema_version: assessment.schema_version,
    assessment_id: assessment.assessment_id,
    snapshot_binding: { snapshot_id: assessment.snapshot_binding.snapshot_id, revision: assessment.snapshot_binding.repository_revision, repository_id: assessment.snapshot_binding.repository_id, digest: assessment.snapshot_binding.configuration_hash },
    evaluator: { id: assessment.evaluator.evaluator_id, version: assessment.evaluator.version },
    rubric: { id: assessment.rubric.rubric_id, version: assessment.rubric.version, digest: assessment.rubric.digest },
    standard: { id: assessment.standard.standard_id, version: assessment.standard.version, digest: assessment.standard.digest },
    config_digest: assessment.snapshot_binding.configuration_hash,
    applicability_digest: assessment.applicability.digest,
    artifact_path: artifactPath,
    artifact_sha256: sha256(bytes),
  };
}
function canonicalOwnerInput(owner, revision, runDirectory, envelope, repositoryRoot = null, degraded = false) {
  if (owner === "repository-health-assessment") {
    const source = fs.readFileSync(path.join(skillsRoot, owner, "assets", "canonical-island.json"), "utf8");
    const target = path.join(runDirectory, "owner-inputs", "health.json");
    atomicJson(target, JSON.parse(source.replaceAll("abc1234", revision)));
    return { script: path.join(skillsRoot, owner, "assets", "write-health-artifact.js"), target };
  }
  if (owner === "codebase-integrity-audit-loop") {
    // RIA mode requires integrity.coverage@2 and bound proof on minted rows (composite-scoring-v3 §7.1, §6.4).
    const source = fs.readFileSync(path.join(skillsRoot, owner, "assets", "canonical-ria-ledger.json"), "utf8");
    const target = path.join(runDirectory, "owner-inputs", "integrity.json");
    atomicJson(target, JSON.parse(source.replaceAll("abc1234", revision).replaceAll("__RIA_BASELINE_ARTIFACT_ID__", envelope?.baseline_ref?.artifact_id ?? "baseline:unbound")));
    return { script: path.join(skillsRoot, owner, "assets", "write-ledger.js"), target };
  }
  // RIA mode binds every scored fitness dimension to packet claims (architecture.evidence-binding@1).
  // Degraded mode has no repository workspace for the packet, so it keeps the unbound example.
  let source;
  if (envelope && repositoryRoot && !degraded) source = architectureRiaInput(repositoryRoot, envelope).input;
  else { source = JSON.parse(fs.readFileSync(path.join(skillsRoot, owner, "assets", "architecture-candidate-set.example.json"), "utf8")); source.repository_revision = revision; }
  const target = path.join(runDirectory, "owner-inputs", "architecture.json");
  atomicJson(target, source);
  return { script: path.join(skillsRoot, owner, "assets", "write-candidate-set.js"), target };
}
function ownerHandler(owner, overlap) {
  return async ({ request, baseline, run_directory, owner_envelope }) => {
    await overlap(owner);
    if (request.adapter_options?.test_fail_owner === owner) { const error = new Error(`fixture requested ${owner} failure`); error.code = "FIXTURE_OWNER_FAILURE"; throw error; }
    const envelopePath = atomicJson(path.join(run_directory, "owner-inputs", `${owner}-envelope.json`), owner_envelope());
    const input = canonicalOwnerInput(owner, baseline.repository.revision, run_directory, owner_envelope(), baseline.repository.roots[0].root, baseline.repository.mode === "content-addressed-degraded");
    if (baseline.repository.mode === "content-addressed-degraded") {
      const artifactPath = atomicJson(path.join(run_directory, "degraded-owner-artifacts", `${owner}.json`), JSON.parse(fs.readFileSync(input.target, "utf8")));
      const fileSha = sha256(fs.readFileSync(artifactPath));
      return createOwnerReturn({ owner, repository_revision: baseline.repository.revision, artifact_path: artifactPath, canonical_artifact_ref: { owner, artifact_id: `${owner}:${fileSha}`, sha256: fileSha, repository_revision: baseline.repository.revision }, input_binding_echo: owner_envelope(), warnings: ["content-addressed degraded mode: repository-local Git artifact store unavailable"] });
    }
    return invoke(input.script, ["--input", input.target, "--repo", baseline.repository.roots[0].root, "--ria-envelope", envelopePath], run_directory);
  };
}

function createAdapter(context) {
  const seiVerificationOverlap = rendezvous(2, "sei-verification");
  const ownerOverlap = rendezvous(2, "owners");
  return { handlers: {
    "sei-snapshot": async ({ baseline, baseline_ref, runtime_root }) => {
      const overlap_probe = await seiVerificationOverlap("sei-snapshot");
      const snapshot = minimalSnapshot(baseline);
      const repositoryRoot = baseline.repository.roots[0].root;
      const missionId = "ria-v0.8-stock-integration";
      const scopeHash = stableScope(baseline);
      let engineering_intelligence_ref;
      if (baseline.repository.mode === "content-addressed-degraded") {
        const artifact = { schema_version: "1.0.0", owner: "repository-improvement-assessment", kind: "engineering-intelligence", repository_revision: baseline.repository.revision, mission_id: missionId, scope_hash: scopeHash, baseline_binding: baseline_ref, engineering_intelligence: snapshot };
        const bytes = canonicalBytes(artifact);
        const digest = sha256(bytes);
        const artifactPath = path.join(runtime_root, "evidence", "engineering-intelligence", `${digest}.json`);
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        if (!fs.existsSync(artifactPath)) fs.writeFileSync(artifactPath, bytes, { flag: "wx" });
        engineering_intelligence_ref = { artifact_id: `engineering-intelligence:${digest}`, owner: "repository-improvement-assessment", kind: "engineering-intelligence", schema_version: "1.0.0", sha256: digest, repository_revision: baseline.repository.revision, mission_id: missionId, scope_hash: scopeHash, baseline_binding: baseline_ref };
      } else {
        engineering_intelligence_ref = writeEiWithRetry({ repository_root: repositoryRoot, baseline_ref, mission_id: missionId, scope_hash: scopeHash, compute_snapshot: () => snapshot });
      }
      return { engineering_intelligence_ref, snapshot, overlap_probe, result_ref: engineering_intelligence_ref, telemetry: { tool_calls: 1, tokens: 0 } };
    },
    "sei-assessment": async ({ dependencies, runtime_root, baseline }) => {
      const snapshot = dependencies["sei-snapshot"].snapshot;
      const repositoryIndex = { binding: { repository_revision: baseline.repository.revision, index_digest: `sha256:${sha256(JSON.stringify({ repository: baseline.repository.repository_id, revision: baseline.repository.revision }))}` }, entries: [], exclusions: [] };
      const assessment = assessRepositoryEngineering({ snapshot, repositoryIndex, assessmentConfig: { repository_root: baseline.repository.roots[0].root } });
      const artifactPath = atomicJson(path.join(runtime_root, "evidence", "sei-assessments", `${assessment.assessment_id.replace(":", "-")}.json`), assessment);
      const sei_assessment_ref = assessmentRef(assessment, artifactPath);
      return { assessment, sei_assessment_ref, result_ref: { artifact_id: assessment.assessment_id, sha256: sei_assessment_ref.artifact_sha256, repository_revision: baseline.repository.revision }, telemetry: { tool_calls: 1, tokens: 0 } };
    },
    "verification-baseline": async ({ request, baseline, baseline_ref, runtime_root }) => {
      const state = request.command_authorization.state;
      if (!new Set(["granted", "inherited"]).has(state)) { const error = new Error("verification command authority is not available"); error.code = "COMMAND_AUTHORIZATION_DENIED"; throw error; }
      const overlap_probe = await seiVerificationOverlap("verification-baseline");
      const started = Date.now();
      const version = childProcess.execFileSync(process.execPath, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
      const artifact = createVerificationBaseline({
        repository: { repository_id: baseline.repository.repository_id, revision: baseline.repository.revision, working_tree_fingerprint: sha256(JSON.stringify(baseline.repository.roots.map((root) => root.working_tree.fingerprint))) },
        baseline_ref,
        isolation: { mode: "read-only-source", path: baseline.repository.roots[0].root, source_repository_mutated: false },
        commands: [{ id: "node-version", command: `${process.execPath} --version`, status: "passed", exit_code: 0, duration_ms: Math.max(0, Date.now() - started), reason: null, evidence: [`node:${version}`] }],
        environment: { node: version }, coverage: { policy: "stock-integration", line:{covered:90,total:100}, branch:{covered:70,total:100}, changed_line:{covered:19,total:20} }, created_at: "2026-08-30T00:00:00.000Z",
      });
      const writer = writeVerificationBaseline(path.join(runtime_root, "verification", `${artifact.content_sha256}.json`), artifact);
      const verification_baseline_ref = { artifact_id: artifact.artifact_id, content_sha256: artifact.content_sha256, file_sha256: writer.file_sha256, sha256: writer.file_sha256, repository_revision: baseline.repository.revision, path: writer.path };
      return { artifact, writer, verification_baseline_ref, overlap_probe, result_ref: verification_baseline_ref, telemetry: { tool_calls: 1, tokens: 0 } };
    },
    "owner-health": ownerHandler("repository-health-assessment", ownerOverlap),
    "owner-integrity": ownerHandler("codebase-integrity-audit-loop", ownerOverlap),
    "owner-architecture": ownerHandler("architecture-improvement-intelligence", ownerOverlap),
    "report-data": async ({ request, baseline, dependencies, run_directory }) => {
      if (request.presentation_policy !== "generate") return { skipped: true, reason: "EXPLICIT_PRESENTATION_SKIP" };
      const projection = dependencies["assess-binding"];
      if (projection?.stage !== "ASSESS") { const error = new Error("complete ASSESS projection is required for report generation"); error.code = "REPORT_ASSESSMENT_INCOMPLETE"; throw error; }
      const ownerArtifacts = dependencies["owner-artifact-verification"].owner_artifacts;
      const reportRequest = {
        repository: { name: path.basename(baseline.repository.roots[0].root), revision: baseline.repository.revision }, mode: request.lifecycle,
        baseline_ref: projection.baseline_ref, engineering_intelligence_ref: projection.engineering_intelligence_ref, assessment_refs: projection.assessment_refs,
        report_election: { schema_version: 1, policy: "generate", lean: "generate", reason: "caller explicitly requested the combined RIA report", state: "elected-generate", report_owner: null },
        performance_receipt: unavailablePerformanceReceipt(request.run_nonce ?? "pre-presentation", "PRE_PRESENTATION_EVENT_STREAM_INCOMPLETE"),
        sei_telemetry_summary: dependencies["sei-telemetry-summary"],
        coverage_metrics: dependencies["verification-baseline"]?.artifact?.coverage ?? null,
      };
      const healthReturn = ownerArtifacts["repository-health-assessment"];
      const testingRef = Array.isArray(healthReturn?.specialist_refs) ? healthReturn.specialist_refs.find((item) => item.kind === "testing-fitness") : null;
      if (testingRef) reportRequest.testing_fitness_ref = testingRef;
      const evidenceReconRef = Array.isArray(healthReturn?.specialist_refs) ? healthReturn.specialist_refs.find((item) => item.kind === "evidence-recon") : null;
      if (evidenceReconRef) reportRequest.evidence_recon_ref = evidenceReconRef;
      const reportData = buildReportData({ request: reportRequest, healthFile: readJson(healthReturn.artifact_path, "health"), integrityFile: readJson(ownerArtifacts["codebase-integrity-audit-loop"].artifact_path, "integrity"), architectureFile: readJson(ownerArtifacts["architecture-improvement-intelligence"].artifact_path, "architecture"), testingFitnessFile: testingRef ? readJson(testingRef.path, "testing-fitness") : null, evidenceReconFile: evidenceReconRef ? readJson(evidenceReconRef.path, "evidence-recon") : null, skillRoot: riaRoot, fixture: false, v2: v2ContextFromRun({ dependencies, baseline, request }) });
      const output = atomicJson(path.join(run_directory, "report-data.json"), reportData);
      return { report_data: reportData, path: output, result_ref: { report_schema_version: 3, path: output } };
    },
    "report-render": async ({ dependencies, run_directory }) => {
      const data = dependencies["report-data"];
      if (data?.skipped) return data;
      const output = path.join(run_directory, "repository-improvement-assessment.html");
      invoke(path.join(riaRoot, "scripts", "build-report.js"), ["--input", data.path, "--output", output]);
      return { path: output, sha256: sha256(fs.readFileSync(output)), result_ref: { kind: "ria-report", path: output } };
    },
  } };
}

module.exports = { createAdapter, minimalSnapshot };
