#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { evaluateImpactGate } = require("../impact-gate");

try {
  const bytes = fs.readFileSync(0);
  if (bytes.length === 0 || bytes.length > 1024 * 1024) throw new Error("FAIL-IMPACT-GATE-INPUT: stdin must contain 1..1048576 bytes");
  const input = JSON.parse(bytes.toString("utf8"));
  process.stdout.write(`${JSON.stringify(evaluateImpactGate(input))}\n`);
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
}
