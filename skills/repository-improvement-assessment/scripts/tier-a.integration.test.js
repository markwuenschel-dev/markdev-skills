"use strict";

// Every repair here is exercised through scripts/ria.js — the CLI or executeRia — never only
// through the helper it calls. An earlier round verified helpers and shipped three fixes that
// did not hold at the entrypoint.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const { executeRia, normalizedRequest, OWNER_TASKS } = require("./ria.js");
const { createAdapter, returnPath, loadSnapshotFromResult } = require("./ria-agent-adapter.js");

const RIA = path.join(__dirname, "ria.js");
const BINDING = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "baseline.example.json"), "utf8")).sei_compatibility_binding;

function git(root, args) { return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function repo(context, prefix = "ria-tier-a-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => {
    try { git(root, ["worktree", "prune"]); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  git(root, ["init"]); git(root, ["config", "user.email", "t@example.invalid"]); git(root, ["config", "user.name", "Tier A"]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "module.exports = { add: (a, b) => a + b };\n");
  git(root, ["add", "."]); git(root, ["commit", "-m", "fixture"]);
  return root;
}
function request(root, extra = {}) {
  return {
    repository: { root },
    command_authorization: { state: "granted", authorization_ref: "tier-a-test", inherited_from: null, commands: ["node"] },
    sei_compatibility_binding: BINDING,
    lifecycle: "run",
    depth: "quick",
    scope: "head",
    presentation_policy: "skip",
    ...extra,
  };
}
function cli(root, req, name) {
  const requestPath = path.join(root, `${name}.request.json`);
  const outputPath = path.join(root, `${name}.result.json`);
  fs.writeFileSync(requestPath, JSON.stringify(req));
  const started = Date.now();
  const run = childProcess.spawnSync(process.execPath, [RIA, "--request", requestPath, "--output", outputPath], { encoding: "utf8", timeout: 300000 });
  const result = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, "utf8")) : null;
  return { status: run.status, stderr: run.stderr, result, elapsed: Date.now() - started };
}

test("item 1+3: a hung verification command is killed at its timeout, blocks the run, and stale worktree registrations are pruned", (context) => {
  const root = repo(context);
  // A registration whose directory is gone — what a killed run leaves behind.
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), "ria-vt-orphan-"));
  git(root, ["worktree", "add", "--detach", orphan, "HEAD"]);
  fs.rmSync(orphan, { recursive: true, force: true });
  assert.match(git(root, ["worktree", "list", "--porcelain"]), /prunable/);

  const marker = `tier-a-sleeper-${crypto.randomBytes(4).toString("hex")}`;
  const run = cli(root, request(root, {
    verification_contract: { commands: [{ command: `node -e "setTimeout(()=>{},600000)" ${marker}`, kind: "test", timeout_ms: 1500 }] },
  }), "timeout");
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /FAIL-RIA-VERIFICATION-GATE/);
  assert.match(run.stderr, /timed-out/);
  assert.ok(run.elapsed < 240000, `a 1.5 s timeout must not hold the run for ${run.elapsed} ms`);
  // Killing only the shell orphaned the command it started — observed on Windows, where it then
  // held a handle on the isolation worktree. The whole tree has to go.
  assert.equal(processesMatching(marker), 0, `the timed-out command must not survive the run (marker ${marker})`);
  assert.equal(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("ria-vt-") && fs.existsSync(path.join(os.tmpdir(), name, "src"))).length, 0, "no isolation checkout may be left behind");

  assert.doesNotMatch(git(root, ["worktree", "list", "--porcelain"]), /prunable/, "the orphaned registration must be pruned");
  assert.equal(git(root, ["worktree", "list"]).split("\n").length, 1, "only the main worktree may remain");
});

test("fork 1 + item 5 + item 6: an unverified run says so, `ask` says it made no report, state.json carries no snapshot, reuse telemetry is honest", (context) => {
  const root = repo(context);
  fs.writeFileSync(path.join(root, "scratch.tmp"), "dirty\n");
  const req = request(root, { presentation_policy: "ask" });   // deliberately no verification_contract

  const first = cli(root, req, "first");
  assert.equal(first.status, 3, first.stderr);                    // owners pending, as always
  assert.equal(first.result.verification.trust_state, "not-run");
  assert.equal(first.result.verification.command_count, 0);
  assert.match(first.stderr, /verification not-run — no verification commands ran/);
  assert.match(first.stderr, /Health caps its grade at C/);
  assert.match(first.stderr, /presentation_policy "ask" is not interactive/);

  // Item 6: the snapshot travels by path + hash, and never lands in state.json.
  const state = fs.readFileSync(first.result.state_path, "utf8");
  assert.doesNotMatch(state, /"measurements"/, "the SEI snapshot must not be embedded in state.json");
  const sei = JSON.parse(state).task_results["sei-snapshot"];
  assert.ok(sei.snapshot_path && fs.existsSync(sei.snapshot_path));
  assert.equal(sei.snapshot, undefined);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(sei.snapshot_path)).digest("hex"), sei.snapshot_sha256);
  // sei-assessment consumed it by path on this very run.
  assert.ok(JSON.parse(state).task_results["sei-assessment"]);

  // Item 7: an identical second run is served from lineage and the result must say so.
  const second = cli(root, req, "second");
  assert.equal(second.status, 3, second.stderr);
  assert.equal(second.result.startup_resolution.node_cache_state, "EXACT_REUSE");
  const reuse = JSON.parse(fs.readFileSync(second.result.state_path, "utf8")).task_results["reuse-resolve"];
  assert.equal(reuse.startup_mode, "EXACT_REUSE", "reuse-resolve must report the computed resolution, not a FRESH default");
});

test("item 6: a snapshot whose bytes changed is refused, and a result cached before the change still loads inline", (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ria-snap-"));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.json");
  fs.writeFileSync(file, JSON.stringify({ schema_version: "1.0.0", measurements: [] }));
  const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(loadSnapshotFromResult({ snapshot_path: file, snapshot_sha256: sha }).schema_version, "1.0.0");
  fs.appendFileSync(file, " ");
  assert.throws(() => loadSnapshotFromResult({ snapshot_path: file, snapshot_sha256: sha }), /altered \(sha256 mismatch\)/);
  assert.throws(() => loadSnapshotFromResult({ snapshot_path: path.join(dir, "gone.json"), snapshot_sha256: sha }), /is missing/);
  assert.equal(loadSnapshotFromResult({ snapshot: { schema_version: "legacy" } }).schema_version, "legacy");
});

test("item 6: state.json is written once per terminal event, and a lagging last_sequence cannot reuse sequence numbers on continue", async (context) => {
  const root = repo(context);
  const writes = [];
  const realRename = fs.renameSync;
  fs.renameSync = function spy(from, to) { if (String(to).endsWith("state.json")) writes.push(to); return realRename.call(fs, from, to); };
  context.after(() => { fs.renameSync = realRename; });
  const adapter = { createAdapter: (ctx) => createAdapter(ctx, stubSei()) };

  const first = await executeRia(request(root, { verification_contract: { commands: ["node-version"] } }), adapter);
  fs.renameSync = realRename;
  const terminal = first.execution.events.filter((event) => ["reused", "completed", "failed", "blocked", "cancelled"].includes(event.status)).length;
  assert.ok(writes.length <= terminal + 1, `${writes.length} state writes for ${terminal} terminal events`);
  assert.ok(writes.length < first.execution.events.length, "state must not be rewritten for every event");

  // Simulate a crash that left state.json behind the event log, then resume.
  const statePath = first.state_path;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.last_sequence = 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  writeOwnerReturns(path.dirname(statePath), git(root, ["rev-parse", "HEAD"]), first.owner_rendezvous.envelopes);
  await executeRia(request(root, { lifecycle: "continue", state_path: statePath, verification_contract: { commands: ["node-version"] } }), adapter);
  const sequences = fs.readFileSync(path.join(path.dirname(statePath), "task-events.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line).sequence);
  assert.equal(new Set(sequences).size, sequences.length, "sequence numbers in task-events.jsonl must be unique");
});

test("item 4: an elected report that fails to render is reported, and the run is degraded, not complete", async (context) => {
  const root = repo(context);
  const adapter = { createAdapter: (ctx) => createAdapter(ctx, stubSei()) };
  const req = request(root, { presentation_policy: "generate", verification_contract: { commands: ["node-version"] } });
  const first = await executeRia(req, adapter);
  assert.equal(first.status, "awaiting-owner-returns");
  // Owner artifacts that are valid returns but not valid Health/Integrity/Architecture
  // documents: report-data throws, exactly the silent failure this repairs.
  writeOwnerReturns(path.dirname(first.state_path), git(root, ["rev-parse", "HEAD"]), first.owner_rendezvous.envelopes);
  const second = await executeRia({ ...req, lifecycle: "continue", state_path: first.state_path }, adapter);
  assert.equal(second.report, null);
  assert.ok(second.execution.observational_failures.length > 0, "the render failure must be recorded");
  assert.equal(second.status, "degraded", "an elected report that never appeared is not a complete run");
  assert.match(second.warnings.join(" "), /no report was produced/);
});

test("item 5: an unknown presentation_policy is rejected with the valid set", () => {
  assert.throws(() => normalizedRequest(request(os.tmpdir(), { presentation_policy: "genrate" })), /presentation_policy "genrate" is not valid — use one of generate, skip, ask, inherit/);
  for (const valid of ["generate", "skip", "ask", "inherit"]) assert.doesNotThrow(() => normalizedRequest(request(os.tmpdir(), { presentation_policy: valid })));
});

function stubSei() {
  return {
    async seiSnapshot({ baseline, baseline_ref }) {
      const ei = { artifact_id: `engineering-intelligence:${"b".repeat(64)}`, owner: "repository-improvement-assessment", kind: "engineering-intelligence", schema_version: "1.0.0", sha256: "b".repeat(64), repository_revision: baseline.repository.revision, mission_id: "tier-a", scope_hash: "c".repeat(64), baseline_binding: baseline_ref };
      return { engineering_intelligence_ref: ei, snapshot: { schema_version: "1.0.0" }, prior_snapshot_path: null, result_ref: ei, telemetry: { tool_calls: 1, tokens: 0 } };
    },
    async seiAssessment({ dependencies, baseline }) {
      return {
        assessment: { criteria: [{ criterion_id: "c1", applicability: "not_scored", maturity: "not_scored" }] },
        trend: { schema_version: "ria.trend@1", status: "no-comparable-prior", prior: null, deltas: [] },
        engineering_intelligence_ref: dependencies["sei-snapshot"].engineering_intelligence_ref,
        result_ref: { artifact_id: "sei-assessment:test", sha256: "d".repeat(64), repository_revision: baseline.repository.revision },
        telemetry: { tool_calls: 1, tokens: 0 },
      };
    },
  };
}
function writeOwnerReturns(runDirectory, revision, envelopes) {
  for (const owner of Object.values(OWNER_TASKS)) {
    const envelope = JSON.parse(fs.readFileSync(envelopes[owner], "utf8"));
    const artifactPath = path.join(runDirectory, `${owner}.json`);
    const bytes = `${JSON.stringify({ owner, repository_revision: revision })}\n`;
    fs.writeFileSync(artifactPath, bytes);
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const ownerReturn = createOwnerReturn({ owner, repository_revision: revision, artifact_path: artifactPath, canonical_artifact_ref: { owner, artifact_id: `${owner}:${sha}`, sha256: sha, repository_revision: revision }, input_binding_echo: envelope });
    fs.mkdirSync(path.dirname(returnPath(runDirectory, owner)), { recursive: true });
    fs.writeFileSync(returnPath(runDirectory, owner), `${JSON.stringify(ownerReturn, null, 2)}\n`);
  }
}
function processesMatching(marker) {
  if (process.platform === "win32") {
    const out = childProcess.spawnSync("powershell", ["-NoProfile", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -eq 'node.exe' }).Count`], { encoding: "utf8" });
    return Number.parseInt(String(out.stdout).trim(), 10) || 0;
  }
  const out = childProcess.spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
  return String(out.stdout).split("\n").filter((line) => line.includes(marker) && !line.includes("ps -eo")).length;
}
