#!/usr/bin/env node
// Summarise a Claude Code session log (*.jsonl) so a retro reads numbers, not the raw transcript.
// Usage: node session-stats.js <session.jsonl> [--top N]
//        node session-stats.js --find <project-dir>   (list sessions, newest first)
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

function projectsRoot() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

// Claude Code names a project's log folder after its absolute path with every non-alphanumeric char replaced by "-".
function slugFor(dir) {
  // On Windows, a Git Bash/MSYS path (/c/Users/...) names the drive C:, not a folder "c" on the current drive.
  if (process.platform === "win32") dir = dir.replace(/^\/([A-Za-z])(?=\/|$)/, (_, d) => `${d.toUpperCase()}:`);
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
}

function findSessions(dir) {
  const folder = path.join(projectsRoot(), slugFor(dir));
  if (!fs.existsSync(folder)) return { folder, sessions: [] };
  const sessions = fs
    .readdirSync(folder)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = path.join(folder, f);
      const st = fs.statSync(full);
      return { file: full, bytes: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
  return { folder, sessions };
}

function resultSize(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) return content.reduce((n, c) => n + (c && typeof c.text === "string" ? c.text.length : 0), 0);
  return 0;
}

function describeInput(name, input) {
  if (!input || typeof input !== "object") return "";
  const v = input.file_path || input.path || input.pattern || input.command || input.skill || input.url || input.query || input.description || "";
  return String(v).replace(/\s+/g, " ").slice(0, 120);
}

// Heuristic, not proof: a success claim in assistant text with no successful
// verification-like command since the last human turn. Retro treats each hit as a lead to check.
const CLAIM = /\b(all (?:the )?tests? pass(?:es|ed)?|tests? (?:are |now )?pass(?:ing|es)?|(?:everything|it|this|that) (?:now )?works|(?:is |are |now )(?:fixed|verified)|build (?:is )?(?:green|passing)|all (?:checks|gates) (?:pass|green))\b/i;
const VERIFY_CMD = /\b(test|tests|pytest|jest|vitest|mocha|check|lint|tsc|build|gate|verify|shellcheck|cargo|go test|node .*\.test\.js)\b/i;

function summarise(file, top) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const calls = new Map(); // id -> {name, target}
  const byTool = {};
  const errors = [];
  const results = [];
  const reads = {};
  const skills = [];
  const unverified = [];
  let verifiedSinceHuman = false;
  let userTurns = 0, assistantMsgs = 0, malformed = 0, firstTs = null, lastTs = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { malformed++; continue; }
    if (rec.timestamp) { firstTs = firstTs || rec.timestamp; lastTs = rec.timestamp; }
    const content = rec.message && Array.isArray(rec.message.content) ? rec.message.content : [];
    if (rec.type === "assistant") assistantMsgs++;
    if (rec.type === "user" && content.some((b) => b && b.type === "text")) { userTurns++; verifiedSinceHuman = false; }
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && rec.type === "assistant" && typeof b.text === "string") {
        const m = b.text.match(CLAIM);
        if (m && !verifiedSinceHuman) unverified.push({ claim: m[0], excerpt: b.text.replace(/\s+/g, " ").slice(Math.max(0, m.index - 60), m.index + 80) });
      } else if (b.type === "tool_use") {
        const target = describeInput(b.name, b.input);
        calls.set(b.id, { name: b.name, target });
        const t = (byTool[b.name] = byTool[b.name] || { calls: 0, errors: 0, result_chars: 0 });
        t.calls++;
        if (b.name === "Read" && target) reads[target] = (reads[target] || 0) + 1;
        if (b.name === "Skill" && target) skills.push(target);
      } else if (b.type === "tool_result") {
        const call = calls.get(b.tool_use_id) || { name: "unknown", target: "" };
        const size = resultSize(b.content);
        const t = (byTool[call.name] = byTool[call.name] || { calls: 0, errors: 0, result_chars: 0 });
        t.result_chars += size;
        results.push({ tool: call.name, target: call.target, chars: size });
        if (!b.is_error && call.name === "Bash" && VERIFY_CMD.test(call.target)) verifiedSinceHuman = true;
        if (b.is_error) {
          t.errors++;
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          errors.push({ tool: call.name, target: call.target, message: String(text).replace(/\s+/g, " ").slice(0, 200) });
        }
      }
    }
  }

  const totalChars = results.reduce((n, r) => n + r.chars, 0);
  return {
    file: path.basename(file),
    span: { first: firstTs, last: lastTs },
    user_turns: userTurns,
    assistant_messages: assistantMsgs,
    malformed_lines: malformed,
    tool_calls: calls.size,
    tool_result_chars: totalChars,
    est_tool_result_tokens: Math.ceil(totalChars / 4),
    by_tool: Object.fromEntries(Object.entries(byTool).sort((a, b) => b[1].result_chars - a[1].result_chars)),
    largest_results: results.sort((a, b) => b.chars - a.chars).slice(0, top),
    errors: errors.slice(0, top),
    error_count: errors.length,
    repeated_reads: Object.entries(reads).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, top).map(([file, n]) => ({ file, reads: n })),
    skills_invoked: skills,
    unverified_claims: { method: "heuristic", count: unverified.length, items: unverified.slice(0, top) },
  };
}

function main(argv) {
  const topIdx = argv.indexOf("--top");
  const top = topIdx >= 0 ? Number(argv[topIdx + 1]) || 10 : 10;
  if (argv[0] === "--find") {
    process.stdout.write(JSON.stringify(findSessions(argv[1] || process.cwd()), null, 2) + "\n");
    return 0;
  }
  const file = argv[0];
  if (!file || !fs.existsSync(file)) {
    process.stderr.write("usage: session-stats.js <session.jsonl> [--top N] | --find <project-dir>\n");
    return 2;
  }
  process.stdout.write(JSON.stringify(summarise(file, top), null, 2) + "\n");
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { summarise, findSessions, slugFor };
