#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const ER = require("./evidence-recon.js");
const { run } = require("./evidence-recon.test.js");

const required = [
  "MANIFEST.json", "EVIDENCE-MODEL.md", "MODE-SELECTION.md", "NEGATIVE-CLAIMS.md",
  "CONTRADICTION-RECONCILIATION.md", "ADOPTION.md", "evidence-packet.schema.json", "expedition-lane.schema.json",
  "canonical-evidence-packet.json", "fixtures/expedition-evidence-packet.json", "evidence-recon.js"
];
let failed = 0;
for (const rel of required) {
  if (!fs.existsSync(path.join(__dirname, rel))) { console.error(`MISSING ${rel}`); failed++; }
  else console.log(`ok file ${rel}`);
}
for (const rel of ["MANIFEST.json", "evidence-packet.schema.json", "expedition-lane.schema.json", "canonical-evidence-packet.json", "fixtures/expedition-evidence-packet.json"]) {
  try { JSON.parse(fs.readFileSync(path.join(__dirname, rel), "utf8")); console.log(`ok json ${rel}`); }
  catch (error) { console.error(`FAIL json ${rel}: ${error.message}`); failed++; }
}
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "MANIFEST.json"), "utf8"));
for (const rel of manifest.owned_files || []) {
  if (!fs.existsSync(path.join(__dirname, rel))) { console.error(`MISSING owned file ${rel}`); failed++; }
}
if (manifest.version !== "1.0.0" || manifest.protocol_versions.evidence_packet_version !== ER.EVIDENCE_PACKET_VERSION) {
  console.error("FAIL manifest/protocol version mismatch"); failed++;
} else console.log("ok manifest/protocol version");
if (!failed) failed += run();
console.log(`${failed ? "EVIDENCE_RECON_PACKAGE_RED" : "EVIDENCE_RECON_PACKAGE_OK"}`);
process.exit(failed ? 1 : 0);
