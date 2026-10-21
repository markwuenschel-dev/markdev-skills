"use strict";

const crypto = require("node:crypto");

const SEMANTIC_OBSERVATION_VERSION = "sei.engineering-observation@1";
const MAX_TEXT = 512;
const OBSERVED_STATUSES = new Set(["measured", "inferred"]);
const DUPLICATION_RESOURCE_LIMIT_CODES = new Set([
  "FAIL-DUPLICATION-RESOURCE-LIMIT",
  "FAIL-DUPLICATION-PARTIAL-RESOURCE-LIMIT",
]);

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT
    && value.trim() === value && !value.includes("\0") && !/[\r\n]/.test(value);
}

function canonicalStrings(values) {
  return [...new Set(values.filter(boundedText))].sort(stableCompare);
}

function failureCode(reason) {
  if (typeof reason !== "string") return null;
  const separator = reason.indexOf(":");
  const code = separator === -1 ? reason : reason.slice(0, separator);
  return /^[A-Z0-9-]+$/.test(code) ? code : null;
}

function normalizedContext(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.measurements)) {
    throw new Error("FAIL-ASSESSMENT-EVIDENCE-MAP: snapshot.measurements must be an array");
  }
  const collectors = new Map();
  for (const collector of Array.isArray(snapshot.collectors) ? snapshot.collectors : []) {
    if (!isRecord(collector) || !boundedText(collector.collector_id)) continue;
    if (collectors.has(collector.collector_id)) {
      throw new Error(`FAIL-ASSESSMENT-EVIDENCE-MAP: duplicate collector ${collector.collector_id}`);
    }
    collectors.set(collector.collector_id, {
      status: collector.status,
      resource_limited: DUPLICATION_RESOURCE_LIMIT_CODES.has(failureCode(collector.reason)),
    });
  }
  const binding = isRecord(snapshot.repository) ? {
    snapshot_id: boundedText(snapshot.snapshot_id) ? snapshot.snapshot_id : null,
    repository_id: boundedText(snapshot.repository.repository_id) ? snapshot.repository.repository_id : null,
    repository_revision: boundedText(snapshot.repository.revision) ? snapshot.repository.revision : null,
  } : null;
  const seenMetricIds = new Set();
  const normalizedMetrics = snapshot.measurements.filter((metric) => (
    isRecord(metric) && boundedText(metric.metric_id) && isRecord(metric.measurement)
    && typeof metric.measurement.status === "string"
    && Number.isFinite(metric.measurement.completeness) && metric.measurement.completeness >= 0 && metric.measurement.completeness <= 1
    && Number.isFinite(metric.measurement.confidence) && metric.measurement.confidence >= 0 && metric.measurement.confidence <= 1
    && isRecord(metric.source) && boundedText(metric.source.collector_id)
    && canonicalStrings([...(Array.isArray(metric.source.artifact_refs) ? metric.source.artifact_refs : []), ...(Array.isArray(metric.source.evidence_refs) ? metric.source.evidence_refs : [])]).length > 0
  )).map((metric) => {
    if (!collectors.has(metric.source.collector_id)) {
      throw new Error(`FAIL-ASSESSMENT-EVIDENCE-MAP: metric ${metric.metric_id} has no collector binding`);
    }
    if (seenMetricIds.has(metric.metric_id)) {
      throw new Error(`FAIL-ASSESSMENT-EVIDENCE-MAP: duplicate metric ${metric.metric_id}`);
    }
    seenMetricIds.add(metric.metric_id);
    return {
    metric_id: metric.metric_id,
    definition_id: boundedText(metric.definition_id) ? metric.definition_id : null,
    value: metric.value,
    status: metric.measurement.status,
    completeness: metric.measurement.completeness,
    confidence: metric.measurement.confidence,
    collector_id: metric.source.collector_id,
    evidence_refs: canonicalStrings([...(Array.isArray(metric.source.artifact_refs) ? metric.source.artifact_refs : []), ...(Array.isArray(metric.source.evidence_refs) ? metric.source.evidence_refs : [])]),
    scope: isRecord(metric.scope) ? {
      kind: typeof metric.scope.kind === "string" ? metric.scope.kind : null,
      language: typeof metric.scope.language === "string" ? metric.scope.language.toLowerCase() : null,
      generated_code: metric.scope.generated_code === true,
    } : { kind: null, language: null, generated_code: false },
    reason: boundedText(metric.measurement.reason) ? metric.measurement.reason : null,
    };
  }).sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  return {
    collectors,
    metrics: normalizedMetrics.filter((metric) => collectors.get(metric.collector_id)?.status !== "unavailable"),
    // Retain unavailable metric envelopes for explicit-absence observations.
    // They remain excluded from positive scoring selection, but their source
    // refs are still canonical proof that discovery checked the surface.
    allMetrics: normalizedMetrics,
    binding,
  };
}

// Each inner array is a compatibility group: the first matching producer ID wins.
// Separate groups express distinct language/scoped producers for the same meaning.
const OBSERVATION_SPECS = Object.freeze([
  ["engineering.source_inventory.human_file_count", "source-inventory", "first", "files", [["static.human_source_file_count", "static.source_file_count"]]],
  ["engineering.source_inventory.human_source_lines", "source-inventory", "first", "lines", [["static.human_source_lines", "static.source_lines"]]],
  ["engineering.complexity.production.cyclomatic", "complexity", "max", "complexity", [
    ["static.python.cyclomatic_complexity:production"],
    ["static.tsjs.cyclomatic_complexity:production"],
    ["static.java.cyclomatic_complexity"],
    ["static.kotlin.cyclomatic_complexity"],
    ["static.cyclomatic_complexity:production", "static.cyclomatic_complexity"],
  ]],
  ["engineering.complexity.production.p90", "complexity", "max", "complexity-points", [
    ["static.python.cyclomatic_complexity_p90:production", "static.python.cyclomatic.p90:production"],
    ["static.tsjs.cyclomatic_complexity_p90:production", "static.tsjs.cyclomatic.p90:production"],
    ["static.cyclomatic_complexity_p90"],
  ]],
  ["engineering.complexity.production.max", "complexity", "max", "complexity-points", [
    ["static.python.cyclomatic_complexity_max:production", "static.python.cyclomatic.max:production"],
    ["static.tsjs.cyclomatic_complexity_max:production", "static.tsjs.cyclomatic.max:production"],
    ["static.cyclomatic_complexity_max"],
  ]],
  ["engineering.complexity.production.p50", "complexity", "max", "complexity-points", [
    ["static.python.cyclomatic_complexity_p50:production"],
    ["static.tsjs.cyclomatic_complexity_p50:production"],
    ["static.cyclomatic_complexity_p50"],
  ]],
  ["engineering.complexity.production.callable_count", "complexity", "sum", "callables", [
    ["static.python.cyclomatic_callable_count:production"],
    ["static.tsjs.cyclomatic_callable_count:production"],
    ["static.cyclomatic_callable_count"],
  ]],
  ["engineering.complexity.production.parsed_file_count", "complexity", "sum", "files", [
    ["static.python.parsed_file_count:production"],
    ["static.tsjs.parsed_file_count:production"],
  ]],
  ["engineering.complexity.production.eligible_file_count", "complexity", "sum", "files", [
    ["static.python.file_count:production"],
    ["static.tsjs.file_count:production"],
  ]],
  ["engineering.dependency.cyclic_node_count", "dependency-topology", "max", "cyclic-nodes", [
    ["static.python.dependency.cyclic_node_count:production"],
    ["static.tsjs.dependency.cyclic_node_count:production"],
    ["dependency.cyclic_node_count"],
  ]],
  ["engineering.dependency.node_count", "dependency-topology", "max", "nodes", [
    ["static.python.dependency.node_count:production", "static.python.dependency.node_count:all-python"],
    ["static.tsjs.dependency.node_count:production", "static.tsjs.dependency.node_count:all-tsjs"],
    ["dependency.node_count"],
    ["static.dependency.node_count:tsjs"],
  ]],
  ["engineering.dependency.edge_count", "dependency-topology", "max", "edges", [
    ["static.python.dependency.edge_count:production"],
    ["static.tsjs.dependency.edge_count:production"],
    ["dependency.edge_count"],
  ]],
  ["engineering.dependency.scc_count", "dependency-topology", "max", "components", [
    ["static.python.dependency.scc_count:production"],
    ["static.tsjs.dependency.scc_count:production"],
    ["dependency.scc_count"],
  ]],
  ["engineering.dependency.boundary_pressure", "dependency-topology", "max", "fan-in", [
    ["static.python.dependency.fan_in_max:production"],
    ["static.tsjs.dependency.fan_in_max:production"],
    ["dependency.fan_in"],
  ]],
  ["engineering.dependency.cycle_pressure", "dependency-topology", "sum", "cycles", [
    ["static.python.dependency.cyclic_scc_count:production"],
    ["static.tsjs.dependency.cyclic_scc_count:production"],
    ["dependency.cyclic_scc_count"],
  ]],
  ["engineering.dependency.centrality_concentration", "dependency-topology", "max", "ratio", [
    ["static.python.dependency.centrality:production"],
    ["static.tsjs.dependency.centrality:production"],
    ["dependency.centrality"],
  ]],
  ["engineering.dependency.instability", "dependency-topology", "max", "ratio", [
    ["static.python.dependency.instability:production"],
    ["static.tsjs.dependency.instability:production"],
    ["dependency.instability"],
  ]],
  ["engineering.dependency.density", "dependency-topology", "max", "ratio", [
    ["static.python.dependency.density:production"],
    ["static.tsjs.dependency.density:production"],
    ["dependency.density"],
  ]],
  ["engineering.git.observed_churn", "git-history", "sum", "changed-lines", [["git.observed_text_churn", "git.churn"]]],
  ["engineering.git.change_frequency", "git-history", "first", "revisions", [["git.change_frequency"]]],
  ["engineering.git.ownership_concentration", "git-history", "max", "ratio", [["git.observed_touch_ownership_concentration", "git.ownership_concentration"]]],
  ["engineering.git.co_change_pressure", "git-history", "sum", "pairs", [["git.observed_co_change_pair_count", "git.co_change_pair_count"]]],
  ["engineering.git.age_days", "git-history", "first", "days", [["git.age_days"]]],
  ["engineering.verification.test_execution", "verification", "first", "tests", [["verification.autonomous_tests_total", "verification.tests_total"]]],
  ["engineering.verification.tests_passed", "verification", "first", "tests", [["verification.autonomous_tests_passed", "verification.tests_passed"]]],
  ["engineering.verification.tests_failed", "verification", "first", "tests", [["verification.autonomous_tests_failed", "verification.tests_failed"]]],
  ["engineering.verification.test_configuration", "verification-configuration", "first", "paths", [["discovery.test_evidence_path_count"]]],
  ["engineering.verification.statement_coverage", "verification", "first", "ratio", [["verification.statement_coverage"]]],
  ["engineering.verification.branch_coverage", "verification", "first", "ratio", [["verification.branch_coverage"]]],
  ["engineering.verification.coverage_configuration", "verification-configuration", "first", "paths", [["discovery.coverage_evidence_path_count"]]],
  ["engineering.verification.duration", "verification", "first", "milliseconds", [["verification.autonomous_duration_ms", "verification.duration_ms"]]],
  ["engineering.delivery.ci_configuration", "delivery-configuration", "first", "paths", [["discovery.ci_evidence_path_count"]]],
  ["engineering.delivery.release_configuration", "delivery-configuration", "first", "paths", [["discovery.engineering.deployment-and-release_evidence_path_count", "assessment.delivery.release_configuration"]]],
  ["engineering.delivery.reproducibility_inputs", "delivery-configuration", "first", "manifests", [["discovery.engineering.dependency-manifests_evidence_path_count", "assessment.delivery.reproducibility_inputs"]]],
  ["engineering.delivery.feedback_flow", "delivery", "first", "ratio", [["assessment.delivery.feedback_flow"]]],
  ["engineering.duplication.observed_ratio", "duplication", "first", "ratio", [["static.duplication.observed_percentage"]]],
  ["engineering.duplication.analyzed_source_lines", "duplication", "first", "lines", [["static.duplication.analyzed_source_lines"]]],
  ["engineering.duplication.clone_family_count", "duplication", "first", "families", [["static.duplication.clone_family_count"]]],
  ["engineering.duplication.clone_family_pressure", "duplication", "first", "families", [["static.duplication.large_clone_family_count"]]],
  ["engineering.work_item.cycle_time", "work-item-flow", "first", "milliseconds", [["kanban.cycle_time"]]],
  ["engineering.work_item.throughput", "work-item-flow", "first", "items", [["kanban.throughput"]]],
  ["engineering.pr.review_latency", "pr-review-flow", "first", "milliseconds", [["flow.first_review_p50_ms"]]],
  ["engineering.pr.count", "pr-review-flow", "first", "count", [["flow.pr_count"]]],
  ["engineering.pr.cycle_time", "pr-review-flow", "first", "milliseconds", [["flow.pr_cycle_p50_ms"]]],
  ["engineering.feedback.sample_count", "feedback-timing", "first", "count", [["feedback.sample_count"]]],
  ["engineering.feedback.first_response_time", "feedback-timing", "first", "milliseconds", [["feedback.first_response_p50_ms"]]],
  ["engineering.feedback.resolution_time", "feedback-timing", "first", "milliseconds", [["feedback.resolution_p50_ms"]]],
  ["engineering.work_item.wip", "work-item-flow", "first", "items", [["kanban.wip"]]],
  ["engineering.work_item.age", "work-item-flow", "first", "milliseconds", [["kanban.work_item_age"]]],
  ["engineering.delivery.deployment_frequency", "deployment", "first", "deployments", [["dora.deployment_frequency"]]],
  ["engineering.delivery.started_deployments", "deployment", "first", "deployments", [["deployment.started_count"]]],
  ["engineering.delivery.succeeded_deployments", "deployment", "first", "deployments", [["deployment.succeeded_count"]]],
  ["engineering.delivery.failed_deployments", "deployment", "first", "deployments", [["deployment.failed_count"]]],
  ["engineering.delivery.rollback_count", "deployment", "first", "deployments", [["deployment.rollback_count"]]],
  ["engineering.dora.change_lead_time", "deployment", "first", "milliseconds", [["dora.change_lead_time"]]],
  ["engineering.dora.failed_deployment_recovery_time", "deployment", "first", "milliseconds", [["dora.failed_deployment_recovery_time"]]],
  ["engineering.dora.change_fail_rate", "deployment", "first", "ratio", [["dora.change_fail_rate"]]],
  ["engineering.dora.deployment_rework_rate", "deployment", "first", "ratio", [["dora.deployment_rework_rate"]]],
  ["engineering.maintainability.failure_explicitness", "verification", "first", "ratio", [["assessment.failure_explicitness"]]],
  ["engineering.verification.change_verification", "verification", "first", "ratio", [["assessment.verification.change_verification"]]],
  ["engineering.reliability.failure_handling", "reliability", "first", "ratio", [["assessment.reliability.failure_handling", "reliability.failure_handling"]]],
  ["engineering.reliability.operational_readiness", "reliability", "first", "ratio", [["assessment.reliability.operational_readiness", "operations.operational_readiness"]]],
  ["engineering.reliability.recovery_evidence", "reliability", "first", "state", [["assessment.reliability.recovery_evidence", "operations.recovery_exercise"]]],
  ["engineering.reliability.observability", "reliability", "first", "ratio", [["assessment.reliability.observability", "operations.observability_coverage"]]],
  ["engineering.security.secret_findings", "security", "first", "findings", [["assessment.security.secret_findings", "security.secret_findings", "security.secrets_findings"]]],
  ["engineering.security.dependency_hygiene", "security", "first", "ratio", [["assessment.security.dependency_hygiene", "security.dependency_vulnerabilities", "security.dependency_findings"]]],
  ["engineering.security.verification", "security", "first", "state", [["assessment.security.verification", "security.verification", "security.scan_execution"]]],
  ["engineering.developer.local_feedback", "developer-experience", "first", "state", [["assessment.developer.local_feedback", "developer_experience.local_feedback", "verification.local_feedback"]]],
  ["engineering.developer.configuration_ergonomics", "developer-experience", "first", "ratio", [["assessment.developer.configuration_ergonomics", "developer_experience.configuration_ergonomics", "developer_experience.config_ergonomics"]]],
  ["engineering.developer.flow_friction", "developer-experience", "first", "days", [["assessment.developer.flow_friction", "developer_experience.flow_friction", "developer_experience.feedback_latency"]]],
  ["engineering.documentation.repository_overview", "documentation", "first", "state", [["assessment.documentation.repository_overview", "documentation.overview_present"]]],
  ["engineering.documentation.contracts_and_runbooks", "documentation", "first", "ratio", [["assessment.documentation.contracts_and_runbooks", "documentation.contracts_and_runbooks", "documentation.runbook_coverage"]]],
  ["engineering.documentation.change_context", "documentation", "first", "ratio", [["assessment.documentation.change_context", "documentation.change_context", "documentation.decision_records"]]],
  ["engineering.documentation.onboarding_discoverability", "documentation", "first", "state", [["assessment.documentation.onboarding_discoverability", "documentation.onboarding_present"]]],
]);

// Runtime measurements are useful evidence and remain in the index, but a
// wall-clock duration is not a stable semantic fact across two cold runs of
// the same revision. Keep it out of the vocabulary digest so equivalence is
// about engineering meaning, not host scheduling noise.
const VOLATILE_SEMANTIC_OBSERVATION_IDS = new Set([
  "engineering.verification.duration",
]);

// Definitions are the producer-independent compatibility boundary.  A producer
// may rename its raw metric_id, but it must retain the definition_id that
// describes the same measurement.  We deliberately do not infer meaning from
// spelling alone: an arbitrary guessed metric ID without a known definition is
// ignored and reported as mapping debt when it belongs to an assessable family.
const DEFINITION_TO_OBSERVATION = Object.freeze({
  "sei.static.source_file_count@1": "engineering.source_inventory.human_file_count",
  "sei.static.source_lines@1": "engineering.source_inventory.human_source_lines",
  "sei.static.python.cyclomatic_complexity_p90@1": "engineering.complexity.production.p90",
  "sei.static.tsjs.cyclomatic_complexity_p90@1": "engineering.complexity.production.p90",
  "sei.static.python.cyclomatic_complexity_p50@1": "engineering.complexity.production.p50",
  "sei.static.tsjs.cyclomatic_complexity_p50@1": "engineering.complexity.production.p50",
  "sei.static.java.cyclomatic_callable@1": "engineering.complexity.production.cyclomatic",
  "sei.static.kotlin.cyclomatic_complexity@1": "engineering.complexity.production.cyclomatic",
  "sei.static.python.cyclomatic_complexity_max@1": "engineering.complexity.production.max",
  "sei.static.tsjs.cyclomatic_complexity_max@1": "engineering.complexity.production.max",
  "sei.static.python.cyclomatic_callable_count@1": "engineering.complexity.production.callable_count",
  "sei.static.tsjs.cyclomatic_callable_count@1": "engineering.complexity.production.callable_count",
  "sei.static.python.parsed_file_count@1": "engineering.complexity.production.parsed_file_count",
  "sei.static.tsjs.parsed_file_count@1": "engineering.complexity.production.parsed_file_count",
  "sei.static.python.file_count@1": "engineering.complexity.production.eligible_file_count",
  "sei.static.tsjs.file_count@1": "engineering.complexity.production.eligible_file_count",
  "sei.static.python.dependency.cyclic_node_count@1": "engineering.dependency.cyclic_node_count",
  "sei.static.tsjs.dependency.cyclic_node_count@1": "engineering.dependency.cyclic_node_count",
  "sei.static.python.dependency.node_count@1": "engineering.dependency.node_count",
  "sei.static.tsjs.dependency.node_count@1": "engineering.dependency.node_count",
  "sei.adapter.dependency.node_count@1": "engineering.dependency.node_count",
  "sei.static.python.dependency.edge_count@1": "engineering.dependency.edge_count",
  "sei.static.tsjs.dependency.edge_count@1": "engineering.dependency.edge_count",
  "sei.adapter.dependency.edge_count@1": "engineering.dependency.edge_count",
  "sei.static.python.dependency.scc_count@1": "engineering.dependency.scc_count",
  "sei.static.tsjs.dependency.scc_count@1": "engineering.dependency.scc_count",
  "sei.adapter.dependency.scc_count@1": "engineering.dependency.scc_count",
  "sei.static.python.dependency.fan_in_max@1": "engineering.dependency.boundary_pressure",
  "sei.static.tsjs.dependency.fan_in_max@1": "engineering.dependency.boundary_pressure",
  "sei.adapter.dependency.fan_in@1": "engineering.dependency.boundary_pressure",
  "sei.static.python.dependency.cyclic_scc_count@1": "engineering.dependency.cycle_pressure",
  "sei.static.tsjs.dependency.cyclic_scc_count@1": "engineering.dependency.cycle_pressure",
  "sei.adapter.dependency.cyclic_scc_count@1": "engineering.dependency.cycle_pressure",
  "sei.static.python.dependency.centrality@1": "engineering.dependency.centrality_concentration",
  "sei.static.tsjs.dependency.centrality@1": "engineering.dependency.centrality_concentration",
  "sei.adapter.dependency.centrality@1": "engineering.dependency.centrality_concentration",
  "sei.static.python.dependency.instability@1": "engineering.dependency.instability",
  "sei.static.tsjs.dependency.instability@1": "engineering.dependency.instability",
  "sei.adapter.dependency.density@1": "engineering.dependency.density",
  "sei.git.observed_text_churn@1": "engineering.git.observed_churn",
  "sei.git.change_frequency@1": "engineering.git.change_frequency",
  "sei.git.observed_touch_ownership_concentration@1": "engineering.git.ownership_concentration",
  "sei.git.observed_co_change_pair_count@1": "engineering.git.co_change_pressure",
  "sei.git.age_days@1": "engineering.git.age_days",
  "sei.adapter.verification.tests_total@1": "engineering.verification.test_execution",
  "sei.verification.autonomous_tests_total@1": "engineering.verification.test_execution",
  "sei.adapter.verification.tests_passed@1": "engineering.verification.tests_passed",
  "sei.verification.autonomous_tests_passed@1": "engineering.verification.tests_passed",
  "sei.adapter.verification.tests_failed@1": "engineering.verification.tests_failed",
  "sei.verification.autonomous_tests_failed@1": "engineering.verification.tests_failed",
  "sei.adapter.verification.statement_coverage@1": "engineering.verification.statement_coverage",
  "sei.adapter.verification.branch_coverage@1": "engineering.verification.branch_coverage",
  "sei.adapter.verification.duration_ms@1": "engineering.verification.duration",
  "sei.verification.autonomous_duration_ms@1": "engineering.verification.duration",
  "sei.kanban.cycle_time@1": "engineering.work_item.cycle_time",
  "sei.kanban.throughput@1": "engineering.work_item.throughput",
  "sei.kanban.wip@1": "engineering.work_item.wip",
  "sei.kanban.work_item_age@1": "engineering.work_item.age",
  "sei.static.duplication.observed_percentage@1": "engineering.duplication.observed_ratio",
  "sei.static.duplication.analyzed_source_lines@1": "engineering.duplication.analyzed_source_lines",
  "sei.static.duplication.clone_family_count@1": "engineering.duplication.clone_family_count",
  "sei.static.duplication.large_clone_family_count@1": "engineering.duplication.clone_family_pressure",
  "sei.adapter.flow.first_review_p50_ms@1": "engineering.pr.review_latency",
  "sei.adapter.flow.pr_count@1": "engineering.pr.count",
  "sei.adapter.flow.pr_cycle_p50_ms@1": "engineering.pr.cycle_time",
  "sei.adapter.feedback.sample_count@1": "engineering.feedback.sample_count",
  "sei.adapter.feedback.first_response_p50_ms@1": "engineering.feedback.first_response_time",
  "sei.adapter.feedback.resolution_p50_ms@1": "engineering.feedback.resolution_time",
  "sei.adapter.deployment.started_count@1": "engineering.delivery.started_deployments",
  "sei.adapter.deployment.failed_count@1": "engineering.delivery.failed_deployments",
  "sei.adapter.deployment.rollback_count@1": "engineering.delivery.rollback_count",
  "sei.dora.deployment_frequency@1": "engineering.delivery.deployment_frequency",
  "sei.dora.change_lead_time@1": "engineering.dora.change_lead_time",
  "sei.dora.failed_deployment_recovery_time@1": "engineering.dora.failed_deployment_recovery_time",
  "sei.dora.change_fail_rate@1": "engineering.dora.change_fail_rate",
  "sei.dora.deployment_rework_rate@1": "engineering.dora.deployment_rework_rate",
  "sei.adapter.deployment.succeeded_count@1": "engineering.delivery.succeeded_deployments",
  "sei.assessment.failure_explicitness@1": "engineering.maintainability.failure_explicitness",
  "sei.assessment.delivery.release_configuration@1": "engineering.delivery.release_configuration",
  "sei.assessment.delivery.reproducibility_inputs@1": "engineering.delivery.reproducibility_inputs",
  "sei.assessment.delivery.feedback_flow@1": "engineering.delivery.feedback_flow",
  "sei.assessment.verification.change_verification@1": "engineering.verification.change_verification",
  "sei.assessment.reliability.failure_handling@1": "engineering.reliability.failure_handling",
  "sei.assessment.reliability.operational_readiness@1": "engineering.reliability.operational_readiness",
  "sei.assessment.reliability.recovery_evidence@1": "engineering.reliability.recovery_evidence",
  "sei.assessment.reliability.observability@1": "engineering.reliability.observability",
  "sei.assessment.security.secret_findings@1": "engineering.security.secret_findings",
  "sei.assessment.security.dependency_hygiene@1": "engineering.security.dependency_hygiene",
  "sei.assessment.security.verification@1": "engineering.security.verification",
  "sei.assessment.developer.local_feedback@1": "engineering.developer.local_feedback",
  "sei.assessment.developer.configuration_ergonomics@1": "engineering.developer.configuration_ergonomics",
  "sei.assessment.developer.flow_friction@1": "engineering.developer.flow_friction",
  "sei.assessment.documentation.repository_overview@1": "engineering.documentation.repository_overview",
  "sei.assessment.documentation.contracts_and_runbooks@1": "engineering.documentation.contracts_and_runbooks",
  "sei.assessment.documentation.change_context@1": "engineering.documentation.change_context",
  "sei.assessment.documentation.onboarding_discoverability@1": "engineering.documentation.onboarding_discoverability",
});

const ASSESSABLE_FAMILY_PREFIXES = Object.freeze([
  "verification.", "git.", "kanban.", "flow.", "dora.", "deployment.", "assessment.", "reliability.", "operations.", "security.", "developer_experience.", "documentation.",
]);

function definitionCompatible(metric, observationId) {
  if (DEFINITION_TO_OBSERVATION[metric.definition_id] !== observationId) return false;
  // Production recipes must never silently consume an all-language/test
  // partition merely because the producer reused the same definition_id.
  if (observationId.includes(".production.") && /:(?:all-|test|tests?)(?:$|-)/i.test(metric.metric_id)) return false;
  return true;
}

function metricLanguageKey(metric) {
  if (metric.scope.language) return metric.scope.language;
  if (metric.metric_id.startsWith("static.python.")) return "python";
  if (metric.metric_id.startsWith("static.tsjs.")) return "tsjs";
  return "repository";
}

function selectedMetrics(context, alternativeGroups, observationId = null) {
  const byId = new Map(context.metrics.map((metric) => [metric.metric_id, metric]));
  const requested = new Set(alternativeGroups.flat());
  const candidates = alternativeGroups.flatMap((alternatives, groupRank) => alternatives
    .map((metricId, alternativeRank) => ({ metric: byId.get(metricId), groupRank, alternativeRank }))
    .filter((candidate) => candidate.metric));
  const definitionCandidates = observationId === null ? [] : context.metrics
    .map((metric) => ({ metric, groupRank: alternativeGroups.length, alternativeRank: 0 }))
    .filter((candidate) => definitionCompatible(candidate.metric, observationId)
      && !requested.has(candidate.metric.metric_id));
  candidates.push(...definitionCandidates);
  const selected = new Map();
  for (const candidate of candidates.sort((left, right) => left.groupRank - right.groupRank
    || left.alternativeRank - right.alternativeRank || stableCompare(left.metric.metric_id, right.metric.metric_id))) {
    const language = metricLanguageKey(candidate.metric);
    if (!selected.has(language)) selected.set(language, candidate.metric);
  }
  return [...selected.values()]
    .filter((metric) => OBSERVED_STATUSES.has(metric.status) && (Number.isFinite(metric.value) || typeof metric.value === "boolean")
      && metric.completeness > 0 && metric.confidence > 0)
    .sort((left, right) => stableCompare(left.metric_id, right.metric_id));
}

function aggregate(metrics, mode) {
  const values = metrics.map((metric) => metric.value);
  if (mode === "sum") return values.reduce((total, value) => total + (typeof value === "boolean" ? (value ? 1 : 0) : value), 0);
  if (mode === "max") return Math.max(...values);
  return values[0];
}

function observationFor(context, spec) {
  const [observation_id, family, aggregation, unit, alternatives] = spec;
  const metrics = selectedMetrics(context, alternatives, observation_id);
  if (metrics.length === 0) return null;
  const resourceLimited = family === "duplication" && metrics.some((metric) => context.collectors.get(metric.collector_id)?.resource_limited);
  const coverage = Math.min(...metrics.map((metric) => metric.completeness));
  const confidence = Math.min(...metrics.map((metric) => metric.confidence));
  const scopes = canonicalStrings(metrics.map((metric) => metric.scope.language).filter(Boolean));
  const lowerBound = resourceLimited || coverage < 1;
  return {
    observation_id,
    value: aggregate(metrics, aggregation),
    unit,
    state: coverage === 1 && confidence === 1 && !resourceLimited ? "complete" : "partial",
    coverage,
    confidence,
    context: {
      family,
      aggregation,
      languages: scopes,
      lower_bound: lowerBound,
      ...(context.binding ? { binding: context.binding } : {}),
    },
    source_metric_ids: metrics.map((metric) => metric.metric_id).sort(stableCompare),
    evidence_refs: canonicalStrings(metrics.flatMap((metric) => metric.evidence_refs)),
  };
}

function semanticShape(observation) {
  if (VOLATILE_SEMANTIC_OBSERVATION_IDS.has(observation?.observation_id)) return null;
  const { source_metric_ids, evidence_refs, context, ...semantic } = observation;
  // Snapshot identity and provenance belong to the bound evidence artifact,
  // not to the meaning of the observation.  Excluding the binding here keeps
  // the semantic vocabulary digest stable when the same revision is emitted
  // into a different snapshot/output run.
  return {
    ...semantic,
    ...(isRecord(context)
      ? { context: Object.fromEntries(Object.entries(context).filter(([key]) => key !== "binding")) }
      : {}),
  };
}

function derivedRatio(observations, observationId, numeratorId, denominatorId, family, unit) {
  const numerator = observations.find((observation) => observation.observation_id === numeratorId);
  const denominator = observations.find((observation) => observation.observation_id === denominatorId);
  if (!numerator || !denominator || !Number.isFinite(numerator.value) || !Number.isFinite(denominator.value) || denominator.value <= 0) return null;
  return {
    observation_id: observationId,
    value: numerator.value / denominator.value,
    unit,
    state: numerator.state === "complete" && denominator.state === "complete" ? "complete" : "partial",
    coverage: Math.min(numerator.coverage, denominator.coverage),
    confidence: Math.min(numerator.confidence, denominator.confidence),
    context: {
      family,
      aggregation: "ratio",
      languages: [...new Set([...(numerator.context.languages ?? []), ...(denominator.context.languages ?? [])])].sort(stableCompare),
      lower_bound: Boolean(numerator.context.lower_bound || denominator.context.lower_bound),
      ...(numerator.context.binding ?? denominator.context.binding ? { binding: numerator.context.binding ?? denominator.context.binding } : {}),
    },
    source_metric_ids: [...new Set([...(numerator.source_metric_ids ?? []), ...(denominator.source_metric_ids ?? [])])].sort(stableCompare),
    evidence_refs: [...new Set([...(numerator.evidence_refs ?? []), ...(denominator.evidence_refs ?? [])])].sort(stableCompare),
  };
}

function derivedComplement(observations, observationId, sourceId, family, unit) {
  const source = observations.find((observation) => observation.observation_id === sourceId);
  if (!source || !Number.isFinite(source.value) || source.value < 0 || source.value > 1) return null;
  return {
    observation_id: observationId,
    value: Number((1 - source.value).toFixed(8)),
    unit,
    state: source.state,
    coverage: source.coverage,
    confidence: source.confidence,
    context: {
      family,
      aggregation: "complement",
      languages: [...(source.context.languages ?? [])].sort(stableCompare),
      lower_bound: source.context.lower_bound === true,
      ...(source.context.binding ? { binding: source.context.binding } : {}),
    },
    source_metric_ids: [...(source.source_metric_ids ?? [])].sort(stableCompare),
    evidence_refs: [...(source.evidence_refs ?? [])].sort(stableCompare),
  };
}

function explicitAbsence(context, observationId, family, collectorIds, unit = "state", sourceMetricIds = []) {
  const collectors = collectorIds.map((collectorId) => ({ collectorId, record: context.collectors.get(collectorId) }))
    .filter((entry) => entry.record);
  if (collectors.length === 0 || collectors.some((entry) => entry.record.status !== "unavailable")) return null;
  const selectedMetricIds = sourceMetricIds.length > 0
    ? sourceMetricIds.filter((metricId) => context.allMetrics?.some((metric) => metric.metric_id === metricId))
    : collectors.map((entry) => `collector:${entry.collectorId}:absence`);
  const evidenceRefs = [...new Set((context.allMetrics ?? [])
    .filter((metric) => selectedMetricIds.includes(metric.metric_id))
    .flatMap((metric) => metric.evidence_refs))].sort(stableCompare);
  if (selectedMetricIds.length === 0 || evidenceRefs.length === 0) return null;
  return {
    observation_id: observationId,
    value: 0,
    unit,
    state: "complete",
    coverage: 1,
    confidence: 0.9,
    context: {
      family,
      aggregation: "explicit-absence",
      languages: [],
      lower_bound: false,
      absence_observed: true,
      ...(context.binding ? { binding: context.binding } : {}),
    },
    source_metric_ids: selectedMetricIds.sort(stableCompare),
    evidence_refs: evidenceRefs,
  };
}

function pathPresence(context, observationId, patterns, family) {
  const matches = context.metrics.filter((metric) => {
    if (!metric.metric_id.startsWith("git.age_days:")) return false;
    const path = metric.metric_id.slice("git.age_days:".length).toLowerCase();
    return patterns.some((pattern) => pattern.test(path));
  });
  if (matches.length === 0) return null;
  return {
    observation_id: observationId,
    value: 1,
    unit: new Set([
      "engineering.documentation.contracts_and_runbooks",
      "engineering.documentation.change_context",
    ]).has(observationId) ? "ratio" : "state",
    state: matches.every((metric) => metric.status === "measured" && metric.completeness === 1 && metric.confidence === 1) ? "complete" : "partial",
    coverage: Math.min(...matches.map((metric) => metric.completeness)),
    confidence: Math.min(...matches.map((metric) => metric.confidence)),
    context: {
      family,
      aggregation: "presence",
      languages: [],
      lower_bound: false,
      ...(context.binding ? { binding: context.binding } : {}),
    },
    source_metric_ids: matches.map((metric) => metric.metric_id).sort(stableCompare),
    evidence_refs: canonicalStrings(matches.flatMap((metric) => metric.evidence_refs)),
  };
}

function mappingDebt(context, observations) {
  const mappedMetricIds = new Set(observations.flatMap((observation) => observation.source_metric_ids ?? []));
  const declaredMetricIds = new Set(OBSERVATION_SPECS.flatMap((spec) => spec[4].flat()));
  const entries = context.metrics
    .filter((metric) => OBSERVED_STATUSES.has(metric.status) && (Number.isFinite(metric.value) || typeof metric.value === "boolean")
      && metric.completeness > 0 && metric.confidence > 0
      && !mappedMetricIds.has(metric.metric_id)
      && !declaredMetricIds.has(metric.metric_id)
      // File/module observations are intentionally retained as provenance for
      // aggregate semantic observations; they are not mapping debt by
      // themselves.  Only repository-level producer records are candidates.
      && !metric.metric_id.includes(":")
      && (ASSESSABLE_FAMILY_PREFIXES.some((prefix) => metric.metric_id.startsWith(prefix))
        || (metric.metric_id.startsWith("static.cyclomatic_")
          || metric.metric_id.startsWith("static.source_"))))
    .map((metric) => ({
      metric_id: metric.metric_id,
      collector_id: metric.collector_id,
      definition_id: metric.definition_id,
      reason: "unmapped-assessable-metric",
    }))
    .sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  return {
    count: entries.length,
    mapping_failure_count: entries.length,
    metric_ids: entries.map((entry) => entry.metric_id),
    entries,
  };
}

function deriveSemanticEvidenceIndex(snapshot) {
  const context = normalizedContext(snapshot);
  const observations = OBSERVATION_SPECS.map((spec) => observationFor(context, spec)).filter(Boolean);
  const derived = [
    derivedRatio(observations, "engineering.complexity.production.outlier_ratio", "engineering.complexity.production.max", "engineering.complexity.production.p90", "complexity", "ratio"),
    derivedRatio(observations, "engineering.complexity.production.coverage", "engineering.complexity.production.parsed_file_count", "engineering.complexity.production.eligible_file_count", "complexity", "ratio"),
    derivedRatio(observations, "engineering.dependency.scc_concentration", "engineering.dependency.cyclic_node_count", "engineering.dependency.node_count", "dependency-topology", "ratio"),
    // A bounded fan-in concentration proxy is available even when a producer
    // does not publish a named centrality algorithm. It is explicitly derived
    // from the observed maximum boundary pressure and graph size, never
    // mistaken for an unverified PageRank/betweenness score.
    derivedRatio(observations, "engineering.dependency.centrality_concentration", "engineering.dependency.boundary_pressure", "engineering.dependency.node_count", "dependency-topology", "ratio"),
    derivedComplement(observations, "engineering.complexity.parser_exclusions", "engineering.complexity.production.coverage", "complexity", "ratio"),
    derivedComplement(observations, "engineering.dependency.analysis_exclusions", "engineering.dependency.node_coverage", "dependency-topology", "ratio"),
    derivedComplement(observations, "engineering.verification.test_scope_coverage", "engineering.verification.statement_coverage", "verification", "ratio"),
    pathPresence(context, "engineering.documentation.repository_overview", [/^readme(?:\.|$)/, /(^|\/)context\.md$/], "documentation"),
    pathPresence(context, "engineering.documentation.contracts_and_runbooks", [/(^|\/)(runbook|contributing|operations|docs\/adr|docs\/decisions|(?:[^/]*-)?contract)(?:\.|\/|$)/], "documentation"),
    pathPresence(context, "engineering.documentation.change_context", [/(^|\/)(changelog|decisions|adr|design|architecture)/], "documentation"),
    pathPresence(context, "engineering.documentation.onboarding_discoverability", [/(^|\/)(contributing|onboard|setup|getting-started|readme)/], "documentation"),
    // Configuration observations are path counts when present; retain that
    // same semantic unit for an explicit zero-path absence so target-policy
    // binding cannot drift between available and unavailable collectors.
    explicitAbsence(context, "engineering.delivery.ci_configuration", "delivery-configuration", ["ci-discovery"], "paths", ["discovery.ci_evidence_path_count"]),
    explicitAbsence(context, "engineering.delivery.release_configuration", "delivery-configuration", ["autonomous-deployment-and-release"], "paths", ["discovery.engineering.deployment-and-release_evidence_path_count"]),
    explicitAbsence(context, "engineering.verification.statement_coverage", "verification", ["coverage-discovery"], "ratio", ["verification.statement_coverage", "discovery.coverage_evidence_path_count"]),
    explicitAbsence(context, "engineering.security.verification", "security", ["autonomous-static-analysis-results"], "state", ["discovery.engineering.static-analysis-results_evidence_path_count"]),
  ].filter(Boolean);
  const nodeCoverage = observations.find((observation) => observation.observation_id === "engineering.dependency.node_count");
  if (nodeCoverage) {
    const coverageObservation = {
      observation_id: "engineering.dependency.node_coverage",
      value: nodeCoverage.coverage,
      unit: "ratio",
      state: nodeCoverage.state,
      coverage: nodeCoverage.coverage,
      confidence: nodeCoverage.confidence,
      context: { family: "dependency-topology", aggregation: "coverage", languages: nodeCoverage.context.languages ?? [], lower_bound: nodeCoverage.context.lower_bound === true, ...(nodeCoverage.context.binding ? { binding: nodeCoverage.context.binding } : {}) },
      source_metric_ids: [...nodeCoverage.source_metric_ids],
      evidence_refs: [...nodeCoverage.evidence_refs],
    };
    derived.push(coverageObservation);
    const exclusions = derived.find((observation) => observation.observation_id === "engineering.dependency.analysis_exclusions");
    if (!exclusions) {
      derived.push({
        observation_id: "engineering.dependency.analysis_exclusions",
        value: Number((1 - nodeCoverage.coverage).toFixed(8)),
        unit: "ratio",
        state: nodeCoverage.state,
        coverage: nodeCoverage.coverage,
        confidence: nodeCoverage.confidence,
        context: { family: "dependency-topology", aggregation: "complement", languages: nodeCoverage.context.languages ?? [], lower_bound: nodeCoverage.context.lower_bound === true, ...(nodeCoverage.context.binding ? { binding: nodeCoverage.context.binding } : {}) },
        source_metric_ids: [...nodeCoverage.source_metric_ids],
        evidence_refs: [...nodeCoverage.evidence_refs],
      });
    }
  }
  const duplicationObservations = observations.filter((observation) => observation.context.family === "duplication");
  if (duplicationObservations.length > 0 && [...context.collectors.values()].some((collector) => collector.resource_limited)) {
    derived.push({
      observation_id: "engineering.duplication.resource_limit",
      value: true,
      unit: "state",
      state: "partial",
      coverage: Math.min(...duplicationObservations.map((observation) => observation.coverage)),
      confidence: Math.min(...duplicationObservations.map((observation) => observation.confidence)),
      context: { family: "duplication", aggregation: "state", languages: [], lower_bound: true },
      source_metric_ids: [...new Set(duplicationObservations.flatMap((observation) => observation.source_metric_ids))].sort(stableCompare),
      evidence_refs: [...new Set(duplicationObservations.flatMap((observation) => observation.evidence_refs))].sort(stableCompare),
    });
  }
  const observationById = new Map(observations.map((observation) => [observation.observation_id, observation]));
  for (const observation of derived) if (!observationById.has(observation.observation_id)) observationById.set(observation.observation_id, observation);
  const allObservations = [...observationById.values()]
    .sort((left, right) => stableCompare(left.observation_id, right.observation_id));
  const semantic_digest = sha256({
    semantic_observation_version: SEMANTIC_OBSERVATION_VERSION,
    observations: allObservations.map(semanticShape).filter(Boolean),
  });
  return deepFreeze({
    semantic_observation_version: SEMANTIC_OBSERVATION_VERSION,
    semantic_digest,
    observations: allObservations,
    mapping_debt: mappingDebt(context, allObservations),
  });
}

module.exports = {
  SEMANTIC_OBSERVATION_VERSION,
  deriveSemanticEvidenceIndex,
};
