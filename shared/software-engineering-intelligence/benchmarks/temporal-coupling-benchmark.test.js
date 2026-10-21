"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { runTemporalCouplingBenchmark } = require("./temporal-coupling-benchmark.js");

test("temporal coupling benchmark reports bounded 10/100/1000/5000 curves without timing thresholds", () => {
  const result = runTemporalCouplingBenchmark({
    sizes: [10, 100, 1_000, 5_000],
    policy: { threshold: 10, cap: 40, action: "down_weight" },
  });

  assert.equal(result.benchmark_id, "sei-temporal-coupling-benchmark-v1");
  assert.deepEqual(result.curves.map((curve) => curve.file_count), [10, 100, 1_000, 5_000]);
  for (const curve of result.curves) {
    assert.equal(typeof curve.elapsed_ms, "number");
    assert.ok(Number.isFinite(curve.elapsed_ms));
    assert.equal(typeof curve.heap_delta_bytes, "number");
    assert.ok(Number.isFinite(curve.heap_delta_bytes));
    assert.ok(curve.relationship_count <= curve.pair_bound);
    assert.equal(curve.pair_bound, curve.file_count === 10 ? 45 : 780);
    assert.equal(curve.mass_change_policy.action, "down_weight");
    assert.match(curve.mass_change_policy.policy_hash, /^sha256:[a-f0-9]{64}$/);
  }
});
