#!/usr/bin/env node
"use strict";
/* Prints nominal owner influence (composite-scoring-v3 §4.2) from the scoring
 * config, read through the loader. Docs quote this output; tests call the
 * same computation. Usage: node print-influence.js [--json] [--config <path>] */
const { loadScoringConfig } = require("./composite-v2-config.js");

const args = process.argv.slice(2);
const json = args.includes("--json");
const configIndex = args.indexOf("--config");
const loaded = loadScoringConfig(configIndex >= 0 ? { configPath: args[configIndex + 1] } : {});
const rows = Object.entries(loaded.nominal_influence).map(([owner, value]) => ({ owner, influence: Math.round(value * 10) / 10 }));
if (json) {
  process.stdout.write(`${JSON.stringify({ config_version: loaded.config_version, config_sha256: loaded.config_sha256, influence: Object.fromEntries(rows.map(row => [row.owner, row.influence])) })}\n`);
} else {
  process.stdout.write(`Nominal influence, config ${loaded.config_version} (${loaded.config_sha256.slice(0, 12)})\n`);
  for (const row of rows) process.stdout.write(`  ${row.owner.padEnd(13)} ${row.influence.toFixed(1)}%\n`);
}
