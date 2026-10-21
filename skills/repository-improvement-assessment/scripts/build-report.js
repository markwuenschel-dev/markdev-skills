#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const workspace = require("../../shared/project-intelligence-workspace/project-intelligence-workspace.js");
const { gradeForScore, ledgerPriorityColor, ledgerPriorityBand } = require("./scoring.js");

function parseArgs(argv) {
  const out = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--input", "--output", "--repo"].includes(arg)) {
      if (!argv[index + 1]) throw new Error(`MISSING_VALUE:${arg}`);
      out[arg.slice(2)] = argv[++index];
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  return out;
}
function requireString(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`FIELD_REQUIRED:${label}`); return value; }
function array(value) { return Array.isArray(value) ? value : []; }
function escapeList(values, escapeHtml, empty = "none") { return (array(values).length ? values : [empty]).map(value => `<li>${escapeHtml(String(value))}</li>`).join(""); }
function numberOrText(value, formatNumber) { return value === null || value === undefined ? "Not scored" : formatNumber(value); }
function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "Not recorded";
  if (milliseconds >= 3600000) return `${(milliseconds / 3600000).toFixed(1).replace(/\.0$/, "")}h`;
  if (milliseconds >= 60000) return `${(milliseconds / 60000).toFixed(1).replace(/\.0$/, "")}m`;
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  return `${Math.round(milliseconds)}ms`;
}
function shortOwner(owner) {
  return ({
    "repository-health-assessment": "Health",
    "codebase-integrity-audit-loop": "Integrity",
    "architecture-improvement-intelligence": "Architecture",
  })[owner] || owner;
}
function dispositionFromArchitecture(candidate) { return candidate.disposition || "unassigned"; }
// RIA report grades use one canonical +/- scale. Health's own raw/final letters remain visible as source evidence.
function gradeFor(score) { return gradeForScore(score); }
function scoreColor(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return "#5f6875";
  if (score < 60) return "#ef4444";
  if (score < 70) return "#f59e0b";
  if (score < 80) return "#eab308";
  if (score < 90) return "#22c55e";
  return "#3ecf8e";
}
function ratio(numerator, denominator) {
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= 0) return null;
  return Math.round((top / bottom) * 1000) / 10;
}
// viewBox 0 0 100 1 with preserveAspectRatio none makes every width a literal percentage.
function percentBar(value, color, label) {
  const width = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return `<svg class="bar" viewBox="0 0 100 1" preserveAspectRatio="none" role="img" aria-label="${label}">`
    + `<rect x="0" y="0" width="100" height="1" fill="rgba(255,255,255,.08)"/>`
    + (width > 0 ? `<rect x="0" y="0" width="${width}" height="1" fill="${color}"/>` : "")
    + `</svg>`;
}
function countBy(items, predicate) { return array(items).filter(predicate).length; }
function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log("usage: node scripts/build-report.js --input <ria-report-data-v3.json> [--output <html>] [--repo <repository-root>]"); return; }
  if (!args.input) throw new Error("--input is required");
  const skillRoot = path.resolve(__dirname, "..");
  const sharedRoot = path.resolve(skillRoot, "..", "shared");
  const compiler = require(path.join(sharedRoot, "assessment-acceleration", "report-compiler.js"));
  const presentation = require(path.join(sharedRoot, "report-presentation", "report-presentation.js"));
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
  if (!input || input.report_schema_version !== 3) throw new Error("REPORT_SCHEMA_VERSION_MUST_BE_3: run scripts/build-report-data.js against real child artifacts first");
  const repository = input.repository || {};
  const name = requireString(repository.name, "repository.name");
  const revision = requireString(repository.revision, "repository.revision");
  const analytics = input.analytics || {};
  const health = analytics.health || {};
  const integrity = analytics.integrity || {};
  const architecture = analytics.architecture || {};
  const testing = analytics.testing || null;
  const coverage = analytics.coverage || { line:null, branch:null, changed_line:null };
  const composite = analytics.composite || null;
  const synthesis = input.synthesis || {};
  if (typeof health.score !== "number" || !Number.isFinite(health.score)) throw new Error("REPORT_SUFFICIENCY_FAILED:HEALTH_SCORE_REQUIRED");
  if (!composite || typeof composite.final_score !== "number" || !Number.isFinite(composite.final_score)) throw new Error("REPORT_SUFFICIENCY_FAILED:COMPOSITE_SCORE_REQUIRED");
  if (!Array.isArray(integrity.candidates) || !Array.isArray(architecture.candidates)) throw new Error("REPORT_SUFFICIENCY_FAILED:CANDIDATE_ANALYTICS_REQUIRED");
  if (input.provenance?.child_artifacts_hash_verified !== true || input.provenance?.health_grading_recomputed !== true || input.provenance?.integrity_scoring_recomputed !== true) throw new Error("REPORT_PROVENANCE_GATE_FAILED");

  const statusChip = array(input.blockers).length
    ? `<span class="status blocked">✗ ${input.blockers.length} blocker${input.blockers.length === 1 ? "" : "s"}</span>`
    : `<span class="status complete">✓ bound analytics ready</span>`;

  const scoreGauge = presentation.scoreGauge({
    id: "ria-overall-score",
    title: "Overall RIA score",
    description: `Weighted RIA composite ${composite.final_grade}, ${composite.final_score} out of 100 across six assessment dimensions.`,
    score: composite.final_score,
    grade: composite.final_grade,
    note: `Raw ${composite.raw_score}/100 (${composite.raw_grade})${composite.binding_cap ? ` · capped at ${composite.binding_cap.ceiling} by ${composite.binding_cap.cap}` : ""} · ${Math.round(composite.assessment_coverage)}% dimension coverage.`,
    color: scoreColor(composite.final_score),
  });

  const performance = analytics.performance || {};
  const seiTelemetry = analytics.sei_telemetry || { gate_observation_ratio:null, gate_observation_status:"UNAVAILABLE", criterion_counts:null };
  const metricCards = [
    presentation.metricCard({ label: "Overall RIA", value: `${presentation.formatNumber(composite.final_score)}/100`, note: `Grade ${composite.final_grade} · raw ${composite.raw_grade}` }),
    presentation.metricCard({ label: "Architecture fitness", value: architecture.fitness ? `${presentation.formatNumber(architecture.fitness.score)}/100` : "Health lane", note: architecture.fitness ? `Grade ${architecture.fitness.grade} · ${presentation.formatPercent(architecture.fitness.coverage * 100)} rubric coverage` : "Dedicated architecture fitness not recorded; composite uses canonical Health architecture lane." }),
    presentation.metricCard({ label: "Test-suite fitness", value: testing ? `${presentation.formatNumber(testing.score)}/100` : "Health lane", note: testing ? `Grade ${testing.grade} · review-testing sidecar` : "review-testing sidecar not recorded; composite uses Health verification lane." }),
    presentation.metricCard({ label: "Line coverage", value: coverage.line?.percent == null ? "Not measured" : `${presentation.formatNumber(coverage.line.percent)}%`, note: coverage.line ? `${coverage.line.covered}/${coverage.line.total} lines` : "Never inferred from test count." }),
    presentation.metricCard({ label: "Branch coverage", value: coverage.branch?.percent == null ? "Not measured" : `${presentation.formatNumber(coverage.branch.percent)}%`, note: coverage.branch ? `${coverage.branch.covered}/${coverage.branch.total} branches` : "Never inferred from test count." }),
    presentation.metricCard({ label: "Changed-line coverage", value: coverage.changed_line?.percent == null ? "Not measured" : `${presentation.formatNumber(coverage.changed_line.percent)}%`, note: coverage.changed_line ? `${coverage.changed_line.covered}/${coverage.changed_line.total} changed lines` : "Shown only when measured." }),
    presentation.metricCard({ label: "Assessment coverage", value: `${presentation.formatNumber(composite.assessment_coverage)}%`, note: `Health evidence coverage ${presentation.formatPercent(health.weighted_coverage)}` }),
    presentation.metricCard({ label: "Confidence", value: presentation.formatNumber(health.confidence_index), note: health.confidence_band || "band unavailable" }),
    presentation.metricCard({ label: "Integrity candidates", value: presentation.formatNumber(integrity.candidate_count, 0), note: `${presentation.formatNumber(integrity.eligible_count, 0)} eligible · ${presentation.formatNumber(integrity.judgment_heavy_count, 0)} judgment-heavy` }),
    presentation.metricCard({ label: "Architecture candidates", value: presentation.formatNumber(architecture.candidate_count, 0), note: `${presentation.formatNumber(architecture.scored_count, 0)} priority-scored candidates` }),
    presentation.metricCard({ label: "Wall time", value: formatDuration(performance.wall_time_ms), note: "Measured end-to-end; concurrent phases are not additive" }),
    presentation.metricCard({ label: "Peak concurrency", value: performance.peaks?.total_concurrency ?? "Not recorded", note: `Peak READY queue ${performance.peaks?.ready_queue ?? "unavailable"}` }),
    presentation.metricCard({ label: "SEI evidence", value: seiTelemetry.gate_observation_status === "RECORDED" && seiTelemetry.criterion_counts ? `${seiTelemetry.criterion_counts.assessed}/${seiTelemetry.criterion_counts.applicable}` : "Not recorded", note: seiTelemetry.gate_observation_status === "RECORDED" && seiTelemetry.criterion_counts ? `SEI assessed ${seiTelemetry.criterion_counts.assessed} / ${seiTelemetry.criterion_counts.applicable} applicable criteria` : "SEI telemetry unavailable; no Health or command-count proxy is used." }),
  ].join("");

  const chartCards = [];
  const chart = (title, html, className = "") => chartCards.push(`<article class="rp-chart-card rp-card ${className}"><h3>${compiler.escapeHtml(title)}</h3>${html}</article>`);
  chart("Health lane profile", presentation.horizontalBarChart({ id: "health-lanes", title: "Health lane scores", description: "Canonical Repository Health Assessment scores by lane, ordered weakest first.", items: array(health.lanes).map(lane => ({ label: `${lane.id}${lane.critical ? " · critical" : ""}`, value: lane.score })), max: 100, unit: "/100", note: "Lane scores are recomputed by the Health verifier from the bound health artifact." }), "rp-half");
  chart("Coverage states", presentation.donutChart({ id: "coverage-states", title: "Coverage-state distribution", description: "Count of assessed surfaces by coverage state.", items: health.coverage_states, note: `Weighted coverage is ${presentation.formatPercent(health.weighted_coverage)}; counts do not replace criticality weighting.` }));
  chart("Evidence quality", presentation.donutChart({ id: "evidence-quality", title: "Evidence-quality distribution", description: "Count of applicable surfaces by evidence-quality class.", items: health.evidence_quality, note: `Canonical evidence-strength score: ${presentation.formatPercent(health.evidence_strength)}.` }));
  chart("Integrity priority", presentation.horizontalBarChart({ id: "integrity-priority", title: "Highest integrity priorities", description: "Canonical candidate-ledger priority scores for the highest-ranked integrity candidates.", items: array(integrity.candidates).slice(0, 12).map(candidate => ({ label: `${candidate.candidate_id} · ${candidate.title}`, value: candidate.priority })), note: array(integrity.candidates).length > 12 ? `Showing 12 of ${integrity.candidates.length} integrity candidates. Priority arithmetic is recomputed through shared/candidate-ledger-spine.` : "Priority arithmetic is recomputed through shared/candidate-ledger-spine." }), "rp-half");
  chart("Integrity status", presentation.donutChart({ id: "integrity-status", title: "Integrity candidate status", description: "Distribution of integrity candidates by canonical status.", items: integrity.status_counts }));
  chart("Architecture disposition", presentation.donutChart({ id: "architecture-disposition", title: "Architecture candidate disposition", description: "Distribution of architecture candidates by downstream disposition.", items: architecture.disposition_counts, note: `${architecture.scored_count}/${architecture.candidate_count} architecture candidates have canonical ledger scores.` }));
  const architectureScores = array(architecture.candidates).filter(candidate => candidate.priority !== null);
  chart(architectureScores.length ? "Architecture priority" : "Architecture transformations", architectureScores.length
    ? presentation.horizontalBarChart({ id: "architecture-priority", title: "Scored architecture priorities", description: "Canonical ledger priority scores for architecture candidates where a bound score exists.", items: architectureScores.slice(0, 12).map(candidate => ({ label: `${candidate.candidate_id} · ${candidate.title}`, value: candidate.priority })), note: "Missing architecture scores are not synthesized." })
    : presentation.horizontalBarChart({ id: "architecture-transforms", title: "Architecture transformation types", description: "Candidate counts by architecture transformation type. This is a count, not a fabricated score.", items: architecture.transformation_counts, note: "No bound architecture ledger was available; the report preserves ‘Not scored’." }));
  chart("Downstream routing", presentation.donutChart({ id: "routing", title: "Downstream disposition", description: "Counts of named candidates or actions routed to each downstream workflow.", items: analytics.routing_counts }));
  if (array(analytics.convergence_counts).length) chart("Cross-owner convergence", presentation.horizontalBarChart({ id: "convergence", title: "Cross-owner convergence", description: "Number of cross-cutting patterns established by each owner combination.", items: analytics.convergence_counts, note: "A convergence count reflects separately attributed owners supporting one pattern." }));
  if (array(health.commands).length) chart("Verification duration", presentation.horizontalBarChart({ id: "verification-duration", title: "Verification command duration", description: "Elapsed duration for each recorded verification command.", items: health.commands.map(command => ({ label: `${command.kind} · ${command.command}`, value: command.elapsed_seconds })), unit: "s", note: "Skipped commands show as not scored/unavailable rather than zero work." }), "rp-half");

  const ownerSummaries = array(synthesis.owner_summaries).map(summary => `<article class="owner"><div class="label">${compiler.escapeHtml(shortOwner(summary.owner))}</div><h3>${compiler.escapeHtml(summary.headline || summary.owner)}</h3><ul>${escapeList(summary.details, compiler.escapeHtml)}</ul></article>`).join("");
  const patterns = array(synthesis.cross_cutting_patterns).length ? synthesis.cross_cutting_patterns.map(pattern => `<article class="pattern"><h3>${compiler.escapeHtml(pattern.title)}</h3><p>${compiler.escapeHtml(pattern.detail)}</p><div class="meta">${compiler.escapeHtml(array(pattern.owners).map(shortOwner).join(" · "))}</div></article>`).join("") : `<p class="quiet">No material cross-owner pattern was established.</p>`;
  const priorityItems = array(synthesis.top_priorities).length ? [...synthesis.top_priorities].sort((a,b) => (Number(b.priority_score) || -Infinity) - (Number(a.priority_score) || -Infinity) || Number(a.rank)-Number(b.rank)).map(item => {
    const score = typeof item.priority_score === "number" && Number.isFinite(item.priority_score) ? item.priority_score : null;
    const color = ledgerPriorityColor(score);
    const band = item.priority_band || ledgerPriorityBand(score);
    return `<article class="priority" style="--priority-color:${color}"><div class="priority-score" style="background:${color}">${compiler.escapeHtml(score === null ? "—" : presentation.formatNumber(score,0))}</div><div><div class="priority-head"><h3>${compiler.escapeHtml(item.title)}</h3><span class="priority-band" style="color:${color};border-color:${color}">${compiler.escapeHtml(band)}</span></div><p>${compiler.escapeHtml(item.why)}</p><div class="meta">${compiler.escapeHtml(shortOwner(item.owner))}${item.canonical_id ? ` · ${compiler.escapeHtml(item.canonical_id)}` : ""} · ${compiler.escapeHtml(item.disposition)}</div></div></article>`;
  }) : [];
  const priorities = priorityItems.length
    ? `<div class="priorities">${priorityItems.slice(0,5).join("")}</div>` + (priorityItems.length > 5 ? `<details class="rp-details priority-more"><summary>All ${priorityItems.length} priorities</summary><div class="rp-details-body"><div class="priorities">${priorityItems.join("")}</div></div></details>` : "")
    : `<p class="quiet">No priority was promoted.</p>`;

  const uncertainty = ["confirmed","inferred","unknown","coverage_gaps"].map(key => `<div class="uncertainty"><div class="label">${compiler.escapeHtml(key.replaceAll("_"," "))}</div><ul>${escapeList(synthesis.uncertainty?.[key], compiler.escapeHtml)}</ul></div>`).join("");
  const routing = Object.entries(synthesis.downstream_routing || {}).map(([key, values]) => `<div class="route"><div class="label">${compiler.escapeHtml(key.replaceAll("_"," "))}</div><ul>${escapeList(values, compiler.escapeHtml)}</ul></div>`).join("");

  const candidateRows = [
    ...array(health.candidates).map(candidate => ({ owner: "Health", id: candidate.candidate_id, title: candidate.title, score: candidate.priority, band: candidate.band, disposition: candidate.execution_mode || candidate.status, value: candidate.value, risk: candidate.risk })),
    ...array(integrity.candidates).map(candidate => ({ owner: "Integrity", id: candidate.candidate_id, title: candidate.title, score: candidate.priority, band: candidate.band, disposition: candidate.execution_mode || candidate.status, value: candidate.value, risk: candidate.risk })),
    ...array(architecture.candidates).map(candidate => ({ owner: "Architecture", id: candidate.candidate_id, title: candidate.title, score: candidate.priority, band: candidate.band || (candidate.score_state === "scored" ? "Scored" : "Not scored"), disposition: dispositionFromArchitecture(candidate), value: candidate.value, risk: candidate.risk })),
  ].sort((a,b) => (b.score ?? -Infinity)-(a.score ?? -Infinity) || a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id));
  const portfolio = analytics.candidate_portfolio || { shown: candidateRows.length, total: candidateRows.length, health: array(health.candidates).length, integrity: integrity.candidate_count, architecture: architecture.candidate_count };
  const portfolioNote = `Showing ${portfolio.shown} of ${portfolio.total} candidates (${portfolio.health} health, ${portfolio.integrity} integrity, ${portfolio.architecture} architecture).`;
  const trend = analytics.trend || { status: "no-comparable-prior" };
  const trendNote = trend.status === "compared" && trend.prior
    ? `<p class="quiet">Trend: compared against ${compiler.escapeHtml(trend.prior.repository_revision || trend.prior.artifact_id || "prior snapshot")}${Array.isArray(trend.deltas) && trend.deltas.length ? ` · ${trend.deltas.length} measured deltas` : ""}.</p>`
    : `<p class="quiet">Trend: ${compiler.escapeHtml(trend.status === "unavailable" ? "comparison unavailable" : "no comparable prior run")}.</p>`;
  const candidateTable = `${trendNote}<p class="quiet">${compiler.escapeHtml(portfolioNote)}</p><div class="rp-table-wrap"><table class="rp-table"><thead><tr><th>Owner</th><th>ID</th><th>Candidate</th><th class="rp-number">Priority</th><th class="rp-number">Value</th><th class="rp-number">Risk</th><th>Band / score state</th><th>Disposition</th></tr></thead><tbody>${candidateRows.length ? candidateRows.map(row => `<tr><td class="candidate-owner">${compiler.escapeHtml(row.owner)}</td><td><code>${compiler.escapeHtml(row.id)}</code></td><td>${compiler.escapeHtml(row.title)}</td><td class="rp-number ${row.score === null ? "not-scored" : ""}">${compiler.escapeHtml(numberOrText(row.score, presentation.formatNumber))}</td><td class="rp-number ${row.value === null ? "not-scored" : ""}">${compiler.escapeHtml(numberOrText(row.value, presentation.formatNumber))}</td><td class="rp-number ${row.risk === null ? "not-scored" : ""}">${compiler.escapeHtml(numberOrText(row.risk, presentation.formatNumber))}</td><td>${compiler.escapeHtml(row.band)}</td><td>${compiler.escapeHtml(row.disposition)}</td></tr>`).join("") : `<tr><td colspan="8">No candidates were produced.</td></tr>`}</tbody></table></div>`;

  const gateSeconds = array(health.commands).map(command => Number(command.elapsed_seconds)).filter(value => Number.isFinite(value));
  const gateMaxSeconds = gateSeconds.length ? Math.max(...gateSeconds) : 0;
  const gateResultClass = result => (result === "pass" ? "good" : result === "skipped" ? "off" : result === "fail" || result === "error" ? "bad" : "warn");
  const verificationTable = `<div class="rp-table-wrap"><table class="rp-table" style="min-width:620px"><thead><tr><th>Kind</th><th>Result</th><th>Command</th><th class="rp-number">Seconds</th></tr></thead><tbody>${array(health.commands).length ? health.commands.map(command => {
    const seconds = Number(command.elapsed_seconds);
    // Skipped gates render an em dash and no bar, never a zero-length bar with a number beside it.
    const observed = Number.isFinite(seconds) && command.elapsed_seconds !== null;
    const share = observed && gateMaxSeconds > 0 ? (seconds / gateMaxSeconds) * 100 : null;
    return `<tr><td>${compiler.escapeHtml(command.kind)}</td>`
      + `<td><span class="pill ${gateResultClass(command.result)}">${compiler.escapeHtml(command.result)}</span></td>`
      + `<td><code>${compiler.escapeHtml(command.command)}</code>`
      + (share === null ? "" : `<span class="gate-bar-wrap">${percentBar(share, scoreColor(100), `${compiler.escapeHtml(command.command)} duration`)}</span>`)
      + `</td>`
      + `<td class="rp-number${observed ? "" : " not-scored"}">${compiler.escapeHtml(observed ? presentation.formatNumber(seconds) : "—")}</td></tr>`;
  }).join("") : `<tr><td colspan="4">No verification commands recorded.</td></tr>`}</tbody></table></div>`;

  const performanceCharts = [];
  if (array(performance.phases).length) performanceCharts.push(`<article class="rp-chart-card rp-half"><h3>Wall-clock tasks</h3>${presentation.timelineChart({ id: "runtime-phases", title: "RIA task durations", description: "Longest recorded RIA task durations, with critical-path work ordered first.", items: performance.phases, note: "Concurrent bars are not additive wall time; use the wall-time metric for elapsed duration." })}</article>`);
  if (array(performance.tool_calls).length) performanceCharts.push(`<article class="rp-chart-card"><h3>Tool calls</h3>${presentation.horizontalBarChart({ id: "tool-calls", title: "Task tool-call count", description: "Tool-call totals recorded for the most tool-intensive RIA tasks and owners.", items: performance.tool_calls, note: "Tool-call count is workload telemetry, not a quality score." })}</article>`);
  if (array(performance.token_usage).length) performanceCharts.push(`<article class="rp-chart-card"><h3>Token usage</h3>${presentation.horizontalBarChart({ id: "token-usage", title: "Task token usage", description: "Recorded token consumption by semantic task or assessment owner.", items: performance.token_usage, note: "Token count is cost telemetry and should be interpreted with artifact reuse and task scope." })}</article>`);
  if (array(performance.cache_counts).length) performanceCharts.push(`<article class="rp-chart-card"><h3>Cache outcomes</h3>${presentation.donutChart({ id: "cache-outcomes", title: "Artifact reuse outcomes", description: "Cache state across SEI, verification, Health, Integrity, and Architecture artifacts.", items: performance.cache_counts, note: "Exact and incremental reuse avoid recomputation only when revision, engine, configuration, and contract bindings remain valid." })}</article>`);
  if (array(performance.avoided_work).length) performanceCharts.push(`<article class="rp-chart-card"><h3>Avoided work</h3>${presentation.horizontalBarChart({ id: "avoided-work", title: "Work avoided through reuse", description: "Counts of duplicate suites, owner agents, full scans, and report-only rebuilds avoided by this run.", items: performance.avoided_work, note: "These counts are recorded by the executor; they are not estimated after the run." })}</article>`);
  if (array(performance.class_concurrency).length) performanceCharts.push(`<article class="rp-chart-card"><h3>Peak class concurrency</h3>${presentation.horizontalBarChart({ id: "class-concurrency", title: "Peak executor concurrency by class", description: "Maximum observed simultaneous work by executor resource class.", items: performance.class_concurrency, note: `Overall peak concurrency: ${performance.peaks?.total_concurrency ?? "not recorded"}; READY-queue peak: ${performance.peaks?.ready_queue ?? "not recorded"}.` })}</article>`);
  if (array(performance.overlap).length) performanceCharts.push(`<article class="rp-chart-card"><h3>Useful overlap</h3>${presentation.timelineChart({ id: "runtime-overlap", title: "Pipeline overlap", description: "Measured overlap between SEI and shared verification plus the common owner-parallel window.", items: performance.overlap, note: "Overlap is elapsed time removed from the serialized critical path." })}</article>`);
  if (array(performance.task_states).length) performanceCharts.push(`<article class="rp-chart-card"><h3>Task outcomes</h3>${presentation.donutChart({ id: "task-states", title: "Execution task states", description: "Final state of every recorded task in the RIA execution graph.", items: performance.task_states, note: `Retries: ${performance.retries ?? 0}; cancellations: ${performance.cancellations ?? 0}.` })}</article>`);
  if (!performanceCharts.length) performanceCharts.push(`<p class="quiet">No structured performance telemetry was recorded for this run.</p>`);

  const ownerCards = array(input.assessment_refs).map(ref => `<article class="owner-ref"><div class="label">${compiler.escapeHtml(shortOwner(ref.owner))}</div><h3>${compiler.escapeHtml(ref.owner)}</h3><dl><div><dt>artifact</dt><dd>${compiler.escapeHtml(ref.artifact_id)}</dd></div><div><dt>sha256</dt><dd>${compiler.escapeHtml(ref.sha256)}</dd></div><div><dt>revision</dt><dd>${compiler.escapeHtml(ref.repository_revision)}</dd></div></dl></article>`).join("");
  const blockers = array(input.blockers).length ? input.blockers.map(value => `<li>${compiler.escapeHtml(value)}</li>`).join("") : `<li>All three canonical owner artifacts were byte-hash verified, revision-compatible, and normalized through their authoritative scoring/verification logic.</li>`;
  const escape = compiler.escapeHtml;
  const dimensionLabels = {
    "correctness-and-integrity": "Correctness",
    "architecture-fitness": "Architecture",
    "contracts-and-integration": "Contracts",
    "verification-readiness": "Test suite",
    "build-and-delivery": "Build",
    "maintainability-and-ownership": "Maintainability",
  };
  const boardCells = array(composite.dimensions).map(cell => {
    const grade = gradeFor(cell.score);
    const color = scoreColor(cell.score);
    const source = cell.source === "review-testing" ? "review-testing specialist sidecar"
      : cell.source === "architecture-improvement-intelligence" ? "architecture fitness"
      : "repository health lane";
    return `<article class="cell"><div class="cell-top"><span class="cell-dot" style="background:${color}"></span>`
      + `<span class="cell-owner">${escape(dimensionLabels[cell.id] || cell.id)}</span>`
      + `<span class="kind canonical">${escape(source)}</span></div>`
      + `<div class="cell-score">${escape(cell.score === null ? "Not scored" : presentation.formatNumber(cell.score))}`
      + `<small>${cell.score === null ? "" : "/100"}</small><span class="g">${escape(grade || "—")}</span></div>`
      + percentBar(cell.score, color, `${escape(dimensionLabels[cell.id] || cell.id)} score`)
      + `<div class="cell-basis">weight ${escape(String(cell.weight))}% · ${escape(source)}</div>`
      + `<div class="cell-detail">Coverage ${cell.coverage == null ? "not recorded" : escape(presentation.formatPercent(cell.coverage * 100))} · confidence ${cell.confidence == null ? "not recorded" : escape(presentation.formatPercent(cell.confidence * 100))}</div></article>`;
  }).join("");

  const dialRadius = 50;
  const dialCircumference = 2 * Math.PI * dialRadius;
  const dialDash = Math.max(0, Math.min(100, Number(composite.final_score) || 0)) / 100 * dialCircumference;
  const dial = `<svg viewBox="0 0 120 120" width="104" height="104" role="img" aria-label="Overall RIA grade ${escape(String(composite.final_grade || ""))}, weighted score ${escape(presentation.formatNumber(composite.final_score))} out of 100">`
    + `<circle cx="60" cy="60" r="${dialRadius}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="8"/>`
    + `<circle cx="60" cy="60" r="${dialRadius}" fill="none" stroke="${scoreColor(composite.final_score)}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${dialDash.toFixed(1)} ${(dialCircumference - dialDash).toFixed(1)}" transform="rotate(-90 60 60)"/>`
    + `<text x="60" y="68" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-weight="700" font-size="28" fill="#f7f9fc">${escape(String(composite.final_grade || "—"))}</text>`
    + `<text x="60" y="84" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9" fill="#8f98a6">${escape(presentation.formatNumber(composite.final_score))}/100</text></svg>`;

  const capNote = composite.binding_cap ? ` Binding cap: ${escape(composite.binding_cap.ceiling)} (${escape(composite.binding_cap.cap || "critical condition")}).` : "";
  const scoreboard = `<div class="board"><div class="board-top">`
    + `<div class="overall-score">${dial}<div><div class="label">Overall RIA score</div>`
    + `<div class="overall-number">${escape(presentation.formatNumber(composite.final_score))}<span>/100</span></div>`
    + `<div class="overall-grade">${escape(composite.final_grade)} <span>raw ${escape(composite.raw_grade)} · ${escape(presentation.formatNumber(composite.raw_score))}</span></div>`
    + `<div class="cell-detail" style="max-width:42ch">Weighted across six assessment dimensions: Correctness 25%, Architecture 20%, Contracts 15%, Test Suite 20%, Build 10%, Maintainability 10%.${capNote}</div></div></div>`
    + `<div class="board-cells">${boardCells}</div></div>`
    + `<p class="board-foot">Overall RIA is a deterministic weighted average over the six dimensions above. Dedicated Architecture Fitness and review-testing evidence replace their matching Health lanes when present; they are never added as extra weights, so the same concern is not double-counted. Letter grades use one A+ through F scale everywhere.</p></div>`;

  const laneRows = array(health.lanes).length ? health.lanes.map(lane => {
    const color = scoreColor(lane.score);
    const level = typeof lane.score === "number" && Number.isFinite(lane.score) ? (lane.score / 25).toFixed(1) : null;
    return `<div class="lane"><div><div class="lane-name">${escape(lane.id)}</div>`
      + `<div class="lane-sub">weight ${escape(String(lane.criticality_weight ?? "n/a"))}${lane.critical ? " · critical" : ""}`
      + `${level === null ? "" : ` · level ${level} of 4`}</div></div>`
      + `<div class="lane-score">${escape(numberOrText(lane.score, presentation.formatNumber))}</div>`
      + `<div>${percentBar(lane.score, color, `${escape(lane.id)} lane score`)}</div></div>`;
  }).join("") : `<div class="lane"><div class="quiet">No lane scores were carried by the bound health artifact.</div></div>`;

  const activeGrade = composite.final_grade || gradeFor(composite.final_score);
  const rubricBands = [
    { g:"A+", range:"97–100" }, { g:"A", range:"93–<97" }, { g:"A-", range:"90–<93" },
    { g:"B+", range:"87–<90" }, { g:"B", range:"83–<87" }, { g:"B-", range:"80–<83" },
    { g:"C+", range:"77–<80" }, { g:"C", range:"73–<77" }, { g:"C-", range:"70–<73" },
    { g:"D+", range:"67–<70" }, { g:"D", range:"63–<67" }, { g:"D-", range:"60–<63" },
    { g:"F", range:"<60" },
  ].map(band => `<div class="rubric-row ${band.g === activeGrade ? "on" : ""}"><b>${band.g}</b>`
    + `<span>RIA weighted composite</span><span class="rng">${escape(band.range)}</span></div>`).join("");

  const capRows = array(health.caps).length
    ? health.caps.map(cap => `<dt>${escape(cap.cap || cap.name || "cap")}</dt><dd>ceiling ${escape(String(cap.ceiling ?? "n/a"))}</dd>`).join("")
    : `<dt>no Health caps applied</dt><dd>—</dd>`;

  const rubricCards = [
    `<article class="card"><h3>RIA grade rubric</h3><div style="margin-top:12px">${rubricBands}</div>`
      + `<p class="cell-detail" style="margin-top:12px">One canonical A+ through F mapping is used for the weighted RIA score and specialist fitness scores.</p></article>`,
    `<article class="card"><h3>Composite accounting</h3><dl class="kv" style="margin-top:12px">`
      + `<dt>raw weighted score</dt><dd>${escape(presentation.formatNumber(composite.raw_score))}</dd>`
      + `<dt>raw grade</dt><dd>${escape(String(composite.raw_grade ?? "—"))}</dd>`
      + `<dt>final score</dt><dd>${escape(presentation.formatNumber(composite.final_score))}</dd>`
      + `<dt>final grade</dt><dd>${escape(String(composite.final_grade ?? "—"))}</dd>`
      + `<dt>dimension coverage</dt><dd>${escape(presentation.formatNumber(composite.assessment_coverage))}%</dd>`
      + capRows + `</dl></article>`,
    `<article class="card"><h3>Health evidence context</h3><dl class="kv" style="margin-top:12px">`
      + `<dt>Health canonical grade</dt><dd>${escape(String(health.final_grade ?? "—"))}</dd>`
      + `<dt>Health raw score</dt><dd>${escape(presentation.formatNumber(health.score))}</dd>`
      + `<dt>confidence index</dt><dd>${escape(presentation.formatNumber(health.confidence_index))}</dd>`
      + `<dt>weighted evidence coverage</dt><dd>${escape(presentation.formatPercent(health.weighted_coverage))}</dd>`
      + `<dt>evidence strength</dt><dd>${escape(presentation.formatPercent(health.evidence_strength))}</dd>`
      + `<dt>baseline</dt><dd>${escape(String(health.baseline ?? "—"))}</dd></dl></article>`,
  ].join("");

  const testingPanel = `<div class="cards">`
    + `<article class="card"><h3>Test Suite Fitness</h3><div class="fitness-big">${escape(testing ? `${presentation.formatNumber(testing.score)} · ${testing.grade}` : "Specialist sidecar not recorded")}</div>`
    + `<p class="cell-detail">${testing ? `review-testing · rubric coverage ${escape(presentation.formatPercent((testing.rubric_coverage ?? 0)*100))} · evidence confidence ${escape(presentation.formatPercent((testing.evidence_confidence ?? 0)*100))}` : "The weighted composite falls back to the canonical Health verification-readiness lane. Run review-testing to replace that lane with specialist evidence."}</p></article>`
    + `<article class="card"><h3>Coverage</h3><dl class="kv">`
    + `<dt>line</dt><dd>${coverage.line?.percent == null ? "Not measured" : `${escape(presentation.formatNumber(coverage.line.percent))}% · ${escape(String(coverage.line.covered))}/${escape(String(coverage.line.total))}`}</dd>`
    + `<dt>branch</dt><dd>${coverage.branch?.percent == null ? "Not measured" : `${escape(presentation.formatNumber(coverage.branch.percent))}% · ${escape(String(coverage.branch.covered))}/${escape(String(coverage.branch.total))}`}</dd>`
    + `<dt>changed lines</dt><dd>${coverage.changed_line?.percent == null ? "Not measured" : `${escape(presentation.formatNumber(coverage.changed_line.percent))}% · ${escape(String(coverage.changed_line.covered))}/${escape(String(coverage.changed_line.total))}`}</dd>`
    + `</dl><p class="cell-detail">Coverage is aggregated from covered/total counts; percentages are never averaged across packages and are never inferred from test count.</p></article>`
    + `<article class="card"><h3>Architecture Fitness</h3><div class="fitness-big">${architecture.fitness ? `${escape(presentation.formatNumber(architecture.fitness.score))} · ${escape(architecture.fitness.grade)}` : "Dedicated score not recorded"}</div>`
    + `<p class="cell-detail">${architecture.fitness ? `Architecture Improvement Intelligence · coverage ${escape(presentation.formatPercent(architecture.fitness.coverage*100))} · confidence ${architecture.fitness.confidence == null ? "not recorded" : escape(presentation.formatPercent(architecture.fitness.confidence*100))}` : "The weighted composite falls back to the canonical Health architecture-fitness lane. Candidate priority scores remain separate from repository architecture fitness."}</p></article>`
    + `</div>`;

  const gradePill = `<span class="grade-pill"><span class="dot" style="background:${scoreColor(composite.final_score)}"></span>`
    + `RIA ${escape(String(composite.final_grade || gradeFor(composite.final_score) || "—"))} · ${escape(presentation.formatNumber(composite.final_score))}</span>`;
  const blockerCount = array(input.blockers).length;
  const railFooter = `revision ${escape(revision.slice(0, 7))}<br />mode ${escape(input.mode || "read-only")}<br />`
    + `${blockerCount} blocker${blockerCount === 1 ? "" : "s"} open`;

  const output = args.output ? path.resolve(args.output) : workspace.reportPath(args.repo || process.cwd(), "ria", `repository-improvement-assessment-${Date.now()}.html`);
  const compiled = compiler.compileTemplate({
    template: path.join(skillRoot, "assets", "report-scaffold.html"),
    output,
    replacements: {
      "<!-- REPORT:TITLE -->": compiler.escapeHtml(`Repository Improvement Assessment — ${name}`),
      "<!-- REPORT:REPOSITORY_NAME -->": compiler.escapeHtml(name),
      "<!-- REPORT:RAIL_BRAND -->": compiler.escapeHtml(name),
      "<!-- REPORT:GRADE_PILL -->": gradePill,
      "<!-- REPORT:RAIL_FOOTER -->": railFooter,
      "<!-- REPORT:SCOREBOARD -->": scoreboard,
      "<!-- REPORT:LANE_ROWS -->": laneRows,
      "<!-- REPORT:RUBRIC_CARDS -->": rubricCards,
      "<!-- REPORT:TESTING_PANEL -->": testingPanel,
      "<!-- REPORT:REVISION -->": compiler.escapeHtml(revision),
      "<!-- REPORT:BASELINE_ID -->": compiler.escapeHtml(input.baseline_ref?.artifact_id || "unknown"),
      "<!-- REPORT:MODE -->": compiler.escapeHtml(input.mode || "read-only"),
      "<!-- REPORT:STATUS_CHIP -->": statusChip,
      "<!-- REPORT:OVERALL_CONDITION -->": compiler.escapeHtml(synthesis.overall_condition || `Overall RIA grade ${composite.final_grade} (${composite.final_score}/100)`),
      "<!-- REPORT:EXECUTIVE_SUMMARY -->": compiler.escapeHtml(synthesis.executive_summary || "No executive summary provided."),
      "<!-- REPORT:SCORE_GAUGE -->": scoreGauge,
      "<!-- REPORT:METRIC_CARDS -->": metricCards,
      "<!-- REPORT:ANALYTICS_CHARTS -->": chartCards.join(""),
      "<!-- REPORT:OWNER_SUMMARIES -->": ownerSummaries,
      "<!-- REPORT:CANDIDATE_TABLE -->": candidateTable,
      "<!-- REPORT:TOP_PRIORITIES -->": priorities,
      "<!-- REPORT:CROSS_CUTTING -->": patterns,
      "<!-- REPORT:ROUTING -->": routing,
      "<!-- REPORT:UNCERTAINTY -->": uncertainty,
      "<!-- REPORT:VERIFICATION_TABLE -->": verificationTable,
      "<!-- REPORT:PERFORMANCE_CHARTS -->": performanceCharts.join(""),
      "<!-- REPORT:OWNER_CARDS -->": ownerCards,
      "<!-- REPORT:PROVENANCE -->": compiler.escapeHtml(JSON.stringify({ baseline_ref: input.baseline_ref, engineering_intelligence_ref: input.engineering_intelligence_ref, artifact_bindings: input.artifact_bindings, provenance: input.provenance }, null, 2)),
      "<!-- REPORT:ELECTION -->": compiler.escapeHtml(JSON.stringify(input.report_election, null, 2)),
      "<!-- REPORT:PERFORMANCE_RECEIPT -->": compiler.escapeHtml(JSON.stringify(analytics.performance?.raw || { mode:"not-recorded" }, null, 2)),
      "<!-- REPORT:BLOCKERS -->": blockers,
      "/* REPORT:SHARED_PRESENTATION_CSS */": presentation.responsiveCss(),
      "/* REPORT:SHARED_PRESENTATION_SCRIPT */": presentation.progressiveScript(),
    },
  });
  const html = fs.readFileSync(output, "utf8");
  const quality = presentation.inspectResponsiveReport(html, { requireVisualization: true });
  if (!quality.ok) { fs.rmSync(output, { force:true }); throw new Error("REPORT_PRESENTATION_GATE_FAILED:" + quality.problems.join("; ")); }
  console.log(JSON.stringify({ kind: "repository-improvement-assessment-report", report_schema_version: 3, charts: chartCards.length + performanceCharts.filter(value => value.includes("data-rp-chart")).length, candidates: candidateRows.length, ...compiled }));
}

try { main(); }
catch (error) { console.error(error.stack || error); process.exitCode = 1; }
