#!/usr/bin/env node
"use strict";
/**
 * review-to-claims: translate one review-fitness-report (v1 or v1.1, from a
 * review-* adapter, scored by shared/review-fitness-runtime) into health claims
 * for one health lane. Review reports become CLAIMS inside a lane; they never
 * replace a lane score.
 *
 *   node review-to-claims.js --report <report.json> --lane <health-lane-id>
 *        --claim-prefix <PFX> [--evidence <evidence.json>] [--revision <sha>]
 *        [--dimensions <dim,dim>] --out <claims.json>
 *   node review-to-claims.js --error-code <CODE> --domain <domain>
 *        --lane <health-lane-id> --claim-prefix <PFX> --out <claims.json>
 *
 * Output: { schema: "rha.review-claims@1", lane, domain, report_sha256,
 *           claims: [...], limitations: [string] }
 *
 * - One claim per scored rule: fail findings, plus pass for every covered rule
 *   without a finding. not-applicable rules produce no claim (a limitation
 *   records the exclusion and its rationale).
 * - fitness.status insufficient-evidence / not-applicable, or a fail-closed
 *   runtime error (--error-code, e.g. EVIDENCE_PROOF_ANALYZER_UNAVAILABLE),
 *   produce zero claims and a limitation, so the parent records an
 *   evidence_workers entry instead of a claim.
 * - Refuses (exit 2) on a schema-invalid report (validated by the runtime's own
 *   validate_report), a --revision mismatch, or --evidence whose hash is not
 *   the report's evidence_sha256.
 * - report_sha256 is sha256 of the report file's bytes as read.
 * - Every claim carries review_source.proof_basis. It is "judgment" iff the
 *   rule is in the v1.1 report's coverage.judged_rules, or the finding's (or
 *   --evidence observation's) proofs include type "model-judgment"; otherwise
 *   "mechanical". A v1 report has no judged_rules and is all mechanical.
 *   Judged claims put their text in observation.inferred, never confirmed:
 *   the runtime checked only the judgment's signature and binding.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SKILLS_ROOT = path.resolve(__dirname, "..", "..");
const RUNTIME_SCRIPTS = path.join(SKILLS_ROOT, "shared", "review-fitness-runtime", "scripts");
const REVIEW_CLI = path.join(RUNTIME_SCRIPTS, "fitness-review.py");
const HEALTH_SCHEMA = path.join(__dirname, "health.schema.json");
const OUTPUT_SCHEMA = "rha.review-claims@1";
const REVIEW_DOMAINS = ["accessibility", "algorithms", "architecture", "data", "maintainability", "performance", "process", "reliability", "security", "testing"];
const SCORED_STATUSES = ["pass", "needs-work", "fail"];
const JUDGMENT_PROOF_TYPE = "model-judgment";

class Refusal extends Error {}

function python() {
  return process.env.REVIEW_FITNESS_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function runPython(args) {
  const run = spawnSync(python(), args, { encoding: "utf8" });
  if (run.error) throw new Refusal("REVIEW_VALIDATOR_UNAVAILABLE:" + (run.error.code || run.error.message));
  return run;
}

/** The runtime's validate_report is the single authority for the report
 * contract; shelling out avoids a second, drifting JS implementation. */
function validateReportFile(file) {
  const run = runPython([REVIEW_CLI, "validate", "--report", file]);
  if (run.status !== 0) throw new Refusal("REVIEW_REPORT_INVALID:" + String(run.stderr || run.stdout).trim());
}

/** sha256 of the runtime's canonical JSON of the evidence file. Python's
 * json.dumps float/escape rules differ from JSON.stringify, so the runtime
 * computes it. */
function evidenceSha256(file) {
  const code = "import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from review_fitness_runtime import canonical_bytes, sha256_bytes, load_json; print(sha256_bytes(canonical_bytes(load_json(Path(sys.argv[2])))))";
  const run = runPython(["-c", code, RUNTIME_SCRIPTS, file]);
  if (run.status !== 0) throw new Refusal("REVIEW_EVIDENCE_INVALID:" + String(run.stderr).trim());
  return String(run.stdout).trim();
}

function healthLanes() {
  const schema = JSON.parse(fs.readFileSync(HEALTH_SCHEMA, "utf8"));
  const lanes = schema && schema.properties && schema.properties.lanes && schema.properties.lanes.items && schema.properties.lanes.items.properties && schema.properties.lanes.items.properties.lane && schema.properties.lanes.items.properties.lane.enum;
  if (!Array.isArray(lanes) || !lanes.length) throw new Refusal("HEALTH_LANE_ENUM_UNREADABLE");
  return lanes;
}

/** Runtime outcome -> health claim result. A failed observation of low or info
 * severity means the control exists but is imperfect: partial. */
function resultFor(outcome, severity) {
  if (outcome === "pass") return "pass";
  if (outcome === "fail") return severity === "low" || severity === "info" ? "partial" : "fail";
  return null;
}

/** "judgment" when the runtime only checked a model judgment's signature and
 * binding for this rule; "mechanical" when an analyzer re-derived the fact. */
function proofBasisFor(ruleId, judgedRules, ...observations) {
  if (judgedRules.has(ruleId)) return "judgment";
  for (const item of observations) {
    if (item && Array.isArray(item.proofs) && item.proofs.some((proof) => proof && proof.type === JUDGMENT_PROOF_TYPE)) return "judgment";
  }
  return "mechanical";
}

function claimId(prefix, n) {
  return prefix + "-" + String(n).padStart(2, "0");
}

function evidenceRefs(observation) {
  const refs = [{ path: observation.location.path, lines: String(observation.location.line), note: "review observation location" }];
  for (const proof of observation.proofs || []) {
    refs.push({ path: proof.artifact_ref, note: "review-proof-bundle/v1 " + proof.type + " claim " + proof.claim_id + " sha256:" + proof.sha256 });
  }
  return refs;
}

function buildClaims({ report, reportSha256, lane, prefix, evidence = null, dimensions = null }) {
  const domain = report.domain;
  const status = report.fitness.status;
  const inScope = (dimension) => !dimensions || dimensions.includes(dimension);
  const limitations = [];
  for (const item of report.not_applicable || []) {
    if (inScope(item.dimension)) limitations.push("review-" + domain + " rule " + item.rule_id + " recorded not-applicable: " + item.rationale);
  }
  if (!SCORED_STATUSES.includes(status)) {
    limitations.unshift("review-" + domain + " produced no claims: fitness status " + status + " (coverage " + report.coverage.status + ", ratio " + report.coverage.ratio + ")");
    return { claims: [], limitations };
  }
  const missing = report.coverage.missing_rules.filter((ruleId) => inScope(ruleRecordDimension(report, ruleId, evidence)));
  if (missing.length) limitations.push("review-" + domain + " rules not checked: " + missing.join(", "));

  const byRule = new Map();
  if (evidence) for (const item of evidence.observations) byRule.set(item.rule_id, item);
  const findings = new Map(report.findings.map((item) => [item.rule_id, item]));
  // v1 reports have no judged_rules: every covered rule was mechanically proved.
  const judgedRules = new Set(Array.isArray(report.coverage.judged_rules) ? report.coverage.judged_rules : []);
  const claims = [];
  let n = 0;
  for (const ruleId of report.coverage.covered_rules) {
    const finding = findings.get(ruleId);
    const observation = finding || byRule.get(ruleId) || null;
    const dimension = observation ? observation.dimension : null;
    if (!observation) {
      limitations.push("review-" + domain + " rule " + ruleId + " passed but no claim was emitted: pass for --evidence to carry its location and proofs");
      continue;
    }
    if (!inScope(dimension)) continue;
    const result = resultFor(observation.outcome, observation.severity);
    if (!result) continue;
    n += 1;
    const verdict = observation.outcome === "pass" ? "passed" : "failed (" + observation.severity + ")";
    const proofBasis = proofBasisFor(ruleId, judgedRules, finding, byRule.get(ruleId));
    const schemaVersion = String(report.schema_version);
    claims.push({
      claim_id: claimId(prefix, n),
      lane,
      statement: "review-" + domain + " " + ruleId + " " + verdict + (proofBasis === "judgment" ? " (model judgment)" : "") + ": " + observation.observation,
      result,
      evidence: evidenceRefs(observation),
      observation: proofBasis === "judgment"
        ? { inferred: observation.observation + " [confidence " + observation.confidence + ", model judgment: the runtime checked its signature and binding only, " + schemaVersion + "]" }
        : { confirmed: observation.observation + " [confidence " + observation.confidence + ", runtime-validated " + schemaVersion + "]" },
      review_source: { domain, report_sha256: reportSha256, rule_id: ruleId, dimension, proof_basis: proofBasis },
    });
  }
  return { claims, limitations };
}

function ruleRecordDimension(report, ruleId, evidence) {
  if (evidence) {
    const hit = evidence.observations.find((item) => item.rule_id === ruleId);
    if (hit) return hit.dimension;
  }
  // Registered rule ids are <domain>.<dimension>.<name>; used only for scoping limitations.
  const parts = ruleId.split(".");
  return parts.length >= 3 ? parts[1] : null;
}

function parseArgs(argv) {
  const keys = ["--report", "--lane", "--claim-prefix", "--revision", "--out", "--evidence", "--dimensions", "--error-code", "--domain"];
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { out.help = true; continue; }
    if (!keys.includes(key)) throw new Error("UNKNOWN_ARGUMENT:" + key);
    if (argv[i + 1] === undefined) throw new Error("MISSING_VALUE:" + key);
    out[key.slice(2).replace(/-/g, "_")] = argv[++i];
  }
  return out;
}

const USAGE = "usage: node review-to-claims.js --report <report.json> --lane <health-lane-id> --claim-prefix <PFX> [--evidence <evidence.json>] [--revision <sha>] [--dimensions <a,b>] --out <claims.json>\n" +
  "       node review-to-claims.js --error-code <CODE> --domain <domain> --lane <health-lane-id> --claim-prefix <PFX> --out <claims.json>";

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(USAGE + "\n"); return 0; }
  if (!args.lane || !args.claim_prefix || !args.out || (!args.report === !args.error_code)) {
    process.stderr.write(USAGE + "\n");
    return 1;
  }
  if (!healthLanes().includes(args.lane)) throw new Refusal("HEALTH_LANE_UNKNOWN:" + args.lane);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(args.claim_prefix)) throw new Refusal("CLAIM_PREFIX_INVALID:" + args.claim_prefix);
  const dimensions = args.dimensions ? args.dimensions.split(",").map((d) => d.trim()).filter(Boolean) : null;
  let output;
  if (args.error_code) {
    if (!REVIEW_DOMAINS.includes(args.domain)) throw new Refusal("REVIEW_DOMAIN_UNKNOWN:" + args.domain);
    if (!/^[A-Z][A-Z0-9_]*(?::.*)?$/.test(args.error_code)) throw new Refusal("ERROR_CODE_INVALID:" + args.error_code);
    output = {
      schema: OUTPUT_SCHEMA, lane: args.lane, domain: args.domain, report_sha256: null, claims: [],
      limitations: ["review-" + args.domain + " produced no report: the runtime failed closed with " + args.error_code + "; observations are unscored and no score or grade exists"],
    };
  } else {
    const reportPath = path.resolve(args.report);
    const bytes = fs.readFileSync(reportPath);
    const reportSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    validateReportFile(reportPath);
    const report = JSON.parse(bytes.toString("utf8"));
    if (args.domain && args.domain !== report.domain) throw new Refusal("REVIEW_DOMAIN_MISMATCH:" + args.domain + "!=" + report.domain);
    if (args.revision !== undefined && args.revision.toLowerCase() !== report.repository_revision) {
      throw new Refusal("REVIEW_REVISION_MISMATCH:" + args.revision + "!=" + report.repository_revision);
    }
    if (dimensions) {
      const unknown = dimensions.filter((d) => !Object.prototype.hasOwnProperty.call(report.fitness.dimensions, d));
      if (unknown.length) throw new Refusal("REVIEW_DIMENSION_UNKNOWN:" + unknown.join(","));
    }
    let evidence = null;
    if (args.evidence) {
      const evidencePath = path.resolve(args.evidence);
      if (evidenceSha256(evidencePath) !== report.evidence_sha256) throw new Refusal("REVIEW_EVIDENCE_HASH_MISMATCH");
      evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    }
    const built = buildClaims({ report, reportSha256, lane: args.lane, prefix: args.claim_prefix, evidence, dimensions });
    output = { schema: OUTPUT_SCHEMA, lane: args.lane, domain: report.domain, report_sha256: reportSha256, claims: built.claims, limitations: built.limitations };
  }
  fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2) + "\n");
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error instanceof Refusal ? error.message : (error && error.stack) || error) + "\n");
    process.exitCode = error instanceof Refusal ? 2 : 1;
  }
}

module.exports = { buildClaims, resultFor, proofBasisFor, main, OUTPUT_SCHEMA };
