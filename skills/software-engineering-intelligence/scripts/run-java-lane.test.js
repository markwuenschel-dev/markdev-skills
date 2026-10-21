"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { runJavaLane } = require("./run-java-lane");
const Core = require("../internal/java-lane-core");
const { evaluateJavaLaneFixture, runJavaLaneFixture } = require("../test-support/java-lane-harness");

const RUNNER = path.join(__dirname, "run-java-lane.js");
const PINNED = Object.freeze({
  platform: "fixture-os",
  vendor: "fixture-vendor",
  runtime_version: "25.0.3+fixture",
  java_sha256: "a".repeat(64),
  javac_sha256: "b".repeat(64),
});
const TAP_PASS = "TAP version 13\nok 1 - fixture\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";

test("JDK 21 and missing compilers are portable conditional-unavailable outcomes", () => {
  for (const identity of [
    { platform: "fixture-os", java_runtime_version: "21.0.8", java_vendor: "fixture-vendor", compiler_available: true },
    { platform: "fixture-os", java_runtime_version: "25.0.3", java_vendor: "fixture-vendor", compiler_available: false },
    { platform: "fixture-os", java_runtime_version: null, java_vendor: null, compiler_available: false },
  ]) {
    const receipt = evaluateJavaLaneFixture(identity, PINNED);
    assert.equal(receipt.schema_version, "sei-java-lane-receipt@2");
    assert.equal(receipt.status, "conditional-unavailable");
    assert.equal(receipt.capability.status, "unavailable");
  }
});

test("an unpinned JDK 25 is rejected before integration tests execute", () => {
  withJavaFixture((fixture) => {
    let calls = 0;
    const receipt = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: { ...fixture.pinned, java_sha256: "c".repeat(64) }, execute: (command) => { calls += 1; assert.equal(command, fixture.java); return fixture.identityOutput; } });
    assert.equal(receipt.status, "toolchain-mismatch");
    assert.equal(calls, 1, "only identity admission may execute");
  });
});

test("each pinned-toolchain clause independently rejects a mismatch before tests run", () => {
  withJavaFixture((fixture) => {
    for (const field of ["platform", "runtime_version", "vendor", "java_sha256", "javac_sha256"]) {
      let calls = 0;
      const drifted = field.endsWith("sha256") ? "d".repeat(64) : `drifted-${field}`;
      const receipt = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: { ...fixture.pinned, [field]: drifted }, execute: () => { calls += 1; return fixture.identityOutput; } });
      assert.equal(receipt.status, "toolchain-mismatch", field);
      assert.deepEqual(receipt.mismatches, [field], field);
      assert.equal(calls, 1, `${field}: tests must not run`);
    }
  });
});

test("the exact pinned JDK 25 executes the hermetic integration tests with a TAP proof", () => {
  withJavaFixture((fixture) => {
    let calls = 0;
    const receipt = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, execute: (command, args, options) => {
      calls += 1;
      if (calls === 1) { assert.equal(command, fixture.java); assert.equal(options.timeout, 30_000); return fixture.identityOutput; }
      assert.equal(command, process.execPath);
      assert(args.includes("--test-reporter=tap"));
      assert(args.includes("shared/software-engineering-intelligence/analyzers/java-ast-protocol.test.js"));
      assert.equal(options.timeout, 270_000);
      assert.equal(options.env.SEI_JAVA_25, fixture.java, "the admitted executable must be propagated into the test lane");
      assert.equal(options.env.SEI_JAVA_25_HOME, fixture.home);
      return { status: 0, stdout: TAP_PASS, stderr: "" };
    } });
    assert.equal(calls, 2);
    assert.equal(receipt.schema_version, "sei-java-lane-receipt@2");
    assert.equal(receipt.status, "pass");
    assert.equal(receipt.exit_code, 0);
    assert.deepEqual({ total: receipt.tap.total, passed: receipt.tap.passed, failed: receipt.tap.failed }, { total: 1, passed: 1, failed: 0 });
  });
});

test("exit 0 without a TAP summary of executed tests is a failure, not a pass", () => {
  withJavaFixture((fixture) => {
    for (const [label, testResult] of [
      ["empty output", { status: 0, stdout: "", stderr: "" }],
      ["zero tests", { status: 0, stdout: "1..0\n# tests 0\n# pass 0\n# fail 0\n# skipped 0\n", stderr: "" }],
      ["failed test with exit 0", { status: 0, stdout: "not ok 1 - x\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n", stderr: "" }],
    ]) {
      let calls = 0;
      const receipt = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, execute: () => (++calls === 1 ? fixture.identityOutput : testResult) });
      assert.equal(receipt.status, "fail", label);
    }
  });
});

test("both spawns receive only the allowlisted environment", () => {
  withJavaFixture((fixture) => {
    const environment = {
      PATH: "fixture-path", TEMP: "fixture-temp", SECRET_TOKEN: "leak",
      NODE_OPTIONS: "--require evil.js", NODE_PATH: "evil", JAVA_TOOL_OPTIONS: "-javaagent:evil.jar", JDK_JAVA_OPTIONS: "-Devil", _JAVA_OPTIONS: "-Devil",
    };
    const seen = [];
    const receipt = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, environment, execute: (command, args, options) => {
      seen.push(options.env);
      return seen.length === 1 ? fixture.identityOutput : { status: 0, stdout: TAP_PASS, stderr: "" };
    } });
    assert.equal(receipt.status, "pass");
    assert.equal(seen.length, 2);
    for (const env of seen) {
      for (const name of Object.keys(env)) assert.ok(Core.ENVIRONMENT_ALLOWLIST.includes(name), `${name} must not reach the spawn`);
      assert.equal(env.PATH, "fixture-path");
      for (const name of ["NODE_OPTIONS", "NODE_PATH", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "SECRET_TOKEN"]) assert.equal(env[name], undefined, name);
    }
  });
});

test("a NODE_OPTIONS preload that exits 0 cannot fake a pass", () => {
  withJavaFixture((fixture) => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-java-lane-repo-"));
    try {
      for (const relative of Core.HERMETIC_TESTS) {
        const file = path.join(repositoryRoot, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'require("node:test")("fixture passes", () => {});\n');
      }
      const preload = path.join(repositoryRoot, "exit-zero.js");
      fs.writeFileSync(preload, "process.exit(0);\n");
      const environment = { ...Core.scrubEnvironment(process.env), NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
      const realSpawn = (command, args, options) => spawnSync(command, args, options);

      // Production path: the preload is scrubbed, so real tests run and pass.
      let calls = 0;
      const scrubbed = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, repository_root: repositoryRoot, environment, execute: (...call) => (++calls === 1 ? fixture.identityOutput : realSpawn(...call)) });
      assert.equal(scrubbed.status, "pass", scrubbed.stderr);
      assert.equal(scrubbed.tap.total, 2);

      // Defence in depth: even if the preload reached the child, exit 0 with no TAP is not a pass.
      calls = 0;
      const injected = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, repository_root: repositoryRoot, environment, execute: (command, args, options) => (++calls === 1 ? fixture.identityOutput : realSpawn(command, args, { ...options, env: { ...options.env, NODE_OPTIONS: environment.NODE_OPTIONS } })) });
      assert.equal(injected.exit_code, 0, "the preload really did exit 0");
      assert.equal(injected.status, "fail");
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});

test("spawn errors and signals are recorded in the receipt", () => {
  withJavaFixture((fixture) => {
    let calls = 0;
    const timedOut = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, execute: () => (++calls === 1
      ? fixture.identityOutput
      : { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" }) });
    assert.equal(timedOut.status, "fail");
    assert.equal(timedOut.exit_code, null);
    assert.equal(timedOut.spawn_error, "ETIMEDOUT");
    assert.equal(timedOut.signal, "SIGTERM");

    const missing = runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, execute: () => ({ status: null, signal: null, error: Object.assign(new Error("spawnSync java ENOENT"), { code: "ENOENT" }) }) });
    assert.equal(missing.status, "conditional-unavailable");
    assert.equal(missing.identity.spawn_error, "ENOENT");
  });
});

test("conflicting configured home and executable identities fail closed", () => {
  withJavaFixture((fixture) => {
    const other = path.join(path.dirname(fixture.home), "other", "bin", path.basename(fixture.java));
    assert.throws(() => runJavaLaneFixture({ java_home: fixture.home, java_executable: other, pinned_toolchain: fixture.pinned, execute: () => fixture.identityOutput }), /FAIL-SEI-JAVA-EXECUTABLE-CONFLICT/);
  });
});

test("a configured home that disagrees with the reported java.home fails closed", () => {
  withJavaFixture((fixture) => {
    const elsewhere = { status: 0, stdout: "", stderr: fixture.identityOutput.stderr.replace(`java.home = ${fixture.home}`, `java.home = ${path.join(path.dirname(fixture.home), "elsewhere")}`) };
    assert.throws(() => runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, execute: () => elsewhere }), /FAIL-SEI-JAVA-HOME-CONFLICT/);
  });
});

test("identity output without java.home is unresolved and fails closed", () => {
  withJavaFixture((fixture) => {
    const noHome = { status: 0, stdout: "", stderr: fixture.identityOutput.stderr.replace(/^.*java\.home.*$/m, "") };
    assert.throws(() => runJavaLaneFixture({ java_home: fixture.home, pinned_toolchain: fixture.pinned, execute: () => noHome }), /FAIL-SEI-JAVA-HOME-UNRESOLVED/);
  });
});

test("relative configured Java paths are rejected before any spawn", () => {
  let calls = 0;
  const execute = () => { calls += 1; return { status: 0 }; };
  assert.throws(() => runJavaLaneFixture({ java_executable: path.join("bin", "java"), pinned_toolchain: PINNED, execute }), /FAIL-SEI-JAVA-EXECUTABLE-RELATIVE/);
  assert.throws(() => runJavaLaneFixture({ java_home: "relative-home", pinned_toolchain: PINNED, execute }), /FAIL-SEI-JAVA-HOME-RELATIVE/);
  assert.equal(calls, 0);
});

test("CRLF identity output is parsed exactly", () => {
  withJavaFixture((fixture) => {
    const crlf = { status: 0, stdout: "", stderr: fixture.identityOutput.stderr.replace(/\n/g, "\r\n") };
    const identity = Core.detectJavaIdentity({ execute: () => crlf, javaHome: fixture.home });
    assert.equal(identity.java_runtime_version, "25.0.3+fixture");
    assert.equal(identity.java_vendor, "fixture-vendor");
    assert.equal(evaluateJavaLaneFixture(identity, fixture.pinned).status, "ready");
  });
});

test("the version fallback reads the java -version banner, not an unrelated *.version property", () => {
  withJavaFixture((fixture) => {
    const output = { status: 0, stdout: "", stderr: `    java.class.version = 69.0\n    java.home = ${fixture.home}\n    java.vendor = fixture-vendor\njava version "25.0.3+fixture" 2025-10-21 LTS\r\n` };
    const identity = Core.detectJavaIdentity({ execute: () => output, javaHome: fixture.home });
    assert.equal(identity.java_runtime_version, "25.0.3+fixture");
  });
});

test("identity comparison resolves real paths, so a junctioned home is the same executable", (t) => {
  withJavaFixture((fixture) => {
    const alias = `${fixture.home}-alias`;
    try {
      fs.symlinkSync(fixture.home, alias, "junction");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return t.skip(`junctions unavailable (${error.code})`);
      throw error;
    }
    try {
      const identity = Core.detectJavaIdentity({ execute: () => fixture.identityOutput, javaHome: alias, javaExecutable: fixture.java });
      assert.equal(identity.java_executable_sha256, fixture.pinned.java_sha256);
    } finally {
      try { fs.unlinkSync(alias); } catch { fs.rmdirSync(alias); }
    }
  });
});

test("the pinned toolchain block must be a closed, well-formed key set", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sei-java-pin-"));
  try {
    const manifestPath = path.join(directory, "MANIFEST.json");
    for (const toolchain of [{ ...PINNED, extra: "x" }, { ...PINNED, java_sha256: "not-hex" }, (({ vendor, ...rest }) => rest)(PINNED), null]) {
      fs.writeFileSync(manifestPath, JSON.stringify({ java_toolchain: toolchain }));
      assert.throws(() => Core.loadPinnedToolchain(manifestPath), /FAIL-SEI-JAVA-TOOLCHAIN-MANIFEST/);
    }
    fs.writeFileSync(manifestPath, JSON.stringify({ java_toolchain: PINNED }));
    assert.deepEqual(Core.loadPinnedToolchain(manifestPath), PINNED);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the production entrypoint ignores caller-supplied executors and toolchain identities", () => {
  assert.equal(runJavaLane.length, 0);
  const previousExecutable = process.env.SEI_JAVA_25;
  const previousHome = process.env.SEI_JAVA_25_HOME;
  process.env.SEI_JAVA_25 = path.join(os.tmpdir(), "definitely-missing-sei-java");
  delete process.env.SEI_JAVA_25_HOME;
  try {
    const receipt = runJavaLane({ execute: () => ({ status: 0 }), pinned_toolchain: PINNED, java_home: "caller-home" });
    assert.equal(receipt.status, "conditional-unavailable");
  } finally {
    if (previousExecutable === undefined) delete process.env.SEI_JAVA_25;
    else process.env.SEI_JAVA_25 = previousExecutable;
    if (previousHome === undefined) delete process.env.SEI_JAVA_25_HOME;
    else process.env.SEI_JAVA_25_HOME = previousHome;
  }
});

test("the CLI maps admission errors to exit 3 and unavailable to exit 2 with a JSON receipt", () => {
  const run = (overrides) => {
    const env = { ...Core.scrubEnvironment(process.env), ...overrides };
    delete env.SEI_JAVA_25_HOME;
    const result = spawnSync(process.execPath, [RUNNER], { encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
    return { status: result.status, receipt: JSON.parse(result.stdout.trim()) };
  };
  const admission = run({ SEI_JAVA_25: path.join("relative", "java") });
  assert.equal(admission.status, 3);
  assert.equal(admission.receipt.status, "admission-error");
  assert.equal(admission.receipt.error_code, "FAIL-SEI-JAVA-EXECUTABLE-RELATIVE");
  assert.equal(admission.receipt.schema_version, "sei-java-lane-receipt@2");

  const unavailable = run({ SEI_JAVA_25: path.join(os.tmpdir(), "definitely-missing-sei-java") });
  assert.equal(unavailable.status, 2);
  assert.equal(unavailable.receipt.status, "conditional-unavailable");
});

function withJavaFixture(body) {
  const fixture = javaFixture();
  try {
    return body(fixture);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
}

function javaFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sei-java-identity-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const java = path.join(bin, process.platform === "win32" ? "java.exe" : "java");
  const javac = path.join(bin, process.platform === "win32" ? "javac.exe" : "javac");
  fs.writeFileSync(java, "fixture-java-binary");
  fs.writeFileSync(javac, "fixture-javac-binary");
  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const runtime = "25.0.3+fixture";
  const vendor = "fixture-vendor";
  return {
    home, java, javac,
    pinned: { platform: process.platform, vendor, runtime_version: runtime, java_sha256: sha(java), javac_sha256: sha(javac) },
    identityOutput: { status: 0, stdout: "", stderr: `    java.home = ${home}\n    java.runtime.version = ${runtime}\n    java.vendor = ${vendor}\n` },
  };
}
