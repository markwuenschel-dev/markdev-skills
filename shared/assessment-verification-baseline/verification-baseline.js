"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const workspace = require("../project-intelligence-workspace/project-intelligence-workspace.js");

const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA = /^[0-9a-f]{64}$/;
const STATES = new Set(["passed", "failed", "unavailable", "skipped", "timed-out"]);
const ISOLATION = new Set(["worktree", "copy", "container", "read-only-source", "caller-attested", "none"]);
const SCHEMA_VERSION = "assessment-verification-baseline@3";
const LEGACY_SCHEMA_VERSION = "assessment-verification-baseline@2";
const TRUST_STATES = new Set(["trustworthy", "partial", "untrustworthy", "not-run"]);
const COMMAND_KINDS = new Set(["test", "build", "lint", "typecheck", "other"]);

/** repository-health-assessment derives its trust baseline from commands shaped
 * {command_id, kind, command, result} and caps the grade harder when a `test` command
 * is not passing. RIA emits {id, status, exit_code}. Nothing in code ever translated
 * between them — an agent was told to copy the receipts across by hand — and an agent
 * that simply omitted the copy got `not-run`, a SOFTER verdict than reporting the
 * failure honestly. Emitting the Health shape here removes the hand step. */
const KIND_RULES = Object.freeze([
  ["test", ["test", "tests", "pytest", "jest", "vitest", "mocha", "rspec", "phpunit", "unittest", "gotestsum"]],
  ["typecheck", ["tsc", "mypy", "pyright", "typecheck", "type-check", "flow"]],
  ["lint", ["lint", "eslint", "ruff", "clippy", "flake8", "rubocop", "golangci-lint", "shellcheck"]],
  ["build", ["build", "compile", "webpack", "rollup", "tsup", "vite", "make"]],
]);
function deriveCommandKind(command) {
  const tokens = String(command).toLowerCase().split(/[^a-z0-9.+-]+/).filter(Boolean).map((token) => token.replace(/^-+/, ""));
  for (const [kind, needles] of KIND_RULES) if (tokens.some((token) => needles.includes(token))) return kind;
  // Never guess `test`. A wrong `test` tightens Health's cap on evidence that does not
  // exist; `other` understates the claim instead of overstating it.
  return "other";
}
const STATUS_TO_HEALTH_RESULT = Object.freeze({ passed: "pass", failed: "fail", "timed-out": "error", unavailable: "skipped", skipped: "skipped" });
// health.schema.json: command_id must match ^[A-Za-z0-9][A-Za-z0-9._:-]*$. RIA ids are the
// command string with whitespace dashed, so `node --test src/x.test.js` carries a `/`.
function healthCommandId(id) {
  let value = String(id).replace(/[^A-Za-z0-9._:-]/g, "-");
  if (!/^[A-Za-z0-9]/.test(value)) value = `c${value}`;
  return value;
}
// A timeout has no exit status of its own. 124 is the conventional timeout exit (GNU
// timeout(1)); Health requires an integer for every executed command and a non-zero one
// for anything that did not pass.
const TIMEOUT_EXIT_CODE = 124;
/** The exact array to paste into a health island's `verification.commands`, satisfying the
 * FULL Health verifier — not only deriveBaseline. An executed command must carry exit_code
 * and elapsed_seconds, a skipped one must carry a reason and neither metric, ids must be in
 * Health's charset and unique. Missing any of these made "adopt verbatim" impossible, and the
 * cheapest way out for an agent was to drop commands — which scores better. */
function healthVerificationCommands(commands) {
  const seen = new Map();
  return commands.map((command) => {
    const result = STATUS_TO_HEALTH_RESULT[command.status] ?? "error";
    let commandId = healthCommandId(command.id);
    const count = (seen.get(commandId) ?? 0) + 1;
    seen.set(commandId, count);
    if (count > 1) commandId = `${commandId}-${count}`;
    const base = { command_id: commandId, kind: command.kind ?? "other", command: command.command, result };
    if (result === "skipped") {
      return { ...base, reason: command.reason || `not executed (${command.status})` };
    }
    const exitCode = Number.isInteger(command.exit_code) ? command.exit_code
      : command.status === "timed-out" ? TIMEOUT_EXIT_CODE
      : result === "pass" ? 0 : 1;
    return {
      ...base,
      exit_code: exitCode,
      elapsed_seconds: Math.round(Number(command.duration_ms || 0)) / 1000,
      ...(command.reason ? { reason: command.reason } : {}),
    };
  });
}

/** The verdict the summary counters always implied but never stated. `summary`
 * was written on every run and read by nobody, so a baseline whose only command
 * failed was indistinguishable from one that passed. Consumers refuse on this. */
function deriveTrust(commands, summary) {
  if (!commands.length) return { state: "not-run", reason: "no-commands" };
  if (summary.failed > 0) return { state: "untrustworthy", reason: "command-failed" };
  if (summary.timed_out > 0) return { state: "untrustworthy", reason: "command-timed-out" };
  if (summary.unavailable > 0) return { state: "partial", reason: "command-unavailable" };
  if (summary.skipped > 0) return { state: "partial", reason: "command-skipped" };
  return { state: "trustworthy", reason: "all-passing" };
}

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

function normalizeInput(input, schemaVersion = SCHEMA_VERSION) {
  closed(input, ["baseline_ref", "commands", "coverage", "created_at", "environment", "isolation", "repository"], "input");
  closed(input.repository, ["repository_id", "revision", "working_tree_fingerprint"], "repository");
  if (!input.repository.repository_id || !REVISION.test(input.repository.revision) || !input.repository.working_tree_fingerprint) fail("repository binding is invalid");
  const baseline = ref(input.baseline_ref, "baseline_ref");
  if (baseline.repository_revision !== input.repository.revision) fail("baseline revision differs from verification revision");
  closed(input.isolation, ["mode", "overlay", "path", "source_repository_mutated"], "isolation");
  if (!ISOLATION.has(input.isolation.mode) || input.isolation.source_repository_mutated !== false || (input.isolation.path !== null && typeof input.isolation.path !== "string")) fail("isolation receipt is invalid");
  if (input.isolation.overlay !== undefined && input.isolation.overlay !== null) {
    closed(input.isolation.overlay, ["copied", "entries", "removed"], "isolation overlay");
    if (![input.isolation.overlay.copied, input.isolation.overlay.entries, input.isolation.overlay.removed].every((count) => Number.isInteger(count) && count >= 0)) fail("isolation overlay is invalid");
  }
  if (!Array.isArray(input.commands)) fail("commands must be an array");
  const ids = new Set();
  const commands = input.commands.map((command, index) => {
    closed(command, ["command", "duration_ms", "evidence", "exit_code", "id", "kind", "kind_inferred", "reason", "status"], `command ${index}`);
    if (!command.id || ids.has(command.id) || !command.command || !STATES.has(command.status) || !Number.isFinite(command.duration_ms) || command.duration_ms < 0 || !Array.isArray(command.evidence) || command.evidence.some((item) => typeof item !== "string" || !item)) fail(`command ${index} is invalid`);
    ids.add(command.id);
    if (!Number.isInteger(command.exit_code) && command.exit_code !== null) fail(`command ${index} exit_code is invalid`);
    // A declared kind is authoritative; a derived one is marked so an inference is never
    // mistaken for something the caller asserted.
    // kind_inferred is the provenance of record: on re-verification the artifact already
    // carries the derived kind, so presence of `kind` alone cannot mean "declared" or a
    // round trip would flip every inferred kind to declared and fail the byte check.
    const declared = command.kind !== undefined && command.kind !== null && command.kind_inferred !== true;
    if (declared && !COMMAND_KINDS.has(command.kind)) fail(`command ${index} kind is invalid`);
    const kind = declared ? command.kind : deriveCommandKind(command.command);
    if (command.kind_inferred !== undefined && typeof command.kind_inferred !== "boolean") fail(`command ${index} kind_inferred is invalid`);
    return canonical({ ...command, kind, kind_inferred: !declared, evidence: [...new Set(command.evidence)].sort(), reason: command.reason ?? null });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const summary = { passed: 0, failed: 0, unavailable: 0, skipped: 0, timed_out: 0, duration_ms: 0 };
  for (const command of commands) {
    summary.duration_ms += command.duration_ms;
    if (command.status === "timed-out") summary.timed_out += 1;
    else summary[command.status] += 1;
  }
  const createdAt = input.created_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) fail("created_at is invalid");
  const trust = deriveTrust(commands, summary);
  if (!TRUST_STATES.has(trust.state)) fail("trust state is invalid");
  const legacy = schemaVersion === LEGACY_SCHEMA_VERSION;
  return canonical({
    schema_version: schemaVersion,
    repository: input.repository,
    baseline_ref: baseline,
    isolation: input.isolation,
    commands,
    summary,
    ...(legacy ? {} : { trust, health_verification: { commands: healthVerificationCommands(commands) } }),
    environment: input.environment ?? {},
    coverage: input.coverage ?? {},
    created_at: createdAt,
  });
}

function createVerificationBaseline(input, schemaVersion = SCHEMA_VERSION) {
  const body = normalizeInput(input, schemaVersion);
  const contentSha256 = sha256(body);
  return Object.freeze(canonical({ ...body, artifact_id: `assessment-verification:${contentSha256}`, content_sha256: contentSha256 }));
}

function verifyVerificationBaseline(value) {
  try {
    // @2 stays readable so content-addressed reuse of artifacts written before the
    // trust field survives; only @3 carries `trust`.
    const legacy = value && value.schema_version === LEGACY_SCHEMA_VERSION;
    const keys = ["artifact_id", "baseline_ref", "commands", "content_sha256", "coverage", "created_at", "environment", "isolation", "repository", "schema_version", "summary"];
    closed(value, legacy ? keys : [...keys, "trust", "health_verification"], "artifact");
    if (!(value.schema_version === SCHEMA_VERSION || legacy) || !SHA.test(value.content_sha256) || value.artifact_id !== `assessment-verification:${value.content_sha256}`) fail("artifact identity is invalid");
    const reconstructed = createVerificationBaseline({ repository: value.repository, baseline_ref: value.baseline_ref, isolation: value.isolation, commands: value.commands, environment: value.environment, coverage: value.coverage, created_at: value.created_at }, value.schema_version);
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

module.exports = { ISOLATION, SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, TRUST_STATES, COMMAND_KINDS, deriveTrust, deriveCommandKind, healthVerificationCommands, createVerificationBaseline, verifyVerificationBaseline, verifyVerificationBaselineFile, writeVerificationBaseline, writeVerificationBaselineForRepository, canonicalJson, sha256 };
