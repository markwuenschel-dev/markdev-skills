"use strict";
// Appendix A evidence-grounded fixture (instructions Phase 9; composite-scoring-v3 §12).
//
// buildAppendixARepo() creates the Node-only repository with every planted property and a
// history of four commits (the third touches five files). The owner-input builders then
// record an assessment of exactly that repository: every evidence ref names a real file and
// line in it, the reproductions are run and their output bytes are the receipts, and the
// verification commands are the ones the bound verification baseline actually ran. Nothing
// is copied from another repository's sample artifact.

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const skillsRoot = path.resolve(__dirname, "..", "..", "..");
const { codeKey } = require(path.join(skillsRoot, "shared", "ria-scoring", "evidence-model.js"));
const { writeEvidencePacketForRepository } = require(path.join(skillsRoot, "shared", "evidence-recon", "evidence-recon.js"));
const { bindingFromEnvelope, packetRefFor } = require(path.join(skillsRoot, "architecture-improvement-intelligence", "assets", "architecture-evidence-binding.js"));

const FILES = Object.freeze({
  "package.json": '{\n  "name": "appendix-a",\n  "version": "1.0.0",\n  "private": true\n}\n',
  "src/math.js": "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n",
  "test/math.test.js": "const test = require(\"node:test\");\nconst assert = require(\"node:assert/strict\");\nconst { add } = require(\"../src/math.js\");\ntest(\"add\", () => assert.equal(add(1, 2), 3));\n",
  "scripts/run-fixture-tests.js": [
    "// Enumerates test/**/*.test.js with Node built-ins and runs exactly those files.",
    "const { spawnSync } = require(\"node:child_process\");",
    "const fs = require(\"node:fs\");",
    "const path = require(\"node:path\");",
    "const root = path.resolve(__dirname, \"..\");",
    "function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(\".test.js\") ? [path.join(dir, entry.name)] : []); }",
    "const files = walk(path.join(root, \"test\")).map((file) => path.relative(root, file).split(path.sep).join(\"/\")).sort();",
    "console.log(JSON.stringify({ enumerated: files }));",
    "if (!files.length) process.exit(1);",
    "const run = spawnSync(process.execPath, [\"--test\", ...files], { cwd: root, stdio: \"inherit\" });",
    "process.exit(run.status === null ? 1 : run.status);",
    "",
  ].join("\n"),
  "src/money.js": "function toCents(x) {\n  return Math.floor(x * 100);\n}\nmodule.exports = { toCents };\n",
  "src/api/order-schema.js": "// Server-side order contract.\nmodule.exports = { fields: [\"id\", \"qty\", \"price\"] };\n",
  "src/client/order-schema.js": "// Client-side copy of the order contract.\nmodule.exports = { fields: [\"id\", \"quantity\", \"price\"] };\n",
  "src/access.js": "function canReadOrder(requester, order) {\n  return Boolean(requester && requester.authenticated);\n}\nmodule.exports = { canReadOrder };\n",
  "src/a.js": "const b = require(\"./b.js\");\nmodule.exports = { base: () => 1, a: () => b.b() + 1 };\n",
  "src/b.js": "const a = require(\"./a.js\");\nmodule.exports = { b: () => 2, viaA: () => a.base() };\n",
  "repro/money.repro.js": "const { toCents } = require(\"../src/money.js\");\nconst actual = toCents(0.29);\nconsole.log(JSON.stringify({ check: \"toCents(0.29)\", expected: 29, actual }));\nprocess.exit(actual === 29 ? 0 : 1);\n",
  "repro/access.repro.js": "const { canReadOrder } = require(\"../src/access.js\");\nconst alice = { id: \"fake-alice\", authenticated: true };\nconst order = { id: \"order-1\", ownerId: \"fake-bob\" };\nconst actual = canReadOrder(alice, order);\nconsole.log(JSON.stringify({ check: \"fake-alice reads fake-bob's order\", expected: false, actual }));\nprocess.exit(actual === false ? 0 : 1);\n",
});
const COMMITS = Object.freeze([
  ["initial package and math", ["package.json", "src/math.js"]],
  ["tests and fixture runner", ["test/math.test.js", "scripts/run-fixture-tests.js"]],
  ["money, order contracts and access", ["src/money.js", "src/api/order-schema.js", "src/client/order-schema.js", "src/access.js", "repro/money.repro.js"]],
  ["module pair and access reproduction", ["src/a.js", "src/b.js", "repro/access.repro.js"]],
]);
const VERIFICATION_COMMAND = Object.freeze({ command: "node scripts/run-fixture-tests.js", kind: "test" });

/** rollup.priority_score is recomputed by the spine verifier; store the same number. */
function withPriority(row) {
  require(path.join(skillsRoot, "shared", "candidate-ledger-spine", "ledger-verify.js"));
  return { ...row, rollup: { ...row.rollup, priority_score: globalThis.LedgerVerify.computePriority(row.scores).priority } };
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function git(root, args) { return childProcess.execFileSync("git", ["-C", root, "-c", "user.email=fixture@example.invalid", "-c", "user.name=Appendix A", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" }).trim(); }

function buildAppendixARepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-q"]);
  for (const [message, files] of COMMITS) {
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), FILES[file]); }
    git(root, ["add", ...files]); git(root, ["commit", "-qm", message]);
  }
  return { root, revision: git(root, ["rev-parse", "HEAD"]) };
}

/** Runs one reproduction at the fixture root and stores its ria.proof-receipt@1 (content
 * addressed) recording what actually ran: binding, predicate, expected, actual, exit code. */
function runReproduction(root, script, receiptDir, { binding, predicate_id }) {
  const run = childProcess.spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  const record = JSON.parse(run.stdout.trim());
  const receipt = Buffer.from(JSON.stringify({ schema_version: "ria.proof-receipt@1", kind: "reproduction", binding, predicate_id, check_id: script, expected: record.expected, actual: record.actual, exit_code: run.status, stdout: run.stdout }));
  fs.mkdirSync(receiptDir, { recursive: true });
  const digest = sha256(receipt);
  fs.writeFileSync(path.join(receiptDir, `${digest}.json`), receipt);
  return { ...record, exit_code: run.status, receipt_sha256: digest };
}

function bindingOf(envelope) { return bindingFromEnvelope(envelope); }

/* ---------------------------------- Health -------------------------------- */

function levels(values, refs) {
  const keys = ["observed_soundness", "automated_enforcement", "verification_readiness", "boundary_clarity", "change_containment", "operational_reproducibility"];
  const text = { 0: "absent", 1: "ad hoc on the inspected path", 2: "present but inconsistently applied", 3: "systematic on the paths that matter", 4: "enforced and verified everywhere" };
  return Object.fromEntries(keys.map((key, index) => [key, { level: values[index], claim_refs: refs.map((claim_id) => ({ claim_id, support: `Evidences ${key.replaceAll("_", " ")} for this lane in the fixture.` })), rationale: `Level ${values[index]} for ${key.replaceAll("_", " ")}: ${text[values[index]]}.` }]));
}

/** Health's assessment of the fixture (repository-health-assessment RIA mode). */
function healthIsland({ revision, envelope, verificationArtifact }) {
  const binding = bindingOf(envelope);
  const claims = [
    { claim_id: "CORE-01", lane: "correctness-and-integrity", statement: "toCents floors an inexact float product, so toCents(0.29) returns 28.", result: "fail", evidence: [{ path: "src/money.js", lines: "1-3" }, { path: "repro/money.repro.js", lines: "1-4" }], observation: { confirmed: "repro/money.repro.js prints expected 29, actual 28 and exits 1." } },
    { claim_id: "CORE-02", lane: "correctness-and-integrity", statement: "Only add() has an automated test; money, access and the contracts have none.", result: "partial", evidence: [{ path: "test/math.test.js", lines: "1-4" }], observation: { confirmed: "The single test file exercises add only.", inferred: "Regressions elsewhere are caught only by review." } },
    { claim_id: "ARCH-01", lane: "architecture-fitness", statement: "src/a.js and src/b.js require each other, forming a module cycle.", result: "fail", evidence: [{ path: "src/a.js", lines: "1-1" }, { path: "src/b.js", lines: "1-1" }], observation: { confirmed: "Each file's first line requires the other." } },
    { claim_id: "ARCH-02", lane: "architecture-fitness", statement: "Other modules are small, single-purpose files with explicit exports.", result: "pass", evidence: [{ path: "src/math.js", lines: "1-4" }, { path: "src/money.js", lines: "1-4" }], observation: { confirmed: "Each module exports one narrow function set." } },
    { claim_id: "CONTRACT-01", lane: "contracts-and-integration", statement: "The server and client copies of the order contract disagree: qty versus quantity.", result: "fail", evidence: [{ path: "src/api/order-schema.js", lines: "2-2" }, { path: "src/client/order-schema.js", lines: "2-2" }], observation: { confirmed: "The two field lists differ in the quantity field name." } },
    { claim_id: "VER-01", lane: "verification-readiness", statement: "The fixture runner enumerates test files explicitly and propagates the test exit status.", result: "partial", evidence: [{ path: "scripts/run-fixture-tests.js", lines: "1-11" }, { path: "test/math.test.js", lines: "1-4" }], observation: { confirmed: "The bound verification baseline ran it and it passed.", inferred: "Coverage is limited to add." } },
    { claim_id: "BUILD-01", lane: "build-and-delivery", statement: "There is no CI configuration and no build step.", result: "fail", evidence: [{ architecture_level: true, rationale: "No CI workflow, pipeline file or build script exists anywhere in the repository." }], observation: { confirmed: "The tracked file list has no CI or build configuration." } },
    { claim_id: "MAINT-01", lane: "maintainability-and-ownership", statement: "There is no README or ownership metadata; the modules themselves are short.", result: "partial", evidence: [{ path: "package.json", lines: "1-5" }], observation: { confirmed: "package.json carries no description or repository fields and no README exists.", inferred: "Onboarding relies on reading the code." } },
    { claim_id: "SEC-01", lane: "security-and-production-safety", statement: "canReadOrder accepts every authenticated requester without checking order ownership.", result: "fail", evidence: [{ path: "src/access.js", lines: "1-3" }, { path: "repro/access.repro.js", lines: "1-6" }], observation: { confirmed: "repro/access.repro.js shows fake-alice reading fake-bob's order and exits 1." } },
    { claim_id: "NUM-01", lane: "numerical-correctness", statement: "Currency conversion truncates instead of rounding to the nearest cent.", result: "fail", evidence: [{ path: "src/money.js", lines: "2-2" }], observation: { confirmed: "Math.floor(x * 100) is applied to an inexact product." } },
  ];
  const lane = (id, weight, values, refs) => ({ lane: id, criticality_weight: weight, scores: levels(values, refs) });
  const lanes = [
    lane("correctness-and-integrity", 5, [1, 1, 1, 2, 2, 3], ["CORE-01", "CORE-02"]),
    lane("architecture-fitness", 4, [2, 1, 1, 2, 2, 3], ["ARCH-01", "ARCH-02"]),
    lane("contracts-and-integration", 4, [1, 0, 1, 1, 1, 1], ["CONTRACT-01"]),
    lane("verification-readiness", 4, [2, 2, 1, 2, 2, 3], ["VER-01"]),
    lane("build-and-delivery", 3, [1, 0, 1, 1, 1, 1], ["BUILD-01"]),
    lane("maintainability-and-ownership", 2, [2, 1, 1, 2, 2, 2], ["MAINT-01"]),
    lane("security-and-production-safety", 5, [1, 0, 0, 1, 1, 1], ["SEC-01"]),
    lane("numerical-correctness", 4, [1, 0, 1, 1, 1, 1], ["NUM-01"]),
  ];
  const coverage = [
    { id: "runtime-code", criticality_weight: 5, coverage: "inspected", evidence_quality: "strong", evidence_refs: [{ kind: "path", ref: "src/" }] },
    { id: "domain-libraries", criticality_weight: 4, coverage: "inspected", evidence_quality: "strong", evidence_refs: [{ kind: "path", ref: "src/money.js" }] },
    { id: "architecture-boundaries", criticality_weight: 4, coverage: "inspected", evidence_quality: "strong", evidence_refs: [{ kind: "claim", ref: "ARCH-01" }] },
    { id: "contracts-and-wiring", criticality_weight: 5, coverage: "inspected", evidence_quality: "strong", evidence_refs: [{ kind: "claim", ref: "CONTRACT-01" }] },
    { id: "data-lifecycle", criticality_weight: 4, coverage: "not-applicable", reason: "The fixture stores no data and has no migrations.", evidence_refs: [{ kind: "inventory", ref: "tracked file list at the assessed revision" }] },
    { id: "verification", criticality_weight: 4, coverage: "inspected", evidence_quality: "strong", evidence_refs: [{ kind: "command", ref: verificationArtifact.health_verification.commands[0].command_id }] },
    { id: "build-and-delivery", criticality_weight: 3, coverage: "inspected", evidence_quality: "moderate", evidence_refs: [{ kind: "inventory", ref: "tracked file list: no CI or build configuration" }] },
    { id: "operational-behavior", criticality_weight: 3, coverage: "not-applicable", reason: "The fixture is a library with no runtime entrypoint or service.", evidence_refs: [{ kind: "inventory", ref: "tracked file list at the assessed revision" }] },
    { id: "generated-surfaces", criticality_weight: 2, coverage: "not-applicable", reason: "No generated code exists.", evidence_refs: [{ kind: "inventory", ref: "tracked file list at the assessed revision" }] },
    { id: "specialized-paths", criticality_weight: 3, coverage: "not-applicable", reason: "No GPU, platform-specific or native paths.", evidence_refs: [{ kind: "inventory", ref: "language and platform inventory" }] },
    { id: "ownership-and-maintainability", criticality_weight: 2, coverage: "inspected", evidence_quality: "moderate", evidence_refs: [{ kind: "claim", ref: "MAINT-01" }] },
  ];
  const candidate = {
    candidate_id: "CONTRACT-001", title: "Order contract copies disagree on the quantity field", lane_sources: ["contracts-and-integration"], claim_refs: ["CONTRACT-01"],
    summary: "The server order schema names the field qty while the client copy names it quantity.", root_cause: "Two hand-maintained copies of one contract with no shared source or equivalence check.",
    evidence: [{ file: "src/api/order-schema.js", line: 2, observation: "fields include qty" }, { file: "src/client/order-schema.js", line: 2, observation: "fields include quantity" }],
    scores: { severity: 3, confidence: 5, leverage: 4, locality: 4, testability: 5, blast_radius: 3, regression_risk: 2, human_decision_risk: 2 },
    rollup: { priority_score: 0, recommended_action: "direct-fix", execution_mode: "sequential", blocked_by: [] }, effort: "S", depends_on: [], unlocks: [], status: "ready",
    dedup: { duplicate_group: null, merged_from: [] },
    candidate_lifecycle: { candidate_id: "CONTRACT-001", discovered_by: "repository-health-assessment", current_owner: { skill: "repository-health-assessment", stage: "awaiting-selection" }, lifecycle_status: "awaiting-selection", history: [{ event: "discovered", timestamp: "2026-10-16T00:00:00Z", artifact: "health-assessment:appendix-a" }], completion: { completed_at: null, verification_refs: [] }, resolution: { superseded_by: null, reason: null } },
  };
  return {
    health_schema_version: 5, spine_version: 3, generated: "2026-10-16T00:00:00Z",
    repository: { name: "appendix-a", revision, freshness: "fresh", freshness_evidence: { assessment_revision: revision, head_revision: revision, working_tree_clean: true, observed_at: "2026-10-16T00:00:00Z" } },
    verification: { baseline: verificationArtifact.trust.state === "trustworthy" ? "trustworthy" : "partial", isolation: "worktree", isolation_note: `verification baseline ${verificationArtifact.artifact_id}`, commands: verificationArtifact.health_verification.commands },
    coverage, lanes, claims,
    lane_applicability: {
      "data-and-migrations": { state: "not-applicable", surface_refs: ["data-lifecycle"], rationale: "The fixture stores no data and has no migrations." },
      "gpu-equivalence": { state: "not-applicable", surface_refs: ["specialized-paths"], rationale: "No GPU implementation exists." },
      "performance-and-resources": { state: "not-applicable", surface_refs: ["runtime-code"], rationale: "No stated latency, throughput or memory budget." },
      "platform-compatibility": { state: "not-applicable", surface_refs: ["specialized-paths"], rationale: "Single Node runtime target." },
    },
    sprawl_pressure: { stale_reachable_paths: [], competing_authoritative_implementations: [], duplicated_contract_representations: [], unowned_compatibility_layers: [], abandoned_reachable_experiments: [], automated_sprawl_checks: "none", assessment: "low" },
    evidence_workers: [{ worker_id: "worker-fixture-1", lane: "correctness-and-integrity", status: "complete", limitations: [] }],
    candidates: [withPriority(candidate)],
  };
}

/* -------------------------------- Integrity ------------------------------- */

function integrityLedger({ envelope, root, receiptDir, variant = {} }) {
  const binding = bindingOf(envelope);
  const money = runReproduction(root, "repro/money.repro.js", receiptDir, { binding, predicate_id: "correctness:logic-error:toCents-floor" });
  const access = runReproduction(root, "repro/access.repro.js", receiptDir, { binding, predicate_id: "security:security-exposure:order-owner-check" });
  const row = (id, extra) => withPriority({
    candidate_id: id, title: extra.title, lane_sources: extra.lane_sources, claim_refs: [], summary: extra.summary, root_cause: extra.root_cause, evidence: extra.evidence,
    scores: extra.scores, rollup: { priority_score: 0, recommended_action: "direct-fix", execution_mode: "parallel-safe", blocked_by: [] }, effort: "S", depends_on: [], unlocks: [], status: extra.status ?? "ready",
    dedup: { duplicate_group: null, merged_from: [] }, ...extra.ria,
  });
  const reproduction = (predicate, result, script) => ({ kind: "reproduction", predicate_id: predicate, binding, check_id: script, receipt_sha256: result.receipt_sha256, expected: result.expected, actual: result.actual, exit_code: result.exit_code });
  const candidates = [
    row("integrity:CORR-001", {
      title: "toCents truncates currency conversion",
      lane_sources: ["correctness-and-integrity"], summary: "toCents(0.29) returns 28 because Math.floor is applied to an inexact float product.", root_cause: "Currency conversion floors x * 100 instead of rounding to the nearest cent.",
      evidence: [{ file: "src/money.js", line: 2, observation: "return Math.floor(x * 100);" }], scores: { severity: 3, confidence: 5, leverage: 3, locality: 5, testability: 5, blast_radius: 3, regression_risk: 2, human_decision_risk: 1 },
      ria: { ria_dimensions: ["correctness"], defect_class: "logic-error", ria_proof: { failure_predicate: { predicate_id: "correctness:logic-error:toCents-floor", statement: "toCents(0.29) returns 28, expected 29" }, input_binding: binding, proofs: [reproduction("correctness:logic-error:toCents-floor", money, "repro/money.repro.js")] } },
    }),
    row("integrity:SEC-001", {
      title: "Order reads skip the ownership check",
      lane_sources: ["security-and-production-safety"], summary: "canReadOrder lets any authenticated requester read any order.", root_cause: "The authorization check tests authentication only and never compares requester.id with order.ownerId.",
      evidence: [{ file: "src/access.js", line: 2, observation: "return Boolean(requester && requester.authenticated);" }], scores: { severity: variant.securitySeverity ?? 4, confidence: 5, leverage: 4, locality: 5, testability: 5, blast_radius: 4, regression_risk: 2, human_decision_risk: 2 },
      ria: { ria_dimensions: ["security"], defect_class: "security-exposure", ria_proof: { failure_predicate: { predicate_id: "security:security-exposure:order-owner-check", statement: "A fake authenticated user can read another fake user's order." }, input_binding: binding, proofs: [reproduction("security:security-exposure:order-owner-check", access, "repro/access.repro.js")] } },
    }),
    // Integrity adopts Health's contract-drift finding under its original id (§6.4 adoption).
    row("CONTRACT-001", {
      title: "Order contract copies disagree on the quantity field",
      lane_sources: ["contracts-and-integration"], summary: "The server order schema names the field qty while the client copy names it quantity.", root_cause: "Two hand-maintained copies of one contract with no shared source or equivalence check.",
      evidence: [{ file: "src/api/order-schema.js", line: 2, observation: "fields include qty" }, { file: "src/client/order-schema.js", line: 2, observation: "fields include quantity" }], scores: { severity: 3, confidence: 5, leverage: 4, locality: 4, testability: 5, blast_radius: 3, regression_risk: 2, human_decision_risk: 2 },
      ria: { ria_dimensions: ["contracts"], defect_class: "contract-drift", ria_proof: contractProof(binding), candidate_lifecycle: { candidate_id: "CONTRACT-001", discovered_by: "repository-health-assessment", current_owner: { skill: "codebase-integrity-audit-loop", stage: "verify" }, lifecycle_status: "verifying", history: [{ event: "discovered", timestamp: "2026-10-16T00:00:00Z", artifact: "health-assessment:appendix-a" }], completion: { completed_at: null, verification_refs: [] }, resolution: { superseded_by: null, reason: null } } },
    }),
  ];
  const surface = (surface_id, criticality_weight, state, quality, refs, reason = null) => ({ surface_id, criticality_weight, state, evidence_quality: state === "not-applicable" || state === "uninspected" ? "none" : quality, methods: state === "inspected" || state === "sampled" ? ["direct file inspection"] : [], scope: state === "inspected" || state === "sampled" ? `${surface_id} at the assessed revision` : surface_id === "data-lifecycle" || state === "not-applicable" ? `${surface_id} at the assessed revision` : "", evidence_refs: refs, reason, weight_rationale: null });
  const negative = (id, statement, surfaces, checks) => ({ negative_claim_id: id, statement, search_scope: surfaces.map((item) => `surface:${item}`), search_methods: [...checks.map((item) => `defect-check:${item}`), "direct inspection of every matching file"], evidence_quality: "strong", coverage: { state: "inspected", scope: "every tracked source file at the assessed revision", methods: ["bounded-exhaustive file inventory", "direct inspection"], limitations: [] }, sources: [{ kind: "path", ref: "src/money.js" }, { kind: "path", ref: "src/access.js" }, { kind: "inventory", ref: "tracked src/ file list at the assessed revision" }], exclusions: [], search_completeness: "bounded-exhaustive", supports_absence: true, confidence: { level: "high", rationale: "The finite source surface was enumerated and inspected." }, limitations: [] });
  const sampledOnly = variant.reliabilitySampledWithoutNegativeClaim === true;
  const coverage = {
    schema_version: "integrity.coverage@2",
    dimensions: {
      correctness: { surfaces: [surface("runtime-code", 5, "inspected", "strong", [{ kind: "path", ref: "src/money.js" }, { kind: "candidate", ref: "integrity:CORR-001" }]), surface("domain-libraries", 4, "inspected", "strong", [{ kind: "path", ref: "src/money.js" }]), surface("data-lifecycle", 4, "not-applicable", "none", [], "The fixture stores no data.")], negative_claims: [] },
      contracts: { surfaces: [surface("contracts-and-wiring", 5, "inspected", "strong", [{ kind: "path", ref: "src/api/order-schema.js" }, { kind: "path", ref: "src/client/order-schema.js" }, { kind: "candidate", ref: "CONTRACT-001" }]), surface("generated-surfaces", 2, "not-applicable", "none", [], "No generated code exists.")], negative_claims: [] },
      security: { surfaces: [surface("runtime-code", 5, "inspected", "strong", [{ kind: "path", ref: "src/access.js" }, { kind: "candidate", ref: "integrity:SEC-001" }]), surface("contracts-and-wiring", 5, "inspected", "strong", [{ kind: "path", ref: "src/api/order-schema.js" }]), surface("specialized-paths", 3, "not-applicable", "none", [], "No specialized execution paths.")], negative_claims: [] },
      reliability: sampledOnly
        ? { surfaces: [surface("runtime-code", 5, "sampled", "moderate", [{ kind: "path", ref: "src/money.js" }]), surface("operational-behavior", 3, "not-applicable", "none", [], "No runtime entrypoint or service.")], negative_claims: [] }
        : { surfaces: [surface("runtime-code", 5, "inspected", "strong", [{ kind: "path", ref: "src/money.js" }, { kind: "path", ref: "src/access.js" }]), surface("operational-behavior", 3, "not-applicable", "none", [], "No runtime entrypoint or service.")], negative_claims: [negative("INT-N-REL-001", "No failure-handling or concurrency defect exists in the fixture's source.", ["runtime-code"], ["failure-handling", "concurrency"])] },
    },
  };
  return { spine_version: 3, coverage, candidates, reproductions: { money, access } };
}

/** Two strong, line-bound observations of the same contract-drift predicate (§7.2 observed). */
function contractProof(binding) {
  const predicate = "contracts:contract-drift:order-quantity-field";
  const keys = [codeKey(binding, "src/api/order-schema.js", [2, 2]), codeKey(binding, "src/client/order-schema.js", [2, 2])];
  return { failure_predicate: { predicate_id: predicate, statement: "The api and client order contracts name the quantity field differently." }, input_binding: binding, proofs: keys.map((key) => ({ kind: "observation", predicate_id: predicate, binding, quality: "strong", evidence_key: key, confirmed: `${key.path}:2 lists the quantity field as ${key.path.includes("api") ? "qty" : "quantity"}.` })) };
}

/* ------------------------------ Architecture ------------------------------ */

function architectureInput({ root, envelope }) {
  const binding = bindingOf(envelope);
  const tag = (id) => `architecture-fitness:${id}`;
  const claim = (claim_id, statement, status, quality, sources, supports, coverageState = "inspected") => ({
    claim_id, statement, epistemic_status: status, evidence_quality: quality,
    coverage: { state: coverageState, scope: "tracked src/ modules and their require edges", methods: ["direct file inspection", "require-graph inspection"], limitations: coverageState === "sampled" ? ["Representative modules only."] : [] },
    sources, confidence: { level: status === "confirmed" ? "high" : "medium", rationale: status === "confirmed" ? "Directly visible in the source at the assessed revision." : "Reasoned from the inspected modules." },
    supports: supports.map(tag), contradiction_refs: [], limitations: [],
  });
  const packet = {
    evidence_packet_version: 1, packet_id: "ICA-ER-APPENDIX-A",
    producer: { skill: "architecture-improvement-intelligence", run_id: "ica-appendix-a", mode: "inline", created_at: "2026-10-16T00:00:00Z" },
    scope: { claim_or_question: "Which structural properties of the fixture's modules support each fitness score?", objective: "Bind every scored fitness dimension to inspected claims.", required_completeness: "targeted", included_surfaces: [{ surface_id: "src-modules", description: "Tracked src/ modules and require edges." }], excluded_surfaces: [] },
    coverage_plan: { source_classes: ["code"], independent_surfaces: ["src-modules"], contradiction_risk: "low", false_negative_cost: "medium", cross_source_reconciliation: false, parallelizable: false, selected_mode: "inline", mode_rationale: "A few small modules; inline is sufficient." },
    claims: [
      claim("ICA-C-001", "src/a.js and src/b.js require each other: a dependency cycle between two modules.", "confirmed", "strong", [{ kind: "line", ref: "src/a.js:1" }, { kind: "line", ref: "src/b.js:1" }], ["dependency_direction_cycle_control", "boundary_integrity", "cohesion_locality"]),
      claim("ICA-C-002", "The order contract exists as two hand-maintained copies with diverging field names.", "confirmed", "strong", [{ kind: "line", ref: "src/api/order-schema.js:2" }, { kind: "line", ref: "src/client/order-schema.js:2" }], ["interface_contract_clarity", "duplication_competing_implementations"]),
      claim("ICA-C-003", "State is owned by single modules; no module mutates another's exports.", "confirmed", "strong", [{ kind: "path", ref: "src/money.js" }, { kind: "path", ref: "src/math.js" }], ["state_data_ownership"]),
      claim("ICA-C-004", "Small modules keep most changes local, but only add() has a test seam exercised.", "inferred", "moderate", [{ kind: "path", ref: "test/math.test.js" }, { kind: "path", ref: "src/access.js" }], ["change_containment_evolvability", "architectural_testability_observability"], "sampled"),
    ],
    negative_claims: [], contradictions: [],
    handoff: { safe_to_assume: ["ICA-C-001", "ICA-C-002", "ICA-C-003"], unresolved_facts: ["ICA-C-004"], owner_intent_required: [], possible_decision_surfaces: [], consumer_notes: ["Appendix A fixture assessment."] },
    lane_receipts: [],
  };
  const stored = writeEvidencePacketForRepository(root, packet, { owner: "architecture-improvement-intelligence" });
  const q = (id) => `evidence-recon:${stored.sha256}#${id}`;
  const dim = (score, claimId) => ({ score, state: "scored", evidence_refs: [q(claimId)] });
  const input = {
    schema_version: 2, run_id: "ica-appendix-a", repository_revision: binding.revision,
    scope: { objective: "Assess structural fitness of the Appendix A fixture.", included: ["."], excluded: [], mutation_posture: "read-only" },
    evidence_packet_refs: [packetRefFor(stored.path, binding)],
    coverage_receipt: { architecture_sweep_complete: true, final_adversarial_sweep_complete: true, lens_dispositions: { authority: "candidate ICA-001", locality: "no candidate: modules are small", migration: "not-applicable: no public migration surface" } },
    candidates: [{
      candidate_id: "ICA-001", title: "Break the src/a.js ⇄ src/b.js require cycle", transformation_kind: "dependency_inversion",
      structural_problem: "Two modules require each other, so neither can load or be tested alone.", evidence_refs: [q("ICA-C-001")],
      current_state: "a.js requires b.js and b.js requires a.js.", proposed_state: "Move the shared base() into its own module that both depend on.",
      authority_before: "a.js + b.js", authority_after: "base module", interface_change: "b.js imports base from the new module.", locality_gain: "Each module loads independently.", leverage_gain: "Removes the only cycle.",
      complexity_destination: "A third, tiny module holds the shared function.", deletion_test: "Removing the back-edge leaves both modules working.", simpler_alternative: "Inline base() into b.js; rejected because a.js also uses it.",
      risks: ["None beyond the two files."], compatibility: [], migration: [], verification_obligations: ["A require-graph check proving no cycle remains."],
      critic: { outcome: "eligible", hard_failures: [], unresolved_questions: [] }, ledger_candidate_ref: "ICA-001", unresolved_decisions: [], disposition: "ready_for_integrity_loop",
    }],
    performance_receipt: { profile: "aggressive-threadpool-v2", planned_tasks: 3, peak_concurrency: 1 },
    proposed_domain_updates: [], proposed_adr_updates: [],
    architecture_fitness: {
      schema_version: "architecture.fitness@2", confidence: 0.85,
      dimensions: {
        boundary_integrity: dim(60, "ICA-C-001"), dependency_direction_cycle_control: dim(35, "ICA-C-001"), cohesion_locality: dim(70, "ICA-C-001"),
        interface_contract_clarity: dim(50, "ICA-C-002"), state_data_ownership: dim(85, "ICA-C-003"), change_containment_evolvability: dim(70, "ICA-C-004"),
        duplication_competing_implementations: dim(55, "ICA-C-002"), architectural_testability_observability: dim(45, "ICA-C-004"),
      },
    },
  };
  return { input, packet_path: stored.path, packet_sha256: stored.sha256 };
}

module.exports = { FILES, COMMITS, VERIFICATION_COMMAND, buildAppendixARepo, healthIsland, integrityLedger, architectureInput, runReproduction };
