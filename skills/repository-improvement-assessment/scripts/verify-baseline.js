#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { verifyBaseline } = require("../baseline.js");
try {
  if (!process.argv[2]) throw new Error("usage: verify-baseline.js <baseline.json>");
  const result = verifyBaseline(JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), "utf8")));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
