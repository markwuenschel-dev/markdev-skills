"use strict";

/*
 * User-facing control adapters for loop-router.
 *
 * This module deliberately has no state store of its own.  Mission discovery
 * is the canonical repository-owned runtime directory, and every transition
 * goes through shared/orchestration-runtime's locked transaction API.  The
 * compatibility `status(path)` / `graph(path)` forms remain for package tests;
 * user commands should call the repository forms (`getLoopStatus(repo, id)`,
 * `getRemediationGraph(repo, id)`, and `resumeMission(repo, id)`).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const Runtime = require("../../shared/orchestration-runtime/runtime-router");
const Store = require("../../shared/orchestration-runtime/runtime-store");
const Registry = require("../../shared/capability-registry/registry");

const DISPATCHABLE = new Set(["ASSESS", "RECONCILE", "EXECUTE", "INTEGRATE", "CONTINUE"]);
const CRITICAL_CAPABILITIES = new Set(["loop-router", "shared/orchestration-runtime", "independent-verification"]);

function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }
function nowIso(now) {
  const at = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error("CONTROL_NOW_INVALID");
  return at.toISOString();
}
function canonicalRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) throw new Error("REPOSITORY_ROOT_REQUIRED");
  return fs.realpathSync.native(repositoryRoot);
}
function runtimeDirectory(repositoryRoot) {
  return path.join(canonicalRepositoryRoot(repositoryRoot), ".autonomous-loop", "runtime");
}
function repositoryRevision(root, supplied) {
  if (typeof supplied === "string" && supplied.length) return supplied;
  try { return childProcess.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (_) { return "working-tree-" + Store.sha256(root).slice(0, 32); }
}
function bootstrapPolicy(input) {
  const base = {
    global_worker_budget: 8, max_nested_dispatch_depth: 2, lease_ms: 60000, retry_base_delay_ms: 1000, retry_max_attempts: 3,
    stage_owners: { ASSESS: ["repository-improvement-assessment"], RECONCILE: ["loop-router"], EXECUTE: ["production-flywheel"], INTEGRATE: ["action-integration-reassessment"], CONTINUE: ["independent-verification"] },
    stage_requirements: { ASSESS: [], RECONCILE: ["assessment"], EXECUTE: ["assessment", "frontier"], INTEGRATE: ["assessment", "frontier", "integration"], CONTINUE: ["assessment", "frontier", "integration"] },
    stage_predecessors: { ASSESS: [], RECONCILE: ["ASSESS"], EXECUTE: ["RECONCILE"], INTEGRATE: ["EXECUTE"], CONTINUE: ["INTEGRATE"] },
    projection_owners: { assessment: ["repository-improvement-assessment"], frontier: ["remediation-graph-optimizer"], integration: ["shared/action-integration-reassessment"], decision: ["decision-owner"] },
    stage_return_projections: Store.DEFAULT_STAGE_RETURN_PROJECTIONS,
    stage_supporting_artifact_requirements: Store.DEFAULT_STAGE_SUPPORTING_ARTIFACT_REQUIREMENTS,
    stage_owner_projection_admissions: Store.DEFAULT_STAGE_OWNER_PROJECTION_ADMISSIONS,
    integration_finding_reentry: Store.DEFAULT_INTEGRATION_FINDING_REENTRY,
  };
  return Object.assign(base, clone(input || {}));
}
function stateFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map(entry => path.join(directory, entry.name)).sort();
}
function fileSha256(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function isRuntimeFile(value) { return typeof value === "string" && fs.existsSync(value) && fs.statSync(value).isFile(); }

function capabilityNamesForState(state) {
  const names = new Set();
  for (const projection of state.owner_projections || []) if (projection.owner) names.add(projection.owner);
  for (const reservation of state.reservations || []) if (reservation.owner) names.add(reservation.owner);
  for (const retry of state.retries || []) if (retry.owner) names.add(retry.owner);
  for (const stage of Object.keys(state.policy && state.policy.stage_owners || {})) for (const owner of state.policy.stage_owners[stage] || []) names.add(owner);
  names.add("loop-router");
  names.add("shared/orchestration-runtime");
  return [...names].sort();
}
function currentCapabilitySnapshot(root, state, repositoryRoot, namesOverride) {
  try {
    const names = Array.isArray(namesOverride) && namesOverride.length ? namesOverride : Registry.discover(root).packages.map(item => item.name);
    const snapshot = Registry.snapshot(root, names);
    return Object.assign({}, snapshot, {
      artifact_id: "capability-snapshot-" + snapshot.snapshot_sha256.slice(0, 24),
      owner: "shared/capability-registry",
      kind: "capability-snapshot",
      sha256: snapshot.snapshot_sha256,
      registry_revision: "registry-" + snapshot.snapshot_sha256.slice(0, 24),
      registry_schema_version: snapshot.schema_version,
      canonical_root_identity: snapshot.canonical_root,
      captured_at: new Date().toISOString(),
      sha256: snapshot.snapshot_sha256,
    });
  } catch (error) {
    return { error: error.message };
  }
}
function capabilityDrift(root, state, options) {
  const expected = state.capability_snapshot_ref;
  if (!expected) return { classification: "unverifiable", reason: "mission capability snapshot is missing" };
  const configuredSkillsRoot = options && options.skills_root || process.env.AGENT_SKILLS_ROOT || expected.canonical_root_identity;
  let skillsRoot;
  try { skillsRoot = fs.realpathSync.native(configuredSkillsRoot); } catch (error) { return { classification: "unverifiable", reason: "capability root is missing or unreadable: " + error.message }; }
  let historical = null;
  const artifactRoot = state.repository_root || root;
  try {
    const artifactPath = path.join(artifactRoot, ".autonomous-loop", "capability-snapshots", expected.sha256 + ".json");
    if (fs.existsSync(artifactPath)) historical = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  } catch (error) { return { classification: "unverifiable", reason: "capability snapshot artifact is unreadable: " + error.message }; }
  const current = currentCapabilitySnapshot(skillsRoot, state, artifactRoot, historical && historical.capabilities && historical.capabilities.map(item => item.capability || item.name));
  if (current.error) return { classification: "unverifiable", reason: current.error };
  if (current.sha256 === expected.sha256 && current.registry_schema_version === expected.registry_schema_version) return { classification: "identical", expected: clone(expected), current: clone(current) };

  /* If the registry exposes inventory, calculate the affected set.  A missing
   * historical inventory is not guessed: the known singleton authorities are
   * conservatively treated as revalidation-required, while unrelated drift is
   * reported as compatible-drift. */
  const expectedByName = new Map(((historical && historical.capabilities) || expected.capabilities || []).map(item => [item.capability || item.name, item]));
  const currentByName = new Map((current.capabilities || []).map(item => [item.capability || item.name, item]));
  const changed = new Set();
  for (const name of new Set([...expectedByName.keys(), ...currentByName.keys()])) {
    if (JSON.stringify(expectedByName.get(name)) !== JSON.stringify(currentByName.get(name))) changed.add(name);
  }
  if (!changed.size) for (const name of CRITICAL_CAPABILITIES) changed.add(name);
  const affected = [...changed].filter(name => capabilityNamesForState(state).includes(name)).sort();
  const critical = affected.some(name => CRITICAL_CAPABILITIES.has(name));
  return { classification: critical ? "revalidation-required" : "compatible-drift", expected: clone(expected), current: clone(current), changed_capabilities: [...changed].sort(), affected_capabilities: affected };
}

function routeForState(state, now) { return Runtime.routeLifecycle(state, nowIso(now)); }
function classifyRoute(route, state) {
  if (!route) return "unverifiable";
  if (route.decision === "COMPLETE") return "complete";
  if (route.decision === "STOP_USER_REQUESTED" || route.decision === "STOP_SOFT") return "soft-stopped";
  if (route.decision === "STOP_HUMAN") return "human-held";
  if (route.decision === "STOP_UNVERIFIABLE") return "unverifiable";
  if (route.decision === "WAIT_CAPACITY" || route.decision === "WAIT_RETRY") return "waiting";
  if (DISPATCHABLE.has(route.decision)) return "active";
  return state && state.lifecycle && Object.values(state.lifecycle).some(item => item.status === "active") ? "active" : "waiting";
}

function readMission(filePath, now) {
  try {
    const state = Store.readRuntimeState(filePath);
    const route = routeForState(state, now);
    return { ok: true, state, route, status: classifyRoute(route, state), runtime_state_path: filePath };
  } catch (error) {
    return { ok: false, status: "unverifiable", runtime_state_path: filePath, reason: error.message };
  }
}

function discoverActiveMissions(repositoryRoot, now) {
  const root = canonicalRepositoryRoot(repositoryRoot), directory = runtimeDirectory(root);
  const missions = [], invalid = [];
  for (const file of stateFiles(directory)) {
    const loaded = readMission(file, now);
    if (!loaded.ok) { invalid.push({ runtime_state_path: file, status: "unverifiable", reason: loaded.reason }); continue; }
    missions.push({
      mission_id: loaded.state.mission_id,
      scope_hash: loaded.state.scope_hash,
      repository_revision: loaded.state.repository_revision,
      runtime_state_path: file,
      decision: loaded.route.decision,
      status: loaded.status,
      started_at: loaded.state.authorization && loaded.state.authorization.authorized_at,
      last_transition: Object.values(loaded.state.lifecycle || {}).map(item => item.updated_at).filter(Boolean).sort().pop() || null,
      active_reservations: loaded.state.reservations.filter(item => item.status === "active").map(item => ({ reservation_id: item.reservation_id, stage: item.stage, owner: item.owner })),
      capability_snapshot_ref: clone(loaded.state.capability_snapshot_ref || null),
    });
  }
  missions.sort((a, b) => a.mission_id.localeCompare(b.mission_id) || a.runtime_state_path.localeCompare(b.runtime_state_path));
  const resumable = missions.filter(item => !["complete", "terminal-failed"].includes(item.status));
  const result = { repository_root: root, runtime_directory: directory, missions, invalid, active: resumable };
  if (invalid.length) result.decision = "STOP_UNVERIFIABLE";
  else if (resumable.length === 0) result.decision = missions.some(item => item.status === "complete") ? "COMPLETE" : "NO_RESUMABLE_MISSION";
  else if (resumable.length === 1) { result.decision = "RESUME_READY"; result.mission = resumable[0]; }
  else { result.decision = "MISSION_SELECTION_REQUIRED"; result.active = resumable; }
  /* Preserve the compact discovery shape consumed by the existing package test. */
  return Object.freeze(result);
}

function selectMission(repositoryRoot, missionId, now) {
  const found = discoverActiveMissions(repositoryRoot, now);
  if (found.decision === "STOP_UNVERIFIABLE") return { ok: false, result: found };
  const candidates = found.active;
  if (missionId !== undefined && missionId !== null) {
    const selected = candidates.find(item => item.mission_id === missionId);
    if (!selected) return { ok: false, result: Object.assign({}, found, { decision: "MISSION_NOT_FOUND", requested_mission_id: missionId }) };
    return { ok: true, mission: selected, result: found };
  }
  if (candidates.length !== 1) return { ok: false, result: found };
  return { ok: true, mission: candidates[0], result: found };
}

function handoffForStage(stage, reservation, state) {
  const manifestPath = path.join(__dirname, "..", "MANIFEST.json");
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (_) { return { stage, owner: reservation.owner, reservation_id: reservation.reservation_id }; }
  const entry = manifest.canonical_handoffs && manifest.canonical_handoffs[stage];
  return Object.freeze({ stage, owner: reservation.owner, reservation_id: reservation.reservation_id, generation: reservation.generation, fence_token: reservation.fence_token, bound_hash: reservation.bound_hash, repository_revision: state.repository_revision, sequence: clone(entry && entry.sequence || []) });
}

function resumeMission(repositoryRoot, missionId, options) {
  options = options || {};
  const at = nowIso(options.now);
  const selected = selectMission(repositoryRoot, missionId, at);
  if (!selected.ok) return Object.freeze(selected.result);
  const mission = selected.mission, filePath = mission.runtime_state_path;
  let state;
  try { state = Store.readRuntimeState(filePath); } catch (error) { return Object.freeze({ decision: "STOP_UNVERIFIABLE", reason: error.message, mission_id: mission.mission_id }); }
  const drift = capabilityDrift(canonicalRepositoryRoot(repositoryRoot), state, options);
  if (drift.classification === "unverifiable" || drift.classification === "revalidation-required") return Object.freeze({ decision: "STOP_UNVERIFIABLE", reason: drift.reason || "capability drift requires revalidation", mission_id: state.mission_id, capability_drift: drift });

  const recovered = Runtime.transactRuntimeFile(filePath, "recover", {}, at, options.transaction_options);
  if (!recovered.ok) return Object.freeze({ decision: recovered.code === "INVALID_FILE_STATE" ? "STOP_UNVERIFIABLE" : recovered.code, mission_id: state.mission_id, error: recovered.error, capability_drift: drift });
  state = recovered.state;
  if (state.soft_stop && state.soft_stop.phase === "effective") {
    const clearPayload = { mission_id: state.mission_id, scope_hash: state.scope_hash, policy_hash: state.policy_hash, repository_revision: state.repository_revision, requested_by: options.requested_by || "user" };
    const cleared = Runtime.transactRuntimeFile(filePath, "clear-soft-stop", clearPayload, at, options.transaction_options);
    if (!cleared.ok) return Object.freeze({ decision: cleared.code === "SOFT_STOP_WAVE_ACTIVE" ? "STOP_USER_REQUESTED" : "STOP_UNVERIFIABLE", mission_id: state.mission_id, route: cleared.route, reason: cleared.reason || cleared.code, capability_drift: drift });
    state = cleared.state;
  } else if (state.soft_stop) {
    const pendingRoute = routeForState(state, at);
    return Object.freeze({ decision: pendingRoute.decision === "WAIT_SOFT_STOP" ? "WAIT_SOFT_STOP" : "STOP_USER_REQUESTED", mission_id: state.mission_id, route: pendingRoute, capability_drift: drift, reason: "soft stop is still draining the current wave" });
  }
  const route = routeForState(state, at);
  const base = { mission_id: state.mission_id, repository_revision: state.repository_revision, capability_drift: drift, route };
  if (!DISPATCHABLE.has(route.decision)) return Object.freeze(Object.assign(base, { decision: route.decision, state: undefined }));
  const stage = route.decision, owner = (state.policy.stage_owners[stage] || [])[0];
  if (!owner) return Object.freeze({ decision: "STOP_UNVERIFIABLE", reason: "no canonical owner for " + stage, mission_id: state.mission_id });
  const identity = "router-resume::" + stage + "::" + state.repository_revision;
  const request = { mission_id: state.mission_id, scope_hash: state.scope_hash, policy_hash: state.policy_hash, repository_revision: state.repository_revision, stage, owner, identity, idempotency_key: Runtime.makeIdempotencyKey(state.mission_id, stage, state.repository_revision, identity), projection_bindings: Runtime.projectionBindingsForStage(state, stage), nested: false, ancestors: [], lease_ms: state.policy.lease_ms };
  const reserved = Runtime.transactRuntimeFile(filePath, "reserve", request, at, options.transaction_options);
  if (!reserved.ok) return Object.freeze(Object.assign(base, { decision: reserved.code, route: reserved.route || route, reason: reserved.reason }));
  return Object.freeze(Object.assign(base, { decision: stage, reservation: clone(reserved.reservation), handoff: handoffForStage(stage, reserved.reservation, reserved.state) }));
}

function startMission(repositoryRoot, authorization, policy, options) {
  options = options || {};
  const root = canonicalRepositoryRoot(repositoryRoot), found = discoverActiveMissions(root, options.now);
  if (found.active && found.active.length) return Object.freeze({ decision: "MISSION_CONFLICT", missions: found.active });
  authorization = authorization && typeof authorization === "object" ? authorization : {};
  const at = nowIso(options.now), missionId = authorization.mission_id || "RIA-" + Store.sha256(root + "::" + at).slice(0, 24);
  const scopeHash = authorization.scope_hash && /^[a-f0-9]{64}$/.test(authorization.scope_hash) ? authorization.scope_hash : Store.sha256({ repository_root: root, scope: authorization.scope || "repository-improvement-assessment" });
  const revision = repositoryRevision(root, authorization.repository_revision);
  const skillsRoot = canonicalRepositoryRoot(options.skills_root || process.env.AGENT_SKILLS_ROOT || path.join(__dirname, "..", ".."));
  let snapshotRef;
  try { snapshotRef = Registry.snapshotRef(skillsRoot, undefined, { repository_root: root }); } catch (error) { return Object.freeze({ decision: "STOP_UNVERIFIABLE", reason: "capability snapshot capture failed: " + error.message, mission_id: missionId }); }
  const request = { mission_id: missionId, scope_hash: scopeHash, repository_revision: revision, repository_root: root, authorization: { authorized_by: authorization.authorized_by || "user", authorized_at: authorization.authorized_at || at }, policy: bootstrapPolicy(policy), capability_snapshot_ref: snapshotRef };
  const filePath = path.join(runtimeDirectory(root), missionId.replace(/[^A-Za-z0-9._-]/g, "_") + ".json");
  const result = Runtime.startMissionFile(filePath, request, at);
  if (!result.ok) return Object.freeze({ decision: result.code, reason: result.error, mission_id: missionId });
  return Object.freeze({ decision: "ASSESS", mission_id: missionId, repository_root: root, runtime_state_path: filePath, reservation: clone(result.reservation), route: result.route, capability_snapshot_ref: clone(snapshotRef) });
}

function statusFromPath(runtimeStatePath, now) {
  const before = fileSha256(runtimeStatePath), state = Store.readRuntimeState(runtimeStatePath), route = routeForState(state, now), after = fileSha256(runtimeStatePath);
  if (before !== after) throw new Error("STATUS_MUTATED_RUNTIME_STATE");
  const current = Object.fromEntries((state.owner_projections || []).map(item => [item.projection_kind, { projection_id: item.projection_id, artifact_ref: clone(item.artifact_ref), claim: clone(item.claim), owner: item.owner }]));
  return Object.freeze({
    mission_id: state.mission_id, repository_root: state.repository_root || null, repository_revision: state.repository_revision,
    capability_snapshot_ref: clone(state.capability_snapshot_ref || null), lifecycle: clone(state.lifecycle), decision: route,
    active_reservations: state.reservations.filter(item => item.status === "active").map(clone), active_agents: "canonical runtime does not persist agent identities",
    retries: clone(state.retries), runtime_stops: clone(state.runtime_stops), soft_stop: clone(state.soft_stop || null), current_projections: current,
    current_frontier: current.frontier || null, human_decisions: (state.owner_projections || []).filter(item => item.projection_kind === "decision").map(clone),
    capacity: clone(state.capacity), remaining_autonomous_work: route.decision, publish_policy: clone(state.publish_policy || null), runtime_state_sha256: after,
  });
}

function getLoopStatus(repositoryRoot, missionId, now) {
  if (isRuntimeFile(repositoryRoot)) return statusFromPath(repositoryRoot, missionId);
  const selected = selectMission(repositoryRoot, missionId, now);
  if (!selected.ok) return selected.result;
  return statusFromPath(selected.mission.runtime_state_path, now);
}

function graphFromPath(runtimeStatePath) {
  const before = fileSha256(runtimeStatePath), state = Store.readRuntimeState(runtimeStatePath), frontier = state.owner_projections.find(item => item.projection_kind === "frontier"), after = fileSha256(runtimeStatePath);
  if (before !== after) throw new Error("GRAPH_MUTATED_RUNTIME_STATE");
  return frontier ? Object.freeze({ decision: "GRAPH_AVAILABLE", graph_ref: clone(frontier.artifact_ref), frontier_projection_id: frontier.projection_id, frontier_claim: clone(frontier.claim), execution_state_overlay: "resolved by action-graph owner; not recomputed here", runtime_state_sha256: after }) : Object.freeze({ decision: "GRAPH_NOT_AVAILABLE", reason: "RECONCILE has not admitted a frontier projection", runtime_state_sha256: after });
}
function getRemediationGraph(repositoryRoot, missionId) {
  if (isRuntimeFile(repositoryRoot)) return graphFromPath(repositoryRoot);
  const selected = selectMission(repositoryRoot, missionId);
  if (!selected.ok) return selected.result;
  return graphFromPath(selected.mission.runtime_state_path);
}

function resolveDecision(repositoryRoot, missionId, decisionId, answer, options) {
  options = options || {};
  if (typeof decisionId !== "string" || !decisionId || typeof answer !== "string" || !answer) return Object.freeze({ decision: "STOP_HUMAN", reason: "decision id and answer are required" });
  const selected = selectMission(repositoryRoot, missionId, options.now);
  if (!selected.ok) return Object.freeze(selected.result);
  const filePath = selected.mission.runtime_state_path, state = Store.readRuntimeState(filePath), route = routeForState(state, options.now);
  const graph = state.owner_projections.find(item => item.projection_kind === "frontier");
  if (!graph) return Object.freeze({ decision: "STOP_HUMAN", reason: "current remediation graph is not admitted", mission_id: state.mission_id });
  const predecessor = graph.projection_hash;
  const payload = { mission_id: state.mission_id, scope_hash: state.scope_hash, policy_hash: state.policy_hash, repository_revision: state.repository_revision, owner: options.owner || "decision-owner", decision_id: decisionId, graph_ref: graph.artifact_ref, answer, answer_sha256: Store.sha256(answer), predecessor_projection_hash: predecessor };
  const result = Runtime.transactRuntimeFile(filePath, "resolve-decision", payload, nowIso(options.now), options.transaction_options);
  if (!result.ok) return Object.freeze({ decision: result.code === "DECISION_NOT_FOUND" ? "STOP_HUMAN" : result.code, reason: result.reason || result.code, mission_id: state.mission_id, route });
  const nextRoute = routeForState(result.state, options.now);
  return Object.freeze({ decision: nextRoute.decision, transaction_code: result.code, mission_id: state.mission_id, decision_receipt: clone(result.decision_receipt), route: nextRoute });
}
function admitDecision(repositoryRoot, missionId, decisionRef, options) {
  options = options || {};
  const selected = selectMission(repositoryRoot, missionId, options.now);
  if (!selected.ok) return Object.freeze(selected.result);
  if (!decisionRef || typeof decisionRef !== "object" || typeof decisionRef.decision_id !== "string") return Object.freeze({ decision: "STOP_HUMAN", reason: "closed graph decision reference is required" });
  const filePath = selected.mission.runtime_state_path, state = Store.readRuntimeState(filePath), graph = state.owner_projections.find(item => item.projection_kind === "frontier");
  if (!graph) return Object.freeze({ decision: "STOP_HUMAN", reason: "current remediation graph is not admitted", mission_id: state.mission_id });
  const payload = { mission_id: state.mission_id, scope_hash: state.scope_hash, policy_hash: state.policy_hash, repository_revision: state.repository_revision, owner: options.owner || "decision-owner", decision_id: decisionRef.decision_id, graph_ref: graph.artifact_ref, decision_ref: clone(decisionRef), status: "hold", predecessor_projection_hash: graph.projection_hash, reason: decisionRef.reason || "graph human decision", owner_metadata: clone(options.owner_metadata || {}) };
  const result = Runtime.transactRuntimeFile(filePath, "admit-decision", payload, nowIso(options.now), options.transaction_options);
  return Object.freeze({ decision: result.ok ? "STOP_HUMAN" : result.code, mission_id: state.mission_id, decision_projection: clone(result.decision_projection), route: result.route });
}

function requestStopAfterCurrentWave(repositoryRoot, missionId, options) {
  options = options || {};
  const selected = selectMission(repositoryRoot, missionId, options.now);
  if (!selected.ok) return Object.freeze(selected.result);
  const state = Store.readRuntimeState(selected.mission.runtime_state_path), at = nowIso(options.now);
  const payload = { mission_id: state.mission_id, scope_hash: state.scope_hash, policy_hash: state.policy_hash, repository_revision: state.repository_revision, requested_by: options.requested_by || "user", mode: "after-current-wave", request_id: options.request_id || "soft-stop-" + Store.sha256(state.mission_id + "::" + at).slice(0, 24) };
  const result = Runtime.transactRuntimeFile(selected.mission.runtime_state_path, "request-soft-stop", payload, at, options.transaction_options);
  return Object.freeze({ decision: result.ok ? "STOP_USER_REQUESTED" : result.code, mission_id: state.mission_id, soft_stop: result.soft_stop || (result.state && result.state.soft_stop), route: result.route });
}

function clearSoftStopAndResume(repositoryRoot, missionId, options) { return resumeMission(repositoryRoot, missionId, options); }
function auditSkillWiring(options) {
  options = options || {};
  const root = options.root || options.skillsRoot || process.env.AGENT_SKILLS_ROOT;
  if (!root) throw new Error("AUDIT_SKILL_ROOT_REQUIRED");
  return require("./wiring-audit").audit(root, options);
}

/* Legacy aliases are intentionally read-only and do not expose a state-write
 * primitive.  They make the existing package contract additive rather than a
 * second control surface. */
function status(runtimeStatePath, now) { return statusFromPath(runtimeStatePath, now); }
function graph(runtimeStatePath) { return graphFromPath(runtimeStatePath); }

module.exports = {
  runtimeDirectory,
  discoverActiveMissions,
  resumeMission,
  startMission,
  getLoopStatus,
  getRemediationGraph,
  resolveDecision,
  admitDecision,
  requestStopAfterCurrentWave,
  clearSoftStopAndResume,
  auditSkillWiring,
  status,
  graph,
  capabilityDrift,
};
