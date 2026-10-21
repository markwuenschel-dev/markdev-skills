#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" || arg === "--output" || arg === "--ledger-verify" || arg === "--repo") {
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

const USAGE = "usage: node assets/build-report.js --input <report-input.json> [--repo <repository-root>] [--output <html>] [--ledger-verify <file-or-package-dir>]\n" +
  "  --input follows assets/report-input.schema.json. Default output: <repo>/.project-intelligence/reports/health/repository-health-<ms>.html";
function usage(stream = console.log) { stream(USAGE); }

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
  if (!args.input) { usage(console.error); process.exitCode = 2; return; }

  const skillRoot = path.resolve(__dirname, "..");
  const compilerPath = sharedFile(skillRoot, "assessment-acceleration", "report-compiler.js", process.env.ASSESSMENT_ACCELERATION_PATH);
  const ledgerPath = args.ledger_verify || sharedFile(skillRoot, "candidate-ledger-spine", "ledger-verify.js", process.env.LEDGER_VERIFY_PATH);
  const { escapeHtml, safeJsonForScript, compileTemplate } = require(compilerPath);
  const presentation = require(sharedFile(skillRoot, "report-presentation", "report-presentation.js", process.env.REPORT_PRESENTATION_PATH));
  const workspace = require(sharedFile(skillRoot, "project-intelligence-workspace", "project-intelligence-workspace.js", process.env.PROJECT_INTELLIGENCE_WORKSPACE_PATH));

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


  const countBy = (values, selector) => {
    const counts = new Map();
    for (const value of values || []) { const key = String(selector(value) ?? "unknown"); counts.set(key, (counts.get(key) || 0) + 1); }
    return [...counts.entries()].map(([label, value]) => ({ label, value })).sort((a,b) => b.value-a.value || a.label.localeCompare(b.label));
  };
  const analytics = [
    `<article class="rp-chart-card rp-half"><h3>Overall health score</h3>${presentation.scoreGauge({ id:"rha-score", title:"Repository health score", description:`Canonical health score ${verified.grade.raw_score} and final grade ${verified.grade.final_grade}.`, score:verified.grade.raw_score, grade:verified.grade.final_grade, note:`Raw grade ${verified.grade.raw_grade}; weighted coverage ${verified.coverage.weighted_coverage}%.` })}</article>`,
    `<article class="rp-chart-card rp-half"><h3>Lane profile</h3>${presentation.horizontalBarChart({ id:"rha-lanes", title:"Health lane profile", description:"Canonical lane scores, weakest first.", items:verified.lanes.map(lane => ({label:lane.lane + (lane.critical ? " · critical" : ""), value:lane.computed.score})).sort((a,b)=>a.value-b.value), max:100, unit:"/100" })}</article>`,
    `<article class="rp-chart-card"><h3>Coverage states</h3>${presentation.donutChart({ id:"rha-coverage", title:"Coverage state distribution", description:"Count of assessed surfaces by coverage state.", items:countBy(verified.coverage.rows,row=>row.coverage), note:`Weighted coverage ${verified.coverage.weighted_coverage}%.` })}</article>`,
    `<article class="rp-chart-card"><h3>Evidence quality</h3>${presentation.donutChart({ id:"rha-evidence", title:"Evidence quality distribution", description:"Applicable surfaces by evidence quality.", items:countBy(verified.coverage.rows.filter(row=>row.applicable),row=>row.evidence_quality || "none"), note:`Evidence strength ${verified.coverage.evidence_strength}%.` })}</article>`,
    `<article class="rp-chart-card"><h3>Verification duration</h3>${presentation.horizontalBarChart({ id:"rha-commands", title:"Verification command duration", description:"Elapsed seconds for recorded verification commands.", items:(verified.commands || []).map(command => ({label:command.kind + " · " + command.command, value:command.elapsed_seconds ?? null})), unit:"s", note:"Skipped commands remain unavailable rather than becoming zero." })}</article>`,
  ].join("");

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

  const repositoryRoot = args.repo || process.cwd();
  const scratch = workspace.createScratchSession(repositoryRoot, "rha-report-template");
  const stagedTemplate = path.join(scratch.path, "template.html");
  fs.writeFileSync(stagedTemplate, template, "utf8");
  try {
    const output = args.output ? path.resolve(args.output) : workspace.reportPath(repositoryRoot, "health", "repository-health-" + Date.now() + ".html");
    const receipt = parsed.performance_receipt || { mode: "not-recorded" };
    const compiled = compileTemplate({
      template: stagedTemplate,
      output,
      replacements: {
        "<!-- REPORT:HEALTH_ISLAND -->": safeJsonForScript(health),
        "/* REPORT:LEDGER_VERIFY */": ledgerSource,
        "/* REPORT:HEALTH_VERIFY */": healthSource,
        "<!-- REPORT:PERFORMANCE_RECEIPT -->": escapeHtml(JSON.stringify(receipt, null, 2)),
        "<!-- REPORT:RESPONSIVE_ANALYTICS -->": analytics,
        "/* REPORT:SHARED_PRESENTATION_CSS */": presentation.responsiveCss(),
        "/* REPORT:SHARED_PRESENTATION_SCRIPT */": presentation.progressiveScript()
      }
    });
    const quality = presentation.inspectResponsiveReport(fs.readFileSync(output, "utf8"), { requireVisualization:true });
    if (!quality.ok) throw new Error("REPORT_PRESENTATION_GATE_FAILED:" + quality.problems.join("; "));
    console.log(JSON.stringify({ kind: "repository-health-report", charts:5, ...compiled }));
  } finally {
    scratch.cleanup();
  }
}

try { main(); }
catch (error) { console.error(error.stack || error); process.exitCode = 1; }
