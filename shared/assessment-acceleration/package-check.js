"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runPool, planWaves, defaultWorkerBudget } = require("./scheduler.js");
const { resolveConcurrencyProfile } = require("./concurrency-profile.js");
const { CacheStore, classifyReuse, sha256 } = require("./cache-store.js");
const { escapeHtml, safeJsonForScript, compileTemplate } = require("./report-compiler.js");
const { PerformanceReceipt } = require("./performance-receipt.js");
const { fingerprintFiles, parsePorcelainZ } = require("./fingerprint.js");

async function main() {
  const aggressive = resolveConcurrencyProfile({}, { host_parallelism: 8 });
  assert.equal(aggressive.class_budgets.agent, 16, "read-only agent budget should aggressively oversubscribe host parallelism");
  assert.ok(aggressive.class_budgets.command < aggressive.class_budgets.agent, "local commands must remain more conservative than remote/read-only agents");
  assert.equal(aggressive.target_ready_queue, 48);
  assert.equal(defaultWorkerBudget({ REPOSITORY_ANALYSIS_MAX_WORKERS: "24" }), 24);

  const classLimited = await runPool([
    { id: "agent-a", kind: "evidence-lane", executor_class: "agent" },
    { id: "agent-b", kind: "evidence-lane", executor_class: "agent" },
    { id: "agent-c", kind: "evidence-lane", executor_class: "agent" },
    { id: "cmd-a", kind: "command", executor_class: "command" },
    { id: "cmd-b", kind: "command", executor_class: "command" }
  ], async task => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return task.id;
  }, { maxParallel: 5, classBudgets: { agent: 3, command: 1, general: 5 } });
  assert.equal(classLimited.ok, true);
  assert.equal(classLimited.peak_by_class.agent, 3);
  assert.equal(classLimited.peak_by_class.command, 1);
  const tasks = Array.from({ length: 8 }, (_, index) => ({ id: "t" + index, weight: 1 }));
  const started = Date.now();
  const pooled = await runPool(tasks, async () => { await new Promise(resolve => setTimeout(resolve, 60)); return "ok"; }, { maxParallel: 4 });
  assert.equal(pooled.ok, true);
  assert.equal(pooled.peak_concurrency, 4);
  assert.ok(Date.now() - started < 360, "bounded pool should execute four-at-a-time");

  const resourceTimes = [];
  const resource = await runPool([
    { id: "a", resources: ["worktree"] },
    { id: "b", resources: ["worktree"] },
    { id: "c", resources: ["other"] }
  ], async task => {
    const start = Date.now();
    await new Promise(resolve => setTimeout(resolve, 35));
    resourceTimes.push({ id: task.id, start, end: Date.now() });
  }, { maxParallel: 3 });
  assert.equal(resource.ok, true);
  const a = resourceTimes.find(item => item.id === "a"), b = resourceTimes.find(item => item.id === "b");
  assert.ok(a.end <= b.start || b.end <= a.start, "exclusive resources must not overlap");

  const waves = planWaves([
    { id: "inventory" },
    { id: "lane-a", depends_on: ["inventory"] },
    { id: "lane-b", depends_on: ["inventory"] },
    { id: "merge", depends_on: ["lane-a", "lane-b"] }
  ], { maxParallel: 2 });
  assert.deepEqual(waves.waves.map(wave => wave.task_ids), [["inventory"], ["lane-a", "lane-b"], ["merge"]]);

  const failSoft = await runPool([
    { id: "bad" },
    { id: "independent" },
    { id: "blocked", depends_on: ["bad"] },
    { id: "salvage", depends_on: ["bad"], allow_failed_dependencies: true }
  ], async task => { if (task.id === "bad") throw new Error("expected failure"); return task.id; }, { maxParallel: 3 });
  assert.equal(failSoft.ok, false);
  assert.equal(failSoft.results.bad.status, "failed");
  assert.equal(failSoft.results.independent.status, "success");
  assert.equal(failSoft.results.blocked.status, "blocked");
  assert.equal(failSoft.results.salvage.status, "success");

  const timedDefault = await runPool([{ id: "timeout-default", timeout_ms: 10, retries: 2 }], async () => { await new Promise(resolve => setTimeout(resolve, 35)); }, { maxParallel: 1 });
  assert.equal(timedDefault.results["timeout-default"].status, "failed");
  assert.equal(timedDefault.results["timeout-default"].attempts, 1, "timeouts must not retry unless the runner opts in as abort-safe");
  assert.match(timedDefault.results["timeout-default"].error, /TASK_TIMEOUT/);

  const timedRetry = await runPool([{ id: "timeout-retry", timeout_ms: 10, retries: 1, retry_on_timeout: true }], async (_task, context) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 35);
    context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  }), { maxParallel: 1, collectEvents: true });
  assert.equal(timedRetry.results["timeout-retry"].status, "failed");
  assert.equal(timedRetry.results["timeout-retry"].attempts, 2);
  assert.match(timedRetry.results["timeout-retry"].error, /TASK_TIMEOUT/);
  assert.ok(timedRetry.events.length > 0);
  assert.deepEqual(timedDefault.events, [], "event retention is opt-in to keep the hot path small");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-cache-check-"));
  const store = new CacheStore(root);
  const descriptor = {
    namespace: "health", repository_key: "repo", lane_id: "contracts", contract_version: "1",
    input_fingerprint: sha256("input"), dependency_fingerprint: sha256("deps"), environment_fingerprint: sha256("env"),
    source_revision: "r1", working_tree_fingerprint: "w1", scope: { paths: ["src"] }
  };
  let computes = 0;
  const outputs = await Promise.all(Array.from({ length: 6 }, () => store.getOrCompute(descriptor, async () => { computes += 1; await new Promise(resolve => setTimeout(resolve, 40)); return { claims: [1] }; })));
  assert.equal(computes, 1, "single-flight must compute once");
  assert.deepEqual(outputs.map(item => item.payload), Array.from({ length: 6 }, () => ({ claims: [1] })));
  const releaseHeartbeat = await store.acquire({ ...descriptor, lane_id: "heartbeat" }, { timeout_ms: 50, stale_ms: 20, heartbeat_ms: 5 });
  await assert.rejects(store.acquire({ ...descriptor, lane_id: "heartbeat" }, { timeout_ms: 45, stale_ms: 20, heartbeat_ms: 5 }), /CACHE_LOCK_TIMEOUT/);
  releaseHeartbeat();

  const crossDescriptor = { ...descriptor, lane_id: "cross-process" };
  const countFile = path.join(root, "cross-process-count.txt");
  const workerFile = path.join(root, "cache-worker.js");
  fs.writeFileSync(workerFile, `
    "use strict";
    const fs = require("node:fs");
    const { CacheStore } = require(${JSON.stringify(path.resolve(__dirname, "cache-store.js"))});
    const descriptor = JSON.parse(process.env.CACHE_DESCRIPTOR);
    const store = new CacheStore(process.env.CACHE_ROOT);
    store.getOrCompute(descriptor, async () => {
      fs.appendFileSync(process.env.COUNT_FILE, "compute\\n", "utf8");
      await new Promise(resolve => setTimeout(resolve, 80));
      return { shared: true };
    }).then(() => process.exit(0), error => { console.error(error.stack || error); process.exit(1); });
  `, "utf8");
  const childResults = await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [workerFile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CACHE_ROOT: root, CACHE_DESCRIPTOR: JSON.stringify(crossDescriptor), COUNT_FILE: countFile }
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(code) : reject(new Error("cache child failed " + code + ": " + stderr)));
  })));
  assert.equal(childResults.length, 5);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).filter(Boolean).length, 1, "cross-process single-flight must compute once");

  const exact = store.lookup(descriptor);
  assert.equal(exact.reuse, "exact");
  const moved = { ...descriptor, source_revision: "r2", working_tree_fingerprint: "w2" };
  assert.equal(store.lookup(moved).reuse, "content-stable");
  const changed = { ...moved, input_fingerprint: sha256("changed") };
  assert.equal(store.lookup(changed).reuse, "warm-only");
  assert.equal(classifyReuse(null, descriptor), "miss");
  assert.throws(() => store.lookup({ ...descriptor, source_revision: "" }), /CACHE_DESCRIPTOR_INVALID:source_revision/);

  fs.writeFileSync(path.join(root, "fingerprint.txt"), "alpha", "utf8");
  try { fs.symlinkSync("fingerprint.txt", path.join(root, "fingerprint-link")); } catch (_) { /* symlinks may be restricted */ }
  const wholeRoot = fingerprintFiles(root, ["."]);
  assert.ok(wholeRoot.records.some(record => record.path === "fingerprint.txt" && record.state === "file"));
  if (fs.existsSync(path.join(root, "fingerprint-link"))) assert.ok(wholeRoot.records.some(record => record.path === "fingerprint-link" && record.state === "symlink"));
  assert.deepEqual(parsePorcelainZ(Buffer.from("R  new name\0old name\0?? untracked\0")), ["new name", "old name", "untracked"]);

  let now = 1000;
  const receipt = new PerformanceReceipt({ mode: "mixed", worker_budget: 4, clock: () => now });
  receipt.setPlannedTasks(8).setOwnerLaneCounts({ health: 3, integrity: 2, architecture: 3 }).recordCache("exact", 2).recordCache("content-stable").recordCache("warm-only").recordCache("miss", 4).invalidate("contracts changed", { lane_id: "contracts" });
  const endStage = receipt.startStage("evidence"); now += 75; endStage();
  receipt.absorbScheduler(pooled); now += 25;
  const finalReceipt = receipt.finalize();
  assert.equal(finalReceipt.wall_elapsed_ms, 100);
  assert.equal(finalReceipt.peak_concurrency, 4);
  assert.equal(finalReceipt.cache.content_stable, 1);
  assert.equal(finalReceipt.owner_lane_counts.architecture, 3);
  assert.throws(() => receipt.recordCache("exact"), /PERFORMANCE_RECEIPT_CLOSED/);

  assert.equal(escapeHtml('<script>"&'), "&lt;script&gt;&quot;&amp;");
  assert.ok(!safeJsonForScript({ value: "</script>" }).includes("</script>"));
  const template = path.join(root, "template.html"), output = path.join(root, "out.html");
  fs.writeFileSync(template, "a<!--X-->b", "utf8");
  const compiled = compileTemplate({ template, output, replacements: { "<!--X-->": "safe" } });
  assert.equal(fs.readFileSync(output, "utf8"), "asafeb");
  assert.ok(compiled.bytes > 0 && /^[a-f0-9]{64}$/.test(compiled.sha256));
  assert.ok(Number.isFinite(compiled.compile_elapsed_ms) && compiled.compile_elapsed_ms >= 0);
  let reportNow = 2000;
  const reportReceipt = new PerformanceReceipt({ clock: () => reportNow });
  reportReceipt.recordReport(compiled);
  assert.equal(reportReceipt.receipt.stage_elapsed_ms.report_compile, compiled.compile_elapsed_ms);
  assert.throws(() => reportReceipt.finalize({ mode: "warm" }), /PERFORMANCE_RECEIPT_EXTRA_COLLISION:mode/);

  fs.rmSync(root, { recursive: true, force: true });
  console.log("PASS assessment-acceleration package check");
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
