#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildRepositoryIndex } = require("../repository-index.js");
const { analyzeStaticIntelligence } = require("../static-intelligence.js");
const { TaskExecutor } = require("../task-executor.js");

const FAILURE = "FAIL-PYTHON-STATIC-BENCHMARK";
const ALLOWED_MODES = new Set(["serial", "2", "auto"]);

function fail(detail) {
  throw new Error(`${FAILURE}: ${detail}`);
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: null,
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? (128 * 1024 * 1024),
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.error || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : String(result.stderr ?? "").trim();
    fail(`${options.label ?? command} failed${result.error ? ` (${result.error.message})` : ` with exit ${result.status}${stderr ? ` (${stderr.slice(0, 4096)})` : ""}`}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

function git(repositoryRoot, args, label = `git ${args[0]}`) {
  return run("git", args, { cwd: repositoryRoot, label });
}

function oneLine(bytes, label) {
  const value = bytes.toString("utf8").trim();
  if (!value || value.includes("\n") || value.includes("\r")) fail(`${label} was malformed`);
  return value;
}

function parsePositiveInteger(value, label, maximum) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) fail(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) fail(`${label} must not exceed ${maximum}`);
  return parsed;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail("arguments must be an array");
  const mapping = new Map([
    ["--repo", "repositoryRoot"],
    ["--revision", "revision"],
    ["--python", "pythonExecutable"],
    ["--modes", "modes"],
    ["--repetitions", "repetitions"],
    ["--warmups", "warmups"],
    ["--out", "out"],
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[index + 1];
    if (!key || typeof value !== "string" || !value || value.includes("\0")) fail(`unsupported argument or missing value ${flag}`);
    if (Object.hasOwn(parsed, key)) fail(`duplicate argument ${flag}`);
    parsed[key] = value;
  }
  for (const key of ["repositoryRoot", "revision", "pythonExecutable"]) {
    if (!Object.hasOwn(parsed, key)) fail(`${key} is required`);
  }
  parsed.revision = parsed.revision.toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed.revision)) fail("revision must be a full lowercase Git commit identity");
  const modes = (parsed.modes ?? "serial,2,auto").split(",");
  if (modes.length === 0 || new Set(modes).size !== modes.length || modes.some((mode) => !ALLOWED_MODES.has(mode))) {
    fail("modes must be a unique comma-separated subset of serial,2,auto");
  }
  return {
    repositoryRoot: parsed.repositoryRoot,
    revision: parsed.revision,
    pythonExecutable: parsed.pythonExecutable,
    modes,
    repetitions: parsePositiveInteger(parsed.repetitions ?? "3", "repetitions", 20),
    warmups: parsed.warmups === undefined ? 1 : parsePositiveInteger(parsed.warmups, "warmups", 10),
    out: parsed.out ?? null,
  };
}

class MemoryCache {
  constructor() {
    this.entries = new Map();
    this.reads = 0;
    this.creates = 0;
  }

  async read(key, { signal }) {
    if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
    this.reads += 1;
    const value = this.entries.get(key);
    return value === undefined ? null : Buffer.from(value);
  }

  async create(key, bytes, { signal }) {
    if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
    this.creates += 1;
    if (this.entries.has(key)) return "exists";
    this.entries.set(key, Buffer.from(bytes));
    return "created";
  }
}

function executorForMode(mode) {
  const options = mode === "serial"
    ? { maxWorkers: 1, resourceLimits: { external_process: 1 }, groupLimits: { "python-ast": 1 } }
    : mode === "2"
      ? { maxWorkers: 2, resourceLimits: { external_process: 2 }, groupLimits: { "python-ast": 2 } }
      : { maxWorkers: "auto", groupLimits: { "python-ast": 2 } };
  const inner = new TaskExecutor({
    ...options,
    maxQueued: 1024,
    maxMemoryWeight: 8,
    defaultTimeoutMs: 32_000,
  });
  const observed = {
    groupLimits: inner.groupLimits,
    runs: [],
    async run(tasks, runOptions) {
      const result = await inner.run(tasks, runOptions);
      observed.runs.push(structuredClone(result.telemetry));
      return result;
    },
  };
  return observed;
}

function probePython(pythonExecutable) {
  if (!path.isAbsolute(pythonExecutable) || !fs.statSync(pythonExecutable, { throwIfNoEntry: false })?.isFile()) {
    fail("pythonExecutable must be an existing absolute file");
  }
  const value = JSON.parse(run(pythonExecutable, ["-I", "-S", "-c", "import json,platform,sys;print(json.dumps({'implementation':sys.implementation.name,'version':platform.python_version(),'grammar':[sys.version_info.major,sys.version_info.minor]},sort_keys=True,separators=(',',':')))"], {
    label: "isolated CPython probe",
    timeout: 30_000,
    maxBuffer: 4096,
  }).toString("utf8"));
  if (value.implementation !== "cpython" || value.version !== "3.13.7"
      || JSON.stringify(value.grammar) !== JSON.stringify([3, 13])) {
    fail(`benchmark requires exact CPython 3.13.7, observed ${JSON.stringify(value)}`);
  }
  return value;
}

function summarize(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const total = ordered.reduce((sum, value) => sum + value, 0);
  const median = ordered.length % 2 === 1
    ? ordered[Math.floor(ordered.length / 2)]
    : (ordered[(ordered.length / 2) - 1] + ordered[ordered.length / 2]) / 2;
  return {
    count: ordered.length,
    min: Number(ordered[0].toFixed(3)),
    median: Number(median.toFixed(3)),
    mean: Number((total / ordered.length).toFixed(3)),
    max: Number(ordered.at(-1).toFixed(3)),
  };
}

async function measureAnalyzer({ repositoryIndex, pythonExecutable, mode, cache, configurationOverrides }) {
  const taskExecutor = executorForMode(mode);
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 5);
  const started = process.hrtime.bigint();
  let result;
  try {
    result = await analyzeStaticIntelligence({
      repositoryIndex,
      taskExecutor,
      cache,
      configuration: {
        pythonExecutable,
        grammarTarget: [3, 13],
        moduleRoots: [],
        ...(configurationOverrides ?? {}),
      },
    });
  } finally {
    clearInterval(sampler);
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const rssAfter = process.memoryUsage().rss;
  rssPeak = Math.max(rssPeak, rssAfter);
  const outputBytes = Buffer.from(JSON.stringify(result.canonical), "utf8");
  return {
    duration_ms: Number(durationMs.toFixed(3)),
    parent_rss_before_bytes: rssBefore,
    parent_rss_after_bytes: rssAfter,
    parent_rss_peak_bytes: rssPeak,
    parent_rss_delta_bytes: rssAfter - rssBefore,
    output_bytes: outputBytes.length,
    output_digest: sha256(outputBytes),
    analyzer_telemetry: structuredClone(result.telemetry),
    executor_runs: taskExecutor.runs,
  };
}

async function measurePair(context) {
  const cache = new MemoryCache();
  const cold = await measureAnalyzer({ ...context, cache });
  const warm = await measureAnalyzer({ ...context, cache });
  if (cold.output_digest !== warm.output_digest || cold.output_bytes !== warm.output_bytes) {
    fail(`${context.mode} cold/warm canonical evidence differs`);
  }
  if (warm.analyzer_telemetry.tasks_submitted !== 0 || warm.analyzer_telemetry.parse.misses !== 0
      || warm.analyzer_telemetry.graph.misses !== 0) {
    fail(`${context.mode} warm measurement did not reuse the complete analyzer cache`);
  }
  return { cold, warm };
}

async function runPythonStaticBenchmark(input = {}) {
  const {
    repositoryRoot,
    revision,
    pythonExecutable,
    modes = ["serial", "2", "auto"],
    repetitions = 3,
    warmups = 1,
    configurationOverrides = {},
  } = input;
  if (typeof repositoryRoot !== "string" || !fs.statSync(repositoryRoot, { throwIfNoEntry: false })?.isDirectory()) fail("repositoryRoot must be an existing directory");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision ?? "")) fail("revision must be an exact full lowercase Git identity");
  if (!Array.isArray(modes) || modes.length === 0 || new Set(modes).size !== modes.length || modes.some((mode) => !ALLOWED_MODES.has(mode))) fail("modes are invalid");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) fail("repetitions must be 1 through 20");
  if (!Number.isInteger(warmups) || warmups < 0 || warmups > 10) fail("warmups must be 0 through 10");
  if (configurationOverrides === null || typeof configurationOverrides !== "object" || Array.isArray(configurationOverrides)) fail("configurationOverrides must be an object");

  const root = fs.realpathSync.native(repositoryRoot);
  const exactCommit = oneLine(git(root, ["rev-parse", "--verify", `${revision}^{commit}`]), "benchmark commit");
  if (exactCommit !== revision) fail("revision did not resolve byte-for-byte to the supplied commit");
  const rootTree = oneLine(git(root, ["rev-parse", "--verify", `${revision}^{tree}`]), "benchmark root tree");
  const statusBefore = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], "benchmark pre-run status");
  if (statusBefore.length !== 0) fail("benchmark repository must be clean and read-only");
  const python = probePython(pythonExecutable);

  const repositoryIndex = await buildRepositoryIndex({
    repository_root: root,
    repository_revision: revision,
    generated_path_patterns: ["build/**", "coverage/**", "dist/**", "generated/**"],
  });
  const modeResults = [];
  const allDigests = new Set();
  for (const mode of modes) {
    const context = { repositoryIndex, pythonExecutable, mode, configurationOverrides };
    for (let index = 0; index < warmups; index += 1) await measurePair(context);
    const measurements = [];
    for (let index = 0; index < repetitions; index += 1) {
      const measurement = await measurePair(context);
      measurements.push({ repetition: index + 1, ...measurement });
      allDigests.add(measurement.cold.output_digest);
      allDigests.add(measurement.warm.output_digest);
    }
    modeResults.push({
      mode,
      measurements,
      descriptive_summary: {
        cold_duration_ms: summarize(measurements.map((entry) => entry.cold.duration_ms)),
        warm_duration_ms: summarize(measurements.map((entry) => entry.warm.duration_ms)),
        cold_parent_rss_peak_bytes: summarize(measurements.map((entry) => entry.cold.parent_rss_peak_bytes)),
        warm_parent_rss_peak_bytes: summarize(measurements.map((entry) => entry.warm.parent_rss_peak_bytes)),
      },
    });
  }
  if (allDigests.size !== 1) fail(`canonical analyzer evidence differs across modes: ${[...allDigests].sort(stableCompare).join(", ")}`);
  const statusAfter = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], "benchmark post-run status");
  if (!statusBefore.equals(statusAfter)) fail("benchmark changed the read-only repository working tree");
  const seiRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const seiHead = oneLine(git(seiRoot, ["rev-parse", "--verify", "HEAD^{commit}"]), "SEI HEAD");
  return {
    schema_version: "sei.python-static-benchmark@1",
    status: "PASS",
    benchmark_boundary: "python-static-analyzer-stage-after-repository-index",
    repository_revision: revision,
    repository_root_tree: rootTree,
    repository_index_digest: repositoryIndex.binding.index_digest,
    sei_product_revision: seiHead,
    benchmark_script_sha256: sha256(fs.readFileSync(__filename)),
    python,
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    host_parallelism: typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    requested_modes: [...modes],
    repetitions,
    warmups,
    canonical_output_digest: [...allDigests][0],
    evidence_equality: true,
    process_tree_peak_rss_bytes: null,
    process_tree_rss_reason: "unavailable — portable child-process-tree RSS sampling was not supplied; parent RSS is measured separately",
    useful_speedup_threshold: "not-defined",
    default_concurrency_recommendation: null,
    concurrency_credit: "not-assessed",
    modes: modeResults,
  };
}

async function main(argv) {
  const options = parseArguments(argv);
  const receipt = await runPythonStaticBenchmark(options);
  if (options.out !== null) {
    const out = path.resolve(options.out);
    if (fs.existsSync(out)) fail("--out must identify a fresh absent directory");
    fs.mkdirSync(out, { recursive: false });
    fs.writeFileSync(path.join(out, "benchmark-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return receipt;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, runPythonStaticBenchmark };
