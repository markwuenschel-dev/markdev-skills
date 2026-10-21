"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  JAVA_AST_ANALYZER_VERSION,
  JAVA_AST_PROTOCOL_VERSION,
  PARSER_RUNTIME,
  GRAMMAR_TARGET,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  probeJavaAstRuntime,
  analyzeJavaAstBatch,
} = require("./analyzers/java-ast-protocol.js");

const JVM_STATIC_INTELLIGENCE_VERSION = "sei.jvm-static-intelligence@1";
const JAVA_CYCLOMATIC_DEFINITION_ID = "sei.static.java.cyclomatic_callable@1";
const JAVA_CALLABLE_SPAN_DEFINITION_ID = "sei.static.java.callable_span@1";
const JAVA_IMPORT_DEFINITION_ID = "sei.static.java.import_declaration@1";
const KOTLIN_UNAVAILABLE_REASON = "FAIL-JVM-KOTLIN-PARSER-UNAVAILABLE: no verified Kotlin compiler AST runtime is bundled or configured";
const JAVA_RUNTIME_UNAVAILABLE_REASON = "FAIL-JVM-JAVA-RUNTIME-UNAVAILABLE: JDK compiler AST capability 25 or newer could not be verified";
const JAVA_PARTIAL_REASON = "FAIL-JVM-JAVA-PARTIAL: one or more selected Java sources could not be verified";
const SOURCE_MODES = new Set(["100644", "100755"]);
const INPUT_KEYS = Object.freeze(["configuration", "repositoryIndex", "signal", "taskExecutor"]);
const CONFIGURATION_KEYS = Object.freeze(["grammarTarget", "javaExecutable", "limits"]);
const LIMIT_KEYS = Object.freeze([...Object.keys(DEFAULT_LIMITS), "maxQueuedSourceBytes"]);
const DEFAULT_MAX_QUEUED_SOURCE_BYTES = 16 * 1024 * 1024;
const HARD_MAX_QUEUED_SOURCE_BYTES = 64 * 1024 * 1024;
const HARD_MAX_JAVA_EXECUTABLE_BYTES = 64 * 1024 * 1024;

function errorWithCode(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function fail(code, detail) {
  throw errorWithCode(code, detail);
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedRecord(value, keys, label, code = "FAIL-JVM-STATIC-CONFIG", exact = false) {
  if (!isRecord(value)) fail(code, `${label} must be a closed record`);
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  const unexpected = actual.filter((key) => !allowed.has(key)).sort(stableCompare);
  if (unexpected.length > 0) fail(code, `${label} contains unexpected field ${unexpected[0]}`);
  if (exact) {
    const missing = [...allowed].filter((key) => !Object.hasOwn(value, key)).sort(stableCompare);
    if (missing.length > 0) fail(code, `${label} is missing field ${missing[0]}`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(stableCompare).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function executableSha256(executable) {
  try {
    const stats = fs.statSync(executable);
    if (!stats.isFile()) return null;
    if (stats.size > HARD_MAX_JAVA_EXECUTABLE_BYTES) {
      fail("FAIL-JVM-STATIC-CONFIG", `configuration.javaExecutable exceeds ${HARD_MAX_JAVA_EXECUTABLE_BYTES} bytes`);
    }
    return sha256(fs.readFileSync(executable));
  } catch {
    return null;
  }
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function checkCancelled(signal) {
  if (signal?.aborted) fail("FAIL-JVM-STATIC-CANCELLED", "operation was cancelled");
}

function normalizeLimits(value) {
  assertClosedRecord(value, LIMIT_KEYS, "configuration.limits");
  const limits = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const candidate = value[key] ?? DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > HARD_LIMITS[key]) {
      fail("FAIL-JVM-STATIC-CONFIG", `configuration.limits.${key} must be a positive safe integer no greater than ${HARD_LIMITS[key]}`);
    }
    limits[key] = candidate;
  }
  const maxQueuedSourceBytes = value.maxQueuedSourceBytes ?? DEFAULT_MAX_QUEUED_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxQueuedSourceBytes) || maxQueuedSourceBytes <= 0
      || maxQueuedSourceBytes > HARD_MAX_QUEUED_SOURCE_BYTES) {
    fail("FAIL-JVM-STATIC-CONFIG", `configuration.limits.maxQueuedSourceBytes must be 1..${HARD_MAX_QUEUED_SOURCE_BYTES}`);
  }
  if (limits.maxFileBytes > limits.maxBatchBytes) {
    fail("FAIL-JVM-STATIC-CONFIG", "configuration.limits.maxFileBytes cannot exceed maxBatchBytes");
  }
  if (maxQueuedSourceBytes < limits.maxBatchBytes) {
    fail("FAIL-JVM-STATIC-CONFIG", "configuration.limits.maxQueuedSourceBytes cannot be smaller than maxBatchBytes");
  }
  return Object.freeze({ ...limits, maxQueuedSourceBytes });
}

function normalizeConfiguration(value) {
  assertClosedRecord(value, CONFIGURATION_KEYS, "configuration", "FAIL-JVM-STATIC-CONFIG");
  if (typeof value.javaExecutable !== "string" || value.javaExecutable.includes("\0") || !path.isAbsolute(value.javaExecutable)) {
    fail("FAIL-JVM-STATIC-CONFIG", "configuration.javaExecutable must be an explicit absolute NUL-free path");
  }
  if (value.grammarTarget !== GRAMMAR_TARGET) {
    fail("FAIL-JVM-STATIC-CONFIG", `configuration.grammarTarget must be exactly ${GRAMMAR_TARGET}`);
  }
  return Object.freeze({
    javaExecutable: value.javaExecutable,
    grammarTarget: value.grammarTarget,
    limits: normalizeLimits(value.limits ?? {}),
  });
}

function validateRepositoryIndex(index) {
  if (!index || typeof index !== "object" || !Array.isArray(index.entries) || typeof index.readBlobs !== "function") {
    fail("FAIL-JVM-STATIC-BINDING", "repositoryIndex must expose entries and readBlobs");
  }
  const binding = index.binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("FAIL-JVM-STATIC-BINDING", "repositoryIndex.binding is required");
  }
  const required = [
    "classification_policy_hash", "classification_policy_version", "index_digest", "index_key",
    "object_format", "repository_revision", "root_tree_oid",
  ];
  for (const key of required) {
    if (typeof binding[key] !== "string" || binding[key].length === 0) {
      fail("FAIL-JVM-STATIC-BINDING", `repositoryIndex.binding.${key} is required`);
    }
  }
  if (!["sha1", "sha256"].includes(binding.object_format)) fail("FAIL-JVM-STATIC-BINDING", "repositoryIndex object format is unsupported");
  const oidLength = binding.object_format === "sha1" ? 40 : 64;
  const oidPattern = new RegExp(`^[0-9a-f]{${oidLength}}$`);
  if (!oidPattern.test(binding.repository_revision) || !oidPattern.test(binding.root_tree_oid)
      || !/^sha256:[0-9a-f]{64}$/.test(binding.index_digest)
      || !/^sha256:[0-9a-f]{64}$/.test(binding.classification_policy_hash)
      || !/^sha256:[0-9a-f]{64}$/.test(binding.index_key)) {
    fail("FAIL-JVM-STATIC-BINDING", "repositoryIndex binding identities are invalid");
  }
}

function validateTaskExecutor(taskExecutor) {
  if (!taskExecutor || typeof taskExecutor !== "object" || typeof taskExecutor.run !== "function") {
    fail("FAIL-JVM-STATIC-CONFIG", "taskExecutor must expose TaskExecutor.run(tasks,{signal})");
  }
}

function bindingToken(index) {
  return canonicalJson({
    classification_policy_hash: index.binding.classification_policy_hash,
    classification_policy_version: index.binding.classification_policy_version,
    index_digest: index.binding.index_digest,
    index_key: index.binding.index_key,
    object_format: index.binding.object_format,
    repository_revision: index.binding.repository_revision,
    root_tree_oid: index.binding.root_tree_oid,
  });
}

function assertLive(index, token, signal) {
  checkCancelled(signal);
  if (bindingToken(index) !== token) {
    fail("FAIL-JVM-STATIC-BINDING", "RepositoryIndex identity changed during JVM analysis");
  }
}

function emptyCoverage() {
  return {
    indexed_source: 0,
    selected_human: 0,
    excluded_generated: 0,
    excluded_vendor: 0,
    excluded_unknown_generated: 0,
  };
}

function validateIndexEntry(entry, objectFormat) {
  if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || entry.path.length === 0
      || entry.path.includes("\0") || entry.path.includes("\\") || entry.path.startsWith("/") || /^[A-Za-z]:/.test(entry.path)
      || !SOURCE_MODES.has(entry.mode) || !Number.isSafeInteger(entry.byte_size) || entry.byte_size < 0
      || typeof entry.blob_oid !== "string" || typeof entry.content_key !== "string" || !entry.classifications) {
    fail("FAIL-JVM-STATIC-BINDING", "repositoryIndex contains an invalid JVM source entry");
  }
  const segments = entry.path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("FAIL-JVM-STATIC-BINDING", "repositoryIndex contains an unsafe JVM source path");
  }
  const algorithm = entry.blob_oid.length === 40 ? "sha1" : entry.blob_oid.length === 64 ? "sha256" : null;
  if (algorithm === null || algorithm !== objectFormat || !new RegExp(`^[0-9a-f]{${entry.blob_oid.length}}$`).test(entry.blob_oid)
      || entry.content_key !== `git-blob:${algorithm}:${entry.blob_oid}`) {
    fail("FAIL-JVM-STATIC-BINDING", "repositoryIndex JVM content identity is invalid");
  }
}

function selectEntries(index) {
  const coverage = { java: emptyCoverage(), kotlin: emptyCoverage() };
  const selected = { java: [], kotlin: [] };
  for (const entry of index.entries) {
    if (!entry || !SOURCE_MODES.has(entry.mode) || entry.classifications?.source !== true
        || !["java", "kotlin"].includes(entry.language)) continue;
    validateIndexEntry(entry, index.binding.object_format);
    if (!["generated", "human", "unknown"].includes(entry.classifications.generated)
        || !["vendor", "not-vendor"].includes(entry.classifications.vendor)
        || typeof entry.classifications.test_source !== "boolean") {
      fail("FAIL-JVM-STATIC-BINDING", "repositoryIndex JVM classifications are invalid");
    }
    const languageCoverage = coverage[entry.language];
    languageCoverage.indexed_source += 1;
    if (entry.classifications.vendor === "vendor") {
      languageCoverage.excluded_vendor += 1;
    } else if (entry.classifications.generated === "generated") {
      languageCoverage.excluded_generated += 1;
    } else if (entry.classifications.generated !== "human") {
      languageCoverage.excluded_unknown_generated += 1;
    } else {
      languageCoverage.selected_human += 1;
      selected[entry.language].push(entry);
    }
  }
  selected.java.sort((left, right) => stableCompare(left.path, right.path));
  selected.kotlin.sort((left, right) => stableCompare(left.path, right.path));
  return { coverage, selected };
}

function configurationHash(configuration, javaExecutableSha256) {
  return sha256(canonicalJson({
    analyzer_version: JAVA_AST_ANALYZER_VERSION,
    boundary_version: JVM_STATIC_INTELLIGENCE_VERSION,
    grammar_target: configuration.grammarTarget,
    java_executable_sha256: javaExecutableSha256,
    limits: configuration.limits,
    protocol: JAVA_AST_PROTOCOL_VERSION,
  }));
}

function protocolLimits(configuration) {
  return Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, configuration.limits[key]]));
}

function uniqueJavaEntries(entries) {
  const byContent = new Map();
  for (const entry of entries) {
    const prior = byContent.get(entry.content_key);
    if (prior && (prior.blob_oid !== entry.blob_oid || prior.byte_size !== entry.byte_size)) {
      fail("FAIL-JVM-STATIC-BINDING", "equal JVM content keys declared different blob identities");
    }
    if (!prior) byContent.set(entry.content_key, entry);
  }
  return [...byContent.values()].sort((left, right) => stableCompare(left.path, right.path));
}

function partitionBatches(entries, limits) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const entry of entries) {
    if (current.length > 0 && (current.length >= limits.maxBatchFiles || bytes + entry.byte_size > limits.maxBatchBytes)) {
      batches.push({ entries: current, bytes });
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entry.byte_size;
  }
  if (current.length > 0) batches.push({ entries: current, bytes });
  return batches;
}

function partitionWaves(batches, maximumBytes) {
  const waves = [];
  let current = [];
  let bytes = 0;
  for (const batch of batches) {
    if (current.length > 0 && bytes + batch.bytes > maximumBytes) {
      waves.push({ batches: current, bytes });
      current = [];
      bytes = 0;
    }
    current.push(batch);
    bytes += batch.bytes;
  }
  if (current.length > 0) waves.push({ batches: current, bytes });
  return waves;
}

function gitBlobOid(bytes, objectFormat) {
  return crypto.createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function verifyBlob(entry, bytes, objectFormat) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== entry.byte_size || gitBlobOid(bytes, objectFormat) !== entry.blob_oid) {
    fail("FAIL-JVM-STATIC-BINDING", "RepositoryIndex blob bytes do not match the admitted Git object identity");
  }
}

function parseErrorFact(entry, error) {
  return {
    blob_oid: entry.blob_oid,
    byte_size: entry.byte_size,
    content_key: entry.content_key,
    error: {
      code: error.code,
      column: error.column,
      compiler_code: error.compiler_code,
      line: error.line,
    },
    language: "java",
    path: entry.path,
    scope: entry.classifications.test_source ? "test" : "production",
    status: "error",
  };
}

function genericErrorFact(entry, code) {
  return parseErrorFact(entry, { code, column: null, compiler_code: null, line: null });
}

function unavailableFact(entry, language, reason) {
  return {
    blob_oid: entry.blob_oid,
    byte_size: entry.byte_size,
    content_key: entry.content_key,
    language,
    path: entry.path,
    reason,
    scope: entry.classifications.test_source ? "test" : "production",
    status: "unavailable",
  };
}

function okFact(entry, result) {
  return {
    blob_oid: entry.blob_oid,
    byte_size: entry.byte_size,
    callables: result.callables,
    content_key: entry.content_key,
    imports: result.imports,
    language: "java",
    package_name: result.package_name,
    path: entry.path,
    scope: entry.classifications.test_source ? "test" : "production",
    status: "ok",
  };
}

function errorCode(error) {
  if (typeof error?.code === "string") return error.code;
  const match = /^(FAIL-[A-Z0-9-]+):/.exec(error?.message ?? "");
  return match?.[1] ?? "FAIL-JVM-JAVA-ANALYZER";
}

function runtimeFromResponse(response) {
  return {
    analyzer_source_sha256: response.analyzer_source_sha256,
    analyzer_version: response.analyzer_version,
    compiler_implementation: response.compiler_implementation,
    direct_process_executable: response.direct_process_executable,
    grammar_target: response.grammar_target,
    java_runtime_version: response.java_runtime_version,
    java_vendor: response.java_vendor,
    parser_runtime: response.parser_runtime,
    protocol: response.protocol,
  };
}

function taskForBatch(batch, batchIndex, context) {
  const { configuration, index, runtimeIdentity, signal, token } = context;
  const firstPath = batch.entries[0].path;
  return {
    id: `java-ast-${batchIndex.toString().padStart(6, "0")}`,
    resourceClass: "external_process",
    deterministicOrderKey: `40:java:${firstPath}`,
    dependencies: [],
    timeoutMs: configuration.limits.batchTimeoutMs + 5_000,
    memoryWeight: Math.max(1, Math.ceil((batch.bytes + configuration.limits.maxStdoutBytes) / (32 * 1024 * 1024))),
    concurrencyGroup: "java-ast",
    run: async ({ signal: taskSignal }) => {
      assertLive(index, token, taskSignal);
      const blobs = await index.readBlobs(batch.entries, {
        max_blob_bytes: configuration.limits.maxFileBytes,
        max_total_bytes: configuration.limits.maxBatchBytes,
        signal: taskSignal,
      });
      assertLive(index, token, taskSignal);
      if (!blobs || typeof blobs.get !== "function") fail("FAIL-JVM-STATIC-BINDING", "RepositoryIndex readBlobs did not return a map-like value");
      const files = batch.entries.map((entry, ordinal) => {
        const bytes = blobs.get(entry.path);
        verifyBlob(entry, bytes, index.binding.object_format);
        return { ordinal, blobOid: entry.blob_oid, contentKey: entry.content_key, bytes };
      });
      const response = await analyzeJavaAstBatch({
        javaExecutable: configuration.javaExecutable,
        requestId: `jvm-${index.binding.index_digest.slice(7, 23)}-${batchIndex}`,
        indexDigest: index.binding.index_digest,
        files,
        limits: protocolLimits(configuration),
        signal: taskSignal,
      });
      if (canonicalJson(runtimeFromResponse(response)) !== canonicalJson(runtimeIdentity)) {
        fail("FAIL-JVM-STATIC-BINDING", "Java runtime identity changed between admission and batch analysis");
      }
      assertLive(index, token, taskSignal);
      return response;
    },
  };
}

function newTelemetry(selected, uniqueEntries) {
  return {
    analyzer_batch_attempts: 0,
    batch_count: 0,
    batch_protocol_attempts: 0,
    executor_runs: 0,
    max_in_flight: 0,
    max_wave_source_bytes: 0,
    runtime_probe_attempts: 0,
    selected_java_files: selected.java.length,
    selected_kotlin_files: selected.kotlin.length,
    selected_source_bytes: [...selected.java, ...selected.kotlin].reduce((sum, entry) => sum + entry.byte_size, 0),
    tasks_submitted: 0,
    unique_java_blobs: uniqueEntries.length,
    waves: 0,
  };
}

async function analyzeJavaEntries(entries, context, telemetry) {
  const factsByContent = new Map();
  const oversized = entries.filter((entry) => entry.byte_size > context.configuration.limits.maxFileBytes);
  for (const entry of oversized) factsByContent.set(entry.content_key, genericErrorFact(entry, "FAIL-JVM-JAVA-FILE-LIMIT"));
  const admitted = entries.filter((entry) => entry.byte_size <= context.configuration.limits.maxFileBytes);
  const batches = partitionBatches(admitted, context.configuration.limits);
  const waves = partitionWaves(batches, context.configuration.limits.maxQueuedSourceBytes);
  telemetry.batch_count = batches.length;
  telemetry.waves = waves.length;
  let batchOffset = 0;
  for (const wave of waves) {
    assertLive(context.index, context.token, context.signal);
    telemetry.max_wave_source_bytes = Math.max(telemetry.max_wave_source_bytes, wave.bytes);
    const tasks = wave.batches.map((batch, index) => taskForBatch(batch, batchOffset + index, context));
    telemetry.analyzer_batch_attempts += tasks.length;
    telemetry.batch_protocol_attempts += tasks.length;
    const execution = await context.taskExecutor.run(tasks, { signal: context.signal });
    telemetry.executor_runs += 1;
    telemetry.tasks_submitted += execution.telemetry?.tasks_submitted ?? tasks.length;
    telemetry.max_in_flight = Math.max(telemetry.max_in_flight, execution.telemetry?.max_in_flight ?? 0);
    if (context.signal?.aborted || execution.status === "cancelled") checkCancelled(context.signal ?? { aborted: true });
    const outcomes = new Map(execution.results.map((result) => [result.id, result]));
    for (let index = 0; index < wave.batches.length; index += 1) {
      const batch = wave.batches[index];
      const task = tasks[index];
      const outcome = outcomes.get(task.id);
      if (outcome?.state === "succeeded") {
        for (let ordinal = 0; ordinal < batch.entries.length; ordinal += 1) {
          const entry = batch.entries[ordinal];
          const result = outcome.value.results[ordinal];
          if (!result || result.content_key !== entry.content_key) {
            fail("FAIL-JVM-STATIC-BINDING", "Java analyzer result no longer binds admitted content");
          }
          factsByContent.set(entry.content_key, result.status === "ok" ? okFact(entry, result) : parseErrorFact(entry, result.error));
        }
      } else {
        const code = errorCode(outcome?.error);
        if (code === "FAIL-JVM-STATIC-BINDING" || code === "FAIL-JAVA-AST-PROTOCOL") {
          fail("FAIL-JVM-STATIC-BINDING", "Java analysis crossed an unverified identity boundary");
        }
        if (code === "FAIL-JAVA-AST-CANCELLED" || code === "FAIL-TASK-CANCELLED") checkCancelled(context.signal ?? { aborted: true });
        for (const entry of batch.entries) factsByContent.set(entry.content_key, genericErrorFact(entry, "FAIL-JVM-JAVA-ANALYZER"));
      }
    }
    batchOffset += wave.batches.length;
  }
  assertLive(context.index, context.token, context.signal);
  return factsByContent;
}

function materializeJavaFiles(selected, factsByContent) {
  return selected.map((entry) => {
    const source = factsByContent.get(entry.content_key);
    if (!source) fail("FAIL-JVM-STATIC-BINDING", "Java fact coverage is incomplete");
    if (source.status === "ok") return okFact(entry, source);
    return parseErrorFact(entry, source.error);
  });
}

function languageState(status, reason, runtime, files) {
  return {
    failed_file_count: files.filter((file) => file.status === "error").length,
    measured_file_count: files.filter((file) => file.status === "ok").length,
    reason,
    runtime,
    selected_file_count: files.length,
    status,
    unavailable_file_count: files.filter((file) => file.status === "unavailable").length,
  };
}

function analyzerContracts() {
  return {
    java: {
      analyzer_version: JAVA_AST_ANALYZER_VERSION,
      callable_span_definition: "zero-based UTF-16 start/end offsets with an exclusive end; one-based lines and columns",
      callable_span_definition_id: JAVA_CALLABLE_SPAN_DEFINITION_ID,
      cyclomatic_definition: "base 1 plus if, loop, catch, non-default switch label, conditional expression, conditional-and, and conditional-or nodes; nested callable bodies are excluded",
      cyclomatic_definition_id: JAVA_CYCLOMATIC_DEFINITION_ID,
      grammar_target: GRAMMAR_TARGET,
      import_definition_id: JAVA_IMPORT_DEFINITION_ID,
      import_definition: "compiler-AST import declarations preserve exact qualified names and static/wildcard flags; no symbol-resolution edge is inferred",
      parser_runtime: PARSER_RUNTIME,
      protocol: JAVA_AST_PROTOCOL_VERSION,
    },
    kotlin: {
      analyzer_version: null,
      parser_runtime: null,
      reason: KOTLIN_UNAVAILABLE_REASON,
      status: "unavailable",
    },
  };
}

async function analyzeJvmStaticIntelligence(input) {
  assertClosedRecord(input, INPUT_KEYS, "input");
  validateRepositoryIndex(input.repositoryIndex);
  validateTaskExecutor(input.taskExecutor);
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    fail("FAIL-JVM-STATIC-CONFIG", "signal must be an AbortSignal");
  }
  checkCancelled(input.signal);
  const configuration = normalizeConfiguration(input.configuration);
  const { repositoryIndex: index, taskExecutor, signal } = input;
  const token = bindingToken(index);
  const javaExecutableHash = executableSha256(configuration.javaExecutable);
  const configHash = configurationHash(configuration, javaExecutableHash);
  assertLive(index, token, signal);
  const { coverage, selected } = selectEntries(index);
  const uniqueEntries = uniqueJavaEntries(selected.java);
  const telemetry = newTelemetry(selected, uniqueEntries);
  const kotlinFiles = selected.kotlin.map((entry) => unavailableFact(entry, "kotlin", KOTLIN_UNAVAILABLE_REASON));
  let runtimeIdentity = null;
  let javaFiles = [];
  let javaStatus = selected.java.length === 0 ? "not_present" : "unavailable";
  let javaReason = selected.java.length === 0 ? null : JAVA_RUNTIME_UNAVAILABLE_REASON;
  if (selected.java.length > 0) {
    telemetry.runtime_probe_attempts += 1;
    try {
      runtimeIdentity = await probeJavaAstRuntime({ javaExecutable: configuration.javaExecutable, signal });
    } catch (error) {
      if (signal?.aborted || errorCode(error) === "FAIL-JAVA-AST-CANCELLED") checkCancelled(signal ?? { aborted: true });
      runtimeIdentity = null;
    }
    assertLive(index, token, signal);
    if (runtimeIdentity === null) {
      javaFiles = selected.java.map((entry) => unavailableFact(entry, "java", JAVA_RUNTIME_UNAVAILABLE_REASON));
    } else {
      if (javaExecutableHash === null || executableSha256(configuration.javaExecutable) !== javaExecutableHash) {
        fail("FAIL-JVM-STATIC-BINDING", "Java executable identity changed during runtime admission");
      }
      const factsByContent = await analyzeJavaEntries(uniqueEntries, {
        configuration,
        index,
        runtimeIdentity,
        signal,
        taskExecutor,
        token,
      }, telemetry);
      javaFiles = materializeJavaFiles(selected.java, factsByContent);
      javaStatus = javaFiles.some((file) => file.status !== "ok") ? "degraded" : "available";
      javaReason = javaStatus === "available" ? null : JAVA_PARTIAL_REASON;
    }
  }
  assertLive(index, token, signal);
  const runtime = runtimeIdentity === null ? null : {
    ...runtimeIdentity,
    java_executable_sha256: javaExecutableHash,
  };
  const files = [...javaFiles, ...kotlinFiles].sort((left, right) => stableCompare(left.path, right.path) || stableCompare(left.language, right.language));
  const canonical = deepFreeze(canonicalValue({
    analyzer_contracts: analyzerContracts(),
    binding: {
      classification_policy_hash: index.binding.classification_policy_hash,
      classification_policy_version: index.binding.classification_policy_version,
      configuration_hash: configHash,
      index_digest: index.binding.index_digest,
      index_key: index.binding.index_key,
      object_format: index.binding.object_format,
      repository_revision: index.binding.repository_revision,
      root_tree_oid: index.binding.root_tree_oid,
    },
    coverage,
    files,
    languages: {
      java: languageState(javaStatus, javaReason, runtime, javaFiles),
      kotlin: languageState("unavailable", KOTLIN_UNAVAILABLE_REASON, null, kotlinFiles),
    },
    schema_version: JVM_STATIC_INTELLIGENCE_VERSION,
  }));
  const result = {
    canonical,
    canonical_digest: sha256(canonicalJson(canonical)),
    telemetry: deepFreeze(canonicalValue(telemetry)),
  };
  return deepFreeze(result);
}

function projectJvmEvidence(input) {
  assertClosedRecord(input, ["configuration_hash", "history_window", "result"], "projection input", "FAIL-JVM-STATIC-PROJECTION", true);
  const result = input.result;
  if (!isRecord(result) || result.canonical?.schema_version !== JVM_STATIC_INTELLIGENCE_VERSION || !Array.isArray(result.canonical.files)) {
    fail("FAIL-JVM-STATIC-PROJECTION", "result is not canonical JVM intelligence");
  }
  if (!/^[0-9a-f]{64}$/.test(input.configuration_hash ?? "")) fail("FAIL-JVM-STATIC-PROJECTION", "configuration_hash is invalid");
  assertClosedRecord(input.history_window, ["end", "kind", "start"], "projection history_window", "FAIL-JVM-STATIC-PROJECTION", true);
  const revision = result.canonical.binding.repository_revision;
  if (input.history_window.end !== revision) fail("FAIL-JVM-STATIC-PROJECTION", "history_window must end at repository revision");
  const java = result.canonical.languages.java;
  const kotlin = result.canonical.languages.kotlin;
  const collectorStatus = (state) => state.status === "available" ? "available" : state.status === "degraded" ? "degraded" : "unavailable";
  const collectors = [
    { collector_id: "java-static-intelligence", collector_version: JVM_STATIC_INTELLIGENCE_VERSION, status: collectorStatus(java), analyzer_identity: JAVA_AST_ANALYZER_VERSION, analyzer_version: JAVA_AST_ANALYZER_VERSION, reason: java.status === "available" ? null : java.reason ?? JAVA_RUNTIME_UNAVAILABLE_REASON },
    { collector_id: "kotlin-static-intelligence", collector_version: JVM_STATIC_INTELLIGENCE_VERSION, status: "unavailable", analyzer_identity: JVM_STATIC_INTELLIGENCE_VERSION, analyzer_version: JVM_STATIC_INTELLIGENCE_VERSION, reason: kotlin.reason },
  ];
  const refsFor = (language, extras = []) => [...new Set([`jvm-result:${result.canonical_digest}`, `repository-index:${result.canonical.binding.index_digest}`, `jvm-language:${language}`, ...extras])].sort(stableCompare);
  const record = ({ id, definition, language, status, value, unit, subject = "repository:committed-index", pathValue = ".", scopeKind = "repository", extras = [], reason = null }) => {
    const measured = status === "measured";
    const collector = language === "java" ? collectors[0] : collectors[1];
    const evidenceRefs = refsFor(language, extras);
    return {
      metric_id: id, definition_id: definition, family: "structural_complexity", subject, repository_revision: revision,
      value: measured ? value : null, unit,
      measurement: { status, completeness: measured ? 1 : 0, confidence: measured ? 1 : 0, reason: measured ? null : reason ?? collector.reason ?? "verified measurement is unavailable" },
      source: { kind: "exact-git-jvm-compiler-ast", collector_id: collector.collector_id, collector_version: collector.collector_version, repository_revision: revision, command: null, artifact_refs: evidenceRefs, evidence_refs: evidenceRefs },
      scope: { kind: scopeKind, path: pathValue, language, generated_code: false, included_in_human_maintainability: true },
      window: structuredClone(input.history_window), analyzer_identity: collector.analyzer_identity, analyzer_version: collector.analyzer_version,
      comparability: { analyzer_identity: collector.analyzer_identity, analyzer_version: collector.analyzer_version, configuration_hash: input.configuration_hash, compatible_with_prior: false, reason: "no prior analyzer-bound JVM measurement was supplied" },
    };
  };
  const javaFiles = result.canonical.files.filter((file) => file.language === "java");
  const javaCallables = javaFiles.filter((file) => file.status === "ok").flatMap((file) => file.callables.map((callable) => ({ file, callable })));
  const javaMeasured = java.status === "available" || java.status === "degraded";
  const metrics = [
    record({ id: "static.java.cyclomatic_callable_count", definition: JAVA_CYCLOMATIC_DEFINITION_ID, language: "java", status: javaMeasured ? "measured" : "unavailable", value: javaCallables.length, unit: "callables" }),
    record({ id: "static.java.cyclomatic_complexity", definition: JAVA_CYCLOMATIC_DEFINITION_ID, language: "java", status: javaMeasured ? "measured" : "unavailable", value: javaCallables.reduce((sum, item) => sum + item.callable.complexity, 0), unit: "cyclomatic-complexity-points" }),
    record({ id: "static.java.cognitive_complexity", definition: "sei.static.java.cognitive_complexity@1", language: "java", status: "unavailable", value: null, unit: "cognitive-complexity-points", reason: "verified Java cognitive-complexity definition is unavailable" }),
    record({ id: "static.kotlin.cyclomatic_complexity", definition: "sei.static.kotlin.cyclomatic_complexity@1", language: "kotlin", status: "unavailable", value: null, unit: "cyclomatic-complexity-points" }),
  ];
  for (const file of javaFiles) {
    const callables = file.status === "ok" ? file.callables : [];
    metrics.push(record({ id: `static.java.cyclomatic_complexity:${file.path}`, definition: JAVA_CYCLOMATIC_DEFINITION_ID, language: "java", status: file.status === "ok" ? "measured" : "unavailable", value: callables.reduce((sum, callable) => sum + callable.complexity, 0), unit: "cyclomatic-complexity-points", subject: `file:${file.path}`, pathValue: file.path, scopeKind: "file", extras: [file.path] }));
    for (const callable of callables) metrics.push(record({ id: `static.java.cyclomatic_callable:${file.path}:${callable.start_line}:${callable.end_line}:${callable.qualified_name}`, definition: JAVA_CYCLOMATIC_DEFINITION_ID, language: "java", status: "measured", value: callable.complexity, unit: "cyclomatic-complexity-points", subject: `java-callable:${file.path}#${callable.qualified_name}@${callable.start_line}-${callable.end_line}`, pathValue: file.path, scopeKind: "file", extras: [file.path, callable.qualified_name] }));
  }
  return deepFreeze(canonicalValue({ collectors, metrics: metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id)), result }));
}

function projectUnavailableJvmEvidence(input) {
  assertClosedRecord(input, ["configuration_hash", "history_window", "reason", "repository_revision"], "unavailable projection input", "FAIL-JVM-STATIC-PROJECTION", true);
  if (!/^[0-9a-f]{40}$/.test(input.repository_revision ?? "") || !/^[0-9a-f]{64}$/.test(input.configuration_hash ?? "") || typeof input.reason !== "string" || input.reason.length === 0) {
    fail("FAIL-JVM-STATIC-PROJECTION", "unavailable projection binding is invalid");
  }
  assertClosedRecord(input.history_window, ["end", "kind", "start"], "projection history_window", "FAIL-JVM-STATIC-PROJECTION", true);
  if (input.history_window.end !== input.repository_revision) fail("FAIL-JVM-STATIC-PROJECTION", "history_window must end at repository revision");
  const collectors = ["java", "kotlin"].map((language) => ({ collector_id: `${language}-static-intelligence`, collector_version: JVM_STATIC_INTELLIGENCE_VERSION, status: "unavailable", analyzer_identity: language === "java" ? JAVA_AST_ANALYZER_VERSION : JVM_STATIC_INTELLIGENCE_VERSION, analyzer_version: language === "java" ? JAVA_AST_ANALYZER_VERSION : JVM_STATIC_INTELLIGENCE_VERSION, reason: language === "kotlin" ? KOTLIN_UNAVAILABLE_REASON : input.reason }));
  const metrics = ["java", "kotlin"].flatMap((language, index) => ["cyclomatic_complexity", "cognitive_complexity"].map((name) => ({
    metric_id: `static.${language}.${name}`, definition_id: `sei.static.${language}.${name}@1`, family: "structural_complexity", subject: "repository:committed-index", repository_revision: input.repository_revision, value: null, unit: `${name.replace("_", "-")}-points`,
    measurement: { status: "unavailable", completeness: 0, confidence: 0, reason: collectors[index].reason },
    source: { kind: "jvm-runtime-discovery", collector_id: collectors[index].collector_id, collector_version: collectors[index].collector_version, repository_revision: input.repository_revision, command: null, artifact_refs: [`jvm-language:${language}`, `jvm-unavailable:${name}`], evidence_refs: [`jvm-language:${language}`, `jvm-unavailable:${name}`] },
    scope: { kind: "repository", path: ".", language, generated_code: false, included_in_human_maintainability: true }, window: structuredClone(input.history_window), analyzer_identity: collectors[index].analyzer_identity, analyzer_version: collectors[index].analyzer_version,
    comparability: { analyzer_identity: collectors[index].analyzer_identity, analyzer_version: collectors[index].analyzer_version, configuration_hash: input.configuration_hash, compatible_with_prior: false, reason: "JVM analyzer runtime unavailable" },
  })));
  return deepFreeze(canonicalValue({ collectors, metrics: metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id)), result: null }));
}

module.exports = {
  JVM_STATIC_INTELLIGENCE_VERSION,
  JAVA_CYCLOMATIC_DEFINITION_ID,
  JAVA_CALLABLE_SPAN_DEFINITION_ID,
  JAVA_IMPORT_DEFINITION_ID,
  KOTLIN_UNAVAILABLE_REASON,
  analyzeJvmStaticIntelligence,
  projectJvmEvidence,
  projectUnavailableJvmEvidence,
};
