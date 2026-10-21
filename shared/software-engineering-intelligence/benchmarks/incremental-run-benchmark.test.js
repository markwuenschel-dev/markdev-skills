"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  buildAlternatingOrder,
  evaluateGates,
  parseArguments,
  validateThresholdDecision,
} = require("./incremental-run-benchmark.js");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function thresholdDecision() {
  const body = {
    schema_version: "sei.incremental-performance-threshold-decision@1",
    status: "approved",
    approved_by: "repository owner",
    approved_at: "2026-08-13T00:00:00.000Z",
    gates: {
      cold: { p50_ratio_max: 1.1, p90_ratio_max: 1.2 },
      history_only: { p50_ratio_max: 0.35, p90_ratio_max: 0.5 },
      no_change: { p50_ratio_max: 0.2, p90_ratio_max: 0.3 },
      one_file: { p50_ratio_max: 0.5, p90_ratio_max: 0.65 },
      rss: { peak_ratio_max: 1.25 },
    },
  };
  return { ...body, decision_sha256: `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex")}` };
}

test("incremental benchmark refuses to exist without an owner-approved threshold receipt", () => {
  assert.throws(() => parseArguments([
    "--oracle-receipt", "C:\\oracle.json",
    "--warmups", "1",
    "--repetitions", "7",
    "--order", "abba",
    "--out", "C:\\out",
  ]), /FAIL-INCREMENTAL-BENCHMARK.*threshold/);
  assert.throws(() => validateThresholdDecision({ status: "proposed" }), /FAIL-INCREMENTAL-BENCHMARK.*approved/);
  assert.deepEqual(buildAlternatingOrder(7, "abba"), ["A", "B", "B", "A", "B", "A", "A", "B", "A", "B", "B", "A", "B", "A"]);
});

test("approved thresholds are content-bound and gate every scenario plus RSS", () => {
  const decision = validateThresholdDecision(thresholdDecision());
  const summaries = {
    cold: { p50_ratio: 1.05, p90_ratio: 1.1, peak_rss_ratio: 1.1 },
    history_only: { p50_ratio: 0.3, p90_ratio: 0.4, peak_rss_ratio: 1.1 },
    no_change: { p50_ratio: 0.15, p90_ratio: 0.25, peak_rss_ratio: 1.1 },
    one_file: { p50_ratio: 0.4, p90_ratio: 0.6, peak_rss_ratio: 1.1 },
  };
  assert.equal(evaluateGates(summaries, decision).pass, true);
  summaries.one_file.p90_ratio = 0.66;
  assert.equal(evaluateGates(summaries, decision).pass, false);
});
