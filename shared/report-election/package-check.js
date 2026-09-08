"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
for (const rel of ["MANIFEST.json","REPORT-ELECTION.md","report-election.schema.json","report-election.js","report-election.test.js"]) {
  if (!fs.existsSync(path.join(root, rel))) throw new Error("MISSING:" + rel);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "MANIFEST.json"), "utf8"));
if (manifest.name !== "report-election" || manifest.version !== "1.0.0") throw new Error("MANIFEST_IDENTITY_INVALID");
require("./report-election.test.js");
console.log("REPORT_ELECTION_PACKAGE_OK");
