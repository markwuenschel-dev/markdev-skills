"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
for (const name of ["ASSESSMENT-VERIFICATION-BASELINE.md", "verification-baseline.js", "verification-baseline.schema.json", "verification-baseline.test.js", "MANIFEST.json"]) {
  if (!fs.existsSync(path.join(root, name))) throw new Error(`MISSING:${name}`);
}
require("./verification-baseline.test.js");
console.log("ASSESSMENT_VERIFICATION_BASELINE_PACKAGE_OK");
