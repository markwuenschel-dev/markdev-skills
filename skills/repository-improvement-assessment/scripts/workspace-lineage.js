#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const storage = require("./durable-storage.js");

const SCHEMA_VERSION = "ria.artifact-lineage@1";
const KINDS = Object.freeze({
  sei: "sei_artifacts",
  verification: "verification_artifacts",
  owner: "owner_artifacts"
});

function emptyLineage(repositoryRoot, { durableMode = "git" } = {}) {
  const root = storage.canonicalRoot(repositoryRoot, durableMode);
  return {
    schema_version: SCHEMA_VERSION,
    repository_key: storage.repositoryKey(root, durableMode),
    repository_root: root,
    sei_artifacts: [],
    verification_artifacts: [],
    owner_artifacts: [],
    updated_at: null
  };
}

function lineagePath(repositoryRoot, { durableMode = "git" } = {}) {
  return storage.resolvePath(repositoryRoot, durableMode, "lineage", "ria-artifacts.json");
}

function loadLineage(repositoryRoot, { durableMode = "git" } = {}) {
  const base = emptyLineage(repositoryRoot, { durableMode });
  const target = lineagePath(repositoryRoot, { durableMode });
  if (!fs.existsSync(target)) return base;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(target, "utf8")); }
  catch (error) { throw new Error(`FAIL-RIA-LINEAGE: invalid JSON at ${target}: ${error.message}`); }
  if (!parsed || parsed.schema_version !== SCHEMA_VERSION) throw new Error(`FAIL-RIA-LINEAGE: unsupported lineage schema at ${target}`);
  if (parsed.repository_key !== base.repository_key) throw new Error(`FAIL-RIA-LINEAGE: repository identity mismatch at ${target}`);
  return {
    ...base,
    ...parsed,
    repository_root: base.repository_root,
    sei_artifacts: Array.isArray(parsed.sei_artifacts) ? parsed.sei_artifacts : [],
    verification_artifacts: Array.isArray(parsed.verification_artifacts) ? parsed.verification_artifacts : [],
    owner_artifacts: Array.isArray(parsed.owner_artifacts) ? parsed.owner_artifacts : []
  };
}

function stableRecordKey(kind, record) {
  if (kind === "sei") return [record.repository_key, record.revision, record.engine_version, record.config_hash, record.execution_contract_hash, record.working_tree_fingerprint].join("|");
  if (kind === "verification") return [record.repository_key, record.revision, record.baseline_sha256, record.verifier_version, record.contract_hash, record.config_hash, record.content_sha256, record.file_sha256, record.working_tree_fingerprint].join("|");
  if (kind === "owner") return [record.owner, record.owner_version, record.repository_key, record.revision, record.baseline_sha256, record.engineering_intelligence_sha256, record.runtime_contract_sha256, record.working_tree_fingerprint].join("|");
  throw new Error(`FAIL-RIA-LINEAGE: unsupported artifact kind ${kind}`);
}

function validateRecord(kind, record, repositoryKey) {
  if (!record || typeof record !== "object") throw new Error(`FAIL-RIA-LINEAGE: ${kind} record must be an object`);
  if (record.repository_key !== repositoryKey) throw new Error(`FAIL-RIA-LINEAGE: ${kind} repository_key mismatch`);
  if (typeof record.path !== "string" || !record.path) throw new Error(`FAIL-RIA-LINEAGE: ${kind} record path is required`);
  if (kind === "verification") {
    if (!/^[0-9a-f]{64}$/.test(record.content_sha256 ?? "")) throw new Error("FAIL-RIA-LINEAGE: verification record content_sha256 is invalid");
    if (!/^[0-9a-f]{64}$/.test(record.file_sha256 ?? "")) throw new Error("FAIL-RIA-LINEAGE: verification record file_sha256 is invalid");
  } else if (!/^[0-9a-f]{64}$/.test(record.sha256 ?? "")) throw new Error(`FAIL-RIA-LINEAGE: ${kind} record sha256 is invalid`);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.revision ?? "")) throw new Error(`FAIL-RIA-LINEAGE: ${kind} record revision is invalid`);
}

function writeLineage(repositoryRoot, lineage, { durableMode = "git" } = {}) {
  const root = storage.canonicalRoot(repositoryRoot, durableMode);
  const target = lineagePath(root, { durableMode });
  const base = emptyLineage(root, { durableMode });
  const next = {
    ...base,
    ...lineage,
    schema_version: SCHEMA_VERSION,
    repository_key: base.repository_key,
    repository_root: base.repository_root,
    updated_at: new Date().toISOString()
  };
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8");
  storage.atomicWrite(target, bytes);
  return { path: target, lineage: next };
}

function recordArtifact(repositoryRoot, kind, record, { durableMode = "git" } = {}) {
  const field = KINDS[kind];
  if (!field) throw new Error(`FAIL-RIA-LINEAGE: unsupported artifact kind ${kind}`);
  const current = loadLineage(repositoryRoot, { durableMode });
  validateRecord(kind, record, current.repository_key);
  const normalized = { ...record, path: path.resolve(record.path), recorded_at: record.recorded_at ?? new Date().toISOString() };
  const key = stableRecordKey(kind, normalized);
  const prior = current[field] ?? [];
  const filtered = prior.filter(item => stableRecordKey(kind, item) !== key);
  current[field] = [...filtered, normalized];
  const written = writeLineage(repositoryRoot, current, { durableMode });
  publishCurrent(repositoryRoot, { durableMode, lineage: written.lineage });
  return written;
}

function currentPath(repositoryRoot, { durableMode = "git" } = {}) {
  return storage.resolvePath(repositoryRoot, durableMode, "lineage", "ria-current.json");
}

function latestByOwner(records) {
  const latest = {};
  for (const record of records || []) if (record?.owner) latest[record.owner] = record;
  return latest;
}

function publishCurrent(repositoryRoot, { durableMode = "git", lineage = null, assess = null } = {}) {
  const currentLineage = lineage ?? loadLineage(repositoryRoot, { durableMode });
  const pointer = {
    schema_version: "ria.current-refs@1",
    sei: (currentLineage.sei_artifacts || []).at(-1) ?? null,
    verification: (currentLineage.verification_artifacts || []).at(-1) ?? null,
    owners: latestByOwner(currentLineage.owner_artifacts),
    assess: assess ?? null,
    lineage_path: lineagePath(repositoryRoot, { durableMode }),
    updated_at: new Date().toISOString()
  };
  const target = currentPath(repositoryRoot, { durableMode });
  storage.atomicWrite(target, Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8"));
  return { path: target, current: pointer };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "-h") { out["-h"] = true; continue; }
    if (!value.startsWith("--")) { out._.push(value); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[value] = next; i += 1; }
    else out[value] = true;
  }
  return out;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args["--help"] || args["-h"]) {
      process.stdout.write("usage: workspace-lineage.js [show|record] --repo <repo> [--durable-mode git|content-addressed-degraded] [--kind sei|verification|owner --input <record.json>]\n");
      process.exit(0);
    }
    const action = args._[0] ?? "show";
    const repo = args["--repo"] ?? process.cwd();
    const durableMode = args["--durable-mode"] ?? "git";
    storage.normalizeMode(durableMode);
    if (action === "show") process.stdout.write(JSON.stringify(loadLineage(repo, { durableMode }), null, 2) + "\n");
    else if (action === "record") {
      const kind = args["--kind"];
      const input = args["--input"];
      if (!kind || !input) throw new Error("usage: workspace-lineage.js record --repo <repo> --kind sei|verification|owner --input <record.json>");
      const record = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
      const result = recordArtifact(repo, kind, record, { durableMode });
      process.stdout.write(JSON.stringify({ path: result.path, kind, status: "recorded" }, null, 2) + "\n");
    } else throw new Error(`unknown action ${action}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { SCHEMA_VERSION, emptyLineage, lineagePath, loadLineage, writeLineage, recordArtifact, stableRecordKey, currentPath, publishCurrent };
