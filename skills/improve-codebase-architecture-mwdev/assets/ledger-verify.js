/* ledger-verify.js — self-verifying scoring ledger for the architecture
 * review report (improve-codebase-architecture).
 *
 * Why this exists: every number on a scored report page — priority, band,
 * meter fill, histogram bars, the 1..N rank order — is otherwise hand-typed
 * by the generating model, and nothing catches an arithmetic slip. This
 * module makes the numbers impossible to hand-mistype, the same way
 * mermaid-safe.js made diagrams impossible to hand-break:
 *
 *   - the report embeds ONE spine-schema ledger as a JSON island
 *     (a <script type="application/json" id="ledger"> block)
 *   - every numeric display renders FROM that data (renderLedgerRows,
 *     renderMeterInto, renderRankInto) — prose stays hand-authored
 *   - priority_score is RECOMPUTED from the eight sub-scores; a stored
 *     value that disagrees is flagged, and the computed value is displayed
 *   - band, fill %, and band-track stops are DERIVED from one bands config,
 *     so thresholds can never desync from their pixels
 *   - card order in the DOM is verified against priority order (with the
 *     deterministic tie-break), and a masthead chip reports the verdict
 *   - scheduling is verified per the spine's ## Eligibility and stable
 *     ranking (REPORT-SCORING.md, spine v3): effort domain (S|M|L), status
 *     domain and stored-vs-derived consistency, depends_on/unlocks references
 *     (unknown / self / cycles), and an eligible queue (verified.queue) that
 *     blocked, human-decision, and rejected candidates can never enter
 *
 * The island is also the machine handoff: production-flywheel (or the next
 * run, as a `previous` baseline) reads the same JSON the page rendered from.
 *
 * Deliberately export-free (a classic script), for the same reasons as
 * mermaid-safe.js: the report inlines the body verbatim, and the regression
 * fixture loads it via <script src> from file://. API attached to
 * globalThis.LedgerVerify.
 */

"use strict";

/** The eight spine scores, in display order. Value adds, risk subtracts. */
const LEDGER_SCORE_KEYS = {
  value: ["severity", "confidence", "leverage", "locality", "testability"],
  risk: ["blast_radius", "regression_risk", "human_decision_risk"],
};

/** Short labels for the contribution histogram, index-aligned with the
 * arrays above: sev·cnf·lev·loc·tst / bla·reg·hdr. */
const LEDGER_SCORE_ABBR = {
  severity: "sev", confidence: "cnf", leverage: "lev", locality: "loc",
  testability: "tst", blast_radius: "bla", regression_risk: "reg",
  human_decision_risk: "hdr",
};

/** One-line definitions (from the spine's scoring half), used for the
 * visible legend and its hover glosses. */
const LEDGER_SCORE_DEFS = {
  severity: "how bad the current issue is",
  confidence: "how certain the finding is",
  leverage: "how much improvement a fix likely produces",
  locality: "how contained the fix appears",
  testability: "how easy it is to prove the fix",
  blast_radius: "how many connected surfaces may need coordinated change",
  regression_risk: "how likely the fix is to break behavior",
  human_decision_risk: "how likely the fix requires human judgment (public contract, migration, policy, architecture, deletion, numerical correctness)",
};

/** Spine v3 scheduling domains (REPORT-SCORING.md ## Scheduling fields). */
const LEDGER_EFFORT_ORDER = { S: 0, M: 1, L: 2 };
const LEDGER_STATUS_VALUES = ["ready", "blocked", "needs-human-decision", "rejected", "completed"];

/** Rank position of an effort letter; a missing effort ranks as M. */
function effortRank(effort) {
  return Object.prototype.hasOwnProperty.call(LEDGER_EFFORT_ORDER, effort)
    ? LEDGER_EFFORT_ORDER[effort]
    : LEDGER_EFFORT_ORDER.M;
}

/** Canonical status derivation (spine ## Scheduling fields). `completed` is
 * never derived — only the loop that finished the candidate stores it. */
function deriveStatus(input) {
  if (input.action === "reject") return "rejected";
  if (input.judgmentHeavy || input.blockedByOpen) return "needs-human-decision";
  if (input.unresolvedDeps && input.unresolvedDeps.length) return "blocked";
  return "ready";
}

/** Spine range: −10 … +22. Derived, not restated, everywhere below. */
const LEDGER_RANGE = { min: -10, max: 22 };

/** This report's bands (stamped deviation: Strong ≥13, stricter than the
 * spine style-half's ≥12). Ordered high→low; `min` is the inclusive floor.
 * An island may override with its own `bands` array (same shape). */
const LEDGER_DEFAULT_BANDS = [
  { key: "strong", icon: "✓", label: "Strong", min: 13, color: "#0ca30c" },
  { key: "worth", icon: "◐", label: "Worth exploring", min: 6, color: "#fab219" },
  { key: "speculative", icon: "○", label: "Speculative", min: LEDGER_RANGE.min, color: "#898781" },
];

/** Position of a priority score on the −10…+22 axis, as a 0–100 percent. */
function fillPercent(priority) {
  const span = LEDGER_RANGE.max - LEDGER_RANGE.min;
  const pct = ((priority - LEDGER_RANGE.min) / span) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** priority_score = Σ value − Σ risk. Throws if any score is missing. */
function computePriority(scores) {
  let value = 0;
  let risk = 0;
  for (const k of LEDGER_SCORE_KEYS.value) value += Number(scores[k]);
  for (const k of LEDGER_SCORE_KEYS.risk) risk += Number(scores[k]);
  const priority = value - risk;
  if (Number.isNaN(priority)) throw new Error("scores incomplete");
  return { priority, value, risk };
}

/** Band for a priority under a bands config (default: this report's). */
function bandFor(priority, bands) {
  const list = Array.isArray(bands) && bands.length ? bands : LEDGER_DEFAULT_BANDS;
  for (const b of list) if (priority >= b.min) return b;
  return list[list.length - 1];
}

/** Derive the band-track stop percents from the bands config — one source,
 * so a future cut change can never desync thresholds from pixels. Each stop
 * sits at the position of the threshold score NAMED in the band labels: the
 * lowest band's "≤ N" names N (= the mid band's min − 1), every higher cut
 * "≥ M" names M. For this report's bands that yields 46.9% / 71.9% — the
 * doc's 47/72 stops, derived instead of restated. */
function bandStops(bands) {
  const list = (Array.isArray(bands) && bands.length ? bands : LEDGER_DEFAULT_BANDS)
    .slice()
    .sort((a, b) => a.min - b.min);
  if (list.length < 2) return [];
  const stops = [fillPercent(list[1].min - 1)];
  for (let i = 2; i < list.length; i++) stops.push(fillPercent(list[i].min));
  return stops; // ascending percents, one per interior boundary
}

/** The spine's stable comparator (REPORT-SCORING.md ## Eligibility and
 * stable ranking): priority desc, then effort asc (S < M < L), then severity
 * desc, then confidence desc, then candidate_id ascending. Ties can never
 * reshuffle between runs, so `1..N` stays a stable selection handle. */
function tieBreakCompare(a, b) {
  if (b.computed.priority !== a.computed.priority) return b.computed.priority - a.computed.priority;
  const ea = effortRank(a.effort);
  const eb = effortRank(b.effort);
  if (ea !== eb) return ea - eb; // cheap work first among equals: S < M < L (spine v3)
  if (Number(b.scores.severity) !== Number(a.scores.severity)) return Number(b.scores.severity) - Number(a.scores.severity);
  if (Number(b.scores.confidence) !== Number(a.scores.confidence)) return Number(b.scores.confidence) - Number(a.scores.confidence);
  return String(a.candidate_id) < String(b.candidate_id) ? -1 : 1;
}

/**
 * Verify a parsed ledger against the spine's scoring half and its
 * ## Eligibility and stable ranking. Returns { ok, problems[], candidates[],
 * queue[] } where candidates are normalized — computed priority/band/fill/
 * rank/status/eligible attached — and sorted by the stable comparator, and
 * queue is the eligible candidate_ids in that order. opts.humanOrder (an
 * array of ids) reorders the queue among eligible candidates only; listed
 * ids that are ineligible or unknown land in humanOrderSkipped, never in
 * the queue. Stored rollup.priority_score and status are checked, never
 * trusted for display.
 */
function verifyLedger(ledger, opts) {
  const problems = [];
  const push = (code, candidateId, message) =>
    problems.push({ code, candidate_id: candidateId || null, message });

  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.candidates)) {
    push("ledger-shape", null, "ledger is not an object with a candidates array");
    return { ok: false, problems, candidates: [], queue: [], humanOrderSkipped: [], bands: LEDGER_DEFAULT_BANDS, stops: bandStops() };
  }
  const bands = (opts && opts.bands) || ledger.bands || LEDGER_DEFAULT_BANDS;

  const seen = new Set();
  const normalized = [];
  ledger.candidates.forEach((c, i) => {
    const id = c && c.candidate_id != null ? String(c.candidate_id) : "";
    const ref = id || "candidate[" + i + "]";
    if (!id) push("missing-field", ref, ref + ": missing candidate_id");
    if (id && seen.has(id)) push("dup-id", id, "duplicate candidate_id: " + id);
    seen.add(id);
    if (!c || typeof c.title !== "string" || !c.title.trim())
      push("missing-field", ref, ref + ": missing title");

    // scores: all eight present, integers 1–5
    const scores = (c && c.scores) || {};
    let scoresOk = true;
    for (const k of [...LEDGER_SCORE_KEYS.value, ...LEDGER_SCORE_KEYS.risk]) {
      const v = scores[k];
      if (!Number.isInteger(v) || v < 1 || v > 5) {
        push("score-range", ref, ref + ": scores." + k + " must be an integer 1–5 (got " + JSON.stringify(v) + ")");
        scoresOk = false;
      }
    }

    // evidence rule: file evidence, or explicit architecture-level rationale
    const ev = c && c.evidence;
    if (!Array.isArray(ev) || ev.length === 0) {
      push("evidence-missing", ref, ref + ": evidence is required (file/line, or architecture_level with rationale)");
    } else {
      ev.forEach((e, j) => {
        const ok =
          (e && typeof e.file === "string" && e.file.trim() &&
            typeof e.observation === "string" && e.observation.trim() &&
            (e.line == null || (Number.isInteger(e.line) && e.line >= 1))) ||
          (e && e.architecture_level === true &&
            typeof e.rationale === "string" && e.rationale.trim());
        if (!ok) push("evidence-shape", ref, ref + ": evidence[" + j + "] needs {file, observation, line?} or {architecture_level: true, rationale}");
      });
    }

    const effortValid = c && c.effort != null &&
      Object.prototype.hasOwnProperty.call(LEDGER_EFFORT_ORDER, c.effort);
    if (c && c.effort != null && !effortValid)
      push("effort-range", ref, ref + ": effort must be one of S | M | L when present (got " + JSON.stringify(c.effort) + ")");

    const statusStored = c && c.status != null ? String(c.status) : null;
    if (statusStored != null && LEDGER_STATUS_VALUES.indexOf(statusStored) < 0)
      push("status-invalid", ref, ref + ": status must be one of " + LEDGER_STATUS_VALUES.join(" | ") + " when present (got " + JSON.stringify(c.status) + ")");

    if (!scoresOk) return; // can't compute a priority worth showing

    const computed = computePriority(scores);
    const stored = c.rollup && c.rollup.priority_score;
    if (stored != null && Number(stored) !== computed.priority) {
      push("priority-mismatch", ref,
        ref + ": stored priority_score " + stored + " ≠ recomputed " + computed.priority + " — displaying the recomputed value");
    }
    normalized.push({
      candidate_id: id || ref,
      title: c.title || ref,
      scores,
      rollup: c.rollup || {},
      evidence: Array.isArray(ev) ? ev : [],
      computed,
      band: bandFor(computed.priority, bands),
      fillPct: fillPercent(computed.priority),
      effort: effortValid ? c.effort : null,
      statusStored: statusStored != null && LEDGER_STATUS_VALUES.indexOf(statusStored) >= 0 ? statusStored : null,
      statusInvalid: statusStored != null && LEDGER_STATUS_VALUES.indexOf(statusStored) < 0,
      depends_on: c && Array.isArray(c.depends_on) ? c.depends_on.map(String) : null,
      unlocks: c && Array.isArray(c.unlocks) ? c.unlocks.map(String) : null,
      judgmentHeavy: Number(scores.human_decision_risk) >= 4,
    });
  });

  normalized.sort(tieBreakCompare);
  normalized.forEach((c, i) => { c.rank = i + 1; });

  // spine v3 scheduling — the executable form of REPORT-SCORING.md
  // ## Eligibility and stable ranking: refs, cycles, status, queue.
  const byId = new Map(normalized.map((c) => [c.candidate_id, c]));
  for (const c of normalized) {
    for (const field of ["depends_on", "unlocks"]) {
      const arr = c[field];
      if (arr == null) continue;
      for (const r of arr) {
        if (r === c.candidate_id) {
          push("dep-self", c.candidate_id, c.candidate_id + ": " + field + " references itself");
        } else if (!seen.has(r)) {
          push("dep-unknown", c.candidate_id,
            c.candidate_id + ": " + field + " references unknown id: " + r);
        }
      }
    }
  }

  // dependency cycles over known, non-self depends_on edges; each cycle once
  {
    const color = new Map(); // 1 = on current path, 2 = done
    for (const start of normalized) {
      if (color.get(start.candidate_id)) continue;
      const stack = [[start.candidate_id, 0]];
      const path = [];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const id = frame[0];
        if (frame[1] === 0) { color.set(id, 1); path.push(id); }
        const node = byId.get(id);
        const deps = node && Array.isArray(node.depends_on) ? node.depends_on : [];
        if (frame[1] < deps.length) {
          const d = deps[frame[1]++];
          if (d === id || !byId.has(d)) continue; // self/unknown reported above
          const st = color.get(d);
          if (st === 1) {
            const cycle = path.slice(path.indexOf(d)).concat(d);
            push("dep-cycle", d, "dependency cycle: " + cycle.join(" → "));
          } else if (!st) {
            stack.push([d, 0]);
          }
        } else {
          color.set(id, 2);
          stack.pop();
          path.pop();
        }
      }
    }
  }

  // status: derive, check stored consistency, mark eligibility
  for (const c of normalized) {
    const rollup = c.rollup || {};
    const action = rollup.recommended_action != null ? String(rollup.recommended_action) : null;
    const bb = rollup.blocked_by;
    const blockedByOpen = Array.isArray(bb) ? bb.length > 0 : bb != null && String(bb).trim() !== "";
    const unresolvedDeps = (Array.isArray(c.depends_on) ? c.depends_on : []).filter((d) => {
      if (d === c.candidate_id) return false; // reported as dep-self
      const dep = byId.get(d);
      return !dep || dep.statusStored !== "completed"; // completed is only ever stored
    });
    const derived = deriveStatus({ action: action, judgmentHeavy: c.judgmentHeavy, blockedByOpen: blockedByOpen, unresolvedDeps: unresolvedDeps });
    c.statusDerived = derived;
    c.status = c.statusStored || derived;
    if (c.statusStored === "ready" && derived !== "ready") {
      push("status-conflict", c.candidate_id,
        c.candidate_id + ": marked ready but derives " + derived +
        (unresolvedDeps.length && derived === "blocked" ? " (unresolved depends_on: " + unresolvedDeps.join(", ") + ")" : "") +
        " — a stored status may be stricter than derived, never looser");
    }
    // spine Phase 1 eligibility: effective status ready AND every derived gate
    // open. An invalid stored status fails closed — never eligible.
    c.eligible = !c.statusInvalid && c.status === "ready" && derived === "ready";
  }

  // the machine queue: eligible candidates in stable-comparator order.
  // Blocked, human-decision, and rejected candidates can never enter it.
  let queue = normalized.filter((c) => c.eligible).map((c) => c.candidate_id);
  const humanOrderSkipped = [];
  const humanOrder = opts && Array.isArray(opts.humanOrder) ? opts.humanOrder.map(String) : null;
  if (humanOrder) {
    const eligibleSet = new Set(queue);
    const picked = [];
    for (const id of humanOrder) {
      if (eligibleSet.has(id) && picked.indexOf(id) < 0) picked.push(id);
      else humanOrderSkipped.push({ candidate_id: id, reason: seen.has(id) ? "ineligible" : "unknown" });
    }
    queue = picked.concat(queue.filter((id) => picked.indexOf(id) < 0));
  }

  return {
    ok: problems.length === 0,
    problems,
    candidates: normalized,
    queue,
    humanOrderSkipped,
    bands,
    stops: bandStops(bands),
    spine_version: ledger.spine_version != null ? String(ledger.spine_version) : null,
    judgmentHeavyCount: normalized.filter((c) => c.judgmentHeavy).length,
  };
}

/** Parse the JSON island. Returns { ledger } or { error }. */
function readLedgerIsland(selector, root) {
  const el = (root || document).querySelector(selector || "#ledger");
  if (!el) return { error: "ledger island not found: " + (selector || "#ledger") };
  try {
    return { ledger: JSON.parse(el.textContent) };
  } catch (e) {
    return { error: "ledger island is not valid JSON: " + e.message };
  }
}

/* ---------- rendering (all data goes in via textContent, never markup) --- */

function ledgerEl(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text != null) el.textContent = text;
  return el;
}

const LEDGER_MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;";

/** internal: the ⚖ judgment-heavy glyph, word carried in the tooltip/aria. */
function judgmentGlyph(c) {
  const g = ledgerEl("span", LEDGER_MONO + "font-size:11px;color:var(--ink-muted,#898781);margin-left:6px;", "⚖");
  const label = "judgment-heavy: human_decision_risk " + c.scores.human_decision_risk + "/5";
  g.title = label;
  g.setAttribute("role", "img");
  g.setAttribute("aria-label", label);
  return g;
}

/** Render the ranked ledger rows into a container. Rank, title, inline score
 * bar (fill = position on the −10…+22 axis), mono priority, ⚖ when hdr ≥ 4. */
function renderLedgerRows(el, verified) {
  el.textContent = "";
  for (const c of verified.candidates) {
    const row = ledgerEl("div", "display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--hairline,#e1e0d9);");
    row.setAttribute("data-ledger-row", c.candidate_id);
    row.appendChild(ledgerEl("span", LEDGER_MONO + "font-weight:700;font-size:14px;min-width:22px;text-align:right;color:" + c.band.color + ";", String(c.rank)));
    const title = ledgerEl("span", "font-family:Georgia,'Times New Roman',serif;font-size:15px;color:var(--ink-primary,#0b0b0b);flex:0 1 auto;", c.title);
    row.appendChild(title);
    if (c.judgmentHeavy) row.appendChild(judgmentGlyph(c));
    if (c.effort) {
      const eff = ledgerEl("span", LEDGER_MONO + "font-size:9px;border:1px solid var(--hairline,#e1e0d9);border-radius:4px;padding:0 4px;color:var(--ink-muted,#898781);", c.effort);
      eff.setAttribute("data-chip", "effort");
      eff.title = "effort " + c.effort + " (S < M < L)";
      row.appendChild(eff);
    }
    if (c.unlocks && c.unlocks.length) {
      const un = ledgerEl("span", LEDGER_MONO + "font-size:9px;border:1px solid var(--hairline,#e1e0d9);border-radius:4px;padding:0 4px;color:var(--ink-muted,#898781);", "unlocks " + c.unlocks.length);
      un.setAttribute("data-chip", "unlocks");
      un.title = "unlocks: " + c.unlocks.join(", ");
      row.appendChild(un);
    }
    const track = ledgerEl("span", "flex:1 1 60px;height:4px;border-radius:2px;background:var(--hairline,#e1e0d9);min-width:60px;position:relative;overflow:hidden;");
    const fill = ledgerEl("span", "position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:" + c.band.color + ";width:" + c.fillPct.toFixed(1) + "%;");
    track.title = "priority " + c.computed.priority + " at " + c.fillPct.toFixed(1) + "% of the −10…+22 axis";
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(ledgerEl("span", LEDGER_MONO + "font-size:12px;color:var(--ink-secondary,#52514e);min-width:52px;text-align:right;", "pri " + c.computed.priority));
    el.appendChild(row);
  }
}

/** Render the full strength meter for one candidate: verdict line, derived
 * band track, and a DIVERGING contribution histogram (value bars up, risk
 * bars down) with the recomputed equation as its caption. */
function renderMeterInto(el, c, verified) {
  el.textContent = "";
  el.classList.add("ledger-meter");

  // 1 · verdict line
  const verdict = ledgerEl("div", "display:flex;align-items:baseline;gap:10px;margin-bottom:8px;");
  verdict.appendChild(ledgerEl("span", "font-weight:700;font-size:14px;color:" + c.band.color + ";", c.band.icon + " " + c.band.label));
  verdict.appendChild(ledgerEl("span", LEDGER_MONO + "font-size:12px;color:var(--ink-secondary,#52514e);", "priority " + c.computed.priority + " / " + LEDGER_RANGE.max));
  if (c.judgmentHeavy) verdict.appendChild(judgmentGlyph(c));
  el.appendChild(verdict);

  // 2 · band track — background stops DERIVED from the bands config
  const stops = verified.stops;
  const track = ledgerEl("div", "position:relative;height:12px;border-radius:6px;overflow:hidden;background:linear-gradient(to right, rgba(137,135,129,.18) 0 " + stops[0] + "%, rgba(250,178,25,.18) " + stops[0] + "% " + stops[1] + "%, rgba(12,163,12,.16) " + stops[1] + "% 100%);");
  track.title = "−10…+22 axis · band stops derived at " + stops.map((s) => s.toFixed(1) + "%").join(" / ");
  for (const s of stops) {
    track.appendChild(ledgerEl("span", "position:absolute;top:0;bottom:0;left:" + s + "%;width:1px;background:var(--baseline,#c3c2b7);"));
  }
  track.appendChild(ledgerEl("span", "position:absolute;left:0;top:0;bottom:0;background:" + c.band.color + ";opacity:.92;width:" + c.fillPct.toFixed(1) + "%;"));
  el.appendChild(track);

  // 3 · diverging contribution histogram + equation caption
  const H = 30; // px per 5-score half
  const histo = ledgerEl("div", "display:flex;align-items:stretch;gap:6px;margin-top:10px;");
  const column = (key, kind) => {
    const score = Number(c.scores[key]);
    const col = ledgerEl("div", "display:flex;flex-direction:column;align-items:center;width:20px;");
    col.setAttribute("data-histo-bar", key);
    col.setAttribute("data-dir", kind === "value" ? "up" : "down");
    const up = ledgerEl("div", "height:" + H + "px;display:flex;align-items:flex-end;width:100%;justify-content:center;");
    const down = ledgerEl("div", "height:" + H + "px;display:flex;align-items:flex-start;width:100%;justify-content:center;");
    const bar = ledgerEl("div", "width:12px;border-radius:2px;height:" + ((score / 5) * H).toFixed(1) + "px;background:" + (kind === "value" ? "var(--ink-secondary,#52514e)" : "rgba(208,59,59,.65)") + ";");
    const label = key + " " + score + "/5 (" + (kind === "value" ? "value, adds" : "risk, subtracts") + ")";
    bar.title = label;
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", label);
    (kind === "value" ? up : down).appendChild(bar);
    col.appendChild(up);
    col.appendChild(ledgerEl("div", "height:1px;width:100%;background:var(--baseline,#c3c2b7);"));
    col.appendChild(down);
    col.appendChild(ledgerEl("div", LEDGER_MONO + "font-size:9px;color:var(--ink-muted,#898781);margin-top:3px;", LEDGER_SCORE_ABBR[key]));
    return col;
  };
  for (const k of LEDGER_SCORE_KEYS.value) histo.appendChild(column(k, "value"));
  histo.appendChild(ledgerEl("div", "width:8px;"));
  for (const k of LEDGER_SCORE_KEYS.risk) histo.appendChild(column(k, "risk"));
  el.appendChild(histo);
  el.appendChild(ledgerEl("div", LEDGER_MONO + "font-size:10px;color:var(--ink-muted,#898781);margin-top:6px;", "Σ value " + c.computed.value + " − Σ risk " + c.computed.risk + " = " + c.computed.priority));
}

/** Fill a rank-rail placeholder: the big serif number, band-coloured. */
function renderRankInto(el, c) {
  el.textContent = String(c.rank);
  el.style.color = c.band.color;
  el.title = c.band.label + " · priority " + c.computed.priority;
}

/** Visible legend for the eight score abbreviations — rendered from the same
 * arrays the histogram uses, so it can never drift from the bars. Tooltips
 * are hover-only; this puts the names on the page (touch screens included). */
function renderScoreLegendInto(el) {
  el.textContent = "";
  el.classList.add("ledger-score-legend");
  const pretty = (k) => k.replace(/_/g, " ").replace("human decision", "human-decision");
  const group = (label, keys, note) => {
    const row = ledgerEl("div", "display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;margin-top:4px;");
    row.appendChild(ledgerEl("span", LEDGER_MONO + "font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted,#898781);min-width:104px;", label + " · " + note));
    for (const k of keys) {
      const item = ledgerEl("span", LEDGER_MONO + "font-size:10px;color:var(--ink-secondary,#52514e);white-space:nowrap;");
      item.setAttribute("data-legend-item", LEDGER_SCORE_ABBR[k]);
      item.title = LEDGER_SCORE_DEFS[k];
      item.appendChild(ledgerEl("b", "font-weight:700;color:var(--ink-primary,#0b0b0b);", LEDGER_SCORE_ABBR[k]));
      item.appendChild(document.createTextNode(" " + pretty(k)));
      row.appendChild(item);
    }
    el.appendChild(row);
  };
  group("value", LEDGER_SCORE_KEYS.value, "adds");
  group("risk", LEDGER_SCORE_KEYS.risk, "subtracts");
  el.appendChild(ledgerEl("div", LEDGER_MONO + "font-size:9px;color:var(--ink-muted,#898781);margin-top:6px;",
    "priority = Σ value − Σ risk · each score 1–5 · scale −10…+22"));
}

/** Verify hand-placed cards sit in rank order and reference real ids. */
function verifyCardOrder(root, verified, problems) {
  const byId = new Map(verified.candidates.map((c) => [c.candidate_id, c]));
  const cards = Array.from((root || document).querySelectorAll("[data-candidate]"));
  let lastRank = 0;
  for (const card of cards) {
    const id = card.getAttribute("data-candidate");
    const c = byId.get(id);
    if (!c) {
      problems.push({ code: "unknown-card", candidate_id: id, message: "card references unknown candidate_id: " + id });
      continue;
    }
    if (c.rank <= lastRank) {
      problems.push({ code: "card-order", candidate_id: id, message: "card " + id + " (rank " + c.rank + ") appears after a higher rank — cards must follow priority order" });
    }
    lastRank = Math.max(lastRank, c.rank);
  }
}

/** The masthead chip. data-ok is set for harnesses; the word carries the
 * verdict, never colour alone. */
function renderChipInto(el, verified) {
  el.textContent = "";
  el.setAttribute("data-ok", verified.ok ? "1" : "0");
  const base = LEDGER_MONO + "display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;";
  if (verified.ok) {
    el.style.cssText = base + "color:#0ca30c;border:1px solid rgba(12,163,12,.4);background:rgba(12,163,12,.08);";
    let text = "✓ scoring verified · " + verified.candidates.length + " candidates";
    if (Array.isArray(verified.queue)) text += " · " + verified.queue.length + " eligible";
    text += " · formula recomputed";
    if (verified.judgmentHeavyCount) text += " · " + verified.judgmentHeavyCount + " judgment-heavy";
    if (verified.spine_version) text += " · spine v" + verified.spine_version;
    el.textContent = text;
    el.title = "priority_score recomputed from the eight sub-scores for every candidate; bands, fills, and rank order derived and checked";
  } else {
    el.style.cssText = base + "color:#d03b3b;border:1px solid rgba(208,59,59,.45);background:rgba(208,59,59,.08);";
    el.textContent = "✗ scoring failed · " + verified.problems.length + " problem" + (verified.problems.length === 1 ? "" : "s");
    el.title = verified.problems.map((p) => p.message).join("\n");
  }
}

/** Optional: print problems as a readable list (report footer, fixtures). */
function renderProblemsInto(el, verified) {
  el.textContent = "";
  if (verified.ok) return;
  for (const p of verified.problems) {
    el.appendChild(ledgerEl("li", LEDGER_MONO + "font-size:11px;color:#d03b3b;", "[" + p.code + "] " + p.message));
  }
}

/**
 * Orchestrator. Reads the island, verifies, renders every numeric display,
 * checks card order, sets the chip. Never throws — a broken island degrades
 * to a red chip and an intact page. Resolves the full verified result.
 */
function runLedger(options) {
  const opts = options || {};
  const root = opts.root || document;
  const chip = root.querySelector(opts.chipSelector || "[data-verify-chip]");
  try {
    const read = readLedgerIsland(opts.islandSelector || "#ledger", root);
    if (read.error) {
      const failed = { ok: false, problems: [{ code: "island", candidate_id: null, message: read.error }], candidates: [], queue: [], humanOrderSkipped: [], stops: bandStops(), judgmentHeavyCount: 0, spine_version: null };
      if (chip) renderChipInto(chip, failed);
      return failed;
    }
    const verified = verifyLedger(read.ledger, { bands: opts.bands, humanOrder: opts.humanOrder });

    const ledgerBox = root.querySelector(opts.ledgerSelector || "[data-ledger]");
    if (ledgerBox) renderLedgerRows(ledgerBox, verified);
    for (const c of verified.candidates) {
      const meter = root.querySelector('[data-meter="' + c.candidate_id + '"]');
      if (meter) renderMeterInto(meter, c, verified);
      const rank = root.querySelector('[data-rank="' + c.candidate_id + '"]');
      if (rank) renderRankInto(rank, c);
    }
    const legendBox = root.querySelector(opts.legendSelector || "[data-score-legend]");
    if (legendBox) renderScoreLegendInto(legendBox);
    root.querySelectorAll("[data-meter],[data-rank]").forEach((el) => {
      const id = el.getAttribute("data-meter") || el.getAttribute("data-rank");
      if (!verified.candidates.some((c) => c.candidate_id === id)) {
        verified.problems.push({ code: "unknown-placeholder", candidate_id: id, message: "placeholder references unknown candidate_id: " + id });
      }
    });
    verifyCardOrder(root, verified, verified.problems);
    verified.ok = verified.problems.length === 0;

    if (chip) renderChipInto(chip, verified);
    const problemsBox = root.querySelector(opts.problemsSelector || "[data-verify-problems]");
    if (problemsBox) renderProblemsInto(problemsBox, verified);
    return verified;
  } catch (error) {
    const failed = { ok: false, problems: [{ code: "harness", candidate_id: null, message: "ledger-verify crashed: " + ((error && error.message) || String(error)) }], candidates: [], queue: [], humanOrderSkipped: [], stops: bandStops(), judgmentHeavyCount: 0, spine_version: null };
    if (chip) renderChipInto(chip, failed);
    return failed;
  }
}

globalThis.LedgerVerify = {
  LEDGER_SCORE_KEYS,
  LEDGER_SCORE_ABBR,
  LEDGER_RANGE,
  LEDGER_DEFAULT_BANDS,
  LEDGER_EFFORT_ORDER,
  LEDGER_STATUS_VALUES,
  effortRank,
  deriveStatus,
  fillPercent,
  computePriority,
  bandFor,
  bandStops,
  tieBreakCompare,
  verifyLedger,
  readLedgerIsland,
  renderLedgerRows,
  renderMeterInto,
  renderRankInto,
  renderScoreLegendInto,
  verifyCardOrder,
  renderChipInto,
  renderProblemsInto,
  runLedger,
};
