"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  assertPackage,
  checkPackage,
} = require("./package-check.js");

const packageRoot = path.resolve(__dirname, "..");
const skillsRoot = path.resolve(packageRoot, "..");

// The fixture copies every shared package the skill manifest declares in
// depends_on, plus the resolver and the shared engine, so a mutation test
// fails only for its own mutation (proved by the control test below).
function fixtureSharedPackages() {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "MANIFEST.json"), "utf8"));
  assert.ok(Array.isArray(manifest.depends_on) && manifest.depends_on.length > 0, "skill manifest must declare depends_on");
  const names = new Set(["shared/capability-registry", "shared/software-engineering-intelligence"]);
  for (const dependency of manifest.depends_on) {
    assert.match(dependency, /^shared\/[a-z0-9-]+$/, `unexpected depends_on entry ${dependency}`);
    names.add(dependency);
  }
  return [...names].sort();
}

function temporaryPackage() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sei-package-check-"));
  const root = path.join(workspace, "skills", "software-engineering-intelligence");
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.cpSync(packageRoot, root, { recursive: true });
  for (const relativePath of fixtureSharedPackages()) {
    fs.cpSync(path.join(skillsRoot, relativePath), path.join(workspace, "skills", relativePath), { recursive: true });
  }
  return { root, workspace, engineRoot: path.join(workspace, "skills", "shared", "software-engineering-intelligence") };
}

function checkMutation(mutate) {
  const fixture = temporaryPackage();
  try {
    mutate(fixture);
    return checkPackage(fixture.root);
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true });
  }
}

function assertRejects(result, expectedErrors) {
  assert.equal(result.ok, false, "mutation must be rejected");
  for (const expected of [].concat(expectedErrors)) {
    assert.ok(result.errors.includes(expected), `expected error:\n  ${expected}\nactual errors:\n  ${result.errors.join("\n  ")}`);
  }
}

function editJson(filePath, edit) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  edit(value);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function tryLink(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip(`${type} links need elevated privileges here (${error.code})`);
      return false;
    }
    throw error;
  }
}

test("SEI package declares one model-core file and complete progressive-disclosure policy", () => {
  const result = checkPackage(packageRoot);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.context.default_model_context, ["SKILL.md"]);
  assert.equal(result.context.conditional_model_context.length, 7);
});

test("control: an unmodified fixture built from the manifest depends_on passes package-check", () => {
  assert.deepEqual(fixtureSharedPackages(), [
    "shared/assessment-runtime-contract",
    "shared/capability-registry",
    "shared/project-intelligence-workspace",
    "shared/report-election",
    "shared/report-presentation",
    "shared/software-engineering-intelligence",
  ]);
  const result = checkMutation(() => {});
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("SEI packages declare minimum runtime capabilities and the public static-intelligence seam", () => {
  const productManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "MANIFEST.json"), "utf8"));
  const sharedManifest = JSON.parse(fs.readFileSync(path.join(skillsRoot, "shared", "software-engineering-intelligence", "MANIFEST.json"), "utf8"));
  assert.equal(productManifest.runtime, "node-builtins-plus-optional-cpython-min-3.13-typescript-compiler-api-jdk-compiler-min-25-stdlib");
  assert.equal(sharedManifest.runtime, "node-builtins-plus-optional-cpython-min-3.13-typescript-compiler-api-jdk-compiler-min-25-stdlib");
  assert.deepEqual(productManifest.java_lanes, { portable: "always", hermetic_jdk25: "conditional-unavailable-below-25" });
  assert.deepEqual(sharedManifest.java_lanes, { portable: "always", hermetic_jdk25: "conditional-unavailable-below-25" });
  assert.deepEqual(productManifest.java_toolchain, sharedManifest.java_toolchain);
  assert.deepEqual(productManifest.java_toolchain, {
    platform: "win32",
    vendor: "Oracle Corporation",
    runtime_version: "25.0.3+9-LTS-195",
    java_sha256: "173806fbfaf125493d69ecca62ef57a8d975e4cd9f0d489f1496be7be4548941",
    javac_sha256: "98b1e2c19ba021660d6be117040be977e898cb0204d9b01f11f2fa3ec6b03f7c",
  });
  assert.deepEqual(sharedManifest.public_exports["static-intelligence.js"], [
    "PYTHON_AST_ANALYZER_VERSION",
    "analyzeStaticIntelligence",
  ]);
  assert.ok(sharedManifest.exports.includes("static-intelligence.PYTHON_AST_ANALYZER_VERSION"));
  assert.ok(sharedManifest.exports.includes("static-intelligence.analyzeStaticIntelligence"));
  assert.ok(sharedManifest.inventory.analyzer_fixtures.includes("fixtures/cqr-python-static-c8e6137.expected.json"));
  assert.ok(sharedManifest.inventory.benchmarks.includes("benchmarks/python-static-benchmark.js"));
  assert.deepEqual(sharedManifest.inventory.scripts, ["scripts/verify-cqr-incrementality.js", "scripts/verify-cqr-python-static.js"]);
  assert.ok(sharedManifest.inventory.benchmarks.includes("benchmarks/incremental-run-benchmark.js"));
  assert.ok(sharedManifest.inventory.tests.includes("benchmarks/incremental-run-benchmark.test.js"));
  assert.ok(sharedManifest.inventory.tests.includes("scripts/verify-cqr-incrementality.test.js"));
  assert.ok(sharedManifest.inventory.tests.includes("benchmarks/python-static-benchmark.test.js"));
  assert.ok(sharedManifest.inventory.tests.includes("scripts/verify-cqr-python-static.test.js"));
});

test("SEI packages inventory incremental run state without registry exposure", () => {
  const sharedManifest = JSON.parse(fs.readFileSync(path.join(skillsRoot, "shared", "software-engineering-intelligence", "MANIFEST.json"), "utf8"));
  assert.ok(sharedManifest.inventory.modules.includes("incremental-run-state.js"));
  assert.ok(sharedManifest.inventory.tests.includes("incremental-run-state.test.js"));
  assert.equal(sharedManifest.public_exports["incremental-run-state.js"], undefined);
  assert.equal(sharedManifest.exports.some((entry) => entry.startsWith("incremental-run-state.")), false);
});

test("SEI package requires V7 semantic presentation seams and rejects their manifest export drift", () => {
  const expected = {
    "semantic-evidence.js": ["SEMANTIC_EVIDENCE_VERSION", "deriveEvidence", "interpretEvidence"],
    "capability-coverage.js": ["CAPABILITY_COVERAGE_VERSION", "deriveCapabilityCoverage"],
    "complexity-presentation.js": ["COMPLEXITY_PRESENTATION_VERSION", "deriveComplexityPresentation"],
    "predictive-candidate-experiment.js": ["PREDICTIVE_CANDIDATE_EXPERIMENT_VERSION", "evaluatePredictiveCandidateExperiment"],
    "predictive-status.js": ["PREDICTIVE_STATUS_VERSION", "derivePredictiveStatus"],
    "trend-status.js": ["TREND_STATUS_VERSION", "deriveTrendStatus"],
    "assessment-standards.js": ["MARK_ENGINEERING_STANDARD", "MARK_SOURCE_DIGEST", "SEI_DEFAULT_ENGINEERING_STANDARD", "STANDARD_RESOLUTION_VERSION", "resolveAssessmentStandard"],
    "engineering-assessment.js": ["ASSESSMENT_SCHEMA_VERSION", "assessRepositoryEngineering", "validateAssessment"],
    "framework-lenses.js": ["FRAMEWORK_LENS_IDS", "FRAMEWORK_LENS_VERSION", "buildFrameworkLenses"],
  };
  const sharedManifestPath = path.join(skillsRoot, "shared", "software-engineering-intelligence", "MANIFEST.json");
  const sharedManifest = JSON.parse(fs.readFileSync(sharedManifestPath, "utf8"));
  for (const [moduleName, exportNames] of Object.entries(expected)) {
    const prefix = moduleName.slice(0, -3);
    assert.deepEqual(sharedManifest.public_exports[moduleName], exportNames, `${moduleName} must declare its public contract`);
    assert.ok(sharedManifest.inventory.modules.includes(moduleName), `${moduleName} must be inventoried as a module`);
    assert.ok(sharedManifest.inventory.tests.includes(`${prefix}.test.js`), `${moduleName} must have its test inventoried`);
    assert.ok(sharedManifest.owned_files.includes(moduleName), `${moduleName} must be owned`);
    assert.ok(sharedManifest.owned_files.includes(`${prefix}.test.js`), `${moduleName} test must be owned`);
    for (const exportName of exportNames) {
      assert.ok(sharedManifest.exports.includes(`${prefix}.${exportName}`), `${moduleName}:${exportName} must be registry-visible`);
    }
  }

  for (const [moduleName, exportNames] of Object.entries(expected)) {
    const missingExport = exportNames.at(-1);
    const prefix = moduleName.slice(0, -3);
    const result = checkMutation(({ engineRoot }) => editJson(path.join(engineRoot, "MANIFEST.json"), (manifest) => {
      manifest.public_exports[moduleName] = manifest.public_exports[moduleName].filter((entry) => entry !== missingExport);
      manifest.exports = manifest.exports.filter((entry) => entry !== `${prefix}.${missingExport}`);
    }));
    assertRejects(result, `FAIL-SHARED-MANIFEST: ${moduleName} must declare its complete required public exports`);
  }
});

test("SEI package rejects a CQR Python oracle moved into the wrong shared inventory category", () => {
  const result = checkMutation(({ engineRoot }) => editJson(path.join(engineRoot, "MANIFEST.json"), (manifest) => {
    manifest.inventory.scripts = manifest.inventory.scripts.filter((entry) => entry !== "scripts/verify-cqr-python-static.js");
    manifest.inventory.modules.push("scripts/verify-cqr-python-static.js");
  }));
  assertRejects(result, "FAIL-SHARED-MANIFEST: shared engine scripts must declare every CQR Python oracle/benchmark file");
});

test("SEI package keeps collection/adapters and comparison/calibration guidance conditional", () => {
  const result = checkMutation(({ root }) => fs.rmSync(path.join(root, "references", "collection-adapters.md")));
  assertRejects(result, [
    "FAIL-PACKAGE-FILE: required file missing: references/collection-adapters.md",
    "FAIL-PACKAGE-REFERENCES: SKILL.md link is missing or escapes package: references/collection-adapters.md",
  ]);
});

test("SEI package rejects a fixture promoted into default model context", () => {
  const fixture = temporaryPackage();
  try {
    editJson(path.join(fixture.root, "context-policy.json"), (policy) => policy.core.push("assets/canonical-input.json"));
    const expected = "FAIL-CONTEXT-REGRESSION: SKILL.md must be the only default model-context file";
    assertRejects(checkPackage(fixture.root), expected);
    assert.throws(() => assertPackage(fixture.root), (error) => error.message.split("\n").includes(expected));
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test("SEI package rejects missing negative route coverage", () => {
  const result = checkMutation(({ root }) => editJson(path.join(root, "evals", "evals.json"), (evals) => {
    evals.cases = evals.cases.filter((entry) => entry.id !== "negative-ria-lifecycle");
  }));
  assertRejects(result, "FAIL-EVAL-COVERAGE: required evaluation missing: negative-ria-lifecycle");
});

test("SEI package rejects a missing referenced contract", () => {
  const result = checkMutation(({ root }) => fs.rmSync(path.join(root, "references", "evidence-contract.md")));
  assertRejects(result, [
    "FAIL-PACKAGE-FILE: required file missing: references/evidence-contract.md",
    "FAIL-PACKAGE-REFERENCES: SKILL.md link is missing or escapes package: references/evidence-contract.md",
  ]);
});

test("SEI package rejects shared-engine path drift in the skill manifest", () => {
  const result = checkMutation(({ root }) => editJson(path.join(root, "MANIFEST.json"), (manifest) => {
    manifest.shared_engine.path = "../shared/software-engineering-intelligence/missing.js";
  }));
  assertRejects(result, "FAIL-PACKAGE-MANIFEST: shared engine must be the declared model-opaque CLI boundary");
});

test("SEI package rejects a stale V1 runner import before a standalone subprocess can use it", () => {
  const result = checkMutation(({ root }) => {
    const runnerPath = path.join(root, "scripts", "run-sei.js");
    const runner = fs.readFileSync(runnerPath, "utf8");
    assert.ok(runner.includes("../../shared/software-engineering-intelligence/layout.js"));
    fs.writeFileSync(
      runnerPath,
      runner.replace("../../shared/software-engineering-intelligence/layout.js", "../../../shared/software-engineering-intelligence/layout.js"),
    );
    const subprocess = spawnSync(process.execPath, [runnerPath], { encoding: "utf8", windowsHide: true });
    assert.notEqual(subprocess.status, 0, "the stale topology import must not silently execute");
    assert.match(`${subprocess.stderr}\n${subprocess.stdout}`, /Cannot find module[\s\S]*layout\.js/);
  });
  assertRejects(result, [
    "FAIL-SHARED-ENGINE: runner must resolve the shared CLI through the canonical layout boundary",
    "FAIL-SHARED-ENGINE: runner did not execute the canonical CLI through the layout boundary",
  ]);
});

test("SEI package rejects a comment-only runner that merely mentions the layout boundary", () => {
  const result = checkMutation(({ root }) => fs.writeFileSync(
    path.join(root, "scripts", "run-sei.js"),
    '// require("../../shared/software-engineering-intelligence/layout.js") resolveSeiLayout execute\n',
  ));
  assert.equal(result.errors.includes("FAIL-SHARED-ENGINE: runner must resolve the shared CLI through the canonical layout boundary"), false, "the text-only check is fooled by design; behaviour must catch it");
  assertRejects(result, "FAIL-SHARED-ENGINE: runner did not execute the canonical CLI through the layout boundary");
});

test("SEI package rejects a comment-only maturity runner that merely mentions the scorer", () => {
  const result = checkMutation(({ root }) => fs.writeFileSync(
    path.join(root, "scripts", "score-sei-maturity.js"),
    '// require("../../shared/software-engineering-intelligence/layout.js") resolveSeiLayout scoreMaturity validateMaturityScorecard\n',
  ));
  assertRejects(result, "FAIL-SHARED-ENGINE: maturity runner did not execute the canonical scorer through the layout boundary");
});

test("SEI package rejects a shared module whose actual public exports no longer match the manifest", () => {
  const result = checkMutation(({ engineRoot }) => {
    const policyPath = path.join(engineRoot, "policy.js");
    const policy = fs.readFileSync(policyPath, "utf8");
    assert.ok(policy.includes("module.exports = { compilePolicy, validatePolicyProfile };"));
    fs.writeFileSync(policyPath, policy.replace("module.exports = { compilePolicy, validatePolicyProfile };", "module.exports = {};"));
  });
  assertRejects(result, "FAIL-SHARED-MANIFEST: policy.js exports do not match the declared public interface");
});

test("SEI package rejects a shared manifest that removes a required module export from every declaration", () => {
  const result = checkMutation(({ engineRoot }) => editJson(path.join(engineRoot, "MANIFEST.json"), (manifest) => {
    delete manifest.public_exports["policy.js"];
    manifest.exports = manifest.exports.filter((entry) => entry !== "policy.compilePolicy");
  }));
  assertRejects(result, "FAIL-SHARED-MANIFEST: policy.js must declare its complete required public exports");
});

test("SEI package requires the TaskExecutor module and its public export contract", () => {
  const missing = checkMutation(({ engineRoot }) => {
    fs.rmSync(path.join(engineRoot, "task-executor.js"));
    fs.rmSync(path.join(engineRoot, "task-executor.test.js"));
  });
  assertRejects(missing, "FAIL-SHARED-MANIFEST: declared public module is missing: task-executor.js");

  const drift = checkMutation(({ engineRoot }) => {
    const modulePath = path.join(engineRoot, "task-executor.js");
    fs.writeFileSync(modulePath, fs.readFileSync(modulePath, "utf8").replace(
      "module.exports = { RESOURCE_CLASSES, TaskExecutor };",
      "module.exports = { TaskExecutor };",
    ));
  });
  assertRejects(drift, "FAIL-SHARED-MANIFEST: task-executor.js exports do not match the declared public interface");
});

test("SEI package requires the repository index module, test, and exact public export contract", () => {
  const missing = checkMutation(({ engineRoot }) => {
    fs.rmSync(path.join(engineRoot, "repository-index.js"));
    fs.rmSync(path.join(engineRoot, "repository-index.test.js"));
  });
  assertRejects(missing, "FAIL-SHARED-MANIFEST: declared public module is missing: repository-index.js");

  const drift = checkMutation(({ engineRoot }) => fs.appendFileSync(path.join(engineRoot, "repository-index.js"), "\nmodule.exports = {};\n"));
  assertRejects(drift, "FAIL-SHARED-MANIFEST: repository-index.js exports do not match the declared public interface");
});

test("SEI package rejects drift in every indexed consumer public seam", () => {
  for (const [moduleName, exportName] of [
    ["collectors.js", "collectStaticEvidenceFromIndex"],
    ["collectors.js", "deriveCollectorConfigurationHash"],
    ["collectors.js", "mergeLocalEvidence"],
    ["verification-artifacts.js", "discoverRevisionBoundVerificationEvidenceFromIndex"],
  ]) {
    const prefix = moduleName.slice(0, -3);
    const result = checkMutation(({ engineRoot }) => editJson(path.join(engineRoot, "MANIFEST.json"), (manifest) => {
      manifest.public_exports[moduleName] = manifest.public_exports[moduleName].filter((name) => name !== exportName);
      manifest.exports = manifest.exports.filter((name) => name !== `${prefix}.${exportName}`);
    }));
    assertRejects(result, `FAIL-SHARED-MANIFEST: ${moduleName} must declare its complete required public exports`);
  }
});

test("SEI package rejects baseline metadata that exposes a forbidden owner reference", () => {
  const result = checkMutation(({ root }) => editJson(path.join(root, "MANIFEST.json"), (manifest) => {
    manifest.baseline_integration.m1_outputs.push("engineering_intelligence_ref");
  }));
  assertRejects(result, "FAIL-PACKAGE-BOUNDARY: baseline integration may expose only standalone evidence and SEI assessment artifacts");
});

test("SEI package rejects a file symlink inside the package", (t) => {
  const fixture = temporaryPackage();
  try {
    const outside = path.join(fixture.workspace, "outside.md");
    fs.writeFileSync(outside, "# outside\n");
    if (!tryLink(t, outside, path.join(fixture.root, "references", "linked.md"), "file")) return;
    assertRejects(checkPackage(fixture.root), "FAIL-PACKAGE-LINK: skill package contains a link or junction: references/linked.md");
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test("SEI package rejects a junction and does not follow it to satisfy required files", (t) => {
  const fixture = temporaryPackage();
  try {
    const references = path.join(fixture.root, "references");
    const outside = path.join(fixture.workspace, "outside-references");
    fs.cpSync(references, outside, { recursive: true });
    fs.rmSync(references, { recursive: true, force: true });
    if (!tryLink(t, outside, references, "junction")) return;
    const result = checkPackage(fixture.root);
    assertRejects(result, [
      "FAIL-PACKAGE-LINK: skill package contains a link or junction: references",
      "FAIL-PACKAGE-FILE: required file missing: references/evidence-contract.md",
      "FAIL-PACKAGE-REFERENCES: SKILL.md link is missing or escapes package: references/evidence-contract.md",
    ]);
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test("SEI package rejects openai.yaml whose required policy exists only inside a comment", () => {
  const result = checkMutation(({ root }) => {
    const yamlPath = path.join(root, "openai.yaml");
    const yaml = fs.readFileSync(yamlPath, "utf8");
    assert.ok(yaml.includes("  allow_implicit_invocation: false"));
    fs.writeFileSync(yamlPath, yaml.replace(
      "  allow_implicit_invocation: false",
      "  allow_implicit_invocation: true # allow_implicit_invocation: false",
    ));
  });
  assertRejects(result, "FAIL-PACKAGE-METADATA: openai.yaml policy.allow_implicit_invocation must be false");
});

test("SEI package rejects an openai.yaml that is entirely commented out", () => {
  const result = checkMutation(({ root }) => {
    const yamlPath = path.join(root, "openai.yaml");
    const commented = fs.readFileSync(yamlPath, "utf8").split(/\r?\n/).map((line) => (line ? `# ${line}` : line)).join("\n");
    fs.writeFileSync(yamlPath, commented);
  });
  assertRejects(result, "FAIL-PACKAGE-METADATA: openai.yaml must declare exactly interface and policy");
});

test("SEI package rejects a runtime contract that is not closed", () => {
  const result = checkMutation(({ root }) => editJson(path.join(root, "RUNTIME-CONTRACT.json"), (contract) => {
    contract.unexpected = true;
  }));
  assertRejects(result, "FAIL-PACKAGE-RUNTIME-CONTRACT: RUNTIME-CONTRACT.json is invalid (FAIL-ASSESSMENT-RUNTIME-CONTRACT: contract is not closed)");
});

test("SEI package rejects a runtime contract whose output schema is stale", () => {
  const { ASSESSMENT_SCHEMA_VERSION } = require(path.join(skillsRoot, "shared", "software-engineering-intelligence", "engineering-assessment.js"));
  const result = checkMutation(({ root }) => editJson(path.join(root, "RUNTIME-CONTRACT.json"), (contract) => {
    contract.output.schema = "sei.engineering-assessment@2";
  }));
  assertRejects(result, `FAIL-PACKAGE-RUNTIME-CONTRACT: output.schema must equal the engine ASSESSMENT_SCHEMA_VERSION ${ASSESSMENT_SCHEMA_VERSION}`);
});

test("SEI package rejects a runtime contract whose version or owner drifts", () => {
  const result = checkMutation(({ root }) => editJson(path.join(root, "RUNTIME-CONTRACT.json"), (contract) => {
    contract.version = "9.9.9";
    contract.owner = "someone-else";
  }));
  assertRejects(result, [
    "FAIL-PACKAGE-RUNTIME-CONTRACT: version must equal MANIFEST.json version",
    "FAIL-PACKAGE-RUNTIME-CONTRACT: owner must be software-engineering-intelligence",
  ]);
});

test("SEI package rejects a skill inventory entry swapped into the wrong category", () => {
  const result = checkMutation(({ root }) => editJson(path.join(root, "MANIFEST.json"), (manifest) => {
    manifest.inventory.references = manifest.inventory.references.filter((entry) => entry !== "references/ria-handoff.md");
    manifest.inventory.assets.push("references/ria-handoff.md");
  }));
  assertRejects(result, "FAIL-PACKAGE-MANIFEST: skill package inventory category assets contains references/ria-handoff.md");
});

test("SEI package rejects an evaluation case without a type or with an empty assertion", () => {
  const result = checkMutation(({ root }) => editJson(path.join(root, "evals", "evals.json"), (evals) => {
    delete evals.cases.find((entry) => entry.id === "negative-health-grade").type;
    evals.cases.find((entry) => entry.id === "negative-integrity-candidate").assertions.push("  ");
  }));
  assertRejects(result, [
    "FAIL-EVAL-COVERAGE: negative-health-grade needs a declared type (discovery|execution|safety|verification)",
    "FAIL-EVAL-COVERAGE: negative-integrity-candidate needs non-empty string assertions",
  ]);
});

test("SEI package accepts a duplicated SKILL.md link and ignores links inside code fences", () => {
  const result = checkMutation(({ root }) => fs.appendFileSync(
    path.join(root, "SKILL.md"),
    "\nSee also [the evidence contract](references/evidence-contract.md).\n\n```md\n[not a link](references/not-real.md)\n```\n",
  ));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});
