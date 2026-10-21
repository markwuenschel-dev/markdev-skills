"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { resolveSeiLayout } = require("./layout.js");

const developmentSkillsRoot = path.resolve(__dirname, "..", "..");
const EXPECTED_SHARED_ENGINE_EXPORTS = Object.freeze([
  "analyzers/tsjs-ast-protocol.DEFAULT_LIMITS",
  "analyzers/tsjs-ast-protocol.HARD_LIMITS",
  "analyzers/tsjs-ast-protocol.SUPPORTED_SYNTAX",
  "analyzers/tsjs-ast-protocol.TSJS_AST_ANALYZER_VERSION",
  "analyzers/tsjs-ast-protocol.TSJS_AST_PROTOCOL_VERSION",
  "analyzers/tsjs-ast-protocol.analyzeTsjsAstBatch",
  "analyzers/tsjs-ast-protocol.decodeTsjsAstResponse",
  "analyzers/tsjs-ast-protocol.encodeTsjsAstRequest",
  "analyzers/tsjs-ast-protocol.probeTsjsAstRuntime",
  "autonomous-evidence.AUTONOMOUS_EVIDENCE_VERSION",
  "autonomous-evidence.discoverEngineeringEvidence",
  "autonomous-evidence.projectEngineeringEvidence",
  "assessment-standards.MARK_ENGINEERING_STANDARD",
  "assessment-standards.MARK_SOURCE_DIGEST",
  "assessment-standards.SEI_DEFAULT_ENGINEERING_STANDARD",
  "assessment-standards.STANDARD_RESOLUTION_VERSION",
  "assessment-standards.resolveAssessmentStandard",
  "calibration.backtestHeuristicHotspots",
  "calibration.backtestHeuristicRisk",
  "calibration.deriveLabelEventDigest",
  "calibration.deriveSnapshotDocumentDigest",
  "capability-coverage.CAPABILITY_COVERAGE_VERSION",
  "capability-coverage.deriveCapabilityCoverage",
  "cli.execute",
  "cli.parseArguments",
  "collectors.collectGitEvidence",
  "collectors.collectGitEvidenceAsync",
  "collectors.collectLocalEvidence",
  "collectors.collectStaticEvidence",
  "collectors.collectStaticEvidenceFromIndex",
  "collectors.deriveCollectorConfigurationHash",
  "collectors.integratePythonStaticIntelligence",
  "collectors.mergeLocalEvidence",
  "complexity-presentation.COMPLEXITY_PRESENTATION_VERSION",
  "complexity-presentation.deriveComplexityPresentation",
  "dependency-intelligence.DEPENDENCY_INTELLIGENCE_VERSION",
  "dependency-intelligence.analyzeDependencyIntelligence",
  "dependency-intelligence.projectDependencyEvidence",
  "dependency-invalidation.DEPENDENCY_INVALIDATION_VERSION",
  "dependency-invalidation.planDependencyInvalidation",
  "engineering-assessment.ASSESSMENT_SCHEMA_VERSION",
  "engineering-assessment.assessRepositoryEngineering",
  "engineering-assessment.validateAssessment",
  "duplication-intelligence.DUPLICATION_ANALYZER_VERSION",
  "duplication-intelligence.analyzeDuplicationIntelligence",
  "duplication-intelligence.projectDuplicationEvidence",
  "evidence-adapters.collectAdapterEvidence",
  "forward-temporal-evaluator.evaluateForwardTemporal",
  "framework-lenses.FRAMEWORK_LENS_IDS",
  "framework-lenses.FRAMEWORK_LENS_VERSION",
  "framework-lenses.buildFrameworkLenses",
  "intelligence-engine.SNAPSHOT_SCHEMA_VERSION",
  "intelligence-engine.STATUS",
  "intelligence-engine.createSnapshot",
  "intelligence-engine.deriveCacheKey",
  "intelligence-engine.deriveRiskModelContractHash",
  "intelligence-engine.deriveSnapshotId",
  "intelligence-engine.materializeSnapshot",
  "intelligence-engine.validateSnapshot",
  "intelligence-verify.main",
  "intelligence-verify.verifyFile",
  "interpretation.compareSnapshots",
  "interpretation.deriveHotspots",
  "interpretation.validateTrendEnvelope",
  "investigation-signals.INVESTIGATION_SIGNAL_VERSION",
  "investigation-signals.deriveInvestigationSignals",
  "investigation-synthesis.INVESTIGATION_SYNTHESIS_VERSION",
  "investigation-synthesis.buildInvestigationSignalRiskModel",
  "jvm-static-intelligence.JAVA_CALLABLE_SPAN_DEFINITION_ID",
  "jvm-static-intelligence.JAVA_CYCLOMATIC_DEFINITION_ID",
  "jvm-static-intelligence.JAVA_IMPORT_DEFINITION_ID",
  "jvm-static-intelligence.JVM_STATIC_INTELLIGENCE_VERSION",
  "jvm-static-intelligence.KOTLIN_UNAVAILABLE_REASON",
  "jvm-static-intelligence.analyzeJvmStaticIntelligence",
  "jvm-static-intelligence.projectJvmEvidence",
  "jvm-static-intelligence.projectUnavailableJvmEvidence",
  "layout.resolveSeiLayout",
  "maturity-scorer.renderMaturityScorecardMarkdown",
  "maturity-scorer.scoreMaturity",
  "maturity-scorer.validateMaturityScorecard",
  "maturity-scorer.withEvidenceArtifactRoot",
  "policy.compilePolicy",
  "policy.validatePolicyProfile",
  "profiles.PROFILE_DIMENSIONS",
  "profiles.PROFILE_VERSION",
  "profiles.deriveProfileContractHash",
  "profiles.evaluateProfiles",
  "predictive-candidate-experiment.PREDICTIVE_CANDIDATE_EXPERIMENT_VERSION",
  "predictive-candidate-experiment.evaluatePredictiveCandidateExperiment",
  "predictive-status.PREDICTIVE_STATUS_VERSION",
  "predictive-status.derivePredictiveStatus",
  "programming-guidelines.PROGRAMMING_GUIDELINES_RULES",
  "programming-guidelines.PROGRAMMING_GUIDELINES_RULE_IDS",
  "programming-guidelines.compileProgrammingGuidelinesProfile",
  "programming-guidelines.evaluateProgrammingGuidelinesProfile",
  "programming-guidelines.validatePolicyProfile",
  "report.renderReport",
  "report.verifyRenderedReport",
  "repository-index.CLASSIFICATION_POLICY_VERSION",
  "repository-index.REPOSITORY_INDEX_VERSION",
  "repository-index.buildRepositoryIndex",
  "schema-validator.validateAgainstSchema",
  "semantic-evidence.SEMANTIC_EVIDENCE_VERSION",
  "semantic-evidence.deriveEvidence",
  "semantic-evidence.interpretEvidence",
  "static-intelligence.PYTHON_AST_ANALYZER_VERSION",
  "static-intelligence.analyzeStaticIntelligence",
  "task-executor.RESOURCE_CLASSES",
  "task-executor.TaskExecutor",
  "temporal-coupling.DEFAULT_MASS_CHANGE_POLICY",
  "temporal-coupling.deriveTemporalCoupling",
  "trend-baseline.AUTOMATIC_BASELINE_MAX_CANDIDATES",
  "trend-baseline.AUTOMATIC_BASELINE_MAX_INVENTORY_BYTES",
  "trend-baseline.AUTOMATIC_BASELINE_MAX_SNAPSHOT_BYTES",
  "trend-baseline.deriveCanonicalRepositoryIdentity",
  "trend-baseline.discoverAutomaticTrendBaseline",
  "trend-status.TREND_STATUS_VERSION",
  "trend-status.deriveTrendStatus",
  "tsjs-intelligence.TSJS_INTELLIGENCE_VERSION",
  "tsjs-intelligence.analyzeTsjsIntelligence",
  "tsjs-intelligence.projectTsjsEvidence",
  "verification-artifacts.buildVerificationArtifactEnvelope",
  "verification-artifacts.discoverRevisionBoundVerificationEvidence",
  "verification-artifacts.discoverRevisionBoundVerificationEvidenceFromIndex",
  "verification-artifacts.parseJUnitXml",
  "verification-artifacts.parseLcov",
].sort());

function real(target) {
  return fs.realpathSync.native(target);
}

function copyPackage(sourceRoot, destinationRoot, relativePath) {
  const source = path.join(sourceRoot, ...relativePath.split("/"));
  const destination = path.join(destinationRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function materializeSkillsRoot(label) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `sei-layout-${label}-`));
  const skillsRoot = path.join(sandbox, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const relativePath of [
    "software-engineering-intelligence",
    "shared/software-engineering-intelligence",
    "shared/capability-registry",
    // The declared dependency closure (software-engineering-intelligence/MANIFEST.json:162-167).
    // report.js:19 and cli.js:61 require out of these, so a sandbox without them cannot load the engine.
    "shared/report-election",
    "shared/report-presentation",
    "shared/assessment-runtime-contract",
    "shared/project-intelligence-workspace",
  ]) {
    copyPackage(developmentSkillsRoot, skillsRoot, relativePath);
  }
  return { sandbox, skillsRoot };
}

function loadLayout(skillsRoot) {
  const modulePath = path.join(skillsRoot, "shared", "software-engineering-intelligence", "layout.js");
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

// Load sandbox modules in a child process. incremental-run-state.js:13 pulls predictive-native-fs.js,
// which dlopens a verified .node image in place at load time (predictive-native-fs.js:87,101); Windows
// LoadLibrary then pins that copy for the life of the process and the fixture cannot be removed.
// This is the pattern predictive-native-fs.test.js:242-287 already uses, and it preserves the assertion.
function moduleExports(modulePath) {
  const result = spawnSync(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(Object.keys(require(process.argv[1])).sort()))",
    modulePath,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${modulePath} must load in a clean process: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function assertLayout(layout, requestedSkillsRoot, requestedSkillRoot) {
  const canonicalRoot = real(requestedSkillsRoot);
  const packageRoot = real(requestedSkillRoot);
  const engineRoot = real(path.join(canonicalRoot, "shared", "software-engineering-intelligence"));
  const taskExecutorPath = path.join(engineRoot, "task-executor.js");
  const repositoryIndexPath = path.join(engineRoot, "repository-index.js");
  const staticIntelligencePath = path.join(engineRoot, "static-intelligence.js");
  const incrementalRunStatePath = path.join(engineRoot, "incremental-run-state.js");
  assert.equal(layout.canonical_root, canonicalRoot);
  assert.equal(layout.package_root, packageRoot);
  assert.equal(layout.shared_engine_root, engineRoot);
  assert.equal(layout.runner_path, path.join(packageRoot, "scripts", "run-sei.js"));
  assert.equal(layout.config_path, path.join(packageRoot, "assets", "canonical-input.json"));
  assert.equal(layout.template_path, path.join(packageRoot, "assets", "report-template.html"));
  assert.equal(layout.maturity_runner_path, path.join(packageRoot, "scripts", "score-sei-maturity.js"));
  assert.equal(layout.maturity_rubric_path, path.join(engineRoot, "maturity-rubric.json"));
  assert.equal(layout.maturity_scorecard_schema_path, path.join(engineRoot, "maturity-scorecard.schema.json"));
  for (const filePath of [layout.runner_path, layout.config_path, layout.template_path, layout.cli_path, layout.maturity_runner_path, layout.maturity_rubric_path, layout.maturity_scorecard_schema_path, taskExecutorPath, repositoryIndexPath, staticIntelligencePath, incrementalRunStatePath]) {
    assert.equal(fs.statSync(filePath).isFile(), true, `${filePath} must resolve to a file`);
  }
  assert.deepEqual(moduleExports(taskExecutorPath), ["RESOURCE_CLASSES", "TaskExecutor"]);
  assert.deepEqual(moduleExports(repositoryIndexPath), [
    "CLASSIFICATION_POLICY_VERSION",
    "REPOSITORY_INDEX_VERSION",
    "buildRepositoryIndex",
  ]);
  assert.deepEqual(moduleExports(staticIntelligencePath), [
    "PYTHON_AST_ANALYZER_VERSION",
    "analyzeStaticIntelligence",
  ]);
  assert.deepEqual(moduleExports(incrementalRunStatePath), ["openIncrementalRun"]);
}

function maturityEvidence() {
  return {
    kind: "sei-maturity-evidence-v1",
    sei_revision: "a".repeat(40),
    observations: [],
    promotion_evidence: {
      report_schema_integrity: false,
      cache_incremental_runs: null,
      merge_heavy_useful: false,
      framework_not_scored_honest: false,
      heterogeneous_repository_count: 0,
      primary_language_ecosystem_count: 0,
      merge_heavy_repository: null,
      large_repository: null,
      predictive_validation: null,
    },
  };
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function runMaturityRunner(skillsRoot, evidencePath, out, extraArguments = []) {
  const runnerPath = path.join(skillsRoot, "software-engineering-intelligence", "scripts", "score-sei-maturity.js");
  return spawnSync(process.execPath, [runnerPath, "--evidence", evidencePath, "--out", out, ...extraArguments], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "SEI Layout Test",
      GIT_AUTHOR_EMAIL: "sei-layout@example.invalid",
      GIT_COMMITTER_NAME: "SEI Layout Test",
      GIT_COMMITTER_EMAIL: "sei-layout@example.invalid",
      GIT_AUTHOR_DATE: "2001-02-03T04:05:06+00:00",
      GIT_COMMITTER_DATE: "2001-02-03T04:05:06+00:00",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createRepositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-layout-repository-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "index.js"), "export function stable() { return 1; }\n");
  git(repo, ["init", "--quiet"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "layout fixture"]);
  return { root, repo, revision: git(repo, ["rev-parse", "HEAD"]) };
}

function verifyWithLayoutEngine(engineRoot, snapshotPath, reportPath) {
  const result = spawnSync(process.execPath, [
    "-e",
    String.raw`
      const fs = require("node:fs");
      const path = require("node:path");
      const [engineRoot, snapshotPath, reportPath] = process.argv.slice(1);
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      const report = fs.readFileSync(reportPath, "utf8");
      const { validateSnapshot } = require(path.join(engineRoot, "intelligence-engine.js"));
      const { verifyRenderedReport } = require(path.join(engineRoot, "report.js"));
      process.stdout.write(JSON.stringify({
        snapshot_ok: validateSnapshot(snapshot).ok,
        report_result: verifyRenderedReport(report, snapshot),
      }));
    `,
    engineRoot,
    snapshotPath,
    reportPath,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${engineRoot} must verify its own artifacts in a clean process: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function runStandaloneRunner({ label, skillsRoot, runnerPath, repo, outputRoot }) {
  assert.equal(fs.statSync(runnerPath).isFile(), true, `${label} runner must be executed at its requested layout path`);
  const output = path.join(outputRoot, label);
  const result = spawnSync(process.execPath, [runnerPath, "--repo", repo, "--out", output, "--evidence-only"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${label} runner failed:\n${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout);
  const snapshot = JSON.parse(fs.readFileSync(receipt.snapshot_path, "utf8"));
  const engineRoot = path.join(real(skillsRoot), "shared", "software-engineering-intelligence");
  // Verified in a clean process for the same reason as moduleExports: report.js transitively loads
  // the native image, which would pin this sandbox and defeat its cleanup.
  const verification = verifyWithLayoutEngine(engineRoot, receipt.snapshot_path, receipt.report_path);
  assert.equal(receipt.snapshot_id, snapshot.snapshot_id, `${label} receipt must bind the emitted snapshot`);
  assert.equal(verification.snapshot_ok, true, `${label} snapshot must satisfy the canonical engine contract`);
  assert.deepEqual(verification.report_result, { ok: true, errors: [] }, `${label} report must bind exactly to the canonical snapshot`);
  assert.equal(path.relative(output, receipt.snapshot_path).startsWith(".."), false, `${label} snapshot must stay under its selected output directory`);
  assert.equal(path.relative(output, receipt.report_path).startsWith(".."), false, `${label} report must stay under its selected output directory`);
  return snapshot.snapshot_id;
}

test("SEI layout resolver uses canonical registry discovery in the development checkout", () => {
  const { resolveSeiLayout } = loadLayout(developmentSkillsRoot);
  const packageRoot = path.join(developmentSkillsRoot, "software-engineering-intelligence");
  assertLayout(resolveSeiLayout({ skillsRoot: developmentSkillsRoot, skillRoot: packageRoot }), developmentSkillsRoot, packageRoot);
});

test("SEI layout resolver supports a materialized canonical live root", () => {
  const fixture = materializeSkillsRoot("canonical");
  try {
    const { resolveSeiLayout } = loadLayout(fixture.skillsRoot);
    const packageRoot = path.join(fixture.skillsRoot, "software-engineering-intelligence");
    assertLayout(resolveSeiLayout({ skillsRoot: fixture.skillsRoot, skillRoot: packageRoot }), fixture.skillsRoot, packageRoot);
  } finally {
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("SEI layout resolver treats .claude/skills and .agents/skills junctions as mirrors", () => {
  const fixture = materializeSkillsRoot("mirrors");
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "sei-layout-host-"));
  const claudeRoot = path.join(host, ".claude", "skills");
  const agentsRoot = path.join(host, ".agents", "skills");
  try {
    fs.mkdirSync(path.dirname(claudeRoot), { recursive: true });
    fs.mkdirSync(path.dirname(agentsRoot), { recursive: true });
    fs.symlinkSync(fixture.skillsRoot, claudeRoot, "junction");
    fs.symlinkSync(fixture.skillsRoot, agentsRoot, "junction");
    const { resolveSeiLayout } = loadLayout(fixture.skillsRoot);
    for (const mirrorRoot of [claudeRoot, agentsRoot]) {
      const skillRoot = path.join(mirrorRoot, "software-engineering-intelligence");
      const layout = resolveSeiLayout({ skillsRoot: mirrorRoot, skillRoot, mirrors: [claudeRoot, agentsRoot] });
      assertLayout(layout, mirrorRoot, skillRoot);
      assert.deepEqual(layout.mirrors.map((mirror) => mirror.status), ["mirror", "mirror"]);
    }
  } finally {
    for (const mirrorRoot of [claudeRoot, agentsRoot]) {
      if (fs.existsSync(mirrorRoot)) fs.unlinkSync(mirrorRoot);
    }
    fs.rmSync(host, { recursive: true, force: true });
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("SEI layout resolver runs from an isolated candidate without a developer-repository root", () => {
  const fixture = materializeSkillsRoot("candidate");
  try {
    const { resolveSeiLayout } = loadLayout(fixture.skillsRoot);
    const packageRoot = path.join(fixture.skillsRoot, "software-engineering-intelligence");
    assertLayout(resolveSeiLayout({ skillsRoot: fixture.skillsRoot, skillRoot: packageRoot }), fixture.skillsRoot, packageRoot);
  } finally {
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("SEI standalone runner materializes the same canonical snapshot and report in every supported layout", () => {
  const repository = createRepositoryFixture();
  const canonical = materializeSkillsRoot("runner-canonical");
  const isolated = materializeSkillsRoot("runner-candidate");
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "sei-layout-runner-host-"));
  const claudeRoot = path.join(host, ".claude", "skills");
  const agentsRoot = path.join(host, ".agents", "skills");
  try {
    fs.mkdirSync(path.dirname(claudeRoot), { recursive: true });
    fs.mkdirSync(path.dirname(agentsRoot), { recursive: true });
    fs.symlinkSync(canonical.skillsRoot, claudeRoot, "junction");
    fs.symlinkSync(canonical.skillsRoot, agentsRoot, "junction");
    const layouts = [
      { label: "development-checkout", skillsRoot: developmentSkillsRoot },
      { label: "canonical-live-root", skillsRoot: canonical.skillsRoot },
      { label: "claude-junction", skillsRoot: claudeRoot },
      { label: "agents-junction", skillsRoot: agentsRoot },
      { label: "isolated-candidate", skillsRoot: isolated.skillsRoot },
    ];
    const snapshots = layouts.map(({ label, skillsRoot }) => runStandaloneRunner({
      label,
      skillsRoot,
      runnerPath: path.join(skillsRoot, "software-engineering-intelligence", "scripts", "run-sei.js"),
      repo: repository.repo,
      outputRoot: repository.root,
    }));
    assert.equal(new Set(snapshots).size, 1, "layout choice must not change canonical snapshot identity");
  } finally {
    for (const mirrorRoot of [claudeRoot, agentsRoot]) {
      if (fs.existsSync(mirrorRoot)) fs.unlinkSync(mirrorRoot);
    }
    fs.rmSync(host, { recursive: true, force: true });
    fs.rmSync(canonical.sandbox, { recursive: true, force: true });
    fs.rmSync(isolated.sandbox, { recursive: true, force: true });
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("SEI registry discovery exposes the complete canonical shared-engine export contract", () => {
  const registry = require(path.join(developmentSkillsRoot, "shared", "capability-registry", "registry.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(developmentSkillsRoot, "shared", "software-engineering-intelligence", "MANIFEST.json"), "utf8"));
  const record = registry.discover(developmentSkillsRoot).packages.find((item) => item.name === "shared/software-engineering-intelligence");
  assert.ok(Array.isArray(manifest.exports), "shared manifest must declare registry-visible exports");
  assert.ok(record, "shared engine must be registry-discoverable");
  assert.deepEqual([...manifest.exports].sort(), EXPECTED_SHARED_ENGINE_EXPORTS, "shared manifest must declare every canonical public export");
  assert.deepEqual(record.exports, EXPECTED_SHARED_ENGINE_EXPORTS, "registry discovery must expose every canonical public export");
});

test("SEI shared inventory keeps CQR oracles and analyzer benchmarks non-public and category-bound", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(developmentSkillsRoot, "shared", "software-engineering-intelligence", "MANIFEST.json"), "utf8"));
  const expected = [
    "benchmarks/python-static-benchmark.js",
    "benchmarks/python-static-benchmark.test.js",
    "benchmarks/incremental-run-benchmark.js",
    "benchmarks/incremental-run-benchmark.test.js",
    "fixtures/cqr-python-static-c8e6137.expected.json",
    "scripts/verify-cqr-incrementality.js",
    "scripts/verify-cqr-incrementality.test.js",
    "scripts/verify-cqr-python-static.js",
    "scripts/verify-cqr-python-static.test.js",
  ];
  assert.deepEqual(manifest.inventory.scripts, ["scripts/verify-cqr-incrementality.js", "scripts/verify-cqr-python-static.js"]);
  assert.ok(manifest.inventory.analyzer_fixtures.includes("fixtures/cqr-python-static-c8e6137.expected.json"));
  assert.ok(manifest.inventory.benchmarks.includes(expected[0]));
  assert.ok(manifest.inventory.tests.includes(expected[1]));
  assert.ok(manifest.inventory.benchmarks.includes(expected[2]));
  assert.ok(manifest.inventory.tests.includes(expected[3]));
  assert.ok(manifest.inventory.tests.includes("scripts/verify-cqr-incrementality.test.js"));
  assert.ok(manifest.inventory.tests.includes("scripts/verify-cqr-python-static.test.js"));
  assert.equal(expected.every((relativePath) => manifest.owned_files.includes(relativePath)), true);
  assert.equal(expected.some((relativePath) => Object.hasOwn(manifest.public_exports, relativePath)), false);
});

test("SEI product maturity runner is deterministic across every supported layout", () => {
  const canonical = materializeSkillsRoot("maturity-canonical");
  const isolated = materializeSkillsRoot("maturity-candidate");
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "sei-layout-maturity-host-"));
  const claudeRoot = path.join(host, ".claude", "skills");
  const agentsRoot = path.join(host, ".agents", "skills");
  const evidencePath = path.join(host, "evidence.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(maturityEvidence(), null, 2)}\n`);
  try {
    fs.mkdirSync(path.dirname(claudeRoot), { recursive: true });
    fs.mkdirSync(path.dirname(agentsRoot), { recursive: true });
    fs.symlinkSync(canonical.skillsRoot, claudeRoot, "junction");
    fs.symlinkSync(canonical.skillsRoot, agentsRoot, "junction");
    const layouts = [developmentSkillsRoot, canonical.skillsRoot, claudeRoot, agentsRoot, isolated.skillsRoot];
    const receipts = layouts.map((skillsRoot, index) => {
      const result = runMaturityRunner(skillsRoot, evidencePath, path.join(host, `out-${index}`));
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.kind, "sei-maturity-scorecard-receipt-v1");
      assert.equal(receipt.promotion_status, "blocked");
      assert.equal(fs.statSync(receipt.json_path).isFile(), true);
      assert.equal(fs.statSync(receipt.markdown_path).isFile(), true);
      assert.equal(sha256(fs.readFileSync(receipt.json_path)), receipt.json_sha256);
      assert.equal(sha256(fs.readFileSync(receipt.markdown_path)), receipt.markdown_sha256);
      return receipt;
    });
    assert.equal(new Set(receipts.map((receipt) => receipt.scorecard_id)).size, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.json_sha256)).size, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.markdown_sha256)).size, 1);
  } finally {
    for (const mirrorRoot of [claudeRoot, agentsRoot]) if (fs.existsSync(mirrorRoot)) fs.unlinkSync(mirrorRoot);
    fs.rmSync(host, { recursive: true, force: true });
    fs.rmSync(canonical.sandbox, { recursive: true, force: true });
    fs.rmSync(isolated.sandbox, { recursive: true, force: true });
  }
});

test("SEI product maturity runner rejects invalid arguments, immutable drift, and required blocked promotion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-maturity-runner-"));
  const evidencePath = path.join(root, "evidence.json");
  const out = path.join(root, "out");
  fs.writeFileSync(evidencePath, `${JSON.stringify(maturityEvidence(), null, 2)}\n`);
  try {
    const invalid = runMaturityRunner(developmentSkillsRoot, evidencePath, out, ["--unknown"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /FAIL-SEI-MATURITY-ARGUMENTS/);

    const first = runMaturityRunner(developmentSkillsRoot, evidencePath, out);
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(first.stdout);
    fs.writeFileSync(receipt.markdown_path, "tampered\n");
    const drifted = runMaturityRunner(developmentSkillsRoot, evidencePath, out);
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /FAIL-SEI-MATURITY-IMMUTABLE/);

    const required = runMaturityRunner(developmentSkillsRoot, evidencePath, path.join(root, "required"), ["--require-promotion"]);
    assert.notEqual(required.status, 0);
    assert.match(required.stderr, /FAIL-SEI-MATURITY-PROMOTION/);
    assert.equal(fs.existsSync(path.join(root, "required", "maturity-scorecards")), true, "blocked scorecard remains published evidence");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
