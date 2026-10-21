"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  TSJS_AST_ANALYZER_VERSION,
  TSJS_AST_PROTOCOL_VERSION,
  DEFAULT_LIMITS,
  encodeTsjsAstRequest,
  decodeTsjsAstResponse,
  probeTsjsAstRuntime,
  analyzeTsjsAstBatch,
} = require("./tsjs-ast-protocol");

const FIXTURES = path.join(__dirname, "..", "fixtures", "tsjs-ast");
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIXTURES, "complexity.expected.json"), "utf8"));

function typescriptPath() {
  const candidates = [
    process.env.SEI_TYPESCRIPT_PATH,
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor", "resources", "app", "extensions", "node_modules", "typescript", "lib", "typescript.js"),
  ].filter(Boolean);
  try { candidates.unshift(require.resolve("typescript")); } catch { /* optional runtime */ }
  return candidates.find((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate)) ?? null;
}

function sourceFile(name, syntax, ordinal) {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  const blobOid = crypto.createHash("sha1").update(Buffer.concat([
    Buffer.from(`blob ${bytes.length}\0`, "ascii"),
    bytes,
  ])).digest("hex");
  return {
    blobOid,
    bytes,
    contentKey: `git-blob:sha1:${blobOid}`,
    ordinal,
    syntax,
  };
}

function summarize(result) {
  const callables = result.callables.map((callable) => [
    callable.qualified_name,
    callable.kind,
    callable.lineno,
    callable.end_lineno,
    callable.cyclomatic_complexity,
    callable.cognitive_complexity,
  ]);
  const dependencyKinds = Object.fromEntries([...new Set(result.dependencies.map((fact) => fact.kind))]
    .sort().map((kind) => [kind, result.dependencies.filter((fact) => fact.kind === kind).length]));
  const staticModules = [...new Set(result.dependencies.map((fact) => fact.module).filter(Boolean))].sort();
  return {
    callables,
    cyclomatic_sum: result.callables.reduce((sum, fact) => sum + fact.cyclomatic_complexity, 0),
    cognitive_sum: result.callables.reduce((sum, fact) => sum + fact.cognitive_complexity, 0),
    dependency_kinds: dependencyKinds,
    static_modules: staticModules,
  };
}

test("request framing is pathless, bounded, canonical, and syntax-explicit", () => {
  const file = sourceFile("complexity.ts", "typescript", 0);
  const frame = encodeTsjsAstRequest({
    requestId: "fixture-1",
    indexDigest: `sha256:${"a".repeat(64)}`,
    files: [file],
  });
  assert.equal(frame.subarray(0, 8).toString("ascii"), "SEITJA1\0");
  const headerLength = frame.readUInt32BE(8);
  const header = JSON.parse(frame.subarray(12, 12 + headerLength).toString("utf8"));
  assert.equal(header.protocol, TSJS_AST_PROTOCOL_VERSION);
  assert.equal(header.analyzer_version, TSJS_AST_ANALYZER_VERSION);
  assert.equal(header.files[0].syntax, "typescript");
  assert.equal(Object.hasOwn(header.files[0], "path"), false);
  assert.equal(frame.length, 12 + headerLength + file.bytes.length);

  assert.throws(() => encodeTsjsAstRequest({
    requestId: "fixture-1",
    indexDigest: `sha256:${"a".repeat(64)}`,
    files: [{ ...file, path: "secret.ts" }],
  }), /FAIL-TSJS-AST-CONFIG.*unexpected field path/);
  assert.throws(() => encodeTsjsAstRequest({
    requestId: "fixture-1",
    indexDigest: `sha256:${"a".repeat(64)}`,
    files: [{ ...file, bytes: Buffer.alloc(DEFAULT_LIMITS.maxFileBytes + 1) }],
  }), /FAIL-TSJS-AST-FILE-LIMIT/);
});

test("the explicit TypeScript runtime probe binds parser bytes and Node identity", { skip: typescriptPath() === null }, async () => {
  const identity = await probeTsjsAstRuntime({
    nodeExecutable: process.execPath,
    typescriptPath: typescriptPath(),
  });
  assert.equal(identity.status, "available");
  assert.match(identity.node_version, /^v\d+\.\d+\.\d+$/);
  assert.match(identity.typescript_version, /^\d+\.\d+\.\d+/);
  assert.match(identity.typescript_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(identity.script_kinds, ["javascript", "jsx", "typescript", "tsx"]);
});

test("TypeScript, TSX, and JavaScript produce true AST facts and locked complexity literals", { skip: typescriptPath() === null, timeout: 60_000 }, async () => {
  const files = [
    sourceFile("complexity.ts", "typescript", 0),
    sourceFile("component.tsx", "tsx", 1),
    sourceFile("commonjs.js", "javascript", 2),
  ];
  const response = await analyzeTsjsAstBatch({
    nodeExecutable: process.execPath,
    typescriptPath: typescriptPath(),
    requestId: "complexity-fixture",
    indexDigest: `sha256:${"b".repeat(64)}`,
    files,
  });
  assert.equal(response.status, "ok");
  assert.deepEqual(summarize(response.results[0]), EXPECTED.complexity_ts);
  assert.deepEqual(summarize(response.results[1]), {
    ...EXPECTED.component_tsx,
    dependency_kinds: { import: 1 },
  });
  assert.deepEqual(summarize(response.results[2]), {
    ...EXPECTED.commonjs_js,
    dependency_kinds: { "require-literal": 1 },
  });
  assert.ok(response.results[0].exports.some((fact) => fact.kind === "named" && fact.name === "decide"));
  assert.ok(response.results[1].exports.some((fact) => fact.kind === "named" && fact.name === "Panel"));
  assert.ok(response.results[2].exports.some((fact) => fact.kind === "commonjs-property" && fact.name === "run"));
});

test("malformed and explicitly unsupported syntax are unavailable, never lexical estimates", { skip: typescriptPath() === null, timeout: 60_000 }, async () => {
  const response = await analyzeTsjsAstBatch({
    nodeExecutable: process.execPath,
    typescriptPath: typescriptPath(),
    requestId: "unavailable-fixture",
    indexDigest: `sha256:${"c".repeat(64)}`,
    files: [
      sourceFile("malformed.ts", "typescript", 0),
      sourceFile("unsupported.js", "javascript", 1),
    ],
  });
  assert.equal(response.status, "unavailable");
  assert.equal(response.results[0].status, "unavailable");
  assert.equal(response.results[0].error.code, "FAIL-TSJS-AST-PARSE");
  assert.equal(response.results[1].status, "unavailable");
  assert.equal(response.results[1].error.code, "FAIL-TSJS-AST-UNSUPPORTED-SYNTAX");
  assert.equal(Object.hasOwn(response.results[0], "callables"), false);
  assert.equal(Object.hasOwn(response.results[1], "callables"), false);
});

test("response decoding rejects coordinated provenance and fact tampering", { skip: typescriptPath() === null, timeout: 60_000 }, async () => {
  const file = sourceFile("complexity.ts", "typescript", 0);
  const response = await analyzeTsjsAstBatch({
    nodeExecutable: process.execPath,
    typescriptPath: typescriptPath(),
    requestId: "tamper-fixture",
    indexDigest: `sha256:${"d".repeat(64)}`,
    files: [file],
  });
  const body = JSON.parse(JSON.stringify(response));
  body.results[0].callables[0].cyclomatic_complexity = 0;
  const bodyBytes = Buffer.from(JSON.stringify(body), "utf8");
  const frame = Buffer.alloc(12 + bodyBytes.length);
  Buffer.from("SEITJR1\0", "ascii").copy(frame, 0);
  frame.writeUInt32BE(bodyBytes.length, 8);
  bodyBytes.copy(frame, 12);
  assert.throws(() => decodeTsjsAstResponse(frame, {
    files: [file],
    requestId: "tamper-fixture",
    runtime: response.runtime,
  }), /FAIL-TSJS-AST-PROTOCOL/);
});

test("absent optional parser is an honest unavailable runtime", async () => {
  const identity = await probeTsjsAstRuntime({ nodeExecutable: process.execPath });
  if (identity.status === "available") {
    assert.match(identity.typescript_sha256, /^sha256:/);
  } else {
    assert.equal(identity.status, "unavailable");
    assert.equal(identity.reason, "typescript-compiler-api-not-found");
  }
});

test("timeout rejects only after the admitted analyzer process is reaped", { timeout: 10_000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sei-tsjs-process-"));
  const pidPath = path.join(temporary, "child.pid");
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  await assert.rejects(probeTsjsAstRuntime({
    analyzerPath: path.join(__dirname, "tsjs-stall-fixture.js"),
    nodeExecutable: process.execPath,
    timeoutMs: 100,
    typescriptPath: pidPath,
  }), /FAIL-TSJS-AST-TIMEOUT/);
  const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8"), 10);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `analyzer pid ${pid} survived promise settlement`);
});

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForDead(pid) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) assert.fail(`process ${pid} survived cancellation`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

for (const fixtureCase of [
  { label: "JavaScript", name: "commonjs.js", syntax: "javascript" },
  { label: "TypeScript", name: "complexity.ts", syntax: "typescript" },
]) {
  test(`${fixtureCase.label} analyzer cancellation reaps parent and descendant before promise settlement`, { skip: typescriptPath() === null, timeout: 30_000 }, async (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `sei-tsjs-${fixtureCase.syntax}-cancel-`));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const prior = process.env.SEI_TSJS_STALL_MARKER;
    process.env.SEI_TSJS_STALL_MARKER = temporary;
    t.after(() => {
      if (prior === undefined) delete process.env.SEI_TSJS_STALL_MARKER;
      else process.env.SEI_TSJS_STALL_MARKER = prior;
    });
    const controller = new AbortController();
    const pending = analyzeTsjsAstBatch({
      analyzerPath: path.join(__dirname, "tsjs-stall-fixture.js"),
      nodeExecutable: process.execPath,
      typescriptPath: typescriptPath(),
      requestId: `${fixtureCase.syntax}-cancel`,
      indexDigest: `sha256:${"e".repeat(64)}`,
      files: [sourceFile(fixtureCase.name, fixtureCase.syntax, 0)],
      signal: controller.signal,
    });
    await waitForFile(path.join(temporary, "child.pid"));
    const parentPid = Number(fs.readFileSync(path.join(temporary, "parent.pid"), "utf8"));
    const childPid = Number(fs.readFileSync(path.join(temporary, "child.pid"), "utf8"));
    controller.abort();
    await assert.rejects(pending, /FAIL-TSJS-AST-CANCELLED/);
    await waitForDead(parentPid);
    await waitForDead(childPid);
  });
}
