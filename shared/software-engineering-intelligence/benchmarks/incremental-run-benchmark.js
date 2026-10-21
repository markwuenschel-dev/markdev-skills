#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FAILURE = "FAIL-INCREMENTAL-BENCHMARK";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GATE_KEYS = Object.freeze(["cold", "history_only", "no_change", "one_file", "rss"]);

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
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(stableCompare).map((key) => [key, canonicalValue(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort(stableCompare)) === canonicalJson([...keys].sort(stableCompare));
}

function positiveInteger(value, label, maximum) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) fail(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) fail(`${label} must not exceed ${maximum}`);
  return parsed;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) fail("arguments must be flag/value pairs");
  const mapping = new Map([
    ["--oracle-receipt", "oracleReceipt"],
    ["--threshold-receipt", "thresholdReceipt"],
    ["--warmups", "warmups"],
    ["--repetitions", "repetitions"],
    ["--order", "order"],
    ["--out", "out"],
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[index + 1];
    if (!key || typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(`unsupported argument or missing value ${flag}`);
    if (Object.hasOwn(parsed, key)) fail(`duplicate argument ${flag}`);
    parsed[key] = value;
  }
  for (const key of ["oracleReceipt", "thresholdReceipt", "out"]) if (!Object.hasOwn(parsed, key)) fail(`${key} threshold-bound argument is required`);
  if ((parsed.order ?? "abba") !== "abba") fail("order must be abba");
  return {
    oracleReceipt: parsed.oracleReceipt,
    thresholdReceipt: parsed.thresholdReceipt,
    warmups: positiveInteger(parsed.warmups ?? "1", "warmups", 3),
    repetitions: positiveInteger(parsed.repetitions ?? "7", "repetitions", 12),
    order: "abba",
    out: parsed.out,
  };
}

function validateThresholdDecision(value) {
  if (!exactKeys(value, ["approved_at", "approved_by", "decision_sha256", "gates", "schema_version", "status"])
      || value.schema_version !== "sei.incremental-performance-threshold-decision@1"
      || value.status !== "approved" || typeof value.approved_by !== "string" || value.approved_by.trim().length === 0
      || Number.isNaN(Date.parse(value.approved_at)) || !exactKeys(value.gates, GATE_KEYS)) {
    fail("an exact owner-approved threshold decision is required");
  }
  for (const key of ["cold", "history_only", "no_change", "one_file"]) {
    if (!exactKeys(value.gates[key], ["p50_ratio_max", "p90_ratio_max"])
        || !Number.isFinite(value.gates[key].p50_ratio_max) || value.gates[key].p50_ratio_max <= 0
        || !Number.isFinite(value.gates[key].p90_ratio_max) || value.gates[key].p90_ratio_max <= 0) fail(`approved ${key} thresholds are invalid`);
  }
  if (!exactKeys(value.gates.rss, ["peak_ratio_max"])
      || !Number.isFinite(value.gates.rss.peak_ratio_max) || value.gates.rss.peak_ratio_max <= 0) fail("approved RSS threshold is invalid");
  const { decision_sha256: declared, ...body } = value;
  if (!SHA256.test(declared) || declared !== sha256(canonicalJson(body))) fail("threshold decision digest is invalid");
  return canonicalValue(value);
}

function buildAlternatingOrder(repetitions, order) {
  if (!Number.isInteger(repetitions) || repetitions <= 0 || order !== "abba") fail("benchmark order request is invalid");
  const pattern = ["A", "B", "B", "A"];
  const sequence = [];
  for (let index = 0; index < repetitions; index += 1) {
    sequence.push(...(pattern[index % pattern.length] === "A" ? ["A", "B"] : ["B", "A"]));
  }
  return sequence;
}

function readCanonicalReceipt(filePath, maximum, label) {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maximum) fail(`${label} is not a bounded regular file`);
  const bytes = fs.readFileSync(filePath, "utf8");
  let value;
  try { value = JSON.parse(bytes); } catch (error) { fail(`${label} is invalid JSON (${error.message})`); }
  if (`${JSON.stringify(canonicalValue(value), null, 2)}\n` !== bytes) fail(`${label} is not canonical pretty JSON`);
  return value;
}

function readJsonReceipt(filePath, maximum, label) {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maximum) fail(`${label} is not a bounded regular file`);
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) { fail(`${label} is invalid JSON (${error.message})`); }
}

function validateOracleReceipt(value) {
  if (!value || value.schema_version !== "sei.cqr-incrementality-oracle@1" || value.status !== "PASS"
      || value.verdict_scope !== "correctness-only-no-performance-acceptance" || !Array.isArray(value.scenarios) || value.scenarios.length !== 3
      || value.archived_baseline_parity !== true || value.threshold_decision !== "not-supplied-performance-benchmark-blocked") fail("oracle receipt is not an eligible correctness receipt");
  const { receipt_id: declared, ...body } = value;
  if (!SHA256.test(declared) || declared !== sha256(canonicalJson(body))) fail("oracle receipt digest is stale");
  for (const root of [value.baseline_sei?.root, value.candidate_sei?.root, value.fixture?.repository_root]) {
    if (typeof root !== "string" || !path.isAbsolute(root)) fail("oracle receipt roots are invalid");
  }
  return value;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function summarizeRatios(samples) {
  const durationRatios = samples.map((entry) => entry.b_duration_ms / entry.a_duration_ms);
  const rssRatios = samples.map((entry) => entry.b_max_rss / entry.a_max_rss);
  return {
    count: samples.length,
    p50_ratio: Number(percentile(durationRatios, 0.5).toFixed(6)),
    p90_ratio: Number(percentile(durationRatios, 0.9).toFixed(6)),
    peak_rss_ratio: Number(Math.max(...rssRatios).toFixed(6)),
  };
}

function evaluateGates(summaries, decision) {
  const checks = {};
  for (const key of ["cold", "history_only", "no_change", "one_file"]) {
    checks[key] = summaries[key].p50_ratio <= decision.gates[key].p50_ratio_max
      && summaries[key].p90_ratio <= decision.gates[key].p90_ratio_max;
  }
  checks.rss = Math.max(...Object.values(summaries).map((entry) => entry.peak_rss_ratio)) <= decision.gates.rss.peak_ratio_max;
  return { checks, pass: Object.values(checks).every(Boolean) };
}

function run(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: null,
    windowsHide: true,
    timeout: options.timeout ?? 180_000,
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (result.error || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : String(result.stderr ?? "").trim();
    fail(`${options.label ?? command} failed${result.error ? ` (${result.error.message})` : ` with exit ${result.status}${stderr ? ` (${stderr.slice(0, 4096)})` : ""}`}`);
  }
  return { stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""), durationMs };
}

function git(root, args, label = `git ${args[0]}`) {
  return run("git", args, { cwd: root, label }).stdout.toString("utf8").trim();
}

function gitState(root) {
  return {
    revision: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
    status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

function checkout(root, revision) {
  git(root, ["checkout", "--quiet", "--detach", revision]);
  const state = gitState(root);
  if (state.revision !== revision || state.status !== "") fail(`benchmark fixture checkout ${revision} drifted`);
}

function regularSha(filePath, label) {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 256 * 1024 * 1024) fail(`${label} is not a bounded regular file`);
  return sha256(fs.readFileSync(filePath));
}

function measureProduct({ seiRoot, repositoryRoot, out, pythonExecutable, incremental, baseline, performancePath, configRoot }) {
  const cliPath = path.join(seiRoot, "skills", "shared", "software-engineering-intelligence", "cli.js");
  const config = path.join(configRoot, "skills", "software-engineering-intelligence", "assets", "canonical-input.json");
  const argv = ["--repo", repositoryRoot, "--out", out, "--config", config, "--python", pythonExecutable];
  if (incremental !== null) argv.push("--incremental", incremental);
  if (baseline !== null) argv.push("--baseline", baseline);
  if (performancePath !== null) argv.push("--performance-json", performancePath);
  const wrapper = "const c=require(process.argv[1]);c.execute(JSON.parse(process.argv[2])).then(r=>process.stdout.write(JSON.stringify({receipt:r,max_rss_kb:process.resourceUsage().maxRSS}))).catch(e=>{console.error(e&&e.stack||e);process.exitCode=1})";
  const measured = run(process.execPath, ["-e", wrapper, cliPath, JSON.stringify(argv)], { cwd: seiRoot, label: `benchmark ${incremental ?? "baseline"} product` });
  let envelope;
  try { envelope = JSON.parse(measured.stdout.toString("utf8")); } catch (error) { fail(`benchmark product receipt was malformed (${error.message})`); }
  if (!Number.isFinite(envelope.max_rss_kb) || envelope.max_rss_kb <= 0) fail("benchmark product RSS was unavailable");
  const snapshotSha = regularSha(envelope.receipt.snapshot_path, "benchmark snapshot");
  const reportSha = regularSha(envelope.receipt.report_path, "benchmark report");
  const performance = performancePath === null ? null : readJsonReceipt(performancePath, 16 * 1024 * 1024, "sample performance receipt");
  return {
    duration_ms: Number(measured.durationMs.toFixed(3)),
    max_rss_kb: envelope.max_rss_kb,
    snapshot_sha256: snapshotSha,
    report_sha256: reportSha,
    comparison_sha256: sha256(canonicalJson(envelope.receipt.comparison)),
    incremental: performance === null ? null : {
      static_mode: envelope.receipt.performance.incremental_stages?.static?.reuse?.mode ?? null,
      static_recomputed: envelope.receipt.performance.incremental_stages?.static?.reuse?.recomputed_file_count ?? null,
      history_mode: envelope.receipt.performance.incremental_stages?.history?.reuse?.mode ?? null,
      history_appended: envelope.receipt.performance.incremental_stages?.history?.reuse?.appended_commit_count ?? null,
      phase_reconciled: envelope.receipt.performance.phase_telemetry?.reconciliation?.within_tolerance === true,
    },
  };
}

function assertPairParity(a, b, scenario) {
  for (const field of ["snapshot_sha256", "report_sha256", "comparison_sha256"]) if (a[field] !== b[field]) fail(`${scenario} paired ${field} differs`);
}

function seedIncremental({ oracle, scenario, sampleRoot }) {
  const repositoryRoot = oracle.fixture.repository_root;
  const candidateRoot = oracle.candidate_sei.root;
  const pythonExecutable = oracle.python.executable;
  const stateRoot = path.join(sampleRoot, "i");
  const performanceRoot = path.join(sampleRoot, "p");
  fs.mkdirSync(performanceRoot, { recursive: true });
  checkout(repositoryRoot, oracle.fixture.revisions.s0);
  const s0 = measureProduct({
    seiRoot: candidateRoot, repositoryRoot, out: stateRoot, pythonExecutable,
    incremental: "auto", baseline: null, performancePath: path.join(performanceRoot, "seed-s0.json"), configRoot: candidateRoot,
  });
  if (scenario === "no_change") return { stateRoot, revision: oracle.fixture.revisions.s0, baseline: null, expected: { static: "exact", recomputed: 0, history: "exact", appended: 0 } };
  checkout(repositoryRoot, oracle.fixture.revisions.s1);
  if (scenario === "one_file") return { stateRoot, revision: oracle.fixture.revisions.s1, baseline: path.join(stateRoot, "snapshots", `${path.basename(findSnapshot(stateRoot))}`), expected: { static: "partial", recomputed: 1, history: "append", appended: 1 } };
  const s1 = measureProduct({
    seiRoot: candidateRoot, repositoryRoot, out: stateRoot, pythonExecutable,
    incremental: "auto", baseline: findSnapshot(stateRoot), performancePath: path.join(performanceRoot, "seed-s1.json"), configRoot: candidateRoot,
  });
  void s0; void s1;
  checkout(repositoryRoot, oracle.fixture.revisions.s2);
  return { stateRoot, revision: oracle.fixture.revisions.s2, baseline: findSnapshotForRevision(stateRoot, oracle.fixture.revisions.s1), expected: { static: "hit", recomputed: 0, history: "append", appended: 1 } };
}

function snapshotFiles(root) {
  const directory = path.join(root, "snapshots");
  return fs.readdirSync(directory).map((name) => path.join(directory, name)).sort(stableCompare);
}

function findSnapshot(root) {
  const files = snapshotFiles(root);
  if (files.length === 0) fail("incremental seed snapshot is missing");
  return files.at(-1);
}

function findSnapshotForRevision(root, revision) {
  for (const filePath of snapshotFiles(root)) {
    const snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (snapshot.repository?.revision === revision) return filePath;
  }
  fail(`incremental seed snapshot for ${revision} is missing`);
}

function measureScenarioPair({ oracle, scenario, sampleRoot, orientation }) {
  const repositoryRoot = oracle.fixture.repository_root;
  const candidateRoot = oracle.candidate_sei.root;
  const pythonExecutable = oracle.python.executable;
  fs.mkdirSync(sampleRoot, { recursive: true });
  if (scenario === "cold") {
    checkout(repositoryRoot, oracle.fixture.revisions.s0);
    const invoke = (side) => measureProduct({
      seiRoot: side === "A" ? oracle.baseline_sei.root : candidateRoot,
      repositoryRoot,
      out: path.join(sampleRoot, side.toLowerCase()),
      pythonExecutable,
      incremental: side === "A" ? null : "off",
      baseline: null,
      performancePath: side === "A" ? null : path.join(sampleRoot, "candidate-performance.json"),
      configRoot: candidateRoot,
    });
    const values = {};
    for (const side of orientation) values[side] = invoke(side);
    assertPairParity(values.A, values.B, scenario);
    return values;
  }
  const seed = seedIncremental({ oracle, scenario, sampleRoot });
  checkout(repositoryRoot, seed.revision);
  const invoke = (side) => {
    const value = measureProduct({
      seiRoot: candidateRoot, repositoryRoot,
      out: side === "A" ? path.join(sampleRoot, "a") : seed.stateRoot,
      pythonExecutable, incremental: side === "A" ? "off" : "auto", baseline: seed.baseline,
      performancePath: path.join(sampleRoot, `${side.toLowerCase()}-performance.json`), configRoot: candidateRoot,
    });
    if (side === "B" && (value.incremental.static_mode !== seed.expected.static
        || value.incremental.static_recomputed !== seed.expected.recomputed
        || value.incremental.history_mode !== seed.expected.history
        || value.incremental.history_appended !== seed.expected.appended
        || value.incremental.phase_reconciled !== true)) fail(`${scenario} incremental telemetry drifted`);
    return value;
  };
  const values = {};
  for (const side of orientation) values[side] = invoke(side);
  assertPairParity(values.A, values.B, scenario);
  return values;
}

function runIncrementalBenchmark(input) {
  const oracle = validateOracleReceipt(readCanonicalReceipt(path.resolve(input.oracleReceipt), 4 * 1024 * 1024, "oracle receipt"));
  const decision = validateThresholdDecision(readCanonicalReceipt(path.resolve(input.thresholdReceipt), 64 * 1024, "threshold decision"));
  const out = path.resolve(input.out);
  if (fs.existsSync(out)) fail("benchmark output must be a fresh path");
  const lock = path.join(os.tmpdir(), `sei-incremental-benchmark-${crypto.createHash("sha256").update(out).digest("hex")}.lock`);
  try { fs.mkdirSync(lock); } catch (error) { fail(`overlapping benchmark is not allowed (${error.code ?? error.message})`); }
  try {
    fs.mkdirSync(out, { recursive: false });
    const statfs = fs.statfsSync(out);
    if (Number(statfs.bavail) * Number(statfs.bsize) < 2 * 1024 * 1024 * 1024) fail("insufficient free disk for the official benchmark");
    const fixtureBefore = gitState(oracle.fixture.repository_root);
    const codeBefore = [gitState(oracle.baseline_sei.root), gitState(oracle.candidate_sei.root)];
    if (fixtureBefore.status !== "" || codeBefore.some((state) => state.status !== "")) fail("benchmark inputs must be clean");
    const scenarios = ["cold", "no_change", "one_file", "history_only"];
    const samples = Object.fromEntries(scenarios.map((scenario) => [scenario, []]));
    let sequence = 0;
    for (const scenario of scenarios) {
      for (let warmup = 0; warmup < input.warmups; warmup += 1) {
        const orientation = buildAlternatingOrder(1, input.order);
        measureScenarioPair({ oracle, scenario, sampleRoot: path.join(out, "r", `w${sequence++}`), orientation });
      }
      const order = buildAlternatingOrder(input.repetitions, input.order);
      for (let repetition = 0; repetition < input.repetitions; repetition += 1) {
        const orientation = order.slice(repetition * 2, repetition * 2 + 2);
        const pair = measureScenarioPair({ oracle, scenario, sampleRoot: path.join(out, "r", `m${sequence++}`), orientation });
        samples[scenario].push({
          order: orientation.join(""),
          a_duration_ms: pair.A.duration_ms,
          b_duration_ms: pair.B.duration_ms,
          a_max_rss: pair.A.max_rss_kb,
          b_max_rss: pair.B.max_rss_kb,
          snapshot_sha256: pair.A.snapshot_sha256,
          report_sha256: pair.A.report_sha256,
          comparison_sha256: pair.A.comparison_sha256,
        });
      }
    }
    checkout(oracle.fixture.repository_root, fixtureBefore.revision);
    const fixtureAfter = gitState(oracle.fixture.repository_root);
    const codeAfter = [gitState(oracle.baseline_sei.root), gitState(oracle.candidate_sei.root)];
    if (canonicalJson(fixtureAfter) !== canonicalJson(fixtureBefore) || canonicalJson(codeAfter) !== canonicalJson(codeBefore)) fail("benchmark inputs changed");
    const summaries = Object.fromEntries(scenarios.map((scenario) => [scenario, summarizeRatios(samples[scenario])]));
    const gates = evaluateGates(summaries, decision);
    const body = canonicalValue({
      schema_version: "sei.incremental-run-benchmark@1",
      status: gates.pass ? "PASS" : "FAIL",
      oracle_receipt_id: oracle.receipt_id,
      threshold_decision_sha256: decision.decision_sha256,
      method: { warmups: input.warmups, repetitions: input.repetitions, order: input.order, sample_deletion: false },
      samples,
      summaries,
      gates,
      rss_unit: "node-process-resource-usage-maxRSS-kilobytes",
      process_tree_rss: "not-measured",
      fixture_preserved: true,
    });
    const receipt = canonicalValue({ ...body, receipt_id: sha256(canonicalJson(body)) });
    fs.writeFileSync(path.join(out, "benchmark-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return receipt;
  } finally {
    try { fs.rmdirSync(lock); } catch { /* bounded lease cleanup */ }
  }
}

function main(argv = process.argv.slice(2)) {
  try {
    const receipt = runIncrementalBenchmark(parseArguments(argv));
    process.stdout.write(`${JSON.stringify({ status: receipt.status, receipt_id: receipt.receipt_id })}\n`);
    return receipt.status === "PASS" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  buildAlternatingOrder,
  evaluateGates,
  parseArguments,
  runIncrementalBenchmark,
  summarizeRatios,
  validateOracleReceipt,
  validateThresholdDecision,
};
