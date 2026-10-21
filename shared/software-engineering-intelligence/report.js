"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const intelligenceEngine = require("./intelligence-engine.js");
const { validateSnapshot } = intelligenceEngine;
const intelligenceEnginePrivate = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")];
const engineeringAssessment = require("./engineering-assessment.js");
const engineeringAssessmentPrivate = engineeringAssessment[Symbol.for("sei.engineering-assessment.private.v1")];
const reportProjection = require("./report-projection.js");
const {
  snapshotDigest,
  validateReportProjection,
} = reportProjection;
const reportProjectionPrivate = reportProjection[Symbol.for("sei.report-projection.private.v1")];
const forwardTemporalPrivate = require("./forward-temporal-evaluator.js")[Symbol.for("sei.forward-temporal-evaluator.private.v1")];
const { resolveSeiLayout } = require("./layout.js");
const reportPresentation = require("../report-presentation/report-presentation.js");

const TEMPLATE_PATH = resolveSeiLayout().template_path;
const ISLAND_PATTERN = /<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/g;
const ISLAND_DIGEST_PATTERN = /<meta name="sei-island-sha256" content="([a-f0-9]{64})">/g;
const SNAPSHOT_DIGEST_PATTERN = /<meta name="sei-snapshot-sha256" content="([a-f0-9]{64})">/g;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXTERNAL_DEPENDENCY_PATTERN = /<(?:script|img|link|iframe|audio|video|source)\b[^>]*(?:src|href)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i;
const MARKER_PATTERN = /\{\{(?:SEI_REPORT_PROJECTION_JSON|SEI_ISLAND_SHA256|SEI_SNAPSHOT_SHA256|REPORT_PRESENTATION_CSS|REPORT_PRESENTATION_SCRIPT)\}\}/g;
const canonicalReportBytes = new WeakMap();

function assertValidSnapshot(snapshot) {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) throw new Error(`FAIL-REPORT-SNAPSHOT: ${validation.errors.join("; ")}`);
}

function safeIslandJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes, "utf8").digest("hex");
}

function renderProjection(projection) {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8").replace(/\r\n?/g, "\n");
  const islandBytes = safeIslandJson(projection);
  const markers = {
    "{{SEI_REPORT_PROJECTION_JSON}}": islandBytes,
    "{{SEI_ISLAND_SHA256}}": digest(islandBytes),
    "{{SEI_SNAPSHOT_SHA256}}": projection.source.snapshot_sha256,
    "{{REPORT_PRESENTATION_CSS}}": reportPresentation.responsiveCss(),
    "{{REPORT_PRESENTATION_SCRIPT}}": reportPresentation.progressiveScript(),
  };
  for (const marker of Object.keys(markers)) {
    if (template.split(marker).length !== 2) {
      throw new Error(`FAIL-REPORT-TEMPLATE: template must contain exactly one ${marker} marker`);
    }
  }
  // One pass with a callback: replacement values are inserted literally (no
  // `$&`/`$'`/`` $` ``/`$$` expansion) and inserted text is never rescanned, so an
  // island that happens to contain a marker string cannot be substituted.
  return template.replace(MARKER_PATTERN, (marker) => markers[marker]);
}

function renderSnapshotProjection(snapshot, predictiveBinding, assessmentBinding, projectSnapshot) {
  return renderProjection(projectSnapshot(snapshot, predictiveBinding === null || predictiveBinding === undefined
    ? (assessmentBinding === null || assessmentBinding === undefined ? {} : { assessment_binding: assessmentBinding })
    : { predictive_binding: predictiveBinding, ...(assessmentBinding === null || assessmentBinding === undefined ? {} : { assessment_binding: assessmentBinding }) }));
}

function renderValidatedSnapshot(snapshot, predictiveBinding = null, assessmentBinding = null) {
  return renderSnapshotProjection(snapshot, predictiveBinding, assessmentBinding, reportProjectionPrivate.projectValidatedSnapshot);
}

function renderCanonicalSnapshot(snapshot, predictiveBinding = null, assessmentBinding = null) {
  return renderSnapshotProjection(snapshot, predictiveBinding, assessmentBinding, reportProjectionPrivate.projectValidatedSnapshot);
}

function renderReport(snapshot, options = {}) {
  assertValidSnapshot(snapshot);
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => key !== "predictive_binding")) {
    throw new Error("FAIL-REPORT-SNAPSHOT: options must contain only predictive_binding");
  }
  return renderValidatedSnapshot(snapshot, options.predictive_binding ?? null);
}

function renderReportFromCanonicalArtifact(artifact, options = {}) {
  const { snapshot } = intelligenceEnginePrivate.readCanonicalArtifact(artifact);
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["predictive_binding", "assessment_binding"].includes(key))) {
    throw new Error("FAIL-REPORT-ARTIFACT: options contain an unsupported binding");
  }
  const predictiveBinding = options.predictive_binding ?? null;
  const assessmentBinding = options.assessment_binding ?? null;
  const html = renderCanonicalSnapshot(snapshot, predictiveBinding, assessmentBinding);
  // The private verifier short-cuts on cached bytes, so only bytes that the
  // public verifier independently accepts may ever enter the cache.
  const verification = verifyRenderedReport(html, snapshot, { predictive_binding: predictiveBinding, assessment_binding: assessmentBinding });
  if (!verification.ok) {
    throw new Error(`FAIL-REPORT-UNVERIFIED: canonical render failed public verification: ${verification.errors.join("; ")}`);
  }
  let variants = canonicalReportBytes.get(artifact);
  if (variants === undefined) {
    variants = new Map();
    canonicalReportBytes.set(artifact, variants);
  }
  let assessmentVariants = variants.get(predictiveBinding);
  if (assessmentVariants === undefined) {
    assessmentVariants = new Map();
    variants.set(predictiveBinding, assessmentVariants);
  }
  assessmentVariants.set(assessmentBinding, html);
  return html;
}

function verifyRenderedReportFromCanonicalArtifact(html, artifact, options = {}) {
  const errors = [];
  const { snapshot } = intelligenceEnginePrivate.readCanonicalArtifact(artifact);
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["predictive_binding", "assessment_binding"].includes(key))) {
    throw new Error("FAIL-REPORT-ARTIFACT: options contain an unsupported binding");
  }
  const predictiveBinding = options.predictive_binding ?? null;
  const assessmentBinding = options.assessment_binding ?? null;
  const expected = canonicalReportBytes.get(artifact)?.get(predictiveBinding)?.get(assessmentBinding);
  if (expected === html) return { ok: true, errors: [] };
  if (expected === undefined) {
    errors.push("FAIL-REPORT-ARTIFACT: canonical report was not rendered by this module");
  } else {
    errors.push("FAIL-REPORT-TAMPERED: report bytes do not match the branded canonical snapshot");
  }
  const publicValidation = verifyRenderedReport(html, snapshot, { predictive_binding: predictiveBinding, assessment_binding: assessmentBinding });
  errors.push(...publicValidation.errors);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function expectedBinding(expectedSnapshotOrDigest, predictiveBinding, assessmentBinding, errors) {
  if (expectedSnapshotOrDigest === undefined) return { digest: null, projectionBytes: null };
  if (typeof expectedSnapshotOrDigest === "string") {
    if (!SHA256_PATTERN.test(expectedSnapshotOrDigest)) {
      errors.push("FAIL-REPORT-EXPECTED-BINDING: expected digest must be a lowercase SHA-256 hex value");
      return { digest: null, projectionBytes: null };
    }
    return { digest: expectedSnapshotOrDigest, projectionBytes: null };
  }
  try {
    assertValidSnapshot(expectedSnapshotOrDigest);
    return {
      digest: snapshotDigest(expectedSnapshotOrDigest),
      projectionBytes: safeIslandJson(reportProjectionPrivate.projectValidatedSnapshot(
        expectedSnapshotOrDigest,
        {
          ...(predictiveBinding === null || predictiveBinding === undefined ? {} : { predictive_binding: predictiveBinding }),
          ...(assessmentBinding === null || assessmentBinding === undefined ? {} : { assessment_binding: assessmentBinding }),
        },
      )),
    };
  } catch (error) {
    errors.push(`FAIL-REPORT-EXPECTED-BINDING: ${error.message}`);
    return { digest: null, projectionBytes: null };
  }
}

function verifyRenderedReport(html, expectedSnapshotOrDigest, options = {}) {
  const errors = [];
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["predictive_binding", "assessment_binding"].includes(key))) {
    return { ok: false, errors: ["FAIL-REPORT-EXPECTED-BINDING: options contain an unsupported binding"] };
  }
  const predictiveBinding = options.predictive_binding ?? null;
  const assessmentBinding = options.assessment_binding ?? null;
  if (typeof html !== "string" || html.length === 0) {
    return { ok: false, errors: ["FAIL-REPORT-DOCUMENT: report must be a non-empty string"] };
  }
  if (EXTERNAL_DEPENDENCY_PATTERN.test(html) || /<script\b[^>]*\bsrc\s*=/i.test(html)) {
    errors.push("FAIL-REPORT-EXTERNAL-DEPENDENCY: report must be self-contained");
  }
  const islands = [...html.matchAll(ISLAND_PATTERN)];
  if (islands.length !== 1) {
    errors.push("FAIL-REPORT-ISLAND: report must contain exactly one projection island");
    return { ok: false, errors };
  }
  const islandDigests = [...html.matchAll(ISLAND_DIGEST_PATTERN)];
  if (islandDigests.length !== 1) {
    errors.push("FAIL-REPORT-ISLAND-DIGEST: report must contain exactly one SHA-256 projection digest meta value");
  } else if (digest(islands[0][1]) !== islandDigests[0][1]) {
    errors.push("FAIL-REPORT-ISLAND-DIGEST: embedded digest does not match exact projection bytes");
  }
  const snapshotDigests = [...html.matchAll(SNAPSHOT_DIGEST_PATTERN)];
  if (snapshotDigests.length !== 1) {
    errors.push("FAIL-REPORT-SNAPSHOT-DIGEST: report must contain exactly one canonical snapshot digest meta value");
  }
  let projection;
  try {
    projection = JSON.parse(islands[0][1]);
  } catch {
    errors.push("FAIL-REPORT-ISLAND: projection island is malformed JSON");
    return { ok: false, errors };
  }
  const projectionValidation = validateReportProjection(projection);
  errors.push(...projectionValidation.errors);
  if (snapshotDigests.length === 1 && projection.source?.snapshot_sha256 !== snapshotDigests[0][1]) {
    errors.push("FAIL-REPORT-SNAPSHOT-DIGEST: projection source does not match the declared canonical snapshot digest");
  }
  const predictiveState = projection.predictive_intelligence?.state;
  const predictiveEvaluationExists = projection.predictive_status?.evaluation_exists === true;
  const predictiveReadinessOnly = predictiveState === "NOT_READY"
    && predictiveEvaluationExists === false
    && projection.predictive_intelligence?.forecast_state === "readiness";
  let predictiveReadinessBinding = false;
  if (predictiveBinding !== null) {
    try { predictiveReadinessBinding = forwardTemporalPrivate.isAutomaticReadinessBinding(predictiveBinding); } catch { predictiveReadinessBinding = false; }
  }
  const requiresPredictiveBinding = !predictiveReadinessOnly
    && (predictiveState !== "not-established" && predictiveState !== "NOT_READY" || predictiveEvaluationExists);
  if (requiresPredictiveBinding && predictiveBinding === null) {
    errors.push("FAIL-REPORT-EXPECTED-BINDING: evaluated predictive intelligence requires an expected package-branded predictive binding");
  }
  if (!requiresPredictiveBinding && predictiveBinding !== null && !predictiveReadinessBinding) {
    errors.push("FAIL-REPORT-EXPECTED-BINDING: expected predictive binding is absent from the report projection");
  }
  if (requiresPredictiveBinding && predictiveBinding !== null
      && typeof expectedSnapshotOrDigest === "string") {
    errors.push("FAIL-REPORT-EXPECTED-BINDING: evaluated predictive intelligence requires the expected canonical snapshot, not only its digest");
  }
  const assessmentState = projection.assessment?.state;
  const requiresAssessmentBinding = assessmentState !== "not-assessed";
  if (requiresAssessmentBinding && assessmentBinding === null) {
    errors.push("FAIL-REPORT-EXPECTED-BINDING: engineering assessment requires an expected package-branded assessment binding");
  }
  if (!requiresAssessmentBinding && assessmentBinding !== null) {
    errors.push("FAIL-REPORT-EXPECTED-BINDING: assessment binding is absent from the report projection");
  }
  if (requiresAssessmentBinding && assessmentBinding !== null && expectedSnapshotOrDigest === undefined) {
    errors.push("FAIL-REPORT-EXPECTED-BINDING: evaluated assessment requires the expected canonical snapshot");
  }
  if (assessmentBinding !== null) {
    try { engineeringAssessmentPrivate.readBoundAssessment(assessmentBinding); } catch (error) { errors.push(error.message); }
  }
  const expected = expectedBinding(expectedSnapshotOrDigest, predictiveBinding, assessmentBinding, errors);
  if (expected.digest !== null && projection.source?.snapshot_sha256 !== expected.digest) {
    errors.push("FAIL-REPORT-EXPECTED-BINDING: projection does not match expected canonical snapshot digest");
  }
  if (expected.projectionBytes !== null && islands[0][1] !== expected.projectionBytes) {
    // Automatic prediction readiness is deliberately non-numeric and may be
    // reported by a package-private run binding that cannot cross the public
    // verifier boundary.  Keep the canonical snapshot/assessment projection
    // exact, while allowing only the bounded readiness reason/state to survive
    // that boundary. Evaluated receipts still require their opaque binding.
    let readinessEquivalent = false;
    if (predictiveBinding === null
        && ["not-established", "NOT_READY"].includes(projection.predictive_intelligence?.state)
        && projection.predictive_intelligence?.forecast_state === "readiness"
        && projection.predictive_status?.evaluation_exists !== true) {
      try {
        const canonicalProjection = JSON.parse(expected.projectionBytes);
        canonicalProjection.predictive_intelligence = projection.predictive_intelligence;
        readinessEquivalent = safeIslandJson(canonicalProjection) === islands[0][1];
      } catch {
        readinessEquivalent = false;
      }
    }
    if (!readinessEquivalent) errors.push("FAIL-REPORT-EXPECTED-BINDING: projection bytes were not derived from the expected canonical snapshot");
  }
  try {
    if (renderProjection(projection) !== html) {
      errors.push("FAIL-REPORT-TAMPERED: report bytes do not match the validated projection island");
    }
  } catch (error) {
    errors.push(`FAIL-REPORT-DOCUMENT: ${error.message}`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { renderReport, verifyRenderedReport };
Object.defineProperty(module.exports, Symbol.for("sei.report.private.v1"), {
  value: Object.freeze({ renderReportFromCanonicalArtifact, verifyRenderedReportFromCanonicalArtifact }),
});
