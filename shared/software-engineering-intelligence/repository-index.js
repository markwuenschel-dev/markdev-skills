"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");

const REPOSITORY_INDEX_VERSION = "sei.repository-index@1";
const CLASSIFICATION_POLICY_VERSION = "sei.repository-classification@2";
const GIT_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 64 * 1024;
const HARD_LIMITS = Object.freeze({
  max_entries: 100_000,
  max_tree_bytes: 16 * 1024 * 1024,
  max_blob_bytes: 64 * 1024 * 1024,
  max_batch_bytes: 32 * 1024 * 1024,
  max_exclusions: 1_024,
});
const SOURCE_EXTENSIONS = Object.freeze([
  [".c", "c"], [".cc", "cpp"], [".cpp", "cpp"], [".cs", "csharp"],
  [".go", "go"], [".java", "java"], [".js", "javascript"], [".jsx", "javascript"],
  [".kt", "kotlin"], [".kts", "kotlin"], [".php", "php"], [".py", "python"],
  [".rb", "ruby"], [".rs", "rust"], [".swift", "swift"], [".ts", "typescript"],
  [".tsx", "typescript"],
]);
const SOURCE_BY_EXTENSION = new Map(SOURCE_EXTENSIONS);
const INPUT_KEYS = Object.freeze(["cache_root", "generated_path_patterns", "limits", "repository_revision", "repository_root", "signal"]);
const LIMIT_KEYS = Object.freeze(Object.keys(HARD_LIMITS));
const READ_KEYS = Object.freeze(["max_blob_bytes", "max_total_bytes", "signal"]);
const CACHE_BINDING_KEYS = Object.freeze([
  "classification_policy_hash", "classification_policy_version", "entry_count", "exclusion_count",
  "index_digest", "index_key", "index_version", "object_format", "repository_revision", "root_tree_oid",
  "total_blob_bytes",
]);
const ENTRY_KEYS = Object.freeze(["blob_oid", "byte_size", "classifications", "content_key", "entry_key", "language", "mode", "path"]);
const CLASSIFICATION_KEYS = Object.freeze(["artifact_candidate_kinds", "generated", "manifest_kinds", "source", "test_source", "vendor"]);
const EXCLUSION_KEYS = Object.freeze(["mode", "object_oid", "path", "reason"]);
const OWNED_ENTRIES = new WeakMap();
const IN_FLIGHT_BUILDS = new Map();

function fail(family, detail) {
  throw new Error(`${family}: ${detail}`);
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function assertClosedRecord(value, keys, label, family) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(family, `${label} must be an object`);
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) fail(family, `${label} contains unexpected field ${unexpected.sort(stableCompare)[0]}`);
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function cancellationError() {
  return new Error("FAIL-REPOSITORY-INDEX-CANCELLED: operation was cancelled");
}

function checkCancelled(signal) {
  if (signal?.aborted) throw cancellationError();
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function gitFailure(family, detail, stderr) {
  const suffix = stderr.length > 0 ? ` (${stderr.toString("utf8").trim()})` : "";
  return new Error(`${family}: ${detail}${suffix}`);
}

function runGit(repositoryRoot, args, options) {
  const { family, maxStdoutBytes, signal, input } = options;
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const safeRoot = path.resolve(repositoryRoot);
    const child = spawn("git", ["-c", `safe.directory=${safeRoot}`, ...args], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError = null;
    let settled = false;
    const timer = setTimeout(() => {
      terminalError ??= gitFailure(family, "Git command timed out", Buffer.concat(stderr));
      child.kill();
    }, GIT_TIMEOUT_MS);
    const abort = () => {
      terminalError = cancellationError();
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        terminalError ??= gitFailure(family, `Git stdout exceeded ${maxStdoutBytes} bytes`, Buffer.concat(stderr));
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_LIMIT) {
        terminalError ??= gitFailure(family, `Git stderr exceeded ${STDERR_LIMIT} bytes`, Buffer.concat(stderr));
        child.kill();
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      terminalError ??= gitFailure(family, `could not spawn Git: ${error.message}`, Buffer.concat(stderr));
    });
    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (terminalError) {
        reject(terminalError);
      } else if (code !== 0) {
        reject(gitFailure(family, `Git exited with code ${code}${closeSignal ? ` (${closeSignal})` : ""}`, Buffer.concat(stderr)));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
    if (input !== undefined) {
      child.stdin.on("error", (error) => {
        terminalError ??= gitFailure(family, `could not write Git input: ${error.message}`, Buffer.concat(stderr));
        child.kill();
      });
      child.stdin.end(input);
    }
  });
}

function parseSingleLine(bytes, family, label) {
  const value = bytes.toString("utf8").trim();
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) fail(family, `${label} was malformed`);
  return value;
}

async function resolveBinding(repositoryRoot, revision, signal) {
  const family = "FAIL-REPOSITORY-INDEX-BINDING";
  const commit = parseSingleLine(await runGit(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`], {
    family, maxStdoutBytes: 1024, signal,
  }), family, "commit identity");
  if (commit !== revision) fail(family, "supplied revision did not resolve byte-for-byte to the exact commit");
  const rootTreeOid = parseSingleLine(await runGit(repositoryRoot, ["rev-parse", "--verify", `${revision}^{tree}`], {
    family, maxStdoutBytes: 1024, signal,
  }), family, "root tree identity");
  const objectFormat = parseSingleLine(await runGit(repositoryRoot, ["rev-parse", "--show-object-format"], {
    family, maxStdoutBytes: 1024, signal,
  }), family, "object format");
  if (objectFormat !== "sha1" && objectFormat !== "sha256") fail(family, `unsupported object format ${objectFormat}`);
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${oidLength}}$`).test(rootTreeOid)) fail(family, "root tree identity did not match the object format");
  return { repository_revision: commit, root_tree_oid: rootTreeOid, object_format: objectFormat };
}

function normalizeInput(input) {
  const family = "FAIL-REPOSITORY-INDEX-INPUT";
  assertClosedRecord(input, INPUT_KEYS, "input", family);
  if (typeof input.repository_root !== "string" || input.repository_root.length === 0 || input.repository_root.includes("\0")) {
    fail(family, "repository_root must be a non-empty NUL-free string");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.repository_revision ?? "")) {
    fail(family, "repository_revision must be an exact lowercase full 40- or 64-hex commit identity");
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) fail(family, "signal must be an AbortSignal");
  const repositoryRoot = path.resolve(input.repository_root);
  let stats;
  try { stats = fs.statSync(repositoryRoot); } catch { fail(family, "repository_root must be an existing directory"); }
  if (!stats.isDirectory()) fail(family, "repository_root must be an existing directory");
  const patternsSupplied = input.generated_path_patterns !== undefined;
  if (patternsSupplied && !Array.isArray(input.generated_path_patterns)) fail(family, "generated_path_patterns must be an array when supplied");
  const patterns = patternsSupplied ? input.generated_path_patterns.map((pattern, index) => {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.includes("\0")) {
      fail(family, `generated_path_patterns[${index}] must be a non-empty NUL-free string`);
    }
    return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  }) : [];
  const limitsInput = input.limits ?? {};
  assertClosedRecord(limitsInput, LIMIT_KEYS, "limits", family);
  const limits = {};
  for (const [key, hardLimit] of Object.entries(HARD_LIMITS)) {
    const value = limitsInput[key] ?? hardLimit;
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimit) fail(family, `${key} must be a positive safe integer no greater than ${hardLimit}`);
    limits[key] = value;
  }
  if (input.cache_root !== undefined && (typeof input.cache_root !== "string" || input.cache_root.length === 0 || input.cache_root.includes("\0"))) {
    fail(family, "cache_root must be a non-empty NUL-free string when supplied");
  }
  return {
    repositoryRoot,
    revision: input.repository_revision,
    patternsSupplied,
    patterns: [...new Set(patterns)].sort(stableCompare),
    cacheRoot: input.cache_root === undefined ? null : path.resolve(input.cache_root),
    limits: Object.freeze(limits),
    signal: input.signal,
  };
}

function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function classificationPolicy(patternsSupplied, patterns) {
  return {
    version: CLASSIFICATION_POLICY_VERSION,
    generated_patterns_supplied: patternsSupplied,
    generated_path_patterns: patterns,
    source_extensions: SOURCE_EXTENSIONS,
    test_rule: "supported-source-in-test-tests-__tests__-src-test-or-js-ts-test-spec-case-insensitive@1",
    vendor_segments: ["external", "node_modules", "third_party", "vendor"],
    manifest_rule: "node-python-requirements-gradle-maven-path-candidates@1",
    artifact_rule: "ci-test-coverage-jest-vitest-junit-lcov-unsupported-coverage-path-candidates@2",
  };
}

function manifestKinds(filePath) {
  const kinds = [];
  if (/(?:^|\/)package\.json$/.test(filePath)) kinds.push("node-package");
  if (/(?:^|\/)pyproject\.toml$/.test(filePath)) kinds.push("python-project");
  if (/(?:^|\/)(?:requirements(?:[-_.](?:dev|test|tests))?\.txt|(?:dev|test)-requirements\.txt|requirements\/(?:dev|test|tests)\.txt)$/i.test(filePath)) kinds.push("python-requirements");
  if (/(?:^|\/)build\.gradle(?:\.kts)?$/.test(filePath)) kinds.push("gradle-build");
  if (/(?:^|\/)settings\.gradle(?:\.kts)?$/.test(filePath)) kinds.push("gradle-settings");
  if (/(?:^|\/)pom\.xml$/.test(filePath)) kinds.push("maven-project");
  return kinds.sort(stableCompare);
}

function artifactCandidateKinds(filePath) {
  const kinds = [];
  const packageCandidate = /(?:^|\/)package\.json$/.test(filePath);
  const pythonCandidate = /(?:^|\/)(?:pyproject\.toml|pytest\.ini|tox\.ini)$/.test(filePath);
  const requirementsCandidate = /(?:^|\/)(?:requirements(?:[-_.](?:dev|test|tests))?\.txt|(?:dev|test)-requirements\.txt|requirements\/(?:dev|test|tests)\.txt)$/i.test(filePath);
  const gradleCandidate = /(?:^|\/)(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/.test(filePath);
  const mavenCandidate = /(?:^|\/)pom\.xml$/.test(filePath);
  const jestConfig = /(?:^|\/)jest\.config\.[^/]+$/.test(filePath);
  const vitestConfig = /(?:^|\/)vitest\.config\.[^/]+$/.test(filePath);
  const conditionalCoverage = jestConfig || vitestConfig;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(filePath) || /^(?:\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml)$/i.test(filePath)) kinds.push("ci-config");
  if (packageCandidate || pythonCandidate || requirementsCandidate || gradleCandidate || mavenCandidate || conditionalCoverage) kinds.push("test-config");
  if (packageCandidate || /(?:^|\/)pyproject\.toml$/.test(filePath) || gradleCandidate || mavenCandidate || conditionalCoverage || /(?:^|\/)(?:\.coveragerc|coverage\.toml)$/.test(filePath)) kinds.push("coverage-config");
  if (jestConfig) kinds.push("jest-config");
  if (vitestConfig) kinds.push("vitest-config");
  if (/(?:^|\/)(?:TEST-[^/]+|junit[^/]*)\.xml$/i.test(filePath) || /(?:^|\/)test-results\/[^/]+\.xml$/i.test(filePath)) kinds.push("junit-result");
  if (/(?:^|\/)lcov\.info$/i.test(filePath)) kinds.push("lcov-result");
  if (/(?:^|\/)(?:jacoco(?:TestReport)?|cobertura|coverage)\.xml$/i.test(filePath) || /(?:^|\/)\.coverage(?:\.[^/]+)?$/i.test(filePath)) kinds.push("unsupported-coverage-result");
  return kinds.sort(stableCompare);
}

function classifyEntry(filePath, mode, patternsSupplied, patterns, policyHash) {
  const extension = path.posix.extname(filePath).toLowerCase();
  const language = SOURCE_BY_EXTENSION.get(extension) ?? "unknown";
  const source = mode !== "120000" && language !== "unknown";
  const lowerPath = filePath.toLowerCase();
  const testSource = source && (
    /(?:^|\/)(?:tests?|__tests__|src\/test)(?:\/|$)/i.test(filePath)
      || /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath)
  );
  const generated = patternsSupplied
    ? (patterns.some((pattern) => globToRegExp(pattern).test(filePath)) ? "generated" : "human")
    : "unknown";
  const vendor = lowerPath.split("/").some((segment) => new Set(["node_modules", "vendor", "third_party", "external"]).has(segment))
    ? "vendor" : "not-vendor";
  return {
    language,
    classifications: {
      source,
      test_source: testSource,
      generated,
      vendor,
      manifest_kinds: manifestKinds(filePath),
      artifact_candidate_kinds: artifactCandidateKinds(filePath),
    },
    policyHash,
  };
}

function validateRepositoryPath(filePath, family) {
  if (filePath.length === 0 || filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath) || filePath.includes("\\")) {
    fail(family, `unsafe repository path ${JSON.stringify(filePath)}`);
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(family, `unsafe repository path ${JSON.stringify(filePath)}`);
  }
}

function parseTree(bytes, context) {
  const family = "FAIL-REPOSITORY-INDEX-TREE";
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0) fail(family, "tree output was not NUL terminated");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) fail(family, "tree output contained an empty record");
    try { records.push(decoder.decode(bytes.subarray(start, index))); } catch { fail(family, "tree output contained a non-UTF-8 path"); }
    start = index + 1;
  }
  const paths = new Set();
  const entries = [];
  const exclusions = [];
  let totalBlobBytes = 0;
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) fail(family, "tree record was missing its path delimiter");
    const header = record.slice(0, tab);
    const filePath = record.slice(tab + 1);
    validateRepositoryPath(filePath, family);
    if (paths.has(filePath)) fail(family, `duplicate repository path ${JSON.stringify(filePath)}`);
    paths.add(filePath);
    const match = header.match(/^(\d{6}) ([a-z]+) ([0-9a-f]+) +([0-9]+|-)$/);
    if (!match) fail(family, `malformed tree record for ${JSON.stringify(filePath)}`);
    const [, mode, type, objectOid, sizeText] = match;
    const oidLength = context.objectFormat === "sha1" ? 40 : 64;
    if (!new RegExp(`^[0-9a-f]{${oidLength}}$`).test(objectOid)) fail(family, `object identity disagreed with ${context.objectFormat}`);
    if (mode === "160000") {
      if (type !== "commit" || sizeText !== "-") fail(family, "gitlink record was malformed");
      exclusions.push({ path: filePath, mode, object_oid: objectOid, reason: "gitlink-not-a-blob" });
      if (exclusions.length > context.limits.max_exclusions) fail(family, `exclusions exceeded ${context.limits.max_exclusions}`);
      continue;
    }
    if (!new Set(["100644", "100755", "120000"]).has(mode) || type !== "blob" || sizeText === "-") {
      fail(family, `unsupported tree object mode/type for ${JSON.stringify(filePath)}`);
    }
    const byteSize = Number(sizeText);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) fail(family, `unsafe blob size for ${JSON.stringify(filePath)}`);
    if (byteSize > context.limits.max_blob_bytes) fail(family, `blob size exceeded ${context.limits.max_blob_bytes} for ${JSON.stringify(filePath)}`);
    totalBlobBytes += byteSize;
    if (!Number.isSafeInteger(totalBlobBytes)) fail(family, "total blob bytes exceeded safe integer range");
    const classified = classifyEntry(filePath, mode, context.patternsSupplied, context.patterns, context.policyHash);
    const identity = {
      path: filePath,
      mode,
      blob_oid: objectOid,
      byte_size: byteSize,
      content_key: `git-blob:${context.objectFormat}:${objectOid}`,
      language: classified.language,
      classifications: classified.classifications,
    };
    entries.push({ ...identity, entry_key: sha256(canonicalJson({ classification_policy_hash: context.policyHash, ...identity })) });
    if (entries.length > context.limits.max_entries) fail(family, `entries exceeded ${context.limits.max_entries}`);
  }
  entries.sort((left, right) => stableCompare(left.path, right.path) || stableCompare(left.blob_oid, right.blob_oid));
  exclusions.sort((left, right) => stableCompare(left.path, right.path) || stableCompare(left.object_oid, right.object_oid));
  return { entries, exclusions, totalBlobBytes };
}

function digestBinding(binding) {
  const {
    index_version,
    classification_policy_version,
    repository_revision,
    root_tree_oid,
    object_format,
    classification_policy_hash,
    index_key,
    entry_count,
    total_blob_bytes,
    exclusion_count,
  } = binding;
  return {
    index_version,
    classification_policy_version,
    repository_revision,
    root_tree_oid,
    object_format,
    classification_policy_hash,
    index_key,
    entry_count,
    total_blob_bytes,
    exclusion_count,
  };
}

function cacheArtifactBytes(binding, entries, exclusions) {
  return Buffer.from(canonicalJson({
    binding: { ...digestBinding(binding), index_digest: binding.index_digest },
    entries,
    exclusions,
  }), "utf8");
}

function validateCacheArtifactIntrinsic(value) {
  if (!hasExactKeys(value, ["binding", "entries", "exclusions"])) return false;
  const { binding, entries, exclusions } = value;
  if (!hasExactKeys(binding, CACHE_BINDING_KEYS) || !Array.isArray(entries) || !Array.isArray(exclusions)) return false;
  if (binding.index_version !== REPOSITORY_INDEX_VERSION || binding.classification_policy_version !== CLASSIFICATION_POLICY_VERSION) return false;
  if (!new Set(["sha1", "sha256"]).has(binding.object_format)) return false;
  const oidLength = binding.object_format === "sha1" ? 40 : 64;
  const oidPattern = new RegExp(`^[0-9a-f]{${oidLength}}$`);
  if (!oidPattern.test(binding.repository_revision) || !oidPattern.test(binding.root_tree_oid)) return false;
  if (!/^sha256:[0-9a-f]{64}$/.test(binding.classification_policy_hash)
      || !/^sha256:[0-9a-f]{64}$/.test(binding.index_key)
      || !/^sha256:[0-9a-f]{64}$/.test(binding.index_digest)) return false;
  const expectedIndexKey = sha256(canonicalJson({
    index_version: binding.index_version,
    object_format: binding.object_format,
    repository_revision: binding.repository_revision,
    root_tree_oid: binding.root_tree_oid,
    classification_policy_hash: binding.classification_policy_hash,
  }));
  if (binding.index_key !== expectedIndexKey) return false;
  let priorPath = null;
  let totalBlobBytes = 0;
  for (const entry of entries) {
    if (!hasExactKeys(entry, ENTRY_KEYS) || !hasExactKeys(entry.classifications, CLASSIFICATION_KEYS)) return false;
    try { validateRepositoryPath(entry.path, "FAIL-REPOSITORY-INDEX-CACHE"); } catch { return false; }
    if (priorPath !== null && stableCompare(priorPath, entry.path) >= 0) return false;
    priorPath = entry.path;
    if (!new Set(["100644", "100755", "120000"]).has(entry.mode) || !oidPattern.test(entry.blob_oid)) return false;
    if (!Number.isSafeInteger(entry.byte_size) || entry.byte_size < 0) return false;
    if (entry.content_key !== `git-blob:${binding.object_format}:${entry.blob_oid}`) return false;
    if (typeof entry.language !== "string" || entry.language.length === 0) return false;
    const classifications = entry.classifications;
    if (typeof classifications.source !== "boolean" || typeof classifications.test_source !== "boolean") return false;
    if (!new Set(["generated", "human", "unknown"]).has(classifications.generated)) return false;
    if (!new Set(["vendor", "not-vendor"]).has(classifications.vendor)) return false;
    for (const field of ["manifest_kinds", "artifact_candidate_kinds"]) {
      if (!Array.isArray(classifications[field]) || classifications[field].some((item) => typeof item !== "string")
          || new Set(classifications[field]).size !== classifications[field].length
          || classifications[field].some((item, index) => index > 0 && stableCompare(classifications[field][index - 1], item) >= 0)) return false;
    }
    const { entry_key: entryKey, ...identity } = entry;
    if (entryKey !== sha256(canonicalJson({ classification_policy_hash: binding.classification_policy_hash, ...identity }))) return false;
    totalBlobBytes += entry.byte_size;
    if (!Number.isSafeInteger(totalBlobBytes)) return false;
  }
  priorPath = null;
  for (const exclusion of exclusions) {
    if (!hasExactKeys(exclusion, EXCLUSION_KEYS) || exclusion.mode !== "160000" || exclusion.reason !== "gitlink-not-a-blob" || !oidPattern.test(exclusion.object_oid)) return false;
    try { validateRepositoryPath(exclusion.path, "FAIL-REPOSITORY-INDEX-CACHE"); } catch { return false; }
    if (priorPath !== null && stableCompare(priorPath, exclusion.path) >= 0) return false;
    priorPath = exclusion.path;
  }
  if (binding.entry_count !== entries.length || binding.exclusion_count !== exclusions.length || binding.total_blob_bytes !== totalBlobBytes) return false;
  const expectedDigest = sha256(canonicalJson({ binding: digestBinding(binding), entries, exclusions }));
  return binding.index_digest === expectedDigest;
}

function cachePathFor(cacheRoot, indexKey) {
  return path.join(cacheRoot, "repository-index-v1", `${indexKey.slice("sha256:".length)}.json`);
}

async function quarantineCorrupt(cachePath) {
  const quarantinePath = `${cachePath}.corrupt-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    await fs.promises.rename(cachePath, quarantinePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error(`FAIL-REPOSITORY-INDEX-CACHE: could not quarantine corrupt cache artifact (${error.message})`);
  }
}

async function readCache(normalized, expected) {
  if (normalized.cacheRoot === null) return { state: "disabled" };
  const cachePath = cachePathFor(normalized.cacheRoot, expected.index_key);
  let stats;
  try { stats = await fs.promises.lstat(cachePath); } catch (error) {
    if (error.code === "ENOENT") return { state: "miss", cachePath };
    throw new Error(`FAIL-REPOSITORY-INDEX-CACHE: could not inspect cache artifact (${error.message})`);
  }
  const maximumCacheBytes = Math.min(128 * 1024 * 1024, (normalized.limits.max_tree_bytes * 16) + (1024 * 1024));
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maximumCacheBytes) {
    await quarantineCorrupt(cachePath);
    return { state: "recovered-corrupt", cachePath };
  }
  let bytes;
  try { bytes = await fs.promises.readFile(cachePath); } catch (error) {
    throw new Error(`FAIL-REPOSITORY-INDEX-CACHE: could not read cache artifact (${error.message})`);
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    await quarantineCorrupt(cachePath);
    return { state: "recovered-corrupt", cachePath };
  }
  if (!validateCacheArtifactIntrinsic(value)) {
    await quarantineCorrupt(cachePath);
    return { state: "recovered-corrupt", cachePath };
  }
  if (!bytes.equals(cacheArtifactBytes(value.binding, value.entries, value.exclusions))) {
    await quarantineCorrupt(cachePath);
    return { state: "recovered-corrupt", cachePath };
  }
  for (const field of ["index_version", "classification_policy_version", "repository_revision", "root_tree_oid", "object_format", "classification_policy_hash", "index_key"]) {
    if (value.binding[field] !== expected[field]) fail("FAIL-REPOSITORY-INDEX-CACHE", "valid cache artifact conflicts with its immutable final name");
  }
  const overBounds = value.entries.length > normalized.limits.max_entries
    || value.exclusions.length > normalized.limits.max_exclusions
    || value.entries.some((entry) => entry.byte_size > normalized.limits.max_blob_bytes);
  if (overBounds) return { state: "miss", cachePath };
  return { state: "hit", cachePath, value };
}

async function publishCache(cachePath, bytes, signal) {
  checkCancelled(signal);
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  checkCancelled(signal);
  const stagePath = `${cachePath}.stage-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let linked = false;
  try {
    const handle = await fs.promises.open(stagePath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    checkCancelled(signal);
    try {
      await fs.promises.link(stagePath, cachePath);
      linked = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await fs.promises.readFile(cachePath);
      if (!existing.equals(bytes)) fail("FAIL-REPOSITORY-INDEX-CACHE", "valid cache artifact conflicts with concurrently published bytes");
    }
    if (signal?.aborted) {
      if (linked) await fs.promises.unlink(cachePath).catch(() => {});
      throw cancellationError();
    }
  } catch (error) {
    if (/^FAIL-REPOSITORY-INDEX-/.test(error.message ?? "")) throw error;
    throw new Error(`FAIL-REPOSITORY-INDEX-CACHE: cache publication failed (${error.message})`);
  } finally {
    await fs.promises.unlink(stagePath).catch(() => {});
  }
}

async function buildRepositoryIndex(input) {
  const normalized = normalizeInput(input);
  checkCancelled(normalized.signal);
  const initial = await resolveBinding(normalized.repositoryRoot, normalized.revision, normalized.signal);
  const policy = classificationPolicy(normalized.patternsSupplied, normalized.patterns);
  const policyHash = sha256(canonicalJson(policy));
  const indexKey = sha256(canonicalJson({
    index_version: REPOSITORY_INDEX_VERSION,
    object_format: initial.object_format,
    repository_revision: initial.repository_revision,
    root_tree_oid: initial.root_tree_oid,
    classification_policy_hash: policyHash,
  }));
  const inFlightKey = normalized.signal === undefined
    ? canonicalJson({ repository_root: normalized.repositoryRoot, index_key: indexKey, cache_root: normalized.cacheRoot, limits: normalized.limits })
    : null;
  if (inFlightKey !== null && IN_FLIGHT_BUILDS.has(inFlightKey)) return IN_FLIGHT_BUILDS.get(inFlightKey);
  const promise = (async () => {
    const expectedCacheBinding = {
      index_version: REPOSITORY_INDEX_VERSION,
      classification_policy_version: CLASSIFICATION_POLICY_VERSION,
      repository_revision: initial.repository_revision,
      root_tree_oid: initial.root_tree_oid,
      object_format: initial.object_format,
      classification_policy_hash: policyHash,
      index_key: indexKey,
    };
    let cached = await readCache(normalized, expectedCacheBinding);
    const readExactTree = async () => {
      const treeBytes = await runGit(normalized.repositoryRoot, ["ls-tree", "-r", "-l", "-z", "--full-tree", normalized.revision, "--"], {
        family: "FAIL-REPOSITORY-INDEX-TREE",
        maxStdoutBytes: normalized.limits.max_tree_bytes,
        signal: normalized.signal,
      });
      return parseTree(treeBytes, {
        objectFormat: initial.object_format,
        limits: normalized.limits,
        patternsSupplied: normalized.patternsSupplied,
        patterns: normalized.patterns,
        policyHash,
      });
    };
    let parsed = null;
    if (cached.state === "hit") {
      parsed = await readExactTree();
      const cacheMatchesTree = canonicalJson(cached.value.entries) === canonicalJson(parsed.entries)
        && canonicalJson(cached.value.exclusions) === canonicalJson(parsed.exclusions);
      if (cacheMatchesTree) {
        const finalBinding = await resolveBinding(normalized.repositoryRoot, normalized.revision, normalized.signal);
        if (canonicalJson(finalBinding) !== canonicalJson(initial)) fail("FAIL-REPOSITORY-INDEX-BINDING", "commit or root tree drifted during cache replay");
        return materializeIndex(normalized, { ...cached.value.binding, cache: "hit" }, cached.value.entries, cached.value.exclusions);
      }
      await quarantineCorrupt(cached.cachePath);
      cached = { state: "recovered-corrupt", cachePath: cached.cachePath };
    }
    parsed ??= await readExactTree();
    const finalBinding = await resolveBinding(normalized.repositoryRoot, normalized.revision, normalized.signal);
    if (canonicalJson(finalBinding) !== canonicalJson(initial)) fail("FAIL-REPOSITORY-INDEX-BINDING", "commit or root tree drifted during construction");
    const digestBindingValue = {
      index_version: REPOSITORY_INDEX_VERSION,
      classification_policy_version: CLASSIFICATION_POLICY_VERSION,
      repository_revision: initial.repository_revision,
      root_tree_oid: initial.root_tree_oid,
      object_format: initial.object_format,
      classification_policy_hash: policyHash,
      index_key: indexKey,
      entry_count: parsed.entries.length,
      total_blob_bytes: parsed.totalBlobBytes,
      exclusion_count: parsed.exclusions.length,
    };
    const binding = {
      ...digestBindingValue,
      index_digest: sha256(canonicalJson({ binding: digestBindingValue, entries: parsed.entries, exclusions: parsed.exclusions })),
      cache: cached.state,
    };
    if (cached.cachePath) await publishCache(cached.cachePath, cacheArtifactBytes(binding, parsed.entries, parsed.exclusions), normalized.signal);
    return materializeIndex(normalized, binding, parsed.entries, parsed.exclusions);
  })();
  if (inFlightKey !== null) IN_FLIGHT_BUILDS.set(inFlightKey, promise);
  try { return await promise; } finally { if (inFlightKey !== null) IN_FLIGHT_BUILDS.delete(inFlightKey); }
}

function materializeIndex(normalized, binding, entries, exclusions) {
  const owner = Object.freeze({});
  for (const entry of entries) OWNED_ENTRIES.set(entry, owner);
  deepFreeze(binding);
  deepFreeze(entries);
  deepFreeze(exclusions);
  const index = {
    binding,
    entries,
    exclusions,
    async readBlobs(requestedEntries, options) {
      return readBlobs(normalized, owner, requestedEntries, options);
    },
  };
  return Object.freeze(index);
}

function readonlyMap(entries) {
  const inner = new Map(entries);
  return Object.freeze({
    get size() { return inner.size; },
    get(key) { return inner.get(key); },
    has(key) { return inner.has(key); },
    entries() { return inner.entries(); },
    keys() { return inner.keys(); },
    values() { return inner.values(); },
    forEach(callback, thisArg) { return inner.forEach((value, key) => callback.call(thisArg, value, key, this), thisArg); },
    [Symbol.iterator]() { return inner[Symbol.iterator](); },
    [Symbol.toStringTag]: "Map",
  });
}

function parseBatchOutput(bytes, requestedByOid, objectFormat) {
  const family = "FAIL-REPOSITORY-INDEX-BLOB";
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  const blobs = new Map();
  let offset = 0;
  for (const [oid, expectedSize] of requestedByOid) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) fail(family, `missing cat-file header for ${oid}`);
    const header = bytes.subarray(offset, newline).toString("ascii");
    const match = header.match(/^([0-9a-f]+) ([a-z]+) ([0-9]+)$/);
    if (!match) fail(family, `malformed cat-file header for ${oid}`);
    const [, returnedOid, type, sizeText] = match;
    if (returnedOid !== oid || returnedOid.length !== oidLength) fail(family, `cat-file returned an unexpected OID for ${oid}`);
    if (type !== "blob") fail(family, `cat-file returned ${type} instead of blob for ${oid}`);
    const returnedSize = Number(sizeText);
    if (!Number.isSafeInteger(returnedSize) || returnedSize !== expectedSize) fail(family, `cat-file size disagreed with the tree for ${oid}`);
    const contentStart = newline + 1;
    const contentEnd = contentStart + returnedSize;
    if (contentEnd >= bytes.length || bytes[contentEnd] !== 10) fail(family, `cat-file content was truncated for ${oid}`);
    blobs.set(oid, Buffer.from(bytes.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== bytes.length) fail(family, "cat-file returned trailing bytes");
  return blobs;
}

async function readBlobs(normalized, owner, requestedEntries, options) {
  const family = "FAIL-REPOSITORY-INDEX-BLOB";
  if (!Array.isArray(requestedEntries)) fail(family, "entries must be an array");
  assertClosedRecord(options, READ_KEYS, "read options", family);
  if (options.signal !== undefined && !isAbortSignal(options.signal)) fail(family, "signal must be an AbortSignal");
  for (const key of ["max_blob_bytes", "max_total_bytes"]) {
    const maximum = key === "max_blob_bytes" ? normalized.limits.max_blob_bytes : normalized.limits.max_batch_bytes;
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0 || options[key] > maximum) {
      fail(family, `${key} must be a positive safe integer no greater than ${maximum}`);
    }
  }
  checkCancelled(options.signal);
  const seenPaths = new Set();
  let totalBytes = 0;
  const canonicalEntries = [...requestedEntries];
  for (const entry of canonicalEntries) {
    if (!entry || typeof entry !== "object" || OWNED_ENTRIES.get(entry) !== owner) fail(family, "every requested entry must be owned by this index");
    if (seenPaths.has(entry.path)) fail(family, `duplicate requested path ${JSON.stringify(entry.path)}`);
    seenPaths.add(entry.path);
    if (entry.byte_size > options.max_blob_bytes) fail(family, `${entry.path} exceeds max_blob_bytes`);
    totalBytes += entry.byte_size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > options.max_total_bytes) fail(family, "requested entries exceed max_total_bytes");
  }
  canonicalEntries.sort((left, right) => stableCompare(left.path, right.path));
  if (canonicalEntries.length === 0) return readonlyMap([]);
  const sizeByOid = new Map();
  for (const entry of canonicalEntries) {
    const priorSize = sizeByOid.get(entry.blob_oid);
    if (priorSize !== undefined && priorSize !== entry.byte_size) fail(family, `equal OIDs declared different sizes for ${entry.blob_oid}`);
    sizeByOid.set(entry.blob_oid, entry.byte_size);
  }
  const requestedByOid = [...sizeByOid.entries()].sort(([left], [right]) => stableCompare(left, right));
  const gitInput = Buffer.from(`${requestedByOid.map(([oid]) => oid).join("\n")}\n`, "ascii");
  const maximumOutput = totalBytes + (requestedByOid.length * 128) + 1;
  const output = await runGit(normalized.repositoryRoot, ["cat-file", "--batch"], {
    family,
    maxStdoutBytes: maximumOutput,
    signal: options.signal,
    input: gitInput,
  });
  checkCancelled(options.signal);
  const blobs = parseBatchOutput(output, requestedByOid, normalized.revision.length === 40 ? "sha1" : "sha256");
  return readonlyMap(canonicalEntries.map((entry) => [entry.path, Buffer.from(blobs.get(entry.blob_oid))]));
}

module.exports = {
  REPOSITORY_INDEX_VERSION,
  CLASSIFICATION_POLICY_VERSION,
  buildRepositoryIndex,
};
