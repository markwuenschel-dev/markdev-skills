#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FAILURE = "FAIL-CQR-INCREMENTAL-ORACLE";
const CQR_REVISION = "c8e6137c5d7d78dc75b6c6c383f0ed3cf2d937a6";
const CQR_ROOT_TREE = "534a477e85439ce9daaff0cc0b4e7321298375d3";
const BASELINE_SEI_REVISION = "4ed955b47105a95f178d8c518d94c79b273ac5f2";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MODULE_PATHS = Object.freeze([
  "skills/software-engineering-intelligence/assets/canonical-input.json",
  "skills/software-engineering-intelligence/assets/report-template.html",
  "skills/software-engineering-intelligence/scripts/run-sei.js",
  "skills/shared/software-engineering-intelligence/cli.js",
  "skills/shared/software-engineering-intelligence/collectors.js",
  "skills/shared/software-engineering-intelligence/incremental-run-state.js",
  "skills/shared/software-engineering-intelligence/intelligence-engine.js",
  "skills/shared/software-engineering-intelligence/report.js",
  "skills/shared/software-engineering-intelligence/static-intelligence.js",
]);

function fail(detail) {
  const error = new Error(`${FAILURE}: ${detail}`);
  error.code = FAILURE;
  throw error;
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(stableCompare).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function prettyJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) fail("arguments must be flag/value pairs");
  const mapping = new Map([
    ["--repo", "repositoryRoot"],
    ["--revision", "revision"],
    ["--baseline-sei-root", "baselineSeiRoot"],
    ["--candidate-sei-root", "candidateSeiRoot"],
    ["--python", "pythonExecutable"],
    ["--out", "out"],
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = mapping.get(flag);
    if (!key || typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(`unsupported argument or missing value ${flag}`);
    if (Object.hasOwn(parsed, key)) fail(`duplicate argument ${flag}`);
    parsed[key] = value;
  }
  for (const key of ["repositoryRoot", "revision", "baselineSeiRoot", "candidateSeiRoot", "pythonExecutable", "out"]) {
    if (!Object.hasOwn(parsed, key)) fail(`${key} is required`);
  }
  if (parsed.revision !== CQR_REVISION) fail(`revision must equal the frozen CQR revision ${CQR_REVISION}`);
  return parsed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: null,
    windowsHide: true,
    timeout: options.timeout ?? 180_000,
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...(options.env ?? {}) },
  });
  if (result.error || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : String(result.stderr ?? "").trim();
    fail(`${options.label ?? command} failed${result.error ? ` (${result.error.message})` : ` with exit ${result.status}${stderr ? ` (${stderr.slice(0, 8192)})` : ""}`}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

function git(root, args, label = `git ${args[0]}`) {
  return run("git", args, { cwd: root, label });
}

function oneLine(bytes, label) {
  const value = bytes.toString("utf8").trim();
  if (!value || /[\r\n]/.test(value)) fail(`${label} was malformed`);
  return value;
}

function gitIdentity(root) {
  const revision = oneLine(git(root, ["rev-parse", "HEAD"]), "Git revision");
  const tree = oneLine(git(root, ["rev-parse", "HEAD^{tree}"]), "Git root tree");
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).toString("utf8");
  return { revision, tree, status, status_sha256: sha256(status) };
}

function verifySeiRoot(root, expectedRevision, label) {
  const resolved = path.resolve(root);
  const identity = gitIdentity(resolved);
  if (identity.revision !== expectedRevision || identity.status !== "") fail(`${label} must be a clean exact ${expectedRevision} Git root`);
  const files = {};
  for (const relativePath of MODULE_PATHS) {
    if (relativePath.includes("incremental-run-state") && label === "baseline SEI") continue;
    const filePath = path.join(resolved, ...relativePath.split("/"));
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() || stats.isSymbolicLink()) fail(`${label} is missing regular file ${relativePath}`);
    const bytes = fs.readFileSync(filePath);
    files[relativePath] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  return { root: resolved, revision: identity.revision, tree: identity.tree, files };
}

function probePython(executable) {
  const resolved = path.resolve(executable);
  const stats = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) fail("Python executable must be an absolute regular file");
  let probe;
  try {
    probe = JSON.parse(run(resolved, ["-I", "-S", "-c", "import json,platform,sys;print(json.dumps({'implementation':sys.implementation.name,'version':platform.python_version(),'major':sys.version_info.major,'minor':sys.version_info.minor},sort_keys=True,separators=(',',':')))"], {
      label: "isolated CPython probe", timeout: 30_000, maxBuffer: 4096,
    }).toString("utf8"));
  } catch (error) {
    if (error?.code === FAILURE) throw error;
    fail(`Python probe was malformed (${error.message})`);
  }
  if (probe.implementation !== "cpython" || probe.major !== 3 || probe.minor !== 13) fail(`exact CPython 3.13 is required, observed ${JSON.stringify(probe)}`);
  return { executable: resolved, ...probe };
}

function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readRegular(filePath, maximum, label) {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maximum) fail(`${label} is not a bounded regular file`);
  return fs.readFileSync(filePath);
}

function runProduct({ seiRoot, repositoryRoot, out, pythonExecutable, incremental, baseline, performancePath }) {
  const runner = path.join(seiRoot, "skills", "software-engineering-intelligence", "scripts", "run-sei.js");
  const config = path.join(seiRoot, "skills", "software-engineering-intelligence", "assets", "canonical-input.json");
  const args = [runner, "--repo", repositoryRoot, "--out", out, "--config", config, "--python", pythonExecutable];
  if (incremental !== null) args.push("--incremental", incremental);
  if (baseline !== null) args.push("--baseline", baseline);
  if (performancePath !== null) args.push("--performance-json", performancePath);
  const started = process.hrtime.bigint();
  const stdout = run(process.execPath, args, { cwd: seiRoot, label: `SEI ${incremental ?? "baseline"} run`, timeout: 180_000 });
  const wallMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  let receipt;
  try { receipt = JSON.parse(stdout.toString("utf8")); } catch (error) { fail(`SEI stdout was not one JSON receipt (${error.message})`); }
  const snapshotBytes = readRegular(receipt.snapshot_path, 256 * 1024 * 1024, "snapshot");
  const reportBytes = readRegular(receipt.report_path, 256 * 1024 * 1024, "report");
  if (!contained(out, receipt.snapshot_path) || !contained(out, receipt.report_path)) fail("public artifacts escaped their run output");
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const engine = require(path.join(seiRoot, "skills", "shared", "software-engineering-intelligence", "intelligence-engine.js"));
  const report = require(path.join(seiRoot, "skills", "shared", "software-engineering-intelligence", "report.js"));
  const snapshotValidation = engine.validateSnapshot(snapshot);
  if (!snapshotValidation.ok) fail(`snapshot validation failed (${snapshotValidation.errors.join("; ")})`);
  const reportValidation = report.verifyRenderedReport(reportBytes.toString("utf8"), snapshot);
  if (!reportValidation.ok) fail(`report validation failed (${reportValidation.errors.join("; ")})`);
  let performance = null;
  if (performancePath !== null) performance = JSON.parse(readRegular(performancePath, 16 * 1024 * 1024, "performance receipt").toString("utf8"));
  return {
    receipt,
    snapshot,
    snapshotBytes,
    reportBytes,
    performance,
    external_wall_ms: Number(wallMs.toFixed(3)),
  };
}

function evidenceForRun(run, outputRoot) {
  const phase = run.receipt.performance?.phase_telemetry;
  const stages = run.receipt.performance?.incremental_stages;
  const executor = run.performance?.executor;
  const artifacts = run.receipt.performance?.artifacts;
  return {
    snapshot_sha256: sha256(run.snapshotBytes),
    report_sha256: sha256(run.reportBytes),
    comparison_sha256: sha256(canonicalJson(run.receipt.comparison)),
    snapshot_id: run.receipt.snapshot_id,
    external_wall_ms: run.external_wall_ms,
    phase_reconciled: phase?.reconciliation?.within_tolerance === true,
    static_mode: stages?.static?.reuse?.mode ?? null,
    static_recomputed: stages?.static?.reuse?.recomputed_file_count ?? null,
    history_mode: stages?.history?.reuse?.mode ?? null,
    history_appended: stages?.history?.reuse?.appended_commit_count ?? null,
    consumer_tasks: executor?.phases?.consumers?.tasks_submitted ?? null,
    python_tasks: executor?.phases?.python_static?.tasks_submitted ?? run.receipt.performance?.python_static_intelligence?.tasks_submitted ?? null,
    artifacts_within_output: contained(outputRoot, run.receipt.snapshot_path)
      && contained(outputRoot, run.receipt.report_path)
      && Number.isInteger(artifacts?.planned_count),
  };
}

function validateScenarioEvidence(value, expectations = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("scenario evidence is invalid");
  if (expectations.expectedName !== undefined && value.name !== expectations.expectedName) fail("scenario name drifted");
  if (expectations.expectedRevision !== undefined && value.revision !== expectations.expectedRevision) fail("scenario revision drifted");
  if (expectations.expectedRootTree !== undefined && value.root_tree !== expectations.expectedRootTree) fail("scenario root tree drifted");
  for (const side of ["forced_cold", "incremental"]) {
    if (!value[side] || !SHA256.test(value[side].snapshot_sha256) || !SHA256.test(value[side].report_sha256) || !SHA256.test(value[side].comparison_sha256)) fail(`${side} digests are invalid`);
  }
  for (const field of ["snapshot_sha256", "report_sha256", "comparison_sha256"]) {
    if (value.forced_cold[field] !== value.incremental[field]) fail(`scenario ${field} parity failed`);
  }
  if (value.incremental.phase_reconciled !== true || value.incremental.artifacts_within_output !== true) fail("scenario telemetry or containment failed");
  const checks = [
    ["static_mode", expectations.expectedStaticMode],
    ["static_recomputed", expectations.expectedStaticRecomputed],
    ["history_mode", expectations.expectedHistoryMode],
    ["history_appended", expectations.expectedHistoryAppended],
  ];
  for (const [field, expected] of checks) if (expected !== undefined && value.incremental[field] !== expected) fail(`scenario ${field} drifted`);
  return true;
}

function writeFileExclusive(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes, { encoding: "utf8", flag: "wx" });
}

function checkout(repositoryRoot, revision) {
  git(repositoryRoot, ["checkout", "--quiet", "--detach", revision]);
  const identity = gitIdentity(repositoryRoot);
  if (identity.revision !== revision || identity.status !== "") fail(`fixture checkout ${revision} is not clean`);
  return identity;
}

function selectProductionPython(repositoryRoot) {
  const paths = git(repositoryRoot, ["ls-tree", "-r", "--name-only", "HEAD"]).toString("utf8").split(/\r?\n/)
    .filter((entry) => entry.endsWith(".py") && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(entry))
    .sort(stableCompare);
  if (paths.length === 0) fail("CQR fixture contains no production Python source");
  return paths[0];
}

function commitFixtureChange(repositoryRoot, filePath) {
  fs.appendFileSync(path.join(repositoryRoot, ...filePath.split("/")), "\n# SEI incremental oracle deterministic one-file change\n", "utf8");
  git(repositoryRoot, ["add", "--", filePath]);
  run("git", ["-c", "user.name=SEI Oracle", "-c", "user.email=oracle@example.invalid", "commit", "--quiet", "-m", "SEI oracle one-file change"], {
    cwd: repositoryRoot,
    label: "fixture one-file commit",
    env: { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  });
  return gitIdentity(repositoryRoot);
}

function commitEmpty(repositoryRoot) {
  run("git", ["-c", "user.name=SEI Oracle", "-c", "user.email=oracle@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "SEI oracle history-only change"], {
    cwd: repositoryRoot,
    label: "fixture empty commit",
    env: { GIT_AUTHOR_DATE: "2026-01-01T00:00:01Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:01Z" },
  });
  return gitIdentity(repositoryRoot);
}

function runScenario({ name, repositoryRoot, candidate, pythonExecutable, root, incrementalRoot, baselinePath, expectations }) {
  const forcedRoot = path.join(root, `cold-${name}`);
  const forcedPerformance = path.join(root, "p", `${name}-cold.json`);
  const incrementalPerformance = path.join(root, "p", `${name}-incremental.json`);
  const forced = runProduct({
    seiRoot: candidate.root, repositoryRoot, out: forcedRoot, pythonExecutable,
    incremental: "off", baseline: baselinePath, performancePath: forcedPerformance,
  });
  const incremental = runProduct({
    seiRoot: candidate.root, repositoryRoot, out: incrementalRoot, pythonExecutable,
    incremental: "auto", baseline: baselinePath, performancePath: incrementalPerformance,
  });
  const identity = gitIdentity(repositoryRoot);
  const evidence = {
    name,
    revision: identity.revision,
    root_tree: identity.tree,
    forced_cold: evidenceForRun(forced, forcedRoot),
    incremental: evidenceForRun(incremental, incrementalRoot),
  };
  validateScenarioEvidence(evidence, {
    expectedName: name,
    expectedRevision: identity.revision,
    expectedRootTree: identity.tree,
    ...expectations,
  });
  return { evidence, forced, incremental };
}

function runCorrectnessOracle(input) {
  const sourceRoot = path.resolve(input.repositoryRoot);
  const out = path.resolve(input.out);
  for (const protectedRoot of [sourceRoot, path.resolve(input.baselineSeiRoot), path.resolve(input.candidateSeiRoot)]) {
    if (out === protectedRoot || contained(protectedRoot, out)) fail("oracle output must not be inside a source or SEI root");
  }
  if (fs.existsSync(out)) fail("oracle output must be a fresh path");
  fs.mkdirSync(out, { recursive: false });
  const originalBefore = gitIdentity(sourceRoot);
  if (originalBefore.revision !== CQR_REVISION || originalBefore.tree !== CQR_ROOT_TREE) fail("real CQR revision or root tree drifted");
  const baseline = verifySeiRoot(input.baselineSeiRoot, BASELINE_SEI_REVISION, "baseline SEI");
  const candidateIdentity = gitIdentity(path.resolve(input.candidateSeiRoot));
  const candidate = verifySeiRoot(input.candidateSeiRoot, candidateIdentity.revision, "candidate SEI");
  const python = probePython(input.pythonExecutable);
  const fixtureRoot = path.join(out, "r", "src");
  fs.mkdirSync(path.dirname(fixtureRoot), { recursive: true });
  run("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", sourceRoot, fixtureRoot], { label: "output-local CQR clone" });
  git(fixtureRoot, ["config", "core.autocrlf", "false"]);
  git(fixtureRoot, ["config", "core.eol", "lf"]);
  const s0Identity = checkout(fixtureRoot, CQR_REVISION);
  if (s0Identity.tree !== CQR_ROOT_TREE) fail("output-local S0 tree drifted");
  const incrementalRoot = path.join(out, "r", "auto");
  const baselineRun = runProduct({
    seiRoot: baseline.root, repositoryRoot: fixtureRoot, out: path.join(out, "r", "baseline"),
    pythonExecutable: python.executable, incremental: null, baseline: null, performancePath: null,
  });
  const s0 = runScenario({
    name: "s0-no-change", repositoryRoot: fixtureRoot, candidate, pythonExecutable: python.executable,
    root: path.join(out, "r"), incrementalRoot, baselinePath: null,
    expectations: { expectedStaticMode: "miss", expectedStaticRecomputed: 204, expectedHistoryMode: "cold", expectedHistoryAppended: 168 },
  });
  if (sha256(baselineRun.snapshotBytes) !== s0.evidence.forced_cold.snapshot_sha256
      || sha256(baselineRun.reportBytes) !== s0.evidence.forced_cold.report_sha256) fail("candidate cold S0 bytes differ from archived baseline");
  const exactPerformance = path.join(out, "r", "p", "s0-exact.json");
  const exactRun = runProduct({
    seiRoot: candidate.root, repositoryRoot: fixtureRoot, out: incrementalRoot, pythonExecutable: python.executable,
    incremental: "auto", baseline: null, performancePath: exactPerformance,
  });
  const exactEvidence = evidenceForRun(exactRun, incrementalRoot);
  for (const field of ["snapshot_sha256", "report_sha256", "comparison_sha256"]) {
    if (exactEvidence[field] !== s0.evidence.incremental[field]) fail(`S0 exact replay ${field} drifted`);
  }
  if (exactEvidence.static_mode !== "exact" || exactEvidence.history_mode !== "exact"
      || exactEvidence.consumer_tasks !== 0 || exactEvidence.python_tasks !== 0) fail("S0 exact replay admitted downstream work");
  const changedPath = selectProductionPython(fixtureRoot);
  const s1Identity = commitFixtureChange(fixtureRoot, changedPath);
  const s1 = runScenario({
    name: "s1-one-file", repositoryRoot: fixtureRoot, candidate, pythonExecutable: python.executable,
    root: path.join(out, "r"), incrementalRoot, baselinePath: s0.incremental.receipt.snapshot_path,
    expectations: { expectedStaticMode: "partial", expectedStaticRecomputed: 1, expectedHistoryMode: "append", expectedHistoryAppended: 1 },
  });
  if (!(s1.evidence.incremental.python_tasks > 0)) fail("S1 did not recompute Python analysis for the changed source");
  const s2Identity = commitEmpty(fixtureRoot);
  if (s2Identity.tree !== s1Identity.tree) fail("S2 history-only commit changed the root tree");
  const s2 = runScenario({
    name: "s2-history-only", repositoryRoot: fixtureRoot, candidate, pythonExecutable: python.executable,
    root: path.join(out, "r"), incrementalRoot, baselinePath: s1.incremental.receipt.snapshot_path,
    expectations: { expectedStaticMode: "hit", expectedStaticRecomputed: 0, expectedHistoryMode: "append", expectedHistoryAppended: 1 },
  });
  if (s2.evidence.incremental.python_tasks !== 0) fail("S2 history-only run admitted Python analyzer work");
  const originalAfter = gitIdentity(sourceRoot);
  if (canonicalJson(originalAfter) !== canonicalJson(originalBefore)) fail("real CQR checkout changed during the oracle");
  const body = canonicalValue({
    schema_version: "sei.cqr-incrementality-oracle@1",
    status: "PASS",
    verdict_scope: "correctness-only-no-performance-acceptance",
    baseline_sei: baseline,
    candidate_sei: candidate,
    python,
    source: {
      root: sourceRoot,
      revision: originalBefore.revision,
      root_tree: originalBefore.tree,
      status_sha256: originalBefore.status_sha256,
      unchanged_after: true,
    },
    fixture: {
      repository_root: fixtureRoot,
      changed_path: changedPath,
      revisions: { s0: s0Identity.revision, s1: s1Identity.revision, s2: s2Identity.revision },
      root_trees: { s0: s0Identity.tree, s1: s1Identity.tree, s2: s2Identity.tree },
    },
    scenarios: [s0.evidence, s1.evidence, s2.evidence],
    exact_replay: exactEvidence,
    archived_baseline_parity: true,
    threshold_decision: "not-supplied-performance-benchmark-blocked",
  });
  const receipt = canonicalValue({ ...body, receipt_id: sha256(canonicalJson(body)) });
  const receiptPath = path.join(out, "oracle-receipt.json");
  writeFileExclusive(receiptPath, prettyJson(receipt));
  return { receipt, receiptPath };
}

function main(argv = process.argv.slice(2)) {
  try {
    const result = runCorrectnessOracle(parseArguments(argv));
    process.stdout.write(`${JSON.stringify({ status: "PASS", receipt: result.receiptPath, receipt_id: result.receipt.receipt_id })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArguments, runCorrectnessOracle, validateScenarioEvidence };
