"use strict";

const EVIDENCE_PACKET_VERSION = 1;
const EXPEDITION_LANE_VERSION = 1;
const COVERAGE_STATES = Object.freeze(["inspected", "sampled", "inventory-only", "uninspected", "unavailable", "not-applicable"]);
const EVIDENCE_QUALITIES = Object.freeze(["strong", "moderate", "weak", "none"]);
const EPISTEMIC_STATUSES = Object.freeze(["confirmed", "inferred", "unknown"]);
const CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low", "none"]);
const RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
const MODES = Object.freeze(["inline", "expedition"]);
const SOURCE_KINDS = Object.freeze(["path", "line", "command", "runtime", "test", "document", "history", "inventory", "external", "other"]);
const COMPLETENESS = Object.freeze(["targeted", "representative", "exhaustive"]);
const SEARCH_COMPLETENESS = Object.freeze(["unknown", "representative", "bounded-exhaustive", "repository-exhaustive"]);
const CONTRADICTION_STATES = Object.freeze(["resolved", "partially-resolved", "unresolved"]);
const LANE_STATES = Object.freeze(["complete", "partial", "failed", "blocked"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function add(problems, code, path, message) {
  problems.push({ code, path, message });
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function checkId(value, problems, path) {
  if (!hasText(value) || !ID_RE.test(value)) add(problems, "id-invalid", path, "must be a stable non-empty identifier matching " + ID_RE);
}

function checkEnum(value, allowed, problems, path, code) {
  if (!allowed.includes(value)) add(problems, code || "enum-invalid", path, `must be one of: ${allowed.join(", ")}`);
}

function checkStringArray(value, problems, path, options = {}) {
  if (!Array.isArray(value)) {
    add(problems, "array-required", path, "must be an array");
    return;
  }
  if (options.minItems && value.length < options.minItems) add(problems, "array-too-short", path, `must contain at least ${options.minItems} item(s)`);
  const seen = new Set();
  value.forEach((item, index) => {
    if (!hasText(item)) add(problems, "string-required", `${path}[${index}]`, "must be a non-empty string");
    if (options.unique && seen.has(item)) add(problems, "duplicate-value", `${path}[${index}]`, `duplicate value: ${item}`);
    seen.add(item);
  });
}

function checkSourceRef(source, problems, path) {
  if (!isObject(source)) {
    add(problems, "source-invalid", path, "must be an object");
    return;
  }
  checkEnum(source.kind, SOURCE_KINDS, problems, `${path}.kind`, "source-kind-invalid");
  if (!hasText(source.ref)) add(problems, "source-ref-missing", `${path}.ref`, "must be a non-empty stable reference");
  if (source.note !== undefined && typeof source.note !== "string") add(problems, "source-note-invalid", `${path}.note`, "must be a string when present");
}

function checkSources(sources, problems, path) {
  if (!Array.isArray(sources)) {
    add(problems, "sources-required", path, "must be an array");
    return;
  }
  sources.forEach((source, index) => checkSourceRef(source, problems, `${path}[${index}]`));
}

function checkCoverage(coverage, evidenceQuality, problems, path) {
  if (!isObject(coverage)) {
    add(problems, "coverage-invalid", path, "must be an object");
    return;
  }
  checkEnum(coverage.state, COVERAGE_STATES, problems, `${path}.state`, "coverage-state-invalid");
  if (!hasText(coverage.scope)) add(problems, "coverage-scope-missing", `${path}.scope`, "must state the surface actually covered");
  checkStringArray(coverage.methods, problems, `${path}.methods`);
  checkStringArray(coverage.limitations, problems, `${path}.limitations`);
  if (["unavailable", "not-applicable"].includes(coverage.state) && !hasText(coverage.reason)) {
    add(problems, "coverage-reason-missing", `${path}.reason`, `${coverage.state} requires a reason`);
  }
  if (coverage.state === "inspected" && !["strong", "moderate"].includes(evidenceQuality)) {
    add(problems, "coverage-evidence-mismatch", path, "inspected coverage requires strong or moderate evidence quality");
  }
}

function checkConfidence(confidence, problems, path) {
  if (!isObject(confidence)) {
    add(problems, "confidence-invalid", path, "must be an object");
    return;
  }
  checkEnum(confidence.level, CONFIDENCE_LEVELS, problems, `${path}.level`, "confidence-level-invalid");
  if (!hasText(confidence.rationale)) add(problems, "confidence-rationale-missing", `${path}.rationale`, "must explain why this confidence level is warranted");
}

function validateClaimShape(claim, problems, path) {
  if (!isObject(claim)) {
    add(problems, "claim-invalid", path, "must be an object");
    return;
  }
  checkId(claim.claim_id, problems, `${path}.claim_id`);
  if (!hasText(claim.statement)) add(problems, "claim-statement-missing", `${path}.statement`, "must be a non-empty statement");
  checkEnum(claim.epistemic_status, EPISTEMIC_STATUSES, problems, `${path}.epistemic_status`, "epistemic-status-invalid");
  checkEnum(claim.evidence_quality, EVIDENCE_QUALITIES, problems, `${path}.evidence_quality`, "evidence-quality-invalid");
  checkCoverage(claim.coverage, claim.evidence_quality, problems, `${path}.coverage`);
  checkSources(claim.sources, problems, `${path}.sources`);
  checkConfidence(claim.confidence, problems, `${path}.confidence`);
  checkStringArray(claim.supports, problems, `${path}.supports`, { unique: true });
  checkStringArray(claim.contradiction_refs, problems, `${path}.contradiction_refs`, { unique: true });
  checkStringArray(claim.limitations, problems, `${path}.limitations`);
  if (["confirmed", "inferred"].includes(claim.epistemic_status) && (!Array.isArray(claim.sources) || claim.sources.length === 0)) {
    add(problems, "claim-sources-missing", `${path}.sources`, `${claim.epistemic_status} claims require at least one source`);
  }
  if (claim.epistemic_status === "confirmed" && ["weak", "none"].includes(claim.evidence_quality)) {
    add(problems, "confirmed-evidence-too-weak", `${path}.evidence_quality`, "confirmed claims require strong or moderate evidence");
  }
  if (claim.epistemic_status === "unknown" && claim.confidence && claim.confidence.level === "high") {
    add(problems, "unknown-high-confidence", `${path}.confidence.level`, "unknown claims cannot carry high confidence");
  }
  if (claim.origin_lane !== undefined) checkId(claim.origin_lane, problems, `${path}.origin_lane`);
}

function validateNegativeClaimShape(claim, problems, path) {
  if (!isObject(claim)) {
    add(problems, "negative-claim-invalid", path, "must be an object");
    return;
  }
  checkId(claim.negative_claim_id, problems, `${path}.negative_claim_id`);
  if (!hasText(claim.statement)) add(problems, "negative-claim-statement-missing", `${path}.statement`, "must be a non-empty statement");
  checkStringArray(claim.search_scope, problems, `${path}.search_scope`, { minItems: 1 });
  checkStringArray(claim.search_methods, problems, `${path}.search_methods`, { minItems: 1 });
  checkEnum(claim.evidence_quality, EVIDENCE_QUALITIES, problems, `${path}.evidence_quality`, "evidence-quality-invalid");
  checkCoverage(claim.coverage, claim.evidence_quality, problems, `${path}.coverage`);
  checkSources(claim.sources, problems, `${path}.sources`);
  checkStringArray(claim.exclusions, problems, `${path}.exclusions`);
  checkEnum(claim.search_completeness, SEARCH_COMPLETENESS, problems, `${path}.search_completeness`, "search-completeness-invalid");
  if (typeof claim.supports_absence !== "boolean") add(problems, "supports-absence-invalid", `${path}.supports_absence`, "must be boolean");
  checkConfidence(claim.confidence, problems, `${path}.confidence`);
  checkStringArray(claim.limitations, problems, `${path}.limitations`);
  if (claim.origin_lane !== undefined) checkId(claim.origin_lane, problems, `${path}.origin_lane`);

  if (claim.supports_absence === true) {
    if (!claim.coverage || claim.coverage.state !== "inspected") add(problems, "negative-claim-coverage-insufficient", `${path}.coverage.state`, "supports_absence=true requires inspected coverage");
    if (!["strong", "moderate"].includes(claim.evidence_quality)) add(problems, "negative-claim-evidence-insufficient", `${path}.evidence_quality`, "supports_absence=true requires strong or moderate evidence");
    if (!["bounded-exhaustive", "repository-exhaustive"].includes(claim.search_completeness)) add(problems, "negative-claim-search-not-exhaustive", `${path}.search_completeness`, "supports_absence=true requires bounded-exhaustive or repository-exhaustive search");
    if (!Array.isArray(claim.sources) || claim.sources.length === 0) add(problems, "negative-claim-sources-missing", `${path}.sources`, "supports_absence=true requires at least one search receipt");
    if (!Array.isArray(claim.exclusions)) add(problems, "negative-claim-exclusions-missing", `${path}.exclusions`, "exclusions must be explicitly recorded, including [] when none");
  }
}

function validateContradictionShape(item, problems, path) {
  if (!isObject(item)) {
    add(problems, "contradiction-invalid", path, "must be an object");
    return;
  }
  checkId(item.contradiction_id, problems, `${path}.contradiction_id`);
  checkStringArray(item.claim_refs, problems, `${path}.claim_refs`, { minItems: 2, unique: true });
  checkEnum(item.status, CONTRADICTION_STATES, problems, `${path}.status`, "contradiction-status-invalid");
  checkStringArray(item.authority_order, problems, `${path}.authority_order`);
  if (typeof item.resolution !== "string") add(problems, "contradiction-resolution-invalid", `${path}.resolution`, "must be a string");
  if (typeof item.remaining_uncertainty !== "string") add(problems, "contradiction-uncertainty-invalid", `${path}.remaining_uncertainty`, "must be a string");
  if (!hasText(item.consequence)) add(problems, "contradiction-consequence-missing", `${path}.consequence`, "must state why the conflict matters");
  if (item.status === "resolved" && !hasText(item.resolution)) add(problems, "contradiction-resolution-missing", `${path}.resolution`, "resolved contradiction requires a resolution");
  if (item.status === "unresolved" && !hasText(item.remaining_uncertainty)) add(problems, "contradiction-uncertainty-missing", `${path}.remaining_uncertainty`, "unresolved contradiction requires remaining uncertainty");
  if (item.status === "partially-resolved" && (!hasText(item.resolution) || !hasText(item.remaining_uncertainty))) {
    add(problems, "contradiction-partial-incomplete", path, "partially-resolved contradiction requires both resolution and remaining uncertainty");
  }
  if (item.origin_lane !== undefined) checkId(item.origin_lane, problems, `${path}.origin_lane`);
}

function validateLaneReceiptShape(receipt, problems, path) {
  if (!isObject(receipt)) {
    add(problems, "lane-receipt-invalid", path, "must be an object");
    return;
  }
  checkId(receipt.lane_id, problems, `${path}.lane_id`);
  if (!hasText(receipt.surface)) add(problems, "lane-surface-missing", `${path}.surface`, "must be a non-empty surface description");
  checkEnum(receipt.status, LANE_STATES, problems, `${path}.status`, "lane-status-invalid");
  checkStringArray(receipt.claim_refs, problems, `${path}.claim_refs`, { unique: true });
  checkStringArray(receipt.negative_claim_refs, problems, `${path}.negative_claim_refs`, { unique: true });
  checkStringArray(receipt.contradiction_refs, problems, `${path}.contradiction_refs`, { unique: true });
  checkStringArray(receipt.limitations, problems, `${path}.limitations`);
}

function validateEvidencePacket(packet) {
  const problems = [];
  if (!isObject(packet)) return { ok: false, problems: [{ code: "packet-invalid", path: "$", message: "packet must be an object" }] };
  if (packet.evidence_packet_version !== EVIDENCE_PACKET_VERSION) add(problems, "packet-version", "$.evidence_packet_version", `must equal ${EVIDENCE_PACKET_VERSION}`);
  checkId(packet.packet_id, problems, "$.packet_id");

  if (!isObject(packet.producer)) add(problems, "producer-invalid", "$.producer", "must be an object");
  else {
    if (!hasText(packet.producer.skill)) add(problems, "producer-skill-missing", "$.producer.skill", "must be non-empty");
    if (!hasText(packet.producer.run_id)) add(problems, "producer-run-missing", "$.producer.run_id", "must be non-empty");
    checkEnum(packet.producer.mode, MODES, problems, "$.producer.mode", "mode-invalid");
    if (!hasText(packet.producer.created_at)) add(problems, "producer-time-missing", "$.producer.created_at", "must be non-empty");
  }

  if (!isObject(packet.scope)) add(problems, "scope-invalid", "$.scope", "must be an object");
  else {
    if (!hasText(packet.scope.claim_or_question)) add(problems, "scope-question-missing", "$.scope.claim_or_question", "must be non-empty");
    if (!hasText(packet.scope.objective)) add(problems, "scope-objective-missing", "$.scope.objective", "must be non-empty");
    checkEnum(packet.scope.required_completeness, COMPLETENESS, problems, "$.scope.required_completeness", "completeness-invalid");
    if (!Array.isArray(packet.scope.included_surfaces)) add(problems, "included-surfaces-invalid", "$.scope.included_surfaces", "must be an array");
    else packet.scope.included_surfaces.forEach((surface, i) => {
      const p = `$.scope.included_surfaces[${i}]`;
      if (!isObject(surface)) add(problems, "surface-invalid", p, "must be an object");
      else { checkId(surface.surface_id, problems, `${p}.surface_id`); if (!hasText(surface.description)) add(problems, "surface-description-missing", `${p}.description`, "must be non-empty"); }
    });
    if (!Array.isArray(packet.scope.excluded_surfaces)) add(problems, "excluded-surfaces-invalid", "$.scope.excluded_surfaces", "must be an array");
    else packet.scope.excluded_surfaces.forEach((surface, i) => {
      const p = `$.scope.excluded_surfaces[${i}]`;
      if (!isObject(surface)) add(problems, "excluded-surface-invalid", p, "must be an object");
      else { checkId(surface.surface_id, problems, `${p}.surface_id`); if (!hasText(surface.reason)) add(problems, "excluded-surface-reason-missing", `${p}.reason`, "must be non-empty"); }
    });
  }

  if (!isObject(packet.coverage_plan)) add(problems, "coverage-plan-invalid", "$.coverage_plan", "must be an object");
  else {
    checkStringArray(packet.coverage_plan.source_classes, problems, "$.coverage_plan.source_classes", { unique: true });
    checkStringArray(packet.coverage_plan.independent_surfaces, problems, "$.coverage_plan.independent_surfaces", { unique: true });
    checkEnum(packet.coverage_plan.contradiction_risk, RISK_LEVELS, problems, "$.coverage_plan.contradiction_risk", "risk-invalid");
    checkEnum(packet.coverage_plan.false_negative_cost, RISK_LEVELS, problems, "$.coverage_plan.false_negative_cost", "risk-invalid");
    if (typeof packet.coverage_plan.cross_source_reconciliation !== "boolean") add(problems, "coverage-plan-boolean", "$.coverage_plan.cross_source_reconciliation", "must be boolean");
    if (typeof packet.coverage_plan.parallelizable !== "boolean") add(problems, "coverage-plan-boolean", "$.coverage_plan.parallelizable", "must be boolean");
    checkEnum(packet.coverage_plan.selected_mode, MODES, problems, "$.coverage_plan.selected_mode", "mode-invalid");
    if (!hasText(packet.coverage_plan.mode_rationale)) add(problems, "mode-rationale-missing", "$.coverage_plan.mode_rationale", "must explain why this execution shape is proportional");
    if (packet.producer && packet.producer.mode !== packet.coverage_plan.selected_mode) add(problems, "mode-mismatch", "$.coverage_plan.selected_mode", "must match producer.mode");
  }

  if (!Array.isArray(packet.claims)) add(problems, "claims-invalid", "$.claims", "must be an array");
  else packet.claims.forEach((claim, index) => validateClaimShape(claim, problems, `$.claims[${index}]`));
  if (!Array.isArray(packet.negative_claims)) add(problems, "negative-claims-invalid", "$.negative_claims", "must be an array");
  else packet.negative_claims.forEach((claim, index) => validateNegativeClaimShape(claim, problems, `$.negative_claims[${index}]`));
  if (!Array.isArray(packet.contradictions)) add(problems, "contradictions-invalid", "$.contradictions", "must be an array");
  else packet.contradictions.forEach((item, index) => validateContradictionShape(item, problems, `$.contradictions[${index}]`));
  if (!Array.isArray(packet.lane_receipts)) add(problems, "lane-receipts-invalid", "$.lane_receipts", "must be an array");
  else packet.lane_receipts.forEach((receipt, index) => validateLaneReceiptShape(receipt, problems, `$.lane_receipts[${index}]`));

  const claimMap = new Map();
  const negativeMap = new Map();
  const contradictionMap = new Map();
  const laneMap = new Map();
  function uniqueInsert(map, id, code, path) {
    if (!hasText(id)) return;
    if (map.has(id)) add(problems, code, path, `duplicate identifier: ${id}`);
    else map.set(id, true);
  }
  (packet.claims || []).forEach((c, i) => uniqueInsert(claimMap, c.claim_id, "claim-id-duplicate", `$.claims[${i}].claim_id`));
  (packet.negative_claims || []).forEach((c, i) => uniqueInsert(negativeMap, c.negative_claim_id, "negative-claim-id-duplicate", `$.negative_claims[${i}].negative_claim_id`));
  (packet.contradictions || []).forEach((c, i) => uniqueInsert(contradictionMap, c.contradiction_id, "contradiction-id-duplicate", `$.contradictions[${i}].contradiction_id`));
  (packet.lane_receipts || []).forEach((c, i) => uniqueInsert(laneMap, c.lane_id, "lane-id-duplicate", `$.lane_receipts[${i}].lane_id`));
  for (const id of claimMap.keys()) if (negativeMap.has(id) || contradictionMap.has(id) || laneMap.has(id)) add(problems, "identifier-collision", "$", `identifier reused across record kinds: ${id}`);
  for (const id of negativeMap.keys()) if (contradictionMap.has(id) || laneMap.has(id)) add(problems, "identifier-collision", "$", `identifier reused across record kinds: ${id}`);
  for (const id of contradictionMap.keys()) if (laneMap.has(id)) add(problems, "identifier-collision", "$", `identifier reused across record kinds: ${id}`);

  const evidenceIds = new Set([...claimMap.keys(), ...negativeMap.keys()]);
  (packet.contradictions || []).forEach((item, i) => {
    (item.claim_refs || []).forEach((id, j) => { if (!evidenceIds.has(id)) add(problems, "contradiction-ref-unknown", `$.contradictions[${i}].claim_refs[${j}]`, `unknown claim reference: ${id}`); });
  });
  (packet.claims || []).forEach((claim, i) => {
    (claim.contradiction_refs || []).forEach((id, j) => {
      const c = (packet.contradictions || []).find(x => x.contradiction_id === id);
      if (!c) add(problems, "claim-contradiction-ref-unknown", `$.claims[${i}].contradiction_refs[${j}]`, `unknown contradiction: ${id}`);
      else if (!c.claim_refs.includes(claim.claim_id)) add(problems, "contradiction-link-not-reciprocal", `$.claims[${i}].contradiction_refs[${j}]`, `${id} does not reference ${claim.claim_id}`);
    });
  });

  if (!isObject(packet.handoff)) add(problems, "handoff-invalid", "$.handoff", "must be an object");
  else {
    checkStringArray(packet.handoff.safe_to_assume, problems, "$.handoff.safe_to_assume", { unique: true });
    checkStringArray(packet.handoff.unresolved_facts, problems, "$.handoff.unresolved_facts", { unique: true });
    (packet.handoff.safe_to_assume || []).forEach((id, i) => {
      const claim = (packet.claims || []).find(x => x.claim_id === id);
      const negative = (packet.negative_claims || []).find(x => x.negative_claim_id === id);
      if (!claim && !negative) add(problems, "handoff-safe-ref-unknown", `$.handoff.safe_to_assume[${i}]`, `unknown evidence id: ${id}`);
      else if (claim && claim.epistemic_status !== "confirmed") add(problems, "handoff-safe-not-confirmed", `$.handoff.safe_to_assume[${i}]`, `${id} is ${claim.epistemic_status}, not confirmed`);
      else if (negative && negative.supports_absence !== true) add(problems, "handoff-safe-negative-unsupported", `$.handoff.safe_to_assume[${i}]`, `${id} does not support absence`);
    });
    (packet.handoff.unresolved_facts || []).forEach((id, i) => {
      const claim = (packet.claims || []).find(x => x.claim_id === id);
      const negative = (packet.negative_claims || []).find(x => x.negative_claim_id === id);
      if (!claim && !negative) add(problems, "handoff-unresolved-ref-unknown", `$.handoff.unresolved_facts[${i}]`, `unknown evidence id: ${id}`);
      else if (claim && claim.epistemic_status === "confirmed") add(problems, "handoff-unresolved-confirmed", `$.handoff.unresolved_facts[${i}]`, `${id} is already confirmed`);
      else if (negative && negative.supports_absence === true) add(problems, "handoff-unresolved-negative-settled", `$.handoff.unresolved_facts[${i}]`, `${id} already supports absence`);
    });
    if (!Array.isArray(packet.handoff.owner_intent_required)) add(problems, "owner-intent-invalid", "$.handoff.owner_intent_required", "must be an array");
    else packet.handoff.owner_intent_required.forEach((item, i) => {
      const p = `$.handoff.owner_intent_required[${i}]`;
      if (!isObject(item)) add(problems, "owner-intent-item-invalid", p, "must be an object");
      else {
        checkId(item.id, problems, `${p}.id`);
        if (!hasText(item.question)) add(problems, "owner-intent-question-missing", `${p}.question`, "must be non-empty");
        if (!hasText(item.rationale)) add(problems, "owner-intent-rationale-missing", `${p}.rationale`, "must be non-empty");
        checkStringArray(item.claim_refs, problems, `${p}.claim_refs`, { unique: true });
        (item.claim_refs || []).forEach((id, j) => { if (!evidenceIds.has(id)) add(problems, "owner-intent-ref-unknown", `${p}.claim_refs[${j}]`, `unknown evidence id: ${id}`); });
      }
    });
    if (!Array.isArray(packet.handoff.possible_decision_surfaces)) add(problems, "decision-surfaces-invalid", "$.handoff.possible_decision_surfaces", "must be an array");
    else packet.handoff.possible_decision_surfaces.forEach((item, i) => {
      const p = `$.handoff.possible_decision_surfaces[${i}]`;
      if (!isObject(item)) add(problems, "decision-surface-item-invalid", p, "must be an object");
      else {
        checkId(item.id, problems, `${p}.id`);
        if (!hasText(item.title)) add(problems, "decision-surface-title-missing", `${p}.title`, "must be non-empty");
        if (!hasText(item.rationale)) add(problems, "decision-surface-rationale-missing", `${p}.rationale`, "must be non-empty");
        checkStringArray(item.claim_refs, problems, `${p}.claim_refs`, { unique: true });
        (item.claim_refs || []).forEach((id, j) => { if (!evidenceIds.has(id)) add(problems, "decision-surface-ref-unknown", `${p}.claim_refs[${j}]`, `unknown evidence id: ${id}`); });
      }
    });
    checkStringArray(packet.handoff.consumer_notes, problems, "$.handoff.consumer_notes");
  }

  const mode = packet.producer && packet.producer.mode;
  if (mode === "inline" && Array.isArray(packet.lane_receipts) && packet.lane_receipts.length !== 0) add(problems, "inline-lanes-forbidden", "$.lane_receipts", "inline mode must not fabricate expedition lane receipts");
  if (mode === "expedition" && (!Array.isArray(packet.lane_receipts) || packet.lane_receipts.length < 2)) add(problems, "expedition-lanes-missing", "$.lane_receipts", "expedition mode requires at least two bounded lane receipts");

  const laneIds = new Set(laneMap.keys());
  if (mode === "expedition") {
    (packet.claims || []).forEach((item, i) => { if (!hasText(item.origin_lane)) add(problems, "expedition-origin-lane-missing", `$.claims[${i}].origin_lane`, "expedition claims must name their origin lane"); else if (!laneIds.has(item.origin_lane)) add(problems, "expedition-origin-lane-unknown", `$.claims[${i}].origin_lane`, `unknown lane: ${item.origin_lane}`); });
    (packet.negative_claims || []).forEach((item, i) => { if (!hasText(item.origin_lane)) add(problems, "expedition-origin-lane-missing", `$.negative_claims[${i}].origin_lane`, "expedition negative claims must name their origin lane"); else if (!laneIds.has(item.origin_lane)) add(problems, "expedition-origin-lane-unknown", `$.negative_claims[${i}].origin_lane`, `unknown lane: ${item.origin_lane}`); });
    (packet.contradictions || []).forEach((item, i) => { if (!hasText(item.origin_lane)) add(problems, "expedition-origin-lane-missing", `$.contradictions[${i}].origin_lane`, "expedition contradictions must name their origin lane"); else if (!laneIds.has(item.origin_lane)) add(problems, "expedition-origin-lane-unknown", `$.contradictions[${i}].origin_lane`, `unknown lane: ${item.origin_lane}`); });
  }

  (packet.lane_receipts || []).forEach((receipt, i) => {
    const refs = [
      ["claim_refs", claimMap],
      ["negative_claim_refs", negativeMap],
      ["contradiction_refs", contradictionMap]
    ];
    for (const [field, map] of refs) (receipt[field] || []).forEach((id, j) => {
      if (!map.has(id)) add(problems, "lane-ref-unknown", `$.lane_receipts[${i}].${field}[${j}]`, `unknown ${field.replace(/_refs$/, "")}: ${id}`);
    });
  });

  return { ok: problems.length === 0, problems, summary: summarizePacket(packet) };
}

function validateExpeditionLane(lane) {
  const problems = [];
  if (!isObject(lane)) return { ok: false, problems: [{ code: "lane-invalid", path: "$", message: "lane return must be an object" }] };
  if (lane.expedition_lane_version !== EXPEDITION_LANE_VERSION) add(problems, "lane-version", "$.expedition_lane_version", `must equal ${EXPEDITION_LANE_VERSION}`);
  checkId(lane.lane_id, problems, "$.lane_id");
  checkId(lane.parent_packet_id, problems, "$.parent_packet_id");
  if (!hasText(lane.surface)) add(problems, "lane-surface-missing", "$.surface", "must be non-empty");
  checkEnum(lane.status, LANE_STATES, problems, "$.status", "lane-status-invalid");
  if (!Array.isArray(lane.claims)) add(problems, "lane-claims-invalid", "$.claims", "must be an array"); else lane.claims.forEach((c, i) => validateClaimShape(c, problems, `$.claims[${i}]`));
  if (!Array.isArray(lane.negative_claims)) add(problems, "lane-negative-claims-invalid", "$.negative_claims", "must be an array"); else lane.negative_claims.forEach((c, i) => validateNegativeClaimShape(c, problems, `$.negative_claims[${i}]`));
  if (!Array.isArray(lane.contradictions)) add(problems, "lane-contradictions-invalid", "$.contradictions", "must be an array"); else lane.contradictions.forEach((c, i) => validateContradictionShape(c, problems, `$.contradictions[${i}]`));
  checkStringArray(lane.limitations, problems, "$.limitations");
  return { ok: problems.length === 0, problems };
}

function riskAtLeast(value, threshold) {
  return RISK_LEVELS.indexOf(value) >= RISK_LEVELS.indexOf(threshold);
}

function recommendMode(profile = {}) {
  const sourceClasses = Array.isArray(profile.source_classes) ? profile.source_classes.length : Number(profile.source_class_count || 0);
  const surfaces = Array.isArray(profile.independent_surfaces) ? profile.independent_surfaces.length : Number(profile.independent_surface_count || 0);
  const contradictionRisk = RISK_LEVELS.includes(profile.contradiction_risk) ? profile.contradiction_risk : "low";
  const falseNegativeCost = RISK_LEVELS.includes(profile.false_negative_cost) ? profile.false_negative_cost : "low";
  const requiredCompleteness = COMPLETENESS.includes(profile.required_completeness) ? profile.required_completeness : "targeted";
  const crossSource = profile.cross_source_reconciliation === true;
  const parallelizable = profile.parallelizable === true;
  const reasons = [];

  if (surfaces >= 3) reasons.push(`${surfaces} independent evidence surfaces`);
  if (crossSource && sourceClasses >= 3) reasons.push(`${sourceClasses} source classes require reconciliation`);
  if (riskAtLeast(contradictionRisk, "high") && sourceClasses >= 2) reasons.push(`${contradictionRisk} contradiction risk across multiple source classes`);
  if (requiredCompleteness === "exhaustive" && riskAtLeast(falseNegativeCost, "high") && surfaces >= 2) reasons.push(`exhaustive completeness with ${falseNegativeCost} false-negative cost`);

  const wide = reasons.length > 0;
  if (parallelizable && wide) return { mode: "expedition", reasons, rationale: `Expedition mode is proportional because ${reasons.join("; ")}. The parent must retain synthesis authority.` };
  if (wide && !parallelizable) reasons.push("work is not safely partitionable, so the parent should run an expanded inline pass");
  if (!wide) reasons.push("the claim can be established through one bounded coherent evidence pass");
  return { mode: "inline", reasons, rationale: `Inline mode is proportional because ${reasons.join("; ")}.` };
}

function mergeExpeditionLanes(basePacket, laneReturns) {
  const packet = clone(basePacket);
  if (!isObject(packet)) throw new Error("base packet must be an object");
  if (!packet.producer || packet.producer.mode !== "expedition") throw new Error("base packet must declare expedition mode");
  if (!Array.isArray(laneReturns) || laneReturns.length < 2) throw new Error("expedition merge requires at least two lane returns");
  packet.claims = Array.isArray(packet.claims) ? packet.claims : [];
  packet.negative_claims = Array.isArray(packet.negative_claims) ? packet.negative_claims : [];
  packet.contradictions = Array.isArray(packet.contradictions) ? packet.contradictions : [];
  packet.lane_receipts = Array.isArray(packet.lane_receipts) ? packet.lane_receipts : [];

  const used = new Set([
    ...packet.claims.map(x => x.claim_id),
    ...packet.negative_claims.map(x => x.negative_claim_id),
    ...packet.contradictions.map(x => x.contradiction_id),
    ...packet.lane_receipts.map(x => x.lane_id)
  ].filter(Boolean));

  for (const raw of laneReturns) {
    const lane = clone(raw);
    const checked = validateExpeditionLane(lane);
    if (!checked.ok) {
      const error = new Error(`invalid expedition lane ${lane && lane.lane_id ? lane.lane_id : "<unknown>"}`);
      error.problems = checked.problems;
      throw error;
    }
    if (lane.parent_packet_id !== packet.packet_id) throw new Error(`lane ${lane.lane_id} targets ${lane.parent_packet_id}, expected ${packet.packet_id}`);
    if (used.has(lane.lane_id)) throw new Error(`identifier collision: ${lane.lane_id}`);
    used.add(lane.lane_id);

    const claims = lane.claims.map(item => ({ ...item, origin_lane: lane.lane_id }));
    const negatives = lane.negative_claims.map(item => ({ ...item, origin_lane: lane.lane_id }));
    const contradictions = lane.contradictions.map(item => ({ ...item, origin_lane: lane.lane_id }));
    for (const [id, kind] of [
      ...claims.map(x => [x.claim_id, "claim"]),
      ...negatives.map(x => [x.negative_claim_id, "negative claim"]),
      ...contradictions.map(x => [x.contradiction_id, "contradiction"])
    ]) {
      if (used.has(id)) throw new Error(`identifier collision for ${kind}: ${id}`);
      used.add(id);
    }
    packet.claims.push(...claims);
    packet.negative_claims.push(...negatives);
    packet.contradictions.push(...contradictions);
    packet.lane_receipts.push({
      lane_id: lane.lane_id,
      surface: lane.surface,
      status: lane.status,
      claim_refs: claims.map(x => x.claim_id),
      negative_claim_refs: negatives.map(x => x.negative_claim_id),
      contradiction_refs: contradictions.map(x => x.contradiction_id),
      limitations: lane.limitations
    });
  }

  const result = validateEvidencePacket(packet);
  if (!result.ok) {
    const error = new Error("merged expedition packet failed validation");
    error.problems = result.problems;
    throw error;
  }
  return packet;
}

function summarizePacket(packet) {
  const claims = Array.isArray(packet && packet.claims) ? packet.claims : [];
  const negatives = Array.isArray(packet && packet.negative_claims) ? packet.negative_claims : [];
  const contradictions = Array.isArray(packet && packet.contradictions) ? packet.contradictions : [];
  const lanes = Array.isArray(packet && packet.lane_receipts) ? packet.lane_receipts : [];
  const countBy = (items, key) => items.reduce((acc, item) => { const value = item && item[key]; acc[value] = (acc[value] || 0) + 1; return acc; }, {});
  return {
    mode: packet && packet.producer ? packet.producer.mode : null,
    claims: claims.length,
    epistemic_statuses: countBy(claims, "epistemic_status"),
    negative_claims: negatives.length,
    absence_supported: negatives.filter(x => x.supports_absence === true).length,
    contradictions: contradictions.length,
    unresolved_contradictions: contradictions.filter(x => x.status !== "resolved").length,
    lanes: lanes.length,
    safe_to_assume: packet && packet.handoff && Array.isArray(packet.handoff.safe_to_assume) ? packet.handoff.safe_to_assume.length : 0,
    unresolved_facts: packet && packet.handoff && Array.isArray(packet.handoff.unresolved_facts) ? packet.handoff.unresolved_facts.length : 0
  };
}

module.exports = {
  EVIDENCE_PACKET_VERSION,
  EXPEDITION_LANE_VERSION,
  COVERAGE_STATES,
  EVIDENCE_QUALITIES,
  EPISTEMIC_STATUSES,
  CONFIDENCE_LEVELS,
  RISK_LEVELS,
  MODES,
  SOURCE_KINDS,
  COMPLETENESS,
  SEARCH_COMPLETENESS,
  validateEvidencePacket,
  validateExpeditionLane,
  recommendMode,
  mergeExpeditionLanes,
  summarizePacket
};
