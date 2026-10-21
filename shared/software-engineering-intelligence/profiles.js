"use strict";

const crypto = require("node:crypto");

const PROFILE_DIMENSIONS = Object.freeze({
  Agile: ["individuals_and_interactions", "working_software", "customer_collaboration", "responding_to_change"],
  Scrum: ["accountabilities", "events", "artifacts_and_commitments", "empiricism"],
  Kanban: ["wip", "throughput", "work_item_age", "cycle_time"],
  DORA: ["change_lead_time", "deployment_frequency", "failed_deployment_recovery_time", "change_fail_rate", "deployment_rework_rate"],
  SPACE: ["satisfaction_and_wellbeing", "performance", "activity", "communication_and_collaboration", "efficiency_and_flow"],
  EngThrive: ["speed", "ease", "quality", "thriving"],
});

const PROFILE_VERSION = "1.0.0";
const OBSERVED_STATUSES = new Set(["measured", "inferred"]);
const DORA_FORBIDDEN_PROVENANCE = /merge|pull|commit|branch|(^|[^a-z0-9])(pr|mr)(?=$|[^a-z0-9])/i;
const RFC3339_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

const HUMAN_FRAMEWORK_AUTHORITY = Object.freeze({
  source_kind: "human-process-evidence",
  collector_id: "human-framework-evidence",
  analyzer_identity: "sei.human-framework-evidence@1",
});
const DORA_AUTHORITY = Object.freeze({
  source_kind: "typed-authoritative-deployment",
  collector_id: "dora-deployment-evidence",
  analyzer_identity: "sei.dora-deployment-evidence@1",
});
const KANBAN_AUTHORITY = Object.freeze({
  source_kind: "typed-authoritative-work-item-flow",
  collector_id: "kanban-work-item-flow",
  analyzer_identity: "sei.kanban-work-item-flow@1",
});

const DORA_DIMENSION_CONTRACTS = Object.freeze({
  change_lead_time: Object.freeze({ metric_id: "dora.change_lead_time", definition_id: "sei.dora.change_lead_time@1", family: "delivery_performance", unit: "milliseconds", artifact_prefix: "deployment-record:" }),
  deployment_frequency: Object.freeze({ metric_id: "dora.deployment_frequency", definition_id: "sei.dora.deployment_frequency@1", family: "delivery_performance", unit: "deployments_per_window", artifact_prefix: "deployment-record:" }),
  failed_deployment_recovery_time: Object.freeze({ metric_id: "dora.failed_deployment_recovery_time", definition_id: "sei.dora.failed_deployment_recovery_time@1", family: "delivery_performance", unit: "milliseconds", artifact_prefix: "deployment-record:" }),
  change_fail_rate: Object.freeze({ metric_id: "dora.change_fail_rate", definition_id: "sei.dora.change_fail_rate@1", family: "delivery_performance", unit: "ratio", artifact_prefix: "deployment-record:", ratio: true }),
  deployment_rework_rate: Object.freeze({ metric_id: "dora.deployment_rework_rate", definition_id: "sei.dora.deployment_rework_rate@1", family: "delivery_performance", unit: "ratio", artifact_prefix: "deployment-record:", ratio: true }),
});

const KANBAN_WORKFLOW_CONTRACT = Object.freeze({
  metric_id: "kanban.definition_of_workflow",
  definition_id: "sei.kanban.definition_of_workflow@1",
  family: "workflow_definition",
  unit: "definition",
  artifact_prefix: "workflow-definition:",
});
const KANBAN_TRANSITION_CONTRACT = Object.freeze({
  metric_id: "kanban.transition_records",
  definition_id: "sei.kanban.transition_records@1",
  family: "workflow_transitions",
  unit: "records",
  artifact_prefix: "work-item-transition:",
});
const KANBAN_DIMENSION_CONTRACTS = Object.freeze({
  wip: Object.freeze({ metric_id: "kanban.wip", definition_id: "sei.kanban.wip@1", family: "flow", unit: "items", artifact_prefix: "work-item-transition:" }),
  throughput: Object.freeze({ metric_id: "kanban.throughput", definition_id: "sei.kanban.throughput@1", family: "flow", unit: "items", artifact_prefix: "work-item-transition:" }),
  work_item_age: Object.freeze({ metric_id: "kanban.work_item_age", definition_id: "sei.kanban.work_item_age@1", family: "flow", unit: "milliseconds", artifact_prefix: "work-item-transition:" }),
  cycle_time: Object.freeze({ metric_id: "kanban.cycle_time", definition_id: "sei.kanban.cycle_time@1", family: "flow", unit: "milliseconds", artifact_prefix: "work-item-transition:" }),
});
const SCRUM_ADOPTION_CONTRACT = Object.freeze({
  metric_id: "scrum.current_adoption",
  definition_id: "sei.scrum.current_adoption@1",
  family: "framework_adoption",
  unit: "assertion",
  artifact_prefix: "framework-adoption:",
});
const SPACE_HUMAN_ONLY_DIMENSIONS = new Set(["satisfaction_and_wellbeing", "communication_and_collaboration"]);
const SPACE_TYPED_DIMENSIONS = new Set(["performance", "efficiency_and_flow"]);
const AGILE_HUMAN_ONLY_DIMENSIONS = new Set(["individuals_and_interactions", "customer_collaboration", "responding_to_change"]);
const SPACE_BINDING_FIELDS = new Set(["profile_id", "profile", "id", "evidence", "evidence_bindings"]);
const SPACE_COMPOSITE_CONTROL_KEYS = new Set([
  "single", "single_score", "overall", "overall_score", "overall_rating", "composite", "composite_score", "score", "scores",
  "weighted", "weighted_score", "weighted_average", "weighted_sum", "weight", "weights", "aggregate", "aggregate_score",
  "aggregate_result", "aggregation", "aggregation_result", "aggregation_method", "summary", "summary_score", "summary_method",
  "median", "sum", "min", "max", "mean", "average", "total", "scalar", "scalar_value", "rating", "rank", "rollup",
  "index", "reducer", "calculation",
]);
const AGILE_CLASSIFICATION_FIELDS = new Set(["evidence_class", "class", "classification"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeKey(value) {
  return normalize(String(value ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

function stableCompare(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deriveProfileContractHash(profileId) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify({
    profile_id: profileId,
    profile_version: PROFILE_VERSION,
    dimensions: PROFILE_DIMENSIONS[profileId],
  })).digest("hex")}`;
}

function canonicalProfile(binding) {
  const values = typeof binding === "string"
    ? [binding]
    : isRecord(binding)
      ? ["profile_id", "profile", "id"]
        .filter((field) => Object.hasOwn(binding, field))
        .map((field) => binding[field])
      : [];
  if (values.length === 0 || values.some((value) => !isNonBlankString(value))) return null;
  const aliases = values.map(normalize);
  if (new Set(aliases).size !== 1) return null;
  return Object.keys(PROFILE_DIMENSIONS).find((name) => normalize(name) === aliases[0]) ?? null;
}

function stringArray(value, { minimum = 0 } = {}) {
  if (!Array.isArray(value)) return null;
  const result = value.map((item) => (isNonBlankString(item) ? item.trim() : null));
  if (result.some((item) => item === null) || result.length < minimum || new Set(result).size !== result.length) return null;
  return result.sort(stableCompare);
}

function metricEvidenceRefs(metric) {
  const refs = [
    ...(Array.isArray(metric?.source?.artifact_refs) ? metric.source.artifact_refs : []),
    ...(Array.isArray(metric?.source?.evidence_refs) ? metric.source.evidence_refs : []),
  ];
  const canonical = refs.filter(isNonBlankString).map((item) => item.trim());
  return canonical.length === refs.length ? [...new Set(canonical)].sort(stableCompare) : [];
}

function collectorFor(snapshot, metric) {
  const collectorId = metric?.source?.collector_id;
  const collectors = Array.isArray(snapshot?.collectors) ? snapshot.collectors : [];
  const matching = collectors.filter((collector) => collector?.collector_id === collectorId);
  return matching.length === 1 ? matching[0] : null;
}

function observedSnapshotMetric(snapshot, metric) {
  const source = metric?.source;
  const collector = collectorFor(snapshot, metric);
  const status = metric?.measurement?.status;
  return (
    isRecord(metric) &&
    OBSERVED_STATUSES.has(status) &&
    typeof metric.value === "number" && Number.isFinite(metric.value) &&
    isRecord(source) &&
    isNonBlankString(source.kind) &&
    isNonBlankString(source.collector_id) &&
    isNonBlankString(source.collector_version) &&
    source.repository_revision === snapshot?.repository?.revision &&
    metric.repository_revision === snapshot?.repository?.revision &&
    collector?.status === "available" &&
    collector.collector_version === source.collector_version &&
    collector.analyzer_identity === metric.analyzer_identity &&
    collector.analyzer_version === metric.analyzer_version &&
    metricEvidenceRefs(metric).length > 0
  );
}

function uniqueMetric(snapshot, metricId) {
  const matching = (Array.isArray(snapshot?.measurements) ? snapshot.measurements : [])
    .filter((metric) => metric?.metric_id === metricId);
  return matching.length === 1 ? matching[0] : null;
}

function refsContainPrefix(metric, prefix) {
  const refs = metricEvidenceRefs(metric);
  return refs.length > 0 && refs.some((reference) => reference.startsWith(prefix));
}

function metricMatchesContract(snapshot, metric, contract, authority, { expectedValue = undefined, rejectMergeProvenance = false } = {}) {
  if (!observedSnapshotMetric(snapshot, metric)) return false;
  if (
    metric.metric_id !== contract.metric_id ||
    metric.definition_id !== contract.definition_id ||
    metric.family !== contract.family ||
    metric.unit !== contract.unit ||
    metric.source.kind !== authority.source_kind ||
    metric.source.collector_id !== authority.collector_id ||
    metric.analyzer_identity !== authority.analyzer_identity ||
    !refsContainPrefix(metric, contract.artifact_prefix)
  ) return false;
  if (contract.ratio === true && (metric.value < 0 || metric.value > 1)) return false;
  if (expectedValue !== undefined && metric.value !== expectedValue) return false;
  if (rejectMergeProvenance && metricEvidenceRefs(metric).some((reference) => DORA_FORBIDDEN_PROVENANCE.test(reference))) return false;
  return true;
}

function profileMetricEvidence(metric, dimension, evidenceRefs = metricEvidenceRefs(metric)) {
  return {
    kind: metric.definition_id,
    dimension,
    status: metric.measurement.status,
    evidence_refs: evidenceRefs,
    metric_id: metric.metric_id,
  };
}

function canonicalProfileEvidence(item) {
  return {
    kind: item.kind,
    dimension: item.dimension,
    status: item.status,
    evidence_refs: item.evidence_refs,
    metric_id: item.metric_id,
  };
}

function evidenceKey(item) {
  return `${item.metric_id}\u0000${item.dimension}\u0000${item.status}\u0000${item.evidence_refs.join("\u0000")}`;
}

function orderedEvidence(evidence) {
  const byKey = new Map();
  for (const item of evidence) byKey.set(evidenceKey(item), item);
  return [...byKey.values()].sort((left, right) => stableCompare(evidenceKey(left), evidenceKey(right)));
}

function dimensionRecord(dimension, evidence, missingStatus = "insufficient_evidence") {
  const matching = orderedEvidence(evidence.filter((item) => item.dimension === dimension));
  return {
    status: matching.some((item) => item.status === "measured")
      ? "measured"
      : matching.length > 0
        ? "inferred"
        : missingStatus,
    evidence: matching.map(canonicalProfileEvidence),
    evidence_refs: [...new Set(matching.flatMap((item) => item.evidence_refs))].sort(stableCompare),
  };
}

function notApplicableDimensions(profileId) {
  return Object.fromEntries(PROFILE_DIMENSIONS[profileId].map((dimension) => [
    dimension,
    { status: "not_applicable", evidence: [], evidence_refs: [] },
  ]));
}

function applicability(status, reason, evidenceRefs = []) {
  return { status, reason, evidence_refs: [...new Set(evidenceRefs)].sort(stableCompare) };
}

function decorateProfileResult(result) {
  return {
    ...result,
    profile_version: PROFILE_VERSION,
    profile_contract_hash: deriveProfileContractHash(result.profile_id),
  };
}

function bindingEvidence(snapshot, binding) {
  const candidates = [
    ...(Array.isArray(binding?.evidence) ? binding.evidence : []),
    ...(Array.isArray(binding?.evidence_bindings) ? binding.evidence_bindings : []),
  ];
  const evidence = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isNonBlankString(candidate.metric_id) || !isNonBlankString(candidate.dimension)) continue;
    const metric = uniqueMetric(snapshot, candidate.metric_id.trim());
    if (!observedSnapshotMetric(snapshot, metric)) continue;
    const requestedRefs = stringArray(candidate.evidence_refs, { minimum: 1 });
    if (requestedRefs === null) continue;
    const metricRefs = new Set(metricEvidenceRefs(metric));
    if (requestedRefs.some((reference) => !metricRefs.has(reference))) continue;
    if (candidate.status !== undefined && normalize(candidate.status) !== metric.measurement.status) continue;
    evidence.push({
      ...profileMetricEvidence(metric, normalize(candidate.dimension), requestedRefs),
      evidence_class: agileClassification(candidate),
      source_kind: metric.source.kind,
      collector_id: metric.source.collector_id,
      analyzer_identity: metric.analyzer_identity,
    });
  }
  return orderedEvidence(evidence);
}

function containsSpaceControl(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.some((item) => containsSpaceControl(item, seen));
  if (!isRecord(value) || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, candidate]) => {
    const normalized = normalizeKey(key);
    if (SPACE_COMPOSITE_CONTROL_KEYS.has(normalized)) return true;
    if (normalized === "evidence" || normalized === "evidence_bindings") return false;
    return containsSpaceControl(candidate, seen);
  });
}

function validateSpaceBinding(binding) {
  if (containsSpaceControl(binding)) {
    throw new Error("FAIL-SPACE-SINGLE-SCORE: SPACE dimensions cannot be collapsed into a composite score");
  }
  if (!isRecord(binding) || !Object.keys(binding).every((key) => SPACE_BINDING_FIELDS.has(normalizeKey(key)))) {
    throw new Error("FAIL-SPACE-SINGLE-SCORE: SPACE accepts only a dimensions-and-evidence binding");
  }
}

function humanFrameworkMetric(metric, profileId, dimension) {
  return (
    metric.definition_id === `sei.${profileId.toLowerCase()}.${dimension}@1` &&
    metric.family === "framework_profile" &&
    metric.source.kind === HUMAN_FRAMEWORK_AUTHORITY.source_kind &&
    metric.source.collector_id === HUMAN_FRAMEWORK_AUTHORITY.collector_id &&
    metric.analyzer_identity === HUMAN_FRAMEWORK_AUTHORITY.analyzer_identity
  );
}

function typedFrameworkMetric(metric, profileId, dimension) {
  return (
    metric.definition_id === `sei.${profileId.toLowerCase()}.${dimension}@1` &&
    metric.family === "framework_profile" &&
    metric.source.kind === "typed-adapter"
  );
}

function sourceMetric(snapshot, item) {
  return uniqueMetric(snapshot, item.metric_id);
}

function evaluateDora(snapshot) {
  const evidence = [];
  for (const dimension of PROFILE_DIMENSIONS.DORA) {
    const metric = uniqueMetric(snapshot, DORA_DIMENSION_CONTRACTS[dimension].metric_id);
    if (metricMatchesContract(snapshot, metric, DORA_DIMENSION_CONTRACTS[dimension], DORA_AUTHORITY, { rejectMergeProvenance: true })) {
      evidence.push(profileMetricEvidence(metric, dimension));
    }
  }
  const dimensions = Object.fromEntries(PROFILE_DIMENSIONS.DORA.map((dimension) => [
    dimension,
    dimensionRecord(dimension, evidence),
  ]));
  const complete = PROFILE_DIMENSIONS.DORA.every((dimension) => dimensions[dimension].status === "measured" || dimensions[dimension].status === "inferred");
  const refs = evidence.flatMap((item) => item.evidence_refs);
  return {
    profile_id: "DORA",
    applicability: applicability(
      complete ? "applicable" : "insufficient_evidence",
      complete
        ? "five separate DORA dimensions are bound to typed authoritative deployment measurements"
        : "all five DORA dimensions require typed authoritative deployment measurements; Git merges and generic deployment facts do not qualify",
      refs,
    ),
    dimensions,
    failure_codes: complete ? [] : ["FAIL-DORA-WITHOUT-TYPED-AUTHORITATIVE-DEPLOYMENT-EVIDENCE"],
  };
}

function resolveScrumAdoption(snapshot, binding) {
  const adoption = binding?.adoption;
  if (!isRecord(adoption)) return null;
  if (normalize(adoption.status) !== "current" || adoption.explicit !== true || normalize(adoption.framework) !== "scrum") return null;
  if (!isNonBlankString(adoption.metric_id)) return null;
  const metric = uniqueMetric(snapshot, adoption.metric_id.trim());
  if (!metricMatchesContract(snapshot, metric, SCRUM_ADOPTION_CONTRACT, HUMAN_FRAMEWORK_AUTHORITY)) return null;
  const suppliedRefs = stringArray(adoption.evidence_refs, { minimum: 1 });
  const metricRefs = new Set(metricEvidenceRefs(metric));
  if (suppliedRefs === null || suppliedRefs.some((reference) => !metricRefs.has(reference))) return null;
  return metric;
}

function evaluateScrum(snapshot, binding) {
  const adoption = resolveScrumAdoption(snapshot, binding);
  if (!adoption) {
    return {
      profile_id: "Scrum",
      applicability: applicability("not_applicable", "only current explicit Scrum adoption binds this alignment view"),
      dimensions: notApplicableDimensions("Scrum"),
      failure_codes: ["FAIL-FRAMEWORK-WITHOUT-APPLICABILITY"],
    };
  }
  const evidence = PROFILE_DIMENSIONS.Scrum.flatMap((dimension) => [profileMetricEvidence(adoption, dimension)]);
  return {
    profile_id: "Scrum",
    applicability: applicability(
      "applicable",
      "current explicit Scrum adoption is snapshot-bound; this is not a conformance grade",
      metricEvidenceRefs(adoption),
    ),
    dimensions: Object.fromEntries(PROFILE_DIMENSIONS.Scrum.map((dimension) => [dimension, dimensionRecord(dimension, evidence)])),
    failure_codes: [],
  };
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
  const milliseconds = civilClock.getTime() - offsetMilliseconds + fractionalMilliseconds;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function hasOnlyFields(value, fields) {
  return isRecord(value) && Object.keys(value).every((field) => fields.has(field));
}

function resolveKanbanWorkflow(snapshot, binding) {
  const workflow = binding?.definition_of_workflow;
  const fields = new Set([
    "metric_id", "identified", "start_event", "finish_event", "active_states", "as_of", "window_start", "window_end", "evidence_refs",
  ]);
  if (!hasOnlyFields(workflow, fields) || workflow.identified !== true || !isNonBlankString(workflow.metric_id)) return null;
  const metric = uniqueMetric(snapshot, workflow.metric_id.trim());
  if (!metricMatchesContract(snapshot, metric, KANBAN_WORKFLOW_CONTRACT, KANBAN_AUTHORITY)) return null;
  const suppliedRefs = stringArray(workflow.evidence_refs, { minimum: 1 });
  const metricRefs = new Set(metricEvidenceRefs(metric));
  const start = isNonBlankString(workflow.start_event) ? normalize(workflow.start_event) : null;
  const finish = isNonBlankString(workflow.finish_event) ? normalize(workflow.finish_event) : null;
  const activeStates = stringArray(workflow.active_states, { minimum: 1 });
  const active = activeStates === null ? null : new Set(activeStates.map(normalize));
  const asOf = parseTimestamp(workflow.as_of);
  const windowStart = parseTimestamp(workflow.window_start);
  const windowEnd = parseTimestamp(workflow.window_end);
  if (
    suppliedRefs === null || suppliedRefs.some((reference) => !metricRefs.has(reference)) ||
    !start || !finish || start === finish || active === null || !active.has(start) || active.has(finish) ||
    asOf === null || windowStart === null || windowEnd === null || windowStart > windowEnd || windowEnd > asOf
  ) return null;
  return { metric, start, finish, active, as_of: asOf, window_start: windowStart, window_end: windowEnd };
}

function resolveKanbanTransitions(snapshot, binding, workflow) {
  const fields = new Set(["work_item_id", "from", "to", "occurred_at", "evidence_refs"]);
  if (!isNonBlankString(binding?.transition_metric_id) || !Array.isArray(binding?.transitions) || binding.transitions.length === 0) return null;
  const metric = uniqueMetric(snapshot, binding.transition_metric_id.trim());
  if (!metricMatchesContract(snapshot, metric, KANBAN_TRANSITION_CONTRACT, KANBAN_AUTHORITY)) return null;
  if (metric.value !== binding.transitions.length) return null;
  const metricRefs = new Set(metricEvidenceRefs(metric));
  const seen = new Set();
  const transitions = [];
  for (const candidate of binding.transitions) {
    if (!hasOnlyFields(candidate, fields) || !isNonBlankString(candidate.work_item_id) || !isNonBlankString(candidate.from) || !isNonBlankString(candidate.to)) return null;
    const from = normalize(candidate.from);
    const to = normalize(candidate.to);
    const occurredAt = parseTimestamp(candidate.occurred_at);
    const refs = stringArray(candidate.evidence_refs, { minimum: 1 });
    if (
      from === to || occurredAt === null || occurredAt > workflow.as_of || refs === null ||
      refs.some((reference) => !reference.startsWith("work-item-transition:") || !metricRefs.has(reference))
    ) return null;
    const transition = { work_item_id: candidate.work_item_id.trim(), from, to, occurred_at: occurredAt, evidence_refs: refs };
    const identity = `${transition.work_item_id}\u0000${transition.from}\u0000${transition.to}\u0000${transition.occurred_at}\u0000${refs.join("\u0000")}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    transitions.push(transition);
  }
  return {
    metric,
    records: transitions.sort((left, right) => (
      left.occurred_at - right.occurred_at ||
      stableCompare(left.work_item_id, right.work_item_id) ||
      stableCompare(left.from, right.from) ||
      stableCompare(left.to, right.to)
    )),
  };
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function deriveKanbanDimensions(transitions, workflow) {
  const byItem = new Map();
  for (const transition of transitions) {
    const records = byItem.get(transition.work_item_id) ?? [];
    records.push(transition);
    byItem.set(transition.work_item_id, records);
  }
  const completedItems = new Set();
  const cycleTimes = [];
  const ages = [];
  let wip = 0;
  for (const records of byItem.values()) {
    let activeStartedAt = null;
    let currentState = null;
    for (const transition of records) {
      currentState = transition.to;
      if (transition.to === workflow.start) activeStartedAt = transition.occurred_at;
      if (transition.to === workflow.finish) {
        if (transition.occurred_at >= workflow.window_start && transition.occurred_at <= workflow.window_end) {
          completedItems.add(transition.work_item_id);
          if (activeStartedAt !== null && transition.occurred_at >= activeStartedAt) {
            cycleTimes.push(transition.occurred_at - activeStartedAt);
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
    throughput: completedItems.size,
    work_item_age: median(ages),
    cycle_time: median(cycleTimes),
  };
}

function adapterKanbanEvidence(snapshot) {
  const workflow = uniqueMetric(snapshot, KANBAN_WORKFLOW_CONTRACT.metric_id);
  const transitions = uniqueMetric(snapshot, KANBAN_TRANSITION_CONTRACT.metric_id);
  const workflowBound = metricMatchesContract(snapshot, workflow, KANBAN_WORKFLOW_CONTRACT, KANBAN_AUTHORITY, { expectedValue: 1 });
  const transitionsBound = metricMatchesContract(snapshot, transitions, KANBAN_TRANSITION_CONTRACT, KANBAN_AUTHORITY) &&
    Number.isSafeInteger(transitions?.value) && transitions.value >= 0;
  return { workflow, transitions, workflow_bound: workflowBound, transitions_bound: transitionsBound };
}

function evaluateKanban(snapshot, binding) {
  const workflow = resolveKanbanWorkflow(snapshot, binding);
  const transitions = workflow ? resolveKanbanTransitions(snapshot, binding, workflow) : null;
  const calculated = transitions ? deriveKanbanDimensions(transitions.records, workflow) : null;
  const suppliedTypedWorkflow = isRecord(binding) && ["definition_of_workflow", "transition_metric_id", "transitions"]
    .some((field) => Object.hasOwn(binding, field));
  // Adapter-generated Kanban metrics can stand alone, but an explicitly supplied
  // typed workflow binding is a request to validate that exact workflow. Do not
  // discard an invalid timestamp or transition chain and silently fall back to
  // independently stored aggregate metrics.
  const adapterEvidence = workflow && transitions ? null : suppliedTypedWorkflow ? null : adapterKanbanEvidence(snapshot);
  const evidence = [];
  const missingDimensionEvidence = [];
  for (const dimension of PROFILE_DIMENSIONS.Kanban) {
    const metric = uniqueMetric(snapshot, KANBAN_DIMENSION_CONTRACTS[dimension].metric_id);
    if (
      workflow && transitions && calculated[dimension] !== null &&
      metricMatchesContract(snapshot, metric, KANBAN_DIMENSION_CONTRACTS[dimension], KANBAN_AUTHORITY, { expectedValue: calculated[dimension] })
    ) {
      evidence.push(
        profileMetricEvidence(workflow.metric, dimension),
        profileMetricEvidence(transitions.metric, dimension),
        profileMetricEvidence(metric, dimension),
      );
    } else if (
      adapterEvidence?.workflow_bound && adapterEvidence.transitions_bound &&
      metricMatchesContract(snapshot, metric, KANBAN_DIMENSION_CONTRACTS[dimension], KANBAN_AUTHORITY)
    ) {
      evidence.push(
        profileMetricEvidence(adapterEvidence.workflow, dimension),
        profileMetricEvidence(adapterEvidence.transitions, dimension),
        profileMetricEvidence(metric, dimension),
      );
    } else {
      missingDimensionEvidence.push(dimension);
    }
  }
  const dimensions = Object.fromEntries(PROFILE_DIMENSIONS.Kanban.map((dimension) => [
    dimension,
    dimensionRecord(dimension, evidence),
  ]));
  const complete = missingDimensionEvidence.length === 0;
  const failureCodes = [
    ...(workflow || adapterEvidence?.workflow_bound ? [] : ["FAIL-KANBAN-WITHOUT-DEFINITION-OF-WORKFLOW"]),
    ...((workflow && !transitions) || (!workflow && adapterEvidence?.workflow_bound && !adapterEvidence.transitions_bound)
      ? ["FAIL-KANBAN-WITHOUT-TYPED-TRANSITIONS"]
      : []),
    ...((workflow && transitions && !complete) || (!workflow && adapterEvidence?.workflow_bound && adapterEvidence.transitions_bound && !complete)
      ? ["FAIL-KANBAN-TYPED-TRANSITION-CALCULATION-MISMATCH"]
      : []),
  ];
  return {
    profile_id: "Kanban",
    applicability: applicability(
      complete ? "applicable" : "insufficient_evidence",
      complete
        ? "Definition of Workflow and typed transition calculations bind every Kanban dimension"
        : "WIP, throughput, work-item age, and cycle time require an explicit Definition of Workflow plus typed transition calculations",
      evidence.flatMap((item) => item.evidence_refs),
    ),
    dimensions,
    failure_codes: failureCodes,
  };
}

function evaluateSpace(snapshot, binding) {
  validateSpaceBinding(binding);
  const evidence = bindingEvidence(snapshot, binding).filter((item) => {
    if (!PROFILE_DIMENSIONS.SPACE.includes(item.dimension)) return false;
    const metric = sourceMetric(snapshot, item);
    if (SPACE_HUMAN_ONLY_DIMENSIONS.has(item.dimension)) return humanFrameworkMetric(metric, "SPACE", item.dimension);
    // A caller may explicitly bind Activity to any observed snapshot metric;
    // the evaluator never infers it from commits or other repository activity.
    if (item.dimension === "activity") return true;
    if (SPACE_TYPED_DIMENSIONS.has(item.dimension)) return typedFrameworkMetric(metric, "SPACE", item.dimension) || humanFrameworkMetric(metric, "SPACE", item.dimension);
    return false;
  });
  const dimensions = Object.fromEntries(PROFILE_DIMENSIONS.SPACE.map((dimension) => [
    dimension,
    dimensionRecord(dimension, evidence, "unobservable"),
  ]));
  return {
    profile_id: "SPACE",
    applicability: applicability("applicable", "SPACE dimensions are independent and never collapse to a single score", evidence.flatMap((item) => item.evidence_refs)),
    dimensions,
    failure_codes: [],
  };
}

function agileClassification(item) {
  const values = Object.entries(item ?? {})
    .filter(([key]) => AGILE_CLASSIFICATION_FIELDS.has(normalizeKey(key)))
    .map(([, value]) => value);
  if (values.length === 0 || values.some((value) => !isNonBlankString(value))) return null;
  const classifications = values.map(normalize);
  if (new Set(classifications).size !== 1) return null;
  return classifications[0] === "machine" || classifications[0] === "human" ? classifications[0] : null;
}

function evaluateAgile(snapshot, binding) {
  const classified = bindingEvidence(snapshot, binding).filter((item) => {
    if (!PROFILE_DIMENSIONS.Agile.includes(item.dimension) || item.evidence_class === null) return false;
    const metric = sourceMetric(snapshot, item);
    if (AGILE_HUMAN_ONLY_DIMENSIONS.has(item.dimension)) {
      return item.evidence_class === "human" && humanFrameworkMetric(metric, "Agile", item.dimension);
    }
    return item.evidence_class === "machine" && typedFrameworkMetric(metric, "Agile", item.dimension);
  });
  const machine = classified.filter((item) => item.evidence_class === "machine");
  const human = classified.filter((item) => item.evidence_class === "human");
  const evidence = [...machine, ...human];
  const unobservable = PROFILE_DIMENSIONS.Agile.filter((dimension) => !evidence.some((item) => item.dimension === dimension));
  return {
    profile_id: "Agile",
    applicability: applicability("applicable", "Agile is an evidence-limited alignment view, not a conformance or trust score", evidence.flatMap((item) => item.evidence_refs)),
    dimensions: Object.fromEntries(PROFILE_DIMENSIONS.Agile.map((dimension) => [dimension, dimensionRecord(dimension, evidence, "unobservable")])),
    evidence: {
      machine: machine.map(({ evidence_class, source_kind, collector_id, analyzer_identity, ...item }) => item),
      human: human.map(({ evidence_class, source_kind, collector_id, analyzer_identity, ...item }) => item),
      unobservable,
    },
    failure_codes: [],
  };
}

function evaluateEngThrive(snapshot, binding) {
  const individual = normalize(binding?.scope?.kind ?? binding?.scope) === "individual";
  const evidence = bindingEvidence(snapshot, binding).filter((item) => PROFILE_DIMENSIONS.EngThrive.includes(item.dimension));
  return {
    profile_id: "EngThrive",
    maturity: "experimental",
    guidance: "advisory",
    scope: "system",
    applicability: applicability(
      individual ? "not_applicable" : "applicable",
      individual ? "EngThrive is restricted to system-level use" : "experimental system-level advisory profile",
      individual ? [] : evidence.flatMap((item) => item.evidence_refs),
    ),
    dimensions: individual
      ? notApplicableDimensions("EngThrive")
      : Object.fromEntries(PROFILE_DIMENSIONS.EngThrive.map((dimension) => [dimension, dimensionRecord(dimension, evidence, "unobservable")])),
    failure_codes: individual ? ["FAIL-FRAMEWORK-WITHOUT-APPLICABILITY"] : [],
  };
}

function evaluateProfiles(snapshot = {}, profileBindings = []) {
  const requested = Array.isArray(profileBindings) && profileBindings.length > 0
    ? profileBindings
    : Object.keys(PROFILE_DIMENSIONS).map((profile_id) => ({ profile_id }));
  const result = {};
  const seenProfiles = new Set();
  for (const supplied of requested) {
    const binding = typeof supplied === "string" ? { profile_id: supplied } : supplied;
    const profile = canonicalProfile(binding);
    if (!profile) throw new Error("FAIL-FRAMEWORK-WITHOUT-APPLICABILITY: unknown profile binding");
    if (seenProfiles.has(profile)) throw new Error(`FAIL-FRAMEWORK-WITHOUT-APPLICABILITY: duplicate profile binding ${profile}`);
    seenProfiles.add(profile);
    if (profile === "DORA") result.DORA = decorateProfileResult(evaluateDora(snapshot));
    else if (profile === "Scrum") result.Scrum = decorateProfileResult(evaluateScrum(snapshot, binding));
    else if (profile === "Kanban") result.Kanban = decorateProfileResult(evaluateKanban(snapshot, binding));
    else if (profile === "SPACE") result.SPACE = decorateProfileResult(evaluateSpace(snapshot, binding));
    else if (profile === "Agile") result.Agile = decorateProfileResult(evaluateAgile(snapshot, binding));
    else if (profile === "EngThrive") result.EngThrive = decorateProfileResult(evaluateEngThrive(snapshot, binding));
  }
  return result;
}

module.exports = { PROFILE_DIMENSIONS, PROFILE_VERSION, deriveProfileContractHash, evaluateProfiles };
