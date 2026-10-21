"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  activeOwnedProcessCount,
  runOwnedSubprocess,
} = require("./subprocess-supervisor");

const fixture = path.join(__dirname, "subprocess-supervisor-fixture.js");

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForDead(pid) {
  const deadline = Date.now() + 10_000;
  while (alive(pid)) {
    if (Date.now() >= deadline) assert.fail(`process ${pid} survived settled supervisor promise`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function options(root, signal, timeoutMs = 30_000) {
  return {
    command: process.execPath,
    args: [fixture, path.join(root, "parent.pid"), path.join(root, "child.pid")],
    cwd: root,
    signal,
    timeoutMs,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    temporaryRoot: root,
    temporaryPaths: [path.join(root, "owned-temp")],
    codes: {
      cancelled: "FAIL-SUPERVISOR-CANCELLED",
      timeout: "FAIL-SUPERVISOR-TIMEOUT",
      process: "FAIL-SUPERVISOR-PROCESS",
    },
  };
}

test("pre-abort spawns nothing", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-supervisor-preabort-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runOwnedSubprocess(options(root, controller.signal)), /FAIL-SUPERVISOR-CANCELLED/);
  assert.equal(fs.existsSync(path.join(root, "parent.pid")), false);
  assert.equal(activeOwnedProcessCount(), 0);
});

test("temporary cleanup rejects broad roots and paths outside the caller-owned root", () => {
  const broad = path.parse(os.tmpdir()).root;
  assert.throws(() => runOwnedSubprocess({ ...options(os.tmpdir()), temporaryRoot: broad }), /FAIL-SUBPROCESS-SUPERVISOR-CONFIG/);
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-supervisor-boundary-"));
  try {
    assert.throws(() => runOwnedSubprocess({
      ...options(ownedRoot),
      temporaryRoot: ownedRoot,
      temporaryPaths: [path.resolve(ownedRoot, "..", "escape")],
    }), /FAIL-SUBPROCESS-SUPERVISOR-CONFIG/);
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test("abort reaps descendants, drains pipes, settles, and removes owned temporary paths", { timeout: 30_000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-supervisor-abort-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "owned-temp"));
  fs.writeFileSync(path.join(root, "owned-temp", "artifact"), "x");
  const controller = new AbortController();
  const pending = runOwnedSubprocess(options(root, controller.signal));
  await waitForFile(path.join(root, "child.pid"));
  const parentPid = Number(fs.readFileSync(path.join(root, "parent.pid"), "utf8"));
  const childPid = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"));
  controller.abort();
  await assert.rejects(pending, /FAIL-SUPERVISOR-CANCELLED/);
  await waitForDead(parentPid);
  await waitForDead(childPid);
  assert.equal(fs.existsSync(path.join(root, "owned-temp")), false);
  assert.equal(activeOwnedProcessCount(), 0);
});

test("timeout uses the same complete cleanup path", { timeout: 30_000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-supervisor-timeout-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "owned-temp"));
  const pending = runOwnedSubprocess(options(root, undefined, 100));
  await waitForFile(path.join(root, "child.pid"));
  const parentPid = Number(fs.readFileSync(path.join(root, "parent.pid"), "utf8"));
  const childPid = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"));
  await assert.rejects(pending, /FAIL-SUPERVISOR-TIMEOUT/);
  await waitForDead(parentPid);
  await waitForDead(childPid);
  assert.equal(fs.existsSync(path.join(root, "owned-temp")), false);
  assert.equal(activeOwnedProcessCount(), 0);
});
