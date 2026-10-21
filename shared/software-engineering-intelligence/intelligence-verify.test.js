"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { verifyFile } = require("./intelligence-verify.js");

const canonicalPath = path.join(__dirname, "canonical-intelligence.json");

test("verifies the canonical snapshot and rejects a tampered provenance binding", () => {
  assert.equal(verifyFile(canonicalPath).ok, true);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sei-verify-"));
  const invalidPath = path.join(directory, "invalid.json");
  const invalid = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  invalid.measurements[0].repository_revision = "tampered";
  fs.writeFileSync(invalidPath, `${JSON.stringify(invalid)}\n`, "utf8");

  const result = verifyFile(invalidPath);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith("FAIL-METRIC-WITHOUT-PROVENANCE:")));
});
