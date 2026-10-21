"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseArguments,
  runPythonStaticBenchmark,
} = require("./python-static-benchmark.js");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function python313() {
  const explicit = process.env.SEI_PYTHON_313;
  if (explicit && fs.statSync(explicit, { throwIfNoEntry: false })?.isFile()) return explicit;
  const windows = "C:\\Program Files\\Python313\\python.exe";
  if (fs.statSync(windows, { throwIfNoEntry: false })?.isFile()) return windows;
  const result = spawnSync("python3.13", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-static-benchmark-test-"));
  fs.mkdirSync(path.join(root, "src", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[tool.hatch.build.targets.wheel]\npackages = [\"src/pkg\"]\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "pkg", "__init__.py"), "from .worker import choose\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "pkg", "worker.py"), "def choose(value):\n    if value:\n        return 1\n    return 0\n", "utf8");
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Benchmark"], root);
  run("git", ["config", "user.email", "benchmark@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "fixture"], root);
  return { root, revision: run("git", ["rev-parse", "HEAD"], root) };
}

test("Python static benchmark proves cold/warm and serial/2/auto evidence equality with descriptive telemetry", { timeout: 180_000 }, async (context) => {
  const executable = python313();
  if (executable === null) return context.skip("exact CPython 3.13 is unavailable");
  const repository = createRepository();
  context.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));

  const receipt = await runPythonStaticBenchmark({
    repositoryRoot: repository.root,
    revision: repository.revision,
    pythonExecutable: executable,
    modes: ["serial", "2", "auto"],
    repetitions: 1,
    warmups: 0,
    configurationOverrides: {
      maxFileBytes: 64 * 1024,
      maxBatchFiles: 1,
      maxBatchBytes: 128 * 1024,
      maxQueuedSourceBytes: 256 * 1024,
    },
  });

  assert.equal(receipt.schema_version, "sei.python-static-benchmark@1");
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.repository_revision, repository.revision);
  assert.deepEqual(receipt.requested_modes, ["serial", "2", "auto"]);
  assert.equal(receipt.repetitions, 1);
  assert.equal(receipt.warmups, 0);
  assert.match(receipt.canonical_output_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.evidence_equality, true);
  assert.equal(receipt.useful_speedup_threshold, "not-defined");
  assert.equal(receipt.default_concurrency_recommendation, null);
  assert.equal(receipt.concurrency_credit, "not-assessed");
  assert.equal(receipt.process_tree_peak_rss_bytes, null);
  assert.match(receipt.process_tree_rss_reason, /unavailable/i);
  assert.equal(receipt.modes.length, 3);

  for (const mode of receipt.modes) {
    assert.equal(mode.measurements.length, 1);
    const [measurement] = mode.measurements;
    assert.equal(measurement.cold.output_digest, receipt.canonical_output_digest);
    assert.equal(measurement.warm.output_digest, receipt.canonical_output_digest);
    assert.ok(measurement.cold.duration_ms >= 0);
    assert.ok(measurement.warm.duration_ms >= 0);
    assert.ok(measurement.cold.output_bytes > 0);
    assert.equal(measurement.cold.output_bytes, measurement.warm.output_bytes);
    assert.ok(measurement.cold.analyzer_telemetry.tasks_submitted >= 2);
    assert.equal(measurement.warm.analyzer_telemetry.tasks_submitted, 0);
    assert.ok(measurement.warm.analyzer_telemetry.parse.hits >= 2);
    assert.equal(measurement.warm.analyzer_telemetry.parse.misses, 0);
    assert.ok(Number.isInteger(measurement.cold.parent_rss_peak_bytes));
    assert.ok(measurement.cold.executor_runs.length >= 1);
    assert.equal(measurement.cold.executor_runs.every((entry) => entry.timeouts === 0 && entry.cancelled === 0), true);
  }
});

test("Python static benchmark CLI parser is closed and preserves the three explicit modes", () => {
  const revision = "a".repeat(40);
  assert.deepEqual(parseArguments([
    "--repo", "C:\\cqr",
    "--revision", revision,
    "--python", "C:\\Python313\\python.exe",
    "--modes", "serial,2,auto",
    "--repetitions", "3",
    "--out", "C:\\out",
  ]), {
    repositoryRoot: "C:\\cqr",
    revision,
    pythonExecutable: "C:\\Python313\\python.exe",
    modes: ["serial", "2", "auto"],
    repetitions: 3,
    warmups: 1,
    out: "C:\\out",
  });
  assert.throws(() => parseArguments(["--repo", "x", "--unknown", "y"]), /FAIL-PYTHON-STATIC-BENCHMARK.*unsupported/);
});
