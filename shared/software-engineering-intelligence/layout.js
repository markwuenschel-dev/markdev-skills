"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKILL_NAME = "software-engineering-intelligence";
const SHARED_NAME = "shared/software-engineering-intelligence";

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function realDirectory(target, label) {
  if (typeof target !== "string" || target.length === 0) {
    fail("FAIL-SEI-LAYOUT-PATH", `${label} must be a non-empty path`);
  }
  let resolved;
  try {
    resolved = fs.realpathSync.native(target);
  } catch (error) {
    fail("FAIL-SEI-LAYOUT-PATH", `${label} cannot be resolved (${error.code ?? error.message})`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    fail("FAIL-SEI-LAYOUT-PATH", `${label} is not a directory`);
  }
  return resolved;
}

function existingFile(root, relativePath, label) {
  const resolved = path.join(root, ...relativePath.split("/"));
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    fail("FAIL-SEI-LAYOUT-FILE", `${label} is missing: ${relativePath}`);
  }
  return resolved;
}

function loadRegistry(skillsRoot) {
  const registryPath = existingFile(skillsRoot, "shared/capability-registry/registry.js", "capability registry");
  let registry;
  try {
    registry = require(registryPath);
  } catch (error) {
    fail("FAIL-SEI-LAYOUT-REGISTRY", `cannot load capability registry (${error.message})`);
  }
  for (const exportName of ["canonicalRoot", "resolveInstallation", "discover"]) {
    if (typeof registry[exportName] !== "function") {
      fail("FAIL-SEI-LAYOUT-REGISTRY", `capability registry lacks public export ${exportName}`);
    }
  }
  return { registry, registryPath };
}

function recordFor(inventory, name) {
  const record = inventory.packages.find((item) => item.name === name);
  if (!record) fail("FAIL-SEI-LAYOUT-DISCOVERY", `capability registry did not discover ${name}`);
  return record;
}

function resolveSeiLayout(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("FAIL-SEI-LAYOUT-OPTIONS", "options must be an object");
  }
  const sharedEngineRoot = realDirectory(options.sharedEngineRoot ?? __dirname, "shared engine root");
  const inferredSkillsRoot = path.resolve(sharedEngineRoot, "..", "..");
  const requestedSkillsRoot = options.skillsRoot ?? inferredSkillsRoot;
  const requestedSkillRoot = options.skillRoot ?? path.join(requestedSkillsRoot, SKILL_NAME);
  const mirrors = options.mirrors ?? [];
  if (!Array.isArray(mirrors) || mirrors.some((mirror) => typeof mirror !== "string" || mirror.length === 0)) {
    fail("FAIL-SEI-LAYOUT-OPTIONS", "mirrors must be an array of non-empty paths");
  }

  const { registry, registryPath } = loadRegistry(inferredSkillsRoot);
  const installation = registry.resolveInstallation(requestedSkillsRoot, mirrors);
  const canonicalRoot = installation.canonical_root;
  if (canonicalRoot !== realDirectory(inferredSkillsRoot, "shared engine skills root")) {
    fail("FAIL-SEI-LAYOUT-ROOT", "shared engine root and requested skills root do not resolve to one canonical installation");
  }

  const inventory = registry.discover(canonicalRoot);
  const sharedRecord = recordFor(inventory, SHARED_NAME);
  const skillRecord = recordFor(inventory, SKILL_NAME);
  if (sharedRecord.real_path !== sharedEngineRoot) {
    fail("FAIL-SEI-LAYOUT-DISCOVERY", "registry shared-engine record does not match the loaded shared engine");
  }

  const packageRoot = realDirectory(requestedSkillRoot, "skill package root");
  if (skillRecord.real_path !== packageRoot) {
    fail("FAIL-SEI-LAYOUT-DISCOVERY", "registry skill record does not match the requested skill package");
  }

  return Object.freeze({
    canonical_root: canonicalRoot,
    package_root: packageRoot,
    shared_engine_root: sharedEngineRoot,
    registry_path: registryPath,
    runner_path: existingFile(packageRoot, "scripts/run-sei.js", "runner"),
    config_path: existingFile(packageRoot, "assets/canonical-input.json", "canonical input"),
    template_path: existingFile(packageRoot, "assets/report-template.html", "report template"),
    maturity_runner_path: existingFile(packageRoot, "scripts/score-sei-maturity.js", "maturity runner"),
    maturity_rubric_path: existingFile(sharedEngineRoot, "maturity-rubric.json", "maturity rubric"),
    maturity_scorecard_schema_path: existingFile(sharedEngineRoot, "maturity-scorecard.schema.json", "maturity scorecard schema"),
    cli_path: existingFile(sharedEngineRoot, "cli.js", "shared CLI"),
    mirrors: installation.mirror_records,
  });
}

module.exports = { resolveSeiLayout };
