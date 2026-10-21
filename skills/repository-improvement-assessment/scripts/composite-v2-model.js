"use strict";
// RIA composite v2 shadow binder (composite-scoring-v3 §5.2, §6, §7, §9; instructions Phase 8).
//
// Builds the normalized `ria.composite-v2.input@1` document from the four bound owner
// artifacts, the verification baseline and the bound SEI assessment, then calls the pure
// engine. Artifact parsing and binding live here; the engine does numerical work only.
// v1 stays the reported composite: this module never changes `compositeAnalytics`.
//
// Normalization choices the spec leaves open are marked [assumed] and listed in the RIA
// SKILL.md "Composite v2 shadow" section:
//   * Health facts are the claims each lane's dimension scores cite (claim_refs). A cited
//     claim's line-bound evidence is strong when the claim is mechanical
//     (review_source.proof_basis) or carries a confirmed observation, otherwise moderate;
//     whole-file evidence is moderate. Health's verification/delivery contributions also hold
//     the executed shared verification commands (test kinds for verification, other kinds for
//     delivery) as strong original facts (§6.3: the shared receipt is attributed to Health).
//   * SEI facts are the observations of the mapped dimension's applicable criteria; quality
//     follows criterion confidence (HIGH strong, MODERATE moderate, LOW weak).
//   * Integrity facts are the code evidence of findings it holds in the dimension (strong when
//     the finding is confirmed, else moderate), plus the path refs of inspected or sampled
//     coverage surfaces at their declared quality, plus negative-claim path sources.
//   * Architecture facts come from the architecture.evidence-binding@1 receipt.
//   * Baseline command status maps passed->pass, failed->fail, timed-out->timed-out,
//     skipped->skipped and unavailable->error ("could not start", §9.2).

const fs = require("node:fs");
const path = require("node:path");

const SKILLS = path.resolve(__dirname, "..", "..");
const EM = require(path.join(SKILLS, "shared", "ria-scoring", "evidence-model.js"));
const { computeCompositeV2 } = require(path.join(SKILLS, "shared", "ria-scoring", "composite-v2.js"));
const { loadScoringConfig, loadPresentationPolicy } = require(path.join(SKILLS, "shared", "ria-scoring", "composite-v2-config.js"));
const { integrityConfidence, integrityDimensionScore, integrityEligibility } = require(path.join(SKILLS, "shared", "ria-scoring", "integrity-scoring.js"));
const { readArchitectureFitness, WEIGHTS: FITNESS_WEIGHTS } = require(path.join(SKILLS, "architecture-improvement-intelligence", "assets", "architecture-fitness.js"));

const OWNERS = Object.freeze(["health", "architecture", "integrity", "sei"]);
const STATUS_TO_OUTCOME = Object.freeze({ passed: "pass", failed: "fail", "timed-out": "timed-out", skipped: "skipped", unavailable: "error" });
const SEI_QUALITY = Object.freeze({ HIGH: "strong", MODERATE: "moderate", LOW: "weak" });
const INPUT_SCHEMA_PATH = path.join(SKILLS, "shared", "ria-scoring", "composite-v2.input.schema.json");

function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function finite(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function unique(values) { return [...new Set(values)].sort(compare); }
function blocker(code, detail) { const error = new Error(`${code}: ${detail}`); error.code = code; error.non_degradable = true; throw error; }

/** Keys -> facts; unclassifiable entries are recorded, never silently dropped. */
function factsFrom(entries, context, { quality, origin = "original", origin_ref = null }, sink) {
  const facts = [];
  for (const entry of entries) {
    let classified;
    try { classified = EM.classifyEvidence(entry, context); }
    catch (error) { sink.push(`evidence ${JSON.stringify(entry).slice(0, 80)} is not bound: ${error.message}`); continue; }
    for (const key of classified.keys) {
      const sei = key.kind === "sei-metric";
      facts.push({ ...key, quality: sei ? "moderate" : quality, origin: sei ? "adopted" : origin, origin_ref: sei ? "sei" : origin_ref });
    }
  }
  return facts;
}

function dependenceFor(owner, dimension, facts, factors, threshold) {
  const result = EM.contributionDependence({ owner, dimension, facts, factors, threshold });
  const strongOriginal = result.facts.some(fact => fact.origin === "original" && fact.quality === "strong");
  return {
    dependence: {
      classification: result.classification,
      origin_owners: result.origin_owners.filter(item => OWNERS.includes(item) && item !== owner),
      adopted_strength_ratio: result.adopted_strength_ratio,
      evidence_keys: result.facts.map(fact => ({ key: fact.key, kind: fact.kind, quality: fact.quality, origin: fact.origin, origin_ref: fact.origin_ref ?? null })),
    },
    strong_original: strongOriginal,
    limitations: result.limitations,
  };
}

/* --------------------------------- Health --------------------------------- */

function healthContributions({ config, health, verified, context, factors, threshold, commands }) {
  const out = {};
  const lanesById = new Map((verified.lanes ?? []).map(lane => [lane.lane, lane]));
  const rawLanes = new Map((health.lanes ?? []).map(lane => [lane.lane, lane]));
  const claims = new Map((health.claims ?? []).map(claim => [claim.claim_id, claim]));
  const applicability = health.lane_applicability ?? {};
  const coverage = finite(verified.coverage?.weighted_coverage);
  const confidenceIndex = finite(verified.confidence?.index);
  const notGradable = verified.grade?.not_gradable === true || verified.grade?.final_grade === "Not gradable";
  const eligibility = config.eligibility.health;
  for (const [dimension, spec] of Object.entries(config.dimensions)) {
    const laneId = spec.sources.health?.lane;
    if (!laneId) continue;
    const limitations = [];
    const lane = lanesById.get(laneId);
    if (!lane) {
      if (applicability[laneId]?.state === "not-applicable") { out[dimension] = { eligibility: "not_applicable", limitations: [`Health declared lane ${laneId} not applicable: ${applicability[laneId].rationale}`] }; continue; }
      out[dimension] = { eligibility: "not_assessed", limitations: [`Health did not score lane ${laneId}`] };
      continue;
    }
    const score = finite(lane.computed?.score);
    if (notGradable) limitations.push(`Health is Not gradable: ${verified.grade?.reason ?? "no reason recorded"}`);
    if (coverage === null || coverage < eligibility.min_weighted_coverage) limitations.push(`Health weighted coverage ${coverage} is below ${eligibility.min_weighted_coverage}`);
    if (confidenceIndex === null) limitations.push("Health confidence index is unavailable");
    if (score === null) limitations.push(`lane ${laneId} has no computed score`);
    const sink = [];
    const cited = unique(Object.values(rawLanes.get(laneId)?.scores ?? {}).flatMap(entry => (entry?.claim_refs ?? []).map(ref => ref.claim_id)));
    let facts = [];
    for (const id of cited) {
      const claim = claims.get(id);
      if (!claim || claim.result === "unknown") continue;
      const mechanical = claim.review_source?.proof_basis === "mechanical";
      const confirmed = nonempty(claim.observation?.confirmed);
      for (const entry of claim.evidence ?? []) {
        const bound = typeof entry?.path === "string" && nonempty(entry.lines);
        facts.push(...factsFrom([entry], context, { quality: bound && (mechanical || confirmed) ? "strong" : "moderate" }, sink));
      }
    }
    if (spec.sources.health && (dimension === "verification" || dimension === "delivery") && context.verificationBaselineSha256) {
      const wanted = commands.filter(command => (dimension === "verification" ? command.kind === "test" : command.kind !== "test") && (command.outcome === "pass" || command.outcome === "fail"));
      facts.push(...wanted.map(command => ({ ...EM.commandKey(context.verificationBaselineSha256, command.command_id), quality: "strong", origin: "original", origin_ref: null })));
    }
    const dep = dependenceFor("health", dimension, facts, factors, threshold);
    if (limitations.length) { out[dimension] = { eligibility: "insufficient_evidence", limitations: [...limitations, ...sink] }; continue; }
    const established = coverage >= eligibility.established_min_weighted_coverage;
    out[dimension] = {
      eligibility: "scored", score, confidence: confidenceIndex / 100, coverage: coverage / 100,
      maturity: established ? "established" : "provisional", provisional: !established,
      baseline_dependent: dimension === "verification" || dimension === "delivery",
      strong_original: dep.strong_original, dependence: dep.dependence, limitations: [...sink, ...dep.limitations],
    };
  }
  return out;
}

function healthCriticalFailure(config, health, verified) {
  const value = health.uncontained_critical_failure;
  if (!verified.ok || !value || typeof value !== "object") return null;
  const claim = (health.claims ?? []).find(item => item.claim_id === value.claim_id);
  if (!claim) return null;
  const lane = claim.lane;
  const dimension = Object.entries(config.dimensions).find(([, spec]) => spec.sources.health?.lane === lane)?.[0] ?? config.lane_dimension_map?.[lane]?.[0] ?? null;
  if (!dimension) return null;
  return { claim_id: claim.claim_id, dimension, admissible: claim.result === "fail" && claim.review_source?.proof_basis !== "judgment" };
}

/* ------------------------------ Architecture ------------------------------ */

function architectureContributions({ config, artifact, receipt, factors, threshold }) {
  const out = {};
  const fitness = artifact.architecture_fitness ? readArchitectureFitness(artifact.architecture_fitness) : null;
  for (const [dimension, spec] of Object.entries(config.dimensions)) {
    const ids = spec.sources.architecture?.fitness_dimensions;
    if (!ids) continue;
    if (!fitness) {
      const reason = artifact.architecture_fitness_unavailable ? `${artifact.architecture_fitness_unavailable.reason_code}: ${artifact.architecture_fitness_unavailable.detail}` : "no architecture fitness";
      out[dimension] = { eligibility: "insufficient_evidence", limitations: [`Architecture fitness unavailable (${reason})`] };
      continue;
    }
    const states = ids.map(id => fitness.dimensions[id]);
    if (states.every(item => item.state === "not_applicable")) { out[dimension] = { eligibility: "not_applicable", limitations: ids.map(id => `${id}: ${fitness.dimensions[id].reason_code}`) }; continue; }
    // A scored fitness sub-dimension is eligible only when its cited claims all resolved to
    // bound facts (receipt `evidence_complete`). Otherwise it is insufficient_evidence and its
    // weight stays as missing mass that widens the contribution's bounds (§4.1, §8.3).
    const facts = [];
    const evidenceLimits = [];
    if (!receipt) evidenceLimits.push("architecture evidence receipt unavailable (architecture.evidence-binding@1)");
    const evidenced = new Set();
    for (const id of ids) {
      if (fitness.dimensions[id].state !== "scored") continue;
      const entry = receipt?.dimensions?.[id];
      if (!entry) { if (receipt) evidenceLimits.push(`${id}: no evidence entry in the binding receipt`); continue; }
      evidenceLimits.push(...entry.limitations);
      if (entry.evidence_complete === true && entry.facts.length > 0) { evidenced.add(id); facts.push(...entry.facts); }
      else evidenceLimits.push(`${id}: cited evidence did not fully resolve; sub-score ineligible`);
    }
    const stateOf = (id) => fitness.dimensions[id].state === "not_applicable" ? "not_applicable" : evidenced.has(id) ? "scored" : "insufficient_evidence";
    const sub_scores = ids.map(id => ({ id, weight: FITNESS_WEIGHTS[id], state: stateOf(id), score: stateOf(id) === "scored" ? fitness.dimensions[id].score : null }));
    const applicableWeight = sub_scores.filter(sub => sub.state !== "not_applicable").reduce((total, sub) => total + sub.weight, 0);
    const eligibleWeight = sub_scores.filter(sub => sub.state === "scored").reduce((total, sub) => total + sub.weight, 0);
    const mapped = { coverage: applicableWeight ? eligibleWeight / applicableWeight : null, complete: applicableWeight > 0 && eligibleWeight === applicableWeight };
    const limitations = [];
    if (eligibleWeight === 0) limitations.push("no mapped fitness sub-score is scored with resolved evidence");
    if (mapped.coverage === null || mapped.coverage < config.eligibility.architecture.min_mapped_coverage) limitations.push(`mapped fitness coverage ${mapped.coverage} is below ${config.eligibility.architecture.min_mapped_coverage}`);
    if (finite(fitness.confidence) === null) limitations.push("fitness confidence is absent");
    if (limitations.length) { out[dimension] = { eligibility: "insufficient_evidence", limitations: unique([...limitations, ...evidenceLimits]) }; continue; }
    const dep = dependenceFor("architecture", dimension, facts, factors, threshold);
    out[dimension] = {
      eligibility: "scored", sub_scores, confidence: fitness.confidence, coverage: mapped.coverage,
      maturity: mapped.complete && evidenceLimits.length === 0 ? "established" : "provisional", provisional: !mapped.complete || evidenceLimits.length > 0,
      strong_original: dep.strong_original, dependence: dep.dependence, limitations: unique([...evidenceLimits, ...dep.limitations]),
    };
  }
  return out;
}

/* -------------------------------- Integrity ------------------------------- */

/** Normalized findings (§6.4) from one owner's spine rows. Finding ids are namespaced by
 * owner ("health/CONTRACT-007", "integrity/integrity:CORR-001") so the same record held by
 * two owners stays two members; Integrity's adopted rows link to the Health record they
 * adopted, which merges them into one canonical group. */
function ownerFindings({ config, owner, rows, binding, context }) {
  const findings = [];
  const limitations = [];
  for (const row of rows ?? []) {
    const minted = owner === "integrity" ? String(row.candidate_id).startsWith("integrity:") : true;
    let dimensions = Array.isArray(row.ria_dimensions) ? row.ria_dimensions : null;
    const rowLimits = [];
    if (!dimensions) {
      const derived = EM.deriveAdoptedDimensions(row.lane_sources, config.lane_dimension_map);
      dimensions = derived.dimensions;
      rowLimits.push(...derived.limitations);
    }
    if (!dimensions.length) { limitations.push(`${owner}/${row.candidate_id}: no RIA dimension (${rowLimits.join("; ") || "untagged"})`); continue; }
    const proof = row.ria_proof ?? null;
    const sink = [];
    const keys = factsFrom(row.evidence ?? [], context, { quality: "moderate" }, sink);
    const discoveredBy = row.candidate_lifecycle?.discovered_by ?? null;
    findings.push({
      finding_id: `${owner}/${row.candidate_id}`,
      record_id: row.candidate_id,
      owner,
      origin: minted ? "original" : "adopted",
      origin_ref: minted ? null : (discoveredBy === "repository-health-assessment" ? "health" : discoveredBy),
      adopted_from: null,
      dimensions,
      defect_class: row.defect_class ?? null,
      severity: Number.isInteger(row.scores?.severity) ? row.scores.severity : null,
      predicate: proof?.failure_predicate ?? null,
      binding: proof?.input_binding ?? binding,
      evidence_keys: keys,
      proofs: proof?.proofs ?? [],
      containment: proof?.containment ?? null,
      dedup: { duplicate_group: row.dedup?.duplicate_group ?? null, merged_from: row.dedup?.merged_from ?? [] },
      limitations: [...rowLimits, ...sink],
    });
  }
  return { findings, limitations };
}

/** All owners' findings with record references resolved to namespaced finding ids. */
function canonicalFindings({ config, health, ledger, binding, context }) {
  const healthPart = ownerFindings({ config, owner: "health", rows: health?.candidates ?? [], binding, context });
  const integrityPart = ownerFindings({ config, owner: "integrity", rows: ledger?.candidates ?? [], binding, context });
  const findings = [...healthPart.findings, ...integrityPart.findings];
  const ids = new Set(findings.map(finding => finding.finding_id));
  const resolve = (owner, ref) => [`${owner}/${ref}`, `health/${ref}`, `integrity/${ref}`].find(id => ids.has(id)) ?? `${owner}/${ref}`;
  for (const finding of findings) {
    finding.dedup = { ...finding.dedup, merged_from: finding.dedup.merged_from.map(ref => resolve(finding.owner, ref)) };
    if (finding.owner === "integrity" && finding.origin === "adopted" && ids.has(`health/${finding.record_id}`)) finding.adopted_from = `health/${finding.record_id}`;
  }
  return { findings, limitations: [...healthPart.limitations, ...integrityPart.limitations] };
}

function integrityContributions({ config, ledger, coverageResult, grouping, findings, context, factors, threshold }) {
  const out = {};
  const byId = new Map(findings.map(finding => [finding.finding_id, finding]));
  for (const [dimension, spec] of Object.entries(config.dimensions)) {
    const defectDimension = spec.sources.integrity?.defect_dimension;
    if (!defectDimension) continue;
    if (!coverageResult?.ok) { out[dimension] = { eligibility: "insufficient_evidence", limitations: [`integrity.coverage@2 unavailable or invalid: ${(coverageResult?.problems ?? ["no coverage receipt"]).slice(0, 3).join("; ")}`] }; continue; }
    if (coverageResult.sources_verified !== true) { out[dimension] = { eligibility: "insufficient_evidence", limitations: ["integrity.coverage@2 path refs were not resolved at the assessed revision (no repository source available to the binder)"] }; continue; }
    const receipt = coverageResult.dimensions[defectDimension];
    if (receipt?.applicable_weight === 0 || receipt?.not_applicable) { out[dimension] = { eligibility: "not_applicable", limitations: [`Integrity declared ${defectDimension} not applicable`] }; continue; }
    const held = grouping.groups.filter(group => group.dimension === defectDimension && group.holders.includes("integrity"));
    const eligibility = integrityEligibility(receipt.coverage, config);
    const scored = integrityDimensionScore({ groups: held, absenceSupported: receipt.absence_supported === true, config });
    const confidence = integrityConfidence({ coverage: receipt.coverage, qSurface: receipt.q_surface, groups: held, negativeClaimQuality: receipt.negative_claim_quality, factors });
    const limitations = [...scored.limitations];
    if (eligibility.state !== "scored") limitations.push(`Integrity coverage ${receipt.coverage} is below ${config.eligibility.integrity.provisional_min_coverage}`);
    if (scored.state !== "scored") { out[dimension] = { eligibility: "insufficient_evidence", limitations }; continue; }
    if (eligibility.state !== "scored") { out[dimension] = { eligibility: "insufficient_evidence", limitations }; continue; }
    if (confidence === null) { out[dimension] = { eligibility: "insufficient_evidence", limitations: [...limitations, "Integrity confidence has no admissible evidence quality"] }; continue; }
    const sink = [];
    const facts = [];
    for (const group of held) for (const id of group.members) {
      const finding = byId.get(id);
      if (!finding) continue;
      facts.push(...finding.evidence_keys.map(key => ({ ...key, quality: group.confirmed ? "strong" : key.quality, origin: key.origin === "adopted" ? "adopted" : finding.origin, origin_ref: key.origin === "adopted" ? key.origin_ref : finding.origin_ref })));
    }
    const dimensionReceipt = ledger.coverage?.dimensions?.[defectDimension];
    for (const surface of dimensionReceipt?.surfaces ?? []) {
      if (!["inspected", "sampled"].includes(surface.state) || !EM.QUALITIES.includes(surface.evidence_quality)) continue;
      facts.push(...factsFrom((surface.evidence_refs ?? []).filter(ref => ref.kind === "path").map(ref => ({ kind: "path", ref: ref.ref })), context, { quality: surface.evidence_quality }, sink));
    }
    for (const claim of dimensionReceipt?.negative_claims ?? []) {
      if (!EM.QUALITIES.includes(claim.evidence_quality)) continue;
      facts.push(...factsFrom((claim.sources ?? []).filter(source => source.kind === "path" || source.kind === "line"), context, { quality: claim.evidence_quality }, sink));
    }
    const dep = dependenceFor("integrity", dimension, facts, factors, threshold);
    const unresolved = grouping.unresolved.some(entry => entry.members.some(id => byId.get(id)?.dimensions.includes(defectDimension)));
    const contested = held.some(group => group.evidentiary_state === "contested");
    const complete = receipt.coverage >= 1 - 1e-9;
    out[dimension] = {
      eligibility: "scored", score: scored.score, confidence, coverage: receipt.coverage,
      maturity: complete && !eligibility.provisional && !unresolved ? "established" : "provisional",
      provisional: eligibility.provisional || unresolved || !complete,
      unresolved_contradictions: contested,
      strong_original: dep.strong_original, dependence: dep.dependence,
      limitations: unique([...limitations, ...sink, ...dep.limitations, ...(unresolved ? ["unresolved potential duplicates prevent a final Integrity contribution"] : [])]),
    };
  }
  return out;
}

/* ----------------------------------- SEI ---------------------------------- */

function seiContributions({ config, loaded, sei, context, factors, threshold }) {
  const out = {};
  const rubricWeights = new Map((loaded.imports?.sei_rubric ?? []).map(item => [item.dimension_id, item.weight]));
  for (const [dimension, spec] of Object.entries(config.dimensions)) {
    const ids = spec.sources.sei?.dimensions;
    if (!ids) continue;
    if (sei.status !== "bound") { out[dimension] = { eligibility: "failed", limitations: [sei.status === "unavailable" ? `bound SEI evidence unavailable (${sei.reason}): SEI contribution failed, shadow is degraded` : "no bound SEI assessment (allowed legacy run): SEI contribution failed, shadow is degraded"] }; continue; }
    const records = new Map((sei.assessment.dimensions ?? []).map(item => [item.dimension_id, item]));
    const evaluate = (id) => {
      const record = records.get(id);
      if (!record) return { id, eligible: false, reason: `SEI has no dimension ${id}` };
      const eligible = config.eligibility.sei.eligible_maturities.includes(record.maturity) && !config.eligibility.sei.ineligible_confidences.includes(record.confidence) && finite(record.score) !== null;
      return { id, record, eligible, confidence: config.sei_confidence[record.confidence] ?? null, reason: eligible ? null : `SEI ${id} maturity ${record.maturity}, confidence ${record.confidence}` };
    };
    const evaluated = ids.map(evaluate);
    const sink = [];
    const facts = [];
    for (const criterion of sei.assessment.criteria ?? []) {
      if (!ids.includes(criterion.dimension_id) || criterion.applicability !== "applicable") continue;
      const quality = SEI_QUALITY[criterion.confidence];
      if (!quality) continue;
      for (const observation of criterion.evidence?.observations ?? []) {
        if (!nonempty(observation.observation_id)) continue;
        facts.push({ ...EM.seiMetricKey(context.seiAssessmentSha256, criterion.criterion_id, observation.observation_id), quality, origin: "original", origin_ref: null });
      }
    }
    const dep = dependenceFor("sei", dimension, facts, factors, threshold);
    const eligible = evaluated.filter(item => item.eligible);
    if (!eligible.length) { out[dimension] = { eligibility: "insufficient_evidence", limitations: evaluated.map(item => item.reason) }; continue; }
    if (ids.length === 1) {
      const only = eligible[0];
      out[dimension] = {
        eligibility: "scored", score: only.record.score, confidence: only.confidence, coverage: finite(only.record.coverage),
        maturity: only.record.maturity === "established" ? "established" : "provisional", provisional: only.record.maturity !== "established",
        strong_original: dep.strong_original, dependence: dep.dependence, limitations: [...sink, ...dep.limitations],
      };
      continue;
    }
    // change_and_docs (§5.2): each SEI sub-dimension evaluated on its own, combined by rubric weight.
    const sub_scores = evaluated.map(item => ({ id: item.id, weight: rubricWeights.get(item.id) ?? 0, state: item.eligible ? "scored" : "insufficient_evidence", score: item.eligible ? item.record.score : null, confidence: item.eligible ? item.confidence : null, maturity: item.eligible ? (item.record.maturity === "established" ? "established" : "provisional") : "unavailable" }));
    const provisional = evaluated.some(item => !item.eligible || item.record.maturity !== "established");
    out[dimension] = {
      eligibility: "scored", sub_scores, maturity: provisional ? "provisional" : "established", provisional,
      strong_original: dep.strong_original, dependence: dep.dependence, limitations: unique([...sink, ...dep.limitations, ...evaluated.filter(item => !item.eligible).map(item => item.reason)]),
    };
  }
  return out;
}

/* -------------------------------- assembly -------------------------------- */

function verificationCommands(baseline) {
  if (!baseline) return [];
  return [...(baseline.commands ?? [])].map(command => {
    const outcome = STATUS_TO_OUTCOME[command.status];
    if (!outcome) blocker("FAIL-RIA-COMPOSITE-V2-VERIFICATION", `command ${command.id} has unknown status ${command.status}`);
    return { command_id: command.id, kind: command.kind, outcome };
  }).sort((a, b) => compare(a.command_id, b.command_id));
}

/** lineCount-style resolver over the assessed source snapshot, or null when the binder has
 * no repository to read (then nothing that needs path resolution can score). */
function sourceResolver(sources) {
  if (!sources || typeof sources.repository_root !== "string" || !sources.snapshot) return null;
  const { revisionReader } = require(path.join(SKILLS, "architecture-improvement-intelligence", "assets", "architecture-evidence-binding.js"));
  return revisionReader(path.resolve(sources.repository_root), sources.snapshot);
}

/** §7.2 receipt store: content-addressed `<sha256>.json` files (ria.proof-receipt@1) in the
 * run's receipt directories. Absent bytes are missing evidence (the proof is inadmissible);
 * bytes that do not hash to their name, or are not JSON, are tampering and block. */
function receiptReader(receipts) {
  const directories = Array.isArray(receipts?.directories) ? receipts.directories.filter(item => typeof item === "string") : [];
  const crypto = require("node:crypto");
  return function readReceipt(sha256) {
    if (!/^[a-f0-9]{64}$/.test(String(sha256))) return { status: "missing" };
    for (const directory of directories) {
      const file = path.join(path.resolve(directory), `${sha256}.json`);
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== sha256) blocker("FAIL-RIA-PROOF-RECEIPT", `receipt ${file} does not hash to its name`);
      let receipt;
      try { receipt = JSON.parse(bytes.toString("utf8")); } catch (error) { blocker("FAIL-RIA-PROOF-RECEIPT", `receipt ${file} is not JSON: ${error.message}`); }
      return { status: "present", receipt };
    }
    return { status: "missing" };
  };
}

/**
 * Builds and computes the v2 shadow composite.
 * ctx: {
 *   health: { raw, verified },            raw bound island and HV.verifyHealth(raw)
 *   integrity: { raw },                   bound ledger
 *   architecture: { raw, receipt },       bound candidate set and its evidence-binding receipt (or null)
 *   sei: { status: "bound" | "missing", assessment, sha256 },
 *   verification: { artifact, sha256 } | null,
 *   binding: { repository_id, root_id, revision },
 *   run: { failed_tasks, allow_degraded },
 *   source_bindings: [...],
 *   sources: { repository_root, snapshot } | null,   where cited paths resolve (§7.1 rule 4)
 *   receipts: { directories: [...] } | null,           where proof receipts are stored (§7.2)
 *   loaded?, policy?, calibration_verified?
 * }
 * Returns { input, composite }.
 */
function compositeV2Analytics(ctx) {
  const loaded = ctx.loaded ?? loadScoringConfig();
  const policy = ctx.policy ?? loadPresentationPolicy();
  const config = loaded.config;
  const factors = EM.strengthFactors({ evidence_qualities: loaded.imports.evidence_qualities, health_evidence_factor: loaded.imports.health_evidence_factor });
  const threshold = config.dependence.adopted_strength_threshold;
  const commands = verificationCommands(ctx.verification?.artifact ?? null);
  const commandIds = new Map(commands.map(command => [command.command_id, command.command_id]));
  const resolveSource = sourceResolver(ctx.sources);
  const context = {
    binding: ctx.binding,
    casePolicy: "sensitive",
    seiAssessmentSha256: ctx.sei?.status === "bound" ? ctx.sei.sha256 : null,
    verificationBaselineSha256: ctx.verification?.sha256 ?? null,
    commandIdFor: (ref) => commandIds.get(ref) ?? null,
    readReceipt: receiptReader(ctx.receipts),
    resolveSource,
    seiHasMetric: (criterionId, metricId) => (ctx.sei?.assessment?.criteria ?? []).some(criterion => criterion.criterion_id === criterionId && (criterion.evidence?.observations ?? []).some(o => o.observation_id === metricId || (o.source_metric_ids ?? []).includes(metricId))),
  };
  const { findings, limitations: findingLimits } = canonicalFindings({ config, health: ctx.health?.raw ?? null, ledger: ctx.integrity?.raw ?? null, binding: ctx.binding, context });
  const grouping = EM.groupCanonicalDefects(findings, context);
  const byId = new Map(findings.map(finding => [finding.finding_id, finding]));
  const groups = grouping.groups.map(group => {
    const checks = group.members.map(id => byId.get(id)?.containment ? EM.containmentVerified(byId.get(id).containment, group.predicate_id, context) : null).filter(Boolean);
    const contained = checks.some(check => check.contained);
    const { limitations, ...rest } = group;
    return { ...rest, limitations: contained ? limitations : unique([...limitations, ...checks.flatMap(check => check.limitations)]), cap_eligible: true, contained };
  });
  let coverageResult = null;
  try {
    const { verifyIntegrityCoverage } = require(path.join(SKILLS, "codebase-integrity-audit-loop", "assets", "integrity-coverage.js"));
    coverageResult = ctx.integrity?.raw ? verifyIntegrityCoverage(ctx.integrity.raw, { revision: ctx.binding.revision, loaded, resolveSource, resolveCommand: (ref) => commandIds.has(ref) }) : { ok: false, problems: ["no Integrity artifact"], dimensions: {} };
  } catch (error) { coverageResult = { ok: false, problems: [error.message], dimensions: {} }; }

  // An owner whose artifact is absent (the owner task failed) contributes `failed` everywhere
  // it is mapped (§5.1): the run is degraded and never final (§9.1).
  const failedOwner = (owner, reason) => Object.fromEntries(Object.entries(config.dimensions).filter(([, spec]) => spec.shares[owner]).map(([dimension]) => [dimension, { eligibility: "failed", limitations: [reason] }]));
  const perOwner = {
    health: ctx.health?.raw ? healthContributions({ config, health: ctx.health.raw, verified: ctx.health.verified, context, factors, threshold, commands }) : failedOwner("health", "Health owner artifact unavailable: owner task failed"),
    architecture: ctx.architecture?.raw ? architectureContributions({ config, artifact: ctx.architecture.raw, receipt: ctx.architecture.receipt ?? null, factors, threshold }) : failedOwner("architecture", "Architecture owner artifact unavailable: owner task failed"),
    integrity: ctx.integrity?.raw ? integrityContributions({ config, ledger: ctx.integrity.raw, coverageResult, grouping: { ...grouping, groups }, findings, context, factors, threshold }) : failedOwner("integrity", "Integrity owner artifact unavailable: owner task failed"),
    sei: seiContributions({ config, loaded, sei: ctx.sei ?? { status: "missing" }, context, factors, threshold }),
  };
  const dimensions = {};
  for (const dimension of Object.keys(config.dimensions)) {
    const contributions = {};
    for (const owner of OWNERS) if (perOwner[owner][dimension]) contributions[owner] = perOwner[owner][dimension];
    dimensions[dimension] = { contributions };
  }
  const input = {
    schema_version: "ria.composite-v2.input@1",
    run: { failed_tasks: unique(ctx.run?.failed_tasks ?? []), allow_degraded: ctx.run?.allow_degraded === true },
    verification: { commands },
    dimensions,
    canonical_defects: { groups, unresolved: grouping.unresolved, health_uncontained_critical_failure: ctx.health?.raw ? healthCriticalFailure(config, ctx.health.raw, ctx.health.verified) : null },
    presentation: { reported_composite: policy.policy.reported_composite, policy_sha256: policy.policy_sha256, calibration_ref: policy.policy.calibration_ref ?? null, calibration_verified: ctx.calibration_verified === true },
    source_bindings: ctx.source_bindings ?? [],
  };
  const composite = computeCompositeV2(loaded, input, { inputSchema: JSON.parse(fs.readFileSync(INPUT_SCHEMA_PATH, "utf8")) });
  return { input, composite, limitations: unique([...findingLimits, ...(coverageResult?.limitations ?? [])]), rejected_links: grouping.rejected_links };
}

/** Headline selection (D6): v2 headlines only under a promoted policy with a verified
 * calibration receipt; otherwise v1. Promotion B changes policy, never this code. */
function headlineSelection(compositeV2) {
  return compositeV2 && compositeV2.reported === true ? "v2" : "v1";
}

/** §5.3 missing versus corrupt: bound SEI bytes that are simply absent leave SEI missing
 * (failed contributions, degraded shadow), like a missing Architecture packet file; a hash,
 * shape, path or binding problem blocks. */
function readSeiOrMissing(read) {
  try { return read(); }
  catch (error) {
    if (/FAIL-(ENGINEERING-INTELLIGENCE|SEI-ASSESSMENT)-ARTIFACT-NOT-FOUND/.test(String(error.message))) return { assessment_status: "unavailable", reason: error.message };
    blocker("FAIL-RIA-COMPOSITE-V2-SEI", error.message);
  }
}

/** Where proof receipts live (§7.2): Integrity's workspace receipt store in the assessed
 * repository, then the RIA runtime root's receipts directory. [assumed] location. */
function receiptDirectories(repositoryRoot, runtimeRoot) {
  return [path.join(repositoryRoot, ".project-intelligence", "assessments", "integrity", "receipts"), runtimeRoot ? path.join(runtimeRoot, "receipts") : null].filter(Boolean);
}

/** The v2 context a bound run supplies to buildReportData, from the report-data node's
 * dependencies. SEI is read through the Phase 6 reader: a genuinely absent legacy
 * assessment is "missing" (degraded shadow); hash, shape, path or binding problems block. */
function v2ContextFromRun({ dependencies, baseline, request }) {
  const verified = dependencies["owner-artifact-verification"] ?? {};
  const envelope = verified.input_binding_echo ?? null;
  const repositoryRoot = baseline.repository.roots[0].root;
  let sei = { status: "missing", assessment: null, sha256: null };
  if (envelope) {
    const { readSeiEvidence } = require("../engineering-intelligence-reader.js");
    let evidence;
    evidence = readSeiOrMissing(() => readSeiEvidence({ repository_root: repositoryRoot, envelope, allowed_roots: [path.join(repositoryRoot, ".project-intelligence"), request.runtime_root].filter(Boolean) }));
    if (evidence.assessment_status === "bound") sei = { status: "bound", assessment: evidence.assessment, sha256: envelope.sei_assessment_ref.artifact_sha256 };
    else if (evidence.assessment_status === "unavailable") sei = { status: "unavailable", assessment: null, sha256: null, reason: evidence.reason };
  }
  const verification = dependencies["verification-baseline"];
  const root = baseline.repository.roots[0];
  return {
    architecture_evidence: verified.architecture_evidence ?? null,
    sources: { repository_root: repositoryRoot, snapshot: root.head_revision && root.revision === root.head_revision ? { kind: "git", revision: root.revision } : { kind: "worktree" } },
    receipts: { directories: receiptDirectories(repositoryRoot, request.runtime_root) },
    sei,
    verification: verification?.artifact ? { artifact: verification.artifact, sha256: verification.verification_baseline_ref?.file_sha256 ?? verification.verification_baseline_ref?.sha256 ?? verification.artifact.content_sha256 } : null,
    run: { failed_tasks: (verified.failures ?? []).map(item => (item.owner ? `owner:${item.owner}` : String(item.code))), allow_degraded: request.allow_degraded === true },
  };
}

/** The same v2 context for the standalone report CLI, re-derived from bound bytes: the owner
 * envelope's SEI assessment (reader), its verification baseline (re-hashed) and Architecture's
 * evidence receipt (re-resolved in consume mode). Tampering blocks; absence degrades. */
function v2ContextFromEnvelope({ envelope, repositoryRoot, architectureArtifact, allowedRoots = null }) {
  const roots = allowedRoots ?? [path.join(repositoryRoot, ".project-intelligence"), process.env.RIA_RUNTIME_ROOT].filter(Boolean);
  const { readSeiEvidence } = require("../engineering-intelligence-reader.js");
  let sei = { status: "missing", assessment: null, sha256: null };
  let evidence;
  evidence = readSeiOrMissing(() => readSeiEvidence({ repository_root: repositoryRoot, envelope, allowed_roots: roots }));
  if (evidence.assessment_status === "bound") sei = { status: "bound", assessment: evidence.assessment, sha256: envelope.sei_assessment_ref.artifact_sha256 };
  else if (evidence.assessment_status === "unavailable") sei = { status: "unavailable", assessment: null, sha256: null, reason: evidence.reason };
  let verification = null;
  const ref = envelope.verification_baseline_ref;
  if (ref) {
    const expected = ref.file_sha256 || ref.sha256;
    if (!ref.path || !expected) blocker("FAIL-RIA-COMPOSITE-V2-VERIFICATION", "verification_baseline_ref needs path and file_sha256/sha256");
    const crypto = require("node:crypto");
    const bytes = fs.readFileSync(path.resolve(ref.path));
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected) blocker("FAIL-RIA-COMPOSITE-V2-VERIFICATION", `verification baseline bytes changed at ${ref.path}`);
    verification = { artifact: JSON.parse(bytes.toString("utf8")), sha256: expected };
  }
  const { bindingFromEnvelope, resolveArchitectureEvidence, sourceSnapshotFor } = require(path.join(SKILLS, "architecture-improvement-intelligence", "assets", "architecture-evidence-binding.js"));
  let receipt;
  try { receipt = resolveArchitectureEvidence(architectureArtifact, { mode: "consume", repositoryRoot, binding: bindingFromEnvelope(envelope), allowedRoots: roots }); }
  catch (error) { blocker("FAIL-RIA-ARCHITECTURE-EVIDENCE", error.message); }
  const snapshot = receipt?.source_snapshot ?? sourceSnapshotFor(repositoryRoot, bindingFromEnvelope(envelope).revision);
  return {
    architecture_evidence: receipt, sei, verification, run: { failed_tasks: [], allow_degraded: false },
    sources: { repository_root: repositoryRoot, snapshot },
    receipts: { directories: receiptDirectories(repositoryRoot, process.env.RIA_RUNTIME_ROOT) },
  };
}

module.exports = { STATUS_TO_OUTCOME, compositeV2Analytics, headlineSelection, receiptDirectories, verificationCommands, v2ContextFromEnvelope, v2ContextFromRun };
