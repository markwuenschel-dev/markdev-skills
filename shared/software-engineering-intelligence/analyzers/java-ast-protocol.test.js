"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  JAVA_AST_ANALYZER_VERSION,
  JAVA_AST_PROTOCOL_VERSION,
  PARSER_RUNTIME,
  GRAMMAR_TARGET,
  encodeJavaAstRequest,
  probeJavaAstRuntime,
  analyzeJavaAstBatch,
  decodeJavaAstResponse,
} = require("./java-ast-protocol.js");

const fixtureRoot = path.join(__dirname, "..", "fixtures", "jvm-static");

function java25() {
  const configured = process.env.SEI_JAVA_25;
  let executable = configured;
  if (!executable) {
    const lookup = process.platform === "win32"
      ? spawnSync("where.exe", ["java"], { encoding: "utf8", windowsHide: true })
      : spawnSync("sh", ["-c", "command -v java"], { encoding: "utf8" });
    assert.equal(lookup.status, 0, `JDK 25 java is required for this focused test: ${lookup.stderr}`);
    executable = lookup.stdout.split(/\r?\n/).find(Boolean);
  }
  assert.equal(path.isAbsolute(executable), true, "SEI_JAVA_25/java lookup must resolve an absolute path");
  const settings = spawnSync(executable, ["-XshowSettings:properties", "-version"], { encoding: "utf8", windowsHide: true });
  assert.equal(settings.status, 0, settings.stderr);
  const javaHome = /^\s*java\.home\s*=\s*(.+)$/m.exec(`${settings.stdout}${settings.stderr}`)?.[1].trim();
  assert.ok(javaHome, "java launcher must report java.home");
  executable = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  assert.equal(fs.existsSync(executable), true, "java.home must contain the owned runtime executable");
  const version = spawnSync(executable, ["-version"], { encoding: "utf8", windowsHide: true });
  assert.equal(version.status, 0, version.stderr);
  assert.match(`${version.stdout}${version.stderr}`, /(?:version |openjdk )"?25\./);
  return executable;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function gitBlobOid(bytes, algorithm = "sha1") {
  return crypto.createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`, "utf8")).update(bytes).digest("hex");
}

function protocolFile(ordinal, bytes) {
  const blobOid = gitBlobOid(bytes);
  return { ordinal, contentKey: `git-blob:sha1:${blobOid}`, blobOid, bytes };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function responseFrame(value) {
  const body = Buffer.from(canonicalJson(value), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from("SEIJVR1\0", "ascii"), length, body]);
}

function bundledAnalyzerPath() {
  return path.join(__dirname, "JavaAstAnalyzer.java");
}

function analyzerSourceHash(analyzerPath = bundledAnalyzerPath()) {
  return sha256(fs.readFileSync(analyzerPath));
}

function parseRequestMetadata(frame) {
  let offset = 8;
  const requestIdLength = frame.readUInt16BE(offset); offset += 2;
  const requestId = frame.subarray(offset, offset + requestIdLength).toString("utf8"); offset += requestIdLength;
  const indexDigest = `sha256:${frame.subarray(offset, offset + 32).toString("hex")}`; offset += 32;
  const grammarTarget = frame.readUInt16BE(offset); offset += 2;
  const maxFileBytes = frame.readUInt32BE(offset); offset += 4;
  const fileCount = frame.readUInt16BE(offset); offset += 2;
  const maxBatchBytes = frame.readUInt32BE(offset); offset += 4;
  const files = [];
  for (let index = 0; index < fileCount; index += 1) {
    const ordinal = frame.readUInt16BE(offset); offset += 2;
    const oidAlgorithm = frame.readUInt8(offset); offset += 1;
    const oidBytes = oidAlgorithm === 1 ? 20 : 32;
    const blobOid = frame.subarray(offset, offset + oidBytes).toString("hex"); offset += oidBytes;
    const contentKeyLength = frame.readUInt16BE(offset); offset += 2;
    const contentKey = frame.subarray(offset, offset + contentKeyLength).toString("utf8"); offset += contentKeyLength;
    const byteLength = frame.readUInt32BE(offset); offset += 4;
    const sourceSha256 = frame.subarray(offset, offset + 32).toString("hex"); offset += 32;
    files.push({ ordinal, oidAlgorithm, blobOid, contentKey, byteLength, sourceSha256 });
  }
  return { requestId, indexDigest, grammarTarget, maxFileBytes, fileCount, maxBatchBytes, files, sourceOffset: offset };
}

function actualRuntimeFixture(sourceHash = `sha256:${"a".repeat(64)}`) {
  return {
    analyzer_source_sha256: sourceHash,
    analyzer_version: "sei.java-ast@1",
    compiler_implementation: "com.sun.tools.javac.api.JavacTool",
    direct_process_executable: true,
    grammar_target: 25,
    java_runtime_version: "25.0.3+9-LTS-195",
    java_vendor: "Oracle Corporation",
    parser_runtime: "jdk.compiler",
    protocol: "sei.java-ast@1",
  };
}

function validResponse(file, runtime = actualRuntimeFixture(), requestId = "decode-fixture", indexDigest = `sha256:${"9".repeat(64)}`) {
  return {
    analyzer_source_sha256: runtime.analyzer_source_sha256,
    analyzer_version: runtime.analyzer_version,
    compiler_implementation: runtime.compiler_implementation,
    diagnostics: { files_failed: 0, files_received: 1, files_succeeded: 1 },
    direct_process_executable: runtime.direct_process_executable,
    grammar_target: runtime.grammar_target,
    index_digest: indexDigest,
    java_runtime_version: runtime.java_runtime_version,
    java_vendor: runtime.java_vendor,
    parser_runtime: runtime.parser_runtime,
    protocol: runtime.protocol,
    request_id: requestId,
    results: [{
      callables: [],
      content_key: file.contentKey,
      imports: [],
      ordinal: 0,
      package_name: null,
      sha256: crypto.createHash("sha256").update(file.bytes).digest("hex"),
      status: "ok",
    }],
    status: "ok",
  };
}

test("Java AST protocol locks a JDK 25 compiler-tree contract", () => {
  assert.equal(JAVA_AST_ANALYZER_VERSION, "sei.java-ast@1");
  assert.equal(JAVA_AST_PROTOCOL_VERSION, "sei.java-ast@1");
  assert.equal(PARSER_RUNTIME, "jdk.compiler");
  assert.equal(GRAMMAR_TARGET, 25);
});

test("request framing is bounded, pathless, ordinal ordered, and bound to Git blob identities", () => {
  const first = protocolFile(0, Buffer.from("class A {}\n", "utf8"));
  const second = protocolFile(1, Buffer.from("class B {}\n", "utf8"));
  const frame = encodeJavaAstRequest({
    requestId: "frame-fixture",
    indexDigest: `sha256:${"b".repeat(64)}`,
    files: [second, first],
  });
  assert.equal(frame.subarray(0, 8).toString("ascii"), "SEIJVA1\0");
  const metadata = parseRequestMetadata(frame);
  assert.deepEqual(metadata.files.map((file) => file.ordinal), [0, 1]);
  assert.deepEqual(metadata.files.map((file) => file.contentKey), [first.contentKey, second.contentKey]);
  assert.deepEqual(metadata.files.map((file) => file.sourceSha256), [
    crypto.createHash("sha256").update(first.bytes).digest("hex"),
    crypto.createHash("sha256").update(second.bytes).digest("hex"),
  ]);
  assert.equal(metadata.grammarTarget, 25);
  assert.equal(metadata.indexDigest, `sha256:${"b".repeat(64)}`);
  assert.deepEqual(frame.subarray(metadata.sourceOffset), Buffer.concat([first.bytes, second.bytes]));
  assert.equal(frame.includes(Buffer.from("src/main/java/A.java", "utf8")), false);
  assert.throws(() => encodeJavaAstRequest({
    requestId: "bad-path-field",
    indexDigest: `sha256:${"b".repeat(64)}`,
    files: [{ ...first, path: "src/main/java/A.java" }],
  }), /FAIL-JAVA-AST-CONFIG.*unexpected field path/);
  assert.throws(() => encodeJavaAstRequest({
    requestId: "forged-blob",
    indexDigest: `sha256:${"b".repeat(64)}`,
    files: [{ ...first, bytes: Buffer.from("class Forged {}\n") }],
  }), /FAIL-JAVA-AST-CONFIG.*bytes do not match blobOid/);
});

test("runtime probe admits the minimum JDK 25 compiler-tree capability", { timeout: 30_000 }, async () => {
  const identity = await probeJavaAstRuntime({ javaExecutable: java25() });
  assert.deepEqual(identity, {
    analyzer_source_sha256: analyzerSourceHash(),
    analyzer_version: JAVA_AST_ANALYZER_VERSION,
    compiler_implementation: "com.sun.tools.javac.api.JavacTool",
    direct_process_executable: true,
    grammar_target: GRAMMAR_TARGET,
    java_runtime_version: identity.java_runtime_version,
    java_vendor: identity.java_vendor,
    parser_runtime: PARSER_RUNTIME,
    protocol: JAVA_AST_PROTOCOL_VERSION,
  });
  assert.ok(Number(identity.java_runtime_version.split(".")[0]) >= 25);
  assert.ok(identity.java_vendor.length > 0);
  await assert.rejects(
    probeJavaAstRuntime({ javaExecutable: process.execPath }),
    /FAIL-JAVA-AST-RUNTIME/,
  );
});

test("compiler AST analysis returns hand-authored callable spans, cyclomatic values, and imports", { timeout: 30_000 }, async () => {
  const source = fs.readFileSync(path.join(fixtureRoot, "java", "ComplexityFixture.java"));
  const expected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "java.expected.json"), "utf8"));
  const response = await analyzeJavaAstBatch({
    javaExecutable: java25(),
    requestId: "complexity-fixture",
    indexDigest: `sha256:${"c".repeat(64)}`,
    files: [protocolFile(0, source)],
  });
  assert.equal(response.status, "ok");
  const result = response.results[0];
  assert.equal(result.package_name, expected.package_name);
  assert.deepEqual(result.imports.map((fact) => ({
    qualified_name: fact.qualified_name,
    static: fact.static,
    wildcard: fact.wildcard,
    start_line: fact.start_line,
    end_line: fact.end_line,
  })), expected.imports);
  assert.deepEqual(result.callables.map((fact) => ({
    kind: fact.kind,
    qualified_name: fact.qualified_name,
    complexity: fact.complexity,
    start_line: fact.start_line,
    end_line: fact.end_line,
  })), expected.callables);
  for (const fact of [...result.callables, ...result.imports]) {
    assert.ok(fact.start_offset >= 0 && fact.end_offset > fact.start_offset);
    assert.ok(fact.start_line >= 1 && fact.start_column >= 1);
    assert.ok(fact.end_line >= fact.start_line && fact.end_column >= 1);
  }
});

test("malformed and non-UTF-8 sources fail per file without contaminating valid AST facts", { timeout: 30_000 }, async () => {
  const valid = Buffer.from("package ok; class Good { int value() { return 1; } }\n", "utf8");
  const malformed = fs.readFileSync(path.join(fixtureRoot, "java", "Malformed.java"));
  const invalidUtf8 = Buffer.from([0x63, 0x6c, 0x61, 0x73, 0x73, 0x20, 0xff]);
  const response = await analyzeJavaAstBatch({
    javaExecutable: java25(),
    requestId: "partial-fixture",
    indexDigest: `sha256:${"d".repeat(64)}`,
    files: [protocolFile(0, valid), protocolFile(1, malformed), protocolFile(2, invalidUtf8)],
  });
  assert.equal(response.status, "partial");
  assert.deepEqual(response.results.map((result) => result.status), ["ok", "error", "error"]);
  assert.equal(response.results[0].callables[0].qualified_name, "ok.Good.value()");
  assert.match(response.results[1].error.code, /^FAIL-JAVA-AST-PARSE$/);
  assert.match(response.results[1].error.compiler_code, /^compiler\./);
  assert.equal(response.results[2].error.code, "FAIL-JAVA-AST-ENCODING");
  assert.equal(response.results[2].error.compiler_code, null);
});

test("response decoder rejects identity, binding, shape, ordering, count, and framing attacks", () => {
  const file = protocolFile(0, Buffer.from("class A {}\n"));
  const runtime = actualRuntimeFixture();
  const indexDigest = `sha256:${"9".repeat(64)}`;
  const expectations = { files: [file], indexDigest, requestId: "decode-fixture", runtimeIdentity: runtime };
  const valid = validResponse(file, runtime, "decode-fixture", indexDigest);
  assert.deepEqual(decodeJavaAstResponse(responseFrame(valid), expectations), valid);
  const attacks = [
    ["identity", (value) => { value.analyzer_version = "sei.java-ast@2"; }],
    ["runtime", (value) => { value.java_runtime_version = "25.0.4"; }],
    ["index binding", (value) => { value.index_digest = `sha256:${"8".repeat(64)}`; }],
    ["content binding", (value) => { value.results[0].content_key = `git-blob:sha1:${"f".repeat(40)}`; }],
    ["sha binding", (value) => { value.results[0].sha256 = "0".repeat(64); }],
    ["unexpected field", (value) => { value.results[0].path = "secret.java"; }],
    ["span beyond source", (value) => { value.results[0].callables = [{
      complexity: 1,
      end_column: 1,
      end_line: 1,
      end_offset: 999,
      kind: "method",
      qualified_name: "A.a()",
      start_column: 1,
      start_line: 1,
      start_offset: 0,
    }]; }],
    ["diagnostic count", (value) => { value.diagnostics.files_succeeded = 0; }],
    ["status count", (value) => { value.status = "partial"; }],
  ];
  for (const [name, mutate] of attacks) {
    const attacked = structuredClone(valid);
    mutate(attacked);
    assert.throws(() => decodeJavaAstResponse(responseFrame(attacked), expectations), /FAIL-JAVA-AST-PROTOCOL/, name);
  }
  const trailing = Buffer.concat([responseFrame(valid), Buffer.from([0])]);
  assert.throws(() => decodeJavaAstResponse(trailing, expectations), /FAIL-JAVA-AST-PROTOCOL/);
  const noncanonicalBody = Buffer.from(JSON.stringify({ ...valid, aaa: null }), "utf8");
  const noncanonicalLength = Buffer.alloc(4); noncanonicalLength.writeUInt32BE(noncanonicalBody.length);
  assert.throws(() => decodeJavaAstResponse(Buffer.concat([
    Buffer.from("SEIJVR1\0"), noncanonicalLength, noncanonicalBody,
  ]), expectations), /FAIL-JAVA-AST-PROTOCOL/);
});

test("bundled analyzer rejects corrupt request framing before emitting a response", { timeout: 30_000 }, () => {
  const file = protocolFile(0, Buffer.from("class A {}\n"));
  const frame = encodeJavaAstRequest({
    requestId: "raw-hostile",
    indexDigest: `sha256:${"e".repeat(64)}`,
    files: [file],
  });
  const mutations = [
    ["magic", () => { const value = Buffer.from(frame); value[0] ^= 0xff; return value; }],
    ["truncated", () => frame.subarray(0, frame.length - 1)],
    ["trailing", () => Buffer.concat([frame, Buffer.from([0])])],
    ["source hash", () => { const value = Buffer.from(frame); value[value.length - 1] ^= 1; return value; }],
  ];
  for (const [name, mutate] of mutations) {
    const javaExecutable = java25();
    const result = spawnSync(javaExecutable, [bundledAnalyzerPath(), "--analyze", analyzerSourceHash(), javaExecutable], {
      input: mutate(), encoding: null, timeout: 10_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0, name);
    assert.equal(result.stdout.length, 0, name);
    assert.ok(result.stderr.length > 0 && result.stderr.length <= 4096, name);
  }
});

function javaStringLiteral(value) {
  return JSON.stringify(value).replaceAll("\\/", "/");
}

function writeSleepingAnalyzer(root, markerPrefix) {
  const analyzerPath = path.join(root, "SleepingAnalyzer.java");
  const parentMarker = `${markerPrefix}-parent.txt`;
  const childMarker = `${markerPrefix}-child.txt`;
  const source = `
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import javax.tools.ToolProvider;

class SleepingAnalyzer {
  static String quote(String value) { return "\\\"" + value.replace("\\\\", "\\\\\\\\").replace("\\\"", "\\\\\\\"") + "\\\""; }
  public static void main(String[] args) throws Exception {
    if (args[0].equals("--child")) {
      Files.writeString(Path.of(args[1]), Long.toString(ProcessHandle.current().pid()), StandardCharsets.UTF_8);
      Thread.sleep(120000);
      return;
    }
    if (args[0].equals("--probe")) {
      String json = "{\\\"analyzer_source_sha256\\\":" + quote(args[1])
        + ",\\\"analyzer_version\\\":\\\"sei.java-ast@1\\\""
        + ",\\\"compiler_implementation\\\":" + quote(ToolProvider.getSystemJavaCompiler().getClass().getName())
        + ",\\\"direct_process_executable\\\":true"
        + ",\\\"grammar_target\\\":25"
        + ",\\\"java_runtime_version\\\":" + quote(System.getProperty("java.runtime.version"))
        + ",\\\"java_vendor\\\":" + quote(System.getProperty("java.vendor"))
        + ",\\\"parser_runtime\\\":\\\"jdk.compiler\\\""
        + ",\\\"protocol\\\":\\\"sei.java-ast@1\\\"}";
      System.out.print(json);
      return;
    }
    String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + (System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java");
    Process child = new ProcessBuilder(java, ${javaStringLiteral(analyzerPath)}, "--child", ${javaStringLiteral(childMarker)}).start();
    Files.writeString(Path.of(${javaStringLiteral(parentMarker)}), Long.toString(ProcessHandle.current().pid()), StandardCharsets.UTF_8);
    Thread.sleep(120000);
  }
}
`;
  fs.writeFileSync(analyzerPath, source);
  return { analyzerPath, parentMarker, childMarker };
}

async function waitForPid(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (fs.existsSync(filePath)) {
      const marker = fs.readFileSync(filePath, "utf8").trim();
      if (/^[1-9]\d*$/.test(marker)) {
        const pid = Number(marker);
        if (Number.isSafeInteger(pid)) return pid;
      }
    }
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("PID marker wait does not interpret an existing empty marker as process zero", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-java-pid-marker-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "pid.txt");
  fs.writeFileSync(marker, "");
  const timer = setTimeout(() => fs.writeFileSync(marker, String(process.pid)), 50);
  context.after(() => clearTimeout(timer));
  assert.equal(await waitForPid(marker), process.pid);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForDead(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) assert.fail(`process ${pid} survived cancellation`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("pre-abort spawns nothing and in-flight cancellation reaps the analyzer process tree", { timeout: 45_000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-java-ast-cancel-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markers = writeSleepingAnalyzer(root, path.join(root, "marker"));
  const file = protocolFile(0, Buffer.from("class A {}\n"));
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(analyzeJavaAstBatch({
    javaExecutable: java25(), analyzerPath: markers.analyzerPath,
    requestId: "pre-aborted", indexDigest: `sha256:${"1".repeat(64)}`, files: [file], signal: preAborted.signal,
  }), /FAIL-JAVA-AST-CANCELLED/);
  assert.equal(fs.existsSync(markers.parentMarker), false);

  const controller = new AbortController();
  const analysis = analyzeJavaAstBatch({
    javaExecutable: java25(), analyzerPath: markers.analyzerPath,
    requestId: "cancel-tree", indexDigest: `sha256:${"2".repeat(64)}`, files: [file], signal: controller.signal,
  });
  const parentPid = await waitForPid(markers.parentMarker);
  const childPid = await waitForPid(markers.childMarker);
  controller.abort();
  await assert.rejects(analysis, /FAIL-JAVA-AST-CANCELLED/);
  await waitForDead(parentPid);
  await waitForDead(childPid);
});

test("batch timeout reaps the same owned analyzer process tree before rejection", { timeout: 30_000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-java-ast-timeout-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markers = writeSleepingAnalyzer(root, path.join(root, "marker"));
  const file = protocolFile(0, Buffer.from("class A {}\n"));
  const analysis = analyzeJavaAstBatch({
    javaExecutable: java25(),
    analyzerPath: markers.analyzerPath,
    requestId: "timeout-tree",
    indexDigest: `sha256:${"3".repeat(64)}`,
    files: [file],
    limits: { batchTimeoutMs: 5_000 },
  });
  const parentPid = await waitForPid(markers.parentMarker);
  const childPid = await waitForPid(markers.childMarker);
  await assert.rejects(analysis, /FAIL-JAVA-AST-TIMEOUT/);
  await waitForDead(parentPid);
  await waitForDead(childPid);
});

function writeFloodAnalyzer(root) {
  const analyzerPath = path.join(root, "FloodAnalyzer.java");
  fs.writeFileSync(analyzerPath, `
import javax.tools.ToolProvider;

class FloodAnalyzer {
  static String quote(String value) { return "\\\"" + value.replace("\\\\", "\\\\\\\\").replace("\\\"", "\\\\\\\"") + "\\\""; }
  public static void main(String[] args) throws Exception {
    if (args[0].equals("--probe")) {
      String json = "{\\\"analyzer_source_sha256\\\":" + quote(args[1])
        + ",\\\"analyzer_version\\\":\\\"sei.java-ast@1\\\""
        + ",\\\"compiler_implementation\\\":" + quote(ToolProvider.getSystemJavaCompiler().getClass().getName())
        + ",\\\"direct_process_executable\\\":true"
        + ",\\\"grammar_target\\\":25"
        + ",\\\"java_runtime_version\\\":" + quote(System.getProperty("java.runtime.version"))
        + ",\\\"java_vendor\\\":" + quote(System.getProperty("java.vendor"))
        + ",\\\"parser_runtime\\\":\\\"jdk.compiler\\\""
        + ",\\\"protocol\\\":\\\"sei.java-ast@1\\\"}";
      System.out.print(json);
      return;
    }
    System.out.print("x".repeat(131072));
    System.out.flush();
    Thread.sleep(120000);
  }
}
`);
  return analyzerPath;
}

test("hostile analyzer output is killed at the configured byte ceiling", { timeout: 30_000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-java-ast-flood-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = protocolFile(0, Buffer.from("class A {}\n"));
  await assert.rejects(analyzeJavaAstBatch({
    javaExecutable: java25(),
    analyzerPath: writeFloodAnalyzer(root),
    requestId: "stdout-flood",
    indexDigest: `sha256:${"4".repeat(64)}`,
    files: [file],
    limits: { maxStdoutBytes: 1024, batchTimeoutMs: 10_000 },
  }), /FAIL-JAVA-AST-PROCESS.*stdout exceeded 1024 bytes/);
});
