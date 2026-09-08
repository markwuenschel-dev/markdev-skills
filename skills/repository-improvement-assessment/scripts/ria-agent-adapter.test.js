"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const { executeRia, OWNER_TASKS } = require("./ria.js");
const { createAdapter, returnPath } = require("./ria-agent-adapter.js");
const { deriveCompatibilityBinding } = require("./compatibility-binding.js");

function git(root, args) { return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-agent-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "RIA Adapter"]);
  fs.writeFileSync(path.join(root, "source.txt"), "source\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}
function compatibility() {
  return deriveCompatibilityBinding({
    engine_version: "test@1",
    effective_configuration: {},
    execution_contract: { version: 1 },
    history_window: { kind: "revision-range", start: null },
    assessment_schema_version: "sei.engineering-assessment@3",
    analyzer_capabilities: {},
  });
}
function request(root, extra = {}) {
  return {
    repository: { root },
    durable_mode: "git",
    command_authorization: { state: "granted", authorization_ref: "test", inherited_from: null, commands: ["node-version"] },
    verification_contract: { commands: ["node-version"] },
    sei_compatibility_binding: compatibility(),
    runtime_root: path.join(root, ".project-intelligence", "assessments", "ria", "runtime"),
    presentation_policy: "skip",
    depth: "quick",
    ...extra,
  };
}
function stubs() {
  return {
    async seiSnapshot({ baseline, baseline_ref }) {
      const ei = {
        artifact_id: `engineering-intelligence:${"b".repeat(64)}`,
        owner: "repository-improvement-assessment",
        kind: "engineering-intelligence",
        schema_version: "1.0.0",
        sha256: "b".repeat(64),
        repository_revision: baseline.repository.revision,
        mission_id: "ria-agent-test",
        scope_hash: "c".repeat(64),
        baseline_binding: baseline_ref,
      };
      return { engineering_intelligence_ref: ei, snapshot: { schema_version: "1.0.0" }, prior_snapshot_path: null, result_ref: ei, telemetry: { tool_calls: 1, tokens: 0 } };
    },
    async seiAssessment({ dependencies, baseline }) {
      return {
        assessment: { criteria: [{ criterion_id: "c1", applicability: "not_scored", maturity: "not_scored" }] },
        trend: { schema_version: "ria.trend@1", status: "no-comparable-prior", prior: null, deltas: [] },
        engineering_intelligence_ref: dependencies["sei-snapshot"].engineering_intelligence_ref,
        result_ref: { artifact_id: "sei-assessment:test", sha256: "d".repeat(64), repository_revision: baseline.repository.revision },
        telemetry: { tool_calls: 1, tokens: 0 },
      };
    },
    async verification({ baseline }) {
      const verification_baseline_ref = {
        artifact_id: "verification:test",
        sha256: "d".repeat(64),
        content_sha256: "e".repeat(64),
        file_sha256: "d".repeat(64),
        repository_revision: baseline.repository.revision,
      };
      return { verification_baseline_ref, result_ref: verification_baseline_ref, telemetry: { tool_calls: 1, tokens: 0 } };
    },
  };
}
function writeOwnerReturns(runDirectory, baseline, envelopes) {
  for (const owner of Object.values(OWNER_TASKS)) {
    const envelope = JSON.parse(fs.readFileSync(envelopes[owner], "utf8"));
    assert.equal(Boolean(envelope.verification_baseline_ref) || owner === "architecture-improvement-intelligence", true, owner);
    const artifactPath = path.join(runDirectory, `${owner}.json`);
    const bytes = `${JSON.stringify({ owner, repository_revision: baseline.repository.revision })}\n`;
    fs.writeFileSync(artifactPath, bytes);
    const sha = hash(Buffer.from(bytes));
    const ownerReturn = createOwnerReturn({
      owner,
      repository_revision: baseline.repository.revision,
      artifact_path: artifactPath,
      canonical_artifact_ref: { owner, artifact_id: `${owner}:${sha}`, sha256: sha, repository_revision: baseline.repository.revision },
      input_binding_echo: envelope,
    });
    fs.mkdirSync(path.dirname(returnPath(runDirectory, owner)), { recursive: true });
    fs.writeFileSync(returnPath(runDirectory, owner), `${JSON.stringify(ownerReturn, null, 2)}\n`);
  }
}

test("agent adapter pauses for owner returns then completes on continue", async (context) => {
  const root = fixture(context);
  const injected = stubs();
  const adapter = {
    createAdapter(ctx) {
      return createAdapter(ctx, { seiSnapshot: injected.seiSnapshot, seiAssessment: injected.seiAssessment, verification: injected.verification });
    },
  };
  const first = await executeRia(request(root), adapter);
  assert.equal(first.status, "awaiting-owner-returns", JSON.stringify(first.execution.failures, null, 2));
  assert.ok(first.owner_rendezvous);
  assert.equal(Object.keys(first.owner_rendezvous.envelopes).length, 3);
  assert.equal(fs.existsSync(first.persistence.lineage_path), true);
  const runDirectory = path.dirname(first.state_path);
  writeOwnerReturns(runDirectory, { repository: { revision: git(root, ["rev-parse", "HEAD"]) } }, first.owner_rendezvous.envelopes);
  const continued = await executeRia(request(root, { lifecycle: "continue", state_path: first.state_path }), adapter);
  assert.equal(continued.status, "complete", JSON.stringify(continued.execution.failures, null, 2));
  assert.equal(continued.assessment.stage, "ASSESS");
  assert.equal(continued.assessment.assessment_refs.length, 3);
  assert.equal(fs.existsSync(continued.persistence.assess.path), true);
  assert.equal(continued.execution.run_id, first.execution.run_id);
});

test("Health and Integrity envelopes carry verification_baseline_ref", async (context) => {
  const root = fixture(context);
  const injected = stubs();
  const adapter = {
    createAdapter(ctx) {
      return createAdapter(ctx, { seiSnapshot: injected.seiSnapshot, seiAssessment: injected.seiAssessment, verification: injected.verification });
    },
  };
  const first = await executeRia(request(root), adapter);
  const health = JSON.parse(fs.readFileSync(first.owner_rendezvous.envelopes["repository-health-assessment"], "utf8"));
  const integrity = JSON.parse(fs.readFileSync(first.owner_rendezvous.envelopes["codebase-integrity-audit-loop"], "utf8"));
  assert.equal(health.verification_baseline_ref.artifact_id, "verification:test");
  assert.equal(integrity.verification_baseline_ref.artifact_id, "verification:test");
});
