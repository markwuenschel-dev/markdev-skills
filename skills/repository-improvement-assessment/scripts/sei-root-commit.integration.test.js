"use strict";

// composite-scoring-v3 §12 test 21 (P2), Appendix B of the agent instructions:
// a repository whose root commit is the only significant commit before HEAD
// must complete SEI and reach awaiting-owner-returns (exit 3). Before P2 the
// trend baseline emitted parent_count 0 and the run blocked (exit 2).

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const RIA = path.join(__dirname, "ria.js");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "request.example.json"), "utf8"));

function git(root, args) {
  return childProcess.execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" }).trim();
}

test("P2: the SEI root-commit regression repository reaches awaiting-owner-returns", (context) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ria-p2-"));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"));
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"p2","version":"1.0.0","scripts":{"test":"node --test"}}\n');
  fs.writeFileSync(path.join(root, "src", "math.js"), "module.exports={add:(a,b)=>a+b};\n");
  fs.writeFileSync(path.join(root, "test", "math.test.js"), "const t=require('node:test');const a=require('node:assert');t.test('add',()=>a.equal(require('../src/math.js').add(1,2),3));\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "one"]);
  fs.appendFileSync(path.join(root, "src", "math.js"), "// two\n");
  git(root, ["commit", "-qam", "two"]);
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "2");

  const request = { ...EXAMPLE, repository: { root }, verification_contract: { commands: ["node --test"] }, presentation_policy: "skip" };
  const requestPath = path.join(sandbox, "request.json");
  const outputPath = path.join(sandbox, "result.json");
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const run = childProcess.spawnSync(process.execPath, [RIA, "--request", requestPath, "--output", outputPath], { encoding: "utf8", timeout: 300000 });
  assert.doesNotMatch(run.stderr, /FAIL-TREND-BASELINE-METADATA|parent_count/);
  assert.equal(run.status, 3, run.stderr);
  const result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(result.status, "awaiting-owner-returns");
});
