"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSeiTelemetrySummary, unavailable } = require("./sei-telemetry-summary.js");

const binding = { artifact_id: `engineering-intelligence:${"a".repeat(64)}`, sha256: "a".repeat(64) };
function assessment(observed, applicable) {
  return { criteria: Array.from({ length: applicable }, (_, index) => index < observed
    ? { criterion_id: `criterion-${index}`, applicability: "applicable", maturity: "established" }
    : { criterion_id: `criterion-${index}`, applicability: "not_scored", maturity: "not_scored" }) };
}
function build(observed, applicable) { return buildSeiTelemetrySummary({ sei_binding: binding, cache_disposition: "MISS", assessment: assessment(observed, applicable) }); }

test(String.raw`repository-improvement-assessment\scripts\sei-telemetry-summary.test.js`, () => {
  function prove(builder) {
    const half = builder(10, 20);
    const repeat = builder(10, 20);
    const changed = builder(15, 20);
    assert.deepEqual(half, repeat, "same SEI assessment must produce the same summary");
    assert.deepEqual(half.criterion_counts, { applicable: 20, assessed: 10, established: 10, not_applicable: 0, not_scored: 10, provisional: 0, total: 20 });
    assert.equal(half.gate_observation_ratio, 0.5);
    assert.equal(changed.gate_observation_ratio, 0.75);
    assert.equal(half.gate_observation_status, "RECORDED");
    assert.notEqual(half.summary_id, changed.summary_id, "changed SEI assessment must change summary identity");
  }

  assert.doesNotThrow(() => prove(build));
  assert.throws(() => prove(() => 1));
  assert.throws(() => prove(() => "nonempty"));
  const fixed = build(10, 20);
  assert.throws(() => prove(() => fixed));
  const missing = unavailable({ sei_binding: binding });
  assert.equal(missing.schema_version, "sei.telemetry-summary@1");
  assert.deepEqual(missing.sei_binding, binding);
  assert.equal(missing.collector_status, "unavailable");
  assert.equal(missing.criterion_counts, null);
  assert.equal(missing.gate_observation_ratio, null);
  assert.equal(missing.gate_observation_status, "UNAVAILABLE");
  assert.equal(missing.failure_code, "NOT_RECORDED");
});

test("Gate-observation ratio is exclusively SEI-native and changes with assessed criteria", () => {
  const half = build(10, 20);
  const threeQuarters = build(15, 20);
  assert.equal(half.criterion_counts.assessed, 10);
  assert.equal(half.criterion_counts.applicable, 20);
  assert.equal(half.gate_observation_ratio, 0.5);
  assert.equal(threeQuarters.gate_observation_ratio, 0.75);
  assert.equal(half.gate_observation_status, "RECORDED");
  assert.equal(threeQuarters.gate_observation_status, "RECORDED");
});

test("absent SEI telemetry has no Gate-observation fallback", () => {
  const missingAssessment = buildSeiTelemetrySummary({ sei_binding: binding, cache_disposition: "MISS" });
  const explicitlyUnavailable = unavailable({ sei_binding: binding });
  for (const summary of [missingAssessment, explicitlyUnavailable]) {
    assert.equal(summary.gate_observation_ratio, null);
    assert.equal(summary.gate_observation_status, "UNAVAILABLE");
  }
});

test("SEI accounting remains exclusive and the Engineering Intelligence binding stays payload-free", () => {
  const summary = buildSeiTelemetrySummary({ sei_binding: binding, cache_disposition: "MISS", assessment: { criteria: [
    { criterion_id: "a", applicability: "applicable", maturity: "established" },
    { criterion_id: "b", applicability: "applicable", maturity: "provisional" },
    { criterion_id: "c", applicability: "not_scored", maturity: "not_scored" },
    { criterion_id: "d", applicability: "not_applicable", maturity: "not_scored" },
  ] } });
  assert.deepEqual(summary.criterion_counts, { applicable: 3, assessed: 2, established: 1, not_applicable: 1, not_scored: 1, provisional: 1, total: 4 });
  assert.throws(() => buildSeiTelemetrySummary({ sei_binding: binding, assessment: { criteria: [{ criterion_id: "bad", applicability: "applicable", maturity: "mystery" }] } }), /exclusive accounting state/);
  assert.deepEqual(Object.keys(binding).sort(), ["artifact_id", "sha256"]);
});

test("SEI causal proof rejects numeric, nonempty, and fixed-object implementations", () => {
  function prove(builder) {
    const half = builder(10, 20);
    const repeat = builder(10, 20);
    const changed = builder(15, 20);
    assert.deepEqual(half, repeat, "same SEI input must be deterministic");
    assert.equal(half.gate_observation_ratio, 0.5);
    assert.equal(changed.gate_observation_ratio, 0.75);
    assert.notEqual(half.summary_id, changed.summary_id, "different SEI input must change the summary identity");
  }
  assert.doesNotThrow(() => prove(build));
  assert.throws(() => prove(() => 1));
  assert.throws(() => prove(() => "nonempty"));
  const fixed = build(10, 20);
  assert.throws(() => prove(() => fixed));
});
