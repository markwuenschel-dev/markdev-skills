"use strict";

const crypto = require("node:crypto");

const DEPENDENCY_INVALIDATION_VERSION = "sei.dependency-invalidation@1";
const NORMALIZED_FACTS_VERSION = "sei.normalized-dependency-facts@1";
const PORTABLE_SNAPSHOT_VERSION = "sei.dependency-invalidation-snapshot@1";
const PRIVATE = Symbol.for("sei.dependency-invalidation.private@1");
const HARD_LIMITS = Object.freeze({
  max_analyzers: 64,
  max_edges: 500_000,
  max_nodes: 100_000,
  max_partitions: 128,
  max_paths: 100_000,
  max_reason_depth: 64,
  max_reason_steps: 250_000,
  max_records: 500_000,
  max_text_length: 1_024,
});
const INDEX_KEYS = Object.freeze(["binding", "entries", "exclusions", "readBlobs"]);
const INDEX_BINDING_KEYS = Object.freeze([
  "cache", "classification_policy_hash", "classification_policy_version", "entry_count", "exclusion_count",
  "index_digest", "index_key", "index_version", "object_format", "repository_revision", "root_tree_oid",
  "total_blob_bytes",
]);
const ENTRY_KEYS = Object.freeze([
  "blob_oid", "byte_size", "classifications", "content_key", "entry_key", "language", "mode", "path",
]);
const CLASSIFICATION_KEYS = Object.freeze([
  "artifact_candidate_kinds", "generated", "manifest_kinds", "source", "test_source", "vendor",
]);
const EXCLUSION_KEYS = Object.freeze(["mode", "object_oid", "path", "reason"]);
const FACT_KEYS = Object.freeze(["index_digest", "partitions", "repository_revision", "schema_version"]);
const PARTITION_KEYS = Object.freeze([
  "aggregate_cache_keys", "edges", "nodes", "partition_id", "producer_analyzer_ids", "status",
]);
const NODE_KEYS = Object.freeze(["content_key", "language", "node_id", "path"]);
const EDGE_KEYS = Object.freeze(["certainty", "kind", "source_node_id", "target_node_id"]);
const ANALYZER_KEYS = Object.freeze([
  "analyzer_id", "analyzer_identity", "analyzer_version", "configuration_hash", "records",
]);
const RECORD_KEYS = Object.freeze([
  "cache_key", "content_key", "node_id", "partition_id", "path", "record_id", "scope",
]);
const TRUSTED_ANCESTRY = new WeakMap();

function fail(detail) {
  const error = new Error(`FAIL-DEPENDENCY-INVALIDATION: ${detail}`);
  error.code = "FAIL-DEPENDENCY-INVALIDATION";
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

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function assertExactKeys(value, keys, label) {
  if (!exactKeys(value, keys)) fail(`${label} must contain exactly ${keys.join(", ")}`);
}

function requireFrozen(value, label) {
  if (!Object.isFrozen(value)) fail(`${label} must be immutable`);
}

function validText(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.length > 0 && value.length <= HARD_LIMITS.max_text_length
    && !value.includes("\0");
}

function validDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validRepositoryPath(value) {
  if (!validText(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(stableCompare).map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(stableCompare);
}

function compareNullable(left, right) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return stableCompare(left, right);
}

function validateRepositoryIndex(index, label) {
  if (index === null || typeof index !== "object" || Array.isArray(index)) fail(`${label} must be a RepositoryIndex`);
  if (Object.keys(index).length !== INDEX_KEYS.length || !INDEX_KEYS.every((key) => Object.hasOwn(index, key))) {
    fail(`${label} must have the exact RepositoryIndex surface`);
  }
  requireFrozen(index, label);
  if (typeof index.readBlobs !== "function") fail(`${label}.readBlobs must be a function`);
  assertExactKeys(index.binding, INDEX_BINDING_KEYS, `${label}.binding`);
  requireFrozen(index.binding, `${label}.binding`);
  const binding = index.binding;
  if (binding.index_version !== "sei.repository-index@1") fail(`${label}.binding.index_version is unsupported`);
  if (!validText(binding.classification_policy_version) || !validDigest(binding.classification_policy_hash)
      || !validDigest(binding.index_key) || !validDigest(binding.index_digest)) fail(`${label}.binding digests are invalid`);
  if (!new Set(["sha1", "sha256"]).has(binding.object_format)) fail(`${label}.binding.object_format is invalid`);
  const oidLength = binding.object_format === "sha1" ? 40 : 64;
  const oidPattern = new RegExp(`^[0-9a-f]{${oidLength}}$`);
  if (!oidPattern.test(binding.repository_revision) || !oidPattern.test(binding.root_tree_oid)) {
    fail(`${label}.binding revision identities disagree with object_format`);
  }
  if (!validText(binding.cache)) fail(`${label}.binding.cache is invalid`);
  for (const key of ["entry_count", "exclusion_count", "total_blob_bytes"]) {
    if (!Number.isSafeInteger(binding[key]) || binding[key] < 0) fail(`${label}.binding.${key} is invalid`);
  }
  if (!Array.isArray(index.entries) || !Array.isArray(index.exclusions)) fail(`${label} arrays are invalid`);
  requireFrozen(index.entries, `${label}.entries`);
  requireFrozen(index.exclusions, `${label}.exclusions`);
  if (index.entries.length > HARD_LIMITS.max_paths) fail(`${label}.entries exceeds max_paths`);
  if (index.exclusions.length > HARD_LIMITS.max_paths) fail(`${label}.exclusions exceeds max_paths`);
  if (binding.entry_count !== index.entries.length || binding.exclusion_count !== index.exclusions.length) {
    fail(`${label}.binding counts disagree with materialization`);
  }
  const entries = [];
  const pathSet = new Set();
  let totalBlobBytes = 0;
  for (const [position, entry] of index.entries.entries()) {
    assertExactKeys(entry, ENTRY_KEYS, `${label}.entries[${position}]`);
    requireFrozen(entry, `${label}.entries[${position}]`);
    if (!validRepositoryPath(entry.path) || pathSet.has(entry.path)) fail(`${label}.entries paths are invalid or duplicate`);
    pathSet.add(entry.path);
    if (!oidPattern.test(entry.blob_oid) || entry.content_key !== `git-blob:${binding.object_format}:${entry.blob_oid}`) {
      fail(`${label}.entries[${position}] content identity is invalid`);
    }
    if (!new Set(["100644", "100755", "120000"]).has(entry.mode)
        || !Number.isSafeInteger(entry.byte_size) || entry.byte_size < 0 || !validText(entry.language)) {
      fail(`${label}.entries[${position}] metadata is invalid`);
    }
    assertExactKeys(entry.classifications, CLASSIFICATION_KEYS, `${label}.entries[${position}].classifications`);
    requireFrozen(entry.classifications, `${label}.entries[${position}].classifications`);
    const classifications = entry.classifications;
    if (typeof classifications.source !== "boolean" || typeof classifications.test_source !== "boolean"
        || !new Set(["generated", "human", "unknown"]).has(classifications.generated)
        || !new Set(["vendor", "not-vendor"]).has(classifications.vendor)) {
      fail(`${label}.entries[${position}].classifications values are invalid`);
    }
    for (const key of ["manifest_kinds", "artifact_candidate_kinds"]) {
      if (!Array.isArray(classifications[key]) || !Object.isFrozen(classifications[key])
          || classifications[key].some((value) => !validText(value))
          || canonicalJson(classifications[key]) !== canonicalJson(sortedUnique(classifications[key]))) {
        fail(`${label}.entries[${position}].classifications.${key} is invalid`);
      }
    }
    const identity = {
      path: entry.path,
      mode: entry.mode,
      blob_oid: entry.blob_oid,
      byte_size: entry.byte_size,
      content_key: entry.content_key,
      language: entry.language,
      classifications: {
        source: classifications.source,
        test_source: classifications.test_source,
        generated: classifications.generated,
        vendor: classifications.vendor,
        manifest_kinds: [...classifications.manifest_kinds],
        artifact_candidate_kinds: [...classifications.artifact_candidate_kinds],
      },
    };
    const expectedEntryKey = sha256(JSON.stringify({ classification_policy_hash: binding.classification_policy_hash, ...identity }));
    if (entry.entry_key !== expectedEntryKey) fail(`${label}.entries[${position}].entry_key is invalid`);
    totalBlobBytes += entry.byte_size;
    if (!Number.isSafeInteger(totalBlobBytes)) fail(`${label} total bytes exceed safe integer range`);
    entries.push({ ...identity, entry_key: entry.entry_key });
  }
  const orderedEntries = [...entries].sort((left, right) => stableCompare(left.path, right.path) || stableCompare(left.blob_oid, right.blob_oid));
  if (JSON.stringify(entries) !== JSON.stringify(orderedEntries)) fail(`${label}.entries are not canonically ordered`);
  const exclusions = [];
  for (const [position, exclusion] of index.exclusions.entries()) {
    assertExactKeys(exclusion, EXCLUSION_KEYS, `${label}.exclusions[${position}]`);
    requireFrozen(exclusion, `${label}.exclusions[${position}]`);
    if (!validRepositoryPath(exclusion.path) || exclusion.mode !== "160000"
        || !oidPattern.test(exclusion.object_oid) || !validText(exclusion.reason)) {
      fail(`${label}.exclusions[${position}] is invalid`);
    }
    exclusions.push({
      path: exclusion.path,
      mode: exclusion.mode,
      object_oid: exclusion.object_oid,
      reason: exclusion.reason,
    });
  }
  const orderedExclusions = [...exclusions].sort((left, right) => stableCompare(left.path, right.path)
    || stableCompare(left.object_oid, right.object_oid));
  if (JSON.stringify(exclusions) !== JSON.stringify(orderedExclusions)) fail(`${label}.exclusions are not canonically ordered`);
  if (totalBlobBytes !== binding.total_blob_bytes) fail(`${label}.binding.total_blob_bytes is invalid`);
  const expectedIndexKey = sha256(JSON.stringify({
    index_version: binding.index_version,
    object_format: binding.object_format,
    repository_revision: binding.repository_revision,
    root_tree_oid: binding.root_tree_oid,
    classification_policy_hash: binding.classification_policy_hash,
  }));
  if (binding.index_key !== expectedIndexKey) fail(`${label}.binding.index_key is invalid`);
  const digestBinding = {
    index_version: binding.index_version,
    classification_policy_version: binding.classification_policy_version,
    repository_revision: binding.repository_revision,
    root_tree_oid: binding.root_tree_oid,
    object_format: binding.object_format,
    classification_policy_hash: binding.classification_policy_hash,
    index_key: binding.index_key,
    entry_count: binding.entry_count,
    total_blob_bytes: binding.total_blob_bytes,
    exclusion_count: binding.exclusion_count,
  };
  const expectedIndexDigest = sha256(JSON.stringify({ binding: digestBinding, entries, exclusions }));
  if (binding.index_digest !== expectedIndexDigest) fail(`${label}.binding.index_digest is invalid`);
  return {
    value: index,
    binding: {
      repository_revision: binding.repository_revision,
      index_digest: binding.index_digest,
      index_key: binding.index_key,
      object_format: binding.object_format,
    },
    entries,
    entryByPath: new Map(entries.map((entry) => [entry.path, entry])),
  };
}

function normalizeDependencyFacts(facts, index, label) {
  assertExactKeys(facts, FACT_KEYS, label);
  requireFrozen(facts, label);
  if (facts.schema_version !== NORMALIZED_FACTS_VERSION) fail(`${label}.schema_version is unsupported`);
  if (facts.repository_revision !== index.binding.repository_revision || facts.index_digest !== index.binding.index_digest) {
    fail(`${label} does not bind its RepositoryIndex`);
  }
  if (!Array.isArray(facts.partitions) || !Object.isFrozen(facts.partitions)) fail(`${label}.partitions must be immutable`);
  if (facts.partitions.length > HARD_LIMITS.max_partitions) fail(`${label}.partitions exceeds max_partitions`);
  let nodeCount = 0;
  let edgeCount = 0;
  const partitionIds = new Set();
  const partitions = [];
  for (const [partitionPosition, partition] of facts.partitions.entries()) {
    const partitionLabel = `${label}.partitions[${partitionPosition}]`;
    assertExactKeys(partition, PARTITION_KEYS, partitionLabel);
    requireFrozen(partition, partitionLabel);
    if (!validText(partition.partition_id) || partitionIds.has(partition.partition_id)
        || !new Set(["available", "degraded", "unavailable", "unverifiable"]).has(partition.status)) {
      fail(`${partitionLabel} identity or status is invalid`);
    }
    if (!Array.isArray(partition.producer_analyzer_ids) || !Object.isFrozen(partition.producer_analyzer_ids)
        || partition.producer_analyzer_ids.length === 0
        || partition.producer_analyzer_ids.some((id) => !validText(id))
        || new Set(partition.producer_analyzer_ids).size !== partition.producer_analyzer_ids.length) {
      fail(`${partitionLabel}.producer_analyzer_ids is invalid`);
    }
    partitionIds.add(partition.partition_id);
    if (!Array.isArray(partition.nodes) || !Object.isFrozen(partition.nodes)
        || !Array.isArray(partition.edges) || !Object.isFrozen(partition.edges)
        || !Array.isArray(partition.aggregate_cache_keys) || !Object.isFrozen(partition.aggregate_cache_keys)) {
      fail(`${partitionLabel} arrays must be immutable`);
    }
    nodeCount += partition.nodes.length;
    edgeCount += partition.edges.length;
    if (nodeCount > HARD_LIMITS.max_nodes) fail(`${label} nodes exceeds max_nodes`);
    if (edgeCount > HARD_LIMITS.max_edges) fail(`${label} edges exceeds max_edges`);
    const nodeIds = new Set();
    const nodes = [];
    let uncertainPathIdentity = false;
    for (const [nodePosition, node] of partition.nodes.entries()) {
      const nodeLabel = `${partitionLabel}.nodes[${nodePosition}]`;
      assertExactKeys(node, NODE_KEYS, nodeLabel);
      requireFrozen(node, nodeLabel);
      if (!validText(node.node_id) || nodeIds.has(node.node_id) || !validText(node.language)) {
        fail(`${nodeLabel} identity is invalid or duplicate`);
      }
      nodeIds.add(node.node_id);
      if (node.path === null || node.content_key === null) {
        if (node.path !== null || node.content_key !== null) fail(`${nodeLabel} uncertain path binding must use paired nulls`);
        uncertainPathIdentity = true;
      } else {
        if (!validRepositoryPath(node.path) || !validText(node.content_key)) fail(`${nodeLabel} path binding is invalid`);
        const entry = index.entryByPath.get(node.path);
        if (!entry || entry.content_key !== node.content_key || entry.language !== node.language) {
          fail(`${nodeLabel} does not bind an indexed entry`);
        }
      }
      nodes.push({
        node_id: node.node_id,
        path: node.path,
        content_key: node.content_key,
        language: node.language,
      });
    }
    nodes.sort((left, right) => stableCompare(left.node_id, right.node_id)
      || compareNullable(left.path, right.path) || compareNullable(left.content_key, right.content_key));
    const edgeIdentities = new Set();
    const edges = [];
    let uncertainEdge = false;
    for (const [edgePosition, edge] of partition.edges.entries()) {
      const edgeLabel = `${partitionLabel}.edges[${edgePosition}]`;
      assertExactKeys(edge, EDGE_KEYS, edgeLabel);
      requireFrozen(edge, edgeLabel);
      if (!validText(edge.source_node_id) || !nodeIds.has(edge.source_node_id) || !validText(edge.kind)
          || !new Set(["exact", "dynamic", "unresolved", "unknown"]).has(edge.certainty)) {
        fail(`${edgeLabel} identity is invalid`);
      }
      if (edge.certainty === "exact") {
        if (!validText(edge.target_node_id) || !nodeIds.has(edge.target_node_id)) fail(`${edgeLabel} exact target is invalid`);
      } else {
        if (edge.target_node_id !== null) fail(`${edgeLabel} uncertain target must be null`);
        uncertainEdge = true;
      }
      const normalized = {
        source_node_id: edge.source_node_id,
        target_node_id: edge.target_node_id,
        kind: edge.kind,
        certainty: edge.certainty,
      };
      const identity = canonicalJson(normalized);
      if (edgeIdentities.has(identity)) fail(`${edgeLabel} is duplicate`);
      edgeIdentities.add(identity);
      edges.push(normalized);
    }
    edges.sort((left, right) => stableCompare(left.source_node_id, right.source_node_id)
      || compareNullable(left.target_node_id, right.target_node_id)
      || stableCompare(left.kind, right.kind) || stableCompare(left.certainty, right.certainty));
    if (partition.aggregate_cache_keys.some((key) => !validDigest(key))
        || new Set(partition.aggregate_cache_keys).size !== partition.aggregate_cache_keys.length) {
      fail(`${partitionLabel}.aggregate_cache_keys are invalid`);
    }
    const aggregateCacheKeys = [...partition.aggregate_cache_keys].sort(stableCompare);
    const normalized = {
      partition_id: partition.partition_id,
      producer_analyzer_ids: [...partition.producer_analyzer_ids].sort(stableCompare),
      status: partition.status,
      nodes,
      edges,
      aggregate_cache_keys: aggregateCacheKeys,
    };
    const structural = {
      partition_id: normalized.partition_id,
      producer_analyzer_ids: normalized.producer_analyzer_ids,
      status: normalized.status,
      nodes: normalized.nodes,
      edges: normalized.edges,
    };
    partitions.push({
      ...normalized,
      uncertain_edge: uncertainEdge,
      uncertain_path_identity: uncertainPathIdentity,
      digest: sha256(canonicalJson(normalized)),
      structural_digest: sha256(canonicalJson(structural)),
      nodeById: new Map(nodes.map((node) => [node.node_id, node])),
    });
  }
  partitions.sort((left, right) => stableCompare(left.partition_id, right.partition_id));
  const normalizedFacts = {
    schema_version: NORMALIZED_FACTS_VERSION,
    repository_revision: facts.repository_revision,
    index_digest: facts.index_digest,
    partitions: partitions.map(({
      uncertain_edge, uncertain_path_identity, digest, structural_digest, nodeById, ...partition
    }) => partition),
  };
  return {
    normalized: normalizedFacts,
    digest: sha256(canonicalJson(normalizedFacts)),
    partitions,
    partitionById: new Map(partitions.map((partition) => [partition.partition_id, partition])),
    node_count: nodeCount,
    edge_count: edgeCount,
  };
}

function analyzerBindingKey(analyzer) {
  return sha256(canonicalJson({
    analyzer_id: analyzer.analyzer_id,
    analyzer_identity: analyzer.analyzer_identity,
    analyzer_version: analyzer.analyzer_version,
    configuration_hash: analyzer.configuration_hash,
  }));
}

function normalizeAnalyzers(analyzers, index, facts, label) {
  if (!Array.isArray(analyzers) || !Object.isFrozen(analyzers)) fail(`${label} must be an immutable array`);
  if (analyzers.length > HARD_LIMITS.max_analyzers) fail(`${label} exceeds max_analyzers`);
  const analyzerIds = new Set();
  const normalized = [];
  let recordCount = 0;
  for (const [analyzerPosition, analyzer] of analyzers.entries()) {
    const analyzerLabel = `${label}[${analyzerPosition}]`;
    assertExactKeys(analyzer, ANALYZER_KEYS, analyzerLabel);
    requireFrozen(analyzer, analyzerLabel);
    if (!validText(analyzer.analyzer_id) || analyzerIds.has(analyzer.analyzer_id)
        || !validText(analyzer.analyzer_identity) || !validText(analyzer.analyzer_version)
        || !validDigest(analyzer.configuration_hash)) fail(`${analyzerLabel} identity is invalid or duplicate`);
    analyzerIds.add(analyzer.analyzer_id);
    if (!Array.isArray(analyzer.records) || !Object.isFrozen(analyzer.records)) fail(`${analyzerLabel}.records must be immutable`);
    recordCount += analyzer.records.length;
    if (recordCount > HARD_LIMITS.max_records) fail(`${label} records exceeds max_records`);
    const recordIds = new Set();
    const records = [];
    for (const [recordPosition, record] of analyzer.records.entries()) {
      const recordLabel = `${analyzerLabel}.records[${recordPosition}]`;
      assertExactKeys(record, RECORD_KEYS, recordLabel);
      requireFrozen(record, recordLabel);
      if (!validText(record.record_id) || recordIds.has(record.record_id) || !validDigest(record.cache_key)
          || !new Set(["path", "node", "partition", "global"]).has(record.scope)
          || !validText(record.partition_id)) fail(`${recordLabel} identity is invalid or duplicate`);
      recordIds.add(record.record_id);
      const partition = record.partition_id === "*" ? null : facts.partitionById.get(record.partition_id);
      if (record.scope === "global") {
        if (record.partition_id !== "*" || record.path !== null || record.node_id !== null || record.content_key !== null) {
          fail(`${recordLabel} global binding is invalid`);
        }
      } else if (record.scope === "partition") {
        if (!partition || record.path !== null || record.node_id !== null || record.content_key !== null) {
          fail(`${recordLabel} partition binding is invalid`);
        }
      } else {
        if (!partition || !validRepositoryPath(record.path) || !validText(record.content_key)) {
          fail(`${recordLabel} path binding is invalid`);
        }
        const entry = index.entryByPath.get(record.path);
        if (!entry || entry.content_key !== record.content_key) fail(`${recordLabel} does not bind an indexed entry`);
        if (record.scope === "path" && record.node_id !== null) fail(`${recordLabel} path record must not bind a node`);
        if (record.scope === "node") {
          if (!validText(record.node_id)) fail(`${recordLabel}.node_id is invalid`);
          const node = partition.nodeById.get(record.node_id);
          if (!node || node.path !== record.path || node.content_key !== record.content_key) {
            fail(`${recordLabel} does not bind a partition node`);
          }
        }
      }
      records.push({
        record_id: record.record_id,
        cache_key: record.cache_key,
        scope: record.scope,
        partition_id: record.partition_id,
        path: record.path,
        node_id: record.node_id,
        content_key: record.content_key,
      });
    }
    records.sort((left, right) => stableCompare(left.record_id, right.record_id));
    const bindingKey = analyzerBindingKey(analyzer);
    normalized.push({
      analyzer_id: analyzer.analyzer_id,
      analyzer_identity: analyzer.analyzer_identity,
      analyzer_version: analyzer.analyzer_version,
      configuration_hash: analyzer.configuration_hash,
      binding_key: bindingKey,
      records,
      recordById: new Map(records.map((record) => [record.record_id, record])),
    });
  }
  normalized.sort((left, right) => stableCompare(left.analyzer_id, right.analyzer_id));
  const analyzerById = new Map(normalized.map((analyzer) => [analyzer.analyzer_id, analyzer]));
  for (const partition of facts.partitions) {
    for (const producerAnalyzerId of partition.producer_analyzer_ids) {
      if (!analyzerById.has(producerAnalyzerId)) fail(`${label} does not declare producer ${producerAnalyzerId}`);
    }
  }
  return { analyzers: normalized, analyzerById, record_count: recordCount };
}

function normalizeSnapshot(snapshot, label) {
  assertExactKeys(snapshot, ["analyzers", "dependencyFacts", "repositoryIndex"], label);
  requireFrozen(snapshot, label);
  const index = validateRepositoryIndex(snapshot.repositoryIndex, `${label}.repositoryIndex`);
  const facts = normalizeDependencyFacts(snapshot.dependencyFacts, index, `${label}.dependencyFacts`);
  const analyzers = normalizeAnalyzers(snapshot.analyzers, index, facts, `${label}.analyzers`);
  return { value: snapshot, index, facts, ...analyzers };
}

function portableSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot, "snapshot");
  return deepFreeze(canonicalValue({
    schema_version: PORTABLE_SNAPSHOT_VERSION,
    repository_index: {
      binding: normalized.index.value.binding,
      entries: normalized.index.entries,
      exclusions: normalized.index.value.exclusions,
    },
    dependency_facts: normalized.facts.normalized,
    analyzers: normalized.analyzers.map((analyzer) => ({
      analyzer_id: analyzer.analyzer_id,
      analyzer_identity: analyzer.analyzer_identity,
      analyzer_version: analyzer.analyzer_version,
      configuration_hash: analyzer.configuration_hash,
      records: analyzer.records,
    })),
  }));
}

function rehydratePortableSnapshot(value) {
  assertExactKeys(value, ["analyzers", "dependency_facts", "repository_index", "schema_version"], "portable snapshot");
  if (value.schema_version !== PORTABLE_SNAPSHOT_VERSION) fail("portable snapshot schema is unsupported");
  assertExactKeys(value.repository_index, ["binding", "entries", "exclusions"], "portable snapshot repository_index");
  const repositoryIndex = deepFreeze(canonicalValue({
    binding: value.repository_index.binding,
    entries: value.repository_index.entries,
    exclusions: value.repository_index.exclusions,
    async readBlobs() {
      fail("portable dependency snapshot does not expose repository blobs");
    },
  }));
  const snapshot = deepFreeze(canonicalValue({
    repositoryIndex,
    dependencyFacts: value.dependency_facts,
    analyzers: value.analyzers,
  }));
  normalizeSnapshot(snapshot, "portable snapshot");
  return snapshot;
}

function createTrustedAncestryBinding(input) {
  assertExactKeys(input, [
    "currentRepositoryIndex", "evidenceDigest", "priorRepositoryIndex", "relationship",
  ], "trusted ancestry input");
  if (input.priorRepositoryIndex === null || typeof input.priorRepositoryIndex !== "object"
      || input.currentRepositoryIndex === null || typeof input.currentRepositoryIndex !== "object") {
    fail("trusted ancestry input must bind RepositoryIndex objects");
  }
  if (!Object.isFrozen(input.priorRepositoryIndex) || !Object.isFrozen(input.currentRepositoryIndex)) {
    fail("trusted ancestry input RepositoryIndex objects must be immutable");
  }
  const priorRevision = input.priorRepositoryIndex.binding?.repository_revision;
  const currentRevision = input.currentRepositoryIndex.binding?.repository_revision;
  if (!validText(priorRevision) || !validText(currentRevision) || !validDigest(input.evidenceDigest)
      || !new Set(["strict-ancestor", "same-revision", "not-ancestor", "unverifiable"]).has(input.relationship)) {
    fail("trusted ancestry input is invalid");
  }
  if (input.relationship === "same-revision" && priorRevision !== currentRevision) {
    fail("same-revision ancestry disagrees with RepositoryIndex revisions");
  }
  if (input.relationship === "strict-ancestor" && priorRevision === currentRevision) {
    fail("strict-ancestor ancestry requires distinct revisions");
  }
  const publicBinding = {
    schema_version: "sei.trusted-revision-ancestry@1",
    prior_repository_revision: priorRevision,
    current_repository_revision: currentRevision,
    relationship: input.relationship,
    evidence_digest: input.evidenceDigest,
  };
  const binding = deepFreeze({ ...publicBinding, binding_digest: sha256(canonicalJson(publicBinding)) });
  TRUSTED_ANCESTRY.set(binding, {
    priorRepositoryIndex: input.priorRepositoryIndex,
    currentRepositoryIndex: input.currentRepositoryIndex,
  });
  return binding;
}

function evaluateAncestry(binding, prior, current) {
  const owner = binding && typeof binding === "object" ? TRUSTED_ANCESTRY.get(binding) : undefined;
  if (!owner || owner.priorRepositoryIndex !== prior.value.repositoryIndex
      || owner.currentRepositoryIndex !== current.value.repositoryIndex) {
    return {
      status: "unverified",
      relationship: null,
      evidence_digest: null,
      binding_digest: null,
      fallback_reason: "ancestry-binding-untrusted",
    };
  }
  const expectedPublic = {
    schema_version: "sei.trusted-revision-ancestry@1",
    prior_repository_revision: prior.index.binding.repository_revision,
    current_repository_revision: current.index.binding.repository_revision,
    relationship: binding.relationship,
    evidence_digest: binding.evidence_digest,
  };
  if (!exactKeys(binding, [...Object.keys(expectedPublic), "binding_digest"])
      || binding.binding_digest !== sha256(canonicalJson(expectedPublic))
      || binding.prior_repository_revision !== expectedPublic.prior_repository_revision
      || binding.current_repository_revision !== expectedPublic.current_repository_revision) {
    return {
      status: "unverified",
      relationship: null,
      evidence_digest: null,
      binding_digest: null,
      fallback_reason: "ancestry-binding-invalid",
    };
  }
  const allowed = new Set(["strict-ancestor", "same-revision"]);
  return {
    status: allowed.has(binding.relationship) ? "verified" : binding.relationship,
    relationship: binding.relationship,
    evidence_digest: binding.evidence_digest,
    binding_digest: binding.binding_digest,
    fallback_reason: allowed.has(binding.relationship) ? null : `ancestry-${binding.relationship}`,
  };
}

function unavailableAncestry(reason) {
  return {
    status: "unverified",
    relationship: null,
    evidence_digest: null,
    binding_digest: null,
    fallback_reason: reason,
  };
}

function diffPaths(priorIndex, currentIndex) {
  if (priorIndex.binding.object_format !== currentIndex.binding.object_format) {
    return {
      status: "unverifiable",
      added: [],
      changed: [],
      deleted: [],
      renamed: [],
      uncertain_renames: [],
    };
  }
  const priorByPath = priorIndex.entryByPath;
  const currentByPath = currentIndex.entryByPath;
  const changed = [];
  const priorOnly = [];
  const currentOnly = [];
  for (const [filePath, priorEntry] of priorByPath) {
    const currentEntry = currentByPath.get(filePath);
    if (!currentEntry) priorOnly.push(priorEntry);
    else if (priorEntry.blob_oid !== currentEntry.blob_oid) changed.push(filePath);
  }
  for (const [filePath, currentEntry] of currentByPath) {
    if (!priorByPath.has(filePath)) currentOnly.push(currentEntry);
  }
  const priorCounts = new Map();
  const currentCounts = new Map();
  for (const entry of priorIndex.entries) priorCounts.set(entry.content_key, (priorCounts.get(entry.content_key) ?? 0) + 1);
  for (const entry of currentIndex.entries) currentCounts.set(entry.content_key, (currentCounts.get(entry.content_key) ?? 0) + 1);
  const deletedByContent = new Map();
  const addedByContent = new Map();
  for (const entry of priorOnly) {
    if (!deletedByContent.has(entry.content_key)) deletedByContent.set(entry.content_key, []);
    deletedByContent.get(entry.content_key).push(entry);
  }
  for (const entry of currentOnly) {
    if (!addedByContent.has(entry.content_key)) addedByContent.set(entry.content_key, []);
    addedByContent.get(entry.content_key).push(entry);
  }
  const renamed = [];
  const uncertainRenames = [];
  const renamedFrom = new Set();
  const renamedTo = new Set();
  for (const contentKey of sortedUnique([...deletedByContent.keys(), ...addedByContent.keys()])) {
    const deleted = deletedByContent.get(contentKey) ?? [];
    const added = addedByContent.get(contentKey) ?? [];
    if (deleted.length === 0 || added.length === 0) continue;
    if (deleted.length === 1 && added.length === 1
        && priorCounts.get(contentKey) === 1 && currentCounts.get(contentKey) === 1) {
      renamed.push({ from: deleted[0].path, to: added[0].path, content_key: contentKey });
      renamedFrom.add(deleted[0].path);
      renamedTo.add(added[0].path);
    } else {
      uncertainRenames.push({
        content_key: contentKey,
        added_paths: added.map((entry) => entry.path).sort(stableCompare),
        deleted_paths: deleted.map((entry) => entry.path).sort(stableCompare),
      });
    }
  }
  renamed.sort((left, right) => stableCompare(left.from, right.from) || stableCompare(left.to, right.to));
  uncertainRenames.sort((left, right) => stableCompare(left.content_key, right.content_key));
  return {
    status: uncertainRenames.length === 0 ? "verified" : "uncertain",
    added: currentOnly.map((entry) => entry.path).filter((filePath) => !renamedTo.has(filePath)).sort(stableCompare),
    changed: changed.sort(stableCompare),
    deleted: priorOnly.map((entry) => entry.path).filter((filePath) => !renamedFrom.has(filePath)).sort(stableCompare),
    renamed,
    uncertain_renames: uncertainRenames,
  };
}

function directPathReasons(pathChanges) {
  const prior = new Map();
  const current = new Map();
  const add = (map, filePath, reason) => {
    if (!map.has(filePath)) map.set(filePath, []);
    map.get(filePath).push(reason);
  };
  for (const filePath of pathChanges.changed) {
    add(prior, filePath, { kind: "changed-content", path: filePath, revision_side: "prior" });
    add(current, filePath, { kind: "changed-content", path: filePath, revision_side: "current" });
  }
  for (const filePath of pathChanges.added) add(current, filePath, { kind: "added-path", path: filePath, revision_side: "current" });
  for (const filePath of pathChanges.deleted) add(prior, filePath, { kind: "deleted-path", path: filePath, revision_side: "prior" });
  for (const rename of pathChanges.renamed) {
    add(prior, rename.from, { kind: "renamed-path", path: rename.from, from: rename.from, to: rename.to, revision_side: "prior" });
    add(current, rename.to, { kind: "renamed-path", path: rename.to, from: rename.from, to: rename.to, revision_side: "current" });
  }
  for (const uncertain of pathChanges.uncertain_renames) {
    for (const filePath of uncertain.deleted_paths) add(prior, filePath, { kind: "uncertain-path-identity", path: filePath, revision_side: "prior" });
    for (const filePath of uncertain.added_paths) add(current, filePath, { kind: "uncertain-path-identity", path: filePath, revision_side: "current" });
  }
  return { prior, current };
}

function compareReasonChains(left, right) {
  return (left.length - right.length) || stableCompare(canonicalJson(left), canonicalJson(right));
}

function traverseReverse(partition, side, pathReasons) {
  const reverse = new Map(partition.nodes.map((node) => [node.node_id, []]));
  for (const edge of partition.edges) {
    if (edge.certainty !== "exact") continue;
    reverse.get(edge.target_node_id).push(edge);
  }
  for (const edges of reverse.values()) {
    edges.sort((left, right) => stableCompare(left.source_node_id, right.source_node_id)
      || stableCompare(left.target_node_id, right.target_node_id) || stableCompare(left.kind, right.kind));
  }
  const candidates = [];
  for (const node of partition.nodes) {
    if (node.path === null) continue;
    for (const reason of pathReasons.get(node.path) ?? []) candidates.push({ node_id: node.node_id, chain: [reason] });
  }
  candidates.sort((left, right) => stableCompare(left.node_id, right.node_id) || compareReasonChains(left.chain, right.chain));
  const visited = new Map();
  const queue = [];
  let reasonSteps = 0;
  for (const candidate of candidates) {
    if (!visited.has(candidate.node_id)) {
      visited.set(candidate.node_id, candidate.chain);
      queue.push(candidate.node_id);
      reasonSteps += candidate.chain.length;
    }
  }
  let depthExceeded = false;
  let budgetExceeded = reasonSteps > HARD_LIMITS.max_reason_steps;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const dependencyNodeId = queue[cursor];
    const chain = visited.get(dependencyNodeId);
    for (const edge of reverse.get(dependencyNodeId) ?? []) {
      if (visited.has(edge.source_node_id)) continue;
      const dependencyDepth = chain.length;
      if (dependencyDepth > HARD_LIMITS.max_reason_depth) {
        depthExceeded = true;
        continue;
      }
      const nextChain = [...chain, {
        kind: "reverse-dependency",
        source_node_id: edge.source_node_id,
        target_node_id: edge.target_node_id,
        edge_kind: edge.kind,
        revision_side: side,
      }];
      if (reasonSteps + nextChain.length > HARD_LIMITS.max_reason_steps) {
        budgetExceeded = true;
        continue;
      }
      visited.set(edge.source_node_id, nextChain);
      queue.push(edge.source_node_id);
      reasonSteps += nextChain.length;
    }
  }
  return { visited, depthExceeded, budgetExceeded };
}

function partitionAnalyzerDrift(prior, current, priorPartition, currentPartition) {
  if (!priorPartition || !currentPartition) return true;
  if (canonicalJson(priorPartition.producer_analyzer_ids) !== canonicalJson(currentPartition.producer_analyzer_ids)) return true;
  return currentPartition.producer_analyzer_ids.some((producerAnalyzerId) => {
    const priorAnalyzer = prior.analyzerById.get(producerAnalyzerId);
    const currentAnalyzer = current.analyzerById.get(producerAnalyzerId);
    return !priorAnalyzer || !currentAnalyzer || priorAnalyzer.binding_key !== currentAnalyzer.binding_key;
  });
}

function crossRevisionNodeIdentityUncertain(priorPartition, currentPartition, pathChanges) {
  if (!priorPartition || !currentPartition) return false;
  const exactRenames = new Map(pathChanges.renamed.map((rename) => [rename.from, rename.to]));
  const currentByPath = new Map(currentPartition.nodes
    .filter((node) => node.path !== null).map((node) => [node.path, node]));
  for (const priorNode of priorPartition.nodes) {
    const currentNode = currentPartition.nodeById.get(priorNode.node_id);
    if (currentNode && priorNode.path !== currentNode.path) {
      const exactRename = priorNode.path !== null && currentNode.path !== null
        && exactRenames.get(priorNode.path) === currentNode.path
        && priorNode.content_key === currentNode.content_key;
      if (!exactRename) return true;
    }
    if (priorNode.path === null) continue;
    const nodeAtSamePath = currentByPath.get(priorNode.path);
    if (nodeAtSamePath && nodeAtSamePath.node_id !== priorNode.node_id) return true;
  }
  return false;
}

function fallbackAffectedNodes(partitionId, priorPartition, currentPartition, reason) {
  const combined = new Map();
  for (const [side, partition] of [["prior", priorPartition], ["current", currentPartition]]) {
    for (const node of partition?.nodes ?? []) {
      const key = node.node_id;
      if (!combined.has(key)) combined.set(key, {
        partition_id: partitionId,
        node_id: node.node_id,
        paths: [],
        content_keys: [],
        revision_sides: [],
        reason_chain: [{ kind: "full-partition-fallback", reason, revision_side: side }],
      });
      const entry = combined.get(key);
      if (node.path !== null) entry.paths.push(node.path);
      if (node.content_key !== null) entry.content_keys.push(node.content_key);
      entry.revision_sides.push(side);
      const candidate = [{ kind: "full-partition-fallback", reason, revision_side: side }];
      if (compareReasonChains(candidate, entry.reason_chain) < 0) entry.reason_chain = candidate;
    }
  }
  return [...combined.values()].map((entry) => ({
    ...entry,
    paths: sortedUnique(entry.paths),
    content_keys: sortedUnique(entry.content_keys),
    revision_sides: sortedUnique(entry.revision_sides),
  })).sort((left, right) => stableCompare(left.node_id, right.node_id));
}

function mergeAffectedNodes(partitionId, priorPartition, currentPartition, priorTraversal, currentTraversal) {
  const combined = new Map();
  for (const [side, partition, traversal] of [
    ["prior", priorPartition, priorTraversal], ["current", currentPartition, currentTraversal],
  ]) {
    if (!partition || !traversal) continue;
    for (const [nodeId, chain] of traversal.visited) {
      const node = partition.nodeById.get(nodeId);
      if (!combined.has(nodeId)) combined.set(nodeId, {
        partition_id: partitionId,
        node_id: nodeId,
        paths: [],
        content_keys: [],
        revision_sides: [],
        reason_chain: chain,
      });
      const entry = combined.get(nodeId);
      if (node.path !== null) entry.paths.push(node.path);
      if (node.content_key !== null) entry.content_keys.push(node.content_key);
      entry.revision_sides.push(side);
      if (compareReasonChains(chain, entry.reason_chain) < 0) entry.reason_chain = chain;
    }
  }
  return [...combined.values()].map((entry) => ({
    ...entry,
    paths: sortedUnique(entry.paths),
    content_keys: sortedUnique(entry.content_keys),
    revision_sides: sortedUnique(entry.revision_sides),
  })).sort((left, right) => stableCompare(left.node_id, right.node_id));
}

function buildDependencyPartitions(prior, current, pathChanges, globalReasons) {
  const partitionIds = sortedUnique([
    ...prior.facts.partitions.map((partition) => partition.partition_id),
    ...current.facts.partitions.map((partition) => partition.partition_id),
  ]);
  const pathReasonMaps = directPathReasons(pathChanges);
  const partitions = [];
  const allAffectedNodes = [];
  for (const partitionId of partitionIds) {
    const priorPartition = prior.facts.partitionById.get(partitionId) ?? null;
    const currentPartition = current.facts.partitionById.get(partitionId) ?? null;
    const reasons = [...globalReasons];
    if (!priorPartition) reasons.push("prior-partition-missing");
    if (!currentPartition) reasons.push("current-partition-missing");
    if (priorPartition && priorPartition.status !== "available") reasons.push(`prior-dependency-facts-${priorPartition.status}`);
    if (currentPartition && currentPartition.status !== "available") reasons.push(`current-dependency-facts-${currentPartition.status}`);
    if (priorPartition?.uncertain_edge || currentPartition?.uncertain_edge) reasons.push("uncertain-dependency-edge");
    if (priorPartition?.uncertain_path_identity || currentPartition?.uncertain_path_identity) reasons.push("uncertain-node-path-identity");
    if (crossRevisionNodeIdentityUncertain(priorPartition, currentPartition, pathChanges)) {
      reasons.push("cross-revision-node-identity-uncertain");
    }
    const producerDrift = partitionAnalyzerDrift(prior, current, priorPartition, currentPartition);
    if (producerDrift) reasons.push("producer-analyzer-binding-drift");
    let priorTraversal = priorPartition ? traverseReverse(priorPartition, "prior", pathReasonMaps.prior) : null;
    let currentTraversal = currentPartition ? traverseReverse(currentPartition, "current", pathReasonMaps.current) : null;
    if (priorTraversal?.depthExceeded || currentTraversal?.depthExceeded) reasons.push("reason-depth-exceeded");
    if (priorTraversal?.budgetExceeded || currentTraversal?.budgetExceeded) reasons.push("reason-budget-exceeded");
    const partitionHasBoundPathChange = (priorTraversal?.visited.size ?? 0) > 0
      || (currentTraversal?.visited.size ?? 0) > 0;
    if (priorPartition && currentPartition && priorPartition.structural_digest !== currentPartition.structural_digest
        && !partitionHasBoundPathChange && !producerDrift) {
      reasons.push("dependency-facts-drift-without-authoritative-change");
    }
    const orderedReasons = sortedUnique(reasons);
    const mode = orderedReasons.length === 0 ? "incremental" : "full-recompute";
    let affectedNodes;
    if (mode === "full-recompute") {
      affectedNodes = fallbackAffectedNodes(partitionId, priorPartition, currentPartition, orderedReasons[0]);
    } else {
      affectedNodes = mergeAffectedNodes(partitionId, priorPartition, currentPartition, priorTraversal, currentTraversal);
    }
    allAffectedNodes.push(...affectedNodes);
    const factsChanged = priorPartition?.structural_digest !== currentPartition?.structural_digest;
    const topologyRecompute = mode === "full-recompute" || affectedNodes.length > 0 || factsChanged;
    partitions.push({
      partition_id: partitionId,
      mode,
      reasons: orderedReasons,
      prior_facts_digest: priorPartition?.digest ?? null,
      current_facts_digest: currentPartition?.digest ?? null,
      affected_node_count: affectedNodes.length,
      topology_recompute: topologyRecompute,
    });
  }
  allAffectedNodes.sort((left, right) => stableCompare(left.partition_id, right.partition_id)
    || stableCompare(left.node_id, right.node_id));
  return { partitions, affectedNodes: allAffectedNodes, pathReasonMaps, globalReasons: sortedUnique(globalReasons) };
}

function recordPairOutput(analyzerId, priorRecord, currentRecord, reasons, reusable = false) {
  const selected = currentRecord ?? priorRecord;
  const output = {
    analyzer_id: analyzerId,
    record_id: selected.record_id,
    scope: selected.scope,
    partition_id: selected.partition_id,
    path: selected.path,
    node_id: selected.node_id,
    prior_cache_key: priorRecord?.cache_key ?? null,
    current_cache_key: currentRecord?.cache_key ?? null,
    prior_content_key: priorRecord?.content_key ?? null,
    current_content_key: currentRecord?.content_key ?? null,
  };
  if (reusable) output.cache_key = currentRecord.cache_key;
  else output.reasons = sortedUnique(reasons);
  return output;
}

function recordMetadataEqual(priorRecord, currentRecord) {
  return priorRecord.scope === currentRecord.scope && priorRecord.partition_id === currentRecord.partition_id
    && priorRecord.path === currentRecord.path && priorRecord.node_id === currentRecord.node_id
    && priorRecord.content_key === currentRecord.content_key;
}

function classifyAnalyzerRecords(prior, current, pathReasonMaps, dependencyResult) {
  const direct = [];
  const affected = [];
  const reusable = [];
  const fullPartitions = new Set(dependencyResult.partitions
    .filter((partition) => partition.mode === "full-recompute").map((partition) => partition.partition_id));
  const topologyPartitions = new Set(dependencyResult.partitions
    .filter((partition) => partition.topology_recompute).map((partition) => partition.partition_id));
  const affectedNodes = new Set(dependencyResult.affectedNodes
    .map((node) => `${node.partition_id}\0${node.node_id}`));
  const analyzerIds = sortedUnique([...prior.analyzerById.keys(), ...current.analyzerById.keys()]);
  for (const analyzerId of analyzerIds) {
    const priorAnalyzer = prior.analyzerById.get(analyzerId) ?? null;
    const currentAnalyzer = current.analyzerById.get(analyzerId) ?? null;
    const analyzerDrift = priorAnalyzer?.binding_key !== currentAnalyzer?.binding_key;
    const recordIds = sortedUnique([
      ...(priorAnalyzer?.records ?? []).map((record) => record.record_id),
      ...(currentAnalyzer?.records ?? []).map((record) => record.record_id),
    ]);
    for (const recordId of recordIds) {
      const priorRecord = priorAnalyzer?.recordById.get(recordId) ?? null;
      const currentRecord = currentAnalyzer?.recordById.get(recordId) ?? null;
      const selected = currentRecord ?? priorRecord;
      const reasons = [];
      reasons.push(...dependencyResult.globalReasons);
      if (analyzerDrift) reasons.push("analyzer-binding-drift");
      if (!priorRecord) reasons.push("record-added");
      if (!currentRecord) reasons.push("record-deleted");
      if (priorRecord && priorRecord.path !== null && pathReasonMaps.prior.has(priorRecord.path)) reasons.push("direct-path-change");
      if (currentRecord && currentRecord.path !== null && pathReasonMaps.current.has(currentRecord.path)) reasons.push("direct-path-change");
      if (selected.scope === "global" && fullPartitions.size > 0) reasons.push("partition-full-recompute");
      if (selected.scope !== "global" && fullPartitions.has(selected.partition_id)) reasons.push("partition-full-recompute");
      if (reasons.length > 0) {
        direct.push(recordPairOutput(analyzerId, priorRecord, currentRecord, reasons));
        continue;
      }
      if (priorRecord && currentRecord && !recordMetadataEqual(priorRecord, currentRecord)) {
        direct.push(recordPairOutput(analyzerId, priorRecord, currentRecord, ["record-binding-drift"]));
        continue;
      }
      if (priorRecord && currentRecord && priorRecord.cache_key !== currentRecord.cache_key) {
        direct.push(recordPairOutput(analyzerId, priorRecord, currentRecord, ["cache-key-drift"]));
        continue;
      }
      const nodeAffected = selected.scope === "node"
        && affectedNodes.has(`${selected.partition_id}\0${selected.node_id}`);
      const aggregateAffected = (selected.scope === "partition" && topologyPartitions.has(selected.partition_id))
        || (selected.scope === "global" && topologyPartitions.size > 0);
      if (nodeAffected || aggregateAffected) {
        affected.push(recordPairOutput(analyzerId, priorRecord, currentRecord, [
          nodeAffected ? "reverse-transitive-dependency" : "topology-or-global-aggregate",
        ]));
        continue;
      }
      if (priorRecord && currentRecord) {
        reusable.push(recordPairOutput(analyzerId, priorRecord, currentRecord, [], true));
      } else {
        direct.push(recordPairOutput(analyzerId, priorRecord, currentRecord, ["record-comparability-unavailable"]));
      }
    }
  }
  const compare = (left, right) => stableCompare(left.analyzer_id, right.analyzer_id)
    || stableCompare(left.record_id, right.record_id);
  const recomputePartitionsByAnalyzer = new Map();
  for (const record of [...direct, ...affected]) {
    if (record.scope === "global") continue;
    if (!recomputePartitionsByAnalyzer.has(record.analyzer_id)) recomputePartitionsByAnalyzer.set(record.analyzer_id, new Set());
    recomputePartitionsByAnalyzer.get(record.analyzer_id).add(record.partition_id);
  }
  const retainedReusable = [];
  for (const record of reusable) {
    const recomputePartitions = recomputePartitionsByAnalyzer.get(record.analyzer_id) ?? new Set();
    const aggregateAffected = (record.scope === "partition" && recomputePartitions.has(record.partition_id))
      || (record.scope === "global" && recomputePartitions.size > 0);
    if (!aggregateAffected) {
      retainedReusable.push(record);
      continue;
    }
    const { cache_key: cacheKey, ...pairedRecord } = record;
    if (cacheKey !== record.current_cache_key) fail("reusable aggregate cache identity is inconsistent");
    affected.push({
      ...pairedRecord,
      reasons: [record.scope === "global" ? "analyzer-global-aggregate" : "analyzer-partition-aggregate"],
    });
  }
  direct.sort(compare);
  affected.sort(compare);
  retainedReusable.sort(compare);
  return { direct, affected, reusable: retainedReusable };
}

function topologyAggregates(prior, current, dependencyPartitions) {
  const output = [];
  for (const partition of dependencyPartitions.filter((candidate) => candidate.topology_recompute)) {
    const priorFacts = prior.facts.partitionById.get(partition.partition_id);
    const currentFacts = current.facts.partitionById.get(partition.partition_id);
    const priorRecordKeys = [];
    const currentRecordKeys = [];
    for (const analyzer of prior.analyzers) {
      for (const record of analyzer.records) {
        if (record.scope === "partition" && record.partition_id === partition.partition_id) priorRecordKeys.push(record.cache_key);
      }
    }
    for (const analyzer of current.analyzers) {
      for (const record of analyzer.records) {
        if (record.scope === "partition" && record.partition_id === partition.partition_id) currentRecordKeys.push(record.cache_key);
      }
    }
    output.push({
      aggregate_id: `topology:${partition.partition_id}`,
      partition_id: partition.partition_id,
      prior_cache_keys: sortedUnique([...(priorFacts?.aggregate_cache_keys ?? []), ...priorRecordKeys]),
      current_cache_keys: sortedUnique([...(currentFacts?.aggregate_cache_keys ?? []), ...currentRecordKeys]),
      reasons: partition.reasons.length > 0 ? partition.reasons : ["dependency-facts-or-nodes-changed"],
    });
  }
  return output;
}

function globalAggregates(recordResult) {
  const grouped = new Map();
  for (const record of [...recordResult.direct, ...recordResult.affected].filter((candidate) => candidate.scope === "global")) {
    if (!grouped.has(record.analyzer_id)) grouped.set(record.analyzer_id, {
      prior_cache_keys: [],
      current_cache_keys: [],
      reasons: [],
    });
    const group = grouped.get(record.analyzer_id);
    if (record.prior_cache_key !== null) group.prior_cache_keys.push(record.prior_cache_key);
    if (record.current_cache_key !== null) group.current_cache_keys.push(record.current_cache_key);
    group.reasons.push(...record.reasons);
  }
  return [...grouped.entries()].sort(([left], [right]) => stableCompare(left, right)).map(([analyzerId, group]) => ({
    aggregate_id: `global:${analyzerId}`,
    analyzer_id: analyzerId,
    prior_cache_keys: sortedUnique(group.prior_cache_keys),
    current_cache_keys: sortedUnique(group.current_cache_keys),
    reasons: sortedUnique(group.reasons),
  }));
}

function bindingSummary(snapshot, status = "valid") {
  if (!snapshot) {
    return {
      status,
      repository_revision: null,
      index_digest: null,
      dependency_facts_digest: null,
      analyzers: [],
      record_count: 0,
    };
  }
  return {
    status,
    repository_revision: snapshot.index.binding.repository_revision,
    index_digest: snapshot.index.binding.index_digest,
    dependency_facts_digest: snapshot.facts.digest,
    analyzers: snapshot.analyzers.map((analyzer) => ({
      analyzer_id: analyzer.analyzer_id,
      analyzer_identity: analyzer.analyzer_identity,
      analyzer_version: analyzer.analyzer_version,
      configuration_hash: analyzer.configuration_hash,
      binding_key: analyzer.binding_key,
      record_count: analyzer.records.length,
    })),
    record_count: snapshot.record_count,
  };
}

function finalizePlan(body) {
  const planDigest = sha256(canonicalJson(body));
  return deepFreeze({ ...body, plan_digest: planDigest });
}

function conservativePriorFallback(current, reason, ancestry) {
  const dependencyPartitions = current.facts.partitions.map((partition) => ({
    partition_id: partition.partition_id,
    mode: "full-recompute",
    reasons: [reason],
    prior_facts_digest: null,
    current_facts_digest: partition.digest,
    affected_node_count: partition.nodes.length,
    topology_recompute: true,
  }));
  const affectedNodes = current.facts.partitions.flatMap((partition) => fallbackAffectedNodes(
    partition.partition_id, null, partition, reason,
  ));
  const direct = current.analyzers.flatMap((analyzer) => analyzer.records.map((record) => recordPairOutput(
    analyzer.analyzer_id, null, record, [reason],
  ))).sort((left, right) => stableCompare(left.analyzer_id, right.analyzer_id) || stableCompare(left.record_id, right.record_id));
  const emptyPrior = {
    facts: { partitionById: new Map() },
    analyzers: [],
    analyzerById: new Map(),
  };
  const body = {
    schema_version: DEPENDENCY_INVALIDATION_VERSION,
    status: "full-recompute",
    limits: { ...HARD_LIMITS },
    ancestry: {
      status: ancestry.status,
      relationship: ancestry.relationship,
      evidence_digest: ancestry.evidence_digest,
      binding_digest: ancestry.binding_digest,
    },
    bindings: {
      prior: bindingSummary(null, "invalid"),
      current: bindingSummary(current),
    },
    path_changes: {
      status: "unverifiable",
      added: [],
      changed: [],
      deleted: [],
      renamed: [],
      uncertain_renames: [],
    },
    fallback_reasons: sortedUnique([reason, ancestry.fallback_reason].filter(Boolean)),
    dependency_partitions: dependencyPartitions,
    affected_dependency_nodes: affectedNodes,
    directly_invalidated_analyzer_records: direct,
    affected_dependency_analyzer_records: [],
    unaffected_reusable_analyzer_records: [],
    topology_aggregates_requiring_recompute: topologyAggregates(emptyPrior, current, dependencyPartitions),
    global_aggregates_requiring_recompute: globalAggregates({ direct, affected: [] }),
  };
  return finalizePlan(body);
}

function planDependencyInvalidation(input) {
  assertExactKeys(input, ["ancestryBinding", "current", "prior"], "input");
  const current = normalizeSnapshot(input.current, "current");
  let prior;
  try {
    prior = normalizeSnapshot(input.prior, "prior");
  } catch (error) {
    if (error?.code !== "FAIL-DEPENDENCY-INVALIDATION") throw error;
    return conservativePriorFallback(current, "prior-state-invalid", unavailableAncestry("ancestry-binding-untrusted"));
  }
  const ancestry = evaluateAncestry(input.ancestryBinding, prior, current);
  const pathChanges = diffPaths(prior.index, current.index);
  const globalReasons = [];
  if (ancestry.fallback_reason) globalReasons.push(ancestry.fallback_reason);
  if (pathChanges.status === "unverifiable") globalReasons.push("content-oid-comparability-unavailable");
  if (pathChanges.uncertain_renames.length > 0) globalReasons.push("path-identity-uncertain");
  const dependencyResult = buildDependencyPartitions(prior, current, pathChanges, globalReasons);
  const recordResult = classifyAnalyzerRecords(prior, current, dependencyResult.pathReasonMaps, dependencyResult);
  const fullCount = dependencyResult.partitions.filter((partition) => partition.mode === "full-recompute").length;
  const status = dependencyResult.partitions.length === 0 && dependencyResult.globalReasons.length > 0
    ? "full-recompute"
    : fullCount === 0 ? "incremental"
    : fullCount === dependencyResult.partitions.length ? "full-recompute" : "mixed";
  const fallbackReasons = sortedUnique([
    ...dependencyResult.globalReasons,
    ...dependencyResult.partitions.flatMap((partition) => partition.reasons),
  ]);
  const body = {
    schema_version: DEPENDENCY_INVALIDATION_VERSION,
    status,
    limits: { ...HARD_LIMITS },
    ancestry: {
      status: ancestry.status,
      relationship: ancestry.relationship,
      evidence_digest: ancestry.evidence_digest,
      binding_digest: ancestry.binding_digest,
    },
    bindings: {
      prior: bindingSummary(prior),
      current: bindingSummary(current),
    },
    path_changes: pathChanges,
    fallback_reasons: fallbackReasons,
    dependency_partitions: dependencyResult.partitions,
    affected_dependency_nodes: dependencyResult.affectedNodes,
    directly_invalidated_analyzer_records: recordResult.direct,
    affected_dependency_analyzer_records: recordResult.affected,
    unaffected_reusable_analyzer_records: recordResult.reusable,
    topology_aggregates_requiring_recompute: topologyAggregates(prior, current, dependencyResult.partitions),
    global_aggregates_requiring_recompute: globalAggregates(recordResult),
  };
  return finalizePlan(body);
}

const api = {
  DEPENDENCY_INVALIDATION_VERSION,
  planDependencyInvalidation,
};
Object.defineProperty(api, PRIVATE, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({ createTrustedAncestryBinding, portableSnapshot, rehydratePortableSnapshot }),
});

module.exports = Object.freeze(api);
