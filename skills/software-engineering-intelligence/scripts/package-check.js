#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGE_NAME = "software-engineering-intelligence";
const SHARED_PACKAGE_NAME = "shared/software-engineering-intelligence";
const REQUIRED_RUNTIME = "node-builtins-plus-optional-cpython-min-3.13-typescript-compiler-api-jdk-compiler-min-25-stdlib";
const REQUIRED_JAVA_TOOLCHAIN = Object.freeze({
  platform: "win32",
  vendor: "Oracle Corporation",
  runtime_version: "25.0.3+9-LTS-195",
  java_sha256: "173806fbfaf125493d69ecca62ef57a8d975e4cd9f0d489f1496be7be4548941",
  javac_sha256: "98b1e2c19ba021660d6be117040be977e898cb0204d9b01f11f2fa3ec6b03f7c",
});
const ENGINE_RELATIVE_PATH = "../shared/software-engineering-intelligence/cli.js";
const LAYOUT_RELATIVE_PATH = "../shared/software-engineering-intelligence/layout.js";
const ASSESSMENT_RELATIVE_PATH = "../shared/software-engineering-intelligence/engineering-assessment.js";
const RUNTIME_CONTRACT_MODULE_RELATIVE_PATH = "../shared/assessment-runtime-contract/runtime-contract.js";
const RUNTIME_CONTRACT_REQUIRED_INPUTS = Object.freeze(["output_location", "repository"]);
const EVAL_TYPES = Object.freeze(["discovery", "execution", "safety", "verification"]);
const SKILL_INVENTORY_RULES = Object.freeze({
  entrypoint: (entry) => entry === "SKILL.md",
  references: (entry) => /^references\/[^/]+\.md$/.test(entry),
  assets: (entry) => /^assets\/[^/]+$/.test(entry),
  scripts: (entry) => /^scripts\/[^/]+\.js$/.test(entry) && !entry.endsWith(".test.js"),
  internal: (entry) => /^internal\/[^/]+\.js$/.test(entry),
  test_support: (entry) => /^test-support\/[^/]+\.js$/.test(entry),
  tests: (entry) => /^scripts\/[^/]+\.test\.js$/.test(entry),
  evaluation: (entry) => /^evals\/[^/]+\.json$/.test(entry),
  metadata: (entry) => ["MANIFEST.json", "context-policy.json", "openai.yaml", "RUNTIME-CONTRACT.json"].includes(entry),
});
const OPENAI_YAML_EXPECTED = Object.freeze({
  interface: Object.freeze({
    display_name: "Software Engineering Intelligence",
    short_description: "Produce provenance-bound engineering evidence snapshots and reports",
  }),
  policy: Object.freeze({ allow_implicit_invocation: false }),
});
const PROBE_ENV_ALLOWLIST = Object.freeze(["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE"]);
const REQUIRED_REFERENCES = [
  "references/collection-adapters.md",
  "references/comparison-calibration.md",
  "references/evidence-contract.md",
  "references/maturity-scoring.md",
  "references/profile-applicability.md",
  "references/policy-profile.md",
  "references/ria-handoff.md",
];
const REQUIRED_ASSETS = [
  "assets/canonical-input.json",
  "assets/report-template.html",
];
const REQUIRED_SCRIPTS = [
  "scripts/package-check.js",
  "scripts/package-check.test.js",
  "scripts/run-java-lane.js",
  "scripts/run-java-lane.test.js",
  "scripts/score-sei-maturity.js",
  "scripts/run-sei.js",
];
const REQUIRED_INTERNAL = ["internal/java-lane-core.js"];
const REQUIRED_TEST_SUPPORT = ["test-support/java-lane-harness.js"];
const REQUIRED_ORACLE_FILES = [...REQUIRED_SCRIPTS, ...REQUIRED_INTERNAL, ...REQUIRED_TEST_SUPPORT];
const REQUIRED_METADATA = [
  "MANIFEST.json",
  "RUNTIME-CONTRACT.json",
  "context-policy.json",
  "evals/evals.json",
  "openai.yaml",
];
const REQUIRED_FILES = [
  "SKILL.md",
  ...REQUIRED_REFERENCES,
  ...REQUIRED_ASSETS,
  ...REQUIRED_SCRIPTS,
  ...REQUIRED_INTERNAL,
  ...REQUIRED_TEST_SUPPORT,
  ...REQUIRED_METADATA,
].sort();
const REQUIRED_EVALS = Object.freeze({
  "route-explicit-run-sei": { shouldRoute: true, expectedRoute: PACKAGE_NAME },
  "negative-ria-lifecycle": { shouldRoute: false, expectedRoute: "repository-improvement-assessment" },
  "negative-health-grade": { shouldRoute: false, expectedRoute: "repository-health-assessment" },
  "negative-integrity-candidate": { shouldRoute: false, expectedRoute: "codebase-integrity-audit-loop" },
  "negative-architecture-deepening": { shouldRoute: false, expectedRoute: "architecture-improvement-intelligence" },
  "missing-deployment-unavailable": { shouldRoute: true, expectedRoute: PACKAGE_NAME },
  "explicit-baseline-comparison": { shouldRoute: true, expectedRoute: PACKAGE_NAME },
  "automatic-baseline-comparison": { shouldRoute: true, expectedRoute: PACKAGE_NAME },
  "policy-source-drift": { shouldRoute: true, expectedRoute: PACKAGE_NAME },
  "typed-local-adapter-evidence": { shouldRoute: true, expectedRoute: PACKAGE_NAME },
  "context-policy-regression": { shouldRoute: true, expectedRoute: PACKAGE_NAME },
});
const REQUIRED_SHARED_PUBLIC_EXPORTS = Object.freeze({
  "analyzers/tsjs-ast-protocol.js": ["DEFAULT_LIMITS", "HARD_LIMITS", "SUPPORTED_SYNTAX", "TSJS_AST_ANALYZER_VERSION", "TSJS_AST_PROTOCOL_VERSION", "analyzeTsjsAstBatch", "decodeTsjsAstResponse", "encodeTsjsAstRequest", "probeTsjsAstRuntime"],
  "autonomous-evidence.js": ["AUTONOMOUS_EVIDENCE_VERSION", "discoverEngineeringEvidence", "projectEngineeringEvidence"],
  "assessment-standards.js": ["MARK_ENGINEERING_STANDARD", "MARK_SOURCE_DIGEST", "SEI_DEFAULT_ENGINEERING_STANDARD", "STANDARD_RESOLUTION_VERSION", "resolveAssessmentStandard"],
  "calibration.js": ["backtestHeuristicHotspots", "backtestHeuristicRisk", "deriveLabelEventDigest", "deriveSnapshotDocumentDigest"],
  "capability-coverage.js": ["CAPABILITY_COVERAGE_VERSION", "deriveCapabilityCoverage"],
  "cli.js": ["execute", "parseArguments"],
  "collectors.js": ["collectGitEvidence", "collectGitEvidenceAsync", "collectLocalEvidence", "collectStaticEvidence", "collectStaticEvidenceFromIndex", "deriveCollectorConfigurationHash", "integratePythonStaticIntelligence", "mergeLocalEvidence"],
  "complexity-presentation.js": ["COMPLEXITY_PRESENTATION_VERSION", "deriveComplexityPresentation"],
  "dependency-intelligence.js": ["DEPENDENCY_INTELLIGENCE_VERSION", "analyzeDependencyIntelligence", "projectDependencyEvidence"],
  "dependency-invalidation.js": ["DEPENDENCY_INVALIDATION_VERSION", "planDependencyInvalidation"],
  "engineering-assessment.js": ["ASSESSMENT_SCHEMA_VERSION", "assessRepositoryEngineering", "validateAssessment"],
  "duplication-intelligence.js": ["DUPLICATION_ANALYZER_VERSION", "analyzeDuplicationIntelligence", "projectDuplicationEvidence"],
  "evidence-adapters.js": ["collectAdapterEvidence"],
  "forward-temporal-evaluator.js": ["evaluateForwardTemporal"],
  "framework-lenses.js": ["FRAMEWORK_LENS_IDS", "FRAMEWORK_LENS_VERSION", "buildFrameworkLenses"],
  "intelligence-engine.js": ["SNAPSHOT_SCHEMA_VERSION", "STATUS", "createSnapshot", "deriveCacheKey", "deriveRiskModelContractHash", "deriveSnapshotId", "materializeSnapshot", "validateSnapshot"],
  "intelligence-verify.js": ["main", "verifyFile"],
  "interpretation.js": ["compareSnapshots", "deriveHotspots", "validateTrendEnvelope"],
  "investigation-signals.js": ["INVESTIGATION_SIGNAL_VERSION", "deriveInvestigationSignals"],
  "investigation-synthesis.js": ["INVESTIGATION_SYNTHESIS_VERSION", "buildInvestigationSignalRiskModel"],
  "jvm-static-intelligence.js": ["JAVA_CALLABLE_SPAN_DEFINITION_ID", "JAVA_CYCLOMATIC_DEFINITION_ID", "JAVA_IMPORT_DEFINITION_ID", "JVM_STATIC_INTELLIGENCE_VERSION", "KOTLIN_UNAVAILABLE_REASON", "analyzeJvmStaticIntelligence", "projectJvmEvidence", "projectUnavailableJvmEvidence"],
  "layout.js": ["resolveSeiLayout"],
  "maturity-scorer.js": ["renderMaturityScorecardMarkdown", "scoreMaturity", "validateMaturityScorecard", "withEvidenceArtifactRoot"],
  "policy.js": ["compilePolicy", "validatePolicyProfile"],
  "profiles.js": ["PROFILE_DIMENSIONS", "PROFILE_VERSION", "deriveProfileContractHash", "evaluateProfiles"],
  "predictive-candidate-experiment.js": ["PREDICTIVE_CANDIDATE_EXPERIMENT_VERSION", "evaluatePredictiveCandidateExperiment"],
  "predictive-status.js": ["PREDICTIVE_STATUS_VERSION", "derivePredictiveStatus"],
  "programming-guidelines.js": ["PROGRAMMING_GUIDELINES_RULES", "PROGRAMMING_GUIDELINES_RULE_IDS", "compileProgrammingGuidelinesProfile", "evaluateProgrammingGuidelinesProfile", "validatePolicyProfile"],
  "report.js": ["renderReport", "verifyRenderedReport"],
  "repository-index.js": ["CLASSIFICATION_POLICY_VERSION", "REPOSITORY_INDEX_VERSION", "buildRepositoryIndex"],
  "schema-validator.js": ["validateAgainstSchema"],
  "semantic-evidence.js": ["SEMANTIC_EVIDENCE_VERSION", "deriveEvidence", "interpretEvidence"],
  "static-intelligence.js": ["PYTHON_AST_ANALYZER_VERSION", "analyzeStaticIntelligence"],
  "task-executor.js": ["RESOURCE_CLASSES", "TaskExecutor"],
  "temporal-coupling.js": ["DEFAULT_MASS_CHANGE_POLICY", "deriveTemporalCoupling"],
  "trend-baseline.js": [
    "AUTOMATIC_BASELINE_MAX_CANDIDATES",
    "AUTOMATIC_BASELINE_MAX_INVENTORY_BYTES",
    "AUTOMATIC_BASELINE_MAX_SNAPSHOT_BYTES",
    "deriveCanonicalRepositoryIdentity",
    "discoverAutomaticTrendBaseline",
  ],
  "trend-status.js": ["TREND_STATUS_VERSION", "deriveTrendStatus"],
  "tsjs-intelligence.js": ["TSJS_INTELLIGENCE_VERSION", "analyzeTsjsIntelligence", "projectTsjsEvidence"],
  "verification-artifacts.js": ["buildVerificationArtifactEnvelope", "discoverRevisionBoundVerificationEvidence", "discoverRevisionBoundVerificationEvidenceFromIndex", "parseJUnitXml", "parseLcov"],
});
const REQUIRED_SHARED_INTERNAL_MODULES = Object.freeze({
  "analyzers/subprocess-supervisor.js": ["activeOwnedProcessCount", "runOwnedSubprocess"],
  "incremental-run-state.js": ["openIncrementalRun"],
  "runtime-capabilities.js": ["assessJavaCapability", "assessPythonCapability"],
});
const REQUIRED_SHARED_ORACLE_INVENTORY = Object.freeze({
  analyzer_fixtures: ["fixtures/cqr-python-static-c8e6137.expected.json"],
  benchmarks: ["benchmarks/incremental-run-benchmark.js", "benchmarks/python-static-benchmark.js"],
  scripts: ["scripts/verify-cqr-incrementality.js", "scripts/verify-cqr-python-static.js"],
  tests: [
    "benchmarks/incremental-run-benchmark.test.js",
    "benchmarks/python-static-benchmark.test.js",
    "scripts/verify-cqr-incrementality.test.js",
    "scripts/verify-cqr-python-static.test.js",
  ],
});

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

function sameSorted(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function addError(errors, code, detail) {
  errors.push(`${code}: ${detail}`);
}

function inspectModule(modulePath, valueName = null) {
  const script = [
    'const value = require(process.argv[1]);',
    'const types = Object.fromEntries(Object.keys(value).map((key) => [key, typeof value[key]]));',
    'const picked = process.argv[2] ? { value: value[process.argv[2]] } : {};',
    'process.stdout.write(JSON.stringify({ exports: Object.keys(value), types, ...picked }));',
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script, modulePath, ...(valueName === null ? [] : [valueName])], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || result.stdout || `module inspector exited ${result.status}`).trim() };
  }
  try {
    return { ok: true, ...JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `module inspector returned malformed JSON (${error.message})` };
  }
}

function safePackagePath(packageRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) return null;
  const normalized = toPosix(relativePath);
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return null;
  }
  const resolved = path.resolve(packageRoot, normalized);
  const rootWithSeparator = `${path.resolve(packageRoot)}${path.sep}`;
  return resolved === path.resolve(packageRoot) || resolved.startsWith(rootWithSeparator) ? resolved : null;
}

function readText(filePath, errors, code) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    addError(errors, code, `${toPosix(filePath)} (${error.message})`);
    return null;
  }
}

function readJson(filePath, errors, label) {
  const text = readText(filePath, errors, "FAIL-PACKAGE-FILE");
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    addError(errors, "FAIL-PACKAGE-JSON", `${label} is invalid JSON (${error.message})`);
    return null;
  }
}

class PackageLinkError extends Error {
  constructor(relativePath) {
    super(`link or junction is not allowed: ${relativePath}`);
    this.relativePath = relativePath;
  }
}

function realPathOrNull(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

// Containment is decided on real paths: a lexically-contained path that resolves
// through a link or junction to somewhere outside the root is not contained.
function realContained(root, target) {
  const realRoot = realPathOrNull(root);
  const realTarget = realPathOrNull(target);
  if (realRoot === null || realTarget === null) return null;
  const key = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const rootKey = key(realRoot);
  const targetKey = key(realTarget);
  const prefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`;
  if (targetKey !== rootKey && !targetKey.startsWith(prefix)) return null;
  return fs.statSync(realTarget, { throwIfNoEntry: false }) ?? null;
}

function containedFile(root, target) {
  return realContained(root, target)?.isFile() === true;
}

function listFiles(root) {
  const output = [];
  const walk = (current, relative) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const nextPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new PackageLinkError(toPosix(nextRelative));
      if (entry.isDirectory()) walk(nextPath, nextRelative);
      else if (entry.isFile()) output.push(toPosix(nextRelative));
    }
  };
  walk(root, "");
  return output.sort();
}

function countFiles(root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return 0;
  try {
    return listFiles(root).length;
  } catch (error) {
    if (error instanceof PackageLinkError) return 0;
    throw error;
  }
}

function flattenedInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return null;
  const files = [];
  for (const entries of Object.values(inventory)) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || entry.length === 0)) return null;
    files.push(...entries);
  }
  return files;
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function checkCompleteInventory(root, manifest, label, errors, categoryRules = null) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
  let actual;
  try {
    actual = listFiles(root);
  } catch (error) {
    if (!(error instanceof PackageLinkError)) throw error;
    addError(errors, "FAIL-PACKAGE-LINK", `${label} contains a link or junction: ${error.relativePath}`);
    return;
  }
  const owned = manifest.owned_files;
  const inventory = flattenedInventory(manifest.inventory);
  if (!Array.isArray(owned) || owned.some((entry) => typeof entry !== "string" || entry.length === 0) || hasDuplicates(owned)) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", `${label} owned_files must be a unique string inventory`);
  } else if (!sameSorted(owned, actual)) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", `${label} owned_files must exactly inventory every package file`);
  }
  if (inventory === null || hasDuplicates(inventory)) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", `${label} inventory categories must contain unique file paths`);
  } else if (!sameSorted(inventory, actual)) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", `${label} inventory categories must exactly cover every package file`);
  }
  if (categoryRules !== null && inventory !== null) {
    if (!sameSorted(Object.keys(manifest.inventory), Object.keys(categoryRules))) {
      addError(errors, "FAIL-PACKAGE-MANIFEST", `${label} inventory must declare exactly the categories ${Object.keys(categoryRules).sort().join(", ")}`);
    }
    for (const [category, entries] of Object.entries(manifest.inventory)) {
      const rule = categoryRules[category];
      if (!rule) continue;
      for (const entry of entries) {
        if (!rule(entry)) addError(errors, "FAIL-PACKAGE-MANIFEST", `${label} inventory category ${category} contains ${entry}`);
      }
    }
  }
}

function canonicalRegistryExports(publicExports) {
  if (!publicExports || typeof publicExports !== "object" || Array.isArray(publicExports)) return null;
  const exports = [];
  for (const [moduleName, names] of Object.entries(publicExports)) {
    if (!moduleName.endsWith(".js") || !Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0)) {
      return null;
    }
    const moduleId = moduleName.slice(0, -".js".length);
    for (const name of names) exports.push(`${moduleId}.${name}`);
  }
  return exports;
}

function checkBaselineIntegration(manifest, errors) {
  const boundary = manifest.baseline_integration;
  const expectedFields = ["forbidden_outputs", "m1_outputs", "owner", "reference_contract", "status"];
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary) || !sameSorted(Object.keys(boundary), expectedFields)) {
    addError(errors, "FAIL-PACKAGE-BOUNDARY", "baseline integration boundary must be a closed M1 metadata record");
    return;
  }
  if (
    boundary.status !== "integrated-additive-assessment-ref-v1" ||
    boundary.owner !== "repository-improvement-assessment" ||
    boundary.reference_contract !== "additive-sei-assessment-ref-v1"
  ) {
    addError(errors, "FAIL-PACKAGE-BOUNDARY", "baseline integration boundary must declare the additive verified SEI assessment reference contract");
  }
  if (!Array.isArray(boundary.m1_outputs) || !sameSorted(boundary.m1_outputs, ["engineering-assessment-sidecar", "offline-report", "standalone-snapshot"])) {
    addError(errors, "FAIL-PACKAGE-BOUNDARY", "baseline integration may expose only standalone evidence and SEI assessment artifacts");
  }
  if (!Array.isArray(boundary.forbidden_outputs) || !sameSorted(boundary.forbidden_outputs, [
    "assessment_refs",
    "baseline_ref",
    "candidate",
    "engineering_intelligence_ref",
    "health_grade",
    "lifecycle_state",
    "verification_verdict",
  ])) {
    addError(errors, "FAIL-PACKAGE-BOUNDARY", "M1 baseline integration must reject assessment, lifecycle, and verification output aliases");
  }
}

function parseFrontmatter(skillText, errors) {
  const match = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    addError(errors, "FAIL-PACKAGE-FRONTMATTER", "SKILL.md must begin with YAML frontmatter");
    return {};
  }
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field) result[field[1]] = field[2];
  }
  return result;
}

function stripFencedCode(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence === null) {
      if (marker !== null) fence = marker;
      else kept.push(line);
    } else if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
    }
  }
  return kept.join("\n");
}

function markdownTargets(text) {
  const targets = new Set();
  const expression = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of stripFencedCode(text).matchAll(expression)) {
    const rawTarget = match[1].trim();
    if (rawTarget.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
    targets.add(rawTarget.split(/\s+/)[0].split("#")[0]);
  }
  return [...targets];
}

function checkDeclaredFiles(packageRoot, errors) {
  for (const relativePath of REQUIRED_FILES) {
    const resolved = safePackagePath(packageRoot, relativePath);
    if (!resolved || !containedFile(packageRoot, resolved)) {
      addError(errors, "FAIL-PACKAGE-FILE", `required file missing: ${relativePath}`);
    }
  }
}

function checkSkill(packageRoot, errors) {
  const skillPath = path.join(packageRoot, "SKILL.md");
  const skillText = readText(skillPath, errors, "FAIL-PACKAGE-FILE");
  if (skillText === null) return null;

  const frontmatter = parseFrontmatter(skillText, errors);
  if (frontmatter.name !== PACKAGE_NAME) {
    addError(errors, "FAIL-PACKAGE-FRONTMATTER", `name must be ${PACKAGE_NAME}`);
  }
  if (frontmatter["disable-model-invocation"] !== "false") {
    addError(errors, "FAIL-PACKAGE-FRONTMATTER", "skill must remain model-invocable for explicit SEI requests");
  }
  if (!frontmatter.description?.includes("explicitly asks") || !frontmatter.description.includes("Software Engineering Intelligence")) {
    addError(errors, "FAIL-PACKAGE-ROUTING", "description must state the explicit SEI activation boundary");
  }
  if (skillText.split(/\r?\n/).length > 500) {
    addError(errors, "FAIL-CONTEXT-REGRESSION", "SKILL.md exceeds the 500-line core-context ceiling");
  }

  const requiredBoundaryTerms = [
    "Inspect the selected repository",
    "Use existing trustworthy tools only",
    "unavailable",
    "health-grade",
    "candidate score",
    "completion verdict",
    "caller-selected",
    "exact match",
  ];
  for (const term of requiredBoundaryTerms) {
    if (!skillText.includes(term)) {
      addError(errors, "FAIL-PACKAGE-BOUNDARY", `SKILL.md is missing required contract text: ${term}`);
    }
  }
  if (skillText.includes("node skills/software-engineering-intelligence/")) {
    addError(errors, "FAIL-PACKAGE-LAYOUT", "SKILL.md must not require a developer-repository-root invocation");
  }
  if (!skillText.includes("<installed-software-engineering-intelligence-dir>/scripts/run-sei.js")) {
    addError(errors, "FAIL-PACKAGE-LAYOUT", "SKILL.md must document the installed-package runner path");
  }

  const links = markdownTargets(skillText);
  const expectedLinks = [...REQUIRED_REFERENCES, "scripts/run-sei.js"];
  if (!sameSorted(links, expectedLinks)) {
    addError(errors, "FAIL-PACKAGE-REFERENCES", "SKILL.md links must exactly match conditional references and bundled runner");
  }
  for (const target of links) {
    const resolved = safePackagePath(packageRoot, target);
    if (!resolved || !containedFile(packageRoot, resolved)) {
      addError(errors, "FAIL-PACKAGE-REFERENCES", `SKILL.md link is missing or escapes package: ${target}`);
    }
  }
  return skillText;
}

function checkOpenAiYaml(packageRoot, errors) {
  const text = readText(path.join(packageRoot, "openai.yaml"), errors, "FAIL-PACKAGE-FILE");
  if (text === null) return;
  const parsed = parseTwoLevelYaml(text);
  if (parsed === null) {
    addError(errors, "FAIL-PACKAGE-METADATA", "openai.yaml is not the closed two-level mapping shape");
    return;
  }
  if (!sameSorted(Object.keys(parsed), Object.keys(OPENAI_YAML_EXPECTED))) {
    addError(errors, "FAIL-PACKAGE-METADATA", "openai.yaml must declare exactly interface and policy");
  }
  for (const [section, expectedFields] of Object.entries(OPENAI_YAML_EXPECTED)) {
    const actual = parsed[section];
    if (!actual || !sameSorted(Object.keys(actual), Object.keys(expectedFields))) {
      addError(errors, "FAIL-PACKAGE-METADATA", `openai.yaml ${section} must declare exactly ${Object.keys(expectedFields).sort().join(", ")}`);
      continue;
    }
    for (const [field, expected] of Object.entries(expectedFields)) {
      if (actual[field] !== expected) {
        addError(errors, "FAIL-PACKAGE-METADATA", `openai.yaml ${section}.${field} must be ${JSON.stringify(expected)}`);
      }
    }
  }
}

function stripYamlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return quote === null ? line : null;
}

function parseYamlScalar(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (/^'(?:[^']|'')*'$/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  return undefined;
}

// Deliberately tiny closed parser (no YAML library ships in this tree): two
// mapping levels, two-space child indent, scalar values only. Comments are
// stripped before matching, so a comment can never satisfy a field. Any other
// shape returns null rather than being guessed.
function parseTwoLevelYaml(text) {
  const result = {};
  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = stripYamlComment(rawLine);
    if (stripped === null || stripped.includes("\t")) return null;
    const line = stripped.replace(/\s+$/, "");
    if (line.trim().length === 0) continue;
    const top = /^([A-Za-z_][A-Za-z0-9_]*):$/.exec(line);
    if (top) {
      if (Object.hasOwn(result, top[1])) return null;
      section = top[1];
      result[section] = {};
      continue;
    }
    const child = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s+(\S.*)$/.exec(line);
    if (!child || section === null || Object.hasOwn(result[section], child[1])) return null;
    const value = parseYamlScalar(child[2]);
    if (value === undefined) return null;
    result[section][child[1]] = value;
  }
  return result;
}

function checkRuntimeContract(packageRoot, manifest, errors) {
  const contractPath = path.join(packageRoot, "RUNTIME-CONTRACT.json");
  const modulePath = path.resolve(packageRoot, RUNTIME_CONTRACT_MODULE_RELATIVE_PATH);
  if (!containedFile(path.resolve(packageRoot, ".."), modulePath)) {
    addError(errors, "FAIL-PACKAGE-RUNTIME-CONTRACT", `runtime contract validator is missing: ${RUNTIME_CONTRACT_MODULE_RELATIVE_PATH}`);
    return;
  }
  let contract;
  try {
    contract = require(modulePath).read(contractPath).contract;
  } catch (error) {
    addError(errors, "FAIL-PACKAGE-RUNTIME-CONTRACT", `RUNTIME-CONTRACT.json is invalid (${error.message})`);
    return;
  }
  if (contract.owner !== PACKAGE_NAME) addError(errors, "FAIL-PACKAGE-RUNTIME-CONTRACT", `owner must be ${PACKAGE_NAME}`);
  if (contract.version !== manifest?.version) addError(errors, "FAIL-PACKAGE-RUNTIME-CONTRACT", "version must equal MANIFEST.json version");
  if (!sameSorted(contract.input.required, RUNTIME_CONTRACT_REQUIRED_INPUTS) || hasDuplicates(contract.input.required)) {
    addError(errors, "FAIL-PACKAGE-RUNTIME-CONTRACT", `input.required must be exactly ${RUNTIME_CONTRACT_REQUIRED_INPUTS.join(", ")}`);
  }
  const assessmentPath = path.resolve(packageRoot, ASSESSMENT_RELATIVE_PATH);
  const inspected = containedFile(path.resolve(packageRoot, ".."), assessmentPath)
    ? inspectModule(assessmentPath, "ASSESSMENT_SCHEMA_VERSION")
    : { ok: false, error: "engineering-assessment.js is missing" };
  if (!inspected.ok || typeof inspected.value !== "string") {
    addError(errors, "FAIL-PACKAGE-RUNTIME-CONTRACT", `engine assessment schema version is unavailable (${inspected.error ?? "not a string"})`);
  } else if (contract.output.schema !== inspected.value) {
    addError(errors, "FAIL-PACKAGE-RUNTIME-CONTRACT", `output.schema must equal the engine ASSESSMENT_SCHEMA_VERSION ${inspected.value}`);
  }
}

function checkManifest(packageRoot, manifest, errors) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
  if (manifest.name !== PACKAGE_NAME) addError(errors, "FAIL-PACKAGE-MANIFEST", `name must be ${PACKAGE_NAME}`);
  if (manifest.version !== "1.3.0") addError(errors, "FAIL-PACKAGE-MANIFEST", "version must be 1.3.0");
  if (manifest.entrypoint !== "SKILL.md") addError(errors, "FAIL-PACKAGE-MANIFEST", "entrypoint must be SKILL.md");
  if (manifest.runtime !== REQUIRED_RUNTIME) addError(errors, "FAIL-PACKAGE-MANIFEST", `runtime must be ${REQUIRED_RUNTIME}`);
  if (JSON.stringify(manifest.java_lanes) !== JSON.stringify({ portable: "always", hermetic_jdk25: "conditional-unavailable-below-25" })) addError(errors, "FAIL-PACKAGE-MANIFEST", "Java portable/hermetic lanes are not declared");
  if (JSON.stringify(manifest.java_toolchain) !== JSON.stringify(REQUIRED_JAVA_TOOLCHAIN)) addError(errors, "FAIL-PACKAGE-MANIFEST", "Java hermetic lane toolchain identity is not pinned");
  if (manifest.context_policy !== "context-policy.json") addError(errors, "FAIL-PACKAGE-MANIFEST", "context policy is missing");
  checkCompleteInventory(packageRoot, manifest, "skill package", errors, SKILL_INVENTORY_RULES);
  if (!sameSorted(manifest.references ?? [], REQUIRED_REFERENCES)) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", "manifest references must cover the seven conditional contracts");
  }
  if (!sameSorted(manifest.assets ?? [], REQUIRED_ASSETS)) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", "manifest assets must cover runner inputs and report template");
  }
  if (!sameSorted(manifest.scripts ?? [], REQUIRED_SCRIPTS)) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", "manifest scripts must cover runner and deterministic package checks");
  }
  if (manifest.evals !== "evals/evals.json") addError(errors, "FAIL-PACKAGE-MANIFEST", "evals must resolve to evals/evals.json");

  const engine = manifest.shared_engine;
  if (
    engine?.path !== ENGINE_RELATIVE_PATH ||
    engine?.layout_module !== LAYOUT_RELATIVE_PATH ||
    engine?.context_classification !== "model-opaque"
  ) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", "shared engine must be the declared model-opaque CLI boundary");
  }
  if (!sameSorted(engine?.required_exports ?? [], ["execute", "parseArguments"])) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", "shared engine must require its complete CLI public exports");
  }
  if (
    engine?.resolver_capability !== "shared/capability-registry" ||
    !sameSorted(engine?.resolver_exports ?? [], ["canonicalRoot", "discover", "resolveInstallation"])
  ) {
    addError(errors, "FAIL-PACKAGE-MANIFEST", "shared engine must declare its read-only canonical layout resolver dependency");
  }
  if (!["evidence-producer", "evidence-producer-and-assessment"].includes(manifest.authority?.class)) {
    addError(errors, "FAIL-PACKAGE-BOUNDARY", "manifest authority must remain an evidence producer or evidence-backed assessor");
  }
  checkBaselineIntegration(manifest, errors);
  const handoff = readText(path.join(packageRoot, "references", "ria-handoff.md"), errors, "FAIL-PACKAGE-FILE");
  if (
    handoff !== null &&
    (!handoff.includes("does **not** define or emit") ||
      !handoff.includes("optional, verified `sei_assessment_ref`") ||
      !handoff.includes("exactly three existing assessment owners"))
  ) {
    addError(errors, "FAIL-PACKAGE-BOUNDARY", "RIA handoff reference must state the additive verified SEI assessment reference and preserved owner boundary");
  }
  if (
    manifest.permission_boundary?.source_repository_mutation !== false ||
    manifest.permission_boundary?.network !== false ||
    manifest.permission_boundary?.dependency_installation !== false ||
    typeof manifest.permission_boundary?.artifact_writes !== "string"
  ) {
    addError(errors, "FAIL-PACKAGE-BOUNDARY", "manifest permission boundary must remain read-only except caller-selected artifacts");
  }
  const nonGoals = manifest.non_goals ?? [];
  for (const required of ["repository health grading", "candidate scoring or ranking", "lifecycle ownership", "completion verdicts"]) {
    if (!nonGoals.includes(required)) addError(errors, "FAIL-PACKAGE-BOUNDARY", `manifest non-goal missing: ${required}`);
  }
}

function checkContextPolicy(packageRoot, policy, errors) {
  const empty = {
    default_model_context: [],
    conditional_model_context: [],
    model_opaque_paths: [],
    metadata_paths: REQUIRED_METADATA,
  };
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return empty;
  const allowedFields = new Set(["schema_version", "core", "conditional", "oracle", "fixtures", "historical"]);
  for (const field of Object.keys(policy)) {
    if (!allowedFields.has(field)) addError(errors, "FAIL-CONTEXT-REGRESSION", `context policy has unsupported field: ${field}`);
  }
  if (policy.schema_version !== 2) {
    addError(errors, "FAIL-CONTEXT-REGRESSION", "context policy must use the direct-invocation schema_version 2 contract");
  }
  const core = Array.isArray(policy.core) ? policy.core : [];
  const conditional = policy.conditional && typeof policy.conditional === "object" && !Array.isArray(policy.conditional)
    ? policy.conditional
    : {};
  const conditionalEntries = Object.entries(conditional);
  const conditionalPaths = conditionalEntries.flatMap(([, entry]) => Array.isArray(entry?.refs) ? entry.refs : []);
  const oracleSources = policy.oracle?.sources && typeof policy.oracle.sources === "object" && !Array.isArray(policy.oracle.sources)
    ? Object.values(policy.oracle.sources)
    : [];
  const oracleEntrypoints = oracleSources.map((entry) => entry?.path).filter((entry) => typeof entry === "string");

  if (!sameSorted(core, ["SKILL.md"])) {
    addError(errors, "FAIL-CONTEXT-REGRESSION", "SKILL.md must be the only default model-context file");
  }
  if (!sameSorted(conditionalPaths, REQUIRED_REFERENCES)) {
    addError(errors, "FAIL-CONTEXT-REGRESSION", "conditional references must exactly match the seven declared contracts");
  }
  for (const [name, entry] of conditionalEntries) {
    if (!entry || !Array.isArray(entry.condition_ids)
        || entry.condition_ids.some((value) => typeof value !== "string" || !value.startsWith("context.software-engineering-intelligence."))
        || entry.condition_ids.length === 0) {
      addError(errors, "FAIL-CONTEXT-REGRESSION", `conditional branch ${name} needs stable condition IDs`);
    }
    if (!entry || !Array.isArray(entry.refs) || entry.refs.length === 0) {
      addError(errors, "FAIL-CONTEXT-REGRESSION", `conditional branch ${name} needs references`);
    }
  }
  if (!sameSorted(oracleEntrypoints, REQUIRED_ORACLE_FILES)) {
    addError(errors, "FAIL-CONTEXT-REGRESSION", "runner and package-test entrypoints must stay opaque to default model context");
  }
  if (policy.oracle?.default_model_read !== false
      || policy.oracle?.retrieval !== "section"
      || oracleSources.some((entry) => !entry || typeof entry.selector !== "string" || entry.selector.length === 0)) {
    addError(errors, "FAIL-CONTEXT-REGRESSION", "oracle source must remain outside default model context");
  }
  if (policy.fixtures?.default_model_read !== false || policy.historical?.default_model_read !== false) {
    addError(errors, "FAIL-CONTEXT-REGRESSION", "fixtures and historical artifacts must remain outside default model context");
  }

  const classified = new Map();
  const classify = (kind, relativePath) => {
    const resolved = safePackagePath(packageRoot, relativePath);
    if (!resolved || !containedFile(packageRoot, resolved)) {
      addError(errors, "FAIL-CONTEXT-REGRESSION", `classified path is missing or unsafe: ${relativePath}`);
      return;
    }
    const normalized = toPosix(relativePath);
    if (classified.has(normalized)) {
      addError(errors, "FAIL-CONTEXT-REGRESSION", `${normalized} is classified as both ${classified.get(normalized)} and ${kind}`);
      return;
    }
    classified.set(normalized, kind);
  };
  for (const entry of core) classify("core", entry);
  for (const entry of conditionalPaths) classify("conditional", entry);
  for (const entry of oracleEntrypoints) classify("oracle", entry);

  return {
    default_model_context: core,
    conditional_model_context: conditionalEntries.map(([name, entry]) => ({
      name,
      path: entry?.refs?.[0],
      when: Array.isArray(entry?.condition_ids) ? entry.condition_ids.join("; ") : "",
    })),
    model_opaque_paths: oracleEntrypoints,
    metadata_paths: REQUIRED_METADATA,
  };
}

function checkEvaluations(evals, errors) {
  if (!evals || typeof evals !== "object" || Array.isArray(evals)) return;
  if (evals.skill !== PACKAGE_NAME) addError(errors, "FAIL-EVAL-COVERAGE", `eval skill must be ${PACKAGE_NAME}`);
  if (!Array.isArray(evals.cases)) {
    addError(errors, "FAIL-EVAL-COVERAGE", "eval cases must be an array");
    return;
  }
  const byId = new Map();
  for (const entry of evals.cases) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0 || byId.has(entry.id)) {
      addError(errors, "FAIL-EVAL-COVERAGE", "eval IDs must be present and unique");
      continue;
    }
    byId.set(entry.id, entry);
    if (!EVAL_TYPES.includes(entry.type)) {
      addError(errors, "FAIL-EVAL-COVERAGE", `${entry.id} needs a declared type (${EVAL_TYPES.join("|")})`);
    }
    if (
      !Array.isArray(entry.assertions) ||
      entry.assertions.length === 0 ||
      entry.assertions.some((assertion) => typeof assertion !== "string" || assertion.trim().length === 0)
    ) {
      addError(errors, "FAIL-EVAL-COVERAGE", `${entry.id} needs non-empty string assertions`);
    }
  }
  for (const [id, expected] of Object.entries(REQUIRED_EVALS)) {
    const entry = byId.get(id);
    if (!entry) {
      addError(errors, "FAIL-EVAL-COVERAGE", `required evaluation missing: ${id}`);
      continue;
    }
    if (entry.should_route !== expected.shouldRoute || entry.expected_route !== expected.expectedRoute) {
      addError(errors, "FAIL-EVAL-COVERAGE", `${id} has incorrect routing expectation`);
    }
  }
  const explicit = byId.get("route-explicit-run-sei");
  if (!explicit?.prompt?.includes("Run Software Engineering Intelligence")) {
    addError(errors, "FAIL-EVAL-COVERAGE", "positive evaluation must cover the explicit direct request");
  }
}

function checkSharedManifest(engineRoot, manifest, errors) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
  if (manifest.name !== SHARED_PACKAGE_NAME) {
    addError(errors, "FAIL-SHARED-MANIFEST", `name must be ${SHARED_PACKAGE_NAME}`);
  }
  if (manifest.version !== "1.3.0" || manifest.entrypoint !== "cli.js" || manifest.runtime !== REQUIRED_RUNTIME) {
    addError(errors, "FAIL-SHARED-MANIFEST", "shared engine identity, entrypoint, and runtime are incomplete");
  }
  if (JSON.stringify(manifest.java_lanes) !== JSON.stringify({ portable: "always", hermetic_jdk25: "conditional-unavailable-below-25" })) addError(errors, "FAIL-SHARED-MANIFEST", "shared Java portable/hermetic lanes are not declared");
  if (JSON.stringify(manifest.java_toolchain) !== JSON.stringify(REQUIRED_JAVA_TOOLCHAIN)) addError(errors, "FAIL-SHARED-MANIFEST", "shared Java hermetic lane toolchain identity is not pinned");
  checkCompleteInventory(engineRoot, manifest, "shared engine", errors);
  for (const [category, requiredFiles] of Object.entries(REQUIRED_SHARED_ORACLE_INVENTORY)) {
    const declared = manifest.inventory?.[category];
    if (!Array.isArray(declared) || requiredFiles.some((relativePath) => !declared.includes(relativePath))) {
      addError(errors, "FAIL-SHARED-MANIFEST", `shared engine ${category} must declare every CQR Python oracle/benchmark file`);
    }
  }
  const publicExports = manifest.public_exports;
  if (!publicExports || typeof publicExports !== "object" || Array.isArray(publicExports)) {
    addError(errors, "FAIL-SHARED-MANIFEST", "shared engine must declare public_exports by module");
  } else {
    if (!sameSorted(Object.keys(publicExports), Object.keys(REQUIRED_SHARED_PUBLIC_EXPORTS))) {
      addError(errors, "FAIL-SHARED-MANIFEST", "shared engine must declare every required public module exactly once");
    }
    for (const [moduleName, expectedExports] of Object.entries(publicExports)) {
      if (!Array.isArray(expectedExports) || expectedExports.some((entry) => typeof entry !== "string") || hasDuplicates(expectedExports)) {
        addError(errors, "FAIL-SHARED-MANIFEST", `${moduleName} public exports must be a unique string list`);
        continue;
      }
      const modulePath = path.join(engineRoot, moduleName);
      if (!containedFile(engineRoot, modulePath)) {
        addError(errors, "FAIL-SHARED-MANIFEST", `declared public module is missing: ${moduleName}`);
        continue;
      }
      try {
        const inspected = moduleName === "cli.js" ? inspectModule(modulePath) : { ok: true, exports: Object.keys(require(modulePath)) };
        if (!inspected.ok) throw new Error(inspected.error);
        const actualExports = inspected.exports;
        if (!sameSorted(actualExports, expectedExports)) {
          addError(errors, "FAIL-SHARED-MANIFEST", `${moduleName} exports do not match the declared public interface`);
        }
      } catch (error) {
        addError(errors, "FAIL-SHARED-MANIFEST", `${moduleName} cannot be loaded (${error.message})`);
      }
    }
    for (const [moduleName, requiredExports] of Object.entries(REQUIRED_SHARED_PUBLIC_EXPORTS)) {
      if (!sameSorted(publicExports[moduleName] ?? [], requiredExports)) {
        addError(errors, "FAIL-SHARED-MANIFEST", `${moduleName} must declare its complete required public exports`);
      }
    }
  }
  for (const [moduleName, expectedExports] of Object.entries(REQUIRED_SHARED_INTERNAL_MODULES)) {
    if (!manifest.inventory?.modules?.includes(moduleName) || publicExports?.[moduleName] !== undefined) {
      addError(errors, "FAIL-SHARED-MANIFEST", `${moduleName} must be inventoried as a package-private module`);
      continue;
    }
    const modulePath = path.join(engineRoot, moduleName);
    try {
      const inspected = inspectModule(modulePath);
      if (!inspected.ok) throw new Error(inspected.error);
      if (!sameSorted(inspected.exports, expectedExports)) {
        addError(errors, "FAIL-SHARED-MANIFEST", `${moduleName} internal exports do not match the required private seam`);
      }
    } catch (error) {
      addError(errors, "FAIL-SHARED-MANIFEST", `${moduleName} cannot be loaded (${error.message})`);
    }
  }
  const canonicalExports = canonicalRegistryExports(REQUIRED_SHARED_PUBLIC_EXPORTS);
  if (canonicalExports === null || !Array.isArray(manifest.exports) || manifest.exports.some((entry) => typeof entry !== "string" || entry.length === 0) || hasDuplicates(manifest.exports)) {
    addError(errors, "FAIL-SHARED-MANIFEST", "shared engine must declare a unique canonical registry exports list");
  } else if (!sameSorted(manifest.exports, canonicalExports)) {
    addError(errors, "FAIL-SHARED-MANIFEST", "shared engine registry exports must exactly match every declared module public export");
  }
  const resolver = manifest.consumes?.find((entry) => entry?.capability === "shared/capability-registry");
  if (!resolver || resolver.module !== "registry.js" || !sameSorted(resolver.required_exports ?? [], ["canonicalRoot", "discover", "resolveInstallation"])) {
    addError(errors, "FAIL-SHARED-MANIFEST", "shared engine must declare its read-only capability-registry dependency");
  }
  if (!["evidence-producer", "evidence-producer-and-assessment"].includes(manifest.authority?.class)) {
    addError(errors, "FAIL-SHARED-MANIFEST", "shared engine authority must remain evidence-producer or evidence-producer-and-assessment");
  }
}

function checkSharedEngine(packageRoot, errors) {
  const enginePath = path.resolve(packageRoot, ENGINE_RELATIVE_PATH);
  if (!containedFile(path.resolve(packageRoot, ".."), enginePath)) {
    addError(errors, "FAIL-SHARED-ENGINE", `engine is missing: ${ENGINE_RELATIVE_PATH}`);
    return;
  }
  const engineRoot = path.dirname(enginePath);
  const layoutPath = path.resolve(packageRoot, LAYOUT_RELATIVE_PATH);
  if (!containedFile(engineRoot, layoutPath)) {
    addError(errors, "FAIL-SHARED-ENGINE", `layout resolver is missing: ${LAYOUT_RELATIVE_PATH}`);
    return;
  }
  const inspectedEngine = inspectModule(enginePath);
  if (!inspectedEngine.ok) {
    addError(errors, "FAIL-SHARED-ENGINE", `engine cannot be loaded (${inspectedEngine.error})`);
  } else {
    if (inspectedEngine.types.execute !== "function") addError(errors, "FAIL-SHARED-ENGINE", "engine must export execute");
    if (inspectedEngine.types.parseArguments !== "function") addError(errors, "FAIL-SHARED-ENGINE", "engine must export parseArguments");
  }
  const sharedManifest = readJson(path.join(engineRoot, "MANIFEST.json"), errors, "shared MANIFEST.json");
  checkSharedManifest(engineRoot, sharedManifest, errors);
  try {
    const { resolveSeiLayout } = require(layoutPath);
    const layout = resolveSeiLayout({ skillRoot: packageRoot });
    if (layout.package_root !== fs.realpathSync.native(packageRoot) || layout.shared_engine_root !== fs.realpathSync.native(engineRoot)) {
      addError(errors, "FAIL-SHARED-ENGINE", "layout resolver did not bind the package and shared engine to one canonical installation");
    }
    const registry = require(layout.registry_path);
    const sharedRecord = registry.discover(layout.canonical_root).packages.find((item) => item.name === SHARED_PACKAGE_NAME);
    const expectedExports = canonicalRegistryExports(REQUIRED_SHARED_PUBLIC_EXPORTS);
    if (!sharedRecord || expectedExports === null || !sameSorted(sharedRecord.exports ?? [], expectedExports)) {
      addError(errors, "FAIL-SHARED-ENGINE", "registry discovery must expose the complete shared-engine canonical exports");
    }
  } catch (error) {
    addError(errors, "FAIL-SHARED-ENGINE", `layout resolver cannot validate this package placement (${error.message})`);
  }
  const runnerText = readText(path.join(packageRoot, "scripts", "run-sei.js"), errors, "FAIL-PACKAGE-FILE");
  const maturityRunnerText = readText(path.join(packageRoot, "scripts", "score-sei-maturity.js"), errors, "FAIL-PACKAGE-FILE");
  const expectedRunnerLayoutImport = toPosix(path.relative(path.join(packageRoot, "scripts"), layoutPath));
  if (
    runnerText !== null &&
    (!runnerText.includes(`"${expectedRunnerLayoutImport}"`) ||
      runnerText.includes("../../../shared/software-engineering-intelligence") ||
      !runnerText.includes("resolveSeiLayout") ||
      !runnerText.includes("execute"))
  ) {
    addError(errors, "FAIL-SHARED-ENGINE", "runner must resolve the shared CLI through the canonical layout boundary");
  }
  if (
    maturityRunnerText !== null &&
    (!maturityRunnerText.includes(`"${expectedRunnerLayoutImport}"`) ||
      !maturityRunnerText.includes("resolveSeiLayout") ||
      !maturityRunnerText.includes("scoreMaturity") ||
      !maturityRunnerText.includes("validateMaturityScorecard"))
  ) {
    addError(errors, "FAIL-SHARED-ENGINE", "maturity runner must resolve the canonical scorer through the layout boundary");
  }
  checkRunnerBehaviour(packageRoot, engineRoot, layoutPath, errors);
}

// Loaded with --require into a runner subprocess. It records every resolved
// module file and replaces the shared CLI / maturity scorer with sentinel stubs,
// so the check proves the runner really executes the canonical engine through
// the layout boundary without running a real SEI collection.
const RUNNER_PROBE_SOURCE = `"use strict";
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const out = process.env.SEI_PACKAGE_PROBE_OUT;
const token = process.env.SEI_PACKAGE_PROBE_TOKEN;
const engineRoot = process.env.SEI_PACKAGE_PROBE_ENGINE;
const key = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
const realOf = (value) => { try { return fs.realpathSync.native(value); } catch { return value; } };
const loaded = [];
const originalLoad = Module._load;
Module._load = function probeLoad(request, parent, isMain) {
  let filename = null;
  try { filename = Module._resolveFilename(request, parent, isMain); } catch {}
  if (typeof filename === "string" && path.isAbsolute(filename)) {
    const real = realOf(filename);
    loaded.push(real);
    fs.writeFileSync(out, JSON.stringify(loaded));
    if (key(path.dirname(real)) === key(engineRoot)) {
      if (path.basename(real) === "cli.js") {
        return Object.freeze({ execute: async () => ({ sei_package_probe: token }), parseArguments: () => ({}) });
      }
      if (path.basename(real) === "maturity-scorer.js") {
        const stop = () => { throw new Error("SEI_PACKAGE_PROBE:" + token); };
        return Object.freeze({ scoreMaturity: stop, renderMaturityScorecardMarkdown: stop, validateMaturityScorecard: stop, withEvidenceArtifactRoot: stop });
      }
    }
  }
  return originalLoad.apply(this, arguments);
};
`;

function probeEnvironment(extra) {
  const environment = {};
  for (const name of PROBE_ENV_ALLOWLIST) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  return { ...environment, ...extra };
}

function runRunnerProbe(runnerPath, engineRoot, args, workspace) {
  const token = require("node:crypto").randomBytes(16).toString("hex");
  const probePath = path.join(workspace, "probe.js");
  const outPath = path.join(workspace, `loaded-${path.basename(runnerPath)}.json`);
  fs.writeFileSync(probePath, RUNNER_PROBE_SOURCE, "utf8");
  const result = spawnSync(process.execPath, ["--require", probePath, runnerPath, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: probeEnvironment({
      SEI_PACKAGE_PROBE_OUT: outPath,
      SEI_PACKAGE_PROBE_TOKEN: token,
      SEI_PACKAGE_PROBE_ENGINE: engineRoot,
    }),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  let loaded = [];
  try {
    loaded = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    loaded = [];
  }
  const key = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  return {
    token,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    has: (target) => new Set(loaded.map(key)).has(key(target)),
  };
}

function checkRunnerBehaviour(packageRoot, engineRootInput, layoutPath, errors) {
  const engineRoot = realPathOrNull(engineRootInput);
  const realLayout = realPathOrNull(layoutPath);
  const runnerPath = path.join(packageRoot, "scripts", "run-sei.js");
  const maturityPath = path.join(packageRoot, "scripts", "score-sei-maturity.js");
  if (engineRoot === null || realLayout === null) return;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sei-runner-probe-"));
  try {
    if (containedFile(packageRoot, runnerPath)) {
      const probe = runRunnerProbe(runnerPath, engineRoot, [], workspace);
      let receipt = null;
      try {
        receipt = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
      } catch {
        receipt = null;
      }
      if (
        !probe.has(realLayout) ||
        !probe.has(path.join(engineRoot, "cli.js")) ||
        receipt?.sei_package_probe !== probe.token
      ) {
        addError(errors, "FAIL-SHARED-ENGINE", "runner did not execute the canonical CLI through the layout boundary");
      }
    }
    if (containedFile(packageRoot, maturityPath)) {
      const evidencePath = path.join(workspace, "evidence.json");
      fs.writeFileSync(evidencePath, "{}\n", "utf8");
      const probe = runRunnerProbe(maturityPath, engineRoot, ["--evidence", evidencePath, "--out", path.join(workspace, "out")], workspace);
      if (
        !probe.has(realLayout) ||
        !probe.has(path.join(engineRoot, "maturity-scorer.js")) ||
        !probe.stderr.includes(`SEI_PACKAGE_PROBE:${probe.token}`)
      ) {
        addError(errors, "FAIL-SHARED-ENGINE", "maturity runner did not execute the canonical scorer through the layout boundary");
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function checkPackageLocal(packageRoot = path.resolve(__dirname, "..")) {
  const root = path.resolve(packageRoot);
  const errors = [];
  let context = {
    default_model_context: [],
    conditional_model_context: [],
    model_opaque_paths: [],
    metadata_paths: [],
  };
  try {
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      addError(errors, "FAIL-PACKAGE-ROOT", `package root is not a directory: ${toPosix(root)}`);
    } else {
      checkDeclaredFiles(root, errors);
      checkSkill(root, errors);
      checkOpenAiYaml(root, errors);
      const manifest = readJson(path.join(root, "MANIFEST.json"), errors, "MANIFEST.json");
      const policy = readJson(path.join(root, "context-policy.json"), errors, "context-policy.json");
      const evals = readJson(path.join(root, "evals", "evals.json"), errors, "evals/evals.json");
      readJson(path.join(root, "assets", "canonical-input.json"), errors, "assets/canonical-input.json");
      checkManifest(root, manifest, errors);
      checkRuntimeContract(root, manifest, errors);
      context = checkContextPolicy(root, policy, errors);
      checkEvaluations(evals, errors);
      checkSharedEngine(root, errors);
    }
  } catch (error) {
    addError(errors, "FAIL-PACKAGE-CHECK", error.message);
  }
  const sortedErrors = [...new Set(errors)].sort();
  return {
    ok: sortedErrors.length === 0,
    errors: sortedErrors,
    context,
    file_count: countFiles(root),
  };
}

function checkPackage(packageRoot = path.resolve(__dirname, "..")) {
  const root = path.resolve(packageRoot);
  const result = spawnSync(process.execPath, [__filename, "--json", root], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      errors: [`FAIL-PACKAGE-CHECK: isolated validator failed (${String(result.stderr || error.message).trim()})`],
      context: { default_model_context: [], conditional_model_context: [], model_opaque_paths: [], metadata_paths: [] },
      file_count: 0,
    };
  }
}

function assertPackage(packageRoot) {
  const result = checkPackage(packageRoot);
  if (!result.ok) {
    const error = new Error(result.errors.join("\n"));
    error.result = result;
    throw error;
  }
  return result;
}

function formatResult(result) {
  if (!result.ok) return `SEI_PACKAGE_INVALID errors=${result.errors.length}\n${result.errors.join("\n")}`;
  return [
    "SEI_PACKAGE_OK",
    `files=${result.file_count}`,
    `core=${result.context.default_model_context.length}`,
    `conditional=${result.context.conditional_model_context.length}`,
    `opaque=${result.context.model_opaque_paths.length}`,
    `metadata=${result.context.metadata_paths.length}`,
  ].join(" ");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args[0] === "--json";
  const positional = jsonMode ? args.slice(1) : args;
  if (positional.length > 1) {
    process.stderr.write("FAIL-PACKAGE-ARGUMENTS: expected zero or one package-root argument\n");
    process.exitCode = 1;
  } else {
    const result = checkPackageLocal(positional[0] ?? path.resolve(__dirname, ".."));
    process.stdout.write(jsonMode ? JSON.stringify(result) : `${formatResult(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}

module.exports = {
  assertPackage,
  checkPackage,
  formatResult,
};
