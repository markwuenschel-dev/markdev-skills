"use strict";

const SEMANTIC_EVIDENCE_VERSION = "sei.semantic-evidence@1";
const MAX_ITEMS = 10_000;
const MAX_TEXT = 512;
const OBSERVED_STATES = new Set(["complete", "strong-partial", "partial"]);
const NON_OBSERVED_SEMANTIC_STATES = new Set([
  "configured-not-observed",
  "not-detected",
  "external-required",
  "unsupported",
  "resource-limited",
  "first-observation",
  "prior-not-current",
  "not-applicable",
  "unresolved",
]);
const MEASUREMENT_STATUSES = new Set(["measured", "inferred", "unavailable", "not-applicable", "unverifiable"]);
const COLLECTOR_STATUSES = new Set(["available", "degraded", "unavailable"]);
const SEMANTIC_RECORD_FIELDS = [
  "semantic_evidence_version",
  "state",
  "usable",
  "value",
  "coverage",
  "confidence",
  "condition",
  "source_metric_ids",
  "evidence_refs",
  "exclusions",
  "partiality_reasons",
];

function fail(detail) {
  const error = new Error(`FAIL-SEMANTIC-EVIDENCE: ${detail}`);
  error.code = "FAIL-SEMANTIC-EVIDENCE";
  throw error;
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosed(value, fields, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain closed record`);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field)).sort(stableCompare);
  if (unknown.length > 0) fail(`${label}.${unknown[0]} is not declared`);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length > 0) fail(`${label}.${missing[0]} is required`);
}

function validText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT
    && value.trim() === value && !value.includes("\0") && !/[\r\n]/.test(value);
}

function assertText(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!validText(value)) fail(`${label} must be a bounded nonblank string${nullable ? " or null" : ""}`);
}

function assertFraction(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) fail(`${label} must be a finite ratio from zero through one`);
}

function assertFiniteValue(value, label) {
  if (!Number.isFinite(value)) fail(`${label} must be a finite number`);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalStrings(values, label, { minimum = 0 } = {}) {
  if (!Array.isArray(values) || values.length < minimum || values.length > MAX_ITEMS) {
    fail(`${label} must contain from ${minimum} through ${MAX_ITEMS} entries`);
  }
  for (const [index, value] of values.entries()) assertText(value, `${label}[${index}]`);
  return [...new Set(values)].sort(stableCompare);
}

function canonicalExclusions(exclusions, label = "exclusions") {
  if (!Array.isArray(exclusions) || exclusions.length > MAX_ITEMS) {
    fail(`${label} must contain at most ${MAX_ITEMS} entries`);
  }
  const unique = new Map();
  for (const [index, exclusion] of exclusions.entries()) {
    assertClosed(exclusion, ["code", "count", "value_affecting"], `${label}[${index}]`);
    assertText(exclusion.code, `${label}[${index}].code`);
    if (!Number.isSafeInteger(exclusion.count) || exclusion.count < 1) {
      fail(`${label}[${index}].count must be a positive safe integer`);
    }
    if (typeof exclusion.value_affecting !== "boolean") {
      fail(`${label}[${index}].value_affecting must be boolean`);
    }
    const canonical = {
      code: exclusion.code,
      count: exclusion.count,
      value_affecting: exclusion.value_affecting,
    };
    unique.set(JSON.stringify(canonical), canonical);
  }
  return [...unique.values()].sort((left, right) => (
    stableCompare(left.code, right.code)
    || left.count - right.count
    || Number(left.value_affecting) - Number(right.value_affecting)
  ));
}

function observedState(coverage, confidence, exclusions) {
  const complete = coverage === 1 && confidence === 1
    && exclusions.every((exclusion) => exclusion.value_affecting === false);
  if (complete) return "complete";
  if (coverage >= 0.9 && confidence >= 0.9) return "strong-partial";
  return "partial";
}

function partialityReasons(coverage, confidence, exclusions) {
  return canonicalStrings([
    ...(coverage < 1 ? ["coverage-below-complete"] : []),
    ...(confidence < 1 ? ["confidence-below-complete"] : []),
    ...exclusions
      .filter((exclusion) => exclusion.value_affecting)
      .map((exclusion) => `value-affecting-exclusion:${exclusion.code}`),
  ], "partiality reasons");
}

function validateInterpretationInput(input) {
  assertClosed(input, [
    "value",
    "measurement",
    "collector",
    "condition",
    "source_metric_ids",
    "evidence_refs",
    "exclusions",
  ], "interpretation input");
  assertClosed(input.measurement, ["status", "completeness", "confidence"], "interpretation input.measurement");
  if (!MEASUREMENT_STATUSES.has(input.measurement.status)) fail("interpretation input.measurement.status is unsupported");
  assertFraction(input.measurement.completeness, "interpretation input.measurement.completeness");
  assertFraction(input.measurement.confidence, "interpretation input.measurement.confidence");
  assertClosed(input.collector, ["status", "binding_valid"], "interpretation input.collector");
  if (!COLLECTOR_STATUSES.has(input.collector.status)) fail("interpretation input.collector.status is unsupported");
  if (input.collector.binding_valid !== true) fail("interpretation input.collector must have a valid provenance binding");
  assertClosed(input.condition, ["kind", "code"], "interpretation input.condition");
  const observed = input.condition.kind === "observed";
  if (!observed && !NON_OBSERVED_SEMANTIC_STATES.has(input.condition.kind)) {
    fail("interpretation input.condition.kind is unsupported");
  }
  assertText(input.condition.code, "interpretation input.condition.code", { nullable: observed });
  if (observed) {
    assertFiniteValue(input.value, "interpretation input.value");
    if (!new Set(["measured", "inferred"]).has(input.measurement.status)) {
      fail("observed evidence requires a measured or inferred measurement status");
    }
    if (input.measurement.completeness === 0 || input.measurement.confidence === 0) {
      fail("observed evidence requires positive completeness and confidence");
    }
    if (input.collector.status === "unavailable") fail("observed evidence cannot come from an unavailable collector");
  } else {
    if (input.value !== null) fail("non-observed semantic evidence must have a null value");
    if (input.measurement.status === "measured" || input.measurement.status === "inferred") {
      fail("non-observed semantic evidence cannot have an observed measurement status");
    }
  }
  const sourceMetricIds = canonicalStrings(input.source_metric_ids, "interpretation input.source_metric_ids", { minimum: 1 });
  const evidenceRefs = canonicalStrings(input.evidence_refs, "interpretation input.evidence_refs", { minimum: 1 });
  const exclusions = canonicalExclusions(input.exclusions, "interpretation input.exclusions");
  return { observed, sourceMetricIds, evidenceRefs, exclusions };
}

function validateSemanticEvidence(evidence, label) {
  assertClosed(evidence, SEMANTIC_RECORD_FIELDS, label);
  if (evidence.semantic_evidence_version !== SEMANTIC_EVIDENCE_VERSION) fail(`${label}.semantic_evidence_version is unsupported`);
  if (!OBSERVED_STATES.has(evidence.state) && !NON_OBSERVED_SEMANTIC_STATES.has(evidence.state)) {
    fail(`${label}.state is unsupported`);
  }
  if (typeof evidence.usable !== "boolean") fail(`${label}.usable must be boolean`);
  assertFraction(evidence.coverage, `${label}.coverage`);
  assertFraction(evidence.confidence, `${label}.confidence`);
  assertClosed(evidence.condition, ["kind", "code"], `${label}.condition`);
  if (evidence.condition.kind !== "observed" && evidence.condition.kind !== "derived"
      && !NON_OBSERVED_SEMANTIC_STATES.has(evidence.condition.kind)) {
    fail(`${label}.condition.kind is unsupported`);
  }
  assertText(evidence.condition.code, `${label}.condition.code`, { nullable: evidence.condition.kind === "observed" });
  const sourceMetricIds = canonicalStrings(evidence.source_metric_ids, `${label}.source_metric_ids`, { minimum: 1 });
  const evidenceRefs = canonicalStrings(evidence.evidence_refs, `${label}.evidence_refs`, { minimum: 1 });
  const exclusions = canonicalExclusions(evidence.exclusions, `${label}.exclusions`);
  const reasons = canonicalStrings(evidence.partiality_reasons, `${label}.partiality_reasons`);
  if (JSON.stringify(sourceMetricIds) !== JSON.stringify(evidence.source_metric_ids)
      || JSON.stringify(evidenceRefs) !== JSON.stringify(evidence.evidence_refs)
      || JSON.stringify(exclusions) !== JSON.stringify(evidence.exclusions)
      || JSON.stringify(reasons) !== JSON.stringify(evidence.partiality_reasons)) {
    fail(`${label} must use canonical deterministic ordering`);
  }
  if (evidence.usable) {
    assertFiniteValue(evidence.value, `${label}.value`);
    if (!OBSERVED_STATES.has(evidence.state)) fail(`${label}.usable evidence must have an observed state`);
    if (evidence.condition.kind !== "observed" && evidence.condition.kind !== "derived") {
      fail(`${label}.usable evidence must have an observed or derived condition`);
    }
    if (evidence.coverage === 0 || evidence.confidence === 0) fail(`${label}.usable evidence requires positive coverage and confidence`);
    if (evidence.state !== observedState(evidence.coverage, evidence.confidence, exclusions)) {
      fail(`${label}.state does not match coverage, confidence, and exclusions`);
    }
    if (JSON.stringify(reasons) !== JSON.stringify(partialityReasons(evidence.coverage, evidence.confidence, exclusions))) {
      fail(`${label}.partiality_reasons do not match propagated uncertainty`);
    }
  } else {
    if (evidence.value !== null) fail(`${label}.unusable evidence must have a null value`);
    if (!NON_OBSERVED_SEMANTIC_STATES.has(evidence.state)) fail(`${label}.unusable evidence must have a non-observed state`);
    if (evidence.condition.kind !== evidence.state) fail(`${label}.condition.kind must match its non-observed state`);
    if (reasons.length > 0) fail(`${label}.unusable evidence cannot claim partial numeric reasons`);
  }
}

function interpretEvidence(input) {
  const validated = validateInterpretationInput(input);
  const coverage = input.measurement.completeness;
  const confidence = input.measurement.confidence;
  return deepFreeze({
    semantic_evidence_version: SEMANTIC_EVIDENCE_VERSION,
    state: validated.observed ? observedState(coverage, confidence, validated.exclusions) : input.condition.kind,
    usable: validated.observed,
    value: validated.observed ? input.value : null,
    coverage,
    confidence,
    condition: { kind: input.condition.kind, code: input.condition.code },
    source_metric_ids: validated.sourceMetricIds,
    evidence_refs: validated.evidenceRefs,
    exclusions: validated.exclusions,
    partiality_reasons: validated.observed ? partialityReasons(coverage, confidence, validated.exclusions) : [],
  });
}

function deriveEvidence(input) {
  assertClosed(input, ["operation", "value", "inputs", "exclusions"], "derivation input");
  assertText(input.operation, "derivation input.operation");
  assertFiniteValue(input.value, "derivation input.value");
  if (!Array.isArray(input.inputs) || input.inputs.length === 0 || input.inputs.length > MAX_ITEMS) {
    fail(`derivation input.inputs must contain from 1 through ${MAX_ITEMS} semantic evidence records`);
  }
  input.inputs.forEach((evidence, index) => validateSemanticEvidence(evidence, `derivation input.inputs[${index}]`));
  const coverage = Math.min(...input.inputs.map((evidence) => evidence.coverage));
  const confidence = Math.min(...input.inputs.map((evidence) => evidence.confidence));
  const exclusions = canonicalExclusions([
    ...input.inputs.flatMap((evidence) => evidence.exclusions),
    ...canonicalExclusions(input.exclusions, "derivation input.exclusions"),
  ]);
  const sourceMetricIds = canonicalStrings(
    input.inputs.flatMap((evidence) => evidence.source_metric_ids),
    "derived source metric IDs",
    { minimum: 1 },
  );
  const evidenceRefs = canonicalStrings(
    input.inputs.flatMap((evidence) => evidence.evidence_refs),
    "derived evidence references",
    { minimum: 1 },
  );
  const usable = input.inputs.every((evidence) => evidence.usable);
  return deepFreeze({
    semantic_evidence_version: SEMANTIC_EVIDENCE_VERSION,
    state: usable ? observedState(coverage, confidence, exclusions) : "unresolved",
    usable,
    value: usable ? input.value : null,
    coverage,
    confidence,
    condition: usable
      ? { kind: "derived", code: input.operation }
      : { kind: "unresolved", code: "required-input-unusable" },
    source_metric_ids: sourceMetricIds,
    evidence_refs: evidenceRefs,
    exclusions,
    partiality_reasons: usable ? partialityReasons(coverage, confidence, exclusions) : [],
  });
}

module.exports = {
  SEMANTIC_EVIDENCE_VERSION,
  deriveEvidence,
  interpretEvidence,
};
