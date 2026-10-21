"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const active = new Set();

function activeOwnedProcessCount() {
  return active.size;
}

function processError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function powershellPath() {
  const modern = path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(modern)) return modern;
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidate = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

function stopWindowsTree(pid, force, trackedPids = null) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
  const forceSwitch = force ? " -Force" : "";
  const discovery = trackedPids === null ? [
    `$rootPid=${pid}`,
    "$ids=[System.Collections.Generic.HashSet[int]]::new()",
    "[void]$ids.Add($rootPid)",
    "$changed=$true",
    "while($changed){$changed=$false;foreach($p in Get-Process -ErrorAction SilentlyContinue){try{$parent=$p.Parent}catch{$parent=$null};if($null-ne $parent-and $ids.Contains([int]$parent.Id)-and $ids.Add([int]$p.Id)){$changed=$true}}}",
    "$ordered=@($ids)",
  ] : [`$ordered=@(${trackedPids.map((value) => Number(value)).join(",")})`];
  const script = [
    ...discovery,
    "$ordered | ConvertTo-Json -Compress",
    "[array]::Reverse($ordered)",
    `foreach($id in $ordered){Stop-Process -Id $id${forceSwitch} -ErrorAction SilentlyContinue}`,
  ].join(";");
  return new Promise((resolve) => {
    const killer = spawn(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks = [];
    killer.stdout.on("data", (chunk) => chunks.push(chunk));
    const done = () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
        resolve((Array.isArray(parsed) ? parsed : [parsed]).filter((value) => Number.isSafeInteger(value) && value > 0));
      } catch { resolve(trackedPids ?? [pid]); }
    };
    killer.once("error", () => resolve(trackedPids ?? [pid]));
    killer.once("close", done);
  });
}

function signalPosixGroup(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    return error.code === "EPERM";
  }
}

function processGroupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    return error.code === "EPERM";
  }
}

async function waitForOwnedTreeExit(pid, trackedPids, processCode) {
  const deadline = Date.now() + 5_000;
  const alive = () => process.platform === "win32"
    ? (trackedPids ?? [pid]).some(processAlive)
    : processGroupAlive(pid);
  while (alive()) {
    if (Date.now() >= deadline) throw processError(processCode, `owned process tree for pid ${pid} survived force termination`);
    await delay(25);
  }
}

async function terminateOwnedProcess(child, graceMs, processCode) {
  let trackedPids = null;
  if (process.platform === "win32") trackedPids = await stopWindowsTree(child.pid, false);
  else signalPosixGroup(child, "SIGTERM");
  await delay(graceMs);
  if (process.platform === "win32") await stopWindowsTree(child.pid, true, trackedPids);
  else signalPosixGroup(child, "SIGKILL");
  await waitForOwnedTreeExit(child.pid, trackedPids, processCode);
}

function cleanupTemporaryPaths(paths) {
  for (const temporaryPath of paths) {
    if (typeof temporaryPath !== "string" || temporaryPath.length === 0 || !path.isAbsolute(temporaryPath)) {
      throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "temporaryPaths must contain absolute paths");
    }
    fs.rmSync(temporaryPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "input must be an object");
  if (typeof input.command !== "string" || input.command.length === 0) throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "command is required");
  if (!Array.isArray(input.args) || input.args.some((value) => typeof value !== "string")) throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "args must be strings");
  if (!input.codes || !["cancelled", "timeout", "process"].every((key) => typeof input.codes[key] === "string" && input.codes[key].length > 0)) {
    throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "codes must define cancelled, timeout, and process");
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "signal must be an AbortSignal");
  for (const key of ["timeoutMs", "maxStdoutBytes", "maxStderrBytes"]) {
    if (!Number.isSafeInteger(input[key]) || input[key] <= 0) throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", `${key} must be a positive safe integer`);
  }
  const graceMs = input.graceMs ?? 150;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 5_000) throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "graceMs must be 0..5000");
  const temporaryPaths = input.temporaryPaths ?? [];
  if (!Array.isArray(temporaryPaths)) throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "temporaryPaths must be an array");
  let temporaryRoot = input.temporaryRoot;
  if (temporaryPaths.length > 0) {
    if (typeof temporaryRoot !== "string" || !path.isAbsolute(temporaryRoot)) {
      throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "temporary cleanup requires an absolute caller-owned temporaryRoot");
    }
    temporaryRoot = path.resolve(temporaryRoot);
    const platformKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    const systemTemporaryRoot = path.resolve(os.tmpdir());
    const rootKey = platformKey(temporaryRoot);
    const systemKey = platformKey(systemTemporaryRoot);
    if (rootKey === platformKey(path.parse(temporaryRoot).root)
        || rootKey === systemKey
        || !rootKey.startsWith(`${systemKey}${path.sep}`)
        || !fs.statSync(temporaryRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "temporaryRoot must be an existing caller-owned directory below the system temporary directory");
    }
    for (const temporaryPath of temporaryPaths) {
      if (typeof temporaryPath !== "string" || !path.isAbsolute(temporaryPath)) {
        throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "temporaryPaths must contain absolute paths");
      }
      const candidateKey = platformKey(path.resolve(temporaryPath));
      if (!candidateKey.startsWith(`${rootKey}${path.sep}`)) {
        throw processError("FAIL-SUBPROCESS-SUPERVISOR-CONFIG", "temporaryPaths must stay strictly inside temporaryRoot");
      }
    }
  }
  return { ...input, graceMs, temporaryPaths, temporaryRoot };
}

function runOwnedSubprocess(rawInput) {
  const options = normalize(rawInput);
  if (options.signal?.aborted) return Promise.reject(processError(options.codes.cancelled, "operation was cancelled before spawn"));
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    active.add(child);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError = null;
    let termination = null;
    let settled = false;
    const terminate = (error) => {
      terminalError ??= error;
      if (!termination) {
        if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
        termination = terminateOwnedProcess(child, options.graceMs, options.codes.process);
      }
    };
    const timer = setTimeout(() => terminate(processError(options.codes.timeout, `process exceeded ${options.timeoutMs} ms`)), options.timeoutMs);
    timer.unref?.();
    const abort = () => terminate(processError(options.codes.cancelled, "operation was cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) terminate(processError(options.codes.process, `stdout exceeded ${options.maxStdoutBytes} bytes`));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const admitted = Math.max(0, Math.min(chunk.length, options.maxStderrBytes - Math.min(stderrBytes, options.maxStderrBytes)));
      if (admitted > 0) stderr.push(chunk.subarray(0, admitted));
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxStderrBytes) terminate(processError(options.codes.process, `stderr exceeded ${options.maxStderrBytes} bytes`));
    });
    child.once("error", (error) => terminate(processError(options.codes.process, `could not spawn process: ${error.message}`)));
    child.once("close", async (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      let terminationError = null;
      if (termination) {
        try { await termination; } catch (error) { terminationError = error; }
      }
      active.delete(child);
      let cleanupError = null;
      try { cleanupTemporaryPaths(options.temporaryPaths); } catch (error) { cleanupError = error; }
      const stderrBuffer = Buffer.concat(stderr);
      if (terminationError) reject(terminationError);
      else if (terminalError) reject(terminalError);
      else if (cleanupError) reject(processError(options.codes.process, `temporary cleanup failed: ${cleanupError.message}`));
      else if (code !== 0) {
        const detail = stderrBuffer.toString("utf8").trim().slice(0, 512);
        reject(processError(options.codes.process, `process exited with code ${code}${closeSignal ? ` (${closeSignal})` : ""}${detail ? `: ${detail}` : ""}`));
      } else resolve({ stdout: Buffer.concat(stdout), stderr: stderrBuffer, pid: child.pid });
    });
    if (options.input !== undefined) {
      child.stdin.once("error", (error) => terminate(processError(options.codes.process, `could not write process input: ${error.message}`)));
      child.stdin.end(options.input);
    }
  });
}

module.exports = Object.freeze({
  activeOwnedProcessCount,
  runOwnedSubprocess,
});
