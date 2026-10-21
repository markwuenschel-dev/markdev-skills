#!/usr/bin/env node
// Structural check for a PR body written by pr-mwdev. Proves shape only, never truth.
// Usage: node check-pr-body.js [--caller land-pr|flywheel] [--repo <dir>] <body.md | ->
//   --caller  also enforce that caller's contract (see pr-mwdev SKILL.md, Caller contracts)
//   --repo    resolve cited gate-runner receipts under <dir> and require the table status to match
// exit 0 = ok, 1 = errors, 2 = usage
"use strict";
const fs = require("fs");
const path = require("path");

const REQUIRED = ["Summary", "Evidence", "Merge Danger"];
const OPTIONAL = ["Out of scope"];
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED-UNVERIFIABLE", "SKIPPED", "NOT RUN"]);
const RECEIPT = /\.agentic\/gate-evidence\/[^\s|`]+\/receipt\.json/;
const PLACEHOLDER = /<(one sentence|one visual|failing test|passing test|command or check|caller evidence|the reason|one word|consumers or surfaces|deliberately excluded|outcome)[^>]*>/i;

function receiptOutcome(repo, rel) {
  const file = path.resolve(repo, rel);
  if (!file.startsWith(path.resolve(repo) + path.sep)) return { error: `receipt path escapes repo: ${rel}` };
  if (!fs.existsSync(file)) return { error: `cited receipt not found: ${rel}` };
  let r;
  try { r = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { error: `cited receipt is not JSON: ${rel}` }; }
  r = r && r.gate_receipt ? r.gate_receipt : r;
  if (!r || typeof r.outcome !== "string") return { error: `cited receipt has no outcome: ${rel}` };
  return { outcome: r.outcome, fresh: r.fresh };
}

function check(md, opts = {}) {
  const errors = [];
  const text = md.replace(/\r/g, "");
  // Ignore headings inside fenced blocks.
  const lines = text.split("\n");
  const sections = [];
  let fence = null;
  for (const line of lines) {
    const f = line.match(/^(```+|~~~+)/);
    if (f) { if (!fence) fence = f[1]; else if (line.startsWith(fence)) fence = null; }
    const h = !fence && line.match(/^##\s+(.+?)\s*$/);
    if (h) sections.push({ name: h[1], body: [] });
    else if (sections.length) sections[sections.length - 1].body.push(line);
  }
  const names = sections.map((s) => s.name);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) errors.push(`duplicate heading: ${n}`);
  for (const n of names) if (!REQUIRED.includes(n) && !OPTIONAL.includes(n)) errors.push(`unexpected heading: ${n}`);
  const order = names.filter((n) => REQUIRED.includes(n));
  for (const r of REQUIRED) if (!names.includes(r)) errors.push(`missing heading: ${r}`);
  if (order.join("|") !== REQUIRED.filter((r) => names.includes(r)).join("|")) errors.push(`headings out of order: ${order.join(", ")}`);
  if (names.includes("Out of scope") && names.indexOf("Out of scope") < names.indexOf("Merge Danger")) errors.push("Out of scope must follow Merge Danger");
  for (const s of sections) if (!s.body.join("\n").trim()) errors.push(`empty section: ${s.name}`);

  const get = (n) => (sections.find((s) => s.name === n) || { body: [] }).body.join("\n");
  const ev = get("Evidence");
  const evidenceRows = [];
  if (ev && !(/\*\*Before:\*\*/.test(ev) && /\*\*After:\*\*/.test(ev)) && !/No before\/after captured/.test(ev)) errors.push("Evidence needs **Before:** and **After:**, or 'No before/after captured'");
  for (const row of ev.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l))) {
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    const last = cells[cells.length - 1];
    if (cells.length < 3 || last === "Status") continue;
    if (!STATUSES.has(last)) { errors.push(`invalid status '${last}' (use PASS, FAIL, BLOCKED-UNVERIFIABLE, SKIPPED, NOT RUN)`); continue; }
    evidenceRows.push(cells);
    const cited = row.match(RECEIPT);
    if (cited && opts.repo) {
      const r = receiptOutcome(opts.repo, cited[0]);
      if (r.error) errors.push(r.error);
      else if (r.outcome !== last) errors.push(`status '${last}' contradicts receipt outcome '${r.outcome}' (${cited[0]})`);
      else if (r.fresh === false && last === "PASS") errors.push(`receipt is stale, so PASS is unsupported (${cited[0]})`);
    }
  }
  const md2 = get("Merge Danger");
  const door = md2.match(/\*\*Door:\*\*\s*([a-z-]+)/i);
  if (!door) errors.push("Merge Danger needs **Door:**");
  else if (!["one-way", "two-way", "unknown"].includes(door[1].toLowerCase())) errors.push(`invalid door '${door[1]}'`);
  const br = md2.match(/\*\*Blast Radius:\*\*[ \t]*(\S.*)?/i);
  if (!br || !br[1]) errors.push("Merge Danger needs a non-empty **Blast Radius:**");
  if (PLACEHOLDER.test(text)) errors.push(`unfilled placeholder: ${text.match(PLACEHOLDER)[0]}`);

  if (opts.caller === "land-pr") {
    if (!evidenceRows.length) errors.push("land-pr: Evidence needs a status table with at least one validation command");
  } else if (opts.caller === "flywheel") {
    if (!/machine verdict authori[sz]es review, not merge/i.test(text)) errors.push("flywheel: missing the human-gate line (the machine verdict authorizes review, not merge)");
    if (!/packet_lock_sha256/.test(ev)) errors.push("flywheel: Evidence needs the verification block (packet_lock_sha256 not found)");
    if (!/tamper_evidence/.test(ev)) errors.push("flywheel: verification block needs tamper_evidence");
  }
  return errors;
}

function main(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--caller") opts.caller = argv[++i];
    else if (argv[i] === "--repo") opts.repo = argv[++i];
    else rest.push(argv[i]);
  }
  const usage = "usage: check-pr-body.js [--caller land-pr|flywheel] [--repo <dir>] <body.md | ->\n";
  if (rest.length !== 1 || (opts.caller && !["land-pr", "flywheel"].includes(opts.caller)) || (opts.repo !== undefined && !fs.existsSync(opts.repo))) {
    process.stderr.write(usage); return 2;
  }
  const md = rest[0] === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(rest[0], "utf8");
  const errors = check(md, opts);
  for (const e of errors) process.stderr.write(`ERROR ${e}\n`);
  if (!errors.length) process.stdout.write("OK pr body structure\n");
  return errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { check };
