"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Store = require("../../shared/orchestration-runtime/runtime-store");
const Runtime = require("../../shared/orchestration-runtime/runtime-router");
const Registry = require("../../shared/capability-registry/registry");
const Control = require("./loop-control");

const candidateSkillsRoot = path.resolve(__dirname, "..", "..");
const readyFixture = JSON.parse(fs.readFileSync(path.join(candidateSkillsRoot, "shared", "orchestration-runtime", "fixtures", "lifecycle-ready.json"), "utf8"));
const humanFixture = JSON.parse(fs.readFileSync(path.join(candidateSkillsRoot, "shared", "orchestration-runtime", "fixtures", "lifecycle-human-stop.json"), "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-control-hardening-"));
const bootstrapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loop-control-bootstrap-"));
const runtimeDir = path.join(root, ".autonomous-loop", "runtime");
const T0 = "2026-08-08T15:00:00.000Z";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function withSnapshot(state) { state = copy(state); state.capability_snapshot_ref = Registry.snapshotRef(candidateSkillsRoot); return state; }
function write(name, state) { const file = path.join(runtimeDir, name + ".json"); Store.atomicWriteJSON(file, state); return file; }
function check(condition, message) { assert.ok(condition, message); }

try {
  fs.mkdirSync(runtimeDir, { recursive: true });
  check(Control.discoverActiveMissions(root, T0).decision === "NO_RESUMABLE_MISSION", "zero missions are not resumable");

  const boot = Control.startMission(bootstrapRoot, { mission_id: "mission-bootstrap-control", authorized_by: "test" }, readyFixture.policy, { now: T0, skills_root: candidateSkillsRoot });
  check(boot.decision === "ASSESS" && boot.reservation && fs.existsSync(boot.runtime_state_path), "path-free startMission persists and reserves ASSESS");
  const artifactPath = path.join(bootstrapRoot, ".autonomous-loop", "capability-snapshots", boot.capability_snapshot_ref.sha256 + ".json");
  check(fs.existsSync(artifactPath), "startMission persists a resolvable capability artifact under the repository");
  check(Control.startMission(bootstrapRoot, { mission_id: "mission-bootstrap-control-2", authorized_by: "test" }, readyFixture.policy, { now: T0, skills_root: candidateSkillsRoot }).decision === "MISSION_CONFLICT", "conflicting bootstrap is rejected before a second mission is created");
  check(Control.discoverActiveMissions(bootstrapRoot, T0).mission.mission_id === "mission-bootstrap-control", "cold discovery finds the same bootstrapped mission");

  const first = write("mission-a", withSnapshot(readyFixture));
  const found = Control.discoverActiveMissions(root, T0);
  check(found.decision === "RESUME_READY" && found.mission.mission_id === readyFixture.mission_id, "one mission is selected deterministically");
  check(found.mission.status === "active", "dispatchable mission is classified active");

  const resumed = Control.resumeMission(root, readyFixture.mission_id, { now: T0, skills_root: candidateSkillsRoot });
  check(resumed.decision === "EXECUTE" && resumed.reservation && resumed.handoff, "resume recovers, routes, reserves, and emits the canonical handoff");
  check(resumed.reservation.owner === "execution-runtime", "resume uses the runtime policy owner");

  const beforeStatus = fs.readFileSync(first);
  const status = Control.getLoopStatus(root, readyFixture.mission_id, T0);
  const afterStatus = fs.readFileSync(first);
  check(status.mission_id === readyFixture.mission_id && status.active_reservations.length === 1, "status resolves canonical runtime state");
  check(Buffer.compare(beforeStatus, afterStatus) === 0, "status is read-only");

  const beforeGraph = fs.readFileSync(first);
  const graph = Control.getRemediationGraph(root, readyFixture.mission_id);
  const afterGraph = fs.readFileSync(first);
  check(graph.decision === "GRAPH_AVAILABLE" && Buffer.compare(beforeGraph, afterGraph) === 0, "graph lookup is read-only and uses the admitted frontier");

  const stopped = Control.requestStopAfterCurrentWave(root, readyFixture.mission_id, { now: "2026-08-08T15:00:01.000Z" });
  check(stopped.decision === "STOP_USER_REQUESTED" && stopped.soft_stop, "soft stop is a runtime transaction");
  const cold = spawnSync(process.execPath, ["-e", "const S=require(process.argv[1]);const x=S.readRuntimeState(process.argv[2]);process.stdout.write(JSON.stringify({request_id:x.soft_stop.request_id,history:x.soft_stop_history.length}));", path.join(candidateSkillsRoot, "shared", "orchestration-runtime", "runtime-store.js"), first], { encoding: "utf8" });
  check(cold.status === 0 && JSON.parse(cold.stdout).history === 1, "a cold process preserves the soft stop");
  const heldResume = Control.resumeMission(root, readyFixture.mission_id, { now: "2026-08-08T15:00:02.000Z", skills_root: candidateSkillsRoot });
  check(heldResume.decision === "WAIT_SOFT_STOP", "resume reports a wave-draining soft stop while the active claim remains: " + JSON.stringify(heldResume));
  check(Store.readRuntimeState(first).soft_stop.request_id === stopped.soft_stop.request_id, "active-wave resume does not consume the durable soft stop");

  const secondState = withSnapshot(readyFixture); secondState.mission_id = "mission-b"; secondState.authorization.mission_id = "mission-b"; secondState.owner_projections.forEach((projection) => { projection.mission_id = "mission-b"; projection.projection_hash = Store.projectionHash(projection); projection.projection_id = Store.projectionId(projection); });
  let secondPrevious = "0".repeat(64); secondState.owner_projection_history = secondState.owner_projections.filter((projection) => ["assessment", "frontier", "integration"].includes(projection.projection_kind)).map((projection, index) => { const entry = Store.ownerProjectionHistoryEntry(projection, index + 1, secondPrevious); secondPrevious = entry.history_hash; return entry; }); secondState.owner_projection_current = Object.fromEntries(["assessment", "frontier", "integration"].map((kind) => { const projection = secondState.owner_projections.find((item) => item.projection_kind === kind); return [kind, projection ? projection.projection_id : null]; }));
  const second = write("mission-b", secondState);
  const multiple = Control.discoverActiveMissions(root, T0);
  check(multiple.decision === "MISSION_SELECTION_REQUIRED" && multiple.active.length === 2, "multiple missions require an explicit selection: " + JSON.stringify(multiple));
  check(Control.getLoopStatus(root, "missing-mission", T0).decision === "MISSION_NOT_FOUND", "unknown mission is not selected implicitly");

  const decisionFile = write("decision", humanFixture);
  const decision = Control.resolveDecision(root, humanFixture.mission_id, "merge-approval", "approved by owner", { now: "2026-08-08T15:00:03.000Z" });
  check(decision.decision === "EXECUTE" && decision.decision_receipt && decision.decision_receipt.answer === "approved by owner", "decision resolution persists an exact answer receipt and re-enters routing");
  const decisionCold = spawnSync(process.execPath, ["-e", "const S=require(process.argv[1]);const x=S.readRuntimeState(process.argv[2]);process.stdout.write(JSON.stringify(x.decision_receipts[0]));", path.join(candidateSkillsRoot, "shared", "orchestration-runtime", "runtime-store.js"), decisionFile], { encoding: "utf8" });
  check(decisionCold.status === 0 && JSON.parse(decisionCold.stdout).decision_id === "merge-approval", "decision receipt survives a fresh process");
  const replayDecision = Control.resolveDecision(root, humanFixture.mission_id, "merge-approval", "approved by owner", { now: "2026-08-08T15:00:04.000Z" });
  check(replayDecision.transaction_code === "DECISION_ALREADY_RESOLVED" && replayDecision.decision === "EXECUTE", "same answer replay is idempotent: " + JSON.stringify(replayDecision));
  const conflictDecision = Control.resolveDecision(root, humanFixture.mission_id, "merge-approval", "rejected", { now: "2026-08-08T15:00:04.000Z" });
  check(conflictDecision.decision === "DECISION_CONFLICT", "conflicting answer replay is rejected: " + JSON.stringify(conflictDecision));
  const unknownDecision = Control.resolveDecision(root, humanFixture.mission_id, "unknown", "answer", { now: "2026-08-08T15:00:04.000Z" });
  check(unknownDecision.decision === "STOP_HUMAN" && unknownDecision.reason === "DECISION_NOT_FOUND", "unknown decision is rejected by the canonical owner: " + JSON.stringify(unknownDecision));

  fs.writeFileSync(path.join(runtimeDir, "corrupt.json"), "{");
  check(Control.discoverActiveMissions(root, T0).decision === "STOP_UNVERIFIABLE", "corrupt runtime state fails closed");
  console.log("GREEN — 15/15 checks passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(bootstrapRoot, { recursive: true, force: true });
}
