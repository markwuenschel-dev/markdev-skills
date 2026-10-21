#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createSnapshot, validateSnapshot } = require("./intelligence-engine.js");

function verifyFile(filePath) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`FAIL-SNAPSHOT-READ: ${error.message}`] };
  }

  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    return validation;
  }

  try {
    const first = JSON.stringify(createSnapshot(snapshot));
    const second = JSON.stringify(createSnapshot(structuredClone(snapshot)));
    if (first !== second) {
      return { ok: false, errors: ["FAIL-NONDETERMINISTIC-SNAPSHOT: canonicalization changed between identical inputs"] };
    }
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }

  return { ok: true, errors: [] };
}

function main(argv) {
  const filePath = path.resolve(argv[2] ?? path.join(__dirname, "canonical-intelligence.json"));
  const result = verifyFile(filePath);
  if (!result.ok) {
    for (const error of result.errors) console.error(error);
    return 1;
  }
  console.log(`ok ${filePath}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main, verifyFile };
