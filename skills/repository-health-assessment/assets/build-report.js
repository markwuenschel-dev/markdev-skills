#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" || arg === "--output" || arg === "--ledger-verify") {
      if (!argv[i + 1]) throw new Error("MISSING_VALUE:" + arg);
      out[arg.slice(2).replace(/-/g, "_")] = argv[++i];
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error("UNKNOWN_ARGUMENT:" + arg);
  }
  return out;
}

function existing(candidates, label) {
  for (const candidate of candidates.filter(Boolean)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(label + "_NOT_FOUND\nsearched:\n" + candidates.filter(Boolean).join("\n"));
}

function sharedFile(skillRoot, packageName, fileName, envPath) {
  let envCandidate = null;
  if (envPath) {
    const resolved = path.resolve(envPath);
    envCandidate = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? path.join(resolved, fileName) : resolved;
  }
  return existing([
    envCandidate,
    path.resolve(skillRoot, "..", "shared", packageName, fileName),
    path.resolve(skillRoot, "..", "..", "shared", packageName, fileName),
    path.resolve(process.cwd(), "shared", packageName, fileName),
    path.resolve(process.cwd(), "skills", "shared", packageName, fileName)
  ], packageName.toUpperCase().replace(/-/g, "_") + "_FILE");
}

function usage() {
  console.log("usage: node assets/build-report.js --input <json> [--output <html>] [--ledger-verify <file-or-package-dir>]");
}

function loadHealthVerifier(ledgerSource, healthSource, ledgerPath, healthPath) {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(ledgerSource, sandbox, { filename: ledgerPath });
  vm.runInNewContext(healthSource, sandbox, { filename: healthPath });
  if (!sandbox.HealthVerify || typeof sandbox.HealthVerify.verifyHealth !== "function") throw new Error("HEALTH_VERIFY_API_MISSING");
  return sandbox.HealthVerify;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();
  if (!args.input) throw new Error("--input is required");

  const skillRoot = path.resolve(__dirname, "..");
  const compilerPath = sharedFile(skillRoot, "assessment-acceleration", "report-compiler.js", process.env.ASSESSMENT_ACCELERATION_PATH);
  const ledgerPath = args.ledger_verify || sharedFile(skillRoot, "candidate-ledger-spine", "ledger-verify.js", process.env.LEDGER_VERIFY_PATH);
  const { escapeHtml, safeJsonForScript, compileTemplate } = require(compilerPath);

  const parsed = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
  if (!parsed || parsed.report_schema_version !== 1) throw new Error("REPORT_SCHEMA_VERSION_MUST_BE_1");
  const allowedTop = new Set(["report_schema_version", "health", "prose", "performance_receipt"]);
  for (const key of Object.keys(parsed)) if (!allowedTop.has(key)) throw new Error("REPORT_INPUT_UNKNOWN_FIELD:" + key);
  const health = parsed.health;
  const prose = parsed.prose;
  if (!health || typeof health !== "object") throw new Error("REPORT_INPUT_HEALTH_REQUIRED");
  if (!prose || typeof prose !== "object") throw new Error("REPORT_INPUT_PROSE_REQUIRED");

  const healthPath = path.join(__dirname, "health-verify.js");
  const ledgerSource = fs.readFileSync(ledgerPath, "utf8");
  const healthSource = fs.readFileSync(healthPath, "utf8");
  const verified = loadHealthVerifier(ledgerSource, healthSource, ledgerPath, healthPath).verifyHealth(health);
  if (!verified.ok) throw new Error("HEALTH_INVALID:\n" + verified.problems.map(problem => `[${problem.code}] ${problem.message}`).join("\n"));

  const requiredProse = [
    "one-sentence-verdict", "executive-summary", "grade-drivers", "coverage-denominator",
    "architecture-and-integration-health", "confirmed-observations", "inferred-observations",
    "unknown-observations", "confidence-improvement"
  ];

  for (const key of Object.keys(prose)) if (!requiredProse.includes(key)) throw new Error("REPORT_PROSE_UNKNOWN:" + key);
  if (parsed.performance_receipt != null && (typeof parsed.performance_receipt !== "object" || Array.isArray(parsed.performance_receipt))) throw new Error("PERFORMANCE_RECEIPT_INVALID");

  let template = fs.readFileSync(path.join(__dirname, "report-scaffold.html"), "utf8");
  for (const key of requiredProse) {
    if (typeof prose[key] !== "string" || !prose[key].trim()) throw new Error("REPORT_PROSE_REQUIRED:" + key);
    const marker = new RegExp(`<p\\b([^>]*\\bdata-prose-required="${key}"[^>]*)>\\s*</p>`, "g");
    const matches = [...template.matchAll(marker)];
    if (matches.length !== 1) throw new Error("REPORT_PROSE_MARKER_" + (matches.length ? "DUPLICATE" : "MISSING") + ":" + key);
    template = template.replace(marker, `<p$1>${escapeHtml(prose[key])}</p>`);
  }

  const stagedTemplate = path.join(os.tmpdir(), "repository-health-template-" + process.pid + "-" + Date.now() + ".html");
  fs.writeFileSync(stagedTemplate, template, "utf8");
  try {
    const output = path.resolve(args.output || path.join(os.tmpdir(), "repository-health-" + Date.now() + ".html"));
    const receipt = parsed.performance_receipt || { mode: "not-recorded" };
    const compiled = compileTemplate({
      template: stagedTemplate,
      output,
      replacements: {
        "<!-- REPORT:HEALTH_ISLAND -->": safeJsonForScript(health),
        "/* REPORT:LEDGER_VERIFY */": ledgerSource,
        "/* REPORT:HEALTH_VERIFY */": healthSource,
        "<!-- REPORT:PERFORMANCE_RECEIPT -->": escapeHtml(JSON.stringify(receipt, null, 2))
      }
    });
    console.log(JSON.stringify({ kind: "repository-health-report", ...compiled }));
  } finally {
    fs.rmSync(stagedTemplate, { force: true });
  }
}

try { main(); }
catch (error) { console.error(error.stack || error); process.exitCode = 1; }
