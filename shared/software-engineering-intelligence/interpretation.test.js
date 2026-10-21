"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compareSnapshots, deriveHotspots } = require("./interpretation.js");

function metric({
  id,
  definition,
  subject = "file:src/core.js",
  value,
  unit,
  status = "measured",
  analyzer = "sei.fixture@1",
  analyzerVersion = "1.0.0",
  configuration = "config-a",
  compatible = true,
  repositoryRevision = "revision-a",
  window = null,
  comparison = undefined,
  evidenceRefs = undefined,
  scope = undefined,
}) {
  const measurementWindow = window ?? { kind: "revision", start: null, end: repositoryRevision };
  const fileSubject = typeof subject === "string" && subject.startsWith("file:");
  return {
    metric_id: id,
    definition_id: definition,
    subject,
    repository_revision: repositoryRevision,
    value,
    unit,
    measurement: { status, confidence: 1, completeness: 1, reason: null },
    source: {
      collector_id: "fixture",
      collector_version: "1.0.0",
      repository_revision: repositoryRevision,
      evidence_refs: evidenceRefs ?? [`evidence:${id}`],
    },
    scope: scope ?? {
      kind: fileSubject ? "file" : "repository",
      path: fileSubject ? subject.slice("file:".length) : "",
      language: fileSubject ? "javascript" : null,
      generated_code: false,
      included_in_human_maintainability: true,
    },
    window: measurementWindow,
    analyzer_identity: analyzer,
    analyzer_version: analyzerVersion,
    comparability: {
      analyzer_identity: analyzer,
      analyzer_version: analyzerVersion,
      configuration_hash: configuration,
      compatible_with_prior: compatible,
      reason: compatible ? "same analyzer contract" : "first observation",
    },
    ...(comparison === undefined ? {} : { comparison }),
  };
}

function snapshot(measurements, overrides = {}) {
  const revision = overrides.revision ?? "revision-a";
  return {
    schema_version: "1.0.0",
    snapshot_id: overrides.snapshot_id ?? "snapshot-current",
    repository: {
      repository_id: "repo",
      configuration_hash: overrides.configuration_hash ?? "config-a",
      revision,
      history_boundary: overrides.history_boundary ?? { kind: "revision", start: null, end: revision },
    },
    collectors: [
      {
        collector_id: "fixture",
        collector_version: "1.0.0",
        analyzer_identity: "sei.fixture@1",
        analyzer_version: "1.0.0",
        status: overrides.collector_status ?? "available",
      },
    ],
    measurements,
    risk_models: overrides.risk_models ?? [],
  };
}

function calibrationSnapshot(overrides = {}) {
  return snapshot([
    metric({
      id: "calibration.validation-receipt",
      definition: "sei.calibration.validation-receipt@1",
      subject: "repository:repo",
      value: 1,
      unit: "records",
      evidenceRefs: ["artifact:validation.json"],
    }),
  ], overrides);
}

function comparablePair() {
  const priorSnapshotId = "snapshot-prior";
  const currentSnapshotId = "snapshot-current";
  const priorRevision = "revision-a";
  const currentRevision = "revision-b";
  const priorMetric = metric({
    id: "git.churn",
    definition: "sei.git.churn@1",
    value: 10,
    unit: "lines-changed",
    repositoryRevision: priorRevision,
  });
  const currentMetric = metric({
    id: "git.churn",
    definition: "sei.git.churn@1",
    value: 14,
    unit: "lines-changed",
    repositoryRevision: currentRevision,
    comparison: {
      baseline_snapshot_id: priorSnapshotId,
      baseline_metric_id: priorMetric.metric_id,
      analyzer_identity: priorMetric.analyzer_identity,
      analyzer_version: priorMetric.analyzer_version,
      configuration_hash: "config-a",
    },
  });
  return {
    prior: snapshot([priorMetric], { snapshot_id: priorSnapshotId, revision: priorRevision }),
    current: snapshot([currentMetric], {
      snapshot_id: currentSnapshotId,
      revision: currentRevision,
      history_boundary: { kind: "revision-range", start: priorRevision, end: currentRevision },
    }),
  };
}

test("hotspots are labelled heuristic until an independent holdout validates them", () => {
  const result = deriveHotspots({
    measurements: [
      {
        metric_id: "git.churn:src/core.js",
        definition_id: "sei.git.churn@1",
        subject: "file:src/core.js",
        value: 120,
        unit: "lines-changed",
        measurement: { status: "measured" },
      },
    ],
    risk_models: [],
  });

  assert.equal(result.model_status, "heuristic");
});

test("hotspot feature vectors require snapshot-bound metric provenance", () => {
  const result = deriveHotspots({
    measurements: [{
      metric_id: "git.churn:src/core.js",
      definition_id: "sei.git.churn@1",
      subject: "file:src/core.js",
      value: 120,
      unit: "lines-changed",
      measurement: { status: "measured" },
    }],
  });

  assert.deepEqual(result.features, []);
});

test("hotspot vectors retain positive partial file evidence from a matching degraded collector", () => {
  const coverage = 141 / 145;
  const partial = metric({
    id: "git.change_frequency:src/core.js",
    definition: "sei.git.change_frequency@1",
    value: 141,
    unit: "revisions",
  });
  partial.measurement = {
    status: "measured",
    completeness: coverage,
    confidence: coverage,
    reason: "4 merge commits lack attributed file rows",
  };

  for (const status of ["measured", "inferred"]) {
    const candidate = structuredClone(partial);
    candidate.measurement.status = status;
    const observed = deriveHotspots(snapshot([candidate], { collector_status: "degraded" }));
    assert.equal(observed.features.length, 1, status);
    assert.deepEqual(observed.features[0].vector.map((feature) => feature.metric_id), [partial.metric_id]);
  }

  const unavailable = structuredClone(partial);
  unavailable.value = null;
  unavailable.measurement = { status: "unavailable", completeness: 0, confidence: 0, reason: "not observed" };
  const zeroCoverage = structuredClone(partial);
  zeroCoverage.measurement.completeness = 0;
  const zeroConfidence = structuredClone(partial);
  zeroConfidence.measurement.confidence = 0;
  const unbound = structuredClone(partial);
  unbound.source.repository_revision = "revision-other";

  for (const candidate of [unavailable, zeroCoverage, zeroConfidence, unbound]) {
    assert.deepEqual(
      deriveHotspots(snapshot([candidate], { collector_status: "degraded" })).features,
      [],
    );
  }
});

test("hotspot vectors preserve lexical, churn, coverage, and test-count evidence without authority claims", () => {
  const result = deriveHotspots(snapshot([
    metric({ id: "git.churn:src/core.js", definition: "sei.git.churn@1", value: 120, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/core.js", definition: "sei.static.lexical_max_nesting_depth@1", value: 7, unit: "lexical-brace-or-indentation-depth" }),
    metric({ id: "tests.count:src/core.js", definition: "fixture.tests.count@1", value: 80, unit: "tests" }),
    metric({ id: "coverage.lines:src/core.js", definition: "fixture.coverage.lines@1", value: 98, unit: "percent" }),
  ]));

  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].vector.map((feature) => feature.metric_id), [
    "coverage.lines:src/core.js",
    "git.churn:src/core.js",
    "static.lexical_max_nesting_depth:src/core.js",
    "tests.count:src/core.js",
  ]);
  assert.equal(result.features[0].vector[2].interpretation, "lexical structural proxy");
  assert.equal("candidate_priority" in result, false);
  assert.equal("health_grade" in result, false);
  assert.equal("completion_verdict" in result, false);
  assert.doesNotMatch(JSON.stringify(result), /bug.probability|productivity.score|verification.strength/i);
});

test("validated hotspot claims fail closed without a V1 calibration artifact contract", () => {
  const current = calibrationSnapshot();
  assert.throws(
    () => deriveHotspots(current, {
      model_validation: {
        model_id: "heuristic-v1",
        requested_status: "validated",
        training_ids: ["repo:a", "repo:b"],
        holdout_ids: ["repo:b", "repo:c"],
        evidence_refs: ["artifact:validation.json"],
      },
    }),
    /FAIL-TRAIN-TEST-LEAKAGE/,
  );
  assert.throws(
    () => deriveHotspots(current, { model_validation: { model_id: "heuristic-v1", requested_status: "calibrated" } }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );

  assert.throws(
    () => deriveHotspots(current, {
      model_validation: {
        model_id: "heuristic-v1",
        requested_status: "validated",
        training_ids: ["repo:a"],
        holdout_ids: ["repo:b"],
        evidence_refs: ["artifact:validation.json"],
        calibration_method: "pre-registered-thresholds",
      },
    }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );
});

test("calibration rejects blank, duplicate, and normalized-overlapping holdout evidence", () => {
  const current = calibrationSnapshot();
  const valid = {
    model_id: "heuristic-v1",
    requested_status: "validated",
    training_ids: ["repo:training"],
    holdout_ids: ["repo:holdout"],
    evidence_refs: ["artifact:validation.json"],
    calibration_method: "pre-registered-thresholds",
  };
  for (const invalid of [
    { calibration_method: "   " },
    { training_ids: ["repo:training", "repo:training"] },
    { training_ids: ["repo:training", " "] },
    { holdout_ids: ["repo:holdout", "repo:holdout"] },
    { evidence_refs: ["artifact:validation.json", " "] },
  ]) {
    assert.throws(
      () => deriveHotspots(current, { model_validation: { ...valid, ...invalid } }),
      /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
    );
  }
  assert.throws(
    () => deriveHotspots(current, {
      model_validation: { ...valid, training_ids: [" repo:training "], holdout_ids: ["repo:training"] },
    }),
    /FAIL-TRAIN-TEST-LEAKAGE/,
  );
});

test("calibration requests from every supplied source must deeply agree", () => {
  const valid = {
    model_id: "heuristic-v1",
    requested_status: "validated",
    training_ids: ["repo:training"],
    holdout_ids: ["repo:holdout"],
    evidence_refs: ["artifact:validation.json"],
    calibration_method: "pre-registered-thresholds",
  };
  const current = calibrationSnapshot();
  assert.throws(
    () => deriveHotspots(current, {
      model_validation: valid,
      validation: { ...valid, holdout_ids: ["repo:training"] },
    }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION|FAIL-TRAIN-TEST-LEAKAGE/,
  );
  assert.throws(
    () => deriveHotspots({
      ...current,
      risk_models: [
        { risk_model_id: "heuristic-v1", model_status: "validated", validation: valid },
        { risk_model_id: "heuristic-v1", model_status: "validated", validation: { ...valid, calibration_method: "different-method" } },
      ],
    }, { model_validation: valid }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );
  assert.throws(
    () => deriveHotspots({
      ...current,
      risk_models: [{ risk_model_id: "heuristic-v1", model_status: "validated", status: "heuristic", validation: valid }],
    }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );
  assert.throws(
    () => deriveHotspots(current, {
      model_validation: valid,
      validation: { ...valid, ignored_metadata: "must-not-bypass-agreement" },
    }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );
  assert.throws(
    () => deriveHotspots({
      ...current,
      risk_models: [{ risk_model_id: "heuristic-v1", model_status: "validated", validation: structuredClone(valid) }],
    }, {
      model_validation: structuredClone(valid),
      validation: structuredClone(valid),
    }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );
});

test("calibration ignores unbound and unrelated risk-model validation", () => {
  const current = calibrationSnapshot();
  const valid = {
    model_id: "heuristic-v1",
    requested_status: "validated",
    training_ids: ["repo:training"],
    holdout_ids: ["repo:holdout"],
    evidence_refs: ["artifact:validation.json"],
    calibration_method: "pre-registered-thresholds",
  };
  const unbound = structuredClone(valid);
  delete unbound.model_id;
  assert.equal(deriveHotspots(current, { model_validation: unbound }).model_status, "heuristic");
  assert.equal(
    deriveHotspots({
      ...current,
      risk_models: [{ risk_model_id: "other-model-v1", model_status: "validated", validation: valid }],
    }).model_status,
    "heuristic",
  );
});

test("calibration requires agreeing target aliases and fails closed in V1", () => {
  const current = calibrationSnapshot();
  const valid = {
    model_id: "heuristic-v1",
    requested_status: "validated",
    training_ids: ["repo:training"],
    holdout_ids: ["repo:holdout"],
    evidence_refs: ["artifact:validation.json"],
    calibration_method: "pre-registered-thresholds",
  };
  assert.throws(
    () => deriveHotspots(current, { model_validation: { ...valid, evidence_refs: ["missing:artifact"] } }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );
  assert.throws(
    () => deriveHotspots(current, {
      model_validation: { ...valid, risk_model_id: "heuristic-v1", model_id: "other-model-v1" },
    }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );
  assert.throws(
    () => deriveHotspots(current, { model_validation: valid }),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );
});

test("hotspots exclude generated and non-human scopes from feature cohorts", () => {
  const generatedScope = {
    kind: "file",
    path: "src/generated.js",
    language: "javascript",
    generated_code: true,
    included_in_human_maintainability: true,
  };
  const nonHumanScope = {
    kind: "file",
    path: "src/external.js",
    language: "javascript",
    generated_code: false,
    included_in_human_maintainability: false,
  };
  const result = deriveHotspots(snapshot([
    metric({ id: "git.churn:src/low.js", definition: "sei.git.churn@1", subject: "file:src/low.js", value: 1, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/low.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/low.js", value: 1, unit: "depth" }),
    metric({ id: "git.churn:src/high.js", definition: "sei.git.churn@1", subject: "file:src/high.js", value: 10, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/high.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/high.js", value: 10, unit: "depth" }),
    metric({ id: "git.churn:src/generated.js", definition: "sei.git.churn@1", subject: "file:src/generated.js", value: 0, unit: "lines-changed", scope: generatedScope }),
    metric({ id: "static.lexical_max_nesting_depth:src/generated.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/generated.js", value: 0, unit: "depth", scope: generatedScope }),
    metric({ id: "git.churn:src/external.js", definition: "sei.git.churn@1", subject: "file:src/external.js", value: 0, unit: "lines-changed", scope: nonHumanScope }),
    metric({ id: "static.lexical_max_nesting_depth:src/external.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/external.js", value: 0, unit: "depth", scope: nonHumanScope }),
  ]));

  assert.deepEqual(result.features.map((feature) => feature.subject), ["file:src/high.js", "file:src/low.js"]);
  const high = result.features.find((feature) => feature.subject === "file:src/high.js");
  assert.ok(high.vector.every((feature) => feature.cohort_size === 2));
  assert.deepEqual(high.hotspot_signals, []);
});

test("hotspots require a canonical file scope aligned to each file subject", () => {
  const mismatchedScope = {
    kind: "file",
    path: "src/not-the-subject.js",
    language: "javascript",
    generated_code: false,
    included_in_human_maintainability: true,
  };
  const repositoryScope = {
    kind: "repository",
    path: "src/repository-scoped.js",
    language: "javascript",
    generated_code: false,
    included_in_human_maintainability: true,
  };
  const result = deriveHotspots(snapshot([
    metric({ id: "git.churn:src/low.js", definition: "sei.git.churn@1", subject: "file:src/low.js", value: 1, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/low.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/low.js", value: 1, unit: "depth" }),
    metric({ id: "git.churn:src/high.js", definition: "sei.git.churn@1", subject: "file:src/high.js", value: 10, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/high.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/high.js", value: 10, unit: "depth" }),
    metric({ id: "git.churn:src/mismatched.js", definition: "sei.git.churn@1", subject: "file:src/mismatched.js", value: 100, unit: "lines-changed", scope: mismatchedScope }),
    metric({ id: "static.lexical_max_nesting_depth:src/mismatched.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/mismatched.js", value: 100, unit: "depth", scope: mismatchedScope }),
    metric({ id: "git.churn:src/repository-scoped.js", definition: "sei.git.churn@1", subject: "file:src/repository-scoped.js", value: 100, unit: "lines-changed", scope: repositoryScope }),
    metric({ id: "static.lexical_max_nesting_depth:src/repository-scoped.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/repository-scoped.js", value: 100, unit: "depth", scope: repositoryScope }),
  ]));

  assert.deepEqual(result.features.map((feature) => feature.subject), ["file:src/high.js", "file:src/low.js"]);
  const high = result.features.find((feature) => feature.subject === "file:src/high.js");
  assert.ok(high.vector.every((feature) => feature.cohort_size === 2));
  assert.deepEqual(high.hotspot_signals, []);
});

test("hotspots canonicalize file subject aliases before duplicate and cohort identity", () => {
  const aliases = ["file:src/a.js", "file:src\\a.js", "file: src/a.js "];
  const rows = aliases.map((subject, index) => metric({
    id: `git.churn:alias-${index}`,
    definition: "sei.git.churn@1",
    subject,
    value: index + 1,
    unit: "lines-changed",
  }));

  assert.throws(
    () => deriveHotspots(snapshot(rows)),
    /FAIL-AMBIGUOUS-METRIC-OBSERVATION/,
  );
});

test("hotspots canonicalize duplicate-slash and dot file paths before cohorts or signals", () => {
  const aliases = ["file:src/a.js", "file:src//a.js", "file:src/./a.js"];
  const conflictingRows = aliases.map((subject, index) => metric({
    id: `git.churn:path-alias-${index}`,
    definition: "sei.git.churn@1",
    subject,
    value: index + 1,
    unit: "lines-changed",
  }));
  assert.throws(
    () => deriveHotspots(snapshot(conflictingRows)),
    /FAIL-AMBIGUOUS-METRIC-OBSERVATION/,
  );

  const grouped = deriveHotspots(snapshot([
    metric({ id: "git.churn:src/a.js", definition: "sei.git.churn@1", subject: "file:src/a.js", value: 100, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/a.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src//a.js", value: 100, unit: "depth" }),
    metric({ id: "git.churn:src/b.js", definition: "sei.git.churn@1", subject: "file:src/b.js", value: 1, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/b.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/b.js", value: 1, unit: "depth" }),
    metric({ id: "git.churn:src/c.js", definition: "sei.git.churn@1", subject: "file:src/c.js", value: 2, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/c.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/c.js", value: 2, unit: "depth" }),
  ]));
  assert.deepEqual(grouped.features.map((feature) => feature.subject), ["file:src/a.js", "file:src/b.js", "file:src/c.js"]);
  const a = grouped.features.find((feature) => feature.subject === "file:src/a.js");
  assert.ok(a.vector.every((feature) => feature.cohort_size === 3));
  assert.equal(a.hotspot_signals.length, 1);

  const escaped = deriveHotspots(snapshot([
    metric({ id: "git.churn:escaped", definition: "sei.git.churn@1", subject: "file:src/../outside.js", value: 100, unit: "lines-changed" }),
  ]));
  assert.deepEqual(escaped.features, []);

  const driveAbsolute = deriveHotspots(snapshot([
    metric({ id: "git.churn:drive-absolute", definition: "sei.git.churn@1", subject: "file:C:/repo/src/a.js", value: 100, unit: "lines-changed" }),
  ]));
  assert.deepEqual(driveAbsolute.features, []);
});

test("a one-file feature cohort cannot create a coincidence hotspot signal", () => {
  const result = deriveHotspots(snapshot([
    metric({ id: "git.churn:src/only.js", definition: "sei.git.churn@1", subject: "file:src/only.js", value: 120, unit: "lines-changed" }),
    metric({ id: "static.lexical_max_nesting_depth:src/only.js", definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/only.js", value: 7, unit: "lexical-brace-or-indentation-depth" }),
  ]));
  assert.deepEqual(result.features[0].hotspot_signals, []);
});

test("direct hotspot derivation rejects duplicate file feature identities", () => {
  const rows = ["a", "b", "c"].flatMap((suffix) => [
    metric({ id: `git.churn:src/only.js:${suffix}`, definition: "sei.git.churn@1", subject: "file:src/only.js", value: 120, unit: "lines-changed" }),
    metric({ id: `static.lexical_max_nesting_depth:src/only.js:${suffix}`, definition: "sei.static.lexical_max_nesting_depth@1", subject: "file:src/only.js", value: 7, unit: "lexical-brace-or-indentation-depth" }),
  ]);
  assert.throws(() => deriveHotspots(snapshot(rows)), /FAIL-AMBIGUOUS-METRIC-OBSERVATION/);
  assert.throws(
    () => compareSnapshots(snapshot([rows[0]], { snapshot_id: "prior" }), snapshot(rows, { snapshot_id: "current" })),
    /FAIL-AMBIGUOUS-METRIC-OBSERVATION/,
  );
});

test("direct interpretation rejects duplicate metric IDs before vector or trend lookup", () => {
  const first = metric({
    id: "git.churn:src/low.js",
    definition: "sei.git.churn@1",
    subject: "file:src/low.js",
    value: 1,
    unit: "lines-changed",
  });
  const duplicate = { ...structuredClone(first), value: 999 };
  assert.throws(() => deriveHotspots(snapshot([first, duplicate])), /FAIL-AMBIGUOUS-METRIC-OBSERVATION/);
  assert.throws(
    () => compareSnapshots(snapshot([first, duplicate], { snapshot_id: "prior" }), snapshot([first], { snapshot_id: "current" })),
    /FAIL-AMBIGUOUS-METRIC-OBSERVATION/,
  );
  assert.throws(
    () => compareSnapshots(snapshot([first], { snapshot_id: "prior" }), snapshot([first, duplicate], { snapshot_id: "current" })),
    /FAIL-AMBIGUOUS-METRIC-OBSERVATION/,
  );
});

test("snapshot trends require schema, definition, unit, analyzer, configuration, and valid source compatibility", () => {
  const { prior, current } = comparablePair();
  const comparable = compareSnapshots(prior, current);
  assert.equal(comparable.status, "comparable");
  assert.equal(comparable.trends[0].delta, 4);

  const changedDefinition = compareSnapshots(
    prior,
    { ...current, measurements: [{ ...current.measurements[0], definition_id: "sei.git.churn@2" }] },
  );
  assert.equal(changedDefinition.status, "incomparable");
  assert.equal("delta" in changedDefinition.trends[0], false);
  assert.match(changedDefinition.trends[0].reason, /definition/i);

  const unavailable = compareSnapshots(
    prior,
    { ...current, measurements: [{ ...current.measurements[0], value: null, measurement: { status: "unavailable" } }] },
  );
  assert.equal(unavailable.status, "incomparable");
  assert.equal("delta" in unavailable.trends[0], false);
});

test("factual comparison bindings are checked against the supplied prior observation", () => {
  const pair = comparablePair();
  pair.prior.measurements[0].measurement.confidence = 0.7;
  pair.current.measurements[0].measurement.confidence = 0.8;
  Object.assign(pair.current.measurements[0].comparison, {
    binding_kind: "automatic",
    baseline_repository_revision: pair.prior.repository.revision,
    baseline_value: pair.prior.measurements[0].value,
    delta: 4,
    confidence: 0.7,
  });
  assert.equal(compareSnapshots(pair.prior, pair.current, { require_explicit_baseline: true }).status, "comparable");

  for (const [label, mutate] of [
    ["revision", (comparison) => { comparison.baseline_repository_revision = "revision-other"; }],
    ["value", (comparison) => { comparison.baseline_value = 11; }],
    ["delta", (comparison) => { comparison.delta = 3; }],
    ["confidence", (comparison) => { comparison.confidence = 0.8; }],
  ]) {
    const current = structuredClone(pair.current);
    mutate(current.measurements[0].comparison);
    const result = compareSnapshots(pair.prior, current, { require_explicit_baseline: true });
    assert.equal(result.status, "incomparable", label);
    assert.match(result.trends[0].reason, /baseline|delta|confidence/i, label);
  }
});

test("snapshot trends require source-bound evidence references before emitting a delta", () => {
  for (const side of ["prior", "current"]) {
    const pair = comparablePair();
    pair[side].measurements[0].source.evidence_refs = [];
    const result = compareSnapshots(pair.prior, pair.current);
    assert.equal(result.status, "incomparable", side);
    assert.equal(result.trends[0].status, "incomparable", side);
    assert.equal("delta" in result.trends[0], false, side);
    assert.match(result.trends[0].reason, /evidence/i, side);
  }
});

test("a snapshot without prior metric history reports insufficient history, not a zero delta", () => {
  const { prior, current } = comparablePair();
  const genuinelyNew = structuredClone(current);
  genuinelyNew.measurements[0].comparability.compatible_with_prior = false;
  genuinelyNew.measurements[0].comparability.reason = "first observation";
  delete genuinelyNew.measurements[0].comparison;
  const result = compareSnapshots(
    { ...prior, measurements: [] },
    genuinelyNew,
  );
  assert.equal(result.status, "insufficient_history");
  assert.equal(result.trends[0].status, "insufficient_history");
  assert.equal("delta" in result.trends[0], false);
});

test("an explicit baseline keeps unavailable prior evidence insufficient while retaining other compatible deltas", () => {
  const { prior, current } = comparablePair();
  const priorUnavailable = metric({
    id: "git.first_observed_metric",
    definition: "sei.git.first_observed_metric@1",
    value: null,
    unit: "events",
    status: "not-applicable",
    repositoryRevision: "revision-a",
    compatible: false,
  });
  const currentObserved = metric({
    id: priorUnavailable.metric_id,
    definition: priorUnavailable.definition_id,
    value: 2,
    unit: priorUnavailable.unit,
    repositoryRevision: "revision-b",
    compatible: false,
  });
  prior.measurements.push(priorUnavailable);
  current.measurements.push(currentObserved);

  const result = compareSnapshots(prior, current, { require_explicit_baseline: true });
  const retained = result.trends.find((trend) => trend.metric_id === "git.churn");
  const insufficient = result.trends.find((trend) => trend.metric_id === priorUnavailable.metric_id);

  assert.equal(result.status, "mixed");
  assert.equal(retained.status, "comparable");
  assert.equal(retained.delta, 4);
  assert.equal(insufficient.status, "insufficient_history");
  assert.equal("delta" in insufficient, false);
});

test("an explicit baseline keeps intentionally non-comparable degraded discovery metrics insufficient", () => {
  const { prior, current } = comparablePair();
  const discoveryCollector = {
    collector_id: "test-discovery",
    collector_version: "1.0.0",
    analyzer_identity: "sei.discovery.test@1",
    analyzer_version: "1.0.0",
    status: "degraded",
    reason: "test configuration was observed; execution results were not observed",
  };
  prior.collectors.push(structuredClone(discoveryCollector));
  current.collectors.push(structuredClone(discoveryCollector));
  const priorDiscovery = metric({
    id: "discovery.test_evidence_path_count",
    definition: "sei.discovery.test_evidence_path_count@1",
    subject: "repository:revision-bound-verification-discovery",
    value: 2,
    unit: "paths",
    analyzer: discoveryCollector.analyzer_identity,
    repositoryRevision: "revision-a",
    compatible: false,
  });
  const currentDiscovery = metric({
    id: priorDiscovery.metric_id,
    definition: priorDiscovery.definition_id,
    subject: priorDiscovery.subject,
    value: 3,
    unit: priorDiscovery.unit,
    analyzer: discoveryCollector.analyzer_identity,
    repositoryRevision: "revision-b",
    compatible: false,
  });
  priorDiscovery.source.collector_id = discoveryCollector.collector_id;
  currentDiscovery.source.collector_id = discoveryCollector.collector_id;
  prior.measurements.push(priorDiscovery);
  current.measurements.push(currentDiscovery);

  const result = compareSnapshots(prior, current, { require_explicit_baseline: true });
  const discoveryTrend = result.trends.find((trend) => trend.metric_id === priorDiscovery.metric_id);
  assert.equal(result.status, "mixed");
  assert.equal(discoveryTrend.status, "insufficient_history");
  assert.equal("delta" in discoveryTrend, false);
});

test("current-only trends validate identity, source, window, collector, and baseline bindings", () => {
  const { prior, current } = comparablePair();
  const newMetric = () => metric({
    id: "git.new_metric",
    definition: "sei.git.new_metric@1",
    value: 4,
    unit: "events",
    repositoryRevision: "revision-b",
    compatible: false,
  });
  const validNew = compareSnapshots(prior, { ...current, measurements: [newMetric()] });
  assert.equal(validNew.status, "insufficient_history");
  assert.equal(validNew.trends[0].status, "insufficient_history");

  for (const [label, mutate] of [
    ["identity", (metricRecord) => { metricRecord.subject = " "; }],
    ["source", (metricRecord) => { metricRecord.source.repository_revision = "wrong-revision"; }],
    ["window", (metricRecord) => { metricRecord.window = { kind: "rolling", start: null, end: "revision-b" }; }],
    ["collector", (metricRecord) => { metricRecord.source.collector_id = "missing-collector"; }],
    ["baseline", (metricRecord) => { metricRecord.comparability.compatible_with_prior = true; }],
  ]) {
    const currentOnly = newMetric();
    mutate(currentOnly);
    const result = compareSnapshots(prior, { ...current, measurements: [currentOnly] });
    assert.equal(result.status, "incomparable", label);
    assert.equal(result.trends[0].status, "incomparable", label);
    assert.equal("delta" in result.trends[0], false, label);
  }
});

test("current-only metrics cannot fabricate an existing comparison baseline", () => {
  for (const [label, baselineSnapshotId, baselineMetricId] of [
    ["missing snapshot", "snapshot-missing", "git.churn"],
    ["different metric", "snapshot-prior", "git.churn"],
  ]) {
    const { prior, current } = comparablePair();
    const claimed = metric({
      id: "git.new_metric",
      definition: "sei.git.new_metric@1",
      value: 4,
      unit: "events",
      repositoryRevision: "revision-b",
      compatible: true,
      comparison: {
        baseline_snapshot_id: baselineSnapshotId,
        baseline_metric_id: baselineMetricId,
        analyzer_identity: "sei.fixture@1",
        analyzer_version: "1.0.0",
        configuration_hash: "config-a",
      },
    });
    const result = compareSnapshots(prior, { ...current, measurements: [claimed] });
    assert.equal(result.status, "incomparable", label);
    assert.equal(result.trends[0].status, "incomparable", label);
    assert.equal("delta" in result.trends[0], false, label);
    assert.match(result.trends[0].reason, /baseline/i, label);
  }
});

test("snapshot trends fail closed on blank or unbound schema, identity, revision, and window metadata", () => {
  const { prior: priorFixture, current: currentFixture } = comparablePair();
  const cases = [
    ["schema", (left, right) => { left.schema_version = " "; right.schema_version = " "; }],
    ["repository", (left, right) => { left.repository.repository_id = " "; right.repository.repository_id = " "; }],
    ["definition", (left, right) => { left.measurements[0].definition_id = " "; right.measurements[0].definition_id = " "; }],
    ["analyzer identity", (left, right) => { left.measurements[0].analyzer_identity = " "; right.measurements[0].analyzer_identity = " "; }],
    ["analyzer version", (left, right) => { left.measurements[0].analyzer_version = " "; right.measurements[0].analyzer_version = " "; }],
    ["subject", (left, right) => { left.measurements[0].subject = " "; right.measurements[0].subject = " "; }],
    ["unit", (left, right) => { left.measurements[0].unit = " "; right.measurements[0].unit = " "; }],
    ["configuration", (left, right) => { left.repository.configuration_hash = " "; right.repository.configuration_hash = " "; }],
    ["revision", (left, right) => { left.repository.revision = " "; right.repository.revision = " "; }],
    ["metric revision binding", (current) => { current.measurements[0].repository_revision = "other-revision"; }],
    ["source revision binding", (current) => { current.measurements[0].source.repository_revision = "other-revision"; }],
    ["window end", (current) => { current.measurements[0].window.end = " "; }],
    ["window start", (_left, right) => { right.measurements[0].window.start = "revision-a"; }],
  ];
  for (const [label, mutate] of cases) {
    const prior = structuredClone(priorFixture);
    const current = structuredClone(currentFixture);
    current.snapshot_id = `current-${label}`;
    current.measurements[0].comparison.baseline_snapshot_id = prior.snapshot_id;
    mutate(prior, current);
    const result = compareSnapshots(prior, current);
    assert.notEqual(result.status, "comparable", label);
    assert.equal("delta" in result.trends[0], false, label);
  }
});

test("trends require ordered snapshot identities, valid static windows, baseline bindings, and unique collectors", () => {
  const fixture = comparablePair();
  const staticWithBroaderHistory = compareSnapshots(structuredClone(fixture.prior), structuredClone(fixture.current));
  assert.equal(staticWithBroaderHistory.status, "comparable");
  const staticWithEarlierRepositoryHistory = structuredClone(fixture.current);
  staticWithEarlierRepositoryHistory.repository.history_boundary.start = "revision-before-prior";
  assert.equal(
    compareSnapshots(structuredClone(fixture.prior), staticWithEarlierRepositoryHistory).status,
    "comparable",
  );
  for (const [label, mutate] of [
    ["blank snapshot id", (_prior, current) => { current.snapshot_id = " "; }],
    ["same snapshot id", (prior, current) => { current.snapshot_id = prior.snapshot_id; }],
    ["same revision", (_prior, current) => { current.repository.revision = "revision-a"; }],
    ["blank ordered boundary", (_prior, current) => { current.repository.history_boundary.start = " "; }],
    ["foreign metric window kind", (_prior, current) => { current.measurements[0].window.kind = "rolling"; }],
    ["foreign static window start", (_prior, current) => { current.measurements[0].window.start = "revision-a"; }],
    ["missing comparison", (_prior, current) => { delete current.measurements[0].comparison; }],
    ["wrong baseline metric", (_prior, current) => { current.measurements[0].comparison.baseline_metric_id = "other"; }],
    ["duplicate collector", (_prior, current) => { current.collectors.push(structuredClone(current.collectors[0])); }],
  ]) {
    const prior = structuredClone(fixture.prior);
    const current = structuredClone(fixture.current);
    mutate(prior, current);
    const result = compareSnapshots(prior, current);
    assert.notEqual(result.status, "comparable", label);
    assert.equal("delta" in result.trends[0], false, label);
  }
});

test("snapshot trends require exact collector and profile contract bindings", () => {
  const { prior: priorFixture, current: currentFixture } = comparablePair();
  const profile = {
    profile_id: "SPACE",
    profile_version: "1.0.0",
    profile_contract_hash: `sha256:${"a".repeat(64)}`,
  };

  for (const [label, mutate] of [
    ["collector version", (_prior, current) => { current.collectors[0].collector_version = "2.0.0"; }],
    ["collector status", (_prior, current) => { current.collectors[0].status = "degraded"; }],
    ["collector analyzer", (_prior, current) => { current.collectors[0].analyzer_version = "2.0.0"; }],
    ["profile inventory", (_prior, current) => { current.profiles = []; }],
    ["profile contract", (_prior, current) => { current.profiles[0].profile_contract_hash = `sha256:${"b".repeat(64)}`; }],
  ]) {
    const prior = structuredClone(priorFixture);
    const current = structuredClone(currentFixture);
    prior.profiles = [structuredClone(profile)];
    current.profiles = [structuredClone(profile)];
    mutate(prior, current);

    const result = compareSnapshots(prior, current);
    assert.equal(result.status, "incomparable", label);
    assert.equal(result.trends[0].status, "incomparable", label);
    assert.equal("delta" in result.trends[0], false, label);
  }
});

test("same-ID measurements need an explicit canonical baseline binding before emitting a delta", () => {
  const { prior, current } = comparablePair();
  delete current.measurements[0].comparison;
  current.measurements[0].comparability.compatible_with_prior = false;
  current.measurements[0].comparability.reason = "no explicit canonical baseline was supplied";

  const result = compareSnapshots(prior, current, { require_explicit_baseline: true });
  assert.equal(result.status, "incomparable");
  assert.equal(result.trends[0].status, "incomparable");
  assert.equal("delta" in result.trends[0], false);
  assert.match(result.trends[0].reason, /explicit baseline/i);
});
