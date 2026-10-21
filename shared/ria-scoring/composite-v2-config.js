"use strict";
/* Loader for the RIA composite v2 scoring config and presentation policy
 * (composite-scoring-v3 §4.2, §10, §11, §13).
 *
 * Every v2 reducer reads policy only through loadScoringConfig. The loader
 * validates the closed schema, enforces the §4.2 contract constraints, resolves
 * owner-owned imports (never copied into the config), deep-freezes the result
 * and returns three identities:
 *   config_sha256         canonical scoring config bytes
 *   imports_sha256        digests of every imported owner definition
 *   implementation_sha256 reducer/normalizer/schema files + imports_sha256
 * The presentation policy is hashed separately (policy_sha256) and never
 * participates in the scoring identities. */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateAgainstSchema } = require("../software-engineering-intelligence/schema-validator.js");

const PACKAGE_ROOT = __dirname;
const DEFAULT_SKILLS_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const CONFIG_PATH = path.join(PACKAGE_ROOT, "composite-v2.config.json");
const CONFIG_SCHEMA_PATH = path.join(PACKAGE_ROOT, "composite-v2.config.schema.json");
const POLICY_PATH = path.join(PACKAGE_ROOT, "composite-v2.policy.json");
const POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "composite-v2.policy.schema.json");

/** §4.2 contract constraints. These are specification invariants, not
 * calibration items, so a config cannot loosen them. */
const CONTRACT = Object.freeze({
  minimum_multi_owner_share: 0.20,
  architecture_share_caps: Object.freeze({ verification: 0.20, maintainability: 0.34 }),
  influence_band: Object.freeze({ minimum: 20, maximum: 30 }),
  share_sum_tolerance: 1e-9,
});

/** Files whose bytes define v2 scoring behaviour. Paths are relative to the
 * skills root. A change to any of them changes implementation_sha256 and
 * invalidates a calibration receipt (§11). The config itself is excluded
 * (config_sha256) as is the presentation policy (policy_sha256). */
// The reducer, its schemas and every normalizer that turns owner artifacts into its input
// (Phase 8): a calibration receipt binds this digest, so Promotion B cannot silently run
// different normalization than the one calibrated.
const IMPLEMENTATION_FILES = Object.freeze([
  "architecture-improvement-intelligence/assets/architecture-evidence-binding.js",
  "architecture-improvement-intelligence/assets/architecture-fitness.js",
  "codebase-integrity-audit-loop/assets/integrity-coverage.js",
  "repository-improvement-assessment/scripts/composite-v2-model.js",
  "shared/ria-scoring/composite-v2-config.js",
  "shared/ria-scoring/composite-v2.config.schema.json",
  "shared/ria-scoring/composite-v2.input.schema.json",
  "shared/ria-scoring/composite-v2.js",
  "shared/ria-scoring/evidence-model.js",
  "shared/ria-scoring/integrity-scoring.js",
  "shared/ria-scoring/scoring.js",
]);

const DEFECT_DIMENSIONS = Object.freeze(["correctness", "contracts", "security", "reliability"]);

function fail(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  const error = new Error(`FAIL-RIA-COMPOSITE-CONFIG: ${list.join("; ")}`);
  error.code = "FAIL-RIA-COMPOSITE-CONFIG";
  error.problems = list;
  throw error;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { return fail(`cannot read ${path.basename(file)} (${error.code ?? error.message})`); }
}

function loadHealthGlobal(file) {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  if (!sandbox.HealthVerify) fail(`${path.basename(file)} does not define globalThis.HealthVerify`);
  return sandbox.HealthVerify;
}

/** Resolves each config import to its owner-owned value and digest. Values are
 * cloned through JSON so a vm-realm object cannot leak in. */
function resolveImports(imports, skillsRoot) {
  const resolved = {};
  const digests = {};
  const moduleCache = new Map();
  for (const name of Object.keys(imports).sort()) {
    const spec = imports[name];
    const file = path.resolve(skillsRoot, ...spec.module.split("/"));
    const relative = path.relative(skillsRoot, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`import ${name} escapes the skills root`);
    if (!fs.existsSync(file)) fail(`import ${name}: ${spec.module} is missing`);
    const cacheKey = `${spec.loader}|${file}`;
    if (!moduleCache.has(cacheKey)) {
      if (spec.loader === "commonjs") moduleCache.set(cacheKey, require(file));
      else if (spec.loader === "json") moduleCache.set(cacheKey, readJsonFile(file));
      else if (spec.loader === "global:HealthVerify") moduleCache.set(cacheKey, loadHealthGlobal(file));
      else fail(`import ${name}: unsupported loader ${spec.loader}`);
    }
    const source = moduleCache.get(cacheKey);
    if (!source || !Object.prototype.hasOwnProperty.call(source, spec.export)) fail(`import ${name}: ${spec.module} has no export ${spec.export}`);
    const value = JSON.parse(JSON.stringify(source[spec.export]));
    resolved[name] = value;
    digests[name] = { module: spec.module, export: spec.export, value_sha256: sha256(canonicalJson(value)) };
  }
  return { values: resolved, digests };
}

/** Nominal influence (§4.2): every owner eligible, each dimension weighted by
 * weight / Σ weight, owner share within it. Returned in percent, unrounded. */
function computeNominalInfluence(config) {
  const dimensions = config.dimensions;
  const total = Object.values(dimensions).reduce((sum, dimension) => sum + dimension.weight, 0);
  const influence = Object.fromEntries(config.owners.map(owner => [owner, 0]));
  if (!(total > 0)) return influence;
  for (const dimension of Object.values(dimensions)) {
    for (const [owner, share] of Object.entries(dimension.shares)) influence[owner] += (dimension.weight / total) * share * 100;
  }
  return influence;
}

function oneDecimal(value) { return Math.abs(value * 10 - Math.round(value * 10)) < 1e-9; }

function gradeFor(score, bands) {
  for (const [minimum, grade] of bands) if (score >= minimum) return grade;
  return null;
}

/** Semantic constraints the schema cannot express. Returns problem strings. */
function semanticProblems(config, imports) {
  const problems = [];
  const lanes = imports.health_lane_definitions;
  const surfaces = imports.health_default_surfaces;
  const fitnessWeights = imports.architecture_fitness_weights;
  const seiDimensions = new Set(imports.sei_rubric.map(entry => entry.dimension_id));
  const used = { lane: new Map(), fitness: new Map(), sei: new Map() };

  let criticalCount = 0;
  for (const [id, dimension] of Object.entries(config.dimensions)) {
    if (!(dimension.weight > 0)) problems.push(`${id}: weight must be positive`);
    if (dimension.critical) criticalCount += 1;
    const sourceOwners = Object.keys(dimension.sources).sort();
    const shareOwners = Object.keys(dimension.shares).sort();
    if (sourceOwners.length === 0) problems.push(`${id}: needs at least one owner source`);
    if (canonicalJson(sourceOwners) !== canonicalJson(shareOwners)) problems.push(`${id}: share owners must equal source owners`);
    const shares = Object.values(dimension.shares);
    const sum = shares.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > CONTRACT.share_sum_tolerance) problems.push(`${id}: shares sum to ${sum}, not 1`);
    if (shares.length > 1) {
      for (const [owner, share] of Object.entries(dimension.shares)) {
        if (share < CONTRACT.minimum_multi_owner_share - CONTRACT.share_sum_tolerance) problems.push(`${id}.${owner}: share ${share} is below ${CONTRACT.minimum_multi_owner_share}`);
      }
    }
    const cap = CONTRACT.architecture_share_caps[id];
    if (cap !== undefined && (dimension.shares.architecture ?? 0) > cap + CONTRACT.share_sum_tolerance) problems.push(`${id}: architecture share exceeds ${cap}`);

    const health = dimension.sources.health;
    if (health) {
      if (!Object.prototype.hasOwnProperty.call(lanes, health.lane)) problems.push(`${id}: unknown Health lane ${health.lane}`);
      if (used.lane.has(health.lane)) problems.push(`${id}: Health lane ${health.lane} already maps to ${used.lane.get(health.lane)}`);
      used.lane.set(health.lane, id);
    }
    const architecture = dimension.sources.architecture;
    if (architecture) {
      for (const sub of architecture.fitness_dimensions) {
        if (!Object.prototype.hasOwnProperty.call(fitnessWeights, sub)) problems.push(`${id}: unknown Architecture fitness dimension ${sub}`);
        if (used.fitness.has(sub)) problems.push(`${id}: fitness dimension ${sub} already maps to ${used.fitness.get(sub)}`);
        used.fitness.set(sub, id);
      }
    }
    const sei = dimension.sources.sei;
    if (sei) {
      for (const sub of sei.dimensions) {
        if (!seiDimensions.has(sub)) problems.push(`${id}: unknown SEI dimension ${sub}`);
        if (used.sei.has(sub)) problems.push(`${id}: SEI dimension ${sub} already maps to ${used.sei.get(sub)}`);
        used.sei.set(sub, id);
      }
    }
    const integrity = dimension.sources.integrity;
    if (integrity) {
      if (integrity.defect_dimension !== id) problems.push(`${id}: Integrity defect_dimension must equal the dimension id`);
      if (!config.integrity_surface_map[id]) problems.push(`${id}: missing integrity_surface_map entry`);
      if (!config.integrity_defect_checks[id]) problems.push(`${id}: missing integrity_defect_checks entry`);
    }
  }
  if (criticalCount === 0) problems.push("at least one dimension must be critical");
  for (const id of DEFECT_DIMENSIONS) {
    if (!config.dimensions[id]?.sources?.integrity) problems.push(`integrity_surface_map.${id}: dimension has no Integrity source`);
    for (const surface of config.integrity_surface_map[id] ?? []) {
      if (!Object.prototype.hasOwnProperty.call(surfaces, surface)) problems.push(`integrity_surface_map.${id}: unknown surface ${surface}`);
    }
  }
  for (const [lane, mapped] of Object.entries(config.lane_dimension_map)) {
    if (!Object.prototype.hasOwnProperty.call(lanes, lane)) problems.push(`lane_dimension_map: unknown Health lane ${lane}`);
    if (!Array.isArray(mapped) || mapped.length === 0 || mapped.some(dimension => !DEFECT_DIMENSIONS.includes(dimension))) problems.push(`lane_dimension_map.${lane}: must be a non-empty subset of ${DEFECT_DIMENSIONS.join(", ")}`);
  }

  const influence = computeNominalInfluence(config);
  for (const [owner, value] of Object.entries(influence)) {
    if (value < CONTRACT.influence_band.minimum - 1e-9 || value > CONTRACT.influence_band.maximum + 1e-9) problems.push(`nominal influence for ${owner} is ${value.toFixed(2)}, outside [${CONTRACT.influence_band.minimum}, ${CONTRACT.influence_band.maximum}]`);
  }

  const eligibility = config.eligibility;
  if (eligibility.health.min_weighted_coverage > eligibility.health.established_min_weighted_coverage) problems.push("eligibility.health: minimum exceeds established minimum");
  if (!(eligibility.integrity.provisional_min_coverage > 0) || eligibility.integrity.provisional_min_coverage > eligibility.integrity.scored_min_coverage) problems.push("eligibility.integrity: need 0 < provisional_min_coverage <= scored_min_coverage");
  if (!(eligibility.architecture.min_mapped_coverage > 0)) problems.push("eligibility.architecture: min_mapped_coverage must be positive");
  if (!eligibility.sei.ineligible_confidences.includes("NOT_ESTABLISHED")) problems.push("eligibility.sei: NOT_ESTABLISHED must stay ineligible");
  const seiConfidence = config.sei_confidence;
  if (!(seiConfidence.HIGH > seiConfidence.MODERATE && seiConfidence.MODERATE > seiConfidence.LOW && seiConfidence.LOW > 0)) problems.push("sei_confidence: need HIGH > MODERATE > LOW > 0");
  if (!(config.confidence_bands.high > config.confidence_bands.moderate && config.confidence_bands.moderate > 0)) problems.push("confidence_bands: need high > moderate > 0");
  if (!(config.contested.spread_threshold > 0)) problems.push("contested.spread_threshold must be positive");
  if (!(config.contested.minimum_multiplier > 0)) problems.push("contested.minimum_multiplier must be positive");
  if (!(config.dependence.adopted_strength_threshold > 0)) problems.push("dependence.adopted_strength_threshold must be positive");
  if (!(config.status.not_gradable_min_scored_weight_ratio > 0)) problems.push("status.not_gradable_min_scored_weight_ratio must be positive");
  if (!(config.critical_floor.point_below > 0)) problems.push("critical_floor.point_below must be positive");

  const schedule = config.integrity_scoring.severity_schedule;
  const severities = schedule.map(row => row.severity).sort();
  if (canonicalJson(severities) !== canonicalJson([1, 2, 3, 4, 5])) problems.push("integrity_scoring.severity_schedule: needs exactly one row per severity 1-5");
  const bySeverity = Object.fromEntries(schedule.map(row => [row.severity, row]));
  for (const row of schedule) {
    if (row.floor > row.ceiling) problems.push(`severity ${row.severity}: floor exceeds ceiling`);
    if (!(row.step > 0)) problems.push(`severity ${row.severity}: step must be positive`);
  }
  for (let severity = 2; severity <= 5; severity += 1) {
    const worse = bySeverity[severity], better = bySeverity[severity - 1];
    if (worse && better && !(worse.ceiling < better.ceiling && worse.floor < better.floor)) problems.push(`severity ${severity}: ceiling and floor must be below severity ${severity - 1}`);
  }
  if (bySeverity[1] && !(config.integrity_scoring.no_defect_score > bySeverity[1].ceiling)) problems.push("integrity_scoring.no_defect_score must exceed the severity-1 ceiling");

  const ceilings = config.caps.ceilings;
  for (const [letter, ceiling] of Object.entries(ceilings)) {
    if (!oneDecimal(ceiling)) problems.push(`caps.ceilings.${letter}: must use one-decimal precision`);
    if (gradeFor(ceiling, imports.grade_bands) !== letter) problems.push(`caps.ceilings.${letter}: ${ceiling} is not in the ${letter} band`);
  }
  if (!(ceilings.D < ceilings["D+"] && ceilings["D+"] < ceilings.C)) problems.push("caps.ceilings: need D < D+ < C");
  return problems;
}

function validateScoringConfig(config, imports) {
  const schema = readJsonFile(CONFIG_SCHEMA_PATH);
  const schemaErrors = validateAgainstSchema(config, schema);
  if (schemaErrors.length) fail(schemaErrors);
  const problems = semanticProblems(config, imports);
  if (problems.length) fail(problems);
}

function implementationDigest(skillsRoot, importsSha256, files = IMPLEMENTATION_FILES) {
  const entries = files.map(relative => {
    const file = path.resolve(skillsRoot, ...relative.split("/"));
    if (!fs.existsSync(file)) {
      // Typed apart from configuration errors: an absent implementation file is an availability
      // problem a partial installation can cause, not an invalid configuration (§5.3).
      const error = new Error(`FAIL-RIA-COMPOSITE-IMPLEMENTATION-MISSING: implementation file ${relative} is missing`);
      error.code = "FAIL-RIA-COMPOSITE-IMPLEMENTATION-MISSING";
      error.missing_implementation = relative;
      throw error;
    }
    return { path: relative, sha256: sha256(fs.readFileSync(file)) };
  });
  return { files: entries, implementation_sha256: sha256(canonicalJson({ files: entries, imports_sha256: importsSha256 })) };
}

/** Loads and validates the scoring config. `config` may be supplied directly
 * (test-local configurations); otherwise the packaged config is read. */
function loadScoringConfig({ config = null, configPath = CONFIG_PATH, skillsRoot = DEFAULT_SKILLS_ROOT } = {}) {
  const raw = config ? JSON.parse(JSON.stringify(config)) : readJsonFile(configPath);
  const schema = readJsonFile(CONFIG_SCHEMA_PATH);
  const schemaErrors = validateAgainstSchema(raw, schema);
  if (schemaErrors.length) fail(schemaErrors);
  const imports = resolveImports(raw.imports, skillsRoot);
  const problems = semanticProblems(raw, imports.values);
  if (problems.length) fail(problems);
  const importsSha256 = sha256(canonicalJson(imports.digests));
  const implementation = implementationDigest(skillsRoot, importsSha256);
  return deepFreeze({
    config: raw,
    config_version: raw.config_version,
    config_sha256: sha256(canonicalJson(raw)),
    imports: imports.values,
    import_digests: imports.digests,
    imports_sha256: importsSha256,
    implementation_files: implementation.files,
    implementation_sha256: implementation.implementation_sha256,
    nominal_influence: computeNominalInfluence(raw),
    contract: CONTRACT,
  });
}

/** Loads the separate presentation policy. It carries no scoring numbers and
 * its hash never enters config_sha256 or implementation_sha256. */
function loadPresentationPolicy({ policy = null, policyPath = POLICY_PATH } = {}) {
  const raw = policy ? JSON.parse(JSON.stringify(policy)) : readJsonFile(policyPath);
  const errors = validateAgainstSchema(raw, readJsonFile(POLICY_SCHEMA_PATH));
  if (errors.length) {
    const error = new Error(`FAIL-RIA-COMPOSITE-POLICY: ${errors.join("; ")}`);
    error.code = "FAIL-RIA-COMPOSITE-POLICY";
    throw error;
  }
  return deepFreeze({ policy: raw, policy_sha256: sha256(canonicalJson(raw)) });
}

module.exports = {
  CONFIG_PATH,
  CONTRACT,
  DEFECT_DIMENSIONS,
  IMPLEMENTATION_FILES,
  POLICY_PATH,
  canonicalJson,
  computeNominalInfluence,
  loadPresentationPolicy,
  loadScoringConfig,
  sha256,
  validateScoringConfig,
};
