#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { sha256, stableStringify } = require("./cache-store.js");

const DEFAULT_IGNORES = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", "build", "coverage"]);

function normalizeRelative(root, target) {
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) throw new Error("FINGERPRINT_PATH_OUTSIDE_ROOT:" + target);
  return relative || ".";
}

function walk(root, relative = ".", found = [], ignores = DEFAULT_IGNORES) {
  const directory = relative === "." ? root : path.join(root, relative);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && ignores.has(entry.name)) continue;
    const child = relative === "." ? entry.name : path.join(relative, entry.name);
    const portable = child.split(path.sep).join("/");
    if (entry.isDirectory()) walk(root, portable, found, ignores);
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(portable);
  }
  return found;
}

function fingerprintFiles(root, relativePaths) {
  if (!Array.isArray(relativePaths)) throw new Error("FINGERPRINT_PATHS_INVALID");
  const canonical = fs.realpathSync.native(root);
  const recordsByPath = new Map();

  function recordPath(requested) {
    if (typeof requested !== "string" || !requested) throw new Error("FINGERPRINT_PATH_INVALID");
    const absolute = path.resolve(canonical, requested);
    const relative = normalizeRelative(canonical, absolute);
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        recordsByPath.set(relative, { path: relative, state: "missing" });
        return;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      recordsByPath.set(relative, { path: relative, state: "symlink", target, sha256: sha256(target) });
      return;
    }
    if (stat.isDirectory()) {
      for (const child of walk(canonical, relative)) recordPath(child);
      return;
    }
    if (stat.isFile()) {
      const bytes = fs.readFileSync(absolute);
      recordsByPath.set(relative, { path: relative, state: "file", bytes: bytes.length, sha256: sha256(bytes) });
      return;
    }
    recordsByPath.set(relative, { path: relative, state: "other", mode: stat.mode, bytes: stat.size });
  }

  for (const requested of [...new Set(relativePaths)].sort()) recordPath(requested);
  const records = [...recordsByPath.values()].sort((a, b) => a.path.localeCompare(b.path) || a.state.localeCompare(b.state));
  return { fingerprint: sha256(records), records };
}

function git(repoRoot, args) {
  return childProcess.execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function parsePorcelainZ(status) {
  const tokens = (Buffer.isBuffer(status) ? status.toString("utf8") : String(status || "")).split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record.length < 3) continue;
    const statusCode = record.slice(0, 2);
    const current = record.slice(3);
    if (current) paths.push(current);
    if (/[RC]/.test(statusCode) && index + 1 < tokens.length) {
      const origin = tokens[++index];
      if (origin) paths.push(origin);
    }
  }
  return [...new Set(paths)].sort();
}

function repositoryKey(root) {
  return sha256(process.platform === "win32" ? root.toLowerCase() : root);
}

function repositoryFingerprint(repoRoot) {
  const root = fs.realpathSync.native(repoRoot);
  try {
    const revision = git(root, ["rev-parse", "HEAD"]);
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
    const status = childProcess.execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
    const dirtyEntries = parsePorcelainZ(status);
    const dirty = fingerprintFiles(root, dirtyEntries);
    const statusBase64 = status.toString("base64");
    return {
      root,
      repository_key: repositoryKey(root),
      revision,
      tree,
      clean: dirtyEntries.length === 0,
      dirty_paths: dirtyEntries,
      working_tree_fingerprint: sha256({ status: statusBase64, dirty: dirty.records }),
      content_fingerprint: sha256({ tree, status: statusBase64, dirty: dirty.records })
    };
  } catch (_) {
    const all = walk(root);
    const files = fingerprintFiles(root, all);
    return {
      root,
      repository_key: repositoryKey(root),
      revision: "unversioned-" + files.fingerprint.slice(0, 16),
      tree: null,
      clean: null,
      dirty_paths: all,
      working_tree_fingerprint: files.fingerprint,
      content_fingerprint: files.fingerprint
    };
  }
}

function environmentFingerprint(values = {}) {
  return sha256({ platform: process.platform, arch: process.arch, node: process.version, values });
}

function laneDescriptor({ namespace, repository, lane_id, contract_version, paths, dependencies = [], environment = {}, scope = null }) {
  if (!repository || typeof repository.root !== "string") throw new Error("LANE_REPOSITORY_ROOT_REQUIRED");
  const input = fingerprintFiles(repository.root, paths);
  const dependency = fingerprintFiles(repository.root, dependencies);
  return {
    namespace,
    repository_key: repository.repository_key,
    lane_id,
    contract_version,
    input_fingerprint: input.fingerprint,
    dependency_fingerprint: dependency.fingerprint,
    environment_fingerprint: environmentFingerprint(environment),
    source_revision: repository.revision,
    working_tree_fingerprint: repository.working_tree_fingerprint,
    scope,
    diagnostics: { input_records: input.records, dependency_records: dependency.records }
  };
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === "repo" && process.argv[3]) console.log(JSON.stringify(repositoryFingerprint(process.argv[3]), null, 2));
  else if (command === "files" && process.argv[3]) console.log(JSON.stringify(fingerprintFiles(process.argv[3], process.argv.slice(4).length ? process.argv.slice(4) : ["."]), null, 2));
  else {
    console.error("usage: node fingerprint.js repo <repo-root> | files <repo-root> <path...>");
    process.exitCode = 2;
  }
}

module.exports = { DEFAULT_IGNORES, normalizeRelative, walk, fingerprintFiles, parsePorcelainZ, repositoryFingerprint, environmentFingerprint, laneDescriptor, stableStringify };
