"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AUTOMATIC_BASELINE_MAX_CANDIDATES,
  AUTOMATIC_BASELINE_MAX_INVENTORY_BYTES,
} = require("./trend-baseline.js");
const dependencyInvalidationPrivate = require("./dependency-invalidation.js")[Symbol.for("sei.dependency-invalidation.private@1")];
const predictiveFilesystemPrivate = require("./predictive-native-fs.js")[Symbol.for("sei.predictive-native-fs.private.v1")];

const STATIC_SCHEMA_VERSION = "sei.incremental-static-state@2";
const LEGACY_STATIC_SCHEMA_VERSION = "sei.incremental-static-state@1";
const HISTORY_SCHEMA_VERSION = "sei.incremental-git-history-state@1";
const MAX_STAGE_FILES = 512;
const MAX_STAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_STAGE_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_ASSESSMENT_FILES = 64;
const MAX_ASSESSMENT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_ENTRIES = 100_000;
const MAX_HISTORY_COMMITS = 1_000_000;
const STABLE_STATE_ROOT_ENV = "SEI_INCREMENTAL_STATE_ROOT";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RELATIVE_PATH = /^(?![A-Za-z]:)(?!\/)(?!\\)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\0]+$/;
const stageState = new WeakMap();
const stateWriterState = new WeakMap();
const SESSION_INPUT_KEYS = new Set([
  "assessment_config_sha256",
  "automatic_baseline_inventory_binding",
  "collector_configuration_hash",
  "config_bytes_sha256",
  "execution_contract_hash",
  "explicit_baseline_binding",
  "external_input_bindings",
  "history_window",
  "mode",
  "output_root",
  "performance_output_path",
  "repository",
  "repository_index_binding",
  "runtime_binding",
  "state_root",
  "signal",
  "source_tree_clean",
]);

const STATIC_BINDING_KEYS = Object.freeze([
  "analyzer_identity",
  "analyzer_version",
  "classification_policy_version",
  "collector_version",
  "configuration_hash",
  "index_digest",
  "object_format",
  "repository_id",
  "repository_revision",
  "root_tree_oid",
]);
const STATIC_ENTRY_KEYS = Object.freeze([
  "blob_oid",
  "content_key",
  "entry_key",
  "generated_classification_known",
  "generated_code",
  "included_in_human_maintainability",
  "language",
  "lexical_function_count",
  "lexical_max_nesting_depth",
  "mode",
  "path",
  "source_lines",
]);
const HISTORY_BINDING_KEYS = Object.freeze([
  "analyzer_identity",
  "analyzer_version",
  "collector_version",
  "configuration_hash",
  "history_end",
  "history_kind",
  "history_start",
  "object_format",
  "repository_id",
  "temporal_policy_hash",
]);
const COMMIT_KEYS = Object.freeze(["author", "files", "is_merge", "revision", "timestamp"]);
const FILE_KEYS = Object.freeze(["added", "binary_change", "change_kind", "deleted", "path"]);
const RENAMED_FILE_KEYS = Object.freeze([...FILE_KEYS, "previous_path"].sort());

function fail(detail, cause = undefined) {
  const error = cause === undefined
    ? new Error(`FAIL-INCREMENTAL-STATE: ${detail}`)
    : new Error(`FAIL-INCREMENTAL-STATE: ${detail}`, { cause });
  error.code = "FAIL-INCREMENTAL-STATE";
  throw error;
}

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function canonicalResolvedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalStateRoot(value) {
  if (!nonempty(value) || !path.isAbsolute(value) || value.includes("\0")) {
    fail("state_root must be an absolute NUL-free path");
  }
  if (process.platform !== "win32") return path.resolve(value);
  if (!/^[A-Z]:\\/.test(value) || value.includes("/")
      || (value.length > 3 && value.endsWith("\\"))
      || path.win32.normalize(value) !== value) {
    fail("state_root must use one canonical uppercase-drive DOS absolute spelling");
  }
  return value;
}

function nativeWriterRoot(stateRootPath) {
  if (process.platform !== "win32" || predictiveFilesystemPrivate?.helperIdentity === null) return null;
  try {
    return predictiveFilesystemPrivate.openRoot(stateRootPath);
  } catch (error) {
    fail("state_root is not one canonical physical native root", error);
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

function prettyJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort(stableCompare)) === canonicalJson([...keys].sort(stableCompare));
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function objectIdPattern(format) {
  if (format === "sha1") return /^[0-9a-f]{40}$/;
  if (format === "sha256") return /^[0-9a-f]{64}$/;
  fail("binding object_format is unsupported");
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function normalizedRelativePath(value, label) {
  if (!nonempty(value)) fail(`${label} must be a non-empty NUL-free path`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!RELATIVE_PATH.test(normalized) || path.posix.isAbsolute(normalized)) fail(`${label} must be a contained relative path`);
  return normalized;
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeStaticBinding(value) {
  if (!exactKeys(value, STATIC_BINDING_KEYS)) fail("static binding is not closed");
  const oid = objectIdPattern(value.object_format);
  if (!nonempty(value.repository_id)
      || !oid.test(value.repository_revision)
      || !oid.test(value.root_tree_oid)
      || !SHA256.test(value.index_digest)
      || !nonempty(value.classification_policy_version)
      || !nonempty(value.collector_version)
      || !nonempty(value.analyzer_identity)
      || !nonempty(value.analyzer_version)
      || !/^[0-9a-f]{64}$/.test(value.configuration_hash)) {
    fail("static binding fields are invalid");
  }
  return canonicalValue(value);
}

function normalizeStaticEntries(values, binding) {
  if (!Array.isArray(values) || values.length > MAX_STATIC_ENTRIES) fail("static entries exceeded the closed bound");
  const oid = objectIdPattern(binding.object_format);
  const paths = new Set();
  return values.map((value, index) => {
    if (!exactKeys(value, STATIC_ENTRY_KEYS)) fail(`static entry ${index} is not closed`);
    const entryPath = normalizedRelativePath(value.path, `static entry ${index} path`);
    if (paths.has(entryPath)) fail(`duplicate static path ${entryPath}`);
    paths.add(entryPath);
    if (!oid.test(value.blob_oid)
        || value.content_key !== `git-blob:${binding.object_format}:${value.blob_oid}`
        || !SHA256.test(value.entry_key)
        || !new Set(["100644", "100755"]).has(value.mode)
        || !nonempty(value.language)
        || typeof value.generated_code !== "boolean"
        || typeof value.generated_classification_known !== "boolean"
        || typeof value.included_in_human_maintainability !== "boolean"
        || value.included_in_human_maintainability !== (value.generated_classification_known && !value.generated_code)
        || !integer(value.source_lines)
        || !integer(value.lexical_function_count)
        || !integer(value.lexical_max_nesting_depth)) {
      fail(`static entry ${index} fields are invalid`);
    }
    return canonicalValue({ ...value, path: entryPath });
  }).sort((left, right) => stableCompare(left.path, right.path));
}

function normalizeHistoryBinding(value) {
  if (!exactKeys(value, HISTORY_BINDING_KEYS)) fail("history binding is not closed");
  const oid = objectIdPattern(value.object_format);
  if (!nonempty(value.repository_id)
      || !new Set(["revision", "revision-range"]).has(value.history_kind)
      || (value.history_start !== null && !oid.test(value.history_start))
      || !oid.test(value.history_end)
      || !nonempty(value.collector_version)
      || !nonempty(value.analyzer_identity)
      || !nonempty(value.analyzer_version)
      || !/^[0-9a-f]{64}$/.test(value.configuration_hash)
      || !SHA256.test(value.temporal_policy_hash)) {
    fail("history binding fields are invalid");
  }
  return canonicalValue(value);
}

function normalizeHistoryFile(value, commitIndex, fileIndex) {
  const hasPrevious = Object.hasOwn(value ?? {}, "previous_path");
  if (!exactKeys(value, hasPrevious ? RENAMED_FILE_KEYS : FILE_KEYS)) {
    fail(`history commit ${commitIndex} file ${fileIndex} is not closed`);
  }
  const filePath = normalizedRelativePath(value.path, `history commit ${commitIndex} file ${fileIndex} path`);
  const binary = value.binary_change === true;
  const kind = value.change_kind;
  if (typeof value.binary_change !== "boolean"
      || !new Set(["add", "copy", "delete", "modify", "rename", "type_change", "other"]).has(kind)
      || (binary ? value.added !== null || value.deleted !== null : !integer(value.added) || !integer(value.deleted))) {
    fail(`history commit ${commitIndex} file ${fileIndex} fields are invalid`);
  }
  if ((kind === "copy" || kind === "rename") !== hasPrevious) {
    fail(`history commit ${commitIndex} file ${fileIndex} previous_path is incoherent`);
  }
  const normalized = { ...value, path: filePath };
  if (hasPrevious) normalized.previous_path = normalizedRelativePath(value.previous_path, `history commit ${commitIndex} file ${fileIndex} previous_path`);
  return canonicalValue(normalized);
}

function normalizeCommits(values, binding) {
  if (!Array.isArray(values) || values.length > MAX_HISTORY_COMMITS) fail("history commits exceeded the closed bound");
  const oid = objectIdPattern(binding.object_format);
  const revisions = new Set();
  return values.map((value, commitIndex) => {
    if (!exactKeys(value, COMMIT_KEYS)) fail(`history commit ${commitIndex} is not closed`);
    const revision = String(value.revision ?? "").toLowerCase();
    if (!oid.test(revision)) fail(`history commit ${commitIndex} revision is invalid`);
    if (revisions.has(revision)) fail(`duplicate history revision ${revision}`);
    revisions.add(revision);
    if (!nonempty(value.author) || typeof value.is_merge !== "boolean" || !Array.isArray(value.files)) {
      fail(`history commit ${commitIndex} fields are invalid`);
    }
    let timestamp;
    try {
      timestamp = new Date(value.timestamp).toISOString();
    } catch {
      fail(`history commit ${commitIndex} timestamp is not normalized ISO`);
    }
    if (typeof value.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value.timestamp) || timestamp !== value.timestamp) {
      fail(`history commit ${commitIndex} timestamp is not normalized ISO`);
    }
    const seenPaths = new Set();
    const files = value.files.map((file, fileIndex) => normalizeHistoryFile(file, commitIndex, fileIndex))
      .sort((left, right) => stableCompare(left.path, right.path));
    for (const file of files) {
      if (seenPaths.has(file.path)) fail(`history commit ${commitIndex} duplicates path ${file.path}`);
      seenPaths.add(file.path);
    }
    return canonicalValue({ revision, timestamp, author: value.author, is_merge: value.is_merge, files });
  }).sort((left, right) => stableCompare(left.timestamp, right.timestamp) || stableCompare(left.revision, right.revision));
}

function buildDocument(kind, binding, records, options = {}) {
  const schemaVersion = kind === "static"
    ? options.schemaVersion ?? STATIC_SCHEMA_VERSION
    : HISTORY_SCHEMA_VERSION;
  const recordKey = kind === "static" ? "entries" : "commits";
  const body = {
    schema_version: schemaVersion,
    kind,
    binding,
    [recordKey]: records,
    record_count: records.length,
  };
  if (kind === "static" && schemaVersion === STATIC_SCHEMA_VERSION) {
    body.dependency_state = options.dependencyState ?? null;
  }
  const canonicalBody = canonicalValue(body);
  return canonicalValue({ ...canonicalBody, artifact_sha256: sha256(canonicalJson(canonicalBody)) });
}

function validateDependencyStateBinding(snapshot, binding) {
  const indexBinding = snapshot.repositoryIndex.binding;
  if (indexBinding.repository_revision !== binding.repository_revision
      || indexBinding.root_tree_oid !== binding.root_tree_oid
      || indexBinding.object_format !== binding.object_format
      || indexBinding.index_digest !== binding.index_digest
      || indexBinding.classification_policy_version !== binding.classification_policy_version) {
    fail("static dependency state does not bind the compact static stage");
  }
}

function brandDocument(document, expectedKind, expectedDigest = null, expectedBytes = null) {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("stage document is invalid");
  const recordKey = expectedKind === "static" ? "entries" : "commits";
  const supportedSchema = expectedKind === "static"
    ? new Set([LEGACY_STATIC_SCHEMA_VERSION, STATIC_SCHEMA_VERSION])
    : new Set([HISTORY_SCHEMA_VERSION]);
  const documentKeys = ["artifact_sha256", "binding", "kind", "record_count", recordKey, "schema_version"];
  if (expectedKind === "static" && document.schema_version === STATIC_SCHEMA_VERSION) documentKeys.push("dependency_state");
  if (!exactKeys(document, documentKeys)
      || document.kind !== expectedKind || !supportedSchema.has(document.schema_version)) {
    fail("stage document kind or schema is invalid");
  }
  const binding = expectedKind === "static" ? normalizeStaticBinding(document.binding) : normalizeHistoryBinding(document.binding);
  const records = expectedKind === "static" ? normalizeStaticEntries(document.entries, binding) : normalizeCommits(document.commits, binding);
  let dependencyState = null;
  if (expectedKind === "static" && document.schema_version === STATIC_SCHEMA_VERSION && document.dependency_state !== null) {
    const dependencySnapshot = dependencyInvalidationPrivate.rehydratePortableSnapshot(document.dependency_state);
    validateDependencyStateBinding(dependencySnapshot, binding);
    dependencyState = dependencyInvalidationPrivate.portableSnapshot(dependencySnapshot);
  }
  if (document.record_count !== records.length) fail("stage record_count is invalid");
  const canonical = buildDocument(expectedKind, binding, records, {
    schemaVersion: document.schema_version,
    dependencyState,
  });
  if (document.artifact_sha256 !== canonical.artifact_sha256
      || (expectedDigest !== null && canonical.artifact_sha256 !== expectedDigest)) {
    fail("stage content digest is invalid");
  }
  const bytes = prettyJson(canonical);
  if (Buffer.byteLength(bytes) > MAX_STAGE_FILE_BYTES) fail("stage exceeded the closed byte bound");
  if (expectedBytes !== null && expectedBytes !== bytes) fail("stage bytes are not canonical");
  const frozen = deepFreeze(canonical);
  const stage = Object.freeze({});
  stageState.set(stage, Object.freeze({ kind: expectedKind, document: frozen, bytes }));
  return stage;
}

function createStaticStage({ binding, entries, dependency_snapshot: dependencySnapshot = null } = {}) {
  const normalizedBinding = normalizeStaticBinding(binding);
  let dependencyState = null;
  if (dependencySnapshot !== null) {
    const normalizedSnapshot = dependencyInvalidationPrivate.rehydratePortableSnapshot(
      dependencyInvalidationPrivate.portableSnapshot(dependencySnapshot),
    );
    validateDependencyStateBinding(normalizedSnapshot, normalizedBinding);
    dependencyState = dependencyInvalidationPrivate.portableSnapshot(normalizedSnapshot);
  }
  return brandDocument(buildDocument(
    "static",
    normalizedBinding,
    normalizeStaticEntries(entries, normalizedBinding),
    { dependencyState },
  ), "static");
}

function createHistoryStage({ binding, commits } = {}) {
  const normalizedBinding = normalizeHistoryBinding(binding);
  return brandDocument(buildDocument("history", normalizedBinding, normalizeCommits(commits, normalizedBinding)), "history");
}

function readStage(stage, expectedKind = null) {
  const state = stageState.get(stage);
  if (!state) fail("stage brand is invalid");
  if (expectedKind !== null && state.kind !== expectedKind) fail(`stage brand is not ${expectedKind}`);
  return state.document;
}

function readStaticDependencySnapshot(stage) {
  const document = readStage(stage, "static");
  if (document.dependency_state === undefined || document.dependency_state === null) return null;
  return dependencyInvalidationPrivate.rehydratePortableSnapshot(document.dependency_state);
}

function withStaticDependencySnapshot(stage, dependencySnapshot) {
  const document = readStage(stage, "static");
  return createStaticStage({
    binding: document.binding,
    entries: document.entries,
    dependency_snapshot: dependencySnapshot,
  });
}

function validateRootInput(outputRoot, repositoryId) {
  if (!nonempty(outputRoot) || !nonempty(repositoryId)) fail("output_root and repository_id must be nonblank");
}

function repositoryKey(repositoryId) {
  validateRootInput("state", repositoryId);
  return crypto.createHash("sha256").update(repositoryId).digest("hex");
}

function defaultStableStateRoot(repositoryId = null) {
  const candidates = [];
  if (typeof process.env[STABLE_STATE_ROOT_ENV] === "string"
      && path.isAbsolute(process.env[STABLE_STATE_ROOT_ENV])
      && !process.env[STABLE_STATE_ROOT_ENV].includes("\0")) {
    candidates.push(path.resolve(process.env[STABLE_STATE_ROOT_ENV]));
  }
  if (candidates.length === 0 && process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (typeof localAppData === "string" && path.isAbsolute(localAppData)) {
      candidates.push(path.join(localAppData, "sei", "incremental-run-state-v1"));
    } else {
      candidates.push(path.join(os.homedir(), "AppData", "Local", "sei", "incremental-run-state-v1"));
    }
  } else if (candidates.length === 0) {
    candidates.push(path.join(os.homedir(), ".cache", "sei", "incremental-run-state-v1"));
  }
  candidates.push(path.join(os.tmpdir(), "sei-incremental-run-state-v1"));
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      const probeParent = repositoryId === null ? candidate : path.join(candidate, repositoryKey(repositoryId));
      fs.mkdirSync(probeParent, { recursive: true });
      const probe = fs.mkdtempSync(path.join(probeParent, ".sei-state-probe-"));
      fs.rmdirSync(probe);
      return candidate;
    } catch { /* try the next stable per-user or temp root */ }
  }
  fail("no writable stable incremental state root is available");
}

function stateRoot({ output_root: outputRoot, repository_id: repositoryId, state_root: configuredStateRoot } = {}) {
  validateRootInput(outputRoot ?? "state", repositoryId);
  if (configuredStateRoot !== undefined && configuredStateRoot !== null) {
    return canonicalStateRoot(configuredStateRoot);
  }
  return path.join(defaultStableStateRoot(repositoryId), repositoryKey(repositoryId));
}

function cacheRoot({ output_root: outputRoot, repository_id: repositoryId, state_root: configuredStateRoot } = {}) {
  validateRootInput(outputRoot, repositoryId);
  if (configuredStateRoot !== undefined) {
    return stateRoot({ output_root: outputRoot, repository_id: repositoryId, state_root: configuredStateRoot });
  }
  return path.resolve(outputRoot, "incremental-run-state-v1", repositoryKey(repositoryId));
}

function stageDirectory(input, kind) {
  if (!new Set(["static", "history"]).has(kind)) fail("stage kind is unsupported");
  return path.join(cacheRoot(input), "stages", kind);
}

function artifactForStage({ output_root: outputRoot, state_root: configuredStateRoot, repository_id: repositoryId, stage } = {}) {
  const state = stageState.get(stage);
  if (!state) fail("stage brand is invalid");
  const digest = state.document.artifact_sha256.slice("sha256:".length);
  return Object.freeze({
    label: `INCREMENTAL_${state.kind.toUpperCase()}_STATE_${digest}`,
    path: path.join(stageDirectory({ output_root: outputRoot, state_root: configuredStateRoot, repository_id: repositoryId }, state.kind), `${digest}.json`),
    bytes: state.bytes,
  });
}

function discoverStages({ output_root: outputRoot, state_root: configuredStateRoot, repository_id: repositoryId, kind } = {}) {
  const directory = stageDirectory({ output_root: outputRoot, state_root: configuredStateRoot, repository_id: repositoryId }, kind);
  const telemetry = { examined: 0, accepted: 0, rejected: 0, bounded: false, bytes: 0 };
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => stableCompare(left.name, right.name));
  } catch (error) {
    if (error.code === "ENOENT") return Object.freeze({ stages: Object.freeze([]), telemetry: Object.freeze(telemetry) });
    return Object.freeze({ stages: Object.freeze([]), telemetry: Object.freeze({ ...telemetry, rejected: 1 }) });
  }
  if (entries.length > MAX_STAGE_FILES) {
    return Object.freeze({ stages: Object.freeze([]), telemetry: Object.freeze({ ...telemetry, bounded: true, rejected: entries.length }) });
  }
  const stages = [];
  for (const entry of entries) {
    telemetry.examined += 1;
    if (!/^[0-9a-f]{64}\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      telemetry.rejected += 1;
      continue;
    }
    const filePath = path.join(directory, entry.name);
    let stats;
    try {
      stats = fs.lstatSync(filePath);
    } catch {
      telemetry.rejected += 1;
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_STAGE_FILE_BYTES
        || telemetry.bytes + stats.size > MAX_STAGE_AGGREGATE_BYTES) {
      telemetry.rejected += 1;
      if (telemetry.bytes + stats.size > MAX_STAGE_AGGREGATE_BYTES) telemetry.bounded = true;
      continue;
    }
    telemetry.bytes += stats.size;
    let bytes;
    let document;
    try {
      bytes = fs.readFileSync(filePath, "utf8");
      document = JSON.parse(bytes);
      const digest = `sha256:${entry.name.slice(0, 64)}`;
      stages.push(brandDocument(document, kind, digest, bytes));
      telemetry.accepted += 1;
    } catch {
      telemetry.rejected += 1;
    }
  }
  return Object.freeze({ stages: Object.freeze(stages), telemetry: Object.freeze(telemetry) });
}

function discoverSessionStages(binding, kind) {
  const primary = discoverStages({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
    kind,
  });
  if (binding.state_root === undefined || binding.state_root === null
      || canonicalResolvedPath(binding.state_root) === canonicalResolvedPath(path.resolve(binding.output_root, "incremental-run-state-v1", repositoryKey(binding.repository.repository_id)))) {
    return primary;
  }
  const legacy = discoverStages({
    output_root: binding.output_root,
    repository_id: binding.repository.repository_id,
    kind,
  });
  if (primary.stages.length > 0 || legacy.stages.length === 0) return primary;
  return Object.freeze({
    stages: legacy.stages,
    telemetry: Object.freeze({
      ...legacy.telemetry,
      legacy_fallback: true,
      primary: primary.telemetry,
    }),
  });
}

function snapshotFileName(bytes) {
  let snapshot;
  try { snapshot = JSON.parse(bytes); } catch { return null; }
  const snapshotId = snapshot?.snapshot_id;
  return typeof snapshotId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(snapshotId)
    ? `${snapshotId}.json`
    : null;
}

function persistSnapshotInState(binding, bytes) {
  const fileName = snapshotFileName(bytes);
  if (fileName === null) return null;
  const root = path.join(cacheRoot({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
  }), "snapshots");
  try { fs.mkdirSync(root, { recursive: true }); } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT") return null;
    throw error;
  }
  const target = path.join(root, fileName);
  let existing;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") publicationFail(`canonical snapshot persistence read failed: ${error.code ?? error.message}`);
  }
  if (existing !== undefined) {
    if (existing !== bytes) immutableArtifactFail("SNAPSHOT-STATE", `existing state snapshot differs at ${target}`);
    return target;
  }
  const stagingRoot = fs.mkdtempSync(path.join(root, ".sei-snapshot-"));
  const staged = path.join(stagingRoot, fileName);
  try {
    fs.writeFileSync(staged, bytes, { encoding: "utf8", flag: "wx" });
    fs.linkSync(staged, target);
  } catch (error) {
    if (error.code === "EEXIST") {
      const concurrent = fs.readFileSync(target, "utf8");
      if (concurrent !== bytes) immutableArtifactFail("SNAPSHOT-STATE", `concurrent state snapshot differs at ${target}`);
    } else {
      publicationFail(`canonical snapshot persistence failed: ${error.code ?? error.message}`);
    }
  } finally {
    try { fs.unlinkSync(staged); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { fs.rmdirSync(stagingRoot); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
  return target;
}

function assessmentFileName(bytes) {
  let assessment;
  try { assessment = JSON.parse(bytes); } catch { return null; }
  const id = assessment?.assessment_id;
  return typeof id === "string" && /^sha256:[0-9a-f]{64}$/.test(id)
    ? `${id.slice("sha256:".length)}.json`
    : null;
}

function persistAssessmentInState(binding, bytes) {
  const fileName = assessmentFileName(bytes);
  if (fileName === null) return null;
  const root = path.join(cacheRoot({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
  }), "assessments");
  try { fs.mkdirSync(root, { recursive: true }); } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT") return null;
    throw error;
  }
  const target = path.join(root, fileName);
  let existing;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") publicationFail(`assessment persistence read failed: ${error.code ?? error.message}`);
  }
  if (existing !== undefined) {
    if (existing !== bytes) immutableArtifactFail("ASSESSMENT-STATE", `existing state assessment differs at ${target}`);
    return target;
  }
  const stagingRoot = fs.mkdtempSync(path.join(root, ".sei-assessment-"));
  const staged = path.join(stagingRoot, fileName);
  try {
    fs.writeFileSync(staged, bytes, { encoding: "utf8", flag: "wx" });
    fs.linkSync(staged, target);
  } catch (error) {
    if (error.code === "EEXIST") {
      const concurrent = fs.readFileSync(target, "utf8");
      if (concurrent !== bytes) immutableArtifactFail("ASSESSMENT-STATE", `concurrent state assessment differs at ${target}`);
    } else {
      publicationFail(`assessment persistence failed: ${error.code ?? error.message}`);
    }
  } finally {
    try { fs.unlinkSync(staged); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { fs.rmdirSync(stagingRoot); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
  return target;
}

const ASSESSMENT_PROFILE_BINDING_VERSION = "sei.assessment-profile-binding@1";

function assessmentProfileBindingPath(binding, assessmentFile) {
  const profileKey = binding.assessment_config_sha256 === null
    ? "no-profile"
    : binding.assessment_config_sha256.slice("sha256:".length);
  return path.join(cacheRoot({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
  }), "assessment-profile-bindings", `${profileKey}.${assessmentFile}`);
}

function assessmentProfileBindingBytes(binding, bytes) {
  const fileName = assessmentFileName(bytes);
  if (fileName === null) return null;
  return {
    fileName,
    bytes: prettyJson({
      schema_version: ASSESSMENT_PROFILE_BINDING_VERSION,
      assessment_config_sha256: binding.assessment_config_sha256,
      assessment_id: JSON.parse(bytes).assessment_id,
    }),
  };
}

// A persisted assessment is only replayable for the assessment profile that
// produced it. The assessment document cannot carry that identity itself (its
// standard digest does not cover coverage_gate or target policy inputs), so the
// producing profile digest is recorded in an immutable sidecar beside it.
function persistAssessmentProfileBinding(binding, bytes) {
  const record = assessmentProfileBindingBytes(binding, bytes);
  if (record === null) return null;
  const target = assessmentProfileBindingPath(binding, record.fileName);
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT") return null;
    throw error;
  }
  try {
    fs.writeFileSync(target, record.bytes, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") publicationFail(`assessment profile binding persistence failed: ${error.code ?? error.message}`);
    const existing = fs.readFileSync(target, "utf8");
    if (existing !== record.bytes) immutableArtifactFail("ASSESSMENT-PROFILE-BINDING", `existing assessment profile binding differs at ${target}`);
  }
  return target;
}

function assessmentsBoundToProfile(binding, candidates) {
  if (!Array.isArray(candidates)) return Object.freeze([]);
  return Object.freeze(candidates.filter((candidate) => {
    try {
      const record = assessmentProfileBindingBytes(binding, candidate.bytes);
      if (record === null) return false;
      const target = assessmentProfileBindingPath(binding, record.fileName);
      const stats = fs.lstatSync(target);
      if (!stats.isFile() || stats.isSymbolicLink()) return false;
      return fs.readFileSync(target, "utf8") === record.bytes;
    } catch { return false; }
  }));
}

function reportFileName(bytes) {
  return `${sha256(bytes).slice("sha256:".length)}.html`;
}

function persistReportInState(binding, bytes) {
  if (binding.state_root === undefined || binding.state_root === null) return null;
  const fileName = reportFileName(bytes);
  const root = path.join(cacheRoot({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
  }), "reports");
  try { fs.mkdirSync(root, { recursive: true }); } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT") return null;
    throw error;
  }
  const target = path.join(root, fileName);
  let existing;
  try { existing = fs.readFileSync(target, "utf8"); } catch (error) {
    if (error.code !== "ENOENT") publicationFail(`report persistence read failed: ${error.code ?? error.message}`);
  }
  if (existing !== undefined) {
    if (existing !== bytes) immutableArtifactFail("REPORT-STATE", `existing state report differs at ${target}`);
    return target;
  }
  const stagingParent = path.parse(root).root.toLowerCase() === path.parse(os.tmpdir()).root.toLowerCase()
    ? os.tmpdir()
    : root;
  const stagingRoot = fs.mkdtempSync(path.join(stagingParent, ".sei-report-"));
  const staged = path.join(stagingRoot, fileName);
  try {
    fs.writeFileSync(staged, bytes, { encoding: "utf8", flag: "wx" });
    fs.linkSync(staged, target);
  } catch (error) {
    if (error.code === "EEXIST") {
      const concurrent = fs.readFileSync(target, "utf8");
      if (concurrent !== bytes) immutableArtifactFail("REPORT-STATE", `concurrent state report differs at ${target}`);
    } else publicationFail(`report persistence failed: ${error.code ?? error.message}`);
  } finally {
    try { fs.unlinkSync(staged); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { fs.rmdirSync(stagingRoot); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
  return target;
}

function persistedArtifactPath(binding, label, relativePath, artifactDigest = null) {
  const fileName = path.basename(relativePath);
  if (label === "SNAPSHOT" && fileName.endsWith(".json")) {
    return path.join(cacheRoot({
      output_root: binding.output_root,
      state_root: binding.state_root,
      repository_id: binding.repository.repository_id,
    }), "snapshots", fileName);
  }
  if (label === "REPORT" && fileName.endsWith(".html")) {
    if (!SHA256.test(artifactDigest ?? "")) return null;
    return path.join(cacheRoot({
      output_root: binding.output_root,
      state_root: binding.state_root,
      repository_id: binding.repository.repository_id,
    }), "reports", `${artifactDigest.slice("sha256:".length)}.html`);
  }
  return null;
}

function discoverPersistedAssessments(binding) {
  const root = path.join(cacheRoot({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
  }), "assessments");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^[0-9a-f]{64}\.json$/.test(entry.name))
      .sort((left, right) => stableCompare(left.name, right.name));
  } catch (error) {
    if (error.code === "ENOENT") return Object.freeze([]);
    return Object.freeze([]);
  }
  const discovered = [];
  for (const entry of entries.slice(0, MAX_ASSESSMENT_FILES)) {
    const candidatePath = path.join(root, entry.name);
    try {
      const stats = fs.lstatSync(candidatePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_ASSESSMENT_FILE_BYTES) continue;
      const bytes = fs.readFileSync(candidatePath, "utf8");
      if (assessmentFileName(bytes) !== entry.name) continue;
      discovered.push(Object.freeze({ path: candidatePath, bytes, assessment: JSON.parse(bytes) }));
    } catch { /* corrupt state is ignored; the current run remains authoritative */ }
  }
  return Object.freeze(discovered);
}

function importLegacySnapshots(binding) {
  if (binding.state_root === undefined || binding.state_root === null) return;
  const legacyRoot = path.resolve(binding.output_root, "snapshots");
  const stableRoot = path.resolve(cacheRoot({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
  }), "snapshots");
  if (canonicalResolvedPath(legacyRoot) === canonicalResolvedPath(stableRoot)) return;
  let entries;
  try {
    entries = fs.readdirSync(legacyRoot, { withFileTypes: true }).sort((left, right) => stableCompare(left.name, right.name));
  } catch (error) {
    if (error.code === "ENOENT") return;
    return;
  }
  if (entries.length > AUTOMATIC_BASELINE_MAX_CANDIDATES) return;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.json$/.test(entry.name)) continue;
    let bytes;
    try {
      const stats = fs.lstatSync(path.join(legacyRoot, entry.name));
      if (stats.size <= 0 || stats.size > MAX_STAGE_FILE_BYTES) continue;
      bytes = fs.readFileSync(path.join(legacyRoot, entry.name), "utf8");
    } catch { continue; }
    if (snapshotFileName(bytes) !== entry.name) continue;
    try { persistSnapshotInState(binding, bytes); } catch { /* legacy import is best effort; current validation remains fail-closed */ }
  }
}

function automaticBaselineInventoryBinding(outputRoot, additions = [], configuredStateRoot = null) {
  if (!nonempty(outputRoot)) fail("automatic baseline inventory requires a nonblank output root");
  if (!Array.isArray(additions) || additions.some((addition) => (
    !addition || typeof addition !== "object" || Array.isArray(addition)
    || !exactKeys(addition, ["bytes", "name"])
    || !/^[^\\/\0]+\.json$/.test(addition.name)
    || typeof addition.bytes !== "string"
  ))) fail("automatic baseline inventory additions are invalid");
  const snapshotRoots = [...new Set([
    path.resolve(configuredStateRoot ?? outputRoot, "snapshots"),
    ...(configuredStateRoot === null ? [] : [path.resolve(outputRoot, "snapshots")]),
  ])];
  const candidates = [];
  const names = new Set();
  let totalBytes = 0;
  let bounded = false;
  for (const snapshotRoot of snapshotRoots) {
    let entries;
    try {
      entries = fs.readdirSync(snapshotRoot, { withFileTypes: true }).sort((left, right) => stableCompare(left.name, right.name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return deepFreeze(canonicalValue({
        schema_version: "sei.automatic-baseline-inventory@1",
        status: "unavailable",
        digest: sha256(canonicalJson([])),
        candidate_count: 0,
        total_bytes: 0,
      }));
    }
    if (entries.length > 2_048) {
      bounded = true;
      break;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(".json") || names.has(entry.name)) continue;
      if (candidates.length >= AUTOMATIC_BASELINE_MAX_CANDIDATES) {
        bounded = true;
        break;
      }
      const filePath = path.join(snapshotRoot, entry.name);
      let stats;
      try { stats = fs.lstatSync(filePath); } catch { bounded = true; break; }
      if (!entry.isFile() || !stats.isFile() || stats.isSymbolicLink()) continue;
      totalBytes += stats.size;
      if (totalBytes > AUTOMATIC_BASELINE_MAX_INVENTORY_BYTES) { bounded = true; break; }
      let bytes;
      try { bytes = fs.readFileSync(filePath); } catch { bounded = true; break; }
      candidates.push({ name: entry.name, size: stats.size, sha256: sha256(bytes) });
      names.add(entry.name);
    }
    if (bounded) break;
  }
  if (!bounded) {
    for (const addition of [...additions].sort((left, right) => stableCompare(left.name, right.name))) {
      if (names.has(addition.name)) continue;
      totalBytes += Buffer.byteLength(addition.bytes);
      if (candidates.length >= AUTOMATIC_BASELINE_MAX_CANDIDATES || totalBytes > AUTOMATIC_BASELINE_MAX_INVENTORY_BYTES) {
        bounded = true;
        break;
      }
      candidates.push({ name: addition.name, size: Buffer.byteLength(addition.bytes), sha256: sha256(addition.bytes) });
      names.add(addition.name);
    }
    candidates.sort((left, right) => stableCompare(left.name, right.name));
  }
  const status = bounded ? "bounded" : "available";
  const digestInput = bounded ? [] : candidates;
  return deepFreeze(canonicalValue({
    schema_version: "sei.automatic-baseline-inventory@1",
    status,
    digest: sha256(canonicalJson(digestInput)),
    candidate_count: bounded ? 0 : candidates.length,
    total_bytes: bounded ? 0 : totalBytes,
  }));
}

function runBindingWithInventory(binding, inventory) {
  const { output_root: _outputRoot, performance_output_path: _performanceOutputPath, signal: _signal, ...identity } = binding;
  return canonicalValue({ ...identity, automatic_baseline_inventory_binding: inventory });
}

function runKey(binding) {
  // @2 added assessment_config_sha256 to the binding. An @1 manifest can never
  // match an @2 key (and vice versa), so a cross-version read is a clean miss.
  return sha256(canonicalJson({ schema_version: "sei.incremental-run-binding@2", binding }));
}

function manifestPath(binding, key) {
  return path.join(cacheRoot({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
  }), "manifests", `${key.slice("sha256:".length)}.json`);
}

function relativeArtifact(binding, artifact) {
  const resolved = path.resolve(artifact.path);
  const relative = path.relative(binding.output_root, resolved).replaceAll("\\", "/");
  if (!RELATIVE_PATH.test(relative) || path.posix.isAbsolute(relative)) publicationFail(`${artifact.label} escaped the output root`);
  return {
    label: artifact.label,
    relative_path: relative,
    size: Buffer.byteLength(artifact.bytes),
    sha256: sha256(artifact.bytes),
  };
}

function createRunManifest(binding, artifacts, result, postInventory) {
  if (!postInventory || typeof postInventory !== "object" || Array.isArray(postInventory)) publicationFail("post-publication baseline inventory is invalid");
  const postBinding = runBindingWithInventory(binding, postInventory);
  const key = runKey(postBinding);
  const snapshotArtifact = artifacts.find((candidate) => candidate.label === "SNAPSHOT");
  if (!snapshotArtifact) publicationFail("exact run manifest requires SNAPSHOT");
  const reportArtifact = artifacts.find((candidate) => candidate.label === "REPORT");
  const canonicalArtifacts = [snapshotArtifact, ...(reportArtifact ? [reportArtifact] : [])]
    .map((artifact) => relativeArtifact(binding, artifact))
    .sort((left, right) => stableCompare(left.label, right.label));
  if (!result || typeof result !== "object" || Array.isArray(result)
      || !exactKeys(result, ["comparison", "revision", "snapshot_id"])
      || !nonempty(result.snapshot_id) || result.revision !== binding.repository.revision) {
    publicationFail("exact run result binding is invalid");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(artifacts.find((candidate) => candidate.label === "SNAPSHOT").bytes);
  } catch {
    publicationFail("exact run snapshot bytes are invalid");
  }
  if (snapshot?.snapshot_id !== result.snapshot_id
      || snapshot?.repository?.repository_id !== binding.repository.repository_id
      || snapshot?.repository?.revision !== result.revision
      || !comparisonMatchesSnapshot(result.comparison, snapshot)) {
    publicationFail("exact run comparison or snapshot binding is invalid");
  }
  const body = canonicalValue({
    schema_version: "sei.incremental-run-manifest@2",
    run_key: key,
    binding: postBinding,
    result,
    artifacts: canonicalArtifacts,
  });
  const document = canonicalValue({ ...body, manifest_sha256: sha256(canonicalJson(body)) });
  return {
    binding: postBinding,
    run_key: key,
    artifact: {
      label: `INCREMENTAL_RUN_MANIFEST_${key.slice("sha256:".length)}`,
      path: manifestPath(binding, key),
      bytes: prettyJson(document),
    },
  };
}

function comparisonMatchesSnapshot(comparison, snapshot) {
  if (!comparison || typeof comparison !== "object" || Array.isArray(comparison)) return false;
  const requiredKeys = [
    "baseline_eligible",
    "baseline_repository_revision",
    "baseline_snapshot_id",
    "baseline_source",
    "baseline_status",
    "label",
    "reason",
    "trend",
  ];
  const optionalKeys = ["compatibility", "direction", "historical_context"];
  const keys = Object.keys(comparison);
  if (requiredKeys.some((key) => !Object.hasOwn(comparison, key))
      || keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) return false;
  if (!new Set(["automatic", "explicit"]).has(comparison.baseline_source)
      || !new Set(["established", "selected", "explicit"]).has(comparison.baseline_status)
      || typeof comparison.baseline_eligible !== "boolean"
      || !new Set([null, "improving", "stable", "worsening", "incomparable", "insufficient-history"]).has(comparison.label)
      || (comparison.reason !== null && !nonempty(comparison.reason))) return false;
  if (comparison.label === null) {
    if (comparison.compatibility !== "comparable" || comparison.direction !== "unassigned") return false;
  } else if (Object.hasOwn(comparison, "compatibility") || Object.hasOwn(comparison, "direction")) return false;
  const repositoryRevision = snapshot.repository?.revision;
  const oid = typeof repositoryRevision === "string" && repositoryRevision.length === 64
    ? /^[0-9a-f]{64}$/
    : /^[0-9a-f]{40}$/;
  if ((comparison.baseline_snapshot_id !== null && !nonempty(comparison.baseline_snapshot_id))
      || (comparison.baseline_repository_revision !== null && !oid.test(comparison.baseline_repository_revision))) return false;
  let trendValidation;
  try {
    const { validateTrendEnvelope } = require("./interpretation.js");
    trendValidation = validateTrendEnvelope(comparison.trend);
  } catch {
    return false;
  }
  if (!trendValidation.ok
      || comparison.trend.current_snapshot_id !== snapshot.snapshot_id
      || comparison.trend.previous_snapshot_id !== comparison.baseline_snapshot_id) return false;
  if (comparison.baseline_status === "established") {
    if (comparison.baseline_source !== "automatic"
        || comparison.baseline_snapshot_id !== null
        || comparison.baseline_repository_revision !== null) return false;
  } else if (comparison.baseline_source === "automatic" !== (comparison.baseline_status === "selected")) return false;
  const metadata = snapshot.run_metadata?.trend_baseline;
  if (metadata === undefined) return comparison.baseline_snapshot_id === null && comparison.baseline_repository_revision === null;
  if (Object.hasOwn(comparison, "historical_context")
      && canonicalJson(comparison.historical_context) !== canonicalJson(metadata.historical_context ?? null)) return false;
  return comparison.baseline_source === metadata.binding_kind
    && comparison.baseline_status === metadata.status
    && comparison.baseline_eligible === metadata.eligible
    && comparison.baseline_snapshot_id === metadata.baseline_snapshot_id
    && comparison.baseline_repository_revision === metadata.baseline_repository_revision;
}

function boundAssessmentForSnapshot(snapshot, candidates) {
  if (!Array.isArray(candidates)) return null;
  let engineeringAssessment;
  try { engineeringAssessment = require("./engineering-assessment.js"); } catch { return null; }
  const privateApi = engineeringAssessment[Symbol.for("sei.engineering-assessment.private.v1")];
  if (!privateApi || typeof privateApi.bindAssessment !== "function") return null;
  for (const candidate of [...candidates].sort((left, right) => stableCompare(left.path, right.path))) {
    const assessment = candidate?.assessment;
    try {
      if (!assessment || engineeringAssessment.validateAssessment(assessment, snapshot).ok !== true) continue;
      return Object.freeze({
        assessment,
        binding: privateApi.bindAssessment(assessment, snapshot),
      });
    } catch { /* corrupted or stale state is ignored; the caller falls back to recomputation */ }
  }
  return null;
}

function exactBundle(binding, diagnostics = [], priorAssessments = []) {
  const reject = (reason) => { diagnostics.push(reason); return null; };
  const expectedBinding = runBindingWithInventory(binding, binding.automatic_baseline_inventory_binding);
  const key = runKey(expectedBinding);
  const filePath = manifestPath(binding, key);
  let stats;
  let bytes;
  let document;
  try {
    stats = fs.lstatSync(filePath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0n || stats.size > BigInt(4 * 1024 * 1024)) return reject("manifest-target");
    bytes = fs.readFileSync(filePath, "utf8");
    document = JSON.parse(bytes);
  } catch {
    return reject("manifest-unavailable");
  }
  if (!exactKeys(document, ["artifacts", "binding", "manifest_sha256", "result", "run_key", "schema_version"])
      || !new Set(["sei.incremental-run-manifest@1", "sei.incremental-run-manifest@2"]).has(document.schema_version)
      || document.run_key !== key
      || canonicalJson(document.binding) !== canonicalJson(expectedBinding)
      || !Array.isArray(document.artifacts)
      || (document.schema_version === "sei.incremental-run-manifest@1" && document.artifacts.length !== 2)
      || (document.schema_version === "sei.incremental-run-manifest@2" && !new Set([1, 2]).has(document.artifacts.length))
      || !exactKeys(document.result, ["comparison", "revision", "snapshot_id"])) return reject("manifest-contract");
  const { manifest_sha256: declaredDigest, ...body } = document;
  if (declaredDigest !== sha256(canonicalJson(body)) || bytes !== prettyJson(document)) return reject("manifest-canonical-bytes");
  const loaded = new Map();
  const identities = new Set();
  for (const artifact of document.artifacts) {
    if (!exactKeys(artifact, ["label", "relative_path", "sha256", "size"])
        || !new Set(["REPORT", "SNAPSHOT"]).has(artifact.label)
        || !RELATIVE_PATH.test(artifact.relative_path) || path.posix.isAbsolute(artifact.relative_path)
        || !SHA256.test(artifact.sha256) || !integer(artifact.size)) return reject("artifact-contract");
    let artifactPath = path.resolve(binding.output_root, artifact.relative_path);
    const relative = path.relative(binding.output_root, artifactPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return reject("artifact-path");
    let artifactStats;
    let artifactBytes;
    try {
      artifactStats = fs.lstatSync(artifactPath, { bigint: true });
    } catch (error) {
      const persistedPath = error.code === "ENOENT" ? persistedArtifactPath(binding, artifact.label, artifact.relative_path, artifact.sha256) : null;
      if (persistedPath === null) return reject("artifact-unavailable");
      artifactPath = persistedPath;
      try { artifactStats = fs.lstatSync(artifactPath, { bigint: true }); } catch { return reject("artifact-unavailable"); }
    }
    try {
      if (!artifactStats.isFile() || artifactStats.isSymbolicLink() || artifactStats.size !== BigInt(artifact.size)) return reject("artifact-target");
      const identity = `${artifactStats.dev}:${artifactStats.ino}`;
      if (identities.has(identity)) return reject("artifact-alias");
      identities.add(identity);
      artifactBytes = fs.readFileSync(artifactPath);
    } catch { return reject("artifact-unavailable"); }
    if (sha256(artifactBytes) !== artifact.sha256) return reject("artifact-digest");
    loaded.set(artifact.label, { path: artifactPath, bytes: artifactBytes.toString("utf8") });
  }
  if (!loaded.has("SNAPSHOT") || loaded.size !== document.artifacts.length) return reject("artifact-coverage");
  if (document.schema_version === "sei.incremental-run-manifest@1" && !loaded.has("REPORT")) return reject("artifact-coverage");
  let snapshot;
  let canonicalArtifact;
  let assessmentBinding = null;
  let assessment = null;
  try {
    snapshot = JSON.parse(loaded.get("SNAPSHOT").bytes);
    const enginePrivate = require("./intelligence-engine.js")[Symbol.for("sei.intelligence-engine.private.v1")];
    canonicalArtifact = enginePrivate.canonicalArtifactFromSnapshot(snapshot);
    if (enginePrivate.readCanonicalArtifact(canonicalArtifact).snapshot_json !== loaded.get("SNAPSHOT").bytes) return reject("snapshot-canonical-bytes");
    const assessed = boundAssessmentForSnapshot(snapshot, priorAssessments);
    if (loaded.has("REPORT")) {
      const reportModule = require("./report.js");
      const reportPrivate = reportModule[Symbol.for("sei.report.private.v1")];
      const trustedVerifier = reportPrivate?.verifyRenderedReportFromCanonicalArtifact;
      const trustedRenderer = reportPrivate?.renderReportFromCanonicalArtifact;
      const candidates = [{ binding: null, assessment: null }, ...(assessed === null ? [] : [assessed])];
      let reportVerified = false;
      for (const candidate of candidates) {
        const options = candidate.binding === null ? {} : { assessment_binding: candidate.binding };
        let validation;
        if (typeof trustedRenderer === "function" && typeof trustedVerifier === "function") {
          const rendered = trustedRenderer(canonicalArtifact, options);
          if (rendered === loaded.get("REPORT").bytes) {
            validation = trustedVerifier(loaded.get("REPORT").bytes, canonicalArtifact, options);
          } else {
            // Automatic predictive readiness is a bounded, non-numeric report
            // annotation. Its opaque run binding is intentionally not persisted
            // in the exact-run manifest; the public verifier can still validate
            // the canonical snapshot/assessment and structurally constrain the
            // readiness payload without treating it as an evaluated receipt.
            validation = reportModule.verifyRenderedReport(loaded.get("REPORT").bytes, snapshot, options);
          }
        } else {
          validation = reportModule.verifyRenderedReport(loaded.get("REPORT").bytes, snapshot, options);
        }
        if (validation.ok) {
          reportVerified = true;
          assessmentBinding = candidate.binding;
          assessment = candidate.assessment;
          break;
        }
      }
      if (!reportVerified) return reject("report-verification");
    } else if (assessed !== null) {
      assessmentBinding = assessed.binding;
      assessment = assessed.assessment;
    }
  } catch { return reject("snapshot-validation"); }
  if (document.result.snapshot_id !== snapshot.snapshot_id
      || document.result.revision !== snapshot.repository.revision
      || snapshot.repository.repository_id !== expectedBinding.repository.repository_id
      || snapshot.repository.revision !== expectedBinding.repository.revision
      || !comparisonMatchesSnapshot(document.result.comparison, snapshot)) return reject("result-binding");
  return Object.freeze({
    run_key: key,
    manifest_path: filePath,
    manifest_bytes: bytes,
    manifest_label: `INCREMENTAL_RUN_MANIFEST_${key.slice("sha256:".length)}`,
    canonical_artifact: canonicalArtifact,
    report_bytes: loaded.get("REPORT")?.bytes ?? null,
    snapshot_path: loaded.get("SNAPSHOT").path,
    report_path: loaded.get("REPORT")?.path ?? null,
    assessment,
    assessment_binding: assessmentBinding,
    automatic_baseline_inventory_binding: deepFreeze(document.binding.automatic_baseline_inventory_binding),
    comparison: deepFreeze(document.result.comparison),
    snapshot_id: document.result.snapshot_id,
    revision: document.result.revision,
  });
}

function validateSessionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !SESSION_INPUT_KEYS.has(key))) {
    fail("incremental session input is not closed");
  }
  const required = [...SESSION_INPUT_KEYS].filter((key) => key !== "signal");
  if (required.some((key) => !Object.hasOwn(input, key))) fail("incremental session input is incomplete");
  if (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== "boolean" || typeof input.signal.addEventListener !== "function")) {
    fail("incremental session signal must be an AbortSignal");
  }
  if (input.signal?.aborted) throw input.signal.reason ?? new Error("FAIL-INCREMENTAL-STATE: incremental session was cancelled");
  if (input.mode !== "auto") fail("openIncrementalRun supports only auto mode");
  if (!nonempty(input.output_root) || typeof input.source_tree_clean !== "boolean"
      || !/^[0-9a-f]{64}$/.test(input.collector_configuration_hash)
      || !SHA256.test(input.config_bytes_sha256)
      || !SHA256.test(input.execution_contract_hash)
      || (input.assessment_config_sha256 !== null && !SHA256.test(input.assessment_config_sha256))
      || !Array.isArray(input.external_input_bindings)) {
    fail("incremental session scalar bindings are invalid");
  }
  if (input.performance_output_path !== null && (!nonempty(input.performance_output_path) || !path.isAbsolute(input.performance_output_path))) {
    fail("performance output path binding is invalid");
  }
  if (!exactKeys(input.repository, ["object_format", "repository_id", "revision", "root_tree_oid"])) {
    fail("incremental repository binding is not closed");
  }
  const oid = objectIdPattern(input.repository.object_format);
  if (!nonempty(input.repository.repository_id) || !oid.test(input.repository.revision) || !oid.test(input.repository.root_tree_oid)) {
    fail("incremental repository binding is invalid");
  }
  if (!input.repository_index_binding || typeof input.repository_index_binding !== "object" || Array.isArray(input.repository_index_binding)
      || input.repository_index_binding.repository_revision !== input.repository.revision
      || input.repository_index_binding.root_tree_oid !== input.repository.root_tree_oid
      || input.repository_index_binding.object_format !== input.repository.object_format
      || !SHA256.test(input.repository_index_binding.index_digest)
      || !SHA256.test(input.repository_index_binding.index_key)) {
    fail("incremental Repository Index binding is invalid");
  }
  if (!exactKeys(input.history_window, ["end", "kind", "start"])
      || !new Set(["revision", "revision-range"]).has(input.history_window.kind)
      || input.history_window.end !== input.repository.revision
      || (input.history_window.start !== null && !oid.test(input.history_window.start))) {
    fail("incremental history binding is invalid");
  }
  const configuredStateRoot = input.state_root === undefined ? null : input.state_root;
  const boundStateRoot = configuredStateRoot === null
    ? null
    : canonicalStateRoot(configuredStateRoot);
  const boundInventory = automaticBaselineInventoryBinding(input.output_root, [], boundStateRoot);
  if (canonicalJson(boundInventory) !== canonicalJson(input.automatic_baseline_inventory_binding)) {
    fail("automatic baseline inventory binding drifted before session open");
  }
  if (input.explicit_baseline_binding !== null && (typeof input.explicit_baseline_binding !== "object" || Array.isArray(input.explicit_baseline_binding))) {
    fail("explicit baseline binding is invalid");
  }
  if (!input.runtime_binding || typeof input.runtime_binding !== "object" || Array.isArray(input.runtime_binding)) {
    fail("runtime binding is invalid");
  }
  return deepFreeze(canonicalValue({
    ...input,
    output_root: path.resolve(input.output_root),
    ...(boundStateRoot === null ? {} : { state_root: boundStateRoot }),
    signal: undefined,
  }));
}

function writerLeasePath(binding, rootCapability = null) {
  const leaseRoot = cacheRoot({
    output_root: binding.output_root,
    state_root: binding.state_root,
    repository_id: binding.repository.repository_id,
  });
  const canonicalOutputRoot = rootCapability === null
    ? (process.platform === "win32" ? leaseRoot.toLowerCase() : leaseRoot)
    : `win32-file-id-v1:${rootCapability.identity}`;
  const key = crypto.createHash("sha256").update(canonicalJson({
    output_root: canonicalOutputRoot,
    repository_id: binding.repository.repository_id,
  })).digest("hex");
  return path.join(leaseRoot, "locks", `${key}.lock`);
}

function acquireWriter(binding, rootCapability = null) {
  const lockPath = writerLeasePath(binding, rootCapability);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      const held = new Error(`FAIL-INCREMENTAL-WRITER: writer lease is already held at ${lockPath}`);
      held.code = "FAIL-INCREMENTAL-WRITER";
      throw held;
    }
    throw error;
  }
  const receipt = prettyJson({
    schema_version: "sei.incremental-writer-lease@1",
    pid: process.pid,
    output_root: binding.output_root,
    repository_id: binding.repository.repository_id,
  });
  try {
    fs.writeFileSync(handle, receipt, "utf8");
    fs.fsyncSync(handle);
  } catch (error) {
    try { fs.closeSync(handle); } catch { /* best effort */ }
    try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
    throw error;
  }
  const identity = fs.fstatSync(handle, { bigint: true });
  return { handle, lockPath, identity: `${identity.dev}:${identity.ino}` };
}

function publicationFail(detail) {
  const error = new Error(`FAIL-INCREMENTAL-PUBLICATION: ${detail}`);
  error.code = "FAIL-INCREMENTAL-PUBLICATION";
  throw error;
}

function immutableArtifactFail(label, detail) {
  const error = new Error(`FAIL-IMMUTABLE-${label}: ${detail}`);
  error.code = `FAIL-IMMUTABLE-${label}`;
  throw error;
}

function artifactAliasFail(detail) {
  const error = new Error(`FAIL-ARTIFACT-ALIAS: ${detail}`);
  error.code = "FAIL-ARTIFACT-ALIAS";
  throw error;
}

function sharesCanonicalSnapshotStorage(left, right) {
  return new Set([left.label, right.label]).size === 2
    && new Set([left.label, right.label]).has("SNAPSHOT")
    && new Set([left.label, right.label]).has("CACHE")
    && left.bytes === right.bytes;
}

function canonicalSnapshotStoragePair(artifacts) {
  const snapshots = artifacts.filter((artifact) => artifact.label === "SNAPSHOT");
  const caches = artifacts.filter((artifact) => artifact.label === "CACHE");
  if (snapshots.length !== 1 || caches.length !== 1
      || !sharesCanonicalSnapshotStorage(snapshots[0], caches[0])) return null;
  return new Set([snapshots[0], caches[0]]);
}

function belongsToCanonicalSnapshotStoragePair(pair, left, right) {
  return pair !== null && pair.has(left) && pair.has(right);
}

function validatePublication(sessionBinding, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !exactKeys(input, ["artifacts", "manifest"])
      || !Array.isArray(input.artifacts) || !input.manifest || typeof input.manifest !== "object") {
    publicationFail("publication input must contain only artifacts and manifest");
  }
  const all = [...input.artifacts, input.manifest];
  const seenPaths = new Set();
  const artifacts = all.map((artifact, index) => {
    if (!exactKeys(artifact, ["bytes", "label", "path"])
        || !nonempty(artifact.label) || !nonempty(artifact.path) || typeof artifact.bytes !== "string") {
      publicationFail(`artifact ${index} is invalid`);
    }
    const resolved = path.resolve(artifact.path);
    const outputRoot = path.resolve(sessionBinding.output_root);
    const relative = path.relative(outputRoot, resolved);
    const authorizedExternal = sessionBinding.performance_output_path !== null
      && artifact.label === "PERFORMANCE"
      && canonicalResolvedPath(resolved) === canonicalResolvedPath(sessionBinding.performance_output_path);
    const stateRoot = cacheRoot({
      output_root: sessionBinding.output_root,
      state_root: sessionBinding.state_root,
      repository_id: sessionBinding.repository.repository_id,
    });
    const stateRelative = path.relative(stateRoot, resolved);
    const authorizedState = artifact.label.startsWith("INCREMENTAL_")
      && stateRelative.length > 0
      && !stateRelative.startsWith("..")
      && !path.isAbsolute(stateRelative);
    if (!authorizedExternal && !authorizedState && (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative))) {
      publicationFail(`artifact ${artifact.label} escaped the output root`);
    }
    const canonical = canonicalResolvedPath(resolved);
    if (seenPaths.has(canonical)) artifactAliasFail(`${artifact.label} aliases another target path`);
    seenPaths.add(canonical);
    return { ...artifact, path: resolved };
  });
  return { artifacts: artifacts.slice(0, -1), manifest: artifacts.at(-1) };
}

function lstatContainedTarget(filePath, label) {
  let current = path.dirname(filePath);
  while (true) {
    let stats;
    try {
      stats = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") publicationFail(`${label} parent inspection failed: ${error.code ?? error.message}`);
      const parent = path.dirname(current);
      if (parent === current) publicationFail(`${label} has no directory ancestor`);
      current = parent;
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) publicationFail(`${label} parent is not a real directory`);
    break;
  }
  try {
    const stats = fs.lstatSync(filePath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) immutableArtifactFail(label, `existing target is not a real file at ${filePath}`);
    return stats;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function preflightPublication(publication) {
  const all = [...publication.artifacts, publication.manifest];
  const canonicalStoragePair = canonicalSnapshotStoragePair(all);
  const identities = new Map();
  const existing = new Map();
  for (const artifact of all) {
    const stats = lstatContainedTarget(artifact.path, artifact.label);
    if (stats === null) {
      existing.set(artifact.path, false);
      continue;
    }
    const identity = `${stats.dev}:${stats.ino}`;
    const identityOwner = identities.get(identity);
    if (identityOwner && !belongsToCanonicalSnapshotStoragePair(canonicalStoragePair, identityOwner, artifact)) {
      artifactAliasFail(`${artifact.label} aliases another existing target`);
    }
    identities.set(identity, artifact);
    let bytes;
    try { bytes = fs.readFileSync(artifact.path, "utf8"); } catch (error) {
      immutableArtifactFail(artifact.label, `existing target is unreadable: ${error.code ?? error.message}`);
    }
    if (bytes !== artifact.bytes) immutableArtifactFail(artifact.label, `existing artifact bytes differ at ${artifact.path}`);
    existing.set(artifact.path, true);
  }
  return existing;
}

function stagePublicationArtifacts(publication, existing) {
  const pending = [...publication.artifacts, publication.manifest]
    .filter((artifact) => !existing.get(artifact.path));
  if (pending.length === 0) return [];
  const staged = [];
  const all = [...publication.artifacts, publication.manifest];
  const canonicalStoragePair = canonicalSnapshotStoragePair(all);
  const sharedByLabel = new Map(canonicalStoragePair === null
    ? []
    : [...canonicalStoragePair].map((artifact) => [artifact.label, artifact]));
  const stagedByLabel = new Map();
  try {
    for (let index = 0; index < pending.length; index += 1) {
      const artifact = pending[index];
      const counterpartLabel = artifact.label === "SNAPSHOT" ? "CACHE" : artifact.label === "CACHE" ? "SNAPSHOT" : null;
      const counterpart = counterpartLabel === null ? null : sharedByLabel.get(counterpartLabel);
      if (counterpart && belongsToCanonicalSnapshotStoragePair(canonicalStoragePair, artifact, counterpart)) {
        const stagedCounterpart = stagedByLabel.get(counterpartLabel);
        if (stagedCounterpart) {
          const entry = { artifact, stagePath: counterpart.path, stagingRoot: null, ownsStage: false };
          staged.push(entry);
          stagedByLabel.set(artifact.label, entry);
          continue;
        }
        if (existing.get(counterpart.path)) {
          const entry = { artifact, stagePath: counterpart.path, stagingRoot: null, ownsStage: false };
          staged.push(entry);
          stagedByLabel.set(artifact.label, entry);
          continue;
        }
      }
      const targetDirectory = path.dirname(artifact.path);
      fs.mkdirSync(targetDirectory, { recursive: true });
      // Prefer a short per-process staging root. It avoids ordinary nested
      // Windows path failures while retaining hard-link publication whenever
      // the temporary root is on the same volume as the target.
      const targetVolume = path.parse(targetDirectory).root.toLowerCase();
      const temporaryVolume = path.parse(os.tmpdir()).root.toLowerCase();
      const stagingParent = targetVolume === temporaryVolume
        ? os.tmpdir()
        : targetDirectory;
      const stagingRoot = fs.mkdtempSync(path.join(stagingParent, ".sei-staging-"));
      const stagePath = path.join(stagingRoot, `${String(index).padStart(6, "0")}.artifact`);
      const entry = { artifact, stagePath, stagingRoot, ownsStage: true };
      staged.push(entry);
      stagedByLabel.set(artifact.label, entry);
      fs.writeFileSync(stagePath, artifact.bytes, { encoding: "utf8", flag: "wx" });
    }
    return staged;
  } catch (error) {
    cleanupStaged(staged);
    publicationFail(`artifact staging failed: ${error.code ?? error.message}`);
  }
}

function cleanupStaged(staged) {
  const roots = new Set();
  const paths = new Set();
  for (const entry of staged) {
    if (!entry.ownsStage || paths.has(entry.stagePath)) continue;
    paths.add(entry.stagePath);
    roots.add(entry.stagingRoot);
    try { fs.unlinkSync(entry.stagePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const root of roots) {
    try { fs.rmdirSync(root); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
}

/**
 * Atomically links an immutable publication set. The package-private validator,
 * when supplied, runs synchronously after staging aliases are removed and before
 * success is returned; any validation failure rolls the linked set back.
 */
function publishSet(sessionBinding, input, validatePublished = null) {
  if (validatePublished !== null && typeof validatePublished !== "function") {
    publicationFail("post-publication validator must be a function");
  }
  const publication = validatePublication(sessionBinding, input);
  const existing = preflightPublication(publication);
  const staged = stagePublicationArtifacts(publication, existing);
  const manifestPath = publication.manifest.path;
  const ordinary = staged.filter((entry) => entry.artifact.path !== manifestPath);
  const manifest = staged.find((entry) => entry.artifact.path === manifestPath) ?? null;
  const linked = [];
  let validationFailure = null;
  try {
    for (const entry of [...ordinary, ...(manifest === null ? [] : [manifest])]) {
      fs.mkdirSync(path.dirname(entry.artifact.path), { recursive: true });
      fs.linkSync(entry.stagePath, entry.artifact.path);
      linked.push(entry.artifact.path);
      const sourceStats = fs.lstatSync(entry.stagePath, { bigint: true });
      const targetStats = fs.lstatSync(entry.artifact.path, { bigint: true });
      if (!sourceStats.isFile() || sourceStats.isSymbolicLink()
          || !targetStats.isFile() || targetStats.isSymbolicLink()
          || `${sourceStats.dev}:${sourceStats.ino}` !== `${targetStats.dev}:${targetStats.ino}`) {
        artifactAliasFail(`${entry.artifact.label} target identity changed during publication`);
      }
    }
    cleanupStaged(staged);
    if (validatePublished !== null) {
      for (const artifact of [...publication.artifacts, publication.manifest]) {
        try { validatePublished(artifact); } catch (error) {
          validationFailure = error;
          throw error;
        }
      }
    }
  } catch (error) {
    for (const filePath of linked.reverse()) {
      try { fs.unlinkSync(filePath); } catch (rollbackError) { if (rollbackError.code !== "ENOENT") throw rollbackError; }
    }
    cleanupStaged(staged);
    if (validationFailure !== null) throw validationFailure;
    publicationFail(`atomic link failed: ${error.code ?? error.message}`);
  }
  return Object.freeze({
    planned_count: publication.artifacts.length + 1,
    planned_bytes: [...publication.artifacts, publication.manifest].reduce((sum, artifact) => sum + Buffer.byteLength(artifact.bytes), 0),
    existing_count: [...existing.values()].filter(Boolean).length,
    pending_count: staged.length,
    staged_count: staged.length,
    staged_bytes: staged.filter((entry) => entry.ownsStage)
      .reduce((sum, entry) => sum + Buffer.byteLength(entry.artifact.bytes), 0),
    linked_count: linked.length,
    linked_bytes: linked.reduce((sum, filePath) => {
      const artifact = [...publication.artifacts, publication.manifest].find((candidate) => candidate.path === filePath);
      return sum + Buffer.byteLength(artifact.bytes);
    }, 0),
    manifest_published_last: manifest === null || linked.at(-1) === manifestPath,
    rolled_back_count: 0,
  });
}

function releaseWriter(writer) {
  let ownedPath = false;
  try {
    const stats = fs.lstatSync(writer.lockPath, { bigint: true });
    ownedPath = `${stats.dev}:${stats.ino}` === writer.identity && stats.isFile() && !stats.isSymbolicLink();
  } catch { /* a missing or replaced lease is not ours to remove */ }
  try { fs.closeSync(writer.handle); } finally {
    if (ownedPath) {
      try { fs.unlinkSync(writer.lockPath); } catch { /* a missing lease is already closed */ }
    }
  }
}

function acquireWriterSet(binding) {
  const lexicalWriter = acquireWriter(binding);
  if (binding.state_root === undefined) return { rootCapability: null, writers: [lexicalWriter] };
  try {
    const rootCapability = nativeWriterRoot(binding.state_root);
    if (rootCapability === null) return { rootCapability: null, writers: [lexicalWriter] };
    const physicalWriter = acquireWriter(binding, rootCapability);
    return { rootCapability, writers: [lexicalWriter, physicalWriter] };
  } catch (error) {
    releaseWriter(lexicalWriter);
    throw error;
  }
}

function releaseWriterSet(writers) {
  let firstError = null;
  for (const writer of [...writers].reverse()) {
    try { releaseWriter(writer); } catch (error) { firstError ??= error; }
  }
  if (firstError !== null) throw firstError;
}

async function openStateWriter({ output_root: outputRoot, state_root: configuredStateRoot, repository_id: repositoryId } = {}) {
  validateRootInput(outputRoot, repositoryId);
  const binding = deepFreeze({
    output_root: path.resolve(outputRoot),
    ...(configuredStateRoot === undefined ? {} : { state_root: canonicalStateRoot(configuredStateRoot) }),
    repository: { repository_id: repositoryId },
    performance_output_path: null,
  });
  const acquired = acquireWriterSet(binding);
  const { rootCapability, writers } = acquired;
  let closed = false;
  const lease = {
    publish(publication) {
      if (closed) publicationFail("state writer is already closed");
      return publishSet(binding, publication);
    },
    async close() {
      if (closed) return;
      closed = true;
      releaseWriterSet(writers);
    },
  };
  stateWriterState.set(lease, {
    binding,
    publish: lease.publish,
    publishValidated(publication, validator) {
      if (closed) publicationFail("state writer is already closed");
      return publishSet(binding, publication, validator);
    },
    runWithLease(callback) {
      if (closed) publicationFail("state writer is already closed");
      if (typeof callback !== "function") publicationFail("state writer callback must be a function");
      return callback(rootCapability);
    },
  });
  return Object.freeze(lease);
}

function stateWriterAccess(lease, { state_root: expectedStateRoot, repository_id: expectedRepositoryId } = {}) {
  const state = stateWriterState.get(lease);
  if (!state) publicationFail("state writer lease is not package-branded");
  const actualRoot = cacheRoot({
    output_root: state.binding.output_root,
    state_root: state.binding.state_root,
    repository_id: state.binding.repository.repository_id,
  });
  if (expectedStateRoot !== undefined) {
    let canonicalExpectedRoot;
    try { canonicalExpectedRoot = canonicalStateRoot(expectedStateRoot); } catch (error) {
      publicationFail(`state writer lease root is not canonical (${error.message})`);
    }
    const matches = process.platform === "win32"
      ? actualRoot === canonicalExpectedRoot
      : canonicalResolvedPath(actualRoot) === canonicalResolvedPath(canonicalExpectedRoot);
    if (!matches) publicationFail("state writer lease root does not match");
  }
  if (expectedRepositoryId !== undefined && state.binding.repository.repository_id !== expectedRepositoryId) {
    publicationFail("state writer lease repository does not match");
  }
  return Object.freeze({ state_root: actualRoot, runWithLease: state.runWithLease });
}

async function openIncrementalRun(input) {
  const binding = validateSessionInput(input);
  const acquired = acquireWriterSet(binding);
  const { rootCapability, writers } = acquired;
  let closed = false;
  importLegacySnapshots(binding);
  const priorAssessments = discoverPersistedAssessments(binding);
  const exactDiagnostics = [];
  const exact = binding.source_tree_clean
    ? exactBundle(binding, exactDiagnostics, assessmentsBoundToProfile(binding, priorAssessments))
    : null;
  const priorStatic = discoverSessionStages(binding, "static");
  const priorHistory = discoverSessionStages(binding, "history");
  const priorStages = Object.freeze({ static: priorStatic.stages, history: priorHistory.stages });
  const discovery = Object.freeze({
    mode: exact !== null ? "exact" : priorStages.static.length > 0 || priorStages.history.length > 0 ? "prior" : "cold",
    reason: exact !== null
      ? "exact validated run bundle is available"
      : priorStages.static.length > 0 || priorStages.history.length > 0
        ? "validated compact stage candidates are available"
        : "no validated prior incremental state is available",
    static: priorStatic.telemetry,
    history: priorHistory.telemetry,
    exact_rejection_reason: exact === null ? (binding.source_tree_clean ? exactDiagnostics[0] ?? "no-exact-manifest" : "source-tree-dirty") : null,
  });
  const session = {
    discovery,
    exact_bundle: exact,
    prior_assessments: priorAssessments,
    prior_stages: priorStages,
    publish(publication) {
      if (closed) publicationFail("session is already closed");
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("FAIL-INCREMENTAL-PUBLICATION: publication was cancelled");
      let normalizedPublication;
      if (publication && typeof publication === "object" && !Array.isArray(publication)
          && exactKeys(publication, ["artifacts", "post_automatic_baseline_inventory_binding", "result"])) {
        const manifest = createRunManifest(
          binding,
          publication.artifacts,
          publication.result,
          publication.post_automatic_baseline_inventory_binding,
        );
        const anticipated = automaticBaselineInventoryBinding(binding.output_root, publication.artifacts
          .filter((artifact) => artifact.label === "SNAPSHOT")
          .map((artifact) => ({ name: path.basename(artifact.path), bytes: artifact.bytes })), binding.state_root);
        if (canonicalJson(anticipated) !== canonicalJson(publication.post_automatic_baseline_inventory_binding)) {
          publicationFail("post-publication automatic baseline inventory is not exact");
        }
        normalizedPublication = { artifacts: publication.artifacts, manifest: manifest.artifact };
      } else {
        normalizedPublication = publication;
      }
      const snapshotArtifact = normalizedPublication.artifacts.find((artifact) => artifact.label === "SNAPSHOT");
      if (snapshotArtifact) persistSnapshotInState(binding, snapshotArtifact.bytes);
      const reportArtifact = normalizedPublication.artifacts.find((artifact) => artifact.label === "REPORT");
      if (reportArtifact) persistReportInState(binding, reportArtifact.bytes);
      const assessmentArtifact = normalizedPublication.artifacts.find((artifact) => artifact.label === "ASSESSMENT");
      if (assessmentArtifact) {
        persistAssessmentInState(binding, assessmentArtifact.bytes);
        persistAssessmentProfileBinding(binding, assessmentArtifact.bytes);
      }
      const result = publishSet(binding, normalizedPublication);
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("FAIL-INCREMENTAL-PUBLICATION: publication was cancelled");
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      releaseWriterSet(writers);
    },
  };
  stateWriterState.set(session, {
    binding,
    publish: session.publish,
    publishValidated(publication, validator) {
      if (closed) publicationFail("session is already closed");
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("FAIL-INCREMENTAL-PUBLICATION: publication was cancelled");
      return publishSet(binding, publication, validator);
    },
    runWithLease(callback) {
      if (closed) publicationFail("session is already closed");
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("FAIL-INCREMENTAL-PUBLICATION: publication was cancelled");
      if (typeof callback !== "function") publicationFail("state writer callback must be a function");
      return callback(rootCapability);
    },
  });
  return Object.freeze(session);
}

module.exports = { openIncrementalRun };
Object.defineProperty(module.exports, Symbol.for("sei.incremental-run-state.private.v2"), {
  value: Object.freeze({
    artifactForStage,
    automaticBaselineInventoryBinding,
    cacheRoot,
    createHistoryStage,
    createStaticStage,
    discoverStages,
    openStateWriter,
    readStage,
    readStaticDependencySnapshot,
    stateRoot,
    stateWriterAccess,
    persistAssessmentInState,
    persistAssessmentProfileBinding,
    assessmentsBoundToProfile,
    discoverPersistedAssessments,
    withStaticDependencySnapshot,
  }),
});
