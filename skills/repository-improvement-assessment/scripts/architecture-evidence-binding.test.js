"use strict";

// architecture.evidence-binding@1 (composite-scoring-v3 §5.2, §6.1–§6.3; Phase 7b, the
// prerequisite to Phase 8). Exercised writer -> stored packet -> RIA resolution on a real
// stock run: the Architecture writer binds packet bytes, RIA's owner-artifact verification
// re-resolves them on every run (fresh, continue, report-only), and each adversarial case
// changes exactly one thing in otherwise valid, correctly hashed inputs.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { executeRia, verifyArchitectureEvidence } = require("./ria.js");
const stockAdapter = require("./test-support/ria-stock-adapter.js");
const { architectureRiaInput } = require("./test-support/architecture-ria-fixture.js");
const { deriveCompatibilityBinding } = require("./compatibility-binding.js");
const { contributionDependence } = require("../../shared/ria-scoring/evidence-model.js");

const SKILLS = path.resolve(__dirname, "..", "..");
const WRITER = path.join(SKILLS, "architecture-improvement-intelligence", "assets", "write-candidate-set.js");
const ARCHITECTURE = "architecture-improvement-intelligence";
const DIMENSIONS = ["boundary_integrity", "dependency_direction_cycle_control", "cohesion_locality", "interface_contract_clarity", "state_data_ownership", "change_containment_evolvability", "duplication_competing_implementations", "architectural_testability_observability"];
// Hand-authored factors and threshold for the independence oracle; not the production config.
const FACTORS = { strong: 1, moderate: 0.5, weak: 0.25 };

function git(root, args) { return childProcess.execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" }).trim(); }
function compatibility() { return deriveCompatibilityBinding({ engine_version: "sei-stock-integration@1", effective_configuration: { evidence: "bounded" }, execution_contract: { version: 1 }, history_window: { kind: "full" }, assessment_schema_version: "sei.engineering-assessment@3", analyzer_capabilities: {} }); }
function request(root, extra = {}) { return { repository: { root }, durable_mode: "git", command_authorization: { state: "granted", authorization_ref: "binding-test", inherited_from: null, commands: ["node-version"] }, verification_contract: { commands: ["node-version"], isolation: "read-only-source" }, sei_compatibility_binding: compatibility(), runtime_root: path.join(root, ".project-intelligence", "assessments", "ria", "binding-test"), presentation_policy: "skip", depth: "quick", ...extra }; }
function verification(result) { return result.execution.task_results["owner-artifact-verification"]; }
function failureText(result) { return JSON.stringify([result.execution.failures, result.execution.degraded_failures, result.execution.observational_failures]); }

let fixture = null;
async function run(context) {
  if (fixture) return fixture;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ria-arch-binding-"));
  process.on("exit", () => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} });
  const root = path.join(sandbox, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "src", "owner.js"), "module.exports = { state: 1 };\nmodule.exports.read = () => module.exports.state;\n");
  fs.writeFileSync(path.join(root, "src", "route.js"), "const owner = require('./owner.js');\nmodule.exports = () => owner.read();\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "fixture"]);
  const fresh = await executeRia(request(root), stockAdapter);
  assert.equal(fresh.status, "complete", failureText(fresh));
  const runDirectory = path.dirname(fresh.state_path);
  const envelope = JSON.parse(fs.readFileSync(path.join(runDirectory, "owner-inputs", `${ARCHITECTURE}-envelope.json`), "utf8"));
  const revision = git(root, ["rev-parse", "HEAD"]);
  const receipt = verification(fresh).architecture_evidence;
  fixture = { sandbox, root, fresh, envelope, revision, receipt, baseline: { repository: { roots: [{ root, revision, head_revision: revision }] } }, runtime_root: request(root).runtime_root };
  return fixture;
}
function writeArchitecture(fx, input) {
  const scratch = fs.mkdtempSync(path.join(fx.sandbox, "writer-"));
  const inputPath = path.join(scratch, "input.json"); fs.writeFileSync(inputPath, JSON.stringify(input));
  const envelopePath = path.join(scratch, "envelope.json"); fs.writeFileSync(envelopePath, JSON.stringify(fx.envelope));
  const out = childProcess.spawnSync(process.execPath, [WRITER, "--input", inputPath, "--repo", fx.root, "--ria-envelope", envelopePath], { encoding: "utf8", env: { ...process.env, RIA_RUNTIME_ROOT: fx.runtime_root } });
  return { ...out, ownerReturn: out.status === 0 ? JSON.parse(out.stdout) : null };
}
function rejects(fx, input, pattern) {
  const out = writeArchitecture(fx, input);
  assert.notEqual(out.status, 0, `writer accepted: ${out.stdout}`);
  assert.match(out.stderr, pattern);
}
function consume(fx, ownerReturn) { return verifyArchitectureEvidence(ownerReturn, fx.envelope, fx.baseline, { runtime_root: fx.runtime_root }); }
/** Stores an artifact the writer would reject, as a bypassing producer would, and returns its owner return. */
function bypassArtifact(fx, value) {
  const file = path.join(fs.mkdtempSync(path.join(fx.sandbox, "bypass-")), "architecture.json"); fs.writeFileSync(file, JSON.stringify(value));
  return { owner: ARCHITECTURE, artifact_path: file };
}

test("a fresh stock run binds every scored fitness dimension to resolved packet facts", async (context) => {
  const fx = await run(context);
  const receipt = fx.receipt;
  assert.equal(receipt.schema_version, "architecture.evidence-binding@1");
  assert.equal(receipt.mode, "consume");
  assert.deepEqual(receipt.withheld, []);
  assert.deepEqual(receipt.binding, { repository_id: fx.envelope.baseline_ref.artifact_id, root_id: "root-0", revision: fx.revision });
  assert.deepEqual(receipt.source_snapshot, { kind: "git", revision: fx.revision });
  assert.equal(receipt.packets.length, 1); assert.equal(receipt.packets[0].status, "bound");
  for (const id of DIMENSIONS) assert.ok(receipt.dimensions[id].facts.length > 0, `${id} has facts`);
  // ICA-C-001 cites src/owner.js (whole file) and src/owner.js:1 — two code keys, strong, original.
  const boundary = receipt.dimensions.boundary_integrity.facts;
  assert.deepEqual(boundary.map((fact) => fact.key).sort(), [`code:${fx.envelope.baseline_ref.artifact_id}:root-0:${fx.revision}:src/owner.js:[*]`, `code:${fx.envelope.baseline_ref.artifact_id}:root-0:${fx.revision}:src/owner.js:[1,1]`].sort());
  assert.ok(boundary.every((fact) => fact.quality === "strong" && fact.origin === "original"));
  // ICA-C-003 is inferred with sampled coverage: capped at moderate whatever the packet says.
  assert.ok(receipt.dimensions.change_containment_evolvability.facts.every((fact) => fact.quality === "moderate"));
  assert.ok(receipt.candidates["ICA-001"].facts.length > 0, "candidate refs resolve too");
});

test("fork 2: strong original evidence on the dimension is independent; moderate-only is not", async (context) => {
  const fx = await run(context);
  // Oracle by hand: boundary has 2 strong original facts -> A = 0, O = 2, ratio 0 < 0.5, strong original present.
  const strong = contributionDependence({ owner: "architecture", dimension: "architecture", facts: fx.receipt.dimensions.boundary_integrity.facts, factors: FACTORS, threshold: 0.5 });
  assert.equal(strong.classification, "independent"); assert.equal(strong.original_strength, 2); assert.equal(strong.adopted_strength_ratio, 0);
  // Testability cites only the moderate ICA-C-003: O = 2 x 0.5 = 1, but no strong original fact and no scored origin.
  const moderate = contributionDependence({ owner: "architecture", dimension: "verification", facts: fx.receipt.dimensions.architectural_testability_observability.facts, factors: FACTORS, threshold: 0.5 });
  assert.equal(moderate.original_strength, 1);
  assert.equal(moderate.classification, "insufficient_evidence", "moderate original facts count in O but cannot alone pass the strong-original gate");
});

test("continue and report-only runs re-resolve the packet instead of reusing a cached verdict", async (context) => {
  const fx = await run(context);
  const again = await executeRia(request(fx.root, { lifecycle: "report-only" }), stockAdapter);
  assert.equal(again.status, "complete", failureText(again));
  assert.ok(again.execution.events.some((event) => event.task_id === "owner-artifact-verification" && event.status === "completed"), "verification executed, not reused");
  assert.ok(again.execution.events.some((event) => event.task_id === "owner-architecture" && event.status === "reused"), "the Architecture artifact itself was reused");
  assert.deepEqual(verification(again).architecture_evidence, fx.receipt);
});

test("tampered packet bytes block report-only and continue runs; a missing packet stays missing evidence", async (context) => {
  const fx = await run(context);
  const packetPath = fx.receipt.packets[0] && JSON.parse(fs.readFileSync(fx.fresh.execution.task_results["owner-artifact-verification"].owner_artifacts[ARCHITECTURE].artifact_path, "utf8")).evidence_packet_refs[0].path;
  const original = fs.readFileSync(packetPath);
  try {
    fs.writeFileSync(packetPath, Buffer.concat([original, Buffer.from(" ")]));
    const reportOnly = await executeRia(request(fx.root, { lifecycle: "report-only" }), stockAdapter);
    assert.notEqual(reportOnly.status, "complete");
    assert.match(failureText(reportOnly), /FAIL-RIA-ARCHITECTURE-EVIDENCE: FAIL-ARCHITECTURE-EVIDENCE-HASH-MISMATCH/);
    const resumed = await executeRia(request(fx.root, { lifecycle: "continue", state_path: fx.fresh.state_path }), stockAdapter);
    assert.notEqual(resumed.status, "complete");
    assert.match(failureText(resumed), /FAIL-ARCHITECTURE-EVIDENCE-HASH-MISMATCH/);
    // allow_degraded is its own plan: run it clean, then tamper and continue it.
    fs.writeFileSync(packetPath, original);
    const degradedFresh = await executeRia(request(fx.root, { allow_degraded: true }), stockAdapter);
    assert.equal(degradedFresh.status, "complete", failureText(degradedFresh));
    fs.writeFileSync(packetPath, Buffer.concat([original, Buffer.from(" ")]));
    const degraded = await executeRia(request(fx.root, { allow_degraded: true, lifecycle: "continue", state_path: degradedFresh.state_path }), stockAdapter);
    assert.equal(degraded.status, "blocked", `tampering is never degraded into missing evidence; got ${degraded.status} ${failureText(degraded)}`);
    assert.match(failureText(degraded), /FAIL-ARCHITECTURE-EVIDENCE-HASH-MISMATCH/);
    fs.rmSync(packetPath);
    const missing = await executeRia(request(fx.root, { lifecycle: "report-only" }), stockAdapter);
    assert.equal(missing.status, "complete", failureText(missing));
    const receipt = verification(missing).architecture_evidence;
    assert.equal(receipt.packets[0].status, "unavailable");
    for (const id of DIMENSIONS) { assert.deepEqual(receipt.dimensions[id].facts, [], id); assert.match(receipt.dimensions[id].limitations.join("\n"), /packet unavailable/); }
  } finally { fs.writeFileSync(packetPath, original); }
});

test("writer -> stored packet -> RIA resolution: the writer's accepted artifact resolves identically in RIA", async (context) => {
  const fx = await run(context);
  const { input } = architectureRiaInput(fx.root, fx.envelope);
  const out = writeArchitecture(fx, input);
  assert.equal(out.status, 0, out.stderr);
  const receipt = consume(fx, out.ownerReturn);
  assert.deepEqual(receipt.dimensions, fx.receipt.dimensions);
  assert.deepEqual(receipt.withheld, []);
});

test("the writer rejects unbound, unqualified, dangling and tampered evidence", async (context) => {
  const fx = await run(context);
  const base = () => architectureRiaInput(fx.root, fx.envelope);
  let value = base().input; value.evidence_packet_refs.push("evidence-recon:example");
  rejects(fx, value, /FAIL-ARCHITECTURE-EVIDENCE-PACKET-REF[\s\S]*legacy string ref/);
  value = base().input; value.architecture_fitness.dimensions.cohesion_locality.evidence_refs = ["claim:E1"];
  rejects(fx, value, /FAIL-ARCHITECTURE-EVIDENCE-UNQUALIFIED/);
  value = base().input; delete value.architecture_fitness.dimensions.cohesion_locality.evidence_refs;
  rejects(fx, value, /FAIL-ARCHITECTURE-EVIDENCE-UNBOUND-DIMENSION: scored fitness dimension cohesion_locality/);
  const { input: dangling, packet_sha256 } = base(); dangling.architecture_fitness.dimensions.cohesion_locality.evidence_refs = [`evidence-recon:${packet_sha256}#ICA-C-404`];
  rejects(fx, dangling, /FAIL-ARCHITECTURE-EVIDENCE-DANGLING[\s\S]*ICA-C-404/);
  value = base().input; value.architecture_fitness.dimensions.cohesion_locality.evidence_refs = [`evidence-recon:${"e".repeat(64)}#ICA-C-001`];
  rejects(fx, value, /FAIL-ARCHITECTURE-EVIDENCE-DANGLING[\s\S]*packet not in evidence_packet_refs/);
  const tampered = base(); fs.appendFileSync(tampered.packet_path, " ");
  try { rejects(fx, tampered.input, /FAIL-ARCHITECTURE-EVIDENCE-HASH-MISMATCH/); }
  finally { const bytes = fs.readFileSync(tampered.packet_path); fs.writeFileSync(tampered.packet_path, bytes.subarray(0, bytes.length - 1)); }
  value = base().input; value.evidence_packet_refs[0] = { ...value.evidence_packet_refs[0], binding: { ...value.evidence_packet_refs[0].binding, revision: "0".repeat(40) } };
  rejects(fx, value, /FAIL-ARCHITECTURE-EVIDENCE-BINDING-MISMATCH/);
  const escaped = base(); const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ria-arch-outside-")), "packet.json"); fs.copyFileSync(escaped.packet_path, outside);
  escaped.input.evidence_packet_refs[0] = { ...escaped.input.evidence_packet_refs[0], path: outside };
  rejects(fx, escaped.input, /FAIL-ARCHITECTURE-EVIDENCE-PATH-ESCAPE/);
});

test("cited sources must exist at the bound revision and inside the assessed scope", async (context) => {
  const fx = await run(context);
  rejects(fx, architectureRiaInput(fx.root, fx.envelope, { sourcePath: "src/deleted.js" }).input, /FAIL-ARCHITECTURE-EVIDENCE-DANGLING[\s\S]*src\/deleted\.js, which does not exist/);
  const pastEnd = architectureRiaInput(fx.root, fx.envelope, { mutatePacket: (packet) => { packet.claims[0].sources[1].ref = "src/owner.js:2-9"; } }).input;
  rejects(fx, pastEnd, /FAIL-ARCHITECTURE-EVIDENCE-DANGLING[\s\S]*past end of file \(2 lines\)/);
  const narrow = architectureRiaInput(fx.root, fx.envelope).input; narrow.scope.included = ["docs"];
  rejects(fx, narrow, /FAIL-ARCHITECTURE-EVIDENCE-OUT-OF-SCOPE[\s\S]*outside scope\.included/);
  const excluded = architectureRiaInput(fx.root, fx.envelope).input; excluded.scope.excluded = ["src"];
  rejects(fx, excluded, /FAIL-ARCHITECTURE-EVIDENCE-OUT-OF-SCOPE[\s\S]*inside scope\.excluded/);
});

test("a packet's strong label is capped by epistemic status and coverage", async (context) => {
  const fx = await run(context);
  // Each variant declares strong; only inspected + confirmed may lend strong.
  for (const [label, edit, expected] of [
    ["inferred, inspected", (claim) => { claim.coverage = { ...claim.coverage, state: "inspected" }; }, "moderate"],
    ["confirmed, sampled", (claim) => { claim.epistemic_status = "confirmed"; }, "moderate"],
    ["confirmed, inspected", (claim) => { claim.epistemic_status = "confirmed"; claim.coverage = { ...claim.coverage, state: "inspected" }; }, "strong"],
  ]) {
    const { input } = architectureRiaInput(fx.root, fx.envelope, { mutatePacket: (packet) => { packet.claims[2].evidence_quality = "strong"; edit(packet.claims[2]); if (packet.claims[2].epistemic_status === "confirmed") { packet.handoff.unresolved_facts = []; packet.handoff.safe_to_assume.push("ICA-C-003"); } } });
    const out = writeArchitecture(fx, input);
    assert.equal(out.status, 0, out.stderr);
    const facts = consume(fx, out.ownerReturn).dimensions.change_containment_evolvability.facts;
    assert.ok(facts.length > 0 && facts.every((fact) => fact.quality === expected), `${label}: ${JSON.stringify(facts.map((fact) => fact.quality))}`);
  }
});

test("an unrelated strong citation cannot support a dimension it does not declare", async (context) => {
  const fx = await run(context);
  const { input, packet_sha256 } = architectureRiaInput(fx.root, fx.envelope);
  // ICA-C-002 is strong and confirmed, but declares contracts/state support, not boundary_integrity.
  input.architecture_fitness.dimensions.boundary_integrity.evidence_refs = [`evidence-recon:${packet_sha256}#ICA-C-002`];
  rejects(fx, input, /FAIL-ARCHITECTURE-EVIDENCE-UNSUPPORTED[\s\S]*does not declare supports "architecture-fitness:boundary_integrity"/);
  const unknown = architectureRiaInput(fx.root, fx.envelope, { mutatePacket: (packet) => { Object.assign(packet.claims[0], { epistemic_status: "unknown", confidence: { level: "low", rationale: "Not established." } }); packet.handoff.safe_to_assume = packet.handoff.safe_to_assume.filter((id) => id !== "ICA-C-001"); packet.handoff.unresolved_facts.push("ICA-C-001"); } }).input;
  rejects(fx, unknown, /FAIL-ARCHITECTURE-EVIDENCE-UNSUPPORTED[\s\S]*epistemic_status unknown/);
});

test("packet-qualified refs keep same-named claims apart and repackaged evidence stays adopted", async (context) => {
  const fx = await run(context);
  const own = architectureRiaInput(fx.root, fx.envelope);
  // A Health-produced packet reusing the same packet-local claim id, at strong quality.
  const health = architectureRiaInput(fx.root, fx.envelope, { owner: "repository-health-assessment", mutatePacket: (packet) => { packet.producer.skill = "repository-health-assessment"; packet.packet_id = "RHA-ER-RIA-001"; } });
  assert.notEqual(health.packet_sha256, own.packet_sha256);
  const input = own.input;
  input.evidence_packet_refs.push(health.packet_ref);
  input.architecture_fitness.dimensions.cohesion_locality.evidence_refs = [`evidence-recon:${health.packet_sha256}#ICA-C-001`];
  const out = writeArchitecture(fx, input);
  assert.equal(out.status, 0, out.stderr);
  const receipt = consume(fx, out.ownerReturn);
  assert.ok(receipt.dimensions.boundary_integrity.facts.every((fact) => fact.origin === "original"), "own packet's ICA-C-001");
  const adopted = receipt.dimensions.cohesion_locality.facts;
  assert.ok(adopted.length > 0 && adopted.every((fact) => fact.origin === "adopted" && fact.origin_ref === "health:RHA-ER-RIA-001"), JSON.stringify(adopted));
  const oracle = contributionDependence({ owner: "architecture", dimension: "architecture", facts: adopted, factors: FACTORS, threshold: 0.5 });
  assert.equal(oracle.adopted_strength_ratio, 1); assert.deepEqual(oracle.origin_owners, ["health"]);
  // An Architecture-produced claim citing a Health artifact is adopted too.
  const cited = architectureRiaInput(fx.root, fx.envelope, { mutatePacket: (packet) => { packet.claims[1].sources.push({ kind: "other", ref: `health-assessment:${"a".repeat(64)}`, note: "Repackaged Health claim." }); } });
  const cOut = writeArchitecture(fx, cited.input);
  assert.equal(cOut.status, 0, cOut.stderr);
  assert.ok(consume(fx, cOut.ownerReturn).dimensions.interface_contract_clarity.facts.every((fact) => fact.origin === "adopted" && fact.origin_ref.startsWith("health:")));
});

test("RIA withholds, rather than credits, evidence that bypassed the writer's policy checks", async (context) => {
  const fx = await run(context);
  const { input, packet_sha256 } = architectureRiaInput(fx.root, fx.envelope);
  input.evidence_packet_refs.push("evidence-recon:example");
  input.architecture_fitness.dimensions.boundary_integrity.evidence_refs = [`evidence-recon:${packet_sha256}#ICA-C-002`];
  input.architecture_fitness.dimensions.cohesion_locality.evidence_refs = ["claim:E1"];
  const receipt = consume(fx, bypassArtifact(fx, input));
  assert.deepEqual(receipt.dimensions.boundary_integrity.facts, []);
  assert.deepEqual(receipt.dimensions.cohesion_locality.facts, []);
  assert.ok(receipt.dimensions.dependency_direction_cycle_control.facts.length > 0, "other dimensions still resolve");
  assert.equal(receipt.withheld.length, 4, receipt.withheld.join("\n"));
  for (const code of ["PACKET-REF", "UNSUPPORTED", "UNQUALIFIED", "UNBOUND-DIMENSION"]) assert.ok(receipt.withheld.some((line) => line.includes(`FAIL-ARCHITECTURE-EVIDENCE-${code}`)), code);
  // A legacy artifact without any packet refs is missing evidence, not a failure.
  const legacy = JSON.parse(fs.readFileSync(path.join(SKILLS, ARCHITECTURE, "assets", "architecture-candidate-set.example.json"), "utf8"));
  legacy.repository_revision = fx.revision; delete legacy.evidence_packet_refs;
  const legacyReceipt = consume(fx, bypassArtifact(fx, legacy));
  assert.ok(legacyReceipt.withheld.some((line) => line.includes("FAIL-ARCHITECTURE-EVIDENCE-PACKET-REF: evidence_packet_refs must be an array")));
  assert.ok(DIMENSIONS.every((id) => legacyReceipt.dimensions[id].facts.length === 0));
  // Integrity violations still block in consume mode.
  const dangling = architectureRiaInput(fx.root, fx.envelope).input;
  dangling.architecture_fitness.dimensions.boundary_integrity.evidence_refs = [`evidence-recon:${"e".repeat(64)}#ICA-C-001`];
  assert.throws(() => consume(fx, bypassArtifact(fx, dangling)), /FAIL-RIA-ARCHITECTURE-EVIDENCE: FAIL-ARCHITECTURE-EVIDENCE-DANGLING/);
});
