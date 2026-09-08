"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBaseline, canonicalBytes, verifyBaseline, writeBaseline } = require("../baseline.js");
const { deriveCompatibilityBinding } = require("./compatibility-binding.js");

function git(root, args) { return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function makeGit(parent, name) {
  const root = path.join(parent, name); fs.mkdirSync(root, { recursive: true }); git(root, ["init"]); git(root, ["config", "user.email", "ria@example.invalid"]); git(root, ["config", "user.name", "RIA Test"]); fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src", "index.js"), "module.exports = 1;\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "fixture"]); return root;
}
function request(roots, extra = {}) {
  return {
    repository: { roots },
    durable_mode: "git",
    generated_protected_paths: [{ kind: "exact-existing", path: "src", root_index: 0 }, { kind: "allowed-absent-generated", path: "dist", root_index: 0 }, { kind: "pattern", path: "coverage/**", root_index: 0 }],
    command_authorization: { state: "inherited", inherited_from: "caller:fixture", authorization_ref: "auth:fixture", commands: ["test"] },
    verification_contract: { commands: ["node --test"] },
    sei_compatibility_binding: deriveCompatibilityBinding({ engine_version: "1.3.0", effective_configuration: { profile: "standard" }, execution_contract: { version: 2 }, history_window: { kind: "full" }, analyzer_capabilities: { git: true } }),
    environment_toolchain: { node: process.version }, provenance: { builder: "test" }, ...extra,
  };
}

test("builds deterministic Git and multi-root baselines with closed path modes", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ria-baseline-"));
  try {
    const a = makeGit(parent, "a"); const b = makeGit(parent, "b");
    const first = buildBaseline(request([b, a])); const second = buildBaseline(request([a, b]));
    assert.deepEqual(first, second); assert.equal(verifyBaseline(first).ok, true); assert.equal(first.repository.roots.length, 2); assert.equal(first.repository.ancestor_reuse_allowed, true);
    assert.deepEqual(first.generated_protected_paths.map((entry) => entry.kind).sort(), ["allowed-absent-generated", "exact-existing", "pattern"]);
    const out = path.join(parent, "baseline.json"); const written = writeBaseline(out, first); assert.equal(written.content_sha256, first.content_sha256); assert.notEqual(written.content_sha256, written.file_sha256); assert.deepEqual(fs.readFileSync(out), canonicalBytes(first));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("normal durable mode rejects non-Git and degraded mode is fresh-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-nongit-")); fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src", "a.txt"), "a\n");
  try {
    assert.throws(() => buildBaseline(request([root])), /normal durable mode requires Git/);
    const baseline = buildBaseline(request([root], { durable_mode: "content-addressed-degraded" }));
    assert.equal(baseline.repository.mode, "content-addressed-degraded"); assert.equal(baseline.repository.ancestor_reuse_allowed, false); assert.equal(verifyBaseline(baseline).ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scope is identity-bearing and dirty head scope fails closed", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ria-scope-"));
  try {
    const root = makeGit(parent, "repo");
    const head = buildBaseline(request([root], { scope: "head" }));
    assert.equal(head.repository.scope, "head");
    fs.writeFileSync(path.join(root, "src", "index.js"), "module.exports = 2;\n");
    assert.throws(() => buildBaseline(request([root], { scope: "head" })), /head scope requires a clean checkout/);
    const first = buildBaseline(request([root], { scope: "worktree" }));
    fs.writeFileSync(path.join(root, "src", "index.js"), "module.exports = 3;\n");
    const second = buildBaseline(request([root], { scope: "worktree" }));
    assert.equal(first.repository.scope, "worktree");
    assert.equal(first.repository.ancestor_reuse_allowed, false);
    assert.notEqual(first.repository.revision, second.repository.revision);
    assert.notEqual(first.content_sha256, second.content_sha256);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("invalid exact paths and missing inherited authority fail before SEI", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ria-invalid-"));
  try {
    const root = makeGit(parent, "repo");
    assert.throws(() => buildBaseline(request([root], { generated_protected_paths: [{ kind: "exact-existing", path: "missing", root_index: 0 }] })), /required path does not exist/);
    assert.throws(() => buildBaseline(request([root], { command_authorization: { state: "inherited", commands: [] } })), /requires inherited_from/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("published baseline example is a valid immutable artifact", () => {
  const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "baseline.example.json"), "utf8"));
  assert.deepEqual(verifyBaseline(example), { ok: true, errors: [], baseline_ref: { artifact_id: example.artifact_id, sha256: example.content_sha256, repository_revision: example.repository.revision } });
});
