"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEPENDENCY_TOPOLOGY_VERSION,
  reduceDependencyTopology,
} = require("./dependency-topology.js");

test("dependency topology reduces a directed graph to deterministic SCC, fan, density, and instability facts", () => {
  const graph = {
    nodes: [{ id: "d" }, { id: "c" }, { id: "b" }, { id: "a" }],
    edges: [
      { source: "d", target: "c" },
      { source: "c", target: "a" },
      { source: "b", target: "c" },
      { source: "a", target: "b" },
    ],
  };

  const result = reduceDependencyTopology(graph);

  assert.equal(DEPENDENCY_TOPOLOGY_VERSION, "sei.dependency-topology@1");
  assert.deepEqual(result.aggregates, {
    node_count: 4,
    edge_count: 4,
    non_self_edge_count: 4,
    scc_count: 2,
    cyclic_scc_count: 1,
    cyclic_node_count: 3,
    max_fan_in: 2,
    max_fan_out: 1,
    density: {
      status: "measured",
      numerator: 4,
      denominator: 12,
      value: 0.33333333,
      reason: null,
    },
    centrality: {
      status: "unavailable",
      value: null,
      reason: "FAIL-DEPENDENCY-TOPOLOGY-UNSUPPORTED-METRIC: no named centrality algorithm is defined",
    },
  });
  assert.deepEqual(result.nodes, [
    {
      id: "a",
      inbound_neighbors: ["c"],
      outbound_neighbors: ["b"],
      fan_in: 1,
      fan_out: 1,
      instability: { status: "measured", numerator: 1, denominator: 2, value: 0.5, reason: null },
    },
    {
      id: "b",
      inbound_neighbors: ["a"],
      outbound_neighbors: ["c"],
      fan_in: 1,
      fan_out: 1,
      instability: { status: "measured", numerator: 1, denominator: 2, value: 0.5, reason: null },
    },
    {
      id: "c",
      inbound_neighbors: ["b", "d"],
      outbound_neighbors: ["a"],
      fan_in: 2,
      fan_out: 1,
      instability: { status: "measured", numerator: 1, denominator: 3, value: 0.33333333, reason: null },
    },
    {
      id: "d",
      inbound_neighbors: [],
      outbound_neighbors: ["c"],
      fan_in: 0,
      fan_out: 1,
      instability: { status: "measured", numerator: 1, denominator: 1, value: 1, reason: null },
    },
  ]);
  assert.deepEqual(result.strongly_connected_components, [
    {
      scc_id: "sha256:515777d4d1ab9c16d0cf85d734971e1ed7ab5a614fd507f421946e3267b775a3",
      members: ["a", "b", "c"],
      cyclic: true,
    },
    {
      scc_id: "sha256:98f9deb2ab4998294566a1039894e4328b373f039bb25c378977a29248c9a28b",
      members: ["d"],
      cyclic: false,
    },
  ]);

  const reordered = reduceDependencyTopology({
    nodes: [...graph.nodes].reverse(),
    edges: [...graph.edges].reverse(),
  });
  assert.deepEqual(reordered, result);
});

test("self loops prove cycles without inflating unique-neighbor fan values", () => {
  const result = reduceDependencyTopology({
    nodes: [{ id: "solo" }],
    edges: [{ source: "solo", target: "solo" }],
  });

  assert.deepEqual(result.aggregates, {
    node_count: 1,
    edge_count: 1,
    non_self_edge_count: 0,
    scc_count: 1,
    cyclic_scc_count: 1,
    cyclic_node_count: 1,
    max_fan_in: 0,
    max_fan_out: 0,
    density: {
      status: "not-applicable",
      numerator: 0,
      denominator: null,
      value: null,
      reason: "FAIL-DEPENDENCY-TOPOLOGY-NOT-APPLICABLE: density requires at least two nodes",
    },
    centrality: {
      status: "unavailable",
      value: null,
      reason: "FAIL-DEPENDENCY-TOPOLOGY-UNSUPPORTED-METRIC: no named centrality algorithm is defined",
    },
  });
  assert.deepEqual(result.nodes, [{
    id: "solo",
    inbound_neighbors: [],
    outbound_neighbors: [],
    fan_in: 0,
    fan_out: 0,
    instability: {
      status: "not-applicable",
      numerator: 0,
      denominator: null,
      value: null,
      reason: "FAIL-DEPENDENCY-TOPOLOGY-NOT-APPLICABLE: instability requires at least one non-self dependency",
    },
  }]);
  assert.deepEqual(result.strongly_connected_components, [{
    scc_id: "sha256:1b24c6760c7f000a3f9386d2acfcb62aed341b448f0434213824c423c3a98d3a",
    members: ["solo"],
    cyclic: true,
  }]);
});

test("isolated nodes remain explicit and use not-applicable instability rather than zero", () => {
  const result = reduceDependencyTopology({
    nodes: [{ id: "z" }, { id: "isolated" }],
    edges: [],
  });

  assert.equal(result.aggregates.density.status, "measured");
  assert.equal(result.aggregates.density.value, 0);
  assert.equal(result.aggregates.scc_count, 2);
  assert.equal(result.aggregates.cyclic_scc_count, 0);
  assert.deepEqual(result.nodes.map((node) => [
    node.id,
    node.inbound_neighbors,
    node.outbound_neighbors,
    node.instability.status,
    node.instability.value,
  ]), [
    ["isolated", [], [], "not-applicable", null],
    ["z", [], [], "not-applicable", null],
  ]);
});

test("duplicate graph identities and edges to unknown nodes fail closed", () => {
  const invalidGraphs = [
    {
      label: "duplicate node",
      input: { nodes: [{ id: "a" }, { id: "a" }], edges: [] },
      detail: /duplicate node ID "a"/,
    },
    {
      label: "duplicate edge",
      input: {
        nodes: [{ id: "a" }, { id: "b" }],
        edges: [{ source: "a", target: "b" }, { source: "a", target: "b" }],
      },
      detail: /duplicate edge "a" -> "b"/,
    },
    {
      label: "unknown source",
      input: { nodes: [{ id: "a" }], edges: [{ source: "missing", target: "a" }] },
      detail: /must bind declared nodes/,
    },
    {
      label: "unknown target",
      input: { nodes: [{ id: "a" }], edges: [{ source: "a", target: "missing" }] },
      detail: /must bind declared nodes/,
    },
  ];

  for (const fixture of invalidGraphs) {
    assert.throws(
      () => reduceDependencyTopology(fixture.input),
      (error) => error.code === "FAIL-DEPENDENCY-TOPOLOGY" && fixture.detail.test(error.message),
      fixture.label,
    );
  }
});

test("reducer results are transitively immutable", () => {
  const result = reduceDependencyTopology({
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ source: "a", target: "b" }],
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.aggregates.density), true);
  assert.equal(Object.isFrozen(result.nodes), true);
  assert.equal(Object.isFrozen(result.nodes[0].outbound_neighbors), true);
  assert.equal(Object.isFrozen(result.strongly_connected_components[0].members), true);
  assert.throws(() => result.nodes[0].outbound_neighbors.push("c"), TypeError);
});
