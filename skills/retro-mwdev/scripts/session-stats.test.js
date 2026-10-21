"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { summarise, slugFor } = require("./session-stats.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-"));
const file = path.join(dir, "s.jsonl");
const rec = (o) => JSON.stringify(o);
fs.writeFileSync(file, [
  rec({ type: "user", timestamp: "t1", message: { content: [{ type: "text", text: "go" }] } }),
  rec({ type: "assistant", message: { content: [
    { type: "tool_use", id: "a", name: "Read", input: { file_path: "src/x.ts" } },
    { type: "tool_use", id: "b", name: "Read", input: { file_path: "src/x.ts" } },
    { type: "tool_use", id: "c", name: "Bash", input: { command: "npm test" } },
    { type: "tool_use", id: "d", name: "Skill", input: { skill: "land-pr" } },
  ] } }),
  rec({ type: "user", timestamp: "t2", message: { content: [
    { type: "tool_result", tool_use_id: "a", content: "x".repeat(40) },
    { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "y".repeat(8) }] },
    { type: "tool_result", tool_use_id: "c", content: "FAIL boom", is_error: true },
  ] } }),
  "not json",
  "",
].join("\n"));

const s = summarise(file, 5);
assert.strictEqual(s.user_turns, 1, "tool_result-only user records are not turns");
assert.strictEqual(s.tool_calls, 4);
assert.strictEqual(s.malformed_lines, 1);
assert.strictEqual(s.by_tool.Read.result_chars, 48);
assert.strictEqual(s.error_count, 1);
assert.strictEqual(s.errors[0].tool, "Bash");
assert.deepStrictEqual(s.repeated_reads, [{ file: "src/x.ts", reads: 2 }]);
assert.deepStrictEqual(s.skills_invoked, ["land-pr"]);
assert.strictEqual(s.largest_results[0].chars, 40);
// Claude Code slugs the absolute path, so the drive letter is part of it on Windows.
if (process.platform === "win32") {
  assert.strictEqual(slugFor("C:\\Users\\me\\my.repo"), "C--Users-me-my-repo");
  assert.strictEqual(slugFor("/c/Users/me/my.repo"), "C--Users-me-my-repo", "Git Bash path maps to the same slug");
}
else assert.strictEqual(slugFor("/home/me/my.repo"), "-home-me-my-repo");

// unverified-claim heuristic
const f2 = path.join(dir, "claims.jsonl");
fs.writeFileSync(f2, [
  rec({ type: "user", message: { content: [{ type: "text", text: "fix it" }] } }),
  rec({ type: "assistant", message: { content: [{ type: "text", text: "Done, all tests pass now." }] } }),
  rec({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }),
  rec({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  rec({ type: "assistant", message: { content: [{ type: "text", text: "Verified: tests are passing." }] } }),
  rec({ type: "user", message: { content: [{ type: "text", text: "and the other one?" }] } }),
  rec({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } }),
  rec({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "FAIL", is_error: true }] } }),
  rec({ type: "assistant", message: { content: [{ type: "text", text: "That works now." }] } }),
].join("\n"));
const s2 = summarise(f2, 5);
assert.strictEqual(s2.unverified_claims.method, "heuristic");
assert.strictEqual(s2.unverified_claims.count, 2, "claim before any test, and claim after a failed test");
assert.match(s2.unverified_claims.items[0].claim, /all tests pass/i);
assert.match(s2.unverified_claims.items[1].claim, /works/i);
assert.strictEqual(s.unverified_claims.count, 0);
console.log("session-stats: all assertions passed");
