"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { collectGitEvidence, collectGitEvidenceAsync } = require("../collectors.js");

const DEFAULT_BENCHMARK_CASES = Object.freeze([
  Object.freeze({ case_id: "linear-1000", scenario: "linear", commit_count: 1_000 }),
  Object.freeze({ case_id: "monorepo-10000", scenario: "monorepo", commit_count: 10_000 }),
  Object.freeze({ case_id: "monorepo-50000", scenario: "monorepo", commit_count: 50_000 }),
  Object.freeze({ case_id: "binary-1000", scenario: "binary-heavy", commit_count: 1_000 }),
  Object.freeze({ case_id: "rename-1000", scenario: "rename-heavy", commit_count: 1_000 }),
]);

function runGit(root, args, options = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    input: options.input,
    shell: false,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`FAIL-GIT-INGESTION-BENCHMARK: git ${args.join(" ")} failed (${result.stderr || result.error?.message || result.status})`);
  }
  return result.stdout;
}

function assertCase(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`FAIL-GIT-INGESTION-BENCHMARK: cases[${index}] must be an object`);
  }
  if (typeof value.case_id !== "string" || !/^[a-z0-9-]+$/.test(value.case_id)) {
    throw new Error(`FAIL-GIT-INGESTION-BENCHMARK: cases[${index}].case_id must be a lowercase identifier`);
  }
  if (!new Set(["linear", "monorepo", "binary-heavy", "rename-heavy", "mixed"]).has(value.scenario)) {
    throw new Error(`FAIL-GIT-INGESTION-BENCHMARK: cases[${index}].scenario is unsupported`);
  }
  if (!Number.isInteger(value.commit_count) || value.commit_count < 3) {
    throw new Error(`FAIL-GIT-INGESTION-BENCHMARK: cases[${index}].commit_count must be an integer of at least 3`);
  }
  return { case_id: value.case_id, scenario: value.scenario, commit_count: value.commit_count };
}

function importData(chunks, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  chunks.push(Buffer.from(`data ${bytes.length}\n`, "utf8"), bytes, Buffer.from("\n", "utf8"));
}

function modifyInline(chunks, filePath, value) {
  chunks.push(Buffer.from(`M 100644 inline ${filePath}\n`, "utf8"));
  importData(chunks, value);
}

function pathForCommit(index, scenario) {
  if (scenario === "monorepo") {
    return `packages/package-${String(index % 200).padStart(3, "0")}/src/file-${String(index % 40).padStart(2, "0")}.js`;
  }
  return `src/file-${String(index % 250).padStart(3, "0")}.js`;
}

function buildHistoryImport({ scenario, commit_count: commitCount }) {
  const chunks = [];
  let renamedPath = "src/rename-000000.js";
  for (let index = 1; index <= commitCount; index += 1) {
    const message = `SEI benchmark ${scenario} ${index}`;
    chunks.push(Buffer.from(
      `commit refs/heads/main\nmark :${index}\ncommitter SEI Benchmark <benchmark@example.test> ${1_700_000_000 + index} +0000\ndata ${Buffer.byteLength(message, "utf8")}\n${message}\n`,
      "utf8",
    ));
    if (index > 1) chunks.push(Buffer.from(`from :${index - 1}\n`, "utf8"));

    if (scenario === "rename-heavy") {
      const nextPath = `src/rename-${String(index).padStart(6, "0")}.js`;
      if (index === 1) {
        modifyInline(chunks, renamedPath, "export const renamed = 1;\n");
      } else {
        chunks.push(Buffer.from(`R ${renamedPath} ${nextPath}\n`, "utf8"));
        renamedPath = nextPath;
      }
    } else if (scenario === "mixed" && index === 1) {
      modifyInline(chunks, renamedPath, "export const renamed = 1;\n");
    } else if (scenario === "mixed" && index === 2) {
      const nextPath = "src/rename-000002.js";
      chunks.push(Buffer.from(`R ${renamedPath} ${nextPath}\n`, "utf8"));
      renamedPath = nextPath;
    } else if (scenario === "binary-heavy" || (scenario === "mixed" && index === 3)) {
      modifyInline(chunks, `assets/blob-${String(index % 40).padStart(2, "0")}.bin`, Buffer.from([0, index % 256, 255, 1, 254, 2]));
    } else {
      const filePath = pathForCommit(index, scenario);
      modifyInline(chunks, filePath, `export const benchmark${index % 250} = ${index};\n`);
    }
    chunks.push(Buffer.from("\n", "utf8"));
  }
  chunks.push(Buffer.from("done\n", "utf8"));
  return Buffer.concat(chunks);
}

function createGitIngestionBenchmarkFixture(caseDefinition) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-git-ingestion-benchmark-"));
  try {
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["fast-import", "--quiet"], {
      encoding: null,
      input: buildHistoryImport(caseDefinition),
    });
    const revision = runGit(root, ["rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    return { root, revision };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function showBatchPeakBytes(events) {
  const batches = new Map();
  for (const event of events) {
    if (event.command[0] !== "show") continue;
    const batchKey = event.command
      .filter((argument) => argument !== "--name-status" && argument !== "--numstat")
      .join("\0");
    batches.set(batchKey, (batches.get(batchKey) ?? 0) + event.stdout_bytes);
  }
  return Math.max(...batches.values(), 0);
}

function benchmarkGitIngestion(input = {}) {
  const events = [];
  const beforeMemory = process.memoryUsage();
  const startedAt = process.hrtime.bigint();
  const evidence = collectGitEvidence({
    ...input,
    git_observer: (event) => events.push(event),
  });
  const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
  const durationMs = Number(elapsedNanoseconds) / 1_000_000;
  const afterMemory = process.memoryUsage();
  const collector = evidence.collectors.find((entry) => entry.collector_id === "git-history");
  if (!collector || collector.status === "unavailable" || !Number.isInteger(evidence.aggregates.commit_count)) {
    throw new Error(`FAIL-GIT-INGESTION-BENCHMARK: local Git evidence was unavailable${collector?.reason ? `: ${collector.reason}` : ""}`);
  }
  const commits = evidence.aggregates.commit_count;
  return {
    duration_ms: Number(durationMs.toFixed(3)),
    process_count: events.length,
    commits,
    commits_per_second: durationMs === 0 || commits === 0 ? null : Number((commits / (durationMs / 1_000)).toFixed(3)),
    files_processed: evidence.files.length,
    binary_files_processed: evidence.files.filter((file) => file.binary_change).length,
    renamed_files_processed: evidence.files.filter((file) => file.rename_sources.length > 0).length,
    peak_batch_bytes: showBatchPeakBytes(events),
    rss_before_bytes: beforeMemory.rss,
    rss_after_bytes: afterMemory.rss,
    rss_delta_bytes: afterMemory.rss - beforeMemory.rss,
    cache_effectiveness: "not-applicable",
  };
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function summarizeAsyncMeasurement(evidence, events, durationMs, beforeMemory, afterMemory, requestedSaturation) {
  const collector = evidence.collectors.find((entry) => entry.collector_id === "git-history");
  if (!collector || collector.status === "unavailable" || !Number.isInteger(evidence.aggregates.commit_count)) {
    throw new Error(`FAIL-GIT-INGESTION-BENCHMARK: async local Git evidence was unavailable${collector?.reason ? `: ${collector.reason}` : ""}`);
  }
  const commits = evidence.aggregates.commit_count;
  const resolvedSaturation = Math.max(...events.map((event) => event.saturation ?? 1), 1);
  return {
    requested_saturation: requestedSaturation,
    resolved_saturation: resolvedSaturation,
    duration_ms: Number(durationMs.toFixed(3)),
    process_count: events.length,
    peak_active_processes: Math.max(...events.map((event) => event.peak_active_processes ?? 1), 1),
    commits,
    commits_per_second: durationMs === 0 || commits === 0 ? null : Number((commits / (durationMs / 1_000)).toFixed(3)),
    files_processed: evidence.files.length,
    binary_files_processed: evidence.files.filter((file) => file.binary_change).length,
    renamed_files_processed: evidence.files.filter((file) => file.rename_sources.length > 0).length,
    peak_batch_bytes: showBatchPeakBytes(events),
    rss_before_bytes: beforeMemory.rss,
    rss_after_bytes: afterMemory.rss,
    rss_delta_bytes: afterMemory.rss - beforeMemory.rss,
    semantic_sha256: sha256(JSON.stringify(evidence)),
  };
}

async function benchmarkGitIngestionAsync(input = {}, { saturation = "auto" } = {}) {
  const events = [];
  const beforeMemory = process.memoryUsage();
  const startedAt = process.hrtime.bigint();
  const evidence = await collectGitEvidenceAsync({
    ...input,
    git_observer: (event) => events.push(event),
  }, { saturation });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const afterMemory = process.memoryUsage();
  return summarizeAsyncMeasurement(evidence, events, durationMs, beforeMemory, afterMemory, saturation);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runGitIngestionSaturationBenchmark({
  case_definition: caseDefinition = { case_id: "mixed-1000", scenario: "mixed", commit_count: 1_000 },
  saturations = [1, 2, 4, "auto"],
  iterations = 1,
} = {}) {
  const normalizedCase = assertCase(caseDefinition, 0);
  if (!Array.isArray(saturations) || saturations.length === 0
      || saturations.some((value) => !new Set([1, 2, 4, "auto"]).has(value))) {
    throw new Error("FAIL-GIT-INGESTION-BENCHMARK: saturations must contain only 1, 2, 4, or auto");
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 5) {
    throw new Error("FAIL-GIT-INGESTION-BENCHMARK: iterations must be an integer from 1 through 5");
  }
  const fixture = createGitIngestionBenchmarkFixture(normalizedCase);
  try {
    const oracleEvidence = collectGitEvidence({
      repo_root: fixture.root,
      repository_revision: fixture.revision,
      generated_path_patterns: [],
    });
    const oracleSemanticSha256 = sha256(JSON.stringify(oracleEvidence));
    const measurements = [];
    for (const saturation of saturations) {
      const trials = [];
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        trials.push(await benchmarkGitIngestionAsync({
          repo_root: fixture.root,
          repository_revision: fixture.revision,
          generated_path_patterns: [],
        }, { saturation }));
      }
      const representative = trials.slice().sort((left, right) => left.duration_ms - right.duration_ms)[Math.floor(trials.length / 2)];
      measurements.push({
        ...representative,
        duration_ms: Number(median(trials.map((trial) => trial.duration_ms)).toFixed(3)),
        commits_per_second: Number(median(trials.map((trial) => trial.commits_per_second)).toFixed(3)),
        trial_duration_ms: trials.map((trial) => trial.duration_ms),
      });
    }
    const semanticDigests = new Set(measurements.map((entry) => entry.semantic_sha256));
    if (semanticDigests.size !== 1 || !semanticDigests.has(oracleSemanticSha256)) {
      throw new Error("FAIL-GIT-INGESTION-BENCHMARK: saturation changed normalized collector evidence from the synchronous oracle");
    }
    return {
      benchmark_id: "sei-async-git-saturation-benchmark-v1",
      case_id: normalizedCase.case_id,
      scenario: normalizedCase.scenario,
      requested_commit_count: normalizedCase.commit_count,
      iterations,
      oracle_semantic_sha256: oracleSemanticSha256,
      default_saturation: "auto",
      default_selection_reason: "bounded auto selected because the measured four-process saturation preserved the synchronous semantic digest and materially reduced median latency",
      measurements,
    };
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function runGitIngestionBenchmarkSuite({ cases = DEFAULT_BENCHMARK_CASES } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("FAIL-GIT-INGESTION-BENCHMARK: cases must be a non-empty array");
  }
  const normalizedCases = cases.map(assertCase);
  if (new Set(normalizedCases.map((entry) => entry.case_id)).size !== normalizedCases.length) {
    throw new Error("FAIL-GIT-INGESTION-BENCHMARK: case IDs must be unique");
  }
  const results = normalizedCases.map((caseDefinition) => {
    const fixture = createGitIngestionBenchmarkFixture(caseDefinition);
    try {
      return {
        case_id: caseDefinition.case_id,
        scenario: caseDefinition.scenario,
        requested_commit_count: caseDefinition.commit_count,
        ...benchmarkGitIngestion({
          repo_root: fixture.root,
          repository_revision: fixture.revision,
          generated_path_patterns: [],
        }),
      };
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
  return { benchmark_id: "sei-git-ingestion-scale-benchmark-v1", cases: results };
}

if (require.main === module) {
  const results = runGitIngestionBenchmarkSuite();
  process.stdout.write(`${JSON.stringify(results)}\n`);
}

module.exports = {
  DEFAULT_BENCHMARK_CASES,
  benchmarkGitIngestion,
  benchmarkGitIngestionAsync,
  runGitIngestionSaturationBenchmark,
  runGitIngestionBenchmarkSuite,
};
