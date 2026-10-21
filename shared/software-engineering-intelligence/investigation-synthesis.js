"use strict";

const { deriveRiskModelContractHash } = require("./intelligence-engine.js");
const { deriveInvestigationSignals } = require("./investigation-signals.js");
const { interpretEvidence } = require("./semantic-evidence.js");

const INVESTIGATION_SYNTHESIS_VERSION = "sei.investigation-synthesis@1";
const MODEL_ID = "engineering-investigation-signals-v1";
const INTERPRETATION_BOUNDARY = "bounded repository-relative engineering investigation signals only; not defect, architecture, priority, or health verdicts";
const SIGNAL_ORDER = Object.freeze([
  "high-complexity-high-churn",
  "high-centrality-repeated-modification",
  "weak-verification-high-change-pressure",
  "high-fan-in-concentrated-ownership",
  "cycle-growing-dependency-pressure",
  "duplication-simultaneous-change",
]);

function stableCompare(left, right) { return left === right ? 0 : left < right ? -1 : 1; }

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function refs(metric) {
  return [...new Set([
    ...(Array.isArray(metric?.source?.artifact_refs) ? metric.source.artifact_refs : []),
    ...(Array.isArray(metric?.source?.evidence_refs) ? metric.source.evidence_refs : []),
  ].filter((entry) => typeof entry === "string" && entry.length > 0))].sort(stableCompare).slice(0, 16);
}

function observationEvidence(metric, evidenceRefs) {
  const status = metric?.measurement?.status;
  if (status === "measured" && Number.isFinite(metric?.value)) {
    try {
      const evidence = interpretEvidence({
        value: metric.value,
        measurement: {
          status,
          completeness: metric.measurement.completeness,
          confidence: metric.measurement.confidence,
        },
        collector: {
          status: metric.measurement.completeness === 1 && metric.measurement.confidence === 1 ? "available" : "degraded",
          binding_valid: evidenceRefs.length > 0,
        },
        condition: { kind: "observed", code: null },
        source_metric_ids: [metric.metric_id],
        evidence_refs: evidenceRefs,
        exclusions: [],
      });
      if (evidence.state === "complete") return { status: "measured", value: evidence.value };
      if (evidence.state === "strong-partial") {
        return {
          status: "degraded",
          value: evidence.value,
          coverage: evidence.coverage,
          confidence: evidence.confidence,
          semantic_state: evidence.state,
        };
      }
      return { status: "degraded", value: null };
    } catch {
      return { status: "degraded", value: null };
    }
  }
  if (status === "unverifiable") return { status: "unverifiable", value: null };
  return { status: "unavailable", value: null };
}

function fileSubject(metric) {
  if (typeof metric?.subject === "string" && metric.subject.startsWith("file:")) return metric.subject;
  if (typeof metric?.subject === "string" && metric.subject.startsWith("clone:")) return metric.subject;
  if (metric?.scope?.kind === "module" && typeof metric.scope.path === "string" && metric.scope.path !== ".") {
    return `file:${metric.scope.path}`;
  }
  return null;
}

function classify(metric) {
  const id = metric?.metric_id ?? "";
  if (/^static\.(?:(?:java|python|tsjs)\.)?cyclomatic_complexity:[^:]/.test(id) && !id.includes("_max:")) return "complexity_percentile";
  if (/^git\.observed_text_churn:/.test(id)) return "churn_percentile";
  if (/^git\.change_frequency:/.test(id)) return "change_frequency_percentile";
  if (/^git\.observed_touch_ownership_concentration:/.test(id)) return "ownership_concentration_percentile";
  if (/^static\.dependency\.page_rank:/.test(id)) return "centrality_percentile";
  if (/^static\.dependency\.fan_in:/.test(id)) return "fan_in_percentile";
  if (/^static\.(?:tsjs\.)?dependency\.cycle_participation:/.test(id)) return "cycle_participation";
  if (/^static\.(?:tsjs\.)?dependency\.dependency_growth:/.test(id)) return "dependency_growth_percentile";
  if (/^static\.duplication\.(?:clone_family|family)_percentage:/.test(id)) return "duplication_percentile";
  if (/^git\.observed_(?:co_change|cochange)(?:_count)?:/.test(id)) return "cochange_percentile";
  return null;
}

function metricLanguage(metric) {
  if (typeof metric?.scope?.language === "string" && metric.scope.language.trim().length > 0) {
    return metric.scope.language.trim().toLowerCase();
  }
  const match = /^static\.(java|python|tsjs)\./.exec(metric?.metric_id ?? "");
  return match?.[1] ?? null;
}

function candidatePreference(candidate) {
  return [
    candidate.status === "measured" ? 2 : candidate.status === "degraded" ? 1 : 0,
    candidate.language === null ? 0 : 1,
  ];
}

function selectCandidates(candidates) {
  const selected = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.subject}\0${candidate.kind}`;
    const current = selected.get(key);
    if (current === undefined) {
      selected.set(key, candidate);
      continue;
    }
    const left = candidatePreference(candidate);
    const right = candidatePreference(current);
    if (left[0] > right[0] || (left[0] === right[0] && left[1] > right[1])
        || (left[0] === right[0] && left[1] === right[1] && stableCompare(candidate.metric_id, current.metric_id) < 0)) {
      selected.set(key, candidate);
    }
  }
  return [...selected.values()].sort((left, right) => (
    stableCompare(left.kind, right.kind) || stableCompare(left.subject, right.subject) || stableCompare(left.metric_id, right.metric_id)
  ));
}

function percentile(value, cohort) {
  if (cohort.length === 1) return 0.5;
  let below = 0;
  let equal = 0;
  for (const candidate of cohort) {
    if (candidate.raw_value < value) below += 1;
    else if (candidate.raw_value === value) equal += 1;
  }
  const midpointRank = below + ((equal - 1) / 2);
  return Number((midpointRank / (cohort.length - 1)).toFixed(8));
}

function contextualize(candidates) {
  const observed = candidates.filter((candidate) => Number.isFinite(candidate.raw_value));
  const byKind = new Map();
  const byKindAndLanguage = new Map();
  for (const candidate of observed) {
    if (!byKind.has(candidate.kind)) byKind.set(candidate.kind, []);
    byKind.get(candidate.kind).push(candidate);
    const languageKey = `${candidate.kind}\0${candidate.language ?? ""}`;
    if (!byKindAndLanguage.has(languageKey)) byKindAndLanguage.set(languageKey, []);
    byKindAndLanguage.get(languageKey).push(candidate);
  }
  return candidates.map((candidate) => {
    if (!Number.isFinite(candidate.raw_value)) {
      return { ...candidate, repository_percentile: null, within_language_percentile: null };
    }
    if (candidate.kind === "cycle_participation") {
      return {
        ...candidate,
        repository_percentile: candidate.raw_value,
        within_language_percentile: candidate.raw_value,
      };
    }
    const repositoryPercentile = percentile(candidate.raw_value, byKind.get(candidate.kind));
    const languageCohort = byKindAndLanguage.get(`${candidate.kind}\0${candidate.language ?? ""}`);
    const withinLanguagePercentile = percentile(candidate.raw_value, languageCohort);
    return {
      ...candidate,
      repository_percentile: repositoryPercentile,
      within_language_percentile: withinLanguagePercentile,
    };
  });
}

function verificationObservation(metrics) {
  const candidates = metrics
    .filter((metric) => /^verification\./.test(metric?.metric_id ?? ""))
    .map((metric) => {
      const evidenceRefs = refs(metric);
      const evidence = observationEvidence(metric, evidenceRefs);
      return {
        metric_id: metric.metric_id,
        ...evidence,
        value: Number.isFinite(evidence.value) ? Math.max(0, Math.min(1, metric.measurement.confidence)) : null,
        evidence_refs: evidenceRefs,
      };
    })
    .filter((candidate) => candidate.evidence_refs.length > 0);
  const statusOrder = { measured: 3, degraded: 2, unverifiable: 1, unavailable: 0 };
  candidates.sort((left, right) => (
    statusOrder[right.status] - statusOrder[left.status]
    || (right.value ?? -1) - (left.value ?? -1)
    || stableCompare(left.metric_id, right.metric_id)
  ));
  return candidates[0] ?? null;
}

function percentileLabel(value) {
  const percent = Number((value * 100).toFixed(2));
  return `P${percent}`;
}

function contextualInterpretation(record, contexts) {
  const details = [];
  for (const observation of record.observations) {
    const context = contexts.get(`${record.subject}\0${observation.kind}`);
    if (context === undefined) continue;
    if (!Number.isFinite(context.raw_value)) {
      details.push(`${observation.kind} ${context.status}`);
      continue;
    }
    const language = context.language === null ? "language unavailable" : `language ${context.language}`;
    const uncertainty = context.status === "degraded"
      ? `, ${context.semantic_state}, coverage ${context.coverage}, confidence ${context.confidence}` : "";
    details.push(
      `${observation.kind} raw ${context.raw_value}, ${language}, within-language ${percentileLabel(context.within_language_percentile)}, repository ${percentileLabel(context.repository_percentile)}${uncertainty}`,
    );
  }
  if (details.length === 0) return record.interpretation;
  return `Measured context: ${details.join("; ")}. ${record.interpretation}`;
}

function rankSignals(signals) {
  const subjectBreadth = new Map();
  for (const signal of signals) {
    if (!subjectBreadth.has(signal.subject)) subjectBreadth.set(signal.subject, new Set());
    for (const observation of signal.observations) subjectBreadth.get(signal.subject).add(observation.kind);
  }
  const strength = (signal) => signal.observations.reduce(
    (sum, observation) => sum + (Number.isFinite(observation.value) ? observation.value : 0.5),
    0,
  ) / signal.observations.length;
  return signals.slice().sort((left, right) => (
    subjectBreadth.get(right.subject).size - subjectBreadth.get(left.subject).size
    || (right.confidence === "high" ? 1 : 0) - (left.confidence === "high" ? 1 : 0)
    || strength(right) - strength(left)
    || SIGNAL_ORDER.indexOf(left.signal_type) - SIGNAL_ORDER.indexOf(right.signal_type)
    || stableCompare(left.subject, right.subject)
  ));
}

function buildInvestigationSignalRiskModel(snapshot) {
  if (!snapshot || !snapshot.repository || !/^[0-9a-f]{40}$/.test(snapshot.repository.revision ?? "") || !Array.isArray(snapshot.measurements)) {
    throw new Error("FAIL-INVESTIGATION-SYNTHESIS: snapshot binding is invalid");
  }
  const candidates = [];
  const subjectLanguageSets = new Map();
  for (const metric of snapshot.measurements) {
    const kind = classify(metric);
    const subject = fileSubject(metric);
    const metricRefs = refs(metric);
    if (kind === null || subject === null || metricRefs.length === 0) continue;
    const evidence = observationEvidence(metric, metricRefs);
    const language = metricLanguage(metric);
    if (language !== null) {
      if (!subjectLanguageSets.has(subject)) subjectLanguageSets.set(subject, new Set());
      subjectLanguageSets.get(subject).add(language);
    }
    candidates.push({
      kind,
      subject,
      raw_value: evidence.value,
      status: evidence.status,
      coverage: evidence.coverage,
      confidence: evidence.confidence,
      semantic_state: evidence.semantic_state,
      language,
      metric_id: metric.metric_id,
      evidence_refs: metricRefs,
    });
  }
  const subjectLanguages = new Map([...subjectLanguageSets.entries()].map(([subject, languages]) => {
    const ordered = [...languages].sort(stableCompare);
    return [subject, ordered.length === 1 ? ordered[0] : null];
  }));
  for (const candidate of candidates) {
    const inferredLanguage = subjectLanguages.get(candidate.subject);
    if (candidate.language === null && typeof inferredLanguage === "string") {
      candidate.language = inferredLanguage;
    }
  }
  const contextualCandidates = contextualize(selectCandidates(candidates));
  const candidateByObservation = new Map(contextualCandidates.map((candidate) => [`${candidate.subject}\0${candidate.kind}`, candidate]));
  const observations = contextualCandidates.map((candidate) => {
    const observation = {
      subject: candidate.subject,
      kind: candidate.kind,
      status: candidate.status,
      value: Number.isFinite(candidate.raw_value)
        ? candidate.language === null ? candidate.repository_percentile : candidate.within_language_percentile
        : null,
      evidence_refs: candidate.evidence_refs,
    };
    if (candidate.status === "degraded" && Number.isFinite(observation.value)) {
      observation.coverage = candidate.coverage;
      observation.confidence = candidate.confidence;
      observation.semantic_state = candidate.semantic_state;
    }
    return observation;
  });
  const changedSubjects = [...new Set(observations.filter((entry) => entry.kind === "change_frequency_percentile").map((entry) => entry.subject))].sort(stableCompare);
  const verification = verificationObservation(snapshot.measurements);
  if (verification) {
    for (const subject of changedSubjects) {
      const candidate = {
        kind: "verification_strength",
        subject,
        raw_value: verification.value,
        status: verification.status,
        coverage: verification.coverage,
        confidence: verification.confidence,
        semantic_state: verification.semantic_state,
        language: subjectLanguages.get(subject) ?? null,
        metric_id: verification.metric_id,
        evidence_refs: verification.evidence_refs,
        repository_percentile: null,
        within_language_percentile: null,
      };
      candidateByObservation.set(`${subject}\0verification_strength`, candidate);
      const observation = {
        subject,
        kind: candidate.kind,
        status: candidate.status,
        value: Number.isFinite(candidate.raw_value) ? candidate.raw_value : null,
        evidence_refs: candidate.evidence_refs,
      };
      if (candidate.status === "degraded" && Number.isFinite(observation.value)) {
        observation.coverage = candidate.coverage;
        observation.confidence = candidate.confidence;
        observation.semantic_state = candidate.semantic_state;
      }
      observations.push(observation);
    }
  }
  const derived = deriveInvestigationSignals({ repository_revision: snapshot.repository.revision, observations });
  const records = rankSignals(derived.signals.map((record) => ({
    ...record,
    interpretation: contextualInterpretation(record, candidateByObservation),
  })));
  const usedCandidates = records.flatMap((record) => record.observations.map((observation) => (
    candidateByObservation.get(`${record.subject}\0${observation.kind}`)
  ))).filter(Boolean);
  const metricIds = [...new Set(usedCandidates.map((candidate) => candidate.metric_id))].sort(stableCompare);
  const evidenceRefs = [...new Set(records.flatMap((record) => record.evidence_refs))].sort(stableCompare);
  const available = records.length > 0;
  return deepFreeze({
    risk_model_id: MODEL_ID,
    model_version: "1.0.0",
    model_contract_hash: deriveRiskModelContractHash(MODEL_ID),
    model_status: available ? "heuristic" : "unavailable",
    calibration: null,
    result: {
      result_id: `${MODEL_ID}:${snapshot.repository.revision}`,
      kind: "engineering_investigation_signals",
      status: available ? "available" : "unavailable",
      repository_revision: snapshot.repository.revision,
      evidence_metric_ids: available ? metricIds : [],
      evidence_refs: available ? evidenceRefs : [],
      interpretation_boundary: INTERPRETATION_BOUNDARY,
      records: available ? records : [],
    },
  });
}

module.exports = { INVESTIGATION_SYNTHESIS_VERSION, buildInvestigationSignalRiskModel };
