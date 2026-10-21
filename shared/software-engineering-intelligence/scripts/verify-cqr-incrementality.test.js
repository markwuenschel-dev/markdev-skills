"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseArguments,
  validateScenarioEvidence,
} = require("./verify-cqr-incrementality.js");

const SHA = `sha256:${"a".repeat(64)}`;
const REVISION = "b".repeat(40);

function scenario() {
  return {
    name: "s1-one-file",
    revision: REVISION,
    root_tree: "c".repeat(40),
    forced_cold: {
      snapshot_sha256: SHA,
      report_sha256: SHA,
      comparison_sha256: SHA,
    },
    incremental: {
      snapshot_sha256: SHA,
      report_sha256: SHA,
      comparison_sha256: SHA,
      phase_reconciled: true,
      static_mode: "partial",
      static_recomputed: 1,
      history_mode: "append",
      history_appended: 1,
      consumer_tasks: 2,
      python_tasks: 1,
      artifacts_within_output: true,
    },
  };
}

test("CQR incrementality oracle arguments are closed and exact", () => {
  assert.deepEqual(parseArguments([
    "--repo", "C:\\cqr",
    "--revision", "c8e6137c5d7d78dc75b6c6c383f0ed3cf2d937a6",
    "--baseline-sei-root", "C:\\baseline",
    "--candidate-sei-root", "C:\\candidate",
    "--python", "C:\\Python313\\python.exe",
    "--out", "C:\\out",
  ]), {
    repositoryRoot: "C:\\cqr",
    revision: "c8e6137c5d7d78dc75b6c6c383f0ed3cf2d937a6",
    baselineSeiRoot: "C:\\baseline",
    candidateSeiRoot: "C:\\candidate",
    pythonExecutable: "C:\\Python313\\python.exe",
    out: "C:\\out",
  });
  assert.throws(() => parseArguments(["--repo", "x", "--unknown", "y"]), /FAIL-CQR-INCREMENTAL-ORACLE.*unsupported/);
});

test("scenario evidence rejects every required binding, parity, telemetry, and containment drift", () => {
  assert.doesNotThrow(() => validateScenarioEvidence(scenario(), {
    expectedName: "s1-one-file",
    expectedStaticMode: "partial",
    expectedStaticRecomputed: 1,
    expectedHistoryMode: "append",
    expectedHistoryAppended: 1,
  }));
  const drifts = [
    ["revision", "d".repeat(40)],
    ["root_tree", "e".repeat(40)],
    ["forced_cold.snapshot_sha256", `sha256:${"f".repeat(64)}`],
    ["incremental.report_sha256", `sha256:${"1".repeat(64)}`],
    ["incremental.comparison_sha256", `sha256:${"2".repeat(64)}`],
    ["incremental.phase_reconciled", false],
    ["incremental.static_recomputed", 2],
    ["incremental.artifacts_within_output", false],
  ];
  for (const [key, value] of drifts) {
    const candidate = structuredClone(scenario());
    const parts = key.split(".");
    let target = candidate;
    while (parts.length > 1) target = target[parts.shift()];
    target[parts[0]] = value;
    assert.throws(() => validateScenarioEvidence(candidate, {
      expectedName: "s1-one-file",
      expectedRevision: REVISION,
      expectedRootTree: "c".repeat(40),
      expectedStaticMode: "partial",
      expectedStaticRecomputed: 1,
      expectedHistoryMode: "append",
      expectedHistoryAppended: 1,
    }), /FAIL-CQR-INCREMENTAL-ORACLE/);
  }
});
