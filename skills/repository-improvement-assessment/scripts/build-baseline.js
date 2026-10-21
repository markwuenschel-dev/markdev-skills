#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { buildBaseline, writeBaseline } = require("../baseline.js");
function parse(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (key === "--help" || key === "-h") out.help = true; else if (["--input", "--output"].includes(key)) { if (!argv[i + 1]) throw new Error(`MISSING_VALUE:${key}`); out[key] = argv[++i]; } else throw new Error(`UNKNOWN_ARGUMENT:${key}`); } return out; }
try {
  const args = parse(process.argv.slice(2));
  if (args.help) { process.stdout.write("usage: build-baseline.js --input <request.json> [--output <baseline.json>]\n"); process.exit(0); }
  if (!args["--input"]) throw new Error("--input is required");
  const value = buildBaseline(JSON.parse(fs.readFileSync(path.resolve(args["--input"]), "utf8")));
  if (args["--output"]) process.stdout.write(`${JSON.stringify(writeBaseline(path.resolve(args["--output"]), value))}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
