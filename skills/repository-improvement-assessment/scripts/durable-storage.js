"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const workspace = require("../../shared/project-intelligence-workspace/project-intelligence-workspace.js");
const { gitPreflight } = require("../baseline.js");

const MODES = new Set(["git", "content-addressed-degraded"]);
const CATEGORIES = new Set(["lineage", "assessments", "reports"]);

function fail(message) { throw new Error(`FAIL-RIA-DURABLE-STORAGE: ${message}`); }
function normalizeMode(mode = "git") {
  if (!MODES.has(mode)) fail(`unsupported durable mode ${mode}`);
  return mode;
}
function canonicalRoot(repositoryRoot, mode = "git") {
  const durableMode = normalizeMode(mode);
  if (durableMode === "git") return workspace.canonicalRepositoryRoot(repositoryRoot);
  const requested = path.resolve(repositoryRoot || process.cwd());
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) fail(`repository root is not a directory: ${requested}`);
  const root = fs.realpathSync.native(requested);
  if (gitPreflight(root).ok) fail("content-addressed-degraded cannot be used on a Git root");
  return root;
}
function repositoryKey(repositoryRoot, mode = "git") {
  const root = canonicalRoot(repositoryRoot, mode);
  if (mode === "git") return workspace.repositoryKey(root);
  const normalized = process.platform === "win32" ? root.toLowerCase() : root;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
function resolvePath(repositoryRoot, mode, category, ...segments) {
  if (!CATEGORIES.has(category)) fail(`unsupported category ${category}`);
  const durableMode = normalizeMode(mode);
  if (durableMode === "git") return workspace.resolvePath(repositoryRoot, category, ...segments);
  const root = canonicalRoot(repositoryRoot, durableMode);
  const base = path.join(root, ".project-intelligence", category);
  const target = path.resolve(base, ...segments.map(String));
  const relative = path.relative(base, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`${category} path escaped its durable root`);
  fs.mkdirSync(base, { recursive: true });
  return target;
}
function atomicWrite(filePath, bytes) { workspace.atomicWrite(filePath, bytes); }
function canonicalJsonBytes(value) { return workspace.canonicalJsonBytes(value); }
function storeJsonArtifact(repositoryRoot, mode, category, namespace, value) {
  const bytes = canonicalJsonBytes(value);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = resolvePath(repositoryRoot, mode, category, namespace, digest.slice(0, 2), `${digest}.json`);
  if (fs.existsSync(target)) {
    if (!fs.readFileSync(target).equals(bytes)) fail(`content address collision at ${target}`);
  } else atomicWrite(target, bytes);
  return Object.freeze({ path: target, sha256: digest, bytes: bytes.length });
}

module.exports = Object.freeze({ MODES, atomicWrite, canonicalJsonBytes, canonicalRoot, normalizeMode, repositoryKey, resolvePath, storeJsonArtifact });
