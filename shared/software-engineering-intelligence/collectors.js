"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { deriveTemporalCoupling } = require("./temporal-coupling.js");
const { validateSnapshot } = require("./intelligence-engine.js");
const incrementalStatePrivate = require("./incremental-run-state.js")[Symbol.for("sei.incremental-run-state.private.v2")];

const COLLECTOR_VERSION = "1.2.0";
const STATIC_ANALYZER_ID = "sei.lexical-js@1";
const STATIC_ANALYZER_VERSION = "1.1.0";
const SPECIALIZED_ANALYZER_ID = "external.specialized-complexity";
const GIT_ANALYZER_ID = "sei.git-history@1";
const GIT_ANALYZER_VERSION = "1.4.1";
const GIT_REVISION_BATCH_SIZE = 256;
const GIT_SHOW_FRAME_MARKER = "sei-git-frame-v1";
const GIT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const GIT_MAX_SATURATION = 4;
const GIT_DEFAULT_SATURATION = "auto";
const GIT_TERMINATION_GRACE_MS = 2_000;
const INTERNAL_GIT_OBSERVER = Symbol("sei-git-observer");
const SUPPLIED_SOURCE_EXTENSIONS = new Map([
  [".c", "c"], [".cc", "cpp"], [".cpp", "cpp"], [".cs", "csharp"],
  [".go", "go"], [".java", "java"], [".js", "javascript"], [".jsx", "javascript"],
  [".kt", "kotlin"], [".kts", "kotlin"], [".php", "php"], [".py", "python"],
  [".rb", "ruby"], [".rs", "rust"], [".swift", "swift"], [".ts", "typescript"],
  [".tsx", "typescript"],
]);
const FULL_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MERGE_CHURN_UNATTRIBUTED_REASON = "merge_conflict_resolution_churn_unattributed";
const GENERATED_CLASSIFICATION_UNKNOWN_REASON = "generated_vendor_classification_unknown_excluded_from_behavioral_aggregates";
const BINARY_CHURN_UNVERIFIABLE_REASON = "binary-numstat-churn-is-null-so-complete-line-churn-is-unverifiable";

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeGitPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} must be a non-empty NUL-free path`);
  }
  const normalized = normalizePath(value);
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} must be a non-empty NUL-free path`);
  }
  return normalized;
}

function normalizeGitTimestamp(value, label) {
  if (typeof value !== "string" || !RFC3339_WITH_OFFSET.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} must be RFC3339 with Z or an explicit offset`);
  }
  return new Date(value).toISOString();
}

function temporalPolicyConfiguration(input) {
  const receipt = deriveTemporalCoupling({ commits: [], policy: input.temporal_coupling_policy }).mass_change_policy;
  return {
    policy_id: receipt.policy_id,
    policy_version: receipt.policy_version,
    policy_hash: receipt.policy_hash,
    threshold: receipt.threshold,
    action: receipt.action,
    reason: receipt.reason,
  };
}

function effectiveConfiguration(input) {
  const patternsPresent = Array.isArray(input.generated_path_patterns);
  if (input.generated_path_patterns !== undefined && !patternsPresent) {
    throw new Error("FAIL-INVALID-COLLECTOR-CONFIG: generated_path_patterns must be an array when supplied");
  }
  const patterns = patternsPresent
    ? input.generated_path_patterns.map((pattern, index) => {
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error(`FAIL-INVALID-COLLECTOR-CONFIG: generated_path_patterns[${index}] must be a non-empty string`);
      }
      return normalizePath(pattern);
    })
    : [];
  const analyzerVersion = input.static_analyzer_version ?? STATIC_ANALYZER_VERSION;
  if (typeof analyzerVersion !== "string" || analyzerVersion.length === 0) {
    throw new Error("FAIL-INVALID-COLLECTOR-CONFIG: static_analyzer_version must be a non-empty string");
  }
  return {
    generated_path_patterns_supplied: patternsPresent,
    generated_path_patterns: [...new Set(patterns)].sort(stableCompare),
    static_analyzer_identity: STATIC_ANALYZER_ID,
    static_analyzer_version: analyzerVersion,
    git_analyzer_identity: GIT_ANALYZER_ID,
    git_analyzer_version: GIT_ANALYZER_VERSION,
    temporal_coupling_policy: temporalPolicyConfiguration(input),
  };
}

function deriveCollectorConfigurationHash(input) {
  const derived = crypto.createHash("sha256").update(JSON.stringify(effectiveConfiguration(input))).digest("hex");
  if (input.configuration_hash !== undefined && input.configuration_hash !== derived) {
    throw new Error("FAIL-CONFIGURATION-HASH-MISMATCH: supplied configuration_hash does not match canonical effective collector config");
  }
  return derived;
}

function repositoryRevision(input) {
  if (typeof input.repository_revision !== "string" || input.repository_revision.length === 0) {
    throw new Error("FAIL-MISSING-REPOSITORY-REVISION: repository_revision is required for provenance-bound collection");
  }
  return input.repository_revision;
}

function repositorySubject(input) {
  return `repository:${normalizePath(input.repo_root ?? "supplied-evidence")}`;
}

function revisionWindow(input) {
  return { kind: "revision", start: null, end: repositoryRevision(input) };
}

function historyWindow(input) {
  const boundary = input.history_window;
  if (boundary && typeof boundary === "object") {
    return {
      kind: boundary.kind ?? "revision-range",
      start: boundary.start ?? null,
      end: boundary.end ?? repositoryRevision(input),
    };
  }
  return { kind: "revision-range", start: null, end: repositoryRevision(input) };
}

function collectorRecord({ id, status, analyzerIdentity, analyzerVersion, reason = null }) {
  return {
    collector_id: id,
    collector_version: COLLECTOR_VERSION,
    status,
    analyzer_identity: analyzerIdentity,
    analyzer_version: analyzerVersion,
    reason,
  };
}

function metricRecord(input, options) {
  const measured = options.status === "measured" || options.status === "inferred";
  const artifactRefs = [...new Set(options.artifactRefs ?? [])].sort(stableCompare);
  if (artifactRefs.length === 0) artifactRefs.push(options.fallbackArtifact ?? "collector-input");
  return {
    metric_id: options.metricId,
    definition_id: options.definitionId,
    family: options.family,
    subject: options.subject ?? repositorySubject(input),
    repository_revision: repositoryRevision(input),
    value: measured ? options.value : null,
    unit: options.unit,
    measurement: {
      status: options.status,
      completeness: options.completeness ?? (measured ? 1 : 0),
      confidence: options.confidence ?? (measured ? 1 : 0),
      reason: options.reason ?? null,
    },
    source: {
      kind: options.sourceKind,
      collector_id: options.collectorId,
      collector_version: COLLECTOR_VERSION,
      repository_revision: repositoryRevision(input),
      command: options.command ?? null,
      artifact_refs: artifactRefs,
      evidence_refs: artifactRefs,
    },
    scope: {
      kind: options.scopeKind ?? "repository",
      path: options.scopePath ?? ".",
      language: options.language ?? null,
      generated_code: options.generatedCode ?? false,
      included_in_human_maintainability: options.includedInHuman ?? true,
    },
    window: options.window,
    analyzer_identity: options.analyzerIdentity,
    analyzer_version: options.analyzerVersion,
    comparability: {
      analyzer_identity: options.analyzerIdentity,
      analyzer_version: options.analyzerVersion,
      configuration_hash: deriveCollectorConfigurationHash(input),
      compatible_with_prior: false,
      reason: options.comparabilityReason ?? "no prior analyzer-bound measurement was supplied",
    },
  };
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function classifyGenerated(file, patternsPresent, patterns) {
  if (typeof file.generated === "boolean") {
    return { generated: file.generated, known: true, reason: "explicit source-row classification" };
  }
  if (!patternsPresent) {
    return { generated: false, known: false, reason: "generated path patterns were not supplied" };
  }
  const generated = patterns.some((pattern) => globToRegExp(pattern).test(file.path));
  return { generated, known: true, reason: generated ? "matched generated path pattern" : "did not match generated path patterns" };
}

function detectLanguage(filePath, declaredLanguage) {
  if (typeof declaredLanguage === "string" && declaredLanguage.length > 0) return declaredLanguage;
  return SUPPLIED_SOURCE_EXTENSIONS.get(path.extname(filePath).toLowerCase()) ?? "unknown";
}

function lineCount(content) {
  if (content.length === 0) return 0;
  return content.replace(/\r\n?/g, "\n").split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function lexicalFunctionCount(content, language) {
  const patterns = language === "python"
    ? [/^\s*(?:async\s+)?def\s+[A-Za-z_$][\w$]*\s*\(/gm]
    : [
      /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g,
      /(?:^|[,{;]\s*)(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/gm,
      /(?:^|[,{;]\s*)[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
    ];
  return patterns.reduce((count, pattern) => count + [...content.matchAll(pattern)].length, 0);
}

function lexicalMaxNesting(content, language) {
  if (language === "python") {
    let maximum = 0;
    for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
      if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
      const spaces = line.match(/^\s*/)[0].replaceAll("\t", "    ").length;
      maximum = Math.max(maximum, Math.floor(spaces / 4));
    }
    return maximum;
  }
  let depth = 0;
  let maximum = 0;
  for (const character of content) {
    if (character === "{") {
      depth += 1;
      maximum = Math.max(maximum, depth);
    } else if (character === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return maximum;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(fraction * ordered.length) - 1];
}

function suppliedSourceRows(input) {
  for (const key of ["files", "source_files", "sources"]) {
    if (Array.isArray(input[key])) return input[key];
  }
  return null;
}

function outputByteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function recordGitCommandTelemetry(input, args, result) {
  const observer = input?.[INTERNAL_GIT_OBSERVER];
  if (typeof observer !== "function") return;
  const event = Object.freeze({
    command: Object.freeze([...args]),
    stdout_bytes: outputByteLength(result.stdout),
    stderr_bytes: outputByteLength(result.stderr),
    status: Number.isInteger(result.status) ? result.status : null,
    error_code: typeof result.error?.code === "string" ? result.error.code : null,
    ...(Number.isSafeInteger(result.saturation) ? { saturation: result.saturation } : {}),
    ...(Number.isSafeInteger(result.active_processes) ? { active_processes: result.active_processes } : {}),
    ...(Number.isSafeInteger(result.peak_active_processes) ? { peak_active_processes: result.peak_active_processes } : {}),
  });
  try {
    observer(event);
  } catch {
    // Benchmark telemetry must not affect local evidence collection.
  }
}

function runLocalGit(input, args, options = {}) {
  const repositoryRoot = path.resolve(input.repo_root);
  const result = spawnSync(input.git_executable ?? "git", ["-c", `safe.directory=${repositoryRoot}`, "-C", repositoryRoot, ...args], {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    windowsHide: true,
    shell: false,
    timeout: input.git_timeout_ms ?? 30_000,
    maxBuffer: input.git_max_buffer_bytes ?? GIT_MAX_BUFFER_BYTES,
    input: options.input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  recordGitCommandTelemetry(input, args, result);
  return result;
}

function cancellationError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("FAIL-GIT-CANCELLED: Git history collection was cancelled");
  error.code = "FAIL-GIT-CANCELLED";
  return error;
}

function checkGitCancellation(signal) {
  if (signal?.aborted) throw cancellationError(signal);
}

function normalizeGitAsyncOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("FAIL-INVALID-COLLECTOR-CONFIG: async Git options must be a closed record");
  }
  const unexpected = Object.keys(options).filter((key) => !["saturation", "signal"].includes(key)).sort(stableCompare);
  if (unexpected.length > 0) {
    throw new Error(`FAIL-INVALID-COLLECTOR-CONFIG: async Git options contain unexpected field ${unexpected[0]}`);
  }
  if (options.signal !== undefined && (
    typeof options.signal !== "object"
    || typeof options.signal.aborted !== "boolean"
    || typeof options.signal.addEventListener !== "function"
    || typeof options.signal.removeEventListener !== "function"
  )) {
    throw new Error("FAIL-INVALID-COLLECTOR-CONFIG: async Git signal must be an AbortSignal");
  }
  const requested = options.saturation ?? GIT_DEFAULT_SATURATION;
  let saturation;
  if (requested === "auto") {
    const available = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    const availableWorkers = Math.max(1, Math.min(GIT_MAX_SATURATION, available - 1));
    saturation = availableWorkers >= 4 ? 4 : availableWorkers >= 2 ? 2 : 1;
  } else {
    saturation = requested;
  }
  if (!Number.isSafeInteger(saturation) || !new Set([1, 2, 4]).has(saturation)) {
    throw new Error("FAIL-INVALID-COLLECTOR-CONFIG: async Git saturation must be 1, 2, 4, or auto");
  }
  checkGitCancellation(options.signal);
  return Object.freeze({ signal: options.signal, requested_saturation: requested, saturation });
}

function createSemaphore(limit) {
  let active = 0;
  const queued = [];
  const dispatch = () => {
    while (active < limit && queued.length > 0) {
      const waiter = queued.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(cancellationError(waiter.signal));
        continue;
      }
      active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        dispatch();
      });
    }
  };
  return Object.freeze({
    acquire(signal) {
      checkGitCancellation(signal);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: null };
        waiter.onAbort = () => {
          const index = queued.indexOf(waiter);
          if (index >= 0) queued.splice(index, 1);
          reject(cancellationError(signal));
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        queued.push(waiter);
        dispatch();
      });
    },
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitForProcessGroupExit(pid, timeoutMs = GIT_TERMINATION_GRACE_MS) {
  if (!processGroupExists(pid)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const inspect = () => {
      if (!processGroupExists(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      const timer = setTimeout(inspect, 20);
      timer.unref?.();
    };
    inspect();
  });
}

function waitForChild(child, timeoutMs = GIT_TERMINATION_GRACE_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const closed = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", closed);
    timer = setTimeout(() => {
      child.removeListener("close", closed);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
  });
}

function runTerminationCommand(executable, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, shell: false, stdio: "ignore" });
    } catch (error) {
      resolve({ status: null, error });
      return;
    }
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (status) => resolve({ status, error: spawnError }));
  });
}

async function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const terminated = await runTerminationCommand(taskkill, ["/PID", String(child.pid), "/T", "/F"]);
    if ((terminated.error || terminated.status !== 0) && processExists(child.pid)) {
      const error = new Error(`FAIL-GIT-PROCESS-CLEANUP: taskkill failed for Git process tree ${child.pid}`);
      error.code = "FAIL-GIT-PROCESS-CLEANUP";
      throw error;
    }
    const closed = await waitForChild(child);
    if (!closed || processExists(child.pid)) {
      const error = new Error(`FAIL-GIT-PROCESS-CLEANUP: unable to terminate Git process tree ${child.pid}`);
      error.code = "FAIL-GIT-PROCESS-CLEANUP";
      throw error;
    }
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (await waitForProcessGroupExit(child.pid)) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!await waitForProcessGroupExit(child.pid)) {
    const error = new Error(`FAIL-GIT-PROCESS-CLEANUP: unable to terminate Git process group ${child.pid}`);
    error.code = "FAIL-GIT-PROCESS-CLEANUP";
    throw error;
  }
}

function bufferedGitProcess(input, args, options, signal) {
  checkGitCancellation(signal);
  const maximum = input.git_max_buffer_bytes ?? GIT_MAX_BUFFER_BYTES;
  const timeoutMs = input.git_timeout_ms ?? 30_000;
  const encoding = Object.hasOwn(options, "encoding") ? options.encoding : "utf8";
  return new Promise((resolve, reject) => {
    let child;
    try {
      const repositoryRoot = path.resolve(input.repo_root);
      child = spawn(input.git_executable ?? "git", ["-c", `safe.directory=${repositoryRoot}`, "-C", repositoryRoot, ...args], {
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: encoding === null ? Buffer.alloc(0) : "", stderr: "", error });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnError = null;
    let terminalError = null;
    let aborted = false;
    let termination = null;
    let settled = false;
    const requestTermination = (reason) => {
      terminalError ??= reason;
      termination ??= terminateProcessTree(child).catch((error) => { terminalError = error; });
      return termination;
    };
    const onAbort = () => {
      aborted = true;
      void requestTermination(cancellationError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      const error = new Error(`Git process exceeded ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      void requestTermination(error);
    }, timeoutMs);
    timeout.unref?.();
    const collect = (chunks, byteCount, chunk) => {
      const next = byteCount + chunk.length;
      if (next > maximum) {
        const error = new Error(`Git process output exceeded ${maximum} bytes`);
        error.code = "ENOBUFS";
        void requestTermination(error);
        return byteCount;
      }
      chunks.push(chunk);
      return next;
    };
    child.stdout.on("data", (chunk) => { stdoutBytes = collect(stdoutChunks, stdoutBytes, chunk); });
    child.stderr.on("data", (chunk) => { stderrBytes = collect(stderrChunks, stderrBytes, chunk); });
    child.stdin.on("error", () => {
      // A process that exits or is cancelled before consuming stdin may close
      // the pipe first. Its exit/error record remains the authoritative result.
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", async (status, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (termination !== null) await termination;
      if (terminalError?.code === "FAIL-GIT-PROCESS-CLEANUP") {
        reject(terminalError);
        return;
      }
      if (aborted) {
        reject(cancellationError(signal));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
      const stderrBuffer = Buffer.concat(stderrChunks, stderrBytes);
      resolve({
        status,
        signal: childSignal,
        stdout: encoding === null ? stdout : stdout.toString(encoding),
        stderr: encoding === null ? stderrBuffer : stderrBuffer.toString(encoding),
        error: terminalError ?? spawnError,
      });
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

function createGitExecution(input, normalized) {
  const semaphore = createSemaphore(normalized.saturation);
  let activeProcesses = 0;
  let peakActiveProcesses = 0;
  return Object.freeze({
    ...normalized,
    async run(args, processOptions = {}) {
      const release = await semaphore.acquire(normalized.signal);
      activeProcesses += 1;
      peakActiveProcesses = Math.max(peakActiveProcesses, activeProcesses);
      try {
        const result = await bufferedGitProcess(input, args, processOptions, normalized.signal);
        recordGitCommandTelemetry(input, args, {
          ...result,
          saturation: normalized.saturation,
          active_processes: activeProcesses,
          peak_active_processes: peakActiveProcesses,
        });
        return result;
      } finally {
        activeProcesses -= 1;
        release();
      }
    },
  });
}

function commandFailure(result) {
  return result.error?.code ?? String(result.stderr || `exit ${result.status}`).trim();
}

function gitOutputBufferExceeded(result) {
  return result.error?.code === "ENOBUFS" || result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function resolveLocalRevisionBinding(input, { requireCleanWorktree = false } = {}) {
  if (typeof input.repo_root !== "string" || input.repo_root.length === 0) {
    return { available: false, reason: "repo_root is required for local collection" };
  }
  if (!FULL_GIT_REVISION.test(input.repository_revision)) {
    return { available: false, reason: "declared repository_revision must be a full Git commit ID for local collection" };
  }
  const resolved = runLocalGit(input, ["rev-parse", "--verify", "--end-of-options", `${input.repository_revision}^{commit}`]);
  if (resolved.error || resolved.status !== 0) {
    return { available: false, reason: `declared repository_revision cannot be resolved locally: ${commandFailure(resolved)}` };
  }
  const resolvedRevision = resolved.stdout.trim();
  if (resolvedRevision.toLowerCase() !== input.repository_revision.toLowerCase()) {
    return { available: false, reason: "declared repository_revision did not resolve to the same full commit ID" };
  }
  if (requireCleanWorktree) {
    const head = runLocalGit(input, ["rev-parse", "--verify", "HEAD"]);
    if (head.error || head.status !== 0 || head.stdout.trim().toLowerCase() !== resolvedRevision.toLowerCase()) {
      return { available: false, reason: "local source tree HEAD does not match declared repository_revision" };
    }
    const status = runLocalGit(input, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.error || status.status !== 0) {
      return { available: false, reason: `local source tree cleanliness cannot be verified: ${commandFailure(status)}` };
    }
    if (status.stdout.trim().length > 0) {
      return { available: false, reason: "local source tree is dirty and cannot be bound to declared repository_revision" };
    }
  }
  return { available: true, resolvedRevision };
}

function resolveLocalHistoryRevision(input, revision, label) {
  if (typeof revision !== "string" || revision.length === 0 || revision.startsWith("-")) {
    return { available: false, reason: `${label} is not a safe Git revision` };
  }
  const result = runLocalGit(input, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  if (result.error || result.status !== 0) {
    return { available: false, reason: `${label} cannot be resolved locally: ${commandFailure(result)}` };
  }
  return { available: true, resolvedRevision: result.stdout.trim() };
}

async function resolveLocalRevisionBindingAsync(input, execution, { requireCleanWorktree = false } = {}) {
  if (typeof input.repo_root !== "string" || input.repo_root.length === 0) {
    return { available: false, reason: "repo_root is required for local collection" };
  }
  if (!FULL_GIT_REVISION.test(input.repository_revision)) {
    return { available: false, reason: "declared repository_revision must be a full Git commit ID for local collection" };
  }
  const resolved = await execution.run(["rev-parse", "--verify", "--end-of-options", `${input.repository_revision}^{commit}`]);
  if (resolved.error || resolved.status !== 0) {
    return { available: false, reason: `declared repository_revision cannot be resolved locally: ${commandFailure(resolved)}` };
  }
  const resolvedRevision = resolved.stdout.trim();
  if (resolvedRevision.toLowerCase() !== input.repository_revision.toLowerCase()) {
    return { available: false, reason: "declared repository_revision did not resolve to the same full commit ID" };
  }
  if (requireCleanWorktree) {
    const head = await execution.run(["rev-parse", "--verify", "HEAD"]);
    if (head.error || head.status !== 0 || head.stdout.trim().toLowerCase() !== resolvedRevision.toLowerCase()) {
      return { available: false, reason: "local source tree HEAD does not match declared repository_revision" };
    }
    const status = await execution.run(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.error || status.status !== 0) {
      return { available: false, reason: `local source tree cleanliness cannot be verified: ${commandFailure(status)}` };
    }
    if (status.stdout.trim().length > 0) {
      return { available: false, reason: "local source tree is dirty and cannot be bound to declared repository_revision" };
    }
  }
  return { available: true, resolvedRevision };
}

async function resolveLocalHistoryRevisionAsync(input, revision, label, execution) {
  if (typeof revision !== "string" || revision.length === 0 || revision.startsWith("-")) {
    return { available: false, reason: `${label} is not a safe Git revision` };
  }
  const result = await execution.run(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  if (result.error || result.status !== 0) {
    return { available: false, reason: `${label} cannot be resolved locally: ${commandFailure(result)}` };
  }
  return { available: true, resolvedRevision: result.stdout.trim() };
}

function unavailableStaticEvidence(input, reason, analyzerVersion) {
  const sourceCollector = collectorRecord({
    id: "static-source",
    status: "unavailable",
    analyzerIdentity: STATIC_ANALYZER_ID,
    analyzerVersion,
    reason,
  });
  const specializedReason = "no verified specialized complexity analyzer was supplied";
  const specializedCollector = collectorRecord({
    id: "static-specialized-complexity",
    status: "unavailable",
    analyzerIdentity: SPECIALIZED_ANALYZER_ID,
    analyzerVersion: "unavailable",
    reason: specializedReason,
  });
  const window = revisionWindow(input);
  const sourceCommon = {
    family: "structural_complexity",
    status: "unavailable",
    reason,
    sourceKind: "local-source",
    collectorId: "static-source",
    artifactRefs: [],
    fallbackArtifact: "local-source:unavailable",
    window,
    analyzerIdentity: STATIC_ANALYZER_ID,
    analyzerVersion,
    includedInHuman: true,
  };
  const metrics = [
    ["static.source_file_count", "sei.static.source_file_count@1", "files"],
    ["static.human_source_file_count", "sei.static.human_source_file_count@1", "files"],
    ["static.source_lines", "sei.static.source_lines@1", "lines"],
    ["static.lexical_function_count", "sei.static.lexical_function_count@1", "lexically-matched-functions"],
    ["static.lexical_max_nesting_depth_p90", "sei.static.lexical_max_nesting_depth_p90@1", "lexical-brace-or-indentation-depth"],
  ].map(([metricId, definitionId, unit]) => metricRecord(input, { ...sourceCommon, metricId, definitionId, unit }));
  for (const [metricId, definitionId] of [
    ["static.cyclomatic_complexity", "sei.static.cyclomatic_complexity@1"],
    ["static.cognitive_complexity", "sei.static.cognitive_complexity@1"],
  ]) {
    metrics.push(metricRecord(input, {
      metricId,
      definitionId,
      family: "structural_complexity",
      unit: "analyzer-defined-score",
      status: "unavailable",
      reason: specializedReason,
      sourceKind: "analyzer-capability",
      collectorId: "static-specialized-complexity",
      artifactRefs: [],
      fallbackArtifact: "analyzer:unavailable",
      window,
      analyzerIdentity: SPECIALIZED_ANALYZER_ID,
      analyzerVersion: "unavailable",
      includedInHuman: true,
    }));
  }
  metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  const collectors = [sourceCollector, specializedCollector];
  return {
    collectors,
    capabilities: structuredClone(collectors),
    metrics,
    files: [],
    relationships: [],
    aggregates: {
      source_file_count: null,
      human_source_file_count: null,
      generated_source_file_count: null,
      unclassified_source_file_count: null,
      human_source_lines: null,
      human_source_lines_p50: null,
      human_source_lines_p90: null,
      human_lexical_max_nesting_depth_p50: null,
      human_lexical_max_nesting_depth_p90: null,
      by_language: null,
    },
  };
}

const STATIC_FILE_METRIC_FIELDS = new Map([
  ["static.source_lines", "source_lines"],
  ["static.lexical_function_count", "lexical_function_count"],
  ["static.lexical_max_nesting_depth", "lexical_max_nesting_depth"],
]);

function staticFileMetricField(metricId) {
  if (typeof metricId !== "string") return null;
  for (const [prefix, field] of STATIC_FILE_METRIC_FIELDS) {
    if (metricId.startsWith(`${prefix}:`)) return field;
  }
  return null;
}

function reusableStaticAnalyses(input, snapshot, analyzerVersion, expectedByPath = null) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return new Map();
  let validation;
  try {
    validation = validateSnapshot(snapshot);
  } catch {
    return new Map();
  }
  if (!validation.ok || snapshot.repository?.configuration_hash !== deriveCollectorConfigurationHash(input)) return new Map();
  const sourceCollector = snapshot.collectors?.find((collector) => collector?.collector_id === "static-source");
  if (
    !sourceCollector ||
    !["available", "degraded"].includes(sourceCollector.status) ||
    sourceCollector.collector_version !== COLLECTOR_VERSION ||
    sourceCollector.analyzer_identity !== STATIC_ANALYZER_ID ||
    sourceCollector.analyzer_version !== analyzerVersion
  ) {
    return new Map();
  }

  const candidates = new Map();
  const invalidPaths = new Set();
  for (const metric of snapshot.measurements ?? []) {
    const field = staticFileMetricField(metric?.metric_id);
    if (field === null || invalidPaths.has(metric?.scope?.path)) continue;
    const metricPath = metric?.scope?.path;
    const refs = metric?.source?.artifact_refs;
    const blobRefs = Array.isArray(refs)
      ? refs.filter((reference) => /^git-blob:([0-9a-f]{40}|[0-9a-f]{64})$/.test(reference))
      : [];
    if (
      typeof metricPath !== "string" || metricPath.length === 0 ||
      metric?.subject !== `file:${metricPath}` ||
      metric?.scope?.kind !== "file" ||
      typeof metric?.scope?.language !== "string" ||
      typeof metric?.scope?.generated_code !== "boolean" ||
      typeof metric?.scope?.included_in_human_maintainability !== "boolean" ||
      metric?.measurement?.status !== "measured" ||
      !Number.isInteger(metric.value) || metric.value < 0 ||
      metric?.source?.kind !== "local-source" ||
      metric?.source?.collector_id !== "static-source" ||
      metric?.source?.collector_version !== COLLECTOR_VERSION ||
      metric?.analyzer_identity !== STATIC_ANALYZER_ID ||
      metric?.analyzer_version !== analyzerVersion ||
      metric?.comparability?.configuration_hash !== deriveCollectorConfigurationHash(input) ||
      blobRefs.length !== 1 || !refs.includes(metricPath)
    ) {
      if (typeof metricPath === "string") invalidPaths.add(metricPath);
      continue;
    }
    const candidate = candidates.get(metricPath) ?? {
      object_id: blobRefs[0].slice("git-blob:".length),
      language: metric.scope.language,
      generated_code: metric.scope.generated_code,
      included_in_human_maintainability: metric.scope.included_in_human_maintainability,
      values: {},
    };
    if (
      candidate.object_id !== blobRefs[0].slice("git-blob:".length) ||
      candidate.language !== metric.scope.language ||
      candidate.generated_code !== metric.scope.generated_code ||
      candidate.included_in_human_maintainability !== metric.scope.included_in_human_maintainability ||
      Object.hasOwn(candidate.values, field)
    ) {
      invalidPaths.add(metricPath);
      candidates.delete(metricPath);
      continue;
    }
    candidate.values[field] = metric.value;
    candidates.set(metricPath, candidate);
  }

  const patternsPresent = Array.isArray(input.generated_path_patterns);
  const patterns = patternsPresent ? input.generated_path_patterns.map(normalizePath).sort(stableCompare) : [];
  const reusable = new Map();
  for (const [filePath, candidate] of candidates) {
    if (
      invalidPaths.has(filePath) ||
      !Object.values(STATIC_FILE_METRIC_FIELDS).every((field) => Number.isInteger(candidate.values[field]))
    ) continue;
    const expected = expectedByPath?.get(filePath);
    const classification = expected === undefined
      ? classifyGenerated({ path: filePath }, patternsPresent, patterns)
      : {
          generated: expected.generated_code,
          known: expected.generated_classification_known,
        };
    const language = expected?.language ?? detectLanguage(filePath, undefined);
    if (
      candidate.language !== language ||
      candidate.generated_code !== classification.generated ||
      candidate.included_in_human_maintainability !== (classification.known && !classification.generated)
    ) continue;
    reusable.set(filePath, {
      object_id: candidate.object_id,
      language,
      generated_code: candidate.generated_code,
      included_in_human_maintainability: candidate.included_in_human_maintainability,
      ...candidate.values,
    });
  }
  return reusable;
}

function normalizeSourceRows(rows) {
  const seenPaths = new Set();
  return rows.map((file, index) => {
    if (
      !file || typeof file.path !== "string" || file.path.length === 0 ||
      (typeof file.content !== "string" && !file.cached_analysis)
    ) {
      throw new Error(`FAIL-MALFORMED-SOURCE-RECORD: source row ${index} requires string path and content or a validated cached analysis`);
    }
    const normalizedPath = normalizePath(file.path);
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`FAIL-DUPLICATE-SOURCE-PATH: source row ${index} duplicates normalized path ${normalizedPath}`);
    }
    seenPaths.add(normalizedPath);
    return { ...file, path: normalizedPath };
  }).sort((left, right) => stableCompare(left.path, right.path));
}

function materializeStaticEvidence(input, normalizedRows, analyzerVersion, collectionKind) {
  const patternsPresent = Array.isArray(input.generated_path_patterns);
  const patterns = patternsPresent ? input.generated_path_patterns.map(normalizePath).sort(stableCompare) : [];
  const rows = normalizeSourceRows(normalizedRows);

  let reusedFileCount = 0;
  const files = rows.map((file) => {
    const classification = file.index_classification ?? classifyGenerated(file, patternsPresent, patterns);
    const language = detectLanguage(file.path, file.language);
    const cached = file.cached_analysis;
    if (cached) reusedFileCount += 1;
    return {
      path: file.path,
      language,
      generated_code: classification.generated,
      generated_classification_known: classification.known,
      generated_classification_reason: classification.reason,
      included_in_human_maintainability: classification.known && !classification.generated,
      source_blob_id: typeof file.object_id === "string" ? file.object_id : null,
      source_lines: cached ? cached.source_lines : lineCount(file.content),
      lexical_function_count: cached ? cached.lexical_function_count : lexicalFunctionCount(file.content, language),
      lexical_max_nesting_depth: cached ? cached.lexical_max_nesting_depth : lexicalMaxNesting(file.content, language),
    };
  });
  const human = files.filter((file) => file.included_in_human_maintainability);
  const byLanguage = {};
  for (const file of files) {
    const partition = byLanguage[file.language] ?? { source_file_count: 0, human_source_file_count: 0, generated_source_file_count: 0, source_lines: 0, human_source_lines: 0 };
    partition.source_file_count += 1;
    partition.source_lines += file.source_lines;
    if (file.included_in_human_maintainability) {
      partition.human_source_file_count += 1;
      partition.human_source_lines += file.source_lines;
    }
    if (file.generated_code) partition.generated_source_file_count += 1;
    byLanguage[file.language] = partition;
  }
  const aggregates = {
    source_file_count: files.length,
    human_source_file_count: human.length,
    generated_source_file_count: files.filter((file) => file.generated_code).length,
    unclassified_source_file_count: files.filter((file) => !file.generated_classification_known).length,
    human_source_lines: human.reduce((sum, file) => sum + file.source_lines, 0),
    human_source_lines_p50: percentile(human.map((file) => file.source_lines), 0.5),
    human_source_lines_p90: percentile(human.map((file) => file.source_lines), 0.9),
    human_lexical_max_nesting_depth_p50: percentile(human.map((file) => file.lexical_max_nesting_depth), 0.5),
    human_lexical_max_nesting_depth_p90: percentile(human.map((file) => file.lexical_max_nesting_depth), 0.9),
    by_language: Object.fromEntries(Object.entries(byLanguage).sort(([left], [right]) => stableCompare(left, right))),
  };
  const artifactRefs = files.map((file) => file.path);
  const window = revisionWindow(input);
  const hasUnclassifiedFiles = files.some((file) => !file.generated_classification_known);
  const humanPercentileStatus = hasUnclassifiedFiles
    ? "unverifiable"
    : human.length === 0 ? "not-applicable" : "measured";
  const humanPercentileReason = hasUnclassifiedFiles
    ? "human-source percentile is unverifiable because generated classification is incomplete"
    : human.length === 0 ? "no human-maintained source files are in scope" : null;
  const common = {
    family: "structural_complexity",
    status: "measured",
    sourceKind: collectionKind === "indexed" ? "local-source" : "supplied-source",
    collectorId: "static-source",
    artifactRefs,
    fallbackArtifact: collectionKind === "indexed" ? normalizePath(input.repo_root ?? ".") : "supplied:source_rows",
    window,
    analyzerIdentity: STATIC_ANALYZER_ID,
    analyzerVersion,
    includedInHuman: true,
  };
  const metrics = [
    metricRecord(input, { ...common, metricId: "static.source_file_count", definitionId: "sei.static.source_file_count@1", value: files.length, unit: "files" }),
    metricRecord(input, { ...common, metricId: "static.human_source_file_count", definitionId: "sei.static.human_source_file_count@1", value: human.length, unit: "files" }),
    metricRecord(input, { ...common, metricId: "static.source_lines", definitionId: "sei.static.source_lines@1", value: aggregates.human_source_lines, unit: "lines" }),
    metricRecord(input, { ...common, metricId: "static.lexical_function_count", definitionId: "sei.static.lexical_function_count@1", value: human.reduce((sum, file) => sum + file.lexical_function_count, 0), unit: "lexically-matched-functions" }),
    metricRecord(input, {
      ...common,
      metricId: "static.lexical_max_nesting_depth_p90",
      definitionId: "sei.static.lexical_max_nesting_depth_p90@1",
      value: aggregates.human_lexical_max_nesting_depth_p90,
      unit: "lexical-brace-or-indentation-depth",
      status: humanPercentileStatus,
      reason: humanPercentileReason,
      completeness: hasUnclassifiedFiles ? 0 : 1,
      confidence: hasUnclassifiedFiles ? 0 : 1,
    }),
  ];
  for (const file of files) {
    const fileCommon = {
      ...common,
      subject: `file:${file.path}`,
      artifactRefs: [file.path, ...(file.source_blob_id === null ? [] : [`git-blob:${file.source_blob_id}`])],
      scopeKind: "file",
      scopePath: file.path,
      language: file.language,
      generatedCode: file.generated_code,
      includedInHuman: file.included_in_human_maintainability,
    };
    metrics.push(
      metricRecord(input, { ...fileCommon, metricId: `static.source_lines:${file.path}`, definitionId: "sei.static.source_lines@1", value: file.source_lines, unit: "lines" }),
      metricRecord(input, { ...fileCommon, metricId: `static.lexical_function_count:${file.path}`, definitionId: "sei.static.lexical_function_count@1", value: file.lexical_function_count, unit: "lexically-matched-functions" }),
      metricRecord(input, { ...fileCommon, metricId: `static.lexical_max_nesting_depth:${file.path}`, definitionId: "sei.static.lexical_max_nesting_depth@1", value: file.lexical_max_nesting_depth, unit: "lexical-brace-or-indentation-depth" }),
    );
  }
  const specializedReason = "no verified specialized complexity analyzer was supplied";
  for (const [metricId, definitionId] of [
    ["static.cyclomatic_complexity", "sei.static.cyclomatic_complexity@1"],
    ["static.cognitive_complexity", "sei.static.cognitive_complexity@1"],
  ]) {
    metrics.push(metricRecord(input, {
      metricId,
      definitionId,
      family: "structural_complexity",
      unit: "analyzer-defined-score",
      status: "unavailable",
      reason: specializedReason,
      sourceKind: "analyzer-capability",
      collectorId: "static-specialized-complexity",
      artifactRefs,
      fallbackArtifact: "analyzer:unavailable",
      window,
      analyzerIdentity: SPECIALIZED_ANALYZER_ID,
      analyzerVersion: "unavailable",
      includedInHuman: true,
    }));
  }
  metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  const collectors = [
    collectorRecord({
      id: "static-source",
      status: patternsPresent || files.every((file) => file.generated_classification_known) ? "available" : "degraded",
      analyzerIdentity: STATIC_ANALYZER_ID,
      analyzerVersion,
      reason: patternsPresent || files.every((file) => file.generated_classification_known) ? null : "generated path patterns were not supplied; unclassified files were excluded from human-maintainability aggregates",
    }),
    collectorRecord({
      id: "static-specialized-complexity",
      status: "unavailable",
      analyzerIdentity: SPECIALIZED_ANALYZER_ID,
      analyzerVersion: "unavailable",
      reason: specializedReason,
    }),
  ];
  const analysisCache = collectionKind === "supplied"
    ? { cache: "not-applicable", reused_file_count: 0, recomputed_file_count: files.length }
    : {
      cache: reusedFileCount === 0 ? "miss" : reusedFileCount === files.length ? "hit" : "partial",
      reused_file_count: reusedFileCount,
      recomputed_file_count: files.length - reusedFileCount,
    };
  const publicFiles = files.map(({ source_blob_id, ...file }) => file);
  return { collectors, capabilities: structuredClone(collectors), metrics, files: publicFiles, relationships: [], aggregates, analysis_cache: analysisCache };
}

function collectStaticEvidence(input = {}) {
  repositoryRevision(input);
  const rows = suppliedSourceRows(input);
  if (rows === null) throw new Error("FAIL-REPOSITORY-INDEX-REQUIRED: repository-local static collection requires collectStaticEvidenceFromIndex");
  const analyzerVersion = input.static_analyzer_version ?? STATIC_ANALYZER_VERSION;
  return materializeStaticEvidence(input, rows, analyzerVersion, "supplied");
}

function validateIndexedStaticInput(input, repositoryIndex, options) {
  repositoryRevision(input);
  if (!repositoryIndex || typeof repositoryIndex !== "object" || !Array.isArray(repositoryIndex.entries) || typeof repositoryIndex.readBlobs !== "function") {
    throw new Error("FAIL-REPOSITORY-INDEX-REQUIRED: repository_index must expose entries and readBlobs");
  }
  if (repositoryIndex.binding?.repository_revision !== input.repository_revision) {
    throw new Error("FAIL-REPOSITORY-INDEX-REVISION-MISMATCH: repository index revision does not match collector input");
  }
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => key !== "signal")) {
    throw new Error("FAIL-REPOSITORY-INDEX-INPUT: indexed static options contain unsupported fields");
  }
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== "boolean" || typeof options.signal.addEventListener !== "function")) {
    throw new Error("FAIL-REPOSITORY-INDEX-INPUT: signal must be an AbortSignal");
  }
  return 32 * 1024 * 1024;
}

function requireIndexedStaticNotCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("FAIL-REPOSITORY-INDEX-CANCELLED: indexed static collection was cancelled");
  error.code = "FAIL-REPOSITORY-INDEX-CANCELLED";
  throw error;
}

async function collectStaticEvidenceFromIndexCore(input = {}, repositoryIndex, options = {}, compactReusable = null) {
  const maxBatchBytes = validateIndexedStaticInput(input, repositoryIndex, options);
  requireIndexedStaticNotCancelled(options.signal);
  const analyzerVersion = input.static_analyzer_version ?? STATIC_ANALYZER_VERSION;
  const entries = repositoryIndex.entries.filter((entry) => (
    (entry.mode === "100644" || entry.mode === "100755") && entry.classifications?.source === true
  ));
  const expectedByPath = new Map(entries.map((entry) => {
    const known = entry.classifications.generated !== "unknown";
    return [entry.path, {
      language: entry.language,
      generated_code: entry.classifications.generated === "generated",
      generated_classification_known: known,
    }];
  }));
  const reusableByPath = compactReusable ?? reusableStaticAnalyses(input, input.prior_static_snapshot, analyzerVersion, expectedByPath);
  const rows = [];
  const misses = [];
  for (const entry of entries) {
    const expected = expectedByPath.get(entry.path);
    const cached = reusableByPath.get(entry.path);
    const indexClassification = {
      generated: expected.generated_code,
      known: expected.generated_classification_known,
      reason: expected.generated_classification_known
        ? (expected.generated_code ? "matched generated path pattern" : "did not match generated path patterns")
        : "generated path patterns were not supplied",
    };
    if (
      cached?.object_id === entry.blob_oid &&
      cached.language === expected.language &&
      cached.generated_code === expected.generated_code &&
      cached.included_in_human_maintainability === (expected.generated_classification_known && !expected.generated_code)
    ) {
      rows.push({
        path: entry.path,
        object_id: entry.blob_oid,
        language: entry.language,
        index_classification: indexClassification,
        cached_analysis: cached,
      });
    } else {
      if (entry.byte_size > maxBatchBytes) {
        return unavailableStaticEvidence(input, `local source inventory unavailable: ${entry.path} exceeds the ${maxBatchBytes}-byte static batch bound`, analyzerVersion);
      }
      misses.push({ entry, indexClassification });
    }
  }
  for (let offset = 0; offset < misses.length;) {
    requireIndexedStaticNotCancelled(options.signal);
    const batch = [];
    let batchBytes = 0;
    while (offset < misses.length && batchBytes + misses[offset].entry.byte_size <= maxBatchBytes) {
      batch.push(misses[offset]);
      batchBytes += misses[offset].entry.byte_size;
      offset += 1;
    }
    let blobs;
    try {
      blobs = await repositoryIndex.readBlobs(batch.map((item) => item.entry), {
        max_blob_bytes: maxBatchBytes,
        max_total_bytes: maxBatchBytes,
        signal: options.signal,
      });
    } catch (error) {
      if (String(error?.message).startsWith("FAIL-REPOSITORY-INDEX-CANCELLED")) throw error;
      throw error;
    }
    for (const item of batch) {
      const bytes = blobs.get(item.entry.path);
      if (!Buffer.isBuffer(bytes)) throw new Error(`FAIL-REPOSITORY-INDEX-BLOB: missing indexed source blob ${item.entry.path}`);
      rows.push({
        path: item.entry.path,
        object_id: item.entry.blob_oid,
        language: item.entry.language,
        index_classification: item.indexClassification,
        content: bytes.toString("utf8"),
      });
    }
  }
  requireIndexedStaticNotCancelled(options.signal);
  return materializeStaticEvidence(input, rows, analyzerVersion, "indexed");
}

async function collectStaticEvidenceFromIndex(input = {}, repositoryIndex, options = {}) {
  return collectStaticEvidenceFromIndexCore(input, repositoryIndex, options);
}

function compactStaticReusable(input, repositoryIndex, repositoryId, stages) {
  if (typeof repositoryId !== "string" || repositoryId.length === 0 || !Array.isArray(stages)) {
    throw new Error("FAIL-INCREMENTAL-STATE: compact static collector requires repository_id and prior_stages");
  }
  const analyzerVersion = input.static_analyzer_version ?? STATIC_ANALYZER_VERSION;
  const configurationHash = deriveCollectorConfigurationHash(input);
  const compatible = [];
  for (const stage of stages) {
    const document = incrementalStatePrivate.readStage(stage, "static");
    const binding = document.binding;
    if (
      binding.repository_id !== repositoryId ||
      binding.object_format !== repositoryIndex.binding.object_format ||
      binding.collector_version !== COLLECTOR_VERSION ||
      binding.analyzer_identity !== STATIC_ANALYZER_ID ||
      binding.analyzer_version !== analyzerVersion ||
      binding.configuration_hash !== configurationHash ||
      binding.classification_policy_version !== repositoryIndex.binding.classification_policy_version
    ) continue;
    compatible.push(document);
  }
  const exact = new Map();
  const conflictedExact = new Set();
  const content = new Map();
  const conflictedContent = new Set();
  for (const document of compatible) {
    for (const entry of document.entries) {
      const analysis = {
        object_id: entry.blob_oid,
        language: entry.language,
        generated_code: entry.generated_code,
        included_in_human_maintainability: entry.included_in_human_maintainability,
        source_lines: entry.source_lines,
        lexical_function_count: entry.lexical_function_count,
        lexical_max_nesting_depth: entry.lexical_max_nesting_depth,
      };
      const exactKey = `${entry.path}\0${entry.entry_key}`;
      const exactPrior = exact.get(exactKey);
      const exactFacts = JSON.stringify([
        analysis.source_lines,
        analysis.lexical_function_count,
        analysis.lexical_max_nesting_depth,
      ]);
      if (exactPrior !== undefined && exactPrior.facts !== exactFacts) {
        conflictedExact.add(exactKey);
        exact.delete(exactKey);
      } else if (!conflictedExact.has(exactKey)) {
        exact.set(exactKey, { facts: exactFacts, analysis });
      }
      const contentKey = `${entry.content_key}\0${entry.language}`;
      const prior = content.get(contentKey);
      const facts = JSON.stringify([
        analysis.source_lines,
        analysis.lexical_function_count,
        analysis.lexical_max_nesting_depth,
      ]);
      if (prior !== undefined && prior.facts !== facts) {
        conflictedContent.add(contentKey);
        content.delete(contentKey);
      } else if (!conflictedContent.has(contentKey)) {
        content.set(contentKey, { facts, analysis });
      }
    }
  }
  const reusable = new Map();
  for (const entry of repositoryIndex.entries) {
    if (!((entry.mode === "100644" || entry.mode === "100755") && entry.classifications?.source === true)) continue;
    const selected = exact.get(`${entry.path}\0${entry.entry_key}`)?.analysis
      ?? content.get(`${entry.content_key}\0${entry.language}`)?.analysis;
    if (selected === undefined) continue;
    const known = entry.classifications.generated !== "unknown";
    reusable.set(entry.path, {
      object_id: entry.blob_oid,
      language: entry.language,
      generated_code: entry.classifications.generated === "generated",
      included_in_human_maintainability: known && entry.classifications.generated !== "generated",
      source_lines: selected.source_lines,
      lexical_function_count: selected.lexical_function_count,
      lexical_max_nesting_depth: selected.lexical_max_nesting_depth,
    });
  }
  return reusable;
}

function staticStageFromEvidence(input, repositoryIndex, repositoryId, evidence) {
  const files = new Map(evidence.files.map((file) => [file.path, file]));
  const entries = repositoryIndex.entries
    .filter((entry) => (entry.mode === "100644" || entry.mode === "100755") && entry.classifications?.source === true)
    .map((entry) => {
      const file = files.get(entry.path);
      if (!file) throw new Error(`FAIL-INCREMENTAL-STATE: compact static evidence omitted ${entry.path}`);
      return {
        path: entry.path,
        blob_oid: entry.blob_oid,
        content_key: entry.content_key,
        entry_key: entry.entry_key,
        mode: entry.mode,
        language: file.language,
        generated_code: file.generated_code,
        generated_classification_known: file.generated_classification_known,
        included_in_human_maintainability: file.included_in_human_maintainability,
        source_lines: file.source_lines,
        lexical_function_count: file.lexical_function_count,
        lexical_max_nesting_depth: file.lexical_max_nesting_depth,
      };
    });
  return incrementalStatePrivate.createStaticStage({
    binding: {
      repository_id: repositoryId,
      repository_revision: repositoryIndex.binding.repository_revision,
      root_tree_oid: repositoryIndex.binding.root_tree_oid,
      object_format: repositoryIndex.binding.object_format,
      index_digest: repositoryIndex.binding.index_digest,
      classification_policy_version: repositoryIndex.binding.classification_policy_version,
      collector_version: COLLECTOR_VERSION,
      analyzer_identity: STATIC_ANALYZER_ID,
      analyzer_version: input.static_analyzer_version ?? STATIC_ANALYZER_VERSION,
      configuration_hash: deriveCollectorConfigurationHash(input),
    },
    entries,
  });
}

async function collectStaticEvidenceIncremental(input = {}, repositoryIndex, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["prior_stages", "repository_id", "signal"].includes(key))) {
    throw new Error("FAIL-INCREMENTAL-STATE: compact static options are not closed");
  }
  const reusable = compactStaticReusable(input, repositoryIndex, options.repository_id, options.prior_stages);
  const evidence = await collectStaticEvidenceFromIndexCore(
    input,
    repositoryIndex,
    options.signal === undefined ? {} : { signal: options.signal },
    reusable,
  );
  const stage = staticStageFromEvidence(input, repositoryIndex, options.repository_id, evidence);
  return Object.freeze({
    evidence,
    stage,
    telemetry: Object.freeze({
      mode: evidence.analysis_cache.cache,
      reused_file_count: evidence.analysis_cache.reused_file_count,
      recomputed_file_count: evidence.analysis_cache.recomputed_file_count,
    }),
  });
}

function suppliedHistoryRows(input) {
  for (const key of ["commits", "history", "history_rows", "git_events"]) {
    if (Array.isArray(input[key])) return input[key];
  }
  return null;
}

function validateCommitRows(rows) {
  const seenRevisions = new Set();
  return rows.map((commit, commitIndex) => {
    if (!commit || typeof commit.revision !== "string" || commit.revision.length === 0 ||
        typeof commit.timestamp !== "string" ||
        typeof commit.author !== "string" || commit.author.length === 0 || !Array.isArray(commit.files) ||
        (commit.is_merge !== undefined && typeof commit.is_merge !== "boolean")) {
      throw new Error(`FAIL-MALFORMED-GIT-RECORD: commit row ${commitIndex} is incomplete`);
    }
    const timestamp = normalizeGitTimestamp(commit.timestamp, `commit row ${commitIndex} timestamp`);
    const normalizedRevision = commit.revision.toLowerCase();
    if (seenRevisions.has(normalizedRevision)) {
      throw new Error(`FAIL-DUPLICATE-GIT-COMMIT: commit row ${commitIndex} duplicates revision ${commit.revision}`);
    }
    seenRevisions.add(normalizedRevision);
    const seenPaths = new Set();
    const files = commit.files.map((file, fileIndex) => {
      if (!file || typeof file.path !== "string" || file.path.length === 0) {
        throw new Error(`FAIL-MALFORMED-GIT-RECORD: commit row ${commitIndex} file row ${fileIndex} is invalid`);
      }
      const binaryChange = file.binary_change === true;
      if (binaryChange) {
        if (file.added !== null || file.deleted !== null) {
          throw new Error(`FAIL-MALFORMED-GIT-RECORD: binary commit row ${commitIndex} file row ${fileIndex} must use null numstat churn`);
        }
      } else if (!Number.isInteger(file.added) || file.added < 0 || !Number.isInteger(file.deleted) || file.deleted < 0) {
        throw new Error(`FAIL-MALFORMED-GIT-RECORD: commit row ${commitIndex} file row ${fileIndex} is invalid`);
      }
      const normalizedPath = normalizeGitPath(file.path, `commit row ${commitIndex} file row ${fileIndex} path`);
      if (seenPaths.has(normalizedPath)) {
        throw new Error(`FAIL-DUPLICATE-GIT-PATH: commit row ${commitIndex} duplicates normalized path ${normalizedPath}`);
      }
      seenPaths.add(normalizedPath);
      const changeKind = file.change_kind ?? "modify";
      if (!new Set(["add", "copy", "delete", "modify", "rename", "type_change", "other"]).has(changeKind)) {
        throw new Error(`FAIL-MALFORMED-GIT-RECORD: commit row ${commitIndex} file row ${fileIndex} has an unsupported change_kind`);
      }
      const previousPath = file.previous_path === undefined
        ? null
        : normalizeGitPath(file.previous_path, `commit row ${commitIndex} file row ${fileIndex} previous_path`);
      if ((changeKind === "rename" || changeKind === "copy") && (previousPath === null || previousPath.length === 0)) {
        throw new Error(`FAIL-MALFORMED-GIT-RECORD: commit row ${commitIndex} ${changeKind} row ${fileIndex} requires previous_path`);
      }
      if ((changeKind !== "rename" && changeKind !== "copy") && previousPath !== null) {
        throw new Error(`FAIL-MALFORMED-GIT-RECORD: commit row ${commitIndex} file row ${fileIndex} cannot supply previous_path`);
      }
      const normalized = {
        path: normalizedPath,
        added: binaryChange ? null : file.added,
        deleted: binaryChange ? null : file.deleted,
        binary_change: binaryChange,
        change_kind: changeKind,
      };
      if (previousPath !== null) normalized.previous_path = previousPath;
      return normalized;
    }).sort((left, right) => stableCompare(left.path, right.path));
    return { revision: commit.revision, timestamp, author: commit.author, is_merge: commit.is_merge === true, files };
  }).sort((left, right) => stableCompare(left.timestamp, right.timestamp) || stableCompare(left.revision, right.revision));
}

function nullTerminatedTokens(output, label) {
  if (!Buffer.isBuffer(output)) {
    throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} did not return a byte stream`);
  }
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0x00) {
    throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} was not NUL terminated`);
  }
  const tokens = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0x00) continue;
    try {
      tokens.push(new TextDecoder("utf-8", { fatal: true }).decode(output.subarray(start, index)));
    } catch {
      throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} contained a non-UTF-8 path`);
    }
    start = index + 1;
  }
  return tokens;
}

function pathStatusKind(status) {
  switch (status[0]) {
    case "A": return "add";
    case "C": return "copy";
    case "D": return "delete";
    case "M": return "modify";
    case "R": return "rename";
    case "T": return "type_change";
    default: return "other";
  }
}

function parseNameStatus(output) {
  const tokens = nullTerminatedTokens(output, "git name-status");
  const rows = new Map();
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!/^[ACDMRTUXB](?:\d+)?$/.test(status)) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: git name-status contained an unsupported status token");
    }
    const kind = pathStatusKind(status);
    const needsSource = status[0] === "R" || status[0] === "C";
    const previousPath = needsSource ? tokens[index++] : null;
    const filePath = tokens[index++];
    if (typeof filePath !== "string" || filePath.length === 0 || (needsSource && (typeof previousPath !== "string" || previousPath.length === 0))) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: git name-status contained an incomplete path record");
    }
    const key = needsSource ? `${previousPath}\0${filePath}` : filePath;
    if (rows.has(key)) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: git name-status duplicated a path record");
    }
    rows.set(key, { path: filePath, previous_path: previousPath, change_kind: kind });
  }
  return rows;
}

function parseNumstat(output) {
  const tokens = nullTerminatedTokens(output, "git numstat");
  const rows = [];
  for (let index = 0; index < tokens.length;) {
    const row = tokens[index++];
    const firstTab = row.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : row.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: git numstat contained an incomplete row");
    }
    const added = row.slice(0, firstTab);
    const deleted = row.slice(firstTab + 1, secondTab);
    let previousPath = null;
    let filePath = row.slice(secondTab + 1);
    if (filePath.length === 0) {
      previousPath = tokens[index++];
      filePath = tokens[index++];
    }
    if (typeof filePath !== "string" || filePath.length === 0 || (previousPath !== null && (typeof previousPath !== "string" || previousPath.length === 0))) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: git numstat contained an incomplete path record");
    }
    const binaryChange = added === "-" && deleted === "-";
    if (!binaryChange && (!/^\d+$/.test(added) || !/^\d+$/.test(deleted))) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: git numstat contained non-numeric churn");
    }
    rows.push({
      path: filePath,
      previous_path: previousPath,
      added: binaryChange ? null : Number(added),
      deleted: binaryChange ? null : Number(deleted),
      binary_change: binaryChange,
    });
  }
  return rows;
}

function joinGitChangeRows(statuses, numbers) {
  const seen = new Set();
  const files = numbers.map((number) => {
    const key = number.previous_path === null ? number.path : `${number.previous_path}\0${number.path}`;
    const status = statuses.get(key);
    if (!status) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: Git numstat and name-status disagreed about a path");
    }
    seen.add(key);
    const row = { ...number, change_kind: status.change_kind };
    if (status.previous_path === null) delete row.previous_path;
    return row;
  });
  if (seen.size !== statuses.size) {
    throw new Error("FAIL-MALFORMED-GIT-RECORD: Git name-status and numstat did not cover the same paths");
  }
  return files;
}

function readNulDelimitedField(output, offset, label) {
  const end = output.indexOf(0x00, offset);
  if (end === -1) throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} was incomplete`);
  return { value: output.subarray(offset, end).toString("utf8"), nextOffset: end + 1 };
}

function parseBatchedShowFrames(output, revisions, label) {
  if (!Buffer.isBuffer(output)) {
    throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} did not return a byte stream`);
  }
  const frames = [];
  let searchOffset = 0;
  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index];
    const marker = Buffer.from(`\0${GIT_SHOW_FRAME_MARKER}\0${revision}\0`, "utf8");
    const markerOffset = output.indexOf(marker, searchOffset);
    if (markerOffset === -1 || (index === 0 && markerOffset !== 0)) {
      throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} contained an unexpected revision frame`);
    }
    const timestamp = readNulDelimitedField(output, markerOffset + marker.length, `${label} timestamp`);
    const author = readNulDelimitedField(output, timestamp.nextOffset, `${label} author`);
    const parents = readNulDelimitedField(output, author.nextOffset, `${label} parents`);
    if (author.value.length === 0) {
      throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} commit metadata was incomplete for ${revision}`);
    }
    const parentIds = parents.value.length === 0 ? [] : parents.value.split(" ");
    if (parentIds.some((parent) => !FULL_GIT_REVISION.test(parent)) || parentIds.length !== new Set(parentIds).size) {
      throw new Error(`FAIL-MALFORMED-GIT-RECORD: ${label} parent metadata was invalid for ${revision}`);
    }
    frames.push({
      revision,
      timestamp: normalizeGitTimestamp(timestamp.value, `${label} timestamp for ${revision}`),
      author: author.value,
      parent_count: parentIds.length,
      data_start: parents.nextOffset,
      marker_offset: markerOffset,
    });
    searchOffset = parents.nextOffset;
  }
  return frames.map((frame, index) => ({
    ...frame,
    changes: output.subarray(frame.data_start, index + 1 < frames.length ? frames[index + 1].marker_offset : output.length),
  }));
}

function stripGitShowHeaderSeparator(changes) {
  let offset = 0;
  while (offset < changes.length && changes[offset] === 0x00) offset += 1;
  if (changes[offset] === 0x0a) offset += 1;
  else if (changes[offset] === 0x0d && changes[offset + 1] === 0x0a) offset += 2;
  return changes.subarray(offset);
}

function readGitBatch(input, baseArgs, batch) {
  const statusResult = runLocalGit(input, [...baseArgs, "--name-status", ...batch], { encoding: null });
  const numstatResult = runLocalGit(input, [...baseArgs, "--numstat", ...batch], { encoding: null });
  if (gitOutputBufferExceeded(statusResult) || gitOutputBufferExceeded(numstatResult)) return null;
  if (statusResult.error || statusResult.status !== 0 || numstatResult.error || numstatResult.status !== 0) {
    throw new Error("FAIL-MALFORMED-GIT-RECORD: Git revision-batch change records were unavailable");
  }
  const statusFrames = parseBatchedShowFrames(statusResult.stdout, batch, "git show name-status");
  const numstatFrames = parseBatchedShowFrames(numstatResult.stdout, batch, "git show numstat");
  return batch.map((revision, index) => {
    const status = statusFrames[index];
    const numstat = numstatFrames[index];
    if (
      status.revision !== numstat.revision
      || status.timestamp !== numstat.timestamp
      || status.author !== numstat.author
      || status.parent_count !== numstat.parent_count
    ) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: Git revision-batch frames disagreed about commit metadata");
    }
    // A merge is evidence that a merge occurred, but its tree may contain the
    // already-observed branch commits. Treating a first-parent diff as ordinary
    // file activity double-counts those changes, so merge file rows remain empty.
    const files = status.parent_count > 1
      ? []
      : joinGitChangeRows(
        parseNameStatus(stripGitShowHeaderSeparator(status.changes)),
        parseNumstat(stripGitShowHeaderSeparator(numstat.changes)),
      );
    return {
      revision,
      timestamp: status.timestamp,
      author: status.author,
      is_merge: status.parent_count > 1,
      files,
    };
  });
}

async function settleAllOrThrow(promises) {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return settled.map((result) => result.value);
}

async function readGitBatchAsync(input, baseArgs, batch, execution) {
  const [statusResult, numstatResult] = await settleAllOrThrow([
    execution.run([...baseArgs, "--name-status", ...batch], { encoding: null }),
    execution.run([...baseArgs, "--numstat", ...batch], { encoding: null }),
  ]);
  if (gitOutputBufferExceeded(statusResult) || gitOutputBufferExceeded(numstatResult)) return null;
  if (statusResult.error || statusResult.status !== 0 || numstatResult.error || numstatResult.status !== 0) {
    throw new Error("FAIL-MALFORMED-GIT-RECORD: Git revision-batch change records were unavailable");
  }
  const statusFrames = parseBatchedShowFrames(statusResult.stdout, batch, "git show name-status");
  const numstatFrames = parseBatchedShowFrames(numstatResult.stdout, batch, "git show numstat");
  return batch.map((revision, index) => {
    const status = statusFrames[index];
    const numstat = numstatFrames[index];
    if (
      status.revision !== numstat.revision
      || status.timestamp !== numstat.timestamp
      || status.author !== numstat.author
      || status.parent_count !== numstat.parent_count
    ) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: Git revision-batch frames disagreed about commit metadata");
    }
    const files = status.parent_count > 1
      ? []
      : joinGitChangeRows(
        parseNameStatus(stripGitShowHeaderSeparator(status.changes)),
        parseNumstat(stripGitShowHeaderSeparator(numstat.changes)),
      );
    return {
      revision,
      timestamp: status.timestamp,
      author: status.author,
      is_merge: status.parent_count > 1,
      files,
    };
  });
}

function readBatchedGitRows(input, revisions) {
  const format = `%x00${GIT_SHOW_FRAME_MARKER}%x00%H%x00%aI%x00%aE%x00%P%x00`;
  const baseArgs = ["show", "--no-walk=unsorted", "--root", "--no-ext-diff", "-r", "-z", "--find-renames=50%", `--format=${format}`];
  const rows = new Map();
  const readWithBoundedFallback = (batch) => {
    const batchRows = readGitBatch(input, baseArgs, batch);
    if (batchRows === null) {
      if (batch.length === 1) {
        throw new Error("FAIL-MALFORMED-GIT-RECORD: one Git revision exceeds the configured process output buffer");
      }
      const middle = Math.ceil(batch.length / 2);
      readWithBoundedFallback(batch.slice(0, middle));
      readWithBoundedFallback(batch.slice(middle));
      return;
    }
    for (const row of batchRows) {
      if (rows.has(row.revision)) {
        throw new Error(`FAIL-MALFORMED-GIT-RECORD: Git revision-batch duplicated ${row.revision}`);
      }
      rows.set(row.revision, row);
    }
  };
  for (let start = 0; start < revisions.length; start += GIT_REVISION_BATCH_SIZE) {
    readWithBoundedFallback(revisions.slice(start, start + GIT_REVISION_BATCH_SIZE));
  }
  if (rows.size !== revisions.length) {
    throw new Error("FAIL-MALFORMED-GIT-RECORD: Git revision-batch did not cover every requested revision");
  }
  return revisions.map((revision) => {
    const row = rows.get(revision);
    if (!row) throw new Error(`FAIL-MALFORMED-GIT-RECORD: Git revision-batch omitted ${revision}`);
    return row;
  });
}

async function readBatchedGitRowsAsync(input, revisions, execution) {
  const format = `%x00${GIT_SHOW_FRAME_MARKER}%x00%H%x00%aI%x00%aE%x00%P%x00`;
  const baseArgs = ["show", "--no-walk=unsorted", "--root", "--no-ext-diff", "-r", "-z", "--find-renames=50%", `--format=${format}`];
  const rows = new Map();
  const readWithBoundedFallback = async (batch) => {
    checkGitCancellation(execution.signal);
    const batchRows = await readGitBatchAsync(input, baseArgs, batch, execution);
    if (batchRows === null) {
      if (batch.length === 1) {
        throw new Error("FAIL-MALFORMED-GIT-RECORD: one Git revision exceeds the configured process output buffer");
      }
      const middle = Math.ceil(batch.length / 2);
      await settleAllOrThrow([
        readWithBoundedFallback(batch.slice(0, middle)),
        readWithBoundedFallback(batch.slice(middle)),
      ]);
      return;
    }
    for (const row of batchRows) {
      if (rows.has(row.revision)) {
        throw new Error(`FAIL-MALFORMED-GIT-RECORD: Git revision-batch duplicated ${row.revision}`);
      }
      rows.set(row.revision, row);
    }
  };
  const batches = [];
  for (let start = 0; start < revisions.length; start += GIT_REVISION_BATCH_SIZE) {
    batches.push(revisions.slice(start, start + GIT_REVISION_BATCH_SIZE));
  }
  await settleAllOrThrow(batches.map(readWithBoundedFallback));
  if (rows.size !== revisions.length) {
    throw new Error("FAIL-MALFORMED-GIT-RECORD: Git revision-batch did not cover every requested revision");
  }
  return revisions.map((revision) => {
    const row = rows.get(revision);
    if (!row) throw new Error(`FAIL-MALFORMED-GIT-RECORD: Git revision-batch omitted ${revision}`);
    return row;
  });
}

function resolveLocalGitRowRequest(input) {
  const boundary = input.history_window;
  const autoRootInclusive = boundary?.auto_root_inclusive === true;
  const resolvedWindow = {
    kind: boundary?.kind ?? "revision-range",
    start: null,
    end: null,
  };
  if (boundary && Object.hasOwn(boundary, "auto_root_inclusive") && typeof boundary.auto_root_inclusive !== "boolean") {
    return { available: false, reason: "auto-root inclusive flag must be boolean", window: resolvedWindow };
  }
  if (autoRootInclusive && resolvedWindow.kind !== "revision-range") {
    return { available: false, reason: "auto-root inclusive history requires a revision-range boundary", window: resolvedWindow };
  }
  const binding = resolveLocalRevisionBinding(input);
  if (!binding.available) return { ...binding, window: resolvedWindow };
  resolvedWindow.end = binding.resolvedRevision;
  if (boundary?.end) {
    const resolvedEnd = resolveLocalHistoryRevision(input, boundary.end, "history window end");
    if (!resolvedEnd.available) return { ...resolvedEnd, window: resolvedWindow };
    if (resolvedEnd.resolvedRevision.toLowerCase() !== binding.resolvedRevision.toLowerCase()) {
      return {
        available: false,
        reason: "history window end does not match declared repository_revision",
        window: { ...resolvedWindow, end: resolvedEnd.resolvedRevision },
      };
    }
  }
  let revisionRange = binding.resolvedRevision;
  if (boundary?.start) {
    const resolvedStart = resolveLocalHistoryRevision(input, boundary.start, "history window start");
    if (!resolvedStart.available) return { ...resolvedStart, window: resolvedWindow };
    resolvedWindow.start = resolvedStart.resolvedRevision;
    const ancestry = runLocalGit(input, ["merge-base", "--is-ancestor", resolvedStart.resolvedRevision, binding.resolvedRevision]);
    if (ancestry.error || ancestry.status !== 0) {
      return {
        available: false,
        reason: ancestry.status === 1
          ? "history window start is not an ancestor of declared repository_revision"
          : `history window ancestry cannot be verified: ${commandFailure(ancestry)}`,
        window: resolvedWindow,
      };
    }
    revisionRange = `${resolvedStart.resolvedRevision}..${binding.resolvedRevision}`;
    if (autoRootInclusive) {
      const shallow = runLocalGit(input, ["rev-parse", "--is-shallow-repository"]);
      if (shallow.error || shallow.status !== 0 || shallow.stdout.trim() !== "false") {
        return {
          available: false,
          reason: "auto-root inclusive history is unavailable for a shallow or unverifiable repository; declare an explicit bounded history window",
          window: resolvedWindow,
        };
      }
      const roots = runLocalGit(input, ["rev-list", "--max-parents=0", "--topo-order", "--reverse", binding.resolvedRevision]);
      if (roots.error || roots.status !== 0) {
        return {
          available: false,
          reason: `auto-root inclusive history cannot resolve repository roots: ${commandFailure(roots)}`,
          window: resolvedWindow,
        };
      }
      const rootIds = [...new Set(roots.stdout.replace(/\r\n?/g, "\n").split("\n").filter(Boolean).map((root) => root.toLowerCase()))];
      if (
        rootIds.length !== 1 ||
        !FULL_GIT_REVISION.test(rootIds[0]) ||
        rootIds[0] !== resolvedStart.resolvedRevision.toLowerCase()
      ) {
        return {
          available: false,
          reason: "auto-root inclusive history requires the declared start to be the sole observable repository root",
          window: resolvedWindow,
        };
      }
      // Git A..B excludes A. This private CLI-only mode has already proven A
      // is the single root, so query B instead to retain the complete locally
      // observable history while the persisted window remains { kind,start,end }.
      revisionRange = binding.resolvedRevision;
    }
  } else if (autoRootInclusive) {
    return {
      available: false,
      reason: "auto-root inclusive history requires a nonblank declared start",
      window: resolvedWindow,
    };
  }
  return { available: true, binding, window: resolvedWindow, revisionRange };
}

async function resolveLocalGitRowRequestAsync(input, execution) {
  const boundary = input.history_window;
  const autoRootInclusive = boundary?.auto_root_inclusive === true;
  const resolvedWindow = {
    kind: boundary?.kind ?? "revision-range",
    start: null,
    end: null,
  };
  if (boundary && Object.hasOwn(boundary, "auto_root_inclusive") && typeof boundary.auto_root_inclusive !== "boolean") {
    return { available: false, reason: "auto-root inclusive flag must be boolean", window: resolvedWindow };
  }
  if (autoRootInclusive && resolvedWindow.kind !== "revision-range") {
    return { available: false, reason: "auto-root inclusive history requires a revision-range boundary", window: resolvedWindow };
  }
  const binding = await resolveLocalRevisionBindingAsync(input, execution);
  if (!binding.available) return { ...binding, window: resolvedWindow };
  resolvedWindow.end = binding.resolvedRevision;
  if (boundary?.end) {
    const resolvedEnd = await resolveLocalHistoryRevisionAsync(input, boundary.end, "history window end", execution);
    if (!resolvedEnd.available) return { ...resolvedEnd, window: resolvedWindow };
    if (resolvedEnd.resolvedRevision.toLowerCase() !== binding.resolvedRevision.toLowerCase()) {
      return {
        available: false,
        reason: "history window end does not match declared repository_revision",
        window: { ...resolvedWindow, end: resolvedEnd.resolvedRevision },
      };
    }
  }
  let revisionRange = binding.resolvedRevision;
  if (boundary?.start) {
    const resolvedStart = await resolveLocalHistoryRevisionAsync(input, boundary.start, "history window start", execution);
    if (!resolvedStart.available) return { ...resolvedStart, window: resolvedWindow };
    resolvedWindow.start = resolvedStart.resolvedRevision;
    const ancestry = await execution.run(["merge-base", "--is-ancestor", resolvedStart.resolvedRevision, binding.resolvedRevision]);
    if (ancestry.error || ancestry.status !== 0) {
      return {
        available: false,
        reason: ancestry.status === 1
          ? "history window start is not an ancestor of declared repository_revision"
          : `history window ancestry cannot be verified: ${commandFailure(ancestry)}`,
        window: resolvedWindow,
      };
    }
    revisionRange = `${resolvedStart.resolvedRevision}..${binding.resolvedRevision}`;
    if (autoRootInclusive) {
      const shallow = await execution.run(["rev-parse", "--is-shallow-repository"]);
      if (shallow.error || shallow.status !== 0 || shallow.stdout.trim() !== "false") {
        return {
          available: false,
          reason: "auto-root inclusive history is unavailable for a shallow or unverifiable repository; declare an explicit bounded history window",
          window: resolvedWindow,
        };
      }
      const roots = await execution.run(["rev-list", "--max-parents=0", "--topo-order", "--reverse", binding.resolvedRevision]);
      if (roots.error || roots.status !== 0) {
        return {
          available: false,
          reason: `auto-root inclusive history cannot resolve repository roots: ${commandFailure(roots)}`,
          window: resolvedWindow,
        };
      }
      const rootIds = [...new Set(roots.stdout.replace(/\r\n?/g, "\n").split("\n").filter(Boolean).map((root) => root.toLowerCase()))];
      if (
        rootIds.length !== 1
        || !FULL_GIT_REVISION.test(rootIds[0])
        || rootIds[0] !== resolvedStart.resolvedRevision.toLowerCase()
      ) {
        return {
          available: false,
          reason: "auto-root inclusive history requires the declared start to be the sole observable repository root",
          window: resolvedWindow,
        };
      }
      revisionRange = binding.resolvedRevision;
    }
  } else if (autoRootInclusive) {
    return {
      available: false,
      reason: "auto-root inclusive history requires a nonblank declared start",
      window: resolvedWindow,
    };
  }
  return { available: true, binding, window: resolvedWindow, revisionRange };
}

function readLocalGitRevisionRange(input, request, revisionRange = request.revisionRange) {
  const args = ["rev-list", "--reverse", "--topo-order", revisionRange];
  const result = runLocalGit(input, args);
  if (result.error || result.status !== 0) {
    return {
      available: false,
      reason: `Git history unavailable: ${result.error?.code ?? String(result.stderr || `exit ${result.status}`).trim()}`,
      window: request.window,
    };
  }
  try {
    const revisions = result.stdout.replace(/\r\n?/g, "\n").split("\n").filter(Boolean);
    if (revisions.some((revision) => !FULL_GIT_REVISION.test(revision))) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: git rev-list returned an invalid revision");
    }
    const commits = readBatchedGitRows(input, revisions);
    return {
      available: true,
      commits: validateCommitRows(commits),
      command: "git rev-list --reverse --topo-order <revision-range>; git show --no-walk=unsorted --root --no-ext-diff -r -z --find-renames=50% --format=<nul-framed-metadata> --name-status|--numstat <revision-batch:256>",
      window: request.window,
    };
  } catch (error) {
    return { available: false, reason: error.message, window: request.window };
  }
}

function readLocalGitRows(input) {
  const request = resolveLocalGitRowRequest(input);
  if (!request.available) return request;
  return readLocalGitRevisionRange(input, request);
}

async function readLocalGitRevisionRangeAsync(input, request, execution, revisionRange = request.revisionRange) {
  const args = ["rev-list", "--reverse", "--topo-order", revisionRange];
  const result = await execution.run(args);
  if (result.error || result.status !== 0) {
    return {
      available: false,
      reason: `Git history unavailable: ${result.error?.code ?? String(result.stderr || `exit ${result.status}`).trim()}`,
      window: request.window,
    };
  }
  try {
    const revisions = result.stdout.replace(/\r\n?/g, "\n").split("\n").filter(Boolean);
    if (revisions.some((revision) => !FULL_GIT_REVISION.test(revision))) {
      throw new Error("FAIL-MALFORMED-GIT-RECORD: git rev-list returned an invalid revision");
    }
    const commits = await readBatchedGitRowsAsync(input, revisions, execution);
    return {
      available: true,
      commits: validateCommitRows(commits),
      command: "git rev-list --reverse --topo-order <revision-range>; git show --no-walk=unsorted --root --no-ext-diff -r -z --find-renames=50% --format=<nul-framed-metadata> --name-status|--numstat <revision-batch:256>",
      window: request.window,
    };
  } catch (error) {
    if (execution.signal?.aborted || error?.code === "FAIL-GIT-PROCESS-CLEANUP") throw error;
    return { available: false, reason: error.message, window: request.window };
  }
}

async function readLocalGitRowsAsync(input, execution) {
  const request = await resolveLocalGitRowRequestAsync(input, execution);
  if (!request.available) return request;
  return readLocalGitRevisionRangeAsync(input, request, execution);
}

function unavailableGitEvidence(input, reason, window = {
  kind: input.history_window?.kind ?? "revision-range",
  start: null,
  end: null,
}) {
  const collector = collectorRecord({ id: "git-history", status: "unavailable", analyzerIdentity: GIT_ANALYZER_ID, analyzerVersion: GIT_ANALYZER_VERSION, reason });
  const common = {
    family: "repository_behavior",
    status: "unavailable",
    reason,
    sourceKind: "git-history",
    collectorId: "git-history",
    artifactRefs: ["git:unavailable"],
    window,
    analyzerIdentity: GIT_ANALYZER_ID,
    analyzerVersion: GIT_ANALYZER_VERSION,
    includedInHuman: false,
  };
  const definitions = [
    ["git.change_frequency", "sei.git.change_frequency@1", "revisions"],
    ["git.churn", "sei.git.churn@1", "lines-changed"],
    ["git.observed_text_churn", "sei.git.observed_text_churn@1", "lines-changed"],
    ["git.age_days", "sei.git.age_days@1", "days"],
    ["git.ownership_concentration", "sei.git.ownership_concentration@1", "ratio"],
    ["git.observed_touch_ownership_concentration", "sei.git.observed_touch_ownership_concentration@1", "ratio"],
    ["git.co_change_pair_count", "sei.git.co_change_pair_count@1", "file-pairs"],
    ["git.observed_co_change_pair_count", "sei.git.observed_co_change_pair_count@1", "file-pairs"],
  ];
  const metrics = definitions.map(([metricId, definitionId, unit]) => metricRecord(input, { ...common, metricId, definitionId, unit }));
  metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  return { collectors: [collector], capabilities: [structuredClone(collector)], metrics, files: [], relationships: [], aggregates: { commit_count: null, churn: null, repository_age_days: null, observed_history_window_days: null, merge_commit_count: null, ownership_concentration: null, co_change_pair_count: null, observed_non_merge_commit_count: null, observed_attributed_commit_count: null, observed_commit_coverage: null, unattributed_merge_commit_count: null, binary_file_change_exclusion_count: null, generated_vendor_file_change_exclusion_count: null, unknown_classification_file_change_exclusion_count: null, observed_text_churn: null, observed_text_change_count: null, observed_touch_count: null, observed_touch_ownership_concentration: null, observed_co_change_pair_count: null }, temporal_coupling: null };
}

function collectGitEvidence(input = {}) {
  const observer = typeof input?.git_observer === "function" ? input.git_observer : null;
  if (observer === null) return collectGitEvidenceInternal(input);
  const telemetry = [];
  const collectionInput = {
    ...input,
    [INTERNAL_GIT_OBSERVER]: (event) => telemetry.push(event),
  };
  try {
    return collectGitEvidenceInternal(collectionInput);
  } finally {
    for (const event of telemetry) {
      try {
        observer(event);
      } catch {
        // An observer is telemetry-only and cannot change evidence semantics.
      }
    }
  }
}

async function collectGitEvidenceAsync(input = {}, options = {}) {
  repositoryRevision(input);
  const normalizedOptions = normalizeGitAsyncOptions(options);
  if (suppliedHistoryRows(input) !== null) {
    checkGitCancellation(normalizedOptions.signal);
    return collectGitEvidence(input);
  }
  if (typeof input.repo_root !== "string" || input.repo_root.length === 0) {
    return collectGitEvidenceInternal(input);
  }
  const observer = typeof input?.git_observer === "function" ? input.git_observer : null;
  const telemetry = [];
  const collectionInput = observer === null ? input : {
    ...input,
    [INTERNAL_GIT_OBSERVER]: (event) => telemetry.push(event),
  };
  const execution = createGitExecution(collectionInput, normalizedOptions);
  try {
    const result = await readLocalGitRowsAsync(collectionInput, execution);
    checkGitCancellation(normalizedOptions.signal);
    return collectGitEvidenceInternal(collectionInput, result);
  } finally {
    if (observer !== null) {
      for (const event of telemetry) {
        try { observer(event); } catch {
          // An observer is telemetry-only and cannot change evidence semantics.
        }
      }
    }
  }
}

function compatibleHistoryStagesConservative(input, request, repositoryId, stages) {
  if (typeof repositoryId !== "string" || repositoryId.length === 0 || !Array.isArray(stages)) {
    throw new Error("FAIL-INCREMENTAL-STATE: compact history collector requires repository_id and prior_stages");
  }
  const documents = [];
  let corruptStageCount = 0;
  for (const stage of stages) {
    try {
      documents.push(incrementalStatePrivate.readStage(stage, "history"));
    } catch {
      corruptStageCount += 1;
    }
  }
  const objectFormat = request.binding.resolvedRevision.length === 40 ? "sha1" : "sha256";
  const configurationHash = deriveCollectorConfigurationHash(input);
  const temporalPolicyHash = temporalPolicyConfiguration(input).policy_hash;
  return {
    corruptStageCount,
    documents: documents.filter((document) => {
      const binding = document.binding;
      return binding.repository_id === repositoryId
        && binding.object_format === objectFormat
        && binding.history_kind === request.window.kind
        && binding.history_start === request.window.start
        && binding.collector_version === COLLECTOR_VERSION
        && binding.analyzer_identity === GIT_ANALYZER_ID
        && binding.analyzer_version === GIT_ANALYZER_VERSION
        && binding.configuration_hash === configurationHash
        && binding.temporal_policy_hash === temporalPolicyHash;
    }).sort((left, right) => stableCompare(left.artifact_sha256, right.artifact_sha256)),
  };
}

async function compactHistoryRowsAsync(input, repositoryId, stages, execution) {
  const request = await resolveLocalGitRowRequestAsync(input, execution);
  if (!request.available) {
    return { result: request, telemetry: { mode: "cold", reused_commit_count: 0, appended_commit_count: 0, reason: request.reason } };
  }
  const compatible = compatibleHistoryStagesConservative(input, request, repositoryId, stages);
  if (compatible.corruptStageCount > 0) {
    const result = await readLocalGitRevisionRangeAsync(input, request, execution);
    return {
      result,
      telemetry: {
        mode: "cold",
        reused_commit_count: 0,
        appended_commit_count: result.available ? result.commits.length : 0,
        reason: "corrupt compact history stage rejected reuse",
      },
    };
  }
  const exact = compatible.documents.find((document) => document.binding.history_end === request.window.end);
  if (exact) {
    return {
      result: {
        available: true,
        commits: validateCommitRows(exact.commits),
        command: "git rev-list --reverse --topo-order <revision-range>; git show --no-walk=unsorted --root --no-ext-diff -r -z --find-renames=50% --format=<nul-framed-metadata> --name-status|--numstat <revision-batch:256>",
        window: request.window,
      },
      telemetry: { mode: "hit", reused_commit_count: exact.commits.length, appended_commit_count: 0, reason: null },
    };
  }
  const shallow = await execution.run(["rev-parse", "--is-shallow-repository"]);
  if (shallow.error || shallow.status !== 0 || shallow.stdout.trim() !== "false") {
    const result = await readLocalGitRevisionRangeAsync(input, request, execution);
    return { result, telemetry: { mode: "cold", reused_commit_count: 0, appended_commit_count: result.available ? result.commits.length : 0, reason: "shallow or unverifiable history rejected append reuse" } };
  }
  const candidates = [];
  for (const document of compatible.documents) {
    checkGitCancellation(execution.signal);
    const priorEnd = document.binding.history_end;
    const ancestry = await execution.run(["merge-base", "--is-ancestor", priorEnd, request.window.end]);
    if (ancestry.error || ancestry.status !== 0) continue;
    const count = await execution.run(["rev-list", "--count", `${priorEnd}..${request.window.end}`]);
    if (count.error || count.status !== 0 || !/^\d+$/.test(count.stdout.trim())) continue;
    const distance = Number(count.stdout.trim());
    if (!Number.isSafeInteger(distance) || distance <= 0) continue;
    candidates.push({ document, distance });
  }
  candidates.sort((left, right) => left.distance - right.distance
    || stableCompare(left.document.binding.history_end, right.document.binding.history_end)
    || stableCompare(left.document.artifact_sha256, right.document.artifact_sha256));
  const selected = candidates[0];
  if (!selected) {
    const result = await readLocalGitRevisionRangeAsync(input, request, execution);
    return { result, telemetry: { mode: "cold", reused_commit_count: 0, appended_commit_count: result.available ? result.commits.length : 0, reason: "no compatible strict-ancestor history stage" } };
  }
  const appended = await readLocalGitRevisionRangeAsync(
    input,
    request,
    execution,
    `${selected.document.binding.history_end}..${request.window.end}`,
  );
  if (!appended.available) {
    const result = await readLocalGitRevisionRangeAsync(input, request, execution);
    return { result, telemetry: { mode: "cold", reused_commit_count: 0, appended_commit_count: result.available ? result.commits.length : 0, reason: "history append ingestion failed closed" } };
  }
  let commits;
  try {
    commits = validateCommitRows([...selected.document.commits, ...appended.commits]);
  } catch {
    const result = await readLocalGitRevisionRangeAsync(input, request, execution);
    return { result, telemetry: { mode: "cold", reused_commit_count: 0, appended_commit_count: result.available ? result.commits.length : 0, reason: "combined history state failed closed validation" } };
  }
  return {
    result: { ...appended, commits, window: request.window },
    telemetry: {
      mode: "append",
      reused_commit_count: selected.document.commits.length,
      appended_commit_count: appended.commits.length,
      reason: null,
    },
  };
}

function historyStageFromRows(input, repositoryId, result) {
  if (!result.available) return null;
  return incrementalStatePrivate.createHistoryStage({
    binding: {
      repository_id: repositoryId,
      object_format: result.window.end.length === 40 ? "sha1" : "sha256",
      history_kind: result.window.kind,
      history_start: result.window.start,
      history_end: result.window.end,
      collector_version: COLLECTOR_VERSION,
      analyzer_identity: GIT_ANALYZER_ID,
      analyzer_version: GIT_ANALYZER_VERSION,
      configuration_hash: deriveCollectorConfigurationHash(input),
      temporal_policy_hash: temporalPolicyConfiguration(input).policy_hash,
    },
    commits: result.commits,
  });
}

async function collectGitEvidenceIncremental(input = {}, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["prior_stages", "repository_id", "saturation", "signal"].includes(key))) {
    throw new Error("FAIL-INCREMENTAL-STATE: compact history options are not closed");
  }
  const asyncOptions = normalizeGitAsyncOptions({ signal: options.signal, saturation: options.saturation });
  if (suppliedHistoryRows(input) !== null) {
    return Object.freeze({
      evidence: await collectGitEvidenceAsync(input, { signal: asyncOptions.signal, saturation: asyncOptions.saturation }),
      stage: null,
      telemetry: Object.freeze({ mode: "not-applicable", reused_commit_count: 0, appended_commit_count: 0, reason: "supplied history is not cached" }),
    });
  }
  const observer = typeof input?.git_observer === "function" ? input.git_observer : null;
  const commandTelemetry = [];
  const executionInput = observer === null ? input : {
    ...input,
    [INTERNAL_GIT_OBSERVER]: (event) => commandTelemetry.push(event),
  };
  const execution = createGitExecution(executionInput, asyncOptions);
  try {
    const selected = await compactHistoryRowsAsync(executionInput, options.repository_id, options.prior_stages, execution);
    checkGitCancellation(asyncOptions.signal);
    const evidence = collectGitEvidenceInternal(input, selected.result);
    const stage = historyStageFromRows(input, options.repository_id, selected.result);
    return Object.freeze({ evidence, stage, telemetry: Object.freeze(selected.telemetry) });
  } finally {
    if (observer !== null) {
      for (const event of commandTelemetry) {
        try { observer(event); } catch {
          // An observer is telemetry-only and cannot change evidence semantics.
        }
      }
    }
  }
}

function collectGitEvidenceInternal(input = {}, localResult = null) {
  repositoryRevision(input);
  const configuration = effectiveConfiguration(input);
  const supplied = suppliedHistoryRows(input);
  let commits;
  let command = null;
  let effectiveWindow = historyWindow(input);
  let sourceKind = "supplied-git-history";
  if (supplied !== null) {
    commits = validateCommitRows(supplied);
  } else {
    if (typeof input.repo_root !== "string" || input.repo_root.length === 0) {
      return unavailableGitEvidence(input, "Git history unavailable: repo_root was not supplied");
    }
    const result = localResult ?? readLocalGitRows(input);
    if (!result.available) return unavailableGitEvidence(input, result.reason, result.window);
    commits = result.commits;
    command = result.command;
    effectiveWindow = result.window;
    sourceKind = "local-git";
  }
  if (commits.length === 0) {
    const reason = "history window contains no commits";
    const collector = collectorRecord({ id: "git-history", status: "available", analyzerIdentity: GIT_ANALYZER_ID, analyzerVersion: GIT_ANALYZER_VERSION });
    const common = {
      family: "repository_behavior", status: "not-applicable", reason, completeness: 1, confidence: 1,
      sourceKind, collectorId: "git-history", command, artifactRefs: [supplied === null ? "git-log" : "supplied:history_rows"],
      window: effectiveWindow, analyzerIdentity: GIT_ANALYZER_ID, analyzerVersion: GIT_ANALYZER_VERSION,
      includedInHuman: false,
    };
    const metrics = [
      ["git.change_frequency", "sei.git.change_frequency@1", "revisions"],
      ["git.churn", "sei.git.churn@1", "lines-changed"],
      ["git.observed_text_churn", "sei.git.observed_text_churn@1", "lines-changed"],
      ["git.age_days", "sei.git.age_days@1", "days"],
      ["git.ownership_concentration", "sei.git.ownership_concentration@1", "ratio"],
      ["git.observed_touch_ownership_concentration", "sei.git.observed_touch_ownership_concentration@1", "ratio"],
      ["git.co_change_pair_count", "sei.git.co_change_pair_count@1", "file-pairs"],
      ["git.observed_co_change_pair_count", "sei.git.observed_co_change_pair_count@1", "file-pairs"],
    ].map(([metricId, definitionId, unit]) => metricRecord(input, { ...common, metricId, definitionId, unit }));
    metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
    const temporalCoupling = deriveTemporalCoupling({ commits: [], policy: input.temporal_coupling_policy });
    return { collectors: [collector], capabilities: [structuredClone(collector)], metrics, files: [], relationships: [], aggregates: { commit_count: 0, churn: 0, repository_age_days: null, observed_history_window_days: null, merge_commit_count: 0, ownership_concentration: null, co_change_pair_count: 0, observed_non_merge_commit_count: 0, observed_attributed_commit_count: 0, observed_commit_coverage: 1, unattributed_merge_commit_count: 0, binary_file_change_exclusion_count: 0, generated_vendor_file_change_exclusion_count: 0, unknown_classification_file_change_exclusion_count: 0, observed_text_churn: 0, observed_text_change_count: 0, observed_touch_count: 0, observed_touch_ownership_concentration: null, observed_co_change_pair_count: 0 }, temporal_coupling: temporalCoupling };
  }

  const patternsPresent = configuration.generated_path_patterns_supplied;
  const patterns = configuration.generated_path_patterns;
  // Local history intentionally omits merge tree rows to avoid double-counting
  // branch commits. With no pinned merge-resolution delta, a zero-row merge is
  // incomplete behavioral/churn evidence rather than a complete zero.
  const mergeCommitCount = commits.filter((commit) => commit.is_merge).length;
  const unattributedMergeCommitCount = commits.filter((commit) => commit.is_merge && commit.files.length === 0).length;
  const hasUnattributedMergeChurn = unattributedMergeCommitCount > 0;
  const observedNonMergeCommitCount = commits.length - mergeCommitCount;
  const observedAttributedCommitCount = commits.length - unattributedMergeCommitCount;
  const observedCommitCoverage = observedAttributedCommitCount / commits.length;
  const fileStats = new Map();
  const authorTouches = new Map();
  const observedAuthorTouches = new Map();
  let binaryFileChangeExclusionCount = 0;
  let generatedVendorFileChangeExclusionCount = 0;
  let unknownClassificationFileChangeExclusionCount = 0;
  const temporalCommits = [];
  for (const commit of commits) {
    const temporalFiles = [];
    for (const file of commit.files) {
      const classification = classifyGenerated({ path: file.path }, patternsPresent, patterns);
      const stats = fileStats.get(file.path) ?? {
        path: file.path,
        change_frequency: 0,
        observed_change_frequency: 0,
        added: 0,
        deleted: 0,
        observed_text_added: 0,
        observed_text_deleted: 0,
        observed_text_change_count: 0,
        observed_touch_count: 0,
        binary_change: false,
        binary_change_count: 0,
        authors: new Map(),
        observed_authors: new Map(),
        revisions: new Set(),
        first_timestamp: commit.timestamp,
        last_timestamp: commit.timestamp,
        change_kinds: new Set(),
        rename_sources: new Set(),
        generated_code: classification.generated,
        generated_classification_known: classification.known,
        generated_classification_reason: classification.reason,
        included_in_human_maintainability: classification.known && !classification.generated,
        included_in_behavioral_aggregates: classification.known && !classification.generated,
      };
      stats.change_frequency += 1;
      if (!commit.is_merge || commit.files.length > 0) stats.observed_change_frequency += 1;
      if (file.binary_change) {
        stats.binary_change = true;
        stats.binary_change_count += 1;
      } else {
        stats.added += file.added;
        stats.deleted += file.deleted;
      }
      stats.authors.set(commit.author, (stats.authors.get(commit.author) ?? 0) + 1);
      stats.revisions.add(commit.revision);
      stats.first_timestamp = stableCompare(stats.first_timestamp, commit.timestamp) < 0 ? stats.first_timestamp : commit.timestamp;
      stats.last_timestamp = stableCompare(stats.last_timestamp, commit.timestamp) > 0 ? stats.last_timestamp : commit.timestamp;
      stats.change_kinds.add(file.change_kind);
      if (file.previous_path !== undefined) stats.rename_sources.add(file.previous_path);
      fileStats.set(file.path, stats);
      if (stats.included_in_behavioral_aggregates) {
        authorTouches.set(commit.author, (authorTouches.get(commit.author) ?? 0) + 1);
      }
      const eligibleForObservedTouch = (!commit.is_merge || commit.files.length > 0)
        && classification.known
        && !classification.generated;
      const eligibleForObservedText = eligibleForObservedTouch && !file.binary_change;
      if (eligibleForObservedTouch && file.binary_change) binaryFileChangeExclusionCount += 1;
      if ((!commit.is_merge || commit.files.length > 0) && classification.known && classification.generated) generatedVendorFileChangeExclusionCount += 1;
      if ((!commit.is_merge || commit.files.length > 0) && !classification.known) unknownClassificationFileChangeExclusionCount += 1;
      if (eligibleForObservedText) {
        stats.observed_text_added += file.added;
        stats.observed_text_deleted += file.deleted;
        stats.observed_text_change_count += 1;
      }
      if (eligibleForObservedTouch) {
        stats.observed_touch_count += 1;
        stats.observed_authors.set(commit.author, (stats.observed_authors.get(commit.author) ?? 0) + 1);
        observedAuthorTouches.set(commit.author, (observedAuthorTouches.get(commit.author) ?? 0) + 1);
      }
      temporalFiles.push({
        path: file.path,
        eligible_for_temporal_coupling: eligibleForObservedTouch,
      });
    }
    temporalCommits.push({ revision: commit.revision, timestamp: commit.timestamp, author: commit.author, files: temporalFiles });
  }
  const timestamps = commits.map((commit) => Date.parse(commit.timestamp));
  const historyEndTimestamp = Math.max(...timestamps);
  const files = [...fileStats.values()].map((stats) => ({
    path: stats.path,
    change_frequency: stats.observed_change_frequency,
    added_lines: stats.binary_change || hasUnattributedMergeChurn ? null : stats.added,
    deleted_lines: stats.binary_change || hasUnattributedMergeChurn ? null : stats.deleted,
    churn: stats.binary_change || hasUnattributedMergeChurn ? null : stats.added + stats.deleted,
    binary_change: stats.binary_change,
    binary_change_count: stats.binary_change_count,
    observed_text_added_lines: stats.observed_text_added,
    observed_text_deleted_lines: stats.observed_text_deleted,
    observed_text_churn: stats.observed_text_added + stats.observed_text_deleted,
    observed_text_change_count: stats.observed_text_change_count,
    observed_touch_count: stats.observed_touch_count,
    observed_touch_ownership_concentration: stats.observed_touch_count === 0
      ? null
      : Math.max(...stats.observed_authors.values()) / stats.observed_touch_count,
    age_days: Math.floor((historyEndTimestamp - Date.parse(stats.first_timestamp)) / 86_400_000),
    observed_history_window_days: Math.floor((historyEndTimestamp - Date.parse(stats.first_timestamp)) / 86_400_000),
    first_observed_timestamp: stats.first_timestamp,
    last_observed_timestamp: stats.last_timestamp,
    ownership_concentration: hasUnattributedMergeChurn ? null : Math.max(...stats.authors.values()) / stats.change_frequency,
    authors: [...stats.authors.entries()].sort(([left], [right]) => stableCompare(left, right)).map(([author, touches]) => ({ author, touches })),
    observed_revisions: [...stats.revisions].sort(stableCompare),
    change_kinds: [...stats.change_kinds].sort(stableCompare),
    rename_sources: [...stats.rename_sources].sort(stableCompare),
    generated_code: stats.generated_code,
    generated_classification_known: stats.generated_classification_known,
    generated_classification_reason: stats.generated_classification_reason,
    included_in_human_maintainability: stats.included_in_human_maintainability,
    included_in_behavioral_aggregates: stats.included_in_behavioral_aggregates,
  })).sort((left, right) => stableCompare(left.path, right.path));
  const temporalCoupling = deriveTemporalCoupling({ commits: temporalCommits, policy: input.temporal_coupling_policy });
  const relationships = temporalCoupling.relationships;
  const aggregateFiles = files.filter((file) => file.included_in_behavioral_aggregates);
  const hasUnknownGeneratedClassification = files.some((file) => !file.generated_classification_known);
  const aggregateHasBinaryChange = aggregateFiles.some((file) => file.binary_change);
  const behavioralDegradationReasons = [
    hasUnattributedMergeChurn ? MERGE_CHURN_UNATTRIBUTED_REASON : null,
    hasUnknownGeneratedClassification ? GENERATED_CLASSIFICATION_UNKNOWN_REASON : null,
  ].filter(Boolean);
  const behavioralAggregatesUnverifiable = behavioralDegradationReasons.length > 0;
  const aggregateChurnUnverifiable = aggregateHasBinaryChange || behavioralAggregatesUnverifiable;
  const totalTouches = [...authorTouches.values()].reduce((sum, count) => sum + count, 0);
  const observedTextChangeCount = files.reduce((sum, file) => sum + file.observed_text_change_count, 0);
  const observedTouchCount = [...observedAuthorTouches.values()].reduce((sum, count) => sum + count, 0);
  const aggregates = {
    commit_count: commits.length,
    churn: aggregateChurnUnverifiable ? null : aggregateFiles.reduce((sum, file) => sum + file.churn, 0),
    repository_age_days: Math.floor((Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000),
    observed_history_window_days: Math.floor((Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000),
    merge_commit_count: commits.filter((commit) => commit.is_merge).length,
    ownership_concentration: behavioralAggregatesUnverifiable || totalTouches === 0 ? null : Math.max(...authorTouches.values()) / totalTouches,
    co_change_pair_count: behavioralAggregatesUnverifiable ? null : relationships.length,
    observed_non_merge_commit_count: observedNonMergeCommitCount,
    observed_attributed_commit_count: observedAttributedCommitCount,
    observed_commit_coverage: observedCommitCoverage,
    unattributed_merge_commit_count: unattributedMergeCommitCount,
    binary_file_change_exclusion_count: binaryFileChangeExclusionCount,
    generated_vendor_file_change_exclusion_count: generatedVendorFileChangeExclusionCount,
    unknown_classification_file_change_exclusion_count: unknownClassificationFileChangeExclusionCount,
    observed_text_churn: aggregateFiles.reduce((sum, file) => sum + file.observed_text_churn, 0),
    observed_text_change_count: observedTextChangeCount,
    observed_touch_count: observedTouchCount,
    observed_touch_ownership_concentration: observedTouchCount === 0
      ? null
      : Math.max(...observedAuthorTouches.values()) / observedTouchCount,
    observed_co_change_pair_count: relationships.length,
  };
  const artifactRefs = files.map((file) => file.path);
  const observedWindowReason = "observed-history-window-span-not-file-or-repository-creation-age";
  const ownershipReason = "observed-commit-touch-concentration-within-the-declared-history-window-not-authorship-or-productivity";
  const behavioralAggregateReason = behavioralDegradationReasons.join(";") || null;
  const aggregateChurnReason = [
    aggregateHasBinaryChange ? BINARY_CHURN_UNVERIFIABLE_REASON : null,
    ...behavioralDegradationReasons,
  ].filter(Boolean).join(";") || null;
  const observedFileFrequencyReason = hasUnattributedMergeChurn
    ? "observed_file_change_frequency_excludes_unattributed_merge_conflict_resolution"
    : null;
  const observedSubsetReasonParts = [
    "observed-subset (partial/non-full; not a full-history metric)",
    `observed_attributed_commits=${observedAttributedCommitCount}/${commits.length}`,
    `observed_non_merge_commits=${observedNonMergeCommitCount}/${commits.length}`,
    `unattributed_merge_commits=${unattributedMergeCommitCount}`,
    `generated_vendor_file_changes_excluded=${generatedVendorFileChangeExclusionCount}`,
    `unknown_classification_file_changes_excluded=${unknownClassificationFileChangeExclusionCount}`,
  ];
  const observedTextSubsetReason = [
    ...observedSubsetReasonParts,
    `binary_numstat_rows_excluded_from_text_churn=${binaryFileChangeExclusionCount}`,
  ].join("; ");
  const observedTouchSubsetReason = [
    ...observedSubsetReasonParts,
    `binary_line_churn_exclusions=${binaryFileChangeExclusionCount}`,
    `binary_path_author_touches_retained=${binaryFileChangeExclusionCount}`,
  ].join("; ");
  const observedCoChangeSubsetReason = [
    observedTouchSubsetReason,
    `temporal_mass_change_policy=${temporalCoupling.mass_change_policy.policy_id}@${temporalCoupling.mass_change_policy.policy_version}`,
    `mass_commits=${temporalCoupling.mass_change_policy.mass_commit_count}`,
    `excluded_pairwise=${temporalCoupling.mass_change_policy.excluded_pairwise_count}`,
    `down_weighted_pairwise=${temporalCoupling.mass_change_policy.down_weighted_pairwise_count}`,
    "observed pair count is post-policy, not all theoretical pairs",
  ].join("; ");
  const fileFrequencyReason = hasUnattributedMergeChurn ? observedTouchSubsetReason : null;
  const common = {
    family: "repository_behavior", status: "measured", sourceKind, collectorId: "git-history", command,
    artifactRefs, window: effectiveWindow, analyzerIdentity: GIT_ANALYZER_ID, analyzerVersion: GIT_ANALYZER_VERSION,
    includedInHuman: false,
  };
  const metrics = [
    metricRecord(input, { ...common, metricId: "git.change_frequency", definitionId: "sei.git.change_frequency@1", value: aggregates.commit_count, unit: "revisions" }),
    metricRecord(input, {
      ...common,
      metricId: "git.churn",
      definitionId: "sei.git.churn@1",
      value: aggregates.churn,
      unit: "lines-changed",
      status: aggregateChurnUnverifiable ? "unverifiable" : "measured",
      reason: aggregateChurnReason,
    }),
    metricRecord(input, {
      ...common,
      metricId: "git.observed_text_churn",
      definitionId: "sei.git.observed_text_churn@1",
      value: aggregates.observed_text_churn,
      unit: "lines-changed",
      status: observedTextChangeCount === 0 && unknownClassificationFileChangeExclusionCount > 0 ? "unverifiable" : "measured",
      completeness: observedTextChangeCount === 0 && unknownClassificationFileChangeExclusionCount > 0 ? 0 : observedCommitCoverage,
      confidence: observedTextChangeCount === 0 && unknownClassificationFileChangeExclusionCount > 0 ? 0 : observedCommitCoverage,
      reason: observedTextSubsetReason,
    }),
    metricRecord(input, { ...common, metricId: "git.age_days", definitionId: "sei.git.age_days@1", value: aggregates.repository_age_days, unit: "days", reason: observedWindowReason }),
    metricRecord(input, {
      ...common,
      metricId: "git.ownership_concentration",
      definitionId: "sei.git.ownership_concentration@1",
      value: aggregates.ownership_concentration,
      unit: "ratio",
      status: behavioralAggregatesUnverifiable ? "unverifiable" : totalTouches === 0 ? "not-applicable" : "measured",
      reason: behavioralAggregatesUnverifiable
        ? behavioralAggregateReason
        : totalTouches === 0
          ? "history rows contain no behavioral file touches from which to derive observed commit concentration"
          : ownershipReason,
      completeness: behavioralAggregatesUnverifiable ? 0 : 1,
      confidence: behavioralAggregatesUnverifiable ? 0 : 1,
    }),
    metricRecord(input, {
      ...common,
      metricId: "git.observed_touch_ownership_concentration",
      definitionId: "sei.git.observed_touch_ownership_concentration@1",
      value: aggregates.observed_touch_ownership_concentration,
      unit: "ratio",
      status: observedTouchCount === 0 && unknownClassificationFileChangeExclusionCount > 0
        ? "unverifiable"
        : observedTouchCount === 0 ? "not-applicable" : "measured",
      completeness: observedTouchCount === 0 ? 0 : observedCommitCoverage,
      confidence: observedTouchCount === 0 ? 0 : observedCommitCoverage,
      reason: observedTouchCount === 0
        ? `${observedTouchSubsetReason}; no eligible human file touches were observed`
        : observedTouchSubsetReason,
    }),
    metricRecord(input, {
      ...common,
      metricId: "git.co_change_pair_count",
      definitionId: "sei.git.co_change_pair_count@1",
      value: aggregates.co_change_pair_count,
      unit: "file-pairs",
      status: behavioralAggregatesUnverifiable ? "unverifiable" : "measured",
      reason: behavioralAggregatesUnverifiable ? behavioralAggregateReason : null,
    }),
    metricRecord(input, {
      ...common,
      metricId: "git.observed_co_change_pair_count",
      definitionId: "sei.git.observed_co_change_pair_count@1",
      value: aggregates.observed_co_change_pair_count,
      unit: "file-pairs",
      status: observedTouchCount === 0 && unknownClassificationFileChangeExclusionCount > 0 ? "unverifiable" : "measured",
      completeness: observedTouchCount === 0 && unknownClassificationFileChangeExclusionCount > 0 ? 0 : observedCommitCoverage,
      confidence: observedTouchCount === 0 && unknownClassificationFileChangeExclusionCount > 0 ? 0 : observedCommitCoverage,
      reason: observedCoChangeSubsetReason,
    }),
  ];
  for (const file of files) {
    const fileCommon = {
      ...common,
      subject: `file:${file.path}`,
      artifactRefs: [file.path],
      scopeKind: "file",
      scopePath: file.path,
      generatedCode: file.generated_code,
      includedInHuman: file.included_in_human_maintainability,
    };
    metrics.push(
      metricRecord(input, {
        ...fileCommon,
        metricId: `git.change_frequency:${file.path}`,
        definitionId: "sei.git.change_frequency@1",
        value: file.change_frequency,
        unit: "revisions",
        reason: fileFrequencyReason ?? observedFileFrequencyReason,
        completeness: hasUnattributedMergeChurn ? observedCommitCoverage : 1,
        confidence: hasUnattributedMergeChurn ? observedCommitCoverage : 1,
      }),
      metricRecord(input, {
        ...fileCommon,
        metricId: `git.churn:${file.path}`,
        definitionId: "sei.git.churn@1",
        value: file.churn,
        unit: "lines-changed",
        status: file.binary_change || hasUnattributedMergeChurn ? "unverifiable" : "measured",
        reason: [
          file.binary_change ? BINARY_CHURN_UNVERIFIABLE_REASON : null,
          hasUnattributedMergeChurn ? MERGE_CHURN_UNATTRIBUTED_REASON : null,
        ].filter(Boolean).join(";") || null,
      }),
      metricRecord(input, {
        ...fileCommon,
        metricId: `git.observed_text_churn:${file.path}`,
        definitionId: "sei.git.observed_text_churn@1",
        value: file.observed_text_churn,
        unit: "lines-changed",
        status: !file.generated_classification_known
          ? "unverifiable"
          : !file.included_in_behavioral_aggregates || file.observed_text_change_count === 0
            ? "not-applicable"
            : "measured",
        completeness: file.observed_text_change_count === 0 ? 0 : observedCommitCoverage,
        confidence: file.observed_text_change_count === 0 ? 0 : observedCommitCoverage,
        reason: file.observed_text_change_count === 0
          ? `${observedTextSubsetReason}; no eligible human text change was observed for ${file.path}`
          : observedTextSubsetReason,
      }),
      metricRecord(input, { ...fileCommon, metricId: `git.age_days:${file.path}`, definitionId: "sei.git.age_days@1", value: file.age_days, unit: "days", reason: observedWindowReason }),
      metricRecord(input, {
        ...fileCommon,
        metricId: `git.ownership_concentration:${file.path}`,
        definitionId: "sei.git.ownership_concentration@1",
        value: file.ownership_concentration,
        unit: "ratio",
        status: hasUnattributedMergeChurn ? "unverifiable" : "measured",
        reason: hasUnattributedMergeChurn ? MERGE_CHURN_UNATTRIBUTED_REASON : ownershipReason,
      }),
      metricRecord(input, {
        ...fileCommon,
        metricId: `git.observed_touch_ownership_concentration:${file.path}`,
        definitionId: "sei.git.observed_touch_ownership_concentration@1",
        value: file.observed_touch_ownership_concentration,
        unit: "ratio",
        status: !file.generated_classification_known
          ? "unverifiable"
          : !file.included_in_behavioral_aggregates || file.observed_touch_count === 0
            ? "not-applicable"
            : "measured",
        completeness: file.observed_touch_count === 0 ? 0 : observedCommitCoverage,
        confidence: file.observed_touch_count === 0 ? 0 : observedCommitCoverage,
        reason: file.observed_touch_count === 0
          ? `${observedTouchSubsetReason}; no eligible human file touch was observed for ${file.path}`
          : observedTouchSubsetReason,
      }),
    );
  }
  metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  const collector = collectorRecord({
    id: "git-history",
    status: behavioralAggregatesUnverifiable ? "degraded" : "available",
    analyzerIdentity: GIT_ANALYZER_ID,
    analyzerVersion: GIT_ANALYZER_VERSION,
    reason: behavioralAggregateReason,
  });
  return { collectors: [collector], capabilities: [structuredClone(collector)], metrics, files, relationships, aggregates, temporal_coupling: temporalCoupling };
}

function mergeLocalEvidence(staticEvidence, gitEvidence) {
  for (const [label, evidence] of [["static", staticEvidence], ["git", gitEvidence]]) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
        !Array.isArray(evidence.collectors) || !Array.isArray(evidence.metrics) ||
        !Array.isArray(evidence.relationships) || !evidence.aggregates || typeof evidence.aggregates !== "object") {
      throw new Error(`FAIL-MALFORMED-LOCAL-EVIDENCE: ${label} evidence is not a closed collector result`);
    }
  }
  const collectors = [...staticEvidence.collectors, ...gitEvidence.collectors].sort((left, right) => stableCompare(left.collector_id, right.collector_id));
  return {
    collectors,
    capabilities: structuredClone(collectors),
    metrics: [...staticEvidence.metrics, ...gitEvidence.metrics].sort((left, right) => stableCompare(left.metric_id, right.metric_id)),
    relationships: [...staticEvidence.relationships, ...gitEvidence.relationships].sort((left, right) => stableCompare(`${left.kind}:${left.source}:${left.target}`, `${right.kind}:${right.source}:${right.target}`)),
    aggregates: { static: staticEvidence.aggregates, git: gitEvidence.aggregates },
    static: staticEvidence,
    git: gitEvidence,
  };
}

function staticIntegrationFailure(detail) {
  throw new Error(`FAIL-STATIC-INTELLIGENCE-INTEGRATION: ${detail}`);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function integratePythonStaticIntelligence(input = {}) {
  const allowed = new Set(["collector_input", "lexical_evidence", "repository_index", "static_intelligence"]);
  if (!isPlainRecord(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    staticIntegrationFailure("input must be a closed integration record");
  }
  const collectorInput = input.collector_input;
  const lexical = input.lexical_evidence;
  const repositoryIndex = input.repository_index;
  const result = input.static_intelligence;
  const canonical = result?.canonical;
  if (!isPlainRecord(collectorInput) || !isPlainRecord(lexical)
      || !Array.isArray(lexical.collectors) || !Array.isArray(lexical.metrics)
      || !Array.isArray(lexical.files) || !Array.isArray(lexical.relationships)
      || !isPlainRecord(lexical.aggregates) || !isPlainRecord(repositoryIndex?.binding)
      || !isPlainRecord(result) || !isPlainRecord(canonical)
      || !Array.isArray(canonical.collectors) || !Array.isArray(canonical.metrics)
      || !isPlainRecord(canonical.binding) || !isPlainRecord(canonical.analyzer)
      || !isPlainRecord(canonical.diagnostics) || !isPlainRecord(canonical.facts)
      || !isPlainRecord(result.telemetry)) {
    staticIntegrationFailure("lexical, index, and Python analyzer results must expose their closed landed seams");
  }
  const revision = repositoryRevision(collectorInput);
  const indexDigest = repositoryIndex.binding.index_digest;
  if (repositoryIndex.binding.repository_revision !== revision
      || canonical.binding.repository_revision !== revision) {
    staticIntegrationFailure("repository revision does not match the shared index and Python result");
  }
  if (typeof indexDigest !== "string" || canonical.binding.index_digest !== indexDigest) {
    staticIntegrationFailure("Python result does not match the shared RepositoryIndex digest");
  }
  for (const [key, value] of [
    ["configuration_hash", canonical.binding.configuration_hash],
    ["graph_cache_key", canonical.binding.graph_cache_key],
    ["graph_evidence_key", canonical.binding.graph_evidence_key],
  ]) {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
      staticIntegrationFailure(`Python binding ${key} is invalid`);
    }
  }
  for (const key of ["analyzer_version", "parser_runtime"]) {
    if (typeof canonical.analyzer[key] !== "string" || canonical.analyzer[key].length === 0) {
      staticIntegrationFailure(`Python analyzer ${key} is invalid`);
    }
  }

  const lexicalCollectorIds = new Set();
  for (const collector of lexical.collectors) {
    if (!isPlainRecord(collector) || typeof collector.collector_id !== "string"
        || lexicalCollectorIds.has(collector.collector_id)) {
      staticIntegrationFailure("lexical collector identities are malformed or duplicated");
    }
    lexicalCollectorIds.add(collector.collector_id);
  }
  const pythonCollectorIds = new Set();
  for (const collector of canonical.collectors) {
    if (!isPlainRecord(collector) || typeof collector.collector_id !== "string"
        || pythonCollectorIds.has(collector.collector_id) || lexicalCollectorIds.has(collector.collector_id)) {
      staticIntegrationFailure(`Python collector identity ${collector?.collector_id ?? "<missing>"} is malformed or duplicated`);
    }
    pythonCollectorIds.add(collector.collector_id);
  }

  const lexicalMetricIds = new Set();
  let cyclomaticPlaceholder = null;
  for (const metric of lexical.metrics) {
    if (!isPlainRecord(metric) || typeof metric.metric_id !== "string" || lexicalMetricIds.has(metric.metric_id)) {
      staticIntegrationFailure("lexical metric identities are malformed or duplicated");
    }
    lexicalMetricIds.add(metric.metric_id);
    if (metric.metric_id === "static.cyclomatic_complexity") cyclomaticPlaceholder = metric;
  }
  if (cyclomaticPlaceholder?.measurement?.status !== "unavailable"
      || cyclomaticPlaceholder?.source?.collector_id !== "static-specialized-complexity") {
    staticIntegrationFailure("legacy cyclomatic ownership is not the replaceable unavailable placeholder");
  }

  const pythonMetricIds = new Set();
  for (const metric of canonical.metrics) {
    if (!isPlainRecord(metric) || typeof metric.metric_id !== "string" || pythonMetricIds.has(metric.metric_id)) {
      staticIntegrationFailure("Python metric identities are malformed or duplicated");
    }
    if (lexicalMetricIds.has(metric.metric_id) && metric.metric_id !== "static.cyclomatic_complexity") {
      staticIntegrationFailure(`Python metric duplicates existing ownership for ${metric.metric_id}`);
    }
    pythonMetricIds.add(metric.metric_id);
  }
  if (!pythonMetricIds.has("static.cyclomatic_complexity")) {
    staticIntegrationFailure("Python result did not claim the cyclomatic replacement");
  }

  const configurationHash = deriveCollectorConfigurationHash(collectorInput);
  const bindingRefs = [
    `python-analyzer:${canonical.analyzer.analyzer_version}`,
    `python-configuration:${canonical.binding.configuration_hash}`,
    `python-graph:${canonical.binding.graph_evidence_key}`,
    `python-runtime:${canonical.analyzer.parser_runtime}`,
    `repository-index:${indexDigest}`,
  ];
  const projectedMetrics = canonical.metrics.map((metric) => {
    if (metric.repository_revision !== revision || metric.source?.repository_revision !== revision
        || metric.window?.end !== revision || !pythonCollectorIds.has(metric.source?.collector_id)) {
      staticIntegrationFailure(`Python metric ${metric.metric_id} is not revision/collector bound`);
    }
    const artifactRefs = [...new Set([
      ...(Array.isArray(metric.source.artifact_refs) ? metric.source.artifact_refs : []),
      ...bindingRefs,
    ])].sort(stableCompare);
    const evidenceRefs = [...new Set([
      ...(Array.isArray(metric.source.evidence_refs) ? metric.source.evidence_refs : []),
      ...bindingRefs,
    ])].sort(stableCompare);
    const repositoryScope = metric.scope?.kind === "repository";
    return {
      ...structuredClone(metric),
      subject: repositoryScope ? repositorySubject(collectorInput) : metric.subject,
      source: {
        ...structuredClone(metric.source),
        artifact_refs: artifactRefs,
        evidence_refs: evidenceRefs,
      },
      comparability: {
        ...structuredClone(metric.comparability),
        configuration_hash: configurationHash,
      },
    };
  });
  const metrics = [
    ...lexical.metrics.filter((metric) => metric.metric_id !== "static.cyclomatic_complexity").map((metric) => structuredClone(metric)),
    ...projectedMetrics,
  ].sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  if (new Set(metrics.map((metric) => metric.metric_id)).size !== metrics.length) {
    staticIntegrationFailure("integrated metric ownership is not unique");
  }
  const collectors = [
    ...lexical.collectors.map((collector) => structuredClone(collector)),
    ...canonical.collectors.map((collector) => structuredClone(collector)),
  ].sort((left, right) => stableCompare(left.collector_id, right.collector_id));
  return {
    evidence: {
      ...lexical,
      collectors,
      capabilities: structuredClone(collectors),
      metrics,
      static_intelligence: canonical,
    },
    canonical,
    telemetry: result.telemetry,
  };
}

function collectLocalEvidence(input = {}) {
  if (suppliedSourceRows(input) === null || suppliedHistoryRows(input) === null) {
    throw new Error("FAIL-REPOSITORY-INDEX-REQUIRED: repository-local collection requires the asynchronous indexed collection topology");
  }
  return mergeLocalEvidence(collectStaticEvidence(input), collectGitEvidence(input));
}

module.exports = {
  collectGitEvidence,
  collectGitEvidenceAsync,
  collectLocalEvidence,
  collectStaticEvidence,
  collectStaticEvidenceFromIndex,
  deriveCollectorConfigurationHash,
  integratePythonStaticIntelligence,
  mergeLocalEvidence,
};
Object.defineProperty(module.exports, Symbol.for("sei.collectors.private.v2"), {
  value: Object.freeze({ collectGitEvidenceIncremental, collectStaticEvidenceIncremental }),
});
