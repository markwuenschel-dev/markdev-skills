"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { assessJavaCapability } = require("../runtime-capabilities");
const { runOwnedSubprocess } = require("./subprocess-supervisor");

const JAVA_AST_ANALYZER_VERSION = "sei.java-ast@1";
const JAVA_AST_PROTOCOL_VERSION = "sei.java-ast@1";
const PARSER_RUNTIME = "jdk.compiler";
const GRAMMAR_TARGET = 25;
const REQUEST_MAGIC = Buffer.from("SEIJVA1\0", "ascii");
const RESPONSE_MAGIC = Buffer.from("SEIJVR1\0", "ascii");
const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxBatchFiles: 32,
  maxBatchBytes: 4 * 1024 * 1024,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  batchTimeoutMs: 30_000,
});
const HARD_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxBatchFiles: 128,
  maxBatchBytes: 16 * 1024 * 1024,
  maxStdoutBytes: 32 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  batchTimeoutMs: 120_000,
});
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
const FILE_INPUT_KEYS = Object.freeze(["blobOid", "bytes", "contentKey", "ordinal"]);
const RUNTIME_KEYS = Object.freeze([
  "analyzer_source_sha256", "analyzer_version", "compiler_implementation", "direct_process_executable", "grammar_target",
  "java_runtime_version", "java_vendor", "parser_runtime", "protocol",
]);

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedRecord(value, keys, label, code, exact = false) {
  if (!isRecord(value)) fail(code, `${label} must be a closed record`);
  const allowed = new Set(keys);
  const actual = Object.keys(value).sort(stableCompare);
  const unexpected = actual.filter((key) => !allowed.has(key));
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

function normalizeLimits(input = {}) {
  assertClosedRecord(input, LIMIT_KEYS, "limits", "FAIL-JAVA-AST-CONFIG");
  const result = {};
  for (const key of LIMIT_KEYS) {
    const value = input[key] ?? DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_LIMITS[key]) {
      fail("FAIL-JAVA-AST-CONFIG", `${key} must be a positive safe integer no greater than ${HARD_LIMITS[key]}`);
    }
    result[key] = value;
  }
  if (result.maxFileBytes > result.maxBatchBytes) {
    fail("FAIL-JAVA-AST-CONFIG", "maxFileBytes cannot exceed maxBatchBytes");
  }
  return Object.freeze(result);
}

function validateRequestIdentity(requestId, indexDigest) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    fail("FAIL-JAVA-AST-CONFIG", "requestId must be 1-128 portable identity characters");
  }
  if (typeof indexDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(indexDigest)) {
    fail("FAIL-JAVA-AST-CONFIG", "indexDigest must be a lowercase sha256 identity");
  }
}

function normalizeFiles(files, limits) {
  if (!Array.isArray(files) || files.length === 0) fail("FAIL-JAVA-AST-CONFIG", "files must be a non-empty array");
  if (files.length > limits.maxBatchFiles) {
    fail("FAIL-JAVA-AST-BATCH-LIMIT", `batch contains more than ${limits.maxBatchFiles} files`);
  }
  const normalized = files.map((file, index) => {
    assertClosedRecord(file, FILE_INPUT_KEYS, `files[${index}]`, "FAIL-JAVA-AST-CONFIG", true);
    if (!Number.isSafeInteger(file.ordinal) || file.ordinal < 0 || file.ordinal > 65_535) {
      fail("FAIL-JAVA-AST-CONFIG", `files[${index}].ordinal must be a non-negative uint16`);
    }
    if (!Buffer.isBuffer(file.bytes)) fail("FAIL-JAVA-AST-CONFIG", `files[${index}].bytes must be a Buffer`);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(file.blobOid)) {
      fail("FAIL-JAVA-AST-CONFIG", `files[${index}].blobOid is invalid`);
    }
    const algorithm = file.blobOid.length === 40 ? "sha1" : "sha256";
    if (file.contentKey !== `git-blob:${algorithm}:${file.blobOid}`) {
      fail("FAIL-JAVA-AST-CONFIG", `files[${index}].contentKey does not bind blobOid`);
    }
    const computedOid = crypto.createHash(algorithm)
      .update(Buffer.from(`blob ${file.bytes.length}\0`, "utf8"))
      .update(file.bytes)
      .digest("hex");
    if (computedOid !== file.blobOid) {
      fail("FAIL-JAVA-AST-CONFIG", `files[${index}].bytes do not match blobOid`);
    }
    if (Buffer.byteLength(file.contentKey, "utf8") > 65_535) fail("FAIL-JAVA-AST-CONFIG", `files[${index}].contentKey is too long`);
    if (file.bytes.length > limits.maxFileBytes) {
      fail("FAIL-JAVA-AST-FILE-LIMIT", `ordinal ${file.ordinal} exceeds ${limits.maxFileBytes} bytes`);
    }
    return { ...file, bytes: Buffer.from(file.bytes) };
  }).sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].ordinal !== index) {
      fail("FAIL-JAVA-AST-CONFIG", "file ordinals must be unique and contiguous from zero");
    }
  }
  const totalBytes = normalized.reduce((sum, file) => sum + file.bytes.length, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBatchBytes) {
    fail("FAIL-JAVA-AST-BATCH-LIMIT", `batch source bytes exceed ${limits.maxBatchBytes}`);
  }
  return normalized;
}

function uint16(value) {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function encodeJavaAstRequest(input) {
  assertClosedRecord(input, ["files", "indexDigest", "limits", "requestId"], "request", "FAIL-JAVA-AST-CONFIG");
  validateRequestIdentity(input.requestId, input.indexDigest);
  const limits = normalizeLimits(input.limits);
  const files = normalizeFiles(input.files, limits);
  const requestId = Buffer.from(input.requestId, "utf8");
  const metadata = [
    REQUEST_MAGIC,
    uint16(requestId.length),
    requestId,
    Buffer.from(input.indexDigest.slice(7), "hex"),
    uint16(GRAMMAR_TARGET),
    uint32(limits.maxFileBytes),
    uint16(files.length),
    uint32(limits.maxBatchBytes),
  ];
  for (const file of files) {
    const oidAlgorithm = file.blobOid.length === 40 ? 1 : 2;
    const contentKey = Buffer.from(file.contentKey, "utf8");
    metadata.push(
      uint16(file.ordinal),
      Buffer.from([oidAlgorithm]),
      Buffer.from(file.blobOid, "hex"),
      uint16(contentKey.length),
      contentKey,
      uint32(file.bytes.length),
      crypto.createHash("sha256").update(file.bytes).digest(),
    );
  }
  const headerBytes = metadata.reduce((sum, part) => sum + part.length, 0);
  if (headerBytes > 1024 * 1024) fail("FAIL-JAVA-AST-BATCH-LIMIT", "request metadata exceeds 1 MiB");
  return Buffer.concat([...metadata, ...files.map((file) => file.bytes)]);
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function processError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function runJavaProcess({ javaExecutable, analyzerPath, analyzerHash, mode, input, signal, timeoutMs, maxStdoutBytes, maxStderrBytes }) {
  return runOwnedSubprocess({
    command: javaExecutable,
    args: [analyzerPath, mode, analyzerHash, javaExecutable],
    cwd: path.dirname(analyzerPath),
    input,
    signal,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    codes: {
      cancelled: "FAIL-JAVA-AST-CANCELLED",
      timeout: "FAIL-JAVA-AST-TIMEOUT",
      process: "FAIL-JAVA-AST-PROCESS",
    },
  }).then((result) => {
    if (result.stderr.length > 0) throw processError("FAIL-JAVA-AST-PROCESS", "analyzer emitted stderr on a successful exit");
    return result;
  });
}

function normalizeProcessOptions(input, { probe = false } = {}) {
  const keys = probe ? ["analyzerPath", "javaExecutable", "signal", "timeoutMs"] : [
    "analyzerPath", "files", "indexDigest", "javaExecutable", "limits", "requestId", "signal",
  ];
  assertClosedRecord(input, keys, "input", "FAIL-JAVA-AST-CONFIG");
  if (typeof input.javaExecutable !== "string" || input.javaExecutable.includes("\0") || !path.isAbsolute(input.javaExecutable)) {
    fail("FAIL-JAVA-AST-CONFIG", "javaExecutable must be an explicit absolute NUL-free path");
  }
  const analyzerPath = input.analyzerPath === undefined ? path.join(__dirname, "JavaAstAnalyzer.java") : input.analyzerPath;
  if (typeof analyzerPath !== "string" || analyzerPath.includes("\0") || !path.isAbsolute(analyzerPath)) {
    fail("FAIL-JAVA-AST-CONFIG", "analyzerPath must be an absolute NUL-free path");
  }
  let stats;
  try { stats = fs.statSync(analyzerPath); } catch { fail("FAIL-JAVA-AST-CONFIG", "analyzerPath must be an existing regular file"); }
  if (!stats.isFile()) fail("FAIL-JAVA-AST-CONFIG", "analyzerPath must be an existing regular file");
  if (input.signal !== undefined && !isAbortSignal(input.signal)) fail("FAIL-JAVA-AST-CONFIG", "signal must be an AbortSignal");
  const analyzerHash = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(analyzerPath)).digest("hex")}`;
  if (probe) {
    const timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      fail("FAIL-JAVA-AST-CONFIG", "timeoutMs must be 1..30000");
    }
    return { javaExecutable: input.javaExecutable, analyzerPath, analyzerHash, signal: input.signal, timeoutMs };
  }
  return { ...input, analyzerPath, analyzerHash };
}

function validateRuntimeIdentity(identity, expectedHash, code = "FAIL-JAVA-AST-RUNTIME") {
  assertClosedRecord(identity, RUNTIME_KEYS, "runtime identity", code, true);
  const capability = assessJavaCapability({
    compiler_available: identity.compiler_implementation === "com.sun.tools.javac.api.JavacTool",
    java_runtime_version: identity.java_runtime_version,
  });
  if (identity.analyzer_source_sha256 !== expectedHash
      || identity.analyzer_version !== JAVA_AST_ANALYZER_VERSION
      || identity.compiler_implementation !== "com.sun.tools.javac.api.JavacTool"
      || identity.direct_process_executable !== true
      || identity.grammar_target !== GRAMMAR_TARGET
      || capability.status !== "available"
      || typeof identity.java_vendor !== "string" || identity.java_vendor.length === 0 || identity.java_vendor.length > 256
      || identity.java_vendor.includes("\0") || /[\r\n]/.test(identity.java_vendor)
      || identity.parser_runtime !== PARSER_RUNTIME
      || identity.protocol !== JAVA_AST_PROTOCOL_VERSION) {
    fail(code, `runtime identity lacks the minimum analyzer capability (${capability.reason_code ?? "IDENTITY_MISMATCH"})`);
  }
}

async function probeJavaAstRuntime(input) {
  const options = normalizeProcessOptions(input, { probe: true });
  let result;
  try {
    result = await runJavaProcess({
      ...options,
      mode: "--probe",
      maxStdoutBytes: 16 * 1024,
      maxStderrBytes: 16 * 1024,
    });
  } catch (error) {
    if (/^FAIL-JAVA-AST-(?:CANCELLED|TIMEOUT):/.test(error.message)) throw error;
    throw processError("FAIL-JAVA-AST-RUNTIME", error.message);
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); } catch { fail("FAIL-JAVA-AST-RUNTIME", "probe stdout was not UTF-8"); }
  let identity;
  try { identity = JSON.parse(text); } catch { fail("FAIL-JAVA-AST-RUNTIME", "probe stdout was not one JSON object"); }
  if (canonicalJson(identity) !== text) fail("FAIL-JAVA-AST-RUNTIME", "probe response was not canonical JSON");
  validateRuntimeIdentity(identity, options.analyzerHash);
  return deepFreeze(canonicalValue(identity));
}

function assertSafeInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label} must be a safe integer >= ${minimum}`);
  }
}

function assertSpan(value, label) {
  for (const key of ["start_offset", "end_offset", "start_line", "start_column", "end_line", "end_column"]) {
    assertSafeInteger(value[key], `${label}.${key}`, { minimum: key.includes("offset") ? 0 : 1 });
  }
  if (value.end_offset <= value.start_offset || value.end_line < value.start_line) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label} has an invalid source span`);
  }
}

function validateCallable(value, label) {
  const keys = [
    "complexity", "end_column", "end_line", "end_offset", "kind", "qualified_name",
    "start_column", "start_line", "start_offset",
  ];
  assertClosedRecord(value, keys, label, "FAIL-JAVA-AST-PROTOCOL", true);
  assertSpan(value, label);
  assertSafeInteger(value.complexity, `${label}.complexity`, { minimum: 1 });
  if (!["constructor", "instance-initializer", "lambda", "method", "static-initializer"].includes(value.kind)) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label}.kind is invalid`);
  }
  if (typeof value.qualified_name !== "string" || value.qualified_name.length === 0
      || value.qualified_name.length > 2048 || value.qualified_name.includes("\0") || /[\r\n]/.test(value.qualified_name)) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label}.qualified_name is invalid`);
  }
}

function validateImport(value, label) {
  const keys = [
    "end_column", "end_line", "end_offset", "qualified_name", "start_column", "start_line",
    "start_offset", "static", "wildcard",
  ];
  assertClosedRecord(value, keys, label, "FAIL-JAVA-AST-PROTOCOL", true);
  assertSpan(value, label);
  if (typeof value.qualified_name !== "string" || value.qualified_name.length === 0
      || value.qualified_name.length > 2048 || value.qualified_name.includes("\0") || /[\r\n]/.test(value.qualified_name)) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label}.qualified_name is invalid`);
  }
  if (typeof value.static !== "boolean" || typeof value.wildcard !== "boolean") {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label} import flags must be booleans`);
  }
  if (value.wildcard !== value.qualified_name.endsWith(".*")) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label}.wildcard disagrees with qualified_name`);
  }
}

function validateParseError(value, label) {
  assertClosedRecord(value, ["code", "column", "compiler_code", "line"], label, "FAIL-JAVA-AST-PROTOCOL", true);
  if (!["FAIL-JAVA-AST-ENCODING", "FAIL-JAVA-AST-PARSE", "FAIL-JAVA-AST-SOURCE"].includes(value.code)) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label}.code is invalid`);
  }
  for (const key of ["line", "column"]) {
    if (value[key] !== null) assertSafeInteger(value[key], `${label}.${key}`, { minimum: 1 });
  }
  if (value.compiler_code !== null && (
    typeof value.compiler_code !== "string" || !/^compiler\.[A-Za-z0-9._-]{1,240}$/.test(value.compiler_code)
  )) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label}.compiler_code is invalid`);
  }
  if (value.code !== "FAIL-JAVA-AST-PARSE" && value.compiler_code !== null) {
    fail("FAIL-JAVA-AST-PROTOCOL", `${label}.compiler_code is only valid for parser diagnostics`);
  }
}

function compareFacts(left, right) {
  return left.start_offset - right.start_offset
    || left.end_offset - right.end_offset
    || stableCompare(left.kind ?? "", right.kind ?? "")
    || stableCompare(left.qualified_name, right.qualified_name);
}

function decodeJavaAstResponse(frame, expectations) {
  if (!Buffer.isBuffer(frame)) fail("FAIL-JAVA-AST-PROTOCOL", "response frame must be a Buffer");
  assertClosedRecord(expectations, ["files", "indexDigest", "requestId", "runtimeIdentity"], "expectations", "FAIL-JAVA-AST-PROTOCOL", true);
  if (typeof expectations.indexDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectations.indexDigest)) {
    fail("FAIL-JAVA-AST-PROTOCOL", "expectations.indexDigest is invalid");
  }
  validateRuntimeIdentity(expectations.runtimeIdentity, expectations.runtimeIdentity?.analyzer_source_sha256, "FAIL-JAVA-AST-PROTOCOL");
  if (frame.length < 12 || !frame.subarray(0, 8).equals(RESPONSE_MAGIC)) {
    fail("FAIL-JAVA-AST-PROTOCOL", "response magic is invalid");
  }
  const bodyLength = frame.readUInt32BE(8);
  if (bodyLength === 0 || frame.length !== 12 + bodyLength) {
    fail("FAIL-JAVA-AST-PROTOCOL", "response length is truncated or has trailing bytes");
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(12)); } catch { fail("FAIL-JAVA-AST-PROTOCOL", "response body is not UTF-8"); }
  let response;
  try { response = JSON.parse(text); } catch { fail("FAIL-JAVA-AST-PROTOCOL", "response body is not one JSON object"); }
  if (canonicalJson(response) !== text) fail("FAIL-JAVA-AST-PROTOCOL", "response body is not canonical JSON");
  const responseKeys = [
    "analyzer_source_sha256", "analyzer_version", "compiler_implementation", "diagnostics", "direct_process_executable",
    "grammar_target", "index_digest", "java_runtime_version",
    "java_vendor", "parser_runtime", "protocol", "request_id", "results", "status",
  ];
  assertClosedRecord(response, responseKeys, "response", "FAIL-JAVA-AST-PROTOCOL", true);
  const runtime = expectations.runtimeIdentity;
  for (const key of [
    "analyzer_source_sha256", "analyzer_version", "compiler_implementation", "direct_process_executable",
    "grammar_target", "java_runtime_version",
    "java_vendor", "parser_runtime", "protocol",
  ]) {
    if (response[key] !== runtime[key]) fail("FAIL-JAVA-AST-PROTOCOL", `response ${key} does not match the admitted runtime`);
  }
  if (response.index_digest !== expectations.indexDigest) fail("FAIL-JAVA-AST-PROTOCOL", "response index_digest does not match the request");
  if (response.request_id !== expectations.requestId) fail("FAIL-JAVA-AST-PROTOCOL", "response request_id does not match the request");
  if (!Array.isArray(expectations.files) || !Array.isArray(response.results)
      || response.results.length !== expectations.files.length) {
    fail("FAIL-JAVA-AST-PROTOCOL", "response results do not cover every admitted ordinal");
  }
  if (!["ok", "partial", "error"].includes(response.status)) fail("FAIL-JAVA-AST-PROTOCOL", "response status is invalid");
  assertClosedRecord(response.diagnostics, ["files_failed", "files_received", "files_succeeded"], "response.diagnostics", "FAIL-JAVA-AST-PROTOCOL", true);
  for (const key of ["files_failed", "files_received", "files_succeeded"]) {
    assertSafeInteger(response.diagnostics[key], `response.diagnostics.${key}`);
  }
  let failures = 0;
  for (let ordinal = 0; ordinal < response.results.length; ordinal += 1) {
    const expected = expectations.files[ordinal];
    const result = response.results[ordinal];
    if (!expected || expected.ordinal !== ordinal) fail("FAIL-JAVA-AST-PROTOCOL", "expectation ordinals are not contiguous");
    const common = ["content_key", "ordinal", "sha256", "status"];
    const keys = result?.status === "ok"
      ? ["callables", ...common, "imports", "package_name"]
      : [...common, "error"];
    assertClosedRecord(result, keys, `response.results[${ordinal}]`, "FAIL-JAVA-AST-PROTOCOL", true);
    const expectedSha = crypto.createHash("sha256").update(expected.bytes).digest("hex");
    if (result.ordinal !== ordinal || result.content_key !== expected.contentKey || result.sha256 !== expectedSha) {
      fail("FAIL-JAVA-AST-PROTOCOL", `response result ${ordinal} does not match the admitted content identity`);
    }
    if (result.status === "ok") {
      let sourceText;
      try { sourceText = new TextDecoder("utf-8", { fatal: true }).decode(expected.bytes); } catch {
        fail("FAIL-JAVA-AST-PROTOCOL", `response result ${ordinal} cannot be ok for non-UTF-8 source`);
      }
      if (sourceText.startsWith("\uFEFF")) sourceText = sourceText.slice(1);
      if (result.package_name !== null && (
        typeof result.package_name !== "string" || result.package_name.length === 0
        || result.package_name.length > 2048 || result.package_name.includes("\0") || /[\r\n]/.test(result.package_name)
      )) fail("FAIL-JAVA-AST-PROTOCOL", `response result ${ordinal} package_name is invalid`);
      if (!Array.isArray(result.callables) || !Array.isArray(result.imports)) {
        fail("FAIL-JAVA-AST-PROTOCOL", `response result ${ordinal} facts must be arrays`);
      }
      result.callables.forEach((value, index) => validateCallable(value, `response.results[${ordinal}].callables[${index}]`));
      result.imports.forEach((value, index) => validateImport(value, `response.results[${ordinal}].imports[${index}]`));
      for (const fact of [...result.callables, ...result.imports]) {
        if (fact.end_offset > sourceText.length) {
          fail("FAIL-JAVA-AST-PROTOCOL", `response result ${ordinal} contains a source span beyond the admitted text`);
        }
      }
      for (let index = 1; index < result.callables.length; index += 1) {
        if (compareFacts(result.callables[index - 1], result.callables[index]) > 0) {
          fail("FAIL-JAVA-AST-PROTOCOL", "callables are not canonically sorted");
        }
      }
      for (let index = 1; index < result.imports.length; index += 1) {
        if (compareFacts(result.imports[index - 1], result.imports[index]) > 0) {
          fail("FAIL-JAVA-AST-PROTOCOL", "imports are not canonically sorted");
        }
      }
    } else if (result.status === "error") {
      failures += 1;
      validateParseError(result.error, `response.results[${ordinal}].error`);
    } else {
      fail("FAIL-JAVA-AST-PROTOCOL", `response result ${ordinal} status is invalid`);
    }
  }
  const expectedStatus = failures === 0 ? "ok" : failures === response.results.length ? "error" : "partial";
  if (response.status !== expectedStatus
      || response.diagnostics.files_received !== response.results.length
      || response.diagnostics.files_failed !== failures
      || response.diagnostics.files_succeeded !== response.results.length - failures) {
    fail("FAIL-JAVA-AST-PROTOCOL", "response status/diagnostics are inconsistent with results");
  }
  return deepFreeze(canonicalValue(response));
}

async function analyzeJavaAstBatch(input) {
  const options = normalizeProcessOptions(input);
  const limits = normalizeLimits(input.limits);
  const files = normalizeFiles(input.files, limits);
  const runtimeIdentity = await probeJavaAstRuntime({
    analyzerPath: options.analyzerPath,
    javaExecutable: options.javaExecutable,
    signal: options.signal,
    timeoutMs: Math.min(10_000, limits.batchTimeoutMs),
  });
  const frame = encodeJavaAstRequest({
    requestId: input.requestId,
    indexDigest: input.indexDigest,
    files,
    limits,
  });
  const result = await runJavaProcess({
    javaExecutable: options.javaExecutable,
    analyzerPath: options.analyzerPath,
    analyzerHash: options.analyzerHash,
    mode: "--analyze",
    input: frame,
    signal: options.signal,
    timeoutMs: limits.batchTimeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
  });
  return decodeJavaAstResponse(result.stdout, {
    files,
    indexDigest: input.indexDigest,
    requestId: input.requestId,
    runtimeIdentity,
  });
}

module.exports = {
  JAVA_AST_ANALYZER_VERSION,
  JAVA_AST_PROTOCOL_VERSION,
  PARSER_RUNTIME,
  GRAMMAR_TARGET,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  encodeJavaAstRequest,
  probeJavaAstRuntime,
  decodeJavaAstResponse,
  analyzeJavaAstBatch,
};
