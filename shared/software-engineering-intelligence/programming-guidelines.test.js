"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  compileProgrammingGuidelinesProfile,
  evaluateProgrammingGuidelinesProfile,
} = require("./programming-guidelines.js");
const {
  fixtureDocument,
  fixtureLocators,
  writeAdoptedProgrammingGuidelinesFixture,
  writeProgrammingGuidelinesFixture,
  writeRepositoryFixture,
} = require("./programming-guidelines-fixture.js");
const { compilePolicy, validatePolicyProfile } = require("./policy.js");

const EXPECTED_CLASSIFICATIONS = Object.freeze([
  ["PG-LAYOUT-NAMESPACE-001", "layout-namespace", "convention", "static"],
  ["PG-DEPENDENCY-AUTHORITY-001", "dependency-authority", "required", "static"],
  ["PG-SINGLE-OWNER-CHOKEPOINT-001", "single-owner-chokepoints", "hard-invariant", "static"],
  ["PG-FAIL-CLOSED-001", "fail-closed", "hard-invariant", "review"],
  ["PG-IDEMPOTENCY-001", "idempotency", "required", "runtime"],
  ["PG-DB-TRANSACTION-LOCKING-001", "db-transaction-locking", "hard-invariant", "runtime"],
  ["PG-TESTING-001", "testing", "required", "executable"],
  ["PG-GENERATED-CONTRACTS-001", "generated-contracts", "hard-invariant", "process"],
  ["PG-SECRETS-CONFIG-001", "secrets-config", "hard-invariant", "static"],
  ["PG-DELIVERY-001", "delivery", "advisory", "external-evidence"],
]);

test("Programming Guidelines repository use is unavailable without an authoritative source", () => {
  assert.throws(
    () => compileProgrammingGuidelinesProfile({}),
    /FAIL-PROGRAMMING-GUIDELINES-UNAVAILABLE/,
  );
});

test("a fixture-only Programming Guidelines source cannot establish repository policy after a verbatim copy", (t) => {
  const fixture = writeProgrammingGuidelinesFixture(t);
  const copiedPath = path.join(fixture.root, "repository-policy", "PROGRAMMING-GUIDELINES.md");
  fs.mkdirSync(path.dirname(copiedPath), { recursive: true });
  fs.writeFileSync(copiedPath, fixtureDocument(), "utf8");
  const copiedInput = {
    ...fixture,
    document_path: copiedPath,
    adoption_evidence_ref: "adoption:fixture-only",
    locators: fixtureLocators(),
  };

  assert.throws(
    () => compileProgrammingGuidelinesProfile(copiedInput),
    /FAIL-PROGRAMMING-GUIDELINES-FIXTURE-SOURCE/,
  );
});

test("Programming Guidelines compilation fails when a required source locator is missing", (t) => {
  const input = writeAdoptedProgrammingGuidelinesFixture(t);
  delete input.locators["PG-TESTING-001"];
  assert.throws(
    () => compileProgrammingGuidelinesProfile(input),
    /FAIL-PROGRAMMING-GUIDELINES-LOCATOR/,
  );
});

test("an adopted non-fixture Programming Guidelines source compiles to a closed M2 policy profile", (t) => {
  const input = writeAdoptedProgrammingGuidelinesFixture(t);
  const profile = compileProgrammingGuidelinesProfile(input);

  assert.deepEqual(
    profile.rules.map((rule) => [rule.rule_id, rule.category, rule.severity, rule.verification.method]),
    EXPECTED_CLASSIFICATIONS,
  );
  assert.ok(profile.rules.every((rule) => rule.status === "unverifiable"));
  assert.ok(profile.rules.every((rule) => rule.source_refs[0].locator.includes("sha256:")));
  assert.equal(profile.source.digest, input.expected_digest);
  assert.equal("score" in profile.summary, false);
  assert.deepEqual(validatePolicyProfile(profile), { ok: true, errors: [] });
});

test("Programming Guidelines compilation fails on source hash drift", (t) => {
  const input = writeAdoptedProgrammingGuidelinesFixture(t);
  fs.appendFileSync(input.document_path, "\nDrifted after the digest was pinned.\n", "utf8");
  assert.throws(
    () => compileProgrammingGuidelinesProfile(input),
    /FAIL-PROGRAMMING-GUIDELINES-SOURCE-DRIFT/,
  );
});

test("Programming Guidelines compilation requires a real heading and matching section fingerprint", (t) => {
  const missingHeading = writeAdoptedProgrammingGuidelinesFixture(t);
  missingHeading.locators["PG-TESTING-001"].heading = "## Missing testing heading";
  assert.throws(
    () => compileProgrammingGuidelinesProfile(missingHeading),
    /FAIL-PROGRAMMING-GUIDELINES-LOCATOR/,
  );

  const driftedFingerprint = writeAdoptedProgrammingGuidelinesFixture(t);
  driftedFingerprint.locators["PG-TESTING-001"].fingerprint = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => compileProgrammingGuidelinesProfile(driftedFingerprint),
    /FAIL-PROGRAMMING-GUIDELINES-LOCATOR/,
  );
});

test("Programming Guidelines evaluator keeps subjective rules unverifiable", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t);
  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });

  const statusById = Object.fromEntries(result.rules.map((rule) => [rule.rule_id, rule.status]));
  assert.equal(statusById["PG-FAIL-CLOSED-001"], "unverifiable");
  assert.equal(statusById["PG-IDEMPOTENCY-001"], "unverifiable");
  assert.equal(statusById["PG-DB-TRANSACTION-LOCKING-001"], "unverifiable");
  assert.equal(statusById["PG-DELIVERY-001"], "unverifiable");
  assert.deepEqual(validatePolicyProfile(result), { ok: true, errors: [] });
});

test("Programming Guidelines evaluator deterministically passes only reliable repository mechanics", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t);
  const input = {
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  };
  const first = evaluateProgrammingGuidelinesProfile(input);
  const second = evaluateProgrammingGuidelinesProfile(input);
  const statusById = Object.fromEntries(first.rules.map((rule) => [rule.rule_id, rule.status]));

  for (const ruleId of [
    "PG-LAYOUT-NAMESPACE-001",
    "PG-DEPENDENCY-AUTHORITY-001",
    "PG-SINGLE-OWNER-CHOKEPOINT-001",
    "PG-TESTING-001",
    "PG-GENERATED-CONTRACTS-001",
    "PG-SECRETS-CONFIG-001",
  ]) {
    assert.equal(statusById[ruleId], "pass", ruleId);
  }
  assert.deepEqual(first, second);
  assert.deepEqual(validatePolicyProfile(first), { ok: true, errors: [] });
});

test("static sole-owner evaluation ignores commented, quoted, and plain template import text", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/non-import-text.js": [
      "// require(\"@app/config\")",
      "/* require(\"@app/config\") */",
      "// module['requ' + 'ire']('@app/config')",
      "/* eval('require(\"@app/config\")') */",
      "// requ\\u0069re('@app/config')",
      "// Function('return require')()('@app/config')",
      "/* new Function('return require')()('@app/config') */",
      "// globalThis['Fun' + 'ction']('return require')()('@app/config')",
      "/* ({})['constr' + 'uctor']['constr' + 'uctor']('return require')()('@app/config') */",
      "// const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
      "/* process.get\\u0042uiltinModule('module')._load('@app/config') */",
      "// process.getBuiltinModule('module')._load('@app/config')",
      "/* process['getBuiltinModule']('module')._load('@app/config') */",
      "// process['get'+'BuiltinModule']('node:module')._load('@app/config')",
      "// const {getBuiltinModule}=process; getBuiltinModule('node:module');",
      "/* Object.getOwnPropertyDescriptor(process, 'getBuiltinModule').value; */",
      "// const [, load] = arguments; load('@app/config');",
      "/* const { 1: load } = arguments; load('@app/config'); */",
      "// const { ['process']: p } = globalObject;",
      "/* const { ['main' + 'Module']: M } = p; */",
      "// const runtime = this.process; runtime.binding('spawn_sync');",
      "/* const runtime = window.process; runtime._linkedBinding('spawn_sync'); */",
      "const quoted = 'require(\"@app/config\")';",
      "const escapedQuoted = 'requ\\u0069re(\"@app/config\")';",
      "const reflected = 'Reflect.get(module, \"require\").call(module, \"@app/config\")';",
      "const functionQuoted = 'Function(\"return require\")()(\"@app/config\")';",
      "const asyncFunctionQuoted = 'AsyncFunction(\"return require\")()(\"@app/config\")';",
      "const computedGlobalQuoted = \"globalThis['Function'.toString()](\" + \"'return require')()('@app/config')\";",
      "const builtinQuoted = 'process.getBuiltinModule(\"module\")._load(\"@app/config\")';",
      "const builtinNodeQuoted = 'process.getBuiltinModule(\"node:module\")._load(\"@app/config\")';",
      "const exactBuiltinName = 'getBuiltinModule';",
      "const reflectionNames = 'constructor __proto__ getPrototypeOf getOwnPropertyDescriptor getOwnPropertyDescriptors';",
      "const argumentsQuoted = 'arguments';",
      "const objectPatternQuoted = \"const { ['process']: p } = globalObject;\";",
      "const ambientQuoted = 'this.process.binding(\"spawn_sync\")';",
      "console.log('getBuiltinModule');",
      "const templated = `require(\"@app/config\")`;",
      "const escapedTemplate = `process.get\\u0042uiltinModule('module')._load('@app/config')`;",
      "const dynamic = `await import(\"@app/config\")`;",
      "const builtinTemplate = `process?.['getBuiltinModule']('module')._load('@app/config')`;",
      "const dynamicBuiltinTemplate = `process['get'+'BuiltinModule']('module')._load('@app/config')`;",
      "const exactBuiltinTemplate = `getBuiltinModule`;",
      "const reflectionTemplate = `constructor __proto__ getPrototypeOf getOwnPropertyDescriptor getOwnPropertyDescriptors`;",
      "const argumentsTemplate = `arguments`;",
      "const objectPatternTemplate = `const { ['process']: p } = globalObject;`;",
      "const ambientTemplate = `this.process.binding('spawn_sync')`;",
      "const functionTemplate = `new Function('return require')()('@app/config')`;",
      "const asyncFunctionTemplate = `AsyncFunction('return require')()('@app/config')`;",
      "const computedGlobalTemplate = `globalThis[['Function']]('return require')()('@app/config')`;",
      "",
    ].join("\n"),
  });
  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "pass");
  assert.ok(soleOwner.verification.evidence_refs.includes("owner-import:src/config-owner.js:@app/config"));
});

test("static sole-owner evaluation detects literal CommonJS and ESM imports in code", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/rogue-require.js": "const config = require(\"@app/config\");\n",
    "src/rogue-import.mjs": "import config from \"@app/config\";\n",
  });
  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "fail");
  assert.ok(soleOwner.verification.evidence_refs.includes("non-owner-import:src/rogue-require.js:@app/config"));
  assert.ok(soleOwner.verification.evidence_refs.includes("non-owner-import:src/rogue-import.mjs:@app/config"));
});

test("static sole-owner evaluation fails a runtime-backed non-owner module.require import", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    "src/rogue-module-require.js": [
      "const config = module.require(\"@app/config\");",
      "if (config.source !== \"fixture\") throw new Error(\"fixture config did not resolve\");",
      "",
    ].join("\n"),
  });
  const payload = path.join(repositoryRoot, "src", "rogue-module-require.js");
  const executed = spawnSync(process.execPath, [payload], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "fail");
  assert.ok(soleOwner.verification.evidence_refs.includes("non-owner-import:src/rogue-module-require.js:@app/config"));
});

test("runtime-reachable nontrivial require calls are unverifiable rather than a hard pass", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    "src/rogue-optional-require.js": [
      "const config = require?.(\"@app/config\");",
      "if (config.source !== \"fixture\") throw new Error(\"fixture config did not resolve\");",
      "",
    ].join("\n"),
    "src/rogue-indirect-require.js": [
      "const config = (0, require)(\"@app/config\");",
      "if (config.source !== \"fixture\") throw new Error(\"fixture config did not resolve\");",
      "",
    ].join("\n"),
    "src/rogue-optional-module-require.js": [
      "const config = module.require?.(\"@app/config\");",
      "if (config.source !== \"fixture\") throw new Error(\"fixture config did not resolve\");",
      "",
    ].join("\n"),
    "src/rogue-property-require.js": [
      "const loader = module;",
      "const config = loader.require(\"@app/config\");",
      "if (config.source !== \"fixture\") throw new Error(\"fixture config did not resolve\");",
      "",
    ].join("\n"),
    "src/rogue-computed-module-require.js": [
      "const config = module[\"require\"](\"@app/config\");",
      "if (config.source !== \"fixture\") throw new Error(\"fixture config did not resolve\");",
      "",
    ].join("\n"),
  });
  for (const relativePath of [
    "src/rogue-optional-require.js",
    "src/rogue-indirect-require.js",
    "src/rogue-optional-module-require.js",
    "src/rogue-property-require.js",
    "src/rogue-computed-module-require.js",
  ]) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-optional-require.js:optional-require-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-indirect-require.js:indirect-require-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-optional-module-require.js:optional-module-require-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-property-require.js:property-require-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-computed-module-require.js:computed-property-require-call"));
});

test("runtime-reachable dynamic loader forms are unverifiable rather than hard passes", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    "src/rogue-concatenated-module-require.js": [
      "const config = module['requ' + 'ire']('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-template-module-require.js": [
      "const config = module[`require`]('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-array-module-require.js": [
      "const config = module[['require']]('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-reflect-module-require.js": [
      "const load = Reflect.get(module, 'require');",
      "const config = load.call(module, '@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-eval-require.js": [
      "const config = eval('require(\\\"@app/config\\\")');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-dynamic-import.mjs": [
      "const namespace = await import(`@app/config`);",
      "if (namespace.default.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
  });
  const dynamicLoaderPaths = [
    "src/rogue-concatenated-module-require.js",
    "src/rogue-template-module-require.js",
    "src/rogue-array-module-require.js",
    "src/rogue-reflect-module-require.js",
    "src/rogue-eval-require.js",
    "src/rogue-dynamic-import.mjs",
  ];
  for (const relativePath of dynamicLoaderPaths) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-concatenated-module-require.js:computed-module-property-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-template-module-require.js:computed-module-property-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-array-module-require.js:computed-module-property-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-reflect-module-require.js:reflect-get-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-eval-require.js:eval-call"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-dynamic-import.mjs:dynamic-import-call"));
});

test("runtime-reachable Function-family loaders are unverifiable rather than hard passes", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-function-constructor.js", [
      "const config = Function('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-new-function-constructor.js", [
      "const config = new Function('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-async-function-constructor.js", [
      "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
      "(async () => {",
      "  const load = await AsyncFunction('return require')();",
      "  const config = load('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "})().catch((error) => { throw error; });",
      "",
    ].join("\n")],
    ["src/rogue-new-async-function-constructor.js", [
      "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
      "(async () => {",
      "  const load = await new AsyncFunction('return require')();",
      "  const config = load('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "})().catch((error) => { throw error; });",
      "",
    ].join("\n")],
    ["src/rogue-constructor-property-loader.js", [
      "const config = Object.getPrototypeOf(function () {}).constructor('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    ...Object.fromEntries(loaderVariants),
  });

  for (const [relativePath] of loaderVariants) {
    const payload = path.join(repositoryRoot, ...relativePath.split("/"));
    const executed = spawnSync(process.execPath, [
      "-e",
      `globalThis.require = require; require(${JSON.stringify(payload)});`,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:dynamic-code-constructor-reference`,
    ));
  }
});

test("runtime-reachable computed global and constructor loaders are unverifiable rather than hard passes", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-computed-global-function.js", [
      "const config = globalThis['Fun' + 'ction']('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-array-global-function.js", [
      "const config = globalThis[['Function']]('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-method-global-function.js", [
      "const config = globalThis['Function'.toString()]('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-computed-constructor-chain.js", [
      "const config = ({})['constr' + 'uctor']['constr' + 'uctor']('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-computed-async-constructor.js", [
      "(async () => {",
      "  const load = await Object.getPrototypeOf(async function () {})['constr' + 'uctor']('return require')();",
      "  const config = load('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "})().catch((error) => { throw error; });",
      "",
    ].join("\n")],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    ...Object.fromEntries(loaderVariants),
  });

  for (const [relativePath] of loaderVariants) {
    const payload = path.join(repositoryRoot, ...relativePath.split("/"));
    const executed = spawnSync(process.execPath, [
      "-e",
      `globalThis.require = require; require(${JSON.stringify(payload)});`,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:unrecognized-dynamic-property-loader-access`,
    ));
  }
});

test("optional global, constructor, property-eval, and template process loaders are fail-closed", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-optional-global-function.js", [
      "const config = globalThis?.['Fun' + 'ction']('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"), "unrecognized-executable-global-access"],
    ["src/rogue-optional-node-global-function.js", [
      "const config = global?.['Fun' + 'ction']('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"), "unrecognized-executable-global-access"],
    ["src/rogue-optional-literal-global-function.js", [
      "const config = globalThis?.['Function']('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"), "unrecognized-executable-global-access"],
    ["src/rogue-optional-computed-constructor-chain.js", [
      "const config = ({})?.['constr' + 'uctor']?.['constr' + 'uctor']('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"), "dynamic-code-constructor-reference"],
    ["src/rogue-optional-computed-async-constructor.js", [
      "(async () => {",
      "  const load = await Object.getPrototypeOf(async function () {})?.['constr' + 'uctor']('return require')();",
      "  const config = load('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "})().catch((error) => { throw error; });",
      "",
    ].join("\n"), "dynamic-code-constructor-reference"],
    ["src/rogue-global-property-eval.js", [
      "const config = globalThis.eval(\"require('@app/config')\");",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"), "property-eval-reference"],
    ["src/rogue-optional-global-property-eval.js", [
      "const config = globalThis?.eval(\"require('@app/config')\");",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"), "property-eval-reference"],
    ["src/rogue-optional-computed-global-eval.js", [
      "const config = globalThis?.['eval'](\"require('@app/config')\");",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"), "unrecognized-dynamic-property-loader-access"],
    ["src/rogue-optional-template-process-builtin.js", [
      "const fs = globalThis?.[`process`]?.[`getBuiltinModule`]('fs');",
      "if (typeof fs.readFileSync !== 'function') throw new Error('fixture fs did not resolve');",
      "",
    ].join("\n"), "unrecognized-executable-global-access"],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    ...Object.fromEntries(loaderVariants.map(([relativePath, source]) => [relativePath, source])),
  });

  for (const [relativePath] of loaderVariants) {
    const payload = path.join(repositoryRoot, ...relativePath.split("/"));
    const executed = spawnSync(process.execPath, [
      "-e",
      `globalThis.require = require; require(${JSON.stringify(payload)});`,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath, , reason] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:${reason}`,
    ));
  }
});

test("unrecognized executable module and Reflect loader chains are unverifiable rather than hard passes", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    "src/rogue-optional-computed-module-require.js": [
      "const config = module?.[`require`]('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-computed-reflect-get.js": [
      "const load = Reflect['get'](module, 'require');",
      "const config = load.call(module, '@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-module-constructor-load.js": [
      "const config = module.constructor._load('@app/config', module);",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
  });
  const dynamicLoaderPaths = [
    "src/rogue-optional-computed-module-require.js",
    "src/rogue-computed-reflect-get.js",
    "src/rogue-module-constructor-load.js",
  ];
  for (const relativePath of dynamicLoaderPaths) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-optional-computed-module-require.js:unrecognized-module-loader-construction"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-computed-reflect-get.js:unrecognized-reflect-loader-construction"));
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-module-constructor-load.js:unrecognized-module-loader-construction"));
});

test("runtime-reachable process.getBuiltinModule loader chains are unverifiable rather than hard passes", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-process-builtin-module-loader.js", "const M=process.getBuiltinModule('module');"],
    ["src/rogue-optional-process-builtin-module-loader.js", "const M=process?.getBuiltinModule('module');"],
    ["src/rogue-computed-process-builtin-module-loader.js", "const M=process['getBuiltinModule']('module');"],
    ["src/rogue-optional-computed-process-builtin-module-loader.js", "const M=process?.['getBuiltinModule']('module');"],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    ...Object.fromEntries(loaderVariants.map(([relativePath, initialize]) => [relativePath, [
      initialize,
      "const parent=M._cache[process.argv[1]];",
      "const config=M._load('@app/config', parent);",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")])),
  });
  for (const [relativePath] of loaderVariants) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(`unsupported-import-call:${relativePath}:process-builtin-module-loader-chain`));
  }
});

test("runtime-reachable node:module builtin-loader access is unverifiable rather than a hard pass", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-node-builtin-module-loader.js", "const M=process.getBuiltinModule('node:module');"],
    ["src/rogue-optional-node-builtin-module-loader.js", "const M=process?.getBuiltinModule('node:module');"],
    ["src/rogue-computed-node-builtin-module-loader.js", "const M=process['getBuiltinModule']('node:module');"],
    ["src/rogue-optional-computed-node-builtin-module-loader.js", "const M=process?.['getBuiltinModule']('node:module');"],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    ...Object.fromEntries(loaderVariants.map(([relativePath, initialize]) => [relativePath, [
      initialize,
      "const parent=M._cache[process.argv[1]];",
      "const config=M._load('@app/config', parent);",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")])),
  });
  for (const [relativePath] of loaderVariants) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(`unsupported-import-call:${relativePath}:process-builtin-module-loader-chain`));
  }
});

test("runtime-reachable unknown computed process builtin-loader access is unverifiable rather than a hard pass", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-dynamic-process-builtin-module-loader.js", "const M=process['get'+'BuiltinModule']('module');"],
    ["src/rogue-dynamic-node-process-builtin-module-loader.js", "const M=process['get'+'BuiltinModule']('node:module');"],
    ["src/rogue-optional-dynamic-process-builtin-module-loader.js", "const M=process?.['get'+'BuiltinModule']('module');"],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    ...Object.fromEntries(loaderVariants.map(([relativePath, initialize]) => [relativePath, [
      initialize,
      "const parent=M._cache[process.argv[1]];",
      "const config=M._load('@app/config', parent);",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")])),
  });
  for (const [relativePath] of loaderVariants) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(`unsupported-import-call:${relativePath}:unrecognized-process-computed-loader-access`));
  }
});

test("runtime-reachable getBuiltinModule aliases and descriptors are unverifiable rather than hard passes", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-process-alias-builtin-loader.js", [
      "const p=process;",
      "const M=p.getBuiltinModule('node:module');",
    ]],
    ["src/rogue-dynamic-process-alias-builtin-loader.js", [
      "const p=process;",
      "const M=p['get'+'BuiltinModule']('node:module');",
    ]],
    ["src/rogue-destructured-builtin-loader.js", [
      "const {getBuiltinModule}=process;",
      "const M=getBuiltinModule('node:module');",
    ]],
    ["src/rogue-global-process-builtin-loader.js", [
      "const M=globalThis['process']['getBuiltinModule']('node:module');",
    ]],
    ["src/rogue-dynamic-global-process-alias-builtin-loader.js", [
      "const p=globalThis['process'];",
      "const M=p['get'+'BuiltinModule']('node:module');",
    ]],
    ["src/rogue-descriptor-builtin-loader.js", [
      "const getBuiltinModule=Object.getOwnPropertyDescriptor(process,'getBuiltinModule').value;",
      "const M=getBuiltinModule('node:module');",
    ]],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    ...Object.fromEntries(loaderVariants.map(([relativePath, initialize]) => [relativePath, [
      ...initialize,
      "const parent=M._cache[process.argv[1]];",
      "const config=M._load('@app/config', parent);",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")])),
  });
  for (const [relativePath] of loaderVariants) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(`unsupported-import-call:${relativePath}:unrecognized-get-builtin-module-access`));
  }
});

test("runtime-reachable process and static Module constructions are fail-closed before loader aliases can hide", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-main-module-concatenated-require.js", [
      "const config = process.mainModule['re' + 'quire']('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ]],
    ["src/rogue-optional-main-module-concatenated-require.js", [
      "const config = process?.mainModule?.['re' + 'quire']('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ]],
    ["src/rogue-template-main-module-require.js", [
      "const config = process?.[`mainModule`]?.[`require`]('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ]],
    ["src/rogue-main-module-constructor-require.js", [
      "const localRequire = process.mainModule['constr' + 'uctor'].createRequire(__filename);",
      "const config = localRequire('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ]],
    ["src/rogue-static-module-require.js", [
      "const { createRequire } = require('module');",
      "const localRequire = createRequire(__filename);",
      "const config = localRequire('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ]],
    ["src/rogue-static-node-module-require.js", [
      "const { createRequire } = require('node:module');",
      "const localRequire = createRequire(__filename);",
      "const config = localRequire('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ]],
    ["src/rogue-static-module-import.mjs", [
      "import { createRequire } from 'module';",
      "const localRequire = createRequire(import.meta.url);",
      "const config = localRequire('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ]],
    ["src/rogue-static-node-module-import.mjs", [
      "import { createRequire } from 'node:module';",
      "const localRequire = createRequire(import.meta.url);",
      "const config = localRequire('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ]],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    ...Object.fromEntries(loaderVariants.map(([relativePath, lines]) => [
      relativePath,
      [...lines, ""].join("\n"),
    ])),
  });

  for (const [relativePath] of loaderVariants) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  const processReasons = [
    ["src/rogue-main-module-concatenated-require.js", "unrecognized-process-loader-construction"],
    ["src/rogue-optional-main-module-concatenated-require.js", "unrecognized-process-loader-construction"],
    ["src/rogue-template-main-module-require.js", "unrecognized-process-computed-loader-access"],
    ["src/rogue-main-module-constructor-require.js", "unrecognized-process-loader-construction"],
  ];
  for (const [relativePath, reason] of processReasons) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:${reason}`,
    ));
  }
  for (const [relativePath] of loaderVariants.slice(4)) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:static-module-loader-construction`,
    ));
  }
});

test("literal computed process builtin access is unverifiable even for a non-module builtin", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/rogue-computed-non-module-builtin.js": [
      "const fs=process['getBuiltinModule']('fs');",
      "if (typeof fs.readFileSync !== 'function') throw new Error('fixture fs did not resolve');",
      "",
    ].join("\n"),
  });
  const sourcePath = path.join(repositoryRoot, "src", "rogue-computed-non-module-builtin.js");
  const executed = spawnSync(process.execPath, [sourcePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-import-call:src/rogue-computed-non-module-builtin.js:unrecognized-get-builtin-module-access"));
});

test("exact direct process.getBuiltinModule('fs') remains a benign source", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/known-builtin.js": [
      "const fs = process.getBuiltinModule('fs');",
      "if (typeof fs.readFileSync !== 'function') throw new Error('fixture fs did not resolve');",
      "",
    ].join("\n"),
  });
  const sourcePath = path.join(repositoryRoot, "src", "known-builtin.js");
  const executed = spawnSync(process.execPath, [sourcePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "pass");
  assert.ok(soleOwner.verification.evidence_refs.includes("owner-import:src/config-owner.js:@app/config"));
});

test("array and object literals remain within the verified subset until a member access occurs", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/benign-literals.js": [
      "const labels = ['first', 'second'];",
      "const config = { labels, nested: [{ active: true }] };",
      "if (config.labels.length !== 2) throw new Error('fixture literals did not resolve');",
      "",
    ].join("\n"),
  });
  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "pass");
  assert.ok(soleOwner.verification.evidence_refs.includes("owner-import:src/config-owner.js:@app/config"));
});

test("literal optional computed member access is unverifiable even when it runtime-executes benignly", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/rogue-optional-literal-member.js": [
      "const value = ({ value: 'fixture' })?.['value'];",
      "if (value !== 'fixture') throw new Error('fixture optional member did not resolve');",
      "",
    ].join("\n"),
  });
  const payload = path.join(repositoryRoot, "src", "rogue-optional-literal-member.js");
  const executed = spawnSync(process.execPath, [payload], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-optional-literal-member.js:unrecognized-dynamic-property-loader-access",
  ));
});

test("literal computed reflection chains that runtime-load a restricted module are unverifiable", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    "src/rogue-literal-computed-reflection.js": [
      "const O = {}['constructor'];",
      "const D = O['getOwnPropertyDescriptors'](O['__proto__']);",
      "const F = O['values'](D).at(2)['value'];",
      "const config = F('return require')()('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
  });
  const payload = path.join(repositoryRoot, "src", "rogue-literal-computed-reflection.js");
  const executed = spawnSync(process.execPath, [
    "-e",
    `globalThis.require = require; require(${JSON.stringify(payload)});`,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-literal-computed-reflection.js:unrecognized-dynamic-property-loader-access",
  ));
});

test("direct reflection primitives are unverifiable before a later chain can construct code", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/rogue-direct-prototype.js": [
      "const prototype = Object.getPrototypeOf(Object);",
      "if (typeof prototype !== 'function') throw new Error('fixture prototype did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-direct-descriptors.js": [
      "const descriptors = Object.getOwnPropertyDescriptors({});",
      "if (typeof descriptors !== 'object') throw new Error('fixture descriptors did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-direct-descriptor.js": [
      "const descriptor = Object.getOwnPropertyDescriptor({}, 'value');",
      "if (descriptor !== undefined) throw new Error('fixture descriptor did not resolve');",
      "",
    ].join("\n"),
    "src/rogue-direct-proto.js": [
      "const prototype = ({}).__proto__;",
      "if (typeof prototype !== 'object') throw new Error('fixture proto did not resolve');",
      "",
    ].join("\n"),
  });
  for (const relativePath of [
    "src/rogue-direct-prototype.js",
    "src/rogue-direct-descriptors.js",
    "src/rogue-direct-descriptor.js",
    "src/rogue-direct-proto.js",
  ]) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath, reason] of [
    ["src/rogue-direct-prototype.js", "dynamic-code-constructor-reference"],
    ["src/rogue-direct-descriptors.js", "dynamic-code-constructor-reference"],
    ["src/rogue-direct-descriptor.js", "unrecognized-get-builtin-module-access"],
    ["src/rogue-direct-proto.js", "dynamic-code-constructor-reference"],
  ]) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:${reason}`,
    ));
  }
});

test("nested destructured reflection aliases that construct a process loader are unverifiable", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    "src/rogue-nested-destructured-constructor.js": [
      "const { constructor: { constructor: F } } = {};",
      "const config = F(\"return process.mainModule.require('@app/config')\")();",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n"),
  });
  const payload = path.join(repositoryRoot, "src", "rogue-nested-destructured-constructor.js");
  const executed = spawnSync(process.execPath, [
    "-e",
    `process.mainModule = module; require(${JSON.stringify(payload)});`,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-nested-destructured-constructor.js:reflection-capability-primitive-reference",
  ));
});

test("destructured reflection and capability primitive aliases are outside the verified grammar", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const variants = [
    ["src/rogue-destructured-constructor.js", "const { constructor: FunctionCtor } = {};\nvoid FunctionCtor;\n", "reflection-capability-primitive-reference"],
    ["src/rogue-destructured-prototype.js", "const { prototype: objectPrototype } = Object;\nvoid objectPrototype;\n", "reflection-capability-primitive-reference"],
    ["src/rogue-destructured-proto.js", "const { __proto__: objectPrototype } = {};\nvoid objectPrototype;\n", "reflection-capability-primitive-reference"],
    ["src/rogue-destructured-get-prototype.js", "const { getPrototypeOf: getPrototype } = Object;\nvoid getPrototype;\n", "reflection-capability-primitive-reference"],
    ["src/rogue-destructured-descriptors.js", "const { getOwnPropertyDescriptors: descriptors } = Object;\nvoid descriptors;\n", "reflection-capability-primitive-reference"],
    ["src/rogue-destructured-descriptor.js", "const { getOwnPropertyDescriptor: descriptor } = Object;\nvoid descriptor;\n", "unrecognized-get-builtin-module-access"],
    ["src/rogue-destructured-own-keys.js", "const { ownKeys: keys } = Reflect;\nvoid keys;\n", "reflection-capability-primitive-reference"],
    ["src/rogue-destructured-define-property.js", "const { defineProperty: define } = Object;\nvoid define;\n", "reflection-capability-primitive-reference"],
    ["src/rogue-proxy-alias.js", "const ProxyAlias = Proxy;\nvoid ProxyAlias;\n", "reflection-capability-primitive-reference"],
    ["src/rogue-class-constructor.js", "class Fixture { constructor() {} }\nvoid Fixture;\n", "reflection-capability-primitive-reference"],
  ];
  const repositoryRoot = writeRepositoryFixture(t, Object.fromEntries(variants.map(([relativePath, source]) => [
    relativePath,
    source,
  ])));

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath, , reason] of variants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:${reason}`,
    ));
  }
});

test("CJS arguments destructuring cannot hide a runtime module loader", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-arguments-numeric-key.js", [
      "const { 1: load } = arguments;",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-arguments-computed-key.js", [
      "const { [1]: load } = arguments;",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-arguments-array.js", [
      "const [, load] = arguments;",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-arguments-rest.js", [
      "const [, ...remaining] = arguments;",
      "const [load] = remaining;",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-arguments-arrow-spread.js", [
      "const load = ((...captured) => captured[1])(...arguments);",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-arguments-array-from.js", [
      "const load = Array.from(arguments)[1];",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-arguments-object-values.js", [
      "const load = Object.values(arguments)[1];",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-arguments-map.js", [
      "const load = new Map(Array.from(arguments, (value, index) => [index, value])).get(1);",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-arguments-bound-module.js", [
      "const load = arguments[1].bind(module);",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    ...Object.fromEntries(loaderVariants),
  });

  for (const [relativePath] of loaderVariants) {
    const payload = path.join(repositoryRoot, ...relativePath.split("/"));
    const executed = spawnSync(process.execPath, [payload], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:unrecognized-executable-arguments-access`,
    ), `${relativePath}: ${soleOwner.verification.evidence_refs.join(", ")}`);
  }
});

test("computed object destructuring cannot hide global process module loader aliases", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-computed-object-destructure-literal.js", [
      "module.exports = function loadFrom(globalObject) {",
      "  const { ['process']: p } = globalObject;",
      "  const { ['mainModule']: M } = p;",
      "  const { ['require']: r } = M;",
      "  const config = r.bind(M)('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "};",
      "",
    ].join("\n"), "{ process: globalThis.process }"],
    ["src/rogue-computed-object-destructure-concatenated.js", [
      "module.exports = function loadFrom(globalObject) {",
      "  const { ['pro' + 'cess']: p } = globalObject;",
      "  const { ['main' + 'Module']: M } = p;",
      "  const { ['requ' + 'ire']: r } = M;",
      "  const config = r.bind(M)('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "};",
      "",
    ].join("\n"), "{ process: globalThis.process }"],
    ["src/rogue-computed-object-destructure-nested.js", [
      "module.exports = function loadFrom(input) {",
      "  const { ['outer']: { ['process']: p } } = input;",
      "  const { ['mainModule']: M } = p;",
      "  const { ['require']: r } = M;",
      "  const config = r.bind(M)('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "};",
      "",
    ].join("\n"), "{ outer: { process: globalThis.process } }"],
    ["src/rogue-computed-object-destructure-rest.js", [
      "module.exports = function loadFrom(globalObject) {",
      "  const { ...aliases } = globalObject;",
      "  const { ['process']: p } = aliases;",
      "  const { ['mainModule']: M } = p;",
      "  const { ['require']: r } = M;",
      "  const config = r.bind(M)('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "};",
      "",
    ].join("\n"), "{ process: globalThis.process }"],
    ["src/rogue-computed-object-destructure-assignment.js", [
      "module.exports = function loadFrom(globalObject) {",
      "  let p;",
      "  ({ ['process']: p } = globalObject);",
      "  const { ['mainModule']: M } = p;",
      "  const { ['require']: r } = M;",
      "  const config = r.bind(M)('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "};",
      "",
    ].join("\n"), "{ process: globalThis.process }"],
    ["src/rogue-computed-object-destructure-array-pattern.js", [
      "module.exports = function loadFrom(globalObject) {",
      "  const [{ ['process']: p }] = [globalObject];",
      "  const { ['mainModule']: M } = p;",
      "  const { ['require']: r } = M;",
      "  const config = r.bind(M)('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "};",
      "",
    ].join("\n"), "{ process: globalThis.process }"],
    ["src/rogue-computed-object-destructure-parameter.js", [
      "module.exports = function loadFrom({ ['process']: p }) {",
      "  const { ['mainModule']: M } = p;",
      "  const { ['require']: r } = M;",
      "  const config = r.bind(M)('@app/config');",
      "  if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "};",
      "",
    ].join("\n"), "{ process: globalThis.process }"],
    ["src/rogue-computed-object-destructure-for-of.js", [
      "module.exports = function loadFrom(globalObject) {",
      "  for (const { ['process']: p } of [globalObject]) {",
      "    const { ['mainModule']: M } = p;",
      "    const { ['require']: r } = M;",
      "    const config = r.bind(M)('@app/config');",
      "    if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "  }",
      "};",
      "",
    ].join("\n"), "{ process: globalThis.process }"],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    ...Object.fromEntries(loaderVariants.map(([relativePath, source]) => [relativePath, source])),
  });

  for (const [relativePath, , inputExpression] of loaderVariants) {
    const payload = path.join(repositoryRoot, ...relativePath.split("/"));
    const executed = spawnSync(process.execPath, [
      "-e",
      `process.mainModule = module; require(${JSON.stringify(payload)})(${inputExpression});`,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:unrecognized-object-destructuring-pattern`,
    ), `${relativePath}: ${soleOwner.verification.evidence_refs.join(", ")}`);
  }
});

test("ordinary computed object literals remain within the verified subset", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/benign-computed-object-literal.js": [
      "const record = {",
      "  ['process']: 'plain',",
      "  ['main' + 'Module']: 'plain',",
      "  nested: { ['require']: 'plain' },",
      "  ...{ stable: true },",
      "};",
      "if (record.stable !== true) {",
      "  throw new Error('fixture literal did not resolve');",
      "}",
      "",
    ].join("\n"),
    "src/benign-parameter-default-object-literal.js": [
      "function create(value = { ['process']: 'plain', ...{ stable: true } }) {",
      "  return value.stable;",
      "}",
      "if (create() !== true) {",
      "  throw new Error('fixture parameter literal did not resolve');",
      "}",
      "",
    ].join("\n"),
    "src/benign-parameter-array-object-literal.js": [
      "function create(value = [{ ['process']: 'plain' }]) {",
      "  return value.length;",
      "}",
      "if (create() !== 1) {",
      "  throw new Error('fixture parameter array literal did not resolve');",
      "}",
      "",
    ].join("\n"),
  });
  for (const relativePath of [
    "src/benign-computed-object-literal.js",
    "src/benign-parameter-default-object-literal.js",
    "src/benign-parameter-array-object-literal.js",
  ]) {
    const payload = path.join(repositoryRoot, ...relativePath.split("/"));
    const executed = spawnSync(process.execPath, [payload], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "pass");
  assert.ok(soleOwner.verification.evidence_refs.includes("owner-import:src/config-owner.js:@app/config"));
});

test("ambient this process binding aliases cannot spawn a child module loader", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    "src/rogue-this-process-binding.js": [
      "(function () {",
      "  const runtime = this.process;",
      "  const spawn = runtime.binding('spawn_sync').spawn;",
      "  const envPairs = Object.entries(runtime.env).map(([key, value]) => key + '=' + value);",
      "  const result = spawn({",
      "    file: runtime.execPath,",
      "    args: [runtime.execPath, '-e', \"const config = require('@app/config'); if (config.source !== 'fixture') process.exit(1);\"],",
      "    cwd: runtime.cwd(),",
      "    windowsHide: true,",
      "    windowsVerbatimArguments: false,",
      "    detached: false,",
      "    envPairs,",
      "    stdio: [",
      "      { type: 'pipe', readable: true, writable: false },",
      "      { type: 'pipe', readable: false, writable: true },",
      "      { type: 'pipe', readable: false, writable: true },",
      "    ],",
      "    maxBuffer: 1024 * 1024,",
      "  });",
      "  if (result.status !== 0) throw new Error('fixture child process did not resolve config');",
      "})();",
      "",
    ].join("\n"),
  });
  const payload = path.join(repositoryRoot, "src", "rogue-this-process-binding.js");
  const executed = spawnSync(process.execPath, [payload], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-this-process-binding.js:unrecognized-executable-ambient-global-access",
  ));
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-this-process-binding.js:unrecognized-process-capability-access",
  ));
});

test("spread ambient roots are not mistaken for member properties", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/rogue-spread-this.js": [
      "module.exports = function copyRoot() {",
      "  return { ...this };",
      "};",
      "",
    ].join("\n"),
  });
  const payload = path.join(repositoryRoot, "src", "rogue-spread-this.js");
  const executed = spawnSync(process.execPath, [
    "-e",
    `const copy = require(${JSON.stringify(payload)}).call({ process: globalThis.process }); if (copy.process !== globalThis.process) process.exit(1);`,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-spread-this.js:unrecognized-executable-ambient-global-access",
  ));
});

test("native capability properties are unverifiable through arbitrary aliases", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const propertyNames = ["binding", "_linkedBinding", "dlopen", "_load", "createRequire"];
  const repositoryRoot = writeRepositoryFixture(t, Object.fromEntries(propertyNames.map((propertyName) => [
    `src/rogue-capability-${propertyName}.js`,
    `const candidate = supplied?.${propertyName};\nvoid candidate;\n`,
  ])));

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const propertyName of propertyNames) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:src/rogue-capability-${propertyName}.js:unrecognized-process-capability-access`,
    ));
  }
});

test("runtime-reachable variable-computed loaders and static code-execution capabilities are unverifiable", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-variable-computed-constructor.js", [
      "const key = 'constructor';",
      "const ObjectCtor = ({})[key];",
      "const FunctionCtor = ObjectCtor[key];",
      "const load = FunctionCtor('return require')();",
      "const config = load('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-fs-then-variable-computed-constructor.js", [
      "const fs = process.getBuiltinModule('fs');",
      "const key = 'constructor';",
      "const ObjectCtor = ({})[key];",
      "const FunctionCtor = ObjectCtor[key];",
      "const load = FunctionCtor('return require')();",
      "const config = load('@app/config');",
      "if (typeof fs.readFileSync !== 'function' || config.source !== 'fixture') throw new Error('fixture loader did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-process-import-computed-builtin-loader.js", [
      "const p = require('node:process');",
      "const key = 'getBuiltinModule';",
      "const M = p[key]('module');",
      "const fs = M._load('node:fs');",
      "if (typeof fs.readFileSync !== 'function') throw new Error('fixture builtin did not resolve');",
      "",
    ].join("\n")],
    ["src/rogue-vm-import-loader.js", [
      "const vm = require('node:vm');",
      "const config = vm.runInThisContext(\"require('@app/config')\");",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
      "",
    ].join("\n")],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: 'fixture' };\n",
    ...Object.fromEntries(loaderVariants),
  });

  for (const [relativePath] of loaderVariants) {
    const payload = path.join(repositoryRoot, ...relativePath.split("/"));
    const executed = spawnSync(process.execPath, [
      "-e",
      `globalThis.require = require; require(${JSON.stringify(payload)});`,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-variable-computed-constructor.js:unrecognized-dynamic-property-loader-access",
  ));
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-fs-then-variable-computed-constructor.js:unrecognized-dynamic-property-loader-access",
  ));
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-process-import-computed-builtin-loader.js:static-process-loader-capability-import",
  ));
  assert.ok(soleOwner.verification.evidence_refs.includes(
    "unsupported-import-call:src/rogue-vm-import-loader.js:static-vm-code-execution-capability-import",
  ));
});

test("optional fs and direct non-fs process builtin access are unverifiable", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-optional-fs-builtin.js", [
      "const fs = process?.getBuiltinModule('fs');",
      "if (typeof fs.readFileSync !== 'function') throw new Error('fixture fs did not resolve');",
    ]],
    ["src/rogue-child-process-builtin.js", [
      "const childProcess = process.getBuiltinModule('child_process');",
      "if (typeof childProcess.spawn !== 'function') throw new Error('fixture child_process did not resolve');",
    ]],
  ];
  const repositoryRoot = writeRepositoryFixture(t, Object.fromEntries(loaderVariants.map(([relativePath, lines]) => [
    relativePath,
    [...lines, ""].join("\n"),
  ])));
  for (const [relativePath] of loaderVariants) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath] of loaderVariants) {
    assert.ok(soleOwner.verification.evidence_refs.includes(
      `unsupported-import-call:${relativePath}:nontrivial-process-builtin-module-loader-access`,
    ));
  }
});

test("runtime-valid identifier escapes and escaped fs literals are unverifiable", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const loaderVariants = [
    ["src/rogue-escaped-require.js", [
      "const config = requ\\u0069re('@app/config');",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ], "source-syntax"],
    ["src/rogue-escaped-builtin-loader.js", [
      "const M = process.get\\u0042uiltinModule('module');",
      "const parent = M._cache[process.argv[1]];",
      "const config = M._load('@app/config', parent);",
      "if (config.source !== 'fixture') throw new Error('fixture config did not resolve');",
    ], "source-syntax"],
    ["src/rogue-escaped-fs-builtin.js", [
      "const fs = process.getBuiltinModule('\\x66s');",
      "if (typeof fs.readFileSync !== 'function') throw new Error('fixture fs did not resolve');",
    ], "nontrivial-process-builtin-module-loader-access"],
  ];
  const repositoryRoot = writeRepositoryFixture(t, {
    "node_modules/@app/config/index.js": "module.exports = { source: \"fixture\" };\n",
    ...Object.fromEntries(loaderVariants.map(([relativePath, lines]) => [
      relativePath,
      [...lines, ""].join("\n"),
    ])),
  });
  for (const [relativePath] of loaderVariants) {
    const executed = spawnSync(process.execPath, [path.join(repositoryRoot, ...relativePath.split("/"))], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(executed.status, 0, `${relativePath}: ${executed.stderr || executed.error?.message}`);
  }

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  for (const [relativePath, , reason] of loaderVariants) {
    if (reason === "source-syntax") {
      assert.ok(soleOwner.verification.evidence_refs.includes(`unsupported-source-syntax:${relativePath}`));
    } else {
      assert.ok(soleOwner.verification.evidence_refs.includes(`unsupported-import-call:${relativePath}:${reason}`));
    }
  }
});

test("static sole-owner evaluation recognizes code after a CR-terminated line comment", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/rogue-cr.js": "// comment\rconst config = require(\"@app/config\");\r",
  });
  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "fail");
  assert.ok(soleOwner.verification.evidence_refs.includes("non-owner-import:src/rogue-cr.js:@app/config"));
});

test("static sole-owner evaluation is unverifiable for template interpolation it cannot lex safely", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "src/template-expression.js": "const value = `${require(\"@app/config\")}`;\n",
  });
  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: [],
    changed_paths_evidence_ref: "git-diff:fixture-clean",
  });
  const soleOwner = result.rules.find((rule) => rule.rule_id === "PG-SINGLE-OWNER-CHOKEPOINT-001");

  assert.equal(soleOwner.status, "unverifiable");
  assert.ok(soleOwner.verification.evidence_refs.includes("unsupported-source-syntax:src/template-expression.js"));
});

test("Programming Guidelines evaluator fails each supported mechanical violation without caller verdicts", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t, {
    "package.json": `${JSON.stringify({ name: "fixture-repository", dependencies: { "left-pad": "1.0.0" } }, null, 2)}\n`,
    "src/rogue.js": "require(\"legacy-config\"); require(\"@app/config\");\n",
    "scratch/note.txt": "forbidden layout\n",
    ".env": "DO_NOT_COMMIT=fixture\n",
  });
  fs.rmSync(path.join(repositoryRoot, "tests"), { recursive: true, force: true });

  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: ["generated/client.js"],
    changed_paths_evidence_ref: "git-diff:fixture-generated-edit",
  });
  const statusById = Object.fromEntries(result.rules.map((rule) => [rule.rule_id, rule.status]));
  for (const ruleId of [
    "PG-LAYOUT-NAMESPACE-001",
    "PG-DEPENDENCY-AUTHORITY-001",
    "PG-SINGLE-OWNER-CHOKEPOINT-001",
    "PG-TESTING-001",
    "PG-GENERATED-CONTRACTS-001",
    "PG-SECRETS-CONFIG-001",
  ]) {
    assert.equal(statusById[ruleId], "fail", ruleId);
  }
});

test("a failed hard invariant remains prominent beside passing conventions", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t);
  const result = evaluateProgrammingGuidelinesProfile({
    profile,
    repository_root: repositoryRoot,
    changed_paths: ["generated/client.js"],
    changed_paths_evidence_ref: "git-diff:fixture-generated-edit",
  });

  assert.equal(result.summary.status, "fail");
  assert.ok(result.summary.hard_invariant_failures.includes("PG-GENERATED-CONTRACTS-001"));
  assert.ok(result.summary.by_status.pass.includes("PG-LAYOUT-NAMESPACE-001"));
  assert.equal("score" in result.summary, false);
  assert.equal("average" in result.summary, false);
});

test("Programming Guidelines evaluator rejects or recomputes caller pass claims", (t) => {
  const compiled = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t);
  const callerClaimedPass = compilePolicy({
    document_path: compiled.source.document_path,
    expected_digest: compiled.source.digest,
    rule_map: compiled.rules.map((rule) => ({ ...structuredClone(rule), status: "pass" })),
  });

  assert.throws(
    () => evaluateProgrammingGuidelinesProfile({
      profile: callerClaimedPass,
      repository_root: repositoryRoot,
      changed_paths: [],
      changed_paths_evidence_ref: "git-diff:fixture-clean",
      status: "pass",
    }),
    /FAIL-PROGRAMMING-GUIDELINES-INPUT/,
  );

  const evaluated = evaluateProgrammingGuidelinesProfile({
    profile: callerClaimedPass,
    repository_root: repositoryRoot,
    changed_paths: ["generated/client.js"],
    changed_paths_evidence_ref: "git-diff:fixture-generated-edit",
  });
  const statusById = Object.fromEntries(evaluated.rules.map((rule) => [rule.rule_id, rule.status]));
  assert.equal(statusById["PG-FAIL-CLOSED-001"], "unverifiable");
  assert.equal(statusById["PG-GENERATED-CONTRACTS-001"], "fail");
});

test("missing generated-change evidence is unverifiable rather than a false pass", (t) => {
  const profile = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const repositoryRoot = writeRepositoryFixture(t);
  const result = evaluateProgrammingGuidelinesProfile({ profile, repository_root: repositoryRoot });
  const generated = result.rules.find((rule) => rule.rule_id === "PG-GENERATED-CONTRACTS-001");
  assert.equal(generated.status, "unverifiable");
});

test("Programming Guidelines evaluator rejects an oracle forged away from the pinned source section", (t) => {
  const compiled = compileProgrammingGuidelinesProfile(writeAdoptedProgrammingGuidelinesFixture(t));
  const forgedRules = structuredClone(compiled.rules);
  const layoutRule = forgedRules.find((rule) => rule.rule_id === "PG-LAYOUT-NAMESPACE-001");
  const forgedMechanic = JSON.stringify({ kind: "forbidden_paths", patterns: ["never/**"] });
  layoutRule.oracle = `pg-evaluator-v1:${Buffer.from(forgedMechanic, "utf8").toString("base64url")}`;
  const forged = compilePolicy({
    document_path: compiled.source.document_path,
    expected_digest: compiled.source.digest,
    rule_map: forgedRules,
  });
  const repositoryRoot = writeRepositoryFixture(t, { "scratch/note.txt": "must fail\n" });

  assert.throws(
    () => evaluateProgrammingGuidelinesProfile({
      profile: forged,
      repository_root: repositoryRoot,
      changed_paths: [],
      changed_paths_evidence_ref: "git-diff:fixture-clean",
    }),
    /FAIL-PROGRAMMING-GUIDELINES-PROFILE/,
  );
});
