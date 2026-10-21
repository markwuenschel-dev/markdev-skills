"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { finiteOrNull, weightedComposite, normalizeCoverageMetrics, ledgerPriorityBand } = require("./scoring.js");
const { validatePerformanceReceipt } = require("./performance-receipt.js");
const { validateElectionRecord } = require("../../shared/report-election/report-election.js");

const OWNERS = Object.freeze([
  "repository-health-assessment",
  "codebase-integrity-audit-loop",
  "architecture-improvement-intelligence",
]);

function stableCompare(a, b) { return String(a ?? "").localeCompare(String(b ?? "")); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(stableCompare).map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function shortOwnerName(owner) { return owner === OWNERS[0] ? "Health" : owner === OWNERS[1] ? "Integrity" : owner === OWNERS[2] ? "Architecture" : String(owner); }
const finite = finiteOrNull; // P1: one shared coercion path (shared/ria-scoring/scoring.js)
function countBy(values, selector) {
  const counts = new Map();
  for (const value of values || []) {
    const key = String(selector(value) ?? "unknown");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || stableCompare(a[0], b[0])).map(([label, value]) => ({ label, value }));
}
function readJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const bytes = fs.readFileSync(resolved);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`ARTIFACT_JSON_INVALID:${label}:${error.message}`); }
  return { path: resolved, bytes, value, sha256: sha256(bytes) };
}
function placeholderHash(value) { return /^([0-9a-f])\1{63}$/.test(String(value || "")); }
function artifactHashSuffix(artifactId) {
  const match = String(artifactId || "").match(/([0-9a-f]{64})$/);
  return match ? match[1] : null;
}
function findCandidate(value, predicates) {
  for (const candidate of predicates(value)) if (candidate && typeof candidate === "object") return candidate;
  return null;
}
function healthPayload(value) {
  return findCandidate(value, root => [
    root,
    root.health,
    root.health_island,
    root.payload,
    root.assessment && root.assessment.health,
    root.assessment && root.assessment.health_island,
  ].filter(item => item && item.health_schema_version === 5));
}
function integrityPayload(value) {
  return findCandidate(value, root => [
    root,
    root.ledger,
    root.candidate_ledger,
    root.payload,
    root.assessment && root.assessment.ledger,
  ].filter(item => item && Number(item.spine_version) === 3 && Array.isArray(item.candidates)));
}
function architecturePayload(value) {
  return findCandidate(value, root => [
    root,
    root.candidate_set,
    root.architecture_candidate_set,
    root.payload,
    root.assessment,
    root.assessment && root.assessment.candidate_set,
  ].filter(item => item && Number(item.schema_version) === 2 && Array.isArray(item.candidates)));
}
function architectureLedger(value) {
  return findCandidate(value, root => [
    root.ledger,
    root.candidate_ledger,
    root.assessment && root.assessment.ledger,
  ].filter(item => item && Number(item.spine_version) === 3 && Array.isArray(item.candidates)));
}
function loadVerifiers(skillRoot) {
  const ledgerPath = path.resolve(skillRoot, "..", "shared", "candidate-ledger-spine", "ledger-verify.js");
  const healthPath = path.resolve(skillRoot, "..", "repository-health-assessment", "assets", "health-verify.js");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(ledgerPath, "utf8"), sandbox, { filename: ledgerPath });
  vm.runInNewContext(fs.readFileSync(healthPath, "utf8"), sandbox, { filename: healthPath });
  if (!sandbox.LedgerVerify?.verifyLedger || !sandbox.HealthVerify?.verifyHealth) throw new Error("ASSESSMENT_VERIFIER_API_MISSING");
  return { LV: sandbox.LedgerVerify, HV: sandbox.HealthVerify };
}
function validateRequest(request, { fixture = false } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("REPORT_REQUEST_INVALID");
  const repository = request.repository || {};
  if (!nonempty(repository.name) || !nonempty(repository.revision)) throw new Error("REPORT_REPOSITORY_REQUIRED");
  if (!fixture && /(?:^|[-_:])(demo|fixture|placeholder)(?:$|[-_:])/i.test(`${repository.name} ${request.baseline_ref?.artifact_id || ""}`)) {
    throw new Error("PRODUCTION_REPORT_REJECTS_DEMO_OR_FIXTURE_BINDING");
  }
  const baseline = request.baseline_ref || {};
  for (const key of ["artifact_id", "sha256", "repository_revision"]) if (!nonempty(baseline[key])) throw new Error(`BASELINE_REF_REQUIRED:${key}`);
  if (!/^[0-9a-f]{64}$/.test(baseline.sha256)) throw new Error("BASELINE_SHA256_INVALID");
  if (!fixture && placeholderHash(baseline.sha256)) throw new Error("PRODUCTION_REPORT_REJECTS_PLACEHOLDER_BASELINE_HASH");
  if (baseline.repository_revision !== repository.revision) throw new Error("BASELINE_REVISION_MISMATCH");
  if (!Array.isArray(request.assessment_refs) || request.assessment_refs.length !== 3) throw new Error("ASSESSMENT_REFS_MUST_BE_EXACTLY_3");
  const refs = new Map();
  for (const ref of request.assessment_refs) {
    if (!OWNERS.includes(ref?.owner)) throw new Error(`ASSESSMENT_OWNER_INVALID:${ref?.owner}`);
    if (refs.has(ref.owner)) throw new Error(`ASSESSMENT_OWNER_DUPLICATE:${ref.owner}`);
    for (const key of ["artifact_id", "sha256", "repository_revision"]) if (!nonempty(ref[key])) throw new Error(`ASSESSMENT_REF_REQUIRED:${ref.owner}:${key}`);
    if (!/^[0-9a-f]{64}$/.test(ref.sha256)) throw new Error(`ASSESSMENT_SHA256_INVALID:${ref.owner}`);
    if (!fixture && placeholderHash(ref.sha256)) throw new Error(`PRODUCTION_REPORT_REJECTS_PLACEHOLDER_HASH:${ref.owner}`);
    if (ref.repository_revision !== repository.revision) throw new Error(`ASSESSMENT_REVISION_MISMATCH:${ref.owner}`);
    const suffix = artifactHashSuffix(ref.artifact_id);
    if (suffix && suffix !== ref.sha256) throw new Error(`ASSESSMENT_ARTIFACT_ID_HASH_MISMATCH:${ref.owner}`);
    refs.set(ref.owner, ref);
  }
  for (const owner of OWNERS) if (!refs.has(owner)) throw new Error(`ASSESSMENT_OWNER_MISSING:${owner}`);
  const election = request.report_election || {};
  const electionValidation = validateElectionRecord(election);
  if (!electionValidation.ok) throw new Error(`REPORT_ELECTION_INVALID:${electionValidation.problems.join(";")}`);
  if (election.policy !== "generate" || election.state !== "elected-generate") throw new Error("REPORT_ELECTION_NOT_GENERATE");
  const performanceValidation = validatePerformanceReceipt(request.performance_receipt);
  if (!performanceValidation.ok) throw new Error(`PERFORMANCE_RECEIPT_INVALID:${performanceValidation.errors.join(";")}`);
  return { repository, baseline, refs, election };
}
function bindArtifact(owner, ref, file, extractor, revision) {
  if (file.sha256 !== ref.sha256) throw new Error(`ARTIFACT_SHA256_MISMATCH:${owner}:expected=${ref.sha256}:actual=${file.sha256}`);
  const payload = extractor(file.value);
  if (!payload) throw new Error(`ARTIFACT_PAYLOAD_UNRECOGNIZED:${owner}`);
  const payloadRevision = payload.repository_revision || payload.repository?.revision || payload.revision || null;
  if (payloadRevision && payloadRevision !== revision) throw new Error(`ARTIFACT_PAYLOAD_REVISION_MISMATCH:${owner}`);
  return payload;
}
function normalizeHealth(health, HV, LV) {
  const verified = HV.verifyHealth(health);
  if (!verified.ok) throw new Error("HEALTH_ARTIFACT_INVALID:\n" + verified.problems.map(problem => `[${problem.code}] ${problem.message}`).join("\n"));
  const coverageStates = countBy(verified.coverage.rows, row => row.coverage);
  const evidenceQuality = countBy(verified.coverage.rows.filter(row => row.applicable), row => row.evidence_quality || "none");
  const commands = (verified.commands || []).map(command => ({
    id: command.command_id,
    kind: command.kind,
    command: command.command,
    result: command.result,
    elapsed_seconds: finite(command.elapsed_seconds),
  }));
  const sourceCandidates = Array.isArray(health.candidates) ? health.candidates : [];
  let candidates = [];
  if (sourceCandidates.length) {
    const ledger = LV.verifyLedger({ spine_version: health.spine_version ?? 3, candidates: sourceCandidates });
    if (!ledger.ok) throw new Error("HEALTH_CANDIDATE_LEDGER_INVALID:\n" + ledger.problems.map(problem => `[${problem.code}] ${problem.message}`).join("\n"));
    candidates = spineCandidates(ledger);
  }
  return {
    grade: verified.grade,
    score: finite(verified.grade.raw_score),
    final_grade: verified.grade.final_grade,
    raw_grade: verified.grade.raw_grade,
    // Health's own gradability verdict. RIA propagates it instead of computing a letter.
    not_gradable: verified.grade.not_gradable === true || verified.grade.final_grade === "Not gradable",
    not_gradable_reason: verified.grade.reason || null,
    weighted_coverage: finite(verified.coverage.weighted_coverage),
    evidence_strength: finite(verified.coverage.evidence_strength),
    core_availability: finite(verified.coverage.core_availability),
    confidence_index: finite(verified.confidence.index),
    confidence_band: verified.confidence.band,
    baseline: verified.baseline,
    candidate_count: verified.candidateCount,
    lanes: verified.lanes.map(lane => ({
      id: lane.lane,
      score: finite(lane.computed?.score),
      grade: lane.grade,
      critical: lane.critical === true,
      criticality_weight: finite(lane.criticality_weight),
    })).sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || stableCompare(a.id, b.id)),
    coverage_states: coverageStates,
    evidence_quality: evidenceQuality,
    // Claims carry confirmed/inferred/unknown observations and evidence paths; surfaces
    // carry the reason a surface was uncovered. Both were reduced to counts here and the
    // detail discarded, which is why the report's uncertainty section had nothing to say.
    claims: (Array.isArray(health.claims) ? health.claims : []).map(claim => ({
      claim_id: claim.claim_id,
      lane: claim.lane,
      statement: claim.statement || "",
      result: claim.result,
      observation: claim.observation || {},
      evidence: (Array.isArray(claim.evidence) ? claim.evidence : []).map(item => ({ path: item?.path || "", note: item?.note || "" })),
    })),
    review_proof_basis: reviewProofBasisCounts(health.claims),
    surfaces: verified.coverage.rows.map(row => ({ id: row.id, coverage: row.coverage, applicable: row.applicable === true, reason: row.reason || null })),
    commands,
    command_summary: countBy(commands, command => command.result),
    caps: verified.grade.caps_applied || [],
    problem_count: verified.problems.length,
    candidates,
  };
}
function spineCandidates(verified) {
  return (verified.candidates || []).map(candidate => ({
    candidate_id: candidate.candidate_id,
    title: candidate.title,
    priority: finite(candidate.computed?.priority),
    value: finite(candidate.computed?.value),
    risk: finite(candidate.computed?.risk),
    band: candidate.band?.label || ledgerPriorityBand(candidate.computed?.priority),
    status: candidate.status,
    eligible: candidate.eligible === true,
    effort: candidate.effort || null,
    scores: candidate.scores || {},
    recommended_action: candidate.rollup?.recommended_action || null,
    execution_mode: candidate.rollup?.execution_mode || null,
    lane_sources: Array.isArray(candidate.lane_sources) ? candidate.lane_sources.map(String) : [],
    claim_refs: Array.isArray(candidate.claim_refs) ? candidate.claim_refs.map(String) : [],
    rank: candidate.rank,
  }));
}
function normalizeLedger(ledger, LV) {
  const verified = LV.verifyLedger(ledger);
  if (!verified.ok) throw new Error("INTEGRITY_LEDGER_INVALID:\n" + verified.problems.map(problem => `[${problem.code}] ${problem.message}`).join("\n"));
  const candidates = spineCandidates(verified);
  return {
    candidate_count: candidates.length,
    eligible_count: candidates.filter(candidate => candidate.eligible).length,
    judgment_heavy_count: verified.judgmentHeavyCount,
    candidates,
    status_counts: countBy(candidates, candidate => candidate.status),
    band_counts: countBy(candidates, candidate => candidate.band),
    action_counts: countBy(candidates, candidate => candidate.recommended_action || "unassigned"),
    effort_counts: countBy(candidates, candidate => candidate.effort || "unknown"),
  };
}
function normalizeArchitecture(candidateSet, optionalLedger, LV) {
  const seen = new Set();
  for (const candidate of candidateSet.candidates) {
    if (!nonempty(candidate.candidate_id) || seen.has(candidate.candidate_id)) throw new Error("ARCHITECTURE_CANDIDATE_ID_INVALID_OR_DUPLICATE");
    seen.add(candidate.candidate_id);
  }
  let scoredById = new Map();
  if (optionalLedger) {
    const verified = LV.verifyLedger(optionalLedger);
    if (!verified.ok) throw new Error("ARCHITECTURE_LEDGER_INVALID:\n" + verified.problems.map(problem => `[${problem.code}] ${problem.message}`).join("\n"));
    scoredById = new Map(verified.candidates.map(candidate => [candidate.candidate_id, candidate]));
  }
  const candidates = candidateSet.candidates.map((candidate, index) => {
    const scored = scoredById.get(candidate.ledger_candidate_ref || candidate.candidate_id) || null;
    return {
      candidate_id: candidate.candidate_id,
      title: candidate.title || candidate.candidate_id,
      transformation_kind: candidate.transformation_kind || "unspecified",
      structural_problem: candidate.structural_problem || "",
      proposed_state: candidate.proposed_state || "",
      disposition: candidate.disposition || "unassigned",
      critic_outcome: candidate.critic?.outcome || "not-recorded",
      unresolved_decision_count: Array.isArray(candidate.unresolved_decisions) ? candidate.unresolved_decisions.length : 0,
      rank: scored?.rank ?? index + 1,
      priority: finite(scored?.computed?.priority),
      value: finite(scored?.computed?.value),
      risk: finite(scored?.computed?.risk),
      band: scored ? (scored.band?.label || ledgerPriorityBand(scored.computed?.priority)) : "Not scored",
      score_state: scored ? "scored" : "not-scored",
    };
  });
  candidates.sort((a, b) => (b.priority ?? -Infinity) - (a.priority ?? -Infinity) || a.rank - b.rank || stableCompare(a.candidate_id, b.candidate_id));
  const architectureFitnessModule = require(path.resolve(__dirname, "..", "..", "architecture-improvement-intelligence", "assets", "architecture-fitness.js"));
  const fitnessInput = architectureFitnessModule.normalizeCandidateFitness(candidateSet);
  const fitness = fitnessInput.architecture_fitness ? architectureFitnessModule.readArchitectureFitness(fitnessInput.architecture_fitness) : null;
  return {
    candidate_count: candidates.length,
    scored_count: candidates.filter(candidate => candidate.priority !== null).length,
    candidates,
    disposition_counts: countBy(candidates, candidate => candidate.disposition),
    transformation_counts: countBy(candidates, candidate => candidate.transformation_kind),
    critic_counts: countBy(candidates, candidate => candidate.critic_outcome),
    coverage_receipt: candidateSet.coverage_receipt || null,
    fitness,
    ...(fitnessInput.architecture_fitness_unavailable ? { fitness_unavailable: fitnessInput.architecture_fitness_unavailable } : {}),
  };
}
function normalizeTestingFitness(file, ref, revision) {
  if (!file || !ref) return null;
  if (file.sha256 !== ref.sha256) throw new Error(`TESTING_FITNESS_SHA256_MISMATCH:expected=${ref.sha256}:actual=${file.sha256}`);
  const value = file.value;
  if (!value || value.schema_version !== "ria.testing-fitness@1") throw new Error("TESTING_FITNESS_SCHEMA_INVALID");
  if (value.source?.repository_revision && value.source.repository_revision !== revision) throw new Error("TESTING_FITNESS_REVISION_MISMATCH");
  return value;
}
/** Repository Health's Evidence Recon sidecar, carried as an evidence-recon specialist_ref
 * on the Health owner return. RIA is its consumer: it hash-binds the packet and lists it as
 * a specialist binding. It never contributes a score.
 *
 * Since evidence-recon 1.1.0 the packet may name the health artifact it was projected from
 * (producer.artifact_refs[kind=health-artifact]). When present, its sha256 must equal the
 * hash-bound Health artifact's sha256, or the sidecar belongs to a different health run.
 * A packet without the structured ref is a legacy 1.0.0 sidecar: tolerated, and recorded as
 * artifact_bound=false so the report does not claim a binding it never checked. */
function normalizeEvidenceRecon(file, ref, revision, healthSha256 = null) {
  if (!file || !ref) return null;
  if (file.sha256 !== ref.sha256) throw new Error(`EVIDENCE_RECON_SHA256_MISMATCH:expected=${ref.sha256}:actual=${file.sha256}`);
  if (ref.repository_revision && ref.repository_revision !== revision) throw new Error("EVIDENCE_RECON_REVISION_MISMATCH");
  const value = file.value;
  if (!value || Number(value.evidence_packet_version) !== 1) throw new Error("EVIDENCE_RECON_SCHEMA_INVALID");
  if (value.producer?.skill && value.producer.skill !== "repository-health-assessment") throw new Error(`EVIDENCE_RECON_FOREIGN_PRODUCER:${value.producer.skill}`);
  if (ref.packet_id && value.packet_id !== ref.packet_id) throw new Error("EVIDENCE_RECON_PACKET_ID_MISMATCH");
  const refs = value.producer?.artifact_refs;
  if (refs !== undefined && !Array.isArray(refs)) throw new Error("EVIDENCE_RECON_ARTIFACT_REFS_INVALID");
  const healthRefs = (refs || []).filter(item => item && item.kind === "health-artifact");
  if (healthRefs.length > 1) throw new Error("EVIDENCE_RECON_HEALTH_ARTIFACT_REF_DUPLICATE");
  let artifact_bound = false;
  if (healthRefs.length === 1) {
    const bound = healthRefs[0];
    if (typeof bound.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(bound.sha256)) throw new Error("EVIDENCE_RECON_HEALTH_ARTIFACT_REF_INVALID");
    if (!healthSha256) throw new Error("EVIDENCE_RECON_HEALTH_ARTIFACT_UNAVAILABLE");
    if (bound.sha256 !== healthSha256) throw new Error(`EVIDENCE_RECON_HEALTH_ARTIFACT_MISMATCH:expected=${healthSha256}:actual=${bound.sha256}`);
    artifact_bound = true;
  }
  return { packet_id: value.packet_id ?? null, sha256: file.sha256, path: file.path, artifact_bound };
}
/** Display-only split of Health claims that came from review-fitness reports
 * (claim.review_source, set by repository-health-assessment review-to-claims). proof_basis
 * "judgment" marks claims backed by a judged baseline (review-fitness-report v1.1
 * coverage.judged_rules); every other review-sourced claim is mechanical. Never scored. */
function reviewProofBasisCounts(claims) {
  const reviewed = (Array.isArray(claims) ? claims : []).filter(claim => claim && claim.review_source && typeof claim.review_source === "object");
  if (!reviewed.length) return null;
  const judgment = reviewed.filter(claim => claim.review_source.proof_basis === "judgment").length;
  return { review_claims: reviewed.length, mechanical: reviewed.length - judgment, judgment, treatment: "display only; never changes a score" };
}
function healthLaneMap(health) {
  return new Map((health.lanes || []).map((lane) => [lane.id, lane]));
}
/** Health's cap ceilings are letters on its own five-band rubric, anchored to the 0-4
 * maturity scale (health-verify.js). Passing the bare letter to the RIA scorer made it
 * resolve on the thirteen-band scale instead, so a Health "B" ceiling (below 90) became
 * a ceiling of 86.999. Translate to a score here, where the source rubric is known. */
const HEALTH_GRADE_FLOORS = Object.freeze([["A", 90], ["B", 75], ["C", 50], ["D", 25], ["F", 0]]);
function healthCeilingScore(letter) {
  const index = HEALTH_GRADE_FLOORS.findIndex(([grade]) => grade === letter);
  if (index === -1) return null;
  return index === 0 ? 100 : HEALTH_GRADE_FLOORS[index - 1][1] - 0.001;
}
function translateHealthCaps(caps) {
  return (Array.isArray(caps) ? caps : []).map((cap) => {
    const ceiling_score = healthCeilingScore(cap?.ceiling);
    return ceiling_score === null ? cap : { ...cap, ceiling_score, ceiling_rubric: "repository-health-assessment" };
  });
}
/** Optional Health lanes heavy enough to be critical (criticality_weight >= 4 in
 * health-verify.js HEALTH_LANE_DEFINITIONS). They are not RIA weights — RIA_WEIGHTS is the
 * fixed six-dimension table in shared/ria-scoring — so they are rendered explicitly and bind
 * the composite through Health's weakest-critical-lane cap, which translateHealthCaps carries. */
const HEALTH_OPTIONAL_CRITICAL_LANES = Object.freeze(["security-and-production-safety", "data-and-migrations"]);
function compositeAnalytics(health, architecture, testing) {
  const lanes = healthLaneMap(health);
  const dimension = (id, source = "repository-health-assessment") => {
    const lane = lanes.get(id);
    return { score: finite(lane?.score), source, coverage: health.weighted_coverage === null ? null : health.weighted_coverage / 100, confidence: health.confidence_index === null ? null : health.confidence_index / 100 };
  };
  // verification-readiness is ALWAYS Health's lane. review-testing now contributes claims
  // inside that lane upstream (repository-health-assessment review-to-claims), so letting a
  // ria.testing-fitness sidecar replace the lane score here would count the same evidence
  // twice — once as Health claims, once as the substituted score — while Health's cap on the
  // replaced lane still bound the composite.
  const dimensions = {
    "correctness-and-integrity": dimension("correctness-and-integrity"),
    "architecture-fitness": architecture.fitness
      ? { score: finite(architecture.fitness.score), source: "architecture-improvement-intelligence", coverage: finite(architecture.fitness.coverage), confidence: finite(architecture.fitness.confidence) }
      : dimension("architecture-fitness"),
    "contracts-and-integration": dimension("contracts-and-integration"),
    "verification-readiness": dimension("verification-readiness"),
    "build-and-delivery": dimension("build-and-delivery"),
    "maintainability-and-ownership": dimension("maintainability-and-ownership"),
  };
  const optional_critical_lanes = HEALTH_OPTIONAL_CRITICAL_LANES.filter((id) => lanes.has(id)).map((id) => {
    const lane = lanes.get(id);
    return { id, score: finite(lane.score), health_grade: lane.grade ?? null, criticality_weight: finite(lane.criticality_weight), critical: lane.critical === true, treatment: "rendered; binds the composite only through Health's weakest-critical-lane cap, never as extra RIA weight" };
  });
  const testing_informational = testing ? {
    source: "review-testing",
    score: finite(testing.score),
    grade: testing.grade ?? null,
    rubric_coverage: finite(testing.rubric_coverage),
    evidence_confidence: finite(testing.evidence_confidence),
    treatment: "informational; displayed beside the Health verification-readiness lane, never substituted and never combined with Health caps",
  } : null;
  const computed = weightedComposite(dimensions, undefined, translateHealthCaps(health.caps));
  if (health.not_gradable) {
    // Health refused to grade (core surface uninspected/unavailable or coverage below the
    // gradability floor). A letter computed over its lane scores would launder that refusal.
    return {
      ...computed,
      raw_score: null, raw_grade: null, final_score: null, final_grade: "Not gradable", binding_cap: null,
      not_gradable: true,
      reason: `Repository Health is Not gradable: ${health.not_gradable_reason || "reason not recorded"}`,
      optional_critical_lanes,
      testing_informational,
    };
  }
  return { ...computed, not_gradable: false, reason: null, optional_critical_lanes, testing_informational };
}

/** Health routes candidates to an owner (to_architecture / to_integrity) or to the human
 * decision queue; Integrity and Architecture route to their own disposition queues. */
const ROUTE_KEYS = Object.freeze(["ready", "needs_expanded_grill", "needs_decision_terrain_mapper", "needs_prototype", "blocked", "decision_queue", "to_architecture", "to_integrity"]);
const DISPOSITION_TO_ROUTE = Object.freeze({
  ready_for_integrity_loop: "ready",
  ready: "ready",
  needs_expanded_grill: "needs_expanded_grill",
  needs_decision_terrain_mapper: "needs_decision_terrain_mapper",
  needs_prototype: "needs_prototype",
  blocked_needs_human_decision: "decision_queue",
  "blocked-needs-human-decision": "decision_queue",
  "needs-human-decision": "decision_queue",
  blocked: "blocked",
});
/** spine-v3 recommended_action → the owner that acts on a Health candidate
 * (shared/candidate-ledger-spine/REPORT-SCORING.md:40). reject is never routed. */
const HEALTH_ACTION_TO_ROUTE = Object.freeze({
  design: "to_architecture",
  prototype: "to_architecture",
  "direct-fix": "to_integrity",
  "fitness-check": "to_integrity",
  triage: "to_integrity",
});
function healthRoute(candidate) {
  // Two names, one state: execution_mode blocked-needs-human-decision ⇔ status needs-human-decision.
  if (candidate.execution_mode === "blocked-needs-human-decision" || candidate.status === "needs-human-decision") return "decision_queue";
  return HEALTH_ACTION_TO_ROUTE[candidate.recommended_action] || null;
}
function ledgerRoute(candidate) {
  // execution_mode is a routing value only when it names the human-decision block;
  // sequential / swarm / connected-impact-sweep describe HOW to run, so fall back to status.
  if (candidate.execution_mode === "blocked-needs-human-decision") return "decision_queue";
  return DISPOSITION_TO_ROUTE[candidate.status] || null;
}
function deriveRouting(source, health, integrity, architecture) {
  const routing = source.downstream_routing || {};
  const authored = ROUTE_KEYS.some((key) => Array.isArray(routing[key]) && routing[key].length > 0);
  if (authored) return Object.fromEntries(ROUTE_KEYS.map((key) => [key, Array.isArray(routing[key]) ? routing[key].map(String) : []]));
  const buckets = Object.fromEntries(ROUTE_KEYS.map((key) => [key, []]));
  const push = (key, id) => { if (key && !buckets[key].includes(id)) buckets[key].push(id); };
  for (const candidate of architecture.candidates || []) push(DISPOSITION_TO_ROUTE[candidate.disposition], candidate.candidate_id);
  for (const candidate of integrity.candidates || []) push(ledgerRoute(candidate), candidate.candidate_id);
  for (const candidate of health.candidates || []) push(healthRoute(candidate), candidate.candidate_id);
  return buckets;
}
/** Namespace of a candidate id (`<namespace>:<local>`), or null for an unprefixed legacy id. */
const OWNER_NAMESPACES = Object.freeze({ [OWNERS[0]]: "health", [OWNERS[1]]: "integrity", [OWNERS[2]]: "architecture" });
function idNamespace(id) {
  const match = String(id || "").match(/^([a-z]+):/);
  return match && Object.values(OWNER_NAMESPACES).includes(match[1]) ? match[1] : null;
}
/** A candidate_id may appear under two owners only as an adopted upstream candidate:
 * either it carries one of those owners' namespace prefix (Integrity adopting a Health
 * ledger row keeps "health:<id>"), or — for legacy unprefixed ids — every copy carries the
 * same title, i.e. it is the same row. Any other repeat is a collision between two
 * independently minted ids and would merge unrelated candidates in routing and priorities. */
function assertNoCrossOwnerDuplicates(health, integrity, architecture) {
  const owners = new Map();
  const titles = new Map();
  const record = (owner, candidates) => { for (const candidate of candidates || []) { const id = String(candidate.candidate_id); if (!owners.has(id)) { owners.set(id, new Set()); titles.set(id, new Set()); } owners.get(id).add(owner); titles.get(id).add(String(candidate.title ?? "").trim().toLowerCase()); } };
  record(OWNERS[0], health.candidates);
  record(OWNERS[1], integrity.candidates);
  record(OWNERS[2], architecture.candidates);
  for (const [id, set] of owners) {
    if (set.size < 2) continue;
    const namespace = idNamespace(id);
    const origin = [...set].find((owner) => OWNER_NAMESPACES[owner] === namespace);
    const sameRow = namespace === null && titles.get(id).size === 1 && !titles.get(id).has("");
    if (!origin && !sameRow) throw new Error(`CANDIDATE_ID_CROSS_OWNER_DUPLICATE:${id}:${[...set].map(shortOwnerName).join("+")}: prefix each minted id with the owner's candidate_namespace (${Object.values(OWNER_NAMESPACES).join("|")}:)`);
  }
}
// SKILL.md promises the combined report synthesizes "cross-cutting patterns" and
// "uncertainty/coverage" — the whole reason a combined view beats three separate
// artifacts. Both were pass-throughs of a `synthesis` key the production path never
// supplies, so both rendered empty on every run while the section headers implied
// they had been checked and nothing was found. These derive them from the bound
// owner artifacts, which already carry the data.

const IDENTIFIER_TOKEN = /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g;
const PATH_LIKE = /^[A-Za-z0-9_@.-]+(?:[/][A-Za-z0-9_@.-]+)+$/;
const PATH_EXTENSION = /[.](?:js|jsx|ts|tsx|py|json|md|go|rs|java|rb|sql|sh|ya?ml|toml|ini|cfg)$/;

/** Tokens worth joining on: shared constant/identifier names and shared file paths.
 * Anything else is too weak to claim two owners are talking about the same thing. */
function mentionTokens(text) {
  const value = String(text || "");
  if (!value) return [];
  const tokens = new Set();
  for (const match of value.match(IDENTIFIER_TOKEN) || []) tokens.add(match);
  for (const word of value.split(/[^A-Za-z0-9_@./-]+/)) {
    const candidate = word.replace(/[.,;:)]+$/, "");
    if (PATH_LIKE.test(candidate) && PATH_EXTENSION.test(candidate)) tokens.add(candidate);
  }
  return [...tokens];
}

function ownerMentions(health, integrity, architecture) {
  const mentions = [];
  const add = (owner, token, label) => { if (token) mentions.push({ owner, token, label }); };
  for (const claim of health.claims || []) {
    const text = [claim.statement, claim.observation?.confirmed, claim.observation?.inferred, claim.observation?.unknown].filter(Boolean).join(" ");
    for (const token of mentionTokens(text)) add(OWNERS[0], token, `${claim.claim_id} (${claim.lane})`);
    for (const evidence of claim.evidence || []) if (nonempty(evidence.path)) add(OWNERS[0], evidence.path, `${claim.claim_id} (${claim.lane})`);
  }
  for (const candidate of health.candidates || []) for (const token of mentionTokens(candidate.title)) add(OWNERS[0], token, candidate.candidate_id);
  for (const candidate of integrity.candidates || []) for (const token of mentionTokens(candidate.title)) add(OWNERS[1], token, candidate.candidate_id);
  for (const candidate of architecture.candidates || []) {
    const text = [candidate.title, candidate.structural_problem, candidate.proposed_state].filter(Boolean).join(" ");
    for (const token of mentionTokens(text)) add(OWNERS[2], token, candidate.candidate_id);
  }
  return mentions;
}

function deriveCrossCutting(health, integrity, architecture) {
  const byToken = new Map();
  for (const mention of ownerMentions(health, integrity, architecture)) {
    if (!byToken.has(mention.token)) byToken.set(mention.token, new Map());
    const owners = byToken.get(mention.token);
    if (!owners.has(mention.owner)) owners.set(mention.owner, new Set());
    owners.get(mention.owner).add(mention.label);
  }
  const patterns = [];
  for (const [token, owners] of byToken) {
    if (owners.size < 2) continue;
    const parts = [...owners.entries()]
      .sort((a, b) => OWNERS.indexOf(a[0]) - OWNERS.indexOf(b[0]))
      .map(([owner, labels]) => `${shortOwnerName(owner)}: ${[...labels].sort().slice(0, 4).join(", ")}`);
    patterns.push({
      title: token,
      detail: `${owners.size} owners independently reference ${token}. ${parts.join(" · ")}.`,
      owners: [...owners.keys()].sort((a, b) => OWNERS.indexOf(a) - OWNERS.indexOf(b)),
      evidence_count: [...owners.values()].reduce((total, labels) => total + labels.size, 0),
    });
  }
  return patterns
    .sort((a, b) => b.owners.length - a.owners.length || b.evidence_count - a.evidence_count || stableCompare(a.title, b.title))
    .slice(0, 12);
}

function deriveUncertainty(health, architecture) {
  const confirmed = [], inferred = [], unknown = [];
  for (const claim of health.claims || []) {
    const label = `${claim.claim_id} (${claim.lane})`;
    if (nonempty(claim.observation?.confirmed)) confirmed.push(`${label}: ${claim.observation.confirmed}`);
    if (nonempty(claim.observation?.inferred)) inferred.push(`${label}: ${claim.observation.inferred}`);
    if (nonempty(claim.observation?.unknown)) unknown.push(`${label}: ${claim.observation.unknown}`);
    if (claim.result === "unknown" && !nonempty(claim.observation?.unknown)) unknown.push(`${label}: recorded as unknown with no observation`);
  }
  const coverage_gaps = [];
  for (const surface of health.surfaces || []) {
    if (surface.coverage === "unavailable") coverage_gaps.push(`surface ${surface.id} unavailable — ${surface.reason || "reason not recorded"}`);
    else if (surface.coverage === "partial") coverage_gaps.push(`surface ${surface.id} partially covered${surface.reason ? ` — ${surface.reason}` : ""}`);
  }
  if (architecture.coverage_receipt && typeof architecture.coverage_receipt === "object") {
    for (const [key, value] of Object.entries(architecture.coverage_receipt)) {
      if (Array.isArray(value) && value.length) coverage_gaps.push(`architecture coverage receipt ${key}: ${value.slice(0, 6).map(String).join(", ")}`);
    }
  }
  const sort = (values) => [...new Set(values)].sort(stableCompare);
  return { confirmed: sort(confirmed), inferred: sort(inferred), unknown: sort(unknown), coverage_gaps: sort(coverage_gaps) };
}

function normalizeSynthesis(request, health, integrity, architecture, composite = null) {
  const source = request.synthesis && typeof request.synthesis === "object" ? request.synthesis : {};
  const normalizedRouting = deriveRouting(source, health, integrity, architecture);
  const ownerSummaries = Array.isArray(source.owner_summaries) ? source.owner_summaries : [
    { owner: OWNERS[0], headline: `Grade ${health.final_grade} · ${health.score ?? "Not scored"}/100`, details: [`Weighted coverage ${health.weighted_coverage ?? "Unavailable"}%`, `Confidence ${health.confidence_index ?? "Unavailable"} (${health.confidence_band || "unknown"})`, `${health.candidate_count} health candidates`] },
    { owner: OWNERS[1], headline: `${integrity.candidate_count} integrity candidates`, details: [`${integrity.eligible_count} currently eligible`, `${integrity.judgment_heavy_count} judgment-heavy`, `${integrity.band_counts.map(row => `${row.label}: ${row.value}`).join(" · ") || "No candidate bands"}`] },
    { owner: OWNERS[2], headline: `${architecture.candidate_count} architecture candidates`, details: [`${architecture.scored_count} carry canonical ledger scores`, `${architecture.disposition_counts.map(row => `${row.label}: ${row.value}`).join(" · ") || "No dispositions"}`] },
  ];
  const byId = new Map([
    ...(health.candidates || []).map(candidate => [candidate.candidate_id, candidate]),
    ...integrity.candidates.map(candidate => [candidate.candidate_id, candidate]),
    ...architecture.candidates.map(candidate => [candidate.candidate_id, candidate]),
  ]);
  const sourcePriorities = Array.isArray(source.top_priorities) && source.top_priorities.length ? source.top_priorities.map((item) => ({
    ...item,
    priority_score: finite(item.priority_score ?? item.priority ?? byId.get(item.canonical_id)?.priority),
    priority_band: item.priority_band || byId.get(item.canonical_id)?.band || ledgerPriorityBand(item.priority_score ?? item.priority ?? byId.get(item.canonical_id)?.priority),
  })) : [
    ...(health.candidates || []).slice(0, 5).map(candidate => ({ title: candidate.title, why: `Canonical health priority ${candidate.priority ?? "not scored"}; ${candidate.band}.`, owner: OWNERS[0], canonical_id: candidate.candidate_id, disposition: candidate.execution_mode || candidate.status, priority_score: candidate.priority, priority_band: candidate.band })),
    ...integrity.candidates.slice(0, 7).map(candidate => ({ title: candidate.title, why: `Canonical integrity priority ${candidate.priority ?? "not scored"}; ${candidate.band}.`, owner: OWNERS[1], canonical_id: candidate.candidate_id, disposition: candidate.execution_mode || candidate.status, priority_score: candidate.priority, priority_band: candidate.band })),
    ...architecture.candidates.slice(0, 5).map(candidate => ({ title: candidate.title, why: candidate.structural_problem || "Architecture candidate survived the architecture critic.", owner: OWNERS[2], canonical_id: candidate.candidate_id, disposition: candidate.disposition, priority_score: candidate.priority, priority_band: candidate.band || ledgerPriorityBand(candidate.priority) })),
  ];
  const authoredPatterns = Array.isArray(source.cross_cutting_patterns) && source.cross_cutting_patterns.length;
  const crossCutting = authoredPatterns ? source.cross_cutting_patterns : deriveCrossCutting(health, integrity, architecture);
  const crossCuttingProvenance = authoredPatterns ? "authored" : "derived";
  const uncertaintyKeys = ["confirmed", "inferred", "unknown", "coverage_gaps"];
  const authoredUncertainty = uncertaintyKeys.some((key) => Array.isArray(source.uncertainty?.[key]) && source.uncertainty[key].length);
  const uncertainty = authoredUncertainty
    ? Object.fromEntries(uncertaintyKeys.map((key) => [key, Array.isArray(source.uncertainty?.[key]) ? source.uncertainty[key] : []]))
    : deriveUncertainty(health, architecture);
  const uncertaintyProvenance = authoredUncertainty ? "authored" : "derived";
  const priorities = sourcePriorities
    .map((item) => ({ ...item, priority_band: item.priority_band || ledgerPriorityBand(item.priority_score) }))
    .sort((a, b) => (b.priority_score ?? -Infinity) - (a.priority_score ?? -Infinity) || stableCompare(a.canonical_id, b.canonical_id))
    .slice(0, 12)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  return {
    overall_condition: nonempty(source.overall_condition) ? source.overall_condition : composite?.not_gradable ? `Overall RIA composite is Not gradable — ${composite.reason}. No letter is computed; ${integrity.candidate_count} integrity and ${architecture.candidate_count} architecture candidates remain listed.` : composite?.final_score !== null && composite?.final_score !== undefined ? `Overall RIA grade ${composite.final_grade} (${composite.final_score}/100) from the weighted assessment dimensions, with ${integrity.candidate_count} integrity and ${architecture.candidate_count} architecture candidates.` : `Repository health grade ${health.final_grade} (${health.score ?? "not scored"}/100) with ${integrity.candidate_count} integrity and ${architecture.candidate_count} architecture candidates.`,
    executive_summary: nonempty(source.executive_summary) ? source.executive_summary : `The assessment is bound to one immutable revision and three validated owner artifacts. Quantitative Health grading, canonical Integrity scoring, Architecture dispositions, coverage, verification, routing, and runtime data are rendered from those artifacts rather than re-authored prose.`,
    owner_summaries: ownerSummaries,
    cross_cutting_patterns: crossCutting,
    top_priorities: priorities,
    uncertainty,
    // A section that renders blank when nothing was computed is indistinguishable from
    // one that was computed and found nothing. The renderer needs to tell them apart.
    synthesis_provenance: { cross_cutting_patterns: crossCuttingProvenance, uncertainty: uncertaintyProvenance },
    downstream_routing: normalizedRouting,
  };
}
function performanceAnalytics(receipt) {
  const value = receipt && typeof receipt === "object" ? receipt : { mode: "not-recorded" };
  const humanize = label => String(label || "unknown").replace(/^owner-/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, character => character.toUpperCase());
  const rows = object => Object.entries(object || {}).map(([label, amount]) => ({ label: humanize(label), value: finite(amount) })).filter(row => row.value !== null);
  if (value.schema_version === "ria.performance-receipt@2") {
    const tasks = Array.isArray(value.tasks) ? value.tasks : [];
    const observed = item => finite(item?.value);
    const phases = tasks.filter(task => finite(task.duration_ms) !== null).map(task => ({ label: humanize(task.owner || task.task_id), value: finite(task.duration_ms), critical_path: (value.critical_path_task_ids || []).includes(task.task_id), state: task.state, task_id: task.task_id })).sort((a,b)=>Number(b.critical_path)-Number(a.critical_path)||b.value-a.value).slice(0,18);
    const toolCalls = tasks.filter(task => observed(task.tool_calls) !== null && observed(task.tool_calls) > 0).map(task => ({label:humanize(task.owner||task.task_id),value:observed(task.tool_calls)}));
    const tokenUsage = tasks.filter(task => observed(task.tokens) !== null && observed(task.tokens) > 0).map(task => ({label:humanize(task.owner||task.task_id),value:observed(task.tokens)}));
    const cacheCounts = countBy(tasks.filter(task=>task.cache_disposition!=="NOT_APPLICABLE"), task=>task.cache_disposition);
    return {
      raw:value, schema_version:value.schema_version, profile:"event-derived", wall_time_ms:observed(value.metrics?.actual_wall_ms), phases, tool_calls:toolCalls, token_usage:tokenUsage,
      cache:null, cache_counts:cacheCounts, cache_summary:cacheCounts.map(row=>`${row.label}: ${row.value}`).join(" · ")||"No cache telemetry",
      avoided_work:[{label:"Estimated reuse savings ms",value:observed(value.metrics?.cache_reuse_savings_ms)??0}], avoided_work_total:observed(value.metrics?.cache_reuse_savings_ms)??0,
      peaks:{ready_queue:observed(value.metrics?.ready_queue_peak),total_concurrency:observed(value.metrics?.peak_concurrency),refill_events:null}, class_concurrency:rows(value.class_budgets), overlap:[],
      task_states:countBy(tasks,task=>task.state||"unknown"), retries:0, cancellations:tasks.filter(task=>task.state==="cancelled").length, worker_budgets:{class_budgets:value.class_budgets},
      serial_work_ms:observed(value.metrics?.serial_work_ms), critical_path_ms:observed(value.metrics?.critical_path_ms), scheduler_overhead_ms:observed(value.metrics?.scheduler_overhead_ms), telemetry_status:value.telemetry_status,
    };
  }
  if (value.schema_version === "ria.performance-receipt@1") {
    const tasks = Array.isArray(value.tasks) ? value.tasks : [];
    const completedTasks = tasks.filter(task => finite(task.duration_ms) !== null && !["skipped", "blocked"].includes(task.state));
    const phases = completedTasks
      .map(task => ({ label: humanize(task.owner && task.owner !== "unknown" ? task.owner : task.id), value: finite(task.duration_ms), critical_path: task.critical_path === true, state: task.state, task_id: task.id }))
      .sort((a, b) => Number(b.critical_path) - Number(a.critical_path) || b.value - a.value || stableCompare(a.label, b.label))
      .slice(0, 18);
    const toolCalls = completedTasks.filter(task => finite(task.tool_calls) !== null && finite(task.tool_calls) > 0)
      .map(task => ({ label: humanize(task.owner && task.owner !== "unknown" ? task.owner : task.id), value: finite(task.tool_calls) }))
      .sort((a, b) => b.value - a.value || stableCompare(a.label, b.label)).slice(0, 16);
    const tokenUsage = completedTasks.filter(task => finite(task.tokens) !== null && finite(task.tokens) > 0)
      .map(task => ({ label: humanize(task.owner && task.owner !== "unknown" ? task.owner : task.id), value: finite(task.tokens) }))
      .sort((a, b) => b.value - a.value || stableCompare(a.label, b.label)).slice(0, 16);
    const cacheCounts = countBy(Object.entries(value.cache || {}), ([, state]) => state || "UNKNOWN");
    const avoidedWork = rows(value.avoided_work);
    const classConcurrency = rows(value.peaks?.class_concurrency);
    const overlap = [
      { label: "SEI + verification overlap", value: finite(value.overlap?.sei_verification_ms) },
      { label: "Owner parallel window", value: finite(value.overlap?.owner_parallel_window_ms) },
    ].filter(row => row.value !== null);
    const taskStates = countBy(tasks, task => task.state || "unknown");
    const retries = tasks.reduce((sum, task) => sum + (finite(task.retry_count) || 0), 0);
    const cancellations = tasks.reduce((sum, task) => sum + (finite(task.cancellation_count) || 0), 0);
    return {
      raw: value,
      schema_version: value.schema_version,
      profile: value.startup?.mode || "not-recorded",
      wall_time_ms: finite(value.wall_time_ms),
      phases,
      tool_calls: toolCalls,
      token_usage: tokenUsage,
      cache: value.cache || null,
      cache_counts: cacheCounts,
      cache_summary: cacheCounts.map(row => `${row.label}: ${row.value}`).join(" · ") || "No cache telemetry",
      avoided_work: avoidedWork,
      avoided_work_total: avoidedWork.reduce((sum, row) => sum + row.value, 0),
      peaks: {
        ready_queue: finite(value.peaks?.ready_queue),
        total_concurrency: finite(value.peaks?.total_concurrency),
        refill_events: finite(value.peaks?.refill_events),
      },
      class_concurrency: classConcurrency,
      overlap,
      task_states: taskStates,
      retries,
      cancellations,
      worker_budgets: value.worker_budgets || null,
    };
  }
  const phases = [];
  const push = (label, milliseconds) => { const numeric = finite(milliseconds); if (numeric !== null) phases.push({ label, value: numeric }); };
  push("Baseline + intelligence", value.baseline_and_engineering_intelligence_ms);
  push("Assembly / report", value.assembly_report_ms || value.report_build_ms || value.assembly_ms);
  for (const [owner, milliseconds] of Object.entries(value.owner_durations_ms || {})) push(humanize(owner), milliseconds);
  const toolCalls = rows(value.owner_tool_uses);
  return {
    raw: value,
    schema_version: null,
    phases,
    tool_calls: toolCalls,
    token_usage: rows(value.owner_tokens || value.owner_token_usage),
    profile: value.profile || value.mode || "not-recorded",
    wall_time_ms: finite(value.wall_time_ms),
    cache: value.cache || value.cache_status || null,
    cache_counts: typeof value.cache === "object" ? countBy(Object.entries(value.cache), ([, state]) => state || "UNKNOWN") : [],
    cache_summary: typeof value.cache === "string" ? value.cache : "Cache state unavailable",
    avoided_work: rows(value.avoided_work),
    avoided_work_total: rows(value.avoided_work).reduce((sum, row) => sum + row.value, 0),
    peaks: { ready_queue: finite(value.peaks?.ready_queue), total_concurrency: finite(value.peaks?.total_concurrency), refill_events: finite(value.peaks?.refill_events) },
    class_concurrency: rows(value.peaks?.class_concurrency),
    overlap: rows(value.overlap),
    task_states: [],
    retries: finite(value.retries) || 0,
    cancellations: finite(value.cancellations) || 0,
    worker_budgets: value.worker_budgets || null,
  };
}
function convergenceAnalytics(patterns) {
  const pairRows = [];
  for (const pattern of patterns || []) {
    const owners = [...new Set(Array.isArray(pattern.owners) ? pattern.owners : [])].sort(stableCompare);
    if (owners.length < 2) continue;
    pairRows.push({ label: owners.map(owner => owner.replace(/(?:repository-|codebase-|architecture-|improvement-|assessment|audit-loop|intelligence)/g, "").replace(/-+/g, " ").trim() || owner).join(" + "), value: 1 });
  }
  const grouped = new Map();
  for (const row of pairRows) grouped.set(row.label, (grouped.get(row.label) || 0) + row.value);
  return [...grouped.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || stableCompare(a.label, b.label));
}
/** composite-scoring-v3 Phase 8: the v2 composite, computed on every report beside v1 and
 * shown as an uncalibrated shadow. `v2` carries what the bound run knows beyond the three
 * owner files: { architecture_evidence, sei: {status, assessment, sha256}, verification:
 * {artifact, sha256}, run: {failed_tasks, allow_degraded} }. Absent pieces degrade the
 * shadow explicitly (missing evidence); they never change v1. */
function compositeV2ForReport({ request, validated, HV, healthRaw, integrityRaw, architectureRaw, files, v2 }) {
  const { compositeV2Analytics, headlineSelection } = require("./composite-v2-model.js");
  const binding = { repository_id: request.baseline_ref?.artifact_id || "baseline:unbound", root_id: "root-0", revision: validated.repository.revision };
  const context = v2 && typeof v2 === "object" ? v2 : {};
  const sources = [
    ...files.map(([owner, file]) => ({ kind: "owner-artifact", owner, sha256: file.sha256 })),
    ...(context.sei?.status === "bound" ? [{ kind: "sei-assessment", sha256: context.sei.sha256 }] : []),
    ...(context.verification?.sha256 ? [{ kind: "verification-baseline", sha256: context.verification.sha256 }] : []),
    ...(context.architecture_evidence ? [{ kind: "architecture-evidence-binding", schema_version: context.architecture_evidence.schema_version, packets: (context.architecture_evidence.packets ?? []).map(item => item.sha256 ?? item.legacy_ref ?? null) }] : []),
  ];
  const result = compositeV2Analytics({
    health: { raw: healthRaw, verified: HV.verifyHealth(healthRaw) },
    integrity: { raw: integrityRaw },
    architecture: { raw: architectureRaw, receipt: context.architecture_evidence ?? null },
    sei: context.sei ?? { status: "missing", assessment: null, sha256: null },
    verification: context.verification ?? null,
    binding,
    run: context.run ?? { failed_tasks: [], allow_degraded: false },
    source_bindings: sources,
    sources: context.sources ?? null,
    receipts: context.receipts ?? null,
  });
  return { ...result.composite, headline: headlineSelection(result.composite), binder_limitations: result.limitations, rejected_links: result.rejected_links };
}

/** Narrow availability fallback for the v2 shadow (composite-scoring-v3 §5.3; Promotion A
 * deployment review 2026-10-17). Returns a reason string only when `error` is a missing
 * implementation file of the shadow itself (a module or data file under the skills tree that a
 * partial deployment removed, or FAIL-RIA-COMPOSITE-IMPLEMENTATION-MISSING naming a file on the
 * config loader's own IMPLEMENTATION_FILES list that is in fact absent) AND the presentation
 * policy, read directly, reports v1. Every other error returns null and must be rethrown:
 * every other FAIL-* code (FAIL-RIA-COMPOSITE-CONFIG included), non-degradable blockers
 * (receipt hash mismatches, binding failures, invalid evidence), bare-package resolution, and
 * any error when the policy is unreadable or selects v2 as the headline. */
function compositeV2Unavailable(error) {
  if (!error || error.non_degradable === true) return null;
  const skills = path.resolve(__dirname, "..", "..");
  let missing = null;
  if (error.code === "FAIL-RIA-COMPOSITE-IMPLEMENTATION-MISSING") {
    let declared = [];
    try { declared = require(path.join(skills, "shared", "ria-scoring", "composite-v2-config.js")).IMPLEMENTATION_FILES ?? []; } catch { return null; }
    const relative = error.missing_implementation;
    if (typeof relative !== "string" || !declared.includes(relative)) return null;
    const file = path.resolve(skills, ...relative.split("/"));
    if (fs.existsSync(file)) return null;
    missing = file;
  } else if (/^FAIL-/.test(String(error.code ?? ""))) return null;
  else if (error.code === "MODULE_NOT_FOUND") {
    const named = /Cannot find module '([^']+)'/.exec(String(error.message))?.[1] ?? null;
    if (named && path.isAbsolute(named)) missing = named;
    else if (named && named.startsWith(".") && Array.isArray(error.requireStack) && error.requireStack[0]) missing = path.resolve(path.dirname(error.requireStack[0]), named);
  } else if (error.code === "ENOENT" && typeof error.path === "string") missing = error.path;
  if (!missing || path.relative(skills, path.resolve(missing)).startsWith("..") || path.isAbsolute(path.relative(skills, path.resolve(missing)))) return null;
  let policy;
  try { policy = JSON.parse(fs.readFileSync(path.join(skills, "shared", "ria-scoring", "composite-v2.policy.json"), "utf8")); } catch { return null; }
  if (policy?.reported_composite !== "v1") return null;
  return `v2 shadow unavailable: ${path.relative(skills, path.resolve(missing)).replace(/\\/g, "/")} is missing from this installation; v1 is the reported composite`;
}

function buildReportData({ request, healthFile, integrityFile, architectureFile, testingFitnessFile = null, evidenceReconFile = null, skillRoot, fixture = false, v2 = null }) {
  const validated = validateRequest(request, { fixture });
  const { LV, HV } = loadVerifiers(skillRoot);
  const healthRaw = bindArtifact(OWNERS[0], validated.refs.get(OWNERS[0]), healthFile, healthPayload, validated.repository.revision);
  const integrityRaw = bindArtifact(OWNERS[1], validated.refs.get(OWNERS[1]), integrityFile, integrityPayload, validated.repository.revision);
  const architectureRaw = bindArtifact(OWNERS[2], validated.refs.get(OWNERS[2]), architectureFile, architecturePayload, validated.repository.revision);
  const health = normalizeHealth(healthRaw, HV, LV);
  const integrity = normalizeLedger(integrityRaw, LV);
  const architecture = normalizeArchitecture(architectureRaw, architectureLedger(architectureFile.value), LV);
  assertNoCrossOwnerDuplicates(health, integrity, architecture);
  const testing = normalizeTestingFitness(testingFitnessFile, request.testing_fitness_ref ?? null, validated.repository.revision);
  const evidenceRecon = normalizeEvidenceRecon(evidenceReconFile, request.evidence_recon_ref ?? null, validated.repository.revision, healthFile.sha256);
  const coverage = normalizeCoverageMetrics(request.coverage_metrics ?? testing?.coverage_metrics ?? null);
  const composite = compositeAnalytics(health, architecture, testing);
  let compositeV2 = null, compositeV2UnavailableReason = null;
  try { compositeV2 = compositeV2ForReport({ request, validated, HV, healthRaw, integrityRaw, architectureRaw, files: [[OWNERS[0], healthFile], [OWNERS[1], integrityFile], [OWNERS[2], architectureFile]], v2 }); }
  catch (error) { compositeV2UnavailableReason = compositeV2Unavailable(error); if (compositeV2UnavailableReason === null) throw error; }
  const synthesis = normalizeSynthesis(request, health, integrity, architecture, composite);
  const routingCounts = Object.entries(synthesis.downstream_routing).map(([label, values]) => ({ label: label.replaceAll("_", " "), value: values.length }));
  const healthCount = (health.candidates || []).length;
  const integrityCount = integrity.candidate_count;
  const architectureCount = architecture.candidate_count;
  const shownCount = healthCount + integrityCount + architectureCount;
  const totalCount = (finite(health.candidate_count) ?? healthCount) + integrityCount + architectureCount;
  const candidatePortfolio = {
    shown: shownCount,
    total: totalCount,
    health: healthCount,
    integrity: integrityCount,
    architecture: architectureCount,
  };
  const trend = request.trend && typeof request.trend === "object" ? request.trend : { schema_version: "ria.trend@1", status: "no-comparable-prior", prior: null, deltas: [] };
  const quantitativeSignal = [health.score, health.weighted_coverage, health.confidence_index, integrity.candidate_count, architecture.candidate_count].filter(value => finite(value) !== null);
  if (!quantitativeSignal.length) throw new Error("REPORT_SUFFICIENCY_FAILED:NO_QUANTITATIVE_SIGNAL");
  return canonical({
    report_schema_version: 3,
    generated_at: new Date().toISOString(),
    repository: validated.repository,
    mode: request.mode || "read-only",
    baseline_ref: validated.baseline,
    engineering_intelligence_ref: request.engineering_intelligence_ref || null,
    assessment_refs: request.assessment_refs,
    report_election: validated.election,
    artifact_bindings: [
      { owner: OWNERS[0], path: healthFile.path, sha256: healthFile.sha256 },
      { owner: OWNERS[1], path: integrityFile.path, sha256: integrityFile.sha256 },
      { owner: OWNERS[2], path: architectureFile.path, sha256: architectureFile.sha256 },
    ],
    specialist_bindings: [
      ...(testing && testingFitnessFile ? [{ kind: "testing-fitness", path: testingFitnessFile.path, sha256: testingFitnessFile.sha256 }] : []),
      ...(evidenceRecon ? [{ kind: "evidence-recon", path: evidenceRecon.path, sha256: evidenceRecon.sha256 }] : []),
    ],
    analytics: {
      health,
      integrity,
      architecture,
      testing,
      coverage,
      composite,
      ...(compositeV2 ? { composite_v2: compositeV2 } : {}),
      routing_counts: routingCounts,
      candidate_portfolio: candidatePortfolio,
      trend,
      verification_trust: request.verification_trust && typeof request.verification_trust === "object" ? request.verification_trust : null,
      convergence_counts: convergenceAnalytics(synthesis.cross_cutting_patterns),
      performance: performanceAnalytics(request.performance_receipt),
      sei_telemetry: request.sei_telemetry_summary ?? { schema_version:"sei.telemetry-summary@1", gate_observation_ratio:null, gate_observation_status:"UNAVAILABLE", failure_code:"NOT_RECORDED" },
    },
    synthesis,
    blockers: Array.isArray(request.blockers) ? request.blockers.map(String) : [],
    provenance: {
      report_model: "repository-improvement-assessment-report-data@3",
      production_binding_enforced: !fixture,
      child_artifacts_hash_verified: true,
      child_artifacts_revision_verified: true,
      health_grading_recomputed: true,
      integrity_scoring_recomputed: true,
      architecture_fitness_recomputed: architecture.fitness !== null,
      testing_fitness_hash_verified: testing !== null,
      testing_fitness_substituted: false,
      evidence_recon_hash_verified: evidenceRecon !== null,
      evidence_recon_artifact_bound: evidenceRecon !== null && evidenceRecon.artifact_bound === true,
      composite_not_gradable_propagated: composite.not_gradable === true,
      composite_scoring_recomputed: true,
      composite_v2_shadow: compositeV2 !== null,
      composite_v2_reported: compositeV2?.reported === true,
      ...(compositeV2UnavailableReason ? { composite_v2_unavailable: compositeV2UnavailableReason } : {}),
      architecture_scores_fabricated: false,
    },
  });
}

module.exports = {
  OWNERS,
  canonical,
  canonicalJson,
  sha256,
  readJson,
  buildReportData,
  validateRequest,
  compositeAnalytics,
  compositeV2ForReport,
  compositeV2Unavailable,
  deriveRouting,
  assertNoCrossOwnerDuplicates,
  placeholderHash,
  normalizeEvidenceRecon,
  reviewProofBasisCounts,
};
