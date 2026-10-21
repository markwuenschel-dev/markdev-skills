"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSnapshot,
  deriveRiskModelContractHash,
  deriveSnapshotId,
  materializeSnapshot,
  validateSnapshot,
} = require("./intelligence-engine.js");
const { deriveHotspots } = require("./interpretation.js");
const enginePrivate = require("./intelligence-engine.js")[Symbol.for("sei.intelligence-engine.private.v1")];

function makeMetric(overrides = {}) {
  const metric = {
    metric_id: "static.source_lines",
    definition_id: "sei.static.source_lines@1",
    family: "structural_complexity",
    subject: "repository:repo-fixture",
    repository_revision: "0123456789abcdef0123456789abcdef01234567",
    value: 42,
    unit: "lines",
    measurement: {
      status: "measured",
      completeness: 1,
      confidence: 1,
      reason: null,
    },
    source: {
      kind: "local-source",
      collector_id: "static-source",
      collector_version: "1.0.0",
      repository_revision: "0123456789abcdef0123456789abcdef01234567",
      command: "node static-collector.js --revision 0123456789abcdef0123456789abcdef01234567",
      artifact_refs: ["src/index.js"],
    },
    scope: {
      kind: "repository",
      path: ".",
      language: "javascript",
      generated_code: false,
      included_in_human_maintainability: true,
    },
    window: {
      kind: "revision",
      start: null,
      end: "0123456789abcdef0123456789abcdef01234567",
    },
    analyzer_identity: "sei.lexical-js@1",
    analyzer_version: "1.0.0",
    comparability: {
      analyzer_identity: "sei.lexical-js@1",
      analyzer_version: "1.0.0",
      configuration_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      compatible_with_prior: false,
      reason: "first snapshot",
    },
  };

  const analyzerIdentity = overrides.analyzer_identity ?? metric.analyzer_identity;
  const analyzerVersion = overrides.analyzer_version ?? metric.analyzer_version;
  return {
    ...metric,
    ...overrides,
    analyzer_identity: analyzerIdentity,
    analyzer_version: analyzerVersion,
    measurement: { ...metric.measurement, ...overrides.measurement },
    source: { ...metric.source, ...overrides.source },
    scope: { ...metric.scope, ...overrides.scope },
    window: { ...metric.window, ...overrides.window },
    comparability: {
      ...metric.comparability,
      analyzer_identity: analyzerIdentity,
      analyzer_version: analyzerVersion,
      ...overrides.comparability,
    },
  };
}

function baseSnapshot() {
  const snapshot = {
    schema_version: "1.0.0",
    snapshot_id: "sei-snapshot-fixture-1",
    repository: {
      repository_id: "repo-fixture",
      revision: "0123456789abcdef0123456789abcdef01234567",
      configuration_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      history_boundary: {
        kind: "revision-range",
        start: "fedcba9876543210fedcba9876543210fedcba98",
        end: "0123456789abcdef0123456789abcdef01234567",
      },
      generated_path_patterns: ["dist/**"],
    },
    collectors: [
      {
        collector_id: "static-source",
        collector_version: "1.0.0",
        status: "available",
        analyzer_identity: "sei.lexical-js@1",
        analyzer_version: "1.0.0",
        reason: null,
      },
    ],
    measurements: [makeMetric()],
    risk_models: [],
    profiles: [],
    evidence_summary: {
      measurement_count: 1,
      status_counts: {
        measured: 1,
        inferred: 0,
        unavailable: 0,
        "not-applicable": 0,
        unverifiable: 0,
      },
    },
    run_metadata: {
      generated_at: "2026-08-10T00:00:00.000Z",
      cache: {
        cache_key: "placeholder",
        repository_revision: "0123456789abcdef0123456789abcdef01234567",
        configuration_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schema_version: "1.0.0",
        collector_versions: ["static-source@1.0.0"],
        history_boundary: {
          kind: "revision-range",
          start: "fedcba9876543210fedcba9876543210fedcba98",
          end: "0123456789abcdef0123456789abcdef01234567",
        },
      },
    },
  };
  return materializeSnapshot(snapshot);
}

test("rejects a measured metric without provenance and preserves unavailable as nonzero-state", () => {
  assert.equal(validateSnapshot(baseSnapshot()).ok, true);

  const missing = structuredClone(baseSnapshot());
  delete missing.measurements[0].source.collector_version;
  assert.equal(validateSnapshot(missing).ok, false);

  const unavailable = makeMetric({
    value: null,
    measurement: { status: "unavailable", reason: "analyzer is not installed" },
  });
  assert.notEqual(unavailable.value, 0);
});

test("canonical hotspot validation accepts the same positive partial degraded observation as vectorization", () => {
  const coverage = 141 / 145;
  const draft = structuredClone(baseSnapshot());
  draft.snapshot_id = "pending";
  draft.collectors[0].status = "degraded";
  draft.collectors[0].reason = "4 merge commits lack attributed file rows";
  draft.measurements = [makeMetric({
    metric_id: "git.change_frequency:src/index.js",
    definition_id: "sei.git.change_frequency@1",
    family: "repository_behavior",
    subject: "file:src/index.js",
    value: 141,
    unit: "revisions",
    measurement: {
      status: "measured",
      completeness: coverage,
      confidence: coverage,
      reason: "4 merge commits lack attributed file rows",
    },
    source: {
      kind: "local-git",
      command: null,
      artifact_refs: ["git:history"],
      evidence_refs: ["git:src/index.js"],
    },
    scope: {
      kind: "file",
      path: "src/index.js",
      language: "javascript",
      generated_code: false,
      included_in_human_maintainability: true,
    },
  })];
  draft.evidence_summary.measurement_count = 1;

  const hotspots = deriveHotspots(draft);
  assert.equal(hotspots.features.length, 1);
  const metricIds = draft.measurements.map((metric) => metric.metric_id).sort();
  const refs = [...new Set(draft.measurements.flatMap((metric) => [
    ...(metric.source.artifact_refs ?? []),
    ...(metric.source.evidence_refs ?? []),
  ]))].sort();
  draft.risk_models = [{
    risk_model_id: "heuristic-v1",
    model_version: "1.0.0",
    model_contract_hash: deriveRiskModelContractHash("heuristic-v1"),
    model_status: "heuristic",
    calibration: null,
    result: {
      result_id: `heuristic-v1:${draft.repository.revision}`,
      kind: "heuristic_hotspot_vectors",
      status: "available",
      repository_revision: draft.repository.revision,
      evidence_metric_ids: metricIds,
      evidence_refs: refs,
      interpretation_boundary: hotspots.interpretation_boundary,
      records: hotspots.features.map((feature) => ({
        subject: feature.subject,
        features: feature.vector,
        hotspot_signals: feature.hotspot_signals,
      })),
    },
  }];

  const snapshot = materializeSnapshot(draft);
  assert.deepEqual(validateSnapshot(snapshot), { ok: true, errors: [] });
});

test("rejects a comparison produced by an incompatible analyzer", () => {
  const snapshot = baseSnapshot();
  snapshot.measurements[0].comparison = {
    baseline_snapshot_id: "sei-snapshot-fixture-0",
    baseline_metric_id: "static.source_lines",
    analyzer_identity: "vendor.cyclomatic@9",
    analyzer_version: "9.0.0",
    configuration_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith("FAIL-INCOMPATIBLE-COMPARISON:")));
});

test("validates closed factual comparison metadata while preserving legacy comparison snapshots", () => {
  const legacy = baseSnapshot();
  legacy.measurements[0].comparability.compatible_with_prior = true;
  legacy.measurements[0].comparability.reason = "legacy explicit baseline binding";
  legacy.measurements[0].comparison = {
    baseline_snapshot_id: "sei-snapshot-fixture-0",
    baseline_metric_id: "static.source_lines",
    analyzer_identity: "sei.lexical-js@1",
    analyzer_version: "1.0.0",
    configuration_hash: "a".repeat(64),
  };
  legacy.snapshot_id = "pending";
  assert.equal(validateSnapshot(materializeSnapshot(legacy)).ok, true);

  const factual = baseSnapshot();
  factual.measurements[0].comparability.compatible_with_prior = true;
  factual.measurements[0].comparability.reason = "automatic canonical baseline binding";
  factual.measurements[0].comparison = {
    baseline_snapshot_id: "sei-snapshot-fixture-0",
    baseline_metric_id: "static.source_lines",
    analyzer_identity: "sei.lexical-js@1",
    analyzer_version: "1.0.0",
    configuration_hash: "a".repeat(64),
    binding_kind: "automatic",
    baseline_repository_revision: "f".repeat(40),
    baseline_value: 40,
    delta: 2,
    confidence: 0.75,
  };
  factual.run_metadata.trend_baseline = {
    binding_kind: "automatic",
    status: "selected",
    eligible: true,
    baseline_snapshot_id: "sei-snapshot-fixture-0",
    baseline_repository_revision: "f".repeat(40),
    compatible_metric_count: 1,
    reason: "selected nearest compatible strict ancestor",
  };
  factual.snapshot_id = "pending";
  const valid = materializeSnapshot(factual);
  assert.equal(validateSnapshot(valid).ok, true);

  for (const [label, mutate] of [
    ["delta", (snapshot) => { snapshot.measurements[0].comparison.delta = 3; }],
    ["confidence", (snapshot) => { snapshot.measurements[0].measurement.confidence = 0.5; }],
    ["baseline ID", (snapshot) => { snapshot.run_metadata.trend_baseline.baseline_snapshot_id = "sei-other-baseline"; }],
    ["baseline revision", (snapshot) => { snapshot.measurements[0].comparison.baseline_repository_revision = "e".repeat(40); }],
    ["binding kind", (snapshot) => { snapshot.measurements[0].comparison.binding_kind = "explicit"; }],
    ["eligibility", (snapshot) => { snapshot.run_metadata.trend_baseline.eligible = false; }],
  ]) {
    const forged = structuredClone(valid);
    mutate(forged);
    const result = validateSnapshot(forged);
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), /FAIL-(?:INCOMPATIBLE-COMPARISON|TREND-BASELINE-METADATA)/, label);
  }
});

test("requires canonical subject, revision, and explicit comparability semantics", () => {
  const snapshot = baseSnapshot();
  delete snapshot.measurements[0].subject;
  delete snapshot.measurements[0].repository_revision;
  delete snapshot.measurements[0].comparability;

  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("measurements[0].subject")));
  assert.ok(result.errors.some((error) => error.includes("measurements[0].repository_revision")));
  assert.ok(result.errors.some((error) => error.includes("measurements[0].comparability")));
});

test("rejects a metric whose declared comparability identity differs from its analyzer", () => {
  const snapshot = baseSnapshot();
  snapshot.measurements[0].comparability.analyzer_identity = "other-analyzer@1";

  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith("FAIL-INCOMPATIBLE-COMPARISON:")));
});

test("rejects duplicate stable IDs", () => {
  const snapshot = baseSnapshot();
  snapshot.measurements.push(structuredClone(snapshot.measurements[0]));
  snapshot.evidence_summary.measurement_count = 2;
  snapshot.evidence_summary.status_counts.measured = 2;

  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith("FAIL-DUPLICATE-ID:")));
});

test("requires not-applicable measurements to carry a reason", () => {
  const snapshot = baseSnapshot();
  snapshot.measurements[0] = makeMetric({
    value: null,
    measurement: {
      status: "not-applicable",
      completeness: 1,
      confidence: 1,
      reason: "repository has no deployable service",
    },
  });
  snapshot.evidence_summary.status_counts.measured = 0;
  snapshot.evidence_summary.status_counts["not-applicable"] = 1;
  const materialized = materializeSnapshot(snapshot);
  assert.equal(validateSnapshot(materialized).ok, true);

  materialized.measurements[0].measurement.reason = null;
  const result = validateSnapshot(materialized);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("measurement.reason is required")));
});

test("rejects stale cache metadata", () => {
  const snapshot = baseSnapshot();
  snapshot.run_metadata.cache.repository_revision = "ffffffffffffffffffffffffffffffffffffffff";

  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith("FAIL-STALE-CACHE-METADATA:")));
});

test("requires explicit generated-code scope flags", () => {
  const snapshot = baseSnapshot();
  delete snapshot.measurements[0].scope.generated_code;
  delete snapshot.measurements[0].scope.included_in_human_maintainability;

  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith("FAIL-GENERATED-CODE-SCOPE:")));
});

test("matches schema-required scope and window fields and invalidates caches on analyzer drift", () => {
  const missingScopeAndWindow = baseSnapshot();
  delete missingScopeAndWindow.measurements[0].scope.kind;
  delete missingScopeAndWindow.measurements[0].scope.path;
  delete missingScopeAndWindow.measurements[0].scope.language;
  missingScopeAndWindow.measurements[0].window = {};

  const scopeResult = validateSnapshot(missingScopeAndWindow);
  assert.equal(scopeResult.ok, false);
  assert.ok(scopeResult.errors.some((error) => error.includes("scope.kind")));
  assert.ok(scopeResult.errors.some((error) => error.includes("scope.path")));
  assert.ok(scopeResult.errors.some((error) => error.includes("scope.language")));
  assert.ok(scopeResult.errors.some((error) => error.includes("window.kind")));
  assert.ok(scopeResult.errors.some((error) => error.includes("window.start is required")));
  assert.ok(scopeResult.errors.some((error) => error.includes("window.end is required")));

  const analyzerDrift = baseSnapshot();
  analyzerDrift.collectors[0].analyzer_version = "2.0.0";
  analyzerDrift.measurements[0].analyzer_version = "2.0.0";
  analyzerDrift.measurements[0].comparability.analyzer_version = "2.0.0";
  analyzerDrift.snapshot_id = deriveSnapshotId(analyzerDrift);

  const cacheResult = validateSnapshot(analyzerDrift);
  assert.equal(cacheResult.ok, false);
  assert.ok(cacheResult.errors.some((error) => error.includes("cache.collector_fingerprints")));
});

test("matches schema-required nullable history bounds and closed record shapes", () => {
  const missingHistoryBounds = baseSnapshot();
  delete missingHistoryBounds.repository.history_boundary.start;
  delete missingHistoryBounds.repository.history_boundary.end;
  missingHistoryBounds.unexpected = true;
  delete missingHistoryBounds.measurements[0].measurement.reason;

  const missingResult = validateSnapshot(missingHistoryBounds);
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((error) => error.includes("history_boundary.start is required")));
  assert.ok(missingResult.errors.some((error) => error.includes("history_boundary.end is required")));
  assert.ok(missingResult.errors.some((error) => error.includes("snapshot.unexpected is not a declared field")));
  assert.ok(missingResult.errors.some((error) => error.includes("measurement.reason must be a non-empty string or null")));

  const explicitNullBounds = baseSnapshot();
  explicitNullBounds.repository.history_boundary = {
    kind: "unbounded-history",
    start: null,
    end: null,
  };
  assert.equal(validateSnapshot(materializeSnapshot(explicitNullBounds)).ok, true);
});

test("creates byte-identical output for identical logical inputs", () => {
  const first = baseSnapshot();
  first.collectors.push({
    collector_id: "git-history",
    collector_version: "1.0.0",
    status: "available",
    analyzer_identity: "sei.git-history@1",
    analyzer_version: "1.0.0",
    reason: null,
  });
  first.measurements.push(makeMetric({
    metric_id: "git.change_frequency",
    definition_id: "sei.git.change_frequency@1",
    value: 7,
    unit: "revisions",
    analyzer_identity: "sei.git-history@1",
    analyzer_version: "1.0.0",
    source: {
      collector_id: "git-history",
      collector_version: "1.0.0",
      command: "git log --numstat",
      artifact_refs: ["git-log"],
    },
    window: {
      kind: "revision-range",
      start: "fedcba9876543210fedcba9876543210fedcba98",
    },
  }));
  first.evidence_summary.measurement_count = 2;
  first.evidence_summary.status_counts.measured = 2;
  first.run_metadata.cache.collector_versions.push("git-history@1.0.0");

  const rematerializedFirst = materializeSnapshot(first);
  const second = structuredClone(rematerializedFirst);
  second.collectors.reverse();
  second.measurements.reverse();
  second.run_metadata.cache.collector_versions.reverse();

  assert.equal(JSON.stringify(createSnapshot(rematerializedFirst)), JSON.stringify(materializeSnapshot(second)));
});

test("private canonical artifacts preserve exact bytes and validate changed or untrusted snapshots once", () => {
  assert.equal(typeof enginePrivate.materializeCanonicalArtifact, "function");
  assert.equal(typeof enginePrivate.canonicalArtifactFromSnapshot, "function");
  assert.equal(typeof enginePrivate.readCanonicalArtifact, "function");

  const draft = structuredClone(baseSnapshot());
  draft.snapshot_id = "pending";
  draft.run_metadata.cache = {};
  draft.measurements[0].source.artifact_refs = ["src/<entry>&.js"];
  const expected = materializeSnapshot(draft);
  const observations = [];
  let tick = 0n;
  const timing = {
    now() {
      tick += 1_000_000n;
      return tick;
    },
    observe(field, durationMs) {
      observations.push([field, durationMs]);
    },
  };
  const artifact = enginePrivate.materializeCanonicalArtifact(draft, timing);
  const branded = enginePrivate.readCanonicalArtifact(artifact);

  assert.equal(branded.snapshot.snapshot_id, expected.snapshot_id);
  assert.equal(branded.snapshot.run_metadata.cache.cache_key, expected.run_metadata.cache.cache_key);
  assert.equal(branded.snapshot_json, `${JSON.stringify(expected, null, 2)}\n`);
  assert.equal(observations.filter(([field]) => field === "snapshot_validation_ms").length, 1);
  assert.throws(() => { branded.snapshot.repository.repository_id = "mutated"; }, TypeError);
  assert.throws(
    () => enginePrivate.readCanonicalArtifact({ ...artifact }),
    /FAIL-SNAPSHOT-ARTIFACT: canonical artifact brand is invalid/,
  );

  observations.length = 0;
  const untrusted = enginePrivate.canonicalArtifactFromSnapshot(JSON.parse(branded.snapshot_json), timing);
  assert.equal(enginePrivate.readCanonicalArtifact(untrusted).snapshot_json, branded.snapshot_json);
  assert.equal(observations.filter(([field]) => field === "snapshot_validation_ms").length, 1);

  const tampered = JSON.parse(branded.snapshot_json);
  tampered.snapshot_id = "sei-v1-forged";
  assert.throws(
    () => enginePrivate.canonicalArtifactFromSnapshot(tampered, timing),
    /FAIL-SNAPSHOT-IDENTITY/,
  );
});

test("materializeSnapshot performs one full validation after binding derived identity", () => {
  const observations = [];
  let tick = 0n;
  const timing = {
    now() {
      tick += 1_000_000n;
      return tick;
    },
    observe(field, durationMs) {
      observations.push([field, durationMs]);
    },
  };
  const snapshot = enginePrivate.materializeSnapshotWithTelemetry(baseSnapshot(), timing);
  assert.equal(typeof snapshot.snapshot_id, "string");
  assert.equal(observations.filter(([field]) => field === "snapshot_validation_ms").length, 1);
});

test("private trend probe is closed, branded, and preserves the old unbound snapshot identity", () => {
  assert.equal(typeof enginePrivate.createTrendProbe, "function");
  assert.equal(typeof enginePrivate.readTrendProbe, "function");
  const current = baseSnapshot();
  const probe = enginePrivate.createTrendProbe(current);
  const projected = enginePrivate.readTrendProbe(probe);

  assert.deepEqual(Object.keys(projected).sort(), [
    "collectors",
    "measurements",
    "profiles",
    "repository",
    "schema_version",
    "snapshot_id",
  ]);
  assert.equal(projected.snapshot_id, current.snapshot_id);
  assert.equal(Object.isFrozen(projected), true);
  assert.throws(
    () => enginePrivate.readTrendProbe(structuredClone(projected)),
    /FAIL-TREND-PROBE: trend probe brand is invalid/,
  );
});

module.exports = { baseSnapshot, makeMetric };
