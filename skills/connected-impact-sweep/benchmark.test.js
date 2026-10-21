"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { runBenchmark } = require("./benchmark");

test("synthetic risk corpus has no missed full sweeps or unnecessary low-risk full sweeps", () => {
  const result = runBenchmark();
  assert.equal(result.synthetic, true);
  assert.deepEqual(result.confusion_matrix, {
    true_full: 4,
    false_full: 0,
    true_non_full: 2,
    missed_full: 0,
  });
  assert.equal(result.low_risk_full_sweeps, 0);
  assert.equal(result.cases, 6);
  assert.match(result.corpus_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.corpus_bytes > 0);
});
