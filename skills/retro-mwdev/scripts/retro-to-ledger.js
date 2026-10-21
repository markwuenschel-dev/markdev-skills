#!/usr/bin/env node
// Convert retro-mwdev findings into candidate-ledger-spine v3 candidates, then verify them
// with the spine's own ledger-verify.js, so production-flywheel can take them as ledger work.
// Usage: node retro-to-ledger.js <findings.json> [--out ledger.json] [--at <ISO timestamp>] [--spine <ledger-verify.js>]
// exit 0 = valid ledger written, 1 = invalid findings or ledger, 2 = usage
"use strict";
const fs = require("fs");
const path = require("path");

const CATEGORIES = ["navigation", "automated-checks", "verification", "coding-standards", "steering-files", "skills", "tool-economy", "information-access"];
const STATUSES = { confirmed: 5, plausible: 3, unverified: 2 }; // highest confidence score each status may claim
const SCORE_KEYS = ["severity", "confidence", "leverage", "locality", "testability", "blast_radius", "regression_risk", "human_decision_risk"];

function loadSpine(file) {
  eval(fs.readFileSync(file, "utf8")); // classic script: attaches globalThis.LedgerVerify
  if (!globalThis.LedgerVerify || typeof globalThis.LedgerVerify.verifyLedger !== "function") throw new Error("ledger-verify.js did not expose LedgerVerify.verifyLedger");
  return globalThis.LedgerVerify;
}

function validateFinding(f, i) {
  const errs = [];
  const at = `findings[${i}]`;
  for (const k of ["title", "category", "status", "change", "next_run_proof", "owner"]) if (typeof f[k] !== "string" || !f[k].trim()) errs.push(`${at}.${k} is required`);
  if (f.category && !CATEGORIES.includes(f.category)) errs.push(`${at}.category must be one of ${CATEGORIES.join(", ")}`);
  if (f.status && !(f.status in STATUSES)) errs.push(`${at}.status must be confirmed, plausible, or unverified`);
  if (!Array.isArray(f.evidence) || !f.evidence.length) errs.push(`${at}.evidence needs at least one {file, line?, observation}`);
  const sc = f.scores || {};
  for (const k of SCORE_KEYS) if (!Number.isInteger(sc[k]) || sc[k] < 1 || sc[k] > 5) errs.push(`${at}.scores.${k} must be an integer 1-5`);
  if (f.status in STATUSES && Number.isInteger(sc.confidence) && sc.confidence > STATUSES[f.status]) errs.push(`${at}: a ${f.status} finding may not score confidence above ${STATUSES[f.status]}`);
  if (f.effort !== undefined && !["S", "M", "L"].includes(f.effort)) errs.push(`${at}.effort must be S, M, or L`);
  return errs;
}

function toCandidate(f, i, opts, LV) {
  const id = f.id || `RETRO-${String(i + 1).padStart(3, "0")}`;
  const blockedBy = Array.isArray(f.blocked_by) ? f.blocked_by : [];
  const judgment = f.scores.human_decision_risk >= 4 || blockedBy.length > 0;
  return {
    candidate_id: id,
    title: f.title,
    lane_sources: [`retro-mwdev:${f.category}`],
    summary: `${f.change} Next-run proof: ${f.next_run_proof}`,
    root_cause: f.root_cause || f.title,
    evidence: f.evidence.map((e) => ({ file: e.file || opts.session, ...(Number.isInteger(e.line) ? { line: e.line } : {}), observation: e.observation })),
    scores: Object.fromEntries(SCORE_KEYS.map((k) => [k, f.scores[k]])),
    rollup: {
      priority_score: LV.computePriority(f.scores).priority,
      recommended_action: judgment ? "design" : "direct-fix",
      execution_mode: judgment ? "blocked-needs-human-decision" : "sequential",
      blocked_by: blockedBy,
    },
    effort: f.effort || "M",
    depends_on: [],
    unlocks: [],
    status: judgment ? "needs-human-decision" : "ready",
    dedup: { duplicate_group: null, merged_from: [] },
    candidate_lifecycle: {
      candidate_id: id,
      discovered_by: "retro-mwdev",
      current_owner: { skill: f.owner, stage: "awaiting-selection" },
      lifecycle_status: "discovered",
      history: [{ event: `discovered (${f.status})`, timestamp: opts.at, artifact: opts.session }],
      completion: { completed_at: null, verification_refs: [] },
      resolution: { superseded_by: null, reason: null },
    },
  };
}

function convert(input, opts) {
  const LV = loadSpine(opts.spine);
  const findings = Array.isArray(input && input.findings) ? input.findings : null;
  if (!findings) return { errors: ["input needs a findings array"] };
  const errors = findings.flatMap(validateFinding);
  if (errors.length) return { errors };
  const ledger = { spine_version: 3, candidates: findings.map((f, i) => toCandidate(f, i, { ...opts, session: input.session || "retro-session" }, LV)) };
  const verified = LV.verifyLedger(ledger);
  if (!verified.ok) return { errors: verified.problems.map((p) => `ledger: ${p.code} ${p.message}`) };
  return { ledger, queue: verified.queue };
}

function main(argv) {
  const opts = { at: new Date().toISOString(), spine: path.join(__dirname, "..", "..", "shared", "candidate-ledger-spine", "ledger-verify.js") };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opts.out = argv[++i];
    else if (argv[i] === "--at") opts.at = argv[++i];
    else if (argv[i] === "--spine") opts.spine = argv[++i];
    else rest.push(argv[i]);
  }
  if (rest.length !== 1 || !fs.existsSync(rest[0]) || !fs.existsSync(opts.spine)) {
    process.stderr.write("usage: retro-to-ledger.js <findings.json> [--out ledger.json] [--at <ISO>] [--spine <ledger-verify.js>]\n");
    return 2;
  }
  let input;
  try { input = JSON.parse(fs.readFileSync(rest[0], "utf8")); } catch (e) { process.stderr.write(`ERROR findings file is not JSON: ${e.message}\n`); return 1; }
  const r = convert(input, opts);
  if (r.errors) { for (const e of r.errors) process.stderr.write(`ERROR ${e}\n`); return 1; }
  const text = JSON.stringify(r.ledger, null, 2) + "\n";
  if (opts.out) fs.writeFileSync(opts.out, text); else process.stdout.write(text);
  process.stderr.write(`OK ${r.ledger.candidates.length} candidate(s); eligible queue: ${r.queue.join(", ") || "none"}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { convert, CATEGORIES };
