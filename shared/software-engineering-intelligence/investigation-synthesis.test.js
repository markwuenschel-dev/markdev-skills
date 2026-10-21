"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInvestigationSignalRiskModel } = require("./investigation-synthesis.js");

const REVISION = "a".repeat(40);

function metric(metric_id, subject, value, status = "measured", artifact_refs = [metric_id]) {
  const dependencyPath = subject.startsWith("dependency-node:tsjs:") ? subject.slice("dependency-node:tsjs:".length) : null;
  return {
    metric_id,
    subject,
    value: status === "measured" ? value : null,
    measurement: { status, completeness: status === "measured" ? 1 : 0, confidence: status === "measured" ? 1 : 0, reason: status === "measured" ? null : "not observed" },
    source: { artifact_refs, evidence_refs: artifact_refs },
    scope: { kind: subject.startsWith("file:") ? "file" : dependencyPath === null ? "repository" : "module", path: subject.startsWith("file:") ? subject.slice(5) : dependencyPath ?? "." },
  };
}

function languageMetric(metric_id, subject, value, language, overrides = {}) {
  const candidate = metric(metric_id, subject, value, overrides.status ?? "measured", overrides.artifact_refs ?? [metric_id]);
  candidate.scope.language = language;
  if (overrides.completeness !== undefined) candidate.measurement.completeness = overrides.completeness;
  if (overrides.confidence !== undefined) candidate.measurement.confidence = overrides.confidence;
  return candidate;
}

test("canonical synthesis produces bounded evidence-bound investigation signals without verdict language", () => {
  const measurements = [
    metric("static.tsjs.cyclomatic_complexity:src/a.ts", "file:src/a.ts", 40),
    metric("static.tsjs.cyclomatic_complexity:src/b.ts", "file:src/b.ts", 4),
    metric("git.observed_text_churn:src/a.ts", "file:src/a.ts", 900),
    metric("git.observed_text_churn:src/b.ts", "file:src/b.ts", 10),
    metric("git.change_frequency:src/a.ts", "file:src/a.ts", 30),
    metric("git.change_frequency:src/b.ts", "file:src/b.ts", 1),
    metric("static.dependency.page_rank:tsjs:src/a.ts", "dependency-node:tsjs:src/a.ts", 0.8),
    metric("static.dependency.page_rank:tsjs:src/b.ts", "dependency-node:tsjs:src/b.ts", 0.2),
    metric("static.dependency.fan_in:tsjs:src/a.ts", "dependency-node:tsjs:src/a.ts", 8),
    metric("static.dependency.fan_in:tsjs:src/b.ts", "dependency-node:tsjs:src/b.ts", 0),
    metric("git.observed_touch_ownership_concentration:src/a.ts", "file:src/a.ts", 0.9),
    metric("git.observed_touch_ownership_concentration:src/b.ts", "file:src/b.ts", 0.5),
    metric("verification.test.total", "repository:test", null, "unavailable", ["verification:test:missing"]),
  ];
  const snapshot = { repository: { revision: REVISION }, measurements };
  const first = buildInvestigationSignalRiskModel(snapshot);
  const second = buildInvestigationSignalRiskModel(structuredClone(snapshot));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.risk_model_id, "engineering-investigation-signals-v1");
  assert.equal(first.model_status, "heuristic");
  assert.equal(first.result.kind, "engineering_investigation_signals");
  assert.equal(first.result.status, "available");
  assert.ok(first.result.records.length >= 3 && first.result.records.length <= 25);
  assert.deepEqual(first.result.records.slice(0, 3).map((record) => record.signal_type), [
    "high-complexity-high-churn",
    "high-centrality-repeated-modification",
    "high-fan-in-concentrated-ownership",
  ]);
  assert.equal(first.result.records.every((record) => record.subject === "file:src/a.ts"), true);
  assert.equal(first.result.records.every((record) => record.evidence_refs.length > 0), true);
  assert.equal(JSON.stringify(first).includes(" is a defect"), false);
  assert.match(first.result.interpretation_boundary, /investigation signals only/);
});

test("synthesis returns explicit unavailable output when no multi-signal intersection is supportable", () => {
  const result = buildInvestigationSignalRiskModel({
    repository: { revision: REVISION },
    measurements: [metric("static.tsjs.cyclomatic_complexity:src/a.ts", "file:src/a.ts", 1)],
  });
  assert.equal(result.model_status, "unavailable");
  assert.equal(result.result.status, "unavailable");
  assert.deepEqual(result.result.records, []);
  assert.deepEqual(result.result.evidence_metric_ids, []);
  assert.deepEqual(result.result.evidence_refs, []);
});

test("synthesis ranks complexity within language while retaining raw and repository-relative context", () => {
  const measurements = [
    languageMetric("static.python.cyclomatic_complexity:src/py-low.py", "file:src/py-low.py", 1, "python"),
    languageMetric("static.python.cyclomatic_complexity:src/target.py", "file:src/target.py", 12, "python"),
    languageMetric("static.java.cyclomatic_complexity:src/Target.java", "file:src/Target.java", 12, "java"),
    languageMetric("static.java.cyclomatic_complexity:src/java-high.java", "file:src/java-high.java", 20, "java"),
    languageMetric("git.observed_text_churn:src/py-low.py", "file:src/py-low.py", 1, "python"),
    languageMetric("git.observed_text_churn:src/target.py", "file:src/target.py", 100, "python"),
    languageMetric("git.observed_text_churn:src/Target.java", "file:src/Target.java", 100, "java"),
    languageMetric("git.observed_text_churn:src/java-high.java", "file:src/java-high.java", 200, "java"),
  ];

  const result = buildInvestigationSignalRiskModel({ repository: { revision: REVISION }, measurements });
  const complexityChurn = result.result.records.filter((record) => record.signal_type === "high-complexity-high-churn");
  const pythonTarget = complexityChurn.find((record) => record.subject === "file:src/target.py");

  assert.ok(pythonTarget);
  assert.equal(complexityChurn.some((record) => record.subject === "file:src/Target.java"), false);
  assert.match(pythonTarget.interpretation, /python/);
  assert.match(pythonTarget.interpretation, /raw 12/);
  assert.match(pythonTarget.interpretation, /within-language P100/);
  assert.match(pythonTarget.interpretation, /repository P50/);
  assert.doesNotMatch(pythonTarget.interpretation, /defect|health|priority|caus/i);
});

test("synthesis retains strong partial structural and behavioral intersections with explicit uncertainty", () => {
  const measurements = [
    languageMetric("static.java.cyclomatic_complexity:src/partial.java", "file:src/partial.java", 100, "java", { completeness: 0.95, confidence: 0.94 }),
    languageMetric("static.java.cyclomatic_complexity:src/low.java", "file:src/low.java", 1, "java"),
    languageMetric("git.observed_text_churn:src/partial.java", "file:src/partial.java", 100, "java", { completeness: 0.93, confidence: 0.92 }),
    languageMetric("git.observed_text_churn:src/low.java", "file:src/low.java", 1, "java"),
  ];

  const forward = buildInvestigationSignalRiskModel({ repository: { revision: REVISION }, measurements });
  const reverse = buildInvestigationSignalRiskModel({ repository: { revision: REVISION }, measurements: [...measurements].reverse() });

  assert.deepEqual(reverse, forward);
  assert.equal(forward.result.status, "available");
  assert.equal(forward.result.records.length, 1);
  assert.equal(forward.result.records[0].signal_type, "high-complexity-high-churn");
  assert.equal(forward.result.records[0].subject, "file:src/partial.java");
  assert.equal(forward.result.records[0].confidence, "medium");
  assert.deepEqual(forward.result.records[0].observations, [
    {
      kind: "complexity_percentile",
      status: "degraded",
      value: 1,
      coverage: 0.95,
      confidence: 0.94,
      semantic_state: "strong-partial",
      evidence_refs: ["static.java.cyclomatic_complexity:src/partial.java"],
    },
    {
      kind: "churn_percentile",
      status: "degraded",
      value: 1,
      coverage: 0.93,
      confidence: 0.92,
      semantic_state: "strong-partial",
      evidence_refs: ["git.observed_text_churn:src/partial.java"],
    },
  ]);
  assert.match(forward.result.records[0].interpretation, /strong-partial/);
});

test("synthesis suppresses tied weak-signal floods and incomplete measurements", () => {
  const tied = [];
  for (let index = 0; index < 30; index += 1) {
    const path = `src/equal-${String(index).padStart(2, "0")}.js`;
    tied.push(languageMetric(`static.tsjs.cyclomatic_complexity:${path}`, `file:${path}`, 5, "javascript"));
    tied.push(languageMetric(`git.observed_text_churn:${path}`, `file:${path}`, 5, "javascript"));
    tied.push(languageMetric(`git.change_frequency:${path}`, `file:${path}`, 5, "javascript"));
  }
  tied.push(metric("verification.tests_total", "repository:test", null, "unavailable", ["verification:configured-only"]));
  const tiedResult = buildInvestigationSignalRiskModel({ repository: { revision: REVISION }, measurements: tied });
  assert.equal(tiedResult.result.status, "unavailable");
  assert.deepEqual(tiedResult.result.records, []);

  const partial = [
    languageMetric("static.java.cyclomatic_complexity:src/a.java", "file:src/a.java", 100, "java", { completeness: 0.5, confidence: 0.5 }),
    languageMetric("static.java.cyclomatic_complexity:src/b.java", "file:src/b.java", 1, "java"),
    languageMetric("git.observed_text_churn:src/a.java", "file:src/a.java", 100, "java"),
    languageMetric("git.observed_text_churn:src/b.java", "file:src/b.java", 1, "java"),
  ];
  const partialResult = buildInvestigationSignalRiskModel({ repository: { revision: REVISION }, measurements: partial });
  assert.equal(partialResult.result.status, "unavailable");
});

test("synthesis cannot turn zero-coverage, unavailable, or unbound metrics into numeric signals", () => {
  const supporting = [
    languageMetric("static.java.cyclomatic_complexity:src/low.java", "file:src/low.java", 1, "java"),
    languageMetric("git.observed_text_churn:src/target.java", "file:src/target.java", 100, "java"),
    languageMetric("git.observed_text_churn:src/low.java", "file:src/low.java", 1, "java"),
  ];
  const blockedComplexity = [
    languageMetric("static.java.cyclomatic_complexity:src/target.java", "file:src/target.java", 100, "java", { completeness: 0, confidence: 0.95 }),
    languageMetric("static.java.cyclomatic_complexity:src/target.java", "file:src/target.java", null, "java", { status: "unavailable" }),
    languageMetric("static.java.cyclomatic_complexity:src/target.java", "file:src/target.java", 100, "java", { artifact_refs: [] }),
  ];

  for (const candidate of blockedComplexity) {
    const result = buildInvestigationSignalRiskModel({
      repository: { revision: REVISION },
      measurements: [candidate, ...supporting],
    });
    assert.equal(result.result.status, "unavailable");
    assert.deepEqual(result.result.records, []);
  }
});

test("synthesis is deterministic when verification evidence and measurements arrive in different orders", () => {
  const measurements = [
    languageMetric("static.tsjs.cyclomatic_complexity:src/a.ts", "file:src/a.ts", 20, "typescript"),
    languageMetric("static.tsjs.cyclomatic_complexity:src/b.ts", "file:src/b.ts", 1, "typescript"),
    languageMetric("git.observed_text_churn:src/a.ts", "file:src/a.ts", 200, "typescript"),
    languageMetric("git.observed_text_churn:src/b.ts", "file:src/b.ts", 1, "typescript"),
    languageMetric("git.change_frequency:src/a.ts", "file:src/a.ts", 20, "typescript"),
    languageMetric("git.change_frequency:src/b.ts", "file:src/b.ts", 1, "typescript"),
    metric("verification.tests_total", "repository:test", null, "unavailable", ["verification:configured-only"]),
    metric("verification.statement_coverage", "repository:test", 0.8, "measured", ["verification:observed-coverage"]),
  ];
  const forward = buildInvestigationSignalRiskModel({ repository: { revision: REVISION }, measurements });
  const reverse = buildInvestigationSignalRiskModel({ repository: { revision: REVISION }, measurements: measurements.slice().reverse() });

  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.result.records.map((record) => record.signal_type), ["high-complexity-high-churn"]);
  assert.deepEqual(forward.result.records[0].evidence_refs, [
    "git.observed_text_churn:src/a.ts",
    "static.tsjs.cyclomatic_complexity:src/a.ts",
  ]);
});

test("synthesis retains measured cycle and clone-family intersections without inventing single-signal findings", () => {
  const measurements = [
    languageMetric("static.tsjs.dependency.cycle_participation:src/cycle.ts", "file:src/cycle.ts", 1, "typescript"),
    languageMetric("static.tsjs.dependency.dependency_growth:src/cycle.ts", "file:src/cycle.ts", 12, "typescript"),
    languageMetric("static.tsjs.dependency.dependency_growth:src/other.ts", "file:src/other.ts", 1, "typescript"),
    metric("static.duplication.clone_family_percentage:family-a", "clone:family-a", 0.4),
    metric("static.duplication.clone_family_percentage:family-b", "clone:family-b", 0.05),
    metric("git.observed_co_change_count:family-a", "clone:family-a", 8),
    metric("git.observed_co_change_count:family-b", "clone:family-b", 1),
    languageMetric("static.java.cyclomatic_complexity:src/single.java", "file:src/single.java", 500, "java"),
  ];

  const result = buildInvestigationSignalRiskModel({ repository: { revision: REVISION }, measurements });
  assert.deepEqual(result.result.records.map(({ signal_type, subject }) => ({ signal_type, subject })), [
    { signal_type: "cycle-growing-dependency-pressure", subject: "file:src/cycle.ts" },
    { signal_type: "duplication-simultaneous-change", subject: "clone:family-a" },
  ]);
  assert.equal(result.result.records.some((record) => record.subject === "file:src/single.java"), false);
  assert.equal(result.result.records.every((record) => record.observations.length >= 2), true);
  assert.equal(result.result.records.every((record) => record.evidence_refs.length >= 2), true);
});
