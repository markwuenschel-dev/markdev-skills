"use strict";
/* integrity.coverage@2 verifier and the RIA-mode writer (composite-scoring-v3
 * §7.1, §6.4; instructions Phase 5). Expected coverage values are worked by hand
 * from Health's defaults: credits inspected 1.0 / sampled 0.6, factors strong 1.0
 * / moderate 0.9. */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { verifyIntegrityCoverage } = require("./integrity-coverage.js");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "canonical-ria-ledger.json"), "utf8"));
const REVISION = "abc1234";
const clone = () => JSON.parse(JSON.stringify(FIXTURE));
const verify = (ledger, options = {}) => verifyIntegrityCoverage(ledger, { revision: REVISION, ...options });
function rejects(mutate, pattern) {
  const ledger = clone(); mutate(ledger);
  const result = verify(ledger);
  assert.equal(result.ok, false, `expected rejection matching ${pattern}`);
  assert.match(result.problems.join("\n"), pattern);
}

test("the canonical RIA ledger verifies and yields hand-calculated coverage", () => {
  const result = verify(clone());
  assert.equal(result.ok, true, result.problems.join("\n"));
  // correctness: (5x1x1 + 4x0.6x0.9 + 4x0x0) / 13 = 7.16 / 13
  assert.ok(Math.abs(result.dimensions.correctness.coverage - 7.16 / 13) < 1e-12);
  // contracts: generated-surfaces not-applicable leaves the denominator: 5/5
  assert.equal(result.dimensions.contracts.coverage, 1);
  // security: (5x1x1 + 5x1x0.9) / 10 = 0.95, and its negative claim supports absence
  assert.ok(Math.abs(result.dimensions.security.coverage - 0.95) < 1e-12);
  assert.equal(result.dimensions.security.absence_supported, true);
  // reliability: (5x0.6x0.9 + 3x0) / 8 = 0.3375
  assert.ok(Math.abs(result.dimensions.reliability.coverage - 0.3375) < 1e-12);
  assert.equal(result.dimensions.reliability.absence_supported, false);
  assert.match(JSON.stringify(result.import_digests), /HEALTH_COVERAGE_CREDIT/);
});

test("a declared coverage number is rejected", () => {
  rejects(l => { l.coverage.dimensions.correctness.coverage = 0.99; }, /declared coverage numbers are rejected/);
  rejects(l => { l.coverage.dimensions.correctness.surfaces[0].coverage = 1; }, /declared coverage numbers are rejected/);
  rejects(l => { l.coverage.weighted_coverage = 90; }, /declared coverage numbers are rejected/);
});

test("completeness: a missing mapped surface or dimension fails", () => {
  rejects(l => { l.coverage.dimensions.correctness.surfaces.pop(); }, /mapped surface data-lifecycle is missing/);
  rejects(l => { delete l.coverage.dimensions.reliability; }, /reliability: dimension receipt is required/);
  rejects(l => { l.coverage.dimensions.correctness.surfaces.push(l.coverage.dimensions.correctness.surfaces[0]); }, /duplicate surface runtime-code/);
});

test("a core surface may never be not-applicable", () => {
  rejects(l => { Object.assign(l.coverage.dimensions.contracts.surfaces[0], { state: "not-applicable", evidence_quality: "none", evidence_refs: [], reason: "none here" }); }, /core surface contracts-and-wiring may never be not-applicable/);
});

test("inspected with weak evidence fails, and evidenced states need refs", () => {
  rejects(l => { l.coverage.dimensions.correctness.surfaces[0].evidence_quality = "weak"; }, /inspected coverage requires strong or moderate/);
  rejects(l => { l.coverage.dimensions.correctness.surfaces[1].evidence_refs = []; }, /sampled requires non-empty evidence_refs/);
});

test("unresolved and cross-revision refs fail; off-default weights need a rationale", () => {
  rejects(l => { l.coverage.dimensions.correctness.surfaces[0].evidence_refs.push({ kind: "candidate", ref: "integrity:NOPE" }); }, /does not resolve to a ledger row/);
  rejects(l => { l.coverage.dimensions.correctness.surfaces[0].evidence_refs.push({ kind: "path", ref: "src/money.js", revision: "zzz" }); }, /bound to revision zzz/);
  rejects(l => { l.coverage.dimensions.correctness.surfaces[0].evidence_refs.push({ kind: "path", ref: "../escape.js" }); }, /escapes the assessed root/);
  rejects(l => { l.coverage.dimensions.correctness.surfaces[0].criticality_weight = 3; }, /needs weight_rationale/);
});

test("§12 test 12: inspecting runtime-code for correctness gives security zero coverage", () => {
  const ledger = clone();
  ledger.coverage.dimensions.security = {
    surfaces: [
      { surface_id: "runtime-code", criticality_weight: 5, state: "uninspected", evidence_quality: "none", methods: [], scope: "", evidence_refs: [], reason: null, weight_rationale: null },
      { surface_id: "contracts-and-wiring", criticality_weight: 5, state: "uninspected", evidence_quality: "none", methods: [], scope: "", evidence_refs: [], reason: null, weight_rationale: null },
      { surface_id: "specialized-paths", criticality_weight: 3, state: "uninspected", evidence_quality: "none", methods: [], scope: "", evidence_refs: [], reason: null, weight_rationale: null },
    ],
    negative_claims: [],
  };
  const result = verify(ledger);
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.equal(result.dimensions.correctness.surfaces, undefined);
  assert.equal(result.dimensions.security.coverage, 0, "correctness inspection does not count for security");
  // A surface recorded under a dimension it is not mapped to is rejected rather than silently credited.
  rejects(l => { l.coverage.dimensions.reliability.surfaces.push({ ...l.coverage.dimensions.security.surfaces[1] }); }, /contracts-and-wiring is not mapped to reliability/);
});

test("§7.1 rule 5: a negative claim must cover every mapped surface, check and exclusion", () => {
  const claim = () => clone().coverage.dimensions.security.negative_claims[0];
  const run = mutate => { const l = clone(); const c = claim(); mutate(c); l.coverage.dimensions.security.negative_claims = [c]; return verify(l); };
  const narrow = run(c => { c.search_scope = ["surface:runtime-code"]; });
  assert.equal(narrow.ok, true);
  assert.equal(narrow.dimensions.security.absence_supported, false, "one surface cannot establish repository-wide absence");
  assert.equal(run(c => { c.search_methods = ["defect-check:security-exposure"]; }).dimensions.security.absence_supported, false, "missing configured missing-validation check");
  assert.equal(run(c => { c.exclusions = ["surface:contracts-and-wiring"]; }).dimensions.security.absence_supported, false, "exclusions cannot remove graded scope");
  assert.equal(run(c => { c.supports_absence = false; }).dimensions.security.absence_supported, false);
  const invalid = run(c => { c.search_completeness = "representative"; });
  assert.equal(invalid.ok, false, "Evidence Recon rejects supports_absence without exhaustive search");
  assert.match(invalid.problems.join("\n"), /negative-claim-search-not-exhaustive/);
});

test("RIA mode: Integrity-minted rows need dimensions, class and bound proof", () => {
  rejects(l => { delete l.candidates[1].ria_dimensions; }, /require ria_dimensions/);
  rejects(l => { delete l.candidates[1].defect_class; }, /require defect_class/);
  rejects(l => { delete l.candidates[1].ria_proof; }, /require ria_proof/);
  const adoptedUntagged = clone(); adoptedUntagged.candidates[0].lane_sources = [];
  const result = verify(adoptedUntagged);
  assert.equal(result.ok, true, "adopted upstream rows keep their ID and are not dropped");
  assert.match(result.limitations.join("\n"), /CONTRACT-007: adopted row has no lane_sources/);
  assert.match(verify(clone(), { revision: "other" }).limitations.join("\n"), /ria_proof is bound to revision abc1234, not other/);
});

test("write-ledger requires a valid coverage receipt under --ria-envelope only", (context) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-coverage-writer-"));
  context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, "repo"); fs.mkdirSync(repo);
  childProcess.execFileSync("git", ["-C", repo, "init", "-q"]);
  const envelope = { baseline_ref: { artifact_id: "baseline:fixture", sha256: "a".repeat(64), repository_revision: REVISION }, engineering_intelligence_ref: { artifact_id: `engineering-intelligence:${"b".repeat(64)}`, owner: "repository-improvement-assessment", kind: "engineering-intelligence", schema_version: "1.0.0", sha256: "b".repeat(64), repository_revision: REVISION, mission_id: "fixture", scope_hash: "c".repeat(64), baseline_binding: { artifact_id: "baseline:fixture", sha256: "a".repeat(64), repository_revision: REVISION } }, presentation_policy: "inherit" };
  const envelopePath = path.join(scratch, "envelope.json"); fs.writeFileSync(envelopePath, JSON.stringify(envelope));
  const write = (ledger, withEnvelope) => {
    const input = path.join(scratch, `in-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(input, JSON.stringify(ledger));
    return childProcess.spawnSync(process.execPath, [path.join(__dirname, "write-ledger.js"), "--input", input, "--repo", repo, ...(withEnvelope ? ["--ria-envelope", envelopePath] : [])], { encoding: "utf8", env: { ...process.env, RIA_RUNTIME_ROOT: scratch } });
  };
  const good = write(clone(), true);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).schema_version, "ria.owner-return@1");
  const noCoverage = clone(); delete noCoverage.coverage;
  const rejected = write(noCoverage, true);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /FAIL-INTEGRITY-COVERAGE-INVALID[\s\S]*coverage \(integrity\.coverage@2\) is required/);
  const declared = clone(); declared.coverage.dimensions.correctness.coverage = 1;
  assert.match(write(declared, true).stderr, /declared coverage numbers are rejected/);
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "shared", "candidate-ledger-spine", "canonical-ledger.json"), "utf8"));
  assert.equal(write(legacy, false).status, 0, "outside RIA mode the receipt stays optional");
});
