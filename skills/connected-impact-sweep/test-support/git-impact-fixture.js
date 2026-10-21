"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function command(root, args) { return String(execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })).trim(); }

function createImpactFixture(input, contentByPath = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connected-impact-git-"));
  command(root, ["init", "-q"]);
  command(root, ["config", "user.email", "impact-fixture@example.invalid"]);
  command(root, ["config", "user.name", "Impact Fixture"]);
  fs.writeFileSync(path.join(root, ".fixture"), "base\n");
  command(root, ["add", ".fixture"]);
  command(root, ["commit", "-q", "-m", "base"]);
  const base = command(root, ["rev-parse", "HEAD"]);
  for (const change of input.changes) {
    const target = path.join(root, ...change.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contentByPath[change.path] || "const internalImplementation = true;\n");
  }
  command(root, ["add", "--all"]);
  command(root, ["commit", "-q", "-m", "change"]);
  const revision = command(root, ["rev-parse", "HEAD"]);
  return Object.freeze({ root, base, revision, input: { ...input, repository_root: root, base_revision: base, repository_revision: revision } });
}

module.exports = Object.freeze({ createImpactFixture });
