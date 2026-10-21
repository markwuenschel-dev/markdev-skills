"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { gradeForScore, weightedComposite, priorityColor, priorityLabel, ledgerPriorityBand, ledgerPriorityColor, normalizeCoverageMetrics } = require("./scoring.js");

test("plus-minus grades use one canonical mapping", () => {
  assert.equal(gradeForScore(99), "A+");
  assert.equal(gradeForScore(93), "A");
  assert.equal(gradeForScore(90), "A-");
  assert.equal(gradeForScore(67.8), "D+");
  assert.equal(gradeForScore(61), "D-");
  assert.equal(gradeForScore(59.9), "F");
});

test("RIA composite is a weighted average and preserves assessment coverage", () => {
  const result = weightedComposite({
    "correctness-and-integrity": { score: 60 },
    "architecture-fitness": { score: 70 },
    "contracts-and-integration": { score: 80 },
    "verification-readiness": { score: 90 },
    "build-and-delivery": { score: 100 },
    "maintainability-and-ownership": { score: 50 },
  });
  assert.equal(result.raw_score, 74);
  assert.equal(result.raw_grade, "C");
  assert.equal(result.assessment_coverage, 100);
});

test("priority color spans cool to hot and severity remains textual", () => {
  assert.equal(priorityColor(0), "#3b82f6");
  assert.equal(priorityColor(50), "#22c55e");
  assert.equal(priorityColor(100), "#ef4444");
  assert.equal(priorityLabel(92), "CRITICAL");
  assert.equal(priorityLabel(54), "MODERATE");
});

test("ledger priority bands stay on the spine −10…+22 scale", () => {
  assert.equal(ledgerPriorityBand(20), "Strong");
  assert.equal(ledgerPriorityBand(8), "Worth exploring");
  assert.equal(ledgerPriorityBand(5), "Speculative");
  assert.equal(ledgerPriorityBand(undefined), "Unscored");
  assert.equal(priorityLabel(20), "LOW");
  assert.notEqual(ledgerPriorityColor(20), priorityColor(20));
});

test("coverage aggregates from counts rather than percent averages", () => {
  const coverage = normalizeCoverageMetrics({ line:{covered:18429,total:21081}, branch:{covered:4211,total:5630} });
  assert.equal(coverage.line.percent, 87.42);
  assert.equal(coverage.branch.percent, 74.8);
});

// composite-scoring-v3 §12 test 1 (P1): absent evidence is never an observed zero.
test("finiteOrNull rejects absent and non-numeric values and accepts decimal strings", () => {
  const { finiteOrNull } = require("./scoring.js");
  for (const value of [null, undefined, "", "   ", true, false, [], [5], {}, { score: 5 }, NaN, Infinity, -Infinity, "Infinity", "NaN", "0x10", "1,5", "5px"]) {
    assert.equal(finiteOrNull(value), null, `expected null for ${JSON.stringify(value)}`);
  }
  assert.equal(finiteOrNull(0), 0);
  assert.equal(finiteOrNull(-4), -4);
  assert.equal(finiteOrNull(" 42 "), 42);
  assert.equal(finiteOrNull("-3.5"), -3.5);
  assert.equal(finiteOrNull(".5"), 0.5);
  assert.equal(finiteOrNull("1e3"), 1000);
  assert.equal(finiteOrNull(150), 150, "range validation is separate; no clamping here");
});

test("weightedComposite({}) is unscored, not F", () => {
  const result = weightedComposite({});
  assert.equal(result.raw_score, null);
  assert.equal(result.final_score, null);
  assert.equal(result.final_grade, null);
  assert.equal(result.assessed_weight, 0);
  assert.equal(result.assessment_coverage, 0);
  for (const row of result.dimensions) {
    assert.equal(row.score, null);
    assert.equal(row.grade, null);
    assert.equal(row.coverage, null);
    assert.equal(row.confidence, null);
  }
});

test("null dimensions and null coverage/confidence are absent, not 0", () => {
  const result = weightedComposite({
    "correctness-and-integrity": null,
    "architecture-fitness": { score: 70, coverage: null, confidence: "" },
    "contracts-and-integration": { score: 80 },
    "verification-readiness": { score: 90 },
    "build-and-delivery": { score: true },
    "maintainability-and-ownership": { score: 50 },
  });
  // (70*20 + 80*15 + 90*20 + 50*10) / (20+15+20+10) = 4900/65 = 75.3846…
  assert.equal(result.raw_score, 75.4);
  assert.equal(result.assessed_weight, 65);
  assert.equal(result.assessment_coverage, 65);
  const arch = result.dimensions.find(row => row.id === "architecture-fitness");
  assert.equal(arch.coverage, null);
  assert.equal(arch.confidence, null);
});
