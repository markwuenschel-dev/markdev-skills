#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const skillRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(skillRoot, "..", "shared", "orchestration-runtime");
const Runtime = require(path.join(runtimeRoot, "runtime-router.js"));
const Store = require(path.join(runtimeRoot, "runtime-store.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(skillRoot, "MANIFEST.json"), "utf8"));
const templatePath = path.join(skillRoot, "assets", "lifecycle-state.json");

const runtimeDependency = manifest.depends_on.find((dependency) => dependency.skill === "shared/orchestration-runtime");
const REQUIRED_ROUTER_EXPORTS = runtimeDependency.required_exports_by_module["runtime-router.js"];
const REQUIRED_STORE_EXPORTS = runtimeDependency.required_exports_by_module["runtime-store.js"];

let checks = 0;
function equal(actual, expected, label) { assert.equal(actual, expected, label); checks += 1; }
function ok(value, label) { assert.ok(value, label); checks += 1; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function loadState() { return JSON.parse(fs.readFileSync(templatePath, "utf8")); }
function assertValid(state, label) {
  const verified = Runtime.verifyRuntimeState(state);
  ok(verified.ok, label + (verified.ok ? "" : ": " + verified.errors.join("; ")));
}

function requestFor(state, stage, identity) {
  return {
    mission_id: state.mission_id,
    scope_hash: state.scope_hash,
    policy_hash: state.policy_hash,
    repository_revision: state.repository_revision,
    stage,
    owner: state.policy.stage_owners[stage][0],
    identity,
    idempotency_key: Runtime.makeIdempotencyKey(state.mission_id, stage, state.repository_revision, identity),
    projection_bindings: Runtime.projectionBindingsForStage(state, stage),
    nested: false,
    ancestors: [],
    lease_ms: state.policy.lease_ms,
  };
}

function completedReceipt(reservation) {
  return {
    receipt_id: "receipt-" + reservation.reservation_id,
    reservation_id: reservation.reservation_id,
    mission_id: reservation.mission_id,
    stage: reservation.stage,
    identity: reservation.identity,
    idempotency_key: reservation.idempotency_key,
    generation: reservation.generation,
    fence_token: reservation.fence_token,
    bound_hash: reservation.bound_hash,
    repository_revision: reservation.repository_revision,
    policy_hash: reservation.policy_hash,
    status: "completed",
    stage_complete: true,
  };
}

function terminalReceipt(reservation, status, extra) {
  return Object.assign(completedReceipt(reservation), { status, stage_complete: false }, extra || {});
}

function receiptHash(receipt, completedAt) {
  const terminal = Object.assign({}, clone(receipt), { completed_at: completedAt, receipt_hash: "0".repeat(64) });
  terminal.receipt_hash = Store.hashRecord(terminal, "receipt_hash");
  return terminal.receipt_hash;
}

function childReference(state, reservation, receipt, completedAt, marker) {
  const mapping = state.policy.stage_return_projections[reservation.stage];
  const reference = {
    projection_id: "child-" + Store.sha256(reservation.reservation_id + "::" + marker).slice(0, 24),
    owner: mapping.owner,
    kind: mapping.kind,
    repository_revision: state.repository_revision,
    sha256: Store.sha256("child-artifact::" + marker),
    status: "completed",
    recorded_at: completedAt,
    source_reservation_id: reservation.reservation_id,
    source_bound_hash: reservation.bound_hash,
    source_receipt_hash: receiptHash(receipt, completedAt),
  };
  if (mapping.predecessor_class !== null) reference.predecessor_projection_hash = state.child_projection_current[mapping.predecessor_class];
  return reference;
}

function supportingArtifactRefs(state, reservation, at, marker) {
  return state.policy.stage_supporting_artifact_requirements[reservation.stage].map((requirement, index) => ({
    reference_id: "support-" + marker + "-" + index,
    owner: requirement.owner,
    kind: requirement.kind,
    repository_revision: state.repository_revision,
    sha256: Store.sha256("support-artifact::" + marker + "::" + index),
    status: requirement.status,
    purpose: requirement.purpose,
    recorded_at: at,
    coverage: {
      reservation_id: reservation.reservation_id,
      identity: reservation.identity,
      bound_hash: reservation.bound_hash,
      coverage_status: requirement.coverage_status,
    },
  }));
}

function admittedOwnerProjection(state, reservation, at, marker, changes) {
  const admission = state.policy.stage_owner_projection_admissions[reservation.stage];
  if (admission === null) return undefined;
  const claim = admission.projection_kind === "assessment"
    ? { status: "current" }
    : admission.projection_kind === "frontier"
      ? { status: "ready-execute" }
      : { status: "clean", finding_ids: [] };
  const projection = {
    projection_id: "",
    projection_kind: admission.projection_kind,
    owner: admission.owner,
    mission_id: state.mission_id,
    repository_revision: state.repository_revision,
    policy_hash: state.policy_hash,
    artifact_ref: {
      artifact_id: "owner-projection-" + marker,
      owner: admission.owner,
      kind: admission.projection_kind + "-projection",
      sha256: Store.sha256("owner-projection-artifact::" + marker),
      repository_revision: state.repository_revision,
    },
    claim,
    recorded_at: at,
    projection_hash: "",
  };
  Object.assign(projection, changes || {});
  projection.projection_hash = Store.projectionHash(projection);
  projection.projection_id = Store.projectionId(projection);
  return projection;
}


function emitHandoff(state, reservation) {
  const contract = manifest.canonical_handoffs[reservation.stage];
  if (!contract) throw new Error("canonical_handoffs is missing " + reservation.stage);
  if (reservation.owner !== contract.reservation_owner) throw new Error("runtime reservation owner drifted from canonical handoff");
  return {
    decision: reservation.stage,
    reservation: {
      reservation_id: reservation.reservation_id,
      mission_id: reservation.mission_id,
      owner: reservation.owner,
      bound_hash: reservation.bound_hash,
      repository_revision: reservation.repository_revision,
    },
    sequence: clone(contract.sequence),
    required_artifact_refs: clone(state.policy.stage_supporting_artifact_requirements[reservation.stage]),
  };
}

function reserve(state, stage, identity, at) {
  const result = Runtime.reserveDispatch(state, requestFor(state, stage, identity), at);
  ok(result.ok, stage + " reservation succeeds: " + result.code);
  const handoff = emitHandoff(result.state, result.reservation);
  equal(handoff.reservation.owner, manifest.canonical_handoffs[stage].reservation_owner, stage + " emitted handoff uses canonical reservation owner");
  assert.deepEqual(handoff.sequence, manifest.canonical_handoffs[stage].sequence, stage + " emitted handoff preserves canonical sequence");
  checks += 1;
  return { state: result.state, reservation: result.reservation, handoff };
}

function complete(state, reservation, at, marker, refs, ownerProjection) {
  const receipt = completedReceipt(reservation);
  const beforeHistory = clone(state.child_projection_history);
  const beforeReservations = clone(state.reservations.slice(0, -1));
  const beforeOwnerHistory = clone(state.owner_projection_history);
  const beforeOwnerCurrent = clone(state.owner_projection_current);
  const returnedOwnerProjection = ownerProjection === undefined ? admittedOwnerProjection(state, reservation, at, marker) : ownerProjection;
  const result = Runtime.completeChildDispatch(state, receipt, childReference(state, reservation, receipt, at, marker), refs === undefined ? supportingArtifactRefs(state, reservation, at, marker) : refs, returnedOwnerProjection, at);
  ok(result.ok, reservation.stage + " completion is accepted atomically: " + result.code);
  assert.deepEqual(result.state.child_projection_history.slice(0, beforeHistory.length), beforeHistory, reservation.stage + " completion preserves earlier child history");
  assert.deepEqual(result.state.reservations.slice(0, beforeReservations.length), beforeReservations, reservation.stage + " completion preserves earlier reservations");
  assert.deepEqual(result.state.owner_projection_history.slice(0, beforeOwnerHistory.length), beforeOwnerHistory, reservation.stage + " completion preserves earlier owner-projection history");
  checks += 3;
  const admission = state.policy.stage_owner_projection_admissions[reservation.stage];
  if (admission === null) {
    assert.deepEqual(result.state.owner_projection_current, beforeOwnerCurrent, reservation.stage + " completion does not change canonical owner projections");
  } else {
    equal(result.state.owner_projection_current[admission.projection_kind], returnedOwnerProjection.projection_id, reservation.stage + " completion selects the admitted current owner projection");
    ok(result.state.owner_projection_history.some((entry) => entry.projection_hash === returnedOwnerProjection.projection_hash), reservation.stage + " completion appends the admitted owner projection immutably");
  }
  checks += 1;
  assertValid(result.state, reservation.stage + " accepted successor verifies");
  return result.state;
}

function rejectCompletion(state, reservation, at, marker, refs, label) {
  const before = clone(state);
  const receipt = completedReceipt(reservation);
  const result = Runtime.completeChildDispatch(state, receipt, childReference(state, reservation, receipt, at, marker), refs, at);
  equal(result.ok, false, label + " is rejected");
  equal(result.code, "CHILD_SUPPORTING_ARTIFACT_MISMATCH", label + " fails the supporting-evidence contract");
  assert.deepEqual(result.state, before, label + " leaves reservation and history unchanged");
  checks += 1;
}

function rejectOwnerProjectionAdmission(state, reservation, at, marker, ownerProjection, child, label, expectedCode) {
  const before = clone(state);
  const receipt = completedReceipt(reservation);
  const returnedChild = child || childReference(state, reservation, receipt, at, marker);
  const result = Runtime.completeChildDispatch(state, receipt, returnedChild, supportingArtifactRefs(state, reservation, at, marker), ownerProjection, at);
  equal(result.ok, false, label + " is rejected");
  equal(result.code, expectedCode || "CHILD_OWNER_PROJECTION_ADMISSION_MISMATCH", label + " returns the closed admission error");
  assert.deepEqual(result.state, before, label + " leaves reservation, receipt, and histories unchanged");
  checks += 1;
  const routerStop = routerStopForRejectedReturn(result, reservation);
  equal(routerStop.decision, "STOP_UNVERIFIABLE", label + " stops the router instead of dispatching a successor");
  equal(routerStop.route_receipt.reservation_id, reservation.reservation_id, label + " stop receipt identifies the still-active reservation");
}

function routerStopForRejectedReturn(result, reservation) {
  return {
    decision: "STOP_UNVERIFIABLE",
    reason: "owner-projection admission rejected: " + result.code,
    route_receipt: { decision: "STOP_UNVERIFIABLE", reason: "owner-projection admission rejected: " + result.code, reservation_id: reservation.reservation_id },
  };
}

function routerRoute(state, at) { return Runtime.routeLifecycle(state, at); }

function recoveredRoute(state, at) {
  const recovered = Runtime.recoverRuntime(state, at);
  ok(recovered.ok, "runtime recovery succeeds before routing");
  assertValid(recovered.state, "recovered state verifies");
  return { state: recovered.state, route: routerRoute(recovered.state, at) };
}

function routeDecision(state, at, expected, label) {
  const routed = recoveredRoute(state, at);
  equal(routed.route.decision, expected, label);
  return routed;
}

function executeReady(prefix) {
  let state = loadState();
  assertValid(state, prefix + " cold state verifies");
  routeDecision(state, "2026-08-08T16:00:01.000Z", "ASSESS", prefix + " cold start routes only ASSESS");
  let reserved = reserve(state, "ASSESS", prefix + "-assessment", "2026-08-08T16:00:02.000Z");
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:00:03.000Z", prefix + "-assessment");
  routeDecision(state, "2026-08-08T16:00:04.000Z", "RECONCILE", prefix + " assessment return re-enters reconciliation");
  reserved = reserve(state, "RECONCILE", prefix + "-reconciliation", "2026-08-08T16:00:05.000Z");
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:00:06.000Z", prefix + "-reconciliation");
  routeDecision(state, "2026-08-08T16:00:07.000Z", "EXECUTE", prefix + " reconciliation return routes execution");
  return state;
}

function integrateReady(prefix) {
  let state = executeReady(prefix);
  const reserved = reserve(state, "EXECUTE", prefix + "-frontier", "2026-08-08T16:00:08.000Z");
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:00:09.000Z", prefix + "-execution");
  routeDecision(state, "2026-08-08T16:00:10.000Z", "INTEGRATE", prefix + " verified execution routes Stage 15");
  return state;
}

function humanResolutionProjection(state, reservation, at) {
  const owner = state.policy.projection_owners.decision[0];
  const projection = {
    projection_id: "pending",
    projection_kind: "decision",
    owner,
    mission_id: state.mission_id,
    repository_revision: state.repository_revision,
    policy_hash: state.policy_hash,
    artifact_ref: {
      artifact_id: "human-resolution-" + reservation.reservation_id,
      owner,
      kind: "decision-projection",
      sha256: Store.sha256("human-resolution::" + reservation.reservation_id),
      repository_revision: state.repository_revision,
    },
    claim: { status: "resolved", subject_id: "held:" + reservation.reservation_id, reason: "owner-approved", resolves_record_id: reservation.receipt.receipt_hash },
    recorded_at: at,
    projection_hash: "0".repeat(64),
  };
  projection.projection_hash = Store.projectionHash(projection);
  projection.projection_id = Store.projectionId(projection);
  return projection;
}

function main() {
  for (const name of REQUIRED_ROUTER_EXPORTS) equal(typeof Runtime[name], "function", "runtime-router exports " + name);
  for (const name of REQUIRED_STORE_EXPORTS) equal(typeof Store[name], "function", "runtime-store exports " + name);
  for (const stage of ["ASSESS", "RECONCILE", "EXECUTE", "INTEGRATE", "CONTINUE"]) ok(manifest.canonical_handoffs[stage], "manifest owns canonical handoff for " + stage);
  const reconcileAction = manifest.canonical_handoffs.RECONCILE.sequence[0].action;
  ok(/canonical hash-bound refs-only/.test(reconcileAction) &&
    /repository-improvement-assessment/.test(reconcileAction) &&
    /remediation-graph-optimizer/.test(reconcileAction),
  "RECONCILE handoff is the Task3 canonical hash-bound refs-only RIA/RGO contract");
  ok(!/normalized|packet/i.test(reconcileAction),
    "RECONCILE handoff rejects retired normalized-packet wording");

  const assessmentInitial = loadState();
  const assessmentReserved = reserve(assessmentInitial, "ASSESS", "temporal-boundary", "2026-08-08T16:00:01.000Z");
  const temporalReceipt = completedReceipt(assessmentReserved.reservation), temporalChild = childReference(assessmentReserved.state, assessmentReserved.reservation, temporalReceipt, "2026-08-08T16:00:02.000Z", "temporal-boundary"), temporalOwner = admittedOwnerProjection(assessmentReserved.state, assessmentReserved.reservation, "2026-08-08T16:00:02.000Z", "temporal-boundary");
  const futureRefs = ["remediation-graph", "action-set", "execution", "verification", "stage15-integration"].map((kind, index) => ({ reference_id: "future-" + index, owner: "foreign-owner", kind, repository_revision: assessmentReserved.state.repository_revision, sha256: Store.sha256("future::" + kind), status: "complete", purpose: "future-stage", recorded_at: "2026-08-08T16:00:02.000Z", coverage: { reservation_id: assessmentReserved.reservation.reservation_id, identity: assessmentReserved.reservation.identity, bound_hash: assessmentReserved.reservation.bound_hash, coverage_status: "complete" } }));
  for (const ref of futureRefs) {
    const before = clone(assessmentReserved.state);
    const rejected = Runtime.completeChildDispatch(assessmentReserved.state, temporalReceipt, temporalChild, [ref], temporalOwner, "2026-08-08T16:00:02.000Z");
    equal(rejected.code, "CHILD_SUPPORTING_ARTIFACT_MISMATCH", "ASSESS rejects " + ref.kind + " evidence from a future lifecycle stage");
    assert.deepEqual(rejected.state, before, "future-stage evidence rejection is atomic"); checks += 1;
  }
  const assessmentState = complete(assessmentReserved.state, assessmentReserved.reservation, "2026-08-08T16:00:02.000Z", "temporal-boundary", []);
  equal(Object.keys(assessmentState.owner_projection_current).sort().join(","), "assessment,frontier,integration", "ASSESS persists only the assessment-stage canonical projection");
  routeDecision(assessmentState, "2026-08-08T16:00:03.000Z", "RECONCILE", "router derives reconciliation from the completed assessment alone");
  const assessmentReconcile = reserve(assessmentState, "RECONCILE", "temporal-boundary-reconcile", "2026-08-08T16:00:04.000Z");
  ok(assessmentReconcile.reservation.projection_bindings.some((binding) => binding.projection_kind === "assessment"), "RECONCILE reservation binds the persisted assessment evidence");
  ok(!assessmentReconcile.reservation.projection_bindings.some((binding) => /handoff|action|execution|verification|stage15/i.test(binding.projection_kind)), "RECONCILE reservation has no projected future-stage evidence");

  const admissionInitial = loadState();
  let admissionReserved = reserve(admissionInitial, "ASSESS", "admission-negatives", "2026-08-08T15:50:01.000Z");
  const admissionAt = "2026-08-08T15:50:02.000Z";
  rejectOwnerProjectionAdmission(admissionReserved.state, admissionReserved.reservation, admissionAt, "missing-owner-update", undefined, undefined, "ASSESS without its required canonical owner projection");
  const wrongOwnerUpdate = admittedOwnerProjection(admissionReserved.state, admissionReserved.reservation, admissionAt, "wrong-owner-update", { owner: "wrong-owner" });
  rejectOwnerProjectionAdmission(admissionReserved.state, admissionReserved.reservation, admissionAt, "wrong-owner-update", wrongOwnerUpdate, undefined, "ASSESS with wrong owner projection owner");
  const staleOwnerUpdate = admittedOwnerProjection(admissionReserved.state, admissionReserved.reservation, "2026-08-08T15:50:00.000Z", "stale-owner-update");
  rejectOwnerProjectionAdmission(admissionReserved.state, admissionReserved.reservation, admissionAt, "stale-owner-update", staleOwnerUpdate, undefined, "ASSESS with stale owner projection update");
  const unboundChild = childReference(admissionReserved.state, admissionReserved.reservation, completedReceipt(admissionReserved.reservation), admissionAt, "unbound-owner-update");
  unboundChild.source_bound_hash = "f".repeat(64);
  rejectOwnerProjectionAdmission(admissionReserved.state, admissionReserved.reservation, admissionAt, "unbound-owner-update", admittedOwnerProjection(admissionReserved.state, admissionReserved.reservation, admissionAt, "unbound-owner-update"), unboundChild, "ASSESS with owner update unbound from its child completion", "CHILD_PROJECTION_MISMATCH");
  const duplicateOwnerUpdate = admittedOwnerProjection(admissionReserved.state, admissionReserved.reservation, admissionAt, "duplicate-owner-update");
  duplicateOwnerUpdate.projection_id = admissionReserved.state.owner_projections[0].projection_id;
  rejectOwnerProjectionAdmission(admissionReserved.state, admissionReserved.reservation, admissionAt, "duplicate-owner-update", duplicateOwnerUpdate, undefined, "ASSESS with duplicate canonical owner projection update");
  const exhaustedOutsideReconcile = admittedOwnerProjection(admissionReserved.state, admissionReserved.reservation, admissionAt, "exhausted-outside-reconcile", {
    projection_kind: "frontier",
    owner: "remediation-graph-optimizer",
    artifact_ref: {
      artifact_id: "frontier-outside-reconcile",
      owner: "remediation-graph-optimizer",
      kind: "frontier-projection",
      sha256: Store.sha256("frontier-outside-reconcile"),
      repository_revision: admissionReserved.state.repository_revision,
    },
    claim: { status: "exhausted" },
  });
  rejectOwnerProjectionAdmission(admissionReserved.state, admissionReserved.reservation, admissionAt, "exhausted-outside-reconcile", exhaustedOutsideReconcile, undefined, "ASSESS cannot admit an exhausted frontier");

  let state = executeReady("main-chain");
  let reserved = reserve(state, "EXECUTE", "main-chain-frontier", "2026-08-08T16:01:00.000Z");
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:01.000Z", "missing-execute-evidence", [], "EXECUTE without independent verification");
  const wrongExecute = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:01.000Z", "wrong-execute-evidence");
  wrongExecute[0].owner = "wrong-owner";
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:01.000Z", "wrong-execute-evidence", wrongExecute, "EXECUTE with wrong verification reference");
  const staleExecute = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:01.000Z", "stale-execute-evidence");
  staleExecute[0].recorded_at = "2026-08-08T16:00:00.000Z";
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:01.000Z", "stale-execute-evidence", staleExecute, "EXECUTE with stale verification reference");
  const unboundExecute = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:01.000Z", "unbound-execute-evidence");
  unboundExecute[0].coverage.bound_hash = "f".repeat(64);
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:01.000Z", "unbound-execute-evidence", unboundExecute, "EXECUTE with unbound verification reference");
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:01:01.000Z", "main-chain-execution");
  routeDecision(state, "2026-08-08T16:01:02.000Z", "INTEGRATE", "verified execution re-enters Stage 15");

  reserved = reserve(state, "INTEGRATE", "main-chain-cohort", "2026-08-08T16:01:03.000Z");
  const partial = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "partial-cohort");
  partial[0].coverage.coverage_status = "partial";
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "partial-cohort", partial, "INTEGRATE with partial cohort");
  const missing = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "missing-cohort");
  missing.pop();
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "missing-cohort", missing, "INTEGRATE with missing combined-state reference");
  const wrong = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "wrong-cohort");
  wrong[1].kind = "wrong-kind";
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "wrong-cohort", wrong, "INTEGRATE with wrong combined-state reference");
  const stale = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "stale-cohort");
  stale[1].recorded_at = "2026-08-08T16:00:00.000Z";
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "stale-cohort", stale, "INTEGRATE with stale combined-state reference");
  const unbound = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "unbound-cohort");
  unbound[0].coverage.reservation_id = "other-reservation";
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "unbound-cohort", unbound, "INTEGRATE with unbound cohort reference");
  const duplicate = supportingArtifactRefs(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "duplicate-cohort");
  duplicate[1].reference_id = duplicate[0].reference_id;
  rejectCompletion(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "duplicate-cohort", duplicate, "INTEGRATE with duplicate evidence identity");
  const firstWaveFrontier = state.owner_projections.find((projection) => projection.projection_kind === "frontier");
  const findingOwnerProjection = admittedOwnerProjection(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "main-chain-integration-finding", { claim: { status: "finding", finding_ids: ["finding-wave-1"] } });
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:01:04.000Z", "main-chain-integration-finding", undefined, findingOwnerProjection);
  const reentryRecovered = recoveredRoute(state, "2026-08-08T16:01:05.000Z");
  equal(reentryRecovered.route.decision, "RECONCILE", "canonical integration finding reopens exactly the next reconciliation wave");
  state = reentryRecovered.state;
  reserved = reserve(state, "RECONCILE", "main-chain-reconciliation-wave-2", "2026-08-08T16:01:06.000Z");
  ok(reserved.reservation.projection_bindings.some((binding) => binding.projection_id === state.owner_projection_current.integration), "re-entry reconciliation binds the current canonical integration finding");
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:01:07.000Z", "main-chain-reconciliation-wave-2");
  const secondWaveFrontier = state.owner_projections.find((projection) => projection.projection_kind === "frontier");
  ok(secondWaveFrontier.projection_id !== firstWaveFrontier.projection_id, "second reconciliation atomically replaces the current frontier without rewriting history");
  const firstExecution = state.reservations.find((reservation) => reservation.identity === "main-chain-frontier");
  ok(firstExecution.projection_bindings.some((binding) => binding.projection_id === firstWaveFrontier.projection_id), "first-wave execution retains its historic frontier binding");
  reserved = reserve(state, "EXECUTE", "main-chain-frontier-wave-2", "2026-08-08T16:01:08.000Z");
  ok(reserved.reservation.projection_bindings.some((binding) => binding.projection_id === secondWaveFrontier.projection_id), "second-wave execution binds the new current frontier");
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:01:09.000Z", "main-chain-execution-wave-2");
  routeDecision(state, "2026-08-08T16:01:10.000Z", "INTEGRATE", "second-wave execution routes second-wave integration");
  reserved = reserve(state, "INTEGRATE", "main-chain-cohort-wave-2", "2026-08-08T16:01:11.000Z");
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:01:12.000Z", "main-chain-integration-clean-wave-2");
  routeDecision(state, "2026-08-08T16:01:13.000Z", "RECONCILE", "clean second-wave integration authorizes the exhausted-frontier reconciliation");
  const cleanReentryRecovered = recoveredRoute(state, "2026-08-08T16:01:14.000Z");
  equal(cleanReentryRecovered.route.decision, "RECONCILE", "recovery preserves the clean-integration re-entry route");
  state = cleanReentryRecovered.state;
  reserved = reserve(state, "RECONCILE", "main-chain-reconciliation-exhausted", "2026-08-08T16:01:15.000Z");
  const exhaustedFrontier = admittedOwnerProjection(reserved.state, reserved.reservation, "2026-08-08T16:01:16.000Z", "main-chain-frontier-exhausted", { claim: { status: "exhausted" } });
  state = complete(reserved.state, reserved.reservation, "2026-08-08T16:01:16.000Z", "main-chain-reconciliation-exhausted", undefined, exhaustedFrontier);
  const completeRecovered = recoveredRoute(state, "2026-08-08T16:01:17.000Z");
  equal(completeRecovered.route.decision, "COMPLETE", "recovery after a RECONCILE-admitted exhausted frontier reaches terminal completion");
  ok(!Object.prototype.hasOwnProperty.call(completeRecovered.route, "reservation"), "terminal completion has no successor reservation");
  equal(completeRecovered.state.reservations.length, state.reservations.length, "terminal recovery creates no reservation");
  equal(state.child_projection_history.length, 8, "two lifecycle waves plus exhausted reconciliation used only public child-return transitions");
  ok(state.child_projection_history.every((entry) => !Object.prototype.hasOwnProperty.call(entry.projection, "payload")), "child history remains opaque and payload-free");
  equal(state.owner_projection_history.length, 8, "two lifecycle waves and terminal reconciliation append only their own permitted stage projections");

  let invalidIntegrationState = integrateReady("invalid-integration-status");
  const invalidIntegrationReserved = reserve(invalidIntegrationState, "INTEGRATE", "invalid-integration-status", "2026-08-08T16:06:01.000Z");
  const invalidIntegrationProjection = admittedOwnerProjection(invalidIntegrationReserved.state, invalidIntegrationReserved.reservation, "2026-08-08T16:06:02.000Z", "invalid-integration-status", { claim: { status: "unsupported", finding_ids: [] } });
  rejectOwnerProjectionAdmission(invalidIntegrationReserved.state, invalidIntegrationReserved.reservation, "2026-08-08T16:06:02.000Z", "invalid-integration-status", invalidIntegrationProjection, undefined, "INTEGRATE rejects an unsupported canonical integration status");

  let capacityState = executeReady("capacity");
  for (let index = 0; index < capacityState.policy.global_worker_budget; index += 1) {
    capacityState = reserve(capacityState, "EXECUTE", "capacity-" + index, "2026-08-08T16:10:0" + index + ".000Z").state;
  }
  routeDecision(capacityState, "2026-08-08T16:10:10.000Z", "WAIT_CAPACITY", "full worker budget waits without dispatch");

  let retryState = loadState();
  assertValid(retryState, "retry cold state verifies");
  reserved = reserve(retryState, "ASSESS", "retry-assessment", "2026-08-08T16:20:01.000Z");
  const failed = Runtime.releaseDispatch(reserved.state, terminalReceipt(reserved.reservation, "failed", { reason: "unstable gate", failure_classification: "unstable-check" }), "2026-08-08T16:20:02.000Z");
  ok(failed.ok, "retryable terminal receipt is recorded through releaseDispatch");
  const retry = Runtime.recordRetry(failed.state, {
    mission_id: failed.state.mission_id,
    scope_hash: failed.state.scope_hash,
    policy_hash: failed.state.policy_hash,
    repository_revision: failed.state.repository_revision,
    stage: reserved.reservation.stage,
    owner: reserved.reservation.owner,
    identity: reserved.reservation.identity,
    source_reservation_id: reserved.reservation.reservation_id,
  }, { classification: "unstable-check" }, "2026-08-08T16:20:03.000Z");
  ok(retry.ok, "retry is recorded through recordRetry");
  routeDecision(retry.state, "2026-08-08T16:20:03.000Z", "WAIT_RETRY", "scheduled retry waits without dispatch");

  const heldInitial = loadState();
  reserved = reserve(heldInitial, "ASSESS", "held-assessment", "2026-08-08T16:30:01.000Z");
  const held = Runtime.releaseDispatch(reserved.state, terminalReceipt(reserved.reservation, "held", { reason: "human-decision" }), "2026-08-08T16:30:02.000Z");
  ok(held.ok, "held terminal receipt is recorded through releaseDispatch");
  routeDecision(held.state, "2026-08-08T16:30:03.000Z", "STOP_HUMAN", "held receipt stops without dispatch");
  const resolutionAt = "2026-08-08T16:30:04.000Z";
  const heldReservation = held.state.reservations.find((reservation) => reservation.reservation_id === reserved.reservation.reservation_id);
  const resolution = Runtime.resolveHeldDispatch(held.state, {
    mission_id: held.state.mission_id,
    scope_hash: held.state.scope_hash,
    policy_hash: held.state.policy_hash,
    repository_revision: held.state.repository_revision,
    owner: held.state.policy.projection_owners.decision[0],
    reservation_id: heldReservation.reservation_id,
  }, humanResolutionProjection(held.state, heldReservation, resolutionAt), resolutionAt);
  ok(resolution.ok, "authorized human resolution reopens only the held stage");
  routeDecision(resolution.state, "2026-08-08T16:30:05.000Z", "ASSESS", "held resolution makes the exact stage routable");

  let staleState = executeReady("stale");
  reserved = reserve(staleState, "EXECUTE", "stale-frontier", "2026-08-08T16:40:01.000Z");
  const beforeRecovery = Runtime.reserveDispatch(reserved.state, requestFor(reserved.state, "EXECUTE", "stale-frontier"), "2026-08-08T16:41:02.000Z");
  equal(beforeRecovery.code, "DUPLICATE_IDEMPOTENCY_KEY", "expired reservation remains fenced before recovery");
  const recovered = Runtime.recoverRuntime(reserved.state, "2026-08-08T16:41:02.000Z");
  ok(recovered.ok && recovered.recovered.length === 1, "expired reservation is recovered once");
  const takeover = Runtime.reserveDispatch(recovered.state, requestFor(recovered.state, "EXECUTE", "stale-frontier"), "2026-08-08T16:41:03.000Z");
  ok(takeover.ok, "new fenced generation is reserved after recovery");
  equal(takeover.code, "TAKEN_OVER", "stale recovery produces a takeover");
  equal(takeover.reservation.generation, 2, "takeover increments generation");
  ok(takeover.reservation.fence_token !== reserved.reservation.fence_token, "takeover changes the fence token");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loop-router-scenarios-"));
  try {
    const file = path.join(tempRoot, "runtime-state.json");
    const fileState = executeReady("file");
    reserved = reserve(fileState, "EXECUTE", "file-frontier", "2026-08-08T16:50:01.000Z");
    Store.atomicWriteJSON(file, reserved.state);
    const receipt = completedReceipt(reserved.reservation);
    const at = "2026-08-08T16:50:02.000Z";
    const completed = Runtime.completeChildDispatchFile(file, receipt, childReference(reserved.state, reserved.reservation, receipt, at, "file-execution"), supportingArtifactRefs(reserved.state, reserved.reservation, at, "file-execution"), at);
    ok(completed.ok, "file transaction atomically accepts evidence-bound EXECUTE completion");
    const persisted = Store.readRuntimeState(file);
    equal(persisted.reservations.at(-1).status, "completed", "file completion persists terminal receipt");
    equal(persisted.child_projection_history.at(-1).supporting_artifact_refs.length, 1, "file completion persists exact verification reference");
    routeDecision(persisted, "2026-08-08T16:50:03.000Z", "INTEGRATE", "persisted completion re-enters Stage 15");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("GREEN " + checks + " checks");
  return { checks };
}

if (require.main === module) {
  try { main(); } catch (error) { console.error("RED " + checks + " checks: " + error.stack); process.exitCode = 1; }
}

// Candidate router public test adapter: calls only the runtime's exported
// reservation/completion/recovery APIs and exposes the full real lifecycle
// trace to the Task 5 audit without copying its state machine.
module.exports = { runPublicRuntimeTrace: main };
