"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RUBRIC_PATH = path.join(__dirname, "maturity-rubric.json");
const SCORECARD_KIND = "sei-maturity-scorecard-v1";
const EVIDENCE_ARTIFACT_ROOT = Symbol("sei_maturity_artifact_root");
const EVIDENCE_LEVELS = [
  "implementation",
  "focused_deterministic",
  "synthetic_integration",
  "one_real_oracle",
  "heterogeneous_real_oracles",
  "temporal_holdout",
];
const STANDARD_CEILINGS = [0.25, 0.50, 0.70, 0.85, 1.00, 1.00];
const PREDICTIVE_CEILINGS = [0.10, 0.25, 0.45, 0.60, 0.75, 1.00];
const CATEGORY_MAXIMA = [260, 200, 180, 160, 70, 50, 35, 25, 15, 5];
const PREDICTIVE_BASELINES = ["loc", "churn", "complexity", "commit_count"];
const NUMERIC_FLOORS = [["overall_floor", null, 900], ["measurement_floor", "measurement", 230], ["performance_floor", "performance", 170], ["breadth_floor", "breadth", 155], ["predictive_floor", "predictive", 120], ["actionability_floor", "actionability", 42]];
const PROMOTION_GATE_IDS = [...NUMERIC_FLOORS.map(([gateId]) => gateId), "report_schema_integrity", "cache_incremental_useful", "framework_not_scored_honest", "heterogeneous_repository_coverage", "merge_heavy_repository", "large_repository", "predictive_validation"];
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const PINNED_RUBRIC_SHA256 = "sha256:c1e1fea45c04b2c2dc272bd73eb1ac608d24105daaf49675c26a3c5f40268f4d";

function fail(detail) {
  throw new Error(`FAIL-SEI-MATURITY: ${detail}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function requireClosedKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`);
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative safe integer`);
}

function requirePositiveFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${label} must be a positive finite number`);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function canonicalNumber(value) {
  return Number(value.toFixed(8));
}

function loadRubric() {
  let bytes;
  let rubric;
  try {
    bytes = fs.readFileSync(RUBRIC_PATH);
    rubric = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`pinned rubric cannot be loaded (${error.message})`);
  }
  if (sha256(Buffer.from(stableStringify(rubric), "utf8")) !== PINNED_RUBRIC_SHA256) fail("pinned rubric hash drift detected");
  requireClosedKeys(rubric, ["kind", "rubric_id", "categories"], "rubric");
  if (rubric.kind !== "sei-maturity-rubric-v1" || rubric.rubric_id !== "sei-maturity-v1" || !Array.isArray(rubric.categories) || rubric.categories.length !== 10) {
    fail("pinned rubric identity is invalid");
  }
  const criterionIds = new Set();
  const probeIds = new Set();
  let total = 0;
  rubric.categories.forEach((category, index) => {
    requireClosedKeys(category, ["category_id", "maximum_points", "criteria"], `rubric.categories[${index}]`);
    if (typeof category.category_id !== "string" || !/^[a-z]+$/.test(category.category_id) || category.maximum_points !== CATEGORY_MAXIMA[index] || !Array.isArray(category.criteria)) {
      fail("pinned rubric weight drift detected");
    }
    const categoryTotal = category.criteria.reduce((sum, criterion, criterionIndex) => {
      requireClosedKeys(criterion, ["criterion_id", "probe_id", "maximum_points"], `rubric.categories[${index}].criteria[${criterionIndex}]`);
      if (!/^([a-z]+)\.[a-z_]+$/.test(criterion.criterion_id) || criterion.criterion_id.split(".")[0] !== category.category_id || !/^probe\.[a-z]+\.[a-z_]+$/.test(criterion.probe_id) || !Number.isSafeInteger(criterion.maximum_points) || criterion.maximum_points <= 0 || criterionIds.has(criterion.criterion_id) || probeIds.has(criterion.probe_id)) {
        fail("pinned rubric criterion declaration is invalid");
      }
      criterionIds.add(criterion.criterion_id);
      probeIds.add(criterion.probe_id);
      return sum + criterion.maximum_points;
    }, 0);
    if (categoryTotal !== category.maximum_points) fail("pinned rubric weight drift detected");
    total += categoryTotal;
  });
  if (total !== 1000) fail("pinned rubric must total exactly 1000 points");
  return { rubric, rubric_sha256: PINNED_RUBRIC_SHA256 };
}

function withEvidenceArtifactRoot(evidenceBundle, artifactRoot) {
  if (!isRecord(evidenceBundle) || typeof artifactRoot !== "string" || artifactRoot.length === 0) fail("artifact root must be supplied as a directory path");
  const copy = structuredClone(evidenceBundle);
  Object.defineProperty(copy, EVIDENCE_ARTIFACT_ROOT, { value: artifactRoot, enumerable: false });
  return copy;
}

function validateArtifactReference(reference, root, label) {
  requireClosedKeys(reference, ["path", "sha256"], label);
  if (typeof reference.path !== "string" || reference.path.length === 0 || reference.path.includes("\\") || path.posix.isAbsolute(reference.path) || path.win32.isAbsolute(reference.path) || reference.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail(`${label}.path is not a safe repository-relative regular-file path`);
  }
  if (typeof reference.sha256 !== "string" || !SHA256.test(reference.sha256)) fail(`${label}.sha256 must be a lowercase sha256 digest`);
  let canonicalRoot;
  let target;
  try {
    canonicalRoot = fs.realpathSync(root);
    target = fs.realpathSync(path.resolve(canonicalRoot, reference.path));
  } catch (error) {
    fail(`${label} cannot resolve its referenced artifact`);
  }
  if (path.relative(canonicalRoot, target).startsWith("..") || path.isAbsolute(path.relative(canonicalRoot, target))) fail(`${label}.path escapes the artifact root`);
  let metadata;
  try { metadata = fs.statSync(target); } catch (error) { fail(`${label} cannot stat its referenced artifact`); }
  if (!metadata.isFile()) fail(`${label}.path must name a regular file`);
  if (sha256(fs.readFileSync(target)) !== reference.sha256) fail(`${label}.sha256 does not match the referenced bytes`);
}

function validatePromotionEvidence(value, root) {
  requireClosedKeys(value, [
    "report_schema_integrity", "cache_incremental_runs", "merge_heavy_useful", "framework_not_scored_honest",
    "heterogeneous_repository_count", "primary_language_ecosystem_count", "merge_heavy_repository", "large_repository", "predictive_validation",
  ], "promotion_evidence");
  for (const key of ["report_schema_integrity", "merge_heavy_useful", "framework_not_scored_honest"]) {
    if (typeof value[key] !== "boolean") fail(`promotion_evidence.${key} must be boolean`);
  }
  requireNonnegativeInteger(value.heterogeneous_repository_count, "promotion_evidence.heterogeneous_repository_count");
  requireNonnegativeInteger(value.primary_language_ecosystem_count, "promotion_evidence.primary_language_ecosystem_count");
  if (value.merge_heavy_repository !== null) {
    requireClosedKeys(value.merge_heavy_repository, ["commit_count", "merge_commit_count"], "promotion_evidence.merge_heavy_repository");
    requireNonnegativeInteger(value.merge_heavy_repository.commit_count, "promotion_evidence.merge_heavy_repository.commit_count");
    requireNonnegativeInteger(value.merge_heavy_repository.merge_commit_count, "promotion_evidence.merge_heavy_repository.merge_commit_count");
    if (value.merge_heavy_repository.merge_commit_count > value.merge_heavy_repository.commit_count) fail("promotion_evidence.merge_heavy_repository has incoherent counts");
  }
  if (value.large_repository !== null) {
    requireClosedKeys(value.large_repository, ["supported_source_file_count", "source_line_count", "commit_count"], "promotion_evidence.large_repository");
    for (const key of ["supported_source_file_count", "source_line_count", "commit_count"]) requireNonnegativeInteger(value.large_repository[key], `promotion_evidence.large_repository.${key}`);
  }
  if (value.cache_incremental_runs !== null) {
    requireClosedKeys(value.cache_incremental_runs, ["repositories"], "promotion_evidence.cache_incremental_runs");
    if (!Array.isArray(value.cache_incremental_runs.repositories) || value.cache_incremental_runs.repositories.length < 3) fail("promotion_evidence.cache_incremental_runs requires at least three repositories");
    const repositoryIds = new Set();
    value.cache_incremental_runs.repositories.forEach((repository, repositoryIndex) => {
      requireClosedKeys(repository, ["repository_id", "cold_warm_pairs"], `promotion_evidence.cache_incremental_runs.repositories[${repositoryIndex}]`);
      if (typeof repository.repository_id !== "string" || repository.repository_id.trim().length === 0 || repositoryIds.has(repository.repository_id) || !Array.isArray(repository.cold_warm_pairs) || repository.cold_warm_pairs.length < 3) {
        fail("promotion_evidence.cache_incremental_runs repository is invalid");
      }
      repositoryIds.add(repository.repository_id);
      repository.cold_warm_pairs.forEach((pair, pairIndex) => {
        requireClosedKeys(pair, ["cold_duration_ms", "warm_duration_ms"], `promotion_evidence.cache_incremental_runs.repositories[${repositoryIndex}].cold_warm_pairs[${pairIndex}]`);
        requirePositiveFiniteNumber(pair.cold_duration_ms, `promotion_evidence.cache_incremental_runs.repositories[${repositoryIndex}].cold_warm_pairs[${pairIndex}].cold_duration_ms`);
        requirePositiveFiniteNumber(pair.warm_duration_ms, `promotion_evidence.cache_incremental_runs.repositories[${repositoryIndex}].cold_warm_pairs[${pairIndex}].warm_duration_ms`);
      });
    });
  }
  if (value.predictive_validation !== null) {
    requireClosedKeys(value.predictive_validation, ["repository_count", "forward_folds_per_repository", "resolved_holdout_subject_count", "horizon_count", "leakage_detected", "horizons"], "promotion_evidence.predictive_validation");
    for (const key of ["repository_count", "forward_folds_per_repository", "resolved_holdout_subject_count", "horizon_count"]) requireNonnegativeInteger(value.predictive_validation[key], `promotion_evidence.predictive_validation.${key}`);
    if (typeof value.predictive_validation.leakage_detected !== "boolean" || !Array.isArray(value.predictive_validation.horizons) || value.predictive_validation.horizons.length < 2) fail("promotion_evidence.predictive_validation is invalid");
    const horizonIds = new Set();
    value.predictive_validation.horizons.forEach((horizon, index) => {
      requireClosedKeys(horizon, ["horizon_id", "paired_bootstrap_95_lower_confidence_bound", "baselines"], `promotion_evidence.predictive_validation.horizons[${index}]`);
      if (typeof horizon.horizon_id !== "string" || horizon.horizon_id.length === 0 || horizonIds.has(horizon.horizon_id) || !isRecord(horizon.paired_bootstrap_95_lower_confidence_bound) || !Array.isArray(horizon.baselines)) fail("promotion_evidence.predictive_validation horizon is invalid");
      horizonIds.add(horizon.horizon_id);
      const bound = horizon.paired_bootstrap_95_lower_confidence_bound;
      requireClosedKeys(bound, ["method", "confidence_level", "lower_confidence_bound", "provenance"], `promotion_evidence.predictive_validation.horizons[${index}].paired_bootstrap_95_lower_confidence_bound`);
      if (bound.method !== "paired_bootstrap" || bound.confidence_level !== 0.95 || typeof bound.lower_confidence_bound !== "number" || !Number.isFinite(bound.lower_confidence_bound)) fail("promotion_evidence.predictive_validation horizon paired bootstrap bound is invalid");
      validateArtifactReference(bound.provenance, root, `promotion_evidence.predictive_validation.horizons[${index}].paired_bootstrap_95_lower_confidence_bound.provenance`);
      if (new Set(horizon.baselines).size !== PREDICTIVE_BASELINES.length || horizon.baselines.length !== PREDICTIVE_BASELINES.length || !PREDICTIVE_BASELINES.every((baseline) => horizon.baselines.includes(baseline))) fail("promotion_evidence.predictive_validation horizon baselines are invalid");
    });
    if (value.predictive_validation.horizon_count !== horizonIds.size || horizonIds.size < 2) fail("promotion_evidence.predictive_validation horizon_count must equal at least two distinct horizons");
  }
}

function validateEvidence(evidenceBundle, rubric) {
  requireClosedKeys(evidenceBundle, ["kind", "sei_revision", "observations", "promotion_evidence"], "evidence bundle");
  if (evidenceBundle.kind !== "sei-maturity-evidence-v1" || typeof evidenceBundle.sei_revision !== "string" || !REVISION.test(evidenceBundle.sei_revision) || !Array.isArray(evidenceBundle.observations)) fail("evidence bundle identity is invalid or revision drifted");
  const root = evidenceBundle[EVIDENCE_ARTIFACT_ROOT];
  if (typeof root !== "string" || root.length === 0) fail("artifact root must be attached by the evidence-bundle runner");
  validatePromotionEvidence(evidenceBundle.promotion_evidence, root);
  const criterionById = new Map(rubric.categories.flatMap((category) => category.criteria).map((criterion) => [criterion.criterion_id, criterion]));
  const seen = new Set();
  const observations = [];
  evidenceBundle.observations.forEach((observation, index) => {
    requireClosedKeys(observation, ["probe_id", "criterion_id", "status", "evidence_level", "summary", "artifact_refs"], `observations[${index}]`);
    const criterion = criterionById.get(observation.criterion_id);
    if (!criterion || observation.probe_id !== criterion.probe_id) fail(`observations[${index}] references an unknown criterion or probe`);
    if (!["pass", "fail", "inconclusive"].includes(observation.status) || !EVIDENCE_LEVELS.includes(observation.evidence_level) || typeof observation.summary !== "string" || observation.summary.trim().length === 0 || !Array.isArray(observation.artifact_refs) || observation.artifact_refs.length === 0) fail(`observations[${index}] is invalid`);
    const observationKey = `${observation.criterion_id}\u0000${observation.evidence_level}`;
    if (seen.has(observationKey)) fail(`observations[${index}] duplicates an observation for that criterion and evidence level`);
    seen.add(observationKey);
    const paths = new Set();
    observation.artifact_refs.forEach((reference, referenceIndex) => {
      validateArtifactReference(reference, root, `observations[${index}].artifact_refs[${referenceIndex}]`);
      if (paths.has(reference.path)) fail(`observations[${index}] repeats an artifact path`);
      paths.add(reference.path);
    });
    observations.push(observation);
  });
  return observations;
}

function ceilingFor(categoryId, level) {
  const index = EVIDENCE_LEVELS.indexOf(level);
  if (index < 0) return 0;
  if (categoryId === "predictive") return PREDICTIVE_CEILINGS[index];
  if (categoryId === "provenance" && index >= 1) return 1;
  return STANDARD_CEILINGS[index];
}

function gate(gate_id, passed, blocked = !passed) {
  return { gate_id, status: passed ? "pass" : blocked ? "blocked" : "fail" };
}

function cacheIncrementalUseful(cacheIncrementalRuns) {
  if (cacheIncrementalRuns === null) return false;
  return cacheIncrementalRuns.repositories.every((repository) => {
    const pairedImprovements = repository.cold_warm_pairs.map((pair) => (pair.cold_duration_ms - pair.warm_duration_ms) / pair.cold_duration_ms);
    return median(pairedImprovements) >= 0.25;
  });
}

function promotionFor(categories, promotionEvidence) {
  const categoryById = new Map(categories.map((category) => [category.category_id, category]));
  const gates = Object.create(null);
  const hasUnsupported = categories.some((category) => category.criteria.some((criterion) => criterion.status === "unsupported" || criterion.status === "inconclusive"));
  const hasFailure = categories.some((category) => category.criteria.some((criterion) => criterion.status === "fail"));
  const total = categories.reduce((sum, category) => sum + category.points, 0);
  for (const [gateId, categoryId, floor] of NUMERIC_FLOORS) {
    const target = categoryId === null ? total : categoryById.get(categoryId).points;
    gates[gateId] = gate(gateId, target >= floor, hasUnsupported || !hasFailure);
  }
  gates.report_schema_integrity = gate("report_schema_integrity", promotionEvidence.report_schema_integrity);
  gates.cache_incremental_useful = gate("cache_incremental_useful", cacheIncrementalUseful(promotionEvidence.cache_incremental_runs));
  gates.framework_not_scored_honest = gate("framework_not_scored_honest", promotionEvidence.framework_not_scored_honest);
  gates.heterogeneous_repository_coverage = gate("heterogeneous_repository_coverage", promotionEvidence.heterogeneous_repository_count >= 4 && promotionEvidence.primary_language_ecosystem_count >= 3);
  const merge = promotionEvidence.merge_heavy_repository;
  gates.merge_heavy_repository = gate("merge_heavy_repository", promotionEvidence.merge_heavy_useful && merge !== null && merge.commit_count >= 200 && merge.merge_commit_count >= 10 && merge.merge_commit_count / merge.commit_count >= 0.05);
  const large = promotionEvidence.large_repository;
  gates.large_repository = gate("large_repository", large !== null && (large.supported_source_file_count >= 10000 || large.source_line_count >= 1000000 || large.commit_count >= 50000));
  const predictive = promotionEvidence.predictive_validation;
  const predictiveHorizon = predictive?.horizons.find((horizon) => horizon.paired_bootstrap_95_lower_confidence_bound.lower_confidence_bound > 1.0 && PREDICTIVE_BASELINES.every((baseline) => horizon.baselines.includes(baseline)));
  gates.predictive_validation = gate("predictive_validation", predictive !== null && predictive.repository_count >= 3 && predictive.forward_folds_per_repository >= 5 && predictive.resolved_holdout_subject_count >= 500 && predictive.horizon_count >= 2 && predictive.leakage_detected === false && predictiveHorizon !== undefined);
  const statuses = Object.values(gates).map((item) => item.status);
  return { status: statuses.every((status) => status === "pass") ? "pass" : hasFailure ? "fail" : "blocked", gates };
}

function validateMaturityScorecard(scorecard) {
  const { rubric, rubric_sha256 } = loadRubric();
  requireClosedKeys(scorecard, ["kind", "rubric_id", "rubric_sha256", "sei_revision", "scorecard_id", "maximum_points", "total_points", "categories", "promotion"], "scorecard");
  if (scorecard.kind !== SCORECARD_KIND || scorecard.rubric_id !== rubric.rubric_id || scorecard.rubric_sha256 !== rubric_sha256 || typeof scorecard.sei_revision !== "string" || !REVISION.test(scorecard.sei_revision) || scorecard.maximum_points !== 1000 || !Array.isArray(scorecard.categories) || scorecard.categories.length !== rubric.categories.length) {
    fail("scorecard identity is not canonical");
  }
  let computedTotal = 0;
  scorecard.categories.forEach((category, categoryIndex) => {
    const canonicalCategory = rubric.categories[categoryIndex];
    requireClosedKeys(category, ["category_id", "maximum_points", "points", "criteria"], `scorecard.categories[${categoryIndex}]`);
    if (category.category_id !== canonicalCategory.category_id || category.maximum_points !== canonicalCategory.maximum_points || !Array.isArray(category.criteria) || category.criteria.length !== canonicalCategory.criteria.length) fail(`scorecard.categories[${categoryIndex}] is not rubric-pinned`);
    let computedCategoryPoints = 0;
    category.criteria.forEach((criterion, criterionIndex) => {
      const canonicalCriterion = canonicalCategory.criteria[criterionIndex];
      requireClosedKeys(criterion, ["criterion_id", "maximum_points", "status", "evidence_level", "evidence_ceiling", "points"], `scorecard.categories[${categoryIndex}].criteria[${criterionIndex}]`);
      if (criterion.criterion_id !== canonicalCriterion.criterion_id || criterion.maximum_points !== canonicalCriterion.maximum_points || !["pass", "fail", "inconclusive", "unsupported"].includes(criterion.status) || !Number.isFinite(criterion.points) || criterion.points < 0 || criterion.points > criterion.maximum_points) fail(`scorecard criterion ${canonicalCriterion.criterion_id} is invalid`);
      const hasPass = criterion.status === "pass";
      if ((!hasPass && criterion.evidence_level !== null) || (hasPass && !EVIDENCE_LEVELS.includes(criterion.evidence_level))) fail(`scorecard criterion ${canonicalCriterion.criterion_id} has an invalid evidence level`);
      const expectedCeiling = hasPass ? ceilingFor(canonicalCategory.category_id, criterion.evidence_level) : 0;
      const expectedPoints = hasPass ? canonicalNumber(canonicalCriterion.maximum_points * expectedCeiling) : 0;
      if (criterion.evidence_ceiling !== expectedCeiling || criterion.points !== expectedPoints) fail(`scorecard criterion ${canonicalCriterion.criterion_id} has noncanonical points or ceiling`);
      computedCategoryPoints += expectedPoints;
    });
    computedCategoryPoints = canonicalNumber(computedCategoryPoints);
    if (!Number.isFinite(category.points) || category.points < 0 || category.points > category.maximum_points || category.points !== computedCategoryPoints) fail(`scorecard category ${canonicalCategory.category_id} total is not canonical`);
    computedTotal += computedCategoryPoints;
  });
  computedTotal = canonicalNumber(computedTotal);
  if (!Number.isFinite(scorecard.total_points) || scorecard.total_points < 0 || scorecard.total_points > 1000 || scorecard.total_points !== computedTotal) fail("scorecard overall total is not canonical");
  requireClosedKeys(scorecard.promotion, ["status", "gates"], "scorecard.promotion");
  if (!isRecord(scorecard.promotion.gates) || !["pass", "fail", "blocked"].includes(scorecard.promotion.status)) fail("scorecard promotion is invalid");
  requireClosedKeys(scorecard.promotion.gates, PROMOTION_GATE_IDS, "scorecard.promotion.gates");
  const categoriesById = new Map(scorecard.categories.map((category) => [category.category_id, category]));
  const hasUnsupported = scorecard.categories.some((category) => category.criteria.some((criterion) => criterion.status === "unsupported" || criterion.status === "inconclusive"));
  const hasFailure = scorecard.categories.some((category) => category.criteria.some((criterion) => criterion.status === "fail"));
  for (const [gateId, categoryId, floor] of NUMERIC_FLOORS) {
    const record = scorecard.promotion.gates[gateId];
    requireClosedKeys(record, ["gate_id", "status"], `scorecard.promotion.gates.${gateId}`);
    const passed = (categoryId === null ? computedTotal : categoriesById.get(categoryId).points) >= floor;
    const expectedStatus = passed ? "pass" : hasUnsupported || !hasFailure ? "blocked" : "fail";
    if (record.gate_id !== gateId || record.status !== expectedStatus) fail(`scorecard promotion gate ${gateId} is not canonical`);
  }
  for (const gateId of PROMOTION_GATE_IDS.slice(NUMERIC_FLOORS.length)) {
    const record = scorecard.promotion.gates[gateId];
    requireClosedKeys(record, ["gate_id", "status"], `scorecard.promotion.gates.${gateId}`);
    if (record.gate_id !== gateId || !["pass", "blocked"].includes(record.status)) fail(`scorecard promotion gate ${gateId} is invalid`);
  }
  const expectedPromotionStatus = Object.values(scorecard.promotion.gates).every((record) => record.status === "pass") ? "pass" : hasFailure ? "fail" : "blocked";
  if (scorecard.promotion.status !== expectedPromotionStatus) fail("scorecard promotion status is not canonical");
  const identity = stableStringify({ rubric_sha256, sei_revision: scorecard.sei_revision, categories: scorecard.categories, promotion: scorecard.promotion });
  const expectedScorecardId = `sei-maturity-v1-${crypto.createHash("sha256").update(identity).digest("hex")}`;
  if (scorecard.scorecard_id !== expectedScorecardId) fail("scorecard ID does not bind its canonical contents");
  return true;
}

function scoreMaturity(evidenceBundle) {
  const { rubric, rubric_sha256 } = loadRubric();
  const observations = validateEvidence(evidenceBundle, rubric);
  const byCriterion = new Map();
  for (const observation of observations) {
    const list = byCriterion.get(observation.criterion_id) ?? [];
    list.push(observation);
    byCriterion.set(observation.criterion_id, list);
  }
  const categories = rubric.categories.map((category) => {
    const criteria = category.criteria.map((criterion) => {
      const records = byCriterion.get(criterion.criterion_id) ?? [];
      const strongestFailure = records.filter((record) => record.status === "fail").reduce((maximum, record) => Math.max(maximum, EVIDENCE_LEVELS.indexOf(record.evidence_level)), -1);
      const strongestPass = records.filter((record) => record.status === "pass").reduce((maximum, record) => Math.max(maximum, EVIDENCE_LEVELS.indexOf(record.evidence_level)), -1);
      const inconclusive = records.some((record) => record.status === "inconclusive");
      const status = strongestFailure >= strongestPass && strongestFailure >= 0 ? "fail" : strongestPass >= 0 ? "pass" : inconclusive ? "inconclusive" : "unsupported";
      const evidence_level = status === "pass" ? EVIDENCE_LEVELS[strongestPass] : null;
      const ceiling = status === "pass" ? ceilingFor(category.category_id, evidence_level) : 0;
      return {
        criterion_id: criterion.criterion_id,
        maximum_points: criterion.maximum_points,
        status,
        evidence_level,
        evidence_ceiling: ceiling,
        points: status === "pass" ? canonicalNumber(criterion.maximum_points * ceiling) : 0,
      };
    });
    return {
      category_id: category.category_id,
      maximum_points: category.maximum_points,
      points: canonicalNumber(criteria.reduce((sum, criterion) => sum + criterion.points, 0)),
      criteria,
    };
  });
  const promotion = promotionFor(categories, evidenceBundle.promotion_evidence);
  const total_points = canonicalNumber(categories.reduce((sum, category) => sum + category.points, 0));
  const identity = stableStringify({ rubric_sha256, sei_revision: evidenceBundle.sei_revision, categories, promotion });
  return {
    kind: SCORECARD_KIND,
    rubric_id: rubric.rubric_id,
    rubric_sha256,
    sei_revision: evidenceBundle.sei_revision,
    scorecard_id: `sei-maturity-v1-${crypto.createHash("sha256").update(identity).digest("hex")}`,
    maximum_points: 1000,
    total_points,
    categories,
    promotion,
  };
}

function renderMaturityScorecardMarkdown(scorecard) {
  validateMaturityScorecard(scorecard);
  const lines = [
    "# SEI Product Maturity Scorecard",
    "",
    `Scorecard ID: \`${scorecard.scorecard_id}\``,
    `SEI revision: \`${scorecard.sei_revision}\``,
    `Rubric: \`${scorecard.rubric_id}\` (${scorecard.rubric_sha256})`,
    "",
    `Total points: ${scorecard.total_points}/${scorecard.maximum_points}`,
    `Promotion: ${scorecard.promotion.status}`,
    "",
    "## Categories",
    "",
  ];
  for (const category of scorecard.categories) {
    lines.push(`- ${category.category_id[0].toUpperCase()}${category.category_id.slice(1)}: ${category.points}/${category.maximum_points}`);
  }
  lines.push("", "## Promotion gates", "");
  for (const item of Object.values(scorecard.promotion.gates)) lines.push(`- ${item.gate_id}: ${item.status}`);
  return `${lines.join("\n")}\n`;
}

module.exports = {
  scoreMaturity,
  renderMaturityScorecardMarkdown,
  validateMaturityScorecard,
  withEvidenceArtifactRoot,
};
