"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const expected = require("./fixtures/dependency-invalidation/expected.json");
const fixtures = require("./fixtures/dependency-invalidation/scenarios.js");
const invalidation = require("./dependency-invalidation.js");

const PRIVATE = Symbol.for("sei.dependency-invalidation.private@1");

function trusted(prior, current, relationship = "strict-ancestor") {
  return invalidation[PRIVATE].createTrustedAncestryBinding({
    priorRepositoryIndex: prior.repositoryIndex,
    currentRepositoryIndex: current.repositoryIndex,
    relationship,
    evidenceDigest: fixtures.sha256(`git-ancestry:${prior.repositoryIndex.binding.repository_revision}:${current.repositoryIndex.binding.repository_revision}:${relationship}`),
  });
}

function plan(pair, ancestryBinding = trusted(pair.prior, pair.current)) {
  return invalidation.planDependencyInvalidation({
    prior: pair.prior,
    current: pair.current,
    ancestryBinding,
  });
}

function ids(records) {
  return records.map((record) => record.record_id);
}

function nodeIds(records) {
  return records.map((record) => record.node_id);
}

test("public seam is closed and returns a frozen, canonical, digest-bound incremental plan", () => {
  assert.deepEqual(Object.keys(invalidation), [
    "DEPENDENCY_INVALIDATION_VERSION",
    "planDependencyInvalidation",
  ]);
  assert.equal(invalidation.DEPENDENCY_INVALIDATION_VERSION, expected.planner_version);
  const pair = fixtures.pair("isolated");
  const result = plan(pair);

  assert.equal(result.schema_version, expected.planner_version);
  assert.equal(result.status, "incremental");
  assert.deepEqual(result.limits, expected.hard_limits);
  assert.match(result.plan_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.parse(JSON.stringify(result)).plan_digest, result.plan_digest);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.path_changes.changed), true);
  assert.throws(() => invalidation.planDependencyInvalidation({
    prior: pair.prior,
    current: pair.current,
    ancestryBinding: trusted(pair.prior, pair.current),
    surprise: true,
  }), (error) => error?.code === "FAIL-DEPENDENCY-INVALIDATION");
});

test("portable dependency snapshots round-trip without repository blob authority", async () => {
  const pair = fixtures.pair("shared");
  const priorPortable = invalidation[PRIVATE].portableSnapshot(pair.prior);
  const currentPortable = invalidation[PRIVATE].portableSnapshot(pair.current);
  assert.equal(priorPortable.schema_version, "sei.dependency-invalidation-snapshot@1");
  assert.deepEqual(Object.keys(priorPortable.repository_index), ["binding", "entries", "exclusions"]);
  assert.equal(JSON.stringify(priorPortable).includes("readBlobs"), false);

  const prior = invalidation[PRIVATE].rehydratePortableSnapshot(priorPortable);
  const current = invalidation[PRIVATE].rehydratePortableSnapshot(currentPortable);
  const replay = plan({ prior, current }, trusted(prior, current));
  assert.deepEqual(replay.path_changes, plan(pair).path_changes);
  assert.deepEqual(nodeIds(replay.affected_dependency_nodes), ["api", "app", "shared"]);
  await assert.rejects(prior.repositoryIndex.readBlobs(), /does not expose repository blobs/);
});

test("content OID equality is authoritative and leaf versus shared changes invalidate only exact reverse dependents", () => {
  const sameContent = fixtures.pair("config-drift");
  const samePlan = plan({
    prior: sameContent.prior,
    current: fixtures.deepFreeze({
      ...sameContent.current,
      analyzers: sameContent.prior.analyzers,
    }),
  });
  assert.deepEqual(samePlan.path_changes, {
    status: "verified",
    added: [],
    changed: [],
    deleted: [],
    renamed: [],
    uncertain_renames: [],
  });

  const isolated = plan(fixtures.pair("isolated"));
  assert.deepEqual(isolated.path_changes.changed, ["src/isolated.js"]);
  assert.deepEqual(nodeIds(isolated.affected_dependency_nodes), ["isolated"]);
  assert.equal(ids(isolated.directly_invalidated_analyzer_records).includes("file:src/isolated.js"), true);
  assert.equal(ids(isolated.affected_dependency_analyzer_records).includes("node:api"), false);

  const nonNodePaths = Object.keys(fixtures.BASE_FILES).filter((filePath) => filePath !== "src/isolated.js");
  const nonNodePair = fixtures.pair("isolated", {
    prior: { facts: { paths: nonNodePaths } },
    current: { facts: { paths: nonNodePaths } },
  });
  const nonNode = plan(nonNodePair);
  assert.equal(nonNode.affected_dependency_nodes.length, 0);
  assert.equal(ids(nonNode.directly_invalidated_analyzer_records).includes("file:src/isolated.js"), true);
  assert.equal(ids(nonNode.affected_dependency_analyzer_records).includes("global:repository"), true);
  assert.equal(nonNode.global_aggregates_requiring_recompute.length, 1);

  const leaf = plan(fixtures.pair("leaf"));
  assert.deepEqual(leaf.path_changes.changed, ["src/leaf.py"]);
  assert.deepEqual(nodeIds(leaf.affected_dependency_nodes), ["api", "app", "leaf", "shared"]);

  const shared = plan(fixtures.pair("shared"));
  assert.deepEqual(shared.path_changes.changed, ["src/shared.py"]);
  assert.deepEqual(nodeIds(shared.affected_dependency_nodes), ["api", "app", "shared"]);
  const app = shared.affected_dependency_nodes.find((node) => node.node_id === "app");
  assert.deepEqual(app.reason_chain.map((reason) => reason.kind), [
    "changed-content",
    "reverse-dependency",
    "reverse-dependency",
  ]);
  assert.deepEqual(app.reason_chain.slice(1).map((reason) => [reason.source_node_id, reason.target_node_id]), [
    ["api", "shared"],
    ["app", "api"],
  ]);
  assert.equal(ids(shared.affected_dependency_analyzer_records).includes("node:api"), true);
  assert.equal(ids(shared.affected_dependency_analyzer_records).includes("node:app"), true);
  assert.equal(ids(shared.unaffected_reusable_analyzer_records).includes("file:src/app.ts"), true);
  assert.equal(shared.topology_aggregates_requiring_recompute.length, 1);
});

test("unique OID renames and deletion use current and prior graphs without guessing path identity", () => {
  const renamed = plan(fixtures.pair("rename"));
  assert.deepEqual(renamed.path_changes.added, []);
  assert.deepEqual(renamed.path_changes.deleted, []);
  assert.deepEqual(renamed.path_changes.renamed, [{
    content_key: renamed.path_changes.renamed[0].content_key,
    from: "src/shared.py",
    to: "src/common.py",
  }]);
  assert.deepEqual(nodeIds(renamed.affected_dependency_nodes), ["api", "app", "common", "shared"]);
  assert.equal(renamed.dependency_partitions[0].mode, "incremental");

  const deleted = plan(fixtures.pair("delete"));
  assert.deepEqual(deleted.path_changes.deleted, ["src/leaf.py"]);
  assert.deepEqual(nodeIds(deleted.affected_dependency_nodes), ["api", "app", "leaf", "shared"]);
  const shared = deleted.affected_dependency_nodes.find((node) => node.node_id === "shared");
  assert.deepEqual(shared.revision_sides, ["prior"]);
  assert.equal(ids(deleted.directly_invalidated_analyzer_records).includes("file:src/leaf.py"), true);

  const ambiguous = plan(fixtures.pair("ambiguous-rename"));
  assert.equal(ambiguous.path_changes.status, "uncertain");
  assert.deepEqual(ambiguous.path_changes.uncertain_renames.map((item) => ({
    added_paths: item.added_paths,
    deleted_paths: item.deleted_paths,
  })), [{
    added_paths: ["src/duplicate-c.ts"],
    deleted_paths: ["src/duplicate-a.ts"],
  }]);
  assert.equal(ambiguous.status, "full-recompute");
  assert.equal(ambiguous.dependency_partitions[0].reasons.includes("path-identity-uncertain"), true);
});

test("analyzer configuration drift and unknown dynamic dependencies force explicit partition recomputation", () => {
  const drift = plan(fixtures.pair("config-drift"));
  assert.equal(drift.status, "full-recompute");
  assert.equal(drift.dependency_partitions[0].mode, "full-recompute");
  assert.equal(drift.dependency_partitions[0].reasons.includes("producer-analyzer-binding-drift"), true);
  assert.equal(drift.unaffected_reusable_analyzer_records.length, 0);
  assert.equal(drift.directly_invalidated_analyzer_records.length, drift.bindings.current.record_count);

  const dynamic = plan(fixtures.pair("dynamic"));
  assert.equal(dynamic.status, "full-recompute");
  assert.equal(dynamic.dependency_partitions[0].reasons.includes("uncertain-dependency-edge"), true);
  assert.equal(dynamic.unaffected_reusable_analyzer_records.length, 0);

  const withSecondaryProducer = (snapshot, configurationHash) => fixtures.deepFreeze({
    ...snapshot,
    dependencyFacts: fixtures.deepFreeze({
      ...snapshot.dependencyFacts,
      partitions: snapshot.dependencyFacts.partitions.map((partition) => fixtures.deepFreeze({
        ...partition,
        producer_analyzer_ids: fixtures.deepFreeze([fixtures.ANALYZER_ID, "tsjs-static"]),
      })),
    }),
    analyzers: fixtures.deepFreeze([...snapshot.analyzers, fixtures.deepFreeze({
      analyzer_id: "tsjs-static",
      analyzer_identity: "sei.tsjs-static@1",
      analyzer_version: "1.0.0",
      configuration_hash: configurationHash,
      records: fixtures.deepFreeze([]),
    })]),
  });
  const multiBase = fixtures.pair("isolated");
  const multi = {
    prior: withSecondaryProducer(multiBase.prior, fixtures.sha256("tsjs:v1")),
    current: withSecondaryProducer(multiBase.current, fixtures.sha256("tsjs:v2")),
  };
  const multiProducerDrift = plan(multi, trusted(multi.prior, multi.current));
  assert.equal(multiProducerDrift.dependency_partitions[0].reasons.includes("producer-analyzer-binding-drift"), true);
});

test("corrupt prior state and caller-claimed ancestry degrade to a deterministic conservative plan", () => {
  const pair = fixtures.pair("shared");
  const ancestryBinding = trusted(pair.prior, pair.current);
  const corruptIndex = fixtures.deepFreeze({
    ...pair.prior.repositoryIndex,
    binding: fixtures.deepFreeze({ ...pair.prior.repositoryIndex.binding, index_digest: fixtures.sha256("tampered") }),
  });
  const corruptPrior = fixtures.deepFreeze({ ...pair.prior, repositoryIndex: corruptIndex });
  const corrupt = plan({ prior: corruptPrior, current: pair.current }, ancestryBinding);
  assert.equal(corrupt.status, "full-recompute");
  assert.equal(corrupt.path_changes.status, "unverifiable");
  assert.equal(corrupt.fallback_reasons.includes("prior-state-invalid"), true);
  assert.equal(corrupt.unaffected_reusable_analyzer_records.length, 0);

  const copiedClaim = fixtures.deepFreeze({ ...ancestryBinding });
  const untrusted = plan(pair, copiedClaim);
  assert.equal(untrusted.status, "full-recompute");
  assert.equal(untrusted.ancestry.status, "unverified");
  assert.equal(untrusted.fallback_reasons.includes("ancestry-binding-untrusted"), true);

  const emptySnapshot = (snapshot) => fixtures.deepFreeze({
    repositoryIndex: snapshot.repositoryIndex,
    dependencyFacts: fixtures.deepFreeze({
      ...snapshot.dependencyFacts,
      partitions: fixtures.deepFreeze([]),
    }),
    analyzers: fixtures.deepFreeze([]),
  });
  const empty = { prior: emptySnapshot(pair.prior), current: emptySnapshot(pair.current) };
  const emptyFallback = plan(empty, null);
  assert.equal(emptyFallback.status, "full-recompute");
  assert.equal(emptyFallback.fallback_reasons.includes("ancestry-binding-untrusted"), true);
});

test("cycles terminate with bounded reason chains and input ordering cannot change bytes or digest", () => {
  const cyclePair = fixtures.pair("shared");
  const currentFiles = { ...fixtures.BASE_FILES, "src/cycle-a.ts": "export const a = () => b() + 1;\n" };
  const current = fixtures.snapshot("cycle:current", currentFiles, fixtures.BASE_EDGES);
  const cycles = plan({ prior: cyclePair.prior, current }, trusted(cyclePair.prior, current));
  const cycleNodes = cycles.affected_dependency_nodes.filter((node) => node.node_id.startsWith("cycle-"));
  assert.deepEqual(nodeIds(cycleNodes), ["cycle-a", "cycle-b"]);
  assert.equal(cycleNodes.every((node) => node.reason_chain.length <= expected.hard_limits.max_reason_depth + 1), true);

  const pair = fixtures.pair("shared");
  const first = plan(pair);
  const reorderedPair = {
    prior: fixtures.reordered(pair.prior),
    current: fixtures.reordered(pair.current),
  };
  const second = plan(reorderedPair, trusted(reorderedPair.prior, reorderedPair.current));
  assert.deepEqual(second, first);
  assert.equal(second.plan_digest, first.plan_digest);
});

test("reason-depth and fixed input bounds fail closed without caller-controlled limits", () => {
  const files = {};
  const edges = [];
  for (let index = 0; index < 67; index += 1) {
    const filePath = `src/n${String(index).padStart(2, "0")}.ts`;
    files[filePath] = `export const n${index} = ${index};\n`;
    if (index > 0) edges.push({
      source: `src/n${String(index - 1).padStart(2, "0")}.ts`,
      target: filePath,
    });
  }
  const prior = fixtures.snapshot("depth:prior", files, edges);
  files["src/n66.ts"] = "export const n66 = 999;\n";
  const current = fixtures.snapshot("depth:current", files, edges);
  const depth = plan({ prior, current }, trusted(prior, current));
  assert.equal(depth.status, "full-recompute");
  assert.equal(depth.dependency_partitions[0].reasons.includes("reason-depth-exceeded"), true);

  const pair = fixtures.pair("isolated");
  const partitions = Array.from({ length: expected.hard_limits.max_partitions + 1 }, (_, index) => fixtures.deepFreeze({
    ...pair.current.dependencyFacts.partitions[0],
    partition_id: `p:${String(index).padStart(3, "0")}`,
    nodes: [],
    edges: [],
  }));
  const oversizedFacts = fixtures.deepFreeze({ ...pair.current.dependencyFacts, partitions });
  const oversizedCurrent = fixtures.deepFreeze({ ...pair.current, dependencyFacts: oversizedFacts });
  assert.throws(
    () => plan({ prior: pair.prior, current: oversizedCurrent }, trusted(pair.prior, oversizedCurrent)),
    (error) => error?.code === "FAIL-DEPENDENCY-INVALIDATION" && /max_partitions/.test(error.message),
  );
});
