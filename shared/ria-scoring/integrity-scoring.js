"use strict";
/* RIA's combination logic for the Integrity owner (composite-scoring-v3 §7.3,
 * §7.4, §7.5). Pure functions over the Integrity verifier's per-dimension
 * output and the Phase 3 canonical defect groups. Numbers come only from the
 * loaded scoring config (integrity_scoring, eligibility.integrity) and the
 * imported HEALTH_EVIDENCE_FACTOR. */

function scheduleRow(schedule, severity) {
  return schedule.find(row => row.severity === severity) ?? null;
}

/** §7.3: worst-dominated dimension score from confirmed canonical groups.
 * groups: canonical groups for this dimension that Integrity holds (original or
 * adopted). Contested and unconfirmed groups do not score. Returns
 * { score, state, worst_severity, confirmed_group_count, limitations }. */
function integrityDimensionScore({ groups, absenceSupported, config }) {
  const scoring = config.integrity_scoring;
  const limitations = [];
  const confirmed = (groups ?? []).filter(group => group.confirmed);
  const unscoredSeverity = confirmed.filter(group => !Number.isInteger(group.severity));
  if (unscoredSeverity.length) limitations.push(`${unscoredSeverity.length} confirmed group(s) lack a validated 1-5 severity`);
  const scored = confirmed.filter(group => Number.isInteger(group.severity));
  if (scored.length === 0) {
    if (unscoredSeverity.length) return { score: null, state: "insufficient_evidence", worst_severity: null, confirmed_group_count: confirmed.length, limitations };
    if (absenceSupported) return { score: scoring.no_defect_score, state: "scored", worst_severity: null, confirmed_group_count: 0, limitations };
    return { score: null, state: "insufficient_evidence", worst_severity: null, confirmed_group_count: 0, limitations: [...limitations, "no confirmed defects and no negative claim with supports_absence for this dimension"] };
  }
  const worst = Math.max(...scored.map(group => group.severity));
  const row = scheduleRow(scoring.severity_schedule, worst);
  const further = confirmed.length - 1; // every further confirmed group counts once
  const score = Math.max(row.floor, row.ceiling - row.step * further);
  return { score, state: "scored", worst_severity: worst, confirmed_group_count: confirmed.length, limitations };
}

/** §7.4: eligibility from computed dimension coverage (0-1). */
function integrityEligibility(coverage, config) {
  const thresholds = config.eligibility.integrity;
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) return { state: "insufficient_evidence", provisional: false };
  if (coverage >= thresholds.scored_min_coverage) return { state: "scored", provisional: false };
  if (coverage >= thresholds.provisional_min_coverage) return { state: "scored", provisional: true };
  return { state: "insufficient_evidence", provisional: false };
}

/** §7.5: confidence = coverage × min(Q_surface, Q_defect).
 * Q_defect is the severity-weighted mean quality factor of unique confirmed
 * groups' primary evidence; with none, the validated negative-claim evidence
 * quality. Missing required evidence yields null, never a default 1. */
function integrityConfidence({ coverage, qSurface, groups, negativeClaimQuality, factors }) {
  if (typeof coverage !== "number" || typeof qSurface !== "number") return null;
  const confirmed = (groups ?? []).filter(group => group.confirmed && Number.isInteger(group.severity));
  let qDefect = null;
  if (confirmed.length) {
    let weighted = 0, weights = 0;
    for (const group of confirmed) {
      const factor = factors[group.primary_quality];
      if (typeof factor !== "number") return null;
      weighted += group.severity * factor;
      weights += group.severity;
    }
    qDefect = weighted / weights;
  } else if (negativeClaimQuality && typeof factors[negativeClaimQuality] === "number") {
    qDefect = factors[negativeClaimQuality];
  }
  if (qDefect === null) return null;
  return coverage * Math.min(qSurface, qDefect);
}

module.exports = { integrityConfidence, integrityDimensionScore, integrityEligibility };
