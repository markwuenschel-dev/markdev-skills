"use strict";

const assert = require("node:assert/strict");
const child = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const skillRoot = path.resolve(__dirname, ".."), skillsRoot = path.resolve(skillRoot, "..");
const script = path.join(skillRoot, "assets", "write-ledger.js"), input = path.join(skillsRoot, "shared", "candidate-ledger-spine", "canonical-ledger.json");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-assessment-"));
try {
  child.execFileSync("git", ["init", "--quiet", repo]);
  fs.mkdirSync(path.join(repo, "src"));
  const sentinel = path.join(repo, "src", "sentinel.txt");
  fs.writeFileSync(sentinel, "source remains unchanged\n");
  child.execFileSync("git", ["-C", repo, "add", "src/sentinel.txt"]);
  child.execFileSync("git", ["-C", repo, "-c", "user.name=Codex Test", "-c", "user.email=codex@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const before = fs.readFileSync(sentinel, "utf8");
  const output = JSON.parse(child.execFileSync(process.execPath, [script, "--repo", repo, "--input", input], { encoding: "utf8" }));
  assert.ok(output.path.startsWith(path.join(repo, ".project-intelligence", "assessments", "integrity")));
  assert.equal(output.owner, "codebase-integrity-audit-loop");
  assert.match(output.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), before);
  assert.equal(child.execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), "");
  const forbidden = child.spawnSync(process.execPath, [script, "--repo", repo, "--input", input, "--output", path.join(repo, "src", "forbidden.json")], { encoding: "utf8" });
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /ARTIFACT_PATH_FORBIDDEN/);
  assert.equal(fs.existsSync(path.join(repo, "src", "forbidden.json")), false);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log("GREEN integrity assessment mutation boundary: tracked tree unchanged; only designated runtime artifacts written");
