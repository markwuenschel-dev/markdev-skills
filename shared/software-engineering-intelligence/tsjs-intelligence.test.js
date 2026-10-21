"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { buildRepositoryIndex } = require("./repository-index");
const { TaskExecutor } = require("./task-executor");
const {
  TSJS_INTELLIGENCE_VERSION,
  analyzeTsjsIntelligence,
  projectTsjsEvidence,
} = require("./tsjs-intelligence");

const FIXTURES = path.join(__dirname, "fixtures", "tsjs-ast");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function parserPath() {
  const candidates = [
    process.env.SEI_TYPESCRIPT_PATH,
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor", "resources", "app", "extensions", "node_modules", "typescript", "lib", "typescript.js"),
  ].filter(Boolean);
  try { candidates.unshift(require.resolve("typescript")); } catch { /* optional runtime */ }
  return candidates.find((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate)) ?? null;
}

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

function createRepository({ generatedPolicy = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-tsjs-intelligence-"));
  write(root, "src/core.ts", fixture("complexity.ts"));
  write(root, "src/component.tsx", fixture("component.tsx"));
  write(root, "src/commonjs.js", fixture("commonjs.js"));
  write(root, "src/helper.js", "export function helper(value) { return value; }\n");
  write(root, "src/types.js", "export const Shape = Object;\n");
  write(root, "src/shared.js", "export { decide } from \"./core.ts\";\nexport const shared = 1;\n");
  write(root, "src/all.js", "export const all = 1;\n");
  write(root, "src/lazy.js", "export const lazy = 1;\n");
  write(root, "src/broken.ts", fixture("malformed.ts"));
  write(root, "tests/core.test.ts", "import test from \"node:test\";\nimport { decide } from \"../src/core.ts\";\ntest(\"decision\", () => { if (decide(1) > 0) return; });\n");
  write(root, "generated/client.ts", "export function generated() { if (true) return 1; return 0; }\n");
  write(root, "vendor/library.js", "export function vendored() { if (true) return 1; return 0; }\n");
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Fixture"], root);
  run("git", ["config", "user.email", "fixture@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "fixture"], root);
  return {
    generatedPatterns: generatedPolicy ? ["generated/**"] : undefined,
    revision: run("git", ["rev-parse", "HEAD"], root),
    root,
  };
}

async function index(repository) {
  return buildRepositoryIndex({
    repository_root: repository.root,
    repository_revision: repository.revision,
    ...(repository.generatedPatterns === undefined ? {} : { generated_path_patterns: repository.generatedPatterns }),
  });
}

function executor(workers) {
  return new TaskExecutor({
    maxWorkers: workers,
    resourceLimits: { external_process: workers },
    groupLimits: { "tsjs-ast": workers },
    maxMemoryWeight: 16,
  });
}

function configuration(typescriptPath = parserPath()) {
  return {
    nodeExecutable: process.execPath,
    typescriptPath,
    maxQueuedSourceBytes: 16 * 1024 * 1024,
    limits: {
      maxFileBytes: 2 * 1024 * 1024,
      maxBatchFiles: 4,
      maxBatchBytes: 4 * 1024 * 1024,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
      batchTimeoutMs: 30_000,
    },
  };
}

function metricMap(result) {
  return new Map(result.canonical.metrics.map((metric) => [metric.metric_id, metric]));
}

test("normalized TS/JS intelligence emits structural distributions and dependency topology", { skip: parserPath() === null, timeout: 120_000 }, async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await index(repository);
  const result = await analyzeTsjsIntelligence({
    repositoryIndex,
    taskExecutor: executor(2),
    configuration: configuration(),
  });

  assert.equal(TSJS_INTELLIGENCE_VERSION, "sei.tsjs-static-intelligence@1");
  assert.equal(result.canonical.version, TSJS_INTELLIGENCE_VERSION);
  assert.equal(result.canonical.collectors[0].status, "degraded");
  assert.deepEqual(result.canonical.diagnostics.coverage, {
    excluded_generated: 1,
    excluded_unknown_generated: 0,
    excluded_vendor: 1,
    indexed_supported_source: 12,
    parsed_files: 9,
    selected_human_nonvendor: 10,
    unavailable_files: 1,
  });
  assert.equal(result.canonical.facts.complexity.files.find((file) => file.path === "src/broken.ts").parse_status, "unavailable");
  assert.equal(result.canonical.facts.complexity.files.some((file) => file.path.startsWith("generated/")), false);
  assert.equal(result.canonical.facts.complexity.files.some((file) => file.path.startsWith("vendor/")), false);

  const metrics = metricMap(result);
  for (const [id, value] of [
    ["static.tsjs.cyclomatic_callable_count:production", 8],
    ["static.tsjs.cyclomatic_complexity:production", 24],
    ["static.tsjs.cyclomatic_complexity_p50:production", 2],
    ["static.tsjs.cyclomatic_complexity_p90:production", 8],
    ["static.tsjs.cognitive_complexity:production", 22],
    ["static.tsjs.cognitive_complexity_p50:production", 1],
    ["static.tsjs.cognitive_complexity_p90:production", 11],
    ["static.tsjs.cyclomatic_callable_count:all-tsjs", 9],
    ["static.tsjs.cyclomatic_complexity:all-tsjs", 26],
    ["static.tsjs.cognitive_complexity:all-tsjs", 23],
    ["static.tsjs.dependency.node_count:production", 9],
    ["static.tsjs.dependency.edge_count:production", 7],
    ["static.tsjs.dependency.cyclic_scc_count:production", 1],
    ["static.tsjs.dependency.cyclic_node_count:production", 2],
    ["static.tsjs.dependency.node_count:all-tsjs", 10],
    ["static.tsjs.dependency.edge_count:all-tsjs", 8],
    ["static.tsjs.dependency.import_count:all-tsjs:internal", 8],
    ["static.tsjs.dependency.import_count:all-tsjs:external", 2],
    ["static.tsjs.dependency.import_count:all-tsjs:unresolved-relative", 1],
    ["static.tsjs.dependency.import_count:all-tsjs:dynamic", 2],
  ]) assert.equal(metrics.get(id)?.value, value, id);

  const callable = metrics.get("static.tsjs.cyclomatic_callable:src/core.ts:10:0:19:1:decide");
  assert.equal(callable.value, 8);
  assert.equal(callable.subject, "tsjs-callable:src/core.ts#decide@10:0-19:1");
  assert.ok(callable.source.artifact_refs.includes("tsjs-syntax:typescript"));
  assert.ok(callable.source.artifact_refs.some((ref) => /^tsjs-typescript:\d+\.\d+\.\d+/.test(ref)));
  assert.ok(callable.source.artifact_refs.some((ref) => /^tsjs-typescript-bytes:sha256:[0-9a-f]{64}$/.test(ref)));
  const cognitive = metrics.get("static.tsjs.cognitive_callable:src/core.ts:10:0:19:1:decide");
  assert.equal(cognitive.value, 11);

  const cycle = result.canonical.metrics.find((metric) => metric.metric_id.startsWith("static.tsjs.dependency.cyclic_scc_size:production:"));
  assert.equal(cycle.value, 2);
  assert.deepEqual(cycle.source.artifact_refs.filter((ref) => ref.startsWith("tsjs-scc-member:")), [
    "tsjs-scc-member:src/core.ts",
    "tsjs-scc-member:src/shared.js",
  ]);
  assert.equal(result.canonical.facts.topology.references.some((fact) => fact.classification === "dynamic" && fact.target === null), true);
  assert.equal(result.canonical.facts.topology.references.some((fact) => fact.classification === "unresolved-relative" && fact.module === "./legacy.cjs"), true);
});

test("serial and parallel execution produce byte-identical canonical evidence", { skip: parserPath() === null, timeout: 120_000 }, async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await index(repository);
  const serial = await analyzeTsjsIntelligence({ repositoryIndex, taskExecutor: executor(1), configuration: configuration() });
  const parallel = await analyzeTsjsIntelligence({ repositoryIndex, taskExecutor: executor(2), configuration: configuration() });
  assert.equal(JSON.stringify(serial.canonical), JSON.stringify(parallel.canonical));
  assert.equal(serial.telemetry.max_in_flight, 1);
  assert.ok(parallel.telemetry.max_in_flight >= 1 && parallel.telemetry.max_in_flight <= 2);
});

test("relative dependency resolution follows compiler file-before-directory precedence", { skip: parserPath() === null, timeout: 120_000 }, async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  write(repository.root, "src/foo.ts", "export const source = 'file';\n");
  write(repository.root, "src/foo/index.ts", "export const source = 'directory';\n");
  write(repository.root, "src/resolution.ts", "import { source } from './foo';\nexport { source };\n");
  run("git", ["add", "--all"], repository.root);
  run("git", ["commit", "--quiet", "-m", "resolution precedence"], repository.root);
  repository.revision = run("git", ["rev-parse", "HEAD"], repository.root);

  const result = await analyzeTsjsIntelligence({
    repositoryIndex: await index(repository),
    taskExecutor: executor(1),
    configuration: configuration(),
  });
  const reference = result.canonical.facts.topology.references.find((item) => (
    item.path === "src/resolution.ts" && item.module === "./foo"
  ));
  assert.equal(reference.classification, "internal");
  assert.equal(reference.target, "src/foo.ts");
});

test("TS/JS intelligence projects collector-bound metrics without mutating canonical evidence", { skip: parserPath() === null, timeout: 120_000 }, async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const result = await analyzeTsjsIntelligence({ repositoryIndex: await index(repository), taskExecutor: executor(2), configuration: configuration() });
  const before = JSON.stringify(result.canonical);
  const projected = projectTsjsEvidence({
    result,
    configuration_hash: "b".repeat(64),
    history_window: { kind: "revision", start: null, end: result.canonical.binding.repository_revision },
  });
  assert.equal(projected.collectors[0].collector_id, "tsjs-static-intelligence");
  assert.ok(projected.metrics.length > 20);
  assert.ok(projected.metrics.every((metric) => metric.comparability.configuration_hash === "b".repeat(64)));
  assert.ok(projected.metrics.every((metric) => metric.window.end === result.canonical.binding.repository_revision));
  assert.equal(JSON.stringify(result.canonical), before);
  assert.equal(Object.isFrozen(projected), true);
});

test("missing parser and unknown generated classification remain unavailable rather than lexical", { timeout: 120_000 }, async (t) => {
  const repository = createRepository();
  const unknownRepository = createRepository({ generatedPolicy: false });
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(unknownRepository.root, { recursive: true, force: true }));

  const missing = await analyzeTsjsIntelligence({
    repositoryIndex: await index(repository),
    taskExecutor: executor(1),
    configuration: configuration(path.join(repository.root, "missing-typescript.js")),
  });
  assert.equal(missing.canonical.collectors[0].status, "unavailable");
  assert.ok(missing.canonical.facts.complexity.files.every((file) => file.parse_status === "unavailable"));
  assert.ok(missing.canonical.metrics.filter((metric) => metric.family === "structural_complexity").every((metric) => metric.value === null));

  const unknown = await analyzeTsjsIntelligence({
    repositoryIndex: await index(unknownRepository),
    taskExecutor: executor(1),
    configuration: configuration(parserPath()),
  });
  assert.equal(unknown.canonical.collectors[0].status, "unavailable");
  assert.equal(unknown.canonical.diagnostics.coverage.selected_human_nonvendor, 0);
  assert.equal(unknown.canonical.diagnostics.coverage.excluded_unknown_generated, 11);
  assert.equal(unknown.telemetry.tasks_submitted, 0);
});

test("closed input/configuration and cancellation fail before analyzer admission", { skip: parserPath() === null, timeout: 120_000 }, async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await index(repository);
  await assert.rejects(analyzeTsjsIntelligence({
    repositoryIndex,
    taskExecutor: executor(1),
    configuration: { ...configuration(), weights: { cyclomatic: 1 } },
  }), /FAIL-TSJS-INTELLIGENCE-CONFIG.*unexpected field weights/);

  const controller = new AbortController();
  controller.abort(new Error("stop"));
  let calls = 0;
  const taskExecutor = executor(1);
  const original = taskExecutor.run.bind(taskExecutor);
  taskExecutor.run = (...args) => {
    calls += 1;
    return original(...args);
  };
  await assert.rejects(analyzeTsjsIntelligence({
    repositoryIndex,
    taskExecutor,
    configuration: configuration(),
    signal: controller.signal,
  }), /FAIL-TSJS-INTELLIGENCE-CANCELLED/);
  assert.equal(calls, 0);
});
