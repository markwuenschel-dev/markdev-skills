"use strict";

// Public contract: collectAdapterEvidence({ repository_revision,
// configuration_hash, history_window, adapters }) returns M2 collector and
// measurement records for the fixed adapter IDs below. Every adapter is a
// closed, normalized envelope containing its stable ID/version, typed payload,
// exact revision/configuration/window binding, SHA-256 payload binding, and
// completeness/coverage declaration. This module deliberately does not read
// networks, files, provider APIs, XML, LCOV, or other raw formats. Timing
// percentiles use deterministic nearest-rank selection; absent/partial typed
// facts stay null and unavailable rather than becoming a proxy health score.
const crypto = require("node:crypto");
const { reduceDependencyTopology } = require("./dependency-topology.js");
const ADAPTER_VERSION = "1.0.0";
const FULL_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONFIGURATION_HASH = /^[a-f0-9]{64}$/;
const RFC3339_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

const ADAPTER_SPECS = Object.freeze([
  Object.freeze({
    id: "dependency-topology",
    kind: "dependency_topology",
    analyzer_identity: "sei.adapter.dependency-topology@1",
    metrics: Object.freeze([
      ["dependency.node_count", "sei.adapter.dependency.node_count@1", "dependency_topology", "count"],
      ["dependency.edge_count", "sei.adapter.dependency.edge_count@1", "dependency_topology", "count"],
      ["dependency.scc_count", "sei.adapter.dependency.scc_count@1", "dependency_topology", "count"],
      ["dependency.cyclic_scc_count", "sei.adapter.dependency.cyclic_scc_count@1", "dependency_topology", "count"],
      ["dependency.cyclic_node_count", "sei.adapter.dependency.cyclic_node_count@1", "dependency_topology", "count"],
      ["dependency.fan_in", "sei.adapter.dependency.fan_in@1", "dependency_topology", "count"],
      ["dependency.fan_out", "sei.adapter.dependency.fan_out@1", "dependency_topology", "count"],
      ["dependency.density", "sei.adapter.dependency.density@1", "dependency_topology", "ratio"],
      ["dependency.centrality", "sei.adapter.dependency.centrality@1", "dependency_topology", "normalized-centrality"],
    ]),
  }),
  Object.freeze({
    id: "deployment-events",
    kind: "deployment_events",
    analyzer_identity: "sei.adapter.deployment-events@1",
    metrics: Object.freeze([
      ["deployment.started_count", "sei.adapter.deployment.started_count@1", "deployment_events", "count"],
      ["deployment.succeeded_count", "sei.adapter.deployment.succeeded_count@1", "deployment_events", "count"],
      ["deployment.failed_count", "sei.adapter.deployment.failed_count@1", "deployment_events", "count"],
      ["deployment.rollback_count", "sei.adapter.deployment.rollback_count@1", "deployment_events", "count"],
      ["deployment.duration_p50_ms", "sei.adapter.deployment.duration_p50_ms@1", "deployment_events", "milliseconds"],
      ["deployment.duration_p75_ms", "sei.adapter.deployment.duration_p75_ms@1", "deployment_events", "milliseconds"],
      ["deployment.duration_p90_ms", "sei.adapter.deployment.duration_p90_ms@1", "deployment_events", "milliseconds"],
      ["deployment.duration_p95_ms", "sei.adapter.deployment.duration_p95_ms@1", "deployment_events", "milliseconds"],
    ]),
  }),
  Object.freeze({
    id: "kanban-work-item-flow",
    kind: "work_item_workflow",
    analyzer_identity: "sei.kanban-work-item-flow@1",
    source_kind: "typed-authoritative-work-item-flow",
    metrics: Object.freeze([
      ["kanban.definition_of_workflow", "sei.kanban.definition_of_workflow@1", "workflow_definition", "definition"],
      ["kanban.transition_records", "sei.kanban.transition_records@1", "workflow_transitions", "records"],
      ["kanban.wip", "sei.kanban.wip@1", "flow", "items"],
      ["kanban.throughput", "sei.kanban.throughput@1", "flow", "items"],
      ["kanban.work_item_age", "sei.kanban.work_item_age@1", "flow", "milliseconds"],
      ["kanban.cycle_time", "sei.kanban.cycle_time@1", "flow", "milliseconds"],
    ]),
  }),
  Object.freeze({
    id: "feedback-timing",
    kind: "feedback_timing",
    analyzer_identity: "sei.adapter.feedback-timing@1",
    metrics: Object.freeze([
      ["feedback.sample_count", "sei.adapter.feedback.sample_count@1", "feedback_timing", "count"],
      ["feedback.first_response_p50_ms", "sei.adapter.feedback.first_response_p50_ms@1", "feedback_timing", "milliseconds"],
      ["feedback.first_response_p75_ms", "sei.adapter.feedback.first_response_p75_ms@1", "feedback_timing", "milliseconds"],
      ["feedback.first_response_p90_ms", "sei.adapter.feedback.first_response_p90_ms@1", "feedback_timing", "milliseconds"],
      ["feedback.first_response_p95_ms", "sei.adapter.feedback.first_response_p95_ms@1", "feedback_timing", "milliseconds"],
      ["feedback.resolution_p50_ms", "sei.adapter.feedback.resolution_p50_ms@1", "feedback_timing", "milliseconds"],
      ["feedback.resolution_p75_ms", "sei.adapter.feedback.resolution_p75_ms@1", "feedback_timing", "milliseconds"],
      ["feedback.resolution_p90_ms", "sei.adapter.feedback.resolution_p90_ms@1", "feedback_timing", "milliseconds"],
      ["feedback.resolution_p95_ms", "sei.adapter.feedback.resolution_p95_ms@1", "feedback_timing", "milliseconds"],
    ]),
  }),
  Object.freeze({
    id: "pr-flow",
    kind: "pr_flow",
    analyzer_identity: "sei.adapter.pr-flow@1",
    metrics: Object.freeze([
      ["flow.pr_count", "sei.adapter.flow.pr_count@1", "pr_flow", "count"],
      ["flow.pr_cycle_p50_ms", "sei.adapter.flow.pr_cycle_p50_ms@1", "pr_flow", "milliseconds"],
      ["flow.pr_cycle_p75_ms", "sei.adapter.flow.pr_cycle_p75_ms@1", "pr_flow", "milliseconds"],
      ["flow.pr_cycle_p90_ms", "sei.adapter.flow.pr_cycle_p90_ms@1", "pr_flow", "milliseconds"],
      ["flow.pr_cycle_p95_ms", "sei.adapter.flow.pr_cycle_p95_ms@1", "pr_flow", "milliseconds"],
      ["flow.first_review_p50_ms", "sei.adapter.flow.first_review_p50_ms@1", "pr_flow", "milliseconds"],
      ["flow.first_review_p75_ms", "sei.adapter.flow.first_review_p75_ms@1", "pr_flow", "milliseconds"],
      ["flow.first_review_p90_ms", "sei.adapter.flow.first_review_p90_ms@1", "pr_flow", "milliseconds"],
      ["flow.first_review_p95_ms", "sei.adapter.flow.first_review_p95_ms@1", "pr_flow", "milliseconds"],
      ["flow.review_p50_ms", "sei.adapter.flow.review_p50_ms@1", "pr_flow", "milliseconds"],
      ["flow.review_p75_ms", "sei.adapter.flow.review_p75_ms@1", "pr_flow", "milliseconds"],
      ["flow.review_p90_ms", "sei.adapter.flow.review_p90_ms@1", "pr_flow", "milliseconds"],
      ["flow.review_p95_ms", "sei.adapter.flow.review_p95_ms@1", "pr_flow", "milliseconds"],
      ["flow.merge_p50_ms", "sei.adapter.flow.merge_p50_ms@1", "pr_flow", "milliseconds"],
      ["flow.merge_p75_ms", "sei.adapter.flow.merge_p75_ms@1", "pr_flow", "milliseconds"],
      ["flow.merge_p90_ms", "sei.adapter.flow.merge_p90_ms@1", "pr_flow", "milliseconds"],
      ["flow.merge_p95_ms", "sei.adapter.flow.merge_p95_ms@1", "pr_flow", "milliseconds"],
    ]),
  }),
  Object.freeze({
    id: "verification-summary",
    kind: "verification_summary",
    analyzer_identity: "sei.adapter.verification-summary@1",
    metrics: Object.freeze([
      ["verification.tests_total", "sei.adapter.verification.tests_total@1", "verification_evidence", "count"],
      ["verification.tests_passed", "sei.adapter.verification.tests_passed@1", "verification_evidence", "count"],
      ["verification.tests_failed", "sei.adapter.verification.tests_failed@1", "verification_evidence", "count"],
      ["verification.duration_ms", "sei.adapter.verification.duration_ms@1", "verification_evidence", "milliseconds"],
      ["verification.statement_coverage", "sei.adapter.verification.statement_coverage@1", "verification_evidence", "ratio"],
      ["verification.branch_coverage", "sei.adapter.verification.branch_coverage@1", "verification_evidence", "ratio"],
    ]),
  }),
  Object.freeze({
    id: "assessment-evidence",
    kind: "assessment_evidence",
    analyzer_identity: "sei.adapter.assessment-evidence@1",
    source_kind: "typed-authoritative-assessment-evidence",
    metrics: Object.freeze([
      ["assessment.failure_explicitness", "sei.assessment.failure_explicitness@1", "assessment_evidence", "ratio"],
      ["assessment.delivery.release_configuration", "sei.assessment.delivery.release_configuration@1", "assessment_evidence", "state"],
      ["assessment.delivery.reproducibility_inputs", "sei.assessment.delivery.reproducibility_inputs@1", "assessment_evidence", "state"],
      ["assessment.delivery.feedback_flow", "sei.assessment.delivery.feedback_flow@1", "assessment_evidence", "ratio"],
      ["assessment.verification.change_verification", "sei.assessment.verification.change_verification@1", "assessment_evidence", "ratio"],
      ["assessment.reliability.failure_handling", "sei.assessment.reliability.failure_handling@1", "assessment_evidence", "ratio"],
      ["assessment.reliability.operational_readiness", "sei.assessment.reliability.operational_readiness@1", "assessment_evidence", "ratio"],
      ["assessment.reliability.recovery_evidence", "sei.assessment.reliability.recovery_evidence@1", "assessment_evidence", "state"],
      ["assessment.reliability.observability", "sei.assessment.reliability.observability@1", "assessment_evidence", "ratio"],
      ["assessment.security.secret_findings", "sei.assessment.security.secret_findings@1", "assessment_evidence", "findings"],
      ["assessment.security.dependency_hygiene", "sei.assessment.security.dependency_hygiene@1", "assessment_evidence", "ratio"],
      ["assessment.security.verification", "sei.assessment.security.verification@1", "assessment_evidence", "state"],
      ["assessment.developer.local_feedback", "sei.assessment.developer.local_feedback@1", "assessment_evidence", "state"],
      ["assessment.developer.configuration_ergonomics", "sei.assessment.developer.configuration_ergonomics@1", "assessment_evidence", "ratio"],
      ["assessment.developer.flow_friction", "sei.assessment.developer.flow_friction@1", "assessment_evidence", "days"],
      ["assessment.documentation.repository_overview", "sei.assessment.documentation.repository_overview@1", "assessment_evidence", "state"],
      ["assessment.documentation.contracts_and_runbooks", "sei.assessment.documentation.contracts_and_runbooks@1", "assessment_evidence", "ratio"],
      ["assessment.documentation.change_context", "sei.assessment.documentation.change_context@1", "assessment_evidence", "ratio"],
      ["assessment.documentation.onboarding_discoverability", "sei.assessment.documentation.onboarding_discoverability@1", "assessment_evidence", "state"],
    ]),
  }),
]);

const DORA_DEPLOYMENT_SPEC = Object.freeze({
  id: "dora-deployment-evidence",
  kind: "typed_authoritative_deployment",
  analyzer_identity: "sei.dora-deployment-evidence@1",
  source_kind: "typed-authoritative-deployment",
  metrics: Object.freeze([
    ["dora.change_lead_time", "sei.dora.change_lead_time@1", "delivery_performance", "milliseconds"],
    ["dora.deployment_frequency", "sei.dora.deployment_frequency@1", "delivery_performance", "deployments_per_window"],
    ["dora.failed_deployment_recovery_time", "sei.dora.failed_deployment_recovery_time@1", "delivery_performance", "milliseconds"],
    ["dora.change_fail_rate", "sei.dora.change_fail_rate@1", "delivery_performance", "ratio"],
    ["dora.deployment_rework_rate", "sei.dora.deployment_rework_rate@1", "delivery_performance", "ratio"],
  ]),
});

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(message) {
  throw new Error(`FAIL-ADAPTER-CONTRACT: ${message}`);
}

function validateClosedKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not declared`);
  }
}

function normalizeBase(input) {
  validateClosedKeys(input, ["repository_revision", "configuration_hash", "history_window", "adapters"], "input");
  if (typeof input.repository_revision !== "string" || !FULL_REVISION.test(input.repository_revision)) {
    fail("repository_revision must be a full lowercase Git revision");
  }
  if (typeof input.configuration_hash !== "string" || !CONFIGURATION_HASH.test(input.configuration_hash)) {
    fail("configuration_hash must be a lowercase SHA-256 hex digest");
  }
  validateClosedKeys(input.history_window, ["kind", "start", "end"], "history_window");
  if (!new Set(["revision", "revision-range"]).has(input.history_window.kind)) fail("history_window.kind is unsupported");
  if (input.history_window.start !== null && !isNonBlankString(input.history_window.start)) fail("history_window.start must be null or nonblank");
  if (input.history_window.end !== input.repository_revision) fail("history_window.end must equal repository_revision");
  return {
    repository_revision: input.repository_revision,
    configuration_hash: input.configuration_hash,
    history_window: {
      kind: input.history_window.kind,
      start: input.history_window.start,
      end: input.history_window.end,
    },
    adapters: input.adapters,
  };
}

function collectorRecord(spec, status, reason = null) {
  return {
    collector_id: spec.id,
    collector_version: ADAPTER_VERSION,
    status,
    analyzer_identity: spec.analyzer_identity,
    analyzer_version: ADAPTER_VERSION,
    reason,
  };
}

function metricRecord(base, spec, definition, options) {
  const observed = options.status === "measured" || options.status === "inferred";
  const artifactRef = options.artifact_ref ?? `adapter:${spec.id}:${options.status}`;
  return {
    metric_id: definition[0],
    definition_id: definition[1],
    family: definition[2],
    subject: `repository:adapter-evidence`,
    repository_revision: base.repository_revision,
    value: observed ? options.value : null,
    unit: definition[3],
    measurement: {
      status: options.status,
      completeness: observed ? options.completeness : 0,
      confidence: observed ? options.confidence : 0,
      reason: observed ? null : options.reason,
    },
    source: {
      kind: spec.source_kind ?? "typed-adapter",
      collector_id: spec.id,
      collector_version: ADAPTER_VERSION,
      repository_revision: base.repository_revision,
      command: null,
      artifact_refs: [artifactRef],
      evidence_refs: options.evidence_refs ?? [artifactRef],
    },
    scope: {
      kind: "repository",
      path: ".",
      language: null,
      generated_code: false,
      included_in_human_maintainability: true,
    },
    window: structuredClone(base.history_window),
    analyzer_identity: spec.analyzer_identity,
    analyzer_version: ADAPTER_VERSION,
    comparability: {
      analyzer_identity: spec.analyzer_identity,
      analyzer_version: ADAPTER_VERSION,
      configuration_hash: base.configuration_hash,
      compatible_with_prior: false,
      reason: "adapter evidence requires an exact artifact, revision, and configuration binding",
    },
  };
}

function unavailableResult(base, spec, reason) {
  return {
    collector: collectorRecord(spec, "unavailable", reason),
    metrics: spec.metrics.map((definition) => metricRecord(base, spec, definition, {
      status: "unavailable",
      reason,
    })),
  };
}

function adapterError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalPayload(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalPayload(item)).sort((left, right) => stableCompare(stableStringify(left), stableStringify(right)));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort(stableCompare).map((key) => [key, canonicalPayload(value[key])]));
  }
  return value;
}

function payloadDigest(payload) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(canonicalPayload(payload))).digest("hex")}`;
}

function sameStableValue(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function validateDeclaredFraction(value, label, allowedStates) {
  validateClosedKeys(value, ["state", "fraction"], label);
  if (!allowedStates.has(value.state)) throw adapterError("FAIL-ADAPTER-MALFORMED", `${label}.state is unsupported`);
  if (typeof value.fraction !== "number" || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", `${label}.fraction must be between zero and one`);
  }
  if (value.state === "complete" && value.fraction !== 1) throw adapterError("FAIL-ADAPTER-MALFORMED", `${label}.complete requires fraction one`);
  if (value.state === "partial" && value.fraction >= 1) throw adapterError("FAIL-ADAPTER-MALFORMED", `${label}.partial requires fraction below one`);
  return { state: value.state, fraction: value.fraction };
}

function validateCoverage(value) {
  validateClosedKeys(value, ["scope", "fraction"], "coverage");
  if (!new Set(["repository", "partial"]).has(value.scope)) throw adapterError("FAIL-ADAPTER-MALFORMED", "coverage.scope is unsupported");
  if (typeof value.fraction !== "number" || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", "coverage.fraction must be between zero and one");
  }
  if (value.scope === "repository" && value.fraction !== 1) throw adapterError("FAIL-ADAPTER-MALFORMED", "repository coverage requires fraction one");
  if (value.scope === "partial" && value.fraction >= 1) throw adapterError("FAIL-ADAPTER-MALFORMED", "partial coverage requires fraction below one");
  return { scope: value.scope, fraction: value.fraction };
}

function envelopeBelongsToSpec(value, spec) {
  return isRecord(value) && (value.adapter_id === spec.id || value.kind === spec.kind);
}

function normalizeAdapterEnvelope(base, spec, value, supportedFormats) {
  validateClosedKeys(value, [
    "adapter_id",
    "adapter_version",
    "kind",
    "format",
    "artifact_ref",
    "artifact_sha256",
    "repository_revision",
    "configuration_hash",
    "history_window",
    "completeness",
    "coverage",
    "payload",
  ], `${spec.id} adapter`);
  if (value.adapter_id !== spec.id || value.kind !== spec.kind || value.adapter_version !== ADAPTER_VERSION) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", `${spec.id} adapter identity, kind, or version is not supported`);
  }
  if (!supportedFormats.has(value.format)) {
    throw adapterError("FAIL-ADAPTER-UNSUPPORTED-FORMAT", `${spec.id} format is unsupported`);
  }
  if (!isNonBlankString(value.artifact_ref) || typeof value.artifact_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.artifact_sha256)) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", `${spec.id} artifact reference and SHA-256 are required`);
  }
  if (value.repository_revision !== base.repository_revision) {
    throw adapterError("FAIL-ADAPTER-FOREIGN-REVISION", `${spec.id} artifact revision does not match repository_revision`);
  }
  if (value.configuration_hash !== base.configuration_hash) {
    throw adapterError("FAIL-ADAPTER-FOREIGN-CONFIGURATION", `${spec.id} artifact configuration hash does not match`);
  }
  validateClosedKeys(value.history_window, ["kind", "start", "end"], `${spec.id}.history_window`);
  if (!sameStableValue(value.history_window, base.history_window)) {
    throw adapterError("FAIL-ADAPTER-FOREIGN-WINDOW", `${spec.id} artifact history window does not match`);
  }
  const completeness = validateDeclaredFraction(value.completeness, `${spec.id}.completeness`, new Set(["complete", "partial"]));
  const coverage = validateCoverage(value.coverage);
  if (!isRecord(value.payload)) throw adapterError("FAIL-ADAPTER-MALFORMED", `${spec.id} payload must be a typed object`);
  if (value.artifact_sha256 !== payloadDigest(value.payload)) {
    throw adapterError("FAIL-ADAPTER-HASH-MISMATCH", `${spec.id} artifact SHA-256 does not bind the typed payload`);
  }
  return {
    ...structuredClone(value),
    completeness,
    coverage,
  };
}

function unavailableMetricResult(base, spec, definition, reason, artifactRef) {
  return metricRecord(base, spec, definition, {
    status: "unavailable",
    reason,
    artifact_ref: artifactRef,
  });
}

function unverifiableResult(base, spec, reason, artifactRef = `adapter:${spec.id}:unverifiable`) {
  return {
    collector: collectorRecord(spec, "degraded", reason),
    metrics: spec.metrics.map((definition) => metricRecord(base, spec, definition, {
      status: "unverifiable",
      reason,
      artifact_ref: artifactRef,
    })),
  };
}

function failureArtifactRef(spec, candidate) {
  return isRecord(candidate) && isNonBlankString(candidate.artifact_ref)
    ? candidate.artifact_ref
    : `adapter:${spec.id}:unverifiable`;
}

function resultFromValues(base, spec, envelope, values) {
  const completeness = Math.min(envelope.completeness.fraction, envelope.coverage.fraction);
  const metrics = spec.metrics.map((definition) => {
    const metricId = definition[0];
    const detail = values.get(metricId);
    if (!detail || detail.value === null) {
      return unavailableMetricResult(base, spec, definition, detail?.reason ?? "FAIL-ADAPTER-UNSUPPORTED-METRIC: no typed evidence was supplied", envelope.artifact_ref);
    }
    return metricRecord(base, spec, definition, {
      status: "measured",
      value: detail.value,
      completeness,
      confidence: completeness,
      artifact_ref: envelope.artifact_ref,
      evidence_refs: detail.evidence_refs ?? [envelope.artifact_ref, envelope.artifact_sha256],
    });
  });
  const unavailable = metrics.some((metric) => metric.measurement.status === "unavailable");
  const partial = envelope.completeness.state === "partial" || envelope.coverage.scope === "partial" || unavailable;
  return {
    collector: collectorRecord(
      spec,
      partial ? "degraded" : "available",
      partial ? "FAIL-ADAPTER-PARTIAL: declared coverage or supported metric set is partial" : null,
    ),
    metrics,
  };
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function verificationFacts(payload) {
  validateClosedKeys(payload, ["tests", "coverage"], "verification summary payload");
  if (payload.tests === undefined && payload.coverage === undefined) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", "verification summary requires tests or coverage facts");
  }
  const values = new Map();
  if (payload.tests === undefined) {
    for (const metricId of ["verification.tests_total", "verification.tests_passed", "verification.tests_failed", "verification.duration_ms"]) {
      values.set(metricId, { value: null, reason: "FAIL-ADAPTER-UNSUPPORTED-METRIC: this normalized summary contains no test outcome facts" });
    }
  } else {
    validateClosedKeys(payload.tests, ["total", "passed", "failed", "skipped", "duration_ms"], "verification tests");
    const { total, passed, failed, skipped, duration_ms: durationMs } = payload.tests;
    if (![total, passed, failed, skipped].every(nonNegativeInteger) || !finiteNonNegative(durationMs) || passed + failed + skipped !== total) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "verification test counts and duration must be coherent nonnegative facts");
    }
    values.set("verification.tests_total", { value: total });
    values.set("verification.tests_passed", { value: passed });
    values.set("verification.tests_failed", { value: failed });
    values.set("verification.duration_ms", { value: rounded(durationMs) });
  }

  if (payload.coverage === undefined) {
    for (const metricId of ["verification.statement_coverage", "verification.branch_coverage"]) {
      values.set(metricId, { value: null, reason: "FAIL-ADAPTER-UNSUPPORTED-METRIC: this normalized summary contains no coverage facts" });
    }
  } else {
    validateClosedKeys(payload.coverage, ["statements", "branches"], "verification coverage");
    for (const [field, metricId] of [["statements", "verification.statement_coverage"], ["branches", "verification.branch_coverage"]]) {
      const coverage = payload.coverage[field];
      if (coverage === undefined) {
        values.set(metricId, { value: null, reason: `FAIL-ADAPTER-UNSUPPORTED-METRIC: no normalized ${field} coverage was supplied` });
        continue;
      }
      validateClosedKeys(coverage, ["covered", "total"], `verification coverage.${field}`);
      if (!nonNegativeInteger(coverage.covered) || !nonNegativeInteger(coverage.total) || coverage.covered > coverage.total) {
        throw adapterError("FAIL-ADAPTER-MALFORMED", `${field} coverage counts must be coherent nonnegative integers`);
      }
      if (coverage.total === 0) {
        throw adapterError("FAIL-ADAPTER-COVERAGE-THEATER", `${field} coverage cannot claim a zero denominator`);
      }
      values.set(metricId, { value: rounded(coverage.covered / coverage.total) });
    }
  }
  return values;
}

function assessmentEvidenceFacts(payload, spec) {
  validateClosedKeys(payload, ["facts"], "assessment evidence payload");
  if (!Array.isArray(payload.facts) || payload.facts.length === 0) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", "assessment evidence requires a nonempty facts array");
  }
  const allowed = new Map(spec.metrics.map(([metricId, definitionId]) => [metricId, definitionId]));
  const seen = new Set();
  const values = new Map();
  for (const fact of payload.facts) {
    validateClosedKeys(fact, ["metric_id", "value", "evidence_refs"], "assessment evidence fact");
    if (!isNonBlankString(fact.metric_id) || !allowed.has(fact.metric_id) || seen.has(fact.metric_id)) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "assessment evidence facts must use unique declared metric IDs");
    }
    if (!(typeof fact.value === "boolean" || (typeof fact.value === "number" && Number.isFinite(fact.value) && fact.value >= 0))) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "assessment evidence fact values must be finite nonnegative numbers or booleans");
    }
    if (Array.isArray(fact.evidence_refs) && (fact.evidence_refs.length === 0 || !fact.evidence_refs.every(isNonBlankString))) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "assessment evidence refs must be nonempty strings");
    }
    seen.add(fact.metric_id);
    values.set(fact.metric_id, { value: fact.value, evidence_refs: fact.evidence_refs });
  }
  return values;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function setTimingPercentiles(values, prefix, timings, expectedCount, label) {
  const quantiles = [["p50", 0.5], ["p75", 0.75], ["p90", 0.9], ["p95", 0.95]];
  if (expectedCount === 0 || timings.length !== expectedCount) {
    for (const [name] of quantiles) {
      values.set(`${prefix}_${name}_ms`, {
        value: null,
        reason: `FAIL-ADAPTER-PARTIAL: complete typed ${label} timing was not supplied for every declared record`,
      });
    }
    return;
  }
  for (const [name, fraction] of quantiles) {
    values.set(`${prefix}_${name}_ms`, { value: rounded(percentile(timings, fraction)) });
  }
}

function feedbackFacts(payload) {
  validateClosedKeys(payload, ["samples"], "feedback timing payload");
  if (!Array.isArray(payload.samples)) throw adapterError("FAIL-ADAPTER-MALFORMED", "feedback timing requires a typed samples array");
  const sampleIds = new Set();
  const firstResponse = [];
  const resolution = [];
  for (const sample of payload.samples) {
    validateClosedKeys(sample, ["sample_id", "first_response_ms", "resolution_ms"], "feedback timing sample");
    if (!isNonBlankString(sample.sample_id) || sampleIds.has(sample.sample_id) || !finiteNonNegative(sample.first_response_ms)) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "feedback timing samples require unique IDs and nonnegative first-response timing");
    }
    if (sample.resolution_ms !== undefined) {
      if (!finiteNonNegative(sample.resolution_ms) || sample.resolution_ms < sample.first_response_ms) {
        throw adapterError("FAIL-ADAPTER-MALFORMED", "feedback resolution timing must be nonnegative and no earlier than first response");
      }
      resolution.push(sample.resolution_ms);
    }
    sampleIds.add(sample.sample_id);
    firstResponse.push(sample.first_response_ms);
  }
  const values = new Map([["feedback.sample_count", { value: payload.samples.length }]]);
  setTimingPercentiles(values, "feedback.first_response", firstResponse, payload.samples.length, "first-response");
  setTimingPercentiles(values, "feedback.resolution", resolution, payload.samples.length, "resolution");
  return values;
}

function flowFacts(payload) {
  validateClosedKeys(payload, ["pull_requests"], "PR flow payload");
  if (!Array.isArray(payload.pull_requests)) throw adapterError("FAIL-ADAPTER-MALFORMED", "PR flow requires a typed pull_requests array");
  const ids = new Set();
  const timingFields = [
    ["cycle_time_ms", "flow.pr_cycle", "PR cycle"],
    ["first_review_time_ms", "flow.first_review", "first review"],
    ["review_time_ms", "flow.review", "review"],
    ["merge_time_ms", "flow.merge", "merge"],
  ];
  const timings = Object.fromEntries(timingFields.map(([field]) => [field, []]));
  for (const pullRequest of payload.pull_requests) {
    validateClosedKeys(pullRequest, ["pr_id", "merged", "cycle_time_ms", "first_review_time_ms", "review_time_ms", "merge_time_ms"], "PR flow record");
    if (!isNonBlankString(pullRequest.pr_id) || ids.has(pullRequest.pr_id)) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "PR flow records require unique nonblank PR IDs");
    }
    if (pullRequest.merged !== undefined && typeof pullRequest.merged !== "boolean") {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "PR flow merged must be boolean when supplied");
    }
    if (pullRequest.merge_time_ms !== undefined && pullRequest.merged !== true) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "PR merge timing requires an explicit merged record");
    }
    for (const [field] of timingFields) {
      if (pullRequest[field] !== undefined) {
        if (!finiteNonNegative(pullRequest[field])) throw adapterError("FAIL-ADAPTER-MALFORMED", `PR flow ${field} must be nonnegative`);
        timings[field].push(pullRequest[field]);
      }
    }
    ids.add(pullRequest.pr_id);
  }
  const values = new Map([["flow.pr_count", { value: payload.pull_requests.length }]]);
  for (const [field, prefix, label] of timingFields) {
    setTimingPercentiles(values, prefix, timings[field], payload.pull_requests.length, label);
  }
  return values;
}

function legacyDeploymentFacts(payload) {
  validateClosedKeys(payload, ["events"], "deployment event payload");
  if (!Array.isArray(payload.events)) throw adapterError("FAIL-ADAPTER-MALFORMED", "deployment evidence requires a typed events array");
  const eventIds = new Set();
  const statuses = new Set(["started", "succeeded", "failed", "rolled_back"]);
  const counts = Object.fromEntries([...statuses].map((status) => [status, 0]));
  const durations = [];
  for (const event of payload.events) {
    validateClosedKeys(event, ["event_id", "status", "duration_ms"], "deployment event");
    if (!isNonBlankString(event.event_id) || eventIds.has(event.event_id) || !statuses.has(event.status)) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "deployment events require unique IDs and declared statuses");
    }
    if (event.duration_ms !== undefined) {
      if (!finiteNonNegative(event.duration_ms)) throw adapterError("FAIL-ADAPTER-MALFORMED", "deployment duration must be nonnegative when supplied");
      durations.push(event.duration_ms);
    }
    eventIds.add(event.event_id);
    counts[event.status] += 1;
  }
  const values = new Map([
    ["deployment.started_count", { value: counts.started }],
    ["deployment.succeeded_count", { value: counts.succeeded }],
    ["deployment.failed_count", { value: counts.failed }],
    ["deployment.rollback_count", { value: counts.rolled_back }],
  ]);
  setTimingPercentiles(values, "deployment.duration", durations, payload.events.length, "deployment duration");
  return values;
}

function parseTimestamp(value) {
  if (!isNonBlankString(value)) return null;
  const matched = RFC3339_WITH_OFFSET.exec(value.trim());
  if (!matched) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zoneText, offsetSign, offsetHourText, offsetMinuteText] = matched;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = zoneText === "Z" ? 0 : Number(offsetHourText);
  const offsetMinute = zoneText === "Z" ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) return null;
  const civilClock = new Date(0);
  civilClock.setUTCFullYear(year, month - 1, day);
  civilClock.setUTCHours(hour, minute, second, 0);
  const fractionalMilliseconds = fractionText === undefined ? 0 : Number(`0${fractionText}`) * 1000;
  const offsetMilliseconds = (offsetHour * 60 + offsetMinute) * 60000 * (offsetSign === "-" ? -1 : 1);
  const parsed = civilClock.getTime() - offsetMilliseconds + fractionalMilliseconds;
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalRefs(prefix, records, identifier) {
  return records
    .map((record) => `${prefix}${record[identifier]}`)
    .sort(stableCompare);
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function typedDeploymentFacts(payload) {
  validateClosedKeys(payload, ["production_environment", "changes", "events"], "typed deployment event payload");
  if (!isNonBlankString(payload.production_environment) || !Array.isArray(payload.changes) || !Array.isArray(payload.events)) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", "typed deployment evidence requires production_environment, changes, and events arrays");
  }
  const productionEnvironment = payload.production_environment.trim();
  const changes = new Map();
  for (const change of payload.changes) {
    validateClosedKeys(change, ["change_set", "committed_at"], "typed deployment change");
    const committedAt = parseTimestamp(change.committed_at);
    if (!isNonBlankString(change.change_set) || committedAt === null || changes.has(change.change_set.trim())) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "typed deployment changes require unique change_set identifiers and committed_at timestamps");
    }
    changes.set(change.change_set.trim(), { change_set: change.change_set.trim(), committed_at: committedAt });
  }

  const eventIds = new Set();
  const events = [];
  for (const event of payload.events) {
    validateClosedKeys(event, [
      "event_id", "change_set", "environment", "started_at", "completed_at", "status",
      "rollback_of", "rework_of", "recovery_completed_at",
    ], "typed deployment event");
    const startedAt = parseTimestamp(event.started_at);
    const completedAt = parseTimestamp(event.completed_at);
    const recoveryCompletedAt = event.recovery_completed_at === undefined ? null : parseTimestamp(event.recovery_completed_at);
    const rollbackOf = event.rollback_of === undefined ? null : event.rollback_of;
    const reworkOf = event.rework_of === undefined ? null : event.rework_of;
    if (
      !isNonBlankString(event.event_id) || eventIds.has(event.event_id.trim()) ||
      !isNonBlankString(event.change_set) || !isNonBlankString(event.environment) ||
      startedAt === null || completedAt === null || completedAt < startedAt ||
      !new Set(["succeeded", "failed"]).has(event.status) ||
      (rollbackOf !== null && !isNonBlankString(rollbackOf)) ||
      (reworkOf !== null && !isNonBlankString(reworkOf)) ||
      (event.recovery_completed_at !== undefined && recoveryCompletedAt === null) ||
      (event.status === "failed" && recoveryCompletedAt !== null && recoveryCompletedAt < completedAt) ||
      (event.status !== "failed" && recoveryCompletedAt !== null)
    ) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "typed deployment events require unique identifiers, typed change/environment/timestamps, a terminal outcome, and coherent recovery timestamps");
    }
    const normalized = {
      event_id: event.event_id.trim(),
      change_set: event.change_set.trim(),
      environment: event.environment.trim(),
      started_at: startedAt,
      completed_at: completedAt,
      status: event.status,
      rollback_of: rollbackOf === null ? null : rollbackOf.trim(),
      rework_of: reworkOf === null ? null : reworkOf.trim(),
      recovery_completed_at: recoveryCompletedAt,
    };
    eventIds.add(normalized.event_id);
    events.push(normalized);
  }
  const byEventId = new Map(events.map((event) => [event.event_id, event]));
  for (const event of events) {
    const change = changes.get(event.change_set);
    if (!change || change.committed_at >= event.started_at) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "every typed deployment event must bind a declared change committed before its deployment started");
    }
    if (event.rollback_of !== null) {
      const target = byEventId.get(event.rollback_of);
      if (
        !target || target.event_id === event.event_id || event.status !== "failed" || target.status !== "succeeded" ||
        target.environment !== event.environment || target.completed_at >= event.started_at
      ) {
        throw adapterError("FAIL-ADAPTER-MALFORMED", "typed rollback linkage must bind a failed deployment to an earlier succeeded deployment in the same environment");
      }
    }
    if (event.rework_of !== null) {
      const target = byEventId.get(event.rework_of);
      if (
        !target || target.event_id === event.event_id || event.status !== "succeeded" || target.status !== "failed" ||
        target.environment !== event.environment || target.completed_at >= event.started_at
      ) {
        throw adapterError("FAIL-ADAPTER-MALFORMED", "typed rework linkage must bind a succeeding deployment to an earlier failed deployment in the same environment");
      }
    }
    if (event.recovery_completed_at !== null && event.recovery_completed_at <= event.completed_at) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "typed deployment recovery must complete after its failed deployment completed");
    }
  }

  const genericCounts = { started: events.length, succeeded: 0, failed: 0, rollback: 0 };
  const durations = [];
  for (const event of events) {
    genericCounts[event.status] += 1;
    if (event.rollback_of !== null) genericCounts.rollback += 1;
    durations.push(event.completed_at - event.started_at);
  }
  const generic = new Map([
    ["deployment.started_count", { value: genericCounts.started }],
    ["deployment.succeeded_count", { value: genericCounts.succeeded }],
    ["deployment.failed_count", { value: genericCounts.failed }],
    ["deployment.rollback_count", { value: genericCounts.rollback }],
  ]);
  setTimingPercentiles(generic, "deployment.duration", durations, events.length, "deployment duration");

  const production = events.filter((event) => event.environment === productionEnvironment);
  const successful = production.filter((event) => event.status === "succeeded");
  const failed = production.filter((event) => event.status === "failed");
  const productionRefs = canonicalRefs("deployment-record:", production, "event_id");
  const successfulRefs = canonicalRefs("deployment-record:", successful, "event_id");
  const failedRefs = canonicalRefs("deployment-record:", failed, "event_id");
  const changeLeadTimes = successful
    .map((event) => {
      const change = changes.get(event.change_set);
      return change && event.completed_at >= change.committed_at ? event.completed_at - change.committed_at : null;
    });
  const recoveryTimes = failed
    .map((event) => event.recovery_completed_at === null ? null : event.recovery_completed_at - event.completed_at);
  const reworked = production.filter((event) => event.rework_of !== null);
  const unavailable = (reason) => ({ value: null, reason });
  const dora = new Map([
    ["dora.change_lead_time", changeLeadTimes.length > 0 && changeLeadTimes.every((value) => value !== null)
      ? { value: median(changeLeadTimes), evidence_refs: successfulRefs }
      : unavailable("FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE: every succeeded production deployment requires a bound committed change timestamp")],
    ["dora.deployment_frequency", production.length > 0
      ? { value: successful.length, evidence_refs: successfulRefs.length > 0 ? successfulRefs : productionRefs }
      : unavailable("FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE: no typed production deployment records were supplied")],
    ["dora.failed_deployment_recovery_time", recoveryTimes.length > 0 && recoveryTimes.every((value) => value !== null)
      ? { value: median(recoveryTimes), evidence_refs: failedRefs }
      : unavailable("FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE: failed production deployments require recovery_completed_at timestamps")],
    ["dora.change_fail_rate", production.length > 0
      ? { value: rounded(failed.length / production.length), evidence_refs: productionRefs }
      : unavailable("FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE: no typed production deployment records were supplied")],
    ["dora.deployment_rework_rate", production.length > 0
      ? { value: rounded(reworked.length / production.length), evidence_refs: productionRefs }
      : unavailable("FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE: no typed production deployment records were supplied")],
  ]);
  return { generic, dora };
}

function deploymentFacts(payload, format) {
  if (format === "deployment-events-v1") return legacyDeploymentFacts(payload);
  if (format === "deployment-events-v2") return typedDeploymentFacts(payload).generic;
  throw adapterError("FAIL-ADAPTER-UNSUPPORTED-FORMAT", "deployment event format is unsupported");
}

function normalizeWorkflowState(value) {
  return isNonBlankString(value) ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : null;
}

function workflowStateArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", `${label} must be a nonempty typed state array`);
  }
  const states = value.map(normalizeWorkflowState);
  if (states.some((state) => state === null) || new Set(states).size !== states.length) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", `${label} must contain unique nonblank workflow states`);
  }
  return states;
}

function deriveWorkflowDimensions(records, workflow) {
  const byItem = new Map();
  for (const record of records) {
    const itemRecords = byItem.get(record.work_item_id) ?? [];
    itemRecords.push(record);
    byItem.set(record.work_item_id, itemRecords);
  }
  const completed = new Set();
  const cycleTimes = [];
  const ages = [];
  let wip = 0;
  for (const itemRecords of byItem.values()) {
    let activeStartedAt = null;
    let currentState = null;
    for (const record of itemRecords) {
      currentState = record.to;
      if (record.to === workflow.start) activeStartedAt = record.occurred_at;
      if (record.to === workflow.finish) {
        if (record.occurred_at >= workflow.window_start && record.occurred_at <= workflow.window_end) {
          completed.add(record.work_item_id);
          if (activeStartedAt !== null && record.occurred_at >= activeStartedAt) {
            cycleTimes.push(record.occurred_at - activeStartedAt);
          }
        }
        activeStartedAt = null;
      }
    }
    if (workflow.active.has(currentState)) {
      wip += 1;
      if (activeStartedAt !== null && workflow.as_of >= activeStartedAt) ages.push(workflow.as_of - activeStartedAt);
    }
  }
  return {
    wip,
    throughput: completed.size,
    work_item_age: median(ages),
    cycle_time: median(cycleTimes),
  };
}

function workItemWorkflowFacts(payload) {
  validateClosedKeys(payload, ["definition_of_workflow", "transitions"], "work-item workflow payload");
  if (!isRecord(payload.definition_of_workflow) || !Array.isArray(payload.transitions)) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", "work-item workflow evidence requires a Definition of Workflow and typed transitions");
  }
  const definition = payload.definition_of_workflow;
  validateClosedKeys(definition, ["workflow_id", "states", "start_event", "finish_event", "active_states", "as_of", "window_start", "window_end"], "Definition of Workflow");
  const states = workflowStateArray(definition.states, "Definition of Workflow.states");
  const start = normalizeWorkflowState(definition.start_event);
  const finish = normalizeWorkflowState(definition.finish_event);
  const activeStates = workflowStateArray(definition.active_states, "Definition of Workflow.active_states");
  const asOf = parseTimestamp(definition.as_of);
  const windowStart = parseTimestamp(definition.window_start);
  const windowEnd = parseTimestamp(definition.window_end);
  if (
    !isNonBlankString(definition.workflow_id) || !start || !finish || start === finish ||
    !states.includes(start) || !states.includes(finish) ||
    activeStates.some((state) => !states.includes(state)) || !activeStates.includes(start) || activeStates.includes(finish) ||
    asOf === null || windowStart === null || windowEnd === null || windowStart > windowEnd || windowEnd > asOf
  ) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", "Definition of Workflow requires declared states, active start/non-active finish, and a coherent as_of window");
  }
  const transitionIds = new Set();
  const records = [];
  for (const transition of payload.transitions) {
    validateClosedKeys(transition, ["transition_id", "work_item_id", "from", "to", "occurred_at"], "work-item transition");
    const from = normalizeWorkflowState(transition.from);
    const to = normalizeWorkflowState(transition.to);
    const occurredAt = parseTimestamp(transition.occurred_at);
    if (
      !isNonBlankString(transition.transition_id) || transitionIds.has(transition.transition_id.trim()) ||
      !isNonBlankString(transition.work_item_id) || !from || !to || from === to ||
      !states.includes(from) || !states.includes(to) || occurredAt === null || occurredAt > asOf
    ) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "work-item transitions require unique identifiers, declared states, and timestamps at or before as_of");
    }
    transitionIds.add(transition.transition_id.trim());
    records.push({
      transition_id: transition.transition_id.trim(),
      work_item_id: transition.work_item_id.trim(),
      from,
      to,
      occurred_at: occurredAt,
    });
  }
  records.sort((left, right) => (
    left.occurred_at - right.occurred_at || stableCompare(left.work_item_id, right.work_item_id) || stableCompare(left.transition_id, right.transition_id)
  ));
  const previousByItem = new Map();
  for (const record of records) {
    const previous = previousByItem.get(record.work_item_id);
    if (previous && (record.occurred_at <= previous.occurred_at || record.from !== previous.to)) {
      throw adapterError("FAIL-ADAPTER-MALFORMED", "typed work-item transitions must form a strictly ordered state chain per work item");
    }
    previousByItem.set(record.work_item_id, record);
  }
  const workflow = {
    start,
    finish,
    active: new Set(activeStates),
    as_of: asOf,
    window_start: windowStart,
    window_end: windowEnd,
  };
  const dimensions = deriveWorkflowDimensions(records, workflow);
  const workflowRef = `workflow-definition:${definition.workflow_id.trim()}`;
  const transitionRefs = canonicalRefs("work-item-transition:", records, "transition_id");
  const values = new Map([
    ["kanban.definition_of_workflow", { value: 1, evidence_refs: [workflowRef] }],
    ["kanban.transition_records", { value: records.length, evidence_refs: transitionRefs }],
    ["kanban.wip", { value: dimensions.wip, evidence_refs: transitionRefs }],
    ["kanban.throughput", { value: dimensions.throughput, evidence_refs: transitionRefs }],
    ["kanban.work_item_age", dimensions.work_item_age === null
      ? { value: null, reason: "FAIL-KANBAN-WITHOUT-TYPED-TRANSITIONS: no work item is active at as_of" }
      : { value: dimensions.work_item_age, evidence_refs: transitionRefs }],
    ["kanban.cycle_time", dimensions.cycle_time === null
      ? { value: null, reason: "FAIL-KANBAN-WITHOUT-TYPED-TRANSITIONS: no work item completed inside the workflow window with an observed start transition" }
      : { value: dimensions.cycle_time, evidence_refs: transitionRefs }],
  ]);
  return values;
}

function topologyFacts(payload) {
  validateClosedKeys(payload, ["nodes", "edges", "centrality"], "dependency topology payload");
  let topology;
  try {
    topology = reduceDependencyTopology({ nodes: payload.nodes, edges: payload.edges });
  } catch (error) {
    if (error?.code !== "FAIL-DEPENDENCY-TOPOLOGY") throw error;
    throw adapterError("FAIL-ADAPTER-MALFORMED", error.message.replace(/^FAIL-DEPENDENCY-TOPOLOGY:\s*/, ""));
  }
  const aggregate = topology.aggregates;
  const topologyNodeIds = new Set(topology.nodes.map((node) => node.id));
  const values = new Map([
    ["dependency.node_count", { value: aggregate.node_count }],
    ["dependency.edge_count", { value: aggregate.edge_count }],
    ["dependency.scc_count", { value: aggregate.scc_count }],
    ["dependency.cyclic_scc_count", { value: aggregate.cyclic_scc_count }],
    ["dependency.cyclic_node_count", { value: aggregate.cyclic_node_count }],
    ["dependency.fan_in", { value: aggregate.max_fan_in }],
    ["dependency.fan_out", { value: aggregate.max_fan_out }],
    ["dependency.density", aggregate.density.status === "not-applicable"
      ? { value: null, reason: "FAIL-ADAPTER-UNSUPPORTED-METRIC: density has no directed pair denominator" }
      : { value: rounded(aggregate.density.numerator / aggregate.density.denominator) }],
  ]);
  if (payload.centrality === undefined) {
    values.set("dependency.centrality", { value: null, reason: "FAIL-ADAPTER-UNSUPPORTED-METRIC: no typed centrality support was supplied" });
  } else if (!Array.isArray(payload.centrality)) {
    throw adapterError("FAIL-ADAPTER-MALFORMED", "dependency topology centrality must be an array when supplied");
  } else {
    const centrality = new Map();
    for (const entry of payload.centrality) {
      validateClosedKeys(entry, ["node", "value"], "dependency topology centrality");
      if (!isNonBlankString(entry.node) || !topologyNodeIds.has(entry.node) || centrality.has(entry.node) || typeof entry.value !== "number" || !Number.isFinite(entry.value) || entry.value < 0 || entry.value > 1) {
        throw adapterError("FAIL-ADAPTER-MALFORMED", "dependency topology centrality must cover unique declared nodes with normalized values");
      }
      centrality.set(entry.node, entry.value);
    }
    if (centrality.size !== aggregate.node_count) {
      values.set("dependency.centrality", { value: null, reason: "FAIL-ADAPTER-UNSUPPORTED-METRIC: centrality does not cover every topology node" });
    } else {
      values.set("dependency.centrality", { value: Math.max(0, ...centrality.values()) });
    }
  }
  return values;
}

function collectSpec(base, spec, adapters) {
  if (!Array.isArray(adapters)) {
    return unverifiableResult(base, spec, "FAIL-ADAPTER-MALFORMED: adapters must be an array");
  }
  const supplied = adapters.filter((adapter) => envelopeBelongsToSpec(adapter, spec));
  if (supplied.length === 0) return unavailableResult(base, spec, `FAIL-ADAPTER-MISSING: ${spec.id} was not supplied`);
  if (supplied.length !== 1) return unverifiableResult(base, spec, `FAIL-ADAPTER-DUPLICATE: ${spec.id} was supplied more than once`);
  let envelope;
  try {
    const supportedFormats = {
      "dependency-topology": new Set(["dependency-topology-v1"]),
      "deployment-events": new Set(["deployment-events-v1", "deployment-events-v2"]),
      "feedback-timing": new Set(["feedback-timing-v1"]),
      "kanban-work-item-flow": new Set(["work-item-workflow-v1"]),
      "pr-flow": new Set(["pr-flow-v1"]),
      "verification-summary": new Set([
        "junit-summary-v1",
        "lcov-summary-v1",
        "local-verification-summary-v1",
        "cobertura-summary-v1",
        "coverage-py-summary-v1",
        "jacoco-summary-v1",
      ]),
      "assessment-evidence": new Set(["assessment-evidence-v1"]),
    };
    envelope = normalizeAdapterEnvelope(base, spec, supplied[0], supportedFormats[spec.id] ?? new Set());
    if (spec.id === "dependency-topology") return resultFromValues(base, spec, envelope, topologyFacts(envelope.payload));
    if (spec.id === "deployment-events") return resultFromValues(base, spec, envelope, deploymentFacts(envelope.payload, envelope.format));
    if (spec.id === "feedback-timing") return resultFromValues(base, spec, envelope, feedbackFacts(envelope.payload));
    if (spec.id === "kanban-work-item-flow") return resultFromValues(base, spec, envelope, workItemWorkflowFacts(envelope.payload));
    if (spec.id === "pr-flow") return resultFromValues(base, spec, envelope, flowFacts(envelope.payload));
    if (spec.id === "verification-summary") return resultFromValues(base, spec, envelope, verificationFacts(envelope.payload));
    if (spec.id === "assessment-evidence") return resultFromValues(base, spec, envelope, assessmentEvidenceFacts(envelope.payload, spec));
    throw adapterError("FAIL-ADAPTER-UNSUPPORTED-FORMAT", `${spec.id} support is not implemented in this adapter contract`);
  } catch (error) {
    const reason = error.code ?? "FAIL-ADAPTER-MALFORMED";
    if (reason === "FAIL-ADAPTER-UNSUPPORTED-FORMAT") return unavailableResult(base, spec, `${reason}: ${error.message.replace(/^.*?: /, "")}`);
    return unverifiableResult(base, spec, `${reason}: ${error.message.replace(/^.*?: /, "")}`, failureArtifactRef(spec, supplied[0]));
  }
}

function collectDoraDeploymentEvidence(base, adapters) {
  const deploymentSpec = ADAPTER_SPECS.find((spec) => spec.id === "deployment-events");
  if (!Array.isArray(adapters)) {
    return unverifiableResult(base, DORA_DEPLOYMENT_SPEC, "FAIL-ADAPTER-MALFORMED: adapters must be an array");
  }
  const supplied = adapters.filter((adapter) => envelopeBelongsToSpec(adapter, deploymentSpec));
  if (supplied.length === 0) {
    return unavailableResult(base, DORA_DEPLOYMENT_SPEC, "FAIL-ADAPTER-MISSING: deployment-events-v2 was not supplied; typed deployment/change evidence is required for DORA");
  }
  if (supplied.length !== 1) {
    return unverifiableResult(base, DORA_DEPLOYMENT_SPEC, "FAIL-ADAPTER-DUPLICATE: deployment-events was supplied more than once");
  }
  try {
    const envelope = normalizeAdapterEnvelope(base, deploymentSpec, supplied[0], new Set(["deployment-events-v1", "deployment-events-v2"]));
    if (envelope.format !== "deployment-events-v2") {
      return unavailableResult(base, DORA_DEPLOYMENT_SPEC, "FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE: deployment-events-v2 is required for typed deployment/change calculations");
    }
    return resultFromValues(base, DORA_DEPLOYMENT_SPEC, envelope, typedDeploymentFacts(envelope.payload).dora);
  } catch (error) {
    const reason = error.code ?? "FAIL-ADAPTER-MALFORMED";
    return unverifiableResult(base, DORA_DEPLOYMENT_SPEC, `${reason}: ${error.message.replace(/^.*?: /, "")}`, failureArtifactRef(DORA_DEPLOYMENT_SPEC, supplied[0]));
  }
}

function collectAdapterEvidence(input = {}) {
  const base = normalizeBase(input);
  const results = [
    ...ADAPTER_SPECS.map((spec) => collectSpec(base, spec, base.adapters)),
    collectDoraDeploymentEvidence(base, base.adapters),
  ];
  return {
    collectors: results.map((result) => result.collector).sort((left, right) => stableCompare(left.collector_id, right.collector_id)),
    metrics: results.flatMap((result) => result.metrics).sort((left, right) => stableCompare(left.metric_id, right.metric_id)),
  };
}

module.exports = { collectAdapterEvidence };
