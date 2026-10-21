"use strict";

const GRADE_BANDS = Object.freeze([
  [97, "A+"], [93, "A"], [90, "A-"],
  [87, "B+"], [83, "B"], [80, "B-"],
  [77, "C+"], [73, "C"], [70, "C-"],
  [67, "D+"], [63, "D"], [60, "D-"],
  [0, "F"],
]);

const RIA_WEIGHTS = Object.freeze({
  "correctness-and-integrity": 25,
  "architecture-fitness": 20,
  "contracts-and-integration": 15,
  "verification-readiness": 20,
  "build-and-delivery": 10,
  "maintainability-and-ownership": 10,
});

const PRIORITY_STOPS = Object.freeze([
  [0, [59, 130, 246]],
  [25, [6, 182, 212]],
  [50, [34, 197, 94]],
  [75, [245, 158, 11]],
  [100, [239, 68, 68]],
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}
function gradeForScore(score) {
  const value = finite(score);
  if (value === null) return null;
  const bounded = clamp(value);
  for (const [minimum, grade] of GRADE_BANDS) if (bounded >= minimum) return grade;
  return "F";
}
function gradeCeilingScore(grade) {
  const ceilings = { "A+":100, A:96.999, "A-":92.999, "B+":89.999, B:86.999, "B-":82.999, "C+":79.999, C:76.999, "C-":72.999, "D+":69.999, D:66.999, "D-":62.999, F:59.999 };
  return Object.prototype.hasOwnProperty.call(ceilings, grade) ? ceilings[grade] : null;
}
function applyGradeCaps(rawScore, caps = []) {
  const value = finite(rawScore);
  if (value === null) return { raw_score:null, raw_grade:null, final_score:null, final_grade:null, binding_cap:null };
  let finalScore = clamp(value);
  let bindingCap = null;
  for (const cap of Array.isArray(caps) ? caps : []) {
    const ceiling = gradeCeilingScore(cap?.ceiling);
    if (ceiling !== null && ceiling < finalScore) {
      finalScore = ceiling;
      bindingCap = cap;
    }
  }
  return {
    raw_score: Math.round(clamp(value) * 10) / 10,
    raw_grade: gradeForScore(value),
    final_score: Math.round(finalScore * 10) / 10,
    final_grade: gradeForScore(finalScore),
    binding_cap: bindingCap,
  };
}
function weightedComposite(dimensions, weights = RIA_WEIGHTS, caps = []) {
  let numerator = 0;
  let denominator = 0;
  const rows = [];
  for (const [id, weight] of Object.entries(weights)) {
    const source = dimensions?.[id] ?? null;
    const score = finite(source?.score ?? source);
    const bounded = score === null ? null : clamp(score);
    if (bounded !== null) {
      numerator += bounded * weight;
      denominator += weight;
    }
    rows.push({
      id,
      weight,
      score: bounded,
      grade: gradeForScore(bounded),
      source: source?.source ?? null,
      coverage: finite(source?.coverage),
      confidence: finite(source?.confidence),
    });
  }
  const score = denominator ? numerator / denominator : null;
  return {
    ...applyGradeCaps(score, caps),
    assessed_weight: denominator,
    assessment_coverage: denominator / Object.values(weights).reduce((a,b) => a+b,0) * 100,
    dimensions: rows,
  };
}
function priorityLabel(score) {
  const value = finite(score);
  if (value === null) return "UNSCORED";
  if (value >= 85) return "CRITICAL";
  if (value >= 70) return "HIGH";
  if (value >= 45) return "MODERATE";
  if (value >= 20) return "LOW";
  return "MINIMAL";
}
const LEDGER_RANGE = Object.freeze({ min: -10, max: 22 });
function ledgerFillPercent(priority) {
  const value = finite(priority);
  if (value === null) return null;
  const span = LEDGER_RANGE.max - LEDGER_RANGE.min;
  return Math.max(0, Math.min(100, ((clamp(value, LEDGER_RANGE.min, LEDGER_RANGE.max) - LEDGER_RANGE.min) / span) * 100));
}
function ledgerPriorityBand(priority) {
  const value = finite(priority);
  if (value === null) return "Unscored";
  if (value >= 13) return "Strong";
  if (value >= 6) return "Worth exploring";
  return "Speculative";
}
function ledgerPriorityColor(priority) {
  const percent = ledgerFillPercent(priority);
  return percent === null ? "#5f6875" : priorityColor(percent);
}
function hexByte(value) { return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0"); }
function priorityColor(score) {
  const raw = finite(score);
  if (raw === null) return "#5f6875";
  const value = clamp(raw);
  let left = PRIORITY_STOPS[0], right = PRIORITY_STOPS.at(-1);
  for (let i = 1; i < PRIORITY_STOPS.length; i += 1) {
    if (value <= PRIORITY_STOPS[i][0]) { left = PRIORITY_STOPS[i-1]; right = PRIORITY_STOPS[i]; break; }
  }
  const span = Math.max(1, right[0] - left[0]);
  const t = (value - left[0]) / span;
  const rgb = left[1].map((channel, index) => channel + (right[1][index] - channel) * t);
  return `#${rgb.map(hexByte).join("")}`;
}
function normalizeCoverageMetric(metric) {
  if (!metric || typeof metric !== "object") return null;
  const covered = finite(metric.covered);
  const total = finite(metric.total);
  if (covered === null || total === null || covered < 0 || total < 0 || covered > total) return null;
  return { covered, total, percent: total === 0 ? null : Math.round((covered / total) * 10000) / 100 };
}
function normalizeCoverageMetrics(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    line: normalizeCoverageMetric(source.line),
    branch: normalizeCoverageMetric(source.branch),
    changed_line: normalizeCoverageMetric(source.changed_line ?? source.changedLine),
  };
}

module.exports = {
  GRADE_BANDS,
  LEDGER_RANGE,
  RIA_WEIGHTS,
  applyGradeCaps,
  gradeForScore,
  ledgerFillPercent,
  ledgerPriorityBand,
  ledgerPriorityColor,
  normalizeCoverageMetric,
  normalizeCoverageMetrics,
  priorityColor,
  priorityLabel,
  weightedComposite,
};
