"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const capabilityCoverage = require("./capability-coverage.js");
const {
  CAPABILITY_COVERAGE_VERSION,
  deriveCapabilityCoverage,
} = capabilityCoverage;
const coveragePrivate = capabilityCoverage[Symbol.for("sei.capability-coverage.private.v1")];

function collector(collectorId, status = "available", reason = null) {
  return {
    collector_id: collectorId,
    collector_version: "1.0.0",
    status,
    analyzer_identity: `sei.${collectorId}@1`,
    analyzer_version: "1.0.0",
    reason,
  };
}

function metric({
  metricId,
  collectorId,
  value,
  status = "measured",
  completeness = status === "measured" || status === "inferred" ? 1 : 0,
  confidence = completeness,
  language = null,
  scopeKind = "repository",
  path = ".",
}) {
  return {
    metric_id: metricId,
    value,
    measurement: { status, completeness, confidence },
    source: {
      collector_id: collectorId,
      collector_version: "1.0.0",
      artifact_refs: [`artifact:${metricId}`],
      evidence_refs: [`evidence:${metricId}`],
    },
    scope: {
      kind: scopeKind,
      path,
      language,
      generated_code: false,
      included_in_human_maintainability: true,
    },
  };
}

function fixtureSnapshot() {
  const historyCoverage = 141 / 145;
  return {
    collectors: [
      collector("static-source"),
      collector("git-history", "degraded"),
      collector("test-discovery", "degraded"),
      collector("coverage-discovery", "unavailable"),
      collector("ci-discovery", "unavailable"),
      collector("kotlin-static-intelligence", "unavailable"),
      collector("structural-duplication-intelligence", "unavailable", "FAIL-DUPLICATION-RESOURCE-LIMIT: candidate bound reached"),
      collector("work-item-adapter", "unavailable"),
      collector("pr-flow", "unavailable"),
      collector("deployment-events", "unavailable"),
      collector("dora-deployment-evidence", "unavailable"),
    ],
    measurements: [
      metric({ metricId: "static.human_source_file_count", collectorId: "static-source", value: 20 }),
      metric({ metricId: "static.source_lines:src/main.js", collectorId: "static-source", value: 80, language: "javascript", scopeKind: "file", path: "src/main.js" }),
      metric({ metricId: "static.source_lines:src/unsupported.kt", collectorId: "static-source", value: 40, language: "kotlin", scopeKind: "file", path: "src/unsupported.kt" }),
      metric({ metricId: "git.change_frequency", collectorId: "git-history", value: 145 }),
      metric({ metricId: "git.observed_text_churn", collectorId: "git-history", value: 187947, completeness: historyCoverage, confidence: historyCoverage }),
      metric({ metricId: "discovery.test_evidence_path_count", collectorId: "test-discovery", value: 3 }),
      metric({ metricId: "discovery.coverage_evidence_path_count", collectorId: "coverage-discovery", value: null, status: "unavailable" }),
      metric({ metricId: "discovery.ci_evidence_path_count", collectorId: "ci-discovery", value: null, status: "unavailable" }),
      metric({ metricId: "static.kotlin.cyclomatic_complexity", collectorId: "kotlin-static-intelligence", value: null, status: "unavailable", language: "kotlin" }),
      metric({ metricId: "static.duplication.analyzed_source_lines", collectorId: "structural-duplication-intelligence", value: null, status: "unavailable" }),
    ],
  };
}

function capabilityById(result, capabilityId) {
  const capability = result.capabilities.find((candidate) => candidate.capability_id === capabilityId);
  assert.ok(capability, `missing capability ${capabilityId}`);
  return capability;
}

test("capability coverage exposes a bounded domain catalog rather than a volume-weighted percentage", () => {
  const result = deriveCapabilityCoverage(fixtureSnapshot());

  assert.deepEqual(Object.keys(capabilityCoverage).sort(), [
    "CAPABILITY_COVERAGE_VERSION",
    "deriveCapabilityCoverage",
  ]);
  assert.equal(CAPABILITY_COVERAGE_VERSION, "sei.capability-coverage@1");
  assert.equal(result.capability_coverage_version, CAPABILITY_COVERAGE_VERSION);
  assert.equal(Array.isArray(result.capabilities), true);
  assert.equal(Object.hasOwn(result, "coverage_ratio"), false);
  assert.equal(Object.hasOwn(result, "score"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.capabilities), true);
  assert.equal(coveragePrivate.SEMANTIC_OBSERVATION_VERSION, "sei.engineering-observation@1");
  assert.equal(
    coveragePrivate.deriveSemanticEvidenceIndex(fixtureSnapshot()).semantic_observation_version,
    "sei.engineering-observation@1",
  );

  const source = capabilityById(result, "source-inventory");
  assert.equal(source.evidence.state, "complete");
  assert.equal(source.evidence.usable, true);

  const history = capabilityById(result, "change-history");
  assert.equal(history.evidence.state, "strong-partial");
  assert.equal(history.evidence.usable, true);
  assert.equal(history.evidence.coverage, 141 / 145);
  assert.match(history.summary, /141 of 145 revisions/i);
  assert.deepEqual(history.evidence.exclusions, [{
    code: "unattributed-history-revisions",
    count: 4,
    value_affecting: true,
  }]);

  const tests = capabilityById(result, "test-execution");
  assert.equal(tests.evidence.state, "configured-not-observed");
  assert.equal(tests.evidence.usable, false);
  assert.match(tests.summary, /3 test paths/i);

  assert.equal(capabilityById(result, "coverage").evidence.state, "not-detected");
  assert.equal(capabilityById(result, "ci").evidence.state, "not-detected");
  assert.equal(capabilityById(result, "kotlin-structure").evidence.state, "unsupported");
  assert.equal(capabilityById(result, "duplication").evidence.state, "resource-limited");
  assert.equal(capabilityById(result, "work-item-flow").evidence.state, "external-required");
  assert.equal(capabilityById(result, "pr-review-flow").evidence.state, "external-required");
  assert.equal(capabilityById(result, "deployment-dora").evidence.state, "external-required");

  const absentLanguage = capabilityById(result, "python-structure");
  assert.equal(absentLanguage.applicable, false);
  assert.equal(absentLanguage.evidence.state, "not-applicable");
});

test("capability coverage is deterministic, does not parse arbitrary reason prose, and marks unbound language evidence unresolved", () => {
  const snapshot = fixtureSnapshot();
  snapshot.collectors.push(collector("tsjs-static-intelligence", "degraded", "human text that is not a classification input"));
  snapshot.measurements.push(metric({
    metricId: "static.source_lines:src/partial.js",
    collectorId: "static-source",
    value: 10,
    language: "javascript",
    scopeKind: "file",
    path: "src/partial.js",
  }));

  const first = deriveCapabilityCoverage(snapshot);
  const permuted = {
    collectors: [...snapshot.collectors].reverse(),
    measurements: [...snapshot.measurements].reverse(),
  };
  const second = deriveCapabilityCoverage(permuted);

  assert.deepEqual(second, first);
  assert.equal(capabilityById(first, "tsjs-structure").evidence.state, "unresolved");
  assert.equal(capabilityById(first, "duplication").evidence.condition.code, "duplication-resource-limit");
  assert.doesNotMatch(JSON.stringify(first), /human text that is not a classification input/);
});

test("capability coverage rejects malformed or ambiguously bound inputs", () => {
  assert.throws(
    () => deriveCapabilityCoverage({ collectors: [], measurements: [] }),
    /FAIL-CAPABILITY-COVERAGE/,
  );
  assert.throws(
    () => deriveCapabilityCoverage({
      collectors: [collector("static-source"), collector("static-source")],
      measurements: [],
    }),
    /FAIL-CAPABILITY-COVERAGE/,
  );
  assert.throws(
    () => deriveCapabilityCoverage({
      collectors: [collector("static-source")],
      measurements: [metric({ metricId: "static.source_file_count", collectorId: "missing-collector", value: 1 })],
    }),
    /FAIL-CAPABILITY-COVERAGE/,
  );
});
