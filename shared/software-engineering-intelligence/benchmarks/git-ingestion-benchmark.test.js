"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runGitIngestionBenchmarkSuite,
  runGitIngestionSaturationBenchmark,
} = require("./git-ingestion-benchmark.js");

test("async Git saturation benchmark compares 1, 2, 4, and auto without semantic drift", async () => {
  const result = await runGitIngestionSaturationBenchmark({
    case_definition: { case_id: "mixed-300", scenario: "mixed", commit_count: 300 },
    saturations: [1, 2, 4, "auto"],
  });

  assert.equal(result.benchmark_id, "sei-async-git-saturation-benchmark-v1");
  assert.deepEqual(result.measurements.map((entry) => entry.requested_saturation), [1, 2, 4, "auto"]);
  assert.equal(new Set(result.measurements.map((entry) => entry.semantic_sha256)).size, 1);
  assert.ok(result.measurements.every((entry) => entry.semantic_sha256 === result.oracle_semantic_sha256));
  assert.ok(result.measurements.every((entry) => entry.commits === 300));
  assert.ok(result.measurements.every((entry) => entry.peak_active_processes <= entry.resolved_saturation));
  assert.deepEqual(
    result.measurements.slice(0, 3).map((entry) => entry.peak_active_processes),
    [1, 2, 4],
  );
  assert.equal(result.default_saturation, "auto");
});

test("Git ingestion benchmark reports bounded telemetry for a 100-commit local fixture", (context) => {
  const result = runGitIngestionBenchmarkSuite({
    cases: [{ case_id: "mixed-100", scenario: "mixed", commit_count: 100 }],
  });

  assert.equal(result.benchmark_id, "sei-git-ingestion-scale-benchmark-v1");
  assert.equal(result.cases.length, 1);
  const [entry] = result.cases;
  assert.equal(entry.case_id, "mixed-100");
  assert.equal(entry.scenario, "mixed");
  assert.equal(entry.requested_commit_count, 100);
  assert.equal(entry.commits, 100);
  assert.ok(Number.isFinite(entry.duration_ms));
  assert.ok(entry.duration_ms >= 0);
  assert.ok(Number.isInteger(entry.process_count));
  assert.ok(entry.process_count >= 3);
  assert.ok(Number.isFinite(entry.commits_per_second));
  assert.ok(entry.commits_per_second > 0);
  assert.ok(entry.files_processed >= 99);
  assert.ok(entry.binary_files_processed >= 1);
  assert.ok(entry.renamed_files_processed >= 1);
  assert.ok(Number.isInteger(entry.peak_batch_bytes));
  assert.ok(entry.peak_batch_bytes > 0);
  assert.equal(entry.cache_effectiveness, "not-applicable");
  assert.ok(Number.isInteger(entry.rss_before_bytes));
  assert.ok(Number.isInteger(entry.rss_after_bytes));
  assert.ok(Number.isInteger(entry.rss_delta_bytes));
});

test("Git ingestion benchmark exercises binary, rename, and monorepo history shapes", () => {
  const result = runGitIngestionBenchmarkSuite({
    cases: [
      { case_id: "binary-20", scenario: "binary-heavy", commit_count: 20 },
      { case_id: "rename-20", scenario: "rename-heavy", commit_count: 20 },
      { case_id: "monorepo-20", scenario: "monorepo", commit_count: 20 },
    ],
  });

  const byId = new Map(result.cases.map((entry) => [entry.case_id, entry]));
  assert.equal(byId.get("binary-20").binary_files_processed, 20);
  assert.equal(byId.get("rename-20").renamed_files_processed, 19);
  assert.ok(byId.get("monorepo-20").files_processed >= 20);
  assert.ok(result.cases.every((entry) => entry.commits === 20 && entry.cache_effectiveness === "not-applicable"));
});
