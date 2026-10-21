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
