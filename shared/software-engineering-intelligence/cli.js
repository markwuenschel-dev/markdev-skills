"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  collectGitEvidence,
  collectStaticEvidenceFromIndex,
  deriveCollectorConfigurationHash,
  integratePythonStaticIntelligence,
  mergeLocalEvidence,
} = require("./collectors.js");
const collectorsPrivate = require("./collectors.js")[Symbol.for("sei.collectors.private.v2")];
const incrementalRunState = require("./incremental-run-state.js");
const { openIncrementalRun } = incrementalRunState;
const incrementalStatePrivate = incrementalRunState[Symbol.for("sei.incremental-run-state.private.v2")];
const dependencyInvalidationPrivate = require("./dependency-invalidation.js")[Symbol.for("sei.dependency-invalidation.private@1")];
const { TaskExecutor } = require("./task-executor.js");
const { buildRepositoryIndex } = require("./repository-index.js");
const { analyzeStaticIntelligence } = require("./static-intelligence.js");
const { analyzeTsjsIntelligence, projectTsjsEvidence } = require("./tsjs-intelligence.js");
const { analyzeDuplicationIntelligence, projectDuplicationEvidence } = require("./duplication-intelligence.js");
const { discoverEngineeringEvidence, projectEngineeringEvidence } = require("./autonomous-evidence.js");
const autonomousAssessmentPrivate = require("./autonomous-evidence.js")[Symbol.for("sei.autonomous-evidence.assessment.private.v1")];
const { collectAutonomousLocalExecution } = require("./autonomous-local-execution.js");
const { analyzeDependencyIntelligence, projectDependencyEvidence } = require("./dependency-intelligence.js");
const { buildInvestigationSignalRiskModel } = require("./investigation-synthesis.js");
const { analyzeJvmStaticIntelligence, projectJvmEvidence, projectUnavailableJvmEvidence } = require("./jvm-static-intelligence.js");
const { collectAdapterEvidence } = require("./evidence-adapters.js");
const {
  buildVerificationArtifactEnvelope,
  discoverRevisionBoundVerificationEvidenceFromIndex,
} = require("./verification-artifacts.js");
const { deriveTemporalCoupling } = require("./temporal-coupling.js");
const intelligenceEngine = require("./intelligence-engine.js");
const {
  SNAPSHOT_SCHEMA_VERSION,
  deriveRiskModelContractHash,
  materializeSnapshot,
  validateSnapshot,
} = intelligenceEngine;
const { compareSnapshots, deriveHotspots } = require("./interpretation.js");
const { evaluateProfiles } = require("./profiles.js");
const { resolveSeiLayout } = require("./layout.js");
const reportModule = require("./report.js");
const reportPrivate = reportModule[Symbol.for("sei.report.private.v1")];
const forwardTemporalEvaluator = require("./forward-temporal-evaluator.js");
const forwardTemporalPrivate = forwardTemporalEvaluator[Symbol.for("sei.forward-temporal-evaluator.private.v1")];
const predictiveAuto = require("./predictive-auto.js");
const predictiveAutoPrivate = predictiveAuto[Symbol.for("sei.predictive-auto.private.v1")];
const predictiveStateManagement = require("./predictive-state-management.js");
const predictiveStatePrivate = predictiveStateManagement[Symbol.for("sei.predictive-state-management.private.v1")];
const engineeringAssessment = require("./engineering-assessment.js");
const engineeringAssessmentPrivate = engineeringAssessment[Symbol.for("sei.engineering-assessment.private.v1")];
const assessmentStandards = require("./assessment-standards.js");
const trendBaseline = require("./trend-baseline.js");
const { deriveCanonicalRepositoryIdentity } = trendBaseline;
const projectIntelligenceWorkspace = require("../project-intelligence-workspace/project-intelligence-workspace.js");
const trendBaselinePrivate = trendBaseline[Symbol.for("sei.trend-baseline.private.v1")];

const DEFAULT_CONFIG_PATH = resolveSeiLayout().config_path;
const ARGUMENTS = new Set(["--repo", "--out", "--config", "--assessment-config", "--performance-json", "--baseline", "--python", "--incremental", "--predictive", "--forward-temporal", "--forward-temporal-prior", "--predictive-state", "--predictive-state-lineage", "--predictive-state-report-pins", "--predictive-state-scope", "--predictive-state-confirm", "--evidence-only", "--report-mode"]);
const CONFIG_FIELDS = new Set([
  "repository_id",
  "generated_path_patterns",
  "history_window",
  "profile_bindings",
  "static_analyzer_version",
  "temporal_coupling_policy",
  "adapter_evidence",
  "verification_artifacts",
]);
const EXTERNAL_ADAPTER_CAPABILITIES = Object.freeze([
  ["coverage-adapter", "external.coverage-adapter", "no coverage adapter was configured"],
  ["ci-adapter", "external.ci-adapter", "no CI adapter was configured"],
  ["deployment-adapter", "external.deployment-adapter", "no deployment adapter was configured"],
  ["work-item-adapter", "external.work-item-adapter", "no work-item adapter was configured"],
  ["policy-adapter", "external.policy-adapter", "no policy adapter was configured"],
  ["feedback-adapter", "external.feedback-adapter", "no feedback adapter was configured"],
]);
const TREND_VALID_MEASUREMENT_STATES = new Set(["measured", "inferred"]);
const STATIC_ANALYSIS_CACHE_SCHEMA_VERSION = 1;
const PYTHON_DISCOVERY_CODE = "import sys; print(sys.executable)";
const PYTHON_DISCOVERY_TIMEOUT_MS = 5_000;
const TYPESCRIPT_RUNTIME_CANDIDATES = Object.freeze([
  ...(process.env.SEI_TYPESCRIPT_PATH ? [process.env.SEI_TYPESCRIPT_PATH] : []),
  ...(process.platform === "win32" && process.env.LOCALAPPDATA
    ? [path.join(process.env.LOCALAPPDATA, "Programs", "cursor", "resources", "app", "extensions", "node_modules", "typescript", "lib", "typescript.js")]
    : []),
]);
const MAX_PYTHON_ANALYZER_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_PYTHON_ANALYZER_CACHE_BUFFER_BYTES = 128 * 1024 * 1024;
const PREPUBLICATION_PHASE_FIELDS = Object.freeze([
  "baseline_discovery_ms",
  "autonomous_discovery_ms",
  "autonomous_local_execution_ms",
  "assessment_evaluation_ms",
  "cache_discovery_ms",
  "comparison_ms",
  "consumer_executor_ms",
  "evidence_composition_ms",
  "git_history_ms",
  "input_binding_ms",
  "lexical_ms",
  "python_static_ms",
  "predictive_auto_ms",
  "report_render_ms",
  "report_verification_ms",
  "repository_index_ms",
  "repository_resolution_ms",
  "snapshot_build_ms",
  "snapshot_draft_ms",
  "snapshot_identity_ms",
  "snapshot_materialization_ms",
  "snapshot_serialization_ms",
  "snapshot_validation_ms",
  "substrate_executor_ms",
  "tsjs_static_ms",
  "duplication_ms",
  "jvm_static_ms",
  "verification_discovery_ms",
]);
const RECONCILED_PREPUBLICATION_PHASE_FIELDS = Object.freeze([
  "repository_resolution_ms",
  "input_binding_ms",
  "cache_discovery_ms",
  "substrate_executor_ms",
  "consumer_executor_ms",
  "evidence_composition_ms",
  "snapshot_build_ms",
  "baseline_discovery_ms",
  "comparison_ms",
  "predictive_auto_ms",
  "report_render_ms",
  "report_verification_ms",
  "assessment_evaluation_ms",
]);
const EXCLUDED_PERFORMANCE_RECEIPT_PHASES = Object.freeze({
  artifact_preflight_ms: "occurs after immutable performance receipt bytes are fixed",
  artifact_publication_ms: "occurs after immutable performance receipt bytes are fixed",
  performance_receipt_write_ms: "the caller writes or transports the returned receipt after CLI execution",
});
const intelligenceEnginePrivate = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")];
const MAX_PYTHON_ANALYZER_CACHE_ENTRIES = 100_000;

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function roundedMilliseconds(value) {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function createPhaseRecorder(monotonicNow = process.hrtime.bigint) {
  if (typeof monotonicNow !== "function") {
    throw new Error("FAIL-CLI-TELEMETRY: monotonic clock must be a function");
  }
  let previous = null;
  const readNow = () => {
    const value = monotonicNow();
    if (typeof value !== "bigint" || value < 0n || (previous !== null && value < previous)) {
      throw new Error("FAIL-CLI-TELEMETRY: monotonic clock returned an invalid or regressing bigint");
    }
    previous = value;
    return value;
  };
  const origin = readNow();
  const phases = new Map(PREPUBLICATION_PHASE_FIELDS.map((field) => [field, 0]));
  const millisecondsBetween = (start, end) => Number(end - start) / 1_000_000;
  const add = (field, durationMs) => {
    if (typeof field !== "string" || !phases.has(field) || typeof durationMs !== "number"
        || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`FAIL-CLI-TELEMETRY: invalid phase observation ${String(field)}`);
    }
    phases.set(field, phases.get(field) + durationMs);
  };
  const measureSync = (field, work) => {
    if (typeof work !== "function") throw new Error("FAIL-CLI-TELEMETRY: measured work must be a function");
    const started = readNow();
    try {
      return work();
    } finally {
      add(field, millisecondsBetween(started, readNow()));
    }
  };
  const measureAsync = async (field, work) => {
    if (typeof work !== "function") throw new Error("FAIL-CLI-TELEMETRY: measured work must be a function");
    const started = readNow();
    try {
      return await work();
    } finally {
      add(field, millisecondsBetween(started, readNow()));
    }
  };
  const measureDetachedSync = (work) => {
    if (typeof work !== "function") throw new Error("FAIL-CLI-TELEMETRY: measured work must be a function");
    const started = readNow();
    const value = work();
    return { value, duration_ms: millisecondsBetween(started, readNow()) };
  };
  const elapsed = () => millisecondsBetween(origin, readNow());
  const phaseObject = (fields = PREPUBLICATION_PHASE_FIELDS) => Object.fromEntries(
    fields.map((field) => [field, roundedMilliseconds(phases.get(field) ?? 0)]),
  );
  const prepublicationTelemetry = () => {
    const durationMs = elapsed();
    const accountedMs = RECONCILED_PREPUBLICATION_PHASE_FIELDS
      .reduce((sum, field) => sum + (phases.get(field) ?? 0), 0);
    const unattributedMs = durationMs - accountedMs;
    const toleranceMs = Math.max(50, durationMs * 0.02);
    return {
      schema_version: "sei.phase-telemetry@1",
      clock: "monotonic-bigint-nanoseconds",
      timing_scope: "execution-start-through-prepublication-validation",
      phases_ms: phaseObject(),
      reconciliation: {
        accounted_fields: [...RECONCILED_PREPUBLICATION_PHASE_FIELDS],
        accounted_ms: roundedMilliseconds(accountedMs),
        prepublication_duration_ms: roundedMilliseconds(durationMs),
        unattributed_ms: roundedMilliseconds(unattributedMs),
        tolerance_ms: roundedMilliseconds(toleranceMs),
        within_tolerance: unattributedMs >= 0 && unattributedMs <= toleranceMs,
      },
      excluded_phases: { ...EXCLUDED_PERFORMANCE_RECEIPT_PHASES },
    };
  };
  return Object.freeze({
    add,
    elapsed,
    measureAsync,
    measureDetachedSync,
    measureSync,
    prepublicationTelemetry,
    instrumentation: Object.freeze({ now: readNow, observe: add }),
    finalTelemetry(prepublication, artifactPreflightMs, artifactPublicationMs) {
      return {
        ...structuredClone(prepublication),
        timing_scope: "execution-start-through-artifact-publication",
        phases_ms: {
          ...prepublication.phases_ms,
          artifact_preflight_ms: roundedMilliseconds(artifactPreflightMs),
          artifact_publication_ms: roundedMilliseconds(artifactPublicationMs),
          total_internal_ms: roundedMilliseconds(elapsed()),
        },
        excluded_phases: {
          performance_receipt_write_ms: EXCLUDED_PERFORMANCE_RECEIPT_PHASES.performance_receipt_write_ms,
        },
      };
    },
  });
}

function defaultOutputRoot(repositoryPath) {
  return path.join(path.resolve(repositoryPath), projectIntelligenceWorkspace.WORKSPACE_DIR_NAME);
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (name === "--evidence-only") {
      if (Object.hasOwn(parsed, name)) throw new Error(`FAIL-CLI-ARGUMENTS: duplicate argument ${name}`);
      parsed[name] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!ARGUMENTS.has(name) || typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error("FAIL-CLI-ARGUMENTS: expected [--repo <path>] [--out <path>] [--config <path>] [--assessment-config <path>] [--evidence-only] [--report-mode generate|skip] [--baseline <canonical-snapshot-or-ref.json>] [--performance-json <path>] [--python <absolute-compatible-cpython-path>] [--predictive auto|off|required] [--forward-temporal <absolute-current-bundle.json>] [--forward-temporal-prior <absolute-historical-bundle.json>] [--incremental auto|off] [--predictive-state inspect|purge --predictive-state-lineage <lineage.json> --predictive-state-report-pins <pins.json> --predictive-state-scope <inspection.json> --predictive-state-confirm <token>]");
    }
    if (Object.hasOwn(parsed, name)) throw new Error(`FAIL-CLI-ARGUMENTS: duplicate argument ${name}`);
    parsed[name] = value;
    index += 2;
  }
  const repositoryPath = path.resolve(parsed["--repo"] ?? process.cwd());
  const outputPath = parsed["--out"] === undefined
    ? defaultOutputRoot(repositoryPath)
    : path.resolve(parsed["--out"]);
  if (parsed["--python"] !== undefined && (
    !path.isAbsolute(parsed["--python"]) || parsed["--python"].includes("\0")
  )) {
    throw new Error("FAIL-CLI-ARGUMENTS: --python must be an explicit absolute NUL-free Python executable path");
  }
  for (const argument of ["--forward-temporal", "--forward-temporal-prior"]) {
    if (parsed[argument] !== undefined && (!path.isAbsolute(parsed[argument]) || parsed[argument].includes("\0"))) {
      throw new Error(`FAIL-CLI-ARGUMENTS: ${argument} must be an explicit absolute NUL-free bundle path`);
    }
  }
  if (parsed["--forward-temporal"] !== undefined && parsed["--forward-temporal-prior"] !== undefined) {
    throw new Error("FAIL-CLI-ARGUMENTS: --forward-temporal and --forward-temporal-prior are mutually exclusive");
  }
  if (parsed["--incremental"] !== undefined && !new Set(["auto", "off"]).has(parsed["--incremental"])) {
    throw new Error("FAIL-CLI-ARGUMENTS: --incremental must be auto or off");
  }
  if (parsed["--predictive"] !== undefined && !new Set(["auto", "off", "required"]).has(parsed["--predictive"])) {
    throw new Error("FAIL-CLI-ARGUMENTS: --predictive must be auto, off, or required");
  }
  if (parsed["--report-mode"] !== undefined && !new Set(["generate", "skip"]).has(parsed["--report-mode"])) {
    throw new Error("FAIL-CLI-ARGUMENTS: --report-mode must be generate or skip");
  }
  if (parsed["--predictive-state"] !== undefined && !new Set(["inspect", "purge"]).has(parsed["--predictive-state"])) {
    throw new Error("FAIL-CLI-ARGUMENTS: --predictive-state must be inspect or purge");
  }
  const stateCommand = parsed["--predictive-state"] ?? null;
  if (stateCommand === null && (
    parsed["--predictive-state-lineage"] !== undefined
    || parsed["--predictive-state-report-pins"] !== undefined
    || parsed["--predictive-state-scope"] !== undefined
    || parsed["--predictive-state-confirm"] !== undefined
  )) {
    throw new Error("FAIL-CLI-ARGUMENTS: predictive state options require --predictive-state inspect|purge");
  }
  if (stateCommand !== null && parsed["--evidence-only"] === true) {
    throw new Error("FAIL-CLI-ARGUMENTS: --evidence-only cannot be combined with predictive state management");
  }
  if (stateCommand === "inspect" && parsed["--predictive-state-confirm"] !== undefined) {
    throw new Error("FAIL-CLI-ARGUMENTS: inspection cannot receive purge-only state options");
  }
  if (stateCommand === "inspect" && parsed["--predictive-state-scope"] !== undefined) {
    throw new Error("FAIL-CLI-ARGUMENTS: inspection cannot receive purge-only state options");
  }
  if (stateCommand === "purge" && parsed["--predictive-state-confirm"] === undefined) {
    throw new Error("FAIL-CLI-ARGUMENTS: purge requires --predictive-state-confirm <token>");
  }
  if (stateCommand === "purge" && parsed["--predictive-state-scope"] === undefined) {
    throw new Error("FAIL-CLI-ARGUMENTS: purge requires --predictive-state-scope <inspection.json>");
  }
  if (stateCommand !== null && parsed["--predictive-state-lineage"] === undefined) {
    throw new Error("FAIL-CLI-ARGUMENTS: predictive state management requires --predictive-state-lineage <lineage.json>");
  }
  return {
    repo: repositoryPath,
    out: outputPath,
    usesProjectWorkspace: parsed["--out"] === undefined,
    config: parsed["--config"] ? path.resolve(parsed["--config"]) : DEFAULT_CONFIG_PATH,
    assessmentConfig: parsed["--assessment-config"] ? path.resolve(parsed["--assessment-config"]) : null,
    evidenceOnly: parsed["--evidence-only"] === true,
    baseline: parsed["--baseline"] ? path.resolve(parsed["--baseline"]) : null,
    performanceJson: parsed["--performance-json"] ? path.resolve(parsed["--performance-json"]) : null,
    python: parsed["--python"] ? path.resolve(parsed["--python"]) : null,
    forwardTemporal: parsed["--forward-temporal"] ? path.resolve(parsed["--forward-temporal"]) : null,
    forwardTemporalPrior: parsed["--forward-temporal-prior"] ? path.resolve(parsed["--forward-temporal-prior"]) : null,
    predictive: parsed["--predictive"] ?? "auto",
    incremental: parsed["--incremental"] ?? "auto",
    reportMode: parsed["--report-mode"] ?? "generate",
    predictiveState: stateCommand,
    predictiveStateLineage: parsed["--predictive-state-lineage"] ? path.resolve(parsed["--predictive-state-lineage"]) : null,
    predictiveStateReportPins: parsed["--predictive-state-report-pins"] ? path.resolve(parsed["--predictive-state-report-pins"]) : null,
    predictiveStateScope: parsed["--predictive-state-scope"] ? path.resolve(parsed["--predictive-state-scope"]) : null,
    predictiveStateConfirm: parsed["--predictive-state-confirm"] ?? null,
  };
}

function resolvePythonRuntime(explicitExecutable, dependencies = {}) {
  if (!isRecord(dependencies) || Object.keys(dependencies).some((key) => !["platform", "realpath", "spawn"].includes(key))) {
    throw new Error("FAIL-CLI-COLLECTION: Python runtime discovery dependencies are invalid");
  }
  if (explicitExecutable !== null) {
    if (typeof explicitExecutable !== "string" || !path.isAbsolute(explicitExecutable) || explicitExecutable.includes("\0")) {
      throw new Error("FAIL-CLI-COLLECTION: explicit Python runtime must be an absolute NUL-free path");
    }
    return { executable: explicitExecutable, source: "explicit", status: "candidate", reason: null };
  }
  const platform = dependencies.platform ?? process.platform;
  const spawn = dependencies.spawn ?? spawnSync;
  const realpath = dependencies.realpath ?? fs.realpathSync.native;
  const windows = platform === "win32";
  const command = windows ? "py" : "python3";
  const args = windows
    ? ["-3", "-I", "-S", "-c", PYTHON_DISCOVERY_CODE]
    : ["-I", "-S", "-c", PYTHON_DISCOVERY_CODE];
  let result;
  try {
    result = spawn(command, args, {
      cwd: os.tmpdir(),
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: PYTHON_DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    result = null;
  }
  const output = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (result?.status !== 0 || output.length === 0 || output.includes("\0")
      || output.includes("\n") || output.includes("\r") || !path.isAbsolute(output)) {
    return {
      executable: null,
      source: windows ? "windows-py-3" : "posix-python3",
      status: "unavailable",
      reason: `CPython capability discovery via ${windows ? "py -3" : "python3"} returned no absolute executable`,
    };
  }
  let executable;
  try {
    executable = realpath(output);
  } catch {
    return {
      executable: null,
      source: windows ? "windows-py-3" : "posix-python3",
      status: "unavailable",
      reason: "CPython capability discovery returned an executable path that could not be resolved",
    };
  }
  if (typeof executable !== "string" || executable.includes("\0") || !path.isAbsolute(executable)) {
    return {
      executable: null,
      source: windows ? "windows-py-3" : "posix-python3",
      status: "unavailable",
      reason: "CPython capability discovery returned an invalid resolved executable path",
    };
  }
  return {
    executable,
    source: windows ? "windows-py-3" : "posix-python3",
    status: "candidate",
    reason: null,
  };
}

function resolveTsjsRuntime(dependencies = {}) {
  if (!isRecord(dependencies) || Object.keys(dependencies).some((key) => !["exists", "realpath", "candidates"].includes(key))) {
    throw new Error("FAIL-CLI-COLLECTION: TS/JS runtime discovery dependencies are invalid");
  }
  const exists = dependencies.exists ?? fs.existsSync;
  const realpath = dependencies.realpath ?? fs.realpathSync.native;
  let packageCandidate = null;
  try { packageCandidate = require.resolve("typescript"); } catch { /* optional trusted host runtime */ }
  const candidates = dependencies.candidates ?? [packageCandidate, ...TYPESCRIPT_RUNTIME_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0") || !exists(candidate)) continue;
    try {
      const resolved = realpath(candidate);
      if (typeof resolved === "string" && path.isAbsolute(resolved) && !resolved.includes("\0")) {
        return { nodeExecutable: process.execPath, typescriptPath: resolved, status: "candidate", source: "trusted-host-typescript", reason: null };
      }
    } catch { /* try next trusted candidate */ }
  }
  return {
    nodeExecutable: process.execPath,
    typescriptPath: null,
    status: "unavailable",
    source: "trusted-host-typescript",
    reason: "no trusted absolute TypeScript compiler API runtime was discovered; TS/JS structural metrics are unavailable",
  };
}

function resolveJvmRuntime(dependencies = {}) {
  if (!isRecord(dependencies) || Object.keys(dependencies).some((key) => !["exists", "realpath", "spawn", "candidates"].includes(key))) {
    throw new Error("FAIL-CLI-COLLECTION: JVM runtime discovery dependencies are invalid");
  }
  const exists = dependencies.exists ?? fs.existsSync;
  const realpath = dependencies.realpath ?? fs.realpathSync.native;
  const spawn = dependencies.spawn ?? spawnSync;
  const configured = [process.env.SEI_JAVA, process.env.SEI_JAVA_25, process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : null].filter(Boolean);
  if (dependencies.candidates === undefined) {
    const lookup = process.platform === "win32" ? spawn("where.exe", ["java"], { encoding: "utf8", windowsHide: true }) : spawn("which", ["java"], { encoding: "utf8" });
    if (lookup.status === 0) configured.push(...String(lookup.stdout).split(/\r?\n/).filter(Boolean));
  }
  for (const candidate of dependencies.candidates ?? configured) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0") || !exists(candidate)) continue;
    try {
      const resolved = realpath(candidate);
      if (typeof resolved !== "string" || !path.isAbsolute(resolved) || resolved.includes("\0")) continue;
      const probe = spawn(resolved, ["-XshowSettings:properties", "-version"], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      if (probe.status !== 0) continue;
      const properties = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
      const version = /^\s*java\.specification\.version\s*=\s*(\S+)\s*$/m.exec(properties)?.[1] ?? null;
      const javaHome = /^\s*java\.home\s*=\s*(.+?)\s*$/m.exec(properties)?.[1] ?? null;
      const feature = /^(\d+)(?:\.|$)/.exec(version ?? "")?.[1];
      if (feature === undefined || Number(feature) < 25 || javaHome === null || !path.isAbsolute(javaHome) || javaHome.includes("\0")) continue;
      const homeExecutable = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
      if (!exists(homeExecutable)) continue;
      const exactExecutable = realpath(homeExecutable);
      if (typeof exactExecutable === "string" && path.isAbsolute(exactExecutable) && !exactExecutable.includes("\0")) {
        return { executable: exactExecutable, status: "candidate", source: "trusted-host-java" };
      }
    } catch { /* try next candidate */ }
  }
  return { executable: null, status: "unavailable", source: "trusted-host-java", reason: "no trusted absolute JDK compiler runtime at version 25 or newer was discovered; Java structural metrics are unavailable" };
}

function derivePackageId(modulePath, repositoryIndex) {
  if (typeof modulePath !== "string" || modulePath.length === 0 || modulePath.includes("\0")) return null;
  const roots = (Array.isArray(repositoryIndex?.entries) ? repositoryIndex.entries : [])
    .filter((entry) => entry?.classifications?.manifest_kinds?.includes("node-package"))
    .map((entry) => path.posix.dirname(entry.path))
    .filter((root, index, values) => values.indexOf(root) === index)
    .filter((root) => root === "." || modulePath === root || modulePath.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length || stableCompare(left, right));
  if (roots.length > 0) return roots[0];
  const parts = modulePath.split("/");
  if (["apps", "modules", "packages", "services"].includes(parts[0]) && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts.length > 1 ? parts[0] : null;
}

function readJson(filePath, failureCode) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`${failureCode}: cannot read ${filePath}: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${failureCode}: ${filePath} is not valid JSON`);
  }
}

function canonicalSnapshotDigest(snapshot) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

function baselineSnapshotFromDocument(supplied) {
  if (!isRecord(supplied) || supplied.kind !== "sei-canonical-snapshot-ref") {
    return { snapshot: supplied, reference: null };
  }
  const allowed = new Set(["kind", "schema_version", "snapshot_id", "snapshot_sha256", "snapshot"]);
  if (Object.keys(supplied).some((key) => !allowed.has(key))) {
    throw new Error("FAIL-CLI-BASELINE: baseline reference contains an unsupported field");
  }
  if (supplied.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`FAIL-CLI-BASELINE: baseline reference schema_version must equal ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (typeof supplied.snapshot_id !== "string" || supplied.snapshot_id.trim().length === 0) {
    throw new Error("FAIL-CLI-BASELINE: baseline reference snapshot_id must be nonblank");
  }
  if (typeof supplied.snapshot_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(supplied.snapshot_sha256)) {
    throw new Error("FAIL-CLI-BASELINE: baseline reference snapshot_sha256 must be a lowercase SHA-256 digest");
  }
  if (!isRecord(supplied.snapshot)) {
    throw new Error("FAIL-CLI-BASELINE: baseline reference snapshot must be an object");
  }
  return {
    snapshot: supplied.snapshot,
    reference: {
      snapshot_id: supplied.snapshot_id,
      snapshot_sha256: supplied.snapshot_sha256,
    },
  };
}

function readCanonicalBaseline(filePath) {
  const supplied = readJson(filePath, "FAIL-CLI-BASELINE");
  const document = baselineSnapshotFromDocument(supplied);
  const validation = validateSnapshot(document.snapshot);
  if (!validation.ok) {
    throw new Error(`FAIL-CLI-BASELINE: baseline is not a valid canonical snapshot (${validation.errors.join("; ")})`);
  }
  let materialized;
  try {
    materialized = materializeSnapshot(document.snapshot);
  } catch (error) {
    throw new Error(`FAIL-CLI-BASELINE: baseline cannot be materialized (${error.message})`);
  }
  if (materialized.snapshot_id !== document.snapshot.snapshot_id) {
    throw new Error("FAIL-CLI-BASELINE: baseline snapshot identity does not survive canonical materialization");
  }
  if (document.reference !== null && (
    document.reference.snapshot_id !== materialized.snapshot_id ||
    document.reference.snapshot_sha256 !== canonicalSnapshotDigest(materialized)
  )) {
    throw new Error("FAIL-CLI-BASELINE: baseline reference identity or digest does not bind the canonical snapshot");
  }
  return materialized;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(config) {
  if (!isRecord(config) || Object.keys(config).some((key) => !CONFIG_FIELDS.has(key))) {
    throw new Error("FAIL-CLI-CONFIG: configuration must contain only declared fields");
  }
  if (config.repository_id !== undefined && (typeof config.repository_id !== "string" || config.repository_id.trim().length === 0)) {
    throw new Error("FAIL-CLI-CONFIG: repository_id must be a non-empty string");
  }
  if (!Array.isArray(config.generated_path_patterns) || config.generated_path_patterns.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("FAIL-CLI-CONFIG: generated_path_patterns must be an array of non-empty strings");
  }
  if (config.static_analyzer_version !== undefined && (typeof config.static_analyzer_version !== "string" || config.static_analyzer_version.length === 0)) {
    throw new Error("FAIL-CLI-CONFIG: static_analyzer_version must be a non-empty string");
  }
  if (config.profile_bindings !== undefined && !Array.isArray(config.profile_bindings)) {
    throw new Error("FAIL-CLI-CONFIG: profile_bindings must be an array");
  }
  if (config.history_window !== undefined) {
    const window = config.history_window;
    if (!isRecord(window) || Object.keys(window).some((key) => !["kind", "start", "end"].includes(key))) {
      throw new Error("FAIL-CLI-CONFIG: history_window must contain only kind, start, and end");
    }
    if (window.kind !== undefined && !["revision", "revision-range"].includes(window.kind)) {
      throw new Error("FAIL-CLI-CONFIG: history_window.kind is unsupported");
    }
    for (const field of ["start", "end"]) {
      if (window[field] !== undefined && window[field] !== null && (typeof window[field] !== "string" || window[field].length === 0 || window[field].startsWith("-"))) {
        throw new Error(`FAIL-CLI-CONFIG: history_window.${field} must be a safe revision or null`);
      }
    }
  }
  if (config.temporal_coupling_policy !== undefined) {
    try {
      deriveTemporalCoupling({ commits: [], policy: config.temporal_coupling_policy });
    } catch (error) {
      throw new Error(`FAIL-CLI-CONFIG: temporal_coupling_policy is invalid (${error.message})`);
    }
  }
  if (config.adapter_evidence !== undefined) {
    const adapterEvidence = config.adapter_evidence;
    if (!isRecord(adapterEvidence) || Object.keys(adapterEvidence).some((key) => key !== "adapters")) {
      throw new Error("FAIL-CLI-CONFIG: adapter_evidence must contain only adapters");
    }
    if (!Array.isArray(adapterEvidence.adapters) || adapterEvidence.adapters.some((adapter) => !isRecord(adapter))) {
      throw new Error("FAIL-CLI-CONFIG: adapter_evidence.adapters must be an array of typed envelope objects");
    }
  }
  if (config.verification_artifacts !== undefined) {
    const verification = config.verification_artifacts;
    if (!isRecord(verification) || Object.keys(verification).some((key) => !["artifacts", "completeness", "coverage"].includes(key))) {
      throw new Error("FAIL-CLI-CONFIG: verification_artifacts must contain only artifacts, completeness, and coverage");
    }
    if (!Array.isArray(verification.artifacts) || verification.artifacts.length === 0 || verification.artifacts.some((artifact) => (
      !isRecord(artifact) || Object.keys(artifact).some((key) => !["format", "path"].includes(key)) ||
      !["junit-xml", "lcov"].includes(artifact.format) || typeof artifact.path !== "string" || artifact.path.length === 0
    ))) {
      throw new Error("FAIL-CLI-CONFIG: verification_artifacts.artifacts must declare nonempty JUnit XML or LCOV paths");
    }
    for (const [field, keys, states] of [
      ["completeness", ["state", "fraction"], ["complete", "partial"]],
      ["coverage", ["scope", "fraction"], ["repository", "partial"]],
    ]) {
      const declaration = verification[field];
      const stateKey = field === "completeness" ? "state" : "scope";
      if (!isRecord(declaration) || Object.keys(declaration).some((key) => !keys.includes(key)) || !states.includes(declaration[stateKey]) ||
        typeof declaration.fraction !== "number" || !Number.isFinite(declaration.fraction) || declaration.fraction < 0 || declaration.fraction > 1 ||
        ((declaration[stateKey] === "complete" || declaration[stateKey] === "repository") && declaration.fraction !== 1) ||
        ((declaration[stateKey] === "partial") && declaration.fraction >= 1)) {
        throw new Error(`FAIL-CLI-CONFIG: verification_artifacts.${field} must declare a coherent supported fraction`);
      }
    }
    if (config.adapter_evidence?.adapters.some((adapter) => adapter.adapter_id === "verification-summary" || adapter.kind === "verification_summary")) {
      throw new Error("FAIL-CLI-CONFIG: verification_artifacts cannot be combined with a normalized verification-summary envelope");
    }
  }
  return structuredClone(config);
}

function runGit(repo, args) {
  const result = spawnSync("git", ["-c", `safe.directory=${path.resolve(repo)}`, "-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`FAIL-REPOSITORY-REVISION: git ${args.join(" ")} failed: ${result.error?.code ?? String(result.stderr || `exit ${result.status}`).trim()}`);
  }
  return result.stdout.trim();
}

function resolveStableHistoryRoot(repo, revision) {
  if (runGit(repo, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error("FAIL-REPOSITORY-REVISION: default full-history binding is unavailable for a shallow repository; declare history_window.start explicitly");
  }
  const roots = [...new Set(runGit(repo, ["rev-list", "--max-parents=0", "--topo-order", "--reverse", revision])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((candidate) => candidate.toLowerCase()))];
  if (roots.length !== 1 || roots.some((candidate) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate))) {
    throw new Error("FAIL-REPOSITORY-REVISION: default full-history binding requires one observable repository root; declare history_window.start explicitly");
  }
  const root = roots[0];
  const verified = runGit(repo, ["rev-parse", "--verify", `${root}^{commit}`]).toLowerCase();
  if (verified !== root) throw new Error("FAIL-REPOSITORY-REVISION: history-root commit verification changed identity");
  return root;
}

function resolveRepository(repo) {
  let stats;
  try {
    stats = fs.statSync(repo);
  } catch (error) {
    throw new Error(`FAIL-REPOSITORY-REVISION: repository path is unavailable: ${error.code ?? error.message}`);
  }
  if (!stats.isDirectory()) throw new Error("FAIL-REPOSITORY-REVISION: repository path must be a directory");
  const root = path.resolve(runGit(repo, ["rev-parse", "--show-toplevel"]));
  const revision = runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
    throw new Error("FAIL-REPOSITORY-REVISION: Git did not resolve an exact commit ID");
  }
  const verified = runGit(root, ["rev-parse", "--verify", `${revision}^{commit}`]).toLowerCase();
  if (verified !== revision) throw new Error("FAIL-REPOSITORY-REVISION: exact revision verification changed identity");
  const generatedAt = new Date(runGit(root, ["show", "-s", "--format=%cI", revision])).toISOString();
  return { root, revision, generatedAt };
}

function statusSummary(measurements) {
  const statusCounts = {
    measured: 0,
    inferred: 0,
    unavailable: 0,
    "not-applicable": 0,
    unverifiable: 0,
  };
  for (const metric of measurements) statusCounts[metric.measurement.status] += 1;
  return { measurement_count: measurements.length, status_counts: statusCounts };
}

function normalizedPatterns(patterns) {
  return [...new Set(patterns.map((pattern) => pattern.replaceAll("\\", "/").replace(/^\.\//, "")))].sort(stableCompare);
}

function attachExternalAdapterCapabilities(evidence) {
  const collectorIds = new Set(evidence.collectors.map((collector) => collector.collector_id));
  const collectors = [...evidence.collectors];
  for (const [collectorId, analyzerIdentity, reason] of EXTERNAL_ADAPTER_CAPABILITIES) {
    if (collectorIds.has(collectorId)) continue;
    collectors.push({
      collector_id: collectorId,
      collector_version: "unavailable",
      status: "unavailable",
      analyzer_identity: analyzerIdentity,
      analyzer_version: "unavailable",
      reason,
    });
  }
  collectors.sort((left, right) => stableCompare(left.collector_id, right.collector_id));
  return { ...evidence, collectors };
}

function bindingSignature(records, fields) {
  if (!Array.isArray(records)) return null;
  const seen = new Set();
  const bindings = [];
  for (const record of records) {
    if (!isRecord(record)) return null;
    const binding = {};
    for (const field of fields) {
      if (typeof record[field] !== "string" || record[field].trim().length === 0) return null;
      binding[field] = record[field].trim();
    }
    if (seen.has(binding[fields[0]])) return null;
    seen.add(binding[fields[0]]);
    bindings.push(binding);
  }
  return JSON.stringify(bindings.sort((left, right) => stableCompare(left[fields[0]], right[fields[0]])));
}

function compatibleSnapshotBindings(previous, current) {
  const previousBoundary = previous?.repository?.history_boundary;
  const currentBoundary = current?.repository?.history_boundary;
  return (
    previous?.schema_version === current?.schema_version &&
    previous?.repository?.repository_id === current?.repository?.repository_id &&
    previous?.repository?.configuration_hash === current?.repository?.configuration_hash &&
    previousBoundary?.kind === currentBoundary?.kind &&
    previousBoundary?.start === currentBoundary?.start &&
    bindingSignature(
      previous?.collectors,
      ["collector_id", "collector_version", "status", "analyzer_identity", "analyzer_version"],
    ) === bindingSignature(
      current?.collectors,
      ["collector_id", "collector_version", "status", "analyzer_identity", "analyzer_version"],
    ) &&
    bindingSignature(previous?.profiles ?? [], ["profile_id", "profile_version", "profile_contract_hash"])
      === bindingSignature(current?.profiles ?? [], ["profile_id", "profile_version", "profile_contract_hash"])
  );
}

function metricHasAvailableCollector(snapshot, metric) {
  const collector = snapshot?.collectors?.find((candidate) => candidate.collector_id === metric?.source?.collector_id);
  return (
    collector?.status === "available" &&
    collector.collector_version === metric?.source?.collector_version &&
    collector.analyzer_identity === metric?.analyzer_identity &&
    collector.analyzer_version === metric?.analyzer_version
  );
}

function metricsCanBindToBaseline(previous, current) {
  return (
    previous?.metric_id === current?.metric_id &&
    previous?.definition_id === current?.definition_id &&
    previous?.subject === current?.subject &&
    previous?.unit === current?.unit &&
    previous?.analyzer_identity === current?.analyzer_identity &&
    previous?.analyzer_version === current?.analyzer_version &&
    previous?.window?.kind === current?.window?.kind &&
    previous?.window?.start === current?.window?.start &&
    previous?.comparability?.configuration_hash === current?.comparability?.configuration_hash &&
    TREND_VALID_MEASUREMENT_STATES.has(previous?.measurement?.status) &&
    TREND_VALID_MEASUREMENT_STATES.has(current?.measurement?.status) &&
    typeof previous?.value === "number" && Number.isFinite(previous.value) &&
    typeof current?.value === "number" && Number.isFinite(current.value)
  );
}

function attachCanonicalBaselineBindings(base, baseline, bindingKind) {
  if (
    baseline?.repository?.revision === base?.repository?.revision ||
    !compatibleSnapshotBindings(baseline, base)
  ) return 0;
  const previousByMetricId = new Map(baseline.measurements.map((metric) => [metric.metric_id, metric]));
  let bindingCount = 0;
  for (const [metricIndex, metric] of base.measurements.entries()) {
    const previous = previousByMetricId.get(metric.metric_id);
    if (
      !previous ||
      !metricsCanBindToBaseline(previous, metric) ||
      !metricHasAvailableCollector(baseline, previous) ||
      !metricHasAvailableCollector(base, metric)
    ) {
      continue;
    }
    base.measurements[metricIndex] = {
      ...metric,
      comparability: {
        ...metric.comparability,
        compatible_with_prior: true,
        reason: `${bindingKind} canonical baseline binding`,
      },
      comparison: {
        baseline_snapshot_id: baseline.snapshot_id,
        baseline_metric_id: previous.metric_id,
        analyzer_identity: metric.analyzer_identity,
        analyzer_version: metric.analyzer_version,
        configuration_hash: base.repository.configuration_hash,
        binding_kind: bindingKind,
        baseline_repository_revision: baseline.repository.revision,
        baseline_value: previous.value,
        delta: metric.value - previous.value,
        confidence: Math.min(previous.measurement.confidence, metric.measurement.confidence),
      },
    };
    bindingCount += 1;
  }
  return bindingCount;
}

function riskEvidenceBindings(measurements) {
  const metricIds = [...new Set(measurements
    .map((metric) => metric?.metric_id)
    .filter((metricId) => typeof metricId === "string" && metricId.length > 0))]
    .sort(stableCompare);
  const refs = [...new Set(measurements.flatMap((metric) => [
    ...(Array.isArray(metric?.source?.artifact_refs) ? metric.source.artifact_refs : []),
    ...(Array.isArray(metric?.source?.evidence_refs) ? metric.source.evidence_refs : []),
  ]).filter((reference) => typeof reference === "string" && reference.length > 0))]
    .sort(stableCompare);
  return { metric_ids: metricIds, refs };
}

function heuristicRiskModel(repositoryRevision, hotspots, bindings) {
  const riskModelId = "heuristic-v1";
  return {
    risk_model_id: riskModelId,
    model_version: "1.0.0",
    model_contract_hash: deriveRiskModelContractHash(riskModelId),
    model_status: "heuristic",
    calibration: null,
    result: {
      result_id: `${riskModelId}:${repositoryRevision}`,
      kind: "heuristic_hotspot_vectors",
      status: "available",
      repository_revision: repositoryRevision,
      evidence_metric_ids: bindings.metric_ids,
      evidence_refs: bindings.refs,
      interpretation_boundary: hotspots.interpretation_boundary,
      records: hotspots.features.map((feature) => ({
        subject: feature.subject,
        features: feature.vector,
        hotspot_signals: feature.hotspot_signals,
      })),
    },
  };
}

function temporalCouplingRiskModel(repositoryRevision, relationships, bindings, massChangePolicy) {
  const riskModelId = "temporal-coupling-pressure-v1";
  return {
    risk_model_id: riskModelId,
    model_version: "1.0.0",
    model_contract_hash: deriveRiskModelContractHash(riskModelId),
    model_status: "heuristic",
    calibration: null,
    result: {
      result_id: `${riskModelId}:${repositoryRevision}`,
      kind: "temporal_coupling_pressure",
      status: "available",
      repository_revision: repositoryRevision,
      evidence_metric_ids: bindings.metric_ids,
      evidence_refs: bindings.refs,
      interpretation_boundary: "source-bound co-change pressure only; not a defect probability or candidate priority",
      records: structuredClone(relationships),
      mass_change_policy: structuredClone(massChangePolicy),
    },
  };
}

function configurationHashFromMeasurements(measurements) {
  const configurationHashes = [...new Set((Array.isArray(measurements) ? measurements : [])
    .map((metric) => metric?.comparability?.configuration_hash)
    .filter((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)))];
  if (configurationHashes.length !== 1) {
    throw new Error("FAIL-CLI-COLLECTION: collectors did not agree on one configuration hash");
  }
  return configurationHashes[0];
}

function composeAdapterEvidence(config, repository, historyWindow, localEvidence, configPath, discovery) {
  // Existing external adapters remain normalized only.  V2 additionally
  // accepts a small, explicit local JUnit/LCOV format set and immediately
  // normalizes it into the same closed verification-summary envelope.
  // A non-current historical boundary cannot meet M4's exact revision-bound
  // envelope contract, so an omitted adapter configuration remains explicitly
  // unavailable through the existing capability records; a supplied one fails
  // before output rather than being rebound or guessed.
  const configurationHash = configurationHashFromMeasurements(localEvidence.metrics);
  if (!discovery || typeof discovery !== "object" || !Array.isArray(discovery.collectors) || !Array.isArray(discovery.metrics)) {
    throw new Error("FAIL-CLI-COLLECTION: indexed verification discovery did not return a closed result");
  }
  const hasInternalDependencyTopology = localEvidence.collectors.some((collector) => collector.collector_id === "python-static-intelligence")
    && localEvidence.metrics.some((metric) => metric.family === "dependency_topology");
  const hasExternalDependencyTopology = (config.adapter_evidence?.adapters ?? []).some((adapter) => (
    adapter?.adapter_id === "dependency-topology" || adapter?.kind === "dependency_topology"
  ));
  if (hasInternalDependencyTopology && hasExternalDependencyTopology) {
    throw new Error("FAIL-CLI-COLLECTION: internal Python dependency topology and external dependency topology scope overlap");
  }
  const collectorIds = new Set(localEvidence.collectors.map((collector) => collector.collector_id));
  const metricIds = new Set(localEvidence.metrics.map((metric) => metric.metric_id));
  const metricById = new Map(localEvidence.metrics.map((metric) => [metric.metric_id, metric]));
  const evidenceRank = (record) => {
    const status = record?.measurement?.status ?? record?.status;
    return status === "measured" || status === "available" ? 3 : status === "inferred" || status === "degraded" ? 2 : 1;
  };
  function claimRecords(records) {
    const acceptedMetrics = [];
    for (const collector of records.collectors) {
      if (collectorIds.has(collector.collector_id)) {
        throw new Error(`FAIL-CLI-COLLECTION: adapter collector duplicates ${collector.collector_id}`);
      }
      collectorIds.add(collector.collector_id);
    }
    for (const metric of records.metrics) {
      if (metricIds.has(metric.metric_id)) {
        const prior = metricById.get(metric.metric_id);
        // Internal autonomous probes are allowed to replace the older
        // unavailable adapter placeholder for the same semantic fact.  A
        // second observed/inferred producer remains an ownership conflict.
        if (evidenceRank(prior) > evidenceRank(metric)
            || (evidenceRank(prior) === evidenceRank(metric) && evidenceRank(metric) === 1)) continue;
        throw new Error(`FAIL-CLI-COLLECTION: adapter metric duplicates ${metric.metric_id}`);
      }
      metricIds.add(metric.metric_id);
      metricById.set(metric.metric_id, metric);
      acceptedMetrics.push(metric);
    }
    return acceptedMetrics;
  }
  const discoveredMetrics = claimRecords(discovery);
  const discoveredEvidence = {
    ...localEvidence,
    collectors: [...localEvidence.collectors, ...discovery.collectors],
    capabilities: [...(localEvidence.capabilities ?? []), ...structuredClone(discovery.collectors)],
    metrics: [...localEvidence.metrics, ...discoveredMetrics],
  };
  if (historyWindow.end !== repository.revision) {
    if (config.adapter_evidence !== undefined || config.verification_artifacts !== undefined) {
      throw new Error("FAIL-CLI-CONFIG: adapter evidence requires history_window.end to equal the resolved repository revision");
    }
    return {
      ...discoveredEvidence,
      collectors: discoveredEvidence.collectors.sort((left, right) => stableCompare(left.collector_id, right.collector_id)),
      capabilities: discoveredEvidence.capabilities.sort((left, right) => stableCompare(left.collector_id, right.collector_id)),
      metrics: discoveredEvidence.metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id)),
    };
  }
  const adapters = structuredClone(config.adapter_evidence?.adapters ?? []);
  if (config.verification_artifacts !== undefined) {
    adapters.push(buildVerificationArtifactEnvelope({
      base_directory: path.dirname(configPath),
      repository_revision: repository.revision,
      configuration_hash: configurationHash,
      history_window: historyWindow,
      ...config.verification_artifacts,
    }));
  }
  const hasExplicitVerificationSummary = adapters.some((adapter) => (
    adapter?.adapter_id === "verification-summary" || adapter?.kind === "verification_summary"
  ));
  if (!hasExplicitVerificationSummary && discovery.verification_summary !== null) {
    adapters.push(discovery.verification_summary);
  }
  const collectedAdapterEvidence = collectAdapterEvidence({
    repository_revision: repository.revision,
    configuration_hash: configurationHash,
    history_window: historyWindow,
    adapters,
  });
  const adapterEvidence = hasInternalDependencyTopology
    ? {
        ...collectedAdapterEvidence,
        collectors: collectedAdapterEvidence.collectors.filter((collector) => collector.collector_id !== "dependency-topology"),
        capabilities: (collectedAdapterEvidence.capabilities ?? collectedAdapterEvidence.collectors)
          .filter((collector) => collector.collector_id !== "dependency-topology"),
        metrics: collectedAdapterEvidence.metrics.filter((metric) => metric.source?.collector_id !== "dependency-topology"),
      }
    : collectedAdapterEvidence;
  const acceptedAdapterMetrics = claimRecords(adapterEvidence);
  return {
    ...discoveredEvidence,
    collectors: [...discoveredEvidence.collectors, ...adapterEvidence.collectors]
      .sort((left, right) => stableCompare(left.collector_id, right.collector_id)),
    capabilities: [...discoveredEvidence.capabilities, ...structuredClone(adapterEvidence.collectors)]
      .sort((left, right) => stableCompare(left.collector_id, right.collector_id)),
    metrics: [...discoveredEvidence.metrics, ...acceptedAdapterMetrics]
      .sort((left, right) => stableCompare(left.metric_id, right.metric_id)),
  };
}

function buildSnapshotDraft(repository, config, evidence, phaseRecorder = null) {
  const measure = (field, work) => phaseRecorder === null ? work() : phaseRecorder.measureSync(field, work);
  return measure("snapshot_draft_ms", () => {
    const configurationHash = configurationHashFromMeasurements(evidence.metrics);
    const repositoryIdentity = deriveCanonicalRepositoryIdentity({
      repository_root: repository.root,
      repository_revision: repository.revision,
      repository_id: config.repository_id,
    });
    const localRepositorySubject = `repository:${repository.root.replaceAll("\\", "/")}`;
    const measurements = evidence.metrics.map((metric) => (
      metric.subject === localRepositorySubject
        ? { ...metric, subject: `repository:${repositoryIdentity}` }
        : metric
    ));
    const historyBoundary = structuredClone(
      evidence.git.metrics[0]?.window ?? { kind: "revision-range", start: null, end: repository.revision },
    );
    const massChangePolicy = evidence.git?.temporal_coupling?.mass_change_policy;
    if (!isRecord(massChangePolicy)) {
      throw new Error("FAIL-CLI-COLLECTION: git collection did not return a mass-change policy receipt");
    }
    const draft = {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      snapshot_id: "pending",
      repository: {
        repository_id: repositoryIdentity,
        revision: repository.revision,
        configuration_hash: configurationHash,
        history_boundary: historyBoundary,
        generated_path_patterns: normalizedPatterns(config.generated_path_patterns),
      },
      collectors: evidence.collectors,
      measurements,
      risk_models: [],
      profiles: [],
      evidence_summary: statusSummary(measurements),
      run_metadata: { generated_at: repository.generatedAt, cache: {} },
    };
    const hotspots = deriveHotspots(draft);
    const riskBindings = riskEvidenceBindings(draft.measurements);
    draft.risk_models = [
      heuristicRiskModel(repository.revision, hotspots, riskBindings),
      temporalCouplingRiskModel(repository.revision, evidence.relationships, riskBindings, massChangePolicy),
      buildInvestigationSignalRiskModel(draft),
    ];
    draft.profiles = Object.values(evaluateProfiles(draft, config.profile_bindings)).sort((left, right) => stableCompare(left.profile_id, right.profile_id));
    return draft;
  });
}

function bindTrendToSnapshotDraft(draft, trendBinding) {
  const bindingCount = trendBinding.baseline === null
    ? 0
    : attachCanonicalBaselineBindings(draft, trendBinding.baseline, trendBinding.binding_kind);
  draft.run_metadata.trend_baseline = {
    binding_kind: trendBinding.binding_kind,
    status: trendBinding.status,
    eligible: trendBinding.status === "established" ? trendBinding.eligible : bindingCount > 0,
    baseline_snapshot_id: trendBinding.baseline?.snapshot_id ?? null,
    baseline_repository_revision: trendBinding.baseline?.repository?.revision ?? null,
    compatible_metric_count: bindingCount,
    historical_context: trendBinding.historical_context ?? null,
    reason: trendBinding.reason,
  };
  return draft;
}

function serializedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function noBaselineComparisonReceipt(currentSnapshot, trendBinding) {
  const reason = trendBinding.reason;
  const receipt = {
    baseline_source: "automatic",
    baseline_status: "established",
    baseline_eligible: currentSnapshot.run_metadata.trend_baseline.eligible,
    baseline_snapshot_id: null,
    baseline_repository_revision: null,
    label: "insufficient-history",
    reason,
    trend: {
      status: "insufficient_history",
      previous_snapshot_id: null,
      current_snapshot_id: currentSnapshot.snapshot_id,
      reason,
      trends: [],
    },
  };
  if (trendBinding.historical_context !== null && trendBinding.historical_context !== undefined) {
    receipt.historical_context = structuredClone(trendBinding.historical_context);
  }
  return receipt;
}

function resolveHistoryWindow(config, repository) {
  const configured = config.history_window ?? {};
  const kind = configured.kind ?? "revision-range";
  const autoRoot = kind === "revision-range" && (configured.start === undefined || configured.start === null);
  const start = autoRoot ? resolveStableHistoryRoot(repository.root, repository.revision) : configured.start ?? null;
  const window = {
    kind,
    // A null revision-range start requests the complete locally observable
    // history. Anchor it at its sole root so an explicit baseline can bind the
    // same boundary; the private collector flag retains that root commit.
    start,
    end: configured.end ?? repository.revision,
  };
  return {
    window,
    collectorWindow: autoRoot ? { ...window, auto_root_inclusive: true } : window,
  };
}

function comparisonReceipt(previousSnapshot, currentSnapshot, baselineSource, baselineStatus) {
  const trend = compareSnapshots(previousSnapshot, currentSnapshot, { require_explicit_baseline: true });
  const baselineReceipt = {
    baseline_source: baselineSource,
    baseline_status: baselineStatus,
    baseline_eligible: currentSnapshot.run_metadata.trend_baseline.eligible,
    baseline_snapshot_id: previousSnapshot.snapshot_id,
    baseline_repository_revision: previousSnapshot.repository.revision,
  };
  const comparableRecords = trend.trends.filter((record) => record.status === "comparable");
  if (trend.status === "comparable" && comparableRecords.every((record) => record.delta === 0)) {
    return { ...baselineReceipt, label: "stable", reason: null, trend };
  }
  if ((trend.status === "comparable" || trend.status === "mixed") && comparableRecords.length > 0) {
    return {
      ...baselineReceipt,
      // `label` is a directional presentation conclusion. Compatibility is
      // evidence-bound, but the current SEI contract deliberately has no
      // directional interpretation mapping for nonzero factual deltas.
      // Keeping that label null is not an incomparability claim; the separate
      // fields make the usable factual comparison explicit without inventing
      // an improving/worsening conclusion outside a declared contract.
      label: null,
      compatibility: "comparable",
      direction: "unassigned",
      reason: comparableRecords.some((record) => record.delta !== 0)
        ? "canonical snapshots contain compatible factual deltas but no directional interpretation contract is declared"
        : "canonical snapshots contain compatible observations but incomplete history has no directional interpretation contract",
      trend,
    };
  }
  if (trend.status === "incomparable" || trend.status === "mixed") {
    return {
      ...baselineReceipt,
      label: "incomparable",
      reason: trend.reason ?? "at least one metric lacks a compatible explicit baseline binding",
      trend,
    };
  }
  if (trend.status === "insufficient_history") {
    return {
      ...baselineReceipt,
      label: "insufficient-history",
      reason: "the explicit baseline has no compatible prior metric observations",
      trend,
    };
  }
  throw new Error("FAIL-CLI-COMPARISON: trend result did not contain a reportable comparison state");
}

function sameRevisionPriorAssessment(candidates, snapshot) {
  if (!Array.isArray(candidates) || !isRecord(snapshot)) return null;
  const ordered = [...candidates].sort((left, right) => stableCompare(left.path, right.path));
  for (const candidate of ordered) {
    const assessment = candidate?.assessment;
    if (!isRecord(assessment)
        || !new Set(["sei.engineering-assessment@2", engineeringAssessment.ASSESSMENT_SCHEMA_VERSION]).has(assessment.schema_version)
        || assessment.snapshot_binding?.snapshot_id !== snapshot.snapshot_id
        || assessment.snapshot_binding?.repository_id !== snapshot.repository?.repository_id
        || assessment.snapshot_binding?.repository_revision !== snapshot.repository?.revision
        || assessment.snapshot_binding?.configuration_hash !== snapshot.repository?.configuration_hash) continue;
    const validation = engineeringAssessment.validateAssessment(assessment, snapshot);
    if (validation.ok) return assessment;
  }
  return null;
}

function cacheArtifactPath(out, snapshot) {
  return path.join(out, "cache", snapshot.run_metadata.cache.cache_key, `${snapshot.snapshot_id}.json`);
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function exactConfigurationBytes(configPath) {
  return fs.readFileSync(configPath);
}

function configuredExternalInputBindings(config, configPath) {
  const declarations = config.verification_artifacts?.artifacts ?? [];
  return declarations.map((declaration) => {
    const resolved = path.resolve(path.dirname(configPath), declaration.path);
    const stats = fs.lstatSync(resolved);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`FAIL-CLI-CONFIG: verification artifact must be a regular non-symlink file at ${resolved}`);
    }
    const bytes = fs.readFileSync(resolved);
    return {
      format: declaration.format,
      canonical_path: resolved,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
    };
  }).sort((left, right) => stableCompare(left.canonical_path, right.canonical_path));
}

function forwardTemporalBundleInputBinding(bundlePath) {
  if (bundlePath === null) return [];
  let stats;
  let realPath;
  let bytes;
  try {
    stats = fs.lstatSync(bundlePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 256 * 1024) {
      throw new Error("bundle must be a bounded regular non-symlink file");
    }
    realPath = fs.realpathSync.native(bundlePath);
    bytes = fs.readFileSync(realPath);
  } catch (error) {
    throw new Error(`FAIL-CLI-FORWARD-TEMPORAL: bundle cannot be bound (${error.code ?? error.message})`);
  }
  if (bytes.length !== stats.size) throw new Error("FAIL-CLI-FORWARD-TEMPORAL: bundle changed while its immutable input binding was read");
  return [{
    format: "sei.forward-temporal-bundle@1",
    canonical_path: realPath,
    size: bytes.length,
    sha256: sha256Bytes(bytes),
  }];
}

function assertStrictPriorForwardTemporalBundle(repositoryRoot, binding, snapshot) {
  const receipt = forwardTemporalPrivate.projectBoundForwardTemporalReceiptSummary(binding);
  const priorRevision = receipt.final_revision;
  const currentRevision = snapshot.repository.revision;
  if (priorRevision === currentRevision) {
    throw new Error("FAIL-CLI-FORWARD-TEMPORAL-PRIOR: historical predictive evidence must end at a strict ancestor of the current repository revision");
  }
  const ancestor = inspectGit(repositoryRoot, ["merge-base", "--is-ancestor", priorRevision, currentRevision]);
  if (ancestor.error || ancestor.status !== 0) {
    throw new Error("FAIL-CLI-FORWARD-TEMPORAL-PRIOR: historical predictive evidence final revision is not a strict ancestor of the current repository revision");
  }
  const distance = inspectGit(repositoryRoot, ["rev-list", "--count", `${priorRevision}..${currentRevision}`]);
  const count = Number(distance.stdout?.trim());
  if (distance.error || distance.status !== 0 || !Number.isSafeInteger(count) || count <= 0) {
    throw new Error("FAIL-CLI-FORWARD-TEMPORAL-PRIOR: historical predictive evidence does not have a verified positive revision distance to the current repository revision");
  }
}

const EXECUTION_CONTRACT_AUXILIARY_PATHS = Object.freeze([
  "analyzers/JavaAstAnalyzer.java",
  "analyzers/python-ast.py",
  "analyzers/tsjs-analyzer.js",
  "intelligence.schema.json",
  "product/report-template.html",
]);

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Shared packages the skill manifest declares as runtime dependencies
// (software-engineering-intelligence/MANIFEST.json depends_on). Modules the CLI
// graph loads from them (report.js -> report-presentation, cli.js ->
// project-intelligence-workspace) change rendered/published bytes, so they
// belong to the replay contract just like engine modules.
function executionContractDependencyRoots(layout) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(layout.package_root, "MANIFEST.json"), "utf8"));
  } catch (error) {
    throw new Error(`FAIL-CLI-COLLECTION: execution contract could not read the skill manifest (${error.code ?? error.message})`);
  }
  const declared = manifest?.depends_on;
  if (!Array.isArray(declared) || declared.some((entry) => typeof entry !== "string" || !/^shared\/[a-z0-9][a-z0-9-]*$/.test(entry))) {
    throw new Error("FAIL-CLI-COLLECTION: execution contract requires a closed shared/<package> depends_on list in the skill manifest");
  }
  return declared.map((entry) => {
    const candidate = path.join(layout.canonical_root, ...entry.split("/"));
    try {
      return fs.realpathSync.native(candidate);
    } catch (error) {
      throw new Error(`FAIL-CLI-COLLECTION: declared dependency ${entry} is unavailable (${error.code ?? error.message})`);
    }
  });
}

function executionContractPaths() {
  const root = fs.realpathSync.native(__dirname);
  const dependencyRoots = executionContractDependencyRoots(resolveSeiLayout());
  const discovered = new Set();
  const visit = (moduleRecord) => {
    if (moduleRecord === null || typeof moduleRecord !== "object" || typeof moduleRecord.filename !== "string") return;
    const filename = path.resolve(moduleRecord.filename);
    if (!isContainedPath(root, filename) && !dependencyRoots.some((dependencyRoot) => isContainedPath(dependencyRoot, filename))) return;
    const relative = path.relative(root, filename);
    if (!relative.endsWith(".js") && !relative.endsWith(".json")) return;
    const canonicalRelative = relative.split(path.sep).join("/");
    if (discovered.has(canonicalRelative)) return;
    discovered.add(canonicalRelative);
    for (const child of moduleRecord.children ?? []) visit(child);
  };
  visit(require.cache[__filename] ?? null);
  if (!discovered.has("cli.js")) {
    throw new Error("FAIL-CLI-COLLECTION: execution contract could not resolve the CLI module graph");
  }
  for (const relativePath of EXECUTION_CONTRACT_AUXILIARY_PATHS) discovered.add(relativePath);
  return Object.freeze([...discovered].sort(stableCompare));
}

function executionContractHash() {
  const layout = resolveSeiLayout();
  const root = __dirname;
  const bindings = executionContractPaths().map((relativePath) => ({
    relative_path: relativePath,
    sha256: sha256Bytes(fs.readFileSync(
      relativePath === "product/report-template.html" ? layout.template_path : path.join(root, ...relativePath.split("/")),
    )),
  }));
  return sha256Bytes(Buffer.from(JSON.stringify(bindings), "utf8"));
}

function pythonRuntimeIdentity(runtime) {
  if (runtime.executable === null) {
    return { status: "unavailable", executable: null, identity: null, source: runtime.source };
  }
  const resolved = path.resolve(runtime.executable);
  let executableBinding;
  try {
    const stats = fs.lstatSync(resolved);
    if (!stats.isFile() || stats.isSymbolicLink()) throw Object.assign(new Error("not a regular file"), { code: "NOT_REGULAR" });
    const bytes = fs.readFileSync(resolved);
    executableBinding = { path: fs.realpathSync.native(resolved), size: bytes.length, sha256: sha256Bytes(bytes) };
  } catch (error) {
    return {
      status: "unavailable",
      executable: resolved,
      source: runtime.source,
      identity: { availability: "unavailable", error_code: error.code ?? "UNREADABLE" },
    };
  }
  const result = spawnSync(executableBinding.path, [
    "-I", "-S", "-c",
    "import json,sys; print(json.dumps({'implementation':sys.implementation.name,'version':list(sys.version_info[:3]),'cache_tag':sys.implementation.cache_tag},sort_keys=True,separators=(',',':')))",
  ], { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 });
  if (result.error || result.status !== 0) {
    return {
      status: "unavailable",
      executable: executableBinding.path,
      source: runtime.source,
      identity: {
        availability: "unavailable",
        error_code: result.error?.code ?? `EXIT_${result.status}`,
        executable: executableBinding,
      },
    };
  }
  let identity;
  try { identity = JSON.parse(result.stdout); } catch {
    throw new Error("FAIL-CLI-COLLECTION: exact Python runtime identity was malformed");
  }
  return {
    status: "candidate",
    executable: executableBinding.path,
    source: runtime.source,
    identity: { ...identity, executable: executableBinding },
  };
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(stableCompare).map((key) => [key, canonicalJsonValue(value[key])]));
  }
  return value;
}

// The loaded --assessment-config profile is part of the replay identity: a
// changed coverage gate, standard, or target policy must never replay an
// assessment produced under a different profile. null means "no profile".
function assessmentConfigDigest(assessmentConfig) {
  return assessmentConfig === null || assessmentConfig === undefined
    ? null
    : sha256Bytes(Buffer.from(JSON.stringify(canonicalJsonValue(assessmentConfig)), "utf8"));
}

function incrementalSessionInput({
  options,
  repository,
  assessmentConfig,
  repositoryIndex,
  resolvedRepositoryId,
  configurationHash,
  config,
  explicitBaseline,
  forwardTemporalBundleBinding,
  historyWindow,
  stateRoot,
  pythonRuntime,
  sourceTreeClean,
  signal,
}) {
  return {
    output_root: options.out,
    state_root: stateRoot,
    performance_output_path: options.performanceJson,
    repository: {
      repository_id: resolvedRepositoryId,
      revision: repository.revision,
      root_tree_oid: repositoryIndex.binding.root_tree_oid,
      object_format: repositoryIndex.binding.object_format,
    },
    repository_index_binding: Object.fromEntries(Object.entries(repositoryIndex.binding).filter(([key]) => key !== "cache")),
    collector_configuration_hash: configurationHash,
    history_window: historyWindow,
    config_bytes_sha256: sha256Bytes(exactConfigurationBytes(options.config)),
    assessment_config_sha256: assessmentConfigDigest(assessmentConfig),
    external_input_bindings: [
      ...configuredExternalInputBindings(config, options.config),
      ...forwardTemporalBundleBinding,
    ].sort((left, right) => stableCompare(left.canonical_path, right.canonical_path)),
    explicit_baseline_binding: explicitBaseline === null ? null : {
      snapshot_id: explicitBaseline.snapshot_id,
      sha256: sha256Bytes(Buffer.from(serializedJson(explicitBaseline), "utf8")),
    },
    automatic_baseline_inventory_binding: incrementalStatePrivate.automaticBaselineInventoryBinding(options.out, [], stateRoot),
    runtime_binding: {
      node: { version: process.version, platform: process.platform, architecture: process.arch },
      git: { version: runGit(repository.root, ["--version"]), object_format: repositoryIndex.binding.object_format },
      python: pythonRuntimeIdentity(pythonRuntime),
    },
    execution_contract_hash: executionContractHash(),
    source_tree_clean: sourceTreeClean,
    mode: "auto",
    ...(signal === undefined ? {} : { signal }),
  };
}

function inspectGit(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function selectStaticDependencyBaseline(repository, repositoryIndex, repositoryIdValue, stages) {
  const candidates = [];
  for (const stage of stages) {
    let document;
    let snapshot;
    try {
      document = incrementalStatePrivate.readStage(stage, "static");
      snapshot = incrementalStatePrivate.readStaticDependencySnapshot(stage);
    } catch {
      continue;
    }
    if (snapshot === null || document.binding.repository_id !== repositoryIdValue
        || snapshot.repositoryIndex.binding.object_format !== repositoryIndex.binding.object_format) continue;
    const priorRevision = snapshot.repositoryIndex.binding.repository_revision;
    const currentRevision = repositoryIndex.binding.repository_revision;
    let relationship;
    let distance;
    if (priorRevision === currentRevision) {
      relationship = "same-revision";
      distance = 0;
    } else {
      const ancestry = inspectGit(repository.root, ["merge-base", "--is-ancestor", priorRevision, currentRevision]);
      if (ancestry.error || ancestry.status !== 0) continue;
      const count = inspectGit(repository.root, ["rev-list", "--count", `${priorRevision}..${currentRevision}`]);
      if (count.error || count.status !== 0 || !/^\d+$/.test(count.stdout.trim())) continue;
      distance = Number(count.stdout.trim());
      if (!Number.isSafeInteger(distance) || distance <= 0) continue;
      relationship = "strict-ancestor";
    }
    candidates.push({
      snapshot,
      relationship,
      distance,
      digest: document.artifact_sha256,
      priorRevision,
      currentRevision,
    });
  }
  candidates.sort((left, right) => left.distance - right.distance
    || stableCompare(left.priorRevision, right.priorRevision)
    || stableCompare(left.digest, right.digest));
  const selected = candidates[0];
  if (!selected) return null;
  const evidenceDigest = sha256Bytes(Buffer.from(JSON.stringify({
    command: "git merge-base --is-ancestor; git rev-list --count",
    current_repository_revision: selected.currentRevision,
    distance: selected.distance,
    prior_repository_revision: selected.priorRevision,
    relationship: selected.relationship,
  }), "utf8"));
  return Object.freeze({
    prior_snapshot: selected.snapshot,
    ancestry_binding: dependencyInvalidationPrivate.createTrustedAncestryBinding({
      priorRepositoryIndex: selected.snapshot.repositoryIndex,
      currentRepositoryIndex: repositoryIndex,
      relationship: selected.relationship,
      evidenceDigest,
    }),
  });
}

function staticAnalysisCacheRoot(out, repositoryIdValue) {
  const repositoryKey = crypto.createHash("sha256").update(repositoryIdValue).digest("hex");
  return path.join(out, "static-analysis-cache", repositoryKey);
}

function pythonAnalyzerCacheRoot(out, repositoryIdValue) {
  return path.resolve(staticAnalysisCacheRoot(out, repositoryIdValue), "python-ast-v1");
}

function pythonAnalyzerCachePath(root, key) {
  if (typeof key !== "string" || !/^sha256:[0-9a-f]{64}$/.test(key)) {
    throw new Error("FAIL-CLI-COLLECTION: Python analyzer cache key must be an exact lowercase sha256 identity");
  }
  const candidate = path.resolve(root, `${key.slice("sha256:".length)}.json`);
  const relative = path.relative(root, candidate);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("FAIL-CLI-COLLECTION: Python analyzer cache key escaped its repository-specific root");
  }
  return candidate;
}

function checkCacheSignal(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Python analyzer cache operation was cancelled");
}

function createBufferedPythonAnalyzerCache(out, repositoryIdValue) {
  const root = pythonAnalyzerCacheRoot(out, repositoryIdValue);
  const pending = new Map();
  let pendingBytes = 0;
  const cache = {
    async read(key, { signal } = {}) {
      checkCacheSignal(signal);
      const filePath = pythonAnalyzerCachePath(root, key);
      const buffered = pending.get(key);
      if (buffered !== undefined) return Buffer.from(buffered);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      if (!stat.isFile() || stat.size > MAX_PYTHON_ANALYZER_CACHE_BYTES) {
        throw new Error("Python analyzer cache entry is not a bounded regular file");
      }
      const bytes = fs.readFileSync(filePath);
      checkCacheSignal(signal);
      return bytes;
    },
    async create(key, bytes, { signal } = {}) {
      checkCacheSignal(signal);
      const filePath = pythonAnalyzerCachePath(root, key);
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_PYTHON_ANALYZER_CACHE_BYTES) {
        throw new Error("Python analyzer cache publication requires bounded non-empty canonical bytes");
      }
      if (pending.has(key) || fs.existsSync(filePath)) {
        checkCacheSignal(signal);
        return "exists";
      }
      if (pending.size >= MAX_PYTHON_ANALYZER_CACHE_ENTRIES
          || pendingBytes + bytes.length > MAX_PYTHON_ANALYZER_CACHE_BUFFER_BYTES) {
        throw new Error("Python analyzer cache buffer reached its bounded publication envelope");
      }
      pending.set(key, Buffer.from(bytes));
      pendingBytes += bytes.length;
      checkCacheSignal(signal);
      return "created";
    },
  };
  return {
    cache,
    artifacts() {
      return [...pending.entries()]
        .sort(([left], [right]) => stableCompare(left, right))
        .map(([key, bytes]) => ({
          label: `PYTHON_STATIC_CACHE_${key.slice("sha256:".length)}`,
          path: pythonAnalyzerCachePath(root, key),
          bytes: bytes.toString("utf8"),
        }));
    },
  };
}

function staticAnalysisCachePointerPath(out, repositoryIdValue) {
  return path.join(staticAnalysisCacheRoot(out, repositoryIdValue), "latest.json");
}

function readPriorStaticAnalysisSnapshot(out, repositoryIdValue, phaseRecorder = null) {
  const pointerPath = staticAnalysisCachePointerPath(out, repositoryIdValue);
  let pointer;
  try {
    pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(pointer) ||
    Object.keys(pointer).some((key) => !["schema_version", "repository_id", "snapshot_id"].includes(key)) ||
    pointer.schema_version !== STATIC_ANALYSIS_CACHE_SCHEMA_VERSION ||
    pointer.repository_id !== repositoryIdValue ||
    typeof pointer.snapshot_id !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(pointer.snapshot_id)
  ) {
    return null;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(path.join(out, "snapshots", `${pointer.snapshot_id}.json`), "utf8"));
  } catch {
    return null;
  }
  let validation;
  try {
    validation = phaseRecorder === null
      ? validateSnapshot(snapshot)
      : intelligenceEnginePrivate.validateSnapshotWithTelemetry(snapshot, {}, phaseRecorder.instrumentation);
  } catch {
    return null;
  }
  if (!validation.ok || snapshot.snapshot_id !== pointer.snapshot_id || snapshot.repository?.repository_id !== repositoryIdValue) {
    return null;
  }
  return snapshot;
}

function writeStaticAnalysisCachePointer(out, snapshot) {
  const repositoryIdValue = snapshot?.repository?.repository_id;
  if (typeof repositoryIdValue !== "string" || repositoryIdValue.length === 0 || typeof snapshot?.snapshot_id !== "string") return;
  const pointerPath = staticAnalysisCachePointerPath(out, repositoryIdValue);
  const pointer = {
    schema_version: STATIC_ANALYSIS_CACHE_SCHEMA_VERSION,
    repository_id: repositoryIdValue,
    snapshot_id: snapshot.snapshot_id,
  };
  let temporaryPath = null;
  try {
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    temporaryPath = `${pointerPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, serializedJson(pointer), { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, pointerPath);
  } catch {
    // This mutable performance hint is never required for canonical output.
    if (temporaryPath !== null) {
      try { fs.unlinkSync(temporaryPath); } catch { /* cache cleanup is best effort */ }
    }
  }
}

function validatedCachedArtifact(cachePath, expectedArtifact, sourceTreeClean, phaseRecorder = null) {
  if (!sourceTreeClean || !fs.existsSync(cachePath)) return null;
  let candidateBytes;
  let candidate;
  try {
    candidateBytes = fs.readFileSync(cachePath, "utf8");
    candidate = JSON.parse(candidateBytes);
  } catch {
    return null;
  }
  let candidateArtifact;
  try {
    candidateArtifact = intelligenceEnginePrivate.canonicalArtifactFromSnapshot(
      candidate,
      phaseRecorder?.instrumentation ?? null,
    );
  } catch {
    return null;
  }
  const expected = intelligenceEnginePrivate.readCanonicalArtifact(expectedArtifact);
  const cached = intelligenceEnginePrivate.readCanonicalArtifact(candidateArtifact);
  const matches =
    cached.snapshot.run_metadata.cache.cache_key === expected.snapshot.run_metadata.cache.cache_key &&
    cached.snapshot.snapshot_id === expected.snapshot.snapshot_id &&
    cached.snapshot_json === expected.snapshot_json &&
    candidateBytes === expected.snapshot_json;
  return matches ? candidateArtifact : null;
}

function artifactStat(filePath) {
  try {
    return fs.statSync(filePath, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertArtifactParent(filePath, label) {
  let current = path.dirname(filePath);
  while (true) {
    const stat = artifactStat(current);
    if (stat) {
      if (!stat.isDirectory()) {
        throw new Error(`FAIL-CLI-OUTPUT: ${label} parent is not a directory at ${current}`);
      }
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`FAIL-CLI-OUTPUT: ${label} has no writable directory ancestor`);
    }
    current = parent;
  }
}

function assertImmutableArtifact(artifact) {
  const stat = artifactStat(artifact.path);
  if (!stat) return false;
  if (!stat.isFile()) {
    throw new Error(`FAIL-IMMUTABLE-${artifact.label}: existing artifact target is not a file at ${artifact.path}`);
  }
  let bytes;
  try {
    bytes = fs.readFileSync(artifact.path, "utf8");
  } catch (error) {
    throw new Error(`FAIL-IMMUTABLE-${artifact.label}: cannot read existing artifact at ${artifact.path}: ${error.code ?? error.message}`);
  }
  if (bytes !== artifact.bytes) {
    throw new Error(`FAIL-IMMUTABLE-${artifact.label}: existing artifact bytes differ at ${artifact.path}`);
  }
  return true;
}

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sharesCanonicalSnapshotStorage(left, right) {
  return new Set([left.label, right.label]).size === 2
    && new Set([left.label, right.label]).has("SNAPSHOT")
    && new Set([left.label, right.label]).has("CACHE")
    && left.bytes === right.bytes;
}

function canonicalSnapshotStoragePair(artifacts) {
  const snapshots = artifacts.filter((artifact) => artifact.label === "SNAPSHOT");
  const caches = artifacts.filter((artifact) => artifact.label === "CACHE");
  if (snapshots.length !== 1 || caches.length !== 1
      || !sharesCanonicalSnapshotStorage(snapshots[0], caches[0])) return null;
  return new Set([snapshots[0], caches[0]]);
}

function belongsToCanonicalSnapshotStoragePair(pair, left, right) {
  return pair !== null && pair.has(left) && pair.has(right);
}

function assertNoArtifactAliases(artifacts) {
  const canonicalStoragePair = canonicalSnapshotStoragePair(artifacts);
  const byPath = new Map();
  const byFileIdentity = new Map();
  for (const artifact of artifacts) {
    const canonical = canonicalPath(artifact.path);
    const pathOwner = byPath.get(canonical);
    if (pathOwner) {
      throw new Error(`FAIL-ARTIFACT-ALIAS: ${pathOwner.label} and ${artifact.label} resolve to the same path`);
    }
    byPath.set(canonical, artifact);
    const stat = artifactStat(artifact.path);
    if (stat) {
      const identity = `${stat.dev}:${stat.ino}`;
      const identityOwner = byFileIdentity.get(identity);
      if (identityOwner && !belongsToCanonicalSnapshotStoragePair(canonicalStoragePair, identityOwner, artifact)) {
        throw new Error(`FAIL-ARTIFACT-ALIAS: ${identityOwner.label} and ${artifact.label} refer to the same file`);
      }
      byFileIdentity.set(identity, artifact);
    }
  }
}

function preflightArtifacts(artifacts) {
  artifacts.forEach((artifact) => assertArtifactParent(artifact.path, artifact.label));
  assertNoArtifactAliases(artifacts);
  const existingByPath = new Map(artifacts.map((artifact) => [artifact.path, assertImmutableArtifact(artifact)]));
  const existingCount = [...existingByPath.values()].filter(Boolean).length;
  return {
    existingByPath,
    telemetry: {
      planned_count: artifacts.length,
      planned_bytes: artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.bytes), 0),
      existing_count: existingCount,
      pending_count: artifacts.length - existingCount,
    },
  };
}

function cleanupStageEntries(entries) {
  const paths = new Set();
  const directories = new Set();
  for (const entry of entries) {
    if (!entry.ownsStage || paths.has(entry.stagePath)) continue;
    paths.add(entry.stagePath);
    directories.add(entry.stageDirectory);
    try { fs.unlinkSync(entry.stagePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const directory of directories) {
    try { fs.rmdirSync(directory); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
}

function shortStagePrefix(targetPath) {
  const targetDirectory = path.dirname(targetPath);
  // Staging beside the destination is both writable under ordinary user permissions and
  // guaranteed to be on the same volume, which is required for the hard-link publication.
  return path.join(targetDirectory, ".sei-stage-");
}

function publishArtifacts(artifacts, existingByPath) {
  const staged = [];
  const published = [];
  const canonicalStoragePair = canonicalSnapshotStoragePair(artifacts);
  const sharedByLabel = new Map(canonicalStoragePair === null
    ? []
    : [...canonicalStoragePair].map((artifact) => [artifact.label, artifact]));
  const stagedByLabel = new Map();
  try {
    for (const artifact of artifacts) {
      if (existingByPath.get(artifact.path)) continue;
      fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
      const counterpartLabel = artifact.label === "SNAPSHOT" ? "CACHE" : artifact.label === "CACHE" ? "SNAPSHOT" : null;
      const counterpart = counterpartLabel === null ? null : sharedByLabel.get(counterpartLabel);
      if (counterpart && belongsToCanonicalSnapshotStoragePair(canonicalStoragePair, artifact, counterpart)) {
        const stagedCounterpart = stagedByLabel.get(counterpartLabel);
        if (stagedCounterpart) {
          const entry = { artifact, stageDirectory: null, stagePath: counterpart.path, ownsStage: false };
          staged.push(entry);
          stagedByLabel.set(artifact.label, entry);
          continue;
        }
        if (existingByPath.get(counterpart.path)) {
          const entry = { artifact, stageDirectory: null, stagePath: counterpart.path, ownsStage: false };
          staged.push(entry);
          stagedByLabel.set(artifact.label, entry);
          continue;
        }
      }
      const stageDirectory = fs.mkdtempSync(shortStagePrefix(artifact.path));
      const stagePath = path.join(stageDirectory, "artifact");
      const entry = { artifact, stageDirectory, stagePath, ownsStage: true };
      staged.push(entry);
      stagedByLabel.set(artifact.label, entry);
      fs.writeFileSync(stagePath, artifact.bytes, { encoding: "utf8", flag: "wx" });
    }
    for (const entry of staged) {
      try {
        fs.linkSync(entry.stagePath, entry.artifact.path);
        published.push(entry.artifact.path);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        assertImmutableArtifact(entry.artifact);
      }
    }
    assertNoArtifactAliases(artifacts);
  } catch (error) {
    for (const filePath of published.reverse()) {
      try { fs.unlinkSync(filePath); } catch (rollbackError) { if (rollbackError.code !== "ENOENT") throw rollbackError; }
    }
    cleanupStageEntries(staged);
    throw error;
  }
  cleanupStageEntries(staged);
  return {
    staged_count: staged.length,
    staged_bytes: staged.filter((entry) => entry.ownsStage)
      .reduce((sum, entry) => sum + Buffer.byteLength(entry.artifact.bytes), 0),
    linked_count: published.length,
    rolled_back_count: 0,
  };
}

function productExecutorTelemetry(telemetry) {
  return {
    tasks_submitted: telemetry.tasks_submitted,
    tasks_completed: telemetry.tasks_completed,
    effective_workers: telemetry.effective_workers,
    max_in_flight: telemetry.max_in_flight,
    queue_wait_ms: telemetry.queue_wait_ms,
    worker_busy_ms: telemetry.worker_busy_ms,
    wall_ms: telemetry.wall_ms,
    retries: telemetry.retries,
    timeouts: telemetry.timeouts,
    cancelled: telemetry.cancelled,
    blocked: telemetry.blocked,
    serial_fallback: telemetry.serial_fallback,
  };
}

function productPythonStaticTelemetry(result) {
  if (result === null) {
    return {
      status: "unavailable",
      reason: "no CPython runtime candidate with the minimum 3.13 AST capability was available",
      executor_runs: 0,
      tasks_submitted: 0,
      tasks_completed: 0,
      cache_hits: 0,
      recomputed: 0,
      batch_count: 0,
      subprocess_count: 0,
      max_in_flight: 0,
      timeouts: 0,
      cancelled: 0,
      serial_fallback: true,
      cache: { parse: null, graph: null },
    };
  }
  const telemetry = result.telemetry;
  const tasksSubmitted = telemetry.tasks_submitted;
  return {
    status: result.canonical.collectors[0].status,
    reason: result.canonical.collectors[0].reason,
    executor_runs: telemetry.executor_runs,
    tasks_submitted: tasksSubmitted,
    tasks_completed: tasksSubmitted,
    cache_hits: telemetry.parse.hits + telemetry.graph.hits,
    recomputed: telemetry.parse.misses + telemetry.graph.misses,
    batch_count: tasksSubmitted,
    subprocess_count: tasksSubmitted,
    max_in_flight: telemetry.max_in_flight,
    timeouts: telemetry.timeouts,
    cancelled: telemetry.cancelled,
    serial_fallback: telemetry.max_in_flight <= 1,
    cache: {
      parse: structuredClone(telemetry.parse),
      graph: structuredClone(telemetry.graph),
    },
  };
}

function markUnavailablePythonRuntime(lexicalEvidence, pythonRuntime) {
  const evidence = structuredClone(lexicalEvidence);
  const cyclomatic = evidence.metrics.find((metric) => metric.metric_id === "static.cyclomatic_complexity");
  if (cyclomatic?.measurement?.status !== "unavailable") {
    throw new Error("FAIL-CLI-COLLECTION: absent Python runtime cannot replace a non-unavailable cyclomatic record");
  }
  const reason = `FAIL-PYTHON-AST-RUNTIME-UNAVAILABLE: ${pythonRuntime.reason}`;
  cyclomatic.measurement.reason = reason;
  cyclomatic.source.artifact_refs = [...new Set([
    ...cyclomatic.source.artifact_refs,
    `python-runtime-discovery:${pythonRuntime.source}`,
  ])].sort(stableCompare);
  cyclomatic.source.evidence_refs = [...cyclomatic.source.artifact_refs];
  return evidence;
}

function resolveIncrementalStateRoot(options, repositoryId) {
  const configuredStateRoot = options?.usesProjectWorkspace
    ? path.join(options.out, "incremental-run-state-v1", crypto.createHash("sha256").update(repositoryId).digest("hex"))
    : undefined;
  return incrementalStatePrivate.stateRoot({
    output_root: options.out,
    repository_id: repositoryId,
    ...(configuredStateRoot === undefined ? {} : { state_root: configuredStateRoot }),
  });
}

function checkExecutionSignal(signal) {
  if (signal?.aborted) {
    throw new Error(`FAIL-CLI-COLLECTION: ${signal.reason instanceof Error ? signal.reason.message : "execution was cancelled"}`);
  }
}

async function executePredictiveStateCommand(options, repository) {
  if (options.predictiveState === null) return null;
  const config = validateConfig(readJson(options.config, "FAIL-CLI-CONFIG"));
  const repositoryId = deriveCanonicalRepositoryIdentity({
    repository_root: repository.root,
    repository_revision: repository.revision,
    repository_id: config.repository_id,
  });
  const lineage = readJson(options.predictiveStateLineage, "FAIL-CLI-PREDICTIVE-STATE-LINEAGE");
  const reportPins = options.predictiveStateReportPins === null
    ? []
    : readJson(options.predictiveStateReportPins, "FAIL-CLI-PREDICTIVE-STATE-PINS");
  const scopeDocument = options.predictiveStateScope === null
    ? null
    : readJson(options.predictiveStateScope, "FAIL-CLI-PREDICTIVE-STATE-SCOPE");
  const stateRoot = resolveIncrementalStateRoot(options, repositoryId);
  const baseInput = {
    stateRoot,
    repositoryId,
    lineage,
    reportPins,
  };
  const emit = (result) => ({
    command: `predictive-state-${options.predictiveState}`,
    repository_id: repositoryId,
    ...result,
  });
  if (options.predictiveState === "inspect") {
    try {
      return emit(predictiveStatePrivate.inspectPredictiveState({ ...baseInput, lease: null }));
    } catch (error) {
      if (error?.code !== "FAIL-PREDICTIVE-RETENTION"
          || !/existing predictive state requires a leased read capability/.test(error.message)) throw error;
    }
  }
  let lease = null;
  try {
    lease = await incrementalStatePrivate.openStateWriter({
      output_root: options.out,
      state_root: stateRoot,
      repository_id: repositoryId,
    });
    const input = { ...baseInput, lease };
    const result = options.predictiveState === "inspect"
      ? predictiveStatePrivate.inspectPredictiveState(input)
      : predictiveStatePrivate.purgePredictiveState({
        ...input,
        purgeScope: scopeDocument?.purge_scope ?? scopeDocument,
        confirmationToken: options.predictiveStateConfirm,
      });
    return emit(result);
  } finally {
    if (lease !== null) await lease.close();
  }
}

async function executeWithExecutor(argv, executor, runOptions = {}) {
  if (!isRecord(runOptions) || Object.keys(runOptions).some((key) => !["monotonicNow", "resolveJvmRuntime", "resolvePythonRuntime", "resolveTsjsRuntime", "signal"].includes(key))) {
    throw new Error("FAIL-CLI-COLLECTION: execution options may contain only signal, a controlled monotonic clock, and controlled analyzer resolvers");
  }
  if (runOptions.resolvePythonRuntime !== undefined && typeof runOptions.resolvePythonRuntime !== "function") {
    throw new Error("FAIL-CLI-COLLECTION: controlled Python resolver must be a function");
  }
  if (runOptions.monotonicNow !== undefined && typeof runOptions.monotonicNow !== "function") {
    throw new Error("FAIL-CLI-COLLECTION: controlled monotonic clock must be a function");
  }
  if (runOptions.resolveTsjsRuntime !== undefined && typeof runOptions.resolveTsjsRuntime !== "function") {
    throw new Error("FAIL-CLI-COLLECTION: controlled TS/JS resolver must be a function");
  }
  if (runOptions.resolveJvmRuntime !== undefined && typeof runOptions.resolveJvmRuntime !== "function") throw new Error("FAIL-CLI-COLLECTION: controlled JVM resolver must be a function");
  const signal = runOptions.signal;
  checkExecutionSignal(signal);
  const phaseRecorder = createPhaseRecorder(runOptions.monotonicNow);
  let incrementalSession = null;
  let predictiveStateWriter = null;
  // A run that never reaches publication must leave no output tree behind. Collection phases
  // materialize paths under the output root (autonomous local execution writes execution-evidence/
  // at autonomous-local-execution.js:374-375) before composition can reject an ownership conflict,
  // so an output root THIS run created is rolled back when the run fails. A pre-existing output
  // tree is never touched.
  let createdOutputRoot = null;
  let runFailed = false;
  try {
  const { options, repository } = phaseRecorder.measureSync("repository_resolution_ms", () => {
    const parsedOptions = parseArguments(argv);
    const repository = resolveRepository(parsedOptions.repo);
    if (parsedOptions.usesProjectWorkspace) {
      // The default output root belongs to the Git top-level, not to whatever
      // subdirectory --repo (or the working directory) named. Rebinding here,
      // before the output-root rollback, clean-tree check, and state root are
      // derived, keeps every artifact inside the excluded workspace.
      parsedOptions.out = projectIntelligenceWorkspace.workspaceRoot(repository.root);
      projectIntelligenceWorkspace.ensureWorkspace(repository.root);
    }
    return { options: parsedOptions, repository };
  });
  if (!fs.existsSync(options.out)) createdOutputRoot = options.out;
  const stateCommandResult = await executePredictiveStateCommand(options, repository);
  if (stateCommandResult !== null) return stateCommandResult;
  const initialBindings = phaseRecorder.measureSync("input_binding_ms", () => {
    const config = validateConfig(readJson(options.config, "FAIL-CLI-CONFIG"));
    const assessmentConfig = options.assessmentConfig === null
      ? null
      : readJson(options.assessmentConfig, "FAIL-CLI-ASSESSMENT-CONFIG");
    const explicitBaseline = options.baseline ? readCanonicalBaseline(options.baseline) : null;
    const forwardTemporalBundlePath = options.forwardTemporal ?? options.forwardTemporalPrior;
    const forwardTemporalBundleBinding = forwardTemporalBundleInputBinding(forwardTemporalBundlePath);
    const sourceTreeClean = runGit(repository.root, ["status", "--porcelain=v1", "--untracked-files=all"]).length === 0
      && forwardTemporalBundlePath === null;
    const resolvedRepositoryId = deriveCanonicalRepositoryIdentity({
      repository_root: repository.root,
      repository_revision: repository.revision,
      repository_id: config.repository_id,
    });
    return { config, assessmentConfig, explicitBaseline, forwardTemporalBundleBinding, sourceTreeClean, resolvedRepositoryId };
  });
  const { config, assessmentConfig, explicitBaseline, forwardTemporalBundleBinding, sourceTreeClean, resolvedRepositoryId } = initialBindings;
  const stateRoot = options.incremental === "auto"
    || (options.predictive === "required" && options.forwardTemporal === null && options.forwardTemporalPrior === null)
    ? resolveIncrementalStateRoot(options, resolvedRepositoryId)
    : null;
  let priorAssessmentCandidates = [];
  const remainingBindings = phaseRecorder.measureSync("input_binding_ms", () => {
    const history = resolveHistoryWindow(config, repository);
    const historyWindow = history.window;
    const collectorInput = {
      repo_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: config.generated_path_patterns,
      history_window: history.collectorWindow,
      ...(config.static_analyzer_version ? { static_analyzer_version: config.static_analyzer_version } : {}),
      ...(config.temporal_coupling_policy ? { temporal_coupling_policy: config.temporal_coupling_policy } : {}),
    };
    const configurationHash = deriveCollectorConfigurationHash(collectorInput);
    const pythonRuntime = (runOptions.resolvePythonRuntime ?? resolvePythonRuntime)(options.python);
    if (!isRecord(pythonRuntime) || !["candidate", "unavailable"].includes(pythonRuntime.status)
        || (pythonRuntime.executable !== null && (
          typeof pythonRuntime.executable !== "string" || !path.isAbsolute(pythonRuntime.executable) || pythonRuntime.executable.includes("\0")
        ))) {
      throw new Error("FAIL-CLI-COLLECTION: Python runtime resolver returned an invalid closed candidate");
    }
    const tsjsRuntime = (runOptions.resolveTsjsRuntime ?? resolveTsjsRuntime)();
    const jvmRuntime = (runOptions.resolveJvmRuntime ?? resolveJvmRuntime)();
    if (!isRecord(tsjsRuntime) || !["candidate", "unavailable"].includes(tsjsRuntime.status)
        || typeof tsjsRuntime.nodeExecutable !== "string" || !path.isAbsolute(tsjsRuntime.nodeExecutable)
        || (tsjsRuntime.typescriptPath !== null && (typeof tsjsRuntime.typescriptPath !== "string" || !path.isAbsolute(tsjsRuntime.typescriptPath)))) {
      throw new Error("FAIL-CLI-COLLECTION: TS/JS runtime resolver returned an invalid closed candidate");
    }
    checkExecutionSignal(signal);
    const pythonAnalyzerCache = createBufferedPythonAnalyzerCache(options.out, resolvedRepositoryId);
    const disabledDiscovery = Object.freeze({
      stages: Object.freeze([]),
      telemetry: Object.freeze({ examined: 0, accepted: 0, rejected: 0, bounded: false, bytes: 0, disabled: true }),
    });
    const staticStageDiscovery = options.incremental === "auto"
      ? incrementalStatePrivate.discoverStages({ output_root: options.out, state_root: stateRoot, repository_id: resolvedRepositoryId, kind: "static" })
      : disabledDiscovery;
    const historyStageDiscovery = options.incremental === "auto"
      ? incrementalStatePrivate.discoverStages({ output_root: options.out, state_root: stateRoot, repository_id: resolvedRepositoryId, kind: "history" })
      : disabledDiscovery;
    return {
      historyWindow,
      collectorInput,
      configurationHash,
      pythonRuntime,
      tsjsRuntime,
      jvmRuntime,
      pythonAnalyzerCache,
      staticStageDiscovery,
      historyStageDiscovery,
      stateRoot,
    };
  });
  const {
    historyWindow,
    collectorInput,
    configurationHash,
    pythonRuntime,
    tsjsRuntime,
    jvmRuntime,
    pythonAnalyzerCache,
    staticStageDiscovery,
    historyStageDiscovery,
  } = remainingBindings;
  const cacheValidation = {
    prior_static_snapshot: { attempted: false, result: "superseded-by-compact-state" },
    incremental_static_state: {
      attempted: options.incremental === "auto",
      result: options.incremental === "off" ? "disabled" : staticStageDiscovery.stages.length === 0 ? "miss" : "candidate",
    },
    incremental_history_state: {
      attempted: options.incremental === "auto",
      result: options.incremental === "off" ? "disabled" : historyStageDiscovery.stages.length === 0 ? "miss" : "candidate",
    },
    canonical_snapshot: { attempted: sourceTreeClean, result: sourceTreeClean ? "miss" : "disabled" },
  };

  // Resolve one immutable revision-bound index before admitting every independent analysis branch.
  const phaseA = await phaseRecorder.measureAsync("substrate_executor_ms", () => executor.run([
    {
      id: "repository-index",
      resourceClass: "io_git",
      concurrencyGroup: "git-tree-index",
      deterministicOrderKey: "00:repository-index",
      memoryWeight: 1,
      run: ({ signal }) => phaseRecorder.measureAsync("repository_index_ms", () => buildRepositoryIndex({
        repository_root: repository.root,
        repository_revision: repository.revision,
        generated_path_patterns: config.generated_path_patterns,
        signal,
      })),
    },
  ], { signal }));
  const indexResult = phaseA.results.find((result) => result.id === "repository-index");
  if (phaseA.status !== "succeeded" || indexResult?.state !== "succeeded") {
    const detail = indexResult?.error?.message ?? "repository index collection did not succeed";
    throw new Error(`FAIL-CLI-COLLECTION: ${detail}`);
  }
  const repositoryIndex = indexResult.value;
  const staticDependencyBaseline = options.incremental === "auto"
    ? selectStaticDependencyBaseline(
      repository,
      repositoryIndex,
      resolvedRepositoryId,
      staticStageDiscovery.stages,
    )
    : null;
  if (options.incremental === "auto") {
    incrementalSession = await phaseRecorder.measureAsync("cache_discovery_ms", () => openIncrementalRun(incrementalSessionInput({
      options,
      repository,
      assessmentConfig,
      repositoryIndex,
      resolvedRepositoryId,
      configurationHash,
      config,
      explicitBaseline,
      forwardTemporalBundleBinding,
      historyWindow,
      pythonRuntime,
      sourceTreeClean,
      signal,
      stateRoot,
    })));
    priorAssessmentCandidates = incrementalSession.prior_assessments ?? [];
  }
  // Exact bundles are safe for assessed replay only when the persisted,
  // snapshot-bound assessment was validated as part of bundle verification.
  // Evidence-only bundles remain replayable without a sidecar.
  if (options.predictive !== "required" && ((options.evidenceOnly && incrementalSession?.exact_bundle?.assessment === null)
       || (!options.evidenceOnly && incrementalSession?.exact_bundle?.assessment !== null))
      && incrementalSession?.exact_bundle !== null && incrementalSession?.exact_bundle !== undefined) {
    const exact = incrementalSession.exact_bundle;
    const exactState = intelligenceEnginePrivate.readCanonicalArtifact(exact.canonical_artifact);
    const snapshot = exactState.snapshot;
    const snapshotBytes = exactState.snapshot_json;
    const reportBytes = options.reportMode === "generate"
      ? (exact.report_bytes ?? reportPrivate.renderReportFromCanonicalArtifact(
          exact.canonical_artifact,
          exact.assessment_binding === null ? {} : { assessment_binding: exact.assessment_binding },
        ))
      : null;
    const fileCount = snapshot.measurements.find((metric) => metric.metric_id === "static.source_file_count")?.value ?? 0;
    const commitCount = snapshot.measurements.find((metric) => metric.metric_id === "git.change_frequency")?.value ?? 0;
    const relationshipCount = snapshot.risk_models
      .find((model) => model.risk_model_id === "temporal-coupling-pressure-v1")?.result?.records?.length ?? 0;
    cacheValidation.canonical_snapshot.result = "hit";
    cacheValidation.incremental_static_state.result = "exact";
    cacheValidation.incremental_history_state.result = "exact";
    const prepublicationPhaseTelemetry = phaseRecorder.prepublicationTelemetry();
    const substrateTelemetry = productExecutorTelemetry(phaseA.telemetry);
    const idleExecutor = {
      tasks_submitted: 0, tasks_completed: 0, effective_workers: 0, max_in_flight: 0,
      queue_wait_ms: 0, worker_busy_ms: 0, wall_ms: 0, retries: 0, timeouts: 0,
      cancelled: 0, blocked: 0, serial_fallback: true,
    };
    const performance = {
      duration_ms: prepublicationPhaseTelemetry.reconciliation.prepublication_duration_ms,
      files: fileCount,
      commits: commitCount,
      relationship_count: relationshipCount,
      cache: "hit",
      cache_result: "hit",
      static_analysis_cache: { cache: "hit", reused_file_count: fileCount, recomputed_file_count: 0 },
      python_static_intelligence: {
        ...productPythonStaticTelemetry(null),
        status: "replayed",
        reason: "exact validated run bundle replayed without analyzer execution",
        discovery_source: pythonRuntime.source,
      },
      phase_telemetry: prepublicationPhaseTelemetry,
      cache_validation: structuredClone(cacheValidation),
      incremental_stages: {
        static: {
          discovery: structuredClone(incrementalSession.discovery.static),
          reuse: { mode: "exact", reused_file_count: fileCount, recomputed_file_count: 0 },
          invalidation: {
            mode: "exact",
            status: "exact",
            reason: "exact validated run bundle replayed",
            plan_digest: null,
            ancestry_relationship: "same-revision",
            prior_repository_revision: repository.revision,
            current_repository_revision: repository.revision,
            changed_path_count: 0,
            affected_node_count: 0,
            directly_invalidated_record_count: 0,
            dependency_invalidated_record_count: 0,
            reusable_record_count: fileCount,
            topology_recompute: false,
          },
        },
        history: { discovery: structuredClone(incrementalSession.discovery.history), reuse: { mode: "exact", reused_commit_count: commitCount, appended_commit_count: 0, reason: null } },
      },
    };
    const performanceArtifact = {
      ...performance,
      executor: {
        mode: "exact-run-replay-v1",
        ...substrateTelemetry,
        phases: { substrate: substrateTelemetry, consumers: idleExecutor, python_static: idleExecutor },
        git_history_execution: "compact-state-exact-hit",
        git_history_cancellation: "not-cooperative",
      },
    };
    const cachePath = cacheArtifactPath(options.out, snapshot);
    const assessment = options.evidenceOnly ? null : exact.assessment;
    // Re-apply the CURRENT profile's coverage gate to the replayed assessment,
    // with the same shared evaluator and error as the fresh path
    // (engineering-assessment.js evaluateCoverageGate/enforceCoverageGate).
    if (assessment !== null) {
      engineeringAssessmentPrivate.enforceCoverageGate(
        engineeringAssessmentPrivate.evaluateCoverageGate(assessment, assessmentConfig),
      );
    }
    const snapshotPath = path.join(options.out, "snapshots", `${snapshot.snapshot_id}.json`);
    const reportPath = path.join(options.out, "reports", `${snapshot.snapshot_id}.html`);
    const assessmentPath = assessment === null ? null : path.join(options.out, "assessments", `${assessment.assessment_id.slice("sha256:".length)}.json`);
    const artifacts = [
      { label: "SNAPSHOT", path: snapshotPath, bytes: snapshotBytes },
      ...(options.reportMode === "generate" ? [{ label: "REPORT", path: reportPath, bytes: reportBytes }] : []),
      { label: "CACHE", path: cachePath, bytes: snapshotBytes },
      ...(assessment === null ? [] : [{ label: "ASSESSMENT", path: assessmentPath, bytes: serializedJson(assessment) }]),
      ...(options.performanceJson ? [{ label: "PERFORMANCE", path: options.performanceJson, bytes: serializedJson(performanceArtifact) }] : []),
    ];
    checkExecutionSignal(signal);
    const publicationMeasurement = phaseRecorder.measureDetachedSync(() => incrementalSession.publish({
      artifacts,
      manifest: { label: exact.manifest_label, path: exact.manifest_path, bytes: exact.manifest_bytes },
    }));
    const returnedPhaseTelemetry = phaseRecorder.finalTelemetry(
      prepublicationPhaseTelemetry,
      0,
      publicationMeasurement.duration_ms,
    );
    return {
      snapshot_id: snapshot.snapshot_id,
      revision: repository.revision,
      cache: "hit",
      assessment_id: assessment?.assessment_id ?? null,
      assessment_path: assessmentPath,
      assessment: assessment === null ? { state: "not-assessed", reason: "evidence-only mode was requested" } : {
        state: assessment.overview.maturity,
        score: assessment.overview.score,
        coverage: assessment.overview.coverage,
        confidence: assessment.overview.confidence,
        trajectory: assessment.trajectory.state,
        assessed_criterion_rate: assessment.coverage_accounting?.assessed_criterion_rate ?? null,
        coverage_gate: assessment.coverage_accounting?.coverage_gate?.status ?? "not_met",
      },
      snapshot_path: snapshotPath,
      report_path: options.reportMode === "generate" ? reportPath : null,
      predictive: {
        mode: options.predictive,
        state: "replayed",
        reason: options.reportMode === "generate" ? "exact validated report bundle replayed; prior predictive readiness/evaluation remains report-bound" : "exact validated bundle replayed; report publication was skipped by elected presentation policy",
        cache_status: "hit",
        fold_count: 0,
        forecast_count: 0,
      },
      comparison: exact.comparison,
      performance: {
        ...performance,
        executor: performanceArtifact.executor,
        phase_telemetry: returnedPhaseTelemetry,
        artifacts: publicationMeasurement.value,
      },
    };
  }
  const discoveryWindow = historyWindow.end === repository.revision
    ? historyWindow
    : { kind: "revision", start: null, end: repository.revision };
  const analyzerExecutor = new TaskExecutor({
    maxWorkers: 1,
    resourceLimits: { external_process: 1 },
    groupLimits: { "python-ast": 1, "tsjs-ast": 1 },
    maxMemoryWeight: 6,
  });
  let pythonStaticResult = null;
  let tsjsStaticResult = null;
  let duplicationResult = null;
  let autonomousDiscoveryResult = null;
  let autonomousExecutionResult = null;
  let dependencyResult = null;
  let jvmStaticResult = null;
  const phaseB = await phaseRecorder.measureAsync("consumer_executor_ms", () => executor.run([
    {
      id: "git-history",
      resourceClass: "io_git",
      concurrencyGroup: "git-history",
      deterministicOrderKey: "10:git-history",
      memoryWeight: 4,
      run: ({ signal }) => phaseRecorder.measureAsync("git_history_ms", async () => {
        if (signal.aborted) throw signal.reason ?? new Error("Git history cancelled before start");
        return collectorsPrivate.collectGitEvidenceIncremental(collectorInput, {
          repository_id: resolvedRepositoryId,
          prior_stages: historyStageDiscovery.stages,
          signal,
        });
      }),
    },
    {
      id: "static-source",
      resourceClass: "io_git",
      concurrencyGroup: "git-blob-read",
      deterministicOrderKey: "20:static-source",
      memoryWeight: 4,
      run: ({ signal }) => phaseRecorder.measureAsync(
        "lexical_ms",
        () => collectorsPrivate.collectStaticEvidenceIncremental(collectorInput, repositoryIndex, {
          repository_id: resolvedRepositoryId,
          prior_stages: staticStageDiscovery.stages,
          signal,
        }),
      ),
    },
    {
      id: "verification-discovery",
      resourceClass: "io_light",
      concurrencyGroup: null,
      deterministicOrderKey: "30:verification-discovery",
      memoryWeight: 1,
      run: ({ signal }) => phaseRecorder.measureAsync("verification_discovery_ms", () => (
        discoverRevisionBoundVerificationEvidenceFromIndex({
          repository_revision: repository.revision,
          configuration_hash: configurationHash,
          history_window: discoveryWindow,
          repository_index: repositoryIndex,
          signal,
        })
      )),
    },
    {
      id: "autonomous-evidence",
      resourceClass: "io_light",
      concurrencyGroup: null,
      deterministicOrderKey: "35:autonomous-evidence",
      memoryWeight: 1,
      run: ({ signal }) => phaseRecorder.measureAsync("autonomous_discovery_ms", async () => {
        autonomousDiscoveryResult = await discoverEngineeringEvidence({ repositoryIndex, signal });
        return autonomousDiscoveryResult;
      }),
    },
    {
      id: "autonomous-local-execution",
      resourceClass: "external_process",
      concurrencyGroup: "local-verification",
      deterministicOrderKey: "36:autonomous-local-execution",
      memoryWeight: 2,
      run: ({ signal }) => phaseRecorder.measureAsync("autonomous_local_execution_ms", async () => {
        autonomousExecutionResult = await collectAutonomousLocalExecution({
          repository_root: repository.root,
          repository_revision: repository.revision,
          repository_index: repositoryIndex,
          output_root: options.out,
          python_executable: pythonRuntime.executable,
          configuration_hash: configurationHash,
          signal,
        });
        return autonomousExecutionResult;
      }),
    },
    {
      id: "python-static",
      resourceClass: "external_process",
      concurrencyGroup: "language-analyzer",
      deterministicOrderKey: "40:python-static",
      memoryWeight: 3,
      run: ({ signal }) => phaseRecorder.measureAsync("python_static_ms", async () => {
        if (pythonRuntime.executable === null) return null;
        pythonStaticResult = await analyzeStaticIntelligence({
          repositoryIndex,
          taskExecutor: analyzerExecutor,
          cache: pythonAnalyzerCache.cache,
          configuration: { pythonExecutable: pythonRuntime.executable, grammarTarget: [3, 13], moduleRoots: [] },
          invalidation: staticDependencyBaseline,
          signal,
        });
        return pythonStaticResult;
      }),
    },
    {
      id: "tsjs-static",
      resourceClass: "external_process",
      concurrencyGroup: "language-analyzer",
      deterministicOrderKey: "50:tsjs-static",
      memoryWeight: 3,
      run: ({ signal }) => phaseRecorder.measureAsync("tsjs_static_ms", async () => {
        tsjsStaticResult = await analyzeTsjsIntelligence({
          repositoryIndex,
          taskExecutor: analyzerExecutor,
          configuration: { nodeExecutable: tsjsRuntime.nodeExecutable, typescriptPath: tsjsRuntime.typescriptPath },
          signal,
        });
        return tsjsStaticResult;
      }),
    },
    {
      id: "structural-duplication",
      resourceClass: "cpu_heavy",
      concurrencyGroup: "duplication-analysis",
      deterministicOrderKey: "60:structural-duplication",
      memoryWeight: 4,
      run: ({ signal }) => phaseRecorder.measureAsync("duplication_ms", async () => {
        duplicationResult = await analyzeDuplicationIntelligence({ repositoryIndex, signal });
        return duplicationResult;
      }),
    },
    {
      id: "jvm-static",
      resourceClass: "external_process",
      concurrencyGroup: "language-analyzer",
      deterministicOrderKey: "65:jvm-static",
      memoryWeight: 4,
      run: ({ signal }) => phaseRecorder.measureAsync("jvm_static_ms", async () => {
        if (jvmRuntime.executable === null) return null;
        jvmStaticResult = await analyzeJvmStaticIntelligence({ repositoryIndex, taskExecutor: analyzerExecutor, configuration: { javaExecutable: jvmRuntime.executable, grammarTarget: 25, limits: {} }, signal });
        return jvmStaticResult;
      }),
    },
    {
      id: "named-dependency-intelligence",
      resourceClass: "cpu_heavy",
      concurrencyGroup: "dependency-analysis",
      deterministicOrderKey: "70:named-dependency-intelligence",
      dependencies: ["tsjs-static"],
      memoryWeight: 2,
      run: ({ signal }) => {
        if (signal.aborted) throw signal.reason ?? new Error("dependency intelligence cancelled before start");
        const topology = tsjsStaticResult?.canonical?.facts?.topology;
        if (!topology || topology.status === "unavailable") return null;
        const modules = topology.modules.filter((module) => module.parse_status === "ok");
        const moduleIds = new Set(modules.map((module) => module.id));
        dependencyResult = analyzeDependencyIntelligence({
          nodes: modules.map((module) => ({ id: module.id, package_id: derivePackageId(module.path, repositoryIndex), layer: null })),
          edges: topology.edges.filter((edge) => moduleIds.has(edge.source) && moduleIds.has(edge.target)).map((edge) => ({ source: edge.source, target: edge.target })),
        });
        return dependencyResult;
      },
    },
  ], { signal }));
  const gitResult = phaseB.results.find((result) => result.id === "git-history");
  const staticResult = phaseB.results.find((result) => result.id === "static-source");
  const discoveryResult = phaseB.results.find((result) => result.id === "verification-discovery");
  const requiredResults = [
    gitResult,
    staticResult,
    discoveryResult,
    phaseB.results.find((result) => result.id === "autonomous-evidence"),
    phaseB.results.find((result) => result.id === "autonomous-local-execution"),
    phaseB.results.find((result) => result.id === "python-static"),
    phaseB.results.find((result) => result.id === "tsjs-static"),
    phaseB.results.find((result) => result.id === "structural-duplication"),
    phaseB.results.find((result) => result.id === "jvm-static"),
    phaseB.results.find((result) => result.id === "named-dependency-intelligence"),
  ];
  if (phaseB.status !== "succeeded" || requiredResults.some((result) => result?.state !== "succeeded")) {
    const detail = requiredResults.find((result) => result?.state !== "succeeded")?.error?.message ?? "indexed analysis DAG did not succeed";
    throw new Error(`FAIL-CLI-COLLECTION: ${detail}`);
  }
  const integratedStaticEvidence = pythonRuntime.executable === null
    ? markUnavailablePythonRuntime(staticResult.value.evidence, pythonRuntime)
    : integratePythonStaticIntelligence({
        collector_input: collectorInput,
        lexical_evidence: staticResult.value.evidence,
        repository_index: repositoryIndex,
        static_intelligence: pythonStaticResult,
      }).evidence;
  checkExecutionSignal(signal);
  const { localEvidence, evidence } = phaseRecorder.measureSync("evidence_composition_ms", () => {
    const baseLocalEvidence = mergeLocalEvidence(integratedStaticEvidence, gitResult.value.evidence);
    const tsjsEvidence = projectTsjsEvidence({ result: tsjsStaticResult, configuration_hash: configurationHash, history_window: discoveryWindow });
    const duplicationEvidence = projectDuplicationEvidence({ result: duplicationResult, configuration_hash: configurationHash, history_window: discoveryWindow });
    const autonomousEvidence = projectEngineeringEvidence({ discovery: autonomousDiscoveryResult, configuration_hash: configurationHash, history_window: discoveryWindow });
    const executionEvidence = autonomousExecutionResult ?? { collectors: [], metrics: [] };
    const dependencyEvidence = dependencyResult === null
      ? { collectors: [], metrics: [], result: null }
      : projectDependencyEvidence({
          result: dependencyResult,
          graph_id: "tsjs",
          graph_completeness: tsjsStaticResult.canonical.facts.topology.completeness,
          repository_revision: repository.revision,
          configuration_hash: configurationHash,
          history_window: discoveryWindow,
        });
    const jvmEvidence = jvmStaticResult === null
      ? projectUnavailableJvmEvidence({ repository_revision: repository.revision, configuration_hash: configurationHash, history_window: discoveryWindow, reason: jvmRuntime.reason ?? "JDK compiler capability 25 or newer unavailable" })
      : projectJvmEvidence({ result: jvmStaticResult, configuration_hash: configurationHash, history_window: discoveryWindow });
    const collectors = [...baseLocalEvidence.collectors, ...tsjsEvidence.collectors, ...jvmEvidence.collectors, ...duplicationEvidence.collectors, ...autonomousEvidence.collectors, ...executionEvidence.collectors, ...dependencyEvidence.collectors]
      .sort((left, right) => stableCompare(left.collector_id, right.collector_id));
    const metricIds = new Set();
    const metrics = [...baseLocalEvidence.metrics, ...tsjsEvidence.metrics, ...jvmEvidence.metrics, ...duplicationEvidence.metrics, ...autonomousEvidence.metrics, ...executionEvidence.metrics, ...dependencyEvidence.metrics]
      .sort((left, right) => stableCompare(left.metric_id, right.metric_id));
    for (const metric of metrics) {
      if (metricIds.has(metric.metric_id)) throw new Error(`FAIL-CLI-COLLECTION: internal analyzers duplicate metric ${metric.metric_id}`);
      metricIds.add(metric.metric_id);
    }
    const localEvidence = {
      ...baseLocalEvidence,
      collectors,
      capabilities: structuredClone(collectors),
      metrics,
      tsjs_intelligence: tsjsEvidence,
      jvm_intelligence: jvmEvidence,
      duplication_intelligence: duplicationEvidence,
      autonomous_engineering_evidence: autonomousEvidence,
      autonomous_local_execution: executionEvidence,
      dependency_intelligence: dependencyEvidence,
    };
    if (configurationHashFromMeasurements(localEvidence.metrics) !== configurationHash) {
      throw new Error("FAIL-CLI-COLLECTION: materialized evidence configuration hash disagreed with the scheduled configuration hash");
    }
    const composedEvidence = attachExternalAdapterCapabilities(composeAdapterEvidence(
      config,
      repository,
      historyWindow,
      localEvidence,
      options.config,
      discoveryResult.value,
    ));
    const localAssessment = autonomousAssessmentPrivate.deriveAssessmentEvidence({
      discovery: autonomousDiscoveryResult,
      projected: composedEvidence,
      execution: autonomousExecutionResult,
      configuration_hash: configurationHash,
      history_window: discoveryWindow,
    });
    const evidenceQuality = (record) => {
      const status = record?.measurement?.status ?? record?.status;
      return status === "measured" || status === "available" ? 3 : status === "inferred" || status === "degraded" ? 2 : 1;
    };
    // Local execution is a producer-owned, revision-bound fact. If an older
    // discovery/adapter placeholder already used the same semantic metric ID,
    // replace only the weaker record; never emit duplicate IDs into a snapshot.
    const metricById = new Map(composedEvidence.metrics.map((metric) => [metric.metric_id, metric]));
    for (const metric of localAssessment.metrics) {
      const prior = metricById.get(metric.metric_id);
      if (!prior || evidenceQuality(metric) > evidenceQuality(prior)) metricById.set(metric.metric_id, metric);
    }
    const collectorById = new Map(composedEvidence.collectors.map((collector) => [collector.collector_id, collector]));
    for (const collector of localAssessment.collectors) {
      const prior = collectorById.get(collector.collector_id);
      if (!prior || evidenceQuality(collector) > evidenceQuality(prior)) collectorById.set(collector.collector_id, collector);
    }
    const mergedCollectors = [...collectorById.values()].sort((left, right) => stableCompare(left.collector_id, right.collector_id));
    const evidence = {
      ...composedEvidence,
      collectors: mergedCollectors,
      capabilities: [...(composedEvidence.capabilities ?? []), ...mergedCollectors
        .filter((collector) => !composedEvidence.collectors.some((prior) => prior.collector_id === collector.collector_id))
        .map((collector) => structuredClone(collector))],
      metrics: [...metricById.values()].sort((left, right) => stableCompare(left.metric_id, right.metric_id)),
    };
    return { localEvidence, evidence };
  });
  const snapshotDraft = phaseRecorder.measureSync(
    "snapshot_build_ms",
    () => buildSnapshotDraft(repository, config, evidence, phaseRecorder),
  );
  const trendBinding = phaseRecorder.measureSync("baseline_discovery_ms", () => (
    explicitBaseline !== null
      ? {
          binding_kind: "explicit",
          status: "explicit",
          eligible: true,
          baseline: explicitBaseline,
          reason: "explicit canonical baseline supplied by the caller",
        }
      : trendBaselinePrivate.discoverAutomaticTrendBaselineFromProbe({
          repository_root: repository.root,
          output_root: stateRoot ?? options.out,
          current_probe: intelligenceEnginePrivate.createTrendProbe(
            snapshotDraft,
            phaseRecorder.instrumentation,
          ),
        })
  ));
  const collectedArtifact = phaseRecorder.measureSync(
    "snapshot_build_ms",
    () => intelligenceEnginePrivate.materializeCanonicalArtifact(
      bindTrendToSnapshotDraft(snapshotDraft, trendBinding),
      phaseRecorder.instrumentation,
    ),
  );
  const collectedState = intelligenceEnginePrivate.readCanonicalArtifact(collectedArtifact);
  const collectedSnapshot = collectedState.snapshot;
  const cachePath = cacheArtifactPath(options.out, collectedSnapshot);
  const cachedArtifact = phaseRecorder.measureSync(
    "cache_discovery_ms",
    () => validatedCachedArtifact(cachePath, collectedArtifact, sourceTreeClean, phaseRecorder),
  );
  if (sourceTreeClean) cacheValidation.canonical_snapshot.result = cachedArtifact === null ? "miss" : "hit";
  const finalArtifact = cachedArtifact ?? collectedArtifact;
  const finalState = intelligenceEnginePrivate.readCanonicalArtifact(finalArtifact);
  const snapshot = finalState.snapshot;
  // A repository-local output directory makes the working tree dirty after
  // the first publication. Do not let that mutable state select a prior
  // assessment trajectory for the same revision; recomputing from the exact
  // snapshot keeps the report bytes stable while preserving the fail-closed
  // cache boundary.
  const priorAssessment = sourceTreeClean
    ? sameRevisionPriorAssessment(priorAssessmentCandidates, snapshot)
    : null;
  const assessment = options.evidenceOnly
    ? null
    : phaseRecorder.measureSync("assessment_evaluation_ms", () => {
      const resolvedStandard = assessmentStandards.resolveAssessmentStandard({
        assessmentConfig,
        repositoryRoot: repository.root,
      });
      const normalizedAssessmentConfig = {
        ...(assessmentConfig ?? {}),
        repository_root: repository.root,
        standard: {
          standard_id: resolvedStandard.standard.standard_id,
          version: resolvedStandard.standard.standard_version,
          source: resolvedStandard.source.kind,
          applicability: { not_applicable_criteria: [] },
        },
      };
      const assessWith = (prior) => engineeringAssessment.assessRepositoryEngineering({
        snapshot,
        repositoryIndex,
        assessmentConfig: normalizedAssessmentConfig,
        priorAssessment: prior,
      });
      // A same-snapshot prior compares the snapshot with itself. When the
      // first-observation assessment for this exact snapshot already exists,
      // reuse it so a cache miss publishes the same bytes as an exact replay
      // instead of minting a self-comparison that the immutable report path
      // must refuse. A differing base (methodology change) keeps the prior.
      const base = assessWith(null);
      if (priorAssessment === null
          || priorAssessmentCandidates.some((candidate) => candidate?.assessment?.assessment_id === base.assessment_id)) return base;
      return assessWith(priorAssessment);
    });
  const assessmentBinding = assessment === null ? null : engineeringAssessmentPrivate.bindAssessment(assessment, snapshot);
  const assessmentBytes = assessment === null ? null : serializedJson(assessment);
  const assessmentPath = assessment === null ? null : path.join(options.out, "assessments", `${assessment.assessment_id.slice("sha256:".length)}.json`);
  const baseline = trendBinding.baseline;
  const comparison = phaseRecorder.measureSync("comparison_ms", () => (
    baseline
      ? comparisonReceipt(baseline, snapshot, trendBinding.binding_kind, trendBinding.status)
      : noBaselineComparisonReceipt(snapshot, trendBinding)
  ));
  const snapshotBytes = finalState.snapshot_json;
  const forwardTemporalBundlePath = options.forwardTemporal ?? options.forwardTemporalPrior;
  let predictiveAutoResult = null;
  let predictiveBinding;
  if (forwardTemporalBundlePath !== null) {
    predictiveBinding = phaseRecorder.measureSync("input_binding_ms", () => {
      const binding = forwardTemporalPrivate.loadForwardTemporalBundle({
        bundle_path: forwardTemporalBundlePath,
        expected_bundle_sha256: forwardTemporalBundleBinding[0]?.sha256,
      });
      if (options.forwardTemporal !== null) {
        forwardTemporalPrivate.assertBoundCurrentSnapshot(binding, snapshot);
      } else {
        assertStrictPriorForwardTemporalBundle(repository.root, binding, snapshot);
      }
      return binding;
    });
  } else if (options.predictive === "off") {
    predictiveBinding = null;
  } else {
    predictiveBinding = await phaseRecorder.measureAsync("predictive_auto_ms", async () => {
      const lease = options.predictive === "required"
        ? incrementalSession ?? (predictiveStateWriter ??= await incrementalStatePrivate.openStateWriter({
          output_root: options.out,
          state_root: stateRoot,
          repository_id: resolvedRepositoryId,
        }))
        : incrementalSession;
      predictiveAutoResult = predictiveAuto.evaluateAutomatic({
        mode: options.predictive,
        output_root: options.out,
        state_root: stateRoot,
        repository_id: resolvedRepositoryId,
        configuration_hash: configurationHash,
        history_stage: gitResult.value.stage,
        current_snapshot: snapshot,
        repository_root: repository.root,
        config_path: options.config,
        python_executable: pythonRuntime.executable,
        lease,
        signal,
      });
      if (options.predictive === "required" && predictiveAutoResult.status !== "evaluated") {
        throw new Error(`FAIL-CLI-PREDICTIVE-REQUIRED: ${predictiveAutoResult.reason}`);
      }
      return predictiveAutoResult.binding;
    });
  }
  const reportBytes = phaseRecorder.measureSync(
    "report_render_ms",
    () => options.reportMode === "generate"
      ? reportPrivate.renderReportFromCanonicalArtifact(finalArtifact, { predictive_binding: predictiveBinding, assessment_binding: assessmentBinding })
      : null,
  );
  const reportValidation = phaseRecorder.measureSync(
    "report_verification_ms",
    () => options.reportMode === "generate"
      ? reportPrivate.verifyRenderedReportFromCanonicalArtifact(reportBytes, finalArtifact, { predictive_binding: predictiveBinding, assessment_binding: assessmentBinding })
      : { ok: true, errors: [] },
  );
  if (!reportValidation.ok) throw new Error(`FAIL-CLI-REPORT: ${reportValidation.errors.join("; ")}`);
  checkExecutionSignal(signal);

  const snapshotPath = path.join(options.out, "snapshots", `${snapshot.snapshot_id}.json`);
  const reportPath = path.join(options.out, "reports", `${snapshot.snapshot_id}.html`);
  const cache = cachedArtifact ? "hit" : "miss";
  const prepublicationPhaseTelemetry = phaseRecorder.prepublicationTelemetry();
  const performance = {
    duration_ms: prepublicationPhaseTelemetry.reconciliation.prepublication_duration_ms,
    files: evidence.static.files.length,
    commits: evidence.git.aggregates.commit_count,
    relationship_count: evidence.relationships.length,
    cache,
    cache_result: cache,
    static_analysis_cache: structuredClone(localEvidence.static.analysis_cache ?? {
      cache: "not-applicable",
      reused_file_count: 0,
      recomputed_file_count: 0,
    }),
    python_static_intelligence: pythonStaticResult === null
      ? {
          ...productPythonStaticTelemetry(null),
          status: "unavailable",
          reason: pythonRuntime.reason,
          discovery_source: pythonRuntime.source,
        }
      : {
          ...productPythonStaticTelemetry(pythonStaticResult),
          discovery_source: pythonRuntime.source,
        },
    tsjs_static_intelligence: {
      status: tsjsStaticResult.canonical.collectors[0].status,
      reason: tsjsStaticResult.canonical.collectors[0].reason,
      discovery_source: tsjsRuntime.source,
      parser_status: tsjsStaticResult.canonical.analyzer.runtime.status,
      tasks_submitted: tsjsStaticResult.telemetry.tasks_submitted,
      max_in_flight: tsjsStaticResult.telemetry.max_in_flight,
      timeouts: tsjsStaticResult.telemetry.timeouts,
      cancelled: tsjsStaticResult.telemetry.cancelled,
    },
    predictive: {
      mode: forwardTemporalBundlePath !== null ? "explicit" : options.predictive,
      state: forwardTemporalBundlePath !== null ? "evaluated" : predictiveAutoResult?.status ?? "disabled",
      cache_status: predictiveAutoResult?.cache_status ?? null,
      fold_count: predictiveAutoResult?.receipt?.folds?.length ?? 0,
      forecast_count: predictiveAutoResult?.current_rankings?.reduce((sum, ranking) => sum + ranking.items.length, 0) ?? 0,
      telemetry: predictiveAutoResult?.telemetry ?? null,
    },
    jvm_static_intelligence: {
      status: jvmStaticResult?.canonical.languages.java.status ?? "unavailable",
      reason: jvmStaticResult?.canonical.languages.java.status === "available"
        ? null
        : jvmStaticResult?.canonical.languages.java.reason ?? jvmRuntime.reason ?? "JDK compiler capability 25 or newer unavailable",
      discovery_source: jvmRuntime.source,
      java_files: jvmStaticResult?.canonical.languages.java.selected_file_count ?? 0,
      kotlin_status: jvmStaticResult?.canonical.languages.kotlin.status ?? "unavailable",
      tasks_submitted: jvmStaticResult?.telemetry.tasks_submitted ?? 0,
      max_in_flight: jvmStaticResult?.telemetry.max_in_flight ?? 0,
    },
    duplication_intelligence: {
      status: duplicationResult.status,
      reason: duplicationResult.reason,
      clone_family_count: duplicationResult.summary.clone_family_count,
      analyzed_source_files: duplicationResult.summary.analyzed_source_files,
      blob_read_batches: duplicationResult.telemetry.blob_read_batches,
      candidate_pairs: duplicationResult.telemetry.candidate_pairs,
    },
    autonomous_evidence: {
      capability_count: autonomousDiscoveryResult.capabilities.length,
      observed: autonomousDiscoveryResult.capabilities.filter((capability) => capability.state === "OBSERVED").length,
      configured: autonomousDiscoveryResult.capabilities.filter((capability) => capability.state === "CONFIGURED").length,
      unavailable: autonomousDiscoveryResult.capabilities.filter((capability) => capability.state === "UNAVAILABLE").length,
      telemetry: structuredClone(autonomousDiscoveryResult.telemetry),
    },
    phase_telemetry: prepublicationPhaseTelemetry,
    cache_validation: structuredClone(cacheValidation),
    incremental_stages: {
      exact_rejection_reason: incrementalSession?.discovery?.exact_rejection_reason ?? null,
      static: {
        discovery: structuredClone(staticStageDiscovery.telemetry),
        reuse: structuredClone(staticResult.value.telemetry),
        invalidation: pythonStaticResult?.invalidation ?? {
          mode: "unavailable",
          status: "unavailable",
          reason: pythonRuntime.reason ?? "no Python dependency analyzer result is available",
          plan_digest: null,
          ancestry_relationship: null,
          prior_repository_revision: null,
          current_repository_revision: repository.revision,
          changed_path_count: 0,
          affected_node_count: 0,
          directly_invalidated_record_count: 0,
          dependency_invalidated_record_count: 0,
          reusable_record_count: 0,
          topology_recompute: true,
        },
      },
      history: {
        discovery: structuredClone(historyStageDiscovery.telemetry),
        reuse: structuredClone(gitResult.value.telemetry),
      },
    },
  };
  const performanceArtifact = {
    ...performance,
    executor: (() => {
      const substrateTelemetry = productExecutorTelemetry(phaseA.telemetry);
      const consumerTelemetry = productExecutorTelemetry(phaseB.telemetry);
      return {
        mode: "revision-indexed-analysis-dag-v1",
        tasks_submitted: substrateTelemetry.tasks_submitted + consumerTelemetry.tasks_submitted,
        tasks_completed: substrateTelemetry.tasks_completed + consumerTelemetry.tasks_completed,
        effective_workers: Math.max(substrateTelemetry.effective_workers, consumerTelemetry.effective_workers),
        max_in_flight: Math.max(substrateTelemetry.max_in_flight, consumerTelemetry.max_in_flight),
        queue_wait_ms: substrateTelemetry.queue_wait_ms + consumerTelemetry.queue_wait_ms,
        worker_busy_ms: substrateTelemetry.worker_busy_ms + consumerTelemetry.worker_busy_ms,
        wall_ms: substrateTelemetry.wall_ms + consumerTelemetry.wall_ms,
        retries: substrateTelemetry.retries + consumerTelemetry.retries,
        timeouts: substrateTelemetry.timeouts + consumerTelemetry.timeouts,
        cancelled: substrateTelemetry.cancelled + consumerTelemetry.cancelled,
        blocked: substrateTelemetry.blocked + consumerTelemetry.blocked,
        serial_fallback: substrateTelemetry.serial_fallback && consumerTelemetry.serial_fallback,
        phases: {
          repository_index: substrateTelemetry,
          analysis_dag: consumerTelemetry,
          python_static: performance.python_static_intelligence,
          tsjs_static: performance.tsjs_static_intelligence,
          jvm_static: performance.jvm_static_intelligence,
        },
        git_history_execution: "async-batched-git-processes-auto-saturation-max4",
        git_history_cancellation: "cooperative-process-tree-cleanup",
      };
    })(),
  };
  const staticStageForPublication = incrementalSession !== null && staticResult.value.stage !== null
    && pythonStaticResult?.dependency_snapshot
    ? incrementalStatePrivate.withStaticDependencySnapshot(
      staticResult.value.stage,
      pythonStaticResult.dependency_snapshot,
    )
    : staticResult.value.stage;
  const artifacts = [
    { label: "SNAPSHOT", path: snapshotPath, bytes: snapshotBytes },
    ...(options.reportMode === "generate" ? [{ label: "REPORT", path: reportPath, bytes: reportBytes }] : []),
    { label: "CACHE", path: cachePath, bytes: snapshotBytes },
    ...(assessment === null ? [] : [{ label: "ASSESSMENT", path: assessmentPath, bytes: assessmentBytes }]),
    ...(options.performanceJson ? [{ label: "PERFORMANCE", path: options.performanceJson, bytes: serializedJson(performanceArtifact) }] : []),
    ...(predictiveAutoResult?.artifact_bytes === null || predictiveAutoResult?.artifact_bytes === undefined ? [] : [{
      label: "PREDICTIVE",
      path: path.join(options.out, "predictive", `${snapshot.snapshot_id}.json`),
      bytes: predictiveAutoResult.artifact_bytes,
    }]),
    ...pythonAnalyzerCache.artifacts(),
    ...(incrementalSession === null ? [] : [staticStageForPublication, gitResult.value.stage]
      .filter((stage) => stage !== null)
      .map((stage) => incrementalStatePrivate.artifactForStage({
        output_root: options.out,
        state_root: stateRoot,
        repository_id: resolvedRepositoryId,
        stage,
      }))),
  ];
  checkExecutionSignal(signal);
  let preflightMeasurement;
  let publicationMeasurement;
  let artifactTelemetry;
  if (incrementalSession === null) {
    preflightMeasurement = phaseRecorder.measureDetachedSync(() => preflightArtifacts(artifacts));
    checkExecutionSignal(signal);
    publicationMeasurement = phaseRecorder.measureDetachedSync(() => (
      publishArtifacts(artifacts, preflightMeasurement.value.existingByPath)
    ));
    artifactTelemetry = {
      ...preflightMeasurement.value.telemetry,
      ...publicationMeasurement.value,
    };
  } else {
    const directEvidenceOnlyPublication = options.evidenceOnly && incrementalSession.exact_bundle === null;
    if (directEvidenceOnlyPublication) {
      preflightMeasurement = phaseRecorder.measureDetachedSync(() => preflightArtifacts(artifacts));
      publicationMeasurement = phaseRecorder.measureDetachedSync(() => publishArtifacts(
        artifacts,
        preflightMeasurement.value.existingByPath,
      ));
      artifactTelemetry = {
        ...preflightMeasurement.value.telemetry,
        ...publicationMeasurement.value,
      };
    } else {
      preflightMeasurement = { duration_ms: 0, value: null };
      const replayManifest = options.evidenceOnly
        && incrementalSession.exact_bundle !== null
        && incrementalSession.exact_bundle !== undefined
        && incrementalSession.exact_bundle.assessment !== null
        ? {
            label: incrementalSession.exact_bundle.manifest_label,
            path: incrementalSession.exact_bundle.manifest_path,
            bytes: incrementalSession.exact_bundle.manifest_bytes,
          }
        : null;
      publicationMeasurement = phaseRecorder.measureDetachedSync(() => replayManifest === null
        ? incrementalSession.publish({
            artifacts,
            post_automatic_baseline_inventory_binding: incrementalStatePrivate.automaticBaselineInventoryBinding(options.out, [{
              name: path.basename(snapshotPath),
              bytes: snapshotBytes,
            }], stateRoot),
            result: {
              snapshot_id: snapshot.snapshot_id,
              revision: repository.revision,
              comparison,
            },
          })
        : incrementalSession.publish({ artifacts, manifest: replayManifest }));
      artifactTelemetry = publicationMeasurement.value;
    }
  }
  const returnedPhaseTelemetry = phaseRecorder.finalTelemetry(
    prepublicationPhaseTelemetry,
    preflightMeasurement.duration_ms,
    publicationMeasurement.duration_ms,
  );
  return {
    snapshot_id: snapshot.snapshot_id,
    revision: repository.revision,
    assessment_id: assessment?.assessment_id ?? null,
    assessment_path: assessmentPath,
    assessment: assessment === null ? { state: "not-assessed", reason: "evidence-only mode was requested" } : {
      state: assessment.overview.maturity,
        score: assessment.overview.score,
        coverage: assessment.overview.coverage,
        confidence: assessment.overview.confidence,
        trajectory: assessment.trajectory.state,
        assessed_criterion_rate: assessment.coverage_accounting?.assessed_criterion_rate ?? null,
        coverage_gate: assessment.coverage_accounting?.coverage_gate?.status ?? "not_met",
      },
    cache,
    snapshot_path: snapshotPath,
    report_path: options.reportMode === "generate" ? reportPath : null,
    predictive: forwardTemporalBundlePath !== null
      ? { mode: "explicit", state: "evaluated", cache_status: null, fold_count: 0, forecast_count: 0 }
      : {
          mode: options.predictive,
          state: predictiveAutoResult?.status ?? "disabled",
          reason: predictiveAutoResult?.reason ?? null,
          cache_status: predictiveAutoResult?.cache_status ?? null,
          fold_count: predictiveAutoResult?.receipt?.folds?.length ?? 0,
          forecast_count: predictiveAutoResult?.current_rankings?.reduce((sum, ranking) => sum + ranking.items.length, 0) ?? 0,
          telemetry: predictiveAutoResult?.telemetry ?? null,
        },
    comparison,
    performance: {
      ...performance,
      phase_telemetry: returnedPhaseTelemetry,
      artifacts: artifactTelemetry,
    },
  };
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    if (predictiveStateWriter !== null) await predictiveStateWriter.close();
    if (incrementalSession !== null) await incrementalSession.close();
    // Last, so the closers above cannot re-create files under a directory just removed.
    if (runFailed && createdOutputRoot !== null) {
      try { fs.rmSync(createdOutputRoot, { recursive: true, force: true }); } catch { /* unpublished output rollback is best effort */ }
    }
  }
}

async function execute(argv) {
  return executeWithExecutor(argv, new TaskExecutor({
    maxWorkers: "auto",
    groupLimits: {
      "git-tree-index": 1,
      "git-history": 1,
      "git-blob-read": 4,
      "language-analyzer": 2,
      "duplication-analysis": 1,
    },
  }));
}

module.exports = { execute, parseArguments };
Object.defineProperty(module.exports, Symbol.for("sei.cli.private.v1"), {
  value: Object.freeze({
    derivePackageId,
    executeWithExecutor,
    executionContractHash,
    executionContractPaths,
    resolveJvmRuntime,
    resolvePythonRuntime,
    resolveTsjsRuntime,
    shortStagePrefix,
  }),
});
