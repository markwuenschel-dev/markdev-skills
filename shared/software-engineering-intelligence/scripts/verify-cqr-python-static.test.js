"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveCollectorConfigurationHash,
  deriveStaticConfigurationHash,
  parseArguments,
  verifyProductArtifacts,
} = require("./verify-cqr-python-static.js");

const REVISION = "a".repeat(40);
const TREE = "b".repeat(40);
const SEI_REVISION = "c".repeat(40);
const INDEX_DIGEST = `sha256:${"d".repeat(64)}`;
const CONFIGURATION_HASH = `sha256:${"e".repeat(64)}`;
const GRAPH_KEY = `sha256:${"f".repeat(64)}`;
const SCC_ID = `sha256:${"1".repeat(64)}`;

function metric(overrides) {
  const commonRefs = [
    `python-analyzer:sei.python-ast@1`,
    `python-configuration:${CONFIGURATION_HASH}`,
    `python-grammar:3.13`,
    `python-graph:${GRAPH_KEY}`,
    `python-runtime:cpython-3.13`,
    `repository-index:${INDEX_DIGEST}`,
  ];
  return {
    metric_id: overrides.metric_id,
    definition_id: overrides.definition_id,
    family: overrides.family,
    subject: overrides.subject ?? "repository:committed-index",
    repository_revision: REVISION,
    value: overrides.value,
    unit: overrides.unit,
    measurement: {
      status: overrides.status ?? "measured",
      completeness: overrides.status === "unavailable" ? 0 : 1,
      confidence: overrides.status === "unavailable" ? 0 : 1,
      reason: overrides.reason ?? null,
    },
    source: {
      kind: "exact-git-python-ast",
      collector_id: "python-static-intelligence",
      collector_version: "1.0.0",
      repository_revision: REVISION,
      command: null,
      artifact_refs: [...commonRefs, ...(overrides.refs ?? [])].sort(),
      evidence_refs: [...commonRefs, ...(overrides.refs ?? [])].sort(),
    },
    scope: overrides.scope ?? {
      kind: "repository",
      path: ".",
      language: "python",
      generated_code: false,
      included_in_human_maintainability: true,
    },
    window: { kind: "revision", start: null, end: REVISION },
    analyzer_identity: "sei.python-ast@1",
    analyzer_version: "sei.python-ast@1",
    comparability: {
      analyzer_identity: "sei.python-ast@1",
      analyzer_version: "sei.python-ast@1",
      configuration_hash: CONFIGURATION_HASH,
      compatible_with_prior: false,
      reason: "no prior analyzer-bound measurement was supplied",
    },
  };
}

function fixture() {
  const aggregate = metric({
    metric_id: "static.python.cyclomatic_complexity:production",
    definition_id: "sei.static.python.cyclomatic_complexity@1",
    family: "structural_complexity",
    value: 12,
    unit: "cyclomatic-complexity-points",
    refs: ["python-partition:production"],
  });
  const cycle = metric({
    metric_id: `static.python.dependency.cyclic_scc_size:production:${SCC_ID}`,
    definition_id: "sei.static.python.dependency.cyclic_scc_size@1",
    family: "dependency_topology",
    subject: `python-scc:${SCC_ID}`,
    value: 2,
    unit: "modules",
    scope: {
      kind: "scc",
      path: ".",
      language: "python",
      generated_code: false,
      included_in_human_maintainability: true,
    },
    refs: [
      `python-scc:${SCC_ID}`,
      "python-scc-member:app.a@pkg/app/a.py",
      "python-scc-member:app.b@pkg/app/b.py",
      "python-import:pkg/app/a.py:4:0->app.b",
      "python-import:pkg/app/b.py:8:2->app.a",
      "python-partition:production",
    ],
  });
  const centrality = metric({
    metric_id: "static.python.dependency.centrality:production",
    definition_id: "sei.static.python.dependency.centrality@1",
    family: "dependency_topology",
    value: null,
    unit: "normalized-centrality",
    status: "unavailable",
    reason: "no named centrality algorithm is defined",
    refs: ["python-partition:production"],
  });
  const snapshot = {
    schema_version: "1.0.0",
    snapshot_id: "sei-v1-test",
    repository: { revision: REVISION },
    collectors: [{
      collector_id: "python-static-intelligence",
      collector_version: "1.0.0",
      status: "available",
      analyzer_identity: "sei.python-ast@1",
      analyzer_version: "sei.python-ast@1",
      reason: null,
    }],
    measurements: [aggregate, centrality, cycle],
  };
  const expected = {
    schema_version: "sei.cqr-python-static-expected@1",
    bindings: {
      cqr_revision: REVISION,
      cqr_root_tree: TREE,
      sei_product_revision: SEI_REVISION,
      repository_index_digest: INDEX_DIGEST,
      repository_classification_policy_version: "sei.repository-classification@2",
      static_configuration_hash: CONFIGURATION_HASH,
      analyzer_version: "sei.python-ast@1",
      parser_runtime: "cpython-3.13",
      grammar_target: [3, 13],
      python_implementation: "cpython",
      python_version: "3.13.7",
      inventory_digest: `sha256:${"2".repeat(64)}`,
    },
    inventory: {
      python_file_count: 3,
      production_file_count: 2,
      test_file_count: 1,
      unique_python_blob_count: 3,
      parsed_file_count: 3,
      parse_failure_count: 0,
    },
    metric_bindings: [
      {
        metric_id: aggregate.metric_id,
        definition_id: aggregate.definition_id,
        subject: aggregate.subject,
        value: aggregate.value,
        unit: aggregate.unit,
        measurement_status: "measured",
        scope: aggregate.scope,
        required_refs: ["python-partition:production"],
      },
      {
        metric_id: cycle.metric_id,
        definition_id: cycle.definition_id,
        subject: cycle.subject,
        value: cycle.value,
        unit: cycle.unit,
        measurement_status: "measured",
        scope: cycle.scope,
        required_refs: cycle.source.artifact_refs.filter((ref) => ref.startsWith("python-scc") || ref.startsWith("python-import")),
      },
    ],
    required_unavailable_metrics: [{
      metric_id: centrality.metric_id,
      definition_id: centrality.definition_id,
      unit: centrality.unit,
      reason_includes: "no named centrality algorithm",
    }],
    required_report_text: [
      "Complexity (language-aware, Python-only)",
      "Dependency topology (Python-only)",
      "Specialized AST coverage: Python only; TypeScript/TSX, JavaScript, Java, and Kotlin are unavailable and deferred.",
    ],
  };
  const report = `<!doctype html><html><body>${expected.required_report_text.join("\n")}<script type="application/json" data-sei-island>${JSON.stringify(snapshot)}</script></body></html>`;
  const performance = {
    python_static_intelligence: {
      status: "available",
      cache_hits: 0,
      recomputed: 4,
      batch_count: 2,
      subprocess_count: 2,
      max_in_flight: 2,
      timeouts: 0,
      cancelled: 0,
      cache: { parse: { hits: 0, misses: 3 }, graph: { hits: 0, misses: 1 } },
    },
  };
  const warmPerformance = structuredClone(performance);
  warmPerformance.python_static_intelligence.cache_hits = 4;
  warmPerformance.python_static_intelligence.recomputed = 0;
  warmPerformance.python_static_intelligence.batch_count = 0;
  warmPerformance.python_static_intelligence.subprocess_count = 0;
  warmPerformance.python_static_intelligence.max_in_flight = 0;
  warmPerformance.python_static_intelligence.cache = { parse: { hits: 3, misses: 0 }, graph: { hits: 1, misses: 0 } };
  return {
    expected,
    snapshotBytes: Buffer.from(`${JSON.stringify(snapshot)}\n`),
    repeatSnapshotBytes: Buffer.from(`${JSON.stringify(snapshot)}\n`),
    reportBytes: Buffer.from(report),
    repeatReportBytes: Buffer.from(report),
    coldPerformance: performance,
    warmPerformance,
    liveBindings: {
      cqr_revision: REVISION,
      cqr_root_tree: TREE,
      sei_product_revision: SEI_REVISION,
      repository_index_digest: INDEX_DIGEST,
      repository_classification_policy_version: "sei.repository-classification@2",
      static_configuration_hash: CONFIGURATION_HASH,
      python_implementation: "cpython",
      python_version: "3.13.7",
      inventory_digest: expected.bindings.inventory_digest,
      inventory: {
        python_file_count: 3,
        production_file_count: 2,
        test_file_count: 1,
        unique_python_blob_count: 3,
      },
      committed_product_hashes: {},
    },
  };
}

test("CQR verifier accepts exact independent literals, provenance, report text, and cold/warm output equality", () => {
  const result = verifyProductArtifacts(fixture());
  assert.equal(result.status, "PASS");
  assert.equal(result.product_verdict, "PASS");
  assert.match(result.canonical_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.cold_snapshot_sha256, result.warm_snapshot_sha256);
  assert.equal(result.cold_report_sha256, result.warm_report_sha256);
});

test("CQR verifier locks the product configuration identity and closed invocation contract", () => {
  assert.equal(
    deriveStaticConfigurationHash(),
    "sha256:c60418175359c90f721d48c2ea16b4ea98f3829ea4d2548accf319d62834fc12",
  );
  assert.equal(
    deriveCollectorConfigurationHash(),
    "c425795cefa3e362fb0d14c880d5545303d7e7bb53e2fec5f658b82eb3a6923c",
  );
  assert.deepEqual(parseArguments([
    "--repo", "C:\\cqr",
    "--revision", REVISION,
    "--expected", "C:\\expected.json",
    "--python", "C:\\Python313\\python.exe",
    "--sei-root", "C:\\sei",
    "--out", "C:\\out",
  ]), {
    repo: "C:\\cqr",
    revision: REVISION,
    expected: "C:\\expected.json",
    python: "C:\\Python313\\python.exe",
    seiRoot: "C:\\sei",
    out: "C:\\out",
  });
  assert.throws(() => parseArguments(["--repo", "C:\\cqr", "--unknown", "x"]), /FAIL-CQR-PYTHON-ORACLE.*unsupported argument/);
});

test("CQR verifier fails closed on every locked identity, literal, source-ref, language-boundary, and determinism negative", async (context) => {
  const cases = [
    ["exact revision", (value) => { value.liveBindings.cqr_revision = "9".repeat(40); }, /live cqr_revision mismatch/],
    ["repository index identity", (value) => {
      const snapshot = JSON.parse(value.snapshotBytes);
      for (const metricValue of snapshot.measurements) {
        metricValue.source.artifact_refs = metricValue.source.artifact_refs.filter((ref) => !ref.startsWith("repository-index:"));
        metricValue.source.evidence_refs = metricValue.source.evidence_refs.filter((ref) => !ref.startsWith("repository-index:"));
      }
      value.snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
      value.repeatSnapshotBytes = Buffer.from(value.snapshotBytes);
      value.reportBytes = Buffer.from(value.reportBytes.toString("utf8").replace(/<script type="application\/json" data-sei-island>[\s\S]*?<\/script>/, `<script type="application/json" data-sei-island>${JSON.stringify(snapshot)}</script>`));
      value.repeatReportBytes = Buffer.from(value.reportBytes);
    }, /lacks artifact ref repository-index:/],
    ["analyzer identity", (value) => {
      const snapshot = JSON.parse(value.snapshotBytes);
      snapshot.collectors[0].analyzer_identity = "sei.python-ast@2";
      value.snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
      value.repeatSnapshotBytes = Buffer.from(value.snapshotBytes);
      value.reportBytes = Buffer.from(value.reportBytes.toString("utf8").replace(/<script type="application\/json" data-sei-island>[\s\S]*?<\/script>/, `<script type="application/json" data-sei-island>${JSON.stringify(snapshot)}</script>`));
      value.repeatReportBytes = Buffer.from(value.reportBytes);
    }, /collector analyzer identity mismatch/],
    ["configuration identity", (value) => {
      const snapshot = JSON.parse(value.snapshotBytes);
      snapshot.measurements[0].comparability.configuration_hash = `sha256:${"0".repeat(64)}`;
      value.snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
      value.repeatSnapshotBytes = Buffer.from(value.snapshotBytes);
      value.reportBytes = Buffer.from(value.reportBytes.toString("utf8").replace(/<script type="application\/json" data-sei-island>[\s\S]*?<\/script>/, `<script type="application/json" data-sei-island>${JSON.stringify(snapshot)}</script>`));
      value.repeatReportBytes = Buffer.from(value.reportBytes);
    }, /comparability\.configuration_hash mismatch/],
    ["runtime identity", (value) => {
      const snapshot = JSON.parse(value.snapshotBytes);
      for (const metricValue of snapshot.measurements) {
        metricValue.source.artifact_refs = metricValue.source.artifact_refs.filter((ref) => !ref.startsWith("python-runtime:"));
        metricValue.source.evidence_refs = metricValue.source.evidence_refs.filter((ref) => !ref.startsWith("python-runtime:"));
      }
      value.snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
      value.repeatSnapshotBytes = Buffer.from(value.snapshotBytes);
      value.reportBytes = Buffer.from(value.reportBytes.toString("utf8").replace(/<script type="application\/json" data-sei-island>[\s\S]*?<\/script>/, `<script type="application/json" data-sei-island>${JSON.stringify(snapshot)}</script>`));
      value.repeatReportBytes = Buffer.from(value.reportBytes);
    }, /lacks artifact ref python-runtime:/],
    ["changed literal", (value) => {
      const snapshot = JSON.parse(value.snapshotBytes);
      snapshot.measurements.find((entry) => entry.metric_id === "static.python.cyclomatic_complexity:production").value = 13;
      value.snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
      value.repeatSnapshotBytes = Buffer.from(value.snapshotBytes);
      value.reportBytes = Buffer.from(value.reportBytes.toString("utf8").replace(/<script type="application\/json" data-sei-island>[\s\S]*?<\/script>/, `<script type="application/json" data-sei-island>${JSON.stringify(snapshot)}</script>`));
      value.repeatReportBytes = Buffer.from(value.reportBytes);
    }, /value mismatch/],
    ["cycle source reference", (value) => {
      const snapshot = JSON.parse(value.snapshotBytes);
      const cycle = snapshot.measurements.find((entry) => entry.metric_id.includes("cyclic_scc_size"));
      cycle.source.artifact_refs = cycle.source.artifact_refs.filter((ref) => !ref.includes("pkg/app/a.py:4:0"));
      cycle.source.evidence_refs = cycle.source.evidence_refs.filter((ref) => !ref.includes("pkg/app/a.py:4:0"));
      value.snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
      value.repeatSnapshotBytes = Buffer.from(value.snapshotBytes);
      value.reportBytes = Buffer.from(value.reportBytes.toString("utf8").replace(/<script type="application\/json" data-sei-island>[\s\S]*?<\/script>/, `<script type="application/json" data-sei-island>${JSON.stringify(snapshot)}</script>`));
      value.repeatReportBytes = Buffer.from(value.reportBytes);
    }, /lacks artifact ref python-import:/],
    ["unsupported-language state", (value) => {
      const text = "Specialized AST coverage: Python only; TypeScript/TSX, JavaScript, Java, and Kotlin are unavailable and deferred.";
      value.reportBytes = Buffer.from(value.reportBytes.toString("utf8").replace(text, ""));
      value.repeatReportBytes = Buffer.from(value.reportBytes);
    }, /report lacks required text/],
    ["nondeterministic bytes", (value) => { value.repeatSnapshotBytes = Buffer.concat([value.repeatSnapshotBytes, Buffer.from(" ")]); }, /snapshot bytes are nondeterministic/],
  ];

  for (const [name, mutate, pattern] of cases) {
    await context.test(name, () => {
      const value = fixture();
      mutate(value);
      assert.throws(() => verifyProductArtifacts(value), pattern);
    });
  }
});
