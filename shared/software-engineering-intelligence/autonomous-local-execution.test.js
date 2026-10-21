"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  AUTONOMOUS_LOCAL_EXECUTION_VERSION,
  collectAutonomousLocalExecution,
  deriveExecutionPlan,
  parseNodeTap,
  parsePytest,
} = require("./autonomous-local-execution.js");
const {
  collectStructuralFacts,
  containedEnvironment,
  sourceStatusSnapshot,
  assertSourceUnchanged,
} = require("./autonomous-local-execution.js")[Symbol.for("sei.autonomous-local-execution.private.v1")];
const { buildRepositoryIndex } = require("./repository-index.js");

const CONFIGURATION_HASH = "c".repeat(64);

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// A real committed repository in the OS temp directory (same construction as
// git-gold-fixtures.js, with caller-chosen content).
function createRepository(files) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sei-probe-repo-")));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "probe@example.test"]);
  git(root, ["config", "user.name", "SEI Probe Fixture"]);
  git(root, ["config", "core.autocrlf", "false"]);
  // Same local exclusion the project-intelligence workspace installs for its output root.
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "\n/.project-intelligence/\n");
  const resolved = typeof files === "function" ? files(root) : files;
  for (const [relativePath, content] of Object.entries(resolved)) writeFile(root, relativePath, content);
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return { root, revision: git(root, ["rev-parse", "HEAD"]) };
}

async function probe(repository, extra = {}) {
  const repositoryIndex = await buildRepositoryIndex({ repository_root: repository.root, repository_revision: repository.revision });
  return collectAutonomousLocalExecution({
    repository_root: repository.root,
    repository_revision: repository.revision,
    repository_index: repositoryIndex,
    output_root: path.join(repository.root, ".project-intelligence"),
    python_executable: null,
    configuration_hash: CONFIGURATION_HASH,
    ...extra,
  });
}

function fakeEntry(filePath, content, classifications = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    path: filePath,
    byte_size: bytes.length,
    content: bytes,
    classifications: { source: false, test_source: false, generated: "human", vendor: "not-vendor", ...classifications },
  };
}

// Mirrors repository-index.js readBlobs: throws on any oversize request.
function fakeIndex(entries, requested = []) {
  return {
    entries,
    readBlobs: async (items, options) => {
      requested.push(...items.map((item) => item.path));
      let total = 0;
      for (const item of items) {
        if (item.byte_size > options.max_blob_bytes) throw new Error(`FAIL-REPOSITORY-INDEX-BLOB: ${item.path} exceeds max_blob_bytes`);
        total += item.byte_size;
        if (total > options.max_total_bytes) throw new Error("FAIL-REPOSITORY-INDEX-BLOB: requested entries exceed max_total_bytes");
      }
      return new Map(items.map((item) => [item.path, item.content]));
    },
  };
}

test("autonomous local execution derives bounded permission-confined runtime commands from repository files", () => {
  const result = deriveExecutionPlan({
    files: ["tests/a.test.js", "src/a.js", "tests/b.test.js", "tests/ignored.py"],
    python_executable: "C:/Python/python.exe",
    node_executable: "C:/Node/node.exe",
  });
  assert.equal(AUTONOMOUS_LOCAL_EXECUTION_VERSION, "sei.autonomous-local-execution@1");
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].tool, "node-test");
  assert.deepEqual(result.commands[0].args, [
    "--permission", "--allow-fs-read=<sandbox>", "--allow-fs-write=<sandbox>",
    "--test", "--test-isolation=none", "--test-reporter=tap", "tests/a.test.js", "tests/b.test.js",
  ]);
  assert.equal(result.commands[0].args.some((arg) => /allow-child-process|allow-worker|allow-addons/.test(arg)), false);
  assert.equal(result.commands[0].bounded, false);
  assert.deepEqual(result.withheld, []);
  assert.equal(Object.isFrozen(result), true);
});

test("autonomous local execution never plans pytest because it cannot be confined", () => {
  const result = deriveExecutionPlan({ files: ["tests/test_a.py"], python_executable: "C:/Python/python.exe", node_executable: "C:/Node/node.exe" });
  assert.deepEqual(result.commands, []);
  assert.equal(result.withheld.length, 1);
  assert.equal(result.withheld[0].tool, "pytest");
  assert.match(result.withheld[0].reason, /^containment-unavailable/);
});

test("autonomous local execution parses Node TAP and pytest summaries without trusting exit text", () => {
  assert.deepEqual(parseNodeTap("# tests 4\n# pass 3\n# fail 1\n# skipped 0\n# duration_ms 12.5", "", 1), {
    total: 4, passed: 3, failed: 1, skipped: 0, duration_ms: 12.5, exit_code: 1,
  });
  assert.deepEqual(parsePytest("3 passed, 1 failed, 2 skipped in 1.25s", "", 1), {
    total: 6, passed: 3, failed: 1, skipped: 2, duration_ms: 1250, exit_code: 1,
  });
  assert.deepEqual(parseNodeTap("ℹ tests 29\nℹ pass 29\nℹ fail 0\nℹ skipped 0\nℹ duration_ms 7444.1", "", 0), {
    total: 29, passed: 29, failed: 0, skipped: 0, duration_ms: 7444.1, exit_code: 0,
  });
});

test("autonomous local execution rejects undeclared inputs", () => {
  assert.throws(() => deriveExecutionPlan({ files: [], extra: true }), /FAIL-AUTONOMOUS-EXECUTION/);
});

test("autonomous local execution environment is an allowlist pointed into the sandbox", () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require=/evil.js";
  try {
    const sandbox = path.join(os.tmpdir(), "sei-exec-env");
    const environment = containedEnvironment(sandbox);
    assert.equal(Object.keys(environment).some((key) => key.toUpperCase() === "NODE_OPTIONS"), false);
    assert.equal(environment.HOME, path.join(sandbox, "home"));
    assert.equal(environment.USERPROFILE, path.join(sandbox, "home"));
    assert.equal(environment.TMP, path.join(sandbox, "tmp"));
    assert.equal(environment.TEMP, path.join(sandbox, "tmp"));
    assert.equal(environment.GIT_CEILING_DIRECTORIES, sandbox);
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(environment.CI, "1");
    assert.equal(environment.NODE_ENV, "test");
    assert.equal(environment.PYTHONDONTWRITEBYTECODE, "1");
    const allowed = new Set(["path", "systemroot", "windir", "ci", "node_env", "pythondontwritebytecode", "home", "userprofile",
      "tmp", "temp", "tmpdir", "git_ceiling_directories", "git_config_nosystem"]);
    assert.deepEqual(Object.keys(environment).filter((key) => !allowed.has(key.toLowerCase())), []);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

test("autonomous local execution derives bounded structural facts from index blobs", async () => {
  const entries = [
    fakeEntry("src.js", "try { logger.info('start'); } catch (error) { throw error; }\n", { source: true }),
    fakeEntry("package.json", "{\"scripts\":{\"test\":\"node --test\"}}\n"),
    fakeEntry("package-lock.json", "{}\n"),
    fakeEntry("README.md", "Setup configuration, health checks, rollback and recovery are documented here.\n"),
    fakeEntry("docs/recovery.md", "Rollback and recovery exercise procedure.\n"),
  ];
  const facts = await collectStructuralFacts(fakeIndex(entries), entries);
  assert.equal(facts.scan.complete, true);
  assert.equal(facts.scan.coverage, 1);
  assert.equal(facts.scan.analyzed_file_count, facts.scan.candidate_count);
  assert.equal(facts.failure_explicitness.value, 1);
  assert.equal(facts.failure_handling.value, 1);
  assert.equal(facts.observability.value, 1);
  assert.equal(facts.dependency_hygiene.value, 1);
  assert.equal(facts.configuration_ergonomics.value, 1);
  assert.equal(facts.recovery_evidence.value, 1);
  assert.equal(facts.secrets_and_configuration.value, 0);
});

test("autonomous structural scan reports unread files honestly instead of counting selections", async () => {
  const entries = [
    fakeEntry("a.js", "try { x(); } catch (e) { throw e; }\n", { source: true }),
    fakeEntry("b.js", "logger.info('x');\n", { source: true }),
  ];
  const index = {
    entries,
    readBlobs: async (items) => new Map(items.filter((item) => item.path === "a.js").map((item) => [item.path, item.content])),
  };
  const facts = await collectStructuralFacts(index, entries);
  assert.equal(facts.scan.candidate_count, 2);
  assert.equal(facts.scan.selected_file_count, 2);
  assert.equal(facts.scan.analyzed_file_count, 1);
  assert.equal(facts.scan.unreadable, 1);
  assert.equal(facts.scan.complete, false);
  assert.equal(facts.scan.coverage, 0.5);
  assert.deepEqual(facts.scan.paths, ["a.js"]);
});

test("autonomous structural scan skips an oversize blob with a secret and reports partial coverage", async () => {
  const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
  const big = Buffer.alloc(3 * 1024 * 1024, 0x20);
  big.write(`const key = "${secret}";\n`, 0, "utf8");
  const repository = createRepository({ "src/big.js": big, "src/small.js": "try { run(); } catch (error) { throw error; }\n" });
  try {
    const repositoryIndex = await buildRepositoryIndex({ repository_root: repository.root, repository_revision: repository.revision });
    const requested = [];
    const index = { entries: repositoryIndex.entries, readBlobs: async (items, options) => {
      requested.push(...items.map((item) => item.path));
      return repositoryIndex.readBlobs(items, options);
    } };
    const facts = await collectStructuralFacts(index, repositoryIndex.entries);
    assert.equal(facts.scan.skipped_oversize, 1);
    assert.equal(facts.scan.complete, false);
    assert.ok(facts.scan.coverage < 1);
    assert.equal(facts.scan.analyzed_file_count, 1);
    assert.deepEqual(facts.scan.paths, ["src/small.js"]);
    assert.equal(requested.includes("src/big.js"), false, "oversize blob must never be requested (readBlobs throws on it)");
    assert.equal(facts.secrets_and_configuration.finding_count, 0);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("autonomous probe confines tests: escape writes and git are denied, source is unchanged", async () => {
  const marker = `sei-escape-marker-${crypto.randomBytes(6).toString("hex")}`;
  const repository = createRepository((root) => ({
    "src/app.js": "module.exports = () => 1;\n",
    "tests/escape.test.js": [
      "\"use strict\";",
      "const test = require(\"node:test\");",
      "const fs = require(\"node:fs\");",
      "const path = require(\"node:path\");",
      "const childProcess = require(\"node:child_process\");",
      `const SOURCE = ${JSON.stringify(root)};`,
      `test("relative escape write", () => { fs.writeFileSync(path.resolve("../../${marker}"), "x"); });`,
      `test("absolute write into source", () => { fs.writeFileSync(path.join(SOURCE, "${marker}"), "x"); });`,
      "test(\"git mutation of source\", () => { childProcess.execFileSync(\"git\", [\"-C\", SOURCE, \"commit\", \"--allow-empty\", \"-m\", \"escape\"]); });",
      "test(\"in-sandbox write\", () => { fs.writeFileSync(\"inside.txt\", \"ok\"); });",
      "",
    ].join("\n"),
  }));
  try {
    const statusBefore = git(repository.root, ["status", "--porcelain=v2", "--untracked-files=all"]);
    const result = await probe(repository);
    const run = result.execution.results[0];
    assert.equal(run.tool, "node-test");
    assert.equal(run.result.state, "completed");
    assert.deepEqual({ total: run.result.facts.total, passed: run.result.facts.passed, failed: run.result.facts.failed },
      { total: 4, passed: 1, failed: 3 });
    assert.match(`${run.result.stdout_tail}\n${run.result.stderr_tail}`, /ERR_ACCESS_DENIED/);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), marker)), false);
    assert.equal(fs.existsSync(path.join(repository.root, marker)), false);
    assert.equal(git(repository.root, ["rev-parse", "HEAD"]), repository.revision);
    assert.equal(git(repository.root, ["status", "--porcelain=v2", "--untracked-files=all"]), statusBefore);
    const outputRoot = path.join(repository.root, ".project-intelligence");
    assert.deepEqual(fs.readdirSync(outputRoot).filter((name) => name.startsWith(".sei-execution-")), []);
    assert.ok(fs.existsSync(result.artifact_path));
    const total = result.metrics.find((metric) => metric.metric_id === "verification.autonomous_tests_total");
    assert.equal(total.value, 4);
    assert.equal(total.measurement.status, "measured");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("autonomous probe structural facts come from the committed blob, not a tree rewritten during the probe", async () => {
  const committed = "function run() { try { work(); } catch (error) { throw error; } }\nmodule.exports = run;\n";
  const rewritten = "logger.info('rewritten'); const password = \"supersecretvalue123\";\n";
  const repository = createRepository({
    "src/app.js": committed,
    "tests/rewrite.test.js": [
      "\"use strict\";",
      "const test = require(\"node:test\");",
      "const fs = require(\"node:fs\");",
      `test("rewrites source in the sandbox", () => { fs.writeFileSync("src/app.js", ${JSON.stringify(rewritten)}); });`,
      "",
    ].join("\n"),
  });
  try {
    // A dirty working tree must not leak into revision-bound facts either.
    fs.writeFileSync(path.join(repository.root, "src", "app.js"), rewritten);
    const result = await probe(repository);
    assert.equal(result.execution.results[0].result.facts.passed, 1);
    const facts = result.execution.structural_facts;
    assert.deepEqual(facts.source.source_paths, ["src/app.js"]);
    assert.equal(facts.failure_explicitness.value, 1);
    assert.equal(facts.observability.value, 0);
    assert.equal(facts.secrets_and_configuration.finding_count, 0);
    assert.equal(fs.readFileSync(path.join(repository.root, "src", "app.js"), "utf8"), rewritten);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("autonomous probe records pytest-only repositories as containment-unavailable without executing", async () => {
  const repository = createRepository({ "tests/test_a.py": "def test_a():\n    assert True\n", "src/a.py": "x = 1\n" });
  try {
    const result = await probe(repository, { python_executable: path.join(repository.root, "missing-python.exe") });
    assert.deepEqual(result.execution.results, []);
    assert.equal(result.execution.plan.withheld[0].tool, "pytest");
    const total = result.metrics.find((metric) => metric.metric_id === "verification.autonomous_tests_total");
    assert.equal(total.measurement.status, "unavailable");
    assert.match(total.measurement.reason, /^containment-unavailable/);
    assert.equal(result.collector.status, "unavailable");
    assert.match(result.collector.reason, /^containment-unavailable/);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("autonomous probe tamper check fails closed when the source tree changes", () => {
  const repository = createRepository({ "src/a.js": "module.exports = 1;\n" });
  try {
    const outputRoot = path.join(repository.root, "sei-out-not-ignored");
    const before = sourceStatusSnapshot(repository.root, outputRoot);
    writeFile(repository.root, "sei-out-not-ignored/execution-evidence/x.json", "{}");
    assert.doesNotThrow(() => assertSourceUnchanged(before, sourceStatusSnapshot(repository.root, outputRoot)));
    fs.writeFileSync(path.join(repository.root, "src", "a.js"), "module.exports = 2;\n");
    const dirty = sourceStatusSnapshot(repository.root, outputRoot);
    assert.throws(() => assertSourceUnchanged(before, dirty), (error) => error.code === "FAIL-SEI-SOURCE-MUTATED");
    // A second edit to an already-dirty file changes size/mtime, not the porcelain line.
    fs.writeFileSync(path.join(repository.root, "src", "a.js"), "module.exports = 22;\n");
    assert.throws(() => assertSourceUnchanged(dirty, sourceStatusSnapshot(repository.root, outputRoot)), /FAIL-SEI-SOURCE-MUTATED/);
    const clean = sourceStatusSnapshot(repository.root, outputRoot);
    writeFile(repository.root, "untracked.txt", "x");
    assert.throws(() => assertSourceUnchanged(clean, sourceStatusSnapshot(repository.root, outputRoot)), /FAIL-SEI-SOURCE-MUTATED/);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});
