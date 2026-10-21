"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const {
  PYTHON_AST_ANALYZER_VERSION,
  PYTHON_AST_PROTOCOL_VERSION,
  PARSER_RUNTIME,
  GRAMMAR_TARGET,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  analyzePythonAstBatch,
} = require("./analyzers/python-ast-protocol.js");
const { reduceDependencyTopology } = require("./dependency-topology.js");
const dependencyInvalidation = require("./dependency-invalidation.js");
const dependencyInvalidationPrivate = dependencyInvalidation[Symbol.for("sei.dependency-invalidation.private@1")];

const COLLECTOR_VERSION = "1.0.0";
const PARSE_CACHE_SCHEMA_VERSION = "sei.python-parse-cache@1";
const GRAPH_CACHE_SCHEMA_VERSION = "sei.python-graph-cache@2";
const MODULE_ROOT_POLICY_VERSION = "sei.python-module-roots@1";
const MODULE_RESOLUTION_POLICY_VERSION = "sei.python-import-resolution@1";
const GRAPH_METRIC_CONTRACT_VERSION = "sei.python-dependency-metrics@1";
const MAX_QUEUED_SOURCE_BYTES_DEFAULT = 16 * 1024 * 1024;
const MAX_QUEUED_SOURCE_BYTES_HARD = 64 * 1024 * 1024;
const MAX_CACHE_DIAGNOSTICS = 64;
const MAX_IMPORT_REFS = 256;
const MAX_PROTOCOL_FACTS_PER_FILE = Math.floor(HARD_LIMITS.maxStdoutBytes / 32);
const MAX_PARSE_CACHE_BYTES = HARD_LIMITS.maxStdoutBytes + (64 * 1024);
const MAX_GRAPH_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_ROOTS = 10_000;
const MAX_GRAPH_MODULES = 100_000;
const MAX_GRAPH_EDGES = 1_000_000;
const MAX_GRAPH_IMPORT_OCCURRENCES = 100_000_000;
const MAX_GRAPH_STRING_LENGTH = 65_536;
const MAX_GRAPH_REASON_LENGTH = 65_536;
const SOURCE_MODES = new Set(["100644", "100755"]);
const INPUT_KEYS = new Set(["cache", "configuration", "invalidation", "repositoryIndex", "signal", "taskExecutor"]);
const DEPENDENCY_PARTITION_ID = "python:all";
const DEPENDENCY_ANALYZER_ID = "python-static-intelligence";
const CONFIGURATION_KEYS = new Set([
  "batchTimeoutMs",
  "grammarTarget",
  "maxBatchBytes",
  "maxBatchFiles",
  "maxFileBytes",
  "maxQueuedSourceBytes",
  "maxStderrBytes",
  "maxStdoutBytes",
  "moduleRoots",
  "pythonExecutable",
]);
const PARSE_IN_FLIGHT = new Map();
const GRAPH_IN_FLIGHT = new Map();

const CYCLOMATIC_METRIC_CONTRACT_HASH = sha256(canonicalJson({
  contract: "sei.python-cyclomatic@1",
  decisions: [
    "assert", "async-for", "bool-op-extra-value", "comprehension-filter",
    "comprehension-generator", "except-handler", "for", "if", "if-expression",
    "match-case", "while",
  ],
  nested_named_callables: "separate",
  percentile: "nearest-rank",
}));
const GRAPH_METRIC_CONTRACT_HASH = sha256(canonicalJson({
  contract: GRAPH_METRIC_CONTRACT_VERSION,
  centrality: "unavailable",
  density: "directed-non-self-eight-decimals",
  fan: "unique-non-self-neighbors",
  instability: "fan-out-over-total-eight-decimals",
  scc: "deterministic-tarjan",
}));

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

function assertClosedRecord(value, keys, label, code = "FAIL-STATIC-INTELLIGENCE-CONFIG", exact = false) {
  if (!isRecord(value)) fail(code, `${label} must be a closed record`);
  const allowed = keys instanceof Set ? keys : new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key)).sort(stableCompare);
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

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function bytesSha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function checkCancelled(signal) {
  if (signal?.aborted) fail("FAIL-STATIC-INTELLIGENCE-CANCELLED", "operation was cancelled");
}

function normalizeRoot(value, label) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\")) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", `${label} must be a NUL-free repository-relative POSIX path`);
  }
  const trimmed = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (trimmed === "" || trimmed === ".") return ".";
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)
      || trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", `${label} is not a safe repository-relative path`);
  }
  return trimmed;
}

function positiveBound(value, key, hard) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > hard) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", `${key} must be a positive safe integer no greater than ${hard}`);
  }
  return value;
}

function normalizeConfiguration(value) {
  assertClosedRecord(value, CONFIGURATION_KEYS, "configuration");
  if (typeof value.pythonExecutable !== "string" || value.pythonExecutable.includes("\0") || !path.isAbsolute(value.pythonExecutable)) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "pythonExecutable must be an explicit absolute NUL-free path");
  }
  if (!Array.isArray(value.grammarTarget) || value.grammarTarget.length !== 2
      || value.grammarTarget[0] !== GRAMMAR_TARGET[0] || value.grammarTarget[1] !== GRAMMAR_TARGET[1]) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "grammarTarget must be exactly [3,13]");
  }
  if (!Array.isArray(value.moduleRoots)) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "moduleRoots must be an array; [] selects exact-manifest derivation");
  }
  const roots = value.moduleRoots.map((root, index) => normalizeRoot(root, `moduleRoots[${index}]`)).sort(stableCompare);
  if (new Set(roots).size !== roots.length) fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "moduleRoots must be unique after normalization");
  const limits = {
    maxFileBytes: positiveBound(value.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes, "maxFileBytes", HARD_LIMITS.maxFileBytes),
    maxBatchFiles: positiveBound(value.maxBatchFiles ?? DEFAULT_LIMITS.maxBatchFiles, "maxBatchFiles", HARD_LIMITS.maxBatchFiles),
    maxBatchBytes: positiveBound(value.maxBatchBytes ?? DEFAULT_LIMITS.maxBatchBytes, "maxBatchBytes", HARD_LIMITS.maxBatchBytes),
    maxStdoutBytes: positiveBound(value.maxStdoutBytes ?? DEFAULT_LIMITS.maxStdoutBytes, "maxStdoutBytes", HARD_LIMITS.maxStdoutBytes),
    maxStderrBytes: positiveBound(value.maxStderrBytes ?? DEFAULT_LIMITS.maxStderrBytes, "maxStderrBytes", HARD_LIMITS.maxStderrBytes),
    batchTimeoutMs: positiveBound(value.batchTimeoutMs ?? DEFAULT_LIMITS.batchTimeoutMs, "batchTimeoutMs", HARD_LIMITS.batchTimeoutMs),
  };
  const maxQueuedSourceBytes = positiveBound(
    value.maxQueuedSourceBytes ?? MAX_QUEUED_SOURCE_BYTES_DEFAULT,
    "maxQueuedSourceBytes",
    MAX_QUEUED_SOURCE_BYTES_HARD,
  );
  if (limits.maxFileBytes > limits.maxBatchBytes) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "maxFileBytes cannot exceed maxBatchBytes");
  }
  if (limits.maxBatchBytes > maxQueuedSourceBytes) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "maxBatchBytes cannot exceed maxQueuedSourceBytes");
  }
  return deepFreeze({
    pythonExecutable: value.pythonExecutable,
    grammarTarget: [...GRAMMAR_TARGET],
    moduleRoots: roots,
    maxQueuedSourceBytes,
    limits,
  });
}

function validateRepositoryIndex(index) {
  if (!index || typeof index !== "object" || !isRecord(index.binding) || !Array.isArray(index.entries)
      || typeof index.readBlobs !== "function") {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "repositoryIndex must be a landed immutable RepositoryIndex");
  }
  const binding = index.binding;
  for (const key of ["repository_revision", "index_digest", "classification_policy_version", "classification_policy_hash", "index_key"]) {
    if (typeof binding[key] !== "string" || binding[key].length === 0) {
      fail("FAIL-STATIC-INTELLIGENCE-BINDING", `repositoryIndex.binding.${key} is required`);
    }
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(binding.repository_revision)
      || !/^sha256:[0-9a-f]{64}$/.test(binding.index_digest)) {
    fail("FAIL-STATIC-INTELLIGENCE-BINDING", "repositoryIndex binding identities are invalid");
  }
}

function validateTaskExecutor(executor) {
  if (!executor || typeof executor !== "object" || typeof executor.run !== "function") {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "taskExecutor must expose TaskExecutor.run(tasks,{signal})");
  }
  const groupLimit = executor.groupLimits?.["python-ast"] ?? 1;
  if (!Number.isSafeInteger(groupLimit) || groupLimit <= 0 || groupLimit > 4) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "taskExecutor python-ast concurrency must be between one and four");
  }
}

function validateCache(cache) {
  if (cache === null || cache === undefined) return null;
  if ((typeof cache !== "object" && typeof cache !== "function")
      || typeof cache.read !== "function" || typeof cache.create !== "function") {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "cache must be null or expose read(key,{signal}) and create(key,bytes,{signal})");
  }
  return cache;
}

function validateInvalidationInput(value, currentIndex) {
  if (value === null || value === undefined) return null;
  assertClosedRecord(value, ["ancestry_binding", "prior_snapshot"], "invalidation", "FAIL-STATIC-INTELLIGENCE-INVALIDATION", true);
  let priorSnapshot;
  try {
    dependencyInvalidationPrivate.portableSnapshot(value.prior_snapshot);
    priorSnapshot = value.prior_snapshot;
  } catch (error) {
    fail("FAIL-STATIC-INTELLIGENCE-INVALIDATION", `prior snapshot is invalid: ${boundedMessage(error)}`);
  }
  return deepFreeze({
    ancestry_binding: value.ancestry_binding,
    prior_snapshot: priorSnapshot,
  });
}

function bindingToken(index) {
  const binding = index.binding;
  return canonicalJson({
    classification_policy_hash: binding.classification_policy_hash,
    classification_policy_version: binding.classification_policy_version,
    index_digest: binding.index_digest,
    index_key: binding.index_key,
    repository_revision: binding.repository_revision,
  });
}

function assertLive(index, token, signal) {
  checkCancelled(signal);
  if (bindingToken(index) !== token) {
    fail("FAIL-STATIC-INTELLIGENCE-BINDING", "RepositoryIndex identity changed during analysis");
  }
}

function selectedPythonEntries(index) {
  const counters = {
    indexed_python_source: 0,
    non_vendor_python_source: 0,
    selected_human_python: 0,
    parsed_human_python: 0,
    unparsed_human_python: 0,
    excluded_generated: 0,
    excluded_vendor: 0,
    excluded_unknown_generated: 0,
  };
  const selected = [];
  for (const entry of index.entries) {
    const classifications = entry?.classifications;
    if (!classifications || !SOURCE_MODES.has(entry.mode) || classifications.source !== true) continue;
    if (entry.language !== "python") continue;
    counters.indexed_python_source += 1;
    if (classifications.vendor === "vendor") {
      counters.excluded_vendor += 1;
      continue;
    }
    counters.non_vendor_python_source += 1;
    if (classifications.generated === "generated") {
      counters.excluded_generated += 1;
      continue;
    }
    if (classifications.generated !== "human") {
      counters.excluded_unknown_generated += 1;
      continue;
    }
    counters.selected_human_python += 1;
    selected.push(entry);
  }
  selected.sort((left, right) => stableCompare(left.path, right.path));
  return { selected, counters };
}

function joinRepositoryPath(parent, child) {
  const normalizedChild = normalizeRoot(child, "manifest module root");
  if (normalizedChild === ".") return parent === "" ? "." : parent;
  return parent === "" ? normalizedChild : `${parent}/${normalizedChild}`;
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== null && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === null ? character : quote === character ? null : quote;
      continue;
    }
    if (character === "#" && quote === null) return line.slice(0, index);
  }
  return line;
}

function quotedStrings(value) {
  const output = [];
  const expression = /(["'])([^"'\r\n]+)\1/g;
  for (const match of value.matchAll(expression)) output.push(match[2]);
  return output;
}

function parseManifestRoots(text, projectDirectory) {
  const roots = new Set();
  let section = "";
  let sawSupportedDeclaration = false;
  let sawUnsupportedPackageDeclaration = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const packageDir = /^(?:package-dir|package_dir)\s*=\s*\{(.*)\}\s*$/.exec(line);
    if (packageDir && section.startsWith("tool.setuptools")) {
      const emptyKey = /(?:""|'')\s*=\s*(["'])([^"']+)\1/.exec(packageDir[1]);
      if (emptyKey) {
        roots.add(joinRepositoryPath(projectDirectory, emptyKey[2]));
        sawSupportedDeclaration = true;
      } else {
        sawUnsupportedPackageDeclaration = true;
      }
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1].toLowerCase();
    const value = assignment[2];
    if (key === "where" && section === "tool.setuptools.packages.find") {
      const values = quotedStrings(value);
      if (values.length === 0) sawUnsupportedPackageDeclaration = true;
      for (const root of values) roots.add(joinRepositoryPath(projectDirectory, root));
      sawSupportedDeclaration ||= values.length > 0;
    } else if (key === "packages" && (section.startsWith("tool.hatch.build.targets.") || section.startsWith("tool.setuptools"))) {
      const values = quotedStrings(value);
      if (!value.trim().startsWith("[") || values.length === 0 || /\{/.test(value)) {
        sawUnsupportedPackageDeclaration = true;
        continue;
      }
      for (const packagePath of values) {
        const normalized = normalizeRoot(packagePath.replace(/\./g, "/"), "manifest package path");
        const segments = normalized === "." ? [] : normalized.split("/");
        const base = segments[0] === "src" ? "src" : ".";
        roots.add(joinRepositoryPath(projectDirectory, base));
      }
      sawSupportedDeclaration = true;
    } else if (key === "packages" && section.startsWith("tool.poetry")) {
      sawUnsupportedPackageDeclaration = true;
    }
  }
  return {
    roots: [...roots].sort(stableCompare),
    sawSupportedDeclaration,
    sawUnsupportedPackageDeclaration,
  };
}

function pathWithinRoot(filePath, root) {
  return root === "." || filePath.startsWith(`${root}/`);
}

async function deriveModuleRoots(index, pythonEntries, configuredRoots, configuration, signal, diagnostics) {
  const manifests = index.entries.filter((entry) => (
    SOURCE_MODES.has(entry.mode)
      && entry.classifications?.manifest_kinds?.includes("python-project")
  )).sort((left, right) => stableCompare(left.path, right.path));
  const manifestBindings = [];
  const derived = new Set();
  let unsupportedManifest = false;
  for (const entry of manifests) {
    checkCancelled(signal);
    if (entry.byte_size > configuration.limits.maxFileBytes) {
      unsupportedManifest = true;
      diagnostics.push(`FAIL-STATIC-INTELLIGENCE-MANIFEST-LIMIT:${entry.path}`);
      manifestBindings.push({ path: entry.path, content_key: entry.content_key, sha256: null, status: "limit" });
      continue;
    }
    let bytes;
    try {
      const blobs = await index.readBlobs([entry], {
        max_blob_bytes: configuration.limits.maxFileBytes,
        max_total_bytes: configuration.limits.maxBatchBytes,
        signal,
      });
      bytes = blobs.get(entry.path);
    } catch (error) {
      if (signal?.aborted) checkCancelled(signal);
      unsupportedManifest = true;
      diagnostics.push(`FAIL-STATIC-INTELLIGENCE-MANIFEST-READ:${entry.path}:${boundedMessage(error)}`);
      manifestBindings.push({ path: entry.path, content_key: entry.content_key, sha256: null, status: "read-error" });
      continue;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      unsupportedManifest = true;
      diagnostics.push(`FAIL-STATIC-INTELLIGENCE-MANIFEST-ENCODING:${entry.path}`);
      manifestBindings.push({ path: entry.path, content_key: entry.content_key, sha256: bytesSha256(bytes), status: "encoding-error" });
      continue;
    }
    const projectDirectory = path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path);
    const parsed = parseManifestRoots(text, projectDirectory);
    const scopedPython = pythonEntries.filter((candidate) => (
      projectDirectory === "" || candidate.path.startsWith(`${projectDirectory}/`)
    ));
    if (parsed.sawUnsupportedPackageDeclaration && !parsed.sawSupportedDeclaration) unsupportedManifest = true;
    if (parsed.roots.length > 0) {
      for (const root of parsed.roots) derived.add(root);
    } else if (scopedPython.length > 0) {
      const conventionalSrc = projectDirectory === "" ? "src" : `${projectDirectory}/src`;
      const root = scopedPython.every((candidate) => candidate.path.startsWith(`${conventionalSrc}/`))
        ? conventionalSrc
        : projectDirectory === "" ? "." : projectDirectory;
      derived.add(root);
    }
    manifestBindings.push({
      path: entry.path,
      content_key: entry.content_key,
      sha256: bytesSha256(bytes),
      status: parsed.sawUnsupportedPackageDeclaration && !parsed.sawSupportedDeclaration ? "unsupported" : "parsed",
    });
  }
  if (manifests.length === 0 && pythonEntries.length > 0) {
    derived.add(pythonEntries.every((entry) => entry.path.startsWith("src/")) ? "src" : ".");
  }
  const roots = configuredRoots.length > 0 ? configuredRoots : [...derived].sort(stableCompare);
  for (const root of roots) {
    if (pythonEntries.length > 0 && !pythonEntries.some((entry) => pathWithinRoot(entry.path, root))) {
      fail("FAIL-STATIC-INTELLIGENCE-CONFIG", `module root ${JSON.stringify(root)} is not bound to an indexed supported Python blob`);
    }
  }
  const digest = sha256(canonicalJson({
    manifests: manifestBindings,
    policy: MODULE_ROOT_POLICY_VERSION,
    roots,
  }));
  return deepFreeze({ roots, manifests: manifestBindings, digest, unsupportedManifest });
}

function moduleForEntry(entry, roots) {
  const candidates = [];
  for (const root of roots) {
    if (!pathWithinRoot(entry.path, root)) continue;
    const relative = root === "." ? entry.path : entry.path.slice(root.length + 1);
    if (!relative.endsWith(".py")) continue;
    const segments = relative.slice(0, -3).split("/");
    const packageModule = segments.at(-1) === "__init__";
    if (packageModule) segments.pop();
    if (segments.length === 0 || segments.some((segment) => !/^[A-Za-z_]\w*$/.test(segment))) {
      candidates.push({ root, module_id: null, package: packageModule });
    } else {
      candidates.push({ root, module_id: segments.join("."), package: packageModule });
    }
  }
  const moduleIds = [...new Set(candidates.map((candidate) => candidate.module_id))];
  if (moduleIds.length !== 1 || moduleIds[0] === null) {
    return { status: "unverifiable", candidates };
  }
  return { status: "mapped", root: candidates[0].root, module_id: moduleIds[0], package: candidates[0].package };
}

function bindModules(entries, roots) {
  const files = entries.map((entry) => ({ entry, mapping: moduleForEntry(entry, roots) }));
  const issues = [];
  for (const file of files) {
    if (file.mapping.status !== "mapped") issues.push(`ambiguous-or-invalid-module:${file.entry.path}`);
  }
  const byId = new Map();
  for (const file of files.filter((candidate) => candidate.mapping.status === "mapped")) {
    const prior = byId.get(file.mapping.module_id);
    if (prior) issues.push(`duplicate-module:${file.mapping.module_id}:${prior.entry.path}:${file.entry.path}`);
    else byId.set(file.mapping.module_id, file);
  }
  return { files, byId, issues: issues.sort(stableCompare) };
}

function parseFactKey(contentKey) {
  return sha256(canonicalJson({
    protocol: PYTHON_AST_PROTOCOL_VERSION,
    analyzer_version: PYTHON_AST_ANALYZER_VERSION,
    metric_contract_hash: CYCLOMATIC_METRIC_CONTRACT_HASH,
    parser_identity: "cpython",
    parser_runtime_major_minor: "3.13",
    grammar_target: [...GRAMMAR_TARGET],
    content_key: contentKey,
  }));
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validLocation(value) {
  return ["lineno", "col_offset", "end_lineno", "end_col_offset"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= (key.includes("lineno") ? 1 : 0))
    && (value.end_lineno > value.lineno || (value.end_lineno === value.lineno && value.end_col_offset >= value.col_offset));
}

function validCallable(value) {
  return exactKeys(value, ["col_offset", "complexity", "end_col_offset", "end_lineno", "kind", "lineno", "qualified_name"])
    && validLocation(value)
    && Number.isSafeInteger(value.complexity) && value.complexity >= 1
    && ["function", "async-function", "method", "async-method", "nested-function", "nested-async-function"].includes(value.kind)
    && typeof value.qualified_name === "string" && value.qualified_name.length > 0 && value.qualified_name.length <= 1024
    && !value.qualified_name.includes("\0");
}

function validImport(value) {
  if (!exactKeys(value, ["col_offset", "end_col_offset", "end_lineno", "kind", "level", "lineno", "module", "names"])
      || !validLocation(value) || !["import", "from", "dynamic-builtin", "dynamic-importlib"].includes(value.kind)
      || !Number.isSafeInteger(value.level) || value.level < 0
      || (value.module !== null && (typeof value.module !== "string" || value.module.length === 0
        || value.module.length > 1024 || value.module.includes("\0")))
      || !Array.isArray(value.names) || value.names.length > 10_000) return false;
  if (!value.names.every((alias) => exactKeys(alias, ["asname", "name"])
      && typeof alias.name === "string" && alias.name.length > 0 && alias.name.length <= 1024 && !alias.name.includes("\0")
      && (alias.asname === null || (typeof alias.asname === "string" && alias.asname.length > 0
        && alias.asname.length <= 1024 && !alias.asname.includes("\0"))))) return false;
  return !(value.kind.startsWith("dynamic-") && (value.level !== 0 || value.module !== null || value.names.length !== 0));
}

function compareProtocolFacts(left, right, finalKey) {
  for (const key of ["lineno", "col_offset", "end_lineno", "end_col_offset"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return stableCompare(left[finalKey], right[finalKey]);
}

function isCanonicallyOrdered(values, compare, { strict = false } = {}) {
  for (let index = 1; index < values.length; index += 1) {
    const comparison = compare(values[index - 1], values[index]);
    if (comparison > 0 || (strict && comparison === 0)) return false;
  }
  return true;
}

function artifactBytes(kind, schemaVersion, payload) {
  const body = { kind, schema_version: schemaVersion, payload };
  return Buffer.from(canonicalJson({ artifact_hash: sha256(canonicalJson(body)), ...body }), "utf8");
}

function decodeArtifact(bytes, kind, schemaVersion) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (canonicalJson(value) !== bytes.toString("utf8")
      || !exactKeys(value, ["artifact_hash", "kind", "payload", "schema_version"])
      || value.kind !== kind || value.schema_version !== schemaVersion
      || value.artifact_hash !== sha256(canonicalJson({ kind, schema_version: schemaVersion, payload: value.payload }))) return null;
  return value.payload;
}

function parseArtifact(bytes, expectedContentKey) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PARSE_CACHE_BYTES) return null;
  const payload = decodeArtifact(bytes, "python-parse-fact", PARSE_CACHE_SCHEMA_VERSION);
  if (!payload || !exactKeys(payload, [
    "analyzer_version", "callables", "content_key", "file_sha256", "grammar_target", "imports", "parser_runtime",
  ])) return null;
  if (payload.analyzer_version !== PYTHON_AST_ANALYZER_VERSION || payload.parser_runtime !== PARSER_RUNTIME
      || payload.content_key !== expectedContentKey || !/^[0-9a-f]{64}$/.test(payload.file_sha256)
      || !Array.isArray(payload.grammar_target) || canonicalJson(payload.grammar_target) !== canonicalJson(GRAMMAR_TARGET)
      || !Array.isArray(payload.callables) || payload.callables.length > MAX_PROTOCOL_FACTS_PER_FILE
      || !payload.callables.every(validCallable)
      || !isCanonicallyOrdered(payload.callables, (left, right) => compareProtocolFacts(left, right, "qualified_name"))
      || !Array.isArray(payload.imports) || payload.imports.length > MAX_PROTOCOL_FACTS_PER_FILE
      || !payload.imports.every(validImport)
      || !isCanonicallyOrdered(payload.imports, (left, right) => compareProtocolFacts(left, right, "kind"))) return null;
  return deepFreeze({ status: "ok", ...payload });
}

function parseArtifactPayload(result) {
  return {
    analyzer_version: PYTHON_AST_ANALYZER_VERSION,
    callables: result.callables,
    content_key: result.content_key,
    file_sha256: result.file_sha256,
    grammar_target: [...GRAMMAR_TARGET],
    imports: result.imports,
    parser_runtime: PARSER_RUNTIME,
  };
}

function boundedMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 240);
}

function errorCode(error) {
  if (typeof error?.code === "string") return error.code;
  const match = /\b(FAIL-[A-Z0-9-]+):/.exec(error?.message ?? String(error));
  return match?.[1] ?? "FAIL-STATIC-INTELLIGENCE-ANALYZER";
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Every owned key is rejected together on a fatal run error. Attach a
  // handler immediately so sibling key promises cannot become unhandled while
  // the caller observes the same error through the aggregate await below.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function cacheRead(cache, key, signal, telemetry, expectedContentKey = null) {
  if (cache === null) return null;
  try {
    checkCancelled(signal);
    const bytes = await cache.read(key, { signal });
    checkCancelled(signal);
    if (bytes === null || bytes === undefined) return null;
    const value = expectedContentKey === null
      ? decodeGraphArtifact(bytes, key)
      : parseArtifact(bytes, expectedContentKey);
    if (value === null) {
      telemetry.corrupt += 1;
      if (telemetry.diagnostics.length < MAX_CACHE_DIAGNOSTICS) telemetry.diagnostics.push(`corrupt:${key}`);
      return null;
    }
    return { value, bytes: Buffer.from(bytes) };
  } catch (error) {
    if (signal?.aborted) checkCancelled(signal);
    telemetry.read_errors += 1;
    if (telemetry.diagnostics.length < MAX_CACHE_DIAGNOSTICS) telemetry.diagnostics.push(`read-error:${key}:${boundedMessage(error)}`);
    return null;
  }
}

async function cacheCreate(cache, key, bytes, signal, telemetry, expectedContentKey = null) {
  if (cache === null) return;
  checkCancelled(signal);
  let outcome;
  try {
    outcome = await cache.create(key, Buffer.from(bytes), { signal });
  } catch (error) {
    if (signal?.aborted) checkCancelled(signal);
    telemetry.write_errors += 1;
    if (telemetry.diagnostics.length < MAX_CACHE_DIAGNOSTICS) telemetry.diagnostics.push(`write-error:${key}:${boundedMessage(error)}`);
    return;
  }
  checkCancelled(signal);
  if (outcome === "created") {
    telemetry.writes += 1;
    return;
  }
  if (outcome !== "exists") {
    telemetry.write_errors += 1;
    if (telemetry.diagnostics.length < MAX_CACHE_DIAGNOSTICS) telemetry.diagnostics.push(`write-contract:${key}`);
    return;
  }
  let current;
  try {
    checkCancelled(signal);
    current = await cache.read(key, { signal });
  } catch (error) {
    if (signal?.aborted) checkCancelled(signal);
    telemetry.write_errors += 1;
    if (telemetry.diagnostics.length < MAX_CACHE_DIAGNOSTICS) telemetry.diagnostics.push(`conflict-read-error:${key}:${boundedMessage(error)}`);
    return;
  }
  checkCancelled(signal);
  if (Buffer.isBuffer(current) && current.equals(bytes)) return;
  const valid = expectedContentKey === null ? decodeGraphArtifact(current, key) : parseArtifact(current, expectedContentKey);
  if (valid !== null) fail("FAIL-STATIC-INTELLIGENCE-CACHE-CONFLICT", `valid immutable cache bytes conflict at ${key}`);
  if (telemetry.diagnostics.length < MAX_CACHE_DIAGNOSTICS) telemetry.diagnostics.push(`immutable-corrupt:${key}`);
}

function partitionMisses(items, limits) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const item of items) {
    if (current.length > 0 && (current.length >= limits.maxBatchFiles || bytes + item.entry.byte_size > limits.maxBatchBytes)) {
      batches.push({ items: current, bytes });
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.entry.byte_size;
  }
  if (current.length > 0) batches.push({ items: current, bytes });
  return batches;
}

function partitionWaves(batches, maxQueuedSourceBytes) {
  const waves = [];
  let current = [];
  let bytes = 0;
  for (const batch of batches) {
    if (current.length > 0 && bytes + batch.bytes > maxQueuedSourceBytes) {
      waves.push(current);
      current = [];
      bytes = 0;
    }
    current.push(batch);
    bytes += batch.bytes;
  }
  if (current.length > 0) waves.push(current);
  return waves;
}

function responseFact(result) {
  if (result.status === "ok") {
    return deepFreeze({
      status: "ok",
      analyzer_version: PYTHON_AST_ANALYZER_VERSION,
      parser_runtime: PARSER_RUNTIME,
      grammar_target: [...GRAMMAR_TARGET],
      content_key: result.content_key,
      file_sha256: result.sha256,
      callables: result.callables,
      imports: result.imports,
    });
  }
  return deepFreeze({
    status: "error",
    content_key: result.content_key,
    file_sha256: result.sha256,
    error: {
      ...result.error,
      message: result.error.message.replace(/<sei-blob:\d+>/g, "<sei-blob>"),
    },
  });
}

function batchFailureFact(item, code, message) {
  return deepFreeze({
    status: "error",
    content_key: item.entry.content_key,
    file_sha256: null,
    error: {
      code,
      message: message.slice(0, 240),
      lineno: null,
      col_offset: null,
      end_lineno: null,
      end_col_offset: null,
    },
  });
}

function taskForBatch(batch, batchIndex, index, configuration) {
  const firstPath = batch.items[0].entry.path;
  return {
    id: `python-ast-${batchIndex.toString().padStart(6, "0")}`,
    resourceClass: "external_process",
    deterministicOrderKey: `30:python:${firstPath}`,
    dependencies: [],
    timeoutMs: configuration.limits.batchTimeoutMs + 2_000,
    memoryWeight: Math.max(1, Math.ceil((batch.bytes + configuration.limits.maxStdoutBytes) / (32 * 1024 * 1024))),
    concurrencyGroup: "python-ast",
    run: async ({ signal }) => {
      const entries = batch.items.map((item) => item.entry);
      const blobs = await index.readBlobs(entries, {
        max_blob_bytes: configuration.limits.maxFileBytes,
        max_total_bytes: configuration.limits.maxBatchBytes,
        signal,
      });
      const files = batch.items.map((item, ordinal) => ({
        ordinal,
        contentKey: item.entry.content_key,
        blobOid: item.entry.blob_oid,
        bytes: blobs.get(item.entry.path),
      }));
      return analyzePythonAstBatch({
        pythonExecutable: configuration.pythonExecutable,
        requestId: `static-${index.binding.index_digest.slice(7, 23)}-${batchIndex}`,
        indexDigest: index.binding.index_digest,
        files,
        limits: configuration.limits,
        signal,
      });
    },
  };
}

async function executeMisses(items, context) {
  const { index, taskExecutor, configuration, signal, token, cache, telemetry } = context;
  const facts = new Map();
  const oversized = items.filter((item) => item.entry.byte_size > configuration.limits.maxFileBytes);
  for (const item of oversized) {
    facts.set(item.key, batchFailureFact(item, "FAIL-PYTHON-AST-FILE-LIMIT", `${item.entry.path} exceeds maxFileBytes`));
  }
  const admitted = items.filter((item) => item.entry.byte_size <= configuration.limits.maxFileBytes);
  const batches = partitionMisses(admitted, configuration.limits);
  const waves = partitionWaves(batches, configuration.maxQueuedSourceBytes);
  let batchOffset = 0;
  for (const wave of waves) {
    assertLive(index, token, signal);
    const tasks = wave.map((batch, indexInWave) => taskForBatch(batch, batchOffset + indexInWave, index, configuration));
    const execution = await taskExecutor.run(tasks, { signal });
    telemetry.executor_runs += 1;
    telemetry.tasks_submitted += execution.telemetry?.tasks_submitted ?? tasks.length;
    telemetry.max_in_flight = Math.max(telemetry.max_in_flight, execution.telemetry?.max_in_flight ?? 0);
    telemetry.timeouts += execution.telemetry?.timeouts ?? 0;
    telemetry.cancelled += execution.telemetry?.cancelled ?? 0;
    if (signal?.aborted || execution.status === "cancelled") checkCancelled(signal ?? { aborted: true });
    for (let indexInWave = 0; indexInWave < wave.length; indexInWave += 1) {
      const batch = wave[indexInWave];
      const outcome = execution.results[indexInWave];
      if (outcome?.state === "succeeded") {
        const response = outcome.value;
        for (let ordinal = 0; ordinal < batch.items.length; ordinal += 1) {
          const item = batch.items[ordinal];
          const responseResult = response.results[ordinal];
          if (!responseResult || responseResult.content_key !== item.entry.content_key) {
            fail("FAIL-STATIC-INTELLIGENCE-BINDING", "analyzer result no longer binds the admitted content key");
          }
          facts.set(item.key, responseFact(responseResult));
        }
      } else {
        const code = errorCode(outcome?.error);
        const message = boundedMessage(outcome?.error ?? "analyzer task failed");
        if (code === "FAIL-PYTHON-AST-PROTOCOL") {
          fail("FAIL-STATIC-INTELLIGENCE-BINDING", message);
        }
        for (const item of batch.items) facts.set(item.key, batchFailureFact(item, code, message));
      }
    }
    batchOffset += wave.length;
  }
  assertLive(index, token, signal);
  for (const item of items) {
    const fact = facts.get(item.key);
    if (fact?.status !== "ok") continue;
    const bytes = artifactBytes("python-parse-fact", PARSE_CACHE_SCHEMA_VERSION, parseArtifactPayload(fact));
    await cacheCreate(cache, item.key, bytes, signal, telemetry.parse, item.entry.content_key);
    assertLive(index, token, signal);
  }
  return facts;
}

async function loadParseFacts(entries, context) {
  const uniqueByContent = new Map();
  for (const entry of entries) {
    if (!uniqueByContent.has(entry.content_key)) uniqueByContent.set(entry.content_key, entry);
  }
  const items = [...uniqueByContent.values()].map((entry) => ({ entry, key: parseFactKey(entry.content_key) }));
  const factsByKey = new Map();
  const waiting = [];
  const owned = [];
  for (const item of items) {
    checkCancelled(context.signal);
    const cached = await cacheRead(context.cache, item.key, context.signal, context.telemetry.parse, item.entry.content_key);
    if (cached !== null) {
      context.telemetry.parse.hits += 1;
      factsByKey.set(item.key, cached.value);
      continue;
    }
    context.telemetry.parse.misses += 1;
    const inFlight = context.signal === undefined ? PARSE_IN_FLIGHT.get(item.key) : null;
    if (inFlight) {
      context.telemetry.parse.in_flight_hits += 1;
      waiting.push({ item, promise: inFlight });
      continue;
    }
    const deferred = createDeferred();
    owned.push({ ...item, deferred });
    waiting.push({ item, promise: deferred.promise });
    if (context.signal === undefined) PARSE_IN_FLIGHT.set(item.key, deferred.promise);
  }
  if (owned.length > 0) {
    try {
      const produced = await executeMisses(owned, context);
      for (const item of owned) item.deferred.resolve(produced.get(item.key));
    } catch (error) {
      for (const item of owned) item.deferred.reject(error);
    } finally {
      for (const item of owned) {
        if (PARSE_IN_FLIGHT.get(item.key) === item.deferred.promise) PARSE_IN_FLIGHT.delete(item.key);
      }
    }
  }
  const resolved = await Promise.all(waiting.map(async (item) => ({
    key: item.item.key,
    fact: await item.promise,
  })));
  for (const item of resolved) factsByKey.set(item.key, item.fact);
  const byContent = new Map(items.map((item) => [item.entry.content_key, factsByKey.get(item.key)]));
  return { byContent, parseKeys: new Map(items.map((item) => [item.entry.content_key, item.key])) };
}

function packageForModule(moduleId, packageModule) {
  if (packageModule) return moduleId;
  const separator = moduleId.lastIndexOf(".");
  return separator === -1 ? "" : moduleId.slice(0, separator);
}

function relativeBase(sourceModule, packageModule, level, moduleName) {
  const packageId = packageForModule(sourceModule, packageModule);
  const parts = packageId.length === 0 ? [] : packageId.split(".");
  const removals = level - 1;
  if (removals > parts.length) return null;
  const retained = parts.slice(0, parts.length - removals);
  if (moduleName !== null) retained.push(...moduleName.split("."));
  return retained.length === 0 ? null : retained.join(".");
}

function importReference(pathName, fact, classification, target = null) {
  return {
    path: pathName,
    lineno: fact.lineno,
    col_offset: fact.col_offset,
    kind: fact.kind,
    classification,
    target,
  };
}

function resolveImports(moduleBinding, factsByContent) {
  const modules = new Set(moduleBinding.byId.keys());
  const localTopLevels = new Set([...modules].map((moduleId) => moduleId.split(".")[0]));
  const edgeCounts = new Map();
  const counts = { local: 0, external: 0, unresolved_local_candidate: 0, unsupported_dynamic: 0 };
  const refs = [];
  const addClassification = (file, fact, classification, target = null) => {
    counts[classification] += 1;
    if (refs.length < MAX_IMPORT_REFS) refs.push(importReference(file.entry.path, fact, classification, target));
    if (classification === "local") {
      const identity = canonicalJson([file.mapping.module_id, target]);
      const prior = edgeCounts.get(identity) ?? { source: file.mapping.module_id, target, occurrences: 0 };
      prior.occurrences += 1;
      edgeCounts.set(identity, prior);
    }
  };
  for (const file of moduleBinding.files) {
    if (file.mapping.status !== "mapped") continue;
    const parse = factsByContent.get(file.entry.content_key);
    if (parse?.status !== "ok") continue;
    for (const fact of parse.imports) {
      if (fact.kind === "dynamic-builtin" || fact.kind === "dynamic-importlib") {
        addClassification(file, fact, "unsupported_dynamic");
        continue;
      }
      if (fact.kind === "import") {
        for (const alias of fact.names) {
          if (modules.has(alias.name)) addClassification(file, fact, "local", alias.name);
          else if (localTopLevels.has(alias.name.split(".")[0])) addClassification(file, fact, "unresolved_local_candidate");
          else addClassification(file, fact, "external");
        }
        continue;
      }
      const base = fact.level > 0
        ? relativeBase(file.mapping.module_id, file.mapping.package, fact.level, fact.module)
        : fact.module;
      for (const alias of fact.names) {
        const candidate = base === null ? null : alias.name === "*" ? base : `${base}.${alias.name}`;
        const target = candidate !== null && modules.has(candidate)
          ? candidate
          : base !== null && modules.has(base) ? base : null;
        if (target !== null) {
          addClassification(file, fact, "local", target);
        } else {
          const topLevel = (base ?? candidate ?? "").split(".")[0];
          if (fact.level > 0 || localTopLevels.has(topLevel)) addClassification(file, fact, "unresolved_local_candidate");
          else addClassification(file, fact, "external");
        }
      }
    }
  }
  const edgeOccurrences = [...edgeCounts.values()].sort((left, right) => (
    stableCompare(left.source, right.source) || stableCompare(left.target, right.target)
  ));
  return {
    counts,
    references: refs.sort((left, right) => (
      stableCompare(left.path, right.path) || left.lineno - right.lineno || left.col_offset - right.col_offset
      || stableCompare(left.classification, right.classification) || stableCompare(left.target ?? "", right.target ?? "")
    )),
    edge_occurrences: edgeOccurrences,
    edges: edgeOccurrences.map(({ source, target }) => ({ source, target })),
  };
}

function materializeTopology(moduleBinding, factsByContent, rootBinding) {
  if (rootBinding.unsupportedManifest) {
    return {
      status: "unverifiable",
      reason: "FAIL-STATIC-INTELLIGENCE-MODULE-ROOT: Python package declarations could not be verified",
      roots: rootBinding.roots,
      modules: [],
      imports: { counts: { local: 0, external: 0, unresolved_local_candidate: 0, unsupported_dynamic: 0 }, references: [], edge_occurrences: [], edges: [] },
      partitions: null,
    };
  }
  if (moduleBinding.issues.length > 0) {
    return {
      status: "unverifiable",
      reason: `FAIL-STATIC-INTELLIGENCE-MODULE-BINDING: ${moduleBinding.issues.join(";")}`,
      roots: rootBinding.roots,
      modules: [],
      imports: { counts: { local: 0, external: 0, unresolved_local_candidate: 0, unsupported_dynamic: 0 }, references: [], edge_occurrences: [], edges: [] },
      partitions: null,
    };
  }
  const modules = moduleBinding.files.map((file) => ({
    id: file.mapping.module_id,
    path: file.entry.path,
    package: file.mapping.package,
    test_source: file.entry.classifications.test_source,
    parse_status: factsByContent.get(file.entry.content_key)?.status ?? "error",
  })).sort((left, right) => stableCompare(left.id, right.id));
  if (modules.length === 0) {
    return {
      status: "unavailable",
      reason: "FAIL-STATIC-INTELLIGENCE-NO-PYTHON-MODULES: no supported human Python module was indexed",
      roots: rootBinding.roots,
      modules,
      imports: { counts: { local: 0, external: 0, unresolved_local_candidate: 0, unsupported_dynamic: 0 }, references: [], edge_occurrences: [], edges: [] },
      partitions: null,
    };
  }
  const imports = resolveImports(moduleBinding, factsByContent);
  const allIds = new Set(modules.map((module) => module.id));
  const productionIds = new Set(modules.filter((module) => !module.test_source).map((module) => module.id));
  const allEdges = imports.edges.filter((edge) => allIds.has(edge.source) && allIds.has(edge.target));
  const productionEdges = imports.edges.filter((edge) => productionIds.has(edge.source) && productionIds.has(edge.target));
  const successful = modules.filter((module) => module.parse_status === "ok").length;
  const status = successful === 0 ? "unavailable" : "measured";
  const reason = successful === 0
    ? "FAIL-STATIC-INTELLIGENCE-PARSE: no supported Python module parsed successfully"
    : successful < modules.length
      ? `FAIL-STATIC-INTELLIGENCE-PARTIAL: parsed ${successful} of ${modules.length} supported Python modules`
      : null;
  return {
    status,
    reason,
    roots: rootBinding.roots,
    modules,
    imports,
    partitions: status === "unavailable" ? null : {
      all_python: {
        nodes: [...allIds].sort(stableCompare).map((id) => ({ id })),
        edges: allEdges,
        topology: reduceDependencyTopology({ nodes: [...allIds].map((id) => ({ id })), edges: allEdges }),
      },
      production: {
        nodes: [...productionIds].sort(stableCompare).map((id) => ({ id })),
        edges: productionEdges,
        topology: reduceDependencyTopology({ nodes: [...productionIds].map((id) => ({ id })), edges: productionEdges }),
      },
    },
  };
}

function graphArtifactPayload(graphKey, materialization) {
  return { graph_key: graphKey, materialization };
}

function validBoundedGraphString(value, maximum = MAX_GRAPH_STRING_LENGTH) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function validGraphPath(value, { allowDot = false } = {}) {
  if (!validBoundedGraphString(value) || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  if (allowDot && value === ".") return true;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validGraphRoot(value) {
  return value === "." || validGraphPath(value);
}

function validGraphModuleId(value) {
  return validBoundedGraphString(value)
    && value.split(".").every((segment) => /^[A-Za-z_]\w*$/.test(segment));
}

function graphEdgeCompare(left, right) {
  return stableCompare(left.source, right.source) || stableCompare(left.target, right.target);
}

function graphReferenceCompare(left, right) {
  return stableCompare(left.path, right.path) || left.lineno - right.lineno || left.col_offset - right.col_offset
    || stableCompare(left.classification, right.classification) || stableCompare(left.target ?? "", right.target ?? "");
}

function validateGraphModules(modules, roots) {
  if (!Array.isArray(modules) || modules.length > MAX_GRAPH_MODULES) return false;
  const paths = new Set();
  for (const module of modules) {
    if (!exactKeys(module, ["id", "package", "parse_status", "path", "test_source"])
        || !validGraphModuleId(module.id) || !validGraphPath(module.path) || !module.path.endsWith(".py")
        || typeof module.package !== "boolean" || typeof module.test_source !== "boolean"
        || !["ok", "error"].includes(module.parse_status) || paths.has(module.path)) return false;
    paths.add(module.path);
    const mapping = moduleForEntry({ path: module.path }, roots);
    if (mapping.status !== "mapped" || mapping.module_id !== module.id || mapping.package !== module.package) return false;
  }
  return isCanonicallyOrdered(modules, (left, right) => stableCompare(left.id, right.id), { strict: true });
}

function validateGraphReference(reference, modulesByPath, modulesById) {
  if (!exactKeys(reference, ["classification", "col_offset", "kind", "lineno", "path", "target"])
      || !validGraphPath(reference.path) || !modulesByPath.has(reference.path)
      || modulesByPath.get(reference.path).parse_status !== "ok"
      || !Number.isSafeInteger(reference.lineno) || reference.lineno < 1
      || !Number.isSafeInteger(reference.col_offset) || reference.col_offset < 0
      || !["import", "from", "dynamic-builtin", "dynamic-importlib"].includes(reference.kind)
      || !["local", "external", "unresolved_local_candidate", "unsupported_dynamic"].includes(reference.classification)) return false;
  if (reference.classification === "local") {
    return validGraphModuleId(reference.target) && modulesById.has(reference.target)
      && !reference.kind.startsWith("dynamic-");
  }
  if (reference.target !== null) return false;
  return reference.classification === "unsupported_dynamic"
    ? reference.kind.startsWith("dynamic-")
    : !reference.kind.startsWith("dynamic-");
}

function validateGraphImports(imports, modules) {
  if (!exactKeys(imports, ["counts", "edge_occurrences", "edges", "references"])
      || !exactKeys(imports.counts, ["external", "local", "unresolved_local_candidate", "unsupported_dynamic"])
      || !Array.isArray(imports.edge_occurrences) || imports.edge_occurrences.length > MAX_GRAPH_EDGES
      || !Array.isArray(imports.edges) || imports.edges.length > MAX_GRAPH_EDGES
      || !Array.isArray(imports.references) || imports.references.length > MAX_IMPORT_REFS) return false;
  for (const value of Object.values(imports.counts)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_GRAPH_IMPORT_OCCURRENCES) return false;
  }
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const modulesByPath = new Map(modules.map((module) => [module.path, module]));
  if (!imports.references.every((reference) => validateGraphReference(reference, modulesByPath, modulesById))
      || !isCanonicallyOrdered(imports.references, graphReferenceCompare)) return false;
  const referencedCounts = { local: 0, external: 0, unresolved_local_candidate: 0, unsupported_dynamic: 0 };
  for (const reference of imports.references) referencedCounts[reference.classification] += 1;
  if (Object.keys(referencedCounts).some((key) => referencedCounts[key] > imports.counts[key])) return false;

  let localOccurrences = 0;
  for (const occurrence of imports.edge_occurrences) {
    if (!exactKeys(occurrence, ["occurrences", "source", "target"])
        || !validGraphModuleId(occurrence.source) || !modulesById.has(occurrence.source)
        || !validGraphModuleId(occurrence.target) || !modulesById.has(occurrence.target)
        || !Number.isSafeInteger(occurrence.occurrences) || occurrence.occurrences <= 0
        || occurrence.occurrences > MAX_GRAPH_IMPORT_OCCURRENCES) return false;
    localOccurrences += occurrence.occurrences;
    if (!Number.isSafeInteger(localOccurrences) || localOccurrences > MAX_GRAPH_IMPORT_OCCURRENCES) return false;
  }
  if (!isCanonicallyOrdered(imports.edge_occurrences, graphEdgeCompare, { strict: true })
      || localOccurrences !== imports.counts.local) return false;
  for (const edge of imports.edges) {
    if (!exactKeys(edge, ["source", "target"])
        || !validGraphModuleId(edge.source) || !modulesById.has(edge.source)
        || !validGraphModuleId(edge.target) || !modulesById.has(edge.target)) return false;
  }
  return isCanonicallyOrdered(imports.edges, graphEdgeCompare, { strict: true })
    && canonicalJson(imports.edges) === canonicalJson(imports.edge_occurrences.map(({ source, target }) => ({ source, target })));
}

function validateTopologyPartition(partition, expectedNodes, expectedEdges) {
  if (!exactKeys(partition, ["edges", "nodes", "topology"])
      || !Array.isArray(partition.nodes) || partition.nodes.length > MAX_GRAPH_MODULES
      || !Array.isArray(partition.edges) || partition.edges.length > MAX_GRAPH_EDGES) return false;
  for (const node of partition.nodes) {
    if (!exactKeys(node, ["id"]) || !validGraphModuleId(node.id)) return false;
  }
  if (!isCanonicallyOrdered(partition.nodes, (left, right) => stableCompare(left.id, right.id), { strict: true })) return false;
  for (const edge of partition.edges) {
    if (!exactKeys(edge, ["source", "target"]) || !validGraphModuleId(edge.source) || !validGraphModuleId(edge.target)) return false;
  }
  if (!isCanonicallyOrdered(partition.edges, graphEdgeCompare, { strict: true })
      || canonicalJson(partition.nodes) !== canonicalJson(expectedNodes)
      || canonicalJson(partition.edges) !== canonicalJson(expectedEdges)) return false;
  try {
    const expected = reduceDependencyTopology({ nodes: partition.nodes, edges: partition.edges });
    return canonicalJson(expected) === canonicalJson(partition.topology);
  } catch {
    return false;
  }
}

function graphImportsAreEmpty(imports) {
  return Object.values(imports.counts).every((value) => value === 0)
    && imports.references.length === 0 && imports.edge_occurrences.length === 0 && imports.edges.length === 0;
}

function validateGraphMaterialization(value) {
  if (!exactKeys(value, ["imports", "modules", "partitions", "reason", "roots", "status"])
      || !["measured", "unavailable", "unverifiable"].includes(value.status)
      || (value.reason !== null && (!validBoundedGraphString(value.reason, MAX_GRAPH_REASON_LENGTH) || /[\r\n]/.test(value.reason)))
      || !Array.isArray(value.roots) || value.roots.length > MAX_GRAPH_ROOTS
      || !value.roots.every(validGraphRoot)
      || !isCanonicallyOrdered(value.roots, stableCompare, { strict: true })
      || !validateGraphModules(value.modules, value.roots)
      || !validateGraphImports(value.imports, value.modules)) return false;
  const successful = value.modules.filter((module) => module.parse_status === "ok").length;
  if (value.status === "unverifiable") {
    return value.reason !== null && value.partitions === null && value.modules.length === 0 && graphImportsAreEmpty(value.imports);
  }
  if (value.status === "unavailable") {
    return value.reason !== null && value.partitions === null && successful === 0 && graphImportsAreEmpty(value.imports);
  }
  if (successful === 0 || (successful === value.modules.length ? value.reason !== null : value.reason === null)
      || !exactKeys(value.partitions, ["all_python", "production"])) return false;
  const allIds = new Set(value.modules.map((module) => module.id));
  const productionIds = new Set(value.modules.filter((module) => !module.test_source).map((module) => module.id));
  const allNodes = [...allIds].sort(stableCompare).map((id) => ({ id }));
  const productionNodes = [...productionIds].sort(stableCompare).map((id) => ({ id }));
  const allEdges = value.imports.edges.filter((edge) => allIds.has(edge.source) && allIds.has(edge.target));
  const productionEdges = value.imports.edges.filter((edge) => productionIds.has(edge.source) && productionIds.has(edge.target));
  return validateTopologyPartition(value.partitions.all_python, allNodes, allEdges)
    && validateTopologyPartition(value.partitions.production, productionNodes, productionEdges);
}

function decodeGraphArtifact(bytes, graphKey) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_GRAPH_CACHE_BYTES) return null;
  const payload = decodeArtifact(bytes, "python-graph-materialization", GRAPH_CACHE_SCHEMA_VERSION);
  if (!payload || !exactKeys(payload, ["graph_key", "materialization"]) || payload.graph_key !== graphKey) return null;
  const value = payload.materialization;
  if (!validateGraphMaterialization(value)) return null;
  return deepFreeze(value);
}

function graphPathParsePairs(moduleBinding, parseKeys, factsByContent) {
  return moduleBinding.files.map((file) => {
    const parse = factsByContent.get(file.entry.content_key);
    return {
      path: file.entry.path,
      entry_key: file.entry.entry_key,
      parse_fact_key: parseKeys.get(file.entry.content_key),
      parse_status: parse?.status ?? "error",
      parse_error: parse?.status === "error" ? parse.error.code : null,
    };
  }).sort((left, right) => stableCompare(left.path, right.path));
}

function graphCacheKey(index, configurationHash, rootBinding, moduleBinding, parseKeys, factsByContent) {
  const pairs = graphPathParsePairs(moduleBinding, parseKeys, factsByContent);
  return sha256(canonicalJson({
    materialization_contract: "python-graph-materialization@2",
    analyzer_version: PYTHON_AST_ANALYZER_VERSION,
    protocol_version: PYTHON_AST_PROTOCOL_VERSION,
    parser_runtime: PARSER_RUNTIME,
    grammar_target: GRAMMAR_TARGET,
    configuration_hash: configurationHash,
    classification_policy_version: index.binding.classification_policy_version,
    module_root_manifest_digest: rootBinding.digest,
    module_resolution_policy_version: MODULE_RESOLUTION_POLICY_VERSION,
    graph_metric_contract_hash: GRAPH_METRIC_CONTRACT_HASH,
    sorted_path_parse_fact_pairs: pairs,
  }));
}

function graphEvidenceKey(index, configurationHash, rootBinding, moduleBinding, parseKeys, factsByContent) {
  return sha256(canonicalJson({
    repository_id: `git-commit:${index.binding.repository_revision}`,
    repository_revision: index.binding.repository_revision,
    index_digest: index.binding.index_digest,
    configuration_hash: configurationHash,
    classification_policy_version: index.binding.classification_policy_version,
    module_root_manifest_digest: rootBinding.digest,
    module_resolution_policy_version: MODULE_RESOLUTION_POLICY_VERSION,
    graph_metric_contract_hash: GRAPH_METRIC_CONTRACT_HASH,
    sorted_path_parse_fact_pairs: graphPathParsePairs(moduleBinding, parseKeys, factsByContent),
  }));
}

function dependencyInvalidationSnapshot(index, configurationHash, selected, topology, parseKeys, graphKeyValue) {
  const entryByPath = new Map(selected.map((entry) => [entry.path, entry]));
  const nodes = topology.modules.map((module) => {
    const entry = entryByPath.get(module.path);
    if (!entry) fail("FAIL-STATIC-INTELLIGENCE-INVALIDATION", `topology module ${module.path} is not selected`);
    return {
      node_id: module.id,
      path: module.path,
      content_key: entry.content_key,
      language: "python",
    };
  }).sort((left, right) => stableCompare(left.node_id, right.node_id));
  const nodeByPath = new Map(nodes.map((node) => [node.path, node]));
  const records = [];
  for (const entry of selected) {
    const parseKey = parseKeys.get(entry.content_key);
    if (!/^sha256:[0-9a-f]{64}$/.test(parseKey ?? "")) {
      fail("FAIL-STATIC-INTELLIGENCE-INVALIDATION", `parse identity is missing for ${entry.path}`);
    }
    records.push({
      record_id: `parse:${entry.path}`,
      cache_key: parseKey,
      scope: "path",
      partition_id: DEPENDENCY_PARTITION_ID,
      path: entry.path,
      node_id: null,
      content_key: entry.content_key,
    });
    const node = nodeByPath.get(entry.path);
    if (node) records.push({
      record_id: `node:${node.node_id}`,
      cache_key: parseKey,
      scope: "node",
      partition_id: DEPENDENCY_PARTITION_ID,
      path: entry.path,
      node_id: node.node_id,
      content_key: entry.content_key,
    });
  }
  records.push({
    record_id: `graph:${DEPENDENCY_PARTITION_ID}`,
    cache_key: graphKeyValue,
    scope: "partition",
    partition_id: DEPENDENCY_PARTITION_ID,
    path: null,
    node_id: null,
    content_key: null,
  });
  records.sort((left, right) => stableCompare(left.record_id, right.record_id));
  const partitionStatus = topology.status === "measured"
    ? (topology.reason === null ? "available" : "degraded")
    : topology.status;
  const snapshot = deepFreeze({
    repositoryIndex: index,
    dependencyFacts: {
      schema_version: "sei.normalized-dependency-facts@1",
      repository_revision: index.binding.repository_revision,
      index_digest: index.binding.index_digest,
      partitions: [{
        partition_id: DEPENDENCY_PARTITION_ID,
        producer_analyzer_ids: [DEPENDENCY_ANALYZER_ID],
        status: partitionStatus,
        nodes,
        edges: topology.imports.edges.map((edge) => ({
          source_node_id: edge.source,
          target_node_id: edge.target,
          kind: "python-import",
          certainty: "exact",
        })).sort((left, right) => stableCompare(left.source_node_id, right.source_node_id)
          || stableCompare(left.target_node_id, right.target_node_id)),
        aggregate_cache_keys: [graphKeyValue],
      }],
    },
    analyzers: [{
      analyzer_id: DEPENDENCY_ANALYZER_ID,
      analyzer_identity: PYTHON_AST_ANALYZER_VERSION,
      analyzer_version: PYTHON_AST_ANALYZER_VERSION,
      configuration_hash: configurationHash,
      records,
    }],
  });
  dependencyInvalidationPrivate.portableSnapshot(snapshot);
  return snapshot;
}

function projectUnchangedDependencySnapshot(index, configurationHash, selected, parseKeys, graphKeyValue, invalidationInput) {
  if (invalidationInput === null) return null;
  const prior = invalidationInput.prior_snapshot;
  const analyzer = prior.analyzers.find((candidate) => candidate.analyzer_id === DEPENDENCY_ANALYZER_ID);
  const partition = prior.dependencyFacts.partitions.find((candidate) => candidate.partition_id === DEPENDENCY_PARTITION_ID);
  if (!analyzer || !partition
      || analyzer.analyzer_identity !== PYTHON_AST_ANALYZER_VERSION
      || analyzer.analyzer_version !== PYTHON_AST_ANALYZER_VERSION
      || analyzer.configuration_hash !== configurationHash
      || !partition.aggregate_cache_keys.includes(graphKeyValue)) return null;
  const priorParseByPath = new Map(analyzer.records
    .filter((record) => record.scope === "path")
    .map((record) => [record.path, record]));
  if (priorParseByPath.size !== selected.length) return null;
  for (const entry of selected) {
    const priorRecord = priorParseByPath.get(entry.path);
    if (!priorRecord || priorRecord.content_key !== entry.content_key
        || priorRecord.cache_key !== parseKeys.get(entry.content_key)) return null;
  }
  const snapshot = deepFreeze({
    repositoryIndex: index,
    dependencyFacts: {
      schema_version: "sei.normalized-dependency-facts@1",
      repository_revision: index.binding.repository_revision,
      index_digest: index.binding.index_digest,
      partitions: [partition],
    },
    analyzers: [analyzer],
  });
  dependencyInvalidationPrivate.portableSnapshot(snapshot);
  return snapshot;
}

function dependencyInvalidationPlan(currentSnapshot, invalidationInput) {
  if (invalidationInput === null) return null;
  return dependencyInvalidation.planDependencyInvalidation({
    prior: invalidationInput.prior_snapshot,
    current: currentSnapshot,
    ancestryBinding: invalidationInput.ancestry_binding,
  });
}

function invalidationReceipt(plan, currentSnapshot) {
  if (plan === null) {
    return deepFreeze({
      mode: "cold",
      status: "unavailable",
      reason: "no validated prior dependency state",
      plan_digest: null,
      ancestry_relationship: null,
      prior_repository_revision: null,
      current_repository_revision: currentSnapshot.repositoryIndex.binding.repository_revision,
      changed_path_count: 0,
      affected_node_count: 0,
      directly_invalidated_record_count: 0,
      dependency_invalidated_record_count: 0,
      reusable_record_count: 0,
      topology_recompute: true,
    });
  }
  const topologyRecompute = plan.topology_aggregates_requiring_recompute.length > 0;
  const changedPathCount = plan.path_changes.added.length + plan.path_changes.changed.length
    + plan.path_changes.deleted.length + plan.path_changes.renamed.length
    + plan.path_changes.uncertain_renames.length;
  return deepFreeze({
    mode: topologyRecompute ? "recompute" : "reuse",
    status: plan.status,
    reason: topologyRecompute ? "dependency closure requires recomputation" : "validated dependency state admits reuse",
    plan_digest: plan.plan_digest,
    ancestry_relationship: plan.ancestry.relationship,
    prior_repository_revision: plan.bindings.prior.repository_revision,
    current_repository_revision: plan.bindings.current.repository_revision,
    changed_path_count: changedPathCount,
    affected_node_count: plan.affected_dependency_nodes.length,
    directly_invalidated_record_count: plan.directly_invalidated_analyzer_records.length,
    dependency_invalidated_record_count: plan.affected_dependency_analyzer_records.length,
    reusable_record_count: plan.unaffected_reusable_analyzer_records.length,
    topology_recompute: topologyRecompute,
  });
}

async function recomputeGraphWithoutReuse(key, materialization, context) {
  const { cache, signal, telemetry, index, token } = context;
  telemetry.graph.misses += 1;
  assertLive(index, token, signal);
  const bytes = artifactBytes(
    "python-graph-materialization",
    GRAPH_CACHE_SCHEMA_VERSION,
    graphArtifactPayload(key, materialization),
  );
  await cacheCreate(cache, key, bytes, signal, telemetry.graph, null);
  assertLive(index, token, signal);
  return materialization;
}

async function graphWithCache(key, context, compute) {
  const { cache, signal, telemetry, index, token } = context;
  const cached = await cacheRead(cache, key, signal, telemetry.graph, null);
  if (cached !== null) {
    telemetry.graph.hits += 1;
    return cached.value;
  }
  telemetry.graph.misses += 1;
  const materialization = deepFreeze(compute());
  assertLive(index, token, signal);
  const bytes = artifactBytes(
    "python-graph-materialization",
    GRAPH_CACHE_SCHEMA_VERSION,
    graphArtifactPayload(key, materialization),
  );
  await cacheCreate(cache, key, bytes, signal, telemetry.graph, null);
  assertLive(index, token, signal);
  return materialization;
}

async function loadGraph(key, context, compute) {
  if (context.signal !== undefined) return graphWithCache(key, context, compute);
  const existing = GRAPH_IN_FLIGHT.get(key);
  if (existing) {
    context.telemetry.graph.in_flight_hits += 1;
    return existing;
  }
  const promise = graphWithCache(key, context, compute);
  GRAPH_IN_FLIGHT.set(key, promise);
  try {
    return await promise;
  } finally {
    if (GRAPH_IN_FLIGHT.get(key) === promise) GRAPH_IN_FLIGHT.delete(key);
  }
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function complexityPartition(files) {
  const successfulFiles = files.filter((file) => file.parse_status === "ok");
  const callableValues = successfulFiles.flatMap((file) => file.callables.map((callable) => callable.complexity));
  const completeness = files.length === 0 ? 0 : Number((successfulFiles.length / files.length).toFixed(8));
  const status = successfulFiles.length === 0 || callableValues.length === 0 ? "unavailable" : "measured";
  const reason = successfulFiles.length === 0
    ? "FAIL-STATIC-INTELLIGENCE-PARSE: no supported human Python file parsed successfully"
    : callableValues.length === 0
      ? "FAIL-STATIC-INTELLIGENCE-NO-CALLABLES: no supported named callable was present in successfully parsed Python files"
      : completeness < 1
        ? `FAIL-STATIC-INTELLIGENCE-PARTIAL: Python analyzer parsed ${successfulFiles.length} of ${files.length} supported human Python files`
        : null;
  return {
    status,
    reason,
    completeness,
    aggregate: {
      parsed_file_count: successfulFiles.length,
      supported_file_count: files.length,
      callable_count: callableValues.length,
      complexity_sum: callableValues.reduce((sum, value) => sum + value, 0),
      complexity_p50: nearestRank(callableValues, 0.5),
      complexity_p90: nearestRank(callableValues, 0.9),
      complexity_max: callableValues.length === 0 ? null : Math.max(...callableValues),
    },
  };
}

function complexityFacts(entries, factsByContent, counters) {
  const files = entries.map((entry) => {
    const fact = factsByContent.get(entry.content_key);
    if (fact?.status !== "ok") {
      return {
        path: entry.path,
        content_key: entry.content_key,
        parse_status: "error",
        error: fact?.error ?? { code: "FAIL-STATIC-INTELLIGENCE-PARSE", message: "parse fact missing" },
        callable_count: null,
        complexity_sum: null,
        complexity_max: null,
        callables: [],
        test_source: entry.classifications.test_source,
      };
    }
    const values = fact.callables.map((callable) => callable.complexity);
    return {
      path: entry.path,
      content_key: entry.content_key,
      parse_status: "ok",
      error: null,
      callable_count: values.length,
      complexity_sum: values.reduce((sum, value) => sum + value, 0),
      complexity_max: values.length === 0 ? 0 : Math.max(...values),
      callables: fact.callables,
      test_source: entry.classifications.test_source,
    };
  });
  const successfulFiles = files.filter((file) => file.parse_status === "ok");
  counters.parsed_human_python = successfulFiles.length;
  counters.unparsed_human_python = files.length - successfulFiles.length;
  const denominator = counters.non_vendor_python_source;
  const completeness = denominator === 0 ? 0 : Number((successfulFiles.length / denominator).toFixed(8));
  const allPython = complexityPartition(files);
  const production = complexityPartition(files.filter((file) => !file.test_source));
  const omissions = [
    counters.unparsed_human_python > 0 ? `${counters.unparsed_human_python} human Python file(s) did not parse` : null,
    counters.excluded_generated > 0 ? `${counters.excluded_generated} generated Python file(s) were excluded` : null,
    counters.excluded_unknown_generated > 0 ? `${counters.excluded_unknown_generated} Python file(s) had unknown generated classification` : null,
  ].filter((value) => value !== null);
  return {
    status: successfulFiles.length === 0 ? "unavailable" : "measured",
    reason: successfulFiles.length === 0
      ? "FAIL-STATIC-INTELLIGENCE-PARSE: no supported human Python file parsed successfully"
      : completeness < 1
        ? `FAIL-STATIC-INTELLIGENCE-PARTIAL: Python analyzer parsed ${successfulFiles.length} of ${denominator} non-vendor Python source files; ${omissions.join("; ")}`
        : null,
    completeness,
    files,
    aggregate: allPython.aggregate,
    partitions: {
      all_python: allPython,
      production,
    },
  };
}

function metricRecord(index, configurationHash, graphKeyValue, options) {
  const measured = options.status === "measured" || options.status === "inferred";
  const artifactRefs = [...new Set([
    `repository-index:${index.binding.index_digest}`,
    `python-analyzer:${PYTHON_AST_ANALYZER_VERSION}`,
    `python-configuration:${configurationHash}`,
    `python-grammar:${GRAMMAR_TARGET.join(".")}`,
    `python-runtime:${PARSER_RUNTIME}`,
    ...(graphKeyValue === null ? [] : [`python-graph:${graphKeyValue}`]),
    ...(options.artifactRefs ?? []),
  ])].sort(stableCompare);
  return {
    metric_id: options.metricId,
    definition_id: options.definitionId,
    family: options.family,
    subject: options.subject ?? "repository:committed-index",
    repository_revision: index.binding.repository_revision,
    value: measured ? options.value : null,
    unit: options.unit,
    measurement: {
      status: options.status,
      completeness: options.completeness ?? (measured ? 1 : 0),
      confidence: options.confidence ?? (measured ? 1 : 0),
      reason: options.reason ?? null,
    },
    source: {
      kind: "exact-git-python-ast",
      collector_id: "python-static-intelligence",
      collector_version: COLLECTOR_VERSION,
      repository_revision: index.binding.repository_revision,
      command: null,
      artifact_refs: artifactRefs,
      evidence_refs: artifactRefs,
    },
    scope: {
      kind: options.scopeKind ?? "repository",
      path: options.scopePath ?? ".",
      language: "python",
      generated_code: false,
      included_in_human_maintainability: true,
    },
    window: { kind: "revision", start: null, end: index.binding.repository_revision },
    analyzer_identity: PYTHON_AST_ANALYZER_VERSION,
    analyzer_version: PYTHON_AST_ANALYZER_VERSION,
    comparability: {
      analyzer_identity: PYTHON_AST_ANALYZER_VERSION,
      analyzer_version: PYTHON_AST_ANALYZER_VERSION,
      configuration_hash: configurationHash,
      compatible_with_prior: false,
      reason: "no prior analyzer-bound measurement was supplied",
    },
  };
}

function unavailableTopologyMetricStatus(topology, metricKind) {
  if (topology.status === "unverifiable") return "unverifiable";
  if (topology.status === "unavailable") return "unavailable";
  if (metricKind === "centrality") return "unavailable";
  return "measured";
}

function buildMetrics(index, configurationHash, graphKeyValue, complexity, topology) {
  const metrics = [];
  const allPythonComplexity = complexity.partitions.all_python;
  const commonComplexity = {
    family: "structural_complexity",
    status: allPythonComplexity.status,
    completeness: complexity.completeness,
    confidence: allPythonComplexity.status === "measured" ? complexity.completeness : 0,
    reason: allPythonComplexity.status === "measured" ? complexity.reason : allPythonComplexity.reason,
  };
  for (const [metricId, definitionId, value, unit] of [
    ["static.cyclomatic_complexity", "sei.static.cyclomatic_complexity@1", complexity.aggregate.complexity_sum, "cyclomatic-complexity-points"],
    ["static.cyclomatic_callable_count", "sei.static.cyclomatic_callable_count@1", complexity.aggregate.callable_count, "callables"],
    ["static.cyclomatic_complexity_p50", "sei.static.cyclomatic_complexity_p50@1", complexity.aggregate.complexity_p50, "cyclomatic-complexity-points"],
    ["static.cyclomatic_complexity_p90", "sei.static.cyclomatic_complexity_p90@1", complexity.aggregate.complexity_p90, "cyclomatic-complexity-points"],
    ["static.cyclomatic_complexity_max", "sei.static.cyclomatic_complexity_max@1", complexity.aggregate.complexity_max, "cyclomatic-complexity-points"],
  ]) {
    metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
      ...commonComplexity,
      metricId,
      definitionId,
      value,
      unit,
    }));
  }
  for (const [partitionId, partition] of [
    ["production", complexity.partitions.production],
    ["all-python", complexity.partitions.all_python],
  ]) {
    const partitionCommon = {
      family: "structural_complexity",
      status: partition.status,
      completeness: partition.status === "measured" ? partition.completeness : 0,
      confidence: partition.status === "measured" ? partition.completeness : 0,
      reason: partition.reason,
      artifactRefs: [`python-partition:${partitionId}`],
    };
    for (const [metricId, definitionId, value, unit] of [
      ["static.python.cyclomatic_callable_count", "sei.static.python.cyclomatic_callable_count@1", partition.aggregate.callable_count, "callables"],
      ["static.python.cyclomatic_complexity", "sei.static.python.cyclomatic_complexity@1", partition.aggregate.complexity_sum, "cyclomatic-complexity-points"],
      ["static.python.cyclomatic_complexity_p50", "sei.static.python.cyclomatic_complexity_p50@1", partition.aggregate.complexity_p50, "cyclomatic-complexity-points"],
      ["static.python.cyclomatic_complexity_p90", "sei.static.python.cyclomatic_complexity_p90@1", partition.aggregate.complexity_p90, "cyclomatic-complexity-points"],
      ["static.python.cyclomatic_complexity_max", "sei.static.python.cyclomatic_complexity_max@1", partition.aggregate.complexity_max, "cyclomatic-complexity-points"],
    ]) {
      metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
        ...partitionCommon,
        metricId: `${metricId}:${partitionId}`,
        definitionId,
        value,
        unit,
      }));
    }
    for (const [metricId, definitionId, value] of [
      ["static.python.file_count", "sei.static.python.file_count@1", partition.aggregate.supported_file_count],
      ["static.python.parsed_file_count", "sei.static.python.parsed_file_count@1", partition.aggregate.parsed_file_count],
    ]) {
      const inventoryStatus = partition.aggregate.parsed_file_count === 0 ? "unavailable" : "measured";
      metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
        metricId: `${metricId}:${partitionId}`,
        definitionId,
        family: "structural_complexity",
        value,
        unit: "files",
        status: inventoryStatus,
        completeness: inventoryStatus === "measured" ? partition.completeness : 0,
        confidence: inventoryStatus === "measured" ? partition.completeness : 0,
        reason: inventoryStatus === "measured" ? partition.reason : partition.reason,
        artifactRefs: [`python-partition:${partitionId}`],
      }));
    }
  }
  for (const file of complexity.files) {
    const status = file.parse_status === "ok" ? "measured" : "unavailable";
    const reason = status === "measured" ? null : `${file.error.code}: ${file.error.message}`.slice(0, 240);
    for (const [suffix, definitionId, value] of [
      ["", "sei.static.cyclomatic_complexity@1", file.complexity_sum],
      [".max", "sei.static.cyclomatic_complexity_max@1", file.complexity_max],
    ]) {
      metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
        metricId: `static.cyclomatic_complexity${suffix}:${file.path}`,
        definitionId,
        family: "structural_complexity",
        value,
        unit: "cyclomatic-complexity-points",
        status,
        completeness: status === "measured" ? 1 : 0,
        confidence: status === "measured" ? 1 : 0,
        reason,
        subject: `file:${file.path}`,
        scopeKind: "file",
        scopePath: file.path,
        artifactRefs: [file.path, file.content_key, `python-partition:${file.test_source ? "test" : "production"}`],
      }));
    }
    if (file.parse_status !== "ok") continue;
    for (const callable of file.callables) {
      const callableIdentity = `python-callable:${file.path}#${callable.qualified_name}@${callable.lineno}:${callable.col_offset}-${callable.end_lineno}:${callable.end_col_offset}`;
      metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
        metricId: `static.python.cyclomatic_callable:${file.path}:${callable.lineno}:${callable.col_offset}:${callable.end_lineno}:${callable.end_col_offset}:${callable.qualified_name}`,
        definitionId: "sei.static.python.cyclomatic_callable@1",
        family: "structural_complexity",
        value: callable.complexity,
        unit: "cyclomatic-complexity-points",
        status: "measured",
        completeness: 1,
        confidence: 1,
        reason: null,
        subject: callableIdentity,
        scopeKind: "file",
        scopePath: file.path,
        artifactRefs: [
          file.path,
          file.content_key,
          callableIdentity,
          `python-partition:${file.test_source ? "test" : "production"}`,
        ],
      }));
    }
  }
  const moduleById = new Map(topology.modules.map((module) => [module.id, module]));
  const moduleByPath = new Map(topology.modules.map((module) => [module.path, module]));
  for (const [partitionId, partition] of [
    ["production", topology.partitions?.production ?? null],
    ["all-python", topology.partitions?.all_python ?? null],
  ]) {
    const aggregate = partition?.topology?.aggregates ?? null;
    const partitionModules = partition === null ? [] : partition.nodes.map((node) => moduleById.get(node.id)).filter(Boolean);
    const topologyCompleteness = partitionModules.length === 0
      ? (topology.status === "measured" ? 1 : 0)
      : Number((partitionModules.filter((module) => module.parse_status === "ok").length / partitionModules.length).toFixed(8));
    const aggregateStatus = unavailableTopologyMetricStatus(topology, "supported");
    for (const [name, value, unit] of [
      ["node_count", aggregate?.node_count, "count"],
      ["edge_count", aggregate?.edge_count, "count"],
      ["scc_count", aggregate?.scc_count, "count"],
      ["cyclic_scc_count", aggregate?.cyclic_scc_count, "count"],
      ["cyclic_node_count", aggregate?.cyclic_node_count, "count"],
      ["fan_in_max", aggregate?.max_fan_in, "count"],
      ["fan_out_max", aggregate?.max_fan_out, "count"],
    ]) {
      metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
        metricId: `static.python.dependency.${name}:${partitionId}`,
        definitionId: `sei.static.python.dependency.${name}@1`,
        family: "dependency_topology",
        value,
        unit,
        status: aggregateStatus,
        completeness: aggregateStatus === "measured" ? topologyCompleteness : 0,
        confidence: aggregateStatus === "measured" ? topologyCompleteness : 0,
        reason: topology.reason,
        artifactRefs: [`python-partition:${partitionId}`],
      }));
    }
    const densityStatus = topology.status === "measured" && aggregate?.density?.status === "not-applicable"
      ? "not-applicable"
      : aggregateStatus;
    metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
      metricId: `static.python.dependency.density:${partitionId}`,
      definitionId: "sei.static.python.dependency.density@1",
      family: "dependency_topology",
      value: aggregate?.density?.value,
      unit: "ratio",
      status: densityStatus,
      completeness: densityStatus === "measured" ? topologyCompleteness : 0,
      confidence: densityStatus === "measured" ? topologyCompleteness : 0,
      reason: densityStatus === "not-applicable" ? aggregate.density.reason : topology.reason,
      artifactRefs: [`python-partition:${partitionId}`],
    }));
    metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
      metricId: `static.python.dependency.centrality:${partitionId}`,
      definitionId: "sei.static.python.dependency.centrality@1",
      family: "dependency_topology",
      value: null,
      unit: "normalized-centrality",
      status: "unavailable",
      completeness: 0,
      confidence: 0,
      reason: aggregate?.centrality?.reason ?? "FAIL-DEPENDENCY-TOPOLOGY-UNSUPPORTED-METRIC: no named centrality algorithm is defined",
      artifactRefs: [`python-partition:${partitionId}`],
    }));
    if (partition === null) continue;
    for (const node of partition.topology.nodes) {
      const module = moduleById.get(node.id);
      if (!module) continue;
      const moduleStatus = module.parse_status === "ok" ? "measured" : "unavailable";
      const moduleCompleteness = moduleStatus === "measured" ? topologyCompleteness : 0;
      const moduleReason = moduleStatus === "measured"
        ? topology.reason
        : "FAIL-STATIC-INTELLIGENCE-PARSE: module source did not parse; degree and instability are unavailable rather than zero";
      const moduleRefs = [`python-module:${node.id}`, module.path, `python-partition:${partitionId}`];
      for (const [name, value] of [["fan_in", node.fan_in], ["fan_out", node.fan_out]]) {
        metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
          metricId: `static.python.dependency.${name}:${partitionId}:${node.id}`,
          definitionId: `sei.static.python.dependency.${name}@1`,
          family: "dependency_topology",
          value,
          unit: "count",
          status: moduleStatus,
          completeness: moduleCompleteness,
          confidence: moduleCompleteness,
          reason: moduleReason,
          subject: `python-module:${node.id}`,
          scopeKind: "module",
          scopePath: module.path,
          artifactRefs: moduleRefs,
        }));
      }
      metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
        metricId: `static.python.dependency.instability:${partitionId}:${node.id}`,
        definitionId: "sei.static.python.dependency.instability@1",
        family: "dependency_topology",
        value: moduleStatus === "measured" ? node.instability.value : null,
        unit: "ratio",
        status: moduleStatus === "measured" ? node.instability.status : "unavailable",
        completeness: moduleStatus === "measured" && node.instability.status === "measured" ? topologyCompleteness : 0,
        confidence: moduleStatus === "measured" && node.instability.status === "measured" ? topologyCompleteness : 0,
        reason: moduleStatus === "measured" ? (node.instability.reason ?? topology.reason) : moduleReason,
        subject: `python-module:${node.id}`,
        scopeKind: "module",
        scopePath: module.path,
        artifactRefs: moduleRefs,
      }));
    }
    for (const component of partition.topology.strongly_connected_components.filter((candidate) => candidate.cyclic)) {
      const members = component.members.map((member) => moduleById.get(member)).filter(Boolean);
      const memberIds = new Set(component.members);
      const sourceRefs = topology.imports.references
        .filter((reference) => reference.classification === "local"
          && memberIds.has(moduleByPath.get(reference.path)?.id)
          && memberIds.has(reference.target))
        .map((reference) => `python-import:${reference.path}:${reference.lineno}:${reference.col_offset}->${reference.target}`);
      metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
        metricId: `static.python.dependency.cyclic_scc_size:${partitionId}:${component.scc_id}`,
        definitionId: "sei.static.python.dependency.cyclic_scc_size@1",
        family: "dependency_topology",
        value: component.members.length,
        unit: "modules",
        status: "measured",
        completeness: topologyCompleteness,
        confidence: topologyCompleteness,
        reason: topology.reason,
        subject: `python-scc:${component.scc_id}`,
        scopeKind: "scc",
        scopePath: ".",
        artifactRefs: [
          `python-partition:${partitionId}`,
          `python-scc:${component.scc_id}`,
          ...members.map((member) => `python-scc-member:${member.id}@${member.path}`),
          ...sourceRefs,
        ],
      }));
    }
  }
  const importStatus = unavailableTopologyMetricStatus(topology, "supported");
  for (const classification of ["local", "external", "unresolved_local_candidate", "unsupported_dynamic"]) {
    metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
      metricId: `static.python.dependency.import_count:all-python:${classification.replaceAll("_", "-")}`,
      definitionId: "sei.static.python.dependency.import_count@1",
      family: "dependency_topology",
      value: topology.imports.counts[classification],
      unit: "count",
      status: importStatus,
      completeness: importStatus === "measured" ? (topology.modules.length === 0 ? 0 : Number((topology.modules.filter((module) => module.parse_status === "ok").length / topology.modules.length).toFixed(8))) : 0,
      confidence: importStatus === "measured" ? (topology.modules.length === 0 ? 0 : Number((topology.modules.filter((module) => module.parse_status === "ok").length / topology.modules.length).toFixed(8))) : 0,
      reason: topology.reason,
      artifactRefs: ["python-partition:all-python"],
    }));
  }
  metrics.push(metricRecord(index, configurationHash, graphKeyValue, {
    metricId: "static.python.dependency.dynamic_resolution",
    definitionId: "sei.static.python.dependency.dynamic_resolution@1",
    family: "dependency_topology",
    value: null,
    unit: "resolved-dynamic-edges",
    status: "unavailable",
    completeness: 0,
    confidence: 0,
    reason: "FAIL-STATIC-INTELLIGENCE-DYNAMIC-IMPORTS: dynamic import resolution is outside the static contract; unsupported call sites create no dependency edges",
  }));
  return metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
}

function telemetryRecord() {
  const cachePart = () => ({
    hits: 0,
    misses: 0,
    corrupt: 0,
    in_flight_hits: 0,
    writes: 0,
    read_errors: 0,
    write_errors: 0,
    diagnostics: [],
  });
  return {
    parse: cachePart(),
    graph: { ...cachePart(), materializations: 0 },
    executor_runs: 0,
    tasks_submitted: 0,
    max_in_flight: 0,
    timeouts: 0,
    cancelled: 0,
  };
}

function configurationIdentity(configuration) {
  return sha256(canonicalJson({
    analyzer_version: PYTHON_AST_ANALYZER_VERSION,
    grammar_target: configuration.grammarTarget,
    limits: configuration.limits,
    max_queued_source_bytes: configuration.maxQueuedSourceBytes,
    module_roots: configuration.moduleRoots,
    module_root_policy: MODULE_ROOT_POLICY_VERSION,
    module_resolution_policy: MODULE_RESOLUTION_POLICY_VERSION,
  }));
}

async function analyzeStaticIntelligence(input) {
  assertClosedRecord(input, INPUT_KEYS, "input");
  validateRepositoryIndex(input.repositoryIndex);
  validateTaskExecutor(input.taskExecutor);
  const cache = validateCache(input.cache);
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    fail("FAIL-STATIC-INTELLIGENCE-CONFIG", "signal must be an AbortSignal");
  }
  const configuration = normalizeConfiguration(input.configuration);
  const { repositoryIndex: index, taskExecutor, signal } = input;
  const invalidationInput = validateInvalidationInput(input.invalidation, index);
  const token = bindingToken(index);
  const telemetry = telemetryRecord();
  assertLive(index, token, signal);
  const { selected, counters } = selectedPythonEntries(index);
  const rootDiagnostics = [];
  const roots = await deriveModuleRoots(index, selected, configuration.moduleRoots, configuration, signal, rootDiagnostics);
  assertLive(index, token, signal);
  const moduleBinding = bindModules(selected, roots.roots);
  const parse = await loadParseFacts(selected, {
    index,
    taskExecutor,
    cache,
    configuration,
    signal,
    token,
    telemetry,
  });
  assertLive(index, token, signal);
  const configurationHash = configurationIdentity(configuration);
  const graphCacheKeyValue = graphCacheKey(index, configurationHash, roots, moduleBinding, parse.parseKeys, parse.byContent);
  const graphEvidenceKeyValue = graphEvidenceKey(index, configurationHash, roots, moduleBinding, parse.parseKeys, parse.byContent);
  const graphContext = {
    cache,
    signal,
    telemetry,
    index,
    token,
  };
  let computedTopology = null;
  const computeTopology = () => {
    if (computedTopology === null) {
      telemetry.graph.materializations += 1;
      computedTopology = deepFreeze(materializeTopology(moduleBinding, parse.byContent, roots));
    }
    return computedTopology;
  };
  let dependencySnapshot = projectUnchangedDependencySnapshot(
    index,
    configurationHash,
    selected,
    parse.parseKeys,
    graphCacheKeyValue,
    invalidationInput,
  );
  if (dependencySnapshot === null && invalidationInput !== null) {
    dependencySnapshot = dependencyInvalidationSnapshot(
      index,
      configurationHash,
      selected,
      computeTopology(),
      parse.parseKeys,
      graphCacheKeyValue,
    );
  }
  let invalidationPlan = dependencyInvalidationPlan(dependencySnapshot, invalidationInput);
  let invalidation = invalidationReceipt(invalidationPlan, dependencySnapshot ?? { repositoryIndex: index });
  const topology = invalidation.topology_recompute && invalidationInput !== null
    ? await recomputeGraphWithoutReuse(graphCacheKeyValue, computeTopology(), graphContext)
    : await loadGraph(graphCacheKeyValue, graphContext, computeTopology);
  if (dependencySnapshot === null) {
    dependencySnapshot = dependencyInvalidationSnapshot(
      index,
      configurationHash,
      selected,
      topology,
      parse.parseKeys,
      graphCacheKeyValue,
    );
    invalidationPlan = null;
    invalidation = invalidationReceipt(null, dependencySnapshot);
  }
  assertLive(index, token, signal);
  const complexity = complexityFacts(selected, parse.byContent, counters);
  const collectorStatus = complexity.status === "unavailable"
    ? "unavailable"
    : complexity.completeness === 1 && topology.status === "measured" && topology.reason === null
      ? "available" : "degraded";
  const collectorReason = collectorStatus === "available" ? null
    : complexity.status === "unavailable" ? complexity.reason
      : topology.reason ?? complexity.reason ?? "Python-only source coverage is partial";
  const collectors = [{
    collector_id: "python-static-intelligence",
    collector_version: COLLECTOR_VERSION,
    status: collectorStatus,
    analyzer_identity: PYTHON_AST_ANALYZER_VERSION,
    analyzer_version: PYTHON_AST_ANALYZER_VERSION,
    reason: collectorReason,
  }];
  const canonical = deepFreeze(canonicalValue({
    analyzer: {
      analyzer_version: PYTHON_AST_ANALYZER_VERSION,
      protocol: PYTHON_AST_PROTOCOL_VERSION,
      parser_runtime: PARSER_RUNTIME,
      grammar_target: [...GRAMMAR_TARGET],
      cyclomatic_metric_contract_hash: CYCLOMATIC_METRIC_CONTRACT_HASH,
      graph_metric_contract_hash: GRAPH_METRIC_CONTRACT_HASH,
      module_root_policy_version: MODULE_ROOT_POLICY_VERSION,
      module_resolution_policy_version: MODULE_RESOLUTION_POLICY_VERSION,
    },
    binding: {
      repository_revision: index.binding.repository_revision,
      index_digest: index.binding.index_digest,
      classification_policy_version: index.binding.classification_policy_version,
      configuration_hash: configurationHash,
      module_root_manifest_digest: roots.digest,
      graph_cache_key: graphCacheKeyValue,
      graph_evidence_key: graphEvidenceKeyValue,
    },
    collectors,
    metrics: buildMetrics(index, configurationHash, graphEvidenceKeyValue, complexity, topology),
    diagnostics: {
      coverage: counters,
      module_roots: roots,
      module_binding_issues: moduleBinding.issues,
      root_diagnostics: rootDiagnostics,
    },
    facts: {
      complexity,
      topology,
      parse_fact_keys: [...parse.parseKeys.entries()].map(([contentKey, key]) => ({ content_key: contentKey, key }))
        .sort((left, right) => stableCompare(left.content_key, right.content_key)),
    },
  }));
  return deepFreeze({ canonical, telemetry, dependency_snapshot: dependencySnapshot, invalidation });
}

module.exports = {
  PYTHON_AST_ANALYZER_VERSION,
  analyzeStaticIntelligence,
};
