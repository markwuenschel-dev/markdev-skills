"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AUTONOMOUS_EVIDENCE_VERSION,
  discoverEngineeringEvidence,
  projectEngineeringEvidence,
} = require("./autonomous-evidence.js");
const autonomousAssessmentPrivate = require("./autonomous-evidence.js")[Symbol.for("sei.autonomous-evidence.assessment.private.v1")];

const REVISION = "a".repeat(40);

function entry(path, bytes, classifications = {}) {
  const content = Buffer.from(bytes, "utf8");
  return {
    path,
    mode: "100644",
    byte_size: content.length,
    language: "unknown",
    content,
    classifications: {
      source: false,
      test_source: false,
      generated: "human",
      vendor: "not-vendor",
      manifest_kinds: [],
      artifact_candidate_kinds: [],
      ...classifications,
    },
  };
}

// Mirrors repository-index.js readonlyMap(): a frozen map-like view, deliberately not a Map instance.
function mapLikeView(inner) {
  return Object.freeze({
    get size() { return inner.size; },
    get(key) { return inner.get(key); },
    has(key) { return inner.has(key); },
    entries() { return inner.entries(); },
    [Symbol.iterator]() { return inner[Symbol.iterator](); },
    [Symbol.toStringTag]: "Map",
  });
}

function index(entries, readOverride = null) {
  return {
    binding: {
      repository_revision: REVISION,
      index_digest: `sha256:${"b".repeat(64)}`,
    },
    entries,
    readBlobs: readOverride ?? (async (requested) => mapLikeView(new Map(requested.map((item) => [item.path, item.content])))),
  };
}

test("autonomous evidence normalizes authoritative lint and dependency-vulnerability results at the indexed revision", async () => {
  const entries = [
    entry("eslint.config.js", "export default []"),
    entry("reports/eslint-results.json", JSON.stringify([
      { filePath: "src/a.js", messages: [{ severity: 2 }, { severity: 1 }], errorCount: 1, warningCount: 1 },
    ])),
    entry(".github/dependabot.yml", "version: 2\nupdates: []\n"),
    entry("reports/npm-audit.json", JSON.stringify({
      auditReportVersion: 2,
      metadata: { vulnerabilities: { info: 0, low: 1, moderate: 1, high: 1, critical: 0, total: 3 } },
    })),
  ];
  const result = await discoverEngineeringEvidence({ repositoryIndex: index(entries) });
  const capabilities = new Map(result.capabilities.map((capability) => [capability.capability_id, capability]));

  assert.equal(AUTONOMOUS_EVIDENCE_VERSION, "sei.autonomous-evidence@2");
  assert.equal(capabilities.get("lint-and-typecheck").state, "OBSERVED");
  assert.deepEqual(capabilities.get("lint-and-typecheck").result_paths, ["reports/eslint-results.json"]);
  assert.deepEqual(capabilities.get("lint-and-typecheck").facts, {
    error_count: 1,
    warning_count: 1,
    info_count: 0,
    finding_count: 2,
    tools: ["ESLint"],
  });
  assert.equal(capabilities.get("dependency-vulnerabilities").state, "OBSERVED");
  assert.deepEqual(capabilities.get("dependency-vulnerabilities").configuration_paths, [".github/dependabot.yml"]);
  assert.deepEqual(capabilities.get("dependency-vulnerabilities").result_paths, ["reports/npm-audit.json"]);
  assert.deepEqual(capabilities.get("dependency-vulnerabilities").facts, {
    vulnerability_count: 3,
    severities: { critical: 0, high: 1, medium: 1, low: 1, unknown: 0 },
    tools: ["npm audit"],
  });
  assert.deepEqual(await discoverEngineeringEvidence({ repositoryIndex: index([...entries].reverse()) }), result);
});

test("autonomous evidence discovers configured and observed engineering surfaces from one immutable index", async () => {
  const entries = [
    entry("package.json", JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc --noEmit", mutation: "stryker run" } }), { manifest_kinds: ["node-package"] }),
    entry("tsconfig.json", "{}"),
    entry("eslint.config.js", "export default []"),
    entry("stryker.conf.json", "{}"),
    entry("reports/analysis.sarif", JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "ESLint" } }, results: [{ ruleId: "no-eval" }, { ruleId: "eqeqeq" }] }] })),
    entry("reports/mutation.json", JSON.stringify({ schemaVersion: "1", thresholds: { high: 80 }, files: { "src/a.ts": { mutants: [{ status: "Killed" }, { status: "Survived" }] } } })),
    entry(".github/CODEOWNERS", "* @team\n"),
    entry(".github/pull_request_template.md", "## Verification\n"),
    entry(".github/ISSUE_TEMPLATE/bug.yml", "name: Bug\n"),
    entry(".github/workflows/release.yml", "jobs:\n  deploy:\n    steps:\n      - run: npm publish\n"),
    entry("deploy/k8s/deployment.yaml", "kind: Deployment\n"),
  ];
  const result = await discoverEngineeringEvidence({ repositoryIndex: index(entries) });

  assert.equal(AUTONOMOUS_EVIDENCE_VERSION, "sei.autonomous-evidence@2");
  assert.equal(result.repository_revision, REVISION);
  assert.equal(result.repository_index_digest, `sha256:${"b".repeat(64)}`);
  const capabilities = new Map(result.capabilities.map((capability) => [capability.capability_id, capability]));
  assert.equal(capabilities.get("dependency-manifests").state, "CONFIGURED");
  assert.equal(capabilities.get("lint-and-typecheck").state, "OBSERVED");
  assert.deepEqual(capabilities.get("lint-and-typecheck").surfaces, ["ESLint", "TypeScript compiler"]);
  assert.deepEqual(capabilities.get("lint-and-typecheck").result_paths, ["reports/analysis.sarif"]);
  assert.equal(capabilities.get("static-analysis-results").state, "OBSERVED");
  assert.equal(capabilities.get("static-analysis-results").facts.result_count, 2);
  assert.deepEqual(capabilities.get("static-analysis-results").facts.tools, ["ESLint"]);
  assert.equal(capabilities.get("mutation-testing").state, "OBSERVED");
  assert.deepEqual(capabilities.get("mutation-testing").facts, {
    killed: 1,
    survived: 1,
    total: 2,
    score: 0.5,
  });
  assert.equal(capabilities.get("review-metadata").state, "CONFIGURED");
  assert.equal(capabilities.get("work-item-metadata").state, "CONFIGURED");
  assert.equal(capabilities.get("deployment-and-release").state, "CONFIGURED");
  assert.equal(capabilities.get("deployment-and-release").execution, "UNOBSERVED");
  assert.equal(result.telemetry.index_entries_examined, entries.length);
  assert.equal(result.telemetry.repository_walks, 0);
  assert.equal(result.telemetry.blobs_read, 4);
  assert.equal(Object.isFrozen(result.capabilities), true);

  const reordered = await discoverEngineeringEvidence({ repositoryIndex: index([...entries].reverse()) });
  assert.deepEqual(reordered, result);
});

test("autonomous evidence distinguishes configured, observed, malformed, and unavailable surfaces", async () => {
  const result = await discoverEngineeringEvidence({ repositoryIndex: index([
    entry("pom.xml", "<project><dependencies/></project>", { manifest_kinds: ["maven-project"] }),
    entry("pitest.xml", "<mutationThreshold>80</mutationThreshold>"),
    entry("results/bad.sarif", "{"),
  ]) });
  const capabilities = new Map(result.capabilities.map((capability) => [capability.capability_id, capability]));
  assert.equal(capabilities.get("dependency-manifests").state, "CONFIGURED");
  assert.equal(capabilities.get("mutation-testing").state, "CONFIGURED");
  assert.equal(capabilities.get("mutation-testing").execution, "UNOBSERVED");
  assert.equal(capabilities.get("static-analysis-results").state, "CONFIGURED");
  assert.match(capabilities.get("static-analysis-results").reason, /could not be normalized/);
  assert.equal(capabilities.get("review-metadata").state, "UNAVAILABLE");
});

test("autonomous evidence keeps supported scanner configuration distinct from unavailable result surfaces", async () => {
  const result = await discoverEngineeringEvidence({ repositoryIndex: index([
    entry("pyrightconfig.json", "{}"),
    entry(".semgrep.yml", "rules: []\n"),
    entry(".github/dependabot.yml", "version: 2\nupdates: []\n"),
    entry("package.json", JSON.stringify({ scripts: { scan: "semgrep scan", mutation: "stryker run", audit: "npm audit --json" } }), { manifest_kinds: ["node-package"] }),
  ]) });
  const capabilities = new Map(result.capabilities.map((capability) => [capability.capability_id, capability]));

  assert.equal(capabilities.get("lint-and-typecheck").state, "CONFIGURED");
  assert.equal(capabilities.get("static-analysis-results").state, "CONFIGURED");
  assert.equal(capabilities.get("dependency-vulnerabilities").state, "CONFIGURED");
  assert.equal(capabilities.get("mutation-testing").state, "CONFIGURED");
  assert.ok(capabilities.get("static-analysis-results").configuration_paths.includes("package.json"));
  assert.ok(capabilities.get("mutation-testing").configuration_paths.includes("package.json"));
  assert.ok(capabilities.get("dependency-vulnerabilities").configuration_paths.includes("package.json"));
  for (const capability of capabilities.values()) {
    if (capability.state !== "OBSERVED") assert.equal(capability.facts, null);
  }
});

test("autonomous evidence normalizes pyright, PIT, and Trivy authoritative result schemas", async () => {
  const result = await discoverEngineeringEvidence({ repositoryIndex: index([
    entry("reports/pyright-report.json", JSON.stringify({
      version: "1.1.400",
      generalDiagnostics: [{ severity: "error" }, { severity: "warning" }, { severity: "information" }],
      summary: { filesAnalyzed: 1, errorCount: 1, warningCount: 1, informationCount: 1 },
    })),
    entry("reports/mutations.xml", '<mutations><mutation detected="true" status="KILLED"/><mutation detected="false" status="SURVIVED"/></mutations>'),
    entry("reports/trivy-results.json", JSON.stringify({ SchemaVersion: 2, Results: [{ Vulnerabilities: [{ Severity: "CRITICAL" }, { Severity: "MEDIUM" }] }] })),
  ]) });
  const capabilities = new Map(result.capabilities.map((capability) => [capability.capability_id, capability]));

  assert.deepEqual(capabilities.get("lint-and-typecheck").facts, {
    error_count: 1,
    warning_count: 1,
    info_count: 1,
    finding_count: 3,
    tools: ["pyright"],
  });
  assert.deepEqual(capabilities.get("mutation-testing").facts, { killed: 1, survived: 1, total: 2, score: 0.5 });
  assert.deepEqual(capabilities.get("dependency-vulnerabilities").facts, {
    vulnerability_count: 2,
    severities: { critical: 1, high: 0, medium: 1, low: 0, unknown: 0 },
    tools: ["Trivy"],
  });
});

test("autonomous evidence bounds candidate reads and isolates unreadable artifacts", async () => {
  const entries = Array.from({ length: 70 }, (_, number) => entry(
    `reports/r${String(number).padStart(2, "0")}.sarif`,
    JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: `Tool-${number}` } }, results: [] }] }),
  ));
  const batches = [];
  const result = await discoverEngineeringEvidence({
    repositoryIndex: index(entries, async (requested) => {
      batches.push(requested.map(({ path }) => path));
      if (requested.length > 1) throw new Error("synthetic batch read failure");
      const only = requested[0];
      if (only.path.endsWith("00.sarif")) throw new Error("synthetic unreadable blob");
      return new Map([[only.path, only.content]]);
    }),
  });
  const sarif = result.capabilities.find((capability) => capability.capability_id === "static-analysis-results");
  assert.equal(result.telemetry.candidate_limit_reached, true);
  assert.equal(result.telemetry.blobs_selected, 64);
  assert.equal(result.telemetry.blobs_read, 63);
  assert.equal(result.telemetry.blob_read_failures, 1);
  assert.equal(sarif.state, "OBSERVED");
  assert.equal(batches.length, 65);
});

test("autonomous evidence prefers valid observed facts while isolating malformed and oversized peers", async () => {
  const valid = entry("good/npm-audit.json", JSON.stringify({
    auditReportVersion: 2,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  }));
  const malformed = entry("bad/npm-audit.json", "{");
  const oversized = entry("oversized/trivy-results.json", "{}");
  oversized.byte_size = (2 * 1024 * 1024) + 1;
  const requested = [];
  const result = await discoverEngineeringEvidence({
    repositoryIndex: index([
      entry(".github/dependabot.yml", "version: 2\nupdates: []\n"),
      valid,
      malformed,
      oversized,
    ], async (entries) => {
      requested.push(...entries.map((candidate) => candidate.path));
      return new Map(entries.map((candidate) => [candidate.path, candidate.content]));
    }),
  });
  const dependency = result.capabilities.find((capability) => capability.capability_id === "dependency-vulnerabilities");

  assert.equal(dependency.state, "OBSERVED");
  assert.deepEqual(dependency.result_paths, ["good/npm-audit.json"]);
  assert.equal(dependency.rejected_artifact_count, 2);
  assert.equal(dependency.facts.vulnerability_count, 1);
  assert.equal(requested.includes("oversized/trivy-results.json"), false);
  assert.equal(result.telemetry.oversized_candidates, 1);
});

test("autonomous evidence validates revision binding, cancellation, closed input, and blob bounds", async () => {
  await assert.rejects(
    discoverEngineeringEvidence({ repositoryIndex: index([]), extra: true }),
    (error) => error?.code === "FAIL-AUTONOMOUS-EVIDENCE",
  );
  await assert.rejects(
    discoverEngineeringEvidence({ repositoryIndex: { ...index([]), binding: { repository_revision: "HEAD", index_digest: "bad" } } }),
    (error) => error?.code === "FAIL-AUTONOMOUS-EVIDENCE",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    discoverEngineeringEvidence({ repositoryIndex: index([]), signal: controller.signal }),
    /FAIL-AUTONOMOUS-EVIDENCE.*cancelled/,
  );
  const oversized = entry("result.sarif", "{}");
  oversized.byte_size = (2 * 1024 * 1024) + 1;
  const result = await discoverEngineeringEvidence({ repositoryIndex: index([oversized]) });
  assert.equal(result.telemetry.oversized_candidates, 1);
  assert.equal(result.telemetry.blobs_read, 0);
});

test("autonomous evidence enforces the aggregate blob byte ceiling even when the index reader over-returns", async () => {
  const sharedBytes = Buffer.alloc(2 * 1024 * 1024, 32);
  const entries = Array.from({ length: 17 }, (_, number) => {
    const candidate = entry(`reports/r${String(number).padStart(2, "0")}.sarif`, "{}");
    return { ...candidate, byte_size: sharedBytes.length, content: sharedBytes };
  });
  const result = await discoverEngineeringEvidence({ repositoryIndex: index(entries) });
  const sarif = result.capabilities.find((capability) => capability.capability_id === "static-analysis-results");

  assert.equal(result.telemetry.bytes_read, 32 * 1024 * 1024);
  assert.equal(result.telemetry.blobs_read, 16);
  assert.equal(result.telemetry.total_byte_limit_reached, true);
  assert.equal(sarif.state, "CONFIGURED");
  assert.equal(sarif.rejected_artifact_count, 17);
});

test("autonomous evidence projects canonical records without implying execution", async () => {
  const discovered = await discoverEngineeringEvidence({ repositoryIndex: index([
    entry("package.json", JSON.stringify({ scripts: { lint: "eslint ." } }), { manifest_kinds: ["node-package"] }),
    entry("reports/analysis.sarif", JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } }, results: [{}] }] })),
  ]) });
  const projected = projectEngineeringEvidence({
    discovery: discovered,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: REVISION },
  });
  assert.equal(projected.collectors.length, 8);
  assert.equal(projected.metrics.length, 8);
  const staticCollector = projected.collectors.find((item) => item.collector_id === "autonomous-static-analysis-results");
  const staticMetric = projected.metrics.find((item) => item.metric_id === "discovery.engineering.static-analysis-results_evidence_path_count");
  const deployMetric = projected.metrics.find((item) => item.metric_id === "discovery.engineering.deployment-and-release_evidence_path_count");
  assert.equal(staticCollector.status, "available");
  assert.equal(staticMetric.value, 1);
  assert.equal(staticMetric.measurement.status, "measured");
  assert.equal(deployMetric.value, null);
  assert.equal(deployMetric.measurement.status, "unavailable");
  assert.equal(Object.isFrozen(projected), true);
  assert.match(JSON.stringify(projected), /configuration was observed|committed SARIF facts/);
  assert.doesNotMatch(JSON.stringify(projected), /health.*(?:pass|fail)/i);
});

test("autonomous evidence projection is closed and carries revision-index and accepted-result provenance", async () => {
  const discovered = await discoverEngineeringEvidence({ repositoryIndex: index([
    entry("reports/eslint-results.json", JSON.stringify([
      { filePath: "src/a.js", messages: [{ severity: 2 }], errorCount: 1, warningCount: 0 },
    ])),
  ]) });
  const projected = projectEngineeringEvidence({
    discovery: discovered,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: REVISION },
  });
  const lint = projected.metrics.find((metric) => metric.metric_id === "discovery.engineering.lint-and-typecheck_evidence_path_count");

  assert.ok(lint.source.evidence_refs.includes(`repository-index:sha256:${"b".repeat(64)}`));
  assert.ok(lint.source.evidence_refs.includes("accepted-result:reports/eslint-results.json"));
  const forged = structuredClone(discovered);
  forged.capabilities[0].undeclared = true;
  assert.throws(() => projectEngineeringEvidence({
    discovery: forged,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: REVISION },
  }), /FAIL-AUTONOMOUS-EVIDENCE.*not declared/);
});

test("autonomous assessment bridge derives only revision-bound local facts", async () => {
  assert.equal(typeof autonomousAssessmentPrivate?.deriveAssessmentEvidence, "function");
  const discovered = await discoverEngineeringEvidence({ repositoryIndex: index([
    entry("package.json", JSON.stringify({ scripts: { lint: "eslint .", test: "node --test" } }), { manifest_kinds: ["node-package"] }),
    entry(".github/workflows/release.yml", "name: release\n"),
    entry("reports/analysis.sarif", JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } }, results: [{}] }] })),
    entry("reports/npm-audit.json", JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } })),
  ]) });
  const projected = projectEngineeringEvidence({
    discovery: discovered,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: REVISION },
  });
  const derived = autonomousAssessmentPrivate.deriveAssessmentEvidence({
    discovery: discovered,
    projected,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: REVISION },
  });
  const ids = derived.metrics.map((metric) => metric.metric_id);
  assert.ok(ids.includes("assessment.delivery.release_configuration"));
  assert.ok(ids.includes("assessment.security.verification"));
  assert.ok(ids.includes("assessment.security.dependency_hygiene"));
  assert.ok(derived.metrics.every((metric) => metric.repository_revision === REVISION));
  assert.ok(derived.metrics.every((metric) => metric.comparability.configuration_hash === "a".repeat(64)));
  assert.ok(derived.metrics.every((metric) => metric.source.evidence_refs.length > 0));
});
