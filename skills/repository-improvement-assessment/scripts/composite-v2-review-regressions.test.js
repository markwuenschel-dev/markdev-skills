"use strict";
// Regressions for the 2026-10-16 Promotion A review's spec findings, at the composite binder
// boundary (each mirrors the reviewer's reproduction, with a positive control):
//   1. receipt digests were accepted without receipt bytes (§7.2, §9.2 containment)
//   2. Integrity coverage and absence accepted unresolved sources and scope (§7.1 rules 4-5)
//   3. a scored Architecture sub-dimension without resolved evidence kept its mass (§4.1)
// and for the 2026-10-17 recheck's residual findings:
//   4. a strong observation citing a nonexistent file or line confirmed a critical defect (§7.2)
//   5. absence ignored recorded scope text and unresolved non-path refs (§7.1 rules 4-5)
// and for the second recheck's boundary findings:
//   6. invalid observation ranges ([0,0], negative, inverted, fractional) confirmed defects (§6.1)
//   7. a Git tree (directory) counted as source lines for an observation (§7.2)
//   8. quoted, directory or prose scope notation vanished from absence validation (§7.1 rule 5)
// and for the third recheck:
//   9. surfaces citing only a candidate, with empty or symbolic scope, had an empty inventory
//      that passed an empty-list comparison and established absence (§7.1 rule 5)
// and for the fourth recheck:
//  10. a negative claim asserting inspected coverage over sampled (or otherwise uninspected)
//      surfaces established absence; sampling every surface cannot produce a 100 (§7.3)
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SKILLS = path.resolve(__dirname, "..", "..");
const EM = require(path.join(SKILLS, "shared", "ria-scoring", "evidence-model.js"));
const { loadScoringConfig } = require(path.join(SKILLS, "shared", "ria-scoring", "composite-v2-config.js"));
const { compositeV2Analytics } = require("./composite-v2-model.js");
const AB = require(path.join(SKILLS, "architecture-improvement-intelligence", "assets", "architecture-evidence-binding.js"));
const { verifyIntegrityCoverage } = require(path.join(SKILLS, "codebase-integrity-audit-loop", "assets", "integrity-coverage.js"));

const loaded = loadScoringConfig();
const BINDING = { repository_id: "probe", root_id: "root-0", revision: "f".repeat(40) };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(SKILLS, relative), "utf8"));

/** A worktree holding the files the canonical ledger cites, and an empty receipt store. */
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-review-regressions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, text] of [["src/money.js", "exports.toCents = (x) => Math.floor(x * 100);\n"], ["src/api/schema.ts", "export interface Order { qty: number }\n"], ["src/other.js", "module.exports = 1;\n"]]) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  const receipts = path.join(root, "receipts");
  fs.mkdirSync(receipts);
  return { root, receipts, sources: { repository_root: root, snapshot: { kind: "worktree" } } };
}
function storeReceipt(dir, receipt) {
  const bytes = Buffer.from(JSON.stringify(receipt));
  const digest = sha(bytes);
  fs.writeFileSync(path.join(dir, `${digest}.json`), bytes);
  return digest;
}
function ledgerWithCriticalProof(receiptSha256) {
  const ledger = readJson("codebase-integrity-audit-loop/assets/canonical-ria-ledger.json");
  const victim = ledger.candidates.find((candidate) => candidate.candidate_id === "integrity:CORR-001");
  victim.scores.severity = 5;
  victim.ria_proof = { failure_predicate: { predicate_id: "correctness:logic-error:probe", statement: "probe" }, input_binding: BINDING, proofs: [{ kind: "reproduction", receipt_sha256: receiptSha256, binding: BINDING, predicate_id: "correctness:logic-error:probe", expected: 1, actual: 2, exit_code: 1 }] };
  return { ledger, victim };
}
const caps = (ctx) => compositeV2Analytics({ loaded, binding: BINDING, sei: { status: "missing" }, ...ctx }).composite.caps.filter((cap) => cap.cap_id === "confirmed-critical-failure");

test("spec 1: an invented reproduction receipt cannot trigger the critical cap; real bytes can", (t) => {
  const w = workspace(t);
  const forged = ledgerWithCriticalProof("0".repeat(64));
  assert.deepEqual(caps({ integrity: { raw: forged.ledger }, sources: w.sources, receipts: { directories: [w.receipts] } }), [], "a digest without bytes confirms nothing");
  const digest = storeReceipt(w.receipts, { schema_version: EM.RECEIPT_SCHEMA, kind: "reproduction", binding: BINDING, predicate_id: "correctness:logic-error:probe", expected: 1, actual: 2, exit_code: 1 });
  const real = ledgerWithCriticalProof(digest);
  assert.equal(caps({ integrity: { raw: real.ledger }, sources: w.sources, receipts: { directories: [w.receipts] } }).length, 1, "positive control: a stored receipt confirms and caps");
  const stale = ledgerWithCriticalProof(storeReceipt(w.receipts, { schema_version: EM.RECEIPT_SCHEMA, kind: "reproduction", binding: { ...BINDING, revision: "e".repeat(40) }, predicate_id: "correctness:logic-error:probe", expected: 1, actual: 2, exit_code: 1 }));
  assert.deepEqual(caps({ integrity: { raw: stale.ledger }, sources: w.sources, receipts: { directories: [w.receipts] } }), [], "a receipt for another revision does not confirm");
  fs.writeFileSync(path.join(w.receipts, `${digest}.json`), Buffer.from(JSON.stringify({ tampered: true })));
  assert.throws(() => caps({ integrity: { raw: real.ledger }, sources: w.sources, receipts: { directories: [w.receipts] } }), (error) => /FAIL-RIA-PROOF-RECEIPT/.test(error.message) && error.non_degradable === true, "bytes that do not hash to their name block");
});

test("spec 1: invented containment cannot remove the critical cap; a passing check receipt can", (t) => {
  const w = workspace(t);
  const digest = storeReceipt(w.receipts, { schema_version: EM.RECEIPT_SCHEMA, kind: "reproduction", binding: BINDING, predicate_id: "correctness:logic-error:probe", expected: 1, actual: 2, exit_code: 1 });
  const { ledger, victim } = ledgerWithCriticalProof(digest);
  const ctx = { integrity: { raw: ledger }, sources: w.sources, receipts: { directories: [w.receipts] } };
  victim.ria_proof.containment = { kind: "prevention-check", check_id: "fake", receipt_sha256: "1".repeat(64), outcome: "pass", predicate_id: "correctness:logic-error:probe", binding: BINDING };
  assert.equal(caps(ctx).length, 1, "fabricated containment leaves the cap in place");
  const failing = storeReceipt(w.receipts, { schema_version: EM.RECEIPT_SCHEMA, kind: "prevention-check", binding: BINDING, predicate_id: "correctness:logic-error:probe", check_id: "guard", outcome: "fail" });
  victim.ria_proof.containment = { kind: "prevention-check", check_id: "guard", receipt_sha256: failing, predicate_id: "correctness:logic-error:probe", binding: BINDING };
  assert.equal(caps(ctx).length, 1, "a failing prevention check is not containment");
  const passing = storeReceipt(w.receipts, { schema_version: EM.RECEIPT_SCHEMA, kind: "prevention-check", binding: BINDING, predicate_id: "correctness:logic-error:probe", check_id: "guard", outcome: "pass" });
  victim.ria_proof.containment = { kind: "prevention-check", check_id: "guard", receipt_sha256: passing, predicate_id: "correctness:logic-error:probe", binding: BINDING };
  assert.deepEqual(caps(ctx), [], "positive control: a verified passing check contains the defect");
});

function integrityScores(ctx) {
  return Object.fromEntries(compositeV2Analytics({ loaded, binding: BINDING, sei: { status: "missing" }, ...ctx }).composite.dimensions
    .map((dimension) => [dimension.id, dimension.contributions.find((c) => c.owner === "integrity")]).filter(([, c]) => c));
}
/** The reviewer's fabricated receipt: every surface inspected/strong on the given path,
 * and one negative claim per dimension sourced from that path with the given exclusions. */
function fabricatedLedger(pathRef, { exclusions = ["all actual files"], sources = [pathRef] } = {}) {
  const ledger = readJson("codebase-integrity-audit-loop/assets/canonical-ria-ledger.json");
  ledger.candidates = [];
  for (const [dimension, receipt] of Object.entries(ledger.coverage.dimensions)) {
    for (const surface of receipt.surfaces) Object.assign(surface, { state: "inspected", evidence_quality: "strong", methods: ["unrelated"], scope: `${surface.surface_id} at the assessed revision`, evidence_refs: [{ kind: "path", ref: pathRef }], reason: null });
    receipt.negative_claims = [{ negative_claim_id: "negative:fake", statement: "Nothing is wrong", search_scope: receipt.surfaces.map((s) => `surface:${s.surface_id}`), search_methods: loaded.config.integrity_defect_checks[dimension].map((c) => `defect-check:${c}`), evidence_quality: "strong", coverage: { state: "inspected", scope: "one file", methods: ["unrelated"], limitations: [] }, sources: sources.map((ref) => ({ kind: "path", ref })), exclusions, search_completeness: "repository-exhaustive", supports_absence: true, confidence: { level: "high", rationale: "because" }, limitations: [] }];
  }
  return ledger;
}

test("spec 2: fabricated Integrity inspection evidence does not earn 100", (t) => {
  const w = workspace(t);
  const nonexistent = integrityScores({ integrity: { raw: fabricatedLedger("never-existed/no-such-file.js") }, sources: w.sources });
  for (const [id, contribution] of Object.entries(nonexistent)) {
    assert.notEqual(contribution.state, "scored", `${id}: a nonexistent path cannot be inspection evidence`);
    assert.match(contribution.limitations.join(" "), /does not exist at the assessed revision/, id);
  }
  const unresolved = integrityScores({ integrity: { raw: fabricatedLedger("src/money.js", { exclusions: [] }) } });
  for (const [id, contribution] of Object.entries(unresolved)) assert.notEqual(contribution.state, "scored", `${id}: without repository sources the receipt is not scored`);
  const freeText = integrityScores({ integrity: { raw: fabricatedLedger("src/money.js") }, sources: w.sources });
  for (const [id, contribution] of Object.entries(freeText)) assert.notEqual(contribution.score, 100, `${id}: an uncheckable "all actual files" exclusion defeats absence`);
  const narrow = fabricatedLedger("src/money.js", { exclusions: [], sources: ["src/other.js"] });
  for (const receipt of Object.values(narrow.coverage.dimensions)) for (const surface of receipt.surfaces) surface.evidence_refs.push({ kind: "path", ref: "src/api/schema.ts" });
  for (const [id, contribution] of Object.entries(integrityScores({ integrity: { raw: narrow }, sources: w.sources }))) assert.notEqual(contribution.score, 100, `${id}: a search of one other file cannot establish absence over the recorded scope`);
  const honest = integrityScores({ integrity: { raw: fabricatedLedger("src/money.js", { exclusions: [] }) }, sources: w.sources });
  assert.equal(honest.correctness.state, "scored", "positive control: a resolved, covering receipt still scores");
  assert.equal(honest.correctness.score, 100);
});

function architectureArtifact() {
  const artifact = readJson("architecture-improvement-intelligence/assets/architecture-candidate-set.ria.example.json");
  const receipt = { dimensions: {} };
  for (const id of Object.keys(artifact.architecture_fitness.dimensions)) {
    artifact.architecture_fitness.dimensions[id] = { state: "scored", score: 80, evidence_refs: [`evidence-recon:${"a".repeat(64)}#claim:probe`] };
    receipt.dimensions[id] = { evidence_complete: true, facts: [{ ...EM.codeKey(BINDING, `src/${id}.js`, [1, 1]), origin: "original", quality: "strong" }], limitations: [] };
  }
  return { artifact, receipt };
}
const architectureContribution = (artifact, receipt) => compositeV2Analytics({ loaded, binding: BINDING, sei: { status: "missing" }, architecture: { raw: artifact, receipt } }).composite.dimensions.find((d) => d.id === "architecture").contributions.find((c) => c.owner === "architecture");

test("spec 3: a sub-dimension without resolved evidence retains missing mass", () => {
  const { artifact, receipt } = architectureArtifact();
  const full = architectureContribution(artifact, receipt);
  assert.deepEqual([full.lower, full.score, full.upper, full.completeness], [80, 80, 80, 1], "positive control: fully evidenced");
  receipt.dimensions.cohesion_locality = { evidence_complete: false, facts: [], limitations: ["packet unavailable (packet-file-missing)"] };
  const missing = architectureContribution(artifact, receipt);
  assert.ok(missing.completeness < 1, `completeness ${missing.completeness}`);
  assert.ok(missing.lower < 80 && missing.upper > 80, `bounds widen: [${missing.lower}, ${missing.upper}]`);
  assert.equal(missing.provisional, true);
  receipt.dimensions.cohesion_locality = { facts: [{ ...EM.codeKey(BINDING, "src/x.js", [1, 1]), origin: "original", quality: "strong" }], limitations: [] };
  assert.ok(architectureContribution(artifact, receipt).completeness < 1, "a receipt entry that does not assert evidence_complete is not trusted");
});

test("spec 3: the real resolver's partial receipt (one packet missing) widens the bounds", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ria-review-arch-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.writeFileSync(path.join(scratch, "source.js"), "module.exports = 1;\n");
  const packet = JSON.parse(fs.readFileSync(path.join(SKILLS, "architecture-improvement-intelligence/assets/canonical-ria-evidence-packet.json"), "utf8").replaceAll("__ARCH_SOURCE_PATH__", "source.js"));
  const packetPath = path.join(scratch, "packet.json");
  fs.writeFileSync(packetPath, JSON.stringify(packet));
  const realRef = AB.packetRefFor(packetPath, BINDING);
  const missingRef = { ...realRef, sha256: "b".repeat(64), artifact_id: `evidence-recon:${"b".repeat(64)}`, path: path.join(scratch, "missing-packet.json"), packet_id: "unavailable-packet" };
  const artifact = JSON.parse(fs.readFileSync(path.join(SKILLS, "architecture-improvement-intelligence/assets/architecture-candidate-set.ria.example.json"), "utf8").replaceAll("__ARCH_PACKET_SHA256__", realRef.sha256).replaceAll("__RIA_REVISION__", BINDING.revision));
  artifact.evidence_packet_refs = [realRef];
  const options = { repositoryRoot: scratch, binding: BINDING, allowedRoots: [scratch], mode: "consume", sourceSnapshot: { kind: "worktree" } };
  const whole = architectureContribution(artifact, AB.resolveArchitectureEvidence(artifact, options));
  assert.equal(whole.completeness, 1, "positive control: every packet resolves");
  assert.equal(whole.lower, whole.upper);
  artifact.evidence_packet_refs = [realRef, missingRef];
  artifact.architecture_fitness.dimensions.cohesion_locality.evidence_refs = [`evidence-recon:${missingRef.sha256}#ICA-C-001`];
  const receipt = AB.resolveArchitectureEvidence(artifact, options);
  assert.equal(receipt.dimensions.cohesion_locality.evidence_complete, false);
  const partial = architectureContribution(artifact, receipt);
  assert.ok(partial.completeness < 1, `completeness ${partial.completeness}`);
  assert.ok(partial.lower < partial.upper, `bounds widen: [${partial.lower}, ${partial.upper}]`);
});

function ledgerWithObservation(relativePath, range, { key } = {}) {
  const ledger = readJson("codebase-integrity-audit-loop/assets/canonical-ria-ledger.json");
  const victim = ledger.candidates.find((candidate) => candidate.candidate_id === "integrity:CORR-001");
  victim.scores.severity = 5;
  const evidenceKey = { ...EM.codeKey(BINDING, relativePath, range), ...(key ?? {}) };
  victim.ria_proof = { failure_predicate: { predicate_id: "correctness:logic-error:observed", statement: "probe" }, input_binding: BINDING, proofs: [{ kind: "observation", predicate_id: "correctness:logic-error:observed", binding: BINDING, quality: "strong", confirmed: "toCents floors instead of rounding", evidence_key: evidenceKey }] };
  return ledger;
}

test("recheck spec 1: a strong observation must cite source that exists at the assessed revision", (t) => {
  const w = workspace(t);
  const ctx = (ledger, sources = w.sources) => ({ integrity: { raw: ledger }, sources, receipts: { directories: [w.receipts] } });
  assert.deepEqual(caps(ctx(ledgerWithObservation("never-existed/no-such-file.js", [999, 999]))), [], "a nonexistent file confirms nothing");
  assert.deepEqual(caps(ctx(ledgerWithObservation("src/money.js", [999, 999]))), [], "a line beyond the file confirms nothing");
  assert.deepEqual(caps(ctx(ledgerWithObservation("src/money.js", [1, 1], { key: { key: EM.codeKey(BINDING, "never-existed/no-such-file.js", [1, 1]).key } }))), [], "metadata that disagrees with its key confirms nothing");
  assert.deepEqual(caps(ctx(ledgerWithObservation("src/money.js", [1, 1]), null)), [], "without a source snapshot an observation cannot be verified");
  const real = caps(ctx(ledgerWithObservation("src/money.js", [1, 1])));
  assert.equal(real.length, 1, "positive control: a cited line that exists confirms and caps");
  assert.equal(real[0].ceiling, 66.9);
});

/** Absence ledger: every surface inspected/strong with the given refs and scope text; one
 * negative claim per dimension sourced from the given paths. */
function scopedLedger({ refs, scope, sources }) {
  const ledger = fabricatedLedger("src/money.js", { exclusions: [], sources });
  for (const receipt of Object.values(ledger.coverage.dimensions)) for (const surface of receipt.surfaces) Object.assign(surface, { scope, evidence_refs: refs });
  return ledger;
}

test("recheck spec 2: absence must search the recorded scope, and every ref must resolve", (t) => {
  const w = workspace(t);
  const scores = (ledger) => Object.entries(integrityScores({ integrity: { raw: ledger }, sources: w.sources }));
  const pathRef = [{ kind: "path", ref: "src/money.js" }];
  for (const [id, c] of scores(scopedLedger({ refs: pathRef, scope: "src/money.js and src/other.js", sources: ["src/money.js"] }))) {
    assert.notEqual(c.score, 100, `${id}: scope text names a file the search did not cover`);
  }
  for (const [id, c] of scores(scopedLedger({ refs: [{ kind: "inventory", ref: "inventory:not-real" }], scope: "everything", sources: ["src/money.js"] }))) {
    assert.notEqual(c.state, "scored", `${id}: an unresolved inventory ref fails validation`);
    assert.match(c.limitations.join(" "), /evidence ref inventory/, id);
  }
  for (const [id, c] of scores(scopedLedger({ refs: [{ kind: "inventory", ref: "src/api/schema.ts" }], scope: "everything", sources: ["src/money.js"] }))) {
    assert.notEqual(c.score, 100, `${id}: a resolved inventory cannot be enumerated here, so absence over it is unchecked`);
  }
  // A ref on a (non-core) not-applicable surface is outside the applicable search scope, so only
  // rule 4 (resolution) can reject it; a claim ref that names this ledger's claim is the control.
  const withInventoryOnly = (ref) => {
    const ledger = scopedLedger({ refs: pathRef, scope: "", sources: ["src/money.js"] });
    for (const receipt of Object.values(ledger.coverage.dimensions)) Object.assign(receipt.surfaces.at(-1), { state: "not-applicable", evidence_quality: "none", methods: [], reason: "probe: outside this dimension's applicable scope", evidence_refs: [ref] });
    return ledger;
  };
  for (const [id, c] of scores(withInventoryOnly({ kind: "claim", ref: "negative:fake" }))) assert.deepEqual([c.state, c.score], ["scored", 100], `${id}: positive control, a resolved claim ref`);
  for (const [kind, ref] of [["claim", "negative:not-in-ledger"], ["command", "cmd-not-in-baseline"], ["rationale", "looks complete"]]) {
    for (const [id, c] of scores(withInventoryOnly({ kind, ref }))) {
      assert.notEqual(c.state, "scored", `${id}: unresolved ${kind} ref`);
      assert.match(c.limitations.join(" "), new RegExp(`evidence ref ${kind}`), id);
    }
  }
  const honest = scores(scopedLedger({ refs: pathRef, scope: "src/money.js and src/other.js", sources: ["src/money.js", "src/other.js"] }));
  for (const [id, c] of honest) assert.deepEqual([c.state, c.score], ["scored", 100], `${id}: positive control, the search covers the recorded scope`);
});

test("recheck 2 spec 1: an observation range must be positive ascending integers", (t) => {
  const w = workspace(t);
  const ctx = (ledger) => ({ integrity: { raw: ledger }, sources: w.sources, receipts: { directories: [w.receipts] } });
  const forged = (range) => ledgerWithObservation("src/money.js", [1, 1], { key: { range, key: `code:${BINDING.repository_id}:${BINDING.root_id}:${BINDING.revision}:src/money.js:[${range[0]},${range[1]}]` } });
  for (const range of [[0, 0], [-3, -1], [1, 0], [0.5, 0.5]]) assert.deepEqual(caps(ctx(forged(range))), [], `range ${JSON.stringify(range)} confirms nothing`);
  assert.throws(() => EM.codeKey(BINDING, "src/money.js", [0, 0]), /FAIL-EVIDENCE-RANGE/, "codeKey rejects an invalid structured range");
  assert.equal(caps(ctx(forged([1, 1]))).length, 1, "positive control: [1,1] on an existing line confirms");
});

test("recheck 2 spec 2: a Git tree is not source; only a regular blob confirms an observation", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ria-review-git-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const run = (args) => require("node:child_process").execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "money.js"), "exports.toCents = (x) => Math.floor(x * 100);\n");
  run(["init", "-q"]); run(["add", "-A"]); run(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "fixture"]);
  const binding = { ...BINDING, revision: run(["rev-parse", "HEAD"]) };
  assert.equal(run(["cat-file", "-t", `${binding.revision}:src`]), "tree");
  const sources = { repository_root: repo, snapshot: { kind: "git", revision: binding.revision } };
  const capsAt = (file) => {
    const ledger = readJson("codebase-integrity-audit-loop/assets/canonical-ria-ledger.json");
    const victim = ledger.candidates.find((candidate) => candidate.candidate_id === "integrity:CORR-001");
    victim.scores.severity = 5;
    victim.ria_proof = { failure_predicate: { predicate_id: "correctness:logic-error:observed", statement: "probe" }, input_binding: binding, proofs: [{ kind: "observation", predicate_id: "correctness:logic-error:observed", binding, quality: "strong", confirmed: "floors", evidence_key: EM.codeKey(binding, file, [1, 1]) }] };
    return compositeV2Analytics({ loaded, binding, sei: { status: "missing" }, integrity: { raw: ledger }, sources }).composite.caps.filter((cap) => cap.cap_id === "confirmed-critical-failure");
  };
  assert.deepEqual(capsAt("src"), [], "a directory confirms nothing");
  assert.equal(capsAt("src/money.js").length, 1, "positive control: a source blob confirms");
  const worktree = AB.revisionReader(repo, { kind: "worktree" });
  assert.equal(worktree("src").state, "absent", "the worktree reader agrees: a directory is not a file");
  assert.equal(worktree("src/money.js").state, "present");
});

test("recheck 2 spec 3: scope notation the verifier cannot enumerate keeps absence unsupported", (t) => {
  const w = workspace(t);
  const scores = (ledger) => Object.entries(integrityScores({ integrity: { raw: ledger }, sources: w.sources }));
  const pathRef = [{ kind: "path", ref: "src/money.js" }];
  for (const scope of ["src/money.js and \"src/other.js\"", "src", "src/", "src/money.js and the rest of src", "'src/money.js'"]) {
    const ledger = scopedLedger({ refs: pathRef, scope, sources: ["src/money.js"] });
    for (const [id, c] of scores(ledger)) assert.notEqual(c.score, 100, `${id}: scope ${JSON.stringify(scope)} cannot be enumerated, so absence is unsupported`);
    const verdict = verifyIntegrityCoverage(ledger, { revision: BINDING.revision, loaded, resolveSource: AB.revisionReader(w.root, { kind: "worktree" }) });
    for (const [id, dimension] of Object.entries(verdict.dimensions)) assert.match(JSON.stringify(dimension.negative_claims[0].limitations), /cannot be enumerated/, `${id}: the unenumerable scope is named, not dropped (${scope})`);
  }
  for (const scope of ["", "src/money.js", "src/money.js, src/other.js", "src/money.js and src/other.js"]) {
    for (const [id, c] of scores(scopedLedger({ refs: pathRef, scope, sources: ["src/money.js", "src/other.js"] }))) assert.deepEqual([c.state, c.score], ["scored", 100], `${id}: positive control, enumerable scope ${JSON.stringify(scope)} searched in full`);
  }
});

test("recheck 2 spec 2: links are not regular source in either reader", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ria-review-links-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ria-review-outside-"));
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const run = (args, input) => require("node:child_process").execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, input }).trim();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "money.js"), "one\ntwo\n");
  run(["init", "-q"]); run(["add", "-A"]);
  // A Git symlink entry (mode 120000) whose target text is a path, added without a filesystem link.
  const linkBlob = run(["hash-object", "-w", "--stdin"], "money.js");
  run(["update-index", "--add", "--cacheinfo", `120000,${linkBlob},src/link.js`]);
  run(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "fixture"]);
  const git = AB.revisionReader(repo, { kind: "git", revision: run(["rev-parse", "HEAD"]) });
  assert.equal(git("src/link.js").state, "absent", "a Git symlink is not a regular source blob");
  assert.equal(git("src/money.js").state, "present", "positive control");
  // A worktree file reached through a junction that leaves the repository.
  fs.writeFileSync(path.join(outside, "evil.js"), "x\n");
  fs.symlinkSync(outside, path.join(repo, "src", "escape"), "junction");
  const worktree = AB.revisionReader(repo, { kind: "worktree" });
  assert.equal(worktree("src/escape/evil.js").state, "absent", "a file outside the repository through a link is absent");
  assert.equal(worktree("src/money.js").state, "present", "positive control");
});

test("recheck 3: every applicable inspected surface needs a file inventory; an empty one keeps uncertainty", (t) => {
  const w = workspace(t);
  const canonical = readJson("codebase-integrity-audit-loop/assets/canonical-ria-ledger.json");
  const adopted = canonical.candidates.find((candidate) => candidate.candidate_id === "CONTRACT-007");
  const scores = (ledger) => Object.entries(integrityScores({ integrity: { raw: ledger }, sources: w.sources }));
  const withRefs = (refsFor, scope) => {
    const ledger = scopedLedger({ refs: [], scope: "", sources: ["src/money.js"] });
    ledger.candidates = [structuredClone(adopted)];
    for (const receipt of Object.values(ledger.coverage.dimensions)) receipt.surfaces.forEach((surface, index) => Object.assign(surface, { evidence_refs: refsFor(index), scope: scope(surface) }));
    return ledger;
  };
  const candidateOnly = () => [{ kind: "candidate", ref: "CONTRACT-007" }];
  for (const [label, scope] of [["empty", () => ""], ["symbolic", (surface) => `${surface.surface_id} at the assessed revision`]]) {
    const ledger = withRefs(candidateOnly, scope);
    for (const [id, c] of scores(ledger)) assert.notEqual(c.score, 100, `${id}: candidate-only surfaces with ${label} scope enumerate no files`);
    const verdict = verifyIntegrityCoverage(ledger, { revision: BINDING.revision, loaded, resolveSource: AB.revisionReader(w.root, { kind: "worktree" }) });
    assert.equal(verdict.ok, true, "the receipt itself is valid; only absence is withheld");
    for (const [id, dimension] of Object.entries(verdict.dimensions)) {
      assert.equal(dimension.absence_supported, false, id);
      assert.match(JSON.stringify(dimension.negative_claims[0].limitations), /no file inventory/, id);
    }
  }
  // One enumerated surface does not vouch for the others in the dimension.
  const mixed = withRefs((index) => (index === 0 ? [{ kind: "path", ref: "src/money.js" }] : candidateOnly()), () => "");
  for (const [id, c] of scores(mixed)) assert.notEqual(c.score, 100, `${id}: a second surface with no inventory still withholds absence`);
  const enumerated = withRefs(() => [{ kind: "path", ref: "src/money.js" }, ...candidateOnly()], () => "");
  for (const [id, c] of scores(enumerated)) assert.deepEqual([c.state, c.score], ["scored", 100], `${id}: positive control, every surface enumerated and searched`);
});

test("recheck 4: a negative claim's inspected coverage needs every applicable surface inspected", (t) => {
  const w = workspace(t);
  const scores = (ledger) => Object.entries(integrityScores({ integrity: { raw: ledger }, sources: w.sources }));
  const pathRef = [{ kind: "path", ref: "src/money.js" }];
  const withStates = (stateFor) => {
    const ledger = scopedLedger({ refs: pathRef, scope: "", sources: ["src/money.js"] });
    for (const receipt of Object.values(ledger.coverage.dimensions)) receipt.surfaces.forEach((surface, index) => Object.assign(surface, { state: stateFor(index), evidence_quality: "moderate" }));
    return ledger;
  };
  for (const [label, stateFor] of [["every surface sampled", () => "sampled"], ["one surface sampled", (i) => (i === 0 ? "sampled" : "inspected")], ["one surface inventory-only", (i) => (i === 0 ? "inspected" : "inventory-only")]]) {
    const ledger = withStates(stateFor);
    for (const [id, c] of scores(ledger)) assert.notEqual(c.score, 100, `${id}: ${label} cannot produce a 100`);
    const verdict = verifyIntegrityCoverage(ledger, { revision: BINDING.revision, loaded, resolveSource: AB.revisionReader(w.root, { kind: "worktree" }) });
    for (const [id, dimension] of Object.entries(verdict.dimensions)) {
      assert.equal(dimension.absence_supported, false, `${id}: ${label}`);
      assert.match(JSON.stringify(dimension.negative_claims[0].limitations), /not inspected/, `${id}: ${label}`);
    }
  }
  for (const [id, c] of scores(withStates(() => "inspected"))) assert.deepEqual([c.state, c.score], ["scored", 100], `${id}: positive control, every applicable surface inspected`);
});
