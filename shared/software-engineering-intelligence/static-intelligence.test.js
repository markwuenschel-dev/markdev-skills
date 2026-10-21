"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  PYTHON_AST_ANALYZER_VERSION,
  analyzeStaticIntelligence,
} = require("./static-intelligence");
const { buildRepositoryIndex } = require("./repository-index");
const { TaskExecutor } = require("./task-executor");
const INVALIDATION_PRIVATE = require("./dependency-invalidation.js")[Symbol.for("sei.dependency-invalidation.private@1")];

const FIXTURE_ROOT = path.join(__dirname, "fixtures", "python-ast", "imports");
const IMPORTS_EXPECTED = require("./fixtures/python-ast/imports.expected.json");
const CACHE_EXPECTED = require("./fixtures/python-ast/cache.expected.json");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function python313() {
  if (process.env.SEI_PYTHON_313 && path.isAbsolute(process.env.SEI_PYTHON_313)) return process.env.SEI_PYTHON_313;
  const launcher = spawnSync("py", ["-3.13", "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (launcher.status === 0 && path.isAbsolute(launcher.stdout.trim())) return launcher.stdout.trim();
  throw new Error("focused T3 tests require an explicit CPython 3.13 executable (SEI_PYTHON_313)");
}

function createRepository(fixtureName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sei-static-${fixtureName}-`));
  fs.cpSync(path.join(FIXTURE_ROOT, fixtureName), root, { recursive: true });
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Fixture"], root);
  run("git", ["config", "user.email", "fixture@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "fixture"], root);
  return { root, revision: run("git", ["rev-parse", "HEAD"], root) };
}

function commitAll(repository, message) {
  run("git", ["add", "--all"], repository.root);
  run("git", ["commit", "--quiet", "-m", message], repository.root);
  repository.revision = run("git", ["rev-parse", "HEAD"], repository.root);
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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function cacheArtifact(cache, kind, predicate = () => true) {
  const match = [...cache.entries].find(([, bytes]) => {
    try {
      const artifact = JSON.parse(bytes.toString("utf8"));
      return artifact.kind === kind && predicate(artifact.payload);
    } catch {
      return false;
    }
  });
  assert.ok(match, `${kind} cache artifact must exist`);
  return match;
}

function resignArtifact(bytes, mutatePayload) {
  const artifact = JSON.parse(bytes.toString("utf8"));
  mutatePayload(artifact.payload);
  const body = {
    kind: artifact.kind,
    schema_version: artifact.schema_version,
    payload: artifact.payload,
  };
  artifact.artifact_hash = digest(canonicalJson(body));
  return Buffer.from(canonicalJson(artifact), "utf8");
}

class ConflictingCache extends MemoryCache {
  constructor() {
    super();
    this.injected = false;
  }

  async create(key, bytes, options) {
    if (!this.injected && bytes.includes(Buffer.from('"kind":"python-parse-fact"'))) {
      this.injected = true;
      const artifact = JSON.parse(bytes.toString("utf8"));
      artifact.payload.callables.push({
        col_offset: 0,
        complexity: 1,
        end_col_offset: 1,
        end_lineno: 1,
        kind: "function",
        lineno: 1,
        qualified_name: "valid_but_conflicting_cache_fact",
      });
      const body = {
        kind: artifact.kind,
        schema_version: artifact.schema_version,
        payload: artifact.payload,
      };
      artifact.artifact_hash = digest(canonicalJson(body));
      this.entries.set(key, Buffer.from(canonicalJson(artifact), "utf8"));
      return "exists";
    }
    return super.create(key, bytes, options);
  }
}

function configuration(overrides = {}) {
  return {
    pythonExecutable: python313(),
    grammarTarget: [3, 13],
    moduleRoots: [],
    maxFileBytes: 256 * 1024,
    maxBatchFiles: 3,
    maxBatchBytes: 256 * 1024,
    maxQueuedSourceBytes: 512 * 1024,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
    batchTimeoutMs: 30_000,
    ...overrides,
  };
}

function executor(workers) {
  return new TaskExecutor({
    maxWorkers: workers,
    resourceLimits: { external_process: workers },
    groupLimits: { "python-ast": workers },
    maxQueued: 64,
    maxMemoryWeight: 8,
    defaultTimeoutMs: 32_000,
  });
}

async function indexRepository(repository, { classified = true } = {}) {
  return buildRepositoryIndex({
    repository_root: repository.root,
    repository_revision: repository.revision,
    ...(classified ? { generated_path_patterns: ["generated/**"] } : {}),
  });
}

function cacheTelemetry(result) {
  return {
    parse_hits: result.telemetry.parse.hits,
    parse_misses: result.telemetry.parse.misses,
    parse_writes: result.telemetry.parse.writes,
    graph_hits: result.telemetry.graph.hits,
    graph_misses: result.telemetry.graph.misses,
    graph_writes: result.telemetry.graph.writes,
  };
}

async function analyze(repositoryIndex, cache, workers = 2, overrides = {}, signal = undefined) {
  return analyzeStaticIntelligence({
    repositoryIndex,
    taskExecutor: executor(workers),
    cache,
    configuration: configuration(overrides),
    ...(signal === undefined ? {} : { signal }),
  });
}

test("static intelligence exposes the closed T3 seam", () => {
  assert.equal(PYTHON_AST_ANALYZER_VERSION, "sei.python-ast@1");
  assert.equal(typeof analyzeStaticIntelligence, "function");
  assert.deepEqual(
    Object.keys(require("./static-intelligence")).sort(),
    ["PYTHON_AST_ANALYZER_VERSION", "analyzeStaticIntelligence"],
  );
});

test("index-backed Python intelligence resolves imports and preserves partial parse truth", { timeout: 120_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);
  const result = await analyzeStaticIntelligence({
    repositoryIndex,
    taskExecutor: executor(2),
    cache: null,
    configuration: configuration(),
  });

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.canonical.facts.topology));
  assert.deepEqual(result.canonical.diagnostics.module_roots.roots, ["src"]);
  assert.equal(result.canonical.collectors[0].status, "degraded");
  assert.deepEqual(result.canonical.facts.complexity.aggregate, IMPORTS_EXPECTED.complexity);
  assert.equal(result.canonical.facts.complexity.completeness, IMPORTS_EXPECTED.completeness);
  assert.deepEqual(result.canonical.facts.topology.imports.counts, IMPORTS_EXPECTED.import_counts);
  assert.deepEqual(result.canonical.facts.topology.imports.edge_occurrences, IMPORTS_EXPECTED.edge_occurrences);
  assert.deepEqual(result.canonical.facts.topology.partitions.production.topology.aggregates, IMPORTS_EXPECTED.production_aggregates);
  assert.deepEqual(result.canonical.facts.complexity.partitions.production.aggregate, {
    parsed_file_count: 6,
    supported_file_count: 7,
    callable_count: 6,
    complexity_sum: 16,
    complexity_p50: 2,
    complexity_p90: 6,
    complexity_max: 6,
  });
  assert.deepEqual(result.canonical.facts.complexity.partitions.all_python.aggregate, IMPORTS_EXPECTED.complexity);

  const metrics = new Map(result.canonical.metrics.map((metric) => [metric.metric_id, metric]));
  assert.equal(metrics.get("static.python.cyclomatic_complexity:production").value, 16);
  assert.equal(metrics.get("static.python.cyclomatic_complexity:production").measurement.completeness, 0.85714286);
  assert.equal(metrics.get("static.python.cyclomatic_complexity:all-python").value, 18);
  assert.equal(metrics.get("static.python.cyclomatic_complexity_p50:production").value, 2);
  assert.equal(metrics.get("static.python.cyclomatic_complexity_p90:all-python").value, 6);
  assert.equal(metrics.get("static.python.dependency.node_count:production").value, 7);
  assert.equal(metrics.get("static.python.dependency.node_count:all-python").value, 8);
  assert.equal(metrics.get("static.python.dependency.import_count:all-python:external").value, 3);
  assert.equal(metrics.get("static.python.dependency.import_count:all-python:unresolved-local-candidate").value, 1);
  assert.equal(metrics.get("static.python.dependency.import_count:all-python:unsupported-dynamic").value, 2);
  assert.equal(metrics.get("static.python.dependency.centrality:production").measurement.status, "unavailable");
  assert.equal(metrics.get("static.python.dependency.centrality:production").value, null);
  assert.equal(metrics.get("static.python.dependency.instability:production:acme.empty").measurement.status, "not-applicable");
  assert.equal(metrics.get("static.python.dependency.fan_out:production:acme.broken").measurement.status, "unavailable");
  assert.equal(metrics.get("static.python.dependency.fan_out:production:acme.broken").value, null);
  assert.equal(result.canonical.metrics.some((metric) => metric.metric_id.startsWith("dependency.")), false);

  const choose = result.canonical.metrics.find((metric) => metric.subject === "python-callable:src/acme/core.py#choose@19:0-23:12");
  assert.ok(choose, "each callable must have a stable qualified-name and literal-span subject");
  assert.equal(choose.value, 6);
  assert.equal(choose.scope.kind, "file");
  assert.equal(choose.scope.path, "src/acme/core.py");
  assert.ok(choose.source.artifact_refs.includes("python-callable:src/acme/core.py#choose@19:0-23:12"));
  const inner = result.canonical.metrics.find((metric) => metric.subject === "python-callable:src/acme/core.py#outer.<locals>.inner@27:4-28:44");
  assert.equal(inner?.value, 2);

  const emptyFile = metrics.get("static.cyclomatic_complexity:src/acme/empty.py");
  assert.equal(emptyFile.measurement.status, "measured");
  assert.equal(emptyFile.value, 0);
  assert.ok(emptyFile.source.artifact_refs.includes("python-partition:production"));

  const cyclicSccs = result.canonical.metrics.filter((metric) => metric.metric_id.startsWith("static.python.dependency.cyclic_scc_size:production:"));
  assert.equal(cyclicSccs.length, 1);
  assert.equal(cyclicSccs[0].value, 3);
  assert.deepEqual(
    cyclicSccs[0].source.artifact_refs.filter((reference) => reference.startsWith("python-scc-member:")),
    [
      "python-scc-member:acme.core@src/acme/core.py",
      "python-scc-member:acme.helpers@src/acme/helpers.py",
      "python-scc-member:acme@src/acme/__init__.py",
    ],
  );
  assert.ok(cyclicSccs[0].source.evidence_refs.some((reference) => reference === "python-import:src/acme/helpers.py:1:0->acme.core"));
  for (const metric of result.canonical.metrics) {
    for (const reference of [
      "python-analyzer:sei.python-ast@1",
      "python-runtime:cpython-3.13",
      "python-grammar:3.13",
      `python-configuration:${result.canonical.binding.configuration_hash}`,
    ]) {
      assert.ok(metric.source.artifact_refs.includes(reference), `${metric.metric_id} must bind ${reference}`);
      assert.ok(metric.source.evidence_refs.includes(reference), `${metric.metric_id} must evidence ${reference}`);
    }
  }
  assert.equal(result.telemetry.tasks_submitted, 3);
  assert.equal(CACHE_EXPECTED.parse_cache_schema, "sei.python-parse-cache@1");
});

test("a parsed Python file with no callable is zero only at file scope", { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-static-no-callable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "constants.py"), "ANSWER = 42\n", "utf8");
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Fixture"], root);
  run("git", ["config", "user.email", "fixture@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "fixture"], root);
  const repository = { root, revision: run("git", ["rev-parse", "HEAD"], root) };

  const result = await analyze(await indexRepository(repository), null);
  const aggregate = result.canonical.metrics.find((metric) => metric.metric_id === "static.cyclomatic_complexity");
  const languageAggregate = result.canonical.metrics.find((metric) => metric.metric_id === "static.python.cyclomatic_complexity:all-python");
  const file = result.canonical.metrics.find((metric) => metric.metric_id === "static.cyclomatic_complexity:constants.py");
  assert.equal(aggregate.measurement.status, "unavailable");
  assert.equal(aggregate.value, null);
  assert.equal(languageAggregate.measurement.status, "unavailable");
  assert.equal(languageAggregate.value, null);
  assert.equal(file.measurement.status, "measured");
  assert.equal(file.value, 0);
});

test("Python coverage ignores unrelated languages but records unassessed Python source", { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-static-language-coverage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "service.py"), "def ready(value):\n    return value + 1\n", "utf8");
  fs.writeFileSync(path.join(root, "ui.js"), "export const ready = true;\n", "utf8");
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Fixture"], root);
  run("git", ["config", "user.email", "fixture@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "initial fixture"], root);
  const repository = { root, revision: run("git", ["rev-parse", "HEAD"], root) };

  const full = await analyze(await indexRepository(repository), null);
  assert.equal(full.canonical.collectors[0].status, "available");
  assert.equal(full.canonical.facts.complexity.completeness, 1);
  assert.equal(full.canonical.diagnostics.coverage.selected_human_python, 1);
  assert.equal(full.canonical.diagnostics.coverage.indexed_python_source, 1);

  fs.mkdirSync(path.join(root, "generated"));
  fs.writeFileSync(path.join(root, "generated", "client.py"), "def generated():\n    return 1\n", "utf8");
  commitAll(repository, "add generated Python");

  const partial = await analyze(await indexRepository(repository), null);
  assert.equal(partial.canonical.collectors[0].status, "degraded");
  assert.equal(partial.canonical.facts.complexity.completeness, 0.5);
  assert.equal(partial.canonical.diagnostics.coverage.excluded_generated, 1);
  assert.match(partial.canonical.collectors[0].reason, /generated/i);
});

test("immutable caches preserve canonical facts, recover corruption, and invalidate graph identity", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const cache = new MemoryCache();
  let repositoryIndex = await indexRepository(repository);

  const cold = await analyze(repositoryIndex, cache);
  assert.deepEqual(cacheTelemetry(cold), CACHE_EXPECTED.cold);
  const warm = await analyze(repositoryIndex, cache);
  assert.deepEqual(cacheTelemetry(warm), CACHE_EXPECTED.warm);
  assert.equal(JSON.stringify(warm.canonical), JSON.stringify(cold.canonical));

  const parseArtifact = [...cache.entries].find(([, bytes]) => bytes.includes(Buffer.from('"kind":"python-parse-fact"')));
  assert.ok(parseArtifact, "a successful parse fact must be cached");
  assert.doesNotMatch(parseArtifact[1].toString("utf8"), /"path"|"module_id"|"test_source"|"generated"/);
  cache.entries.set(parseArtifact[0], Buffer.from("{truncated", "utf8"));
  const recovered = await analyze(repositoryIndex, cache);
  assert.equal(recovered.telemetry.parse.corrupt, 1);
  assert.equal(recovered.telemetry.parse.misses, 2);
  assert.equal(recovered.telemetry.graph.hits, 1);
  assert.deepEqual(recovered.canonical.facts.complexity, cold.canonical.facts.complexity);
  assert.deepEqual(recovered.canonical.facts.topology, cold.canonical.facts.topology);
  assert.deepEqual(recovered.canonical.metrics, cold.canonical.metrics);
  assert.deepEqual(recovered.canonical, cold.canonical);
  cache.entries.set(parseArtifact[0], Buffer.from(parseArtifact[1]));

  fs.renameSync(path.join(repository.root, "src", "acme", "empty.py"), path.join(repository.root, "src", "acme", "renamed.py"));
  commitAll(repository, "rename without changing blob bytes");
  repositoryIndex = await indexRepository(repository);
  const renamed = await analyze(repositoryIndex, cache);
  assert.deepEqual(cacheTelemetry(renamed), CACHE_EXPECTED.rename);
  assert.notEqual(renamed.canonical.binding.graph_cache_key, cold.canonical.binding.graph_cache_key);
  assert.ok(renamed.canonical.facts.topology.modules.some((module) => module.id === "acme.renamed"));

  fs.writeFileSync(path.join(repository.root, "src", "acme", "new_target.py"), "VALUE = 2\n", "utf8");
  commitAll(repository, "add a module");
  repositoryIndex = await indexRepository(repository);
  const added = await analyze(repositoryIndex, cache);
  assert.deepEqual(cacheTelemetry(added), CACHE_EXPECTED.add_module);
  assert.notEqual(added.canonical.binding.graph_cache_key, renamed.canonical.binding.graph_cache_key);

  fs.appendFileSync(path.join(repository.root, "pyproject.toml"), "\n# exact manifest identity changed\n", "utf8");
  commitAll(repository, "change manifest bytes");
  repositoryIndex = await indexRepository(repository);
  const manifestChanged = await analyze(repositoryIndex, cache);
  assert.notEqual(manifestChanged.canonical.binding.module_root_manifest_digest, added.canonical.binding.module_root_manifest_digest);
  assert.equal(manifestChanged.telemetry.graph.misses, 1);
  assert.equal(manifestChanged.telemetry.graph.hits, 0);
});

test("history-only descendants reuse the content-derived Python graph materialization", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const cache = new MemoryCache();
  const firstIndex = await indexRepository(repository);
  const first = await analyze(firstIndex, cache);

  run("git", ["commit", "--quiet", "--allow-empty", "-m", "history only"], repository.root);
  repository.revision = run("git", ["rev-parse", "HEAD"], repository.root);
  const secondIndex = await indexRepository(repository);
  const second = await analyze(secondIndex, cache);

  assert.notEqual(secondIndex.binding.index_digest, firstIndex.binding.index_digest);
  assert.equal(second.canonical.binding.graph_cache_key, first.canonical.binding.graph_cache_key);
  assert.notEqual(second.canonical.binding.graph_evidence_key, first.canonical.binding.graph_evidence_key);
  assert.equal(second.canonical.metrics.every((metric) => (
    metric.source.artifact_refs.includes(`python-graph:${second.canonical.binding.graph_evidence_key}`)
    && !metric.source.artifact_refs.includes(`python-graph:${second.canonical.binding.graph_cache_key}`)
  )), true);
  assert.equal(second.telemetry.graph.hits, 1);
  assert.equal(second.telemetry.graph.misses, 0);
  assert.equal(second.telemetry.graph.materializations, 0);
  assert.deepEqual(second.canonical.facts.topology, first.canonical.facts.topology);
});

test("dependency-aware graph admission rejects a stale reverse-dependent graph while retaining exact parse facts", { timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-static-invalidation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "leaf.py"), "def value():\n    return 1\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "consumer.py"), "from leaf import value\n\ndef answer():\n    return value()\n", "utf8");
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Fixture"], root);
  run("git", ["config", "user.email", "fixture@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "dependency root"], root);
  const repository = { root, revision: run("git", ["rev-parse", "HEAD"], root) };
  const cache = new MemoryCache();
  const firstIndex = await indexRepository(repository);
  const first = await analyzeStaticIntelligence({
    repositoryIndex: firstIndex,
    taskExecutor: executor(1),
    cache,
    configuration: configuration({ moduleRoots: ["src"] }),
  });
  assert.equal(first.invalidation.mode, "cold");

  fs.writeFileSync(path.join(root, "src", "leaf.py"), "def value():\n    return 2\n", "utf8");
  commitAll(repository, "change imported leaf");
  const secondIndex = await indexRepository(repository);
  const second = await analyzeStaticIntelligence({
    repositoryIndex: secondIndex,
    taskExecutor: executor(1),
    cache,
    configuration: configuration({ moduleRoots: ["src"] }),
    invalidation: {
      prior_snapshot: first.dependency_snapshot,
      ancestry_binding: INVALIDATION_PRIVATE.createTrustedAncestryBinding({
        priorRepositoryIndex: first.dependency_snapshot.repositoryIndex,
        currentRepositoryIndex: secondIndex,
        relationship: "strict-ancestor",
        evidenceDigest: digest(`git-ancestry:${firstIndex.binding.repository_revision}:${secondIndex.binding.repository_revision}`),
      }),
    },
  });
  assert.equal(second.telemetry.parse.hits, 1);
  assert.equal(second.telemetry.parse.misses, 1);
  assert.equal(second.telemetry.graph.hits, 0);
  assert.equal(second.telemetry.graph.misses, 1);
  assert.equal(second.telemetry.graph.materializations, 1);
  assert.equal(second.invalidation.mode, "recompute");
  assert.equal(second.invalidation.ancestry_relationship, "strict-ancestor");
  assert.equal(second.invalidation.affected_node_count, 2);
  assert.equal(second.invalidation.dependency_invalidated_record_count, 1);
  assert.equal(second.canonical.facts.topology.imports.edges.some((edge) => (
    edge.source === "consumer" && edge.target === "leaf"
  )), true);

  const copiedAncestry = { ...INVALIDATION_PRIVATE.createTrustedAncestryBinding({
    priorRepositoryIndex: first.dependency_snapshot.repositoryIndex,
    currentRepositoryIndex: secondIndex,
    relationship: "strict-ancestor",
    evidenceDigest: digest("copied ancestry is not trusted"),
  }) };
  const rejected = await analyzeStaticIntelligence({
    repositoryIndex: secondIndex,
    taskExecutor: executor(1),
    cache,
    configuration: configuration({ moduleRoots: ["src"] }),
    invalidation: {
      prior_snapshot: first.dependency_snapshot,
      ancestry_binding: copiedAncestry,
    },
  });
  assert.equal(rejected.invalidation.status, "full-recompute");
  assert.equal(rejected.invalidation.ancestry_relationship, null);
  assert.equal(rejected.invalidation.reusable_record_count, 0);
  assert.equal(rejected.telemetry.graph.hits, 0);
  assert.equal(rejected.telemetry.graph.materializations, 1);
});

test("re-signed parse-cache tampering cannot bypass protocol ordering and bounds", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);
  const cache = new MemoryCache();
  const cold = await analyze(repositoryIndex, cache);
  const [key, original] = cacheArtifact(cache, "python-parse-fact", (payload) => (
    payload.callables.length > 1 && payload.imports.length > 1
  ));

  const tamperCases = [
    ["noncanonical fact order", (payload) => {
      payload.callables.reverse();
      payload.imports.reverse();
    }],
    ["overlong protocol string", (payload) => {
      payload.imports[0].module = "x".repeat(1025);
    }],
    ["over-bound alias array", (payload) => {
      payload.imports[0].names = Array.from({ length: 10_001 }, () => ({ asname: null, name: "x" }));
    }],
  ];
  for (const [label, mutate] of tamperCases) {
    cache.entries.set(key, resignArtifact(original, mutate));
    const replay = await analyze(repositoryIndex, cache);
    assert.equal(replay.telemetry.parse.corrupt, 1, label);
    assert.equal(replay.telemetry.parse.hits, 6, label);
    assert.equal(replay.telemetry.parse.misses, 2, label);
    assert.equal(replay.telemetry.graph.hits, 1, label);
    assert.deepEqual(replay.canonical, cold.canonical, label);
    cache.entries.set(key, Buffer.from(original));
  }
});

test("re-signed graph-cache tampering cannot bypass nested closed materialization validation", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);
  const cache = new MemoryCache();
  const cold = await analyze(repositoryIndex, cache);
  const [key, original] = cacheArtifact(cache, "python-graph-materialization");

  const tamperCases = [
    ["nested undeclared fields", (payload) => {
      payload.materialization.modules[0].undeclared = true;
      payload.materialization.imports.undeclared = true;
    }],
    ["unsafe root", (payload) => {
      payload.materialization.roots = ["../outside"];
    }],
    ["inconsistent import projection", (payload) => {
      payload.materialization.imports.edge_occurrences[0].occurrences += 1;
    }],
  ];
  for (const [label, mutate] of tamperCases) {
    cache.entries.set(key, resignArtifact(original, mutate));
    const replay = await analyze(repositoryIndex, cache);
    assert.equal(replay.telemetry.graph.corrupt, 1, label);
    assert.equal(replay.telemetry.graph.hits, 0, label);
    assert.equal(replay.telemetry.graph.misses, 1, label);
    assert.deepEqual(replay.canonical, cold.canonical, label);
    cache.entries.set(key, Buffer.from(original));
  }
});

test("ambiguous roots and duplicate module IDs are unverifiable without path-order winners", { timeout: 180_000 }, async (t) => {
  const duplicateRepository = createRepository("ambiguous");
  const overlappingRepository = createRepository("repository");
  t.after(() => fs.rmSync(duplicateRepository.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(overlappingRepository.root, { recursive: true, force: true }));

  const duplicate = await analyze(await indexRepository(duplicateRepository), null);
  assert.equal(duplicate.canonical.facts.topology.status, "unverifiable");
  assert.match(duplicate.canonical.facts.topology.reason, /duplicate-module:pkg/);
  assert.equal(duplicate.canonical.facts.topology.partitions, null);
  assert.equal(duplicate.canonical.metrics.find((metric) => metric.metric_id === "static.python.dependency.node_count:production").measurement.status, "unverifiable");

  const overlapping = await analyze(
    await indexRepository(overlappingRepository),
    null,
    2,
    { moduleRoots: ["src", "src/acme"] },
  );
  assert.equal(overlapping.canonical.facts.topology.status, "unverifiable");
  assert.match(overlapping.canonical.facts.topology.reason, /ambiguous-or-invalid-module/);
  assert.equal(overlapping.canonical.facts.topology.modules.length, 0);
});

test("unknown generated classification and absent runtime degrade honestly", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));

  const unknown = await analyze(await indexRepository(repository, { classified: false }), null);
  assert.equal(unknown.canonical.diagnostics.coverage.excluded_unknown_generated, 8);
  assert.equal(unknown.canonical.facts.complexity.status, "unavailable");
  assert.equal(unknown.canonical.facts.topology.status, "unavailable");
  assert.equal(unknown.canonical.collectors[0].status, "unavailable");
  assert.equal(unknown.telemetry.tasks_submitted, 0);

  const missingRuntime = await analyze(
    await indexRepository(repository),
    null,
    2,
    { pythonExecutable: path.join(repository.root, "missing-python-3.13.exe") },
  );
  assert.equal(missingRuntime.canonical.facts.complexity.status, "unavailable");
  assert.equal(missingRuntime.canonical.facts.topology.status, "unavailable");
  assert.ok(missingRuntime.canonical.facts.complexity.files.every((file) => file.parse_status === "error"));
});

test("serial and two-worker execution produce byte-identical canonical evidence", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);
  const serial = await analyze(repositoryIndex, null, 1);
  const parallel = await analyze(repositoryIndex, null, 2);
  assert.ok(Buffer.from(JSON.stringify(serial.canonical)).equals(Buffer.from(JSON.stringify(parallel.canonical))));
  assert.equal(serial.telemetry.max_in_flight, 1);
  assert.ok(parallel.telemetry.max_in_flight >= 1 && parallel.telemetry.max_in_flight <= 2);
});

test("concurrent cold callers deduplicate parse and graph work per exact key", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);
  const cache = new MemoryCache();
  const [first, second] = await Promise.all([
    analyze(repositoryIndex, cache, 2),
    analyze(repositoryIndex, cache, 2),
  ]);
  assert.equal(JSON.stringify(first.canonical), JSON.stringify(second.canonical));
  assert.equal(first.telemetry.tasks_submitted + second.telemetry.tasks_submitted, 3);
  assert.equal(first.telemetry.parse.in_flight_hits + second.telemetry.parse.in_flight_hits, 8);
  assert.equal(first.telemetry.graph.in_flight_hits + second.telemetry.graph.in_flight_hits, 1);
});

test("cancellation admits no later batch and publishes no cache artifact", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);
  const cache = new MemoryCache();

  const preAborted = new AbortController();
  preAborted.abort(new Error("pre-aborted"));
  let preAbortedRuns = 0;
  const neverRun = executor(1);
  const neverRunBase = neverRun.run.bind(neverRun);
  neverRun.run = (...args) => {
    preAbortedRuns += 1;
    return neverRunBase(...args);
  };
  await assert.rejects(analyzeStaticIntelligence({
    repositoryIndex,
    taskExecutor: neverRun,
    cache,
    configuration: configuration(),
    signal: preAborted.signal,
  }), /FAIL-STATIC-INTELLIGENCE-CANCELLED/);
  assert.equal(preAbortedRuns, 0);

  const controller = new AbortController();
  const aborting = executor(1);
  const abortingBase = aborting.run.bind(aborting);
  let taskStarts = 0;
  aborting.run = (tasks, options) => abortingBase(tasks.map((task) => ({
    ...task,
    run: async (taskContext) => {
      taskStarts += 1;
      controller.abort(new Error("cancel during first admitted task"));
      return task.run(taskContext);
    },
  })), options);
  await assert.rejects(analyzeStaticIntelligence({
    repositoryIndex,
    taskExecutor: aborting,
    cache,
    configuration: configuration(),
    signal: controller.signal,
  }), /FAIL-STATIC-INTELLIGENCE-CANCELLED/);
  assert.equal(taskStarts, 1);
  assert.equal(cache.creates, 0);
});

test("a healthy AbortSignal permits immutable publication and warm reuse", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);
  const cache = new MemoryCache();
  const controller = new AbortController();

  const cold = await analyze(repositoryIndex, cache, 2, {}, controller.signal);
  assert.deepEqual(cacheTelemetry(cold), CACHE_EXPECTED.cold);
  assert.equal(cache.creates, 8);
  const warm = await analyze(repositoryIndex, cache, 2, {}, controller.signal);
  assert.deepEqual(cacheTelemetry(warm), CACHE_EXPECTED.warm);
  assert.equal(JSON.stringify(warm.canonical), JSON.stringify(cold.canonical));
});

test("valid conflicting immutable cache bytes fail closed", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  await assert.rejects(
    analyze(await indexRepository(repository), new ConflictingCache()),
    /FAIL-STATIC-INTELLIGENCE-CACHE-CONFLICT/,
  );
});

test("closed configuration, resource bounds, and stale index bindings fail closed", { timeout: 180_000 }, async (t) => {
  const repository = createRepository("repository");
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);

  await assert.rejects(analyzeStaticIntelligence({
    repositoryIndex,
    taskExecutor: executor(1),
    cache: null,
    configuration: { ...configuration(), unknown: true },
  }), /FAIL-STATIC-INTELLIGENCE-CONFIG.*unexpected field unknown/);
  await assert.rejects(analyzeStaticIntelligence({
    repositoryIndex,
    taskExecutor: executor(1),
    cache: null,
    configuration: { ...configuration(), grammarTarget: [3, 12] },
  }), /grammarTarget must be exactly/);
  await assert.rejects(analyzeStaticIntelligence({
    repositoryIndex,
    taskExecutor: executor(1),
    cache: null,
    configuration: { ...configuration(), maxBatchBytes: 513 * 1024 },
  }), /maxBatchBytes cannot exceed maxQueuedSourceBytes/);

  const tinyFileLimit = await analyze(repositoryIndex, null, 1, { maxFileBytes: 64 });
  assert.equal(tinyFileLimit.canonical.facts.complexity.aggregate.supported_file_count, 8);
  assert.ok(tinyFileLimit.canonical.facts.complexity.files.some((file) => file.error?.code === "FAIL-PYTHON-AST-FILE-LIMIT"));
  assert.ok(tinyFileLimit.canonical.facts.complexity.aggregate.parsed_file_count > 0);

  const stale = {
    binding: { ...repositoryIndex.binding },
    entries: repositoryIndex.entries,
    exclusions: repositoryIndex.exclusions,
    readBlobs: async (...args) => {
      const value = await repositoryIndex.readBlobs(...args);
      stale.binding.index_key = `sha256:${"0".repeat(64)}`;
      return value;
    },
  };
  await assert.rejects(analyzeStaticIntelligence({
    repositoryIndex: stale,
    taskExecutor: executor(1),
    cache: null,
    configuration: configuration(),
  }), /FAIL-STATIC-INTELLIGENCE-BINDING.*identity changed/);
});
