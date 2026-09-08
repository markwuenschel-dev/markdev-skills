"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const child = require("node:child_process");
const { placeholderHash } = require("./report-model.js");
const { unavailablePerformanceReceipt } = require("./performance-receipt.js");

const root = path.resolve(__dirname, "..");
const skills = path.resolve(root, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ria-v3-"));
const healthPath = path.join(skills, "repository-health-assessment", "assets", "canonical-island.json");
const integrityPath = path.join(skills, "shared", "candidate-ledger-spine", "canonical-ledger.json");
const architectureSource = path.join(skills, "architecture-improvement-intelligence", "assets", "architecture-candidate-set.example.json");
const architecturePath = path.join(temp, "architecture.json");
const architectureFixture = JSON.parse(fs.readFileSync(architectureSource, "utf8"));
architectureFixture.repository_revision = "abc1234";
fs.writeFileSync(architecturePath, JSON.stringify(architectureFixture, null, 2) + "\n");
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const revision = "abc1234";
const request = {
  repository: { name: "fixture-repo", revision }, mode: "read-only",
  baseline_ref: { artifact_id: "baseline:fixture-real-hash", sha256: digest(healthPath), repository_revision: revision },
  assessment_refs: [
    { owner:"repository-health-assessment", artifact_id:`health-assessment:${digest(healthPath)}`, sha256:digest(healthPath), repository_revision:revision },
    { owner:"codebase-integrity-audit-loop", artifact_id:`integrity-ledger:${digest(integrityPath)}`, sha256:digest(integrityPath), repository_revision:revision },
    { owner:"architecture-improvement-intelligence", artifact_id:`architecture-assessment:${digest(architecturePath)}`, sha256:digest(architecturePath), repository_revision:revision },
  ],
  report_election: { schema_version:1, policy:"generate", lean:"generate", reason:"fixture report test", state:"elected-generate", report_owner:null },
  coverage_metrics: { line:{covered:874,total:1000}, branch:{covered:748,total:1000}, changed_line:{covered:94,total:100} },
  sei_telemetry_summary: { schema_version:"sei.telemetry-summary@1", gate_observation_ratio:2/3, gate_observation_status:"RECORDED", criterion_counts:{assessed:2,applicable:3}, failure_code:null },
  performance_receipt: unavailablePerformanceReceipt("fixture-run", "NO_EXECUTOR_TELEMETRY")
};
const requestPath = path.join(temp, "request.json");
const dataPath = path.join(temp, "data.json");
const htmlPath = path.join(temp, "report.html");
fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
child.execFileSync(process.execPath, [path.join(root,"scripts","build-report-data.js"),"--request",requestPath,"--health",healthPath,"--integrity",integrityPath,"--architecture",architecturePath,"--output",dataPath,"--fixture"], {stdio:"pipe"});
const data = JSON.parse(fs.readFileSync(dataPath,"utf8"));
assert.equal(data.report_schema_version, 3);
assert.equal(data.analytics.health.score, 63.8);
assert.equal(data.analytics.integrity.candidate_count, 1);
assert.equal(data.analytics.architecture.candidates[0].priority, null);
assert.equal(data.analytics.architecture.fitness.score, 74.2);
assert.equal(data.analytics.architecture.fitness.grade, "C");
assert.equal(data.analytics.coverage.line.percent, 87.4);
assert.equal(data.analytics.coverage.branch.percent, 74.8);
assert.ok(data.analytics.composite.final_score >= 0 && data.analytics.composite.final_score <= 100);
assert.match(data.analytics.composite.final_grade, /^(A\+|A|A-|B\+|B|B-|C\+|C|C-|D\+|D|D-|F)$/);
assert.equal(data.provenance.architecture_scores_fabricated, false);
assert.equal(data.analytics.performance.telemetry_status, "unavailable");
child.execFileSync(process.execPath, [path.join(root,"scripts","build-report.js"),"--input",dataPath,"--output",htmlPath], {stdio:"pipe"});
const html = fs.readFileSync(htmlPath,"utf8");
assert.match(html, /data-report-responsive="1"/);
assert.match(html, /data-rp-chart=/);
assert.match(html, /Ranked candidate portfolio/);
assert.match(html, /Overall RIA score/);
assert.match(html, /Architecture Fitness/);
assert.match(html, /Test Suite Fitness/);
assert.match(html, /Line coverage/);
assert.match(html, /Branch coverage/);
assert.match(html, /Expand all/);
assert.match(html, /All \d+ priorities|Highest-leverage priorities/);
assert.match(html, /Not scored/);
assert.match(html, /Work avoided through reuse/);
assert.match(html, /NO_EXECUTOR_TELEMETRY/);
assert.match(html, /SEI assessed 2 \/ 3 applicable criteria/);
assert.match(html, /Worth exploring/);
assert.doesNotMatch(html, />LOW</);
assert.match(html, /candidate-owner">Health</);
assert.match(html, /Showing \d+ of \d+ candidates/);
assert.match(html, /Trend:/);
assert.equal(data.analytics.integrity.candidates[0].band, "Worth exploring");
assert.equal(data.synthesis.top_priorities.some((item) => item.priority_band === "Worth exploring"), true);
assert.equal(data.synthesis.top_priorities.some((item) => item.priority_band === "LOW"), false);
assert.ok(data.analytics.routing_counts.some((row) => row.label === "ready" && row.value >= 1));
assert.ok((data.analytics.health.candidates || []).length >= 1);
assert.equal(data.analytics.candidate_portfolio.health, (data.analytics.health.candidates || []).length);
assert.doesNotMatch(html, /observed 2 \/ 3 gates/);
assert.doesNotMatch(html, /main\s*\{[^}]*max-width\s*:\s*980px/s);
assert.equal(placeholderHash("1".repeat(64)), true);
const bad = structuredClone(request);
bad.repository.name = "real-repo";
bad.baseline_ref.artifact_id = "baseline:real";
bad.assessment_refs[0].sha256 = "1".repeat(64);
const badPath = path.join(temp,"bad.json"); fs.writeFileSync(badPath,JSON.stringify(bad));
const rejected = child.spawnSync(process.execPath,[path.join(root,"scripts","build-report-data.js"),"--request",badPath,"--health",healthPath,"--integrity",integrityPath,"--architecture",architecturePath,"--output",path.join(temp,"bad-out.json")],{encoding:"utf8"});
assert.notEqual(rejected.status,0);
assert.match(rejected.stderr,/PLACEHOLDER_HASH/);
const badElection = structuredClone(request); delete badElection.report_election.schema_version;
const badElectionPath = path.join(temp,"bad-election.json"); fs.writeFileSync(badElectionPath,JSON.stringify(badElection));
const electionRejected = child.spawnSync(process.execPath,[path.join(root,"scripts","build-report-data.js"),"--request",badElectionPath,"--health",healthPath,"--integrity",integrityPath,"--architecture",architecturePath,"--output",path.join(temp,"bad-election-out.json"),"--fixture"],{encoding:"utf8"});
assert.notEqual(electionRejected.status,0); assert.match(electionRejected.stderr,/REPORT_ELECTION_INVALID/);
const badPerformance = structuredClone(request); badPerformance.performance_receipt.receipt_sha256 = "0".repeat(64);
const badPerformancePath = path.join(temp,"bad-performance.json"); fs.writeFileSync(badPerformancePath,JSON.stringify(badPerformance));
const performanceRejected = child.spawnSync(process.execPath,[path.join(root,"scripts","build-report-data.js"),"--request",badPerformancePath,"--health",healthPath,"--integrity",integrityPath,"--architecture",architecturePath,"--output",path.join(temp,"bad-performance-out.json"),"--fixture"],{encoding:"utf8"});
assert.notEqual(performanceRejected.status,0); assert.match(performanceRejected.stderr,/PERFORMANCE_RECEIPT_INVALID/);
fs.rmSync(temp,{recursive:true,force:true});
console.log("RIA_REPORT_V3_TEST_OK");
