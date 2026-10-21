"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runOwnedSubprocess } = require("./subprocess-supervisor");

const TSJS_AST_ANALYZER_VERSION = "sei.tsjs-ast@1";
const TSJS_AST_PROTOCOL_VERSION = "sei.tsjs-ast@1";
const REQUEST_MAGIC = Buffer.from("SEITJA1\0", "ascii");
const RESPONSE_MAGIC = Buffer.from("SEITJR1\0", "ascii");
const SUPPORTED_SYNTAX = Object.freeze(["javascript", "jsx", "typescript", "tsx"]);
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
const FILE_KEYS = Object.freeze(["blobOid", "bytes", "contentKey", "ordinal", "syntax"]);
const MAX_FACTS_PER_FILE = 100_000;
const MAX_STRING = 4096;

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeLimits(input = {}) {
  assertClosedRecord(input, LIMIT_KEYS, "limits", "FAIL-TSJS-AST-CONFIG");
  const result = {};
  for (const key of LIMIT_KEYS) {
    const value = input[key] ?? DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_LIMITS[key]) {
      fail("FAIL-TSJS-AST-CONFIG", `${key} must be a positive safe integer no greater than ${HARD_LIMITS[key]}`);
    }
    result[key] = value;
  }
  if (result.maxFileBytes > result.maxBatchBytes) fail("FAIL-TSJS-AST-CONFIG", "maxFileBytes cannot exceed maxBatchBytes");
  return Object.freeze(result);
}

function validateIdentity(requestId, indexDigest) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    fail("FAIL-TSJS-AST-CONFIG", "requestId must be 1-128 portable identity characters");
  }
  if (typeof indexDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(indexDigest)) {
    fail("FAIL-TSJS-AST-CONFIG", "indexDigest must be a lowercase sha256 identity");
  }
}

function normalizeFiles(files, limits) {
  if (!Array.isArray(files) || files.length === 0) fail("FAIL-TSJS-AST-CONFIG", "files must be a non-empty array");
  if (files.length > limits.maxBatchFiles) fail("FAIL-TSJS-AST-BATCH-LIMIT", `batch contains more than ${limits.maxBatchFiles} files`);
  const sorted = files.map((file, index) => {
    assertClosedRecord(file, FILE_KEYS, `files[${index}]`, "FAIL-TSJS-AST-CONFIG", true);
    if (!Number.isSafeInteger(file.ordinal) || file.ordinal < 0) fail("FAIL-TSJS-AST-CONFIG", `files[${index}].ordinal must be a non-negative safe integer`);
    if (!Buffer.isBuffer(file.bytes)) fail("FAIL-TSJS-AST-CONFIG", `files[${index}].bytes must be a Buffer`);
    if (!SUPPORTED_SYNTAX.includes(file.syntax)) fail("FAIL-TSJS-AST-CONFIG", `files[${index}].syntax is unsupported`);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(file.blobOid ?? "")) fail("FAIL-TSJS-AST-CONFIG", `files[${index}].blobOid is invalid`);
    const algorithm = file.blobOid.length === 40 ? "sha1" : "sha256";
    if (file.contentKey !== `git-blob:${algorithm}:${file.blobOid}`) fail("FAIL-TSJS-AST-CONFIG", `files[${index}].contentKey does not bind blobOid`);
    if (file.bytes.length > limits.maxFileBytes) fail("FAIL-TSJS-AST-FILE-LIMIT", `ordinal ${file.ordinal} exceeds ${limits.maxFileBytes} bytes`);
    return { ...file, bytes: Buffer.from(file.bytes) };
  }).sort((left, right) => left.ordinal - right.ordinal);
  for (let ordinal = 0; ordinal < sorted.length; ordinal += 1) {
    if (sorted[ordinal].ordinal !== ordinal) fail("FAIL-TSJS-AST-CONFIG", "file ordinals must be unique and contiguous from zero");
  }
  const totalBytes = sorted.reduce((sum, file) => sum + file.bytes.length, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBatchBytes) fail("FAIL-TSJS-AST-BATCH-LIMIT", `batch source bytes exceed ${limits.maxBatchBytes}`);
  return sorted;
}

function encodeTsjsAstRequest(input) {
  assertClosedRecord(input, ["files", "indexDigest", "limits", "requestId"], "request", "FAIL-TSJS-AST-CONFIG");
  validateIdentity(input.requestId, input.indexDigest);
  const limits = normalizeLimits(input.limits);
  const files = normalizeFiles(input.files, limits);
  const header = {
    analyzer_version: TSJS_AST_ANALYZER_VERSION,
    files: files.map((file) => ({
      blob_oid: file.blobOid,
      byte_length: file.bytes.length,
      content_key: file.contentKey,
      ordinal: file.ordinal,
      sha256: crypto.createHash("sha256").update(file.bytes).digest("hex"),
      syntax: file.syntax,
    })),
    index_digest: input.indexDigest,
    limits: {
      max_batch_bytes: limits.maxBatchBytes,
      max_batch_files: limits.maxBatchFiles,
      max_file_bytes: limits.maxFileBytes,
    },
    protocol: TSJS_AST_PROTOCOL_VERSION,
    request_id: input.requestId,
  };
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  if (headerBytes.length > 1024 * 1024) fail("FAIL-TSJS-AST-BATCH-LIMIT", "request header exceeds 1 MiB");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBytes.length);
  return Buffer.concat([REQUEST_MAGIC, length, headerBytes, ...files.map((file) => file.bytes)]);
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function runAnalyzerProcess({ nodeExecutable, analyzerPath, typescriptPath, mode, input, signal, timeoutMs, maxStdoutBytes, maxStderrBytes }) {
  return runOwnedSubprocess({
    command: nodeExecutable,
    args: [analyzerPath, mode, typescriptPath ?? ""],
    cwd: path.dirname(analyzerPath),
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    input,
    signal,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    codes: {
      cancelled: "FAIL-TSJS-AST-CANCELLED",
      timeout: "FAIL-TSJS-AST-TIMEOUT",
      process: "FAIL-TSJS-AST-PROCESS",
    },
  });
}

function normalizeProcessOptions(input, { probe = false } = {}) {
  const keys = probe ? ["analyzerPath", "nodeExecutable", "signal", "timeoutMs", "typescriptPath"] : [
    "analyzerPath", "files", "indexDigest", "limits", "nodeExecutable", "requestId", "signal", "typescriptPath",
  ];
  assertClosedRecord(input, keys, "input", "FAIL-TSJS-AST-CONFIG");
  if (typeof input.nodeExecutable !== "string" || input.nodeExecutable.includes("\0") || !path.isAbsolute(input.nodeExecutable)) {
    fail("FAIL-TSJS-AST-CONFIG", "nodeExecutable must be an explicit absolute NUL-free path");
  }
  const analyzerPath = input.analyzerPath === undefined ? path.join(__dirname, "tsjs-analyzer.js") : input.analyzerPath;
  if (typeof analyzerPath !== "string" || analyzerPath.includes("\0") || !path.isAbsolute(analyzerPath)) fail("FAIL-TSJS-AST-CONFIG", "analyzerPath must be an absolute NUL-free path");
  let analyzerStats;
  try { analyzerStats = fs.statSync(analyzerPath); } catch { fail("FAIL-TSJS-AST-CONFIG", "analyzerPath must be an existing regular file"); }
  if (!analyzerStats.isFile()) fail("FAIL-TSJS-AST-CONFIG", "analyzerPath must be an existing regular file");
  if (input.typescriptPath !== undefined && input.typescriptPath !== null
      && (typeof input.typescriptPath !== "string" || input.typescriptPath.includes("\0") || !path.isAbsolute(input.typescriptPath))) {
    fail("FAIL-TSJS-AST-CONFIG", "typescriptPath must be an absolute NUL-free path when supplied");
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) fail("FAIL-TSJS-AST-CONFIG", "signal must be an AbortSignal");
  if (probe) {
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) fail("FAIL-TSJS-AST-CONFIG", "timeoutMs must be 1..30000");
    return { analyzerPath, nodeExecutable: input.nodeExecutable, signal: input.signal, timeoutMs, typescriptPath: input.typescriptPath ?? null };
  }
  return { ...input, analyzerPath, typescriptPath: input.typescriptPath ?? null };
}

function validateRuntime(value, label, { probe = false } = {}) {
  const runtimeKeys = ["analyzer_sha256", "node_version", "script_kinds", "status", "typescript_sha256", "typescript_version"];
  const keys = probe ? [...runtimeKeys, "analyzer_version", "protocol", "reason"] : runtimeKeys;
  assertClosedRecord(value, keys, label, "FAIL-TSJS-AST-RUNTIME", true);
  if (probe && (value.protocol !== TSJS_AST_PROTOCOL_VERSION || value.analyzer_version !== TSJS_AST_ANALYZER_VERSION)) {
    fail("FAIL-TSJS-AST-RUNTIME", "probe protocol identity is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.analyzer_sha256 ?? "") || !/^v\d+\.\d+\.\d+$/.test(value.node_version ?? "")) {
    fail("FAIL-TSJS-AST-RUNTIME", "runtime analyzer/Node identity is invalid");
  }
  if (!Array.isArray(value.script_kinds)) fail("FAIL-TSJS-AST-RUNTIME", "script_kinds must be an array");
  if (value.status === "available") {
    if (probe && value.reason !== null) fail("FAIL-TSJS-AST-RUNTIME", "available probe cannot have a reason");
    if (!/^sha256:[0-9a-f]{64}$/.test(value.typescript_sha256 ?? "") || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(value.typescript_version ?? "")) {
      fail("FAIL-TSJS-AST-RUNTIME", "TypeScript parser identity is invalid");
    }
    if (canonicalJson(value.script_kinds) !== canonicalJson(SUPPORTED_SYNTAX)) fail("FAIL-TSJS-AST-RUNTIME", "script kinds are invalid");
  } else if (value.status === "unavailable") {
    if (value.typescript_sha256 !== null || value.typescript_version !== null || value.script_kinds.length !== 0) fail("FAIL-TSJS-AST-RUNTIME", "unavailable parser has identity fields");
    if (probe && (typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 256)) fail("FAIL-TSJS-AST-RUNTIME", "unavailable probe reason is invalid");
  } else fail("FAIL-TSJS-AST-RUNTIME", "runtime status is invalid");
}

function runtimeFromProbe(identity) {
  return deepFreeze({
    analyzer_sha256: identity.analyzer_sha256,
    node_version: identity.node_version,
    script_kinds: [...identity.script_kinds],
    status: identity.status,
    typescript_sha256: identity.typescript_sha256,
    typescript_version: identity.typescript_version,
  });
}

async function probeTsjsAstRuntime(input) {
  const options = normalizeProcessOptions(input, { probe: true });
  let result;
  try {
    result = await runAnalyzerProcess({ ...options, mode: "--probe", maxStdoutBytes: 16 * 1024, maxStderrBytes: 16 * 1024 });
  } catch (error) {
    if (/^FAIL-TSJS-AST-(?:CANCELLED|TIMEOUT):/.test(error.message)) throw error;
    fail("FAIL-TSJS-AST-RUNTIME", error.message);
  }
  let identity;
  try { identity = JSON.parse(result.stdout.toString("utf8")); } catch { fail("FAIL-TSJS-AST-RUNTIME", "probe stdout was not one UTF-8 JSON object"); }
  if (canonicalJson(identity) !== result.stdout.toString("utf8")) fail("FAIL-TSJS-AST-RUNTIME", "probe response was not canonical JSON");
  validateRuntime(identity, "probe response", { probe: true });
  return deepFreeze({ ...identity, script_kinds: Object.freeze([...identity.script_kinds]) });
}

function assertSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("FAIL-TSJS-AST-PROTOCOL", `${label} must be a safe integer >= ${minimum}`);
}

function assertString(value, label, { nullable = false, maximum = MAX_STRING } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) fail("FAIL-TSJS-AST-PROTOCOL", `${label} is invalid`);
}

function assertLocation(value, label) {
  for (const key of ["lineno", "col_offset", "end_lineno", "end_col_offset"]) {
    assertSafeInteger(value[key], `${label}.${key}`, key.includes("lineno") ? 1 : 0);
  }
  if (value.end_lineno < value.lineno || (value.end_lineno === value.lineno && value.end_col_offset < value.col_offset)) {
    fail("FAIL-TSJS-AST-PROTOCOL", `${label} has an inverted source range`);
  }
}

function validateCallable(value, label) {
  const keys = ["cognitive_complexity", "col_offset", "cyclomatic_complexity", "end_col_offset", "end_lineno", "kind", "lineno", "qualified_name"];
  assertClosedRecord(value, keys, label, "FAIL-TSJS-AST-PROTOCOL", true);
  assertLocation(value, label);
  assertSafeInteger(value.cyclomatic_complexity, `${label}.cyclomatic_complexity`, 1);
  assertSafeInteger(value.cognitive_complexity, `${label}.cognitive_complexity`, 0);
  const kinds = [
    "function", "async-function", "generator-function", "async-generator-function",
    "nested-function", "nested-async-function", "nested-generator-function", "nested-async-generator-function",
    "function-expression", "async-function-expression", "generator-function-expression", "async-generator-function-expression",
    "nested-function-expression", "nested-async-function-expression", "nested-generator-function-expression", "nested-async-generator-function-expression",
    "arrow-function", "async-arrow-function", "method", "async-method", "generator-method", "async-generator-method",
    "constructor", "getter", "setter",
  ];
  if (!kinds.includes(value.kind)) fail("FAIL-TSJS-AST-PROTOCOL", `${label}.kind is invalid`);
  assertString(value.qualified_name, `${label}.qualified_name`, { maximum: 2048 });
}

function validateImportName(value, label) {
  assertClosedRecord(value, ["imported", "local"], label, "FAIL-TSJS-AST-PROTOCOL", true);
  assertString(value.imported, `${label}.imported`);
  assertString(value.local, `${label}.local`);
}

function validateDependency(value, label) {
  const keys = ["col_offset", "end_col_offset", "end_lineno", "kind", "lineno", "module", "names", "type_only"];
  assertClosedRecord(value, keys, label, "FAIL-TSJS-AST-PROTOCOL", true);
  assertLocation(value, label);
  const kinds = ["import", "import-equals-require", "export-from", "export-all-from", "dynamic-import-literal", "dynamic-import-dynamic", "require-literal", "require-dynamic", "import-type", "import-type-dynamic"];
  if (!kinds.includes(value.kind)) fail("FAIL-TSJS-AST-PROTOCOL", `${label}.kind is invalid`);
  assertString(value.module, `${label}.module`, { nullable: true });
  if (!Array.isArray(value.names) || value.names.length > 10_000) fail("FAIL-TSJS-AST-PROTOCOL", `${label}.names is invalid`);
  value.names.forEach((name, index) => validateImportName(name, `${label}.names[${index}]`));
  for (let index = 1; index < value.names.length; index += 1) {
    const prior = value.names[index - 1];
    const current = value.names[index];
    if (stableCompare(prior.imported, current.imported) > 0 || (prior.imported === current.imported && stableCompare(prior.local, current.local) > 0)) {
      fail("FAIL-TSJS-AST-PROTOCOL", `${label}.names is not canonically sorted`);
    }
  }
  if (typeof value.type_only !== "boolean") fail("FAIL-TSJS-AST-PROTOCOL", `${label}.type_only is invalid`);
  const dynamic = ["dynamic-import-dynamic", "require-dynamic", "import-type-dynamic"].includes(value.kind);
  if ((dynamic && value.module !== null) || (!dynamic && value.module === null)) fail("FAIL-TSJS-AST-PROTOCOL", `${label}.module does not match kind`);
}

function validateExport(value, label) {
  const keys = ["col_offset", "end_col_offset", "end_lineno", "kind", "lineno", "local_name", "module", "name", "type_only"];
  assertClosedRecord(value, keys, label, "FAIL-TSJS-AST-PROTOCOL", true);
  assertLocation(value, label);
  if (!["named", "default", "export-all", "export-equals", "commonjs-property", "commonjs-assignment"].includes(value.kind)) fail("FAIL-TSJS-AST-PROTOCOL", `${label}.kind is invalid`);
  assertString(value.name, `${label}.name`, { nullable: true });
  assertString(value.local_name, `${label}.local_name`, { nullable: true });
  assertString(value.module, `${label}.module`, { nullable: true });
  if (typeof value.type_only !== "boolean") fail("FAIL-TSJS-AST-PROTOCOL", `${label}.type_only is invalid`);
}

function validateError(value, label) {
  const keys = ["code", "col_offset", "end_col_offset", "end_lineno", "lineno", "message"];
  assertClosedRecord(value, keys, label, "FAIL-TSJS-AST-PROTOCOL", true);
  if (!/^FAIL-TSJS-AST-(?:PARSER-UNAVAILABLE|PARSE|UNSUPPORTED-SYNTAX|DECODE|ANALYSIS|FACT-LIMIT)$/.test(value.code ?? "")) fail("FAIL-TSJS-AST-PROTOCOL", `${label}.code is invalid`);
  for (const key of ["lineno", "col_offset", "end_lineno", "end_col_offset"]) {
    if (value[key] !== null) assertSafeInteger(value[key], `${label}.${key}`, key.includes("lineno") ? 1 : 0);
  }
  assertString(value.message, `${label}.message`, { maximum: 512 });
  if (/[\r\n]/.test(value.message)) fail("FAIL-TSJS-AST-PROTOCOL", `${label}.message must be one line`);
}

function compareFacts(left, right, finalKeys) {
  for (const key of ["lineno", "col_offset", "end_lineno", "end_col_offset"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  for (const key of finalKeys) {
    const result = stableCompare(left[key] ?? "", right[key] ?? "");
    if (result !== 0) return result;
  }
  return 0;
}

function validateOrderedFacts(values, validate, label, finalKeys) {
  if (!Array.isArray(values) || values.length > MAX_FACTS_PER_FILE) fail("FAIL-TSJS-AST-PROTOCOL", `${label} is invalid`);
  values.forEach((value, index) => validate(value, `${label}[${index}]`));
  for (let index = 1; index < values.length; index += 1) {
    if (compareFacts(values[index - 1], values[index], finalKeys) > 0) fail("FAIL-TSJS-AST-PROTOCOL", `${label} is not canonically sorted`);
  }
}

function decodeTsjsAstResponse(frame, expectations) {
  if (!Buffer.isBuffer(frame)) fail("FAIL-TSJS-AST-PROTOCOL", "response frame must be a Buffer");
  assertClosedRecord(expectations, ["files", "requestId", "runtime"], "expectations", "FAIL-TSJS-AST-PROTOCOL", true);
  if (frame.length < 12 || !frame.subarray(0, 8).equals(RESPONSE_MAGIC)) fail("FAIL-TSJS-AST-PROTOCOL", "response magic is invalid");
  const bodyLength = frame.readUInt32BE(8);
  if (bodyLength === 0 || frame.length !== 12 + bodyLength) fail("FAIL-TSJS-AST-PROTOCOL", "response length is truncated or has trailing bytes");
  const bodyBytes = frame.subarray(12);
  let response;
  try { response = JSON.parse(bodyBytes.toString("utf8")); } catch { fail("FAIL-TSJS-AST-PROTOCOL", "response body is not one UTF-8 JSON object"); }
  if (canonicalJson(response) !== bodyBytes.toString("utf8")) fail("FAIL-TSJS-AST-PROTOCOL", "response body is not canonical JSON");
  assertClosedRecord(response, ["analyzer_version", "diagnostics", "protocol", "request_id", "results", "runtime", "status"], "response", "FAIL-TSJS-AST-PROTOCOL", true);
  if (response.protocol !== TSJS_AST_PROTOCOL_VERSION || response.analyzer_version !== TSJS_AST_ANALYZER_VERSION || response.request_id !== expectations.requestId) {
    fail("FAIL-TSJS-AST-PROTOCOL", "response identity does not match request");
  }
  validateRuntime(response.runtime, "response.runtime");
  if (canonicalJson(response.runtime) !== canonicalJson(expectations.runtime)) fail("FAIL-TSJS-AST-PROTOCOL", "response runtime changed after probe");
  if (!["ok", "partial", "unavailable"].includes(response.status)) fail("FAIL-TSJS-AST-PROTOCOL", "response status is invalid");
  assertClosedRecord(response.diagnostics, ["files_received", "files_succeeded", "files_unavailable"], "response.diagnostics", "FAIL-TSJS-AST-PROTOCOL", true);
  for (const key of ["files_received", "files_succeeded", "files_unavailable"]) assertSafeInteger(response.diagnostics[key], `response.diagnostics.${key}`);
  if (!Array.isArray(expectations.files) || !Array.isArray(response.results) || response.results.length !== expectations.files.length) fail("FAIL-TSJS-AST-PROTOCOL", "response does not cover every admitted file");
  let unavailable = 0;
  for (let ordinal = 0; ordinal < response.results.length; ordinal += 1) {
    const expected = expectations.files[ordinal];
    const result = response.results[ordinal];
    if (!expected || expected.ordinal !== ordinal) fail("FAIL-TSJS-AST-PROTOCOL", "expectation ordinals are invalid");
    const common = ["content_key", "ordinal", "sha256", "status", "syntax"];
    const keys = result?.status === "ok" ? [...common, "callables", "dependencies", "exports"] : [...common, "error"];
    assertClosedRecord(result, keys, `response.results[${ordinal}]`, "FAIL-TSJS-AST-PROTOCOL", true);
    const expectedSha = crypto.createHash("sha256").update(expected.bytes).digest("hex");
    if (result.ordinal !== ordinal || result.content_key !== expected.contentKey || result.sha256 !== expectedSha || result.syntax !== expected.syntax) {
      fail("FAIL-TSJS-AST-PROTOCOL", `response result ${ordinal} does not match admitted content identity`);
    }
    if (result.status === "ok") {
      validateOrderedFacts(result.callables, validateCallable, `response.results[${ordinal}].callables`, ["qualified_name"]);
      validateOrderedFacts(result.dependencies, validateDependency, `response.results[${ordinal}].dependencies`, ["kind", "module"]);
      validateOrderedFacts(result.exports, validateExport, `response.results[${ordinal}].exports`, ["kind", "module", "name"]);
    } else if (result.status === "unavailable") {
      unavailable += 1;
      validateError(result.error, `response.results[${ordinal}].error`);
    } else fail("FAIL-TSJS-AST-PROTOCOL", `response result ${ordinal} status is invalid`);
  }
  const expectedStatus = unavailable === 0 ? "ok" : unavailable === response.results.length ? "unavailable" : "partial";
  if (response.status !== expectedStatus || response.diagnostics.files_received !== response.results.length
      || response.diagnostics.files_unavailable !== unavailable || response.diagnostics.files_succeeded !== response.results.length - unavailable) {
    fail("FAIL-TSJS-AST-PROTOCOL", "response diagnostics/status are inconsistent");
  }
  return deepFreeze(response);
}

async function analyzeTsjsAstBatch(input) {
  const options = normalizeProcessOptions(input);
  const limits = normalizeLimits(input.limits);
  const files = normalizeFiles(input.files, limits);
  const probe = await probeTsjsAstRuntime({
    analyzerPath: options.analyzerPath,
    nodeExecutable: options.nodeExecutable,
    signal: options.signal,
    timeoutMs: Math.min(5_000, limits.batchTimeoutMs),
    typescriptPath: options.typescriptPath,
  });
  const runtime = runtimeFromProbe(probe);
  const frame = encodeTsjsAstRequest({ files, indexDigest: input.indexDigest, limits, requestId: input.requestId });
  const result = await runAnalyzerProcess({
    analyzerPath: options.analyzerPath,
    input: frame,
    maxStderrBytes: limits.maxStderrBytes,
    maxStdoutBytes: limits.maxStdoutBytes,
    mode: "--analyze",
    nodeExecutable: options.nodeExecutable,
    signal: options.signal,
    timeoutMs: limits.batchTimeoutMs,
    typescriptPath: options.typescriptPath,
  });
  return decodeTsjsAstResponse(result.stdout, { files, requestId: input.requestId, runtime });
}

module.exports = {
  TSJS_AST_ANALYZER_VERSION,
  TSJS_AST_PROTOCOL_VERSION,
  SUPPORTED_SYNTAX,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  encodeTsjsAstRequest,
  probeTsjsAstRuntime,
  decodeTsjsAstResponse,
  analyzeTsjsAstBatch,
};
