"use strict";

const {
  OWNER_IDS,
  RIA_OWNER,
  assertBaselineRef,
  assertEngineeringIntelligenceRef,
  assertSeiAssessmentRef,
  deepEqual,
  fail,
  stableStringify,
  validateAssessProjection,
} = require("./engineering-intelligence.js");
const { writeEngineeringIntelligenceArtifact } = require("./engineering-intelligence-writer.js");
const schema = require("./engineering-intelligence.schema.json");
const reportSchema = require("./assets/report-schema.json");
const { validateAgainstSchema } = require("../shared/software-engineering-intelligence/schema-validator.js");
const { validateOwnerReturn } = require("../shared/ria-owner-return/owner-return.js");

function assertOwnerAssessors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== OWNER_IDS.length || Object.keys(value).some((owner) => !OWNER_IDS.includes(owner)) ||
      OWNER_IDS.some((owner) => typeof value[owner] !== "function")) {
    fail("FAIL-RIA-OWNER-ASSESSMENT-SCHEMA", "owner_assessors must contain exactly the three canonical owner callbacks");
  }
  return value;
}

function assertOwnerReceipt(value, owner, envelope) {
  if (value?.schema_version === "ria.owner-return@1") {
    const validated = validateOwnerReturn(value, { owner, repository_revision: envelope.baseline_ref.repository_revision, input_binding_echo: envelope });
    if (!validated.ok) fail("FAIL-RIA-OWNER-ASSESSMENT-SCHEMA", validated.errors.join("; "));
    return validated.owner_ref;
  }
  const errors = validateAgainstSchema(value, { $defs: schema.$defs, $ref: "#/$defs/ownerAssessmentReceipt" });
  if (errors.length > 0) fail("FAIL-RIA-OWNER-ASSESSMENT-SCHEMA", errors.join("; "));
  const hasSeiAssessment = Object.hasOwn(envelope, "sei_assessment_ref");
  const exactSeiAssessmentEcho = hasSeiAssessment === Object.hasOwn(value, "sei_assessment_ref") &&
    (!hasSeiAssessment || deepEqual(value.sei_assessment_ref, envelope.sei_assessment_ref));
  if (value.owner_ref.owner !== owner || value.owner_ref.repository_revision !== envelope.baseline_ref.repository_revision ||
      !deepEqual(value.baseline_ref, envelope.baseline_ref) || !deepEqual(value.engineering_intelligence_ref, envelope.engineering_intelligence_ref) ||
      !exactSeiAssessmentEcho) {
    fail("FAIL-RIA-OWNER-ASSESSMENT-BINDING", "owner receipt must echo the exact baseline and supplied SEI evidence references for its own authority");
  }
  return structuredClone(value.owner_ref);
}

function validateAssessReport(value) {
  const schemaErrors = validateAgainstSchema(value, reportSchema);
  if (schemaErrors.length > 0) {
    return { ok: false, errors: schemaErrors.map((error) => `FAIL-RIA-ASSESS-REPORT-SCHEMA: ${error}`) };
  }
  try {
    let baseline;
    try {
      baseline = assertBaselineRef(value.baseline_ref, "FAIL-RIA-ASSESS-REPORT-SCHEMA");
    } catch (error) {
      throw new Error(`FAIL-RIA-ASSESS-REPORT-SCHEMA: ${error.message}`);
    }
    let intelligence;
    try {
      intelligence = assertEngineeringIntelligenceRef(value.engineering_intelligence_ref, "FAIL-RIA-ASSESS-REPORT-SCHEMA");
    } catch (error) {
      throw new Error(`FAIL-RIA-ASSESS-REPORT-BINDING: ${error.message}`);
    }
    if (!deepEqual(intelligence.baseline_binding, baseline) || intelligence.repository_revision !== baseline.repository_revision) {
      throw new Error("FAIL-RIA-ASSESS-REPORT-BINDING: engineering_intelligence_ref must bind the report baseline_ref and revision");
    }
    if (Object.hasOwn(value, "sei_assessment_ref")) {
      assertSeiAssessmentRef(value.sei_assessment_ref, { repository_revision: baseline.repository_revision });
    }
    if (value.assessment_refs.length !== OWNER_IDS.length) {
      throw new Error("FAIL-RIA-ASSESS-REPORT-CONTRACT: assessment_refs must contain exactly three owner references");
    }
    const owners = new Set();
    value.assessment_refs.forEach((ref, index) => {
      if (ref.repository_revision !== baseline.repository_revision) {
        throw new Error(`FAIL-RIA-ASSESS-REPORT-BINDING: assessment_refs[${index}] revision must match baseline_ref`);
      }
      if (owners.has(ref.owner)) {
        throw new Error(`FAIL-RIA-ASSESS-REPORT-CONTRACT: duplicate owner ${ref.owner}`);
      }
      owners.add(ref.owner);
    });
    if (!deepEqual([...owners].sort(), [...OWNER_IDS].sort())) {
      throw new Error("FAIL-RIA-ASSESS-REPORT-CONTRACT: assessment_refs must contain exactly the three canonical owners");
    }
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}

function runAssessWithEngineeringIntelligence(input) {
  const allowed = ["repository_root", "baseline_ref", "mission_id", "scope_hash", "compute_snapshot", "owner_assessors", "sei_assessment_ref"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    fail("FAIL-RIA-ASSESS-INPUT-SCHEMA", "assessment input contains unsupported fields");
  }
  const baseline = assertBaselineRef(input.baseline_ref, "FAIL-RIA-ASSESS-INPUT-SCHEMA");
  const ownerAssessors = assertOwnerAssessors(input.owner_assessors);
  const seiAssessmentRef = Object.hasOwn(input, "sei_assessment_ref")
    ? assertSeiAssessmentRef(input.sei_assessment_ref, { repository_revision: baseline.repository_revision })
    : undefined;
  const engineeringIntelligenceRef = assertEngineeringIntelligenceRef(writeEngineeringIntelligenceArtifact({
    repository_root: input.repository_root,
    baseline_ref: baseline,
    mission_id: input.mission_id,
    scope_hash: input.scope_hash,
    compute_snapshot: input.compute_snapshot,
  }));
  const envelopeBytes = stableStringify({
    baseline_ref: baseline,
    engineering_intelligence_ref: engineeringIntelligenceRef,
    ...(seiAssessmentRef ? { sei_assessment_ref: seiAssessmentRef } : {}),
  });
  const assessmentRefs = OWNER_IDS.map((owner) => {
    const envelope = JSON.parse(envelopeBytes);
    let receipt;
    try {
      receipt = ownerAssessors[owner](envelope);
    } catch (error) {
      if (error.message?.startsWith("FAIL-RIA-OWNER-ASSESSMENT-")) throw error;
      fail("FAIL-RIA-OWNER-ASSESSMENT", `${owner} failed: ${error.message ?? String(error)}`);
    }
    return assertOwnerReceipt(receipt, owner, envelope);
  });
  const projection = {
    stage: "ASSESS",
    owner: RIA_OWNER,
    baseline_ref: baseline,
    engineering_intelligence_ref: engineeringIntelligenceRef,
    ...(seiAssessmentRef ? { sei_assessment_ref: seiAssessmentRef } : {}),
    assessment_refs: assessmentRefs,
  };
  const validation = validateAssessProjection(projection);
  if (!validation.ok) fail("FAIL-RIA-ASSESS-PROJECTION", validation.errors.join("; "));
  return projection;
}

module.exports = { runAssessWithEngineeringIntelligence, validateAssessProjection, validateAssessReport };
