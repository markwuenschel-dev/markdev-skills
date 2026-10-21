"use strict";

// Phase 8 shadow integration (composite-scoring-v3 D6, §5.2, §9.2, §10). A real stock run
// with report generation: v1 stays the reported composite, v2 is computed beside it from the
// bound artifacts and rendered as an uncalibrated shadow, and the standalone report CLI
// reproduces it from the same bound bytes.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { executeRia } = require("./ria.js");
const stockAdapter = require("./test-support/ria-stock-adapter.js");
const { deriveCompatibilityBinding } = require("./compatibility-binding.js");
const { buildReportData, compositeAnalytics, readJson } = require("./report-model.js");
const { STATUS_TO_OUTCOME, compositeV2Analytics } = require("./composite-v2-model.js");
const { selectHeadline } = require("./composite-v2-section.js");
const { unavailablePerformanceReceipt } = require("./performance-receipt.js");
const { loadPresentationPolicy } = require("../../shared/ria-scoring/composite-v2-config.js");

const SKILL = path.resolve(__dirname, "..");
const ARCHITECTURE = "architecture-improvement-intelligence";
const DIMENSIONS = ["architecture", "change_and_docs", "contracts", "correctness", "delivery", "maintainability", "reliability", "security", "verification"];
function git(root, args) { return childProcess.execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" }).trim(); }
function compatibility() { return deriveCompatibilityBinding({ engine_version: "sei-stock-integration@1", effective_configuration: { evidence: "bounded" }, execution_contract: { version: 1 }, history_window: { kind: "full" }, assessment_schema_version: "sei.engineering-assessment@3", analyzer_capabilities: {} }); }
function request(root, extra = {}) { return { repository: { root }, durable_mode: "git", command_authorization: { state: "granted", authorization_ref: "shadow-test", inherited_from: null, commands: ["node-version"] }, verification_contract: { commands: ["node-version"], isolation: "read-only-source" }, sei_compatibility_binding: compatibility(), runtime_root: path.join(root, ".project-intelligence", "assessments", "ria", "shadow-test"), presentation_policy: "generate", depth: "quick", ...extra }; }

let fixture = null;
async function run() {
  if (fixture) return fixture;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ria-v2-shadow-"));
  process.on("exit", () => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} });
  const root = path.join(sandbox, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "src", "owner.js"), "module.exports = { state: 1 };\nmodule.exports.read = () => module.exports.state;\n");
  // The canonical Integrity ledger the stock adapter replays cites these paths; RIA resolves
  // coverage path refs at the assessed revision (composite-scoring-v3 §7.1 rule 4).
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "money.js"), "exports.toCents = (x) => Math.floor(x * 100);\n");
  fs.writeFileSync(path.join(root, "src", "api", "schema.ts"), "export interface Order { qty: number }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "fixture"]);
  const result = await executeRia(request(root), stockAdapter);
  assert.equal(result.status, "complete", JSON.stringify(result.execution.failures));
  const reportData = result.execution.task_results["report-data"];
  const data = JSON.parse(fs.readFileSync(reportData.path, "utf8"));
  const runDirectory = path.dirname(result.state_path);
  const verified = result.execution.task_results["owner-artifact-verification"];
  fixture = { sandbox, root, result, data, reportDataPath: reportData.path, html: fs.readFileSync(result.report.path, "utf8"), runDirectory, verified, envelopePath: path.join(runDirectory, "owner-inputs", `${ARCHITECTURE}-envelope.json`) };
  return fixture;
}
function cliRequest(fx) {
  const d = fx.data;
  return { repository: d.repository, mode: d.mode, baseline_ref: d.baseline_ref, engineering_intelligence_ref: d.engineering_intelligence_ref, assessment_refs: d.assessment_refs, report_election: d.report_election, performance_receipt: unavailablePerformanceReceipt("cli", "PRE_PRESENTATION_EVENT_STREAM_INCOMPLETE") };
}
function ownerFiles(fx) {
  const artifacts = fx.verified.owner_artifacts;
  return { health: artifacts["repository-health-assessment"].artifact_path, integrity: artifacts["codebase-integrity-audit-loop"].artifact_path, architecture: artifacts[ARCHITECTURE].artifact_path };
}
function cli(fx, extra = [], env = {}) {
  const scratch = fs.mkdtempSync(path.join(fx.sandbox, "cli-"));
  const requestPath = path.join(scratch, "request.json"); fs.writeFileSync(requestPath, JSON.stringify(cliRequest(fx)));
  const output = path.join(scratch, "report-data.json");
  const files = ownerFiles(fx);
  const out = childProcess.spawnSync(process.execPath, [path.join(__dirname, "build-report-data.js"), "--request", requestPath, "--health", files.health, "--integrity", files.integrity, "--architecture", files.architecture, "--output", output, ...extra], { encoding: "utf8", env: { ...process.env, RIA_RUNTIME_ROOT: request(fx.root).runtime_root, ...env } });
  return { ...out, data: out.status === 0 ? JSON.parse(fs.readFileSync(output, "utf8")) : null };
}

test("v2 is computed beside v1 as an uncalibrated shadow, and v1 is unchanged", async () => {
  const fx = await run();
  const v2 = fx.data.analytics.composite_v2;
  assert.equal(v2.schema_version, "ria.composite@2");
  assert.equal(v2.reported, false);
  assert.equal(v2.calibration_state, "uncalibrated");
  assert.equal(v2.headline, "v1");
  assert.equal(fx.data.provenance.composite_v2_shadow, true);
  assert.equal(fx.data.provenance.composite_v2_reported, false);
  assert.deepEqual(v2.dimensions.map((dimension) => dimension.id).sort(), DIMENSIONS);
  // v1 recomputed from the same normalized owners, with no v2 context, is byte-identical.
  const files = ownerFiles(fx);
  const plain = buildReportData({ request: cliRequest(fx), healthFile: readJson(files.health, "health"), integrityFile: readJson(files.integrity, "integrity"), architectureFile: readJson(files.architecture, "architecture"), skillRoot: SKILL, fixture: false });
  assert.deepEqual(plain.analytics.composite, fx.data.analytics.composite);
  assert.deepEqual(compositeAnalytics(plain.analytics.health, plain.analytics.architecture, plain.analytics.testing), fx.data.analytics.composite);
});

test("the stock-adapter report shows four owners in effective influence", async () => {
  const fx = await run();
  const influence = fx.data.analytics.composite_v2.influence;
  for (const owner of ["health", "architecture", "integrity", "sei"]) assert.ok(influence.effective[owner] > 0, `${owner}: ${influence.effective[owner]}`);
  const total = Object.values(influence.effective).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 100) < 1e-6, `effective influence sums to 100 (got ${total})`);
  assert.deepEqual(Object.keys(influence.nominal).sort(), ["architecture", "health", "integrity", "sei"]);
});

test("the report renders the shadow section and keeps the v1 headline", async () => {
  const fx = await run();
  const v1 = fx.data.analytics.composite;
  const v2 = fx.data.analytics.composite_v2;
  assert.match(fx.html, /<section id="composite-v2">/);
  assert.match(fx.html, /v2 composite — uncalibrated shadow/);
  assert.match(fx.html, /Uncalibrated shadow — not the reported grade\./);
  assert.match(fx.html, new RegExp(`data-v2-status="${v2.status}"`));
  for (const id of DIMENSIONS) assert.match(fx.html, new RegExp(`data-v2-dimension="${id}"`), id);
  for (const owner of ["health", "architecture", "integrity", "sei"]) assert.match(fx.html, new RegExp(`data-v2-owner="${owner}"`), owner);
  assert.match(fx.html, /Effective owner influence \(v2 shadow\)/);
  assert.match(fx.html, /href="#composite-v2"/);
  // The headline gauge and grade pill still show v1.
  assert.match(fx.html, new RegExp(`RIA ${v1.final_grade.replace("+", "\\+")} · `));
  assert.doesNotMatch(fx.html, /RIA composite v2/);
  assert.doesNotMatch(fx.html, />LOW</);
});

test("headline selection: only a promoted policy with a verified calibration headlines v2", async () => {
  const fx = await run();
  const analytics = fx.data.analytics;
  assert.equal(selectHeadline(analytics).source, "v1");
  assert.equal(selectHeadline({ ...analytics, composite_v2: { ...analytics.composite_v2, headline: "v2", reported: false } }).source, "v1", "policy alone cannot headline v2");
  const capped = { ...analytics.composite_v2, headline: "v2", reported: true, status: "provisional", point: { raw_score: 88.04, final_score: 69.9, final_grade: "D+" }, caps: [{ cap_id: "critical-dimension-floor", trigger: "architecture", ceiling: 69.9, binding: true }] };
  const selected = selectHeadline({ ...analytics, composite_v2: capped });
  assert.equal(selected.source, "v2");
  assert.equal(selected.composite.final_score, 69.9, "a capped D+ never displays as 70");
  assert.equal(selected.composite.final_grade, "D+");
  assert.deepEqual(selected.composite.binding_cap, { ceiling: 69.9, cap: "critical-dimension-floor" });
  // build-report renders the promoted headline from report data alone.
  const promoted = structuredClone(fx.data); promoted.analytics.composite_v2 = capped;
  const input = path.join(fx.sandbox, "promoted-report-data.json"); fs.writeFileSync(input, JSON.stringify(promoted));
  const html = path.join(fx.sandbox, "promoted.html");
  childProcess.execFileSync(process.execPath, [path.join(__dirname, "build-report.js"), "--input", input, "--output", html]);
  const page = fs.readFileSync(html, "utf8");
  assert.match(page, /RIA composite v2 D\+, 69\.9 out of 100/);
  assert.match(page, /RIA D\+ · 69\.9/);
  assert.match(page, /<strong>Reported composite\.<\/strong>/);
  // The engine itself refuses `reported` without a verified calibration, whatever the policy says.
  const policy = loadPresentationPolicy({ policy: { schema_version: "ria.composite-v2.policy@1", reported_composite: "v2", calibration_ref: { receipt_path: "calibration/receipt.json", receipt_sha256: "f".repeat(64) } } });
  const files = ownerFiles(fx);
  const HV = require("../../repository-health-assessment/assets/health-verify.js");
  const health = JSON.parse(fs.readFileSync(files.health, "utf8"));
  const out = compositeV2Analytics({ policy, health: { raw: health, verified: (globalThis.HealthVerify ?? HV).verifyHealth(health) }, integrity: { raw: JSON.parse(fs.readFileSync(files.integrity, "utf8")) }, architecture: { raw: JSON.parse(fs.readFileSync(files.architecture, "utf8")), receipt: fx.verified.architecture_evidence }, sei: { status: "missing" }, verification: null, binding: { repository_id: fx.data.baseline_ref.artifact_id, root_id: "root-0", revision: fx.data.repository.revision } });
  assert.equal(out.composite.reported, false);
  assert.equal(out.composite.calibration_state, "uncalibrated");
});

test("the report CLI reproduces the run's shadow from the bound envelope", async () => {
  const fx = await run();
  const out = cli(fx, ["--ria-envelope", fx.envelopePath, "--repo", fx.root]);
  assert.equal(out.status, 0, out.stderr);
  const strip = (value) => { const copy = structuredClone(value); return copy; };
  assert.deepEqual(strip(out.data.analytics.composite_v2.dimensions), strip(fx.data.analytics.composite_v2.dimensions));
  assert.deepEqual(out.data.analytics.composite_v2.point, fx.data.analytics.composite_v2.point);
  assert.equal(cli(fx, ["--ria-envelope", fx.envelopePath]).status, 1, "--ria-envelope requires --repo");
});

test("without bound SEI the shadow degrades explicitly; tampered bound evidence blocks", async () => {
  const fx = await run();
  const bare = cli(fx);
  assert.equal(bare.status, 0, bare.stderr);
  const v2 = bare.data.analytics.composite_v2;
  assert.equal(v2.run_state, "degraded");
  assert.notEqual(v2.status, "final");
  for (const dimension of v2.dimensions) for (const c of dimension.contributions.filter((item) => item.owner === "sei")) assert.equal(c.state, "failed", dimension.id);
  assert.deepEqual(bare.data.analytics.composite, fx.data.analytics.composite, "v1 is independent of the v2 context");
  // Tamper with the bound SEI assessment bytes the envelope names.
  const envelope = JSON.parse(fs.readFileSync(fx.envelopePath, "utf8"));
  const assessmentPath = envelope.sei_assessment_ref.artifact_path;
  const original = fs.readFileSync(assessmentPath);
  try {
    fs.writeFileSync(assessmentPath, Buffer.concat([original, Buffer.from(" ")]));
    const tampered = cli(fx, ["--ria-envelope", fx.envelopePath, "--repo", fx.root]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /FAIL-RIA-COMPOSITE-V2-SEI: FAIL-SEI-ASSESSMENT-HASH-MISMATCH/);
  } finally { fs.writeFileSync(assessmentPath, original); }
  // Bound bytes that are simply absent leave SEI missing (degraded shadow), never a block.
  fs.renameSync(assessmentPath, `${assessmentPath}.moved`);
  try {
    const absent = cli(fx, ["--ria-envelope", fx.envelopePath, "--repo", fx.root]);
    assert.equal(absent.status, 0, absent.stderr);
    const shadow = absent.data.analytics.composite_v2;
    assert.equal(shadow.run_state, "degraded");
    const sei = shadow.dimensions.find((dimension) => dimension.id === "verification").contributions.find((c) => c.owner === "sei");
    assert.equal(sei.state, "failed");
    assert.match(sei.limitations.join(" "), /bound SEI evidence unavailable \(FAIL-SEI-ASSESSMENT-ARTIFACT-NOT-FOUND/);
  } finally { fs.renameSync(`${assessmentPath}.moved`, assessmentPath); }
  const baselinePath = envelope.verification_baseline_ref.path;
  const baselineBytes = fs.readFileSync(baselinePath);
  try {
    fs.writeFileSync(baselinePath, Buffer.concat([baselineBytes, Buffer.from(" ")]));
    const tampered = cli(fx, ["--ria-envelope", fx.envelopePath, "--repo", fx.root]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /FAIL-RIA-COMPOSITE-V2-VERIFICATION: verification baseline bytes changed/);
  } finally { fs.writeFileSync(baselinePath, baselineBytes); }
});

test("verification outcomes follow §9.2: unavailable means the command could not start", () => {
  assert.deepEqual(STATUS_TO_OUTCOME, { passed: "pass", failed: "fail", "timed-out": "timed-out", skipped: "skipped", unavailable: "error" });
});

/* Narrow v2 availability fallback (Promotion A deployment review 2026-10-17): a partial
 * deployment that removed a v2 implementation file leaves v1 renderable while v1 is the
 * reported composite; integrity failures and a v2 headline never fall back. */
const SKILLS_ROOT = path.resolve(__dirname, "..", "..");
function installationCopy(fx, { remove = [], policy = null } = {}) {
  const copy = fs.mkdtempSync(path.join(fx.sandbox, "install-"));
  fs.cpSync(SKILLS_ROOT, copy, { recursive: true, filter: (source) => !/[\/]\.git([\/]|$)/.test(source) });
  for (const relative of remove) fs.rmSync(path.join(copy, relative));
  if (policy) fs.writeFileSync(path.join(copy, "shared", "ria-scoring", "composite-v2.policy.json"), JSON.stringify(policy));
  return copy;
}
function cliAt(fx, skillsRoot) {
  const scratch = fs.mkdtempSync(path.join(fx.sandbox, "cli-"));
  const requestPath = path.join(scratch, "request.json"); fs.writeFileSync(requestPath, JSON.stringify(cliRequest(fx)));
  const output = path.join(scratch, "report-data.json");
  const files = ownerFiles(fx);
  const out = childProcess.spawnSync(process.execPath, [path.join(skillsRoot, "repository-improvement-assessment", "scripts", "build-report-data.js"), "--request", requestPath, "--health", files.health, "--integrity", files.integrity, "--architecture", files.architecture, "--output", output], { encoding: "utf8", env: { ...process.env, RIA_RUNTIME_ROOT: request(fx.root).runtime_root } });
  return { ...out, output, data: out.status === 0 ? JSON.parse(fs.readFileSync(output, "utf8")) : null };
}

test("a partial installation missing a v2 file still renders v1, and says v2 is unavailable", async () => {
  const fx = await run();
  const intact = cliAt(fx, installationCopy(fx));
  assert.equal(intact.status, 0, intact.stderr);
  assert.equal(intact.data.analytics.composite_v2.schema_version, "ria.composite@2", "positive control: the intact copy computes v2");
  const partial = cliAt(fx, installationCopy(fx, { remove: ["shared/ria-scoring/evidence-model.js"] }));
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(partial.data.analytics.composite_v2, undefined, "no v2 numbers are invented");
  assert.deepEqual(partial.data.analytics.composite, intact.data.analytics.composite, "v1 is unchanged");
  assert.equal(partial.data.provenance.composite_v2_shadow, false);
  assert.equal(partial.data.provenance.composite_v2_reported, false);
  assert.match(partial.data.provenance.composite_v2_unavailable, /shared\/ria-scoring\/evidence-model\.js is missing/);
  const html = path.join(path.dirname(partial.output), "report.html");
  const rendered = childProcess.spawnSync(process.execPath, [path.join(__dirname, "build-report.js"), "--input", partial.output, "--output", html], { encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(fs.readFileSync(html, "utf8"), /The v2 composite was not computed for this report\. v2 shadow unavailable: shared\/ria-scoring\/evidence-model\.js is missing/);
  // The original deploy hazard: the overwrite removes Integrity's coverage verifier, which the
  // config loader reports as FAIL-RIA-COMPOSITE-IMPLEMENTATION-MISSING.
  const integrityGone = cliAt(fx, installationCopy(fx, { remove: ["codebase-integrity-audit-loop/assets/integrity-coverage.js"] }));
  assert.equal(integrityGone.status, 0, integrityGone.stderr);
  assert.equal(integrityGone.data.analytics.composite_v2, undefined);
  assert.deepEqual(integrityGone.data.analytics.composite, intact.data.analytics.composite, "v1 is unchanged");
  assert.match(integrityGone.data.provenance.composite_v2_unavailable, /codebase-integrity-audit-loop\/assets\/integrity-coverage\.js is missing/);
  const v2Headline = cliAt(fx, installationCopy(fx, { remove: ["shared/ria-scoring/evidence-model.js"], policy: { schema_version: "ria.composite-v2.policy@1", reported_composite: "v2", calibration_ref: null } }));
  assert.notEqual(v2Headline.status, 0, "when policy selects v2 as the headline, a missing v2 file blocks instead of falling back to v1");
  assert.match(v2Headline.stderr, /evidence-model\.js/);
});

test("the fallback catches only a missing v2 file; receipt, binding and evidence failures still block", async () => {
  const fx = await run();
  const files = ownerFiles(fx);
  const modelPath = require.resolve("./composite-v2-model.js");
  const real = require(modelPath);
  const build = (thrown) => {
    require.cache[modelPath].exports = { ...real, compositeV2Analytics: () => { throw thrown(); } };
    try { return buildReportData({ request: cliRequest(fx), healthFile: readJson(files.health, "health"), integrityFile: readJson(files.integrity, "integrity"), architectureFile: readJson(files.architecture, "architecture"), skillRoot: SKILL, fixture: false }); }
    finally { require.cache[modelPath].exports = real; }
  };
  const missingModule = () => { try { require(path.join(SKILLS_ROOT, "shared", "ria-scoring", "removed-by-deploy.js")); } catch (error) { return error; } };
  const degraded = build(missingModule);
  assert.equal(degraded.analytics.composite_v2, undefined);
  assert.match(degraded.provenance.composite_v2_unavailable, /removed-by-deploy\.js is missing/);
  const blocker = (code, extra = {}) => () => Object.assign(new Error(`${code}: probe`), { code, ...extra });
  for (const [label, thrown] of [
    ["receipt hash mismatch", blocker("FAIL-RIA-PROOF-RECEIPT", { non_degradable: true })],
    ["binding failure", blocker("FAIL-RIA-COMPOSITE-BINDING")],
    ["invalid evidence", blocker("FAIL-EVIDENCE-RANGE")],
    ["unclassified error", () => new Error("something else broke")],
  ]) assert.throws(() => build(thrown), (error) => error.message === thrown().message, `${label} is not swallowed`);
});

test("compositeV2Unavailable classifies only missing files under the skills tree", () => {
  const { compositeV2Unavailable } = require("./report-model.js");
  const enoent = (file) => Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: "ENOENT", path: file });
  assert.match(compositeV2Unavailable(enoent(path.join(SKILLS_ROOT, "shared", "ria-scoring", "composite-v2.config.json"))), /composite-v2\.config\.json is missing/);
  assert.equal(compositeV2Unavailable(enoent(path.join(os.tmpdir(), "receipts", "x.json"))), null, "a file outside the skills tree is not an implementation file");
  let bare; try { require("ria-no-such-package"); } catch (error) { bare = error; }
  assert.equal(compositeV2Unavailable(bare), null, "a bare package is not part of the v2 implementation");
  assert.equal(compositeV2Unavailable(Object.assign(enoent(path.join(SKILLS_ROOT, "x.js")), { non_degradable: true })), null, "a non-degradable error never falls back");
  assert.equal(compositeV2Unavailable(Object.assign(enoent(path.join(SKILLS_ROOT, "x.js")), { code: "FAIL-RIA-PROOF-RECEIPT" })), null);
  const typed = (relative, extra = {}) => Object.assign(new Error("FAIL-RIA-COMPOSITE-IMPLEMENTATION-MISSING: probe"), { code: "FAIL-RIA-COMPOSITE-IMPLEMENTATION-MISSING", missing_implementation: relative, ...extra });
  assert.equal(compositeV2Unavailable(typed("codebase-integrity-audit-loop/assets/integrity-coverage.js")), null, "a declared implementation file that is actually present is not missing");
  assert.equal(compositeV2Unavailable(typed("shared/ria-scoring/not-declared.js")), null, "only files on the loader's IMPLEMENTATION_FILES list qualify");
  assert.equal(compositeV2Unavailable(typed("../outside.js")), null);
  assert.equal(compositeV2Unavailable(typed("shared/ria-scoring/evidence-model.js", { non_degradable: true })), null);
  assert.equal(compositeV2Unavailable(Object.assign(new Error("FAIL-RIA-COMPOSITE-CONFIG: implementation file x is missing"), { code: "FAIL-RIA-COMPOSITE-CONFIG" })), null, "genuine configuration errors keep blocking");
});
