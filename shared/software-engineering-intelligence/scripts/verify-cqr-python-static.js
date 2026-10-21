#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FAILURE = "FAIL-CQR-PYTHON-ORACLE";
const REPOSITORY_INDEX_VERSION = "sei.repository-index@1";
const CLASSIFICATION_POLICY_VERSION = "sei.repository-classification@2";
const GENERATED_PATTERNS = Object.freeze(["build/**", "coverage/**", "dist/**", "generated/**"]);
const SOURCE_EXTENSIONS = Object.freeze([
  [".c", "c"], [".cc", "cpp"], [".cpp", "cpp"], [".cs", "csharp"],
  [".go", "go"], [".java", "java"], [".js", "javascript"], [".jsx", "javascript"],
  [".kt", "kotlin"], [".kts", "kotlin"], [".php", "php"], [".py", "python"],
  [".rb", "ruby"], [".rs", "rust"], [".swift", "swift"], [".ts", "typescript"],
  [".tsx", "typescript"],
]);
const SOURCE_BY_EXTENSION = new Map(SOURCE_EXTENSIONS);
const INDEPENDENT_VENDOR_SEGMENTS = new Set(["vendor", "vendors", "third_party", "third-party", "node_modules"]);
const INDEPENDENT_TEST_SEGMENTS = new Set(["test", "tests", "__tests__"]);

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
  if (value !== null && typeof value === "object") {
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

function deriveStaticConfigurationHash() {
  return sha256(canonicalJson({
    analyzer_version: "sei.python-ast@1",
    grammar_target: [3, 13],
    limits: {
      maxFileBytes: 2 * 1024 * 1024,
      maxBatchFiles: 32,
      maxBatchBytes: 4 * 1024 * 1024,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
      batchTimeoutMs: 30_000,
    },
    max_queued_source_bytes: 16 * 1024 * 1024,
    module_roots: [],
    module_root_policy: "sei.python-module-roots@1",
    module_resolution_policy: "sei.python-import-resolution@1",
  }));
}

function deriveCollectorConfigurationHash() {
  const policy = {
    policy_id: "temporal-coupling-mass-change-v1",
    policy_version: "1.0.0",
    threshold: 40,
    cap: 32,
    action: "down_weight",
  };
  const policyHash = sha256(canonicalJson(policy));
  return crypto.createHash("sha256").update(JSON.stringify({
    generated_path_patterns_supplied: true,
    generated_path_patterns: [...GENERATED_PATTERNS],
    static_analyzer_identity: "sei.lexical-js@1",
    static_analyzer_version: "1.1.0",
    git_analyzer_identity: "sei.git-history@1",
    git_analyzer_version: "1.4.1",
    temporal_coupling_policy: {
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      policy_hash: policyHash,
      threshold: policy.threshold,
      action: policy.action,
      reason: "no-mass-changes-observed-at-or-above-threshold-40-so-no-mass-change-action-was-applied-within-fixed-safe-pair-bound-780",
    },
  })).digest("hex");
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: null,
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? (128 * 1024 * 1024),
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...(options.env ?? {}) },
  });
  if (result.error) fail(`${options.label ?? command} could not execute (${result.error.message})`);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : String(result.stderr ?? "").trim();
    fail(`${options.label ?? command} exited ${result.status}${stderr ? ` (${stderr.slice(0, 4096)})` : ""}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

function runGit(repositoryRoot, args, options = {}) {
  return runProcess("git", args, { ...options, cwd: repositoryRoot, label: options.label ?? `git ${args[0]}` });
}

function singleLine(bytes, label) {
  const value = bytes.toString("utf8").trim();
  if (!value || value.includes("\n") || value.includes("\r")) fail(`${label} was malformed`);
  return value;
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

function classificationPolicy() {
  return {
    version: CLASSIFICATION_POLICY_VERSION,
    generated_patterns_supplied: true,
    generated_path_patterns: [...GENERATED_PATTERNS],
    source_extensions: SOURCE_EXTENSIONS,
    test_rule: "supported-source-in-test-tests-__tests__-src-test-or-js-ts-test-spec-case-insensitive@1",
    vendor_segments: ["external", "node_modules", "third_party", "vendor"],
    manifest_rule: "node-python-requirements-gradle-maven-path-candidates@1",
    artifact_rule: "ci-test-coverage-jest-vitest-junit-lcov-unsupported-coverage-path-candidates@2",
  };
}

function classifyEntry(filePath, mode, policyHash) {
  const extension = path.posix.extname(filePath).toLowerCase();
  const language = SOURCE_BY_EXTENSION.get(extension) ?? "unknown";
  const source = mode !== "120000" && language !== "unknown";
  const lowerPath = filePath.toLowerCase();
  return {
    language,
    classifications: {
      source,
      test_source: source && (
        /(?:^|\/)(?:tests?|__tests__|src\/test)(?:\/|$)/i.test(filePath)
        || /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath)
      ),
      generated: GENERATED_PATTERNS.some((pattern) => globToRegExp(pattern).test(filePath)) ? "generated" : "human",
      vendor: lowerPath.split("/").some((segment) => new Set(["node_modules", "vendor", "third_party", "external"]).has(segment))
        ? "vendor" : "not-vendor",
      manifest_kinds: manifestKinds(filePath),
      artifact_candidate_kinds: artifactCandidateKinds(filePath),
    },
    policyHash,
  };
}

function parseExactTree(bytes, objectFormat, policyHash) {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0) fail("Git tree output was not NUL-terminated");
  const entries = [];
  const exclusions = [];
  let totalBlobBytes = 0;
  for (const raw of bytes.toString("utf8").split("\0")) {
    if (!raw) continue;
    const tab = raw.indexOf("\t");
    const match = raw.slice(0, tab).match(/^(\d{6}) ([a-z]+) ([0-9a-f]+) +([0-9]+|-)$/);
    const filePath = raw.slice(tab + 1);
    if (tab < 0 || !match || !filePath || filePath.startsWith("/") || filePath.includes("\\")
        || filePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      fail(`unsafe or malformed Git tree record ${JSON.stringify(raw.slice(0, 256))}`);
    }
    const [, mode, type, objectOid, sizeText] = match;
    const oidLength = objectFormat === "sha1" ? 40 : 64;
    if (!new RegExp(`^[0-9a-f]{${oidLength}}$`).test(objectOid)) fail(`tree OID disagreed with ${objectFormat}`);
    if (mode === "160000") {
      if (type !== "commit" || sizeText !== "-") fail(`malformed gitlink ${filePath}`);
      exclusions.push({ path: filePath, mode, object_oid: objectOid, reason: "gitlink-not-a-blob" });
      continue;
    }
    if (!new Set(["100644", "100755", "120000"]).has(mode) || type !== "blob" || sizeText === "-") fail(`unsupported tree entry ${filePath}`);
    const byteSize = Number(sizeText);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) fail(`unsafe blob size ${filePath}`);
    totalBlobBytes += byteSize;
    const classified = classifyEntry(filePath, mode, policyHash);
    const identity = {
      path: filePath,
      mode,
      blob_oid: objectOid,
      byte_size: byteSize,
      content_key: `git-blob:${objectFormat}:${objectOid}`,
      language: classified.language,
      classifications: classified.classifications,
    };
    entries.push({ ...identity, entry_key: sha256(JSON.stringify({ classification_policy_hash: policyHash, ...identity })) });
  }
  entries.sort((left, right) => stableCompare(left.path, right.path) || stableCompare(left.blob_oid, right.blob_oid));
  exclusions.sort((left, right) => stableCompare(left.path, right.path) || stableCompare(left.object_oid, right.object_oid));
  return { entries, exclusions, totalBlobBytes };
}

function deriveIndependentIndex(repositoryRoot, revision) {
  const commit = singleLine(runGit(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`]), "CQR commit identity");
  if (commit !== revision) fail("CQR revision did not resolve byte-for-byte to the supplied commit");
  const rootTree = singleLine(runGit(repositoryRoot, ["rev-parse", "--verify", `${revision}^{tree}`]), "CQR root tree identity");
  const objectFormat = singleLine(runGit(repositoryRoot, ["rev-parse", "--show-object-format"]), "CQR object format");
  if (!new Set(["sha1", "sha256"]).has(objectFormat)) fail(`unsupported object format ${objectFormat}`);
  const policyHash = sha256(JSON.stringify(classificationPolicy()));
  const indexKey = sha256(JSON.stringify({
    index_version: REPOSITORY_INDEX_VERSION,
    object_format: objectFormat,
    repository_revision: commit,
    root_tree_oid: rootTree,
    classification_policy_hash: policyHash,
  }));
  const treeBytes = runGit(repositoryRoot, ["ls-tree", "-r", "-l", "-z", "--full-tree", revision, "--"]);
  const parsed = parseExactTree(treeBytes, objectFormat, policyHash);
  const binding = {
    index_version: REPOSITORY_INDEX_VERSION,
    classification_policy_version: CLASSIFICATION_POLICY_VERSION,
    repository_revision: commit,
    root_tree_oid: rootTree,
    object_format: objectFormat,
    classification_policy_hash: policyHash,
    index_key: indexKey,
    entry_count: parsed.entries.length,
    total_blob_bytes: parsed.totalBlobBytes,
    exclusion_count: parsed.exclusions.length,
  };
  return {
    binding: { ...binding, index_digest: sha256(JSON.stringify({ binding, entries: parsed.entries, exclusions: parsed.exclusions })) },
    entries: parsed.entries,
    exclusions: parsed.exclusions,
  };
}

function deriveIndependentRepositorySubject(repositoryRoot, revision) {
  const roots = [...new Set(runGit(repositoryRoot, ["rev-list", "--max-parents=0", revision])
    .toString("utf8").split(/\r?\n/).filter(Boolean).map((value) => value.toLowerCase()))].sort(stableCompare);
  if (roots.length === 0 || roots.some((value) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))) {
    fail("CQR root commit identities are unavailable");
  }
  return `repository:sei-repository-v1-${crypto.createHash("sha256").update(`roots:${roots.join(",")}`).digest("hex")}`;
}

function readGitBlobs(repositoryRoot, entries) {
  const orderedOids = [...new Set(entries.map((entry) => entry.blob_oid))].sort(stableCompare);
  if (orderedOids.length === 0) return new Map();
  const bytes = runGit(repositoryRoot, ["cat-file", "--batch"], {
    input: Buffer.from(`${orderedOids.join("\n")}\n`, "ascii"),
    label: "git cat-file --batch",
  });
  const blobs = new Map();
  let offset = 0;
  for (const oid of orderedOids) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) fail(`missing blob header ${oid}`);
    const match = bytes.subarray(offset, newline).toString("ascii").match(/^([0-9a-f]+) blob ([0-9]+)$/);
    if (!match || match[1] !== oid) fail(`malformed blob header ${oid}`);
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end >= bytes.length || bytes[end] !== 10) fail(`truncated blob ${oid}`);
    blobs.set(oid, Buffer.from(bytes.subarray(start, end)));
    offset = end + 1;
  }
  if (offset !== bytes.length) fail("git cat-file returned trailing bytes");
  return blobs;
}

function independentTestSource(filePath) {
  const segments = filePath.split("/");
  const name = segments.at(-1).toLowerCase();
  return segments.slice(0, -1).some((segment) => INDEPENDENT_TEST_SEGMENTS.has(segment.toLowerCase()))
    || name.startsWith("test_") || name.endsWith("_test.py");
}

function deriveIndependentInventory(repositoryRoot, index, expected) {
  const moduleRoot = expected.module_root?.module_root;
  if (typeof moduleRoot !== "string" || !moduleRoot) fail("expected fixture lacks a module root");
  const prefix = `${moduleRoot}/`;
  const pythonEntries = index.entries.filter((entry) => entry.mode !== "120000" && entry.path.endsWith(".py")
    && !GENERATED_PATTERNS.some((pattern) => globToRegExp(pattern).test(entry.path))
    && !entry.path.split("/").some((segment) => INDEPENDENT_VENDOR_SEGMENTS.has(segment.toLowerCase())));
  if (pythonEntries.some((entry) => !entry.path.startsWith(prefix))) fail("Python inventory extends beyond the independently locked module root");
  const manifest = index.entries.find((entry) => entry.path === expected.module_root.manifest_path);
  if (!manifest) fail("independent module-root manifest is absent");
  const blobs = readGitBlobs(repositoryRoot, [...pythonEntries, manifest]);
  assertEqual("module-root manifest blob OID", manifest.blob_oid, expected.module_root.manifest_blob_oid);
  assertEqual("module-root manifest SHA-256", sha256(blobs.get(manifest.blob_oid)), expected.module_root.manifest_sha256);
  const records = pythonEntries.map((entry) => {
    let stem = entry.path.slice(prefix.length, -3);
    if (stem === "__init__" || stem.endsWith("/__init__")) stem = path.posix.dirname(stem);
    const moduleId = stem.replaceAll("/", ".").replace(/^\.+|\.+$/g, "");
    if (!moduleId) fail(`empty module identity for ${entry.path}`);
    return {
      path: entry.path,
      blob_oid: entry.blob_oid,
      byte_size: entry.byte_size,
      sha256: sha256(blobs.get(entry.blob_oid)),
      partition: independentTestSource(entry.path) ? "test" : "production",
      module_id: moduleId,
    };
  }).sort((left, right) => stableCompare(left.path, right.path));
  return {
    python_file_count: records.length,
    production_file_count: records.filter((record) => record.partition === "production").length,
    test_file_count: records.filter((record) => record.partition === "test").length,
    unique_python_blob_count: new Set(pythonEntries.map((entry) => entry.blob_oid)).size,
    inventory_digest: sha256(canonicalJson(records)),
  };
}

function probePython(pythonExecutable) {
  if (!path.isAbsolute(pythonExecutable) || !fs.statSync(pythonExecutable, { throwIfNoEntry: false })?.isFile()) {
    fail("--python must resolve to an existing absolute executable file");
  }
  const bytes = runProcess(pythonExecutable, ["-I", "-S", "-c", "import json,platform,sys;print(json.dumps({'implementation':sys.implementation.name,'version':platform.python_version(),'grammar':[sys.version_info.major,sys.version_info.minor]},sort_keys=True,separators=(',',':')))"], {
    label: "isolated CPython probe",
    timeout: 30_000,
    maxBuffer: 4096,
  });
  const probe = parseJsonBytes(bytes, "isolated CPython probe");
  assertEqual("Python implementation", probe.implementation, "cpython");
  assertEqual("Python grammar", probe.grammar, [3, 13]);
  return probe;
}

function deriveProductBindings(seiRoot, expected) {
  const head = singleLine(runGit(seiRoot, ["rev-parse", "--verify", "HEAD^{commit}"]), "SEI HEAD");
  const hashes = {};
  for (const relativePath of expected.bindings.committed_product_paths ?? []) {
    const committed = runGit(seiRoot, ["show", `${head}:${relativePath}`], { label: `git show ${relativePath}` });
    const diskPath = path.join(seiRoot, ...relativePath.split("/"));
    if (!fs.statSync(diskPath, { throwIfNoEntry: false })?.isFile()) fail(`committed product path is absent on disk: ${relativePath}`);
    const committedOid = singleLine(runGit(seiRoot, ["rev-parse", `${head}:${relativePath}`]), `committed OID ${relativePath}`);
    const diskOid = singleLine(runGit(seiRoot, ["hash-object", `--path=${relativePath}`, diskPath]), `working-file OID ${relativePath}`);
    if (diskOid !== committedOid) fail(`committed product path differs on disk: ${relativePath}`);
    hashes[relativePath] = sha256(committed);
  }
  return { head, hashes };
}

function deriveLiveBindings(options, expected) {
  const repositoryRoot = fs.realpathSync.native(options.repo);
  const seiRoot = fs.realpathSync.native(options.seiRoot);
  const index = deriveIndependentIndex(repositoryRoot, options.revision);
  const inventory = deriveIndependentInventory(repositoryRoot, index, expected);
  const python = probePython(options.python);
  const product = deriveProductBindings(seiRoot, expected);
  return {
    cqr_revision: index.binding.repository_revision,
    cqr_root_tree: index.binding.root_tree_oid,
    sei_product_revision: product.head,
    repository_index_digest: index.binding.index_digest,
    repository_classification_policy_version: index.binding.classification_policy_version,
    static_configuration_hash: deriveStaticConfigurationHash(),
    collector_configuration_hash: deriveCollectorConfigurationHash(),
    python_implementation: python.implementation,
    python_version: python.version,
    inventory_digest: inventory.inventory_digest,
    repository_subject: deriveIndependentRepositorySubject(repositoryRoot, options.revision),
    inventory,
    committed_product_hashes: product.hashes,
  };
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail("arguments must be an array");
  const mapping = new Map([
    ["--repo", "repo"],
    ["--revision", "revision"],
    ["--expected", "expected"],
    ["--python", "python"],
    ["--sei-root", "seiRoot"],
    ["--out", "out"],
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = mapping.get(argument);
    if (!key || index + 1 >= argv.length) fail(`unsupported argument or missing value ${argument}`);
    if (Object.hasOwn(parsed, key)) fail(`duplicate argument ${argument}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(`${argument} requires a non-empty NUL-free value`);
    parsed[key] = key === "revision" ? value.toLowerCase() : value;
    index += 1;
  }
  for (const key of ["repo", "revision", "expected", "python"]) {
    if (!Object.hasOwn(parsed, key)) fail(`--${key} is required`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed.revision)) fail("--revision must be a full lowercase Git commit identity");
  parsed.seiRoot ??= path.resolve(__dirname, "..", "..", "..", "..");
  parsed.out ??= null;
  return parsed;
}

function parseJsonBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes)) fail(`${label} must be supplied as exact bytes`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid UTF-8 JSON (${error.message})`);
  }
}

function assertEqual(label, actual, expected) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label} mismatch; expected ${canonicalJson(expected)}, observed ${canonicalJson(actual)}`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function requiredRefs(expected) {
  return [
    `python-analyzer:${expected.bindings.analyzer_version}`,
    `python-configuration:${expected.bindings.static_configuration_hash}`,
    `python-grammar:${expected.bindings.grammar_target.join(".")}`,
    `python-runtime:${expected.bindings.parser_runtime}`,
    `repository-index:${expected.bindings.repository_index_digest}`,
  ];
}

function verifyMetric(metric, binding, expected) {
  if (!metric) fail(`missing metric ${binding.metric_id}`);
  const lockedScope = binding.scope ?? {
    kind: binding.scope_kind ?? "repository",
    path: binding.scope_path ?? ".",
    language: "python",
    generated_code: false,
    included_in_human_maintainability: true,
  };
  for (const [label, actual, required] of [
    ["definition_id", metric.definition_id, binding.definition_id],
    ["subject", metric.subject, binding.subject ?? expected.bindings.repository_subject ?? "repository:committed-index"],
    ["value", metric.value, binding.value],
    ["unit", metric.unit, binding.unit],
    ["measurement.status", metric.measurement?.status, binding.measurement_status],
    ["scope", metric.scope, lockedScope],
    ["repository_revision", metric.repository_revision, expected.bindings.cqr_revision],
    ["source.repository_revision", metric.source?.repository_revision, expected.bindings.cqr_revision],
    ["analyzer_identity", metric.analyzer_identity, expected.bindings.analyzer_version],
    ["analyzer_version", metric.analyzer_version, expected.bindings.analyzer_version],
    ["comparability.configuration_hash", metric.comparability?.configuration_hash, expected.bindings.collector_configuration_hash ?? expected.bindings.static_configuration_hash],
  ]) assertEqual(`${binding.metric_id} ${label}`, actual, required);
  assertEqual(`${binding.metric_id} source kind`, metric.source?.kind, "exact-git-python-ast");
  assertEqual(`${binding.metric_id} collector`, metric.source?.collector_id, "python-static-intelligence");
  const artifactRefs = new Set(metric.source?.artifact_refs ?? []);
  const evidenceRefs = new Set(metric.source?.evidence_refs ?? []);
  for (const reference of [...requiredRefs(expected), ...(binding.required_refs ?? [])]) {
    if (!artifactRefs.has(reference)) fail(`${binding.metric_id} lacks artifact ref ${reference}`);
    if (!evidenceRefs.has(reference)) fail(`${binding.metric_id} lacks evidence ref ${reference}`);
  }
  const graphRefs = [...artifactRefs].filter((reference) => /^python-graph:sha256:[0-9a-f]{64}$/.test(reference));
  if (graphRefs.length !== 1 || !evidenceRefs.has(graphRefs[0])) fail(`${binding.metric_id} lacks one shared canonical Python graph identity`);
}

function verifyUnavailable(metric, binding, expected) {
  if (!metric) fail(`missing required unavailable metric ${binding.metric_id}`);
  assertEqual(`${binding.metric_id} definition_id`, metric.definition_id, binding.definition_id);
  assertEqual(`${binding.metric_id} unit`, metric.unit, binding.unit);
  assertEqual(`${binding.metric_id} status`, metric.measurement?.status, "unavailable");
  assertEqual(`${binding.metric_id} value`, metric.value, null);
  assertEqual(`${binding.metric_id} repository_revision`, metric.repository_revision, expected.bindings.cqr_revision);
  if (!String(metric.measurement?.reason ?? "").includes(binding.reason_includes)) {
    fail(`${binding.metric_id} unavailable reason lacks ${JSON.stringify(binding.reason_includes)}`);
  }
}

function verifyReport(reportBytes, snapshot, expected) {
  if (!Buffer.isBuffer(reportBytes)) fail("report must be supplied as exact bytes");
  const html = reportBytes.toString("utf8");
  if (/<(?:script|img|link|iframe|audio|video|source)\b[^>]*(?:src|href)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i.test(html)) {
    fail("report contains an external dependency");
  }
  const islands = [...html.matchAll(/<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/g)];
  if (islands.length !== 1) fail("report must contain exactly one embedded snapshot island");
  let embedded;
  try { embedded = JSON.parse(islands[0][1]); } catch (error) { fail(`report snapshot island is invalid (${error.message})`); }
  assertEqual("report snapshot island", embedded, snapshot);
  for (const fragment of expected.required_report_text ?? []) {
    if (!html.includes(fragment)) fail(`report lacks required text ${JSON.stringify(fragment)}`);
  }
}

function verifyPerformance(coldPerformance, warmPerformance, expected) {
  const cold = requireObject(coldPerformance?.python_static_intelligence, "cold Python telemetry");
  const warm = requireObject(warmPerformance?.python_static_intelligence, "warm Python telemetry");
  if (!new Set(["available", "degraded"]).has(cold.status) || warm.status !== cold.status) {
    fail("cold/warm Python analyzer status must be equally available or degraded");
  }
  for (const [label, value] of [
    ["cold timeouts", cold.timeouts], ["warm timeouts", warm.timeouts],
    ["cold cancellations", cold.cancelled], ["warm cancellations", warm.cancelled],
  ]) assertEqual(label, value, 0);
  if (!Number.isSafeInteger(cold.recomputed) || cold.recomputed <= 0) fail("cold run must recompute bounded analyzer evidence");
  if (!Number.isSafeInteger(cold.subprocess_count) || cold.subprocess_count <= 0) fail("cold run must execute at least one analyzer subprocess");
  if (!Number.isSafeInteger(warm.cache_hits) || warm.cache_hits < expected.inventory.parsed_file_count) {
    fail("warm run must reuse every independently expected parsed Python file");
  }
  assertEqual("warm recomputed count", warm.recomputed, 0);
  assertEqual("warm subprocess count", warm.subprocess_count, 0);
  const uniqueBlobCount = expected.inventory.unique_python_blob_count ?? expected.inventory.parsed_file_count;
  if ((cold.cache?.parse?.misses ?? 0) < uniqueBlobCount) fail("cold parse-cache misses do not cover the expected unique Python blobs");
  if ((warm.cache?.parse?.hits ?? 0) < uniqueBlobCount) fail("warm parse-cache hits do not cover the expected unique Python blobs");
  if ((cold.cache?.graph?.misses ?? 0) < 1 || (warm.cache?.graph?.hits ?? 0) < 1) fail("cold/warm graph-cache evidence is incomplete");
}

function verifyProductArtifacts(input) {
  const expected = requireObject(input?.expected, "expected fixture");
  assertEqual("expected schema", expected.schema_version, "sei.cqr-python-static-expected@1");
  requireObject(expected.bindings, "expected bindings");
  requireObject(expected.inventory, "expected inventory");
  const snapshot = parseJsonBytes(input.snapshotBytes, "cold snapshot");
  const repeatSnapshot = parseJsonBytes(input.repeatSnapshotBytes, "warm snapshot");
  if (!input.snapshotBytes.equals(input.repeatSnapshotBytes)) fail("cold/warm snapshot bytes are nondeterministic");
  if (!input.reportBytes.equals(input.repeatReportBytes)) fail("cold/warm report bytes are nondeterministic");
  assertEqual("cold/warm snapshot values", snapshot, repeatSnapshot);
  assertEqual("snapshot schema", snapshot.schema_version, "1.0.0");
  assertEqual("snapshot repository revision", snapshot.repository?.revision, expected.bindings.cqr_revision);

  const live = requireObject(input.liveBindings, "live bindings");
  for (const key of [
    "cqr_revision", "cqr_root_tree", "sei_product_revision", "repository_index_digest",
    "repository_classification_policy_version", "static_configuration_hash",
    "collector_configuration_hash",
    "python_implementation", "python_version", "inventory_digest",
    "repository_subject",
  ]) assertEqual(`live ${key}`, live[key], expected.bindings[key]);
  for (const key of ["python_file_count", "production_file_count", "test_file_count", "unique_python_blob_count"]) {
    assertEqual(`live inventory ${key}`, live.inventory?.[key], expected.inventory[key]);
  }
  assertEqual("committed product module hashes", live.committed_product_hashes ?? {}, expected.bindings.committed_product_hashes ?? {});

  const collector = snapshot.collectors?.find((candidate) => candidate.collector_id === "python-static-intelligence");
  if (!collector) fail("snapshot lacks python-static-intelligence collector");
  if (!new Set(["available", "degraded"]).has(collector.status)) fail("Python collector is not available or degraded");
  assertEqual("collector analyzer identity", collector.analyzer_identity, expected.bindings.analyzer_version);
  assertEqual("collector analyzer version", collector.analyzer_version, expected.bindings.analyzer_version);

  const metrics = new Map((snapshot.measurements ?? []).map((metric) => [metric.metric_id, metric]));
  if (metrics.size !== (snapshot.measurements ?? []).length) fail("snapshot contains duplicate metric IDs");
  for (const binding of expected.metric_bindings ?? []) verifyMetric(metrics.get(binding.metric_id), binding, expected);
  for (const binding of expected.required_unavailable_metrics ?? []) verifyUnavailable(metrics.get(binding.metric_id), binding, expected);
  verifyReport(input.reportBytes, snapshot, expected);
  verifyReport(input.repeatReportBytes, repeatSnapshot, expected);
  verifyPerformance(input.coldPerformance, input.warmPerformance, expected);

  const pythonMetrics = (snapshot.measurements ?? [])
    .filter((metric) => metric.source?.collector_id === "python-static-intelligence")
    .sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  const canonicalDigest = sha256(canonicalJson({ collector, metrics: pythonMetrics }));
  return {
    kind: "sei-cqr-python-static-oracle-receipt-v1",
    status: "PASS",
    product_verdict: "PASS",
    cqr_revision: expected.bindings.cqr_revision,
    cqr_root_tree: expected.bindings.cqr_root_tree,
    sei_product_revision: expected.bindings.sei_product_revision,
    canonical_digest: canonicalDigest,
    cold_snapshot_sha256: sha256(input.snapshotBytes),
    warm_snapshot_sha256: sha256(input.repeatSnapshotBytes),
    cold_report_sha256: sha256(input.reportBytes),
    warm_report_sha256: sha256(input.repeatReportBytes),
    production_modules_imported_by_oracle: false,
  };
}

function parseRunnerReceipt(bytes, label) {
  const lines = bytes.toString("utf8").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) fail(`${label} emitted a non-canonical stdout envelope`);
  return parseJsonBytes(Buffer.from(lines[0], "utf8"), `${label} receipt`);
}

function invokeProduct(options, out, performanceName) {
  const runner = path.join(options.seiRoot, "skills", "software-engineering-intelligence", "scripts", "run-sei.js");
  if (!fs.statSync(runner, { throwIfNoEntry: false })?.isFile()) fail(`SEI runner is absent: ${runner}`);
  const performancePath = path.join(out, performanceName);
  const stdout = runProcess(process.execPath, [runner,
    "--repo", options.repo,
    "--out", out,
    "--performance-json", performancePath,
    "--python", options.python,
  ], { cwd: options.seiRoot, label: `committed SEI ${performanceName}`, timeout: 10 * 60_000 });
  const receipt = parseRunnerReceipt(stdout, performanceName);
  if (receipt.revision !== options.revision) fail(`${performanceName} receipt revision disagreed with the exact CQR revision`);
  for (const [label, artifactPath] of [["snapshot", receipt.snapshot_path], ["report", receipt.report_path], ["performance", performancePath]]) {
    if (typeof artifactPath !== "string" || !fs.statSync(artifactPath, { throwIfNoEntry: false })?.isFile()) {
      fail(`${performanceName} ${label} artifact is absent`);
    }
  }
  return {
    receipt,
    snapshotBytes: fs.readFileSync(receipt.snapshot_path),
    reportBytes: fs.readFileSync(receipt.report_path),
    performance: JSON.parse(fs.readFileSync(performancePath, "utf8")),
  };
}

function ensureFreshOutput(requested) {
  if (requested === null) return fs.mkdtempSync(path.join(os.tmpdir(), "sei-cqr-python-static-"));
  const resolved = path.resolve(requested);
  if (fs.existsSync(resolved)) fail("--out must identify a fresh absent path");
  fs.mkdirSync(resolved, { recursive: false });
  return resolved;
}

function main(argv) {
  const options = parseArguments(argv);
  for (const key of ["repo", "seiRoot"]) {
    if (!fs.statSync(options[key], { throwIfNoEntry: false })?.isDirectory()) fail(`--${key === "seiRoot" ? "sei-root" : key} must identify an existing directory`);
  }
  if (!fs.statSync(options.expected, { throwIfNoEntry: false })?.isFile()) fail("--expected must identify an existing file");
  const expected = JSON.parse(fs.readFileSync(options.expected, "utf8"));
  const beforeStatus = runGit(options.repo, ["status", "--porcelain=v1", "--untracked-files=all"], { label: "CQR pre-run status" });
  if (beforeStatus.length !== 0) fail("CQR oracle requires a clean read-only working tree at the exact revision");
  const liveBindings = deriveLiveBindings(options, expected);
  const out = ensureFreshOutput(options.out);
  const cold = invokeProduct(options, out, "python-static-cold.performance.json");
  const warm = invokeProduct(options, out, "python-static-warm.performance.json");
  const afterStatus = runGit(options.repo, ["status", "--porcelain=v1", "--untracked-files=all"], { label: "CQR post-run status" });
  if (!beforeStatus.equals(afterStatus)) fail("read-only CQR working-tree bytes changed during product execution");
  const receipt = verifyProductArtifacts({
    expected,
    snapshotBytes: cold.snapshotBytes,
    repeatSnapshotBytes: warm.snapshotBytes,
    reportBytes: cold.reportBytes,
    repeatReportBytes: warm.reportBytes,
    coldPerformance: cold.performance,
    warmPerformance: warm.performance,
    liveBindings,
  });
  const complete = {
    ...receipt,
    oracle_schema_version: "sei.cqr-python-static-oracle-receipt@1",
    output_root: out,
    expected_fixture_sha256: sha256(fs.readFileSync(options.expected)),
    oracle_script_sha256: sha256(fs.readFileSync(__filename)),
    oracle_test_sha256: sha256(fs.readFileSync(path.join(__dirname, "verify-cqr-python-static.test.js"))),
    repository_index_digest: liveBindings.repository_index_digest,
    static_configuration_hash: liveBindings.static_configuration_hash,
    inventory_digest: liveBindings.inventory_digest,
    committed_product_hashes: liveBindings.committed_product_hashes,
    cqr_status_before_sha256: sha256(beforeStatus),
    cqr_status_after_sha256: sha256(afterStatus),
    cold_performance_sha256: sha256(fs.readFileSync(path.join(out, "python-static-cold.performance.json"))),
    warm_performance_sha256: sha256(fs.readFileSync(path.join(out, "python-static-warm.performance.json"))),
  };
  fs.writeFileSync(path.join(out, "oracle-receipt.json"), `${JSON.stringify(complete, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify(complete)}\n`);
  return complete;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  deriveIndependentIndex,
  deriveLiveBindings,
  deriveCollectorConfigurationHash,
  deriveStaticConfigurationHash,
  main,
  parseArguments,
  verifyProductArtifacts,
};
