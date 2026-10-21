"use strict";

// CLI-level regression tests for exact-replay identity and the default output
// root. Every fixture lives under os.tmpdir(); no real repository is written.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { resolveSeiLayout } = require("./layout.js");

const developmentSkillsRoot = path.resolve(__dirname, "..", "..");

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "SEI Test",
    GIT_AUTHOR_EMAIL: "sei-test@example.invalid",
    GIT_COMMITTER_NAME: "SEI Test",
    GIT_COMMITTER_EMAIL: "sei-test@example.invalid",
    GIT_AUTHOR_DATE: "2001-02-03T04:05:06+00:00",
    GIT_COMMITTER_DATE: "2001-02-03T04:05:06+00:00",
  };
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, env: gitEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-replay-identity-"));
  const repo = path.join(root, "repo");
  const out = path.join(root, "out");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "index.js"), "function human() { return 1; }\n");
  fs.writeFileSync(path.join(repo, "src", "module.js"), "function helper(value) { return value + 1; }\n");
  git(repo, ["init", "--quiet"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
  return { root, repo, out };
}

function writeJson(root, name, value) {
  const target = path.join(root, name);
  fs.writeFileSync(target, JSON.stringify(value));
  return target;
}

function writeConfig(root) {
  return writeJson(root, "config.json", {
    repository_id: `sei-test-${crypto.createHash("sha256").update(path.resolve(root)).digest("hex")}`,
    generated_path_patterns: ["build/**", "coverage/**", "dist/**", "generated/**"],
    history_window: { kind: "revision-range", start: null },
  });
}

function runCli(args, { cwd } = {}) {
  const script = resolveSeiLayout().runner_path;
  const outIndex = args.indexOf("--out");
  const env = { ...process.env };
  delete env.SEI_INCREMENTAL_STATE_ROOT;
  if (outIndex >= 0) {
    env.SEI_INCREMENTAL_STATE_ROOT = path.join(path.dirname(path.resolve(args[outIndex + 1])), ".sei-test-state");
  }
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true, env, ...(cwd ? { cwd } : {}) });
}

function receiptOf(run) {
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function replayed(receipt) {
  return receipt.performance?.executor?.mode === "exact-run-replay-v1";
}

function findDirectories(root, name) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === name) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function canonicalJson(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    return item;
  };
  return JSON.stringify(canonical(value));
}

function sha256Of(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

test("an enforcing profile after a default-profile run fails closed instead of replaying the cached assessment", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root);
  const enforcing = writeJson(fixture.root, "enforce.json", { standard: "mark", coverage_gate: { required_criteria: 30, denominator: 30, enforce: true } });

  const first = receiptOf(runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]));
  assert.equal(first.assessment.coverage_gate, "not_met", "fixture must under-cover the 30-criterion rubric");
  const second = receiptOf(runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]));
  assert.equal(replayed(second), true, "control: the unchanged default profile replays exactly");

  const strict = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config, "--assessment-config", enforcing]);
  assert.notEqual(strict.status, 0, `enforcing profile must not succeed: ${strict.stdout}`);
  assert.match(strict.stderr, /FAIL-ASSESSMENT-COVERAGE-GATE: assessed \d+\/30 criteria; required 30/);
});

test("alternating assessment profiles each replay their own assessment", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root);
  const profileB = writeJson(fixture.root, "profile-b.json", { standard: "mark", coverage_gate: { required_criteria: 20, denominator: 30 } });
  // --report-mode skip: reports are keyed by snapshot id only, so two profiles
  // (same snapshot, different assessments) collide on one report path. That is a
  // separate pre-existing defect; this test isolates assessment replay identity.
  const defaultArgs = ["--repo", fixture.repo, "--out", fixture.out, "--config", config, "--report-mode", "skip"];
  const profileArgs = [...defaultArgs, "--assessment-config", profileB];

  const defaultFresh = receiptOf(runCli(defaultArgs));
  const profileFresh = receiptOf(runCli(profileArgs));
  assert.equal(replayed(profileFresh), false, "a new profile must not replay the default-profile bundle");
  assert.notEqual(defaultFresh.assessment_id, profileFresh.assessment_id);

  const defaultAgain = receiptOf(runCli(defaultArgs));
  const profileAgain = receiptOf(runCli(profileArgs));
  assert.equal(replayed(defaultAgain), true);
  assert.equal(replayed(profileAgain), true);
  assert.equal(defaultAgain.assessment_id, defaultFresh.assessment_id);
  assert.equal(profileAgain.assessment_id, profileFresh.assessment_id);
});

test("a binding @1 manifest is a clean miss followed by a fresh run", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root);
  // --report-mode skip: see the note in the alternating-profile test.
  const args = ["--repo", fixture.repo, "--out", fixture.out, "--config", config, "--report-mode", "skip"];
  const first = receiptOf(runCli(args));

  const manifestDirectories = findDirectories(path.join(fixture.root, ".sei-test-state"), "manifests");
  assert.equal(manifestDirectories.length, 1);
  const [manifestName] = fs.readdirSync(manifestDirectories[0]).filter((name) => name.endsWith(".json"));
  const manifestPath = path.join(manifestDirectories[0], manifestName);
  const document = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // Rewrite the only manifest exactly as an @1-era writer would have produced it.
  const { assessment_config_sha256: _dropped, ...legacyBinding } = document.binding;
  const legacyKey = sha256Of(canonicalJson({ schema_version: "sei.incremental-run-binding@1", binding: legacyBinding }));
  const { manifest_sha256: _digest, ...body } = { ...document, binding: legacyBinding, run_key: legacyKey };
  const legacy = { ...body, manifest_sha256: sha256Of(canonicalJson(body)) };
  fs.rmSync(manifestPath);
  fs.writeFileSync(path.join(manifestDirectories[0], `${legacyKey.slice("sha256:".length)}.json`), `${JSON.stringify(JSON.parse(canonicalJson(legacy)), null, 2)}\n`);

  const rerun = receiptOf(runCli(args));
  assert.equal(replayed(rerun), false, "an @1 manifest must never be replayed");
  assert.equal(rerun.snapshot_id, first.snapshot_id);
  assert.equal(typeof rerun.assessment_id, "string");
  const afterRerun = receiptOf(runCli(args));
  assert.equal(replayed(afterRerun), true, "the fresh run republishes an @2 manifest that replays");
});

function copyPackage(sourceRoot, destinationRoot, relativePath) {
  const source = path.join(sourceRoot, ...relativePath.split("/"));
  const destination = path.join(destinationRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

// Mirrors layout.test.js materializeSkillsRoot: the engine plus its declared
// dependency closure, copied into a sandbox so a dependency file can be mutated.
function materializeSkillsRoot() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sei-replay-contract-"));
  const skillsRoot = path.join(sandbox, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const relativePath of [
    "software-engineering-intelligence",
    "shared/software-engineering-intelligence",
    "shared/capability-registry",
    "shared/report-election",
    "shared/report-presentation",
    "shared/assessment-runtime-contract",
    "shared/project-intelligence-workspace",
  ]) {
    copyPackage(developmentSkillsRoot, skillsRoot, relativePath);
  }
  return { sandbox, skillsRoot };
}

function sandboxContract(skillsRoot) {
  const cliPath = path.join(skillsRoot, "shared", "software-engineering-intelligence", "cli.js");
  const result = spawnSync(process.execPath, ["-e", `
    const cli = require(${JSON.stringify(cliPath)})[Symbol.for("sei.cli.private.v1")];
    process.stdout.write(JSON.stringify({ hash: cli.executionContractHash(), paths: cli.executionContractPaths() }));
  `], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("the execution contract binds declared shared dependencies and JSON modules", (t) => {
  const { sandbox, skillsRoot } = materializeSkillsRoot();
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const initial = sandboxContract(skillsRoot);
  assert.ok(initial.paths.includes("../report-presentation/report-presentation.js"), initial.paths.join("\n"));
  assert.ok(initial.paths.includes("../project-intelligence-workspace/project-intelligence-workspace.js"));
  assert.ok(initial.paths.includes("engineering-assessment-rubric.json"));
  // Undeclared shared packages (the registry layout.js loads) stay outside the contract.
  assert.equal(initial.paths.some((relativePath) => relativePath.startsWith("../capability-registry/")), false);

  fs.appendFileSync(path.join(skillsRoot, "shared", "report-presentation", "report-presentation.js"), "\n// renderer change\n");
  const rendererChanged = sandboxContract(skillsRoot);
  assert.notEqual(rendererChanged.hash, initial.hash, "a report-presentation change must invalidate exact replay");

  fs.appendFileSync(path.join(skillsRoot, "shared", "software-engineering-intelligence", "engineering-assessment-rubric.json"), "\n");
  const rubricChanged = sandboxContract(skillsRoot);
  assert.notEqual(rubricChanged.hash, rendererChanged.hash, "a required JSON module change must invalidate exact replay");
});

function assertWorkspaceRun(fixture, receipt) {
  const workspace = path.join(fs.realpathSync(fixture.repo), ".project-intelligence");
  for (const artifactPath of [receipt.snapshot_path, receipt.report_path, receipt.assessment_path]) {
    const relative = path.relative(workspace, fs.realpathSync(artifactPath));
    assert.ok(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), `${artifactPath} escaped ${workspace}`);
  }
  assert.equal(fs.existsSync(path.join(fixture.repo, "src", ".project-intelligence")), false);
  assert.equal(git(fixture.repo, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
}

test("--repo <subdirectory> without --out writes only to the Git top-level workspace", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root);
  const receipt = receiptOf(runCli(["--repo", path.join(fixture.repo, "src"), "--config", config]));
  assertWorkspaceRun(fixture, receipt);
});

test("a subdirectory working directory without --repo or --out writes only to the Git top-level workspace", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root);
  const receipt = receiptOf(runCli(["--config", config], { cwd: path.join(fixture.repo, "src") }));
  assertWorkspaceRun(fixture, receipt);
});
