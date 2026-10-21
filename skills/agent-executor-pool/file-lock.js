"use strict";

const fs = require("node:fs");
const os = require("node:os");

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && error.code === "EPERM"); }
}

function wait(ms) { Atomics.wait(sleeper, 0, 0, Math.max(1, ms)); }

function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = Number.isFinite(options.timeout_ms) ? Number(options.timeout_ms) : 10000;
  const staleMs = Number.isFinite(options.stale_ms) ? Number(options.stale_ms) : 300000;
  const started = Date.now();
  fs.mkdirSync(require("node:path").dirname(lockPath), { recursive: true });
  while (Date.now() - started <= timeoutMs) {
    try {
      fs.mkdirSync(lockPath);
      const ownerPath = require("node:path").join(lockPath, "owner.json");
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquired_at: new Date().toISOString() }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const ownerPath = require("node:path").join(lockPath, "owner.json");
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); } catch (_) { /* incomplete owner */ }
        const stat = fs.statSync(fs.existsSync(ownerPath) ? ownerPath : lockPath);
        const liveLocal = owner && owner.hostname === os.hostname() && processAlive(Number(owner.pid));
        if (Date.now() - stat.mtimeMs > staleMs && !liveLocal) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (_) { /* contender may have released */ }
      wait(5);
    }
  }
  throw new Error("FILE_LOCK_TIMEOUT:" + lockPath);
}

function withFileLock(lockPath, operation, options = {}) {
  const release = acquireFileLock(lockPath, options);
  try { return operation(); }
  finally { release(); }
}

module.exports = { acquireFileLock, withFileLock };
