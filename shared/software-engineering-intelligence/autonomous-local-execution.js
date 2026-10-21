"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const AUTONOMOUS_LOCAL_EXECUTION_VERSION = "sei.autonomous-local-execution@1";
const FULL_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// A local run is intentionally a bounded evidence probe, not an unbounded
// test-suite replacement. Keeping the command small makes timeout/cancellation
// semantics truthful on Windows while still producing revision-bound evidence.
const MAX_TEST_FILES = 4;
const MAX_SYNTAX_FILES = 128;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;
const TEST_TIMEOUT_MS = 60_000;
const MAX_STRUCTURAL_FILES = 512;
const MAX_STRUCTURAL_BYTES = 32 * 1024 * 1024;
const MAX_STRUCTURAL_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
// Substituted with the ephemeral sandbox directory at spawn time only, so the
// recorded plan (and therefore the artifact digest) stays deterministic.
const SANDBOX_TOKEN = "<sandbox>";
const CONTAINMENT_UNAVAILABLE = "containment-unavailable";
const STRUCTURAL_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cjs", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts",
  ".mjs", ".php", ".py", ".rb", ".rs", ".scala", ".swift", ".ts", ".tsx",
]);
const CONFIG_FILE_PATTERN = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|gemfile|composer\.json|[^/]+\.(?:ini|toml|yaml|yml|json|properties))$/i;
const LOCK_FILE_PATTERN = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|poetry\.lock|pipfile\.lock|cargo\.lock|go\.sum|gemfile\.lock|composer\.lock|gradle\.lockfile)$/i;
const DOCUMENTATION_FILE_PATTERN = /(?:^|\/)(?:readme(?:\.[^/]+)?|contributing(?:\.[^/]+)?|development(?:\.[^/]+)?|onboarding(?:\.[^/]+)?|[^/]+\.md)$/i;
const OPERATIONAL_PATH_PATTERN = /(?:runbook|deploy|release|docker|compose|helm|k8s|workflow|health|readiness|liveness|rollback|backup|restore|recovery|incident|postmortem)/i;

function fail(detail) {
  const error = new Error(`FAIL-AUTONOMOUS-EXECUTION: ${detail}`);
  error.code = "FAIL-AUTONOMOUS-EXECUTION";
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(stableCompare);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertClosed(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) fail(`${label}.${unexpected.sort(stableCompare)[0]} is not declared`);
}

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("repository path is invalid");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail(`repository path ${JSON.stringify(value)} is not normalized`);
  }
  return normalized;
}

function isJavaScriptTest(filePath) {
  return /\.(?:c|m)?js$/i.test(filePath)
    && (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(filePath)
      || /(?:^|\/)[^/]+\.(?:test|spec)\.(?:c|m)?js$/i.test(filePath));
}

function isLocallyRunnableJavaScriptTest(filePath) {
  return isJavaScriptTest(filePath)
    && !/(?:^|\/)(?:analyzers|benchmarks|fixtures)(?:\/|$)/i.test(filePath);
}

function isPythonTest(filePath) {
  return /(?:^|\/)(?:test|tests)(?:\/|$)/i.test(filePath)
    && /\.py$/i.test(filePath);
}

function prioritizeVerificationFiles(files) {
  const preferred = files.filter((filePath) => (
    /(?:^|\/)skills\/shared\/software-engineering-intelligence\//i.test(filePath)
    || /(?:^|\/)skills\/repository-improvement-assessment\//i.test(filePath)
  ));
  const remaining = files.filter((filePath) => !preferred.includes(filePath));
  return [...preferred, ...remaining];
}

function isJavaScriptSource(filePath) {
  return /\.(?:c|m)?js$/i.test(filePath) && !/(?:^|\/)(?:node_modules|vendor|dist|build|coverage)(?:\/|$)/i.test(filePath);
}

function isStructuralSource(entry) {
  const filePath = entry?.path;
  if (typeof filePath !== "string" || !entry?.classifications?.source || entry.classifications.test_source
      || entry.classifications.generated === "generated" || entry.classifications.vendor === "vendor") return false;
  const extension = path.posix.extname(filePath).toLowerCase();
  return STRUCTURAL_EXTENSIONS.has(extension) && !/(?:^|\/)(?:node_modules|vendor|dist|build|coverage|fixtures?)(?:\/|$)/i.test(filePath);
}

function isPlaceholderSecret(value) {
  return /^(?:example|sample|test|testing|dummy|changeme|change-me|redacted|placeholder|replace[-_ ]?me|your[-_ ]?.*)$/i.test(value.trim());
}

function isContainedRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isCancellation(error) {
  return /CANCELLED/i.test(String(error?.code ?? "")) || /CANCELLED/i.test(String(error?.message ?? ""));
}

// repository-index.js readBlobs returns a frozen Map-like view, not a Map instance.
function isBlobMap(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function";
}

// Structural facts are read from the immutable repository index (git blobs at
// the bound revision), never from a tree that executed code could have touched.
async function readStructuralBlobs(index, selected, signal) {
  const texts = new Map();
  let unreadable = 0;
  if (selected.length === 0) return { texts, unreadable };
  if (typeof index?.readBlobs !== "function") return { texts, unreadable: selected.length };
  const accept = (entry, bytes) => {
    if (!Buffer.isBuffer(bytes) || bytes.length !== entry.byte_size || bytes.length > MAX_STRUCTURAL_BLOB_BYTES) return false;
    texts.set(entry.path, bytes.toString("utf8"));
    return true;
  };
  const options = (maximumTotal) => ({
    max_blob_bytes: MAX_STRUCTURAL_BLOB_BYTES,
    max_total_bytes: maximumTotal,
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    const read = await index.readBlobs(selected, options(MAX_STRUCTURAL_BYTES));
    if (!isBlobMap(read)) throw new Error("blob reader did not return a map");
    for (const entry of selected) if (!accept(entry, read.get(entry.path))) unreadable += 1;
    return { texts, unreadable };
  } catch (error) {
    if (signal?.aborted || isCancellation(error)) throw error;
  }
  for (const entry of selected) {
    if (signal?.aborted) fail("structural scan was cancelled");
    try {
      const read = await index.readBlobs([entry], options(MAX_STRUCTURAL_BLOB_BYTES));
      if (!isBlobMap(read) || !accept(entry, read.get(entry.path))) unreadable += 1;
    } catch (error) {
      if (signal?.aborted || isCancellation(error)) throw error;
      unreadable += 1;
    }
  }
  return { texts, unreadable };
}

async function collectStructuralFacts(index, entries, { signal } = {}) {
  const typedEntries = (Array.isArray(entries) ? entries : []).filter((entry) => typeof entry?.path === "string" && Number.isSafeInteger(entry.byte_size) && entry.byte_size >= 0);
  const escaped = typedEntries.filter((entry) => !isContainedRepositoryPath(entry.path));
  const normalizedEntries = typedEntries.filter((entry) => isContainedRepositoryPath(entry.path))
    .sort((left, right) => stableCompare(left.path, right.path));
  const sourceCandidates = normalizedEntries.filter(isStructuralSource);
  const configCandidates = normalizedEntries.filter((entry) => CONFIG_FILE_PATTERN.test(entry.path) && !/node_modules|vendor|fixtures?/i.test(entry.path));
  const documentationCandidates = normalizedEntries.filter((entry) => DOCUMENTATION_FILE_PATTERN.test(entry.path) && !/node_modules|vendor|fixtures?/i.test(entry.path));
  const operationalCandidates = normalizedEntries.filter((entry) => OPERATIONAL_PATH_PATTERN.test(entry.path) && !/node_modules|vendor|fixtures?/i.test(entry.path));
  const candidateMap = new Map([...sourceCandidates, ...configCandidates, ...documentationCandidates, ...operationalCandidates].map((entry) => [entry.path, entry]));
  const candidates = [...candidateMap.values()].sort((left, right) => stableCompare(left.path, right.path));
  const escapedCandidates = escaped.filter((entry) => isStructuralSource(entry) || CONFIG_FILE_PATTERN.test(entry.path)
    || DOCUMENTATION_FILE_PATTERN.test(entry.path) || OPERATIONAL_PATH_PATTERN.test(entry.path)).length;
  const selected = [];
  let selectedBytes = 0;
  let skippedOversize = 0;
  let skippedBudget = 0;
  for (const entry of candidates) {
    // readBlobs throws on any oversize entry, so oversize blobs are never requested.
    if (entry.byte_size > MAX_STRUCTURAL_BLOB_BYTES) { skippedOversize += 1; continue; }
    if (selected.length >= MAX_STRUCTURAL_FILES || selectedBytes + entry.byte_size > MAX_STRUCTURAL_BYTES) { skippedBudget += 1; continue; }
    selected.push(entry);
    selectedBytes += entry.byte_size;
  }
  const { texts, unreadable } = await readStructuralBlobs(index, selected, signal);
  const analyzedEntries = selected.filter((entry) => texts.has(entry.path));
  const analyzedBytes = analyzedEntries.reduce((total, entry) => total + entry.byte_size, 0);
  const sourcePaths = sourceCandidates.filter((entry) => texts.has(entry.path)).map((entry) => entry.path);
  const sourceText = sourcePaths.map((filePath) => texts.get(filePath));
  const sourceCount = sourcePaths.length;
  const sourceDenominator = Math.max(1, sourceCount);
  const explicitFailureFiles = sourceText.filter((text) => /\b(?:try|catch|except|finally|throw|raise|assert)\b/.test(text)).length;
  const handledFailureFiles = sourceText.filter((text) => /\b(?:catch|except|finally)\b/.test(text)
    && /\b(?:throw|raise|return|reject|finally|rollback|recover)\b/.test(text)).length;
  const observableFiles = sourceText.filter((text) => /\b(?:console\.(?:log|info|warn|error|debug)|logger?\.(?:trace|debug|info|warn|error|fatal)|logging\.(?:debug|info|warning|error|exception)|opentelemetry|prometheus|histogram|counter|tracer?\.(?:start|span)|metrics?\.)\b/i.test(text)).length;
  const operationalTexts = [...operationalCandidates.map((entry) => texts.get(entry.path)).filter(Boolean), ...sourceText];
  const operationalEvidenceFiles = operationalTexts.filter((text) => /\b(?:health(?:z|check)?|readiness|liveness|runbook|deploy(?:ment)?|release|rollback|backup|restore|recovery|incident|postmortem)\b/i.test(text)).length;
  const recoveryEvidenceFiles = operationalTexts.filter((text) => /\b(?:rollback|backup|restore|recovery|disaster|incident|postmortem|chaos)\b/i.test(text)).length;
  const docsText = documentationCandidates.map((entry) => texts.get(entry.path)).filter(Boolean).join("\n");
  const configPaths = configCandidates.filter((entry) => texts.has(entry.path)).map((entry) => entry.path);
  const documentedConfigCount = configPaths.filter((filePath) => {
    const text = texts.get(filePath) ?? "";
    return /\b(?:config(?:uration)?|environment|setup|install|option|setting)\b/i.test(text) || /\b(?:config(?:uration)?|environment|setup|install|option|setting)\b/i.test(docsText);
  }).length;
  const manifestPaths = configPaths.filter((filePath) => /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|gemfile|composer\.json)$/i.test(filePath));
  const lockPaths = normalizedEntries.filter((entry) => LOCK_FILE_PATTERN.test(entry.path) && !/node_modules|vendor|fixtures?/i.test(entry.path)).map((entry) => entry.path);
  const manifestDirectories = new Set(manifestPaths.map((filePath) => path.posix.dirname(filePath)));
  const lockDirectories = new Set(lockPaths.map((filePath) => path.posix.dirname(filePath)));
  const lockedManifestCount = [...manifestDirectories].filter((directory) => lockDirectories.has(directory)).length;
  const secretFindings = [];
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi,
  ];
  for (const [filePath, text] of texts) {
    if (/(?:^|\/)(?:fixtures?|tests?|docs?)(?:\/|$)/i.test(filePath)) continue;
    for (const pattern of secretPatterns) {
      for (const match of text.matchAll(pattern)) {
        const candidate = match[1] ?? match[0];
        if (!isPlaceholderSecret(candidate)) secretFindings.push(`${filePath}:${match.index ?? 0}`);
        if (secretFindings.length >= 512) break;
      }
      if (secretFindings.length >= 512) break;
    }
    if (secretFindings.length >= 512) break;
  }
  // Coverage is what was actually read, over everything that qualified; a file
  // that was selected but not read (oversize, budget, unreadable) is not covered.
  const totalCandidates = candidates.length + escapedCandidates;
  const coverage = totalCandidates === 0 ? 0 : Math.min(1, analyzedEntries.length / totalCandidates);
  const complete = analyzedEntries.length === totalCandidates;
  return {
    scan: {
      source: "repository-index-blobs",
      candidate_count: totalCandidates,
      selected_file_count: selected.length,
      selected_bytes: selectedBytes,
      analyzed_file_count: analyzedEntries.length,
      analyzed_bytes: analyzedBytes,
      skipped_oversize: skippedOversize,
      skipped_budget: skippedBudget,
      unreadable,
      escaped: escapedCandidates,
      complete,
      coverage: Number(coverage.toFixed(8)),
      paths: analyzedEntries.map((entry) => entry.path).slice(0, 256),
    },
    source: { candidate_count: sourceCandidates.length, analyzed_count: sourceCount, source_paths: sourcePaths.slice(0, 256) },
    failure_explicitness: { value: sourceCount === 0 ? null : Number((explicitFailureFiles / sourceDenominator).toFixed(8)), files_with_explicit_handling: explicitFailureFiles },
    failure_handling: { value: sourceCount === 0 ? null : Number((handledFailureFiles / sourceDenominator).toFixed(8)), files_with_terminal_handling: handledFailureFiles },
    observability: { value: sourceCount === 0 ? null : Number((observableFiles / sourceDenominator).toFixed(8)), files_with_observability: observableFiles },
    operational_readiness: { value: Number((operationalEvidenceFiles / Math.max(1, operationalTexts.length)).toFixed(8)), evidence_files: operationalEvidenceFiles },
    recovery_evidence: { value: recoveryEvidenceFiles > 0 ? 1 : 0, evidence_files: recoveryEvidenceFiles },
    secrets_and_configuration: { value: secretFindings.length, finding_count: secretFindings.length, finding_paths: secretFindings.slice(0, 256) },
    dependency_hygiene: { value: manifestDirectories.size === 0 ? null : Number((lockedManifestCount / manifestDirectories.size).toFixed(8)), manifest_count: manifestDirectories.size, locked_manifest_count: lockedManifestCount, lock_paths: lockPaths.slice(0, 256) },
    configuration_ergonomics: { value: configPaths.length === 0 ? null : Number((documentedConfigCount / configPaths.length).toFixed(8)), config_count: configPaths.length, documented_config_count: documentedConfigCount },
  };
}

function nodeContainmentSupported() {
  const flags = process.allowedNodeEnvironmentFlags;
  return flags.has("--permission") && flags.has("--allow-fs-read") && flags.has("--allow-fs-write") && flags.has("--test-isolation");
}

function deriveExecutionPlan(input = {}) {
  assertClosed(input, ["files", "python_executable", "node_executable"], "execution plan input");
  if (!Array.isArray(input.files) || input.files.length > 100_000) fail("files must be a bounded array");
  const files = uniqueSorted(input.files.map(normalizePath));
  const nodeExecutable = typeof input.node_executable === "string" && input.node_executable.length > 0
    ? input.node_executable : process.execPath;
  const orderedFiles = prioritizeVerificationFiles(files);
  const testCandidates = orderedFiles.filter(isLocallyRunnableJavaScriptTest);
  const pythonTestCandidates = orderedFiles.filter(isPythonTest);
  const testFiles = testCandidates.slice(0, MAX_TEST_FILES);
  const pythonTestFiles = pythonTestCandidates.slice(0, MAX_TEST_FILES);
  const syntaxFiles = files.filter(isJavaScriptSource).slice(0, MAX_SYNTAX_FILES);
  const commands = [];
  const withheld = [];
  if (testFiles.length > 0) {
    // Node's permission model confines the in-process test run to the sandbox:
    // reads and writes outside it, child processes, workers, and addons are denied.
    // Process isolation is not used because it needs a child process.
    if (nodeExecutable === process.execPath && !nodeContainmentSupported()) {
      withheld.push({ tool: "node-test", files: testFiles, reason: `${CONTAINMENT_UNAVAILABLE}: this Node runtime does not support --permission with --test-isolation=none` });
    } else {
      commands.push({
        kind: "test",
        tool: "node-test",
        executable: nodeExecutable,
        args: [
          "--permission", `--allow-fs-read=${SANDBOX_TOKEN}`, `--allow-fs-write=${SANDBOX_TOKEN}`,
          "--test", "--test-isolation=none", "--test-reporter=tap", ...testFiles,
        ],
        files: testFiles,
        bounded: testFiles.length < testCandidates.length,
      });
    }
  } else if (pythonTestFiles.length > 0) {
    // pytest cannot be confined to the sandbox (no filesystem/process permission
    // model), so it is never executed; the probe records it as unavailable.
    withheld.push({ tool: "pytest", files: pythonTestFiles, reason: `${CONTAINMENT_UNAVAILABLE}: python test execution cannot be confined to the ephemeral sandbox` });
  }
  return deepFreeze({
    version: AUTONOMOUS_LOCAL_EXECUTION_VERSION,
    commands,
    withheld,
    discovered_test_files: testFiles.length + pythonTestFiles.length,
    discovered_source_files: syntaxFiles.length,
  });
}

function parseNodeTap(stdout, stderr, exitCode) {
  const text = `${stdout}\n${stderr}`;
  const read = (label) => {
    // Node's default reporter uses either TAP comments (`# tests 3`) or the
    // human reporter markers (`ℹ tests 3`) depending on invocation/version.
    const match = text.match(new RegExp(`(?:#|ℹ)\\s*${label}\\s+(\\d+)`, "i"));
    return match ? Number(match[1]) : null;
  };
  let total = read("tests");
  let passed = read("pass");
  let failed = read("fail");
  let skipped = read("skipped");
  if (total === null) {
    passed = (text.match(/^ok\b/gim) ?? []).length;
    failed = (text.match(/^not ok\b/gim) ?? []).length;
    skipped = (text.match(/# (?:SKIP|TODO)\b/gim) ?? []).length;
    total = passed + failed;
  }
  const durationMatch = text.match(/(?:#|ℹ)\s*duration_ms\s+([0-9]+(?:\.[0-9]+)?)/i);
  const durationMs = durationMatch ? Number(durationMatch[1]) : null;
  if (![total, passed, failed, skipped].every((value) => Number.isSafeInteger(value) && value >= 0)
      || passed + failed > total) return null;
  return { total, passed, failed, skipped, duration_ms: Number.isFinite(durationMs) ? durationMs : null, exit_code: exitCode };
}

function parsePytest(stdout, stderr, exitCode) {
  const text = `${stdout}\n${stderr}`;
  const count = (label) => {
    const match = text.match(new RegExp(`(\\d+)\\s+${label}`, "i"));
    return match ? Number(match[1]) : 0;
  };
  const passed = count("passed");
  const failed = count("failed") + count("error(?:s)?");
  const skipped = count("skipped");
  const total = passed + failed + skipped;
  const durationMatch = text.match(/in ([0-9]+(?:\.[0-9]+)?)s\b/i);
  if (!Number.isSafeInteger(total) || total === 0) return null;
  return { total, passed, failed, skipped, duration_ms: durationMatch ? Number(durationMatch[1]) * 1000 : null, exit_code: exitCode };
}

const INHERITED_ENVIRONMENT_KEYS = new Set(["path", "systemroot", "windir"]);

// Allowlist, not denylist: NODE_OPTIONS, credentials, proxies, git overrides and
// everything else the host carries are dropped by construction.
function containedEnvironment(sandbox) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (INHERITED_ENVIRONMENT_KEYS.has(key.toLowerCase()) && typeof value === "string") environment[key] = value;
  }
  const home = path.join(sandbox, "home");
  const temporary = path.join(sandbox, "tmp");
  return {
    ...environment,
    CI: "1",
    NODE_ENV: "test",
    PYTHONDONTWRITEBYTECODE: "1",
    HOME: home,
    USERPROFILE: home,
    TMP: temporary,
    TEMP: temporary,
    TMPDIR: temporary,
    GIT_CEILING_DIRECTORIES: sandbox,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function runBounded(command, cwd, signal, sandbox) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ state: "cancelled", stdout: "", stderr: "", exit_code: null });
      return;
    }
    const args = command.args.map((arg) => arg.replaceAll(SANDBOX_TOKEN, sandbox));
    const child = spawn(command.executable, args, {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      env: containedEnvironment(sandbox),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, stdout: stdout.slice(-MAX_STDOUT_BYTES), stderr: stderr.slice(-MAX_STDERR_BYTES) });
    };
    const append = (target, chunk) => {
      const text = chunk.toString("utf8");
      return target.length >= (target === stdout ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES)
        ? target : `${target}${text}`.slice(-(target === stdout ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES));
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const kill = (timeout = true) => {
      timedOut = timeout;
      try {
        if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
        else if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch { try { child.kill("SIGKILL"); } catch {} }
      try { child.kill("SIGKILL"); } catch {}
    };
    const timer = setTimeout(() => {
      kill(true);
      setTimeout(() => finish({ state: "timeout", stdout, stderr, exit_code: null }), 5_000).unref?.();
    }, TEST_TIMEOUT_MS);
    const abort = () => {
      kill(false);
      finish({ state: "cancelled", stdout, stderr, exit_code: null });
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      finish({ state: signal?.aborted ? "cancelled" : "error", stdout, stderr: `${stderr}\n${error.message}`, exit_code: null });
    });
    child.on("close", (code, signalName) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      finish({ state: timedOut ? "timeout" : signal?.aborted ? "cancelled" : "completed", stdout, stderr, exit_code: code, signal: signalName });
    });
  });
}

function archiveRevision(repositoryRoot, revision, destination, sandbox) {
  const environment = containedEnvironment(sandbox);
  // The source repository lives outside the sandbox, so the ceiling must not apply to it.
  delete environment.GIT_CEILING_DIRECTORIES;
  const archive = spawnSync("git", ["-c", `safe.directory=${repositoryRoot}`, "-C", repositoryRoot, "archive", "--format=tar", revision], {
    encoding: "buffer", windowsHide: true, timeout: 30_000, maxBuffer: MAX_ARCHIVE_BYTES, env: environment,
  });
  if (archive.error || archive.status !== 0 || !Buffer.isBuffer(archive.stdout) || archive.stdout.length === 0) {
    fail(`could not archive revision for isolated execution (${archive.error?.message ?? String(archive.stderr ?? "git archive failed").trim()})`);
  }
  // Pass the destination through cwd rather than -C: an MSYS2 tar.exe (Git for Windows) re-parses the
  // command line and mangles a native backslash path supplied as an argv element.
  const extracted = spawnSync("tar", ["-xf", "-"], {
    cwd: destination, input: archive.stdout, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, env: environment,
  });
  if (extracted.error || extracted.status !== 0) fail(`could not extract isolated revision (${extracted.error?.message ?? String(extracted.stderr ?? "tar failed").trim()})`);
}

function sourceMutated(detail) {
  const error = new Error(`FAIL-SEI-SOURCE-MUTATED: ${detail}`);
  error.code = "FAIL-SEI-SOURCE-MUTATED";
  throw error;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Second line of defence behind the sandbox: the source working tree as git sees
// it (tracked changes, untracked files, and the size/mtime of every listed path).
// Paths under excludedRoot (the SEI output workspace, which this run writes to)
// are ignored. Ignored files are not visible to this check.
function sourceStatusSnapshot(repositoryRoot, excludedRoot = null) {
  const result = spawnSync("git", [
    "-c", `safe.directory=${repositoryRoot}`, "-c", "core.fsmonitor=false", "-C", repositoryRoot,
    "status", "--porcelain=v2", "-z", "--untracked-files=all",
  ], {
    encoding: "buffer", windowsHide: true, timeout: 60_000, maxBuffer: MAX_STATUS_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail(`could not snapshot source status (${result.error?.message ?? String(result.stderr ?? "git status failed").trim()})`);
  }
  const fields = result.stdout.toString("utf8").split("\0");
  const records = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length === 0) continue;
    let filePath;
    let record = field;
    if (field.startsWith("1 ")) filePath = field.split(" ").slice(8).join(" ");
    else if (field.startsWith("2 ")) {
      filePath = field.split(" ").slice(9).join(" ");
      record = `${field}\t${fields[index + 1] ?? ""}`;
      index += 1;
    } else if (field.startsWith("u ")) filePath = field.split(" ").slice(10).join(" ");
    else if (field.startsWith("? ") || field.startsWith("! ")) filePath = field.slice(2);
    else filePath = null;
    const absolute = filePath === null ? null : path.resolve(repositoryRoot, filePath);
    if (absolute !== null && excludedRoot !== null && isWithin(excludedRoot, absolute)) continue;
    let stat = "absent";
    if (absolute !== null) {
      try {
        const info = fs.lstatSync(absolute);
        stat = `${info.isDirectory() ? "d" : info.isSymbolicLink() ? "l" : "f"}:${info.size}:${info.mtimeMs}`;
      } catch {}
    }
    records.push(`${record}\u0000${stat}`);
  }
  return records.sort(stableCompare);
}

function assertSourceUnchanged(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const changed = [...before.filter((item) => !afterSet.has(item)), ...after.filter((item) => !beforeSet.has(item))];
  if (changed.length > 0) {
    const sample = changed.slice(0, 3).map((item) => item.split("\u0000")[0]).join("; ");
    sourceMutated(`the source working tree changed during the autonomous probe (${changed.length} status record(s) differ: ${sample})`);
  }
}

async function collectAutonomousLocalExecution(input = {}) {
  assertClosed(input, ["repository_root", "repository_revision", "repository_index", "output_root", "python_executable", "configuration_hash", "signal"], "local execution input");
  if (typeof input.repository_root !== "string" || !path.isAbsolute(input.repository_root)) fail("repository_root must be absolute");
  if (!FULL_REVISION.test(input.repository_revision ?? "")) fail("repository_revision must be a full lowercase revision");
  if (!/^[0-9a-f]{64}$/.test(input.configuration_hash ?? "")) fail("configuration_hash must be a lowercase SHA-256 digest");
  if (!isRecord(input.repository_index) || !Array.isArray(input.repository_index.entries)) fail("repository_index must be canonical");
  if (typeof input.output_root !== "string" || !path.isAbsolute(input.output_root)) fail("output_root must be absolute");
  const files = input.repository_index.entries.map((entry) => entry.path);
  const plan = deriveExecutionPlan({ files, python_executable: input.python_executable, node_executable: process.execPath });
  const artifactDir = path.join(input.output_root, "execution-evidence");
  const sourceRoot = path.resolve(input.repository_root);
  const outputRoot = path.resolve(input.output_root);
  const statusBefore = sourceStatusSnapshot(sourceRoot, outputRoot);
  // Structural facts come from the immutable index blobs, before anything executes.
  const structuralFacts = await collectStructuralFacts(input.repository_index, input.repository_index.entries, { signal: input.signal });
  const results = [];
  if (plan.commands.length > 0) {
    // The sandbox lives in the OS temp directory, never inside the repository or its
    // output workspace, and is removed once the probe settles.
    const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sei-exec-")));
    try {
      const extracted = path.join(sandbox, "src");
      for (const directory of [extracted, path.join(sandbox, "home"), path.join(sandbox, "tmp")]) fs.mkdirSync(directory);
      archiveRevision(sourceRoot, input.repository_revision, extracted, sandbox);
      for (const command of plan.commands) {
        const result = await runBounded(command, extracted, input.signal, sandbox);
        const facts = result.state === "completed"
          ? command.tool === "node-test" ? parseNodeTap(result.stdout, result.stderr, result.exit_code) : parsePytest(result.stdout, result.stderr, result.exit_code)
          : null;
        results.push({ ...command, result: { state: result.state, exit_code: result.exit_code, signal: result.signal, facts, stdout_tail: result.stdout.replaceAll(sandbox, SANDBOX_TOKEN), stderr_tail: result.stderr.replaceAll(sandbox, SANDBOX_TOKEN) } });
        if (result.state === "cancelled") break;
      }
    } finally {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
    }
  }
  assertSourceUnchanged(statusBefore, sourceStatusSnapshot(sourceRoot, outputRoot));
  fs.mkdirSync(artifactDir, { recursive: true });
  const execution = {
    execution_version: AUTONOMOUS_LOCAL_EXECUTION_VERSION,
    repository_revision: input.repository_revision,
    plan,
    results,
    structural_facts: structuralFacts,
    bounded: true,
  };
  const digest = `sha256:${crypto.createHash("sha256").update(JSON.stringify(execution)).digest("hex")}`;
  const artifactPath = path.join(artifactDir, `${digest.slice("sha256:".length)}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(execution)}\n`, "utf8");
  const test = results.find((result) => result.kind === "test");
  const facts = test?.result?.facts ?? null;
  const executionStatus = facts === null ? "unavailable" : "measured";
  const withheld = plan.withheld[0] ?? null;
  const reason = facts === null
    ? (test?.result?.state === "timeout" ? "autonomous test execution timed out"
      : test ? (test.result.stderr_tail || "autonomous test output could not be parsed")
        : withheld ? withheld.reason : "no supported local test command was discovered")
    : `autonomous ${test.tool} execution completed at the bound revision inside a permission-confined sandbox`;
  const provenance = {
    kind: "revision-bound-autonomous-execution",
    collector_id: "autonomous-local-execution",
    collector_version: "1.0.0",
    repository_revision: input.repository_revision,
    command: test ? `${test.executable} ${test.args.join(" ")}` : null,
    artifact_refs: [`execution-evidence/${path.basename(artifactPath)}`],
    evidence_refs: [`execution-artifact:sha256:${digest.slice("sha256:".length)}`],
  };
  const base = (metric_id, value, unit, status = executionStatus, metricReason = reason) => ({
    metric_id,
    definition_id: `sei.${metric_id}@1`,
    family: "verification",
    subject: "repository:revision-bound-autonomous-execution",
    repository_revision: input.repository_revision,
    value,
    unit,
    measurement: { status, completeness: status === "measured" ? (plan.commands.some((item) => item.bounded) ? 0.95 : 1) : 0, confidence: status === "measured" ? 0.9 : 0, reason: metricReason },
    source: provenance,
    scope: { kind: "repository", path: ".", language: null, generated_code: false, included_in_human_maintainability: false },
    window: { kind: "revision", start: null, end: input.repository_revision },
    analyzer_identity: "sei.autonomous-local-execution@1",
    analyzer_version: "1.0.0",
    comparability: { analyzer_identity: "sei.autonomous-local-execution@1", analyzer_version: "1.0.0", configuration_hash: input.configuration_hash, compatible_with_prior: false, reason: "execution artifact is bound to the exact revision" },
  });
  const metrics = [
    // These IDs are deliberately namespaced: a repository may also provide a
    // committed JUnit/verification summary with the generic IDs. The semantic
    // evidence index treats both producers as the same observation family,
    // while the raw snapshot retains both provenance records without collision.
    base("verification.autonomous_tests_total", facts?.total ?? null, "tests",
      facts?.total === undefined || facts?.total === null ? "unavailable" : executionStatus),
    base("verification.autonomous_tests_passed", facts?.passed ?? null, "tests",
      facts?.passed === undefined || facts?.passed === null ? "unavailable" : executionStatus),
    base("verification.autonomous_tests_failed", facts?.failed ?? null, "tests",
      facts?.failed === undefined || facts?.failed === null ? "unavailable" : executionStatus),
    base("verification.autonomous_duration_ms", facts?.duration_ms ?? null, "milliseconds",
      facts?.duration_ms === undefined || facts?.duration_ms === null ? "unavailable" : executionStatus),
  ];
  const structuralStatus = structuralFacts?.scan?.analyzed_file_count > 0 ? "inferred" : "unavailable";
  const structuralCompleteness = structuralStatus === "unavailable" ? 0 : structuralFacts.scan.coverage;
  const structuralConfidence = structuralStatus === "unavailable" ? 0 : structuralFacts.scan.complete ? 0.85 : 0.7;
  const structuralProvenance = {
    ...provenance,
    collector_id: "autonomous-local-structure",
    collector_version: "1.0.0",
    evidence_refs: uniqueSorted([
      ...provenance.evidence_refs,
      ...(structuralFacts?.scan?.paths ?? []).map((filePath) => `structural-source:${filePath}`),
    ]),
  };
  const structural = (metric_id, value, unit, metricReason) => ({
    metric_id,
    definition_id: `sei.${metric_id}@1`,
    family: "assessment_local_structure",
    subject: "repository:revision-bound-autonomous-structure",
    repository_revision: input.repository_revision,
    value,
    unit,
    measurement: {
      status: value === null || value === undefined ? "unavailable" : structuralStatus,
      completeness: value === null || value === undefined ? 0 : structuralCompleteness,
      confidence: value === null || value === undefined ? 0 : structuralConfidence,
      reason: value === null || value === undefined ? "no bounded source evidence was available" : metricReason,
    },
    source: structuralProvenance,
    scope: { kind: "repository", path: ".", language: null, generated_code: false, included_in_human_maintainability: false },
    window: { kind: "revision", start: null, end: input.repository_revision },
    analyzer_identity: "sei.autonomous-local-structure@1",
    analyzer_version: "1.0.0",
    comparability: { analyzer_identity: "sei.autonomous-local-structure@1", analyzer_version: "1.0.0", configuration_hash: input.configuration_hash, compatible_with_prior: false, reason: "source facts are bound to the exact archived revision" },
  });
  if (structuralFacts !== null) {
    metrics.push(
      structural("assessment.failure_explicitness", structuralFacts.failure_explicitness.value, "ratio", "bounded source scan counted explicit failure constructs; this is structural evidence, not runtime correctness"),
      structural("assessment.reliability.failure_handling", structuralFacts.failure_handling.value, "ratio", "bounded source scan counted terminal handling inside failure constructs; this is structural evidence, not incident behavior"),
      structural("assessment.reliability.observability", structuralFacts.observability.value, "ratio", "bounded source scan counted logging, metrics, and tracing surfaces; runtime telemetry is not inferred"),
      structural("assessment.reliability.operational_readiness", structuralFacts.operational_readiness.value, "ratio", "bounded revision scan counted operational readiness artifacts and terms; deployment health is not inferred"),
      structural("assessment.reliability.recovery_evidence", structuralFacts.recovery_evidence.value, "ratio", "bounded revision scan searched for recovery, rollback, backup, and incident evidence"),
      structural("assessment.security.secret_findings", structuralFacts.secrets_and_configuration.value, "findings", "bounded high-confidence secret-pattern scan; a zero result is not a guarantee against undiscovered secret formats"),
      structural("assessment.security.dependency_hygiene", structuralFacts.dependency_hygiene.value, "ratio", "bounded manifest-to-lockfile coverage; this does not claim vulnerability absence"),
      structural("assessment.developer.configuration_ergonomics", structuralFacts.configuration_ergonomics.value, "ratio", "bounded configuration/documentation scan; this measures discoverability signals, not developer sentiment"),
    );
  }
  const collector = {
    collector_id: "autonomous-local-execution",
    collector_version: "1.0.0",
    status: facts === null ? "unavailable" : "available",
    analyzer_identity: "sei.autonomous-local-execution@1",
    analyzer_version: "1.0.0",
    reason: facts === null ? reason : null,
  };
  const structuralCollector = {
    collector_id: "autonomous-local-structure",
    collector_version: "1.0.0",
    status: structuralStatus === "unavailable" ? "unavailable" : "degraded",
    analyzer_identity: "sei.autonomous-local-structure@1",
    analyzer_version: "1.0.0",
    reason: structuralStatus === "unavailable" ? "no bounded source evidence was available" : "structural repository facts are bounded inferred evidence; runtime and external outcomes are not inferred",
  };
  return deepFreeze({
    execution,
    artifact_path: artifactPath,
    artifact_ref: `execution-evidence/${path.basename(artifactPath)}`,
    collector,
    collectors: [collector, structuralCollector],
    metrics,
  });
}

module.exports = { AUTONOMOUS_LOCAL_EXECUTION_VERSION, deriveExecutionPlan, parseNodeTap, parsePytest, collectAutonomousLocalExecution };
module.exports[Symbol.for("sei.autonomous-local-execution.private.v1")] = Object.freeze({
  collectStructuralFacts, containedEnvironment, sourceStatusSnapshot, assertSourceUnchanged,
});
