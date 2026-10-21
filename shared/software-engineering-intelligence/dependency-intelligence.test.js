"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEPENDENCY_INTELLIGENCE_VERSION,
  analyzeDependencyIntelligence,
  projectDependencyEvidence,
} = require("./dependency-intelligence.js");

function graph() {
  return {
    nodes: [
      { id: "pkg-a/a", package_id: "pkg-a", layer: "api" },
      { id: "pkg-a/b", package_id: "pkg-a", layer: "domain" },
      { id: "pkg-b/c", package_id: "pkg-b", layer: "storage" },
      { id: "isolated", package_id: null, layer: null },
    ],
    edges: [
      { source: "pkg-a/a", target: "pkg-a/b" },
      { source: "pkg-a/b", target: "pkg-b/c" },
    ],
  };
}

test("dependency intelligence computes named centralities, distributions, package edges, and stable investigation facts", () => {
  const result = analyzeDependencyIntelligence(graph());

  assert.equal(DEPENDENCY_INTELLIGENCE_VERSION, "sei.dependency-intelligence@1");
  assert.deepEqual(result.algorithms.degree, {
    algorithm: "directed-degree-centrality@1",
    normalization: "fan divided by node_count minus one",
  });
  assert.equal(result.algorithms.page_rank.algorithm, "pagerank@1");
  assert.equal(result.algorithms.page_rank.damping, 0.85);
  assert.equal(result.algorithms.page_rank.tolerance, 1e-10);
  assert.equal(result.algorithms.page_rank.maximum_iterations, 100);
  assert.equal(result.algorithms.page_rank.converged, true);
  assert.deepEqual(result.algorithms.betweenness, {
    algorithm: "brandes-directed-betweenness@1",
    normalization: "ordered-pair fraction excluding the subject node",
    exact: true,
    source_count: 4,
  });

  assert.equal(result.aggregates.node_count, 4);
  assert.equal(result.aggregates.edge_count, 2);
  assert.equal(result.aggregates.cross_package_edge_count, 1);
  assert.deepEqual(result.aggregates.package_edge_coverage, {
    observed_edges: 2,
    total_edges: 2,
    ratio: 1,
  });
  assert.equal(result.aggregates.cross_layer_edge_count, 2);
  assert.deepEqual(result.aggregates.layer_edge_coverage, {
    observed_edges: 2,
    total_edges: 2,
    ratio: 1,
  });
  assert.deepEqual(result.distributions.fan_in, {
    count: 4,
    p50: 0.5,
    p75: 1,
    p90: 1,
    p95: 1,
    maximum: 1,
    top_10_percent_concentration: 0.5,
  });

  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("pkg-a/b").betweenness_centrality, 0.16666667);
  assert.equal(byId.get("pkg-a/a").betweenness_centrality, 0);
  assert.equal(byId.get("pkg-b/c").page_rank > byId.get("pkg-a/b").page_rank, true);
  assert.equal(byId.get("pkg-a/b").page_rank > byId.get("pkg-a/a").page_rank, true);
  assert.equal(Number(result.nodes.reduce((sum, node) => sum + node.page_rank, 0).toFixed(7)), 1);
  assert.equal(result.high_connectivity_modules.length <= 15, true);
  assert.deepEqual(Object.keys(result.high_connectivity_modules[0]), [
    "id",
    "fan_in",
    "fan_out",
    "degree_centrality",
    "page_rank",
    "betweenness_centrality",
  ]);

  const reordered = analyzeDependencyIntelligence({
    nodes: [...graph().nodes].reverse(),
    edges: [...graph().edges].reverse(),
  });
  assert.deepEqual(reordered, result);
  assert.equal(Object.isFrozen(result.nodes), true);
  assert.equal(Object.isFrozen(result.nodes[0]), true);
});

test("dependency intelligence reports partial package/layer coverage without fabricating cross-boundary counts", () => {
  const result = analyzeDependencyIntelligence({
    nodes: [
      { id: "a", package_id: "one", layer: null },
      { id: "b", package_id: null, layer: "domain" },
      { id: "c", package_id: "two", layer: "storage" },
    ],
    edges: [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ],
  });
  assert.deepEqual(result.aggregates.package_edge_coverage, {
    observed_edges: 0,
    total_edges: 2,
    ratio: 0,
  });
  assert.equal(result.aggregates.cross_package_edge_count, 0);
  assert.deepEqual(result.aggregates.layer_edge_coverage, {
    observed_edges: 1,
    total_edges: 2,
    ratio: 0.5,
  });
  assert.equal(result.aggregates.cross_layer_edge_count, 1);
});

test("dependency intelligence projects named algorithms and bounded module metrics", () => {
  const result = analyzeDependencyIntelligence(graph());
  const projected = projectDependencyEvidence({
    result,
    graph_id: "tsjs",
    graph_completeness: 1,
    repository_revision: "a".repeat(40),
    configuration_hash: "b".repeat(64),
    history_window: { kind: "revision", start: null, end: "a".repeat(40) },
  });
  assert.equal(projected.collectors[0].collector_id, "dependency-intelligence-tsjs");
  assert.equal(projected.metrics.find((metric) => metric.metric_id === "static.dependency.page_rank:tsjs:pkg-b/c").value > 0, true);
  assert.equal(projected.metrics.find((metric) => metric.metric_id === "static.dependency.betweenness:tsjs:pkg-a/b").value, 0.16666667);
  assert.equal(projected.high_connectivity_modules.length <= 15, true);
  assert.equal(Object.isFrozen(projected), true);
});

test("partial dependency graphs degrade projected evidence and preserve bounded confidence", () => {
  const projected = projectDependencyEvidence({
    result: analyzeDependencyIntelligence(graph()),
    graph_id: "tsjs",
    graph_completeness: 0.5,
    repository_revision: "a".repeat(40),
    configuration_hash: "b".repeat(64),
    history_window: { kind: "revision", start: null, end: "a".repeat(40) },
  });
  assert.equal(projected.collectors[0].status, "degraded");
  assert.match(projected.collectors[0].reason, /partial dependency graph/i);
  assert.equal(projected.metrics.every((metric) => metric.measurement.completeness === 0.5), true);
  assert.equal(projected.metrics.every((metric) => metric.measurement.confidence === 0.5), true);
  assert.equal(projected.metrics.every((metric) => /partial dependency graph/i.test(metric.measurement.reason)), true);
});

test("large graphs use deterministic sampled Brandes rather than unbounded exact work", () => {
  const nodes = Array.from({ length: 520 }, (_, index) => ({
    id: `n${String(index).padStart(4, "0")}`,
    package_id: `p${Math.floor(index / 20)}`,
    layer: null,
  }));
  const edges = nodes.slice(0, -1).map((node, index) => ({ source: node.id, target: nodes[index + 1].id }));
  const result = analyzeDependencyIntelligence({ nodes, edges });
  assert.deepEqual(result.algorithms.betweenness, {
    algorithm: "sampled-brandes-directed-betweenness@1",
    normalization: "estimated ordered-pair fraction excluding the subject node",
    exact: false,
    source_count: 64,
  });
  assert.equal(result.nodes.length, 520);
  assert.deepEqual(analyzeDependencyIntelligence({ nodes: [...nodes].reverse(), edges: [...edges].reverse() }), result);
});

test("dependency intelligence rejects open, duplicate, oversized, and unbound graph inputs", () => {
  const invalid = [
    { nodes: [], edges: [], surprise: true },
    { nodes: [{ id: "a", package_id: null, layer: null, extra: true }], edges: [] },
    { nodes: [{ id: "a", package_id: null, layer: null }, { id: "a", package_id: null, layer: null }], edges: [] },
    { nodes: [{ id: "a", package_id: null, layer: null }], edges: [{ source: "a", target: "missing" }] },
    { nodes: Array.from({ length: 10_001 }, (_, index) => ({ id: `n${index}`, package_id: null, layer: null })), edges: [] },
  ];
  for (const input of invalid) {
    assert.throws(
      () => analyzeDependencyIntelligence(input),
      (error) => error?.code === "FAIL-DEPENDENCY-INTELLIGENCE",
    );
  }
});
