"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SHA = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATH_KINDS = new Set(["exact-existing", "allowed-absent-generated", "pattern"]);
const AUTHORIZATION_STATES = new Set(["granted", "denied", "inherited"]);
const SCOPES = new Set(["head", "worktree"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, "utf8"); }
function sha256(value) { return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex"); }
function fail(code, detail) { throw new Error(`${code}: ${detail}`); }
function git(root, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = childProcess.spawnSync("git", ["-C", root, ...args], { encoding, windowsHide: true });
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail("FAIL-RIA-GIT-PREFLIGHT", `${args.join(" ")} failed for ${root}: ${String(result.stderr || result.stdout || "").trim()}`);
  }
  return encoding === "buffer" ? result.stdout : String(result.stdout || "").trim();
}
function normalizedRoot(root) {
  const requested = path.resolve(String(root || ""));
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    fail("FAIL-RIA-BASELINE-ROOT", `repository root is not a directory: ${requested}`);
  }
  return fs.realpathSync.native(requested);
}
function normalizedPathKey(value) { return process.platform === "win32" ? value.toLowerCase() : value; }

function gitPreflight(root) {
  const canonicalRoot = normalizedRoot(root);
  const topLevel = git(canonicalRoot, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!topLevel) return Object.freeze({ ok: false, root: canonicalRoot, code: "NOT_GIT" });
  const resolvedTop = fs.realpathSync.native(topLevel);
  if (normalizedPathKey(resolvedTop) !== normalizedPathKey(canonicalRoot)) {
    fail("FAIL-RIA-GIT-PREFLIGHT", `declared root ${canonicalRoot} is inside ${resolvedTop}; declare the Git root explicitly`);
  }
  const revision = git(canonicalRoot, ["rev-parse", "HEAD"]);
  const tree = git(canonicalRoot, ["rev-parse", "HEAD^{tree}"]);
  const status = git(canonicalRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" });
  return Object.freeze({
    ok: true,
    root: canonicalRoot,
    repository_key: sha256(normalizedPathKey(canonicalRoot)),
    revision,
    tree,
    clean: status.length === 0,
    working_tree_fingerprint: sha256(status),
  });
}

function treeEntries(root) {
  const rows = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => ![".git", ".project-intelligence"].includes(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) rows.push({ path: relative, sha256: sha256(fs.readFileSync(target)) });
      else if (entry.isSymbolicLink()) rows.push({ path: relative, symlink: fs.readlinkSync(target) });
    }
  };
  visit(root);
  return rows;
}

function nonGitIdentity(root) {
  const canonicalRoot = normalizedRoot(root);
  const entries = treeEntries(canonicalRoot);
  const tree = sha256(canonicalJson(entries));
  return Object.freeze({
    ok: false,
    root: canonicalRoot,
    repository_key: sha256(normalizedPathKey(canonicalRoot)),
    revision: tree,
    tree,
    clean: null,
    working_tree_fingerprint: tree,
    content_entries: entries.length,
  });
}

function normalizePathSpecs(specs, roots) {
  if (!Array.isArray(specs)) fail("FAIL-RIA-BASELINE-PATH", "generated_protected_paths must be an array");
  const seen = new Set();
  return specs.map((spec, index) => {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail("FAIL-RIA-BASELINE-PATH", `entry ${index} must be an object`);
    const keys = Object.keys(spec);
    if (keys.some((key) => !["kind", "path", "root_index", "purpose"].includes(key))) fail("FAIL-RIA-BASELINE-PATH", `entry ${index} is not closed`);
    const kind = String(spec.kind || "");
    const relative = String(spec.path || "").split("\\").join("/");
    const rootIndex = Number(spec.root_index ?? 0);
    if (!PATH_KINDS.has(kind) || !relative || path.posix.isAbsolute(relative) || relative.includes("\0") || relative.split("/").includes("..")) {
      fail("FAIL-RIA-BASELINE-PATH", `entry ${index} has an invalid kind or relative path`);
    }
    if (!Number.isInteger(rootIndex) || rootIndex < 0 || rootIndex >= roots.length) fail("FAIL-RIA-BASELINE-PATH", `entry ${index} root_index is invalid`);
    if (kind === "pattern") {
      try { new RegExp(relative.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*")); }
      catch { fail("FAIL-RIA-BASELINE-PATH", `entry ${index} pattern is invalid`); }
    } else {
      const resolved = path.resolve(roots[rootIndex].root, ...relative.split("/"));
      const rel = path.relative(roots[rootIndex].root, resolved);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail("FAIL-RIA-BASELINE-PATH", `entry ${index} escapes its root`);
      if (kind === "exact-existing" && !fs.existsSync(resolved)) fail("FAIL-RIA-BASELINE-PATH", `required path does not exist: ${relative}`);
    }
    const key = `${rootIndex}|${kind}|${relative}`;
    if (seen.has(key)) fail("FAIL-RIA-BASELINE-PATH", `duplicate entry ${key}`);
    seen.add(key);
    return canonical({ kind, path: relative, root_index: rootIndex, purpose: spec.purpose == null ? null : String(spec.purpose) });
  }).sort((a, b) => a.root_index - b.root_index || a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
}

function normalizeAuthorization(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("FAIL-RIA-AUTHORIZATION", "command authorization is required");
  if (Object.keys(value).some((key) => !["state", "authorization_ref", "inherited_from", "commands"].includes(key))) fail("FAIL-RIA-AUTHORIZATION", "authorization is not closed");
  const state = String(value.state || "");
  if (!AUTHORIZATION_STATES.has(state)) fail("FAIL-RIA-AUTHORIZATION", "state must be granted, denied, or inherited");
  if (state === "inherited" && !value.inherited_from) fail("FAIL-RIA-AUTHORIZATION", "inherited authorization requires inherited_from");
  const commands = Array.isArray(value.commands) ? [...new Set(value.commands.map(String))].sort() : [];
  return canonical({ state, authorization_ref: value.authorization_ref == null ? null : String(value.authorization_ref), inherited_from: value.inherited_from == null ? null : String(value.inherited_from), commands });
}

function validateCompatibility(value) {
  const required = ["engine_version", "effective_configuration", "config_hash", "execution_contract_hash", "history_window", "history_window_hash", "assessment_schema_version", "analyzer_capabilities", "analyzer_capability_hash"];
  if (!value || typeof value !== "object" || required.some((key) => !Object.hasOwn(value, key))) fail("FAIL-RIA-SEI-COMPATIBILITY", "compatibility binding is incomplete");
  if (![value.config_hash, value.execution_contract_hash, value.history_window_hash, value.analyzer_capability_hash].every((item) => SHA.test(item || ""))) fail("FAIL-RIA-SEI-COMPATIBILITY", "compatibility hashes are invalid");
  return canonical(value);
}

function baselineBody(input) {
  if (!input || typeof input !== "object") fail("FAIL-RIA-BASELINE", "input must be an object");
  const declaredRoots = input.repository?.roots ?? (input.repository?.root ? [input.repository.root] : []);
  if (!Array.isArray(declaredRoots) || declaredRoots.length === 0) fail("FAIL-RIA-BASELINE", "at least one repository root is required");
  const durableMode = input.durable_mode ?? "git";
  if (!new Set(["git", "content-addressed-degraded"]).has(durableMode)) fail("FAIL-RIA-BASELINE", "durable_mode is invalid");
  const scope = input.scope ?? (durableMode === "git" ? "head" : "worktree");
  if (!SCOPES.has(scope)) fail("FAIL-RIA-BASELINE", "scope must be head or worktree");
  if (durableMode === "content-addressed-degraded" && scope !== "worktree") fail("FAIL-RIA-BASELINE", "non-Git degraded mode supports only worktree scope");
  const roots = declaredRoots.map((root) => {
    const preflight = gitPreflight(root);
    if (!preflight.ok && durableMode === "git") fail("FAIL-RIA-GIT-PREFLIGHT", `normal durable mode requires Git: ${preflight.root}`);
    if (preflight.ok && scope === "head" && !preflight.clean) fail("FAIL-RIA-BASELINE-SCOPE", `head scope requires a clean checkout: ${preflight.root}`);
    if (preflight.ok && scope === "worktree") {
      const surface = sha256(canonicalJson(treeEntries(preflight.root)));
      return Object.freeze({ ...preflight, head_revision: preflight.revision, revision: sha256(canonicalJson({ head_revision: preflight.revision, surface })), tree: surface, working_tree_fingerprint: surface });
    }
    return preflight.ok ? preflight : nonGitIdentity(root);
  }).sort((a, b) => normalizedPathKey(a.root).localeCompare(normalizedPathKey(b.root)));
  if (durableMode === "content-addressed-degraded" && roots.some((root) => root.ok)) {
    fail("FAIL-RIA-BASELINE", "content-addressed-degraded is only for non-Git roots");
  }
  const rootRecords = roots.map((root) => canonical({
    root: root.root,
    repository_key: root.repository_key,
    revision: root.revision,
    head_revision: root.head_revision ?? (root.ok ? root.revision : null),
    tree: root.tree,
    working_tree: { clean: root.clean, fingerprint: root.working_tree_fingerprint },
    history: root.ok ? "git" : "fresh-only-content-addressed",
  }));
  const revision = roots.length === 1 ? roots[0].revision : sha256(canonicalJson(rootRecords.map((root) => ({ repository_key: root.repository_key, revision: root.revision, tree: root.tree }))));
  return canonical({
    schema_version: "ria.baseline@1",
    repository: {
      mode: durableMode === "git" ? "git" : "content-addressed-degraded",
      scope,
      repository_id: sha256(canonicalJson(rootRecords.map((root) => root.repository_key))),
      revision,
      roots: rootRecords,
      ancestor_reuse_allowed: durableMode === "git" && scope === "head",
    },
    generated_protected_paths: normalizePathSpecs(input.generated_protected_paths ?? [], roots),
    command_authorization: normalizeAuthorization(input.command_authorization),
    verification_contract: canonical(input.verification_contract ?? {}),
    sei_compatibility_binding: validateCompatibility(input.sei_compatibility_binding),
    history_binding: canonical(input.history_binding ?? { kind: durableMode === "git" ? "git" : "fresh-only", roots: rootRecords.map((root) => ({ repository_key: root.repository_key, revision: root.revision })) }),
    environment_toolchain: canonical(input.environment_toolchain ?? {}),
    provenance: canonical(input.provenance ?? {}),
  });
}

function buildBaseline(input) {
  const body = baselineBody(input);
  const contentHash = sha256(canonicalJson(body));
  return Object.freeze(canonical({ ...body, artifact_id: `ria-baseline:${contentHash}`, content_sha256: contentHash }));
}

function verifyBaseline(value) {
  try {
    if (!value || typeof value !== "object" || value.schema_version !== "ria.baseline@1") fail("FAIL-RIA-BASELINE-VERIFY", "schema version is invalid");
    const allowed = ["schema_version", "artifact_id", "content_sha256", "repository", "generated_protected_paths", "command_authorization", "verification_contract", "sei_compatibility_binding", "history_binding", "environment_toolchain", "provenance"];
    if (Object.keys(value).some((key) => !allowed.includes(key))) fail("FAIL-RIA-BASELINE-VERIFY", "artifact is not closed");
    if (!SHA.test(value.content_sha256 || "") || value.artifact_id !== `ria-baseline:${value.content_sha256}`) fail("FAIL-RIA-BASELINE-VERIFY", "artifact identity is invalid");
    if (!REVISION.test(value.repository?.revision || "")) fail("FAIL-RIA-BASELINE-VERIFY", "repository revision is invalid");
    if (!SCOPES.has(value.repository?.scope)) fail("FAIL-RIA-BASELINE-VERIFY", "repository scope is invalid");
    if (value.repository.mode === "content-addressed-degraded" && value.repository.scope !== "worktree") fail("FAIL-RIA-BASELINE-VERIFY", "degraded baseline must use worktree scope");
    normalizeAuthorization(value.command_authorization);
    validateCompatibility(value.sei_compatibility_binding);
    const body = canonical(Object.fromEntries(Object.entries(value).filter(([key]) => !["artifact_id", "content_sha256"].includes(key))));
    if (sha256(canonicalJson(body)) !== value.content_sha256) fail("FAIL-RIA-BASELINE-VERIFY", "content hash mismatch");
    return { ok: true, errors: [], baseline_ref: { artifact_id: value.artifact_id, sha256: value.content_sha256, repository_revision: value.repository.revision } };
  } catch (error) { return { ok: false, errors: [error.message] }; }
}

function writeBaseline(filePath, value) {
  const verified = verifyBaseline(value);
  if (!verified.ok) fail("FAIL-RIA-BASELINE-WRITE", verified.errors.join("; "));
  const target = path.resolve(filePath);
  const bytes = canonicalBytes(value);
  const fileSha256 = sha256(bytes);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (!fs.readFileSync(target).equals(bytes)) fail("FAIL-RIA-BASELINE-WRITE", `immutable target differs: ${target}`);
    return Object.freeze({ path: target, reused: true, content_sha256: value.content_sha256, file_sha256: fileSha256 });
  }
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try { fs.writeFileSync(temporary, bytes, { flag: "wx" }); fs.renameSync(temporary, target); }
  finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
  return Object.freeze({ path: target, reused: false, content_sha256: value.content_sha256, file_sha256: fileSha256 });
}

module.exports = { AUTHORIZATION_STATES, PATH_KINDS, SCOPES, baselineBody, buildBaseline, canonical, canonicalBytes, canonicalJson, gitPreflight, nonGitIdentity, sha256, treeEntries, verifyBaseline, writeBaseline };
