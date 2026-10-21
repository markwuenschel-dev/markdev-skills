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
  if (args.help) { console.log("usage: node assets/build-report.js --input <json> [--output <html>] [--repo <repository-root>] [--ledger-verify <file-or-package-dir>]"); return; }
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
  requireString(input.summary, "summary");
  requireArray(input.health_map, "health_map");
  requireArray(input.candidates, "candidates");
  if (!input.observations || !input.ledger) throw new Error("REPORT_OBSERVATIONS_AND_LEDGER_REQUIRED");

  const verified = LV.verifyLedger(input.ledger);
  if (!verified.ok) throw new Error("LEDGER_INVALID:\n" + verified.problems.map(p => `[${p.code}] ${p.message}`).join("\n"));

  const countBy = (values, selector) => { const counts = new Map(); for (const value of values || []) { const key = String(selector(value) ?? "unknown"); counts.set(key,(counts.get(key)||0)+1); } return [...counts.entries()].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value || a.label.localeCompare(b.label)); };
  const presentations = new Map();
  for (const item of input.candidates) {
    const id = requireString(item && item.candidate_id, "candidates[].candidate_id");
    if (presentations.has(id)) throw new Error("PRESENTATION_DUPLICATE:" + id);
    for (const field of ["category", "location", "friction", "root_seam", "integrity_rule", "before", "after", "recommended_branch", "enforceable_check"]) requireString(item[field], id + "." + field);
    for (const field of ["confirmed", "inferred", "unknown", "recommended_lenses", "benefits"]) requireStringArray(item[field], id + "." + field);
    presentations.set(id, item);
  }
  for (const candidate of verified.candidates) if (!presentations.has(candidate.candidate_id)) throw new Error("PRESENTATION_MISSING:" + candidate.candidate_id);
  for (const id of presentations.keys()) if (!verified.candidates.some(c => c.candidate_id === id)) throw new Error("PRESENTATION_UNKNOWN:" + id);

  const list = values => (values.length ? values : ["none recorded"]).map(value => `<li>${escapeHtml(value)}</li>`).join("");
  const healthMap = input.health_map.map(item => `<article class="surface map-item"><div class="map-state">${escapeHtml(requireString(item.state, "health_map.state"))}</div><h3>${escapeHtml(requireString(item.label, "health_map.label"))}</h3><p>${escapeHtml(requireString(item.detail, "health_map.detail"))}</p></article>`).join("\n");
  const observations = ["confirmed", "inferred", "unknown"].map(key => {
    const values = requireStringArray(input.observations[key], "observations." + key);
    return `<div class="obs"><h3>${key}</h3><ul>${list(values)}</ul></div>`;
  }).join("");

  const cards = verified.candidates.map(candidate => {
    const item = presentations.get(candidate.candidate_id);
    const rank = candidate.rank;
    const chips = [item.category, candidate.effort ? "effort " + candidate.effort : null, candidate.status].filter(Boolean).map(value => `<span class="chip">${escapeHtml(value)}</span>`).join("");
    return `<article class="surface candidate" id="candidate-${rank}" data-candidate="${escapeHtml(candidate.candidate_id)}">
      <a class="rail" href="#candidate-${rank}" aria-label="candidate rank ${rank}"><span data-rank="${escapeHtml(candidate.candidate_id)}"></span><span class="vertical">${escapeHtml(item.category)}</span></a>
      <div class="body">
        <h2>${escapeHtml(candidate.title)}</h2><div class="chips">${chips}</div><div class="meter" data-meter="${escapeHtml(candidate.candidate_id)}"></div>
        <div class="location">${escapeHtml(item.location)}</div>
        <div class="facts"><div class="fact"><div class="label">Current friction</div><p>${escapeHtml(item.friction)}</p></div><div class="fact"><div class="label">Root seam</div><p>${escapeHtml(item.root_seam)}</p></div><div class="fact"><div class="label">Integrity rule</div><p>${escapeHtml(item.integrity_rule)}</p></div></div>
        <div class="evidence"><div class="bucket"><div class="label">Confirmed</div><ul>${list(item.confirmed)}</ul></div><div class="bucket"><div class="label">Inferred</div><ul>${list(item.inferred)}</ul></div><div class="bucket"><div class="label">Unknown</div><ul>${list(item.unknown)}</ul></div></div>
        <div class="transform"><div class="side"><div class="label">Before</div><p>${escapeHtml(item.before)}</p></div><div class="arrow">→</div><div class="side after"><div class="label">After</div><p>${escapeHtml(item.after)}</p></div></div>
        <div class="execution"><div><div class="label">Branch and lenses</div><p>${escapeHtml(item.recommended_branch)} · ${escapeHtml(item.recommended_lenses.join(", "))}</p></div><div><div class="label">Enforceable check</div><p>${escapeHtml(item.enforceable_check)}</p></div></div>
        <ul class="wins">${item.benefits.map(value => `<li>${escapeHtml(value)}</li>`).join("")}</ul>
      </div>
    </article>`;
  }).join("\n");

  const scoreKeys = ["severity","confidence","leverage","locality","testability","blast_radius","regression_risk","human_decision_risk"];
  const scoreAverages = scoreKeys.map(key => { const values=verified.candidates.map(c=>Number(c.scores?.[key])).filter(Number.isFinite); return {label:key.replaceAll("_"," "), value:values.length ? values.reduce((a,b)=>a+b,0)/values.length : null}; });
  const analytics = [
    `<article class="rp-chart-card rp-half"><h3>Candidate priority</h3>${presentation.horizontalBarChart({id:"integrity-priority",title:"Integrity candidate priority",description:"Canonical candidate-ledger priority scores, highest first.",items:verified.candidates.slice(0,14).map(c=>({label:c.candidate_id+" · "+c.title,value:c.computed.priority})),note:"Scores are recomputed by shared/candidate-ledger-spine."})}</article>`,
    `<article class="rp-chart-card"><h3>Status distribution</h3>${presentation.donutChart({id:"integrity-status",title:"Integrity candidate status",description:"Candidate distribution by canonical status.",items:countBy(verified.candidates,c=>c.status)})}</article>`,
    `<article class="rp-chart-card"><h3>Priority bands</h3>${presentation.donutChart({id:"integrity-bands",title:"Integrity priority bands",description:"Candidate distribution by canonical scoring band.",items:countBy(verified.candidates,c=>c.band?.label||"unscored")})}</article>`,
    `<article class="rp-chart-card rp-half"><h3>Scoring profile</h3>${presentation.horizontalBarChart({id:"integrity-score-profile",title:"Average candidate scoring profile",description:"Average canonical ledger component scores. Value dimensions and risk dimensions remain distinct in the ledger.",items:scoreAverages,max:4,note:"Averages summarize the portfolio; they do not replace per-candidate scores."})}</article>`,
  ].join("");

  const top = verified.candidates[0];
  const topItem = top ? presentations.get(top.candidate_id) : null;
  const hero = top ? `<section class="surface hero"><div class="eyebrow">Highest-ranked candidate</div><a href="#candidate-${top.rank}">${escapeHtml(top.title)}</a><p>${escapeHtml(topItem.friction)}</p></section>` : "";
  const output = args.output ? path.resolve(args.output) : workspace.reportPath(args.repo || process.cwd(), "integrity", "integrity-candidates-" + Date.now() + ".html");
  const compiled = compileTemplate({
    template: path.join(__dirname, "report-scaffold.html"), output,
    replacements: {
      "<!-- REPORT:TITLE -->": escapeHtml("Codebase integrity — " + input.repository.name),
      "<!-- REPORT:REPOSITORY_NAME -->": escapeHtml(input.repository.name),
      "<!-- REPORT:SUMMARY -->": escapeHtml(input.summary),
      "<!-- REPORT:TOP_CANDIDATE -->": hero,
      "<!-- REPORT:HEALTH_MAP -->": healthMap,
      "<!-- REPORT:OBSERVATIONS -->": observations,
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
  console.log(JSON.stringify({ kind: "integrity-report", candidates: verified.candidates.length, charts:4, ...compiled }));
}

try { main(); }
catch (error) { console.error(error.stack || error); process.exitCode = 1; }
