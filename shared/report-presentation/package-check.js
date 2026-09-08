"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = __dirname;
for (const rel of ["MANIFEST.json","REPORT-PRESENTATION.md","report-presentation.js","report-presentation.test.js","family-adoption.test.js","report-builders.test.js"]) {
  assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
}
const manifest = require("./MANIFEST.json");
assert.equal(manifest.name, "report-presentation");
assert.equal(manifest.version, "1.0.0");
require("./report-presentation.test.js");
require("./family-adoption.test.js");
require("./report-builders.test.js");
console.log("REPORT_PRESENTATION_PACKAGE_OK");
