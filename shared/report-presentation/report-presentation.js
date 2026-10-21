"use strict";

const crypto = require("node:crypto");

const PALETTE = Object.freeze([
  "#4338ca", "#0b8f48", "#d97706", "#c93838", "#2563eb", "#7c3aed", "#0891b2", "#64748b"
]);

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

// P1 (composite-scoring-v3 §3): same semantics as shared/ria-scoring finiteOrNull.
// Kept local because this module sits in SEI's declared dependency closure, which
// does not include shared/ria-scoring; report-presentation.test.js pins parity.
const DECIMAL_NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function finite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!DECIMAL_NUMERIC.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value, digits = 1) {
  const number = finite(value);
  if (number === null) return "Not scored";
  return Number.isInteger(number) ? String(number) : number.toFixed(digits).replace(/\.0+$/, "");
}

function formatPercent(value, digits = 1) {
  const number = finite(value);
  return number === null ? "Unavailable" : `${formatNumber(number, digits)}%`;
}

function safeId(value) {
  return String(value || "chart").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "chart";
}

function hashId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
}

function responsiveCss() {
  return `
/* shared/report-presentation@1 — responsive, zero-network analytical reports */
:root {
  --rp-canvas-max: 3000px;
  --rp-gutter: clamp(12px, 2.2vw, 48px);
  --rp-gap: clamp(12px, 1.25vw, 24px);
  --rp-radius: 16px;
  --rp-prose: 82ch;
}
html { text-size-adjust: 100%; }
body { overflow-x: hidden; }
.rp-shell {
  width: min(var(--rp-canvas-max), calc(100vw - (2 * var(--rp-gutter))));
  margin-inline: auto;
  container-type: inline-size;
  container-name: report;
}
.rp-grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:var(--rp-gap); align-items:start; }
.rp-span-12 { grid-column:span 12; }
.rp-span-8 { grid-column:span 8; }
.rp-span-6 { grid-column:span 6; }
.rp-span-4 { grid-column:span 4; }
.rp-span-3 { grid-column:span 3; }
.rp-prose { max-width:var(--rp-prose); }
.rp-card { min-width:0; border-radius:var(--rp-radius); }
.rp-metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:clamp(10px,1vw,18px); }
.rp-metric { min-width:0; padding:16px; border:1px solid var(--line,rgba(127,127,127,.25)); border-radius:13px; background:color-mix(in srgb,var(--surface,#fff) 94%,transparent); }
.rp-metric-label { font:600 10px/1.4 var(--mono,ui-monospace,monospace); text-transform:uppercase; letter-spacing:.09em; color:var(--muted,#6b7280); }
.rp-metric-value { margin-top:7px; font:700 clamp(22px,2.3vw,36px)/1 var(--serif,Georgia,serif); font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.rp-metric-note { margin-top:6px; font:12px/1.45 var(--sans,system-ui,sans-serif); color:var(--ink2,#555); }
.rp-chart-grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:var(--rp-gap); }
.rp-chart-card { grid-column:span 6; min-width:0; overflow:hidden; }
.rp-chart-card.rp-wide { grid-column:1/-1; }
.rp-chart-wrap { width:100%; min-width:0; overflow-x:auto; overscroll-behavior-inline:contain; }
.rp-chart { display:block; width:100%; height:auto; min-width:420px; overflow:visible; }
.rp-chart text { font-family:var(--sans,system-ui,sans-serif); }
.rp-chart .rp-label { fill:var(--ink2,#555); font-size:12px; }
.rp-chart .rp-value { fill:var(--ink,#111); font:600 11px var(--mono,ui-monospace,monospace); }
.rp-chart .rp-track { fill:color-mix(in srgb,var(--line,#ddd) 52%,transparent); }
.rp-chart .rp-axis { stroke:var(--line,#ddd); stroke-width:1; }
.rp-chart-note { margin:7px 0 0; max-width:var(--rp-prose); color:var(--muted,#777); font:12px/1.45 var(--sans,system-ui,sans-serif); }
.rp-table-wrap { overflow:auto; max-width:100%; border:1px solid var(--line,#ddd); border-radius:12px; }
.rp-table { width:100%; min-width:780px; border-collapse:collapse; font-variant-numeric:tabular-nums; }
.rp-table th,.rp-table td { padding:10px 12px; border-top:1px solid var(--line,#ddd); text-align:left; vertical-align:top; }
.rp-table th { position:sticky; top:0; z-index:1; background:var(--surface,#fff); font:600 10px/1.35 var(--mono,ui-monospace,monospace); text-transform:uppercase; letter-spacing:.08em; color:var(--muted,#777); }
.rp-table td.rp-number,.rp-table th.rp-number { text-align:right; }
.rp-pill { display:inline-flex; align-items:center; gap:5px; border:1px solid currentColor; border-radius:999px; padding:3px 8px; font:600 10px/1.35 var(--mono,ui-monospace,monospace); }
.rp-legend { display:flex; flex-wrap:wrap; gap:8px 14px; margin-top:10px; }
.rp-legend-item { display:inline-flex; align-items:center; gap:6px; color:var(--ink2,#555); font:11px/1.35 var(--sans,system-ui,sans-serif); }
.rp-swatch { width:10px; height:10px; border-radius:3px; background:var(--swatch); }
.rp-details { border:1px solid var(--line,#ddd); border-radius:12px; overflow:clip; }
.rp-details summary { cursor:pointer; padding:12px 14px; font-weight:650; }
.rp-details[open] summary { border-bottom:1px solid var(--line,#ddd); }
.rp-details-body { padding:14px; }
@container report (min-width: 1180px) {
  .rp-chart-card { grid-column:span 4; }
  .rp-chart-card.rp-half { grid-column:span 6; }
  .rp-chart-card.rp-wide { grid-column:1/-1; }
}
@container report (min-width: 1540px) {
  .rp-ultra-3 { grid-column:span 4; }
  .rp-ultra-4 { grid-column:span 3; }
  .rp-chart-card.rp-half { grid-column:span 6; }
}
@container report (min-width: 2000px) {
  .rp-chart-card { grid-column:span 3; }
  .rp-chart-card.rp-half { grid-column:span 6; }
  .rp-chart-card.rp-wide { grid-column:1/-1; }
}
@media (max-width: 980px) {
  .rp-span-8,.rp-span-6,.rp-span-4,.rp-span-3,.rp-chart-card { grid-column:1/-1; }
}
@media (max-width: 620px) {
  :root { --rp-gutter:10px; --rp-gap:10px; }
  .rp-chart { min-width:360px; }
  .rp-metric { padding:13px; }
}
@media print {
  :root { --rp-canvas-max:none; --rp-gutter:0px; }
  .rp-shell { width:100%; }
  .rp-card,.rp-chart-card,.rp-metric { break-inside:avoid; box-shadow:none!important; }
  .rp-chart-wrap,.rp-table-wrap { overflow:visible; }
}
`;
}

function progressiveScript() {
  return `
(() => {
  document.documentElement.dataset.reportResponsive = "1";
  const wide = window.matchMedia("(min-width: 1500px)");
  const apply = () => document.documentElement.dataset.reportDensity = wide.matches ? "wide" : "standard";
  apply();
  if (typeof wide.addEventListener === "function") wide.addEventListener("change", apply);
})();
`;
}

function chartShell({ id, title, description, svg, note = "", className = "" }) {
  const safe = safeId(id || `${title}-${hashId(description)}`);
  return `<div class="rp-chart-wrap" data-rp-chart="${escapeHtml(safe)}"><svg class="rp-chart" viewBox="0 0 760 ${escapeHtml(svg.height)}" role="img" aria-labelledby="${safe}-title ${safe}-desc"><title id="${safe}-title">${escapeHtml(title)}</title><desc id="${safe}-desc">${escapeHtml(description)}</desc>${svg.body}</svg></div>${note ? `<p class="rp-chart-note ${escapeHtml(className)}">${escapeHtml(note)}</p>` : ""}`;
}

function horizontalBarChart({ id, title, description, items = [], max = null, unit = "", note = "", valueFormatter = null }) {
  const normalized = items.map((item, index) => ({
    label: String(item.label ?? item.id ?? `Item ${index + 1}`),
    value: finite(item.value),
    color: item.color || PALETTE[index % PALETTE.length],
    state: item.state || null
  }));
  const observed = normalized.filter(item => item.value !== null).map(item => item.value);
  const maximum = finite(max) ?? Math.max(1, ...observed, 1);
  const row = 32;
  const height = Math.max(96, 42 + normalized.length * row);
  const x = 250;
  const width = 400;
  const body = normalized.map((item, index) => {
    const y = 25 + index * row;
    const amount = item.value === null ? 0 : clamp(item.value / maximum, 0, 1) * width;
    const value = item.value === null ? "Not scored" : (valueFormatter ? valueFormatter(item.value) : `${formatNumber(item.value)}${unit}`);
    return `<text class="rp-label" x="8" y="${y + 12}">${escapeHtml(item.label.slice(0, 36))}</text><rect class="rp-track" x="${x}" y="${y}" width="${width}" height="15" rx="5"/>${item.value === null ? "" : `<rect x="${x}" y="${y}" width="${Math.max(2, amount)}" height="15" rx="5" fill="${escapeHtml(item.color)}"><title>${escapeHtml(`${item.label}: ${value}`)}</title></rect>`}<text class="rp-value" x="${x + width + 12}" y="${y + 12}">${escapeHtml(value)}</text>`;
  }).join("");
  const empty = normalized.length ? "" : `<text class="rp-label" x="8" y="36">No quantitative values available</text>`;
  return chartShell({ id, title, description, note, svg: { height, body: `${empty}${body}` } });
}

function stackedBarChart({ id, title, description, items = [], total = null, note = "" }) {
  const normalized = items.map((item, index) => ({ label: String(item.label ?? item.id ?? `Item ${index + 1}`), value: Math.max(0, finite(item.value) ?? 0), color: item.color || PALETTE[index % PALETTE.length] }));
  const sum = normalized.reduce((acc, item) => acc + item.value, 0);
  const denominator = Math.max(1, finite(total) ?? sum);
  let x = 30;
  const width = 700;
  const segments = normalized.map(item => {
    const segment = width * item.value / denominator;
    const element = segment <= 0 ? "" : `<rect x="${x}" y="28" width="${Math.max(1, segment)}" height="34" fill="${escapeHtml(item.color)}"><title>${escapeHtml(`${item.label}: ${formatNumber(item.value)}`)}</title></rect>`;
    x += segment;
    return element;
  }).join("");
  const legend = normalized.map((item, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    return `<rect x="${30 + col * 235}" y="${86 + row * 28}" width="10" height="10" rx="2" fill="${escapeHtml(item.color)}"/><text class="rp-label" x="${46 + col * 235}" y="${95 + row * 28}">${escapeHtml(item.label.slice(0, 23))}</text><text class="rp-value" x="${230 + col * 235}" y="${95 + row * 28}" text-anchor="end">${escapeHtml(formatNumber(item.value))}</text>`;
  }).join("");
  const height = Math.max(130, 118 + Math.ceil(normalized.length / 3) * 28);
  return chartShell({ id, title, description, note, svg: { height, body: `<rect class="rp-track" x="30" y="28" width="700" height="34" rx="7"/>${segments}${legend}` } });
}

function donutChart({ id, title, description, items = [], note = "" }) {
  const normalized = items.map((item, index) => ({ label: String(item.label ?? item.id ?? `Item ${index + 1}`), value: Math.max(0, finite(item.value) ?? 0), color: item.color || PALETTE[index % PALETTE.length] }));
  const total = normalized.reduce((sum, item) => sum + item.value, 0);
  const radius = 74;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const circles = normalized.map(item => {
    const fraction = total > 0 ? item.value / total : 0;
    const dash = circumference * fraction;
    const circle = dash <= 0 ? "" : `<circle cx="145" cy="116" r="${radius}" fill="none" stroke="${escapeHtml(item.color)}" stroke-width="28" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 145 116)"><title>${escapeHtml(`${item.label}: ${formatNumber(item.value)}`)}</title></circle>`;
    offset += dash;
    return circle;
  }).join("");
  const legend = normalized.map((item, index) => `<rect x="285" y="${48 + index * 29}" width="11" height="11" rx="2" fill="${escapeHtml(item.color)}"/><text class="rp-label" x="304" y="${58 + index * 29}">${escapeHtml(item.label.slice(0, 28))}</text><text class="rp-value" x="620" y="${58 + index * 29}" text-anchor="end">${escapeHtml(formatNumber(item.value))}</text>`).join("");
  const body = `<circle cx="145" cy="116" r="${radius}" fill="none" class="rp-track" stroke-width="28"/>${circles}<text class="rp-value" x="145" y="112" text-anchor="middle" style="font-size:28px">${escapeHtml(formatNumber(total, 0))}</text><text class="rp-label" x="145" y="133" text-anchor="middle">total</text>${legend}`;
  return chartShell({ id, title, description, note, svg: { height: Math.max(240, 82 + normalized.length * 29), body } });
}

function timelineChart({ id, title, description, items = [], note = "" }) {
  const normalized = items.map((item, index) => ({ label: String(item.label ?? item.id ?? `Phase ${index + 1}`), value: Math.max(0, finite(item.value) ?? 0), color: item.color || PALETTE[index % PALETTE.length] }));
  const maximum = Math.max(1, ...normalized.map(item => item.value));
  return horizontalBarChart({
    id, title, description, items: normalized, max: maximum, note,
    valueFormatter: value => value >= 60000 ? `${formatNumber(value / 60000, 1)}m` : value >= 1000 ? `${formatNumber(value / 1000, 1)}s` : `${formatNumber(value, 0)}ms`
  });
}

function scoreGauge({ id, title, description, score, grade = null, note = "", color = "#4338ca" }) {
  const value = finite(score);
  const bounded = value === null ? 0 : clamp(value, 0, 100);
  const radius = 82;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * bounded / 100;
  const body = `<circle cx="190" cy="128" r="${radius}" fill="none" class="rp-track" stroke-width="26"/><circle cx="190" cy="128" r="${radius}" fill="none" stroke="${escapeHtml(color)}" stroke-width="26" stroke-linecap="round" stroke-dasharray="${dash} ${circumference - dash}" transform="rotate(-90 190 128)"/><text class="rp-value" x="190" y="126" text-anchor="middle" style="font-size:34px">${escapeHtml(value === null ? "—" : formatNumber(value))}</text><text class="rp-label" x="190" y="149" text-anchor="middle">${escapeHtml(grade ? `grade ${grade}` : value === null ? "not scored" : "out of 100")}</text>`;
  return chartShell({ id, title, description, note, svg: { height: 260, body } });
}

function metricCard({ label, value, note = "", className = "" }) {
  return `<article class="rp-metric ${escapeHtml(className)}"><div class="rp-metric-label">${escapeHtml(label)}</div><div class="rp-metric-value">${escapeHtml(value)}</div>${note ? `<div class="rp-metric-note">${escapeHtml(note)}</div>` : ""}</article>`;
}

function assertNoViewTimeNetwork(html) {
  const problems = [];
  const source = String(html || "");
  if (/(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(source)) problems.push("runtime network reference found");
  if (/url\(\s*["']?\s*https?:\/\//i.test(source)) problems.push("runtime network CSS URL found");
  return { ok: problems.length === 0, problems };
}

function inspectResponsiveReport(html, { requireVisualization = false } = {}) {
  const source = String(html || "");
  const problems = [];
  if (!/<meta\s+name=["']viewport["']/i.test(source)) problems.push("viewport metadata missing");
  if (!/data-report-responsive=["']1["']/i.test(source)) problems.push("responsive report marker missing");
  if (!/class=["'][^"']*\brp-shell\b/i.test(source)) problems.push("shared responsive shell missing");
  if (requireVisualization && !/data-rp-chart=/i.test(source)) problems.push("quantitative report has no visualization");
  problems.push(...assertNoViewTimeNetwork(source).problems);
  return { ok: problems.length === 0, problems };
}

module.exports = {
  PALETTE, escapeHtml, finite, clamp, formatNumber, formatPercent, safeId,
  responsiveCss, progressiveScript, horizontalBarChart, stackedBarChart,
  donutChart, timelineChart, scoreGauge, metricCard,
  assertNoViewTimeNetwork, inspectResponsiveReport
};
