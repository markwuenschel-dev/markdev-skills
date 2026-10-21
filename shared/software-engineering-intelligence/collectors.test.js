"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  collectLocalEvidence,
  collectGitEvidence,
  collectGitEvidenceAsync,
  collectStaticEvidence,
  collectStaticEvidenceFromIndex,
  deriveCollectorConfigurationHash,
  integratePythonStaticIntelligence,
  mergeLocalEvidence,
} = require("./collectors.js");
const COLLECTORS_PRIVATE = require("./collectors.js")[Symbol.for("sei.collectors.private.v2")];
const STATE_PRIVATE = require("./incremental-run-state.js")[Symbol.for("sei.incremental-run-state.private.v2")];
const { parseArguments } = require("./cli.js");
const CLI_PRIVATE = require("./cli.js")[Symbol.for("sei.cli.private.v1")];
const { buildRepositoryIndex } = require("./repository-index.js");
const { TaskExecutor } = require("./task-executor.js");
const {
  REVISION,
  emptyHistoryWindow,
  generatedCodeTrap,
  malformedHistory,
  monorepoSources,
  noGeneratedRuleSources,
  tinyFileTrapHistory,
} = require("./adversarial-fixtures.js");
const { materializeSnapshot, validateSnapshot } = require("./intelligence-engine.js");

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function initializeGitFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-git-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "collector@example.test"]);
  runGit(root, ["config", "user.name", "SEI Collector Test"]);
  return root;
}

function commitAll(root, message) {
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function canOpenExclusively(filePath) {
  try {
    const descriptor = fs.openSync(filePath, "r+");
    fs.closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function hangingGitCommand(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-hanging-git-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pidFile = path.join(root, "processes.txt");
  if (process.platform === "win32") {
    const quotedPidFile = pidFile.replaceAll("'", "''");
    const lockFile = path.join(root, "descendant.lock");
    const readyFile = path.join(root, "descendant.ready");
    const quotedLockFile = lockFile.replaceAll("'", "''");
    const quotedReadyFile = readyFile.replaceAll("'", "''");
    const childCommand = [
      "`$stream=[System.IO.File]::Open('", quotedLockFile,
      "',[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None);",
      "Set-Content -LiteralPath '", quotedReadyFile, "' -Value 'ready';",
      "Start-Sleep -Seconds 30",
    ].join("");
    return {
      executable: "powershell.exe",
      pidFile,
      readyFile,
      lockFile,
      repositoryRoot: `C:\\sei-missing; Set-Content -LiteralPath '${quotedPidFile}' -Value $PID; & 'powershell.exe' -NoLogo -NoProfile -NonInteractive -Command \"${childCommand}\"; #`,
    };
  }
  const executable = path.join(root, "git-hang");
  const helper = path.join(root, "git-hang.js");
  fs.writeFileSync(helper, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, \`${"${process.pid}"},${"${child.pid}"}\`);`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  fs.copyFileSync(helper, executable);
  fs.chmodSync(executable, 0o755);
  return { executable, pidFile, readyFile: pidFile, lockFile: null, repositoryRoot: root };
}

function python313() {
  if (process.env.SEI_PYTHON_313 && path.isAbsolute(process.env.SEI_PYTHON_313)) return process.env.SEI_PYTHON_313;
  const launcher = spawnSync("py", ["-3.13", "-I", "-S", "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (launcher.status === 0 && path.isAbsolute(launcher.stdout.trim())) return launcher.stdout.trim();
  throw new Error("focused T4 tests require an explicit CPython 3.13 executable (SEI_PYTHON_313)");
}

function cliExecutor() {
  return new TaskExecutor({
    maxWorkers: 2,
    resourceLimits: { io_git: 2, external_process: 1 },
    groupLimits: { "git-tree-index": 1, "git-history": 1, "git-blob-read": 1, "python-ast": 1 },
    maxMemoryWeight: 8,
  });
}

function canonicalStaticSnapshot(input, evidence) {
  const statusCounts = { measured: 0, inferred: 0, unavailable: 0, "not-applicable": 0, unverifiable: 0 };
  for (const metric of evidence.metrics) statusCounts[metric.measurement.status] += 1;
  return materializeSnapshot({
    schema_version: "1.0.0",
    snapshot_id: "pending",
    repository: {
      repository_id: "indexed-static-fixture",
      revision: input.repository_revision,
      configuration_hash: deriveCollectorConfigurationHash(input),
      history_boundary: { kind: "revision", start: null, end: input.repository_revision },
      generated_path_patterns: input.generated_path_patterns,
    },
    collectors: evidence.collectors,
    measurements: evidence.metrics,
    risk_models: [],
    profiles: [],
    evidence_summary: { measurement_count: evidence.metrics.length, status_counts: statusCounts },
    run_metadata: { generated_at: "2026-08-12T00:00:00.000Z" },
  });
}

function pythonStaticResult(input, lexicalEvidence, repositoryIndex) {
  const sourceMetric = structuredClone(lexicalEvidence.metrics.find((metric) => metric.metric_id === "static.cyclomatic_complexity"));
  const metric = (metricId, definitionId, value, family = "structural_complexity", unit = "cyclomatic-complexity-points") => ({
    ...structuredClone(sourceMetric),
    metric_id: metricId,
    definition_id: definitionId,
    family,
    subject: metricId.includes(":") ? `file:${metricId.split(":").slice(1).join(":")}` : "repository:committed-index",
    value,
    unit,
    measurement: { status: "measured", completeness: 1, confidence: 1, reason: null },
    source: {
      ...structuredClone(sourceMetric.source),
      kind: "exact-git-python-ast",
      collector_id: "python-static-intelligence",
      collector_version: "1.0.0",
      artifact_refs: [`repository-index:${repositoryIndex.binding.index_digest}`],
      evidence_refs: [`repository-index:${repositoryIndex.binding.index_digest}`],
    },
    scope: {
      ...structuredClone(sourceMetric.scope),
      kind: metricId.includes(":") ? "file" : "repository",
      path: metricId.includes(":") ? metricId.split(":").slice(1).join(":") : ".",
      language: "python",
    },
    analyzer_identity: "sei.python-ast@1",
    analyzer_version: "sei.python-ast@1",
    comparability: {
      ...structuredClone(sourceMetric.comparability),
      analyzer_identity: "sei.python-ast@1",
      analyzer_version: "sei.python-ast@1",
      configuration_hash: `sha256:${"a".repeat(64)}`,
    },
  });
  return {
    canonical: {
      analyzer: {
        analyzer_version: "sei.python-ast@1",
        parser_runtime: "cpython-3.13-stdlib-ast",
      },
      binding: {
        repository_revision: input.repository_revision,
        index_digest: repositoryIndex.binding.index_digest,
        configuration_hash: `sha256:${"a".repeat(64)}`,
        graph_cache_key: `sha256:${"c".repeat(64)}`,
        graph_evidence_key: `sha256:${"c".repeat(64)}`,
      },
      collectors: [{
        collector_id: "python-static-intelligence",
        collector_version: "1.0.0",
        status: "available",
        analyzer_identity: "sei.python-ast@1",
        analyzer_version: "sei.python-ast@1",
        reason: null,
      }],
      metrics: [
        metric("static.cyclomatic_complexity", "sei.static.cyclomatic_complexity@1", 4),
        metric("static.cyclomatic_complexity:src/model.py", "sei.static.cyclomatic_complexity@1", 4),
        metric("dependency.node_count", "sei.adapter.dependency.node_count@1", 1, "dependency_topology", "count"),
      ],
      diagnostics: { coverage: { selected_human_python: 1 } },
      facts: { complexity: {}, topology: {} },
    },
    telemetry: {
      parse: { hits: 0, misses: 1, corrupt: 0, in_flight_hits: 0, writes: 1, read_errors: 0, write_errors: 0, diagnostics: [] },
      graph: { hits: 0, misses: 1, corrupt: 0, in_flight_hits: 0, writes: 1, read_errors: 0, write_errors: 0, diagnostics: [] },
      executor_runs: 1,
      tasks_submitted: 1,
      max_in_flight: 1,
      timeouts: 0,
      cancelled: 0,
    },
  };
}

test("Python static integration replaces only the cyclomatic placeholder and preserves lexical evidence", () => {
  const input = {
    repo_root: "C:/repo",
    repository_revision: REVISION,
    generated_path_patterns: [],
    files: [
      { path: "src/model.py", content: "def answer():\n    return 42\n" },
      { path: "src/index.js", content: "export const answer = 42;\n" },
    ],
  };
  const lexicalEvidence = collectStaticEvidence(input);
  const lexicalBoundary = structuredClone({
    files: lexicalEvidence.files,
    relationships: lexicalEvidence.relationships,
    aggregates: lexicalEvidence.aggregates,
    analysis_cache: lexicalEvidence.analysis_cache,
  });
  const repositoryIndex = { binding: { repository_revision: REVISION, index_digest: `sha256:${"b".repeat(64)}` } };
  const staticIntelligence = pythonStaticResult(input, lexicalEvidence, repositoryIndex);

  const integrated = integratePythonStaticIntelligence({
    collector_input: input,
    lexical_evidence: lexicalEvidence,
    repository_index: repositoryIndex,
    static_intelligence: staticIntelligence,
  });

  assert.deepEqual({
    files: integrated.evidence.files,
    relationships: integrated.evidence.relationships,
    aggregates: integrated.evidence.aggregates,
    analysis_cache: integrated.evidence.analysis_cache,
  }, lexicalBoundary);
  assert.equal(lexicalEvidence.metrics.find((metric) => metric.metric_id === "static.cyclomatic_complexity").measurement.status, "unavailable");
  assert.equal(integrated.evidence.metrics.find((metric) => metric.metric_id === "static.cyclomatic_complexity").value, 4);
  assert.equal(integrated.evidence.metrics.find((metric) => metric.metric_id === "static.cognitive_complexity").measurement.status, "unavailable");
  assert.ok(integrated.evidence.collectors.some((collector) => collector.collector_id === "static-specialized-complexity"));
  assert.ok(integrated.evidence.collectors.some((collector) => collector.collector_id === "python-static-intelligence"));
  assert.deepEqual(
    integrated.evidence.metrics.map((metric) => metric.metric_id),
    [...new Set(integrated.evidence.metrics.map((metric) => metric.metric_id))].sort(),
  );
  assert.ok(integrated.evidence.metrics
    .filter((metric) => metric.source.collector_id === "python-static-intelligence")
    .every((metric) => metric.comparability.configuration_hash === deriveCollectorConfigurationHash(input)));
  assert.equal(integrated.evidence.metrics.find((metric) => metric.metric_id === "static.cyclomatic_complexity").subject, "repository:C:/repo");
  assert.deepEqual(integrated.telemetry, staticIntelligence.telemetry);
  assert.equal(staticIntelligence.canonical.metrics[0].comparability.configuration_hash, `sha256:${"a".repeat(64)}`);

  const stale = pythonStaticResult(input, lexicalEvidence, repositoryIndex);
  stale.canonical.binding.repository_revision = "f".repeat(40);
  assert.throws(() => integratePythonStaticIntelligence({
    collector_input: input,
    lexical_evidence: lexicalEvidence,
    repository_index: repositoryIndex,
    static_intelligence: stale,
  }), /FAIL-STATIC-INTELLIGENCE-INTEGRATION.*revision/);
});

test("CLI accepts only an explicit Python runtime input without changing the required repository arguments", () => {
  const parsed = parseArguments([
    "--repo", "C:/repo",
    "--out", "C:/out",
    "--python", "C:/Python313/python.exe",
  ]);
  assert.equal(parsed.python, path.resolve("C:/Python313/python.exe"));
  assert.equal(parseArguments(["--repo", "C:/repo", "--out", "C:/out"]).python, null);
  assert.throws(
    () => parseArguments(["--repo", "C:/repo", "--out", "C:/out", "--python", "python3.13"]),
    /FAIL-CLI-ARGUMENTS.*absolute.*Python/i,
  );
});

test("Python runtime discovery selects a Python 3 capability candidate and explicit paths take precedence", () => {
  const calls = [];
  const discovered = CLI_PRIVATE.resolvePythonRuntime(null, {
    platform: "win32",
    spawn(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: "C:\\Python313\\python.exe\r\n", stderr: "" };
    },
    realpath(value) { return value; },
  });
  assert.equal(discovered.executable, "C:\\Python313\\python.exe");
  assert.equal(discovered.source, "windows-py-3");
  assert.deepEqual(calls, [["py", ["-3", "-I", "-S", "-c", "import sys; print(sys.executable)"]]]);

  const explicit = CLI_PRIVATE.resolvePythonRuntime("C:\\Explicit\\python.exe", {
    platform: "win32",
    spawn() { throw new Error("explicit runtime must bypass discovery"); },
    realpath(value) { return value; },
  });
  assert.equal(explicit.executable, "C:\\Explicit\\python.exe");
  assert.equal(explicit.source, "explicit");

  const absent = CLI_PRIVATE.resolvePythonRuntime(null, {
    platform: "linux",
    spawn(command, args) {
      assert.equal(command, "python3");
      assert.deepEqual(args, ["-I", "-S", "-c", "import sys; print(sys.executable)"]);
      return { status: 127, stdout: "", stderr: "not found" };
    },
    realpath(value) { return value; },
  });
  assert.equal(absent.executable, null);
  assert.equal(absent.status, "unavailable");
});

test("CLI phase B projects degraded Python intelligence and keeps analyzer telemetry outside the snapshot", { timeout: 120_000 }, async (context) => {
  const root = initializeGitFixture(context);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "model.py"), "def answer(flag):\n    if flag:\n        return 42\n    return 0\n", "utf8");
  const revision = commitAll(root, "python fixture");
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-cli-"));
  context.after(() => fs.rmSync(support, { recursive: true, force: true }));
  const out = path.join(support, "out");
  const configPath = path.join(support, "config.json");
  const performancePath = path.join(support, "performance.json");
  fs.writeFileSync(configPath, JSON.stringify({ generated_path_patterns: [] }), "utf8");
  const executor = cliExecutor();
  const { executeWithExecutor } = CLI_PRIVATE;

  const receipt = await executeWithExecutor([
    "--repo", root,
    "--out", out,
    "--config", configPath,
    "--performance-json", performancePath,
    "--python", path.join(root, "missing-python-3.13.exe"),
  ], executor);

  assert.equal(receipt.revision, revision);
  const snapshot = JSON.parse(fs.readFileSync(receipt.snapshot_path, "utf8"));
  const cyclomatic = snapshot.measurements.find((metric) => metric.metric_id === "static.cyclomatic_complexity");
  assert.equal(cyclomatic.measurement.status, "unavailable");
  assert.equal(cyclomatic.source.collector_id, "python-static-intelligence");
  assert.ok(cyclomatic.source.artifact_refs.some((ref) => ref.startsWith("python-configuration:sha256:")));
  assert.ok(cyclomatic.source.artifact_refs.some((ref) => ref.startsWith("python-runtime:")));
  assert.equal(snapshot.measurements.find((metric) => metric.metric_id === "static.cognitive_complexity").source.collector_id, "static-specialized-complexity");
  assert.ok(snapshot.measurements.every((metric) => metric.comparability.configuration_hash === snapshot.repository.configuration_hash));
  assert.doesNotMatch(JSON.stringify(snapshot), /tasks_submitted|executor_runs|max_in_flight/);

  const performance = JSON.parse(fs.readFileSync(performancePath, "utf8"));
  assert.equal(performance.python_static_intelligence.status, "unavailable");
  assert.equal(performance.python_static_intelligence.tasks_submitted, 1);
  assert.equal(performance.python_static_intelligence.tasks_completed, 1);
  assert.equal(performance.python_static_intelligence.batch_count, 1);
  assert.equal(performance.python_static_intelligence.subprocess_count, 1);
  assert.equal(performance.python_static_intelligence.timeouts, 0);
  assert.equal(performance.python_static_intelligence.cancelled, 0);
  assert.equal(performance.executor.phases.python_static.tasks_submitted, 1);

  const wrongOut = path.join(support, "wrong-out");
  const wrongReceipt = await executeWithExecutor([
    "--repo", root,
    "--out", wrongOut,
    "--config", configPath,
    "--python", process.execPath,
  ], cliExecutor());
  const wrongSnapshot = JSON.parse(fs.readFileSync(wrongReceipt.snapshot_path, "utf8"));
  assert.equal(wrongSnapshot.measurements.find((metric) => metric.metric_id === "static.cyclomatic_complexity").measurement.status, "unavailable");
});

test("CLI discovers no ambient fallback and reports an absent exact candidate as unavailable", { timeout: 120_000 }, async (context) => {
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "model.py"), "def answer():\n    return 42\n", "utf8");
  commitAll(root, "python fixture");
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-absent-"));
  context.after(() => fs.rmSync(support, { recursive: true, force: true }));
  const out = path.join(support, "out");
  const configPath = path.join(support, "config.json");
  const performancePath = path.join(support, "performance.json");
  fs.writeFileSync(configPath, JSON.stringify({ generated_path_patterns: [] }), "utf8");

  const receipt = await CLI_PRIVATE.executeWithExecutor([
    "--repo", root,
    "--out", out,
    "--config", configPath,
    "--performance-json", performancePath,
  ], cliExecutor(), {
    resolvePythonRuntime() {
      return { executable: null, source: "unavailable", status: "unavailable", reason: "controlled exact candidate absence" };
    },
  });
  const snapshot = JSON.parse(fs.readFileSync(receipt.snapshot_path, "utf8"));
  const cyclomatic = snapshot.measurements.find((metric) => metric.metric_id === "static.cyclomatic_complexity");
  assert.equal(cyclomatic.measurement.status, "unavailable");
  assert.match(cyclomatic.measurement.reason, /FAIL-PYTHON-AST-RUNTIME-UNAVAILABLE.*controlled exact candidate absence/);
  const performance = JSON.parse(fs.readFileSync(performancePath, "utf8"));
  assert.equal(performance.python_static_intelligence.status, "unavailable");
  assert.equal(performance.python_static_intelligence.reason, "controlled exact candidate absence");
  assert.equal(performance.python_static_intelligence.tasks_submitted, 0);
});

test("CLI analyzer cache publishes atomically and reuses cold facts without changing the canonical snapshot", { timeout: 180_000 }, async (context) => {
  const root = initializeGitFixture(context);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "model.py"), "def answer(flag):\n    if flag:\n        return 42\n    return 0\n", "utf8");
  commitAll(root, "python fixture");
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-cache-"));
  context.after(() => fs.rmSync(support, { recursive: true, force: true }));
  const out = path.join(support, "out");
  const configPath = path.join(support, "config.json");
  const coldPerformancePath = path.join(support, "cold-performance.json");
  const warmPerformancePath = path.join(support, "warm-performance.json");
  fs.writeFileSync(configPath, JSON.stringify({ generated_path_patterns: [] }), "utf8");
  const argv = ["--repo", root, "--out", out, "--config", configPath, "--python", python313()];

  const cold = await CLI_PRIVATE.executeWithExecutor([...argv, "--performance-json", coldPerformancePath], cliExecutor());
  const coldBytes = fs.readFileSync(cold.snapshot_path, "utf8");
  const coldSnapshot = JSON.parse(coldBytes);
  const coldCyclomatic = coldSnapshot.measurements.find((metric) => metric.metric_id === "static.cyclomatic_complexity");
  assert.equal(coldCyclomatic.measurement.status, "measured");
  assert.equal(coldCyclomatic.value, 2);
  assert.equal(coldCyclomatic.scope.language, "python");
  const coldPerformance = JSON.parse(fs.readFileSync(coldPerformancePath, "utf8"));
  assert.ok(coldPerformance.python_static_intelligence.cache.parse.writes > 0);
  assert.ok(coldPerformance.python_static_intelligence.cache.graph.writes > 0);
  assert.ok(coldPerformance.python_static_intelligence.tasks_submitted > 0);

  const warm = await CLI_PRIVATE.executeWithExecutor([...argv, "--performance-json", warmPerformancePath], cliExecutor());
  const warmBytes = fs.readFileSync(warm.snapshot_path, "utf8");
  const warmPerformance = JSON.parse(fs.readFileSync(warmPerformancePath, "utf8"));
  assert.equal(warmBytes, coldBytes);
  assert.equal(warmPerformance.python_static_intelligence.status, "replayed", JSON.stringify(warmPerformance.incremental_stages));
  assert.equal(warmPerformance.python_static_intelligence.cache.parse, null);
  assert.equal(warmPerformance.python_static_intelligence.cache.graph, null);
  assert.equal(warmPerformance.python_static_intelligence.tasks_submitted, 0);
  assert.equal(warmPerformance.incremental_stages.static.reuse.mode, "exact");
  assert.equal(warmPerformance.incremental_stages.history.reuse.mode, "exact");
});

test("CLI captures cold, exact, one-file, and dependency-closure incremental telemetry", { timeout: 180_000 }, async (context) => {
  const root = initializeGitFixture(context);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "leaf.py"), "def value():\n    return 1\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "consumer.py"), "from leaf import value\n\ndef answer():\n    return value()\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "isolated.py"), "def isolated():\n    return 1\n", "utf8");
  const firstRevision = commitAll(root, "dependency root");
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "sei-dependency-admission-"));
  context.after(() => fs.rmSync(support, { recursive: true, force: true }));
  const out = path.join(support, "out");
  const configPath = path.join(support, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ generated_path_patterns: [] }), "utf8");
  const argv = ["--repo", root, "--out", out, "--config", configPath, "--python", python313()];

  const cold = await CLI_PRIVATE.executeWithExecutor(argv, cliExecutor());
  assert.equal(cold.revision, firstRevision);
  assert.equal(cold.performance.incremental_stages.static.invalidation.mode, "cold");

  const unchanged = await CLI_PRIVATE.executeWithExecutor(argv, cliExecutor());
  assert.equal(unchanged.cache, "hit");
  assert.equal(unchanged.performance.incremental_stages.static.reuse.mode, "exact");

  fs.writeFileSync(path.join(root, "src", "isolated.py"), "def isolated():\n    return 2\n", "utf8");
  const isolatedRevision = commitAll(root, "change isolated source");
  const isolated = await CLI_PRIVATE.executeWithExecutor(argv, cliExecutor());
  assert.equal(isolated.revision, isolatedRevision);
  assert.deepEqual(isolated.performance.static_analysis_cache, {
    cache: "partial",
    reused_file_count: 2,
    recomputed_file_count: 1,
  });
  assert.equal(isolated.performance.python_static_intelligence.cache.parse.hits, 2);
  assert.equal(isolated.performance.python_static_intelligence.cache.parse.misses, 1);
  assert.equal(isolated.performance.incremental_stages.static.invalidation.affected_node_count, 1);

  fs.writeFileSync(path.join(root, "src", "leaf.py"), "def value():\n    return 2\n", "utf8");
  const secondRevision = commitAll(root, "change imported leaf");
  const changed = await CLI_PRIVATE.executeWithExecutor(argv, cliExecutor());
  assert.equal(changed.revision, secondRevision);
  assert.deepEqual(changed.performance.static_analysis_cache, {
    cache: "partial",
    reused_file_count: 2,
    recomputed_file_count: 1,
  });
  assert.equal(changed.performance.python_static_intelligence.cache.parse.hits, 2);
  assert.equal(changed.performance.python_static_intelligence.cache.parse.misses, 1);
  assert.equal(changed.performance.python_static_intelligence.cache.graph.hits, 0);
  assert.equal(changed.performance.python_static_intelligence.cache.graph.misses, 1);
  assert.deepEqual(changed.performance.incremental_stages.static.invalidation, {
    mode: "recompute",
    status: "incremental",
    reason: "dependency closure requires recomputation",
    plan_digest: changed.performance.incremental_stages.static.invalidation.plan_digest,
    ancestry_relationship: "strict-ancestor",
    prior_repository_revision: isolatedRevision,
    current_repository_revision: secondRevision,
    changed_path_count: 1,
    affected_node_count: 2,
    directly_invalidated_record_count: 3,
    dependency_invalidated_record_count: 1,
    reusable_record_count: 3,
    topology_recompute: true,
  });
  assert.match(changed.performance.incremental_stages.static.invalidation.plan_digest, /^sha256:[0-9a-f]{64}$/);
  context.diagnostic(JSON.stringify({
    cold: {
      static: cold.performance.incremental_stages.static,
      history: cold.performance.incremental_stages.history.reuse,
    },
    unchanged: {
      cache: unchanged.cache,
      static: unchanged.performance.incremental_stages.static.reuse,
      history: unchanged.performance.incremental_stages.history.reuse,
    },
    one_file: {
      static: isolated.performance.incremental_stages.static,
      python_cache: isolated.performance.python_static_intelligence.cache,
    },
    dependency_change: {
      static: changed.performance.incremental_stages.static,
      python_cache: changed.performance.python_static_intelligence.cache,
    },
  }));
});

test("CLI strict-descendant history append reuses dependency state without stale canonical evidence", { timeout: 180_000 }, async (context) => {
  const root = initializeGitFixture(context);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "leaf.py"), "def value():\n    return 1\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "consumer.py"), "from leaf import value\n\ndef answer():\n    return value()\n", "utf8");
  commitAll(root, "history root");
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "sei-history-only-admission-"));
  context.after(() => fs.rmSync(support, { recursive: true, force: true }));
  const out = path.join(support, "out");
  const configPath = path.join(support, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ generated_path_patterns: [] }), "utf8");
  const baseArgv = ["--repo", root, "--config", configPath, "--python", python313()];
  const first = await CLI_PRIVATE.executeWithExecutor([...baseArgv, "--out", out], cliExecutor());

  runGit(root, ["commit", "--quiet", "--allow-empty", "-m", "history only"]);
  const incremental = await CLI_PRIVATE.executeWithExecutor([
    ...baseArgv,
    "--out", out,
    "--baseline", first.snapshot_path,
  ], cliExecutor());
  assert.equal(incremental.performance.incremental_stages.static.reuse.mode, "hit");
  assert.equal(incremental.performance.incremental_stages.static.reuse.recomputed_file_count, 0);
  assert.equal(incremental.performance.incremental_stages.static.invalidation.mode, "reuse");
  assert.equal(incremental.performance.incremental_stages.static.invalidation.affected_node_count, 0);
  assert.equal(incremental.performance.python_static_intelligence.cache.parse.hits, 2);
  assert.equal(incremental.performance.python_static_intelligence.cache.graph.hits, 1);
  assert.equal(incremental.performance.python_static_intelligence.cache.graph.materializations, 0);
  assert.equal(incremental.performance.incremental_stages.history.reuse.mode, "append");
  assert.equal(incremental.performance.incremental_stages.history.reuse.appended_commit_count, 1);

  const coldOut = path.join(support, "cold-out");
  const cold = await CLI_PRIVATE.executeWithExecutor([
    ...baseArgv,
    "--out", coldOut,
    "--baseline", first.snapshot_path,
    "--incremental", "off",
  ], cliExecutor());
  assert.equal(fs.readFileSync(incremental.snapshot_path, "utf8"), fs.readFileSync(cold.snapshot_path, "utf8"));
  assert.equal(fs.readFileSync(incremental.report_path, "utf8"), fs.readFileSync(cold.report_path, "utf8"));
  assert.deepEqual(incremental.comparison, cold.comparison);
});

test("CLI publishes snapshot and canonical cache paths as one immutable physical artifact", { timeout: 180_000 }, async (context) => {
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n", "utf8");
  commitAll(root, "physical snapshot fixture");
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "sei-physical-snapshot-"));
  context.after(() => fs.rmSync(support, { recursive: true, force: true }));
  const configPath = path.join(support, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ generated_path_patterns: [] }), "utf8");
  for (const [mode, out] of [
    ["auto", path.join(support, "auto-out")],
    ["off", path.join(support, "off-out")],
  ]) {
    const execute = () => CLI_PRIVATE.executeWithExecutor([
        "--repo", root,
        "--out", out,
        "--config", configPath,
        "--incremental", mode,
      ], cliExecutor(), {
        resolvePythonRuntime() {
          return { executable: null, source: "unavailable", status: "unavailable", reason: "controlled exact candidate absence" };
        },
      });
    const receipt = await execute();
    const snapshot = JSON.parse(fs.readFileSync(receipt.snapshot_path, "utf8"));
    const cachePath = path.join(out, "cache", snapshot.run_metadata.cache.cache_key, `${snapshot.snapshot_id}.json`);
    const assertSharedIdentity = (label) => {
      assert.equal(fs.readFileSync(cachePath, "utf8"), fs.readFileSync(receipt.snapshot_path, "utf8"), label);
      const snapshotStat = fs.statSync(receipt.snapshot_path, { bigint: true });
      const cacheStat = fs.statSync(cachePath, { bigint: true });
      assert.equal(`${snapshotStat.dev}:${snapshotStat.ino}`, `${cacheStat.dev}:${cacheStat.ino}`, label);
    };
    assertSharedIdentity(`${mode}:cold`);

    fs.unlinkSync(cachePath);
    await execute();
    assertSharedIdentity(`${mode}:cache-restored`);

    fs.unlinkSync(receipt.snapshot_path);
    await execute();
    assertSharedIdentity(`${mode}:snapshot-restored`);
  }
});

test("CLI cancellation before publication leaves no snapshot, report, or buffered analyzer cache", { timeout: 120_000 }, async (context) => {
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "model.py"), "def answer():\n    return 42\n", "utf8");
  commitAll(root, "python fixture");
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-cancel-"));
  context.after(() => fs.rmSync(support, { recursive: true, force: true }));
  const out = path.join(support, "out");
  const configPath = path.join(support, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ generated_path_patterns: [] }), "utf8");
  const controller = new AbortController();
  controller.abort(new Error("controlled pre-publication cancellation"));

  await assert.rejects(CLI_PRIVATE.executeWithExecutor([
    "--repo", root,
    "--out", out,
    "--config", configPath,
    "--python", python313(),
  ], cliExecutor(), { signal: controller.signal }), /FAIL-CLI-COLLECTION.*controlled pre-publication cancellation/);
  assert.equal(fs.existsSync(out), false);
});

test("CLI rejects internal and external dependency topology ownership before output", { timeout: 120_000 }, async (context) => {
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "model.py"), "def answer():\n    return 42\n", "utf8");
  commitAll(root, "python fixture");
  const support = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-collision-"));
  context.after(() => fs.rmSync(support, { recursive: true, force: true }));
  const out = path.join(support, "out");
  const configPath = path.join(support, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    generated_path_patterns: [],
    adapter_evidence: { adapters: [{ adapter_id: "dependency-topology", kind: "dependency_topology" }] },
  }), "utf8");
  const executor = cliExecutor();
  const { executeWithExecutor } = CLI_PRIVATE;

  await assert.rejects(executeWithExecutor([
    "--repo", root,
    "--out", out,
    "--config", configPath,
    "--python", python313(),
  ], executor), /FAIL-CLI-COLLECTION.*dependency topology.*overlap/i);
  assert.equal(fs.existsSync(out), false);
});

test("indexed static evidence is byte-identical to the supplied-row compatibility seam", async (context) => {
  const root = initializeGitFixture(context);
  const sources = new Map([
    ["src/index.js", "export function answer() { return 42; }\n"],
    ["src/model.py", "def answer():\n    return 42\n"],
    ["src/view.tsx", "export const View = () => <main />;\n"],
    ["src/Answer.java", "class Answer { int value() { return 42; } }\n"],
    ["bin/tool.js", "#!/usr/bin/env node\nconsole.log('tool');\n"],
    ["tests/index.test.js", "test('answer', () => answer());\n"],
    ["generated/client.ts", "export const generated = true;\n"],
    ["vendor/library.js", "export const vendored = true;\n"],
  ]);
  for (const [relativePath, content] of sources) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content, "utf8");
  }
  fs.writeFileSync(path.join(root, "notes.data"), "not source\n", "utf8");
  runGit(root, ["add", "--all"]);
  runGit(root, ["update-index", "--chmod=+x", "bin/tool.js"]);
  const linkOid = runGit(root, ["rev-parse", ":src/index.js"]);
  runGit(root, ["update-index", "--add", "--cacheinfo", `120000,${linkOid},src/link.js`]);
  runGit(root, ["commit", "--quiet", "-m", "indexed static fixture"]);
  const revision = runGit(root, ["rev-parse", "HEAD"]);
  const input = {
    repo_root: root,
    repository_revision: revision,
    generated_path_patterns: ["generated/**"],
  };
  const expected = collectStaticEvidence({
    ...input,
    files: [...sources].map(([relativePath, content]) => ({
      path: relativePath,
      object_id: runGit(root, ["rev-parse", `${revision}:${relativePath}`]),
      content,
    })),
  });
  const index = await buildRepositoryIndex({
    repository_root: root,
    repository_revision: revision,
    generated_path_patterns: input.generated_path_patterns,
  });
  const actual = await collectStaticEvidenceFromIndex(input, index, { signal: new AbortController().signal });
  assert.equal(JSON.stringify(actual), JSON.stringify({
    ...expected,
    metrics: expected.metrics.map((metric) => metric.source.collector_id === "static-source" ? ({
      ...metric,
      source: { ...metric.source, kind: "local-source" },
    }) : metric),
    analysis_cache: { cache: "miss", reused_file_count: 0, recomputed_file_count: sources.size },
  }));
  const configurationHash = deriveCollectorConfigurationHash(input);
  assert.ok(actual.metrics.every((metric) => metric.comparability.configuration_hash === configurationHash));
  const git = collectGitEvidence({ ...input, commits: [] });
  assert.equal(mergeLocalEvidence(actual, git).metrics.length, actual.metrics.length + git.metrics.length);
});

test("supplied static aliases and deterministic merge retain the synchronous compatibility contract", () => {
  const sourceInput = monorepoSources();
  const { files, ...base } = sourceInput;
  const expected = collectStaticEvidence({ ...base, files });
  for (const alias of ["files", "source_files", "sources"]) {
    assert.equal(JSON.stringify(collectStaticEvidence({ ...base, [alias]: files })), JSON.stringify(expected), alias);
  }
  const historyInput = { ...tinyFileTrapHistory(), generated_path_patterns: [] };
  const gitEvidence = collectGitEvidence(historyInput);
  assert.equal(
    JSON.stringify(mergeLocalEvidence(expected, gitEvidence)),
    JSON.stringify(mergeLocalEvidence(expected, gitEvidence)),
  );
  assert.throws(() => mergeLocalEvidence({}, gitEvidence), /FAIL-MALFORMED-LOCAL-EVIDENCE/);
  assert.throws(() => collectLocalEvidence({ ...base, files }), /FAIL-REPOSITORY-INDEX-REQUIRED/);
});

test("indexed static reuse binds path, OID, language, and generated classification", async (context) => {
  const root = initializeGitFixture(context);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "stable.js"), "export const stable = true;\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "changed.js"), "export const changed = 1;\n", "utf8");
  const firstRevision = commitAll(root, "first");
  const firstInput = { repo_root: root, repository_revision: firstRevision, generated_path_patterns: [] };
  const firstIndex = await buildRepositoryIndex({ repository_root: root, repository_revision: firstRevision, generated_path_patterns: [] });
  const first = await collectStaticEvidenceFromIndex(firstInput, firstIndex, {});
  const prior = canonicalStaticSnapshot(firstInput, first);

  const hit = await collectStaticEvidenceFromIndex({ ...firstInput, prior_static_snapshot: prior }, firstIndex, {});
  assert.deepEqual(hit.analysis_cache, { cache: "hit", reused_file_count: 2, recomputed_file_count: 0 });

  fs.writeFileSync(path.join(root, "src", "changed.js"), "export const changed = 2;\n", "utf8");
  const secondRevision = commitAll(root, "second");
  const secondInput = { ...firstInput, repository_revision: secondRevision, prior_static_snapshot: prior };
  const secondIndex = await buildRepositoryIndex({ repository_root: root, repository_revision: secondRevision, generated_path_patterns: [] });
  const partial = await collectStaticEvidenceFromIndex(secondInput, secondIndex, {});
  assert.deepEqual(partial.analysis_cache, { cache: "partial", reused_file_count: 1, recomputed_file_count: 1 });
});

test("compact static state reuses unchanged blobs and recomputes only one changed source", async (context) => {
  assert.equal(typeof COLLECTORS_PRIVATE.collectStaticEvidenceIncremental, "function");
  const root = initializeGitFixture(context);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "stable.py"), "def stable():\n    return 1\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "changed.py"), "def changed():\n    return 1\n", "utf8");
  const firstRevision = commitAll(root, "first compact state");
  const baseInput = { repo_root: root, repository_revision: firstRevision, generated_path_patterns: [] };
  const firstIndex = await buildRepositoryIndex({ repository_root: root, repository_revision: firstRevision, generated_path_patterns: [] });
  const first = await COLLECTORS_PRIVATE.collectStaticEvidenceIncremental(baseInput, firstIndex, {
    repository_id: "repo:compact-static",
    prior_stages: [],
  });
  assert.deepEqual(first.evidence.analysis_cache, { cache: "miss", reused_file_count: 0, recomputed_file_count: 2 });
  assert.equal(STATE_PRIVATE.readStage(first.stage, "static").entries.length, 2);

  const exact = await COLLECTORS_PRIVATE.collectStaticEvidenceIncremental(baseInput, firstIndex, {
    repository_id: "repo:compact-static",
    prior_stages: [first.stage],
  });
  assert.deepEqual(exact.evidence.analysis_cache, { cache: "hit", reused_file_count: 2, recomputed_file_count: 0 });
  assert.equal(exact.telemetry.reused_file_count, 2);

  fs.writeFileSync(path.join(root, "src", "changed.py"), "def changed():\n    return 2\n", "utf8");
  const secondRevision = commitAll(root, "change one source");
  const secondInput = { ...baseInput, repository_revision: secondRevision };
  const secondIndex = await buildRepositoryIndex({ repository_root: root, repository_revision: secondRevision, generated_path_patterns: [] });
  const partial = await COLLECTORS_PRIVATE.collectStaticEvidenceIncremental(secondInput, secondIndex, {
    repository_id: "repo:compact-static",
    prior_stages: [first.stage],
  });
  const cold = await collectStaticEvidenceFromIndex(secondInput, secondIndex, {});
  const { analysis_cache: partialCache, ...partialCanonicalEvidence } = partial.evidence;
  const { analysis_cache: coldCache, ...coldCanonicalEvidence } = cold;
  assert.equal(JSON.stringify(partialCanonicalEvidence), JSON.stringify(coldCanonicalEvidence));
  assert.deepEqual(coldCache, { cache: "miss", reused_file_count: 0, recomputed_file_count: 2 });
  assert.deepEqual(partial.evidence.analysis_cache, { cache: "partial", reused_file_count: 1, recomputed_file_count: 1 });
  assert.equal(partial.telemetry.recomputed_file_count, 1);

  fs.renameSync(path.join(root, "src", "stable.py"), path.join(root, "src", "renamed.py"));
  const renamedRevision = commitAll(root, "rename unchanged source");
  const renamedInput = { ...baseInput, repository_revision: renamedRevision };
  const renamedIndex = await buildRepositoryIndex({ repository_root: root, repository_revision: renamedRevision, generated_path_patterns: [] });
  const renamed = await COLLECTORS_PRIVATE.collectStaticEvidenceIncremental(renamedInput, renamedIndex, {
    repository_id: "repo:compact-static",
    prior_stages: [partial.stage],
  });
  assert.deepEqual(renamed.evidence.analysis_cache, { cache: "hit", reused_file_count: 2, recomputed_file_count: 0 });
  const renamedCold = await collectStaticEvidenceFromIndex(renamedInput, renamedIndex, {});
  assert.deepEqual(
    { ...renamed.evidence, analysis_cache: renamedCold.analysis_cache },
    renamedCold,
  );

  const configDrift = await COLLECTORS_PRIVATE.collectStaticEvidenceIncremental({
    ...renamedInput,
    generated_path_patterns: ["src/renamed.py"],
  }, await buildRepositoryIndex({
    repository_root: root,
    repository_revision: renamedRevision,
    generated_path_patterns: ["src/renamed.py"],
  }), {
    repository_id: "repo:compact-static",
    prior_stages: [renamed.stage],
  });
  assert.deepEqual(configDrift.evidence.analysis_cache, { cache: "miss", reused_file_count: 0, recomputed_file_count: 2 });

  const analyzerDrift = await COLLECTORS_PRIVATE.collectStaticEvidenceIncremental({
    ...renamedInput,
    static_analyzer_version: "2.0.0",
  }, renamedIndex, {
    repository_id: "repo:compact-static",
    prior_stages: [renamed.stage],
  });
  assert.deepEqual(analyzerDrift.evidence.analysis_cache, { cache: "miss", reused_file_count: 0, recomputed_file_count: 2 });

  fs.unlinkSync(path.join(root, "src", "changed.py"));
  const deletedRevision = commitAll(root, "delete one source");
  const deletedInput = { ...baseInput, repository_revision: deletedRevision };
  const deletedIndex = await buildRepositoryIndex({ repository_root: root, repository_revision: deletedRevision, generated_path_patterns: [] });
  const deleted = await COLLECTORS_PRIVATE.collectStaticEvidenceIncremental(deletedInput, deletedIndex, {
    repository_id: "repo:compact-static",
    prior_stages: [renamed.stage],
  });
  assert.deepEqual(deleted.evidence.analysis_cache, { cache: "hit", reused_file_count: 1, recomputed_file_count: 0 });
  assert.equal(deleted.evidence.files.some((file) => file.path === "src/changed.py"), false);

  const preAborted = new AbortController();
  preAborted.abort(new Error("compact static cancelled"));
  await assert.rejects(
    COLLECTORS_PRIVATE.collectStaticEvidenceIncremental(renamedInput, renamedIndex, {
      repository_id: "repo:compact-static",
      prior_stages: [renamed.stage],
      signal: preAborted.signal,
    }),
    /FAIL-REPOSITORY-INDEX-CANCELLED/,
  );
});

test("compact history state hits exact revisions and appends one empty descendant commit with cold parity", async (context) => {
  assert.equal(typeof COLLECTORS_PRIVATE.collectGitEvidenceIncremental, "function");
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n", "utf8");
  const firstRevision = commitAll(root, "history root");
  const firstInput = {
    repo_root: root,
    repository_revision: firstRevision,
    generated_path_patterns: [],
    history_window: { kind: "revision-range", start: firstRevision, end: firstRevision, auto_root_inclusive: true },
  };
  const firstPending = COLLECTORS_PRIVATE.collectGitEvidenceIncremental(firstInput, {
    repository_id: "repo:compact-history",
    prior_stages: [],
  });
  assert.equal(typeof firstPending?.then, "function");
  const first = await firstPending;
  assert.equal(first.telemetry.mode, "cold");
  assert.equal(STATE_PRIVATE.readStage(first.stage, "history").commits.length, 1);

  const exact = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental(firstInput, {
    repository_id: "repo:compact-history",
    prior_stages: [first.stage],
  });
  assert.equal(exact.telemetry.mode, "hit");
  assert.equal(exact.telemetry.appended_commit_count, 0);
  assert.equal(JSON.stringify(exact.evidence), JSON.stringify(first.evidence));

  runGit(root, ["commit", "--quiet", "--allow-empty", "-m", "history only"]);
  const secondRevision = runGit(root, ["rev-parse", "HEAD"]);
  const secondInput = {
    ...firstInput,
    repository_revision: secondRevision,
    history_window: { ...firstInput.history_window, end: secondRevision },
  };
  const appendCommands = [];
  const appended = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental({
    ...secondInput,
    git_observer: (event) => appendCommands.push(event),
  }, {
    repository_id: "repo:compact-history",
    prior_stages: [first.stage],
  });
  const cold = collectGitEvidence(secondInput);
  assert.equal(appended.telemetry.mode, "append");
  assert.equal(appended.telemetry.reused_commit_count, 1);
  assert.equal(appended.telemetry.appended_commit_count, 1);
  assert.equal(JSON.stringify(appended.evidence), JSON.stringify(cold));
  assert.equal(STATE_PRIVATE.readStage(appended.stage, "history").commits.length, 2);
  assert.ok(appendCommands.some((event) => event.command.join(" ")
    .includes(`rev-list --reverse --topo-order ${firstRevision}..${secondRevision}`)));
  const appendedShows = appendCommands.filter((event) => event.command[0] === "show");
  assert.equal(appendedShows.length, 2);
  assert.ok(appendedShows.every((event) => event.command.includes(secondRevision) && !event.command.includes(firstRevision)));

  const policyDrift = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental({
    ...secondInput,
    temporal_coupling_policy: { threshold: 9, action: "down_weight" },
  }, {
    repository_id: "repo:compact-history",
    prior_stages: [appended.stage],
  });
  assert.equal(policyDrift.telemetry.mode, "cold");
  assert.equal(JSON.stringify(policyDrift.evidence), JSON.stringify(collectGitEvidence({
    ...secondInput,
    temporal_coupling_policy: { threshold: 9, action: "down_weight" },
  })));

  const corrupt = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental(secondInput, {
    repository_id: "repo:compact-history",
    prior_stages: [appended.stage, Object.freeze({})],
  });
  assert.equal(corrupt.telemetry.mode, "cold");
  assert.match(corrupt.telemetry.reason, /corrupt/i);
  assert.equal(JSON.stringify(corrupt.evidence), JSON.stringify(cold));

  const preAborted = new AbortController();
  preAborted.abort(new Error("compact history cancelled"));
  await assert.rejects(
    COLLECTORS_PRIVATE.collectGitEvidenceIncremental(secondInput, {
      repository_id: "repo:compact-history",
      prior_stages: [appended.stage],
      signal: preAborted.signal,
    }),
    /compact history cancelled/,
  );
});

test("compact history append preserves binary and divergent-history cold semantics", async (context) => {
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n", "utf8");
  const rootRevision = commitAll(root, "history root");
  const baseInput = {
    repo_root: root,
    repository_revision: rootRevision,
    generated_path_patterns: [],
    history_window: { kind: "revision-range", start: rootRevision, end: rootRevision, auto_root_inclusive: true },
  };
  const base = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental(baseInput, {
    repository_id: "repo:history-negatives",
    prior_stages: [],
  });

  fs.writeFileSync(path.join(root, "asset.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  const binaryRevision = commitAll(root, "binary append");
  const binaryInput = {
    ...baseInput,
    repository_revision: binaryRevision,
    history_window: { ...baseInput.history_window, end: binaryRevision },
  };
  const binary = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental(binaryInput, {
    repository_id: "repo:history-negatives",
    prior_stages: [base.stage],
  });
  assert.equal(binary.telemetry.mode, "append");
  assert.equal(JSON.stringify(binary.evidence), JSON.stringify(collectGitEvidence(binaryInput)));
  const binaryRow = STATE_PRIVATE.readStage(binary.stage, "history").commits
    .flatMap((commit) => commit.files)
    .find((file) => file.path === "asset.bin");
  assert.equal(binaryRow.binary_change, true);
  assert.equal(binaryRow.added, null);
  assert.equal(binaryRow.deleted, null);

  runGit(root, ["switch", "--quiet", "-c", "side", rootRevision]);
  fs.writeFileSync(path.join(root, "side.js"), "export const side = true;\n", "utf8");
  const sideRevision = commitAll(root, "side branch");
  const sideInput = {
    ...baseInput,
    repository_revision: sideRevision,
    history_window: { ...baseInput.history_window, end: sideRevision },
  };
  const side = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental(sideInput, {
    repository_id: "repo:history-negatives",
    prior_stages: [base.stage],
  });

  runGit(root, ["switch", "--quiet", "--detach", binaryRevision]);
  fs.writeFileSync(path.join(root, "main.js"), "export const main = true;\n", "utf8");
  const currentRevision = commitAll(root, "divergent main");
  const currentInput = {
    ...baseInput,
    repository_revision: currentRevision,
    history_window: { ...baseInput.history_window, end: currentRevision },
  };
  const divergent = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental(currentInput, {
    repository_id: "repo:history-negatives",
    prior_stages: [side.stage],
  });
  assert.equal(divergent.telemetry.mode, "cold");
  assert.equal(JSON.stringify(divergent.evidence), JSON.stringify(collectGitEvidence(currentInput)));
});

test("compact history append retains merge commits as attributed-empty rows with cold parity", async (context) => {
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "index.js"), "export const root = true;\n", "utf8");
  const rootRevision = commitAll(root, "merge root");
  const mainBranch = runGit(root, ["branch", "--show-current"]);
  const baseInput = {
    repo_root: root,
    repository_revision: rootRevision,
    generated_path_patterns: [],
    history_window: { kind: "revision-range", start: rootRevision, end: rootRevision, auto_root_inclusive: true },
  };
  const base = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental(baseInput, {
    repository_id: "repo:history-merge",
    prior_stages: [],
  });

  runGit(root, ["switch", "--quiet", "-c", "feature"]);
  fs.writeFileSync(path.join(root, "feature.js"), "export const feature = true;\n", "utf8");
  commitAll(root, "feature change");
  runGit(root, ["switch", "--quiet", mainBranch]);
  fs.writeFileSync(path.join(root, "main.js"), "export const main = true;\n", "utf8");
  commitAll(root, "main change");
  runGit(root, ["merge", "--quiet", "--no-ff", "feature", "-m", "merge feature"]);
  const mergeRevision = runGit(root, ["rev-parse", "HEAD"]);
  const mergeInput = {
    ...baseInput,
    repository_revision: mergeRevision,
    history_window: { ...baseInput.history_window, end: mergeRevision },
  };
  const appended = await COLLECTORS_PRIVATE.collectGitEvidenceIncremental(mergeInput, {
    repository_id: "repo:history-merge",
    prior_stages: [base.stage],
  });
  assert.equal(appended.telemetry.mode, "append");
  assert.equal(JSON.stringify(appended.evidence), JSON.stringify(collectGitEvidence(mergeInput)));
  const mergeRow = STATE_PRIVATE.readStage(appended.stage, "history").commits.find((commit) => commit.revision === mergeRevision);
  assert.equal(mergeRow.is_merge, true);
  assert.deepEqual(mergeRow.files, []);
});

test("indexed static rejects mismatched and foreign entries and degrades an oversized source without reading it", async (context) => {
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n", "utf8");
  const revision = commitAll(root, "fixture");
  const input = { repo_root: root, repository_revision: revision, generated_path_patterns: [] };
  const index = await buildRepositoryIndex({ repository_root: root, repository_revision: revision, generated_path_patterns: [] });

  await assert.rejects(
    collectStaticEvidenceFromIndex({ ...input, repository_revision: "f".repeat(40) }, index, {}),
    /FAIL-REPOSITORY-INDEX-REVISION-MISMATCH/,
  );
  await assert.rejects(
    collectStaticEvidenceFromIndex(input, { ...index, entries: index.entries.map((entry) => ({ ...entry })) }, {}),
    /FAIL-REPOSITORY-INDEX-BLOB.*owned/,
  );

  let reads = 0;
  const oversized = await collectStaticEvidenceFromIndex(input, {
    binding: index.binding,
    entries: [{ ...index.entries[0], byte_size: (32 * 1024 * 1024) + 1 }],
    async readBlobs() { reads += 1; return new Map(); },
  }, {});
  assert.equal(reads, 0);
  assert.ok(oversized.collectors.every((collector) => collector.status === "unavailable"));
  assert.match(oversized.collectors[0].reason, /exceeds the 33554432-byte static batch bound/);
});

test("indexed static observes pre-abort on a full reuse hit and propagates in-flight cancellation without partial evidence", async (context) => {
  const root = initializeGitFixture(context);
  fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n", "utf8");
  const revision = commitAll(root, "fixture");
  const input = { repo_root: root, repository_revision: revision, generated_path_patterns: [] };
  const index = await buildRepositoryIndex({ repository_root: root, repository_revision: revision, generated_path_patterns: [] });
  const first = await collectStaticEvidenceFromIndex(input, index, {});
  const prior = canonicalStaticSnapshot(input, first);

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    collectStaticEvidenceFromIndex({ ...input, prior_static_snapshot: prior }, index, { signal: preAborted.signal }),
    /FAIL-REPOSITORY-INDEX-CANCELLED/,
  );

  const inFlight = new AbortController();
  const pending = collectStaticEvidenceFromIndex(input, {
    binding: index.binding,
    entries: index.entries,
    readBlobs(entries, options) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("FAIL-REPOSITORY-INDEX-CANCELLED: synthetic in-flight abort")), { once: true });
      });
    },
  }, { signal: inFlight.signal });
  setImmediate(() => inFlight.abort());
  await assert.rejects(pending, /FAIL-REPOSITORY-INDEX-CANCELLED/);
});

test("the tiny-file trap surfaces churn and temporal coupling without a LOC threshold", () => {
  const evidence = collectGitEvidence({ ...tinyFileTrapHistory(), generated_path_patterns: [] });
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.change_frequency").value, 80);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.churn:src/tiny.js").scope.path, "src/tiny.js");
  assert.ok(evidence.relationships.some((edge) => edge.kind === "temporal_coupling"));
});

test("generated and vendor policy is applied before behavioral aggregates and temporal co-change", () => {
  const evidence = collectGitEvidence({
    repository_revision: REVISION,
    generated_path_patterns: ["generated/**", "vendor/**"],
    commits: [{
      revision: REVISION,
      timestamp: "2026-08-10T00:00:00.000Z",
      author: "collector@example.test",
      files: [
        { path: "src/a.js", added: 2, deleted: 0 },
        { path: "src/b.js", added: 1, deleted: 0 },
        { path: "vendor/library.js", added: 100, deleted: 0 },
        { path: "generated/client.js", added: 100, deleted: 0 },
      ],
    }],
  });

  assert.equal(evidence.aggregates.churn, 3);
  assert.equal(evidence.aggregates.co_change_pair_count, 1);
  assert.equal(evidence.collectors[0].status, "available");
  assert.deepEqual(evidence.relationships.map(({ source, target }) => [source, target]), [["src/a.js", "src/b.js"]]);
  const vendorMetric = evidence.metrics.find((metric) => metric.metric_id === "git.churn:vendor/library.js");
  assert.equal(vendorMetric.scope.generated_code, true);
  assert.equal(vendorMetric.scope.included_in_human_maintainability, false);
});

test("without classification policy, unknown generated or vendor paths are excluded and behavioral aggregates are degraded rather than fabricated", () => {
  const input = {
    repository_revision: REVISION,
    commits: [{
      revision: REVISION,
      timestamp: "2026-08-10T00:00:00.000Z",
      author: "collector@example.test",
      files: [
        { path: "src/a.js", added: 2, deleted: 0 },
        { path: "vendor/library.js", added: 100, deleted: 0 },
      ],
    }],
  };
  const unknown = collectGitEvidence(input);
  assert.equal(unknown.collectors[0].status, "degraded");
  assert.match(unknown.collectors[0].reason, /generated_vendor_classification_unknown/);
  assert.equal(unknown.files.find((file) => file.path === "vendor/library.js").included_in_behavioral_aggregates, false);
  for (const metricId of ["git.churn", "git.ownership_concentration", "git.co_change_pair_count"]) {
    const metric = unknown.metrics.find((entry) => entry.metric_id === metricId);
    assert.equal(metric.value, null, metricId);
    assert.equal(metric.measurement.status, "unverifiable", metricId);
  }
  const observedUnknownChurn = unknown.metrics.find((metric) => metric.metric_id === "git.observed_text_churn");
  assert.equal(observedUnknownChurn.value, null);
  assert.equal(observedUnknownChurn.measurement.status, "unverifiable");
  assert.match(observedUnknownChurn.measurement.reason, /unknown_classification_file_changes_excluded=2/);
  assert.equal(
    unknown.metrics.find((metric) => metric.metric_id === "git.observed_text_churn:vendor/library.js").measurement.status,
    "unverifiable",
  );
  assert.deepEqual(unknown.relationships, []);

  const known = collectGitEvidence({ ...input, generated_path_patterns: ["vendor/**"] });
  assert.equal(known.collectors[0].status, "available");
  assert.equal(known.aggregates.churn, 2);
  assert.equal(known.metrics.find((metric) => metric.metric_id === "git.churn").measurement.status, "measured");
  assert.equal(known.metrics.find((metric) => metric.metric_id === "git.observed_text_churn").value, 2);
  assert.match(
    known.metrics.find((metric) => metric.metric_id === "git.observed_text_churn").measurement.reason,
    /generated_vendor_file_changes_excluded=1/,
  );
  assert.equal(known.files.find((file) => file.path === "src/a.js").included_in_behavioral_aggregates, true);
  assert.equal(known.files.find((file) => file.path === "vendor/library.js").included_in_behavioral_aggregates, false);
});

test("mixed Git evidence exposes bounded observed non-merge human text metrics without completing degraded history", () => {
  const revisions = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
  const evidence = collectGitEvidence({
    repository_revision: revisions[3],
    generated_path_patterns: ["generated/**", "vendor/**"],
    commits: [
      {
        revision: revisions[0],
        timestamp: "2026-08-01T00:00:00.000Z",
        author: "alice@example.test",
        files: [
          { path: "src/a.js", added: 3, deleted: 0 },
          { path: "src/b.js", added: 2, deleted: 0 },
          { path: "vendor/library.js", added: 100, deleted: 0 },
        ],
      },
      {
        revision: revisions[1],
        timestamp: "2026-08-02T00:00:00.000Z",
        author: "bob@example.test",
        files: [
          { path: "src/a.js", added: 1, deleted: 1 },
          { path: "assets/logo.png", added: null, deleted: null, binary_change: true },
        ],
      },
      {
        revision: revisions[2],
        timestamp: "2026-08-03T00:00:00.000Z",
        author: "merge@example.test",
        is_merge: true,
        files: [],
      },
      {
        revision: revisions[3],
        timestamp: "2026-08-04T00:00:00.000Z",
        author: "alice@example.test",
        files: [
          { path: "src/a.js", added: 2, deleted: 0 },
          { path: "generated/client.js", added: 200, deleted: 0 },
        ],
      },
    ],
  });

  assert.deepEqual({
    total: evidence.aggregates.commit_count,
    observed: evidence.aggregates.observed_non_merge_commit_count,
    coverage: evidence.aggregates.observed_commit_coverage,
    mergeExclusions: evidence.aggregates.unattributed_merge_commit_count,
    binaryExclusions: evidence.aggregates.binary_file_change_exclusion_count,
    generatedExclusions: evidence.aggregates.generated_vendor_file_change_exclusion_count,
    observedTextChurn: evidence.aggregates.observed_text_churn,
    observedTouches: evidence.aggregates.observed_touch_count,
    observedOwnership: evidence.aggregates.observed_touch_ownership_concentration,
    observedPairs: evidence.aggregates.observed_co_change_pair_count,
  }, {
    total: 4,
    observed: 3,
    coverage: 0.75,
    mergeExclusions: 1,
    binaryExclusions: 1,
    generatedExclusions: 2,
    observedTextChurn: 9,
    observedTouches: 5,
    observedOwnership: 0.6,
    observedPairs: 2,
  });

  const observedMetrics = new Map(evidence.metrics.map((metric) => [metric.metric_id, metric]));
  for (const [metricId, definitionId, value] of [
    ["git.observed_text_churn", "sei.git.observed_text_churn@1", 9],
    ["git.observed_touch_ownership_concentration", "sei.git.observed_touch_ownership_concentration@1", 0.6],
    ["git.observed_co_change_pair_count", "sei.git.observed_co_change_pair_count@1", 2],
  ]) {
    const metric = observedMetrics.get(metricId);
    assert.equal(metric.definition_id, definitionId);
    assert.equal(metric.analyzer_version, "1.4.1");
    assert.equal(metric.value, value);
    assert.equal(metric.measurement.status, "measured");
    assert.equal(metric.measurement.completeness, 0.75);
    assert.ok(metric.measurement.confidence <= metric.measurement.completeness);
    assert.match(metric.measurement.reason, /observed_non_merge_commits=3\/4/);
    assert.match(metric.measurement.reason, /unattributed_merge_commits=1/);
    assert.match(metric.measurement.reason, /binary_(?:numstat_rows_excluded_from_text_churn|line_churn_exclusions)=1/);
    assert.match(metric.measurement.reason, /generated_vendor_file_changes_excluded=2/);
    assert.match(metric.measurement.reason, /observed-subset.*not a full-history metric/i);
  }

  for (const metricId of ["git.churn", "git.ownership_concentration", "git.co_change_pair_count"]) {
    assert.equal(observedMetrics.get(metricId).measurement.status, "unverifiable", metricId);
    assert.equal(observedMetrics.get(metricId).value, null, metricId);
  }

  const observedFileChurn = observedMetrics.get("git.observed_text_churn:src/a.js");
  assert.equal(observedFileChurn.definition_id, "sei.git.observed_text_churn@1");
  assert.equal(observedFileChurn.value, 7);
  assert.equal(observedFileChurn.measurement.completeness, 0.75);
  const observedFileOwnership = observedMetrics.get("git.observed_touch_ownership_concentration:src/a.js");
  assert.equal(observedFileOwnership.definition_id, "sei.git.observed_touch_ownership_concentration@1");
  assert.equal(observedFileOwnership.value, 2 / 3);
  assert.equal(observedFileOwnership.measurement.completeness, 0.75);
  const fileFrequency = observedMetrics.get("git.change_frequency:src/a.js");
  assert.equal(fileFrequency.measurement.completeness, 0.75);
  assert.equal(fileFrequency.measurement.confidence, 0.75);
  assert.match(fileFrequency.measurement.reason, /observed_non_merge_commits=3\/4/);
  assert.deepEqual(evidence.relationships.map(({ source, target }) => [source, target]), [
    ["assets/logo.png", "src/a.js"],
    ["src/a.js", "src/b.js"],
  ]);
  assert.equal(evidence.aggregates.observed_co_change_pair_count, evidence.relationships.length);
  const observedCoChange = observedMetrics.get("git.observed_co_change_pair_count");
  assert.match(observedCoChange.measurement.reason, /temporal_mass_change_policy=/);
  assert.match(observedCoChange.measurement.reason, /mass_commits=0/);
  assert.match(observedCoChange.measurement.reason, /excluded_pairwise=0/);
  assert.match(observedCoChange.measurement.reason, /down_weighted_pairwise=0/);
});

test("a supplied merge with an explicit validated delta is observed and never mislabeled unattributed", () => {
  const revisions = ["6", "7", "8"].map((digit) => digit.repeat(40));
  const evidence = collectGitEvidence({
    repository_revision: revisions[2],
    generated_path_patterns: [],
    commits: [
      {
        revision: revisions[0],
        timestamp: "2026-08-01T00:00:00.000Z",
        author: "alice@example.test",
        files: [{ path: "src/a.js", added: 2, deleted: 0 }],
      },
      {
        revision: revisions[1],
        timestamp: "2026-08-02T00:00:00.000Z",
        author: "bob@example.test",
        files: [{ path: "src/b.js", added: 1, deleted: 0 }],
      },
      {
        revision: revisions[2],
        timestamp: "2026-08-03T00:00:00.000Z",
        author: "merge@example.test",
        is_merge: true,
        files: [
          { path: "src/a.js", added: 1, deleted: 1 },
          { path: "src/b.js", added: 0, deleted: 1 },
        ],
      },
    ],
  });
  const metrics = new Map(evidence.metrics.map((metric) => [metric.metric_id, metric]));

  assert.equal(evidence.collectors[0].status, "available");
  assert.equal(evidence.aggregates.merge_commit_count, 1);
  assert.equal(evidence.aggregates.unattributed_merge_commit_count, 0);
  assert.equal(evidence.aggregates.observed_attributed_commit_count, 3);
  assert.equal(evidence.aggregates.observed_non_merge_commit_count, 2);
  assert.equal(evidence.aggregates.observed_commit_coverage, 1);
  assert.equal(metrics.get("git.churn").value, 6);
  assert.equal(metrics.get("git.observed_text_churn").value, 6);
  assert.equal(metrics.get("git.observed_touch_ownership_concentration").value, 0.5);
  assert.equal(metrics.get("git.observed_co_change_pair_count").value, 1);
  assert.equal(metrics.get("git.observed_text_churn").measurement.completeness, 1);
  assert.match(metrics.get("git.observed_text_churn").measurement.reason, /observed_attributed_commits=3\/3/);
  assert.match(metrics.get("git.observed_text_churn").measurement.reason, /observed_non_merge_commits=2\/3/);
  assert.match(metrics.get("git.observed_text_churn").measurement.reason, /unattributed_merge_commits=0/);
  assert.doesNotMatch(metrics.get("git.observed_text_churn").measurement.reason, /unattributed_merge_commits=1/);
});

test("observed Git metrics equal complete human metrics when history has no merge or exclusion gap", () => {
  const revisions = ["a", "b"].map((digit) => digit.repeat(40));
  const evidence = collectGitEvidence({
    repository_revision: revisions[1],
    generated_path_patterns: [],
    commits: [
      {
        revision: revisions[0],
        timestamp: "2026-08-01T00:00:00.000Z",
        author: "alice@example.test",
        files: [
          { path: "src/a.js", added: 3, deleted: 0 },
          { path: "src/b.js", added: 2, deleted: 0 },
        ],
      },
      {
        revision: revisions[1],
        timestamp: "2026-08-02T00:00:00.000Z",
        author: "bob@example.test",
        files: [
          { path: "src/a.js", added: 1, deleted: 1 },
          { path: "src/b.js", added: 0, deleted: 1 },
        ],
      },
    ],
  });
  const metrics = new Map(evidence.metrics.map((metric) => [metric.metric_id, metric]));
  assert.equal(metrics.get("git.observed_text_churn").value, metrics.get("git.churn").value);
  assert.equal(metrics.get("git.observed_touch_ownership_concentration").value, metrics.get("git.ownership_concentration").value);
  assert.equal(metrics.get("git.observed_co_change_pair_count").value, metrics.get("git.co_change_pair_count").value);
  assert.equal(metrics.get("git.observed_text_churn:src/a.js").value, metrics.get("git.churn:src/a.js").value);
  assert.equal(metrics.get("git.observed_touch_ownership_concentration:src/a.js").value, metrics.get("git.ownership_concentration:src/a.js").value);
  assert.equal(evidence.aggregates.observed_commit_coverage, 1);
  assert.equal(metrics.get("git.observed_text_churn").measurement.completeness, 1);
  assert.equal(metrics.get("git.change_frequency:src/a.js").measurement.completeness, 1);
});

test("generated complexity does not enter human structural percentiles by default", () => {
  const evidence = collectStaticEvidence(generatedCodeTrap());
  assert.equal(evidence.aggregates.human_source_file_count, 1);
  assert.equal(evidence.aggregates.human_lexical_max_nesting_depth_p90, 1);
  assert.equal(evidence.files.find((file) => file.path === "generated/client.js").included_in_human_maintainability, false);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "static.lexical_max_nesting_depth:generated/client.js").scope.generated_code, true);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "static.cyclomatic_complexity").measurement.status, "unavailable");
  assert.ok(evidence.metrics.every((metric) => !metric.metric_id.includes("complexity") || metric.value === null));
});

test("missing Git is unavailable rather than a zero measurement", () => {
  const evidence = collectGitEvidence({
    repo_root: process.cwd(),
    repository_revision: REVISION,
    git_executable: "definitely-not-an-installed-git-executable",
  });
  assert.equal(evidence.collectors[0].status, "unavailable");
  assert.ok(evidence.metrics.every((metric) => metric.measurement.status === "unavailable"));
  assert.ok(evidence.metrics.every((metric) => metric.value === null));
  assert.deepEqual(
    evidence.metrics.filter((metric) => metric.metric_id.startsWith("git.observed_")).map((metric) => metric.metric_id),
    ["git.observed_co_change_pair_count", "git.observed_text_churn", "git.observed_touch_ownership_concentration"],
  );
  assert.deepEqual(evidence.files, []);
});

test("collection fails closed when evidence cannot bind to a repository revision", () => {
  assert.throws(
    () => collectStaticEvidence({ generated_path_patterns: [], files: [] }),
    /FAIL-MISSING-REPOSITORY-REVISION/,
  );
  assert.throws(
    () => collectGitEvidence({ commits: [] }),
    /FAIL-MISSING-REPOSITORY-REVISION/,
  );
});

test("an empty history window is not applicable rather than measured zero", () => {
  const evidence = collectGitEvidence(emptyHistoryWindow());
  assert.equal(evidence.collectors[0].status, "available");
  assert.ok(evidence.metrics.every((metric) => metric.measurement.status === "not-applicable"));
  assert.ok(evidence.metrics.every((metric) => metric.value === null));
  assert.equal(evidence.aggregates.commit_count, 0);
  assert.equal(evidence.aggregates.observed_non_merge_commit_count, 0);
  assert.equal(evidence.aggregates.observed_commit_coverage, 1);
  assert.deepEqual(evidence.files, []);
});

test("an analyzer version change remains explicit in every lexical metric", () => {
  const input = generatedCodeTrap();
  const first = collectStaticEvidence({ ...input, static_analyzer_version: "1.0.0" });
  const changed = collectStaticEvidence({ ...input, static_analyzer_version: "2.0.0" });
  const lexical = changed.metrics.filter((metric) => metric.source.collector_id === "static-source");
  assert.ok(lexical.every((metric) => metric.analyzer_version === "2.0.0"));
  assert.ok(lexical.every((metric) => metric.comparability.analyzer_version === "2.0.0"));
  assert.notEqual(JSON.stringify(first), JSON.stringify(changed));
});

test("configuration hashes derive from canonical effective config and supplied hashes are verified", () => {
  const fixture = generatedCodeTrap();
  const first = collectStaticEvidence({
    ...fixture,
    generated_path_patterns: ["vendor\\**", "generated/**"],
  });
  const expectedHash = first.metrics[0].comparability.configuration_hash;
  const reordered = collectStaticEvidence({
    ...fixture,
    generated_path_patterns: ["generated/**", "vendor/**"],
  });
  assert.equal(reordered.metrics[0].comparability.configuration_hash, expectedHash);
  assert.doesNotThrow(() => collectStaticEvidence({
    ...fixture,
    generated_path_patterns: ["generated/**", "vendor/**"],
    configuration_hash: expectedHash,
  }));
  assert.throws(
    () => collectStaticEvidence({
      ...fixture,
      generated_path_patterns: ["generated/**", "vendor/**"],
      configuration_hash: "f".repeat(64),
    }),
    /FAIL-CONFIGURATION-HASH-MISMATCH/,
  );
});

test("indexed static collection binds exact committed blobs and ignores working-tree drift", async (context) => {
  const root = initializeGitFixture(context);
  fs.mkdirSync(path.join(root, "src"));
  const sourcePath = path.join(root, "src", "index.js");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.js\n", "utf8");
  fs.writeFileSync(path.join(root, "ignored.js"), "export const ignored = true;\n", "utf8");
  fs.writeFileSync(sourcePath, "export function answer() { return 42; }\n", "utf8");
  const revision = commitAll(root, "fixture");
  const before = fs.readFileSync(sourcePath, "utf8");

  const input = {
    repo_root: root,
    repository_revision: revision,
    generated_path_patterns: [],
  };
  const index = await buildRepositoryIndex({ repository_root: root, repository_revision: revision, generated_path_patterns: [] });
  const evidence = await collectStaticEvidenceFromIndex(input, index, {});

  assert.equal(evidence.collectors.find((collector) => collector.collector_id === "static-source").status, "available");
  assert.deepEqual(evidence.files.map((file) => file.path), ["src/index.js"]);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), before);
  assert.equal(runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  fs.writeFileSync(sourcePath, "export function answer() { return 7; }\n", "utf8");
  const dirty = await collectStaticEvidenceFromIndex(input, index, {});
  assert.equal(JSON.stringify(dirty), JSON.stringify(evidence));

  commitAll(root, "new head");
  const historicalIndex = await buildRepositoryIndex({ repository_root: root, repository_revision: revision, generated_path_patterns: [] });
  const historical = await collectStaticEvidenceFromIndex(input, historicalIndex, {});
  assert.equal(JSON.stringify(historical), JSON.stringify(evidence));
});

test("indexed static evidence reads the declared blob when assume-unchanged hides working-copy drift", async (context) => {
  const root = initializeGitFixture(context);
  const sourcePath = path.join(root, "index.js");
  fs.writeFileSync(sourcePath, "export const committed = true;\n", "utf8");
  const revision = commitAll(root, "committed blob");
  runGit(root, ["update-index", "--assume-unchanged", "index.js"]);
  fs.writeFileSync(sourcePath, "export const changed = false;\nexport const extra = true;\n", "utf8");
  assert.equal(runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const input = {
    repo_root: root,
    repository_revision: revision,
    generated_path_patterns: [],
  };
  const index = await buildRepositoryIndex({ repository_root: root, repository_revision: revision, generated_path_patterns: [] });
  const evidence = await collectStaticEvidenceFromIndex(input, index, {});
  const sourceCollector = evidence.collectors.find((collector) => collector.collector_id === "static-source");
  assert.equal(sourceCollector.status, "available");
  assert.equal(evidence.files.find((file) => file.path === "index.js").source_lines, 1);
});

test("synchronous repository-local static collection fails closed without an index", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-unbound-static-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "index.js"), "export const unbound = true;\n", "utf8");

  assert.throws(() => collectStaticEvidence({
    repo_root: root,
    repository_revision: REVISION,
    generated_path_patterns: [],
  }), /FAIL-REPOSITORY-INDEX-REQUIRED/);
});

test("async Git cancellation rejects with the caller reason and removes the complete process tree", async (context) => {
  const hanging = hangingGitCommand(context);
  const controller = new AbortController();
  const cancellation = new Error("focused Git cancellation");
  const pending = collectGitEvidenceAsync({
    git_executable: hanging.executable,
    repo_root: hanging.repositoryRoot,
    repository_revision: "1".repeat(40),
    generated_path_patterns: [],
  }, { signal: controller.signal, saturation: 1 });

  assert.equal(await waitFor(() => fs.existsSync(hanging.readyFile)), true, "hanging Git descendant never started");
  const pids = fs.readFileSync(hanging.pidFile, "utf8").trim().split(",").map(Number);
  assert.ok(pids.length >= 1);
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid)));
  if (hanging.lockFile !== null) assert.equal(canOpenExclusively(hanging.lockFile), false);

  controller.abort(cancellation);
  await assert.rejects(pending, (error) => error === cancellation);
  assert.equal(await waitFor(() => pids.every((pid) => !processIsAlive(pid))), true,
    `cancelled Git process tree remained alive: ${pids.filter(processIsAlive).join(",")}`);
  if (hanging.lockFile !== null) assert.equal(canOpenExclusively(hanging.lockFile), true,
    "cancelled Git descendant retained its exclusive file handle");
});

test("async Git auto saturation maps a four-CPU host onto a supported bounded value", async () => {
  const originalAvailableParallelism = os.availableParallelism;
  os.availableParallelism = () => 4;
  try {
    const input = emptyHistoryWindow();
    const evidence = await collectGitEvidenceAsync(input);
    assert.equal(JSON.stringify(evidence), JSON.stringify(collectGitEvidence(input)));
  } finally {
    os.availableParallelism = originalAvailableParallelism;
  }
});

test("local Git history resolves the declared revision and never falls through to HEAD", (context) => {
  const root = initializeGitFixture(context);
  const sourcePath = path.join(root, "index.js");
  fs.writeFileSync(sourcePath, "export const version = 1;\n", "utf8");
  const firstRevision = commitAll(root, "first");
  fs.writeFileSync(sourcePath, "export const version = 2;\n", "utf8");
  const secondRevision = commitAll(root, "second");

  const bounded = collectGitEvidence({
    repo_root: root,
    repository_revision: firstRevision,
    history_window: { kind: "revision-range", start: null, end: null },
    generated_path_patterns: [],
  });
  assert.equal(bounded.collectors[0].status, "available");
  assert.equal(bounded.metrics.find((metric) => metric.metric_id === "git.change_frequency").value, 1);

  const mismatch = collectGitEvidence({
    repo_root: root,
    repository_revision: firstRevision,
    history_window: { kind: "revision-range", start: null, end: secondRevision },
  });
  assert.equal(mismatch.collectors[0].status, "unavailable");
  assert.match(mismatch.collectors[0].reason, /history window end.*repository_revision/i);
});

test("an auto-root-inclusive local history boundary retains the root commit without leaking its private flag", (context) => {
  const root = initializeGitFixture(context);
  const sourcePath = path.join(root, "index.js");
  fs.writeFileSync(sourcePath, "export const first = 1;\n", "utf8");
  const firstRevision = commitAll(root, "first");
  fs.appendFileSync(sourcePath, "export const second = 2;\n", "utf8");
  const secondRevision = commitAll(root, "second");

  const evidence = collectGitEvidence({
    repo_root: root,
    repository_revision: secondRevision,
    history_window: {
      kind: "revision-range",
      start: firstRevision,
      end: secondRevision,
      auto_root_inclusive: true,
    },
    generated_path_patterns: [],
  });

  assert.equal(evidence.collectors[0].status, "available");
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.change_frequency").value, 2);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.churn").value, 2);
  assert.ok(evidence.metrics.every((metric) => metric.window.start === firstRevision));
  assert.ok(evidence.metrics.every((metric) => Object.keys(metric.window).sort().join(",") === "end,kind,start"));
});

test("local Git metric windows contain resolved full revisions, never symbolic input", (context) => {
  const root = initializeGitFixture(context);
  const sourcePath = path.join(root, "index.js");
  fs.writeFileSync(sourcePath, "export const version = 1;\n", "utf8");
  const firstRevision = commitAll(root, "first");
  fs.writeFileSync(sourcePath, "export const version = 2;\n", "utf8");
  const secondRevision = commitAll(root, "second");

  const evidence = collectGitEvidence({
    repo_root: root,
    repository_revision: secondRevision,
    history_window: { kind: "revision-range", start: "HEAD~1", end: "HEAD" },
    generated_path_patterns: [],
  });

  assert.equal(evidence.collectors[0].status, "available");
  assert.ok(evidence.metrics.every((metric) => metric.window.start === firstRevision));
  assert.ok(evidence.metrics.every((metric) => metric.window.end === secondRevision));
  assert.ok(evidence.metrics.every((metric) => !metric.window.start.includes("HEAD")));

  const unavailable = collectGitEvidence({
    repo_root: root,
    repository_revision: secondRevision,
    history_window: { kind: "revision-range", start: "missing-symbolic-revision", end: "HEAD" },
  });
  assert.equal(unavailable.collectors[0].status, "unavailable");
  assert.ok(unavailable.metrics.every((metric) => metric.window.start === null));
  assert.ok(unavailable.metrics.every((metric) => metric.window.end === secondRevision));

  const unrelated = runGit(root, ["commit-tree", runGit(root, ["write-tree"]), "-m", "unrelated history root"]);
  const nonAncestral = collectGitEvidence({
    repo_root: root,
    repository_revision: secondRevision,
    history_window: { kind: "revision-range", start: unrelated, end: secondRevision },
  });
  assert.equal(nonAncestral.collectors[0].status, "unavailable");
  assert.match(nonAncestral.collectors[0].reason, /start is not an ancestor/i);
});

test("without a generated path rule, unknown files do not contaminate human aggregates", () => {
  const evidence = collectStaticEvidence(noGeneratedRuleSources());
  assert.equal(evidence.collectors.find((collector) => collector.collector_id === "static-source").status, "degraded");
  assert.equal(evidence.aggregates.human_source_file_count, 1);
  assert.equal(evidence.aggregates.generated_source_file_count, 1);
  assert.equal(evidence.aggregates.unclassified_source_file_count, 1);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "static.lexical_max_nesting_depth_p90").measurement.status, "unverifiable");
});

test("malformed supplied commit records fail closed", () => {
  assert.throws(() => collectGitEvidence(malformedHistory()), /FAIL-MALFORMED-GIT-RECORD/);
});

test("supplied Git records reject NUL-bearing rename origins before aggregation", () => {
  const base = {
    repository_revision: REVISION,
    generated_path_patterns: [],
    commits: [{
      revision: REVISION,
      timestamp: "2026-08-10T00:00:00.000Z",
      author: "collector@example.test",
      files: [{ path: "src/new.js", previous_path: "src/old\0.js", change_kind: "rename", added: 1, deleted: 0 }],
    }],
  };
  assert.throws(() => collectGitEvidence(base), /FAIL-MALFORMED-GIT-RECORD/);
});

test("timezone-less supplied Git timestamps are rejected before host-local parsing", () => {
  const base = {
    repository_revision: REVISION,
    generated_path_patterns: [],
    commits: [{
      revision: REVISION,
      timestamp: "2026-08-10T00:00:00",
      author: "collector@example.test",
      files: [],
    }],
  };
  assert.throws(() => collectGitEvidence({
    ...base,
  }), /FAIL-MALFORMED-GIT-RECORD/);
});

test("duplicate normalized evidence identities fail before aggregation", () => {
  assert.throws(() => collectStaticEvidence({
    repo_root: "fixture://duplicate-source-path",
    repository_revision: REVISION,
    generated_path_patterns: [],
    files: [
      { path: "src\\index.js", content: "export const first = true;\n" },
      { path: "src/index.js", content: "export const second = true;\n" },
    ],
  }), /FAIL-DUPLICATE-SOURCE-PATH/);

  const duplicateFileCommit = {
    revision: "1".repeat(40),
    timestamp: "2026-08-10T00:00:00.000Z",
    author: "owner@example.test",
    files: [
      { path: "src\\index.js", added: 1, deleted: 0 },
      { path: "src/index.js", added: 2, deleted: 0 },
    ],
  };
  assert.throws(() => collectGitEvidence({
    repo_root: "fixture://duplicate-commit-path",
    repository_revision: REVISION,
    commits: [duplicateFileCommit],
  }), /FAIL-DUPLICATE-GIT-PATH/);

  const repeatedCommit = { ...duplicateFileCommit, files: [duplicateFileCommit.files[0]] };
  assert.throws(() => collectGitEvidence({
    repo_root: "fixture://duplicate-commit",
    repository_revision: REVISION,
    commits: [repeatedCommit, { ...repeatedCommit, files: [] }],
  }), /FAIL-DUPLICATE-GIT-COMMIT/);
});

test("a commit without file rows preserves commit evidence but not ownership", () => {
  const evidence = collectGitEvidence({
    repo_root: "fixture://metadata-only-commit",
    repository_revision: REVISION,
    commits: [{ revision: REVISION, timestamp: "2026-08-10T00:00:00.000Z", author: "owner@example.test", files: [] }],
  });
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.change_frequency").value, 1);
  const ownership = evidence.metrics.find((metric) => metric.metric_id === "git.ownership_concentration");
  assert.equal(ownership.measurement.status, "not-applicable");
  assert.equal(ownership.value, null);
});

test("monorepo source inventory preserves deterministic language partitions", () => {
  const evidence = collectStaticEvidence(monorepoSources());
  assert.deepEqual(evidence.aggregates.by_language, {
    python: {
      source_file_count: 1,
      human_source_file_count: 1,
      generated_source_file_count: 0,
      source_lines: 2,
      human_source_lines: 2,
    },
    typescript: {
      source_file_count: 2,
      human_source_file_count: 1,
      generated_source_file_count: 1,
      source_lines: 2,
      human_source_lines: 1,
    },
  });
});

test("supplied row order does not change collector output", () => {
  const staticInput = monorepoSources();
  const reorderedStatic = { ...staticInput, files: [...staticInput.files].reverse() };
  assert.equal(JSON.stringify(collectStaticEvidence(staticInput)), JSON.stringify(collectStaticEvidence(reorderedStatic)));

  const gitInput = { ...tinyFileTrapHistory(), generated_path_patterns: [] };
  const reorderedGit = {
    ...gitInput,
    commits: [...gitInput.commits].reverse().map((commit) => ({ ...commit, files: [...commit.files].reverse() })),
  };
  assert.equal(JSON.stringify(collectGitEvidence(gitInput)), JSON.stringify(collectGitEvidence(reorderedGit)));
});

test("combined local evidence records satisfy the canonical metric contract", () => {
  const input = { ...monorepoSources(), ...tinyFileTrapHistory(), generated_path_patterns: ["packages/generated/**"], files: monorepoSources().files };
  const evidence = collectLocalEvidence(input);
  const statusCounts = { measured: 0, inferred: 0, unavailable: 0, "not-applicable": 0, unverifiable: 0 };
  for (const metric of evidence.metrics) statusCounts[metric.measurement.status] += 1;
  const snapshot = materializeSnapshot({
    schema_version: "1.0.0",
    snapshot_id: "pending",
    repository: {
      repository_id: "collector-fixture",
      revision: REVISION,
      configuration_hash: evidence.metrics[0].comparability.configuration_hash,
      history_boundary: input.history_window,
      generated_path_patterns: input.generated_path_patterns,
    },
    collectors: evidence.collectors,
    measurements: evidence.metrics,
    risk_models: [],
    profiles: [],
    evidence_summary: { measurement_count: evidence.metrics.length, status_counts: statusCounts },
    run_metadata: { generated_at: "2026-08-10T00:00:00.000Z" },
  });
  assert.deepEqual(validateSnapshot(snapshot), { ok: true, errors: [] });
});
