#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildBaseline, verifyBaseline, writeBaseline, gitPreflight } = require("../baseline.js");
const { validateAssessProjection } = require("../engineering-intelligence-assessment.js");
const { validateOwnerReturn, envelopeForOwner } = require("../../shared/ria-owner-return/owner-return.js");
const { buildExecutionPlan } = require("./build-execution-plan.js");
const { executePlan, FileArtifactCache } = require("./execution-runtime.js");
const { buildSeiTelemetrySummary, unavailable: unavailableSeiTelemetry } = require("./sei-telemetry-summary.js");
const { buildPerformanceReceipt, unavailablePerformanceReceipt } = require("./performance-receipt.js");
const projectWorkspace = require("../../shared/project-intelligence-workspace/project-intelligence-workspace.js");
const { resolveStartup } = require("./startup-resolver.js");
const { SCHEMA_VERSION: VERIFICATION_SCHEMA_VERSION } = require("../../shared/assessment-verification-baseline/verification-baseline.js");
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
/** Bound-evidence integrity failures (tampering, dangling refs, binding mismatch) block even
 * under allow_degraded; the runtime honors non_degradable regardless of failure policy. */
function integrityFail(code, message) { const error = new Error(`${code}: ${message}`); error.code = code; error.non_degradable = true; throw error; }
function firstRoot(request) { const roots = request.repository?.roots ?? (request.repository?.root ? [request.repository.root] : []); if (!Array.isArray(roots) || roots.length === 0) fail("FAIL-RIA-REQUEST", "repository.root or repository.roots is required"); return path.resolve(roots[0]); }
function contractDigest(owner) {
  const filePath = path.resolve(__dirname, "..", "..", owner, "RUNTIME-CONTRACT.json");
  const bytes = fs.readFileSync(filePath);
  return { owner, version: JSON.parse(bytes.toString("utf8")).version, runtime_contract_sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
/** What was on disk but outside the assessment, reported beside the result rather than
 * inside the baseline. Under `head` scope the assessed tree is HEAD, so uncommitted work
 * must not enter baseline identity — but staying silent about it is how someone reads a
 * grade and believes it covered the edits they have open. */
function workingTreeNotice(request) {
  try {
    const preflight = gitPreflight(firstRoot(request));
    if (!preflight.ok) return { assessed: request.scope ?? "worktree", clean: null, uncommitted_entry_count: null };
    const assessedScope = request.scope ?? (request.durable_mode === "content-addressed-degraded" ? "worktree" : "head");
    return {
      assessed: assessedScope,
      clean: preflight.clean,
      uncommitted_entry_count: preflight.uncommitted_entry_count,
      excluded_from_assessment: assessedScope === "head" && !preflight.clean,
    };
  } catch { return null; }
}

/** `.project-intelligence/` is excluded via .git/info/exclude, which is local-only and
 * never untracks what is already committed. Saying so once is the difference between a
 * directory the user chose to keep local and one they assume is ignored everywhere. */
function workspaceIgnoreNotice(request) {
  try {
    if (request.durable_mode === "content-addressed-degraded") return null;
    const workspace = projectWorkspace.ensureWorkspace(firstRoot(request));
    const exclude = workspace.git_exclude;
    if (!exclude) return null;
    return {
      pattern: exclude.pattern,
      local_only: exclude.local_only === true,
      tracked_gitignore: exclude.tracked_gitignore === true,
      tracked_files: exclude.tracked_files ?? [],
      suggested_gitignore_line: exclude.suggested_gitignore_line ?? null,
    };
  } catch { return null; }
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
  const skillsRoot = path.resolve(__dirname, "..", "..");
  // composite-scoring-v3 §5.3: name the one SEI reader and the exact bound refs. The refs
  // are copied from a bound envelope verbatim; no shorter reference shape is invented.
  const firstEnvelope = Object.values(envelopes).map((file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }).find(Boolean) ?? null;
  const sei = {
    reader: { module: path.join(skillsRoot, "repository-improvement-assessment", "engineering-intelligence-reader.js"), export: "readSeiEvidence", citation_check_export: "seiCitationProblems" },
    engineering_intelligence_ref: firstEnvelope?.engineering_intelligence_ref ?? null,
    sei_assessment_ref: firstEnvelope?.sei_assessment_ref ?? null,
  };
  return {
    schema_version: "ria.owner-rendezvous@1",
    envelopes,
    return_paths,
    // The seam validates returns it does not produce, so it has to say what a valid
    // return is. Without these paths a dispatched owner has to rediscover the schema,
    // the validator and its own artifact writer before it can answer.
    contract: {
      return_schema_version: "ria.owner-return@1",
      return_schema: path.join(skillsRoot, "shared", "ria-owner-return", "owner-return.schema.json"),
      validator: path.join(skillsRoot, "shared", "ria-owner-return", "owner-return.js"),
      validator_export: "validateOwnerReturn",
      required_fields: ["schema_version", "owner", "canonical_artifact_ref", "repository_revision", "file_sha256", "input_binding_echo", "artifact_path", "warnings"],
      optional_fields: ["specialist_refs"],
      // Owner writers confine --output/--return-out to <repo>/.project-intelligence/ or
      // $RIA_RUNTIME_ROOT. The return paths live under this run directory, so name it.
      env: { RIA_RUNTIME_ROOT: runDirectory },
      writers: {
        "repository-health-assessment": path.join(skillsRoot, "repository-health-assessment", "assets", "write-health-artifact.js"),
        "codebase-integrity-audit-loop": path.join(skillsRoot, "codebase-integrity-audit-loop", "assets", "write-ledger.js"),
        "architecture-improvement-intelligence": path.join(skillsRoot, "architecture-improvement-intelligence", "assets", "write-candidate-set.js"),
      },
      sei,
    },
    instruction: "Dispatch each missing owner skill with the matching envelope JSON at envelopes[owner]. Each owner runs its writer from contract.writers[owner] with environment contract.env (RIA_RUNTIME_ROOT; never --allow-path-outside) and --ria-envelope <envelope> --return-out <return_paths[owner]>; without --return-out the writer prints the return to stdout and you must redirect it to that exact path yourself. The return must satisfy contract.return_schema and pass contract.validator_export. Then rerun with lifecycle continue and the returned state_path.",
  };
}
function verifySeiCitations(ownerReturn, envelope, baseline, request) {
  const { collectSeiCitations, readSeiEvidence, seiCitationProblems } = require("../engineering-intelligence-reader.js");
  const citations = collectSeiCitations(JSON.parse(fs.readFileSync(ownerReturn.artifact_path, "utf8")));
  if (!citations.length) return;
  const repositoryRoot = baseline.repository.roots[0].root;
  let evidence;
  try { evidence = readSeiEvidence({ repository_root: repositoryRoot, envelope, allowed_roots: [path.join(repositoryRoot, ".project-intelligence"), request.runtime_root].filter(Boolean) }); }
  catch (error) { integrityFail("FAIL-RIA-SEI-CITATION", `${ownerReturn.owner}: ${error.message}`); }
  const problems = seiCitationProblems(evidence.assessment, citations);
  if (problems.length) integrityFail("FAIL-RIA-SEI-CITATION", `${ownerReturn.owner}: ${problems.join("; ")}`);
}
/** architecture.evidence-binding@1: re-resolves Architecture's packet-qualified claim refs
 * against the bound packet bytes on every run (this node is never served from cache, so
 * continue and report-only runs re-check too). Tampering, dangling refs and binding
 * mismatches block; a packet or revision that is legitimately unavailable stays missing. */
function verifyArchitectureEvidence(ownerReturn, envelope, baseline, request) {
  const { bindingFromEnvelope, resolveArchitectureEvidence } = require("../../architecture-improvement-intelligence/assets/architecture-evidence-binding.js");
  const repositoryRoot = baseline.repository.roots[0].root;
  try {
    // Sources are read at root-0's own commit when the baseline is a clean Git root, and from
    // the fingerprinted working tree otherwise (multi-root or dirty baselines).
    const root = baseline.repository.roots[0];
    const sourceSnapshot = root.head_revision && root.revision === root.head_revision ? { kind: "git", revision: root.revision } : { kind: "worktree" };
    return resolveArchitectureEvidence(JSON.parse(fs.readFileSync(ownerReturn.artifact_path, "utf8")), { mode: "consume", repositoryRoot, binding: bindingFromEnvelope(envelope), sourceSnapshot, allowedRoots: [path.join(repositoryRoot, ".project-intelligence"), request.runtime_root].filter(Boolean) });
  } catch (error) { integrityFail("FAIL-RIA-ARCHITECTURE-EVIDENCE", error.message); }
}
function baselineRef(baseline) { return { artifact_id: baseline.artifact_id, sha256: baseline.content_sha256, repository_revision: baseline.repository.revision }; }
function terminalCount(plan, events) { const terminal = new Set(["reused", "completed", "failed", "blocked", "cancelled"]); return new Set(events.filter((event) => terminal.has(event.status)).map((event) => event.task_id)).size === plan.tasks.length; }

/** Every field `normalizedRequest` or a downstream validator actually reads. Unknown
 * keys used to be spread through untouched, so a typo produced no error at all and
 * surfaced later as a missing behaviour. */
const REQUEST_FIELDS = Object.freeze([
  "repository", "command_authorization", "sei_compatibility_binding",
  "lifecycle", "mode", "depth", "custom_budget", "durable_mode", "scope", "require_clean",
  "presentation_policy", "reuse_controls", "verification_contract", "allow_degraded",
  "generated_protected_paths", "runtime_root", "state_path", "run_nonce",
  "startup_resolution", "history_binding", "environment_toolchain", "provenance",
  "artifact_lineage", "runtime_capacity",
  // Reserved, deliberately open: the adapter is pluggable via --adapter, and a custom
  // adapter may need its own inputs. Namespacing them keeps the closed set able to catch
  // a typo in a real field without making adapter extensibility impossible.
  "adapter_options",
]);

// ask and inherit are accepted for callers that already pass them, but the CLI cannot hold an
// interactive election: both behave like skip, and main() says so on stderr.
const PRESENTATION_POLICIES = Object.freeze(["generate", "skip", "ask", "inherit"]);
function normalizedRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("FAIL-RIA-REQUEST", "request must be an object");
  const unknown = Object.keys(input).filter((key) => !REQUEST_FIELDS.includes(key));
  if (unknown.length) {
    const near = unknown.map((key) => {
      const match = REQUEST_FIELDS.find((field) => field.toLowerCase() === String(key).toLowerCase());
      return match ? `${key} (did you mean ${match}?)` : key;
    });
    fail("FAIL-RIA-REQUEST", `unknown request field ${near.join(", ")} — see request.schema.json for the accepted set`);
  }
  // `scope: "worktree"` on a Git repository has never produced an assessment. The baseline
  // sets repository.revision to a synthetic content hash (baseline.js), and SEI anchors its
  // history window and Repository Index binding to that same value while deriving its own
  // revision from Git — so incremental-run-state.js rejects the pair. Separating "identity
  // revision" from "Git history anchor" across the RIA/SEI boundary is a real design change,
  // not a local fix. Fail here, immediately and legibly, instead of ~90s later inside SEI.
  const effectiveDurableMode = input.durable_mode ?? "git";
  const effectiveScope = input.scope ?? (effectiveDurableMode === "git" ? "head" : "worktree");
  if (effectiveDurableMode === "git" && effectiveScope === "worktree") {
    fail("FAIL-RIA-SCOPE-UNSUPPORTED", 'scope "worktree" is not yet supported on a Git repository: SEI binds its history window to repository.revision, which this scope sets to a synthetic content hash rather than a commit. Use scope "head": it assesses the committed revision and no longer requires a clean checkout. To assess uncommitted edits, commit them first.');
  }
  // A free string here meant a typo, "ask" and "inherit" all produced no report without a word.
  const policy = input.presentation_policy ?? "skip";
  if (!PRESENTATION_POLICIES.includes(policy)) {
    fail("FAIL-RIA-REQUEST", `presentation_policy ${JSON.stringify(policy)} is not valid — use one of ${PRESENTATION_POLICIES.join(", ")}`);
  }
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
    // Gate-only: baselineBody reads it to refuse a dirty tree and never stores it, so
    // forwarding it cannot move the baseline hash. Omitting it made the opt-in dead.
    require_clean: request.require_clean,
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
    scope: request.scope,
    repository: { root: firstRoot(request) },
    engine_version: baseline.sei_compatibility_binding?.engine_version,
    config_hash: baseline.sei_compatibility_binding?.config_hash,
    execution_contract_hash: baseline.sei_compatibility_binding?.execution_contract_hash,
    compatibility_binding: baseline.sei_compatibility_binding,
    baseline_ref,
    verification: {
      // Bumping this with the artifact schema is deliberate: a pre-trust @2 artifact must
      // NOT be reused as a verification baseline, or the missing verdict comes back with it.
      version: VERIFICATION_SCHEMA_VERSION,
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
  // Each owner receives the shared bindings plus its own candidate_namespace
  // (shared/ria-owner-return CANDIDATE_NAMESPACES) so candidate ids cannot collide across owners.
  const ownerEnvelope = (dependencies = {}, { requireVerification = false, owner = null } = {}) => {
    const assessmentResult = dependencies["sei-assessment"] ?? null;
    const verificationResult = dependencies["verification-baseline"] ?? null;
    const sei = assessmentResult?.engineering_intelligence_ref ?? context.sei_result?.engineering_intelligence_ref;
    if (!sei) fail("FAIL-RIA-ASSESS-BINDING", "SEI did not return engineering_intelligence_ref");
    const verification = verificationResult?.verification_baseline_ref ?? context.verification_baseline_ref ?? null;
    if (requireVerification && !verification) fail("FAIL-RIA-VERIFICATION-BASELINE-REQUIRED", "Health and Integrity require verification_baseline_ref in the RIA envelope");
    const shared = canonical({
      baseline_ref,
      engineering_intelligence_ref: sei,
      ...(assessmentResult?.sei_assessment_ref ?? context.sei_assessment_ref ? { sei_assessment_ref: assessmentResult?.sei_assessment_ref ?? context.sei_assessment_ref } : {}),
      ...(verification ? { verification_baseline_ref: verification } : {}),
      presentation_policy: "inherit",
    });
    return owner ? envelopeForOwner(shared, owner) : shared;
  };
  const required = (taskId) => async (handlerContext) => {
    const handler = external[taskId];
    if (!handler) fail("TASK_HANDLER_MISSING", `adapter has no ${taskId} handler`);
    const requireVerification = taskId === "owner-health" || taskId === "owner-integrity";
    const result = await handler({ ...handlerContext, ...context, owner_envelope: () => ownerEnvelope(handlerContext.dependencies, { requireVerification, owner: OWNER_TASKS[taskId] ?? null }) });
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
    // Read the resolution computed above. The request field is almost always absent, so this used
    // to fall back to FRESH_BASELINE/MISS and report that a fully reused run reused nothing.
    "reuse-resolve": async () => ({ ...startup_resolution, baseline_ref }),
    "sei-snapshot": required("sei-snapshot"),
    "sei-assessment": required("sei-assessment"),
    "verification-baseline": required("verification-baseline"),
    "owner-health": required("owner-health"),
    "owner-integrity": required("owner-integrity"),
    "owner-architecture": required("owner-architecture"),
    "owner-artifact-verification": async ({ dependencies }) => {
      const firstReturn = Object.keys(OWNER_TASKS).map((taskId) => dependencies[taskId]).find(Boolean);
      // Owners echo the shared bindings plus their own candidate_namespace; compare each
      // return against the shared bindings re-namespaced for that owner.
      const firstEcho = firstReturn?.input_binding_echo ?? null;
      const envelope = firstEcho ? canonical(Object.fromEntries(Object.entries(firstEcho).filter(([key]) => key !== "candidate_namespace"))) : null; const refs = []; const failures = []; let architectureEvidence = null;
      if (!envelope) failures.push({ code: "OWNER_ENVELOPE_MISSING" });
      for (const [taskId, owner] of Object.entries(OWNER_TASKS)) {
        const ownerReturn = dependencies[taskId];
        if (!ownerReturn) { failures.push({ owner, code: "OWNER_RETURN_MISSING" }); continue; }
        const validate = owner === "architecture-improvement-intelligence" ? require("../../architecture-improvement-intelligence/assets/architecture-owner-return.js").validateArchitectureOwnerReturn : validateOwnerReturn;
        const validation = validate(ownerReturn, { owner, repository_revision: baseline.repository.revision, input_binding_echo: envelope && ownerReturn.input_binding_echo && typeof ownerReturn.input_binding_echo === "object" && "candidate_namespace" in ownerReturn.input_binding_echo ? envelopeForOwner(envelope, owner) : envelope });
        if (!validation.ok) { failures.push({ owner, code: "OWNER_RETURN_INVALID", errors: validation.errors }); continue; }
        // composite-scoring-v3 §5.3: the authoritative check of sei-criterion citations
        // against the bound assessment bytes. Tampering or a bad citation blocks, even
        // under allow_degraded; it is never turned into ordinary missing evidence.
        if (owner !== "codebase-integrity-audit-loop") verifySeiCitations(ownerReturn, envelope, baseline, request);
        if (owner === "architecture-improvement-intelligence") architectureEvidence = verifyArchitectureEvidence(ownerReturn, envelope, baseline, request);
        refs.push(validation.owner_ref);
      }
      if (failures.length > 0 && !request.allow_degraded) fail("FAIL-RIA-OWNER-ARTIFACT", JSON.stringify(failures));
      return { status: failures.length ? "partial" : "complete", owner_refs: refs, architecture_evidence: architectureEvidence, owner_artifacts: Object.fromEntries(Object.entries(OWNER_TASKS).filter(([taskId]) => dependencies[taskId]).map(([taskId, owner]) => [owner, dependencies[taskId]])), input_binding_echo: envelope, failures };
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
      return assessment ? buildSeiTelemetrySummary({ sei_binding: seiBinding, assessment, cache_disposition: startup_resolution?.node_cache_state ?? "MISS", collector_status: "recorded" }) : unavailableSeiTelemetry({ sei_binding: seiBinding }, "ASSESSMENT_UNAVAILABLE");
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
  // report-render is an observe-mode task: when it throws it is marked SUCCEEDED in the pool
  // and its error lands in observational_failures, which nothing read. A report the caller
  // explicitly elected that never appeared is a missing deliverable, not a completed run.
  const warnings = [];
  if (status === "complete" && request.presentation_policy === "generate" && !effectiveExecution.task_results["report-render"]) {
    status = "degraded";
    warnings.push("presentation_policy was \"generate\" but no report was produced; see execution.observational_failures");
  }
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
    working_tree: workingTreeNotice(request),
    workspace_ignore: workspaceIgnoreNotice(request),
    startup_resolution,
    assessment: completeAssess ? projection : null,
    partial_assessment: completeAssess ? null : projection,
    report: effectiveExecution.task_results["report-render"] ?? null,
    warnings,
    verification: verificationSummary(effectiveExecution.task_results["verification-baseline"]),
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
/** A non-zero exit used to print nothing at all, and with --output nothing reached
 * stdout either, so every diagnosis began by loading the result JSON and walking
 * execution.failures by hand. One line on stderr removes that round trip. */
function exitSummary(result) {
  const describe = (failure) => `${failure.code ?? "UNKNOWN"}${failure.task_id ? ` at ${failure.task_id}` : ""}: ${String(failure.message ?? "").split("\n")[0]}`;
  const headline = exitHeadline(result, describe);
  // Printed for EVERY status, complete included. A non-fatal failure that says nothing is how
  // a report that threw came back as exit 0 with no report and no reason.
  const observational = result.execution?.observational_failures ?? [];
  const lines = [headline, verificationNote(result.verification), ...(result.warnings ?? []).map((warning) => `Warning: ${warning}`)];
  if (observational.length) lines.push(`${observational.length} non-fatal task failure(s); first = ${describe(observational[0])}`);
  const text = lines.filter(Boolean).join("\n");
  return text || null;
}
/** With no verification_contract the gate never fires (deriveTrust([]) is `not-run`), so the
 * run proceeded and read exactly like a verified one. Health already caps not-run at C; what was
 * missing was saying so where the caller looks. */
function verificationSummary(result) {
  const artifact = result?.artifact;
  if (!artifact) return null;
  return {
    trust_state: artifact.trust?.state ?? null,
    trust_reason: artifact.trust?.reason ?? null,
    command_count: Array.isArray(artifact.commands) ? artifact.commands.length : 0,
  };
}
function verificationNote(verification) {
  if (!verification || !["not-run", "partial"].includes(verification.trust_state)) return null;
  const why = verification.trust_state === "not-run" ? "no verification commands ran" : `verification was ${verification.trust_reason ?? "partial"}`;
  return `Note: verification ${verification.trust_state} — ${why}, so this assessment carries no passing test evidence; Health caps its grade at C. Declare verification_contract.commands to verify.`;
}
function exitHeadline(result, describe) {
  if (result.status === "blocked") {
    const failures = [...(result.execution?.failures ?? []), ...(result.execution?.degraded_failures ?? [])];
    const first = failures[0];
    return `RIA blocked (exit 2): ${failures.length} failure(s); first = ${first ? describe(first) : "no failure detail recorded"}`;
  }
  if (result.status === "awaiting-owner-returns") {
    const owners = Object.keys(result.owner_rendezvous?.return_paths ?? {}).join(", ") || "unknown";
    return `RIA awaiting owner returns (exit 3): ${owners}. Envelopes and the return contract are in owner_rendezvous; resume with lifecycle "continue" and state_path ${result.state_path}`;
  }
  if (result.status === "degraded") {
    const degraded = result.execution?.degraded_failures ?? [];
    if (!degraded.length && (result.warnings ?? []).length) return "RIA degraded (exit 0)";
    return `RIA degraded (exit 0): the projection is incomplete${degraded.length ? `; first = ${describe(degraded[0])}` : ""}`;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { process.stdout.write("usage: node scripts/ria.js --request <request.json> [--adapter <ria-agent-adapter.js>] [--output <result.json>]\n"); return; }
  const request = JSON.parse(fs.readFileSync(path.resolve(args.request), "utf8"));
  const adapter = args.adapter ? require(path.resolve(args.adapter)) : require("./ria-agent-adapter.js");
  const result = await executeRia(request, adapter);
  const bytes = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) atomicJson(args.output, result); else process.stdout.write(bytes);
  if (request.presentation_policy === "ask" || request.presentation_policy === "inherit") {
    process.stderr.write(`Note: presentation_policy "${request.presentation_policy}" is not interactive in the CLI; no report generated — pass "generate" to produce one.\n`);
  }
  const tree = result.working_tree;
  if (tree && tree.excluded_from_assessment) {
    process.stderr.write(`Note: ${tree.uncommitted_entry_count} uncommitted working-tree ${tree.uncommitted_entry_count === 1 ? "entry was" : "entries were"} NOT assessed — scope "head" assesses the committed revision. Commit the edits to assess them (scope "worktree" is not supported on a Git repository), or set require_clean:true to refuse to start while the tree is dirty.\n`);
  }
  const ignore = result.workspace_ignore;
  if (ignore && ignore.local_only) {
    process.stderr.write(`Note: ${ignore.pattern} is excluded locally only (.git/info/exclude), which does not survive a clone. To share that across clones add "${ignore.suggested_gitignore_line}" to .gitignore.\n`);
  }
  if (ignore && ignore.tracked_files.length) {
    process.stderr.write(`Warning: ${ignore.tracked_files.length} file(s) under ${ignore.pattern} are already TRACKED in git and no ignore rule removes them: ${ignore.tracked_files.slice(0, 5).join(", ")}${ignore.tracked_files.length > 5 ? ", …" : ""}. Use "git rm --cached" to stop tracking them.\n`);
  }
  const summary = exitSummary(result);
  if (summary) process.stderr.write(`${summary}\n`);
  if (args.output && summary) process.stderr.write(`Full result: ${path.resolve(args.output)}\n`);
  if (result.status === "blocked") process.exitCode = 2;
  if (result.status === "awaiting-owner-returns") process.exitCode = 3;
}
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });

module.exports = { OWNER_TASKS, SOURCE_TASKS, executeRia, normalizedRequest, verifySeiCitations, verifyArchitectureEvidence };
