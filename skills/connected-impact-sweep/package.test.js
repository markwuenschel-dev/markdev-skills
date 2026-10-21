"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createImpactFixture } = require("./test-support/git-impact-fixture");

const root = __dirname;

function listFiles(directory, relative = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(directory, entry.name), childRelative) : [childRelative];
  }).sort();
}

test("manifest inventories the complete explicit gate package", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "MANIFEST.json"), "utf8"));
  assert.equal(manifest.name, "connected-impact-sweep");
  assert.equal(manifest.entrypoint, "SKILL.md");
  assert.deepEqual([...manifest.owned_files].sort(), listFiles(root));
});

test("model shell is explicit-only, bounded, and points to conditional procedures", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "MANIFEST.json"), "utf8"));
  const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  const body = skill.replace(/^---[\s\S]*?---\s*/, "");
  const words = body.match(/\S+/g) ?? [];
  assert.ok(words.length >= 220 && words.length <= 375, `model shell words=${words.length}`);
  assert.doesNotMatch(skill, /whenever asked to edit|every edit, no exceptions/i);
  const policy = JSON.parse(fs.readFileSync(path.join(root, "context-policy.json"), "utf8"));
  assert.equal(policy.schema_version, 2);
  assert.deepEqual(policy.core, ["SKILL.md"]);
  for (const entry of Object.values(policy.conditional)) {
    assert.ok(entry.condition_ids.length > 0);
    for (const ref of entry.refs) assert.equal(fs.statSync(path.join(root, ref)).isFile(), true);
  }
  const metadata = fs.readFileSync(path.join(root, "openai.yaml"), "utf8");
  assert.match(metadata, /allow_implicit_invocation: false/);
  assert.match(skill, /disable-model-invocation:\s*true/);
  assert.equal(manifest.invocation, "explicit-only");
  const Registry = require("../shared/capability-registry/registry");
  const registered = Registry.discover(path.resolve(root, "..")).packages.find((item) => item.name === "connected-impact-sweep");
  assert.equal(registered.invocation_mode, "explicit-only");
  assert.equal(registered.operational_status, "explicit-only");
});

test("direct gate runner accepts JSON and returns the frozen API envelope", () => {
  const fixture = createImpactFixture({
      repository_revision: "direct",
      changes: [{ path: "src/local.js", component: "core", signals: [] }],
  });
  try {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "run-impact-gate.js")], { encoding: "utf8", input: JSON.stringify(fixture.input), windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schema_version, "connected-impact-gate@2");
    assert.equal(output.level, "skip");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
