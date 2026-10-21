"use strict";

const crypto = require("node:crypto");

const { validateSnapshot } = require("./intelligence-engine.js");
const { deriveCapabilityCoverage } = require("./capability-coverage.js");
const { deriveComplexityPresentation } = require("./complexity-presentation.js");
const { PREDICTIVE_STATUS_VERSION, derivePredictiveStatus } = require("./predictive-status.js");
const { deriveTrendStatus } = require("./trend-status.js");
const forwardTemporalPrivate = require("./forward-temporal-evaluator.js")[Symbol.for("sei.forward-temporal-evaluator.private.v1")];
const engineeringAssessment = require("./engineering-assessment.js");
const engineeringAssessmentPrivate = engineeringAssessment[Symbol.for("sei.engineering-assessment.private.v1")];

const REPORT_PROJECTION_VERSION = "sei.report-projection@3";
const REPORT_PROJECTION_COMPATIBLE = new Set(["sei.report-projection@2", REPORT_PROJECTION_VERSION]);
const LIMITS = Object.freeze({
  capabilities: 16,
  composition: 12,
  complexity_partitions: 12,
  complexity_groups: 8,
  complexity_group_items: 12,
  complexity_distributions: 24,
  complexity_top_items: 12,
  scatter: 60,
  investigations: 15,
  topology: 20,
  coupling: 20,
  duplication: 12,
  trend: 20,
  text: 240,
});
const EVIDENCE_STATES = Object.freeze([
  "measured",
  "inferred",
  "unavailable",
  "not-applicable",
  "unverifiable",
]);
const PREDICTIVE_STATUS_STATES = new Set([
  "not-yet-evaluated",
  "evaluated-current",
  "previously-evaluated-compatible-not-current",
  "prior-evaluation-not-comparable",
  "unresolved",
  "NOT_READY",
  "READY_NOT_EVALUATED",
  "VALIDATED_BASELINE",
  "VALIDATED_MODEL",
  "NO_USEFUL_SIGNAL",
  "STALE",
  "INCOMPATIBLE",
]);
const V9_PREDICTIVE_STATES = new Set([
  "NOT_READY",
  "READY_NOT_EVALUATED",
  "VALIDATED_BASELINE",
  "VALIDATED_MODEL",
  "NO_USEFUL_SIGNAL",
  "STALE",
  "INCOMPATIBLE",
]);
const V9_HORIZONS = Object.freeze([10, 25, 50]);
const TREND_STATUS_STATES = new Set([
  "first-compatible-sei-observation-with-observed-history",
  "first-compatible-sei-observation",
  "prior-compatible-baseline-selected",
  "prior-baseline-incompatible",
  "repository-history-insufficient",
  "unresolved",
]);

function stableCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, maximum = LIMITS.text) {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1)}…`;
}

function rounded(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function snapshotDigest(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

function observed(metric) {
  return metric?.measurement?.status === "measured" || metric?.measurement?.status === "inferred";
}

function bounded(items, maximum) {
  return {
    items: items.slice(0, maximum),
    omitted_count: Math.max(0, items.length - maximum),
  };
}

function emptyState({ headline, missing, causeKind, explanation, availabilityPath }) {
  return {
    headline: boundedText(headline),
    missing: boundedText(missing),
    cause_kind: boundedText(causeKind, 80),
    explanation: boundedText(explanation),
    availability_path: boundedText(availabilityPath),
  };
}

function availability(items, reason, empty = null) {
  return {
    state: items.length > 0 ? "available" : "unavailable",
    reason: items.length > 0 ? null : reason,
    empty_state: items.length > 0 ? null : empty ?? emptyState({
      headline: "No evidence is available for this view",
      missing: "Observed evidence",
      causeKind: "not-observed",
      explanation: reason,
      availabilityPath: "Provide revision-bound evidence and rerun SEI.",
    }),
  };
}

function languageFor(metric) {
  const language = metric?.scope?.language;
  if (typeof language === "string" && language.length > 0 && language !== "all") {
    return boundedText(language.toLowerCase(), 40);
  }
  const id = metric?.metric_id ?? "";
  if (/\.python\./.test(id)) return "python";
  if (/\.(?:tsjs|typescript|javascript)\./.test(id)) return "ts/js";
  if (/\.java\./.test(id)) return "java";
  if (/\.kotlin\./.test(id)) return "kotlin";
  return "other";
}

function projectComposition(metrics) {
  const partitions = new Map();
  for (const metric of metrics) {
    if (!observed(metric) || metric?.scope?.generated_code === true) continue;
    const language = languageFor(metric);
    if (!partitions.has(language)) {
      partitions.set(language, { language, paths: new Set(), file_lines: new Map(), repository_lines: null, declared_files: null });
    }
    const partition = partitions.get(language);
    if (metric.scope?.kind === "file" && typeof metric.scope.path === "string") {
      partition.paths.add(metric.scope.path);
      if (/source_lines/.test(metric.metric_id) && typeof metric.value === "number") {
        partition.file_lines.set(metric.scope.path, metric.value);
      }
    }
    if (/source_file_count/.test(metric.metric_id) && typeof metric.value === "number") {
      partition.declared_files = Math.max(partition.declared_files ?? 0, metric.value);
    }
    if (/source_lines/.test(metric.metric_id) && metric.scope?.kind !== "file" && typeof metric.value === "number") {
      partition.repository_lines = Math.max(partition.repository_lines ?? 0, metric.value);
    }
  }
  const items = [...partitions.values()].map((partition) => ({
    language: partition.language,
    file_count: Math.max(partition.paths.size, partition.declared_files ?? 0),
    source_lines: rounded(partition.file_lines.size > 0
      ? [...partition.file_lines.values()].reduce((sum, value) => sum + value, 0)
      : partition.repository_lines),
  })).sort((left, right) => (
    (right.source_lines ?? -1) - (left.source_lines ?? -1)
      || right.file_count - left.file_count
      || stableCompare(left.language, right.language)
  ));
  const selected = bounded(items, LIMITS.composition);
  return {
    ...availability(selected.items, "no observed human-maintained language composition evidence", emptyState({
      headline: "Source composition is not available",
      missing: "Revision-bound human-maintained source inventory",
      causeKind: "not-observed",
      explanation: "SEI did not receive a usable source-line inventory for this snapshot.",
      availabilityPath: "Provide a revision-bound source inventory and rerun SEI.",
    })),
    ...selected,
  };
}

function projectedMetric(metric) {
  return {
    metric_id: boundedText(metric.metric_id),
    label: boundedText(metric.metric_id.replace(/^static\./, "").replaceAll("_", " ")),
    value: rounded(metric.value),
    unit: boundedText(metric.unit, 80),
    status: metric.measurement.status,
  };
}

function projectComplexity(metrics) {
  const complexity = metrics.filter((metric) => observed(metric) && typeof metric.value === "number"
    && /(?:cyclomatic|cognitive)_complexity|cyclomatic_callable:/.test(metric.metric_id));
  const distributions = complexity
    .filter((metric) => metric.scope?.kind !== "file" && !/(?:_callable:|\.max:)/.test(metric.metric_id))
    .sort((left, right) => stableCompare(left.metric_id, right.metric_id))
    .map(projectedMetric);
  const topItems = complexity
    .filter((metric) => metric.scope?.kind !== "repository"
      && typeof metric.subject === "string"
      && !metric.subject.startsWith("repository:"))
    .sort((left, right) => right.value - left.value || stableCompare(left.subject, right.subject) || stableCompare(left.metric_id, right.metric_id))
    .map((metric) => ({
      subject: boundedText(metric.subject),
      value: rounded(metric.value),
      unit: boundedText(metric.unit, 80),
      metric_id: boundedText(metric.metric_id),
    }));
  const selectedDistributions = bounded(distributions, LIMITS.complexity_distributions);
  const selectedTopItems = bounded(topItems, LIMITS.complexity_top_items);
  return {
    ...availability([...selectedDistributions.items, ...selectedTopItems.items], "no observed complexity distribution evidence", emptyState({
      headline: "Raw complexity metrics are not available",
      missing: "Supported structural complexity observations",
      causeKind: "not-observed",
      explanation: "The evidence explorer has no bounded raw complexity metrics for this snapshot.",
      availabilityPath: "Analyze supported source with a revision-bound complexity collector.",
    })),
    distributions: selectedDistributions.items,
    distribution_omitted_count: selectedDistributions.omitted_count,
    top_items: selectedTopItems.items,
    top_item_omitted_count: selectedTopItems.omitted_count,
  };
}

function projectCapabilityCoverage(snapshot) {
  const coverage = deriveCapabilityCoverage(snapshot);
  const capabilities = coverage.capabilities.map((capability) => ({
    capability_id: boundedText(capability.capability_id, 96),
    title: boundedText(capability.title, 96),
    applicable: capability.applicable === true,
    evidence_state: boundedText(capability.evidence.state, 80),
    usable: capability.evidence.usable === true,
    coverage: rounded(capability.evidence.coverage),
    confidence: rounded(capability.evidence.confidence),
    summary: boundedText(capability.summary),
    limitation: boundedText(capability.limitation),
    next_evidence: boundedText(capability.next_evidence),
    facts: capability.facts.slice(0, 4).map((fact) => ({
      label: boundedText(fact.label, 96),
      value: rounded(fact.value),
      unit: boundedText(fact.unit, 80),
    })),
  })).sort((left, right) => stableCompare(left.capability_id, right.capability_id));
  const selected = bounded(capabilities, LIMITS.capabilities);
  const applicable = selected.items.filter((capability) => capability.applicable);
  const usable = applicable.filter((capability) => capability.usable);
  return {
    state: "available",
    applicable_count: applicable.length,
    usable_count: usable.length,
    capabilities: selected.items,
    omitted_count: selected.omitted_count,
    empty_state: null,
  };
}

function projectComplexityPresentation(snapshot) {
  const presentation = deriveComplexityPresentation(snapshot);
  const partitions = presentation.partitions.map((partition) => ({
    language: boundedText(partition.language, 80),
    partition_id: boundedText(partition.partition_id, 128),
    label: boundedText(partition.label),
    measures: partition.measures.map((measure) => ({
      measure: boundedText(measure.measure, 40),
      label: boundedText(measure.label),
      groups: measure.groups.slice(0, LIMITS.complexity_groups).map((group) => ({
        kind: boundedText(group.kind, 80),
        label: boundedText(group.label),
        state: boundedText(group.state, 80),
        coverage: rounded(group.coverage),
        confidence: rounded(group.confidence),
        summary: boundedText(group.summary),
        values: group.values.slice(0, LIMITS.complexity_group_items).map((value) => ({
          role: boundedText(value.role, 80),
          value: rounded(value.value),
          unit: boundedText(value.unit, 80),
        })),
        items: group.items.slice(0, LIMITS.complexity_group_items).map((item) => ({
          path: boundedText(item.path ?? item.subject ?? "unknown", 240),
          value: rounded(item.value ?? item.points_per_100_lines),
          unit: boundedText(item.unit ?? "complexity-points", 80),
          coverage: rounded(item.coverage),
          confidence: rounded(item.confidence),
        })),
      })),
    })),
  })).sort((left, right) => stableCompare(left.language, right.language)
    || stableCompare(left.partition_id, right.partition_id));
  const selected = bounded(partitions, LIMITS.complexity_partitions);
  const groups = selected.items.flatMap((partition) => partition.measures.flatMap((measure) => measure.groups));
  const observedGroups = groups.filter((group) => ["measured", "inferred", "partial"].includes(group.state));
  return {
    ...availability(observedGroups, "no human-readable complexity evidence was derived", emptyState({
      headline: "Complexity is not available for supported source",
      missing: "Supported complexity analysis",
      causeKind: "not-observed",
      explanation: "SEI has no supported complexity evidence it can explain in plain language for this snapshot.",
      availabilityPath: "Analyze supported source with a revision-bound complexity collector.",
    })),
    partitions: selected.items,
    omitted_count: selected.omitted_count,
  };
}

function availableModel(snapshot, kind) {
  return (snapshot.risk_models ?? []).find((model) => (
    model?.result?.kind === kind && model.result.status === "available" && Array.isArray(model.result.records)
  ))?.result ?? null;
}

function featureByRole(features, role) {
  const pattern = role === "structural"
    ? /(?:cyclomatic|cognitive|lexical|max_nesting|source_lines|dependency|duplication)/
    : /(?:churn|change_frequency|change_count|authors?|commits?)/;
  return (features ?? []).filter((feature) => pattern.test(feature.metric_id ?? ""))
    .sort((left, right) => (right.percentile ?? -1) - (left.percentile ?? -1)
      || stableCompare(left.metric_id, right.metric_id))[0] ?? null;
}

function featureEvidence(snapshot, feature) {
  const metric = (snapshot.measurements ?? []).find((candidate) => candidate.metric_id === feature.metric_id);
  const coverage = rounded(metric?.measurement?.completeness);
  const confidence = rounded(metric?.measurement?.confidence);
  const partial = coverage !== null && confidence !== null && (coverage < 1 || confidence < 1);
  return {
    state: partial ? (coverage >= 0.9 && confidence >= 0.9 ? "strong-partial" : "partial") : "complete",
    coverage,
    confidence,
  };
}

function projectScatter(snapshot) {
  const model = availableModel(snapshot, "heuristic_hotspot_vectors");
  const points = (model?.records ?? []).map((record) => {
    const structural = featureByRole(record.features, "structural");
    const behavioral = featureByRole(record.features, "behavioral");
    if (structural === null || behavioral === null) return null;
    const structuralEvidence = featureEvidence(snapshot, structural);
    const behavioralEvidence = featureEvidence(snapshot, behavioral);
    return {
      subject: boundedText(record.subject),
      structural: rounded(structural.percentile),
      behavioral: rounded(behavioral.percentile),
      structural_metric_id: boundedText(structural.metric_id),
      behavioral_metric_id: boundedText(behavioral.metric_id),
      structural_evidence: structuralEvidence,
      behavioral_evidence: behavioralEvidence,
      evidence_state: structuralEvidence.state === "complete" && behavioralEvidence.state === "complete"
        ? "complete"
        : structuralEvidence.state === "partial" || behavioralEvidence.state === "partial" ? "partial" : "strong-partial",
      signal_count: Array.isArray(record.hotspot_signals) ? record.hotspot_signals.length : 0,
    };
  }).filter(Boolean).sort((left, right) => (
    right.signal_count - left.signal_count
      || (right.structural * right.behavioral) - (left.structural * left.behavioral)
      || stableCompare(left.subject, right.subject)
  ));
  const selected = bounded(points, LIMITS.scatter);
  return {
    ...availability(selected.items, "no subjects have both structural and behavioral percentile evidence", emptyState({
      headline: "No structural and behavioral map is available",
      missing: "A subject with both revision-bound structural and behavioral evidence",
      causeKind: "missing-intersection",
      explanation: "SEI does not substitute temporal coupling for a structural-and-behavioral intersection.",
      availabilityPath: "Collect compatible file-level structural and change evidence for the same revision.",
    })),
    axes: { x: "structural percentile", y: "behavioral percentile" },
    points: selected.items,
    omitted_count: selected.omitted_count,
  };
}

function projectCoupling(snapshot) {
  const model = availableModel(snapshot, "temporal_coupling_pressure");
  const relationships = (model?.records ?? []).map((record) => ({
    source: boundedText(record.source),
    target: boundedText(record.target),
    co_change_count: rounded(record.co_change_count),
    coupling_ratio: rounded(record.coupling_ratio),
    policy_status: boundedText(record.policy_status ?? "declared", 80),
  })).sort((left, right) => (
    (right.co_change_count ?? -1) - (left.co_change_count ?? -1)
      || (right.coupling_ratio ?? -1) - (left.coupling_ratio ?? -1)
      || stableCompare(left.source, right.source)
      || stableCompare(left.target, right.target)
  ));
  const selected = bounded(relationships, LIMITS.coupling);
  return {
    ...availability(selected.items, "no source-bound temporal coupling relationships", emptyState({
      headline: "No temporal coupling relationships are available",
      missing: "Source-bound co-change history",
      causeKind: "not-observed",
      explanation: "Temporal coupling is shown separately from structural-and-behavioral investigation leads.",
      availabilityPath: "Collect attributable file-level change history for this revision range.",
    })),
    relationships: selected.items,
    omitted_count: selected.omitted_count,
  };
}

function projectInvestigations(snapshot) {
  const items = [];
  const investigation = availableModel(snapshot, "engineering_investigation_signals");
  for (const record of investigation?.records ?? []) {
    items.push({
      kind: "multi-signal",
      subject: boundedText(record.subject),
      signal: boundedText(record.signal_type),
      confidence: boundedText(record.confidence ?? "unassigned", 40),
      observed: rounded(record.coverage?.observed),
      required: rounded(record.coverage?.required),
      evidence_state: Array.isArray(record.observations) && record.observations.some((observation) => observation.status === "degraded")
        ? "strong-partial" : "complete",
      coverage: Array.isArray(record.observations)
        ? rounded(Math.min(...record.observations
          .map((observation) => observation.coverage)
          .filter((value) => typeof value === "number" && Number.isFinite(value)))) : null,
      detail: boundedText(record.suggested_investigation ?? record.interpretation),
    });
  }
  const hotspots = availableModel(snapshot, "heuristic_hotspot_vectors");
  for (const record of hotspots?.records ?? []) {
    if (!Array.isArray(record.hotspot_signals) || record.hotspot_signals.length === 0) continue;
    items.push({
      kind: "structural-behavioral",
      subject: boundedText(record.subject),
      signal: boundedText(record.hotspot_signals.map((signal) => signal.signal_id).sort(stableCompare).join(", ")),
      confidence: "heuristic",
      observed: record.features?.length ?? 0,
      required: 2,
      evidence_state: "heuristic",
      coverage: null,
      detail: "inspect the bound structural and behavioral evidence",
    });
  }
  const kindRank = new Map([["multi-signal", 0], ["structural-behavioral", 1]]);
  items.sort((left, right) => (kindRank.get(left.kind) - kindRank.get(right.kind))
    || (right.observed ?? -1) - (left.observed ?? -1)
    || stableCompare(left.subject, right.subject));
  const selected = bounded(items, LIMITS.investigations);
  return {
    ...availability(selected.items, "no bounded multi-signal or structural-and-behavioral investigation leads were derived", emptyState({
      headline: "No investigation leads are available yet",
      missing: "A multi-signal or structural-and-behavioral intersection",
      causeKind: "missing-intersection",
      explanation: "Temporal coupling remains available as separate historical relationship evidence; it is not promoted into this list by itself.",
      availabilityPath: "Collect compatible file-level structural and behavioral evidence, then rerun SEI.",
    })),
    items: selected.items,
    omitted_count: selected.omitted_count,
    authority_boundary: "investigation evidence only; not a defect, priority, architecture, or repository-health verdict",
  };
}

function metricView(metrics, predicate, maximum, reason, comparator = (left, right) => stableCompare(left.metric_id, right.metric_id), empty = null) {
  const items = metrics.filter((metric) => observed(metric) && typeof metric.value === "number" && predicate(metric))
    .sort(comparator)
    .map(projectedMetric);
  const selected = bounded(items, maximum);
  return { ...availability(selected.items, reason, empty), ...selected };
}

function capabilityById(capabilityCoverage, capabilityId) {
  return capabilityCoverage.capabilities.find((capability) => capability.capability_id === capabilityId) ?? null;
}

function projectDuplication(metrics, capabilityCoverage) {
  const capability = capabilityById(capabilityCoverage, "duplication");
  const view = metricView(
    metrics,
    (metric) => /\.duplication\./.test(metric.metric_id),
    LIMITS.duplication,
    "no structural duplication evidence",
    (left, right) => stableCompare(left.metric_id, right.metric_id),
    emptyState({
      headline: "Duplication evidence is not available",
      missing: "A completed or partial structural duplication analysis",
      causeKind: "not-observed",
      explanation: "SEI has no bounded duplication observations for this snapshot.",
      availabilityPath: "Analyze repository source with the structural duplication collector.",
    }),
  );
  const cloneFamilies = view.items.find((item) => item.metric_id === "static.duplication.clone_family_count");
  const semanticState = capability?.evidence_state ?? "unresolved";
  if (semanticState === "resource-limited") {
    view.empty_state = emptyState({
      headline: "Duplication analysis reached its resource boundary",
      missing: "A complete repository-wide clone result",
      causeKind: "resource-limited",
      explanation: "Any retained clone observations are lower bounds; absence of a row is not evidence of no duplication.",
      availabilityPath: capability.next_evidence,
    });
  } else if (capability?.usable && cloneFamilies?.value === 0) {
    view.empty_state = emptyState({
      headline: "No clone families were observed in the completed analysis",
      missing: "No additional duplication evidence",
      causeKind: "complete-zero",
      explanation: "The completed bounded analysis observed zero clone families in its eligible source scope.",
      availabilityPath: "Rerun SEI after source changes.",
    });
  }
  return {
    ...view,
    evidence_state: semanticState,
    lower_bound: semanticState === "resource-limited" || semanticState === "partial" || semanticState === "strong-partial",
  };
}

function canonicalPredictiveCurrentSnapshot(snapshot) {
  return {
    repository_id: snapshot.repository.repository_id,
    revision: snapshot.repository.revision,
    configuration_hash: snapshot.repository.configuration_hash,
    snapshot_id: snapshot.snapshot_id,
  };
}

function projectPredictiveStatus(snapshot, predictiveBinding) {
  try {
    const receipt = predictiveBinding === null || predictiveBinding === undefined
      ? null
      : forwardTemporalPrivate.projectBoundForwardTemporalReceiptSummary(predictiveBinding);
    return derivePredictiveStatus({
      current_snapshot: canonicalPredictiveCurrentSnapshot(snapshot),
      receipt,
    });
  } catch (error) {
    if (predictiveBinding !== undefined) {
      throw new Error(`FAIL-REPORT-PROJECTION-PREDICTIVE: ${error.message}`);
    }
    // This only preserves the package-private canonical projection seam's
    // historical behavior for its intentionally noncanonical unit fixture.
    return null;
  }
}

function projectPredictiveIntelligence(snapshot, predictiveBinding, predictiveStatus) {
  if (predictiveBinding === null || predictiveBinding === undefined) {
    return defaultPredictiveIntelligence();
  }

  // The binding is intentionally opaque. Only the evaluator's branded private
  // projector may turn it into report evidence; caller-provided receipt-shaped
  // objects never reach the normalizer below.
  let bound = null;
  const isReadiness = forwardTemporalPrivate.isAutomaticReadinessBinding(predictiveBinding);
  const currentV9State = V9_PREDICTIVE_STATES.has(predictiveStatus?.state)
    && !["STALE", "INCOMPATIBLE"].includes(predictiveStatus.state);
  if (isReadiness || predictiveStatus?.state === "evaluated-current" || currentV9State) {
    bound = forwardTemporalPrivate.projectBoundForwardTemporalEvaluation(predictiveBinding, snapshot);
  }
  if (bound === null) {
    if (predictiveBinding !== null && predictiveBinding !== undefined
        && predictiveStatus?.state !== undefined
        && !V9_PREDICTIVE_STATES.has(predictiveStatus.state)
        && predictiveStatus.state !== "not-yet-evaluated") {
      // @2 remains readable, but a one-fold/previous-only legacy receipt is
      // not coerced into a V9 state or a current forecast.
      return {
        state: "not-established",
        reason: predictiveStatus.summary ?? "legacy predictive evidence did not establish a current evaluation",
      };
    }
    const state = V9_PREDICTIVE_STATES.has(predictiveStatus?.state)
      ? predictiveStatus.state
      : predictiveStatus?.state === "previously-evaluated-compatible-not-current"
        ? "STALE"
        : "INCOMPATIBLE";
    return projectV9PredictiveState({
      state,
      reason: predictiveStatus?.summary ?? "A predictive receipt is not current for this canonical snapshot.",
      source: null,
      predictiveStatus,
    });
  }
  // The evaluator's readiness binding intentionally exposes the historical
  // `not-established` internal state. Public V9 projection must translate the
  // branded readiness state, while leaving legacy @2 receipts untouched.
  if (isReadiness && bound.state === "not-established") {
    return projectV9PredictiveState({
      state: "NOT_READY",
      reason: bound.reason,
      source: null,
      predictiveStatus,
    });
  }
  // Existing @2 receipts remain readable and render through their historical
  // bounded shape. They are not silently reclassified as a V9 forecast.
  if (!V9_PREDICTIVE_STATES.has(bound.state)) return bound;
  const state = V9_PREDICTIVE_STATES.has(bound.state)
    ? bound.state
    : bound.forecast_state === "readiness" ? "NOT_READY" : "INCOMPATIBLE";
  return projectV9PredictiveState({
    state,
    reason: bound.reason,
    source: bound,
    predictiveStatus,
  });
}

function projectTrendStatus(snapshot, metrics) {
  try {
    const historicalContext = isRecord(snapshot.run_metadata?.trend_baseline?.historical_context)
      ? structuredClone(snapshot.run_metadata.trend_baseline.historical_context)
      : null;
    const baseline = isRecord(snapshot.run_metadata?.trend_baseline)
      ? {
          binding_kind: snapshot.run_metadata.trend_baseline.binding_kind,
          status: snapshot.run_metadata.trend_baseline.status,
          eligible: snapshot.run_metadata.trend_baseline.eligible,
          baseline_snapshot_id: snapshot.run_metadata.trend_baseline.baseline_snapshot_id,
          baseline_repository_revision: snapshot.run_metadata.trend_baseline.baseline_repository_revision,
          compatible_metric_count: snapshot.run_metadata.trend_baseline.compatible_metric_count,
        }
      : null;
    const historyMetric = metrics.find((metric) => (
      metric.metric_id === "git.change_frequency"
        && metric.definition_id === "sei.git.change_frequency@1"
        && metric.measurement !== null
        && typeof metric.measurement === "object"
    ));
    const history = historyMetric === undefined ? null : {
      metric_id: historyMetric.metric_id,
      definition_id: historyMetric.definition_id,
      state: historyMetric.measurement.status,
      value: historyMetric.value,
      coverage: historyMetric.measurement.completeness,
      confidence: historyMetric.measurement.confidence,
      // A revision-range snapshot cannot prove that its configured window is
      // the repository's full history, so never infer that stronger scope.
      scope: "configured-window",
    };
    const comparisons = metrics.filter((metric) => isRecord(metric.comparison)).map((metric) => ({
      metric_id: metric.metric_id,
      baseline_snapshot_id: metric.comparison.baseline_snapshot_id,
      baseline_repository_revision: metric.comparison.baseline_repository_revision,
      binding_kind: metric.comparison.binding_kind,
    }));
    const derived = deriveTrendStatus({
      current_snapshot: {
        snapshot_id: snapshot.snapshot_id,
        repository_revision: snapshot.repository.revision,
      },
      baseline,
      history,
      comparisons,
    });
    if (historicalContext === null) return derived;
    const contextLabel = `${historicalContext.short_revision} ${historicalContext.subject}`.trim();
    const changeFacts = `${historicalContext.changed_file_count} file${historicalContext.changed_file_count === 1 ? "" : "s"}, ${historicalContext.text_churn} lines of text churn`;
    return {
      ...derived,
      historical_context: historicalContext,
      summary: derived.state === "first-compatible-sei-observation" || derived.state === "first-compatible-sei-observation-with-observed-history"
        ? `${derived.summary} Significant prior Git change found: ${contextLabel} (${changeFacts}).`
        : derived.summary,
      next_observation: derived.state === "first-compatible-sei-observation" || derived.state === "first-compatible-sei-observation-with-observed-history"
        ? "Use this Git-history context as orientation; run SEI again after the next compatible observation for factual metric deltas."
        : derived.next_observation,
    };
  } catch {
    // A package-private noncanonical fixture may intentionally omit canonical
    // trend binding fields. Public projection already validates snapshots.
    return null;
  }
}

function projectTrend(metrics, trendStatus) {
  const items = metrics.filter((metric) => observed(metric) && metric.scope?.kind === "repository"
    && metric.comparison !== null && typeof metric.comparison === "object"
    && typeof metric.comparison.delta === "number")
    .sort((left, right) => {
      const rank = (metric) => /^static\.(?:dependency|duplication|java|kotlin|tsjs)\./.test(metric.metric_id) ? 1 : 0;
      return rank(left) - rank(right) || stableCompare(left.metric_id, right.metric_id);
    })
    .map((metric) => ({
      metric_id: boundedText(metric.metric_id),
      value: rounded(metric.value),
      baseline_value: rounded(metric.comparison.baseline_value),
      delta: rounded(metric.comparison.delta),
      unit: boundedText(metric.unit, 80),
      confidence: rounded(metric.comparison.confidence),
      baseline_revision: boundedText(metric.comparison.baseline_repository_revision, 80),
      direction: "unassigned",
    }));
  const selected = bounded(items, LIMITS.trend);
  const empty = trendStatus === null ? emptyState({
    headline: "No comparable trend is available yet",
    missing: "A compatible prior repository-level baseline",
    causeKind: "unresolved",
    explanation: "SEI could not derive a structured trend status for this projection.",
    availabilityPath: "Use a canonical snapshot with validated trend-baseline metadata.",
  }) : emptyState({
    headline: trendStatus.state === "first-compatible-sei-observation-with-observed-history"
      ? "This is the first compatible SEI observation"
      : "No comparable trend is available yet",
    missing: "A compatible prior repository-level baseline",
    causeKind: trendStatus.state,
    explanation: trendStatus.summary,
    availabilityPath: trendStatus.next_observation,
  });
  return {
    ...availability(selected.items, "no comparable repository-level trend bindings", empty),
    evidence_state: trendStatus?.state ?? "unresolved",
    historical_context: trendStatus?.historical_context ?? null,
    items: selected.items,
    omitted_count: selected.omitted_count,
  };
}

const TREND_METRIC_LABELS = Object.freeze({
  "static.source_lines": "Human-maintained source lines",
  "static.source_file_count": "Human-maintained source files",
  "static.human_source_file_count": "Human-maintained source files",
  "git.change_frequency": "Observed revisions in the configured history window",
  "git.observed_text_churn": "Observed text churn",
  "git.ownership_concentration": "Observed ownership concentration",
});

function humanTrendMetricLabel(metricId) {
  if (Object.hasOwn(TREND_METRIC_LABELS, metricId)) return TREND_METRIC_LABELS[metricId];
  const words = String(metricId)
    .replace(/^[^.]+\./, "")
    .replace(/[.:]/g, " ")
    .replaceAll("_", " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
  return boundedText(words.length === 0 ? "Observed repository measure" : words, 120);
}

function projectPrimaryTrend(trend) {
  const rank = (metricId) => ({
    "static.source_lines": 0,
    "static.human_source_file_count": 1,
    "static.source_file_count": 1,
    "git.observed_text_churn": 2,
    "git.change_frequency": 3,
  }[metricId] ?? 4);
  const items = trend.items.map((item) => ({
    label: humanTrendMetricLabel(item.metric_id),
    metric_id: item.metric_id,
    earlier_value: item.baseline_value,
    current_value: item.value,
    change: item.delta,
    unit: item.unit,
    confidence: item.confidence,
    baseline_revision: item.baseline_revision,
    interpretation: "Factual change only; no directional quality conclusion.",
  })).sort((left, right) => rank(left.metric_id) - rank(right.metric_id)
    || stableCompare(left.metric_id, right.metric_id)).map(({ metric_id, ...item }) => item);
  return {
    ...availability(items, "no comparable repository-level trend bindings", trend.empty_state),
    evidence_state: trend.evidence_state,
    historical_context: trend.historical_context ?? null,
    items,
    omitted_count: trend.omitted_count,
  };
}

function predictiveReason(state, reason) {
  if (typeof reason === "string" && reason.length > 0) return boundedText(reason);
  return {
    NOT_READY: "No compatible terminal-holdout evidence is ready for this canonical snapshot.",
    READY_NOT_EVALUATED: "Development evidence is available, but no terminally validated selection is bound.",
    VALIDATED_BASELINE: "A simple baseline produced the validated rank-only result.",
    VALIDATED_MODEL: "The nominated composite produced the validated rank-only result.",
    NO_USEFUL_SIGNAL: "Terminal evaluation established no useful rank-only signal; no current forecast is authorized.",
    STALE: "Predictive evidence is compatible history, but it does not bind this current snapshot.",
    INCOMPATIBLE: "Predictive evidence does not match this repository identity or configuration.",
  }[state] ?? "No validated predictive evidence is bound to this canonical snapshot.";
}

function projectPredictiveRanking(ranking) {
  return {
    outcome_id: boundedText(ranking?.outcome_id ?? ranking?.target_id, 96),
    horizon_commits: V9_HORIZONS.includes(ranking?.horizon_commits) ? ranking.horizon_commits : null,
    state: boundedText(ranking?.state, 40),
    method_id: boundedText(ranking?.method_id, 96),
    method_kind: boundedText(ranking?.method_kind, 48),
    claim: ranking?.claim === "rank-only" ? "rank-only" : null,
    items: Array.isArray(ranking?.items) ? ranking.items.slice(0, 10).map((item) => ({
      rank: Number.isSafeInteger(item?.rank) && item.rank > 0 ? item.rank : null,
      subject: boundedText(item?.subject, 240),
      path: boundedText(item?.path, 240),
      percentile: rounded(item?.percentile),
    })) : [],
  };
}

function projectPredictiveMethod(method) {
  if (!isRecord(method)) return null;
  return {
    method_id: boundedText(method.method_id, 96),
    method_kind: boundedText(method.method_kind, 48),
    lift_at_k: rounded(method.lift_at_k),
    average_precision: rounded(method.average_precision),
    qualifies: method.qualifies === true,
  };
}

function projectPredictivePromotion(promotion) {
  const terminal = isRecord(promotion?.terminal_holdout) ? promotion.terminal_holdout : {};
  const targetId = promotion?.target_id ?? promotion?.outcome_id ?? "unknown-target";
  const horizon = promotion?.horizon_commits ?? "unknown";
  const state = promotion?.state ?? "NOT_READY";
  return {
    target_id: boundedText(targetId, 96),
    horizon_commits: V9_HORIZONS.includes(promotion?.horizon_commits) ? promotion.horizon_commits : null,
    state: boundedText(state, 40),
    terminal_state: boundedText(terminal.state ?? promotion?.terminal_state, 40),
    summary: boundedText(promotion?.summary ?? `${horizon}-commit ${targetId} result is ${state}.`),
    nomination: isRecord(promotion?.nomination) ? {
      method_id: boundedText(promotion.nomination.method_id, 96),
      method_kind: boundedText(promotion.nomination.method_kind, 48),
      metric: boundedText(promotion.nomination.metric, 80),
      mean_average_precision: rounded(promotion.nomination.mean_average_precision),
    } : null,
    candidate: projectPredictiveMethod(terminal.nominated_method),
    fallback: projectPredictiveMethod(terminal.fallback_method),
    selected_method: isRecord(promotion?.selected_method) ? {
      method_id: boundedText(promotion.selected_method.method_id, 96),
      method_kind: boundedText(promotion.selected_method.method_kind, 48),
    } : null,
    forecast_item_count: Number.isSafeInteger(promotion?.forecast_item_count)
      ? Math.max(0, Math.min(10, promotion.forecast_item_count))
      : 0,
  };
}

function projectPredictiveHorizon(promotions, rankings) {
  const horizon = promotions[0]?.horizon_commits ?? rankings[0]?.horizon_commits ?? null;
  const horizonRankings = rankings.filter((ranking) => ranking.horizon_commits === horizon);
  const states = promotions.map((promotion) => promotion.state);
  const state = states.includes("VALIDATED_MODEL") ? "VALIDATED_MODEL"
    : states.includes("VALIDATED_BASELINE") ? "VALIDATED_BASELINE"
      : states.includes("NO_USEFUL_SIGNAL") ? "NO_USEFUL_SIGNAL"
        : states.includes("READY_NOT_EVALUATED") ? "READY_NOT_EVALUATED"
          : states.includes("STALE") ? "STALE"
            : states.includes("INCOMPATIBLE") ? "INCOMPATIBLE" : "NOT_READY";
  return {
    horizon_commits: horizon,
    state,
    target_count: promotions.length,
    promotions,
    current_rankings: horizonRankings,
    forecast_available: horizonRankings.some((ranking) => (ranking.items ?? []).length > 0)
      && ["VALIDATED_MODEL", "VALIDATED_BASELINE"].includes(state),
  };
}

function projectV9PredictiveState({ state, reason, source, predictiveStatus }) {
  const sourceOutcomes = Array.isArray(source?.outcomes)
    ? source.outcomes.map(projectPredictivePromotion)
    : Array.isArray(predictiveStatus?.outcomes)
      ? predictiveStatus.outcomes.map((outcome) => ({
        target_id: boundedText(outcome.target_id ?? outcome.outcome_id, 96),
        horizon_commits: V9_HORIZONS.includes(outcome.horizon_commits) ? outcome.horizon_commits : null,
        state: boundedText(outcome.state, 40),
        terminal_state: boundedText(outcome.terminal_state, 40),
        summary: boundedText(outcome.summary ?? outcome.baseline_vs_composite?.summary ?? predictiveStatus.summary),
        nomination: null,
        candidate: null,
        fallback: null,
        selected_method: isRecord(outcome.selected_method) ? {
          method_id: boundedText(outcome.selected_method.method_id, 96),
          method_kind: boundedText(outcome.selected_method.method_kind, 48),
        } : null,
        forecast_item_count: Number.isSafeInteger(outcome.forecast_item_count)
          ? Math.max(0, Math.min(10, outcome.forecast_item_count)) : 0,
      }))
      : [];
  const allRankings = Array.isArray(source?.current_rankings)
    ? source.current_rankings.map(projectPredictiveRanking)
    : [];
  const rankingCounts = new Map();
  allRankings.forEach((ranking) => {
    const key = `${ranking.outcome_id}\0${ranking.horizon_commits}`;
    const count = (ranking.items ?? []).filter((item) => Number.isSafeInteger(item.rank) && item.rank > 0).length;
    rankingCounts.set(key, Math.max(rankingCounts.get(key) ?? 0, Math.min(10, count)));
  });
  sourceOutcomes.forEach((promotion) => {
    const key = `${promotion.target_id}\0${promotion.horizon_commits}`;
    const count = rankingCounts.get(key) ?? 0;
    promotion.forecast_item_count = ["VALIDATED_MODEL", "VALIDATED_BASELINE"].includes(promotion.state)
      ? count : 0;
  });
  const availableHorizons = [...new Set(sourceOutcomes.map((outcome) => outcome.horizon_commits)
    .filter((horizon) => V9_HORIZONS.includes(horizon)))].sort((left, right) => left - right);
  const promotionsByHorizon = new Map();
  sourceOutcomes.forEach((promotion) => {
    if (!V9_HORIZONS.includes(promotion.horizon_commits)) return;
    const existing = promotionsByHorizon.get(promotion.horizon_commits) ?? [];
    existing.push(promotion);
    promotionsByHorizon.set(promotion.horizon_commits, existing);
  });
  const horizons = [...promotionsByHorizon.entries()].map(([horizon, promotions]) => projectPredictiveHorizon(
    promotions,
    allRankings.filter((ranking) => ranking.horizon_commits === horizon),
  ));
  const defaultHorizon = horizons.find((horizon) => horizon.horizon_commits === 25) ?? null;
  const defaultRankings = defaultHorizon?.current_rankings ?? [];
  const selectedMethods = Array.isArray(source?.selected_methods) ? source.selected_methods.slice(0, 16).map((method) => ({
    target_id: boundedText(method?.target_id, 96),
    horizon_commits: V9_HORIZONS.includes(method?.horizon_commits) ? method.horizon_commits : null,
    state: boundedText(method?.state, 40),
    method_id: boundedText(method?.method_id, 96),
    method_kind: boundedText(method?.method_kind, 48),
  })) : [];
  const validationPromotions = (defaultHorizon?.promotions ?? sourceOutcomes).slice(0, 3);
  const candidateMethods = validationPromotions.map((promotion) => promotion.candidate).filter(Boolean);
  const fallbackMethods = validationPromotions.map((promotion) => promotion.fallback).filter(Boolean);
  const terminalStates = validationPromotions.map((promotion) => promotion.terminal_state);
  const aggregateTerminalState = terminalStates.length === 0 || terminalStates.every((terminalState) => terminalState === "NOT_READ")
    ? "NOT_READ"
    : terminalStates.some((terminalState) => terminalState === "INSUFFICIENT_CLASSES")
      ? "INSUFFICIENT_CLASSES"
      : terminalStates.every((terminalState) => terminalState === "EVALUATED") ? "EVALUATED" : "NOT_READ";
  const forecastState = ["VALIDATED_MODEL", "VALIDATED_BASELINE"].includes(state) && defaultRankings.length > 0
    ? "validated"
    : ["STALE", "INCOMPATIBLE"].includes(state) ? state.toLowerCase() : state === "NO_USEFUL_SIGNAL" ? "no-current-forecast" : "readiness";
  return {
    state,
    reason: predictiveReason(state, reason),
    default_horizon_commits: 25,
    available_horizons: availableHorizons,
    horizons,
    forecast_state: forecastState,
    selected_methods: selectedMethods,
    current_rankings: defaultRankings,
    horizon_rankings: allRankings.slice(0, 16),
    outcomes: sourceOutcomes.slice(0, 16),
    validation: {
      candidate_methods: candidateMethods,
      fallback_methods: fallbackMethods,
      terminal_state: aggregateTerminalState,
      // V9 binds three development folds plus one terminal holdout. The
      // evaluator's legacy forward_fold_count is a receipt-internal count
      // and must not leak as the public V9 development count.
      development_fold_count: V9_PREDICTIVE_STATES.has(source?.state) ? 3 : 0,
      terminal_holdout_fold_count: V9_PREDICTIVE_STATES.has(source?.state) ? 1 : 0,
      coverage: {
        available_horizon_count: availableHorizons.length,
        evaluated_horizon_count: horizons.filter((horizon) => horizon.state !== "NOT_READY").length,
        default_horizon_evaluated: defaultHorizon !== null && defaultHorizon.state !== "NOT_READY",
      },
    },
    descriptive_concentration: {
      state: "descriptive-only",
      summary: "Observed concentration is descriptive evidence only.",
    },
    interpretation_boundary: boundedText(source?.interpretation_boundary ?? "Rank-only ordering of mechanically observed repository-change targets."),
    limitations: [
      "Rank and percentile values are not probabilities.",
      "Results describe mechanically observed repository changes only.",
    ],
    receipt_sha256: typeof source?.receipt_sha256 === "string" ? boundedText(source.receipt_sha256, 80) : null,
    bundle_sha256: typeof source?.bundle_sha256 === "string" ? boundedText(source.bundle_sha256, 80) : null,
    ranking_k: Number.isSafeInteger(source?.ranking_k) ? source.ranking_k : null,
    forward_fold_count: Number.isSafeInteger(source?.forward_fold_count) ? source.forward_fold_count : 0,
    legacy_state: source !== null && !V9_PREDICTIVE_STATES.has(source?.state) ? boundedText(source?.state, 40) : null,
  };
}

function defaultPredictiveIntelligence() {
  return projectV9PredictiveState({
    state: "NOT_READY",
    reason: "no validated forward-temporal evaluation is bound to this canonical snapshot",
    source: null,
    predictiveStatus: null,
  });
}

function projectRepositoryOverview(snapshot, composition, capabilityCoverage, investigations) {
  const sourceInventory = capabilityById(capabilityCoverage, "source-inventory");
  const summaryParts = [];
  if (sourceInventory?.facts[0]) {
    summaryParts.push(`${sourceInventory.facts[0].value} ${sourceInventory.facts[0].unit} of human-maintained source were inventoried`);
  } else {
    summaryParts.push("Human-maintained source inventory is not yet resolved");
  }
  summaryParts.push(`${capabilityCoverage.usable_count} of ${capabilityCoverage.applicable_count} applicable capability areas have usable evidence`);
  if (investigations.items.length > 0) {
    summaryParts.push(`${investigations.items.length} bounded investigation lead${investigations.items.length === 1 ? " is" : "s are"} available`);
  } else {
    summaryParts.push("no multi-signal investigation lead is available yet");
  }
  return {
    headline: "Repository overview",
    summary: boundedText(`${summaryParts.join("; ")}.`),
    repository_id: boundedText(snapshot.repository.repository_id),
    revision: boundedText(snapshot.repository.revision, 80),
    generated_at: boundedText(snapshot.run_metadata.generated_at, 80),
    composition_state: composition.state,
    capability_state: capabilityCoverage.state,
    investigation_state: investigations.state,
  };
}

function projectEvidenceExplorer(snapshot, metrics, rawComplexity, composition, coupling, duplication, topology, trend) {
  const counts = snapshot.evidence_summary.status_counts;
  const statuses = EVIDENCE_STATES.map((status) => ({ status, count: Number(counts[status] ?? 0) }));
  const observedCount = Number(counts.measured ?? 0) + Number(counts.inferred ?? 0);
  const measurementCount = Number(snapshot.evidence_summary.measurement_count ?? metrics.length);
  const summary = {
    measurement_count: measurementCount,
    observed_count: observedCount,
    coverage_ratio: measurementCount === 0 ? null : rounded(observedCount / measurementCount),
    statuses,
    collectors: ["available", "degraded", "unavailable"].map((status) => ({
      status,
      count: snapshot.collectors.filter((collector) => collector.status === status).length,
    })),
  };
  return {
    state: "available",
    measurement_summary: summary,
    raw_views: {
      composition,
      complexity: rawComplexity,
      topology,
      coupling,
      duplication,
      trend,
    },
  };
}

function projectAssessment(snapshot, binding) {
  if (binding === null || binding === undefined) {
    return {
      state: "not-assessed",
      reason: "assessment was omitted; run SEI without evidence-only mode to derive an engineering assessment",
      assessment_id: null,
      score: null,
      score_band: "NOT SCORED",
      score_visibility: "hidden",
      coverage: 0,
      confidence: "NOT_ESTABLISHED",
      maturity: "not_scored",
      dimensions: [],
      criteria: [],
      strengths: [],
      deficiencies: [],
      interventions: [],
      framework_lenses: [],
      trajectory: { state: "first-observation", reason: "assessment was omitted", score_delta: null, coverage_delta: null },
      evidence_limits: [],
      observation_vocabulary_version: null,
      observation_vocabulary_digest: null,
      semantic_digest: null,
      coverage_accounting: null,
      domain_summary: [],
    };
  }
  const assessment = engineeringAssessmentPrivate.readBoundAssessment(binding);
  if (assessment.snapshot_binding.snapshot_id !== snapshot.snapshot_id
      || assessment.snapshot_binding.repository_id !== snapshot.repository.repository_id
      || assessment.snapshot_binding.repository_revision !== snapshot.repository.revision
      || assessment.snapshot_binding.configuration_hash !== snapshot.repository.configuration_hash) {
    throw new Error("FAIL-REPORT-ASSESSMENT-BINDING: assessment does not bind the canonical snapshot");
  }
  return projectAssessmentArtifact(assessment);
}

function boundedArray(value, maximum, mapper) {
  return Array.isArray(value) ? value.slice(0, maximum).map(mapper).filter((item) => item !== null) : [];
}

function projectAssessmentObservation(observation) {
  if (!isRecord(observation) || typeof observation.observation_id !== "string") return null;
  const rawContext = isRecord(observation.context) ? observation.context : {};
  return {
    observation_id: boundedText(observation.observation_id, 120),
    role: boundedText(observation.role, 40),
    state: boundedText(observation.state, 40),
    value: projectObservationValue(observation.value),
    unit: boundedText(observation.unit, 80),
    coverage: rounded(observation.coverage),
    confidence: boundedText(observation.confidence, 40),
    context: {
      family: boundedText(rawContext.family, 80),
      aggregation: boundedText(rawContext.aggregation, 40),
      languages: boundedArray(rawContext.languages, 8, (language) => boundedText(language, 32)),
      lower_bound: rawContext.lower_bound === true,
    },
    evidence_ref_count: Array.isArray(observation.evidence_refs) ? observation.evidence_refs.length : 0,
  };
}

function assessmentLabel(value) {
  return String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function projectAssessmentDomainSummary(assessment) {
  return boundedArray(assessment?.dimensions, 9, (dimension) => {
    if (!isRecord(dimension) || typeof dimension.dimension_id !== "string") return null;
    const coverage = rounded(dimension.coverage);
    const score = dimension.maturity === "not_scored" ? null : rounded(dimension.score);
    const resourceLimited = (assessment.criteria ?? [])
      .filter((criterion) => criterion?.dimension_id === dimension.dimension_id)
      .flatMap((criterion) => criterion?.evidence?.observations ?? [])
      .some((observation) => observation?.state === "partial"
        || observation?.state === "resource-limited"
        || isRecord(observation?.context) && observation.context.lower_bound === true);
    const evidenceState = score === null
      ? coverage === null || coverage <= 0 ? "unavailable" : "not-scored"
      : coverage === null ? "partial"
        : resourceLimited ? "resource-limited"
          : score === 0 && coverage >= 1 ? "complete-zero"
            : coverage >= 1 ? "complete" : coverage <= 0 ? "unavailable" : "partial";
    return {
      dimension_id: boundedText(dimension.dimension_id, 96),
      label: boundedText(assessmentLabel(dimension.dimension_id), 120),
      score,
      coverage,
      confidence: boundedText(dimension.confidence, 40),
      maturity: boundedText(dimension.maturity, 40),
      evidence_state: evidenceState,
      observed_criterion_count: Number.isSafeInteger(dimension.observed_criterion_count) ? dimension.observed_criterion_count : 0,
      criterion_count: Number.isSafeInteger(dimension.criterion_count) ? dimension.criterion_count : 0,
    };
  });
}

function projectObservationValue(value) {
  if (typeof value === "number") return rounded(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value, 160);
  return null;
}

function projectCriterionExplanation(explanation) {
  const source = isRecord(explanation) ? explanation : {};
  return {
    observed: boundedText(source.observed),
    means: boundedText(source.means),
    why_it_matters: boundedText(source.why_it_matters),
    limitations: boundedText(source.limitations),
    blocked_stronger_result: boundedText(source.blocked_stronger_result),
    next_investigation: boundedText(source.next_investigation),
  };
}

function projectCriterionEvidence(evidence) {
  const source = isRecord(evidence) ? evidence : {};
  const synthesis = isRecord(source.synthesis) ? source.synthesis : {};
  return {
    observations: boundedArray(source.observations, 12, projectAssessmentObservation),
    synthesis: {
      recipe_id: boundedText(synthesis.recipe_id, 120),
      reducer_version: boundedText(synthesis.reducer_version, 80),
      contributing_observation_ids: boundedArray(synthesis.contributing_observation_ids, 12, (id) => boundedText(id, 120)),
    },
  };
}

function projectAssessmentDelta(delta, idField) {
  if (!isRecord(delta) || typeof delta[idField] !== "string") return null;
  const result = {
    [idField]: boundedText(delta[idField], 96),
    score_delta: rounded(delta.score_delta),
    coverage_delta: rounded(delta.coverage_delta),
  };
  if (typeof delta.state === "string") result.state = boundedText(delta.state, 48);
  return result;
}

function projectAssessmentTrajectory(trajectory) {
  const source = isRecord(trajectory) ? trajectory : {};
  return {
    state: boundedText(source.state, 64),
    reason: boundedText(source.reason),
    prior_assessment_id: typeof source.prior_assessment_id === "string" ? boundedText(source.prior_assessment_id, 80) : null,
    score_delta: rounded(source.score_delta),
    coverage_delta: rounded(source.coverage_delta),
    classification: typeof source.classification === "string" ? boundedText(source.classification, 80) : null,
    movement_cause: boundedText(source.movement_cause, 80),
    semantic_digest_changed: typeof source.semantic_digest_changed === "boolean" ? source.semantic_digest_changed : null,
    dimension_deltas: boundedArray(source.dimension_deltas, 9, (delta) => projectAssessmentDelta(delta, "dimension_id")),
    criterion_deltas: boundedArray(source.criterion_deltas, 33, (delta) => projectAssessmentDelta(delta, "criterion_id")),
  };
}

function projectCoverageAccounting(accounting) {
  if (!isRecord(accounting)) return null;
  const count = (name) => Number.isSafeInteger(accounting[name]) && accounting[name] >= 0 ? accounting[name] : 0;
  return {
    criterion_total: count("criterion_total"),
    established_count: count("established_count"),
    provisional_count: count("provisional_count"),
    not_scored_count: count("not_scored_count"),
    not_applicable_count: count("not_applicable_count"),
    mapping_failure_count: count("mapping_failure_count"),
    assessed_criterion_rate: typeof accounting.assessed_criterion_rate === "number" && Number.isFinite(accounting.assessed_criterion_rate)
      ? Math.max(0, Math.min(1, accounting.assessed_criterion_rate)) : 0,
    coverage_gate: isRecord(accounting.coverage_gate) ? {
      required_criteria: Number.isSafeInteger(accounting.coverage_gate.required_criteria) && accounting.coverage_gate.required_criteria >= 0 ? accounting.coverage_gate.required_criteria : 0,
      denominator: Number.isSafeInteger(accounting.coverage_gate.denominator) && accounting.coverage_gate.denominator >= 0 ? accounting.coverage_gate.denominator : 0,
      target_rate: rounded(accounting.coverage_gate.target_rate),
      assessed_criterion_rate: rounded(accounting.coverage_gate.assessed_criterion_rate),
      status: ["passed", "not_met"].includes(accounting.coverage_gate.status) ? accounting.coverage_gate.status : "not_met",
      reason: boundedText(accounting.coverage_gate.reason),
    } : null,
    not_scored_reasons: boundedArray(accounting.not_scored_reasons, 16, (reason) => {
      if (!isRecord(reason)) return null;
      return {
        reason: boundedText(reason.reason, 120),
        category: boundedText(reason.category, 64),
        criterion_count: Number.isSafeInteger(reason.criterion_count) && reason.criterion_count >= 0 ? reason.criterion_count : 0,
      };
    }),
  };
}

function projectAssessmentArtifact(assessment) {
  const overview = isRecord(assessment?.overview) ? assessment.overview : {};
  const maturity = boundedText(overview.maturity, 40);
  const isNotScored = maturity === "not_scored";
  const scoreVisibility = isNotScored ? "hidden" : ["provisional", "established"].includes(overview.score_visibility)
    ? overview.score_visibility
    : maturity === "provisional" ? "provisional" : "established";
  return {
    state: maturity,
    reason: "derived from the immutable canonical snapshot by the versioned SEI engineering assessment evaluator",
    assessment_id: assessment.assessment_id,
    score: isNotScored ? null : rounded(overview.score),
    score_band: isNotScored ? "NOT SCORED" : boundedText(overview.score_band, 40),
    score_visibility: scoreVisibility,
    coverage: rounded(overview.coverage) ?? 0,
    confidence: boundedText(overview.confidence, 40),
    maturity,
    dimensions: boundedArray(assessment.dimensions, 9, (dimension) => ({
      dimension_id: boundedText(dimension.dimension_id, 96),
      weight: rounded(dimension.weight),
      score: dimension.maturity === "not_scored" ? null : rounded(dimension.score),
      coverage: rounded(dimension.coverage),
      confidence: boundedText(dimension.confidence, 40),
      maturity: boundedText(dimension.maturity, 40),
      observed_criterion_count: dimension.observed_criterion_count,
      criterion_count: dimension.criterion_count,
    })),
    domain_summary: projectAssessmentDomainSummary(assessment),
    criteria: boundedArray(assessment.criteria, 64, (criterion) => ({
      criterion_id: boundedText(criterion.criterion_id, 96),
      dimension_id: boundedText(criterion.dimension_id, 96),
      weight: rounded(criterion.weight),
      applicability: boundedText(criterion.applicability, 40),
      score: criterion.maturity === "not_scored" ? null : rounded(criterion.score),
      coverage: rounded(criterion.coverage),
      confidence: boundedText(criterion.confidence, 40),
      maturity: boundedText(criterion.maturity, 40),
      evidence: projectCriterionEvidence(criterion.evidence),
      explanation: projectCriterionExplanation(criterion.explanation),
    })),
    strengths: boundedArray(assessment.strengths, 12, (finding) => ({
      criterion_id: boundedText(finding.criterion_id, 96),
      dimension_id: boundedText(finding.dimension_id, 96),
      score: rounded(finding.score),
    })),
    deficiencies: boundedArray(assessment.deficiencies, 12, (finding) => ({
      criterion_id: boundedText(finding.criterion_id, 96),
      dimension_id: boundedText(finding.dimension_id, 96),
      score: rounded(finding.score),
      severity: rounded(finding.severity),
    })),
    interventions: boundedArray(assessment.interventions, 12, (intervention) => ({
      intervention_id: boundedText(intervention.intervention_id, 96),
      criterion_id: boundedText(intervention.criterion_id, 96),
      dimension_id: boundedText(intervention.dimension_id, 96),
      family: boundedText(intervention.family, 80),
      priority: rounded(intervention.priority),
      targets: boundedArray(intervention.targets, 8, (target) => boundedText(target, 180)),
      why: boundedText(intervention.why),
      next_investigation: boundedText(intervention.next_investigation),
      boundary: boundedText(intervention.boundary),
    })),
    framework_lenses: boundedArray(assessment.framework_lenses, 12, (lens) => ({
      lens_id: boundedText(lens.lens_id, 80),
      label: boundedText(lens.label),
      status: boundedText(lens.status, 40),
      reason: boundedText(lens.reason),
    })),
    trajectory: projectAssessmentTrajectory(assessment.trajectory),
    evidence_limits: boundedArray(assessment.evidence_limits, 24, (limit) => ({
      criterion_id: boundedText(limit.criterion_id, 96),
      reason: boundedText(limit.reason),
    })),
    observation_vocabulary_version: typeof assessment.observation_vocabulary_version === "string"
      ? boundedText(assessment.observation_vocabulary_version, 80) : null,
    observation_vocabulary_digest: typeof assessment.observation_vocabulary_digest === "string"
      ? boundedText(assessment.observation_vocabulary_digest, 80) : null,
    semantic_digest: typeof assessment.semantic_digest === "string" ? boundedText(assessment.semantic_digest, 80) : null,
    coverage_accounting: projectCoverageAccounting(assessment.coverage_accounting),
  };
}

function projectVisualDatasets(assessment, predictiveIntelligence, complexity, scatter, topology, coupling, duplication, trend) {
  const scoreTarget = Number.isFinite(assessment?.acceptable_score) ? assessment.acceptable_score : 70;
  const targetFor = (item) => {
    const target = isRecord(item?.target) ? item.target : isRecord(item?.target_band) ? item.target_band : null;
    return {
      acceptable_score: Number.isFinite(target?.acceptable_score) ? rounded(target.acceptable_score) : scoreTarget,
      target_source: target?.target_source === "repository-override" || target?.source === "repository-override" ? "repository-override" : "sei-default",
      policy_digest: typeof target?.policy_digest === "string" ? boundedText(target.policy_digest, 80) : null,
      observations: Array.isArray(target?.observations) ? target.observations.slice(0, 8).map((observation) => ({
        observation_id: boundedText(observation.observation_id, 120),
        direction: boundedText(observation.direction, 32),
        acceptable_value: rounded(observation.acceptable_value),
        concern_value: rounded(observation.concern_value),
        unit: boundedText(observation.unit, 80),
      })) : [],
    };
  };
  const criteria = Array.isArray(assessment?.criteria) ? assessment.criteria : [];
  const criterionTargets = criteria.map((criterion) => {
    const target = targetFor(criterion);
    const score = Number.isFinite(criterion.score) ? rounded(criterion.score) : null;
    return {
      criterion_id: boundedText(criterion.criterion_id, 96),
      label: boundedText(String(criterion.criterion_id).replaceAll("_", " "), 96),
      score,
      target_score: target.acceptable_score,
      gap: score === null ? null : rounded(target.acceptable_score - score),
      coverage: rounded(criterion.coverage),
      confidence: boundedText(criterion.confidence, 40),
      maturity: boundedText(criterion.maturity, 40),
      target_source: target.target_source,
      policy_digest: target.policy_digest,
      observations: target.observations,
    };
  });
  const priorityGaps = criterionTargets.filter((criterion) => Number.isFinite(criterion.gap) && criterion.gap > 0)
    .sort((left, right) => right.gap - left.gap || stableCompare(left.criterion_id, right.criterion_id)).slice(0, 5);
  const dimensions = Array.isArray(assessment?.dimensions) ? assessment.dimensions : [];
  return {
    target_policy: isRecord(assessment?.target_policy) ? {
      schema_version: boundedText(assessment.target_policy.schema_version, 80),
      digest: boundedText(assessment.target_policy.digest, 80),
      source: boundedText(assessment.target_policy.source, 40),
    } : { schema_version: "sei.assessment-target-policy@1", digest: null, source: "sei-default" },
    executive: {
      score: Number.isFinite(assessment?.score) ? rounded(assessment.score) : null,
      acceptable_score: scoreTarget,
      coverage: rounded(assessment?.coverage),
      confidence: boundedText(assessment?.confidence, 40),
      predictive_state: boundedText(predictiveIntelligence?.state, 40),
    },
    domains: dimensions.slice(0, 12).map((dimension) => ({
      dimension_id: boundedText(dimension.dimension_id, 96),
      label: boundedText(dimension.label ?? dimension.dimension_id, 96),
      score: Number.isFinite(dimension.score) ? rounded(dimension.score) : null,
      target_score: Number.isFinite(dimension.acceptable_score) ? rounded(dimension.acceptable_score) : scoreTarget,
      coverage: rounded(dimension.coverage),
      maturity: boundedText(dimension.maturity, 40),
    })),
    criteria: criterionTargets.slice(0, 64),
    priority_gaps: priorityGaps,
    predictive: {
      forward_fold_count: Number.isSafeInteger(predictiveIntelligence?.forward_fold_count) ? predictiveIntelligence.forward_fold_count : 0,
      selected_methods: Array.isArray(predictiveIntelligence?.selected_methods) ? predictiveIntelligence.selected_methods.slice(0, 16) : [],
      current_rankings: Array.isArray(predictiveIntelligence?.current_rankings) ? predictiveIntelligence.current_rankings.slice(0, 16) : [],
    },
    complexity: (complexity?.partitions ?? []).slice(0, 4).map((partition) => ({ label: boundedText(partition.label, 96), coverage: rounded(partition.coverage) })),
    scatter: (scatter?.points ?? []).slice(0, 12).map((point) => ({ subject: boundedText(point.subject, 120), x: rounded(point.x), y: rounded(point.y) })),
    topology: (topology?.items ?? []).slice(0, 6).map((item) => ({
      label: humanTrendMetricLabel(item.metric_id),
      value: rounded(item.value),
    })),
    coupling: (coupling?.relationships ?? []).slice(0, 6).map((item) => ({ source: boundedText(item.source, 80), target: boundedText(item.target, 80), value: rounded(item.value) })),
    duplication: (duplication?.items ?? []).slice(0, 4).map((item) => ({
      label: humanTrendMetricLabel(item.metric_id),
      value: rounded(item.value),
    })),
    trend: (trend?.items ?? []).slice(0, 4).map((item) => ({
      label: humanTrendMetricLabel(item.metric_id),
      value: rounded(item.value),
      delta: rounded(item.delta),
    })),
  };
}

function projectValidatedSnapshot(snapshot, options = {}) {
  if (!isRecord(options) || Object.keys(options).some((key) => !["predictive_binding", "assessment_binding"].includes(key))) {
    throw new Error("FAIL-REPORT-PROJECTION: package-private options contain an unsupported binding");
  }
  const predictiveBinding = Object.hasOwn(options, "predictive_binding")
    ? options.predictive_binding
    : undefined;
  const assessmentBinding = Object.hasOwn(options, "assessment_binding")
    ? options.assessment_binding
    : undefined;
  const metrics = Array.isArray(snapshot.measurements) ? snapshot.measurements : [];
  const composition = projectComposition(metrics);
  const rawComplexity = projectComplexity(metrics);
  const capabilityCoverage = projectCapabilityCoverage(snapshot);
  const complexity = projectComplexityPresentation(snapshot);
  const scatter = projectScatter(snapshot);
  const coupling = projectCoupling(snapshot);
  const investigations = projectInvestigations(snapshot);
  const predictiveStatus = projectPredictiveStatus(snapshot, predictiveBinding);
  const predictiveIntelligence = projectPredictiveIntelligence(snapshot, predictiveBinding, predictiveStatus);
  const trendStatus = projectTrendStatus(snapshot, metrics);
  const topology = metricView(
    metrics,
    (metric) => /\.dependency\./.test(metric.metric_id)
      && /(?:node_count|edge_count|scc_count|cyclic_|density|fan_(?:in|out)_max|page_rank|betweenness)/.test(metric.metric_id),
    LIMITS.topology,
    "no bounded dependency topology evidence",
    (left, right) => {
      const centrality = (metric) => /(?:page_rank|betweenness)/.test(metric.metric_id) ? 1 : 0;
      return centrality(left) - centrality(right)
        || (centrality(left) === 1 ? right.value - left.value : 0)
        || stableCompare(left.metric_id, right.metric_id);
    },
    emptyState({
      headline: "Dependency topology is not available",
      missing: "Supported dependency topology evidence",
      causeKind: "not-observed",
      explanation: "SEI has no bounded dependency topology observations for this snapshot.",
      availabilityPath: "Analyze supported Python or TS/JS source with a dependency collector.",
    }),
  );
  const duplication = projectDuplication(metrics, capabilityCoverage);
  const trend = projectTrend(metrics, trendStatus);
  const trendPrimary = projectPrimaryTrend(trend);
  const evidenceExplorer = projectEvidenceExplorer(
    snapshot,
    metrics,
    rawComplexity,
    composition,
    coupling,
    duplication,
    topology,
    trend,
  );
  const assessment = projectAssessment(snapshot, assessmentBinding);
  const visualDatasets = projectVisualDatasets(assessment, predictiveIntelligence, complexity, scatter, topology, coupling, duplication, trend);
  return {
    schema_version: REPORT_PROJECTION_VERSION,
    source: {
      snapshot_id: snapshot.snapshot_id,
      snapshot_sha256: snapshotDigest(snapshot),
      repository_id: boundedText(snapshot.repository.repository_id),
      revision: snapshot.repository.revision,
      generated_at: snapshot.run_metadata.generated_at,
    },
    predictive_intelligence: predictiveIntelligence,
    visual_datasets: visualDatasets,
    predictive_status: predictiveStatus,
    assessment,
    trend_status: trendStatus,
    trend_primary: trendPrimary,
    repository_overview: projectRepositoryOverview(snapshot, composition, capabilityCoverage, investigations),
    capability_coverage: capabilityCoverage,
    composition,
    complexity,
    scatter,
    investigations,
    evidence_explorer: evidenceExplorer,
    // Compatibility aliases remain projection-only; the V7 renderer places raw
    // collector counts and raw metric tables exclusively in the evidence explorer.
    evidence: evidenceExplorer.measurement_summary,
    views: {
      topology,
      coupling,
      duplication,
      trend,
    },
  };
}

function projectReport(snapshot, options = {}) {
  if (!isRecord(options) || Object.keys(options).length !== 0) {
    throw new Error("FAIL-REPORT-PROJECTION: public projection does not accept predictive evidence; renderReport requires a package-branded predictive binding");
  }
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) throw new Error(`FAIL-REPORT-PROJECTION-SNAPSHOT: ${validation.errors.join("; ")}`);
  return projectValidatedSnapshot(snapshot);
}

function exactKeys(value, fields) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort(stableCompare);
  const expected = [...fields].sort(stableCompare);
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function validPredictiveStatus(status) {
  const fields = [
    "predictive_status_version",
    "state",
    "evaluation_exists",
    "compatibility",
    "exact_snapshot_participation",
    "receipt",
    "outcomes",
    "summary",
  ];
  if (!exactKeys(status, fields) || status.predictive_status_version !== PREDICTIVE_STATUS_VERSION
      || !PREDICTIVE_STATUS_STATES.has(status.state)
      || typeof status.evaluation_exists !== "boolean" || typeof status.compatibility !== "string"
      || typeof status.summary !== "string" || !Array.isArray(status.outcomes) || status.outcomes.length > 16) {
    return false;
  }
  if (status.state === "not-yet-evaluated") {
    return status.evaluation_exists === false && status.compatibility === "not-assessed"
      && status.exact_snapshot_participation === null && status.receipt === null && status.outcomes.length === 0;
  }
  if (!status.evaluation_exists || !isRecord(status.receipt)
      || !/^sha256:[a-f0-9]{64}$/.test(status.receipt.receipt_sha256)
      || status.receipt.digest_status !== "declared-not-recomputed"
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(status.receipt.final_revision)) {
    return false;
  }
  const isV9Receipt = Number.isSafeInteger(status.receipt.horizon_count)
    || Number.isSafeInteger(status.receipt.development_fold_count)
    || Number.isSafeInteger(status.receipt.terminal_holdout_fold_count);
  if (isV9Receipt) {
    if (!Number.isSafeInteger(status.receipt.horizon_count) || status.receipt.horizon_count !== 3
        || status.receipt.development_fold_count !== 3
        || status.receipt.terminal_holdout_fold_count !== 1) return false;
  } else if (!exactKeys(status.receipt, [
    "receipt_sha256",
    "digest_status",
    "final_revision",
    "forward_fold_count",
    "cutoff_snapshot_count",
  ]) || !Number.isSafeInteger(status.receipt.forward_fold_count) || status.receipt.forward_fold_count < 1
      || !Number.isSafeInteger(status.receipt.cutoff_snapshot_count)
      || status.receipt.cutoff_snapshot_count !== status.receipt.forward_fold_count + 2) {
    return false;
  }
  const stateShape = {
    NOT_READY: ["compatible", true],
    READY_NOT_EVALUATED: ["compatible", true],
    VALIDATED_BASELINE: ["compatible", true],
    VALIDATED_MODEL: ["compatible", true],
    NO_USEFUL_SIGNAL: ["compatible", true],
    STALE: ["compatible", false],
    INCOMPATIBLE: ["not-comparable", null],
    "evaluated-current": ["compatible", true],
    "previously-evaluated-compatible-not-current": ["compatible", false],
    "prior-evaluation-not-comparable": ["not-comparable", null],
    unresolved: ["compatible", true],
  }[status.state];
  if (stateShape === undefined || status.compatibility !== stateShape[0]
      || status.exact_snapshot_participation !== stateShape[1]) return false;
  if (isV9Receipt) {
    return status.outcomes.every((outcome) => (
      exactKeys(outcome, ["target_id", "horizon_commits", "state", "selected_method", "terminal_state", "forecast_item_count", "summary"])
        && typeof outcome.target_id === "string" && outcome.target_id.length > 0
        && V9_HORIZONS.includes(outcome.horizon_commits)
        && V9_PREDICTIVE_STATES.has(outcome.state)
        && (outcome.selected_method === null || (isRecord(outcome.selected_method)
          && exactKeys(outcome.selected_method, ["method_id", "method_kind"])
          && typeof outcome.selected_method.method_id === "string"
          && typeof outcome.selected_method.method_kind === "string"))
        && typeof outcome.terminal_state === "string"
        && Number.isSafeInteger(outcome.forecast_item_count) && outcome.forecast_item_count >= 0 && outcome.forecast_item_count <= 10
        && typeof outcome.summary === "string"
    ));
  }
  return status.outcomes.every((outcome) => (
    exactKeys(outcome, ["outcome_id", "state", "evaluated_fold_count", "baseline_vs_composite"])
      && typeof outcome.outcome_id === "string" && outcome.outcome_id.length > 0
      && ["evaluated", "partially-evaluated", "not-established", "unavailable"].includes(outcome.state)
      && Number.isSafeInteger(outcome.evaluated_fold_count) && outcome.evaluated_fold_count >= 0
      && (outcome.state !== "evaluated" || outcome.evaluated_fold_count >= 2)
      && exactKeys(outcome.baseline_vs_composite, [
        "basis",
        "baseline_count",
        "baseline_better_count",
        "composite_better_count",
        "tied_count",
        "unavailable_count",
        "summary",
      ])
      && outcome.baseline_vs_composite.basis === "forward-fold ranking-score comparison"
      && ["baseline_count", "baseline_better_count", "composite_better_count", "tied_count", "unavailable_count"].every((key) => (
        Number.isSafeInteger(outcome.baseline_vs_composite[key]) && outcome.baseline_vs_composite[key] >= 0
      ))
      && outcome.baseline_vs_composite.baseline_count === (
        outcome.baseline_vs_composite.baseline_better_count
          + outcome.baseline_vs_composite.composite_better_count
          + outcome.baseline_vs_composite.tied_count
          + outcome.baseline_vs_composite.unavailable_count
      )
      && typeof outcome.baseline_vs_composite.summary === "string"
  ));
}

function validateReportProjection(projection) {
  const errors = [];
  if (projection === null || typeof projection !== "object" || Array.isArray(projection)) {
    return { ok: false, errors: ["FAIL-REPORT-PROJECTION: projection must be an object"] };
  }
  if (!REPORT_PROJECTION_COMPATIBLE.has(projection.schema_version)) errors.push("FAIL-REPORT-PROJECTION: unsupported schema version");
  if (!/^[a-f0-9]{64}$/.test(projection.source?.snapshot_sha256 ?? "")) errors.push("FAIL-REPORT-PROJECTION: source snapshot digest is invalid");
  const assessment = projection.assessment;
  if (!isRecord(assessment)
      || !["not-assessed", "not_scored", "provisional", "established"].includes(assessment.state)
      || typeof assessment.reason !== "string"
      || !["NOT SCORED", "Excellent", "Strong", "Good", "Needs attention", "Material gaps"].includes(assessment.score_band)
      || !["hidden", "provisional", "established"].includes(assessment.score_visibility)
      || (assessment.score !== null && (typeof assessment.score !== "number" || !Number.isFinite(assessment.score) || assessment.score < 0 || assessment.score > 100))
      || typeof assessment.coverage !== "number" || assessment.coverage < 0 || assessment.coverage > 1
      || !["HIGH", "MODERATE", "LOW", "NOT_ESTABLISHED"].includes(assessment.confidence)
      || !Array.isArray(assessment.dimensions) || assessment.dimensions.length > 9
      || !Array.isArray(assessment.criteria) || assessment.criteria.length > 64
      || !Array.isArray(assessment.strengths) || assessment.strengths.length > 12
      || !Array.isArray(assessment.deficiencies) || assessment.deficiencies.length > 12
      || !Array.isArray(assessment.interventions) || assessment.interventions.length > 12
      || !Array.isArray(assessment.framework_lenses) || assessment.framework_lenses.length > 12
      || !Array.isArray(assessment.domain_summary) || assessment.domain_summary.length > 9
      || !isRecord(assessment.trajectory)) {
    errors.push("FAIL-REPORT-PROJECTION: engineering assessment projection is invalid");
  } else {
    if (assessment.domain_summary.some((domain) => (
      !isRecord(domain)
        || typeof domain.dimension_id !== "string"
        || typeof domain.label !== "string"
        || !["complete", "complete-zero", "partial", "resource-limited", "unavailable", "not-scored"].includes(domain.evidence_state)
        || (domain.score !== null && (typeof domain.score !== "number" || !Number.isFinite(domain.score) || domain.score < 0 || domain.score > 100))
        || (domain.coverage !== null && (typeof domain.coverage !== "number" || !Number.isFinite(domain.coverage) || domain.coverage < 0 || domain.coverage > 1))
    ))) {
      errors.push("FAIL-REPORT-PROJECTION: engineering assessment domain summary is invalid");
    }
    if ((assessment.maturity === "not_scored" && (assessment.score !== null || assessment.score_visibility !== "hidden"))
        || (assessment.maturity === "provisional" && assessment.score_visibility !== "provisional")
        || (assessment.maturity === "established" && assessment.score_visibility !== "established")) {
      errors.push("FAIL-REPORT-PROJECTION: assessment score visibility violates maturity");
    }
    const reasonCategories = new Set(["genuinely_unavailable_evidence", "external_evidence_required", "unsupported_capability", "not_applicable", "insufficient_criterion_evidence", "mapping_failure"]);
    if (assessment.observation_vocabulary_version !== null && (!isRecord(assessment.coverage_accounting)
        || assessment.coverage_accounting.mapping_failure_count !== 0
        || !Array.isArray(assessment.coverage_accounting.not_scored_reasons)
        || assessment.coverage_accounting.not_scored_reasons.some((reason) => !isRecord(reason)
          || typeof reason.reason !== "string" || reason.reason.length === 0
          || !reasonCategories.has(reason.category)
          || !Number.isSafeInteger(reason.criterion_count) || reason.criterion_count < 0))) {
      errors.push("FAIL-REPORT-PROJECTION: assessment mapping debt must be zero");
    }
    if (isRecord(assessment.coverage_accounting)) {
      const accounting = assessment.coverage_accounting;
      const accounted = Number(accounting.established_count ?? 0) + Number(accounting.provisional_count ?? 0)
        + Number(accounting.not_scored_count ?? 0) + Number(accounting.not_applicable_count ?? 0);
      const reasonTotal = Array.isArray(accounting.not_scored_reasons)
        ? accounting.not_scored_reasons.reduce((sum, reason) => sum + Number(reason?.criterion_count ?? 0), 0) : -1;
      if (accounted !== accounting.criterion_total || reasonTotal !== accounting.not_scored_count) {
        errors.push("FAIL-REPORT-PROJECTION: assessment coverage accounting does not reconcile");
      }
      const assessed = Number(accounting.established_count ?? 0) + Number(accounting.provisional_count ?? 0);
      const expectedRate = accounting.criterion_total > 0 ? assessed / accounting.criterion_total : 0;
      if (!Number.isFinite(accounting.assessed_criterion_rate) || Math.abs(accounting.assessed_criterion_rate - expectedRate) > 0.000001
          || !isRecord(accounting.coverage_gate)
          || accounting.coverage_gate.denominator !== accounting.criterion_total
          || Math.abs(Number(accounting.coverage_gate.assessed_criterion_rate) - expectedRate) > 0.000001) {
        errors.push("FAIL-REPORT-PROJECTION: assessment coverage rate does not reconcile");
      }
    }
    if (assessment.observation_vocabulary_version !== null && assessment.criteria.some((criterion) => (
      criterion.score !== null
        && ["observed", "means", "why_it_matters", "limitations", "blocked_stronger_result", "next_investigation"]
          .some((field) => typeof criterion.explanation?.[field] !== "string" || criterion.explanation[field].length === 0)
    ))) {
      errors.push("FAIL-REPORT-PROJECTION: scored V8.1 criteria require complete explanations");
    }
    if (assessment.observation_vocabulary_version !== null && (typeof assessment.trajectory.classification !== "string"
        || assessment.trajectory.classification.length === 0
        || typeof assessment.trajectory.semantic_digest_changed !== "boolean" && assessment.trajectory.semantic_digest_changed !== null)) {
      errors.push("FAIL-REPORT-PROJECTION: V8.1 trajectory classification is invalid");
    }
  }
  if (!isRecord(projection.repository_overview)
      || typeof projection.repository_overview.headline !== "string"
      || typeof projection.repository_overview.summary !== "string") {
    errors.push("FAIL-REPORT-PROJECTION: repository overview is invalid");
  }
  if (!Array.isArray(projection.capability_coverage?.capabilities)
      || projection.capability_coverage.capabilities.length > LIMITS.capabilities
      || projection.capability_coverage.capabilities.some((capability) => (
        !isRecord(capability)
        || typeof capability.capability_id !== "string"
        || typeof capability.title !== "string"
        || typeof capability.evidence_state !== "string"
        || typeof capability.summary !== "string"
        || typeof capability.next_evidence !== "string"
      ))) {
    errors.push("FAIL-REPORT-PROJECTION: capability coverage is invalid");
  }
  if (!Array.isArray(projection.evidence_explorer?.measurement_summary?.statuses)
      || projection.evidence_explorer.measurement_summary.statuses.map((item) => item?.status).join("\0") !== EVIDENCE_STATES.join("\0")) {
    errors.push("FAIL-REPORT-PROJECTION: evidence states are incomplete or out of order");
  }
  const predictive = projection.predictive_intelligence;
  if (!isRecord(predictive) || typeof predictive.state !== "string" || typeof predictive.reason !== "string") {
    errors.push("FAIL-REPORT-PROJECTION: predictive intelligence state is invalid");
  } else if (V9_PREDICTIVE_STATES.has(predictive.state)) {
    const validHorizon = (horizon) => isRecord(horizon)
      && V9_HORIZONS.includes(horizon.horizon_commits)
      && V9_PREDICTIVE_STATES.has(horizon.state)
      && Number.isSafeInteger(horizon.target_count) && horizon.target_count >= 0 && horizon.target_count <= 3
      && Array.isArray(horizon.promotions) && horizon.promotions.length <= 3
      && Array.isArray(horizon.current_rankings) && horizon.current_rankings.length <= 16
      && typeof horizon.forecast_available === "boolean";
    const validPromotion = (promotion) => isRecord(promotion)
      && typeof promotion.target_id === "string" && promotion.target_id.length > 0
      && V9_HORIZONS.includes(promotion.horizon_commits)
      && V9_PREDICTIVE_STATES.has(promotion.state)
      && typeof promotion.terminal_state === "string"
      && typeof promotion.summary === "string"
      && Number.isSafeInteger(promotion.forecast_item_count) && promotion.forecast_item_count >= 0 && promotion.forecast_item_count <= 10;
    if (!Number.isSafeInteger(predictive.default_horizon_commits) || predictive.default_horizon_commits !== 25
        || !Array.isArray(predictive.available_horizons) || predictive.available_horizons.length > 3
        || predictive.available_horizons.some((horizon) => !V9_HORIZONS.includes(horizon))
        || !Array.isArray(predictive.horizons) || predictive.horizons.length > 3
        || predictive.horizons.some((horizon) => !validHorizon(horizon))
        || !Array.isArray(predictive.outcomes) || predictive.outcomes.length > 16
        || predictive.outcomes.some((promotion) => !validPromotion(promotion))
        || !Array.isArray(predictive.current_rankings) || predictive.current_rankings.length > 16
        || predictive.current_rankings.some((ranking) => !isRecord(ranking) || typeof ranking.outcome_id !== "string"
          || !V9_HORIZONS.includes(ranking.horizon_commits) || typeof ranking.method_id !== "string"
          || ranking.claim !== "rank-only" || !Array.isArray(ranking.items) || ranking.items.length > 10)
        || !isRecord(predictive.validation)
        || !Array.isArray(predictive.validation.candidate_methods)
        || !Array.isArray(predictive.validation.fallback_methods)
        || typeof predictive.validation.terminal_state !== "string"
        || !Number.isSafeInteger(predictive.validation.development_fold_count)
        || !Number.isSafeInteger(predictive.validation.terminal_holdout_fold_count)
        || !isRecord(predictive.validation.coverage)
        || !Number.isSafeInteger(predictive.validation.coverage.available_horizon_count)
        || predictive.validation.coverage.available_horizon_count < 0
        || predictive.validation.coverage.available_horizon_count > 3
        || !Number.isSafeInteger(predictive.validation.coverage.evaluated_horizon_count)
        || predictive.validation.coverage.evaluated_horizon_count < 0
        || predictive.validation.coverage.evaluated_horizon_count > predictive.validation.coverage.available_horizon_count
        || typeof predictive.validation.coverage.default_horizon_evaluated !== "boolean"
        || !isRecord(predictive.descriptive_concentration)
        || predictive.descriptive_concentration.state !== "descriptive-only"
        || typeof predictive.descriptive_concentration.summary !== "string"
        || typeof predictive.interpretation_boundary !== "string"
        || !Array.isArray(predictive.limitations)
        || predictive.limitations.length === 0
        || predictive.limitations.length > 4
        || predictive.limitations.some((limitation) => typeof limitation !== "string" || limitation.length === 0)
        || !["readiness", "validated", "no-current-forecast", "stale", "incompatible"].includes(predictive.forecast_state)) {
      errors.push("FAIL-REPORT-PROJECTION: V9 predictive intelligence is not a bounded state projection");
    }
  } else if (predictive.state === "not-established") {
    const legacyKeys = ["reason", "state"];
    const isLegacyReadiness = Object.keys(predictive).sort().join("\0") === legacyKeys.join("\0");
    const readinessKeys = new Set(["state", "reason", "forecast_state", "forward_fold_count", "selected_methods", "current_rankings", "outcomes"]);
    const isReadiness = !Object.keys(predictive).some((key) => !readinessKeys.has(key))
      && predictive.forecast_state === "readiness"
      && predictive.forward_fold_count === 0
      && Array.isArray(predictive.selected_methods) && predictive.selected_methods.length === 0
      && Array.isArray(predictive.current_rankings) && predictive.current_rankings.length === 0
      && Array.isArray(predictive.outcomes) && predictive.outcomes.length === 0;
    if (!isLegacyReadiness && !isReadiness) {
      errors.push("FAIL-REPORT-PROJECTION: not-established predictive intelligence readiness payload is invalid");
    }
  } else if (predictive.state === "evaluated" || predictive.state === "partially-evaluated") {
    const currentRankings = predictive.current_rankings === undefined ? [] : predictive.current_rankings;
    if (!/^(?:sha256:)[a-f0-9]{64}$/.test(predictive.receipt_sha256 ?? "")
        || !/^(?:sha256:)[a-f0-9]{64}$/.test(predictive.bundle_sha256 ?? "")
        || !Number.isSafeInteger(predictive.ranking_k) || predictive.ranking_k < 1
        || !Number.isSafeInteger(predictive.forward_fold_count) || predictive.forward_fold_count < 1
        || typeof predictive.interpretation_boundary !== "string" || !Array.isArray(predictive.outcomes)
        || predictive.outcomes.length === 0 || predictive.outcomes.length > 8
        || !Array.isArray(currentRankings) || currentRankings.length > 16
        || currentRankings.some((ranking) => !isRecord(ranking) || typeof ranking.outcome_id !== "string" || typeof ranking.method_id !== "string" || !Array.isArray(ranking.items) || ranking.items.length > 10)) {
      errors.push("FAIL-REPORT-PROJECTION: evaluated predictive intelligence is not a bounded validated projection");
    }
  } else {
    errors.push("FAIL-REPORT-PROJECTION: predictive intelligence state is unsupported");
  }
  const predictiveStatus = projection.predictive_status;
  if (predictiveStatus !== null && !validPredictiveStatus(predictiveStatus)) {
    errors.push("FAIL-REPORT-PROJECTION: predictive status is invalid");
  } else if (predictiveStatus === null) {
    if (predictive?.state !== "not-established" && predictive?.state !== "NOT_READY") {
      errors.push("FAIL-REPORT-PROJECTION: predictive evaluation requires a predictive status binding");
    }
  } else if (predictive?.state === "evaluated" || predictive?.state === "partially-evaluated") {
    if (predictiveStatus.state !== "evaluated-current") {
      errors.push("FAIL-REPORT-PROJECTION: current predictive detail requires an evaluated-current predictive status");
    }
  } else if (predictiveStatus.state === "evaluated-current") {
    errors.push("FAIL-REPORT-PROJECTION: evaluated-current predictive status requires bound current predictive detail");
  }
  const trendStatus = projection.trend_status;
  if (trendStatus !== null && (!isRecord(trendStatus)
      || !TREND_STATUS_STATES.has(trendStatus.state)
      || typeof trendStatus.compatibility !== "string"
      || typeof trendStatus.summary !== "string"
      || typeof trendStatus.next_observation !== "string")) {
    errors.push("FAIL-REPORT-PROJECTION: trend status is invalid");
  }
  const limits = [
    [projection.composition?.items, LIMITS.composition, "composition"],
    [projection.complexity?.partitions, LIMITS.complexity_partitions, "complexity partitions"],
    [projection.scatter?.points, LIMITS.scatter, "scatter"],
    [projection.investigations?.items, LIMITS.investigations, "investigations"],
    [projection.evidence_explorer?.raw_views?.topology?.items, LIMITS.topology, "topology"],
    [projection.evidence_explorer?.raw_views?.coupling?.relationships, LIMITS.coupling, "coupling"],
    [projection.evidence_explorer?.raw_views?.duplication?.items, LIMITS.duplication, "duplication"],
    [projection.evidence_explorer?.raw_views?.trend?.items, LIMITS.trend, "trend"],
    [projection.trend_primary?.items, LIMITS.trend, "primary trend"],
    [projection.evidence_explorer?.raw_views?.complexity?.distributions, LIMITS.complexity_distributions, "raw complexity distributions"],
    [projection.evidence_explorer?.raw_views?.complexity?.top_items, LIMITS.complexity_top_items, "raw complexity top items"],
  ];
  for (const [items, maximum, label] of limits) {
    if (!Array.isArray(items) || items.length > maximum) errors.push(`FAIL-REPORT-PROJECTION: ${label} exceeds its closed bound`);
  }
  for (const view of [projection.complexity, projection.scatter, projection.investigations,
    projection.evidence_explorer?.raw_views?.duplication, projection.evidence_explorer?.raw_views?.coupling,
    projection.evidence_explorer?.raw_views?.trend, projection.trend_primary]) {
    if (!isRecord(view) || (view.empty_state !== null && (!isRecord(view.empty_state)
        || ["headline", "missing", "cause_kind", "explanation", "availability_path"].some((field) => typeof view.empty_state[field] !== "string")))) {
      errors.push("FAIL-REPORT-PROJECTION: a major view has an invalid structured empty state");
      break;
    }
  }
  if (JSON.stringify(projection).includes('"measurements"') || JSON.stringify(projection).includes('"profiles"')) {
    errors.push("FAIL-REPORT-PROJECTION: raw snapshot universes are forbidden");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  LIMITS,
  REPORT_PROJECTION_VERSION,
  projectReport,
  snapshotDigest,
  validateReportProjection,
};
Object.defineProperty(module.exports, Symbol.for("sei.report-projection.private.v1"), {
  value: Object.freeze({ projectValidatedSnapshot, projectAssessmentArtifact, projectV9PredictiveState }),
});
