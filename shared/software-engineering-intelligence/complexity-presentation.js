"use strict";

const COMPLEXITY_PRESENTATION_VERSION = "sei.complexity-presentation@1";
const MAX_MEASUREMENTS = 100_000;
const MAX_PARTITIONS = 128;
const MAX_ITEMS_PER_GROUP = 20;
const MAX_TEXT = 512;
const OBSERVED_STATUSES = new Set(["measured", "inferred"]);
const MEASURE_ORDER = new Map([["cyclomatic", 0], ["cognitive", 1]]);
const GROUP_ORDER = new Map([
  ["workload", 0],
  ["typical", 1],
  ["complex_tail", 2],
  ["maximum", 3],
  ["file_concentration", 4],
  ["callable_outliers", 5],
  ["density", 6],
]);

function fail(detail) {
  const error = new Error(`FAIL-COMPLEXITY-PRESENTATION: ${detail}`);
  error.code = "FAIL-COMPLEXITY-PRESENTATION";
  throw error;
}

function stableCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function boundedText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT
    && !value.includes("\0") && !/[\r\n]/.test(value);
}

function readSnapshot(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.measurements)) {
    fail("snapshot.measurements must be an array");
  }
  if (snapshot.measurements.length > MAX_MEASUREMENTS) {
    fail(`snapshot.measurements exceeds bounded limit of ${MAX_MEASUREMENTS}`);
  }
  snapshot.measurements.forEach((measurement, index) => {
    if (!isRecord(measurement)) fail(`snapshot.measurements[${index}] must be a plain record`);
  });
  return snapshot.measurements;
}

function metricBase(metricId) {
  const colon = metricId.indexOf(":");
  return colon === -1 ? metricId : metricId.slice(0, colon);
}

function metricSuffix(metricId) {
  const colon = metricId.indexOf(":");
  return colon === -1 ? null : metricId.slice(colon + 1);
}

function classifyComplexityMetric(metricId) {
  if (!boundedText(metricId)) return null;
  const match = metricBase(metricId).match(/^static(?:\.([a-z0-9-]+))?\.(cyclomatic|cognitive)_(complexity(?:_(p50|p90|max))?|callable_count|callable)$/);
  if (!match) return null;
  const [, namespace, measure, suffix, quantile] = match;
  const kind = suffix === "callable_count" ? "callable_count"
    : suffix === "callable" ? "callable_outlier"
      : quantile === "p50" ? "typical"
        : quantile === "p90" ? "complex_tail"
          : quantile === "max" ? "maximum"
            : "total";
  return { kind, measure, namespace: namespace ?? null };
}

function isSourceLinesMetric(metricId) {
  return boundedText(metricId) && metricBase(metricId) === "static.source_lines";
}

function normalizedLanguage(metric, classification = null) {
  const fromScope = metric.scope?.language;
  if (boundedText(fromScope)) return fromScope.toLowerCase();
  if (classification?.namespace !== null && classification?.namespace !== undefined) return classification.namespace;
  return null;
}

function exactFileKey(metric, language) {
  const scope = metric.scope;
  if (!isRecord(scope) || scope.kind !== "file" || !boundedText(scope.path) || !boundedText(language)) return null;
  if (!boundedText(metric.repository_revision)) return null;
  return `${language}\0${scope.path}\0${metric.repository_revision}`;
}

function partitionId(metric) {
  const suffix = metricSuffix(metric.metric_id);
  if (suffix === null || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(suffix)) return "repository";
  return suffix;
}

function acceptedScope(metric) {
  return metric.scope?.generated_code !== true && metric.scope?.included_in_human_maintainability !== false;
}

function metricObservation(metric) {
  const measurement = metric.measurement;
  if (!isRecord(measurement) || !boundedText(measurement.status)) {
    fail(`canonical measurement ${metric.metric_id} has no valid measurement status`);
  }
  const status = measurement.status;
  if (!OBSERVED_STATUSES.has(status)) {
    return {
      confidence: null,
      coverage: null,
      state: status,
      status,
      usable: false,
      value: null,
    };
  }
  if (!Number.isFinite(metric.value)) fail(`observed canonical measurement ${metric.metric_id} must be finite`);
  if (!Number.isFinite(measurement.completeness) || measurement.completeness < 0 || measurement.completeness > 1) {
    fail(`observed canonical measurement ${metric.metric_id} has invalid completeness`);
  }
  if (!Number.isFinite(measurement.confidence) || measurement.confidence < 0 || measurement.confidence > 1) {
    fail(`observed canonical measurement ${metric.metric_id} has invalid confidence`);
  }
  if (measurement.completeness === 0 || measurement.confidence === 0) {
    fail(`observed canonical measurement ${metric.metric_id} must have positive completeness and confidence`);
  }
  return {
    confidence: measurement.confidence,
    coverage: measurement.completeness,
    state: status === "inferred" ? "inferred" : measurement.completeness < 1 || measurement.confidence < 1 ? "partial" : "measured",
    status,
    usable: true,
    value: metric.value,
  };
}

function languageLabel(language) {
  const labels = {
    javascript: "JavaScript",
    java: "Java",
    kotlin: "Kotlin",
    python: "Python",
    tsjs: "TypeScript/JavaScript",
    typescript: "TypeScript",
  };
  return labels[language] ?? language.replace(/(^|[-_])(\w)/g, (_match, prefix, character) => `${prefix === "-" || prefix === "_" ? " " : ""}${character.toUpperCase()}`);
}

function partitionLabel(partition) {
  if (partition === "observed-files") return "observed files";
  if (partition === "repository") return "repository";
  return partition.replaceAll("-", " ");
}

function evidenceValue(metric, observation, role) {
  return {
    confidence: observation.confidence,
    coverage: observation.coverage,
    metric_id: metric.metric_id,
    role,
    state: observation.state,
    unit: metric.unit ?? null,
    value: observation.value,
  };
}

function evidenceState(observed, unavailable) {
  if (observed.length === 0) {
    const states = [...new Set(unavailable.map((entry) => entry.state))].sort(stableCompare);
    return states.length === 1 ? states[0] : states.length === 0 ? "unavailable" : "mixed-non-observation";
  }
  if (unavailable.length > 0 || observed.some((entry) => entry.state === "partial")) return "partial";
  if (observed.every((entry) => entry.state === "inferred")) return "inferred";
  return "measured";
}

function evidenceMetadata(observed, unavailable) {
  if (observed.length === 0) {
    return {
      confidence: null,
      coverage: null,
      unavailable_metric_ids: unavailable.map((entry) => entry.metric_id).sort(stableCompare),
    };
  }
  return {
    confidence: Math.min(...observed.map((entry) => entry.confidence)),
    coverage: Math.min(...observed.map((entry) => entry.coverage)),
    unavailable_metric_ids: unavailable.map((entry) => entry.metric_id).sort(stableCompare),
  };
}

function certaintySentence(state, coverage, confidence) {
  if (state !== "partial" || coverage === null || confidence === null) return "";
  return ` Partial analyzer coverage: ${rounded(coverage * 100)}% coverage and ${rounded(confidence * 100)}% confidence.`;
}

function group({ kind, measure, observed, unavailable, values = [], items = [], joinedFileCount = null, summary }) {
  const state = evidenceState(observed, unavailable);
  const metadata = evidenceMetadata(observed, unavailable);
  return {
    kind,
    label: {
      callable_outliers: "Callable outliers",
      complex_tail: "Complex tail (P90)",
      density: "Complexity density",
      file_concentration: "File concentration",
      maximum: "Maximum",
      typical: "Typical callable (P50)",
      workload: "Workload",
    }[kind],
    state,
    coverage: metadata.coverage,
    confidence: metadata.confidence,
    unavailable_metric_ids: metadata.unavailable_metric_ids,
    values,
    items,
    ...(joinedFileCount === null ? {} : { joined_file_count: joinedFileCount }),
    summary: `${summary}${certaintySentence(state, metadata.coverage, metadata.confidence)}`,
  };
}

function measureName(measure) {
  return measure === "cyclomatic" ? "Cyclomatic" : "Cognitive";
}

function groupSummary(kind, measure, language, partition, observed, unavailable, options = {}) {
  const name = measureName(measure);
  const context = `${languageLabel(language)} / ${partitionLabel(partition)}`;
  if (observed.length === 0) return `${name} ${kind.replaceAll("_", " ")} is ${evidenceState(observed, unavailable)} for ${context}.`;
  if (kind === "workload") {
    const count = observed.find((entry) => entry.role === "callable_count")?.value ?? null;
    const total = observed.find((entry) => entry.role === "total")?.value ?? null;
    if (count !== null && total !== null) return `Across ${count} callables, ${name.toLowerCase()} workload totals ${total} points for ${context}.`;
    if (total !== null) return `${name} workload totals ${total} points for ${context}.`;
    return `${count} callables are represented in ${name.toLowerCase()} workload evidence for ${context}.`;
  }
  const value = observed[0]?.value;
  if (kind === "typical") return `Typical callable ${name.toLowerCase()} complexity (P50) is ${value} points for ${context}.`;
  if (kind === "complex_tail") return `Complex-tail callable ${name.toLowerCase()} complexity (P90) is ${value} points for ${context}.`;
  if (kind === "maximum") return `Maximum observed callable ${name.toLowerCase()} complexity is ${value} points for ${context}.`;
  if (kind === "file_concentration") return `${options.itemCount ?? 0} observed file totals are shown for ${name.toLowerCase()} complexity in ${context}.`;
  if (kind === "callable_outliers") return `${options.itemCount ?? 0} highest observed callable values are shown for ${name.toLowerCase()} complexity in ${context}.`;
  return `${options.joinedFileCount ?? 0} exact file-to-line joins support ${name.toLowerCase()} complexity density in ${context}.`;
}

function aggregationKey(language, partition, measure) {
  return `${language}\0${partition}\0${measure}`;
}

function emptyAggregate(language, partition, measure) {
  return {
    language,
    measure,
    partition_id: partition,
    records: {
      callable_count: [],
      complex_tail: [],
      maximum: [],
      total: [],
      typical: [],
    },
  };
}

function insertAggregate(aggregates, language, partition, measure, kind, metric, observation) {
  const key = aggregationKey(language, partition, measure);
  const aggregate = aggregates.get(key) ?? emptyAggregate(language, partition, measure);
  aggregate.records[kind].push({
    ...evidenceValue(metric, observation, kind),
    metric_id: metric.metric_id,
    usable: observation.usable,
  });
  aggregates.set(key, aggregate);
}

function fileKey(language, measure) {
  return `${language}\0${measure}`;
}

function emptyFileAggregate(language, measure) {
  return { callables: [], files: [], language, measure };
}

function insertFileMetric(fileAggregates, language, measure, kind, metric, observation) {
  const key = fileKey(language, measure);
  const aggregate = fileAggregates.get(key) ?? emptyFileAggregate(language, measure);
  const entry = {
    confidence: observation.confidence,
    coverage: observation.coverage,
    metric_id: metric.metric_id,
    path: metric.scope.path,
    state: observation.state,
    subject: boundedText(metric.subject) ? metric.subject : null,
    unit: metric.unit ?? null,
    value: observation.value,
    usable: observation.usable,
    repository_revision: metric.repository_revision,
  };
  aggregate[kind].push(entry);
  fileAggregates.set(key, aggregate);
}

function appendSourceLines(linesByFile, metric, observation, language) {
  const key = exactFileKey(metric, language);
  if (key === null) return;
  const entries = linesByFile.get(key) ?? [];
  entries.push({
    confidence: observation.confidence,
    coverage: observation.coverage,
    metric_id: metric.metric_id,
    state: observation.state,
    usable: observation.usable,
    value: observation.value,
  });
  linesByFile.set(key, entries);
}

function splitEvidence(entries) {
  const observed = entries.filter((entry) => entry.usable);
  const unavailable = entries.filter((entry) => !entry.usable);
  return { observed, unavailable };
}

function canonicalEvidence(entries) {
  return [...entries].sort((left, right) => stableCompare(left.metric_id, right.metric_id));
}

function aggregateGroups(aggregate) {
  const groups = [];
  const workloadEntries = canonicalEvidence([...aggregate.records.callable_count, ...aggregate.records.total]);
  if (workloadEntries.length > 0) {
    const split = splitEvidence(workloadEntries);
    const values = split.observed.map(({ usable, ...entry }) => entry).sort((left, right) => (
      stableCompare(left.role, right.role) || stableCompare(left.metric_id, right.metric_id)
    ));
    groups.push(group({
      kind: "workload",
      measure: aggregate.measure,
      observed: split.observed,
      unavailable: split.unavailable,
      values,
      summary: groupSummary("workload", aggregate.measure, aggregate.language, aggregate.partition_id, split.observed, split.unavailable),
    }));
  }
  for (const kind of ["typical", "complex_tail", "maximum"]) {
    const entries = canonicalEvidence(aggregate.records[kind]);
    if (entries.length === 0) continue;
    const split = splitEvidence(entries);
    const values = split.observed.map(({ usable, ...entry }) => entry);
    groups.push(group({
      kind,
      measure: aggregate.measure,
      observed: split.observed,
      unavailable: split.unavailable,
      values,
      summary: groupSummary(kind, aggregate.measure, aggregate.language, aggregate.partition_id, split.observed, split.unavailable),
    }));
  }
  return groups;
}

function sortItems(entries) {
  return [...entries].sort((left, right) => (
    right.value - left.value
    || stableCompare(left.path, right.path)
    || stableCompare(left.subject ?? "", right.subject ?? "")
    || stableCompare(left.metric_id, right.metric_id)
  )).slice(0, MAX_ITEMS_PER_GROUP);
}

function buildFileGroups(aggregate, linesByFile) {
  const groups = [];
  const fileSplit = splitEvidence(canonicalEvidence(aggregate.files));
  if (fileSplit.observed.length + fileSplit.unavailable.length > 0) {
    const items = sortItems(fileSplit.observed).map((entry) => ({
      confidence: entry.confidence,
      coverage: entry.coverage,
      metric_id: entry.metric_id,
      path: entry.path,
      state: entry.state,
      unit: entry.unit,
      value: entry.value,
    }));
    groups.push(group({
      kind: "file_concentration",
      measure: aggregate.measure,
      observed: fileSplit.observed,
      unavailable: fileSplit.unavailable,
      items,
      summary: groupSummary("file_concentration", aggregate.measure, aggregate.language, "observed-files", fileSplit.observed, fileSplit.unavailable, { itemCount: items.length }),
    }));
  }

  const callableSplit = splitEvidence(canonicalEvidence(aggregate.callables));
  if (callableSplit.observed.length + callableSplit.unavailable.length > 0) {
    const items = sortItems(callableSplit.observed).map((entry) => ({
      confidence: entry.confidence,
      coverage: entry.coverage,
      metric_id: entry.metric_id,
      path: entry.path,
      state: entry.state,
      subject: entry.subject,
      unit: entry.unit,
      value: entry.value,
    }));
    groups.push(group({
      kind: "callable_outliers",
      measure: aggregate.measure,
      observed: callableSplit.observed,
      unavailable: callableSplit.unavailable,
      items,
      summary: groupSummary("callable_outliers", aggregate.measure, aggregate.language, "observed-files", callableSplit.observed, callableSplit.unavailable, { itemCount: items.length }),
    }));
  }

  const joins = [];
  for (const file of fileSplit.observed) {
    const key = `${aggregate.language}\0${file.path}\0${file.repository_revision}`;
    const lineEntries = linesByFile.get(key) ?? [];
    if (lineEntries.length !== 1) continue;
    const lines = lineEntries[0];
    if (!lines.usable || lines.value <= 0) continue;
    joins.push({
      confidence: Math.min(file.confidence, lines.confidence),
      coverage: Math.min(file.coverage, lines.coverage),
      file_metric_id: file.metric_id,
      line_metric_id: lines.metric_id,
      metric_id: `${file.metric_id}|${lines.metric_id}`,
      path: file.path,
      points_per_100_lines: rounded((file.value / lines.value) * 100),
      source_lines: lines.value,
      state: file.state === "partial" || lines.state === "partial" ? "partial" : file.state === "inferred" || lines.state === "inferred" ? "inferred" : "measured",
      unit: "complexity-points-per-100-lines",
      value: (file.value / lines.value) * 100,
    });
  }
  if (joins.length > 0) {
    const sorted = sortItems(joins).map((entry) => ({
      confidence: entry.confidence,
      coverage: entry.coverage,
      file_metric_id: entry.file_metric_id,
      line_metric_id: entry.line_metric_id,
      path: entry.path,
      points_per_100_lines: entry.points_per_100_lines,
      source_lines: entry.source_lines,
      state: entry.state,
    }));
    const joinedObserved = joins.map((entry) => ({ ...entry, usable: true }));
    groups.push(group({
      kind: "density",
      measure: aggregate.measure,
      observed: joinedObserved,
      unavailable: [],
      items: sorted,
      joinedFileCount: joins.length,
      summary: groupSummary("density", aggregate.measure, aggregate.language, "observed-files", joinedObserved, [], { joinedFileCount: joins.length }),
    }));
  }
  return groups;
}

function renderPartition(language, partitionIdValue, measureGroups) {
  const measures = [...measureGroups.entries()].map(([measure, groups]) => ({
    measure,
    label: `${measureName(measure)} complexity`,
    groups: groups.sort((left, right) => GROUP_ORDER.get(left.kind) - GROUP_ORDER.get(right.kind)),
  })).sort((left, right) => MEASURE_ORDER.get(left.measure) - MEASURE_ORDER.get(right.measure));
  return {
    language,
    partition_id: partitionIdValue,
    label: `${languageLabel(language)} / ${partitionLabel(partitionIdValue)}`,
    measures,
  };
}

function deriveComplexityPresentation(snapshot) {
  const measurements = readSnapshot(snapshot);
  const aggregates = new Map();
  const fileAggregates = new Map();
  const linesByFile = new Map();

  for (const metric of measurements) {
    if (!acceptedScope(metric)) continue;
    const complexity = classifyComplexityMetric(metric.metric_id);
    if (complexity !== null) {
      const language = normalizedLanguage(metric, complexity);
      if (language === null) continue;
      const observation = metricObservation(metric);
      if (metric.scope?.kind === "repository" && Object.hasOwn(emptyAggregate(language, "repository", complexity.measure).records, complexity.kind)) {
        insertAggregate(aggregates, language, partitionId(metric), complexity.measure, complexity.kind, metric, observation);
      } else if (metric.scope?.kind === "file" && complexity.kind === "total") {
        insertFileMetric(fileAggregates, language, complexity.measure, "files", metric, observation);
      } else if (metric.scope?.kind === "file" && complexity.kind === "callable_outlier") {
        insertFileMetric(fileAggregates, language, complexity.measure, "callables", metric, observation);
      }
      continue;
    }
    if (!isSourceLinesMetric(metric.metric_id) || metric.scope?.kind !== "file") continue;
    const language = normalizedLanguage(metric);
    if (language === null) continue;
    appendSourceLines(linesByFile, metric, metricObservation(metric), language);
  }

  const partitionMeasures = new Map();
  for (const aggregate of aggregates.values()) {
    const groups = aggregateGroups(aggregate);
    if (groups.length === 0) continue;
    const key = `${aggregate.language}\0${aggregate.partition_id}`;
    const measures = partitionMeasures.get(key) ?? new Map();
    measures.set(aggregate.measure, groups);
    partitionMeasures.set(key, measures);
  }
  for (const aggregate of fileAggregates.values()) {
    const groups = buildFileGroups(aggregate, linesByFile);
    if (groups.length === 0) continue;
    const key = `${aggregate.language}\0observed-files`;
    const measures = partitionMeasures.get(key) ?? new Map();
    measures.set(aggregate.measure, groups);
    partitionMeasures.set(key, measures);
  }
  if (partitionMeasures.size > MAX_PARTITIONS) fail(`derived partition count exceeds bounded limit of ${MAX_PARTITIONS}`);

  const partitions = [...partitionMeasures.entries()].map(([key, measures]) => {
    const [language, partitionIdValue] = key.split("\0");
    return renderPartition(language, partitionIdValue, measures);
  }).sort((left, right) => (
    stableCompare(left.language, right.language) || stableCompare(left.partition_id, right.partition_id)
  ));

  return deepFreeze({
    complexity_presentation_version: COMPLEXITY_PRESENTATION_VERSION,
    partitions,
  });
}

module.exports = {
  COMPLEXITY_PRESENTATION_VERSION,
  deriveComplexityPresentation,
};
