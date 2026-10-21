"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const FACTS_VERSION = "sei.normalized-dependency-facts@1";
const PARTITION_ID = "repository:production";
const ANALYZER_ID = "cross-language-static";
const POLICY_VERSION = "sei.repository-classification@2";
const INDEX_VERSION = "sei.repository-index@1";

function canonicalJson(value) {
  return JSON.stringify(value);
}

function hash(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest("hex");
}

function sha256(value) {
  return `sha256:${hash("sha256", value)}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function languageFor(filePath) {
  const extension = path.posix.extname(filePath);
  if (extension === ".py") return "python";
  if ([".ts", ".tsx"].includes(extension)) return "typescript";
  return "javascript";
}

function moduleId(filePath) {
  return filePath.replace(/^src\//, "").replace(/\.[^.]+$/, "").replaceAll("/", ".");
}

function blobOid(content) {
  const bytes = Buffer.from(content, "utf8");
  return hash("sha1", Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes]));
}

function revision(seed) {
  return hash("sha1", `commit:${seed}`);
}

function repositoryIndex(seed, files) {
  const classificationPolicyHash = sha256(canonicalJson({ fixture: "dependency-invalidation@1" }));
  const entries = Object.entries(files).map(([filePath, content]) => {
    const bytes = Buffer.from(content, "utf8");
    const oid = blobOid(content);
    const identity = {
      path: filePath,
      mode: "100644",
      blob_oid: oid,
      byte_size: bytes.length,
      content_key: `git-blob:sha1:${oid}`,
      language: languageFor(filePath),
      classifications: {
        source: true,
        test_source: false,
        generated: "human",
        vendor: "not-vendor",
        manifest_kinds: [],
        artifact_candidate_kinds: [],
      },
    };
    return {
      ...identity,
      entry_key: sha256(canonicalJson({ classification_policy_hash: classificationPolicyHash, ...identity })),
    };
  }).sort((left, right) => left.path.localeCompare(right.path) || left.blob_oid.localeCompare(right.blob_oid));
  const exclusions = [];
  const repositoryRevision = revision(seed);
  const rootTreeOid = hash("sha1", canonicalJson(entries.map(({ path: filePath, blob_oid }) => [filePath, blob_oid])));
  const indexKey = sha256(canonicalJson({
    index_version: INDEX_VERSION,
    object_format: "sha1",
    repository_revision: repositoryRevision,
    root_tree_oid: rootTreeOid,
    classification_policy_hash: classificationPolicyHash,
  }));
  const digestBinding = {
    index_version: INDEX_VERSION,
    classification_policy_version: POLICY_VERSION,
    repository_revision: repositoryRevision,
    root_tree_oid: rootTreeOid,
    object_format: "sha1",
    classification_policy_hash: classificationPolicyHash,
    index_key: indexKey,
    entry_count: entries.length,
    total_blob_bytes: entries.reduce((sum, entry) => sum + entry.byte_size, 0),
    exclusion_count: 0,
  };
  const binding = {
    ...digestBinding,
    index_digest: sha256(canonicalJson({ binding: digestBinding, entries, exclusions })),
    cache: "disabled",
  };
  return deepFreeze({
    binding,
    entries,
    exclusions,
    async readBlobs() {
      throw new Error("fixture RepositoryIndex does not expose source bytes");
    },
  });
}

function normalizedFacts(index, edges, options = {}) {
  const entryByPath = new Map(index.entries.map((entry) => [entry.path, entry]));
  const paths = options.paths ?? index.entries.map((entry) => entry.path);
  const nodes = paths.map((filePath) => {
    const entry = entryByPath.get(filePath);
    if (!entry) throw new Error(`fixture path ${filePath} is not indexed`);
    return {
      node_id: moduleId(filePath),
      path: filePath,
      content_key: entry.content_key,
      language: entry.language,
    };
  });
  const nodeByPath = new Map(nodes.map((node) => [node.path, node]));
  const normalizedEdges = edges.map((edge) => {
    if (edge.certainty !== undefined && edge.certainty !== "exact") {
      return {
        source_node_id: nodeByPath.get(edge.source)?.node_id ?? moduleId(edge.source),
        target_node_id: null,
        kind: edge.kind ?? "dynamic-import",
        certainty: edge.certainty,
      };
    }
    return {
      source_node_id: nodeByPath.get(edge.source)?.node_id ?? moduleId(edge.source),
      target_node_id: nodeByPath.get(edge.target)?.node_id ?? moduleId(edge.target),
      kind: edge.kind ?? "static-import",
      certainty: "exact",
    };
  });
  const partition = {
    partition_id: PARTITION_ID,
    producer_analyzer_ids: options.producerAnalyzerIds ?? [ANALYZER_ID],
    status: options.status ?? "available",
    nodes: options.reverse ? [...nodes].reverse() : nodes,
    edges: options.reverse ? [...normalizedEdges].reverse() : normalizedEdges,
    aggregate_cache_keys: [sha256(canonicalJson({
      analyzer_id: ANALYZER_ID,
      index_digest: index.binding.index_digest,
      partition_id: PARTITION_ID,
      product: "topology",
    }))],
  };
  const partitions = options.partitions ?? [partition];
  return deepFreeze({
    schema_version: FACTS_VERSION,
    repository_revision: index.binding.repository_revision,
    index_digest: index.binding.index_digest,
    partitions: options.reverse ? [...partitions].reverse() : partitions,
  });
}

function analyzerBindings(index, options = {}) {
  const configurationHash = options.configurationHash ?? sha256("configuration:v1");
  const identity = options.identity ?? "sei.cross-language-static@1";
  const version = options.version ?? "1.0.0";
  const facts = options.facts;
  const partition = facts.partitions[0];
  const nodeByPath = new Map(partition.nodes.map((node) => [node.path, node]));
  const records = [];
  for (const entry of index.entries) {
    const common = {
      analyzer_id: ANALYZER_ID,
      analyzer_identity: identity,
      analyzer_version: version,
      configuration_hash: configurationHash,
      content_key: entry.content_key,
      partition_id: PARTITION_ID,
      path: entry.path,
    };
    records.push({
      record_id: `file:${entry.path}`,
      cache_key: sha256(canonicalJson({ ...common, scope: "path" })),
      scope: "path",
      partition_id: PARTITION_ID,
      path: entry.path,
      node_id: null,
      content_key: entry.content_key,
    });
    const node = nodeByPath.get(entry.path);
    if (node) records.push({
      record_id: `node:${node.node_id}`,
      cache_key: sha256(canonicalJson({ ...common, node_id: node.node_id, scope: "node" })),
      scope: "node",
      partition_id: PARTITION_ID,
      path: entry.path,
      node_id: node.node_id,
      content_key: entry.content_key,
    });
  }
  records.push({
    record_id: `partition:${PARTITION_ID}`,
    cache_key: sha256(canonicalJson({ configurationHash, identity, partition: PARTITION_ID, scope: "partition" })),
    scope: "partition",
    partition_id: PARTITION_ID,
    path: null,
    node_id: null,
    content_key: null,
  });
  records.push({
    record_id: "global:repository",
    cache_key: sha256(canonicalJson({ configurationHash, identity, scope: "global" })),
    scope: "global",
    partition_id: "*",
    path: null,
    node_id: null,
    content_key: null,
  });
  const analyzer = {
    analyzer_id: ANALYZER_ID,
    analyzer_identity: identity,
    analyzer_version: version,
    configuration_hash: configurationHash,
    records: options.reverse ? [...records].reverse() : records,
  };
  return deepFreeze(options.reverse ? [analyzer].reverse() : [analyzer]);
}

const BASE_FILES = Object.freeze({
  "src/api.ts": "export const api = () => shared();\n",
  "src/app.ts": "export const app = () => api();\n",
  "src/cycle-a.ts": "export const a = () => b();\n",
  "src/cycle-b.ts": "export const b = () => a();\n",
  "src/isolated.js": "export const isolated = 1;\n",
  "src/leaf.py": "def leaf():\n    return 1\n",
  "src/shared.py": "from .leaf import leaf\n",
});

const BASE_EDGES = Object.freeze([
  { source: "src/app.ts", target: "src/api.ts" },
  { source: "src/api.ts", target: "src/shared.py" },
  { source: "src/shared.py", target: "src/leaf.py" },
  { source: "src/cycle-a.ts", target: "src/cycle-b.ts" },
  { source: "src/cycle-b.ts", target: "src/cycle-a.ts" },
]);

function snapshot(seed, files, edges, options = {}) {
  const repositoryIndexValue = repositoryIndex(seed, files);
  const dependencyFacts = normalizedFacts(repositoryIndexValue, edges, options.facts);
  const analyzers = analyzerBindings(repositoryIndexValue, { ...options.analyzer, facts: dependencyFacts });
  return deepFreeze({ repositoryIndex: repositoryIndexValue, dependencyFacts, analyzers });
}

function pair(kind, options = {}) {
  const priorFiles = { ...BASE_FILES };
  const currentFiles = { ...BASE_FILES };
  let priorEdges = BASE_EDGES.map((edge) => ({ ...edge }));
  let currentEdges = BASE_EDGES.map((edge) => ({ ...edge }));
  if (kind === "isolated") currentFiles["src/isolated.js"] = "export const isolated = 2;\n";
  if (kind === "shared") currentFiles["src/shared.py"] = "from .leaf import leaf\nVALUE = 2\n";
  if (kind === "leaf") currentFiles["src/leaf.py"] = "def leaf():\n    return 2\n";
  if (kind === "rename") {
    currentFiles["src/common.py"] = currentFiles["src/shared.py"];
    delete currentFiles["src/shared.py"];
    currentEdges = currentEdges.map((edge) => ({
      ...edge,
      source: edge.source === "src/shared.py" ? "src/common.py" : edge.source,
      target: edge.target === "src/shared.py" ? "src/common.py" : edge.target,
    }));
  }
  if (kind === "delete") {
    delete currentFiles["src/leaf.py"];
    currentEdges = currentEdges.filter((edge) => edge.target !== "src/leaf.py" && edge.source !== "src/leaf.py");
  }
  if (kind === "dynamic") {
    currentEdges.push({ source: "src/app.ts", target: null, certainty: "dynamic", kind: "dynamic-import" });
  }
  if (kind === "ambiguous-rename") {
    const duplicate = "export const duplicate = true;\n";
    priorFiles["src/duplicate-a.ts"] = duplicate;
    priorFiles["src/duplicate-b.ts"] = duplicate;
    currentFiles["src/duplicate-b.ts"] = duplicate;
    currentFiles["src/duplicate-c.ts"] = duplicate;
  }
  const prior = snapshot(`${kind}:prior`, priorFiles, priorEdges, options.prior);
  const currentOptions = { ...(options.current ?? {}) };
  if (kind === "config-drift") {
    currentOptions.analyzer = {
      ...(currentOptions.analyzer ?? {}),
      configurationHash: sha256("configuration:v2"),
    };
  }
  const current = snapshot(`${kind}:current`, currentFiles, currentEdges, currentOptions);
  return { prior, current };
}

function reordered(snapshotValue) {
  const dependencyFacts = deepFreeze({
    ...snapshotValue.dependencyFacts,
    partitions: [...snapshotValue.dependencyFacts.partitions].reverse().map((partition) => deepFreeze({
      ...partition,
      nodes: [...partition.nodes].reverse(),
      edges: [...partition.edges].reverse(),
      aggregate_cache_keys: [...partition.aggregate_cache_keys].reverse(),
    })),
  });
  const analyzers = deepFreeze([...snapshotValue.analyzers].reverse().map((analyzer) => deepFreeze({
    ...analyzer,
    records: [...analyzer.records].reverse(),
  })));
  return deepFreeze({ repositoryIndex: snapshotValue.repositoryIndex, dependencyFacts, analyzers });
}

module.exports = {
  ANALYZER_ID,
  BASE_EDGES,
  BASE_FILES,
  FACTS_VERSION,
  PARTITION_ID,
  deepFreeze,
  normalizedFacts,
  pair,
  reordered,
  repositoryIndex,
  sha256,
  snapshot,
};
