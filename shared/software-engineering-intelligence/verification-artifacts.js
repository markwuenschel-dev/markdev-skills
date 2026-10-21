"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_DISCOVERY_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_PATHS = 100_000;
const MAX_DISCOVERED_CONFIGURATION_ARTIFACTS = 512;
const MAX_DISCOVERED_EVIDENCE_PATHS = 256;
const MAX_DISCOVERED_RESULT_ARTIFACTS = 32;
const FULL_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONFIGURATION_HASH = /^[a-f0-9]{64}$/;
const DISCOVERY_STATES = Object.freeze({
  CONFIGURED: "CONFIGURED",
  OBSERVED: "OBSERVED",
  UNAVAILABLE: "UNAVAILABLE",
});

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function stableSurfaceCompare(left, right) {
  const insensitive = stableCompare(String(left).toLowerCase(), String(right).toLowerCase());
  return insensitive || stableCompare(left, right);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(detail) {
  throw new Error(`FAIL-VERIFICATION-ARTIFACT: ${detail}`);
}

function requireClosedKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} contains an unsupported field`);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function payloadDigest(payload) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(payload)).digest("hex")}`;
}

function rawDigest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeRevisionPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("discovered Git path must be nonempty and contain no NUL bytes");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("discovered Git path must be repository-relative and normalized");
  }
  return normalized;
}

function boundedEvidencePaths(paths) {
  return [...new Set(paths)].sort(stableCompare).slice(0, MAX_DISCOVERED_EVIDENCE_PATHS);
}

function withoutCommentOnlyLines(text, syntax) {
  let normalized = String(text);
  if (syntax === "xml") normalized = normalized.replace(/<!--[\s\S]*?-->/g, "");
  if (syntax === "javascript" || syntax === "gradle") normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, "");
  const lines = normalized.split(/\r?\n/);
  if (syntax === "json") return normalized;
  return lines.filter((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
    return trimmed.length > 0;
  }).join("\n");
}

const SURFACE_RULES = Object.freeze([
  ["Gradle/JUnit", /(?:\.\/)?gradlew\b[^\r\n]*(?:\btest\b|\bcleanTest\b)|\buseJUnitPlatform\s*\(|\btestImplementation\s*\(/i],
  ["Jest", /(?:^|[^A-Za-z0-9_-])jest(?:\s|$|["'])/im],
  ["Maven/JUnit", /(?:\.\/)?mvnw?\b[^\r\n]*\btest\b|<artifactId>\s*(?:junit[^<]*|maven-(?:surefire|failsafe)-plugin)\s*<\/artifactId>/i],
  ["mypy", /(?:^|[^A-Za-z0-9_-])mypy(?:\s|$|["'])/im],
  ["pyright", /(?:^|[^A-Za-z0-9_-])pyright(?:\s|$|["'])/im],
  ["pytest", /(?:^|[^A-Za-z0-9_-])pytest(?:\s|$|["'])|\[tool\.pytest\./im],
  ["Ruff", /(?:^|[^A-Za-z0-9_-])ruff(?:\s|$|["'])|\[tool\.ruff(?:\.|\])/im],
  ["Vitest", /(?:^|[^A-Za-z0-9_-])vitest(?:\s|$|["'])/im],
]);

function observedSurfaces(text, syntax, allowed = null) {
  const executableText = withoutCommentOnlyLines(text, syntax);
  return SURFACE_RULES
    .filter(([name, pattern]) => (allowed === null || allowed.has(name)) && pattern.test(executableText))
    .map(([name]) => name)
    .sort(stableSurfaceCompare);
}

function discoveryCapability(state, evidencePaths, workflowSurfaces, reason) {
  const uniqueEvidencePaths = [...new Set(evidencePaths)].sort(stableCompare);
  return {
    state,
    evidence_path_count: uniqueEvidencePaths.length,
    evidence_paths: boundedEvidencePaths(uniqueEvidencePaths),
    workflow_surfaces: [...new Set(workflowSurfaces)].sort(stableSurfaceCompare),
    execution: state === DISCOVERY_STATES.OBSERVED ? "OBSERVED" : "UNOBSERVED",
    reason,
  };
}

function revisionArtifactEnvelope(input, artifacts) {
  const parsed = artifacts.map((artifact) => ({
    format: artifact.format,
    bytes: artifact.bytes,
    digest: rawDigest(artifact.bytes),
  }));
  return buildVerificationEnvelopeFromParsed({
    ...input,
    completeness: { state: "partial", fraction: 0 },
    coverage: { scope: "partial", fraction: 0 },
  }, parsed, "revision-verification-artifacts");
}

function discoveryRecords(input, capabilityId, capability) {
  const collectorId = `${capabilityId}-discovery`;
  const analyzerIdentity = `sei.discovery.${capabilityId}@1`;
  const version = "1.0.0";
  const collectorStatus = capability.state === DISCOVERY_STATES.OBSERVED
    ? "available"
    : capability.state === DISCOVERY_STATES.CONFIGURED ? "degraded" : "unavailable";
  const observed = capability.state !== DISCOVERY_STATES.UNAVAILABLE;
  const metricId = `discovery.${capabilityId}_evidence_path_count`;
  const evidenceRefs = capability.workflow_surfaces.map((surface) => `workflow-surface:${surface}`);
  if (capability.evidence_paths.length === 0 && evidenceRefs.length === 0) {
    evidenceRefs.push(`discovery-state:${capabilityId}:${capability.state.toLowerCase()}`);
  }
  return {
    collector: {
      collector_id: collectorId,
      collector_version: version,
      status: collectorStatus,
      analyzer_identity: analyzerIdentity,
      analyzer_version: version,
      reason: collectorStatus === "available" ? null : capability.reason,
    },
    metric: {
      metric_id: metricId,
      definition_id: `sei.${metricId}@1`,
      family: "verification_discovery",
      subject: "repository:revision-bound-verification-discovery",
      repository_revision: input.repository_revision,
      value: observed ? capability.evidence_path_count : null,
      unit: "paths",
      measurement: {
        status: observed ? "measured" : "unavailable",
        completeness: observed ? 1 : 0,
        confidence: observed ? 1 : 0,
        reason: capability.reason,
      },
      source: {
        kind: "revision-bound-git-discovery",
        collector_id: collectorId,
        collector_version: version,
        repository_revision: input.repository_revision,
        command: "git ls-tree -r --name-only <revision>; git cat-file blob <revision>:<allowlisted-path>",
        artifact_refs: [...capability.evidence_paths],
        evidence_refs: evidenceRefs,
      },
      scope: {
        kind: "repository",
        path: ".",
        language: null,
        generated_code: false,
        included_in_human_maintainability: false,
      },
      window: structuredClone(input.history_window),
      analyzer_identity: analyzerIdentity,
      analyzer_version: version,
      comparability: {
        analyzer_identity: analyzerIdentity,
        analyzer_version: version,
        configuration_hash: input.configuration_hash,
        compatible_with_prior: false,
        reason: "no prior analyzer-bound measurement was supplied",
      },
    },
  };
}

function discoveryOutput(input, capabilities, verificationSummary = null) {
  const records = [
    discoveryRecords(input, "ci", capabilities.ci),
    discoveryRecords(input, "test", capabilities.tests),
    discoveryRecords(input, "coverage", capabilities.coverage),
  ];
  return {
    collectors: records.map((record) => record.collector).sort((left, right) => stableCompare(left.collector_id, right.collector_id)),
    metrics: records.map((record) => record.metric).sort((left, right) => stableCompare(left.metric_id, right.metric_id)),
    verification_summary: verificationSummary,
  };
}

function unavailableDiscoveryOutput(input, reason) {
  return discoveryOutput(input, {
    ci: discoveryCapability(DISCOVERY_STATES.UNAVAILABLE, [], [], reason),
    tests: discoveryCapability(DISCOVERY_STATES.UNAVAILABLE, [], [], reason),
    coverage: discoveryCapability(DISCOVERY_STATES.UNAVAILABLE, [], [], reason),
  });
}

function validateDiscoveryBinding(input, allowedKeys, label) {
  requireClosedKeys(input, allowedKeys, label);
  if (typeof input.repository_revision !== "string" || !FULL_REVISION.test(input.repository_revision)) fail("repository_revision must be a full lowercase Git revision");
  if (typeof input.configuration_hash !== "string" || !CONFIGURATION_HASH.test(input.configuration_hash)) fail("configuration_hash must be a lowercase SHA-256 digest");
  requireClosedKeys(input.history_window, ["kind", "start", "end"], "history_window");
  if (!new Set(["revision", "revision-range"]).has(input.history_window.kind) || input.history_window.end !== input.repository_revision) fail("history_window must end at repository_revision");
  if (input.history_window.start !== null && (typeof input.history_window.start !== "string" || input.history_window.start.length === 0)) fail("history_window.start must be null or nonempty");
}

function legacyCandidates(paths) {
  return {
    workflowPaths: paths.filter((blobPath) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(blobPath) || /^(?:\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml)$/i.test(blobPath)),
    packagePaths: paths.filter((blobPath) => /(?:^|\/)package\.json$/.test(blobPath)),
    pythonConfigPaths: paths.filter((blobPath) => /(?:^|\/)(?:pyproject\.toml|pytest\.ini|tox\.ini)$/.test(blobPath)),
    pythonRequirementPaths: paths.filter((blobPath) => /(?:^|\/)(?:requirements(?:[-_.](?:dev|test|tests))?\.txt|(?:dev|test)-requirements\.txt|requirements\/(?:dev|test|tests)\.txt)$/i.test(blobPath)),
    gradleConfigPaths: paths.filter((blobPath) => /(?:^|\/)(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/.test(blobPath)),
    mavenConfigPaths: paths.filter((blobPath) => /(?:^|\/)pom\.xml$/.test(blobPath)),
    intrinsicCoverageConfigPaths: paths.filter((blobPath) => /(?:^|\/)(?:\.coveragerc|coverage\.toml)$/.test(blobPath)),
    conditionalCoverageConfigPaths: paths
      .filter((blobPath) => /(?:^|\/)(?:jest\.config\.[^/]+|vitest\.config\.[^/]+)$/.test(blobPath))
      .map((blobPath) => ({ path: blobPath, surface: /(?:^|\/)jest\.config\./.test(blobPath) ? "Jest" : "Vitest" })),
    testSourcePaths: paths.filter((blobPath) => (
      /(?:^|\/)(?:tests?|__tests__|src\/test)(?:\/|$)/.test(blobPath)
        && /\.(?:[cm]?[jt]sx?|py|java|kt|kts|groovy|rb|go|rs|cs|c|cc|cpp|cxx|h|hpp|php|swift|scala)$/i.test(blobPath)
    ) || /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(blobPath)),
    junitPaths: paths.filter((blobPath) => /(?:^|\/)(?:TEST-[^/]+|junit[^/]*)\.xml$/i.test(blobPath) || /(?:^|\/)test-results\/[^/]+\.xml$/i.test(blobPath)),
    lcovPaths: paths.filter((blobPath) => /(?:^|\/)lcov\.info$/i.test(blobPath)),
    unsupportedCoverageResultPaths: paths.filter((blobPath) => (
      /(?:^|\/)(?:jacoco(?:TestReport)?|cobertura|coverage)\.xml$/i.test(blobPath)
        || /(?:^|\/)\.coverage(?:\.[^/]+)?$/i.test(blobPath)
    )),
  };
}

function discoverFromCandidates(input, candidates, candidateReader) {
  const {
    workflowPaths,
    packagePaths,
    pythonConfigPaths,
    pythonRequirementPaths,
    gradleConfigPaths,
    mavenConfigPaths,
    intrinsicCoverageConfigPaths,
    conditionalCoverageConfigPaths,
    testSourcePaths,
    junitPaths,
    lcovPaths,
    unsupportedCoverageResultPaths,
  } = candidates;
  const blobCache = new Map();
  let inspectedConfigurationArtifactCount = 0;
  function readBlob(blobPath) {
    if (blobCache.has(blobPath)) return blobCache.get(blobPath);
    const bytes = candidateReader(blobPath);
    if (!Buffer.isBuffer(bytes)) fail("revision blob reader must return bytes");
    if (bytes.length > MAX_DISCOVERY_BLOB_BYTES) fail(`discovery blob exceeds the ${MAX_DISCOVERY_BLOB_BYTES}-byte limit`);
    blobCache.set(blobPath, bytes);
    return bytes;
  }
  function inspectedText(blobPath, syntax, failures) {
    if (!blobCache.has(blobPath) && inspectedConfigurationArtifactCount >= MAX_DISCOVERED_CONFIGURATION_ARTIFACTS) {
      failures.push(blobPath);
      return "";
    }
    try {
      if (!blobCache.has(blobPath)) inspectedConfigurationArtifactCount += 1;
      return withoutCommentOnlyLines(readBlob(blobPath).toString("utf8"), syntax);
    } catch {
      failures.push(blobPath);
      return "";
    }
  }

  const coverageConfigPaths = [...intrinsicCoverageConfigPaths];
  const ciSurfaces = [];
  const workflowInspectionFailures = [];
  const testInspectionFailures = [];
  const coverageInspectionFailures = [];
  const sharedTestCoverageInspectionFailures = [];
  const workflowExecutionText = workflowPaths.map((blobPath) => inspectedText(blobPath, "yaml", workflowInspectionFailures)).join("\n");
  ciSurfaces.push(...observedSurfaces(workflowExecutionText, "yaml"));
  const testEvidencePaths = [...testSourcePaths];
  const testSurfaces = [];
  for (const blobPath of packagePaths) {
    const text = inspectedText(blobPath, "json", sharedTestCoverageInspectionFailures);
    if (text.length === 0) continue;
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const scripts = isRecord(parsed?.scripts) ? Object.entries(parsed.scripts).filter(([, command]) => typeof command === "string") : [];
    const dependencyNames = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .flatMap((field) => isRecord(parsed?.[field]) ? Object.keys(parsed[field]) : []);
    const packageTestSurfaces = observedSurfaces(text, "json", new Set(["Jest", "Vitest"]));
    const hasTestConfiguration = scripts.some(([name, command]) => (
      name === "test" || /(?:^|[^A-Za-z0-9_-])(?:jest|vitest)(?:\s|$)/i.test(command)
    )) || dependencyNames.some((name) => /^(?:jest|vitest|@jest\/|@vitest\/)/i.test(name));
    if (hasTestConfiguration) {
      testEvidencePaths.push(blobPath);
      testSurfaces.push(...packageTestSurfaces);
      if (/(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/i.test(workflowExecutionText)) ciSurfaces.push(...packageTestSurfaces);
    }
    if (scripts.some(([name, command]) => (
      command.trim().length > 0 && (
        /coverage/i.test(name) || /\b(?:c8|nyc)\b|\b(?:vitest|jest)\b[^\r\n]*--coverage\b/i.test(command)
      )
    )) || dependencyNames.some((name) => /^(?:c8|nyc|@vitest\/coverage-|babel-plugin-istanbul)$/i.test(name))
      || parsed?.jest?.collectCoverage === true) coverageConfigPaths.push(blobPath);
  }
  for (const blobPath of pythonConfigPaths) {
    const text = inspectedText(blobPath, "toml", sharedTestCoverageInspectionFailures);
    if (text.length === 0) continue;
    const surfaces = observedSurfaces(text, "toml", new Set(["pytest"]));
    if (surfaces.length > 0) {
      testEvidencePaths.push(blobPath);
      testSurfaces.push(...surfaces);
    }
    if (/(?:^|\n)\s*\[tool\.coverage(?:\.|\])/im.test(text)) coverageConfigPaths.push(blobPath);
  }
  for (const blobPath of pythonRequirementPaths) {
    const text = inspectedText(blobPath, "requirements", testInspectionFailures);
    if (/(?:^|\n)\s*pytest(?:[<>=!~\[]|\s|$)/im.test(text)) {
      testEvidencePaths.push(blobPath);
      testSurfaces.push("pytest");
    }
  }
  for (const blobPath of gradleConfigPaths) {
    const text = inspectedText(blobPath, "gradle", sharedTestCoverageInspectionFailures);
    if (text.length === 0) continue;
    const surfaces = observedSurfaces(text, "gradle", new Set(["Gradle/JUnit"]));
    if (surfaces.length > 0) {
      testEvidencePaths.push(blobPath);
      testSurfaces.push(...surfaces);
    }
    if (/\bjacoco\b/i.test(text)) coverageConfigPaths.push(blobPath);
  }
  for (const blobPath of mavenConfigPaths) {
    const text = inspectedText(blobPath, "xml", sharedTestCoverageInspectionFailures);
    if (text.length === 0) continue;
    const surfaces = observedSurfaces(text, "xml", new Set(["Maven/JUnit"]));
    if (surfaces.length > 0) {
      testEvidencePaths.push(blobPath);
      testSurfaces.push(...surfaces);
    }
    if (/<artifactId>\s*(?:jacoco-maven-plugin|cobertura-maven-plugin)\s*<\/artifactId>/i.test(text)) coverageConfigPaths.push(blobPath);
  }
  for (const candidate of conditionalCoverageConfigPaths) {
    const text = inspectedText(candidate.path, "javascript", coverageInspectionFailures);
    testEvidencePaths.push(candidate.path);
    const inferredSurfaces = candidate.surface === null
      ? observedSurfaces(text, "javascript", new Set(["Jest", "Vitest"]))
      : [candidate.surface];
    testSurfaces.push(...inferredSurfaces);
    if (/\bcoverage\s*[:=]/i.test(text)) coverageConfigPaths.push(candidate.path);
  }
  testInspectionFailures.push(...sharedTestCoverageInspectionFailures);
  coverageInspectionFailures.push(...sharedTestCoverageInspectionFailures);

  const resultPaths = [...junitPaths, ...lcovPaths].sort(stableCompare);
  let verificationSummary = null;
  let testResultFailure = null;
  let coverageResultFailure = null;
  const validResultArtifacts = [];
  if (resultPaths.length > MAX_DISCOVERED_RESULT_ARTIFACTS) {
    const boundReason = `supported committed result artifact count exceeded the ${MAX_DISCOVERED_RESULT_ARTIFACTS}-artifact bound`;
    if (junitPaths.length > 0) testResultFailure = boundReason;
    if (lcovPaths.length > 0) coverageResultFailure = boundReason;
  } else {
    const acceptedDigests = new Set();
    for (const [candidatePaths, format, failureLabel] of [
      [junitPaths, "junit-xml", "JUnit"],
      [lcovPaths, "lcov", "LCOV"],
    ]) {
      if (candidatePaths.length === 0) continue;
      let isolatedCount = 0;
      for (const blobPath of candidatePaths) {
        try {
          const artifact = { format, bytes: readBlob(blobPath) };
          revisionArtifactEnvelope(input, [artifact]);
          const digest = rawDigest(artifact.bytes);
          if (acceptedDigests.has(digest)) {
            isolatedCount += 1;
            continue;
          }
          acceptedDigests.add(digest);
          validResultArtifacts.push(artifact);
        } catch {
          isolatedCount += 1;
        }
      }
      if (isolatedCount > 0) {
        const noun = isolatedCount === 1 ? "artifact" : "artifacts";
        const detail = `${failureLabel} result normalization isolated ${isolatedCount} malformed, unreadable, duplicate, or unsupported ${noun}`;
        if (format === "junit-xml") testResultFailure = detail;
        else coverageResultFailure = detail;
      }
    }
    if (validResultArtifacts.length > 0) {
      verificationSummary = revisionArtifactEnvelope(input, validResultArtifacts);
    }
  }
  const observedTests = verificationSummary?.payload?.tests !== undefined;
  const observedCoverage = verificationSummary?.payload?.coverage !== undefined;
  const ci = workflowPaths.length > 0
    ? discoveryCapability(DISCOVERY_STATES.CONFIGURED, workflowPaths, ciSurfaces, `CI configuration was observed at the resolved Git revision${workflowInspectionFailures.length > 0 ? "; bounded content could not be inspected" : ""}; execution results were not observed`)
    : discoveryCapability(DISCOVERY_STATES.UNAVAILABLE, [], [], "no supported committed CI configuration was observed at the resolved Git revision");
  const tests = observedTests
    ? discoveryCapability(DISCOVERY_STATES.OBSERVED, [...testEvidencePaths, ...junitPaths], [...testSurfaces, ...ciSurfaces.filter((surface) => ["Gradle/JUnit", "Jest", "Maven/JUnit", "pytest", "Vitest"].includes(surface))], `committed supported JUnit results were observed and normalized at the resolved Git revision${testResultFailure ? `; ${testResultFailure}` : ""}; repository-wide result completeness and current test health remain unknown`)
    : testEvidencePaths.length > 0
      ? discoveryCapability(DISCOVERY_STATES.CONFIGURED, [...testEvidencePaths, ...junitPaths], testSurfaces, `${testResultFailure ? `${testResultFailure}; ` : ""}test configuration or test sources were observed at the resolved Git revision${testInspectionFailures.length > 0 ? "; some bounded candidate configuration content could not be inspected" : ""}; execution results were not observed`)
      : discoveryCapability(DISCOVERY_STATES.UNAVAILABLE, junitPaths, [], testResultFailure ?? (testInspectionFailures.length > 0
        ? "candidate test configuration content could not be inspected within the bounded revision-only discovery contract"
        : "no supported committed test configuration, sources, or result artifact was observed at the resolved Git revision"));
  const coverage = observedCoverage
    ? discoveryCapability(DISCOVERY_STATES.OBSERVED, [...coverageConfigPaths, ...lcovPaths, ...unsupportedCoverageResultPaths], [], `committed supported LCOV results were observed and normalized at the resolved Git revision${coverageResultFailure ? `; ${coverageResultFailure}` : ""}; repository coverage scope and completeness remain unknown${unsupportedCoverageResultPaths.length > 0 ? "; JaCoCo/Cobertura/coverage.py results were not normalized" : ""}`)
    : coverageConfigPaths.length > 0 || unsupportedCoverageResultPaths.length > 0
      ? discoveryCapability(DISCOVERY_STATES.CONFIGURED, [...coverageConfigPaths, ...lcovPaths, ...unsupportedCoverageResultPaths], [], `${coverageResultFailure ? `${coverageResultFailure}; ` : ""}coverage configuration or conventional result artifacts were observed at the resolved Git revision${unsupportedCoverageResultPaths.length > 0 ? "; JaCoCo/Cobertura/coverage.py results were not normalized" : ""}${coverageInspectionFailures.length > 0 ? "; some bounded candidate configuration content could not be inspected" : ""}; execution results were not observed`)
      : discoveryCapability(DISCOVERY_STATES.UNAVAILABLE, lcovPaths, [], coverageResultFailure ?? (coverageInspectionFailures.length > 0
        ? "candidate coverage configuration content could not be inspected within the bounded revision-only discovery contract"
        : "no supported committed coverage configuration or result artifact was observed at the resolved Git revision"));
  return discoveryOutput(input, { ci, tests, coverage }, verificationSummary);
}

function discoverRevisionBoundVerificationEvidence(input) {
  validateDiscoveryBinding(
    input,
    ["repository_revision", "configuration_hash", "history_window", "listRevisionPaths", "readRevisionBlob"],
    "revision-bound discovery input",
  );
  if (typeof input.listRevisionPaths !== "function" || typeof input.readRevisionBlob !== "function") fail("revision-bound discovery requires path and blob readers");
  let paths;
  try {
    const listed = input.listRevisionPaths();
    if (!Array.isArray(listed) || listed.length > MAX_DISCOVERY_PATHS) {
      return unavailableDiscoveryOutput(input, `revision-bound discovery was unavailable because the path listing exceeded the ${MAX_DISCOVERY_PATHS}-path bound or was malformed`);
    }
    paths = listed.map(normalizeRevisionPath);
    if (new Set(paths).size !== paths.length) {
      return unavailableDiscoveryOutput(input, "revision-bound discovery was unavailable because the path listing contained duplicate paths");
    }
  } catch {
    return unavailableDiscoveryOutput(input, "revision-bound discovery was unavailable because the path listing could not be read or validated");
  }
  paths.sort(stableCompare);
  const pathSet = new Set(paths);
  return discoverFromCandidates(input, legacyCandidates(paths), (blobPath) => {
    if (!pathSet.has(blobPath)) fail("revision blob reader was asked for an unlisted path");
    return input.readRevisionBlob(blobPath);
  });
}

function indexCandidates(entries) {
  const hasManifest = (entry, kind) => entry.classifications.manifest_kinds.includes(kind);
  const hasArtifact = (entry, kind) => entry.classifications.artifact_candidate_kinds.includes(kind);
  const byPath = (left, right) => stableCompare(left.path, right.path);
  const configurationWithoutManifest = (entry) => entry.classifications.manifest_kinds.length === 0;
  return {
    workflowPaths: entries.filter((entry) => hasArtifact(entry, "ci-config")).sort(byPath).map((entry) => entry.path),
    packagePaths: entries.filter((entry) => hasManifest(entry, "node-package")).sort(byPath).map((entry) => entry.path),
    pythonConfigPaths: entries.filter((entry) => (
      hasManifest(entry, "python-project") ||
      (configurationWithoutManifest(entry) && hasArtifact(entry, "test-config") && !hasArtifact(entry, "coverage-config"))
    )).sort(byPath).map((entry) => entry.path),
    pythonRequirementPaths: entries.filter((entry) => hasManifest(entry, "python-requirements")).sort(byPath).map((entry) => entry.path),
    gradleConfigPaths: entries.filter((entry) => hasManifest(entry, "gradle-build") || hasManifest(entry, "gradle-settings")).sort(byPath).map((entry) => entry.path),
    mavenConfigPaths: entries.filter((entry) => hasManifest(entry, "maven-project")).sort(byPath).map((entry) => entry.path),
    intrinsicCoverageConfigPaths: entries.filter((entry) => (
      configurationWithoutManifest(entry) && hasArtifact(entry, "coverage-config") && !hasArtifact(entry, "test-config")
    )).sort(byPath).map((entry) => entry.path),
    conditionalCoverageConfigPaths: entries.filter((entry) => (
      configurationWithoutManifest(entry) && hasArtifact(entry, "coverage-config") && hasArtifact(entry, "test-config")
    )).sort(byPath).map((entry) => ({
      path: entry.path,
      surface: hasArtifact(entry, "jest-config") ? "Jest" : hasArtifact(entry, "vitest-config") ? "Vitest" : null,
    })),
    testSourcePaths: entries.filter((entry) => entry.classifications.test_source === true).sort(byPath).map((entry) => entry.path),
    junitPaths: entries.filter((entry) => hasArtifact(entry, "junit-result")).sort(byPath).map((entry) => entry.path),
    lcovPaths: entries.filter((entry) => hasArtifact(entry, "lcov-result")).sort(byPath).map((entry) => entry.path),
    unsupportedCoverageResultPaths: entries.filter((entry) => hasArtifact(entry, "unsupported-coverage-result")).sort(byPath).map((entry) => entry.path),
  };
}

function cancellationRequested(signal) {
  if (!signal?.aborted) return;
  const error = new Error("FAIL-REPOSITORY-INDEX-CANCELLED: verification discovery was cancelled");
  error.code = "FAIL-REPOSITORY-INDEX-CANCELLED";
  throw error;
}

async function discoverRevisionBoundVerificationEvidenceFromIndex(input) {
  validateDiscoveryBinding(
    input,
    ["repository_revision", "configuration_hash", "history_window", "repository_index", "signal"],
    "indexed revision-bound discovery input",
  );
  if (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== "boolean" || typeof input.signal.addEventListener !== "function")) fail("signal must be an AbortSignal");
  cancellationRequested(input.signal);
  const repositoryIndex = input.repository_index;
  if (!repositoryIndex || typeof repositoryIndex !== "object" || !Array.isArray(repositoryIndex.entries) || typeof repositoryIndex.readBlobs !== "function") {
    fail("repository_index must expose entries and readBlobs");
  }
  if (repositoryIndex.binding?.repository_revision !== input.repository_revision) fail("repository index revision does not match discovery input");
  if (repositoryIndex.entries.length > MAX_DISCOVERY_PATHS) {
    return unavailableDiscoveryOutput(input, `revision-bound discovery was unavailable because the path listing exceeded the ${MAX_DISCOVERY_PATHS}-path bound or was malformed`);
  }
  const candidates = indexCandidates(repositoryIndex.entries);
  const entryByPath = new Map(repositoryIndex.entries.map((entry) => [entry.path, entry]));
  const configurationOrder = [
    ...candidates.workflowPaths,
    ...candidates.packagePaths,
    ...candidates.pythonConfigPaths,
    ...candidates.pythonRequirementPaths,
    ...candidates.gradleConfigPaths,
    ...candidates.mavenConfigPaths,
    ...candidates.conditionalCoverageConfigPaths.map((candidate) => candidate.path),
  ];
  const firstConfigurationPaths = [];
  const planned = new Set();
  for (const candidatePath of configurationOrder) {
    if (planned.has(candidatePath)) continue;
    planned.add(candidatePath);
    firstConfigurationPaths.push(candidatePath);
    if (firstConfigurationPaths.length === MAX_DISCOVERED_CONFIGURATION_ARTIFACTS) break;
  }
  const supportedResults = [...candidates.junitPaths, ...candidates.lcovPaths].sort(stableCompare);
  const readPaths = [...firstConfigurationPaths];
  if (supportedResults.length <= MAX_DISCOVERED_RESULT_ARTIFACTS) {
    for (const resultPath of supportedResults) if (!planned.has(resultPath)) readPaths.push(resultPath);
  }
  const failures = new Map();
  const readableEntries = [];
  for (const candidatePath of readPaths) {
    const entry = entryByPath.get(candidatePath);
    if (!entry) {
      failures.set(candidatePath, "indexed candidate path was not owned by the repository index");
    } else if (entry.byte_size > MAX_DISCOVERY_BLOB_BYTES) {
      failures.set(candidatePath, `discovery blob exceeds the ${MAX_DISCOVERY_BLOB_BYTES}-byte limit`);
    } else {
      readableEntries.push(entry);
    }
  }
  const bytesByPath = new Map();
  async function readBatch(batch) {
    cancellationRequested(input.signal);
    try {
      const blobs = await repositoryIndex.readBlobs(batch, {
        max_blob_bytes: MAX_DISCOVERY_BLOB_BYTES,
        max_total_bytes: 32 * 1024 * 1024,
        signal: input.signal,
      });
      for (const entry of batch) {
        const bytes = blobs.get(entry.path);
        if (!Buffer.isBuffer(bytes)) throw new Error(`indexed blob result omitted ${entry.path}`);
        bytesByPath.set(entry.path, bytes);
      }
    } catch (error) {
      if (String(error?.message).startsWith("FAIL-REPOSITORY-INDEX-CANCELLED")) throw error;
      if (batch.length === 1) {
        failures.set(batch[0].path, error?.message ?? "indexed blob read failed");
        return;
      }
      const midpoint = Math.floor(batch.length / 2);
      await readBatch(batch.slice(0, midpoint));
      await readBatch(batch.slice(midpoint));
    }
  }
  for (let offset = 0; offset < readableEntries.length;) {
    const batch = [];
    let totalBytes = 0;
    while (offset < readableEntries.length && totalBytes + readableEntries[offset].byte_size <= 32 * 1024 * 1024) {
      batch.push(readableEntries[offset]);
      totalBytes += readableEntries[offset].byte_size;
      offset += 1;
    }
    await readBatch(batch);
  }
  cancellationRequested(input.signal);
  return discoverFromCandidates(input, candidates, (candidatePath) => {
    if (failures.has(candidatePath)) fail(`cannot inspect ${candidatePath}: ${failures.get(candidatePath)}`);
    const bytes = bytesByPath.get(candidatePath);
    if (!Buffer.isBuffer(bytes)) fail(`candidate ${candidatePath} was outside the bounded read plan`);
    return bytes;
  });
}

function parseNonNegativeInteger(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} exceeds the safe integer range`);
  return parsed;
}

function parseSeconds(value, label) {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) fail(`${label} must be nonnegative decimal seconds`);
  const milliseconds = Number(value) * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds > Number.MAX_SAFE_INTEGER) fail(`${label} exceeds the safe millisecond range`);
  return Math.round(milliseconds);
}

function findXmlTagEnd(text, start) {
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  fail("XML tag is not terminated");
}

function parseXmlOpenTag(raw) {
  const head = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(raw);
  if (!head) fail("XML open tag is malformed");
  const name = head[1];
  let attributesText = head[2].trim();
  let selfClosing = false;
  if (attributesText.endsWith("/")) {
    selfClosing = true;
    attributesText = attributesText.slice(0, -1).trimEnd();
  }
  const attributes = Object.create(null);
  while (attributesText.length > 0) {
    const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attributesText);
    if (!match || Object.hasOwn(attributes, match[1])) fail(`XML attributes for <${name}> are malformed`);
    attributes[match[1]] = match[2] ?? match[3] ?? "";
    attributesText = attributesText.slice(match[0].length).trimStart();
  }
  return { name, attributes, selfClosing };
}

function scanXml(text, handlers) {
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) fail("DTD and entity declarations are unsupported");
  const stack = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start === -1) break;
    if (text.startsWith("<!--", start)) {
      const end = text.indexOf("-->", start + 4);
      if (end === -1) fail("XML comment is not terminated");
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", start)) {
      const end = text.indexOf("]]>", start + 9);
      if (end === -1) fail("XML CDATA section is not terminated");
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<?", start)) {
      const end = text.indexOf("?>", start + 2);
      if (end === -1) fail("XML processing instruction is not terminated");
      cursor = end + 2;
      continue;
    }
    if (text.startsWith("<!", start)) fail("XML declaration is unsupported");
    const end = findXmlTagEnd(text, start + 1);
    const raw = text.slice(start + 1, end).trim();
    if (raw.startsWith("/")) {
      const close = /^\/([A-Za-z_][A-Za-z0-9_.:-]*)$/.exec(raw);
      if (!close || stack.at(-1) !== close[1]) fail("XML tags are not balanced");
      handlers.close?.(close[1], stack);
      stack.pop();
    } else {
      const open = parseXmlOpenTag(raw);
      handlers.open?.(open.name, open.attributes, stack, open.selfClosing);
      if (open.selfClosing) {
        handlers.close?.(open.name, stack, true);
      } else {
        stack.push(open.name);
      }
    }
    cursor = end + 1;
  }
  if (stack.length > 0) fail("XML tags are not balanced");
}

function parseJUnitXml(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("JUnit XML must be supplied as bytes");
  const text = bytes.toString("utf8");
  const testcases = [];
  let rootSummary = null;
  let current = null;
  scanXml(text, {
    open(name, attributes, stack, selfClosing) {
      if ((name === "testsuite" || name === "testsuites") && stack.length === 0 && attributes.tests !== undefined) {
        rootSummary = {
          total: parseNonNegativeInteger(attributes.tests, `${name}.tests`),
          failed: parseNonNegativeInteger(attributes.failures ?? "0", `${name}.failures`) + parseNonNegativeInteger(attributes.errors ?? "0", `${name}.errors`),
          skipped: parseNonNegativeInteger(attributes.skipped ?? "0", `${name}.skipped`),
          duration_ms: parseSeconds(attributes.time, `${name}.time`),
        };
      }
      if (name === "testcase") {
        if (current !== null) fail("nested JUnit testcase elements are unsupported");
        current = { failed: false, skipped: false, duration_ms: parseSeconds(attributes.time, "testcase.time") };
      } else if (current !== null && (name === "failure" || name === "error")) {
        current.failed = true;
      } else if (current !== null && name === "skipped") {
        current.skipped = true;
      }
    },
    close(name) {
      if (name === "testcase") {
        if (current === null) fail("JUnit testcase close tag has no open testcase");
        testcases.push(current);
        current = null;
      }
    },
  });
  if (current !== null) fail("JUnit testcase is not terminated");
  if (testcases.length > 0) {
    const total = testcases.length;
    const failed = testcases.filter((item) => item.failed).length;
    const skipped = testcases.filter((item) => !item.failed && item.skipped).length;
    const durationMs = testcases.reduce((sum, item) => sum + item.duration_ms, 0);
    if (!Number.isSafeInteger(durationMs)) fail("JUnit testcase duration exceeds the safe integer range");
    return { total, passed: total - failed - skipped, failed, skipped, duration_ms: durationMs };
  }
  if (rootSummary === null) fail("JUnit XML contains neither testcase records nor a root summary");
  if (rootSummary.failed + rootSummary.skipped > rootSummary.total) fail("JUnit root summary has incoherent outcome counts");
  return {
    total: rootSummary.total,
    passed: rootSummary.total - rootSummary.failed - rootSummary.skipped,
    failed: rootSummary.failed,
    skipped: rootSummary.skipped,
    duration_ms: rootSummary.duration_ms,
  };
}

function parseLcov(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("LCOV must be supplied as bytes");
  const aggregate = { statementCovered: 0, statementTotal: 0, branchCovered: 0, branchTotal: 0, hasStatements: false, hasBranches: false };
  let record = null;
  let recordCount = 0;
  function finishRecord() {
    if (record === null) fail("LCOV end_of_record has no source file");
    if ((record.lf === null) !== (record.lh === null) || (record.brf === null) !== (record.brh === null)) {
      fail("LCOV summary counters must be present in pairs");
    }
    if (record.lf !== null) {
      if (record.lh > record.lf) fail("LCOV hit lines exceed found lines");
      aggregate.statementCovered += record.lh;
      aggregate.statementTotal += record.lf;
      aggregate.hasStatements = true;
    }
    if (record.brf !== null) {
      if (record.brh > record.brf) fail("LCOV hit branches exceed found branches");
      aggregate.branchCovered += record.brh;
      aggregate.branchTotal += record.brf;
      aggregate.hasBranches = true;
    }
    if (![aggregate.statementCovered, aggregate.statementTotal, aggregate.branchCovered, aggregate.branchTotal].every(Number.isSafeInteger)) {
      fail("LCOV aggregate exceeds the safe integer range");
    }
    record = null;
    recordCount += 1;
  }
  for (const line of bytes.toString("utf8").split("\n").map((item) => item.endsWith("\r") ? item.slice(0, -1) : item)) {
    if (line.length === 0 || line.startsWith("TN:")) continue;
    if (line.startsWith("SF:")) {
      if (record !== null || line.length === 3) fail("LCOV source records must be nonempty and terminated");
      record = { lf: null, lh: null, brf: null, brh: null };
      continue;
    }
    if (line === "end_of_record") {
      finishRecord();
      continue;
    }
    if (record === null) fail("LCOV record data appears before SF");
    for (const [prefix, field] of [["LF:", "lf"], ["LH:", "lh"], ["BRF:", "brf"], ["BRH:", "brh"]]) {
      if (line.startsWith(prefix)) {
        if (record[field] !== null) fail(`LCOV ${prefix.slice(0, -1)} appears more than once per source file`);
        record[field] = parseNonNegativeInteger(line.slice(prefix.length), `LCOV ${prefix.slice(0, -1)}`);
        break;
      }
    }
  }
  if (record !== null) fail("LCOV final source record is not terminated");
  if (recordCount === 0) fail("LCOV contains no source records");
  const coverage = {};
  if (aggregate.hasStatements && aggregate.statementTotal > 0) coverage.statements = { covered: aggregate.statementCovered, total: aggregate.statementTotal };
  if (aggregate.hasBranches && aggregate.branchTotal > 0) coverage.branches = { covered: aggregate.branchCovered, total: aggregate.branchTotal };
  return coverage;
}

function validateCompleteness(value) {
  requireClosedKeys(value, ["state", "fraction"], "completeness");
  if (!new Set(["complete", "partial"]).has(value.state) || typeof value.fraction !== "number" || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1) {
    fail("completeness must declare a finite complete or partial fraction");
  }
  if ((value.state === "complete" && value.fraction !== 1) || (value.state === "partial" && value.fraction >= 1)) fail("completeness state and fraction disagree");
  return structuredClone(value);
}

function validateCoverage(value) {
  requireClosedKeys(value, ["scope", "fraction"], "coverage");
  if (!new Set(["repository", "partial"]).has(value.scope) || typeof value.fraction !== "number" || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1) {
    fail("coverage must declare a finite repository or partial fraction");
  }
  if ((value.scope === "repository" && value.fraction !== 1) || (value.scope === "partial" && value.fraction >= 1)) fail("coverage scope and fraction disagree");
  return structuredClone(value);
}

function readArtifact(baseDirectory, artifact) {
  requireClosedKeys(artifact, ["format", "path"], "verification artifact");
  if (!new Set(["junit-xml", "lcov"]).has(artifact.format) || typeof artifact.path !== "string" || artifact.path.length === 0) {
    fail("verification artifact requires supported format and nonempty path");
  }
  const absolutePath = path.resolve(baseDirectory, artifact.path);
  let stats;
  let bytes;
  try {
    stats = fs.statSync(absolutePath);
    if (!stats.isFile()) fail("verification artifact path must resolve to a regular file");
    if (stats.size > MAX_ARTIFACT_BYTES) fail("verification artifact exceeds the 64 MiB parser limit");
    bytes = fs.readFileSync(absolutePath);
  } catch (error) {
    if (String(error.message).startsWith("FAIL-VERIFICATION-ARTIFACT:")) throw error;
    fail(`cannot read verification artifact (${error.code ?? error.message})`);
  }
  return { format: artifact.format, bytes, digest: rawDigest(bytes) };
}

function validateEnvelopeBinding(input) {
  if (typeof input.repository_revision !== "string" || !FULL_REVISION.test(input.repository_revision)) fail("repository_revision must be a full lowercase Git revision");
  if (typeof input.configuration_hash !== "string" || !CONFIGURATION_HASH.test(input.configuration_hash)) fail("configuration_hash must be a lowercase SHA-256 digest");
  requireClosedKeys(input.history_window, ["kind", "start", "end"], "history_window");
  if (!new Set(["revision", "revision-range"]).has(input.history_window.kind) || input.history_window.end !== input.repository_revision) {
    fail("history_window must end at repository_revision");
  }
  if (input.history_window.start !== null && (typeof input.history_window.start !== "string" || input.history_window.start.length === 0)) fail("history_window.start must be null or nonempty");
  return {
    completeness: validateCompleteness(input.completeness),
    coverage: validateCoverage(input.coverage),
  };
}

function buildVerificationEnvelopeFromParsed(input, parsed, artifactRefPrefix) {
  const { completeness, coverage } = validateEnvelopeBinding(input);
  if (!Array.isArray(parsed) || parsed.length === 0) fail("artifacts must be a nonempty array");
  const digests = new Set();
  for (const artifact of parsed) {
    if (digests.has(artifact.digest)) fail("duplicate verification artifact bytes are not allowed");
    digests.add(artifact.digest);
  }
  const testTotals = { total: 0, passed: 0, failed: 0, skipped: 0, duration_ms: 0 };
  const coverageTotals = { statementCovered: 0, statementTotal: 0, branchCovered: 0, branchTotal: 0, hasStatements: false, hasBranches: false };
  for (const artifact of parsed) {
    if (artifact.format === "junit-xml") {
      const tests = parseJUnitXml(artifact.bytes);
      for (const field of Object.keys(testTotals)) testTotals[field] += tests[field];
    } else {
      const parsedCoverage = parseLcov(artifact.bytes);
      if (parsedCoverage.statements) {
        coverageTotals.hasStatements = true;
        coverageTotals.statementCovered += parsedCoverage.statements.covered;
        coverageTotals.statementTotal += parsedCoverage.statements.total;
      }
      if (parsedCoverage.branches) {
        coverageTotals.hasBranches = true;
        coverageTotals.branchCovered += parsedCoverage.branches.covered;
        coverageTotals.branchTotal += parsedCoverage.branches.total;
      }
    }
  }
  if (![...Object.values(testTotals), coverageTotals.statementCovered, coverageTotals.statementTotal, coverageTotals.branchCovered, coverageTotals.branchTotal].every(Number.isSafeInteger)) {
    fail("verification aggregate exceeds the safe integer range");
  }
  const payload = {};
  if (parsed.some((artifact) => artifact.format === "junit-xml")) payload.tests = testTotals;
  const parsedCoverage = {};
  if (coverageTotals.hasStatements && coverageTotals.statementTotal > 0) parsedCoverage.statements = { covered: coverageTotals.statementCovered, total: coverageTotals.statementTotal };
  if (coverageTotals.hasBranches && coverageTotals.branchTotal > 0) parsedCoverage.branches = { covered: coverageTotals.branchCovered, total: coverageTotals.branchTotal };
  if (Object.keys(parsedCoverage).length > 0) payload.coverage = parsedCoverage;
  if (Object.keys(payload).length === 0) fail("verification artifacts contain no supported test or coverage facts");
  const rawManifest = parsed.map(({ format, digest }) => ({ format, digest })).sort((left, right) => stableCompare(`${left.format}:${left.digest}`, `${right.format}:${right.digest}`));
  const combinedRawDigest = rawDigest(Buffer.from(stableStringify(rawManifest), "utf8"));
  return {
    adapter_id: "verification-summary",
    adapter_version: "1.0.0",
    kind: "verification_summary",
    format: "local-verification-summary-v1",
    artifact_ref: `${artifactRefPrefix}:${combinedRawDigest}`,
    artifact_sha256: payloadDigest(payload),
    repository_revision: input.repository_revision,
    configuration_hash: input.configuration_hash,
    history_window: structuredClone(input.history_window),
    completeness,
    coverage,
    payload,
  };
}

function buildVerificationArtifactEnvelope(input) {
  requireClosedKeys(input, ["base_directory", "repository_revision", "configuration_hash", "history_window", "completeness", "coverage", "artifacts"], "input");
  if (typeof input.base_directory !== "string" || input.base_directory.length === 0) fail("base_directory must be a nonempty path");
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) fail("artifacts must be a nonempty array");
  const parsed = input.artifacts.map((artifact) => readArtifact(input.base_directory, artifact));
  return buildVerificationEnvelopeFromParsed(input, parsed, "local-verification-artifacts");
}

module.exports = {
  buildVerificationArtifactEnvelope,
  discoverRevisionBoundVerificationEvidence,
  discoverRevisionBoundVerificationEvidenceFromIndex,
  parseJUnitXml,
  parseLcov,
};
