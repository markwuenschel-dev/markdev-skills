"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  JVM_STATIC_INTELLIGENCE_VERSION,
  JAVA_CYCLOMATIC_DEFINITION_ID,
  KOTLIN_UNAVAILABLE_REASON,
  analyzeJvmStaticIntelligence,
  projectJvmEvidence,
} = require("./jvm-static-intelligence.js");
const { TaskExecutor } = require("./task-executor.js");

const fixtureRoot = path.join(__dirname, "fixtures", "jvm-static");

function java25() {
  const configured = process.env.SEI_JAVA_25;
  let launcher = configured;
  if (!launcher) {
    const lookup = process.platform === "win32"
      ? spawnSync("where.exe", ["java"], { encoding: "utf8", windowsHide: true })
      : spawnSync("sh", ["-c", "command -v java"], { encoding: "utf8" });
    assert.equal(lookup.status, 0, lookup.stderr);
    launcher = lookup.stdout.split(/\r?\n/).find(Boolean);
  }
  const settings = spawnSync(launcher, ["-XshowSettings:properties", "-version"], { encoding: "utf8", windowsHide: true });
  assert.equal(settings.status, 0, settings.stderr);
  const javaHome = /^\s*java\.home\s*=\s*(.+)$/m.exec(`${settings.stdout}${settings.stderr}`)?.[1].trim();
  assert.ok(javaHome);
  const executable = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  assert.equal(fs.existsSync(executable), true);
  return executable;
}

function gitBlobOid(bytes, algorithm = "sha1") {
  return crypto.createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`, "utf8")).update(bytes).digest("hex");
}

function entry(filePath, language, bytes, overrides = {}) {
  const blobOid = overrides.blob_oid ?? gitBlobOid(bytes);
  return {
    path: filePath,
    mode: "100644",
    blob_oid: blobOid,
    byte_size: overrides.byte_size ?? bytes.length,
    content_key: `git-blob:sha1:${blobOid}`,
    entry_key: `sha256:${crypto.createHash("sha256").update(filePath).digest("hex")}`,
    language,
    classifications: {
      source: true,
      test_source: overrides.test_source ?? false,
      generated: overrides.generated ?? "human",
      vendor: overrides.vendor ?? "not-vendor",
      manifest_kinds: [],
      artifact_candidate_kinds: [],
    },
    bytes,
  };
}

function binding() {
  return {
    repository_revision: "1".repeat(40),
    root_tree_oid: "2".repeat(40),
    object_format: "sha1",
    index_digest: `sha256:${"3".repeat(64)}`,
    classification_policy_version: "sei.repository-classification@2",
    classification_policy_hash: `sha256:${"4".repeat(64)}`,
    index_key: `sha256:${"5".repeat(64)}`,
  };
}

function syntheticIndex(sourceEntries, options = {}) {
  const reads = [];
  const index = {
    binding: binding(),
    entries: [...sourceEntries],
    exclusions: [],
    async readBlobs(requested, readOptions) {
      reads.push({ paths: requested.map((item) => item.path), options: readOptions });
      if (options.beforeReadReturn) options.beforeReadReturn(index, requested);
      return new Map(requested.map((item) => [item.path, Buffer.from(item.bytes)]));
    },
  };
  return { index, reads };
}

function executor(workers = 2) {
  return new TaskExecutor({
    maxWorkers: workers,
    resourceLimits: { external_process: workers },
    groupLimits: { "java-ast": workers },
    maxMemoryWeight: 16,
    hostCapacity: {
      parallelism: Math.max(2, workers),
      totalMemoryBytes: 16 * 1024 ** 3,
      freeMemoryBytes: 8 * 1024 ** 3,
    },
  });
}

function configuration(overrides = {}) {
  return {
    javaExecutable: java25(),
    grammarTarget: 25,
    limits: {},
    ...overrides,
  };
}

test("JVM boundary publishes deterministic revision-bound Java facts and honest Kotlin unavailability", { timeout: 60_000 }, async () => {
  const javaBytes = fs.readFileSync(path.join(fixtureRoot, "java", "ComplexityFixture.java"));
  const kotlinBytes = fs.readFileSync(path.join(fixtureRoot, "kotlin", "Unsupported.kt"));
  const javaEntry = entry("src/main/java/example/jvm/ComplexityFixture.java", "java", javaBytes);
  const kotlinEntry = entry("src/main/kotlin/example/jvm/Unsupported.kt", "kotlin", kotlinBytes);
  const fixture = syntheticIndex([kotlinEntry, javaEntry]);
  const input = {
    repositoryIndex: fixture.index,
    taskExecutor: executor(),
    configuration: configuration(),
  };
  const first = await analyzeJvmStaticIntelligence(input);
  const second = await analyzeJvmStaticIntelligence(input);

  assert.equal(JVM_STATIC_INTELLIGENCE_VERSION, "sei.jvm-static-intelligence@1");
  assert.equal(JAVA_CYCLOMATIC_DEFINITION_ID, "sei.static.java.cyclomatic_callable@1");
  assert.equal(first.canonical.schema_version, JVM_STATIC_INTELLIGENCE_VERSION);
  assert.equal(first.canonical.binding.repository_revision, fixture.index.binding.repository_revision);
  assert.equal(first.canonical.binding.index_digest, fixture.index.binding.index_digest);
  assert.equal(first.canonical.languages.java.status, "available");
  assert.equal(first.canonical.languages.java.runtime.grammar_target, 25);
  assert.match(first.canonical.languages.java.runtime.java_executable_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.canonical.languages.kotlin.status, "unavailable");
  assert.equal(first.canonical.languages.kotlin.reason, KOTLIN_UNAVAILABLE_REASON);
  assert.deepEqual(first.canonical.files.map((fact) => [fact.path, fact.language, fact.status]), [
    [javaEntry.path, "java", "ok"],
    [kotlinEntry.path, "kotlin", "unavailable"],
  ]);
  const javaFact = first.canonical.files[0];
  assert.equal(javaFact.package_name, "example.jvm");
  assert.equal(javaFact.callables.find((fact) => fact.qualified_name.endsWith(".score(List<String>)")).complexity, 9);
  assert.deepEqual(javaFact.imports.map((fact) => fact.qualified_name), [
    "java.util.List", "java.util.Collections.emptyList",
  ]);
  assert.deepEqual(fixture.reads.flatMap((read) => read.paths), [javaEntry.path, javaEntry.path]);
  assert.deepEqual(first.canonical, second.canonical);
  assert.equal(first.canonical_digest, second.canonical_digest);
  assert.match(first.canonical_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.canonical.files[0].callables), true);
  assert.throws(() => { first.canonical.files[0].status = "forged"; }, TypeError);
  assert.equal(Object.hasOwn(first.canonical, "telemetry"), false);
});

test("JVM projection publishes true Java callable and file complexity with honest Kotlin and cognitive gaps", { timeout: 60_000 }, async () => {
  const javaBytes = fs.readFileSync(path.join(fixtureRoot, "java", "ComplexityFixture.java"));
  const fixture = syntheticIndex([entry("src/ComplexityFixture.java", "java", javaBytes)]);
  const analyzed = await analyzeJvmStaticIntelligence({ repositoryIndex: fixture.index, taskExecutor: executor(), configuration: configuration() });
  const projected = projectJvmEvidence({
    result: analyzed,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: fixture.index.binding.repository_revision },
  });
  assert.deepEqual(projected.collectors.map((collector) => [collector.collector_id, collector.status]), [
    ["java-static-intelligence", "available"],
    ["kotlin-static-intelligence", "unavailable"],
  ]);
  assert.equal(projected.metrics.find((metric) => metric.metric_id === "static.java.cyclomatic_callable_count").value, 8);
  assert.equal(projected.metrics.find((metric) => metric.metric_id === "static.java.cyclomatic_complexity").value, 20);
  assert.equal(projected.metrics.find((metric) => metric.metric_id === "static.java.cyclomatic_complexity:src/ComplexityFixture.java").value, 20);
  assert.equal(projected.metrics.find((metric) => metric.metric_id.includes("score(List<String>)")).value, 9);
  assert.equal(projected.metrics.find((metric) => metric.metric_id === "static.java.cognitive_complexity").measurement.status, "unavailable");
  assert.equal(projected.metrics.find((metric) => metric.metric_id === "static.kotlin.cyclomatic_complexity").measurement.status, "unavailable");
  assert.equal(Object.isFrozen(projected), true);
});

test("bounded batching deduplicates Git blobs and preserves canonical parity across serial and parallel execution", { timeout: 90_000 }, async () => {
  const firstBytes = Buffer.from("package batch; class A { int a() { if (true) return 1; return 0; } }\n");
  const secondBytes = Buffer.from("package batch; import java.util.List; class B { int b(List<?> x) { return x.isEmpty() ? 0 : 1; } }\n");
  const entries = [
    entry("src/A.java", "java", firstBytes),
    entry("src/Alias.java", "java", firstBytes),
    entry("src/B.java", "java", secondBytes, { test_source: true }),
  ];
  const serialFixture = syntheticIndex(entries);
  const parallelFixture = syntheticIndex([...entries].reverse());
  const limits = {
    maxBatchFiles: 1,
    maxBatchBytes: 1024,
    maxFileBytes: 1024,
    maxQueuedSourceBytes: 2048,
  };
  const serial = await analyzeJvmStaticIntelligence({
    repositoryIndex: serialFixture.index,
    taskExecutor: executor(1),
    configuration: configuration({ limits }),
  });
  const parallel = await analyzeJvmStaticIntelligence({
    repositoryIndex: parallelFixture.index,
    taskExecutor: executor(2),
    configuration: configuration({ limits }),
  });
  assert.deepEqual(serial.canonical, parallel.canonical);
  assert.equal(serial.canonical_digest, parallel.canonical_digest);
  assert.equal(serial.telemetry.unique_java_blobs, 2);
  assert.equal(serial.telemetry.batch_count, 2);
  assert.equal(serial.telemetry.executor_runs, 1);
  assert.equal(serial.telemetry.tasks_submitted, 2);
  assert.equal(serial.telemetry.max_wave_source_bytes <= limits.maxQueuedSourceBytes, true);
  assert.deepEqual(serialFixture.reads.map((read) => read.paths), [["src/A.java"], ["src/B.java"]]);
  assert.deepEqual(serial.canonical.files.map((fact) => fact.path), ["src/A.java", "src/Alias.java", "src/B.java"]);
  assert.equal(serial.canonical.files[0].callables[0].complexity, 2);
  assert.equal(serial.canonical.files[1].callables[0].complexity, 2);
  assert.equal(serial.canonical.files[2].callables[0].complexity, 2);
});

test("missing Java runtime and absent Kotlin parser fail closed without reading source blobs", async () => {
  const javaEntry = entry("src/Unavailable.java", "java", Buffer.from("class Unavailable {}\n"));
  const kotlinEntry = entry("src/Unavailable.kt", "kotlin", Buffer.from("class Unavailable\n"));
  const fixture = syntheticIndex([javaEntry, kotlinEntry]);
  const result = await analyzeJvmStaticIntelligence({
    repositoryIndex: fixture.index,
    taskExecutor: executor(),
    configuration: {
      javaExecutable: path.join(path.parse(process.execPath).root, "definitely-missing", "java.exe"),
      grammarTarget: 25,
    },
  });
  assert.equal(result.canonical.languages.java.status, "unavailable");
  assert.match(result.canonical.languages.java.reason, /^FAIL-JVM-JAVA-RUNTIME-UNAVAILABLE:/);
  assert.equal(result.canonical.languages.java.runtime, null);
  assert.equal(result.canonical.languages.kotlin.status, "unavailable");
  assert.deepEqual(result.canonical.files.map((fact) => fact.status), ["unavailable", "unavailable"]);
  assert.deepEqual(fixture.reads, []);
  assert.equal(result.telemetry.runtime_probe_attempts, 1);
  assert.equal(result.telemetry.batch_protocol_attempts, 0);
});

test("malformed, oversized, generated, vendor, and unknown-generated inputs retain distinct closed outcomes", { timeout: 60_000 }, async () => {
  const malformed = fs.readFileSync(path.join(fixtureRoot, "java", "Malformed.java"));
  const oversizedBytes = Buffer.from("class Oversized {}\n".repeat(100));
  const malformedEntry = entry("src/Malformed.java", "java", malformed);
  const oversizedEntry = entry("src/Oversized.java", "java", oversizedBytes);
  const generated = entry("generated/Generated.java", "java", Buffer.from("class Generated {}\n"), { generated: "generated" });
  const vendor = entry("vendor/Vendor.kt", "kotlin", Buffer.from("class Vendor\n"), { vendor: "vendor" });
  const unknown = entry("src/Unknown.kt", "kotlin", Buffer.from("class Unknown\n"), { generated: "unknown" });
  const fixture = syntheticIndex([unknown, oversizedEntry, vendor, malformedEntry, generated]);
  const result = await analyzeJvmStaticIntelligence({
    repositoryIndex: fixture.index,
    taskExecutor: executor(),
    configuration: configuration({ limits: { maxFileBytes: 512, maxBatchBytes: 1024, maxQueuedSourceBytes: 1024 } }),
  });
  assert.equal(result.canonical.languages.java.status, "degraded");
  assert.deepEqual(result.canonical.files.map((fact) => [fact.path, fact.error?.code]), [
    ["src/Malformed.java", "FAIL-JAVA-AST-PARSE"],
    ["src/Oversized.java", "FAIL-JVM-JAVA-FILE-LIMIT"],
  ]);
  assert.deepEqual(fixture.reads.map((read) => read.paths), [[malformedEntry.path]]);
  assert.deepEqual(result.canonical.coverage.java, {
    excluded_generated: 1,
    excluded_unknown_generated: 0,
    excluded_vendor: 0,
    indexed_source: 3,
    selected_human: 2,
  });
  assert.deepEqual(result.canonical.coverage.kotlin, {
    excluded_generated: 0,
    excluded_unknown_generated: 1,
    excluded_vendor: 1,
    indexed_source: 2,
    selected_human: 0,
  });
  assert.equal(JSON.stringify(result).includes("Generated.java"), false);
  assert.equal(JSON.stringify(result).includes("Vendor.kt"), false);
  assert.equal(JSON.stringify(result).includes("Unknown.kt"), false);
});

test("blob or index identity drift is fatal rather than downgraded to a measurement error", { timeout: 30_000 }, async () => {
  const bytes = Buffer.from("class Bound {}\n");
  const boundEntry = entry("src/Bound.java", "java", bytes);
  const wrongBlobFixture = syntheticIndex([{ ...boundEntry, bytes: Buffer.from("class Forged {}\n") }]);
  await assert.rejects(analyzeJvmStaticIntelligence({
    repositoryIndex: wrongBlobFixture.index,
    taskExecutor: executor(),
    configuration: configuration(),
  }), /FAIL-JVM-STATIC-BINDING/);

  const driftFixture = syntheticIndex([boundEntry], {
    beforeReadReturn(index) { index.binding.index_digest = `sha256:${"f".repeat(64)}`; },
  });
  await assert.rejects(analyzeJvmStaticIntelligence({
    repositoryIndex: driftFixture.index,
    taskExecutor: executor(),
    configuration: configuration(),
  }), /FAIL-JVM-STATIC-BINDING/);
});

test("configuration is closed and cancellation is never mislabeled as runtime unavailability", async () => {
  const fixture = syntheticIndex([entry("src/A.java", "java", Buffer.from("class A {}\n"))]);
  await assert.rejects(analyzeJvmStaticIntelligence({
    repositoryIndex: fixture.index,
    taskExecutor: executor(),
    configuration: { ...configuration(), kotlinExecutable: "kotlinc" },
  }), /FAIL-JVM-STATIC-CONFIG.*unexpected field kotlinExecutable/);
  await assert.rejects(analyzeJvmStaticIntelligence({
    repositoryIndex: fixture.index,
    taskExecutor: executor(),
    configuration: configuration({ grammarTarget: 21 }),
  }), /FAIL-JVM-STATIC-CONFIG.*exactly 25/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(analyzeJvmStaticIntelligence({
    repositoryIndex: fixture.index,
    taskExecutor: executor(),
    configuration: configuration(),
    signal: controller.signal,
  }), /FAIL-JVM-STATIC-CANCELLED/);
  assert.deepEqual(fixture.reads, []);
});

test("an all-Kotlin repository needs no Java runtime probe and remains explicitly unverifiable", async () => {
  const kotlinEntry = entry("src/Only.kt", "kotlin", Buffer.from("class Only\n"));
  const fixture = syntheticIndex([kotlinEntry]);
  const result = await analyzeJvmStaticIntelligence({
    repositoryIndex: fixture.index,
    taskExecutor: executor(),
    configuration: {
      javaExecutable: path.join(path.parse(process.execPath).root, "unused-missing", "java.exe"),
      grammarTarget: 25,
    },
  });
  assert.equal(result.canonical.languages.java.status, "not_present");
  assert.equal(result.canonical.languages.java.reason, null);
  assert.equal(result.canonical.languages.kotlin.status, "unavailable");
  assert.equal(result.canonical.files[0].reason, KOTLIN_UNAVAILABLE_REASON);
  assert.equal(result.telemetry.runtime_probe_attempts, 0);
  assert.deepEqual(fixture.reads, []);
});
