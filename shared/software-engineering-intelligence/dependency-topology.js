"use strict";

const crypto = require("node:crypto");

const DEPENDENCY_TOPOLOGY_VERSION = "sei.dependency-topology@1";
const SCC_IDENTITY_VERSION = "sei.python-scc@1";
const CENTRALITY_UNAVAILABLE_REASON = "FAIL-DEPENDENCY-TOPOLOGY-UNSUPPORTED-METRIC: no named centrality algorithm is defined";
const NOT_APPLICABLE_DENSITY_REASON = "FAIL-DEPENDENCY-TOPOLOGY-NOT-APPLICABLE: density requires at least two nodes";
const NOT_APPLICABLE_INSTABILITY_REASON = "FAIL-DEPENDENCY-TOPOLOGY-NOT-APPLICABLE: instability requires at least one non-self dependency";

function fail(detail) {
  const error = new Error(`FAIL-DEPENDENCY-TOPOLOGY: ${detail}`);
  error.code = "FAIL-DEPENDENCY-TOPOLOGY";
  throw error;
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClosedRecord(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key)).sort(stableCompare);
  if (unexpected.length > 0) fail(`${label}.${unexpected[0]} is not declared`);
}

function validNodeId(value) {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\u0000");
}

function roundRatio(numerator, denominator) {
  return Number((numerator / denominator).toFixed(8));
}

function sccIdentity(members) {
  const bytes = `${SCC_IDENTITY_VERSION}\u0000${members.join("\u0000")}`;
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function compareMemberLists(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = stableCompare(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function stronglyConnectedComponents(nodeIds, adjacency) {
  let nextIndex = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const componentStack = [];
  const onComponentStack = new Set();
  const components = [];

  for (const root of nodeIds) {
    if (indices.has(root)) continue;
    const traversal = [{ node: root, parent: null, nextTarget: 0, entered: false }];
    while (traversal.length > 0) {
      const frame = traversal[traversal.length - 1];
      if (!frame.entered) {
        frame.entered = true;
        indices.set(frame.node, nextIndex);
        lowlinks.set(frame.node, nextIndex);
        nextIndex += 1;
        componentStack.push(frame.node);
        onComponentStack.add(frame.node);
      }

      const targets = adjacency.get(frame.node);
      if (frame.nextTarget < targets.length) {
        const target = targets[frame.nextTarget];
        frame.nextTarget += 1;
        if (!indices.has(target)) {
          traversal.push({ node: target, parent: frame.node, nextTarget: 0, entered: false });
        } else if (onComponentStack.has(target)) {
          lowlinks.set(frame.node, Math.min(lowlinks.get(frame.node), indices.get(target)));
        }
        continue;
      }

      traversal.pop();
      if (frame.parent !== null) {
        lowlinks.set(frame.parent, Math.min(lowlinks.get(frame.parent), lowlinks.get(frame.node)));
      }
      if (lowlinks.get(frame.node) !== indices.get(frame.node)) continue;

      const members = [];
      let member;
      do {
        member = componentStack.pop();
        onComponentStack.delete(member);
        members.push(member);
      } while (member !== frame.node);
      components.push(members.sort(stableCompare));
    }
  }

  return components.sort(compareMemberLists);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function reduceDependencyTopology(input) {
  assertClosedRecord(input, ["nodes", "edges"], "dependency topology input");
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    fail("nodes and edges must be arrays");
  }

  const nodeIds = [];
  const knownNodes = new Set();
  for (const node of input.nodes) {
    assertClosedRecord(node, ["id"], "dependency topology node");
    if (!validNodeId(node.id)) fail("node IDs must be nonblank strings without null bytes");
    if (knownNodes.has(node.id)) fail(`duplicate node ID ${JSON.stringify(node.id)}`);
    knownNodes.add(node.id);
    nodeIds.push(node.id);
  }
  nodeIds.sort(stableCompare);

  const adjacencySets = new Map(nodeIds.map((id) => [id, new Set()]));
  const inboundFanSets = new Map(nodeIds.map((id) => [id, new Set()]));
  const outboundFanSets = new Map(nodeIds.map((id) => [id, new Set()]));
  const selfEdges = new Set();
  const edgeIdentities = new Set();
  let nonSelfEdgeCount = 0;

  for (const edge of input.edges) {
    assertClosedRecord(edge, ["source", "target"], "dependency topology edge");
    if (!validNodeId(edge.source) || !validNodeId(edge.target)) {
      fail("edge source and target must be nonblank strings without null bytes");
    }
    if (!knownNodes.has(edge.source) || !knownNodes.has(edge.target)) {
      fail(`edge ${JSON.stringify(edge.source)} -> ${JSON.stringify(edge.target)} must bind declared nodes`);
    }
    const identity = JSON.stringify([edge.source, edge.target]);
    if (edgeIdentities.has(identity)) {
      fail(`duplicate edge ${JSON.stringify(edge.source)} -> ${JSON.stringify(edge.target)}`);
    }
    edgeIdentities.add(identity);
    adjacencySets.get(edge.source).add(edge.target);
    if (edge.source === edge.target) {
      selfEdges.add(edge.source);
    } else {
      nonSelfEdgeCount += 1;
      outboundFanSets.get(edge.source).add(edge.target);
      inboundFanSets.get(edge.target).add(edge.source);
    }
  }

  const adjacency = new Map(nodeIds.map((id) => [id, [...adjacencySets.get(id)].sort(stableCompare)]));
  const componentMembers = stronglyConnectedComponents(nodeIds, adjacency);
  const stronglyConnected = componentMembers.map((members) => ({
    scc_id: sccIdentity(members),
    members,
    cyclic: members.length > 1 || selfEdges.has(members[0]),
  }));

  const nodes = nodeIds.map((id) => {
    const inbound = [...inboundFanSets.get(id)].sort(stableCompare);
    const outbound = [...outboundFanSets.get(id)].sort(stableCompare);
    const numerator = outbound.length;
    const denominator = inbound.length + outbound.length;
    return {
      id,
      inbound_neighbors: inbound,
      outbound_neighbors: outbound,
      fan_in: inbound.length,
      fan_out: outbound.length,
      instability: denominator === 0
        ? {
            status: "not-applicable",
            numerator: 0,
            denominator: null,
            value: null,
            reason: NOT_APPLICABLE_INSTABILITY_REASON,
          }
        : {
            status: "measured",
            numerator,
            denominator,
            value: roundRatio(numerator, denominator),
            reason: null,
          },
    };
  });

  const densityDenominator = nodeIds.length < 2 ? null : nodeIds.length * (nodeIds.length - 1);
  const density = densityDenominator === null
    ? {
        status: "not-applicable",
        numerator: nonSelfEdgeCount,
        denominator: null,
        value: null,
        reason: NOT_APPLICABLE_DENSITY_REASON,
      }
    : {
        status: "measured",
        numerator: nonSelfEdgeCount,
        denominator: densityDenominator,
        value: roundRatio(nonSelfEdgeCount, densityDenominator),
        reason: null,
      };
  const cyclicComponents = stronglyConnected.filter((component) => component.cyclic);

  return deepFreeze({
    reducer_version: DEPENDENCY_TOPOLOGY_VERSION,
    aggregates: {
      node_count: nodeIds.length,
      edge_count: edgeIdentities.size,
      non_self_edge_count: nonSelfEdgeCount,
      scc_count: stronglyConnected.length,
      cyclic_scc_count: cyclicComponents.length,
      cyclic_node_count: cyclicComponents.reduce((count, component) => count + component.members.length, 0),
      max_fan_in: Math.max(0, ...nodes.map((node) => node.fan_in)),
      max_fan_out: Math.max(0, ...nodes.map((node) => node.fan_out)),
      density,
      centrality: {
        status: "unavailable",
        value: null,
        reason: CENTRALITY_UNAVAILABLE_REASON,
      },
    },
    nodes,
    strongly_connected_components: stronglyConnected,
  });
}

module.exports = {
  DEPENDENCY_TOPOLOGY_VERSION,
  reduceDependencyTopology,
};
