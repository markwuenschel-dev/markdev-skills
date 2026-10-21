"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const child = require("node:child_process");
const fitness = require("./architecture-fitness.js");
const { createOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const ids = ["boundary_integrity", "dependency_direction_cycle_control", "cohesion_locality", "interface_contract_clarity", "state_data_ownership", "change_containment_evolvability", "duplication_competing_implementations", "architectural_testability_observability"];
const revision = "abc1234";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function v2() { return { schema_version: "architecture.fitness@2", confidence: 0.9, dimensions: Object.fromEntries(ids.map(id => [id, { score: 80, state: "scored" }])) }; }
function scratch(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-v2-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
/** RIA mode binds every scored fitness dimension to stored packet claims
 * (architecture.evidence-binding@1). The scratch root is not a Git repository, so cited
 * sources are read from its working tree; the packet lives under RIA_RUNTIME_ROOT. */
function bindEvidence(root, value, envelope) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "owner.js"), "module.exports = { state: 1 };\nmodule.exports.read = () => module.exports.state;\n");
  const bytes = Buffer.from(fs.readFileSync(path.join(__dirname, "canonical-ria-evidence-packet.json"), "utf8").replaceAll("__ARCH_SOURCE_PATH__", "src/owner.js"));
  const packetPath = path.join(root, "evidence", `${hash(bytes)}.json`);
  fs.mkdirSync(path.dirname(packetPath), { recursive: true }); fs.writeFileSync(packetPath, bytes);
  const binding = require("./architecture-evidence-binding.js");
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, "architecture-candidate-set.ria.example.json"), "utf8").replaceAll("__ARCH_PACKET_SHA256__", hash(bytes)));
  value.evidence_packet_refs = [binding.packetRefFor(packetPath, binding.bindingFromEnvelope(envelope))];
  value.scope = template.scope;
  value.candidates = template.candidates;
  for (const id of ids) value.architecture_fitness.dimensions[id].evidence_refs = template.architecture_fitness.dimensions[id].evidence_refs;
}
function setup(t) {
  const root = scratch(t);
  const value = JSON.parse(fs.readFileSync(path.join(__dirname, "architecture-candidate-set.example.json"), "utf8"));
  value.repository_revision = revision; value.architecture_fitness = v2();
  const envelope = { baseline_ref: { artifact_id: "baseline:fixture", sha256: "a".repeat(64), repository_revision: revision }, engineering_intelligence_ref: { artifact_id: "ei:fixture" }, presentation_policy: "inherit" };
  bindEvidence(root, value, envelope);
  const input = path.join(root, "input.json"), echo = path.join(root, "envelope.json"), output = path.join(root, "output", "architecture.json"), returnOut = path.join(root, "return", "owner.json");
  fs.writeFileSync(echo, JSON.stringify(envelope));
  function write(options = {}) {
    fs.writeFileSync(input, JSON.stringify(value));
    return child.spawnSync(process.execPath, [path.join(__dirname, "write-candidate-set.js"), "--input", input, "--repo", root, "--output", output, "--ria-envelope", echo, "--return-out", returnOut, ...(options.args || [])], { encoding: "utf8", env: { ...process.env, RIA_RUNTIME_ROOT: root } });
  }
  return { root, value, envelope, output, returnOut, write };
}
test("@2 preserves missing-state metadata and scored zero through normalization", () => {
  const input = v2();
  input.dimensions.boundary_integrity = { score: null, state: "unavailable", reason_code: "NOT_INSPECTED", detail: "Boundary evidence unavailable." };
  input.dimensions.architectural_testability_observability.score = 0;
  const result = fitness.normalizeArchitectureFitness(input);
  assert.equal(result.schema_version, "architecture.fitness@2");
  assert.deepEqual(result.dimensions.boundary_integrity, input.dimensions.boundary_integrity);
  assert.equal(result.dimensions.architectural_testability_observability.score, 0);
  assert.equal(result.coverage, 0.8);
  assert.equal(result.score, 75); // (75 * 80 + 5 * 0) / 80
  assert.deepEqual(fitness.normalizeArchitectureFitness(result), result);
  assert.deepEqual(input.dimensions.boundary_integrity, { score: null, state: "unavailable", reason_code: "NOT_INSPECTED", detail: "Boundary evidence unavailable." });
});
test("@1 read migration retains score and coverage without changing stored bytes", t => {
  const root = scratch(t), target = path.join(root, "legacy.json");
  const legacy = { schema_version: "architecture.fitness@1", confidence: 0.6, dimensions: Object.fromEntries(ids.map(id => [id, 80])) };
  legacy.dimensions.state_data_ownership = null;
  fs.writeFileSync(target, JSON.stringify(legacy)); const before = fs.readFileSync(target);
  const migrated = fitness.readArchitectureFitness(JSON.parse(before));
  assert.equal(migrated.schema_version, "architecture.fitness@2"); assert.equal(migrated.score, 80); assert.equal(migrated.coverage, 0.9);
  assert.deepEqual(migrated.dimensions.state_data_ownership, { score: null, state: "unavailable", reason_code: "LEGACY_NULL", detail: "Legacy architecture fitness has no score for this dimension." });
  assert.deepEqual(migrated.dimensions.boundary_integrity, { score: 80, state: "scored" });
  assert.deepEqual(fs.readFileSync(target), before);
});
for (const [name, mutate] of [
  ["missing dimension", value => { delete value.dimensions.boundary_integrity; }],
  ["extra dimension", value => { value.dimensions.typo = { score: 100, state: "scored" }; }],
  ["extra dimension field", value => { value.dimensions.boundary_integrity.typo = true; }],
  ["null scored value", value => { value.dimensions.boundary_integrity.score = null; }],
  ["unavailable numeric value", value => { value.dimensions.boundary_integrity = { score: 0, state: "unavailable", reason_code: "NO_DATA", detail: "Unavailable." }; }],
  ["empty reason", value => { value.dimensions.boundary_integrity = { score: null, state: "unavailable", reason_code: " ", detail: "Unavailable." }; }],
  ["empty detail", value => { value.dimensions.boundary_integrity = { score: null, state: "unavailable", reason_code: "NO_DATA", detail: " " }; }],
  ["unbound NA", value => { value.dimensions.boundary_integrity = { score: null, state: "not_applicable", reason_code: "NO_SURFACE", detail: "No surface." }; }],
  ["score above range", value => { value.dimensions.boundary_integrity.score = 101; }],
  ["numeric string score", value => { value.dimensions.boundary_integrity.score = "80"; }],
  ["unknown version", value => { value.schema_version = "architecture.fitness@9"; }],
  ["null version", value => { value.schema_version = null; }],
]) test(`@2 rejects ${name}`, () => { const input = v2(); mutate(input); assert.throws(() => fitness.normalizeArchitectureFitness(input), /FAIL-ARCHITECTURE-FITNESS/); });
for (const confidence of [-0.1, 1.1, 90, "0.9", true, Infinity]) test(`rejects invalid confidence ${String(confidence)}`, () => {
  assert.throws(() => fitness.normalizeArchitectureFitness({ ...v2(), confidence }), /FAIL-ARCHITECTURE-FITNESS/);
});
for (const [field, value] of [
  ["score", true], ["score", "80"], ["score", -1], ["score", 101], ["score", Infinity],
  ["grade", true], ["grade", 80], ["grade", "UNKNOWN"],
  ["coverage", null], ["coverage", -0.1], ["coverage", 1.1], ["coverage", "0.8"], ["coverage", Infinity],
  ["weights", null], ["weights", []], ["weights", 20], ["weights", "invalid"],
]) test(`@2 rejects malformed declared ${field}: ${String(value)}`, () => {
  assert.throws(() => fitness.normalizeArchitectureFitness({ ...v2(), [field]: value }), /FAIL-ARCHITECTURE-FITNESS/);
});
test("valid declared aggregates are recomputed from dimensions without changing arithmetic", () => {
  const result = fitness.normalizeArchitectureFitness({ ...v2(), score: 0, grade: "F", coverage: 0, weights: {} });
  assert.equal(result.score, 80); assert.equal(result.grade, "B-"); assert.equal(result.coverage, 1);
  assert.equal(result.weights.boundary_integrity, 20);
});
test("@2 accepts a justified NA dimension and retains its evidence refs", () => {
  const input = v2();
  input.dimensions.boundary_integrity = { score: null, state: "not_applicable", reason_code: "NO_BOUNDARIES", detail: "Inventory confirms this surface is absent.", evidence_refs: ["src/main.js:1-8"] };
  assert.deepEqual(fitness.normalizeArchitectureFitness(input).dimensions.boundary_integrity, input.dimensions.boundary_integrity);
});
test("mapped coverage cannot borrow unrelated scored fitness dimensions", () => {
  const input = v2();
  input.dimensions.boundary_integrity = { score: null, state: "unavailable", reason_code: "NO_ACCESS", detail: "Boundary not inspected." };
  assert.equal(fitness.normalizeArchitectureFitness(input).coverage, 0.8);
  const mapped = fitness.mappedFitnessSummary(input, ["boundary_integrity", "dependency_direction_cycle_control", "cohesion_locality"]);
  assert.equal(mapped.coverage, 0.6); assert.equal(mapped.score, 80); assert.equal(mapped.complete, false);
  assert.deepEqual(fitness.mappedFitnessSummary(input, ["boundary_integrity"]), { score: null, coverage: 0, confidence: 0.9, complete: false });
});
test("writer, artifact, owner validator and report reader retain @2 metadata", t => {
  const f = setup(t);
  f.value.architecture_fitness.dimensions.boundary_integrity = { score: null, state: "unavailable", reason_code: "NOT_INSPECTED", detail: "Evidence unavailable." };
  const result = f.write(); assert.equal(result.status, 0, result.stderr);
  const returned = JSON.parse(fs.readFileSync(f.returnOut)), artifactBytes = fs.readFileSync(f.output), stored = JSON.parse(artifactBytes);
  assert.equal(returned.file_sha256, hash(artifactBytes));
  assert.deepEqual(stored.architecture_fitness.dimensions.boundary_integrity, f.value.architecture_fitness.dimensions.boundary_integrity);
  const { validateArchitectureOwnerReturn } = require("./architecture-owner-return.js");
  assert.equal(validateArchitectureOwnerReturn(returned, { repository_revision: revision, input_binding_echo: f.envelope }).ok, true);
  const { buildReportData, readJson } = require("../../repository-improvement-assessment/scripts/report-model.js");
  const skills = path.resolve(__dirname, "..", "..");
  const healthPath = path.join(skills, "repository-health-assessment/assets/canonical-island.json"), integrityPath = path.join(skills, "shared/candidate-ledger-spine/canonical-ledger.json");
  const request = { repository: { name: "fixture", revision }, mode: "read-only", baseline_ref: f.envelope.baseline_ref,
    assessment_refs: [["repository-health-assessment", "health-assessment", healthPath], ["codebase-integrity-audit-loop", "integrity-ledger", integrityPath], ["architecture-improvement-intelligence", "architecture-assessment", f.output]].map(([owner,prefix,file]) => ({ owner, artifact_id: `${prefix}:${hash(fs.readFileSync(file))}`, sha256: hash(fs.readFileSync(file)), repository_revision: revision })),
    report_election: { schema_version: 1, policy: "generate", lean: "generate", reason: "fixture", state: "elected-generate", report_owner: null },
    performance_receipt: require("../../repository-improvement-assessment/scripts/performance-receipt.js").unavailablePerformanceReceipt("fixture", "NO_EXECUTOR_TELEMETRY") };
  const data = buildReportData({ request, healthFile: readJson(healthPath, "health"), integrityFile: readJson(integrityPath, "integrity"), architectureFile: readJson(f.output, "architecture"), skillRoot: path.join(skills, "repository-improvement-assessment"), fixture: true });
  assert.deepEqual(data.analytics.architecture.fitness.dimensions.boundary_integrity, f.value.architecture_fitness.dimensions.boundary_integrity);
  assert.deepEqual(fs.readFileSync(f.output), artifactBytes);
  stored.architecture_fitness.dimensions.boundary_integrity = { score: 100, state: "unavailable" };
  const badBytes = Buffer.from(JSON.stringify(stored)); fs.writeFileSync(f.output, badBytes);
  const rebound = createOwnerReturn({ ...returned, canonical_artifact_ref: { ...returned.canonical_artifact_ref, sha256: hash(badBytes), artifact_id: `architecture-assessment:${hash(badBytes)}` } });
  assert.equal(validateArchitectureOwnerReturn(rebound).ok, false, "valid hash cannot bless invalid fitness");
});
for (const [name, mutate, code] of [
  ["missing fitness", v => { delete v.architecture_fitness; }, "FAIL-ARCHITECTURE-FITNESS-REQUIRED"],
  ["legacy fitness", v => { v.architecture_fitness = { confidence: 0.9, dimensions: Object.fromEntries(ids.map(id => [id, 80])) }; }, "FAIL-ARCHITECTURE-FITNESS-REQUIRED"],
  ["both outcomes", v => { v.architecture_fitness_unavailable = { reason_code: "NO_ACCESS", detail: "No evidence access." }; }, "FAIL-ARCHITECTURE-FITNESS-REQUIRED"],
  ["revision mismatch", v => { v.repository_revision = "different"; }, "RIA_ENVELOPE_REVISION_MISMATCH"],
  ["invalid confidence", v => { v.architecture_fitness.confidence = 90; }, "FAIL-ARCHITECTURE-FITNESS"],
  ["malformed aggregate score", v => { v.architecture_fitness.score = true; }, "FAIL-ARCHITECTURE-FITNESS"],
  ["malformed aggregate grade", v => { v.architecture_fitness.grade = 80; }, "FAIL-ARCHITECTURE-FITNESS"],
  ["malformed aggregate coverage", v => { v.architecture_fitness.coverage = null; }, "FAIL-ARCHITECTURE-FITNESS"],
  ["malformed aggregate weights", v => { v.architecture_fitness.weights = null; }, "FAIL-ARCHITECTURE-FITNESS"],
  ["invalid unavailable", v => { delete v.architecture_fitness; v.architecture_fitness_unavailable = { reason_code: "NO_ACCESS", detail: " " }; }, "FAIL-ARCHITECTURE-FITNESS"],
]) test(`RIA writer rejects ${name} before creating outputs`, t => {
  const f = setup(t); mutate(f.value); const result = f.write();
  assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(code));
  assert.equal(fs.existsSync(path.dirname(f.output)), false); assert.equal(fs.existsSync(path.dirname(f.returnOut)), false);
});
test("RIA writer accepts explicit whole-fitness unavailability", t => {
  const f = setup(t); delete f.value.architecture_fitness;
  f.value.architecture_fitness_unavailable = { reason_code: "NO_ACCESS", detail: "Repository evidence was unavailable." };
  const result = f.write(); assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(fs.readFileSync(f.output)); assert.deepEqual(stored.architecture_fitness_unavailable, f.value.architecture_fitness_unavailable);
  assert.equal("architecture_fitness" in stored, false);
  assert.equal(require("./architecture-owner-return.js").validateArchitectureOwnerReturn(JSON.parse(fs.readFileSync(f.returnOut))).ok, true);
});
