"use strict";

const { reduceDependencyTopology } = require("./dependency-topology.js");

const DEPENDENCY_INTELLIGENCE_VERSION = "sei.dependency-intelligence@1";
const MAX_NODES = 10_000;
const MAX_EDGES = 200_000;
const MAX_TEXT = 1024;
const EXACT_BRANDES_MAX_NODES = 512;
const EXACT_BRANDES_MAX_EDGES = 20_000;
const SAMPLED_BRANDES_SOURCES = 64;
const PAGERANK_DAMPING = 0.85;
const PAGERANK_TOLERANCE = 1e-10;
const PAGERANK_MAX_ITERATIONS = 100;

function fail(detail) {
  const error = new Error(`FAIL-DEPENDENCY-INTELLIGENCE: ${detail}`);
  error.code = "FAIL-DEPENDENCY-INTELLIGENCE";
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

function assertClosed(value, allowedKeys, label) {
  if (!isRecord(value)) fail(`${label} must be a closed record`);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(stableCompare);
  if (unknown.length > 0) fail(`${label}.${unknown[0]} is not declared`);
}

function validText(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !value.includes("\0");
}

function round(value) {
  return Number(value.toFixed(8));
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function quantile(sortedValues, probability) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const fraction = position - lower;
  return round(sortedValues[lower] + ((sortedValues[upper] - sortedValues[lower]) * fraction));
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return {
      count: 0,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      maximum: null,
      top_10_percent_concentration: null,
    };
  }
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const topCount = Math.max(1, Math.ceil(sorted.length * 0.1));
  const topTotal = sorted.slice(-topCount).reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    maximum: sorted.at(-1),
    top_10_percent_concentration: total === 0 ? 0 : round(topTotal / total),
  };
}

function pageRank(nodeIds, outbound, inbound) {
  const count = nodeIds.length;
  if (count === 0) {
    return { scores: new Map(), iterations: 0, converged: true };
  }
  let ranks = new Map(nodeIds.map((id) => [id, 1 / count]));
  let iterations = 0;
  let converged = false;
  while (iterations < PAGERANK_MAX_ITERATIONS) {
    iterations += 1;
    let dangling = 0;
    for (const id of nodeIds) {
      if (outbound.get(id).length === 0) dangling += ranks.get(id);
    }
    const base = ((1 - PAGERANK_DAMPING) / count) + (PAGERANK_DAMPING * dangling / count);
    const next = new Map();
    let delta = 0;
    for (const id of nodeIds) {
      let incomingContribution = 0;
      for (const source of inbound.get(id)) {
        incomingContribution += ranks.get(source) / outbound.get(source).length;
      }
      const value = base + (PAGERANK_DAMPING * incomingContribution);
      next.set(id, value);
      delta += Math.abs(value - ranks.get(id));
    }
    ranks = next;
    if (delta <= PAGERANK_TOLERANCE) {
      converged = true;
      break;
    }
  }
  return { scores: ranks, iterations, converged };
}

function selectedBrandesSources(nodeIds, exact) {
  if (exact || nodeIds.length <= SAMPLED_BRANDES_SOURCES) return [...nodeIds];
  const selected = [];
  for (let index = 0; index < SAMPLED_BRANDES_SOURCES; index += 1) {
    selected.push(nodeIds[Math.floor(index * nodeIds.length / SAMPLED_BRANDES_SOURCES)]);
  }
  return selected;
}

function betweenness(nodeIds, outbound, edgeCount) {
  const exact = nodeIds.length <= EXACT_BRANDES_MAX_NODES && edgeCount <= EXACT_BRANDES_MAX_EDGES;
  const sources = selectedBrandesSources(nodeIds, exact);
  const scores = new Map(nodeIds.map((id) => [id, 0]));
  for (const source of sources) {
    const stack = [];
    const predecessors = new Map(nodeIds.map((id) => [id, []]));
    const paths = new Map(nodeIds.map((id) => [id, 0]));
    const distance = new Map(nodeIds.map((id) => [id, -1]));
    paths.set(source, 1);
    distance.set(source, 0);
    const queue = [source];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const vertex = queue[cursor];
      stack.push(vertex);
      for (const target of outbound.get(vertex)) {
        if (distance.get(target) < 0) {
          distance.set(target, distance.get(vertex) + 1);
          queue.push(target);
        }
        if (distance.get(target) === distance.get(vertex) + 1) {
          paths.set(target, paths.get(target) + paths.get(vertex));
          predecessors.get(target).push(vertex);
        }
      }
    }
    const dependency = new Map(nodeIds.map((id) => [id, 0]));
    while (stack.length > 0) {
      const target = stack.pop();
      for (const predecessor of predecessors.get(target)) {
        const targetPaths = paths.get(target);
        if (targetPaths !== 0) {
          dependency.set(
            predecessor,
            dependency.get(predecessor) + ((paths.get(predecessor) / targetPaths) * (1 + dependency.get(target))),
          );
        }
      }
      if (target !== source) scores.set(target, scores.get(target) + dependency.get(target));
    }
  }
  const orderedPairDenominator = nodeIds.length <= 2 ? null : (nodeIds.length - 1) * (nodeIds.length - 2);
  const sampleExpansion = exact || sources.length === 0 ? 1 : nodeIds.length / sources.length;
  const normalized = new Map(nodeIds.map((id) => [
    id,
    orderedPairDenominator === null ? 0 : round((scores.get(id) * sampleExpansion) / orderedPairDenominator),
  ]));
  return {
    scores: normalized,
    descriptor: {
      algorithm: exact ? "brandes-directed-betweenness@1" : "sampled-brandes-directed-betweenness@1",
      normalization: exact
        ? "ordered-pair fraction excluding the subject node"
        : "estimated ordered-pair fraction excluding the subject node",
      exact,
      source_count: sources.length,
    },
  };
}

function analyzeDependencyIntelligence(input) {
  assertClosed(input, ["edges", "nodes"], "dependency intelligence input");
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) fail("nodes and edges must be arrays");
  if (input.nodes.length > MAX_NODES) fail(`node count exceeds ${MAX_NODES}`);
  if (input.edges.length > MAX_EDGES) fail(`edge count exceeds ${MAX_EDGES}`);

  const nodeMap = new Map();
  for (const [index, node] of input.nodes.entries()) {
    assertClosed(node, ["id", "layer", "package_id"], `nodes[${index}]`);
    if (!validText(node.id)) fail(`nodes[${index}].id is invalid`);
    if (!validText(node.package_id, { nullable: true })) fail(`nodes[${index}].package_id is invalid`);
    if (!validText(node.layer, { nullable: true })) fail(`nodes[${index}].layer is invalid`);
    if (nodeMap.has(node.id)) fail(`duplicate node ID ${JSON.stringify(node.id)}`);
    nodeMap.set(node.id, { id: node.id, package_id: node.package_id, layer: node.layer });
  }
  const edgeKeys = new Set();
  const edges = [];
  for (const [index, edge] of input.edges.entries()) {
    assertClosed(edge, ["source", "target"], `edges[${index}]`);
    if (!validText(edge.source) || !validText(edge.target)) fail(`edges[${index}] endpoints are invalid`);
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) fail(`edges[${index}] must bind declared nodes`);
    const key = JSON.stringify([edge.source, edge.target]);
    if (edgeKeys.has(key)) fail(`duplicate edge ${key}`);
    edgeKeys.add(key);
    edges.push({ source: edge.source, target: edge.target });
  }

  const nodeIds = [...nodeMap.keys()].sort(stableCompare);
  edges.sort((left, right) => stableCompare(left.source, right.source) || stableCompare(left.target, right.target));
  const outboundSets = new Map(nodeIds.map((id) => [id, new Set()]));
  const inboundSets = new Map(nodeIds.map((id) => [id, new Set()]));
  for (const edge of edges) {
    outboundSets.get(edge.source).add(edge.target);
    inboundSets.get(edge.target).add(edge.source);
  }
  const outbound = new Map(nodeIds.map((id) => [id, [...outboundSets.get(id)].sort(stableCompare)]));
  const inbound = new Map(nodeIds.map((id) => [id, [...inboundSets.get(id)].sort(stableCompare)]));
  const topology = reduceDependencyTopology({
    nodes: nodeIds.map((id) => ({ id })),
    edges,
  });
  const pageRankResult = pageRank(nodeIds, outbound, inbound);
  const betweennessResult = betweenness(nodeIds, outbound, edges.length);
  const topologyNodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const degreeDenominator = nodeIds.length <= 1 ? null : nodeIds.length - 1;
  const nodes = nodeIds.map((id) => {
    const topologyNode = topologyNodes.get(id);
    return {
      id,
      package_id: nodeMap.get(id).package_id,
      layer: nodeMap.get(id).layer,
      inbound_neighbors: topologyNode.inbound_neighbors,
      outbound_neighbors: topologyNode.outbound_neighbors,
      fan_in: topologyNode.fan_in,
      fan_out: topologyNode.fan_out,
      instability: topologyNode.instability,
      in_degree_centrality: degreeDenominator === null ? 0 : round(topologyNode.fan_in / degreeDenominator),
      out_degree_centrality: degreeDenominator === null ? 0 : round(topologyNode.fan_out / degreeDenominator),
      degree_centrality: degreeDenominator === null ? 0 : round((topologyNode.fan_in + topologyNode.fan_out) / degreeDenominator),
      page_rank: round(pageRankResult.scores.get(id)),
      betweenness_centrality: betweennessResult.scores.get(id),
    };
  });

  let packageObserved = 0;
  let layerObserved = 0;
  let crossPackage = 0;
  let crossLayer = 0;
  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (source.package_id !== null && target.package_id !== null) {
      packageObserved += 1;
      if (source.package_id !== target.package_id) crossPackage += 1;
    }
    if (source.layer !== null && target.layer !== null) {
      layerObserved += 1;
      if (source.layer !== target.layer) crossLayer += 1;
    }
  }
  const coverage = (observed) => ({
    observed_edges: observed,
    total_edges: edges.length,
    ratio: edges.length === 0 ? null : round(observed / edges.length),
  });
  const highConnectivity = [...nodes]
    .sort((left, right) => (
      (right.degree_centrality - left.degree_centrality)
      || (right.page_rank - left.page_rank)
      || (right.betweenness_centrality - left.betweenness_centrality)
      || stableCompare(left.id, right.id)
    ))
    .slice(0, 15)
    .map((node) => ({
      id: node.id,
      fan_in: node.fan_in,
      fan_out: node.fan_out,
      degree_centrality: node.degree_centrality,
      page_rank: node.page_rank,
      betweenness_centrality: node.betweenness_centrality,
    }));

  return deepFreeze({
    intelligence_version: DEPENDENCY_INTELLIGENCE_VERSION,
    algorithms: {
      degree: {
        algorithm: "directed-degree-centrality@1",
        normalization: "fan divided by node_count minus one",
      },
      page_rank: {
        algorithm: "pagerank@1",
        damping: PAGERANK_DAMPING,
        tolerance: PAGERANK_TOLERANCE,
        maximum_iterations: PAGERANK_MAX_ITERATIONS,
        iterations: pageRankResult.iterations,
        converged: pageRankResult.converged,
      },
      betweenness: betweennessResult.descriptor,
    },
    aggregates: {
      node_count: topology.aggregates.node_count,
      edge_count: topology.aggregates.edge_count,
      non_self_edge_count: topology.aggregates.non_self_edge_count,
      scc_count: topology.aggregates.scc_count,
      cyclic_scc_count: topology.aggregates.cyclic_scc_count,
      cyclic_node_count: topology.aggregates.cyclic_node_count,
      density: topology.aggregates.density,
      cross_package_edge_count: crossPackage,
      package_edge_coverage: coverage(packageObserved),
      cross_layer_edge_count: crossLayer,
      layer_edge_coverage: coverage(layerObserved),
    },
    distributions: {
      fan_in: distribution(nodes.map((node) => node.fan_in)),
      fan_out: distribution(nodes.map((node) => node.fan_out)),
      degree_centrality: distribution(nodes.map((node) => node.degree_centrality)),
      page_rank: distribution(nodes.map((node) => node.page_rank)),
      betweenness_centrality: distribution(nodes.map((node) => node.betweenness_centrality)),
    },
    nodes,
    strongly_connected_components: topology.strongly_connected_components,
    high_connectivity_modules: highConnectivity,
  });
}

function projectDependencyEvidence(input) {
  assertClosed(input, ["result", "graph_id", "graph_completeness", "repository_revision", "configuration_hash", "history_window"], "projection input");
  const result = input.result;
  if (!isRecord(result) || result.intelligence_version !== DEPENDENCY_INTELLIGENCE_VERSION || !Array.isArray(result.nodes)
      || !isRecord(result.aggregates) || !isRecord(result.algorithms)) fail("projection result is not canonical dependency intelligence");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.graph_id ?? "")) fail("projection graph_id is invalid");
  if (!Number.isFinite(input.graph_completeness) || input.graph_completeness < 0 || input.graph_completeness > 1) {
    fail("projection graph_completeness must be a finite ratio");
  }
  if (!/^[0-9a-f]{40}$/.test(input.repository_revision ?? "") || !/^[0-9a-f]{64}$/.test(input.configuration_hash ?? "")) {
    fail("projection revision or configuration hash is invalid");
  }
  assertClosed(input.history_window, ["kind", "start", "end"], "projection history_window");
  if (!new Set(["revision", "revision-range"]).has(input.history_window.kind) || input.history_window.end !== input.repository_revision) {
    fail("projection history_window must end at repository_revision");
  }
  const collectorId = `dependency-intelligence-${input.graph_id}`;
  const analyzerIdentity = DEPENDENCY_INTELLIGENCE_VERSION;
  const refs = [
    `dependency-graph:${input.graph_id}`,
    `dependency-algorithm:${result.algorithms.page_rank.algorithm}`,
    `dependency-algorithm:${result.algorithms.betweenness.algorithm}`,
    `dependency-algorithm:${result.algorithms.degree.algorithm}`,
  ].sort(stableCompare);
  const partialReason = input.graph_completeness === 1
    ? null
    : `partial dependency graph: ${input.graph_completeness} of selected modules parsed successfully`;
  const metric = (name, subject, value, unit, scopeKind = "repository", scopePath = ".") => ({
    metric_id: `static.dependency.${name}:${input.graph_id}${subject === null ? "" : `:${subject}`}`,
    definition_id: `sei.static.dependency.${name}@1`,
    family: "dependency_intelligence",
    subject: subject === null ? `dependency-graph:${input.graph_id}` : `dependency-node:${input.graph_id}:${subject}`,
    repository_revision: input.repository_revision,
    value,
    unit,
    measurement: { status: "measured", completeness: input.graph_completeness, confidence: input.graph_completeness, reason: partialReason },
    source: {
      kind: "named-dependency-graph-algorithms",
      collector_id: collectorId,
      collector_version: "1.0.0",
      repository_revision: input.repository_revision,
      command: null,
      artifact_refs: refs,
      evidence_refs: refs,
    },
    scope: { kind: scopeKind, path: scopePath, language: null, generated_code: false, included_in_human_maintainability: true },
    window: structuredClone(input.history_window),
    analyzer_identity: analyzerIdentity,
    analyzer_version: analyzerIdentity,
    comparability: {
      analyzer_identity: analyzerIdentity,
      analyzer_version: analyzerIdentity,
      configuration_hash: input.configuration_hash,
      compatible_with_prior: false,
      reason: "no prior collector-bound named dependency measurement was supplied",
    },
  });
  const metrics = [
    metric("node_count", null, result.aggregates.node_count, "count"),
    metric("edge_count", null, result.aggregates.edge_count, "count"),
    metric("cross_package_edge_count", null, result.aggregates.cross_package_edge_count, "count"),
    metric("cross_layer_edge_count", null, result.aggregates.cross_layer_edge_count, "count"),
    ...result.nodes.flatMap((node) => [
      metric("page_rank", node.id, node.page_rank, "normalized-centrality", "module", node.id),
      metric("betweenness", node.id, node.betweenness_centrality, "normalized-centrality", "module", node.id),
      metric("degree", node.id, node.degree_centrality, "normalized-centrality", "module", node.id),
      metric("fan_in", node.id, node.fan_in, "count", "module", node.id),
      metric("fan_out", node.id, node.fan_out, "count", "module", node.id),
    ]),
  ].sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  return deepFreeze({
    collectors: [{
      collector_id: collectorId,
      collector_version: "1.0.0",
      status: input.graph_completeness === 1 ? "available" : "degraded",
      analyzer_identity: analyzerIdentity,
      analyzer_version: analyzerIdentity,
      reason: partialReason,
    }],
    metrics,
    algorithms: result.algorithms,
    distributions: result.distributions,
    high_connectivity_modules: result.high_connectivity_modules,
    result,
  });
}

module.exports = {
  DEPENDENCY_INTELLIGENCE_VERSION,
  analyzeDependencyIntelligence,
  projectDependencyEvidence,
};
