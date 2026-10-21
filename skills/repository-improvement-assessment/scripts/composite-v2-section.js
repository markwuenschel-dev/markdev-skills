"use strict";
// "v2 composite — uncalibrated shadow" report section and headline selection
// (composite-scoring-v3 §10, D6; instructions Phase 8 step 4). Rendering only: every number
// shown here was computed by shared/ria-scoring/composite-v2.js. Display rounding follows §9.2:
// a point floors to one decimal and interval endpoints round outward, so a capped 69.9 is
// never shown as 70.

const path = require("node:path");
const { displayLower, displayPoint, displayUpper } = require(path.resolve(__dirname, "..", "..", "shared", "ria-scoring", "composite-v2.js"));
const { gradeForScore } = require("./scoring.js");

const OWNER_LABEL = Object.freeze({ health: "Health", architecture: "Architecture", integrity: "Integrity", sei: "SEI" });
const STATE_LABEL = Object.freeze({ scored: "scored", dependent: "dependent", not_applicable: "not applicable", insufficient_evidence: "insufficient evidence", not_assessed: "not assessed", failed: "failed" });

function fmt(value, digits = 1) { return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—"; }
function pct(value) { return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "—"; }

/** The composite whose number is the report headline. v1 unless the presentation policy
 * selects v2 and its calibration receipt verified (composite_v2.reported === true). The v2
 * headline uses the same fields the v1 headline renders, so no reducer changes on promotion. */
function selectHeadline(analytics) {
  const v1 = analytics.composite;
  const v2 = analytics.composite_v2;
  if (!v2 || v2.headline !== "v2" || v2.reported !== true) return { source: "v1", composite: v1 };
  const notGradable = v2.status === "not_gradable";
  const finalScore = notGradable ? null : displayPoint(v2.point.final_score);
  const rawScore = notGradable ? null : displayPoint(v2.point.raw_score);
  const binding = (v2.caps ?? []).find(cap => cap.binding);
  return {
    source: "v2",
    composite: {
      final_score: finalScore, final_grade: notGradable ? "Not gradable" : v2.point.final_grade, raw_score: rawScore, raw_grade: notGradable ? null : gradeForScore(v2.point.raw_score),
      not_gradable: notGradable, reason: notGradable ? v2.status_reasons.join("; ") : null,
      binding_cap: binding ? { ceiling: binding.ceiling, cap: binding.cap_id } : null,
      assessment_coverage: v2.applicable_weight > 0 ? (v2.scored_weight / v2.applicable_weight) * 100 : 0,
      optional_critical_lanes: [], dimensions: v1?.dimensions ?? [],
    },
  };
}

function renderCompositeV2Section(v2, { escape, presentation, unavailable = null }) {
  if (!v2) return `<p class="cell-detail">The v2 composite was not computed for this report.${unavailable ? ` ${escape(unavailable)}.` : ""}</p>`;
  const reported = v2.reported === true;
  const banner = reported
    ? `<div class="v2-banner reported"><strong>Reported composite.</strong> The presentation policy selects v2 and its calibration receipt verified.</div>`
    : `<div class="v2-banner shadow"><strong>Uncalibrated shadow — not the reported grade.</strong> v1 above remains the reported RIA composite. v2 is computed on every run and shown here until it passes the calibration gate and promotion is approved.</div>`;
  const gradable = v2.status !== "not_gradable";
  const pointText = gradable ? `${fmt(displayPoint(v2.point.final_score))} · ${escape(String(v2.point.final_grade))}` : "Not gradable";
  const summary = `<dl class="kv">`
    + `<dt>status</dt><dd data-v2-status="${escape(v2.status)}">${escape(v2.status)}</dd>`
    + `<dt>point</dt><dd data-v2-point>${pointText}${gradable && v2.point.raw_score !== v2.point.final_score ? ` (raw ${fmt(displayPoint(v2.point.raw_score))})` : ""}</dd>`
    + `<dt>bounds</dt><dd data-v2-bounds>${fmt(displayLower(v2.bounds.final.lower))} – ${fmt(displayUpper(v2.bounds.final.upper))}${v2.bounds.final.upper !== v2.bounds.raw.upper ? ` (raw ${fmt(displayLower(v2.bounds.raw.lower))} – ${fmt(displayUpper(v2.bounds.raw.upper))})` : ""}</dd>`
    + `<dt>confidence</dt><dd>${escape(String(v2.confidence.band ?? "—"))} band · ${fmt(v2.confidence.value, 2)}</dd>`
    + `<dt>run state</dt><dd>${escape(v2.run_state)}</dd>`
    + `<dt>calibration</dt><dd>${escape(v2.calibration_state)}</dd>`
    + `<dt>weakest critical dimension</dt><dd data-v2-weakest>${v2.weakest_critical_dimension.id ? `${escape(v2.weakest_critical_dimension.id)} · ${fmt(v2.weakest_critical_dimension.point)} (${escape(String(v2.weakest_critical_dimension.verdict))})` : "—"}</dd>`
    + `<dt>scored / applicable weight</dt><dd>${fmt(v2.scored_weight, 0)} / ${fmt(v2.applicable_weight, 0)}</dd>`
    + `<dt>config</dt><dd><code>${escape(String(v2.config.config_version))} · ${escape(String(v2.config.config_sha256).slice(0, 12))}</code></dd>`
    + `</dl>`;
  const reasons = (v2.status_reasons ?? []).length ? `<ul class="v2-reasons">${v2.status_reasons.map(reason => `<li>${escape(reason)}</li>`).join("")}</ul>` : "";
  const caps = (v2.caps ?? []).length
    ? `<table class="v2-table"><thead><tr><th>Cap</th><th>Trigger</th><th>Ceiling</th><th>Binding</th></tr></thead><tbody>${v2.caps.map(cap => `<tr><td>${escape(cap.cap_id)}</td><td><code>${escape(cap.trigger)}</code></td><td>${fmt(cap.ceiling)}</td><td>${cap.binding ? "binding" : "non-binding"}</td></tr>`).join("")}</tbody></table>`
    : `<p class="cell-detail">No cap fired.</p>`;
  const rows = v2.dimensions.map(dimension => {
    const head = `<tr class="v2-dim" data-v2-dimension="${escape(dimension.id)}"><th scope="row">${escape(dimension.id)}${dimension.critical ? " · critical" : ""}</th><td>${fmt(dimension.weight, 0)}</td><td>${escape(dimension.verdict)}</td><td>${fmt(dimension.point)}</td><td>${dimension.lower === null ? "—" : `${fmt(displayLower(dimension.lower))} – ${fmt(displayUpper(dimension.upper))}`}</td><td>${fmt(dimension.confidence, 2)}${dimension.contested ? ` · contested (spread ${fmt(dimension.spread)})` : ""}</td></tr>`;
    const contributions = dimension.contributions.map(c => `<tr class="v2-contribution" data-v2-owner="${escape(c.owner)}" data-v2-state="${escape(c.state)}"><td>↳ ${escape(OWNER_LABEL[c.owner] ?? c.owner)}</td><td>${pct(c.original_share)} → ${pct(c.effective_share)}</td><td>${escape(STATE_LABEL[c.state] ?? c.state)}</td><td>${fmt(c.score)}</td><td>${c.adopted_strength_ratio === null ? "—" : `adopted ${pct(c.adopted_strength_ratio)}`}${c.origin_refs.length ? ` · from ${escape(c.origin_refs.join(", "))}` : ""}${c.strong_original ? " · strong original" : ""}</td><td>coverage ${pct(c.coverage)}${c.limitations.length ? `<div class="cell-detail">${c.limitations.map(item => escape(item)).join("<br />")}</div>` : ""}</td></tr>`).join("");
    return head + contributions;
  }).join("");
  const table = `<table class="v2-table"><thead><tr><th>Dimension / owner</th><th>Weight / share (original → effective)</th><th>Verdict / state</th><th>Point</th><th>Bounds / dependence</th><th>Confidence / coverage</th></tr></thead><tbody>${rows}</tbody></table>`;
  const contested = v2.dimensions.filter(dimension => dimension.contested);
  const contestedBlock = contested.length
    ? `<ul class="v2-contested">${contested.map(dimension => `<li><strong>${escape(dimension.id)}</strong>: ${dimension.contributions.filter(c => typeof c.score === "number").map(c => `${escape(OWNER_LABEL[c.owner] ?? c.owner)} ${fmt(c.score)}`).join(" · ")} (spread ${fmt(dimension.spread)}; disagreement lowers confidence only)</li>`).join("")}</ul>`
    : `<p class="cell-detail">No contested dimension.</p>`;
  const defects = (v2.canonical_defects ?? []).length
    ? `<table class="v2-table"><thead><tr><th>Group</th><th>Dimension</th><th>Severity</th><th>Evidentiary state</th><th>Owners</th><th>Members</th></tr></thead><tbody>${v2.canonical_defects.map(group => `<tr><td><code>${escape(group.group_id)}</code></td><td>${escape(group.dimension)}</td><td>${group.severity ?? "—"}</td><td>${escape(group.evidentiary_state)}</td><td>${escape(group.owners.join(", "))}</td><td>${escape(group.members.join(", "))}</td></tr>`).join("")}</tbody></table>`
    : `<p class="cell-detail">No canonical defect groups.</p>`;
  const owners = Object.keys(OWNER_LABEL);
  const influence = presentation.horizontalBarChart({
    id: "v2-effective-influence", title: "Effective owner influence (v2 shadow)",
    description: "Share of the v2 point each owner actually carried in this run, beside its nominal design share.",
    items: owners.map(owner => ({ label: `${OWNER_LABEL[owner]} (nominal ${fmt(v2.influence.nominal[owner])})`, value: v2.influence.effective[owner] })),
    max: 100, unit: "%", note: `Missing bound mass: ${owners.map(owner => `${OWNER_LABEL[owner]} ${fmt(v2.influence.missing_bound_mass[owner])}`).join(" · ")}`,
  });
  return `<article class="card v2-shadow" data-v2-reported="${reported}">${banner}${summary}${reasons}</article>`
    + `<article class="card"><h3>Caps</h3>${caps}</article>`
    + `<article class="rp-chart-card">${influence}</article>`
    + `<article class="card"><h3>Dimensions and contributions</h3>${table}</article>`
    + `<article class="card"><h3>Contested dimensions</h3>${contestedBlock}</article>`
    + `<article class="card"><h3>Canonical defects</h3>${defects}</article>`;
}

module.exports = { renderCompositeV2Section, selectHeadline };
