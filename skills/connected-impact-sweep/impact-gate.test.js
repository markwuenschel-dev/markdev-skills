"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  IMPACT_GATE_SCHEMA_VERSION,
  RevisionGraphCache,
  evaluateImpactGate,
} = require("./impact-gate");
const { createImpactFixture } = require("./test-support/git-impact-fixture");

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "gate-corpus.json"), "utf8"));

test("corpus classifies local, internal, public, migration, and cross-service changes", () => {
  const cache = new RevisionGraphCache();
  for (const fixture of corpus.cases) {
    withFixture(fixture.input, (input) => {
      const result = evaluateImpactGate({ ...input, graphCache: cache });
      assert.equal(result.schema_version, IMPACT_GATE_SCHEMA_VERSION, fixture.id);
      assert.equal(result.level, fixture.expected_level, fixture.id);
      assert.deepEqual(result.reason_codes, fixture.expected_reason_codes, fixture.id);
      assert.deepEqual(result.affected_components, fixture.expected_components, fixture.id);
    });
  }
});

test("multiple files alone never force a full sweep", () => {
  withFixture({
    repository_revision: "rev-internal",
    changes: [
      { path: "src/cache/read.js", component: "cache", signals: [] },
      { path: "src/cache/write.js", component: "cache", signals: [] },
      { path: "src/cache/key.js", component: "cache", signals: [] },
    ],
  }, (input) => {
    const result = evaluateImpactGate(input);
    assert.equal(result.level, "light");
    assert.deepEqual(result.reason_codes, ["INTERNAL_MULTI_FILE"]);
  });
});

test("consequential paths force full impact even when caller signals are empty", () => {
  const cases = [
    ["api/public.ts", "PUBLIC_API_CHANGE"],
    ["src/auth/permissions.js", "AUTHORIZATION_BOUNDARY_CHANGE"],
    ["db/migrations/0042.sql", "MIGRATION_CHANGE"],
    ["contracts/event.proto", "WIRE_SCHEMA_CHANGE"],
    ["src/types/public.d.ts", "EXPORTED_TYPE_CHANGE"],
    ["shared-config/runtime.json", "SHARED_CONFIG_CONTRACT_CHANGE"],
  ];
  for (const [repositoryPath, reason] of cases) {
    withFixture({ repository_revision: "derived", changes: [{ path: repositoryPath, component: "core", signals: [] }] }, (input) => {
      const result = evaluateImpactGate(input);
      assert.equal(result.level, "full", repositoryPath);
      assert(result.reason_codes.includes(reason), repositoryPath);
    });
  }
});

test("semantic authorization changes in generic paths force a full sweep", () => {
  const base = { repository_revision: "semantic-auth", changes: [{ path: "src/server.js", component: "server", signals: [] }] };
  withFixture(base, (input) => {
    const result = evaluateImpactGate(input);
    assert.equal(result.level, "full");
    assert(result.reason_codes.includes("AUTHORIZATION_BOUNDARY_CHANGE"));
    assert.match(result.semantic_patch_set_sha256, /^sha256:[a-f0-9]{64}$/);
  }, { "src/server.js": "function authorizeRequest(user) { return user.permissions.includes('write'); }\n" });
});

test("common language boundary syntax in generic paths cannot be classified as local", () => {
  const cases = [
    ["module-exports", "module.exports = { handleRequest };\n", "PUBLIC_API_CHANGE"],
    ["esm-export-list", "export { handleRequest };\n", "PUBLIC_API_CHANGE"],
    ["java-public-method", "public void endpoint(Request request) { }\n", "PUBLIC_API_CHANGE"],
    ["camel-case-admin-check", "if (!user.isAdmin) { throw new Error('denied'); }\n", "AUTHORIZATION_BOUNDARY_CHANGE"],
  ];
  for (const [id, source, reason] of cases) {
    withFixture({ repository_revision: id, changes: [{ path: `src/${id}.txt`, component: "server", signals: [] }] }, (input) => {
      const result = evaluateImpactGate(input);
      assert.equal(result.level, "full", id);
      assert(result.reason_codes.includes(reason), id);
    }, { [`src/${id}.txt`]: source });
  }
});

test("unrecognized boundary-like syntax fails conservative to a full sweep", () => {
  withFixture({ repository_revision: "unknown-boundary", changes: [{ path: "src/opaque.txt", component: "server", signals: [] }] }, (input) => {
    const result = evaluateImpactGate(input);
    assert.equal(result.level, "full");
    assert(result.reason_codes.includes("SEMANTIC_BOUNDARY_UNKNOWN"));
  }, { "src/opaque.txt": "public boundaryMarker = opaque;\n" });
});

test("caller-only signals are rejected instead of being self-attested", () => {
  const change = { path: "src/local.js", component: "core", signals: ["public-api"] };
  withFixture({ repository_revision: "derived-only", changes: [change] }, (input) => assert.throws(() => evaluateImpactGate(input), /FAIL-IMPACT-SIGNAL-UNDERIVED/));
  withFixture({ repository_revision: "derived-only", changes: [{ path: "api/public.ts", component: "api", signals: ["public-api"] }] }, (input) => assert.equal(evaluateImpactGate(input).level, "full"));
});

test("impact paths use the shared canonical repository identity", () => {
  withFixture({ repository_revision: "paths", changes: [{ path: "src/safe.js", component: "x", signals: [] }] }, (input) => {
    for (const value of ["../outside", "/etc/passwd", "C:/Windows/System32", "src//x", "src/./x"]) {
      assert.throws(() => evaluateImpactGate({ ...input, changes: [{ path: value, component: "x", signals: [] }] }), /FAIL-IMPACT-GATE-INPUT/);
    }
    assert.throws(() => evaluateImpactGate({ ...input, changes: [
      { path: "src/X.js", component: "x", signals: [] }, { path: "src/x.js", component: "x", signals: [] },
    ] }), /FAIL-IMPACT-GATE-INPUT|FAIL-IMPACT-CHANGESET-DRIFT/);
  });
});

test("revision graph cache reuses identical graphs and rejects revision drift", () => {
  const cache = new RevisionGraphCache();
  const graph = { nodes: ["api", "worker"], edges: [{ from: "api", to: "worker" }] };
  withFixture({
    repository_revision: "abc123",
    changes: [{ path: "api/public.ts", component: "api", signals: ["public-api"] }],
    dependency_graph: graph,
    graphCache: cache,
  }, (input) => {
    const first = evaluateImpactGate({ ...input, graphCache: cache });
    const second = evaluateImpactGate({ ...input, graphCache: cache });
    assert.equal(first.graph_cache.cache_hit, false);
    assert.equal(second.graph_cache.cache_hit, true);
    assert.throws(() => evaluateImpactGate({ ...input, dependency_graph: { nodes: ["api", "other"], edges: [] }, graphCache: cache }), /FAIL-IMPACT-GRAPH-DRIFT/);
  });
});

test("explicit invocation forces full without fabricating another risk signal", () => {
  withFixture({
    repository_revision: "explicit",
    explicit_request: true,
    changes: [{ path: "src/local.js", component: "core", signals: [] }],
  }, (input) => {
    const result = evaluateImpactGate(input);
    assert.equal(result.level, "full");
    assert.deepEqual(result.reason_codes, ["EXPLICIT_REQUEST"]);
  });
});

test("gate rejects unknown signals and unbound graph revisions", () => {
  withFixture({ repository_revision: "x", changes: [{ path: "x", component: "x", signals: [] }] }, (input) => {
    assert.throws(() => evaluateImpactGate({ ...input, changes: [{ path: "x", component: "x", signals: ["mystery"] }] }), /FAIL-IMPACT-GATE-INPUT/);
    assert.throws(() => evaluateImpactGate({ ...input, dependency_graph: { repository_revision: "0".repeat(40), nodes: ["x"], edges: [] } }), /FAIL-IMPACT-GRAPH-REVISION/);
  });
});

test("gate rejects malformed collection shapes with its structured input code", () => {
  const base = {
    repository_revision: "shape",
    changes: [{ path: "src/local.js", component: "core", signals: [] }],
  };
  withFixture(base, (bound) => {
    for (const input of [
      { ...bound, dependency_graph: { nodes: "core", edges: [] } },
      { ...bound, dependency_graph: { nodes: [], edges: { from: "core", to: "api" } } },
      { ...bound, changes: [{ ...bound.changes[0], signals: "public-api" }] },
      { ...bound, changes: [{ ...bound.changes[0], deployable_units: "api" }] },
    ]) assert.throws(() => evaluateImpactGate(input), (error) => error?.code === "FAIL-IMPACT-GATE-INPUT");
  });
});

function withFixture(input, callback, contentByPath = {}) {
  const fixture = createImpactFixture(input, contentByPath);
  try { return callback(fixture.input); }
  finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}
