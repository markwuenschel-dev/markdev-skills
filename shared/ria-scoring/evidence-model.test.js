"use strict";
/* composite-scoring-v3 §12 tests 10, 13–15 and 26 at unit level, plus the
 * Phase 3 edge cases: same binding/path/range, shuffled input order,
 * whole-file overlap, refutation of a different predicate, stale receipts.
 * Every expected value is a literal worked by hand. */
const assert = require("node:assert/strict");
const test = require("node:test");
const E = require("./evidence-model.js");

const FACTORS = { strong: 1.0, moderate: 0.9, weak: 0.7 }; // test-local, matches HEALTH_EVIDENCE_FACTOR literally
const BINDING = { repository_id: "repo-1", root_id: "root-1", revision: "a".repeat(40) };
const OTHER_REVISION = { ...BINDING, revision: "b".repeat(40) };
const OTHER_ROOT = { ...BINDING, root_id: "root-2" };
const SEI_SHA = "c".repeat(64);
const VB_SHA = "d".repeat(64);
const RECEIPT = "e".repeat(64);
const RECEIPT2 = "f".repeat(64);
const ctx = { binding: BINDING, casePolicy: "sensitive", seiAssessmentSha256: SEI_SHA, verificationBaselineSha256: VB_SHA, commandIdFor: ref => (ref === "node --test" ? "cmd-test" : null) };

function code(path, start, end, binding = BINDING) { return E.codeKey(binding, path, start === undefined ? null : [start, end ?? start]); }
function fact(key, quality, origin = "original", originRef = null) { return { ...key, quality, origin, origin_ref: originRef }; }

test("paths normalize separators and dot segments and reject escapes", () => {
  assert.equal(E.normalizeRelativePath("src\\api\\.\\x\\..\\schema.ts"), "src/api/schema.ts");
  assert.equal(E.normalizeRelativePath("./SRC/A.js", { casePolicy: "insensitive" }), "src/a.js");
  assert.throws(() => E.normalizeRelativePath("../outside.js"), /FAIL-EVIDENCE-PATH/);
  assert.throws(() => E.normalizeRelativePath("C:/abs/a.js"), /FAIL-EVIDENCE-PATH/);
  assert.throws(() => E.normalizeRelativePath("/abs/a.js"), /FAIL-EVIDENCE-PATH/);
});

test("line ranges parse and inverted ranges are rejected", () => {
  assert.deepEqual(E.parseLineRange("12-30"), [12, 30]);
  assert.deepEqual(E.parseLineRange("L5-L9"), [5, 9]);
  assert.deepEqual(E.parseLineRange(7), [7, 7]);
  assert.equal(E.parseLineRange(undefined), null);
  assert.throws(() => E.parseLineRange("30-12"), /FAIL-EVIDENCE-RANGE/);
  assert.throws(() => E.parseLineRange(0), /FAIL-EVIDENCE-RANGE/);
  assert.throws(() => E.parseLineRange("lots"), /FAIL-EVIDENCE-RANGE/);
});

test("every owner evidence shape classifies into a key kind or an explicit unbound entry", () => {
  const health = E.classifyEvidence({ path: "src/money.js", lines: "3-4" }, ctx);
  assert.equal(health.keys[0].key, `code:repo-1:root-1:${BINDING.revision}:src/money.js:[3,4]`);
  const spine = E.classifyEvidence({ file: "src/money.js", line: 3, observation: "floor" }, ctx);
  assert.equal(spine.keys[0].key, `code:repo-1:root-1:${BINDING.revision}:src/money.js:[3,3]`);
  const reconLine = E.classifyEvidence({ kind: "line", ref: "src/a.js:10-20" }, ctx);
  assert.deepEqual(reconLine.keys[0].range, [10, 20]);
  const reconPath = E.classifyEvidence({ kind: "path", ref: "src/a.js" }, ctx);
  assert.equal(reconPath.keys[0].whole_file, true);
  const sei = E.classifyEvidence({ kind: "sei-criterion", criterion_id: "dependency_cycles", metric_id: "graph.cycles" }, ctx);
  assert.equal(sei.keys[0].key, `sei-metric:${SEI_SHA}:dependency_cycles:graph.cycles`);
  const command = E.classifyEvidence({ kind: "command", ref: "node --test" }, ctx);
  assert.equal(command.keys[0].key, `command:${VB_SHA}:cmd-test`);
  assert.equal(E.classifyEvidence({ kind: "command", ref: "rg -n foo" }, ctx).unbound[0].reason, "command-not-in-verification-baseline");
  assert.equal(E.classifyEvidence({ kind: "inventory", ref: "docs/adr inventory at assessed revision" }, ctx).unbound[0].reason, "unbound-source-kind:inventory");
  assert.equal(E.classifyEvidence({ kind: "document", ref: "all architecture records" }, ctx).unbound[0].reason, "free-text-ref");
  assert.equal(E.classifyEvidence({ architecture_level: true, rationale: "layering" }, ctx).unbound[0].reason, "architecture-level-rationale");
  const analyzer = E.classifyEvidence({ kind: "analyzer", check_id: "madge.cycles", receipt_sha256: RECEIPT }, ctx);
  assert.equal(analyzer.keys[0].kind, "analyzer");
});

test("§6.1 match rule: same binding/path and ≥ 50% of the shorter range", () => {
  assert.equal(E.matchKeys(code("a.js", 10, 20), code("a.js", 10, 20)), "exact");
  // shorter range 15..20 (6 lines), overlap 15..20 = 6 → 100% → overlap
  assert.equal(E.matchKeys(code("a.js", 10, 20), code("a.js", 15, 20)), "overlap");
  // 10..13 vs 12..19: shorter 4 lines, overlap 12..13 = 2 lines → exactly 50% → overlap
  assert.equal(E.matchKeys(code("a.js", 10, 13), code("a.js", 12, 19)), "overlap");
  // 10..13 vs 13..19: shorter 4, overlap 1 → 25% → no match
  assert.equal(E.matchKeys(code("a.js", 10, 13), code("a.js", 13, 19)), null);
  assert.equal(E.matchKeys(code("a.js", 10, 20), code("a.js", 10, 20, OTHER_REVISION)), null, "different revision");
  assert.equal(E.matchKeys(code("a.js", 10, 20), code("a.js", 10, 20, OTHER_ROOT)), null, "mixed-root paths");
  assert.equal(E.matchKeys(code("a.js"), code("a.js", 10, 20)), "discovery", "whole file is discovery only");
  assert.equal(E.matchKeys(code("a.js", 1, 2), code("b.js", 1, 2)), null);
});

test("§12 test 26: duplicate citations and split keys cannot alter independence", () => {
  const adopted = fact(code("src/x.js", 1, 5), "strong", "adopted", "health:H-1");
  const single = E.contributionDependence({ owner: "integrity", dimension: "correctness", facts: [adopted, fact(code("src/y.js", 1, 3), "strong")], factors: FACTORS, threshold: 0.5 });
  // A = 1.0, O = 1.0 → ratio 0.5 → not < 0.5 → dependent
  assert.equal(single.adopted_strength_ratio, 0.5);
  assert.equal(single.classification, "dependent");
  const copied = E.contributionDependence({ owner: "integrity", dimension: "correctness", facts: [adopted, adopted, adopted, fact(code("src/y.js", 1, 3), "strong"), fact(code("src/y.js", 1, 3), "strong")], factors: FACTORS, threshold: 0.5 });
  assert.equal(copied.adopted_strength_ratio, 0.5, "identical keys are deduplicated before arithmetic");
  const weakPadding = E.contributionDependence({ owner: "integrity", dimension: "correctness", facts: [adopted, ...[1, 2, 3, 4, 5, 6].map(n => fact(code(`src/w${n}.js`, 1, 1), "weak"))], factors: FACTORS, threshold: 0.5 });
  // weak originals earn no independence credit: A = 1.0, O = 0 → ratio 1
  assert.equal(weakPadding.adopted_strength_ratio, 1);
  assert.equal(weakPadding.classification, "dependent");
});

test("§12 test 14: a mostly adopted Integrity contribution plus one minor original stays dependent", () => {
  const facts = [
    fact(code("src/a.js", 1, 9), "strong", "adopted", "health:H-1"),
    fact(code("src/b.js", 1, 9), "strong", "adopted", "health:H-2"),
    fact(code("src/c.js", 1, 9), "strong", "adopted", "health:H-3"),
    fact(code("src/d.js", 4, 4), "moderate"),
  ];
  const result = E.contributionDependence({ owner: "integrity", dimension: "correctness", facts, factors: FACTORS, threshold: 0.5 });
  // A = 3.0, O = 0.9 → 3 / 3.9 = 0.769…
  assert.ok(Math.abs(result.adopted_strength_ratio - 3 / 3.9) < 1e-12);
  assert.equal(result.classification, "dependent");
  assert.deepEqual(result.origin_owners, ["health"]);
});

test("§12 test 15: Health lane evidence that is ≥ 50% SEI citations is dependent", () => {
  const seiKey = (c, m) => E.seiMetricKey(SEI_SHA, c, m);
  const facts = [seiKey("dependency_cycles", "graph.cycles"), seiKey("layering", "graph.layers")]
    .map(key => ({ ...key, quality: "strong", ...E.classifyOrigin("health", key) }))
    .concat([fact(code("src/a.js", 1, 4), "strong")]);
  const result = E.contributionDependence({ owner: "health", dimension: "architecture", facts, factors: FACTORS, threshold: 0.5 });
  // A = 2.0 (SEI citations held by Health are adopted), O = 1.0 → 0.667
  assert.ok(Math.abs(result.adopted_strength_ratio - 2 / 3) < 1e-12);
  assert.equal(result.classification, "dependent");
  assert.deepEqual(result.origin_owners, ["sei"]);
});

test("dependence: independent, missing strong original, zero strength and shared commands", () => {
  const independent = E.contributionDependence({ owner: "health", dimension: "correctness", facts: [fact(code("a.js", 1, 1), "strong", "adopted", "integrity:I-1"), fact(code("b.js", 1, 1), "strong"), fact(code("c.js", 1, 1), "strong")], factors: FACTORS, threshold: 0.5 });
  assert.ok(Math.abs(independent.adopted_strength_ratio - 1 / 3) < 1e-12);
  assert.equal(independent.classification, "independent");
  const moderateOnly = E.contributionDependence({ owner: "health", dimension: "correctness", facts: [fact(code("b.js", 1, 1), "moderate")], factors: FACTORS, threshold: 0.5 });
  assert.equal(moderateOnly.classification, "insufficient_evidence", "no strong original and no scored origin");
  const empty = E.contributionDependence({ owner: "health", dimension: "correctness", facts: [], factors: FACTORS, threshold: 0.5 });
  assert.equal(empty.classification, "insufficient_evidence");
  assert.equal(empty.adopted_strength_ratio, null);
  const shared = E.contributionDependence({ owner: "architecture", dimension: "verification", facts: [{ ...E.commandKey(VB_SHA, "cmd-test"), quality: "strong", origin: "original" }], factors: FACTORS, threshold: 0.5 });
  assert.equal(shared.classification, "dependent", "a shared verification receipt is Health's, not another independent measurement");
  assert.deepEqual(shared.origin_owners, ["health"]);
});

test("dependence graph: scored origins resolve; orphans and cycles become missing evidence", () => {
  const resolved = E.resolveDependenceGraph([
    { owner: "health", eligible: true, classification: "independent", origin_owners: [] },
    { owner: "integrity", eligible: true, classification: "dependent", origin_owners: ["health"] },
  ]);
  assert.deepEqual(resolved.integrity, { state: "dependent", origin_refs: ["health"], limitations: [] });
  const orphan = E.resolveDependenceGraph([
    { owner: "health", eligible: false, classification: "independent", origin_owners: [] },
    { owner: "integrity", eligible: true, classification: "dependent", origin_owners: ["health"] },
  ]);
  assert.equal(orphan.integrity.state, "insufficient_evidence");
  const cycle = E.resolveDependenceGraph([
    { owner: "health", eligible: true, classification: "dependent", origin_owners: ["integrity"] },
    { owner: "integrity", eligible: true, classification: "dependent", origin_owners: ["health"] },
  ]);
  assert.equal(cycle.health.state, "insufficient_evidence");
  assert.equal(cycle.integrity.state, "insufficient_evidence");
  assert.match(cycle.health.limitations[0], /cycle/);
});

const PREDICATE = { predicate_id: "correctness:logic-error:toCents-floor", statement: "toCents(0.29) returns 28" };
function finding(overrides = {}) {
  return {
    finding_id: "integrity:I-1", owner: "integrity", origin: "original", adopted_from: null,
    dimensions: ["correctness"], defect_class: "logic-error", severity: 3,
    predicate: PREDICATE, binding: BINDING,
    evidence_keys: [code("src/money.js", 2, 2)],
    proofs: [{ kind: "reproduction", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: RECEIPT, expected: 29, actual: 28, exit_code: 1 }],
    dedup: { duplicate_group: null, merged_from: [] },
    ...overrides,
  };
}
const ANALYZER_RECEIPT = "9".repeat(64);
const RESOLVED_REFUTED = "7".repeat(64);
const RESOLVED_CONFIRMED = "8".repeat(64);
const proofReceipt = (kind, fields) => ({ schema_version: E.RECEIPT_SCHEMA, kind, binding: BINDING, predicate_id: PREDICATE.predicate_id, ...fields });
// The receipts the proofs below cite (§7.2: the verifier checks the receipt, not the digest).
const RECEIPTS = new Map([
  [RECEIPT, proofReceipt("reproduction", { expected: 29, actual: 28, exit_code: 1 })],
  [ANALYZER_RECEIPT, proofReceipt("analyzer", { check_id: "c", proposition: PREDICATE.predicate_id })],
  [RECEIPT2, proofReceipt("counter-evidence", {})],
  [RESOLVED_REFUTED, proofReceipt("resolution", { outcome: "refuted", explains: "repro used a stale build" })],
  [RESOLVED_CONFIRMED, proofReceipt("resolution", { outcome: "confirmed", explains: "counter-test exercised a different input" })],
]);
const readReceipt = (store) => (sha) => (store.has(sha) ? { status: "present", receipt: store.get(sha) } : { status: "missing" });
/** The assessed source the observation tests cite: path -> line count. */
const SOURCE_LINES = new Map([["src/money.js", 12], ["src/api/order-schema.js", 8], ["src/client/order-schema.js", 8]]);
const resolveSource = (relative) => (SOURCE_LINES.has(relative) ? { state: "present", lines: SOURCE_LINES.get(relative) } : { state: "absent" });
const stateCtx = { binding: BINDING, seiAssessmentSha256: SEI_SHA, seiHasMetric: (c, m) => c === "dependency_cycles" && m === "graph.cycles", readReceipt: readReceipt(RECEIPTS), resolveSource };

test("§7.2 evidentiary states are computed from proof, not declared", () => {
  assert.equal(E.evidentiaryState(finding(), stateCtx).state, "reproduced");
  const proof = finding().proofs[0];
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...proof, harness_error: "MODULE_NOT_FOUND" }] }), stateCtx).state, "inferred");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...proof, actual: 29 }] }), stateCtx).state, "inferred", "no expected/actual mismatch");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...proof, exit_code: 0 }] }), stateCtx).state, "inferred");
  const stale = E.evidentiaryState(finding({ proofs: [{ ...proof, binding: OTHER_REVISION }] }), stateCtx);
  assert.equal(stale.state, "inferred");
  assert.match(stale.limitations.join(" "), /stale/);
  assert.equal(E.evidentiaryState(finding({ proofs: [{ kind: "analyzer", predicate_id: PREDICATE.predicate_id, binding: BINDING, check_id: "c", receipt_sha256: ANALYZER_RECEIPT, proposition: PREDICATE.predicate_id }] }), stateCtx).state, "mechanical");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ kind: "analyzer", predicate_id: PREDICATE.predicate_id, binding: BINDING, check_id: "c", receipt_sha256: ANALYZER_RECEIPT, proposition: "something-else" }] }), stateCtx).state, "inferred", "a metric confirms only what it measures");
  const seiProof = { kind: "sei-metric", predicate_id: PREDICATE.predicate_id, assessment_sha256: SEI_SHA, criterion_id: "dependency_cycles", metric_id: "graph.cycles", proposition: PREDICATE.predicate_id };
  assert.equal(E.evidentiaryState(finding({ proofs: [seiProof] }), stateCtx).state, "mechanical");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...seiProof, metric_id: "graph.layers" }] }), stateCtx).state, "inferred", "metric absent from the bound assessment");
  const observation = { kind: "observation", predicate_id: PREDICATE.predicate_id, binding: BINDING, quality: "strong", evidence_key: code("src/money.js", 2, 2), confirmed: "Math.floor(0.29 * 100) is 28" };
  assert.equal(E.evidentiaryState(finding({ proofs: [observation] }), stateCtx).state, "observed");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...observation, quality: "moderate" }] }), stateCtx).state, "inferred");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...observation, confirmed: "" }] }), stateCtx).state, "inferred");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...observation, evidence_key: code("src/money.js") }] }), stateCtx).state, "inferred", "whole-file evidence is not direct");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...observation, evidence_key: code("src/never-existed.js", 3) }] }), stateCtx).state, "inferred", "a file absent from the assessed source is not evidence");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...observation, evidence_key: code("src/money.js", 99) }] }), stateCtx).state, "inferred", "a line beyond the file is not evidence");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ ...observation, evidence_key: { ...observation.evidence_key, key: code("src/elsewhere.js", 2).key } }] }), stateCtx).state, "inferred", "a key that disagrees with its own path is not evidence");
  assert.equal(E.evidentiaryState(finding({ proofs: [observation] }), { ...stateCtx, resolveSource: undefined }).state, "inferred", "no source snapshot, no observation");
  assert.equal(E.evidentiaryState(finding({ proofs: [{ kind: "judgment" }] }), stateCtx).state, "inferred");
  assert.equal(E.evidentiaryState(finding({ predicate: null }), stateCtx).state, "inferred");
});

test("§7.2 refutation, contradiction and resolution", () => {
  const counter = { kind: "counter-evidence", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: RECEIPT2 };
  assert.equal(E.evidentiaryState(finding({ proofs: [counter] }), stateCtx).state, "refuted");
  const both = finding({ proofs: [...finding().proofs, counter] });
  assert.equal(E.evidentiaryState(both, stateCtx).state, "contested");
  const resolvedRefuted = finding({ proofs: [...both.proofs, { kind: "resolution", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: RESOLVED_REFUTED, outcome: "refuted", explains: "repro used a stale build" }] });
  assert.equal(E.evidentiaryState(resolvedRefuted, stateCtx).state, "refuted");
  const resolvedConfirmed = finding({ proofs: [...both.proofs, { kind: "resolution", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: RESOLVED_CONFIRMED, outcome: "confirmed", explains: "counter-test exercised a different input" }] });
  assert.equal(E.evidentiaryState(resolvedConfirmed, stateCtx).state, "reproduced");
  const otherPredicate = finding({ proofs: [...finding().proofs, { ...counter, predicate_id: "correctness:logic-error:something-else" }] });
  assert.equal(E.evidentiaryState(otherPredicate, stateCtx).state, "reproduced", "refuting a different predicate does not touch this one");
  const staleCounter = finding({ proofs: [...finding().proofs, { ...counter, binding: OTHER_REVISION }] });
  assert.equal(E.evidentiaryState(staleCounter, stateCtx).state, "reproduced", "stale counter-evidence is inadmissible");
});

test("§7.2 receipt bytes, not digests, establish proof (review 2026-10-16 spec P1)", () => {
  const forged = { kind: "reproduction", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: "0".repeat(64), expected: 1, actual: 2, exit_code: 1 };
  const missing = E.evidentiaryState(finding({ proofs: [forged] }), stateCtx);
  assert.equal(missing.state, "inferred", "a digest with no receipt bytes is not a reproduction");
  assert.equal(missing.confirmed, false);
  assert.match(missing.limitations.join(" "), /receipt bytes are not available/);
  assert.equal(E.evidentiaryState(finding(), { ...stateCtx, readReceipt: undefined }).state, "inferred", "no receipt reader, no receipt-backed proof");
  const store = (sha, receipt) => ({ ...stateCtx, readReceipt: readReceipt(new Map([[sha, receipt]])) });
  const real = RECEIPTS.get(RECEIPT);
  assert.match(E.evidentiaryState(finding(), store(RECEIPT, { ...real, binding: OTHER_REVISION })).limitations.join(" "), /receipt is bound to a different revision/);
  assert.equal(E.evidentiaryState(finding(), store(RECEIPT, { ...real, predicate_id: "correctness:logic-error:other" })).state, "inferred");
  assert.equal(E.evidentiaryState(finding(), store(RECEIPT, { ...real, kind: "analyzer" })).state, "inferred");
  assert.equal(E.evidentiaryState(finding(), store(RECEIPT, { ...real, schema_version: "other@1" })).state, "inferred");
  assert.equal(E.evidentiaryState(finding(), store(RECEIPT, { ...real, exit_code: 0 })).state, "inferred", "the proof's exit code contradicts its receipt");
  assert.equal(E.evidentiaryState(finding(), store(RECEIPT, { ...real, actual: 29 })).state, "inferred", "the receipt shows no mismatch");
  const fromReceipt = E.evidentiaryState(finding({ proofs: [{ kind: "reproduction", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: RECEIPT }] }), stateCtx);
  assert.equal(fromReceipt.state, "reproduced", "the receipt's own expected/actual/exit code are authoritative");
  const forgedCounter = { kind: "counter-evidence", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: "3".repeat(64) };
  assert.equal(E.evidentiaryState(finding({ proofs: [...finding().proofs, forgedCounter] }), stateCtx).state, "reproduced", "an invented counter-receipt cannot refute or contest");
});

test("§9.2 containment requires a passing receipt for the same predicate (review 2026-10-16 spec P1)", () => {
  const PASS = "4".repeat(64);
  const store = new Map([[PASS, proofReceipt("prevention-check", { check_id: "guard-test", outcome: "pass" })], ["5".repeat(64), proofReceipt("prevention-check", { check_id: "guard-test", outcome: "fail" })]]);
  const ctx = { ...stateCtx, readReceipt: readReceipt(store) };
  const containment = { kind: "prevention-check", check_id: "guard-test", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: PASS, outcome: "pass" };
  assert.equal(E.containmentVerified(containment, PREDICATE.predicate_id, ctx).contained, true);
  assert.equal(E.containmentVerified({ ...containment, receipt_sha256: "1".repeat(64) }, PREDICATE.predicate_id, ctx).contained, false, "an invented receipt does not contain");
  assert.equal(E.containmentVerified({ ...containment, receipt_sha256: "5".repeat(64), outcome: undefined }, PREDICATE.predicate_id, ctx).contained, false, "a failing check does not contain");
  assert.equal(E.containmentVerified({ ...containment, receipt_sha256: "5".repeat(64) }, PREDICATE.predicate_id, ctx).contained, false, "a record claiming pass over a failing receipt does not contain");
  assert.equal(E.containmentVerified(containment, "correctness:logic-error:other", ctx).contained, false);
  assert.equal(E.containmentVerified({ ...containment, kind: "reproduction" }, PREDICATE.predicate_id, ctx).contained, false, "a reproduction is not containment");
});

test("§12 test 10 (unit): workflow status never enters the evidentiary state or grouping", () => {
  const base = finding();
  const workflowNoise = { ...base, status: "rejected", rollup: { recommended_action: "reject" }, candidate_lifecycle: { lifecycle_status: "rejected" } };
  assert.deepEqual(E.evidentiaryState(workflowNoise, stateCtx), E.evidentiaryState(base, stateCtx));
  const g1 = E.groupCanonicalDefects([base], stateCtx);
  const g2 = E.groupCanonicalDefects([{ ...workflowNoise, status: "completed" }], stateCtx);
  assert.deepEqual(g2, g1);
});

test("§12 test 13: the same defect from Health and Integrity forms one canonical group", () => {
  const health = finding({ finding_id: "health:CONTRACT-1", owner: "health", dimensions: ["contracts"], defect_class: "contract-drift", predicate: null, proofs: [{ kind: "judgment" }], severity: 3, evidence_keys: [code("src/api/order-schema.js", 1, 8)] });
  const integrity = finding({ finding_id: "integrity:health:CONTRACT-1", owner: "integrity", origin: "adopted", adopted_from: "health:CONTRACT-1", dimensions: ["contracts"], defect_class: "contract-drift",
    predicate: { predicate_id: "contracts:contract-drift:order-qty", statement: "api uses qty, client uses quantity" }, severity: 3,
    evidence_keys: [code("src/api/order-schema.js", 1, 8), code("src/client/order-schema.js", 1, 8)],
    proofs: [{ kind: "observation", predicate_id: "contracts:contract-drift:order-qty", binding: BINDING, quality: "strong", evidence_key: code("src/api/order-schema.js", 3, 3), confirmed: "field qty vs quantity" }] });
  const result = E.groupCanonicalDefects([integrity, health], stateCtx);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].members, ["health:CONTRACT-1", "integrity:health:CONTRACT-1"]);
  assert.equal(result.groups[0].evidentiary_state, "observed");
  assert.equal(result.groups[0].severity, 3);
  assert.deepEqual(result.groups[0].owners, ["health:original", "integrity:adopted"]);
  // An adoption link between demonstrably different failures is rejected, not merged.
  const wrong = { ...integrity, predicate: { predicate_id: "contracts:contract-drift:other", statement: "x" }, proofs: [] };
  const healthWithPredicate = { ...health, predicate: { predicate_id: "contracts:contract-drift:order-qty", statement: "y" } };
  const rejected = E.groupCanonicalDefects([wrong, healthWithPredicate], stateCtx);
  assert.equal(rejected.groups.length, 2);
  assert.equal(rejected.rejected_links[0].via, "adoption");
  assert.equal(rejected.unresolved.length, 1);
});

test("§6.4 grouping: same predicate + overlapping keys merge; order never changes the result", () => {
  const a = finding({ finding_id: "integrity:I-1" });
  const b = finding({ finding_id: "health:H-9", owner: "health", severity: 4, evidence_keys: [code("src/money.js", 1, 3)] });
  const c = finding({ finding_id: "integrity:I-2", predicate: { predicate_id: "correctness:logic-error:other", statement: "different" }, proofs: [{ ...finding().proofs[0], predicate_id: "correctness:logic-error:other" }] });
  const forward = E.groupCanonicalDefects([a, b, c], stateCtx);
  const shuffled = E.groupCanonicalDefects([c, a, b], stateCtx);
  assert.deepEqual(shuffled, forward);
  assert.equal(forward.groups.length, 2, "overlapping-but-distinct defects stay separate");
  const merged = forward.groups.find(group => group.members.length === 2);
  assert.deepEqual(merged.members, ["health:H-9", "integrity:I-1"]);
  assert.equal(merged.severity, 4, "max severity among confirmed members");
});

test("§6.4 grouping: broad duplicate labels and whole-file overlap never merge different failures", () => {
  const a = finding({ finding_id: "integrity:I-1", dedup: { duplicate_group: "money", merged_from: [] } });
  const b = finding({ finding_id: "integrity:I-2", dedup: { duplicate_group: "money", merged_from: [] }, predicate: { predicate_id: "correctness:logic-error:rounding-mode", statement: "banker's rounding" }, proofs: [{ ...finding().proofs[0], predicate_id: "correctness:logic-error:rounding-mode" }] });
  const result = E.groupCanonicalDefects([a, b], stateCtx);
  assert.equal(result.groups.length, 2);
  assert.equal(result.rejected_links.length, 1);
  assert.equal(result.rejected_links[0].via, "duplicate_group");
  const wholeFileA = finding({ finding_id: "integrity:I-3", evidence_keys: [code("src/money.js")] });
  const wholeFileB = finding({ finding_id: "integrity:I-4", evidence_keys: [code("src/money.js")], predicate: { predicate_id: "correctness:logic-error:negative", statement: "negatives" }, proofs: [{ ...finding().proofs[0], predicate_id: "correctness:logic-error:negative" }] });
  assert.equal(E.groupCanonicalDefects([wholeFileA, wholeFileB], stateCtx).groups.length, 2);
});

test("§6.4 grouping: unresolved potential duplicates are recorded, contested evidence preserved", () => {
  const a = finding({ finding_id: "health:H-1", owner: "health", predicate: null, proofs: [{ kind: "judgment" }], evidence_keys: [code("src/money.js")] });
  const b = finding({ finding_id: "integrity:I-1", evidence_keys: [code("src/money.js", 2, 2)] });
  const result = E.groupCanonicalDefects([a, b], stateCtx);
  assert.equal(result.groups.length, 2, "an uncomparable potential duplicate is not silently merged");
  assert.deepEqual(result.unresolved, [{ members: ["health:H-1", "integrity:I-1"], reason: "potential duplicate without a comparable failure predicate" }]);
  const counter = { kind: "counter-evidence", predicate_id: PREDICATE.predicate_id, binding: BINDING, receipt_sha256: RECEIPT2 };
  const contested = E.groupCanonicalDefects([finding({ proofs: [...finding().proofs, counter] })], stateCtx);
  assert.equal(contested.groups[0].evidentiary_state, "contested");
  assert.equal(contested.groups[0].confirmed, false);
  assert.equal(contested.groups[0].severity, null, "severity comes only from confirmed members");
});

test("adopted findings derive dimensions from lane_sources and report ambiguity", () => {
  const map = { "correctness-and-integrity": ["correctness"], "contracts-and-integration": ["contracts"] };
  assert.deepEqual(E.deriveAdoptedDimensions(["contracts-and-integration", "architecture-fitness"], map), { dimensions: ["contracts"], limitations: ["lane_sources without a dimension mapping: architecture-fitness"], ambiguous: false });
  assert.equal(E.deriveAdoptedDimensions(["architecture-fitness"], map).ambiguous, true);
  assert.equal(E.deriveAdoptedDimensions(undefined, map).ambiguous, true);
});

test("strength factors are imported, and a missing vocabulary fails closed", () => {
  assert.deepEqual(E.strengthFactors({ evidence_qualities: ["strong", "moderate", "weak", "none"], health_evidence_factor: { strong: 1, moderate: 0.9, weak: 0.7, none: 0 } }), { strong: 1, moderate: 0.9, weak: 0.7 });
  assert.throws(() => E.strengthFactors({ evidence_qualities: ["strong"], health_evidence_factor: {} }), /FAIL-EVIDENCE-VOCABULARY/);
});
