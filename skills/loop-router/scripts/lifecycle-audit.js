#!/usr/bin/env node
"use strict";

/* Historical experimental lifecycle-mechanism proof. This script is not a
 * production gate or authority check. RIA is invoked only for its independent
 * ASSESS contract; later mechanics are exercised as isolated fixtures. */
const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..", "..", "..");
const ActionState = require(path.join(root, "skills", "shared", "action-graph-execution", "state-store.js"));
const RouterTrace = require(path.join(root, "skills", "loop-router", "scripts", "router-scenarios.js"));
const Stage15Trace = require(path.join(root, "skills", "shared", "action-integration-reassessment", "wave-boundary-gate.test.js"));

let passed = 0, failed = 0;
function check(name, fn) { try { fn(); passed++; console.log("ok   " + name); } catch (error) { failed++; console.error("FAIL " + name + "\n     " + error.message); } }
function run(name, command) {
  const result = cp.spawnSync(command[0], command.slice(1), { cwd: root, stdio: "inherit", timeout: 180000 });
  if (result.status === 0) { passed++; console.log("ok   " + name); }
  else { failed++; console.error("FAIL " + name + " exit " + result.status + (result.error ? ": " + result.error.message : "")); }
}

console.log("=== historical experimental lifecycle fixtures ===");
run("RIA ASSESS-only contract", ["node", "skills/repository-improvement-assessment/scripts/task3-contract-check.js"]);
check("historical router trace simulates ASSESS through COMPLETE", () => {
  const trace = RouterTrace.runPublicRuntimeTrace();
  assert.ok(trace && trace.checks >= 400);
});
check("planner topology records resource conflicts and integration/verification barriers", () => {
  const topology = fs.readFileSync(path.join(root, "skills", "human-directed-swarm-planner", "assets", "execution-topology.yaml"), "utf8");
  assert.match(topology, /exclusive_resources/);
  assert.match(topology, /integration_owner/);
  assert.match(topology, /verification_owner/);
});
check("action execution persists a durable completed action through its public API", () => {
  const graph = JSON.parse(fs.readFileSync(path.join(root, "skills", "shared", "action-graph-execution", "fixtures", "one-action-three-candidates.json"), "utf8"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-audit-action-"));
  try {
    ActionState.initState(stateDir, graph);
    assert.equal(ActionState.claimAction(stateDir, graph, "action-x", "lifecycle-audit").claimed, true);
    ActionState.recordTransition(stateDir, graph, "action-x", "verifying", {});
    ActionState.recordGateReceipt(stateDir, graph, "verify::action-x", { verdict: "PASS", packet_lock_sha256: "audit-iv", verdict_ref: "audit-iv-receipt" });
    ActionState.recordTransition(stateDir, graph, "action-x", "complete", {});
    assert.equal(ActionState.reverifyOnResume(stateDir, graph).actions["action-x"].status, "complete");
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});
check("RIA remains ASSESS-only while historical handoff fixtures remain internally coherent", () => {
  const ria = fs.readFileSync(path.join(root, "skills", "repository-improvement-assessment", "SKILL.md"), "utf8");
  const manifest = require(path.join(root, "skills", "loop-router", "MANIFEST.json"));
  assert.doesNotMatch(ria, /production-flywheel handoff|run Stage 15|quick-fix-execution-contract/i);
  assert.match(manifest.canonical_handoffs.RECONCILE.sequence[0].action, /remediation-graph-optimizer/);
  assert.equal(fs.existsSync(path.join(root, "skills", "repository-improvement-assessment", "references", "quick-fix-execution-contract.md")), false);
});

(async () => {
  try {
    const result = await Stage15Trace.runHermeticStage15();
    check("Stage15 mechanism returns an exact durable action-set receipt", () => {
      assert.equal(result.ok, true);
      assert.match(result.stage15.action_set_id, /.+/);
      assert.ok(Array.isArray(result.stage15.execution_completion.completion_refs));
      assert.ok(result.stage15.execution_completion.completion_refs.length > 0);
    });
  } catch (error) { failed++; console.error("FAIL Stage15 durable receipt\n     " + error.stack); }
  const supplemental = [
    ["router scenarios", ["node", "skills/loop-router/scripts/router-scenarios.js"]],
    ["runtime", ["node", "skills/shared/orchestration-runtime/package-check.js"]],
    ["graph v2", ["node", "skills/shared/remediation-graph/package-check.js"]],
    ["action execution", ["node", "skills/shared/action-graph-execution/package-check.js"]],
    ["Stage15", ["node", "skills/shared/action-integration-reassessment/package-check.js"]]
  ];
  for (const [name, command] of supplemental) run("supplemental " + name, command);
  console.log("\n" + (failed ? "RED" : "GREEN") + " — primary and supplemental " + passed + " checks");
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error.stack); process.exit(1); });
