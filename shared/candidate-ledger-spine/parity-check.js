#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path");
const here = __dirname;
const ledger = JSON.parse(fs.readFileSync(path.join(here, "canonical-ledger.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(here, "candidate.schema.json"), "utf8"));
eval(fs.readFileSync(path.join(here, "ledger-verify.js"), "utf8"));
const LV = globalThis.LedgerVerify;
if (!LV || ledger.spine_version !== schema.properties.spine_version.const) process.exit(1);
const result = LV.verifyLedger(ledger);
if (!result.ok) { console.error(result.problems); process.exit(1); }
console.log("GREEN — canonical schema version and executable spine agree");
