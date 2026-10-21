"use strict";

const { performance } = require("node:perf_hooks");
const { deriveTemporalCoupling } = require("../temporal-coupling.js");

function syntheticCommit(fileCount) {
  return {
    revision: `${String(fileCount).padStart(40, "0")}`,
    timestamp: "2026-08-10T00:00:00.000Z",
    author: "benchmark@example.test",
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `src/file-${String(index).padStart(5, "0")}.js`,
      eligible_for_temporal_coupling: true,
    })),
  };
}

function runTemporalCouplingBenchmark({ sizes = [10, 100, 1_000, 5_000], policy } = {}) {
  if (!Array.isArray(sizes) || sizes.some((size) => !Number.isInteger(size) || size < 1)) {
    throw new Error("FAIL-INVALID-TEMPORAL-BENCHMARK: sizes must be positive integers");
  }
  const curves = sizes.map((fileCount) => {
    const beforeHeap = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const result = deriveTemporalCoupling({ commits: [syntheticCommit(fileCount)], policy });
    const elapsedMs = performance.now() - startedAt;
    const afterHeap = process.memoryUsage().heapUsed;
    return {
      file_count: fileCount,
      elapsed_ms: elapsedMs,
      heap_delta_bytes: afterHeap - beforeHeap,
      relationship_count: result.relationships.length,
      pair_bound: result.pair_generation_bound,
      mass_change_policy: result.mass_change_policy,
    };
  });
  return { benchmark_id: "sei-temporal-coupling-benchmark-v1", curves };
}

module.exports = { runTemporalCouplingBenchmark, syntheticCommit };
