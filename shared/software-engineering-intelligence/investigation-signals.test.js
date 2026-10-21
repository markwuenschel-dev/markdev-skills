"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  INVESTIGATION_SIGNAL_VERSION,
  deriveInvestigationSignals,
} = require("./investigation-signals.js");

function observation(subject, kind, value, overrides = {}) {
  return {
    subject,
    kind,
    status: "measured",
    value,
    evidence_refs: [`${kind}:${subject}`],
    ...overrides,
  };
}

test("investigation signals combine independent evidence into bounded non-verdict findings", () => {
  const observations = [
    observation("file:server.py", "complexity_percentile", 0.96),
    observation("file:server.py", "churn_percentile", 0.94),
    observation("file:server.py", "centrality_percentile", 0.97),
    observation("file:server.py", "change_frequency_percentile", 0.91),
    observation("file:server.py", "fan_in_percentile", 0.99),
    observation("file:server.py", "ownership_concentration_percentile", 0.82),
    observation("file:server.py", "verification_strength", null, {
      status: "unavailable",
      evidence_refs: ["verification-discovery:configured-no-results"],
    }),
    observation("module:cycle-a", "cycle_participation", 1),
    observation("module:cycle-a", "dependency_growth_percentile", 0.8),
    observation("clone:family-1", "duplication_percentile", 0.95),
    observation("clone:family-1", "cochange_percentile", 0.9),
  ];

  const result = deriveInvestigationSignals({
    repository_revision: "a".repeat(40),
    observations,
  });

  assert.equal(INVESTIGATION_SIGNAL_VERSION, "sei.investigation-signals@1");
  assert.equal(result.repository_revision, "a".repeat(40));
  assert.equal(result.observed_subject_count, 3);
  assert.deepEqual(result.signals.map(({ signal_type, subject }) => ({ signal_type, subject })), [
    { signal_type: "high-complexity-high-churn", subject: "file:server.py" },
    { signal_type: "high-centrality-repeated-modification", subject: "file:server.py" },
    { signal_type: "weak-verification-high-change-pressure", subject: "file:server.py" },
    { signal_type: "high-fan-in-concentrated-ownership", subject: "file:server.py" },
    { signal_type: "cycle-growing-dependency-pressure", subject: "module:cycle-a" },
    { signal_type: "duplication-simultaneous-change", subject: "clone:family-1" },
  ]);
  for (const signal of result.signals) {
    assert.equal(signal.coverage.observed, signal.coverage.required);
    assert.equal(signal.coverage.ratio, 1);
    assert.match(signal.interpretation, /observed/);
    assert.match(signal.suggested_investigation, /review|inspect|investigate/i);
    assert.doesNotMatch(`${signal.interpretation} ${signal.suggested_investigation}`, /defect|badly designed|must refactor/i);
    assert.equal(signal.observations.length, 2);
    assert.ok(signal.evidence_refs.length >= 2);
  }
  assert.equal(result.signals.find((signal) => signal.signal_type === "weak-verification-high-change-pressure").confidence, "medium");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.signals), true);

  const reordered = deriveInvestigationSignals({
    repository_revision: "a".repeat(40),
    observations: [...observations].reverse(),
  });
  assert.deepEqual(reordered, result);
});

test("strong partial observations retain bounded numeric evidence with medium confidence", () => {
  const observations = [
    observation("file:partial.py", "complexity_percentile", 0.96, {
      status: "degraded",
      coverage: 0.95,
      confidence: 0.94,
      semantic_state: "strong-partial",
    }),
    observation("file:partial.py", "churn_percentile", 0.93, {
      status: "degraded",
      coverage: 0.92,
      confidence: 0.91,
      semantic_state: "strong-partial",
    }),
  ];

  const result = deriveInvestigationSignals({ repository_revision: "d".repeat(40), observations });
  const reordered = deriveInvestigationSignals({ repository_revision: "d".repeat(40), observations: [...observations].reverse() });

  assert.deepEqual(reordered, result);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].signal_type, "high-complexity-high-churn");
  assert.equal(result.signals[0].confidence, "medium");
  assert.deepEqual(result.signals[0].observations, [
    {
      kind: "complexity_percentile",
      status: "degraded",
      value: 0.96,
      coverage: 0.95,
      confidence: 0.94,
      semantic_state: "strong-partial",
      evidence_refs: ["complexity_percentile:file:partial.py"],
    },
    {
      kind: "churn_percentile",
      status: "degraded",
      value: 0.93,
      coverage: 0.92,
      confidence: 0.91,
      semantic_state: "strong-partial",
      evidence_refs: ["churn_percentile:file:partial.py"],
    },
  ]);
});

test("strong partial numeric verification is not classified as missing or weak verification", () => {
  const result = deriveInvestigationSignals({
    repository_revision: "e".repeat(40),
    observations: [
      observation("file:verified.py", "change_frequency_percentile", 0.95),
      observation("file:verified.py", "verification_strength", 0.92, {
        status: "degraded",
        coverage: 0.95,
        confidence: 0.94,
        semantic_state: "strong-partial",
      }),
    ],
  });

  assert.deepEqual(result.signals, []);
});

test("investigation signals expose missing counterpart evidence rather than inferring it", () => {
  const result = deriveInvestigationSignals({
    repository_revision: "b".repeat(40),
    observations: [
      observation("file:lonely.py", "complexity_percentile", 0.99),
      observation("module:popular", "fan_in_percentile", 0.95),
    ],
  });
  assert.deepEqual(result.signals, []);
  assert.deepEqual(result.evidence_gaps, [
    {
      subject: "file:lonely.py",
      signal_type: "high-complexity-high-churn",
      missing_kinds: ["churn_percentile"],
    },
    {
      subject: "module:popular",
      signal_type: "high-fan-in-concentrated-ownership",
      missing_kinds: ["ownership_concentration_percentile"],
    },
  ]);
});

test("investigation signals remain bounded and select strongest repository-relative intersections deterministically", () => {
  const observations = [];
  for (let index = 0; index < 80; index += 1) {
    const subject = `file:f${String(index).padStart(3, "0")}.js`;
    observations.push(observation(subject, "complexity_percentile", 0.9 + (index / 1000)));
    observations.push(observation(subject, "churn_percentile", 0.9 + (index / 1000)));
  }
  const result = deriveInvestigationSignals({ repository_revision: "c".repeat(40), observations });
  assert.equal(result.signals.length, 25);
  assert.equal(result.truncation.emitted, 25);
  assert.equal(result.truncation.eligible, 80);
  assert.equal(result.truncation.truncated, true);
  assert.equal(result.signals[0].subject, "file:f079.js");
});

test("investigation signals reject caller-defined rules, invalid states, and unbound evidence", () => {
  const invalid = [
    { repository_revision: "a".repeat(40), observations: [], rules: [] },
    { repository_revision: "HEAD", observations: [] },
    { repository_revision: "a".repeat(40), observations: [observation("file:a", "unknown", 1)] },
    { repository_revision: "a".repeat(40), observations: [{ ...observation("file:a", "churn_percentile", 0.9), evidence_refs: [] }] },
    { repository_revision: "a".repeat(40), observations: [{ ...observation("file:a", "churn_percentile", 2) }] },
    { repository_revision: "a".repeat(40), observations: [observation("file:a", "churn_percentile", 0.9, { status: "degraded" })] },
    { repository_revision: "a".repeat(40), observations: [observation("file:a", "churn_percentile", 0.9, { status: "degraded", coverage: 0, confidence: 0.95, semantic_state: "strong-partial" })] },
    { repository_revision: "a".repeat(40), observations: [observation("file:a", "churn_percentile", 0.9, { status: "degraded", coverage: 0.95, confidence: 0.95, semantic_state: "partial" })] },
    { repository_revision: "a".repeat(40), observations: [observation("file:a", "churn_percentile", 0.9, { status: "unavailable" })] },
  ];
  for (const input of invalid) {
    assert.throws(
      () => deriveInvestigationSignals(input),
      (error) => error?.code === "FAIL-INVESTIGATION-SIGNALS",
    );
  }
});
