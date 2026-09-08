"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const workspace = require("../project-intelligence-workspace/project-intelligence-workspace.js");

const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA = /^[0-9a-f]{64}$/;
const STATES = new Set(["passed", "failed", "unavailable", "skipped", "timed-out"]);
const ISOLATION = new Set(["worktree", "copy", "container", "read-only-source", "caller-attested", "none"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function pretty(value) { return `${JSON.stringify(canonical(value), null, 2)}\n`; }
function sha256(value) { return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : typeof value === "string" ? value : canonicalJson(value)).digest("hex"); }
function fail(detail) { throw new Error(`FAIL-VERIFICATION-BASELINE: ${detail}`); }
function closed(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(`${label} is not closed`);
}
function ref(value, label) {
  closed(value, ["artifact_id", "repository_revision", "sha256"], label);
  if (!value.artifact_id || !SHA.test(value.sha256) || !REVISION.test(value.repository_revision)) fail(`${label} is invalid`);
  return canonical(value);
}

function normalizeInput(input) {
  closed(input, ["baseline_ref", "commands", "coverage", "created_at", "environment", "isolation", "repository"], "input");
  closed(input.repository, ["repository_id", "revision", "working_tree_fingerprint"], "repository");
  if (!input.repository.repository_id || !REVISION.test(input.repository.revision) || !input.repository.working_tree_fingerprint) fail("repository binding is invalid");
  const baseline = ref(input.baseline_ref, "baseline_ref");
  if (baseline.repository_revision !== input.repository.revision) fail("baseline revision differs from verification revision");
  closed(input.isolation, ["mode", "path", "source_repository_mutated"], "isolation");
  if (!ISOLATION.has(input.isolation.mode) || input.isolation.source_repository_mutated !== false || (input.isolation.path !== null && typeof input.isolation.path !== "string")) fail("isolation receipt is invalid");
  if (!Array.isArray(input.commands)) fail("commands must be an array");
  const ids = new Set();
  const commands = input.commands.map((command, index) => {
    closed(command, ["command", "duration_ms", "evidence", "exit_code", "id", "reason", "status"], `command ${index}`);
    if (!command.id || ids.has(command.id) || !command.command || !STATES.has(command.status) || !Number.isFinite(command.duration_ms) || command.duration_ms < 0 || !Array.isArray(command.evidence) || command.evidence.some((item) => typeof item !== "string" || !item)) fail(`command ${index} is invalid`);
    ids.add(command.id);
    if (!Number.isInteger(command.exit_code) && command.exit_code !== null) fail(`command ${index} exit_code is invalid`);
    return canonical({ ...command, evidence: [...new Set(command.evidence)].sort(), reason: command.reason ?? null });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const summary = { passed: 0, failed: 0, unavailable: 0, skipped: 0, timed_out: 0, duration_ms: 0 };
  for (const command of commands) {
    summary.duration_ms += command.duration_ms;
    if (command.status === "timed-out") summary.timed_out += 1;
    else summary[command.status] += 1;
  }
  const createdAt = input.created_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) fail("created_at is invalid");
  return canonical({ schema_version: "assessment-verification-baseline@2", repository: input.repository, baseline_ref: baseline, isolation: input.isolation, commands, summary, environment: input.environment ?? {}, coverage: input.coverage ?? {}, created_at: createdAt });
}

function createVerificationBaseline(input) {
  const body = normalizeInput(input);
  const contentSha256 = sha256(body);
  return Object.freeze(canonical({ ...body, artifact_id: `assessment-verification:${contentSha256}`, content_sha256: contentSha256 }));
}

function verifyVerificationBaseline(value) {
  try {
    closed(value, ["artifact_id", "baseline_ref", "commands", "content_sha256", "coverage", "created_at", "environment", "isolation", "repository", "schema_version", "summary"], "artifact");
    if (value.schema_version !== "assessment-verification-baseline@2" || !SHA.test(value.content_sha256) || value.artifact_id !== `assessment-verification:${value.content_sha256}`) fail("artifact identity is invalid");
    const reconstructed = createVerificationBaseline({ repository: value.repository, baseline_ref: value.baseline_ref, isolation: value.isolation, commands: value.commands, environment: value.environment, coverage: value.coverage, created_at: value.created_at });
    if (pretty(reconstructed) !== pretty(value)) fail("artifact bytes are not canonical or summary/content hash drifted");
    return { ok: true, errors: [], content_sha256: value.content_sha256 };
  } catch (error) { return { ok: false, errors: [error.message] }; }
}

function writeVerificationBaseline(filePath, value) {
  const validation = verifyVerificationBaseline(value);
  if (!validation.ok) fail(validation.errors.join("; "));
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = Buffer.from(pretty(value), "utf8");
  const fileSha256 = sha256(bytes);
  if (fs.existsSync(target)) {
    if (!fs.readFileSync(target).equals(bytes)) fail("immutable artifact target contains different bytes");
    return { path: target, reused: true, content_sha256: value.content_sha256, file_sha256: fileSha256 };
  }
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try { fs.writeFileSync(temporary, bytes, { flag: "wx" }); fs.renameSync(temporary, target); }
  finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
  return { path: target, reused: false, content_sha256: value.content_sha256, file_sha256: fileSha256 };
}

function verifyVerificationBaselineFile(filePath, expected = {}) {
  try {
    const bytes = fs.readFileSync(path.resolve(filePath));
    const fileSha256 = sha256(bytes);
    if (expected.file_sha256 && expected.file_sha256 !== fileSha256) fail("file byte hash mismatch");
    const value = JSON.parse(bytes.toString("utf8"));
    const validation = verifyVerificationBaseline(value);
    if (!validation.ok) fail(validation.errors.join("; "));
    if (expected.content_sha256 && expected.content_sha256 !== value.content_sha256) fail("semantic content hash mismatch");
    return { ok: true, errors: [], artifact: value, content_sha256: value.content_sha256, file_sha256: fileSha256 };
  } catch (error) { return { ok: false, errors: [error.message] }; }
}

function writeVerificationBaselineForRepository(repositoryRoot, value) {
  const validation = verifyVerificationBaseline(value);
  if (!validation.ok) fail(validation.errors.join("; "));
  const target = workspace.resolvePath(repositoryRoot, "verification", "assessment-baseline", value.repository.revision, `${value.content_sha256}.json`);
  return writeVerificationBaseline(target, value);
}

module.exports = { ISOLATION, createVerificationBaseline, verifyVerificationBaseline, verifyVerificationBaselineFile, writeVerificationBaseline, writeVerificationBaselineForRepository, canonicalJson, sha256 };
