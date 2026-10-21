"use strict";

const AUTONOMOUS_EVIDENCE_VERSION = "sei.autonomous-evidence@2";
const MAX_INDEX_ENTRIES = 100_000;
const MAX_CANDIDATES = 64;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_PATHS = 256;
const MAX_SURFACES = 64;
const MAX_NORMALIZED_FINDINGS = 100_000;
const MAX_MUTATION_NODES = 200_000;
const FULL_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONFIGURATION_HASH = /^[0-9a-f]{64}$/;

function fail(detail) {
  const error = new Error(`FAIL-AUTONOMOUS-EVIDENCE: ${detail}`);
  error.code = "FAIL-AUTONOMOUS-EVIDENCE";
  throw error;
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosed(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be a closed record`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(stableCompare);
  if (unknown.length > 0) fail(`${label}.${unknown[0]} is not declared`);
}

function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function checkCancelled(signal) {
  if (signal?.aborted) fail("operation was cancelled");
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function uniqueSorted(values, maximum = Number.MAX_SAFE_INTEGER) {
  return [...new Set(values)].sort(stableCompare).slice(0, maximum);
}

function normalizedEntryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("repository index entry path is invalid");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized !== value || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("repository index entry path must be normalized and repository-relative");
  }
  return normalized;
}

function pathCategories(filePath, manifestKinds) {
  const categories = [];
  const lower = filePath.toLowerCase();
  if (manifestKinds.length > 0 || /(?:^|\/)(?:cargo\.toml|go\.mod|composer\.json|gemfile|packages\.lock\.json)$/.test(lower)) {
    categories.push("dependency-manifests");
  }
  if (/(?:^|\/)(?:eslint\.config\.[^/]+|\.eslintrc(?:\.[^/]+)?|tsconfig(?:\.[^/]+)?\.json|pyrightconfig\.json|mypy\.ini|ruff\.toml|checkstyle[^/]*\.xml|detekt[^/]*\.ya?ml|\.editorconfig)$/.test(lower)) {
    categories.push("lint-and-typecheck");
    categories.push("lint-config");
  }
  if (/(?:^|\/)(?:eslint|pyright)(?:[-_.](?:report|results?|output))?\.json$/.test(lower)) {
    categories.push("lint-and-typecheck");
    categories.push("lint-result");
  }
  if (/(?:^|\/)(?:sonar-project\.properties|\.semgrep\.ya?ml|semgrep\.ya?ml|\.github\/codeql\/[^/]+\.ya?ml)$/.test(lower)) {
    categories.push("static-analysis-results");
    categories.push("static-analysis-config");
  }
  if (/\.sarif(?:\.json)?$/.test(lower)) {
    categories.push("static-analysis-results");
    categories.push("static-analysis-result");
  }
  if (/(?:^|\/)(?:stryker(?:\.conf|\.config)?\.(?:json|js|cjs|mjs|ts)|pitest\.xml|mutmut[^/]*(?:\.ini|\.cfg))$/.test(lower)) {
    categories.push("mutation-testing");
    categories.push("mutation-config");
  }
  if (/(?:^|\/)(?:mutation(?:[-_.](?:report|results?))?\.json|stryker[-_.](?:report|results?)\.json|mutations\.xml)$/.test(lower)) {
    categories.push("mutation-testing");
    categories.push("mutation-result");
  }
  if (/(?:^|\/)(?:\.github\/(?:dependabot|dependency-review-config)\.ya?ml|renovate(?:rc)?(?:\.json5?|\.ya?ml)|\.snyk|\.trivyignore|trivy\.ya?ml|grype\.ya?ml|osv-scanner\.toml)$/.test(lower)) {
    categories.push("dependency-vulnerabilities");
    categories.push("dependency-vulnerability-config");
  }
  if (/(?:^|\/)(?:npm-audit(?:[-_.](?:report|results?))?|pip-audit|osv-scanner(?:[-_.]results?)?|trivy(?:[-_.]results?)?|grype(?:[-_.]results?)?)\.json$/.test(lower)) {
    categories.push("dependency-vulnerabilities");
    categories.push("dependency-vulnerability-result");
  }
  if (/(?:^|\/)(?:codeowners|pull_request_template(?:\/[^/]+|\.[^/]+)?|merge_request_templates?\/[^/]+)$/i.test(filePath)) {
    categories.push("review-metadata");
  }
  if (/(?:^|\/)(?:\.github\/issue_template\/[^/]+|\.gitlab\/issue_templates\/[^/]+|jira[^/]*\.(?:json|ya?ml)|linear[^/]*\.(?:json|ya?ml))$/i.test(filePath)) {
    categories.push("work-item-metadata");
  }
  if (/(?:^|\/)(?:\.github\/workflows\/[^/]*(?:release|deploy|publish)[^/]*\.ya?ml|\.gitlab-ci\.ya?ml|helmfile\.ya?ml|chart\.ya?ml|deploy(?:ment)?\/[^/]+\.ya?ml|k8s\/[^/]+\.ya?ml|dockerfile|docker-compose\.ya?ml|release[^/]*\.json)$/i.test(filePath)) {
    categories.push("deployment-and-release");
  }
  if (lower === "package.json") categories.push("package-metadata");
  return uniqueSorted(categories);
}

function lintSurfaces(filePath, packageText = null) {
  const lower = filePath.toLowerCase();
  const surfaces = [];
  if (/eslint/.test(lower)) surfaces.push("ESLint");
  if (/tsconfig/.test(lower)) surfaces.push("TypeScript compiler");
  if (/pyright/.test(lower)) surfaces.push("pyright");
  if (/mypy/.test(lower)) surfaces.push("mypy");
  if (/ruff/.test(lower)) surfaces.push("Ruff");
  if (/checkstyle/.test(lower)) surfaces.push("Checkstyle");
  if (/detekt/.test(lower)) surfaces.push("Detekt");
  if (/sonar/.test(lower)) surfaces.push("Sonar");
  if (packageText !== null) {
    if (/\beslint\b/i.test(packageText)) surfaces.push("ESLint");
    if (/\btsc\b|\btypescript\b/i.test(packageText)) surfaces.push("TypeScript compiler");
  }
  return surfaces;
}

function parseSarif(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!isRecord(value) || value.version !== "2.1.0" || !Array.isArray(value.runs) || value.runs.length > MAX_SURFACES) return null;
  let resultCount = 0;
  const tools = [];
  const findings = { error_count: 0, warning_count: 0, info_count: 0 };
  for (const run of value.runs) {
    const name = run?.tool?.driver?.name;
    if (typeof name === "string" && name.length > 0 && name.length <= 256) tools.push(name);
    if (!Array.isArray(run?.results)) continue;
    resultCount += run.results.length;
    if (!Number.isSafeInteger(resultCount) || resultCount > MAX_NORMALIZED_FINDINGS) return null;
    for (const result of run.results) {
      const level = result?.level;
      if (level === "error") findings.error_count += 1;
      else if (level === "note" || level === "none") findings.info_count += 1;
      else findings.warning_count += 1;
    }
  }
  return { result_count: resultCount, tools: uniqueSorted(tools, MAX_SURFACES), findings };
}

function parseLintResult(filePath, bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  const lower = filePath.toLowerCase();
  const facts = { error_count: 0, warning_count: 0, info_count: 0 };
  if (/(?:^|\/)eslint/.test(lower)) {
    if (!Array.isArray(value) || value.length > MAX_NORMALIZED_FINDINGS) return null;
    for (const file of value) {
      if (!isRecord(file) || !Array.isArray(file.messages) || file.messages.length > MAX_NORMALIZED_FINDINGS) return null;
      for (const message of file.messages) {
        if (!isRecord(message) || !new Set([0, 1, 2]).has(message.severity)) return null;
        if (message.severity === 2) facts.error_count += 1;
        else if (message.severity === 1) facts.warning_count += 1;
        else facts.info_count += 1;
      }
    }
    return { ...facts, tool: "ESLint" };
  }
  if (/(?:^|\/)pyright/.test(lower)) {
    if (!isRecord(value) || !Array.isArray(value.generalDiagnostics) || value.generalDiagnostics.length > MAX_NORMALIZED_FINDINGS) return null;
    for (const diagnostic of value.generalDiagnostics) {
      if (!isRecord(diagnostic) || !new Set(["error", "warning", "information"]).has(diagnostic.severity)) return null;
      if (diagnostic.severity === "error") facts.error_count += 1;
      else if (diagnostic.severity === "warning") facts.warning_count += 1;
      else facts.info_count += 1;
    }
    return { ...facts, tool: "pyright" };
  }
  return null;
}

function parseMutation(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  const facts = { killed: 0, survived: 0 };
  const pending = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > MAX_MUTATION_NODES) return null;
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (!isRecord(current)) continue;
    if (typeof current.status === "string") {
      const normalized = current.status.toLowerCase();
      if (normalized === "killed") facts.killed += 1;
      else if (normalized === "survived") facts.survived += 1;
    }
    for (const child of Object.values(current)) pending.push(child);
  }
  const total = facts.killed + facts.survived;
  if (total === 0 || total > MAX_NORMALIZED_FINDINGS) return null;
  return { ...facts, total, score: Number((facts.killed / total).toFixed(8)) };
}

function parsePitMutation(bytes) {
  const text = bytes.toString("utf8");
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<mutations(?:\s|>)/i.test(text)) return null;
  const statuses = [...text.matchAll(/\bstatus\s*=\s*["'](KILLED|SURVIVED)["']/gi)];
  if (statuses.length === 0 || statuses.length > MAX_NORMALIZED_FINDINGS) return null;
  const killed = statuses.filter((match) => match[1].toUpperCase() === "KILLED").length;
  const survived = statuses.length - killed;
  return { killed, survived, total: statuses.length, score: Number((killed / statuses.length).toFixed(8)) };
}

function severityCounts() {
  return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
}

function recordSeverity(output, value) {
  const normalized = String(value ?? "unknown").toLowerCase();
  if (normalized === "critical") output.critical += 1;
  else if (normalized === "high") output.high += 1;
  else if (normalized === "medium" || normalized === "moderate") output.medium += 1;
  else if (normalized === "low") output.low += 1;
  else output.unknown += 1;
}

function parseDependencyVulnerabilities(filePath, bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  const lower = filePath.toLowerCase();
  const severities = severityCounts();
  let vulnerabilityCount = 0;
  let tool;
  if (/(?:^|\/)npm-audit(?:[-_.](?:report|results?))?\.json$/.test(lower)) {
    const counts = value?.metadata?.vulnerabilities;
    if (!isRecord(value) || value.auditReportVersion !== 2 || !isRecord(counts)) return null;
    const declared = [counts.critical, counts.high, counts.moderate, counts.low, counts.info, counts.total];
    if (!declared.every((count) => Number.isSafeInteger(count) && count >= 0)) return null;
    if (counts.total !== counts.critical + counts.high + counts.moderate + counts.low + counts.info || counts.total > MAX_NORMALIZED_FINDINGS) return null;
    Object.assign(severities, { critical: counts.critical, high: counts.high, medium: counts.moderate, low: counts.low, unknown: counts.info });
    vulnerabilityCount = counts.total;
    tool = "npm audit";
  } else if (/(?:^|\/)pip-audit\.json$/.test(lower)) {
    const dependencies = Array.isArray(value) ? value : value?.dependencies;
    if (!Array.isArray(dependencies) || dependencies.length > MAX_NORMALIZED_FINDINGS) return null;
    for (const dependency of dependencies) {
      if (!isRecord(dependency) || !Array.isArray(dependency.vulns)) return null;
      for (const vulnerability of dependency.vulns) {
        vulnerabilityCount += 1;
        recordSeverity(severities, vulnerability?.severity);
      }
    }
    tool = "pip-audit";
  } else if (/(?:^|\/)osv-scanner(?:[-_.]results?)?\.json$/.test(lower)) {
    if (!isRecord(value) || !Array.isArray(value.results)) return null;
    for (const result of value.results) {
      if (!isRecord(result) || !Array.isArray(result.packages)) return null;
      for (const packageResult of result.packages) {
        if (!isRecord(packageResult) || !Array.isArray(packageResult.vulnerabilities)) return null;
        for (const vulnerability of packageResult.vulnerabilities) {
          vulnerabilityCount += 1;
          recordSeverity(severities, vulnerability?.database_specific?.severity);
        }
      }
    }
    tool = "OSV-Scanner";
  } else if (/(?:^|\/)trivy(?:[-_.]results?)?\.json$/.test(lower)) {
    if (!isRecord(value) || !Array.isArray(value.Results)) return null;
    for (const result of value.Results) {
      if (!isRecord(result) || (result.Vulnerabilities !== undefined && !Array.isArray(result.Vulnerabilities))) return null;
      for (const vulnerability of result.Vulnerabilities ?? []) {
        vulnerabilityCount += 1;
        recordSeverity(severities, vulnerability?.Severity);
      }
    }
    tool = "Trivy";
  } else if (/(?:^|\/)grype(?:[-_.]results?)?\.json$/.test(lower)) {
    if (!isRecord(value) || !Array.isArray(value.matches)) return null;
    for (const match of value.matches) {
      if (!isRecord(match) || !isRecord(match.vulnerability)) return null;
      vulnerabilityCount += 1;
      recordSeverity(severities, match.vulnerability.severity);
    }
    tool = "Grype";
  } else return null;
  if (!Number.isSafeInteger(vulnerabilityCount) || vulnerabilityCount > MAX_NORMALIZED_FINDINGS) return null;
  return { vulnerability_count: vulnerabilityCount, severities, tool };
}

async function readSelected(index, selected, signal, telemetry) {
  const output = new Map();
  if (selected.length === 0) return output;
  const recordBytes = (entry, bytes) => {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BLOB_BYTES || telemetry.bytes_read + bytes.length > MAX_TOTAL_BYTES) {
      telemetry.blob_read_failures += 1;
      if (Buffer.isBuffer(bytes) && telemetry.bytes_read + bytes.length > MAX_TOTAL_BYTES) telemetry.total_byte_limit_reached = true;
      return;
    }
    output.set(entry.path, bytes);
    telemetry.blobs_read += 1;
    telemetry.bytes_read += bytes.length;
  };
  try {
    const read = await index.readBlobs(selected, {
      max_blob_bytes: MAX_BLOB_BYTES,
      max_total_bytes: MAX_TOTAL_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    if (typeof read?.get !== "function") throw new Error("blob reader did not return a map-like view");
    for (const entry of selected) {
      const bytes = read.get(entry.path);
      recordBytes(entry, bytes);
    }
    return output;
  } catch (error) {
    checkCancelled(signal);
    if (/CANCELLED/i.test(String(error?.message))) throw error;
  }
  for (const entry of selected) {
    checkCancelled(signal);
    if (telemetry.bytes_read + entry.byte_size > MAX_TOTAL_BYTES) {
      telemetry.blob_read_failures += 1;
      telemetry.total_byte_limit_reached = true;
      continue;
    }
    try {
      const read = await index.readBlobs([entry], {
        max_blob_bytes: MAX_BLOB_BYTES,
        max_total_bytes: MAX_BLOB_BYTES,
        ...(signal === undefined ? {} : { signal }),
      });
      if (typeof read?.get !== "function") throw new Error("blob reader did not return a map-like view");
      const bytes = read.get(entry.path);
      if (!Buffer.isBuffer(bytes)) throw new Error("blob was absent");
      recordBytes(entry, bytes);
    } catch (error) {
      checkCancelled(signal);
      if (/CANCELLED/i.test(String(error?.message))) throw error;
      telemetry.blob_read_failures += 1;
    }
  }
  return output;
}

function capability(id, state, configurationPaths, candidateResultPaths, acceptedResultPaths, rejectedArtifactCount, surfaces, facts, reason) {
  const evidencePaths = uniqueSorted([...configurationPaths, ...candidateResultPaths]);
  return {
    capability_id: id,
    state,
    execution: state === "OBSERVED" ? "OBSERVED" : "UNOBSERVED",
    evidence_path_count: evidencePaths.length,
    evidence_paths: evidencePaths.slice(0, MAX_EVIDENCE_PATHS),
    configuration_paths: uniqueSorted(configurationPaths, MAX_EVIDENCE_PATHS),
    result_paths: uniqueSorted(acceptedResultPaths, MAX_EVIDENCE_PATHS),
    rejected_artifact_count: rejectedArtifactCount,
    surfaces: uniqueSorted(surfaces, MAX_SURFACES),
    facts,
    reason,
  };
}

const CAPABILITY_IDS = Object.freeze([
  "dependency-manifests",
  "dependency-vulnerabilities",
  "deployment-and-release",
  "lint-and-typecheck",
  "mutation-testing",
  "review-metadata",
  "static-analysis-results",
  "work-item-metadata",
]);

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) fail(`${label} must be an array of nonempty strings`);
  if (new Set(value).size !== value.length || value.some((item, index) => index > 0 && stableCompare(value[index - 1], item) >= 0)) fail(`${label} must be unique and deterministically sorted`);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative safe integer`);
}

function assertCapabilityFacts(record) {
  if (record.facts === null) return;
  if (!isRecord(record.facts)) fail("projection capability facts must be a closed record or null");
  if (record.capability_id === "lint-and-typecheck") {
    assertClosed(record.facts, ["error_count", "warning_count", "info_count", "finding_count", "tools"], "lint facts");
    for (const field of ["error_count", "warning_count", "info_count", "finding_count"]) assertNonNegativeInteger(record.facts[field], `lint facts.${field}`);
    if (record.facts.finding_count !== record.facts.error_count + record.facts.warning_count + record.facts.info_count) fail("lint facts finding_count disagrees with severity counts");
    assertStringArray(record.facts.tools, "lint facts.tools");
    return;
  }
  if (record.capability_id === "static-analysis-results") {
    assertClosed(record.facts, ["result_count", "tools"], "static-analysis facts");
    assertNonNegativeInteger(record.facts.result_count, "static-analysis facts.result_count");
    assertStringArray(record.facts.tools, "static-analysis facts.tools");
    return;
  }
  if (record.capability_id === "mutation-testing") {
    assertClosed(record.facts, ["killed", "survived", "total", "score"], "mutation facts");
    for (const field of ["killed", "survived", "total"]) assertNonNegativeInteger(record.facts[field], `mutation facts.${field}`);
    if (record.facts.total !== record.facts.killed + record.facts.survived || typeof record.facts.score !== "number" || !Number.isFinite(record.facts.score) || record.facts.score < 0 || record.facts.score > 1) fail("mutation facts are inconsistent");
    return;
  }
  if (record.capability_id === "dependency-vulnerabilities") {
    assertClosed(record.facts, ["vulnerability_count", "severities", "tools"], "dependency-vulnerability facts");
    assertNonNegativeInteger(record.facts.vulnerability_count, "dependency-vulnerability facts.vulnerability_count");
    assertClosed(record.facts.severities, ["critical", "high", "medium", "low", "unknown"], "dependency-vulnerability severities");
    for (const severity of ["critical", "high", "medium", "low", "unknown"]) assertNonNegativeInteger(record.facts.severities[severity], `dependency-vulnerability severities.${severity}`);
    if (Object.values(record.facts.severities).reduce((sum, count) => sum + count, 0) !== record.facts.vulnerability_count) fail("dependency-vulnerability count disagrees with severity counts");
    assertStringArray(record.facts.tools, "dependency-vulnerability facts.tools");
    return;
  }
  fail(`projection capability ${record.capability_id} cannot carry result facts`);
}

async function discoverEngineeringEvidence(input) {
  assertClosed(input, ["repositoryIndex", "signal"], "input");
  if (!isRecord(input.repositoryIndex) || !isRecord(input.repositoryIndex.binding)
      || !Array.isArray(input.repositoryIndex.entries) || typeof input.repositoryIndex.readBlobs !== "function") {
    fail("repositoryIndex must be the immutable repository index public seam");
  }
  if (!FULL_REVISION.test(input.repositoryIndex.binding.repository_revision ?? "")
      || !DIGEST.test(input.repositoryIndex.binding.index_digest ?? "")) {
    fail("repository index binding is invalid");
  }
  if (input.repositoryIndex.entries.length > MAX_INDEX_ENTRIES) fail(`repository index exceeds ${MAX_INDEX_ENTRIES} entries`);
  if (input.signal !== undefined && !isAbortSignal(input.signal)) fail("signal must be an AbortSignal");
  checkCancelled(input.signal);

  const entries = [...input.repositoryIndex.entries].sort((left, right) => stableCompare(left?.path ?? "", right?.path ?? ""));
  const categoriesByPath = new Map();
  const pathsByCategory = new Map([
    ["dependency-manifests", []],
    ["lint-config", []],
    ["lint-result", []],
    ["static-analysis-config", []],
    ["static-analysis-result", []],
    ["mutation-config", []],
    ["mutation-result", []],
    ["dependency-vulnerability-config", []],
    ["dependency-vulnerability-result", []],
    ["review-metadata", []],
    ["work-item-metadata", []],
    ["deployment-and-release", []],
  ]);
  const contentCandidatePaths = new Set();
  const oversizedPaths = new Set();
  const indexedPaths = new Set();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.classifications)
        || !Array.isArray(entry.classifications.manifest_kinds)) fail("repository index entry shape is invalid");
    normalizedEntryPath(entry.path);
    if (indexedPaths.has(entry.path)) fail("repository index contains duplicate entry paths");
    indexedPaths.add(entry.path);
    if (!Number.isSafeInteger(entry.byte_size) || entry.byte_size < 0) fail("repository index entry byte_size is invalid");
    const categories = pathCategories(entry.path, entry.classifications.manifest_kinds);
    categoriesByPath.set(entry.path, categories);
    for (const category of categories) {
      if (pathsByCategory.has(category)) pathsByCategory.get(category).push(entry.path);
    }
    const deploymentContentCandidate = categories.includes("deployment-and-release")
      && /(?:^|\/)(?:\.github\/workflows\/|\.gitlab-ci\.ya?ml$)/i.test(entry.path);
    if (categories.some((category) => [
      "package-metadata", "lint-result", "static-analysis-result", "mutation-result", "dependency-vulnerability-result",
    ].includes(category)) || deploymentContentCandidate) {
      if (entry.byte_size > MAX_BLOB_BYTES) oversizedPaths.add(entry.path);
      else contentCandidatePaths.add(entry.path);
    }
  }
  for (const paths of pathsByCategory.values()) paths.sort(stableCompare);
  const isResultCandidate = (entry) => categoriesByPath.get(entry.path).some((category) => category.endsWith("-result"));
  const contentCandidates = entries
    .filter((entry) => contentCandidatePaths.has(entry.path))
    .sort((left, right) => Number(isResultCandidate(right)) - Number(isResultCandidate(left)) || stableCompare(left.path, right.path))
    .slice(0, MAX_CANDIDATES);
  const telemetry = {
    index_entries_examined: entries.length,
    repository_walks: 0,
    candidate_count: contentCandidatePaths.size,
    blobs_selected: contentCandidates.length,
    blobs_read: 0,
    bytes_read: 0,
    blob_read_failures: 0,
    oversized_candidates: oversizedPaths.size,
    candidate_limit_reached: contentCandidatePaths.size > contentCandidates.length,
    total_byte_limit_reached: false,
  };
  const bytesByPath = await readSelected(input.repositoryIndex, contentCandidates, input.signal, telemetry);
  checkCancelled(input.signal);

  const lintConfigurationPaths = [...pathsByCategory.get("lint-config")];
  const lintCandidateResultPaths = pathsByCategory.get("lint-result");
  const lintAcceptedResultPaths = [];
  const lintSurfaceValues = lintConfigurationPaths.flatMap((filePath) => lintSurfaces(filePath));
  const staticConfigurationPaths = [...pathsByCategory.get("static-analysis-config")];
  const staticConfigurationSurfaces = [];
  const mutationConfigurationPaths = [...pathsByCategory.get("mutation-config")];
  const mutationConfigurationSurfaces = [];
  const dependencyVulnerabilityConfigurationPaths = [...pathsByCategory.get("dependency-vulnerability-config")];
  const dependencyVulnerabilityConfigurationSurfaces = [];
  const lintFacts = { error_count: 0, warning_count: 0, info_count: 0, finding_count: 0, tools: [] };
  let lintRejected = 0;
  for (const [filePath, bytes] of bytesByPath) {
    if (categoriesByPath.get(filePath)?.includes("package-metadata")) {
      const text = bytes.toString("utf8");
      const packageSurfaces = lintSurfaces(filePath, text);
      if (packageSurfaces.length > 0) {
        lintConfigurationPaths.push(filePath);
        lintSurfaceValues.push(...packageSurfaces);
      }
      let parsedPackage;
      try { parsedPackage = JSON.parse(text); } catch { parsedPackage = null; }
      const scriptCommands = isRecord(parsedPackage?.scripts)
        ? Object.values(parsedPackage.scripts).filter((command) => typeof command === "string")
        : [];
      const scriptsText = scriptCommands.join("\n");
      for (const [patterns, paths, surfaces] of [
        [[[/\b(?:semgrep|codeql|sonar-scanner)\b/i, "Static-analysis script"]], staticConfigurationPaths, staticConfigurationSurfaces],
        [[[/\bstryker\b/i, "Stryker"], [/\b(?:pitest|mutmut)\b/i, "Mutation-testing script"]], mutationConfigurationPaths, mutationConfigurationSurfaces],
        [[[/\b(?:npm|pnpm|yarn)\s+audit\b/i, "Package audit"], [/\b(?:pip-audit|osv-scanner|trivy|grype|snyk)\b/i, "Dependency-vulnerability scanner"]], dependencyVulnerabilityConfigurationPaths, dependencyVulnerabilityConfigurationSurfaces],
      ]) {
        const matched = patterns.filter(([pattern]) => pattern.test(scriptsText)).map(([, surface]) => surface);
        if (matched.length > 0) {
          paths.push(filePath);
          surfaces.push(...matched);
        }
      }
    }
  }
  for (const filePath of lintCandidateResultPaths) {
    const bytes = bytesByPath.get(filePath);
    const parsed = bytes ? parseLintResult(filePath, bytes) : null;
    if (parsed === null) {
      lintRejected += 1;
      continue;
    }
    lintAcceptedResultPaths.push(filePath);
    for (const field of ["error_count", "warning_count", "info_count"]) lintFacts[field] += parsed[field];
    lintFacts.tools.push(parsed.tool);
  }

  let sarifResultCount = 0;
  const sarifTools = [];
  const sarifPaths = pathsByCategory.get("static-analysis-result");
  const acceptedSarifPaths = [];
  let sarifRejected = 0;
  for (const filePath of sarifPaths) {
    const bytes = bytesByPath.get(filePath);
    const parsed = bytes ? parseSarif(bytes) : null;
    if (parsed === null) {
      sarifRejected += 1;
      continue;
    }
    acceptedSarifPaths.push(filePath);
    sarifResultCount += parsed.result_count;
    sarifTools.push(...parsed.tools);
    if (parsed.tools.some((tool) => /^(?:eslint|mypy|pyright|ruff|checkstyle|detekt|typescript(?: compiler)?|tsc)$/i.test(tool))) {
      lintAcceptedResultPaths.push(filePath);
      lintFacts.error_count += parsed.findings.error_count;
      lintFacts.warning_count += parsed.findings.warning_count;
      lintFacts.info_count += parsed.findings.info_count;
      lintFacts.tools.push(...parsed.tools);
    }
  }
  lintFacts.finding_count = lintFacts.error_count + lintFacts.warning_count + lintFacts.info_count;
  lintFacts.tools = uniqueSorted(lintFacts.tools, MAX_SURFACES);

  let mutationFacts = null;
  const mutationCandidateResultPaths = pathsByCategory.get("mutation-result");
  const mutationAcceptedResultPaths = [];
  let mutationRejected = 0;
  for (const filePath of mutationCandidateResultPaths) {
    const bytes = bytesByPath.get(filePath);
    const parsed = bytes
      ? (/\.xml$/i.test(filePath) ? parsePitMutation(bytes) : parseMutation(bytes))
      : null;
    if (parsed === null) {
      mutationRejected += 1;
      continue;
    }
    mutationAcceptedResultPaths.push(filePath);
    if (mutationFacts === null) mutationFacts = { killed: 0, survived: 0, total: 0, score: 0 };
    mutationFacts.killed += parsed.killed;
    mutationFacts.survived += parsed.survived;
    mutationFacts.total += parsed.total;
  }
  if (mutationFacts !== null) mutationFacts.score = Number((mutationFacts.killed / mutationFacts.total).toFixed(8));

  const dependencyVulnerabilityCandidateResultPaths = pathsByCategory.get("dependency-vulnerability-result");
  const dependencyVulnerabilityAcceptedResultPaths = [];
  const dependencyVulnerabilityFacts = { vulnerability_count: 0, severities: severityCounts(), tools: [] };
  let dependencyVulnerabilityRejected = 0;
  for (const filePath of dependencyVulnerabilityCandidateResultPaths) {
    const bytes = bytesByPath.get(filePath);
    const parsed = bytes ? parseDependencyVulnerabilities(filePath, bytes) : null;
    if (parsed === null) {
      dependencyVulnerabilityRejected += 1;
      continue;
    }
    dependencyVulnerabilityAcceptedResultPaths.push(filePath);
    dependencyVulnerabilityFacts.vulnerability_count += parsed.vulnerability_count;
    for (const severity of Object.keys(dependencyVulnerabilityFacts.severities)) {
      dependencyVulnerabilityFacts.severities[severity] += parsed.severities[severity];
    }
    dependencyVulnerabilityFacts.tools.push(parsed.tool);
  }
  dependencyVulnerabilityFacts.tools = uniqueSorted(dependencyVulnerabilityFacts.tools, MAX_SURFACES);

  const deploymentPaths = pathsByCategory.get("deployment-and-release");
  const deploymentSurfaces = [];
  for (const filePath of deploymentPaths) {
    const lower = filePath.toLowerCase();
    if (lower.includes("k8s") || lower.includes("deployment")) deploymentSurfaces.push("Kubernetes");
    if (lower.includes("helm") || lower.endsWith("chart.yaml")) deploymentSurfaces.push("Helm");
    const text = bytesByPath.get(filePath)?.toString("utf8") ?? "";
    if (/\bnpm\s+publish\b|\brelease\b/i.test(text)) deploymentSurfaces.push("Package release workflow");
    if (/\bdeploy\b/i.test(text)) deploymentSurfaces.push("Deployment workflow");
  }

  const configuredOrUnavailable = (id, configurationPaths, candidateResultPaths = [], rejectedArtifactCount = 0, surfaces = []) => (
    configurationPaths.length > 0 || candidateResultPaths.length > 0
      ? capability(id, "CONFIGURED", uniqueSorted(configurationPaths), uniqueSorted(candidateResultPaths), [], rejectedArtifactCount, surfaces, null, "supported committed configuration or result candidates were observed, but authoritative result facts could not be normalized")
      : capability(id, "UNAVAILABLE", [], [], [], 0, [], null, "no supported committed evidence was observed at the resolved revision")
  );
  const lintResultEvidence = uniqueSorted([...lintCandidateResultPaths, ...sarifPaths.filter((filePath) => lintAcceptedResultPaths.includes(filePath))]);
  const lintAcceptedEvidence = uniqueSorted(lintAcceptedResultPaths);
  const capabilities = [
    configuredOrUnavailable("dependency-manifests", pathsByCategory.get("dependency-manifests")),
    dependencyVulnerabilityAcceptedResultPaths.length > 0
      ? capability("dependency-vulnerabilities", "OBSERVED", dependencyVulnerabilityConfigurationPaths, dependencyVulnerabilityCandidateResultPaths, dependencyVulnerabilityAcceptedResultPaths, dependencyVulnerabilityRejected, [...dependencyVulnerabilityConfigurationSurfaces, ...dependencyVulnerabilityFacts.tools], dependencyVulnerabilityFacts, "authoritative committed dependency-vulnerability result facts were normalized; cross-tool findings are observations and are not deduplicated or treated as current repository health")
      : configuredOrUnavailable("dependency-vulnerabilities", dependencyVulnerabilityConfigurationPaths, dependencyVulnerabilityCandidateResultPaths, dependencyVulnerabilityRejected, dependencyVulnerabilityConfigurationSurfaces),
    configuredOrUnavailable("deployment-and-release", deploymentPaths, [], 0, deploymentSurfaces),
    lintAcceptedEvidence.length > 0
      ? capability("lint-and-typecheck", "OBSERVED", lintConfigurationPaths, lintResultEvidence, lintAcceptedEvidence, lintRejected, [...lintSurfaceValues, ...lintFacts.tools], lintFacts, "authoritative committed lint or typecheck result facts were normalized; findings are tool output and do not imply current CI health")
      : configuredOrUnavailable("lint-and-typecheck", lintConfigurationPaths, lintResultEvidence, lintRejected, lintSurfaceValues),
    mutationFacts === null
      ? configuredOrUnavailable("mutation-testing", mutationConfigurationPaths, mutationCandidateResultPaths, mutationRejected, mutationConfigurationSurfaces)
      : capability("mutation-testing", "OBSERVED", mutationConfigurationPaths, mutationCandidateResultPaths, mutationAcceptedResultPaths, mutationRejected, mutationConfigurationSurfaces, mutationFacts, "committed mutation-testing result facts were normalized; their freshness beyond the bound revision is not inferred"),
    configuredOrUnavailable("review-metadata", pathsByCategory.get("review-metadata")),
    acceptedSarifPaths.length > 0
      ? capability("static-analysis-results", "OBSERVED", staticConfigurationPaths, sarifPaths, acceptedSarifPaths, sarifRejected, [...staticConfigurationSurfaces, ...sarifTools], { result_count: sarifResultCount, tools: uniqueSorted(sarifTools) }, "committed SARIF facts were normalized; findings are tool output rather than SEI defect claims")
      : configuredOrUnavailable("static-analysis-results", staticConfigurationPaths, sarifPaths, sarifRejected, staticConfigurationSurfaces),
    configuredOrUnavailable("work-item-metadata", pathsByCategory.get("work-item-metadata")),
  ].sort((left, right) => stableCompare(left.capability_id, right.capability_id));

  return deepFreeze({
    discovery_version: AUTONOMOUS_EVIDENCE_VERSION,
    repository_revision: input.repositoryIndex.binding.repository_revision,
    repository_index_digest: input.repositoryIndex.binding.index_digest,
    capabilities,
    telemetry,
  });
}

function projectEngineeringEvidence(input) {
  assertClosed(input, ["discovery", "configuration_hash", "history_window"], "projection input");
  const discovery = input.discovery;
  if (!isRecord(discovery) || discovery.discovery_version !== AUTONOMOUS_EVIDENCE_VERSION
      || !FULL_REVISION.test(discovery.repository_revision ?? "") || !DIGEST.test(discovery.repository_index_digest ?? "")
      || !Array.isArray(discovery.capabilities)) fail("projection discovery is not a canonical autonomous-evidence result");
  assertClosed(discovery, ["discovery_version", "repository_revision", "repository_index_digest", "capabilities", "telemetry"], "projection discovery");
  assertClosed(discovery.telemetry, ["index_entries_examined", "repository_walks", "candidate_count", "blobs_selected", "blobs_read", "bytes_read", "blob_read_failures", "oversized_candidates", "candidate_limit_reached", "total_byte_limit_reached"], "projection discovery.telemetry");
  for (const field of ["index_entries_examined", "repository_walks", "candidate_count", "blobs_selected", "blobs_read", "bytes_read", "blob_read_failures", "oversized_candidates"]) {
    assertNonNegativeInteger(discovery.telemetry[field], `projection discovery.telemetry.${field}`);
  }
  if (typeof discovery.telemetry.candidate_limit_reached !== "boolean" || typeof discovery.telemetry.total_byte_limit_reached !== "boolean") fail("projection discovery telemetry limit flags must be boolean");
  if (!CONFIGURATION_HASH.test(input.configuration_hash ?? "")) fail("projection configuration_hash must be a lowercase SHA-256 digest");
  assertClosed(input.history_window, ["kind", "start", "end"], "projection history_window");
  if (!new Set(["revision", "revision-range"]).has(input.history_window.kind)
      || input.history_window.end !== discovery.repository_revision
      || (input.history_window.start !== null && !FULL_REVISION.test(input.history_window.start ?? ""))) {
    fail("projection history_window must be revision-bound to the discovery result");
  }
  const collectors = [];
  const metrics = [];
  const capabilityIds = new Set();
  for (const record of discovery.capabilities) {
    assertClosed(record, ["capability_id", "state", "execution", "evidence_path_count", "evidence_paths", "configuration_paths", "result_paths", "rejected_artifact_count", "surfaces", "facts", "reason"], "projection capability");
    if (!isRecord(record) || typeof record.capability_id !== "string"
        || !new Set(["CONFIGURED", "OBSERVED", "UNAVAILABLE"]).has(record.state)
        || !Number.isSafeInteger(record.evidence_path_count) || record.evidence_path_count < 0
        || !Array.isArray(record.evidence_paths) || !Array.isArray(record.configuration_paths) || !Array.isArray(record.result_paths) || !Array.isArray(record.surfaces)
        || !Number.isSafeInteger(record.rejected_artifact_count) || record.rejected_artifact_count < 0
        || typeof record.reason !== "string") fail("projection capability record is invalid");
    if (!CAPABILITY_IDS.includes(record.capability_id) || capabilityIds.has(record.capability_id)) fail("projection capability id is unknown or duplicated");
    capabilityIds.add(record.capability_id);
    for (const [value, label] of [[record.evidence_paths, "evidence_paths"], [record.configuration_paths, "configuration_paths"], [record.result_paths, "result_paths"], [record.surfaces, "surfaces"]]) assertStringArray(value, `projection capability.${label}`);
    if (record.evidence_paths.length > MAX_EVIDENCE_PATHS || record.configuration_paths.length > MAX_EVIDENCE_PATHS || record.result_paths.length > MAX_EVIDENCE_PATHS || record.surfaces.length > MAX_SURFACES) fail("projection capability exceeds serialized evidence bounds");
    if ((record.state === "OBSERVED") !== (record.execution === "OBSERVED") || (record.state !== "OBSERVED" && record.execution !== "UNOBSERVED")) fail("projection capability execution disagrees with state");
    if (record.state === "OBSERVED" && (record.result_paths.length === 0 || record.facts === null)) fail("observed projection capability requires accepted result provenance and facts");
    if (record.state !== "OBSERVED" && (record.result_paths.length > 0 || record.facts !== null)) fail("unobserved projection capability cannot carry accepted result facts");
    if (record.state === "UNAVAILABLE" && record.evidence_path_count !== 0) fail("unavailable projection capability cannot claim evidence paths");
    assertCapabilityFacts(record);
    const collectorId = `autonomous-${record.capability_id}`;
    const analyzerIdentity = `sei.autonomous.${record.capability_id}@2`;
    const available = record.state === "OBSERVED";
    const observed = record.state !== "UNAVAILABLE";
    collectors.push({
      collector_id: collectorId,
      collector_version: "2.0.0",
      status: available ? "available" : observed ? "degraded" : "unavailable",
      analyzer_identity: analyzerIdentity,
      analyzer_version: "2.0.0",
      reason: available ? null : record.reason,
    });
    const fallbackRef = `discovery-state:${record.capability_id}:${record.state.toLowerCase()}`;
    const evidenceRefs = uniqueSorted([
      ...record.surfaces.map((surface) => `engineering-surface:${surface}`),
      ...record.result_paths.map((resultPath) => `accepted-result:${resultPath}`),
    ], MAX_EVIDENCE_PATHS - 1);
    evidenceRefs.unshift(`repository-index:${discovery.repository_index_digest}`);
    metrics.push({
      metric_id: `discovery.engineering.${record.capability_id}_evidence_path_count`,
      definition_id: `sei.discovery.engineering.${record.capability_id}_evidence_path_count@1`,
      family: "engineering_evidence_discovery",
      subject: "repository:revision-bound-engineering-evidence",
      repository_revision: discovery.repository_revision,
      value: observed ? record.evidence_path_count : null,
      unit: "paths",
      measurement: { status: observed ? "measured" : "unavailable", completeness: observed ? 1 : 0, confidence: observed ? 1 : 0, reason: record.reason },
      source: {
        kind: "revision-bound-index-discovery",
        collector_id: collectorId,
        collector_version: "2.0.0",
        repository_revision: discovery.repository_revision,
        command: null,
        artifact_refs: record.evidence_paths.length > 0 ? record.evidence_paths.slice(0, MAX_EVIDENCE_PATHS) : [fallbackRef],
        evidence_refs: evidenceRefs.length > 1 ? evidenceRefs : [evidenceRefs[0], fallbackRef],
      },
      scope: { kind: "repository", path: ".", language: null, generated_code: false, included_in_human_maintainability: false },
      window: structuredClone(input.history_window),
      analyzer_identity: analyzerIdentity,
      analyzer_version: "2.0.0",
      comparability: {
        analyzer_identity: analyzerIdentity,
        analyzer_version: "2.0.0",
        configuration_hash: input.configuration_hash,
        compatible_with_prior: false,
        reason: "no prior analyzer-bound autonomous-discovery measurement was supplied",
      },
    });
  }
  if (capabilityIds.size !== CAPABILITY_IDS.length || CAPABILITY_IDS.some((id) => !capabilityIds.has(id))) fail("projection discovery capability set is incomplete");
  collectors.sort((left, right) => stableCompare(left.collector_id, right.collector_id));
  metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  return deepFreeze({ collectors, metrics, discovery });
}

// This bridge turns only facts already observed by the revision-bound local
// discovery pass into assessment measurements. It is deliberately narrower
// than the caller-supplied assessment-evidence adapter: a configured scanner
// can establish that a capability exists, but cannot be treated as an
// observed result. External operational, recovery, secret-scan, and human
// feedback facts remain unavailable unless an explicitly bound adapter supplies
// them.
function deriveAssessmentEvidence(input = {}) {
  assertClosed(input, ["discovery", "projected", "execution", "configuration_hash", "history_window"], "assessment bridge input");
  const { discovery, projected } = input;
  if (!isRecord(discovery) || discovery.discovery_version !== AUTONOMOUS_EVIDENCE_VERSION
      || !FULL_REVISION.test(discovery.repository_revision ?? "") || !DIGEST.test(discovery.repository_index_digest ?? "")
      || !Array.isArray(discovery.capabilities)) fail("assessment bridge discovery is not canonical");
  if (!isRecord(projected) || !Array.isArray(projected.metrics) || !Array.isArray(projected.collectors)) fail("assessment bridge projected evidence is not canonical");
  if (!CONFIGURATION_HASH.test(input.configuration_hash ?? "")) fail("assessment bridge configuration_hash is invalid");
  assertClosed(input.history_window, ["kind", "start", "end"], "assessment bridge history_window");
  if (!new Set(["revision", "revision-range"]).has(input.history_window.kind)
      || input.history_window.end !== discovery.repository_revision
      || (input.history_window.start !== null && !FULL_REVISION.test(input.history_window.start ?? ""))) {
    fail("assessment bridge history_window is not revision-bound");
  }

  const capabilities = new Map(discovery.capabilities.map((capability) => [capability.capability_id, capability]));
  const metrics = new Map(projected.metrics.map((metric) => [metric.metric_id, metric]));
  const derived = [];
  const add = ({ metric_id, value, unit, capability, coverage, confidence, reason }) => {
    if (value === null || value === undefined) return;
    const evidenceRefs = uniqueSorted([
      `repository-index:${discovery.repository_index_digest}`,
      ...(capability?.evidence_paths ?? []).map((path) => `evidence-path:${path}`),
      ...(capability?.result_paths ?? []).map((path) => `accepted-result:${path}`),
      ...(capability?.surfaces ?? []).map((surface) => `engineering-surface:${surface}`),
    ]);
    if (evidenceRefs.length === 0) return;
    derived.push({
      metric_id,
      definition_id: `sei.${metric_id}@1`,
      family: "assessment_local_discovery",
      subject: "repository:revision-bound-local-assessment",
      repository_revision: discovery.repository_revision,
      value,
      unit,
      measurement: {
        status: "measured",
        completeness: coverage,
        confidence,
        reason: reason ?? null,
      },
      source: {
        kind: "revision-bound-local-assessment-discovery",
        collector_id: "assessment-local-discovery",
        collector_version: "1.0.0",
        repository_revision: discovery.repository_revision,
        command: null,
        artifact_refs: (capability?.evidence_paths ?? []).slice(0, MAX_EVIDENCE_PATHS),
        evidence_refs: evidenceRefs,
      },
      scope: { kind: "repository", path: ".", language: null, generated_code: false, included_in_human_maintainability: false },
      window: structuredClone(input.history_window),
      analyzer_identity: "sei.autonomous-assessment-discovery@1",
      analyzer_version: "1.0.0",
      comparability: {
        analyzer_identity: "sei.autonomous-assessment-discovery@1",
        analyzer_version: "1.0.0",
        configuration_hash: input.configuration_hash,
        compatible_with_prior: false,
        reason: "local assessment fact is bound to the current revision and immutable repository index",
      },
    });
  };

  const deployment = capabilities.get("deployment-and-release");
  if (deployment && deployment.state !== "UNAVAILABLE") {
    const configuredOnly = deployment.state !== "OBSERVED";
    add({
      metric_id: "assessment.delivery.release_configuration",
      value: 1,
      unit: "ratio",
      capability: deployment,
      coverage: configuredOnly ? 0.5 : 1,
      confidence: configuredOnly ? 0.5 : 1,
      reason: configuredOnly ? "release/deployment configuration was observed without an authoritative result" : "committed release/deployment evidence was observed",
    });
  }

  const staticAnalysis = capabilities.get("static-analysis-results");
  const securitySurface = staticAnalysis?.surfaces?.some((surface) => /codeql|semgrep|sonar|gitleaks|secret|security/i.test(surface)) === true;
  if (staticAnalysis && securitySurface && staticAnalysis.state !== "UNAVAILABLE") {
    const configuredOnly = staticAnalysis.state !== "OBSERVED";
    add({
      metric_id: "assessment.security.verification",
      value: 1,
      unit: "ratio",
      capability: staticAnalysis,
      coverage: configuredOnly ? 0.5 : 1,
      confidence: configuredOnly ? 0.5 : 1,
      reason: configuredOnly ? "security analysis was configured without an accepted result" : "committed security analysis result was observed",
    });
  }

  const vulnerabilities = capabilities.get("dependency-vulnerabilities");
  if (vulnerabilities?.state === "OBSERVED" && isRecord(vulnerabilities.facts)
      && Number.isSafeInteger(vulnerabilities.facts.vulnerability_count)) {
    add({
      metric_id: "assessment.security.dependency_hygiene",
      value: vulnerabilities.facts.vulnerability_count === 0 ? 1 : 0,
      unit: "ratio",
      capability: vulnerabilities,
      coverage: 1,
      confidence: 1,
      reason: "committed dependency-vulnerability result was normalized; zero means no findings in that bound result",
    });
  }

  const chooseExecutionMetric = (autonomousId, committedId) => {
    const autonomous = metrics.get(autonomousId);
    if (autonomous && autonomous.measurement?.status !== "unavailable") return autonomous;
    return metrics.get(committedId);
  };
  const testsTotal = chooseExecutionMetric("verification.autonomous_tests_total", "verification.tests_total");
  const testsPassed = chooseExecutionMetric("verification.autonomous_tests_passed", "verification.tests_passed");
  if (testsTotal && testsPassed && Number.isFinite(testsTotal.value) && Number.isFinite(testsPassed.value)
      && testsTotal.value > 0 && testsPassed.value >= 0 && testsPassed.value <= testsTotal.value
      && testsTotal.measurement.status !== "unavailable" && testsPassed.measurement.status !== "unavailable") {
    const coverage = Math.min(testsTotal.measurement.completeness, testsPassed.measurement.completeness);
    const confidence = Math.min(testsTotal.measurement.confidence, testsPassed.measurement.confidence);
    add({
      metric_id: "assessment.verification.change_verification",
      value: Number((testsPassed.value / testsTotal.value).toFixed(8)),
      unit: "ratio",
      capability: {
        evidence_paths: input.execution?.artifact_ref ? [input.execution.artifact_ref] : [],
        result_paths: input.execution?.artifact_ref ? [input.execution.artifact_ref] : [],
        surfaces: ["autonomous test execution"],
      },
      coverage,
      confidence,
      reason: "revision-bound test outcome facts were normalized into a passed-test ratio",
    });
    add({
      metric_id: "assessment.developer.local_feedback",
      value: testsPassed.value === testsTotal.value ? 1 : 0,
      unit: "ratio",
      capability: {
        evidence_paths: input.execution?.artifact_ref ? [input.execution.artifact_ref] : [],
        result_paths: input.execution?.artifact_ref ? [input.execution.artifact_ref] : [],
        surfaces: ["autonomous test execution"],
      },
      coverage,
      confidence,
      reason: "revision-bound local test execution produced direct developer feedback",
    });
  }

  const lint = capabilities.get("lint-and-typecheck");
  if (lint && lint.state !== "UNAVAILABLE") {
    const configuredOnly = lint.state !== "OBSERVED";
    add({
      metric_id: "assessment.developer.local_feedback",
      value: 1,
      unit: "ratio",
      capability: lint,
      coverage: configuredOnly ? 0.5 : 1,
      confidence: configuredOnly ? 0.5 : 1,
      reason: configuredOnly ? "local lint/typecheck feedback was configured without an accepted result" : "committed lint/typecheck result was observed",
    });
  }

  const unique = new Map();
  for (const metric of derived) if (!unique.has(metric.metric_id)) unique.set(metric.metric_id, metric);
  const outputMetrics = [...unique.values()].sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  return deepFreeze({
    discovery_version: "sei.autonomous-assessment-discovery@1",
    repository_revision: discovery.repository_revision,
    repository_index_digest: discovery.repository_index_digest,
    collectors: outputMetrics.length === 0 ? [] : [{
      collector_id: "assessment-local-discovery",
      collector_version: "1.0.0",
      status: "degraded",
      analyzer_identity: "sei.autonomous-assessment-discovery@1",
      analyzer_version: "1.0.0",
      reason: "local facts are bounded repository evidence; external operational and human evidence remains separate",
    }],
    metrics: outputMetrics,
  });
}

module.exports = {
  AUTONOMOUS_EVIDENCE_VERSION,
  discoverEngineeringEvidence,
  projectEngineeringEvidence,
};

module.exports[Symbol.for("sei.autonomous-evidence.assessment.private.v1")] = Object.freeze({ deriveAssessmentEvidence });
