"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeEngineeringIntelligenceArtifact } = require("../engineering-intelligence-writer.js");
const { materializeSnapshot } = require("../../shared/software-engineering-intelligence/intelligence-engine.js");
const { assessRepositoryEngineering } = require("../../shared/software-engineering-intelligence/engineering-assessment.js");
const { createVerificationBaseline, writeVerificationBaselineForRepository } = require("../../shared/assessment-verification-baseline/verification-baseline.js");
const { validateOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const { v2ContextFromRun } = require("./composite-v2-model.js");
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
function isSeiSnapshotFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (value.kind === "engineering-intelligence" || value.engineering_intelligence) return false;
    return typeof value.snapshot_id === "string" && value.snapshot_id.length > 0 && value.repository && typeof value.repository === "object";
  } catch {
    return false;
  }
}
function findPriorSeiSnapshot(repositoryRoot, durableMode, revision) {
  try {
    const lineage = loadLineage(repositoryRoot, { durableMode });
    const candidates = [...(lineage.sei_artifacts || [])].reverse();
    for (const record of candidates) {
      if (record.revision === revision) continue;
      if (isSeiSnapshotFile(record.path)) return record.path;
    }
    const latest = candidates.find((record) => isSeiSnapshotFile(record.path));
    return latest?.path ?? null;
  } catch {
    return null;
  }
}
const RETRY_SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function writeEiWithRetry(input) {
  let last;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try { return writeEngineeringIntelligenceArtifact(input); }
    catch (error) {
      last = error;
      if (!String(error.message).includes("INDEX-LOCKED")) throw error;
      // Sleep, don't spin: a busy loop pinned a core for the whole backoff.
      Atomics.wait(RETRY_SLEEPER, 0, 0, 8);
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
function gitLongpaths(root, args) {
  return ["-C", root, "-c", "core.longpaths=true", ...args];
}
function gitNulPaths(root, args) {
  const output = childProcess.execFileSync("git", gitLongpaths(root, args), { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return String(output).split("\0").filter(Boolean);
}
/** Copy the uncommitted changes over a detached checkout so `scope: "worktree"`
 * verifies what is actually on disk. Paths come from `diff HEAD` (which names both
 * sides of a rename) plus untracked files, so no rename record has to be parsed. */
function overlayWorkingTree(root, dest) {
  const changed = new Set([
    ...gitNulPaths(root, ["diff", "--name-only", "-z", "HEAD"]),
    ...gitNulPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  let copied = 0, removed = 0;
  for (const relative of changed) {
    if (relative.split("/")[0] === ".project-intelligence") continue;
    const from = path.join(root, relative), to = path.join(dest, relative);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      copied += 1;
    } else if (fs.existsSync(to)) {
      fs.rmSync(to, { recursive: true, force: true });
      removed += 1;
    }
  }
  return { copied, removed, entries: changed.size };
}
/** `git worktree prune` drops only registrations whose directory no longer exists, so it
 * never touches a live worktree. Nothing in RIA called it, and on Windows the rmSync fallback
 * in cleanup() is the common path (handles linger after a command exits), which deletes the
 * checkout but leaves .git/worktrees/<name> registered forever. Best effort, never fatal. */
function pruneWorktrees(root) {
  try { childProcess.execFileSync("git", gitLongpaths(root, ["worktree", "prune"]), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); return "ok"; }
  catch (error) { return `failed: ${String(error.stderr || error.message).trim().slice(0, 200)}`; }
}
function isolateSource(baseline, runDirectory) {
  const root = baseline.repository.roots[0].root;
  if (baseline.repository.mode === "git") {
    const maintenance = { prune_before: pruneWorktrees(root), prune_after: null };
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ria-vt-"));
    // Under `scope: "worktree"` the baseline revision is a synthetic content hash, not a
    // git object; pinning to it makes `worktree add` fail outright. The real commit is
    // always head_revision, and the uncommitted delta is layered on afterwards.
    const commitish = baseline.repository.roots[0].head_revision ?? baseline.repository.revision;
    childProcess.execFileSync("git", gitLongpaths(root, ["worktree", "add", "--detach", dest, commitish]), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const overlay = baseline.repository.scope === "worktree" ? overlayWorkingTree(root, dest) : null;
    return {
      mode: "worktree",
      path: dest,
      overlay,
      maintenance,
      source_repository_mutated: false,
      cleanup() {
        try { childProcess.execFileSync("git", gitLongpaths(root, ["worktree", "remove", "--force", dest]), { windowsHide: true, stdio: "ignore" }); }
        catch { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* leftover worktree is non-source */ } }
        maintenance.prune_after = pruneWorktrees(root);
      },
    };
  }
  const dest = path.join(runDirectory, "verification-worktree");
  fs.cpSync(root, dest, { recursive: true, filter: (src) => !String(src).includes(`${path.sep}.project-intelligence${path.sep}`) && !String(src).endsWith(`${path.sep}.project-intelligence`) });
  return {
    mode: "copy",
    path: dest,
    overlay: null,
    source_repository_mutated: false,
    cleanup() { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* isolation copy cleanup is best effort */ } },
  };
}
/** A contract entry is either a bare shell string or {command, kind}. Pinning `kind`
 * suppresses the heuristic, which matters because a wrong `test` tightens Health's grade
 * cap on evidence that does not exist. */
function normalizeContractEntry(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    if (typeof entry.command !== "string" || !entry.command) fail("FAIL-RIA-VERIFICATION-CONTRACT", "verification_contract.commands entry object requires a non-empty command string");
    const timeout = entry.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout <= 0) fail("FAIL-RIA-VERIFICATION-CONTRACT", `timeout_ms must be a positive integer (milliseconds), got ${entry.timeout_ms}`);
    return { command: entry.command, kind: entry.kind ?? null, timeout_ms: timeout };
  }
  if (typeof entry !== "string" || !entry) fail("FAIL-RIA-VERIFICATION-CONTRACT", "verification_contract.commands entry must be a shell string or {command, kind, timeout_ms}");
  return { command: entry, kind: null, timeout_ms: DEFAULT_COMMAND_TIMEOUT_MS };
}
// Without a timeout one hung test blocked the scheduler inside execSync, where no budget —
// max_wall_minutes included — can fire. It is also why `timed-out` was unreachable.
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** Kill the whole process tree, not just the shell. A timeout that killed only cmd.exe left the
 * command it started running. That was observed here: each timed-out command orphaned its process,
 * which held a handle on the isolation worktree so cleanup could not remove it. taskkill /T needs
 * the parent alive, so this runs before the shell exits, which execSync never allowed. */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try { childProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* already gone */ }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
}
const OUTPUT_CAP_BYTES = 64 * 1024;
async function runIsolatedCommand(command, cwd, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  const started = Date.now();
  const id = String(command).replace(/\s+/g, "-").slice(0, 80) || "command";
  if (command === "node-version") {
    const output = childProcess.execFileSync(process.execPath, ["--version"], { encoding: "utf8", cwd, windowsHide: true }).trim();
    return { id, command: `${process.execPath} --version`, status: "passed", exit_code: 0, duration_ms: Math.max(0, Date.now() - started), reason: null, evidence: [`node:${output}`] };
  }
  // Same shell semantics as before: shell:true uses ComSpec (cmd.exe) on Windows, so entries stay
  // literal shell strings. Output is capped instead of buffered whole, so a chatty suite can no
  // longer overflow a buffer and be recorded as a failed test.
  return await new Promise((resolve) => {
    const child = childProcess.spawn(String(command), { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const take = (buffer, chunk) => (buffer.length < OUTPUT_CAP_BYTES ? buffer + chunk.toString("utf8") : buffer);
    child.stdout.on("data", (chunk) => { stdout = take(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = take(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const finish = (record) => { if (settled) return; settled = true; clearTimeout(timer); resolve(record); };
    const base = () => ({ id, command: String(command), duration_ms: Math.max(0, Date.now() - started) });
    child.on("error", (error) => finish({ ...base(), status: "failed", exit_code: 1, reason: null, evidence: [String(error.message).slice(0, 500)] }));
    child.on("close", (code) => {
      if (timedOut) {
        const record = base();
        const tail = stderr ? `: ${stderr.slice(0, 400)}` : "";
        finish({ ...record, status: "timed-out", exit_code: null, reason: `exceeded timeout of ${timeoutMs} ms`, evidence: [`killed with its process tree after ${record.duration_ms} ms (limit ${timeoutMs} ms)${tail}`] });
      } else if (code === 0) {
        finish({ ...base(), status: "passed", exit_code: 0, reason: null, evidence: [String(stdout || "ok").slice(0, 500)] });
      } else {
        finish({ ...base(), status: "failed", exit_code: Number.isInteger(code) ? code : 1, reason: null, evidence: [String(stderr || stdout || `exited with code ${code}`).slice(0, 500)] });
      }
    });
  });
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

/** Results cached before the snapshot moved out of line still carry it inline under the same
 * cache key; accept those rather than break every warm cache. A path whose bytes no longer
 * match the recorded hash is refused — never silently recomputed, never silently trusted. */
function loadSnapshotFromResult(result) {
  if (result?.snapshot) return result.snapshot;
  const file = result?.snapshot_path;
  if (!file || !fs.existsSync(file)) fail("FAIL-RIA-SEI", `cached snapshot ${file ?? "(no path recorded)"} is missing — rerun with reuse_controls {"SEI":"rerun"}`);
  const bytes = fs.readFileSync(file);
  if (result.snapshot_sha256 && sha256(bytes) !== result.snapshot_sha256) fail("FAIL-RIA-SEI", `cached snapshot ${file} was altered (sha256 mismatch) — rerun with reuse_controls {"SEI":"rerun"}`);
  return JSON.parse(bytes.toString("utf8"));
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
    let snapshotPath = null;
    const snapshotDir = path.join(outDir, "snapshots");
    try {
      const cli = require(path.join(skillsRoot, "shared", "software-engineering-intelligence", "cli.js"));
      await cli.execute(argv);
      const files = fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir).filter((name) => name.endsWith(".json")).sort() : [];
      if (files.length) { snapshotPath = path.join(snapshotDir, files.at(-1)); snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")); }
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
    // Hand the snapshot on by path + hash, never inline. The result is written into state.json
    // and the task cache; inline, one snapshot (5–90 MB) was stored four or five times and
    // state.json was rewritten with it on every scheduler event.
    if (!snapshotPath) snapshotPath = atomicJson(path.join(snapshotDir, `fallback-${sha256(JSON.stringify(snapshot)).slice(0, 16)}.json`), snapshot);
    const snapshot_sha256 = sha256(fs.readFileSync(snapshotPath));
    return { engineering_intelligence_ref, snapshot_path: snapshotPath, snapshot_sha256, prior_snapshot_path: prior, result_ref: engineering_intelligence_ref, telemetry: { tool_calls: 1, tokens: 0 } };
  }

  async function defaultSeiAssessment({ dependencies, runtime_root, baseline }) {
    const snapshot = loadSnapshotFromResult(dependencies["sei-snapshot"]);
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
      const requested = (Array.isArray(request.verification_contract?.commands) ? request.verification_contract.commands : []).map(normalizeContractEntry);
      // Sequential, as before: commands share one checkout and may depend on each other's output.
      const commands = [];
      for (const entry of requested) {
        const record = await runIsolatedCommand(entry.command, isolation.path, entry.timeout_ms);
        commands.push(entry.kind ? { ...record, kind: entry.kind } : record);
      }
      const coverage = parseLcovCounts(isolation.path);
      const artifact = createVerificationBaseline({
        repository: {
          repository_id: baseline.repository.repository_id,
          revision: baseline.repository.revision,
          working_tree_fingerprint: sha256(JSON.stringify(baseline.repository.roots.map((root) => root.working_tree.fingerprint))),
        },
        baseline_ref,
        isolation: { mode: isolation.mode, path: isolation.path, source_repository_mutated: false, overlay: isolation.overlay ?? null },
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
      // The artifact is durable before the gate runs, so a refusal is always
      // backed by evidence the caller can open. Returning normally here is what
      // used to let a task whose every command failed report `completed`.
      if (artifact.trust.state === "untrustworthy" && !request.allow_degraded) {
        const offenders = artifact.commands.filter((command) => command.status !== "passed");
        fail("FAIL-RIA-VERIFICATION-GATE", `${offenders.length} of ${artifact.commands.length} verification command(s) did not pass: ${offenders.map((command) => `${command.id} (${command.status}, exit ${command.exit_code})`).join(", ")}. Evidence: ${writer.path}. Set allow_degraded:true to proceed with an untrustworthy baseline.`);
      }
      return { artifact, writer, verification_baseline_ref, result_ref: verification_baseline_ref, isolation_maintenance: isolation.maintenance ?? null, telemetry: { tool_calls: commands.length, tokens: 0 } };
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
          verification_trust: dependencies["verification-baseline"]?.artifact?.trust ?? null,
          trend: dependencies["sei-assessment"]?.trend ?? null,
        };
        const healthReturn = ownerArtifacts["repository-health-assessment"];
        const testingRef = Array.isArray(healthReturn?.specialist_refs) ? healthReturn.specialist_refs.find((item) => item.kind === "testing-fitness") : null;
        if (testingRef) reportRequest.testing_fitness_ref = testingRef;
        const evidenceReconRef = Array.isArray(healthReturn?.specialist_refs) ? healthReturn.specialist_refs.find((item) => item.kind === "evidence-recon") : null;
        if (evidenceReconRef) reportRequest.evidence_recon_ref = evidenceReconRef;
        const reportData = buildReportData({
          request: reportRequest,
          healthFile: readJson(healthReturn.artifact_path, "health"),
          integrityFile: readJson(ownerArtifacts["codebase-integrity-audit-loop"].artifact_path, "integrity"),
          architectureFile: readJson(ownerArtifacts["architecture-improvement-intelligence"].artifact_path, "architecture"),
          testingFitnessFile: testingRef ? readJson(testingRef.path, "testing-fitness") : null,
          evidenceReconFile: evidenceReconRef ? readJson(evidenceReconRef.path, "evidence-recon") : null,
          skillRoot: riaRoot,
          fixture: false,
          // composite-scoring-v3 Phase 8: the v2 shadow's bound evidence beyond the owner files.
          v2: v2ContextFromRun({ dependencies, baseline, request }),
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

module.exports = { createAdapter, loadSnapshotFromResult, envelopePath, returnPath, writeSeiConfig, findPriorSeiSnapshot, isSeiSnapshotFile, isolateSource };
