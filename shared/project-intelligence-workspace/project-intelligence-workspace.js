"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const SCHEMA_VERSION = "project-intelligence-workspace@1";
const WORKSPACE_DIR_NAME = ".project-intelligence";
const EXCLUDE_PATTERN = "/.project-intelligence/";
const DURABLE_TOP_LEVEL = Object.freeze([
  "lineage", "evidence", "verification", "assessments", "decisions", "execution", "reports", "artifacts", "logs",
  "snapshots", "predictive", "execution-evidence"
]);
const RECLAIMABLE_TOP_LEVEL = Object.freeze(["cache", "static-analysis-cache"]);
const EPHEMERAL_TOP_LEVEL = Object.freeze(["scratch"]);
const ALL_TOP_LEVEL = Object.freeze([...DURABLE_TOP_LEVEL, ...RECLAIMABLE_TOP_LEVEL, ...EPHEMERAL_TOP_LEVEL]);

function fail(code, message) { throw new Error(`${code}: ${message}`); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function atomicWrite(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* no-op */ }
  }
}
function runGit(repositoryRoot, args, { allowFailure = false } = {}) {
  const result = childProcess.spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail("FAIL-PROJECT-INTELLIGENCE-GIT", `${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return String(result.stdout || "").trim();
}
function canonicalRepositoryRoot(startPath = process.cwd(), { requireGit = true } = {}) {
  const requested = path.resolve(startPath);
  if (!fs.existsSync(requested)) fail("FAIL-PROJECT-INTELLIGENCE-REPOSITORY", `path does not exist: ${requested}`);
  const stat = fs.statSync(requested);
  const cwd = stat.isDirectory() ? requested : path.dirname(requested);
  const gitRoot = runGit(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: !requireGit });
  const resolved = gitRoot || cwd;
  const canonical = fs.realpathSync(resolved);
  if (requireGit && !gitRoot) fail("FAIL-PROJECT-INTELLIGENCE-REPOSITORY", "durable project state requires a Git repository root");
  return canonical;
}
function repositoryKey(repositoryRoot) {
  const canonical = canonicalRepositoryRoot(repositoryRoot);
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return sha256(normalized);
}
function gitCommonDir(repositoryRoot) {
  const repo = canonicalRepositoryRoot(repositoryRoot);
  const raw = runGit(repo, ["rev-parse", "--git-common-dir"]);
  if (!raw) fail("FAIL-PROJECT-INTELLIGENCE-GIT", "git did not return a common directory");
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(repo, raw);
  return fs.realpathSync(resolved);
}
function repositoryFamilyKey(repositoryRoot) {
  const common = gitCommonDir(repositoryRoot);
  const normalized = process.platform === "win32" ? common.toLowerCase() : common;
  return sha256(normalized);
}
function assertContained(root, candidate, label = "workspace path") {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("FAIL-PROJECT-INTELLIGENCE-CONTAINMENT", `${label} escaped ${root}`);
  }
  return candidate;
}
function workspaceRoot(repositoryRoot) {
  const repo = canonicalRepositoryRoot(repositoryRoot);
  return path.join(repo, WORKSPACE_DIR_NAME);
}
function layout(repositoryRoot) {
  const repository_root = canonicalRepositoryRoot(repositoryRoot);
  const root = path.join(repository_root, WORKSPACE_DIR_NAME);
  const paths = {
    root,
    manifest: path.join(root, "workspace.json"),
    lineage: path.join(root, "lineage"),
    evidence: path.join(root, "evidence"),
    verification: path.join(root, "verification"),
    assessments: path.join(root, "assessments"),
    decisions: path.join(root, "decisions"),
    execution: path.join(root, "execution"),
    reports: path.join(root, "reports"),
    artifacts: path.join(root, "artifacts"),
    cache: path.join(root, "cache"),
    scratch: path.join(root, "scratch"),
    logs: path.join(root, "logs"),
    snapshots: path.join(root, "snapshots"),
    predictive: path.join(root, "predictive"),
    "execution-evidence": path.join(root, "execution-evidence"),
    "static-analysis-cache": path.join(root, "static-analysis-cache"),
  };
  for (const [name, value] of Object.entries(paths)) if (name !== "root") assertContained(root, value, name);
  return { repository_root, repository_key: repositoryKey(repository_root), worktree_key: repositoryKey(repository_root), repository_family_key: repositoryFamilyKey(repository_root), git_common_dir: gitCommonDir(repository_root), workspace_root: root, paths };
}
function gitExcludePath(repositoryRoot) {
  const repo = canonicalRepositoryRoot(repositoryRoot);
  const raw = runGit(repo, ["rev-parse", "--git-path", "info/exclude"]);
  if (!raw) fail("FAIL-PROJECT-INTELLIGENCE-GIT-EXCLUDE", "git did not return info/exclude path");
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(repo, raw);
}
function ensureLocalGitExclude(repositoryRoot) {
  const filePath = gitExcludePath(repositoryRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map(line => line.trim());
  if (lines.includes(EXCLUDE_PATTERN)) return { path: filePath, changed: false, pattern: EXCLUDE_PATTERN };
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : os.EOL;
  fs.appendFileSync(filePath, `${separator}${EXCLUDE_PATTERN}${os.EOL}`, "utf8");
  return { path: filePath, changed: true, pattern: EXCLUDE_PATTERN };
}
function ensureWorkspace(repositoryRoot, { excludeFromGit = true } = {}) {
  const resolved = layout(repositoryRoot);
  fs.mkdirSync(resolved.workspace_root, { recursive: true });
  for (const name of ALL_TOP_LEVEL) fs.mkdirSync(resolved.paths[name], { recursive: true });
  const now = new Date().toISOString();
  let createdAt = now;
  if (fs.existsSync(resolved.paths.manifest)) {
    try { createdAt = JSON.parse(fs.readFileSync(resolved.paths.manifest, "utf8")).created_at || now; } catch { /* replace malformed local manifest */ }
  }
  const manifest = {
    schema_version: SCHEMA_VERSION,
    workspace_version: 1,
    repository_key: resolved.repository_key,
    worktree_key: resolved.worktree_key,
    repository_family_key: resolved.repository_family_key,
    git_common_dir: resolved.git_common_dir,
    directory: WORKSPACE_DIR_NAME,
    created_at: createdAt,
    updated_at: now,
    lifetimes: {
      durable: [...DURABLE_TOP_LEVEL],
      reclaimable: [...RECLAIMABLE_TOP_LEVEL],
      ephemeral: [...EPHEMERAL_TOP_LEVEL],
    },
  };
  atomicWrite(resolved.paths.manifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  const git_exclude = excludeFromGit ? ensureLocalGitExclude(resolved.repository_root) : null;
  return { ...resolved, manifest, git_exclude };
}
function resolvePath(repositoryRoot, category, ...segments) {
  if (!ALL_TOP_LEVEL.includes(category)) fail("FAIL-PROJECT-INTELLIGENCE-CATEGORY", `unsupported category: ${category}`);
  const resolved = ensureWorkspace(repositoryRoot);
  const base = resolved.paths[category];
  const candidate = path.resolve(base, ...segments.map(segment => String(segment)));
  assertContained(base, candidate, `${category} path`);
  return candidate;
}
function contentAddressedPath(repositoryRoot, category, namespace, digest, extension = ".json") {
  if (!/^[a-f0-9]{64}$/.test(String(digest))) fail("FAIL-PROJECT-INTELLIGENCE-DIGEST", "content address must be a lowercase sha256 digest");
  if (!/^\.[A-Za-z0-9._-]+$/.test(extension)) fail("FAIL-PROJECT-INTELLIGENCE-EXTENSION", "extension must start with '.' and contain only safe characters");
  return resolvePath(repositoryRoot, category, namespace, digest.slice(0, 2), `${digest}${extension}`);
}
function reportPath(repositoryRoot, owner, filename) {
  const safeOwner = String(owner).replace(/[^A-Za-z0-9._-]+/g, "-");
  const safeFile = String(filename).replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!safeOwner || !safeFile) fail("FAIL-PROJECT-INTELLIGENCE-REPORT", "owner and filename must be non-empty");
  return resolvePath(repositoryRoot, "reports", safeOwner, safeFile);
}
function assessmentPath(repositoryRoot, owner, revision, filename = "assessment.json") {
  const safeOwner = String(owner).replace(/[^A-Za-z0-9._-]+/g, "-");
  const safeRevision = String(revision).replace(/[^A-Za-z0-9._-]+/g, "-");
  return resolvePath(repositoryRoot, "assessments", safeOwner, safeRevision, filename);
}
function decisionPath(repositoryRoot, owner, session, filename) {
  return resolvePath(repositoryRoot, "decisions", String(owner), String(session), String(filename));
}
function legacyPath(repositoryRoot, relativePath) {
  const repo = canonicalRepositoryRoot(repositoryRoot);
  const candidate = path.resolve(repo, relativePath);
  assertContained(repo, candidate, "legacy path");
  return candidate;
}
function firstExisting(repositoryRoot, preferredPath, legacyRelativePaths = []) {
  if (fs.existsSync(preferredPath)) return { path: preferredPath, source: "workspace" };
  for (const relative of legacyRelativePaths) {
    const candidate = legacyPath(repositoryRoot, relative);
    if (fs.existsSync(candidate)) return { path: candidate, source: "legacy" };
  }
  return { path: preferredPath, source: "workspace" };
}
function shortScratchBase(repositoryRoot, { platform = process.platform } = {}) {
  const key = repositoryKey(repositoryRoot).slice(0, 12);
  if (platform === "win32") {
    const drive = process.env.SystemDrive && /^[A-Za-z]:$/.test(process.env.SystemDrive) ? process.env.SystemDrive : "C:";
    return path.win32.join(drive + "\\", "pi-tmp", key);
  }
  return path.join(os.tmpdir(), "pi-tmp", key);
}
function createScratchSession(repositoryRoot, purpose, { shortPathRequired = false, platform = process.platform } = {}) {
  const safePurpose = String(purpose || "session").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "session";
  const workspace = ensureWorkspace(repositoryRoot);
  const base = shortPathRequired ? shortScratchBase(repositoryRoot, { platform }) : workspace.paths.scratch;
  fs.mkdirSync(base, { recursive: true });
  const prefix = path.join(base, `${safePurpose}-`);
  const directory = fs.mkdtempSync(prefix);
  return {
    path: directory,
    external: shortPathRequired,
    lifetime: "ephemeral",
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}
function cleanupScratch(repositoryRoot) {
  const workspace = ensureWorkspace(repositoryRoot);
  fs.rmSync(workspace.paths.scratch, { recursive: true, force: true });
  fs.mkdirSync(workspace.paths.scratch, { recursive: true });
  return workspace.paths.scratch;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}
function canonicalJsonBytes(value) { return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8"); }
function storeJsonArtifact(repositoryRoot, category, namespace, value) {
  const bytes = canonicalJsonBytes(value);
  const digest = sha256(bytes);
  const target = contentAddressedPath(repositoryRoot, category, namespace, digest, ".json");
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (!existing.equals(bytes)) fail("FAIL-PROJECT-INTELLIGENCE-IMMUTABILITY", `content address collision at ${target}`);
  } else atomicWrite(target, bytes);
  return Object.freeze({ path: target, sha256: digest, bytes: bytes.length });
}

function pruneReclaimable(repositoryRoot, { olderThanDays = 30, dryRun = true, now = Date.now() } = {}) {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) fail("FAIL-PROJECT-INTELLIGENCE-PRUNE", "olderThanDays must be a nonnegative number");
  const resolved = ensureWorkspace(repositoryRoot);
  const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const category of RECLAIMABLE_TOP_LEVEL) {
    const base = resolved.paths[category];
    const stack = [base];
    while (stack.length) {
      const current = stack.pop();
      let entries = []; try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(target);
        else if (entry.isFile()) {
          const stat = fs.statSync(target);
          if (stat.mtimeMs <= cutoff) candidates.push({ category, path: target, bytes: stat.size, mtime_ms: stat.mtimeMs });
        }
      }
    }
  }
  if (!dryRun) for (const item of candidates) fs.rmSync(item.path, { force: true });
  return Object.freeze({ dry_run: Boolean(dryRun), older_than_days: olderThanDays, files: candidates, reclaimable_bytes: candidates.reduce((sum,item)=>sum+item.bytes,0) });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  WORKSPACE_DIR_NAME,
  EXCLUDE_PATTERN,
  DURABLE_TOP_LEVEL,
  RECLAIMABLE_TOP_LEVEL,
  EPHEMERAL_TOP_LEVEL,
  atomicWrite,
  canonicalJsonBytes,
  storeJsonArtifact,
  canonicalRepositoryRoot,
  repositoryKey,
  gitCommonDir,
  repositoryFamilyKey,
  layout,
  workspaceRoot,
  gitExcludePath,
  ensureLocalGitExclude,
  ensureWorkspace,
  resolvePath,
  contentAddressedPath,
  reportPath,
  assessmentPath,
  decisionPath,
  legacyPath,
  firstExisting,
  shortScratchBase,
  createScratchSession,
  cleanupScratch,
  pruneReclaimable,
});
