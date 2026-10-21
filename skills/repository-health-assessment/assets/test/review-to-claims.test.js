#!/usr/bin/env node
"use strict";
// Plain-node tests for review-to-claims.js. Exit code is non-zero on any failure.
// Fixtures come from the review-fitness runtime's own goldens and evidence.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ASSETS = path.resolve(__dirname, "..");
const SKILLS_ROOT = path.resolve(ASSETS, "..", "..");
const RUNTIME = path.join(SKILLS_ROOT, "shared", "review-fitness-runtime");
const TOOL = path.join(ASSETS, "review-to-claims.js");
const { resultFor, buildClaims, proofBasisFor } = require(TOOL);
const PYTHON = process.env.REVIEW_FITNESS_PYTHON || (process.platform === "win32" ? "python" : "python3");
const golden = (scenario) => path.join(RUNTIME, "tests", "golden", "security-" + scenario + ".report.json");
const fixture = (scenario) => path.join(RUNTIME, "tests", "fixtures", "security-" + scenario + ".evidence.json");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "review-to-claims-"));
const healthSchema = JSON.parse(fs.readFileSync(path.join(ASSETS, "health.schema.json"), "utf8"));
const claimSchema = healthSchema.properties.claims.items;

let failures = 0;
let passed = 0;
let skipped = 0;
function test(name, fn) {
  try { fn(); passed += 1; process.stdout.write("ok - " + name + "\n"); }
  catch (error) { failures += 1; process.stdout.write("not ok - " + name + "\n  " + String(error && error.stack || error).split("\n").join("\n  ") + "\n"); }
}

let outCounter = 0;
function run(args) {
  outCounter += 1;
  const out = path.join(work, "claims-" + outCounter + ".json");
  const result = spawnSync(process.execPath, [TOOL, ...args, "--out", out], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, output: result.status === 0 ? JSON.parse(fs.readFileSync(out, "utf8")) : null };
}
const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function assertClaimShape(claim) {
  for (const key of claimSchema.required) assert.ok(key in claim, "claim missing " + key);
  for (const key of Object.keys(claim)) assert.ok(key in claimSchema.properties, "claim key not in health schema: " + key);
  assert.ok(claimSchema.properties.result.enum.includes(claim.result));
  const rs = claimSchema.properties.review_source;
  assert.deepEqual(Object.keys(claim.review_source).sort(), [...rs.required].sort());
  assert.ok(rs.properties.domain.enum.includes(claim.review_source.domain));
  assert.match(claim.review_source.report_sha256, /^[0-9a-f]{64}$/);
  assert.ok(rs.properties.proof_basis.enum.includes(claim.review_source.proof_basis), "proof_basis " + claim.review_source.proof_basis);
  // R1: judged text lives in observation.inferred, mechanical text in confirmed.
  if (claim.review_source.proof_basis === "judgment") {
    assert.ok(!("confirmed" in claim.observation), "judgment claim carries observation.confirmed");
    assert.ok(typeof claim.observation.inferred === "string" && claim.observation.inferred.length > 0);
  } else {
    assert.ok(typeof claim.observation.confirmed === "string" && claim.observation.confirmed.length > 0);
  }
  assert.ok(claim.evidence.length >= 1 && claim.evidence.every((e) => typeof e.path === "string" && e.path));
}

/** Score a mutated copy of a runtime fixture with the runtime's own fixture scorer. */
function scoreMutated(scenario, mutation) {
  const code = [
    "import json, sys, tempfile",
    "from pathlib import Path",
    "runtime = Path(sys.argv[1])",
    "sys.path.insert(0, str(runtime / 'scripts')); sys.path.insert(0, str(runtime / 'test_support'))",
    "from review_fitness_runtime import canonical_bytes",
    "from review_fixture_runtime import score_fixture_review",
    "evidence = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))",
    "mode = sys.argv[4]",
    "for item in evidence['observations']:",
    "    if mode == 'all-na' or item['rule_id'] == 'security.input-validation.baseline':",
    "        item.update({'outcome': 'not-applicable', 'severity': 'info', 'proofs': [], 'rationale': 'No input surface in this target.'})",
    "with tempfile.TemporaryDirectory(dir=runtime / 'tests') as tmp:",
    "    path = Path(tmp) / 'evidence.json'",
    "    path.write_text(json.dumps(evidence), encoding='utf-8')",
    "    report = score_fixture_review('security', runtime / 'tests' / 'targets' / 'security.py', path)",
    "Path(sys.argv[3]).write_bytes(canonical_bytes(report))",
  ].join("\n");
  const out = path.join(work, scenario + "-" + mutation + ".report.json");
  const result = spawnSync(PYTHON, ["-c", code, RUNTIME, fixture(scenario), out, mutation], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return out;
}

/* Expected claims are derived from the report and evidence content, so the
 * tests follow the runtime's registry (baselines + mechanical sub-rules)
 * instead of pinning one generation's rule count. Mirrors the translator's
 * contract: one claim per covered rule that has a finding or an evidence
 * observation with a scoring outcome, in covered_rules order, scoped by
 * --dimensions; judgment iff the rule is in coverage.judged_rules. */
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function expectedClaims(report, evidence, dimensions) {
  const findings = new Map(report.findings.map((f) => [f.rule_id, f]));
  const observed = new Map(((evidence && evidence.observations) || []).map((o) => [o.rule_id, o]));
  const judged = new Set(report.coverage.judged_rules || []);
  const out = [];
  for (const ruleId of report.coverage.covered_rules) {
    const item = findings.get(ruleId) || observed.get(ruleId);
    if (!item) continue;
    if (dimensions && !dimensions.includes(item.dimension)) continue;
    const result = resultFor(item.outcome, item.severity);
    if (!result) continue;
    out.push({ rule_id: ruleId, dimension: item.dimension, result, proof_basis: judged.has(ruleId) ? "judgment" : "mechanical" });
  }
  return out;
}
function assertMatchesExpected(claims, expected) {
  assert.deepEqual(claims.map((c) => ({ rule_id: c.review_source.rule_id, dimension: c.review_source.dimension, result: c.result, proof_basis: c.review_source.proof_basis })), expected);
}
const naLimitations = (report) => (report.not_applicable || []).length;

test("positive report + evidence -> one pass claim per scored rule, provenance carried", () => {
  const report = readJson(golden("positive"));
  const expected = expectedClaims(report, readJson(fixture("positive")));
  assert.ok(expected.length >= report.coverage.judged_rules.length, "fixture should cover at least every judged baseline");
  const r = run(["--report", golden("positive"), "--evidence", fixture("positive"), "--lane", "security-and-production-safety", "--claim-prefix", "SEC-REV"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.output.schema, "rha.review-claims@1");
  assert.equal(r.output.domain, "security");
  assert.equal(r.output.report_sha256, sha256File(golden("positive")));
  assertMatchesExpected(r.output.claims, expected);
  assert.deepEqual(r.output.claims.map((c) => c.claim_id), expected.map((_, n) => "SEC-REV-" + String(n + 1).padStart(2, "0")));
  // The only limitations are the report's not-applicable rules, each with its rationale.
  assert.equal(r.output.limitations.length, naLimitations(report));
  assert.ok(r.output.limitations.every((l) => /recorded not-applicable: /.test(l)));
  for (const claim of r.output.claims) {
    assertClaimShape(claim);
    assert.equal(claim.result, "pass");
    assert.equal(claim.lane, "security-and-production-safety");
    assert.equal(claim.review_source.report_sha256, r.output.report_sha256);
    assert.ok(claim.evidence.some((e) => /review-proof-bundle\/v1/.test(e.note || "")));
  }
});

test("negative report -> fail claims for findings with severity mapping, pass for the rest", () => {
  const report = readJson(golden("negative"));
  const expected = expectedClaims(report, readJson(fixture("negative")));
  const r = run(["--report", golden("negative"), "--evidence", fixture("negative"), "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 0, r.stderr);
  assertMatchesExpected(r.output.claims, expected);
  const byRule = Object.fromEntries(r.output.claims.map((c) => [c.review_source.rule_id, c]));
  for (const finding of report.findings) {
    const claim = byRule[finding.rule_id];
    assert.equal(claim.result, resultFor(finding.outcome, finding.severity), finding.rule_id);
    assert.match(claim.statement, new RegExp("failed \\(" + finding.severity + "\\)"));
  }
  assert.ok(r.output.claims.some((c) => c.result === "pass"), "the negative fixture still has passing rules");
  r.output.claims.forEach(assertClaimShape);
});

test("without --evidence, fail claims still emit and unemitted passes become limitations", () => {
  const report = readJson(golden("negative"));
  const expected = expectedClaims(report, null);
  const r = run(["--report", golden("negative"), "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 0, r.stderr);
  assertMatchesExpected(r.output.claims, expected);
  assert.equal(r.output.claims.length, report.findings.length);
  const unemitted = report.coverage.covered_rules.length - report.findings.length;
  assert.ok(unemitted > 0);
  assert.equal(r.output.limitations.filter((l) => /passed but no claim was emitted/.test(l)).length, unemitted);
  assert.equal(r.output.limitations.length, unemitted + naLimitations(report));
});

test("--dimensions filters claims by review_source.dimension and rejects unknown dimensions", () => {
  const dims = ["input-validation", "cryptography"];
  const expected = expectedClaims(readJson(golden("negative")), readJson(fixture("negative")), dims);
  const r = run(["--report", golden("negative"), "--evidence", fixture("negative"), "--lane", "security-and-production-safety", "--claim-prefix", "SEC", "--dimensions", dims.join(",")]);
  assert.equal(r.status, 0, r.stderr);
  assertMatchesExpected(r.output.claims, expected);
  assert.deepEqual([...new Set(r.output.claims.map((c) => c.review_source.dimension))].sort(), [...dims].sort());
  assert.ok(r.output.limitations.every((l) => dims.some((d) => l.includes(d + ".")) ), "limitations stay scoped to the requested dimensions");
  const bad = run(["--report", golden("negative"), "--lane", "security-and-production-safety", "--claim-prefix", "SEC", "--dimensions", "nope"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /REVIEW_DIMENSION_UNKNOWN:nope/);
});

test("result mapping: pass->pass, fail critical/high/medium->fail, fail low/info->partial, not-applicable->none", () => {
  assert.equal(resultFor("pass", "medium"), "pass");
  for (const s of ["critical", "high", "medium"]) assert.equal(resultFor("fail", s), "fail");
  for (const s of ["low", "info"]) assert.equal(resultFor("fail", s), "partial");
  assert.equal(resultFor("not-applicable", "info"), null);
});

test("insufficient-evidence report -> zero claims plus a limitation", () => {
  const r = run(["--report", golden("insufficient"), "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.output.claims, []);
  assert.match(r.output.limitations[0], /insufficient-evidence/);
});

test("partially not-applicable report -> no claim for the N/A rule, rationale in limitations", () => {
  const report = scoreMutated("positive", "one-na");
  const r = run(["--report", report, "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.output.claims.some((c) => c.review_source.rule_id === "security.input-validation.baseline"));
  assert.ok(r.output.limitations.some((l) => /not-applicable: No input surface/.test(l)));
});

test("all-not-applicable report -> zero claims plus a limitation", () => {
  const report = scoreMutated("positive", "all-na");
  const r = run(["--report", report, "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.output.claims, []);
  assert.match(r.output.limitations[0], /fitness status not-applicable/);
});

test("fail-closed runtime error -> zero claims, null report hash, limitation names the code", () => {
  const r = run(["--error-code", "EVIDENCE_PROOF_ANALYZER_UNAVAILABLE", "--domain", "security", "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.output.report_sha256, null);
  assert.deepEqual(r.output.claims, []);
  assert.match(r.output.limitations[0], /EVIDENCE_PROOF_ANALYZER_UNAVAILABLE/);
});

test("refuses a revision mismatch", () => {
  const r = run(["--report", golden("positive"), "--revision", "e".repeat(40), "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REVIEW_REVISION_MISMATCH/);
  const ok = run(["--report", golden("positive"), "--revision", "f".repeat(40), "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(ok.status, 0, ok.stderr);
});

test("refuses a schema-invalid report via the runtime validator", () => {
  const report = JSON.parse(fs.readFileSync(golden("positive"), "utf8"));
  report.coverage.ratio = 2;
  const file = path.join(work, "invalid.report.json");
  fs.writeFileSync(file, JSON.stringify(report));
  const r = run(["--report", file, "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REVIEW_REPORT_INVALID:REPORT_COVERAGE_INVALID/);
});

test("refuses evidence that is not the report's evidence", () => {
  const r = run(["--report", golden("positive"), "--evidence", fixture("negative"), "--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REVIEW_EVIDENCE_HASH_MISMATCH/);
});

test("refuses an unknown health lane and missing arguments", () => {
  const r = run(["--report", golden("positive"), "--lane", "not-a-lane", "--claim-prefix", "SEC"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HEALTH_LANE_UNKNOWN/);
  const usage = run(["--lane", "security-and-production-safety", "--claim-prefix", "SEC"]);
  assert.equal(usage.status, 1);
});

/* ---- v5.6 proof_basis (I4/I5) ---- */
const H = "a".repeat(64);
const LANE = "security-and-production-safety";
/** A review-fitness-report/v1 shape built in memory from the v1.1 golden: no
 * judged_rules, no judged_proof_count, and no model-judgment proofs (v1 had
 * none). It goes through buildClaims, not the CLI: the runtime validator now
 * checks reports against the current registry. */
function toV1(report, evidence) {
  const out = JSON.parse(JSON.stringify(report));
  out.schema_version = "review-fitness-report/v1";
  delete out.coverage.judged_rules;
  delete out.confidence.judged_proof_count;
  const ev = evidence ? JSON.parse(JSON.stringify(evidence)) : null;
  for (const item of [...out.findings, ...((ev && ev.observations) || [])]) {
    for (const proof of item.proofs || []) if (proof.type === "model-judgment") proof.type = "ast-fact";
  }
  return { report: out, evidence: ev };
}

test("v1 report (no judged_rules) -> every claim mechanical with observation.confirmed", () => {
  const v1 = toV1(readJson(golden("negative")), readJson(fixture("negative")));
  const built = buildClaims({ report: v1.report, reportSha256: H, lane: LANE, prefix: "SEC", evidence: v1.evidence });
  assert.equal(built.claims.length, expectedClaims(v1.report, v1.evidence).length);
  assert.ok(built.claims.length > 0);
  for (const claim of built.claims) {
    assertClaimShape(claim);
    assert.equal(claim.review_source.proof_basis, "mechanical");
    assert.match(claim.observation.confirmed, /runtime-validated review-fitness-report\/v1\]/);
  }
});

test("v1.1 report: judged rules -> judgment/inferred, mechanical sub-rules -> mechanical/confirmed", () => {
  const report = readJson(golden("negative"));
  const evidence = readJson(fixture("negative"));
  const judged = new Set(report.coverage.judged_rules);
  const built = buildClaims({ report, reportSha256: H, lane: LANE, prefix: "SEC", evidence });
  assertMatchesExpected(built.claims, expectedClaims(report, evidence));
  const judgedClaims = built.claims.filter((c) => judged.has(c.review_source.rule_id));
  const mechanicalClaims = built.claims.filter((c) => !judged.has(c.review_source.rule_id));
  assert.ok(judgedClaims.length > 0 && mechanicalClaims.length > 0, "the golden must exercise both kinds");
  for (const claim of judgedClaims) {
    assertClaimShape(claim);
    assert.equal(claim.review_source.proof_basis, "judgment");
    assert.deepEqual(Object.keys(claim.observation), ["inferred"]);
    assert.match(claim.observation.inferred, /model judgment: the runtime checked its signature and binding only, review-fitness-report\/v1\.1\]/);
    assert.match(claim.statement, /\(model judgment\)/);
  }
  for (const claim of mechanicalClaims) {
    assertClaimShape(claim);
    assert.equal(claim.review_source.proof_basis, "mechanical");
    assert.match(claim.observation.confirmed, /runtime-validated review-fitness-report\/v1\.1\]/);
  }
  assert.ok(built.claims.some((c) => c.review_source.proof_basis === "judgment" && c.result === "fail"));
  assert.ok(built.claims.some((c) => c.review_source.proof_basis === "mechanical" && c.result === "fail"));
});

test("judged_rules alone marks a rule as judgment (no proof-type hint needed)", () => {
  const report = readJson(golden("negative"));
  const evidence = readJson(fixture("negative"));
  const passRule = evidence.observations.find((o) => o.outcome === "pass" && !report.coverage.judged_rules.includes(o.rule_id)).rule_id;
  report.coverage.judged_rules = [passRule];
  for (const item of [...report.findings, ...evidence.observations]) for (const proof of item.proofs || []) proof.type = "ast-fact";
  const built = buildClaims({ report, reportSha256: H, lane: LANE, prefix: "SEC", evidence });
  assert.deepEqual(built.claims.filter((c) => c.review_source.proof_basis === "judgment").map((c) => c.review_source.rule_id), [passRule]);
  const claim = built.claims.find((c) => c.review_source.rule_id === passRule);
  assert.equal(claim.result, "pass");
  assert.ok(!("confirmed" in claim.observation));
});

test("a model-judgment proof type marks the claim judgment even without judged_rules", () => {
  const v1 = toV1(readJson(golden("negative")), null);
  const target = v1.report.findings[0];
  target.proofs[0].type = "model-judgment";
  const built = buildClaims({ report: v1.report, reportSha256: H, lane: LANE, prefix: "SEC" });
  assert.deepEqual(built.claims.filter((c) => c.review_source.proof_basis === "judgment").map((c) => c.review_source.rule_id), [target.rule_id]);
  assert.equal(proofBasisFor("x.y.baseline", new Set(), { proofs: [{ type: "ast-fact" }] }), "mechanical");
  assert.equal(proofBasisFor("x.y.baseline", new Set(["x.y.baseline"])), "judgment");
});

test("translated claims verify inside a health island; a judged claim moved to confirmed is rejected (R1)", () => {
  const vm = require("node:vm");
  const ctx = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(SKILLS_ROOT, "shared", "candidate-ledger-spine", "ledger-verify.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(ASSETS, "health-verify.js"), "utf8"), ctx);
  const HV = vm.runInContext("globalThis.HealthVerify", ctx);
  const island = readJson(path.join(ASSETS, "canonical-island.json"));
  const built = buildClaims({ report: readJson(golden("negative")), reportSha256: H, lane: "verification-readiness", prefix: "RTC", evidence: readJson(fixture("negative")) });
  island.claims.push(...built.claims);
  const ok = HV.verifyHealth(island);
  assert.ok(ok.ok, JSON.stringify(ok.problems.slice(0, 3)));
  const bad = JSON.parse(JSON.stringify(island));
  const judged = bad.claims.find((c) => c.claim_id.startsWith("RTC") && c.review_source.proof_basis === "judgment");
  judged.observation.confirmed = judged.observation.inferred;
  assert.ok(HV.verifyHealth(bad).problems.some((p) => p.code === "claim-judgment-confirmed"));
});

test("CLI end to end on the regenerated v1.1 golden: proof_basis follows coverage.judged_rules", () => {
  const report = readJson(golden("negative"));
  assert.equal(report.schema_version, "review-fitness-report/v1.1");
  const r = run(["--report", golden("negative"), "--evidence", fixture("negative"), "--lane", LANE, "--claim-prefix", "SEC", "--revision", report.repository_revision]);
  assert.equal(r.status, 0, r.stderr);
  assertMatchesExpected(r.output.claims, expectedClaims(report, readJson(fixture("negative"))));
  const judged = new Set(report.coverage.judged_rules);
  for (const claim of r.output.claims) {
    assertClaimShape(claim);
    assert.equal(claim.review_source.proof_basis, judged.has(claim.review_source.rule_id) ? "judgment" : "mechanical");
  }
  assert.ok(r.output.claims.some((c) => c.review_source.proof_basis === "judgment"));
  assert.ok(r.output.claims.some((c) => c.review_source.proof_basis === "mechanical"));
});

fs.rmSync(work, { recursive: true, force: true });
process.stdout.write("\n" + passed + " passed, " + failures + " failed" + (skipped ? ", " + skipped + " skipped" : "") + "\n");
process.exitCode = failures ? 1 : 0;
