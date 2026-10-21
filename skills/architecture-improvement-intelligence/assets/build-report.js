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
    if (["--input", "--output", "--ledger-verify", "--repo"].includes(arg)) {
      if (!argv[i + 1]) throw new Error("MISSING_VALUE:" + arg);
      out[arg.slice(2).replace(/-/g, "_")] = argv[++i];
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error("UNKNOWN_ARGUMENT:" + arg);
  }
  return out;
}

function existing(candidates, label) {
  for (const candidate of candidates.filter(Boolean)) if (fs.existsSync(candidate)) return candidate;
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

function loadVerifier(filePath) {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(filePath, "utf8"), sandbox, { filename: filePath });
  if (!sandbox.LedgerVerify || typeof sandbox.LedgerVerify.verifyLedger !== "function") throw new Error("LEDGER_VERIFY_API_MISSING");
  return sandbox.LedgerVerify;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error("REPORT_FIELD_REQUIRED:" + label);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error("REPORT_ARRAY_REQUIRED:" + label);
  return value;
}

function requireStringArray(value, label) {
  return requireArray(value, label).map((item, index) => requireString(item, label + "[" + index + "]"));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("usage: node assets/build-report.js --input <json> [--output <html>] [--repo <repository-root>] [--ledger-verify <file-or-package-dir>]");
    return;
  }
  if (!args.input) throw new Error("--input is required");

  const skillRoot = path.resolve(__dirname, "..");
  const compilerPath = sharedFile(skillRoot, "assessment-acceleration", "report-compiler.js", process.env.ASSESSMENT_ACCELERATION_PATH);
  const ledgerPath = args.ledger_verify || sharedFile(skillRoot, "candidate-ledger-spine", "ledger-verify.js", process.env.LEDGER_VERIFY_PATH);
  const { escapeHtml, safeJsonForScript, compileTemplate } = require(compilerPath);
  const presentation = require(sharedFile(skillRoot, "report-presentation", "report-presentation.js", process.env.REPORT_PRESENTATION_PATH));
  const workspace = require(sharedFile(skillRoot, "project-intelligence-workspace", "project-intelligence-workspace.js", process.env.PROJECT_INTELLIGENCE_WORKSPACE_PATH));
  const LV = loadVerifier(ledgerPath);
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));

  if (!input || input.report_schema_version !== 1) throw new Error("REPORT_SCHEMA_VERSION_MUST_BE_1");
  requireString(input.repository && input.repository.name, "repository.name");
  requireString(input.standfirst, "standfirst");
  requireArray(input.candidates, "candidates");
  if (!input.ledger || typeof input.ledger !== "object") throw new Error("REPORT_LEDGER_REQUIRED");

  const verified = LV.verifyLedger(input.ledger);
  if (!verified.ok) throw new Error("LEDGER_INVALID:\n" + verified.problems.map(p => `[${p.code}] ${p.message}`).join("\n"));

  const countBy = (values, selector) => { const counts = new Map(); for (const value of values || []) { const key = String(selector(value) ?? "unknown"); counts.set(key,(counts.get(key)||0)+1); } return [...counts.entries()].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value || a.label.localeCompare(b.label)); };
  const presentations = new Map();
  for (const item of input.candidates) {
    const id = requireString(item && item.candidate_id, "candidates[].candidate_id");
    if (presentations.has(id)) throw new Error("PRESENTATION_DUPLICATE:" + id);
    requireString(item.problem, id + ".problem");
    requireString(item.solution, id + ".solution");
    requireStringArray(item.files, id + ".files");
    requireStringArray(item.benefits, id + ".benefits");
    if (!item.before || typeof item.before !== "object" || !item.after || typeof item.after !== "object") throw new Error("TRANSFORM_REQUIRED:" + id);
    requireString(item.before.label, id + ".before.label");
    requireStringArray(item.before.modules, id + ".before.modules");
    if (item.before.note != null) requireString(item.before.note, id + ".before.note");
    requireString(item.after.label, id + ".after.label");
    requireString(item.after.module, id + ".after.module");
    requireString(item.after.interface, id + ".after.interface");
    requireStringArray(item.after.internals, id + ".after.internals");
    if (item.after.note != null) requireString(item.after.note, id + ".after.note");
    if (item.category != null) requireString(item.category, id + ".category");
    if (item.adr_conflict != null) requireString(item.adr_conflict, id + ".adr_conflict");
    presentations.set(id, item);
  }
  for (const candidate of verified.candidates) if (!presentations.has(candidate.candidate_id)) throw new Error("PRESENTATION_MISSING:" + candidate.candidate_id);
  for (const id of presentations.keys()) if (!verified.candidates.some(c => c.candidate_id === id)) throw new Error("PRESENTATION_UNKNOWN:" + id);

  const analytics = [
    `<article class="rp-chart-card rp-half"><h3>Candidate priority</h3>${presentation.horizontalBarChart({id:"aii-priority",title:"Architecture candidate priority",description:"Canonical candidate-ledger priority scores, highest first.",items:verified.candidates.slice(0,14).map(c=>({label:c.candidate_id+" · "+c.title,value:c.computed.priority})),note:"Every displayed priority is recomputed from the canonical ledger."})}</article>`,
    `<article class="rp-chart-card"><h3>Priority bands</h3>${presentation.donutChart({id:"aii-bands",title:"Architecture priority bands",description:"Candidate distribution by canonical scoring band.",items:countBy(verified.candidates,c=>c.band?.label||"unscored")})}</article>`,
    `<article class="rp-chart-card"><h3>Status distribution</h3>${presentation.donutChart({id:"aii-status",title:"Architecture candidate status",description:"Candidate distribution by canonical status.",items:countBy(verified.candidates,c=>c.status)})}</article>`,
    `<article class="rp-chart-card rp-half"><h3>Value versus risk</h3>${presentation.horizontalBarChart({id:"aii-value",title:"Architecture candidate value",description:"Canonical value subtotal for each architecture candidate.",items:verified.candidates.slice(0,14).map(c=>({label:c.candidate_id+" · value",value:c.computed.value})),note:"Risk remains separately recorded in each candidate ledger row."})}</article>`,
  ].join("");

  const topId = requireString(input.top_recommendation && input.top_recommendation.candidate_id, "top_recommendation.candidate_id");
  const top = verified.candidates.find(c => c.candidate_id === topId);
  if (!top) throw new Error("TOP_RECOMMENDATION_UNKNOWN:" + topId);
  const topPresentation = presentations.get(topId);

  const moduleList = values => requireStringArray(values || [], "modules").map(value => `<div class="module">${escapeHtml(value)}</div>`).join("");
  const cards = verified.candidates.map(candidate => {
    const item = presentations.get(candidate.candidate_id);
    const rank = candidate.rank;
    const files = item.files.length ? item.files.join(" · ") : "architecture-level evidence";
    const chips = [item.category || "architecture", candidate.effort ? "effort " + candidate.effort : null, candidate.status].filter(Boolean)
      .map(value => `<span class="chip">${escapeHtml(value)}</span>`).join("");
    const benefits = item.benefits.map(value => `<li>${escapeHtml(value)}</li>`).join("");
    const before = item.before || {};
    const after = item.after || {};
    const adr = item.adr_conflict ? `<div class="adr">⚠ ADR · ${escapeHtml(item.adr_conflict)}</div>` : "";
    return `<article class="surface candidate" id="candidate-${rank}" data-candidate="${escapeHtml(candidate.candidate_id)}">
      <a class="rail" href="#candidate-${rank}" aria-label="candidate rank ${rank}">
        <span data-rank="${escapeHtml(candidate.candidate_id)}"></span><span class="vertical">${escapeHtml(item.category || "architecture")}</span>
      </a>
      <div class="body">
        <h2>${escapeHtml(candidate.title)}</h2>
        <div class="chips">${chips}</div>
        <div class="meter" data-meter="${escapeHtml(candidate.candidate_id)}"></div>
        <div class="files">${escapeHtml(files)}</div>
        <div class="transform">
          <div class="side"><h3>${escapeHtml(before.label || "Before")}</h3>${moduleList(before.modules || [])}${before.note ? `<p class="note">${escapeHtml(before.note)}</p>` : ""}</div>
          <div class="arrow" aria-hidden="true">→</div>
          <div class="side deep"><h3>${escapeHtml(after.label || "After")}</h3><div class="module">${escapeHtml(after.module || candidate.title)}</div><div class="interface">interface · ${escapeHtml(after.interface || "one narrow interface")}</div>${moduleList(after.internals || [])}${after.note ? `<p class="note">${escapeHtml(after.note)}</p>` : ""}</div>
        </div>
        <div class="explain"><div><div class="label">Problem</div><p>${escapeHtml(item.problem)}</p></div><div><div class="label">Solution</div><p>${escapeHtml(item.solution)}</p></div></div>
        <ul class="wins">${benefits}</ul>${adr}
      </div>
    </article>`;
  }).join("\n");

  const topHero = `<section class="surface hero"><div class="eyebrow">Start here</div><a href="#candidate-${top.rank}">${escapeHtml(top.title)}</a><p>${escapeHtml(requireString(input.top_recommendation.why, "top_recommendation.why"))}</p></section>`;
  const output = args.output ? path.resolve(args.output) : workspace.reportPath(args.repo || process.cwd(), "architecture", "architecture-review-" + Date.now() + ".html");
  const compiled = compileTemplate({
    template: path.join(__dirname, "report-scaffold.html"),
    output,
    replacements: {
      "<!-- REPORT:TITLE -->": escapeHtml("Architecture review — " + input.repository.name),
      "<!-- REPORT:REPOSITORY_NAME -->": escapeHtml(input.repository.name),
      "<!-- REPORT:STANDFIRST -->": escapeHtml(input.standfirst),
      "<!-- REPORT:TOP_RECOMMENDATION -->": topHero,
      "<!-- REPORT:CANDIDATE_CARDS -->": cards,
      "<!-- REPORT:PERFORMANCE_RECEIPT -->": escapeHtml(JSON.stringify(input.performance_receipt || { mode: "not-recorded" }, null, 2)),
      "<!-- REPORT:LEDGER -->": safeJsonForScript(input.ledger),
      "<!-- REPORT:RESPONSIVE_ANALYTICS -->": analytics,
      "/* REPORT:SHARED_PRESENTATION_CSS */": presentation.responsiveCss(),
      "/* REPORT:SHARED_PRESENTATION_SCRIPT */": presentation.progressiveScript(),
      "/* REPORT:LEDGER_VERIFY */": fs.readFileSync(ledgerPath, "utf8")
    }
  });
  const quality = presentation.inspectResponsiveReport(fs.readFileSync(output,"utf8"), { requireVisualization:true });
  if (!quality.ok) throw new Error("REPORT_PRESENTATION_GATE_FAILED:" + quality.problems.join("; "));
  console.log(JSON.stringify({ kind: "architecture-report", candidates: verified.candidates.length, charts:4, ...compiled }));
}

try { main(); }
catch (error) { console.error(error.stack || error); process.exitCode = 1; }
