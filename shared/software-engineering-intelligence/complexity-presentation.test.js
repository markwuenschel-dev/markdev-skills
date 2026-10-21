"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const complexityPresentation = require("./complexity-presentation.js");
const {
  COMPLEXITY_PRESENTATION_VERSION,
  deriveComplexityPresentation,
} = complexityPresentation;

function measurement({
  metricId,
  value,
  status = "measured",
  completeness = 1,
  confidence = 1,
  language = "python",
  scopeKind = "repository",
  path = ".",
  subject = "repository:fixture",
  reason = null,
}) {
  return {
    metric_id: metricId,
    value,
    unit: metricId.includes("callable_count") ? "callables"
      : metricId.includes("source_lines") ? "lines"
        : "cyclomatic-complexity-points",
    subject,
    repository_revision: "0123456789abcdef0123456789abcdef01234567",
    measurement: { status, completeness, confidence, reason },
    scope: {
      kind: scopeKind,
      path,
      language,
      generated_code: false,
      included_in_human_maintainability: true,
    },
  };
}

function fixtureSnapshot() {
  const partial = { completeness: 0.75, confidence: 0.8 };
  return {
    measurements: [
      measurement({ metricId: "static.python.cyclomatic_complexity:production", value: 120, ...partial }),
      measurement({ metricId: "static.python.cyclomatic_callable_count:production", value: 20, ...partial }),
      measurement({ metricId: "static.python.cyclomatic_complexity_p50:production", value: 3, ...partial }),
      measurement({ metricId: "static.python.cyclomatic_complexity_p90:production", value: 9, ...partial }),
      measurement({ metricId: "static.python.cyclomatic_complexity_max:production", value: 17, ...partial }),
      measurement({ metricId: "static.python.cognitive_complexity:production", value: 80, ...partial }),
      measurement({ metricId: "static.python.cognitive_complexity_p50:production", value: 2, ...partial }),
      measurement({ metricId: "static.python.cognitive_complexity_p90:production", value: 7, ...partial }),
      measurement({ metricId: "static.python.cognitive_complexity_max:production", value: 14, ...partial }),
      measurement({
        metricId: "static.cyclomatic_complexity:src/a.py",
        value: 70,
        scopeKind: "file",
        path: "src/a.py",
        subject: "file:src/a.py",
      }),
      measurement({
        metricId: "static.cyclomatic_complexity:src/b.py",
        value: 50,
        scopeKind: "file",
        path: "src/b.py",
        subject: "file:src/b.py",
      }),
      measurement({
        metricId: "static.source_lines:src/a.py",
        value: 100,
        scopeKind: "file",
        path: "src/a.py",
        subject: "file:src/a.py",
      }),
      measurement({
        metricId: "static.source_lines:src/b.py",
        value: 1000,
        scopeKind: "file",
        path: "src/b.py",
        subject: "file:src/b.py",
      }),
      measurement({
        metricId: "static.source_lines:src/unjoined.py",
        value: 1,
        scopeKind: "file",
        path: "src/unjoined.py",
        subject: "file:src/unjoined.py",
      }),
      measurement({
        metricId: "static.python.cyclomatic_callable:src/a.py:1:0:4:0:alpha",
        value: 17,
        scopeKind: "file",
        path: "src/a.py",
        subject: "python-callable:src/a.py#alpha@1:0-4:0",
      }),
      measurement({
        metricId: "static.python.cyclomatic_callable:src/b.py:1:0:4:0:beta",
        value: 6,
        scopeKind: "file",
        path: "src/b.py",
        subject: "python-callable:src/b.py#beta@1:0-4:0",
      }),
      measurement({
        metricId: "static.kotlin.cyclomatic_complexity",
        value: null,
        status: "unavailable",
        completeness: 0,
        confidence: 0,
        language: "kotlin",
        reason: "unsupported Kotlin parser; this UI-looking text must never be parsed or copied",
      }),
    ],
  };
}

function findPartition(presentation, language, partitionId) {
  return presentation.partitions.find((partition) => (
    partition.language === language && partition.partition_id === partitionId
  ));
}

function findMeasure(partition, measure) {
  return partition.measures.find((entry) => entry.measure === measure);
}

function findGroup(measure, kind) {
  return measure.groups.find((group) => group.kind === kind);
}

test("separates complexity dimensions and quantities into human-ready partial partition groups", () => {
  const snapshot = fixtureSnapshot();
  const presentation = deriveComplexityPresentation(snapshot);
  const reversed = deriveComplexityPresentation({ measurements: [...snapshot.measurements].reverse() });

  assert.deepEqual(Object.keys(complexityPresentation).sort(), [
    "COMPLEXITY_PRESENTATION_VERSION",
    "deriveComplexityPresentation",
  ]);
  assert.equal(COMPLEXITY_PRESENTATION_VERSION, "sei.complexity-presentation@1");
  assert.deepEqual(reversed, presentation);
  assert.equal(Object.isFrozen(presentation), true);
  assert.equal(Object.isFrozen(presentation.partitions), true);

  const python = findPartition(presentation, "python", "production");
  assert.ok(python);
  assert.equal(python.label, "Python / production");
  const cyclomatic = findMeasure(python, "cyclomatic");
  const cognitive = findMeasure(python, "cognitive");
  assert.ok(cyclomatic);
  assert.ok(cognitive);

  const workload = findGroup(cyclomatic, "workload");
  assert.deepEqual(workload.values.map((value) => value.role), ["callable_count", "total"]);
  assert.deepEqual(workload.values.map((value) => value.value), [20, 120]);
  assert.equal(workload.state, "partial");
  assert.equal(workload.coverage, 0.75);
  assert.equal(workload.confidence, 0.8);
  assert.match(workload.summary, /20 callables/i);
  assert.match(workload.summary, /120 points/i);

  const typical = findGroup(cyclomatic, "typical");
  const tail = findGroup(cyclomatic, "complex_tail");
  const maximum = findGroup(cyclomatic, "maximum");
  assert.equal(typical.values[0].value, 3);
  assert.equal(tail.values[0].value, 9);
  assert.equal(maximum.values[0].value, 17);
  assert.match(typical.summary, /typical/i);
  assert.match(tail.summary, /tail/i);
  assert.match(maximum.summary, /maximum/i);
  assert.equal(findGroup(cognitive, "typical").values[0].value, 2);
  assert.equal(findGroup(cognitive, "complex_tail").values[0].value, 7);
  assert.equal(findGroup(cognitive, "maximum").values[0].value, 14);

  assert.equal(findGroup(cyclomatic, "file_concentration"), undefined);
  assert.equal(findGroup(cyclomatic, "callable_outliers"), undefined);
  assert.equal(findGroup(cyclomatic, "density"), undefined);
});

test("keeps file concentration, callable outliers, and density in a separate observed-files group with exact joins", () => {
  const presentation = deriveComplexityPresentation(fixtureSnapshot());
  const observedFiles = findPartition(presentation, "python", "observed-files");
  assert.ok(observedFiles);
  const cyclomatic = findMeasure(observedFiles, "cyclomatic");

  const concentration = findGroup(cyclomatic, "file_concentration");
  assert.deepEqual(concentration.items.map((item) => [item.path, item.value]), [
    ["src/a.py", 70],
    ["src/b.py", 50],
  ]);
  assert.match(concentration.summary, /file total/i);

  const outliers = findGroup(cyclomatic, "callable_outliers");
  assert.deepEqual(outliers.items.map((item) => [item.path, item.value]), [
    ["src/a.py", 17],
    ["src/b.py", 6],
  ]);
  assert.match(outliers.summary, /callable/i);

  const density = findGroup(cyclomatic, "density");
  assert.deepEqual(density.items.map((item) => [item.path, item.source_lines, item.points_per_100_lines]), [
    ["src/a.py", 100, 70],
    ["src/b.py", 1000, 5],
  ]);
  assert.equal(density.joined_file_count, 2);
  assert.match(density.summary, /exact file-to-line joins/i);
  assert.doesNotMatch(JSON.stringify(presentation), /unjoined\.py/);
});

test("represents canonical non-observation without inventing absent groups or copying reasons", () => {
  const presentation = deriveComplexityPresentation(fixtureSnapshot());
  const kotlin = findPartition(presentation, "kotlin", "repository");
  assert.ok(kotlin);
  const cyclomatic = findMeasure(kotlin, "cyclomatic");
  const workload = findGroup(cyclomatic, "workload");

  assert.equal(workload.state, "unavailable");
  assert.equal(workload.coverage, null);
  assert.equal(workload.confidence, null);
  assert.deepEqual(workload.values, []);
  assert.match(workload.summary, /unavailable/i);
  assert.equal(findGroup(cyclomatic, "typical"), undefined);
  assert.equal(findGroup(cyclomatic, "complex_tail"), undefined);
  assert.doesNotMatch(JSON.stringify(presentation), /unsupported Kotlin parser/i);
});

test("fails closed for an unbounded or malformed canonical measurement list", () => {
  assert.throws(
    () => deriveComplexityPresentation({ measurements: "not-an-array" }),
    (error) => error?.code === "FAIL-COMPLEXITY-PRESENTATION",
  );
  assert.throws(
    () => deriveComplexityPresentation({ measurements: [null] }),
    (error) => error?.code === "FAIL-COMPLEXITY-PRESENTATION",
  );
});
