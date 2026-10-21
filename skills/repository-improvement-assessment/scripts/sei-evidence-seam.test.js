"use strict";

// composite-scoring-v3 §5.3 and §12 tests 16 and 27 (instructions Phase 6), exercised
// on real bound artifacts: ria.js runs a fixture repository to the owner rendezvous,
// and every case reads or corrupts what that run actually produced.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { collectSeiCitations, readSeiEvidence, seiCitationProblems } = require("../engineering-intelligence-reader.js");
const { createOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const { verifySeiCitations } = require("./ria.js");
const { architectureRiaInput } = require("./test-support/architecture-ria-fixture.js");

const SKILLS = path.resolve(__dirname, "..", "..");
const RIA = path.join(__dirname, "ria.js");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "request.example.json"), "utf8"));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function git(root, args) { return childProcess.execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" }).trim(); }

let fixture = null;
function rendezvous(context) {
  if (fixture) return fixture;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ria-sei-seam-"));
  process.on("exit", () => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} });
  const root = path.join(sandbox, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  git(root, ["init", "-q"]);
  for (const [name, body] of [["a.js", "module.exports = require('./b.js');\n"], ["b.js", "module.exports = 1;\n"], ["c.js", "module.exports = 2;\n"]]) fs.writeFileSync(path.join(root, "src", name), body);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "one"]);
  fs.appendFileSync(path.join(root, "src", "c.js"), "// two\n"); git(root, ["commit", "-qam", "two"]);
  const request = { ...EXAMPLE, repository: { root }, verification_contract: { commands: ["node -e \"process.exit(0)\""] }, command_authorization: { ...EXAMPLE.command_authorization, commands: ["node"] }, presentation_policy: "skip" };
  const requestPath = path.join(sandbox, "request.json"); const outputPath = path.join(sandbox, "result.json");
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const run = childProcess.spawnSync(process.execPath, [RIA, "--request", requestPath, "--output", outputPath], { encoding: "utf8", timeout: 300000 });
  assert.equal(run.status, 3, run.stderr);
  const result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const runDirectory = path.dirname(result.state_path);
  const runtimeRoot = path.dirname(path.dirname(runDirectory));
  const envelope = JSON.parse(fs.readFileSync(result.owner_rendezvous.envelopes["repository-health-assessment"], "utf8"));
  const evidence = readSeiEvidence({ repository_root: root, envelope, allowed_roots: [runtimeRoot] });
  const criterion = evidence.assessment.criteria.find((item) => item.evidence.observations.length > 0);
  fixture = { sandbox, root, result, runDirectory, runtimeRoot, envelope, evidence, criterion, metric: criterion.evidence.observations[0].observation_id, revision: git(root, ["rev-parse", "HEAD"]) };
  return fixture;
}
/** Writes a structurally valid, correctly hashed variant of the bound assessment and the
 * envelope that binds it, so the only thing wrong is what the test changed. */
function rebound(fx, mutate, directory = path.join(fx.runtimeRoot, "evidence", "sei-assessments")) {
  const assessment = structuredClone(fx.evidence.assessment); mutate(assessment);
  const bytes = Buffer.from(`${JSON.stringify(assessment, null, 2)}\n`);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `variant-${sha256(bytes).slice(0, 12)}.json`); fs.writeFileSync(file, bytes);
  const ref = { ...fx.envelope.sei_assessment_ref, assessment_id: assessment.assessment_id, snapshot_binding: { ...fx.envelope.sei_assessment_ref.snapshot_binding, snapshot_id: assessment.snapshot_binding.snapshot_id }, artifact_path: file, artifact_sha256: sha256(bytes) };
  return { ...fx.envelope, sei_assessment_ref: ref };
}

test("the rendezvous contract names the SEI reader and the exact bound refs", (context) => {
  const fx = rendezvous(context);
  const sei = fx.result.owner_rendezvous.contract.sei;
  assert.equal(sei.reader.export, "readSeiEvidence");
  assert.equal(path.resolve(sei.reader.module), path.join(SKILLS, "repository-improvement-assessment", "engineering-intelligence-reader.js"));
  assert.deepEqual(sei.engineering_intelligence_ref, fx.envelope.engineering_intelligence_ref);
  assert.deepEqual(sei.sei_assessment_ref, fx.envelope.sei_assessment_ref, "the existing complete ref, not a shorter shape");
  for (const field of ["assessment_id", "artifact_sha256", "artifact_path", "snapshot_binding", "rubric", "standard", "config_digest", "applicability_digest"]) assert.ok(field in sei.sei_assessment_ref, field);
  assert.equal(require(sei.reader.module)[sei.reader.export], readSeiEvidence);
});

test("the combined reader returns the cross-bound snapshot and assessment", (context) => {
  const fx = rendezvous(context);
  assert.equal(fx.evidence.assessment_status, "bound");
  assert.equal(fx.evidence.assessment.snapshot_binding.snapshot_id, fx.evidence.snapshot.engineering_intelligence.snapshot_id);
  assert.equal(fx.evidence.snapshot.repository_revision, fx.revision);
  const legacy = { ...fx.envelope }; delete legacy.sei_assessment_ref;
  assert.equal(readSeiEvidence({ repository_root: fx.root, envelope: legacy, allowed_roots: [fx.runtimeRoot] }).assessment_status, "missing", "a genuinely missing legacy assessment is reported, not invented");
});

test("§12 test 27: tampering, malformed bytes, path escape and a wrong snapshot block", (context) => {
  const fx = rendezvous(context);
  const original = fx.envelope.sei_assessment_ref.artifact_path;
  const copy = path.join(fx.runtimeRoot, "evidence", "sei-assessments", "tamper-copy.json");
  fs.copyFileSync(original, copy);
  const tampered = { ...fx.envelope, sei_assessment_ref: { ...fx.envelope.sei_assessment_ref, artifact_path: copy } };
  fs.appendFileSync(copy, " ");
  assert.throws(() => readSeiEvidence({ repository_root: fx.root, envelope: tampered, allowed_roots: [fx.runtimeRoot] }), /FAIL-SEI-ASSESSMENT-HASH-MISMATCH/);
  fs.writeFileSync(copy, "{ not json");
  assert.throws(() => readSeiEvidence({ repository_root: fx.root, envelope: tampered, allowed_roots: [fx.runtimeRoot] }), /FAIL-SEI-ASSESSMENT-HASH-MISMATCH/, "bytes are hashed before they are parsed");
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ria-sei-outside-")), "assessment.json");
  fs.copyFileSync(original, outside);
  const escaped = { ...fx.envelope, sei_assessment_ref: { ...fx.envelope.sei_assessment_ref, artifact_path: outside } };
  assert.throws(() => readSeiEvidence({ repository_root: fx.root, envelope: escaped, allowed_roots: [fx.runtimeRoot] }), /FAIL-SEI-ASSESSMENT-PATH-ESCAPE/);
  const wrongSnapshot = rebound(fx, (assessment) => { assessment.snapshot_binding.snapshot_id = "sei-v1-0000000000000000000000000000000000000000000000000000000000000000"; });
  assert.throws(() => readSeiEvidence({ repository_root: fx.root, envelope: wrongSnapshot, allowed_roots: [fx.runtimeRoot] }), /FAIL-SEI-ASSESSMENT-SNAPSHOT-MISMATCH/, "a same-revision assessment from another snapshot is not interchangeable");
});

test("§12 test 27: a metric under the wrong criterion is rejected", (context) => {
  const fx = rendezvous(context);
  const other = fx.evidence.assessment.criteria.find((item) => item.criterion_id !== fx.criterion.criterion_id && !(item.evidence.observations ?? []).some((o) => o.observation_id === fx.metric || (o.source_metric_ids ?? []).includes(fx.metric)));
  assert.deepEqual(seiCitationProblems(fx.evidence.assessment, [{ criterion_id: fx.criterion.criterion_id, metric_id: fx.metric }]), []);
  assert.match(seiCitationProblems(fx.evidence.assessment, [{ criterion_id: other.criterion_id, metric_id: fx.metric }])[0], /is not a metric of criterion/);
});

function healthIsland(fx, citation) {
  const island = JSON.parse(fs.readFileSync(path.join(SKILLS, "repository-health-assessment", "assets", "canonical-island.json"), "utf8").replaceAll("abc1234", fx.revision));
  island.claims[0].evidence.push({ kind: "sei-criterion", ...citation });
  return island;
}
function architectureSet(fx, citation) {
  // RIA mode binds Architecture evidence to stored packet bytes (architecture.evidence-binding@1).
  const value = architectureRiaInput(fx.root, fx.envelope).input;
  value.candidates[0].evidence_refs.push({ kind: "sei-criterion", ...citation });
  return value;
}
function runWriter(fx, owner, value, envelope) {
  const scratch = fs.mkdtempSync(path.join(fx.sandbox, `${owner}-`));
  const input = path.join(scratch, "input.json"); fs.writeFileSync(input, JSON.stringify(value));
  const envelopePath = path.join(scratch, "envelope.json"); fs.writeFileSync(envelopePath, JSON.stringify(envelope));
  const script = owner === "health" ? path.join(SKILLS, "repository-health-assessment", "assets", "write-health-artifact.js") : path.join(SKILLS, "architecture-improvement-intelligence", "assets", "write-candidate-set.js");
  return childProcess.spawnSync(process.execPath, [script, "--input", input, "--repo", fx.root, "--ria-envelope", envelopePath], { encoding: "utf8", env: { ...process.env, RIA_RUNTIME_ROOT: fx.runtimeRoot } });
}

test("§12 test 16: a criterion in the rubric but absent from the bound assessment is rejected by both writers", (context) => {
  const fx = rendezvous(context);
  const dropped = fx.criterion.criterion_id;
  const rubric = JSON.parse(fs.readFileSync(path.join(SKILLS, "shared", "software-engineering-intelligence", "engineering-assessment-rubric.json"), "utf8"));
  assert.ok(rubric.criteria.some((item) => item.criterion_id === dropped), "the criterion is in the rubric");
  const thin = rebound(fx, (assessment) => { assessment.criteria = assessment.criteria.filter((item) => item.criterion_id !== dropped); });
  const citation = { criterion_id: dropped, metric_id: fx.metric };
  for (const [owner, value] of [["health", healthIsland(fx, citation)], ["architecture", architectureSet(fx, citation)]]) {
    const rejected = runWriter(fx, owner, value, { ...thin, candidate_namespace: owner });
    assert.notEqual(rejected.status, 0, `${owner} writer must reject`);
    assert.match(rejected.stderr, /FAIL-SEI-CITATION-INVALID[\s\S]*is not in the bound assessment/, owner);
    const accepted = runWriter(fx, owner, value, { ...fx.envelope, candidate_namespace: owner });
    assert.equal(accepted.status, 0, `${owner}: ${accepted.stderr}`);
  }
});

test("§12 test 16: RIA's owner-artifact verification is the authoritative check", (context) => {
  const fx = rendezvous(context);
  const dropped = fx.criterion.criterion_id;
  const thin = rebound(fx, (assessment) => { assessment.criteria = assessment.criteria.filter((item) => item.criterion_id !== dropped); });
  const island = healthIsland(fx, { criterion_id: dropped, metric_id: fx.metric });
  const artifact = path.join(fx.sandbox, "health-artifact.json"); fs.writeFileSync(artifact, JSON.stringify(island));
  const bytes = fs.readFileSync(artifact);
  const ownerReturn = createOwnerReturn({ owner: "repository-health-assessment", canonical_artifact_ref: { owner: "repository-health-assessment", artifact_id: `health-assessment:${sha256(bytes)}`, sha256: sha256(bytes), repository_revision: fx.revision }, repository_revision: fx.revision, artifact_path: artifact, input_binding_echo: thin, warnings: [] });
  const baseline = { repository: { roots: [{ root: fx.root }] } };
  assert.equal(collectSeiCitations(island).length, 1);
  assert.throws(() => verifySeiCitations(ownerReturn, thin, baseline, { runtime_root: fx.runtimeRoot }), /FAIL-RIA-SEI-CITATION[\s\S]*is not in the bound assessment/);
  assert.throws(() => verifySeiCitations(ownerReturn, thin, baseline, { runtime_root: fx.runtimeRoot }), (error) => error.non_degradable === true, "blocks even under allow_degraded");
  assert.doesNotThrow(() => verifySeiCitations(ownerReturn, fx.envelope, baseline, { runtime_root: fx.runtimeRoot }));
});
