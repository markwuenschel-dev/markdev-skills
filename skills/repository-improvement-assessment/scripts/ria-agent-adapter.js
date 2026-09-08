"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { writeEngineeringIntelligenceArtifact } = require("../engineering-intelligence-writer.js");
const { materializeSnapshot } = require("../../shared/software-engineering-intelligence/intelligence-engine.js");
const { assessRepositoryEngineering } = require("../../shared/software-engineering-intelligence/engineering-assessment.js");
const { createVerificationBaseline, writeVerificationBaselineForRepository } = require("../../shared/assessment-verification-baseline/verification-baseline.js");
const { validateOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const { buildReportData, readJson } = require("./report-model.js");
const { unavailablePerformanceReceipt } = require("./performance-receipt.js");
const { loadLineage } = require("./workspace-lineage.js");

const skillsRoot = path.resolve(__dirname, "..", "..");
const riaRoot = path.resolve(__dirname, "..");
const OWNERS = Object.freeze({
  "owner-health": "repository-health-assessment",
  "owner-integrity": "codebase-integrity-audit-loop",
  "owner-architecture": "architecture-improvement-intelligence",
});

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value))).digest("hex");
}
function atomicJson(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort tmp cleanup */ }
  }
  return target;
}
function invoke(script, args) {
  return JSON.parse(childProcess.execFileSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true }));
}
function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
function stableScope(baseline) {
  return sha256(JSON.stringify({
    repository_id: baseline.repository.repository_id,
    revision: baseline.repository.revision,
    roots: baseline.repository.roots.map((root) => root.repository_key),
  }));
}
function envelopePath(runDirectory, owner) {
  return path.join(runDirectory, "owner-inputs", `${owner}-envelope.json`);
}
function returnPath(runDirectory, owner) {
  return path.join(runDirectory, "owner-returns", `${owner}.json`);
}
function writeSeiConfig(baseline, runDirectory) {
  const template = JSON.parse(fs.readFileSync(path.join(riaRoot, "assets", "sei-ria-config.json"), "utf8"));
  template.history_window = {
    kind: "revision-range",
    start: template.history_window?.start ?? null,
    end: baseline.repository.revision,
  };
  const target = path.join(runDirectory, "sei-ria-config.json");
  atomicJson(target, template);
  return target;
}
function findPriorSeiSnapshot(repositoryRoot, durableMode, revision) {
  try {
    const lineage = loadLineage(repositoryRoot, { durableMode });
    const candidates = [...(lineage.sei_artifacts || [])].reverse();
    for (const record of candidates) {
      if (record.revision === revision) continue;
      if (record.path && fs.existsSync(record.path)) return record.path;
    }
    const latest = candidates.find((record) => record.path && fs.existsSync(record.path));
    return latest?.path ?? null;
  } catch {
    return null;
  }
}
function writeEiWithRetry(input) {
  let last;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try { return writeEngineeringIntelligenceArtifact(input); }
    catch (error) {
      last = error;
      if (!String(error.message).includes("INDEX-LOCKED")) throw error;
      const until = Date.now() + 8;
      while (Date.now() < until) { /* bounded contention backoff */ }
    }
  }
  throw last;
}
function assessmentRef(assessment, artifactPath) {
  const bytes = fs.readFileSync(artifactPath);
  return {
    schema_version: assessment.schema_version,
    assessment_id: assessment.assessment_id,
    snapshot_binding: {
      snapshot_id: assessment.snapshot_binding.snapshot_id,
      revision: assessment.snapshot_binding.repository_revision,
      repository_id: assessment.snapshot_binding.repository_id,
      digest: assessment.snapshot_binding.configuration_hash,
    },
    evaluator: { id: assessment.evaluator.evaluator_id, version: assessment.evaluator.version },
    rubric: { id: assessment.rubric.rubric_id, version: assessment.rubric.version, digest: assessment.rubric.digest },
    standard: { id: assessment.standard.standard_id, version: assessment.standard.version, digest: assessment.standard.digest },
    config_digest: assessment.snapshot_binding.configuration_hash,
    applicability_digest: assessment.applicability.digest,
    artifact_path: artifactPath,
    artifact_sha256: sha256(bytes),
  };
}
function isolateSource(baseline, runDirectory) {
  const root = baseline.repository.roots[0].root;
  const dest = path.join(runDirectory, "verification-worktree");
  if (baseline.repository.mode === "git") {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    childProcess.execFileSync("git", ["-C", root, "worktree", "add", "--detach", dest, baseline.repository.revision], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return {
      mode: "worktree",
      path: dest,
      source_repository_mutated: false,
      cleanup() {
        try { childProcess.execFileSync("git", ["-C", root, "worktree", "remove", "--force", dest], { windowsHide: true, stdio: "ignore" }); }
        catch { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* leftover worktree is non-source */ } }
      },
    };
  }
  fs.cpSync(root, dest, { recursive: true, filter: (src) => !String(src).includes(`${path.sep}.project-intelligence${path.sep}`) && !String(src).endsWith(`${path.sep}.project-intelligence`) });
  return {
    mode: "copy",
    path: dest,
    source_repository_mutated: false,
    cleanup() { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* isolation copy cleanup is best effort */ } },
  };
}
function runIsolatedCommand(command, cwd) {
  const started = Date.now();
  const id = String(command).replace(/\s+/g, "-").slice(0, 80) || "command";
  if (command === "node-version") {
    const output = childProcess.execFileSync(process.execPath, ["--version"], { encoding: "utf8", cwd, windowsHide: true }).trim();
    return { id, command: `${process.execPath} --version`, status: "passed", exit_code: 0, duration_ms: Math.max(0, Date.now() - started), reason: null, evidence: [`node:${output}`] };
  }
  try {
    const output = childProcess.execSync(String(command), { encoding: "utf8", cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { id, command: String(command), status: "passed", exit_code: 0, duration_ms: Math.max(0, Date.now() - started), reason: null, evidence: [String(output || "ok").slice(0, 500)] };
  } catch (error) {
    return {
      id,
      command: String(command),
      status: "failed",
      exit_code: Number.isInteger(error.status) ? error.status : 1,
      duration_ms: Math.max(0, Date.now() - started),
      reason: null,
      evidence: [String(error.stderr || error.message).slice(0, 500)],
    };
  }
}
function parseLcovCounts(worktree) {
  const candidates = [path.join(worktree, "coverage", "lcov.info"), path.join(worktree, "lcov.info")];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return {};
  const text = fs.readFileSync(file, "utf8");
  let lineFound = 0;
  let lineHit = 0;
  let branchFound = 0;
  let branchHit = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("LF:")) lineFound += Number(line.slice(3)) || 0;
    else if (line.startsWith("LH:")) lineHit += Number(line.slice(3)) || 0;
    else if (line.startsWith("BRF:")) branchFound += Number(line.slice(4)) || 0;
    else if (line.startsWith("BRH:")) branchHit += Number(line.slice(4)) || 0;
  }
  const coverage = {};
  if (lineFound > 0) coverage.line = { covered: lineHit, total: lineFound };
  if (branchFound > 0) coverage.branch = { covered: branchHit, total: branchFound };
  return coverage;
}
function buildTrend(priorPath, snapshot) {
  if (!priorPath) return { schema_version: "ria.trend@1", status: "no-comparable-prior", prior: null, deltas: [] };
  try {
    const previous = JSON.parse(fs.readFileSync(priorPath, "utf8"));
    const interpretation = require(path.join(skillsRoot, "shared", "software-engineering-intelligence", "interpretation.js"));
    const comparison = typeof interpretation.compareSnapshots === "function" ? interpretation.compareSnapshots(previous, snapshot) : null;
    return {
      schema_version: "ria.trend@1",
      status: "compared",
      prior: {
        artifact_id: previous.snapshot_id || path.basename(priorPath),
        repository_revision: previous.repository?.revision || null,
        path: priorPath,
      },
      deltas: Array.isArray(comparison?.deltas) ? comparison.deltas : comparison ? [comparison] : [],
    };
  } catch {
    return { schema_version: "ria.trend@1", status: "unavailable", prior: { path: priorPath }, deltas: [] };
  }
}

function createAdapter(context, options = {}) {
  const runDirectory = context.run_directory;
  const durableMode = context.request.durable_mode ?? "git";
  const repositoryRoot = context.baseline.repository.roots[0].root;

  async function defaultSeiSnapshot({ baseline, baseline_ref, runtime_root }) {
    const configPath = writeSeiConfig(baseline, runDirectory);
    const prior = findPriorSeiSnapshot(repositoryRoot, durableMode, baseline.repository.revision);
    const outDir = path.join(runDirectory, "sei");
    fs.mkdirSync(outDir, { recursive: true });
    const argv = ["--repo", repositoryRoot, "--out", outDir, "--config", configPath, "--report-mode", "skip"];
    if (prior) argv.push("--baseline", prior);
    let snapshot = null;
    try {
      const cli = require(path.join(skillsRoot, "shared", "software-engineering-intelligence", "cli.js"));
      await cli.execute(argv);
      const snapshotDir = path.join(outDir, "snapshots");
      const files = fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir).filter((name) => name.endsWith(".json")).sort() : [];
      if (files.length) snapshot = JSON.parse(fs.readFileSync(path.join(snapshotDir, files.at(-1)), "utf8"));
    } catch (error) {
      fail("FAIL-RIA-SEI", error.message);
    }
    if (!snapshot) {
      const revision = baseline.repository.revision;
      const config = baseline.sei_compatibility_binding.config_hash;
      snapshot = materializeSnapshot({
        schema_version: "1.0.0",
        snapshot_id: "pending",
        repository: { repository_id: baseline.repository.repository_id, revision, configuration_hash: config, history_boundary: { kind: "revision-range", start: null, end: revision }, generated_path_patterns: JSON.parse(fs.readFileSync(configPath, "utf8")).generated_path_patterns },
        collectors: [],
        measurements: [],
        risk_models: [],
        profiles: [],
        evidence_summary: { measurement_count: 0, status_counts: { measured: 0, inferred: 0, unavailable: 0, "not-applicable": 0, unverifiable: 0 } },
        run_metadata: { generated_at: new Date().toISOString(), cache: { cache_key: sha256(JSON.stringify({ revision, config })), repository_revision: revision, configuration_hash: config, schema_version: "1.0.0", collector_versions: [], history_boundary: { kind: "revision-range", start: null, end: revision } } },
      });
    }
    const engineering_intelligence_ref = writeEiWithRetry({
      repository_root: repositoryRoot,
      baseline_ref,
      mission_id: "ria-agent-adapter",
      scope_hash: stableScope(baseline),
      compute_snapshot: () => snapshot,
    });
    return { engineering_intelligence_ref, snapshot, prior_snapshot_path: prior, result_ref: engineering_intelligence_ref, telemetry: { tool_calls: 1, tokens: 0 } };
  }

  async function defaultSeiAssessment({ dependencies, runtime_root, baseline }) {
    const snapshot = dependencies["sei-snapshot"].snapshot;
    const priorPath = dependencies["sei-snapshot"].prior_snapshot_path ?? null;
    const repositoryIndex = {
      binding: { repository_revision: baseline.repository.revision, index_digest: `sha256:${sha256(JSON.stringify({ repository: baseline.repository.repository_id, revision: baseline.repository.revision }))}` },
      entries: [],
      exclusions: [],
    };
    const assessment = assessRepositoryEngineering({ snapshot, repositoryIndex, assessmentConfig: { repository_root: baseline.repository.roots[0].root } });
    const artifactPath = atomicJson(path.join(runtime_root, "evidence", "sei-assessments", `${assessment.assessment_id.replaceAll(":", "-")}.json`), assessment);
    const sei_assessment_ref = assessmentRef(assessment, artifactPath);
    return {
      assessment,
      sei_assessment_ref,
      trend: buildTrend(priorPath, snapshot),
      result_ref: { artifact_id: assessment.assessment_id, sha256: sei_assessment_ref.artifact_sha256, repository_revision: baseline.repository.revision },
      telemetry: { tool_calls: 1, tokens: 0 },
    };
  }

  async function defaultVerification({ request, baseline, baseline_ref }) {
    const state = request.command_authorization?.state;
    if (!new Set(["granted", "inherited"]).has(state)) fail("COMMAND_AUTHORIZATION_DENIED", "verification command authority is not available");
    const isolation = isolateSource(baseline, runDirectory);
    try {
      const requested = Array.isArray(request.verification_contract?.commands) ? request.verification_contract.commands : [];
      const commands = requested.map((command) => runIsolatedCommand(command, isolation.path));
      const coverage = parseLcovCounts(isolation.path);
      const artifact = createVerificationBaseline({
        repository: {
          repository_id: baseline.repository.repository_id,
          revision: baseline.repository.revision,
          working_tree_fingerprint: sha256(JSON.stringify(baseline.repository.roots.map((root) => root.working_tree.fingerprint))),
        },
        baseline_ref,
        isolation: { mode: isolation.mode, path: isolation.path, source_repository_mutated: false },
        commands,
        environment: { node: process.version },
        coverage,
        created_at: new Date().toISOString(),
      });
      const writer = writeVerificationBaselineForRepository(repositoryRoot, artifact);
      const verification_baseline_ref = {
        artifact_id: artifact.artifact_id,
        content_sha256: artifact.content_sha256,
        file_sha256: writer.file_sha256,
        sha256: writer.file_sha256,
        repository_revision: baseline.repository.revision,
        path: writer.path,
      };
      return { artifact, writer, verification_baseline_ref, result_ref: verification_baseline_ref, telemetry: { tool_calls: commands.length, tokens: 0 } };
    } finally {
      isolation.cleanup();
    }
  }

  function ownerHandler(taskId) {
    const owner = OWNERS[taskId];
    return async ({ owner_envelope, baseline }) => {
      const envelope = owner_envelope();
      if (owner !== "architecture-improvement-intelligence" && !envelope.verification_baseline_ref) {
        fail("FAIL-RIA-VERIFICATION-BASELINE-REQUIRED", `${owner} requires verification_baseline_ref in the RIA envelope`);
      }
      const writtenEnvelope = atomicJson(envelopePath(runDirectory, owner), envelope);
      const destination = returnPath(runDirectory, owner);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (!fs.existsSync(destination)) {
        fail("OWNER_RETURN_PENDING", `write ria.owner-return@1 for ${owner} to ${destination} using envelope ${writtenEnvelope}`);
      }
      const value = JSON.parse(fs.readFileSync(destination, "utf8"));
      const validation = validateOwnerReturn(value, {
        owner,
        repository_revision: baseline.repository.revision,
        input_binding_echo: envelope,
      });
      if (!validation.ok) fail("FAIL-RIA-OWNER-RETURN", validation.errors.join("; "));
      return value;
    };
  }

  return {
    handlers: {
      "sei-snapshot": options.seiSnapshot || defaultSeiSnapshot,
      "sei-assessment": options.seiAssessment || defaultSeiAssessment,
      "verification-baseline": options.verification || defaultVerification,
      "owner-health": ownerHandler("owner-health"),
      "owner-integrity": ownerHandler("owner-integrity"),
      "owner-architecture": ownerHandler("owner-architecture"),
      "report-data": async ({ request, baseline, dependencies, run_directory }) => {
        if (request.presentation_policy !== "generate") return { skipped: true, reason: "EXPLICIT_PRESENTATION_SKIP" };
        const projection = dependencies["assess-binding"];
        if (projection?.stage !== "ASSESS") fail("REPORT_ASSESSMENT_INCOMPLETE", "complete ASSESS projection is required for report generation");
        const ownerArtifacts = dependencies["owner-artifact-verification"].owner_artifacts;
        const reportRequest = {
          repository: { name: path.basename(baseline.repository.roots[0].root), revision: baseline.repository.revision },
          mode: request.lifecycle,
          baseline_ref: projection.baseline_ref,
          engineering_intelligence_ref: projection.engineering_intelligence_ref,
          assessment_refs: projection.assessment_refs,
          report_election: { schema_version: 1, policy: "generate", lean: "generate", reason: "caller explicitly requested the combined RIA report", state: "elected-generate", report_owner: null },
          performance_receipt: unavailablePerformanceReceipt(request.run_nonce ?? "pre-presentation", "PRE_PRESENTATION_EVENT_STREAM_INCOMPLETE"),
          sei_telemetry_summary: dependencies["sei-telemetry-summary"],
          coverage_metrics: dependencies["verification-baseline"]?.artifact?.coverage ?? null,
          trend: dependencies["sei-assessment"]?.trend ?? null,
        };
        const healthReturn = ownerArtifacts["repository-health-assessment"];
        const testingRef = Array.isArray(healthReturn?.specialist_refs) ? healthReturn.specialist_refs.find((item) => item.kind === "testing-fitness") : null;
        if (testingRef) reportRequest.testing_fitness_ref = testingRef;
        const reportData = buildReportData({
          request: reportRequest,
          healthFile: readJson(healthReturn.artifact_path, "health"),
          integrityFile: readJson(ownerArtifacts["codebase-integrity-audit-loop"].artifact_path, "integrity"),
          architectureFile: readJson(ownerArtifacts["architecture-improvement-intelligence"].artifact_path, "architecture"),
          testingFitnessFile: testingRef ? readJson(testingRef.path, "testing-fitness") : null,
          skillRoot: riaRoot,
          fixture: false,
        });
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
    },
  };
}

module.exports = { createAdapter, envelopePath, returnPath, writeSeiConfig, findPriorSeiSnapshot };
