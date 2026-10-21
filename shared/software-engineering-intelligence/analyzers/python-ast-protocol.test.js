"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  PYTHON_AST_ANALYZER_VERSION,
  PYTHON_AST_PROTOCOL_VERSION,
  PARSER_RUNTIME,
  GRAMMAR_TARGET,
  encodePythonAstRequest,
  probePythonAstRuntime,
  analyzePythonAstBatch,
  decodePythonAstResponse,
} = require("./python-ast-protocol.js");

const fixtureRoot = path.join(__dirname, "..", "fixtures", "python-ast");
const protocolExpected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "protocol.expected.json"), "utf8"));

function explicitPython313() {
  const probe = process.platform === "win32"
    ? spawnSync("py", ["-3.13", "-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true })
    : spawnSync("python3.13", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(probe.status, 0, `CPython 3.13 is required for this focused test: ${probe.stderr}`);
  const executable = probe.stdout.trim();
  assert.equal(path.isAbsolute(executable), true);
  return executable;
}

function gitBlobOid(bytes, algorithm = "sha1") {
  return crypto.createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`, "utf8")).update(bytes).digest("hex");
}

function protocolFile(ordinal, bytes) {
  const blobOid = gitBlobOid(bytes);
  return { ordinal, contentKey: `git-blob:sha1:${blobOid}`, blobOid, bytes };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function responseFrame(response) {
  const body = Buffer.from(canonicalJson(response), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from("SEIPYR1\0", "ascii"), length, body]);
}

function requestFrameWithHeader(frame, mutate) {
  const length = frame.readUInt32BE(8);
  const header = JSON.parse(frame.subarray(12, 12 + length).toString("utf8"));
  mutate(header);
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  const encodedLength = Buffer.alloc(4);
  encodedLength.writeUInt32BE(headerBytes.length);
  return Buffer.concat([frame.subarray(0, 8), encodedLength, headerBytes, frame.subarray(12 + length)]);
}

function bundledAnalyzerPath() {
  return path.join(__dirname, "python-ast.py");
}

function runRawAnalyzer(pythonExecutable, frame, analyzerPath = bundledAnalyzerPath()) {
  return spawnSync(pythonExecutable, ["-I", "-S", "-B", analyzerPath, "--analyze"], {
    cwd: path.dirname(analyzerPath),
    input: frame,
    encoding: null,
    timeout: 5_000,
    windowsHide: true,
  });
}

function writeHostileAnalyzer(root, body) {
  const analyzerPath = path.join(root, "hostile-analyzer.py");
  const identity = canonicalJson({
    analyzer_version: protocolExpected.analyzer_version,
    grammar_target: protocolExpected.grammar_target,
    implementation: "cpython",
    parser_runtime: protocolExpected.parser_runtime,
    protocol: protocolExpected.protocol,
    python_version: "3.13.7",
  });
  fs.writeFileSync(analyzerPath, [
    "import importlib.util, json, os, subprocess, sys, time",
    `spec = importlib.util.spec_from_file_location("sei_python_ast", ${JSON.stringify(bundledAnalyzerPath())})`,
    "supervisor = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(supervisor)",
    "supervisor.establish_process_supervisor()",
    `IDENTITY = ${JSON.stringify(identity)}`,
    "if sys.argv[1] == '--probe':",
    "    sys.stdout.write(IDENTITY)",
    "    raise SystemExit(0)",
    "if sys.argv[1] == '--analyze':",
    ...body.split("\n").map((line) => `    ${line}`),
    "raise SystemExit(2)",
    "",
  ].join("\n"));
  return analyzerPath;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFile(filePath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("python AST protocol exposes the locked analyzer identity", () => {
  assert.equal(PYTHON_AST_ANALYZER_VERSION, "sei.python-ast@1");
  assert.equal(PYTHON_AST_PROTOCOL_VERSION, "sei.python-ast@1");
  assert.equal(PARSER_RUNTIME, "cpython-3.13");
  assert.deepEqual(GRAMMAR_TARGET, [3, 13]);
});

test("request framing is canonical, pathless, hash-bound, and ordinal ordered", () => {
  const source = Buffer.from("def answer():\n    return 42\n", "utf8");
  const oid = "0123456789abcdef0123456789abcdef01234567";
  const frame = encodePythonAstRequest({
    requestId: "fixture-request",
    indexDigest: `sha256:${"a".repeat(64)}`,
    files: [{
      ordinal: 0,
      contentKey: `git-blob:sha1:${oid}`,
      blobOid: oid,
      bytes: source,
    }],
  });

  assert.equal(frame.subarray(0, 8).toString("hex"), protocolExpected.request_magic_hex);
  const headerLength = frame.readUInt32BE(8);
  const headerBytes = frame.subarray(12, 12 + headerLength);
  const header = JSON.parse(headerBytes.toString("utf8"));
  assert.deepEqual(Object.keys(header), [
    "analyzer_version", "files", "grammar_target", "index_digest", "limits", "parser_runtime", "protocol", "request_id",
  ]);
  assert.deepEqual(header.files, [{
    blob_oid: oid,
    byte_length: source.length,
    content_key: `git-blob:sha1:${oid}`,
    ordinal: 0,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
  }]);
  assert.equal(Object.hasOwn(header.files[0], "path"), false);
  assert.deepEqual(frame.subarray(12 + headerLength), source);
  assert.equal(headerBytes.toString("utf8"), JSON.stringify(header), "header bytes must already be canonical");
});

test("runtime probe accepts the minimum CPython 3.13 AST capability", async () => {
  const identity = await probePythonAstRuntime({ pythonExecutable: explicitPython313() });
  assert.deepEqual(identity, {
    analyzer_version: protocolExpected.analyzer_version,
    grammar_target: protocolExpected.grammar_target,
    implementation: "cpython",
    parser_runtime: protocolExpected.parser_runtime,
    protocol: protocolExpected.protocol,
    python_version: identity.python_version,
  });
  assert.ok(Number(identity.python_version.split(".")[0]) === 3 && Number(identity.python_version.split(".")[1]) >= 13);

  await assert.rejects(probePythonAstRuntime({ pythonExecutable: process.execPath }), /FAIL-PYTHON-AST-RUNTIME/);
});

test("batch analysis returns exact hand-authored complexity and raw import literals", async () => {
  const source = fs.readFileSync(path.join(fixtureRoot, "complexity.py"));
  const expected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "complexity.expected.json"), "utf8"));
  const response = await analyzePythonAstBatch({
    pythonExecutable: explicitPython313(),
    requestId: "complexity-fixture",
    indexDigest: `sha256:${"b".repeat(64)}`,
    files: [protocolFile(0, source)],
  });

  assert.equal(response.status, "ok");
  assert.deepEqual(response.results[0].callables.map(({ complexity, kind, lineno, qualified_name }) => ({
    complexity, kind, lineno, qualified_name,
  })), expected.callables);
  assert.deepEqual(response.results[0].imports.map(({ kind, level, lineno, module, names }) => ({
    kind, level, lineno, module, names,
  })), expected.imports);
});

test("batch analysis preserves valid source encodings and types per-file parse failures", async () => {
  const malformed = fs.readFileSync(path.join(fixtureRoot, "malformed.py"));
  const files = [
    protocolFile(0, Buffer.from("# coding: latin-1\nvalue = '\xe9'\n", "latin1")),
    protocolFile(1, Buffer.from("\ufeffdef bom():\n    return 1\n", "utf8")),
    protocolFile(2, malformed),
    protocolFile(3, Buffer.from("# coding: definitely-not-a-codec\nvalue = 1\n", "ascii")),
    protocolFile(4, Buffer.from("value = 'before'\0value = 'after'\n", "utf8")),
  ];
  const response = await analyzePythonAstBatch({
    pythonExecutable: explicitPython313(),
    requestId: "encoding-and-errors",
    indexDigest: `sha256:${"c".repeat(64)}`,
    files,
  });

  assert.equal(response.status, "partial");
  assert.deepEqual(response.results.map((result) => result.status), ["ok", "ok", "error", "error", "error"]);
  assert.deepEqual(response.results.filter((result) => result.status === "error").map((result) => result.error.code), protocolExpected.typed_parse_errors);
  assert.equal(response.results[1].callables[0].qualified_name, "bom");
  assert.deepEqual(response.diagnostics, { files_failed: 3, files_received: 5, files_succeeded: 2 });
});

test("request admission and the Python helper reject open, noncontiguous, bounded, and malformed frames", () => {
  const pythonExecutable = explicitPython313();
  const source = Buffer.from("def accepted():\n    return 1\n", "utf8");
  const file = protocolFile(0, source);
  const input = {
    requestId: "hostile-request",
    indexDigest: `sha256:${"d".repeat(64)}`,
    files: [file],
  };
  assert.throws(() => encodePythonAstRequest({ ...input, unknown: true }), /FAIL-PYTHON-AST-CONFIG.*unexpected field/);
  assert.throws(() => encodePythonAstRequest({ ...input, files: [{ ...file, path: "forbidden.py" }] }), /FAIL-PYTHON-AST-CONFIG.*unexpected field path/);
  assert.throws(() => encodePythonAstRequest({ ...input, files: [{ ...file, ordinal: 1 }] }), /FAIL-PYTHON-AST-CONFIG.*contiguous/);
  assert.throws(() => encodePythonAstRequest({ ...input, limits: { maxFileBytes: source.length - 1 } }), /FAIL-PYTHON-AST-FILE-LIMIT/);

  const valid = encodePythonAstRequest(input);
  const wrongMagic = Buffer.from(valid);
  wrongMagic[0] ^= 0xff;
  const badLength = Buffer.from(valid);
  badLength.writeUInt32BE(valid.length, 8);
  const hostileFrames = [
    wrongMagic,
    valid.subarray(0, valid.length - 1),
    Buffer.concat([valid, Buffer.from([0])]),
    badLength,
    requestFrameWithHeader(valid, (header) => { header.unknown = true; }),
    requestFrameWithHeader(valid, (header) => { header.files[0].ordinal = 1; }),
    requestFrameWithHeader(valid, (header) => { header.files[0].sha256 = "0".repeat(64); }),
    requestFrameWithHeader(valid, (header) => { header.files[0].content_key = `git-blob:sha1:${"0".repeat(40)}`; }),
    requestFrameWithHeader(valid, (header) => { header.index_digest = "not-a-digest"; }),
    requestFrameWithHeader(valid, (header) => { header.limits.max_batch_bytes = "many"; }),
  ];
  for (const [index, frame] of hostileFrames.entries()) {
    const result = runRawAnalyzer(pythonExecutable, frame);
    assert.notEqual(result.status, 0, `hostile frame ${index} must be rejected`);
    assert.equal(result.stdout.length, 0, `hostile frame ${index} must not publish a partial response`);
  }
});

test("response decoder fails closed on framing, identity, field, ordinal, hash, range, and ordering drift", async () => {
  const source = Buffer.from("def first():\n    return 1\n\ndef second():\n    return 2\n", "utf8");
  const file = protocolFile(0, source);
  const response = await analyzePythonAstBatch({
    pythonExecutable: explicitPython313(),
    requestId: "strict-response",
    indexDigest: `sha256:${"e".repeat(64)}`,
    files: [file],
  });
  const expectations = { files: [file], pythonVersion: response.python_version, requestId: "strict-response" };
  assert.deepEqual(decodePythonAstResponse(responseFrame(response), expectations), response);

  const mutations = [
    (value) => { value.unknown = true; },
    (value) => { value.request_id = "wrong"; },
    (value) => { value.results[0].ordinal = 1; },
    (value) => { value.results[0].sha256 = "0".repeat(64); },
    (value) => { value.results[0].callables[0].complexity = 0; },
    (value) => { value.results[0].callables[0].end_lineno = 0; },
    (value) => { value.results[0].callables.reverse(); },
    (value) => { value.results[0].extra = true; },
  ];
  for (const mutate of mutations) {
    const value = JSON.parse(JSON.stringify(response));
    mutate(value);
    assert.throws(() => decodePythonAstResponse(responseFrame(value), expectations), /FAIL-PYTHON-AST-PROTOCOL/);
  }

  const valid = responseFrame(response);
  const wrongMagic = Buffer.from(valid);
  wrongMagic[0] ^= 0xff;
  const noncanonicalBody = Buffer.concat([valid, Buffer.from("\n")]);
  noncanonicalBody.writeUInt32BE(noncanonicalBody.length - 12, 8);
  for (const frame of [wrongMagic, valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from([0])]), noncanonicalBody]) {
    assert.throws(() => decodePythonAstResponse(frame, expectations), /FAIL-PYTHON-AST-PROTOCOL/);
  }
});

test("analyzer remains pathless and never imports or executes repository source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-ast-canary-"));
  try {
    const analyzerPath = path.join(root, "python-ast.py");
    const siteMarker = path.join(root, "sitecustomize-ran.txt");
    const importMarker = path.join(root, "repository-import-ran.txt");
    const sourceMarker = path.join(root, "repository-source-ran.txt");
    fs.copyFileSync(bundledAnalyzerPath(), analyzerPath);
    fs.writeFileSync(path.join(root, "sitecustomize.py"), `open(${JSON.stringify(siteMarker)}, "w").write("ran")\n`);
    fs.writeFileSync(path.join(root, "executable_canary.py"), `open(${JSON.stringify(importMarker)}, "w").write("ran")\n`);
    const source = Buffer.from([
      "import executable_canary",
      `open(${JSON.stringify(sourceMarker)}, "w").write("ran")`,
      "def parsed_only():",
      "    return 1",
      "",
    ].join("\n"));
    const response = await analyzePythonAstBatch({
      analyzerPath,
      pythonExecutable: explicitPython313(),
      requestId: "execution-canary",
      indexDigest: `sha256:${"f".repeat(64)}`,
      files: [protocolFile(0, source)],
    });

    assert.equal(response.status, "ok");
    assert.equal(response.results[0].imports[0].names[0].name, "executable_canary");
    assert.equal(fs.existsSync(siteMarker), false, "isolated no-site mode must suppress sitecustomize");
    assert.equal(fs.existsSync(importMarker), false, "repository modules must never be imported");
    assert.equal(fs.existsSync(sourceMarker), false, "repository source must never be executed");
    assert.equal(JSON.stringify(response).includes(root), false, "pathless response must not expose analyzer or source paths");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("timeout kills and reaps the analyzer process tree before rejection settles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-ast-timeout-"));
  try {
    const pidPath = path.join(root, "pids.txt");
    const analyzerPath = writeHostileAnalyzer(root, [
      `child = subprocess.Popen([sys.executable, "-I", "-S", "-c", "import time; time.sleep(60)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)`,
      `open(${JSON.stringify(pidPath)}, "w").write(f"{os.getpid()}\\n{child.pid}\\n")`,
      "while True:",
      "    time.sleep(1)",
    ].join("\n"));
    const source = Buffer.from("value = 1\n");
    await assert.rejects(analyzePythonAstBatch({
      analyzerPath,
      pythonExecutable: explicitPython313(),
      requestId: "timeout-cleanup",
      indexDigest: `sha256:${"1".repeat(64)}`,
      files: [protocolFile(0, source)],
      limits: { batchTimeoutMs: 250 },
    }), /FAIL-PYTHON-AST-TIMEOUT/);

    const pids = fs.readFileSync(pidPath, "utf8").trim().split(/\s+/).map(Number);
    assert.equal(pids.length, 2);
    assert.deepEqual(pids.map(processAlive), [false, false], "direct and grandchild processes must be gone before rejection");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation spawns nothing when pre-aborted and reaps an in-flight process tree before rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-python-ast-cancel-"));
  try {
    const spawnMarker = path.join(root, "spawned.txt");
    const neverAnalyzer = path.join(root, "never.py");
    fs.writeFileSync(neverAnalyzer, `open(${JSON.stringify(spawnMarker)}, "w").write("spawned")\n`);
    const source = Buffer.from("value = 1\n");
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(analyzePythonAstBatch({
      analyzerPath: neverAnalyzer,
      pythonExecutable: explicitPython313(),
      requestId: "pre-aborted",
      indexDigest: `sha256:${"2".repeat(64)}`,
      files: [protocolFile(0, source)],
      signal: preAborted.signal,
    }), /FAIL-PYTHON-AST-CANCELLED/);
    assert.equal(fs.existsSync(spawnMarker), false, "pre-aborted analysis must not spawn the interpreter");

    const pidPath = path.join(root, "pids.txt");
    const analyzerPath = writeHostileAnalyzer(root, [
      `child = subprocess.Popen([sys.executable, "-I", "-S", "-c", "import time; time.sleep(60)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)`,
      `open(${JSON.stringify(pidPath)}, "w").write(f"{os.getpid()}\\n{child.pid}\\n")`,
      "while True:",
      "    time.sleep(1)",
    ].join("\n"));
    const controller = new AbortController();
    const pending = analyzePythonAstBatch({
      analyzerPath,
      pythonExecutable: explicitPython313(),
      requestId: "in-flight-cancel",
      indexDigest: `sha256:${"3".repeat(64)}`,
      files: [protocolFile(0, source)],
      signal: controller.signal,
    });
    await waitForFile(pidPath);
    controller.abort();
    await assert.rejects(pending, /FAIL-PYTHON-AST-CANCELLED/);
    const pids = fs.readFileSync(pidPath, "utf8").trim().split(/\s+/).map(Number);
    assert.deepEqual(pids.map(processAlive), [false, false], "cancelled direct and grandchild processes must be gone before rejection");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("crash and stdout or stderr overflow reject the whole batch after child exit", async () => {
  const source = Buffer.from("value = 1\n");
  const cases = [
    { name: "crash", body: "raise SystemExit(7)", limits: {} },
    { name: "stdout", body: "sys.stdout.buffer.write(b'x' * 4096)\nsys.stdout.flush()\ntime.sleep(60)", limits: { maxStdoutBytes: 1024 } },
    { name: "stderr", body: "sys.stderr.buffer.write(b'x' * 4096)\nsys.stderr.flush()\ntime.sleep(60)", limits: { maxStderrBytes: 1024 } },
  ];
  for (const hostile of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sei-python-ast-${hostile.name}-`));
    try {
      const analyzerPath = writeHostileAnalyzer(root, hostile.body);
      await assert.rejects(analyzePythonAstBatch({
        analyzerPath,
        pythonExecutable: explicitPython313(),
        requestId: `hostile-${hostile.name}`,
        indexDigest: `sha256:${"4".repeat(64)}`,
        files: [protocolFile(0, source)],
        limits: { batchTimeoutMs: 2_000, ...hostile.limits },
      }), /FAIL-PYTHON-AST-PROCESS/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
