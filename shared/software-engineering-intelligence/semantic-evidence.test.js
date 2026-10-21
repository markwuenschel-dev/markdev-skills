"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const semanticEvidence = require("./semantic-evidence.js");
const {
  SEMANTIC_EVIDENCE_VERSION,
  deriveEvidence,
  interpretEvidence,
} = semanticEvidence;

function observedInput(overrides = {}) {
  return {
    value: 42,
    measurement: { status: "measured", completeness: 1, confidence: 1 },
    collector: { status: "available", binding_valid: true },
    condition: { kind: "observed", code: null },
    source_metric_ids: ["git.observed_text_churn:src/core.js"],
    evidence_refs: ["git:src/core.js"],
    exclusions: [],
    ...overrides,
  };
}

test("complete observed evidence is usable and immutable", () => {
  const result = interpretEvidence(observedInput());

  assert.deepEqual(Object.keys(semanticEvidence).sort(), [
    "SEMANTIC_EVIDENCE_VERSION",
    "deriveEvidence",
    "interpretEvidence",
  ]);
  assert.equal(SEMANTIC_EVIDENCE_VERSION, "sei.semantic-evidence@1");
  assert.deepEqual(result, {
    semantic_evidence_version: "sei.semantic-evidence@1",
    state: "complete",
    usable: true,
    value: 42,
    coverage: 1,
    confidence: 1,
    condition: { kind: "observed", code: null },
    source_metric_ids: ["git.observed_text_churn:src/core.js"],
    evidence_refs: ["git:src/core.js"],
    exclusions: [],
    partiality_reasons: [],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.condition), true);
  assert.equal(Object.isFrozen(result.source_metric_ids), true);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test("141 of 145 observed commits remain usable strong-partial evidence under a degraded collector", () => {
  const coverage = 141 / 145;
  const result = interpretEvidence(observedInput({
    measurement: { status: "measured", completeness: coverage, confidence: coverage },
    collector: { status: "degraded", binding_valid: true },
    condition: { kind: "observed", code: "merge-resolution-churn-unattributed" },
    exclusions: [{ code: "merge-resolution-churn-unattributed", count: 4, value_affecting: true }],
  }));

  assert.equal(result.state, "strong-partial");
  assert.equal(result.usable, true);
  assert.equal(result.value, 42);
  assert.equal(result.coverage, coverage);
  assert.equal(result.confidence, coverage);
  assert.deepEqual(result.exclusions, [
    { code: "merge-resolution-churn-unattributed", count: 4, value_affecting: true },
  ]);
  assert.deepEqual(result.partiality_reasons, [
    "confidence-below-complete",
    "coverage-below-complete",
    "value-affecting-exclusion:merge-resolution-churn-unattributed",
  ]);
  assert.equal(Object.isFrozen(result.exclusions[0]), true);
});

test("structured non-observation conditions map to the complete human taxonomy without becoming usable", () => {
  const cases = [
    ["configured-not-observed", "configuration-found-execution-not-observed", "degraded"],
    ["not-detected", "repository-evidence-not-detected", "unavailable"],
    ["external-required", "external-review-metadata-required", "unavailable"],
    ["unsupported", "kotlin-parser-unsupported", "unavailable"],
    ["resource-limited", "clone-candidate-limit-reached", "unavailable"],
    ["first-observation", "no-prior-compatible-observation", "available"],
    ["prior-not-current", "prior-evaluation-not-current", "available"],
    ["not-applicable", "history-window-empty", "available"],
    ["unresolved", "machine-condition-not-classified", "degraded"],
  ];

  for (const [kind, code, collectorStatus] of cases) {
    const result = interpretEvidence(observedInput({
      value: null,
      measurement: { status: kind === "not-applicable" ? "not-applicable" : "unavailable", completeness: 0, confidence: 0 },
      collector: { status: collectorStatus, binding_valid: true },
      condition: { kind, code },
      source_metric_ids: [`fixture.${kind}`],
      evidence_refs: [`fixture:${kind}`],
    }));

    assert.equal(result.state, kind, kind);
    assert.equal(result.usable, false, kind);
    assert.equal(result.value, null, kind);
    assert.equal(result.coverage, 0, kind);
    assert.equal(result.confidence, 0, kind);
    assert.deepEqual(result.partiality_reasons, [], kind);
  }
});

test("derived evidence conservatively propagates mixed inputs with deterministic unions and ordering", () => {
  const coverage = 141 / 145;
  const structural = interpretEvidence(observedInput({
    value: 0.96,
    source_metric_ids: ["static.cyclomatic:src/core.js"],
    evidence_refs: ["static:core", "shared:core"],
  }));
  const behavioral = interpretEvidence(observedInput({
    value: 0.94,
    measurement: { status: "measured", completeness: coverage, confidence: coverage },
    collector: { status: "degraded", binding_valid: true },
    condition: { kind: "observed", code: "merge-resolution-churn-unattributed" },
    source_metric_ids: ["git.observed_text_churn:src/core.js"],
    evidence_refs: ["git:core", "shared:core"],
    exclusions: [{ code: "merge-resolution-churn-unattributed", count: 4, value_affecting: true }],
  }));
  const directExclusions = [
    { code: "unsupported-cohort-subject", count: 2, value_affecting: false },
    { code: "merge-resolution-churn-unattributed", count: 4, value_affecting: true },
  ];

  const forward = deriveEvidence({
    operation: "structural-behavioral-percentile",
    value: 0.95,
    inputs: [structural, behavioral],
    exclusions: directExclusions,
  });
  const reversed = deriveEvidence({
    operation: "structural-behavioral-percentile",
    value: 0.95,
    inputs: [behavioral, structural],
    exclusions: directExclusions.slice().reverse(),
  });

  assert.deepEqual(reversed, forward);
  assert.equal(forward.state, "strong-partial");
  assert.equal(forward.usable, true);
  assert.equal(forward.coverage, coverage);
  assert.equal(forward.confidence, coverage);
  assert.deepEqual(forward.condition, { kind: "derived", code: "structural-behavioral-percentile" });
  assert.deepEqual(forward.source_metric_ids, [
    "git.observed_text_churn:src/core.js",
    "static.cyclomatic:src/core.js",
  ]);
  assert.deepEqual(forward.evidence_refs, ["git:core", "shared:core", "static:core"]);
  assert.deepEqual(forward.exclusions, [
    { code: "merge-resolution-churn-unattributed", count: 4, value_affecting: true },
    { code: "unsupported-cohort-subject", count: 2, value_affecting: false },
  ]);
  assert.deepEqual(forward.partiality_reasons, [
    "confidence-below-complete",
    "coverage-below-complete",
    "value-affecting-exclusion:merge-resolution-churn-unattributed",
  ]);
  assert.equal(Object.isFrozen(forward), true);
  assert.equal(Object.isFrozen(forward.exclusions), true);
});

test("usable numeric evidence follows the complete, strong-partial, and partial decision", () => {
  const valueAffecting = [{ code: "one-row-excluded", count: 1, value_affecting: true }];
  const informational = [{ code: "diagnostic-only", count: 1, value_affecting: false }];

  assert.equal(interpretEvidence(observedInput({
    measurement: { status: "measured", completeness: 0.89, confidence: 1 },
  })).state, "partial");
  assert.equal(interpretEvidence(observedInput({ exclusions: valueAffecting })).state, "strong-partial");
  assert.equal(interpretEvidence(observedInput({ exclusions: informational })).state, "complete");
});

test("semantic evidence rejects open, malformed, unbound, and forged records", () => {
  const complete = interpretEvidence(observedInput());
  const invalidInterpretations = [
    { ...observedInput(), unexpected: true },
    { ...observedInput(), measurement: { ...observedInput().measurement, extra: true } },
    { ...observedInput(), collector: { status: "partial", binding_valid: true } },
    { ...observedInput(), collector: { status: "unavailable", binding_valid: true } },
    { ...observedInput(), collector: { status: "available", binding_valid: false } },
    { ...observedInput(), condition: { kind: "degraded", code: null } },
    { ...observedInput(), measurement: { status: "measured", completeness: 1.1, confidence: 1 } },
    { ...observedInput(), source_metric_ids: [" "] },
    { ...observedInput(), exclusions: [{ code: "excluded", count: 1, value_affecting: true, extra: true }] },
    [],
  ];
  for (const input of invalidInterpretations) {
    assert.throws(
      () => interpretEvidence(input),
      (error) => error?.code === "FAIL-SEMANTIC-EVIDENCE",
    );
  }

  const invalidDerivations = [
    { operation: "sum", value: 1, inputs: [complete], exclusions: [], unexpected: true },
    { operation: "sum", value: 1, inputs: [], exclusions: [] },
    { operation: " ", value: 1, inputs: [complete], exclusions: [] },
    { operation: "sum", value: Number.NaN, inputs: [complete], exclusions: [] },
    {
      operation: "sum",
      value: 1,
      inputs: [{ ...complete, semantic_evidence_version: "forged" }],
      exclusions: [],
    },
  ];
  for (const input of invalidDerivations) {
    assert.throws(
      () => deriveEvidence(input),
      (error) => error?.code === "FAIL-SEMANTIC-EVIDENCE",
    );
  }
});

test("an unusable required input yields a closed unresolved record that remains composable", () => {
  const unsupported = interpretEvidence(observedInput({
    value: null,
    measurement: { status: "unavailable", completeness: 0, confidence: 0 },
    collector: { status: "unavailable", binding_valid: true },
    condition: { kind: "unsupported", code: "runtime-not-supported" },
  }));
  const unresolved = deriveEvidence({
    operation: "x".repeat(512),
    value: 1,
    inputs: [interpretEvidence(observedInput()), unsupported],
    exclusions: [],
  });

  assert.equal(unresolved.state, "unresolved");
  assert.equal(unresolved.usable, false);
  assert.equal(unresolved.value, null);
  assert.deepEqual(unresolved.condition, { kind: "unresolved", code: "required-input-unusable" });
  assert.doesNotThrow(() => deriveEvidence({
    operation: "retry",
    value: 1,
    inputs: [unresolved],
    exclusions: [],
  }));
});
