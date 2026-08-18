/* health-verify.js — self-verifying health model for the repository health
 * assessment report (repository-health-assessment). Schema version 5.
 *
 * Why this exists: a grade is a claim about an entire repository, and every
 * input to it — weighted coverage, six dimension levels per lane, the
 * criticality-weighted mean, the caps, the confidence index — is otherwise
 * hand-typed by the generating model. One slip and the report states a
 * falsehood with a letter grade's authority.
 *
 * Same contract as ledger-verify.js in shared/candidate-ledger-spine: one
 * JSON island, every display rendered from it, every number recomputed, and
 * a masthead chip whose red state means THE REPORT DOES NOT SHIP.
 *
 * ── v2–v4: anti-gaming and handoff hardening ─────────────────────────────────────────────
 * v1's prose promised stronger guarantees than its code enforced. A review
 * reproduced six ways to earn a green chip on a dishonest island; each is
 * now a hard failure with a regression case:
 *
 *   1. Omitting a surface RAISED weighted coverage — dropping
 *      contracts-and-wiring moved the fixture from 78.8% to 84.4%. The
 *      default inventory is now mandatory: a surface the repository lacks is
 *      declared not-applicable with a reason, never omitted.
 *   2. `core_surfaces` could REPLACE the defaults, hiding an uninspectable
 *      core surface from the Not-gradable rule. It is additive only.
 *   3. Lane weights were free 1–5, so a failing critical lane could be
 *      demoted below the critical threshold, escaping the weakest-critical-
 *      lane cap and shrinking its pull on the mean. Weights are locked.
 *   4. Schema constraints lived only in health.schema.json, which nothing
 *      ran. The load-bearing ones are compiled in here, with a parity test.
 *   5. One broad claim could rubber-stamp all six dimensions — and a claim
 *      reading `fail` could sit under six levels of 4, improving the grade.
 *      Support is now declared per dimension, and level/result coherence is
 *      checked in both directions.
 *   6. A report could omit five of six lane scorecards and still verify
 *      green. Verification that only checks what IS on the page is not
 *      verification; binding completeness is now checked.
 *
 * ── v5: code-sprawl pressure ──────────────────────────────────────────────
 * Health islands could report clean lane scores while stale, duplicated, or
 * unowned reachable code sat unmentioned — nothing forced that evidence into
 * view. v5 adds a required `sprawl_pressure` block: five evidence arrays
 * (stale reachable paths, competing authoritative implementations, duplicated
 * contract representations, unowned compatibility layers, abandoned reachable
 * experiments) plus two enums (automated_sprawl_checks, assessment). It is
 * NOT a thirteenth lane or a seventh dimension — it carries no weight and
 * computes no score of its own. It INFORMS the architecture-fitness and
 * maintainability-and-ownership lane claims: every claim_id it cites must
 * belong to one of those two lanes. Every count a report displays is the
 * evidence array's own `.length`, never a stored number.
 *
 * Candidate scoring is NOT implemented here. Candidates follow the shared
 * spine and are verified by ledger-verify.js, whose body the report pastes
 * alongside this one. Its absence is reported, never silently skipped.
 *
 * Deliberately export-free (a classic script): the report inlines the body
 * verbatim, and the regression fixture loads it via <script src> from
 * file://. No `document` access at module scope, so the pure math also runs
 * under Node. API attached to globalThis.HealthVerify.
 */

"use strict";

const HEALTH_SCHEMA_VERSION = 5;
const HEALTH_SPINE_VERSION = 3;

/* ------------------------------- coverage ------------------------------- */

/** The default surface inventory. EVERY id here must appear in the island.
 * A surface the repository lacks is declared `not-applicable` with a reason;
 * it is never omitted, because omission silently shrinks the denominator and
 * makes a thin assessment read as a thorough one. */
const HEALTH_DEFAULT_SURFACES = {
  "runtime-code": { weight: 5, core: true },
  "domain-libraries": { weight: 4, core: true },
  "architecture-boundaries": { weight: 4, core: true },
  "contracts-and-wiring": { weight: 5, core: true },
  "data-lifecycle": { weight: 4, core: false },
  "verification": { weight: 4, core: true },
  "build-and-delivery": { weight: 3, core: false },
  "operational-behavior": { weight: 3, core: false },
  "generated-surfaces": { weight: 2, core: false },
  "specialized-paths": { weight: 3, core: false },
  "ownership-and-maintainability": { weight: 2, core: false },
};

/** Coverage states → credit. `not-applicable` is excluded from the
 * denominator entirely; `unavailable` stays in it at zero. That asymmetry is
 * the anti-gaming property: an uninspectable surface is a hole in the
 * assessment, not an absence in the repository. */
const HEALTH_COVERAGE_CREDIT = {
  "inspected": 1.0,
  "sampled": 0.6,
  "inventory-only": 0.25,
  "uninspected": 0.0,
  "unavailable": 0.0,
  "not-applicable": null,
};

/** Coverage says how much was seen; evidence quality says how much the
 * seeing is worth. */
const HEALTH_EVIDENCE_FACTOR = { "strong": 1.0, "moderate": 0.9, "weak": 0.7, "none": 0.0 };

const HEALTH_FRESHNESS = ["fresh", "stale", "unknown"];

/** Surfaces that make a grade meaningful at all. Any one coming back
 * `unavailable` produces "Not gradable", never a fabricated F. An island may
 * ADD to this list; it can never remove from it. */
function coreSurfaceIds(extra) {
  const core = Object.keys(HEALTH_DEFAULT_SURFACES).filter((k) => HEALTH_DEFAULT_SURFACES[k].core);
  if (Array.isArray(extra)) for (const id of extra) if (core.indexOf(String(id)) === -1) core.push(String(id));
  return core;
}

/* --------------------------------- lanes -------------------------------- */

/** The six dimensions and their fixed weights (sum 100). A lane that argues
 * for its own weights is a lane that cannot be compared to another. */
const HEALTH_DIMENSIONS = [
  { key: "observed_soundness", weight: 30, label: "observed soundness" },
  { key: "automated_enforcement", weight: 25, label: "automated enforcement" },
  { key: "verification_readiness", weight: 20, label: "verification readiness" },
  { key: "boundary_clarity", weight: 10, label: "boundary clarity" },
  { key: "change_containment", weight: 10, label: "change containment" },
  { key: "operational_reproducibility", weight: 5, label: "operational reproducibility" },
];

const HEALTH_MATURITY_MAX = 4;

/** Lane weights are LOCKED, not island-supplied. A free weight is the
 * cheapest way to launder a bad grade: demote the failing critical lane to
 * weight 1 and it both escapes the weakest-critical-lane cap and stops
 * pulling on the mean. */
const HEALTH_LANE_DEFINITIONS = {
  "correctness-and-integrity": { weight: 5, required: true },
  "architecture-fitness": { weight: 4, required: true },
  "contracts-and-integration": { weight: 4, required: true },
  "verification-readiness": { weight: 4, required: true },
  "build-and-delivery": { weight: 3, required: true },
  "maintainability-and-ownership": { weight: 2, required: true },
  "data-and-migrations": { weight: 4, required: false },
  "security-and-production-safety": { weight: 5, required: false },
  "numerical-correctness": { weight: 4, required: false },
  "gpu-equivalence": { weight: 3, required: false },
  "performance-and-resources": { weight: 3, required: false },
  "platform-compatibility": { weight: 2, required: false },
};

const HEALTH_CRITICAL_WEIGHT = 4;
const HEALTH_CLAIM_RESULTS = ["pass", "partial", "fail", "unknown"];

/** Optional lanes must be explicitly activated or explicitly excluded. Silence
 * is not a declaration: without this, the three most expensive optional lanes
 * (data, security, numerical) could simply be left out of a repository that
 * plainly has those surfaces, and the report would never say so. */
const HEALTH_LANE_APPLICABILITY = ["applicable", "not-applicable"];

/** Terminal states a previous candidate may legitimately be in when it is
 * absent from the current run. Anything else that disappears is a continuity
 * failure, not a completion. */
const HEALTH_TERMINAL_STATUS = ["completed", "rejected", "superseded", "deferred", "out-of-scope"];

/* Complete shared-ledger spine v3 envelope. This preflight validates the
 * handoff shape and protocol version; priority arithmetic, dependencies,
 * eligibility, ranking, and rendering remain owned by LedgerVerify. */
const HEALTH_CANDIDATE_ACTIONS = ["direct-fix", "design", "prototype", "fitness-check", "triage", "reject"];
const HEALTH_CANDIDATE_MODES = ["sequential", "connected-impact-sweep", "swarm", "blocked-needs-human-decision"];
const HEALTH_CANDIDATE_STATUSES = ["ready", "blocked", "needs-human-decision", "rejected", "completed"];
const HEALTH_CANDIDATE_EFFORTS = ["S", "M", "L"];
const HEALTH_CANDIDATE_FIELDS = ["candidate_id", "title", "lane_sources", "claim_refs", "summary", "root_cause", "evidence", "scores", "rollup", "effort", "depends_on", "unlocks", "status", "dedup"];
const HEALTH_CANDIDATE_ROLLUP_FIELDS = ["priority_score", "recommended_action", "execution_mode", "blocked_by"];
const HEALTH_CANDIDATE_DEDUP_FIELDS = ["duplicate_group", "merged_from"];
const HEALTH_CANDIDATE_SCORE_KEYS = ["severity", "confidence", "leverage", "locality", "testability", "blast_radius", "regression_risk", "human_decision_risk"];
const HEALTH_CANDIDATE_EVIDENCE_FIELDS = ["file", "line", "observation", "architecture_level", "rationale"];

/* ---------------------------- sprawl pressure ---------------------------- */

/** Code-sprawl pressure INFORMS these two lanes' claims (boundary_clarity and
 * change_containment especially). It is not a lane itself, so this list is
 * closed at exactly two — a claim_id outside it is `sprawl-claim-foreign`. */
const HEALTH_SPRAWL_LANES = ["architecture-fitness", "maintainability-and-ownership"];
const HEALTH_SPRAWL_CHECK_STATES = ["none", "partial", "enforced"];
const HEALTH_SPRAWL_ASSESSMENTS = ["low", "moderate", "high"];
const HEALTH_SPRAWL_PROPS = [
  "stale_reachable_paths",
  "competing_authoritative_implementations",
  "duplicated_contract_representations",
  "unowned_compatibility_layers",
  "abandoned_reachable_experiments",
  "automated_sprawl_checks",
  "assessment",
];
const HEALTH_SPRAWL_PATH_FIELDS = ["claim_id", "path", "note"];
const HEALTH_SPRAWL_GROUP_FIELDS = ["claim_id", "group", "members"];
const HEALTH_SPRAWL_CONTRACT_FIELDS = ["claim_id", "contract", "locations"];

/** The five evidence arrays and how to validate each entry's own fields
 * (claim_id is validated separately by validateSprawlClaimRef, since it is
 * the one field every shape shares). */
const HEALTH_SPRAWL_GROUPS = [
  { key: "stale_reachable_paths", fields: HEALTH_SPRAWL_PATH_FIELDS, required: ["claim_id", "path", "note"] },
  { key: "competing_authoritative_implementations", fields: HEALTH_SPRAWL_GROUP_FIELDS, required: ["claim_id", "group"], listField: "members" },
  { key: "duplicated_contract_representations", fields: HEALTH_SPRAWL_CONTRACT_FIELDS, required: ["claim_id", "contract"], listField: "locations" },
  { key: "unowned_compatibility_layers", fields: HEALTH_SPRAWL_PATH_FIELDS, required: ["claim_id", "path", "note"] },
  { key: "abandoned_reachable_experiments", fields: HEALTH_SPRAWL_PATH_FIELDS, required: ["claim_id", "path", "note"] },
];

/* --------------------------------- grade -------------------------------- */

/** Ordered best → worst. Thresholds are ANCHORED to the maturity scale: a
 * repository uniformly at level N scores 25N and lands exactly on the floor
 * of its band. Level 4 → 100 (A, floor 90), level 3 → 75 (B floor), level 2
 * → 50 (C floor), level 1 → 25 (D floor), level 0 → 0 (F).
 *
 * v1 used 90/80/70/60 and consequently graded a uniformly "partial"
 * repository (all level 2) as F — "systemically unsafe" — and a uniformly
 * "mostly systematic" one (all level 3) as C. The rubric's own words and the
 * letters disagreed. The anchor makes them agree by construction; each
 * grade's label is now the maturity level it corresponds to. */
const HEALTH_GRADES = [
  { letter: "A", min: 90, label: "Systematic and regression-resistant across the board", color: "#0ca30c" },
  { letter: "B", min: 75, label: "Mostly systematic; important paths covered and enforced", color: "#0ca30c" },
  { letter: "C", min: 50, label: "Partial; controls exist but coverage or enforcement is inconsistent", color: "#fab219" },
  { letter: "D", min: 25, label: "Ad hoc; primarily dependent on manual knowledge", color: "#ec835a" },
  { letter: "F", min: -Infinity, label: "Absent, broken, or substantially unverified", color: "#d03b3b" },
];

const HEALTH_NOT_GRADABLE = "Not gradable";

const HEALTH_BASELINE_FACTOR = { "trustworthy": 100, "partial": 50, "untrustworthy": 0, "not-run": 0 };
const HEALTH_FRESHNESS_FACTOR = { "fresh": 100, "stale": 50, "unknown": 0 };

/** Isolation modes for running project commands. `in-place` contradicts the
 * skill's byte-identical promise: a test or build run leaves caches,
 * coverage output, snapshots, generated files, or a touched lockfile behind.
 * Approval to run a command is not the same as that command being safe. */
const HEALTH_ISOLATION = ["worktree", "copy", "container", "in-place", "none"];
const HEALTH_COMMAND_KINDS = ["test", "build", "lint", "typecheck", "other"];
const HEALTH_COMMAND_RESULTS = ["pass", "fail", "error", "skipped"];

/** Baseline state alone is too coarse to cap with. "Partial because no test
 * command exists" and "partial because the linter failed" are different
 * situations and earn different ceilings. deriveBaseline returns the reason
 * so applyCaps can tell them apart. */
const HEALTH_BASELINE_CEILING = {
  "not-run": "C",
  "untrustworthy": "C",
  "partial:no-test-command": "B",
  "partial:non-test-not-passing": "C",
  "trustworthy": null,
};

const HEALTH_CONFIDENCE_WEIGHTS = {
  weighted_coverage: 0.40,
  evidence_strength: 0.20,
  baseline_factor: 0.15,
  core_availability: 0.10,
  determinism_ratio: 0.10,
  freshness_factor: 0.05,
};

const HEALTH_CONFIDENCE_BANDS = [
  { key: "high", min: 75 }, { key: "moderate", min: 50 }, { key: "low", min: -Infinity },
];

/** Rounding is applied ONCE, before both display and comparison, so a score
 * can never display as 90.0 while grading as a B.
 *
 * Two precisions, and the split is not cosmetic. The dimension weights
 * (30/25/20/10/10/5) divided by the 0–4 maturity scale put every lane score
 * on a quarter-point lattice: 48.75, 61.25, 83.75. One decimal place would
 * round 48.75 to 48.8 — a number the formula cannot produce, in a document
 * whose whole argument is that its numbers are recomputable. Scores get two
 * decimals; percentages, which have no such lattice, get one. */
function roundScore(n) { return Math.round(n * 100) / 100; }
function roundPct(n) { return Math.round(n * 10) / 10; }
const round1 = roundPct;

/* ------------------------------ pure math ------------------------------- */

/** Read a dimension level from either shape: v2's { level, claim_refs,
 * rationale } or a bare number. Bare numbers stay usable for unit tests and
 * are REJECTED by the verifier, so the island contract is not weakened. */
/** Normalize claim_refs to [{claim_id, support}]. v3 requires the object
 * form: when one claim legitimately informs several dimensions, each
 * reference must say what it supports THERE. A bare id repeated six times is
 * the rubber stamp the prose claimed was impossible; six distinct support
 * statements are an argument. */
function normalizeClaimRefs(refs) {
  if (!Array.isArray(refs)) return null;
  const out = [];
  for (const r of refs) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      out.push({ claim_id: r.claim_id == null ? null : String(r.claim_id), support: r.support, raw: r });
    } else {
      out.push({ claim_id: String(r), support: undefined, bare: true, raw: r });
    }
  }
  return out;
}

function dimensionLevel(entry) {
  if (entry && typeof entry === "object") return Number(entry.level);
  return Number(entry);
}

/** lane_score = Σ(level ÷ 4 × weight_pct). Range 0–100.
 * Levels 3,1,2,2,1,2 → 48.75 (NOT 52.5; see HEALTH-GRADING.md). */
function laneScore(dimensions) {
  let total = 0;
  const parts = [];
  for (const d of HEALTH_DIMENSIONS) {
    const level = dimensionLevel(dimensions[d.key]);
    if (!Number.isFinite(level)) throw new Error("dimension missing: " + d.key);
    const contribution = (level / HEALTH_MATURITY_MAX) * d.weight;
    total += contribution;
    parts.push({ key: d.key, label: d.label, level, weight: d.weight, contribution });
  }
  return { score: roundScore(total), parts };
}

function surfaceCredit(surface) {
  const state = HEALTH_COVERAGE_CREDIT[surface.coverage];
  if (state === null || state === undefined) return null;
  const factor = HEALTH_EVIDENCE_FACTOR[surface.evidence_quality];
  if (factor === undefined) return null;
  return state * factor;
}

/** Criticality-weighted coverage over every surface except not-applicable. */
function weightedCoverage(surfaces, coreIds) {
  const core = new Set(coreSurfaceIds(coreIds));
  let num = 0, den = 0, evNum = 0, coreNum = 0, coreDen = 0;
  const rows = [];
  for (const s of surfaces || []) {
    const w = Number(s.criticality_weight);
    if (s.coverage === "not-applicable") {
      rows.push({ id: s.id, weight: w, applicable: false, credit: null, contribution: 0, coverage: s.coverage, reason: s.reason, evidence_refs: s.evidence_refs || [] });
      continue;
    }
    const credit = surfaceCredit(s);
    const ev = HEALTH_EVIDENCE_FACTOR[s.evidence_quality];
    if (!Number.isFinite(w) || credit === null) {
      rows.push({ id: s.id, weight: w, applicable: true, credit: null, contribution: 0, coverage: s.coverage, evidence_refs: s.evidence_refs || [] });
      continue;
    }
    num += w * credit; den += w; evNum += w * ev;
    if (core.has(s.id)) { coreNum += w * credit; coreDen += w; }
    rows.push({
      id: s.id, weight: w, applicable: true, credit, contribution: w * credit,
      coverage: s.coverage, evidence_quality: s.evidence_quality, core: core.has(s.id),
      evidence_refs: s.evidence_refs || [],
    });
  }
  return {
    weighted_coverage: den ? roundPct((num / den) * 100) : 0,
    evidence_strength: den ? roundPct((evNum / den) * 100) : 0,
    core_availability: coreDen ? roundPct((coreNum / coreDen) * 100) : 0,
    denominator: den, rows,
  };
}

function overallRaw(lanes) {
  let num = 0, den = 0;
  for (const l of lanes) {
    const w = Number(l.criticality_weight);
    if (!Number.isFinite(w)) continue;
    num += l.computed.score * w; den += w;
  }
  return den ? roundScore(num / den) : 0;
}

function gradeFor(score) {
  for (const g of HEALTH_GRADES) if (score >= g.min) return g;
  return HEALTH_GRADES[HEALTH_GRADES.length - 1];
}

function gradeIndex(letter) {
  const i = HEALTH_GRADES.findIndex((g) => g.letter === letter);
  return i === -1 ? HEALTH_GRADES.length - 1 : i;
}

function oneLetterAbove(letter) {
  return HEALTH_GRADES[Math.max(0, gradeIndex(letter) - 1)].letter;
}

/** Derive the baseline state from recorded command results rather than
 * accepting a declaration. A declared baseline that disagrees is flagged. */
function deriveBaseline(commands) {
  if (!Array.isArray(commands) || !commands.length) return { state: "not-run", reason: "no-commands" };
  const results = commands.map((c) => String(c && c.result));
  const tests = commands.filter((c) => String(c && c.kind) === "test");
  if (!tests.length) return { state: "partial", reason: "no-test-command" };
  if (tests.some((c) => String(c.result) !== "pass")) return { state: "untrustworthy", reason: "test-not-passing" };
  // A non-test command recorded as `skipped` with a reason is a documented
  // non-execution, not a failure. Penalising it would reward omitting the
  // record entirely, which is the opposite of what this field is for. A
  // skipped TEST still lands as untrustworthy above: nothing was proved.
  if (results.some((r) => r !== "pass" && r !== "skipped")) return { state: "partial", reason: "non-test-not-passing" };
  return { state: "trustworthy", reason: "all-passing" };
}

/** The ceiling a baseline earns. A `partial` baseline used to cap nothing at
 * all, which allowed an A grade on a repository whose only executed command
 * was a build — nothing had demonstrated the code runs. */
function baselineCeiling(state, reason) {
  if (state === "partial") return HEALTH_BASELINE_CEILING["partial:" + reason] || "C";
  return HEALTH_BASELINE_CEILING[state] || null;
}

/** Which caps fire and what the final grade becomes. A cap is a CEILING:
 * the final grade is the worst of the raw grade and every ceiling. */
function applyCaps(input) {
  const { overall_raw, weighted_coverage, lanes, baseline, uncontained_critical_failure, unavailable_core_surfaces } = input;
  const unavailableCore = unavailable_core_surfaces || [];
  if (weighted_coverage < 40 || unavailableCore.length) {
    return {
      not_gradable: true,
      reason: unavailableCore.length
        ? "core surface could not be inspected: " + unavailableCore.join(", ")
        : "weighted coverage " + weighted_coverage + "% is below the 40% gradability floor",
      raw_grade: gradeFor(overall_raw).letter,
      final_grade: HEALTH_NOT_GRADABLE,
      caps_applied: [],
    };
  }
  const raw = gradeFor(overall_raw).letter;
  const caps = [];
  const critical = lanes.filter((l) => Number(l.criticality_weight) >= HEALTH_CRITICAL_WEIGHT);
  if (critical.length) {
    const weakest = critical.reduce((a, b) => (b.computed.score < a.computed.score ? b : a));
    caps.push({
      cap: "weakest-critical-lane",
      ceiling: oneLetterAbove(gradeFor(weakest.computed.score).letter),
      trigger: weakest.lane + " scored " + weakest.computed.score + " (" + gradeFor(weakest.computed.score).letter + ")",
    });
  }
  const bCeiling = baselineCeiling(baseline, input.baseline_reason);
  if (bCeiling) {
    caps.push({
      cap: "baseline-" + (input.baseline_reason || baseline),
      ceiling: bCeiling,
      trigger: "baseline is " + baseline + " (" + (input.baseline_reason || "unspecified") + ")",
    });
  }
  if (weighted_coverage < 80) caps.push({ cap: "coverage-below-80", ceiling: "B", trigger: "weighted coverage " + weighted_coverage + "%" });
  if (weighted_coverage < 60) caps.push({ cap: "coverage-below-60", ceiling: "C", trigger: "weighted coverage " + weighted_coverage + "%" });
  if (uncontained_critical_failure) {
    caps.push({
      cap: "uncontained-critical-failure", ceiling: "D",
      trigger: typeof uncontained_critical_failure === "string" ? uncontained_critical_failure : "declared in the island",
    });
  }
  let idx = gradeIndex(raw);
  for (const c of caps) idx = Math.max(idx, gradeIndex(c.ceiling));
  const final_grade = HEALTH_GRADES[idx].letter;
  for (const c of caps) c.binding = gradeIndex(c.ceiling) === idx && idx > gradeIndex(raw);
  return { not_gradable: false, reason: null, raw_grade: raw, final_grade, caps_applied: caps };
}

function confidenceIndex(inputs) {
  let total = 0;
  const parts = [];
  for (const key of Object.keys(HEALTH_CONFIDENCE_WEIGHTS)) {
    const weight = HEALTH_CONFIDENCE_WEIGHTS[key];
    const value = Number(inputs[key]) || 0;
    total += value * weight;
    parts.push({ key, value, weight, contribution: value * weight });
  }
  const index = roundPct(total);
  return { index, band: confidenceBand(index).key, parts };
}

function confidenceBand(index) {
  for (const b of HEALTH_CONFIDENCE_BANDS) if (index >= b.min) return b;
  return HEALTH_CONFIDENCE_BANDS[HEALTH_CONFIDENCE_BANDS.length - 1];
}

/* ----------------------------- run-to-run ------------------------------- */

/** Compute the delta from a previous snapshot rather than accepting a
 * hand-authored trend section. Headline figures alone cannot answer "which
 * claims moved?" or "did CONTRACT-007 actually get closed?" — the two
 * questions a reassessment exists to answer. */
function computeDelta(previous, current) {
  if (!previous) return null;
  const d = { headline: [], claims: [], candidates: [], surfaces: [], lanes: [], continuity_problems: [] };
  const head = (label, now, then) => {
    if (then == null) return;
    d.headline.push({ label, previous: Number(then), current: Number(now), change: roundScore(Number(now) - Number(then)) });
  };
  head("raw score", current.grade.raw_score, previous.raw_score);
  head("weighted coverage", current.coverage.weighted_coverage, previous.weighted_coverage);
  head("confidence index", current.confidence.index, previous.confidence_index);
  if (previous.final_grade) d.grade = { previous: String(previous.final_grade), current: current.grade.final_grade };

  if (Array.isArray(previous.claims)) {
    const prev = new Map(previous.claims.map((c) => [String(c.claim_id), c]));
    for (const c of current.claimList) {
      const p = prev.get(c.claim_id);
      if (!p) d.claims.push({ claim_id: c.claim_id, transition: "new", current_result: c.result });
      else if (String(p.result) !== c.result) d.claims.push({ claim_id: c.claim_id, transition: "changed", previous_result: String(p.result), current_result: c.result });
      prev.delete(c.claim_id);
    }
    for (const [id, p] of prev) d.claims.push({ claim_id: id, transition: "dropped", previous_result: String(p.result) });
  }
  if (Array.isArray(previous.candidates)) {
    const prev = new Map(previous.candidates.map((c) => [String(c.candidate_id), c]));
    for (const c of current.candidateList) {
      const p = prev.get(c.candidate_id);
      if (!p) d.candidates.push({ candidate_id: c.candidate_id, transition: "new" });
      else if (String(p.status) === "completed") d.candidates.push({ candidate_id: c.candidate_id, transition: "reopened" });
      else d.candidates.push({ candidate_id: c.candidate_id, transition: "carried" });
      prev.delete(c.candidate_id);
    }
    for (const [id, p] of prev) {
      // Absence is not completion. A candidate can vanish because it was
      // renamed, merged, superseded, deferred, dropped from scope, or simply
      // lost during report generation. Completion has to be stated.
      const status = String(p.lifecycle_status || "");
      if (HEALTH_TERMINAL_STATUS.indexOf(status) > -1) {
        const r = p.resolution;
        let resolutionOk = !!r && typeof r === "object" && !Array.isArray(r);
        if (status === "completed") {
          resolutionOk = resolutionOk && typeof r.completed_at === "string" && r.completed_at.trim() &&
            Array.isArray(r.verification_refs) && r.verification_refs.length > 0 &&
            r.verification_refs.every((x) => typeof x === "string" && x.trim());
        } else if (status === "superseded") {
          resolutionOk = resolutionOk && typeof r.superseded_by === "string" && r.superseded_by.trim();
        } else {
          resolutionOk = resolutionOk && typeof r.reason === "string" && r.reason.trim();
        }
        if (resolutionOk) {
          d.candidates.push({ candidate_id: id, transition: status, resolution: r });
        } else {
          d.candidates.push({ candidate_id: id, transition: "missing-from-current-run", previous_status: status, resolution: r || null });
          d.continuity_problems.push({
            code: "candidate-resolution-missing",
            ref: id,
            message: id + ": terminal lifecycle_status '" + status + "' is not enough by itself. completed requires completed_at + verification_refs; superseded requires superseded_by; rejected/deferred/out-of-scope require reason.",
          });
        }
      } else {
        d.candidates.push({ candidate_id: id, transition: "missing-from-current-run", previous_status: status || String(p.status || "unknown") });
        d.continuity_problems.push({
          code: "candidate-continuity",
          ref: id,
          message: id + ": present in the previous run as '" + (status || String(p.status || "unknown")) + "' and absent now, with no terminal lifecycle_status. Absence is not completion — record lifecycle_status (" + HEALTH_TERMINAL_STATUS.join(" | ") + ") with a status-specific resolution, or carry the candidate forward.",
        });
      }
    }
  }
  if (Array.isArray(previous.surfaces)) {
    const prev = new Map(previous.surfaces.map((s) => [String(s.id), s]));
    for (const r of current.coverage.rows) {
      const p = prev.get(String(r.id));
      if (p && String(p.coverage) !== String(r.coverage)) {
        d.surfaces.push({ id: r.id, previous_coverage: String(p.coverage), current_coverage: String(r.coverage) });
      }
    }
  }
  if (Array.isArray(previous.lanes)) {
    const prev = new Map(previous.lanes.map((l) => [String(l.lane), l]));
    for (const l of current.lanes) {
      const p = prev.get(l.lane);
      if (p && p.lane_score != null) {
        d.lanes.push({ lane: l.lane, previous: Number(p.lane_score), current: l.computed.score, change: roundScore(l.computed.score - Number(p.lane_score)) });
      }
    }
  }
  return d;
}

/* ----------------------------- verification ----------------------------- */

/** Reject properties the schema does not define, so a typo cannot silently
 * become an ignored field. `covrage` must fail loudly, not default to zero. */
function checkUnknownProps(obj, allowed, ref, push) {
  if (!obj || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    if (allowed.indexOf(k) === -1) {
      push("unknown-property", ref, ref + ": unrecognised property '" + k + "' — a typo here would silently be ignored");
    }
  }
}

const HEALTH_TOP_PROPS = ["health_schema_version", "spine_version", "generated", "repository", "core_surfaces", "verification", "uncontained_critical_failure", "coverage", "lanes", "lane_applicability", "claims", "sprawl_pressure", "grade", "candidates", "previous"];
const HEALTH_REPOSITORY_PROPS = ["name", "root", "revision", "freshness", "freshness_evidence", "excluded_scope"];
const HEALTH_FRESHNESS_EVIDENCE_PROPS = ["assessment_revision", "head_revision", "working_tree_clean", "observed_at"];
const HEALTH_COMMAND_PROPS = ["command_id", "kind", "command", "exit_code", "elapsed_seconds", "result", "reason", "note"];
const HEALTH_EVIDENCE_PROPS = ["path", "lines", "note", "architecture_level", "rationale"];
const HEALTH_OBSERVATION_PROPS = ["confirmed", "inferred", "unknown"];
const HEALTH_PREVIOUS_PROPS = ["generated", "revision", "raw_score", "weighted_coverage", "confidence_index", "final_grade", "claims", "candidates", "surfaces", "lanes"];
const HEALTH_APPLICABILITY_PROPS = ["state", "surface_refs", "rationale"];
const HEALTH_GRADE_PROPS = ["raw_score", "raw_grade", "final_grade", "weighted_coverage", "confidence", "confidence_index", "caps_applied", "not_gradable", "reason"];
const HEALTH_SURFACE_PROPS = ["id", "criticality_weight", "coverage", "evidence_quality", "evidence_refs", "reason", "weight_rationale", "note"];
const HEALTH_SURFACE_EVIDENCE_PROPS = ["kind", "ref"];
const HEALTH_SURFACE_EVIDENCE_KINDS = ["claim", "command", "path", "inventory", "rationale", "blocker"];
const HEALTH_LANE_PROPS = ["lane", "criticality_weight", "scores", "lane_score", "grade_drivers", "would_raise", "could_lower"];
const HEALTH_CLAIM_PROPS = ["claim_id", "lane", "statement", "result", "evidence", "observation"];
const HEALTH_VERIFICATION_PROPS = ["baseline", "isolation", "isolation_note", "commands", "note"];
const HEALTH_DIMENSION_PROPS = ["level", "claim_refs", "rationale"];
const HEALTH_CLAIM_REF_PROPS = ["claim_id", "support"];
const HEALTH_REQUIRED_PROSE = ["one-sentence-verdict", "executive-summary", "grade-drivers", "coverage-denominator", "architecture-and-integration-health", "confirmed-observations", "inferred-observations", "unknown-observations", "confidence-improvement"];


/** One evidence entry's claim_id must resolve to a real claim, and that claim
 * must belong to architecture-fitness or maintainability-and-ownership — the
 * two lanes this evidence is allowed to inform. Mirrors the
 * candidate-claim-unknown / candidate-claim-foreign pattern used for
 * candidates, with sprawl- prefixed codes of its own. */
function validateSprawlClaimRef(entry, ref, claimById, push) {
  if (!entry || typeof entry.claim_id !== "string" || !entry.claim_id.trim()) {
    push("sprawl-shape", ref, ref + ": claim_id is required");
    return;
  }
  const claim = claimById.get(entry.claim_id);
  if (!claim) {
    push("sprawl-claim-unknown", ref, ref + ": claim_id names unknown claim " + entry.claim_id);
    return;
  }
  if (HEALTH_SPRAWL_LANES.indexOf(String(claim.lane)) === -1) {
    push("sprawl-claim-foreign", ref, ref + ": claim " + entry.claim_id + " belongs to lane " + claim.lane + ", which is not " + HEALTH_SPRAWL_LANES.join(" or ") + " — sprawl evidence may only inform those two lanes");
  }
}

/** Validate health.sprawl_pressure: five evidence arrays plus two enums.
 * Every array entry's claim_id is cross-checked against claimById (built by
 * the caller from health.claims, so this must run after claims are indexed).
 * Returns nothing — like the rest of this file's validators, it accumulates
 * into `problems` via push and lets the caller derive counts from the arrays
 * themselves at render time, never from a value stored here. */
function validateSprawlPressure(health, claimById, push) {
  const sprawl = health.sprawl_pressure;
  if (!sprawl || typeof sprawl !== "object" || Array.isArray(sprawl)) {
    push("sprawl-shape", "sprawl_pressure", "health.sprawl_pressure is required — sprawl evidence must be visible in the island, not just implied by lane rationale");
    return;
  }
  checkUnknownProps(sprawl, HEALTH_SPRAWL_PROPS, "sprawl_pressure", push);

  for (const group of HEALTH_SPRAWL_GROUPS) {
    const arr = sprawl[group.key];
    if (!Array.isArray(arr)) {
      push("sprawl-shape", "sprawl_pressure." + group.key, "sprawl_pressure." + group.key + " must be an array — use [] when there is no such evidence, never omit the key");
      continue;
    }
    arr.forEach((entry, i) => {
      const ref = "sprawl_pressure." + group.key + "[" + i + "]";
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        push("sprawl-shape", ref, ref + ": must be an object");
        return;
      }
      checkUnknownProps(entry, group.fields, ref, push);
      for (const f of group.required) {
        if (typeof entry[f] !== "string" || !entry[f].trim()) {
          push("sprawl-shape", ref, ref + ": " + f + " is required");
        }
      }
      if (group.listField) {
        const list = entry[group.listField];
        if (!Array.isArray(list) || list.length < 2 || list.some((x) => typeof x !== "string" || !x.trim())) {
          push("sprawl-shape", ref, ref + "." + group.listField + " must be an array of at least two non-empty strings — a single entry cannot compete with or duplicate itself");
        }
      }
      validateSprawlClaimRef(entry, ref, claimById, push);
    });
  }

  if (HEALTH_SPRAWL_CHECK_STATES.indexOf(sprawl.automated_sprawl_checks) === -1) {
    push("sprawl-enum", "sprawl_pressure.automated_sprawl_checks", "sprawl_pressure.automated_sprawl_checks must be " + HEALTH_SPRAWL_CHECK_STATES.join(" | ") + " (got " + JSON.stringify(sprawl.automated_sprawl_checks) + ")");
  }
  if (HEALTH_SPRAWL_ASSESSMENTS.indexOf(sprawl.assessment) === -1) {
    push("sprawl-enum", "sprawl_pressure.assessment", "sprawl_pressure.assessment must be " + HEALTH_SPRAWL_ASSESSMENTS.join(" | ") + " (got " + JSON.stringify(sprawl.assessment) + ")");
  }
}

/**
 * Verify a parsed health island. Returns a normalized result with computed
 * values attached and every disagreement recorded in `problems`. Stored
 * values are checked, never trusted for display.
 */
function verifyHealth(health) {
  const problems = [];
  const push = (code, ref, message) => problems.push({ code, ref: ref || null, message });

  if (!health || typeof health !== "object") {
    push("health-shape", null, "health island is not an object");
    return failedResult(problems);
  }
  checkUnknownProps(health, HEALTH_TOP_PROPS, "island", push);

  if (Number(health.health_schema_version) !== HEALTH_SCHEMA_VERSION) {
    push("schema-version", null, "health_schema_version must be " + HEALTH_SCHEMA_VERSION + " (got " + JSON.stringify(health.health_schema_version) + ")");
  }
  if (Number(health.spine_version) !== HEALTH_SPINE_VERSION) {
    push("spine-version", null, "spine_version must be " + HEALTH_SPINE_VERSION + " (got " + JSON.stringify(health.spine_version) + ") — this skill hands candidates to the canonical shared-ledger v3 contract");
  }
  if (typeof health.generated !== "string" || !health.generated.trim()) {
    push("health-shape", null, "health.generated is required and must identify when the evidence snapshot was produced");
  }
  if (!health.repository || typeof health.repository !== "object") {
    push("health-shape", null, "health.repository is required — freshness silently defaulting to 'unknown' hid a missing block entirely");
  } else {
    checkUnknownProps(health.repository, HEALTH_REPOSITORY_PROPS, "repository", push);
    if (typeof health.repository.name !== "string" || !health.repository.name.trim()) {
      push("repository-identity", null, "repository.name is required");
    }
    if (typeof health.repository.revision !== "string" || !health.repository.revision.trim()) {
      push("repository-identity", null, "repository.revision is required");
    }
    const fe = health.repository.freshness_evidence;
    if (!fe || typeof fe !== "object" || Array.isArray(fe)) {
      push("freshness-evidence", null, "repository.freshness_evidence is required — freshness changes confidence and must be demonstrated, not asserted");
    } else {
      checkUnknownProps(fe, HEALTH_FRESHNESS_EVIDENCE_PROPS, "repository.freshness_evidence", push);
      for (const k of ["assessment_revision", "head_revision", "observed_at"]) {
        if (typeof fe[k] !== "string" || !fe[k].trim()) push("freshness-evidence", k, "repository.freshness_evidence." + k + " is required");
      }
      if (typeof fe.working_tree_clean !== "boolean") {
        push("freshness-evidence", "working_tree_clean", "repository.freshness_evidence.working_tree_clean must be boolean");
      }
      if (health.repository.revision && fe.assessment_revision && String(health.repository.revision) !== String(fe.assessment_revision)) {
        push("freshness-inconsistent", null, "repository.revision " + health.repository.revision + " does not match freshness_evidence.assessment_revision " + fe.assessment_revision);
      }
    }
  }
  if (!health.verification || typeof health.verification !== "object") {
    push("health-shape", null, "health.verification is required");
  }
  const freshness = (health.repository && health.repository.freshness) || "unknown";
  if (HEALTH_FRESHNESS.indexOf(freshness) === -1) {
    push("freshness-unknown", null, "repository.freshness must be one of " + HEALTH_FRESHNESS.join(" | ") + " (got " + JSON.stringify(freshness) + ")");
  } else if (health.repository && health.repository.freshness_evidence) {
    const fe = health.repository.freshness_evidence;
    const derivedFresh = String(fe.assessment_revision || "") === String(fe.head_revision || "") && fe.working_tree_clean === true;
    if (freshness === "fresh" && !derivedFresh) {
      push("freshness-inconsistent", null, "repository.freshness is 'fresh' but the assessed revision is not the clean current HEAD");
    }
    if (freshness === "stale" && derivedFresh) {
      push("freshness-inconsistent", null, "repository.freshness is 'stale' but the evidence describes a clean assessment at current HEAD");
    }
  }

  const surfaces = Array.isArray(health.coverage) ? health.coverage : null;
  const laneList = Array.isArray(health.lanes) ? health.lanes : null;
  if (!surfaces) push("health-shape", null, "health.coverage must be an array of surfaces");
  if (!laneList) push("health-shape", null, "health.lanes must be an array of lanes");
  if (!surfaces || !laneList) return failedResult(problems);

  /* ---- surfaces: the full default inventory is mandatory ---- */
  const seenSurface = new Set();
  const surfaceEvidencePending = [];
  for (const s of surfaces) {
    const ref = s && s.id ? String(s.id) : "surface[?]";
    checkUnknownProps(s, HEALTH_SURFACE_PROPS, ref, push);
    if (!s || !s.id) push("surface-missing-field", ref, "surface is missing id");
    if (s && s.id && seenSurface.has(String(s.id))) push("dup-surface-id", ref, "duplicate surface id: " + ref);
    if (s && s.id) seenSurface.add(String(s.id));

    const w = Number(s && s.criticality_weight);
    if (!Number.isInteger(w) || w < 1 || w > 5) {
      push("surface-weight-range", ref, ref + ": criticality_weight must be an integer 1–5 (got " + JSON.stringify(s && s.criticality_weight) + ")");
    } else if (HEALTH_DEFAULT_SURFACES[ref] && HEALTH_DEFAULT_SURFACES[ref].weight !== w &&
               !(s.weight_rationale && String(s.weight_rationale).trim())) {
      push("surface-weight-undocumented", ref, ref + ": weight " + w + " differs from the default " + HEALTH_DEFAULT_SURFACES[ref].weight + " and carries no weight_rationale");
    }

    if (!(s && s.coverage in HEALTH_COVERAGE_CREDIT)) {
      push("surface-state-unknown", ref, ref + ": unknown coverage state " + JSON.stringify(s && s.coverage));
      continue;
    }
    const surfaceEvidence = Array.isArray(s.evidence_refs) ? s.evidence_refs : null;
    if (!surfaceEvidence || !surfaceEvidence.length) {
      push("surface-evidence-missing", ref, ref + ": evidence_refs is required — coverage state and evidence strength affect both the grade cap and confidence");
    } else {
      for (let ei = 0; ei < surfaceEvidence.length; ei++) {
        const er = surfaceEvidence[ei];
        const eref = ref + ".evidence_refs[" + ei + "]";
        if (!er || typeof er !== "object" || Array.isArray(er)) {
          push("surface-evidence-shape", eref, eref + ": must be { kind, ref }");
          continue;
        }
        checkUnknownProps(er, HEALTH_SURFACE_EVIDENCE_PROPS, eref, push);
        if (HEALTH_SURFACE_EVIDENCE_KINDS.indexOf(String(er.kind)) === -1) {
          push("surface-evidence-shape", eref, eref + ": kind must be " + HEALTH_SURFACE_EVIDENCE_KINDS.join(" | "));
        }
        if (typeof er.ref !== "string" || !er.ref.trim()) {
          push("surface-evidence-shape", eref, eref + ": ref is required");
        } else {
          surfaceEvidencePending.push({ surface: ref, kind: String(er.kind), ref: String(er.ref), evidence_quality: s.evidence_quality, coverage: s.coverage });
        }
      }
    }
    if (s.coverage === "not-applicable") {
      if (!s.reason || !String(s.reason).trim()) {
        push("surface-reason-missing", ref, ref + ": not-applicable requires a reason — it is a factual claim that the surface does not exist");
      }
      if (HEALTH_DEFAULT_SURFACES[ref] && HEALTH_DEFAULT_SURFACES[ref].core) {
        push("core-surface-not-applicable", ref, ref + ": a default core surface can never be not-applicable. not-applicable removes a surface from the denominator, so declaring the whole core absent yielded 100% coverage and an A. If it truly cannot be inspected, mark it unavailable — which keeps it in the denominator and makes the repository Not gradable.");
      }
      continue;
    }
    if (!(s.evidence_quality in HEALTH_EVIDENCE_FACTOR)) {
      push("evidence-quality-unknown", ref, ref + ": unknown evidence_quality " + JSON.stringify(s.evidence_quality));
      continue;
    }
    if (s.evidence_quality === "strong" && surfaceEvidence &&
        !surfaceEvidence.some((er) => er && ["claim", "command", "path", "inventory"].indexOf(String(er.kind)) > -1)) {
      push("surface-evidence-weak", ref, ref + ": evidence_quality 'strong' needs at least one deterministic claim, command, path, or inventory reference");
    }
    if (s.coverage === "inspected" && (s.evidence_quality === "weak" || s.evidence_quality === "none")) {
      push("coverage-evidence-mismatch", ref, ref + ": coverage 'inspected' with '" + s.evidence_quality + "' evidence is a contradiction — downgrade the state or upgrade the evidence");
    }
    if (s.coverage === "unavailable" && (!s.reason || !String(s.reason).trim())) {
      push("surface-reason-missing", ref, ref + ": unavailable requires a reason so it can become a human-decision blocker");
    }
  }
  for (const id of Object.keys(HEALTH_DEFAULT_SURFACES)) {
    if (!seenSurface.has(id)) {
      push("surface-inventory-incomplete", id, "default surface '" + id + "' is missing from the inventory — declare it not-applicable with a reason rather than omitting it, because omission shrinks the denominator and inflates weighted coverage");
    }
  }
  if (Array.isArray(health.core_surfaces)) {
    for (const id of health.core_surfaces) {
      if (!seenSurface.has(String(id))) {
        push("core-surface-unknown", String(id), "core_surfaces names '" + id + "', which is not in the inventory");
      }
    }
  }

  const cov = weightedCoverage(surfaces, health.core_surfaces);
  const storedCov = health.grade && health.grade.weighted_coverage;
  if (storedCov != null && roundPct(Number(storedCov)) !== cov.weighted_coverage) {
    push("coverage-mismatch", null, "stored weighted_coverage " + storedCov + " ≠ recomputed " + cov.weighted_coverage + " — displaying the recomputed value");
  }
  const core = coreSurfaceIds(health.core_surfaces);
  const unavailableCore = surfaces
    .filter((s) => s && s.coverage === "unavailable" && core.indexOf(String(s.id)) > -1)
    .map((s) => String(s.id));

  /* ---- claims (indexed first: dimensions reference them) ---- */
  const claims = Array.isArray(health.claims) ? health.claims : [];
  const claimById = new Map();
  const seenClaim = new Set();
  let confirmedCount = 0;
  const claimList = [];
  for (const c of claims) {
    const ref = c && c.claim_id ? String(c.claim_id) : "claim[?]";
    checkUnknownProps(c, HEALTH_CLAIM_PROPS, ref, push);
    if (!c || !c.claim_id) push("claim-shape", ref, "claim is missing claim_id");
    if (seenClaim.has(ref)) push("claim-shape", ref, "duplicate claim_id: " + ref);
    seenClaim.add(ref);
    if (!c || typeof c.statement !== "string" || !c.statement.trim()) push("claim-shape", ref, ref + ": missing statement");
    if (!c || HEALTH_CLAIM_RESULTS.indexOf(c.result) === -1) push("claim-shape", ref, ref + ": result must be one of " + HEALTH_CLAIM_RESULTS.join(" | "));
    const ev = c && c.evidence;
    if (!Array.isArray(ev) || !ev.length) {
      push("claim-evidence-missing", ref, ref + ": evidence is required (path/lines, or architecture_level with rationale)");
    } else {
      ev.forEach((e, j) => {
        const ok = (e && typeof e.path === "string" && e.path.trim()) ||
          (e && e.architecture_level === true && typeof e.rationale === "string" && e.rationale.trim());
        if (!ok) push("claim-evidence-missing", ref, ref + ": evidence[" + j + "] needs {path, lines?} or {architecture_level: true, rationale}");
        checkUnknownProps(e, HEALTH_EVIDENCE_PROPS, ref + ".evidence[" + j + "]", push);
      });
    }
    if (c && c.observation) checkUnknownProps(c.observation, HEALTH_OBSERVATION_PROPS, ref + ".observation", push);
    if (c && c.observation && typeof c.observation.confirmed === "string" && c.observation.confirmed.trim()) confirmedCount++;
    if (c && "score_effect" in c) {
      push("claim-shape", ref, ref + ": score_effect is not part of this model — claims justify dimension levels via per-dimension claim_refs, and the arithmetic has exactly one path");
    }
    if (c && "affects_dimensions" in c) {
      push("claim-shape", ref, ref + ": affects_dimensions was replaced in schema v4 — support is declared per dimension (scores.<dimension>.claim_refs), so one broad claim can no longer rubber-stamp a lane");
    }
    if (c && c.claim_id) {
      claimById.set(ref, c);
      claimList.push({ claim_id: ref, lane: String(c.lane), result: String(c.result) });
    }
  }
  const determinism_ratio = claims.length ? roundPct((confirmedCount / claims.length) * 100) : 0;

  /* ---- sprawl pressure: informs architecture-fitness and
     maintainability-and-ownership claims; scores nothing on its own ---- */
  validateSprawlPressure(health, claimById, push);

  /* ---- lanes: locked weights, per-dimension support ---- */
  const laneIds = new Set();
  const lanes = [];
  for (const l of laneList) {
    const ref = l && l.lane ? String(l.lane) : "lane[?]";
    checkUnknownProps(l, HEALTH_LANE_PROPS, ref, push);
    const def = HEALTH_LANE_DEFINITIONS[ref];
    if (!def) { push("lane-unknown", ref, "unknown lane id: " + ref); continue; }
    if (laneIds.has(ref)) push("lane-duplicate", ref, "duplicate lane: " + ref);
    laneIds.add(ref);
    if (l.criticality_weight != null && Number(l.criticality_weight) !== def.weight) {
      push("lane-weight-locked", ref, ref + ": criticality_weight is fixed at " + def.weight + " (got " + JSON.stringify(l.criticality_weight) + ") — a free weight lets a failing critical lane be demoted out of the weakest-critical-lane cap");
    }

    const dims = (l && l.scores) || {};
    const reuse = new Map(); // claim_id||support -> first dimension that used it
    let dimsOk = true;
    for (const d of HEALTH_DIMENSIONS) {
      const entry = dims[d.key];
      const dref = ref + "." + d.key;
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        push("dimension-shape", dref, dref + ": must be an object { level, claim_refs, rationale } — a bare number carries no audit trail");
        dimsOk = false; continue;
      }
      checkUnknownProps(entry, HEALTH_DIMENSION_PROPS, dref, push);
      const level = entry.level;
      if (!Number.isInteger(level) || level < 0 || level > HEALTH_MATURITY_MAX) {
        push("lane-dimension-range", dref, dref + ": level must be an integer 0–4 (got " + JSON.stringify(level) + ")");
        dimsOk = false; continue;
      }
      if (typeof entry.rationale !== "string" || !entry.rationale.trim()) {
        push("dimension-rationale-missing", dref, dref + ": rationale is required — the level is a human judgment and must be auditable");
      }
      const refs = normalizeClaimRefs(entry.claim_refs);
      if (!refs || !refs.length) {
        push("dimension-unjustified", dref, dref + ": claim_refs is required — a level without its own supporting claims is an opinion with a number attached");
        continue;
      }
      const supporting = [];
      for (const r of refs) {
        if (r.bare) {
          push("claim-ref-shape", dref, dref + ": claim_refs entries must be { claim_id, support } — a bare id repeated across dimensions is exactly the rubber stamp this field exists to prevent");
          continue;
        }
        checkUnknownProps(r.raw, HEALTH_CLAIM_REF_PROPS, dref + ".claim_refs", push);
        if (typeof r.support !== "string" || !r.support.trim()) {
          push("claim-ref-support-missing", dref, dref + ": reference to " + r.claim_id + " needs a `support` line saying what it evidences for THIS dimension");
        }
        const claim = claimById.get(r.claim_id);
        if (!claim) { push("dimension-claim-unknown", dref, dref + ": claim_refs names unknown claim " + r.claim_id); continue; }
        if (String(claim.lane) !== ref) { push("dimension-claim-foreign", dref, dref + ": claim " + r.claim_id + " belongs to lane " + claim.lane + ", not " + ref); continue; }
        supporting.push(claim);
        const key = r.claim_id + "||" + String(r.support || "").trim().toLowerCase();
        if (reuse.has(key)) {
          push("claim-ref-duplicate-support", dref, dref + ": claim " + r.claim_id + " is reused from " + reuse.get(key) + " with an identical support line — one claim may inform several dimensions, but it must say something different about each");
        } else {
          reuse.set(key, dref);
        }
      }
      if (!supporting.length) continue;
      const results = supporting.map((c) => String(c.result));
      const anyPositive = results.some((r) => r === "pass" || r === "partial");
      if (level >= 2 && !anyPositive) {
        push("dimension-incoherent", dref, dref + ": level " + level + " is supported only by claims that " + results.join("/") + " — a control that is absent, failing, or unverified cannot evidence a partial or better maturity");
      }
      if (level >= 4 && !results.some((r) => r === "pass")) {
        push("dimension-incoherent", dref, dref + ": level 4 means systematic and regression-resistant, so it needs at least one claim that passes outright — got " + results.join("/"));
      }
      if (results.every((r) => r === "unknown") && level > 1) {
        push("dimension-incoherent", dref, dref + ": every supporting claim is `unknown`, so nothing above level 1 has been evidenced");
      }
      if (level <= 1 && results.every((r) => r === "pass")) {
        push("dimension-incoherent", dref, dref + ": level " + level + " is supported only by passing claims — either the level or the claims are wrong");
      }
    }
    if (!dimsOk) continue;

    const computed = laneScore(dims);
    if (l.lane_score != null && roundScore(Number(l.lane_score)) !== computed.score) {
      push("lane-score-mismatch", ref, ref + ": stored lane_score " + l.lane_score + " ≠ recomputed " + computed.score + " — displaying the recomputed value");
    }
    lanes.push({
      lane: ref, criticality_weight: def.weight, critical: def.weight >= HEALTH_CRITICAL_WEIGHT,
      scores: dims, computed, grade: gradeFor(computed.score).letter,
      claims: claims.filter((c) => c && String(c.lane) === ref).map((c) => String(c.claim_id)),
    });
  }
  for (const id of Object.keys(HEALTH_LANE_DEFINITIONS)) {
    if (HEALTH_LANE_DEFINITIONS[id].required && !laneIds.has(id)) {
      push("lane-missing", id, "required lane not assessed: " + id);
    }
  }
  // Optional lanes: every one must be activated and scored, or declared
  // not-applicable with a reason and the surface that justifies it. Silence
  // used to let the three most expensive optional lanes vanish unremarked.
  const applicability = health.lane_applicability || {};
  checkUnknownProps(applicability, Object.keys(HEALTH_LANE_DEFINITIONS), "lane_applicability", push);
  for (const id of Object.keys(HEALTH_LANE_DEFINITIONS)) {
    if (HEALTH_LANE_DEFINITIONS[id].required) continue;
    const entry = applicability[id];
    if (laneIds.has(id)) {
      if (entry && String(entry.state) === "not-applicable") {
        push("lane-applicability-contradiction", id, id + ": scored as a lane but declared not-applicable");
      }
      continue;
    }
    if (!entry || typeof entry !== "object") {
      push("lane-applicability-missing", id, "optional lane '" + id + "' is neither scored nor declared in lane_applicability — omission is not a declaration, and it is how an expensive lane quietly disappears");
      continue;
    }
    checkUnknownProps(entry, HEALTH_APPLICABILITY_PROPS, "lane_applicability." + id, push);
    if (HEALTH_LANE_APPLICABILITY.indexOf(String(entry.state)) === -1) {
      push("lane-applicability-state", id, "lane_applicability." + id + ".state must be " + HEALTH_LANE_APPLICABILITY.join(" | "));
    } else if (String(entry.state) === "applicable") {
      push("lane-applicability-contradiction", id, id + ": declared applicable but not scored");
    }
    if (typeof entry.rationale !== "string" || !entry.rationale.trim()) {
      push("lane-applicability-rationale", id, "lane_applicability." + id + ": rationale is required");
    }
    const srefs = Array.isArray(entry.surface_refs) ? entry.surface_refs.map(String) : [];
    if (!srefs.length) {
      push("lane-applicability-surface", id, "lane_applicability." + id + ": surface_refs is required — the claim rests on a surface, and the surface is checkable");
    }
    for (const sref of srefs) {
      if (!seenSurface.has(sref)) push("lane-applicability-surface", id, "lane_applicability." + id + ": surface_refs names '" + sref + "', which is not in the inventory");
    }
  }

  for (const c of claims) {
    if (c && c.lane && !laneIds.has(String(c.lane))) {
      push("claim-lane-unknown", String(c.claim_id), String(c.claim_id) + ": references lane not present in this assessment: " + c.lane);
    }
  }

  /* ---- verification baseline: derived from recorded commands ---- */
  const verification = health.verification || {};
  checkUnknownProps(verification, HEALTH_VERIFICATION_PROPS, "verification", push);
  const commands = Array.isArray(verification.commands) ? verification.commands : [];
  const commandIds = new Set();
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i], cref = "verification.commands[" + i + "]";
    checkUnknownProps(c, HEALTH_COMMAND_PROPS, cref, push);
    if (!c || typeof c.command_id !== "string" || !c.command_id.trim()) {
      push("baseline-command-shape", cref, cref + ": command_id is required so surface evidence can reference this execution record");
    } else if (commandIds.has(String(c.command_id))) {
      push("baseline-command-duplicate", cref, cref + ": duplicate command_id " + c.command_id);
    } else {
      commandIds.add(String(c.command_id));
    }
    if (!c || typeof c.command !== "string" || !c.command.trim()) push("baseline-command-shape", cref, cref + ": command is required");
    if (!c || HEALTH_COMMAND_KINDS.indexOf(String(c.kind)) === -1) push("baseline-command-shape", cref, cref + ": kind must be " + HEALTH_COMMAND_KINDS.join(" | "));
    const res = String(c && c.result);
    if (HEALTH_COMMAND_RESULTS.indexOf(res) === -1) {
      push("baseline-command-shape", cref, cref + ": result must be " + HEALTH_COMMAND_RESULTS.join(" | "));
      continue;
    }
    // Metrics are the evidence that the command actually ran. Without them
    // `result: pass` is a claim about a command, not a record of one.
    if (res === "skipped") {
      if (c.exit_code != null || c.elapsed_seconds != null) push("baseline-command-metrics", cref, cref + ": a skipped command cannot carry execution metrics");
      if (typeof c.reason !== "string" || !c.reason.trim()) push("baseline-command-metrics", cref, cref + ": a skipped command requires a reason");
    } else {
      if (!Number.isInteger(c.exit_code)) push("baseline-command-metrics", cref, cref + ": exit_code is required for an executed command");
      if (!Number.isFinite(Number(c.elapsed_seconds))) push("baseline-command-metrics", cref, cref + ": elapsed_seconds is required for an executed command");
      if (res === "pass" && Number.isInteger(c.exit_code) && c.exit_code !== 0) {
        push("baseline-command-inconsistent", cref, cref + ": result 'pass' with exit_code " + c.exit_code + " — the result follows the exit code, not the other way round");
      }
      if (res === "fail" && Number.isInteger(c.exit_code) && c.exit_code === 0) {
        push("baseline-command-inconsistent", cref, cref + ": result 'fail' with exit_code 0");
      }
    }
  }
  for (const er of surfaceEvidencePending) {
    if (er.kind === "claim" && !claimById.has(er.ref)) {
      push("surface-evidence-unknown", er.surface, er.surface + ": evidence_refs names unknown claim " + er.ref);
    }
    if (er.kind === "command" && !commandIds.has(er.ref)) {
      push("surface-evidence-unknown", er.surface, er.surface + ": evidence_refs names unknown command_id " + er.ref);
    }
  }
  const derived = deriveBaseline(commands);
  const derivedBaseline = derived.state;
  const declaredBaseline = verification.baseline;
  if (!(declaredBaseline in HEALTH_BASELINE_FACTOR)) {
    push("baseline-unknown", null, "verification.baseline must be one of " + Object.keys(HEALTH_BASELINE_FACTOR).join(" | ") + " (got " + JSON.stringify(declaredBaseline) + ")");
  } else if (declaredBaseline !== derivedBaseline) {
    push("baseline-mismatch", null, "declared baseline '" + declaredBaseline + "' ≠ derived '" + derivedBaseline + "' (" + derived.reason + ") from " + commands.length + " recorded command(s) — the state follows the results, it is not asserted");
  }
  const baseline = derivedBaseline;
  const baselineReason = derived.reason;
  if (commands.length) {
    const iso = String(verification.isolation);
    if (HEALTH_ISOLATION.indexOf(iso) === -1) {
      push("baseline-isolation-unknown", null, "verification.isolation must be one of " + HEALTH_ISOLATION.join(" | ") + " when commands were run");
    } else if (iso === "in-place" || iso === "none") {
      push("baseline-not-isolated", null, "commands ran with isolation '" + iso + "' — a build or test run leaves caches, coverage output, snapshots, generated files, or a touched lockfile behind, which breaks the read-only promise. Run them in a worktree, copy, or container at the assessed revision.");
    }
  }

  /* ---- grade ---- */
  const overall_raw = overallRaw(lanes);
  const capResult = applyCaps({
    overall_raw, weighted_coverage: cov.weighted_coverage, lanes, baseline,
    baseline_reason: baselineReason,
    uncontained_critical_failure: health.uncontained_critical_failure || false,
    unavailable_core_surfaces: unavailableCore,
  });
  const confidence = confidenceIndex({
    weighted_coverage: cov.weighted_coverage,
    evidence_strength: cov.evidence_strength,
    baseline_factor: HEALTH_BASELINE_FACTOR[baseline] || 0,
    core_availability: cov.core_availability,
    determinism_ratio,
    freshness_factor: HEALTH_FRESHNESS_FACTOR[freshness] || 0,
  });

  const storedGrade = health.grade || {};
  checkUnknownProps(storedGrade, HEALTH_GRADE_PROPS, "grade", push);
  if (storedGrade.raw_grade != null && String(storedGrade.raw_grade) !== String(capResult.raw_grade)) {
    push("grade-mismatch", null, "stored raw_grade " + storedGrade.raw_grade + " ≠ recomputed " + capResult.raw_grade);
  }
  if (storedGrade.confidence_index != null && roundPct(Number(storedGrade.confidence_index)) !== confidence.index) {
    push("confidence-mismatch", null, "stored confidence_index " + storedGrade.confidence_index + " ≠ recomputed " + confidence.index);
  }
  if (storedGrade.not_gradable != null && Boolean(storedGrade.not_gradable) !== Boolean(capResult.not_gradable)) {
    push("grade-mismatch", null, "stored not_gradable " + storedGrade.not_gradable + " ≠ recomputed " + capResult.not_gradable);
  }
  if (storedGrade.reason != null && !capResult.not_gradable) {
    push("grade-mismatch", null, "grade.reason is set but the repository is gradable — a reason without a Not-gradable verdict reads as a caveat the arithmetic does not support");
  }
  if (storedGrade.final_grade != null && String(storedGrade.final_grade) !== capResult.final_grade) {
    push("grade-mismatch", null, "stored final_grade " + storedGrade.final_grade + " ≠ recomputed " + capResult.final_grade + " — displaying the recomputed value");
  }
  if (storedGrade.raw_score != null && roundScore(Number(storedGrade.raw_score)) !== overall_raw) {
    push("grade-mismatch", null, "stored raw_score " + storedGrade.raw_score + " ≠ recomputed " + overall_raw);
  }
  if (storedGrade.confidence != null && String(storedGrade.confidence) !== confidence.band) {
    push("confidence-mismatch", null, "stored confidence " + storedGrade.confidence + " ≠ recomputed " + confidence.band + " (index " + confidence.index + ")");
  }
  const declared = Array.isArray(storedGrade.caps_applied) ? storedGrade.caps_applied.map((c) => (typeof c === "string" ? c : c.cap)) : null;
  if (declared) {
    const fired = capResult.caps_applied.map((c) => c.cap);
    for (const d of declared) if (fired.indexOf(d) === -1) push("cap-fabricated", null, "declared cap did not fire: " + d);
    for (const f of fired) if (declared.indexOf(f) === -1) push("cap-undeclared", null, "cap fired but was not declared: " + f);
  }

  /* ---- candidates: complete shared-spine v3 envelope + health traceability ---- */
  const candidates = Array.isArray(health.candidates) ? health.candidates : [];
  const candidateList = [];
  const seenCandidateIds = new Set();
  let ledger = null;
  if (candidates.length) {
    for (const c of candidates) {
      const ref = c && c.candidate_id ? String(c.candidate_id) : "candidate[?]";
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        push("candidate-shape", ref, ref + ": candidate must be an object");
        continue;
      }
      checkUnknownProps(c, HEALTH_CANDIDATE_FIELDS, ref, push);
      if (!c.candidate_id || typeof c.candidate_id !== "string") push("candidate-shape", ref, ref + ": candidate_id is required");
      else if (seenCandidateIds.has(ref)) push("candidate-duplicate", ref, "duplicate candidate_id: " + ref);
      else seenCandidateIds.add(ref);
      for (const key of ["title", "summary", "root_cause"]) {
        if (typeof c[key] !== "string" || !c[key].trim()) push("candidate-shape", ref, ref + ": " + key + " is required by the shared spine v3 contract");
      }
      candidateList.push({ candidate_id: ref, status: c.status, lifecycle_status: c.lifecycle_status || null });

      const ls = Array.isArray(c.lane_sources) ? c.lane_sources.map(String) : null;
      if (!ls || !ls.length) {
        push("candidate-missing-lane-sources", ref, ref + ": lane_sources is required");
      } else {
        for (const l of ls) if (!laneIds.has(l)) push("candidate-lane-unknown", ref, ref + ": lane_sources references a lane not in this assessment: " + l);
      }

      const crefs = Array.isArray(c.claim_refs) ? c.claim_refs.map(String) : [];
      if (!crefs.length) {
        push("candidate-missing-claim-refs", ref, ref + ": claim_refs is required — every candidate must trace to at least one health claim");
      } else {
        for (const r of crefs) {
          const claim = claimById.get(r);
          if (!claim) { push("candidate-claim-unknown", ref, ref + ": claim_refs names unknown claim " + r); continue; }
          if (ls && ls.indexOf(String(claim.lane)) === -1) {
            push("candidate-claim-foreign", ref, ref + ": claim " + r + " belongs to lane " + claim.lane + ", which is not among lane_sources (" + ls.join(", ") + ")");
          }
        }
      }

      const evidence = Array.isArray(c.evidence) ? c.evidence : null;
      if (!evidence || !evidence.length) {
        push("candidate-evidence-missing", ref, ref + ": evidence is required by the shared spine");
      } else {
        evidence.forEach((e, i) => {
          const eref = ref + ".evidence[" + i + "]";
          checkUnknownProps(e, HEALTH_CANDIDATE_EVIDENCE_FIELDS, eref, push);
          const fileLevel = e && typeof e.file === "string" && e.file.trim() && e.line != null;
          const architectureLevel = e && e.architecture_level === true && typeof e.rationale === "string" && e.rationale.trim();
          if (!fileLevel && !architectureLevel) push("candidate-evidence-missing", eref, eref + ": needs {file, line, observation} or {architecture_level: true, rationale, observation}");
          if (!e || typeof e.observation !== "string" || !e.observation.trim()) push("candidate-evidence-missing", eref, eref + ": observation is required");
        });
      }

      const scores = c.scores;
      if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
        push("candidate-scores", ref, ref + ": scores object is required");
      } else {
        checkUnknownProps(scores, HEALTH_CANDIDATE_SCORE_KEYS, ref + ".scores", push);
        for (const key of HEALTH_CANDIDATE_SCORE_KEYS) {
          const value = scores[key];
          if (!Number.isInteger(value) || value < 1 || value > 5) push("candidate-scores", ref, ref + ".scores." + key + " must be an integer 1–5");
        }
      }

      const rollup = c.rollup;
      if (!rollup || typeof rollup !== "object" || Array.isArray(rollup)) {
        push("candidate-rollup", ref, ref + ": rollup is required by the shared spine v3 contract");
      } else {
        checkUnknownProps(rollup, HEALTH_CANDIDATE_ROLLUP_FIELDS, ref + ".rollup", push);
        if (!Number.isInteger(rollup.priority_score) || rollup.priority_score < -10 || rollup.priority_score > 22) push("candidate-rollup", ref, ref + ".rollup.priority_score must be an integer −10…22");
        if (HEALTH_CANDIDATE_ACTIONS.indexOf(String(rollup.recommended_action)) === -1) push("candidate-rollup", ref, ref + ".rollup.recommended_action must be " + HEALTH_CANDIDATE_ACTIONS.join(" | "));
        if (HEALTH_CANDIDATE_MODES.indexOf(String(rollup.execution_mode)) === -1) push("candidate-rollup", ref, ref + ".rollup.execution_mode must be " + HEALTH_CANDIDATE_MODES.join(" | "));
        if (!Array.isArray(rollup.blocked_by)) push("candidate-rollup", ref, ref + ".rollup.blocked_by must be an array");
      }

      if (HEALTH_CANDIDATE_EFFORTS.indexOf(String(c.effort)) === -1) push("candidate-scheduling", ref, ref + ": effort must be S | M | L");
      if (!Array.isArray(c.depends_on)) push("candidate-scheduling", ref, ref + ": depends_on must be an array");
      if (!Array.isArray(c.unlocks)) push("candidate-scheduling", ref, ref + ": unlocks must be an array");
      if (HEALTH_CANDIDATE_STATUSES.indexOf(String(c.status)) === -1) push("candidate-scheduling", ref, ref + ": status must be " + HEALTH_CANDIDATE_STATUSES.join(" | "));

      const dedup = c.dedup;
      if (!dedup || typeof dedup !== "object" || Array.isArray(dedup)) {
        push("candidate-dedup", ref, ref + ": dedup is required by the shared spine v3 contract");
      } else {
        checkUnknownProps(dedup, HEALTH_CANDIDATE_DEDUP_FIELDS, ref + ".dedup", push);
        if (!Array.isArray(dedup.merged_from)) push("candidate-dedup", ref, ref + ".dedup.merged_from must be an array");
        if (!Object.prototype.hasOwnProperty.call(dedup, "duplicate_group")) push("candidate-dedup", ref, ref + ".dedup.duplicate_group is required (use null when there is no group)");
      }
    }

    if (Number(health.spine_version) === HEALTH_SPINE_VERSION) {
      if (typeof globalThis !== "undefined" && globalThis.LedgerVerify) {
        const LV = globalThis.LedgerVerify;
        const requiredApi = ["verifyLedger", "renderLedgerRows", "renderScoreLegendInto", "renderChipInto"];
        const missingApi = requiredApi.filter((name) => typeof LV[name] !== "function");
        if (missingApi.length) {
          push("ledger-module-incompatible", null, "ledger-verify.js is loaded but missing required API: " + missingApi.join(", "));
        } else {
          ledger = LV.verifyLedger({ spine_version: health.spine_version, candidates });
          for (const p of ledger.problems) push("spine:" + p.code, p.candidate_id, p.message);
        }
      } else {
        push("ledger-module-missing", null, "candidates are present but ledger-verify.js is not loaded — candidate scoring must be verified by the shared spine module, never re-implemented here");
      }
    }
  }

  // Previous snapshot: shape and identity. A duplicate id here silently wins
  // one of two conflicting histories in the delta.
  if (health.previous) {
    checkUnknownProps(health.previous, HEALTH_PREVIOUS_PROPS, "previous", push);
    const dupCheck = (arr, key, label) => {
      if (!Array.isArray(arr)) return;
      const seenIds = new Set();
      arr.forEach((e, i) => {
        const id = e && e[key] != null ? String(e[key]) : null;
        if (!id) { push("previous-shape", label, "previous." + label + "[" + i + "]: missing " + key); return; }
        if (seenIds.has(id)) push("previous-duplicate", label, "previous." + label + ": duplicate " + key + " " + id);
        seenIds.add(id);
      });
    };
    dupCheck(health.previous.claims, "claim_id", "claims");
    dupCheck(health.previous.candidates, "candidate_id", "candidates");
    dupCheck(health.previous.surfaces, "id", "surfaces");
    dupCheck(health.previous.lanes, "lane", "lanes");
  }

  const result = {
    ok: problems.length === 0, problems,
    coverage: cov, lanes, claimList, candidateList,
    claims: { total: claims.length, confirmed: confirmedCount, determinism_ratio },
    baseline, declared_baseline: declaredBaseline, commands,
    isolation: verification.isolation || null,
    grade: Object.assign({ raw_score: overall_raw, weighted_coverage: cov.weighted_coverage }, capResult),
    confidence, ledger, candidateCount: candidates.length,
    schema_version: String(HEALTH_SCHEMA_VERSION), spine_version: String(HEALTH_SPINE_VERSION),
    previous: health.previous || null, source: health,
  };
  result.delta = computeDelta(health.previous, result);
  if (result.delta && result.delta.continuity_problems.length) {
    for (const p of result.delta.continuity_problems) problems.push(p);
    result.ok = problems.length === 0;
  }
  return result;
}

function failedResult(problems) {
  return {
    ok: false, problems,
    coverage: { weighted_coverage: 0, evidence_strength: 0, core_availability: 0, denominator: 0, rows: [] },
    lanes: [], claimList: [], candidateList: [],
    claims: { total: 0, confirmed: 0, determinism_ratio: 0 },
    baseline: null, declared_baseline: null, commands: [], isolation: null,
    grade: { raw_score: 0, weighted_coverage: 0, not_gradable: true, reason: "island unusable", raw_grade: null, final_grade: HEALTH_NOT_GRADABLE, caps_applied: [] },
    confidence: { index: 0, band: "low", parts: [] },
    ledger: null, candidateCount: 0, schema_version: null, spine_version: null,
    previous: null, delta: null, source: null,
  };
}

/**
 * Binding completeness. v1 caught a placeholder naming an unknown lane but
 * not the inverse: a report could omit five of six lane scorecards and still
 * verify green. Verification that only checks what IS on the page is not
 * verification.
 */
function verifyBinding(root, v) {
  const problems = [];
  const scope = root || document;
  const require1 = (sel, what) => {
    const found = scope.querySelectorAll(sel);
    if (found.length === 0) problems.push({ code: "binding-missing", ref: sel, message: "the report has no " + what + " (" + sel + ")" });
    else if (found.length > 1) problems.push({ code: "binding-duplicate", ref: sel, message: "the report has " + found.length + " " + what + " placeholders (" + sel + "); exactly one is expected" });
  };
  require1("[data-verify-chip]", "verification chip");
  require1("[data-repository-name]", "repository name");
  require1("[data-revision]", "repository revision");
  require1("[data-generated]", "assessment timestamp");
  require1("[data-grade]", "grade panel");
  require1("[data-coverage]", "coverage map");
  require1("[data-confidence]", "confidence panel");
  require1("[data-caps]", "caps panel");
  require1("[data-baseline]", "verification baseline");
  require1("[data-sprawl]", "code-sprawl pressure panel");
  require1("[data-decision-blockers]", "human-decision blockers");
  require1("[data-roadmap]", "improvement roadmap");
  require1("[data-handoff]", "handoff summary");
  require1("[data-verify-problems]", "problem container");
  for (const key of HEALTH_REQUIRED_PROSE) {
    const found = scope.querySelectorAll('[data-prose-required="' + key + '"]');
    if (!found.length) {
      problems.push({ code: "binding-missing", ref: key, message: "required authored prose block is missing: " + key });
      continue;
    }
    if (found.length > 1) {
      problems.push({ code: "binding-duplicate", ref: key, message: "required authored prose block appears " + found.length + " times: " + key });
      continue;
    }
    const value = String(found[0].textContent || "").trim();
    if (!value || /^([A-Z0-9_]+)$/.test(value) || /^TODO\b/i.test(value)) {
      problems.push({ code: "binding-unresolved-placeholder", ref: key, message: "required report prose is still empty or contains a scaffold sentinel: " + key });
    }
  }

  const seen = new Map();
  scope.querySelectorAll("[data-lane]").forEach((el) => {
    const id = el.getAttribute("data-lane");
    seen.set(id, (seen.get(id) || 0) + 1);
  });
  for (const l of v.lanes) {
    if (!seen.has(l.lane)) problems.push({ code: "binding-lane-missing", ref: l.lane, message: "lane " + l.lane + " is in the island but has no scorecard in the report" });
    else if (seen.get(l.lane) > 1) problems.push({ code: "binding-duplicate", ref: l.lane, message: "lane " + l.lane + " has " + seen.get(l.lane) + " scorecards" });
  }
  for (const id of seen.keys()) {
    if (!v.lanes.some((l) => l.lane === id)) {
      problems.push({ code: "unknown-placeholder", ref: id, message: "placeholder references a lane not in the island: " + id });
    }
  }
  if (v.candidateCount) {
    const box = scope.querySelector("[data-candidates]");
    if (!box) {
      problems.push({ code: "binding-missing", ref: "[data-candidates]", message: "the island carries " + v.candidateCount + " candidates but the report has no candidate ledger section" });
    } else {
      if (!box.querySelector("[data-ledger]")) {
        problems.push({ code: "binding-missing", ref: "[data-ledger]", message: "the candidate section has no [data-ledger] container, so no candidate row can render" });
      }
      // Presence of the section was never enough: v2 could show a green chip
      // above an empty panel. Count what actually rendered.
      const rendered = box.querySelectorAll("[data-ledger-row]").length;
      if (rendered !== v.candidateCount) {
        problems.push({ code: "binding-candidate-rows", ref: "[data-candidates]", message: "the island carries " + v.candidateCount + " candidates but " + rendered + " rendered — a green chip above an empty candidate panel is exactly the failure this check exists to catch" });
      }
    }
  }
  if (v.previous && !scope.querySelector("[data-delta-panel]")) {
    problems.push({ code: "binding-missing", ref: "[data-delta-panel]", message: "a previous run is recorded but the report has no run-to-run delta section" });
  }
  return problems;
}

function readHealthIsland(selector, root) {
  const el = (root || document).querySelector(selector || "#health");
  if (!el) return { error: "health island not found: " + (selector || "#health") };
  try { return { health: JSON.parse(el.textContent) }; }
  catch (e) { return { error: "health island is not valid JSON: " + e.message }; }
}

/* ---------- rendering (all data goes in via textContent, never markup) --- */

const HEALTH_MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;";
const HEALTH_SERIF = "font-family:Georgia,'Times New Roman',serif;";

function healthEl(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text != null) el.textContent = text;
  return el;
}

function gradeColor(letter) {
  const g = HEALTH_GRADES.find((x) => x.letter === letter);
  return g ? g.color : "var(--ink-muted,#898781)";
}

function renderGradeInto(el, v) {
  el.textContent = "";
  const g = v.grade;
  const notGradable = g.final_grade === HEALTH_NOT_GRADABLE;
  const row = healthEl("div", "display:flex;align-items:flex-end;gap:22px;flex-wrap:wrap;");
  const letter = healthEl("div", HEALTH_SERIF + "font-size:" + (notGradable ? "26px" : "64px") + ";font-weight:700;line-height:1;color:" + (notGradable ? "var(--ink-muted,#898781)" : gradeColor(g.final_grade)) + ";", g.final_grade);
  letter.setAttribute("data-grade-letter", "");
  row.appendChild(letter);
  const facts = healthEl("div", "display:flex;flex-direction:column;gap:3px;");
  const fact = (label, value) => {
    const line = healthEl("div", HEALTH_MONO + "font-size:12px;color:var(--ink-secondary,#52514e);");
    line.appendChild(healthEl("span", "color:var(--ink-muted,#898781);display:inline-block;min-width:150px;", label));
    line.appendChild(healthEl("span", "font-weight:600;", value));
    return line;
  };
  if (!notGradable) facts.appendChild(fact("Interpretation", HEALTH_GRADES[gradeIndex(g.final_grade)].label));
  facts.appendChild(fact("Grade confidence", v.confidence.band + "  (index " + v.confidence.index + ")"));
  facts.appendChild(fact("Weighted coverage", v.coverage.weighted_coverage + "%"));
  facts.appendChild(fact("Raw score", g.raw_score + (g.raw_grade && !notGradable ? "  (raw grade " + g.raw_grade + ")" : "")));
  facts.appendChild(fact("Verification baseline", String(v.baseline) + (v.isolation ? "  · isolation " + v.isolation : "")));
  row.appendChild(facts);
  el.appendChild(row);
  if (notGradable && g.reason) {
    const why = healthEl("div", "margin-top:10px;padding:8px 12px;border-left:3px solid var(--critical,#d03b3b);" + HEALTH_MONO + "font-size:11px;color:var(--ink-secondary,#52514e);",
      "Not gradable — " + g.reason + ". An F would mean assessed and substantially unverified; this is not that.");
    why.setAttribute("data-not-gradable-reason", "");
    el.appendChild(why);
  }
}

function renderCapsInto(el, v) {
  el.textContent = "";
  if (!v.grade.caps_applied.length) {
    el.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-muted,#898781);", "no caps fired — the grade is the raw score"));
    return;
  }
  for (const c of v.grade.caps_applied) {
    const row = healthEl("div", "display:flex;align-items:baseline;gap:10px;padding:6px 0;border-bottom:1px solid var(--hairline,#e1e0d9);");
    row.setAttribute("data-cap", c.cap);
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:11px;font-weight:700;min-width:26px;color:" + (c.binding ? gradeColor(c.ceiling) : "var(--ink-muted,#898781)") + ";", "≤ " + c.ceiling));
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:11px;color:var(--ink-primary,#0b0b0b);min-width:210px;", c.cap));
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:11px;color:var(--ink-secondary,#52514e);flex:1;", c.trigger));
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted,#898781);", c.binding ? "binding" : "recorded"));
    el.appendChild(row);
  }
}

function renderCoverageInto(el, v) {
  el.textContent = "";
  for (const r of v.coverage.rows) {
    const row = healthEl("div", "display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--hairline,#e1e0d9);");
    row.setAttribute("data-surface", r.id);
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:11px;color:var(--ink-primary,#0b0b0b);min-width:210px;", r.id + (r.core ? " ●" : "")));
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);min-width:26px;", "w" + (r.weight || "?")));
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-secondary,#52514e);min-width:112px;", r.applicable ? (r.coverage || "invalid") : "not-applicable"));
    const track = healthEl("span", "flex:1;height:4px;border-radius:2px;background:var(--hairline,#e1e0d9);min-width:60px;position:relative;overflow:hidden;");
    const pct = r.applicable && r.credit != null ? r.credit * 100 : 0;
    track.appendChild(healthEl("span", "position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:var(--accent,#2a78d6);width:" + pct.toFixed(1) + "%;"));
    track.title = r.applicable
      ? "credit " + (r.credit == null ? "invalid" : r.credit.toFixed(2)) + " · evidence " + (r.evidence_quality || "?")
      : "excluded from the denominator — " + (r.reason || "no reason given");
    row.appendChild(track);
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-secondary,#52514e);min-width:44px;text-align:right;", r.applicable && r.credit != null ? pct.toFixed(0) + "%" : "—"));
    const evidenceLabel = (r.evidence_refs || []).map((er) => er.kind + ":" + er.ref).join(" · ");
    const evidence = healthEl("span", HEALTH_MONO + "font-size:9px;color:var(--ink-muted,#898781);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", evidenceLabel);
    evidence.setAttribute("data-surface-evidence", r.id);
    evidence.title = evidenceLabel;
    row.appendChild(evidence);
    el.appendChild(row);
  }
  const foot = healthEl("div", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);margin-top:8px;",
    "weighted coverage " + v.coverage.weighted_coverage + "% · evidence strength " + v.coverage.evidence_strength + "% · core availability " + v.coverage.core_availability + "% · Σ weight " + v.coverage.denominator);
  foot.setAttribute("data-coverage-foot", "");
  el.appendChild(foot);
}

function renderLaneInto(el, lane) {
  el.textContent = "";
  const head = healthEl("div", "display:flex;align-items:baseline;gap:10px;");
  head.appendChild(healthEl("span", HEALTH_SERIF + "font-size:17px;color:var(--ink-primary,#0b0b0b);", lane.lane));
  head.appendChild(healthEl("span", HEALTH_MONO + "font-size:13px;font-weight:700;color:" + gradeColor(lane.grade) + ";", lane.grade + " · " + lane.computed.score));
  head.appendChild(healthEl("span", HEALTH_MONO + "font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted,#898781);", (lane.critical ? "critical · " : "") + "weight " + lane.criticality_weight));
  el.appendChild(head);
  const bars = healthEl("div", "margin-top:8px;display:flex;flex-direction:column;gap:3px;");
  for (const p of lane.computed.parts) {
    const entry = lane.scores[p.key] || {};
    const row = healthEl("div", "display:flex;align-items:center;gap:8px;");
    row.setAttribute("data-dimension", p.key);
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);min-width:190px;", p.label));
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-secondary,#52514e);min-width:16px;", String(p.level)));
    const track = healthEl("span", "flex:1;height:8px;border-radius:2px;background:var(--hairline,#e1e0d9);min-width:60px;position:relative;overflow:hidden;");
    // width encodes the CONTRIBUTION against the dimension's own weight cap,
    // so a 5%-weight dimension can never look like a 30%-weight one.
    track.appendChild(healthEl("span", "position:absolute;left:0;top:0;bottom:0;background:var(--baseline,#c3c2b7);width:" + p.weight + "%;"));
    track.appendChild(healthEl("span", "position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:var(--accent,#2a78d6);width:" + p.contribution.toFixed(2) + "%;"));
    const refIds = (normalizeClaimRefs(entry.claim_refs) || []).map((r) => r.claim_id).filter(Boolean);
    const refSupport = (normalizeClaimRefs(entry.claim_refs) || [])
      .map((r) => r.claim_id + (r.support ? " — " + r.support : "")).join("\n");
    track.title = p.label + ": level " + p.level + "/4 × weight " + p.weight + "% = " + p.contribution.toFixed(2) +
      (entry.rationale ? "\n" + entry.rationale : "") +
      (refSupport ? "\n" + refSupport : "");
    row.appendChild(track);
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-secondary,#52514e);min-width:52px;text-align:right;", p.contribution.toFixed(2)));
    const refs = healthEl("span", HEALTH_MONO + "font-size:9px;color:var(--ink-muted,#898781);min-width:110px;", refIds.join(" "));
    refs.title = refSupport;
    refs.setAttribute("data-dimension-claims", p.key);
    row.appendChild(refs);
    bars.appendChild(row);
  }
  el.appendChild(bars);
  el.appendChild(healthEl("div", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);margin-top:6px;",
    "Σ (level ÷ 4 × weight) = " + lane.computed.score + " · claims: " + (lane.claims.length ? lane.claims.join(", ") : "none")));
}

/** Code-sprawl pressure: renders the five evidence arrays plus the two enum
 * fields. Every count shown is the rendered array's own .length — never a
 * stored number — so a report can never claim "4 stale paths" while showing
 * 3 rows. This block informs the architecture-fitness and
 * maintainability-and-ownership lane claims; it renders no score of its own.
 * textContent only, exactly like every other render*Into function here. */
function renderSprawlInto(el, sprawl_pressure, claims) {
  el.textContent = "";
  if (!sprawl_pressure || typeof sprawl_pressure !== "object") {
    el.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--critical,#d03b3b);", "sprawl_pressure is missing from the island"));
    return;
  }
  const claimById = new Map((claims || []).map((c) => [String(c.claim_id), c]));
  const groups = [
    { key: "stale_reachable_paths", label: "stale reachable paths", fields: ["path", "note"] },
    { key: "competing_authoritative_implementations", label: "competing authoritative implementations", fields: ["group", "members"] },
    { key: "duplicated_contract_representations", label: "duplicated contract representations", fields: ["contract", "locations"] },
    { key: "unowned_compatibility_layers", label: "unowned compatibility layers", fields: ["path", "note"] },
    { key: "abandoned_reachable_experiments", label: "abandoned reachable experiments", fields: ["path", "note"] },
  ];
  let total = 0;
  for (const g of groups) {
    const items = Array.isArray(sprawl_pressure[g.key]) ? sprawl_pressure[g.key] : [];
    total += items.length;
    const head = healthEl("div", HEALTH_MONO + "font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted,#898781);margin-top:8px;", g.label + " · " + items.length);
    head.setAttribute("data-sprawl-count", g.key);
    el.appendChild(head);
    if (!items.length) {
      el.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-muted,#898781);padding:2px 0;", "none recorded"));
      continue;
    }
    for (const item of items) {
      const row = healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-secondary,#52514e);padding:3px 0;border-bottom:1px solid var(--hairline,#e1e0d9);");
      row.setAttribute("data-sprawl-row", g.key);
      const parts = g.fields.map((f) => {
        const val = item ? item[f] : undefined;
        return f + ": " + (Array.isArray(val) ? val.join(", ") : String(val == null ? "" : val));
      });
      const claim = item ? claimById.get(String(item.claim_id)) : null;
      parts.push("claim: " + String(item && item.claim_id) + (claim ? " (" + claim.lane + ")" : " (unresolved)"));
      row.textContent = parts.join(" · ");
      el.appendChild(row);
    }
  }
  const foot = healthEl("div", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);margin-top:8px;",
    "total sprawl findings " + total + " · automated checks: " + String(sprawl_pressure.automated_sprawl_checks) + " · assessment: " + String(sprawl_pressure.assessment));
  foot.setAttribute("data-sprawl-foot", "");
  el.appendChild(foot);
}

function renderConfidenceInto(el, v) {
  el.textContent = "";
  for (const p of v.confidence.parts) {
    const row = healthEl("div", "display:flex;align-items:center;gap:8px;padding:3px 0;");
    row.setAttribute("data-confidence-input", p.key);
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);min-width:170px;", p.key.replace(/_/g, " ")));
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-secondary,#52514e);min-width:40px;text-align:right;", String(roundPct(p.value))));
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);min-width:44px;text-align:right;", "×" + p.weight));
    const track = healthEl("span", "flex:1;height:5px;border-radius:2px;background:var(--hairline,#e1e0d9);min-width:50px;position:relative;overflow:hidden;");
    track.appendChild(healthEl("span", "position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:var(--accent,#2a78d6);width:" + p.value.toFixed(1) + "%;"));
    row.appendChild(track);
    row.appendChild(healthEl("span", HEALTH_MONO + "font-size:10px;color:var(--ink-secondary,#52514e);min-width:44px;text-align:right;", roundPct(p.contribution).toFixed(1)));
    el.appendChild(row);
  }
  el.appendChild(healthEl("div", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);margin-top:6px;",
    "confidence index " + v.confidence.index + " → " + v.confidence.band + " · high ≥75 · moderate ≥50 · low <50"));
}

/** Run-to-run delta, computed from the previous snapshot — not hand-authored. */
function renderDeltaInto(el, v) {
  el.textContent = "";
  if (!v.delta) {
    el.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-muted,#898781);", "no previous assessment — this run is the baseline"));
    return;
  }
  const d = v.delta;
  for (const h of d.headline) {
    const row = healthEl("div", "display:flex;gap:10px;padding:4px 0;" + HEALTH_MONO + "font-size:11px;");
    row.setAttribute("data-delta", h.label);
    row.appendChild(healthEl("span", "color:var(--ink-muted,#898781);min-width:170px;", h.label));
    row.appendChild(healthEl("span", "color:var(--ink-secondary,#52514e);min-width:60px;", h.previous + " →"));
    row.appendChild(healthEl("span", "font-weight:700;color:var(--ink-primary,#0b0b0b);min-width:60px;", String(h.current)));
    row.appendChild(healthEl("span", "color:" + (h.change > 0 ? "var(--good,#0ca30c)" : h.change < 0 ? "var(--critical,#d03b3b)" : "var(--ink-muted,#898781)") + ";", h.change > 0 ? "+" + h.change : String(h.change)));
    el.appendChild(row);
  }
  if (d.grade) {
    el.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-secondary,#52514e);padding:6px 0;", "grade " + d.grade.previous + " → " + d.grade.current));
  }
  const group = (title, rows, fmt) => {
    if (!rows.length) return;
    el.appendChild(healthEl("div", HEALTH_MONO + "font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted,#898781);margin-top:8px;", title));
    for (const r of rows) {
      const line = healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-secondary,#52514e);padding:2px 0;", fmt(r));
      line.setAttribute("data-delta-item", title);
      el.appendChild(line);
    }
  };
  group("claims", d.claims, (r) => r.claim_id + ": " + (r.transition === "changed" ? r.previous_result + " → " + r.current_result : r.transition));
  group("candidates", d.candidates, (r) => r.candidate_id + ": " + r.transition);
  group("surfaces", d.surfaces, (r) => r.id + ": " + r.previous_coverage + " → " + r.current_coverage);
  group("lanes", d.lanes, (r) => r.lane + ": " + r.previous + " → " + r.current + " (" + (r.change > 0 ? "+" : "") + r.change + ")");
}


/** Create one scorecard container per verified lane. A static six-card
 * scaffold cannot represent activated optional lanes without hand-editing,
 * which made the canonical island fail its own report binding. */
function ensureLaneContainers(root, v) {
  const host = root.querySelector("[data-lanes]");
  if (!host) return;
  host.textContent = "";
  for (const lane of v.lanes) {
    const card = healthEl("div");
    card.className = "lane-card";
    card.setAttribute("data-lane", lane.lane);
    host.appendChild(card);
  }
}

/** Repository identity is machine data, not prose. */
function renderMetadata(root, v) {
  if (!v.source || !v.source.repository) return;
  const repo = v.source.repository;
  const set = (sel, value) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = value == null ? "" : String(value);
  };
  set("[data-repository-name]", repo.name);
  set("[data-revision]", repo.revision);
  set("[data-generated]", v.source.generated);
  if (typeof document !== "undefined" && root === document) {
    document.title = "Repository health — " + String(repo.name || "repository");
  }
}

/** Baseline commands are rendered from the island so a report cannot claim
 * that a command ran without showing its recorded result. */
function renderBaselineInto(el, v) {
  el.textContent = "";
  if (!v.commands.length) {
    el.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-muted,#898781);", "no project commands were run"));
    return;
  }
  for (const c of v.commands) {
    const row = healthEl("div", "display:grid;grid-template-columns:minmax(110px,.7fr) minmax(220px,2fr) minmax(70px,.5fr) minmax(80px,.5fr);gap:8px;padding:5px 0;border-bottom:1px solid var(--hairline,#e1e0d9);" + HEALTH_MONO + "font-size:10px;");
    row.setAttribute("data-command", String(c.command_id || ""));
    row.appendChild(healthEl("span", "color:var(--ink-muted,#898781);", String(c.kind)));
    row.appendChild(healthEl("span", "color:var(--ink-primary,#0b0b0b);", String(c.command)));
    row.appendChild(healthEl("span", "font-weight:700;color:" + (c.result === "pass" ? "var(--good,#0ca30c)" : c.result === "skipped" ? "var(--ink-muted,#898781)" : "var(--critical,#d03b3b)") + ";", String(c.result)));
    const metric = c.result === "skipped" ? String(c.reason || "") : "exit " + c.exit_code + " · " + c.elapsed_seconds + "s";
    row.appendChild(healthEl("span", "color:var(--ink-secondary,#52514e);", metric));
    el.appendChild(row);
  }
  el.appendChild(healthEl("div", HEALTH_MONO + "font-size:10px;color:var(--ink-muted,#898781);margin-top:7px;", "derived baseline " + v.baseline + (v.isolation ? " · isolation " + v.isolation : "")));
}

function renderDecisionBlockersInto(el, v) {
  el.textContent = "";
  const rows = [];
  for (const s of (v.source && v.source.coverage) || []) {
    if (s.coverage === "unavailable") rows.push("surface " + s.id + " unavailable — " + (s.reason || "reason not recorded"));
  }
  for (const c of (v.source && v.source.candidates) || []) {
    const blocked = c.status === "needs-human-decision" || (c.rollup && Array.isArray(c.rollup.blocked_by) && c.rollup.blocked_by.length);
    if (blocked) rows.push(c.candidate_id + " — " + ((c.rollup && c.rollup.blocked_by || []).join(", ") || "human decision required"));
  }
  if (!rows.length) {
    el.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-muted,#898781);", "no human-decision blockers recorded"));
    return;
  }
  for (const text of rows) {
    const row = healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-secondary,#52514e);padding:4px 0;border-bottom:1px solid var(--hairline,#e1e0d9);", text);
    row.setAttribute("data-blocker-row", "");
    el.appendChild(row);
  }
}

function renderRoadmapInto(el, v) {
  el.textContent = "";
  const rows = v.coverage.rows
    .filter((r) => r.applicable && r.credit != null)
    .map((r) => ({ id: r.id, gap: roundScore(Number(r.weight || 0) * (1 - Number(r.credit))) }))
    .filter((r) => r.gap > 0)
    .sort((a, b) => b.gap - a.gap || String(a.id).localeCompare(String(b.id)))
    .slice(0, 5);
  if (!rows.length) {
    el.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-muted,#898781);", "no weighted coverage gaps remain"));
    return;
  }
  for (const r of rows) {
    const row = healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-secondary,#52514e);padding:4px 0;border-bottom:1px solid var(--hairline,#e1e0d9);", r.id + " · weighted gap " + r.gap);
    row.setAttribute("data-roadmap-row", r.id);
    el.appendChild(row);
  }
}

function renderHandoffInto(el, v) {
  el.textContent = "";
  const groups = { architecture: [], integrity: [], blocked: [], rejected: [] };
  for (const c of (v.source && v.source.candidates) || []) {
    const action = c.rollup && c.rollup.recommended_action;
    if (c.status === "needs-human-decision" || c.status === "blocked") groups.blocked.push(c.candidate_id);
    else if (c.status === "rejected" || action === "reject") groups.rejected.push(c.candidate_id);
    else if (action === "design" || action === "prototype") groups.architecture.push(c.candidate_id);
    else groups.integrity.push(c.candidate_id);
  }
  for (const key of ["integrity", "architecture", "blocked", "rejected"]) {
    const ids = groups[key];
    const row = healthEl("div", HEALTH_MONO + "font-size:11px;color:var(--ink-secondary,#52514e);padding:4px 0;border-bottom:1px solid var(--hairline,#e1e0d9);", key + " · " + ids.length + (ids.length ? " · " + ids.join(", ") : ""));
    row.setAttribute("data-handoff-row", key);
    el.appendChild(row);
  }
}

/**
 * Render the candidate ledger from the SINGLE health island, delegating every
 * number to the shared spine module's own renderers.
 *
 * v2 shipped a scaffold that called LedgerVerify.runLedger(), which reads its
 * own `#ledger` island — an island this report does not have. The result was a
 * green health chip above a permanently empty candidate panel. Preserving the
 * one-island design means feeding the spine module the candidates directly
 * rather than duplicating them into a second island, and never re-deriving its
 * renderers here.
 */
function renderCandidatesInto(root, v) {
  const LV = typeof globalThis !== "undefined" ? globalThis.LedgerVerify : null;
  const box = root.querySelector("[data-candidates]");
  if (!box) return;
  const rows = box.querySelector("[data-ledger]");
  const legend = box.querySelector("[data-score-legend]");
  const chip = box.querySelector("[data-ledger-chip]");
  if (!LV || !v.ledger) {
    if (rows) { rows.textContent = ""; rows.appendChild(healthEl("div", HEALTH_MONO + "font-size:11px;color:#d03b3b;", "candidate ledger unavailable: the shared spine module is not loaded")); }
    return;
  }
  if (rows) LV.renderLedgerRows(rows, v.ledger);
  if (legend) LV.renderScoreLegendInto(legend);
  if (chip) LV.renderChipInto(chip, v.ledger);
}

function renderChipInto(el, v) {
  el.textContent = "";
  el.setAttribute("data-ok", v.ok ? "1" : "0");
  const base = HEALTH_MONO + "display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;";
  if (v.ok) {
    el.style.cssText = base + "color:#0ca30c;border:1px solid rgba(12,163,12,.4);background:rgba(12,163,12,.08);";
    let text = "✓ health verified · grade " + v.grade.final_grade + " · " + v.lanes.length + " lanes · coverage " + v.coverage.weighted_coverage + "%";
    if (v.grade.caps_applied.length) text += " · " + v.grade.caps_applied.length + " cap" + (v.grade.caps_applied.length === 1 ? "" : "s");
    if (v.candidateCount) text += " · " + v.candidateCount + " candidates";
    if (v.schema_version) text += " · schema v" + v.schema_version;
    el.textContent = text;
    el.title = "inventory completeness, locked lane weights, per-dimension claim support, coverage, grade, caps, confidence, and report binding all checked";
  } else {
    el.style.cssText = base + "color:#d03b3b;border:1px solid rgba(208,59,59,.45);background:rgba(208,59,59,.08);";
    el.textContent = "✗ health verification failed · " + v.problems.length + " problem" + (v.problems.length === 1 ? "" : "s") + " · report must not ship";
    el.title = v.problems.map((p) => p.message).join("\n");
  }
}

function renderProblemsInto(el, v) {
  el.textContent = "";
  if (v.ok) return;
  for (const p of v.problems) {
    el.appendChild(healthEl("li", HEALTH_MONO + "font-size:11px;color:#d03b3b;", "[" + p.code + "] " + p.message));
  }
}

/**
 * Orchestrator. Reads the island, verifies the model, renders every numeric
 * display, verifies binding completeness, sets the chip. Never throws — a
 * broken island degrades to a red chip and an intact page.
 */
function runHealth(options) {
  const opts = options || {};
  const root = opts.root || document;
  const chip = root.querySelector(opts.chipSelector || "[data-verify-chip]");
  try {
    const read = readHealthIsland(opts.islandSelector || "#health", root);
    if (read.error) {
      const failed = failedResult([{ code: "island", ref: null, message: read.error }]);
      if (chip) renderChipInto(chip, failed);
      return failed;
    }
    const v = verifyHealth(read.health);
    renderMetadata(root, v);
    ensureLaneContainers(root, v);
    const bind = (sel, fn) => { const el = root.querySelector(sel); if (el) fn(el, v); };
    bind(opts.gradeSelector || "[data-grade]", renderGradeInto);
    bind(opts.capsSelector || "[data-caps]", renderCapsInto);
    bind(opts.coverageSelector || "[data-coverage]", renderCoverageInto);
    bind(opts.confidenceSelector || "[data-confidence]", renderConfidenceInto);
    bind(opts.deltaSelector || "[data-delta-panel]", renderDeltaInto);
    bind(opts.baselineSelector || "[data-baseline]", renderBaselineInto);
    bind(opts.sprawlSelector || "[data-sprawl]", function (el, vv) { renderSprawlInto(el, vv.source && vv.source.sprawl_pressure, vv.source && vv.source.claims); });
    bind(opts.blockersSelector || "[data-decision-blockers]", renderDecisionBlockersInto);
    bind(opts.roadmapSelector || "[data-roadmap]", renderRoadmapInto);
    bind(opts.handoffSelector || "[data-handoff]", renderHandoffInto);
    for (const lane of v.lanes) {
      const el = root.querySelector('[data-lane="' + lane.lane + '"]');
      if (el) renderLaneInto(el, lane);
    }
    if (v.candidateCount) renderCandidatesInto(root, v);
    if (opts.checkBinding !== false) {
      for (const p of verifyBinding(root, v)) v.problems.push(p);
    }
    v.ok = v.problems.length === 0;
    if (chip) renderChipInto(chip, v);
    const problemsBox = root.querySelector(opts.problemsSelector || "[data-verify-problems]");
    if (problemsBox) renderProblemsInto(problemsBox, v);
    return v;
  } catch (error) {
    const failed = failedResult([{ code: "harness", ref: null, message: "health-verify crashed: " + ((error && error.message) || String(error)) }]);
    if (chip) renderChipInto(chip, failed);
    return failed;
  }
}

globalThis.HealthVerify = {
  HEALTH_SCHEMA_VERSION,
  HEALTH_SPINE_VERSION,
  HEALTH_DEFAULT_SURFACES,
  HEALTH_COVERAGE_CREDIT,
  HEALTH_EVIDENCE_FACTOR,
  HEALTH_DIMENSIONS,
  HEALTH_LANE_DEFINITIONS,
  HEALTH_CRITICAL_WEIGHT,
  HEALTH_SPRAWL_LANES,
  HEALTH_SPRAWL_CHECK_STATES,
  HEALTH_SPRAWL_ASSESSMENTS,
  HEALTH_SPRAWL_GROUPS,
  HEALTH_GRADES,
  HEALTH_NOT_GRADABLE,
  HEALTH_BASELINE_FACTOR,
  HEALTH_ISOLATION,
  HEALTH_BASELINE_CEILING,
  HEALTH_TERMINAL_STATUS,
  HEALTH_LANE_APPLICABILITY,
  HEALTH_REQUIRED_PROSE,
  HEALTH_CONFIDENCE_WEIGHTS,
  round1, roundScore, roundPct,
  coreSurfaceIds, laneScore, surfaceCredit, weightedCoverage, overallRaw,
  gradeFor, gradeIndex, oneLetterAbove, deriveBaseline, baselineCeiling,
  normalizeClaimRefs, applyCaps,
  confidenceIndex, confidenceBand, computeDelta,
  verifyHealth, verifyBinding, readHealthIsland,
  renderGradeInto, renderCapsInto, renderCoverageInto, renderLaneInto,
  renderConfidenceInto, renderDeltaInto, renderCandidatesInto,
  ensureLaneContainers, renderMetadata, renderBaselineInto,
  renderDecisionBlockersInto, renderRoadmapInto, renderHandoffInto,
  renderSprawlInto, validateSprawlPressure,
  renderChipInto, renderProblemsInto,
  runHealth,
};
