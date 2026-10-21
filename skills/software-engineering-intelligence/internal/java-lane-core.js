"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assessJavaCapability } = require("../../shared/software-engineering-intelligence/runtime-capabilities");
const { parseNodeTap } = require("../../shared/software-engineering-intelligence/autonomous-local-execution");

const RECEIPT_SCHEMA_VERSION = "sei-java-lane-receipt@2";
const HERMETIC_TESTS = Object.freeze([
  "shared/software-engineering-intelligence/analyzers/java-ast-protocol.test.js",
  "shared/software-engineering-intelligence/jvm-static-intelligence.test.js",
]);
const PINNED_TOOLCHAIN_KEYS = Object.freeze(["java_sha256", "javac_sha256", "platform", "runtime_version", "vendor"]);
// Only these variables reach either spawn. Preload/agent hooks (NODE_OPTIONS,
// NODE_PATH, JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS, _JAVA_OPTIONS) can make a
// process exit 0 without running tests, so they are never inherited.
const ENVIRONMENT_ALLOWLIST = Object.freeze(["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "SEI_JAVA_25", "SEI_JAVA_25_HOME"]);
const IDENTITY_TIMEOUT_MS = 30_000;
// Below the 300 s final-gate budget so the lane records its own timeout.
const TEST_TIMEOUT_MS = 270_000;

function loadPinnedToolchain(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const toolchain = manifest.java_toolchain;
  if (
    !toolchain || typeof toolchain !== "object" || Array.isArray(toolchain) ||
    JSON.stringify(Object.keys(toolchain).sort()) !== JSON.stringify(PINNED_TOOLCHAIN_KEYS) ||
    PINNED_TOOLCHAIN_KEYS.some((key) => typeof toolchain[key] !== "string" || toolchain[key].length === 0) ||
    !/^[0-9a-f]{64}$/.test(toolchain.java_sha256) || !/^[0-9a-f]{64}$/.test(toolchain.javac_sha256)
  ) {
    throw new Error("FAIL-SEI-JAVA-TOOLCHAIN-MANIFEST");
  }
  return Object.freeze({ ...toolchain });
}

function scrubEnvironment(environment) {
  const scrubbed = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    if (typeof environment?.[name] === "string") scrubbed[name] = environment[name];
  }
  return scrubbed;
}

function fileSha256(filePath) {
  return fs.existsSync(filePath) ? crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") : null;
}

function sameExecutable(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {}
    resolved = resolved.replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function spawnFacts(result) {
  return {
    spawn_error: result?.error ? String(result.error.code || result.error.message) : null,
    signal: result?.signal ?? null,
  };
}

function detectJavaIdentity({ execute, javaHome = null, javaExecutable = null, environment = {} }) {
  if (javaExecutable && !path.isAbsolute(javaExecutable)) throw new Error("FAIL-SEI-JAVA-EXECUTABLE-RELATIVE");
  if (javaHome && !path.isAbsolute(javaHome)) throw new Error("FAIL-SEI-JAVA-HOME-RELATIVE");
  const executableName = process.platform === "win32" ? "java.exe" : "java";
  const compilerName = process.platform === "win32" ? "javac.exe" : "javac";
  const java = javaExecutable || (javaHome ? path.join(javaHome, "bin", executableName) : null) || "java";
  const result = execute(java, ["-XshowSettings:properties", "-version"], {
    encoding: "utf8",
    env: scrubEnvironment(environment),
    timeout: IDENTITY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (!result || result.status !== 0 || result.error) {
    return Object.freeze({ platform: process.platform, compiler_available: false, java_runtime_version: null, java_vendor: null, java_executable_sha256: null, javac_executable_sha256: null, ...spawnFacts(result) });
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const reportedHome = /^\s*java\.home\s*=\s*(.+)$/m.exec(output)?.[1].trim();
  if (!reportedHome) throw new Error("FAIL-SEI-JAVA-HOME-UNRESOLVED");
  if (javaHome && !sameExecutable(path.join(javaHome, "bin", executableName), path.join(reportedHome, "bin", executableName))) throw new Error("FAIL-SEI-JAVA-HOME-CONFLICT");
  const home = javaHome || reportedHome;
  const resolvedJava = path.join(home, "bin", executableName);
  const compiler = path.join(home, "bin", compilerName);
  if (javaExecutable && !sameExecutable(javaExecutable, resolvedJava)) throw new Error("FAIL-SEI-JAVA-EXECUTABLE-CONFLICT");
  return Object.freeze({
    platform: process.platform,
    compiler_available: fs.existsSync(compiler),
    java_runtime_version: /^\s*java\.runtime\.version\s*=\s*(.+)$/m.exec(output)?.[1].trim() || /(?:openjdk|java) version "([^"]+)"/.exec(output)?.[1] || null,
    java_vendor: /^\s*java\.vendor\s*=\s*(.+)$/m.exec(output)?.[1].trim() || null,
    java_executable: resolvedJava,
    javac_executable: compiler,
    java_executable_sha256: fileSha256(resolvedJava),
    javac_executable_sha256: fileSha256(compiler),
  });
}

function evaluateJavaLane(identity, pinnedToolchain) {
  const capability = assessJavaCapability(identity);
  const mismatches = capability.status !== "available" ? [] : [
    ["platform", identity.platform, pinnedToolchain.platform],
    ["runtime_version", identity.java_runtime_version, pinnedToolchain.runtime_version],
    ["vendor", identity.java_vendor, pinnedToolchain.vendor],
    ["java_sha256", identity.java_executable_sha256, pinnedToolchain.java_sha256],
    ["javac_sha256", identity.javac_executable_sha256, pinnedToolchain.javac_sha256],
  ].filter(([, actual, expected]) => actual !== expected).map(([field]) => field);
  return Object.freeze({
    schema_version: RECEIPT_SCHEMA_VERSION,
    lane: "hermetic-jdk25-integration",
    status: capability.status !== "available" ? "conditional-unavailable" : (mismatches.length === 0 ? "ready" : "toolchain-mismatch"),
    capability,
    identity: Object.freeze({ ...identity }),
    pinned_toolchain: Object.freeze({ ...pinnedToolchain }),
    mismatches: Object.freeze(mismatches),
    tests: HERMETIC_TESTS,
  });
}

function runJavaLaneCore({ execute, pinnedToolchain, javaHome, javaExecutable, repositoryRoot, environment }) {
  const identity = detectJavaIdentity({ execute, javaHome, javaExecutable, environment });
  const admission = evaluateJavaLane(identity, pinnedToolchain);
  if (admission.status !== "ready") return admission;
  if (!path.isAbsolute(identity.java_executable || "") || !path.isAbsolute(identity.javac_executable || "")) throw new Error("FAIL-SEI-JAVA-EXECUTION-IDENTITY");
  const result = execute(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...HERMETIC_TESTS], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...scrubEnvironment(environment),
      SEI_JAVA_25: identity.java_executable,
      SEI_JAVA_25_HOME: path.dirname(path.dirname(identity.java_executable)),
    },
  });
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  const exitCode = typeof result?.status === "number" ? result.status : null;
  const tap = parseNodeTap(stdout, stderr, exitCode);
  const facts = spawnFacts(result);
  // A zero exit is not proof: the TAP summary must show tests actually ran.
  const passed = exitCode === 0 && facts.spawn_error === null && facts.signal === null
    && tap !== null && tap.total > 0 && tap.failed === 0 && tap.passed === tap.total;
  return Object.freeze({
    ...admission,
    status: passed ? "pass" : "fail",
    exit_code: exitCode,
    ...facts,
    tap: tap === null ? null : Object.freeze({ ...tap }),
    stdout: stdout.slice(-16384),
    stderr: stderr.slice(-16384),
  });
}

module.exports = Object.freeze({
  ENVIRONMENT_ALLOWLIST,
  HERMETIC_TESTS,
  RECEIPT_SCHEMA_VERSION,
  detectJavaIdentity,
  evaluateJavaLane,
  loadPinnedToolchain,
  runJavaLaneCore,
  scrubEnvironment,
});
