"use strict";

const { interpretEvidence } = require("./semantic-evidence.js");
const assessmentEvidence = require("./engineering-assessment-evidence.js");

const CAPABILITY_COVERAGE_VERSION = "sei.capability-coverage@1";
const MAX_TEXT = 512;
const OBSERVED_MEASUREMENT_STATUSES = new Set(["measured", "inferred"]);
const MEASUREMENT_STATUSES = new Set(["measured", "inferred", "unavailable", "not-applicable", "unverifiable"]);
const COLLECTOR_STATUSES = new Set(["available", "degraded", "unavailable"]);
const DUPLICATION_RESOURCE_LIMIT_CODES = new Set([
  "FAIL-DUPLICATION-RESOURCE-LIMIT",
  "FAIL-DUPLICATION-PARTIAL-RESOURCE-LIMIT",
]);
const LANGUAGE_SPECS = Object.freeze([
  Object.freeze({
    capability_id: "python-structure",
    title: "Python structure",
    key: "python",
    collector_id: "python-static-intelligence",
    metric_ids: [
      "static.python.cyclomatic_complexity:production",
      "static.python.cyclomatic_complexity:all-python",
      "static.cyclomatic_complexity",
    ],
    parsed_file_metric_id: "static.python.parsed_file_count:production",
    eligible_file_metric_id: "static.python.file_count:production",
  }),
  Object.freeze({
    capability_id: "tsjs-structure",
    title: "TS/JS structure",
    key: "tsjs",
    collector_id: "tsjs-static-intelligence",
    metric_ids: [
      "static.tsjs.cyclomatic_complexity:production",
      "static.tsjs.cyclomatic_complexity:all-tsjs",
    ],
    parsed_file_metric_id: "static.tsjs.parsed_file_count:production",
    eligible_file_metric_id: "static.tsjs.file_count:production",
  }),
  Object.freeze({
    capability_id: "java-structure",
    title: "Java structure",
    key: "java",
    collector_id: "java-static-intelligence",
    metric_ids: ["static.java.cyclomatic_complexity"],
    parsed_file_metric_id: null,
    eligible_file_metric_id: null,
  }),
  Object.freeze({
    capability_id: "kotlin-structure",
    title: "Kotlin structure",
    key: "kotlin",
    collector_id: "kotlin-static-intelligence",
    metric_ids: ["static.kotlin.cyclomatic_complexity"],
    parsed_file_metric_id: null,
    eligible_file_metric_id: null,
  }),
]);

function fail(detail) {
  const error = new Error(`FAIL-CAPABILITY-COVERAGE: ${detail}`);
  error.code = "FAIL-CAPABILITY-COVERAGE";
  throw error;
}

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT
    && value.trim() === value && !value.includes("\0") && !/[\r\n]/.test(value);
}

function assertFraction(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite ratio from zero through one`);
  }
}

function canonicalStrings(values) {
  return [...new Set(values.filter(isBoundedText))].sort(stableCompare);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function failureCode(reason) {
  if (typeof reason !== "string") return null;
  const separator = reason.indexOf(":");
  const code = separator === -1 ? reason : reason.slice(0, separator);
  return /^[A-Z0-9-]+$/.test(code) ? code : null;
}

function normalizeSnapshot(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.collectors) || !Array.isArray(snapshot.measurements)) {
    fail("snapshot must contain collectors and measurements arrays");
  }
  if (snapshot.collectors.length === 0 || snapshot.measurements.length === 0) {
    fail("snapshot must contain at least one collector and measurement");
  }

  const collectors = new Map();
  for (const collector of snapshot.collectors) {
    if (!isRecord(collector) || !isBoundedText(collector.collector_id)
        || !isBoundedText(collector.collector_version) || !COLLECTOR_STATUSES.has(collector.status)) {
      fail("collector identity, version, and status must be valid");
    }
    if (collectors.has(collector.collector_id)) fail(`duplicate collector ${collector.collector_id}`);
    collectors.set(collector.collector_id, Object.freeze({
      collector_id: collector.collector_id,
      collector_version: collector.collector_version,
      status: collector.status,
      reason: typeof collector.reason === "string" ? collector.reason : null,
    }));
  }

  const metrics = [];
  const metricById = new Map();
  for (const metric of snapshot.measurements) {
    if (!isRecord(metric) || !isBoundedText(metric.metric_id) || !isRecord(metric.measurement)
        || !isRecord(metric.source) || !MEASUREMENT_STATUSES.has(metric.measurement.status)) {
      fail("measurement identity, state, and source must be valid");
    }
    if (metricById.has(metric.metric_id)) fail(`duplicate metric ${metric.metric_id}`);
    assertFraction(metric.measurement.completeness, `${metric.metric_id}.measurement.completeness`);
    assertFraction(metric.measurement.confidence, `${metric.metric_id}.measurement.confidence`);
    if (!isBoundedText(metric.source.collector_id) || !isBoundedText(metric.source.collector_version)) {
      fail(`${metric.metric_id} must bind a collector identity and version`);
    }
    const collector = collectors.get(metric.source.collector_id);
    if (!collector || collector.collector_version !== metric.source.collector_version) {
      fail(`${metric.metric_id} does not have an unambiguous collector binding`);
    }
    if (metric.value !== null && (typeof metric.value !== "number" || !Number.isFinite(metric.value))) {
      fail(`${metric.metric_id}.value must be a finite number or null`);
    }
    const references = canonicalStrings([
      ...(Array.isArray(metric.source.artifact_refs) ? metric.source.artifact_refs : []),
      ...(Array.isArray(metric.source.evidence_refs) ? metric.source.evidence_refs : []),
    ]);
    const normalized = Object.freeze({
      metric_id: metric.metric_id,
      value: metric.value,
      measurement: Object.freeze({
        status: metric.measurement.status,
        completeness: metric.measurement.completeness,
        confidence: metric.measurement.confidence,
      }),
      collector,
      references: Object.freeze(references),
      scope: isRecord(metric.scope) ? Object.freeze({
        kind: typeof metric.scope.kind === "string" ? metric.scope.kind : null,
        path: typeof metric.scope.path === "string" ? metric.scope.path : null,
        language: typeof metric.scope.language === "string" ? metric.scope.language.toLowerCase() : null,
        generated_code: metric.scope.generated_code === true,
      }) : Object.freeze({ kind: null, path: null, language: null, generated_code: false }),
    });
    metrics.push(normalized);
    metricById.set(normalized.metric_id, normalized);
  }
  metrics.sort((left, right) => stableCompare(left.metric_id, right.metric_id));
  return Object.freeze({ collectors, metrics: Object.freeze(metrics), metricById });
}

function observedMetric(metric) {
  return metric !== undefined && metric !== null
    && OBSERVED_MEASUREMENT_STATUSES.has(metric.measurement.status)
    && typeof metric.value === "number" && Number.isFinite(metric.value)
    && metric.measurement.completeness > 0 && metric.measurement.confidence > 0
    && metric.collector.status !== "unavailable" && metric.references.length > 0;
}

function firstCollector(context, collectorIds) {
  return collectorIds.map((collectorId) => context.collectors.get(collectorId)).find(Boolean) ?? null;
}

function chooseObservedMetric(context, metricIds, collectorIds = null) {
  const requested = new Set(metricIds);
  // Mapped producer metrics are selected through the package-private semantic
  // index.  Raw fallback remains only for discovery facts with no vocabulary
  // observation, preserving the bounded legacy capability surface.
  const semanticMetricIds = context.semanticIndex
    ? new Set(context.semanticIndex.observations.flatMap((observation) => observation.source_metric_ids ?? [])
      .filter((metricId) => requested.has(metricId)))
    : new Set();
  // Once a canonical semantic index is available, an unrecognised raw ID must
  // remain unresolved. Falling back to the producer spelling here would let
  // guessed/renamed metrics bypass the shared meaning boundary.
  const effectiveIds = context.semanticIndex ? semanticMetricIds : requested;
  const rank = new Map(metricIds.map((metricId, index) => [metricId, index]));
  return context.metrics
    .filter((metric) => effectiveIds.has(metric.metric_id)
      && (collectorIds === null || collectorIds.includes(metric.collector.collector_id))
      && observedMetric(metric))
    .sort((left, right) => rank.get(left.metric_id) - rank.get(right.metric_id)
      || stableCompare(left.metric_id, right.metric_id))[0] ?? null;
}

// Resolve a capability through the semantic vocabulary first, then retain the
// raw measurement only as provenance for the existing presentation contract.
// This keeps capability coverage and assessment synthesis on one meaning
// boundary without exposing producer IDs as public capability semantics.
function chooseSemanticObservedMetric(context, semanticIndex, observationId, collectorIds = null) {
  const observation = semanticIndex?.observations?.find((item) => item.observation_id === observationId);
  if (!observation) return null;
  return chooseObservedMetric(context, observation.source_metric_ids ?? [], collectorIds);
}

function firstMetric(context, metricIds, collectorIds = null) {
  const requested = new Set(metricIds);
  const semanticMetricIds = context.semanticIndex
    ? new Set(context.semanticIndex.observations.flatMap((observation) => observation.source_metric_ids ?? [])
      .filter((metricId) => requested.has(metricId)))
    : new Set();
  const effectiveIds = context.semanticIndex ? semanticMetricIds : requested;
  const rank = new Map(metricIds.map((metricId, index) => [metricId, index]));
  return context.metrics
    .filter((metric) => effectiveIds.has(metric.metric_id)
      && (collectorIds === null || collectorIds.includes(metric.collector.collector_id)))
    .sort((left, right) => rank.get(left.metric_id) - rank.get(right.metric_id)
      || stableCompare(left.metric_id, right.metric_id))[0] ?? null;
}

function uniqueMetrics(metrics) {
  return [...new Map(metrics.filter(Boolean).map((metric) => [metric.metric_id, metric])).values()]
    .sort((left, right) => stableCompare(left.metric_id, right.metric_id));
}

function evidenceFromObserved(metric, {
  conditionCode,
  supportingMetrics = [],
  exclusions = [],
} = {}) {
  const inputs = uniqueMetrics([metric, ...supportingMetrics]);
  return interpretEvidence({
    value: metric.value,
    measurement: metric.measurement,
    collector: { status: metric.collector.status, binding_valid: true },
    condition: { kind: "observed", code: conditionCode },
    source_metric_ids: inputs.map((item) => item.metric_id),
    evidence_refs: canonicalStrings(inputs.flatMap((item) => item.references)),
    exclusions,
  });
}

function evidenceFromCondition({
  capabilityId,
  state,
  code,
  collector = null,
  metric = null,
}) {
  const sourceMetricIds = metric ? [metric.metric_id] : [`capability:${capabilityId}`];
  const evidenceRefs = metric?.references.length > 0 ? metric.references : [`capability:${capabilityId}`];
  return interpretEvidence({
    value: null,
    measurement: {
      status: state === "not-applicable" ? "not-applicable" : "unavailable",
      completeness: 0,
      confidence: 0,
    },
    collector: { status: collector?.status ?? "available", binding_valid: true },
    condition: { kind: state, code },
    source_metric_ids: sourceMetricIds,
    evidence_refs: evidenceRefs,
    exclusions: [],
  });
}

function fact(label, value, unit) {
  return { label, value, unit };
}

function capability({
  capabilityId,
  title,
  applicable,
  evidence,
  summary,
  limitation,
  nextEvidence,
  facts = [],
}) {
  if (!isBoundedText(capabilityId) || !isBoundedText(title) || typeof applicable !== "boolean"
      || !isBoundedText(summary) || !isBoundedText(limitation) || !isBoundedText(nextEvidence)) {
    fail(`capability ${capabilityId} is not a bounded presentation record`);
  }
  if (!Array.isArray(facts) || facts.length > 4 || facts.some((item) => !isRecord(item)
      || !isBoundedText(item.label) || typeof item.value !== "number" || !Number.isFinite(item.value)
      || !isBoundedText(item.unit))) {
    fail(`capability ${capabilityId} has invalid facts`);
  }
  return {
    capability_id: capabilityId,
    title,
    applicable,
    evidence,
    summary,
    limitation,
    next_evidence: nextEvidence,
    facts,
  };
}

function sourceInventoryCapability(context) {
  const collector = context.collectors.get("static-source") ?? null;
  const metric = chooseObservedMetric(context, [
    "static.human_source_file_count",
    "static.source_file_count",
  ], ["static-source"]);
  if (metric) {
    return capability({
      capabilityId: "source-inventory",
      title: "Source inventory",
      applicable: true,
      evidence: evidenceFromObserved(metric, { conditionCode: "observed-source-inventory" }),
      summary: `${metric.value} human-maintained source files were inventoried.`,
      limitation: "No known source-inventory limitation was recorded.",
      nextEvidence: "Rerun SEI after source inventory changes.",
      facts: [fact("Human-maintained source files", metric.value, "files")],
    });
  }
  const state = collector?.status === "unavailable" ? "not-detected" : "unresolved";
  return capability({
    capabilityId: "source-inventory",
    title: "Source inventory",
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId: "source-inventory",
      state,
      code: state === "not-detected" ? "source-inventory-not-detected" : "source-inventory-not-resolved",
      collector,
    }),
    summary: state === "not-detected" ? "No supported source inventory was detected." : "Source inventory could not be resolved from the supplied snapshot.",
    limitation: "This is an SEI evidence limitation, not a claim that the repository has no source.",
    nextEvidence: "Provide a revision-bound source inventory and rerun SEI.",
  });
}

function exactCoveredCount(total, coverage) {
  if (!Number.isSafeInteger(total) || total < 0) return null;
  const candidate = Math.round(total * coverage);
  return Math.abs(total * coverage - candidate) <= 0.000001 ? candidate : null;
}

function changeHistoryCapability(context, semanticIndex) {
  const collector = context.collectors.get("git-history") ?? null;
  const total = chooseObservedMetric(context, ["git.change_frequency"], ["git-history"]);
  const observed = chooseSemanticObservedMetric(context, semanticIndex, "engineering.git.observed_churn", ["git-history"])
    ?? chooseSemanticObservedMetric(context, semanticIndex, "engineering.git.co_change_pressure", ["git-history"])
    ?? chooseSemanticObservedMetric(context, semanticIndex, "engineering.git.ownership_concentration", ["git-history"])
    ?? chooseSemanticObservedMetric(context, semanticIndex, "engineering.git.change_frequency", ["git-history"]);
  if (observed) {
    const observedCount = total ? exactCoveredCount(total.value, observed.measurement.completeness) : null;
    const exclusions = observedCount !== null && observedCount < total.value
      ? [{ code: "unattributed-history-revisions", count: total.value - observedCount, value_affecting: true }]
      : [];
    const evidence = evidenceFromObserved(observed, {
      conditionCode: "observed-change-history",
      supportingMetrics: total && total.metric_id !== observed.metric_id ? [total] : [],
      exclusions,
    });
    const facts = total ? [fact("History revisions", total.value, "revisions")] : [];
    if (observedCount !== null && observedCount < total.value) facts.push(fact("Attributed revisions", observedCount, "revisions"));
    return capability({
      capabilityId: "change-history",
      title: "Git/change behavior",
      applicable: true,
      evidence,
      summary: observedCount !== null && total && observedCount < total.value
        ? `${observedCount} of ${total.value} revisions produced attributable change evidence.`
        : total ? `Change history was observed across ${total.value} revisions.` : "Revision-bound change behavior was observed.",
      limitation: evidence.state === "complete"
        ? "No known change-history attribution limitation was recorded."
        : "Some revision-level file-change attribution is unavailable.",
      nextEvidence: evidence.state === "complete"
        ? "Rerun SEI after additional revisions are available."
        : "Provide attributable file-change evidence for the excluded revisions.",
      facts,
    });
  }
  const state = collector?.status === "unavailable" ? "not-detected" : "unresolved";
  return capability({
    capabilityId: "change-history",
    title: "Git/change behavior",
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId: "change-history",
      state,
      code: state === "not-detected" ? "change-history-not-detected" : "change-history-not-resolved",
      collector,
    }),
    summary: state === "not-detected" ? "No usable Git change-history evidence was detected." : "Git change behavior could not be resolved from the supplied snapshot.",
    limitation: "This is an evidence limitation, not a claim that the repository has no change history.",
    nextEvidence: "Analyze a revision-bound Git history with attributable file changes.",
  });
}

function languageAliases(key) {
  if (key === "tsjs") return new Set(["javascript", "typescript", "tsjs", "tsx", "jsx"]);
  return new Set([key]);
}

function languageIsApplicable(context, key) {
  const aliases = languageAliases(key);
  return context.metrics.some((metric) => metric.scope.kind === "file" && metric.scope.generated_code === false
    && aliases.has(metric.scope.language));
}

function languageFileFacts(context, spec) {
  const collectorIds = [spec.collector_id];
  const parsed = spec.parsed_file_metric_id === null ? null
    : chooseObservedMetric(context, [spec.parsed_file_metric_id], collectorIds);
  const eligible = spec.eligible_file_metric_id === null ? null
    : chooseObservedMetric(context, [spec.eligible_file_metric_id], collectorIds);
  const facts = [];
  if (parsed) facts.push(fact("Analyzed files", parsed.value, "files"));
  if (eligible && (!parsed || eligible.metric_id !== parsed.metric_id)) facts.push(fact("Eligible files", eligible.value, "files"));
  if (facts.length === 0) {
    const paths = new Set(context.metrics.filter((metric) => metric.collector.collector_id === spec.collector_id
      && metric.scope.kind === "file" && observedMetric(metric)).map((metric) => metric.scope.path).filter(Boolean));
    if (paths.size > 0) facts.push(fact("Analyzed files", paths.size, "files"));
  }
  return facts;
}

function languageStructureCapability(context, spec) {
  const collector = context.collectors.get(spec.collector_id) ?? null;
  if (!languageIsApplicable(context, spec.key)) {
    return capability({
      capabilityId: spec.capability_id,
      title: spec.title,
      applicable: false,
      evidence: evidenceFromCondition({
        capabilityId: spec.capability_id,
        state: "not-applicable",
        code: `no-${spec.key}-source-detected`,
        collector,
      }),
      summary: `No human-maintained ${spec.title.replace(" structure", "")} source was detected.`,
      limitation: "This capability does not apply to the observed repository source.",
      nextEvidence: "Add supported source for this language, then rerun SEI.",
    });
  }
  const metric = chooseObservedMetric(context, spec.metric_ids, [spec.collector_id]);
  if (metric) {
    const cognitive = spec.key === "java"
      ? firstMetric(context, ["static.java.cognitive_complexity"], [spec.collector_id]) : null;
    const cognitiveMissing = cognitive !== null && !observedMetric(cognitive);
    const evidence = evidenceFromObserved(metric, {
      conditionCode: `observed-${spec.key}-structure`,
      supportingMetrics: cognitiveMissing ? [cognitive] : [],
      exclusions: cognitiveMissing
        ? [{ code: "cognitive-complexity-not-measured", count: 1, value_affecting: true }]
        : [],
    });
    return capability({
      capabilityId: spec.capability_id,
      title: spec.title,
      applicable: true,
      evidence,
      summary: cognitiveMissing
        ? `${spec.title} cyclomatic structure was analyzed; cognitive complexity is not currently measured.`
        : `${spec.title} was structurally analyzed.`,
      limitation: evidence.state === "complete"
        ? "No known structural-analysis coverage limitation was recorded."
        : `Some ${spec.title} source or structural dimensions are not covered.`,
      nextEvidence: evidence.state === "complete"
        ? "Rerun SEI after source changes."
        : `Repair unsupported or unparsed ${spec.title} source, then rerun SEI.`,
      facts: languageFileFacts(context, spec),
    });
  }
  if (spec.key === "kotlin" && collector?.status === "unavailable") {
    return capability({
      capabilityId: spec.capability_id,
      title: spec.title,
      applicable: true,
      evidence: evidenceFromCondition({
        capabilityId: spec.capability_id,
        state: "unsupported",
        code: "kotlin-structural-runtime-unsupported",
        collector,
        metric: firstMetric(context, spec.metric_ids, [spec.collector_id]),
      }),
      summary: "Kotlin source was found, but the current runtime does not provide a verified Kotlin structural analyzer.",
      limitation: "This is an SEI runtime limitation, not evidence that Kotlin structure is simple or absent.",
      nextEvidence: "Provide a verified Kotlin structural analyzer and rerun SEI.",
    });
  }
  return capability({
    capabilityId: spec.capability_id,
    title: spec.title,
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId: spec.capability_id,
      state: "unresolved",
      code: `${spec.key}-structure-not-resolved`,
      collector,
      metric: firstMetric(context, spec.metric_ids, [spec.collector_id]),
    }),
    summary: `${spec.title} could not be resolved from the supplied snapshot.`,
    limitation: "The available machine state does not establish a human evidence classification.",
    nextEvidence: `Provide revision-bound ${spec.title} analysis and rerun SEI.`,
  });
}

function dependencyTopologyCapability(context) {
  const applicable = languageIsApplicable(context, "python") || languageIsApplicable(context, "tsjs");
  const collectorIds = ["dependency-intelligence-tsjs", "tsjs-static-intelligence", "python-static-intelligence"];
  const collector = firstCollector(context, collectorIds);
  if (!applicable) {
    return capability({
      capabilityId: "dependency-topology",
      title: "Dependency topology",
      applicable: false,
      evidence: evidenceFromCondition({
        capabilityId: "dependency-topology",
        state: "not-applicable",
        code: "no-supported-topology-source-detected",
        collector,
      }),
      summary: "No source supported by the current dependency analyzers was detected.",
      limitation: "This capability does not apply to the observed repository source.",
      nextEvidence: "Add supported Python or TS/JS source, then rerun SEI.",
    });
  }
  const metric = chooseObservedMetric(context, [
    "static.dependency.node_count:tsjs",
    "static.tsjs.dependency.node_count:production",
    "static.tsjs.dependency.node_count:all-tsjs",
    "static.python.dependency.node_count:production",
    "static.python.dependency.node_count:all-python",
  ], collectorIds);
  if (metric) {
    const evidence = evidenceFromObserved(metric, { conditionCode: "observed-dependency-topology" });
    return capability({
      capabilityId: "dependency-topology",
      title: "Dependency topology",
      applicable: true,
      evidence,
      summary: `${metric.value} dependency nodes were analyzed.`,
      limitation: evidence.state === "complete"
        ? "No known dependency-analysis coverage limitation was recorded."
        : "Some supported modules were not included in the dependency analysis.",
      nextEvidence: evidence.state === "complete"
        ? "Rerun SEI after dependency changes."
        : "Repair unsupported or unparsed modules, then rerun SEI.",
      facts: [fact("Analyzed dependency nodes", metric.value, "modules")],
    });
  }
  return capability({
    capabilityId: "dependency-topology",
    title: "Dependency topology",
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId: "dependency-topology",
      state: "unresolved",
      code: "dependency-topology-not-resolved",
      collector,
    }),
    summary: "Dependency topology could not be resolved from the supplied snapshot.",
    limitation: "The available machine state does not establish usable dependency evidence.",
    nextEvidence: "Provide revision-bound dependency analysis and rerun SEI.",
  });
}

function testExecutionCapability(context) {
  const execution = chooseObservedMetric(context, ["verification.autonomous_tests_total", "verification.tests_total"], ["autonomous-local-execution", "verification-summary"]);
  if (execution) {
    const evidence = evidenceFromObserved(execution, { conditionCode: "observed-test-execution" });
    return capability({
      capabilityId: "test-execution",
      title: "Test execution",
      applicable: true,
      evidence,
      summary: "Revision-bound test execution evidence is available.",
      limitation: evidence.state === "complete" ? "No known execution-evidence limitation was recorded." : "Test execution evidence is only partially complete.",
      nextEvidence: "Bind a current test execution artifact after the next run.",
      facts: [fact("Observed tests", execution.value, "tests")],
    });
  }
  const discovery = firstMetric(context, ["discovery.test_evidence_path_count"], ["test-discovery"]);
  const collector = context.collectors.get("test-discovery") ?? context.collectors.get("verification-summary") ?? null;
  if (observedMetric(discovery) && discovery.value > 0) {
    return capability({
      capabilityId: "test-execution",
      title: "Test execution",
      applicable: true,
      evidence: evidenceFromCondition({
        capabilityId: "test-execution",
        state: "configured-not-observed",
        code: "test-configuration-found-execution-not-observed",
        collector: discovery.collector,
        metric: discovery,
      }),
      summary: `${discovery.value} test paths were found, but no revision-bound execution result is available.`,
      limitation: "Configured tests are not evidence that a test run passed or failed.",
      nextEvidence: "Bind a revision-matched test execution artifact.",
      facts: [fact("Test paths found", discovery.value, "paths")],
    });
  }
  const state = collector?.status === "unavailable" || (observedMetric(discovery) && discovery.value === 0)
    ? "not-detected" : "unresolved";
  return capability({
    capabilityId: "test-execution",
    title: "Test execution",
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId: "test-execution",
      state,
      code: state === "not-detected" ? "test-evidence-not-detected" : "test-evidence-not-resolved",
      collector,
      metric: discovery,
    }),
    summary: state === "not-detected" ? "No test configuration or execution evidence was detected." : "Test execution evidence could not be resolved from the supplied snapshot.",
    limitation: "This is an evidence limitation, not a claim about test quality.",
    nextEvidence: "Provide test configuration or a revision-bound execution artifact.",
  });
}

function coverageCapability(context) {
  const coverage = chooseObservedMetric(context, [
    "verification.statement_coverage",
    "verification.branch_coverage",
  ], ["verification-summary"]);
  if (coverage) {
    const evidence = evidenceFromObserved(coverage, { conditionCode: "observed-coverage-execution" });
    return capability({
      capabilityId: "coverage",
      title: "Coverage",
      applicable: true,
      evidence,
      summary: "Revision-bound coverage execution evidence is available.",
      limitation: evidence.state === "complete" ? "No known coverage-evidence limitation was recorded." : "Coverage evidence is only partially complete.",
      nextEvidence: "Bind a current coverage artifact after the next run.",
    });
  }
  const discovery = firstMetric(context, ["discovery.coverage_evidence_path_count"], ["coverage-discovery"]);
  const collector = context.collectors.get("coverage-discovery") ?? context.collectors.get("coverage-adapter") ?? null;
  if (observedMetric(discovery) && discovery.value > 0) {
    return capability({
      capabilityId: "coverage",
      title: "Coverage",
      applicable: true,
      evidence: evidenceFromCondition({
        capabilityId: "coverage",
        state: "configured-not-observed",
        code: "coverage-configuration-found-result-not-observed",
        collector: discovery.collector,
        metric: discovery,
      }),
      summary: "Coverage configuration was found, but no revision-bound coverage result is available.",
      limitation: "Configuration is not a measured coverage result.",
      nextEvidence: "Bind a revision-matched coverage artifact.",
      facts: [fact("Coverage evidence paths", discovery.value, "paths")],
    });
  }
  const state = collector?.status === "unavailable" || (observedMetric(discovery) && discovery.value === 0)
    ? "not-detected" : "unresolved";
  return capability({
    capabilityId: "coverage",
    title: "Coverage",
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId: "coverage",
      state,
      code: state === "not-detected" ? "coverage-evidence-not-detected" : "coverage-evidence-not-resolved",
      collector,
      metric: discovery,
    }),
    summary: state === "not-detected" ? "No supported committed coverage evidence was detected." : "Coverage evidence could not be resolved from the supplied snapshot.",
    limitation: "This is an evidence limitation, not a claim that coverage is absent.",
    nextEvidence: "Provide a revision-bound coverage artifact or supported configuration.",
  });
}

function ciCapability(context) {
  const discovery = firstMetric(context, ["discovery.ci_evidence_path_count"], ["ci-discovery"]);
  const collector = context.collectors.get("ci-discovery") ?? context.collectors.get("ci-adapter") ?? null;
  if (observedMetric(discovery) && discovery.value > 0) {
    return capability({
      capabilityId: "ci",
      title: "CI",
      applicable: true,
      evidence: evidenceFromCondition({
        capabilityId: "ci",
        state: "configured-not-observed",
        code: "ci-configuration-found-execution-not-observed",
        collector: discovery.collector,
        metric: discovery,
      }),
      summary: "Committed CI configuration was found, but no revision-bound CI result is available.",
      limitation: "Configuration is not evidence that CI executed successfully.",
      nextEvidence: "Bind a revision-matched CI result.",
      facts: [fact("CI evidence paths", discovery.value, "paths")],
    });
  }
  const state = collector?.status === "unavailable" || (observedMetric(discovery) && discovery.value === 0)
    ? "not-detected" : "unresolved";
  return capability({
    capabilityId: "ci",
    title: "CI",
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId: "ci",
      state,
      code: state === "not-detected" ? "ci-evidence-not-detected" : "ci-evidence-not-resolved",
      collector,
      metric: discovery,
    }),
    summary: state === "not-detected" ? "No supported committed CI evidence was detected." : "CI evidence could not be resolved from the supplied snapshot.",
    limitation: "This is an evidence limitation, not a claim that CI is absent.",
    nextEvidence: "Provide committed CI configuration or a revision-bound CI result.",
  });
}

function duplicationCapability(context) {
  const collector = context.collectors.get("structural-duplication-intelligence") ?? null;
  const resourceLimited = collector !== null && DUPLICATION_RESOURCE_LIMIT_CODES.has(failureCode(collector.reason));
  const metric = chooseObservedMetric(context, [
    "static.duplication.observed_percentage",
    "static.duplication.analyzed_source_lines",
    "static.duplication.clone_family_count",
  ], ["structural-duplication-intelligence"]);
  if (metric) {
    const evidence = evidenceFromObserved(metric, {
      conditionCode: "observed-duplication-analysis",
      exclusions: resourceLimited
        ? [{ code: "duplication-resource-bound", count: 1, value_affecting: true }]
        : [],
    });
    return capability({
      capabilityId: "duplication",
      title: "Duplication",
      applicable: true,
      evidence,
      summary: resourceLimited
        ? "Duplication analysis retained partial lower-bound observations before a resource limit was reached."
        : "Structural duplication evidence is available.",
      limitation: resourceLimited || evidence.state !== "complete"
        ? "The available duplication result does not describe every eligible source region."
        : "No known duplication-analysis coverage limitation was recorded.",
      nextEvidence: resourceLimited
        ? "Increase the bounded clone-analysis capacity or analyze a smaller source scope."
        : "Rerun SEI after source changes.",
    });
  }
  const metricReference = firstMetric(context, [
    "static.duplication.analyzed_source_lines",
    "static.duplication.clone_family_count",
  ], ["structural-duplication-intelligence"]);
  if (resourceLimited) {
    return capability({
      capabilityId: "duplication",
      title: "Duplication",
      applicable: true,
      evidence: evidenceFromCondition({
        capabilityId: "duplication",
        state: "resource-limited",
        code: "duplication-resource-limit",
        collector,
        metric: metricReference,
      }),
      summary: "Duplication analysis did not complete because its bounded clone-candidate capacity was reached.",
      limitation: "This is an SEI resource limitation, not evidence that duplication is absent.",
      nextEvidence: "Increase the bounded clone-analysis capacity or analyze a smaller source scope.",
    });
  }
  return capability({
    capabilityId: "duplication",
    title: "Duplication",
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId: "duplication",
      state: "unresolved",
      code: "duplication-analysis-not-resolved",
      collector,
      metric: metricReference,
    }),
    summary: "Duplication evidence could not be resolved from the supplied snapshot.",
    limitation: "The available machine state does not establish a human duplication classification.",
    nextEvidence: "Provide a revision-bound structural duplication analysis and rerun SEI.",
  });
}

function externalCapability(context, {
  capabilityId,
  title,
  collectorIds,
  metricIds,
  summary,
  nextEvidence,
}) {
  const collector = firstCollector(context, collectorIds);
  const observed = chooseObservedMetric(context, metricIds, collectorIds);
  if (observed) {
    const evidence = evidenceFromObserved(observed, { conditionCode: `observed-${capabilityId}` });
    return capability({
      capabilityId,
      title,
      applicable: true,
      evidence,
      summary: `${title} evidence is available.`,
      limitation: evidence.state === "complete" ? "No known evidence-coverage limitation was recorded." : `${title} evidence is only partially complete.`,
      nextEvidence,
    });
  }
  if (collector === null || collector.status === "unavailable") {
    return capability({
      capabilityId,
      title,
      applicable: true,
      evidence: evidenceFromCondition({
        capabilityId,
        state: "external-required",
        code: `external-${capabilityId}-evidence-required`,
        collector,
      }),
      summary,
      limitation: "This evidence comes from systems outside the committed repository snapshot.",
      nextEvidence,
    });
  }
  return capability({
    capabilityId,
    title,
    applicable: true,
    evidence: evidenceFromCondition({
      capabilityId,
      state: "unresolved",
      code: `${capabilityId}-evidence-not-resolved`,
      collector,
    }),
    summary: `${title} evidence could not be resolved from the supplied snapshot.`,
    limitation: "The available machine state does not establish a human evidence classification.",
    nextEvidence,
  });
}

function deriveCapabilityCoverage(snapshot) {
  // Keep capability coverage on the same canonical producer-to-meaning boundary
  // that assessment synthesis consumes. The index remains package-private so this
  // presentation contract does not become another public artifact format.
  let semanticIndex;
  try {
    semanticIndex = assessmentEvidence.deriveSemanticEvidenceIndex(snapshot);
  } catch (error) {
    fail(error?.message ?? "semantic evidence index could not be derived");
  }
  const context = { ...normalizeSnapshot(snapshot), semanticIndex };
  const capabilities = [
    sourceInventoryCapability(context),
    changeHistoryCapability(context, semanticIndex),
    ...LANGUAGE_SPECS.map((spec) => languageStructureCapability(context, spec)),
    dependencyTopologyCapability(context),
    testExecutionCapability(context),
    coverageCapability(context),
    ciCapability(context),
    duplicationCapability(context),
    externalCapability(context, {
      capabilityId: "work-item-flow",
      title: "Work-item flow",
      collectorIds: ["kanban-work-item-flow", "work-item-adapter"],
      metricIds: ["kanban.cycle_time", "kanban.throughput", "kanban.wip"],
      summary: "Work-item flow evidence requires externally supplied work-item data.",
      nextEvidence: "Bind revision-matched work-item evidence from the delivery system.",
    }),
    externalCapability(context, {
      capabilityId: "pr-review-flow",
      title: "PR/review flow",
      collectorIds: ["pr-flow", "autonomous-review-metadata"],
      metricIds: ["flow.pr_count", "flow.first_review_p50_ms", "flow.merge_p50_ms"],
      summary: "PR and review-flow evidence requires externally supplied review metadata.",
      nextEvidence: "Bind revision-matched PR and review metadata.",
    }),
    externalCapability(context, {
      capabilityId: "deployment-dora",
      title: "Deployment and DORA",
      collectorIds: ["dora-deployment-evidence", "deployment-events", "deployment-adapter"],
      metricIds: ["dora.deployment_frequency", "deployment.started_count", "deployment.succeeded_count"],
      summary: "Deployment and DORA evidence requires externally supplied delivery-event data.",
      nextEvidence: "Bind revision-matched deployment and delivery-event evidence.",
    }),
  ];
  return deepFreeze({
    capability_coverage_version: CAPABILITY_COVERAGE_VERSION,
    capabilities,
  });
}

module.exports = {
  CAPABILITY_COVERAGE_VERSION,
  deriveCapabilityCoverage,
};

Object.defineProperty(module.exports, Symbol.for("sei.capability-coverage.private.v1"), {
  value: Object.freeze({
    SEMANTIC_OBSERVATION_VERSION: assessmentEvidence.SEMANTIC_OBSERVATION_VERSION,
    deriveSemanticEvidenceIndex: assessmentEvidence.deriveSemanticEvidenceIndex,
  }),
  enumerable: false,
  configurable: false,
  writable: false,
});
