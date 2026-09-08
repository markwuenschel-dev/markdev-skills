"use strict";

const assert = require("node:assert/strict");
const { parseArgs } = require("./build-report-data.js");

const parsed = parseArgs([
  "node",
  "build-report-data.js",
  "--request", "request.json",
  "--health", "health.json",
  "--integrity", "integrity.json",
  "--architecture", "architecture.json",
  "--testing-fitness", "testing.json",
]);

assert.equal(parsed["testing-fitness"], "testing.json");
assert.equal(parsed.testing_fitness, undefined);
assert.throws(() => parseArgs(["node", "build-report-data.js", "--testing-fitness"]), /MISSING_VALUE/);
console.log("RIA_BUILD_REPORT_DATA_ARGS_OK");
