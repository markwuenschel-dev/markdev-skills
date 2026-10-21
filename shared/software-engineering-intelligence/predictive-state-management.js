"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const artifactPrivate = require("./predictive-artifact-store.js")[Symbol.for("sei.predictive-artifact-store.private.v1")];
const statePrivate = require("./incremental-run-state.js")[Symbol.for("sei.incremental-run-state.private.v2")];
const nativePrivate = require("./predictive-native-fs.js")[Symbol.for("sei.predictive-native-fs.private.v1")];

const PRIVATE_SYMBOL = Symbol.for("sei.predictive-state-management.private.v1");
const CONFIRMATION_VERSION = "sei.predictive-artifact-purge-confirmation@1";
const INSPECTION_VERSION = "sei.predictive-state-inspection@1";
const PURGE_VERSION = "sei.predictive-state-purge@1";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONFIRMATION = /^confirm:[0-9a-f]{64}$/;
const MAX_REPORT_PINS = 64;
const MAX_SCOPE_ITEMS = 256;
const MAX_MANIFEST_ENTRIES = 128;
const MAX_OBJECT_ENTRIES = 256;
const MAX_TOTAL_ENTRIES = MAX_MANIFEST_ENTRIES + MAX_OBJECT_ENTRIES;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function fail(code, detail, cause = undefined) {
  const error = cause === undefined ? new Error(`${code}: ${detail}`) : new Error(`${code}: ${detail}`, { cause });
  error.code = code;
  throw error;
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function checkSignal(signal, code, operation) {
  if (signal !== undefined && (!isRecord(signal) || typeof signal.aborted !== "boolean")) {
    fail("FAIL-PREDICTIVE-BINDING", "signal must be an AbortSignal");
  }
  if (signal?.aborted) {
    const reason = signal.reason;
    const detail = reason instanceof Error ? reason.message : String(reason ?? "no reason supplied");
    fail(code, `${operation} was cancelled (${detail})`, reason);
  }
}

function normalizeReportPins(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REPORT_PINS) fail("FAIL-PREDICTIVE-BINDING", "report pins are not bounded");
  return structuredClone(value);
}

function normalizeScope(value) {
  if (!isRecord(value)
      || Object.keys(value).sort().join("\0") !== ["lineage_id", "purge_manifest_keys", "purge_object_digests"].sort().join("\0")
      || !nonempty(value.lineage_id)
      || !Array.isArray(value.purge_manifest_keys)
      || !Array.isArray(value.purge_object_digests)
      || value.purge_manifest_keys.length > MAX_SCOPE_ITEMS
      || value.purge_object_digests.length > MAX_SCOPE_ITEMS) {
    fail("FAIL-PREDICTIVE-PURGE", "purge scope is not closed or bounded");
  }
  const normalize = (values, pattern, label) => {
    const sorted = [...values].sort();
    if (sorted.some((value) => !pattern.test(value)) || new Set(sorted).size !== sorted.length) {
      fail("FAIL-PREDICTIVE-PURGE", `${label} are not unique exact digests`);
    }
    return sorted;
  };
  return {
    lineage_id: value.lineage_id,
    purge_manifest_keys: normalize(value.purge_manifest_keys, SHA256, "purge manifest keys"),
    purge_object_digests: normalize(value.purge_object_digests, SHA256, "purge object digests"),
  };
}

function normalizeInput(input, operation) {
  if (!isRecord(input)) fail(`FAIL-PREDICTIVE-${operation}`, "operation input must be a record");
  const allowed = operation === "PURGE"
    ? ["confirmationToken", "lineage", "lease", "purgeScope", "reportPins", "repositoryId", "signal", "stateRoot"]
    : ["lineage", "lease", "reportPins", "repositoryId", "signal", "stateRoot"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    fail(`FAIL-PREDICTIVE-${operation}`, "operation input contains an unknown field");
  }
  if (!nonempty(input.stateRoot) || !path.isAbsolute(input.stateRoot) || !nonempty(input.repositoryId) || !isRecord(input.lineage)
      || (operation === "PURGE" && (input.lease === null || input.lease === undefined))) {
    fail(`FAIL-PREDICTIVE-${operation}`, "state root, repository identity, lineage, and lease are required");
  }
  return {
    stateRoot: input.stateRoot,
    repositoryId: input.repositoryId,
    lineage: structuredClone(input.lineage),
    lease: input.lease,
    reportPins: normalizeReportPins(input.reportPins),
    signal: input.signal,
    ...(operation === "PURGE" ? {
      purgeScope: normalizeScope(input.purgeScope),
      confirmationToken: input.confirmationToken,
    } : {}),
  };
}

function validateLineageForNamespace(lineage) {
  const expected = ["remote_urls", "repository_lineage_id", "root_history_digest"];
  if (!isRecord(lineage) || Object.keys(lineage).sort().join("\0") !== expected.sort().join("\0")
      || !nonempty(lineage.repository_lineage_id)
      || !SHA256.test(lineage.root_history_digest)
      || !Array.isArray(lineage.remote_urls)
      || lineage.remote_urls.some((remote) => !nonempty(remote))) {
    fail("FAIL-PREDICTIVE-LINEAGE", "lineage descriptor is not closed or valid");
  }
}

function boundedEntries(entries, limit, label) {
  if (!Array.isArray(entries) || entries.length > limit) {
    fail("FAIL-PREDICTIVE-RETENTION", `${label} exceed the bounded state-management limit`);
  }
  return entries;
}

function boundedNativeEntries(directory, limit, label) {
  try {
    return boundedEntries(directory.listDirectoryBounded(limit), limit, label);
  } catch (error) {
    if (error?.cause?.reason === "ENUMERATION_LIMIT" || error?.message?.includes("ENUMERATION_LIMIT")) {
      fail("FAIL-PREDICTIVE-RETENTION", `${label} exceed the bounded state-management limit`, error);
    }
    throw error;
  }
}

function preflightNamespace(input) {
  validateLineageForNamespace(input.lineage);
  if (!fs.existsSync(input.stateRoot)) return { exists: false };
  if (nativePrivate.helperIdentity === null || typeof nativePrivate.openRootReadOnly !== "function") {
    fail("FAIL-PREDICTIVE-RETENTION", "validated native predictive inspection is unavailable");
  }
  const root = nativePrivate.openRootReadOnly(input.stateRoot);
  if (root === null) return { exists: false };
  const namespace = root.openDirectoryReadOnly(namespaceComponents(
    input.repositoryId,
    input.lineage.repository_lineage_id,
    nativePrivate.helperIdentity,
  ));
  if (namespace === null) return { exists: false };
  const manifests = namespace.openDirectoryReadOnly(["manifests"]);
  const objects = namespace.openDirectoryReadOnly(["objects"]);
  if (manifests === null || objects === null) {
    fail("FAIL-PREDICTIVE-RETENTION", "predictive namespace is incomplete");
  }
  const manifestEntries = boundedNativeEntries(manifests, MAX_MANIFEST_ENTRIES, "manifest entries");
  const objectEntries = boundedNativeEntries(objects, MAX_OBJECT_ENTRIES, "object entries");
  if (manifestEntries.length + objectEntries.length > MAX_TOTAL_ENTRIES) {
    fail("FAIL-PREDICTIVE-RETENTION", "predictive namespace entries exceed the aggregate bound");
  }
  return { exists: true };
}

function emptyInspection(input) {
  const lineageId = input.lineage.repository_lineage_id;
  const purgeScope = buildScope({ purge_manifest_keys: [], purge_object_digests: [] }, lineageId);
  return deepFreeze({
    schema_version: INSPECTION_VERSION,
    lineage_id: lineageId,
    inspection: {
      schema_version: "sei.predictive-artifact-inspection@1",
      lineage_id: lineageId,
      manifest_count: 0,
      object_count: 0,
      manifests: [],
      objects: [],
    },
    purge_plan: {
      schema_version: "sei.predictive-artifact-purge-plan@1",
      lineage_id: lineageId,
      dry_run: true,
      retained_manifest_keys: [],
      purge_manifest_keys: [],
      retained_object_digests: [],
      purge_object_digests: [],
    },
    purge_scope: purgeScope,
    confirmation_token: buildPurgeConfirmationToken({
      repositoryId: input.repositoryId,
      lineageId,
      purgeScope,
    }),
  });
}

function assertBoundedResult(inspection, purgePlan) {
  if (!isRecord(inspection) || !Number.isSafeInteger(inspection.manifest_count)
      || !Number.isSafeInteger(inspection.object_count)
      || inspection.manifest_count > MAX_MANIFEST_ENTRIES
      || inspection.object_count > MAX_OBJECT_ENTRIES
      || inspection.manifest_count + inspection.object_count > MAX_TOTAL_ENTRIES) {
    fail("FAIL-PREDICTIVE-RETENTION", "validated inspection exceeds the bounded state-management limit");
  }
  boundedEntries(inspection.manifests, MAX_MANIFEST_ENTRIES, "inspection manifests");
  boundedEntries(inspection.objects, MAX_OBJECT_ENTRIES, "inspection objects");
  if (!isRecord(purgePlan)) fail("FAIL-PREDICTIVE-RETENTION", "purge plan is not a bounded record");
  for (const [key, value, limit] of [
    ["retained_manifest_keys", purgePlan.retained_manifest_keys, MAX_MANIFEST_ENTRIES],
    ["purge_manifest_keys", purgePlan.purge_manifest_keys, MAX_MANIFEST_ENTRIES],
    ["retained_object_digests", purgePlan.retained_object_digests, MAX_OBJECT_ENTRIES],
    ["purge_object_digests", purgePlan.purge_object_digests, MAX_OBJECT_ENTRIES],
  ]) boundedEntries(value, limit, `purge plan ${key}`);
  if (purgePlan.retained_manifest_keys.length + purgePlan.purge_manifest_keys.length > MAX_MANIFEST_ENTRIES
      || purgePlan.retained_object_digests.length + purgePlan.purge_object_digests.length > MAX_OBJECT_ENTRIES) {
    fail("FAIL-PREDICTIVE-RETENTION", "purge plan collections exceed the aggregate bound");
  }
}

function buildPurgeConfirmationToken({ repositoryId, lineageId, purgeScope } = {}) {
  if (!nonempty(repositoryId) || !nonempty(lineageId)) fail("FAIL-PREDICTIVE-CONFIRMATION", "confirmation binding identity is invalid");
  const scope = normalizeScope({
    lineage_id: lineageId,
    purge_manifest_keys: purgeScope?.purge_manifest_keys ?? [],
    purge_object_digests: purgeScope?.purge_object_digests ?? [],
  });
  const body = {
    schema_version: CONFIRMATION_VERSION,
    repository_id: repositoryId,
    lineage_id: lineageId,
    purge_scope: scope,
  };
  return `confirm:${sha256(Buffer.from(canonicalJson(body), "utf8")).slice("sha256:".length)}`;
}

function assertTokenEqual(actual, expected) {
  if (typeof actual !== "string" || !CONFIRMATION.test(actual)) fail("FAIL-PREDICTIVE-CONFIRMATION", "exact purge confirmation token is required");
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    fail("FAIL-PREDICTIVE-CONFIRMATION", "purge confirmation does not match the validated lineage and scope");
  }
}

function namespaceComponents(repositoryId, lineageId, helperIdentity) {
  const repositoryKey = crypto.createHash("sha256").update(repositoryId).digest("hex");
  const lineageKey = crypto.createHash("sha256").update(lineageId).digest("hex");
  const helperKey = crypto.createHash("sha256").update(canonicalJson(helperIdentity)).digest("hex");
  return [
    "predictive-artifacts-v1",
    "helpers",
    helperKey,
    "repositories",
    repositoryKey,
    "lineages",
    lineageKey,
  ];
}

function manifestName(key) {
  return `${key.slice("sha256:".length)}.json`;
}

function objectName(digest) {
  return `${digest.slice("sha256:".length)}.object`;
}

function openStore(input) {
  const store = artifactPrivate.openPredictiveArtifactStore({
    stateRoot: input.stateRoot,
    repositoryBinding: { repository_id: input.repositoryId },
    lineage: input.lineage,
    lease: input.lease,
    signal: input.signal,
  });
  return { store, writer: statePrivate.stateWriterAccess(input.lease, {
    state_root: input.stateRoot,
    repository_id: input.repositoryId,
  }) };
}

function buildScope(plan, lineageId) {
  return normalizeScope({
    lineage_id: lineageId,
    purge_manifest_keys: plan.purge_manifest_keys,
    purge_object_digests: plan.purge_object_digests,
  });
}

function inspectPredictiveState(input = {}) {
  const normalized = normalizeInput(input, "RETENTION");
  checkSignal(normalized.signal, "FAIL-PREDICTIVE-RETENTION", "predictive inspection");
  const namespace = preflightNamespace(normalized);
  if (!namespace.exists) return emptyInspection(normalized);
  if (normalized.lease === null || normalized.lease === undefined) {
    fail("FAIL-PREDICTIVE-RETENTION", "existing predictive state requires a leased read capability");
  }
  const { store } = openStore(normalized);
  const inspection = store.inspect({ lineageId: normalized.lineage.repository_lineage_id });
  const purgePlan = store.planPurge({
    lineageId: normalized.lineage.repository_lineage_id,
    reportPins: normalized.reportPins,
  });
  checkSignal(normalized.signal, "FAIL-PREDICTIVE-RETENTION", "predictive inspection");
  assertBoundedResult(inspection, purgePlan);
  const purgeScope = buildScope(purgePlan, normalized.lineage.repository_lineage_id);
  return deepFreeze({
    schema_version: INSPECTION_VERSION,
    lineage_id: normalized.lineage.repository_lineage_id,
    inspection,
    purge_plan: purgePlan,
    purge_scope: purgeScope,
    confirmation_token: buildPurgeConfirmationToken({
      repositoryId: normalized.repositoryId,
      lineageId: normalized.lineage.repository_lineage_id,
      purgeScope,
    }),
  });
}

function readDirectoryEntries(directory, suffix, maxBytes, operation) {
  const limit = suffix === ".json" ? MAX_MANIFEST_ENTRIES : MAX_OBJECT_ENTRIES;
  const entries = [...boundedNativeEntries(directory, limit, `${operation} entries`)]
    .sort((left, right) => left.name.localeCompare(right.name));
  const pattern = suffix === ".json" ? /^[0-9a-f]{64}\.json$/ : /^[0-9a-f]{64}\.object$/;
  if (entries.some((entry) => entry.type !== "file" || !pattern.test(entry.name))) {
    fail("FAIL-PREDICTIVE-RETENTION", `${operation} namespace contains an uncertain or aliased entry`);
  }
  return entries.map((entry) => {
    const loaded = directory.readFile({ name: entry.name, maxBytes });
    return { ...entry, loaded };
  });
}

function purgeObjects({ input, scope, writer, store }) {
  checkSignal(input.signal, "FAIL-PREDICTIVE-PURGE", "predictive purge");
  const helperIdentity = nativePrivate.helperIdentity;
  if (helperIdentity === null || typeof nativePrivate.openRoot !== "function") {
    fail("FAIL-PREDICTIVE-PURGE", "validated native filesystem deletion is unavailable");
  }
  const deleted = writer.runWithLease((leasedRoot) => {
    checkSignal(input.signal, "FAIL-PREDICTIVE-PURGE", "predictive purge");
    const root = leasedRoot ?? nativePrivate.openRoot(writer.state_root);
    const namespace = root.openDirectory(namespaceComponents(
      input.repositoryId,
      input.lineage.repository_lineage_id,
      helperIdentity,
    ));
    if (namespace === null) fail("FAIL-PREDICTIVE-PURGE", "validated predictive lineage namespace is missing");
    const objectDirectory = namespace.openDirectory(["objects"]);
    const manifestDirectory = namespace.openDirectory(["manifests"]);
    if (objectDirectory === null || manifestDirectory === null) {
      fail("FAIL-PREDICTIVE-PURGE", "validated predictive object or manifest namespace is missing");
    }
    const manifests = readDirectoryEntries(manifestDirectory, ".json", MAX_MANIFEST_BYTES, "manifest");
    const objects = readDirectoryEntries(objectDirectory, ".object", MAX_OBJECT_BYTES, "object");
    if (manifests.length + objects.length > MAX_TOTAL_ENTRIES) {
      fail("FAIL-PREDICTIVE-PURGE", "predictive namespace entries exceed the aggregate bound");
    }
    const identities = new Set();
    for (const entry of [...manifests, ...objects]) {
      if (identities.has(entry.loaded.identity)) fail("FAIL-PREDICTIVE-PURGE", "cache namespace contains a hard-link alias");
      identities.add(entry.loaded.identity);
    }
    const refreshedPlan = store.planPurge({
      lineageId: input.lineage.repository_lineage_id,
      reportPins: input.reportPins,
    });
    if (canonicalJson(buildScope(refreshedPlan, input.lineage.repository_lineage_id)) !== canonicalJson(scope)) {
      fail("FAIL-PREDICTIVE-PURGE", "validated manifest reachability changed during purge preflight");
    }
    const manifestByKey = new Map();
    for (const entry of manifests) {
      const key = `sha256:${entry.name.slice(0, 64)}`;
      let document;
      try { document = JSON.parse(entry.loaded.bytes.toString("utf8")); } catch (error) {
        fail("FAIL-PREDICTIVE-MANIFEST", "manifest is not JSON", error);
      }
      if (!isRecord(document) || document.key !== key || document.manifest_sha256 !== undefined && !SHA256.test(document.manifest_sha256)) {
        fail("FAIL-PREDICTIVE-MANIFEST", "manifest key or digest binding is invalid");
      }
      manifestByKey.set(key, entry);
    }
    const objectByDigest = new Map(objects.map((entry) => [`sha256:${entry.name.slice(0, 64)}`, entry]));
    const manifestTargets = scope.purge_manifest_keys.map((key) => {
      const entry = manifestByKey.get(key);
      if (!entry) fail("FAIL-PREDICTIVE-PURGE", `purge manifest target is missing (${key})`);
      return entry;
    });
    const objectTargets = scope.purge_object_digests.map((objectDigest) => {
      const entry = objectByDigest.get(objectDigest);
      if (!entry || entry.loaded.digest !== objectDigest) fail("FAIL-PREDICTIVE-PURGE", `purge object target is invalid (${objectDigest})`);
      return entry;
    });
    for (const entry of [...manifestTargets, ...objectTargets]) {
      checkSignal(input.signal, "FAIL-PREDICTIVE-PURGE", "predictive purge");
      const digest = entry.loaded.digest;
      entry.directory = entry.name.endsWith(".json") ? manifestDirectory : objectDirectory;
      entry.deleteDigest = digest;
    }
    for (const entry of manifestTargets) {
      entry.directory.deleteFile({ name: entry.name, identity: entry.loaded.identity, digest: entry.deleteDigest });
    }
    for (const entry of objectTargets) {
      checkSignal(input.signal, "FAIL-PREDICTIVE-PURGE", "predictive purge");
      entry.directory.deleteFile({ name: entry.name, identity: entry.loaded.identity, digest: entry.deleteDigest });
    }
    checkSignal(input.signal, "FAIL-PREDICTIVE-PURGE", "predictive purge");
    return {
      manifest_keys: scope.purge_manifest_keys,
      object_digests: scope.purge_object_digests,
    };
  });
  const remaining = store.inspect({ lineageId: input.lineage.repository_lineage_id });
  assertBoundedResult(remaining, {
    retained_manifest_keys: remaining.manifests.map((manifest) => manifest.key),
    purge_manifest_keys: [],
    retained_object_digests: remaining.objects.map((object) => object.digest),
    purge_object_digests: [],
  });
  return { deleted, remaining };
}

function purgePredictiveState(input = {}) {
  const normalized = normalizeInput(input, "PURGE");
  checkSignal(normalized.signal, "FAIL-PREDICTIVE-PURGE", "predictive purge");
  if (normalized.purgeScope.lineage_id !== normalized.lineage.repository_lineage_id) {
    fail("FAIL-PREDICTIVE-LINEAGE", "requested purge scope belongs to another lineage");
  }
  const current = inspectPredictiveState({
    stateRoot: normalized.stateRoot,
    repositoryId: normalized.repositoryId,
    lineage: normalized.lineage,
    lease: normalized.lease,
    reportPins: normalized.reportPins,
    signal: normalized.signal,
  });
  if (canonicalJson(normalized.purgeScope) !== canonicalJson(current.purge_scope)) {
    fail("FAIL-PREDICTIVE-PURGE", "requested purge scope is stale or not derived from the validated manifest set");
  }
  assertTokenEqual(normalized.confirmationToken, current.confirmation_token);
  const { store, writer } = openStore(normalized);
  const result = purgeObjects({ input: normalized, scope: current.purge_scope, writer, store });
  return deepFreeze({
    schema_version: PURGE_VERSION,
    lineage_id: normalized.lineage.repository_lineage_id,
    deleted: result.deleted,
    remaining: result.remaining,
  });
}

module.exports = {};
Object.defineProperty(module.exports, PRIVATE_SYMBOL, {
  value: Object.freeze({
    buildPurgeConfirmationToken,
    inspectPredictiveState,
    purgePredictiveState,
  }),
});
Object.freeze(module.exports);
