"use strict";
/* composite-scoring-v3 §12 tests 2, 3 and the Phase-1 portions of 25 and 28.
 * Expected values are literal and hand-calculated; none is derived from the
 * loader's own computation. */
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const L = require("./composite-v2-config.js");
const { gradeForScore } = require("./scoring.js");

const packaged = L.loadScoringConfig();
function clone() { return JSON.parse(JSON.stringify(packaged.config)); }
function rejects(mutate, pattern) {
  const config = clone();
  mutate(config);
  assert.throws(() => L.loadScoringConfig({ config }), error => error.code === "FAIL-RIA-COMPOSITE-CONFIG" && pattern.test(error.message), `expected rejection matching ${pattern}`);
}

test("golden: the initial approved matrix is pinned literally", () => {
  const matrix = Object.fromEntries(Object.entries(packaged.config.dimensions).map(([id, d]) => [id, { weight: d.weight, critical: d.critical, shares: d.shares }]));
  assert.deepEqual(matrix, {
    correctness: { weight: 20, critical: true, shares: { health: 0.35, integrity: 0.65 } },
    architecture: { weight: 15, critical: true, shares: { health: 0.20, architecture: 0.60, sei: 0.20 } },
    contracts: { weight: 12, critical: true, shares: { health: 0.20, architecture: 0.55, integrity: 0.25 } },
    verification: { weight: 15, critical: true, shares: { health: 0.35, architecture: 0.20, sei: 0.45 } },
    delivery: { weight: 8, critical: false, shares: { health: 0.50, sei: 0.50 } },
    maintainability: { weight: 10, critical: false, shares: { health: 0.33, architecture: 0.34, sei: 0.33 } },
    security: { weight: 8, critical: true, shares: { health: 0.33, integrity: 0.34, sei: 0.33 } },
    reliability: { weight: 7, critical: false, shares: { integrity: 0.50, sei: 0.50 } },
    change_and_docs: { weight: 5, critical: false, shares: { sei: 1.00 } },
  });
  assert.equal(packaged.config_version, "1.0.0");
});

test("golden: nominal influence matches the hand-calculated values", () => {
  // Health 20*.35+15*.20+12*.20+15*.35+8*.50+10*.33+8*.33 = 27.59
  // Architecture 15*.60+12*.55+15*.20+10*.34 = 22.00
  // Integrity 20*.65+12*.25+8*.34+7*.50 = 22.22
  // SEI 15*.20+15*.45+8*.50+10*.33+8*.33+7*.50+5*1 = 28.19   (weights sum to 100)
  const expected = { health: 27.59, architecture: 22.00, integrity: 22.22, sei: 28.19 };
  for (const [owner, value] of Object.entries(expected)) {
    assert.ok(Math.abs(packaged.nominal_influence[owner] - value) < 1e-9, `${owner}: ${packaged.nominal_influence[owner]} vs ${value}`);
  }
});

test("a hand-authored two-dimension config yields hand-calculated influence", () => {
  const config = {
    owners: ["health", "architecture", "integrity", "sei"],
    dimensions: {
      a: { weight: 3, shares: { health: 0.5, sei: 0.5 } },
      b: { weight: 1, shares: { architecture: 0.6, integrity: 0.4 } },
    },
  };
  // a = 75%, b = 25%: health 37.5, sei 37.5, architecture 15, integrity 10
  assert.deepEqual(L.computeNominalInfluence(config), { health: 37.5, architecture: 15, integrity: 10, sei: 37.5 });
});

test("§12 test 3: print-influence.js prints the configured influence", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "print-influence.js"), "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed.influence, { health: 27.6, architecture: 22.0, integrity: 22.2, sei: 28.2 });
  assert.equal(printed.config_sha256, packaged.config_sha256);
});

test("§12 test 2: shares that do not sum to 1 are rejected", () => {
  rejects(c => { c.dimensions.delivery.shares = { health: 0.5, sei: 0.4 }; }, /delivery: shares sum/);
});

test("§12 test 2: a multi-owner share below 0.20 is rejected", () => {
  rejects(c => { c.dimensions.correctness.shares = { health: 0.15, integrity: 0.85 }; }, /correctness\.health: share 0\.15 is below 0\.2/);
});

test("§12 test 2: Architecture share caps are enforced", () => {
  rejects(c => { c.dimensions.verification.shares = { health: 0.30, architecture: 0.25, sei: 0.45 }; }, /verification: architecture share exceeds 0\.2/);
  rejects(c => { c.dimensions.maintainability.shares = { health: 0.30, architecture: 0.40, sei: 0.30 }; }, /maintainability: architecture share exceeds 0\.34/);
});

test("§12 test 2: nominal influence outside [20, 30] is rejected", () => {
  // change_and_docs weight 40: total 135, SEI = (28.19 + 35) / 135 * 100 = 46.8
  rejects(c => { c.dimensions.change_and_docs.weight = 40; }, /nominal influence for sei/);
});

test("config is a closed schema and lookups must resolve", () => {
  rejects(c => { c.extra = 1; }, /\$\.extra: is not declared/);
  rejects(c => { delete c.caps.rules["confirmed-critical-failure"]; }, /confirmed-critical-failure: is required/);
  rejects(c => { c.dimensions.correctness.sources.health.lane = "made-up-lane"; }, /unknown Health lane made-up-lane/);
  rejects(c => { c.dimensions.architecture.sources.architecture.fitness_dimensions.push("state_data_ownership"); }, /state_data_ownership already maps to/);
  rejects(c => { c.dimensions.reliability.sources.sei.dimensions = ["not_a_sei_dimension"]; }, /unknown SEI dimension/);
  rejects(c => { c.integrity_surface_map.security.push("not-a-surface"); }, /unknown surface not-a-surface/);
  rejects(c => { c.eligibility.sei.ineligible_confidences = []; }, /NOT_ESTABLISHED must stay ineligible/);
  rejects(c => { c.critical_floor.min_independent_established_sources = 1; }, /must meet minimum/);
  rejects(c => { c.integrity_scoring.severity_schedule[0].floor = 50; }, /severity 5: floor exceeds ceiling/);
});

test("Phase-1 portion of §12 test 25: cap ceilings stay inside their letter band", () => {
  assert.deepEqual(packaged.config.caps.ceilings, { C: 76.9, "D+": 69.9, D: 66.9 });
  assert.equal(gradeForScore(69.9), "D+");
  assert.equal(gradeForScore(76.9), "C");
  assert.equal(gradeForScore(66.9), "D");
  rejects(c => { c.caps.ceilings["D+"] = 70; }, /D\+: 70 is not in the D\+ band/);
  rejects(c => { c.caps.ceilings.C = 76.95; }, /C: must use one-decimal precision/);
});

test("the loaded config is deeply frozen", () => {
  assert.equal(Object.isFrozen(packaged.config.dimensions.correctness.shares), true);
  assert.equal(Object.isFrozen(packaged.imports.health_evidence_factor), true);
  assert.throws(() => { "use strict"; packaged.config.dimensions.correctness.weight = 99; }, TypeError);
});

test("owner-owned factors are imported with digests, not copied", () => {
  assert.equal(JSON.stringify(packaged.config).includes("\"strong\":1"), false);
  assert.deepEqual(packaged.imports.health_evidence_factor, { strong: 1.0, moderate: 0.9, weak: 0.7, none: 0.0 });
  assert.equal(packaged.imports.architecture_fitness_weights.boundary_integrity, 20);
  for (const digest of Object.values(packaged.import_digests)) assert.match(digest.value_sha256, /^[a-f0-9]{64}$/);
});

test("Phase-1 portion of §12 test 28: presentation policy is separate from scoring identity", () => {
  const v1 = L.loadPresentationPolicy();
  assert.deepEqual(v1.policy, { schema_version: "ria.composite-v2.policy@1", reported_composite: "v1", calibration_ref: null });
  const promoted = L.loadPresentationPolicy({ policy: { schema_version: "ria.composite-v2.policy@1", reported_composite: "v2", calibration_ref: { receipt_path: "calibration/receipt.json", receipt_sha256: "a".repeat(64) } } });
  assert.notEqual(promoted.policy_sha256, v1.policy_sha256);
  const reloaded = L.loadScoringConfig();
  assert.equal(reloaded.config_sha256, packaged.config_sha256);
  assert.equal(reloaded.implementation_sha256, packaged.implementation_sha256);
  assert.throws(() => L.loadPresentationPolicy({ policy: { schema_version: "ria.composite-v2.policy@1", reported_composite: "v2", calibration_ref: null } }), /FAIL-RIA-COMPOSITE-POLICY/);
  assert.throws(() => L.loadPresentationPolicy({ policy: { schema_version: "ria.composite-v2.policy@1", reported_composite: "v1", calibration_ref: null, weights: {} } }), /FAIL-RIA-COMPOSITE-POLICY/);
});

test("Phase-1 portion of §12 test 28: any scoring change changes the scoring identity", () => {
  const perturbed = clone();
  perturbed.contested.spread_threshold = 21;
  const loaded = L.loadScoringConfig({ config: perturbed });
  assert.notEqual(loaded.config_sha256, packaged.config_sha256);
  assert.equal(loaded.implementation_sha256, packaged.implementation_sha256);
});
