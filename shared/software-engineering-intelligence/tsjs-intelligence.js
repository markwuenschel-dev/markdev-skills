"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const {
  TSJS_AST_ANALYZER_VERSION,
  TSJS_AST_PROTOCOL_VERSION,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  analyzeTsjsAstBatch,
} = require("./analyzers/tsjs-ast-protocol");

const TSJS_INTELLIGENCE_VERSION = "sei.tsjs-static-intelligence@1";
const COLLECTOR_VERSION = "1.0.0";
const MAX_QUEUED_SOURCE_BYTES_DEFAULT = 16 * 1024 * 1024;
const MAX_QUEUED_SOURCE_BYTES_HARD = 64 * 1024 * 1024;
const MAX_TOTAL_PROTOCOL_FACTS = 1_000_000;
const INPUT_KEYS = Object.freeze(["configuration", "repositoryIndex", "signal", "taskExecutor"]);
const CONFIGURATION_KEYS = Object.freeze(["limits", "maxQueuedSourceBytes", "nodeExecutable", "typescriptPath"]);
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
const SOURCE_MODES = new Set(["100644", "100755"]);
const SYNTAX_BY_EXTENSION = new Map([
  [".js", "javascript"],
  [".jsx", "jsx"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
]);
const STATIC_DEPENDENCY_KINDS = new Set([
  "import", "import-equals-require", "export-from", "export-all-from",
  "dynamic-import-literal", "require-literal", "import-type",
]);
const DYNAMIC_DEPENDENCY_KINDS = new Set(["dynamic-import-dynamic", "require-dynamic", "import-type-dynamic"]);

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function assertClosedRecord(value, keys, label, code = "FAIL-TSJS-INTELLIGENCE-CONFIG", exact = false) {
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

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
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
  if (signal?.aborted) fail("FAIL-TSJS-INTELLIGENCE-CANCELLED", "operation was cancelled");
}

function normalizeConfiguration(value) {
  assertClosedRecord(value, CONFIGURATION_KEYS, "configuration", "FAIL-TSJS-INTELLIGENCE-CONFIG");
  if (typeof value.nodeExecutable !== "string" || !path.isAbsolute(value.nodeExecutable) || value.nodeExecutable.includes("\0")) {
    fail("FAIL-TSJS-INTELLIGENCE-CONFIG", "nodeExecutable must be an explicit absolute NUL-free path");
  }
  if (value.typescriptPath !== null && value.typescriptPath !== undefined
      && (typeof value.typescriptPath !== "string" || !path.isAbsolute(value.typescriptPath) || value.typescriptPath.includes("\0"))) {
    fail("FAIL-TSJS-INTELLIGENCE-CONFIG", "typescriptPath must be an absolute NUL-free path or null");
  }
  const limitsInput = value.limits ?? {};
  assertClosedRecord(limitsInput, LIMIT_KEYS, "configuration.limits", "FAIL-TSJS-INTELLIGENCE-CONFIG");
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const limit = limitsInput[key] ?? DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > HARD_LIMITS[key]) {
      fail("FAIL-TSJS-INTELLIGENCE-CONFIG", `${key} must be a positive safe integer no greater than ${HARD_LIMITS[key]}`);
    }
    limits[key] = limit;
  }
  if (limits.maxFileBytes > limits.maxBatchBytes) fail("FAIL-TSJS-INTELLIGENCE-CONFIG", "maxFileBytes cannot exceed maxBatchBytes");
  const maxQueuedSourceBytes = value.maxQueuedSourceBytes ?? MAX_QUEUED_SOURCE_BYTES_DEFAULT;
  if (!Number.isSafeInteger(maxQueuedSourceBytes) || maxQueuedSourceBytes <= 0 || maxQueuedSourceBytes > MAX_QUEUED_SOURCE_BYTES_HARD) {
    fail("FAIL-TSJS-INTELLIGENCE-CONFIG", `maxQueuedSourceBytes must be 1..${MAX_QUEUED_SOURCE_BYTES_HARD}`);
  }
  if (limits.maxBatchBytes > maxQueuedSourceBytes) fail("FAIL-TSJS-INTELLIGENCE-CONFIG", "maxBatchBytes cannot exceed maxQueuedSourceBytes");
  return deepFreeze({
    limits,
    maxQueuedSourceBytes,
    nodeExecutable: value.nodeExecutable,
    typescriptPath: value.typescriptPath ?? null,
  });
}

function validateRepositoryIndex(index) {
  if (!index || typeof index !== "object" || !index.binding || !Array.isArray(index.entries) || typeof index.readBlobs !== "function") {
    fail("FAIL-TSJS-INTELLIGENCE-CONFIG", "repositoryIndex must be a materialized RepositoryIndex");
  }
  const binding = index.binding;
  if (!/^sha256:[0-9a-f]{64}$/.test(binding.index_digest ?? "")
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(binding.repository_revision ?? "")
      || typeof binding.classification_policy_version !== "string") {
    fail("FAIL-TSJS-INTELLIGENCE-CONFIG", "repositoryIndex binding is invalid");
  }
}

function validateTaskExecutor(executor) {
  if (!executor || typeof executor !== "object" || typeof executor.run !== "function") {
    fail("FAIL-TSJS-INTELLIGENCE-CONFIG", "taskExecutor must expose run(tasks, options)");
  }
}

function bindingToken(index) {
  return canonicalJson({
    classification_policy_version: index.binding.classification_policy_version,
    index_digest: index.binding.index_digest,
    repository_revision: index.binding.repository_revision,
    root_tree_oid: index.binding.root_tree_oid,
  });
}

function assertLive(index, token, signal) {
  checkCancelled(signal);
  if (bindingToken(index) !== token) fail("FAIL-TSJS-INTELLIGENCE-BINDING", "repository index identity changed during analysis");
}

function syntaxForEntry(entry) {
  return SYNTAX_BY_EXTENSION.get(path.posix.extname(entry.path).toLowerCase()) ?? null;
}

function selectEntries(index) {
  const counters = {
    excluded_generated: 0,
    excluded_unknown_generated: 0,
    excluded_vendor: 0,
    indexed_supported_source: 0,
    parsed_files: 0,
    selected_human_nonvendor: 0,
    unavailable_files: 0,
  };
  const selected = [];
  for (const entry of index.entries) {
    const syntax = syntaxForEntry(entry);
    if (!syntax || !SOURCE_MODES.has(entry.mode) || entry.classifications?.source !== true
        || !["javascript", "typescript"].includes(entry.language)) continue;
    counters.indexed_supported_source += 1;
    if (entry.classifications.vendor === "vendor") {
      counters.excluded_vendor += 1;
      continue;
    }
    if (entry.classifications.generated === "generated") {
      counters.excluded_generated += 1;
      continue;
    }
    if (entry.classifications.generated !== "human") {
      counters.excluded_unknown_generated += 1;
      continue;
    }
    counters.selected_human_nonvendor += 1;
    selected.push({ entry, syntax });
  }
  selected.sort((left, right) => stableCompare(left.entry.path, right.entry.path));
  return { selected, counters };
}

function partitionBatches(items, limits) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const item of items) {
    if (current.length > 0 && (current.length >= limits.maxBatchFiles || bytes + item.entry.byte_size > limits.maxBatchBytes)) {
      batches.push({ bytes, items: current });
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.entry.byte_size;
  }
  if (current.length > 0) batches.push({ bytes, items: current });
  return batches;
}

function partitionWaves(batches, maximum) {
  const waves = [];
  let current = [];
  let bytes = 0;
  for (const batch of batches) {
    if (current.length > 0 && bytes + batch.bytes > maximum) {
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

function unavailableFact(item, code, message) {
  return deepFreeze({
    content_key: item.entry.content_key,
    error: {
      code,
      col_offset: null,
      end_col_offset: null,
      end_lineno: null,
      lineno: null,
      message: String(message).replace(/[\r\n]+/g, " ").slice(0, 240),
    },
    status: "unavailable",
    syntax: item.syntax,
  });
}

function taskForBatch(batch, batchIndex, index, configuration) {
  return {
    id: `tsjs-ast-${batchIndex.toString().padStart(6, "0")}`,
    resourceClass: "external_process",
    deterministicOrderKey: `30:tsjs:${batch.items[0].entry.path}`,
    dependencies: [],
    timeoutMs: configuration.limits.batchTimeoutMs + 2_000,
    memoryWeight: Math.max(1, Math.ceil((batch.bytes + configuration.limits.maxStdoutBytes) / (32 * 1024 * 1024))),
    concurrencyGroup: "tsjs-ast",
    run: async ({ signal }) => {
      const entries = batch.items.map((item) => item.entry);
      const blobs = await index.readBlobs(entries, {
        max_blob_bytes: configuration.limits.maxFileBytes,
        max_total_bytes: configuration.limits.maxBatchBytes,
        signal,
      });
      const files = batch.items.map((item, ordinal) => ({
        blobOid: item.entry.blob_oid,
        bytes: blobs.get(item.entry.path),
        contentKey: item.entry.content_key,
        ordinal,
        syntax: item.syntax,
      }));
      return analyzeTsjsAstBatch({
        files,
        indexDigest: index.binding.index_digest,
        limits: configuration.limits,
        nodeExecutable: configuration.nodeExecutable,
        requestId: `tsjs-${index.binding.index_digest.slice(7, 23)}-${batchIndex}`,
        signal,
        typescriptPath: configuration.typescriptPath,
      });
    },
  };
}

function errorCode(error) {
  const message = String(error?.message ?? error);
  return /^([A-Z0-9-]+):/.exec(message)?.[1] ?? error?.code ?? "FAIL-TSJS-INTELLIGENCE-ANALYZER";
}

function errorMessage(error) {
  return String(error?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 240);
}

async function analyzeEntries(items, context) {
  const { index, taskExecutor, configuration, signal, token, telemetry } = context;
  const facts = new Map();
  const oversized = items.filter((item) => item.entry.byte_size > configuration.limits.maxFileBytes);
  for (const item of oversized) facts.set(item.entry.path, unavailableFact(item, "FAIL-TSJS-AST-FILE-LIMIT", `${item.entry.path} exceeds maxFileBytes`));
  const admitted = items.filter((item) => item.entry.byte_size <= configuration.limits.maxFileBytes);
  const waves = partitionWaves(partitionBatches(admitted, configuration.limits), configuration.maxQueuedSourceBytes);
  let batchOffset = 0;
  let runtime = null;
  for (const wave of waves) {
    assertLive(index, token, signal);
    const tasks = wave.map((batch, offset) => taskForBatch(batch, batchOffset + offset, index, configuration));
    const execution = await taskExecutor.run(tasks, { signal });
    telemetry.executor_runs += 1;
    telemetry.tasks_submitted += execution.telemetry?.tasks_submitted ?? tasks.length;
    telemetry.max_in_flight = Math.max(telemetry.max_in_flight, execution.telemetry?.max_in_flight ?? 0);
    telemetry.timeouts += execution.telemetry?.timeouts ?? 0;
    telemetry.cancelled += execution.telemetry?.cancelled ?? 0;
    if (signal?.aborted || execution.status === "cancelled") checkCancelled(signal ?? { aborted: true });
    const outcomes = new Map(execution.results.map((outcome) => [outcome.id, outcome]));
    for (let indexInWave = 0; indexInWave < wave.length; indexInWave += 1) {
      const batch = wave[indexInWave];
      const task = tasks[indexInWave];
      const outcome = outcomes.get(task.id);
      if (outcome?.state === "succeeded") {
        const response = outcome.value;
        if (runtime === null) runtime = response.runtime;
        else if (canonicalJson(runtime) !== canonicalJson(response.runtime)) fail("FAIL-TSJS-INTELLIGENCE-BINDING", "parser/runtime identity changed between batches");
        for (let ordinal = 0; ordinal < batch.items.length; ordinal += 1) {
          const item = batch.items[ordinal];
          const result = response.results[ordinal];
          if (!result || result.content_key !== item.entry.content_key || result.syntax !== item.syntax) {
            fail("FAIL-TSJS-INTELLIGENCE-BINDING", "analyzer result no longer binds admitted content");
          }
          facts.set(item.entry.path, deepFreeze(result.status === "ok" ? {
            callables: result.callables,
            content_key: result.content_key,
            dependencies: result.dependencies,
            exports: result.exports,
            status: "ok",
            syntax: result.syntax,
          } : {
            content_key: result.content_key,
            error: result.error,
            status: "unavailable",
            syntax: result.syntax,
          }));
        }
      } else {
        const code = errorCode(outcome?.error);
        const message = errorMessage(outcome?.error ?? "analyzer task failed");
        if (code === "FAIL-TSJS-AST-PROTOCOL") fail("FAIL-TSJS-INTELLIGENCE-BINDING", message);
        for (const item of batch.items) facts.set(item.entry.path, unavailableFact(item, code, message));
      }
    }
    batchOffset += wave.length;
  }
  assertLive(index, token, signal);
  return { facts, runtime };
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function seriesAggregate(values) {
  let maximum = null;
  let sum = 0;
  for (const value of values) {
    maximum = maximum === null ? value : Math.max(maximum, value);
    sum += value;
  }
  return {
    max: maximum,
    p50: nearestRank(values, 0.5),
    p90: nearestRank(values, 0.9),
    sum,
  };
}

function complexityPartition(files, name) {
  const parsed = files.filter((file) => file.parse_status === "ok");
  const callables = parsed.flatMap((file) => file.callables);
  const cyclomatic = callables.map((fact) => fact.cyclomatic_complexity);
  const cognitive = callables.map((fact) => fact.cognitive_complexity);
  const completeness = files.length === 0 ? 0 : Number((parsed.length / files.length).toFixed(8));
  const status = parsed.length > 0 && callables.length > 0 ? "measured" : "unavailable";
  const reason = parsed.length === 0
    ? `FAIL-TSJS-INTELLIGENCE-PARSE: no ${name} file parsed successfully`
    : callables.length === 0
      ? `FAIL-TSJS-INTELLIGENCE-NO-CALLABLES: no executable callable was present in parsed ${name} files`
      : completeness < 1
        ? `FAIL-TSJS-INTELLIGENCE-PARTIAL: parsed ${parsed.length} of ${files.length} ${name} files`
        : null;
  return {
    aggregate: {
      callable_count: callables.length,
      cognitive: seriesAggregate(cognitive),
      cyclomatic: seriesAggregate(cyclomatic),
      parsed_file_count: parsed.length,
      supported_file_count: files.length,
    },
    completeness,
    reason,
    status,
  };
}

function materializeComplexity(items, facts, counters) {
  let totalCallables = 0;
  const files = items.map((item) => {
    const fact = facts.get(item.entry.path);
    if (fact?.status !== "ok") return {
      callables: [],
      cognitive_max: null,
      cognitive_sum: null,
      content_key: item.entry.content_key,
      cyclomatic_max: null,
      cyclomatic_sum: null,
      error: fact?.error ?? { code: "FAIL-TSJS-INTELLIGENCE-PARSE", message: "parse fact missing" },
      language: item.entry.language,
      parse_status: "unavailable",
      path: item.entry.path,
      syntax: item.syntax,
      test_source: item.entry.classifications.test_source,
    };
    const cyclomatic = fact.callables.map((callable) => callable.cyclomatic_complexity);
    const cognitive = fact.callables.map((callable) => callable.cognitive_complexity);
    const cyclomaticAggregate = seriesAggregate(cyclomatic);
    const cognitiveAggregate = seriesAggregate(cognitive);
    totalCallables += fact.callables.length;
    if (totalCallables > MAX_TOTAL_PROTOCOL_FACTS) fail("FAIL-TSJS-INTELLIGENCE-FACT-LIMIT", `callable facts exceed ${MAX_TOTAL_PROTOCOL_FACTS}`);
    return {
      callables: fact.callables,
      cognitive_max: cognitiveAggregate.max ?? 0,
      cognitive_sum: cognitiveAggregate.sum,
      content_key: item.entry.content_key,
      cyclomatic_max: cyclomaticAggregate.max ?? 0,
      cyclomatic_sum: cyclomaticAggregate.sum,
      error: null,
      language: item.entry.language,
      parse_status: "ok",
      path: item.entry.path,
      syntax: item.syntax,
      test_source: item.entry.classifications.test_source,
    };
  });
  const parsed = files.filter((file) => file.parse_status === "ok").length;
  counters.parsed_files = parsed;
  counters.unavailable_files = files.length - parsed;
  return {
    completeness: files.length === 0 ? 0 : Number((parsed / files.length).toFixed(8)),
    files,
    partitions: {
      all_tsjs: complexityPartition(files, "all TS/JS/TSX"),
      production: complexityPartition(files.filter((file) => !file.test_source), "production TS/JS/TSX"),
    },
    reason: parsed === files.length && files.length > 0 ? null
      : parsed === 0 ? "FAIL-TSJS-INTELLIGENCE-PARSE: no selected file parsed successfully"
        : `FAIL-TSJS-INTELLIGENCE-PARTIAL: parsed ${parsed} of ${files.length} selected files`,
    status: parsed === 0 ? "unavailable" : "measured",
  };
}

function moduleCandidates(sourcePath, moduleName, knownPaths) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), moduleName));
  if (base === ".." || base.startsWith("../") || base.startsWith("/") || /^[A-Za-z]:/.test(base)) return [];
  if (knownPaths.has(base)) return [base];
  if (path.posix.extname(base) === "") {
    for (const extension of [".ts", ".tsx", ".js", ".jsx"]) {
      if (knownPaths.has(`${base}${extension}`)) return [`${base}${extension}`];
    }
    for (const extension of [".ts", ".tsx", ".js", ".jsx"]) {
      if (knownPaths.has(`${base}/index${extension}`)) return [`${base}/index${extension}`];
    }
  } else if (/\.js$/i.test(base)) {
    for (const extension of [".ts", ".tsx"]) {
      const substituted = base.slice(0, -3) + extension;
      if (knownPaths.has(substituted)) return [substituted];
    }
  }
  return [];
}

function classifyDependency(sourcePath, dependency, knownPaths) {
  if (DYNAMIC_DEPENDENCY_KINDS.has(dependency.kind) || dependency.module === null) {
    return { classification: "dynamic", reason: "dynamic-specifier-has-no-static-edge", target: null };
  }
  if (!STATIC_DEPENDENCY_KINDS.has(dependency.kind)) {
    return { classification: "unsupported", reason: "dependency-kind-is-not-admitted", target: null };
  }
  if (!dependency.module.startsWith(".")) return { classification: "external", reason: null, target: null };
  const candidates = moduleCandidates(sourcePath, dependency.module, knownPaths);
  if (candidates.length === 1) return { classification: "internal", reason: null, target: candidates[0] };
  if (candidates.length > 1) return { classification: "ambiguous-relative", reason: `multiple-static-candidates:${candidates.join(",")}`, target: null };
  return { classification: "unresolved-relative", reason: "no-exact-static-candidate", target: null };
}

function sccIdentity(members) {
  return sha256(Buffer.from(`sei.tsjs-scc@1\0${members.join("\0")}`, "utf8"));
}

function reduceTopology(nodeIds, edgePairs) {
  const orderedNodes = [...nodeIds].sort(stableCompare);
  const adjacency = new Map(orderedNodes.map((id) => [id, []]));
  const inbound = new Map(orderedNodes.map((id) => [id, new Set()]));
  const outbound = new Map(orderedNodes.map((id) => [id, new Set()]));
  const selfEdges = new Set();
  for (const edge of edgePairs) {
    adjacency.get(edge.source).push(edge.target);
    if (edge.source === edge.target) selfEdges.add(edge.source);
    else {
      outbound.get(edge.source).add(edge.target);
      inbound.get(edge.target).add(edge.source);
    }
  }
  for (const values of adjacency.values()) values.sort(stableCompare);
  let nextIndex = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  for (const root of orderedNodes) {
    if (indices.has(root)) continue;
    const traversal = [{ entered: false, nextTarget: 0, node: root, parent: null }];
    while (traversal.length > 0) {
      const frame = traversal[traversal.length - 1];
      if (!frame.entered) {
        frame.entered = true;
        indices.set(frame.node, nextIndex);
        lowlinks.set(frame.node, nextIndex);
        nextIndex += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
      }
      const targets = adjacency.get(frame.node);
      if (frame.nextTarget < targets.length) {
        const target = targets[frame.nextTarget];
        frame.nextTarget += 1;
        if (!indices.has(target)) traversal.push({ entered: false, nextTarget: 0, node: target, parent: frame.node });
        else if (onStack.has(target)) lowlinks.set(frame.node, Math.min(lowlinks.get(frame.node), indices.get(target)));
        continue;
      }
      traversal.pop();
      if (frame.parent !== null) lowlinks.set(frame.parent, Math.min(lowlinks.get(frame.parent), lowlinks.get(frame.node)));
      if (lowlinks.get(frame.node) !== indices.get(frame.node)) continue;
      const members = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        members.push(member);
      } while (member !== frame.node);
      members.sort(stableCompare);
      components.push({ cyclic: members.length > 1 || selfEdges.has(members[0]), members, scc_id: sccIdentity(members) });
    }
  }
  components.sort((left, right) => stableCompare(left.members.join("\0"), right.members.join("\0")));
  const nodes = orderedNodes.map((id) => {
    const fanIn = inbound.get(id).size;
    const fanOut = outbound.get(id).size;
    const denominator = fanIn + fanOut;
    return {
      fan_in: fanIn,
      fan_out: fanOut,
      id,
      instability: denominator === 0
        ? { reason: "no-non-self-dependency", status: "not-applicable", value: null }
        : { reason: null, status: "measured", value: Number((fanOut / denominator).toFixed(8)) },
    };
  });
  const cyclic = components.filter((component) => component.cyclic);
  const nonSelfEdges = edgePairs.filter((edge) => edge.source !== edge.target).length;
  const denominator = orderedNodes.length < 2 ? null : orderedNodes.length * (orderedNodes.length - 1);
  let maximumFanIn = 0;
  let maximumFanOut = 0;
  for (const node of nodes) {
    maximumFanIn = Math.max(maximumFanIn, node.fan_in);
    maximumFanOut = Math.max(maximumFanOut, node.fan_out);
  }
  return {
    aggregates: {
      cyclic_node_count: cyclic.reduce((sum, component) => sum + component.members.length, 0),
      cyclic_scc_count: cyclic.length,
      density: denominator === null ? null : Number((nonSelfEdges / denominator).toFixed(8)),
      edge_count: edgePairs.length,
      fan_in_max: maximumFanIn,
      fan_out_max: maximumFanOut,
      node_count: orderedNodes.length,
      scc_count: components.length,
    },
    nodes,
    strongly_connected_components: components,
  };
}

function topologyPartition(modules, edges) {
  const ids = new Set(modules.map((module) => module.id));
  const partitionEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return reduceTopology(ids, partitionEdges);
}

function materializeTopology(items, facts, complexity) {
  const knownPaths = new Set(items.map((item) => item.entry.path));
  const fileFacts = new Map(complexity.files.map((file) => [file.path, file]));
  const modules = items.map((item) => ({
    content_key: item.entry.content_key,
    id: item.entry.path,
    language: item.entry.language,
    parse_status: fileFacts.get(item.entry.path).parse_status,
    path: item.entry.path,
    syntax: item.syntax,
    test_source: item.entry.classifications.test_source,
  }));
  const references = [];
  const exports = [];
  let totalFacts = 0;
  for (const item of items) {
    const fact = facts.get(item.entry.path);
    if (fact?.status !== "ok") continue;
    for (const dependency of fact.dependencies) {
      totalFacts += 1;
      if (totalFacts > MAX_TOTAL_PROTOCOL_FACTS) fail("FAIL-TSJS-INTELLIGENCE-FACT-LIMIT", `dependency/export facts exceed ${MAX_TOTAL_PROTOCOL_FACTS}`);
      const resolution = classifyDependency(item.entry.path, dependency, knownPaths);
      references.push({
        classification: resolution.classification,
        col_offset: dependency.col_offset,
        end_col_offset: dependency.end_col_offset,
        end_lineno: dependency.end_lineno,
        kind: dependency.kind,
        lineno: dependency.lineno,
        module: dependency.module,
        names: dependency.names,
        path: item.entry.path,
        reason: resolution.reason,
        target: resolution.target,
        type_only: dependency.type_only,
      });
    }
    for (const exported of fact.exports) {
      totalFacts += 1;
      if (totalFacts > MAX_TOTAL_PROTOCOL_FACTS) fail("FAIL-TSJS-INTELLIGENCE-FACT-LIMIT", `dependency/export facts exceed ${MAX_TOTAL_PROTOCOL_FACTS}`);
      exports.push({ path: item.entry.path, ...exported });
    }
  }
  references.sort((left, right) => stableCompare(left.path, right.path) || left.lineno - right.lineno
    || left.col_offset - right.col_offset || stableCompare(left.kind, right.kind) || stableCompare(left.module ?? "", right.module ?? ""));
  exports.sort((left, right) => stableCompare(left.path, right.path) || left.lineno - right.lineno
    || left.col_offset - right.col_offset || stableCompare(left.kind, right.kind) || stableCompare(left.name ?? "", right.name ?? ""));
  const edgeSet = new Map();
  for (const reference of references.filter((fact) => fact.classification === "internal")) {
    const key = `${reference.path}\0${reference.target}`;
    if (!edgeSet.has(key)) edgeSet.set(key, { source: reference.path, target: reference.target });
  }
  const edges = [...edgeSet.values()].sort((left, right) => stableCompare(left.source, right.source) || stableCompare(left.target, right.target));
  const parsed = modules.filter((module) => module.parse_status === "ok").length;
  const counts = Object.fromEntries(["internal", "external", "unresolved-relative", "ambiguous-relative", "dynamic", "unsupported"]
    .map((classification) => [classification, references.filter((fact) => fact.classification === classification).length]));
  const status = parsed === 0 ? "unavailable" : "measured";
  return {
    completeness: modules.length === 0 ? 0 : Number((parsed / modules.length).toFixed(8)),
    edges,
    exports,
    import_counts: counts,
    modules,
    partitions: status === "unavailable" ? null : {
      all_tsjs: topologyPartition(modules, edges),
      production: topologyPartition(modules.filter((module) => !module.test_source), edges),
    },
    reason: parsed === modules.length && modules.length > 0 ? null
      : parsed === 0 ? "FAIL-TSJS-INTELLIGENCE-PARSE: no module parsed successfully"
        : `FAIL-TSJS-INTELLIGENCE-PARTIAL: parsed ${parsed} of ${modules.length} modules`,
    references,
    status,
  };
}

function runtimeArtifactRefs(runtime, configurationHash) {
  const refs = [
    `tsjs-analyzer:${TSJS_AST_ANALYZER_VERSION}`,
    `tsjs-configuration:${configurationHash}`,
  ];
  if (runtime) {
    refs.push(`tsjs-analyzer-bytes:${runtime.analyzer_sha256}`, `tsjs-node:${runtime.node_version}`);
    if (runtime.status === "available") refs.push(`tsjs-typescript:${runtime.typescript_version}`, `tsjs-typescript-bytes:${runtime.typescript_sha256}`);
    else refs.push("tsjs-typescript:unavailable");
  }
  return refs;
}

function metricRecord(index, configurationHash, runtime, options) {
  const measured = options.status === "measured" || options.status === "inferred";
  const refs = [...new Set([
    `repository-index:${index.binding.index_digest}`,
    ...runtimeArtifactRefs(runtime, configurationHash),
    ...(options.artifactRefs ?? []),
  ])].sort(stableCompare);
  return {
    analyzer_identity: TSJS_AST_ANALYZER_VERSION,
    analyzer_version: TSJS_AST_ANALYZER_VERSION,
    comparability: {
      analyzer_identity: TSJS_AST_ANALYZER_VERSION,
      analyzer_version: TSJS_AST_ANALYZER_VERSION,
      compatible_with_prior: false,
      configuration_hash: configurationHash,
      reason: "no prior analyzer-bound measurement was supplied",
    },
    definition_id: options.definitionId,
    family: options.family,
    measurement: {
      completeness: options.completeness ?? (measured ? 1 : 0),
      confidence: options.confidence ?? (measured ? 1 : 0),
      reason: options.reason ?? null,
      status: options.status,
    },
    metric_id: options.metricId,
    repository_revision: index.binding.repository_revision,
    scope: {
      generated_code: false,
      included_in_human_maintainability: true,
      kind: options.scopeKind ?? "repository",
      language: options.language ?? "tsjs",
      path: options.scopePath ?? ".",
    },
    source: {
      artifact_refs: refs,
      collector_id: "tsjs-static-intelligence",
      collector_version: COLLECTOR_VERSION,
      command: null,
      evidence_refs: refs,
      kind: "exact-git-tsjs-ast",
      repository_revision: index.binding.repository_revision,
    },
    subject: options.subject ?? "repository:committed-index",
    unit: options.unit,
    value: measured ? options.value : null,
    window: { end: index.binding.repository_revision, kind: "revision", start: null },
  };
}

function buildMetrics(index, configurationHash, runtime, complexity, topology) {
  const metrics = [];
  for (const [partitionId, partition] of [["production", complexity.partitions.production], ["all-tsjs", complexity.partitions.all_tsjs]]) {
    const common = {
      artifactRefs: [`tsjs-partition:${partitionId}`],
      completeness: partition.status === "measured" ? partition.completeness : 0,
      confidence: partition.status === "measured" ? partition.completeness : 0,
      family: "structural_complexity",
      reason: partition.reason,
      status: partition.status,
    };
    for (const [name, definition, value, unit] of [
      ["cyclomatic_callable_count", "sei.static.tsjs.cyclomatic_callable_count@1", partition.aggregate.callable_count, "callables"],
      ["cyclomatic_complexity", "sei.static.tsjs.cyclomatic_complexity@1", partition.aggregate.cyclomatic.sum, "cyclomatic-complexity-points"],
      ["cyclomatic_complexity_p50", "sei.static.tsjs.cyclomatic_complexity_p50@1", partition.aggregate.cyclomatic.p50, "cyclomatic-complexity-points"],
      ["cyclomatic_complexity_p90", "sei.static.tsjs.cyclomatic_complexity_p90@1", partition.aggregate.cyclomatic.p90, "cyclomatic-complexity-points"],
      ["cyclomatic_complexity_max", "sei.static.tsjs.cyclomatic_complexity_max@1", partition.aggregate.cyclomatic.max, "cyclomatic-complexity-points"],
      ["cognitive_complexity", "sei.static.tsjs.cognitive_complexity@1", partition.aggregate.cognitive.sum, "cognitive-complexity-points"],
      ["cognitive_complexity_p50", "sei.static.tsjs.cognitive_complexity_p50@1", partition.aggregate.cognitive.p50, "cognitive-complexity-points"],
      ["cognitive_complexity_p90", "sei.static.tsjs.cognitive_complexity_p90@1", partition.aggregate.cognitive.p90, "cognitive-complexity-points"],
      ["cognitive_complexity_max", "sei.static.tsjs.cognitive_complexity_max@1", partition.aggregate.cognitive.max, "cognitive-complexity-points"],
    ]) metrics.push(metricRecord(index, configurationHash, runtime, { ...common, definitionId: definition, metricId: `static.tsjs.${name}:${partitionId}`, unit, value }));
    const inventoryStatus = partition.aggregate.parsed_file_count > 0 ? "measured" : "unavailable";
    for (const [name, value] of [["file_count", partition.aggregate.supported_file_count], ["parsed_file_count", partition.aggregate.parsed_file_count]]) {
      metrics.push(metricRecord(index, configurationHash, runtime, {
        ...common,
        definitionId: `sei.static.tsjs.${name}@1`,
        metricId: `static.tsjs.${name}:${partitionId}`,
        status: inventoryStatus,
        unit: "files",
        value,
      }));
    }
  }

  for (const file of complexity.files) {
    const status = file.parse_status === "ok" ? "measured" : "unavailable";
    const reason = status === "measured" ? null : `${file.error.code}: ${file.error.message}`.slice(0, 240);
    const fileRefs = [file.content_key, file.path, `tsjs-partition:${file.test_source ? "test" : "production"}`, `tsjs-syntax:${file.syntax}`];
    for (const [name, definition, value, unit] of [
      ["cyclomatic_complexity", "sei.static.tsjs.cyclomatic_complexity@1", file.cyclomatic_sum, "cyclomatic-complexity-points"],
      ["cyclomatic_complexity_max", "sei.static.tsjs.cyclomatic_complexity_max@1", file.cyclomatic_max, "cyclomatic-complexity-points"],
      ["cognitive_complexity", "sei.static.tsjs.cognitive_complexity@1", file.cognitive_sum, "cognitive-complexity-points"],
      ["cognitive_complexity_max", "sei.static.tsjs.cognitive_complexity_max@1", file.cognitive_max, "cognitive-complexity-points"],
    ]) metrics.push(metricRecord(index, configurationHash, runtime, {
      artifactRefs: fileRefs,
      completeness: status === "measured" ? 1 : 0,
      confidence: status === "measured" ? 1 : 0,
      definitionId: definition,
      family: "structural_complexity",
      language: file.language,
      metricId: `static.tsjs.${name}:${file.path}`,
      reason,
      scopeKind: "file",
      scopePath: file.path,
      status,
      subject: `file:${file.path}`,
      unit,
      value,
    }));
    if (file.parse_status !== "ok") continue;
    for (const callable of file.callables) {
      const identity = `tsjs-callable:${file.path}#${callable.qualified_name}@${callable.lineno}:${callable.col_offset}-${callable.end_lineno}:${callable.end_col_offset}`;
      for (const [kind, value, unit] of [
        ["cyclomatic", callable.cyclomatic_complexity, "cyclomatic-complexity-points"],
        ["cognitive", callable.cognitive_complexity, "cognitive-complexity-points"],
      ]) metrics.push(metricRecord(index, configurationHash, runtime, {
        artifactRefs: [...fileRefs, identity],
        definitionId: `sei.static.tsjs.${kind}_callable@1`,
        family: "structural_complexity",
        language: file.language,
        metricId: `static.tsjs.${kind}_callable:${file.path}:${callable.lineno}:${callable.col_offset}:${callable.end_lineno}:${callable.end_col_offset}:${callable.qualified_name}`,
        reason: null,
        scopeKind: "file",
        scopePath: file.path,
        status: "measured",
        subject: identity,
        unit,
        value,
      }));
    }
  }

  for (const [partitionId, partition] of [["production", topology.partitions?.production], ["all-tsjs", topology.partitions?.all_tsjs]]) {
    const status = topology.status === "measured" && partition ? "measured" : "unavailable";
    const modules = topology.modules.filter((module) => partitionId === "all-tsjs" || !module.test_source);
    const completeness = status === "measured" && modules.length > 0
      ? Number((modules.filter((module) => module.parse_status === "ok").length / modules.length).toFixed(8)) : 0;
    for (const [name, value, unit] of [
      ["node_count", partition?.aggregates.node_count, "count"],
      ["edge_count", partition?.aggregates.edge_count, "count"],
      ["scc_count", partition?.aggregates.scc_count, "count"],
      ["cyclic_scc_count", partition?.aggregates.cyclic_scc_count, "count"],
      ["cyclic_node_count", partition?.aggregates.cyclic_node_count, "count"],
      ["fan_in_max", partition?.aggregates.fan_in_max, "count"],
      ["fan_out_max", partition?.aggregates.fan_out_max, "count"],
      ["density", partition?.aggregates.density, "ratio"],
    ]) metrics.push(metricRecord(index, configurationHash, runtime, {
      artifactRefs: [`tsjs-partition:${partitionId}`],
      completeness,
      confidence: completeness,
      definitionId: `sei.static.tsjs.dependency.${name}@1`,
      family: "dependency_topology",
      metricId: `static.tsjs.dependency.${name}:${partitionId}`,
      reason: topology.reason,
      status,
      unit,
      value,
    }));
    metrics.push(metricRecord(index, configurationHash, runtime, {
      artifactRefs: [`tsjs-partition:${partitionId}`],
      definitionId: "sei.static.tsjs.dependency.centrality@1",
      family: "dependency_topology",
      metricId: `static.tsjs.dependency.centrality:${partitionId}`,
      reason: "FAIL-TSJS-INTELLIGENCE-UNSUPPORTED-METRIC: no named centrality algorithm is defined",
      status: "unavailable",
      unit: "normalized-centrality",
      value: null,
    }));
    if (!partition) continue;
    const moduleById = new Map(topology.modules.map((module) => [module.id, module]));
    for (const node of partition.nodes) {
      const module = moduleById.get(node.id);
      const moduleStatus = module?.parse_status === "ok" ? "measured" : "unavailable";
      const refs = [`tsjs-module:${node.id}`, `tsjs-partition:${partitionId}`];
      for (const [name, value] of [["fan_in", node.fan_in], ["fan_out", node.fan_out]]) metrics.push(metricRecord(index, configurationHash, runtime, {
        artifactRefs: refs,
        completeness: moduleStatus === "measured" ? completeness : 0,
        confidence: moduleStatus === "measured" ? completeness : 0,
        definitionId: `sei.static.tsjs.dependency.${name}@1`,
        family: "dependency_topology",
        language: module?.language ?? "tsjs",
        metricId: `static.tsjs.dependency.${name}:${partitionId}:${node.id}`,
        reason: moduleStatus === "measured" ? topology.reason : "module source did not parse",
        scopeKind: "module",
        scopePath: module?.path ?? ".",
        status: moduleStatus,
        subject: `tsjs-module:${node.id}`,
        unit: "count",
        value,
      }));
      metrics.push(metricRecord(index, configurationHash, runtime, {
        artifactRefs: refs,
        completeness: moduleStatus === "measured" && node.instability.status === "measured" ? completeness : 0,
        confidence: moduleStatus === "measured" && node.instability.status === "measured" ? completeness : 0,
        definitionId: "sei.static.tsjs.dependency.instability@1",
        family: "dependency_topology",
        language: module?.language ?? "tsjs",
        metricId: `static.tsjs.dependency.instability:${partitionId}:${node.id}`,
        reason: moduleStatus === "measured" ? (node.instability.reason ?? topology.reason) : "module source did not parse",
        scopeKind: "module",
        scopePath: module?.path ?? ".",
        status: moduleStatus === "measured" ? node.instability.status : "unavailable",
        subject: `tsjs-module:${node.id}`,
        unit: "ratio",
        value: node.instability.value,
      }));
    }
    for (const component of partition.strongly_connected_components.filter((candidate) => candidate.cyclic)) metrics.push(metricRecord(index, configurationHash, runtime, {
      artifactRefs: [`tsjs-partition:${partitionId}`, `tsjs-scc:${component.scc_id}`, ...component.members.map((member) => `tsjs-scc-member:${member}`)],
      completeness,
      confidence: completeness,
      definitionId: "sei.static.tsjs.dependency.cyclic_scc_size@1",
      family: "dependency_topology",
      metricId: `static.tsjs.dependency.cyclic_scc_size:${partitionId}:${component.scc_id}`,
      reason: topology.reason,
      scopeKind: "scc",
      scopePath: ".",
      status: "measured",
      subject: `tsjs-scc:${component.scc_id}`,
      unit: "modules",
      value: component.members.length,
    }));
  }

  const importStatus = topology.status === "measured" ? "measured" : "unavailable";
  for (const classification of ["internal", "external", "unresolved-relative", "ambiguous-relative", "dynamic", "unsupported"]) metrics.push(metricRecord(index, configurationHash, runtime, {
    completeness: importStatus === "measured" ? topology.completeness : 0,
    confidence: importStatus === "measured" ? topology.completeness : 0,
    definitionId: "sei.static.tsjs.dependency.import_count@1",
    family: "dependency_topology",
    metricId: `static.tsjs.dependency.import_count:all-tsjs:${classification}`,
    reason: topology.reason,
    status: importStatus,
    unit: "count",
    value: topology.import_counts[classification],
  }));
  const testSourceByPath = new Map(topology.modules.map((module) => [module.path, module.test_source]));
  const productionExports = topology.exports.filter((fact) => testSourceByPath.get(fact.path) === false).length;
  for (const [partitionId, value] of [["production", productionExports], ["all-tsjs", topology.exports.length]]) metrics.push(metricRecord(index, configurationHash, runtime, {
    completeness: importStatus === "measured" ? topology.completeness : 0,
    confidence: importStatus === "measured" ? topology.completeness : 0,
    definitionId: "sei.static.tsjs.export_count@1",
    family: "dependency_topology",
    metricId: `static.tsjs.export_count:${partitionId}`,
    reason: topology.reason,
    status: importStatus,
    unit: "count",
    value,
  }));
  return metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
}

function configurationIdentity(configuration, runtime) {
  return sha256(canonicalJson({
    analyzer_version: TSJS_AST_ANALYZER_VERSION,
    limits: configuration.limits,
    max_queued_source_bytes: configuration.maxQueuedSourceBytes,
    protocol_version: TSJS_AST_PROTOCOL_VERSION,
    runtime: runtime ?? { status: "not-probed" },
  }));
}

async function analyzeTsjsIntelligence(input) {
  assertClosedRecord(input, INPUT_KEYS, "input");
  validateRepositoryIndex(input.repositoryIndex);
  validateTaskExecutor(input.taskExecutor);
  if (input.signal !== undefined && !isAbortSignal(input.signal)) fail("FAIL-TSJS-INTELLIGENCE-CONFIG", "signal must be an AbortSignal");
  const configuration = normalizeConfiguration(input.configuration);
  const { repositoryIndex: index, taskExecutor, signal } = input;
  const token = bindingToken(index);
  const telemetry = { cancelled: 0, executor_runs: 0, max_in_flight: 0, tasks_submitted: 0, timeouts: 0 };
  assertLive(index, token, signal);
  const { selected, counters } = selectEntries(index);
  const analyzed = await analyzeEntries(selected, { configuration, index, signal, taskExecutor, telemetry, token });
  assertLive(index, token, signal);
  const complexity = materializeComplexity(selected, analyzed.facts, counters);
  const topology = materializeTopology(selected, analyzed.facts, complexity);
  const configurationHash = configurationIdentity(configuration, analyzed.runtime);
  const collectorStatus = complexity.status === "unavailable" ? "unavailable"
    : complexity.completeness === 1 && topology.completeness === 1 ? "available" : "degraded";
  const collectorReason = collectorStatus === "available" ? null : complexity.reason ?? topology.reason
    ?? "TS/JS/TSX structural coverage is partial";
  const canonical = deepFreeze(canonicalValue({
    analyzer: {
      analyzer_version: TSJS_AST_ANALYZER_VERSION,
      cognitive_rules: "structural-nesting-else-logical-sequences-direct-recursion@1",
      cyclomatic_rules: "base-if-loop-catch-case-conditional-logical-nullish@1",
      protocol: TSJS_AST_PROTOCOL_VERSION,
      runtime: analyzed.runtime ?? {
        analyzer_sha256: null,
        node_version: null,
        script_kinds: [],
        status: "not-probed",
        typescript_sha256: null,
        typescript_version: null,
      },
    },
    binding: {
      classification_policy_version: index.binding.classification_policy_version,
      configuration_hash: configurationHash,
      index_digest: index.binding.index_digest,
      repository_revision: index.binding.repository_revision,
    },
    collectors: [{
      analyzer_identity: TSJS_AST_ANALYZER_VERSION,
      analyzer_version: TSJS_AST_ANALYZER_VERSION,
      collector_id: "tsjs-static-intelligence",
      collector_version: COLLECTOR_VERSION,
      reason: collectorReason,
      status: collectorStatus,
    }],
    diagnostics: { coverage: counters },
    facts: { complexity, topology },
    metrics: buildMetrics(index, configurationHash, analyzed.runtime, complexity, topology),
    version: TSJS_INTELLIGENCE_VERSION,
  }));
  return deepFreeze({ canonical, telemetry });
}

function projectTsjsEvidence(input) {
  assertClosedRecord(input, new Set(["result", "configuration_hash", "history_window"]), "projection input", "FAIL-TSJS-INTELLIGENCE-PROJECTION");
  const canonical = input.result?.canonical;
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical) || canonical.version !== TSJS_INTELLIGENCE_VERSION
      || !canonical.binding || typeof canonical.binding !== "object" || Array.isArray(canonical.binding)
      || !Array.isArray(canonical.collectors) || !Array.isArray(canonical.metrics)) {
    fail("FAIL-TSJS-INTELLIGENCE-PROJECTION", "result is not a canonical TS/JS intelligence artifact");
  }
  if (!/^[0-9a-f]{64}$/.test(input.configuration_hash ?? "")) {
    fail("FAIL-TSJS-INTELLIGENCE-PROJECTION", "configuration_hash must be a lowercase SHA-256 digest");
  }
  assertClosedRecord(input.history_window, new Set(["kind", "start", "end"]), "projection history_window", "FAIL-TSJS-INTELLIGENCE-PROJECTION");
  if (!new Set(["revision", "revision-range"]).has(input.history_window.kind)
      || input.history_window.end !== canonical.binding.repository_revision) {
    fail("FAIL-TSJS-INTELLIGENCE-PROJECTION", "history_window must end at the analyzed repository revision");
  }
  const metrics = canonical.metrics.map((metric) => {
    const claimedMeasured = new Set(["measured", "inferred"]).has(metric.measurement?.status);
    const invalidMeasuredValue = claimedMeasured && (typeof metric.value !== "number" || !Number.isFinite(metric.value));
    return canonicalValue({
      ...metric,
      value: invalidMeasuredValue ? null : metric.value,
      measurement: invalidMeasuredValue ? {
        status: "unavailable",
        completeness: 0,
        confidence: 0,
        reason: "FAIL-TSJS-INTELLIGENCE-PROJECTION: analyzer supplied no finite value for this metric",
      } : metric.measurement,
      window: structuredClone(input.history_window),
      comparability: {
        ...metric.comparability,
        configuration_hash: input.configuration_hash,
        compatible_with_prior: false,
        reason: "no prior collector-bound TS/JS measurement was supplied",
      },
    });
  }).sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  return deepFreeze(canonicalValue({
    collectors: structuredClone(canonical.collectors),
    metrics,
    facts: structuredClone(canonical.facts),
    canonical,
  }));
}

module.exports = {
  TSJS_INTELLIGENCE_VERSION,
  analyzeTsjsIntelligence,
  projectTsjsEvidence,
};
