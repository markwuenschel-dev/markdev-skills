#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJson, buildReportData } = require("./report-model.js");
const workspace = require("../../shared/project-intelligence-workspace/project-intelligence-workspace.js");

function parseArgs(argv) {
  const out = { fixture: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--request", "--health", "--integrity", "--architecture", "--testing-fitness", "--ria-envelope", "--output", "--repo"].includes(arg)) {
      if (!argv[index + 1]) throw new Error(`MISSING_VALUE:${arg}`);
      out[arg.slice(2)] = argv[++index];
    } else if (arg === "--fixture") out.fixture = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("usage: node scripts/build-report-data.js --request <json> --health <json> --integrity <json> --architecture <json> [--testing-fitness <ria.testing-fitness@1.json>] [--ria-envelope <owner-envelope.json> --repo <repository-root>] [--output <json>] [--repo <repository-root>] [--fixture]");
    return;
  }
  for (const key of ["request", "health", "integrity", "architecture"]) if (!args[key]) throw new Error(`--${key} is required`);
  const skillRoot = path.resolve(__dirname, "..");
  const requestFile = readJson(args.request, "request");
  const healthFile = readJson(args.health, "health");
  const integrityFile = readJson(args.integrity, "integrity");
  const architectureFile = readJson(args.architecture, "architecture");
  // The public flag is kebab-case; keep the internal property name identical
  // to the parsed flag so a supplied specialist sidecar cannot disappear.
  const testingFitnessFile = args["testing-fitness"] ? readJson(args["testing-fitness"], "testing-fitness") : null;
  // composite-scoring-v3 Phase 8: with the bound owner envelope, the v2 shadow reads the same
  // SEI assessment, verification baseline and Architecture evidence RIA bound; without it the
  // shadow degrades explicitly (missing evidence) and v1 is unchanged.
  let v2 = null;
  if (args["ria-envelope"]) {
    if (!args.repo) throw new Error("--ria-envelope requires --repo");
    const { v2ContextFromEnvelope } = require("./composite-v2-model.js");
    v2 = v2ContextFromEnvelope({ envelope: readJson(args["ria-envelope"], "ria-envelope").value, repositoryRoot: path.resolve(args.repo), architectureArtifact: architectureFile.value });
  }
  const reportData = buildReportData({ request: requestFile.value, healthFile, integrityFile, architectureFile, testingFitnessFile, skillRoot, fixture: args.fixture, v2 });
  const output = args.output ? path.resolve(args.output) : workspace.reportPath(args.repo || process.cwd(), "ria", `ria-report-data-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(reportData, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, output);
  console.log(JSON.stringify({ kind: "repository-improvement-assessment-report-data", schema_version: 3, output, bytes: fs.statSync(output).size }));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}

module.exports = { parseArgs };
