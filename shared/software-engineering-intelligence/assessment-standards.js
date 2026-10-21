"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STANDARD_RESOLUTION_VERSION = "sei.assessment-standard-resolution@1";
const MARK_SOURCE_DIGEST = "sha256:324fa3b9a139a0b96f4fe333142d45f55e29c3882c2c0994357c2a1b7b7c7122";

function stableCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function freeze(value) {
  if (Array.isArray(value)) value.forEach(freeze);
  else if (value && typeof value === "object") Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const MARK_ENGINEERING_STANDARD = freeze({
  standard_id: "mark-engineering-standard",
  standard_version: "2026.08.13",
  label: "Mark Engineering Standard",
  source: {
    kind: "bundled-pinned-profile",
    path_hint: "docs/programming-guidelines.md",
    digest: MARK_SOURCE_DIGEST,
    headings: ["Architecture", "Code Quality", "Testing", "Delivery", "Security", "Documentation"],
  },
  global_rules: [
    "prefer explicit ownership boundaries",
    "keep automation and verification reproducible",
    "preserve evidence for operational and security claims",
  ],
  applicability: {
    eilixa_specific: [
      { when: "repository_name_matches_project_eilixa", include: ["architecture.module_boundary_coherence", "documentation.contracts_runbooks"] },
    ],
  },
  criterion_mappings: {
    module_boundary_coherence: ["Architecture"],
    ci_prerequisites: ["Delivery"],
    contracts_and_runbooks: ["Documentation"],
    secrets_and_configuration: ["Security"],
    test_execution: ["Testing"],
  },
});

const SEI_DEFAULT_ENGINEERING_STANDARD = freeze({
  standard_id: "sei-default-engineering-standard",
  standard_version: "1.0.0",
  label: "SEI Default Engineering Standard",
  source: {
    kind: "bundled-default-profile",
    path_hint: null,
    digest: "sha256:0d26df4f3a3e90be496eca13bbb76a3d56d223bd48ce9c81611eb6c9a828d33d",
    headings: ["Evidence-backed engineering assessment"],
  },
  global_rules: [
    "do not convert unavailable evidence into a failure",
    "keep score, coverage, confidence, and maturity distinct",
  ],
  applicability: { eilixa_specific: [] },
  criterion_mappings: {},
});

const STANDARD_ALIASES = Object.freeze({
  mark: MARK_ENGINEERING_STANDARD,
  "mark-engineering-standard": MARK_ENGINEERING_STANDARD,
  "sei-default": SEI_DEFAULT_ENGINEERING_STANDARD,
  "sei-default-engineering-standard": SEI_DEFAULT_ENGINEERING_STANDARD,
});

function fail(message) {
  throw new Error(`FAIL-ASSESSMENT-STANDARD-PROFILE: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedStandardName(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_]+/g, "-") : null;
}

function nonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function jsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, seen));
  if (!isRecord(value) || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).every((item) => jsonValue(item, seen));
}

function customStandard(value, source) {
  if (!isRecord(value) || !nonBlankString(value.standard_id) || !nonBlankString(value.standard_version)) {
    fail(`${source} custom standard requires standard_id and standard_version`);
  }
  if (!isRecord(value.source) || !nonBlankString(value.source.kind) || !nonBlankString(value.source.digest) || !/^sha256:[a-f0-9]{64}$/.test(value.source.digest)) {
    fail(`${source} custom standard requires a pinned sha256 source digest`);
  }
  if (!jsonValue(value)) fail(`${source} custom standard must be deterministic JSON data`);
  return freeze(structuredClone(value));
}

function parseProfile(value, source) {
  if (!isRecord(value) || !Object.hasOwn(value, "standard")) fail(`${source} must contain a standard selector`);
  if (isRecord(value.standard)) return customStandard(value.standard, source);
  const selector = normalizedStandardName(value.standard);
  if (!selector || !Object.hasOwn(STANDARD_ALIASES, selector)) fail(`${source} selects an unknown standard`);
  return STANDARD_ALIASES[selector];
}

function standardDigest(standard) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(standard)).digest("hex")}`;
}

function repositoryProfile(repositoryRoot, readFile) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "") return null;
  const profilePath = path.join(repositoryRoot, ".sei", "assessment-profile.json");
  try {
    const payload = readFile(profilePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      fail(`repository profile ${profilePath} is not valid JSON`);
    }
    return { standard: parseProfile(parsed, `repository profile ${profilePath}`), path: profilePath };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolve assessment policy without consulting or changing the optional
 * programming-guidelines source-adoption evaluator. The result is immutable
 * data suitable for binding into a content-addressed assessment sidecar.
 */
function resolveAssessmentStandard({ assessmentConfig = null, repositoryRoot = null, readFile = fs.readFileSync } = {}) {
  if (assessmentConfig !== null && assessmentConfig !== undefined) {
    const standard = parseProfile(assessmentConfig, "explicit assessment configuration");
    return freeze({
      schema_version: STANDARD_RESOLUTION_VERSION,
      resolution: "explicit_config",
      standard,
      standard_digest: standardDigest(standard),
      source: { kind: "explicit_config", path: null },
    });
  }

  const profile = repositoryProfile(repositoryRoot, readFile);
  if (profile) {
    return freeze({
      schema_version: STANDARD_RESOLUTION_VERSION,
      resolution: "repository_profile",
      standard: profile.standard,
      standard_digest: standardDigest(profile.standard),
      source: { kind: "repository_profile", path: profile.path },
    });
  }

  return freeze({
    schema_version: STANDARD_RESOLUTION_VERSION,
    resolution: "bundled_mark",
    standard: MARK_ENGINEERING_STANDARD,
    standard_digest: standardDigest(MARK_ENGINEERING_STANDARD),
    source: { kind: "bundled_mark", path: null },
  });
}

module.exports = {
  MARK_ENGINEERING_STANDARD,
  MARK_SOURCE_DIGEST,
  SEI_DEFAULT_ENGINEERING_STANDARD,
  STANDARD_RESOLUTION_VERSION,
  resolveAssessmentStandard,
};
