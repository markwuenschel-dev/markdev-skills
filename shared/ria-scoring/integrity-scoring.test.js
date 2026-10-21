"use strict";
/* composite-scoring-v3 §7.3–§7.5 with a test-local configuration and literal,
 * hand-calculated expectations (instructions Phase 5 acceptance). */
const assert = require("node:assert/strict");
const test = require("node:test");
const S = require("./integrity-scoring.js");

const config = {
  integrity_scoring: {
    no_defect_score: 100,
    severity_schedule: [
      { severity: 5, ceiling: 40, step: 3, floor: 25 },
      { severity: 4, ceiling: 60, step: 3, floor: 45 },
      { severity: 3, ceiling: 75, step: 2, floor: 60 },
      { severity: 2, ceiling: 90, step: 2, floor: 80 },
      { severity: 1, ceiling: 97, step: 1, floor: 90 },
    ],
  },
  eligibility: { integrity: { scored_min_coverage: 0.60, provisional_min_coverage: 0.40 } },
};
const FACTORS = { strong: 1.0, moderate: 0.9, weak: 0.7 };
const group = (severity, extra = {}) => ({ confirmed: true, severity, primary_quality: "strong", ...extra });

test("a severity-5 defect scores 40; plus two more confirmed groups scores 34", () => {
  assert.deepEqual(S.integrityDimensionScore({ groups: [group(5)], absenceSupported: false, config }).score, 40);
  // 40 - 3 x 2 = 34
  assert.equal(S.integrityDimensionScore({ groups: [group(5), group(2), group(1)], absenceSupported: false, config }).score, 34);
  // floor: 40 - 3 x 9 = 13 -> 25
  assert.equal(S.integrityDimensionScore({ groups: [group(5), ...Array.from({ length: 9 }, () => group(1))], absenceSupported: false, config }).score, 25);
  // severity 3 with one further group: 75 - 2 = 73
  assert.equal(S.integrityDimensionScore({ groups: [group(3), group(3)], absenceSupported: true, config }).score, 73);
});

test("no confirmed defects: 100 only with a supporting negative claim (§12 test 11)", () => {
  assert.deepEqual(S.integrityDimensionScore({ groups: [], absenceSupported: true, config }), { score: 100, state: "scored", worst_severity: null, confirmed_group_count: 0, limitations: [] });
  const none = S.integrityDimensionScore({ groups: [], absenceSupported: false, config });
  assert.equal(none.state, "insufficient_evidence");
  assert.equal(none.score, null);
  // Unconfirmed (inferred / contested) groups never score and never count.
  assert.equal(S.integrityDimensionScore({ groups: [{ confirmed: false, severity: 5 }], absenceSupported: false, config }).state, "insufficient_evidence");
});

test("a confirmed group without a validated severity cannot score", () => {
  assert.equal(S.integrityDimensionScore({ groups: [group(null)], absenceSupported: true, config }).state, "insufficient_evidence");
});

test("§7.4 eligibility thresholds", () => {
  assert.deepEqual(S.integrityEligibility(0.60, config), { state: "scored", provisional: false });
  assert.deepEqual(S.integrityEligibility(0.5508, config), { state: "scored", provisional: true });
  assert.deepEqual(S.integrityEligibility(0.40, config), { state: "scored", provisional: true });
  assert.deepEqual(S.integrityEligibility(0.3375, config), { state: "insufficient_evidence", provisional: false });
  assert.deepEqual(S.integrityEligibility(null, config), { state: "insufficient_evidence", provisional: false });
});

test("§7.5 confidence = coverage x min(Q_surface, Q_defect)", () => {
  // no defects, strong negative claim: 0.95 x min(0.95, 1.0) = 0.9025
  assert.ok(Math.abs(S.integrityConfidence({ coverage: 0.95, qSurface: 0.95, groups: [], negativeClaimQuality: "strong", factors: FACTORS }) - 0.9025) < 1e-12);
  // groups sev 4 strong, sev 2 weak: Q_defect = (4x1.0 + 2x0.7) / 6 = 0.9; 0.8 x min(1.0, 0.9) = 0.72
  const groups = [group(4), group(2, { primary_quality: "weak" })];
  assert.ok(Math.abs(S.integrityConfidence({ coverage: 0.8, qSurface: 1.0, groups, negativeClaimQuality: null, factors: FACTORS }) - 0.72) < 1e-12);
  // absent required evidence -> null, never a default 1
  assert.equal(S.integrityConfidence({ coverage: 0.8, qSurface: 1.0, groups: [], negativeClaimQuality: null, factors: FACTORS }), null);
  assert.equal(S.integrityConfidence({ coverage: 0.8, qSurface: 1.0, groups: [group(3, { primary_quality: null })], negativeClaimQuality: "strong", factors: FACTORS }), null);
});
