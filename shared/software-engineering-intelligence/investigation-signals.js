"use strict";

const crypto = require("node:crypto");

const INVESTIGATION_SIGNAL_VERSION = "sei.investigation-signals@1";
const MAX_OBSERVATIONS = 100_000;
const MAX_SIGNALS = 25;
const MAX_GAPS = 50;
const MAX_EVIDENCE_REFS = 16;
const MAX_TEXT = 1024;
const OBSERVATION_STATUSES = new Set(["measured", "degraded", "unavailable", "unverifiable"]);
const OBSERVATION_KINDS = new Set([
  "centrality_percentile",
  "change_frequency_percentile",
  "churn_percentile",
  "cochange_percentile",
  "complexity_percentile",
  "cycle_participation",
  "dependency_growth_percentile",
  "duplication_percentile",
  "fan_in_percentile",
  "ownership_concentration_percentile",
  "verification_strength",
]);

const DEFINITIONS = Object.freeze([
  Object.freeze({
    signal_type: "high-complexity-high-churn",
    requirements: Object.freeze([
      Object.freeze({ kind: "complexity_percentile", minimum: 0.9 }),
      Object.freeze({ kind: "churn_percentile", minimum: 0.9 }),
    ]),
    interpretation: "The subject is observed near the repository's high end for both structural complexity and change churn; the intersection may concentrate investigation effort.",
    suggested_investigation: "Review the subject's responsibility boundaries, recent change history, and available verification evidence.",
  }),
  Object.freeze({
    signal_type: "high-centrality-repeated-modification",
    requirements: Object.freeze([
      Object.freeze({ kind: "centrality_percentile", minimum: 0.9 }),
      Object.freeze({ kind: "change_frequency_percentile", minimum: 0.9 }),
    ]),
    interpretation: "The subject is observed as structurally central and repeatedly modified relative to this repository; changes may affect a broad dependency surface.",
    suggested_investigation: "Inspect dependency consumers, recent modification reasons, and the verification protecting those consumers.",
  }),
  Object.freeze({
    signal_type: "weak-verification-high-change-pressure",
    requirements: Object.freeze([
      Object.freeze({ kind: "verification_strength", non_measured: true }),
      Object.freeze({ kind: "change_frequency_percentile", minimum: 0.9 }),
    ]),
    interpretation: "High relative change frequency is observed while trustworthy verification evidence is degraded, unavailable, or unverifiable.",
    suggested_investigation: "Investigate whether committed test or coverage evidence exists for the changed surface and whether it is current.",
  }),
  Object.freeze({
    signal_type: "high-fan-in-concentrated-ownership",
    requirements: Object.freeze([
      Object.freeze({ kind: "fan_in_percentile", minimum: 0.9 }),
      Object.freeze({ kind: "ownership_concentration_percentile", minimum: 0.75 }),
    ]),
    interpretation: "The subject has many observed dependents and concentrated observed ownership, which may concentrate knowledge around a broadly consumed surface.",
    suggested_investigation: "Review ownership continuity, documentation, and change-review coverage for this highly consumed subject.",
  }),
  Object.freeze({
    signal_type: "cycle-growing-dependency-pressure",
    requirements: Object.freeze([
      Object.freeze({ kind: "cycle_participation", minimum: 1 }),
      Object.freeze({ kind: "dependency_growth_percentile", minimum: 0.75 }),
    ]),
    interpretation: "Cycle participation and relatively high dependency growth are both observed for this subject; the dependency surface is becoming more connected.",
    suggested_investigation: "Inspect the cycle's import responsibilities and the recent edges contributing to its growth.",
  }),
  Object.freeze({
    signal_type: "duplication-simultaneous-change",
    requirements: Object.freeze([
      Object.freeze({ kind: "duplication_percentile", minimum: 0.9 }),
      Object.freeze({ kind: "cochange_percentile", minimum: 0.75 }),
    ]),
    interpretation: "A concentrated clone family and simultaneous change are both observed, suggesting repeated maintenance across related source surfaces.",
    suggested_investigation: "Inspect whether the clone family represents intentional parallel implementations or shared behavior worth consolidating.",
  }),
]);

function fail(detail) {
  const error = new Error(`FAIL-INVESTIGATION-SIGNALS: ${detail}`);
  error.code = "FAIL-INVESTIGATION-SIGNALS";
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

function assertClosed(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be a closed record`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(stableCompare);
  if (unknown.length > 0) fail(`${label}.${unknown[0]} is not declared`);
}

function validText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !value.includes("\0") && !/[\r\n]/.test(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function signalId(revision, type, subject, observations) {
  const bytes = canonicalJson({
    version: INVESTIGATION_SIGNAL_VERSION,
    repository_revision: revision,
    signal_type: type,
    subject,
    observations,
  });
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function requirementSatisfied(observation, requirement) {
  if (requirement.non_measured === true) return !Number.isFinite(observation.value);
  const numericEvidence = observation.status === "measured"
    || (observation.status === "degraded" && observation.semantic_state === "strong-partial");
  return numericEvidence && observation.value >= requirement.minimum;
}

function observationStrength(observation) {
  return Number.isFinite(observation.value) ? observation.value : 0.5;
}

function deriveInvestigationSignals(input) {
  assertClosed(input, ["observations", "repository_revision"], "investigation input");
  if (typeof input.repository_revision !== "string" || !/^[0-9a-f]{40}$/.test(input.repository_revision)) {
    fail("repository_revision must be one exact lowercase commit ID");
  }
  if (!Array.isArray(input.observations) || input.observations.length > MAX_OBSERVATIONS) {
    fail(`observations must be an array containing at most ${MAX_OBSERVATIONS} entries`);
  }

  const observations = [];
  const identities = new Set();
  for (const [index, candidate] of input.observations.entries()) {
    assertClosed(candidate, ["confidence", "coverage", "evidence_refs", "kind", "semantic_state", "status", "subject", "value"], `observations[${index}]`);
    if (!validText(candidate.subject)) fail(`observations[${index}].subject is invalid`);
    if (!OBSERVATION_KINDS.has(candidate.kind)) fail(`observations[${index}].kind is unsupported`);
    if (!OBSERVATION_STATUSES.has(candidate.status)) fail(`observations[${index}].status is invalid`);
    const hasUncertainty = Object.hasOwn(candidate, "coverage")
      || Object.hasOwn(candidate, "confidence") || Object.hasOwn(candidate, "semantic_state");
    if (candidate.status === "measured") {
      if (!Number.isFinite(candidate.value) || candidate.value < 0 || candidate.value > 1) {
        fail(`observations[${index}].value must be a ratio from zero through one when measured`);
      }
      if (hasUncertainty) fail(`observations[${index}] measured evidence cannot declare partial uncertainty`);
    } else if (candidate.status === "degraded" && Number.isFinite(candidate.value)) {
      if (candidate.value < 0 || candidate.value > 1) {
        fail(`observations[${index}].value must be a ratio from zero through one when degraded numeric evidence is retained`);
      }
      if (!Number.isFinite(candidate.coverage) || candidate.coverage < 0.9 || candidate.coverage > 1
          || !Number.isFinite(candidate.confidence) || candidate.confidence < 0.9 || candidate.confidence > 1
          || (candidate.coverage === 1 && candidate.confidence === 1)
          || candidate.semantic_state !== "strong-partial") {
        fail(`observations[${index}] degraded numeric evidence must declare matching strong-partial coverage and confidence`);
      }
    } else if (candidate.value !== null) {
      fail(`observations[${index}].value must be null when evidence is not measured`);
    } else if (hasUncertainty) {
      fail(`observations[${index}] nonnumeric evidence cannot declare numeric uncertainty`);
    }
    if (!Array.isArray(candidate.evidence_refs) || candidate.evidence_refs.length === 0
        || candidate.evidence_refs.length > MAX_EVIDENCE_REFS
        || candidate.evidence_refs.some((reference) => !validText(reference))
        || new Set(candidate.evidence_refs).size !== candidate.evidence_refs.length) {
      fail(`observations[${index}].evidence_refs must be unique bounded nonblank strings`);
    }
    const identity = JSON.stringify([candidate.subject, candidate.kind]);
    if (identities.has(identity)) fail(`duplicate subject/kind observation ${identity}`);
    identities.add(identity);
    const observation = {
      subject: candidate.subject,
      kind: candidate.kind,
      status: candidate.status,
      value: candidate.value,
      evidence_refs: [...candidate.evidence_refs].sort(stableCompare),
    };
    if (candidate.status === "degraded" && Number.isFinite(candidate.value)) {
      observation.coverage = candidate.coverage;
      observation.confidence = candidate.confidence;
      observation.semantic_state = candidate.semantic_state;
    }
    observations.push(observation);
  }
  observations.sort((left, right) => stableCompare(left.subject, right.subject) || stableCompare(left.kind, right.kind));
  const bySubject = new Map();
  for (const observation of observations) {
    if (!bySubject.has(observation.subject)) bySubject.set(observation.subject, new Map());
    bySubject.get(observation.subject).set(observation.kind, observation);
  }

  const eligible = [];
  const evidenceGaps = [];
  for (const [definitionOrder, definition] of DEFINITIONS.entries()) {
    for (const subject of [...bySubject.keys()].sort(stableCompare)) {
      const subjectObservations = bySubject.get(subject);
      const present = definition.requirements.map((requirement) => subjectObservations.get(requirement.kind) ?? null);
      const satisfied = present.map((observation, index) => (
        observation !== null && requirementSatisfied(observation, definition.requirements[index])
      ));
      if (satisfied.every(Boolean)) {
        const selected = present.map((observation) => {
          const selectedObservation = {
            kind: observation.kind,
            status: observation.status,
            value: observation.value,
          };
          if (observation.status === "degraded" && Number.isFinite(observation.value)) {
            selectedObservation.coverage = observation.coverage;
            selectedObservation.confidence = observation.confidence;
            selectedObservation.semantic_state = observation.semantic_state;
          }
          selectedObservation.evidence_refs = observation.evidence_refs;
          return selectedObservation;
        });
        const evidenceRefs = [...new Set(selected.flatMap((observation) => observation.evidence_refs))].sort(stableCompare);
        const strength = selected.reduce((sum, observation) => sum + observationStrength(observation), 0) / selected.length;
        eligible.push({
          definition_order: definitionOrder,
          strength,
          signal: {
            signal_id: signalId(input.repository_revision, definition.signal_type, subject, selected),
            signal_type: definition.signal_type,
            subject,
            observations: selected,
            coverage: { observed: selected.length, required: definition.requirements.length, ratio: 1 },
            confidence: selected.every((observation) => observation.status === "measured") ? "high" : "medium",
            evidence_refs: evidenceRefs,
            interpretation: definition.interpretation,
            suggested_investigation: definition.suggested_investigation,
          },
        });
        continue;
      }
      const satisfiedPresent = satisfied.some(Boolean);
      const missingKinds = definition.requirements
        .filter((_, index) => present[index] === null)
        .map((requirement) => requirement.kind)
        .sort(stableCompare);
      if (satisfiedPresent && missingKinds.length > 0) {
        evidenceGaps.push({ subject, signal_type: definition.signal_type, missing_kinds: missingKinds });
      }
    }
  }
  eligible.sort((left, right) => (
    (left.definition_order - right.definition_order)
    || (right.strength - left.strength)
    || stableCompare(left.signal.subject, right.signal.subject)
  ));
  evidenceGaps.sort((left, right) => {
    const leftOrder = DEFINITIONS.findIndex((definition) => definition.signal_type === left.signal_type);
    const rightOrder = DEFINITIONS.findIndex((definition) => definition.signal_type === right.signal_type);
    return (leftOrder - rightOrder) || stableCompare(left.subject, right.subject);
  });
  const signals = eligible.slice(0, MAX_SIGNALS).map(({ signal }) => signal);
  return deepFreeze({
    signal_version: INVESTIGATION_SIGNAL_VERSION,
    repository_revision: input.repository_revision,
    observed_subject_count: bySubject.size,
    observed_observation_count: observations.length,
    signals,
    evidence_gaps: evidenceGaps.slice(0, MAX_GAPS),
    truncation: {
      eligible: eligible.length,
      emitted: signals.length,
      truncated: eligible.length > signals.length,
      maximum_signals: MAX_SIGNALS,
      evidence_gaps_eligible: evidenceGaps.length,
      evidence_gaps_emitted: Math.min(evidenceGaps.length, MAX_GAPS),
    },
  });
}

module.exports = {
  INVESTIGATION_SIGNAL_VERSION,
  deriveInvestigationSignals,
};
