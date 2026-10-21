"use strict";
/* RIA composite v2 engine (composite-scoring-v3 §4, §5, §8, §9, §10).
 *
 * Pure: computeCompositeV2(loaded, input) performs no file I/O, reads no clock
 * and uses no randomness. `loaded` is the result of loadScoringConfig();
 * `input` is a normalized `ria.composite-v2.input@1` document built by the
 * report model (Phase 8), validated here against composite-v2.input.schema.json
 * (passed in as `inputSchema` by the caller that read it). The same normalized
 * evidence, config, implementation and presentation view yield byte-identical
 * canonical output, independent of input ordering. */

const { gradeForScore } = require("./scoring.js");
const { resolveDependenceGraph } = require("./evidence-model.js");
const { validateAgainstSchema } = require("../software-engineering-intelligence/schema-validator.js");

const MISSING_STATES = Object.freeze(["insufficient_evidence", "not_assessed", "failed"]);
const TEST_KIND = "test";

function fail(detail) {
  const error = new Error(`FAIL-RIA-COMPOSITE-V2-INPUT: ${detail}`);
  error.code = "FAIL-RIA-COMPOSITE-V2-INPUT";
  throw error;
}
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }

/** Display helpers (§9.2): a non-negative point floors to one decimal; interval
 * endpoints round outward. A capped 69.9 therefore never displays as 70. */
function displayPoint(value) { return value === null || value === undefined ? null : Math.floor(value * 10 + 1e-9) / 10; }
function displayLower(value) { return value === null || value === undefined ? null : Math.floor(value * 10 + 1e-9) / 10; }
function displayUpper(value) { return value === null || value === undefined ? null : Math.ceil(value * 10 - 1e-9) / 10; }

/* ------------------------- recursive reduction (§8.3) ---------------------- */

/** One reduction level. entries: [{ id, weight, kind: "scored" | "missing" |
 * "not_applicable" | "dependent", point, lower, upper, completeness }].
 * Dependent entries have a verified scored origin; their mass is redistributed
 * proportionally across all remaining applicable entries (missing included).
 * Returns { point, lower, upper, completeness, shares: {id: {original, bound,
 * effective}} } where completeness is the retained scored bound mass. */
function reduceLevel(entries) {
  const applicable = entries.filter(entry => entry.kind !== "not_applicable");
  const applicableWeight = sum(applicable.map(entry => entry.weight));
  const shares = {};
  for (const entry of entries) shares[entry.id] = { original: entry.weight, bound: 0, effective: 0 };
  if (!(applicableWeight > 0)) return { point: null, lower: null, upper: null, completeness: 0, shares, applicable_weight: 0 };
  const remaining = applicable.filter(entry => entry.kind !== "dependent");
  const remainingWeight = sum(remaining.map(entry => entry.weight));
  if (!(remainingWeight > 0)) {
    // Dependent-only: there is no independent mass left to stand on, so the whole
    // level is missing rather than an empty denominator that looks covered.
    return { point: null, lower: 0, upper: 100, completeness: 0, shares, applicable_weight: applicableWeight };
  }
  for (const entry of remaining) shares[entry.id].bound = entry.weight / remainingWeight;
  const scored = remaining.filter(entry => entry.kind === "scored");
  const missing = remaining.filter(entry => entry.kind === "missing");
  const scoredMass = sum(scored.map(entry => shares[entry.id].bound));
  const point = scored.length ? sum(scored.map(entry => shares[entry.id].bound * entry.point)) / scoredMass : null;
  for (const entry of scored) shares[entry.id].effective = shares[entry.id].bound / scoredMass;
  const lower = sum(scored.map(entry => shares[entry.id].bound * entry.lower));
  const upper = sum(scored.map(entry => shares[entry.id].bound * entry.upper)) + 100 * sum(missing.map(entry => shares[entry.id].bound));
  const completeness = sum(scored.map(entry => shares[entry.id].bound * entry.completeness));
  return { point, lower, upper, completeness, shares, applicable_weight: applicableWeight };
}

/** A contribution's own interval from its sub-scores (owner internal weights,
 * renormalized over eligible sub-scores; ineligible ones widen the interval). */
function contributionInterval(contribution) {
  if (!Array.isArray(contribution.sub_scores) || contribution.sub_scores.length === 0) {
    return { point: contribution.score, lower: contribution.score, upper: contribution.score, completeness: 1, sub_missing: false, sub_provisional: false };
  }
  const entries = [...contribution.sub_scores].sort((a, b) => compare(a.id, b.id)).map(sub => ({
    id: sub.id,
    weight: sub.weight,
    kind: sub.state === "not_applicable" ? "not_applicable" : sub.state === "scored" ? "scored" : "missing",
    point: sub.score, lower: sub.score, upper: sub.score, completeness: 1,
  }));
  const reduced = reduceLevel(entries);
  return {
    point: reduced.point,
    lower: reduced.lower,
    upper: reduced.upper,
    completeness: reduced.completeness,
    sub_missing: entries.some(entry => entry.kind === "missing"),
    sub_provisional: contribution.sub_scores.some(sub => sub.state === "scored" && sub.maturity === "provisional"),
    sub_confidence: (() => {
      const scored = contribution.sub_scores.filter(sub => sub.state === "scored" && typeof sub.confidence === "number");
      const weight = sum(scored.map(sub => sub.weight));
      return weight > 0 ? sum(scored.map(sub => sub.weight * sub.confidence)) / weight : null;
    })(),
  };
}

/* ------------------------------ verification (§9.2) ------------------------ */

function verificationEffects(verification, ceilings, rules) {
  const commands = [...(verification?.commands ?? [])].sort((a, b) => compare(a.command_id, b.command_id));
  const caps = [];
  const effects = { test_unexecuted: false, check_unexecuted: false, no_commands: commands.length === 0, reasons: [] };
  for (const command of commands) {
    const isTest = command.kind === TEST_KIND;
    if (command.outcome === "fail") {
      const capId = isTest ? "verification-tests-failing" : "verification-checks-failing";
      caps.push({ cap_id: capId, trigger: command.command_id, ceiling: ceilings[rules[capId]] });
    } else if (command.outcome === "error" || command.outcome === "timed-out") {
      if (isTest) effects.test_unexecuted = true; else effects.check_unexecuted = true;
      effects.reasons.push(`verification command ${command.command_id} ${command.outcome}; ${isTest ? "verification cannot be final" : "a required unexecuted check prevents final status"}`);
    } else if (command.outcome === "skipped" && isTest) {
      effects.test_unexecuted = true;
      effects.reasons.push(`verification test command ${command.command_id} skipped; verification cannot be final`);
    }
  }
  if (effects.no_commands) effects.reasons.push("no verification commands: verification contributions are insufficient_evidence (unverified)");
  return { caps, effects };
}

/* ---------------------------------- engine --------------------------------- */

function validateInput(input, inputSchema) {
  if (!inputSchema) fail("the normalized-input schema must be supplied");
  const errors = validateAgainstSchema(input, inputSchema);
  if (errors.length) fail(errors.join("; "));
}

/** Computes ria.composite@2. */
function computeCompositeV2(loaded, input, { inputSchema } = {}) {
  validateInput(input, inputSchema);
  const config = loaded.config;
  const owners = config.owners;
  const ceilings = config.caps.ceilings;
  const rules = config.caps.rules;
  const statusReasons = [];
  const verification = verificationEffects(input.verification, ceilings, rules);
  statusReasons.push(...verification.effects.reasons);

  // Run state (§9.1).
  const failedTasks = [...(input.run.failed_tasks ?? [])].sort(compare);
  let degraded = failedTasks.length > 0;
  for (const task of failedTasks) statusReasons.push(`assessment task ${task} failed: run is degraded`);

  const dimensions = [];
  for (const [dimensionId, spec] of Object.entries(config.dimensions)) {
    const supplied = input.dimensions[dimensionId] ?? { contributions: {} };
    const contributionInputs = {};
    for (const owner of owners) {
      if (!spec.shares[owner]) {
        if (supplied.contributions?.[owner]) fail(`dimensions.${dimensionId}.contributions.${owner} is not a mapped owner`);
        continue;
      }
      contributionInputs[owner] = supplied.contributions?.[owner] ?? { eligibility: "not_assessed", limitations: ["owner supplied no contribution"] };
    }
    // §9.2 effects on baseline-dependent contributions.
    for (const [owner, contribution] of Object.entries(contributionInputs)) {
      if (!contribution.baseline_dependent || contribution.eligibility !== "scored") continue;
      const affected = (dimensionId === "verification" && (verification.effects.test_unexecuted || verification.effects.no_commands)) || (dimensionId === "delivery" && verification.effects.check_unexecuted);
      if (affected) contributionInputs[owner] = { ...contribution, eligibility: "insufficient_evidence", limitations: [...(contribution.limitations ?? []), "baseline-dependent contribution: required verification evidence did not execute"] };
    }
    for (const contribution of Object.values(contributionInputs)) if (contribution.eligibility === "failed") degraded = true;

    // Dependence (§6.3) resolved as a graph over eligible contributions.
    const graph = resolveDependenceGraph(Object.entries(contributionInputs).map(([owner, contribution]) => ({
      owner,
      eligible: contribution.eligibility === "scored",
      classification: contribution.eligibility !== "scored" ? "insufficient_evidence" : (contribution.dependence?.classification ?? "independent"),
      origin_owners: contribution.dependence?.origin_owners ?? [],
    })));
    const contributions = [];
    for (const owner of owners) {
      if (!(owner in contributionInputs)) continue;
      const source = contributionInputs[owner];
      const limitations = [...(source.limitations ?? [])];
      let state = source.eligibility;
      let originRefs = [];
      if (state === "scored") {
        const resolved = graph[owner];
        if (resolved.state === "dependent") { state = "dependent"; originRefs = resolved.origin_refs; }
        else if (resolved.state === "insufficient_evidence") { state = "insufficient_evidence"; limitations.push(...resolved.limitations); if (source.dependence?.classification === "insufficient_evidence") limitations.push("evidence has no strong original source and no scored origin"); }
      }
      let interval = { point: null, lower: null, upper: null, completeness: 0, sub_missing: false, sub_provisional: false, sub_confidence: null };
      if (state === "scored" || state === "dependent") {
        interval = contributionInterval(source);
        if (interval.point === null) { state = "insufficient_evidence"; limitations.push("no eligible sub-score"); }
      }
      const confidence = state === "scored" || state === "dependent" ? (typeof source.confidence === "number" ? source.confidence : interval.sub_confidence ?? null) : null;
      const provisional = (state === "scored" || state === "dependent") && (source.provisional === true || source.maturity !== "established" || interval.sub_missing || interval.sub_provisional);
      contributions.push({
        owner, state, source, limitations: [...new Set(limitations)].sort(compare), origin_refs: originRefs,
        score: state === "scored" || state === "dependent" ? interval.point : null,
        lower: state === "scored" ? interval.lower : null,
        upper: state === "scored" ? interval.upper : null,
        completeness: state === "scored" || state === "dependent" ? interval.completeness : null,
        confidence, provisional,
        maturity: state === "scored" || state === "dependent" ? source.maturity : "unavailable",
      });
    }
    const applicableContributions = contributions.filter(c => c.state !== "not_applicable");
    const notApplicable = contributions.length > 0 && applicableContributions.length === 0;
    const limitations = [];
    if (!notApplicable && applicableContributions.length < contributions.length) limitations.push("conflicting applicability declarations: dimension stays applicable");

    const level = reduceLevel(contributions.map(c => ({
      id: c.owner,
      weight: spec.shares[c.owner],
      kind: c.state === "not_applicable" ? "not_applicable" : c.state === "dependent" ? "dependent" : c.state === "scored" ? "scored" : "missing",
      point: c.score, lower: c.lower, upper: c.upper, completeness: c.completeness,
    })));
    const scored = contributions.filter(c => c.state === "scored");
    const missing = contributions.filter(c => MISSING_STATES.includes(c.state));
    let verdict;
    if (notApplicable) verdict = "not_applicable";
    else if (scored.length === 0) verdict = "not_scored";
    else {
      const nonDependentApplicable = applicableContributions.filter(c => c.state !== "dependent").length;
      const anyProvisional = scored.some(c => c.provisional || c.completeness < 1 || c.source.unresolved_contradictions === true);
      verdict = missing.length > 0 || anyProvisional || (scored.length === 1 && nonDependentApplicable > 1) ? "provisional" : "scored";
    }
    if (dimensionId === "verification" && verdict === "scored" && (verification.effects.test_unexecuted || verification.effects.no_commands)) verdict = "provisional";

    // Confidence (§8.4).
    let confidence = null, contested = false, spread = null;
    if (!notApplicable && scored.length) {
      let base = sum(scored.map(c => level.shares[c.owner].effective * (c.confidence ?? 0)));
      const judged = contributions.filter(c => (c.state === "scored" || c.state === "dependent") && typeof c.score === "number").map(c => c.score);
      spread = judged.length ? Math.max(...judged) - Math.min(...judged) : null;
      if (spread !== null && spread > config.contested.spread_threshold) {
        contested = true;
        base *= Math.max(config.contested.minimum_multiplier, 1 - (spread - config.contested.spread_threshold) / config.contested.decay_divisor);
      }
      confidence = base * level.completeness;
    }
    dimensions.push({
      id: dimensionId, weight: spec.weight, critical: spec.critical, verdict,
      point: notApplicable ? null : level.point,
      lower: notApplicable ? null : (level.point === null && level.lower === null ? 0 : level.lower),
      upper: notApplicable ? null : (level.point === null && level.upper === null ? 100 : level.upper),
      confidence, contested, spread, limitations,
      contributions: contributions.map(c => ({
        owner: c.owner, state: c.state, score: c.score,
        original_share: spec.shares[c.owner], bound_share: level.shares[c.owner].bound, effective_share: level.shares[c.owner].effective,
        lower: c.lower, upper: c.upper, completeness: c.completeness, maturity: c.maturity,
        origin_refs: c.origin_refs, limitations: c.limitations,
        confidence: c.confidence, coverage: typeof c.source.coverage === "number" ? c.source.coverage : null, provisional: c.provisional,
        adopted_strength_ratio: c.source.dependence?.adopted_strength_ratio ?? null,
        evidence_keys: [...(c.source.dependence?.evidence_keys ?? [])].sort((a, b) => compare(a.key, b.key)),
        strong_original: c.source.strong_original === true,
      })),
    });
  }

  // Composite (§8.2, §8.3, top level).
  const applicable = dimensions.filter(d => d.verdict !== "not_applicable");
  const applicableWeight = sum(applicable.map(d => d.weight));
  const withPoint = applicable.filter(d => d.point !== null);
  const scoredWeight = sum(applicable.filter(d => d.verdict === "scored" || d.verdict === "provisional").map(d => d.weight));
  let status;
  if (!(applicableWeight > 0)) { status = "not_gradable"; statusReasons.push("NO_APPLICABLE_DIMENSIONS"); }
  else {
    const criticalUnscored = applicable.filter(d => d.critical && d.verdict === "not_scored").map(d => d.id);
    for (const id of criticalUnscored) statusReasons.push(`critical dimension ${id} is not scored`);
    const lowWeight = scoredWeight < config.status.not_gradable_min_scored_weight_ratio * applicableWeight;
    if (lowWeight) statusReasons.push(`scored weight ${scoredWeight} is below ${config.status.not_gradable_min_scored_weight_ratio * 100}% of applicable weight ${applicableWeight}`);
    if (criticalUnscored.length || lowWeight) status = "not_gradable";
    else {
      const open = applicable.filter(d => d.verdict === "not_scored" || d.verdict === "provisional").map(d => d.id);
      for (const id of open) statusReasons.push(`dimension ${id} is ${applicable.find(d => d.id === id).verdict}`);
      if (verification.effects.check_unexecuted) statusReasons.push("a required verification check did not execute");
      if (degraded) statusReasons.push("run is degraded");
      status = open.length || degraded || verification.effects.check_unexecuted ? "provisional" : "final";
    }
  }
  if (degraded && input.run.allow_degraded) statusReasons.push("allow_degraded: the run finished and rendered; the verdict is unchanged");

  let rawPoint = null, rawLower = null, rawUpper = null;
  if (applicableWeight > 0) {
    const pointWeight = sum(withPoint.map(d => d.weight));
    rawPoint = pointWeight > 0 ? sum(withPoint.map(d => d.weight * d.point)) / pointWeight : null;
    rawLower = sum(applicable.map(d => (d.weight / applicableWeight) * d.lower));
    rawUpper = sum(applicable.map(d => (d.weight / applicableWeight) * d.upper));
  }

  // Caps (§9.2, §9.3): admissible triggers are evaluated before score eligibility.
  const caps = [...verification.caps];
  const applicableCritical = new Set(applicable.filter(d => d.critical).map(d => d.id));
  const groups = [...(input.canonical_defects?.groups ?? [])].sort((a, b) => compare(a.group_id, b.group_id));
  for (const group of groups) {
    if (group.confirmed !== true || group.cap_eligible === false || group.contained === true) continue;
    if (!Number.isInteger(group.severity) || group.severity < config.caps.confirmed_critical_min_severity) continue;
    if (!applicableCritical.has(group.dimension)) continue;
    caps.push({ cap_id: "confirmed-critical-failure", trigger: group.group_id, ceiling: ceilings[rules["confirmed-critical-failure"]] });
  }
  const healthFailure = input.canonical_defects?.health_uncontained_critical_failure ?? null;
  if (healthFailure && healthFailure.admissible === true && applicableCritical.has(healthFailure.dimension)) {
    caps.push({ cap_id: "confirmed-critical-failure", trigger: `health:${healthFailure.claim_id}`, ceiling: ceilings[rules["confirmed-critical-failure"]] });
  }
  for (const d of applicable) {
    if (!d.critical || d.verdict !== "scored" || d.point === null || !(d.point < config.critical_floor.point_below)) continue;
    const independent = d.contributions.filter(c => c.state === "scored" && c.maturity === "established" && c.strong_original && c.completeness === 1 && !c.provisional);
    if (independent.length >= config.critical_floor.min_independent_established_sources) {
      caps.push({ cap_id: "critical-dimension-floor", trigger: d.id, ceiling: ceilings[rules["critical-dimension-floor"]] });
    }
  }
  const uniqueCaps = [...new Map(caps.map(cap => [`${cap.cap_id}|${cap.trigger}`, cap])).values()].sort((a, b) => compare(a.cap_id, b.cap_id) || compare(a.trigger, b.trigger));
  const minCeiling = uniqueCaps.length ? Math.min(...uniqueCaps.map(cap => cap.ceiling)) : null;
  const reference = rawPoint ?? rawUpper;
  const capOut = uniqueCaps.map(cap => ({ cap_id: cap.cap_id, trigger: cap.trigger, ceiling: cap.ceiling, binding: reference !== null && cap.ceiling === minCeiling && cap.ceiling < reference }));
  const capValue = value => value === null ? null : minCeiling === null ? value : Math.min(value, minCeiling);
  const gradable = status !== "not_gradable";
  const finalPoint = gradable ? capValue(rawPoint) : null;
  const point = { raw_score: gradable ? rawPoint : null, final_score: finalPoint, final_grade: gradable ? gradeForScore(finalPoint) : null };
  const bounds = { raw: { lower: rawLower, upper: rawUpper }, final: { lower: capValue(rawLower), upper: capValue(rawUpper) } };
  if (point.final_score !== null && !(bounds.final.lower - 1e-9 <= point.final_score && point.final_score <= bounds.final.upper + 1e-9)) {
    throw new Error("FAIL-RIA-COMPOSITE-V2-INVARIANT: lower <= point <= upper does not hold");
  }

  // Composite confidence (§8.4.5–6): unscored applicable dimensions contribute 0.
  let confidenceValue = null;
  if (applicableWeight > 0) confidenceValue = sum(applicable.filter(d => d.confidence !== null).map(d => d.weight * d.confidence)) / applicableWeight;
  const band = confidenceValue === null ? null : confidenceValue >= config.confidence_bands.high ? "high" : confidenceValue >= config.confidence_bands.moderate ? "moderate" : "low";

  // Weakest critical dimension.
  const critical = applicable.filter(d => d.critical).sort((a, b) => (a.point === null ? -Infinity : a.point) - (b.point === null ? -Infinity : b.point) || compare(a.id, b.id));
  const weakest = critical[0] ? { id: critical[0].id, point: critical[0].point, verdict: critical[0].verdict } : { id: null, point: null, verdict: null };

  // Influence (§4.2, §10).
  const nominal = Object.fromEntries(Object.entries(loaded.nominal_influence).sort(([a], [b]) => compare(a, b)));
  const effective = Object.fromEntries(owners.map(owner => [owner, 0]));
  const missingMass = Object.fromEntries(owners.map(owner => [owner, 0]));
  const pointWeight = sum(withPoint.map(d => d.weight));
  for (const d of applicable) {
    for (const c of d.contributions) {
      if (pointWeight > 0 && d.point !== null) effective[c.owner] += (d.weight / pointWeight) * c.effective_share * 100;
      if (MISSING_STATES.includes(c.state)) missingMass[c.owner] += (d.weight / applicableWeight) * c.bound_share * 100;
    }
  }

  const presentation = input.presentation;
  const calibrated = presentation.calibration_verified === true;
  return canonical({
    schema_version: "ria.composite@2",
    reported: calibrated && presentation.reported_composite === "v2",
    calibration_state: calibrated ? "calibrated" : "uncalibrated",
    config: { config_version: loaded.config_version, config_sha256: loaded.config_sha256, implementation_sha256: loaded.implementation_sha256 },
    presentation: { policy_sha256: presentation.policy_sha256, calibration_ref: presentation.calibration_ref ?? null },
    source_bindings: [...(input.source_bindings ?? [])].sort((a, b) => compare(canonicalJson(a), canonicalJson(b))),
    status,
    status_reasons: [...new Set(statusReasons)],
    run_state: degraded ? "degraded" : "complete",
    point,
    bounds,
    caps: capOut,
    confidence: { value: confidenceValue, band },
    applicable_weight: applicableWeight,
    scored_weight: scoredWeight,
    weakest_critical_dimension: weakest,
    dimensions: dimensions.map(d => ({ ...d })),
    canonical_defects: groups.map(group => ({ group_id: group.group_id, members: [...group.members].sort(compare), dimension: group.dimension, severity: group.severity ?? null, evidentiary_state: group.evidentiary_state, owners: [...group.owners].sort(compare) })),
    unresolved_defect_candidates: [...(input.canonical_defects?.unresolved ?? [])].sort((a, b) => compare(canonicalJson(a), canonicalJson(b))),
    influence: { nominal, effective, missing_bound_mass: missingMass },
  });
}

module.exports = { computeCompositeV2, displayLower, displayPoint, displayUpper, reduceLevel };
