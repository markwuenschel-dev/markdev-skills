"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assessPythonCapability } = require("../runtime-capabilities");
const { runOwnedSubprocess } = require("./subprocess-supervisor");

const PYTHON_AST_ANALYZER_VERSION = "sei.python-ast@1";
const PYTHON_AST_PROTOCOL_VERSION = "sei.python-ast@1";
const PARSER_RUNTIME = "cpython-3.13";
const GRAMMAR_TARGET = Object.freeze([3, 13]);
const REQUEST_MAGIC = Buffer.from("SEIPYA1\0", "ascii");
const RESPONSE_MAGIC = Buffer.from("SEIPYR1\0", "ascii");
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

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function assertClosedRecord(value, keys, label, code, exact = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value).sort(stableCompare);
  const allowed = [...keys].sort(stableCompare);
  const unexpected = actual.filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(code, `${label} contains unexpected field ${unexpected[0]}`);
  if (exact) {
    const missing = allowed.filter((key) => !actual.includes(key));
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

function normalizeLimits(input = {}) {
  assertClosedRecord(input, LIMIT_KEYS, "limits", "FAIL-PYTHON-AST-CONFIG");
  const result = {};
  for (const key of LIMIT_KEYS) {
    const value = input[key] ?? DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_LIMITS[key]) {
      fail("FAIL-PYTHON-AST-CONFIG", `${key} must be a positive safe integer no greater than ${HARD_LIMITS[key]}`);
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function validateRequestIdentity(requestId, indexDigest) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    fail("FAIL-PYTHON-AST-CONFIG", "requestId must be 1-128 portable identity characters");
  }
  if (typeof indexDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(indexDigest)) {
    fail("FAIL-PYTHON-AST-CONFIG", "indexDigest must be a lowercase sha256 identity");
  }
}

function normalizeFiles(files, limits) {
  if (!Array.isArray(files) || files.length === 0) fail("FAIL-PYTHON-AST-CONFIG", "files must be a non-empty array");
  if (files.length > limits.maxBatchFiles) fail("FAIL-PYTHON-AST-BATCH-LIMIT", `batch contains more than ${limits.maxBatchFiles} files`);
  const sorted = files.map((file, index) => {
    assertClosedRecord(file, FILE_INPUT_KEYS, `files[${index}]`, "FAIL-PYTHON-AST-CONFIG", true);
    if (!Number.isSafeInteger(file.ordinal) || file.ordinal < 0) fail("FAIL-PYTHON-AST-CONFIG", `files[${index}].ordinal must be a non-negative safe integer`);
    if (!Buffer.isBuffer(file.bytes)) fail("FAIL-PYTHON-AST-CONFIG", `files[${index}].bytes must be a Buffer`);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(file.blobOid)) fail("FAIL-PYTHON-AST-CONFIG", `files[${index}].blobOid is invalid`);
    const algorithm = file.blobOid.length === 40 ? "sha1" : "sha256";
    if (file.contentKey !== `git-blob:${algorithm}:${file.blobOid}`) fail("FAIL-PYTHON-AST-CONFIG", `files[${index}].contentKey does not bind blobOid`);
    if (file.bytes.length > limits.maxFileBytes) fail("FAIL-PYTHON-AST-FILE-LIMIT", `ordinal ${file.ordinal} exceeds ${limits.maxFileBytes} bytes`);
    return { ...file, bytes: Buffer.from(file.bytes) };
  }).sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].ordinal !== index) fail("FAIL-PYTHON-AST-CONFIG", "file ordinals must be unique and contiguous from zero");
  }
  const totalBytes = sorted.reduce((sum, file) => sum + file.bytes.length, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBatchBytes) {
    fail("FAIL-PYTHON-AST-BATCH-LIMIT", `batch source bytes exceed ${limits.maxBatchBytes}`);
  }
  return sorted;
}

function encodePythonAstRequest(input) {
  assertClosedRecord(input, ["files", "indexDigest", "limits", "requestId"], "request", "FAIL-PYTHON-AST-CONFIG");
  validateRequestIdentity(input.requestId, input.indexDigest);
  const limits = normalizeLimits(input.limits);
  const files = normalizeFiles(input.files, limits);
  const header = {
    analyzer_version: PYTHON_AST_ANALYZER_VERSION,
    files: files.map((file) => ({
      blob_oid: file.blobOid,
      byte_length: file.bytes.length,
      content_key: file.contentKey,
      ordinal: file.ordinal,
      sha256: crypto.createHash("sha256").update(file.bytes).digest("hex"),
    })),
    grammar_target: GRAMMAR_TARGET,
    index_digest: input.indexDigest,
    limits: {
      max_batch_bytes: limits.maxBatchBytes,
      max_batch_files: limits.maxBatchFiles,
      max_file_bytes: limits.maxFileBytes,
    },
    parser_runtime: PARSER_RUNTIME,
    protocol: PYTHON_AST_PROTOCOL_VERSION,
    request_id: input.requestId,
  };
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  if (headerBytes.length > 1024 * 1024) fail("FAIL-PYTHON-AST-BATCH-LIMIT", "request header exceeds 1 MiB");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBytes.length);
  return Buffer.concat([REQUEST_MAGIC, length, headerBytes, ...files.map((file) => file.bytes)]);
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function processError(code, detail) {
  return new Error(`${code}: ${detail}`);
}

function runPythonProcess({ pythonExecutable, analyzerPath, mode, input, signal, timeoutMs, maxStdoutBytes, maxStderrBytes }) {
  return runOwnedSubprocess({
    command: pythonExecutable,
    args: ["-I", "-S", "-B", analyzerPath, mode],
    cwd: path.dirname(analyzerPath),
    input,
    signal,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    codes: {
      cancelled: "FAIL-PYTHON-AST-CANCELLED",
      timeout: "FAIL-PYTHON-AST-TIMEOUT",
      process: "FAIL-PYTHON-AST-PROCESS",
    },
  });
}

function normalizeProcessOptions(input, { probe = false } = {}) {
  const keys = probe ? ["analyzerPath", "pythonExecutable", "signal", "timeoutMs"] : [
    "analyzerPath", "files", "indexDigest", "limits", "pythonExecutable", "requestId", "signal",
  ];
  assertClosedRecord(input, keys, "input", "FAIL-PYTHON-AST-CONFIG");
  if (typeof input.pythonExecutable !== "string" || input.pythonExecutable.includes("\0") || !path.isAbsolute(input.pythonExecutable)) {
    fail("FAIL-PYTHON-AST-CONFIG", "pythonExecutable must be an explicit absolute NUL-free path");
  }
  const analyzerPath = input.analyzerPath === undefined ? path.join(__dirname, "python-ast.py") : input.analyzerPath;
  if (typeof analyzerPath !== "string" || analyzerPath.includes("\0") || !path.isAbsolute(analyzerPath)) {
    fail("FAIL-PYTHON-AST-CONFIG", "analyzerPath must be an absolute NUL-free path");
  }
  if (!fs.existsSync(analyzerPath) || !fs.statSync(analyzerPath).isFile()) fail("FAIL-PYTHON-AST-CONFIG", "analyzerPath must be an existing regular file");
  if (input.signal !== undefined && !isAbortSignal(input.signal)) fail("FAIL-PYTHON-AST-CONFIG", "signal must be an AbortSignal");
  if (probe) {
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) fail("FAIL-PYTHON-AST-CONFIG", "timeoutMs must be 1..30000");
    return { pythonExecutable: input.pythonExecutable, analyzerPath, signal: input.signal, timeoutMs };
  }
  return { ...input, analyzerPath };
}

async function probePythonAstRuntime(input) {
  const options = normalizeProcessOptions(input, { probe: true });
  let result;
  try {
    result = await runPythonProcess({
      ...options,
      mode: "--probe",
      maxStdoutBytes: 8 * 1024,
      maxStderrBytes: 8 * 1024,
    });
  } catch (error) {
    if (/^FAIL-PYTHON-AST-(?:CANCELLED|TIMEOUT):/.test(error.message)) throw error;
    throw processError("FAIL-PYTHON-AST-RUNTIME", error.message);
  }
  let identity;
  try { identity = JSON.parse(result.stdout.toString("utf8")); } catch { fail("FAIL-PYTHON-AST-RUNTIME", "probe stdout was not one UTF-8 JSON object"); }
  const keys = ["analyzer_version", "grammar_target", "implementation", "parser_runtime", "protocol", "python_version"];
  assertClosedRecord(identity, keys, "probe response", "FAIL-PYTHON-AST-RUNTIME", true);
  if (canonicalJson(identity) !== result.stdout.toString("utf8")) fail("FAIL-PYTHON-AST-RUNTIME", "probe response was not canonical JSON");
  const capability = assessPythonCapability(identity);
  if (identity.protocol !== PYTHON_AST_PROTOCOL_VERSION || identity.analyzer_version !== PYTHON_AST_ANALYZER_VERSION
      || identity.parser_runtime !== PARSER_RUNTIME || identity.implementation !== "cpython"
      || !Array.isArray(identity.grammar_target) || identity.grammar_target.length !== 2
      || identity.grammar_target[0] !== 3 || identity.grammar_target[1] !== 13
      || capability.status !== "available") {
    fail("FAIL-PYTHON-AST-RUNTIME", `probe identity lacks the minimum analyzer capability (${capability.reason_code ?? "IDENTITY_MISMATCH"})`);
  }
  return Object.freeze({ ...identity, grammar_target: Object.freeze([...identity.grammar_target]) });
}

function assertSafeInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("FAIL-PYTHON-AST-PROTOCOL", `${label} must be a safe integer >= ${minimum}`);
}

function assertLocation(value, label) {
  for (const key of ["lineno", "col_offset", "end_lineno", "end_col_offset"]) {
    assertSafeInteger(value[key], `${label}.${key}`, { minimum: key.includes("lineno") ? 1 : 0 });
  }
  if (value.end_lineno < value.lineno || (value.end_lineno === value.lineno && value.end_col_offset < value.col_offset)) {
    fail("FAIL-PYTHON-AST-PROTOCOL", `${label} has an inverted source range`);
  }
}

function validateCallable(value, label) {
  const keys = ["col_offset", "complexity", "end_col_offset", "end_lineno", "kind", "lineno", "qualified_name"];
  assertClosedRecord(value, keys, label, "FAIL-PYTHON-AST-PROTOCOL", true);
  assertLocation(value, label);
  assertSafeInteger(value.complexity, `${label}.complexity`, { minimum: 1 });
  if (!["function", "async-function", "method", "async-method", "nested-function", "nested-async-function"].includes(value.kind)) {
    fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.kind is invalid`);
  }
  if (typeof value.qualified_name !== "string" || value.qualified_name.length === 0 || value.qualified_name.length > 1024 || value.qualified_name.includes("\0")) {
    fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.qualified_name is invalid`);
  }
}

function validateImport(value, label) {
  const keys = ["col_offset", "end_col_offset", "end_lineno", "kind", "level", "lineno", "module", "names"];
  assertClosedRecord(value, keys, label, "FAIL-PYTHON-AST-PROTOCOL", true);
  assertLocation(value, label);
  if (!["import", "from", "dynamic-builtin", "dynamic-importlib"].includes(value.kind)) fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.kind is invalid`);
  assertSafeInteger(value.level, `${label}.level`);
  if (value.module !== null && (typeof value.module !== "string" || value.module.length === 0 || value.module.length > 1024 || value.module.includes("\0"))) {
    fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.module is invalid`);
  }
  if (!Array.isArray(value.names) || value.names.length > 10_000) fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.names is invalid`);
  for (let index = 0; index < value.names.length; index += 1) {
    const alias = value.names[index];
    assertClosedRecord(alias, ["asname", "name"], `${label}.names[${index}]`, "FAIL-PYTHON-AST-PROTOCOL", true);
    if (typeof alias.name !== "string" || alias.name.length === 0 || alias.name.length > 1024 || alias.name.includes("\0")) {
      fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.names[${index}].name is invalid`);
    }
    if (alias.asname !== null && (typeof alias.asname !== "string" || alias.asname.length === 0 || alias.asname.length > 1024 || alias.asname.includes("\0"))) {
      fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.names[${index}].asname is invalid`);
    }
  }
  if ((value.kind === "dynamic-builtin" || value.kind === "dynamic-importlib") && (value.level !== 0 || value.module !== null || value.names.length !== 0)) {
    fail("FAIL-PYTHON-AST-PROTOCOL", `${label} dynamic fact contains static import fields`);
  }
}

function validateError(value, label) {
  const keys = ["code", "col_offset", "end_col_offset", "end_lineno", "lineno", "message"];
  assertClosedRecord(value, keys, label, "FAIL-PYTHON-AST-PROTOCOL", true);
  if (!/^FAIL-PYTHON-AST-PARSE(?:-[A-Z-]+)?$/.test(value.code)) fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.code is invalid`);
  for (const key of ["lineno", "col_offset", "end_lineno", "end_col_offset"]) {
    if (value[key] !== null) assertSafeInteger(value[key], `${label}.${key}`, { minimum: key.includes("lineno") ? 1 : 0 });
  }
  if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 512 || value.message.includes("\0") || /[\r\n]/.test(value.message)) {
    fail("FAIL-PYTHON-AST-PROTOCOL", `${label}.message is invalid`);
  }
}

function compareFactOrder(left, right, finalKey) {
  for (const key of ["lineno", "col_offset", "end_lineno", "end_col_offset"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return stableCompare(left[finalKey], right[finalKey]);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function decodePythonAstResponse(frame, expectations) {
  if (!Buffer.isBuffer(frame)) fail("FAIL-PYTHON-AST-PROTOCOL", "response frame must be a Buffer");
  assertClosedRecord(expectations, ["files", "pythonVersion", "requestId"], "expectations", "FAIL-PYTHON-AST-PROTOCOL", true);
  if (frame.length < 12 || !frame.subarray(0, 8).equals(RESPONSE_MAGIC)) fail("FAIL-PYTHON-AST-PROTOCOL", "response magic is invalid");
  const bodyLength = frame.readUInt32BE(8);
  if (bodyLength === 0 || frame.length !== 12 + bodyLength) fail("FAIL-PYTHON-AST-PROTOCOL", "response length is truncated or has trailing bytes");
  const bodyBytes = frame.subarray(12);
  let response;
  try { response = JSON.parse(bodyBytes.toString("utf8")); } catch { fail("FAIL-PYTHON-AST-PROTOCOL", "response body is not one UTF-8 JSON object"); }
  if (canonicalJson(response) !== bodyBytes.toString("utf8")) fail("FAIL-PYTHON-AST-PROTOCOL", "response body is not canonical JSON");
  const responseKeys = [
    "analyzer_version", "diagnostics", "grammar_target", "parser_runtime", "protocol", "python_version", "request_id", "results", "status",
  ];
  assertClosedRecord(response, responseKeys, "response", "FAIL-PYTHON-AST-PROTOCOL", true);
  if (response.protocol !== PYTHON_AST_PROTOCOL_VERSION || response.analyzer_version !== PYTHON_AST_ANALYZER_VERSION
      || response.parser_runtime !== PARSER_RUNTIME || response.request_id !== expectations.requestId
      || response.python_version !== expectations.pythonVersion
      || !Array.isArray(response.grammar_target) || response.grammar_target.length !== 2
      || response.grammar_target[0] !== 3 || response.grammar_target[1] !== 13) {
    fail("FAIL-PYTHON-AST-PROTOCOL", "response identity does not match the admitted request/runtime");
  }
  if (!["ok", "partial", "error"].includes(response.status)) fail("FAIL-PYTHON-AST-PROTOCOL", "response status is invalid");
  assertClosedRecord(response.diagnostics, ["files_failed", "files_received", "files_succeeded"], "response.diagnostics", "FAIL-PYTHON-AST-PROTOCOL", true);
  for (const key of ["files_failed", "files_received", "files_succeeded"]) assertSafeInteger(response.diagnostics[key], `response.diagnostics.${key}`);
  if (!Array.isArray(expectations.files) || !Array.isArray(response.results) || response.results.length !== expectations.files.length) {
    fail("FAIL-PYTHON-AST-PROTOCOL", "response results do not cover every admitted ordinal");
  }
  let failureCount = 0;
  for (let ordinal = 0; ordinal < response.results.length; ordinal += 1) {
    const expected = expectations.files[ordinal];
    const result = response.results[ordinal];
    if (!expected || expected.ordinal !== ordinal) fail("FAIL-PYTHON-AST-PROTOCOL", "expectation ordinals are not contiguous");
    const commonKeys = ["content_key", "ordinal", "sha256", "status"];
    const keys = result?.status === "ok" ? [...commonKeys, "callables", "imports"] : [...commonKeys, "error"];
    assertClosedRecord(result, keys, `response.results[${ordinal}]`, "FAIL-PYTHON-AST-PROTOCOL", true);
    const expectedSha = crypto.createHash("sha256").update(expected.bytes).digest("hex");
    if (result.ordinal !== ordinal || result.content_key !== expected.contentKey || result.sha256 !== expectedSha) {
      fail("FAIL-PYTHON-AST-PROTOCOL", `response result ${ordinal} does not match the admitted content identity`);
    }
    if (result.status === "ok") {
      if (!Array.isArray(result.callables) || !Array.isArray(result.imports)) fail("FAIL-PYTHON-AST-PROTOCOL", `response result ${ordinal} facts must be arrays`);
      result.callables.forEach((value, index) => validateCallable(value, `response.results[${ordinal}].callables[${index}]`));
      result.imports.forEach((value, index) => validateImport(value, `response.results[${ordinal}].imports[${index}]`));
      for (let index = 1; index < result.callables.length; index += 1) {
        if (compareFactOrder(result.callables[index - 1], result.callables[index], "qualified_name") > 0) fail("FAIL-PYTHON-AST-PROTOCOL", "callables are not canonically sorted");
      }
      for (let index = 1; index < result.imports.length; index += 1) {
        if (compareFactOrder(result.imports[index - 1], result.imports[index], "kind") > 0) fail("FAIL-PYTHON-AST-PROTOCOL", "imports are not canonically sorted");
      }
    } else if (result.status === "error") {
      failureCount += 1;
      validateError(result.error, `response.results[${ordinal}].error`);
    } else {
      fail("FAIL-PYTHON-AST-PROTOCOL", `response result ${ordinal} status is invalid`);
    }
  }
  const expectedStatus = failureCount === 0 ? "ok" : failureCount === response.results.length ? "error" : "partial";
  if (response.status !== expectedStatus || response.diagnostics.files_failed !== failureCount
      || response.diagnostics.files_succeeded !== response.results.length - failureCount
      || response.diagnostics.files_received !== response.results.length) {
    fail("FAIL-PYTHON-AST-PROTOCOL", "response status/diagnostics are inconsistent with results");
  }
  return deepFreeze(response);
}

async function analyzePythonAstBatch(input) {
  const options = normalizeProcessOptions(input);
  const limits = normalizeLimits(input.limits);
  const files = normalizeFiles(input.files, limits);
  const runtime = await probePythonAstRuntime({
    analyzerPath: options.analyzerPath,
    pythonExecutable: options.pythonExecutable,
    signal: options.signal,
    timeoutMs: Math.min(5_000, limits.batchTimeoutMs),
  });
  const frame = encodePythonAstRequest({
    requestId: input.requestId,
    indexDigest: input.indexDigest,
    files,
    limits,
  });
  const result = await runPythonProcess({
    pythonExecutable: options.pythonExecutable,
    analyzerPath: options.analyzerPath,
    mode: "--analyze",
    input: frame,
    signal: options.signal,
    timeoutMs: limits.batchTimeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
  });
  return decodePythonAstResponse(result.stdout, {
    requestId: input.requestId,
    pythonVersion: runtime.python_version,
    files,
  });
}

module.exports = {
  PYTHON_AST_ANALYZER_VERSION,
  PYTHON_AST_PROTOCOL_VERSION,
  PARSER_RUNTIME,
  GRAMMAR_TARGET,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  encodePythonAstRequest,
  probePythonAstRuntime,
  decodePythonAstResponse,
  analyzePythonAstBatch,
};
