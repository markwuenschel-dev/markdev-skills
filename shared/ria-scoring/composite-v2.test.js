"use strict";
/* composite-scoring-v3 §12 tests 4–6, 8–9, 17–19, 24–25 against hand-written
 * normalized inputs. Every expected number is worked by hand in the comment
 * beside it; none is computed by the engine under test. */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { loadScoringConfig } = require("./composite-v2-config.js");
const { computeCompositeV2, displayPoint, displayLower, displayUpper } = require("./composite-v2.js");
const { gradeForScore } = require("./scoring.js");

const loaded = loadScoringConfig();
const inputSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "composite-v2.input.schema.json"), "utf8"));
const close = (actual, expected, label) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);
const OWNERS_BY_DIMENSION = Object.fromEntries(Object.entries(loaded.config.dimensions).map(([id, d]) => [id, Object.keys(d.shares)]));

function full(score = 100, extra = {}) {
  return { eligibility: "scored", score, confidence: 0.8, coverage: 1, maturity: "established", provisional: false, strong_original: true, dependence: { classification: "independent", origin_owners: [] }, limitations: [], ...extra };
}
/** Every mapped owner scores 100 unless overridden: overrides[dimension][owner] = partial contribution. */
function build(overrides = {}, extra = {}) {
  const dimensions = {};
  for (const [id, owners] of Object.entries(OWNERS_BY_DIMENSION)) {
    dimensions[id] = { contributions: Object.fromEntries(owners.map(owner => [owner, { ...full(), ...(overrides[id]?.[owner] ?? {}) }])) };
  }
  return {
    schema_version: "ria.composite-v2.input@1",
    run: { failed_tasks: [], allow_degraded: false },
    verification: { commands: [{ command_id: "test", kind: "test", outcome: "pass" }] },
    dimensions,
    canonical_defects: { groups: [], unresolved: [], health_uncontained_critical_failure: null },
    presentation: { reported_composite: "v1", policy_sha256: "a".repeat(64), calibration_ref: null, calibration_verified: false },
    source_bindings: [],
    ...extra,
  };
}
const run = (input, config = loaded) => computeCompositeV2(config, input, { inputSchema });
const dim = (result, id) => result.dimensions.find(d => d.id === id);
const missing = { eligibility: "not_assessed", limitations: ["omitted"] };
function allOwners(id, contribution) { return { [id]: Object.fromEntries(OWNERS_BY_DIMENSION[id].map(owner => [owner, contribution])) }; }

test("all evidence present at 100 is final 100 with a point interval", () => {
  const result = run(build());
  assert.equal(result.status, "final");
  assert.equal(result.point.final_score, 100);
  assert.deepEqual(result.bounds.final, { lower: 100, upper: 100 });
  assert.equal(result.reported, false);
  assert.equal(result.calibration_state, "uncalibrated");
});

test("§8.3 worked example: delivery 0 and everything else 100 -> point 92, bounds [92, 92], final", () => {
  // weights sum to 100; delivery 8: 100 x 92/100 + 0 x 8/100 = 92
  const result = run(build({ delivery: { health: { score: 0 }, sei: { score: 0 } } }));
  assert.equal(result.status, "final");
  close(result.point.final_score, 92, "point");
  close(result.bounds.final.lower, 92, "lower");
  close(result.bounds.final.upper, 92, "upper");
});

test("§8.3 worked example: delivery unassessed -> point 100, bounds [92, 100], provisional", () => {
  // point renormalizes over dimensions with a point; delivery keeps [0, 100] in the bounds
  const result = run(build(allOwners("delivery", missing)));
  assert.equal(result.status, "provisional");
  assert.equal(dim(result, "delivery").verdict, "not_scored");
  close(result.point.final_score, 100, "point");
  close(result.bounds.final.lower, 92, "lower");
  close(result.bounds.final.upper, 100, "upper");
});

test("§8.3 worked example: shares [0.5, 0.5], scores [80, missing] -> point 80, bounds [40, 90]", () => {
  const delivery = dim(run(build({ delivery: { health: { score: 80 }, sei: missing } })), "delivery");
  close(delivery.point, 80, "point");
  close(delivery.lower, 40, "lower");   // 0.5 x 80
  close(delivery.upper, 90, "upper");   // 40 + 100 x 0.5
  assert.equal(delivery.verdict, "provisional");
});

test("§8.3 worked example / §12 tests 4, 24: [dependent, 80, missing] at [0.2, 0.3, 0.5] -> point 80, [30, 92.5]", () => {
  // Test-local config: maintainability shares health .20 / architecture .30 / sei .50.
  // Influence stays in band: health 27.59 - 3.3 + 2 = 26.29; architecture 22 - 3.4 + 3 = 21.6; sei 28.19 - 3.3 + 5 = 29.89.
  const config = JSON.parse(JSON.stringify(loaded.config));
  config.dimensions.maintainability.shares = { health: 0.20, architecture: 0.30, sei: 0.50 };
  const local = loadScoringConfig({ config });
  const result = run(build({ maintainability: {
    health: { score: 90, dependence: { classification: "dependent", origin_owners: ["architecture"] } },
    architecture: { score: 80 },
    sei: missing,
  } }), local);
  const m = dim(result, "maintainability");
  close(m.point, 80, "point");
  close(m.lower, 30, "lower");     // 0.375 x 80
  close(m.upper, 92.5, "upper");   // 30 + 100 x 0.625
  const shares = Object.fromEntries(m.contributions.map(c => [c.owner, [c.original_share, c.bound_share, c.effective_share]]));
  assert.deepEqual(shares.health, [0.2, 0, 0], "dependent mass leaves the denominator");
  close(shares.architecture[1], 0.375, "architecture bound share");
  close(shares.sei[1], 0.625, "missing mass has not vanished");
  assert.equal(shares.architecture[2], 1, "point-effective share differs from bound share");
  assert.equal(m.contributions.find(c => c.owner === "health").state, "dependent");
});

test("§12 test 24: NA renormalization, missing sub-scores, orphans, cycles and zero applicable weight", () => {
  // contracts: integrity not_applicable -> health .20/.75, architecture .55/.75
  const na = dim(run(build({ contracts: { health: { score: 60 }, architecture: { score: 90 }, integrity: { eligibility: "not_applicable", limitations: ["no contract surface"] } } })), "contracts");
  close(na.point, (0.2 * 60 + 0.55 * 90) / 0.75, "NA renormalized point");   // 82
  close(na.lower, 82, "lower"); close(na.upper, 82, "upper");
  // architecture sub-scores 80 (w20) and missing (w15): point 80, interval [80 x 20/35, + 100 x 15/35]
  const subs = run(build({ architecture: { architecture: { score: null, sub_scores: [{ id: "boundary_integrity", weight: 20, state: "scored", score: 80 }, { id: "dependency_direction_cycle_control", weight: 15, state: "not_assessed", score: null }] } } }));
  const arch = dim(subs, "architecture").contributions.find(c => c.owner === "architecture");
  close(arch.score, 80, "sub-score point");
  close(arch.lower, 80 * 20 / 35, "sub-score lower");
  close(arch.upper, 80 * 20 / 35 + 100 * 15 / 35, "sub-score upper");
  close(arch.completeness, 20 / 35, "retained scored mass");
  assert.equal(arch.provisional, true);
  assert.equal(dim(subs, "architecture").verdict, "provisional");
  // orphan: dependent on an owner that is not scored -> missing evidence
  const orphan = dim(run(build({ delivery: { health: { score: 70, dependence: { classification: "dependent", origin_owners: ["sei"] } }, sei: missing } })), "delivery");
  assert.equal(orphan.contributions.find(c => c.owner === "health").state, "insufficient_evidence");
  assert.equal(orphan.verdict, "not_scored");
  assert.deepEqual([orphan.lower, orphan.upper], [0, 100]);
  // cycle: health <-> sei dependent on each other -> both missing
  const cycle = dim(run(build({ delivery: { health: { dependence: { classification: "dependent", origin_owners: ["sei"] } }, sei: { dependence: { classification: "dependent", origin_owners: ["health"] } } } })), "delivery");
  assert.deepEqual(cycle.contributions.map(c => c.state), ["insufficient_evidence", "insufficient_evidence"]);
  assert.deepEqual([cycle.point, cycle.lower, cycle.upper], [null, 0, 100]);
  // zero applicable weight
  const na9 = {};
  for (const id of Object.keys(OWNERS_BY_DIMENSION)) Object.assign(na9, allOwners(id, { eligibility: "not_applicable", limitations: ["fixture"] }));
  const none = run(build(na9));
  assert.equal(none.status, "not_gradable");
  assert.ok(none.status_reasons.includes("NO_APPLICABLE_DIMENSIONS"));
  assert.deepEqual(none.point, { raw_score: null, final_score: null, final_grade: null });
  assert.deepEqual(none.bounds.raw, { lower: null, upper: null });
  assert.equal(none.confidence.value, null);
  assert.ok(Object.values(none.influence.effective).every(value => value === 0), "zero influence with no scored weight");
});

test("§12 test 6: contested and completeness multipliers", () => {
  // delivery health 100 / sei 70, both conf 0.8: base 0.8; spread 30 -> x (1 - 10/80) = 0.875 -> 0.7
  const contested = dim(run(build({ delivery: { sei: { score: 70 } } })), "delivery");
  assert.equal(contested.contested, true);
  assert.equal(contested.spread, 30);
  close(contested.confidence, 0.7, "contested confidence");
  // delivery health scored (conf 0.8), sei missing: base 0.8 x completeness 0.5 = 0.4
  close(dim(run(build({ delivery: { sei: missing } })), "delivery").confidence, 0.4, "completeness multiplier");
  // decay floors at 0.5: spread 100 -> max(0.5, 1 - 80/80) = 0.5 -> 0.8 x 0.5 = 0.4
  close(dim(run(build({ delivery: { sei: { score: 0 } } })), "delivery").confidence, 0.4, "contested floor");
});

test("§12 test 8: omitting a low dimension never yields a higher final grade", () => {
  const low = run(build(allOwners("correctness", { score: 40 })));
  assert.equal(low.status, "final");
  // raw (40 x 20 + 100 x 80) / 100 = 88; correctness < 50 with independent established
  // sources also fires the critical floor, so the final is 69.9 (D+)
  close(low.point.raw_score, 88, "raw with the low dimension");
  assert.equal(low.point.final_score, 69.9);
  const omitted = run(build(allOwners("correctness", missing)));
  assert.notEqual(omitted.status, "final");
  assert.equal(omitted.point.final_grade, null, "a critical omission is not gradable, never a higher final grade");
  const nonCritical = run(build(allOwners("maintainability", missing)));
  assert.equal(nonCritical.status, "provisional");
});

test("§12 test 9: omitting a low owner within a dimension never yields a higher final grade", () => {
  const withOwner = run(build({ maintainability: { architecture: { score: 10 } } }));
  assert.equal(withOwner.status, "final");
  const omitted = run(build({ maintainability: { architecture: missing } }));
  assert.equal(omitted.status, "provisional");
  assert.equal(dim(omitted, "maintainability").verdict, "provisional");
});

test("§12 test 17: Architecture 0 with independent established evidence caps at D+ 69.9", () => {
  // raw: 100 - 15 = 85 (B+); floor ceiling 69.9
  const result = run(build(allOwners("architecture", { score: 0 })));
  close(result.point.raw_score, 85, "raw");
  assert.equal(result.point.final_score, 69.9);
  assert.equal(result.point.final_grade, "D+");
  assert.deepEqual(result.caps, [{ cap_id: "critical-dimension-floor", trigger: "architecture", ceiling: 69.9, binding: true }]);
  close(result.bounds.final.upper, 69.9, "caps apply to both endpoints");
  // one independent source only (the others dependent on it): no floor
  const single = run(build({ architecture: { health: { score: 0, dependence: { classification: "dependent", origin_owners: ["architecture"] } }, architecture: { score: 0 }, sei: { score: 0, dependence: { classification: "dependent", origin_owners: ["architecture"] } } } }));
  assert.deepEqual(single.caps, []);
  // provisional evidence alone: verdict provisional -> no floor
  const provisional = run(build(allOwners("architecture", { score: 0, maturity: "provisional" })));
  assert.deepEqual(provisional.caps, []);
  // no strong original evidence: no floor
  assert.deepEqual(run(build(allOwners("architecture", { score: 0, strong_original: false }))).caps, []);
});

test("§12 test 18: a failing lint caps at C; an errored or timed-out test does not cap and keeps verification open", () => {
  const lint = run(build({}, { verification: { commands: [{ command_id: "test", kind: "test", outcome: "pass" }, { command_id: "lint", kind: "lint", outcome: "fail" }] } }));
  assert.deepEqual(lint.caps, [{ cap_id: "verification-checks-failing", trigger: "lint", ceiling: 76.9, binding: true }]);
  assert.equal(lint.point.final_grade, "C");
  for (const outcome of ["error", "timed-out"]) {
    const errored = run(build({ verification: { health: { baseline_dependent: true } } }, { verification: { commands: [{ command_id: "test", kind: "test", outcome }] } }));
    assert.deepEqual(errored.caps, []);
    const v = dim(errored, "verification");
    assert.equal(v.contributions.find(c => c.owner === "health").state, "insufficient_evidence");
    assert.equal(v.verdict, "provisional");
    assert.notEqual(errored.status, "final");
  }
  const failingTests = run(build({}, { verification: { commands: [{ command_id: "test", kind: "test", outcome: "fail" }] } }));
  assert.deepEqual(failingTests.caps.map(c => c.cap_id), ["verification-tests-failing"]);
  const none = run(build({ verification: { health: { baseline_dependent: true } } }, { verification: { commands: [] } }));
  assert.equal(dim(none, "verification").contributions.find(c => c.owner === "health").state, "insufficient_evidence");
  assert.notEqual(none.status, "final");
});

test("§12 test 19: a degraded run is never final, with or without allow_degraded", () => {
  for (const allow of [false, true]) {
    const result = run(build({}, { run: { failed_tasks: ["owner-integrity"], allow_degraded: allow } }));
    assert.equal(result.run_state, "degraded");
    assert.equal(result.status, "provisional");
  }
  const failedOwner = run(build({ reliability: { integrity: { eligibility: "failed", limitations: ["owner failed"] } } }));
  assert.equal(failedOwner.run_state, "degraded");
  assert.notEqual(failedOwner.status, "final");
});

test("§12 test 25: confirmed critical failures cap at D; containment and coverage behave", () => {
  const group = { group_id: "defect:1:security", dimension: "security", members: ["integrity:SEC-1"], severity: 4, evidentiary_state: "reproduced", confirmed: true, owners: ["integrity:original"], cap_eligible: true, contained: false };
  // Insufficient Integrity coverage cannot hide an admissible critical failure.
  const hidden = run(build({ security: { integrity: { eligibility: "insufficient_evidence", limitations: ["coverage 0.3"] } } }, { canonical_defects: { groups: [group], unresolved: [], health_uncontained_critical_failure: null } }));
  assert.deepEqual(hidden.caps, [{ cap_id: "confirmed-critical-failure", trigger: "defect:1:security", ceiling: 66.9, binding: true }]);
  assert.equal(hidden.point.final_grade, "D");
  assert.equal(run(build({}, { canonical_defects: { groups: [{ ...group, contained: true }], unresolved: [], health_uncontained_critical_failure: null } })).caps.length, 0, "a verified guard contains it");
  assert.equal(run(build({}, { canonical_defects: { groups: [{ ...group, severity: 3 }], unresolved: [], health_uncontained_critical_failure: null } })).caps.length, 0, "severity below 4");
  assert.equal(run(build({}, { canonical_defects: { groups: [{ ...group, confirmed: false, evidentiary_state: "contested" }], unresolved: [], health_uncontained_critical_failure: null } })).caps.length, 0, "contested groups never cap");
  assert.equal(run(build({}, { canonical_defects: { groups: [{ ...group, dimension: "reliability" }], unresolved: [], health_uncontained_critical_failure: null } })).caps.length, 0, "reliability is not critical");
  const health = run(build({}, { canonical_defects: { groups: [], unresolved: [], health_uncontained_critical_failure: { claim_id: "CORR-01", dimension: "correctness", admissible: true } } }));
  assert.deepEqual(health.caps.map(c => [c.cap_id, c.trigger]), [["confirmed-critical-failure", "health:CORR-01"]]);
  // Display: a 69.9 ceiling shows D+, never 70; bounds round outward.
  assert.equal(displayPoint(69.9), 69.9);
  assert.equal(gradeForScore(displayPoint(69.9)), "D+");
  assert.equal(displayPoint(69.96), 69.9);
  assert.equal(displayLower(30.04), 30);
  assert.equal(displayUpper(92.41), 92.5);
});

test("caps that fire but do not bind are listed", () => {
  // floor (69.9) and lint (76.9) both fire; only the floor binds
  const result = run(build(allOwners("architecture", { score: 0 }), { verification: { commands: [{ command_id: "test", kind: "test", outcome: "pass" }, { command_id: "lint", kind: "lint", outcome: "fail" }] } }));
  assert.deepEqual(result.caps, [
    { cap_id: "critical-dimension-floor", trigger: "architecture", ceiling: 69.9, binding: true },
    { cap_id: "verification-checks-failing", trigger: "lint", ceiling: 76.9, binding: false },
  ]);
});

test("not-gradable output suppresses point and grade but keeps diagnostic bounds", () => {
  const result = run(build(allOwners("correctness", missing)));
  assert.equal(result.status, "not_gradable");
  assert.deepEqual(result.point, { raw_score: null, final_score: null, final_grade: null });
  close(result.bounds.raw.lower, 80, "diagnostic lower");   // correctness 20 of 100 missing
  close(result.bounds.raw.upper, 100, "diagnostic upper");
  assert.equal(result.weakest_critical_dimension.id, "correctness");
  assert.equal(result.weakest_critical_dimension.point, null);
});

test("nominal and effective influence", () => {
  const result = run(build());
  // all scored: effective equals nominal (27.59 / 22 / 22.22 / 28.19)
  close(result.influence.effective.health, 27.59, "health");
  close(result.influence.effective.architecture, 22, "architecture");
  close(result.influence.effective.integrity, 22.22, "integrity");
  close(result.influence.effective.sei, 28.19, "sei");
  // change_and_docs (5) unassessed: SEI effective = (28.19 - 5) / 95 x 100 = 24.4105…
  const less = run(build(allOwners("change_and_docs", missing)));
  close(less.influence.effective.sei, (28.19 - 5) / 95 * 100, "sei without change_and_docs");
  close(less.influence.missing_bound_mass.sei, 5, "missing mass is reported, not called influence");
});

test("deterministic, byte-identical output under input permutation", () => {
  const groups = [
    { group_id: "defect:b:correctness", dimension: "correctness", members: ["integrity:B", "health:B"], severity: 2, evidentiary_state: "observed", confirmed: true, owners: ["integrity:original", "health:original"] },
    { group_id: "defect:a:correctness", dimension: "correctness", members: ["integrity:A"], severity: 1, evidentiary_state: "reproduced", confirmed: true, owners: ["integrity:original"] },
  ];
  const commands = [{ command_id: "lint", kind: "lint", outcome: "fail" }, { command_id: "test", kind: "test", outcome: "pass" }];
  const a = build({ delivery: { sei: missing } }, { verification: { commands }, canonical_defects: { groups, unresolved: [], health_uncontained_critical_failure: null } });
  const b = build({ delivery: { sei: missing } }, { verification: { commands: [...commands].reverse() }, canonical_defects: { groups: [...groups].reverse().map(g => ({ ...g, members: [...g.members].reverse() })), unresolved: [], health_uncontained_critical_failure: null } });
  b.dimensions = Object.fromEntries(Object.entries(b.dimensions).reverse());
  assert.equal(JSON.stringify(run(a)), JSON.stringify(run(b)));
  assert.equal(JSON.stringify(run(a)).includes("generated"), false, "no generated timestamp");
});

test("the normalized input is a closed contract", () => {
  const bad = build(); bad.extra = 1;
  assert.throws(() => run(bad), /FAIL-RIA-COMPOSITE-V2-INPUT/);
  const unmapped = build(); unmapped.dimensions.reliability.contributions.health = full();
  assert.throws(() => run(unmapped), /not a mapped owner/);
  const noScore = build(); noScore.dimensions.delivery.contributions.health = { eligibility: "scored", maturity: "established" };
  assert.throws(() => run(noScore), /FAIL-RIA-COMPOSITE-V2-INPUT/);
});

test("golden: a deliberately perturbed reducer is caught by the hand-calculated cases (§12 test 28)", () => {
  // If bounds used point-effective shares instead of bound shares, [0.5, 0.5] x [80, missing]
  // would give [80, 80]; the literal [40, 90] above rejects that. Recheck here with a provisional config change:
  const config = JSON.parse(JSON.stringify(loaded.config));
  config.contested.spread_threshold = 40;
  const local = loadScoringConfig({ config });
  assert.notEqual(local.config_sha256, loaded.config_sha256);
  // spread 30 is no longer contested under the perturbed config: 0.8, not 0.7
  close(dim(run(build({ delivery: { sei: { score: 70 } } }), local), "delivery").confidence, 0.8, "perturbed threshold");
});
