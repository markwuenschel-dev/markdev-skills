"use strict";

const FRAMEWORK_LENS_VERSION = "sei.framework-lenses@1";
const FRAMEWORK_LENS_IDS = Object.freeze([
  "Modern SWE",
  "Clean Code/SOLID",
  "DORA",
  "Agile",
  "Scrum",
  "Kanban",
  "SPACE",
  "EngThrive",
  "Mark Engineering Standard",
]);

const LENS_DEFINITIONS = Object.freeze({
  "Modern SWE": Object.freeze({
    label: "Modern Software Engineering",
    criteria: [
      "complexity_concentration", "duplication_pressure", "dependency_direction",
      "cycle_participation", "test_execution", "ci_prerequisites", "operational_readiness",
      "local_feedback", "contracts_and_runbooks",
    ],
  }),
  "Clean Code/SOLID": Object.freeze({
    label: "Clean Code / SOLID",
    criteria: [
      "complexity_concentration", "duplication_pressure", "failure_explicitness",
      "responsibility_concentration", "module_boundary_coherence",
    ],
  }),
  DORA: Object.freeze({
    label: "DORA",
    criteria: ["ci_prerequisites", "release_automation_prerequisites", "recovery_evidence"],
    requires_authoritative_performance_evidence: true,
  }),
  Agile: Object.freeze({
    label: "Agile",
    criteria: ["change_scope_coherence", "commit_batch_discipline", "change_verification", "change_context"],
  }),
  Scrum: Object.freeze({
    label: "Scrum",
    criteria: ["change_scope_coherence", "change_verification", "change_context"],
    requires_adoption_evidence: true,
  }),
  Kanban: Object.freeze({
    label: "Kanban",
    criteria: ["commit_batch_discipline", "change_scope_coherence"],
    requires_adoption_evidence: true,
  }),
  SPACE: Object.freeze({
    label: "SPACE / Developer Experience",
    criteria: ["local_feedback", "configuration_ergonomics"],
  }),
  EngThrive: Object.freeze({
    label: "EngThrive",
    criteria: ["local_feedback", "test_execution", "change_pressure"],
  }),
  "Mark Engineering Standard": Object.freeze({
    label: "Mark Engineering Standard",
    criteria: ["module_boundary_coherence", "test_execution", "ci_prerequisites", "secrets_and_configuration", "contracts_and_runbooks"],
  }),
});

const CRITERION_STATUSES = new Set(["applicable", "not_applicable", "not_scored"]);
const MATURITY_STATUSES = new Set(["not_scored", "provisional", "established"]);

function assertCriteria(criteria) {
  if (!Array.isArray(criteria)) throw new Error("FAIL-FRAMEWORK-LENS-CRITERIA: criteria must be an array");
  const ids = new Set();
  for (const criterion of criteria) {
    if (!criterion || typeof criterion !== "object" || typeof criterion.criterion_id !== "string" || criterion.criterion_id.trim() === "") {
      throw new Error("FAIL-FRAMEWORK-LENS-CRITERIA: every criterion requires a non-blank canonical criterion_id");
    }
    const applicability = criterion.applicability ?? criterion.status;
    if (!CRITERION_STATUSES.has(applicability) || !MATURITY_STATUSES.has(criterion.maturity)) {
      throw new Error("FAIL-FRAMEWORK-LENS-CRITERIA: every criterion requires canonical status and maturity");
    }
    if (ids.has(criterion.criterion_id)) throw new Error(`FAIL-FRAMEWORK-LENS-CRITERIA: duplicate canonical criterion ${criterion.criterion_id}`);
    ids.add(criterion.criterion_id);
  }
}

function canonicalRefs(value) {
  return [...new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [])].sort();
}

function evidenceState(frameworkEvidence, lensId) {
  const value = frameworkEvidence?.[lensId];
  if (!value || typeof value !== "object") return null;
  if (value.status === "observed") return { observed: true, evidence_refs: canonicalRefs(value.evidence_refs) };
  if (value.applicability?.status === "applicable") {
    return { observed: true, evidence_refs: canonicalRefs(value.applicability.evidence_refs) };
  }
  return null;
}

function criterionApplicability(criterion) {
  return criterion.applicability ?? criterion.status;
}

function statusFor(mapped) {
  const applicable = mapped.filter((criterion) => criterionApplicability(criterion) === "applicable");
  if (applicable.length === 0) return "not_scored";
  if (applicable.every((criterion) => criterion.maturity === "established")) return "established";
  return "provisional";
}

function projectCriterion(criterion) {
  return Object.freeze({
    canonical_criterion_id: criterion.criterion_id,
    applicability: criterionApplicability(criterion),
    maturity: criterion.maturity,
    evidence_refs: canonicalRefs(criterion.evidence_refs),
  });
}

/**
 * Build explanatory framework views from already-evaluated canonical criteria.
 * This deliberately emits no numeric score/weight/aggregate fields: every view
 * reuses the assessment evidence and cannot contribute points a second time.
 */
function buildFrameworkLenses({ criteria, frameworkEvidence = {} } = {}) {
  assertCriteria(criteria);
  const byId = new Map(criteria.map((criterion) => [criterion.criterion_id, criterion]));
  return Object.freeze(FRAMEWORK_LENS_IDS.map((lensId) => {
    const definition = LENS_DEFINITIONS[lensId];
    const mapped = definition.criteria.filter((criterionId) => byId.has(criterionId)).map((criterionId) => byId.get(criterionId));
    const adoption = evidenceState(frameworkEvidence, lensId);
    let status = statusFor(mapped);
    let reason = "canonical assessment criteria are reused for this explanatory lens";
    if (definition.requires_authoritative_performance_evidence && !adoption) {
      status = "not_scored";
      reason = "DORA performance requires authoritative deployment and incident evidence; delivery prerequisites alone do not establish it";
    } else if (definition.requires_adoption_evidence && !adoption) {
      status = "not_scored";
      reason = "this lens needs explicit current framework-adoption evidence; repository code evidence alone is not a conformance claim";
    }
    const refs = canonicalRefs([...mapped.flatMap((criterion) => criterion.evidence_refs || []), ...(adoption?.evidence_refs || [])]);
    return Object.freeze({
      lens_id: lensId,
      label: definition.label,
      status,
      reason,
      criteria: Object.freeze(mapped.map(projectCriterion)),
      evidence_refs: refs,
    });
  }));
}

module.exports = {
  FRAMEWORK_LENS_VERSION,
  FRAMEWORK_LENS_IDS,
  buildFrameworkLenses,
};
