#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildBaseline, verifyBaseline, writeBaseline } = require("../baseline.js");
const { validateAssessProjection } = require("../engineering-intelligence-assessment.js");
const { validateOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const { buildExecutionPlan } = require("./build-execution-plan.js");
const { executePlan, FileArtifactCache } = require("./execution-runtime.js");
const { buildSeiTelemetrySummary, unavailable: unavailableSeiTelemetry } = require("./sei-telemetry-summary.js");
const { buildPerformanceReceipt, unavailablePerformanceReceipt } = require("./performance-receipt.js");
const projectWorkspace = require("../../shared/project-intelligence-workspace/project-intelligence-workspace.js");
const { resolveStartup } = require("./startup-resolver.js");
const { persistAssessmentArtifacts } = require("./assess-persistence.js");

const OWNER_TASKS = Object.freeze({
  "owner-health": "repository-health-assessment",
  "owner-integrity": "codebase-integrity-audit-loop",
  "owner-architecture": "architecture-improvement-intelligence",
});
const SOURCE_TASKS = new Set(["sei-snapshot", "sei-assessment", "verification-baseline", ...Object.keys(OWNER_TASKS), "report-data", "report-render"]);
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function atomicJson(filePath, value) { const target = path.resolve(filePath); fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`; try { fs.writeFileSync(temporary, `${JSON.stringify(canonical(value), null, 2)}\n`, { flag: "wx" }); fs.renameSync(temporary, target); } finally { try { fs.rmSync(temporary, { force: true }); } catch {} } return target; }
function fail(code, message) { const error = new Error(`${code}: ${message}`); error.code = code; throw error; }
function firstRoot(request) { const roots = request.repository?.roots ?? (request.repository?.root ? [request.repository.root] : []); if (!Array.isArray(roots) || roots.length === 0) fail("FAIL-RIA-REQUEST", "repository.root or repository.roots is required"); return path.resolve(roots[0]); }
function contractDigest(owner) {
  const filePath = path.resolve(__dirname, "..", "..", owner, "RUNTIME-CONTRACT.json");
  const bytes = fs.readFileSync(filePath);
  return { owner, version: JSON.parse(bytes.toString("utf8")).version, runtime_contract_sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
function collectOwnerRendezvous(runDirectory, failures) {
  const pending = (failures || []).filter((failure) => failure.code === "OWNER_RETURN_PENDING");
  if (!pending.length) return null;
  const envelopes = {};
  const return_paths = {};
  for (const owner of Object.values(OWNER_TASKS)) {
    const envelope = path.join(runDirectory, "owner-inputs", `${owner}-envelope.json`);
    const destination = path.join(runDirectory, "owner-returns", `${owner}.json`);
    if (fs.existsSync(envelope)) envelopes[owner] = envelope;
    return_paths[owner] = destination;
  }
  return {
    schema_version: "ria.owner-rendezvous@1",
    envelopes,
    return_paths,
    instruction: "Dispatch each missing owner skill with the matching envelope JSON. Persist ria.owner-return@1 at return_paths, then rerun with lifecycle continue and the returned state_path.",
  };
}
function baselineRef(baseline) { return { artifact_id: baseline.artifact_id, sha256: baseline.content_sha256, repository_revision: baseline.repository.revision }; }
function terminalCount(plan, events) { const terminal = new Set(["reused", "completed", "failed", "blocked", "cancelled"]); return new Set(events.filter((event) => terminal.has(event.status)).map((event) => event.task_id)).size === plan.tasks.length; }

function normalizedRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("FAIL-RIA-REQUEST", "request must be an object");
  const root = firstRoot(input);
  const runtimeRoot = path.resolve(input.runtime_root ?? path.join(root, ".project-intelligence", "assessments", "ria", "runtime"));
  return canonical({
    ...input,
    repository: input.repository,
    durable_mode: input.durable_mode ?? "git",
    scope: input.scope ?? ((input.durable_mode ?? "git") === "git" ? "head" : "worktree"),
    lifecycle: input.lifecycle ?? input.mode ?? "run",
    depth: input.depth ?? "standard",
    presentation_policy: input.presentation_policy ?? "skip",
    allow_degraded: input.allow_degraded === true,
    reuse_controls: input.reuse_controls ?? {},
    generated_protected_paths: input.generated_protected_paths ?? [],
    verification_contract: input.verification_contract ?? {},
    runtime_root: runtimeRoot,
  });
}

function adapterHandlers(adapter, context) {
  const resolved = typeof adapter?.createAdapter === "function" ? adapter.createAdapter(context) : adapter;
  const handlers = resolved?.handlers ?? resolved ?? {};
  if (!handlers || typeof handlers !== "object") fail("FAIL-RIA-ADAPTER", "adapter must expose handlers");
  for (const [taskId, handler] of Object.entries(handlers)) {
    if (!SOURCE_TASKS.has(taskId) || typeof handler !== "function") fail("FAIL-RIA-ADAPTER", `unsupported handler ${taskId}`);
  }
  return handlers;
}

async function executeRia(input, adapter = {}) {
  const request = normalizedRequest(input);
  if (request.durable_mode === "git") {
    for (const root of request.repository?.roots ?? [request.repository.root]) projectWorkspace.ensureWorkspace(root);
  }
  fs.mkdirSync(request.runtime_root, { recursive: true });
  const baseline = buildBaseline({
    repository: request.repository,
    durable_mode: request.durable_mode,
    scope: request.scope,
    generated_protected_paths: request.generated_protected_paths,
    command_authorization: request.command_authorization,
    verification_contract: request.verification_contract,
    sei_compatibility_binding: request.sei_compatibility_binding,
    history_binding: request.history_binding,
    environment_toolchain: request.environment_toolchain,
    provenance: request.provenance,
  });
  const baseline_ref = baselineRef(baseline);
  const startup_resolution = request.startup_resolution ?? resolveStartup({
    durable_mode: request.durable_mode,
    repository: { root: firstRoot(request) },
    engine_version: baseline.sei_compatibility_binding?.engine_version,
    config_hash: baseline.sei_compatibility_binding?.config_hash,
    execution_contract_hash: baseline.sei_compatibility_binding?.execution_contract_hash,
    compatibility_binding: baseline.sei_compatibility_binding,
    baseline_ref,
    verification: {
      version: "assessment-verification-baseline@2",
      contract_hash: crypto.createHash("sha256").update(JSON.stringify(canonical(request.verification_contract ?? {}))).digest("hex"),
      config_hash: baseline.sei_compatibility_binding?.config_hash,
    },
    owners: Object.values(OWNER_TASKS).map(contractDigest),
  });
  const plan = buildExecutionPlan({
    ...request,
    baseline_ref,
    startup_resolution,
  });
  if (request.lifecycle === "plan") return Object.freeze(canonical({ schema_version: "ria.public-result@1", status: "planned", baseline_ref, plan }));

  const runNonce = request.run_nonce ?? crypto.randomUUID();
  if (request.lifecycle === "continue" && !request.state_path) fail("FAIL-RIA-CONTINUE", "continue requires state_path");
  const resumeState = request.lifecycle === "continue" ? JSON.parse(fs.readFileSync(path.resolve(request.state_path), "utf8")) : null;
  const runDirectory = resumeState ? path.dirname(path.resolve(request.state_path)) : path.join(request.runtime_root, "runs", runNonce);
  fs.mkdirSync(runDirectory, { recursive: true });
  const context = { request, baseline, baseline_ref, plan, run_directory: runDirectory, runtime_root: request.runtime_root };
  const external = adapterHandlers(adapter, context);
  const ownerEnvelope = (dependencies = {}, { requireVerification = false } = {}) => {
    const assessmentResult = dependencies["sei-assessment"] ?? null;
    const verificationResult = dependencies["verification-baseline"] ?? null;
    const sei = assessmentResult?.engineering_intelligence_ref ?? context.sei_result?.engineering_intelligence_ref;
    if (!sei) fail("FAIL-RIA-ASSESS-BINDING", "SEI did not return engineering_intelligence_ref");
    const verification = verificationResult?.verification_baseline_ref ?? context.verification_baseline_ref ?? null;
    if (requireVerification && !verification) fail("FAIL-RIA-VERIFICATION-BASELINE-REQUIRED", "Health and Integrity require verification_baseline_ref in the RIA envelope");
    return canonical({
      baseline_ref,
      engineering_intelligence_ref: sei,
      ...(assessmentResult?.sei_assessment_ref ?? context.sei_assessment_ref ? { sei_assessment_ref: assessmentResult?.sei_assessment_ref ?? context.sei_assessment_ref } : {}),
      ...(verification ? { verification_baseline_ref: verification } : {}),
      presentation_policy: "inherit",
    });
  };
  const required = (taskId) => async (handlerContext) => {
    const handler = external[taskId];
    if (!handler) fail("TASK_HANDLER_MISSING", `adapter has no ${taskId} handler`);
    const requireVerification = taskId === "owner-health" || taskId === "owner-integrity";
    const result = await handler({ ...handlerContext, ...context, owner_envelope: () => ownerEnvelope(handlerContext.dependencies, { requireVerification }) });
    if (!result || typeof result !== "object") fail("FAIL-RIA-ADAPTER", `${taskId} returned no result`);
    if (taskId === "sei-snapshot") context.sei_result = result;
    if (taskId === "sei-assessment") {
      context.sei_assessment_ref = result.sei_assessment_ref ?? null;
      result.engineering_intelligence_ref = result.engineering_intelligence_ref ?? context.sei_result?.engineering_intelligence_ref ?? null;
    }
    if (taskId === "verification-baseline") context.verification_baseline_ref = result.verification_baseline_ref ?? null;
    return result;
  };
  const handlers = {
    "repository-preflight": async () => {
      if (request.command_authorization?.state === "denied" && Array.isArray(request.verification_contract?.commands) && request.verification_contract.commands.length > 0) fail("COMMAND_AUTHORIZATION_DENIED", "verification commands were requested under denied command authority");
      return { repository: baseline.repository, command_authorization: baseline.command_authorization };
    },
    "baseline-build": async () => {
      const target = path.join(request.runtime_root, "baselines", `${baseline.content_sha256}.json`);
      const writer = writeBaseline(target, baseline);
      return { artifact: baseline, baseline_ref, writer, result_ref: baseline_ref };
    },
    "baseline-verify": async ({ dependencies }) => {
      const value = dependencies["baseline-build"]?.artifact;
      const validation = verifyBaseline(value);
      if (!validation.ok) fail("FAIL-RIA-BASELINE-VERIFY", validation.errors.join("; "));
      return { validation, baseline_ref: validation.baseline_ref, result_ref: validation.baseline_ref };
    },
    "reuse-resolve": async () => ({ ...(request.startup_resolution ?? { startup_mode: "FRESH_BASELINE", node_cache_state: "MISS" }), baseline_ref }),
    "sei-snapshot": required("sei-snapshot"),
    "sei-assessment": required("sei-assessment"),
    "verification-baseline": required("verification-baseline"),
    "owner-health": required("owner-health"),
    "owner-integrity": required("owner-integrity"),
    "owner-architecture": required("owner-architecture"),
    "owner-artifact-verification": async ({ dependencies }) => {
      const firstReturn = Object.keys(OWNER_TASKS).map((taskId) => dependencies[taskId]).find(Boolean);
      const envelope = firstReturn?.input_binding_echo ?? null; const refs = []; const failures = [];
      if (!envelope) failures.push({ code: "OWNER_ENVELOPE_MISSING" });
      for (const [taskId, owner] of Object.entries(OWNER_TASKS)) {
        const ownerReturn = dependencies[taskId];
        if (!ownerReturn) { failures.push({ owner, code: "OWNER_RETURN_MISSING" }); continue; }
        const validation = validateOwnerReturn(ownerReturn, { owner, repository_revision: baseline.repository.revision, input_binding_echo: envelope });
        if (!validation.ok) { failures.push({ owner, code: "OWNER_RETURN_INVALID", errors: validation.errors }); continue; }
        refs.push(validation.owner_ref);
      }
      if (failures.length > 0 && !request.allow_degraded) fail("FAIL-RIA-OWNER-ARTIFACT", JSON.stringify(failures));
      return { status: failures.length ? "partial" : "complete", owner_refs: refs, owner_artifacts: Object.fromEntries(Object.entries(OWNER_TASKS).filter(([taskId]) => dependencies[taskId]).map(([taskId, owner]) => [owner, dependencies[taskId]])), input_binding_echo: envelope, failures };
    },
    "cross-owner-synthesis": async ({ dependencies }) => {
      const verified = dependencies["owner-artifact-verification"] ?? { owner_refs: [], failures: [{ code: "OWNER_VERIFICATION_UNAVAILABLE" }] };
      return { status: verified.status ?? "partial", attribution: verified.owner_refs.map((ref) => ({ owner: ref.owner, canonical_artifact_ref: ref })), failures: verified.failures ?? [], judgment_translation: false };
    },
    "assess-binding": async ({ dependencies }) => {
      const verified = dependencies["owner-artifact-verification"];
      const refs = verified?.owner_refs ?? [];
      if (refs.length !== 3) return { stage: "ASSESS-PARTIAL", owner: "repository-improvement-assessment", baseline_ref, engineering_intelligence_ref: context.sei_result?.engineering_intelligence_ref ?? null, available_assessment_refs: refs, missing_owner_count: 3 - refs.length };
      const envelope = verified.input_binding_echo;
      const projection = { stage: "ASSESS", owner: "repository-improvement-assessment", baseline_ref, engineering_intelligence_ref: envelope.engineering_intelligence_ref, ...(envelope.sei_assessment_ref ? { sei_assessment_ref: envelope.sei_assessment_ref } : {}), assessment_refs: refs };
      const validation = validateAssessProjection(projection);
      if (!validation.ok) fail("FAIL-RIA-ASSESS-PROJECTION", validation.errors.join("; "));
      return projection;
    },
    "sei-telemetry-summary": async ({ dependencies }) => {
      const assessmentResult = dependencies["sei-assessment"];
      const assessment = assessmentResult?.assessment;
      const seiBinding = assessmentResult?.engineering_intelligence_ref ?? context.sei_result?.engineering_intelligence_ref ?? null;
      return assessment ? buildSeiTelemetrySummary({ sei_binding: seiBinding, assessment, cache_disposition: request.startup_resolution?.node_cache_state ?? "MISS", collector_status: "recorded" }) : unavailableSeiTelemetry({ sei_binding: seiBinding }, "ASSESSMENT_UNAVAILABLE");
    },
    "report-data": required("report-data"),
    "report-render": required("report-render"),
    "performance-receipt": async () => ({ status: "pending-finalization", cacheable: false }),
  };
  const cache = new FileArtifactCache(path.join(request.runtime_root, "cache", "tasks"));
  const execution = await executePlan(plan, {
    cache,
    handlers,
    ...(resumeState ? {} : { run_id: `ria-${runNonce}` }),
    run_nonce: runNonce,
    state_path: resumeState ? path.resolve(request.state_path) : path.join(runDirectory, "state.json"),
    event_log_path: resumeState?.event_log ?? path.join(runDirectory, "task-events.jsonl"),
    presentation_decision: request.presentation_policy,
  });
  let performance;
  try { performance = buildPerformanceReceipt({ plan, execution_result: execution }); }
  catch (error) { performance = unavailablePerformanceReceipt(execution.run_id, error.code ?? error.message); }
  const performancePath = atomicJson(path.join(runDirectory, "performance-receipt.json"), performance);
  const effectiveExecution = structuredClone(execution);
  effectiveExecution.task_results["performance-receipt"] = { receipt: performance, path: performancePath, result_ref: { receipt_sha256: performance.receipt_sha256 } };
  const projection = effectiveExecution.task_results["assess-binding"] ?? null;
  const completeAssess = projection?.stage === "ASSESS";
  const assessmentRequired = request.lifecycle !== "verify-only";
  const ownerRendezvous = collectOwnerRendezvous(runDirectory, execution.failures);
  const awaitingOwners = Boolean(ownerRendezvous);
  let status = execution.status === "complete" && ((assessmentRequired && !completeAssess) || baseline.repository.mode === "content-addressed-degraded") ? "degraded" : execution.status;
  if (awaitingOwners) status = "awaiting-owner-returns";
  if (!terminalCount(plan, execution.events)) fail("FAIL-RIA-EXECUTION", "not every planned node received a scheduler-produced terminal event");
  const persistRequired = awaitingOwners ? "partial" : request.lifecycle === "verify-only" ? "verification" : completeAssess ? "assess" : null;
  const persistence = persistRequired
    ? persistAssessmentArtifacts({
      repositoryRoot: firstRoot(request),
      durableMode: request.durable_mode,
      baseline,
      execution: effectiveExecution,
      projection: completeAssess ? projection : null,
      required: persistRequired,
    })
    : null;
  return Object.freeze(canonical({
    schema_version: "ria.public-result@1",
    status,
    baseline_ref,
    startup_resolution,
    assessment: completeAssess ? projection : null,
    partial_assessment: completeAssess ? null : projection,
    report: effectiveExecution.task_results["report-render"] ?? null,
    sei_telemetry: effectiveExecution.task_results["sei-telemetry-summary"] ?? null,
    performance_receipt: performance,
    owner_rendezvous: ownerRendezvous,
    state_path: path.join(runDirectory, "state.json"),
    persistence,
    plan,
    execution: effectiveExecution,
  }));
}

function parseArgs(argv) { const out = {}; for (let index = 2; index < argv.length; index += 1) { const key = argv[index]; if (key === "--help" || key === "-h") { out.help = true; continue; } if (!["--request", "--adapter", "--output"].includes(key) || !argv[index + 1]) fail("FAIL-RIA-CLI", `invalid argument ${key}`); out[key.slice(2)] = argv[++index]; } if (!out.help && !out.request) fail("FAIL-RIA-CLI", "--request is required"); return out; }
async function main() { const args = parseArgs(process.argv); if (args.help) { process.stdout.write("usage: node scripts/ria.js --request <request.json> [--adapter <ria-agent-adapter.js>] [--output <result.json>]\n"); return; } const request = JSON.parse(fs.readFileSync(path.resolve(args.request), "utf8")); const adapter = args.adapter ? require(path.resolve(args.adapter)) : require("./ria-agent-adapter.js"); const result = await executeRia(request, adapter); const bytes = `${JSON.stringify(result, null, 2)}\n`; if (args.output) atomicJson(args.output, result); else process.stdout.write(bytes); if (result.status === "blocked") process.exitCode = 2; if (result.status === "awaiting-owner-returns") process.exitCode = 3; }
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });

module.exports = { OWNER_TASKS, SOURCE_TASKS, executeRia, normalizedRequest };
