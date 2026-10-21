"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const canonicalSnapshot = require("./canonical-intelligence.json");
const { deriveRiskModelContractHash, materializeSnapshot } = require("./intelligence-engine.js");
const { compareSnapshots, validateTrendEnvelope } = require("./interpretation.js");
const { compilePolicy, validatePolicyProfile } = require("./policy.js");
const { evaluateProfiles } = require("./profiles.js");

function snapshot() {
  return structuredClone(canonicalSnapshot);
}

function heuristicRisk(snapshotValue, overrides = {}) {
  const revision = snapshotValue.repository.revision;
  return {
    risk_model_id: "heuristic-v1",
    model_version: "1.0.0",
    model_contract_hash: deriveRiskModelContractHash("heuristic-v1"),
    model_status: "heuristic",
    calibration: null,
    result: {
      result_id: `heuristic-v1:${revision}`,
      kind: "heuristic_hotspot_vectors",
      status: "available",
      repository_revision: revision,
      evidence_metric_ids: [snapshotValue.measurements[0].metric_id],
      evidence_refs: [snapshotValue.measurements[0].source.artifact_refs[0]],
      interpretation_boundary: "feature vectors and review-attention signals only",
      records: [],
    },
    ...overrides,
  };
}

function investigationRisk(snapshotValue, observationOverrides = {}) {
  const metric = snapshotValue.measurements[0];
  const evidenceRef = metric.source.artifact_refs[0];
  return {
    risk_model_id: "engineering-investigation-signals-v1",
    model_version: "1.0.0",
    model_contract_hash: deriveRiskModelContractHash("engineering-investigation-signals-v1"),
    model_status: "heuristic",
    calibration: null,
    result: {
      result_id: `engineering-investigation-signals-v1:${snapshotValue.repository.revision}`,
      kind: "engineering_investigation_signals",
      status: "available",
      repository_revision: snapshotValue.repository.revision,
      evidence_metric_ids: [metric.metric_id],
      evidence_refs: [evidenceRef],
      interpretation_boundary: "bounded repository-relative engineering investigation signals only; not defect, architecture, priority, or health verdicts",
      records: [{
        signal_id: `sha256:${"a".repeat(64)}`,
        signal_type: "bounded-test-signal",
        subject: metric.subject,
        observations: [
          { kind: "complexity", status: "measured", value: 0.8, evidence_refs: [evidenceRef], ...observationOverrides },
          { kind: "churn", status: "measured", value: 0.7, evidence_refs: [evidenceRef] },
        ],
        coverage: { observed: 2, required: 2, ratio: 1 },
        confidence: "high",
        evidence_refs: [evidenceRef],
        interpretation: "bounded factual intersection",
        suggested_investigation: "inspect the supporting evidence",
      }],
    },
  };
}

function riskFeature(snapshotValue, overrides = {}) {
  const metric = snapshotValue.measurements[0];
  return {
    metric_id: metric.metric_id,
    definition_id: metric.definition_id,
    value: metric.value,
    unit: metric.unit,
    measurement_status: metric.measurement.status,
    percentile: 1,
    cohort_size: 1,
    analyzer_identity: metric.analyzer_identity,
    analyzer_version: metric.analyzer_version,
    evidence_refs: [metric.source.artifact_refs[0]],
    interpretation: "observed metric",
    ...overrides,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function selfHashedEmptyPolicy(documentPath) {
  const source = {
    document_path: documentPath,
    digest: `sha256:${"a".repeat(64)}`,
  };
  const rules = [];
  const policy_profile_hash = `sha256:${crypto.createHash("sha256").update(stableStringify({
    policy_profile_version: "1.0.0",
    source,
    rules,
  })).digest("hex")}`;
  return {
    policy_profile_id: `policy-${policy_profile_hash.slice("sha256:".length, "sha256:".length + 24)}`,
    policy_profile_version: "1.0.0",
    policy_profile_hash,
    source,
    rules,
    summary: {
      status: "pass",
      counts: { pass: 0, fail: 0, partial: 0, unverifiable: 0, not_applicable: 0 },
      by_status: { pass: [], fail: [], partial: [], unverifiable: [], not_applicable: [] },
      hard_invariant_failures: [],
      hard_invariant_non_passes: [],
    },
  };
}

function policySource(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-semantic-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const documentPath = path.join(root, "engineering-policy.md");
  const bytes = Buffer.from("# Engineering Policy\n\nDeployments require review.\n", "utf8");
  fs.writeFileSync(documentPath, bytes);
  return {
    document_path: documentPath,
    expected_digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
    source_ref: { document_path: documentPath, locator: "#deployments-require-review" },
  };
}

function policyRule(source) {
  return {
    rule_id: "POL-SEMANTIC-001",
    source_refs: [structuredClone(source.source_ref)],
    category: "delivery",
    severity: "required",
    applicability: {
      status: "applicable",
      reason: "repository deploys to production",
      source_refs: [structuredClone(source.source_ref)],
    },
    verification: { method: "artifact", evidence_refs: ["receipt:POL-SEMANTIC-001"] },
    status: "pass",
  };
}

test("canonical materialization rejects direct derived-intelligence injections before identity creation", () => {
  const forgedProbability = snapshot();
  forgedProbability.risk_models = [{
    risk_model_id: "heuristic-v1",
    model_status: "validated",
    probability: 0.99,
  }];
  assert.throws(
    () => materializeSnapshot(forgedProbability),
    /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/,
  );

  const forgedSpace = snapshot();
  forgedSpace.profiles = [{ profile_id: "SPACE", overall_score: 99 }];
  assert.throws(
    () => materializeSnapshot(forgedSpace),
    /FAIL-SPACE-SINGLE-SCORE/,
  );

  const nestedUnknown = snapshot();
  const nested = heuristicRisk(nestedUnknown);
  nested.result.records = [{ subject: "file:src/index.js", unexpected: true }];
  nestedUnknown.risk_models = [nested];
  assert.throws(
    () => materializeSnapshot(nestedUnknown),
    /FAIL-DERIVED-INTELLIGENCE-SCHEMA.*FAIL-SCHEMA-CONTRACT|FAIL-SCHEMA-CONTRACT.*FAIL-DERIVED-INTELLIGENCE-SCHEMA/,
  );
});

test("investigation observations bind measurement status to the only permitted value shape", () => {
  const valid = snapshot();
  valid.risk_models = [investigationRisk(valid)];
  assert.doesNotThrow(() => materializeSnapshot(valid));

  const measuredNull = snapshot();
  measuredNull.risk_models = [investigationRisk(measuredNull, { value: null })];
  assert.throws(() => materializeSnapshot(measuredNull), /FAIL-(?:SCHEMA-CONTRACT|DERIVED-INTELLIGENCE-CONTRACT)/);

  const unavailableValue = snapshot();
  unavailableValue.risk_models = [investigationRisk(unavailableValue, { status: "unavailable", value: 0.8 })];
  assert.throws(() => materializeSnapshot(unavailableValue), /FAIL-(?:SCHEMA-CONTRACT|DERIVED-INTELLIGENCE-CONTRACT)/);
});

test("investigation observations persist strong partial numeric evidence only with bounded uncertainty", () => {
  const valid = snapshot();
  valid.risk_models = [investigationRisk(valid, {
    status: "degraded",
    value: 0.8,
    coverage: 0.95,
    confidence: 0.94,
    semantic_state: "strong-partial",
  })];
  valid.risk_models[0].result.records[0].confidence = "medium";
  assert.doesNotThrow(() => materializeSnapshot(valid));

  const overstated = structuredClone(valid);
  overstated.risk_models[0].result.records[0].confidence = "high";
  assert.throws(() => materializeSnapshot(overstated), /FAIL-(?:SCHEMA-CONTRACT|DERIVED-INTELLIGENCE-CONTRACT)/);

  const zeroCoverage = structuredClone(valid);
  zeroCoverage.risk_models[0].result.records[0].observations[0].coverage = 0;
  assert.throws(() => materializeSnapshot(zeroCoverage), /FAIL-(?:SCHEMA-CONTRACT|DERIVED-INTELLIGENCE-CONTRACT)/);

  const missingSemanticState = structuredClone(valid);
  delete missingSemanticState.risk_models[0].result.records[0].observations[0].semantic_state;
  assert.throws(() => materializeSnapshot(missingSemanticState), /FAIL-(?:SCHEMA-CONTRACT|DERIVED-INTELLIGENCE-CONTRACT)/);

  const duplicateKind = snapshot();
  duplicateKind.risk_models = [investigationRisk(duplicateKind)];
  duplicateKind.risk_models[0].result.records[0].observations[1].kind = "complexity";
  assert.throws(() => materializeSnapshot(duplicateKind), /FAIL-DERIVED-INTELLIGENCE-CONTRACT/);
});

test("risk-model interpretation boundaries are exact model-specific contract values", () => {
  const candidate = snapshot();
  const forged = heuristicRisk(candidate);
  forged.result.interpretation_boundary = "candidate priority is high";
  candidate.risk_models = [forged];

  assert.throws(
    () => materializeSnapshot(candidate),
    /FAIL-DERIVED-INTELLIGENCE-CONTRACT: .*interpretation_boundary does not match heuristic-v1/,
  );
});

test("validated and probability claims require non-overlapping, source-bound calibration and a declared model contract", () => {
  const candidate = snapshot();
  candidate.risk_models = [heuristicRisk(candidate, {
    model_status: "validated",
    calibration: {
      calibration_id: "calibration-1",
      calibration_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      method: "held-out replay",
      training_ids: ["commit:1"],
      holdout_ids: ["commit:1"],
      evidence_refs: [candidate.measurements[0].source.artifact_refs[0]],
    },
  })];
  assert.throws(() => materializeSnapshot(candidate), /FAIL-TRAIN-TEST-LEAKAGE/);
  assert.throws(() => materializeSnapshot(candidate), /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/);

  const probability = snapshot();
  probability.risk_models = [heuristicRisk(probability)];
  probability.risk_models[0].result.kind = "probability";
  probability.risk_models[0].result.records = [{
    subject: "file:src/index.js",
    probability: 0.99,
    evidence_metric_ids: [probability.measurements[0].metric_id],
    evidence_refs: [probability.measurements[0].source.artifact_refs[0]],
  }];
  assert.throws(() => materializeSnapshot(probability), /FAIL-HOTSPOT-CLAIM-WITHOUT-CALIBRATION/);
});

test("heuristic vector values, subjects, cohorts, percentiles, and signals are derived from snapshot evidence", () => {
  const candidate = snapshot();
  const forged = heuristicRisk(candidate);
  forged.result.records = [{
    subject: "file:forged.js",
    features: [riskFeature(candidate, {
      value: 999999,
      cohort_size: 999,
      percentile: 1,
    })],
    hotspot_signals: [{
      signal_id: "coincident-change-and-structure",
      basis_metric_ids: [candidate.measurements[0].metric_id],
      interpretation: "review-attention signal only; not a defect probability or candidate priority",
    }],
  }];
  candidate.risk_models = [forged];
  assert.throws(() => materializeSnapshot(candidate), /FAIL-DERIVED-INTELLIGENCE-(?:EVIDENCE|CONTRACT)/);
});

test("collector availability and metric aliases remain closed semantic inputs", () => {
  const availableWithReason = snapshot();
  availableWithReason.collectors[0].reason = "not allowed while available";
  assert.throws(() => materializeSnapshot(availableWithReason), /FAIL-COLLECTOR-CONTRACT/);

  const alias = snapshot();
  alias.measurements[0].metric_alias = "overall_score";
  assert.throws(() => materializeSnapshot(alias), /FAIL-METRIC-CONTRACT/);
});

test("framework profiles receive canonical identity metadata and reject direct SPACE score injection", () => {
  const profileSnapshot = snapshot();
  const metric = profileSnapshot.measurements[0];
  const result = evaluateProfiles(profileSnapshot, [{
    profile_id: "SPACE",
    evidence: [{
      kind: "metric-observation",
      dimension: "activity",
      status: "measured",
      metric_id: metric.metric_id,
      evidence_refs: [metric.source.artifact_refs[0]],
    }],
  }]).SPACE;
  assert.equal(result.profile_version, "1.0.0");
  assert.match(result.profile_contract_hash, /^sha256:[a-f0-9]{64}$/);

  profileSnapshot.profiles = [result];
  assert.doesNotThrow(() => materializeSnapshot(profileSnapshot));

  profileSnapshot.profiles[0].profile_contract_hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.throws(() => materializeSnapshot(profileSnapshot), /FAIL-PROFILE-IDENTITY-DRIFT/);
});

test("SPACE metric evidence and applicability state bind to real evidence without rejecting valid dimensions", () => {
  const validSnapshot = snapshot();
  const metric = validSnapshot.measurements[0];
  const validProfile = evaluateProfiles(validSnapshot, [{
    profile_id: "SPACE",
    evidence: [{
      kind: "metric-observation",
      dimension: "activity",
      status: "measured",
      metric_id: metric.metric_id,
      evidence_refs: [metric.source.artifact_refs[0]],
    }],
  }]).SPACE;
  validSnapshot.profiles = [validProfile];
  assert.doesNotThrow(() => materializeSnapshot(validSnapshot));

  const forgedKind = structuredClone(validSnapshot);
  forgedKind.profiles[0].dimensions.activity.evidence[0].kind = "sei.forged.evidence@999";
  assert.throws(
    () => materializeSnapshot(forgedKind),
    /FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE.*kind.*metric_id|FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE/,
    "profile evidence kind must bind to the resolved snapshot metric definition",
  );

  const forgedEvidence = snapshot();
  const forgedProfile = evaluateProfiles(forgedEvidence, [{
    profile_id: "SPACE",
    evidence: [{
      kind: "metric-observation",
      dimension: "activity",
      status: "measured",
      metric_id: forgedEvidence.measurements[0].metric_id,
      evidence_refs: ["forged:not-in-source"],
    }],
  }]).SPACE;
  assert.equal(forgedProfile.dimensions.activity.status, "unobservable");
  assert.deepEqual(forgedProfile.dimensions.activity.evidence_refs, []);
  assert.deepEqual(forgedProfile.applicability.evidence_refs, []);
  forgedEvidence.profiles = [forgedProfile];
  assert.doesNotThrow(() => materializeSnapshot(forgedEvidence));

  const contradictory = structuredClone(validSnapshot);
  contradictory.profiles[0].applicability = {
    status: "not_applicable",
    reason: "not applicable cannot retain a measured dimension",
    evidence_refs: [],
  };
  assert.throws(() => materializeSnapshot(contradictory), /FAIL-PROFILE-CONTRACT/);
});

test("SPACE cannot self-attest a measured dimension or applicability with nonmetric evidence", () => {
  const attackedSnapshot = snapshot();
  const metric = attackedSnapshot.measurements[0];
  attackedSnapshot.profiles = [evaluateProfiles(attackedSnapshot, [{
    profile_id: "SPACE",
    evidence: [{
      kind: "metric-observation",
      dimension: "activity",
      status: "measured",
      metric_id: metric.metric_id,
      evidence_refs: [metric.source.artifact_refs[0]],
    }],
  }]).SPACE];

  attackedSnapshot.profiles[0].applicability = {
    status: "applicable",
    reason: "attacker-supplied applicability claim",
    evidence_refs: ["attacker:unbound"],
  };
  attackedSnapshot.profiles[0].dimensions.performance = {
    status: "measured",
    evidence: [{
      kind: "attacker-evidence",
      dimension: "performance",
      status: "measured",
      evidence_refs: ["attacker:unbound"],
    }],
    evidence_refs: ["attacker:unbound"],
  };

  let failure = null;
  try {
    materializeSnapshot(attackedSnapshot);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "the hostile profile must not materialize");
  assert.match(failure.message, /FAIL-DERIVED-INTELLIGENCE-WITHOUT-EVIDENCE/);
  assert.match(failure.message, /dimensions\.performance\.evidence\[0\]\.metric_id must bind profile evidence/);
  assert.match(failure.message, /applicability\.evidence_refs is not bound to authoritative profile evidence/);
});

test("policy compilation returns a closed hash-bound profile and rejects nested output injection", (t) => {
  const source = policySource(t);
  const { source_ref: sourceRef, ...compileSource } = source;
  const profile = compilePolicy({ ...compileSource, rule_map: [policyRule({ ...source, source_ref: sourceRef })] });
  assert.match(profile.policy_profile_id, /^policy-/);
  assert.match(profile.policy_profile_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(validatePolicyProfile(profile), { ok: true, errors: [] });

  const injected = structuredClone(profile);
  injected.rules[0].overall_score = 99;
  assert.equal(validatePolicyProfile(injected).ok, false);
  assert.match(validatePolicyProfile(injected).errors.join("\n"), /FAIL-POLICY-CONTRACT/);

  const forgedEmpty = selfHashedEmptyPolicy(path.join(os.tmpdir(), "forged-policy.md"));
  assert.equal(validatePolicyProfile(forgedEmpty).ok, false);
  assert.match(validatePolicyProfile(forgedEmpty).errors.join("\n"), /FAIL-POLICY-CONTRACT/);
});

test("trend envelopes are closed standalone outputs", () => {
  const prior = snapshot();
  const current = snapshot();
  current.repository.revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  current.repository.history_boundary.end = current.repository.revision;
  current.measurements[0].repository_revision = current.repository.revision;
  current.measurements[0].source.repository_revision = current.repository.revision;
  current.measurements[0].window.end = current.repository.revision;
  current.run_metadata.cache.repository_revision = current.repository.revision;
  current.run_metadata.cache.history_boundary.end = current.repository.revision;
  const result = compareSnapshots(materializeSnapshot(prior), materializeSnapshot(current));
  assert.deepEqual(validateTrendEnvelope(result), { ok: true, errors: [] });

  const injected = structuredClone(result);
  injected.trends[0].overall_score = 99;
  assert.equal(validateTrendEnvelope(injected).ok, false);
  assert.match(validateTrendEnvelope(injected).errors.join("\n"), /FAIL-TREND-CONTRACT/);

  const forgedComparable = structuredClone(result);
  forgedComparable.previous_snapshot_id = null;
  forgedComparable.current_snapshot_id = null;
  forgedComparable.reason = "forged comparable envelope reason";
  assert.equal(validateTrendEnvelope(forgedComparable).ok, false);
  assert.match(validateTrendEnvelope(forgedComparable).errors.join("\n"), /FAIL-TREND-CONTRACT/);
});

test("duplicate metric provenance references fail before canonical snapshot identity", () => {
  const duplicateRefs = snapshot();
  duplicateRefs.measurements[0].source.artifact_refs.push(duplicateRefs.measurements[0].source.artifact_refs[0]);
  assert.throws(() => materializeSnapshot(duplicateRefs), /FAIL-DUPLICATE-ID/);
});
